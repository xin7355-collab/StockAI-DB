#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏧 fi_outflow_probe.py —— 「外資把台灣當提款機」的隔天,要不要跟著賣?(V80.2.1,評估紀錄 53 第 4-A 項)

問題(使用者 11/02:「外資一直賣台積電、台幣一直貶,是不是把台灣當提款機?」;同一天外資現貨賣超 735 億):
  外資大賣台積電 / 全市場大賣 / 台幣大貶 的隔天,0050 之後幾天是不是真的比較差?(= 跟著賣有沒有用)

事件(⛔ 用到未來的資料一律不行;門檻 = 過去 250 個交易日(⛔ 含當天、至少 120 個值)的百分位):
  A  外資賣台積電(2330 外資買賣超,股)在過去 250 天最多的 q%
  A2 同上但看「賣超 ÷ 當天成交量」
  B  外資現貨全市場賣超(fi_mkt_hist,億,上市)在過去 250 天最多的 q%
  C  台幣一天貶最多的 q%(us_hist 的 TWD=X:美股日期 u 的收盤 → 台北 u+1 早上才知道 → 第一個 > u 的台股日才能動作)
  D  (A 或 B)而且 同一天的台幣也在貶最多的 q%
  A / B 是收盤後才公布 → 「能動作的那天」s = 下一個台股交易日。
進出:s 開盤進 → 第 s+N−1 天收盤出(o)・s 收盤進 → 第 s+N 天收盤出(c);N = 5 / 10 / 20;0050 含息(_div0050)。
  0050 量 0 那幾天(2025-06-11~17 分割停牌)⛔ 當進場日。
對照:① 同期每一天都當進場日 ② 動能配對:同一年、前 20 天 0050 漲跌在同一個五分位的日子(扣掉這個平均)
     ③ 安慰劑:事件日期整批往後 / 往前挪 60 個交易日(應該 ≈ 0)。20 個交易日內同一種事件只算一次。
判定(「跟著賣有用」= 之後明顯比較差):動能配對差 < 0 且 t ≤ −2 ・前後半同號 ・逐年 ≥70% 的年份為負 ・
  拿掉任一年仍為負 ・幅度 > 成本 0.385%(0050 賣出再買回:手續費 0.1425%×2 + 證交稅 0.1%)・安慰劑 |t| < 2 ・
  門檻 1 / 2 / 5 / 10% 同號(高原)。⛔ 一關沒過就不算「有用」;反過來明顯比較好 = 「跟著賣反而錯」。

資料:DATA_DIR(d16m_fi:2330.json、_bench0050.json、_div0050.json)・FI_HIST(data/fi_mkt_hist.json)・US_HIST(data/us_hist.json)
跑法:DATA_DIR=$S/d16m_fi FI_HIST=data/fi_mkt_hist.json US_HIST=data/us_hist.json OUT=fo.json python3 scripts/fi_outflow_probe.py
      python3 scripts/fi_outflow_probe.py --selftest
"""
import bisect
import json
import math
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from window_dress_probe import div_factor, mean, tstat  # noqa: E402  ⭐ 同一份含息 / t 值(⛔ 不另寫)

COST = 0.1425 * 2 + 0.1          # 0050 賣出再買回的來回成本(%)
WIN, MIN_HIST, DEDUP, SHIFT = 250, 120, 20, 60
QS = (1, 2, 5, 10)
HOLDS = (5, 10, 20)
CENTER = {'q': 5, 'entry': 'c', 'N': 20}
YR_MIN = 2


# ───────────────────────── 純函式 ─────────────────────────
def pct_flag(vals, q, side):
    """vals = [(index, 值|None)];回 {index: True} —— 那一天的值在「之前 WIN 個有值的日子」的極端 q%(⛔ 含當天)。
    side='low' = 越負越極端(賣超)、'high' = 越大越極端(台幣貶)。"""
    hist, out = [], {}
    for i, v in vals:
        if v is None:
            continue
        if len(hist) >= MIN_HIST:
            w = sorted(hist[-WIN:])
            k = max(0, min(len(w) - 1, int(math.floor(len(w) * q / 100.0))))
            if side == 'low' and v < w[k]:
                out[i] = True
            if side == 'high' and v > w[len(w) - 1 - k]:
                out[i] = True
        hist.append(v)
    return out


def dedup(idx_list, gap=DEDUP):
    out, last = [], -10 ** 9
    for i in sorted(idx_list):
        if i - last >= gap:
            out.append(i)
            last = i
    return out


def fwd_ret(K, s, entry, N, divs):
    """0050:s 開盤進 → s+N−1 收盤出(o)/ s 收盤進 → s+N 收盤出(c);含息 %;進不去 / 資料不夠 → None"""
    if s < 1 or s >= len(K['d']) or K['v'][s] <= 0:
        return None
    if entry == 'o':
        b = s + N - 1
        if b >= len(K['d']):
            return None
        return (K['c'][b] * div_factor(divs, K['d'][s], K['d'][b]) / K['o'][s] - 1) * 100
    b = s + N
    if b >= len(K['d']):
        return None
    return (K['c'][b] * div_factor(divs, K['d'][s], K['d'][b]) / K['c'][s] - 1) * 100


def momentum(K, s):
    return K['c'][s - 1] / K['c'][s - 21] - 1 if s >= 21 and K['c'][s - 21] > 0 else None


def quintile_edges(xs):
    w = sorted(x for x in xs if x is not None)
    return [w[int(len(w) * k / 5)] for k in (1, 2, 3, 4)] if len(w) >= 50 else None


def qbin(x, edges):
    return bisect.bisect_right(edges, x) if (x is not None and edges) else None


def study(K, divs, sigs, entry, N, edges, base_by):
    """sigs = 能動作那天的 index 清單(已去重)→ 結果 dict(差 = 事件 − 同年同動能五分位的平均)"""
    rows = []
    for s in sigs:
        r = fwd_ret(K, s, entry, N, divs)
        if r is None:
            continue
        key = (K['d'][s][:4], qbin(momentum(K, s), edges))
        b = base_by.get(key)
        if b is None:
            continue
        rows.append((K['d'][s], r, r - b))
    if len(rows) < 5:
        return {'n': len(rows)}
    diffs = [x[2] for x in rows]
    half = len(rows) // 2
    yrs = {}
    for d, _, x in rows:
        yrs.setdefault(d[:4], []).append(x)
    ym = {y: mean(v) for y, v in yrs.items() if len(v) >= YR_MIN}
    neg = sum(1 for v in ym.values() if v < 0)
    loyo = [mean([x for d, _, x in rows if d[:4] != y]) for y in yrs] if len(yrs) > 1 else []
    return {'n': len(rows), 'ret': round(mean([x[1] for x in rows]), 3), 'diff': round(mean(diffs), 3),
            't': round(tstat(diffs), 2), 'h1': round(mean(diffs[:half]), 3), 'h2': round(mean(diffs[half:]), 3),
            'yNeg': neg, 'yN': len(ym), 'loyoMax': round(max(loyo), 3) if loyo else None,
            'loyoMin': round(min(loyo), 3) if loyo else None, 'win': round(sum(1 for x in diffs if x > 0) / len(diffs) * 100, 1),
            'from': rows[0][0], 'to': rows[-1][0]}


def verdict(r, plac, plateau_signs):
    """→ ('useful' 跟著賣有用 | 'backfire' 跟著賣反而錯 | 'none' 沒用, 沒過的關)"""
    if r.get('n', 0) < 10:
        return 'none', ['樣本 < 10']
    sign = -1 if r['diff'] < 0 else 1
    fails = []
    if abs(r['t']) < 2:
        fails.append(f't {r["t"]}')
    if (r['h1'] < 0) != (r['h2'] < 0):
        fails.append('前後半不同號')
    ys = r['yNeg'] if sign < 0 else r['yN'] - r['yNeg']
    if r['yN'] and ys / r['yN'] < 0.7:
        fails.append(f'逐年 {ys}/{r["yN"]}')
    lo = r['loyoMax'] if sign < 0 else r['loyoMin']
    if lo is not None and ((sign < 0 and lo >= 0) or (sign > 0 and lo <= 0)):
        fails.append('拿掉某一年就翻')
    if abs(r['diff']) <= COST:
        fails.append(f'幅度 {r["diff"]} ≤ 成本 {COST:.3f}')
    for p in plac:
        if p.get('n', 0) >= 10 and abs(p.get('t') or 0) >= 2:
            fails.append(f'安慰劑 t {p["t"]}')
    if any(s != sign for s in plateau_signs if s):
        fails.append('門檻不是高原')
    if fails:
        return 'none', fails
    return ('useful' if sign < 0 else 'backfire'), []


# ───────────────────────── 載入 ─────────────────────────
def load_k(path):
    rows = json.loads(Path(path).read_text(encoding='utf-8'))
    K = {'d': [], 'o': [], 'c': [], 'v': []}
    for r in rows:
        try:
            o, c = float(r['open']), float(r['close'])
        except Exception:
            continue
        if o <= 0 or c <= 0:
            continue
        K['d'].append(str(r['date']).replace('/', '-')[:10])
        K['o'].append(o)
        K['c'].append(c)
        K['v'].append(float(r.get('volume') or 0))
    return K


def load_divs(path, sym='0050'):
    j = json.loads(Path(path).read_text(encoding='utf-8'))
    h = (((j.get('d') or {}).get(sym) or {}).get('h')) or []
    return [(str(x[0])[:10], float(x[3]), float(x[4])) for x in h if len(x) >= 5 and x[3] and x[4]]


def cur_thr(vals, q, side):
    """App 用的「現在的門檻」:最近 WIN 個值的極端 q%(跟 pct_flag 同一個切法 —— low:值 < 門檻才算;high:值 > 門檻才算)。
    → 散戶 App `_FI_OUT`(scripts/embed_fi_out.mjs);值不到 MIN_HIST 個回 None。"""
    v = [x for x in vals if x is not None]
    if len(v) < MIN_HIST:
        return None
    w = sorted(v[-WIN:])
    k = max(0, min(len(w) - 1, int(math.floor(len(w) * q / 100.0))))
    return w[k] if side == 'low' else w[len(w) - 1 - k]


def build_events(K, tsmc, spot, twd, q):
    """→ {名稱: [能動作那天的 index]}(未去重)。tsmc = {日期: (外資股, 量股)};spot = {日期: 億};twd = [(美股日期, 收盤)]"""
    cal = K['d']
    pos = {d: i for i, d in enumerate(cal)}
    nxt = lambda i: i + 1 if i + 1 < len(cal) else None  # noqa: E731
    a_vals = [(i, (tsmc.get(d) or (None,))[0]) for i, d in enumerate(cal)]
    a2_vals = [(i, (tsmc[d][0] / tsmc[d][1]) if d in tsmc and tsmc[d][1] else None) for i, d in enumerate(cal)]
    b_vals = [(i, spot.get(d)) for i, d in enumerate(cal)]
    A = pct_flag(a_vals, q, 'low')
    A2 = pct_flag(a2_vals, q, 'low')
    B = pct_flag(b_vals, q, 'low')
    # 台幣:美股日期序列算漲跌 → 極端 → 對到「第一個 > u 的台股日」
    chg = [(k, (twd[k][1] / twd[k - 1][1] - 1) if k > 0 and twd[k - 1][1] and twd[k][1] else None) for k in range(len(twd))]
    Cu = pct_flag(chg, q, 'high')
    C_by_date = {twd[k][0]: True for k in Cu}
    ev = {'A': [], 'A2': [], 'B': [], 'C': [], 'D': []}
    for i in A:
        j = nxt(i)
        if j is not None:
            ev['A'].append(j)
    for i in A2:
        j = nxt(i)
        if j is not None:
            ev['A2'].append(j)
    for i in B:
        j = nxt(i)
        if j is not None:
            ev['B'].append(j)
    for k in Cu:
        u = twd[k][0]
        j = bisect.bisect_right(cal, u)
        if j < len(cal):
            ev['C'].append(j)
    for i in set(A) | set(B):
        if C_by_date.get(cal[i]):
            j = nxt(i)
            if j is not None:
                ev['D'].append(j)
    return {k: sorted(set(v)) for k, v in ev.items()}, pos


def base_table(K, divs, entry, N, edges):
    acc = {}
    for s in range(21, len(K['d'])):
        r = fwd_ret(K, s, entry, N, divs)
        if r is None:
            continue
        key = (K['d'][s][:4], qbin(momentum(K, s), edges))
        acc.setdefault(key, []).append(r)
    return {k: mean(v) for k, v in acc.items() if len(v) >= 5}


def run(K, divs, tsmc, spot, twd, log=print, center_q=None):
    cq = center_q or CENTER['q']
    edges = quintile_edges([momentum(K, s) for s in range(len(K['d']))])
    bases = {(e, N): base_table(K, divs, e, N, edges) for e in ('o', 'c') for N in HOLDS}
    allday = {(e, N): mean([x for x in (fwd_ret(K, s, e, N, divs) for s in range(21, len(K['d']))) if x is not None]) for e in ('o', 'c') for N in HOLDS}
    res = {}
    for q in QS:
        ev, _ = build_events(K, tsmc, spot, twd, q)
        for name, idx in ev.items():
            sigs = dedup(idx)
            for e in ('o', 'c'):
                for N in HOLDS:
                    r = study(K, divs, sigs, e, N, edges, bases[(e, N)])
                    plac = [study(K, divs, dedup([i + sh for i in idx if 0 < i + sh < len(K['d'])]), e, N, edges, bases[(e, N)])
                            for sh in (SHIFT, -SHIFT)]
                    r['plac'] = [{k: p.get(k) for k in ('n', 'diff', 't')} for p in plac]
                    r['allday'] = round(allday[(e, N)], 3)
                    res[(name, q, e, N)] = r
    out = {}
    for name in ('A', 'A2', 'B', 'C', 'D'):
        for e in ('o', 'c'):
            for N in HOLDS:
                r = res[(name, cq, e, N)]
                signs = [(-1 if res[(name, q, e, N)].get('diff', 0) < 0 else 1) if res[(name, q, e, N)].get('n', 0) >= 10 else 0 for q in QS]
                v, why = verdict(r, r.get('plac') or [], signs)
                r['verdict'], r['why'], r['plateau'] = v, why, {q: res[(name, q, e, N)].get('diff') for q in QS}
                out[f'{name}|{e}|{N}'] = r
    return out, res


def main():
    dd = os.environ.get('DATA_DIR')
    if not dd:
        sys.exit('需要 DATA_DIR(含 2330.json / _bench0050.json / _div0050.json)')
    K = load_k(Path(dd) / '_bench0050.json')
    divs = load_divs(Path(dd) / '_div0050.json')
    t = json.loads((Path(dd) / '2330.json').read_text(encoding='utf-8'))
    tsmc = {str(r['date']).replace('/', '-')[:10]: (float(r['foreign_net']), float(r.get('volume') or 0))
            for r in t if r.get('foreign_net') is not None}
    fi = json.loads(Path(os.environ.get('FI_HIST') or 'data/fi_mkt_hist.json').read_text(encoding='utf-8'))
    spot = {d: (v[0] if isinstance(v, list) else v) for d, v in (fi.get('spot') or {}).items() if v is not None}
    us = json.loads(Path(os.environ.get('US_HIST') or 'data/us_hist.json').read_text(encoding='utf-8'))
    tw = (us.get('mac') or {}).get('TWD=X') or {}
    twd = [(d, c) for d, c in zip(us.get('days') or [], tw.get('c') or []) if c]
    print(f'0050 {K["d"][0]}~{K["d"][-1]}({len(K["d"])} 天)・台積電外資 {min(tsmc)}~{max(tsmc)}({len(tsmc)})・'
          f'外資現貨 {min(spot)}~{max(spot)}({len(spot)})・台幣 {twd[0][0]}~{twd[-1][0]}({len(twd)})・除息 {len(divs)} 次')
    out, res = run(K, divs, tsmc, spot, twd)
    nm = {'A': '外資賣台積電(張數)', 'A2': '外資賣台積電(佔成交量)', 'B': '外資現貨全市場賣超', 'C': '台幣一天貶最多', 'D': '(A 或 B)+ 台幣同一天大貶'}
    print(f'\n門檻 = 過去 {WIN} 天最多的 {CENTER["q"]}%;差 = 事件 − 同年同動能;成本 {COST:.3f}%')
    for key, r in out.items():
        name, e, N = key.split('|')
        if r.get('n', 0) < 5:
            print(f'{nm[name]:<16} {e} {N:>2} 天  n={r.get("n")}(太少)')
            continue
        print(f'{nm[name]:<16} {e} {N:>2} 天  n={r["n"]:>3}  事件 {r["ret"]:+.2f}% 每天 {r["allday"]:+.2f}%  差 {r["diff"]:+.3f}(t {r["t"]:+.2f})'
              f'  前後 {r["h1"]:+.2f}/{r["h2"]:+.2f}  逐年負 {r["yNeg"]}/{r["yN"]}  拿掉一年 {r["loyoMin"]}~{r["loyoMax"]}'
              f'  安慰劑 {[p.get("diff") for p in r["plac"]]}  高原 {r["plateau"]}  → {r["verdict"]} {"・".join(r["why"][:3])}')
    # 🏧 App 的觸發門檻(現在這一刻的「過去 250 天最多的 5%」;重跑探針才更新)
    sk = sorted(spot)
    tchg = [(twd[k][1] / twd[k - 1][1] - 1) * 100 for k in range(1, len(twd)) if twd[k - 1][1] and twd[k][1]]
    thr = {'spot': cur_thr([spot[d] for d in sk], CENTER['q'], 'low'), 'twd': cur_thr(tchg, CENTER['q'], 'high'),
           'spotAsof': sk[-1] if sk else None, 'twdAsof': twd[-1][0] if twd else None, 'win': WIN, 'q': CENTER['q']}
    if thr['spot'] is not None:
        thr['spot'] = round(thr['spot'], 2)
    if thr['twd'] is not None:
        thr['twd'] = round(thr['twd'], 3)
    print(f'\n🏧 App 門檻(最近 {WIN} 天最多的 {CENTER["q"]}%):外資現貨賣超 < {thr["spot"]} 億({thr["spotAsof"]})・台幣一天貶 > {thr["twd"]}%({thr["twdAsof"]})')
    o = os.environ.get('OUT')
    if o:
        Path(o).write_text(json.dumps({'cost': COST, 'win': WIN, 'center': CENTER, 'thr': thr, 'res': out}, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'\n→ {o}')


# ───────────────────────── selftest ─────────────────────────
def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:300]}'))
        if not cond:
            fails.append(name)

    import datetime as dt
    days, t0 = [], dt.date(2012, 1, 2)
    while len(days) < 2600:
        if t0.weekday() < 5:
            days.append(t0.isoformat())
        t0 += dt.timedelta(days=1)

    def world(effect, seed=7):
        """效果埋在「探針自己會判成事件(門檻 1%)」的那幾天之後 20 天(⛔ 太常發生的話,對照組也被拖下去 → 量不出來)"""
        rnd = random.Random(seed)
        n = len(days)
        fn = [rnd.gauss(0, 1) for _ in range(n)]
        hit = pct_flag([(i, fn[i]) for i in range(n)], 1, 'low')
        c, K = 100.0, {'d': [], 'o': [], 'c': [], 'v': []}
        drift = [0.0] * (n + 30)
        for i in hit:
            for j in range(i + 2, i + 22):
                drift[j] += effect / 20
        for i, d in enumerate(days):
            o = c * (1 + rnd.gauss(0, 0.002))
            c = o * (1 + rnd.gauss(0.0003, 0.009) + drift[i] / 100)
            K['d'].append(d); K['o'].append(o); K['c'].append(c); K['v'].append(1.0)
        tsmc = {d: (fn[i] * 1e7, 3e7) for i, d in enumerate(days)}
        spot = {d: fn[i] * 100 for i, d in enumerate(days)}
        twd = [(d, 30 + 0.001 * i) for i, d in enumerate(days)]
        return K, tsmc, spot, twd

    K, tsmc, spot, twd = world(-8.0)
    out, _ = run(K, [], tsmc, spot, twd, log=lambda *_: None, center_q=1)
    a = out['A|c|20']
    ok('① 埋「外資大賣後 20 天跌 8%」→ 抓得到(差 < −3、t ≤ −2)', a.get('diff', 0) < -3 and a.get('t', 0) <= -2, a)
    ok('① 判定 = 跟著賣有用', a['verdict'] == 'useful', (a['verdict'], a['why']))
    K0, tsmc0, spot0, twd0 = world(0.0)
    out0, _ = run(K0, [], tsmc0, spot0, twd0, log=lambda *_: None, center_q=1)
    a0 = out0['A|c|20']
    ok('② 沒埋效果 → 判定不是「有用」', a0['verdict'] != 'useful' and abs(a0.get('diff', 0)) < 2, (a0.get('diff'), a0.get('t'), a0['verdict']))
    ok('② 安慰劑(挪 60 天)在有效果的世界 ≈ 0', all(abs(p.get('diff') or 0) < 2 for p in a['plac']), a['plac'])
    # ③ ⛔ 前視:把第 1500 天以後的外資數字全改掉,第 1500 天以前的事件一個都不能變
    ev1, _ = build_events(K, tsmc, spot, twd, 5)
    t2 = {d: (v if i < 1500 else (-9e9, 3e7)) for i, (d, v) in enumerate(sorted(tsmc.items()))}
    ev2, _ = build_events(K, t2, spot, twd, 5)
    ok('③ ⛔ 前視:改未來的外資數字,之前的事件不變', [i for i in ev1['A'] if i <= 1500] == [i for i in ev2['A'] if i <= 1500])
    # ④b App 的門檻 cur_thr == pct_flag 的切法:拿前 300 個值算門檻,第 301 個值剛好比門檻小一點 → pct_flag 也判成事件;等於門檻 → 都不算
    hv = [((k * 37) % 101) - 50.0 for k in range(300)]
    th = cur_thr(hv, 5, 'low')
    f1 = pct_flag([(k, v) for k, v in enumerate(hv + [th - 0.01])], 5, 'low')
    f2 = pct_flag([(k, v) for k, v in enumerate(hv + [th])], 5, 'low')
    ok('④b App 門檻 cur_thr 跟 pct_flag 同一個切法(低一點 → 事件;等於 → 不算)', 300 in f1 and 300 not in f2, (th, 300 in f1, 300 not in f2))
    ok('④b 值不夠 120 個 → 不給門檻', cur_thr(hv[:100], 5, 'low') is None)
    # ④ 門檻只用之前的日子(⛔ 含當天);跟門檻一樣的值 ⛔ 算(一堆 0 的時候不會整片都算)
    vals = [(i, float(x)) for i, x in enumerate([0] * 200 + [-5] + [0] * 10)]
    fl = pct_flag(vals, 5, 'low')
    ok('④ 第一次出現的極端值 = 事件(門檻⛔ 含當天)、跟門檻一樣的 0 ⛔ 算', 200 in fl and 201 not in fl and 150 not in fl, sorted(fl)[:5])
    # ⑤ 含息:除息那天價格掉下來 ⛔ 算成虧損
    Kd = {'d': ['2020-01-0%d' % i for i in range(1, 9)], 'o': [100] * 3 + [98] * 5, 'c': [100] * 3 + [98] * 5, 'v': [1] * 8}
    divs = [('2020-01-04', 100.0, 98.0)]
    ok('⑤ 除息日的價格落差補回來(0%)', abs(fwd_ret(Kd, 1, 'c', 5, divs)) < 1e-9, fwd_ret(Kd, 1, 'c', 5, divs))
    ok('⑤ 決定性對照:不補 → −2%', abs(fwd_ret(Kd, 1, 'c', 5, []) + 2) < 1e-9)
    # ⑥ 量 0(停牌)那天 ⛔ 當進場日
    Kv = dict(Kd); Kv['v'] = [1, 0, 1, 1, 1, 1, 1, 1]
    ok('⑥ 停牌那天 ⛔ 進場', fwd_ret(Kv, 1, 'o', 3, []) is None and fwd_ret(Kv, 2, 'o', 3, []) is not None)
    # ⑦ 台幣:美股日期 u 的大貶 → 第一個「> u」的台股日(⛔ 同一天)
    cal = {'d': ['2020-01-02', '2020-01-03', '2020-01-06'], 'o': [1, 1, 1], 'c': [1, 1, 1], 'v': [1, 1, 1]}
    tw2 = [('2019-%02d-%02d' % (1 + i // 28, 1 + i % 28), 30.0) for i in range(200)] + [('2020-01-03', 31.0)]
    ev3, _ = build_events(cal, {}, {}, tw2, 5)
    ok('⑦ 美股 01/03 台幣大貶 → 台股 01/06 才能動作', ev3['C'] == [2], ev3['C'])
    # ⑧ 去重
    ok('⑧ 20 天內只算一次', dedup([1, 5, 21, 22, 41]) == [1, 21, 41])
    print(f'\n{"✅ 全部通過" if not fails else "❌ " + str(len(fails)) + " 條沒過"}')
    return 0 if not fails else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    main()
