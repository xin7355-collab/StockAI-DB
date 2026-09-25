#!/usr/bin/env python3
"""📚 V77.6.3 idx_long 守門:workflow 只手動 / 推 data 分支 / 參考檔防 0 bytes / 腳本守門與 selftest。"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = open(os.path.join(ROOT, '.github/workflows/idx_long.yml')).read()
PY = open(os.path.join(ROOT, 'scripts/idx_long_backfill.py')).read()
CODE = '\n'.join(l for l in PY.split('\n') if not l.lstrip().startswith('#'))
fails = []


def ok(name, cond):
    print(('✅ ' if cond else '❌ ') + name)
    if not cond:
        fails.append(name)


on = WF.split('\non:')[1].split('\npermissions')[0]
ok('① 只有 workflow_dispatch(⛔ 沒有 cron / push → 不吃排程配額、不會被 push 觸發)',
   'workflow_dispatch' in on and 'schedule' not in on and 'push' not in on)
ok('② 自己的 concurrency group(⛔ 不共用)', re.search(r'group:\s*idx-long\b', WF) is not None)
ok('③ 推 data 分支、只 commit 那一個檔、5 次重試 + pull --rebase',
   'git checkout -f -B data origin/data' in WF and '-- data/idx_long.json' in WF
   and 'git push origin data' in WF and 'pull --rebase origin data' in WF and '--force' not in WF)
ok('④ 參考檔取完驗大小(⛔ 0 bytes 陷阱)', '[ -s "/tmp/idx_ref/$f.json" ]' in WF)
ok('⑤ 先跑 selftest 才抓', WF.index('--selftest') < WF.index('--ref-dir /tmp/idx_ref'))
ok('⑥ 只給 FINMIND_TOKENS(⛔ 不給用不到的機密)', set(re.findall(r'secrets\.(\w+)', WF)) == {'FINMIND_TOKENS'})
ok('⑦ 腳本守門字串在(第一根日期 / 根數 / 對表比例)',
   "FIRST_MAX = '2010-01-15'" in CODE and 'MIN_TWII = 3800' in CODE and 'MIN_RATIO = 0.95' in CODE and 'TOL = 0.005' in CODE)
ok('⑧ 有錯就 exit 1 且不寫檔(寫檔在 errs 判斷之後)',
   CODE.index("if errs:") < CODE.index("json.dump(obj, f"))
ok('⑨ token 輪動共用 dispo_probe.fm(⛔ 不寫第二份)', 'from dispo_probe import fm, TOKENS' in CODE and 'urlopen' not in CODE)
ok('⑩ 0050 錨在本站那份(⛔ 不靠 _backadjust_splits —— 它的 gap>5 守門不會動停牌 7 天的分割,run #1 實測 39.3%)',
   'anchor_scale(e5, ref_0050)' in CODE and "obj['e0050_anchor']" in CODE)
r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts/idx_long_backfill.py'), '--selftest'],
                   capture_output=True, text=True)
ok('⑪ selftest 全綠', r.returncode == 0 and 'IDX_LONG_SELFTEST_PASS' in r.stdout)
print(f'\n{"❌ " + str(len(fails)) + " 條沒過" if fails else "✅ IDX_LONG_PASS"}')
sys.exit(1 if fails else 0)
