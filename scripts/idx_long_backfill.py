#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📚 V77.6.3 真的加權指數 + 0050(2010 起)—— 給長歷史回測用(`merge_k66_history.py --idx-long`)

背景:V77.6.2 把回測拉到 2011~2026,但 2021-09 以前的「大盤」是**等權代理**,
而「嚴格空頭不做」(`FILTER=bear60`)正是吃大盤判斷的;2022 以前也沒有 0050 可比。
→ 這支只抓 **4 次** FinMind(付費金鑰,一次呼叫可回 18 年,history_probe 實測):
    ① TaiwanStockPrice              TAIEX  (加權指數 OHLC + 成交金額)
    ② TaiwanStockTotalReturnIndex   TAIEX  (報酬指數;拿不到只寫 *_error,⛔ 不擋)
    ③ TaiwanStockPrice              0050   (原始價 → 錨在本站那份第一天換成同一把尺;2025 的 1:4 分割在錨點之後)
    ④ TaiwanStockDividendResult     0050   (除息日 / 現金股利 / 除息前價 / 參考價)
輸出**一個**檔 data/idx_long.json(前端不讀,只給回測)。

守門(⛔ 都不可拿掉;任一不過 → exit 1、⛔ 不寫檔):
  ・加權 / 0050 第一根 ≤ 2010-01-15、加權 ≥ 3,800 根
  ・⭐ 重疊期對表:跟本站 data/^TWII.json、data/0050.json 同日收盤差 < 0.5% 的比例 ≥ 95%
    (抓錯日期 / 漏還原分割 → 這一關一定叫得出來,`--selftest` 有注入)
  ・對表用的參考檔不在 / 是空的 → exit 1(⛔ 沒驗過的資料不寫)

⛔ 安全:只印「第幾把 token」,絕不印 token 值(dispo_probe.fm 已照做)。
用法:python3 scripts/idx_long_backfill.py [--ref-dir DIR] [--out FILE] | --selftest
"""
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

START = os.getenv('IDX_START') or '2010-01-01'
FIRST_MAX = '2010-01-15'
MIN_TWII = 3800
TOL = 0.005
MIN_RATIO = 0.95
MIN_OVERLAP = 200


def d_slash(s):
    return str(s)[:10].replace('-', '/')


def load_ref(path):
    """本站那份(list of {date, close})→ {YYYY/MM/DD: close};壞的 / 空的回 None。"""
    try:
        with open(path) as f:
            rows = json.load(f)
    except Exception:
        return None
    if not isinstance(rows, list) or not rows:
        return None
    out = {d_slash(r.get('date')): float(r['close']) for r in rows
           if isinstance(r, dict) and r.get('close')}
    return out or None


def overlap_check(new, ref, tol=TOL, min_ratio=MIN_RATIO, min_n=MIN_OVERLAP):
    """new / ref 都是 {date: close}。回 (ok, ratio, n)。"""
    common = [d for d in new if d in ref and ref[d] > 0]
    n = len(common)
    if n < min_n:
        return False, 0.0, n
    good = sum(1 for d in common if abs(new[d] / ref[d] - 1) < tol)
    ratio = good / n
    return ratio >= min_ratio, ratio, n


def anchor_scale(rows, ref, n_chk=20, tol=TOL, jump=0.115):
    """rows(原始價,舊→新)錨到 ref 的第一個共同日期:回 {rows(≤錨點那天、已乘倍率), d, k, n} 或 {err}。
    守門:① 前 n_chk 個共同日期的倍率都跟中位數差 <tol ② 輸出那段不可有單日 >11.5% 的跳動(= 還有沒還原的公司行動)"""
    common = [x['date'] for x in rows if x['date'] in ref and ref[x['date']] > 0]
    if len(common) < n_chk:
        return {'err': f'跟本站那份只有 {len(common)} 個共同日期(<{n_chk}),錨不起來'}
    bym = {x['date']: x['close'] for x in rows}
    ks = sorted(ref[d] / bym[d] for d in common[:n_chk])
    k = ks[len(ks) // 2]
    bad = [d for d in common[:n_chk] if abs(ref[d] / bym[d] / k - 1) >= tol]
    if bad:
        return {'err': f'錨點倍率不一致({len(bad)}/{n_chk} 天偏離中位數 ≥{tol:.1%},例:{bad[0]})'}
    d0 = common[0]
    out = [dict(x, open=x['open'] * k, high=x['high'] * k, low=x['low'] * k, close=x['close'] * k,
                volume=int(round(x['volume'] / k))) for x in rows if x['date'] <= d0]
    for a, b in zip(out, out[1:]):
        r = b['close'] / a['close']
        if r > 1 + jump or r < 1 - jump:
            return {'err': f'錨點之前還有沒還原的跳動:{a["date"]} {a["close"]:.2f} → {b["date"]} {b["close"]:.2f}'}
    return {'rows': out, 'd': d0, 'k': k, 'n': n_chk}


def to_price_rows(rows):
    out = []
    for r in rows or []:
        try:
            out.append({'date': d_slash(r['date']), 'open': float(r['open']), 'high': float(r['max']),
                        'low': float(r['min']), 'close': float(r['close']),
                        'volume': int(r.get('Trading_Volume') or 0), 'amount': int(r.get('Trading_money') or 0)})
        except (KeyError, TypeError, ValueError):
            continue
    out = [x for x in out if x['close'] > 0]
    out.sort(key=lambda x: x['date'])
    return out


def build(fm, ref_twii, ref_0050, today=None):
    """純邏輯(fm 可注入)→ (obj, errors)。errors 非空 = 不可寫檔。"""
    errs = []
    end = today or date.today().isoformat()
    obj = {'updated': end, 'from': START, 'src': 'FinMind',
           'caveat': '回測專用(前端不讀)。0050 已還原分割;股利未再投入(要含息請自己用 div0050 算)。'}

    tw_raw, e = fm('TaiwanStockPrice', {'data_id': 'TAIEX', 'start_date': START, 'end_date': end})
    tw = to_price_rows(tw_raw)
    print(f'① 加權:{len(tw)} 根 ・{tw[0]["date"] if tw else "—"} ~ {tw[-1]["date"] if tw else "—"}' + (f' ・{e}' if e else ''))
    if not tw or tw[0]['date'] > d_slash(FIRST_MAX) or len(tw) < MIN_TWII:
        errs.append(f'加權不夠深({len(tw)} 根,第一根 {tw[0]["date"] if tw else "—"};{e or ""})')
    else:
        ok, ratio, n = overlap_check({x['date']: x['close'] for x in tw}, ref_twii)
        print(f'   對表 data/^TWII.json:{n} 天重疊,差 <0.5% 的 {ratio:.1%}')
        if not ok:
            errs.append(f'加權對不上本站(重疊 {n} 天、只有 {ratio:.1%} 在 0.5% 內)')
    obj['twii'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['amount']] for x in tw]

    tr_raw, e = fm('TaiwanStockTotalReturnIndex', {'data_id': 'TAIEX', 'start_date': START, 'end_date': end})
    tr = sorted([[d_slash(r['date']), float(r['price'])] for r in (tr_raw or [])
                 if r.get('price') not in (None, '', 0)], key=lambda x: x[0])
    print(f'② 報酬指數:{len(tr)} 根' + (f' ・{e}' if e else ''))
    obj['twii_tr'] = tr
    if not tr:
        obj['twii_tr_error'] = f'報酬指數拿不到({e or "回空"})—— 不影響其他三份'

    e5_raw, e = fm('TaiwanStockPrice', {'data_id': '0050', 'start_date': START, 'end_date': end})
    e5 = to_price_rows(e5_raw)
    print(f'③ 0050:{len(e5)} 根 ・{e5[0]["date"] if e5 else "—"} ~ {e5[-1]["date"] if e5 else "—"}' + (f' ・{e}' if e else ''))
    # 🚨 第一次實跑(run #1)抓到:FinMind 的 0050 是**原始價**,2025-06 那次 1:4 分割中間停牌 7 天
    #   → `miner._backadjust_splits` 的 `gap > 5` 守門(刻意的,見它的註解)不會動它 → 整段對不上(39.3%)。
    #   ⭐ 改法:⛔ 不去放寬那道守門,改成**錨在本站那份的第一個共同日期**:
    #     只輸出「本站那份第一天(含)以前」的部分,乘上那一天的倍率;而且前 20 個共同日期的倍率要一致(<0.5%)。
    #     之後那一段本站自己就有(而且已經還原過),⛔ 不用 FinMind 的。
    out5 = []
    if not e5 or e5[0]['date'] > d_slash(FIRST_MAX):
        errs.append(f'0050 不夠深({len(e5)} 根;{e or ""})')
    else:
        a = anchor_scale(e5, ref_0050)
        if a.get('err'):
            errs.append('0050 ' + a['err'])
        else:
            out5 = a['rows']
            obj['e0050_anchor'] = {'d': a['d'], 'k': a['k'], 'n': a['n']}
            print(f'   錨在 {a["d"]}:倍率 {a["k"]:.6f}(前 {a["n"]} 個共同日期一致)・輸出 {len(out5)} 根(本站那份之前)')
    obj['e0050'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['volume']] for x in out5]

    dv_raw, e = fm('TaiwanStockDividendResult', {'data_id': '0050', 'start_date': START, 'end_date': end})
    dv = []
    for r in dv_raw or []:
        try:
            dv.append([d_slash(r['date']), float(r.get('stock_and_cache_dividend') or 0),
                       str(r.get('stock_or_cache_dividend') or ''), float(r.get('before_price') or 0),
                       float(r.get('after_price') or 0)])
        except (TypeError, ValueError):
            continue
    dv.sort(key=lambda x: x[0])
    print(f'④ 0050 除息:{len(dv)} 筆' + (f' ・{e}' if e else ''))
    obj['div0050'] = dv
    if not dv:
        obj['div0050_error'] = f'除息紀錄拿不到({e or "回空"})—— 0050 含息報酬算不了'
    return obj, errs


def selftest():
    fails = []
    ok = lambda name, c: (print(('✅ ' if c else '❌ ') + name), c or fails.append(name))
    days = [f'2023/{m:02d}/{d:02d}' for m in range(1, 13) for d in range(1, 29)]
    ref = {d: 100 + i * 0.3 for i, d in enumerate(days)}
    ok('① 同一份 → 過', overlap_check(dict(ref), ref)[0])
    shifted = {days[i]: ref[days[i + 1]] for i in range(len(days) - 1)}
    ok('② 注入「差 1 天」→ 叫得出來', not overlap_check(shifted, ref, tol=0.001)[0])
    half = {d: (ref[d] * 4 if i < len(days) // 2 else ref[d]) for i, d in enumerate(days)}
    ok('③ 注入「前半段漏還原 1:4 分割」→ 叫得出來', not overlap_check(half, ref)[0])
    ok('④ 重疊太少(<200 天)→ 不算過', not overlap_check({d: ref[d] for d in days[:50]}, ref)[0])

    # build():合成 FinMind(整條 build 走一次,含 miner 分割還原)
    from datetime import timedelta
    d0 = date(2010, 1, 4)
    base = [x.isoformat() for x in (d0 + timedelta(days=k) for k in range(6100)) if x.weekday() < 5][:4200]
    px = [10000 + 300 * ((i * 7) % 11 - 5) for i in range(len(base))]   # 每天 ±1~3% 在跳(差一天才量得到)
    tw = [{'date': d, 'open': px[i], 'max': px[i] + 50, 'min': px[i] - 50, 'close': px[i], 'Trading_money': 1} for i, d in enumerate(base)]
    ref_tw = {d_slash(r['date']): r['close'] for r in tw[-400:]}
    e5 = [{'date': d, 'open': p, 'max': p, 'min': p, 'close': p, 'Trading_Volume': 1}
          for i, d in enumerate(base) for p in [(40 + i * 0.01) * (4 if d < '2025-06-18' else 1)]]
    ref_05 = {d_slash(r['date']): (40 + i * 0.01) for i, r in enumerate(e5) if r['date'] >= '2023-06-01'}

    def fake_fm(shift=False):
        def f(ds, q):
            if ds == 'TaiwanStockPrice' and q['data_id'] == 'TAIEX':
                return ([dict(r, close=tw[min(i + 1, len(tw) - 1)]['close']) for i, r in enumerate(tw)] if shift else tw), None
            if ds == 'TaiwanStockPrice':
                return [dict(r) for r in e5], None
            if ds == 'TaiwanStockTotalReturnIndex':
                return [{'date': r['date'], 'price': r['close'] * 2} for r in tw], None
            return [{'date': '2024-07-16', 'stock_and_cache_dividend': 1.0, 'stock_or_cache_dividend': '息',
                     'before_price': 190, 'after_price': 189}], None
        return f
    o, errs = build(fake_fm(), ref_tw, ref_05, today='2026-09-25')
    ok('⑤ 正常資料 → 沒有錯誤、錨點之前的 0050 已換成本站的尺', not errs and abs(o['e0050'][0][4] - 40) < 1e-6)
    _, errs = build(fake_fm(shift=True), ref_tw, ref_05, today='2026-09-25')
    ok('⑥ 加權日期錯一格 → build 報錯(⛔ 不寫檔)', any('加權' in x for x in errs))
    # ⑦ 錨點倍率不一致(本站那份前 20 天裡有一半是別的尺)→ 必須報錯
    ref_bad = dict(ref_05); ks_ = sorted(ref_bad)[:10]
    for d in ks_: ref_bad[d] *= 2
    _, errs = build(fake_fm(), ref_tw, ref_bad, today='2026-09-25')
    ok('⑦ 注入「錨點倍率不一致」→ build 報錯', any('0050' in x and '錨點' in x for x in errs))
    # ⑦b 錨點之前還有沒還原的 1:2 跳動 → 必須報錯
    e5_keep = list(e5)
    for i_ in range(0, 1000): e5[i_] = dict(e5[i_], close=e5[i_]['close'] * 2)
    _, errs = build(fake_fm(), ref_tw, ref_05, today='2026-09-25')
    e5[:] = e5_keep
    ok('⑦b 注入「錨點之前有沒還原的跳動」→ build 報錯', any('跳動' in x for x in errs))
    # ⑦c 真實情境:原始價在錨點**之後**才分割(2025-06)→ 仍要能錨(⛔ 不可因為後面有分割就放棄)
    o, errs = build(fake_fm(), ref_tw, ref_05, today='2026-09-25')
    ok('⑦c 分割發生在錨點之後 → 照樣錨得起來、第一根 = 還原後的價', not errs and abs(o['e0050'][0][4] - 40) < 1e-6 and o['e0050_anchor']['k'] == 0.25)
    ok('⑧ 參考檔不在 → load_ref 回 None', load_ref('/nonexistent/x.json') is None)
    print(f'\n{"❌ " + str(len(fails)) + " 條沒過" if fails else "✅ IDX_LONG_SELFTEST_PASS"}')
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    arg = lambda k, dflt: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else dflt
    ref_dir = arg('--ref-dir', os.getenv('IDX_REF_DIR') or 'data')
    out = arg('--out', os.getenv('IDX_OUT') or 'data/idx_long.json')
    ref_tw = load_ref(os.path.join(ref_dir, '^TWII.json'))
    ref_05 = load_ref(os.path.join(ref_dir, '0050.json'))
    if not ref_tw or not ref_05:
        print(f'❌ 對表用的參考檔讀不到({ref_dir}/^TWII.json={bool(ref_tw)}、0050.json={bool(ref_05)})→ 不抓(⛔ 沒驗過的資料不寫)')
        sys.exit(1)
    from dispo_probe import fm, TOKENS
    print(f'🔑 token:{len(TOKENS)} 把 ・起點 {START}')
    obj, errs = build(fm, ref_tw, ref_05)
    if errs:
        print('❌ 守門沒過 → 不寫檔:\n  ' + '\n  '.join(errs))
        sys.exit(1)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with open(out, 'w') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 寫出 {out}({os.path.getsize(out) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
