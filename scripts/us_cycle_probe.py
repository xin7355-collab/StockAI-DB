#!/usr/bin/env python3
"""🇺🇸 us_cycle_probe.py —— 標普 500 1928 起:大跌是不是「幾年一次」(V81.0.2,使用者 11/06 問 5 的長資料版)

台股只有 26 年(≥20% 那一級十次上下)→ 拿美股近百年同一套方法再驗一次「有沒有週期」。
切段方法跟 scripts/crash_cycle_probe.mjs 的 zigzag 一字不差:收盤從高點跌 ≥X% 進入,從最低收盤反彈 ≥X% 結束。
每一級:幾段、相鄰兩段開始的間隔(年)、變異係數 CV(1 ≈ 隨機;接近 0 = 很規律;> 1 = 成串),
vs「次數一樣、時間隨機」模擬 2,000 次;間隔落在 2.5~3.5 年的比例 vs 隨機;距上一段開始幾年 → 一年內又來一段的比例。
前後兩半(1928~1976 / 1977~)各算一次看穩不穩。⛔ 只讀 Yahoo、只印 log、不寫任何檔。

跑法:python3 scripts/us_cycle_probe.py            (要網路,Actions macro_probe which=us_cycle)
      python3 scripts/us_cycle_probe.py --selftest
"""
import math
import random
import sys


def zigzag(c, X):
    out, pk, tr = [], 0, -1
    for i in range(1, len(c)):
        if tr < 0:
            if c[i] > c[pk]:
                pk = i
            elif c[i] <= c[pk] * (1 - X / 100):
                tr = i
        else:
            if c[i] < c[tr]:
                tr = i
            elif c[i] >= c[tr] * (1 + X / 100):
                out.append({'pk': pk, 'tr': tr, 'end': i, 'depth': (c[tr] / c[pk] - 1) * 100, 'open': False})
                pk, tr = i, -1
    if tr >= 0:
        out.append({'pk': pk, 'tr': tr, 'end': None, 'depth': (c[tr] / c[pk] - 1) * 100, 'open': True})
    for e in out:
        e['rec'] = next((k for k in range(e['tr'] + 1, len(c)) if c[k] >= c[e['pk']]), None)
    return out


def yrs(d):
    return int(d[:4]) + (int(d[5:7]) - 1) / 12 + (int(d[8:10]) - 1) / 365


def _cv(a):
    m = sum(a) / len(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / len(a)) / m


def cycle_stats(ty, t0, t1, seed=5, sims=2000):
    iv = [ty[k] - ty[k - 1] for k in range(1, len(ty))]
    if len(iv) < 2:
        return {'n': len(ty), 'iv': iv}
    win = lambda a: sum(1 for x in a if 2.5 <= x <= 3.5) / len(a)
    cv, w, R = _cv(iv), win(iv), random.Random(seed)
    le = ge = 0
    ws, cvs = 0.0, []
    for _ in range(sims):
        t = sorted(t0 + R.random() * (t1 - t0) for _ in ty)
        v = [t[k] - t[k - 1] for k in range(1, len(t))]
        c2 = _cv(v)
        cvs.append(c2)
        le += c2 <= cv
        ge += c2 >= cv
        ws += win(v)
    cvs.sort()
    s = sorted(iv)
    med = s[len(s) // 2] if len(s) % 2 else (s[len(s) // 2 - 1] + s[len(s) // 2]) / 2
    return {'n': len(ty), 'iv': [round(x, 2) for x in iv], 'mean': round(sum(iv) / len(iv), 2), 'med': round(med, 2),
            'min': round(min(iv), 2), 'max': round(max(iv), 2), 'cv': round(cv, 2), 'cvMed': round(cvs[sims // 2], 2),
            'cv5': round(cvs[int(sims * 0.05)], 2), 'cv95': round(cvs[int(sims * 0.95)], 2),
            'pReg': round(le / sims, 3), 'pClu': round(ge / sims, 3), 'win3': round(w * 100, 1), 'win3Sim': round(ws / sims * 100, 1)}


def hazard(d, c, legs, H=252, buckets=(0, 1, 2, 3, 4, 6, 99)):
    starts = [L['pk'] for L in legs]
    inleg = bytearray(len(c))
    for L in legs:
        for k in range(L['pk'], (L['end'] if L['end'] is not None else len(c) - 1) + 1):
            inleg[k] = 1
    B = [{'lo': buckets[k], 'hi': buckets[k + 1], 'n': 0, 'hit': 0} for k in range(len(buckets) - 1)]
    si = 0
    for i in range(len(c) - H):
        while si + 1 < len(starts) and starts[si + 1] <= i:
            si += 1
        if inleg[i] or not starts or starts[0] > i:
            continue
        last = starts[si]
        t = yrs(d[i]) - yrs(d[last])
        b = next((x for x in B if x['lo'] <= t < x['hi']), None)
        if not b:
            continue
        b['n'] += 1
        if any(i < s <= i + H for s in starts[si + 1:si + 4]):
            b['hit'] += 1
    for b in B:
        b['rate'] = round(b['hit'] / b['n'] * 100, 1) if b['n'] else None
    return B


def report(d, c, tag):
    print(f'\n════ {tag}:{d[0]} ~ {d[-1]}({len(c)} 天,收盤)════')
    t0, t1 = yrs(d[0]), yrs(d[-1])
    for X in (10, 15, 20):
        L = zigzag(c, X)
        closed = [e for e in L if not e['open']]
        deps = sorted(e['depth'] for e in closed)
        print(f'\n── 跌 ≥{X}%:{len(L)} 段(每 {round((t1 - t0) / max(1, len(L)), 2)} 年一次)・跌幅中位 {round(deps[len(deps) // 2], 1) if deps else "—"}% ──')
        if X == 20:
            for e in L:
                rec = d[e['rec']] if e['rec'] is not None else ('還在跌段裡' if e['open'] else '還沒回到')
                print(f"  {d[e['pk']]} → {d[e['tr']]}  {round(e['depth'], 1):>6}%  跌了 {e['tr'] - e['pk']:>4} 天  回到高點 {rec}")
        cs = cycle_stats([yrs(d[e['pk']]) for e in L], t0, t1)
        if 'cv' not in cs:
            print('  次數太少,不算週期')
            continue
        print(f"  間隔(年)平均 {cs['mean']} ・中位 {cs['med']} ・最短 {cs['min']} ・最長 {cs['max']}")
        print(f"  變異係數 {cs['cv']}(隨機模擬中位 {cs['cvMed']},90% 落在 {cs['cv5']}~{cs['cv95']})・比隨機更規律 p={cs['pReg']} ・比隨機更成串 p={cs['pClu']}")
        print(f"  間隔落在 2.5~3.5 年:{cs['win3']}%(隨機 {cs['win3Sim']}%)")
        if X == 20:
            print('  間隔明細:' + ' / '.join(str(x) for x in cs['iv']))
        hz = hazard(d, c, L)
        print('  距上一段開始幾年 → 一年內又來一段:' + ' ・'.join(
            f"{b['lo']}~{'' if b['hi'] == 99 else b['hi']}年 {b['rate'] if b['rate'] is not None else '—'}%({b['n']}天)" for b in hz))


def selftest():
    ok = bad = 0

    def t(cond, m):
        nonlocal ok, bad
        print(('  ✅ ' if cond else '  ❌ ') + m)
        if cond:
            ok += 1
        else:
            bad += 1
    c = [100, 95, 80, 70, 75, 90, 100, 130, 120, 110, 125, 140]
    z20, z10 = zigzag(c, 20), zigzag(c, 10)
    t(len(z20) == 1 and z20[0]['pk'] == 0 and z20[0]['tr'] == 3 and abs(z20[0]['depth'] + 30) < 1e-9 and z20[0]['rec'] == 6,
      '① ≥20% 一段:第 0 → 3 天、−30%、第 6 天回到高點(跟 crash_cycle_probe.mjs 同一組測資)')
    t(len(z10) == 2 and z10[1]['pk'] == 7 and z10[1]['tr'] == 9, '② ≥10% 兩段,第二段第 7 → 9 天')
    zo = zigzag([100, 110, 85, 80, 82], 20)
    t(len(zo) == 1 and zo[0]['open'] and zo[0]['tr'] == 3 and zo[0]['rec'] is None, '③ 還在跌段裡 → open')
    reg = cycle_stats([2000, 2003, 2006, 2009, 2012, 2015, 2018, 2021, 2024], 2000, 2026)
    t(reg['cv'] < 0.05 and reg['pReg'] < 0.01 and reg['win3'] == 100, f"④ 每 3 年一次 → CV {reg['cv']}、比隨機更規律 p={reg['pReg']}")
    R = random.Random(99)
    ps = cycle_stats(sorted(1928 + R.random() * 98 for _ in range(26)), 1928, 2026)
    t(ps['pReg'] > 0.05 and ps['pClu'] > 0.05, f"⑤ 隨機 26 次不會被判成規律或成串(p {ps['pReg']} / {ps['pClu']})")
    print(f"\n{'❌' if bad else '✅'} selftest {ok}/{ok + bad}")
    return 1 if bad else 0


def main():
    try:
        import yfinance as yf
        h = yf.Ticker('^GSPC').history(period='max', auto_adjust=False)
    except Exception as e:
        print(f'❌ 抓不到 ^GSPC:{e!r} → 沒驗到')
        return 1
    h = h[h['Close'] > 0]
    if len(h) < 20000:
        print(f'❌ ^GSPC 只有 {len(h)} 天(預期 1927 起 ≥ 24,000 天)→ 沒驗到')
        return 1
    d = [x.strftime('%Y-%m-%d') for x in h.index]
    c = [float(x) for x in h['Close']]
    report(d, c, '標普 500 全部')
    k = next(i for i, x in enumerate(d) if x >= '1977-01-01')
    report(d[:k], c[:k], '前半 1928~1976')
    report(d[k:], c[k:], '後半 1977~')
    return 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
