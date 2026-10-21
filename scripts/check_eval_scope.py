#!/usr/bin/env python3
"""🧭 V79.4.7 page.evaluate 的「回呼本體」不可用到 Node 端才有的名字(陷阱 #57)

🚨 為什麼要這支:V76.2.9 把 playbook_scan.mjs 的 `tickOf` 從回呼裡面搬到檔案最上面(Node 端)。
   回呼是**在瀏覽器裡**跑的 → 看不到 Node 端的名字 → ReferenceError → 被每檔的 try/catch 吞掉
   → 名單上凡是有觸發價的股票整檔消失,2026-09-14 ~ 10-20 五週沒人發現(workflow 全綠、檔案照寫)。
   ⛔ `node --check` / 字串比對都抓不到:語法完全合法,錯在「這段程式在哪個環境跑」。

做法(粗掃,⛔ 不是完整的 JS 解析器):
  ① 找 scripts/*.mjs(⛔ 不掃 test_*:測試本身會在四驗證裡真的跑)裡每一個 `page.evaluate(`
  ② 取出回呼的參數與本體(剝掉註解 / 字串 / 正規表示式)
  ③ 本體用到的名字 ∩ 檔案最上層定義的名字 − 回呼自己的參數與區域變數 → 有交集就報
⚠️ 要傳 Node 端的值進去,一律放 evaluate 的第二個參數(`page.evaluate(a => …, { x })`)。

跑法:python3 scripts/check_eval_scope.py            → 有命中 exit 1
      python3 scripts/check_eval_scope.py --selftest → 合成案例自我檢查
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = r'[A-Za-z_$][\w$]*'


def strip(b):
    b = re.sub(r'/\*.*?\*/', ' ', b, flags=re.S)
    b = re.sub(r'(?<![:\\])//[^\n]*', ' ', b)
    b = re.sub(r'`(?:\\.|[^`])*`', '``', b, flags=re.S)
    b = re.sub(r"'(?:\\.|[^'\n\\])*'", "''", b)
    b = re.sub(r'"(?:\\.|[^"\n\\])*"', '""', b)
    # 正規表示式字面量(前面是運算子 / 括號 / return)→ 換成空字串,免得 /^pct(\d+)$/ 被當成用到 pct
    b = re.sub(r'(?:(?<=[(,=:!&|?{};\[])|(?<=return))(\s*)/(?![/*])(?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\\[])+/[a-z]*', r'\1""', b)
    return b


def close_of(s, i, o, c):
    d = 0
    for j in range(i, len(s)):
        if s[j] == o:
            d += 1
        elif s[j] == c:
            d -= 1
            if d == 0:
                return j
    return len(s) - 1


def scan_text(raw, fname='<text>'):
    src = strip(raw)
    top = set(re.findall(rf'^(?:export\s+)?(?:const|let|var|function|async\s+function)\s+({NAME})', src, re.M))
    for g in re.findall(r'^(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=', src, re.M):
        top |= set(re.findall(rf'({NAME})\s*(?=,|$|:|\s*$)', g))
    hits = []
    for m in re.finditer(r'page\.evaluate\(\s*(?:async\s*)?', src):
        i = m.end()
        if i >= len(src):
            continue
        if src[i] == '(':
            pe = close_of(src, i, '(', ')')
            params, k = src[i + 1:pe], pe + 1
        else:
            mm = re.match(NAME, src[i:])
            if not mm:
                continue                      # page.evaluate(fnRef, …) / page.evaluate('字串') → 不是行內回呼
            params, k = mm.group(0), i + mm.end()
        ar = src.find('=>', k)
        if ar < 0 or src[k:ar].strip():
            continue
        k = ar + 2
        while k < len(src) and src[k].isspace():
            k += 1
        if k < len(src) and src[k] == '{':
            body = src[k:close_of(src, k, '{', '}') + 1]
        else:
            j, d = k, 0
            while j < len(src):
                ch = src[j]
                if ch in '([{':
                    d += 1
                elif ch in ')]}':
                    if d == 0:
                        break
                    d -= 1
                elif ch == ',' and d == 0:
                    break
                j += 1
            body = src[k:j]
        local = set(re.findall(NAME, params))
        local |= set(re.findall(rf'(?:const|let|var|function|class)\s+({NAME})', body))
        for g in re.findall(r'(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]\s*=', body):
            local |= set(re.findall(NAME, g))
        for g in re.findall(r'\(([^()]*)\)\s*=>', body):
            local |= set(re.findall(NAME, g))
        local |= set(re.findall(rf'({NAME})\s*=>', body))
        for g in re.findall(r'catch\s*\(([^)]*)\)', body):
            local |= set(re.findall(NAME, g))
        used = set(re.findall(rf'(?<![\w$.])({NAME})(?![\w$])(?!\s*:(?!:))', body))
        bad = sorted((used & top) - local)
        if bad:
            line = raw[:raw.find('page.evaluate', 0)].count('\n') + 1 if raw.count('page.evaluate') == 1 else None
            hits.append((fname, m.start(), bad, line))
    return hits


def selftest():
    fails = []

    def ck(c, msg):
        print(('✅ ' if c else '❌ ') + msg)
        if not c:
            fails.append(msg)
    bug = "const tickOf = v => v < 10 ? 0.01 : 1;\nconst r = await page.evaluate(a => { const t = trigOf(a); return Math.ceil(t / tickOf(t)); }, { x: 1 });\n"
    ck(any('tickOf' in h[2] for h in scan_text(bug)), '① Node 端的 tickOf 用在回呼裡 → 抓得到(V76.2.9 的壞法)')
    ok_arg = "const NEAR = 6;\nconst r = await page.evaluate(a => { const { near } = a; return near * 2; }, { near: NEAR });\n"
    ck(not scan_text(ok_arg), '② 用第二個參數傳進去 → 不報')
    ok_local = "const tickOf = v => 1;\nconst r = await page.evaluate(() => { const tickOf = p => app._tickOf(p); return tickOf(3); });\n"
    ck(not scan_text(ok_local), '③ 回呼裡自己重新定義同名 → 不報')
    ok_re = "const pct = v => v + '%';\nconst r = await page.evaluate(a => { return /^pct(\\d+)$/.test(a.stop); }, { stop: 'pct5' });\n"
    ck(not scan_text(ok_re), '④ 名字只出現在正規表示式裡 → 不報')
    ok_str = "const STEP = 3;\nconst r = await page.evaluate(() => { return 'STEP ' + `STEP`; });\n"
    ck(not scan_text(ok_str), '⑤ 名字只出現在字串裡 → 不報')
    ok_key = "const SYM = '2330';\nconst r = await page.evaluate(s => ({ SYM: s }), SYM);\n"
    ck(not scan_text(ok_key), '⑥ 名字只當物件的鍵 → 不報')
    bug2 = "function helper(x) { return x; }\nconst r = await page.evaluate(async () => { return helper(1); });\n"
    ck(any('helper' in h[2] for h in scan_text(bug2)), '⑦ Node 端的 function 用在 async 回呼裡 → 抓得到')
    # ⑧ 真檔:修好的 playbook_scan 不報;把瀏覽器裡那行拿掉 → 要報
    p = os.path.join(ROOT, 'scripts', 'playbook_scan.mjs')
    src = open(p, encoding='utf-8').read()
    ck(not scan_text(src, p), '⑧ 現行 playbook_scan.mjs 不報')
    inj = src.replace('const tickOf = p => app._tickOf(p);', '')
    ck(inj != src and any('tickOf' in h[2] for h in scan_text(inj, p)), '⑧ 注入「拿掉瀏覽器裡的 tickOf」→ 抓得到')
    print('\n' + ('❌ selftest 失敗 %d 條' % len(fails) if fails else '✅ selftest 全過'))
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        return selftest()
    files = [f for f in sorted(glob.glob(os.path.join(ROOT, 'scripts', '*.mjs'))) if not os.path.basename(f).startswith('test_')]
    n_eval = 0
    hits = []
    for f in files:
        raw = open(f, encoding='utf-8').read()
        if 'page.evaluate' not in raw:
            continue
        n_eval += raw.count('page.evaluate(')
        hits += scan_text(raw, os.path.relpath(f, ROOT))
    if n_eval == 0:
        print('❌ 一個 page.evaluate 都沒掃到 → 檔案路徑錯了?(空過守門)')
        return 1
    for f, _, bad, _ in hits:
        print(f'❌ {f}:page.evaluate 回呼裡用到 Node 端才有的名字 {bad} → 瀏覽器裡會 ReferenceError(改成第二個參數傳進去,或在回呼裡自己定義)')
    print(f'{"❌" if hits else "✅"} 掃 {len(files)} 支腳本、{n_eval} 個 page.evaluate:{len(hits)} 個回呼用到 Node 端的名字')
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
