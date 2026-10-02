#!/usr/bin/env python3
"""🎰 期交所「選擇權 P/C 比」與「台指期大額交易人」歷史 → data/taifex_hist.json(V78.2.5)

為什麼要有這支:當沖頁 🚦 那張卡拿這兩個數字投票(P/C 未平倉比 ≥115 → +0.5、≤85 → −0.5;
大額交易人前 10 大淨部位 >2000 口 → +1、<−2000 → −1)—— 那些權重**從來沒回測過**(陷阱 #38)。
`daytrade_pack.json` 只存當天一筆、每天覆蓋 → 要回測就得把歷史一次挖回來。

做法(⛔ 不開排程,只手動 Run 一次;結果推 data 分支):
  ① 先問期交所 OpenAPI(`/v1/PutCallRatio`、`/v1/OpenInterestOfLargeTradersFutures`)—— 回多少天就收多少天
  ② 再用期交所「下載」頁按月往回抓(⛔ 網址是候選,⚠️ 沙箱連不到期交所 → 由 Actions log 說了算)
     每一個候選都印 HTTP 狀態 + content-type + 內容開頭,並分三種結論(陷阱 #23):
       連不上(例外)/ 被擋(403/429)/ 名字猜錯或格式不同(200 但不是 CSV、或表頭對不上)
  ③ 實跑寫入優先:同一天 OpenAPI 與下載頁都有 → 用 OpenAPI(那是 App 每天在用的同一個來源)

產物:{updated, from, to, pc:{YYYY-MM-DD:[volRatio, oiRatio]}, lt:{YYYY-MM-DD:{all:[t5net,t10net,oi], spec:[...]}},
       src:{...}, src_error:{pc, lt}}
守門:兩個都 <250 天 → ⛔ 不寫、exit 1(把原因印出來)。

跑法:python3 scripts/taifex_hist_miner.py [--selftest]
      環境變數 FROM=2016-01(最早補到哪個月,留空 = 2016-01)・OUT=/tmp/taifex_hist.json
"""
import csv
import io
import json
import os
import sys
import time
from datetime import date, datetime, timezone

FROM = (os.environ.get('FROM') or '2016-01').strip()
OUT = os.environ.get('OUT') or '/tmp/taifex_hist.json'
MIN_DAYS = 250
UA = {'User-Agent': 'Mozilla/5.0 taifex_hist_miner/1.0'}
OPENAPI_PC = 'https://openapi.taifex.com.tw/v1/PutCallRatio'
OPENAPI_LT = 'https://openapi.taifex.com.tw/v1/OpenInterestOfLargeTradersFutures'
# ⚠️ 候選(⛔ 沒在 runner 上驗過;log 說了算)
DOWN_PC = 'https://www.taifex.com.tw/cht/3/pcRatioDown'
DOWN_LT = 'https://www.taifex.com.tw/cht/3/largeTraderFutDown'


def _num(s):
    try:
        return float(str(s).replace(',', '').replace('%', '').strip())
    except Exception:
        return None


def _date(s):
    """2026/09/30、20260930、2026-09-30 → 2026-09-30;認不得回 ''。"""
    s = str(s or '').strip().replace('/', '-')
    if len(s) == 8 and s.isdigit():
        s = f'{s[:4]}-{s[4:6]}-{s[6:]}'
    try:
        return datetime.strptime(s[:10], '%Y-%m-%d').strftime('%Y-%m-%d')
    except Exception:
        return ''


def _decode(b):
    for enc in ('utf-8-sig', 'cp950', 'big5'):
        try:
            return b.decode(enc)
        except Exception:
            pass
    return b.decode('utf-8', 'replace')


def _col(header, *keys):
    """表頭裡第一個「同時含有所有 key」的欄位索引;沒有回 None。"""
    for i, h in enumerate(header):
        h = str(h).replace(' ', '')
        if all(k in h for k in keys):
            return i
    return None


def parse_pc_csv(text):
    """期交所 P/C 下載檔 → {date: [volRatio, oiRatio]}。表頭對不上回 ({}, 原因)。"""
    rows = [r for r in csv.reader(io.StringIO(text)) if r and any(c.strip() for c in r)]
    if not rows:
        return {}, '空檔'
    h = rows[0]
    iD, iV, iO = _col(h, '日期'), _col(h, '成交量', '比率'), _col(h, '未平倉', '比率')
    if None in (iD, iV, iO):
        return {}, f'表頭對不上:{",".join(h)[:120]}'
    out = {}
    for r in rows[1:]:
        if len(r) <= max(iD, iV, iO):
            continue
        d = _date(r[iD]); v, o = _num(r[iV]), _num(r[iO])
        if d and v is not None and o is not None:
            out[d] = [v, o]
    return out, None


def _lt_pick(rows):
    """同一天、同一類交易人的多個月份 → 取全市場未平倉最大那個月(主力近月;同 daytrade_data_miner)。"""
    rows = [r for r in rows if (r.get('oi') or 0) > 100]
    if not rows:
        return None
    r = max(rows, key=lambda x: x['oi'])
    return [int(r['t5b'] - r['t5s']), int(r['t10b'] - r['t10s']), int(r['oi'])]


def _lt_type(s):
    s = str(s).strip()
    if s in ('0', '全部交易人') or '全部' in s:
        return 'all'
    if s in ('1', '特定法人') or '特定' in s:
        return 'spec'
    return None


def parse_lt_csv(text):
    """期交所大額交易人下載檔 → {date: {all:[...], spec:[...]}}。只收台指期(TX)。"""
    rows = [r for r in csv.reader(io.StringIO(text)) if r and any(c.strip() for c in r)]
    if not rows:
        return {}, '空檔'
    h = rows[0]
    iD, iC = _col(h, '日期'), _col(h, '商品')
    iT = _col(h, '交易人類別')
    i5b, i5s = _col(h, '前五大', '買'), _col(h, '前五大', '賣')
    i10b, i10s = _col(h, '前十大', '買'), _col(h, '前十大', '賣')
    iOI = _col(h, '全市場')
    need = (iD, iC, iT, i5b, i5s, i10b, i10s, iOI)
    if None in need:
        return {}, f'表頭對不上:{",".join(h)[:160]}'
    tmp = {}
    for r in rows[1:]:
        if len(r) <= max(need):
            continue
        if r[iC].strip().upper() not in ('TX', '臺股期貨', '台股期貨'):
            continue
        d, ty = _date(r[iD]), _lt_type(r[iT])
        vals = [_num(r[i]) for i in (i5b, i5s, i10b, i10s, iOI)]
        if not d or not ty or None in vals:
            continue
        tmp.setdefault((d, ty), []).append(dict(zip(('t5b', 't5s', 't10b', 't10s', 'oi'), vals)))
    out = {}
    for (d, ty), rs in tmp.items():
        p = _lt_pick(rs)
        if p:
            out.setdefault(d, {})[ty] = p
    return out, None


def parse_openapi_pc(data):
    out = {}
    for r in data if isinstance(data, list) else []:
        if not isinstance(r, dict):
            continue
        d = _date(r.get('Date') or r.get('日期'))
        v = _num(r.get('PutCallVolumeRatio%') or r.get('PutCallVolumeRatio') or r.get('買賣權成交量比率%'))
        o = _num(r.get('PutCallOIRatio%') or r.get('PutCallOIRatio') or r.get('買賣權未平倉量比率%'))
        if d and v is not None and o is not None:
            out[d] = [v, o]
    return out


def parse_openapi_lt(data):
    tmp = {}
    for r in data if isinstance(data, list) else []:
        if not isinstance(r, dict) or str(r.get('Contract') or '').strip().upper() != 'TX':
            continue
        d, ty = _date(r.get('Date')), _lt_type(r.get('TypeOfTraders'))
        vals = [_num(r.get(k)) for k in ('Top5Buy', 'Top5Sell', 'Top10Buy', 'Top10Sell', 'OIOfMarket')]
        if not d or not ty or None in vals:
            continue
        tmp.setdefault((d, ty), []).append(dict(zip(('t5b', 't5s', 't10b', 't10s', 'oi'), vals)))
    out = {}
    for (d, ty), rs in tmp.items():
        p = _lt_pick(rs)
        if p:
            out.setdefault(d, {})[ty] = p
    return out


def classify(status, ctype, head, exc=None):
    """陷阱 #23:把「連不上 / 被擋 / 名字猜錯」分開(下一步完全不同)。"""
    if exc is not None:
        return f'連不上({type(exc).__name__})'
    if status in (403, 429):
        return f'被擋(HTTP {status})'
    if status != 200:
        return f'HTTP {status}'
    # ⚠️ 期交所下載頁回 CSV 時 content-type 照樣標 text/html(2026-10-02 #1 實跑:開頭就是「日期,賣權成交量,…」卻被判成網頁)
    #    → 一律看內容本身:開頭是 < 或含 <html 才算網頁,⛔ 不看 content-type
    h = head.lstrip().lower()
    if h.startswith('<') or '<html' in h[:400]:
        return '名字猜錯或要別的參數(回 200 但是網頁)'
    return None


def _months(frm, today):
    y, m = int(frm[:4]), int(frm[5:7])
    out = []
    while (y, m) <= (today.year, today.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _month_end(y, m):
    import calendar
    return calendar.monthrange(y, m)[1]


def fetch_down(sess, url, parse, months, tag):
    """按月 POST 下載;回 (合併結果, 錯誤摘要或 None)。前 3 個月全失敗 → 提早收工(⛔ 不空打 120 個月)。"""
    got, errs, fails = {}, {}, 0
    for k, (y, m) in enumerate(months):
        form = {'down_type': '1', 'queryStartDate': f'{y}/{m:02d}/01', 'queryEndDate': f'{y}/{m:02d}/{_month_end(y, m):02d}'}
        if 'largeTrader' in url:
            form['commodity_id'] = 'TX'
        try:
            r = sess.post(url, data=form, headers=UA, timeout=40)
            head = _decode(r.content[:400])
            why = classify(r.status_code, r.headers.get('content-type', ''), head)
        except Exception as e:
            r, head, why = None, '', classify(0, '', '', e)
        if why is None:
            part, perr = parse(_decode(r.content))
            if perr:
                why = '格式不同:' + perr
            else:
                got.update(part)
        if why:
            fails += 1
            errs[why] = errs.get(why, 0) + 1
            if fails <= 3:
                print(f'  ⚠️ {tag} {y}/{m:02d}:{why} ・content-type={(r.headers.get("content-type") if r is not None else "-")} ・開頭={head[:160]!r}', flush=True)
        if k == 2 and not got:
            print(f'  ⛔ {tag} 前 3 個月全部失敗 → 收工(⛔ 不空打其餘 {len(months) - 3} 個月)', flush=True)
            break
        time.sleep(0.8)
    err = ' ・'.join(f'{k}×{v}' for k, v in errs.items()) or None
    return got, err


def main():
    if '--selftest' in sys.argv:
        return selftest()
    import requests
    s = requests.Session()
    today = date.today()
    src, src_err = {}, {}
    pc, lt = {}, {}
    # ① 下載頁(按月往回)
    months = _months(FROM, today)
    print(f'🎰 期交所歷史補挖:{FROM} ~ {today:%Y-%m}({len(months)} 個月)', flush=True)
    dpc, src_err['pc_down'] = fetch_down(s, DOWN_PC, parse_pc_csv, months, 'P/C')
    dlt, src_err['lt_down'] = fetch_down(s, DOWN_LT, parse_lt_csv, months, '大額交易人')
    pc.update(dpc); lt.update(dlt)
    src['pc_down'], src['lt_down'] = len(dpc), len(dlt)
    # ② OpenAPI(實跑寫入優先 → 最後覆蓋)
    for url, parse, tgt, key in ((OPENAPI_PC, parse_openapi_pc, pc, 'pc_openapi'), (OPENAPI_LT, parse_openapi_lt, lt, 'lt_openapi')):
        try:
            r = s.get(url, headers=UA, timeout=40)
            why = classify(r.status_code, r.headers.get('content-type', ''), _decode(r.content[:200]))
            if why:
                src_err[key] = why; src[key] = 0
            else:
                part = parse(r.json()); tgt.update(part); src[key] = len(part)
        except Exception as e:
            src_err[key] = classify(0, '', '', e); src[key] = 0
    print(f'📊 P/C {len(pc)} 天(下載頁 {src["pc_down"]} ・OpenAPI {src.get("pc_openapi")})'
          f' ・大額交易人 {len(lt)} 天(下載頁 {src["lt_down"]} ・OpenAPI {src.get("lt_openapi")})', flush=True)
    print(f'   錯誤:{json.dumps({k: v for k, v in src_err.items() if v}, ensure_ascii=False)}', flush=True)
    if len(pc) < MIN_DAYS and len(lt) < MIN_DAYS:
        print(f'❌ 兩個都不到 {MIN_DAYS} 天 → ⛔ 不寫(上面那幾行就是原因)')
        return 1
    ds = sorted(set(pc) | set(lt))
    out = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'from': ds[0], 'to': ds[-1],
           'n': {'pc': len(pc), 'lt': len(lt)}, 'pc': dict(sorted(pc.items())), 'lt': dict(sorted(lt.items())),
           'src': src, 'src_error': {k: v for k, v in src_err.items() if v} or None,
           'note': 'pc=[成交量比%, 未平倉比%] ・lt=[前5大淨, 前10大淨, 全市場未平倉](台指期主力近月;all=全部交易人 spec=特定法人)'}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ {OUT}:{ds[0]} ~ {ds[-1]} ・{os.path.getsize(OUT) / 1024:.0f} KB')
    return 0


def selftest():
    fails = []
    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {e}'))
        if not c:
            fails.append(n)
    pc_csv = '日期,賣權成交量,買權成交量,買賣權成交量比率%,賣權未平倉量,買權未平倉量,買賣權未平倉量比率%\n2026/09/30,500,"504",99.2,80,99,80.57\n2026/09/29,1,1,100,1,1,120\n'
    p, e = parse_pc_csv(pc_csv)
    ok('① P/C:表頭找得到、千分位/引號吃得下', e is None and p.get('2026-09-30') == [99.2, 80.57], (p, e))
    p2, e2 = parse_pc_csv('<html>錯誤</html>')
    ok('①b 表頭對不上 → 回原因(⛔ 不靜默給空)', not p2 and e2 and '表頭' in e2, e2)
    lt_csv = ('日期,商品(契約),商品名稱,到期月份(週別),交易人類別,前五大交易人買方,前五大交易人賣方,前十大交易人買方,前十大交易人賣方,全市場未沖銷部位數\n'
              '2026/09/30,TX,臺股期貨,202610,0,"30,000",12072,40000,35465,116944\n'
              '2026/09/30,TX,臺股期貨,202611,0,100,50,200,100,5000\n'
              '2026/09/30,TX,臺股期貨,666666,0,1,1,1,1,50\n'
              '2026/09/30,TX,臺股期貨,202610,1,20000,2072,30000,25465,116944\n'
              '2026/09/30,MTX,小型臺指,202610,0,9,9,9,9,99999\n')
    l, e = parse_lt_csv(lt_csv)
    ok('② 大額:只收 TX、取未平倉最大的月份、全部 / 特定分開', e is None and l.get('2026-09-30', {}).get('all') == [17928, 4535, 116944]
       and l['2026-09-30'].get('spec') == [17928, 4535, 116944], (l, e))
    oa = [{'Date': '20260930', 'Contract': 'TX', 'TypeOfTraders': '0', 'Top5Buy': '30000', 'Top5Sell': '12072',
           'Top10Buy': '40000', 'Top10Sell': '35465', 'OIOfMarket': '116944'}]
    ok('③ OpenAPI 大額 → 跟下載頁同一個形狀', parse_openapi_lt(oa) == {'2026-09-30': {'all': [17928, 4535, 116944]}})
    ok('③b OpenAPI P/C', parse_openapi_pc([{'Date': '20260930', 'PutCallVolumeRatio%': '99.2', 'PutCallOIRatio%': '80.57'}]) == {'2026-09-30': [99.2, 80.57]})
    ok('④ 分類:連不上 / 被擋 / 回網頁 三種分開;content-type 標 html 但內容是 CSV → 照收(實跑踩到)', classify(0, '', '', OSError()).startswith('連不上')
       and classify(403, '', '').startswith('被擋') and '網頁' in classify(200, 'text/html', '<html>') and classify(200, 'text/csv', '日期') is None
       and classify(200, 'text/html;charset=MS950', '日期,賣權成交量,買權成交量\r\n2016/01/30,1,2') is None)
    ok('⑤ 月份清單含頭尾', _months('2025-11', date(2026, 2, 3)) == [(2025, 11), (2025, 12), (2026, 1), (2026, 2)])
    print('❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ TAIFEX_HIST_SELFTEST_PASS')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
