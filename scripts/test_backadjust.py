#!/usr/bin/env python3
"""🔧 分割/減資回溯調整測試(V71.7.9)。

背景:回答使用者「分析師買 0050」時,拿真實資料做回測,發現 `data/0050.json` 有兩個
不可能的跳空:2024/07/01 ×4.00、2025/06/11 ÷4.00 → 中間整整一年的價位尺標是錯的。
根因是 yfinance 刻意用 auto_adjust=False(才對得上官方收盤),但分割後**舊列不回溯調整**。

這支用真實抓到的形狀當測資,釘住三件事:
  ① 整數倍跳空要被抓到並修平(而且最新價不准被動)
  ② 正常漲跌(含 ±10% 漲跌停、除權息小缺口)不准被誤判
  ③ 中間停牌很久造成的大落差不准被當成分割
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for _m in ('yfinance', 'pandas', 'requests'):
    if _m not in sys.modules:
        try:
            __import__(_m)
        except ImportError:
            sys.modules[_m] = types.ModuleType(_m)

import miner as M   # noqa: E402

B = M._backadjust_splits
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


def mk(seq, start='2026-01-05'):
    """seq = [(日期偏移天數, 收盤)] → records;日期用連續工作日近似(週末跳過不影響 ≤5 天判斷)"""
    from datetime import date, timedelta
    d0 = date.fromisoformat(start)
    out = []
    for i, c in enumerate(seq):
        d = d0 + timedelta(days=i)
        out.append({'date': d.isoformat().replace('-', '/'),
                    'open': c, 'high': c * 1.01, 'low': c * 0.99, 'close': c,
                    'volume': 1000, 'foreign_net': 55, 'margin_balance': 77})
    return out


def closes(rs):
    return [round(float(r['close']), 2) for r in rs]


# ── ① 0050 的真實形狀:先 ×4 再 ÷4(中間一年是別的尺標)────────────────
#    真實形狀(取自 data/0050.json 的實際數字):最舊那段已是分割調整過的尺標,
#    中間 2024/07~2025/06 那段是「分割前原始價」(4 倍),最新那段又回到調整後尺標。
#    → 正確結果應該是「中間那段被縮小 4 倍」,頭尾兩段原封不動。
RAW = [32.0, 33.0, 46.61, 186.60, 188.0, 188.65, 47.16, 48.0, 49.0]   # 各段內部只有小波動
r = B(mk(RAW), '0050')
c = closes(r)
print(f'\n0050 形狀修正前:{RAW}\n0050 形狀修正後:{c}\n')
ok('① 最新價不准被動(要等於官方收盤 49.0)', c[-1] == 49.0, str(c[-1]))
ok('① 中間那段(4 倍原始價)被縮回來', c[3] < 60 and c[4] < 60 and c[5] < 60, str(c[3:6]))
ok('① 頭尾兩段原封不動(它們本來就對)',
   c[0] == 32.0 and c[1] == 33.0 and c[2] == 46.61 and c[6] == 47.16 and c[7] == 48.0, str(c))
# ⚠️ 索引 1→2(33→46.61)是這組**測資自己**的 +41%(真實資料那段中間有 250 根,不會這樣跳),
#    不是程式造成的 → 只檢查「分割那兩個接縫」有沒有被修平。
for _i in (3, 6):
    ok(f'① 接縫 {_i} 已修平(不再是整數倍跳空)', 0.75 < c[_i] / c[_i - 1] < 1.33,
       f'{c[_i-1]}→{c[_i]}')
ok('① 中間那段的量反向調整(價 ÷4 → 量 ×4)', r[3]['volume'] == 4000, str(r[3]['volume']))
# 🔁 沒有累積四捨五入誤差:被 ×4 又 ÷4 抵銷掉的那幾筆,要**原封不動**回到原值
ok('① 倍率抵銷的列不可有捨入誤差(46.61 不能變成 46.60)',
   c[0] == 32.0 and c[1] == 33.0 and c[2] == 46.61, str(c[:3]))
ok('① 沒被調整的那幾筆,量也不准動', r[0]['volume'] == 1000 and r[-1]['volume'] == 1000,
   f"{r[0]['volume']}/{r[-1]['volume']}")
ok('① ⛔ 法人張數/融資餘額不准被動(那是當時真實張數)',
   r[0]['foreign_net'] == 55 and r[0]['margin_balance'] == 77,
   f"{r[0]['foreign_net']}/{r[0]['margin_balance']}")

# ── ② 正常波動不可誤判 ────────────────────────────────────────────────
norm = [100, 110, 99, 108.9, 98.0, 107.8]          # 連續 ±10% 漲跌停
r2 = B(mk(norm), 'X')
ok('② 連續漲跌停(±10%)不動它', closes(r2) == [round(x, 2) for x in norm], str(closes(r2)))

div = [100, 96.5, 97, 98]                           # 除權息 -3.5% 缺口
r3 = B(mk(div), 'Y')
ok('② 除權息小缺口不動它', closes(r3) == [round(x, 2) for x in div], str(closes(r3)))

# ×1.94:單日 +94% 在上市櫃(±10% 漲跌停)物理上不可能 → 判定為「×2 減資 + 當日 −3%」,要修。
# (實測 gh-pages 上的 6705 / 6915 / 6518 就是這個形狀,原本被整數倍 ±3% 的舊規則漏掉。)
near = [10, 10, 19.4, 19.5]
r4 = B(mk(near), 'Z')
ok('② ×1.94 要被認出來是 ×2 減資(單日 +94% 不可能是真漲)',
   closes(r4)[0] == 20.0 and closes(r4)[-1] == 19.5, str(closes(r4)))

# ⛔ 興櫃無漲跌幅限制,真的可能單日大漲 → 湊不到「整數倍 × 漲跌停內殘差」的就不准動
for seq, why in (([10, 10, 15.5, 16], '×1.55 湊不到任何整數倍'),
                 ([10, 10, 6.4, 6.5], '×0.64 湊不到任何整數倍')):
    rr = B(mk(seq), 'OTC')
    ok(f'② {why} → 不碰', closes(rr) == [round(x, 2) for x in seq], str(closes(rr)))

# ── ③ 停牌很久後復牌的大落差 ≠ 分割 ───────────────────────────────────
gapped = mk([50, 50])
gapped.append({'date': '2026/03/20', 'open': 200, 'high': 202, 'low': 198,
               'close': 200, 'volume': 1000})       # 距上一筆 2 個多月
r5 = B(gapped, 'W')
ok('③ 中間隔 2 個月的 ×4 不算分割(那是缺資料)', closes(r5)[0] == 50.0, str(closes(r5)))

# ── ④ 邊界:空/太短/壞值不可 throw ────────────────────────────────────
for bad in ([], [{'date': '2026/01/01', 'close': 10}], mk([10, 0, 10]),
            [{'date': 'xx', 'close': 'abc'}, {'date': 'yy', 'close': None}]):
    try:
        B(bad, 'bad')
    except Exception as e:
        ok(f'④ {str(bad)[:30]} 不 throw', False, f'{type(e).__name__}: {e}')
        break
else:
    ok('④ 空/太短/壞值都不 throw', True)

# ── ⑤ 三次分割也要能一路接回來(倍率要疊乘,不是各修各的)──────────────
r6 = B(mk([100, 100, 50, 50, 25, 25, 5, 5]), 'multi')   # ÷2 → ÷2 → ÷5
c6 = closes(r6)
ok('⑤ 連三次分割:最新價不動', c6[-1] == 5.0, str(c6))
ok('⑤ 連三次分割:最舊被疊乘 ÷20(100 → 5)', abs(c6[0] - 5.0) < 0.02, str(c6))
ok('⑤ 連三次分割後整條無跳空',
   all(0.75 < c6[i] / c6[i - 1] < 1.33 for i in range(1, len(c6))), str(c6))

# ── ⑥ 冪等性(關鍵):`seed_db_from_json` 每次 run 都會把 data/*.json 讀回 SQLite,
#    所以「已經調整過的 JSON」下次會再進來一次 → 第二次跑**不可以**再調一次(否則越調越歪)。
once = B(mk(RAW), '0050')
twice = B([dict(x) for x in once], '0050')
ok('⑥ 對已修好的資料再跑一次:完全不動(冪等)', closes(once) == closes(twice),
   f'{closes(once)} vs {closes(twice)}')
ok('⑥ 量也不可以被再除一次',
   [r['volume'] for r in once] == [r['volume'] for r in twice],
   f"{[r['volume'] for r in once]} vs {[r['volume'] for r in twice]}")

print()
if fails:
    print(f'❌ BACKADJUST_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ BACKADJUST_TEST_PASS')
