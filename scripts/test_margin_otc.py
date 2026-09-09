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

print('\n✅ MARGIN_OTC_PASS' if not fails else f'\n❌ MARGIN_OTC_FAIL {fails}')
sys.exit(1 if fails else 0)
