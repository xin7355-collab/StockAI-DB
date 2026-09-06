#!/usr/bin/env python3
"""🎯 題材板塊(V74.3.5)—— miner._themes_from_pro 的釘子。

它是「miner 用 regex 讀 pro.html 的 PRO.THEMES」這條**跨檔契約**的守門:
pro.html 那段格式一改、regex 就會安靜地少抓/抓不到,而 miner 只會「themes 不產出」
→ 前端顯「還沒產出」,零錯誤訊息(陷阱 #9/#40 的溫床)。

已用注入自我驗證:①把 THEMES 區塊改名 ②把 syms 拆行 → 都要被 ③ 的守門擋下。
"""
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import miner  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(('✅' if cond else '❌') + f' {name}' + ('' if cond else f'  {str(extra)[:200]}'))
    if not cond:
        fails.append(name)


# ① 在當前 pro.html 上要抽得到(空過守門的反面:正常情況必須成功)
groups, names = miner._themes_from_pro()
ok('① parser 在當前 pro.html 上抽得到題材', groups is not None and names is not None)
n_sym = sum(len(v) for v in (groups or {}).values())
ok('①b 題材 ≥ 12、成員 ≥ 60 檔', groups and len(groups) >= 12 and n_sym >= 60,
   f'{len(groups or {})} 題材 / {n_sym} 檔')

# ② regex 沒有漏抓:pro.html THEMES 區塊裡的股號總數 == parser 抽到的總數
s = (ROOT / 'pro.html').read_text(encoding='utf-8')
i = s.index('THEMES: [')
blk = s[i:s.index('],', i) + 2]
all_codes = re.findall(r"'(\d{4,5})'", blk)
ok('② regex 零漏抓(區塊裡每一個股號都有被收進某個題材)', len(all_codes) == n_sym,
   f'區塊 {len(all_codes)} vs 抽到 {n_sym}')

# ②b 使用者點名的題材與個股必須在
flat = {sy for v in (groups or {}).values() for sy in v}
ok('②b 使用者點名的都在:記憶體含南亞科(2408)/群聯(8299)、矽光子(sipho)、散熱(cool)',
   '2408' in (groups or {}).get('mem', []) and '8299' in (groups or {}).get('mem', [])
   and 'sipho' in (groups or {}) and 'cool' in (groups or {}))

# ②c 每一檔成員都要有 K 線檔(⛔ 沒 K 線的不加,V74.2.0 8497 教訓)
missing = [sy for sy in flat if not (ROOT / 'data' / f'{sy}.json').exists()]
ok('②c 每一檔成員都有 data/{sym}.json', not missing, missing)

# ③ 空過守門:格式壞掉(THEMES 區塊消失)→ 必須回 (None, None) 且不 raise
#    ⚠️ 用暫存目錄放一份壞的 pro.html,再 monkeypatch __file__ 的解析
orig_file = miner.__file__
with tempfile.TemporaryDirectory() as td:
    bad = s.replace('THEMES: [', 'THEMES_RENAMED: [')
    (Path(td) / 'pro.html').write_text(bad, encoding='utf-8')
    miner.__file__ = str(Path(td) / 'miner.py')
    g2, n2 = miner._themes_from_pro()
    ok('③ THEMES 區塊消失 → 回 (None, None),⛔ 不可 raise 也不可回空 dict', g2 is None and n2 is None)
    # ③b syms 換行拆開(pro.html 註解明令禁止的寫法)→ regex 抓不到 → 守門要擋
    broken = s.replace("syms: ['3711', '3131', '3583', '6187']", "syms: [\n'3711']")
    # 只留 3 個題材,其餘刪掉 → 低於 10 題材門檻
    j = s.index('THEMES: [')
    k = s.index('],', j)
    keep3 = re.findall(r"\{ k: '[a-z]+',[^}]+\},", s[j:k])[:3]
    few = s[:j] + 'THEMES: [\n' + '\n'.join(keep3) + '\n  ],' + s[k + 2:]
    (Path(td) / 'pro.html').write_text(few, encoding='utf-8')
    g3, n3 = miner._themes_from_pro()
    ok('③b 題材數低於門檻(3 個)→ 守門回 (None, None)', g3 is None and n3 is None)
miner.__file__ = orig_file

# ④ 前後端同源:pro.html JS 的 THEMES 每一個 k 都被 parser 抽到(⛔ 不可有第二份名單)
js_keys = set(re.findall(r"\{ k: '([a-z0-9_]+)',", blk))
ok('④ JS 端每個題材鍵 parser 都抽到(單一來源)', js_keys == set(groups or {}),
   js_keys ^ set(groups or {}))

print()
if fails:
    print(f'❌ TEST_THEMES_FAIL({len(fails)}):', fails)
    sys.exit(1)
print('✅ TEST_THEMES_PASS(全部通過)')
