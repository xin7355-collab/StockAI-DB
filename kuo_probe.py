#!/usr/bin/env python3
"""🧪 郭哲榮「三五法則」探針 —— 回檔 25%/35% 買進到底有沒有邊際?

他的原話(2026-07-16 直播,逐字):
  「強制股回檔25% 100元回到75元買」(強勢股回檔 25% 可買)
  「落中透強的怎麼樣100元回到65元可以買富貴險中求」(落難績優股回檔 35% 可買)
  「可是一檔股票100元給回到50元那不對勁了不應該跌那麼深的」(回檔 >50% 別碰)

檢驗設計(照本專案回測鐵則):
  ・「強勢股」= 近 60 個交易日內創過 250 日新高(他講的對象都是剛創高的飆股)
  ・事件 = 該股從 250 日高點回檔進入某個桶(25±5% / 35±5% / 50%+)的那一天
  ・報酬 = 事件日收盤買進,10/20/60 日後收盤;**扣掉同期加權指數**(對照組鐵則)
  ・去重:同一檔股票 20 個交易日內只算一次事件
  ・對照組:同一批股票「隨便挑一天」的同天期超額報酬(基準不是 0 也不是 50%)

只讀 data/*.json,不打 API、不寫檔。跑法:python3 kuo_probe.py
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (10, 20, 60)
DEDUP = 20

tw = {r['date'].replace('/', '-'): float(r['close'])
      for r in json.loads((DATA / '^TWII.json').read_text())}
tw_dates = sorted(tw)
tw_idx = {d: i for i, d in enumerate(tw_dates)}


def tw_ret(d0, d1):
    if d0 not in tw or d1 not in tw:
        return None
    return (tw[d1] / tw[d0] - 1) * 100


buckets = {
    '回檔20~30%(他:強勢股可買)': (0.20, 0.30),
    '回檔30~40%(他:三五法則可買)': (0.30, 0.40),
    '回檔40~55%(他:不對勁區)': (0.40, 0.55),
    '回檔55%以上(他:別碰)': (0.55, 0.90),
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

    # 對照組:每 40 天抽一天(零假設)
    for i in range(250, n - max(HORIZONS), 40):
        for h in HORIZONS:
            r = (closes[i + h] / closes[i] - 1) * 100
            m = tw_ret(dates[i], dates[i + h])
            if m is not None:
                base[h].append(r - m)

    last_evt = {k: -999 for k in buckets}
    for i in range(250, n - max(HORIZONS)):
        hi250 = max(closes[i - 250:i + 1])
        hi_at = max(range(i - 250, i + 1), key=lambda j: closes[j])
        # 「強勢股」門檻:高點是近 60 日內創的(剛創高才叫強勢股/飆股)
        if i - hi_at > 60:
            continue
        dd = 1 - closes[i] / hi250
        for k, (lo, hi) in buckets.items():
            if lo <= dd < hi and i - last_evt[k] >= DEDUP:
                last_evt[k] = i
                for h in HORIZONS:
                    r = (closes[i + h] / closes[i] - 1) * 100
                    m = tw_ret(dates[i], dates[i + h])
                    if m is not None:
                        events[k][h].append(r - m)
                break

print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥320 根K)\n')
print('對照組(同批股票隨便挑一天,扣大盤後):')
for h in HORIZONS:
    b = base[h]
    w = sum(1 for x in b if x > 0) / len(b) * 100
    print(f'  {h:>3} 日:中位 {statistics.median(b):+6.2f}% ・勝率 {w:4.1f}% ・n={len(b):,}')

print('\n各桶超額報酬(⚠️ 事件日=回檔「進入」該區間那天,近 60 日內剛創過 250 日高):')
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

print('\n⚠️ 已知限制:資料約 2~3 年、涵蓋 2025-2026 多頭+2026/07 急跌;')
print('   倖存者偏誤(下市的不在 data/);未扣交易成本;')
print('   「績優股」他有基本面篩選(本探針只用價格,寬鬆版)。')
