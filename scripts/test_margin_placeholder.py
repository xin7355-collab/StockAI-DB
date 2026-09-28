#!/usr/bin/env python3
"""💳 V77.8.9 融資餘額「0 = 沒抓到的佔位」守門(screener_miner._margin_placeholder_to_none)。
真因:miner.py 在沒抓到融資的那天寫 0 當佔位 → screener 的「融資 5 日增減 %」算成 −100%(實測 61 檔)。
⛔ 一直都是 0 的(不能融資的股票)不動;前面有正值、這天是 0 → None;連續的 0 一起;⛔ 不改呼叫端的 rows。
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import screener_miner as S

fails = []
def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else '  ' + str(extra)))
    if not cond: fails.append(name)

f = S._margin_placeholder_to_none
rows = [{'margin_balance': 5000}, {'margin_balance': 5100}, {'margin_balance': 0}, {'margin_balance': 0}, {'margin_balance': 5200}]
out = f(rows)
ok('① 前面有正值、這天 0 → None(連續兩個 0 都算)', [r['margin_balance'] for r in out] == [5000, 5100, None, None, 5200], out)
ok('② ⛔ 不改呼叫端的 rows', rows[2]['margin_balance'] == 0)
always0 = [{'margin_balance': 0}] * 4
ok('③ 一直都是 0(不能融資)→ 照留 0', [r['margin_balance'] for r in f(always0)] == [0, 0, 0, 0])
lead0 = [{'margin_balance': 0}, {'margin_balance': 3000}, {'margin_balance': 0}]
ok('④ 第一筆就是 0(前面沒有已知值)→ 照留;後面正值之後的 0 → None', [r['margin_balance'] for r in f(lead0)] == [0, 3000, None])
nof = [{'close': 1}, {'margin_balance': None}, {'margin_balance': 'x'}]
ok('⑤ 沒有欄位 / None / 壞字串 → 不動、不炸', f(nof) == nof)
# ⑥ 走真的 build_one:最後兩天是佔位 0 → mgp 不可以是 −100
base = []
for i in range(80):
    base.append({'date': f'2026-06-{(i % 28) + 1:02d}', 'open': 100, 'high': 101, 'low': 99, 'close': 100 + (i % 3), 'volume': 1_000_000,
                 'margin_balance': 5000 + i, 'short_balance': 100})
base[-1] = dict(base[-1], margin_balance=0)
v = S.build_one(base)
ci = {k: i for i, k in enumerate(S.COLS)}
_vv = (v[0] if isinstance(v, tuple) else v) if v else None
mgp = _vv[ci['mgp']] if (_vv and 'mgp' in ci) else 'n/a'
ok('⑥ build_one:今天那筆佔位 0 → mgp ⛔ 不可是 −100', mgp != -100 and mgp != -100.0, mgp)
# ⑦ 決定性對照:拿掉守門(直接用原 rows)→ 同一份會算出 −100
orig = S._margin_placeholder_to_none
S._margin_placeholder_to_none = lambda r: r
v2 = S.build_one(base)
S._margin_placeholder_to_none = orig
_v2 = (v2[0] if isinstance(v2, tuple) else v2) if v2 else None
mgp2 = _v2[ci['mgp']] if _v2 else None
ok('⑦ ⭐ 決定性對照:拿掉守門 → 同一份算出 −100(測資真的踩到那個坑)', mgp2 in (-100, -100.0), mgp2)
print('\n❌ %d 條失敗' % len(fails) if fails else '\n✅ MARGIN_PLACEHOLDER_PASS')
sys.exit(1 if fails else 0)
