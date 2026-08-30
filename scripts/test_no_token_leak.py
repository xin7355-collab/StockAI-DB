#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔐 守門:⛔ 任何 token / 金鑰的**片段**都不可以印進 log。

【為什麼要有這條】
這個 repo 是 **public** → GitHub Actions 的 log 也是公開的。
2026-08-30 查「分點為什麼停產」時,從公開的 job log 裡讀到這樣的輸出:
    逐把探測:eyJ0eX…8yo4:status=400/... ; eyJ0eX…alpA:status=400/...
那是 `tok[:6] + '…' + tok[-4:]` 印出來的 —— **每把外流 10 個字元**
(`finmind_check.py` 更多,14 個)。

⭐ 診斷需要的只有「**第幾把** + 長度 + 錯誤訊息」,那些都不含金鑰內容。
   CLAUDE.md 早就寫著「🔐 只印『第幾把 key』,⛔ 絕不印 token」——
   ⛔ 但那條規則之前只存在文件裡,沒有守門,所以被違反了兩處都沒人發現。
   ⭐ 通用:**靠人記不住的規則,一定要有守門**(同 `check_no_trading_in_ci`)。

🚧 空過守門:掃描到的 .py 檔 < 20 支 → 視為 glob 壞掉,直接失敗。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# ⚠️ 第一版把 `key` 與 `raw` 也列進來 → 誤報 19 處(`raw` 是 K 線列的常用變數名、
#    `raw[:200]` 是截斷 AI 回應)。⭐ 工具報出來的數字,拿去做決策前要先驗工具本身。
#    → 只留「名字就是金鑰」的那幾個;`tokens[:3]` 這種**複數**不會被配到
#      (alternation 咬完 `token` 後下一個字元是 `s`,不是 `[`)。
PAT = re.compile(
    r'(?<![A-Za-z_])(tok|token|secret|api_key|apikey|sj_ca|person_id)'
    r'\s*\[\s*[-:]?\s*\d+\s*[:\]]',
    re.IGNORECASE)

fails = []
scanned = 0
for p in sorted(ROOT.glob('*.py')) + sorted(ROOT.glob('scripts/*.py')):
    if p.name == Path(__file__).name:
        continue
    scanned += 1
    for i, line in enumerate(p.read_text(encoding='utf-8').split('\n'), 1):
        st = line.strip()
        if st.startswith('#'):          # ⛔ 註解要排除 —— 說明這個 bug 的註解裡就寫著壞寫法本身
            continue                    #    (本專案第 9 次踩這個坑,見 CLAUDE.md)
        if PAT.search(line):
            fails.append(f'{p.relative_to(ROOT)}:{i}: {st[:110]}')

print(f'🔐 掃了 {scanned} 支 .py')
if scanned < 20:
    print('🚧 空過守門:掃到的檔案太少,glob 可能壞了')
    sys.exit(1)
for f in fails:
    print(f'❌ {f}')
print(f'\n{"❌ " + str(len(fails)) + " 處把金鑰片段印進 log" if fails else "✅ NO_TOKEN_LEAK_PASS"}')
sys.exit(1 if fails else 0)
