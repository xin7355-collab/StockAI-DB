#!/usr/bin/env python3
"""🔄📐 週轉率 × **位階** 探針 + 月線斜率飆股門檻 —— 權證小哥兩集逐字稿的未測部分

⭐ 為什麼要再測一次週轉率(V72.0.1 明明測過了):
   `turnover_probe.py` 測的是「週轉率 × **昨日漲跌幅**」(他在【當沖三大指標】講的),
   結論是單看週轉率幾乎沒有鑑別力。**但那不是他在【S2 第19集】講的那條規則。**
   S2 第19集講的是「週轉率 × **位階**」,而且方向是相反的兩件事:
     ・「股票在**低檔**主力買它就容易有波段行情,只要**週轉率超過 20%**」(華星光案例)
     ・「週轉率高**在高檔不是什麼好事情**」(紅寶案例,高檔 78%)
   → **同一個 20% 門檻,在低檔是買訊、在高檔是賣訊** —— 這個交互作用我沒測過。
   ⚠️ 這正是 CLAUDE.md 說的「同名不同義」:不分位階去測,兩個方向會互相抵銷成 0。

📐 順便測第二條(【兆華艾綸說 2026-07-08】):
   「**月線斜率大於 1** 就是飆股 —— 1 代表這個月線的均值**每天多 1%**」
   這是他「浪子回頭」選股的第一個條件,而且是**乾淨的純公式**(⛔ 不需要處置股資料,
   處置系統 V70.3.1 已下架,這裡只借用斜率這個定義)。

定義:
  週轉率 = 當日成交量(張)×1000 ÷ 總發行股數 ×100%   ← 總股數來自 tdcc_holders.json 的 t
  位階   = 收盤在近 250 日高低區間的百分位(0=最低、100=最高)
  月線斜率 = (今天的 20MA ÷ 20 天前的 20MA)^(1/20) − 1,換算成「每天幾 %」

方法論(照 CLAUDE.md 四點):
  ① 乾淨對照組 = 所有掃到的交易日(⛔ 不抽樣)
  ② 報酬扣同期加權指數  ③ 同檔同型態 10 交易日去重  ④ 每桶至少 200 筆

只讀 data/*.json,不打 API、不寫檔。跑法:python3 turnover_stage_probe.py
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20)
DEDUP = 10
MIN_BUCKET = 200

tw = {}
for r in json.loads((DATA / '^TWII.json').read_text()):
    try:
        c = float(r['close'])
        if c > 0:
            tw[r['date'].replace('/', '-')] = c
    except Exception:
        continue

tdcc = json.loads((DATA / 'tdcc_holders.json').read_text())
shares = {}
for k, v in tdcc.items():
    if isinstance(v, dict):
        try:
            t = float(v.get('t') or 0)
            if t > 1e6:
                shares[k] = t
        except (TypeError, ValueError):
            pass
print(f'總股數可用 {len(shares):,} 檔')

# 桶:(位階區間, 週轉率區間) → 報酬
TURN = [(0, 5, '週轉<5%'), (5, 10, '週轉5~10%'), (10, 20, '週轉10~20%'),
        (20, 40, '⭐週轉20~40%'), (40, 99999, '⭐週轉40%+')]
STAGE = [(0, 30, '低檔(位階<30)'), (30, 70, '中檔'), (70, 101, '高檔(位階≥70)')]
ev = {(s[2], t[2]): {h: [] for h in HORIZONS} for s in STAGE for t in TURN}
# 月線斜率桶
SLOPE = [(-99, -0.5, '月線斜率 <−0.5%/日'), (-0.5, 0, '−0.5~0'), (0, 0.5, '0~0.5'),
         (0.5, 1.0, '0.5~1.0'), (1.0, 99, '⭐ 斜率 ≥1%/日(他說的飆股)')]
ev_sl = {s[2]: {h: [] for h in HORIZONS} for s in SLOPE}
base = {h: [] for h in HORIZONS}
n_files = n_used = 0

for f in sorted(DATA.glob('[0-9][0-9][0-9][0-9].json')):
    n_files += 1
    sym = f.stem
    try:
        rows = json.loads(f.read_text())
    except Exception:
        continue
    if not isinstance(rows, list) or len(rows) < 300:
        continue
    ser = []
    for r in rows:
        try:
            c = float(r['close']); v = float(r.get('volume') or 0)
            d = r['date'].replace('/', '-')
            if c > 0:
                ser.append((d, c, v))
        except Exception:
            continue
    if len(ser) < 300:
        continue
    n_used += 1
    n = len(ser)
    closes = [x[1] for x in ser]
    ma20 = [None] * n
    run = sum(closes[:20])
    for i in range(19, n):
        if i > 19:
            run += closes[i] - closes[i - 20]
        ma20[i] = run / 20
    tot = shares.get(sym)
    last_ev = {}

    for i in range(250, n - max(HORIZONS)):
        d0, c0, v0 = ser[i]
        if d0 not in tw:
            continue
        rets = {}
        ok = True
        for hz in HORIZONS:
            d1 = ser[i + hz][0]
            if d1 not in tw:
                ok = False
                break
            rets[hz] = (ser[i + hz][1] / c0 - 1) * 100 - (tw[d1] / tw[d0] - 1) * 100
        if not ok:
            continue
        for hz in HORIZONS:
            base[hz].append(rets[hz])

        # ── 位階 × 週轉率 ──
        if tot and v0 > 0:
            win = closes[i - 249:i + 1]
            lo, hi = min(win), max(win)
            if hi > lo:
                stage = (c0 - lo) / (hi - lo) * 100
                turn = v0 * 1000 / tot * 100
                sn = next((x[2] for x in STAGE if x[0] <= stage < x[1]), None)
                tn = next((x[2] for x in TURN if x[0] <= turn < x[1]), None)
                if sn and tn:
                    key = (sn, tn)
                    if i - last_ev.get(key, -999) >= DEDUP:
                        last_ev[key] = i
                        for hz in HORIZONS:
                            ev[key][hz].append(rets[hz])

        # ── 月線斜率 ──
        if ma20[i] and ma20[i - 20] and ma20[i - 20] > 0:
            slope = ((ma20[i] / ma20[i - 20]) ** (1 / 20) - 1) * 100
            sn = next((x[2] for x in SLOPE if x[0] <= slope < x[1]), None)
            if sn:
                k2 = ('SL', sn)
                if i - last_ev.get(k2, -999) >= DEDUP:
                    last_ev[k2] = i
                    for hz in HORIZONS:
                        ev_sl[sn][hz].append(rets[hz])

med = statistics.median
print(f'掃 {n_files} 檔,可用 {n_used} 檔\n')
print('對照組(同批股票所有交易日,扣同期加權後):')
for hz in HORIZONS:
    b = base[hz]
    print(f'  {hz:>3} 日:中位 {med(b):+6.2f}% ・勝率 {sum(1 for x in b if x>0)/len(b)*100:4.1f}% ・n={len(b):,}')


def show(name, arr):
    line = f'  {name:<16}'
    shown = False
    for hz in HORIZONS:
        e = arr[hz]
        if len(e) < MIN_BUCKET:
            line += f'  {hz:>2}日:n={len(e)}不足'
            continue
        shown = True
        edge = med(e) - med(base[hz])
        w = sum(1 for x in e if x > 0) / len(e) * 100
        line += f'  {hz:>2}日 {med(e):+6.2f}%(邊際{edge:+5.2f}pp)勝率{w:4.1f}%'
    line += f'  n={len(arr[HORIZONS[0]]):,}'
    print(line)
    return shown


print(f'\n{"═"*100}\n① 週轉率 × 位階(⭐ 他說:低檔高週轉=起漲、高檔高週轉=出貨)\n{"═"*100}')
for _, _, sn in STAGE:
    print(f'\n■ {sn}')
    for _, _, tn in TURN:
        show(tn, ev[(sn, tn)])

print(f'\n{"═"*100}\n② 月線斜率(⭐ 他說:斜率 ≥1%/日 = 飆股)\n{"═"*100}')
for _, _, sn in SLOPE:
    show(sn, ev_sl[sn])

print('\n⚠️ 判讀限制:')
print('  ・邊際 ±0.5pp 內視為雜訊;未扣交易成本(來回約 0.44%)')
print('  ・總股數用**今天**的(tdcc 只有現值)→ 增資/減資過的個股歷史週轉率會失真')
print('  ・倖存者偏誤;窗口受 ^TWII 長度限制(約 2 年)')
