#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""👑 領頭羊短線輪動 —— Python 端唯一一份規則(V77.9.3 從 auto_trade.py 搬出來共用)

用的人:
  ・auto_trade.py(本機自動下單,⛔ 永遠不進 GitHub Actions)
  ・pick_snapshot.py --leader(採礦:每天把名單存進 pick_history.json,給成績單事後結算)

⛔ 跟 App `index.html` 的 `_LEADER_EDGE.rule` / `.anchor` / `_leaderCalc` / `_leaderClock` 一字不差
   (scripts/test_leaderdeck.mjs 跨檔 + 跨語言比對)。改一邊要改另一邊。
⛔ 這支檔案只放純函式,⛔ 不可 import 任何下單 / 金鑰相關的東西。
"""

LEADER_RULE = {'U': 100, 'N': 5, 'R': 10, 'L': 10, 'hyst': 2}
LEADER_ANCHOR = '2026-09-24'


def leader_calc(D, U=None, N=None):
    """App `_leaderCalc` 的 Python 版(⛔ 改一邊要改另一邊)。回 dict 或 {'err': ...}"""
    R = LEADER_RULE
    U, N = U or R['U'], N or R['N']
    if not D or not D.get('cols') or not D.get('rows'):
        return {'err': 'nodata'}
    CI = {c: i for i, c in enumerate(D['cols'])}
    if 'chg10' not in CI or 'amt20' not in CI:
        return {'err': 'notyet'}
    g = lambda v, k: (v[CI[k]] if k in CI and CI[k] < len(v) else None)
    rows = []
    for sym, v in D['rows'].items():
        if not (len(sym) == 4 and sym.isdigit()) or sym.startswith('00') or (g(v, 'etf') is not None and float(g(v, 'etf') or 0) == 1):
            continue
        try:
            amt20, c = float(g(v, 'amt20') or 0), float(g(v, 'c') or 0)
        except Exception:
            continue
        if not (amt20 > 0 and c > 0):
            continue
        f = lambda k: (None if g(v, k) is None else float(g(v, k)))
        rows.append({'sym': sym, 'amt20': amt20, 'c': c, 'chg10': f('chg10'), 'b20': f('b20'), 'b60': f('b60'),
                     'chg': f('chg'), 'lim': int(g(v, 'lim') or 0), 'att': int(g(v, 'att') or 0)})
    # ⚠️ 排序要跟 JS 一樣穩定:JS Array.sort 是穩定排序、Python sorted 也是 —— 同分時保持 rows 的原順序(= Object.entries 順序)
    rows.sort(key=lambda r: -r['amt20'])
    pool = rows[:U]
    ok = [r for r in pool if r['b20'] is not None and r['b60'] is not None and r['chg10'] is not None and r['b20'] > 0 and r['b20'] < r['b60']]
    ok.sort(key=lambda r: -r['chg10'])
    for i, r in enumerate(ok):
        r['rank'] = i + 1
    return {'pool': pool, 'ranked': ok[:N * R['hyst']], 'buy': ok[:N], 'passed': len(ok), 'n': len(pool),
            'date': D.get('data_date') or '', 'all': {r['sym']: r for r in ok}, 'poolset': {r['sym'] for r in pool}}


def leader_clock(dates, data_date, anchor=None):
    """App `_leaderClock` 的 Python 版:錨點那天 = 第 1 天(換倉日),每 R 個交易日一次。回 (day, is_rebal, left)"""
    R = LEADER_RULE['R']
    anchor = anchor or LEADER_ANCHOR
    day = sum(1 for d in dates if anchor <= d <= data_date)
    if not day:
        return 0, False, None
    k = (day - 1) % R
    return day, k == 0, (0 if k == 0 else R - k)
