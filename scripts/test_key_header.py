#!/usr/bin/env python3
"""🔐 Gemini 金鑰⛔ 不可放在網址參數(V77.5.5,app-guardrails-audit 首跑抓到)

為什麼:網址會出現在錯誤訊息、代理紀錄、瀏覽器歷史;採礦端更危險 ——
`macro_miner.http` 掛了 urllib3 Retry,重試時 urllib3 用 logging 印出**含 query 的網址**,
沒設 logging 就落到 stderr = **公開的 Actions log**。

規則:任何 `generativelanguage.googleapis.com` 的網址字串裡⛔ 不可出現 `key=`,
金鑰一律走 `x-goog-api-key` 標頭。

⭐ guardrails 掃描器對 index.html 會因為檔案太大**直接跳過** → 它只抓到 5 處裡的 1 處。
   這支測試自己逐行掃,⛔ 不依賴那支掃描器。

用法:python3 scripts/test_key_header.py [--selftest]
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
EXTS = ('.py', '.js', '.mjs', '.html')
SKIP_DIRS = {'node_modules', 'data', '.git', '__pycache__', '.claude'}
# 同一行、或網址字串被拆成兩行(f"...models/" f"{m}:generateContent?key=...")都要抓
HOST = 'generativelanguage.googleapis.com'
BAD = re.compile(r'[?&]key=')


def scan_text(text, name='<text>'):
    """回傳違規清單 [(檔名, 行號, 行內容)]。看 HOST 那一行與它後面 2 行(拆行的網址)。"""
    out = []
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if HOST not in ln:
            continue
        for j in range(i, min(i + 3, len(lines))):
            if BAD.search(lines[j]):
                out.append((name, j + 1, lines[j].strip()[:160]))
    return out


def scan_repo():
    bad, files = [], 0
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if not fn.endswith(EXTS) or fn == os.path.basename(__file__):
                continue
            p = os.path.join(dp, fn)
            try:
                t = open(p, encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            if HOST in t:
                files += 1
            bad += scan_text(t, os.path.relpath(p, ROOT))
    return bad, files


def selftest():
    ok = True
    def chk(c, n):
        nonlocal ok
        print(('✅ ' if c else '❌ ') + n)
        ok = ok and c
    chk(scan_text("fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${k}`)"), '同一行 ?key= 叫得出來')
    chk(scan_text('url = (f"https://generativelanguage.googleapis.com/v1beta/models/"\n       f"{m}:generateContent?key={key}")'), '拆成兩行的網址也叫得出來')
    chk(not scan_text("fetch('https://generativelanguage.googleapis.com/v1beta/models', {headers:{'x-goog-api-key':k}})"), '走標頭不誤報')
    chk(not scan_text("fetch('https://api.fugle.tw/x?key=1')"), '別的網站不管')
    return ok


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(0 if selftest() else 1)
    bad, files = scan_repo()
    # 🚨 空過守門:一個呼叫 Gemini 的檔都沒掃到 = 掃描範圍壞了,不是「沒問題」
    if files < 3:
        print(f'❌ 只掃到 {files} 個呼叫 Gemini 的檔(預期 ≥3:index.html / worker.js / macro_miner.py)→ 掃描範圍壞了')
        sys.exit(1)
    if bad:
        print('❌ Gemini 金鑰放在網址參數(改用 x-goog-api-key 標頭):')
        for f, ln, s in bad:
            print(f'   {f}:{ln}  {s}')
        sys.exit(1)
    print(f'✅ Gemini 金鑰全部走標頭(掃到 {files} 個呼叫 Gemini 的檔,0 處放網址)')
