#!/usr/bin/env python3
"""🐘 鉅額交易歷史(證交所 BFIAUU)→ orphan 分支 block_deep(研究用,V80.1.9)。

為什麼:V79.0.0 鉅額交易跟著 FinMind 付費資料一起拿掉;V80.1.9 探針(official_extra_probe.py)證實
  證交所免費官方的 BFIAUU 抓得到 2008-06 起的每一天(2005-04 那幾天是空的;2011-12-16 前多一欄「交割期別」)
  → 拿回來回測「鉅額交易占成交量前 1%」(評估紀錄 52 的策略 D)。只有上市;上櫃的鉅額 ⛔ 沒驗過網址,不猜。
⛔ 只研究用、不進 App;⛔ 不進 data / gh-pages(陷阱 #41);⛔ 不加排程;⛔ 不用金鑰。
走 lib_http.Gate:證交所隔 3 秒、忙就退避、被擋(403 / 回 HTML)就整輪停手 —— ⛔ 不換身分再試。

輸出(OUT_DIR,預設 block_deep/):
  YYYY-MM.json = {"days": {"YYYYMMDD": [[代號, 交易別, 成交價, 成交股數, 成交金額], ...]},
                  "none": ["YYYYMMDD", ...](官方回「沒有資料」= 休市或那天沒有鉅額),
                  "complete": true/false(那個月每個平日都問過、而且整個月已經過完)}
  _status.json = {updated, start, months_total, months_complete, days_with_data, last_day, stopped, more}
時間到(MAX_MIN 分)或這輪問滿 MAX_REQ 次就存檔收工(more=1),下一輪接著抓;已經 complete 的月份 ⛔ 重抓。
🚦 2026-11-02 第一輪:隔 3 秒(實際平均 4.4 秒一次)問到第 1,127 次,證交所改回 HTML 擋頁 → 斷路停手(已抓的 52 個月照推)。
   → 這支改成間隔 5 秒、每輪最多 600 次,一天按一次 Run;⛔ 被擋就換一台機器馬上重抓(那等於繞過封鎖)。
🚦 2026-11-03 第二輪(台北 10:24,盤中):隔 5 秒,問到第 100 次就被擋 → 不是單純「問太多次」(第一輪 1,127 次才擋)。
   → 再減半、拉長:每輪 300 次、間隔 10 秒(GAP_SEC),改在收盤後的晚上按;被擋時把擋頁文字記進 _status.json 的
   blocked_page(分得出「暫時封鎖」還是「系統忙碌 / 維護」)。

跑法:python3 scripts/block_deep_fetch.py [--selftest]
環境變數:OUT_DIR=block_deep  START=2009-01(最早抓到哪個月)  MAX_MIN=80  MAX_REQ=300(這輪最多問幾次)  GAP_SEC=10(間隔秒數)
"""
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib_http import Gate  # noqa: E402

URL = 'https://www.twse.com.tw/rwd/zh/block/BFIAUU'
FAIL_STOP = 5     # 連續幾天都失敗(不是斷路)就整輪停手
GAP_SEC = 10.0    # 預設間隔(環境變數 GAP_SEC 可改):第一輪 3 秒問到第 1,127 次被擋、第二輪 5 秒問到第 100 次被擋
FIELDS = ('證券代號', '交易別', '成交價', '成交股數', '成交金額')


def _num(s):
    try:
        return float(str(s).replace(',', '').strip())
    except (TypeError, ValueError):
        return None


def parse_day(obj):
    """BFIAUU 一天的回應 → ('data', rows) / ('none', []) / ('format', 說明)。純函式。
    欄位用名字找(2011-12-16 前多一欄「交割期別」,用位置讀會錯位);最後一列「總計」⛔ 收。"""
    if not isinstance(obj, dict):
        return 'format', f'回應不是物件({type(obj).__name__})'
    if str(obj.get('stat', '')).upper() != 'OK':
        return 'none', []
    fields = [str(f).strip() for f in obj.get('fields') or []]
    miss = [f for f in FIELDS if f not in fields]
    if miss:
        return 'format', f'少了欄位 {miss}(實際 {fields})'
    ix = [fields.index(f) for f in FIELDS]
    out = []
    for r in obj.get('data') or []:
        if not isinstance(r, list) or len(r) < len(fields):
            continue
        code = str(r[ix[0]]).strip()
        if not code or code == '總計':
            continue
        out.append([code, str(r[ix[1]]).strip(), _num(r[ix[2]]), _num(r[ix[3]]), _num(r[ix[4]])])
    return ('data', out) if out else ('none', [])


def month_weekdays(y, m, upto):
    """那個月 upto(不含)之前的平日 → ['YYYYMMDD', ...]。"""
    d, out = date(y, m, 1), []
    while d.month == m and d < upto:
        if d.weekday() < 5:
            out.append(d.strftime('%Y%m%d'))
        d += timedelta(days=1)
    return out


def months_between(start_ym, end_date):
    y, m = int(start_ym[:4]), int(start_ym[5:7])
    out = []
    while (y, m) <= (end_date.year, end_date.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def load_month(path):
    try:
        j = json.loads(Path(path).read_text(encoding='utf-8'))
        if isinstance(j, dict) and isinstance(j.get('days'), dict) and isinstance(j.get('none'), list):
            return j
    except (OSError, ValueError):
        pass
    return {'days': {}, 'none': [], 'complete': False}


def run(out_dir, start_ym, today, max_min, gate, clock=time.time, log=print, max_req=10 ** 9):
    """抓到時間到 / 被擋 / 全部完成為止 → status dict。today = 台北今天(只抓今天以前的,今天的可能還沒公布)。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = clock()
    months = months_between(start_ym, today)
    stopped, more, last_day, fetched = '', 0, '', 0
    asked, fails_in_row = 0, 0   # asked = 這輪送出幾次(⛔ 只算成功的:11/09 每天都回 307 → 「最多 300 次」形同虛設,問了 426 次)
    for y, m in months:
        p = out / f'{y:04d}-{m:02d}.json'
        mj = load_month(p)
        if mj.get('complete'):
            continue
        todo = [d for d in month_weekdays(y, m, today) if d not in mj['days'] and d not in mj['none']]
        for ds in todo:
            if (clock() - t0) / 60 > max_min or asked >= max_req:
                more = 1
                break
            res, why = gate.get(URL, params={'response': 'json', 'date': ds})
            asked += 1
            if res is None:
                if why.startswith('斷路'):
                    stopped = f'{ds} {why}'
                    break
                fails_in_row += 1
                if fails_in_row >= FAIL_STOP:
                    # 一天失敗可能是那天剛好有問題;連續好幾天都一樣失敗 = 網址改了或換了擋法 → 停手、亮紅燈(⛔ 一直問到時間到)
                    stopped = f'{ds} 連續 {fails_in_row} 天都失敗(最後一次:{why})→ 網址可能改了或被擋,先別再按'
                    break
                log(f'  ⚠️ {ds}:{why}(這天先跳過,下一輪再問)')
                continue
            fails_in_row = 0
            try:
                kind, rows = parse_day(res.json())
            except ValueError:
                kind, rows = 'format', '不是 JSON'
            if kind == 'format':
                stopped = f'{ds} 格式不對:{rows}'
                break
            if kind == 'data':
                mj['days'][ds] = rows
            else:
                mj['none'].append(ds)
            fetched += 1
            last_day = ds
        last_of_month = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
        mj['none'] = sorted(set(mj['none']))
        mj['complete'] = (last_of_month <= today and
                          all(d in mj['days'] or d in mj['none'] for d in month_weekdays(y, m, today)))
        if mj['days'] or mj['none']:
            p.write_text(json.dumps(mj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            log(f'  {y:04d}-{m:02d}:有資料 {len(mj["days"])} 天、沒有 {len(mj["none"])} 天'
                f'{"、完成" if mj["complete"] else ""}')
        if stopped or more:
            break
    files = sorted(out.glob('[0-9][0-9][0-9][0-9]-[0-9][0-9].json'))
    comp = sum(1 for f in files if load_month(f).get('complete'))
    ndays = sum(len(load_month(f)['days']) for f in files)
    if not stopped and not more and comp < len(months) - 1:
        more = 1   # 這輪有跳過的日子(暫時失敗)→ 下一輪再補
    st = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'start': start_ym,
          'months_total': len(months), 'months_complete': comp, 'days_with_data': ndays,
          'fetched_this_run': fetched, 'asked_this_run': asked, 'last_day': last_day, 'stopped': stopped, 'more': more,
          'gate': gate.stats}
    if stopped:
        # 擋頁 / 失敗那一頁長什麼樣(lib_http 記的)→ 下一輪要不要按、隔多久,看這個決定
        host = 'www.twse.com.tw'
        st['blocked_page'] = ((getattr(gate, 'blocked_page', None) or {}).get(host)
                              or (getattr(gate, 'fail_page', None) or {}).get(host, ''))
    (out / '_status.json').write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding='utf-8')
    return st


def gap_sec(raw):
    """GAP_SEC 環境變數 → 間隔秒數:空 / 壞值 = 預設 GAP_SEC;⛔ 比 3 秒快(lib_http 給證交所 www 的下限)。"""
    try:
        v = float(raw) if str(raw or '').strip() else GAP_SEC
    except ValueError:
        v = GAP_SEC
    return max(v, 3.0)


def main():
    out_dir = os.environ.get('OUT_DIR') or 'block_deep'
    start = (os.environ.get('START') or '2009-01').strip()
    max_min = float(os.environ.get('MAX_MIN') or '80')
    max_req = int(os.environ.get('MAX_REQ') or '300')
    gap = gap_sec(os.environ.get('GAP_SEC'))
    today = datetime.now(timezone(timedelta(hours=8))).date()
    print(f'🐘 鉅額交易歷史:{start} ~ {today}(只抓今天以前)、最多 {max_min:.0f} 分鐘 / {max_req} 次、間隔 {gap:g} 秒 → {out_dir}/')
    st = run(out_dir, start, today, max_min, Gate(gaps={'www.twse.com.tw': gap}), max_req=max_req)
    print(f'\n📋 完成 {st["months_complete"]}/{st["months_total"]} 個月、有資料 {st["days_with_data"]} 天、'
          f'這輪問了 {st["fetched_this_run"]} 天、最後 {st["last_day"] or "—"}、'
          f'{"⛔ 停手:" + st["stopped"] if st["stopped"] else ("時間到,下一輪接著抓" if st["more"] else "全部抓完")}')
    if st.get('blocked_page'):
        print(f'   擋頁文字:{st["blocked_page"]}')
    summ = os.environ.get('GITHUB_STEP_SUMMARY')
    if summ:
        with open(summ, 'a', encoding='utf-8') as f:
            f.write(f'## 🐘 鉅額交易歷史\n\n```\n{json.dumps(st, ensure_ascii=False, indent=1)}\n```\n')
    # 被擋 / 格式變了 = 真的壞掉 → 紅燈(檔案照樣推上去,下一輪接著抓);時間到 = 正常
    return 3 if st['stopped'] else 0


def selftest():
    import tempfile
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:240]}'))
        if not cond:
            fails.append(name)

    new = {'stat': 'OK', 'date': '20261030', 'fields': ['證券代號', '證券名稱', '交易別', '成交價', '成交股數', '成交金額'],
           'data': [['1590', '亞德客-KY', '配對交易', '1,080.40', '15,000', '16,206,000'],
                    ['總計', '', '', '', '15,000', '16,206,000']]}
    old = {'stat': 'OK', 'fields': ['證券代號', '證券名稱', '交易別', '交割期別', '成交價', '成交股數', '成交金額'],
           'data': [['2605', '新興', '配對交易', 'T+2日交割', '57.00', '3,000,000', '171,000,000']]}
    k, rows = parse_day(new)
    ok('① 新格式:欄位用名字找、總計列 ⛔ 收、數字去逗號', k == 'data' and rows == [['1590', '配對交易', 1080.4, 15000.0, 16206000.0]], rows)
    k, rows = parse_day(old)
    ok('② 2011-12-16 前多一欄「交割期別」→ 成交價還是 57(⛔ 用位置讀會讀到「T+2日交割」)',
       k == 'data' and rows[0][2] == 57.0 and rows[0][3] == 3000000.0, rows)
    ok('③ stat 不是 OK(休市 / 沒有鉅額)→ none', parse_day({'stat': '很抱歉,沒有符合條件的資料!'}) == ('none', []))
    ok('④ 只有總計列 → none', parse_day({**new, 'data': [['總計', '', '', '', '0', '0']]}) == ('none', []))
    ok('⑤ 少了欄位 → format(⛔ 默默寫空的)', parse_day({'stat': 'OK', 'fields': ['代號'], 'data': [['1']]})[0] == 'format')
    ok('⑥ 平日清單:2026-10 到 10/30(不含)有 21 個平日', len(month_weekdays(2026, 10, date(2026, 10, 30))) == 21)

    class R:
        def __init__(self, obj):
            self._o, self.status_code, self.content = obj, 200, b'{}'

        def json(self):
            return self._o

    class FakeGate:
        def __init__(self, plan):
            self.plan, self.asked, self.stats = plan, [], {}

        def get(self, url, params=None):
            ds = params['date']
            self.asked.append(ds)
            x = self.plan(ds)
            return (R(x), '') if isinstance(x, dict) else (None, x)

    tmp = tempfile.mkdtemp()
    today = date(2026, 11, 2)
    plan = lambda ds: new if ds.endswith(('05', '06')) else {'stat': 'NO'}  # noqa: E731
    g = FakeGate(plan)
    st = run(tmp, '2026-09', today, 999, g, log=lambda *a: None)
    sep = load_month(os.path.join(tmp, '2026-09.json'))
    ok('⑦ 9 月整個月過完 → complete;10 月也過完;11 月只抓到 11/2 以前(⛔ 今天)',
       sep['complete'] and load_month(os.path.join(tmp, '2026-10.json'))['complete']
       and '20261102' not in g.asked and st['stopped'] == '', (st, g.asked[-3:]))
    n1 = len(g.asked)
    g2 = FakeGate(plan)
    run(tmp, '2026-09', today, 999, g2, log=lambda *a: None)
    ok('⑧ 再跑一次:complete 的月份 ⛔ 重抓(只剩還沒過完的月份)', len(g2.asked) == 0 and n1 > 40, (n1, g2.asked))

    tmp2 = tempfile.mkdtemp()
    g3 = FakeGate(lambda ds: '斷路:HTTP 403' if ds >= '20260915' else new)
    st3 = run(tmp2, '2026-09', today, 999, g3, log=lambda *a: None)
    sep3 = load_month(os.path.join(tmp2, '2026-09.json'))
    ok('⑨ 被擋 → 整輪停手、已抓到的照存、標 stopped(⛔ 繼續打)',
       st3['stopped'].startswith('20260915') and len(sep3['days']) == 10 and not sep3['complete']
       and g3.asked[-1] == '20260915', (st3['stopped'], len(sep3['days'])))
    g3b = FakeGate(lambda ds: '斷路:要 JSON 卻回 HTML(擋頁)' if ds >= '20260915' else new)
    g3b.blocked_page = {'www.twse.com.tw': '您的 IP 暫時無法存取'}
    st3b = run(tempfile.mkdtemp(), '2026-09', today, 999, g3b, log=lambda *a: None)
    ok('⑨b 被擋 → _status.json 記下擋頁文字(blocked_page);決定性對照:沒被擋那輪沒有這個鍵',
       st3b.get('blocked_page') == '您的 IP 暫時無法存取' and 'blocked_page' not in st, (st3b.get('blocked_page'), st))
    g4 = FakeGate(lambda ds: new)
    run(tmp2, '2026-09', today, 999, g4, log=lambda *a: None)
    ok('⑩ 下一輪從被擋那天接著抓(⛔ 從頭來)', g4.asked[0] == '20260915', g4.asked[:2])

    t = [0.0]

    def clock():
        t[0] += 30   # 每問一天 30 秒
        return t[0]
    tmp3 = tempfile.mkdtemp()
    g5 = FakeGate(lambda ds: new)
    st5 = run(tmp3, '2026-09', today, 3, g5, clock=clock, log=lambda *a: None)
    ok('⑪ 時間到 → more=1、已抓到的存檔', st5['more'] == 1 and 0 < len(g5.asked) < 10
       and load_month(os.path.join(tmp3, '2026-09.json'))['days'], (st5, len(g5.asked)))
    g7 = FakeGate(lambda ds: new)
    st7 = run(tempfile.mkdtemp(), '2026-09', today, 999, g7, log=lambda *a: None, max_req=5)
    ok('⑪b 這輪問滿 MAX_REQ 次 → 收工、more=1(⛔ 一次問到被擋)', len(g7.asked) == 5 and st7['more'] == 1, (len(g7.asked), st7))
    g6 = FakeGate(lambda ds: '連不上 ConnectionError' if ds == '20260910' else new)
    tmp4 = tempfile.mkdtemp()
    st6 = run(tmp4, '2026-09', today, 999, g6, log=lambda *a: None)
    ok('⑫ 單一天暫時失敗(不是斷路)→ 跳過那天、9 月 ⛔ 標 complete、more=1 下一輪補',
       not load_month(os.path.join(tmp4, '2026-09.json'))['complete'] and st6['more'] == 1 and not st6['stopped'], st6)
    g8 = FakeGate(lambda ds: 'HTTP 307(沒有 Location)')
    g8.fail_page = {'www.twse.com.tw': 'Moved'}
    st8 = run(tempfile.mkdtemp(), '2026-09', today, 999, g8, log=lambda *a: None, max_req=300)
    ok('⑫c 連續 5 天都失敗(11/09 每天 307)→ 整輪停手、標 stopped(紅燈)、記下那一頁;⛔ 一直問到時間到',
       len(g8.asked) == FAIL_STOP == 5 and '連續 5 天' in st8['stopped'] and st8.get('blocked_page') == 'Moved'
       and st8['asked_this_run'] == 5, (len(g8.asked), st8))
    g9 = FakeGate(lambda ds: 'HTTP 307(沒有 Location)' if int(ds[-2:]) % 2 else new)
    st9 = run(tempfile.mkdtemp(), '2026-09', today, 999, g9, log=lambda *a: None, max_req=6)
    ok('⑫d 「最多問幾次」算的是送出幾次(含失敗的),⛔ 只算成功的(11/09 問了 426 次)',
       len(g9.asked) == 6 and st9['asked_this_run'] == 6 and st9['more'] == 1 and not st9['stopped'], (len(g9.asked), st9))
    ok('⑫b 間隔:空 / 壞值 = 預設 10 秒、可以調慢、⛔ 比 3 秒快(填 1 → 3)',
       [gap_sec(x) for x in (None, '', 'abc', '15', '1')] == [10.0, 10.0, 10.0, 15.0, 3.0],
       [gap_sec(x) for x in (None, '', 'abc', '15', '1')])
    src = open(os.path.abspath(__file__), encoding='utf-8').read()
    ok('⑬ 走共用連線守門 lib_http.Gate(⛔ 自己寫 requests;⛔ 偽裝瀏覽器)',
       'from lib_http import Gate' in src and 'requests.get' not in src.replace("'requests.get'", ''))
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 18 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
