#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦→🌅 外資台指期「急遽加空 / 大幅回補 / 空單近期最重 / 最輕」→ 隔天 0050 開盤方向(V79.3.8)

為什麼要有這支:App 的 `_fiFutState()`(相對水位:5 日增減 ±8,000 口、近 20 日位階 ≤15% / ≥85%)
  在當沖頁、總覽、提醒裡被拿來講「明天方向」,但 **從來沒回測過**。V79.0.3 dt_selfgap_probe 時
  外資台指期只有 risk_history 的 68 天 → 測不了;V79.3.6 補挖了 fi_mkt_hist(2018-06 起 2,039 天)→ 現在測得動。

做法(零前視):
  ・狀態用 **當天收盤後**就知道的外資台指期淨未平倉(期交所 15:00 公布)→ 跟 `_fiFutState` 同一套規則逐日重算
    (chg5 = 今天 − 5 個交易日前;位階 = 近 20 個值的區間位置;判斷順序照 App,⛔ 不另訂門檻)
  ・結果看 **隔天** 0050:開盤跳空(開 ÷ 昨收)、開→收、收→收、之後 5 天收→收
    🚨 陷阱 #47:⛔ 不用加權指數的開盤價(那是用昨收湊的)→ 一律用 0050 自己的開盤
  ・隔天是 0050 除息日 → 剔除(跳空是除息造成的)
  ・對照 = 全部交易日的平均(同一段期間);每個狀態 × 每種結果算差、Welch t、逐年同向、前後半;全部一起 BH

⛔ 描述與檢定,⛔ 不改 App。

跑法:FI_MKT=$S/fi_mkt_hist.json DATA_DIR=$S/d10n python3 scripts/fifut_open_probe.py out.json
      (DATA_DIR 要 _bench0050.json(含開盤)與 _div0050.json)
      python3 scripts/fifut_open_probe.py --selftest
"""
import json
import math
import os
import sys
from pathlib import Path

FI_MKT = os.getenv('FI_MKT') or ''
DATA = Path(os.getenv('DATA_DIR') or 'data')
OUTS = ('gap', 'oc', 'cc', 'cc5')
OUT_NAME = {'gap': '隔天開盤跳空', 'oc': '隔天開→收', 'cc': '隔天收→收', 'cc5': '之後 5 天'}
STATES = ('danger', 'good_chg', 'warn_pct', 'good_pct', 'warn_chg', 'good_chg3', 'neutral')
STATE_NAME = {'danger': '🚨 急遽加空(5 日 ≤ −8,000 口)', 'good_chg': '✅ 大幅回補(5 日 ≥ +8,000)',
              'warn_pct': '⛔ 空單近期最重(位階 ≤15%)', 'good_pct': '✅ 空單近期最輕(位階 ≥85%)',
              'warn_chg': '⚠️ 空單增加中(5 日 ≤ −3,000)', 'good_chg3': '✅ 回補中(5 日 ≥ +3,000)', 'neutral': '➖ 區間震盪'}
STATE_DIR = {'danger': -1, 'good_chg': 1, 'warn_pct': -1, 'good_pct': 1, 'warn_chg': -1, 'good_chg3': 1, 'neutral': 0}


def d10(s):
    return str(s or '').replace('/', '-')[:10]


def fut_state(hist):
    """hist = 到今天為止的淨未平倉序列(最後一個是今天)。照 index.html `_fiFutState` 的判斷順序。"""
    if not hist:
        return None
    net = hist[-1]
    chg5 = hist[-1] - hist[-6] if len(hist) >= 6 else None
    win = hist[-20:]
    pct = None
    if len(win) >= 8:
        lo, hi = min(win), max(win)
        if hi > lo:
            pct = (net - lo) / (hi - lo) * 100
    if chg5 is None and pct is None:
        return None
    if chg5 is not None and chg5 <= -8000:
        return 'danger'
    if chg5 is not None and chg5 >= 8000:
        return 'good_chg'
    if pct is not None and pct <= 15:
        return 'warn_pct'
    if pct is not None and pct >= 85:
        return 'good_pct'
    if chg5 is not None and chg5 <= -3000:
        return 'warn_chg'
    if chg5 is not None and chg5 >= 3000:
        return 'good_chg3'
    return 'neutral'


def build_rows(fut, bars, exdiv):
    """fut = {date: 淨口數};bars = [(date, open, close)] 依日期排序;exdiv = 除息日集合。
    回 [{d, st, gap, oc, cc, cc5}](d = 狀態那天;結果是隔天起)。"""
    fd = sorted(fut)
    pos = {d: i for i, (d, _o, _c) in enumerate(bars)}
    rows = []
    hist = []
    for d in fd:
        hist.append(fut[d])
        if d not in pos:
            continue
        i = pos[d]
        if i + 1 >= len(bars):
            continue
        st = fut_state(hist)
        if st is None:
            continue
        d1, o1, c1 = bars[i + 1]
        _d0, _o0, c0 = bars[i]
        if d1 in exdiv or not (o1 > 0 and c0 > 0 and c1 > 0):
            continue
        r = {'d': d, 'st': st, 'gap': (o1 / c0 - 1) * 100, 'oc': (c1 / o1 - 1) * 100, 'cc': (c1 / c0 - 1) * 100, 'cc5': None}
        if i + 5 < len(bars) and not any(bars[k][0] in exdiv for k in range(i + 1, i + 6)):
            r['cc5'] = (bars[i + 5][2] / c0 - 1) * 100
        rows.append(r)
    return rows


def welch(a, b):
    if len(a) < 2 or len(b) < 2:
        return float('nan')
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    va = sum((x - ma) ** 2 for x in a) / (len(a) - 1)
    vb = sum((x - mb) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return (ma - mb) / se if se > 0 else float('nan')


def p_two(t):
    return math.erfc(abs(t) / math.sqrt(2)) if t == t else 1.0


def bh(ps):
    m = len(ps)
    o = sorted(range(m), key=lambda i: ps[i])
    q = [1.0] * m
    run = 1.0
    for r in range(m - 1, -1, -1):
        i = o[r]
        run = min(run, ps[i] * m / (r + 1))
        q[i] = min(1.0, run)
    return q


def analyze(rows):
    out = []
    for st in STATES:
        sel = [r for r in rows if r['st'] == st]
        if len(sel) < 10:
            out.append({'st': st, 'n': len(sel)})
            continue
        for k in OUTS:
            a = [r[k] for r in sel if r[k] is not None]
            b = [r[k] for r in rows if r[k] is not None and r['st'] != st]
            allv = [r[k] for r in rows if r[k] is not None]
            if len(a) < 10:
                continue
            ma, mall = sum(a) / len(a), sum(allv) / len(allv)
            t = welch(a, b)
            yrs = {}
            for r in sel:
                if r[k] is not None:
                    yrs.setdefault(r['d'][:4], []).append(r[k])
            base_y = {}
            for r in rows:
                if r[k] is not None:
                    base_y.setdefault(r['d'][:4], []).append(r[k])
            ydiff = {y: sum(v) / len(v) - sum(base_y[y]) / len(base_y[y]) for y, v in yrs.items() if len(v) >= 3}
            dirn = STATE_DIR[st]
            same = sum(1 for v in ydiff.values() if (v > 0) == (dirn > 0)) if dirn else None
            half = len(sel) // 2
            h1 = [r[k] for r in sel[:half] if r[k] is not None]
            h2 = [r[k] for r in sel[half:] if r[k] is not None]
            hit = sum(1 for x in a if (x > 0) == (dirn > 0)) / len(a) * 100 if dirn else None
            base_hit = sum(1 for x in allv if (x > 0) == (dirn > 0)) / len(allv) * 100 if dirn else None
            out.append({'st': st, 'k': k, 'n': len(a), 'mean': ma, 'all': mall, 'diff': ma - mall, 't': t, 'p': p_two(t),
                        'yr': [same, len(ydiff)] if dirn else None, 'years': ydiff,
                        'h1': (sum(h1) / len(h1) - mall) if h1 else None, 'h2': (sum(h2) / len(h2) - mall) if h2 else None,
                        'hit': hit, 'base_hit': base_hit})
    qs = bh([x['p'] for x in out if 'p' in x])
    j = 0
    for x in out:
        if 'p' in x:
            x['q'] = qs[j]
            j += 1
    return out


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return None


def main():
    outp = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else None
    fm = load(FI_MKT)
    fut = (fm or {}).get('fut') or {}
    b = load(DATA / '_bench0050.json') or []
    dv = load(DATA / '_div0050.json') or {}
    divs = ((dv.get('d') or dv).get('0050') or {}).get('h') or []
    if len(fut) < 500:
        print(f'❌ 外資台指期只有 {len(fut)} 天(FI_MKT={FI_MKT})→ ⛔ 不跑')
        return 1
    bars = sorted((d10(x['date']), float(x.get('open') or 0), float(x.get('close') or 0)) for x in b if float(x.get('close') or 0) > 0)
    if len(bars) < 2000 or not any(o > 0 for _d, o, _c in bars):
        print(f'❌ 0050 只有 {len(bars)} 根或沒有開盤價 → ⛔ 不跑')
        return 1
    if not divs:
        print('❌ 讀不到 0050 除息日 → 除息那天的跳空會被當成訊號,⛔ 不跑')
        return 1
    exdiv = {d10(x[0]) for x in divs}
    fut = {d10(k): v for k, v in fut.items()}
    rows = build_rows(fut, bars, exdiv)
    print(f'🏦 外資台指期 {min(fut)} ~ {max(fut)}({len(fut)} 天)・對到 0050 {len(rows)} 天(剔除隔天除息)')
    cnt = {st: sum(1 for r in rows if r['st'] == st) for st in STATES}
    print('   狀態天數:' + ' ・'.join(f'{STATE_NAME[s].split("(")[0]} {cnt[s]}' for s in STATES))
    res = analyze(rows)
    print(f'\n{"狀態":<18}{"結果":<10}{"n":>5}{"平均%":>8}{"全部%":>8}{"差pp":>7}{"t":>6}{"q":>7}{"同向年":>8}{"前半":>7}{"後半":>7}{"方向對%":>8}{"基準%":>7}')
    for x in res:
        if 'k' not in x:
            print(f'{STATE_NAME[x["st"]][:16]:<18}(n={x["n"]} 太少)')
            continue
        yr = f'{x["yr"][0]}/{x["yr"][1]}' if x['yr'] else '—'
        hit = f'{x["hit"]:.1f}' if x['hit'] is not None else '—'
        bhit = f'{x["base_hit"]:.1f}' if x['base_hit'] is not None else '—'
        print(f'{STATE_NAME[x["st"]][:16]:<18}{OUT_NAME[x["k"]]:<10}{x["n"]:>5}{x["mean"]:>+8.2f}{x["all"]:>+8.2f}{x["diff"]:>+7.2f}{x["t"]:>6.1f}{x["q"]:>7.3f}{yr:>8}'
              f'{(x["h1"] or 0):>+7.2f}{(x["h2"] or 0):>+7.2f}{hit:>8}{bhit:>7}')
    if outp:
        Path(outp).write_text(json.dumps({'from': min(fut), 'to': max(fut), 'n': len(rows), 'cnt': cnt, 'res': res}, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'💾 {outp}')
    return 0


def selftest():
    import random
    bad = []

    def ok(name, c, x=''):
        print(f"  {'✅' if c else '❌'} {name}{(' ・' + str(x)[:200]) if not c else ''}")
        if not c:
            bad.append(name)
    # ① 規則跟 App 同一個判斷順序
    h = [0] * 15 + [-9000]
    ok('① 5 日 ≤ −8,000 → 急遽加空(優先於位階)', fut_state(h) == 'danger', fut_state(h))
    ok('① 5 日 ≥ +8,000 → 大幅回補', fut_state([0] * 15 + [9000]) == 'good_chg')
    h2 = list(range(0, 20000, 1000)) + [500]          # 位階低但 5 日 −14,500 → 仍是急遽加空
    ok('① 位階低 + 5 日大減 → 急遽加空(順序同 App)', fut_state(h2) == 'danger', fut_state(h2))
    h3 = [i * 100 for i in range(20)] + [0]            # 5 日 −1,900、位階 0% → 空單近期最重
    ok('① 5 日小減、位階 0% → 空單近期最重', fut_state(h3) == 'warn_pct', fut_state(h3))
    ok('① 少於 6 天、少於 8 個值 → 不判(None)', fut_state([1, 2, 3]) is None)
    # ② 合成資料:急遽加空隔天開盤 −0.8%、其他雜訊 → 抓得到;除息日剔除;打亂 → 抓不到
    random.seed(5)
    days, bars, fut = [], [], {}
    px, net = 100.0, 0.0
    import datetime as _dt
    d0 = _dt.date(2018, 6, 1)
    while len(days) < 1600:
        if d0.weekday() < 5:
            days.append(d0.isoformat())
        d0 += _dt.timedelta(days=1)
    for i, d in enumerate(days):
        net += random.choice([-2500, -1500, 0, 1500, 2500])
        fut[d] = net
    st_by = {}
    hist = []
    for d in days:
        hist.append(fut[d])
        st_by[d] = fut_state(hist)
    exdiv = {days[200], days[700]}
    for i, d in enumerate(days):
        prev_st = st_by[days[i - 1]] if i else None
        gap = random.gauss(0, 0.6) + (-0.8 if prev_st == 'danger' else 0)
        if d in exdiv:
            gap -= 5
        o = px * (1 + gap / 100)
        c = o * (1 + random.gauss(0, 0.8) / 100)
        bars.append((d, o, c))
        px = c
    rows = build_rows(fut, bars, exdiv)
    res = analyze(rows)
    g = next((x for x in res if x.get('st') == 'danger' and x.get('k') == 'gap'), {})
    ok('② 合成:急遽加空 → 隔天開盤 −0.8pp 抓得到(q ≤ 0.05)', g.get('diff', 0) < -0.5 and g.get('q', 1) <= 0.05, g)
    ok('② 隔天除息的那兩天被剔除', not any(bars[[b[0] for b in bars].index(r['d']) + 1][0] in exdiv for r in rows))
    nd = next((x for x in res if x.get('st') == 'neutral' and x.get('k') == 'gap'), {})
    ok('② 沒效果的狀態(區間震盪)不顯著', nd.get('q', 0) > 0.05 or abs(nd.get('diff', 9)) < 0.2, nd)
    # ③ 決定性對照:狀態打亂 → 急遽加空不可以再顯著
    sts = [r['st'] for r in rows]
    random.shuffle(sts)
    rows2 = [dict(r, st=s) for r, s in zip(rows, sts)]
    g2 = next((x for x in analyze(rows2) if x.get('st') == 'danger' and x.get('k') == 'gap'), {})
    ok('③ 決定性對照:狀態打亂 → 不顯著(⛔ 不是寫死會過)', g2.get('q', 0) > 0.05, g2)
    # ④ 零前視:狀態只用到當天為止(把明天的值改掉,今天的狀態不變)
    hh = [fut[d] for d in days[:300]]
    s_before = fut_state(hh)
    hh2 = hh + [hh[-1] - 50000]
    ok('④ 零前視:多加明天的值不會改變今天的狀態', fut_state(hh) == s_before and fut_state(hh2[:300]) == s_before)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
