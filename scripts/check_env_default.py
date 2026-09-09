#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔧 check_env_default.py —— 擋「環境變數預設值擋不住空字串」這一類 bug(納入 push 前四驗證第 2 項)。

🚨 本專案已經踩過**兩次**同一個坑:
  ① V74.7.0 `intraday_probe.py`:workflow 的「留空」是 `PROBE_SYMS: ""` → `os.environ.get(k, 預設)` 回 `''`
     → 0 檔,錯誤訊息還寫「一個可用交易日都沒有」把診斷帶往完全錯的方向。
  ② V75.1.3 `pe_band_miner.py:41`:排程觸發時 `inputs.limit` 是空字串 → `int(os.getenv('LIMIT', '99999'))`
     → `int('')` 炸 → 而 workflow `set +e … exit 0` 把 rc 吞掉 → **四個週日全綠、零產出**,
     `pe_band.json` 停在 08-14 一個月沒人發現。

⭐ 通用鐵則:`os.getenv(k, 預設)` / `os.environ.get(k, 預設)` **只在 k 不存在時給預設**,
   GitHub Actions 把「沒填的 input」當成**空字串**傳進去 → 預設值形同虛設。
   → 一律寫 `(os.getenv(k) or 預設)`。

判準(⛔ 刻意只抓「直接餵 int/float」與「用 `or` 以外的方式取預設」兩種最會炸的寫法):
  A. `int(os.getenv('X', '…'))` / `float(os.getenv(…, …))` / `int(os.environ.get(…, …))`
  B. `os.getenv('X', '非空預設')` 之後**沒有** `or` —— 只掃同一行(⛔ 不做流程分析,免得誤報一堆)。
     ⚠️ B 類只在預設值**非空**時才報:`os.getenv('X', '')` 本來就是「空的也可以」。

有 `--selftest`(注入兩種壞寫法 + 兩種好寫法,壞的一定要叫、好的一定不能叫)。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GET = r"os\.(?:getenv|environ\.get)\(\s*(['\"])([A-Za-z_][A-Za-z0-9_]*)\1\s*,\s*(['\"]?)([^'\")]*)\3\s*\)"
PAT_A = re.compile(r"\b(?:int|float)\(\s*" + GET)          # int(os.getenv('X', '1'))
PAT_B = re.compile(GET)                                        # os.getenv('X', '1')(同一行沒有 or)


def scan_text(text, fname='<mem>'):
    """回 [(line_no, kind, line)]。kind ∈ {'A','B'}。"""
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        s = line.split('#', 1)[0]           # 剝行尾註解(⛔ 說明這個 bug 的註解本身就含壞寫法)
        if not s.strip():
            continue
        if PAT_A.search(s):
            out.append((i, 'A', line.rstrip()))
            continue
        for m in PAT_B.finditer(s):
            default = m.group(4)
            if default == '':
                continue                    # 預設就是空字串 → 空的也 OK,不報
            after = s[m.end():]
            before = s[:m.start()]
            # `(os.getenv(...) or X)` / `os.getenv(...) or X` → 有救回來
            if re.match(r"\s*\)?\s*or\b", after) or re.search(r"\bor\s*\(?\s*$", before):
                continue
            out.append((i, 'B', line.rstrip()))
            break
    return out


def workflow_input_envs():
    """掃 .github/workflows/*.yml:哪些環境變數是從 `github.event.inputs.*` / `inputs.*` 餵進來的。
    ⭐ 只有這些會在排程觸發時變成**空字串**(手動 dispatch 沒填也是空);
       workflow 寫死的 `MAX_MIN: '150'` 永遠非空,報它只是雜訊(第一版全掃 81 處,九成是這種)。"""
    names = set()
    for y in sorted((ROOT / '.github' / 'workflows').glob('*.yml')):
        try:
            t = y.read_text(encoding='utf-8')
        except Exception:
            continue
        for m in re.finditer(r"^\s*([A-Z][A-Z0-9_]*)\s*:\s*\$\{\{([^}]*)\}\}", t, re.M):
            expr = m.group(2)
            # `${{ inputs.x || '1' }}` 這種 workflow 端已經有後備值 → 永遠非空,不算
            if re.search(r"\binputs\.", expr) and '||' not in expr:
                names.add(m.group(1))
    return names


def scan_repo(all_hits=False):
    risky = workflow_input_envs()
    hits = []
    for p in sorted(ROOT.glob('*.py')) + sorted((ROOT / 'scripts').glob('*.py')):
        if p.name == Path(__file__).name:
            continue
        try:
            t = p.read_text(encoding='utf-8')
        except Exception:
            continue
        for ln, kind, line in scan_text(t, p.name):
            name = (re.search(GET, line.split('#', 1)[0]) or [None, None, None])[2]
            if all_hits or (name in risky):
                hits.append((p.relative_to(ROOT), ln, kind, line))
    return hits, risky


def selftest():
    bad = [
        "LIMIT = int(os.getenv('LIMIT', '99999'))",
        "SLEEP = float(os.environ.get('SLEEP', '0.08'))",
        "syms = os.getenv('PROBE_SYMS', '2330,2317').split(',')",
    ]
    good = [
        "LIMIT = int(os.getenv('LIMIT') or '99999')",
        "syms = (os.environ.get('PROBE_SYMS') or '2330,2317').split(',')",
        "tok = os.getenv('FINMIND_TOKENS', '')",                   # 預設就是空 → 不報
        "# LIMIT = int(os.getenv('LIMIT', '99999'))  ← 說明用的註解不可報",
        "x = os.getenv('A', '1') or '1'",
    ]
    fails = 0
    for b in bad:
        r = scan_text(b)
        print(f"{'✅' if r else '❌'} 壞寫法要叫:{b}")
        fails += 0 if r else 1
    for g in good:
        r = scan_text(g)
        print(f"{'✅' if not r else '❌'} 好寫法不可叫:{g}")
        fails += 1 if r else 0
    print('✅ SELFTEST_PASS' if not fails else f'❌ SELFTEST_FAIL {fails}')
    return 0 if not fails else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    hits, risky = scan_repo(all_hits='--all' in sys.argv)
    if hits:
        print(f"❌ ENV_DEFAULT_FAIL:{len(hits)} 處「環境變數預設值擋不住空字串」的寫法"
              f"(workflow 從 inputs.* 餵進來的變數:{', '.join(sorted(risky)) or '無'};排程觸發時它們是空字串,不是不存在):")
        for f, ln, kind, line in hits:
            print(f"   {f}:{ln} [{kind}] {line.strip()[:110]}")
        print("   → 改成 `(os.getenv(k) or 預設)`;V74.7.0 intraday_probe 與 V75.1.3 pe_band 都是這個坑。")
        sys.exit(1)
    print(f"✅ ENV_DEFAULT_PASS(workflow 從 inputs.* 餵的 {len(risky)} 個變數,Python 端都有 `or 預設` 救回;--all 可列出全部 {len(scan_repo(True)[0])} 處同型寫法)")
