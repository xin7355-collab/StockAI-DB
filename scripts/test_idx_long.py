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
ok('③ 推 data 分支、只 commit 那一個檔(檔名由起點決定)、5 次重試 + pull --rebase',
   'git checkout -f -B data origin/data' in WF and '-- "data/$OUT_NAME"' in WF
   and 'git push origin data' in WF and 'pull --rebase origin data' in WF and '--force' not in WF)
# 🕰️ V79.3.5 起點輸入:預設 2010-01-01(行為不變);早於 2010 → 另存 idx_long_early.json;⛔ inputs 只經 env 進來、先驗格式
_runs = '\n'.join(l for l in WF.split('\n') if 'inputs.' in l)
ok('⑭ 起點輸入預設 2010-01-01、⛔ inputs 只出現在 env(不直接塞進指令)、先驗 YYYY-MM-DD',
   re.search(r"start:\s*\n(?:\s+\w+:.*\n)*?\s+default:\s*'2010-01-01'", WF) is not None
   and _runs.strip().startswith('IN_START: ${{ inputs.start }}') and _runs.count('inputs.') == 1
   and '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' in WF)
ok('⑭b 早於 2010 → idx_long_early.json;否則 idx_long.json(⛔ 早期資料不可蓋掉回測用那份)',
   'if [[ "$S" < "2010-01-01" ]]; then OUT=idx_long_early.json; else OUT=idx_long.json; fi' in WF
   and '--out "/tmp/$OUT_NAME"' in WF)
ok('⑮ 腳本早期模式:起點早於預設才切、拿 idx_long.json 對表、FinMind 不夠深退證交所(⛔ 不改 miner.py)',
   'if START < DEFAULT_START:' in CODE and "load_long_ref(os.path.join(ref_dir, 'idx_long.json'))" in CODE
   and 'build_early(fm, ref_long, twse=twse_index_rows)' in CODE and "EARLY_END = '2010-12-31'" in CODE)
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

# 🏪 V79.2.4 櫃買:backfill 有 ⑤ TPEx(⛔ 不是 OTC —— FinMind 的 'OTC' 回空)、拿不到只寫 twoii_error、⛔ 不進 errs;workflow 參考檔選用
ok('⑫ backfill 抓櫃買用 data_id=TPEx、回空只寫 twoii_error(⛔ 不擋前四份)',
   "'data_id': 'TPEx'" in CODE and "obj['twoii_error']" in CODE and "errs.append(f'櫃買" not in CODE and 'ref_twoii' in CODE)
ok('⑫b workflow 的 ^TWOII 參考檔是選用的(沒有就跳過,⛔ 不 exit 1)', '^TWOII.json' in WF and 'rm -f "/tmp/idx_ref/^TWOII.json"' in WF)
# ⑬ merge_k66_history.apply_idx_long:有 twoii 就接出 ^TWOII.json —— 接點 = 本站那份第一個長歷史也有的日期(本站第一列是星期六假日列、日期格式混用)
import json, tempfile
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from merge_k66_history import apply_idx_long
with tempfile.TemporaryDirectory() as td:
    DD, OUT = os.path.join(td, 'dd'), os.path.join(td, 'out'); os.makedirs(DD); os.makedirs(OUT)
    days = [f'2024/{m:02d}/{d:02d}' for m in range(1, 13) for d in range(1, 29)]
    json.dump([dict(date=d, open=100, high=101, low=99, close=100 + 200 + i, volume=1) for i, d in enumerate(days[200:])], open(f'{DD}/^TWII.json', 'w'))
    json.dump([dict(date=d, open=10, high=10, low=10, close=10 + (200 + i) * 0.1, volume=1) for i, d in enumerate(days[200:])], open(f'{DD}/0050.json', 'w'))
    # 本站櫃買:第一列是假日(不在長歷史日曆)+ 之後日期用「-」格式
    local = [dict(date='2024/06/30', open=1, high=1, low=1, close=999, volume=0)] + [dict(date=d.replace('/', '-'), open=1, high=1, low=1, close=200 + i, volume=0) for i, d in enumerate(days[250:])]
    json.dump(local, open(f'{DD}/^TWOII.json', 'w'))
    J = {'twii': [[d, 100, 101, 99, 100 + i, 1] for i, d in enumerate(days)], 'e0050': [[d, 10, 10, 10, 10 + i * 0.1, 1] for i, d in enumerate(days)], 'div0050': [],
         'twoii': [[d, 1, 1, 1, (200 + i - 250) if i >= 250 else 150 + i * 0.2, 1] for i, d in enumerate(days)]}
    json.dump(J, open(f'{td}/idx_long.json', 'w'))
    apply_idx_long(DD, OUT, f'{td}/idx_long.json')
    outO = json.load(open(f'{OUT}/^TWOII.json')) if os.path.exists(f'{OUT}/^TWOII.json') else None
    ok('⑬ apply_idx_long 有 twoii → 寫 ^TWOII.json = 長歷史(接點之前)+ 本站(接點起);假日列丟掉、日期格式混用也接得上',
       outO is not None and len(outO) == 250 + len(days[250:]) and outO[0]['date'] == days[0] and outO[250]['date'] == days[250].replace('/', '-') and all(r['close'] != 999 for r in outO))
    # ⑬b 有 twoii_error → ⛔ 不寫;接點收盤差 >0.5% → ⛔ 不寫
    os.remove(f'{OUT}/^TWOII.json')
    J2 = dict(J, twoii_error='x'); json.dump(J2, open(f'{td}/idx_long2.json', 'w')); apply_idx_long(DD, OUT, f'{td}/idx_long2.json')
    e1 = not os.path.exists(f'{OUT}/^TWOII.json')
    J3 = dict(J, twoii=[[d, 1, 1, 1, 777, 1] for d in days]); json.dump(J3, open(f'{td}/idx_long3.json', 'w')); apply_idx_long(DD, OUT, f'{td}/idx_long3.json')
    e2 = not os.path.exists(f'{OUT}/^TWOII.json')
    ok('⑬b twoii_error 或接點對不上 → ⛔ 不寫 ^TWOII.json(其他三份照寫)', e1 and e2 and os.path.exists(f'{OUT}/^TWII.json') and os.path.exists(f'{OUT}/_bench0050.json'))
print(f'\n{"❌ " + str(len(fails)) + " 條沒過" if fails else "✅ IDX_LONG_PASS"}')
sys.exit(1 if fails else 0)
