#!/usr/bin/env python3
"""🩺 巡邏:某個分支(預設 origin/data,也可 origin/gh-pages)底下每一個 .json 讀不讀得出來(只讀 git,不打網路)。

🚨 2026-10-24 #647:confcall.json / confcall_digest.json / screener.json 在兩個分支上都壞了(完整 JSON + 舊版尾巴 / 亂碼),
   workflow 全綠、零訊息 —— 只有把檔案一個一個解析才看得到(陷阱 #61)。
用法: python3 scripts/check_branch_json.py [ref=origin/data] [對照 ref](給對照 ref 會列出內容不同的非股票檔)
⚠️ 先 `git fetch origin data gh-pages`。有壞檔 → exit 1。
"""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ref = sys.argv[1] if len(sys.argv) > 1 else 'origin/data'
cmp_ref = sys.argv[2] if len(sys.argv) > 2 else None


def tree(r):
    out = subprocess.run(['git', '-C', str(ROOT), 'ls-tree', '-r', r], capture_output=True, text=True).stdout
    d = {}
    for line in out.splitlines():
        meta, path = line.split('\t', 1)
        _, typ, sha = meta.split()
        if typ == 'blob' and path.endswith('.json'):
            d[path] = sha
    return d


t = tree(ref)
if not t:
    print(f'❌ {ref} 底下一個 .json 都沒有(ref 不存在?先 git fetch)')
    sys.exit(1)
bad = {}
p = subprocess.Popen(['git', '-C', str(ROOT), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
for sha in sorted(set(t.values())):
    p.stdin.write((sha + '\n').encode()); p.stdin.flush()
    n = int(p.stdout.readline().split()[2])
    b = p.stdout.read(n); p.stdout.read(1)
    try:
        json.loads(b.decode('utf-8'))
    except Exception as e:
        bad[sha] = f'{type(e).__name__}: {str(e)[:80]}({n:,} bytes)'
p.stdin.close(); p.wait()
hits = sorted((path, bad[sha]) for path, sha in t.items() if sha in bad)
print(f'{ref}: {len(t)} 個 .json,讀不出來 {len(hits)} 個')
for path, why in hits:
    print('  ❌', path, why)
if cmp_ref:
    c = tree(cmp_ref)
    stock = lambda x: x.startswith('data/') and x.count('/') == 1 and (x[5:-5].isdigit() or x[5:7] == '00' or x[5] == '^')
    diff = sorted(x for x in t if x in c and t[x] != c[x] and not stock(x))
    print(f'跟 {cmp_ref} 比:內容不同的非股票檔 {len(diff)} 個')
    for x in diff:
        print('   ≠', x)
sys.exit(1 if hits else 0)
