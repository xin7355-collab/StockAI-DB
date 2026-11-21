#!/usr/bin/env python3
"""每次 push main 前必跑的「四驗證」—— 平行跑 scripts/fourcheck.txt 的每一條。

用法:
  python3 scripts/run_fourcheck.py                 # 全部跑(預設平行 6 條)
  python3 scripts/run_fourcheck.py -j 10           # 平行 10 條
  python3 scripts/run_fourcheck.py --only release_gate --only test_dupnum   # 只跑指令裡含這些字的
  python3 scripts/run_fourcheck.py --list          # 只列出清單
  python3 scripts/run_fourcheck.py --logdir /tmp/fc   # log 放哪(預設 /tmp/fourcheck_logs)

每一條的輸出存成 logdir/NNN.log;最後列出失敗的(含 log 最後幾行)。有失敗 → exit 1。
⚠️ 有些測試要真的採礦產物 → 先跑 `bash scripts/fetch_testdata.sh`(取完 `git status` 不該看到 data/ 有變動)。
清單的說明與每條的用意:docs/FOURCHECK.md。
"""
import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIST = ROOT / 'scripts' / 'fourcheck.txt'


def load(path=LIST):
    cmds = []
    for ln in path.read_text(encoding='utf-8').split('\n'):
        s = ln.strip()
        if s and not s.startswith('#'):
            cmds.append(s)
    return cmds


def run_one(idx, cmd, logdir, timeout):
    t0 = time.time()
    log = logdir / f'{idx:03d}.log'
    try:
        p = subprocess.run(['bash', '-c', cmd], cwd=ROOT, capture_output=True, text=True,
                           timeout=timeout, env={**os.environ, 'FORCE_COLOR': '0'})
        rc, out = p.returncode, (p.stdout or '') + (p.stderr or '')
    except subprocess.TimeoutExpired as e:
        rc, out = 124, f'⏱️ 超過 {timeout} 秒被砍掉\n' + ((e.stdout or b'').decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or ''))
    log.write_text(f'$ {cmd}\n{out}\n[rc={rc}]\n', encoding='utf-8')
    return idx, cmd, rc, time.time() - t0, log


def main():
    ap = argparse.ArgumentParser(description='四驗證(平行跑 scripts/fourcheck.txt)')
    ap.add_argument('-j', '--jobs', type=int, default=6)
    ap.add_argument('--only', action='append', default=[], help='只跑指令裡含這個字串的(可重複)')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--logdir', default='/tmp/fourcheck_logs')
    ap.add_argument('--timeout', type=int, default=1800, help='每一條最多幾秒(預設 1800)')
    a = ap.parse_args()

    cmds = list(enumerate(load(), 1))
    if a.only:
        cmds = [(i, c) for i, c in cmds if any(o in c for o in a.only)]
    if a.list:
        for i, c in cmds:
            print(f'{i:3d}  {c}')
        print(f'共 {len(cmds)} 條')
        return 0
    if not cmds:
        print('⚠️ 一條都沒選到(--only 打錯?)')
        return 1
    logdir = Path(a.logdir)
    logdir.mkdir(parents=True, exist_ok=True)
    print(f'🧪 四驗證:{len(cmds)} 條,平行 {a.jobs},log 在 {logdir}', flush=True)
    t0 = time.time()
    res = []
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        futs = [ex.submit(run_one, i, c, logdir, a.timeout) for i, c in cmds]
        for f in as_completed(futs):
            r = f.result()
            res.append(r)
            mark = '✅' if r[2] == 0 else '❌'
            print(f'{mark} [{len(res)}/{len(cmds)}] {r[3]:6.1f}s  #{r[0]:03d} {r[1][:110]}', flush=True)
    fails = sorted([r for r in res if r[2] != 0])
    print(f'\n⏱️ 共 {time.time() - t0:.0f} 秒;通過 {len(res) - len(fails)} / {len(res)}')
    if fails:
        print(f'\n❌ 失敗 {len(fails)} 條:')
        for i, c, rc, dt, log in fails:
            tail = log.read_text(encoding='utf-8', errors='replace').rstrip().split('\n')[-6:]
            print(f'\n#{i:03d} rc={rc}  {c[:150]}\n   log:{log}')
            for t in tail:
                print('   │ ' + t[:200])
        return 1
    print('✅ 四驗證全部通過')
    return 0


if __name__ == '__main__':
    sys.exit(main())
