#!/usr/bin/env python3
"""🏚️📊 「全市場地板股家數」探針 —— 權證小哥《哥有籌必爆》S2 第22集 + 兆華艾綸說(2026-07-08)

他的原話:「你要大撿股票的時候大概就是有一堆地板股…**假如地板股有大概 100 檔,
那大概就是短線的低點**」「最近地板股還不多 → 代表這個盤還沒跌到可以撿的位置」。

⭐ 為什麼這條值得測(而且非測不可):
   ① 這是**大盤層級**的訊號 —— 我現有的 `_detectFloorBounce` 是個股層級,
      回答「這一檔該不該接刀」(V71.8.9 已實測:接刀平均輸大盤)。
      但「**全市場有幾檔同時到地板**」問的是完全不同的問題:**大盤跌完了沒**。
   ② **完全可以回算** —— 只要 K 線,零採礦、零 API(符合「要馬上就能用」鐵則)。
   ③ 他給了具體門檻(100 檔),⛔ 但寫死的絕對門檻在本專案已被打臉過兩次
      (V71.1.6 外資期貨、V71.8.1 波動率)→ 這裡同時測「絕對家數」與「自己的歷史位階」。

定義(跟前端 `_detectFloorBounce` 完全同一套,⛔ 不另立一份真相):
  地板股 = ① 對 20MA 的乖離落在**這檔自己近 260 日分布的最低 5%**
           ② 且當日量 ≥ 20 日均量 × 2(他說的「一定要有量」)
  ⭐ 另外輸出「不看量」的版本,用來檢驗「量」這個條件在大盤層級有沒有加分。

檢驗:每個交易日算出全市場地板股家數 → 看加權指數後續 5/10/20 日報酬。
  ・對照組 = 所有掃到的交易日(⛔ 不抽樣 —— playbook_backtest 第一版踩過抽樣偏誤)
  ・⚠️ 這裡的報酬**不扣大盤**(標的本身就是大盤),所以基準是「大盤隨便一天」的絕對報酬

只讀 data/*.json,不打 API、不寫檔。跑法:python3 floorcount_probe.py
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20)
MIN_BARS = 260          # 要夠長才算得出「自己的歷史分布」(同 _detectFloorBounce)
PCTL = 5                # 乖離落在自己歷史最低 5%
VOL_X = 2.0             # 他說的「20 日均量兩倍」

tw_rows = json.loads((DATA / '^TWII.json').read_text())
tw = {}
for r in tw_rows:
    try:
        c = float(r['close'])
        if c > 0:
            tw[r['date'].replace('/', '-')] = c
    except Exception:
        continue
tw_dates = sorted(tw)
tw_idx = {d: i for i, d in enumerate(tw_dates)}

# ─────────────────────────────────────────────────────────────
# 逐檔算出「這一天是不是地板股」,累加成每日家數
# ─────────────────────────────────────────────────────────────
floor_big = {}      # 日期 → 有量地板股家數
floor_any = {}      # 日期 → 不看量的地板股家數
scanned = {}        # 日期 → 當天有被掃到的股票數(當分母,避免早期樣本少導致家數天生偏低)
n_files = n_used = 0

for f in sorted(DATA.glob('[0-9][0-9][0-9][0-9].json')):
    n_files += 1
    try:
        rows = json.loads(f.read_text())
    except Exception:
        continue
    if not isinstance(rows, list) or len(rows) < MIN_BARS:
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
    if len(ser) < MIN_BARS:
        continue
    n_used += 1
    n = len(ser)
    closes = [x[1] for x in ser]

    # 逐日 20MA 乖離
    bias = [None] * n
    run = sum(closes[:20])
    for i in range(19, n):
        if i > 19:
            run += closes[i] - closes[i - 20]
        m = run / 20
        if m > 0:
            bias[i] = (closes[i] - m) / m * 100

    for i in range(MIN_BARS - 1, n):
        d0 = ser[i][0]
        if d0 not in tw:
            continue
        scanned[d0] = scanned.get(d0, 0) + 1
        b = bias[i]
        if b is None:
            continue
        # 這檔自己的歷史分布(用到今天為止的全部,⛔ 不看未來)
        hist = [x for x in bias[:i + 1] if x is not None]
        if len(hist) < 200:
            continue
        below = sum(1 for x in hist if x < b)
        if below / len(hist) * 100 > PCTL:
            continue
        floor_any[d0] = floor_any.get(d0, 0) + 1
        vs = [x[2] for x in ser[max(0, i - 20):i] if x[2] > 0]
        if len(vs) >= 10:
            vma = sum(vs) / len(vs)
            if vma > 0 and ser[i][2] / vma >= VOL_X:
                floor_big[d0] = floor_big.get(d0, 0) + 1

print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥{MIN_BARS} 根K)')
days = sorted(d for d in scanned if scanned[d] >= 500)
print(f'可用交易日 {len(days)} 天({days[0]} ~ {days[-1]}),每天平均掃到 '
      f'{int(statistics.mean(scanned[d] for d in days)):,} 檔\n')


def fwd(d0, hz):
    """加權指數後 hz 個交易日的報酬(%)"""
    i = tw_idx.get(d0)
    if i is None or i + hz >= len(tw_dates):
        return None
    return (tw[tw_dates[i + hz]] / tw[d0] - 1) * 100


def report(title, counts, buckets, pct_mode=False):
    print(f'\n{"═" * 68}\n{title}\n{"═" * 68}')
    vals = [counts.get(d, 0) for d in days]
    print(f'  家數分布:中位 {statistics.median(vals):.0f} ・ P90 {sorted(vals)[int(len(vals)*0.9)]:.0f} '
          f'・ 最大 {max(vals)} ・ 為 0 的天數 {sum(1 for v in vals if v == 0)}')
    base = {hz: [] for hz in HORIZONS}
    for d in days:
        for hz in HORIZONS:
            r = fwd(d, hz)
            if r is not None:
                base[hz].append(r)
    print('  對照組(大盤隨便一天):', end='')
    for hz in HORIZONS:
        b = base[hz]
        print(f'  {hz}日 中位 {statistics.median(b):+.2f}%/勝率 {sum(1 for x in b if x>0)/len(b)*100:.1f}%', end='')
    print(f'  (n={len(base[HORIZONS[0]])})')
    for lo, hi, name in buckets:
        sel = [d for d in days if lo <= counts.get(d, 0) < hi]
        if len(sel) < 15:
            print(f'\n  ■ {name}:樣本不足(n={len(sel)})')
            continue
        print(f'\n  ■ {name}  (n={len(sel)} 個交易日)')
        for hz in HORIZONS:
            e = [fwd(d, hz) for d in sel]
            e = [x for x in e if x is not None]
            if len(e) < 15:
                continue
            edge = statistics.median(e) - statistics.median(base[hz])
            w = sum(1 for x in e if x > 0) / len(e) * 100
            bw = sum(1 for x in base[hz] if x > 0) / len(base[hz]) * 100
            print(f'     {hz:>3} 日:中位 {statistics.median(e):+6.2f}%(邊際 {edge:+5.2f}pp)'
                  f'・勝率 {w:5.1f}%(基準 {bw:4.1f}%)・n={len(e)}')


report('① 有量地板股(量 ≥ 20日均量×2)—— 他說的正版定義',
       floor_big,
       [(0, 1, '0 檔(完全沒有)'), (1, 10, '1~9 檔'), (10, 30, '10~29 檔'),
        (30, 60, '30~59 檔'), (60, 100, '60~99 檔'), (100, 99999, '⭐ 100 檔以上(他說的短線低點)')])

report('② 不看量的地板股(只看極端負乖離)—— 用來檢驗「量」有沒有加分',
       floor_any,
       [(0, 10, '0~9 檔'), (10, 50, '10~49 檔'), (50, 150, '50~149 檔'),
        (150, 300, '150~299 檔'), (300, 99999, '300 檔以上')])

# ③ 相對自己的歷史位階(⛔ 不用寫死門檻 —— 同 V71.1.6 外資期貨的教訓)
print(f'\n{"═" * 68}\n③ 改用「家數在自己近一年的位階」(⛔ 不寫死絕對門檻)\n{"═" * 68}')
base = {hz: [x for x in (fwd(d, hz) for d in days) if x is not None] for hz in HORIZONS}
pct_bucket = {}
for k, d in enumerate(days):
    win = [floor_big.get(x, 0) for x in days[max(0, k - 240):k + 1]]
    if len(win) < 120:
        continue
    cur = floor_big.get(d, 0)
    pct_bucket[d] = sum(1 for v in win if v < cur) / len(win) * 100
for lo, hi, name in [(0, 50, '位階 <50%(地板股比平常少)'),
                     (50, 80, '位階 50~80%'),
                     (80, 95, '位階 80~95%(比平常多)'),
                     (95, 101, '⭐ 位階 ≥95%(近一年最多的那幾天)')]:
    sel = [d for d in pct_bucket if lo <= pct_bucket[d] < hi]
    if len(sel) < 15:
        print(f'\n  ■ {name}:樣本不足(n={len(sel)})')
        continue
    print(f'\n  ■ {name}  (n={len(sel)} 個交易日)')
    for hz in HORIZONS:
        e = [x for x in (fwd(d, hz) for d in sel) if x is not None]
        if len(e) < 15:
            continue
        edge = statistics.median(e) - statistics.median(base[hz])
        w = sum(1 for x in e if x > 0) / len(e) * 100
        bw = sum(1 for x in base[hz] if x > 0) / len(base[hz]) * 100
        print(f'     {hz:>3} 日:中位 {statistics.median(e):+6.2f}%(邊際 {edge:+5.2f}pp)'
              f'・勝率 {w:5.1f}%(基準 {bw:4.1f}%)・n={len(e)}')

print('\n⚠️ 判讀限制(⛔ 別過度解讀):')
print('  ・窗口受 ^TWII 長度限制(V74.2.8 起約 5 年、已含 2022 空頭),但大跌樣本本來就少')
print('  ・交易日之間**高度重疊**(連續幾天都算低點是同一件事)→ n 不是獨立樣本,勝率要保守看')
print('  ・倖存者偏誤:已下市的股票不在 data/ 裡')
print('  ・未扣交易成本(來回約 0.44%)')
