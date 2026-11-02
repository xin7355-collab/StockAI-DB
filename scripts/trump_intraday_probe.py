#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🗽⏱️ trump_intraday_probe.py —— 川普在「台股盤中」發文 → 0050 / 台積電接下來 30 分 / 60 分 / 到收盤會不會動比較大?(V80.2.1,評估紀錄 53 第 4-B 項)

評估紀錄㊵(2026-09-27)只量了日線:盤中發的那幾則被剔除(開盤那一刻還沒發生),而那正是唯一可能「台股還沒反映」的時間。
這支用 5 分 K 補上:
  事件  = 台北 09:00~13:20 發的、原創(⛔ 轉貼)、有分類(lib_trump 五類;另列「任何原創發文」當對照)
  進場  = 發文那一分鐘所在那根 5 分 K 的**下一根開盤**(⛔ 同一根:那根有一部分在發文之前)
  出場  = 30 分(進場那根往後第 6 根收盤)/ 60 分 / 13:25 那根收盤(≈ 收盤)
  同一天 30 分鐘內多則只算第一則
  看兩件事:① 動的幅度 |漲跌| 有沒有比較大(波動)② 方向(漲跌平均)
  對照 = 同一個時間點(同一根 K)、前後 120 個交易日裡「那段時間沒有發文」的日子;
  安慰劑 = 下一個交易日同一個時間點(那段時間也沒發文)→ 應該 ≈ 0
  成本(只在問「能不能拿來賺」時用):0050 來回 0.385%、台積電當沖 0.435%;一類 < 30 次不下結論
資料:K5 = 5 分 K 資料夾(冒號隔開,前面的優先:kbar5_deep / kbar5,每月一檔 YYYY-MM.json.gz,hm = 台北分鐘)
      DEEP = trump_deep 資料夾(trump_posts_miner.py 的研究存檔)
      0050 2025-06-11~17 分割停牌沒有 5 分 K、2021-10-31 那筆是假日垃圾 → 照資料有沒有那一天自動跳過
跑法:K5=$S/k5d/kbar5_deep:$S/k5/kbar5 DEEP=$S/td/trump_deep OUT=ti.json python3 scripts/trump_intraday_probe.py
      python3 scripts/trump_intraday_probe.py --selftest
"""
import gzip
import json
import math
import os
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib_trump import CLS, classify, tw_slot  # noqa: E402

SYMS = ('0050', '2330')
COST = {'0050': 0.385, '2330': 0.435}
HORIZ = (('30m', 30), ('60m', 60), ('close', None))
OPEN_HM, LAST_ENTRY, LAST_BAR = 540, 800, 805
CTRL_WIN, MIN_N = 120, 30
BIG = {'30m': 0.3, '60m': 0.5, 'close': 0.8}      # 「動很大」的門檻(%):發生率用


def mean(a):
    return sum(a) / len(a) if a else float('nan')


def tstat(a):
    n = len(a)
    if n < 3:
        return float('nan')
    m = mean(a)
    v = sum((x - m) ** 2 for x in a) / (n - 1)
    return m / math.sqrt(v / n) if v > 0 else float('nan')


def load_k5(spec, syms=SYMS):
    """→ {sym: {day: {hm: (o,h,l,c,v)}}};前面的資料夾優先(同一天不覆蓋)"""
    out = {s: {} for s in syms}
    for d in [x for x in (spec or '').split(':') if x]:
        for f in sorted(Path(d).glob('*.json.gz')):
            try:
                j = json.load(gzip.open(f, 'rt', encoding='utf-8'))
            except Exception:  # noqa: BLE001
                continue
            for day, e in (j.get('d') or {}).items():
                try:
                    wd = date.fromisoformat(day).weekday()
                except ValueError:
                    continue
                if wd >= 5:
                    continue                                   # 假日的垃圾(2021-10-31 那筆)
                for s in syms:
                    bars = (e.get('k') or {}).get(s)
                    if not bars or day in out[s]:
                        continue
                    out[s][day] = {int(b[0]): tuple(float(x) for x in b[1:6]) for b in bars if len(b) >= 6}
    return out


def entry_bar(hm):
    """發文在台北 hm 分 → 下一根 5 分 K 的開始時間(⛔ 同一根)"""
    return (hm // 5 + 1) * 5


def ret(day_bars, E, H):
    """E 那根開盤進 → H 分鐘後那根收盤出(H=None → 13:25 那根);缺 K → None"""
    if E not in day_bars:
        return None
    xb = LAST_BAR if H is None else E + H - 5
    if xb > LAST_BAR or xb not in day_bars:
        return None
    o = day_bars[E][0]
    c = day_bars[xb][3]
    return (c / o - 1) * 100 if o > 0 else None


def events_from(posts, groups):
    """posts = [(utc iso, 內文, 轉貼?)] → {組名: [(day, E)]}(同一天 30 分鐘內只算第一則)"""
    raw = {g: {} for g in groups}
    for t, x, rt in posts:
        if rt or not x:
            continue
        s = tw_slot(t)
        if not s or s[2] != 'in' or s[1] > LAST_ENTRY:
            continue
        day, hm = s[0], s[1]
        cls = classify(x)
        for g in groups:
            if g == 'all' or (g == 'any' and cls) or g in cls:
                raw[g].setdefault(day, []).append(entry_bar(hm))
    out = {}
    for g, by in raw.items():
        ev = []
        for day, es in by.items():
            last = -10 ** 9
            for E in sorted(es):
                if E - last >= 30:
                    ev.append((day, E))
                    last = E
        out[g] = sorted(ev)
    return out


def busy_map(posts):
    """{day: [發文的台北分鐘]}(對照組要避開這些時間)"""
    m = {}
    for t, x, rt in posts:
        s = tw_slot(t)
        if s and s[2] == 'in':
            m.setdefault(s[0], []).append(s[1])
    return m


def study(K, evs, busy, H, hk, cost, rng):
    days = sorted(K)
    pos = {d: i for i, d in enumerate(days)}
    span = 30 if H is None else H

    def quiet(day, E):
        return all(not (E - 30 <= m < E + (LAST_BAR + 5 - E if H is None else span)) for m in busy.get(day, []))

    rows, plac = [], []
    for day, E in evs:
        if day not in pos:
            continue
        r = ret(K[day], E, H)
        if r is None:
            continue
        i = pos[day]
        ctl = [ret(K[days[j]], E, H) for j in range(max(0, i - CTRL_WIN), min(len(days), i + CTRL_WIN + 1))
               if j != i and quiet(days[j], E)]
        ctl = [x for x in ctl if x is not None]
        if len(ctl) < 20:
            continue
        ma, mr = mean([abs(x) for x in ctl]), mean(ctl)
        big = mean([1.0 if abs(x) > BIG[hk] else 0.0 for x in ctl])
        rows.append((day, r, abs(r) - ma, r - mr, 1.0 if abs(r) > BIG[hk] else 0.0, big, ma))
        if i + 1 < len(days) and quiet(days[i + 1], E):
            rp = ret(K[days[i + 1]], E, H)
            if rp is not None:
                plac.append(abs(rp) - ma)
    if len(rows) < 5:
        return {'n': len(rows)}
    da, ds = [x[2] for x in rows], [x[3] for x in rows]
    yrs = {}
    for x in rows:
        yrs.setdefault(x[0][:4], []).append(x[2])
    return {'n': len(rows), 'abs': round(mean([abs(x[1]) for x in rows]), 3), 'absCtl': round(mean([x[6] for x in rows]), 3),
            'dAbs': round(mean(da), 3), 'tAbs': round(tstat(da), 2), 'dSig': round(mean(ds), 3), 'tSig': round(tstat(ds), 2),
            'big': round(mean([x[4] for x in rows]) * 100, 1), 'bigCtl': round(mean([x[5] for x in rows]) * 100, 1),
            'plac': {'n': len(plac), 'dAbs': round(mean(plac), 3) if plac else None, 't': round(tstat(plac), 2) if len(plac) >= 3 else None},
            'yrs': {y: [len(v), round(mean(v), 3)] for y, v in sorted(yrs.items())}, 'cost': cost,
            'from': rows[0][0], 'to': rows[-1][0]}


def run(K5, posts, log=print, seed=11):
    groups = ['any'] + list(CLS) + ['all']
    evs = events_from(posts, groups)
    busy = busy_map(posts)
    out = {}
    for s in SYMS:
        K = K5.get(s) or {}
        for g in groups:
            for hk, H in HORIZ:
                out[f'{s}|{g}|{hk}'] = study(K, evs[g], busy, H, hk, COST[s], random.Random(seed))
    return out, {g: len(v) for g, v in evs.items()}


def main():
    k5, deep = os.environ.get('K5'), os.environ.get('DEEP')
    if not k5 or not deep:
        sys.exit('需要 K5 與 DEEP')
    from trump_posts_miner import load_deep   # noqa: E402
    p, _, _ = load_deep(deep, log=print)
    posts = [(x['t'], x.get('x') or '', bool(x.get('rt'))) for x in p.values()]
    K5 = load_k5(k5)
    for s in SYMS:
        ds = sorted(K5[s])
        print(f'{s} 5 分 K {ds[0]}~{ds[-1]}({len(ds)} 天)')
    out, cnt = run(K5, posts)
    print(f'盤中發文(09:00~13:20、原創、30 分鐘內只算第一則):{cnt}')
    zh = {'any': '有分類(任一類)', 'all': '任何原創發文', **{c: c for c in CLS}}
    for key, r in out.items():
        s, g, hk = key.split('|')
        if r.get('n', 0) < 5:
            print(f'{s} {zh[g]:<10} {hk:<5} n={r.get("n")}(太少)')
            continue
        flag = '' if r['n'] >= MIN_N else '(⚠️ <30 次,不下結論)'
        print(f'{s} {zh[g]:<10} {hk:<5} n={r["n"]:>3}  |動| {r["abs"]:.3f}% vs 平常 {r["absCtl"]:.3f}%(差 {r["dAbs"]:+.3f}、t {r["tAbs"]:+.2f})'
              f'  動超過 {BIG[hk]}% 的比例 {r["big"]}% vs {r["bigCtl"]}%  方向 {r["dSig"]:+.3f}(t {r["tSig"]:+.2f})'
              f'  安慰劑 {r["plac"]}  {flag}')
    o = os.environ.get('OUT')
    if o:
        Path(o).write_text(json.dumps({'counts': cnt, 'big': BIG, 'res': out}, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'→ {o}')


# ───────────────────────── selftest ─────────────────────────
def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:300]}'))
        if not cond:
            fails.append(name)

    rnd = random.Random(5)
    days, d0 = [], date(2025, 1, 6)
    while len(days) < 400:
        if d0.weekday() < 5:
            days.append(d0.isoformat())
        d0 += timedelta(days=1)

    def make(effect, post_days):
        """每天 55 根 5 分 K;發文那天 10:05~10:35 這幾根放大 effect 倍(只在進場之後)"""
        K = {}
        for day in days:
            bars, c = {}, 100.0
            for hm in range(540, 815, 5):
                o = c
                amp = effect if (day in post_days and 605 <= hm < 635) else 1.0
                c = o * (1 + rnd.gauss(0, 0.001) * amp)
                bars[hm] = (o, max(o, c), min(o, c), c, 100.0)
            K[day] = bars
        return K

    pdays = set(days[100:380:4])                                    # 70 天在台北 10:02 發文
    posts = [(f'{d}T02:02:00Z', 'China must pay TARIFFS', False) for d in pdays]   # 台北 10:02 → 進場 10:05
    K = make(4.0, pdays)
    out, cnt = run({'0050': K, '2330': K}, posts, log=lambda *_: None)
    r = out['0050|any|30m']
    ok('① 埋「發文後 30 分鐘動 4 倍大」→ |動| 明顯比平常大(t > 3)', r.get('tAbs', 0) > 3 and r['abs'] > r['absCtl'] * 2, r)
    ok('① 安慰劑(隔天同一時間)≈ 0', abs(r['plac']['dAbs']) < r['dAbs'] / 3, r['plac'])
    K0 = make(1.0, pdays)
    out0, _ = run({'0050': K0, '2330': K0}, posts, log=lambda *_: None)
    r0 = out0['0050|any|30m']
    ok('② 沒埋效果 → 差 ≈ 0(|t| < 3)', abs(r0.get('tAbs', 0)) < 3, r0)
    # ③ 進場是下一根:效果只放在發文那一根(10:00~10:05)→ ⛔ 算進來
    Kx = {}
    for day in days:
        bars, c = {}, 100.0
        for hm in range(540, 815, 5):
            o = c
            c = o * (1 + (0.02 if (day in pdays and hm == 600) else rnd.gauss(0, 0.001)))
            bars[hm] = (o, max(o, c), min(o, c), c, 100.0)
        Kx[day] = bars
    outx, _ = run({'0050': Kx, '2330': Kx}, posts, log=lambda *_: None)
    ok('③ 發文那一根的漲跌 ⛔ 算(進場是下一根開盤)', abs(outx['0050|any|30m'].get('dAbs', 9)) < 0.1, outx['0050|any|30m'])
    ok('③ entry_bar:10:02 → 10:05、10:05 → 10:10', entry_bar(602) == 605 and entry_bar(605) == 610)
    # ④ 30 分鐘內兩則只算一則;轉貼 / 盤後 ⛔ 算
    ev = events_from([('2025-03-03T02:02:00Z', 'China', False), ('2025-03-03T02:20:00Z', 'tariffs', False),
                      ('2025-03-03T02:40:00Z', 'tariffs', False), ('2025-03-03T02:50:00Z', 'RT @x China', True),
                      ('2025-03-03T06:00:00Z', 'China', False)], ['any'])['any']
    ok('④ 去重 / 轉貼 / 盤後', ev == [('2025-03-03', 605), ('2025-03-03', 645)], ev)
    ok('④ 13:20 以後 ⛔ 進場', events_from([('2025-03-03T05:22:00Z', 'China', False)], ['any'])['any'] == [])
    print(f'\n{"✅ 全部通過" if not fails else "❌ " + str(len(fails)) + " 條沒過"}')
    return 0 if not fails else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    main()
