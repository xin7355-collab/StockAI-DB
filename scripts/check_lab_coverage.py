#!/usr/bin/env python3
"""🔍 巡邏:CLAUDE.md 探針登記表 vs `pro.html` 的實測總表(PRO.LAB)有沒有漏收錄

⭐ CLAUDE.md 鐵則:「爾後每一次回測/探針,結論都要同步記進 PRO.LAB」——
   但那條規則本身很容易只活在文件裡(陷阱 #37),所以把巡邏自動化。

⛔ 它是**巡邏工具不是測試**:exit 0、⛔ 不進四驗證
   —— 誤報擋 push 會讓人養成無視它的習慣(同 page_sweep / card_inventory 的定調)。

⚠️ 比對方式刻意用「**探針名字的字首**」而不是完整檔名:
   LAB 有些條目一次涵蓋多支,來源欄寫成 `volstall/volseq/turnover/arbr/turnover_stage`
   —— 那是**合法的**收錄方式,⛔ 不可因為沒寫 `.py` 就報成漏收。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cm = (ROOT / 'CLAUDE.md').read_text(encoding='utf-8')
pro = (ROOT / 'pro.html').read_text(encoding='utf-8')

probes = {p.split('/')[-1] for p in
          re.findall(r'`((?:scripts/)?\w+_probe\.(?:py|mjs))`', cm)}
srcs = ' '.join(re.findall(r"s:\s*'([^']+)'", pro) + re.findall(r's:\s*"([^"]+)"', pro))

miss = sorted(p for p in probes if p.split('_probe')[0] not in srcs)
print(f'📋 CLAUDE.md 探針登記表:{len(probes)} 支')
print(f'🔬 PRO.LAB 來源欄字數:{len(srcs)}')
if miss:
    print(f'\n⚠️ 登記表有、但 LAB 來源欄找不到的 {len(miss)} 支(要人工確認是不是真的漏收):')
    for m in miss:
        print(f'   - {m}')
    print('\n⭐ 處置:去 docs/DECISIONS.md 找那支的實測數字,補一條 LAB 條目')
    print('   (⛔ 沒有數字的意見不准進來 —— test_prohtml ㉔d 會擋)。')
else:
    print('\n✅ 沒有漏收錄的探針')
sys.exit(0)   # ⛔ 巡邏工具:一律 exit 0
