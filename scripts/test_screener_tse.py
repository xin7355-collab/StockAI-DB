#!/usr/bin/env python3
"""🏷️ V79.7.9 screener `tse`(上市一般股)判定 —— 選股頁「只看上市 / 只看上櫃」兩個篩選讀這一欄。

🚨 以前 `tse = 1 if 有官方產業代碼`:V76.4.0 起 industry_map.json 也收上櫃 → 上櫃 1,000 多檔全被算成上市
   (實測 gh-pages:2,496 檔裡 tse=1 有 1,983 檔,中美晶 5483 / 穩懋 3105 / 環球晶 6488 都是 1)。
⭐ 現在看 stock_names.json 第三欄的市場別(twse / tpex / emerging),沒有市場別才退回舊判斷。

測試走**正式入口** `screener_miner.main()`(暫存 DATA_DIR,真的寫 screener.json 再讀回來),
⭐ 決定性對照:同一份資料拿掉 stock_names.json → 退回舊判斷,上櫃那檔又變成 1(= 舊 bug 重現)。
"""
import json, os, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import screener_miner as S  # noqa: E402

fails = []
def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else '  ' + str(extra)[:300]))
    if not cond:
        fails.append(name)

# ① 純函式
f = S._tse_of
M = {'2330': 'twse', '5483': 'tpex', '0050': 'twse', '7777': 'emerging'}
ok('① 上市一般股 → 1', f('2330', '24', M) == 1)
ok('② 🚨 上櫃有產業代碼也是 0(舊判斷會給 1)', f('5483', '24', M) == 0)
ok('③ ETF 沒有產業代碼 → 0(這一欄是「上市一般股」)', f('0050', None, M) == 0)
ok('④ 興櫃 → 0', f('7777', '24', M) == 0)
ok('⑤ 沒有市場別 → 退回舊判斷(有產業代碼 = 1、沒有 = 0)', f('9999', '24', M) == 1 and f('9998', None, M) == 0)

# ② 正式入口
def bars(n=300, base=100.0):
    out = []
    for i in range(n):
        c = base * (1 + 0.001 * (i % 7))
        out.append({'date': f'2026/{1 + i // 28:02d}/{1 + i % 28:02d}', 'open': c, 'high': c * 1.01,
                    'low': c * 0.99, 'close': c, 'volume': 1_000_000 + i})
    return out

def run(with_names):
    d = Path(tempfile.mkdtemp(prefix='tse_'))
    syms = {'2330': ('24', 'twse'), '5483': ('24', 'tpex'), '0050': (None, 'twse'), '7777': ('24', 'emerging')}
    imap = {}
    names = {}
    for s_, (code, mk) in syms.items():
        (d / f'{s_}.json').write_text(json.dumps(bars()), encoding='utf-8')
        if code:
            imap[s_] = code
        names[s_] = [s_, code or '', mk]
    (d / 'industry_map.json').write_text(json.dumps(imap), encoding='utf-8')
    if with_names:
        (d / 'stock_names.json').write_text(json.dumps({'names': names}), encoding='utf-8')
    env = dict(os.environ, DATA_DIR=str(d), SCREENER_MIN_OK='1')
    r = subprocess.run([sys.executable, '-I', str(ROOT / 'screener_miner.py')], env=env,
                       capture_output=True, text=True, cwd=str(d))
    p = d / 'screener.json'
    if r.returncode != 0 or not p.exists():
        return None, (r.stdout + r.stderr)[-600:]
    j = json.loads(p.read_text(encoding='utf-8'))
    i = j['cols'].index('tse')
    return {s_: v[i] for s_, v in j['rows'].items()}, ''

got, log = run(True)
ok('⑥ 正式入口跑得起來而且四檔都在', got is not None and len(got) == 4, log)
if got:
    ok('⑦ 寫出來的 tse:2330=1、5483=0、0050=0、7777=0', got == {'2330': 1, '5483': 0, '0050': 0, '7777': 0}, got)
old, log2 = run(False)
ok('⑧ ⭐ 決定性對照:拿掉 stock_names.json → 退回舊判斷,上櫃 5483 又變成 1(= 舊 bug)',
   old is not None and old.get('5483') == 1 and old.get('2330') == 1, old or log2)

src = (ROOT / 'screener_miner.py').read_text(encoding='utf-8')
ok('⑨ main 只透過 _tse_of 寫 tse(⛔ 不可再出現 `1 if code else 0` 直接寫進 tse)',
   "v[CI['tse']] = _tse_of(" in src and "v[CI['tse']] = 1 if code else 0" not in src)

print('\n❌ %d 條失敗' % len(fails) if fails else '\n✅ SCREENER_TSE_PASS')
sys.exit(1 if fails else 0)
