#!/usr/bin/env python3
"""🇹🇼 證交所 2004~2009 全市場每日收盤行情(MI_INDEX)+ 除權息(TWT49U)→ orphan 分支 tw_deep04(研究用,V82.0.0)

為什麼(使用者 11/06:「需要比對別的國家要挖礦就挖礦」+ 計畫 B1):
  決策台「📉 大跌撿便宜」(dip-hot-3pct)只測過 2011 以後;2008 那種一路跌一整年的空頭不在資料裡。
  證交所 MI_INDEX(每日收盤行情・全部〔不含權證〕)2004-02-11 起每天一個網址,而且**含後來下市的股票**
  → 沒有倖存者偏誤,拿來驗「大跌撿便宜碰到 2008 會不會接在半山腰」(最重要的樣本外)。
⛔ 研究用、不進 App / data / gh-pages(陷阱 #41);⛔ 不加排程;⛔ 不用金鑰;⛔ 只有上市(上櫃另外探路,不猜網址)。
走 lib_http.Gate:證交所 www 間隔 GAP_SEC 秒、忙就退避、被擋(403 / 回 HTML)就整輪停手 —— ⛔ 不換身分再試、⛔ 換機器馬上重抓。
⚠️ 證交所 www 實測(block_deep 11/02~11/05):隔 3 秒問到第 1,127 次被擋、盤中隔 5 秒第 100 次被擋;
   晚上隔 10 秒 300 次兩輪都沒被擋 → 這支沿用「一輪最多 300 次、間隔 10 秒、⛔ 盤中按」,跟 block_deep 錯開時段。

兩種模式:
  PROBE=1:只問幾天(2004-02-11 / 2006-06-01 / 2009-12-31)× 兩個網址 + TWT49U 一年 × 兩個網址,
           印出每張表的標題 / 欄位 / 第一列,⛔ 寫任何檔(第一次跑先探路:欄位名字、新舊網址哪個有資料)
  其他:照月份抓 → OUT_DIR(預設 tw_deep04/)
     YYYY-MM.json.gz = {"days": {"YYYYMMDD": [[代號, 開, 高, 低, 收, 成交股數, 成交金額, 漲跌號, 漲跌價差], ...]},
                        "none": ["YYYYMMDD", ...](官方回「沒有資料」= 休市),
                        "complete": true/false(那個月每個平日都問過、而且整個月已經過完)}
       數字 "--"(那天沒成交)→ null;漲跌號 = "+" / "-" / "X"(不比價,除權息 / 新上市那類)/ ""。
     div/YYYY.json = TWT49U 那一年的除權息(欄位照名字找,原樣存:資料日期, 代號, 前收, 參考價, 權值+息值, 權/息)
     _status.json  = {updated, start, end, months_total, months_complete, days_with_data, div_years, fetched_this_run, last_day, stopped, more, gate}
  時間到(MAX_MIN 分)或這輪問滿 MAX_REQ 次就存檔收工(more=1),下一輪接著抓;complete 的月份 / 已抓的年份 ⛔ 重抓。

跑法:python3 scripts/tw_deep04_fetch.py [--selftest]
環境變數:OUT_DIR=tw_deep04  START=2004-02  END=2009-12  MAX_MIN=80  MAX_REQ=300  GAP_SEC=10  PROBE=0
          MI_URL / DIV_URL(PROBE 量到哪個網址有資料再填;預設新網址)
"""
import gzip
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib_http import Gate  # noqa: E402

MI_NEW = 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX'
MI_OLD = 'https://www.twse.com.tw/exchangeReport/MI_INDEX'
DIV_NEW = 'https://www.twse.com.tw/rwd/zh/exRight/TWT49U'
DIV_OLD = 'https://www.twse.com.tw/exchangeReport/TWT49U'
GAP_SEC = 10.0
# 欄位照名字找(⛔ 用位置:新舊網址、不同年份欄位順序可能不同)
NEED = ('證券代號', '開盤價', '最高價', '最低價', '收盤價', '成交股數')
OPT = ('成交金額', '漲跌(+/-)', '漲跌價差')
DIV_NEED = ('股票代號',)
DIV_ALIAS = {
    'd': ('資料日期', '除權息日期', '日期'),
    'code': ('股票代號', '證券代號'),
    'pc': ('除權息前收盤價', '除權息前收盤'),
    'ref': ('除權息參考價', '參考價'),
    'val': ('權值+息值', '權值+息值(元)', '權值 + 息值'),
    'kind': ('權/息', '除權息'),
}


def _num(s):
    t = str(s if s is not None else '').replace(',', '').strip()
    if not t or t in ('--', '---', '-', 'X', 'x'):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _sign(s):
    t = re.sub(r'<[^>]*>', '', str(s or '')).strip()
    if '+' in t:
        return '+'
    if '-' in t:
        return '-'
    if 'X' in t.upper():
        return 'X'
    return ''


def _tables(obj):
    """回應裡所有 (title, fields, data):新網址 tables[] / 舊網址 fieldsN + dataN / 單一 fields + data。"""
    out = []
    for t in obj.get('tables') or []:
        if isinstance(t, dict):
            out.append((str(t.get('title') or ''), [str(f).strip() for f in t.get('fields') or []], t.get('data') or []))
    for k, v in obj.items():
        m = re.fullmatch(r'fields(\d*)', str(k))
        if m and isinstance(v, list):
            out.append((str(obj.get('subtitle' + m.group(1)) or obj.get('title') or k), [str(f).strip() for f in v],
                        obj.get('data' + m.group(1)) or []))
    return out


def parse_day(obj):
    """MI_INDEX 一天的回應 → ('data', rows) / ('none', []) / ('format', 說明)。純函式。
    找「欄位同時有 證券代號 / 開高低收 / 成交股數」那張表(⛔ 用位置);stat 不是 OK = 休市 → none;
    stat OK 卻找不到那張表 = 格式變了 → format(⛔ 默默寫空的)。"""
    if not isinstance(obj, dict):
        return 'format', f'回應不是物件({type(obj).__name__})'
    if str(obj.get('stat', '')).upper() != 'OK':
        return 'none', []
    hit = [(ti, f, d) for ti, f, d in _tables(obj) if all(n in f for n in NEED)]
    if not hit:
        return 'format', '找不到個股收盤行情那張表(表:' + ' / '.join(f'{ti}:{f[:6]}' for ti, f, _ in _tables(obj))[:300] + ')'
    ti, f, data = max(hit, key=lambda x: len(x[2]))
    ix = {n: f.index(n) for n in NEED + OPT if n in f}
    out = []
    for r in data:
        if not isinstance(r, list) or len(r) < len(f):
            continue
        code = re.sub(r'<[^>]*>', '', str(r[ix['證券代號']])).strip()
        if not code or code == '總計' or len(code) > 6:
            continue
        g = lambda n: _num(r[ix[n]]) if n in ix else None  # noqa: E731
        out.append([code, g('開盤價'), g('最高價'), g('最低價'), g('收盤價'), g('成交股數'), g('成交金額'),
                    _sign(r[ix['漲跌(+/-)']]) if '漲跌(+/-)' in ix else '', g('漲跌價差')])
    return ('data', out) if out else ('format', f'{ti} 那張表一列都讀不出來')


def roc_date(s):
    """'93年07月15日' / '0930715' / '2004/07/15' / '20040715' → '2004-07-15';讀不出來 → ''。"""
    t = re.sub(r'<[^>]*>', '', str(s or '')).strip()
    m = re.fullmatch(r'(\d{2,3})年(\d{1,2})月(\d{1,2})日', t)
    if m:
        return f'{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    m = re.fullmatch(r'(\d{4})[/-]?(\d{2})[/-]?(\d{2})', t)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
    m = re.fullmatch(r'(\d{2,3})[/-]?(\d{2})[/-]?(\d{2})', t)
    if m:
        return f'{int(m.group(1)) + 1911:04d}-{m.group(2)}-{m.group(3)}'
    return ''


def parse_div(obj):
    """TWT49U 一段期間的回應 → ('data', [[日期, 代號, 前收, 參考價, 權值+息值, 權/息], ...]) / ('none', []) / ('format', 說明)。"""
    if not isinstance(obj, dict):
        return 'format', '回應不是物件'
    if str(obj.get('stat', '')).upper() != 'OK':
        return 'none', []
    for ti, f, data in _tables(obj):
        ix = {}
        for k, names in DIV_ALIAS.items():
            for n in names:
                if n in f:
                    ix[k] = f.index(n)
                    break
        if not all(k in ix for k in ('d', 'code', 'pc', 'ref')):
            continue
        out = []
        for r in data:
            if not isinstance(r, list) or len(r) < len(f):
                continue
            d, code = roc_date(r[ix['d']]), re.sub(r'<[^>]*>', '', str(r[ix['code']])).strip()
            if not d or not code:
                continue
            out.append([d, code, _num(r[ix['pc']]), _num(r[ix['ref']]),
                        _num(r[ix['val']]) if 'val' in ix else None,
                        re.sub(r'<[^>]*>', '', str(r[ix['kind']])).strip() if 'kind' in ix else ''])
        return ('data', out) if out else ('none', [])
    return 'format', '找不到除權息那張表(表:' + ' / '.join(f'{ti}:{f[:6]}' for ti, f, _ in _tables(obj))[:300] + ')'


def month_weekdays(y, m, upto):
    d, out = date(y, m, 1), []
    while d.month == m and d < upto:
        if d.weekday() < 5:
            out.append(d.strftime('%Y%m%d'))
        d += timedelta(days=1)
    return out


def months_between(start_ym, end_ym):
    y, m = int(start_ym[:4]), int(start_ym[5:7])
    ey, em = int(end_ym[:4]), int(end_ym[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def load_month(path):
    try:
        with gzip.open(path, 'rt', encoding='utf-8') as fh:
            j = json.load(fh)
        if isinstance(j, dict) and isinstance(j.get('days'), dict) and isinstance(j.get('none'), list):
            return j
    except (OSError, ValueError, EOFError):
        pass
    return {'days': {}, 'none': [], 'complete': False}


def save_month(path, mj):
    tmp = str(path) + '.tmp'
    with gzip.open(tmp, 'wt', encoding='utf-8') as fh:
        json.dump(mj, fh, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)


def run(out_dir, start_ym, end_ym, today, max_min, gate, clock=time.time, log=print, max_req=10 ** 9,
        mi_url=MI_NEW, div_url=DIV_NEW, first_day='20040211'):
    """抓到時間到 / 被擋 / 全部完成為止 → status dict。先抓每一年的除權息(一年一次),再一天一天抓收盤行情。"""
    out = Path(out_dir)
    (out / 'div').mkdir(parents=True, exist_ok=True)
    t0 = clock()
    months = months_between(start_ym, end_ym)
    stopped, more, last_day, fetched = '', 0, '', 0

    def budget():
        return (clock() - t0) / 60 > max_min or fetched >= max_req

    # ① 除權息:一年一次(⛔ 重抓已經有的年份)
    for y in sorted({y for y, _ in months}):
        p = out / 'div' / f'{y}.json'
        if p.exists():
            continue
        if budget():
            more = 1
            break
        res, why = gate.get(div_url, params={'response': 'json', 'startDate': f'{y}0101', 'endDate': f'{y}1231',
                                             'strDate': f'{y}0101'})
        fetched += 1
        if res is None:
            if why.startswith('斷路'):
                stopped = f'除權息 {y} {why}'
                break
            log(f'  ⚠️ 除權息 {y}:{why}(下一輪再問)')
            continue
        try:
            kind, rows = parse_div(res.json())
        except ValueError:
            kind, rows = 'format', '不是 JSON'
        if kind == 'format':
            stopped = f'除權息 {y} 格式不對:{rows}'
            break
        p.write_text(json.dumps({'y': y, 'rows': rows}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        log(f'  除權息 {y}:{len(rows)} 筆')

    # ② 每天的收盤行情
    if not stopped and not more:
        for y, m in months:
            p = out / f'{y:04d}-{m:02d}.json.gz'
            mj = load_month(p)
            if mj.get('complete'):
                continue
            todo = [d for d in month_weekdays(y, m, today) if d >= first_day and d not in mj['days'] and d not in mj['none']]
            for ds in todo:
                if budget():
                    more = 1
                    break
                res, why = gate.get(mi_url, params={'response': 'json', 'date': ds, 'type': 'ALLBUT0999'})
                if res is None:
                    if why.startswith('斷路'):
                        stopped = f'{ds} {why}'
                        break
                    log(f'  ⚠️ {ds}:{why}(這天先跳過,下一輪再問)')
                    continue
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
                              all(d in mj['days'] or d in mj['none'] for d in month_weekdays(y, m, today) if d >= first_day))
            if mj['days'] or mj['none']:
                save_month(p, mj)
                log(f'  {y:04d}-{m:02d}:有資料 {len(mj["days"])} 天、沒有 {len(mj["none"])} 天{"、完成" if mj["complete"] else ""}')
            if stopped or more:
                break
    files = sorted(out.glob('[0-9][0-9][0-9][0-9]-[0-9][0-9].json.gz'))
    comp = sum(1 for f in files if load_month(f).get('complete'))
    ndays = sum(len(load_month(f)['days']) for f in files)
    divy = sorted(int(p.stem) for p in (out / 'div').glob('[0-9][0-9][0-9][0-9].json'))
    if not stopped and not more and (comp < len(months) or len(divy) < len({y for y, _ in months})):
        more = 1   # 這輪有跳過的日子(暫時失敗)→ 下一輪再補
    st = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'start': start_ym, 'end': end_ym,
          'months_total': len(months), 'months_complete': comp, 'days_with_data': ndays, 'div_years': divy,
          'fetched_this_run': fetched, 'last_day': last_day, 'stopped': stopped, 'more': more,
          'gate': getattr(gate, 'stats', {})}
    if stopped:
        st['blocked_page'] = (getattr(gate, 'blocked_page', None) or {}).get('www.twse.com.tw', '')
    (out / '_status.json').write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding='utf-8')
    return st


def probe(gate, log=print):
    """第一次跑先探路:新舊網址各問 3 天 + 除權息一年,印出表的標題 / 欄位 / 第一列(⛔ 寫檔)。回傳 {url: 結果摘要}。"""
    res_all = {}
    for url in (MI_NEW, MI_OLD):
        for ds in ('20040211', '20060601', '20091231'):
            r, why = gate.get(url, params={'response': 'json', 'date': ds, 'type': 'ALLBUT0999'})
            key = f'{url.split("twse.com.tw")[1]} {ds}'
            if r is None:
                res_all[key] = why
                log(f'🔭 {key}:{why}')
                if why.startswith('斷路'):
                    return res_all
                continue
            try:
                obj = r.json()
            except ValueError:
                res_all[key] = '不是 JSON'
                log(f'🔭 {key}:不是 JSON')
                continue
            kind, rows = parse_day(obj)
            res_all[key] = f'{kind} {len(rows) if kind == "data" else rows}'
            log(f'🔭 {key}:stat={obj.get("stat")} → {kind}' + (f' {len(rows)} 檔,第一列 {rows[0]}' if kind == 'data' else f' {rows}'))
            for ti, f, d in _tables(obj):
                log(f'     表「{ti}」{len(d)} 列 欄位 {f}' + (f' 第一列 {d[0]}' if d else ''))
    for url in (DIV_NEW, DIV_OLD):
        r, why = gate.get(url, params={'response': 'json', 'startDate': '20080101', 'endDate': '20081231', 'strDate': '20080101'})
        key = f'{url.split("twse.com.tw")[1]} 2008'
        if r is None:
            res_all[key] = why
            log(f'🔭 {key}:{why}')
            if why.startswith('斷路'):
                return res_all
            continue
        try:
            obj = r.json()
        except ValueError:
            res_all[key] = '不是 JSON'
            log(f'🔭 {key}:不是 JSON')
            continue
        kind, rows = parse_div(obj)
        res_all[key] = f'{kind} {len(rows) if kind == "data" else rows}'
        log(f'🔭 {key}:stat={obj.get("stat")} → {kind}' + (f' {len(rows)} 筆,第一列 {rows[0]}' if kind == 'data' and rows else f' {rows}'))
        for ti, f, d in _tables(obj):
            log(f'     表「{ti}」{len(d)} 列 欄位 {f}' + (f' 第一列 {d[0]}' if d else ''))
    return res_all


def gap_sec(raw):
    try:
        v = float(raw) if str(raw or '').strip() else GAP_SEC
    except ValueError:
        v = GAP_SEC
    return max(v, 3.0)


def main():
    out_dir = os.environ.get('OUT_DIR') or 'tw_deep04'
    start = (os.environ.get('START') or '2004-02').strip()
    end = (os.environ.get('END') or '2009-12').strip()
    max_min = float(os.environ.get('MAX_MIN') or '80')
    max_req = int(os.environ.get('MAX_REQ') or '300')
    gap = gap_sec(os.environ.get('GAP_SEC'))
    gate = Gate(gaps={'www.twse.com.tw': gap})
    if (os.environ.get('PROBE') or '0').strip() == '1':
        print(f'🔭 探路:MI_INDEX 新舊網址 × 3 天 + TWT49U 2008 × 2 個網址(間隔 {gap:g} 秒,⛔ 寫檔)')
        r = probe(gate)
        summ = os.environ.get('GITHUB_STEP_SUMMARY')
        if summ:
            with open(summ, 'a', encoding='utf-8') as f:
                f.write(f'## 🔭 tw_deep04 探路\n\n```\n{json.dumps(r, ensure_ascii=False, indent=1)}\n```\n')
        return 3 if any(str(v).startswith('斷路') for v in r.values()) else 0
    today = datetime.now(timezone(timedelta(hours=8))).date()
    mi_url = (os.environ.get('MI_URL') or MI_NEW).strip()
    div_url = (os.environ.get('DIV_URL') or DIV_NEW).strip()
    print(f'🇹🇼 證交所全市場日 K:{start} ~ {end}、最多 {max_min:.0f} 分鐘 / {max_req} 次、間隔 {gap:g} 秒 → {out_dir}/({mi_url})')
    st = run(out_dir, start, end, today, max_min, gate, max_req=max_req, mi_url=mi_url, div_url=div_url)
    print(f'\n📋 完成 {st["months_complete"]}/{st["months_total"]} 個月、有資料 {st["days_with_data"]} 天、'
          f'除權息 {len(st["div_years"])} 年、這輪問了 {st["fetched_this_run"]} 次、最後 {st["last_day"] or "—"}、'
          f'{"⛔ 停手:" + st["stopped"] if st["stopped"] else ("時間到,下一輪接著抓" if st["more"] else "全部抓完")}')
    if st.get('blocked_page'):
        print(f'   擋頁文字:{st["blocked_page"]}')
    summ = os.environ.get('GITHUB_STEP_SUMMARY')
    if summ:
        with open(summ, 'a', encoding='utf-8') as f:
            f.write(f'## 🇹🇼 tw_deep04\n\n```\n{json.dumps(st, ensure_ascii=False, indent=1)}\n```\n')
    return 3 if st['stopped'] else 0


def selftest():
    import tempfile
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:240]}'))
        if not cond:
            fails.append(name)

    F = ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)', '漲跌價差',
         '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量', '本益比']
    row = ['2330', '台積電', '45,123,000', '9,000', '2,689,000,000', '59.00', '60.00', '58.50', '59.50',
           '<p style= color:red>+</p>', '0.50', '59.50', '10', '60.00', '20', '12.30']
    dead = ['1234', '某某', '0', '0', '0', '--', '--', '--', '--', '<p> </p>', '0.00', '--', '0', '--', '0', '0.00']
    xrow = ['2002', '中鋼', '1,000', '1', '30,000', '30.00', '30.00', '30.00', '30.00', '<p>X</p>', '0.00', '', '', '', '', '']
    new = {'stat': 'OK', 'date': '20040211', 'tables': [
        {'title': '價格指數(臺灣證券交易所)', 'fields': ['指數', '收盤指數', '漲跌(+/-)'], 'data': [['發行量加權股價指數', '6,021.06', '+']]},
        {'title': '每日收盤行情(全部(不含權證、牛熊證))', 'fields': F, 'data': [row, dead, xrow]}]}
    k, rows = parse_day(new)
    ok('① 新網址 tables[]:欄位照名字找、跳過指數那張表、數字去逗號、+/−/X 讀出來、-- = 沒成交 → null',
       k == 'data' and rows[0] == ['2330', 59.0, 60.0, 58.5, 59.5, 45123000.0, 2689000000.0, '+', 0.5]
       and rows[1][4] is None and rows[1][7] == '' and rows[2][7] == 'X', rows)
    F2 = F[:2] + ['成交金額', '成交股數'] + F[5:]   # 換欄位順序(舊網址 / 舊年份)
    old = {'stat': 'OK', 'fields1': ['指數'], 'data1': [['加權']], 'fields9': F2,
           'data9': [['2330', '台積電', '2,689,000,000', '45,123,000', '9,000'] + row[5:]]}
    k2, rows2 = parse_day(old)
    ok('② 舊網址 fieldsN/dataN + 欄位順序換了 → 照名字讀(成交股數 / 金額 ⛔ 讀錯位)',
       k2 == 'data' and rows2[0][5] == 45123000.0 and rows2[0][6] == 2689000000.0, rows2)
    ok('③ stat 不是 OK(休市)→ none', parse_day({'stat': '很抱歉,沒有符合條件的資料!'}) == ('none', []))
    ok('④ stat OK 卻沒有個股那張表 → format(⛔ 默默寫空的)',
       parse_day({'stat': 'OK', 'tables': [{'title': '價格指數', 'fields': ['指數'], 'data': [['x']]}]})[0] == 'format')
    ok('⑤ 民國 / 西元日期都讀得出來', [roc_date(x) for x in ('93年07月15日', '0930715', '2004/07/15', '20040715', '亂寫')]
       == ['2004-07-15', '2004-07-15', '2004-07-15', '2004-07-15', ''])
    DF = ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息', '漲停價格', '跌停價格']
    dv = {'stat': 'OK', 'fields': DF, 'data': [['97年07月14日', '2330', '台積電', '64.50', '61.47', '3.03', '權息', '', ''],
                                              ['', '', '', '', '', '', '', '', '']]}
    k3, r3 = parse_div(dv)
    ok('⑥ 除權息:欄位照名字找、日期轉西元、空列 ⛔ 收', k3 == 'data' and r3 == [['2008-07-14', '2330', 64.5, 61.47, 3.03, '權息']], r3)
    ok('⑥b 除權息格式不對 → format', parse_div({'stat': 'OK', 'fields': ['代號'], 'data': [['1']]})[0] == 'format')

    class R:
        def __init__(self, obj):
            self._o = obj

        def json(self):
            return self._o

    class FakeGate:
        def __init__(self, plan, dplan=None):
            self.plan, self.dplan, self.asked, self.dasked, self.stats = plan, dplan or (lambda y: dv), [], [], {}

        def get(self, url, params=None):
            if 'TWT49U' in url:
                y = params['startDate'][:4]
                self.dasked.append(y)
                x = self.dplan(y)
            else:
                ds = params['date']
                self.asked.append(ds)
                x = self.plan(ds)
            return (R(x), '') if isinstance(x, dict) else (None, x)

    today = date(2026, 11, 6)
    tmp = tempfile.mkdtemp()
    plan = lambda ds: new if ds.endswith(('05', '06')) else {'stat': 'NO'}  # noqa: E731
    g = FakeGate(plan)
    st = run(tmp, '2004-02', '2004-03', today, 999, g, log=lambda *a: None)
    feb = load_month(os.path.join(tmp, '2004-02.json.gz'))
    ok('⑦ 2004-02 從 02/11 起才問(⛔ 問開始之前的日子)、兩個月都 complete、除權息那一年問一次',
       min(g.asked) == '20040211' and feb['complete'] and load_month(os.path.join(tmp, '2004-03.json.gz'))['complete']
       and g.dasked == ['2004'] and st['div_years'] == [2004] and st['more'] == 0 and st['stopped'] == '', (min(g.asked), st))
    n1 = len(g.asked)
    g2 = FakeGate(plan)
    run(tmp, '2004-02', '2004-03', today, 999, g2, log=lambda *a: None)
    ok('⑧ 再跑一次:complete 的月份 / 已有的除權息年份 ⛔ 重抓', g2.asked == [] and g2.dasked == [] and n1 > 25, (n1, g2.asked, g2.dasked))
    tmp2 = tempfile.mkdtemp()
    g3 = FakeGate(lambda ds: '斷路:要 JSON 卻回 HTML(擋頁)' if ds >= '20040301' else new)
    g3.blocked_page = {'www.twse.com.tw': '因為安全性考量…'}
    st3 = run(tmp2, '2004-02', '2004-03', today, 999, g3, log=lambda *a: None)
    ok('⑨ 被擋 → 整輪停手、已抓的照存、記下擋頁文字(⛔ 繼續打)',
       st3['stopped'].startswith('20040301') and len(load_month(os.path.join(tmp2, '2004-02.json.gz'))['days']) == 13
       and g3.asked[-1] == '20040301' and st3.get('blocked_page') == '因為安全性考量…', st3)
    g4 = FakeGate(lambda ds: new)
    run(tmp2, '2004-02', '2004-03', today, 999, g4, log=lambda *a: None)
    ok('⑩ 下一輪從被擋那天接著抓(⛔ 從頭來)', g4.asked[0] == '20040301', g4.asked[:2])
    g5 = FakeGate(lambda ds: new)
    st5 = run(tempfile.mkdtemp(), '2004-02', '2004-03', today, 999, g5, log=lambda *a: None, max_req=6)
    ok('⑪ 問滿 MAX_REQ 次 → 收工、more=1(除權息那次也算一次)', len(g5.asked) + len(g5.dasked) == 6 and st5['more'] == 1, (len(g5.asked), st5))
    g6 = FakeGate(lambda ds: '連不上 ConnectionError' if ds == '20040212' else new)
    tmp6 = tempfile.mkdtemp()
    st6 = run(tmp6, '2004-02', '2004-02', today, 999, g6, log=lambda *a: None)
    ok('⑫ 單一天暫時失敗 → 跳過那天、那個月 ⛔ complete、more=1',
       not load_month(os.path.join(tmp6, '2004-02.json.gz'))['complete'] and st6['more'] == 1 and not st6['stopped'], st6)
    g7 = FakeGate(lambda ds: {'stat': 'OK', 'tables': []})
    st7 = run(tempfile.mkdtemp(), '2004-02', '2004-02', today, 999, g7, log=lambda *a: None)
    ok('⑬ 格式變了 → 停手、標 stopped(⛔ 寫一堆空的天)', st7['stopped'].startswith('20040211') and '格式不對' in st7['stopped'], st7)
    g8 = FakeGate(lambda ds: new, dplan=lambda y: '斷路:HTTP 403')
    st8 = run(tempfile.mkdtemp(), '2004-02', '2004-02', today, 999, g8, log=lambda *a: None)
    ok('⑭ 除權息就被擋 → 收盤行情一天都 ⛔ 問', st8['stopped'].startswith('除權息 2004') and g8.asked == [], st8)
    ok('⑮ 間隔:空 / 壞值 = 10 秒、⛔ 比 3 秒快', [gap_sec(x) for x in (None, '', 'abc', '15', '1')] == [10.0, 10.0, 10.0, 15.0, 3.0])
    src = open(os.path.abspath(__file__), encoding='utf-8').read()
    ok('⑯ 走共用連線守門 lib_http.Gate(⛔ 自己寫 requests)', 'from lib_http import Gate' in src and 'import requests' not in src.replace("'import requests'", ''))
    # 探路:⛔ 寫檔
    tmpp = tempfile.mkdtemp()
    cwd = os.getcwd()
    os.chdir(tmpp)
    try:
        gp = FakeGate(lambda ds: new)
        pr = probe(gp, log=lambda *a: None)
    finally:
        os.chdir(cwd)
    ok('⑰ 探路:新舊網址 × 3 天 + 除權息兩個網址、⛔ 寫任何檔', len(pr) == 8 and os.listdir(tmpp) == [], (pr, os.listdir(tmpp)))
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 18 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
