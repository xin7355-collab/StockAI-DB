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

print()
if fails:
    print(f'❌ FINMIND_DIAG_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ FINMIND_DIAG_TEST_PASS')
