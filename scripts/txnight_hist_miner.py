#!/usr/bin/env python3
"""🌙 txnight_hist_miner.py —— 台指期夜盤(盤後交易)長歷史(FinMind TaiwanFuturesDaily TX,2017 起)→ txnight.json(研究用)

為什麼要有這支(V82.6.7,使用者 11/23 選「比特幣 + 夜盤一起驗」):
  App 盤前體檢那條夜盤計分(V42.0:夜盤 ≥ +1% 加 1.5 分 …)從來沒回測過 → V82.4.0 起採礦標 score: false = 只顯示、⛔ 算分,
  DECISIONS 那節寫「要不要算分等使用者決定(或先用期交所 2017 起的盤後歷史回測)」。
  外資長歷史那支(fi_mkt_miner.parse_txnear)本來就抓 TaiwanFuturesDaily TX,但刻意跳過 after_market 那一列 → 這支另存。
來源:FinMind 免費層 TaiwanFuturesDaily data_id=TX,一年一次呼叫(約 10 次);金鑰處理 / 逐年抓 = import fi_mkt_miner.fm_year
  (金鑰只放 Authorization 標頭、輪 token、每次間隔 1 秒;⛔ 另抄一份)。
存什麼(照 FinMind 原樣,⛔ 在這裡判斷日期歸屬):
  {d: {FinMind 日期: {'p': [[合約月, 開, 高, 低, 收, 結算, 量, 未平倉], …], 'a': [同上]}}}
  p = 一般盤(trading_session position)、a = 盤後(after_market);每個盤別只留成交量最大的兩個「單一月份」合約(⛔ 價差單)。
  ⚠️ 夜盤 15:00 開到隔天 05:00 —— FinMind 的日期是「開始那天」還是期交所「歸屬的下一個交易日」由探針 txnight_probe.mjs
     先用「夜盤開盤最接近哪一天的日盤收盤」判(⛔ 碰開盤結果),這支只負責原樣存好。
守門:夜盤 2017-05-15 上線 → 每一年(那年第一個可能的日子 ~ 今天)有夜盤的日子 ≥ 平日 85%;沒過的年份整年不寫、原因寫進 err;
  一年都沒過 → exit 1 不寫檔(分支上那份保留)。
跑法:python3 scripts/txnight_hist_miner.py [--selftest];環境變數 FROM=2017・OUT=/tmp/txnight.json・FINMIND_TOKENS
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fi_mkt_miner import fm_year, _date, _num, weekdays   # noqa: E402

FROM_Y = int(((os.environ.get('FROM') or '2017').strip() or '2017')[:4])     # 🔧 空字串一律退回預設(check_env_default)
OUT = (os.environ.get('OUT') or '/tmp/txnight.json').strip()
NIGHT_START = '2017-05-15'          # 期交所盤後交易上線那天
MIN_RATIO = 0.85
KEEP = 2


def pick(rows):
    """FinMind 列 → {日期: {'p': [...], 'a': [...]}};每個盤別留成交量最大的 KEEP 個單一月份合約。純函式。"""
    tmp = {}
    for r in rows or []:
        d = _date(r.get('date'))
        cd = str(r.get('contract_date') or '').strip()
        if not d or len(cd) != 6 or not cd.isdigit():
            continue
        ses = str(r.get('trading_session') or 'position')
        k = 'a' if ses == 'after_market' else ('p' if ses == 'position' else None)
        if k is None:
            continue
        c = _num(r.get('close'))
        if c is None or c <= 0:
            continue
        row = [cd, _num(r.get('open')), _num(r.get('max')), _num(r.get('min')), c,
               _num(r.get('settlement_price')), _num(r.get('volume')) or 0, _num(r.get('open_interest')) or 0]
        tmp.setdefault(d, {}).setdefault(k, []).append(row)
    return {d: {k: sorted(v, key=lambda x: (-x[6], x[0]))[:KEEP] for k, v in s.items()} for d, s in tmp.items()}


def year_check(days, y, today):
    """那一年有夜盤('a')的日子 vs 平日數 → (ok, 說明)。純函式。"""
    a = max(f'{y}-01-01', NIGHT_START)
    b = min(f'{y}-12-31', today)
    if a > b:
        return False, f'{y} 年還沒有夜盤'
    wd = weekdays(a, b)
    n = sum(1 for d, s in days.items() if a <= d <= b and s.get('a'))
    ok = wd > 0 and n >= MIN_RATIO * wd
    return ok, f'{y}:夜盤 {n} 天 / 平日 {wd}({(n / wd if wd else 0):.0%})'


def build(fetch_year, y0, y1, today, log=print):
    """逐年抓 → (產物 dict 或 None, 每年說明)。fetch_year(y) → (rows, err)。"""
    out = {'v': 1, 'src': 'FinMind TaiwanFuturesDaily data_id=TX(免費層)', 'unit': '點;[合約月, 開, 高, 低, 收, 結算, 量, 未平倉]',
           'note': "p = 一般盤、a = 盤後(夜盤 15:00~05:00);日期照 FinMind 原樣(歸屬由探針判)",
           'd': {}, 'years': {}, 'err': {}}
    shown = False
    for y in range(y0, y1 + 1):
        rows, err = fetch_year(y)
        if rows is None:
            out['err'][str(y)] = err or '抓不到'
            log(f'  ⚠️ {y}:{err}')
            continue
        if rows and not shown:
            log(f'  ℹ️ 欄位:{sorted(rows[0].keys())} ・盤別:{sorted({str(r.get("trading_session")) for r in rows})}')
            shown = True
        days = pick(rows)
        ok, why = year_check(days, y, today)
        out['years'][str(y)] = why
        log(f'  {"✅" if ok else "⛔"} {why}・{len(rows)} 列')
        if not ok:
            out['err'][str(y)] = why
            continue
        out['d'].update(days)
    if not out['d']:
        return None, out
    ks = sorted(out['d'])
    out['from'], out['to'] = ks[0], ks[-1]
    # 日期歸屬的線索(只印、⛔ 判):最近幾天兩個盤別的近月開收
    for d in ks[-3:]:
        s = out['d'][d]
        log(f'  🔎 {d} 一般盤 {s.get("p", [[None] * 5])[0][:5]} ・盤後 {s.get("a", [[None] * 5])[0][:5]}')
    return out, out


def main():
    tz8 = timezone(timedelta(hours=8))
    now = datetime.now(tz8)
    today = now.strftime('%Y-%m-%d')
    print(f'🌙 台指期夜盤歷史:{FROM_Y} ~ {now.year}(FinMind TaiwanFuturesDaily TX)', flush=True)
    doc, info = build(lambda y: fm_year('TaiwanFuturesDaily', y, 'TX'), max(FROM_Y, 2017), now.year, today)
    if doc is None:
        print(f'⛔ 一年都沒過守門 → 不寫檔(分支上那份保留):{info.get("err")}')
        return 1
    doc['updated'] = now.strftime('%Y-%m-%d %H:%M')
    os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, OUT)
    print(f'💾 {OUT}({os.path.getsize(OUT):,} bytes)・{doc["from"]} ~ {doc["to"]}・{len(doc["d"])} 天・沒過的年份 {list(doc["err"])}')
    return 0


def selftest():
    bad = []

    def ok(name, cond, got=''):
        print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  → {got}'))
        if not cond:
            bad.append(name)

    R = lambda d, cd, ses, c, v, o=100.0, st=None: {'date': d, 'contract_date': cd, 'trading_session': ses, 'open': o, 'max': c + 5, 'min': o - 5,
                                                   'close': c, 'settlement_price': st if st is not None else c, 'volume': v, 'open_interest': 10}
    rows = [R('2024-03-04', '202403', 'position', 18000, 90000), R('2024-03-04', '202404', 'position', 18010, 5000),
            R('2024-03-04', '202406', 'position', 18050, 100), R('2024-03-04', '202403/202404', 'position', 10, 999999),
            R('2024-03-04', '202403', 'after_market', 18100, 40000), R('2024-03-04', '202404', 'after_market', 18110, 800),
            R('2024-03-04', '202405', 'position', 0, 999), {'date': 'x'}]
    p = pick(rows)
    s = p.get('2024-03-04', {})
    ok('① 一般盤 / 盤後分開存;每個盤別只留量最大的兩個單一月份合約(⛔ 價差單、⛔ 收盤 0)',
       [x[0] for x in s.get('p', [])] == ['202403', '202404'] and [x[0] for x in s.get('a', [])] == ['202403', '202404'], s)
    ok('① 一列的格式 = [合約月, 開, 高, 低, 收, 結算, 量, 未平倉]', s['a'][0] == ['202403', 100.0, 18105.0, 95.0, 18100.0, 18100.0, 40000.0, 10.0], s['a'][0])
    # ② 年份守門:2017 從 05-15 起算
    d17 = {d: {'a': [[1]]} for d in ('2017-05-15', '2017-05-16')}
    ok2, why = year_check(d17, 2017, '2017-05-16')
    ok('② 2017 年從夜盤上線那天(05-15)起算平日,⛔ 從 1 月 1 日', ok2 and '平日 2' in why, why)
    few = {f'2024-03-{k:02d}': {'a': [[1]]} for k in range(4, 9)}
    ok3, why3 = year_check(few, 2024, '2024-12-31')
    ok('② 一整年只有 5 天夜盤 → ⛔(沒過的年份整年不寫)', not ok3, why3)
    ok('② 只有一般盤沒有盤後的日子 ⛔ 算夜盤天數', not year_check({'2024-03-04': {'p': [[1]]}}, 2024, '2024-03-04')[0])

    def fake(y):
        if y == 2018:
            return None, 'HTTP 402'
        days = []
        dt = datetime(y, 1, 1)
        while dt.year == y:
            if dt.weekday() < 5:
                d = dt.strftime('%Y-%m-%d')
                days.append(R(d, f'{y}12', 'position', 10000, 5000))
                if y != 2019 or dt.month == 1:
                    days.append(R(d, f'{y}12', 'after_market', 10010, 2000))
            dt += timedelta(days=1)
        return days, None

    doc, info = build(fake, 2017, 2020, '2020-12-31', log=lambda *a, **k: None)
    ok('③ 抓不到的年份(2018)寫進 err、夜盤太少的年份(2019)整年不寫;其他照寫', doc is not None and '2018' in doc['err'] and '2019' in doc['err']
       and any(k.startswith('2017') for k in doc['d']) and any(k.startswith('2020') for k in doc['d']) and not any(k.startswith('2019') for k in doc['d']),
       (doc and sorted(doc['err']), doc and len(doc['d'])))
    doc2, info2 = build(lambda y: (None, 'HTTP 402'), 2017, 2018, '2018-12-31', log=lambda *a, **k: None)
    ok('③ 一年都沒過 → 回 None(⛔ 寫一份空檔)', doc2 is None and set(info2['err']) == {'2017', '2018'}, info2.get('err'))
    ok('④ 預設值:FROM 空字串 → 2017(check_env_default)', FROM_Y == int(((os.environ.get('FROM') or '2017').strip() or '2017')[:4]))
    print(f"\n{'❌ ' + str(len(bad)) + ' 條沒過' if bad else '✅ TXNIGHT_HIST_SELFTEST_PASS'}")
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
