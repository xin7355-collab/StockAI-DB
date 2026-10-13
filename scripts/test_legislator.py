#!/usr/bin/env python3
"""🏛️ V79.2.0 政治人物持股採礦守門:workflow 只手動 / 專屬 group / 推 data 分支 / 0 bytes 守門 / selftest 先跑 / 0 筆不寫檔。"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = open(os.path.join(ROOT, '.github/workflows/legislator_holdings.yml')).read()
PY = open(os.path.join(ROOT, 'scripts/legislator_miner.py')).read()
CODE = '\n'.join(l for l in PY.split('\n') if not l.lstrip().startswith('#'))
fails = []


def ok(name, cond):
    print(('✅ ' if cond else '❌ ') + name)
    if not cond:
        fails.append(name)


on = WF.split('\non:')[1].split('\npermissions')[0]
ok('① 只有 workflow_dispatch(⛔ 沒有 cron / push)', 'workflow_dispatch' in on and 'schedule' not in on and 'push:' not in on)
ok('② 自己的 concurrency group', re.search(r'group:\s*legislator-holdings\b', WF) is not None)
ok('③ 推 data 分支、只 commit 那一檔、5 次重試 + pull --rebase、⛔ --force',
   'git checkout -f -B data origin/data' in WF and '-- data/legislator_holdings.json' in WF
   and 'git push origin data' in WF and 'pull --rebase origin data' in WF and '--force' not in WF)
ok('④ 推之前驗產物不是 0 bytes', '[ -s /tmp/legislator_holdings.json ]' in WF)
ok('⑤ 先跑 selftest 才抓', WF.index('--selftest') < WF.index('--out /tmp/legislator_holdings.json'))
ok('⑥ probe 模式不推(推那步要 mode == out)', "if: ${{ inputs.mode == 'out' }}" in WF)
ok('⑦ 不給任何機密', not re.findall(r'secrets\.(\w+)', WF))
ok('⑧ 有失敗就 exit 1 且不寫檔(寫檔在 fails 判斷之後)', CODE.index('if fails:') < CODE.index('json.dump(out, f'))
r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts/legislator_miner.py'), '--selftest'],
                   capture_output=True, text=True)
ok('⑨ selftest 全綠', r.returncode == 0 and '❌' not in r.stdout)
print(f'\n{"❌ " + str(len(fails)) + " 條沒過" if fails else "✅ LEGISLATOR_PASS"}')
sys.exit(1 if fails else 0)
