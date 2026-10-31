#!/usr/bin/env python3
"""🌐🧯 V80.0.2 K 線抓取兩件事的離線測試(不連網,http_session.get 全換成假的)。

① 全市場當日 K 線(STOCK_DAY_ALL / 上櫃每日收盤行情):
   日期要驗(⛔ 2026-05 融資錯位就是沒驗日期)、列數要過門檻、權證要濾掉、'--' 不可變成 0、
   開高低彼此矛盾不收;「只補今天那根」只在前 9 天都完整(休市日除外)時才走。
② 逐股逐月端點:被擋(HTTP 403/429、HTML 擋頁、JSON 壞、重試用完)回 None,
   真的沒資料回 [] —— 以前兩種都回 [],整批被擋時沒人知道。斷路器:連 5 次被擋冷卻、3 次停打。
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for _m in ('yfinance', 'pandas', 'requests'):
    if _m not in sys.modules:
        try:
            __import__(_m)
        except ImportError:
            sys.modules[_m] = types.ModuleType(_m)

import miner as M   # noqa: E402
import json as _j  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


def reset():
    for h in M._FETCH_HEALTH.values():
        h.update({'ok': 0, 'empty': 0, 'blocked': 0, 'skipped': 0, 'streak': 0,
                  'trips': 0, 'open_until': 0.0, 'dead': False, 'why': {}})
    M._OHLCV_Q.update({'bad_num': 0, 'fill_ohl': 0, 'no_vol': 0, 'examples': []})


M.time.sleep = lambda *_: None      # 測試不等


class Res:
    def __init__(self, status=200, text=''):
        self.status_code, self.text = status, text

    def json(self):
        import json
        return json.loads(self.text)


calls = []


def fake(responses):
    """responses:list,每次 get 依序取一個(Exception 實例 = 丟出去)。"""
    seq = list(responses)

    def _get(url, **kw):
        calls.append(url)
        r = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(r, Exception):
            raise r
        return r
    M.http_session.get = _get


# ── ① 日期解析 ──
ok('民國 7 碼', M._oapi_date('1151029') == '2026/10/29')
ok('民國斜線', M._oapi_date('115/10/29') == '2026/10/29')
ok('西元 8 碼', M._oapi_date('20261029') == '2026/10/29')
ok('西元橫線', M._oapi_date('2026-10-29') == '2026/10/29')
ok('不存在的日期 → None', M._oapi_date('1151332') is None)
ok('空白 / None → None', M._oapi_date('') is None and M._oapi_date(None) is None)

# ── ① 數字解析:'--' ⛔ 不可回 0 ──
reset()
ok("'--' → None", M._ohlcv_num('--') is None)
ok("空白 → None", M._ohlcv_num(' ') is None)
ok('千分位', M._ohlcv_num('1,234.5') == 1234.5 and M._ohlcv_num('12,345', int) == 12345)
ok('看不懂的字串 → None 並記數', M._ohlcv_num('abc') is None and M._OHLCV_Q['bad_num'] == 1
   and M._OHLCV_Q['examples'] == ['abc'])
ok('收盤沒有 → 不給 K 棒', M._ohlcv_bar('2026/10/29', 1, 1, 1, None, 5) is None)
b = M._ohlcv_bar('2026/10/29', None, 11, 9, 10, 5)
ok('開盤缺 → 用收盤補且記數', b and b['open'] == 10 and M._OHLCV_Q['fill_ohl'] == 1)
b = M._ohlcv_bar('2026/10/29', 10, 11, 9, 10, None)
ok('量缺 → 0 且記數', b and b['volume'] == 0 and M._OHLCV_Q['no_vol'] == 1)


# ── ① 全市場解析 ──
def twse_row(code, d='1151029', o='10', h='11', l='9', c='10.5', v='1,000'):
    return {'Code': code, 'Date': d, 'OpeningPrice': o, 'HighestPrice': h,
            'LowestPrice': l, 'ClosingPrice': c, 'TradeVolume': v}


M._DAILY_ALL_MIN['twse'] = 20
M._DAILY_ALL_MIN['tpex'] = 20
base = [twse_row(f'{1000 + i}') for i in range(30)]
known = {f'{1000 + i}' for i in range(30)} - {'1029'}
bars, info = M.parse_daily_all(base, 'twse', known, '2026/10/29')
ok('正常 → 收進來、權證/沒追的濾掉', info['kept'] == 29 and info['not_known'] == 1 and not info['reason'],
   str(info))
ok('K 棒格式跟 data/{sym}.json 一樣', bars['1000'] == {'date': '2026/10/29', 'open': 10.0, 'high': 11.0,
   'low': 9.0, 'close': 10.5, 'volume': 1000}, str(bars.get('1000')))
bars, info = M.parse_daily_all(base, 'twse', known, '2026/10/30')
ok('⛔ 資料日期 ≠ 要補的那天 → 整個市場不用', bars == {} and '≠' in info['reason'])
mixed = base[:20] + [twse_row(f'{2000 + i}', d='1151028') for i in range(10)]
bars, info = M.parse_daily_all(mixed, 'twse', None, None)
ok('⛔ 日期不一致(< 95% 同一天)→ 不用', bars == {} and '不一致' in info['reason'], str(info))
nodate = [dict(r, Date='') for r in base]
bars, info = M.parse_daily_all(nodate, 'twse', None, None)
ok('⛔ 沒有日期 → 不用(不可當成今天)', bars == {} and '日期' in info['reason'])
bars, info = M.parse_daily_all(base[:10], 'twse', None, None)
ok('⛔ 列數不到門檻(被截斷)→ 不用', bars == {} and '門檻' in info['reason'])
bars, info = M.parse_daily_all({'x': 1}, 'twse', None, None)
ok('⛔ 不是 list → 不用', bars == {} and info['reason'])
odd = base[:26] + [twse_row('9001', c='--', o='--', h='--', l='--'),
                   twse_row('9002', o='--'),
                   twse_row('9003', h='9.5'),          # 最高 < 收盤 → 矛盾
                   twse_row('9004', v='--')]
bars, info = M.parse_daily_all(odd, 'twse', None, None)
ok("沒成交('--')→ 不給、⛔ 不變成 0", '9001' not in bars and info['no_trade'] == 1)
ok('開盤缺 / 高低矛盾 / 沒量 → 不收(⛔ 不拿收盤補)', all(k not in bars for k in ('9002', '9003', '9004'))
   and info['bad'] == 3, str(info))
tp = [{'SecuritiesCompanyCode': f'{6000 + i}', 'Date': '1151029', 'Open': '50', 'High': '52',
       'Low': '49', 'Close': '51', 'TradingShares': '2,000'} for i in range(25)]
bars, info = M.parse_daily_all(tp, 'tpex', None, '2026/10/29')
ok('上櫃欄位名對得上', info['kept'] == 25 and bars['6000']['volume'] == 2000, str(info))

# TW_DAILY_ALL 的值 → 市場
ok("TW_DAILY_ALL:'1' = 兩個、'twse' 只上市、沒設 / 空字串 / '0' = 關",
   M.daily_all_markets('1') == ('twse', 'tpex') and M.daily_all_markets('twse') == ('twse',)
   and M.daily_all_markets('tpex,twse') == ('twse', 'tpex') and M.daily_all_markets(None) == ()
   and M.daily_all_markets('') == () and M.daily_all_markets('0') == ())
reset(); calls.clear()
fake([Res(200, _j.dumps(base))])
bars, infos = M.fetch_daily_all(None, '2026/10/29', markets=('twse',))
ok('只開上市 → ⛔ 不打上櫃', len(infos) == 1 and infos[0]['mkt'] == 'twse' and not any('tpex' in c for c in calls), str(calls))
# fetch_daily_all:單一市場 HTTP 403 不拖垮另一個
reset()
fake([Res(200, _j.dumps(base)), Res(403, 'Forbidden')])
bars, infos = M.fetch_daily_all(None, '2026/10/29')
ok('上櫃 403 → 上市照收、上櫃說明寫 HTTP 403', len(bars) == 30 and infos[1]['reason'] == 'HTTP 403',
   str(infos))
# 🔁 V80.1.1 重試:探針第 4 輪上櫃那份讀到一半斷線(ChunkedEncodingError)→ 以前一次就放棄
import requests as _rq  # noqa: E402
reset(); calls.clear()
fake([_rq.exceptions.ChunkedEncodingError('Connection broken'), Res(200, _j.dumps(base))])
bars, infos = M.fetch_daily_all(None, '2026/10/29', markets=('twse',))
ok('🔁 讀到一半斷線 → 再試一次就拿到(兩次請求、收 30 檔、記下試了 2 次)',
   len(calls) == 2 and len(bars) == 30 and infos[0].get('tries') == 2 and not infos[0].get('reason'),
   f'{calls} {infos}')
reset(); calls.clear()
fake([_rq.exceptions.ChunkedEncodingError('Connection broken')])
bars, infos = M.fetch_daily_all(None, '2026/10/29', markets=('twse',))
ok('🔁 一直斷 → 最多 3 次就放棄、說明寫原因與次數',
   len(calls) == 3 and not bars and 'ChunkedEncodingError' in infos[0]['reason'] and '3 次' in infos[0]['reason'],
   f'{calls} {infos}')
reset(); calls.clear()
fake([Res(403, 'Forbidden')])
bars, infos = M.fetch_daily_all(None, '2026/10/29', markets=('twse',))
ok('⛔ 403 不重試(被擋就是被擋)', len(calls) == 1 and infos[0]['reason'] == 'HTTP 403', f'{calls} {infos}')
reset(); calls.clear()
fake([Res(503, 'busy'), Res(200, _j.dumps(base))])
bars, infos = M.fetch_daily_all(None, '2026/10/29', markets=('twse',))
ok('🔁 503 → 重試後拿到', len(calls) == 2 and len(bars) == 30, f'{calls} {infos}')
reset(); calls.clear()
fake([Res(200, _j.dumps(base)[:500]), Res(200, _j.dumps(base))])
bars, infos = M.fetch_daily_all(None, '2026/10/29', markets=('twse',))
ok('🔁 JSON 只讀到一半 → 重試後拿到', len(calls) == 2 and len(bars) == 30, f'{calls} {infos}')

# ── ① 只補今天那根的條件 ──
full = {'close': 10, 'volume': 5}
days = [f'2026/10/{d}' for d in (16, 19, 20, 21, 22, 23, 26, 27, 28, 29)]
em = {d: dict(full) for d in days[:-1]}
ok('前 9 天完整 → 快速路徑', M.daily_all_fast_ok(em, days, '2026/10/29'))
ok('⛔ 那根不是最後一天 → 不走', not M.daily_all_fast_ok(em, days, '2026/10/28'))
em2 = dict(em); em2.pop('2026/10/23')
ok('⛔ 中間缺一天 → 走舊路徑(它會補)', not M.daily_all_fast_ok(em2, days, '2026/10/29'))
ok('缺的那天是休市 → 仍可快速', M.daily_all_fast_ok(em2, days, '2026/10/29', {'2026/10/23'}))
em3 = dict(em); em3['2026/10/27'] = {'close': None, 'volume': 5}
ok('⛔ 收盤空殼 → 走舊路徑', not M.daily_all_fast_ok(em3, days, '2026/10/29'))
cnt = {d: 1500 for d in days[:-1]}
cnt['2026/10/23'] = 3
ok('休市推斷:那天幾乎沒人有 K 棒', M.market_closed_days(cnt, days[:-1]) == {'2026/10/23'})
ok('樣本太少 → 不推斷', M.market_closed_days({d: 10 for d in days}, days) == set())
slots = {M.weekly_refresh_slot(f'{1000 + i}') for i in range(50)}
ok('每週輪替:落在週一~週五、每天都有人輪到', slots == {0, 1, 2, 3, 4})
ok('每週輪替:同一檔每次一樣', M.weekly_refresh_slot('2330') == M.weekly_refresh_slot('2330'))

# ── ② 逐股端點:被擋 vs 沒資料 ──
good = _j.dumps({'stat': 'OK', 'fields': ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價'],
                 'data': [['115/10/28', '1,000', '0', '10', '11', '9', '10.5'],
                          ['115/10/29', '--', '0', '--', '--', '--', '--']]})
reset()
fake([Res(200, good)])
r = M.twse_ohlcv('2330', '202610')
ok('上市正常 → 一根(沒成交那天不給)', r == [{'date': '2026/10/28', 'open': 10.0, 'high': 11.0, 'low': 9.0,
                                         'close': 10.5, 'volume': 1000}], str(r))
reset()
fake([Res(403, 'Forbidden')])
ok('上市 HTTP 403 → None(被擋)', M.twse_ohlcv('2330', '202610') is None
   and M._FETCH_HEALTH['twse']['why'] == {'HTTP403': 1})
reset()
fake([Res(200, '<html>請稍後再試</html>')])
ok('上市 HTML 擋頁 → None', M.twse_ohlcv('2330', '202610') is None)
reset()
fake([Res(200, '{"stat":"很抱歉，沒有符合條件的資料!"}')])
ok('上市「沒有符合條件」→ [](真的沒資料)', M.twse_ohlcv('6488', '202610') == []
   and M._FETCH_HEALTH['twse']['empty'] == 1)
reset()
fake([Res(200, '')])
ok('上市空字串(興櫃)→ []', M.twse_ohlcv('6999', '202610') == [])
reset()
fake([Res(200, '{"stat": broken')])
ok('上市 JSON 壞掉 → None', M.twse_ohlcv('2330', '202610') is None)
reset()
fake([Res(200, _j.dumps({'stat': 'OK', 'fields': ['X'], 'data': []}))])
ok('上市欄位變了 → None(格式變了要看得到)', M.twse_ohlcv('2330', '202610') is None)
reset()
fake([TimeoutError('t')])
ok('上市重試用完 → None', M.twse_ohlcv('2330', '202610') is None
   and M._FETCH_HEALTH['twse']['why'] == {'TimeoutError': 1})
reset()
fake([Res(403, 'Forbidden')])
ok('上櫃 HTTP 403 → None(V73.6.1 整站擋 runner)', M.tpex_ohlcv('6488', '202610') is None)
reset()
fake([Res(200, '<!DOCTYPE html><html></html>')])
ok('上櫃 HTTP 200 + HTML → None(V80.0.5 實測:runner 打真的上櫃股也回 HTML = 打不通)', M.tpex_ohlcv('6488', '202610') is None
   and M._FETCH_HEALTH['tpex']['why'] == {'HTML': 1})
reset()
fake([Res(200, '')])
ok('上櫃 HTTP 200 + 空白 → [](當月尚未公布)', M.tpex_ohlcv('6488', '202610') == [])
reset()
# 🏪 V80.1.1 上櫃換新站 tradingStock(成交是「張」→ ×1000;舊 st43 的 aaData 已失效,細節在 test_tpex_new.py)
fake([Res(200, _j.dumps({'stat': 'ok', 'tables': [{'fields': ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌', '筆數'],
                                                    'data': [['115/10/28', '2', '0', '50', '52', '49', '51', '0', '9']]}]}))])
ok('上櫃正常(新站 tradingStock,2 張 = 2,000 股)', M.tpex_ohlcv('6488', '202610') == [{'date': '2026/10/28', 'open': 50.0, 'high': 52.0,
                                                    'low': 49.0, 'close': 51.0, 'volume': 2000}])

# ── ② 斷路器 ──
reset()
fake([Res(429, 'Too Many')])
for _ in range(5):
    M.twse_ohlcv('2330', '202610')
h = M._FETCH_HEALTH['twse']
ok('連 5 次被擋 → 冷卻', h['trips'] == 1 and h['open_until'] > M.time.time())
calls.clear()
ok('冷卻中 → 直接 None、⛔ 不打主機', M.twse_ohlcv('2330', '202610') is None and calls == []
   and h['skipped'] == 1)
for _ in range(2):
    h['open_until'] = 0
    for _ in range(5):
        M.twse_ohlcv('2330', '202610')
ok('冷卻 3 次 → 這一輪停打', h['dead'] and h['trips'] == 3)
calls.clear()
M.twse_ohlcv('2330', '202610')
ok('停打後不再連線', calls == [])
ok('上櫃不受上市斷路影響', not M._FETCH_HEALTH['tpex']['dead'])
reset()
fake([Res(429, 'x'), Res(429, 'x'), Res(429, 'x'), Res(429, 'x'), Res(200, good)])
for _ in range(5):
    M.twse_ohlcv('2330', '202610')
ok('中間成功一次 → 連續次數歸零(不誤斷)', M._FETCH_HEALTH['twse']['trips'] == 0)
lines = M.fetch_health_summary()
ok('健康度摘要只有數量', lines and '被擋/壞掉 4' in lines[0] and '2330' not in ''.join(lines), str(lines))

# ── 主迴圈接線(靜態檢查)──
src = (Path(__file__).resolve().parent.parent / 'miner.py').read_text(encoding='utf-8')
ok('全市場預設關(TW_DAILY_ALL 沒設 = 不抓)', "_da_mk = daily_all_markets(os.environ.get('TW_DAILY_ALL'))" in src and 'if _da_mk:' in src)
ok('被擋的 None 不會被 extend', 'rows = rows or []' in src)
ok('快速路徑不叫 yfinance', 'if use_fast:\n                    pass' in src)
ok('健康度在 finally 印', '_report_fetch_health(_DA_STATS if _DA_BARS else None)' in src)

print(f"\n{'❌ ' + str(len(fails)) + ' 項失敗' if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
