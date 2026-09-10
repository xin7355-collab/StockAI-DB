#!/usr/bin/env python3
"""🛟 盤中即時檔「留不留得住」的守門(2026-09-10 新增)

⛔ 為什麼要有這支:`live_quotes.json` / `live_index.json` 從上線起就**留不住** ——
   `daily_miner` 用 orphan force-push 蓋 gh-pages,內容**全部來自工作區的 `data/`**
   (而工作區的 `data/` 來自 `git archive origin/data`)
   → **只要一個檔不在 data 分支,每一輪 daily_miner 都會讓它從 gh-pages 消失**。
   實測(2026-09-09):live_snapshot run #97 的 log 逐字「✅ push 成功」共 4 次,
   隔天 gh-pages 與 data **兩邊都查不到** —— 中間只發生了 3 輪 daily_miner。
   ⚠️ 零錯誤訊息:兩支 workflow 全綠、log 都寫「部署成功」,而兩個分支都是 orphan
   → git 歷史上完全看不出被吃掉(同陷阱 #41)。

⭐ 這支**開真的 git repo 實跑 yaml 裡抽出來的 `deploy()`**(⛔ 測試裡不複製一份邏輯),
   而且有**決定性的對照組**:同一個劇本用「沒推 data 分支」的版本跑一次,
   必須重現「洗版後消失」——⛔ 沒有那一格,這支測試跟沒寫一樣
   (它會變成「不管怎麼改都綠」的假綠燈,同 test_deploy_relay 學到的那條)。

跑法:python3 scripts/test_intraday_relay.py
"""
import os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WFS = {
    'live_snapshot': os.path.join(ROOT, '.github/workflows/live_snapshot.yml'),
    'tick_flow':     os.path.join(ROOT, '.github/workflows/tick_flow.yml'),
}
FAILS = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + (f'  {extra}' if extra and not cond else ''))
    if not cond:
        FAILS.append(name)


def sh(cmd, cwd=None, check=True):
    r = subprocess.run(['bash', '-c', cmd], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


# ── ① 靜態:兩支盤中 workflow 都要有 data 分支同步 ─────────────────
#    ⭐ 用迴圈一次釘兩支 —— ⛔ 只釘新改的那支,正是當初 V69.8.4 只修 tick_flow 的重演(陷阱 #37)
for k, path in WFS.items():
    body = open(path, encoding='utf-8').read()
    has = re.search(r'git\s+checkout\s+-f\s+-B\s+data\s+origin/data', body)
    ok(f'①a {k} 有「也推 data 分支」那段(⛔ 沒有的話 daily_miner 每輪抹掉它)', bool(has))
    if has:
        i_ghp = body.find('git push origin gh-pages')
        i_dat = has.start()
        ok(f'①b {k} data 同步排在 gh-pages push **之後**(排前面會推到還沒更新的內容)',
           0 <= i_ghp < i_dat, f'ghp@{i_ghp} data@{i_dat}')

# ⛔ gh-pages 的 retry 迴圈裡不可再有早退的 return —— 早退等於 data 那段永遠走不到,
#    而且完全沒有錯誤訊息(這是本專案最常見的「安靜地沒作用」形式)
for k, path in WFS.items():
    body = open(path, encoding='utf-8').read()
    m = re.search(r'git push origin gh-pages[^\n]*\n', body)
    ok(f'①c {k} gh-pages push 成功後⛔ 不可直接 `return 0`(要 break 才走得到 data 那段)',
       bool(m) and 'return 0' not in m.group(0), (m.group(0).strip() if m else '找不到'))


# ── ② 功能:開真的 git repo 實跑 deploy(),並用「舊版」當對照組 ────
def extract_deploy(src_text):
    m = re.search(r'\n( {10})deploy\(\) \{\n.*?\n {10}\}\n', src_text, re.S)
    if not m:
        return None
    return '\n'.join(l[10:] if l.startswith(' ' * 10) else l for l in m.group(0).split('\n'))


def build_repo(base):
    """建一個有 main / gh-pages / data 三分支的 repo(後兩者都是 orphan,跟正式環境一樣)"""
    rem, wrk = os.path.join(base, 'remote.git'), os.path.join(base, 'w')
    sh(f'git init -q --bare {rem}')
    sh(f'git clone -q {rem} {wrk}', check=False)
    g = f'cd {wrk} && git config user.email t@t && git config user.name t'
    sh(f'{g} && mkdir -p scripts data && echo x > live_snapshot_miner.py && echo w > scripts/win.py '
       f'&& git add -A && git commit -qm main && git branch -M main && git push -q origin main')
    for b in ('gh-pages', 'data'):
        sh(f'{g} && git checkout -q --orphan {b} && (git rm -rq --cached . 2>/dev/null || true) && rm -rf scripts live_snapshot_miner.py '
           f'&& mkdir -p data && echo \'{{"u":"seed"}}\' > data/other.json '
           f'&& git add -A -f && git commit -qm {b} && git push -q origin {b}')
    sh(f'{g} && git checkout -q main')
    return rem, wrk


def run_ticks(wrk, deploy_src, tag):
    """跑兩拍盤中 + 一拍盤前(⭐ 第 2 拍是決定性的:證明第二輪還回得到主程式碼)"""
    dep = os.path.join(os.path.dirname(wrk), f'dep_{tag}.sh')
    open(dep, 'w').write(deploy_src)
    script = f'''
set -u; cd {wrk}; git config user.email t@t; git config user.name t
source {dep}
BASE=$(git rev-parse HEAD)
for t in T1 T2; do
  git checkout -f -q "$BASE" || {{ echo "REGRESS_no_main_code"; exit 9; }}
  rm -f live_quotes.json live_index.json
  [ -f live_snapshot_miner.py ] || {{ echo "REGRESS_no_miner"; exit 9; }}
  echo "{{\\"updated\\":\\"$t\\"}}" > live_quotes.json
  deploy || {{ echo "REGRESS_deploy_rc"; exit 9; }}
done
git checkout -f -q "$BASE"; rm -f live_quotes.json live_index.json
echo '{{"updated":"T3"}}' > live_index.json
deploy || {{ echo "REGRESS_deploy_rc"; exit 9; }}
'''
    return sh(script, check=False)


def simulate_daily_miner(base, rem, tag):
    """正式環境的收尾:git archive origin/data 鋪底層 → orphan force-push gh-pages"""
    dm = os.path.join(base, f'dm_{tag}')
    sh(f'git clone -q --depth=1 {rem} {dm}', check=False)
    sh(f'cd {dm} && git config user.email t@t && git config user.name t '
       f'&& git fetch -q origin data --depth=1 && rm -rf data && mkdir -p data '
       f'&& (git archive FETCH_HEAD data 2>/dev/null | tar -x || true) '
       f'&& echo \'{{"k":1}}\' > data/2330.json '
       f'&& git checkout -q --orphan ghp && (git rm -rq --cached . 2>/dev/null || true) '
       f'&& git add -A -f && git commit -qm dm && git push -qf origin ghp:gh-pages')


def survives(wrk, fname):
    sh(f'cd {wrk} && git fetch -q origin gh-pages', check=False)
    r = sh(f'cd {wrk} && git show origin/gh-pages:data/{fname} 2>/dev/null', check=False)
    return r.returncode == 0 and 'updated' in r.stdout


cur = extract_deploy(open(WFS['live_snapshot'], encoding='utf-8').read())
ok('② 抽得到 live_snapshot 的 deploy() 本體', bool(cur))

if cur:
    base = tempfile.mkdtemp(prefix='lsrelay_')
    try:
        rem, wrk = build_repo(base)
        r = run_ticks(wrk, cur, 'new')
        ok('②a 三拍都跑得完(⭐ 第 2 拍證明「回到主程式碼」那行仍有效)',
           r.returncode == 0 and 'REGRESS' not in r.stdout, r.stdout[-300:] + r.stderr[-300:])
        ok('②b 盤中與盤前寫到**不同檔名**(⛔ 盤前那輪不可覆蓋盤中快照)',
           survives(wrk, 'live_quotes.json') and survives(wrk, 'live_index.json'))
        simulate_daily_miner(base, rem, 'new')
        ok('②c ⭐⭐ daily_miner orphan force-push 之後 live_quotes 仍在 gh-pages(這就是要修的那件事)',
           survives(wrk, 'live_quotes.json'))
        ok('②c2 live_index 也留得住', survives(wrk, 'live_index.json'))
    finally:
        shutil.rmtree(base, ignore_errors=True)

    # ⭐⭐ 決定性的對照組:把 data 同步整段拿掉,必須重現「洗版後消失」。
    #    ⛔ 沒有這一格,②c 可能只是因為模擬沒生效而恆綠 = 假綠燈。
    # ⚠️ 這裡踩過一次:第一版用 regex 抓到 `\n *fi\n` 就停,而那段裡面**還有一個內層 `fi`**
    #    → 切在中間、留下懸空的 else/fi = **語法壞掉的腳本**,不是「舊版」。
    #    而當時的 ③ 只檢查「字串不見了 + 變短了」,照樣綠 → 對照組整個失去意義。
    #    ⭐ 通用:注入驗證除了確認「有注進去」,還要確認**注完的東西仍然是可執行的**。
    lines = cur.split('\n')
    i0 = next((i for i, l in enumerate(lines) if '🩹 **也推 data 分支**' in l), None)
    i1 = next((i for i, l in enumerate(lines) if i0 is not None and i > i0 and l.strip() == 'return 0'), None)
    old = '\n'.join(lines[:i0] + lines[i1:]) if (i0 is not None and i1 is not None) else cur
    ok('③ 對照組腳本真的被改掉了(⛔ 注入沒注進去的話下面那條會誤導)',
       'checkout -f -B data origin/data' not in old and len(old) < len(cur))
    _syn = subprocess.run(['bash', '-n'], input=old, capture_output=True, text=True)
    ok('③0 ⭐ 對照組腳本**語法仍然合法**(⛔ 切壞的腳本不是「舊版」,那會讓對照組失去意義)',
       _syn.returncode == 0, _syn.stderr[-200:])
    base2 = tempfile.mkdtemp(prefix='lsrelay_ctl_')
    try:
        rem2, wrk2 = build_repo(base2)
        run_ticks(wrk2, old, 'old')
        before = survives(wrk2, 'live_quotes.json')
        simulate_daily_miner(base2, rem2, 'old')
        after = survives(wrk2, 'live_quotes.json')
        ok('③a 對照組:沒推 data 時 gh-pages 上**本來有**(證明它有跑到)', before)
        ok('③b ⭐⭐ 對照組:洗版之後**必須消失** —— 沒消失代表這支測試沒有鑑別力',
           before and not after, f'before={before} after={after}')
    finally:
        shutil.rmtree(base2, ignore_errors=True)


# ── ④ Cloudflare Worker → repository_dispatch 的接線(2026-09-10)────────
#   ⛔ 為什麼要釘:GitHub 的 schedule 在這個 repo 實測遲到 4.5~5 小時、常常整天不進來,
#   所以盤中主迴圈改由 Worker 的 cron 用 `repository_dispatch` 叫起來。
#   🚨 **事件名差一個字就永遠不會觸發,而且兩邊都零訊息** —— 跟 workflow_run 的 host 名字同一種坑。
WORKER = os.path.join(ROOT, 'cloud-worker/worker.js')
if not os.path.exists(WORKER):
    ok('④ 找得到 cloud-worker/worker.js', False)
else:
    wsrc = open(WORKER, encoding='utf-8').read()
    sent = set(re.findall(r"ghDispatch\(env,\s*'([^']+)'\)", wsrc))
    recv = {}
    for k, path in WFS.items():
        for m in re.finditer(r'repository_dispatch:\s*\n\s*types:\s*\[([^\]]+)\]', open(path, encoding='utf-8').read()):
            for ev in m.group(1).split(','):
                recv[ev.strip()] = k
    ok('④a Worker 真的會發 repository_dispatch', bool(sent), sorted(sent))
    # ⭐ **雙向**都要比:發了沒人收 = 白發;收了沒人發 = 永遠不觸發。⛔ 只比一邊抓不到打錯字。
    ok('④b ⭐⭐ Worker 發的每個事件名都有 workflow 接(⛔ 差一字永遠不觸發且零訊息)',
       sent and sent <= set(recv), f'發 {sorted(sent)} / 收 {sorted(recv)}')
    ok('④b2 workflow 收的每個事件名都真的有人發', set(recv) and set(recv) <= sent,
       f'收 {sorted(recv)} / 發 {sorted(sent)}')
    # ⛔ cron 一行都不刪 —— Worker 掛掉時它是唯一的備援(同 workflow_run 那條設計)
    for k, path in WFS.items():
        ok(f'④c {k} 的 cron ⛔ 沒被刪掉(Worker 掛掉時的備援)',
           bool(re.search(r'^\s+- cron:', open(path, encoding='utf-8').read(), re.M)))
    # 🚨 看門狗不可以無條件發 —— live_snapshot 是 cancel-in-progress: true,
    #    每輪都發會一直砍掉自己的主迴圈(把一種 starvation 換成另一種)
    ok('④d 🚨 看門狗有「太久沒更新才發」的判斷(⛔ 無條件發會一直砍掉主迴圈)',
       'staleMin' in wsrc and re.search(r'if \(stale\)\s*await ghDispatch', wsrc) is not None)
    # 🔐 金鑰只能進 Authorization header —— ⛔ 不可進 URL、不可被印出來
    tokline = [l for l in wsrc.split('\n') if 'GH_DISPATCH_TOKEN' in l]
    ok('④e 🔐 金鑰⛔ 不可出現在網址裡', not any(('http' in l and '?' in l) for l in tokline), tokline[:3])
    ok('④e2 🔐 金鑰⛔ 不可被 console/訊息印出來',
       not any(re.search(r'(console\.|tg\(|JSON\.stringify)', l) for l in tokline), tokline[:3])

# ── ⑤ ⛔ 驗 worker.js 語法要用 .mjs —— `node --check` 對 .js 沒有鑑別力 ────
#   🚨 實測(2026-09-10):把 `const __X = 1;` 插進 `export default {}` 的物件字面量裡,
#   `node --check cloud-worker/worker.js` **照樣 rc=0 放行**(package.json 沒有 "type":"module",
#   node 用 CJS 解析)→ 我差點把語法壞掉的 Worker 推上去。複製成 .mjs 才驗得到。
if os.path.exists(WORKER):
    tmpd = tempfile.mkdtemp(prefix='wchk_')
    try:
        mj = os.path.join(tmpd, 'w.mjs')
        shutil.copyfile(WORKER, mj)
        r = subprocess.run(['node', '--check', mj], capture_output=True, text=True)
        ok('⑤a worker.js 語法合法(⛔ 用 .mjs 驗 —— .js 走 CJS 解析沒有鑑別力)',
           r.returncode == 0, r.stderr[-300:])
        # ⭐ 自我驗證:注入一個明確的語法錯,這個檢查法必須抓得到(⛔ 否則它跟沒驗一樣)
        bad = os.path.join(tmpd, 'bad.mjs')
        src = open(WORKER, encoding='utf-8').read().replace(
            '    async scheduled(event, env, ctx) {', 'const __INJ = 1;\n    async scheduled(event, env, ctx) {', 1)
        open(bad, 'w', encoding='utf-8').write(src)
        r2 = subprocess.run(['node', '--check', bad], capture_output=True, text=True)
        ok('⑤b ⭐ 注入語法錯時這個檢查法真的叫得出來(⛔ 沒有這條就不知道它有沒有在驗)',
           r2.returncode != 0)
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)

print()
if FAILS:
    print('❌ INTRADAY_RELAY_FAIL:', FAILS)
    sys.exit(1)
print('✅ INTRADAY_RELAY_PASS')
