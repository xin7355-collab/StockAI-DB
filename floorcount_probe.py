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

🔁 V79.4.3(16 年全市場 d16 重跑前修三件):
  ① 家數門檻改「每 1,000 檔可掃股票」:可掃股票 2011 年約 1,350 檔 → 2026 年約 2,230 檔,
     寫死「100 檔」在 2011 年 = 7.4%、今天 = 4.5%(同一個門檻前後鬆緊差 1.65 倍)。
     門檻用今天的可掃檔數 REF_N 換算成千分比 → 今天的行為不變、早年不再被放水。
     ③ 的「自己近一年位階」也改用千分比(宇宙一年長 3~5%,家數會自己慢慢變多)。
  ② 對照組改「同年份」:地板股是**大盤層級**的事件(同一天全市場一起),同一天的橫斷面對照沒有意義
     → 仍跟「別天」比,但只拿**事件那幾年**的日子,照事件在各年的天數加權(⛔ 不再拿 16 年整段:
     2011~2015 盤整、2020~2026 大多頭,地板股集中在空頭年,整段對照會把「那幾年本來就比較差/好」算成訊號)。
     那一年的對照日少於 MIN_CTRL(30)天 → 那年的事件不算(印出幾筆)。
  ③ 斷崖窗口:20 日均線 / 均量的窗口碰到減資、停牌斷崖(×1.5 / ×0.67,lib_limit.cliff_*)
     → 那一天這檔不算、也不進分母(⛔ 不整檔剔除)。

只讀 data/*.json,不打 API、不寫檔。
跑法:python3 floorcount_probe.py ・DATA_DIR=<d16> python3 floorcount_probe.py
      MAX_SYMS=600(只等距抽 600 檔,冒煙測試用)・python3 floorcount_probe.py --selftest(不需要真資料)
"""
import bisect
import json
import os
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'scripts'))
import lib_limit as LL  # noqa: E402  (scripts/lib_limit.py:斷崖守門跟 JS 版同一組數字)

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('DATA_DIR') or (ROOT / 'data'))   # V78.4.7:可指到修好的資料(🔁 V79.4.3 預設改成 repo 的 data/,不再吃執行目錄)
HORIZONS = (5, 10, 20)
MIN_BARS = 260          # 要夠長才算得出「自己的歷史分布」(同 _detectFloorBounce)
PCTL = 5                # 乖離落在自己歷史最低 5%
VOL_X = 2.0             # 他說的「20 日均量兩倍」
MIN_SCAN = 500          # 一天至少掃到幾檔才算那一天(樣本守門)
# 🔁 V79.4.3 今天(2026-10)的可掃檔數(實測 2,201~2,246)—— 舊門檻(檔)÷ REF_N × 1000 = 千分比門檻
REF_N = 2200
MIN_CTRL = 30           # 🔁 V79.4.3 同年份對照組至少幾天,不夠那年的事件就不算
ZERO = 1e-9             # 「0 檔」那一桶:千分比 < ZERO
INF = float('inf')
MAX_SYMS = int(os.environ.get('MAX_SYMS') or 0)   # 🔁 V79.4.3 冒煙測試用:等距抽 N 檔(⛔ 不取前 N 檔)


def per_k(n):
    """🔁 V79.4.3 今天 REF_N 檔時的 n 檔 → 每 1,000 檔可掃股票的千分比門檻"""
    return n * 1000.0 / REF_N


def rate(counts, scanned, d):
    """🔁 V79.4.3 那一天每 1,000 檔可掃股票裡有幾檔(‰);分母 = 那天真的能判斷的檔數"""
    s = scanned.get(d, 0)
    return counts.get(d, 0) * 1000.0 / s if s > 0 else 0.0


def bucket_days(counts, scanned, days, lo, hi):
    """千分比落在 [lo, hi) 的交易日"""
    return [d for d in days if lo <= rate(counts, scanned, d) < hi]


def load_tw(data_dir):
    tw = {}
    for r in json.loads((Path(data_dir) / '^TWII.json').read_text()):
        try:
            c = float(r['close'])
            if c > 0:
                tw[r['date'].replace('/', '-')] = c
        except Exception:
            continue
    return tw


def make_fwd(tw):
    tw_dates = sorted(tw)
    tw_idx = {d: i for i, d in enumerate(tw_dates)}

    def fwd(d0, hz):
        """加權指數後 hz 個交易日的報酬(%)"""
        i = tw_idx.get(d0)
        if i is None or i + hz >= len(tw_dates):
            return None
        return (tw[tw_dates[i + hz]] / tw[d0] - 1) * 100
    return fwd


def pick_files(data_dir, max_syms=0):
    files = sorted(Path(data_dir).glob('[0-9][0-9][0-9][0-9].json'))
    n_all = len(files)
    if max_syms and n_all > max_syms:   # 等距抽樣:代號排序取前 N 會偏某幾個產業
        files = [files[int(k * n_all / max_syms)] for k in range(max_syms)]
    return files, n_all


# ─────────────────────────────────────────────────────────────
# 逐檔算出「這一天是不是地板股」,累加成每日家數
# ─────────────────────────────────────────────────────────────
def scan(data_dir, tw, max_syms=0):
    floor_big = {}      # 日期 → 有量地板股家數
    floor_any = {}      # 日期 → 不看量的地板股家數
    scanned = {}        # 日期 → 當天真的能判斷的股票數(當分母,避免早期樣本少導致家數天生偏低)
    n_files = n_used = n_cliff = 0
    files, n_all = pick_files(data_dir, max_syms)
    for f in files:
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
                o = float(r.get('open') or 0)
                if c > 0:
                    ser.append((d, c, v, o))
            except Exception:
                continue
        if len(ser) < MIN_BARS:
            continue
        n_used += 1
        n = len(ser)
        closes = [x[1] for x in ser]
        # 🔁 V79.4.3 斷崖(收盤或開盤 vs 前收 ×1.5 / ×0.67)前綴和 —— 只剔碰到的窗口,⛔ 不整檔剔除
        cpre = LL.cliff_prefix(closes, [x[3] for x in ser])

        # 逐日 20MA 乖離
        bias = [None] * n
        cliff = [False] * n
        run = sum(closes[:20])
        for i in range(19, n):
            if i > 19:
                run += closes[i] - closes[i - 20]
            # 🔁 V79.4.3 均線(i-19..i)與均量(i-20..i)的窗口碰到斷崖 → 這天乖離 / 量比都是假的,不算
            if LL.cliff_in(cpre, i - 20, i):
                cliff[i] = True
                continue
            m = run / 20
            if m > 0:
                bias[i] = (closes[i] - m) / m * 100

        hist = []   # 這檔自己的歷史分布(用到今天為止的全部,⛔ 不看未來)—— 保持排序,bisect 數「比今天低」的有幾個
        for i in range(n):
            b = bias[i]
            if b is not None:
                bisect.insort(hist, b)
            if i < MIN_BARS - 1:
                continue
            d0 = ser[i][0]
            if d0 not in tw:
                continue
            if b is None:
                if cliff[i]:
                    n_cliff += 1
                continue                 # 🔁 V79.4.3 判斷不了的那天也不進分母(以前這裡不會發生)
            if len(hist) < 200:
                continue
            scanned[d0] = scanned.get(d0, 0) + 1
            below = bisect.bisect_left(hist, b)
            if below / len(hist) * 100 > PCTL:
                continue
            floor_any[d0] = floor_any.get(d0, 0) + 1
            vs = [x[2] for x in ser[max(0, i - 20):i] if x[2] > 0]
            if len(vs) >= 10:
                vma = sum(vs) / len(vs)
                if vma > 0 and ser[i][2] / vma >= VOL_X:
                    floor_big[d0] = floor_big.get(d0, 0) + 1
    info = {'n_files': n_files, 'n_used': n_used, 'n_cliff': n_cliff, 'n_all': n_all}
    return floor_big, floor_any, scanned, info


# ─────────────────────────────────────────────────────────────
# 🔁 V79.4.3 同年份對照:事件那幾年的所有交易日,照事件在各年的天數加權
# ─────────────────────────────────────────────────────────────
def ctrl_by_year(days, fwd):
    """{hz: {年: [那年每一天的 hz 日報酬]}}"""
    out = {hz: {} for hz in HORIZONS}
    for d in days:
        for hz in HORIZONS:
            r = fwd(d, hz)
            if r is not None:
                out[hz].setdefault(d[:4], []).append(r)
    return out


def wmedian(pts):
    """加權中位數;權重都一樣時 = statistics.median"""
    pts = sorted(pts)
    tot = sum(w for _, w in pts)
    half, acc = tot / 2, 0.0
    for k, (x, w) in enumerate(pts):
        acc += w
        if abs(acc - half) <= 1e-12 * max(1.0, tot):
            return (x + pts[k + 1][0]) / 2 if k + 1 < len(pts) else x
        if acc > half:
            return x
    return pts[-1][0]


def matched(sel, fwd, hz, base_y):
    """事件日 sel 的 hz 日報酬 + 同年份對照的(中位, 勝率%)+ 因那年對照日 < MIN_CTRL 丟掉幾筆"""
    ev, k_y, dropped = [], Counter(), 0
    for d in sel:
        r = fwd(d, hz)
        if r is None:
            continue
        y = d[:4]
        if len(base_y.get(y, ())) < MIN_CTRL:
            dropped += 1
            continue
        ev.append(r)
        k_y[y] += 1
    if not ev:
        return ev, None, None, dropped
    pts = [(x, k / len(base_y[y])) for y, k in k_y.items() for x in base_y[y]]
    tot = sum(w for _, w in pts)
    win = sum(w for x, w in pts if x > 0) / tot * 100
    return ev, wmedian(pts), win, dropped


def _bucket_line(sel, fwd, base_y):
    for hz in HORIZONS:
        e, cmed, cwin, drop = matched(sel, fwd, hz, base_y[hz])
        if len(e) < 15:
            continue
        edge = statistics.median(e) - cmed
        w = sum(1 for x in e if x > 0) / len(e) * 100
        print(f'     {hz:>3} 日:中位 {statistics.median(e):+6.2f}%(邊際 {edge:+5.2f}pp)'
              f'・勝率 {w:5.1f}%(基準 {cwin:4.1f}%)・n={len(e)}'
              + (f'(⚠️ 同年份對照日 < {MIN_CTRL} 天 → 丟掉 {drop} 筆)' if drop else ''))


def _rng(lo, hi):
    if hi <= ZERO:
        return '0‰'
    if hi == INF:
        return f'≥{lo:.1f}‰'
    return f'{">0" if lo == ZERO else f"{lo:.1f}"}~{hi:.1f}‰'


def report(title, counts, scanned, days, buckets, fwd, base_y):
    print(f'\n{"═" * 68}\n{title}\n{"═" * 68}')
    vals = [counts.get(d, 0) for d in days]
    print(f'  家數分布:中位 {statistics.median(vals):.0f} ・ P90 {sorted(vals)[int(len(vals)*0.9)]:.0f} '
          f'・ 最大 {max(vals)} ・ 為 0 的天數 {sum(1 for v in vals if v == 0)}')
    rv = sorted(rate(counts, scanned, d) for d in days)
    print(f'  🔁 每 1,000 檔可掃股票:中位 {statistics.median(rv):.1f}‰ ・ P90 {rv[int(len(rv)*0.9)]:.1f}‰ '
          f'・ 最大 {rv[-1]:.1f}‰(下面分桶照千分比;檔數是「今天 {REF_N:,} 檔時」的換算)')
    print('  對照組(大盤隨便一天,整段):', end='')
    for hz in HORIZONS:
        b = [x for x in (fwd(d, hz) for d in days) if x is not None]
        print(f'  {hz}日 中位 {statistics.median(b):+.2f}%/勝率 {sum(1 for x in b if x>0)/len(b)*100:.1f}%', end='')
    print(f'  (n={sum(1 for d in days if fwd(d, HORIZONS[0]) is not None)})')
    print(f'  🔁 下面每一桶的「邊際 / 基準」= 跟**同年份**的交易日比(照事件在各年的天數加權),⛔ 不再跟 16 年整段比')
    for lo, hi, name in buckets:
        sel = bucket_days(counts, scanned, days, lo, hi)
        label = f'{name}【{_rng(lo, hi)}】'
        if len(sel) < 15:
            print(f'\n  ■ {label}:樣本不足(n={len(sel)})')
            continue
        print(f'\n  ■ {label}  (n={len(sel)} 個交易日)')
        _bucket_line(sel, fwd, base_y)


def main():
    tw = load_tw(DATA)
    fwd = make_fwd(tw)
    floor_big, floor_any, scanned, info = scan(DATA, tw, MAX_SYMS)
    sampled = info['n_files'] < info['n_all']
    print(f'掃 {info["n_files"]} 檔,可用 {info["n_used"]} 檔(≥{MIN_BARS} 根K)'
          + (f'【⚠️ MAX_SYMS 等距抽樣 {info["n_files"]}/{info["n_all"]} 檔,只給冒煙測試用】' if sampled else ''))
    print(f'🧱 斷崖窗口(均線 / 均量碰到 ×1.5 / ×0.67 的跳空)剔除 {info["n_cliff"]:,} 個(股·日)—— ⛔ 不整檔剔除')
    min_scan = MIN_SCAN if not sampled else max(50, round(MIN_SCAN * info['n_files'] / info['n_all']))
    days = sorted(d for d in scanned if scanned[d] >= min_scan)
    if not days:
        print(f'❌ 空過守門:沒有任何一天掃到 ≥{min_scan} 檔')
        sys.exit(1)
    print(f'可用交易日 {len(days)} 天({days[0]} ~ {days[-1]}),每天平均掃到 '
          f'{int(statistics.mean(scanned[d] for d in days)):,} 檔\n')
    base_y = ctrl_by_year(days, fwd)

    report('① 有量地板股(量 ≥ 20日均量×2)—— 他說的正版定義',
           floor_big, scanned, days,
           [(0, ZERO, '0 檔(完全沒有)'), (ZERO, per_k(10), '1~9 檔'), (per_k(10), per_k(30), '10~29 檔'),
            (per_k(30), per_k(60), '30~59 檔'), (per_k(60), per_k(100), '60~99 檔'),
            (per_k(100), INF, '⭐ 100 檔以上(他說的短線低點)')], fwd, base_y)

    report('② 不看量的地板股(只看極端負乖離)—— 用來檢驗「量」有沒有加分',
           floor_any, scanned, days,
           [(0, per_k(10), '0~9 檔'), (per_k(10), per_k(50), '10~49 檔'), (per_k(50), per_k(150), '50~149 檔'),
            (per_k(150), per_k(300), '150~299 檔'), (per_k(300), INF, '300 檔以上')], fwd, base_y)

    # ③ 相對自己的歷史位階(⛔ 不用寫死門檻 —— 同 V71.1.6 外資期貨的教訓)
    print(f'\n{"═" * 68}\n③ 改用「家數在自己近一年的位階」(⛔ 不寫死絕對門檻;🔁 V79.4.3 用千分比排位階)\n{"═" * 68}')
    pct_bucket = {}
    for k, d in enumerate(days):
        win = [rate(floor_big, scanned, x) for x in days[max(0, k - 240):k + 1]]
        if len(win) < 120:
            continue
        cur = rate(floor_big, scanned, d)
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
        _bucket_line(sel, fwd, base_y)

    print('\n⚠️ 判讀限制(⛔ 別過度解讀):')
    print('  ・窗口受 ^TWII 長度限制(V74.2.8 起約 5 年、已含 2022 空頭;d16 從 2011 起),但大跌樣本本來就少')
    print('  ・交易日之間**高度重疊**(連續幾天都算低點是同一件事)→ n 不是獨立樣本,勝率要保守看')
    print('  ・倖存者偏誤:data/ 沒有已下市的股票(d16 有)')
    print('  ・未扣交易成本(來回約 0.44%)')


# ─────────────────────────────────────────────────────────────
# selftest(不需要真資料;每一條都有決定性對照)
# ─────────────────────────────────────────────────────────────
def _weekdays(y0, y1):
    import datetime as dt
    d, out = dt.date(y0, 1, 1), []
    while d <= dt.date(y1, 12, 31):
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def selftest():
    import shutil
    import tempfile
    bad = []

    def ok(name, c, x=''):
        print(f"  {'✅' if c else '❌'} {name}{'' if c else ' ・' + str(x)[:240]}")
        if not c:
            bad.append(name)

    ok('⓪ DATA_DIR 沒設 → repo 的 data/', bool(os.environ.get('DATA_DIR')) or DATA == ROOT / 'data', DATA)

    # ① 宇宙變大一倍:兩個時期都是 5% 的股票到地板 → 千分比門檻觸發次數一樣;寫死「100 檔」只在大宇宙那段觸發
    days = _weekdays(2012, 2021)
    counts, scanned = {}, {}
    for k, d in enumerate(days):
        uni = 1000 if d < '2017-01-01' else 2000
        scanned[d] = uni
        counts[d] = uni // 20 if k % 50 == 0 else uni // 250       # 崩盤日 5%、平常 0.4%
    top = bucket_days(counts, scanned, days, per_k(100), INF)
    a = [d for d in top if d < '2017-01-01']
    b = [d for d in top if d >= '2017-01-01']
    ok('① 宇宙 1,000 → 2,000 檔、同樣 5% 到地板:「≥100 檔(今天換算)」那一桶兩段觸發次數一樣',
       len(a) > 20 and len(a) == len([d for k, d in enumerate(days) if k % 50 == 0 and d < '2017-01-01'])
       and abs(len(a) - len(b)) <= 1, (len(a), len(b)))
    low = bucket_days(counts, scanned, days, ZERO, per_k(10))
    ok('① 平常日 0.4%(1,000 檔時 4 檔、2,000 檔時 8 檔)都落在「1~9 檔」那一桶',
       len([d for d in low if d < '2017-01-01']) > 1000 and len([d for d in low if d >= '2017-01-01']) > 1000,
       (len(low),))
    old_a = sum(1 for d in days if d < '2017-01-01' and counts[d] >= 100)
    old_b = sum(1 for d in days if d >= '2017-01-01' and counts[d] >= 100)
    ok('① 決定性對照:寫死「≥100 檔」→ 小宇宙那段 0 次、大宇宙那段 26 次(舊版 2011 年被系統性放水 / 收緊)',
       old_a == 0 and old_b > 20, (old_a, old_b))

    # ② 同年份對照:2012~2014 加權每天 +0.2%、2015~2017 每天 −0.3%;事件只出現在前三年、沒有任何優勢
    tw = {}
    p = 8000.0
    for d in _weekdays(2012, 2017):
        p *= 1.002 if d < '2015-01-01' else 0.997
        tw[d] = p
    for d in _weekdays(2018, 2018)[40:50]:           # 2018 只有 10 天(對照日 < 30 → 那年的事件要丟掉)
        tw[d] = p
    fwd = make_fwd(tw)
    days2 = sorted(tw)
    base_y = ctrl_by_year(days2, fwd)
    sel = [d for k, d in enumerate(days2) if d < '2015-01-01' and k % 10 == 3]
    e, cmed, cwin, drop = matched(sel, fwd, 5, base_y[5])
    edge = statistics.median(e) - cmed
    ok('② 事件只在多頭那三年、跟同年的日子一模一樣 → 同年份對照邊際 ≈ 0', abs(edge) < 0.05 and drop == 0, (edge, drop))
    whole = [x for x in (fwd(d, 5) for d in days2) if x is not None]
    old_edge = statistics.median(e) - statistics.median(whole)
    ok('② 決定性對照:整段對照(舊版)→ 憑空 > +0.5pp(舊版 16 年就會這樣歪)', old_edge > 0.5, old_edge)
    ok('② 同年份對照的勝率 = 那三年的勝率(~100%),⛔ 不是整段的 ~50%', cwin is not None and cwin > 95, cwin)
    y18 = [d for d in days2 if d.startswith('2018')][0]
    _, _, _, drop2 = matched(sel + [y18], fwd, 5, base_y[5])
    ok(f'② 那一年對照日 < {MIN_CTRL} 天 → 那年的事件不算(丟掉 1 筆)', drop2 == 1, drop2)

    # ③ 斷崖窗口:1102 在第 700 根減資 / 分割(×0.6、量 ×3)→ 那 20 天不算、也不進分母;窗口外照算
    tmp = tempfile.mkdtemp(prefix='floor-')
    try:
        ds = _weekdays(2012, 2016)[:1100]
        twj = [{'date': d.replace('-', '/'), 'open': 100, 'high': 100, 'low': 100, 'close': 100, 'volume': 0} for d in ds]

        def mk(cut=False):
            import math
            rows = []
            for k, d in enumerate(ds):
                c = 50 * (1 + 0.03 * math.sin(k / 6.3))
                v = 1000.0
                if cut and k >= 700:
                    c *= 0.6
                    v *= 3
                rows.append({'date': d.replace('-', '/'), 'open': round(c, 4), 'high': round(c * 1.01, 4),
                             'low': round(c * 0.99, 4), 'close': round(c, 4), 'volume': v})
            return rows
        dir_a, dir_b = Path(tmp) / 'a', Path(tmp) / 'b'
        for dd in (dir_a, dir_b):
            dd.mkdir()
            (dd / '^TWII.json').write_text(json.dumps(twj))
            (dd / '1101.json').write_text(json.dumps(mk()))
            (dd / '1103.json').write_text(json.dumps(mk()))
        (dir_b / '1102.json').write_text(json.dumps(mk(cut=True)))
        twa = load_tw(dir_a)
        fa, aa, sa, _ = scan(dir_a, twa)
        fb, ab, sb, ib = scan(dir_b, twa)
        d700, d710, d760 = ds[700], ds[710], ds[760]
        ok('③ 斷崖那天(×0.6、量 ×3)⛔ 不可被算成地板股(有量 / 不看量都一樣)',
           fb.get(d700, 0) == fa.get(d700, 0) and ab.get(d700, 0) == aa.get(d700, 0),
           (fb.get(d700, 0), fa.get(d700, 0), ab.get(d700, 0), aa.get(d700, 0)))
        ok('③ 斷崖窗口裡那幾天也不進分母', sb.get(d700, 0) - sa.get(d700, 0) == 0 and sb.get(d710, 0) - sa.get(d710, 0) == 0,
           (sb.get(d700), sa.get(d700)))
        ok('③ 窗口外照算(⛔ 不整檔剔除)', sb.get(d760, 0) - sa.get(d760, 0) == 1, (sb.get(d760), sa.get(d760)))
        ok('③ 剔除筆數 = 20 天(第 700~719 根)', ib['n_cliff'] == 20, ib['n_cliff'])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{'❌ 失敗:' + ', '.join(bad) if bad else '✅ selftest 全過'}")
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    main()
