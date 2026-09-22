#!/usr/bin/env python3
"""🏪 櫃買指數長歷史「沿用舊檔」要不要說出原因(V77.4.5)。

為什麼需要這支:
  實測 gh-pages 的 `macro_cache.json` 裡 `twoii_history` **只有 1 筆、日期 2024/10/12**
  (兩年前),`^TWOII.json` 只有 88 bytes,而檔案裡**一個字都沒說**:
  沒有 `twoii` 這個 flat key、也沒有 `twoii_error`
  → 前端只顯「採集中」、`data_audit` 的 C 類完全掃不到,
  最後是靠人去翻 Actions log 才看到真相(三個來源各壞一種 + 磁碟 fallback 自我延續)。

⭐ 這支釘的是「**任何把值設成 None / 缺的守門,都必須同時寫 `*_error`**」(陷阱 #22),
   而且**訊息要寫得讓 `data_audit` 真的報得出來** —— 那是跨檔的約定,所以這裡直接
   讀 `scripts/data_audit.py` 的「有交代的降級」白名單來比對(⛔ 不在這裡抄第二份)。
"""
import os
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance', 'shioaji'):
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.Ticker = lambda *a, **k: None
        sys.modules[_m] = _s

import miner as M   # noqa: E402

fails = []


def ok(name, cond, got=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  → 實際:{got}'))
    if not cond:
        fails.append(name)


SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
#   🚨 靜態斷言前先剝掉 `#` 註解與三引號 docstring —— 本檔的說明文字裡就引用了
#   要禁止的舊寫法,不剝的話會被自己的註解救活/害死(本 repo 已犯 7 次)。
_NOCMT = re.sub(r'"""[\s\S]*?"""', '', re.sub(r'(?m)#.*$', '', SRC))

print('🏪 _hist_stale_error —— 什麼時候該說話')
ok('① 官方有給值、長歷史也夠 → 不報(⛔ 不可製造噪音)',
   M._hist_stale_error('twii', [1] * 58, [{'date': '2026/09/21'}] * 1215) is None)
_MSG = M._hist_stale_error('twoii', [], [{'date': '2024/10/12'}])
ok('② ⭐ 實測情境(三條來源全空、磁碟只剩 1 筆)→ 必須報', bool(_MSG))
ok('②b 訊息要帶**判斷用的原始數字**:幾筆 + 最新哪一天',
   '1 筆' in (_MSG or '') and '2024/10/12' in (_MSG or ''), _MSG)
_MSG2 = M._hist_stale_error('twoii', [1, 2], [{'date': '2024/10/12'}])
ok('③ 兩種原因要講得不一樣(來源 0 筆 vs 歷史檔被截斷)—— 下一步完全不同',
   bool(_MSG2) and _MSG2 != _MSG and '截斷' in _MSG2, _MSG2)
ok('④ long_rows 完全空也要報', bool(M._hist_stale_error('twoii', [], [])))

print('🏪 訊息要讓 data_audit 的 C 類真的報得出來(跨檔約定)')
_DA = (ROOT / 'scripts' / 'data_audit.py').read_text(encoding='utf-8')
_m = re.search(r"_intentional = \(([^)]*)\)", _DA, re.S)
ok('⑤ 讀得到 data_audit 的「有交代的降級」白名單(⛔ 不在這裡抄第二份)', bool(_m))
_WL = re.findall(r"'([^']+)'", _m.group(1)) if _m else []
_hit = [w for w in _WL if w in (_MSG or '')]
ok('⑥ ⭐ 訊息⛔ 不可含那些詞 —— 含了就會被當成「刻意的降級」而不報 ❌'
   '(而指數收盤是當日快照,用兩年前的值是錯的,陷阱 #34)',
   not _hit, f'白名單={_WL} ・命中={_hit}')

print('🏪 呼叫點:寫歷史的下一步就要寫原因')
ok('⑦ `result[hist_key] = …` 之後緊接著寫 `{key}_error`',
   re.search(r"result\[hist_key\]\s*=[^\n]*\n(?:\s*#[^\n]*\n)*\s*_stale = _hist_stale_error\(", SRC)
   is not None,
   [l.strip() for l in SRC.split('\n') if 'result[hist_key]' in l or '_hist_stale_error(' in l])
ok('⑦b 沒事的時候要把舊的 error 清掉(⛔ 不可讓昨天的錯誤訊息黏著)',
   "result.pop(f'{key}_error', None)" in _NOCMT)

print('🏪 TPEx 失敗訊息裡的網址⛔ 不可被截掉日期參數')
_tag = re.search(r"tag = url\.split\('tpex\.org\.tw'\)\[-1\]\[:(\d+)\]", _NOCMT)
ok('⑧ 截斷長度 ≥ 90(42 字會把 `?date=2026/07/01` 切成 `?date=2026`,'
   '於是「200 但 totalCount=0」分不出是參數錯還是真的沒資料)',
   bool(_tag) and int(_tag.group(1)) >= 90, _tag.group(0) if _tag else '找不到那一行')

print('🏪 data_audit 的 D3 要照 D2 的既有原則(有 error → ⚠️、沒 error → ❌)')
ok('⑨ D3 會先看 `{x}_error` 再決定是 ❌ 還是 ⚠️',
   "_why = mc.get(f'{x}_error')" in _DA and re.search(r"if _why:\s*\n\s*add\('⚠️', 'D3'", _DA) is not None,
   [l.strip() for l in _DA.split('\n') if "'D3'" in l])

print()
if fails:
    print(f'❌ OTC_HIST_TEST_FAIL: {len(fails)} 條 → {fails}')
    sys.exit(1)
print('✅ OTC_HIST_TEST_PASS')
