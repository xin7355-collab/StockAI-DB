#!/usr/bin/env python3
"""🌏 crash_global_probe.py —— 急跌之後多久見底、多久回來:台股 1990 起 + 美日港韓德英指數(V81.0.3)

使用者 11/06:「我要你把何時台股反攻給找出來」。⛔ 沒有人能給「哪一天」(本站 40 種止跌 / 反攻訊號都沒過),
能給的是「像現在這樣急跌之後,過去多久見底、還再跌多少、多久回到前高」的分佈 —— 台股 2000 年後只有 14 次,樣本太少,
這支把同一套定義套到更長、更多的市場上。

定義(⛔ 第二份,Python 照抄 JS,`scripts/test_crash_global.mjs` 拿同一份收盤逐筆比):
  ・修正段 corr_legs   = lib_crash.corrLegs:收盤比近 250 天最高低 ≥10% 進入,回到 5% 以內結束
  ・急跌 fast_events  = crash_cycle_probe.fastEvents:收盤 ≤ 前 W 天(不含今天)最高收盤 × (1 − X%)
  ・每段第一次        = lib_crash.firstPerLeg
  ・after / ev_vs_corr = lib_crash.after / evVsCorr(對手 = 同一市場「修正段隨便一天」;p 值用自己的亂數,⛔ 拿來跟 JS 比)
每一次急跌另記(事後量的成績,⛔ 不是訊號):之後 250 天內最低收盤(還再跌幾 %、第幾天)、離那個低點反彈 10% 是第幾天、
回到那段高點是第幾天、那一段最後的最低點(不設 250 天上限)。
「像現在」只描述:之前一年漲 ≥30% / 收盤在 200 日線之上 / 標普同時跌 ≥10%(非美國市場)。
另:VIX 從 ≥T 回落 F%(stopfall_probe.vixGrid 同一條)→ 標普 1990 起樣本外,訊號隔一個交易日收盤進場(⛔ 同一天收盤 = 前視)。

資料:Yahoo(^GSPC 1928、^IXIC 1971、^N225 1965、^HSI 1987、^KS11 1997、^GDAXI 1988、^FTSE 1984、^TWII 1997、^VIX 1990);
台股優先用本站官方那份(TW_LONG / TW_EARLY / TW_NOW,同 lib_crash.loadIndex 的接法),TWSE_EARLY=1 再用證交所 FMTQIK
補 1990~1999 的收盤(lib_http.Gate 慢慢問,被擋就停、照樣跑其他市場)。
⛔ 只讀、只印 log、不寫任何檔、不碰任何分支(Actions macro_probe which=crash_global)。

跑法:python3 scripts/crash_global_probe.py                (要網路)
      python3 scripts/crash_global_probe.py --selftest
      python3 scripts/crash_global_probe.py --events FILE   FILE = [[date, close], …] → 印 JSON(給 test_crash_global.mjs)
"""
import json
import math
import os
import random
import re
import sys
from collections import deque

HS = (5, 20, 60, 120, 250)
FAST = ((15, 25), (10, 10), (20, 40))
YAHOO = (('^GSPC', '標普500'), ('^IXIC', '那斯達克'), ('^N225', '日經'), ('^HSI', '恆生'),
         ('^KS11', '韓股'), ('^GDAXI', '德股'), ('^FTSE', '英股'), ('^TWII', '台股'))


# ── 定義(照抄 JS)────────────────────────────────────────────────────────────
def roll_max(c, W):
    """= dipbuy_probe.rollMax:第 i 天 = c[i−W+1 .. i] 的最大值(含今天)。"""
    out, q = [0.0] * len(c), deque()
    for i, v in enumerate(c):
        while q and c[q[-1]] <= v:
            q.pop()
        q.append(i)
        if q[0] <= i - W:
            q.popleft()
        out[i] = c[q[0]]
    return out


def corr_legs(c, W=250, DD=10, END=5):
    """= lib_crash.corrLegs → (corr, legs, hi)。"""
    hi = roll_max(c, W)
    n, corr, legs, cur = len(c), [-1] * len(c), [], None
    for i in range(n):
        d = c[i] / hi[i] - 1
        if cur is None:
            if d <= -DD / 100:
                pk = i
                while pk > 0 and pk > i - W and c[pk] < hi[i]:
                    pk -= 1
                cur = {'s': i, 'e': i, 'peak': hi[i], 'peakI': pk, 'low': c[i], 'lowI': i, 'open': True}
        elif d > -END / 100:
            cur['open'] = False
            legs.append(cur)
            cur = None
            continue
        if cur is not None:
            cur['e'] = i
            if c[i] < cur['low']:
                cur['low'], cur['lowI'] = c[i], i
            corr[i] = len(legs)
    if cur is not None:
        legs.append(cur)
    for L in legs:
        L['depth'] = (L['low'] / L['peak'] - 1) * 100
    return corr, legs, hi


def fast_events(c, X, W):
    """= crash_cycle_probe.fastEvents:收盤 ≤ 前 W 天(不含今天)最高收盤 × (1 − X%),只用 ≤ i 的資料。"""
    out = []
    for i in range(W, len(c)):
        mx = max(c[i - W:i])
        if c[i] <= mx * (1 - X / 100):
            out.append(i)
    return out


def first_per_leg(ev, corr):
    """= lib_crash.firstPerLeg。"""
    seen, out = set(), []
    for i in ev:
        k = corr[i]
        if k < 0 or k in seen:
            continue
        seen.add(k)
        out.append(i)
    return out


def after(c, A, legs, corr, i, h):
    """= lib_crash.after → dict(x, more, near, deeper)。"""
    x = (A[i + h] / A[i] - 1) * 100 if (A[i] is not None and i + h < len(A) and A[i + h] is not None) else None
    L = legs[corr[i]] if corr[i] >= 0 else None
    mn = c[i]
    end = min((len(c) - 1) if L['open'] else L['e'], i + 250) if L else min(len(c) - 1, i + 120)
    for k in range(i + 1, end + 1):
        if c[k] < mn:
            mn = c[k]
    deeper = None
    if i + 60 < len(c):
        deeper = any(c[i + k] <= c[i] * 0.95 for k in range(1, 61))
    return {'x': x, 'more': (mn / c[i] - 1) * 100, 'near': (c[i] <= L['low'] * 1.03) if L else None, 'deeper': deeper}


def _mean(a):
    return sum(a) / len(a) if a else None


def _med(a):
    if not a:
        return None
    b = sorted(a)
    m = len(b) >> 1
    return b[m] if len(b) % 2 else (b[m - 1] + b[m]) / 2


def ev_vs_corr(d, c, A, corr, legs, ev, hs=HS, seed=7, sims=2000, frm=0):
    """= lib_crash.evVsCorr(⛔ 不四捨五入;p 值自己的亂數)。"""
    R = random.Random(seed)
    pool = [i for i in range(frm, len(c)) if corr[i] >= 0]
    out = {'n': len(ev), 'h': {}}
    def fx(i, h):           # = after(...).x(只要報酬就不用掃後面 250 天)
        return (A[i + h] / A[i] - 1) * 100 if (A[i] is not None and i + h < len(A) and A[i + h] is not None) else None
    for h in hs:
        base = [v for v in (fx(i, h) for i in pool) if v is not None]
        e = [(i, v) for i, v in ((i, fx(i, h)) for i in ev) if v is not None]
        if len(e) < 3 or len(base) < 30:
            out['h'][h] = {'n': len(e)}
            continue
        em, bm = _mean([v for _, v in e]), _mean(base)
        ge = 0
        for _ in range(sims):
            s = 0.0
            for _k in range(len(e)):
                s += base[int(R.random() * len(base))]
            if s / len(e) >= em:
                ge += 1
        half = len(e) >> 1
        h1, h2 = _mean([v for _, v in e[:half]]), _mean([v for _, v in e[half:]])
        yr = {}
        for i, v in e:
            yr.setdefault(d[i][:4], []).append(v)
        ys = list(yr.values())
        out['h'][h] = {'n': len(e), 'ev': em, 'base': bm, 'diff': em - bm,
                       'up': sum(1 for _, v in e if v > 0) / len(e) * 100,
                       'upBase': sum(1 for v in base if v > 0) / len(base) * 100, 'p': (ge / sims) if sims else None,
                       'h1': (h1 - bm) if h1 is not None else None, 'h2': (h2 - bm) if h2 is not None else None,
                       'yrsWin': sum(1 for a in ys if _mean(a) > bm), 'yrsN': len(ys)}
    A0 = [after(c, A, legs, corr, i, 20) for i in ev]
    P0 = [after(c, A, legs, corr, i, 20) for k, i in enumerate(pool) if k % 3 == 0]

    def pc(a, f):
        b = [z for z in a if z[f] is not None]
        return (sum(1 for z in b if z[f]) / len(b) * 100) if b else None
    out['near'], out['nearBase'] = pc(A0, 'near'), pc(P0, 'near')
    out['deeper'], out['deeperBase'] = pc(A0, 'deeper'), pc(P0, 'deeper')
    out['more'], out['moreBase'] = _med([z['more'] for z in A0]), _med([z['more'] for z in P0])
    out['open'] = sum(1 for i in ev if corr[i] >= 0 and legs[corr[i]]['open'])
    return out


# ── 每一次急跌的「見底 / 回來」(事後量的成績)───────────────────────────────────
def ep_metrics(c, legs, corr, i):
    """之後 250 天內最低收盤(= crash_cycle_probe 每次那一行)、離那個低點反彈 10% 第幾天、回到那段高點第幾天、整段最後的最低點。"""
    mn, mi = c[i], i
    for k in range(i + 1, min(len(c), i + 251)):
        if c[k] < mn:
            mn, mi = c[k], k
    reb10 = next((k - i for k in range(mi + 1, len(c)) if c[k] >= mn * 1.10), None)
    L = legs[corr[i]] if corr[i] >= 0 else None
    back = next((k - i for k in range(i + 1, len(c)) if L and c[k] >= L['peak']), None) if L else None
    end = (len(c) - 1) if (not L or L['open']) else L['e']
    lmn, lmi = c[i], i
    for k in range(i + 1, end + 1):
        if c[k] < lmn:
            lmn, lmi = c[k], k
    return {'low250': (mn / c[i] - 1) * 100, 'dLow': mi - i, 'reb10': reb10, 'back': back,
            'legLow': (lmn / c[i] - 1) * 100, 'dLegLow': lmi - i, 'open': bool(L and L['open'])}


def bucket(dl):
    return '當天就是' if dl == 0 else '5 天內' if dl <= 5 else '6~20 天' if dl <= 20 else '21~60 天' if dl <= 60 \
        else '61~120 天' if dl <= 120 else '121~250 天'


BUCKETS = ('當天就是', '5 天內', '6~20 天', '21~60 天', '61~120 天', '121~250 天')
BUCKETS2 = BUCKETS + ('251 天以上',)      # 「這一段的底」可以晚於 250 天(2000~2003 那種長空頭)


def bucket2(dl):
    return bucket(dl) if dl <= 250 else '251 天以上'


def summarize(rows):
    """一組急跌(ep_metrics + fwd)→ 分佈。"""
    done = [r for r in rows if r['dLowFull']]      # 之後還有 250 天資料才算得出「250 天內最低」
    if not done:
        legd = [r for r in rows if r.get('open') is False and r.get('dLegLow') is not None]
        return {'n': len(rows), 'nDone': 0, 'nLeg': len(legd),
                'legBuckets': {b: sum(1 for r in legd if bucket2(r['dLegLow']) == b) for b in BUCKETS2}}
    bk = {b: sum(1 for r in done if bucket(r['dLow']) == b) for b in BUCKETS}
    lows = [r['low250'] for r in done]
    reb = [r['reb10'] for r in done if r['reb10'] is not None]
    back = [r['back'] for r in rows if r['back'] is not None]
    nb = len([r for r in rows if r['backKnown']])
    q = lambda a, p: sorted(a)[min(len(a) - 1, int(p * len(a)))] if a else None
    # 「這一段的底」= 那段修正(距一年高 ≥10%)結束之前的最低收盤 —— 那段還沒結束的不算(⛔ 用現在的低點冒充)
    legd = [r for r in rows if r.get('open') is False and r.get('dLegLow') is not None]
    lgl = [r['legLow'] for r in legd]
    leg = {'nLeg': len(legd), 'legBuckets': {b: sum(1 for r in legd if bucket2(r['dLegLow']) == b) for b in BUCKETS2},
           'legLowMed': _med(lgl), 'legLowQ1': q(lgl, 0.25), 'legLowWorst': min(lgl) if lgl else None,
           'dLegLowMed': _med([r['dLegLow'] for r in legd])}
    return {**leg, 'n': len(rows), 'nDone': len(done), 'buckets': bk,
            'low250Med': _med(lows), 'low250Q1': q(lows, 0.25), 'low250Worst': min(lows),
            'dLowMed': _med([r['dLow'] for r in done]),
            'reb10Med': _med(reb), 'backMed': _med(back),
            'back250': sum(1 for r in rows if r['back'] is not None and r['back'] <= 250) / nb * 100 if nb else None,
            'back500': sum(1 for r in rows if r['back'] is not None and r['back'] <= 500) / nb * 100 if nb else None,
            'redrop60': (sum(1 for r in done if r['deeper']) / len([r for r in done if r['deeper'] is not None]) * 100)
            if [r for r in done if r['deeper'] is not None] else None}


def market_rows(d, c, X, W, extra=None):
    """一個市場一種急跌定義 → (events, rows, legs, corr)。"""
    corr, legs, hi = corr_legs(c)
    ev = first_per_leg(fast_events(c, X, W), corr)
    rows = []
    for i in ev:
        m = ep_metrics(c, legs, corr, i)
        a20 = after(c, c, legs, corr, i, 20)
        fw = {h: ((c[i + h] / c[i] - 1) * 100 if i + h < len(c) else None) for h in HS}
        ma200 = (sum(c[i - 199:i + 1]) / 200) if i >= 199 else None
        r = {'i': i, 'd': d[i], 'c': c[i], **m, 'fw': fw, 'deeper': a20['deeper'], 'near': a20['near'],
             'dLowFull': i + 250 < len(c), 'backKnown': (m['back'] is not None) or (len(c) - 1 - i >= 750),
             'ret250': (c[i] / c[i - 250] - 1) * 100 if i >= 250 else None,
             'above200': (c[i] > ma200) if ma200 else None}
        if extra:
            r.update(extra(i))
        rows.append(r)
    return ev, rows, legs, corr


# ── 資料 ─────────────────────────────────────────────────────────────────────
def _d10(s):
    return str(s).replace('/', '-')[:10]


def merge_tw(long, early, now):
    """同 dipbuy_probe.mergeIdx 的接法(只要收盤):early 只收早於 long 第一天的、now 只收晚於 long 最後一天的。"""
    def rows(src, key='twii'):
        out = []
        for r in (src or {}).get(key, []) if isinstance(src, dict) else []:
            try:
                dd, cc = _d10(r[0]), float(r[4])
            except (TypeError, ValueError, IndexError):
                continue
            if cc > 0:
                out.append((dd, cc))
        return out
    L = rows(long)
    if not L:
        return []
    f0, f1 = L[0][0], L[-1][0]
    E = [r for r in rows(early) if r[0] < f0]
    N = []
    for r in (now or []):
        try:
            dd, cc = _d10(r.get('date')), float(r.get('close'))
        except (TypeError, ValueError, AttributeError):
            continue
        if cc > 0 and dd > f1:
            N.append((dd, cc))
    out = E + L + N
    for k in range(1, len(out)):
        if not out[k][0] > out[k - 1][0]:
            raise ValueError(f'日期沒有由舊到新:{out[k][0]}')
    return out


def roc_iso(s):
    m = re.match(r'^\s*(\d{2,3})[/\-]?(\d{1,2})[/\-]?(\d{1,2})\s*$', str(s or ''))
    if not m:
        return None
    y, mo, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= dd <= 31):
        return None
    return f'{y + 1911:04d}-{mo:02d}-{dd:02d}'


def parse_fmtqik_close(j):
    """TWSE FMTQIK 月份檔 → [(ISO 日期, 加權指數收盤)];欄位一律用名字找(同 miner._parse_fmtqik)。"""
    fields = [str(f or '').replace(' ', '') for f in ((j or {}).get('fields') or [])]
    i_d = next((k for k, f in enumerate(fields) if '日期' in f), None)
    i_c = next((k for k, f in enumerate(fields) if '加權' in f and '指數' in f), None)
    if i_d is None or i_c is None:
        return []
    out = []
    for row in ((j or {}).get('data') or []):
        try:
            iso = roc_iso(row[i_d])
            v = float(str(row[i_c]).replace(',', ''))
        except (ValueError, IndexError, TypeError):
            continue
        if iso and v > 0:
            out.append((iso, v))
    return out


def fetch_twse_early(y0=1990, y1=1999, gate=None, log=print):
    """證交所 FMTQIK 1990~1999 每月一份 → [(日期, 收盤)];被擋就停(回已抓到的 + 原因)。"""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    from lib_http import Gate  # noqa: E402
    g = gate or Gate(gaps={'www.twse.com.tw': 6.0})
    out, why = [], ''
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            url = f'https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json&date={y:04d}{m:02d}01'
            res, why = g.get(url)
            if res is None:
                log(f'  [FMTQIK] {y}/{m:02d} {why}')
                if '斷路' in why:
                    return out, why
                continue
            try:
                got = parse_fmtqik_close(res.json())
            except ValueError:
                got = []
            if not got:
                log(f'  [FMTQIK] {y}/{m:02d} 解析 0 列')
            out += got
    out.sort()
    return out, ''


def yahoo(ticker):
    import yfinance as yf
    h = yf.Ticker(ticker).history(period='max', auto_adjust=False)
    seen, out = set(), []
    for ts, v in h['Close'].items():
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if not (v == v and v > 0):
            continue
        dd = ts.strftime('%Y-%m-%d')
        if dd in seen:
            continue
        seen.add(dd)
        out.append((dd, v))
    out.sort()
    return out


def next_idx(dates, day):
    """第一個 > day 的交易日索引(⛔ 同一天 = 前視);沒有回 −1。"""
    lo, hi = 0, len(dates)
    while lo < hi:
        m = (lo + hi) >> 1
        if dates[m] > day:
            hi = m
        else:
            lo = m + 1
    return lo if lo < len(dates) else -1


def cliff_note(d, c):
    """單日 >±25% 只印出來(1987 標普 −20%、恆生停市 4 天後 −33% 是真的,⛔ 不刪)。"""
    return [f'{d[i]} {(c[i] / c[i - 1] - 1) * 100:+.1f}%' for i in range(1, len(c)) if abs(c[i] / c[i - 1] - 1) > 0.25]


# ── 報告 ─────────────────────────────────────────────────────────────────────
def _f(x, nd=1):
    return '—' if x is None else f'{x:.{nd}f}'


def report_market(name, d, c, log, extra=None):
    out = {'name': name, 'from': d[0], 'to': d[-1], 'n': len(c), 'fast': {}}
    corr, legs, _ = corr_legs(c)
    log(f'\n════ {name}:{d[0]} ~ {d[-1]}({len(c):,} 天)・修正段(跌 ≥10%){len(legs)} 段 ════')
    cl = cliff_note(d, c)
    if cl:
        log(f'  ⚠️ 單日 >±25%:{" ・".join(cl[:6])}')
    for X, W in FAST:
        ev, rows, legs, corr = market_rows(d, c, X, W, extra)
        tag = f'{X}/{W}'
        r = ev_vs_corr(d, c, c, corr, legs, ev)
        s = summarize(rows)
        out['fast'][tag] = {'sum': s, 'vs': {h: {k: v for k, v in (r['h'].get(h) or {}).items()} for h in HS},
                            'near': r['near'], 'nearBase': r['nearBase'], 'deeper': r['deeper'], 'deeperBase': r['deeperBase'],
                            'more': r['more'], 'moreBase': r['moreBase'], 'rows': rows}
        log(f'\n  ── 急跌 {X}%/{W} 天(每段第一次):{len(ev)} 次 ──')
        if tag == '15/25':
            for z in rows:
                log(f"   {z['d']} 收 {z['c']:,.0f} ・250 天內最低 {_f(z['low250'])}%(第 {z['dLow']} 天)"
                    f" ・離底反彈 10% 第 {z['reb10'] if z['reb10'] is not None else '—'} 天"
                    f" ・回到前高第 {z['back'] if z['back'] is not None else '—'} 天"
                    f" ・20/60/250 天 {_f(z['fw'][20])}/{_f(z['fw'][60])}/{_f(z['fw'][250])}%"
                    f" ・前一年 {_f(z['ret250'], 0)}% ・{'年線上' if z['above200'] else '年線下' if z['above200'] is not None else '—'}")
        if s.get('nLeg'):
            log(f"   這一段的底(那段修正結束前的最低點,{s['nLeg']} 次):" + ' ・'.join(f'{b} {s["legBuckets"][b]}' for b in BUCKETS2)
                + f" ・還再跌中位 {_f(s.get('legLowMed'))}% ・最慘 25% {_f(s.get('legLowQ1'))}% ・最慘 {_f(s.get('legLowWorst'))}%")
        if s.get('nDone'):
            log(f"   見底時間(250 天內最低是第幾天,{s['nDone']} 次):" + ' ・'.join(f'{b} {s["buckets"][b]}' for b in BUCKETS))
            log(f"   還再跌 中位 {_f(s['low250Med'])}% ・最慘 25% {_f(s['low250Q1'])}% ・最慘 {_f(s['low250Worst'])}%"
                f" ・離底反彈 10% 中位第 {_f(s['reb10Med'], 0)} 天 ・回到前高中位第 {_f(s['backMed'], 0)} 天"
                f"(一年內回去 {_f(s['back250'], 0)}% ・兩年內 {_f(s['back500'], 0)}%)・60 天內再跌 ≥5% {_f(s['redrop60'], 0)}%")
        for h in HS:
            x = r['h'].get(h) or {}
            if x.get('ev') is None:
                continue
            log(f"   {h:>3} 天:急跌 {x['ev']:+.2f}%(漲 {x['up']:.0f}%)vs 修正段隨便一天 {x['base']:+.2f}%(漲 {x['upBase']:.0f}%)"
                f" 差 {x['diff']:+.2f} ・p={x['p']:.3f} ・前後半 {_f(x['h1'], 2)}/{_f(x['h2'], 2)} ・n={x['n']}")
        log(f"   離那段最低 3% 內 {_f(r['near'], 0)}%(隨便一天 {_f(r['nearBase'], 0)}%)・60 天內再跌 ≥5% {_f(r['deeper'], 0)}%"
            f"(隨便一天 {_f(r['deeperBase'], 0)}%)")
    return out


def pooled(markets, log, tag='15/25'):
    """全部市場合計:分佈 + 每一次減掉自己市場的「修正段隨便一天」平均。"""
    rows = []
    for m in markets:
        f = m['fast'].get(tag)
        if not f:
            continue
        for z in f['rows']:
            rows.append({**z, 'mk': m['name'], 'base': {h: (f['vs'].get(h) or {}).get('base') for h in HS}})
    s = summarize(rows)
    log(f'\n════ 全部市場合計(急跌 {tag},每段第一次):{len(rows)} 次 ════')
    if s.get('nLeg'):
        log(f"   這一段的底({s['nLeg']} 次):" + ' ・'.join(f'{b} {s["legBuckets"][b]}({s["legBuckets"][b] / s["nLeg"] * 100:.0f}%)'
                                                  for b in BUCKETS2)
            + f" ・還再跌中位 {_f(s.get('legLowMed'))}% ・最慘 25% {_f(s.get('legLowQ1'))}% ・最慘 {_f(s.get('legLowWorst'))}%"
            + f" ・第幾天中位 {_f(s.get('dLegLowMed'), 0)}")
    if s.get('nDone'):
        log('   見底時間:' + ' ・'.join(f'{b} {s["buckets"][b]}({s["buckets"][b] / s["nDone"] * 100:.0f}%)' for b in BUCKETS))
        log(f"   還再跌 中位 {_f(s['low250Med'])}% ・最慘 25% {_f(s['low250Q1'])}% ・最慘 {_f(s['low250Worst'])}%"
            f" ・離底反彈 10% 中位第 {_f(s['reb10Med'], 0)} 天 ・回到前高中位第 {_f(s['backMed'], 0)} 天"
            f"(一年內 {_f(s['back250'], 0)}% ・兩年內 {_f(s['back500'], 0)}%)・60 天內再跌 ≥5% {_f(s['redrop60'], 0)}%")
    for h in HS:
        ex = [z['fw'][h] - z['base'][h] for z in rows if z['fw'][h] is not None and z['base'][h] is not None]
        if len(ex) < 5:
            continue
        mu, sd = _mean(ex), (sum((v - _mean(ex)) ** 2 for v in ex) / (len(ex) - 1)) ** 0.5
        pos = sum(1 for v in ex if v > 0)
        log(f'   {h:>3} 天:比自己市場修正段隨便一天 平均 {mu:+.2f}pp(中位 {_med(ex):+.2f})・贏 {pos}/{len(ex)}'
            f' ・t={mu / (sd / len(ex) ** 0.5) if sd > 0 else 0:.2f}')
    return rows, s


def like_now(rows, now, log):
    """「像現在」分組(只描述):之前一年漲 ≥30% / 年線上 / 標普同時跌 ≥10%。"""
    log(f"\n════ 像現在的那幾次(只描述;現在:前一年 {_f(now.get('ret250'), 0)}% ・"
        f"{'年線上' if now.get('above200') else '年線下'} ・標普距一年高 {_f(now.get('spDD'), 1)}%)════")
    groups = [('前一年漲 ≥30%', lambda z: z['ret250'] is not None and z['ret250'] >= 30),
              ('前一年漲 <30%', lambda z: z['ret250'] is not None and z['ret250'] < 30),
              ('還在 200 日線上', lambda z: z['above200'] is True),
              ('已在 200 日線下', lambda z: z['above200'] is False),
              ('標普同時跌 ≥10%', lambda z: z.get('spDD') is not None and z['spDD'] <= -10),
              ('標普沒跌那麼多', lambda z: z.get('spDD') is not None and z['spDD'] > -10)]
    out = {}
    for nm, f in groups:
        g = [z for z in rows if f(z)]
        s = summarize(g)
        out[nm] = s
        if not s.get('nDone'):
            log(f'   {nm}:{len(g)} 次(之後資料不夠)')
            continue
        w60 = [z['fw'][60] for z in g if z['fw'][60] is not None]
        w250 = [z['fw'][250] for z in g if z['fw'][250] is not None]
        lb = s.get('legBuckets') or {}
        log(f"   {nm}:{len(g)} 次 ・5 天內見底 {(s['buckets']['當天就是'] + s['buckets']['5 天內'])}/{s['nDone']}"
            f" ・半年以上 {s['buckets']['121~250 天']}/{s['nDone']} ・還再跌中位 {_f(s['low250Med'])}%"
            f" ・60 天內再跌 ≥5% {_f(s['redrop60'], 0)}% ・60 天中位 {_f(_med(w60))}% ・250 天中位 {_f(_med(w250))}%")
        if s.get('nLeg'):
            log(f"      這一段的底 5 天內 {lb.get('當天就是', 0) + lb.get('5 天內', 0)}/{s['nLeg']}"
                f" ・21~120 天 {lb.get('21~60 天', 0) + lb.get('61~120 天', 0)}/{s['nLeg']}"
                f" ・121 天以上 {lb.get('121~250 天', 0) + lb.get('251 天以上', 0)}/{s['nLeg']}"
                f" ・還再跌中位 {_f(s.get('legLowMed'))}%")
        if len(g) <= 30:
            log('      └ ' + ' ・'.join(f"{z['mk'][:2]} {z['d'][:7]}" for z in sorted(g, key=lambda z: z['d'])))
    return out


def vix_oos(sp, vx, log, Ts=(25, 30, 35), Fs=(15, 20, 25)):
    """VIX 從 ≥T 回落 F%(10 天內高點)→ 標普下一個交易日收盤 → 每段第一次 vs 修正段隨便一天(1990 起)。"""
    sd, sc = [r[0] for r in sp], [r[1] for r in sp]
    vd, vc = [r[0] for r in vx], [r[1] for r in vx]
    corr, legs, _ = corr_legs(sc)
    nxt = lambda day: next_idx(sd, day)
    frm = max(0, nxt(vd[9]) if len(vd) > 9 else 0)
    log(f'\n════ VIX 回落 → 標普(樣本外,{vd[0]} 起;對照組 = {sd[frm]} 起的修正段日子)════')
    log('   高點≥ 回落≥ 段數 |  20 天 差(p)     60 天 差(p)     120 天 差(p)  | 60 天內再跌 ≥5%')
    out = []
    for T in Ts:
        for F in Fs:
            ev = set()
            for i in range(9, len(vc)):
                mx = max(vc[i - 9:i + 1])
                if mx >= T and vc[i] <= (1 - F / 100) * mx:
                    k = nxt(vd[i])
                    if k >= 0:
                        ev.add(k)
            first = first_per_leg(sorted(ev), corr)
            r = ev_vs_corr(sd, sc, sc, corr, legs, first, (20, 60, 120), 17, 2000, frm)

            def cell(h):
                x = r['h'].get(h) or {}
                return f"{x['diff']:+6.2f}({x['p']:.2f})" if x.get('diff') is not None else '     —      '
            out.append({'T': T, 'F': F, 'n': len(first), 'r': r})
            log(f'   {T:>4} {F:>4}% {len(first):>4} | {cell(20)}  {cell(60)}  {cell(120)} | {_f(r["deeper"], 0)}%({_f(r["deeperBase"], 0)}%)')
    return out


# ── selftest ────────────────────────────────────────────────────────────────
def selftest():
    fails = []

    def t(cond, msg):
        print(('✅ ' if cond else '❌ ') + msg)
        if not cond:
            fails.append(msg)

    R = random.Random(3)
    a = [100 + R.random() * 50 for _ in range(400)]
    rm = roll_max(a, 25)
    t(all(abs(rm[i] - max(a[max(0, i - 24):i + 1])) < 1e-12 for i in range(len(a))), '① roll_max = 含今天往前 W 天的最大值(逐天 vs 暴力)')

    c = [100.0] * 300 + [100 - k for k in range(1, 26)] + [75 + k for k in range(1, 40)]
    corr, legs, _ = corr_legs(c)
    t(len(legs) == 1 and legs[0]['s'] == 310 and legs[0]['lowI'] == 324 and abs(legs[0]['depth'] + 25) < 1e-9,
      f"② 修正段:跌到 90 那天進入、最低第 324 天、深 −25%({legs[0]['s'] if legs else None}/{legs[0]['lowI'] if legs else None})")
    t(legs and legs[0]['open'] is False and corr[300] == -1 and corr[310] == 0, '② 回到高點 5% 以內那天結束、之前不在段裡')

    c2 = [100.0] * 40 + [96, 92, 88, 85, 84, 83, 90, 95]
    e1 = fast_events(c2, 15, 25)
    c3 = c2[:44] + [50, 50, 50, 50]
    e2 = fast_events(c3, 15, 25)
    t(e1[:1] == [43] and [i for i in e2 if i <= 43] == [i for i in e1 if i <= 43],
      f'③ 急跌第一天 = 第 43 天(剛好跌 15%),改掉之後的價格不影響({e1[:2]})')
    t(first_per_leg([5, 6, 9, 20], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) == [5, 20], '④ 每段只留第一次')

    c4 = [100.0] * 260 + [85, 80, 70, 72, 78, 82, 90, 96, 100, 101]
    corr4, legs4, _ = corr_legs(c4)
    m = ep_metrics(c4, legs4, corr4, 260)
    t(m['dLow'] == 2 and abs(m['low250'] - (70 / 85 - 1) * 100) < 1e-9 and m['reb10'] == 4 and m['back'] == 8,
      f"⑤ 見底第 2 天、離底反彈 10%(77)第 4 天、回到前高 100 第 8 天({m['dLow']}/{m['reb10']}/{m['back']})")

    # ⑥ 決定性對照:事件埋「之後 20 天 +8%」→ 差距明顯為正;事件 = 修正段隨便抽 → 差距 ≈ 0
    R6 = random.Random(9)
    cc, d6 = [100.0], ['2000-01-01']
    for k in range(1, 6000):
        cc.append(cc[-1] * (1 + R6.gauss(0.0003, 0.012)))
        d6.append(f'{2000 + k // 250:04d}-{(k % 250) // 21 + 1:02d}-{k % 21 + 1:02d}')
    corr6, legs6, _ = corr_legs(cc)
    pool = [i for i in range(len(cc)) if corr6[i] >= 0 and i + 300 < len(cc)]
    t(len(pool) > 300, f'⑥ 合成資料有夠多修正段日子({len(pool)})')
    rnd = sorted(R6.sample(pool, 40))
    r0 = ev_vs_corr(d6, cc, cc, corr6, legs6, rnd, (20,), 5, 500)
    planted = list(cc)
    for i in rnd:
        for k in range(i + 1, i + 21):
            planted[k] = planted[k] * (1.08 ** ((k - i) / 20))
    r1 = ev_vs_corr(d6, cc, planted, corr6, legs6, rnd, (20,), 5, 500)
    t(abs(r0['h'][20]['diff']) < 2.0, f"⑥ 隨便抽的日子 ≈ 修正段平均(差 {r0['h'][20]['diff']:+.2f})")
    t(r1['h'][20]['diff'] > 5 and r1['h'][20]['p'] < 0.05, f"⑥ 埋了 +8% → 抓得到(差 {r1['h'][20]['diff']:+.2f} ・p {r1['h'][20]['p']})")

    # ⑦ VIX:訊號那天 → 下一個交易日(⛔ 同一天)
    sp = [(f'2001-01-{k:02d}', 100.0 - k * 0.1) for k in range(1, 29)]
    vx = [(f'2001-01-{k:02d}', 35.0 if k == 12 else (25.0 if k > 12 else 20.0)) for k in range(1, 29)]
    sd = [r[0] for r in sp]
    k = next_idx(sd, '2001-01-13')
    t(sd[k] == '2001-01-14' and next_idx(sd, '2001-01-28') == -1 and sd[next_idx(sd, '2000-12-31')] == '2001-01-01',
      f'⑦ VIX 回落那天(01-13)→ 標普下一個交易日(01-14)收盤進場、最後一天之後沒有({sd[k]})')
    ev = [i for i in range(9, len(vx)) if max(v for _, v in vx[i - 9:i + 1]) >= 30 and vx[i][1] <= 0.8 * max(v for _, v in vx[i - 9:i + 1])]
    t(ev and vx[ev[0]][0] == '2001-01-13', f'⑦ 回落 20% 第一天 = 01-13(35 → 25)({vx[ev[0]][0] if ev else None})')

    j = {'fields': ['日期', '成交股數', '成交金額', '成交筆數', '發行量加權股價指數', '漲跌點數'],
         'data': [['79/01/04', '1', '2', '3', '9,624.18', '1'], ['79/01/05', '1', '2', '3', '9,627.09', '1'], ['xx', 1, 2, 3, 4, 5]]}
    got = parse_fmtqik_close(j)
    t(got == [('1990-01-04', 9624.18), ('1990-01-05', 9627.09)], f'⑧ FMTQIK 民國日期 + 千分位 → ISO + 數字、壞列丟掉({got})')
    j2 = {'fields': ['發行量加權股價指數', '日期'], 'data': [['5,000.5', '88/12/31']]}
    t(parse_fmtqik_close(j2) == [('1999-12-31', 5000.5)], '⑧ 欄位換順序照名字找')

    long = {'twii': [['2010/01/04', 0, 0, 0, 8207.85, 1], ['2010/01/05', 0, 0, 0, 8211.07, 1]]}
    early = {'twii': [['2009/12/31', 0, 0, 0, 8188.11, 1], ['2010/01/04', 0, 0, 0, 1.0, 1]]}
    now = [{'date': '2010/01/05', 'close': 9}, {'date': '2010/01/06', 'close': 8250.0}]
    mt = merge_tw(long, early, now)
    t([r[0] for r in mt] == ['2009-12-31', '2010-01-04', '2010-01-05', '2010-01-06'] and mt[1][1] == 8207.85,
      '⑨ 台股接法:早期只收 long 之前、^TWII 只收 long 之後(同 mergeIdx)')

    rows = [{'dLowFull': True, 'dLow': 0, 'low250': -1, 'reb10': 30, 'back': 100, 'backKnown': True, 'deeper': False},
            {'dLowFull': True, 'dLow': 3, 'low250': -5, 'reb10': 40, 'back': None, 'backKnown': True, 'deeper': True},
            {'dLowFull': False, 'dLow': 1, 'low250': -2, 'reb10': None, 'back': None, 'backKnown': False, 'deeper': None}]
    s = summarize(rows)
    t(s['nDone'] == 2 and s['buckets']['當天就是'] == 1 and s['buckets']['5 天內'] == 1 and s['back250'] == 50.0
      and s['redrop60'] == 50.0, f'⑩ 分佈:之後資料不夠的不算見底時間、回到前高只算看得到結果的({s})')

    rows2 = [dict(r, open=o, dLegLow=dl, legLow=ll) for r, o, dl, ll in
             zip(rows, (False, False, True), (2, 300, 1), (-3.0, -40.0, -1.0))]
    s2 = summarize(rows2)
    t(s2['nLeg'] == 2 and s2['legBuckets']['5 天內'] == 1 and s2['legBuckets']['251 天以上'] == 1
      and s2['legLowWorst'] == -40.0, f'⑪ 這一段的底:那段還沒結束的不算、超過 250 天另一格({s2})')

    print(f"\n{'❌ ' + str(len(fails)) + ' 條沒過' if fails else '✅ crash_global_probe selftest 全部通過'}")
    return 1 if fails else 0


def events_mode(path):
    """給 test_crash_global.mjs:同一份收盤 → Python 算的事件與數字(⛔ 四捨五入)。"""
    with open(path, encoding='utf-8') as fh:
        rows = json.load(fh)
    d, c = [_d10(r[0]) for r in rows], [float(r[1]) for r in rows]
    corr, legs, hi = corr_legs(c)
    out = {'legs': [{k: L[k] for k in ('s', 'e', 'peak', 'peakI', 'low', 'lowI', 'open', 'depth')} for L in legs], 'fast': {}}
    for X, W in FAST:
        raw = fast_events(c, X, W)
        ev = first_per_leg(raw, corr)
        r = ev_vs_corr(d, c, c, corr, legs, ev, HS, 7, 0)
        out['fast'][f'{X}/{W}'] = {'raw': raw, 'ev': ev, 'ep': [ep_metrics(c, legs, corr, i) for i in ev],
                                   'vs': {str(h): {k: v for k, v in (r['h'].get(h) or {}).items() if k != 'p'} for h in HS},
                                   'near': r['near'], 'nearBase': r['nearBase'], 'deeper': r['deeper'],
                                   'deeperBase': r['deeperBase'], 'more': r['more'], 'moreBase': r['moreBase']}
    print(json.dumps(out))
    return 0


def main():
    log = print
    markets, now = [], {}
    sp = None
    no_yahoo = os.environ.get('NO_YAHOO') == '1'        # 本機乾跑(沙箱連不到 Yahoo):只跑台股
    try:
        sp = None if no_yahoo else yahoo('^GSPC')
    except Exception as e:  # noqa: BLE001
        log(f'⚠️ ^GSPC 抓不到:{type(e).__name__} {str(e)[:80]}')
    spd = [r[0] for r in sp] if sp else []
    sp_dd = None
    if sp:
        spc = [r[1] for r in sp]
        sphi = roll_max(spc, 250)
        sp_dd = {spd[i]: (spc[i] / sphi[i] - 1) * 100 for i in range(len(spc))}

    def sp_at(day):
        if not sp_dd:
            return None
        lo, hi = 0, len(spd)
        while lo < hi:
            m = (lo + hi) >> 1
            if spd[m] <= day:
                lo = m + 1
            else:
                hi = m
        return sp_dd[spd[lo - 1]] if lo > 0 else None

    # 台股:本站官方那份(2000 起)+ FMTQIK 1990~1999(TWSE_EARLY=1)
    tw = []
    try:
        rd = lambda p: json.load(open(p, encoding='utf-8')) if p and os.path.exists(p) else None
        nowj = rd(os.environ.get('TW_NOW'))
        nowj = nowj if isinstance(nowj, list) else ((nowj or {}).get('data') or (nowj or {}).get('rows') or [])
        tw = merge_tw(rd(os.environ.get('TW_LONG')), rd(os.environ.get('TW_EARLY')), nowj)
    except Exception as e:  # noqa: BLE001
        log(f'⚠️ 台股官方那份讀不到:{type(e).__name__} {str(e)[:80]}')
    if os.environ.get('TWSE_EARLY') == '1':
        early, why = fetch_twse_early(1990, 1999)
        f0 = tw[0][0] if tw else '9999'
        early = [r for r in early if r[0] < f0]
        log(f"🏛️ 證交所 FMTQIK 1990~1999:{len(early)} 天{('(' + why + ')') if why else ''}"
            f"{(' ' + early[0][0] + ' ~ ' + early[-1][0]) if early else ''}")
        if early and tw and early[-1][0] < tw[0][0]:
            tw = early + tw
    tw_name = '台股(本站官方)'
    if tw and tw[0][0] >= '2000' and not no_yahoo:
        # 證交所 1990 年代那份拿不到 → 退而求其次:Yahoo ^TWII 1997-07 起只補官方那份之前(同 mergeIdx:官方優先)
        try:
            yt = [r for r in yahoo('^TWII') if r[0] < tw[0][0]]
            if len(yt) > 200:
                gap = (tw[0][1] / yt[-1][1] - 1) * 100
                log(f"🇹🇼 Yahoo ^TWII 補 {len(yt)} 天({yt[0][0]} ~ {yt[-1][0]})・接縫 {yt[-1][0]} {yt[-1][1]:,.0f} → "
                    f"{tw[0][0]} {tw[0][1]:,.0f}({gap:+.1f}%)")
                if abs(gap) < 7:
                    tw = yt + tw
                    tw_name = '台股(Yahoo 1997~1999 + 本站官方)'
                else:
                    log('⚠️ 接縫跳太多(≥7%)→ 不接')
        except Exception as e:  # noqa: BLE001
            log(f'⚠️ ^TWII 抓不到:{type(e).__name__} {str(e)[:80]}')
    if tw:
        d, c = [r[0] for r in tw], [r[1] for r in tw]
        i = len(c) - 1
        ma200 = sum(c[-200:]) / 200
        now = {'d': d[i], 'c': c[i], 'ret250': (c[i] / c[i - 250] - 1) * 100 if i >= 250 else None,
               'above200': c[i] > ma200, 'spDD': sp_at(d[i])}
        log(f"🇹🇼 現在:{now['d']} 收 {now['c']:,.0f} ・前一年 {_f(now['ret250'], 0)}% ・200 日線 {ma200:,.0f}"
            f"({'之上' if now['above200'] else '之下'})・標普距一年高 {_f(now['spDD'], 1)}%")
        markets.append(report_market(tw_name, d, c, log, lambda i: {'spDD': sp_at(d[i])}))
    for tk, nm in YAHOO:
        if (tk == '^TWII' and tw) or no_yahoo:
            continue
        try:
            rows = sp if (tk == '^GSPC' and sp) else yahoo(tk)
        except Exception as e:  # noqa: BLE001
            log(f'⚠️ {tk} 抓不到:{type(e).__name__} {str(e)[:80]}')
            continue
        if len(rows) < 1500:
            log(f'⚠️ {tk} 只有 {len(rows)} 天,跳過')
            continue
        d, c = [r[0] for r in rows], [r[1] for r in rows]
        ex = (lambda i, d=d: {'spDD': sp_at(d[i])}) if tk != '^GSPC' else (lambda i: {'spDD': None})
        markets.append(report_market(f'{nm} {tk}', d, c, log, ex))
    if not markets:
        log('❌ 一個市場都沒抓到')
        return 1
    rows, _ = pooled(markets, log)
    nonus = [z for z in rows if not z['mk'].startswith('標普') and not z['mk'].startswith('那斯達克')]
    like_now(rows, now, log)
    log('\n(非美國市場才有「標普同時跌」那一組)')
    like_now(nonus, now, log)
    try:
        vx = [] if no_yahoo else yahoo('^VIX')
        if sp and len(vx) > 1000:
            vix_oos(sp, vx, log)
    except Exception as e:  # noqa: BLE001
        log(f'⚠️ ^VIX 抓不到:{type(e).__name__} {str(e)[:80]}')
    summ = {m['name']: {'from': m['from'], 'n': m['n'],
                        **{tag: {k: v for k, v in f['sum'].items()} for tag, f in m['fast'].items()}} for m in markets}
    log('\n@@JSON@@ ' + json.dumps({'now': now, 'markets': summ}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if '--events' in sys.argv:
        sys.exit(events_mode(sys.argv[sys.argv.index('--events') + 1]))
    sys.exit(main())
