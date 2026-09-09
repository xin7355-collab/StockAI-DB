#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💳 V75.1.3 上櫃融資券備援(miner.fetch_market_margin)

🚨 背景:`data/5483.json` 的 margin_balance 自 2026-08-12 起全 0。真因不是 FinMind 壞掉,是**備援永遠不會被叫到**:
   FinMind 只在「TWSE+TPEx 全部失敗」或「融券全 0」才啟動 → TWSE 上市成功 + TPEx(對 runner 403)失敗
   = 上櫃 800 多檔無聲地歸零(陷阱 #22:守門把東西擋掉要說出來;這次連擋都沒擋,是「沒接上」)。

⛔ 這支要擋:① 改回舊門檻(FinMind 不會被叫 → 5483 拿不到)② FinMind 補上時**覆蓋**了 TWSE 已有的上市值
   ③ 來源計數 `_src` 沒寫進結果 ④ 上櫃太少的判準用「有沒有」而不是「夠不夠」(陷阱 #10)
做法:mock `miner.http_session.get` 與 `miner.fm_request`(⛔ 不打網路),TWSE 回 2330、TPEx 丟例外、FinMind 回 2330+5483。
"""
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import miner  # noqa: E402

fails = 0
def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:220]}")
    if not cond:
        fails += 1


class _Resp:
    def __init__(self, j=None, status=200, text=''):
        self._j = j; self.status_code = status; self.text = text or ('' if j is None else 'json')
        self.headers = {'content-type': 'application/json' if j is not None else 'text/html'}
    def json(self):
        if self._j is None:
            raise ValueError('not json')
        return self._j


def twse_json(n_rows=600):
    # ⚠️ 這是 **TWSE** 的欄名(rwd MI_MARGN 舊 schema)。
    #    🚨 V75.1.3 的錯就是拿這一組去測 TPEx —— TPEx 用的是簡寫「資餘額/券餘額」,
    #    測資跟程式一起錯 → 兩邊「對得上」→ 12 條全綠但真實資料完全對不上(陷阱 #40)。
    #    ⛔ 不可再把這組欄名用在 tpex 的 fixture 上;TPEx 的在下面 `tpex_json()`。
    fields = ['股票代號', '股票名稱', '融資買進', '融資賣出', '融資現金償還', '融資前日餘額', '融資今日餘額', '融資限額',
              '融券買進', '融券賣出', '融券現券償還', '融券前日餘額', '融券今日餘額', '融券限額', '資券互抵', '註記']
    data = []
    for i in range(n_rows):
        sid = str(1100 + i)
        data.append([sid, f'股{i}', '1', '1', '0', '100', str(1000 + i), '9999', '1', '1', '0', '10', str(50 + i), '999', '0', ''])
    data[0][0] = '2330'; data[0][6] = '77777'; data[0][12] = '888'
    return {'stat': 'OK', 'tables': [{'title': '個股', 'fields': fields, 'data': data}]}


calls = {'twse': 0, 'tpex': 0, 'fm': 0, 'fm_urls': []}
def fake_get(url, headers=None, timeout=15, **kw):
    if 'twse.com.tw' in url and 'MI_MARGN' in url:
        calls['twse'] += 1; return _Resp(twse_json())
    if 'twse.com.tw' in url:              # OpenAPI 那條:給空 list(不影響)
        return _Resp([], 200)
    if 'tpex.org.tw' in url:
        calls['tpex'] += 1; return _Resp(None, 403, '<html>403</html>')   # 對 runner 403(V73.6.1 實測)
    return _Resp(None, 404, '')

def fake_fm(url, timeout=20):
    calls['fm'] += 1; calls['fm_urls'].append(url)
    return {'msg': 'success', 'data': [
        {'stock_id': '2330', 'MarginPurchaseTodayBalance': 11, 'ShortSaleTodayBalance': 22},     # ⛔ 不可覆蓋 TWSE 的 77777
        {'stock_id': '5483', 'MarginPurchaseTodayBalance': 17332, 'ShortSaleTodayBalance': 120},
        {'stock_id': '6488', 'MarginPurchaseTodayBalance': 5000, 'ShortSaleTodayBalance': 10},
    ]}

_real_get, _real_fm, _real_sleep = miner.http_session.get, miner.fm_request, miner.time.sleep
miner.http_session.get = fake_get
miner.fm_request = fake_fm
miner.time.sleep = lambda *a, **k: None
miner._FINMIND_BLOCKED = False
try:
    res = miner.fetch_market_margin(date(2026, 9, 8))
finally:
    miner.http_session.get, miner.fm_request, miner.time.sleep = _real_get, _real_fm, _real_sleep

ok('① TWSE 上市正常(2330 = 77777 / 888)', res.get('2330', {}).get('margin_balance') == 77777 and res.get('2330', {}).get('short_balance') == 888, res.get('2330'))
ok('② TPEx 403 → FinMind 備援被叫到(⛔ 舊門檻下這裡是 0 次)', calls['fm'] >= 1, calls)
ok('③ 上櫃 5483 由 FinMind 補上(17332 / 120)', res.get('5483', {}).get('margin_balance') == 17332 and res.get('5483', {}).get('short_balance') == 120, res.get('5483'))
ok('③b 6488 也補上', res.get('6488', {}).get('margin_balance') == 5000, res.get('6488'))
ok('④ ⛔ FinMind 不可覆蓋 TWSE 已有的 2330(仍是 77777,不是 11)', res.get('2330', {}).get('margin_balance') == 77777, res.get('2330'))
src = getattr(miner.fetch_market_margin, 'last_src', None) or {}
ok('⑤ 來源計數 last_src(twse ≥ 500 / tpex 0 / finmind ≥ 2);⛔ 不可塞進 res 當股號', src.get('twse', 0) >= 500 and src.get('tpex', 0) == 0 and src.get('finmind', 0) >= 2 and '_src' not in res, src)
ok('⑤b last_src 標明觸發原因', bool(src.get('why')), src)
seg0 = (ROOT / 'miner.py').read_text(encoding='utf-8')
ok('⑤c 呼叫端把來源計數寫進 margin_cache[\'_src\'](⛔ 只印 log 會過期)', "margin_cache.setdefault('_src', {})[dd]" in seg0)

# ⑥ 判準是「上櫃**夠不夠**」不是「有沒有」:TPEx 只回 30 檔(殘缺)也要補
calls2 = {'fm': 0}
def fake_get2(url, headers=None, timeout=15, **kw):
    if 'tpex.org.tw' in url:
        rows = [[str(6000 + i)] + ['0'] * 5 + [str(100 + i)] + ['0'] * 6 + ['5'] + ['0'] * 3 for i in range(30)]
        return _Resp({'aaData': rows})
    return fake_get(url, headers, timeout, **kw)
def fake_fm2(url, timeout=20):
    calls2['fm'] += 1
    return {'msg': 'success', 'data': [{'stock_id': '6000', 'MarginPurchaseTodayBalance': 1, 'ShortSaleTodayBalance': 1},
                                       {'stock_id': '5483', 'MarginPurchaseTodayBalance': 17332, 'ShortSaleTodayBalance': 120}]}
miner.http_session.get, miner.fm_request, miner.time.sleep = fake_get2, fake_fm2, (lambda *a, **k: None)
miner._FINMIND_BLOCKED = False
try:
    res2 = miner.fetch_market_margin(date(2026, 9, 8))
finally:
    miner.http_session.get, miner.fm_request, miner.time.sleep = _real_get, _real_fm, _real_sleep
ok('⑥ TPEx 只回 30 檔(< 200)也要啟動 FinMind 補齊(陷阱 #10:看「夠不夠」不是「有沒有」)', calls2['fm'] >= 1 and res2.get('5483', {}).get('margin_balance') == 17332, (calls2, res2.get('5483')))
ok('⑥b TPEx 自己抓到的 6000 不被 FinMind 覆蓋(仍是 100)', res2.get('6000', {}).get('margin_balance') == 100, res2.get('6000'))

# ⑦ 靜態:log 要印 _FINMIND_BLOCKED 狀態(第二嫌疑:跑到融資段時 key 已被前面耗盡)
seg = (ROOT / 'miner.py').read_text(encoding='utf-8')
seg = seg[seg.index('def fetch_market_margin'):seg.index('def fetch_market_margin') + 16000]
ok('⑦ 備援段會把 _FINMIND_BLOCKED 狀態印進 log', '_FINMIND_BLOCKED=' in seg or "_FINMIND_BLOCKED}" in seg)
ok('⑦b 上櫃段有 TPEx 新站候選 + 失敗印 raw 前 200 字', 'www/zh-tw/margin' in seg and '[:200]' in seg)


# ══════════════════════════════════════════════════════════════════════════
# ⑧ V75.1.4:TPEx **真實**欄位(逐字抄自 scripts/otc_margin_probe.py 2026-09-08 的實測輸出)
#    ⛔ 別憑印象編 —— 這 16 個欄名就是探針印出來的原文(它只印到第 16 個,後面還有但用不到)。
# ══════════════════════════════════════════════════════════════════════════
TPEX_FIELDS = ['代號', '名稱', '前資餘額(張)', '資買', '資賣', '現償', '資餘額', '資屬證金',
               '資使用率(%)', '資限額', '前券餘額(張)', '券賣', '券買', '券償', '券餘額', '券屬證金']
#               0      1       2 ⛔前            3      4      5       6 ⭐融資   7
#               8              9        10 ⛔前          11     12     13 ⛔券償  14 ⭐融券  15

def tpex_json(n=920, fields=None, short_bal=None, prev_margin='99999', prev_short='88888'):
    """short_bal=None → 券餘額 ≈ 融資的 3%(合理);傳數字 → 全部用那個值(測守門)。"""
    fs = fields or TPEX_FIELDS
    data = []
    for i in range(n):
        mb = 17000 + i                      # 資餘額(index 6)
        sb = 4                              # 券償  (index 13) ← ⛔ 抓到這個就是錯的
        cb = short_bal if short_bal is not None else int(mb * 0.03)   # 券餘額(index 14)← ✅ 正解
        # 🚨 base 用 6000 而不是 5000:`str(5000+i)` 的 i=483 剛好也是 '5483',
        #    會把下面指定的第 0 列整個蓋掉(CLAUDE.md V73.8.7 記過的「測資檔號重疊」,又踩一次)。
        data.append([str(6000 + i), f'櫃{i}', prev_margin, '1', '1', '0', str(mb), '0',
                     '1.5', '999999', prev_short, '1', '1', str(sb), str(cb), '0'])
    data[0][0] = '5483'
    return {'stat': 'ok', 'tables': [{'title': '上櫃股票融資融券餘額', 'fields': fs, 'data': data}]}


def _run_with_tpex(payload, d=date(2026, 9, 8), is_latest=True):
    """TWSE 正常 + TPEx 回 payload,回 (res, 印出來的字)。"""
    import io, contextlib
    def _g(url, headers=None, timeout=15, **kw):
        if 'tpex.org.tw' in url:
            return _Resp(payload)
        return fake_get(url, headers, timeout, **kw)
    miner.http_session.get, miner.fm_request, miner.time.sleep = _g, fake_fm, (lambda *a, **k: None)
    miner._FINMIND_BLOCKED = False
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            r = miner.fetch_market_margin(d, is_latest=is_latest)
    finally:
        miner.http_session.get, miner.fm_request, miner.time.sleep = _real_get, _real_fm, _real_sleep
    return r, buf.getvalue()


res8, out8 = _run_with_tpex(tpex_json())
ok('⑧ 真實 TPEx 欄位:融資解到「資餘額」(17000,⛔ 不是前資餘額 99999)',
   res8.get('5483', {}).get('margin_balance') == 17000, res8.get('5483'))
ok('⑧b 🚨 融券要解到「券餘額」(510),⛔ 不是「券償」(4) 也不是「前券餘額」(88888)',
   res8.get('5483', {}).get('short_balance') == 510, res8.get('5483'))
ok('⑧c log 印出的欄位索引是 融資=6 融券=14(⛔ 不是 13)',
   '融資=6 融券=14' in out8, out8[-400:])
ok('⑧d 上櫃 920 檔都解得出來 → 不該再啟動 FinMind 補上櫃',
   (getattr(miner.fetch_market_margin, 'last_src', {}) or {}).get('tpex', 0) >= 900,
   getattr(miner.fetch_market_margin, 'last_src', {}))

# ⑧e 欄名變體(帶空白 / 全形括號 / 後面多字)仍要解對 —— 官方常在欄名塞空白(st41 就有)
VAR = ['代號', '名稱', '前資餘額（張）', '資買', '資賣', '現償', ' 資餘額 ', '資屬證金',
       '資使用率(%)', '資限額', '前券餘額（張）', '券賣', '券買', '券償', ' 券餘額 ', '券屬證金']
res8e, _ = _run_with_tpex(tpex_json(fields=VAR))
ok('⑧e 欄名帶空白/全形括號也要解對(⛔ 不可退回寫死索引就算了)',
   res8e.get('5483', {}).get('margin_balance') == 17000 and res8e.get('5483', {}).get('short_balance') == 510,
   res8e.get('5483'))

# ⑧f 🚧 合理性守門:券餘額全部小到像「券償」時要叫出來(欄位抓錯不會丟例外,只會給合法但錯的數字)
res8f, out8f = _run_with_tpex(tpex_json(short_bal=3))
ok('⑧f 融券/融資比值全部 ≤0.05% 要印 ::warning::(這是欄位抓錯唯一看得出來的訊號)',
   '::warning::' in out8f and '券償' in out8f, out8f[-300:])
ok('⑧g ⛔ 比值正常時不可亂叫(誤報會讓人養成忽略警告的習慣)',
   '::warning::' not in out8, out8[-300:])

# ⑧h 🚨 只有欄名**不是**精確的「資餘額/券餘額」時,`_col` 的第 ② 級(寬鬆)才會被走到。
#     ⛔ 上面 ⑧~⑧e 的欄名都被 ① 精確命中 → ② 那段等於沒被測到
#     (注入「拿掉排除『前』」時 6 條測試全綠 = 假綠燈,是注入驗證抓到的)。
#     這一組把欄名換成「資餘額(張)」讓 ① 落空,並且 fields 裡同時有「前資餘額(張)」→
#     沒排除「前」就會配到 index 2 / 10,拿到**昨天**的餘額而且完全不會報錯。
ZHANG = ['代號', '名稱', '前資餘額(張)', '資買', '資賣', '現償', '資餘額(張)', '資屬證金',
         '資使用率(%)', '資限額', '前券餘額(張)', '券賣', '券買', '券償', '券餘額(張)', '券屬證金']
res8h, out8h = _run_with_tpex(tpex_json(fields=ZHANG))
ok('⑧h 欄名「資餘額(張)」走寬鬆比對時,⛔ 不可配到「前資餘額(張)」(=昨天的餘額)',
   res8h.get('5483', {}).get('margin_balance') == 17000 and res8h.get('5483', {}).get('short_balance') == 510,
   res8h.get('5483'))
ok('⑧h2 log 仍是 融資=6 融券=14(⛔ 不是 2 / 10)', '融資=6 融券=14' in out8h, out8h[-300:])

# ⑨ V75.1.4:TWSE OpenAPI 沒有日期參數 → 非最新交易日不可採用
def _twse_rwd_dead(url, headers=None, timeout=15, **kw):
    if 'twse.com.tw' in url and 'MI_MARGN' in url and 'openapi' not in url:
        return _Resp({'stat': 'OK', 'tables': [{'title': '彙總', 'fields': ['代號', '名稱'], 'data': []}]})
    if 'openapi.twse.com.tw' in url:
        calls.setdefault('oapi', 0); calls['oapi'] += 1
        return _Resp([{'Code': '2330', 'MarginPurchaseTodayBalance': '27577', 'ShortSaleTodayBalance': '39'}])
    if 'tpex.org.tw' in url:
        return _Resp(tpex_json())
    return _Resp(None, 404, '')

for _lat, _exp, _lbl in [(True, 1, '最新交易日 → 要用'), (False, 0, '⛔ 非最新交易日 → 不可用')]:
    calls['oapi'] = 0
    miner.http_session.get, miner.fm_request, miner.time.sleep = _twse_rwd_dead, fake_fm, (lambda *a, **k: None)
    miner._FINMIND_BLOCKED = False
    try:
        miner.fetch_market_margin(date(2026, 9, 8), is_latest=_lat)
    finally:
        miner.http_session.get, miner.fm_request, miner.time.sleep = _real_get, _real_fm, _real_sleep
    ok(f'⑨ TWSE OpenAPI {_lbl}(那個端點永遠回最新一天,套進舊日期 = 假歷史)',
       calls['oapi'] == _exp, calls)

seg9 = (ROOT / 'miner.py').read_text(encoding='utf-8')
ok('⑨b 呼叫端有把 is_latest 傳進去(⛔ 只加參數不接等於沒修)',
   'is_latest=(d == trading_days[-1])' in seg9)
ok('⑨c ⛔ why 不可再無條件寫「TPEx 對 runner 403?」(探針實測三條端點全通,那是錯的歸因)',
   'TPEx 對 runner 403?)"' not in seg9.replace('# ', ''), '')

print('\n✅ MARGIN_OTC_PASS' if not fails else f'\n❌ MARGIN_OTC_FAIL {fails}')
sys.exit(1 if fails else 0)
