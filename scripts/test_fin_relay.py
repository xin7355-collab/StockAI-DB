#!/usr/bin/env python3
"""✂️🛟 財報切片「進不進得了前端」的守門(V76.1.8)

⭐ 為什麼要有這支:fin_deep 分支上的 7.8 MB 大檔前端讀不到,而且**只推 fin_deep 分支的東西永遠上不了 gh-pages**
   (daily_miner 的 gh-pages 是 orphan,內容全部來自 `git archive origin/data`)。
   → 切片必須推到 **data 分支**,daily_miner 才會自動帶上去(同 tick_flow「也推 data 分支」)。

⭐ 這支**開真的 git repo 實跑 yaml 裡抽出來的那段腳本**(⛔ 測試裡不複製一份邏輯),
   而且有**決定性的對照組**:同一批切片只推 fin_deep 分支 → 模擬 daily_miner 鋪底層時必須「看不到」。
   ⛔ 沒有那一格,這支測試跟沒寫一樣(假綠燈)。

跑法:python3 scripts/test_fin_relay.py
"""
import json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, '.github/workflows/fin_backfill.yml')
FAILS = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + (f'  {extra}' if extra and not cond else ''))
    if not cond:
        FAILS.append(name)


def sh(cmd, cwd=None, check=True, env=None):
    r = subprocess.run(['bash', '-c', cmd], cwd=cwd, capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


body = open(WF, encoding='utf-8').read()

# ── ① 靜態 ──────────────────────────────────────────────────────
i_push = body.find('- name: 🚀 推上 fin_deep 分支')
i_slice = body.find('- name: ✂️ 每檔切片')
ok('①a workflow 有「✂️ 每檔切片 → 推 data 分支」那步', i_slice > 0)
ok('①b 切片排在「🚀 推上 fin_deep」之後(那步會 checkout --orphan,切片要在它之後自己切回 data)', 0 < i_push < i_slice, f'push@{i_push} slice@{i_slice}')
ok('①c 有 slice_only 輸入,而且回算那步在 slice_only=1 時跳過', 'slice_only:' in body and re.search(r"- name: 📦 回算[^\n]*\n\s+if: \$\{\{ inputs\.slice_only != '1' \}\}", body) is not None)
ok('①d 切片那步用 `git checkout -f -B data origin/data`(⛔ 不是推 fin_deep、不是推 gh-pages)',
   re.search(r'✂️ 每檔切片[\s\S]*git checkout -f -B data origin/data', body) is not None and 'git push origin gh-pages' not in body[i_slice:])
ok('①e 切片器先 cp 到暫存再跑,而且跑之前 node --check(複製完不能用要直接紅燈)',
   re.search(r'git show origin/main:scripts/fin_slice\.mjs > /tmp/fin_slice\.mjs[\s\S]*node --check /tmp/fin_slice\.mjs', body[i_slice:]) is not None)
ok('①f 有「<500 檔拒絕推送」守門', re.search(r'-ge 500', body[i_slice:]) is not None)


def extract_run(text, name):
    m = re.search(r'- name: ' + re.escape(name) + r'[^\n]*\n(?:\s+if:[^\n]*\n)?\s+run: \|\n((?:[ ]{10}[^\n]*\n|\n)+)', text)
    if not m:
        return None
    return '\n'.join(l[10:] if l.startswith(' ' * 10) else l for l in m.group(1).split('\n'))


script = extract_run(body, '✂️ 每檔切片')
ok('②a 抽得出那段 run 腳本', script is not None and 'fin_slice' in script)
if script is None:
    print(f'\n❌ {len(FAILS)} 條失敗'); sys.exit(1)

# ── ② 功能:開真的 git repo 實跑 ─────────────────────────────────
tmp = tempfile.mkdtemp(prefix='finrelay_')
try:
    origin = os.path.join(tmp, 'origin.git')
    sh(f'git init -q --bare "{origin}"')
    seed = os.path.join(tmp, 'seed'); os.makedirs(os.path.join(seed, 'scripts'))
    for f in ('fin_slice.mjs', 'lib_fundamentals.mjs'):
        shutil.copy(os.path.join(ROOT, 'scripts', f), os.path.join(seed, 'scripts', f))
    sh('git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -qm main && git push -q "%s" main' % origin, cwd=seed)
    # data 分支(orphan):一些 K 線檔
    os.makedirs(os.path.join(seed, 'data'))
    for s in ('1101', '2330', '2327'):
        open(os.path.join(seed, 'data', f'{s}.json'), 'w').write('[]')
    sh(f'git checkout -q --orphan data && git rm -rq --cached . && git add -f data && git commit -qm data && git push -q "{origin}" data', cwd=seed)
    # 合成 fin_deep.json(600 檔 × 8 季,ocf 累計)
    FIELDS = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps']
    Q = [f'{y}-{m}' for y in (2024, 2025) for m in ('03-31', '06-30', '09-30', '12-31')]
    cum = {'ocf': [10, 25, 45, 70], 'capex': [-4, -9, -15, -22], 'dep': [2, 4, 6, 8]}
    S = {}
    for n in range(600):
        sym = str(1000 + n)
        S[sym] = {q: [150, 100, cum['capex'][i % 4], cum['dep'][i % 4], cum['ocf'][i % 4], 200, 1000, 1e9, 1.0] for i, q in enumerate(Q)}
    fin = {'q': Q, 'f': FIELDS, 's': S, 'meta': {'updated': '2026-09-07', 'n': 600, 'quarters': 8, 'src': 'test'}}
    work = os.path.join(tmp, 'work')
    sh(f'git clone -q -b main "{origin}" "{work}"')
    sh('git config user.email t@t && git config user.name t', cwd=work)
    os.makedirs(os.path.join(work, 'fin_deep'))
    json.dump(fin, open(os.path.join(work, 'fin_deep', 'fin_deep.json'), 'w'))
    # 模擬上一步(🚀)留下的狀態:orphan 分支 _fin_deploy 只含 fin_deep/
    sh('git checkout -q --orphan _fin_deploy && git rm -rfq --cached . && git add -f fin_deep/ && git commit -qm fin', cwd=work)
    tmpio = os.path.join(tmp, 'io')
    os.makedirs(tmpio)
    run_script = script.replace('/tmp/', tmpio + '/')
    r = sh(run_script, cwd=work, check=False, env=dict(os.environ, GIT_TERMINAL_PROMPT='0'))
    ok('②b 腳本跑得完(rc=0)', r.returncode == 0, (r.stdout + r.stderr)[-600:])
    ok('②c log 寫「已推上 data 分支」', '已推上 data 分支' in r.stdout, r.stdout[-300:])
    lst = sh(f'git --git-dir="{origin}" ls-tree -r --name-only data', check=False).stdout.split()
    got = [p for p in lst if p.startswith('data/fin/')]
    ok('②d ⭐ origin 的 data 分支有 data/fin/*.json(600 檔)', len(got) == 600, f'{len(got)} 檔:{got[:3]}')
    ok('②e 原本的 K 線檔還在(⛔ 不可把別人的 data/ 洗掉)', 'data/2330.json' in lst, str(lst[:5]))
    one = json.loads(sh(f'git --git-dir="{origin}" show data:data/fin/1000.json').stdout)
    ok('②f 切片內容是**單季**(Q4 ocf = 70 − 45 = 25)且標 cum_fixed', any(x['p'] == '2025-12-31' and x['ocf'] == 25 for x in one['q']) and 'ocf' in one['cum_fixed'], json.dumps(one)[:200])
    # ⭐ 模擬 daily_miner 鋪底層:git archive origin/data → 工作區 data/ 要看得到切片
    dep = os.path.join(tmp, 'deploy'); os.makedirs(dep)
    sh(f'git --git-dir="{origin}" archive data | tar -x -C "{dep}"')
    ok('②g ⭐⭐ 模擬 daily_miner `git archive origin/data` 鋪底層 → data/fin/1000.json 在工作區(= 會跟著上 gh-pages)', os.path.exists(os.path.join(dep, 'data', 'fin', '1000.json')))
    # 🚨 決定性對照組:同一批切片只推 fin_deep 分支(原本的設計)→ 鋪底層看不到
    ctl = os.path.join(tmp, 'ctl'); sh(f'git clone -q -b main "{origin}" "{ctl}"'); sh('git config user.email t@t && git config user.name t', cwd=ctl)
    os.makedirs(os.path.join(ctl, 'fin_deep', 'fin'))
    for f in os.listdir(os.path.join(tmpio, 'fin_out'))[:5]:
        shutil.copy(os.path.join(tmpio, 'fin_out', f), os.path.join(ctl, 'fin_deep', 'fin', f))
    sh(f'git checkout -q --orphan _ctl && git rm -rfq --cached . && git add -f fin_deep/ && git commit -qm ctl && git push -q "{origin}" HEAD:fin_deep', cwd=ctl)
    dep2 = os.path.join(tmp, 'deploy2'); os.makedirs(dep2)
    sh(f'git --git-dir="{origin}" archive fin_deep | tar -x -C "{dep2}"')
    sh(f'git --git-dir="{origin}" archive data data/2330.json | tar -x -C "{dep2}"')
    ok('②h 🚨 對照組:只推 fin_deep 分支 → 鋪底層(archive data)看不到切片(這就是為什麼要推 data 分支)',
       os.path.exists(os.path.join(dep2, 'fin_deep', 'fin')) and not os.path.exists(os.path.join(dep2, 'data', 'fin')))
    # 冪等:再跑一次要說「沒東西可推」而不是失敗
    #   ⚠️ 上一輪 `checkout -f -B data` 會把 orphan 分支上**已提交**的 fin_deep/ 收走(真 workflow 一輪只跑一次,沒差)→ 測試自己補回來
    os.makedirs(os.path.join(work, 'fin_deep'), exist_ok=True)
    json.dump(fin, open(os.path.join(work, 'fin_deep', 'fin_deep.json'), 'w'))
    sh('git checkout -q --detach && git checkout -q --orphan _fin_deploy2 && git rm -rfq --cached . && git add -f fin_deep/ && git commit -qm fin2', cwd=work, check=False)
    r2 = sh(run_script, cwd=work, check=False, env=dict(os.environ, GIT_TERMINAL_PROMPT='0'))
    ok('②i 再跑一次(內容沒變)→ rc=0 且寫「沒東西可推」', r2.returncode == 0 and '沒東西可推' in r2.stdout, (r2.stdout + r2.stderr)[-300:])
    # <500 檔守門
    small = dict(fin); small['s'] = {k: v for k, v in list(S.items())[:100]}; small['meta'] = dict(fin['meta'], n=100)
    os.makedirs(os.path.join(work, 'fin_deep'), exist_ok=True)
    json.dump(small, open(os.path.join(work, 'fin_deep', 'fin_deep.json'), 'w'))
    r3 = sh(run_script, cwd=work, check=False, env=dict(os.environ, GIT_TERMINAL_PROMPT='0'))
    ok('②j 只有 100 檔 → 拒絕推送(rc≠0),⛔ 不可用半份覆蓋', r3.returncode != 0, (r3.stdout + r3.stderr)[-200:])
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(('\n❌ %d 條失敗:%s' % (len(FAILS), ' / '.join(FAILS))) if FAILS else '\n✅ test_fin_relay 全過')
sys.exit(1 if FAILS else 0)
