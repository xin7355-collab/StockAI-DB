#!/usr/bin/env python3
"""🪤 「套牢比例」探針 —— 使用者問「散戶在高檔捨不得砍單,是不是就該區間操作」

⭐ 為什麼測這個而不是測「散戶佔比」:
   集保股權分散表(`tdcc_holders.json`)只有 **13 週**(2026/05/08~07/31),
   跟 V71.9.0 那次一樣**樣本不足以回測** → 散戶佔比只能當事實顯示,不能下預測。
   但使用者真正在意的其實不是「散戶多不多」,而是「**有多少人套牢、會不會反彈就跑**」
   —— 那個用 **K 線 + 成交量**就算得出來,零採礦、而且完全可回算。

定義(純公式):
  套牢比例 = 近 120 個交易日裡,「代表成交價 > 今天收盤」的那些日子的成交量 ÷ 總成交量
  ・代表成交價用 (高+低+收)/3(典型價),⛔ 不用收盤(高低振幅大的日子會失真)
  ・= 「這 120 天內買進的人裡,現在還在賠錢的比例」的近似值

檢驗:套牢比例分 5 桶,看後續 10/20/60 日超額報酬(扣同期加權)。
  ・對照組 = 所有掃到的交易日(⛔ 不抽樣 —— playbook_backtest 第一版踩過抽樣偏誤)
  ・同檔 20 日去重

⭐ 順便測使用者的推論:「套牢多 → 適合區間操作嗎?」
   → 額外輸出「套牢比例高時,後續 60 日的**波動區間**」看它是不是真的在箱型裡。

只讀 data/*.json,不打 API、不寫檔。跑法:python3 trapped_probe.py
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (10, 20, 60)
DEDUP = 20
LOOKBACK = 120

tw = {r['date'].replace('/', '-'): float(r['close'])
      for r in json.loads((DATA / '^TWII.json').read_text())}

BUCKETS = [(0, 20, '套牢 0~20%(幾乎人人賺錢)'),
           (20, 40, '套牢 20~40%'),
           (40, 60, '套牢 40~60%'),
           (60, 80, '套牢 60~80%'),
           (80, 101, '套牢 80%+(幾乎人人套牢)')]
events = {b[2]: {h: [] for h in HORIZONS} for b in BUCKETS}
rng60 = {b[2]: [] for b in BUCKETS}          # 後續 60 日的波動區間(測「是不是箱型」)
base = {h: [] for h in HORIZONS}
n_files = n_used = 0

for f in sorted(DATA.glob('[0-9][0-9][0-9][0-9].json')):
    n_files += 1
    try:
        rows = json.loads(f.read_text())
    except Exception:
        continue
    if not isinstance(rows, list) or len(rows) < 260:
        continue
    ser = []
    for r in rows:
        try:
            c = float(r['close']); h = float(r['high']); l = float(r['low'])
            v = float(r.get('volume') or 0)
            d = r['date'].replace('/', '-')
            if c > 0 and v > 0:
                ser.append((d, (h + l + c) / 3, c, v))
        except Exception:
            continue
    if len(ser) < 260:
        continue
    n_used += 1
    n = len(ser)
    last_evt = {b[2]: -999 for b in BUCKETS}

    for i in range(LOOKBACK + 20, n - max(HORIZONS)):
        d0, _, c0, _ = ser[i]
        if d0 not in tw:
            continue
        win = ser[i - LOOKBACK:i + 1]
        tot = sum(x[3] for x in win)
        if tot <= 0:
            continue
        above = sum(x[3] for x in win if x[1] > c0)
        ratio = above / tot * 100
        # 對照組:所有掃到的日子(⛔ 不抽樣)
        for hz in HORIZONS:
            d1 = ser[i + hz][0]
            if d1 in tw:
                base[hz].append((ser[i + hz][2] / c0 - 1) * 100 - (tw[d1] / tw[d0] - 1) * 100)
        for lo, hi, name in BUCKETS:
            if lo <= ratio < hi:
                if i - last_evt[name] < DEDUP:
                    break
                last_evt[name] = i
                for hz in HORIZONS:
                    d1 = ser[i + hz][0]
                    if d1 in tw:
                        events[name][hz].append((ser[i + hz][2] / c0 - 1) * 100 - (tw[d1] / tw[d0] - 1) * 100)
                # 後續 60 日的高低區間(%)——⭐ 用來檢驗「套牢多是不是就變箱型」
                fut = [x[2] for x in ser[i + 1:i + 61]]
                if len(fut) >= 60 and min(fut) > 0:
                    rng60[name].append((max(fut) - min(fut)) / min(fut) * 100)
                break

med = statistics.median
print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥260 根K)\n')
print('對照組(同批股票所有交易日,扣同期加權後):')
for hz in HORIZONS:
    b = base[hz]
    w = sum(1 for x in b if x > 0) / len(b) * 100
    print(f'  {hz:>3} 日:中位 {med(b):+6.2f}% ・勝率 {w:4.1f}% ・n={len(b):,}')

print('\n各套牢比例桶的超額報酬:')
for _, _, name in BUCKETS:
    print(f'\n■ {name}')
    for hz in HORIZONS:
        e = events[name][hz]
        if len(e) < 50:
            print(f'  {hz:>3} 日:樣本不足(n={len(e)})')
            continue
        edge = med(e) - med(base[hz])
        w = sum(1 for x in e if x > 0) / len(e) * 100
        bw = sum(1 for x in base[hz] if x > 0) / len(base[hz]) * 100
        print(f'  {hz:>3} 日:中位 {med(e):+6.2f}%(邊際 {edge:+5.2f}pp)・勝率 {w:4.1f}%(基準 {bw:4.1f}%)・n={len(e):,}')
    r = rng60[name]
    if len(r) >= 50:
        print(f'  📦 後續 60 日波動區間中位:{med(r):.1f}%(⭐ 越小越像箱型)')

print('\n⚠️ 判讀原則:')
print('  ・邊際 ±0.5pp 內視為雜訊;未扣交易成本(來回約 0.44%)')
print('  ・「套牢比例」是用成交量分布近似,⛔ 不是真實持有人成本(那沒有公開資料)')
print('  ・倖存者偏誤;窗口受 ^TWII 長度限制(約 2 年)')
