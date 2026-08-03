#!/usr/bin/env python3
"""📐 台指價差(順逆價差)兩條腿 + 端點自我診斷測試(V71.8.0)。

使用者回報:反攻雷達的「價差翻正」與「台指 VIX 退燒」兩條都顯示**沒有資料**。
查 gh-pages 的 `macro_risk.json` 發現兩個各自獨立的坑:

  ① `taifex_backwardation` 是 None,而 `taifex_backwardation_error` **也是 None**
     → 完全查不出原因。真因:V71.4.9 加的「期貨與現貨必須同一交易日」守門,
       只有 yfinance 那條腿會設 `_LAST_TX_FUT_DATE`,而 **OpenAPI 才是主要來源**
       → 主線根本沒被守到 → 差一天照算 → 算出離譜值 → 被下游「離譜值守門」
       默默設成 None **而且不留原因**。
  ② `tw_vix_error` 顯示所有候選端點都「HTTP 200 但不是 JSON」,連 swagger.json 也是
     → 期交所對未知路徑回的是**網頁**不是 404,所以只試 JSON 永遠問不出正確名稱。

這支釘住修法,免得日後又被「優化」掉。
"""
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.Ticker = lambda *a, **k: None
        sys.modules[_m] = _s

import macro_miner as M   # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


# ── ① OpenAPI 期貨行情:要同時吐出「收盤」與「資料日期」───────────────
ROWS = [
    {'Contract': 'TX', 'ContractMonth(Week)': '202608', 'Date': '20260731',
     'Last': '40,270', 'OpenInterest': '95000'},
    {'Contract': 'TX', 'ContractMonth(Week)': '202608W1', 'Date': '20260731',
     'Last': '40,260', 'OpenInterest': '120000'},          # 週契約:要被排除
    {'Contract': 'MTX', 'ContractMonth(Week)': '202608', 'Date': '20260731',
     'Last': '40,268', 'OpenInterest': '999999'},          # 小台:要被排除
]
M._taifex_openapi = lambda paths: (ROWS, None)
M._LAST_TX_FUT_DATE = None
close = M._taifex_openapi_tx_fut_close()
ok('① 取到 TX 近月收盤(排除週契約與小台)', close == 40270.0, str(close))
ok('① ⭐ OpenAPI 這條腿也要記下資料日期(V71.4.9 的守門才會生效)',
   M._LAST_TX_FUT_DATE == '2026-07-31', str(M._LAST_TX_FUT_DATE))

# ── ② 兩條腿同一天 → 算得出價差,而且兩條腿都要輸出 ─────────────────
def _mk_twii(tmp, date_str, close_v):
    p = Path(tmp) / '^TWII.json'
    p.write_text(f'[{{"date":"{date_str}","open":1,"high":1,"low":1,'
                 f'"close":{close_v},"volume":1}}]', encoding='utf-8')
    return p


import tempfile   # noqa: E402
tmp = tempfile.mkdtemp()
M.DATA_DIR = Path(tmp)
_mk_twii(tmp, '2026/07/31', 40039)
M._LAST_TX_FUT_DATE = None
M._LAST_BACK_LEGS = {}
back, err = M.fetch_taifex_backwardation()
ok('② 同一天 → 算得出價差', back == 231.0 and err is None, f'{back=} {err=}')
legs = M._LAST_BACK_LEGS
ok('② 期貨那條腿有輸出', legs.get('taifex_near') == 40270.0, str(legs))
ok('② 加權那條腿有輸出', legs.get('taiex_close') == 40039.0, str(legs))
ok('② 兩條腿的日期都有輸出(才查得出是不是差一天)',
   legs.get('taifex_fut_date') == '2026-07-31' and legs.get('taiex_date') == '2026-07-31',
   str(legs))

# ── ③ 兩條腿不同天 → 誠實回 None,而且**要有原因**、腿仍要留著 ────────
_mk_twii(tmp, '2026/07/30', 40039)
M._LAST_BACK_LEGS = {}
M._LAST_TX_FUT_DATE = None
back2, err2 = M.fetch_taifex_backwardation()
ok('③ 差一天不硬算', back2 is None, str(back2))
ok('③ ⭐ 要留下原因(不可 value=None 而 error 也 None)', bool(err2) and '不同交易日' in err2, str(err2))
ok('③ 差一天時兩條腿仍要留著(才看得出差在哪一天)',
   M._LAST_BACK_LEGS.get('taifex_fut_date') == '2026-07-31'
   and M._LAST_BACK_LEGS.get('taiex_date') == '2026-07-30', str(M._LAST_BACK_LEGS))

# ── ④ 端點自我診斷:期交所對未知路徑回「網頁」而不是 404 ───────────────
class _Resp:
    def __init__(self, text, code=200):
        self.text, self.status_code = text, code

    def json(self):
        raise ValueError('Expecting value: line 1 column 1 (char 0)')


HTML = ('<html><body><ul>'
        '<li><a href="/v1/DailyMarketReportFut">期貨每日交易行情</a></li>'
        '<li><a href="/v1/OptionsDailyMarketReport">選擇權每日交易行情</a></li>'
        '<li><a href="/v1/TaiwanIndexOptionsVolatilityIndex">臺指選擇權波動率指數</a></li>'
        '</ul></body></html>')
M.http = types.SimpleNamespace(get=lambda url, **k: _Resp(HTML))
names = M._taifex_list_endpoints('vol')
ok('④ ⭐ 回網頁時要從 HTML 撈出端點名(只試 JSON 永遠問不出來)',
   any('Volatility' in n for n in names), str(names))
ok('④ 關鍵字過濾有作用', all('vol' in n.lower() for n in names), str(names))
ok('④ 不含關鍵字時回全清單', len(M._taifex_list_endpoints('')) == 3,
   str(M._taifex_list_endpoints('')))

# ── ⑤ 找不到端點時,錯誤訊息要**把官方清單帶回 JSON**(不能只印 log)──────
M._taifex_openapi = lambda paths: (None, 'OpenAPI 全失敗 → X:非JSON')
rows, err5 = M._fetch_tw_vix_taifex()
ok('⑤ 值為 None', rows is None)
ok('⑤ ⭐ 錯誤字串要含官方端點清單(下一輪就能直接看到正確名稱)',
   '官方端點清單' in err5 and 'Volatility' in err5, str(err5)[:200])

# ── ⑥ 端點清單完全抓不到時,也要講清楚(不可靜默)────────────────────
M.http = types.SimpleNamespace(get=lambda url, **k: _Resp('', 404))
rows6, err6 = M._fetch_tw_vix_taifex()
ok('⑥ 抓不到清單時明說', '端點清單也抓不到' in err6, str(err6)[:160])
# ⭐ V71.8.1:抓不到時要把「每個網址各自回什麼」帶出去 —— 不然下一輪還是只知道「抓不到」,
#    分不出是連不到、被擋(403)、還是拿到網頁但格式不同(200 卻沒 match)。
ok('⑥ ⭐ 要附上各網址的實測結果(狀態碼+長度)', '各網址實測' in err6 and '404' in err6, str(err6)[:200])

print()
if fails:
    print(f'❌ BASIS_LEGS_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ BASIS_LEGS_TEST_PASS')
