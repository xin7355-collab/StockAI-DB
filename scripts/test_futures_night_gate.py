#!/usr/bin/env python3
"""🏀 V78.1.4 個股期貨「夜盤」採礦⛔ 不可在日盤時段寫檔(stock_futures_miner._is_day_session)

起因(2026-10-01):這支跟在 theme_news 後面跑,theme_news 排程被延遲到台北 09:26
→ stock_futures_night.json 的 ts =「10/01 09:30」= 日盤資料標成夜盤。
① 平日 09:30 / 13:00 / 14:59 → 日盤(擋)
② 平日 22:00 / 07:30 / 08:44 / 15:00 → 不擋
③ 週六 10:00 → 不擋(沒有日盤)
④ main() 在日盤時段:不登入、不寫檔、rc≠0(走真的 main,shioaji 打樁成「被叫到就爆」)
⑤ 決定性對照:注入「守門恆 False」→ ④ 必紅
"""
import importlib.util, os, pathlib, sys, tempfile, types
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []


def ok(n, c, e=''):
    print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {e}'))
    if not c:
        fails.append(n)


def load(src=None):
    spec = importlib.util.spec_from_file_location('sfm', ROOT / 'stock_futures_miner.py')
    m = importlib.util.module_from_spec(spec)
    if src is None:
        spec.loader.exec_module(m)
    else:
        exec(compile(src, 'sfm_inj.py', 'exec'), m.__dict__)
    return m


m = load()
T = m.TW
d = lambda y, mo, da, h, mi: datetime(y, mo, da, h, mi, tzinfo=T)
ok('① 平日 09:30 是日盤', m._is_day_session(d(2026, 10, 1, 9, 30)))
ok('① 平日 13:00 是日盤', m._is_day_session(d(2026, 10, 1, 13, 0)))
ok('① 平日 14:59 是日盤', m._is_day_session(d(2026, 10, 1, 14, 59)))
ok('② 平日 22:00 不擋', not m._is_day_session(d(2026, 10, 1, 22, 0)))
ok('② 平日 07:30 不擋', not m._is_day_session(d(2026, 10, 1, 7, 30)))
ok('② 平日 08:44 不擋', not m._is_day_session(d(2026, 10, 1, 8, 44)))
ok('② 平日 15:00 不擋', not m._is_day_session(d(2026, 10, 1, 15, 0)))
ok('③ 週六 10:00 不擋', not m._is_day_session(d(2026, 10, 3, 10, 0)))


def run_main(mod):
    called = {'login': False}

    class Boom:
        def __init__(self, *a, **k):
            called['login'] = True
            raise RuntimeError('不該登入')
    sys.modules['shioaji'] = types.SimpleNamespace(Shioaji=Boom)
    os.environ['SHIOAJI_API_KEY'] = 'x'
    os.environ['SHIOAJI_SECRET_KEY'] = 'y'
    mod._is_day_session = (lambda dt=None: True) if not getattr(mod, '_force_off', False) else mod._is_day_session
    cwd = os.getcwd()
    tmp = tempfile.mkdtemp()
    os.chdir(tmp)
    rc = 0
    try:
        mod.main()
    except SystemExit as e:
        rc = e.code
    except RuntimeError:
        rc = 'login'
    finally:
        os.chdir(cwd)
    return rc, called['login'], os.path.exists(os.path.join(tmp, 'stock_futures_night.json'))


rc, logged, wrote = run_main(m)
ok('④ 日盤時段:不登入、不寫檔、rc≠0', rc not in (0, None) and not logged and not wrote, (rc, logged, wrote))

src = (ROOT / 'stock_futures_miner.py').read_text(encoding='utf-8')
inj = src.replace('    if _is_day_session():\n', '    if False:\n', 1)
assert inj != src, '注入沒注進去'
mi = load(inj)
mi._force_off = True
rc2, logged2, _ = run_main(mi)
ok('⑤ 決定性對照:拿掉守門 → 會去登入(證明 ④ 量得到)', logged2 or rc2 == 'login', (rc2, logged2))

print('\n' + ('❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ FUT_NIGHT_GATE_PASS'))
sys.exit(1 if fails else 0)
