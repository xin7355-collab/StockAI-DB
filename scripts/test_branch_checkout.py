#!/usr/bin/env python3
"""
🌿 V80.2.1 推 data 分支「默默跳過」的回歸測試(陷阱 #64)

真因(2026-11-02 trump_posts.yml 第一輪實跑 log 逐字:「⚠️ 無 data 分支,跳過」):
  deploy_branch 先推 gh-pages,工作區停在 gh-pages —— 那裡有一個 data/ 資料夾;
  接著 `git checkout -f data` → git 分不出 data 是檔名還是分支:
    fatal: 'data' could be both a local file and a tracking branch.
  stderr 被 2>/dev/null 吃掉、|| 分支印「無 data 分支,跳過」、return 0 → 全綠、data 分支從來沒推上去。
  只在 gh-pages 的檔,下一輪 daily_miner 的 orphan 部署就會讓它消失(陷阱 #41 的後半)。
  同一個寫法:trump_posts.yml、news_premarket.yml。

這支:
  ① 靜態:每支 workflow 裡切到 data 分支的 `git checkout`,一律要 `-B <名> <ref>` 或 `--`(⛔ 裸的 data / "$BR")
  ② 實跑:從兩支 yaml 抽出 deploy_branch() 原文(⛔ 測試裡不複製一份邏輯),在「跟 actions/checkout 一樣」的
     repo(git init + remote add + 只抓 main depth 1)裡跑 deploy_branch gh-pages → deploy_branch data,
     兩個遠端分支都要有那個檔
  ③ ⭐ 決定性對照:同一段換回舊寫法(git fetch origin "$BR" + git checkout -f "$BR")→ data 分支一定沒有那個檔
跑法:python3 scripts/test_branch_checkout.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / '.github' / 'workflows'
fails = 0


def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:600]}")
    if not cond:
        fails += 1


def sh(cmd, cwd=None, check=True, env=None):
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


def extract_fn(text, name='deploy_branch'):
    """抽出 `name () { … }`(照縮排找收尾那一行的 `}`),回傳去掉共同縮排的 bash 原文"""
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        m = re.match(r'^(\s*)' + re.escape(name) + r'\s*\(\)\s*\{\s*$', ln)
        if not m:
            continue
        ind = m.group(1)
        for j in range(i + 1, len(lines)):
            if lines[j] == ind + '}':
                body = lines[i:j + 1]
                return '\n'.join(x[len(ind):] if x.startswith(ind) else x for x in body)
    return None


# ── ① 靜態 ──
bad = []
for f in sorted(WF.glob('*.yml')):
    for n, ln in enumerate(f.read_text(encoding='utf8').split('\n'), 1):
        s = ln.split('#')[0] if not ln.strip().startswith('#') else ''
        if not re.search(r'\bgit checkout\b', s):
            continue
        if re.search(r'\s-B\s|--orphan|\s--(\s|$)', s):
            continue
        if re.search(r'\bgit checkout\b(\s+-[a-zA-Z]+)*\s+("?\$\{?BR\}?"?|data)(\s|$|;|\))', s):
            bad.append(f'{f.name}:{n}: {s.strip()[:120]}')
ok('① 每支 workflow 切到 data / "$BR" 一律 -B <名> <ref> 或 --(⛔ 裸的 git checkout -f data)', not bad, bad)

# ── ② ③ 實跑 ──
def build(base):
    """遠端:main / gh-pages(有 data/ 資料夾)/ data;runner = actions/checkout 的做法"""
    rem = base / 'remote.git'
    sh(f'git init -q --bare "{rem}"')
    seed = base / 'seed'
    sh(f'git clone -q "{rem}" "{seed}"', check=False)
    g = lambda c: sh(c, cwd=seed)
    g('git config user.email t@t && git config user.name t')
    (seed / 'a.txt').write_text('main')
    g('git add a.txt && git commit -qm main && git branch -M main && git push -q origin main')
    g('git checkout -q --orphan gh-pages && git rm -rqf .')
    (seed / 'data').mkdir(exist_ok=True)
    (seed / 'data' / 'x.json').write_text('{}')
    (seed / 'index.html').write_text('idx')
    g('git add -f data index.html && git commit -qm gh && git push -q origin gh-pages')
    g('git checkout -q --orphan data && git rm -rqf .')
    (seed / 'data').mkdir(exist_ok=True)
    (seed / 'data' / 'y.json').write_text('{}')
    g('git add -f data && git commit -qm d && git push -q origin data')
    run = base / 'runner'
    run.mkdir()
    r = lambda c: sh(c, cwd=run)
    r(f'git init -q && git remote add origin "file://{rem}" && git config user.email t@t && git config user.name t')
    r('git fetch -q --depth=1 origin +refs/heads/main:refs/remotes/origin/main && git checkout -q -B main origin/main')
    return rem, run


def remote_has(rem, br, path):
    return sh(f'git --git-dir="{rem}" ls-tree -r --name-only {br}', check=False).stdout.split('\n').count(path) == 1


CASES = [
    ('trump_posts.yml', 'trump', ['trump_posts.json'], 'data/trump_posts.json'),
    ('news_premarket.yml', 'news', ['radar_news.json', 'global_news.json'], 'data/radar_news.json'),
    ('mops_daily.yml', 'mopsd', ['mops_recent.json', 'insider_recent.json'], 'data/mops_recent.json'),
]
OLD = ('git fetch origin "$BR" 2>/dev/null || true\n',
       'git checkout -f "$BR" 2>/dev/null || { echo "⚠️ 無 $BR 分支,跳過"; return 0; }\n')

for wf, tmpname, files, target in CASES:
    src = (WF / wf).read_text(encoding='utf8')
    fn = extract_fn(src)
    ok(f'② {wf}:抽得到 deploy_branch()', bool(fn), wf)
    if not fn:
        continue
    for label, body in (('現行', fn), ('舊寫法(決定性對照)', None)):
        if body is None:
            # 把現行那兩行(fetch + checkout)換回舊寫法
            m = re.search(r'git fetch --depth=1 origin "\+refs/heads/\$BR:refs/remotes/origin/\$BR"[^\n]*\n\s*git checkout -f -B "\$BR" "origin/\$BR"[^\n]*\n', fn)
            ok(f'③ {wf}:找得到現行那兩行(才能換回舊寫法)', bool(m), fn[:400])
            if not m:
                continue
            ind = re.match(r'\s*', fn[fn.rfind('\n', 0, m.start()) + 1:]).group(0)
            body = fn[:m.start()] + OLD[0] + ind + OLD[1] + fn[m.end():]
        base = Path(tempfile.mkdtemp(prefix='brco_'))
        try:
            rem, run = build(base)
            tdir = base / 'tmpfiles'
            tdir.mkdir()
            for f in files:
                (tdir / f).write_text('{"ok":1}')
            b = body.replace(f'/tmp/{tmpname}/', f'{tdir}/')
            script = (f'set -e\nHAVE="{" ".join("data/" + f for f in files)}"\n{b}\n'
                      'deploy_branch gh-pages\ndeploy_branch data\n')
            (base / 'run.sh').write_text(script)
            r = sh(f'bash "{base / "run.sh"}"', cwd=run, check=False)
            gh = remote_has(rem, 'gh-pages', target)
            da = remote_has(rem, 'data', target)
            out = (r.stdout + r.stderr)[-500:]
            if label == '現行':
                ok(f'② {wf} 現行:gh-pages 與 data 兩邊都推上去了', r.returncode == 0 and gh and da, f'rc={r.returncode} gh={gh} data={da} :: {out}')
                ok(f'② {wf} 現行:data 分支原本的檔還在(⛔ 被整份蓋掉)', remote_has(rem, 'data', 'data/y.json'), out)
            else:
                ok(f'③ ⭐ {wf} 舊寫法:gh-pages 有、data 沒有(重現「無 data 分支,跳過」)', gh and not da and '無 data 分支' in out, f'gh={gh} data={da} :: {out}')
        finally:
            shutil.rmtree(base, ignore_errors=True)

print(f'\n❌ {fails} 條沒過' if fails else '\n✅ 全部通過')
sys.exit(1 if fails else 0)
