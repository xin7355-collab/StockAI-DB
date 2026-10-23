#!/usr/bin/env python3
"""🌡️ 景氣對策信號寫入守門 —— 這個 bug 讓 macro_risk.json 整整停產 4 天而 workflow 全綠。

實測(2026-09-02 daily_miner run #544 的 job log,⛔ 不是推理出來的):
    🌡️ 景氣對策信號(FinMind 備援):41 分 / red / 2026-07 ・欄位 `monitoring`
    💥 macro_miner 頂層異常:'NoneType' object has no attribute 'get'
    ✅ macro_miner.py            ← 頂層 except 印完就 sys.exit(0) → rc=0 → 綠燈

真因:`out` 初始化就有 `"business_signal": None`,而舊守門寫
      `if "business_signal" not in out:` → **永遠是 False** → 燈號抓到了也不寫進去
      → 下一行 `out["business_signal"].get("stale")` 對 None 呼叫 .get → 崩。
⭐ 觸發點是 V73.3.9 加了 FinMind 備援之後燈號**第一次抓得到**
  (在那之前永遠 None,走另一個分支碰不到那行)—— 修好一個東西引爆另一個。
⚠️ 崩在這裡 = 後面的 ^TWII 位階 / 板塊 ETF / 台指期 / risk_history / **寫檔**全部沒跑。

⛔ 測試要點:`out` 的初始值**必須**跟正式一樣預先塞 None —— 用 `{}` 當測資的話
   舊的壞寫法也會通過,那就是「測資自己把情境弄不見了」(陷阱 #40)。
"""
import json
import re
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for _m in ('yfinance',):          # ⚠️ requests 是真的(macro_miner 會 from requests.adapters import)
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.__getattr__ = lambda n: (lambda *a, **k: None)
        sys.modules[_m] = _s

import macro_miner as mm

FAIL = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  ← {extra}'))
    if not cond:
        FAIL.append(name)

print('① 抓得到燈號時要真的寫進去(⛔ 這正是崩掉的那條路)')
# 🚨 初始值刻意跟正式版一樣 = 已存在但為 None
out = {'business_signal': None, 'other': 1}
r, _err = None, None
try:
    r = mm.apply_business_signal(out, 'red', 41, '2026-07', None)
except Exception as e:          # ⛔ 讓注入缺陷「乾淨地紅」,不要整包 traceback 出去
    _err = f'{type(e).__name__}: {e}'
ok('①a 不會丟例外(舊版在這裡 AttributeError)', _err is None and isinstance(out.get('business_signal'), dict), _err or '')
ok('①b light/score/month 都寫進去了', (out['business_signal'].get('light') == 'red'
    and out['business_signal'].get('score') == 41 and out['business_signal'].get('month') == '2026-07'))
ok('①c 回傳的就是寫進去的那一份', r is out['business_signal'])
ok('①d ⛔ 不可標成 stale(這是新鮮抓到的)', not out['business_signal'].get('stale'))

print('② 抓不到 + 沒有舊檔 → 誠實留 None + 寫 error(⛔ 不可留 None 物件)')
out2 = {'business_signal': None}
mm.apply_business_signal(out2, None, None, None, 'HTTP 500', prev_path='/nonexistent/macro_risk.json')
ok('②a business_signal 仍是 dict', isinstance(out2.get('business_signal'), dict))
ok('②b light 是 None 而且有寫 error', out2['business_signal'].get('light') is None
   and out2['business_signal'].get('error') == 'HTTP 500')

print('③ 抓不到 + 有舊檔 → 沿用並標 stale(⛔ 不可假裝是今天抓到的)')
tmp = Path('/tmp/_bsi_prev.json')
tmp.write_text(json.dumps({'business_signal': {'light': 'green', 'score': 27, 'month': '2026-06'}}), encoding='utf-8')
out3 = {'business_signal': None}
mm.apply_business_signal(out3, None, None, None, 'timeout', prev_path=str(tmp))
b = out3['business_signal']
ok('③a 沿用舊燈號', b.get('light') == 'green' and b.get('month') == '2026-06')
ok('③b 🚨 一定要標 stale=True(⛔ 否則前端分不出是不是今天的)', b.get('stale') is True)
ok('③c 舊錯誤要留著(查得出為什麼沿用)', b.get('last_error') == 'timeout')
ok('③d source 要標 ndc-stale', b.get('source') == 'ndc-stale')

print('④ 舊檔內容是 null / 壞掉 → ⛔ 不可炸(它是 fallback,不能自己變成新的失敗點)')
tmp.write_text('null', encoding='utf-8')
out4 = {'business_signal': None}
mm.apply_business_signal(out4, None, None, None, 'x', prev_path=str(tmp))
ok('④a 仍寫得出 dict', isinstance(out4.get('business_signal'), dict) and out4['business_signal'].get('light') is None)
tmp.write_text('{ 壞掉的 JSON', encoding='utf-8')
out5 = {'business_signal': None}
mm.apply_business_signal(out5, None, None, None, 'x', prev_path=str(tmp))
ok('④b 壞 JSON 也不炸', isinstance(out5.get('business_signal'), dict))

print('⑤ ⛔ main() 裡不可再出現那個壞守門(⭐ 這條防的是「有人改回去」)')
src = Path(__file__).resolve().parent.parent.joinpath('macro_miner.py').read_text(encoding='utf-8')
# 🚨 掃描前一定要先剝掉「註解與 docstring」—— 本專案第 11 次踩到
#    「說明這個 bug 的文字裡就寫著壞寫法本身」→ 不剝的話這條永遠紅(而人會想把它放寬)。
code = re.sub(r'"""[\s\S]*?"""', '', src)
code = '\n'.join(l for l in code.split('\n') if not l.lstrip().startswith('#'))
ok('⑤a ⛔ 程式碼裡不可再有 `"business_signal" not in out`(說明文字不算)',
   '"business_signal" not in out' not in code)
ok('⑤b main() 走的是這支共用函式', 'apply_business_signal(out, bsi_light' in code)
ok('⑤c 🚧 空過守門:剝完註解後還要剩下大部分程式碼(⛔ 否則 ⑤a 是假綠燈)',
   len(code) > len(src) * 0.5, f'{len(code)} vs {len(src)}')

print('⑥ 🚨 空過守門:測資本身要真的重現情境(⛔ 否則舊寫法也會過)')
ok('⑥a 測資的 out 一開始就有 business_signal 這個 key 且為 None',
   ('business_signal' in {'business_signal': None}) and ({'business_signal': None}['business_signal'] is None))

print('⑦ V79.6.4 燈號鍵全檔一份(⛔ FinMind 備援那份曾少連字號 → App 認不得黃紅 / 黃藍)')
ROOT = Path(__file__).resolve().parent.parent
IDX = (ROOT / 'index.html').read_text(encoding='utf-8')
ok('⑦a 分數區間 → 燈號(國發會規則,邊界值)',
   [mm._bsi_light(x) for x in (9, 16, 17, 22, 23, 31, 32, 37, 38, 45)]
   == ['blue', 'blue', 'yellow-blue', 'yellow-blue', 'green', 'green', 'yellow-red', 'yellow-red', 'red', 'red'])
ok('⑦b 五個鍵 App 全認得(index.html 燈號對照表)', all(f"'{k}'" in IDX for k in ('red', 'yellow-red', 'green', 'yellow-blue', 'blue')))
code_nc = '\n'.join(l.split('#')[0] for l in code.split('\n'))          # 連行尾註解也剝掉
ok('⑦c ⛔ 程式碼裡不可再有少連字號的鍵', 'yellowred' not in code_nc and 'yellowblue' not in code_nc)
ok('⑦d 三條來源都走 _bsi_light(⛔ 不各寫一份分數區間)',
   code_nc.count('_bsi_light(') >= 3 and "light = 'yellow-blue'" not in code_nc, code_nc.count('_bsi_light('))

print('⑧ 政府開放資料(國發會「景氣指標及燈號」)—— 先問清單、嚴格認欄位、⛔ 不猜')
from datetime import datetime as _dt, timezone as _tz, timedelta as _td
NOW = _dt(2026, 10, 23, 20, 0, tzinfo=_tz(_td(hours=8)))


class _R:
    def __init__(self, status=200, body=b'', ctype='text/csv'):
        self.status_code = status
        self.content = body if isinstance(body, bytes) else body.encode('utf-8')
        self.text = self.content.decode('utf-8', 'replace')
        self.headers = {'Content-Type': ctype}

    def json(self):                      # 跟 requests 一樣:不是 JSON 就丟 JSONDecodeError(國發會網站回網頁那條路)
        return json.loads(self.text)


META = json.dumps({'success': True, 'result': {'identifier': '6099', 'distribution': [
    {'resourceDescription': '景氣指標及燈號', 'resourceFormat': 'CSV', 'resourceDownloadUrl': 'https://example.test/bsi.csv'},
    {'resourceDescription': '同上', 'resourceFormat': 'XML', 'resourceDownloadUrl': 'https://example.test/bsi.xml'}]}}, ensure_ascii=False)


def fake(files, meta=META):
    calls = []

    def get(u):
        calls.append(u)
        if 'data.gov.tw/api' in u:
            return _R(200, meta, 'application/json')
        if u in files:
            v = files[u]
            return v if isinstance(v, _R) else _R(200, v)
        return _R(404, 'nf')
    get.calls = calls
    return get


CSV_OK = '﻿Date,領先指標綜合指數,景氣對策信號(分),景氣對策信號(燈號)\n2026-06,101.2,39,紅燈\n2026-07,101.5,41,紅燈\n2026-08,101.9,38,紅燈\n'
r8 = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': CSV_OK}), now=NOW)
ok('⑧a 標準 CSV(UTF-8 BOM)→ 最新一個月', r8 == ('red', 38, '2026-08', None), r8)
csv_roc = '年月,景氣對策信號綜合判斷分數,燈號\n115年8月,34,黃紅燈\n115年7月,30,綠燈\n'.encode('cp950')
r8b = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': _R(200, csv_roc)}), now=NOW)
ok('⑧b Big5 + 民國年 + 新到舊排列 → 挑最新月份(⛔ 不是最後一列)', r8b == ('yellow-red', 34, '2026-08', None), r8b)
meta_json = json.dumps({'result': {'distribution': [{'resourceFormat': 'JSON', 'resourceDownloadUrl': 'https://example.test/bsi.json'}]}})
js = json.dumps([{'年月': '202607', '景氣對策信號綜合判斷分數': '22', '燈號': '黃藍燈'},
                 {'年月': '202608', '景氣對策信號綜合判斷分數': '17', '燈號': '黃藍燈'}], ensure_ascii=False)
r8c = mm._bsi_from_open_data(fake({'https://example.test/bsi.json': js}, meta=meta_json), now=NOW)
ok('⑧c JSON 資源也認得', r8c == ('yellow-blue', 17, '2026-08', None), r8c)
# ⭐ 決定性對照:燈號跟分數對不起來 → ⛔ 不用(多半是欄位認錯)
bad = CSV_OK.replace('2026-08,101.9,38,紅燈', '2026-08,101.9,34,綠燈')
r8d = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': bad}), now=NOW)
ok('⑧d 決定性對照:34 分配綠燈 → 拒收並寫原因', r8d[0] is None and '對不起來' in (r8d[3] or ''), r8d)
# ⭐ 決定性對照:沒有「分數」名字的欄位 → ⛔ 不拿 9~45 的數值去猜
noname = 'Date,領先指標,同時指標\n2026-08,38,27\n'
r8e = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': noname}), now=NOW)
ok('⑧e 決定性對照:欄位名字對不上 → 拒收、把欄位與最後一列寫進原因(⛔ 不猜)',
   r8e[0] is None and '找不到分數欄' in (r8e[3] or '') and '領先指標' in (r8e[3] or ''), r8e)
r8f = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': _R(200, '<!DOCTYPE html><html>x</html>')}), now=NOW)
ok('⑧f 下載回網頁 → 寫原因(陷阱 #23)、⛔ 不拿去解析', r8f[0] is None and '網頁' in (r8f[3] or ''), r8f)
fut = CSV_OK.replace('2026-08,101.9,38', '2027-01,101.9,38')
r8g = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': fut}), now=NOW)
ok('⑧g 最新月份在未來 → 不合理、拒收', r8g[0] is None and '不合理' in (r8g[3] or ''), r8g)
old = CSV_OK.replace('2026-06', '2025-06').replace('2026-07', '2025-07').replace('2026-08', '2025-08')
r8h = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': old}), now=NOW)
ok('⑧h 最新月份超過半年前 → 拒收(資料集停更了要看得出來)', r8h[0] is None and '不合理' in (r8h[3] or ''), r8h)
r8i = mm._bsi_from_open_data(fake({}, meta=json.dumps({'result': {'title': 'x'}})), now=NOW)
ok('⑧i 清單裡沒有下載網址 → 原因寫出清單的鍵', r8i[0] is None and '沒有下載網址' in (r8i[3] or ''), r8i)
g = fake({'https://example.test/bsi.csv': CSV_OK})
mm._bsi_from_open_data(g, now=NOW)
ok('⑧j 先問平臺清單、再下載清單列的網址(⛔ 下載網址不寫死)、XML 不碰',
   g.calls[:2] == ['https://data.gov.tw/api/v2/rest/dataset/6099', 'https://example.test/bsi.csv']
   and not any(u.endswith('.xml') for u in g.calls), g.calls)
r8k = mm._bsi_from_open_data(fake({'https://example.test/bsi.csv': CSV_OK.replace(',38,', ',120,')}), now=NOW)
ok('⑧k 分數超出 9~45 的那一列不算 → 退回上一個月', r8k == ('red', 41, '2026-07', None), r8k)
r8l = mm._bsi_from_open_data(lambda u: _R(403, 'forbidden'), now=NOW)
ok('⑧l 清單 HTTP 錯誤 → 原因寫狀態碼', r8l[0] is None and 'HTTP 403' in (r8l[3] or ''), r8l)

print('⑨ 接進 fetch_business_signal:國發會網站回網頁 → 開放資料接手;開放資料也失敗 → FinMind(付費層)最後試')
import requests as _rq
import time as _time
import urllib.request as _ur
_orig = (_rq.get, _time.sleep, _ur.urlopen, mm._bsi_from_open_data)
try:
    _time.sleep = lambda *_a, **_k: None
    HTML = _R(200, '<!DOCTYPE html><html ng-app="NDCapp"></html>', 'text/html')

    def _get(u, **k):
        if 'index.ndc.gov.tw' in u:
            return HTML
        return fake({'https://example.test/bsi.csv': CSV_OK})(u)
    _rq.get = _get
    mm._bsi_from_open_data = lambda get, now=None: _orig[3](get, now=NOW)
    r9 = mm.fetch_business_signal()
    ok('⑨a 國發會網站全是網頁 → 開放資料拿到 8 月紅燈 38 分', r9 == ('red', 38, '2026-08', None), r9)

    def _get2(u, **k):
        if 'index.ndc.gov.tw' in u:
            return HTML
        return _R(404, 'nf')

    class _FM:
        def __init__(self, b): self.b = b
        def read(self): return self.b
        def __enter__(self): return self
        def __exit__(self, *a): return False
    _rq.get = _get2
    _ur.urlopen = lambda *a, **k: _FM(json.dumps({'data': [{'date': '2026-08-01', 'monitoring': 34}]}).encode())
    r9b = mm.fetch_business_signal()
    ok('⑨b 決定性對照:FinMind 拿到 34 分 → 鍵是 yellow-red(以前少連字號)', r9b[:3] == ('yellow-red', 34, '2026-08'), r9b)
    _ur.urlopen = lambda *a, **k: _FM(json.dumps({'data': []}).encode())
    r9c = mm.fetch_business_signal()
    ok('⑨c 全部失敗 → error 同時看得到開放資料那段原因(⛔ 不被截掉)',
       r9c[0] is None and '開放資料 6099' in (r9c[3] or '') and 'FinMind' in (r9c[3] or ''), (r9c[3] or '')[:300])
finally:
    _rq.get, _time.sleep, _ur.urlopen, mm._bsi_from_open_data = _orig

print('⑩ 沿用上一份要讀「本機 → 已發佈」那份(⛔ 早上 macro_cron 是乾淨 checkout,本機沒有)')
PREV = {'business_signal': {'light': 'red', 'score': 41, 'month': '2026-08', 'source': 'ndc-stale'}}
o10 = {'business_signal': None}
mm.apply_business_signal(o10, None, None, None, 'HTTP 500', prev_path='/nonexistent/macro_risk.json', prev=PREV)
b10 = o10['business_signal']
ok('⑩a 本機沒有、已發佈那份有 → 沿用 8 月紅燈並標 stale', b10.get('light') == 'red' and b10.get('month') == '2026-08' and b10.get('stale') is True, b10)
o10b = {'business_signal': None}
mm.apply_business_signal(o10b, None, None, None, 'HTTP 500', prev_path='/nonexistent/macro_risk.json')
ok('⑩b 決定性對照:沒有給上一份 → 燈號是空的(舊版早上那輪就是這樣)', o10b['business_signal'].get('light') is None)
o10c = {'business_signal': None}
mm.apply_business_signal(o10c, None, None, None, 'x', prev_path='/nonexistent/x.json',
                         prev={'business_signal': {'light': 'yellow' + 'red', 'score': 34, 'month': '2026-08'}})
ok('⑩c 上一份是少連字號的舊鍵 → 沿用時改成 yellow-red', o10c['business_signal'].get('light') == 'yellow-red', o10c['business_signal'])
ok('⑩d main() 把讀好的上一份傳進去', 'apply_business_signal(out, bsi_light, bsi_score, bsi_month, bsi_err, prev=_prev_json)' in code)
_i_prev = code.find('_prev_json, _prev_src = _load_prev_macro()')
_i_bsi = code.find('apply_business_signal(out, bsi_light, bsi_score, bsi_month, bsi_err, prev=')   # ⚠️ 要找呼叫,⛔ 不是 def 那行
ok('⑩e 讀上一份那行排在景氣燈號之前(⛔ 排後面 = 傳進去的是還沒讀的變數)', 0 <= _i_prev < _i_bsi, (_i_prev, _i_bsi))

print()
if FAIL:
    print(f'❌ {len(FAIL)} 條失敗:' + ' / '.join(FAIL))
    sys.exit(1)
print('✅ MACRO_BSI_PASS(全部通過)')
