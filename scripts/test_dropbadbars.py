#!/usr/bin/env python3
"""🧹 V74.9.4 `_drop_bad_bars`：掛牌前殘留 / 幽靈棒的濾除守門

⛔ 這支動的是**所有股票的歷史 K 線** → 判準寧可漏抓也不可誤刪。
   全市場實測(2,488 檔):只動 34 檔 / 525 根,而且全部是「開頭量 0 且價格不動」與 1 根幽靈棒。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / 'miner.py').read_text(encoding='utf-8')
i = src.index('def _drop_bad_bars')
j = src.index('\ndef _backadjust_splits', i)
NS = {}
exec(src[i:j], NS)
D = NS['_drop_bad_bars']

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {extra}'))
    if not cond:
        fails.append(name)


def mk(rows, start_day=1):
    """rows = [(close, volume), …] → 記錄陣列(日期只要遞增即可)"""
    out = []
    for k, (c, v) in enumerate(rows):
        out.append({'date': f'2026-01-{(start_day + k):02d}', 'open': c, 'high': c,
                    'low': c, 'close': c, 'volume': v})
    return out


def closes(rs):
    return [round(float(r['close']), 2) for r in rs]


# ① 掛牌前殘留:開頭 6 根量 0 且價格全部一樣 → 砍掉
# ⚠️ 測資要**夠長** —— 守門要求「砍完至少剩 10 根」(第一版只給 12 根 → 砍完剩 6 根,那條根本不會觸發,
#    看起來像程式壞掉,其實是測資撐不起。真實案例 4170 是 797 根砍 152 剩 645)。
r1 = mk([(10.0, 0)] * 6 + [(12.0 + k * 0.1, 5000 + k) for k in range(14)])
o1, n1 = D(list(r1), 'T1')
ok('① 開頭「量 0 且收盤價全一樣」≥5 根要砍掉', len(o1) == 14 and closes(o1)[0] == 12.0, f'{len(o1)} {closes(o1)[:3]}')
ok('① ⭐ 而且要說出砍了什麼(⛔ 不可靜默)', any('掛牌前殘留' in x for x in n1), str(n1))

# ①b 只有 4 根 → ⛔ 不砍(連假前後真的沒成交也可能連幾天量 0)
r1b = mk([(10.0, 0)] * 4 + [(12.0, 5000)] * 12)
o1b, _ = D(list(r1b), 'T1b')
ok('①b 開頭只有 4 根 → ⛔ 不砍(少於 5 根不動)', len(o1b) == len(r1b), str(len(o1b)))

# ①c 量 0 但價格會動 → ⛔ 不砍(那是真的沒成交但有報價)
r1c = mk([(10.0, 0), (10.5, 0), (11.0, 0), (10.8, 0), (11.2, 0), (10.9, 0)]
         + [(12.0, 5000)] * 12)
o1c, _ = D(list(r1c), 'T1c')
ok('①c 🚨 量 0 但**價格有動** → ⛔ 不砍(判準是「量 0 **且** 價格完全不動」)',
   len(o1c) == len(r1c), str(len(o1c)))

# ①d 有量但價格不動 → ⛔ 不砍
r1d = mk([(10.0, 100)] * 6 + [(12.0, 5000)] * 12)
o1d, _ = D(list(r1d), 'T1d')
ok('①d 有成交量(即使價格不動)→ ⛔ 不砍', len(o1d) == len(r1d), str(len(o1d)))

# ①e 🚧 幾乎整檔都是 → ⛔ 不砍(那是資料源問題)
r1e = mk([(10.0, 0)] * 20 + [(12.0, 5000)] * 6)
o1e, n1e = D(list(r1e), 'T1e')
ok('①e 🚧 幾乎整檔都是殘留 → ⛔ 不砍(⛔ 不可把一檔砍到只剩零頭)',
   len(o1e) == len(r1e), f'{len(o1e)}/{len(r1e)}')

# ② 幽靈棒:前後接近、中間離譜(3114 的真實數字)
r2 = mk([(19.95, 1000), (20.0, 1000), (20.48, 1000), (20.9, 1000),
         (2118.96, 25000),
         (21.57, 1000), (21.71, 1000), (21.5, 1000), (21.8, 1000), (22.0, 1000),
         (22.1, 1000), (22.3, 1000)])
o2, n2 = D(list(r2), '3114')
ok('② 幽靈棒(3114 真實案例 20.90 → 2118.96 → 21.57)要被砍掉',
   len(o2) == len(r2) - 1 and 2118.96 not in closes(o2), str(closes(o2)))
ok('② ⭐ 要說出是哪一天、前後多少(⛔ 不可靜默)', any('幽靈棒' in x for x in n2), str(n2))
ok('② ⛔ 前後那兩根是真的,不准被動', closes(o2)[3] == 20.9 and closes(o2)[4] == 21.57, str(closes(o2)))

# ②b 🚨 漲停之後隔天跌停(真實走勢)→ ⛔ 不可誤刪
r2b = mk([(10.0, 1000), (11.0, 1000), (12.1, 1000), (10.9, 1000), (9.8, 1000),
          (10.2, 1000), (10.5, 1000), (10.3, 1000), (10.6, 1000), (10.8, 1000),
          (11.0, 1000), (11.2, 1000)])
o2b, _ = D(list(r2b), 'T2b')
ok('②b 🚨 連續漲跌停這種真實走勢 → ⛔ 一根都不准刪', len(o2b) == len(r2b), str(closes(o2b)))

# ②c 前後兩根**不接近** → ⛔ 不算幽靈棒(那是真的走勢或分割)
r2c = mk([(10.0, 1000)] * 4 + [(70.0, 1000)] + [(69.0, 1000)] * 7)
o2c, _ = D(list(r2c), 'T2c')
ok('②c 前後兩根差很多(10 → 70 → 69)→ ⛔ 不算幽靈棒(那是分割,交給 _backadjust_splits)',
   len(o2c) == len(r2c), str(closes(o2c)))

# ②e 🚨🚨 「前後兩根要接近」那個條件是**唯一**擋得住這種的:前後差很多、但中間相對兩邊都離譜
#     真實情境:×10 分割(10 → 100)之後又大跌(→ 30)。中間那根 100 是**真的**,
#     ⛔ 刪掉它等於把一次分割抹掉 → 交給 _backadjust_splits 處理才對。
#     ⚠️ 第一版沒有這條 → 注入「拿掉前後接近的判斷」時測試照樣綠(⛔ 假綠燈)。
r2e = mk([(10.0, 1000)] * 4 + [(100.0, 1000)] + [(30.0, 1000)] * 8)
o2e, _ = D(list(r2e), 'T2e')
ok('②e 🚨 前後差很多、中間相對兩邊都離譜(10 → 100 → 30)→ ⛔ 不可當幽靈棒刪掉',
   len(o2e) == len(r2e) and 100.0 in closes(o2e), str(closes(o2e)))

# ②d 🚧 幽靈棒超過 3 根 → ⛔ 不砍(整段資料源有問題)
seq = []
for k in range(6):
    seq += [(10.0, 1000), (500.0, 1000)]
seq += [(10.0, 1000)] * 6
r2d = mk(seq)
o2d, n2d = D(list(r2d), 'T2d')
ok('②d 🚧 疑似幽靈棒 >3 根 → ⛔ 不砍,而且要說明為什麼',
   len(o2d) == len(r2d) and any('>3' in x for x in n2d), f'{len(o2d)}/{len(r2d)} {n2d}')

# ③ 正常資料一根都不動 + 冪等
r3 = mk([(10.0 + k * 0.1, 1000 + k) for k in range(30)])
o3, n3 = D(list(r3), 'T3')
ok('③ 正常資料一根都不動,而且沒有雜訊訊息', len(o3) == len(r3) and not n3, f'{len(o3)} {n3}')
twice, _ = D(list(o1), 'T1-again')
ok('③b 冪等:對已經濾乾淨的再跑一次不會再砍', len(twice) == len(o1), f'{len(twice)}/{len(o1)}')

# ④ 壞值不 throw
for bad in ([], [{'date': 'x'}], [{'close': None, 'volume': None}] * 12,
            [{'date': '2026-01-01', 'close': 'abc', 'volume': 'x'}] * 12):
    try:
        D(list(bad), 'bad')
    except Exception as e:
        ok('④ 空/壞值不 throw', False, f'{type(e).__name__}: {e}')
        break
else:
    ok('④ 空/壞值不 throw', True)

print()
print('❌ DROPBADBARS_FAIL: ' + str(fails) if fails else '✅ DROPBADBARS_PASS(全部通過)')
sys.exit(1 if fails else 0)
