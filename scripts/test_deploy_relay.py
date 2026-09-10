#!/usr/bin/env python3
"""
🛟 daily_miner 部署窗口「撿回」守門

🚨 為什麼要有這支(2026-09-09 實測抓到):
   daily_miner 的 deploy job 在**開頭**用 `git archive origin/data` 抓快照,跑 20~25 分鐘,
   最後 **orphan force-push** gh-pages 與 data。
   → 任何別支 workflow 在這段窗口內 push 上去的產物會被**無聲丟掉**
     (兩邊 log 都寫「部署成功」、兩個分支都是 orphan → git 歷史看不出被吃掉)。
   實例:22:04 抓快照 → 22:22 pe_band push 成功 → 22:28 force-push → `pe_band.json` 停在 08-14 一個月。

⛔ 這支釘住四件事:
  ① 分界線 `touch /tmp/base.stamp` 在「鋪設底層資料」那步裡(⛔ 不可搬到 artifact 之後)
  ② 「🛟 撿回」那步存在,且**排在 gh-pages 部署之前**
     —— 排在後面等於沒接上(同陷阱 #34「那行必須排在沿用之前」)
  ③ ⭐ **功能測試**:在 /tmp 開真的 git repo 實跑 yaml 裡**那一段原始腳本**
     —— ⛔ 測試裡不複製一份邏輯(那會變成第二份真相,改了 yaml 測試還是綠的)
  ④ 判準不可退回 `git diff BASE_SHA`(shallow fetch 在雲端拿不到舊物件,陷阱 #40)
"""
import os, re, shutil, subprocess, sys, tempfile, time
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


# ── ① 分界線的位置 ───────────────────────────────────────────
l_base = line_of('touch /tmp/base.stamp')
l_floor = line_of('🗄️ 鋪設底層資料')
l_artifact = line_of('📥 下載並自動合併')
ok('① 有 `touch /tmp/base.stamp` 分界線', l_base > 0)
ok('① 分界線在「鋪設底層資料」那步裡(⛔ 不可搬到 artifact 之後)',
   0 < l_floor < l_base < l_artifact, f'floor={l_floor} stamp={l_base} artifact={l_artifact}')

# ── ② 撿回步驟的位置 ─────────────────────────────────────────
l_relay = line_of('🛟 撿回部署窗口內別支推上來的新檔')
l_ghp = line_of('📡 部署所有資料到 gh-pages')
l_data = line_of('📤 推送到獨立 data 分支')
ok('② 有「🛟 撿回」那一步', l_relay > 0)
ok('② ⭐ 撿回必須排在 gh-pages 部署**之前**(排後面等於沒接上)',
   0 < l_relay < l_ghp, f'relay={l_relay} ghpages={l_ghp}')
ok('② 撿回也必須排在 data 分支推送之前', 0 < l_relay < l_data, f'relay={l_relay} data={l_data}')

# ── ④ ⛔ 不可退回 SHA diff 法 ────────────────────────────────
# 抽出撿回那一步的 run: 內容(下一個 `      - name:` 之前)
body = []
if l_relay > 0:
    i = l_relay  # 0-indexed 的下一行
    while i < len(lines) and not re.match(r'^      - name:', lines[i]):
        body.append(lines[i])
        i += 1
RELAY = '\n'.join(body)
run_body = RELAY.split('run: |', 1)[1] if 'run: |' in RELAY else ''
# 去掉 YAML 縮排(10 空格)
SCRIPT = '\n'.join(l[10:] if l.startswith(' ' * 10) else l for l in run_body.split('\n')).strip('\n')

ok('④ 撿回腳本抽得出來(≥ 15 行,否則是抽取器壞了)', len(SCRIPT.split('\n')) >= 15,
   f'{len(SCRIPT.split(chr(10)))} 行')
# ⚠️ 只看**實際指令**,⛔ 不看註解 —— 註解裡本來就寫著「⛔ 不用 git diff BASE_SHA」,
#    連註解一起掃會被自己的說明文字誤報(第一次跑就踩到)。
CODE = '\n'.join(l for l in SCRIPT.split('\n') if not l.lstrip().startswith('#'))
ok('④ ⛔ 判準不可用 `git diff <SHA> origin/data`(shallow 在雲端拿不到舊物件,陷阱 #40)',
   'git diff' not in CODE and 'BASE_SHA' not in CODE)
ok('④ 判準要用 mtime(`-nt /tmp/base.stamp`)', '-nt /tmp/base.stamp' in CODE)
ok('④ 內容相同要跳過(⛔ 不可無謂覆蓋)', 'cmp -s' in CODE)
ok('④ 要印出撿回幾檔(⛔ 靜默 = 看不出有沒有在工作)', '撿回' in CODE and 'echo' in CODE)

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

        # data 分支:三個檔
        sh('git checkout -q --orphan data && git rm -rq --cached . 2>/dev/null || true', cwd=seed)
        (seed / 'data').mkdir(exist_ok=True)
        for n, v in (('A', 'old-A'), ('B', 'old-B'), ('C', 'old-C')):
            (seed / 'data' / f'{n}.json').write_text(f'{{"v":"{v}"}}')
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
        Path('/tmp/base.stamp').write_text('')          # ← 分界線
        time.sleep(1.1)                                  # mtime 解析度

        # 本輪 daily_miner 產出:只改 A
        (work / 'data' / 'A.json').write_text('{"v":"NEW-by-daily_miner"}')

        # 別支 workflow 在窗口內推了 B(模擬 pe_band)
        sh('git checkout -q data', cwd=seed)
        (seed / 'data' / 'B.json').write_text('{"v":"NEW-by-other-workflow"}')
        sh('git add -A && git commit -qm other && git push -q origin data', cwd=seed)

        # ⭐ 實跑 yaml 裡那段原始腳本(⛔ 測試裡不複製一份邏輯)
        script = Path(tmp) / 'relay.sh'
        script.write_text('set -e\n' + SCRIPT + '\n')
        r = sh(f'bash "{script}"', cwd=work, check=False)
        out = r.stdout + r.stderr
        ok(f'③{label} 撿回腳本跑得起來(rc=0)', r.returncode == 0, out[-400:])

        a = (work / 'data' / 'A.json').read_text()
        b = (work / 'data' / 'B.json').read_text()
        c = (work / 'data' / 'C.json').read_text()
        ok(f'③{label} ⭐ 本輪 daily_miner 產的 A ⛔ 不可被遠端舊版洗掉', 'NEW-by-daily_miner' in a, a)
        ok(f'③{label} ⭐ 別支在窗口內推的 B **要被撿回來**(這就是黑洞那一格)',
           'NEW-by-other-workflow' in b, b)
        ok(f'③{label} 兩邊都沒動的 C 保持不變', 'old-C' in c, c)
        ok(f'③{label} log 要說出撿回幾檔', '撿回別支的 1 檔' in out, out[-300:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


run_case(single_branch=False)
run_case(single_branch=True)

print(f"\n{'❌ %d 項未過:' % len(fails) + chr(10) + '  - ' + (chr(10) + '  - ').join(fails) if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
