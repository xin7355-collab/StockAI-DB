#!/usr/bin/env python3
"""🏦 外資「真連續」買超 N 天 → 持有 10 日的勝率 / 報酬(+ 投信同步的增量)—— V77.3.1

使用者(2026-09-19):「回測過去,外資連續買超五天以上的個股,持有十天後的勝率跟報酬率。」
「加入投信同步買超的條件。」

⭐ 先查登記表(⛔ 不重探):
  ・`_SCR_EDGE.fdays7`(外資近 7 日淨買天數 ≥5)= **−0.24pp / 勝率 37.8%**(選股頁 127 條之一)
  ・板塊層級 `sector_flow` C 變體(外資 10 日買 ≥6 天)= **孤峰**(≥6 +1.48、≥7 −0.11、≥8 −8.61)
  ・`trustvol_probe` 投信單腿 = **六關 0 過**
  ・`maxim_probe` 檢①(前一日籌碼軌跡 ≥99.5%)= 六關全過但絕對超額仍 −0.48%(只能排序)
  → 這支的**新意只有兩件**:① 「真連續」N 天(⛔ 不是 7 天裡 5 天)的**高原檢定** N=3~7
     ② 「外資連買 ∧ 投信同步」對「外資連買 ∧ 投信沒買」的**增量**(共用外資腿,⛔ 不拿全市場當對照)

方法(照 `short_probe.py` 那套,⛔ 不另立標準):
  ・訊號日 t = 外資連續淨買**剛好到 N 天**的那天(⛔ 不是「≥N 的每一天」—— 那會把同一段連買算好幾次)
  ・法人買賣超**收盤後才公布** → **t+1 開盤**進場;t+1 開盤鎖漲停(買不到)剔除
  ・報酬 = 持有到 t+1+h 收盤,扣同期加權(超額);主判準 10 日;來回成本 0.44pp
  ・對照組 = 同一批股票**全部**可交易的股·日;同檔同 N 20 日去重;斷崖守門(相鄰收盤 ±40%)
  ・最後一根 `foreign_net === 0` = **還沒公布**(不是「外資沒動」)→ 那一天不算連買、也不當訊號日
  ・六關:全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 / 格內對照(位階 × 波動 × 成交金額)
  ・強度互控:N 天外資淨買總股數 ÷ N 天總成交股數 三分位 × N —— 檢驗「是連續在說話,還是量在說話」

⚠️ 限制(⛔ 一定要跟結論一起講):
  ・`foreign_net` 從 **2023-06-09** 才有;扣 250 根暖身 → 事件窗口約 2024 年中起,**不含 2022 空頭**
  ・`klines_deep` 有 2021 起的 K 線但**沒有法人欄**(已實查)→ 逐年那關補不到 2022
  ・單位是**股**(⛔ 不是張);賣方(連續賣超)這一輪沒測

════════════════════════════════════════════════════════════════
📊 2026-09-19 實測(V77.3.1):2,154 檔 ・對照組 1,084,690 ・事件 75,210 ・窗口 2024-05-30 ~ 2026-08-18(三年全多頭)
════════════════════════════════════════════════════════════════
  ① 外資剛好連買 3/4/5/6/7 天:10 日 +0.15 / +0.25 / +0.25 / +0.20 / +0.17pp,扣成本全負 → 六關 0 過(「全正但沒有山」)
     連買 5 天:勝率 38.4%(對照 37.0%)・絕對 10 日 +0.37% / 賺錢機率 44.6%(對照 +0.10% / 43.7%)
  ② ⭐ 外資連買 ∧ 投信 3 日內有買:N=5 +0.91pp / 勝率 43.1% / 絕對 +0.86% / 賺錢機率 48.2% → 六關全過(N=3/7 也全過)
     增量 A−B(對照 = 外資連買但投信沒買):N=3 +0.74 全過、N=5 +0.77 / N=7 +0.64 各 5/6(格內 < 成本)
  ③ 🚨 反向增量:投信剛好連買 5 天之上,外資同步 − 沒外資 = +0.68pp(5/6);投信單腿 ≥5 天 +0.79pp 六關全過
     → **主角是投信,外資是加成**;⛔ 不可寫成「外資連買會漲」
  ④ 強度互控(N=5)佔量比 買得少 +0.67 / 中 +0.18 / 買得多 −0.09pp(單調)→ 外資狂掃 = 已經擠了
  處置:⛔ 不做提醒、不進計分;LAB ok r:44 / trap r:30;走完一次空頭重跑再決定進不進 `_SCR_EDGE`。

跑法:
  python3 scripts/fstreak_probe.py             # 全市場
  python3 scripts/fstreak_probe.py --selftest  # 合成 3 檔驗 harness(訊號數 / 零前視 / 鎖漲停剔除 / 去重)
  DATA_DIR=... 指定資料夾;MAX_SYMS=200 試跑
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

DATA = Path(os.environ.get('DATA_DIR') or 'data')
SELFTEST = '--selftest' in sys.argv
WARM = int(os.environ.get('WARM') or 250)
MAX_SYMS = int(os.environ.get('MAX_SYMS') or 0)
DEDUP = 20
COST = 0.44
MIN_N = 200
NS = (3, 4, 5, 6, 7)          # 高原檢定
TRUST_WIN = 3                 # 投信「同步」= 訊號日往前 3 天內任一天淨買 >0


def nf(x, d=2):
    return '—' if x is None or not np.isfinite(x) else f'{x:.{d}f}'


def sg(x):
    return '' if x is None or not np.isfinite(x) else ('+' if x >= 0 else '')


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def load_index(data=None):
    m = {}
    for r in load((data or DATA) / '^TWII.json') or []:
        try:
            c = float(r.get('close') or 0)
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                m[d] = c
        except (TypeError, ValueError):
            pass
    return m


def streaks(fn):
    """外資連續淨買天數(⭐ None = 沒公布/沒資料 → 連續中斷,而且那天自己也不算)。"""
    out, s = [], 0
    for v in fn:
        s = s + 1 if (v is not None and v > 0) else 0
        out.append(s)
    return out


def clean_unpublished(fn, tn):
    """🚨 最後一根 foreign_net == 0 = **還沒公布**(V77.3.1 實查:2330 最後一根 0 / 0),⛔ 不是「外資沒動」→ 改成 None。
    ⚠️ 事件迴圈只跑到 n−21,所以這條對**回測結果**沒影響;它守的是「拿這份序列去算今天 streak」的呼叫端(⛔ 別把 0 算成連續中斷)。"""
    if fn and fn[-1] == 0:
        fn[-1] = None
        tn[-1] = None
    return fn, tn


def collect(data=None, files=None, verbose=True):
    data = data or DATA
    idx = load_index(data)
    if not idx:
        print('⚠️ 沒有 ^TWII.json')
        return None
    all_dates = sorted(idx)
    dnum = {d: i for i, d in enumerate(all_dates)}
    if files is None:
        files = sorted(f for f in data.glob('*.json') if f.stem.isdigit() and len(f.stem) == 4)
        if MAX_SYMS:
            step = max(1, len(files) // MAX_SYMS)
            files = files[::step][:MAX_SYMS]     # ⭐ 等距抽樣(⛔ 不取前 N 檔 = 按產業取樣,V72.1.7)
    if verbose:
        print(f'📂 掃描 {len(files)} 檔個股(4 碼純數字;⛔ 不含 ETF)・暖身 {WARM} 根 ・去重 {DEDUP} 日 ・進場 = 隔天開盤')
    C = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'r10')}
    E = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'st', 'tr', 'trst', 'ratio', 'si', 'r10')}
    # ⭐ 第二個事件庫:**投信**連買剛好到 N 天的那天(另一把去重)→ 給「反向增量」用:投信連買之上,外資有沒有加成?
    ET = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'st', 'fs', 'si', 'r10')}
    n_sym = n_cliff = n_lim = 0
    syms = []
    for f in files:
        rows = load(f) or []
        if len(rows) < WARM + 25:
            continue
        d, op, hi, lo, cl, vol, fn, tn = [], [], [], [], [], [], [], []
        for r in rows:
            if not r or r.get('close') is None:
                continue
            try:
                c = float(r['close'])
            except (TypeError, ValueError):
                continue
            d.append(str(r.get('date') or '').replace('/', '-'))
            cl.append(c)
            op.append(float(r.get('open') or c))
            hi.append(float(r.get('high') or c))
            lo.append(float(r.get('low') or c))
            vol.append(float(r.get('volume') or 0))
            fn.append(None if r.get('foreign_net') is None else float(r['foreign_net']))
            tn.append(None if r.get('trust_net') is None else float(r['trust_net']))
        n = len(cl)
        if n < WARM + 25 or min(cl) <= 0:
            continue
        fn, tn = clean_unpublished(fn, tn)
        if any((cl[i] / cl[i - 1] > 1.4 or cl[i] / cl[i - 1] < 0.6) for i in range(1, n)):
            n_cliff += 1
            continue
        if sum(1 for v in fn if v is not None) < 120:
            continue
        n_sym += 1
        syms.append(f.stem)
        si = len(syms) - 1
        cl_a = np.asarray(cl)
        st = streaks(fn)
        stT = streaks(tn)
        last = {}
        for i in range(WARM, n - 21):
            c0, o1 = cl[i], op[i + 1]
            if not (c0 > 0 and o1 > 0):
                continue
            if o1 >= c0 * 1.0995 and hi[i + 1] == lo[i + 1]:
                n_lim += 1
                continue
            b0, b5, b10, b20 = idx.get(d[i + 1]), idx.get(d[i + 5]), idx.get(d[i + 10]), idx.get(d[i + 20])
            dn_i = dnum.get(d[i])
            if not b0 or not b10 or dn_i is None:
                continue
            r10 = (cl[i + 10] / o1 - 1) * 100
            e10 = r10 - (b10 / b0 - 1) * 100
            if not np.isfinite(e10):
                continue
            e5 = (cl[i + 5] / o1 - 1) * 100 - (b5 / b0 - 1) * 100 if b5 else np.nan
            e20 = (cl[i + 20] / o1 - 1) * 100 - (b20 / b0 - 1) * 100 if b20 else np.nan
            w = cl_a[i - 249:i + 1] if i >= 249 else cl_a[:i + 1]
            mn, mx = float(w.min()), float(w.max())
            pos = (c0 - mn) / (mx - mn) * 100 if mx > mn else 50.0
            lr = np.diff(np.log(cl_a[i - 20:i + 1]))
            vola = float(lr.std()) * math.sqrt(240) * 100
            amt = c0 * vol[i]
            yr = int(d[i][:4])
            C['e5'].append(e5); C['e10'].append(e10); C['e20'].append(e20)
            C['y'].append(yr); C['dn'].append(dn_i); C['pos'].append(pos); C['vola'].append(vola); C['amt'].append(amt); C['r10'].append(r10)
            sT = stT[i]
            if NS[0] <= sT <= NS[-1]:
                pvT = last.get(('t', sT))
                if pvT is None or dn_i - pvT >= DEDUP:
                    last[('t', sT)] = dn_i
                    fw = [fn[j] for j in range(max(0, i - TRUST_WIN + 1), i + 1)]
                    fs_ = -1 if all(v is None for v in fw) else (1 if any(v is not None and v > 0 for v in fw) else 0)
                    ET['e5'].append(e5); ET['e10'].append(e10); ET['e20'].append(e20)
                    ET['y'].append(yr); ET['dn'].append(dn_i); ET['pos'].append(pos); ET['vola'].append(vola); ET['amt'].append(amt)
                    ET['st'].append(sT); ET['fs'].append(fs_); ET['si'].append(si); ET['r10'].append(r10)
            s = st[i]
            if s < NS[0] or s > NS[-1]:
                continue                       # 只記「剛好到 N」那天(s 在 3..7 的每一天各是一個 N 的訊號日)
            pv = last.get(s)
            if pv is not None and dn_i - pv < DEDUP:
                continue
            last[s] = dn_i
            # 投信同步:訊號日往前 TRUST_WIN 天內任一天投信淨買 >0 → 1;全部 ≤0(且有資料)→ 0;沒資料 → -1
            tw = [tn[j] for j in range(max(0, i - TRUST_WIN + 1), i + 1)]
            tr = -1 if all(v is None for v in tw) else (1 if any(v is not None and v > 0 for v in tw) else 0)
            vsum = sum(vol[j] for j in range(i - s + 1, i + 1))
            ratio = (sum(fn[j] for j in range(i - s + 1, i + 1)) / vsum * 100) if vsum > 0 else np.nan
            E['e5'].append(e5); E['e10'].append(e10); E['e20'].append(e20)
            E['y'].append(yr); E['dn'].append(dn_i); E['pos'].append(pos); E['vola'].append(vola); E['amt'].append(amt)
            E['st'].append(s); E['tr'].append(tr); E['trst'].append(stT[i]); E['ratio'].append(ratio); E['si'].append(si); E['r10'].append(r10)
    if verbose and n_cliff:
        print(f'   ⚠️ {n_cliff} 檔因為「相鄰收盤跳超過 ±40%」被整檔剔除(未還原分割/壞 K 棒)')
    if verbose:
        print(f'   ⚠️ 隔天開盤鎖漲停(買不到)剔除 {n_lim:,} 個股·日')
    ctrl = {k: np.asarray(v, dtype=float) for k, v in C.items()}
    ev = {k: np.asarray(v, dtype=float) for k, v in E.items()}
    ev['_trust'] = {k: np.asarray(v, dtype=float) for k, v in ET.items()}   # 掛在 ev 底下,呼叫端簽名不變
    return ctrl, ev, all_dates, n_sym, syms


def analyse(ctrl, ev, all_dates, n_sym, syms, data=None):
    N = len(ctrl['e10'])
    if N < 5000:
        print(f'❌ 對照組只有 {N} 筆 —— 資料不足,不下結論')
        return []
    print(f'📊 {n_sym} 檔 ・對照組 {N:,} 個(股·日)・事件 {len(ev["e10"]):,} 筆(N=3~7 各自去重)\n')
    volaP60 = float(np.percentile(ctrl['vola'], 60))
    hq_c = (ctrl['pos'] >= 75) & (ctrl['vola'] >= volaP60)
    hq_e = (ev['pos'] >= 75) & (ev['vola'] >= volaP60)
    c10, c5, c20 = float(np.mean(ctrl['e10'])), float(np.nanmean(ctrl['e5'])), float(np.nanmean(ctrl['e20']))
    cw = float((ctrl['e10'] > 0).mean() * 100)
    cRaw, cRawW = float(np.mean(ctrl['r10'])), float((ctrl['r10'] > 0).mean() * 100)
    print(f'🆚 對照組(同一批股票,全部可交易的股·日):5日 {nf(c5)}% ・10日 {nf(c10)}% ・20日 {nf(c20)}% ・勝率 {nf(cw, 1)}%')
    print(f'   🧬 波動 P60 = {nf(volaP60, 1)}%(⛔ 基準不是 0% 也不是 50%)\n')
    dn = np.sort(ctrl['dn'])
    MID, LO, HI = float(dn[len(dn) // 2]), float(dn[0]), float(dn[-1]) + 1
    print(f'🗓️ 事件窗口 {all_dates[int(LO)]} ~ {all_dates[int(HI) - 1]} ・中點 {all_dates[int(MID)]}')
    years = sorted(set(int(x) for x in ctrl['y']))
    idx_map = load_index(data)
    ylab, bear = [], []
    for y in years:
        ds = [all_dates[i] for i in range(int(LO), int(HI)) if all_dates[i][:4] == str(y)]
        if len(ds) < 20:
            ylab.append(f'{y}:樣本太短'); continue
        r = (idx_map[ds[-1]] / idx_map[ds[0]] - 1) * 100
        ylab.append(f'{y}:{"+" if r >= 0 else ""}{r:.1f}% {"▲多頭" if r > 0 else "▼空頭"}')
        if r <= 0:
            bear.append(y)
    print('   逐年驗得到的年度(加權在窗口內那段):' + ' ・'.join(ylab))
    print(f'   → {"⚠️ 窗口裡**沒有任何一個空頭年**(2022 不在 data/ 裡),逐年那一關的說服力有限" if not bear else f"✅ 窗口含空頭年 {bear}"}\n')

    def cuts(a):
        return float(np.percentile(a, 100 / 3)), float(np.percentile(a, 200 / 3))
    cP, cV, cA = cuts(ctrl['pos']), cuts(ctrl['vola']), cuts(ctrl['amt'])

    def cell(m):
        return ((m['pos'] > cP[1]).astype(int) + (m['pos'] > cP[0]).astype(int)) * 9 \
            + ((m['vola'] > cV[1]).astype(int) + (m['vola'] > cV[0]).astype(int)) * 3 \
            + ((m['amt'] > cA[1]).astype(int) + (m['amt'] > cA[0]).astype(int))
    cell_c = cell(ctrl)
    e10c = ctrl['e10']
    evT = ev['_trust']

    def stats(mask, base_e10=None, base_mask=None, ev=ev):
        """六關數字;base_* 給「增量檢定」用(對照 = 另一群事件,⛔ 不是全市場)。`ev` 可換成投信那個事件庫。"""
        g = int(mask.sum())
        if g < MIN_N:
            return None
        cell_e = cell(ev)
        if base_mask is None:
            bE, bM = e10c, np.ones(N, bool)
            bdn, by = ctrl['dn'], ctrl['y']
        else:
            bE, bM = ev['e10'], base_mask
            bdn, by = ev['dn'], ev['y']
        b10 = float(np.mean(bE[bM]))
        d10 = float(np.mean(ev['e10'][mask])) - b10
        d5 = float(np.nanmean(ev['e5'][mask])) - (c5 if base_mask is None else float(np.nanmean(ev['e5'][bM])))
        d20 = float(np.nanmean(ev['e20'][mask])) - (c20 if base_mask is None else float(np.nanmean(ev['e20'][bM])))
        w = float((ev['e10'][mask] > 0).mean() * 100)
        raw = float(np.mean(ev['r10'][mask])); rawW = float((ev['r10'][mask] > 0).mean() * 100)   # 絕對報酬(⛔ 使用者問的是這個,不只給超額)

        def half(a, b):
            em = mask & (ev['dn'] >= a) & (ev['dn'] < b)
            cm = bM & (bdn >= a) & (bdn < b)
            if em.sum() < 60 or cm.sum() < 100:
                return np.nan
            return float(np.mean(ev['e10'][em])) - float(np.mean(bE[cm]))
        q1, q2 = half(LO, MID), half(MID, HI)
        yr = {}
        for y in years:
            em = mask & (ev['y'] == y)
            cm = bM & (by == y)
            yr[y] = (float(np.mean(ev['e10'][em])) - float(np.mean(bE[cm]))) if em.sum() > 40 and cm.sum() > 100 else np.nan
        fin = {y: v for y, v in yr.items() if np.isfinite(v)}
        bestY = max(fin, key=fin.get) if fin else None
        if bestY is not None:
            em, cm = mask & (ev['y'] != bestY), bM & (by != bestY)
            exBest = (float(np.mean(ev['e10'][em])) - float(np.mean(bE[cm]))) if em.sum() > 40 else np.nan
        else:
            exBest = np.nan
        ws = wn = cells = 0.0
        for k in np.unique(cell_e[mask]):
            a = mask & (cell_e == k)
            c = (cell_c == k) if base_mask is None else (bM & (cell_e == k))
            if a.sum() < 20 or c.sum() < (200 if base_mask is None else 50):
                continue
            ws += (float(np.mean(ev['e10'][a])) - float(np.mean(bE[c]))) * a.sum()
            wn += a.sum(); cells += 1
        dCell = ws / wn if wn else np.nan
        hqE = (ev['pos'] >= 75) & (ev['vola'] >= volaP60)
        a = mask & hqE
        c = hq_c if base_mask is None else (bM & hqE)
        dHQ = (float(np.mean(ev['e10'][a])) - float(np.mean(bE[c]))) if a.sum() >= 100 and c.sum() >= 100 else np.nan
        yv = list(fin.values())
        passed = bool(d10 > 0 and np.isfinite(q1) and np.isfinite(q2) and (q1 > 0) == (q2 > 0)
                      and yv and all(v > 0 for v in yv) and np.isfinite(exBest) and exBest > 0
                      and d10 - COST > 0 and np.isfinite(dCell) and dCell > COST)
        gates = sum([d10 > 0, bool(np.isfinite(q1) and np.isfinite(q2) and (q1 > 0) == (q2 > 0)), bool(yv and all(v > 0 for v in yv)),
                     bool(np.isfinite(exBest) and exBest > 0), d10 - COST > 0, bool(np.isfinite(dCell) and dCell > COST)])
        return dict(n=g, d5=d5, d10=d10, d20=d20, w=w, raw=raw, rawW=rawW, q1=q1, q2=q2, yr=yr, bestY=bestY, exBest=exBest, dCell=dCell, cells=cells, wn=wn, dHQ=dHQ, nHQ=int(a.sum()), passed=passed, gates=gates)

    def show(name, r, base_note='對照全市場'):
        if r is None:
            print(f'─ {name}:⏳ 樣本不足(需 ≥{MIN_N})\n'); return
        print(f'─ {name}  n={r["n"]:,}({base_note})')
        print(f'   5日 {sg(r["d5"])}{nf(r["d5"])}pp ・10日 {sg(r["d10"])}{nf(r["d10"])}pp ・20日 {sg(r["d20"])}{nf(r["d20"])}pp ・勝率 {nf(r["w"], 1)}%(對照 {nf(cw, 1)}%)'
              f' ・💰 絕對:10 日 {sg(r["raw"])}{nf(r["raw"])}% ・賺錢機率 {nf(r["rawW"], 1)}%(對照 {nf(cRaw)}% / {nf(cRawW, 1)}%)')
        print(f'   前半 {sg(r["q1"])}{nf(r["q1"])} / 後半 {sg(r["q2"])}{nf(r["q2"])}'
              + ('' if (np.isfinite(r['q1']) and np.isfinite(r['q2']) and (r['q1'] > 0) == (r['q2'] > 0)) else ' 🚨不同向')
              + ' ・逐年 ' + ' '.join(f'{y % 100}:{sg(v)}{nf(v, 1)}' for y, v in r['yr'].items()))
        print(f'   去最好年({r["bestY"]}) {sg(r["exBest"])}{nf(r["exBest"])} ・扣成本 {sg(r["d10"] - COST)}{nf(r["d10"] - COST)}'
              f' ・格內({int(r["cells"])}格/{int(r["wn"])}筆) {sg(r["dCell"])}{nf(r["dCell"])} ・疊在🧬之上 {sg(r["dHQ"])}{nf(r["dHQ"])}(n={r["nHQ"]})')
        verdict = '✅ 六關全過' if r['passed'] else f'❌ 沒過({r["gates"]}/6)'
        print(f'   {verdict}\n')

    out = []
    print('📌 ① 外資「真連續」淨買剛好到 N 天(⭐ 高原檢定 N=3~7;⛔ 不是「7 天裡 5 天」)')
    tbl = []
    for n_ in NS:
        m = ev['st'] == n_
        r = stats(m)
        show(f'連買 {n_} 天', r)
        tbl.append((n_, r))
        out.append({'name': f'fstreak{n_}', 'r': r})
    print('   ⛰️ 高原檢定(10 日增量 pp):' + ' / '.join(f'N={n_} {sg(r["d10"]) + nf(r["d10"]) if r else "—"}' for n_, r in tbl))
    vals = [r['d10'] for _, r in tbl if r]
    if len(vals) >= 3:
        mono = all(vals[i] <= vals[i + 1] for i in range(len(vals) - 1)) or all(vals[i] >= vals[i + 1] for i in range(len(vals) - 1))
        allpos = all(v > 0 for v in vals)
        print(f'   → {"✅ 一片高原(全正且單調)" if (mono and allpos) else ("⚠️ 全正但不單調" if allpos else "❌ 不是高原(有負的格)")}\n')

    print('📌 ② 投信同步(⭐ 增量檢定:對照 = 「外資連買 N 天但投信 3 日內都沒買」,共用外資腿,⛔ 不拿全市場當對照)')
    for n_ in (5, 3, 7):
        A = (ev['st'] == n_) & (ev['tr'] == 1)
        B = (ev['st'] == n_) & (ev['tr'] == 0)
        show(f'N={n_} 外資連買 ∧ 投信同步(A)', stats(A))
        show(f'N={n_} 外資連買 ∧ 投信沒買(B)', stats(B))
        inc = stats(A, base_mask=B)
        show(f'N={n_} ⭐ 增量 A − B', inc, base_note='對照 = B 那群事件')
        out.append({'name': f'trust_inc{n_}', 'r': inc, 'A': stats(A), 'B': stats(B)})
    print('📌 ②b 投信單腿(投信自己連買 N 天,不管外資)—— 只當對照,`trustvol_probe` 早就六關 0 過')
    for n_ in (3, 5):
        show(f'投信連買 ≥{n_} 天', stats(ev['trst'] >= n_))

    print('📌 ②c ⭐ 反向增量:**投信**連買剛好 N 天之上,外資 3 日內有沒有買 —— 分得出「誰在說話」(A′ − B′;對照 = B′ 那群)')
    for n_ in (3, 5):
        A2 = (evT['st'] == n_) & (evT['fs'] == 1)
        B2 = (evT['st'] == n_) & (evT['fs'] == 0)
        show(f'投信剛好連買 {n_} 天 ∧ 外資同步(A′)', stats(A2, ev=evT))
        show(f'投信剛好連買 {n_} 天 ∧ 外資沒買(B′)', stats(B2, ev=evT))
        inc2 = stats(A2, base_mask=B2, ev=evT)
        show(f'N={n_} ⭐ 反向增量 A′ − B′', inc2, base_note='對照 = B′ 那群事件')
        out.append({'name': f'foreign_on_trust{n_}', 'r': inc2})

    print('📌 ③ 強度互控:N 天外資淨買 ÷ N 天成交量(三分位 × N)—— 是「連續」在說話,還是「量」在說話?')
    for n_ in (3, 5, 7):
        m = (ev['st'] == n_) & np.isfinite(ev['ratio'])
        if m.sum() < MIN_N * 3:
            print(f'   N={n_}:樣本不足\n'); continue
        q1_, q2_ = np.percentile(ev['ratio'][m], [100 / 3, 200 / 3])
        for lab, mm in (('買得少', m & (ev['ratio'] < q1_)), ('中', m & (ev['ratio'] >= q1_) & (ev['ratio'] < q2_)), ('買得多', m & (ev['ratio'] >= q2_))):
            r = stats(mm)
            print(f'   N={n_} {lab}(占量比 {"<" + nf(q1_, 1) if lab == "買得少" else ("≥" + nf(q2_, 1) if lab == "買得多" else nf(q1_, 1) + "~" + nf(q2_, 1))}%):'
                  f' n={int(mm.sum()):,} ・10日 {sg(r["d10"]) + nf(r["d10"]) if r else "—"}pp ・勝率 {nf(r["w"], 1) if r else "—"}%')
        print()

    print('📎 既有對照(登記表;⛔ 這支不重測):`_SCR_EDGE.fdays7`(7 天裡 ≥5 天)−0.24pp / 37.8% ・板塊 C 變體(10 日 ≥6 天)孤峰 ・投信單腿六關 0 過')
    print('⚠️ 限制:窗口不含 2022 空頭(法人欄 2023-06 起)・單位股 ・賣方未測 ・最後一根 0 = 未公布已剔除')
    return out


# ── 🧪 selftest ──────────────────────────────────────────────────
def make_selftest(tmp):
    """合成 3 檔 + 加權:S1 外資連買 5 天一次(第 300~304 天)・S2 連買 7 天(涵蓋 3~7 各一次訊號日)且投信同步
       ・S3 連買 5 天但**隔天開盤鎖漲停**(要被剔除)。⭐ 決定性對照:把 S1 訊號日**之後**的外資改成大買,訊號數不可變(零前視)。"""
    import random
    random.seed(7)
    n = 400
    dates = [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(n)]      # 假日期(只要能排序、能對上加權)
    dates = [f'2024-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}' if i < 336 else f'2025-{((i - 336) // 28) + 1:02d}-{((i - 336) % 28) + 1:02d}' for i in range(n)]
    twii = [{'date': d, 'close': 20000 + i * 5} for i, d in enumerate(dates)]
    (tmp / '^TWII.json').write_text(json.dumps(twii))

    def mk(sym, fn_of, tn_of, limit_day=None):
        rows, c = [], 100.0
        for i, d in enumerate(dates):
            c = c * (1 + random.uniform(-0.01, 0.01))
            o = c * (1 + random.uniform(-0.005, 0.005))
            h, l = max(o, c) * 1.005, min(o, c) * 0.995
            if limit_day is not None and i == limit_day:
                o = h = l = c = rows[-1]['close'] * 1.1            # 一字漲停(open=high=low)
            rows.append({'date': d, 'open': round(o, 2), 'high': round(h, 2), 'low': round(l, 2), 'close': round(c, 2), 'volume': 1000000,
                         'foreign_net': fn_of(i), 'trust_net': tn_of(i)})
        (tmp / f'{sym}.json').write_text(json.dumps(rows))
    mk('1001', lambda i: 5000 if 300 <= i <= 304 else -1000, lambda i: -100)                  # 連買 5 天 → st=3@302,4@303,5@304
    mk('1002', lambda i: 5000 if 320 <= i <= 326 else -1000, lambda i: 300 if 318 <= i <= 326 else -100)   # 連買 7 天 + 投信同步
    mk('1003', lambda i: 5000 if 340 <= i <= 344 else -1000, lambda i: -100, limit_day=345)  # 連買 5 天但 t+1 一字漲停
    return dates


def selftest():
    import tempfile
    global WARM
    WARM = 250
    fails = []

    def ok(name, cond, extra=''):
        print(f'{"✅" if cond else "❌"} {name}{"" if cond else "  " + str(extra)}')
        if not cond:
            fails.append(name)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        dates = make_selftest(tmp)
        res = collect(tmp, verbose=False)
        ctrl, ev, all_dates, n_sym, syms = res
        ok('⓪ 空過守門:3 檔都收到、對照組有東西', n_sym == 3 and len(ctrl['e10']) > 300, f'{n_sym} / {len(ctrl["e10"])}')
        by = {}
        for s, st, si, tr in zip(ev['st'], ev['st'], ev['si'], ev['tr']):
            by.setdefault(syms[int(si)], []).append((int(st), int(tr)))
        ok('① S1 連買 5 天 → 剛好 N=3/4/5 各一個訊號日(⛔ 不是「≥N 的每一天」)', sorted(x[0] for x in by.get('1001', [])) == [3, 4, 5], str(by.get('1001')))
        ok('② S2 連買 7 天 → N=3~7 各一個,而且投信同步旗標 = 1', sorted(x[0] for x in by.get('1002', [])) == [3, 4, 5, 6, 7] and all(x[1] == 1 for x in by.get('1002', [])), str(by.get('1002')))
        ok('③ S1 的投信旗標 = 0(3 日內投信全 ≤0 且有資料;⛔ 不是 −1)', all(x[1] == 0 for x in by.get('1001', [])), str(by.get('1001')))
        ok('④ S3 t+1 一字漲停 → N=5 那個訊號日被剔除(買不到)', 5 not in [x[0] for x in by.get('1003', [])], str(by.get('1003')))
        # ⑤ 零前視:把 S1 訊號日之後的外資全改成大買 → S1 的訊號日集合不可變(dn 相同)
        rows = json.loads((tmp / '1001.json').read_text())
        for r in rows[305:]:
            r['foreign_net'] = 99999
        (tmp / '1001.json').write_text(json.dumps(rows))
        ev2 = collect(tmp, verbose=False)[1]
        dn1 = sorted(float(x) for x, si in zip(ev['dn'], ev['si']) if syms[int(si)] == '1001' and True)
        dn2 = sorted(float(x) for x, si in zip(ev2['dn'], ev2['si']) if int(si) == 0)
        ok('⑤ 零前視:改訊號日**之後**的外資,前面的訊號日一個都不可變(但之後會多出新的連買)', dn2[:3] == dn1[:3] and len(dn2) > len(dn1), f'{dn1[:3]} vs {dn2[:3]}')
        # ⑥ 去重:讓 S1 在第 302 天之後每天都連買到 3 就斷、再連 3 天 → 20 日內只算一次
        rows = json.loads((tmp / '1001.json').read_text())
        for i, r in enumerate(rows):
            r['foreign_net'] = 5000 if (300 <= i < 330 and (i - 300) % 4 != 3) else -1000     # 3 買 1 賣 循環 → st=3 每 4 天一次
        (tmp / '1001.json').write_text(json.dumps(rows))
        ev3 = collect(tmp, verbose=False)[1]
        n3 = sum(1 for st, si in zip(ev3['st'], ev3['si']) if int(si) == 0 and int(st) == 3)
        ok('⑥ 去重:30 天內 st=3 出現 7~8 次,20 日去重後只留 2 次', n3 == 2, str(n3))
        # ⑦ 最後一根 foreign_net=0 = 還沒公布 → 改 None(⚠️ 直接測那支函式 —— 事件窗口碰不到最後一根,走 collect 測不出來)
        f7, t7 = clean_unpublished([5000, 5000, 0], [1, 1, 0])
        ok('⑦ 最後一根 0 → None(還沒公布),前面的不動;最後一根非 0 就不動', f7 == [5000, 5000, None] and t7 == [1, 1, None] and clean_unpublished([1, -5], [0, 0])[0] == [1, -5], f'{f7} {t7}')
        st_a = streaks([5000, 5000, 0])
        st_b = streaks([5000, 5000, None])
        ok('⑦b `streaks`:0 或 None 都讓連續中斷(0 = 沒買;最後一根的 0 由 collect 改成 None)', st_a == [1, 2, 0] and st_b == [1, 2, 0], f'{st_a} {st_b}')
    print(f'\n{"✅ selftest 全過" if not fails else "❌ " + str(len(fails)) + " 條失敗:" + " / ".join(fails)}')
    return 0 if not fails else 1


def main():
    if SELFTEST:
        sys.exit(selftest())
    res = collect()
    if not res:
        sys.exit(1)
    analyse(*res)


if __name__ == '__main__':
    main()
