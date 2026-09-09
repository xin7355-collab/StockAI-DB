#!/usr/bin/env python3
"""分點「隔日沖真效果」(V71.7.2)離線測試。

背景:使用者問「隔日沖分點有沒有慣性」。broker_habit_probe.py 實測後:
  ✅ 慣性存在,但**人工標籤會錯** —— 美商美林被標「⚡外資最兇隔日沖」,實測真效果 −0.4pp
  ❌ 「開高就倒」「賺 X% 才出」都被否定 → 所以只算配對慣性,不算那兩個

⚠️ 本檔守的是**方法論**(探針踩過兩次的坑,不可被簡化掉):
  ① 必須有「同股換日對照組」。沒有的話會把「他本來每天都在賣」當成隔日沖。
  ② 報酬必須扣掉同期個股漲跌,否則崩盤期會看到「大家都在賠」= 行情不是行為。
"""
import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_MAIN', '1')
for _m in ('yfinance', 'pandas', 'numpy'):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)

import miner as M   # noqa: E402

C = M.compute_flip_edge
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


def day(d, buyers, sellers, ret=0.0):
    return {'d': d, 'ret': ret,
            'b': [[n, 1000, p] for n, p in buyers],
            's': [[n, -1000, p] for n, p in sellers]}


# ── ① 隔日沖:A 只在偶數日買,而且**買完隔天一定賣**;B 每天買但從不賣 ──
#    ⚠️ 測試設計兩個坑(都踩過):
#      (a) A 不能「每天都買」—— 對照組會飽和(見 ⑦)。
#      (b) **每一天都要有賣方**。程式對「當天沒有任何賣方」的日子會整個跳過,
#          於是「A 沒賣的那些日子」不進對照組 → 對照組被灌成 100%,測不出效果。
#          真實資料每天都有前 15 大賣方,不會發生;是我的玩具樣本不真實。
hist = {}
for k in range(7):
    buyers = [('B', 100)] + ([('A', 100)] if k % 2 == 0 else [])
    sellers = [('FILL', 100)] + ([('A', 101)] if (k % 2 == 1) else [])   # 每天都有賣方
    hist.setdefault('X', []).append(day(f'2026-07-0{k + 1}', buyers, sellers, ret=0.0))
r = {x['broker']: x for x in C(hist, min_n=1)}
ok('① 買完隔天就賣的 A:配對率 100%', r['A']['rate'] == 100.0, str(r.get('A')))
ok('① 從不賣的 B:配對率 0%', r['B']['rate'] == 0.0, str(r.get('B')))
ok('① ⭐ A 的真效果明顯為正(對照組沒飽和)', r['A']['edge'] > 30, str(r['A']))
ok('① B 的真效果不為正', r['B']['edge'] <= 0, str(r['B']))

# ── ② ⭐ 對照組要能擋掉「他本來每天都在賣」的假象 ──────────────
#    C 每天都在賣方(不管有沒有買)→ 配對率會很高,但對照組也一樣高 → 真效果應接近 0
hist2 = {}
for k in range(6):
    hist2.setdefault('Y', []).append(day(f'2026-07-0{k + 1}', [('C', 100)], [('C', 100)]))
r2 = {x['broker']: x for x in C(hist2, min_n=1)}
ok('② 天天都在賣的 C:配對率高', r2['C']['rate'] >= 80, str(r2['C']))
ok('② ⭐ 但真效果≈0(對照組擋掉假象)', abs(r2['C']['edge']) < 1e-6, str(r2['C']))

# ── ③ ⭐ 超額報酬要扣掉同期個股漲跌 ────────────────────────────
#    買 100 賣 110 = +10%,但同期個股也漲 10% → 超額應為 0(不是 +10%)
#    ⚠️ 至少要 3 天且各分點要買 ≥2 天:只有 1 天買時「其他日」沒有它 → 沒有對照組
#       → 該分點會被略過(這是刻意的:沒有對照就不下結論)。
def _mk(ret_on_sell, sell_px):
    rows = []
    for k in range(4):
        rows.append(day(f'2026-07-0{k + 1}',
                        [('D', 100), ('F', 1)] if k % 2 == 0 else [('F', 1)],
                        [('FILL', 1)] + ([('D', sell_px)] if k % 2 == 1 else []),
                        ret=(ret_on_sell if k % 2 == 1 else 0.0)))
    return {'Z': rows}


r3 = {x['broker']: x for x in C(_mk(10.0, 110), min_n=1)}
ok('③ ⭐ 扣掉行情後超額≈0(而非 +10%)', 'D' in r3 and abs(r3['D']['med_ex']) < 0.01, str(r3.get('D')))
r4 = {x['broker']: x for x in C(_mk(-10.0, 100), min_n=1)}
ok('③ 逆勢守住 → 超額為正', 'E' not in r4 and r4['D']['med_ex'] > 9.9, str(r4.get('D')))
ok('③ ⭐ 只有 2 天(沒有對照日)→ 略過不下結論',
   C({'Q': [day('a', [('G', 100)], [('FILL', 1)]),
            day('b', [], [('G', 110), ('FILL', 1)], ret=0)]}, min_n=1) == [])

# ── ④ 樣本門檻:低於 min_n 不列(避免 2~3 筆的雜訊被當結論)──────
ok('④ 樣本不足不列入', C(hist, min_n=99) == [])

# ── ⑤ 排序:依真效果由大到小(不是依配對率)──────────────────
mix = {}
for k in range(6):
    mix.setdefault('W', []).append(
        day(f'2026-07-0{k + 1}',
            [('HI', 100), ('LO', 100)],
            ([('HI', 100)] if k else []) + [('LO', 100)]))
rows = C(mix, min_n=1)
ok('⑤ 依 edge 排序', [x['broker'] for x in rows][0] == 'HI', str(rows))
ok('⑤ LO(天天賣)edge 較低', rows[0]['edge'] >= rows[-1]['edge'])

# ── ⑥ 壞資料不可 throw ────────────────────────────────────────
for bad in (None, {}, {'A': None}, {'A': [{'d': 1}]}, {'A': [{'b': 'x', 's': 3}, {}]},
            {'A': [day('a', [('N', 'bad')], []), day('b', [], [('N', None)])]}):
    try:
        C(bad, min_n=1)
    except Exception as e:
        ok(f'⑥ {str(bad)[:26]} 不 throw', False, f'{type(e).__name__}: {e}')
        break
else:
    ok('⑥ 各種壞資料都不 throw', True)

# ── ⑦ 記錄指標的真實限制:天天都買的分點,對照組會飽和 → edge 被低估 ──
#     這不是 bug,是「同股換日對照」的先天性質。實際資料不會飽和(分點不可能
#     在每一檔每一天都買),但單一檔股票的小樣本會 → 所以 min_n 門檻不能拿掉。
sat = {}
for k in range(6):
    sat.setdefault('S', []).append(day(f'2026-07-0{k + 1}', [('OMNI', 100)],
                                       [('OMNI', 100)] if k else []))
rs = {x['broker']: x for x in C(sat, min_n=1)}
ok('⑦ 天天都買的分點:對照組飽和 → edge≈0(已知限制,非 bug)',
   'OMNI' in rs and abs(rs['OMNI']['edge']) < 1e-6, str(rs.get('OMNI')))

print()
if fails:
    print(f'❌ FLIP_EDGE_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ FLIP_EDGE_TEST_PASS')
