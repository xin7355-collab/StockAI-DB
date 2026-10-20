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

🔁 V79.4.3(16 年 d16 重跑前修):
  ① 對照組 ⛔ 不再是「16 年全期的中位數」(那是用到未來 —— 2011 的訊號拿去跟 2020 年以後的多頭比)
     → 每個訊號日的基準 = **那天之前已經實現**的「隨便一天抱 N 日」中位數(擴張窗口,≥120 天才給;勝率同理),
       邊際 = 每一筆(報酬 − 當時的基準)的中位數;前後半 / 逐年同一條
  ② 斷崖(lib_limit.cliff_prefix,×1.5 / ×0.67 = 減資 / 停牌恢復 / 資料洞)只剔碰到的窗口:
     今天跟昨天之間是斷崖 → 這一檔今天不算漲跌;250 日窗口裡有斷崖 → 不算新高新低(⛔ 舊版沒有斷崖守門)
  MAX_SYMS=N 冒煙測試用(平均抽 N 檔;⚠️ 每天要 ≥500 檔才算,抽太少會沒有可用的日子)
  python3 scripts/breadth_osc_probe.py --selftest

🧪 內建一致性檢查(⛔ 沒有它分不出「沒訊號」與「廣度算錯」):
  加權指數當天漲 >1% 的日子,RANA 中位必須明顯 > 0;跌 >1% 的必須明顯 < 0。
"""
import bisect
import json
import os
import statistics
import sys
from collections import deque
from pathlib import Path

import lib_limit as LL   # 🔁 V79.4.3 斷崖守門(跟 lib_cliff.mjs 同一組門檻)

DATA = Path(os.environ.get('DATA_DIR') or 'data')   # V79.4.0:可指到 d16(16 年全市場)
HORIZONS = (5, 10, 20)
MIN_BARS = 260
LOOK = 250
BASE_MIN = 120        # 🔁 V79.4.3 那天之前已經實現的日子少於這麼多 → 沒有基準,那一筆不算
MAX_SYMS = int(os.environ.get('MAX_SYMS') or 0)   # 🔁 V79.4.3 冒煙測試用;0 = 全部


def load_tw(data):
    tw_rows = json.loads((data / '^TWII.json').read_text())
    tw = {}
    for r in tw_rows:
        try:
            c = float(r['close'])
            if c > 0:
                tw[r['date'].replace('/', '-')] = c
        except Exception:
            continue
    tw_dates = sorted(tw)
    return tw, tw_dates, {d: i for i, d in enumerate(tw_dates)}


def new_acc():
    return {'adv': {}, 'dec': {}, 'nh': {}, 'nl': {}, 'scanned': {}, 'cliff_day': 0, 'cliff_hl': 0}


def scan_stock(rows, tw, acc):
    """一檔 → 把每天的漲跌 / 新高新低加進 acc;回 True = 有用到這一檔。
    🔁 V79.4.3 今天跟昨天之間是斷崖 → 這一檔今天整個不算;250 日窗口裡有斷崖 → 這一檔今天不算新高新低(同還沒滿 250 根的新股)"""
    if not isinstance(rows, list) or len(rows) < MIN_BARS:
        return False
    ser, opens = [], []
    for r in rows:
        try:
            c = float(r['close']); d = r['date'].replace('/', '-')
            if c > 0:
                ser.append((d, c))
                try:
                    opens.append(float(r.get('open') or 0))
                except (TypeError, ValueError):
                    opens.append(0.0)
        except Exception:
            continue
    if len(ser) < MIN_BARS:
        return False
    adv, dec, nh, nl, scanned = acc['adv'], acc['dec'], acc['nh'], acc['nl'], acc['scanned']
    closes = [x[1] for x in ser]
    pre = LL.cliff_prefix(closes, opens)
    # 滾動 250 日最高/最低(不含今天)
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
        if LL.cliff_in(pre, i - 1, i):          # 🔁 V79.4.3 今天這一根本身就是斷崖 → 漲跌是假的
            acc['cliff_day'] += 1
            continue
        scanned[d0] = scanned.get(d0, 0) + 1
        if c > prev:
            adv[d0] = adv.get(d0, 0) + 1
        elif c < prev:
            dec[d0] = dec.get(d0, 0) + 1
        if i >= LOOK:
            if LL.cliff_in(pre, i - LOOK, i):   # 🔁 V79.4.3 250 日窗口有斷崖 → 新高 / 新低是假的
                acc['cliff_hl'] += 1
                continue
            if c > closes[hiq[0]]:
                nh[d0] = nh.get(d0, 0) + 1
            if c < closes[loq[0]]:
                nl[d0] = nl.get(d0, 0) + 1
    return True


def ema(seq, n):
    k = 2 / (n + 1); out = []; e = None
    for v in seq:
        e = v if e is None else (v - e) * k + e
        out.append(e)
    return out


def make_fwd(tw, tw_dates, tw_idx):
    def fwd(d0, hz):
        i = tw_idx.get(d0)
        if i is None or i + hz >= len(tw_dates):
            return None
        return (tw[tw_dates[i + hz]] / tw[d0] - 1) * 100
    return fwd


def _median_sorted(v):
    m = len(v)
    return v[m // 2] if m % 2 else (v[m // 2 - 1] + v[m // 2]) / 2


def past_baseline(days, fwd, tw_idx, hz, min_n=BASE_MIN):
    """🔁 V79.4.3 每一天的基準 = 那天之前**已經實現**的「隨便一天抱 hz 日」中位數與勝率(擴張窗口)。
    d' 的報酬要到 idx(d') + hz 那天收盤才知道 → 只收 idx(d') + hz ≤ idx(d)。
    ⛔ 舊版減的是全期中位數 = 用到未來。回 (中位 {d: %}, 勝率 {d: %});已實現的日子 < min_n 的那天不給。"""
    vals, med, win = [], {}, {}
    pos = n_pos = 0
    for d in days:
        k = tw_idx[d]
        while pos < len(days) and tw_idx[days[pos]] + hz <= k:
            x = fwd(days[pos], hz)
            if x is not None:
                bisect.insort(vals, x)
                if x > 0:
                    n_pos += 1
            pos += 1
        if len(vals) >= min_n:
            med[d] = _median_sorted(vals)
            win[d] = n_pos / len(vals) * 100
    return med, win


def edge_rows(sel, hz, fwd, bmed):
    """訊號日 → [(日期, 報酬, 報酬 − 當時的基準)](照日期排);沒有基準的那幾筆另外回筆數(⛔ 不補值)"""
    out, drop = [], 0
    for d in sorted(sel):
        x = fwd(d, hz)
        if x is None:
            continue
        if d not in bmed:
            drop += 1
            continue
        out.append((d, x, x - bmed[d]))
    return out, drop


def robust(rows):
    """前後半段(照日期)+ 逐年 的邊際(每一筆減當時基準之後的中位數)"""
    if len(rows) < 30:
        return ''
    mid = len(rows) // 2
    h1 = statistics.median(ex for _, _, ex in rows[:mid])
    h2 = statistics.median(ex for _, _, ex in rows[mid:])
    yrs = {}
    for d, _, ex in rows:
        yrs.setdefault(d[:4], []).append(ex)
    ys = ' '.join(f"{y[2:]}:{statistics.median(v):+.1f}" for y, v in sorted(yrs.items()) if len(v) >= 8)
    same = (h1 > 0) == (h2 > 0)
    return f' ・前/後半 {h1:+.2f}/{h2:+.2f}{"✅" if same else "❌"} ・逐年 {ys}'


def line_for(sel, hz, fwd, bmed, bwin, min_n):
    """一個天期那一行;樣本 < min_n 回 None。基準勝率 = 那幾個訊號日「當時已知的」勝率平均"""
    rows, drop = edge_rows(sel, hz, fwd, bmed)
    if len(rows) < min_n:
        return None
    e = [x for _, x, _ in rows]
    edge = statistics.median(ex for _, _, ex in rows)
    w = sum(1 for x in e if x > 0) / len(e) * 100
    bw = statistics.mean(bwin[d] for d, _, _ in rows)
    return (f'     {hz:>3} 日:中位 {statistics.median(e):+6.2f}%(邊際 {edge:+5.2f}pp)・勝率 {w:5.1f}%(基準 {bw:4.1f}%)・n={len(e)}'
            + (f'(沒有當時基準剔除 {drop})' if drop else '')
            + (robust(rows) if hz == 20 else ''))


def main():
    tw, tw_dates, tw_idx = load_tw(DATA)
    acc = new_acc()
    n_files = n_used = 0
    files = sorted(DATA.glob('[0-9][0-9][0-9][0-9].json'))
    if MAX_SYMS > 0 and len(files) > MAX_SYMS:   # 🔁 V79.4.3 平均抽樣(⛔ 不取前 N —— 代號排序會偏產業)
        st = len(files) / MAX_SYMS
        files = [files[int(k * st)] for k in range(MAX_SYMS)]
    for f in files:
        n_files += 1
        try:
            rows = json.loads(f.read_text())
        except Exception:
            continue
        if scan_stock(rows, tw, acc):
            n_used += 1
    adv, dec, nh, nl, scanned = acc['adv'], acc['dec'], acc['nh'], acc['nl'], acc['scanned']

    days = sorted(d for d in scanned if scanned[d] >= 500)
    if not days:
        print(f'🚨 沒有任何一天掃到 ≥500 檔(掃 {n_files} 檔,可用 {n_used} 檔)→ 停(MAX_SYMS 抽太少?)')
        sys.exit(1)
    print(f'掃 {n_files} 檔,可用 {n_used} 檔(≥{MIN_BARS} 根K)・可用交易日 {len(days)} 天({days[0]} ~ {days[-1]})'
          f'・每天平均掃到 {int(statistics.mean(scanned[d] for d in days)):,} 檔'
          + (f'・⚠️ MAX_SYMS={MAX_SYMS} 冒煙測試' if MAX_SYMS > 0 else ''))
    print(f'🧱 V79.4.3 斷崖只剔窗口:當天是斷崖 {acc["cliff_day"]:,} 檔·日(不算漲跌)・250 日窗口有斷崖 {acc["cliff_hl"]:,} 檔·日(不算新高新低)')

    # ── 指標 ──
    rana = {}
    for d in days:
        a, b = adv.get(d, 0), dec.get(d, 0)
        rana[d] = (a - b) / (a + b) * 1000 if (a + b) else 0.0
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

    fwd = make_fwd(tw, tw_dates, tw_idx)
    base = {hz: [x for x in (fwd(d, hz) for d in days) if x is not None] for hz in HORIZONS}
    bmed_all = {hz: statistics.median(base[hz]) for hz in HORIZONS}
    bwin_all = {hz: sum(1 for x in base[hz] if x > 0) / len(base[hz]) * 100 for hz in HORIZONS}
    print('對照組(大盤隨便一天):' + ''.join(f'  {hz}日 中位 {bmed_all[hz]:+.2f}%/勝率 {bwin_all[hz]:.1f}%' for hz in HORIZONS) + f'  (n={len(base[5])})')
    # 🔁 V79.4.3 上面那行只是描述;邊際一律減「那天之前已經實現的」中位數(擴張窗口)
    PB = {hz: past_baseline(days, fwd, tw_idx, hz) for hz in HORIZONS}
    print(f'🔁 V79.4.3 邊際 = 每個訊號日的報酬 − 那天之前已經實現的「隨便一天」中位數(擴張窗口,≥{BASE_MIN} 天才給;'
          f'⛔ 不再減全期中位數 —— 那是用到未來)・基準勝率同理')

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
                ln = line_for(sel, hz, fwd, PB[hz][0], PB[hz][1], 15)
                if ln:
                    print(ln)

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
        ln = line_for(ev, hz, fwd, PB[hz][0], PB[hz][1], 10)
        if ln:
            print(ln)

    print('\n⚠️ 判讀限制(⛔ 別過度解讀):')
    print('  ・交易日之間**高度重疊**(連續幾天位階都很低是同一件事)→ n 不是獨立樣本')
    print('  ・倖存者偏誤:已下市的股票不在 data/ 裡;「家數」的絕對值不能跟官方比')
    print('  ・這是**大盤**層級的結論,⛔ 不可直接套到個股打法(V73.2.1:地板股 300+ 對大盤有邊際,混進個股打法少賺 98 萬)')
    print('  ・未扣交易成本;用的是加權指數(市值加權)不是等權')


# ═══════════ selftest(⛔ 不讀真資料)═══════════
def selftest():
    bad = []

    def ok(name, cond, x=''):
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  → {x}'))
        if not cond:
            bad.append(name)

    import random
    from datetime import date, timedelta

    def mk_dates(n, y0=2012):
        out, d = [], date(y0, 1, 2)
        while len(out) < n:
            if d.weekday() < 5:
                out.append(d.isoformat())
            d += timedelta(days=1)
        return out

    # ① 前視(決定性對照):前 1000 天加權沒有趨勢、後 1000 天每天 +0.2%;訊號(沒有任何預測力)全在前段
    #    → 減「當時已知」的基準 ≈ 0;減全期中位數(舊版)→ 憑空 −2pp(後段多頭被拿來比)
    rnd = random.Random(7)
    dts = mk_dates(2000)
    px, tw = 100.0, {}
    for k, d in enumerate(dts):
        px *= 1 + (0.0 if k < 1000 else 0.002) + (rnd.random() - 0.5) * 0.01
        tw[d] = px
    tw_dates = sorted(tw); tw_idx = {d: i for i, d in enumerate(tw_dates)}
    fwd = make_fwd(tw, tw_dates, tw_idx)
    hz = 20
    bmed, bwin = past_baseline(dts, fwd, tw_idx, hz)
    ev = [dts[k] for k in range(300, 970, 7)]
    rows, drop = edge_rows(ev, hz, fwd, bmed)
    new_edge = statistics.median(ex for _, _, ex in rows)
    allv = [x for x in (fwd(d, hz) for d in dts) if x is not None]
    old_edge = statistics.median(x for _, x, _ in rows) - statistics.median(allv)
    ok(f'① 訊號全在前段、沒有預測力:減當時已知的基準 → 邊際 {new_edge:+.2f}pp ≈ 0(n={len(rows)})', len(rows) > 80 and abs(new_edge) < 0.6, new_edge)
    ok(f'①b 決定性對照:同一批改減全期中位數(舊版)→ 憑空 {old_edge:+.2f}pp', old_edge < -1.0, old_edge)
    # ② 零前視:把第 1200 天以後改成每天再多跌 1%(未來的報酬整段變差),第 1100 天(含)以前的基準一個都不能變;全期中位數會變
    #    (⚠️ 只把後面的價格整段 ×3 沒有鑑別力 —— 報酬是比值,只有跨過那一天的 20 筆會變,中位數根本不動)
    tw2 = dict(tw)
    for k in range(1201, len(dts)):
        tw2[dts[k]] = tw[dts[k]] * 0.99 ** (k - 1200)
    fwd2 = make_fwd(tw2, tw_dates, tw_idx)
    bmed2, bwin2 = past_baseline(dts, fwd2, tw_idx, hz)
    same = all(bmed2.get(d) == bmed.get(d) and bwin2.get(d) == bwin.get(d) for d in dts[:1101])
    allv2 = [x for x in (fwd2(d, hz) for d in dts) if x is not None]
    ok('② 改未來的價格:那天以前的基準一個都不變(全期中位數會跟著變 = 前視)', same and statistics.median(allv2) != statistics.median(allv),
       [statistics.median(allv), statistics.median(allv2)])
    ok(f'②b 已實現 <{BASE_MIN} 天 → 沒有基準(⛔ 不補值):第一個有基準的是第 {dts.index(min(bmed))} 天', dts.index(min(bmed)) == BASE_MIN + hz - 1 and dts[0] not in bmed, min(bmed))
    # ②c 中位數 / 勝率 = 那天之前已實現的那幾個值(手算一天)
    k0 = 500
    real = sorted(x for x in (fwd(dts[j], hz) for j in range(k0 - hz + 1)) if x is not None)
    ok('②c 手算第 500 天的基準 = 前 481 天的報酬中位數 / 勝率', abs(bmed[dts[k0]] - statistics.median(real)) < 1e-12 and abs(bwin[dts[k0]] - sum(1 for x in real if x > 0) / len(real) * 100) < 1e-9,
       [bmed[dts[k0]], statistics.median(real)])

    # ③ 斷崖只剔窗口:一檔一路小漲(天天創新高),第 400 根減資 ×0.5 → 那一天不算漲跌、之後 250 天不算新高新低,之前 / 之後照算
    dts3 = mk_dates(800)
    tw3 = {d: 100.0 for d in dts3}
    rows3, p = [], 50.0
    for k, d in enumerate(dts3):
        p *= 1.001
        if k == 400:
            p *= 0.5
        rows3.append({'date': d.replace('-', '/'), 'open': p, 'close': p})
    acc = new_acc()
    scan_stock(rows3, tw3, acc)
    nh_dates = sorted(acc['nh']); nl_dates = sorted(acc['nl'])
    win_bad = [d for d in nh_dates + nl_dates if dts3[400] <= d <= dts3[400 + LOOK - 1]]
    ok(f'③ 斷崖那一天不算漲跌(當天斷崖 {acc["cliff_day"]})、250 日窗口有斷崖的 {acc["cliff_hl"]} 天不算新高新低(違規 {len(win_bad)})',
       acc['cliff_day'] == 1 and dts3[400] not in acc['dec'] and dts3[400] not in acc['scanned'] and not win_bad and acc['cliff_hl'] == LOOK - 1,
       [acc['cliff_day'], acc['cliff_hl'], len(win_bad)])
    ok('③b 斷崖之前 / 窗口過了之後照算(一路小漲 = 天天創新高、沒有假的新低)',
       dts3[399] in acc['nh'] and dts3[400 + LOOK] in acc['nh'] and not nl_dates and dts3[401] in acc['adv'],
       [dts3[399] in acc['nh'], dts3[400 + LOOK] in acc['nh'], len(nl_dates)])
    # ③c 決定性對照:同一檔沒有斷崖 → 那 250 天全是新高(上面不算是因為斷崖,不是因為別的)
    rows4 = [dict(r) for r in rows3]
    for r in rows4[400:]:
        r['open'] *= 2; r['close'] *= 2
    acc4 = new_acc()
    scan_stock(rows4, tw3, acc4)
    ok(f'③c 決定性對照:同一檔把斷崖補回來 → 那段照樣天天創新高({sum(1 for d in acc4["nh"] if dts3[400] <= d <= dts3[400 + LOOK - 1])} 天)',
       acc4['cliff_day'] == 0 and all(d in acc4['nh'] for d in dts3[400:400 + LOOK]), acc4['cliff_day'])

    print(f'\n{"❌ BREADTH_OSC_SELFTEST_FAIL " + str(len(bad)) + " 條" if bad else "✅ BREADTH_OSC_SELFTEST_PASS"}')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    main()
