#!/usr/bin/env python3
"""全市場 P/B 分位數(V71.6.2 修 market_stats.json 從沒產出)離線測試。

真因不是「TWSE 抓不到 P/B」,是 miner.py 組 fund_cache 時把 pbr 丟掉了
→ compute_market_pb_percentiles 樣本恆為 0 → 恆回 {} → 檔案永遠不寫。
這裡固定住:① pbr 讀得到 ② 樣本不足要**印出實際數字**(舊訊息只寫「< 50」,
所以「恆為 0」跟「今天只有 40」長得一樣,這才是躲過診斷這麼久的原因)。
"""
import io
import os
import re
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_MAIN', '1')
for _m in ('yfinance', 'pandas', 'numpy'):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)

import miner as M   # noqa: E402

C = M.compute_market_pb_percentiles
fails = []


def eq(name, got, want):
    ok = got == want
    print(f"{'✅' if ok else '❌'} {name}: {got!r}" + ('' if ok else f' (期望 {want!r})'))
    if not ok:
        fails.append(name)


def cap(fn, *a):
    buf = io.StringIO()
    with redirect_stdout(buf):
        r = fn(*a)
    return r, buf.getvalue()

# ── ① 這就是修之前的實際狀態:876 檔有 pe/yield 但一個 pb 都沒有 → 回 {} ──
no_pb = {str(1100 + i): {'pe': 11.0, 'yield_rate': 7.0} for i in range(876)}
r, log = cap(C, no_pb)
eq('① 全無 pb → 回 {}', r, {})
eq('① log 要印「掃 876 檔」', '掃 876 檔' in log, True)
eq('① log 要印「有 pb/pbr 欄 0 檔」', '有 pb/pbr 欄 0 檔' in log, True)

# ── ② 讀得到 pbr(TWSE BWIBBU_d 的欄名就是 pbr)──
ok_pb = {str(1100 + i): {'pe': 11.0, 'pbr': 1.0 + (i % 40) * 0.1} for i in range(200)}
r, log = cap(C, ok_pb)
eq('② 有 pbr → 有結果', bool(r), True)
eq('② count', r.get('count'), 200)
eq('② 分位數遞增', r['p25'] <= r['p50'] <= r['p75'] <= r['p90'], True)

# ── ③ 'pb' 這個舊欄名也要吃(相容)──
r3, _ = cap(C, {str(i): {'pb': 1.5} for i in range(60)})
eq('③ pb 舊欄名也吃', r3.get('count'), 60)

# ── ④ __status 這種 meta 鍵不可算進 total ──
mixed = {str(1100 + i): {'pbr': 2.0} for i in range(60)}
mixed['__status'] = {'base': 'TWSE'}
r4, log4 = cap(C, mixed)
eq('④ meta 鍵不算檔數', r4.get('count'), 60)
eq('④ scanned 不含 __status', r4.get('scanned'), 60)

# ── ⑤ 離譜值濾掉(0 或 ≥50 是資料髒,不是真的 P/B)──
dirty = {str(1100 + i): {'pbr': 2.0} for i in range(55)}
dirty.update({f'9{i}': {'pbr': v} for i, v in enumerate([0, -1, 50, 99999])})
r5, log5 = cap(C, dirty)
eq('⑤ 髒值不進樣本', r5.get('count'), 55)
# 「有欄位」與「進得了樣本」要分開記,才看得出是「沒抓到」還是「抓到但值是髒的」
eq('⑤ has_pb_field 算全部有欄的', r5.get('has_pb_field'), 59)

# ── ⑥ 樣本剛好 49 / 50 的邊界 ──
eq('⑥ 49 檔不寫', cap(C, {str(i): {'pbr': 2.0} for i in range(49)})[0], {})
eq('⑥ 50 檔要寫', cap(C, {str(i): {'pbr': 2.0} for i in range(50)})[0].get('count'), 50)

# ── ⑦ 字串型數值(JSON 有時給 "1.85")不能整批失敗 ──
r7, _ = cap(C, {str(i): {'pbr': '1.85'} for i in range(60)})
eq('⑦ 字串數值可用', r7.get('count'), 60)
eq('⑦ 壞字串跳過不 throw',
   cap(C, {**{str(i): {'pbr': 2.0} for i in range(55)}, 'X': {'pbr': '--'}})[0].get('count'), 55)

# ── ⑧ 真正的回歸守門:miner.py 組 fund_cache 時一定要帶 pbr ──
src = (ROOT / 'miner.py').read_text(encoding='utf-8')
m = re.search(r"fund_cache = \{s: \{[^}]*\}\s*\n?\s*for s, v in twse_fund", src)
eq('⑧ fund_cache 有帶 pbr(這行被改掉就會再壞一次)',
   bool(m) and 'pbr' in m.group(0), True)

print()
if fails:
    print(f'❌ MARKET_PB_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ MARKET_PB_TEST_PASS')
