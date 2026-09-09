#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🚨 同一個檔案裡**重複定義**同名函式/類別的守門(V74.6.9)

⭐ 為什麼要有這一支(實跑踩到才寫的):
   `intraday_probe.py` 曾同時存在**兩份** `main()`/`selftest()`(新版在前、舊版在後)——
   Python 用**最後**那個定義 → **實際跑的是舊版**,而我一直以為在跑新版。
   症狀是舊版的守門用錯單位(`len(dict)` 當成筆數)→ 一律報「對照組只有 3 筆」而停掉,
   看起來像「資料不夠」,其實是**跑到舊碼**。
   ⛔ 這件事**不會報任何錯**,只會安靜地讓舊版生效 —— 跟陷阱 #9(進入點順序)同一族。

⛔ 只掃**模組層級**(縮排 0)的 `def` / `class`:
   類別方法、巢狀函式、`if/else` 兩個分支各定義一次都是合法寫法,⛔ 不可誤報。
"""
import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP = {'.git', 'node_modules', '__pycache__', 'data'}

bad = []
n_file = 0
for p in sorted(ROOT.glob('*.py')) + sorted(ROOT.glob('scripts/*.py')):
    if any(x in p.parts for x in SKIP):
        continue
    try:
        tree = ast.parse(p.read_text(encoding='utf-8'))
    except Exception:
        continue
    n_file += 1
    seen = {}
    for node in tree.body:                      # ⛔ 只看模組層級,不遞迴
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name in seen:
                bad.append((p.relative_to(ROOT), node.name, seen[node.name], node.lineno))
            seen[node.name] = node.lineno

if bad:
    print('🚨 同一個檔案裡有重複定義(Python 會用**最後**那個,前面那份等於死碼):')
    for f, name, l1, l2 in bad:
        print(f'   ❌ {f}  `{name}`  第 {l1} 行 與 第 {l2} 行')
    print('   ⛔ 這不會報錯,只會安靜地讓其中一份生效 —— 刪掉舊的那一份,或改名。')
    sys.exit(1)

print(f'✅ 沒有模組層級的重複定義(掃 {n_file} 支 Python)')
