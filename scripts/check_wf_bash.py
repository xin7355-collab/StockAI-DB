#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🐚 workflow 每一個 run 步驟先過 `bash -n`(V79.3.8 新增,實跑踩到才寫的)

為什麼:stock_deep_backfill.yml 的還原步驟少了一個右引號(`echo "⚠️ fin_deep 分支拿不到`)——
YAML 照樣合法、check_workflow_paths / check_env_default 全綠,**只有真的跑到那一步才會語法錯**;
而那一步是「接力的下一棒」才會用到的新版 → 一整串補挖會在半夜無聲斷掉(陷阱 #9 / #40 型:全綠 ≠ 會動)。
⭐ `bash -n` 只做語法檢查、不執行;`${{ ... }}` 在 -n 階段只是字面,不會誤報。
⛔ 只檢查 shell 是 bash(預設)的步驟;`shell: python` 之類的跳過。

跑法:python3 scripts/check_wf_bash.py   [--selftest]
"""
import glob
import subprocess
import sys

import yaml


def bad_steps(doc, fname):
    out = []
    for jn, job in ((doc or {}).get('jobs') or {}).items():
        dflt = (((job.get('defaults') or {}).get('run') or {}).get('shell') or
                (((doc.get('defaults') or {}).get('run') or {}).get('shell')) or 'bash')
        for i, st in enumerate(job.get('steps') or []):
            if 'run' not in st:
                continue
            sh = str(st.get('shell') or dflt)
            if not sh.startswith('bash') and sh not in ('sh',):
                continue
            r = subprocess.run(['bash', '-n'], input=st['run'], text=True, capture_output=True)
            if r.returncode != 0:
                out.append(f"{fname} ・job {jn} ・第 {i + 1} 步「{st.get('name', '')}」:{r.stderr.strip()[:200]}")
    return out


def main():
    bad = []
    files = sorted(glob.glob('.github/workflows/*.yml') + glob.glob('.github/workflows/*.yaml'))
    for f in files:
        try:
            doc = yaml.safe_load(open(f, encoding='utf-8'))
        except Exception as e:
            bad.append(f'{f}:YAML 讀不進來 {e}')
            continue
        bad += bad_steps(doc, f)
    if not files:
        print('❌ 一支 workflow 都沒掃到(空過守門)')
        return 1
    for b in bad:
        print('❌ ' + b)
    print(f"{'✅' if not bad else '❌'} {len(files)} 支 workflow 的 run 步驟 bash -n {'全過' if not bad else f'{len(bad)} 步語法錯'}")
    return 1 if bad else 0


def selftest():
    good = {'jobs': {'a': {'steps': [{'run': 'echo "ok"\nif [ 1 ]; then echo x; fi'}, {'uses': 'x'}]}}}
    broke = {'jobs': {'a': {'steps': [{'name': 'n', 'run': 'echo "沒有右引號\necho next'}]}}}
    py = {'jobs': {'a': {'steps': [{'shell': 'python', 'run': 'print("x"'}]}}}
    expr = {'jobs': {'a': {'steps': [{'run': 'echo "${{ github.token }}"\nX=${{ inputs.q }}'}]}}}
    ok = (not bad_steps(good, 'g') and len(bad_steps(broke, 'b')) == 1 and not bad_steps(py, 'p')
          and not bad_steps(expr, 'e'))
    print('✅ selftest 全過(好的過、少引號抓得到、python 步驟跳過、${{ }} 不誤報)' if ok else '❌ selftest 失敗')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
