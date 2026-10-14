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

LEADER_RULE = {'U': 100, 'N': 5, 'R': 10, 'L': 10, 'hyst': 2, 'pos': 85}
# 📍 V78.0.5 'pos' = 買進多一道「一年位置 ≥ 85%」(screener 的 pos252:收盤在近一年最低~最高之間的位置)。
#    ⛔ 只擋**買進**;續抱 / 賣出照舊(前 N×hyst 名續抱)。位置不夠的跳過、改買下一名(可能是第 10 名以後)。
#    回測 leader_probe(V78.0.5):加位置門檻 AI 時代 / 16 年 兩窗口 17 條配對 15/17、17/17;同通過率隨機擋全輸。
#    🧭 V79.2.4 引擎修尺(趨勢過濾兩把尺)後重算:AI 時代 648 → 902%、16 年 3,924 → 6,687%(規則沒變;修尺前寫的是 760 → 953 / 3,176 → 6,783)。
#    換回舊規則:pos=0(auto_trade.py 用 LEADER_POS=0)。
LEADER_ANCHOR = '2026-09-24'
# 📚 V79.2.5 兩本帳(使用者:「依照你說的做」):錢平分兩本帳、換倉日錯開 4 個交易日,每本帳完全獨立(各自的持股 / 各自的錢)。
#    第 2 本帳的錨點 = 第 1 本錨點起第 5 個交易日(錯開 4 天)。回測 leader_probe books:2 bookOff:4(兩窗口 × 17 條):
#    中位不掉、最差那條 AI 603 → 761%、16 年 3,524 → 5,058%;錯開 3~7 天全部成立(高原);成本 ×2 仍成立。⚠️ 攤平「哪一天開始」的運氣,⛔ 不是新優勢。
#    📚 V79.2.6 使用者:「預設關閉」→ 預設一本帳;兩本帳(甲帳 = LEADER_ANCHOR、乙帳 = LEADER_ANCHOR2)要自己開(auto_trade.py 用 LEADER_BOOKS=2)。
LEADER_BOOKS = 1
LEADER_ANCHOR2 = '2026-10-02'


def leader_calc(D, U=None, N=None, pos=None):
    """App `_leaderCalc` 的 Python 版(⛔ 改一邊要改另一邊)。回 dict 或 {'err': ...}
    pos = 買進的一年位置門檻(None = LEADER_RULE['pos'];0 = 舊規則不看位置)"""
    R = LEADER_RULE
    U, N = U or R['U'], N or R['N']
    P = R['pos'] if pos is None else pos
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
                     'chg': f('chg'), 'lim': int(g(v, 'lim') or 0), 'att': int(g(v, 'att') or 0), 'pos': f('pos252')})
    # ⚠️ 排序要跟 JS 一樣穩定:JS Array.sort 是穩定排序、Python sorted 也是 —— 同分時保持 rows 的原順序(= Object.entries 順序)
    rows.sort(key=lambda r: -r['amt20'])
    pool = rows[:U]
    ok = [r for r in pool if r['b20'] is not None and r['b60'] is not None and r['chg10'] is not None and r['b20'] > 0 and r['b20'] < r['b60']]
    ok.sort(key=lambda r: -r['chg10'])
    for i, r in enumerate(ok):
        r['rank'] = i + 1
        r['posOk'] = (not P) or (r['pos'] is not None and r['pos'] >= P)   # 沒有位置資料 = 不買(⛔ 不猜)
    buy = [r for r in ok if r['posOk']][:N]
    return {'pool': pool, 'ranked': ok[:N * R['hyst']], 'buy': buy, 'passed': len(ok), 'n': len(pool), 'pos': P,
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


def leader_books_clock(dates, data_date, books=None, anchors=None):
    """📚 V79.2.5 兩本帳的時鐘(= App `_leadClk`):回 (book, day, is_rebal, left)。
    book = 'lead'(第 1 本)/ 'lead2'(第 2 本)= 今天換倉的那一本;都不是換倉日 → 下一個要換的那一本。
    books=1 → 跟 leader_clock 一模一樣(book 一律 'lead')。兩本錯開 1~R−1 天 → ⛔ 不會同一天換倉。"""
    books = LEADER_BOOKS if books is None else books
    anchors = anchors or ([LEADER_ANCHOR] if books == 1 else [LEADER_ANCHOR, LEADER_ANCHOR2])
    keys = ['lead', 'lead2'][:len(anchors)]
    cl = [leader_clock(dates, data_date, a) for a in anchors]
    for k, (day, reb, left) in zip(keys, cl):
        if reb:
            return k, day, reb, left
    live = [(left, k, day) for k, (day, reb, left) in zip(keys, cl) if day and left is not None]
    if not live:
        return keys[0], cl[0][0], cl[0][1], cl[0][2]
    left, k, day = min(live)
    return k, day, False, left
