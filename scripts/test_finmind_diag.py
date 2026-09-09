#!/usr/bin/env python3
"""FinMind 失敗訊息分類器(V71.6.2)測試。

為什麼需要:V71.5.7 補上「每一把 token 都試」之後,`tw_vix_error` 變成 400 字的原始堆疊,
真正的關鍵訊息夾在中間一眼看不出來 —— 於是很容易又被誤診成「資料集改名」而白改程式。
分類要能把**處置方式不同**的三件事分開:
  ・帳號等級不足 → 帳號問題,**改程式無效**
  ・金鑰無效/過期 → 換金鑰
  ・全部回空     → 才可能是資料集名稱或連線問題
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

C = M._classify_finmind_fail
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


# ── ① 2026-07-30 gh-pages 上的真實字串(混合:2 把無效 + 1 把免費層)──
REAL = [
    'tok1/TaiwanOptionVix:400/Token is illegal.',
    'tok1/TaiwanOptionVIX:400/Token is illegal.',
    'tok1/TaiwanVIX:400/Token is illegal.',
    'tok1/TaiwanFuturesVIX:400/Token is illegal.',
    'tok2/TaiwanOptionVix:400/Your level is register. Please update your user level. Detai',
    'tok2/TaiwanOptionVIX:None/',
    'tok2/TaiwanVIX:None/',
    'tok2/TaiwanFuturesVIX:None/',
    'tok3/TaiwanOptionVix:400/Token is illegal.',
]
r = C(REAL)
print(f'\n實際輸出:\n{r}\n')
ok('① 指出是「帳號等級不足」', '等級不足' in r, r[:80])
ok('① 指名是第 2 把', 'tok2 金鑰有效' in r, r[:80])
ok('① 同時指出 tok1/tok3 金鑰無效', '無效或已過期' in r and 'tok1/tok3' in r, r[:80])
ok('① 明講「改程式無效」(避免又白改一輪)', '改程式無效' in r)
ok('① 原文仍保留(要能回溯)', '原文:' in r)
ok('① 長度不超過 400(不要塞爆 JSON)', len(r) <= 400, f'len={len(r)}')
ok('① ⛔ 不含任何 token 值,只有「第幾把」',
   'Bearer' not in r and all(x in r for x in ('tok1', 'tok2')))

# ── ② 只有金鑰無效 → 不可誤報成等級問題 ────────────────────────
r2 = C(['tok1/TaiwanOptionVix:400/Token is illegal.'])
ok('② 不誤報等級不足', '等級不足' not in r2, r2[:80])
ok('② 正確報金鑰無效', '無效或已過期' in r2, r2[:80])

# ── ③ 只有等級不足 → 不可誤報成金鑰無效 ────────────────────────
r3 = C(['tok1/X:400/Your level is register. Please update your user level.'])
ok('③ 不誤報金鑰無效', '無效或已過期' not in r3, r3[:80])
ok('③ 正確報等級不足', '等級不足' in r3, r3[:80])

# ── ④ 全部回空(沒有明確 msg)→ 這時候才該懷疑資料集名稱 ────────
r4 = C(['tok1/X:None/', 'tok1/Y:None/'])
ok('④ 才提「可能改名或連線問題」', '都回空' in r4, r4[:80])
ok('④ 不亂扣帳號/金鑰的帽子', '等級不足' not in r4 and '無效或已過期' not in r4, r4[:80])

# ── ⑤ 邊界:空清單 / 怪格式不可 throw ──────────────────────────
for bad in ([], [''], ['沒有斜線'], ['tok1'], [None] if False else ['tok1/']):
    try:
        C(bad)
    except Exception as e:
        ok(f'⑤ {bad!r} 不 throw', False, f'{type(e).__name__}: {e}')
        break
else:
    ok('⑤ 空清單/怪格式都不 throw', True)

# ── ⑥ 大小寫變體也要認得(FinMind 訊息措辭改過就漏判很吃虧)──
ok('⑥ Illegal 大寫也認', '無效或已過期' in C(['tok9/X:400/TOKEN IS ILLEGAL']))
ok('⑥ user level 措辭也認', '等級不足' in C(['tok9/X:400/please update your user level']))

# ── ⑦ V71.7.0:台指 VIX 改「先免費(期交所)、後付費(FinMind)」──────────
#    使用者問「台指金鑰要付費嗎?」→ 走 FinMind 要付費層,但台指 VIX 本來就是
#    期交所公布的公開資料、不需金鑰。這裡守住優先序與解析,別日後被改回只走 FinMind。
import types as _t2

_calls = []


def _fake_openapi(paths):
    _calls.append(list(paths))
    return ([{'Date': '20260728', 'VIX': '19.80'},
             {'Date': '20260729', 'VIX': '21.35'},
             {'Date': '20260730', 'VIX': '20.66'}], None)


_orig_oa, _orig_ls = M._taifex_openapi, M._taifex_list_endpoints
M._taifex_openapi = _fake_openapi
rows, err = M._fetch_tw_vix_taifex()
ok('⑦ 期交所路徑解得出列', bool(rows) and len(rows) == 3, f'{rows=} {err=}')
ok('⑦ 民國/西元 8 碼日期轉得對', rows and rows[-1]['date'] == '2026-07-30', str(rows and rows[-1]))
ok('⑦ 由舊到新排序', rows and [r['date'] for r in rows] == sorted(r['date'] for r in rows))

# fetch_tw_vix 要優先用期交所,且**完全不碰 token**(免費源成功就不該再問 FinMind)
os.environ.pop('FINMIND_TOKENS', None)
os.environ.pop('FINMIND_TOKEN', None)
v, chg, e = M.fetch_tw_vix()
ok('⑦ ⭐ 沒有任何 token 也拿得到值(證明不必付費)', v == 20.66 and e is None, f'{v=} {chg=} {e=}')

# 欄名換成中文也要吃
M._taifex_openapi = lambda paths: ([{'日期': '2026/07/30', '波動率指數': '20.66'}], None)
rows2, _ = M._fetch_tw_vix_taifex()
ok('⑦ 中文欄名也吃', bool(rows2) and rows2[0]['vix'] == 20.66, str(rows2))

# 期交所掛掉 + 沒 token → 錯誤訊息要同時交代兩條路(不可讓使用者以為只能付費)
M._taifex_openapi = lambda paths: (None, 'HTTP404')
M._taifex_list_endpoints = lambda kw='': []
v3, _, e3 = M.fetch_tw_vix()
ok('⑦ 兩條都掛時值為 None', v3 is None)
ok('⑦ 錯誤訊息要提到免費源(不可只講 FinMind 付費)', '免費' in str(e3) or 'TAIFEX' in str(e3), str(e3)[:90])

M._taifex_openapi, M._taifex_list_endpoints = _orig_oa, _orig_ls

print()
if fails:
    print(f'❌ FINMIND_DIAG_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ FINMIND_DIAG_TEST_PASS (含台指 VIX 免費源優先)')
