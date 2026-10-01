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


def run(m, limit=None):
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

print('\n' + ('❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ PEBAND_CARRY_PASS'))
sys.exit(1 if fails else 0)
