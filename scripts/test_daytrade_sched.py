#!/usr/bin/env python3
"""📊 V75.1.8 daytrade_pack 採礦搬家(daytrade_data.yml → daytrade_probe.yml)

🚨 為什麼搬:實測 2026-09-09(`actions_list`)`daytrade_data.yml` 從 2026-07-13 上線至今
   **total_count = 1**,而那唯一一筆是手動觸發還被 cancel → **排程一次都沒被觸發過**,
   `data/daytrade_pack.json` 停在 08/07(33 天),前端卻還拿它當今天的方向投票。

⭐ 照 V73.9.0 的結論(⛔ 不要求 GitHub 幫我們排很多次;每天 1~3 次在這個 repo 實測可靠),
   併進 `daytrade_probe.yml`(cron '0 10',同一份實測裡是**正常跑的整點反例**、主題也相同),
   ⛔ 不再開一支 cron 去搶配額。

⛔ 釘死的六件事:
  ① `daytrade_data.yml` ⛔ 不可再有 schedule(⛔ 但也不可刪掉這支 —— 手動補跑還要用)
  ② `daytrade_probe.yml` 真的有跑 `daytrade_data_miner.py`
  ③ 兩支採礦**互不影響**(各自 set +e、exit 0)—— ⛔ 一支失敗不可拖累另一支
  ④ deploy 條件要含 pack_ok(⛔ 否則 probe 失敗那天 pack 也上不去)
  ⑤ ⛔ 沒產出的那支絕不可覆寫線上舊檔(要 pack_ok=1 才進部署清單)
  ⑥ 部署目標是 gh-pages + data 兩條(前端讀 gh-pages;data 讓 daily_miner 的 git archive 保留)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_YML = (ROOT / '.github/workflows/daytrade_data.yml').read_text(encoding='utf-8')
PROBE_YML = (ROOT / '.github/workflows/daytrade_probe.yml').read_text(encoding='utf-8')

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:220]}'))
    if not cond:
        fails.append(name)


# ── ① 舊的那支不可再排程,但要留著手動 ──
_on = DATA_YML.split('\non:', 1)[1].split('\njobs:', 1)[0] if '\non:' in DATA_YML else ''
ok('① ⛔ daytrade_data.yml 不可再有 schedule(⛔ 別再去搶排程配額)',
   'schedule:' not in _on and 'cron:' not in _on, _on.strip()[:200])
ok('① ⛔ 但也不可刪掉這支 —— 手動補跑/校準 log 還要用',
   'workflow_dispatch:' in _on, _on.strip()[:200])
ok('① ⭐ 要寫清楚為什麼停用(⛔ 沒寫原因,下次有人會直接把 cron 加回去)',
   '一次都沒有被觸發過' in DATA_YML or 'total_count' in DATA_YML, '')

# ── ②③ 搬到 probe 那支 ──
ok('② daytrade_probe.yml 真的有跑 daytrade_data_miner.py',
   'python3 daytrade_data_miner.py' in PROBE_YML, '')
_pack = PROBE_YML.split("id: pack", 1)[1].split('- name:', 1)[0] if 'id: pack' in PROBE_YML else ''
ok('③ ⛔ 兩支採礦互不影響:pack 步驟要 set +e 且結尾 exit 0',
   'set +e' in _pack and re.search(r'\bexit 0\b', _pack) is not None, _pack[:200])
ok('③b ⭐ 沒產出時要留下可查的訊息(⛔ 不可靜默)',
   '::warning::' in _pack, _pack[:200])
ok('③c ⭐ pack_ok 要同時看 rc 與檔案是否真的存在(⛔ rc=0 不等於有產出)',
   'pack_ok=1' in _pack and '-f daytrade_pack.json' in _pack, _pack[:300])

# ── ④⑤⑥ 部署 ──
_dep = PROBE_YML.split('部署到 gh-pages', 1)[1] if '部署到 gh-pages' in PROBE_YML else ''
ok('④ deploy 的 if 要含 pack_ok(⛔ 否則 probe 失敗那天 pack 也上不去)',
   "steps.pack.outputs.pack_ok == '1'" in _dep, _dep[:200])
ok('⑤ ⛔ 沒產出不可覆寫線上舊檔(要 pack_ok=1 才複製進部署清單)',
   re.search(r"steps\.pack\.outputs\.pack_ok \}\} \" ?= ?\"1\"|pack_ok \}\}\" = \"1\"", _dep) is not None
   or 'pack_ok }}" = "1" ]' in _dep, _dep[:400])
ok('⑤b ⛔ 兩支都沒產出時要整個跳過(⛔ 不可 push 一個空的 commit)',
   '兩支都沒有可部署的產出' in _dep, '')
ok('⑥ 部署 gh-pages + data 兩條都在',
   'deploy_branch gh-pages' in _dep and 'deploy_branch data' in _dep, '')
ok('⑥b ⭐ commit 只帶明確 pathspec(⛔ 不可 `git add .` 把無關檔推上 gh-pages)',
   'git add .' not in _dep and 'PATHS' in _dep, '')

# ── ⚠️ 這支的 cron 本身不可被順手改掉(它是「實測可靠」的那個頻率)──
ok('⚠️ daytrade_probe 的 cron 仍是每天 1 次(⛔ 改密了就會回到配額被吃光的老路)',
   "cron: '0 10 * * 1-5'" in PROBE_YML, '')

print()
print(f'❌ DAYTRADE_SCHED_FAIL({len(fails)}):{fails}' if fails else '✅ DAYTRADE_SCHED_PASS(全部通過)')
sys.exit(1 if fails else 0)
