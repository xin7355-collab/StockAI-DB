#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏅 釣魚池「實測體質」分數 —— 它到底排不排得出順序?(V74.3.7,只讀 data/,不打網路)

❓ 為什麼要有這支:V74.3.6 把「符合的實測條件 pp 加總」當排序分數。每一條 pp 都是量過的,
   但「**加總之後**」能不能排序,是另一個沒驗過的主張(條件重疊會高估是我自己寫在卡上的)。
   ⛔ 「每個零件都測過」≠「組合起來有用」—— V73.0.0 停損 −3% 單獨有效、跟「2 檔」合起來就翻盤。

⭐ 借的是 twstock-research(使用者 2026-09-01 上傳)的**方法**,不是它的分數:
   它對自己的多因子分數做 forward-return **rank IC**(Spearman)+ Newey-West HAC 信賴區間,
   而且誠實寫「回測 2 年來多數股票 Alpha 為負」。本站探針一向報「pp vs 對照組 + 六關」,
   IC 是另一個角度:**分數高低跟未來報酬高低有沒有一致的順序**(六關問的是「某一格 vs 對照組」)。

📐 做法(跟 screener_edge_probe 完全同一條管線,⛔ 不另寫欄位):
   ・逐檔逐日 `screener_miner.build_one(rows[:i+1])`(只用當天為止的資料,零前視)
   ・分數規則**從 data/scr_edge.json 讀**,判斷式跟 pro.html `_fishScore` 一字不差
     (有成績的條件 ・ ±0.3pp 分類 ・ 加總),⛔ 不可在這裡「順手」改規則 —— 那就變成第二份真相。
   ・每一個交易日:對當天所有可交易(成交額 ≥1,000 萬)的股票,算 Spearman(分數, 未來 20 日超額報酬)。
   ・報:平均 IC、IC_IR(mean/std)、Newey-West HAC 95% CI(lag = 19,前瞻窗口重疊會讓 naive CI 太窄)、
     Q5−Q1 五分位價差、逐年 IC、以及 🆚 對照:**單一最強條件(創一年新高)** 與 **位階 pos252 單獨**
     —— ⛔ 贏 0 不夠,要贏「現況最簡單的一條」(ml_probe 的教訓:模型輸給一條 if)。
🚧 空過守門:日期數 < 200 或平均每日樣本 < 200 → exit 1。
用法:DATA_DIR=... STRIDE=3 python3 scripts/fish_score_ic_probe.py
"""
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import screener_miner as SM  # noqa: E402

DATA = Path(os.environ.get('DATA_DIR') or (ROOT / 'data'))
WARM, FWD, MIN_AMT = 250, 20, 0.1
STRIDE = int(os.environ.get('STRIDE', '3'))
CI = SM.CI

E = json.loads((ROOT / 'data/scr_edge.json').read_text(encoding='utf-8'))
CONDS = [c for c in E['conds'] if c['id'] in E['c']]
OPS = {'eq': lambda x, v: x == v, 'gt': lambda x, v: x > v, 'gte': lambda x, v: x >= v,
       'lt': lambda x, v: x < v, 'lte': lambda x, v: x <= v}


def fish_score(v):
    """⚠️ 跟 pro.html `_fishScore` 同一套規則(有成績 ・ ±0.3 分類 ・ 加總)。"""
    s = 0.0
    for c in CONDS:
        x = v[CI[c['k']]]
        if x is None:
            continue
        if not OPS[c['op']](x, c['v']):
            continue
        pp = E['c'][c['id']][4]
        if pp >= 0.3 or pp <= -0.3:
            s += pp
    return s


tw = json.loads((DATA / '^TWII.json').read_text(encoding='utf-8'))
tw = [r for r in (tw if isinstance(tw, list) else tw.get('data') or []) if float(r.get('close') or 0) > 0]
TWC = {str(r['date']).replace('/', '-'): float(r['close']) for r in tw}
TWD = sorted(TWC)
TWI = {d: i for i, d in enumerate(TWD)}
TWCH = {TWD[i]: (TWC[TWD[i]] / TWC[TWD[i - 1]] - 1) * 100 for i in range(1, len(TWD))}

files = sorted(f for f in os.listdir(DATA) if f[:-5].isdigit() and 4 <= len(f[:-5]) <= 6 and not f.startswith('00'))
print(f'📂 掃 {len(files)} 檔(已排除 ETF)・取樣間隔 {STRIDE}・條件 {len(CONDS)} 條')

# 每個交易日收集 (分數, 超額報酬, 創一年新高?, 位階)
BY = defaultdict(lambda: ([], [], [], []))
I_NH, I_POS = CI['nh'], CI['pos252']
nh_c = next(c for c in CONDS if c['id'] == 'nh252')
for si, f in enumerate(files):
    if si % 300 == 0:
        print(f'  … {si}/{len(files)}', flush=True)
    try:
        rows = json.loads((DATA / f).read_text(encoding='utf-8'))
    except Exception:
        continue
    rows = [r for r in rows if float(r.get('close') or 0) > 0]
    if len(rows) < WARM + FWD + 10:
        continue
    ds = [str(r['date']).replace('/', '-') for r in rows]
    cl = [float(r['close']) for r in rows]
    for i in range(WARM, len(rows) - FWD, STRIDE):
        d, dF = ds[i], ds[i + FWD]
        if d not in TWC or dF not in TWC:
            continue
        v = SM.build_one(rows[:i + 1], TWCH.get(d))
        if v is None or v[CI['amt']] is None or v[CI['amt']] < MIN_AMT:
            continue
        ex = (cl[i + FWD] / cl[i] - 1) * 100 - (TWC[dF] / TWC[d] - 1) * 100
        b = BY[d]
        b[0].append(fish_score(v)); b[1].append(ex)
        nh = v[I_NH]; b[2].append(1.0 if (nh is not None and OPS[nh_c['op']](nh, nh_c['v'])) else 0.0)
        p = v[I_POS]; b[3].append(float(p) if p is not None else float('nan'))


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = ~(np.isnan(a) | np.isnan(b))
    a, b = a[m], b[m]
    if len(a) < 30:
        return None
    ra = np.argsort(np.argsort(a)).astype(float); rb = np.argsort(np.argsort(b)).astype(float)
    # 同分用平均名次(pandas 的 'average'),否則大量同分會偏
    def avg_rank(x):
        order = np.argsort(x, kind='mergesort'); r = np.empty(len(x)); sx = x[order]
        i = 0
        while i < len(x):
            j = i
            while j + 1 < len(x) and sx[j + 1] == sx[i]:
                j += 1
            r[order[i:j + 1]] = (i + j) / 2 + 1; i = j + 1
        return r
    ra, rb = avg_rank(a), avg_rank(b)
    if ra.std() == 0 or rb.std() == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])


def newey_west_ci(x, lag):
    x = np.asarray(x, float); n = len(x); mu = x.mean(); e = x - mu
    v = (e @ e) / n
    for L in range(1, min(lag, n - 1) + 1):
        w = 1 - L / (lag + 1)
        v += 2 * w * (e[:-L] @ e[L:]) / n
    se = math.sqrt(max(v, 0) / n)
    return mu - 1.96 * se, mu + 1.96 * se


def quintile_spread(sc, ex):
    sc, ex = np.asarray(sc, float), np.asarray(ex, float)
    m = ~np.isnan(sc); sc, ex = sc[m], ex[m]
    if len(sc) < 50:
        return None
    q = np.quantile(sc, [0.2, 0.8])
    lo, hi = ex[sc <= q[0]], ex[sc >= q[1]]
    return float(hi.mean() - lo.mean()) if len(lo) > 5 and len(hi) > 5 else None


dates = sorted(BY)
if len(dates) < 200 or np.mean([len(BY[d][0]) for d in dates]) < 200:
    sys.exit(f'🚧 空過守門:日期 {len(dates)} 天、平均樣本 {np.mean([len(BY[d][0]) for d in dates]):.0f} 檔,不夠')

print(f'\n📅 {len(dates)} 個交易日({dates[0]} ~ {dates[-1]})・平均每天 {np.mean([len(BY[d][0]) for d in dates]):.0f} 檔')
print(f'📏 分數分布(全部股·日):中位 {np.median([s for d in dates for s in BY[d][0]]):+.2f} ・P90 {np.quantile([s for d in dates for s in BY[d][0]], .9):+.2f} ・零分佔比 {np.mean([s == 0 for d in dates for s in BY[d][0]])*100:.1f}%')


def report(name, pick):
    ics, qs, byY = [], [], defaultdict(list)
    for d in dates:
        b = BY[d]; ic = spearman(pick(b), b[1])
        if ic is None:
            continue
        ics.append(ic); byY[d[:4]].append(ic)
        q = quintile_spread(pick(b), b[1])
        if q is not None:
            qs.append(q)
    ics = np.asarray(ics)
    lo, hi = newey_west_ci(ics, FWD - 1)
    ir = ics.mean() / ics.std() if ics.std() > 0 else float('nan')
    pos = (ics > 0).mean() * 100
    print(f'\n── {name} ──')
    print(f'   平均 IC {ics.mean():+.4f}  (Newey-West 95% CI {lo:+.4f} ~ {hi:+.4f}, lag {FWD-1})  IC_IR {ir:+.2f}  IC>0 的天數 {pos:.0f}%  n={len(ics)} 天')
    print(f'   五分位價差 Q5−Q1(20 日超額,pp):{np.mean(qs):+.2f}' if qs else '   五分位價差:—')
    print('   逐年 IC:' + ' ・'.join(f'{y} {np.mean(v):+.3f}({len(v)}天)' for y, v in sorted(byY.items())))
    return ics.mean(), lo, hi


res = {}
res['fish'] = report('🏅 實測體質加總(pro.html 用的那條規則)', lambda b: b[0])
res['nh'] = report('🆚 單一最強條件:創一年新高(0/1)', lambda b: b[2])
res['pos'] = report('🆚 位階 pos252 單獨', lambda b: b[3])

m, lo, hi = res['fish']
verdict = ('✅ 分數**排得出順序**(CI 不含 0)' if lo > 0 else ('❌ 排不出順序(CI 含 0)' if hi > 0 else '🚨 方向反了'))
better = m > max(res['nh'][0], res['pos'][0])
print(f'\n🧾 判定:{verdict};' + (' 而且贏過單一條件與位階' if better else ' ⛔ 但**沒有贏過**最簡單的單一條件/位階 —— 那加總沒有帶來新資訊'))
print('⚠️ 限制:IC 講的是「順序」不是「賺多少」;窗口偏多頭;報酬未扣成本;條件重疊代表分數的區分度主要來自「強」這一族。')
