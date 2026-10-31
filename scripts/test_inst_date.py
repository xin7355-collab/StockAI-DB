#!/usr/bin/env python3
"""🗓️ V80.1.0 三大法人回應「是哪一天」要對得上(陷阱 #60 的法人版)—— 走正式入口 fetch_market_institutional,只換網路

釘住:
 ① _resp_dates 認得:YYYYMMDD / YYYY/MM/DD / 民國 NNN/MM/DD / 標題「NNN年MM月DD日」;看不出 → 空
 ② 上市 T86 日期 = 要的那天 → 收;⭐ 決定性對照:同一份回應只把日期改成前一天 → ⛔ 不收(而且 log 寫原因)
 ③ T86 沒有 date 欄、標題日期不對 → ⛔ 不收;完全看不出是哪一天 → 照收 + log「看不出」
 ④ 上櫃:V80.1.1 起預設嚴格(_OTC_INST_DATE_STRICT = True,探針量到三條候選都帶 date / tables[0].date)
    → 第一條日期不對不收、換下一條(日期對 → 收那一條);
    ④b 決定性對照:關掉嚴格 → 照收第一條 + log「只記錄」(V80.1.0 的行為)
 ⑤ FinMind 備援:別天的列 ⛔ 不收
跑法:python3 scripts/test_inst_date.py
"""
import contextlib, io, os, sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
import miner as M  # noqa: E402

FAIL = []


def ck(c, m, extra=''):
    print(('✅ ' if c else '❌ ') + m + ('' if c or not extra else f'  {str(extra)[:300]}'))
    if not c:
        FAIL.append(m)


D = date(2026, 10, 30)

# ① 解析
ck(M._resp_dates({'date': '20261030'}) == {D}, '①a YYYYMMDD')
ck(M._resp_dates({'tables': [{'date': '115/10/30'}]}) == {D}, '①b 民國 NNN/MM/DD(tables[].date)')
ck(M._resp_dates({'reportDate': '2026/10/30'}) == {D}, '①c YYYY/MM/DD(reportDate)')
ck(M._resp_dates({'title': '115年10月30日 三大法人買賣超日報'}) == {D}, '①d 標題「NNN年MM月DD日」')
ck(M._resp_dates({'stat': 'OK', 'data': []}) == set(), '①e 看不出 → 空集合')
ck(M._resp_date_check({'date': '20261029'}, D)[0] is False, '①f 日期不對 → 不通過')
ck(M._resp_date_check({'stat': 'OK'}, D) == (True, '沒帶日期'), '①g 看不出 → 照收、原因寫「沒帶日期」')

T86_FIELDS = ['證券代號', '證券名稱', '外陸資買進股數(不含外資自營商)', '外陸資賣出股數(不含外資自營商)',
              '外陸資買賣超股數(不含外資自營商)', '外資自營商買進股數', '外資自營商賣出股數', '外資自營商買賣超股數',
              '投信買進股數', '投信賣出股數', '投信買賣超股數', '自營商買賣超股數', '自營商買進股數(自行買賣)',
              '自營商賣出股數(自行買賣)', '自營商買賣超股數(自行買賣)', '自營商買進股數(避險)', '自營商賣出股數(避險)',
              '自營商買賣超股數(避險)', '三大法人買賣超股數']
T86_DATA = [[f'{1100 + i}', f'上市{i}', '0', '0', f'{1000 + i}', '0', '0', '0', '0', '0', '7', '-3', '0', '0', '0', '0', '0', '0', '0'] for i in range(120)]
OTC_FIELDS = ['代號', '名稱', '外資及陸資(不含外資自營商)-買進股數', '外資及陸資(不含外資自營商)-賣出股數',
              '外資及陸資(不含外資自營商)-買賣超股數', '投信-買進股數', '投信-賣出股數', '投信-買賣超股數',
              '自營商-買賣超股數']
OTC_DATA = [[f'{6100 + i}', f'上櫃{i}', '0', '0', f'{2000 + i}', '0', '0', '5', '-1'] for i in range(120)]


class R:
    def __init__(self, j, code=200):
        self._j, self.status_code, self.text = j, code, ''

    def json(self):
        return self._j


def run(t86=None, otc=None, fm=None, strict=None):
    """t86 / otc = dict 或 (url 片段 → dict)的 list;回 (res, log)"""
    otc = otc or []

    def get(url, **kw):
        if 'twse.com.tw' in url:
            return R(t86 if t86 is not None else {'stat': '很抱歉,沒有符合條件的資料!'})
        for frag, j in otc:
            if frag in url:
                return R(j)
        return R({}, 404)

    old = (M.http_session.get, M.time.sleep, M.fm_request, M._FINMIND_BLOCKED, M._OTC_INST_DATE_STRICT)
    M.http_session.get = get
    M.time.sleep = lambda *a, **k: None
    M.fm_request = lambda *a, **k: fm
    M._FINMIND_BLOCKED = fm is None
    if strict is not None:
        M._OTC_INST_DATE_STRICT = strict
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            res = M.fetch_market_institutional(D)
    finally:
        M.http_session.get, M.time.sleep, M.fm_request, M._FINMIND_BLOCKED, M._OTC_INST_DATE_STRICT = old
    return res, buf.getvalue()


ok_t86 = {'stat': 'OK', 'date': '20261030', 'title': '115年10月30日 三大法人買賣超日報', 'fields': T86_FIELDS, 'data': T86_DATA}
res, log = run(t86=ok_t86)
ck(res.get('1100', {}).get('foreign_net') == 1000 and res.get('1100', {}).get('trust_net') == 7, '② 上市 T86 日期對 → 收(1100 外資 +1000、投信 +7)', res.get('1100'))
bad_t86 = dict(ok_t86, date='20261029', title='115年10月29日 三大法人買賣超日報')
res2, log2 = run(t86=bad_t86)
ck('1100' not in res2 and '不收' in log2, '②b ⭐ 決定性對照:同一份回應日期改成前一天 → ⛔ 不收,log 寫原因', log2[-200:])
res3, log3 = run(t86={k: v for k, v in ok_t86.items() if k != 'date'} | {'title': '115年10月29日 三大法人買賣超日報'})
ck('1100' not in res3, '③ 沒有 date 欄、標題日期不對 → ⛔ 不收')
res4, log4 = run(t86={k: v for k, v in ok_t86.items() if k not in ('date', 'title')})
ck('1100' in res4 and '看不出' in log4, '③b 完全看不出是哪一天 → 照收 + log「看不出」', log4[-200:])

otc_bad = {'tables': [{'date': '115/10/29', 'fields': OTC_FIELDS, 'data': OTC_DATA}]}
otc_ok = {'tables': [{'date': '115/10/30', 'fields': OTC_FIELDS, 'data': [[r[0], r[1], r[2], r[3], str(int(r[4]) + 1)] + r[5:] for r in OTC_DATA]}]}
ck(M._OTC_INST_DATE_STRICT is True, '④ 預設嚴格(V80.1.1 探針量到上櫃回應帶日期之後打開)')
res5, log5 = run(t86=ok_t86, otc=[('/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=2026/10/30', otc_bad),
                                  ('/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=115/10/30', otc_ok)])
ck(res5.get('6100', {}).get('foreign_net') == 2001 and '只記錄' not in log5,
   '④ 預設:第一條日期不對 ⛔ 不收、換第二條(日期對 → 收 6100 外資 +2001)', (res5.get('6100'), log5[-240:]))
res5b, log5b = run(t86=ok_t86, otc=[('/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=2026/10/30', otc_bad)])
ck('6100' not in res5b and '115/10/29' not in str(res5b) and '2026-10-29' in log5b,
   '④ 唯一一條日期不對 → 上櫃一檔都不收,原因寫進 log(⛔ 不可把 10/29 蓋成 10/30)', log5b[-240:])
res6, log6 = run(t86=ok_t86, otc=[('/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=2026/10/30', otc_bad),
                                  ('/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=115/10/30', otc_ok)], strict=False)
ck(res6.get('6100', {}).get('foreign_net') == 2000 and '只記錄' in log6,
   '④b ⭐ 決定性對照:關掉嚴格 → 照收第一條(10/29 的數字)+ log「只記錄」', (res6.get('6100'), log6[-240:]))

fm = {'data': [{'stock_id': '6200', 'date': '2026-10-30', 'name': 'Foreign_Investor', 'buy': 500, 'sell': 100},
               {'stock_id': '6201', 'date': '2026-10-29', 'name': 'Foreign_Investor', 'buy': 900, 'sell': 100}]}
res7, log7 = run(t86=ok_t86, fm=fm)
ck(res7.get('6200', {}).get('foreign_net') == 400 and '6201' not in res7, '⑤ FinMind 備援:別天的列 ⛔ 不收', (res7.get('6200'), res7.get('6201')))

print(f"\n{'❌ ' + str(len(FAIL)) + ' 條失敗' if FAIL else '✅ 全過'}")
sys.exit(1 if FAIL else 0)
