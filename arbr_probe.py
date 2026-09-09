#!/usr/bin/env python3
"""🧪 ARBR(人氣/意願指標)探針 —— 從 aiagents-stock 讀到的唯一「本專案沒有、而且純公式算得出來」的指標

公式(該專案 `market_sentiment_data.py` 的標準寫法):
  AR = Σ(High − Open) / Σ(Open − Low) × 100      ← 人氣:當日內買賣力道
  BR = Σ(High − 昨收) / Σ(昨收 − Low) × 100      ← 意願:相對昨收的追價意願(負值取 0)
  週期 N = 26

⭐ 為什麼值得測:**只需要 OHLC**(本專案有 2~3 年日 K)→ 零採礦、零 API。
⛔ 但照鐵則「預測性主張一定要先實測」——傳統說法是:
   ・AR > 150(過熱) / AR < 50(超賣)
   ・BR < AR 且兩者都低 → 買點;BR 遠高於 AR → 過熱
   這些門檻**沒有任何實證來源**,先驗過再決定要不要做。

檢驗設計(照本專案回測鐵則):
  ・事件 = AR/BR 由上方或下方「穿越」門檻那一天;同檔 20 個交易日內只算一次
  ・報酬 = 事件日收盤買進,10/20/60 日後;**扣掉同期加權指數**
  ・對照組 = 同一批股票每 40 天抽一天(基準不是 0 也不是 50%)
  ・⭐ 額外測「相對自己的歷史位階」版(同外資期貨 V71.1.6 的教訓:
     寫死絕對門檻常常失真,要看相對自己)

只讀 data/*.json,不打 API、不寫檔。跑法:python3 arbr_probe.py
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (10, 20, 60)
DEDUP = 20
N = 26

tw = {r['date'].replace('/', '-'): float(r['close'])
      for r in json.loads((DATA / '^TWII.json').read_text())}


def tw_ret(d0, d1):
    if d0 not in tw or d1 not in tw:
        return None
    return (tw[d1] / tw[d0] - 1) * 100


def arbr_series(o, h, l, c):
    """回傳 (ar[], br[]),前 N 筆為 None。⛔ BR 的分子分母都要 clip(0)(標準規則)。"""
    n = len(c)
    ar, br = [None] * n, [None] * n
    ho = [max(h[i] - o[i], 0) for i in range(n)]
    ol = [max(o[i] - l[i], 0) for i in range(n)]
    hcy = [max(h[i] - c[i - 1], 0) if i else 0 for i in range(n)]
    cyl = [max(c[i - 1] - l[i], 0) if i else 0 for i in range(n)]
    for i in range(N, n):
        s_ho = sum(ho[i - N + 1:i + 1]); s_ol = sum(ol[i - N + 1:i + 1])
        s_hcy = sum(hcy[i - N + 1:i + 1]); s_cyl = sum(cyl[i - N + 1:i + 1])
        if s_ol > 0:
            ar[i] = s_ho / s_ol * 100
        if s_cyl > 0:
            br[i] = s_hcy / s_cyl * 100
    return ar, br


# 傳統門檻(⚠️ 全部是「書上寫的」,沒有實證來源 —— 這正是要驗的)
BUCKETS = {
    'AR 向上穿 150(傳統:過熱)': ('ar_up', 150),
    'AR 向下穿 50(傳統:超賣可買)': ('ar_dn', 50),
    'BR 向上穿 300(傳統:極度過熱)': ('br_up', 300),
    'BR 向下穿 50(傳統:超賣)': ('br_dn', 50),
    'AR/BR 雙低(AR<60 且 BR<60,傳統:底部)': ('both_low', None),
    '⭐ AR 位階 ≥90%(相對自己近 250 日)': ('ar_pct_hi', 90),
    '⭐ AR 位階 ≤10%(相對自己近 250 日)': ('ar_pct_lo', 10),
}
events = {k: {h: [] for h in HORIZONS} for k in BUCKETS}
base = {h: [] for h in HORIZONS}
n_files = n_used = 0

for f in sorted(DATA.glob('[0-9][0-9][0-9][0-9].json')):
    n_files += 1
    try:
        rows = json.loads(f.read_text())
    except Exception:
        continue
    if not isinstance(rows, list) or len(rows) < 340:
        continue
    ser = [(r['date'].replace('/', '-'), float(r['open']), float(r['high']),
            float(r['low']), float(r['close'])) for r in rows
           if all(r.get(k) for k in ('open', 'high', 'low', 'close'))]
    if len(ser) < 340:
        continue
    n_used += 1
    dates = [x[0] for x in ser]
    o = [x[1] for x in ser]; h = [x[2] for x in ser]
    l = [x[3] for x in ser]; c = [x[4] for x in ser]
    n = len(ser)
    ar, br = arbr_series(o, h, l, c)

    for i in range(300, n - max(HORIZONS), 40):
        for hz in HORIZONS:
            r = (c[i + hz] / c[i] - 1) * 100
            m = tw_ret(dates[i], dates[i + hz])
            if m is not None:
                base[hz].append(r - m)

    last_evt = {k: -999 for k in BUCKETS}
    for i in range(300, n - max(HORIZONS)):
        if ar[i] is None or br[i] is None or ar[i - 1] is None:
            continue
        # 相對自己的位階(近 250 日 AR 分布)
        win = [x for x in ar[i - 250:i] if x is not None]
        ar_pct = (sum(1 for x in win if x < ar[i]) / len(win) * 100) if len(win) >= 100 else None
        for k, (kind, th) in BUCKETS.items():
            hit = False
            if kind == 'ar_up':
                hit = ar[i - 1] < th <= ar[i]
            elif kind == 'ar_dn':
                hit = ar[i - 1] > th >= ar[i]
            elif kind == 'br_up':
                hit = br[i - 1] is not None and br[i - 1] < th <= br[i]
            elif kind == 'br_dn':
                hit = br[i - 1] is not None and br[i - 1] > th >= br[i]
            elif kind == 'both_low':
                hit = ar[i] < 60 and br[i] < 60
            elif kind == 'ar_pct_hi':
                hit = ar_pct is not None and ar_pct >= th
            elif kind == 'ar_pct_lo':
                hit = ar_pct is not None and ar_pct <= th
            if hit and i - last_evt[k] >= DEDUP:
                last_evt[k] = i
                for hz in HORIZONS:
                    r = (c[i + hz] / c[i] - 1) * 100
                    m = tw_ret(dates[i], dates[i + hz])
                    if m is not None:
                        events[k][hz].append(r - m)

print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥340 根K)\n')
print('對照組(同批股票隨便挑一天,扣大盤後):')
for hz in HORIZONS:
    b = base[hz]
    w = sum(1 for x in b if x > 0) / len(b) * 100
    print(f'  {hz:>3} 日:中位 {statistics.median(b):+6.2f}% ・勝率 {w:4.1f}% ・n={len(b):,}')

print('\n各情境超額報酬(⚠️ 邊際 = 中位 − 對照組中位;⛔ 不是絕對報酬):')
for k in BUCKETS:
    print(f'\n■ {k}')
    for hz in HORIZONS:
        e = events[k][hz]
        if len(e) < 50:
            print(f'  {hz:>3} 日:樣本不足(n={len(e)})')
            continue
        med = statistics.median(e)
        w = sum(1 for x in e if x > 0) / len(e) * 100
        bw = sum(1 for x in base[hz] if x > 0) / len(base[hz]) * 100
        edge = med - statistics.median(base[hz])
        print(f'  {hz:>3} 日:中位 {med:+6.2f}%(邊際 {edge:+5.2f}pp)・勝率 {w:4.1f}%(基準 {bw:4.1f}%)・n={len(e):,}')

print('\n⚠️ 判讀原則(⛔ 別自己放寬):')
print('  ・邊際在 ±0.5pp 內 = 雜訊,不做(同 volstall/volseq 那兩次的處置)')
print('  ・未扣交易成本(來回約 0.44%)→ 邊際要明顯大於這個數才有實作價值')
print('  ・倖存者偏誤(下市的不在 data/);樣本落在 2024-2026,含一段多頭+2026/07 急跌')
