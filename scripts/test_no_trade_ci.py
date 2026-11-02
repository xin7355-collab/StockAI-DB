#!/usr/bin/env python3
"""🔐 V80.1.9 「下單程式 ⛔ 進 workflow」守門的兩個繞路(check_workflow_paths.check_no_trading_in_ci)。

① 不帶 .py(`python -m auto_trade` / `-c "import auto_trade"`)② 換一層包裝:workflow 跑的 .py 自己 import auto_trade
決定性對照:test_*.py import auto_trade(用假券商、沒有憑證)⛔ 誤擋;什麼都沒有 → 照過。
跑法:python3 scripts/test_no_trade_ci.py
"""
import contextlib
import io
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_workflow_paths as C  # noqa: E402

FAILS = []


def ok(name, cond, got=''):
    print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
    if not cond:
        FAILS.append(name)


def run(files):
    tmp = Path(tempfile.mkdtemp())
    (tmp / '.github' / 'workflows').mkdir(parents=True)
    for rel, body in files.items():
        p = tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding='utf-8')
    C.ROOT, C.WF_DIR = tmp, tmp / '.github' / 'workflows'
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        res = C.check_no_trading_in_ci()
    return res, buf.getvalue()


WF = 'name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: {}\n'
real_root, real_wf = C.ROOT, C.WF_DIR
try:
    r, out = run({'.github/workflows/a.yml': WF.format('python3 miner.py'), 'miner.py': 'print(1)\n'})
    ok('⓪ 什麼都沒有 → 照過', r is True, out)
    r, out = run({'.github/workflows/a.yml': WF.format('python3 auto_trade.py')})
    ok('① 原本那條:寫了 auto_trade.py → 擋', r is False and 'auto_trade.py' in out, out)
    r, out = run({'.github/workflows/a.yml': WF.format('python3 -m auto_trade')})
    ok('② 不帶 .py(-m)→ 擋', r is False and '沒寫 .py' in out, out)
    r, out = run({'.github/workflows/a.yml': WF.format('python3 -c "import auto_trade"')})
    ok('②b 不帶 .py(-c import)→ 擋', r is False, out)
    r, out = run({'.github/workflows/a.yml': WF.format('python3 scripts/wrap.py'),
                  'scripts/wrap.py': 'import os\nfrom auto_trade import main\nmain()\n'})
    ok('③ 換一層包裝:workflow 跑的 .py 自己 import auto_trade → 擋', r is False and 'wrap.py' in out, out)
    r, out = run({'.github/workflows/a.yml': WF.format('python3 scripts/wrap2.py'),
                  'scripts/wrap2.py': 'import importlib\nm = importlib.import_module("auto_trade")\n'})
    ok('③b importlib 用字串載入 → 擋', r is False, out)
    r, out = run({'.github/workflows/a.yml': WF.format('python3 scripts/test_auto_send.py'),
                  'scripts/test_auto_send.py': 'import auto_trade\n'})
    ok('④ 決定性對照:test_*.py(假券商、沒有憑證)⛔ 誤擋', r is True, out)
finally:
    C.ROOT, C.WF_DIR = real_root, real_wf
r, out = C.check_no_trading_in_ci(), ''
ok('⑤ 這個 repo 現在的 workflow 全部照過(⛔ 誤擋)', r is True)
print(f'\n{"✅ 全過" if not FAILS else "❌ 失敗 " + str(len(FAILS)) + " 條"}(共 8 條)')
sys.exit(1 if FAILS else 0)
