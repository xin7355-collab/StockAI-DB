#!/usr/bin/env python3
"""🧪 權證小哥「乖離年線 200%」探針 —— 正乖離年線太大的股票,後面是不是真的撐不久?

他的原話(2026 直播逐字,【台股止跌了嗎】):
  「乖離年線大概到兩三百%以上喔它的壓力都很大」
  「我很少看到乖離年線200%以上可以撐很久」(連講兩次)
  「現在歸離年線第一名叫旭蘭…第二名叫台勝科…所以呢 今天當然是空他啊」(他據此放空)

檢驗設計(照本專案回測鐵則):
  ・乖離年線 = close / MA240 − 1(%)
  ・事件 = 乖離「向上穿越」某桶下緣那一天(50/100/150/200%);去重 20 交易日
  ・報酬 = 事件日收盤,10/20/60 日後;**扣同期加權指數**(對照組鐵則)
  ・對照組 = 同批股票每 40 天抽一天(零假設基準,不是 0 也不是 50%)

只讀 data/*.json,不打 API、不寫檔。跑法:python3 bias240_probe.py
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (10, 20, 60)
DEDUP = 20

tw = {r['date'].replace('/', '-'): float(r['close'])
      for r in json.loads((DATA / '^TWII.json').read_text())}


def tw_ret(d0, d1):
    if d0 not in tw or d1 not in tw:
        return None
    return (tw[d1] / tw[d0] - 1) * 100


buckets = {
    '乖離年線 50~100%': (0.50, 1.00),
    '乖離年線 100~150%': (1.00, 1.50),
    '乖離年線 150~200%': (1.50, 2.00),
    '乖離年線 200%以上(他:撐不久/空它)': (2.00, 99.0),
}
events = {k: {h: [] for h in HORIZONS} for k in buckets}
base = {h: [] for h in HORIZONS}
n_files = n_used = 0

for f in sorted(DATA.glob('[0-9][0-9][0-9][0-9].json')):
    n_files += 1
    try:
        rows = json.loads(f.read_text())
    except Exception:
        continue
    if not isinstance(rows, list) or len(rows) < 320:
        continue
    ser = [(r['date'].replace('/', '-'), float(r['close'])) for r in rows
           if r.get('close') and float(r['close']) > 0]
    if len(ser) < 320:
        continue
    n_used += 1
    dates = [d for d, _ in ser]
    closes = [c for _, c in ser]
    n = len(ser)

    for i in range(250, n - max(HORIZONS), 40):
        for h in HORIZONS:
            r = (closes[i + h] / closes[i] - 1) * 100
            m = tw_ret(dates[i], dates[i + h])
            if m is not None:
                base[h].append(r - m)

    # 預算 MA240 與乖離序列
    csum = [0.0]
    for c in closes:
        csum.append(csum[-1] + c)
    last_evt = {k: -999 for k in buckets}
    prev_bias = None
    for i in range(250, n - max(HORIZONS)):
        ma240 = (csum[i + 1] - csum[i + 1 - 240]) / 240
        if ma240 <= 0:
            prev_bias = None
            continue
        bias = closes[i] / ma240 - 1
        if prev_bias is not None:
            for k, (lo, hi) in buckets.items():
                # 事件 = 向上「穿越」桶下緣(prev < lo <= bias),照他講的「乖離漲到 X%」語意
                if prev_bias < lo <= bias < hi and i - last_evt[k] >= DEDUP:
                    last_evt[k] = i
                    for h in HORIZONS:
                        r = (closes[i + h] / closes[i] - 1) * 100
                        m = tw_ret(dates[i], dates[i + h])
                        if m is not None:
                            events[k][h].append(r - m)
        prev_bias = bias

print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥320 根K)\n')
print('對照組(同批股票隨便挑一天,扣大盤後):')
for h in HORIZONS:
    b = base[h]
    w = sum(1 for x in b if x > 0) / len(b) * 100
    print(f'  {h:>3} 日:中位 {statistics.median(b):+6.2f}% ・勝率 {w:4.1f}% ・n={len(b):,}')

print('\n各桶超額報酬(事件=乖離向上穿越該桶下緣那天):')
for k in buckets:
    print(f'\n■ {k}')
    for h in HORIZONS:
        e = events[k][h]
        if len(e) < 30:
            print(f'  {h:>3} 日:樣本不足(n={len(e)})')
            continue
        med = statistics.median(e)
        w = sum(1 for x in e if x > 0) / len(e) * 100
        bw = sum(1 for x in base[h] if x > 0) / len(base[h]) * 100
        edge = med - statistics.median(base[h])
        print(f'  {h:>3} 日:中位 {med:+6.2f}%(邊際 {edge:+5.2f}pp)・勝率 {w:4.1f}%(基準 {bw:4.1f}%)・n={len(e):,}')

print('\n⚠️ 已知限制:約 2~3 年資料、倖存者偏誤(下市不在 data/)、未扣交易成本、')
print('   放空還有借券成本與回補風險未計;樣本多落在 2025-2026 多頭+2026/07 急跌。')
