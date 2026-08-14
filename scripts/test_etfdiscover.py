#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📦 主動式 ETF 自動發現(V73.4.0)測試 —— 不打網路,只驗邏輯與佈線。

🚨 背景:`CONC_WATCH` 原本**寫死 17 檔,一檔主動式 ETF 都沒有**,
   而 `data/` 裡實測就有 **30 檔**(00400A~00410A、00981A…)。
   使用者明確要過「ETF 新增成分股,還有比例」,那 30 檔卻一直是空的。

⛔ 這支要擋住四件事:
   ① regex 抓錯範圍(② ③)
   ② 靜默失敗 —— 第一版就漏了 `import os`,NameError 被 `except` 吞成「一檔都沒有」,
      **零錯誤訊息**(陷阱 #9)。→ ④ 釘住「失敗時一定要印原因」
   ③ 同一個檔案裡出現**兩套**「什麼算主動式 ETF」的定義(⑤)
   ④ 發現了卻沒接上採集迴圈(⑥,陷阱 #37)
"""
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

fails = []


def ok(n, c, e=''):
    print(f'{"✅" if c else "❌"} {n}{"" if c else "  " + str(e)[:200]}')
    if not c:
        fails.append(n)


# ⚠️⚠️ 靜態檢查要放在 `import etf_miner` **之前**。
#   🚨 第一版放在後面 → 我做反向驗證(故意加 `from bs4 import BeautifulSoup`)時,
#      測試在 **import 那一行就 crash**,一條斷言都沒跑到;而我當時用 `grep "^❌"`
#      看輸出 → **看不到 traceback**,於是誤以為「測試沒抓到」。
#   ⭐⭐ 兩個教訓:
#      ① 反向驗證要看 **exit code**,⛔ 不能只 grep 輸出(crash 不會印 ❌)
#      ② 「這個檔案不該依賴 X」這種檢查,本身**不可以依賴 import 它**
src = (ROOT / 'etf_miner.py').read_text(encoding='utf-8')
_imports = [l for l in src.split('\n')
            if re.match(r'\s*(import|from)\s', l) and not l.lstrip().startswith('#')]
ok('⑦ ⛔ 沒有真的 import BeautifulSoup / bs4',
   not any(('bs4' in l or 'BeautifulSoup' in l) for l in _imports),
   [l for l in _imports if 'bs4' in l or 'BeautifulSoup' in l])

import etf_miner


# ① 用假的 data 目錄驗:只收主動式,⛔ 不誤收其他 ETF / 個股
with tempfile.TemporaryDirectory() as td:
    d = Path(td)
    good = ['00400A', '00981A', '00410A']
    bad = ['0050', '00878', '00631L', '00625K', '2330', '00981', 'A00400', '00400AB']
    for s in good + bad:
        (d / f'{s}.json').write_text('[]', encoding='utf-8')
    import os
    os.environ['DATA_DIR'] = str(d)
    got = etf_miner._discover_active_etfs()
    ok('① 三檔主動式全部抓到', set(good) <= set(got), f'got={got}')
    ok('② ⛔ 不可誤收槓桿/反向/一般 ETF 與個股',
       not (set(bad) & set(got)), f'誤收={sorted(set(bad) & set(got))}')
    ok('③ 回傳要排序(log 好讀、diff 穩定)', got == sorted(got), f'got={got}')

# ④ ⛔ 失敗時一定要印原因(⛔ 不可靜默回 [])—— 這正是第一版 bug 躲過去的原因
fn = src[src.index('def _discover_active_etfs'):]
fn = fn[:fn.index('\ndef ', 10)] if '\ndef ' in fn[10:] else fn[:3000]
ok('④ ⛔ except 裡必須印出原因', 'print(' in fn.split('except')[-1], fn.split('except')[-1][:200])
ok('④b 註解要記錄「漏 import os 被吞掉」那個坑', '陷阱 #9' in fn, '')

# ⑤ ⛔ 同一個檔案裡不可有兩套「什麼算主動式 ETF」的定義
pats = set(re.findall(r'fullmatch\(r"?\'?(00\\d\{[^}]+\}A)', src))
ok('⑤ 主動式 ETF 的 regex 全檔一致', len(pats) <= 1, f'出現 {len(pats)} 種:{pats}')

# ⑥ ⭐ 陷阱 #37:發現了要真的接上採集迴圈
ok('⑥ 有被採集迴圈使用', '_discover_active_etfs()' in src and 'for cs in _watch:' in src, '')
ok('⑥b ⛔ 不可還留著舊的 `for cs in CONC_WATCH:`', 'for cs in CONC_WATCH:' not in src, '')
ok('⑥c 要印出「核心 N 檔 + 自動發現 M 檔」讓 log 查得到', 'ETF 成分股採集:核心' in src, '')

print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ ETFDISCOVER_PASS(全部通過)'))
sys.exit(1 if fails else 0)
