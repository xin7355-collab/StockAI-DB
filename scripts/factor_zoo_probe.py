#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🦓 變因總表(V79.3.8)—— 「變因因子」研究的判定:每個變因用同一套方法、同一次多重比較一起測

使用者(2026-10-20):「我想做的是變因因子,不是單獨的一般回測,把能測試的都列出來再來執行。」
面板來自 `factor_panel.py`(每檔每 5 個交易日一列、~70 個變因、隔天開盤買 → 5/10/20 天後收盤、含息)。

📐 第一層(全部變因 × 兩個母體 × 主判 10 天):
  ・母體 U1 = 全市場可交易(20 日均成交額 ≥ 1,000 萬、隔天開盤買得到)・U2 = 當天成交額前 100 大(👑 的池子)
  ・報酬一律減「同一天、同一個母體的平均」(= 比同一天隨便挑一檔多多少)
  ・每天把母體依變因分五等分 → 最高 − 最低(方向照全期結果定)、名次相關(IC)、五等分是否單調(高原)
  ・Newey-West t(重疊期 lag = ⌈h ÷ 取樣間隔⌉)→ **全部變因 × 母體一起做 BH**
  ・六關:全期 / 前後半同向 / 逐年 ≥80% 同向 / 去最好年 / 扣成本(最好那一等分 − 0.44)/ 格內(成交額 × 波動 × 位階 三分位 27 格,格內排名仍同向且 t ≥ 2)
  ・**過第一層(先寫死,⛔ 跑完不改)**:BH q ≤ 0.05 + 前後半同向 + 逐年 ≥80% + 格內 + 五等分單調(名次相關 ≥ 0.9)
  ・另外:每個變因 × 大盤狀態(嚴格空頭 / 多頭、加權波動高 / 低)、變因彼此相關表(|ρ| ≥ 0.7 = 同一件事換名字)
📐 大盤狀態分層(MKT_STATE,mkt_state_build.py 產的;V79.3.8):每個變因 × 每個大盤狀態(外資 / 融資 / P/C / 匯率 / 美債 / 油金 /
  美股 / 櫃買相對 …)→ 狀態在「過去 750 天」的前三分之一 vs 後三分之一,那個變因的「最高 − 最低」差多少(Newey-West 迴歸 t)、
  全部變因 × 狀態 × 母體一起 BH、前後半同向才算 —— **只描述「在什麼盤比較有效」,⛔ 不是訊號**;
  狀態值一律取橫切面那一天**以前**(⛔ 不含當天)最近的一筆 = 零前視(selftest ⑩ 有「偷看當天」的決定性對照)。
📐 第二層(👑 增量,LEAD_TRACE + POOL_DIR):leader_probe 每次換倉「本來會買的」那幾檔,依變因在當天前 100 大池子裡的名次
  切三份比(r − 0050);池內控制住 chg10(👑 排名用的)之後的 Fama-MacBeth 係數。
  **過第二層**:兩窗口都 ≥ +1pp/筆(照第一層的方向)+ ≥60% 年份同向 + 池內 t ≥ 2。

⚠️ 統計小工具(BH / Newey-West)在這裡寫一份 Python 版:repo 的 BH 是 JS(lib_fdr.mjs),fish_score_ic_probe 的 NW 寫在模組頂層會被執行;
   兩者都是標準公式(不是本站自訂的判定),selftest ⑦ 拿已知答案對過。

跑法:PANEL_DIR=… DATA_DIR=…(加權)python3 scripts/factor_zoo_probe.py out.json
      LEAD_TRACE=lead_trace_raw.json POOL_DIR=…(POOL_TOP 面板)再加第二層
      python3 scripts/factor_zoo_probe.py --selftest
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

np.seterr(divide='ignore', invalid='ignore')

PANEL = Path(os.getenv('PANEL_DIR') or 'factor_panel')
POOL = os.getenv('POOL_DIR') or ''
DATA = Path(os.getenv('DATA_DIR') or 'data')
LEAD = os.getenv('LEAD_TRACE') or ''
COST = 0.44
MIN_U1, MIN_U2 = 100, 40          # 一天至少要這麼多檔才分五等分
AMT_MIN = 0.1                      # 億 = 1,000 萬
POOL_N = 100
YEAR_MIN_DATES = 12
EXTRA = ['ind_mom20', 'rel20', 'ind_pct20']      # 族群類(面板之後在這裡算:要整個橫切面)
L2_MIN_PP, L2_YR = 1.0, 0.6                       # 第二層:每筆 ≥ +1pp、≥60% 年份同向(先寫死)
L2_YR_LONG = 8                                     # 長窗口裡這個變因至少要有 8 年有資料(⛔ 只有近幾年的變因,兩個窗口其實是同一批筆數)
FM_LAG = 10                                        # 池子面板每天一列、10 天報酬重疊
MAP_MIN = 0.8                                      # 👑 本來會買的,對得上池子面板的比例 < 80% → 面板跟回測不是同一份資料,⛔ 不判
MKT = os.getenv('MKT_STATE') or ''
MS_WIN, MS_MIN = 750, 250                          # 大盤狀態:跟自己過去 750 筆比(至少 250 筆才分)
MS_DATES = 60                                      # 高 / 低兩邊各至少 60 個橫切面(約 1.2 年)才判


# ── 統計 ─────────────────────────────────────────────────────────
def nw_t(x, lag):
    """Newey-West t(Bartlett 權重)。x 是逐日序列;回 (mean, t)。"""
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 10:
        return float('nan'), float('nan')
    mu = x.mean()
    e = x - mu
    v = (e @ e) / n
    for L in range(1, min(lag, n - 1) + 1):
        v += 2 * (1 - L / (lag + 1)) * (e[:-L] @ e[L:]) / n
    se = math.sqrt(max(v, 1e-300) / n)
    return float(mu), float(mu / se)


def nw_ols(y, x, lag):
    """y = a + b·x 的 b 與 Newey-West t(Bartlett)。x 是 0/1(高 / 低狀態)。"""
    y, x = np.asarray(y, float), np.asarray(x, float)
    m = np.isfinite(y) & np.isfinite(x)
    y, x = y[m], x[m]
    n = len(y)
    if n < 20 or x.min() == x.max():
        return float('nan'), float('nan')
    xc = x - x.mean()
    sxx = (xc * xc).sum()
    b = (xc * (y - y.mean())).sum() / sxx
    e = y - y.mean() - b * xc
    u = xc * e
    S = (u * u).sum()
    for l in range(1, lag + 1):
        S += 2 * (1 - l / (lag + 1)) * (u[l:] * u[:-l]).sum()
    se = math.sqrt(S) / sxx if S > 0 else float('nan')
    return float(b), float(b / se) if se and se == se else float('nan')


def mkt_split(dates, series):
    """每個橫切面日:+1 = 狀態在自己過去 750 筆的前三分之一、−1 = 後三分之一、0 = 中間或還不知道。
    ⭐ 只用**嚴格早於那一天**的值(⛔ 不含當天)= 零前視。"""
    ks = sorted(series)
    vs = np.array([series[k] if series[k] is not None else np.nan for k in ks], float)
    out = np.zeros(len(dates), int)
    j = 0
    for i, d in enumerate(dates):
        while j < len(ks) and ks[j] < d:
            j += 1
        if j < 2:
            continue
        cur = vs[j - 1]
        past = vs[max(0, j - 1 - MS_WIN):j - 1]
        past = past[np.isfinite(past)]
        if not np.isfinite(cur) or len(past) < MS_MIN:
            continue
        pr = (past < cur).mean() + 0.5 * (past == cur).mean()
        out[i] = 1 if pr >= 2 / 3 else (-1 if pr <= 1 / 3 else 0)
    return out


def mkt_layer(meta, L1m, names, states, lag, verbose=True):
    """第一層 10 天那份的每日「最高 − 最低」× 每個大盤狀態 → 高狀態 − 低狀態差多少。回 {'res': [...], 'n_tests': k}。"""
    cal = meta['cal']
    res = []
    for u in ('U1', 'U2'):
        sp_all, dates = L1m.get(u, {}).get('_sp'), L1m.get(u, {}).get('_dates')
        if sp_all is None or not len(dates):
            continue
        dts = [cal[i] for i in dates]
        mid = np.median(dates)
        for sname, ser in states.items():
            lab = mkt_split(dts, ser)
            if (lab == 1).sum() < MS_DATES or (lab == -1).sum() < MS_DATES:
                continue
            for j, f in enumerate(names):
                sp = sp_all[:, j]
                m = np.isfinite(sp) & (lab != 0)
                if m.sum() < 2 * MS_DATES:
                    continue
                x = (lab[m] == 1).astype(float)
                b, t = nw_ols(sp[m], x, lag)
                if not np.isfinite(t):
                    continue
                hb = []
                for half in (dates < mid, dates >= mid):
                    mh = m & half
                    xh = lab[mh] == 1
                    hb.append(float(sp[mh][xh].mean() - sp[mh][~xh].mean()) if xh.sum() >= 10 and (~xh).sum() >= 10 else float('nan'))
                res.append({'f': f, 's': sname, 'u': u, 'b': b, 't': t, 'p': p_two(t),
                            'hi': float(sp[m][x == 1].mean()), 'lo': float(sp[m][x == 0].mean()),
                            'n_hi': int(x.sum()), 'n_lo': int((1 - x).sum()), 'h1': hb[0], 'h2': hb[1]})
    qs = bh([r['p'] for r in res]) if res else []
    for r, q in zip(res, qs):
        r['q_bh'] = float(q)
        r['passM'] = bool(q <= 0.05 and np.isfinite(r['h1']) and np.isfinite(r['h2']) and r['h1'] * r['b'] > 0 and r['h2'] * r['b'] > 0)
    if verbose:
        print(f'   大盤分層:{len(res)} 個(變因 × 狀態 × 母體)一起 BH', flush=True)
    return {'res': res, 'n_tests': len(res)}


def p_two(t):
    return float(math.erfc(abs(t) / math.sqrt(2))) if np.isfinite(t) else 1.0


def bh(ps):
    """Benjamini-Hochberg q 值(同 lib_fdr.bhQ 的算法)。"""
    ps = np.asarray([p if np.isfinite(p) else 1.0 for p in ps], float)
    m = len(ps)
    if not m:
        return []
    o = np.argsort(ps)
    q = np.empty(m)
    run = 1.0
    for r in range(m - 1, -1, -1):
        i = o[r]
        run = min(run, ps[i] * m / (r + 1))
        q[i] = min(1.0, run)
    return q.tolist()


def rank_pct(x):
    """有限值的百分位名次(0~1,平手取平均),其他 NaN。全向量化(⛔ 不逐值迴圈:一天 1,500 檔 × 70 個變因 × 800 天)。"""
    out = np.full(len(x), np.nan)
    m = np.isfinite(x)
    n = int(m.sum())
    if n < 2:
        return out
    v = x[m]
    o = np.argsort(v, kind='mergesort')
    sv = v[o]
    first = np.r_[True, sv[1:] != sv[:-1]]
    gid = np.cumsum(first) - 1
    starts = np.flatnonzero(first)
    ends = np.r_[starts[1:], n] - 1
    r = np.empty(n)
    r[o] = ((starts + ends) / 2.0)[gid]
    out[m] = r / (n - 1)
    return out


def group_rank(g, x):
    """組內百分位名次(0~1);g = 組別(整數,<0 = 不算)。"""
    out = np.full(len(x), np.nan)
    m = np.isfinite(x) & (g >= 0)
    if m.sum() < 2:
        return out
    idx = np.where(m)[0]
    o = idx[np.lexsort((x[idx], g[idx]))]
    gs = g[o]
    start = np.r_[0, np.where(np.diff(gs) != 0)[0] + 1]
    size = np.diff(np.r_[start, len(gs)])
    pos = np.arange(len(gs)) - np.repeat(start, size)
    den = np.repeat(np.maximum(size - 1, 1), size)
    out[o] = np.where(np.repeat(size, size) > 1, pos / den, np.nan)
    return out


# ── 讀面板 ───────────────────────────────────────────────────────
def load_panel(d):
    d = Path(d)
    meta = json.loads((d / 'meta.json').read_text(encoding='utf-8'))
    parts = [np.load(d / f'panel_{y}.npz') for y in meta['years']]
    P = {k: np.concatenate([p[k] for p in parts]) for k in ('date_i', 'sym_i', 'X', 'R', 'lock')}
    o = np.lexsort((P['sym_i'], P['date_i']))
    for k in P:
        P[k] = P[k][o]
    return meta, P


def add_industry(meta, P):
    """族群變因:同一天同產業的 chg20 中位(族群動能)、個股 − 族群中位、族群內名次(只用當天,零前視)。"""
    names = meta['names']
    j20 = names.index('chg20')
    ind = np.array([int(meta['ind'].get(s) or -1) if str(meta['ind'].get(s) or '').isdigit() else -1 for s in meta['syms']])
    g = ind[P['sym_i']]
    x = P['X'][:, j20].astype(float)
    di = P['date_i']
    n = len(x)
    mom = np.full(n, np.nan)
    pct = np.full(n, np.nan)
    seg = np.r_[0, np.where(np.diff(di) != 0)[0] + 1, n]
    for a, b in zip(seg[:-1], seg[1:]):
        gg, xx = g[a:b], x[a:b]
        pct[a:b] = group_rank(gg, xx)
        for code in np.unique(gg[gg >= 0]):
            m = (gg == code) & np.isfinite(xx)
            if m.sum() >= 5:
                mom[a:b][gg == code] = np.median(xx[m])
    rel = x - mom
    P['X'] = np.concatenate([P['X'], np.stack([mom, rel, pct], axis=1).astype(np.float32)], axis=1)
    return names + EXTRA


def regimes(meta):
    """每個日曆日的大盤狀態:嚴格空頭(收盤 < 季線 且 月線 < 季線)、加權 20 日波動是否高於自己過去的中位(只用當天以前)。"""
    rows = json.loads((DATA / '^TWII.json').read_text(encoding='utf-8'))
    m = {str(r['date']).replace('/', '-')[:10]: float(r['close']) for r in rows if r and float(r.get('close') or 0) > 0}
    cal = meta['cal']
    c = np.array([m.get(d, np.nan) for d in cal])
    s = np.where(np.isfinite(c), c, np.nan)
    ma = lambda w: np.array([np.nanmean(s[max(0, i - w + 1):i + 1]) if i >= w - 1 else np.nan for i in range(len(s))])
    m20, m60 = ma(20), ma(60)
    bear = (s < m60) & (m20 < m60)
    r = np.r_[np.nan, s[1:] / s[:-1] - 1]
    v20 = np.array([np.nanstd(r[max(1, i - 19):i + 1]) if i >= 20 else np.nan for i in range(len(r))])
    hi = np.zeros(len(v20), bool)
    for i in range(len(v20)):
        past = v20[max(0, i - 750):i]
        past = past[np.isfinite(past)]
        hi[i] = bool(len(past) > 100 and v20[i] > np.median(past))
    return bear, hi


# ── 第一層 ───────────────────────────────────────────────────────
def layer1(meta, P, names, h_idx=1, stride=5, verbose=True):
    hs = meta['hs']
    h = hs[h_idx]
    lag = max(1, math.ceil(h / stride))
    X, R = P['X'], P['R'][:, h_idx].astype(float)
    di = P['date_i']
    jamt, jvol, jpos = names.index('amt20'), names.index('vol20'), names.index('pos252')
    amt = X[:, jamt].astype(float)
    base_ok = np.isfinite(R) & (~P['lock'])
    U1 = base_ok & (amt >= AMT_MIN)
    n = len(R)
    seg = np.r_[0, np.where(np.diff(di) != 0)[0] + 1, n]
    # U2 = 當天成交額前 100 大
    U2 = np.zeros(n, bool)
    for a, b in zip(seg[:-1], seg[1:]):
        aa = np.where(np.isfinite(amt[a:b]), amt[a:b], -1)
        top = np.argsort(-aa)[:POOL_N]
        U2[a + top] = True
    U2 &= base_ok
    bear, hivol = regimes(meta)
    cal = meta['cal']
    years_of = np.array([int(d[:4]) for d in cal])
    K = len(names)
    out = {}
    for uname, U, mn in (('U1', U1, MIN_U1), ('U2', U2, MIN_U2)):
        dates, qm, ic, cs = [], [], [], []
        for a, b in zip(seg[:-1], seg[1:]):
            mu = U[a:b]
            if mu.sum() < mn:
                continue
            idx = np.arange(a, b)[mu]
            y = R[idx] - R[idx].mean()
            # 27 格(成交額 × 波動 × 位階 三分位,當天切)
            cell = np.full(len(idx), -1)
            okc = np.isfinite(X[idx, jamt]) & np.isfinite(X[idx, jvol]) & np.isfinite(X[idx, jpos])
            if okc.sum() >= 54:
                t3 = lambda v: np.minimum((rank_pct(v) * 3).astype(int), 2)
                ca, cv, cp = t3(X[idx, jamt].astype(float)), t3(X[idx, jvol].astype(float)), t3(X[idx, jpos].astype(float))
                cell = np.where(okc, ca * 9 + cv * 3 + cp, -1)
            yc = y.copy()
            if (cell >= 0).any():
                cm = np.bincount(np.maximum(cell, 0), weights=np.where(cell >= 0, y, 0), minlength=27)
                cn = np.bincount(np.maximum(cell, 0), weights=(cell >= 0).astype(float), minlength=27)
                yc = np.where(cell >= 0, y - cm[np.maximum(cell, 0)] / np.maximum(cn[np.maximum(cell, 0)], 1), np.nan)
            q_row = np.full((K, 5), np.nan)
            ic_row = np.full(K, np.nan)
            cs_row = np.full(K, np.nan)
            for j in range(K):
                x = X[idx, j].astype(float)
                m = np.isfinite(x)
                if m.sum() < mn:
                    continue
                rp = rank_pct(x)
                q = np.minimum((rp * 5).astype(int), 4)
                for k in range(5):
                    mk = m & (q == k)
                    if mk.any():
                        q_row[j, k] = y[mk].mean()
                ry = rank_pct(np.where(m, y, np.nan))
                ic_row[j] = np.corrcoef(rp[m], ry[m])[0, 1] if m.sum() > 2 else np.nan
                if (cell >= 0).sum() >= mn:
                    gr = group_rank(np.where(m, cell, -1), x)
                    qc = np.minimum((gr * 5).astype(int), 4)
                    hi_, lo_ = np.isfinite(gr) & (qc == 4), np.isfinite(gr) & (qc == 0)
                    if hi_.sum() >= 5 and lo_.sum() >= 5:
                        cs_row[j] = np.nanmean(yc[hi_]) - np.nanmean(yc[lo_])
            dates.append(di[a])
            qm.append(q_row)
            ic.append(ic_row)
            cs.append(cs_row)
        dates = np.array(dates)
        qm, ic, cs = np.array(qm), np.array(ic), np.array(cs)
        yrs = years_of[dates]
        mid = np.median(dates) if len(dates) else 0
        res = []
        for j in range(K):
            sp = qm[:, j, 4] - qm[:, j, 0]
            ok = np.isfinite(sp)
            if ok.sum() < 30:
                res.append({'f': names[j], 'n': int(ok.sum())})
                continue
            mu, t = nw_t(sp[ok], lag)
            sg = 1.0 if mu >= 0 else -1.0
            qmean = np.nanmean(qm[ok, j, :], axis=0)
            mono = float(np.corrcoef(np.arange(5), qmean)[0, 1]) * sg if np.all(np.isfinite(qmean)) else float('nan')
            h1 = np.nanmean(sp[ok & (dates < mid)])
            h2 = np.nanmean(sp[ok & (dates >= mid)])
            yy = {}
            for yv in np.unique(yrs[ok]):
                mm = ok & (yrs == yv)
                if mm.sum() >= YEAR_MIN_DATES:
                    yy[int(yv)] = float(np.nanmean(sp[mm]))
            yv = list(yy.values())
            same_y = sum(1 for v in yv if v * sg > 0)
            best = max(yy, key=lambda k: yy[k] * sg) if yy else None
            exb = np.nanmean(sp[ok & (yrs != best)]) if best is not None else float('nan')
            top = qmean[4] if sg > 0 else qmean[0]
            csm, cst = nw_t(cs[ok, j], lag)
            icm, ict = nw_t(ic[ok, j], lag)
            # 大盤狀態分層
            reg = {}
            for lab, mk in (('bear', bear[dates]), ('bull', ~bear[dates]), ('hivol', hivol[dates]), ('lovol', ~hivol[dates])):
                mm = ok & mk
                reg[lab] = [float(np.nanmean(sp[mm])) if mm.sum() >= 10 else None, int(mm.sum())]
            res.append({
                'f': names[j], 'n': int(ok.sum()), 'spread': float(mu), 't': float(t), 'p': p_two(t), 'dir': int(sg),
                'q': [float(v) for v in qmean], 'mono': mono, 'ic': float(icm), 'ic_t': float(ict),
                'h1': float(h1), 'h2': float(h2), 'years': yy, 'yr_same': [same_y, len(yv)], 'ex_best': float(exb), 'best_year': best,
                'top_minus_cost': float(top * sg - COST) if np.isfinite(top) else None, 'top': float(top),
                'cell': float(csm), 'cell_t': float(cst), 'reg': reg,
            })
        out[uname] = {'dates': int(len(dates)), 'rows': int(U.sum()), 'res': res,
                      '_sp': (qm[:, :, 4] - qm[:, :, 0]) if len(dates) else None, '_dates': dates}   # 大盤分層用(dump 前拿掉)
        if verbose:
            print(f'   {uname}:{len(dates)} 個橫切面 ・{int(U.sum()):,} 列', flush=True)
    # BH(兩個母體 × 全部變因一起)
    allp = [(u, i, r['p']) for u in out for i, r in enumerate(out[u]['res']) if 'p' in r]
    qs = bh([p for _, _, p in allp])
    for (u, i, _), q in zip(allp, qs):
        out[u]['res'][i]['q_bh'] = q
    for u in out:
        for r in out[u]['res']:
            if 'p' not in r:
                r['pass1'] = False
                continue
            sg = r['dir']
            g = {
                'bh': r['q_bh'] <= 0.05,
                'half': (r['h1'] * sg > 0) and (r['h2'] * sg > 0),
                'year': r['yr_same'][1] > 0 and r['yr_same'][0] >= 0.8 * r['yr_same'][1],
                'exbest': np.isfinite(r['ex_best']) and r['ex_best'] * sg > 0,
                'cost': r['top_minus_cost'] is not None and r['top_minus_cost'] > 0,
                'cell': np.isfinite(r['cell']) and r['cell'] * sg > 0 and abs(r['cell_t']) >= 2,
                'mono': np.isfinite(r['mono']) and r['mono'] >= 0.9,
            }
            r['gates'] = {k: bool(v) for k, v in g.items()}
            r['pass1'] = bool(g['bh'] and g['half'] and g['year'] and g['cell'] and g['mono'])
    return out


def corr_table(meta, P, names, every=4):
    """變因彼此的平均橫切面名次相關(每 4 個橫切面取一個);回 |ρ| ≥ 0.7 的配對。"""
    di = P['date_i']
    n = len(di)
    seg = np.r_[0, np.where(np.diff(di) != 0)[0] + 1, n]
    K = len(names)
    acc = np.zeros((K, K))
    cnt = np.zeros((K, K))
    for s_i, (a, b) in enumerate(zip(seg[:-1], seg[1:])):
        if s_i % every or b - a < 200:
            continue
        Rk = np.stack([rank_pct(P['X'][a:b, j].astype(float)) for j in range(K)], axis=1)
        for j in range(K):
            for k in range(j + 1, K):
                m = np.isfinite(Rk[:, j]) & np.isfinite(Rk[:, k])
                if m.sum() > 100:
                    c = np.corrcoef(Rk[m, j], Rk[m, k])[0, 1]
                    if np.isfinite(c):
                        acc[j, k] += c
                        cnt[j, k] += 1
    pairs = []
    for j in range(K):
        for k in range(j + 1, K):
            if cnt[j, k] >= 5:
                c = acc[j, k] / cnt[j, k]
                if abs(c) >= 0.7:
                    pairs.append([names[j], names[k], round(float(c), 2)])
    return sorted(pairs, key=lambda x: -abs(x[2]))


# ── 第二層:👑 本來會買的 × 變因在池子裡的名次 ─────────────────────
def layer2(meta_pool, Pp, names, lead_raw, dirs):
    """lead_raw = leader_probe RK_TRACE_RAW({窗口|fill: [{d,s,r,b,lock}]});Pp = POOL_TOP 面板(每天前 N 大的每一列)。"""
    cal_pos = {d: i for i, d in enumerate(meta_pool['cal'])}
    sym_pos = {s: i for i, s in enumerate(meta_pool['syms'])}
    di, si = Pp['date_i'], Pp['sym_i']
    key = di.astype(np.int64) * 100000 + si
    order = np.argsort(key)
    skey = key[order]
    jamt = names.index('amt20')
    n = len(di)
    seg = np.r_[0, np.where(np.diff(di) != 0)[0] + 1, n]
    # 池內名次(當天前 100 大才算)
    K = len(names)
    pct = np.full((n, K), np.nan, dtype=np.float32)
    inpool = np.zeros(n, bool)
    for a, b in zip(seg[:-1], seg[1:]):
        aa = Pp['X'][a:b, jamt].astype(float)
        top = np.argsort(-np.where(np.isfinite(aa), aa, -1))[:POOL_N]
        inpool[a + top] = True
        rows = a + top
        for j in range(K):
            pct[rows, j] = rank_pct(Pp['X'][rows, j].astype(float))
    out = {}
    for wkey, picks in (lead_raw or {}).items():
        recs = []
        miss = {'lock': 0, 'date': 0, 'sym': 0, 'pool': 0}      # 對不上的要數出來(⛔ 不可安靜地少算)
        for x in picks:
            if x.get('lock'):
                miss['lock'] += 1
                continue
            c = cal_pos.get(str(x['d'])[:10])
            s = sym_pos.get(x['s'])
            if c is None:
                miss['date'] += 1
                continue
            if s is None:
                miss['sym'] += 1
                continue
            kk = c * 100000 + s
            p = np.searchsorted(skey, kk)
            if p < len(skey) and skey[p] == kk and inpool[order[p]]:
                recs.append((order[p], x['r'] - x['b'], int(str(x['d'])[:4])))
            else:
                miss['pool'] += 1
        tot = len(picks) - miss['lock']
        if not recs:
            out[wkey] = {'n': 0, 'miss': miss, 'total': len(picks), 'map_rate': 0.0}
            continue
        rows = np.array([r[0] for r in recs])
        ex = np.array([r[1] for r in recs])
        yr = np.array([r[2] for r in recs])
        res = {}
        for j, nm in enumerate(names):
            v = pct[rows, j].astype(float)
            m = np.isfinite(v)
            if m.sum() < 60:
                continue
            sg = dirs.get(nm, 1)
            hi_ = m & ((v >= 2 / 3) if sg > 0 else (v <= 1 / 3))
            lo_ = m & ((v <= 1 / 3) if sg > 0 else (v >= 2 / 3))
            if hi_.sum() < 20 or lo_.sum() < 20:
                continue
            d = float(ex[hi_].mean() - ex[lo_].mean())
            va, vb = ex[hi_].var(ddof=1) / hi_.sum(), ex[lo_].var(ddof=1) / lo_.sum()
            tw = d / math.sqrt(va + vb) if va + vb > 0 else float('nan')      # Welch t(同一天的幾檔不獨立 → 只當參考,判定看逐年)
            yy = {}
            for y in np.unique(yr):
                a_, b_ = hi_ & (yr == y), lo_ & (yr == y)
                if a_.sum() >= 5 and b_.sum() >= 5:
                    yy[int(y)] = float(ex[a_].mean() - ex[b_].mean())
            same = sum(1 for v_ in yy.values() if v_ > 0)
            res[nm] = {'diff': d, 't': tw, 'n_hi': int(hi_.sum()), 'n_lo': int(lo_.sum()), 'yr_same': [same, len(yy)], 'years': yy}
        out[wkey] = {'n': len(recs), 'total': len(picks), 'miss': miss, 'map_rate': len(recs) / max(1, tot), 'res': res}
    # 池內 Fama-MacBeth:10 天報酬(減池子平均)~ 名次(chg10)+ 名次(變因)
    j10 = names.index('chg10')
    R = Pp['R'][:, 1].astype(float)
    fm = {}
    for j, nm in enumerate(names):
        if j == j10:
            continue
        coefs = []
        for a, b in zip(seg[:-1], seg[1:]):
            m = inpool[a:b] & np.isfinite(R[a:b]) & np.isfinite(pct[a:b, j]) & np.isfinite(pct[a:b, j10]) & (~Pp['lock'][a:b])
            if m.sum() < 40:
                continue
            y = R[a:b][m] - R[a:b][m].mean()
            Xm = np.stack([np.ones(m.sum()), pct[a:b, j10][m] - 0.5, pct[a:b, j][m] - 0.5], axis=1)
            try:
                beta = np.linalg.lstsq(Xm, y, rcond=None)[0]
                coefs.append(beta[2])
            except Exception:
                pass
        if len(coefs) >= 50:
            mu, t = nw_t(np.array(coefs), FM_LAG)      # 池子面板是每天一列、報酬 10 天重疊 → lag 10(⛔ 不是 2)
            fm[nm] = {'coef': mu, 't': t, 'n': len(coefs)}
    return out, fm


def gate2(L2, fm, dirs):
    """第二層判定(先寫死):每個窗口都 ≥ +1pp/筆 且 ≥60% 年份同向 + 池內控制 chg10 之後 t ≥ 2(方向跟第一層一致)。"""
    wins = [w for w, v in (L2 or {}).items() if v.get('n')]
    out = {}
    names = set()
    for w in wins:
        names |= set((L2[w].get('res') or {}).keys())
    for nm in sorted(names):
        rows = [(L2[w].get('res') or {}).get(nm) for w in wins]
        okw = bool(rows) and all(r is not None and r['diff'] >= L2_MIN_PP and r['yr_same'][1] > 0 and r['yr_same'][0] / r['yr_same'][1] >= L2_YR for r in rows)
        yrs = max((r['yr_same'][1] for r in rows if r is not None), default=0)
        short = yrs < L2_YR_LONG                       # 資料只有近幾年 → 兩窗口其實同一批 → ⛔ 不判(等補挖)
        f = fm.get(nm) or {}
        sg = dirs.get(nm, 1)
        okf = np.isfinite(f.get('t', float('nan'))) and f['t'] * sg >= 2
        out[nm] = {'wins': okw, 'fm': bool(okf), 'short': bool(short), 'years': int(yrs), 'pass2': bool(okw and okf and not short)}
    return out


def main():
    outp = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else None
    meta, P = load_panel(PANEL)
    names = add_industry(meta, P)
    print(f'🦓 面板 {len(P["R"]):,} 列 ・{len(meta["syms"])} 檔 ・{len(names)} 個變因 ・{meta["cal"][0]}~{meta["cal"][-1]}', flush=True)
    res = {'asof': meta['cal'][-1], 'panel': str(PANEL), 'names': names, 'L1': {}}
    l1f = os.getenv('L1_FROM') or ''
    if l1f:                                             # 只改第二層時重用上一次的第一層(⛔ 面板要同一份:比對 asof 與變因清單)
        old = json.loads(Path(l1f).read_text(encoding='utf-8'))
        if old.get('asof') != res['asof'] or old.get('names') != names:
            print(f'❌ L1_FROM={l1f} 跟這份面板不是同一份(asof / 變因清單不同)→ ⛔ 不重用', flush=True)
            return 1
        res['L1'], res['corr'] = old['L1'], old.get('corr')
        print(f'♻️ 第一層重用 {l1f}', flush=True)
    else:
        for hi_ in range(len(meta['hs'])):
            print(f'📐 第一層 {meta["hs"][hi_]} 天', flush=True)
            res['L1'][str(meta['hs'][hi_])] = layer1(meta, P, names, h_idx=hi_, stride=meta.get('stride', 5))
        print('🔗 變因相關表', flush=True)
        res['corr'] = corr_table(meta, P, names)
    main10 = res['L1']['10']
    if MKT:
        if l1f:
            print('⚠️ 重用第一層(L1_FROM)時沒有每日 spread → 大盤分層這一輪不跑(⛔ 不拿舊的湊)', flush=True)
        else:
            ms = json.loads(Path(MKT).read_text(encoding='utf-8'))
            states = ms.get('states') or {}
            print(f'🌐 大盤分層:{len(states)} 個狀態({MKT})', flush=True)
            res['M'] = mkt_layer(meta, main10, names, states, max(1, math.ceil(meta['hs'][1] / meta.get('stride', 5))))
            res['M']['desc'] = ms.get('desc') or {}
    for hk in res['L1']:
        for uk in res['L1'][hk]:
            for pk in ('_sp', '_dates'):
                res['L1'][hk][uk].pop(pk, None)
    dirs = {r['f']: r['dir'] for r in main10['U2']['res'] if 'dir' in r}
    for r in main10['U1']['res']:
        if 'dir' in r and r['f'] not in dirs:
            dirs[r['f']] = r['dir']
    if LEAD and POOL:
        mp, Pp = load_panel(POOL)
        n2 = add_industry(mp, Pp)
        lead_raw = json.loads(Path(LEAD).read_text(encoding='utf-8'))
        print('👑 第二層', flush=True)
        res['L2'], res['L2_fm'] = layer2(mp, Pp, n2, lead_raw, dirs)
        bad_map = {w: v.get('map_rate', 0) for w, v in res['L2'].items() if v.get('map_rate', 0) < MAP_MIN}
        if bad_map:
            print(f'❌ 第二層:👑 本來會買的對不上池子面板 {bad_map}(< {MAP_MIN:.0%})→ 面板跟回測不是同一份資料,⛔ 第二層不判', flush=True)
            res['L2_gate'] = {'error': f'map_rate {bad_map}'}
        else:
            res['L2_gate'] = gate2(res['L2'], res['L2_fm'], dirs)
    report(res)
    if outp:
        Path(outp).write_text(json.dumps(res, ensure_ascii=False, default=lambda o: None), encoding='utf-8')
        print(f'💾 {outp}')
    return 0


def report(res):
    m = res['L1']['10']
    for u in ('U1', 'U2'):
        rows = [r for r in m[u]['res'] if 'p' in r]
        rows.sort(key=lambda r: -abs(r['t']))
        print(f'\n=== 第一層 10 天 ・{u}({"全市場可交易" if u == "U1" else "成交額前 100 大"})・{m[u]["dates"]} 個橫切面 ===')
        print(f'{"變因":<11}{"最高−最低":>9}{"t":>7}{"q":>7}{"單調":>6}{"格內":>7}{"前/後半":>14}{"逐年":>7}{"最好那份−成本":>12}  過')
        for r in rows:
            g = r['gates']
            print(f'{r["f"]:<11}{r["spread"]:>+9.2f}{r["t"]:>7.1f}{r["q_bh"]:>7.3f}{r["mono"]:>6.2f}{r["cell"]:>+7.2f}'
                  f'{r["h1"]:>+7.2f}/{r["h2"]:>+6.2f}{r["yr_same"][0]:>4}/{r["yr_same"][1]:<2}{r["top_minus_cost"] if r["top_minus_cost"] is not None else float("nan"):>+12.2f}  '
                  f'{"✅" if r["pass1"] else "  "}{"".join(k[0] for k, v in g.items() if not v)}')
    if res.get('M'):
        mr = res['M']['res']
        ok = [r for r in mr if r.get('passM')]
        print(f'\n=== 🌐 大盤分層(10 天 ・高狀態 − 低狀態的「最高 − 最低」差,pp)・{res["M"]["n_tests"]} 個一起 BH ・過 {len(ok)} 個 ===')
        for r in sorted(ok or sorted(mr, key=lambda r: -abs(r['t']))[:12], key=lambda r: -abs(r['t']))[:25]:
            print(f'   {r["u"]} {r["f"]:<11}× {r["s"]:<10}{r["b"]:>+7.2f}pp t={r["t"]:>5.1f} q={r.get("q_bh", 1):.3f} '
                  f'・高 {r["hi"]:>+6.2f} / 低 {r["lo"]:>+6.2f} ・前/後半 {r["h1"]:>+6.2f}/{r["h2"]:>+6.2f} {"✅" if r.get("passM") else ""}')
        if not ok:
            print('   (上面是 |t| 最大的幾個,⛔ 沒有一個過 BH + 前後半同向)')
    if res.get('L2'):
        print('\n=== 第二層 👑(本來會買的,依池內名次:好的那三分之一 − 差的那三分之一,r−0050 每筆 pp)===')
        for w, v in res['L2'].items():
            print(f'  [{w}] {v.get("n", 0)} 筆(總共 {v.get("total", 0)} ・對得上 {v.get("map_rate", 0):.1%} ・對不上 {v.get("miss")})')
            items = sorted((v.get('res') or {}).items(), key=lambda kv: -kv[1]['diff'])
            for nm, r in items[:12] + items[-6:]:
                print(f'     {nm:<11}{r["diff"]:>+7.2f}pp t={r["t"]:>5.1f} ・{r["yr_same"][0]}/{r["yr_same"][1]} 年 ・n {r["n_hi"]}/{r["n_lo"]}')
        fm = sorted(res['L2_fm'].items(), key=lambda kv: -abs(kv[1]['t']))
        print('  池內控制 chg10 之後(Fama-MacBeth,名次 0→1 的 10 天超額 %,NW lag 10):')
        for nm, r in fm[:15]:
            print(f'     {nm:<11}{r["coef"]:>+7.2f} t={r["t"]:>5.1f} ・{r["n"]} 天')
        g = res.get('L2_gate') or {}
        if 'error' in g:
            print(f'  ⛔ 第二層沒判:{g["error"]}')
        else:
            ok2 = [nm for nm, v in g.items() if v['pass2']]
            sh = [nm for nm, v in g.items() if v['short'] and (v['wins'] or v['fm'])]
            print(f'  ✅ 過第二層:{", ".join(ok2) if ok2 else "(沒有)"} ・只過兩窗口 {sum(1 for v in g.values() if v["wins"])} 個 ・只過池內 t {sum(1 for v in g.values() if v["fm"])} 個')
            if sh:
                print(f'  ⏳ 可比較的年份不到 {L2_YR_LONG} 年、⛔ 不判(資料太短 → 等補挖;或 👑 本來會買的幾乎都在同一份 → 這個變因跟動能是同一件事):{", ".join(sh)}')


# ── 🧪 selftest ───────────────────────────────────────────────────
def selftest():
    import tempfile
    global DATA
    bad = []

    def ok(name, cond, extra=''):
        print(f"  {'✅' if cond else '❌'} {name}{(' ・' + str(extra)[:220]) if not cond else ''}")
        if not cond:
            bad.append(name)
    rng = np.random.default_rng(3)
    # 合成面板:400 個橫切面 × 300 檔;變因 a 決定報酬(單調 +2pp)、b 純雜訊、c 是 a 的影子(相關 0.95)、d 只在前半有效
    ND, NS = 400, 300
    cal, d0 = [], np.datetime64('2012-01-02')
    while len(cal) < ND * 5:                       # 真的工作日(每年約 250 天 → 每年約 50 個橫切面)
        if np.is_busday(d0):
            cal.append(str(d0))
        d0 += np.timedelta64(1, 'D')
    names = ['a', 'b', 'c', 'd', 'amt20', 'vol20', 'pos252', 'chg20', 'chg10']
    rows_d, rows_s, X, R = [], [], [], []
    for t in range(ND):
        a = rng.normal(size=NS)
        b = rng.normal(size=NS)
        c = a * 0.95 + rng.normal(size=NS) * 0.3
        d = rng.normal(size=NS)
        amt = rng.uniform(0.2, 50, NS)
        noise = rng.normal(0, 6, NS)
        r = 0.8 * a + (0.8 * d if t < ND // 2 else -0.8 * d) + noise
        for s in range(NS):
            rows_d.append(t * 5)
            rows_s.append(s)
            X.append([a[s], b[s], c[s], d[s], amt[s], rng.uniform(10, 80), rng.uniform(0, 100), rng.normal(), rng.normal()])
            R.append([r[s] / 2, r[s], r[s] * 1.5])
    P = {'date_i': np.array(rows_d), 'sym_i': np.array(rows_s), 'X': np.array(X, dtype=np.float32), 'R': np.array(R, dtype=np.float32), 'lock': np.zeros(len(R), bool)}
    meta = {'names': names, 'hs': [5, 10, 20], 'cal': cal, 'syms': [f'{1000 + s}' for s in range(NS)], 'ind': {f'{1000 + s}': f'{(s % 5) + 1:02d}' for s in range(NS)}, 'stride': 5}
    with tempfile.TemporaryDirectory() as td:
        DATA = Path(td)
        (DATA / '^TWII.json').write_text(json.dumps([{'date': d, 'close': 10000 + i} for i, d in enumerate(cal)]))
        nm2 = add_industry(meta, P)
        ok('⓪ 族群三欄加進來', nm2[-3:] == EXTRA and P['X'].shape[1] == len(names) + 3)
        L = layer1(meta, P, nm2, verbose=False)
        r = {x['f']: x for x in L['U1']['res']}
        ok('① 有效變因 a:BH 過、方向正、五等分單調、格內同向 → 過第一層', r['a']['pass1'] and r['a']['dir'] == 1 and r['a']['mono'] > 0.9, {k: r['a'].get(k) for k in ('spread', 't', 'q_bh', 'mono', 'cell', 'gates')})
        ok('② 雜訊變因 b:不過第一層(q > 0.05 或不單調)', not r['b']['pass1'], {k: r['b'].get(k) for k in ('spread', 't', 'q_bh', 'mono')})
        ok('③ 前半有效、後半反向的 d:前後半不同向 → 不過', not r['d']['pass1'] and not r['d']['gates']['half'], {k: r['d'].get(k) for k in ('h1', 'h2')})
        ok('④ 族群相對強弱 / 族群內名次:跟報酬無關 → 不過', not r['rel20']['pass1'] and not r['ind_pct20']['pass1'])
        pairs = corr_table(meta, P, nm2, every=10)
        ok('⑤ 相關表抓得到 a 與 c(影子變因)', any({p[0], p[1]} == {'a', 'c'} for p in pairs), pairs[:5])
        # ⑥ 決定性對照:把報酬打亂(跟 a 無關)→ a 也不可以過
        P2 = dict(P)
        P2['R'] = P['R'][rng.permutation(len(P['R']))]
        L2_ = layer1(meta, P2, nm2, verbose=False)
        r2 = {x['f']: x for x in L2_['U1']['res']}
        ok('⑥ 決定性對照:報酬打亂 → a 不過(⛔ 不是寫死會過)', not r2['a']['pass1'], {k: r2['a'].get(k) for k in ('spread', 't', 'q_bh')})
    # ⑦ 統計小工具對已知答案
    q = bh([0.01, 0.04, 0.03, 0.5])
    ok('⑦ BH:[0.01,0.04,0.03,0.5] → [0.04,0.0533,0.0533,0.5]', np.allclose(q, [0.04, 0.04 * 4 / 3, 0.04 * 4 / 3, 0.5], atol=1e-4), q)
    x = rng.normal(0.5, 1, 2000)
    mu, t = nw_t(x, 0)
    ok('⑦ Newey-West lag 0 = 一般 t(≈ 0.5 ÷ (1/√2000) ≈ 22)', abs(t - mu / (x.std() / math.sqrt(len(x)))) < 0.5, (mu, t))
    rp = rank_pct(np.array([3.0, 1.0, 2.0, 2.0, np.nan]))
    ok('⑦ 名次平手取平均、NaN 不排', np.allclose(rp[:4], [1.0, 0.0, 0.5, 0.5]) and np.isnan(rp[4]), rp)
    # ⑧ 第二層:合成池子(每天 120 檔,前 100 大才算池子)+ 每 10 天換倉買 chg10 前 5 名
    #   報酬 = 3×(chg10 名次) + 3×(a 名次) + 雜訊 → a 要過、b(雜訊)不過、c(chg10 的影子)控制 chg10 之後要 ≈ 0
    ND2, NP = 2100, 120                            # 約 8.4 年(長窗口至少要 8 年有資料)
    cal2, d0 = [], np.datetime64('2013-01-01')
    while len(cal2) < ND2:
        if np.is_busday(d0):
            cal2.append(str(d0))
        d0 += np.timedelta64(1, 'D')
    nm_p = ['a', 'b', 'c', 'chg10', 'amt20', 'chg20']
    rd, rs, rx, rr, picks = [], [], [], [], []
    for t in range(ND2):
        syms_t = rng.choice(400, NP, replace=False)
        ch = rng.normal(size=NP)
        a = rng.normal(size=NP)
        c = ch * 0.95 + rng.normal(size=NP) * 0.3
        amt = rng.uniform(1, 50, NP)
        top = np.argsort(-amt)[:POOL_N]
        rk_ch, rk_a = np.full(NP, np.nan), np.full(NP, np.nan)
        rk_ch[top], rk_a[top] = rank_pct(ch[top]), rank_pct(a[top])
        r10 = 3 * (np.nan_to_num(rk_ch, nan=0.5) - 0.5) + 3 * (np.nan_to_num(rk_a, nan=0.5) - 0.5) + rng.normal(0, 3, NP)
        for k in range(NP):
            rd.append(t)
            rs.append(int(syms_t[k]))
            rx.append([a[k], rng.normal(), c[k], ch[k], amt[k], rng.normal()])
            rr.append([r10[k] / 2, r10[k], r10[k] * 1.5])
        if t % 10 == 0:
            best = top[np.argsort(-ch[top])[:5]]
            for k in best:
                picks.append({'d': cal2[t], 's': f'{int(syms_t[k]):04d}', 'r': float(r10[k]), 'b': 0.0, 'lock': False})
    Pp = {'date_i': np.array(rd), 'sym_i': np.array(rs), 'X': np.array(rx, dtype=np.float32), 'R': np.array(rr, dtype=np.float32), 'lock': np.zeros(len(rr), bool)}
    o = np.lexsort((Pp['sym_i'], Pp['date_i']))
    for k in Pp:
        Pp[k] = Pp[k][o]
    mp = {'names': nm_p, 'hs': [5, 10, 20], 'cal': cal2, 'syms': [f'{s:04d}' for s in range(400)], 'ind': {f'{s:04d}': f'{(s % 5) + 1:02d}' for s in range(400)}, 'stride': 1}
    with tempfile.TemporaryDirectory() as td:
        DATA = Path(td)
        (DATA / '^TWII.json').write_text(json.dumps([{'date': d, 'close': 10000 + i} for i, d in enumerate(cal2)]))
        n2 = add_industry(mp, Pp)
    half = len(picks) // 2
    extra = [{'d': '1999-01-04', 's': '0001', 'r': 0, 'b': 0, 'lock': False}, {'d': cal2[0], 's': '0001', 'r': 9, 'b': 0, 'lock': True}]
    lead = {'w1': picks + extra, 'w2': picks[half:]}
    dirs = {'a': 1, 'b': 1, 'c': 1}
    L2, fm = layer2(mp, Pp, n2, lead, dirs)
    g = gate2(L2, fm, dirs)
    ra = L2['w1']['res'].get('a') or {}
    ok('⑧ 第二層:a(真的有增量)好的三分之一 − 差的三分之一 ≥ +1pp、逐年同向、池內 t ≥ 2 → 過', g.get('a', {}).get('pass2') and ra.get('diff', 0) >= 1, (ra.get('diff'), ra.get('yr_same'), fm.get('a')))
    ok('⑧ 第二層:b(雜訊)不過', not g.get('b', {}).get('pass2'), (L2['w1']['res'].get('b'), fm.get('b')))
    # ⚠️ 影子的係數抽樣上是 N(0, 1) 的 t(種子 1~10 實測 −1.6~+0.7,種子 3 剛好 −3.3)→ 斷言用「比真的增量小很多」+ |t| < 4,
    #    ⛔ 不用 |t| < 2(5% 的機率是巧合紅);拿掉 chg10 控制時影子 t ≈ 85、係數 ≈ a 的 0.9 倍 → 照樣抓得到
    ca, cc = fm.get('a', {}), fm.get('c', {})
    ok('⑧ 第二層:c(chg10 的影子)控制 chg10 之後係數 < a 的 1/4、|t| < 4(⛔ 不可把同一件事算成增量)', abs(cc.get('coef', 9)) < 0.25 * ca.get('coef', 0) and abs(cc.get('t', 9)) < 4, (cc, ca))
    ok('⑧ 對不上的有數出來:鎖漲停 1 ・日期不在面板 1', L2['w1']['miss']['lock'] == 1 and L2['w1']['miss']['date'] == 1 and L2['w1']['map_rate'] > 0.99, L2['w1'].get('miss'))
    # ⑧b 只有最後一年才有資料的變因(跟 a 一樣有效)→ 兩窗口其實同一批 → ⛔ 不判
    Pp2 = dict(Pp)
    Pp2['X'] = Pp['X'].copy()
    ja = n2.index('a')
    late = Pp2['date_i'] < int(ND2 * 0.85)
    Pp2['X'][late, ja] = np.nan
    L2b, fmb = layer2(mp, Pp2, n2, lead, dirs)
    gb = gate2(L2b, fmb, dirs)
    ok('⑧b 資料只有近一年的變因 → short、⛔ 不過(⛔ 不可拿同一批筆數當兩個窗口)', gb.get('a', {}).get('short') and not gb.get('a', {}).get('pass2'), gb.get('a'))
    # ⑨ 決定性對照:把 👑 那幾筆的報酬打亂 → a 不可以再過(⛔ 不是寫死會過)
    shuf = [dict(x, r=y) for x, y in zip(picks, rng.permutation([x['r'] for x in picks]))]
    L2s, _ = layer2(mp, Pp, n2, {'w1': shuf, 'w2': shuf[half:]}, dirs)
    gs = gate2(L2s, fm, dirs)
    ok('⑨ 決定性對照:報酬打亂 → a 的兩窗口那關不過', not gs.get('a', {}).get('wins'), (L2s['w1']['res'].get('a') or {}).get('diff'))
    # ⑨b 代號全對不上 → map_rate 0(main 會拿它擋,⛔ 不判)
    L2m, _ = layer2(mp, Pp, n2, {'w1': [dict(x, s='Z' + x['s']) for x in picks]}, dirs)
    ok('⑨b 代號全對不上 → map_rate = 0 且數得出來(⛔ 不可安靜地當成 0 筆)', L2m['w1'].get('map_rate', 1) == 0 and L2m['w1']['miss']['sym'] == len(picks), L2m['w1'].get('miss'))
    # ⑩ 大盤分層(V79.3.8):e 只在「狀態高」有效、「狀態低」反向 → 抓得到;b 雜訊抓不到;
    #    偷看當天的狀態(LEAK = 當天的 spread)用「嚴格早於」→ 抓不到;狀態打亂 → 抓不到
    rng2 = np.random.default_rng(7)
    calm, d0 = [], np.datetime64('2012-01-02')
    while len(calm) < 2600:
        if np.is_busday(d0):
            calm.append(str(d0))
        d0 += np.timedelta64(1, 'D')
    S = {d: float(np.sin(2 * np.pi * i / 260) + rng2.normal(0, 0.1)) for i, d in enumerate(calm)}
    dts = np.arange(5, len(calm), 5)
    prev = np.array([S[calm[i - 1]] for i in dts])
    sp_e = np.sign(prev) * 1.0 + rng2.normal(0, 1, len(dts))
    sp_b = rng2.normal(0, 1, len(dts))
    sp_g = rng2.normal(0, 1, len(dts))
    LEAK = {d: float(rng2.normal()) for d in calm}
    for k, i in enumerate(dts):
        LEAK[calm[i]] = float(sp_g[k])                       # 當天的值 = 當天的 spread(偷看)
    L1m = {'U1': {'_sp': np.stack([sp_e, sp_b, sp_g], axis=1), '_dates': dts}}
    mt = {'cal': calm}
    shuf = dict(zip(S.keys(), rng2.permutation(list(S.values()))))
    M = mkt_layer(mt, L1m, ['e', 'b', 'g'], {'S': S, 'LEAK': LEAK, 'SHUF': shuf}, 2, verbose=False)
    rm = {(r['f'], r['s']): r for r in M['res']}
    re_ = rm.get(('e', 'S'), {})
    ok('⑩ 大盤分層:e 只在狀態高時有效 → 抓得到(BH 過、前後半同向、b ≈ +2)', re_.get('passM') and 1.5 < re_.get('b', 0) < 2.5, re_)
    ok('⑩ 雜訊變因 b × 狀態 → 抓不到', not rm.get(('b', 'S'), {}).get('passM'), rm.get(('b', 'S')))
    ok('⑩ ⭐ 決定性對照:偷看當天(LEAK)→ 用「嚴格早於」抓不到(⛔ 不可偷看)', not rm.get(('g', 'LEAK'), {}).get('passM'), rm.get(('g', 'LEAK')))
    ok('⑩ 決定性對照:狀態打亂 → e 抓不到', not rm.get(('e', 'SHUF'), {}).get('passM'), rm.get(('e', 'SHUF')))
    stp = {d: (100.0 if d >= calm[1000] else float(i % 7)) for i, d in enumerate(calm)}
    stp[calm[999]] = -1.0                                   # 跳上去前一天放全期最低 → 那天該判「低」
    lab = mkt_split([calm[1000], calm[1001]], stp)
    ok('⑩ mkt_split 零前視:跳上去那天還是看前一天(低)、隔天才算高', lab[0] == -1 and lab[1] == 1, lab)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
