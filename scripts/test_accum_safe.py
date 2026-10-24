#!/usr/bin/env python3
"""🩺 累積檔讀壞了 ⛔ 當成「本來沒有」(2026-10-24 巡邏,陷阱 #61 的第二波)

「讀自己上一份 → 加上今天 → 寫回」的檔,舊寫法 `except: = {}` → 用今天一天蓋掉整段歷史
(10/24 #647 confcall / pick_history 就是這樣差點歸零)。這次把其餘的也接上 lib_jsonsafe:
  尾巴多一段 → 用前面那份完整的往下走;真的救不回來 → ⛔ 寫回(壞檔一個位元組都不動,等人修)。

① 靜態:每一處都改走 lib_jsonsafe,舊寫法 ⛔ 不可回來
② 走正式入口(⛔ 打網路:網路那一步換成「走到這裡就停」的假函式):
   etf_miner / tdcc_sweep / rotation_miner / pe_band_miner / fund_sweep / paper_trade / dividend_miner
   壞檔 → ⛔ 寫、壞檔沒動;尾巴多一段 → 往下走;⭐ 決定性對照:同一份內容完整 → 照常往下走
"""
import ast
import importlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

RES = []


def ok(name, cond, info=''):
    RES.append((name, bool(cond)))
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  ← {str(info)[:300]}'))


class Reached(BaseException):
    """網路那一步換成這個:丟出來 = 讀檔那一關過了、正常往下走(BaseException → ⛔ 被程式自己的 except Exception 吞掉)"""


def _reach(*a, **k):
    raise Reached()


def src(f):
    return (ROOT / f).read_text(encoding='utf-8')


def no_comment(s):
    return '\n'.join(re.sub(r'#.*$', '', ln) for ln in s.splitlines())


TMP = Path(tempfile.mkdtemp())
FULL = {'d': {'2026-10-22': [1, 2, 3, 4]}, 'etfs': [{'symbol': '00981A', 'chg_hist': [['2026-10-22', ['2330']]]}]}
GOOD = json.dumps(FULL, ensure_ascii=False)
SALV = GOOD + '"]}],"old":1}'          # #647 的形狀:完整 JSON + 舊版的尾巴
BAD = GOOD[:len(GOOD) // 2]            # 截斷 = 救不回來


def put(p, raw):
    Path(p).write_text(raw, encoding='utf-8')
    return Path(p).read_bytes()


# ───────── ① 靜態:舊寫法 ⛔ 回來 ─────────
STATIC = [
    ('tick_flow_miner.py', "load_accum(_Path(hist_path)", 'tick_hist.json'),
    ('macro_miner.py', "load_accum(rh_file", 'risk_history.json'),
    ('radar_miner.py', "load_accum(HIST_FILE", 'attention_history.json'),
    ('etf_miner.py', "load_accum(OUT", 'etf_tracking.json'),
    ('tdcc_sweep.py', "load_accum(_Path(OUT_FILE)", 'tdcc_holders.json'),
    ('pe_band_miner.py', "load_accum(OUT", 'pe_band.json'),
    ('fund_sweep.py', "load_accum(OUT_PATH", 'fund_yoy_gm.json'),
    ('rotation_miner.py', "load_accum(OUT", 'fundamentals_rotation.json'),
    ('paper_trade.py', "load_accum(OUTPUT_FILE", 'paper_trades.json'),
    ('dividend_miner.py', "load_accum(path", 'dividends_hist.json'),
    ('miner.py', "load_json_safe(_bd_path", 'breadth.json'),
]
for f, marker, what in STATIC:
    ok(f'① {f}({what})改走 lib_jsonsafe', marker in no_comment(src(f)), marker)

# 舊寫法:同一個 try 裡讀檔、except 直接把累積的東西設成空的
OLD_PAT = [
    ('tick_flow_miner.py', r"except Exception:\s*\n\s*hist = \{\}"),
    ('macro_miner.py', r"except Exception:\s*\n\s*hist = \[\]"),
    ('radar_miner.py', r"except Exception:\s*\n\s*hist = \{\}"),
    ('tdcc_sweep.py', r"舊檔解析失敗\(忽略,重建\)"),
    ('pe_band_miner.py', r"except Exception:\s*\n\s*old = \{\}"),
    ('fund_sweep.py', r"讀舊 \{OUT_PATH\} 失敗"),
    ('rotation_miner.py', r"parse 失敗,重建"),
    ('paper_trade.py', r"def _read_trades\(\):(?:(?!\ndef ).)*?except Exception:\s*\n\s*return \[\]"),
    ('miner.py', r"except Exception:\s*\n\s*_bd = \{\}"),
]
for f, pat in OLD_PAT:
    ok(f'① {f} 舊的「讀壞了當成沒有」⛔ 回來', not re.search(pat, no_comment(src(f)), re.S), pat)

# 讀不出來那條路真的會讓寫回那行跑不到(raise / return / exit 在寫檔之前)
for f, guard, write in [
    ('tick_flow_miner.py', "raise RuntimeError('tick_hist.json", "json.dump(hist, f"),
    ('macro_miner.py', "raise RuntimeError('risk_history.json", "rh_file.write_text("),
    ('radar_miner.py', "raise RuntimeError('attention_history.json", "HIST_FILE.write_text("),
]:
    s = src(f)
    ok(f'① {f}:讀不出來就在寫回之前停下(raise 在 write 之前)', guard in s and s.index(guard) < s.index(write), guard)


# ───────── ② 走正式入口 ─────────
def fresh(mod):
    if mod in sys.modules:
        del sys.modules[mod]
    return importlib.import_module(mod)


# ── etf_miner ──
E = fresh('etf_miner')
E.OUT = TMP / 'etf_tracking.json'
E.list_active_etfs = _reach
b = put(E.OUT, BAD)
try:
    rc = E.main()
except Reached:
    rc = 'reached'
ok('② etf_miner:上一份救不回來 → main 回 1、⛔ 抓、壞檔沒動', rc == 1 and E.OUT.read_bytes() == b, rc)
for name, raw in (('內容完整(⭐ 決定性對照)', GOOD), ('尾巴多一段', SALV)):
    put(E.OUT, raw)
    try:
        E.main(); hit = False
    except Reached:
        hit = True
    ok(f'② etf_miner:{name} → 讀過那一關、照常往下走', hit)
put(E.OUT, SALV)
ok('② etf_miner:尾巴多一段 → 換股紀錄用前面那份(⛔ 變成空的)',
   (E.load_prev_tracking() or {}).get('etfs', [{}])[0].get('chg_hist') == FULL['etfs'][0]['chg_hist'])
E.OUT.unlink()
ok('② etf_miner:檔案不在(第一次跑)→ None,照舊從頭建', E.load_prev_tracking() is None)

# ── tdcc_sweep ──
T = fresh('tdcc_sweep')
T.OUT_FILE = str(TMP / 'tdcc_holders.json')
T.fetch_csv = _reach
b = put(T.OUT_FILE, BAD)
try:
    T.main(); code = 'no-exit'
except SystemExit as e:
    code = e.code
except Reached:
    code = 'reached'
ok('② tdcc_sweep:上一份救不回來 → exit 1、⛔ 下載、壞檔沒動', code == 1 and Path(T.OUT_FILE).read_bytes() == b, code)
for name, raw in (('內容完整(⭐ 決定性對照)', json.dumps({'2330': {'h': [1]}})), ('尾巴多一段', json.dumps({'2330': {'h': [1]}}) + '}x')):
    put(T.OUT_FILE, raw)
    try:
        T.main(); hit = False
    except Reached:
        hit = True
    except SystemExit:
        hit = False
    ok(f'② tdcc_sweep:{name} → 讀過那一關、照常去下載', hit)

# ── rotation_miner ──
R = fresh('rotation_miner')
RD = TMP / 'rot'
RD.mkdir()
for s in ('2330', '2317', '1101'):
    (RD / f'{s}.json').write_text('[]', encoding='utf-8')
R.DATA, R.OUT = RD, RD / 'fundamentals_rotation.json'
R.fetch_one = _reach
b = put(R.OUT, BAD)
try:
    R.main(); code = 'no-exit'
except SystemExit as e:
    code = e.code
except Reached:
    code = 'reached'
ok('② rotation_miner:上一份救不回來 → exit 1、⛔ 抓、壞檔沒動', code == 1 and R.OUT.read_bytes() == b, code)
for name, raw in (('內容完整(⭐ 決定性對照)', json.dumps({'__cursor': 1, '2330': {}})), ('尾巴多一段', json.dumps({'__cursor': 1}) + ']}')):
    put(R.OUT, raw)
    try:
        R.main(); hit = False
    except Reached:
        hit = True
    except SystemExit:
        hit = False
    ok(f'② rotation_miner:{name} → 讀過那一關、照常去抓', hit)

# ── pe_band_miner ──
P = fresh('pe_band_miner')
PD = TMP / 'pe'
PD.mkdir()
(PD / '2330.json').write_text('[]', encoding='utf-8')
P.DATA, P.OUT, P.TOKENS = PD, PD / 'pe_band.json', ['tok']
P.fm = _reach
b = put(P.OUT, BAD)
try:
    rc = P.main()
except Reached:
    rc = 'reached'
ok('② pe_band_miner:上一份救不回來 → 回 1、⛔ 抓(⛔ 當成第一次跑只寫這輪抓到的)、壞檔沒動', rc == 1 and P.OUT.read_bytes() == b, rc)
for name, raw in (('內容完整(⭐ 決定性對照)', json.dumps({'data': {'2330': {'d': '2026-10-01'}}})),
                  ('尾巴多一段', json.dumps({'data': {'2330': {'d': '2026-10-01'}}}) + '}}')):
    put(P.OUT, raw)
    try:
        P.main(); hit = False
    except Reached:
        hit = True
    ok(f'② pe_band_miner:{name} → 讀過那一關、照常去抓', hit)

# ── fund_sweep(merge:老檔打底 + 這晚的 shard)──
F = fresh('fund_sweep')
FD = TMP / 'fund'
FD.mkdir()
F.DATA_DIR, F.OUT_PATH, F.FC_PATH = FD, FD / 'fund_yoy_gm.json', FD / 'fundamentals_cache.json'
F.FC_PATH.write_text(json.dumps({'2330': {}, '2317': {}}), encoding='utf-8')
(FD / 'fund_yoy_gm.shard0.json').write_text(json.dumps({'2317': {'yoy': 5.0}, '__shard': {'hits': 999}}), encoding='utf-8')
b = put(F.OUT_PATH, BAD)
rc = F.merge_mode()
ok('② fund_sweep merge:上一份救不回來 → 回 2(⛔ 部署)、⛔ 只用這晚的 shard 蓋掉全市場、壞檔沒動',
   rc == 2 and F.OUT_PATH.read_bytes() == b, rc)
put(F.OUT_PATH, json.dumps({'2330': {'yoy': 1.0}}))
rc = F.merge_mode()
m = json.loads(F.OUT_PATH.read_text(encoding='utf-8'))
ok('② fund_sweep merge:⭐ 決定性對照:內容完整 → 合併(老的 2330 還在 + 這晚的 2317)', rc == 0 and '2330' in m and m.get('2317', {}).get('yoy') == 5.0, (rc, m))
put(F.OUT_PATH, json.dumps({'2330': {'yoy': 1.0}}) + '}x')
rc = F.merge_mode()
m = json.loads(F.OUT_PATH.read_text(encoding='utf-8'))
ok('② fund_sweep merge:尾巴多一段 → 用前面那份合併(老的 2330 還在)', rc == 0 and '2330' in m, (rc, m))
F.OUT_PATH.unlink()
F.load_existing()
ok('② fund_sweep:檔案不在(第一次跑)→ 可以寫', F._EXISTING_BAD is False)

# ── paper_trade ──
PT = fresh('paper_trade')
PT.OUTPUT_FILE = TMP / 'paper_trades.json'
PT.record_today_signals = _reach
b = put(PT.OUTPUT_FILE, BAD)
try:
    rc = PT.main()
except Reached:
    rc = 'reached'
ok('② paper_trade:上一份救不回來 → 回 1、⛔ 寫(⛔ 把累積的紙上交易蓋成只剩今天)、壞檔沒動',
   rc == 1 and PT.OUTPUT_FILE.read_bytes() == b, rc)
for name, raw in (('內容完整(⭐ 決定性對照)', json.dumps({'trades': [{'symbol': '2330'}]})),
                  ('尾巴多一段', json.dumps({'trades': [{'symbol': '2330'}]}) + '}]}')):
    put(PT.OUTPUT_FILE, raw)
    try:
        PT.main(); hit = False
    except Reached:
        hit = True
    ok(f'② paper_trade:{name} → 讀過那一關、照常往下走', hit)
PT.OUTPUT_FILE.unlink()
ok('② paper_trade:檔案不在(第一次跑)→ 空的開始', PT._read_trades() == [])

# ── dividend_miner(main 前面要先打網路探路 → 這裡直接問 load_old,外加 main 的接線)──
D = fresh('dividend_miner')
dp = TMP / 'dividends_hist.json'
put(dp, json.dumps({'d': {'2330': {'h': [['2026-07-01', 4.5]]}}}) + ']}')
ok('② dividend_miner:尾巴多一段 → 用前面那份的 d', D.load_old(dp) == {'2330': {'h': [['2026-07-01', 4.5]]}})
put(dp, BAD)
ok('② dividend_miner:救不回來 → None', D.load_old(dp) is None)
dp.unlink()
ok('② dividend_miner:檔案不在 → {}(第一次跑)', D.load_old(dp) == {})
ds = no_comment(src('dividend_miner.py'))
ok('② dividend_miner:main 讀到 None → 在抓之前回 1', re.search(r"old = load_old\(OUT_HIST\)\n\s+if old is None:\n[^\n]*\n\s+return 1", ds) is not None)

bad = [n for n, c in RES if not c]
print(f"\n{'✅' if not bad else '❌'} ACCUM_SAFE {len(RES) - len(bad)}/{len(RES)}")
sys.exit(1 if bad else 0)
