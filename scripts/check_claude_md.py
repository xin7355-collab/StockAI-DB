#!/usr/bin/env python3
"""📏 CLAUDE.md 瘦身守門(2026-11-21,四驗證)

CLAUDE.md 每個對話一開始都整份讀進去 —— 長到 2,541 行時,一個只做小事的對話第一輪就吃掉約 35 萬 Token。
2026-11-21 照主題搬到 .claude/rules/*.md(讀 / 改到對應檔案才載入)與 docs/,這支守住三件事:

① CLAUDE.md ≤ 200 行(官方建議;超過 = 又開始往這份累加,新規則該寫進規則檔)
② .claude/rules/*.md 開頭都有 paths(沒有 paths 的規則檔每次都會載入 = 偷偷把 CLAUDE.md 撐回去),
   而且每個 glob 至少對到一個 repo 裡的檔(對不到 = 那份規則永遠不會被載入,而且零訊息)
③ CLAUDE.md 全文、規則檔的檔頭(搬過來的舊原文以外、自己寫的那幾行)提到的 repo 路徑都要存在(搬完留死連結)
   ⚠️ 規則檔裡搬過來的舊原文會提到已刪除 / 只在採礦產物裡的檔(歷史紀錄),⛔ 不檢查那些行。

用法:python3 scripts/check_claude_md.py [--selftest]
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_LINES = 200
# 只檢查看得出是「這個 repo 的路徑」的(data/ 是採礦產物、不在版控 → 不檢查)
PATH_RE = re.compile(r'`((?:\.claude|docs|scripts|\.github|cloud-worker|research)/[A-Za-z0-9_./-]+\.(?:md|py|mjs|js|json|yml|yaml|html|txt|sh|toml|ndjson))`')
OLD_MARK = re.compile(r'^<!-- 舊 CLAUDE\.md 第 \d+~\d+ 行 -->$')


def repo_files(root):
    files = []
    try:
        p = subprocess.run(['git', 'ls-files', '-co', '--exclude-standard'], cwd=root,
                           capture_output=True, text=True, timeout=60)
        if p.returncode == 0:
            files = [l for l in p.stdout.split('\n') if l]
    except Exception:
        pass
    if not files:   # 不是 git repo(selftest 的暫存資料夾)→ 直接走磁碟
        files = [q.relative_to(root).as_posix() for q in root.rglob('*')
                 if q.is_file() and '.git' not in q.relative_to(root).parts]
    # .claude/ 在 .gitignore 裡(規則檔 / Skill 用 add -f 進版控)→ 另外補上磁碟上的
    for p in (root / '.claude').rglob('*'):
        if p.is_file():
            files.append(p.relative_to(root).as_posix())
    return sorted(set(files))


def glob_re(pat):
    """gitignore 式:** 跨資料夾、* 不跨;沒有 / 的樣式比對任何一層的檔名。"""
    p = pat.lstrip('/')
    out, i = '', 0
    while i < len(p):
        if p.startswith('**/', i):
            out += '(?:.*/)?'; i += 3
        elif p.startswith('**', i):
            out += '.*'; i += 2
        elif p[i] == '*':
            out += '[^/]*'; i += 1
        elif p[i] == '?':
            out += '[^/]'; i += 1
        else:
            out += re.escape(p[i]); i += 1
    if '/' not in pat:
        out = '(?:.*/)?' + out
    return re.compile('^' + out + '$')


def parse_paths(text):
    """回 (paths 清單, 錯誤訊息);只認檔案最開頭的 --- 區塊。"""
    lines = text.split('\n')
    if not lines or lines[0].strip() != '---':
        return None, '開頭沒有 --- frontmatter'
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == '---')
    except StopIteration:
        return None, 'frontmatter 沒有結尾的 ---'
    fm = lines[1:end]
    pats, inside = [], False
    for ln in fm:
        if re.match(r'^paths\s*:\s*$', ln):
            inside = True; continue
        m = re.match(r'^paths\s*:\s*(.+)$', ln)
        if m:
            pats += [x.strip().strip('"\'') for x in m.group(1).split(',') if x.strip()]
            inside = False; continue
        if inside:
            m = re.match(r'^\s+-\s+(.+?)\s*$', ln)
            if m:
                pats.append(m.group(1).strip().strip('"\''))
            elif ln.strip():
                inside = False
    if not pats:
        return None, 'frontmatter 沒有 paths(沒有 paths 的規則檔每次都會載入)'
    return pats, None


def own_lines(text):
    """規則檔自己寫的行:第一個「舊 CLAUDE.md 第 a~b 行」註解之前的部分。"""
    out = []
    for ln in text.split('\n'):
        if OLD_MARK.match(ln.strip()):
            break
        out.append(ln)
    return out


def check(root):
    errs = []
    files = repo_files(root)
    fileset = set(files)
    cm = root / 'CLAUDE.md'
    if not cm.exists():
        return ['CLAUDE.md 不存在'], {}
    ct = cm.read_text(encoding='utf-8')
    n = len(ct.rstrip('\n').split('\n'))
    if n > MAX_LINES:
        errs.append(f'① CLAUDE.md {n} 行 > {MAX_LINES}(新規則照主題寫進 .claude/rules/,⛔ 往 CLAUDE.md 累加)')
    rules = sorted((root / '.claude' / 'rules').glob('**/*.md'))
    if not rules:
        errs.append('② .claude/rules/ 一個規則檔都沒有(CLAUDE.md 的索引會全部指到空)')
    texts = {'CLAUDE.md': ct.split('\n')}
    for r in rules:
        rel = r.relative_to(root).as_posix()
        t = r.read_text(encoding='utf-8')
        pats, why = parse_paths(t)
        if why:
            errs.append(f'② {rel}:{why}')
        else:
            for p in pats:
                rx = glob_re(p)
                if not any(rx.match(f) for f in files):
                    errs.append(f'② {rel}:paths「{p}」對不到 repo 裡任何一個檔(這份規則永遠不會載入)')
        texts[rel] = own_lines(t)
    for rel, lines in texts.items():
        for i, ln in enumerate(lines, 1):
            for p in PATH_RE.findall(ln):
                if p not in fileset and not (root / p).exists():
                    errs.append(f'③ {rel} 第 {i} 行提到 `{p}`,但檔案不存在(死連結)')
    return errs, {'claude_lines': n, 'rules': len(rules)}


def selftest():
    fails = []

    def ok(name, cond):
        print(('✅ ' if cond else '❌ ') + name)
        if not cond:
            fails.append(name)

    def mk(tmp, claude='# x\n見 `docs/A.md`\n', rules=None, extra=('docs/A.md', 'index.html', 'scripts/t.py')):
        root = Path(tmp)
        for e in extra:
            (root / e).parent.mkdir(parents=True, exist_ok=True)
            (root / e).write_text('x', encoding='utf-8')
        (root / 'CLAUDE.md').write_text(claude, encoding='utf-8')
        rd = root / '.claude' / 'rules'
        rd.mkdir(parents=True, exist_ok=True)
        for k, v in (rules or {'app.md': '---\npaths:\n  - "index.html"\n---\n# app\n'}).items():
            (rd / k).write_text(v, encoding='utf-8')
        return root

    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t))
        ok('乾淨的設定 → 0 個錯', e == [])
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, claude='\n'.join(['x'] * 201) + '\n'))
        ok('🧪 注入:CLAUDE.md 201 行 → 紅', any(x.startswith('①') for x in e))
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, claude='\n'.join(['x'] * 200) + '\n'))
        ok('邊界:剛好 200 行 → 不紅', not any(x.startswith('①') for x in e))
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, rules={'a.md': '# 沒有 frontmatter\n'}))
        ok('🧪 注入:規則檔沒有 paths → 紅', any('沒有 --- frontmatter' in x for x in e))
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, rules={'a.md': '---\ndescription: x\n---\n# a\n'}))
        ok('🧪 注入:frontmatter 有但沒有 paths → 紅', any('沒有 paths' in x for x in e))
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, rules={'a.md': '---\npaths:\n  - "nothere/**"\n---\n'}))
        ok('🧪 注入:glob 對不到任何檔 → 紅', any('對不到' in x for x in e))
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, rules={'a.md': '---\npaths:\n  - "scripts/*.py"\n  - "*.html"\n  - "scripts/**"\n---\n'}))
        ok('glob:scripts/*.py、*.html(任何一層)、scripts/** 都對得到', e == [])
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, rules={'a.md': '---\npaths: index.html, scripts/t.py\n---\n'}))
        ok('paths 寫成逗號分隔字串也認得', e == [])
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, claude='# x\n見 `docs/Gone.md`\n'))
        ok('🧪 注入:CLAUDE.md 提到不存在的 docs 檔 → 紅', any('docs/Gone.md' in x for x in e))
    with tempfile.TemporaryDirectory() as t:
        r = '---\npaths:\n  - "index.html"\n---\n# a\n看 `scripts/gone.py`\n'
        e, _ = check(mk(t, rules={'a.md': r}))
        ok('🧪 注入:規則檔自己寫的那幾行提到不存在的檔 → 紅', any('scripts/gone.py' in x for x in e))
    with tempfile.TemporaryDirectory() as t:
        r = '---\npaths:\n  - "index.html"\n---\n# a\n<!-- 舊 CLAUDE.md 第 1~2 行 -->\n以前有 `scripts/gone.py`\n'
        e, _ = check(mk(t, rules={'a.md': r}))
        ok('搬過來的舊原文提到已刪除的檔 → ⛔ 不報(那是歷史)', e == [])
    with tempfile.TemporaryDirectory() as t:
        e, _ = check(mk(t, claude='# x\n產物 `data/x.json`\n'))
        ok('data/ 底下的採礦產物 → 不檢查', e == [])
    with tempfile.TemporaryDirectory() as t:
        root = mk(t)
        (root / '.claude' / 'rules' / 'app.md').unlink()
        e, _ = check(root)
        ok('🧪 注入:.claude/rules 空的 → 紅', any('一個規則檔都沒有' in x for x in e))
    print(f'\n{"❌ selftest 失敗 " + str(len(fails)) + " 條" if fails else "✅ CHECK_CLAUDE_MD_SELFTEST_PASS"}')
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        return selftest()
    errs, info = check(ROOT)
    for e in errs:
        print('❌ ' + e)
    if errs:
        print(f'\n❌ CLAUDE.md 守門 {len(errs)} 條沒過')
        return 1
    print(f'✅ CLAUDE.md {info["claude_lines"]} 行(≤{MAX_LINES})・規則檔 {info["rules"]} 個都有 paths 且對得到檔・沒有死連結')
    return 0


if __name__ == '__main__':
    sys.exit(main())
