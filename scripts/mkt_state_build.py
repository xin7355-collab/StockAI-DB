#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌐 大盤狀態表(V79.3.8,變因因子研究「M 類」)—— 給 factor_zoo_probe 分層用:每個變因在什麼盤比較有效。
⛔ 不是訊號、⛔ 不進 App;只讀已經挖好的檔,不打任何 API。

輸入(都是 data 分支上已經有的):
  FI_MKT   fi_mkt_hist.json   外資現貨(2004 起)/ 外資台指期(2018 起)/ 整體融資(2004 起)/ 順逆價差(有才用)
  TAIFEX   taifex_hist.json   選擇權 P/C 未平倉比 / 大額交易人前 10 大淨部位(2010 起)
  US_HIST  us_hist.json       美股 / 費半 / VIX(syms)+ 台幣 / 美債 10 年 / 美元指數 / 原油 / 黃金(mac),2009 起
  DATA_DIR ^TWII.json ^TWOII.json(加權 / 櫃買)
輸出 OUT(預設 mkt_state.json):{asof, src, desc{名: 白話}, states{名: {日期: 值}}}

⭐ 日期 = 那個值「已經知道」的那一天(台股收盤後公布的 → 那一天;美股 → 美國那一天的收盤)。
   factor_zoo_probe 用的時候一律取**橫切面那一天以前(⛔ 不含當天)**最近的一筆 → 零前視,而且再保守多晚一天。
⛔ 缺值就是缺(⛔ 不補 0、⛔ 不往前填):某一天算不出來就沒有那一天。

跑法:FI_MKT=… TAIFEX=… US_HIST=… DATA_DIR=… OUT=… python3 scripts/mkt_state_build.py
      python3 scripts/mkt_state_build.py --selftest
"""
import json
import os
import sys
from pathlib import Path

DESC = {
    'fi5': '外資現貨 5 日合計(億)',
    'fut': '外資台指期淨未平倉(口)',
    'fut5': '外資台指期 5 日增減(口)',
    'mg20': '整體融資 20 日增減(%)',
    'bs': '台指期近月 − 加權(佔加權 %,負 = 逆價差)',
    'pc': '選擇權 P/C 未平倉比',
    'lt': '台指期大額交易人前 10 大淨部位(口)',
    'twd20': '美元兌台幣 20 日變化(%,正 = 台幣變弱)',
    'tnx20': '美債 10 年殖利率 20 日變化(百分點)',
    'dxy20': '美元指數 20 日變化(%)',
    'oil20': '原油 20 日變化(%)',
    'gold20': '黃金 20 日變化(%)',
    'spx20': 'S&P 500 20 日漲跌(%)',
    'sox20': '費城半導體 20 日漲跌(%)',
    'vix': 'VIX',
    'otc_rel20': '櫃買 20 日 − 加權 20 日(百分點)',
    'twii20': '加權 20 日漲跌(%)',
    'twii_pos': '加權一年位置(0 = 一年最低、100 = 一年最高)',
}


def d10(x):
    return str(x).replace('/', '-')[:10]


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def chg(series, n, pct=True):
    """{日期: 值} → n 筆之前到現在的變化(% 或差);前面不滿 n 筆的不給。⛔ 缺值不往前填。"""
    ks = [k for k in sorted(series) if series[k] is not None]
    out = {}
    for i in range(n, len(ks)):
        a, b = series[ks[i - n]], series[ks[i]]
        if a is None or b is None:
            continue
        if pct:
            if a > 0:
                out[ks[i]] = (b / a - 1) * 100
        else:
            out[ks[i]] = b - a
    return out


def rolling_sum(series, n):
    ks = sorted(series)
    out = {}
    for i in range(n - 1, len(ks)):
        w = [series[k] for k in ks[i - n + 1:i + 1]]
        if all(v is not None for v in w):
            out[ks[i]] = sum(w)
    return out


def position(series, n=252):
    """一年位置 0~100(含當天,⛔ 用的時候再晚一天)。不滿 n 筆不給。"""
    ks = sorted(series)
    vs = [series[k] for k in ks]
    out = {}
    for i in range(n - 1, len(ks)):
        w = [v for v in vs[i - n + 1:i + 1] if v is not None]
        if len(w) < n * 0.9 or vs[i] is None:
            continue
        lo, hi = min(w), max(w)
        if hi > lo:
            out[ks[i]] = (vs[i] - lo) / (hi - lo) * 100
    return out


def us_series(us, key, where='syms'):
    """us_hist 的一檔 → {美國日期: 收盤}(None 的那天就沒有)。"""
    days = us.get('days') or []
    s = ((us.get(where) or {}).get(key) or {}).get('c') or []
    return {d10(days[i]): v for i, v in enumerate(s) if i < len(days) and _num(v) is not None}


def idx_closes(path):
    if not path or not Path(path).exists():
        return {}
    j = json.loads(Path(path).read_text(encoding='utf-8'))
    rows = j if isinstance(j, list) else (j.get('data') or [])
    return {d10(r['date']): float(r['close']) for r in rows if r and _num(r.get('close')) and float(r['close']) > 0}


def build(fi=None, tx=None, us=None, twii=None, two=None):
    st, src = {}, {}
    if fi:
        spot = {d10(d): _num(v[0] if isinstance(v, list) else v) for d, v in (fi.get('spot') or {}).items()}
        st['fi5'] = rolling_sum(spot, 5)
        fut = {d10(d): _num(v) for d, v in (fi.get('fut') or {}).items()}
        st['fut'] = {d: v for d, v in fut.items() if v is not None}
        st['fut5'] = chg(fut, 5, pct=False)
        mg = {d10(d): _num(v) for d, v in (fi.get('mg') or {}).items()}
        st['mg20'] = chg(mg, 20)
        # 價差換成「佔加權幾 %」(⛔ 用點數的話 2004 年 6,000 點跟 2026 年 47,000 點不能比)
        bs = {}
        for d, v in (fi.get('bs') or {}).items():
            if isinstance(v, list) and len(v) >= 3 and _num(v[0]) is not None and _num(v[2]):
                bs[d10(d)] = _num(v[0]) / _num(v[2]) * 100
        if bs:
            st['bs'] = bs
    if tx:
        st['pc'] = {d10(d): _num(a[1]) for d, a in (tx.get('pc') or {}).items() if isinstance(a, list) and len(a) > 1 and _num(a[1]) is not None}
        st['lt'] = {d10(d): _num(o['all'][1]) for d, o in (tx.get('lt') or {}).items()
                    if isinstance(o, dict) and isinstance(o.get('all'), list) and len(o['all']) > 1 and _num(o['all'][1]) is not None}
    if us:
        st['twd20'] = chg(us_series(us, 'TWD=X', 'mac'), 20)
        st['tnx20'] = chg(us_series(us, '^TNX', 'mac'), 20, pct=False)
        st['dxy20'] = chg(us_series(us, 'DX-Y.NYB', 'mac'), 20)
        st['oil20'] = chg(us_series(us, 'CL=F', 'mac'), 20)
        st['gold20'] = chg(us_series(us, 'GC=F', 'mac'), 20)
        st['spx20'] = chg(us_series(us, '^GSPC'), 20)
        st['sox20'] = chg(us_series(us, '^SOX'), 20)
        st['vix'] = us_series(us, '^VIX')
    if twii:
        t20 = chg(twii, 20)
        st['twii20'] = t20
        st['twii_pos'] = position(twii)
        if two:
            o20 = chg(two, 20)
            st['otc_rel20'] = {d: o20[d] - t20[d] for d in o20 if d in t20}
    st = {k: v for k, v in st.items() if v}
    for k, v in st.items():
        ks = sorted(v)
        src[k] = f'{ks[0]} ~ {ks[-1]} ・{len(ks)} 天'
    return st, src


def main():
    if '--selftest' in sys.argv:
        return selftest()
    load = lambda e: json.loads(Path(os.environ[e]).read_text(encoding='utf-8')) if os.environ.get(e) and Path(os.environ[e]).exists() else None
    dd = os.environ.get('DATA_DIR') or 'data'
    fi, tx, us = load('FI_MKT'), load('TAIFEX'), load('US_HIST')
    twii, two = idx_closes(Path(dd) / '^TWII.json'), idx_closes(Path(dd) / '^TWOII.json')
    st, src = build(fi, tx, us, twii, two)
    if len(st) < 5:
        print(f'❌ 只算得出 {len(st)} 個狀態({list(st)})→ 輸入檔不齊,⛔ 不寫(空過守門)')
        return 1
    out = os.environ.get('OUT') or 'mkt_state.json'
    asof = max(max(v) for v in st.values())
    Path(out).write_text(json.dumps({'asof': asof, 'src': src, 'desc': {k: DESC.get(k, k) for k in st}, 'states': st},
                                    ensure_ascii=False), encoding='utf-8')
    for k in st:
        print(f'  {k:<10}{DESC.get(k, k):<28}{src[k]}')
    print(f'💾 {out}({len(st)} 個狀態)')
    return 0


def selftest():
    bad = []

    def ok(n, c, e=''):
        print(f"  {'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
        if not c:
            bad.append(n)
    days = [f'2020-01-{d:02d}' for d in range(1, 31)]
    s = {d: float(i + 1) for i, d in enumerate(days)}
    c5 = chg(s, 5)
    ok('① 5 筆變化 %:第 6 筆起才有(1 → 6 = +500%)', len(c5) == 25 and abs(c5[days[5]] - 500) < 1e-9 and days[4] not in c5, list(c5.items())[:2])
    s2 = dict(s)
    s2[days[10]] = None
    c5b = chg(s2, 5)
    ok('① 缺值⛔ 不往前填(缺的那天不算、也不拿它當起點)', days[10] not in c5b and days[15] in c5b and abs(c5b[days[15]] - (16 / 10 - 1) * 100) < 1e-9, c5b.get(days[15]))
    rs = rolling_sum({d: 1.0 for d in days}, 5)
    ok('② 5 日合計第 5 筆起才有', len(rs) == 26 and rs[days[4]] == 5.0)
    pos = position({f'2020-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}': float(i) for i in range(300)}, 252)
    ok('③ 一年位置:一路漲 → 100', pos and abs(list(pos.values())[-1] - 100) < 1e-9)
    us = {'days': ['2020-01-02', '2020-01-03'], 'syms': {'^VIX': {'c': [15.0, None]}}, 'mac': {}}
    ok('④ 美股 None 那天就沒有(⛔ 不補)', us_series(us, '^VIX') == {'2020-01-02': 15.0})
    fi = {'spot': {d: [float(i), 0, 0] for i, d in enumerate(days)}, 'fut': {d: -1000.0 * i for i, d in enumerate(days)},
          'mg': {d: 100.0 + i for i, d in enumerate(days)}}
    tx = {'pc': {d: [0, 1.0 + i / 100] for i, d in enumerate(days)}, 'lt': {d: {'all': [0, 50 * i]} for i, d in enumerate(days)}}
    twii = {d: 10000.0 + i for i, d in enumerate(days)}
    st, src = build(fi, tx, None, twii, {d: 200.0 + 2 * i for i, d in enumerate(days)})
    ok('⑤ 外資現貨 5 日合計 = 那 5 天外資那一格加總', abs(st['fi5'][days[9]] - sum(range(5, 10))) < 1e-9, st['fi5'].get(days[9]))
    ok('⑤ 外資台指期 5 日增減(差,不是 %)', abs(st['fut5'][days[9]] - (-5000)) < 1e-9)
    ok('⑤ P/C 取第二格、大額取 all 的第二格', st['pc'][days[0]] == 1.0 and st['lt'][days[2]] == 100)
    ok('⑤ 櫃買相對加權 = 兩邊 20 日漲跌相減', abs(st['otc_rel20'][days[25]] - ((250 / 210 - 1) - (10025 / 10005 - 1)) * 100) < 1e-6)
    ok('⑤ 沒有順逆價差那份 → 就沒有 bs(⛔ 不補 0)', 'bs' not in st)
    st2, _ = build({'bs': {'2020-01-02': [-50.0, 9950.0, 10000.0], '2020-01-03': [12.0, 1.0]}}, None, None, {}, {})
    ok('⑤ 價差換成佔加權 %(−50 點 / 10,000 = −0.5%);缺加權那格的不收', st2.get('bs') == {'2020-01-02': -0.5}, st2.get('bs'))
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
