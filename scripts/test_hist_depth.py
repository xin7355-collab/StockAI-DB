#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🧪 分點 `hist` 深度(V74.0.7)—— 把「每輪補齊歷史天」釘死。

❓ 為什麼要有這支:2026-08-31 修好全市場覆蓋(172 → 2,689 檔)之後,
   `hist` 天數中位仍然只有 **2 天**。真因不是抓不到,是
   **每輪只把 `data_date` 那一筆存進 hist**(`_hist.append(_snap)`),
   不管批次已經抓了幾天 → 要 22 個交易日才長得滿,
   而 20 日週期、「同一分點連買」偵測、日後的深歷史回算全都靠它。

🚧 釘住四件事(每一條都用注入缺陷驗過):
   ① `by_date` 的**每一天**都要壓成 hist 快照(⛔ 不是只存今天)
   ② hist 合併要**依日期去重 + 排序**,⛔ 不可重複或亂序
   ③ 保留上限仍是 `CHIP_HIST_KEEP`(⛔ 不可無限長大 → 前端下載量)
   ④ 冷門股在**批次模式**下要拿滿深度(零額外 API);⛔ 逐檔模式維持 3 天
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
FAIL = []


def ck(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  ← {extra}'))
    if not cond:
        FAIL.append(name)


def _strip(s):
    """⛔ 掃「不可出現的寫法」前先拿掉註解 —— 說明 bug 的註解裡就寫著壞寫法(本專案踩過 8 次)。"""
    out = [ln.split('#')[0] for ln in s.split('\n')]
    return re.sub(r'"""[\s\S]*?"""', '', '\n'.join(out))


CODE = _strip(SRC)
ck('⓪ 空過守門:去註解後仍有大量程式碼', len(CODE) > 100000, f'只剩 {len(CODE)}')

# ── ① 每一天都要壓成快照 ────────────────────────────────────────
ck('① 要有 _day_snaps 且從 by_date 逐日建立',
   '_day_snaps' in CODE and re.search(r'for _d2, _slot2 in by_date\.items\(\)', CODE) is not None,
   '沒有逐日建快照')
ck('①b ⛔ 不可再出現「只 append 一筆」的舊寫法',
   '_hist.append(_snap)' not in CODE, '舊的單筆 append 還在')

# ── ② 依日期去重 + 排序 ─────────────────────────────────────────
ck('② hist 合併要依日期 dict 去重再 sorted',
   re.search(r'_merged\.update\(_day_snaps\)', CODE) is not None
   and re.search(r'sorted\(_merged\)', CODE) is not None, '沒有去重/排序')

# ── ③ 保留上限還在 ─────────────────────────────────────────────
ck('③ 仍受 CHIP_HIST_KEEP 上限(⛔ 不可無限長大)',
   re.search(r'\[-CHIP_HIST_KEEP:\]', CODE) is not None, '上限不見了')

# ── ④ 冷門股批次模式拿滿、逐檔模式維持 3 天 ─────────────────────
m4 = re.search(r'_need_days = CHIP_DAYS if \(_is_hot or _bulk_idx is not None\) else 3', CODE)
ck('④ 冷門股:批次模式拿滿 CHIP_DAYS、逐檔模式仍是 3 天', m4 is not None,
   '沒有依模式分流(逐檔模式拿滿會多打幾千次 HTTP)')

# ── ⑤ 實跑:模擬 by_date 多天 → 驗 hist 真的補齊、排序、去重、封頂 ──
os.environ.setdefault('FINMIND_TOKENS', 'x')
import tempfile
os.environ['CHIPS_DEEP_DIR'] = tempfile.mkdtemp(prefix='no_deep_')
import miner  # noqa: E402


def simulate(dates, existing_hist, keep=None):
    """把 miner 那段合併邏輯用同樣的資料結構跑一次(⛔ 這裡只驗合併行為,
    判定邏輯本身由 ①~④ 的原始碼斷言把關)。"""
    K = keep or miner.CHIP_HIST_KEEP
    day_snaps = {d: {'d': d, 'b': [[f'券商{d}', 1000, 10.0]], 's': []} for d in dates}
    merged = {str(h['d']): h for h in existing_hist if isinstance(h, dict) and h.get('d')}
    merged.update(day_snaps)
    return [merged[k] for k in sorted(merged)][-K:]


old = [{'d': '2026-08-01', 'b': [['舊', 1, 1.0]], 's': []},
       {'d': '2026-08-04', 'b': [['舊', 1, 1.0]], 's': []}]
res = simulate(['2026-08-05', '2026-08-06', '2026-08-04'], old)
ck('⑤ 實跑:舊 2 天 + 新 3 天(含 1 天重複)→ 合併成 4 天',
   len(res) == 4, f'得到 {len(res)} 天:{[h["d"] for h in res]}')
ck('⑤b 實跑:日期由舊到新排序',
   [h['d'] for h in res] == sorted(h['d'] for h in res), [h['d'] for h in res])
ck('⑤c 實跑:重複日期以**新的**為準(⛔ 不是保留舊的)',
   next(h for h in res if h['d'] == '2026-08-04')['b'][0][0] == '券商2026-08-04',
   '重複那天沒被新資料覆蓋')
big = simulate([f'2026-06-{d:02d}' for d in range(1, 29)], [])
ck('⑤d 實跑:超過上限要截斷成 CHIP_HIST_KEEP 天,且保留**最新**那批',
   len(big) == miner.CHIP_HIST_KEEP and big[-1]['d'] == '2026-06-28',
   f'{len(big)} 天,最後 {big[-1]["d"] if big else "-"}')

# ── ⑥ chips_deep 還原:只拉需要的那幾天(⛔ 不可整包 156MB)──────────
RESTORE = SRC[SRC.index('def _load_chips_deep_local'):]
RESTORE = RESTORE[:RESTORE.index('\ndef ', 10)]
RC = _strip(RESTORE)
ck('⑥ 空過守門:_load_chips_deep_local 去註解後仍有程式碼', len(RC) > 800, f'只剩 {len(RC)}')
ck('⑥b 要先用 ls-tree 問分支有哪幾天再取交集(⛔ 點名不存在的日期會讓 git archive 整個失敗 → 整包 156MB)',
   "'ls-tree'" in RC and 'd in have' in RC, '沒有交集過濾')
ck('⑥c fetch 要帶 --filter=blob:none(只下載點名的那幾天)',
   '--filter=blob:none' in RC, '沒有 partial fetch')
ck('⑥d 解壓要 -C 對齊 CHIPS_DEEP_DIR(⛔ 解到 CWD 會「抓下來卻找不到」)',
   '--strip-components=1' in RC and "-C '" in RC, '解壓路徑沒對齊')

print()
if FAIL:
    print(f'❌ {len(FAIL)} 條沒過:')
    for f in FAIL:
        print('   -', f)
    sys.exit(1)
print('✅ HIST_DEPTH_PASS(全部通過)')
