#!/usr/bin/env python3
"""採礦產物 → workflow artifact 對帳(push 前驗證用)。

為什麼要有這支(V71.4.7,踩過才加):
  `data/breadth.json` 明明在 daily_miner.yml 的 artifact 清單裡,卻從來沒上過 gh-pages。
  原因是那行寫成:

      path: |
        data/breadth.json          # 📊 市場廣度歷史…

  `path: |` 是 YAML **block scalar**,裡面每一行都是「字面文字」,行尾的 `#` 不是註解,
  會變成路徑的一部分 → 這個 pattern 永遠比對不到檔案 → upload-artifact 只警告不失敗
  → workflow 全綠、artifact 照傳,但那一檔就是不見了。前端讀不到,也完全沒有錯誤訊息。

  這正是 CLAUDE.md 陷阱 #9 的同一種:「腳本 rc=0 / workflow 綠燈 ≠ 功能有跑」。

本檔擋兩件事:
  ① block scalar 路徑清單裡不准出現行尾 `#`(要註解就寫在 block 外面)。
  ② miner.py / macro_miner.py / radar_miner.py 等會寫出的 data/*.json,
     必須出現在某支 workflow 的 artifact path 清單裡(不然跑完即丟)。
     ⚠️ ② 是「提醒」不是硬擋:有些檔是中介產物、刻意不上傳,列在 KNOWN_NOT_UPLOADED 白名單。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF_DIR = ROOT / '.github' / 'workflows'

# 刻意不上傳的(中介檔 / 太大 / 只在別的 job 用),列在這裡就不會被 ② 報出來
KNOWN_NOT_UPLOADED = {
    'data/inst_cache_stock.json',     # 18.5MB 採礦中介,V69.9.6 起只留 data 分支
    'data/margin_cache_stock.json',   # 同上,中介快取
    'data/fund_yoy_gm.json',          # fund_sweep.yml 自己部署,不走 daily_miner artifact
    'data/risk_history.json',         # macro 端 append,靠 deploy 的 git archive origin/data 保留
}


def _block_scalar_lines(text):
    """回傳 [(行號, 行內容, 是否在 block scalar 內)]。"""
    out = []
    inblk = False
    ind = 0
    for i, line in enumerate(text.split('\n'), 1):
        m = re.match(r'^(\s*)[\w-]+:\s*[|>][-+]?\s*$', line)
        if m:
            inblk, ind = True, len(m.group(1))
            out.append((i, line, False))
            continue
        if inblk and line.strip() and (len(line) - len(line.lstrip())) <= ind:
            inblk = False
        out.append((i, line, inblk))
    return out


def check_inline_comments():
    bad = []
    for wf in sorted(WF_DIR.glob('*.yml')):
        for ln, line, inblk in _block_scalar_lines(wf.read_text(encoding='utf-8')):
            # 只挑「看起來是路徑」的行,避免誤傷 run: | 裡的 shell(shell 的 # 才是真註解)
            if inblk and re.match(r'^\s*[\w./^*-]+\s+#', line) and 'data/' in line:
                bad.append((wf.name, ln, line.strip()))
    if bad:
        print('❌ artifact 路徑清單裡有「行尾 # 註解」—— 那不是註解,會變成路徑的一部分導致該檔靜默漏傳:')
        for f, ln, l in bad:
            print(f'   • {f}:{ln}  {l[:100]}')
        print('   修法:把說明搬到 block scalar 外面(path: | 那一行之上)再寫 #。')
        return False
    print('✅ workflow 路徑清單無行尾註解陷阱')
    return True


def check_outputs_uploaded():
    wf_text = '\n'.join(p.read_text(encoding='utf-8') for p in WF_DIR.glob('*.yml'))
    produced = set()
    for py in ('miner.py', 'macro_miner.py', 'radar_miner.py'):
        f = ROOT / py
        if not f.exists():
            continue
        src = f.read_text(encoding='utf-8')
        # Path(DATA_DIR) / 'x.json'  或  Path('data', 'x.json')  或  'data/x.json'
        produced |= {f'data/{m}' for m in re.findall(r"Path\(DATA_DIR\)\s*/\s*'([\w.^-]+\.json)'", src)}
        produced |= {f'data/{m}' for m in re.findall(r"Path\('data',\s*'([\w.^-]+\.json)'\)", src)}
    missing = sorted(p for p in produced
                     if p not in KNOWN_NOT_UPLOADED and p.split('/')[-1] not in wf_text)
    if missing:
        print('⚠️ 這些採礦產物沒出現在任何 workflow 的 artifact 清單裡(跑完即丟,前端永遠讀不到):')
        for p in missing:
            print(f'   • {p}')
        print('   → 確認要上傳就加進 daily_miner.yml 的 path 清單;刻意不上傳就加進本檔 KNOWN_NOT_UPLOADED。')
        return False
    print(f'✅ 採礦產物都在 artifact 清單內(掃到 {len(produced)} 個 data/*.json)')
    return True





def _script_secret_needs():
    """每支根目錄 *.py 讀了哪些「像機密」的環境變數(TOKEN/KEY/SECRET)。"""
    need = {}
    for f in sorted(ROOT.glob('*.py')):
        src = f.read_text(encoding='utf-8', errors='ignore')
        names = set(re.findall(r"os\.(?:getenv|environ\.get)\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]", src))
        names |= set(re.findall(r"os\.environ\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\]", src))
        need[f.name] = {n for n in names if re.search(r'TOKEN|KEY|SECRET', n)}
    return need


def _steps_running_scripts():
    """回 [(workflow, job, step_name, {script.py}, {可用的 env 名})]。"""
    import yaml
    out = []
    for wf in sorted(WF_DIR.glob('*.yml')):
        try:
            doc = yaml.safe_load(wf.read_text(encoding='utf-8')) or {}
        except Exception:
            continue
        wf_env = set((doc.get('env') or {}).keys())
        for jname, job in (doc.get('jobs') or {}).items():
            if not isinstance(job, dict):
                continue
            job_env = set((job.get('env') or {}).keys())
            for step in (job.get('steps') or []):
                if not isinstance(step, dict):
                    continue
                run = step.get('run') or ''
                if not isinstance(run, str) or not run:
                    continue
                scripts = set(re.findall(r'python3?\s+(?:-u\s+)?([\w./-]+\.py)', run))
                scripts = {Path(x).name for x in scripts}
                if not scripts:
                    continue
                env = wf_env | job_env | set((step.get('env') or {}).keys())
                out.append((wf.name, jname, step.get('name') or '(unnamed)', scripts, env))
    return out


def check_script_secrets():
    """擋「同一支腳本在 A workflow 有給某機密、在 B workflow 卻漏給」的不一致。

    為什麼只比「不一致」而不比「腳本讀到的全部機密」:
      有些機密本來就是選用的(沒給就跳過該功能),全報會很吵。
      但「同一支腳本、同一個機密,一邊給一邊不給」幾乎一定是漏了 —— 實例:
      macro_cron.yml 跑 macro_miner.py 有給 FINMIND_TOKENS,
      daily_miner.yml 的並行 deploy step 也跑 macro_miner.py 卻只給 GROQ
      → 台指 VIX 每次 daily_miner 跑完就被寫成 null(fetch_tw_vix 回 'no-token'),
        而 daily_miner 正是最後 force-push gh-pages 的那個 → 使用者看到「VIX 沒有資料」。
        整條鏈上沒有任何錯誤訊息,workflow 全綠。
    """
    need = _script_secret_needs()
    steps = _steps_running_scripts()
    # script → 該機密曾在哪些 step 被提供
    provided = {}
    for wfn, jn, sn, scripts, env in steps:
        for sc in scripts:
            for secret in need.get(sc, ()):
                if secret in env:
                    provided.setdefault((sc, secret), []).append(f'{wfn}:{jn}')
    missing = []
    for wfn, jn, sn, scripts, env in steps:
        for sc in scripts:
            for secret in need.get(sc, ()):
                if (sc, secret) in provided and secret not in env:
                    missing.append((wfn, jn, sn, sc, secret, provided[(sc, secret)][0]))
    if missing:
        print('❌ 同一支腳本的機密給法不一致(一邊給、一邊漏 → 該功能會靜默失效):')
        for wfn, jn, sn, sc, secret, where in missing:
            print(f'   • {wfn} / {jn} / {sn}')
            print(f'     跑 {sc} 但沒給 {secret}(在 {where} 有給)')
        print('   → 補上該 env,或確認這支 step 真的不需要(需要就別讓它靜默跑出 null)。')
        return False
    print('✅ 各 workflow 給同一支腳本的機密一致')
    return True


# 🔐 V72.9.9 下單程式**絕不可**進 workflow ——————————————————————————————
#   本 repo 是 **public**;GitHub Actions 的 log/artifact 有外洩風險,而且任何能改
#   workflow 的人都能把 Secrets 印出來。而下單需要「電子憑證 .pfx + 密碼 + 身分證字號」,
#   那等於「代表本人動錢」,外洩 = 別人可以拿這個帳戶下單。
#   ⭐ 分界:**行情可以在雲端跑,下單只能在自己的電腦跑。**
#   ⛔ 這是純粹靠人記不住的那種規則 → 寫成守門,納入 push 前四驗證。
NEVER_IN_CI = ('auto_trade.py',)


def check_no_trading_in_ci():
    bad = []
    for f in sorted(WF_DIR.glob('*.yml')) + sorted(WF_DIR.glob('*.yaml')):
        try:
            txt = f.read_text(encoding='utf-8')
        except Exception:
            continue
        for name in NEVER_IN_CI:
            if name in txt:
                bad.append((f.name, name))
    # 順便擋「憑證類機密被塞進 workflow」
    CA_SECRETS = ('SJ_CA_PATH', 'SJ_CA_PASSWD', 'SJ_PERSON_ID', 'CA_PASSWD', 'PERSON_ID')
    for f in sorted(WF_DIR.glob('*.yml')) + sorted(WF_DIR.glob('*.yaml')):
        try:
            txt = f.read_text(encoding='utf-8')
        except Exception:
            continue
        for sec in CA_SECRETS:
            if sec in txt:
                bad.append((f.name, sec))
    if bad:
        print('❌ 🔐 下單程式/憑證機密出現在 workflow 裡(repo 是 public,這會外洩下單權限):')
        for wfn, name in bad:
            print(f'   • {wfn} 提到 {name}')
        print('   → 下單一律只能在自己的電腦跑;⛔ 不要為了「方便」把它接進 CI。')
        return False
    print('✅ 沒有下單程式/憑證機密進入 workflow(行情在雲端、下單在本機)')
    return True


def check_finmind_token_normalize():
    """🔑 FinMind 金鑰**內部**夾到空白時,`.strip()` 清不掉 → FinMind 回 `Token is illegal.`

    🚨 V73.2.7 實測(`finmind_check.py` 對真金鑰):使用者 4 把有 **3 把**含 1 個內部空白
       (原始 174/173/176 字元 → 清完 173/172/175)。用 `.strip()` 的腳本
       (macro_miner / rotation_miner / history_probe)只剩 1 把能用,
       而那 1 把剛好是免費層 → 於是「台指 VIX 開不了」被誤判成**帳號等級問題**,
       實際上**付費那把根本沒被正確送出去過**。而且三支全綠、零錯誤訊息。

    ⛔ 一律用 `''.join(t.split())`(同 miner.py / finmind_check.py),別再寫 `.strip()`。
    """
    import re
    bad = []
    for f in sorted(ROOT.glob('*.py')) + sorted((ROOT / 'scripts').glob('*.py')):
        try:
            src = f.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue
        for i, ln in enumerate(src.splitlines(), 1):
            if 'FINMIND_TOKEN' not in ln and 'FINMIND_TOKENS' not in ln and '_fm_env' not in ln:
                continue
            # 只看「切逗號 → 逐把處理」那一行
            if '.split(\',\')' not in ln:
                continue
            # ⚠️ 只看**元素運算式**(`[` 到 ` for ` 之間);
            #    尾巴的 `if t.strip()]` 是過濾條件,那個是對的,⛔ 不可誤報
            #    (第一版就因為整行掃而把 5 支全報成壞的 —— 誤報會讓人養成無視守門的習慣)
            m = re.search(r'\[\s*(.*?)\s+for\s+t\s+in\b', ln)
            if m and 't.strip()' in m.group(1):
                bad.append((f.name, i, ln.strip()[:90]))
    if bad:
        print('❌ 🔑 FinMind 金鑰用 .strip() 解析(清不掉金鑰**中間**的空白 → Token is illegal):')
        for fn, i, ln in bad:
            print(f'   • {fn}:{i}  {ln}')
        print("   → 改成 [''.join(t.split()) for t in …](同 miner.py / finmind_check.py)")
        return False
    print('✅ FinMind 金鑰解析都用了 join(split())(清得掉金鑰中間的空白)')
    return True


if __name__ == '__main__':
    ok = check_inline_comments()
    ok = check_outputs_uploaded() and ok
    ok = check_script_secrets() and ok
    ok = check_no_trading_in_ci() and ok
    ok = check_finmind_token_normalize() and ok
    sys.exit(0 if ok else 1)
