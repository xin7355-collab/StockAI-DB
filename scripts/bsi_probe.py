#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌡️ bsi_probe.py —— 景氣燈號 / 領先指標能不能「早知道大盤」?(V80.1.7,計畫 B5)

使用者(2026-11-01):「早知道先機,贏多一點少輸一點」。台股最常聽到的一句:「藍燈買股票、紅燈數鈔票」。
基金平台的統計說紅燈之後一年平均還漲,也有文章說燈號本身落後股市 → 本站自己量。

資料(都在手上,⛔ 新採礦):
  ① 國發會 6099「景氣指標與燈號.csv」(1982-01 起,每月):綜合分數、燈號、領先 / 同時指標(不含趨勢)
     → 另一個工作階段(V80.1.6)已抓到 trade_deep 分支 raw/6099_1.bin.gz(ZIP)
  ② 加權**報酬指數**(含息):data/idx_long_early.json(2003 起)+ data/idx_long.json(2010 起)接起來

⛔ 兩個一定要講的限制(寫進結論):
  ① 公布有時間差 —— 第 M 月的燈號約在 M+1 月 27 日公布 → 一律從「M+1 月 28 日起第一個交易日收盤」才算知道
     (另跑一版「M+2 月第一個交易日」當保守對照)。⛔ 用月底當天 = 偷看一個月。
  ② 檔案是**修正後**的數字:分數偶爾修 1~2 分、領先指標每個月都會重算趨勢(轉折點會移)→ 結果是「樂觀上限」。

量什麼:
  A. 燈號 / 分數分組 → 之後 1 / 3 / 6 / 12 個月報酬,比「每個月都算」的平均(Newey-West t,重疊窗口)
  B. 轉折事件:第一次轉藍 / 第一次轉紅 / 領先指標連 3 個月跌後轉升 / 連 3 個月升後轉跌 → 每一次都列出來
  C. 拿來進出(現金 0 利率,保守):紅燈換現金 / 分數 ≥X 換現金 / 領先指標下降換現金 vs 一直抱著;
     起點挪 12 個月各跑一次,數贏幾次;門檻挪動看是不是高原

跑法:BSI_ZIP=6099.zip IDX_LONG=idx_long.json IDX_EARLY=idx_long_early.json python3 scripts/bsi_probe.py
      python3 scripts/bsi_probe.py --selftest
"""
import csv
import io
import json
import math
import os
import sys
import zipfile
from datetime import date

LIGHTS = {'藍': 'blue', '黃藍': 'yellow-blue', '綠': 'green', '黃紅': 'yellow-red', '紅': 'red'}
HZ = (21, 63, 126, 252)                 # 1 / 3 / 6 / 12 個月(交易日)
HZ_M = {21: 1, 63: 3, 126: 6, 252: 12}


# ───────────────────────── 讀資料 ─────────────────────────
def zip_csv(zb, want='景氣指標與燈號.csv'):
    z = zipfile.ZipFile(io.BytesIO(zb))
    for i in z.infolist():
        nm = i.filename if (i.flag_bits & 0x800) else i.filename.encode('cp437').decode('big5', 'replace')
        if nm == want:
            b = z.read(i)
            for enc in ('utf-8-sig', 'big5', 'cp950'):
                try:
                    return b.decode(enc)
                except UnicodeDecodeError:
                    pass
    return None


def parse_bsi(text):
    """→ [{'m': 'YYYY-MM', 'score': int|None, 'light': str|None, 'lead': float|None, 'coin': float|None}](照月份排)。
    ⛔ 欄位只認名字(不靠位置)。"""
    rd = csv.DictReader(io.StringIO(text))
    out = []
    for r in rd:
        m = str(r.get('Date') or '').strip()
        if len(m) != 6 or not m.isdigit():
            continue
        ym = f'{m[:4]}-{m[4:]}'

        def num(k):
            try:
                return float(str(r.get(k) or '').replace(',', ''))
            except ValueError:
                return None
        sc = num('景氣對策信號綜合分數')
        lt = LIGHTS.get(str(r.get('景氣對策信號') or '').strip())
        out.append({'m': ym, 'score': int(sc) if sc is not None else None, 'light': lt,
                    'lead': num('領先指標不含趨勢指數'), 'coin': num('同時指標不含趨勢指數'),
                    'leadc': num('領先指標綜合指數')})
    return sorted(out, key=lambda x: x['m'])


def splice_tr(early, late):
    """兩段報酬指數接起來:early 只取 late 第一天以前的列,照重疊那天的比例縮放(⛔ 兩段水位不同直接接 = 假跳空)。"""
    late = [(d.replace('/', '-'), float(v)) for d, v in late]
    early = [(d.replace('/', '-'), float(v)) for d, v in early]
    if not late:
        return early
    d0 = late[0][0]
    ov = dict(early)
    k = late[0][1] / ov[d0] if d0 in ov and ov[d0] else None
    if k is None:
        return late
    return [(d, v * k) for d, v in early if d < d0] + late


# ───────────────────────── 純函式 ─────────────────────────
def decision_idx(dates, ym, mode='pub'):
    """第 ym 月的燈號「什麼時候才知道」→ 那一天在交易日序列的索引(收盤時已知)。
    pub:M+1 月 28 日起第一個交易日;late:M+2 月第一個交易日(保守)。"""
    y, m = int(ym[:4]), int(ym[5:7])
    if mode == 'pub':
        y1, m1 = (y + 1, 1) if m == 12 else (y, m + 1)
        target = f'{y1:04d}-{m1:02d}-28'
    else:
        y2, m2 = (y + (m + 2 - 1) // 12, (m + 2 - 1) % 12 + 1)
        target = f'{y2:04d}-{m2:02d}-01'
    import bisect
    i = bisect.bisect_left(dates, target)
    return i if i < len(dates) else None


def fwd(vals, i, h):
    return (vals[i + h] / vals[i] - 1) * 100 if i is not None and i + h < len(vals) else None


def mean(a):
    return sum(a) / len(a) if a else float('nan')


def nw_t(x, lag):
    """Newey-West t(平均是不是 ≠ 0;重疊窗口要用這個,⛔ 用一般 t 會高估)。"""
    n = len(x)
    if n < 5:
        return float('nan')
    m = mean(x)
    e = [v - m for v in x]
    g0 = sum(v * v for v in e) / n
    s = g0
    for L in range(1, min(lag, n - 1) + 1):
        w = 1 - L / (lag + 1)
        gl = sum(e[t] * e[t - L] for t in range(L, n)) / n
        s += 2 * w * gl
    return m / math.sqrt(s / n) if s > 0 else float('nan')


def runs_first(rows, pred):
    """第一次成立的月份(上一個月不成立、這個月成立)。"""
    out, prev = [], False
    for r in rows:
        cur = bool(pred(r))
        if cur and not prev:
            out.append(r['m'])
        prev = cur
    return out


def lead_turns(rows, k=3):
    """領先指標(不含趨勢)連 k 個月跌之後轉升 = up;連 k 個月升之後轉跌 = down。回 {'up': [月份], 'down': [月份]}。"""
    ch = []
    for a, b in zip(rows, rows[1:]):
        if a['lead'] is not None and b['lead'] is not None:
            ch.append((b['m'], b['lead'] - a['lead']))
    up, dn = [], []
    for i in range(k, len(ch)):
        prev = [c for _, c in ch[i - k:i]]
        if all(c < 0 for c in prev) and ch[i][1] > 0:
            up.append(ch[i][0])
        if all(c > 0 for c in prev) and ch[i][1] < 0:
            dn.append(ch[i][0])
    return {'up': up, 'down': dn}


def timing(dates, vals, rows, out_pred, mode='pub', start=None):
    """月度進出:每個月燈號公布那天決定下個月在場 / 現金(現金 0 利率)。回 (倍數, 最大回撤%, 在場比例, 換手次數)。
    out_pred(r) True = 那個月公布後換現金。⛔ 公布前照上一個決定。"""
    sched = []
    for r in rows:
        i = decision_idx(dates, r['m'], mode)
        if i is not None and (start is None or dates[i] >= start):
            sched.append((i, not out_pred(r)))
    if not sched:
        return None
    sched.sort()
    i0 = sched[0][0]
    pos, k, eq, peak, mdd, inmk, sw, last = None, 0, 1.0, 1.0, 0.0, 0, 0, None
    for t in range(i0, len(vals) - 1):
        while k < len(sched) and sched[k][0] <= t:
            new = sched[k][1]
            if last is not None and new != last:
                sw += 1
            pos, last = new, new
            k += 1
        if pos:
            eq *= vals[t + 1] / vals[t]
            inmk += 1
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    n = len(vals) - 1 - i0
    return eq, mdd * 100, inmk / n if n else 0, sw


def buyhold(dates, vals, start_i):
    eq, peak, mdd = 1.0, 1.0, 0.0
    for t in range(start_i, len(vals) - 1):
        eq *= vals[t + 1] / vals[t]
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    return eq, mdd * 100


# ───────────────────────── 主程式 ─────────────────────────
def main():
    zb = open(os.environ.get('BSI_ZIP') or '6099.zip', 'rb').read()
    rows = parse_bsi(zip_csv(zb) or '')
    late = json.load(open(os.environ.get('IDX_LONG') or 'idx_long.json', encoding='utf-8'))['twii_tr']
    early = json.load(open(os.environ.get('IDX_EARLY') or 'idx_long_early.json', encoding='utf-8'))['twii_tr']
    tr = splice_tr(early, late)
    dates, vals = [d for d, _ in tr], [v for _, v in tr]
    rows = [r for r in rows if r['m'] >= '2002-10' and r['score'] is not None]
    print(f'🌡️ 燈號 {rows[0]["m"]} ~ {rows[-1]["m"]}({len(rows)} 個月)・報酬指數 {dates[0]} ~ {dates[-1]}', flush=True)
    res = {'from': rows[0]['m'], 'to': rows[-1]['m'], 'tr': [dates[0], dates[-1]]}
    for mode in ('pub', 'late'):
        allv = {h: [] for h in HZ}
        by = {}
        for r in rows:
            i = decision_idx(dates, r['m'], mode)
            for h in HZ:
                v = fwd(vals, i, h)
                if v is not None:
                    allv[h].append(v)
                    by.setdefault(r['light'], {}).setdefault(h, []).append(v)
        print(f'\n=== A. 燈號 → 之後報酬(含息,{"M+1 月 28 日起" if mode == "pub" else "M+2 月初(保守)"}) ===', flush=True)
        print('   全部月份  ' + '  '.join(f'{HZ_M[h]}月 {mean(allv[h]):+.2f}%' for h in HZ), flush=True)
        tab = {}
        for lt in ('blue', 'yellow-blue', 'green', 'yellow-red', 'red'):
            d = by.get(lt) or {}
            cells, tab[lt] = [], {}
            for h in HZ:
                v = d.get(h) or []
                diff = [x - mean(allv[h]) for x in v]
                t = nw_t(diff, HZ_M[h]) if v else float('nan')
                tab[lt][h] = {'n': len(v), 'm': mean(v), 'vs_all': mean(v) - mean(allv[h]), 't_nw': t}
                cells.append(f'{HZ_M[h]}月 {mean(v):+.2f}%(差 {mean(v) - mean(allv[h]):+.2f}, t {t:.1f})')
            print(f'   {lt:<11} n={len(d.get(21) or [])}  ' + '  '.join(cells), flush=True)
        res[f'A_{mode}'] = tab
    print('\n=== B. 轉折事件(每一次都列,之後 6 / 12 個月,M+1 月 28 日起) ===', flush=True)
    ev = {'first_blue': runs_first(rows, lambda r: r['light'] == 'blue'),
          'first_red': runs_first(rows, lambda r: r['light'] == 'red'),
          'first_cold22': runs_first(rows, lambda r: r['score'] <= 22),
          'first_hot32': runs_first(rows, lambda r: r['score'] >= 32)}
    ev.update({f'lead_{k}': v for k, v in lead_turns(rows).items()})
    res['B'] = {}
    for k, ms in ev.items():
        lst = []
        for m in ms:
            i = decision_idx(dates, m, 'pub')
            lst.append((m, fwd(vals, i, 126), fwd(vals, i, 252)))
        v6 = [x[1] for x in lst if x[1] is not None]
        v12 = [x[2] for x in lst if x[2] is not None]
        res['B'][k] = {'n': len(lst), 'm6': mean(v6), 'm12': mean(v12), 'pos12': sum(1 for x in v12 if x > 0), 'ev': lst}
        print(f'   {k:<13} {len(lst):>2} 次 ・6 個月 {mean(v6):+.1f}% ・12 個月 {mean(v12):+.1f}%(正 {sum(1 for x in v12 if x > 0)}/{len(v12)})'
              f'   ' + ' '.join(f'{m}:{(x2 if x2 is not None else float("nan")):+.0f}' for m, _, x2 in lst), flush=True)
    print('\n=== C. 拿來進出(現金 0 利率)vs 一直抱著:起點挪 12 個月 ===', flush=True)
    starts = [f'{y}-{m:02d}-01' for y in (2003, 2004) for m in range(1, 13)][2:14]
    rules = {'紅燈換現金': lambda r: r['light'] == 'red'}
    for th in (30, 32, 34, 36, 38):
        rules[f'分數≥{th}換現金'] = (lambda t: (lambda r: r['score'] >= t))(th)
    for th in (16, 19, 22):
        rules[f'分數≤{th}換現金(順勢)'] = (lambda t: (lambda r: r['score'] <= t))(th)
    def chg_of(key):
        d = {}
        for a, b in zip(rows, rows[1:]):
            if a.get(key) is not None and b.get(key) is not None:
                d[b['m']] = b[key] - a[key]
        return d
    ch_lead, ch_leadc, ch_coin = chg_of('lead'), chg_of('leadc'), chg_of('coin')
    rules['領先指標下降換現金'] = lambda r: (ch_lead.get(r['m']) or 0) < 0
    # ⚠️ 不含趨勢的領先指標每個月都會用「之後的資料」重算趨勢 → 用修正後的數字回測 = 偷看。三個對照:
    rules['領先指標下降換現金(M+2 月初才知道)'] = ('late', lambda r: (ch_lead.get(r['m']) or 0) < 0)
    rules['領先綜合指數(含趨勢,修正少)下降換現金'] = lambda r: (ch_leadc.get(r['m']) or 0) < 0
    rules['同時指標下降換現金(安慰劑:它本來不該領先)'] = lambda r: (ch_coin.get(r['m']) or 0) < 0
    res['C'] = {}
    for name, pred in rules.items():
        mode = 'pub'
        if isinstance(pred, tuple):
            mode, pred = pred
        win, rel, dd_s, dd_b, inm = 0, [], [], [], []
        for st in starts + [f'2010-{m:02d}-01' for m in range(1, 13)]:
            r_ = timing(dates, vals, rows, pred, mode, st)
            import bisect
            bi = bisect.bisect_left(dates, st)
            b_ = buyhold(dates, vals, max(bi, 0))
            if not r_:
                continue
            win += r_[0] > b_[0]
            rel.append(r_[0] / b_[0])
            dd_s.append(r_[1])
            dd_b.append(b_[1])
            inm.append(r_[2])
        res['C'][name] = {'win': [win, len(rel)], 'rel_med': sorted(rel)[len(rel) // 2] if rel else None, 'mode': mode,
                          'mdd': mean(dd_s), 'mdd_bh': mean(dd_b), 'in_mkt': mean(inm)}
        print(f'   {name:<16} 贏一直抱著 {win}/{len(rel)} ・倍數比(中位){res["C"][name]["rel_med"]:.2f} ・'
              f'中途最多賠 {mean(dd_s):.1f}%(抱著 {mean(dd_b):.1f}%)・在場 {mean(inm) * 100:.0f}%', flush=True)
    out = os.environ.get('OUT')
    if out:
        json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
    return 0


def selftest():
    import random
    bad = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            bad.append(n)
    txt = ('"Date","領先指標綜合指數","領先指標不含趨勢指數","同時指標綜合指數","同時指標不含趨勢指數","落後指標綜合指數","落後指標不含趨勢指數","景氣對策信號綜合分數","景氣對策信號"\n'
           '198201,12.2,100.3,13.1,107.1,13.0,106.9,-,-\n202608,140.4,104.1,141.9,105.2,141.5,104.9,40,紅\n202609,143.2,104.7,143.9,105.2,144.9,105.9,16,藍\n')
    r = parse_bsi(txt)
    ok('① 欄位照名字讀、早期「-」→ None、燈號中文 → 英文', r[0]['score'] is None and r[1] == {'m': '2026-08', 'score': 40, 'light': 'red', 'lead': 104.1, 'coin': 105.2, 'leadc': 140.4}
       and r[2]['light'] == 'blue', r)
    ok('② 接報酬指數:照重疊那天縮放(⛔ 假跳空)', splice_tr([('2009/12/31', 50.0), ('2010/01/04', 51.0)], [('2010/01/04', 102.0), ('2010/01/05', 103.0)])
       == [('2009-12-31', 100.0), ('2010-01-04', 102.0), ('2010-01-05', 103.0)])
    dates = []
    import datetime as dt
    d = dt.date(2003, 1, 1)
    while d < dt.date(2016, 1, 1):
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d += dt.timedelta(days=1)
    i = decision_idx(dates, '2010-05')
    ok('③ 5 月的燈號 6 月 28 日起才算知道(⛔ 月底當天)', dates[i] >= '2010-06-28' and dates[i - 1] < '2010-06-28', dates[i])
    j = decision_idx(dates, '2010-12', 'late')
    ok('③ 保守版:M+2 月第一個交易日(12 月 → 隔年 2 月)', dates[j] >= '2011-02-01' and dates[j - 1] < '2011-02-01', dates[j])
    rnd = random.Random(3)
    rows, m, k = [], dt.date(2003, 1, 1), 0
    while m < dt.date(2015, 1, 1):
        ym = f'{m.year}-{m.month:02d}'
        red = (k % 7 == 0)                      # ⭐ 紅燈是零散的單月(連續一整年的紅燈本來就躲得掉一部分,⛔ 拿來當對照)
        rows.append({'m': ym, 'score': 40 if red else 25, 'light': 'red' if red else 'green', 'lead': 100 + rnd.gauss(0, 1), 'coin': 100})
        m = dt.date(m.year + (m.month // 12), m.month % 12 + 1, 1)
        k += 1
    red_from = {decision_idx(dates, r['m']) for r in rows if r['light'] == 'red'}
    vals, v, bad_run = [], 100.0, 0
    for t in range(len(dates)):
        if t in red_from:
            bad_run = 21
        v *= 1 + (-0.004 if bad_run > 0 else 0.0005) + rnd.gauss(0, 0.002)
        bad_run -= 1
        vals.append(v)
    tm = timing(dates, vals, rows, lambda r: r['light'] == 'red', 'pub')
    bh = buyhold(dates, vals, decision_idx(dates, rows[0]['m']))
    ok('④ 注入「紅燈公布後一個月會跌」→ 紅燈換現金贏一直抱著、回撤較小', tm[0] > bh[0] and tm[1] > bh[1], (tm, bh))
    vals2, v = [], 100.0
    red_month_days = {t for t, dd in enumerate(dates) if any(dd[:7] == r['m'] for r in rows if r['light'] == 'red')}
    for t in range(len(dates)):
        v *= 1 + (-0.004 if t in red_month_days else 0.0005) + rnd.gauss(0, 0.002)
        vals2.append(v)
    tm2 = timing(dates, vals2, rows, lambda r: r['light'] == 'red', 'pub')
    bh2 = buyhold(dates, vals2, decision_idx(dates, rows[0]['m']))
    ok('⑤ 決定性對照:跌在「紅燈那個月本身」(公布前就跌完)→ 等公布才換現金 ⛔ 躲得掉(⛔ 贏一直抱著)', tm2[0] <= bh2[0] * 1.02, (tm2, bh2))
    x = [1.0 + 0.1 * (k % 2) for k in range(40)]
    ok('⑥ Newey-West:lag 0 = 一般 t;正相關的序列 lag 加大 t 變小', abs(nw_t(x, 0) - mean(x) / math.sqrt(sum((a - mean(x)) ** 2 for a in x) / len(x) / len(x))) < 1e-9)
    lt = lead_turns([{'m': f'2020-{k:02d}', 'lead': v} for k, v in enumerate([5, 4, 3, 2, 3, 4, 5, 6, 5], 1)])
    ok('⑦ 領先指標轉折:連 3 跌後轉升 / 連 3 升後轉跌', lt == {'up': ['2020-05'], 'down': ['2020-09']}, lt)
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
