#!/usr/bin/env python3
"""
📈 McClellan 擺動指標 + 新高新低指標(NH-NL)—— 大盤層級實測(V74.9.3)

LAB `next` 掛了很久的兩個「還沒測」:它們是**大盤層級**,測法跟個股事件不同 →
照 `floorcount_probe.py` 的做法:每天從全市場 data/*.json 算出廣度,看**加權指數**未來 5/10/20 日。

定義(⛔ 都是純公式,只用到當天為止的資料):
  漲跌家數比 RANA = (上漲家數 − 下跌家數) ÷ (上漲 + 下跌) × 1000   (ratio-adjusted,家數會隨年份變才這樣做)
  McClellan 擺動 = EMA19(RANA) − EMA39(RANA);累積指標 = Σ 擺動
  新高新低 NH-NL = 創 250 日新高家數 − 創 250 日新低家數(÷ 當天掃到的家數,再 ×1000)
  10 日 NH-NL(Fosback)= 近 10 日 NH-NL 的加總

判準(⛔ 不寫死門檻 —— 同 V71.1.6 / floorcount 的做法):用**自己近一年的位階**分桶,
另外列出教科書門檻(擺動 < −100 / > +100)當對照。
關卡:對照組 = 所有交易日;前後半段同向;逐年同向;⚠️ 交易日高度重疊 → n 不是獨立樣本。

🧪 內建一致性檢查(⛔ 沒有它分不出「沒訊號」與「廣度算錯」):
  加權指數當天漲 >1% 的日子,RANA 中位必須明顯 > 0;跌 >1% 的必須明顯 < 0。
"""
import json
import statistics
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20)
MIN_BARS = 260
LOOK = 250

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

adv, dec, nh, nl, scanned = {}, {}, {}, {}, {}
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
            c = float(r['close']); d = r['date'].replace('/', '-')
            if c > 0:
                ser.append((d, c))
        except Exception:
            continue
    if len(ser) < MIN_BARS:
        continue
    n_used += 1
    closes = [x[1] for x in ser]
    # 滾動 250 日最高/最低(不含今天)
    from collections import deque
    hiq, loq = deque(), deque()
    for i in range(1, len(ser)):
        d0, c = ser[i]
        prev = closes[i - 1]
        # 維護單調佇列(窗口 = i-250 .. i-1)
        j = i - 1
        while hiq and hiq[0] < i - LOOK:
            hiq.popleft()
        while loq and loq[0] < i - LOOK:
            loq.popleft()
        while hiq and closes[hiq[-1]] <= closes[j]:
            hiq.pop()
        hiq.append(j)
        while loq and closes[loq[-1]] >= closes[j]:
            loq.pop()
        loq.append(j)
        if d0 not in tw:
            continue
        scanned[d0] = scanned.get(d0, 0) + 1
        if c > prev:
            adv[d0] = adv.get(d0, 0) + 1
        elif c < prev:
            dec[d0] = dec.get(d0, 0) + 1
        if i >= LOOK:
            if c > closes[hiq[0]]:
                nh[d0] = nh.get(d0, 0) + 1
            if c < closes[loq[0]]:
                nl[d0] = nl.get(d0, 0) + 1

days = sorted(d for d in scanned if scanned[d] >= 500)
print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥{MIN_BARS} 根K)・可用交易日 {len(days)} 天({days[0]} ~ {days[-1]})'
      f'・每天平均掃到 {int(statistics.mean(scanned[d] for d in days)):,} 檔')

# ── 指標 ──
rana = {}
for d in days:
    a, b = adv.get(d, 0), dec.get(d, 0)
    rana[d] = (a - b) / (a + b) * 1000 if (a + b) else 0.0
def ema(seq, n):
    k = 2 / (n + 1); out = []; e = None
    for v in seq:
        e = v if e is None else (v - e) * k + e
        out.append(e)
    return out
seq = [rana[d] for d in days]
e19, e39 = ema(seq, 19), ema(seq, 39)
osc = {d: e19[i] - e39[i] for i, d in enumerate(days) if i >= 39}
summ = {}; s = 0.0
for i, d in enumerate(days):
    if i >= 39:
        s += osc[d]; summ[d] = s
nhnl = {d: (nh.get(d, 0) - nl.get(d, 0)) / scanned[d] * 1000 for d in days}
nhnl10 = {}
for i, d in enumerate(days):
    if i >= 9:
        nhnl10[d] = sum(nhnl[days[j]] for j in range(i - 9, i + 1))

# 🧪 一致性檢查
def twchg(d):
    i = tw_idx[d]
    return (tw[d] / tw[tw_dates[i - 1]] - 1) * 100 if i > 0 else None
up = [rana[d] for d in days if (twchg(d) or 0) > 1]
dn = [rana[d] for d in days if (twchg(d) or 0) < -1]
mu, md = statistics.median(up), statistics.median(dn)
print(f'🧪 一致性:大盤漲>1% 的日子 RANA 中位 {mu:+.0f}(n={len(up)})・跌>1% 的 {md:+.0f}(n={len(dn)})'
      + ('  ✅' if mu > 300 and md < -300 else '  🚨 廣度算錯了,下面的表不要看'))
vals = [osc[d] for d in osc]
print(f'📐 擺動指標分布:P5 {sorted(vals)[int(len(vals)*.05)]:+.0f} ・中位 {statistics.median(vals):+.0f} ・P95 {sorted(vals)[int(len(vals)*.95)]:+.0f}'
      f'  ・NH-NL(‰)分布:P5 {sorted(nhnl.values())[int(len(nhnl)*.05)]:+.0f} ・P95 {sorted(nhnl.values())[int(len(nhnl)*.95)]:+.0f}')


def fwd(d0, hz):
    i = tw_idx.get(d0)
    if i is None or i + hz >= len(tw_dates):
        return None
    return (tw[tw_dates[i + hz]] / tw[d0] - 1) * 100


base = {hz: [x for x in (fwd(d, hz) for d in days) if x is not None] for hz in HORIZONS}
bmed = {hz: statistics.median(base[hz]) for hz in HORIZONS}
bwin = {hz: sum(1 for x in base[hz] if x > 0) / len(base[hz]) * 100 for hz in HORIZONS}
print('對照組(大盤隨便一天):' + ''.join(f'  {hz}日 中位 {bmed[hz]:+.2f}%/勝率 {bwin[hz]:.1f}%' for hz in HORIZONS) + f'  (n={len(base[5])})')


def robust(sel, hz):
    """前後半段 + 逐年 的 20 日邊際(中位差)"""
    e = [(d, fwd(d, hz)) for d in sel]
    e = [(d, x) for d, x in e if x is not None]
    if len(e) < 30:
        return ''
    mid = len(e) // 2
    h1 = statistics.median(x for _, x in e[:mid]) - bmed[hz]
    h2 = statistics.median(x for _, x in e[mid:]) - bmed[hz]
    yrs = {}
    for d, x in e:
        yrs.setdefault(d[:4], []).append(x)
    ys = ' '.join(f"{y[2:]}:{statistics.median(v)-bmed[hz]:+.1f}" for y, v in sorted(yrs.items()) if len(v) >= 8)
    same = (h1 > 0) == (h2 > 0)
    return f' ・前/後半 {h1:+.2f}/{h2:+.2f}{"✅" if same else "❌"} ・逐年 {ys}'


def report(title, series, buckets, pct_mode=True):
    print(f'\n{"═" * 68}\n{title}\n{"═" * 68}')
    ds = [d for d in days if d in series]
    if pct_mode:
        pb = {}
        for k, d in enumerate(ds):
            win = [series[x] for x in ds[max(0, k - 240):k + 1]]
            if len(win) < 120:
                continue
            pb[d] = sum(1 for v in win if v < series[d]) / len(win) * 100
        val = pb
    else:
        val = series
    for lo, hi, name in buckets:
        sel = [d for d in val if lo <= val[d] < hi]
        if len(sel) < 15:
            print(f'\n  ■ {name}:樣本不足(n={len(sel)})')
            continue
        print(f'\n  ■ {name}  (n={len(sel)} 個交易日)')
        for hz in HORIZONS:
            e = [x for x in (fwd(d, hz) for d in sel) if x is not None]
            if len(e) < 15:
                continue
            edge = statistics.median(e) - bmed[hz]
            w = sum(1 for x in e if x > 0) / len(e) * 100
            print(f'     {hz:>3} 日:中位 {statistics.median(e):+6.2f}%(邊際 {edge:+5.2f}pp)・勝率 {w:5.1f}%(基準 {bwin[hz]:4.1f}%)・n={len(e)}'
                  + (robust(sel, hz) if hz == 20 else ''))


PCT = [(0, 5, '⭐ 位階 <5%(近一年最低的那幾天 = 超賣)'), (5, 20, '位階 5~20%'), (20, 50, '位階 20~50%'),
       (50, 80, '位階 50~80%'), (80, 95, '位階 80~95%'), (95, 101, '⭐ 位階 ≥95%(近一年最高 = 超買)')]
report('① McClellan 擺動指標(相對自己近一年的位階)', osc, PCT)
report('①b McClellan 擺動指標 —— 教科書門檻(⛔ 對照用,門檻是別人訂的)', osc,
       [(-9999, -100, '< −100(超賣)'), (-100, 0, '−100~0'), (0, 100, '0~+100'), (100, 9999, '> +100(超買)')], pct_mode=False)
report('② McClellan 累積指標(相對自己近一年的位階)', summ, PCT)
report('③ 新高新低 NH-NL(當日,‰,相對自己近一年的位階)', nhnl, PCT)
report('④ 10 日 NH-NL(Fosback,相對自己近一年的位階)', nhnl10, PCT)

# ⑤ 事件:擺動指標由 <−X 翻回 >−X(「超賣反轉」),X = 自己近一年 P10
print(f'\n{"═" * 68}\n⑤ 事件:擺動指標從近一年 P10 以下**翻回上面**(超賣反轉),10 日去重\n{"═" * 68}')
ds = [d for d in days if d in osc]
ev = []; last_ev = -99
for k in range(1, len(ds)):
    win = [osc[x] for x in ds[max(0, k - 240):k]]
    if len(win) < 120:
        continue
    thr = sorted(win)[int(len(win) * 0.10)]
    if osc[ds[k - 1]] < thr <= osc[ds[k]] and k - last_ev > 10:
        ev.append(ds[k]); last_ev = k
print(f'  n={len(ev)}')
for hz in HORIZONS:
    e = [x for x in (fwd(d, hz) for d in ev) if x is not None]
    if len(e) >= 10:
        edge = statistics.median(e) - bmed[hz]
        w = sum(1 for x in e if x > 0) / len(e) * 100
        print(f'     {hz:>3} 日:中位 {statistics.median(e):+6.2f}%(邊際 {edge:+5.2f}pp)・勝率 {w:5.1f}%(基準 {bwin[hz]:4.1f}%)・n={len(e)}'
              + (robust(ev, hz) if hz == 20 else ''))

print('\n⚠️ 判讀限制(⛔ 別過度解讀):')
print('  ・交易日之間**高度重疊**(連續幾天位階都很低是同一件事)→ n 不是獨立樣本')
print('  ・倖存者偏誤:已下市的股票不在 data/ 裡;「家數」的絕對值不能跟官方比')
print('  ・這是**大盤**層級的結論,⛔ 不可直接套到個股打法(V73.2.1:地板股 300+ 對大盤有邊際,混進個股打法少賺 98 萬)')
print('  ・未扣交易成本;用的是加權指數(市值加權)不是等權')
