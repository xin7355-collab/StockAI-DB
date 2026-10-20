#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🧪 變因面板(V79.3.8)—— 「變因因子」研究的第一步:每一檔、每 5 個交易日,算出 ~70 個變因 + 之後 5/10/20 天的報酬

使用者(2026-10-20):「我想做的是變因因子,不是單獨的一般回測,把能測試的都列出來再來執行。」
→ 這支只負責**把所有變因放進同一張表**(同一個母體、同一條報酬定義),判定交給 `factor_zoo_probe.py`。

⭐ 三條不可違反的設計:
  ① 零前視:變因只用「那一天收盤以前」的資料;法人 / 融資券收盤後公布 → 當天的值可以用(因為進場是**隔天開盤**);
     財報用 `factor_fund_export.mjs` 給的公布日(法定截止日),**嚴格早於**使用日才算知道(同 lib_accrual.knownBefore)。
  ② ⛔ 不產生第二份定義:跟 `screener_miner.build_one` 同名的欄位(chg5/10/20/60、amt20、pos252、dd60、b5/20/60/240、
     vol20、amp20、bull、streak)照它的公式算,selftest ① 逐值比對;基本面欄位來自 lib_value / lib_finaccel / lib_accrual 的匯出。
  ③ 報酬 = 隔天開盤買 → h 天後收盤(含除權息:除權息倍數照 leader_probe.prepStock 同一條驗證),隔天開盤鎖漲停 = 買不到(lock=1);
     前後有 ±40% 單日斷崖(分割 / 減資殘留)那段的列整列丟掉(⛔ 不讓假報酬進來)。

輸出 OUT_DIR/:panel_{年}.npz(date_i, sym_i, X[float32], R[float32: r5,r10,r20], lock)+ meta.json(變因名、日曆、代號、產業)。
⚠️ 記憶體:逐檔處理、按年累積,全市場 16 年約 150 萬列 × 70 欄 ≈ 0.4 GB(float32)。

跑法:DATA_DIR=… DIV=…/dividends_hist.json FUND=fund_export.json IND_MAP=…/industry_map.json OUT_DIR=… python3 scripts/factor_panel.py
      python3 scripts/factor_panel.py --selftest
      DATA_DIR=… python3 scripts/factor_panel.py --check-real 300     # 真資料抽樣跟 build_one 逐值比對
"""
import bisect
import json
import math
import os
import sys
from pathlib import Path

import warnings

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

np.seterr(divide='ignore', invalid='ignore')
warnings.filterwarnings('ignore', category=RuntimeWarning)       # 空視窗 / 除以 0 一律在 np.where 裡處理成 NaN

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DATA = Path(os.getenv('DATA_DIR') or 'data')
OUT = Path(os.getenv('OUT_DIR') or 'factor_panel')
STRIDE = int(os.getenv('STRIDE') or 5)
OFFSET = int(os.getenv('OFFSET') or 0)
WARM = int(os.getenv('WARM') or 252)          # pos252 / b240 要整整 252 根才跟 build_one 同一個窗口
MAX_SYMS = int(os.getenv('MAX_SYMS') or 0)
HS = (5, 10, 20)
CLIFF = 0.40

NAMES = [
    # A 動能 / 反轉
    'chg1', 'chg5', 'chg10', 'chg20', 'chg60', 'mom120', 'mom250', 'mom12_1', 'upshare20',
    # B 位置 / 均線
    'pos252', 'dd252', 'dhi252', 'dd60', 'b5', 'b20', 'b60', 'b240', 'bull', 'nh20cnt60',
    # C 波動 / 風險
    'vol20', 'vol60', 'atrp', 'max20', 'skew60', 'beta120', 'ivol120', 'dvol60', 'vratio', 'amp20',
    # D 量 / 規模
    'amt20', 'amt5_20', 'amt20_120', 'illiq20', 'price', 'lu20', 'lu60',
    # E K 棒
    'clv20', 'ushadow20', 'gapup20', 'gapdn20', 'streak', 'on20', 'id20',
    # F 籌碼
    'f5r', 'f20r', 'f60r', 't5r', 't20r', 't60r', 'd20r', 'i20r', 'fstreak', 'tstreak', 'fpct250', 'ftsync5',
    'mg5p', 'mg20p', 'sbr',
    # G 基本面
    'revY', 'yoyAcc', 'gmY', 'epsY', 'roe4', 'acc', 'nImp', 'ttmPos12', 'ep', 'bp',
]
K = len(NAMES)
NI = {n: i for i, n in enumerate(NAMES)}
FUND_COLS = ('revY', 'yoyAcc', 'gmY', 'epsY', 'roe4', 'acc', 'nImp', 'ttmPos12')


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def lim_of(day):
    """漲跌幅上限:2015-06-01 起 10%,之前 7%(⛔ 寫死 10% 會讓 2010~2015 的漲停一根都抓不到)。"""
    return 0.07 if day < '2015-06-01' else 0.10


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def end_win(x, w):
    """回長度 len(x) 的視窗檢視:out[i] = x[i−w+1 .. i];i < w−1 那幾格回 None(呼叫端用 valid 遮)。"""
    if len(x) < w:
        return None
    return swv(x, w)                                      # 第 j 列 = x[j .. j+w−1] → 對應結尾索引 j+w−1


def rolling(x, w, fn):
    """結尾對齊的滾動統計;前 w−1 格 NaN。fn 吃 (m, w) 陣列、回 (m,)。"""
    out = np.full(len(x), np.nan)
    v = end_win(x, w)
    if v is not None:
        out[w - 1:] = fn(v)
    return out


def rsum_strict(x, w):
    """滾動加總,視窗內有任何 NaN → NaN(⛔ 不把「沒資料」當 0)。"""
    out = np.full(len(x), np.nan)
    if len(x) < w:
        return out
    x0 = np.where(np.isfinite(x), x, 0.0)
    bad = (~np.isfinite(x)).astype(np.int64)
    cs = np.concatenate([[0.0], np.cumsum(x0)])
    cb = np.concatenate([[0], np.cumsum(bad)])
    s = cs[w:] - cs[:-w]
    b = cb[w:] - cb[:-w]
    out[w - 1:] = np.where(b == 0, s, np.nan)
    return out


def streak_pos(x):
    """連續 > 0 的天數(NaN / ≤0 中斷),逐日。"""
    out = np.zeros(len(x))
    k = 0
    for i, v in enumerate(x):
        k = k + 1 if (v == v and v > 0) else 0
        out[i] = k
    return out


def div_factors(dates, C, divs):
    """除權息倍數 F(除權息前價 ÷ 參考價),只在除權息日 ≠ 1;驗證條件跟 leader_probe.prepStock 一字不差(⛔ 不另訂)。"""
    F = np.ones(len(C))
    idx = {d: i for i, d in enumerate(dates)}
    for e in divs or []:
        try:
            dt, _cash, _typ, before, after = e[:5]
        except Exception:
            continue
        i = idx.get(_d(dt))
        if i is None or i == 0:
            continue
        p = i - 1
        while p > 0 and not (C[p] > 0):
            p -= 1
        try:
            b, a = float(before), float(after)
        except (TypeError, ValueError):
            continue
        if not (b > 0 and a > 0 and 1 < b / a < 1.6 and C[p] > 0 and abs(b / C[p] - 1) < 0.03):
            continue
        F[i] *= b / a
    return F


def per_stock(sym, rows, cal_pos, tw_ret, divs, fund, sample_set):
    """一檔 → (cal_i 陣列, X[m,K], R[m,3], lock[m]);沒有可用的列回 None。"""
    recs = []
    for r in rows or []:
        try:
            c = float(r.get('close') or 0)
        except (TypeError, ValueError):
            continue
        if c <= 0:
            continue
        recs.append(r)
    n = len(recs)
    if n < WARM + 25:
        return None
    dates = [_d(r.get('date')) for r in recs]
    f = lambda k, dflt=np.nan: np.array([(float(r[k]) if r.get(k) is not None else dflt) for r in recs], dtype=float)
    C = f('close')
    O = np.where(np.isfinite(f('open')) & (f('open') > 0), f('open'), C)
    H = np.where(np.isfinite(f('high')) & (f('high') > 0), f('high'), C)
    L = np.where(np.isfinite(f('low')) & (f('low') > 0), f('low'), C)
    V = f('volume', 0.0)
    FN, TN, DN = f('foreign_net'), f('trust_net'), f('dealer_net')
    MB, SB = f('margin_balance'), f('short_balance')
    ci = np.array([cal_pos.get(d, -1) for d in dates])
    F = div_factors(dates, C, divs)
    A = C * np.cumprod(F)
    Cp = np.concatenate([[np.nan], C[:-1]])
    ra = np.concatenate([[np.nan], A[1:] / A[:-1] - 1])          # 含息日報酬
    rr = np.concatenate([[np.nan], C[1:] / C[:-1] - 1])          # 原始價日報酬(= build_one 的 vol20 用的)
    cliff_idx = np.where(np.abs(ra) > CLIFF)[0]
    tw = np.array([tw_ret.get(d, np.nan) for d in dates])
    amt = C * V
    lim = np.array([lim_of(d) for d in dates])

    X = np.full((n, K), np.nan, dtype=float)

    def put(name, arr):
        X[:, NI[name]] = arr

    # ── A 動能(chg* = build_one 原始價;長天期用含息)──
    for k_, nm in ((1, 'chg1'), (5, 'chg5'), (10, 'chg10'), (20, 'chg20'), (60, 'chg60')):
        a = np.full(n, np.nan)
        a[k_:] = (C[k_:] / C[:-k_] - 1) * 100
        put(nm, a)
    for k_, nm in ((120, 'mom120'), (250, 'mom250')):
        a = np.full(n, np.nan)
        a[k_:] = (A[k_:] / A[:-k_] - 1) * 100
        put(nm, a)
    a = np.full(n, np.nan)
    a[250:] = (A[230:-20] / A[:-250] - 1) * 100
    put('mom12_1', a)
    up = np.concatenate([[np.nan], (C[1:] > C[:-1]).astype(float)])
    put('upshare20', rolling(up, 20, lambda v: v.mean(axis=1)))
    # ── B 位置 ──
    hi252 = rolling(C, 252, lambda v: v.max(axis=1))
    lo252 = rolling(C, 252, lambda v: v.min(axis=1))
    put('pos252', np.where(hi252 > lo252, (C - lo252) / (hi252 - lo252) * 100, np.nan))
    put('dd252', (C / hi252 - 1) * 100)
    put('dhi252', rolling(C, 252, lambda v: (v.shape[1] - 1) - (v.shape[1] - 1 - np.argmax(v[:, ::-1], axis=1))))
    h60 = rolling(H, 60, lambda v: v.max(axis=1))
    put('dd60', (C / h60 - 1) * 100)
    for k_, nm in ((5, 'b5'), (20, 'b20'), (60, 'b60'), (240, 'b240')):
        m = rolling(C, k_, lambda v: v.mean(axis=1))
        put(nm, (C / m - 1) * 100)
    m5 = rolling(C, 5, lambda v: v.mean(axis=1))
    m20 = rolling(C, 20, lambda v: v.mean(axis=1))
    m60 = rolling(C, 60, lambda v: v.mean(axis=1))
    put('bull', np.where(np.isfinite(m60), ((m5 > m20) & (m20 > m60)).astype(float), np.nan))
    hi20 = rolling(C, 20, lambda v: v.max(axis=1))
    nh = (C >= hi20 - 1e-9).astype(float)
    nh[~np.isfinite(hi20)] = np.nan
    put('nh20cnt60', rolling(nh, 60, lambda v: v.sum(axis=1)))
    # ── C 波動 ──
    put('vol20', rolling(rr, 20, lambda v: np.sqrt((v ** 2).mean(axis=1)) * math.sqrt(252.0) * 100))
    put('vol60', rolling(ra, 60, lambda v: np.sqrt((v ** 2).mean(axis=1)) * math.sqrt(252.0) * 100))
    tr = np.maximum.reduce([H - L, np.abs(H - Cp), np.abs(L - Cp)])
    put('atrp', rolling(tr, 14, lambda v: v.mean(axis=1)) / C * 100)
    put('max20', rolling(ra, 20, lambda v: v.max(axis=1)) * 100)

    def _skew(v):
        mu = v.mean(axis=1, keepdims=True)
        s = v.std(axis=1)
        return np.where(s > 0, ((v - mu) ** 3).mean(axis=1) / np.where(s > 0, s, 1) ** 3, np.nan)
    put('skew60', rolling(ra, 60, _skew))
    wr = end_win(ra, 120)
    wt = end_win(tw, 120)
    if wr is not None:
        ok = np.isfinite(wr) & np.isfinite(wt)
        cnt = ok.sum(axis=1)
        x = np.where(ok, wt, 0.0)
        y = np.where(ok, wr, 0.0)
        mx = x.sum(axis=1) / np.maximum(cnt, 1)
        my = y.sum(axis=1) / np.maximum(cnt, 1)
        cov = (np.where(ok, (wt - mx[:, None]) * (wr - my[:, None]), 0.0)).sum(axis=1) / np.maximum(cnt - 1, 1)
        var = (np.where(ok, (wt - mx[:, None]) ** 2, 0.0)).sum(axis=1) / np.maximum(cnt - 1, 1)
        beta = np.where((cnt >= 80) & (var > 0), cov / np.where(var > 0, var, 1), np.nan)
        res = np.where(ok, (wr - my[:, None]) - beta[:, None] * (wt - mx[:, None]), 0.0)
        iv = np.sqrt((res ** 2).sum(axis=1) / np.maximum(cnt - 2, 1)) * math.sqrt(252.0) * 100
        b_ = np.full(n, np.nan)
        i_ = np.full(n, np.nan)
        b_[119:] = beta
        i_[119:] = np.where(np.isfinite(beta), iv, np.nan)
        put('beta120', b_)
        put('ivol120', i_)
    put('dvol60', rolling(np.minimum(ra, 0), 60, lambda v: np.sqrt((v ** 2).mean(axis=1)) * math.sqrt(252.0) * 100))
    v20a = rolling(ra, 20, lambda v: np.sqrt((v ** 2).mean(axis=1)))
    v120a = rolling(ra, 120, lambda v: np.sqrt((v ** 2).mean(axis=1)))
    put('vratio', np.where(v120a > 0, v20a / np.where(v120a > 0, v120a, 1), np.nan))
    put('amp20', rolling((H - L) / C, 20, lambda v: v.mean(axis=1)) * 100)
    # ── D 量 / 規模 ──
    a20 = rolling(amt, 20, lambda v: v.mean(axis=1))
    a5 = rolling(amt, 5, lambda v: v.mean(axis=1))
    a120 = rolling(amt, 120, lambda v: v.mean(axis=1))
    put('amt20', a20 / 1e8)
    put('amt5_20', np.where(a20 > 0, a5 / np.where(a20 > 0, a20, 1), np.nan))
    put('amt20_120', np.where(a120 > 0, a20 / np.where(a120 > 0, a120, 1), np.nan))
    ill = np.where(amt > 0, np.abs(ra) / np.where(amt > 0, amt, 1) * 1e8, np.nan)
    put('illiq20', rolling(ill, 20, lambda v: np.nanmean(v, axis=1) if v.size else np.nan))
    put('price', C)
    lu = ((C >= Cp * (1 + lim - 0.01)) & (C >= H - 1e-9)).astype(float)
    lu[0] = np.nan
    put('lu20', rolling(lu, 20, lambda v: v.sum(axis=1)))
    put('lu60', rolling(lu, 60, lambda v: v.sum(axis=1)))
    # ── E K 棒 ──
    rng = H - L
    put('clv20', rolling(np.where(rng > 0, (C - L) / np.where(rng > 0, rng, 1), 0.5), 20, lambda v: v.mean(axis=1)))
    put('ushadow20', rolling(np.where(rng > 0, (H - np.maximum(O, C)) / np.where(rng > 0, rng, 1), 0.0), 20, lambda v: v.mean(axis=1)))
    Hp = np.concatenate([[np.nan], H[:-1]])
    Lp = np.concatenate([[np.nan], L[:-1]])
    gu = (O * F > Hp).astype(float)
    gd = (O * F < Lp).astype(float)
    gu[0] = gd[0] = np.nan
    put('gapup20', rolling(gu, 20, lambda v: v.sum(axis=1)))
    put('gapdn20', rolling(gd, 20, lambda v: v.sum(axis=1)))
    on = np.log(O * F / Cp)
    idr = np.log(C / O)
    put('on20', rolling(on, 20, lambda v: v.sum(axis=1)) * 100)
    put('id20', rolling(idr, 20, lambda v: v.sum(axis=1)) * 100)
    # ── F 籌碼(單位:股 ÷ 股 → %;視窗內有缺 → NaN)──
    v5, v20, v60 = rsum_strict(V, 5), rsum_strict(V, 20), rsum_strict(V, 60)
    for src, nm5, nm20, nm60 in ((FN, 'f5r', 'f20r', 'f60r'), (TN, 't5r', 't20r', 't60r')):
        put(nm5, np.where(v5 > 0, rsum_strict(src, 5) / np.where(v5 > 0, v5, 1) * 100, np.nan))
        put(nm20, np.where(v20 > 0, rsum_strict(src, 20) / np.where(v20 > 0, v20, 1) * 100, np.nan))
        put(nm60, np.where(v60 > 0, rsum_strict(src, 60) / np.where(v60 > 0, v60, 1) * 100, np.nan))
    put('d20r', np.where(v20 > 0, rsum_strict(DN, 20) / np.where(v20 > 0, v20, 1) * 100, np.nan))
    put('i20r', np.where(v20 > 0, rsum_strict(FN + TN + DN, 20) / np.where(v20 > 0, v20, 1) * 100, np.nan))
    fs = streak_pos(FN)
    fs[~np.isfinite(FN)] = np.nan
    ts = streak_pos(TN)
    ts[~np.isfinite(TN)] = np.nan
    put('fstreak', fs)
    put('tstreak', ts)
    sy = ((FN > 0) & (TN > 0)).astype(float)
    sy[~(np.isfinite(FN) & np.isfinite(TN))] = np.nan
    put('ftsync5', rsum_strict(sy, 5))
    put('mg5p', np.where(np.concatenate([np.full(5, np.nan), MB[:-5]]) > 0, (MB / np.concatenate([np.full(5, np.nan), MB[:-5]]) - 1) * 100, np.nan))
    put('mg20p', np.where(np.concatenate([np.full(20, np.nan), MB[:-20]]) > 0, (MB / np.concatenate([np.full(20, np.nan), MB[:-20]]) - 1) * 100, np.nan))
    put('sbr', np.where(MB > 0, SB / np.where(MB > 0, MB, 1) * 100, np.nan))

    # ── 取樣 + 逐列的東西(streak / fpct250 / 基本面 / 報酬)──
    pick = [i for i in range(WARM - 1, n - 1) if ci[i] >= 0 and ci[i] in sample_set]
    if not pick:
        return None
    sgn = np.sign(np.nan_to_num(np.concatenate([[0.0], C[1:] - C[:-1]])))
    fpub = [x[0] for x in fund] if fund else []
    out_ci, out_x, out_r, out_lock = [], [], [], []
    for i in pick:
        lo_c = bisect.bisect_right(cliff_idx, i - (WARM - 1))
        hi_c = bisect.bisect_right(cliff_idx, i + max(HS))
        if hi_c > lo_c:
            continue                                       # 前後有斷崖 → 整列丟掉(⛔ 不讓假報酬進來)
        if i + 1 >= n or ci[i + 1] - ci[i] > 3:
            continue                                       # 隔天沒有開盤可以買(停牌)
        x = X[i].copy()
        # streak(= build_one:最近 30 個漲跌號誌,從最後往前數同號)
        s0 = sgn[i]
        k = 0
        if s0 != 0:
            for j in range(i, max(0, i - 30), -1):
                if sgn[j] == s0:
                    k += 1
                else:
                    break
        x[NI['streak']] = k * s0
        # fpct250:今天外資買超在自己過去 250 天(⛔ 不含今天)排第幾(至少 120 個過去值)
        fv = FN[i]
        if fv == fv:
            past = FN[max(0, i - 250):i]
            past = past[np.isfinite(past)]
            if len(past) >= 120:
                x[NI['fpct250']] = float((past < fv).mean() * 100)
        # 基本面:公布日嚴格早於今天的最後一季
        if fpub:
            j = bisect.bisect_left(fpub, dates[i]) - 1
            if j >= 0:
                row = fund[j]
                for c_ in FUND_COLS:
                    x[NI[c_]] = row[2 + FUND_IDX[c_]] if row[2 + FUND_IDX[c_]] is not None else np.nan
                e4, bv = row[2 + FUND_IDX['eps4']], row[2 + FUND_IDX['bvps']]
                x[NI['ep']] = (e4 / C[i] * 100) if e4 is not None else np.nan
                x[NI['bp']] = (bv / C[i]) if bv is not None else np.nan
        # 報酬:隔天開盤買 → h 天後收盤(含息:隔天之後的除權息倍數乘回來)
        rv = []
        for h in HS:
            if i + h < n and ci[i + h] - ci[i] <= h + 10 and O[i + 1] > 0:
                rv.append((C[i + h] * np.prod(F[i + 2:i + h + 1]) / O[i + 1] - 1) * 100)
            else:
                rv.append(np.nan)
        lock = bool(O[i + 1] >= C[i] * (1 + lim[i + 1] - 0.005) and H[i + 1] == L[i + 1])
        out_ci.append(ci[i])
        out_x.append(x)
        out_r.append(rv)
        out_lock.append(lock)
    if not out_ci:
        return None
    return (np.array(out_ci, dtype=np.int32), np.array(out_x, dtype=np.float32),
            np.array(out_r, dtype=np.float32), np.array(out_lock, dtype=bool))


FUND_IDX = {}


def load_fund(path):
    """factor_fund_export.mjs 的輸出 → {sym: [[pub, p, ...]]};cols 對應寫進 FUND_IDX。"""
    raw = load(path) if path else None
    if not raw:
        return {}
    FUND_IDX.clear()
    for i, c in enumerate(raw.get('cols') or []):
        FUND_IDX[c] = i
    need = set(FUND_COLS) | {'eps4', 'bvps'}
    miss = need - set(FUND_IDX)
    if miss:
        print(f'❌ 基本面匯出缺欄 {sorted(miss)} → 不用基本面(⛔ 不猜欄位)')
        return {}
    return raw.get('s') or {}


def pool_days(files, cal_pos, ncal, top):
    """第一趟:每檔逐日 20 日均成交額(= build_one amt20 同一條),每個交易日取前 top 名 → {代號: {日曆索引}}。
    給第二層用(👑 的池子是成交額前 100 大;多抓一點緩衝,判定時再切回前 100)。"""
    M = np.full((len(files), ncal), -1.0, dtype=np.float32)
    for k_, p in enumerate(files):
        rows = [r for r in (load(p) or []) if r and float(r.get('close') or 0) > 0]
        if len(rows) < 20:
            continue
        c = np.array([float(r['close']) for r in rows])
        v = np.array([float(r.get('volume') or 0) for r in rows])
        a20 = rolling(c * v, 20, lambda w: w.mean(axis=1))
        ci = [cal_pos.get(_d(r.get('date')), -1) for r in rows]
        for i, x in enumerate(a20):
            if ci[i] >= 0 and x == x:
                M[k_, ci[i]] = x
    out = {}
    for d in range(ncal):
        col = M[:, d]
        if (col > 0).sum() < top:
            continue
        for k_ in np.argpartition(-col, top)[:top]:
            if col[k_] > 0:
                out.setdefault(files[k_].stem, set()).add(d)
    return out


POOL_TOP = int(os.getenv('POOL_TOP') or 0)


def build(data=None, out=None, verbose=True):
    data = Path(data or DATA)
    out = Path(out or OUT)
    tw_rows = load(data / '^TWII.json') or []
    tw = sorted((_d(r.get('date')), float(r.get('close') or 0)) for r in tw_rows if r and float(r.get('close') or 0) > 0)
    if len(tw) < 300:
        print('❌ 沒有 ^TWII.json(或太短)→ 沒有日曆,⛔ 不跑')
        return None
    cal = [d for d, _ in tw]
    cal_pos = {d: i for i, d in enumerate(cal)}
    tw_ret = {cal[i]: tw[i][1] / tw[i - 1][1] - 1 for i in range(1, len(tw))}
    sample_set = {i for i in range(len(cal)) if i % STRIDE == OFFSET}
    divs_all = load(os.getenv('DIV') or (data / 'dividends_hist.json')) or {}
    if isinstance(divs_all, dict) and 'd' in divs_all and isinstance(divs_all['d'], dict):
        divs_all = divs_all['d']
    fund = load_fund(os.getenv('FUND') or '')
    ind = load(os.getenv('IND_MAP') or (data / 'industry_map.json')) or {}
    files = sorted(p for p in data.glob('*.json') if p.stem.isdigit() and len(p.stem) == 4 and not p.stem.startswith('0'))
    if MAX_SYMS:
        step = max(1, len(files) // MAX_SYMS)
        files = files[::step][:MAX_SYMS]                   # 等距抽樣(⛔ 不取前 N 檔 = 按產業取樣,V72.1.7)
    if verbose:
        print(f'📂 {len(files)} 檔 ・日曆 {cal[0]}~{cal[-1]}({len(cal)} 天)・每 {STRIDE} 天一個橫切面 ・暖身 {WARM} 根 ・'
              f'除權息 {len(divs_all)} 檔 ・基本面 {len(fund)} 檔 ・產業 {len(ind)} 檔', flush=True)
    pool_sets = pool_days(files, cal_pos, len(cal), POOL_TOP) if POOL_TOP else None
    syms, by_year = [], {}
    n_rows = n_skip = 0
    for k_, p in enumerate(files):
        sym = p.stem
        if pool_sets is not None and not pool_sets.get(sym):
            n_skip += 1
            continue
        rows = load(p)
        divs = divs_all.get(sym) if isinstance(divs_all, dict) else None
        if isinstance(divs, dict):
            divs = divs.get('h')
        res = per_stock(sym, rows, cal_pos, tw_ret, divs, fund.get(sym), pool_sets.get(sym) if pool_sets is not None else sample_set)
        if res is None:
            n_skip += 1
            continue
        si = len(syms)
        syms.append(sym)
        cis, xs, rs, lk = res
        n_rows += len(cis)
        years = np.array([int(cal[c][:4]) for c in cis])
        for y in np.unique(years):
            m = years == y
            b = by_year.setdefault(int(y), {'c': [], 's': [], 'x': [], 'r': [], 'l': []})
            b['c'].append(cis[m]); b['s'].append(np.full(int(m.sum()), si, dtype=np.int32))
            b['x'].append(xs[m]); b['r'].append(rs[m]); b['l'].append(lk[m])
        if verbose and (k_ + 1) % 300 == 0:
            print(f'   … {k_ + 1}/{len(files)} 檔 ・{n_rows:,} 列', flush=True)
    if n_rows < 1000:
        print(f'❌ 只有 {n_rows} 列 → 資料不足,⛔ 不寫')
        return None
    out.mkdir(parents=True, exist_ok=True)
    for y, b in sorted(by_year.items()):
        np.savez_compressed(out / f'panel_{y}.npz', date_i=np.concatenate(b['c']), sym_i=np.concatenate(b['s']),
                            X=np.concatenate(b['x']), R=np.concatenate(b['r']), lock=np.concatenate(b['l']))
    meta = {'names': NAMES, 'hs': list(HS), 'cal': cal, 'syms': syms, 'ind': {s: ind.get(s) for s in syms},
            'stride': STRIDE, 'offset': OFFSET, 'warm': WARM, 'rows': n_rows, 'skipped': n_skip,
            'years': sorted(by_year), 'div_syms': len(divs_all), 'fund_syms': len(fund), 'data': str(data)}
    (out / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
    if verbose:
        print(f'✅ {len(syms)} 檔(略過 {n_skip})・{n_rows:,} 列 ・{len(by_year)} 年 → {out}', flush=True)
    return meta


# ── 跟 build_one 逐值比對(⛔ 不產生第二份定義)────────────────────
SAME = ('chg5', 'chg10', 'chg20', 'chg60', 'amt20', 'pos252', 'dd60', 'b5', 'b20', 'b60', 'b240', 'vol20', 'amp20', 'bull', 'streak')


def compare_build_one(rows, i, x):
    """rows[:i+1] 丟進 build_one,跟面板那一列比;回不一致的欄位清單。"""
    import screener_miner as SM
    v = SM.build_one(rows[:i + 1])
    if v is None:
        return ['build_one 回 None']
    bad = []
    for nm in SAME:
        a = v[SM.CI[nm]]
        b = x[NI[nm]]
        if a is None and not np.isfinite(b):
            continue
        tol = 0.051 if nm in ('pos252', 'vol20') else 0.006      # build_one 這兩欄 rd(…, 1)、其餘 rd(…, 2)
        if a is None or not np.isfinite(b) or abs(float(a) - float(b)) > tol + abs(float(a)) * 1e-6:
            bad.append(f'{nm}:{a} vs {b:.4f}')
    return bad


def check_real(nsamp):
    """真資料抽樣:每檔挑一天,面板值跟 build_one 逐值比。"""
    import random
    random.seed(11)
    data = DATA
    tw_rows = load(data / '^TWII.json') or []
    cal = sorted(_d(r.get('date')) for r in tw_rows if r)
    cal_pos = {d: i for i, d in enumerate(cal)}
    files = sorted(p for p in data.glob('*.json') if p.stem.isdigit() and len(p.stem) == 4 and not p.stem.startswith('0'))
    random.shuffle(files)
    n_ok = n_bad = 0
    for p in files[:nsamp]:
        rows = [r for r in (load(p) or []) if r and float(r.get('close') or 0) > 0]
        if len(rows) < WARM + 30:
            continue
        i = random.randrange(WARM, len(rows) - 25)
        res = per_stock(p.stem, rows, cal_pos, {}, None, None, {cal_pos.get(_d(rows[i].get('date')), -9)})
        if res is None:
            continue
        bad = compare_build_one(rows, i, res[1][0])
        if bad:
            n_bad += 1
            if n_bad <= 5:
                print(f'   ❌ {p.stem} {_d(rows[i].get("date"))}:{bad[:4]}')
        else:
            n_ok += 1
    print(f'🔎 真資料抽樣 {n_ok + n_bad} 檔:跟 build_one 一致 {n_ok}、不一致 {n_bad}')
    return 0 if n_bad == 0 and n_ok >= min(50, nsamp // 3) else 1


# ── 🧪 selftest ───────────────────────────────────────────────────
def selftest():
    import tempfile
    global WARM, STRIDE
    bad = []

    def ok(name, cond, extra=''):
        print(f"  {'✅' if cond else '❌'} {name}{(' ・' + str(extra)[:220]) if not cond else ''}")
        if not cond:
            bad.append(name)
    rng = np.random.default_rng(5)
    n = 420
    days = []
    d0 = np.datetime64('2016-01-04')
    while len(days) < n:
        if np.is_busday(d0):
            days.append(str(d0))
        d0 += np.timedelta64(1, 'D')
    tw = [{'date': d.replace('-', '/'), 'close': 9000 * (1.0003 ** i)} for i, d in enumerate(days)]

    def mk(seed, fn=None, lock_at=None, div_at=None, cliff_at=None):
        g = np.random.default_rng(seed)
        rows, c = [], 50.0
        for i, d in enumerate(days):
            c *= 1 + g.normal(0.0005, 0.02)
            o = c * (1 + g.normal(0, 0.005))
            h, l_ = max(o, c) * 1.01, min(o, c) * 0.99
            r = {'date': d.replace('-', '/'), 'open': round(o, 2), 'high': round(h, 2), 'low': round(l_, 2), 'close': round(c, 2),
                 'volume': int(1e6 + g.integers(0, 5e5)), 'foreign_net': (fn(i) if fn else int(g.normal(0, 2e5))),
                 'trust_net': int(g.normal(0, 5e4)), 'dealer_net': int(g.normal(0, 3e4)), 'margin_balance': 3000 + i, 'short_balance': 100}
            rows.append(r)
        if lock_at is not None:
            p = rows[lock_at - 1]['close'] * 1.1
            rows[lock_at].update({'open': round(p, 2), 'high': round(p, 2), 'low': round(p, 2), 'close': round(p, 2)})
        if cliff_at is not None:
            for r in rows[cliff_at:]:
                for k_ in ('open', 'high', 'low', 'close'):
                    r[k_] = round(r[k_] * 2.0, 2)
        return rows
    with tempfile.TemporaryDirectory() as td:
        t = Path(td)
        (t / '^TWII.json').write_text(json.dumps(tw))
        rows_a = mk(1)
        (t / '1101.json').write_text(json.dumps(rows_a))
        cal = days
        cal_pos = {d: i for i, d in enumerate(cal)}
        tw_ret = {cal[i]: tw[i]['close'] / tw[i - 1]['close'] - 1 for i in range(1, len(cal))}
        WARM, STRIDE = 252, 5
        ss = {i for i in range(len(cal)) if i % 5 == 0}
        res = per_stock('1101', rows_a, cal_pos, tw_ret, None, None, ss)
        ok('⓪ 有取樣到列、欄數 = 變因數、報酬 3 欄', res is not None and res[1].shape[1] == K and res[2].shape[1] == 3, None if res is None else res[1].shape)
        # ① 跟 build_one 逐值比(同名欄位一字不差)
        cis = res[0]
        mism = []
        for k_, c_ in enumerate(cis[:12]):
            i = cal_pos[cal[c_]]
            mism += compare_build_one(rows_a, i, res[1][k_])
        ok('① chg / amt20 / pos252 / dd60 / 乖離 / vol20 / amp20 / bull / streak 跟 build_one 逐值相同', not mism, mism[:4])
        # ② 零前視:改「取樣那天之後」的資料,那天的變因一個都不可變(報酬要變)
        i0 = cal_pos[cal[cis[3]]]
        rows_b = json.loads(json.dumps(rows_a))
        for r in rows_b[i0 + 1:]:
            r['foreign_net'] = 9e9
        for r in rows_b[i0 + 2:]:                       # 進場是 i0+1 開盤 → 從 i0+2 起改價,報酬才會變
            r['close'] = round(r['close'] * 1.3, 2)
            r['open'] = round(r['open'] * 1.3, 2)
            r['high'] = round(r['high'] * 1.3, 2)
            r['low'] = round(r['low'] * 1.3, 2)
        res_b = per_stock('1101', rows_b, cal_pos, tw_ret, None, None, ss)
        k3 = list(res_b[0]).index(cis[3])
        same = np.allclose(np.nan_to_num(res[1][3], nan=-7), np.nan_to_num(res_b[1][k3], nan=-7), atol=1e-5)
        ok('② 零前視:改那天之後的價格與外資 → 那天的變因完全不變', same,
           [NAMES[j] for j in np.where(~np.isclose(np.nan_to_num(res[1][3], nan=-7), np.nan_to_num(res_b[1][k3], nan=-7), atol=1e-5))[0]][:6])
        ok('② …但那天之後的報酬要變(注入真的有效)', abs(float(res[2][3][1]) - float(res_b[2][k3][1])) > 1, (res[2][3][1], res_b[2][k3][1]))
        # ③ 除權息:有一筆合格的除息 → 跨過去的報酬要把股息加回來
        i1 = cal_pos[cal[cis[5]]]
        rows_c = json.loads(json.dumps(rows_a))
        pc = rows_c[i1 + 3]['close']
        for r in rows_c[i1 + 4:]:
            for k_ in ('open', 'high', 'low', 'close'):
                r[k_] = round(r[k_] - 2.0, 2)                 # 第 i1+4 天除息 2 元(之後的價全部少 2 元)
        divs = [[rows_c[i1 + 4]['date'], 2.0, '息', pc, round(pc - 2.0, 2)]]
        r_nodiv = per_stock('1101', rows_c, cal_pos, tw_ret, None, None, ss)[2][5][1]
        r_div = per_stock('1101', rows_c, cal_pos, tw_ret, divs, None, ss)[2][5][1]
        r_orig = res[2][5][1]
        ok('③ 除息那段:有股息資料的報酬 ≈ 沒除息時的報酬(差 <0.6pp);沒股息資料會被低估', abs(r_div - r_orig) < 0.6 and r_nodiv < r_div - 2, (r_orig, r_div, r_nodiv))
        # ④ 隔天開盤鎖漲停 → lock
        i2 = cal_pos[cal[cis[6]]]
        rows_d = mk(1, lock_at=i2 + 1)
        res_d = per_stock('1101', rows_d, cal_pos, tw_ret, None, None, ss)
        k6 = list(res_d[0]).index(cis[6])
        ok('④ 隔天開盤就一字漲停 → lock=1(買不到);其他列 lock=0', bool(res_d[3][k6]) and not res_d[3][:k6].any(), res_d[3][:k6 + 1])
        # ⑤ 斷崖 → 前後那段整列丟掉
        i3 = cal_pos[cal[cis[4]]] + 3
        res_e = per_stock('1101', mk(1, cliff_at=i3), cal_pos, tw_ret, None, None, ss)
        kept = set(res_e[0]) if res_e else set()
        ok('⑤ 單日 ×2 斷崖:往後 20 天 / 往前 252 天內的取樣列都不留', all(c_ not in kept for c_ in cis if abs(cal_pos[cal[c_]] - i3) <= 20), sorted(kept)[:5])
        # ⑥ 基本面:公布日當天還不算知道(嚴格早於)
        FUND_IDX.clear()
        for j_, c_ in enumerate(list(FUND_COLS) + ['bvps', 'eps4']):
            FUND_IDX[c_] = j_
        dsamp = cal[cis[2]]
        fund = [['2016-03-31', '2015-12-31'] + [1.0] * len(FUND_IDX), [dsamp, '2016-03-31'] + [2.0] * len(FUND_IDX)]
        res_f = per_stock('1101', rows_a, cal_pos, tw_ret, None, fund, ss)
        k2 = list(res_f[0]).index(cis[2])
        ok('⑥ 基本面:公布日當天用上一季(⛔ 不可 ≤)、隔一個取樣日才換新的一季',
           res_f[1][k2][NI['revY']] == 1.0 and res_f[1][k2 + 1][NI['revY']] == 2.0, (res_f[1][k2][NI['revY']], res_f[1][k2 + 1][NI['revY']]))
        # ⑦ 籌碼:外資每天買 1,000 股、量 1e6 上下 → f5r ≈ 0.1%、fstreak 連續增加
        res_g = per_stock('1101', mk(2, fn=lambda i: 1000), cal_pos, tw_ret, None, None, ss)
        fr = res_g[1][:, NI['f5r']]
        ok('⑦ 外資天天買 → f5r 在 0.05~0.2%、fstreak = 天數', np.all((fr > 0.05) & (fr < 0.2)) and res_g[1][0][NI['fstreak']] >= WARM, (fr[:3], res_g[1][0][NI['fstreak']]))
        # ⑨ 池子:每天成交額前 N 名(第一趟)——量大的那檔每天都在,量小的不在
        big = mk(3)
        for r in big:
            r['volume'] = r['volume'] * 50
        (t / '2330.json').write_text(json.dumps(big))
        ps = pool_days([t / '1101.json', t / '2330.json'], cal_pos, len(cal), 1)
        ok('⑨ 池子前 1 名:每天都是量大的 2330、1101 一天都沒有', set(ps) == {'2330'} and len(ps['2330']) >= len(cal) - 25, {k: len(v) for k, v in ps.items()})
        # ⑧ build():沒有 ^TWII → 不跑
        (t / '^TWII.json').unlink()
        ok('⑧ 沒有 ^TWII.json → 回 None(⛔ 不寫空面板)', build(t, t / 'out', verbose=False) is None)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if '--check-real' in sys.argv:
        sys.exit(check_real(int(sys.argv[sys.argv.index('--check-real') + 1])))
    sys.exit(0 if build() else 1)
