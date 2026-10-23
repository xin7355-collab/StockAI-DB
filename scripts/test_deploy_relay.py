"""
🛟 daily_miner 部署窗口「撿回」守門

🚨 為什麼要有這支(2026-09-09 實測抓到):
   daily_miner 的 deploy job 在**開頭**用 `git archive origin/data` 抓快照,跑 20~25 分鐘,
   最後 **orphan force-push** gh-pages 與 data。
   → 任何別支 workflow 在這段窗口內 push 上去的產物會被**無聲丟掉**
     (兩邊 log 都寫「部署成功」、兩個分支都是 orphan → git 歷史看不出被吃掉)。
   實例:22:04 抓快照 → 22:22 pe_band push 成功 → 22:28 force-push → `pe_band.json` 停在 08-14 一個月。

🚨🚨 **第一版用 mtime 判準,實測整個失效**(2026-09-10,陷阱 #40 第三次):
   `mine-data-*` artifact 的 path 是 **`data/`(整個目錄)**,而每個 batch job 開頭都會
   `git archive origin/data | tar -x` 還原整個 data/;「修剪 artifact」只修剪**股票 K 線檔**,
   `pe_band.json` 這種非股票檔會原封不動跟著 artifact 回來 → download-artifact 疊上去,
   **mtime 變成下載時間** → 全部被誤判成「本輪自己產的」。
   實測 log:「本輪自己產出 **5521** 檔 ・沒變動 **0** 檔」= `cmp` 那行一次都沒被執行到。
   ⛔ 而且 K=0 時「窗口內沒人推東西」跟「判斷式失效」**長得一模一樣** —— 最危險的那種。
   → 判準改成**內容指紋三方比對**,對「用同樣的舊內容覆蓋」免疫。

⛔ 這支釘住四件事:
  ① 基準指紋在「鋪設底層資料」那步裡算(⛔ 不可搬到 download-artifact 之後)
  ② 「🛟 撿回」那步存在,且**排在兩個 push 之前**(排後面等於沒接上,同陷阱 #34)
  ③ ⭐ **功能測試**:開真的 git repo 實跑 yaml 裡**那段原始腳本**,而且**必須重現
     「artifact 用相同舊內容覆蓋」那一格** —— 那正是打死第一版的情境
     (⛔ 測試裡不複製一份邏輯,那會變成第二份真相)
  ④ ⛔ 判準不可退回 mtime,也不可用 `git diff BASE_SHA`(shallow 拿不到舊物件)

🚨 空過守門:若一個 Skill/腳本片段都沒抽到 → exit 1
   (這支工具最大的風險是「輸出看起來乾淨,其實根本沒驗到」)
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
YML = ROOT / '.github/workflows/daily_miner.yml'
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  {str(extra)[:300]}'))
    if not cond:
        fails.append(name)


def sh(cmd, cwd=None, env=None, check=True):
    e = dict(os.environ)
    e.setdefault('GIT_AUTHOR_NAME', 'T'); e.setdefault('GIT_AUTHOR_EMAIL', 't@t')
    e.setdefault('GIT_COMMITTER_NAME', 'T'); e.setdefault('GIT_COMMITTER_EMAIL', 't@t')
    if env:
        e.update(env)
    r = subprocess.run(cmd, shell=True, cwd=cwd, env=e, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


text = YML.read_text()
lines = text.split('\n')


def line_of(needle):
    for i, l in enumerate(lines, 1):
        if needle in l:
            return i
    return -1


# ── ① 基準指紋的位置 ─────────────────────────────────────────
l_base = line_of('/tmp/base_md5.json')
l_floor = line_of('🗄️ 鋪設底層資料')
l_artifact = line_of('📥 下載並自動合併')
ok('① 有算「基準指紋」(/tmp/base_md5.json)', l_base > 0)
ok('① 基準指紋在「鋪設底層資料」那步裡(⛔ 不可搬到 artifact 疊加之後)',
   0 < l_floor < l_base < l_artifact, f'floor={l_floor} base={l_base} artifact={l_artifact}')

# ── ② 撿回步驟的位置 ─────────────────────────────────────────
l_relay = line_of('🛟 撿回部署窗口內別支推上來的新檔')
l_ghp = line_of('📡 部署所有資料到 gh-pages')
l_data = line_of('📤 推送到獨立 data 分支')
ok('② 有「🛟 撿回」那一步', l_relay > 0)
ok('② ⭐ 撿回必須排在 gh-pages 部署**之前**(排後面等於沒接上)',
   0 < l_relay < l_ghp, f'relay={l_relay} ghpages={l_ghp}')
ok('② 撿回也必須排在 data 分支推送之前', 0 < l_relay < l_data, f'relay={l_relay} data={l_data}')

# ── ④ 判準 ──────────────────────────────────────────────────
body = []
if l_relay > 0:
    i = l_relay
    while i < len(lines) and not re.match(r'^      - name:', lines[i]):
        body.append(lines[i])
        i += 1
RELAY = '\n'.join(body)
run_body = RELAY.split('run: |', 1)[1] if 'run: |' in RELAY else ''
SCRIPT = '\n'.join(l[10:] if l.startswith(' ' * 10) else l for l in run_body.split('\n')).strip('\n')
# ⚠️ 只看**實際指令**,⛔ 不看註解 —— 註解裡本來就寫著「⛔ 不用 mtime / git diff」,
#    連註解一起掃會被自己的說明文字誤報(第一次跑就踩到)。
CODE = '\n'.join(l for l in SCRIPT.split('\n') if not l.lstrip().startswith('#'))

ok('④ 撿回腳本抽得出來(≥ 25 行,否則是抽取器壞了)', len(SCRIPT.split('\n')) >= 25,
   f'{len(SCRIPT.split(chr(10)))} 行')
ok('④ ⛔ 判準不可退回 mtime(`-nt`/base.stamp)—— artifact 疊加會把 mtime 全部弄新',
   '-nt ' not in CODE and 'base.stamp' not in CODE)
ok('④ ⛔ 判準不可用 `git diff <SHA> origin/data`(shallow 在雲端拿不到舊物件,陷阱 #40)',
   'git diff' not in CODE and 'BASE_SHA' not in CODE)
ok('④ 判準要讀基準指紋 /tmp/base_md5.json', 'base_md5.json' in CODE)
ok('④ 要有「基準不可信就略過」的空過守門', 'len(base) < 100' in CODE or 'len(base)<100' in CODE)
ok('④ 要印出撿回幾檔(⛔ 靜默 = 看不出有沒有在工作)', '撿回別支的' in CODE)

# ── ③ ⭐ 功能測試:開真的 git repo 實跑 yaml 裡那段原始腳本 ──
# ⚠️ 跑**兩種 clone 形態**(陷阱 #40:測試環境跟正式環境不一樣 = 假綠燈):
#    甲 refspec 完整 → `origin/data` 建得起來
#    乙 single-branch(shallow clone 的預設)→ `origin/data` **建不起來**,必須靠 FETCH_HEAD 備援
#    ⭐ 乙是本機第一次實跑當場踩到的,⛔ 別拿掉。
def run_case(single_branch: bool):
    label = '乙 single-branch(⛔ 沒有 origin/data)' if single_branch else '甲 refspec 完整'
    tmp = tempfile.mkdtemp(prefix='relay_')
    try:
        origin = Path(tmp) / 'origin.git'
        seed = Path(tmp) / 'seed'
        work = Path(tmp) / 'work'
        sh(f'git init --bare -q -b main "{origin}"')
        sh(f'git init -q -b main "{seed}"')
        (seed / 'README.md').write_text('x')
        sh('git add -A && git commit -qm main', cwd=seed)
        sh(f'git remote add origin "{origin}" && git push -q origin main', cwd=seed)

        # data 分支:三個檔 + 一個「別支之後才會新增」的情境
        sh('git checkout -q --orphan data && git rm -rq --cached . 2>/dev/null || true', cwd=seed)
        (seed / 'data').mkdir(exist_ok=True)
        for n, v in (('A', 'old-A'), ('B', 'old-B'), ('C', 'old-C'), ('E', 'old-E')):
            (seed / 'data' / f'{n}.json').write_text(f'{{"v":"{v}"}}')
        # ⚠️ 撿回腳本有「基準 < 100 檔就不可信 → 略過」的空過守門(正式環境 5,521 檔)。
        #    3 個檔的測資會觸發它 → 測資補到 120 檔,讓測試環境貼近正式環境(陷阱 #40)。
        #    ⛔ 不可反過來把守門的門檻調鬆去遷就測試。
        for i in range(117):
            (seed / 'data' / f'F{i:03d}.json').write_text(f'{{"v":"fill-{i}"}}')
        sh('git add -A && git commit -qm data && git push -q origin data', cwd=seed)

        # 模擬 daily_miner 的 deploy job:checkout main
        flag = '--depth=1' if single_branch else '--no-single-branch'
        sh(f'git clone -q {flag} -b main "{origin}" "{work}"')
        sh('git fetch origin data --depth=1', cwd=work)
        has_ref = sh('git rev-parse --verify -q origin/data', cwd=work, check=False).returncode == 0
        ok(f'③{label} clone 形態如預期(origin/data {"不存在" if single_branch else "存在"})',
           has_ref != single_branch, f'has_ref={has_ref}')

        # 鋪底層(用 FETCH_HEAD,兩種形態都通)
        sh('git archive FETCH_HEAD data | tar -x -C .', cwd=work)
        # ⭐ 分界線:算基準指紋(跟 yaml 那步同一套做法)
        sh("""python3 -c "
import hashlib,json,os
base={}
for root,_,files in os.walk('data'):
    for fn in files:
        if not fn.endswith('.json'): continue
        p=os.path.join(root,fn); h=hashlib.md5()
        with open(p,'rb') as f:
            for c in iter(lambda: f.read(1<<20), b''): h.update(c)
        base[p]=h.hexdigest()
json.dump(base, open('/tmp/base_md5.json','w'))
print(len(base))
" """, cwd=work)

        # 🚨🚨 決定性的一格:模擬 `download-artifact` 把整個 data/ 疊上去
        #     —— 內容**一模一樣**(來自同一份 origin/data 快照),但 **mtime 全部變新**。
        #     這正是打死第一版 mtime 判準的情境(實測 log:5521 全 kept、same=0)。
        time.sleep(1.1)
        for p in sorted((work / 'data').glob('*.json')):
            p.write_text(p.read_text())             # 內容不變、mtime 變新(整個 data/ 都疊)

        # 本輪 daily_miner 真的產出:改 A(遠端不會動它)與 E(遠端也會動 → 真正的衝突)
        (work / 'data' / 'A.json').write_text('{"v":"NEW-by-daily_miner"}')
        (work / 'data' / 'E.json').write_text('{"v":"NEW-by-daily_miner-E"}')

        # 別支 workflow 在窗口內推了 B(模擬 pe_band)+ 新增一個 D
        sh('git checkout -q data', cwd=seed)
        (seed / 'data' / 'B.json').write_text('{"v":"NEW-by-other-workflow"}')
        (seed / 'data' / 'D.json').write_text('{"v":"NEW-file-by-other"}')
        (seed / 'data' / 'E.json').write_text('{"v":"NEW-by-other-E"}')   # ← 跟本輪撞同一檔
        sh('git add -A && git commit -qm other && git push -q origin data', cwd=seed)

        # ⭐ 實跑 yaml 裡那段原始腳本(⛔ 測試裡不複製一份邏輯)
        script = Path(tmp) / 'relay.sh'
        script.write_text('set -e\n' + SCRIPT + '\n')
        r = sh(f'bash "{script}"', cwd=work, check=False)
        out = r.stdout + r.stderr
        ok(f'③{label} 撿回腳本跑得起來(rc=0)', r.returncode == 0, out[-500:])

        a = (work / 'data' / 'A.json').read_text()
        b = (work / 'data' / 'B.json').read_text()
        c = (work / 'data' / 'C.json').read_text()
        d = (work / 'data' / 'D.json').read_text() if (work / 'data' / 'D.json').exists() else '(不存在)'
        ok(f'③{label} ⭐ 本輪 daily_miner 產的 A ⛔ 不可被遠端舊版洗掉', 'NEW-by-daily_miner' in a, a)
        ok(f'③{label} 🚨 別支推的 B **要被撿回**(第一版就是死在這 —— artifact 疊加後 mtime 全新)',
           'NEW-by-other-workflow' in b, b)
        ok(f'③{label} 別支**新增**的 D 也要撿回', 'NEW-file-by-other' in d, d)
        ok(f'③{label} 被 artifact 用相同內容覆蓋、兩邊都沒真的動過的 C 保持不變', 'old-C' in c, c)
        ok(f'③{label} log 要說出撿回幾檔(2 檔:B + D)', '🛟 撿回別支的 2 檔' in out, out[-400:])
        ok(f'③{label} 基準指紋要涵蓋全部 121 檔', '比對基準 121 檔' in out, out[-400:])
        # ⚠️ 「遠端沒動」= relay 裡跟基準一模一樣的(A + C + 117 個填充 = 119)——
        #    A 雖然本輪改過,但**遠端沒動它** → 第一關就 same,⛔ 不會走到衝突那關。
        ok(f'③{label} 「遠端沒動」要算到 119 檔', '遠端沒動 119 檔' in out, out[-400:])
        # ⭐ 真正的衝突只有 E(本輪改了、遠端也改了)→ 本輪要贏
        e = (work / 'data' / 'E.json').read_text()
        ok(f'③{label} ⭐ 兩邊都改的 E → **本輪的贏**(⛔ 不可被遠端蓋掉)',
           'NEW-by-daily_miner-E' in e, e)
        ok(f'③{label} ⭐ 「本輪自己改過」要正確算到 E(=1)', '本輪自己改過 1 檔' in out, out[-400:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── ⑥ 部署 job 的時間預算(V79.5.5,10/22 #634 實測抓到)──────────────────
# 🚨 #634:合併那步 22 分 + 「今日訊號掃描」安裝瀏覽器卡 7 分 → 撞 30 分 job 時限
#    → 撿回 / 部署 / 推 data 三步全部沒跑(那一步寫著「不擋部署」,卻吃得掉整個 job 的時限)。
#    10/21 第二輪整個 job 26 分(DEPLOY_NORMAL)= 原本只剩 4 分餘裕。
#    ⭐ 使用者 10/22 選:訊號掃描自己最多 8 分 + job 時限 30 → 40。
#    ⏱️ V79.5.9:10/22 #637 整個 job 30.5 分(訊號掃描那步 7 分 25 秒 = 裝瀏覽器 5 分 39 秒 + 掃描 106 秒)
#      → 瀏覽器改在並行那步背景先裝(見 ⑦),掃描上限 8 → 10(沒裝好時要在這裡補裝);
#      DEPLOY_NORMAL 刻意留 26 不調低(搬走安裝之後平常約 23~25 分,留著當餘裕)。
DEPLOY_NORMAL = 26
SCAN_STEP = '🎯 今日實測訊號掃描(daily_signal_scan)'


def deploy_budget(txt):
    """回 (job 時限, {步驟名: (continue-on-error, 步驟時限)});只看 deploy job。"""
    i = txt.find('\n  deploy:\n')
    if i < 0:
        return None, {}
    blk = txt[i:]
    m = re.search(r'\n    timeout-minutes: (\d+)', blk)
    steps = {}
    pos = [mm.start() for mm in re.finditer(r'\n      - name: ', blk)]
    for k, st in enumerate(pos):
        seg = blk[st:pos[k + 1] if k + 1 < len(pos) else len(blk)]
        name = seg.split('\n')[1].replace('      - name: ', '').strip()
        tm = re.search(r'\n        timeout-minutes: (\d+)', seg)
        steps[name] = ('continue-on-error: true' in seg, int(tm.group(1)) if tm else None)
    return (int(m.group(1)) if m else None), steps


def budget_problems(txt):
    job_t, steps = deploy_budget(txt)
    bad = []
    if SCAN_STEP not in steps:
        return ['找不到訊號掃描那一步(名字改了?)']
    coe, st = steps[SCAN_STEP]
    if not coe:
        bad.append('訊號掃描要 continue-on-error(不擋部署)')
    if st is None or st > 10:
        bad.append(f'訊號掃描要有自己的時限且 ≤ 10 分(現在 {st})')
    if job_t is None:
        bad.append('deploy job 沒有 timeout-minutes')
    else:
        need = DEPLOY_NORMAL + (st or 0) + 4
        if job_t < need:
            bad.append(f'job 時限 {job_t} < 平常 {DEPLOY_NORMAL} + 掃描上限 {st} + 4 = {need}')
        if job_t > 60:
            bad.append(f'job 時限 {job_t} > 60(共用部署鎖,卡太久會擠掉排隊中的其他部署)')
    return bad


_jt, _steps = deploy_budget(text)
ok('⑥ 抽得到 deploy job 的步驟(≥ 15 步,否則是抽取器壞了)', len(_steps) >= 15, len(_steps))
_bp = budget_problems(text)
ok(f'⑥ ⭐ 部署 job 時間預算夠(job {_jt} 分・訊號掃描上限 {_steps.get(SCAN_STEP, (0, None))[1]} 分)', not _bp, _bp)
# 決定性對照(兩條規則各自叫得出來):
#   甲 拿掉訊號掃描自己的時限(= #634 那天)→ 紅
#   乙 job 時限退回 30(掃描照樣 8 分)→ 26 + 8 + 4 = 38 > 30 → 紅
_noscan = re.sub(r'(- name: ' + re.escape(SCAN_STEP) + r'\n(?:        [^\n]*\n)*?)        timeout-minutes: \d+\n', r'\1', text, count=1)
_job30 = re.sub(r'(\n  deploy:\n(?:.*\n)*?    timeout-minutes: )\d+', r'\g<1>30', text, count=1)
ok('⑥ 決定性對照甲:拿掉訊號掃描自己的時限 → 一定紅', _noscan != text and bool(budget_problems(_noscan)), budget_problems(_noscan))
ok('⑥ 決定性對照乙:job 時限退回 30 分 → 一定紅', _job30 != text and bool(budget_problems(_job30)), budget_problems(_job30))
_others = [n for n, (c, t) in _steps.items() if c and t is None and n != SCAN_STEP]
if _others:
    print(f"   ℹ️ 其他標了不擋部署、但沒有自己時限的步驟(目前沒卡過,先列出來):{', '.join(_others)}")


# ── ⑦ 瀏覽器先在「⚡ 並行跑」那步背景裝好,掃描那步裝好了就不重裝(V79.5.9)────────
# 🚨 10/22 #637:訊號掃描那步 7 分 25 秒 = 裝瀏覽器 5 分 39 秒 + 掃描 106 秒;playbook_scan 同一條只要 25 秒
#    → 時快時慢,慢的日子會撞掉掃描自己的時限。並行那步本身 16~22 分(#637 21.5 分)→ 藏進去。
# ⭐ 功能測試:把 yaml 裡兩段**原始 bash** 抽出來實跑(⛔ 測試裡不複製一份邏輯);
#    npm / npx / python / git 換成假的(記下誰在哪一步被叫),node 用**真的**(才驗得到 yaml 裡那段 JS),
#    playwright 換成一個只回「瀏覽器在哪」的假模組。
PAR_STEP = '⚡ 並行跑 7 個 deploy 階段腳本(平行宇宙第二層)'


def step_script(txt, name):
    """抽 deploy job 裡某一步 `run: |` 的內容(去掉 10 格縮排);抽不到回 ''。"""
    ls = txt.split('\n')
    st = next((i for i, l in enumerate(ls) if l.strip() == f'- name: {name}'), -1)
    if st < 0:
        return ''
    body, i = [], st + 1
    while i < len(ls) and not re.match(r'^      - name:', ls[i]):
        body.append(ls[i])
        i += 1
    blk = '\n'.join(body)
    if 'run: |' not in blk:
        return ''
    rb = blk.split('run: |', 1)[1]
    return '\n'.join(l[10:] if l.startswith(' ' * 10) else l for l in rb.split('\n')).strip('\n')


PAR_SH = step_script(text, PAR_STEP)
SCAN_SH = step_script(text, SCAN_STEP)
ok('⑦ 抽得到並行那步與訊號掃描那步的腳本', len(PAR_SH.split('\n')) >= 30 and len(SCAN_SH.split('\n')) >= 10,
   f'{len(PAR_SH.split(chr(10)))} / {len(SCAN_SH.split(chr(10)))} 行')
ok('⑦ 並行那步:背景裝瀏覽器而且有等它(`wait $PIDPW`)',
   'npx playwright install --with-deps chromium' in PAR_SH and 'pw.log 2>&1 &' in PAR_SH
   and 'PIDPW=$!' in PAR_SH and 'wait $PIDPW' in PAR_SH)


def pw_case(par_sh, scan_sh, npx_par=0, npx_scan=0, drop_browser=False, drop_log=False, strict=False):
    """實跑兩段;回 (並行那步 rc, 輸出, 掃描那步 rc, 輸出, 被叫的指令清單)。"""
    tmp = Path(tempfile.mkdtemp(prefix='pw_'))
    try:
        bindir, work, par = tmp / 'bin', tmp / 'work', tmp / 'parallel'
        calls, browser = tmp / 'calls.log', tmp / 'ms-playwright' / 'chrome'
        for d in (bindir, work / 'scripts', work / 'data'):
            d.mkdir(parents=True)

        def fake(name, body):
            f = bindir / name
            f.write_text('#!/bin/bash\n' + body + '\n')
            f.chmod(0o755)
        fake('python', f'echo "python $* [$PHASE]" >> "{calls}"; exit 0')
        fake('git', f'echo "git $* [$PHASE]" >> "{calls}"; exit 0')
        fake('npm', f'echo "npm $* [$PHASE]" >> "{calls}"; exit 0')
        # ⚠️ 假的 npx 故意慢 1 秒:沒有 `wait $PIDPW` 的話,並行那步會在它寫完 RC 之前就結束(決定性對照乙靠這個)
        fake('npx', f'echo "npx $* [$PHASE]" >> "{calls}"; sleep 1; '
                    f'if [ "${{NPX_RC:-0}}" = 0 ]; then mkdir -p "{browser.parent}"; touch "{browser}"; fi; exit ${{NPX_RC:-0}}')
        pm = work / 'node_modules' / 'playwright'
        pm.mkdir(parents=True)
        (pm / 'package.json').write_text('{"name":"playwright","main":"index.js"}')
        (pm / 'index.js').write_text('module.exports={chromium:{executablePath:()=>%s}};' % json.dumps(str(browser)))
        (work / 'scripts' / 'daily_signal_scan.mjs').write_text(
            "import fs from 'fs'; fs.writeFileSync('data/today_signals.json', '{\"bull\":[]}'); console.log('scan ok');\n")
        (tmp / 'par.sh').write_text(par_sh.replace('/tmp/parallel', str(par)) + '\n')
        (tmp / 'scan.sh').write_text(scan_sh.replace('/tmp/parallel', str(par)) + '\n')
        bash = ['bash', '--noprofile', '--norc', '-eo', 'pipefail'] if strict else ['bash', '-e']
        env = dict(os.environ, PATH=f'{bindir}:{os.environ.get("PATH", "")}', NODE_PATH='')
        r1 = subprocess.run(bash + [str(tmp / 'par.sh')], cwd=work, capture_output=True, text=True,
                            env=dict(env, PHASE='par', NPX_RC=str(npx_par)), timeout=60)
        time.sleep(1.5)   # 決定性對照乙(沒有 wait)時,讓背景那個先跑完再往下
        if drop_browser and browser.exists():
            browser.unlink()
        if drop_log and (par / 'pw.log').exists():
            (par / 'pw.log').unlink()
        r2 = subprocess.run(bash + [str(tmp / 'scan.sh')], cwd=work, capture_output=True, text=True,
                            env=dict(env, PHASE='scan', NPX_RC=str(npx_scan)), timeout=60)
        cl = calls.read_text().split('\n') if calls.exists() else []
        return r1.returncode, r1.stdout + r1.stderr, r2.returncode, r2.stdout + r2.stderr, cl
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _scan_installed(cl):
    return any(c.startswith(('npm ', 'npx ')) and c.endswith('[scan]') for c in cl)


if PAR_SH and SCAN_SH:
    # 甲 平常:背景裝好 → 掃描那步不重裝
    rc1, o1, rc2, o2, cl = pw_case(PAR_SH, SCAN_SH)
    ok('⑦甲 並行那步照常結束(rc 0)而且印「瀏覽器已先裝好」', rc1 == 0 and '瀏覽器已先裝好' in o1, o1[-300:])
    ok('⑦甲 安裝是在並行那步叫的(npm + npx 各一次)',
       sum(c.endswith('[par]') and c.startswith('npm ') for c in cl) == 1
       and sum(c.endswith('[par]') and c.startswith('npx ') for c in cl) == 1, cl)
    ok('⑦甲 ⭐ 掃描那步⛔ 不重裝(npm / npx 一次都沒叫)', not _scan_installed(cl) and '不重裝' in o2, (cl, o2[-300:]))
    ok('⑦甲 掃描照跑、印出安裝 / 掃描各幾秒', rc2 == 0 and 'scan ok' in o2 and '⏱️ 安裝' in o2 and 'today_signals.json' in o2, o2[-300:])
    # 甲' 同一段在 pipefail 下也要過(哪天 workflow 加了 `shell: bash` 就是這種跑法)
    rc1s, o1s, rc2s, o2s, cls = pw_case(PAR_SH, SCAN_SH, strict=True)
    ok("⑦甲' 開 pipefail 照樣兩步都過、掃描不重裝", rc1s == 0 and rc2s == 0 and not _scan_installed(cls), (o1s[-200:], o2s[-200:]))
    # 乙 背景那次裝失敗 → 並行那步⛔ 不可因此失敗;掃描那步自己補裝
    rc1, o1, rc2, o2, cl = pw_case(PAR_SH, SCAN_SH, npx_par=1)
    ok('⑦乙 背景安裝失敗 → 並行那步照樣 rc 0(⛔ 不擋部署)而且說出來', rc1 == 0 and '瀏覽器沒裝好' in o1, o1[-300:])
    ok('⑦乙 掃描那步自己補裝後照跑', _scan_installed(cl) and '這裡補裝' in o2 and 'scan ok' in o2, (cl, o2[-300:]))
    # 丙 RC=0 但瀏覽器不在(下載到一半被清掉之類)→ 補裝(驗 yaml 裡那段 JS 真的有在看檔案)
    rc1, o1, rc2, o2, cl = pw_case(PAR_SH, SCAN_SH, drop_browser=True)
    ok('⑦丙 RC=0 但瀏覽器檔案不在 → 掃描那步補裝', _scan_installed(cl) and 'scan ok' in o2, (cl, o2[-300:]))
    # 丁 根本沒有 pw.log(並行那步沒跑到那段)→ 補裝
    rc1, o1, rc2, o2, cl = pw_case(PAR_SH, SCAN_SH, drop_log=True)
    ok('⑦丁 沒有安裝紀錄 → 掃描那步補裝', _scan_installed(cl) and 'scan ok' in o2, (cl, o2[-300:]))
    # 決定性對照甲:把背景安裝搬回掃描那步(= 改版前)→ 掃描那步又開始自己裝 = ⑦甲那條會紅
    _back = re.sub(r'\( T0=\$\(date \+%s\); set \+e\n.*?PIDPW=\$!\n', '', PAR_SH, flags=re.S).replace('wait $PIDPW\n', '')
    if _back != PAR_SH:
        rc1, o1, rc2, o2, cl = pw_case(_back, SCAN_SH)
        ok('⑦ 決定性對照甲:拿掉背景安裝 → 掃描那步一定會自己裝(⑦甲 就是在擋這個)', _scan_installed(cl), cl)
    else:
        ok('⑦ 決定性對照甲:抽得到背景安裝那段(拿得掉才算有對照)', False, '樣式對不上')
    # 決定性對照乙:拿掉 `wait $PIDPW` → 並行那步在安裝寫完 RC 之前就結束 → 印不出「已先裝好」
    _nowait = PAR_SH.replace('wait $PIDPW\n', '')
    if _nowait != PAR_SH:
        rc1, o1, rc2, o2, cl = pw_case(_nowait, SCAN_SH)
        ok('⑦ 決定性對照乙:拿掉 wait $PIDPW → 一定印不出「已先裝好」(⑦甲 第一條會紅)', '瀏覽器已先裝好' not in o1, o1[-300:])
    else:
        ok('⑦ 決定性對照乙:抽得到 wait $PIDPW 那行', False, '樣式對不上')

run_case(single_branch=False)
run_case(single_branch=True)

print(f"\n{'❌ %d 項未過:' % len(fails) + chr(10) + '  - ' + (chr(10) + '  - ').join(fails) if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
