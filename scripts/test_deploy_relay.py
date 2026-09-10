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


run_case(single_branch=False)
run_case(single_branch=True)

print(f"\n{'❌ %d 項未過:' % len(fails) + chr(10) + '  - ' + (chr(10) + '  - ').join(fails) if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
