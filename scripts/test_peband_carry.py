#!/usr/bin/env python3
"""📐 V78.1.2 `pe_band_miner.py`:這一輪「抓不到」的⛔ 不可從檔案裡消失

起因(2026-10-01 實測):FinMind 回 403×4,495 / 402×2,011(付費額度用完),2,369 檔只成功 618 檔,
舊版直接用這 618 檔整份覆蓋 → 線上 1,625 → 618,代號 6~9 開頭全部消失,workflow 全綠(618 ≥ MIN_OK)。

釘住(走真的 `main()`,只換掉網路層 `fm`):
  ① 這輪抓到的 → 用新值
  ② 這輪抓不到的(403/402/網路)→ 沿用上一輪那一筆(原封不動,`d` 仍是舊日期)
  ③ 歷史太短的 → 拿掉(那是資料本身的結論,⛔ 不沿用)
  ④ 跑到上限沒輪到的 → 也沿用
  ⑤ `n` = 檔案總檔數、`fresh` = 這輪抓到、`kept` = 沿用
  ⑥ 決定性對照:把沿用那段拿掉(注入)→ ② 必須紅
  ⑦ V78.1.3 輪動:沒舊值先抓,再照舊 d 由舊到新 ⑧ 連續 40 檔 402/403 → 收工
  ⑫ V78.1.4 額度用完會等、回來接著抓 ⑬ 不無限等
  ⑨ 部分成功且總數不縮 → 寫檔 rc 0 ⑩ 0 檔成功 → rc 1 ⑪ 第一次跑 < MIN_OK → 不產出(⑦⑧⑨ 各有注入)
"""
import importlib.util
import json
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []


def ok(n, c, e=''):
    print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {str(e)[:240]}'))
    if not c:
        fails.append(n)


def load(src_text=None):
    spec = importlib.util.spec_from_file_location('pbm', ROOT / 'pe_band_miner.py')
    m = importlib.util.module_from_spec(spec)
    if src_text is None:
        spec.loader.exec_module(m)
    else:
        exec(compile(src_text, 'pe_band_miner_inj.py', 'exec'), m.__dict__)
    return m


def rows_for(n, pe=10.0):
    return [{'date': f'2025-{(i // 28) % 12 + 1:02d}-{i % 28 + 1:02d}', 'PER': pe + (i % 7)} for i in range(n)]


class FakeClock:
    """假時鐘:sleep 只推進時間、不真的等(額度用完會等 15 分,測試不可真睡)。"""
    def __init__(self):
        self.t = 1_000_000.0
        self.slept = 0.0

    def time(self):
        return self.t

    def sleep(self, s):
        self.t += s
        self.slept += s

    def strftime(self, *a):
        import time as _t
        return _t.strftime(*a)

    def gmtime(self, *a):
        import time as _t
        return _t.gmtime(*a)


def run(m, limit=None):
    m.time = FakeClock()
    d = pathlib.Path(tempfile.mkdtemp())
    syms = ['1101', '2330', '3008', '6415', '9999']
    for s in syms:
        (d / f'{s}.json').write_text('[]')
    old = {s: {'pe': 1.0, 'pct': 50.0, 'lo': 1, 'hi': 2, 'p25': 1, 'med': 1.5, 'p75': 2, 'p5': 1, 'p95': 2, 'n': 300, 'd': '2026-09-01'}
           for s in ['1101', '2330', '3008', '6415', '9999']}
    (d / 'pe_band.json').write_text(json.dumps({'updated': 'x', 'data': old}))
    m.DATA = d; m.OUT = d / 'pe_band.json'; m.TOKENS = ['T1']; m.SLEEP = 0; m.MIN_OK = 1
    m.LIMIT = limit if limit is not None else 99999

    def fake(dataset, sym, start):
        if sym == '1101': return rows_for(400), None        # 抓到
        if sym == '2330': return None, 'http403'            # 額度用完
        if sym == '3008': return None, 'http402'
        if sym == '6415': return rows_for(50), None         # 歷史太短
        return rows_for(400, pe=20.0), None                 # 9999 抓到
    m.fm = fake
    rc = m.main()
    out = json.loads(m.OUT.read_text())
    return rc, out


m = load()
rc, out = run(m)
D = out['data']
ok('① 抓到的用新值(1101 的 d 不是舊的 2026-09-01)', rc == 0 and '1101' in D and D['1101']['d'] != '2026-09-01', D.get('1101'))
ok('② ⭐ 403/402 抓不到的沿用上一輪(2330 / 3008 原封不動)',
   D.get('2330', {}).get('d') == '2026-09-01' and D.get('3008', {}).get('pe') == 1.0, {k: D.get(k) for k in ('2330', '3008')})
ok('③ 歷史太短的拿掉(6415 ⛔ 不沿用)', '6415' not in D, list(D))
ok('⑤ n = 總檔數、fresh = 這輪抓到、kept = 沿用', out.get('n') == 4 and out.get('fresh') == 2 and out.get('kept') == 2, {k: out.get(k) for k in ('n', 'fresh', 'kept')})

# ④ 跑到上限:LIMIT=1 → 只處理 1101,其餘沒輪到的都要沿用(6415 也沒輪到 → 不知道它太短 → 沿用)
m4 = load()
rc4, out4 = run(m4, limit=1)
D4 = out4['data']
ok('④ 跑到上限沒輪到的也沿用(2330/3008/6415/9999 都在)',
   all(s in D4 and D4[s]['d'] == '2026-09-01' for s in ('2330', '3008', '6415', '9999')), list(D4))

# ⑥ 決定性對照:拿掉沿用(注入)→ ② 要紅
src = (ROOT / 'pe_band_miner.py').read_text(encoding='utf-8')
inj = src.replace("    old = {}\n    try:", "    old = {}\n    if False:\n      try:", 1)   # 舊版行為 = 根本不讀上一輪
inj = inj.replace("        old = (json.loads(OUT.read_text(encoding='utf-8')) or {}).get('data') or {}\n    except Exception:\n        old = {}",
                  "        old = (json.loads(OUT.read_text(encoding='utf-8')) or {}).get('data') or {}\n      except Exception:\n        old = {}", 1)
assert inj != src, '注入沒注進去'
mi = load(inj)
_, outi = run(mi)
ok('⑥ ⭐ 決定性對照:不讀上一輪(= 舊版)→ 2330 會消失(證明 ② 量得到)', '2330' not in outi['data'], list(outi['data']))

# ── V78.1.3 輪動 / 額度收工 / 部分寫檔 ──────────────────────────────
def run2(m, syms, old, fake, min_ok=300, quota=40, max_min=180):
    m.time = FakeClock(); m.MAX_MIN = max_min
    d = pathlib.Path(tempfile.mkdtemp())
    for s in syms:
        (d / f'{s}.json').write_text('[]')
    if old is not None:
        (d / 'pe_band.json').write_text(json.dumps({'updated': 'x', 'data': old}))
    m.DATA = d; m.OUT = d / 'pe_band.json'; m.TOKENS = ['T1']; m.SLEEP = 0; m.MIN_OK = min_ok
    m.LIMIT = 99999; m.QUOTA_STOP = quota
    m.fm = fake
    rc = m.main()
    out = json.loads(m.OUT.read_text()) if m.OUT.exists() else None
    return rc, out


def ent(d):
    return {'pe': 1.0, 'pct': 50.0, 'lo': 1, 'hi': 2, 'p25': 1, 'med': 1.5, 'p75': 2, 'p5': 1, 'p95': 2, 'n': 300, 'd': d}


def check_order(src_text=None):
    calls = []
    def f(ds, sym, st):
        calls.append(sym); return rows_for(400), None
    m = load(src_text)
    run2(m, ['1101', '2330', '3008', '6415'], {'1101': ent('2026-09-20'), '2330': ent('2026-08-01'), '3008': ent('2026-09-01')}, f, min_ok=1)
    return calls


calls = check_order()
ok('⑦ 輪動:沒有舊值的先抓(6415),再照舊 d 由舊到新(2330 → 3008 → 1101)', calls == ['6415', '2330', '3008', '1101'], calls)


def check_quota(src_text=None):
    calls = []
    def f(ds, sym, st):
        calls.append(sym); return None, 'http403'
    m = load(src_text)
    syms = [str(1000 + i) for i in range(200)]
    rc, _ = run2(m, syms, {s: ent('2026-09-01') for s in syms}, f, quota=40)
    return calls, rc


calls_q, rc_q = check_quota()
# 全部 403、MAX_MIN 180 → 40 檔之後只「每 15 分試 1 次」:40 + 等待次數(≤ 180/15 = 12)
ok('⑧ 💳 全部 403 → 連續 40 檔後不再逐檔空打(只每 15 分試 1 次,總呼叫 ≤ 40+12)', 40 < len(calls_q) <= 52, len(calls_q))

syms9 = [str(1000 + i) for i in range(10)]
def f9(ds, sym, st):
    return (rows_for(400), None) if sym in ('1000', '1001') else (None, 'http403')
rc9, out9 = run2(load(), syms9, {s: ent('2026-09-01') for s in syms9}, f9, min_ok=300)
ok('⑨ 部分成功(2 < MIN_OK)但總數不縮 → rc 0、寫出、fresh=2 kept=8',
   rc9 == 0 and out9 and out9.get('fresh') == 2 and out9.get('kept') == 8 and out9.get('n') == 10,
   (rc9, out9 and {k: out9.get(k) for k in ('n', 'fresh', 'kept')}))

rc10, out10 = run2(load(), syms9, {s: ent('2026-09-01') for s in syms9}, lambda ds, s, st: (None, 'http403'))
ok('⑩ 一檔都沒抓到 → rc 1、舊檔不動(updated 仍是 x)', rc10 == 1 and out10.get('updated') == 'x', (rc10, out10 and out10.get('updated')))

rc11, out11 = run2(load(), syms9, None, f9, min_ok=300)
ok('⑪ 第一次跑(沒舊檔)成功 < MIN_OK → rc 1、不產出', rc11 == 1 and out11 is None, (rc11, out11))

# 注入:拿掉排序 / 拿掉收工 / 退回舊守門 → 對應那條要紅
src2 = (ROOT / 'pe_band_miner.py').read_text(encoding='utf-8')
i1 = src2.replace("queue, retry, qi = list(order), [], 0", "queue, retry, qi = list(syms), [], 0", 1)
assert i1 != src2
ok('⑦i 注入「不輪動」→ ⑦ 必須紅', check_order(i1) != ['6415', '2330', '3008', '1101'])
i2 = src2.replace("        if quota_streak >= QUOTA_STOP:", "        if False:", 1)
assert i2 != src2
ok('⑧i 注入「不收工」→ ⑧ 必須紅', not (40 < len(check_quota(i2)[0]) <= 52))
i3 = src2.replace("    if ok == 0:", "    if ok < MIN_OK:", 1)
assert i3 != src2
rc9i, _ = run2(load(i3), syms9, {s: ent('2026-09-01') for s in syms9}, f9, min_ok=300)
ok('⑨i 注入「退回 ok < MIN_OK 就不寫」→ ⑨ 必須紅', rc9i == 1)

# ── V78.1.4 額度回來了要接著抓,⛔ 不可直接收工 ────────────────────
def check_resume(src_text=None):
    n = {'c': 0}
    def f(ds, sym, st):
        n['c'] += 1
        return (None, 'http403') if n['c'] <= 45 else (rows_for(400), None)
    m = load(src_text)
    syms = [str(1000 + i) for i in range(100)]
    rc, out = run2(m, syms, {s: ent('2026-09-01') for s in syms}, f, min_ok=1, max_min=150)
    return rc, out, m.time.slept


rc12, out12, slept12 = check_resume()
ok('⑫ 額度用完 → 等(假時鐘 ≥ 15 分)→ 額度回來後 100 檔全部抓到(含剛才失敗那 40 檔)',
   rc12 == 0 and out12 and out12.get('fresh') == 100 and slept12 >= 900, (rc12, out12 and out12.get('fresh'), slept12))
rc13, _, slept13 = (lambda r: (r[1], None, None))(check_quota())
m13 = load()
syms13 = [str(1000 + i) for i in range(200)]
run2(m13, syms13, {s: ent('2026-09-01') for s in syms13}, lambda d, s, st: (None, 'http403'), max_min=150)
ok('⑬ 一直 403 → 等到 MAX_MIN 就收工(假時鐘不超過 150 分)', m13.time.slept <= 150 * 60, m13.time.slept)
i12 = src2.replace("            resumed = False\n", "            resumed = False\n            break\n", 1)
assert i12 != src2
_rc, _o, _ = check_resume(i12)
ok('⑫i 注入「不等、直接收工」(= V78.1.3)→ ⑫ 必須紅', not (_o and _o.get('fresh') == 100), _o and _o.get('fresh'))

# ── ⑭ V78.2.5 workflow 守門「今天已經跑過就跳過」:比台北日期 + 半成品不算 ──
#   ⭐ 從 yaml 抽出那段原始 shell 實跑(⛔ 測試裡不複製一份判斷),`date` 用假的(FAKE_NOW 給 UTC 時間)
import os, shutil, subprocess
try:
    import yaml as _yaml
except Exception:
    _yaml = None


def _guard_script():
    if _yaml is None:
        return None
    wf = _yaml.safe_load(open(ROOT / '.github/workflows/pe_band.yml', encoding='utf-8'))
    for st in wf['jobs']['peband']['steps']:
        if st.get('id') == 'guard':
            return st['run'].replace('${{ github.event_name }}', 'schedule')
    return None


def run_guard(script, updated, n, now_utc):
    d = pathlib.Path(tempfile.mkdtemp())
    (d / 'data').mkdir()
    json.dump({'updated': updated, 'n': n, 'data': {}}, open(d / 'data/pe_band.json', 'w'))
    fb = d / 'bin'
    fb.mkdir()
    real = shutil.which('date')
    (fb / 'date').write_text('#!/bin/sh\nexec ' + real + ' -d "$FAKE_NOW" "$@"\n')   # 假 date:吃 TZ 與 -u
    os.chmod(fb / 'date', 0o755)
    out = d / 'gh_out'
    env = dict(os.environ, PATH=f'{fb}:{os.environ["PATH"]}', FAKE_NOW=now_utc + ' UTC', GITHUB_OUTPUT=str(out))
    r = subprocess.run(['bash', '-c', script], cwd=d, env=env, capture_output=True, text=True)
    res = (out.read_text() if out.exists() else '') + r.stdout + r.stderr
    shutil.rmtree(d, ignore_errors=True)
    return 'skip=yes' in res, res


G = _guard_script()
if G is None:
    ok('⑭ 讀得到 pe_band.yml 的守門那一步(要 PyYAML)', False, 'yaml 模組或 id=guard 的步驟不見了')
else:
    s1, o1 = run_guard(G, '2026-10-01T00:10:54Z', 1625, '2026-10-01 22:49')
    ok('⑭a 10-01 00:10Z 寫的、10-01 22:49Z(台北 10-02)開跑 → 照跑(⛔ 不可被 UTC 同日騙過)', not s1, o1[-300:])
    s2, o2 = run_guard(G, '2026-10-01T18:40:00Z', 1625, '2026-10-01 19:30')
    ok('⑭b 同一個台北日、完整(1,625 檔)→ 跳過', s2, o2[-300:])
    s3, o3 = run_guard(G, '2026-10-01T18:40:00Z', 618, '2026-10-01 19:30')
    ok('⑭c 同一個台北日但只有 618 檔(半成品)→ 照跑補齊', not s3, o3[-300:])
    s4, o4 = run_guard(G, '2026-10-02T03:30:00+08:00', 1625, '2026-10-01 20:00')
    ok('⑭d 產物時間帶 +08:00 也換算得對 → 跳過', s4, o4[-300:])
    G_utc = G.replace('TZ=Asia/Taipei date +%F', 'date -u +%F').replace('hours=8', 'hours=0')
    s5, _ = run_guard(G_utc, '2026-10-01T00:10:54Z', 1625, '2026-10-01 22:49')
    ok('⑭i 注入「退回 UTC」→ ⑭a 的情境會被誤判跳過(必須紅)', s5)
    G_full = G.replace('-ge "$PEB_FULL_N"', '-ge 0')
    s6, _ = run_guard(G_full, '2026-10-01T18:40:00Z', 618, '2026-10-01 19:30')
    ok('⑭i2 注入「半成品也算」→ ⑭c 的情境會被跳過(必須紅)', s6)

print('\n' + ('❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ PEBAND_CARRY_PASS'))
sys.exit(1 if fails else 0)
