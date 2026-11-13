#!/usr/bin/env python3
"""
📢 V82.2.9 mops_daily.yml「併進研究分支」那一段實跑(⛔ 測試裡不複製一份邏輯 —— 從 yaml 抽 push_deep() 原文來跑)

為什麼要實跑:研究分支(mops_deep / insider_deep)是二進位月檔(.json.gz),⛔ 不能靠 git pull --rebase 合併;
  workflow 的做法是「推不上去 → 重抓分支 → 在剛抓下來的月檔上重新併一次 → 再推」。這種 git 流程只有實跑才知道對不對
  (CLAUDE.md:git / workflow 類的 bug 要實測,⛔ 用推理)。

① 一般情況:遠端 mops_deep 原本有 11/10 那天 → 併進 11/12 → 兩天都在、推上去
② ⭐ 第一次 push 被搶先(假 git:第一次 push 前先讓「別人」推一個 2026-10 月檔、這次 push 回失敗)
   → 第二次在新的分支上重新併 → 遠端同時有別人的 2026-10 與我們的 11/12(⛔ 把別人的蓋掉、⛔ 把我們的弄丟)
③ 決定性對照:把迴圈裡那行 --apply-deep 拿掉 → 遠端一定沒有 11/12(證明 ② 量得到「重新併」那件事)
④ 分支不存在 → 印 warning、return 0(⛔ 自己建一個空的研究分支)
跑法:python3 scripts/test_mops_daily_wf.py
"""
import gzip
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / '.github' / 'workflows' / 'mops_daily.yml'
fails = 0


def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:700]}")
    if not cond:
        fails += 1


def sh(cmd, cwd=None, check=True, env=None):
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


def extract_fn(text, name):
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        m = re.match(r'^(\s*)' + re.escape(name) + r'\s*\(\)\s*\{\s*$', ln)
        if not m:
            continue
        ind = m.group(1)
        for j in range(i + 1, len(lines)):
            if lines[j] == ind + '}':
                return '\n'.join(x[len(ind):] if x.startswith(ind) else x for x in lines[i:j + 1])
    return None


def gz(doc):
    return gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def month_doc(rem, br, path):
    r = subprocess.run(f'git --git-dir="{rem}" show {br}:{path}', shell=True, capture_output=True)
    if r.returncode != 0:
        return None
    return json.loads(gzip.decompress(r.stdout).decode('utf-8'))


def build(base):
    rem = base / 'remote.git'
    sh(f'git init -q --bare "{rem}"')
    seed = base / 'seed'
    sh(f'git clone -q "{rem}" "{seed}"', check=False)
    g = lambda c: sh(c, cwd=seed)   # noqa: E731
    g('git config user.email t@t && git config user.name t')
    (seed / 'a.txt').write_text('main')
    g('git add a.txt && git commit -qm main && git branch -M main && git push -q origin main')
    g('git checkout -q --orphan mops_deep && git rm -rqf .')
    (seed / 'mops_deep').mkdir()
    (seed / 'mops_deep' / '2026-11.json.gz').write_bytes(gz({'m': '2026-11', 'days': {'2026-11-10': {'sii': 1, 'otc': 0}},
                                                             'rows': [['1101', '台泥', '2026-11-10', '09:00:00', '舊的公告', 'sii']]}))
    (seed / 'mops_deep' / '_status.json').write_text(json.dumps({'months': ['2026-11'], 'earliest_empty': '2009-12'}))
    g('git add -f mops_deep && git commit -qm deep && git push -q origin mops_deep')
    run = base / 'runner'
    run.mkdir()
    r = lambda c: sh(c, cwd=run)    # noqa: E731
    r(f'git init -q && git remote add origin "file://{rem}" && git config user.email t@t && git config user.name t')
    r('git fetch -q --depth=1 origin +refs/heads/main:refs/remotes/origin/main && git checkout -q -B main origin/main')
    code = base / 'code'
    shutil.copytree(ROOT / 'scripts', code / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy(ROOT / 'lib_jsonsafe.py', code / 'lib_jsonsafe.py')
    patch = {'made': 'x', 'mops': {'2026-11-12|sii': [['2330', '台積電', '2026-11-12', '13:54:04', '公告本公司董事會決議減資彌補虧損', 'sii'],
                                                      ['2317', '鴻海', '2026-11-12', '15:00:00', '公告本公司董事會通過合併財務報告', 'sii']],
                                   '2026-11-12|otc': [['6488', '環球晶', '2026-11-12', '16:00:00', '代子公司公告', 'otc']]},
             'insider': {}}
    (base / 'patch.json').write_text(json.dumps(patch, ensure_ascii=False))
    return rem, run, code, seed


def shim_git(base, rem, seed, steal):
    """假 git:第一次 push 之前先讓「別人」推一個 2026-10 月檔,然後這次 push 回失敗(= 被搶先)。其他照真的 git。"""
    real = shutil.which('git')
    d = base / 'shim'
    d.mkdir()
    flag = base / 'stolen.flag'
    other = base / 'other'
    sh(f'git clone -q --branch mops_deep "{rem}" "{other}"')
    sh('git config user.email o@o && git config user.name o', cwd=other)
    (d / 'git').write_text(f'''#!/bin/bash
if [ "$1" = "push" ] && [ "{1 if steal else 0}" = "1" ] && [ ! -f "{flag}" ]; then
  touch "{flag}"
  ( cd "{other}" && mkdir -p mops_deep && python3 -c "import gzip,json;open('mops_deep/2026-10.json.gz','wb').write(gzip.compress(json.dumps({{'m':'2026-10','days':{{'2026-10-30':{{'sii':1,'otc':0}}}},'rows':[['2330','台積電','2026-10-30','10:00:00','別人推的','sii']]}}).encode()))" \\
    && "{real}" add -f mops_deep && "{real}" commit -qm other && "{real}" push -q origin mops_deep ) >/dev/null 2>&1
  echo "! [rejected] (fetch first)" >&2
  exit 1
fi
exec "{real}" "$@"
''')
    (d / 'git').chmod((d / 'git').stat().st_mode | stat.S_IEXEC)
    return d


src = WF.read_text(encoding='utf8')
fn = extract_fn(src, 'push_deep')
ok('⓪ 抽得到 push_deep()', bool(fn), src[:200])
if not fn:
    sys.exit(1)
code_only = '\n'.join(ln for ln in fn.split('\n') if not ln.strip().startswith('#'))   # ⚠️ 註解裡會提到禁止的寫法 → 先剝掉
ok('⓪ 迴圈裡每一次都重抓分支 + 重新併(⛔ git pull --rebase 二進位月檔)', 'pull --rebase' not in code_only and code_only.count('--apply-deep') == 1
   and code_only.index('for i in') < code_only.index('git fetch') < code_only.index('--apply-deep'), code_only)


def run_case(label, body, steal):
    base = Path(tempfile.mkdtemp(prefix='mdwf_'))
    try:
        rem, run, code, seed = build(base)
        b = body.replace('/tmp/mopsd/code/', f'{code}/').replace('/tmp/mopsd/mops_daily_patch.json', f'{base}/patch.json')
        script = f'set -e\n{b}\npush_deep mops_deep mops\n'
        (base / 'run.sh').write_text(script)
        env = dict(os.environ)
        env['PATH'] = f'{shim_git(base, rem, seed, steal)}:{env["PATH"]}'
        env.pop('GITHUB_OUTPUT', None)
        r = sh(f'bash "{base / "run.sh"}"', cwd=run, check=False, env=env)
        nov = month_doc(rem, 'mops_deep', 'mops_deep/2026-11.json.gz') or {}
        octo = month_doc(rem, 'mops_deep', 'mops_deep/2026-10.json.gz')
        return r, nov, octo, (r.stdout + r.stderr)[-600:]
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ① 一般情況
r, nov, octo, out = run_case('一般', fn, steal=False)
ok('① 一般:推上去、11/10 舊的還在、11/12 兩個市場都進來', r.returncode == 0 and '2026-11-10' in nov.get('days', {})
   and nov.get('days', {}).get('2026-11-12') == {'sii': 2, 'otc': 1} and len(nov.get('rows', [])) == 4, (r.returncode, nov.get('days'), out))
# ② 第一次 push 被搶先
r, nov, octo, out = run_case('搶先', fn, steal=True)
ok('② ⭐ 被搶先 → 第二次在新的分支上重新併:別人的 2026-10 還在、我們的 11/12 也在', r.returncode == 0 and octo is not None
   and nov.get('days', {}).get('2026-11-12') == {'sii': 2, 'otc': 1} and '2026-11-10' in nov.get('days', {}), (r.returncode, octo, nov.get('days'), out))
# ③ 決定性對照:拿掉迴圈裡的 --apply-deep
noapply = '\n'.join(ln for ln in fn.split('\n') if '--apply-deep' not in ln)
r, nov, octo, out = run_case('對照', noapply, steal=True)
ok('③ 決定性對照:拿掉重新併那行 → 遠端一定沒有 11/12(證明 ② 量得到)', '2026-11-12' not in (nov or {}).get('days', {}), (nov or {}).get('days'))
# ④ 分支不存在
base = Path(tempfile.mkdtemp(prefix='mdwf_'))
try:
    rem, run, code, seed = build(base)
    b = fn.replace('/tmp/mopsd/code/', f'{code}/').replace('/tmp/mopsd/mops_daily_patch.json', f'{base}/patch.json')
    (base / 'run.sh').write_text(f'set -e\n{b}\npush_deep insider_deep insider\n')
    r = sh(f'bash "{base / "run.sh"}"', cwd=run, check=False)
    ls = sh(f'git --git-dir="{rem}" branch --list insider_deep', check=False).stdout.strip()
    ok('④ 研究分支不存在 → warning、return 0、⛔ 自己建一個空的', r.returncode == 0 and '::warning::' in r.stdout and not ls, (r.returncode, r.stdout[-300:], ls))
finally:
    shutil.rmtree(base, ignore_errors=True)

print(f'\n❌ {fails} 條沒過' if fails else '\n✅ 全部通過')
sys.exit(1 if fails else 0)
