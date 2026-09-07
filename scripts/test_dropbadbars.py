#!/usr/bin/env python3
"""🧹 V74.9.5 `_drop_bad_bars`：掛牌前殘留 / 幽靈棒 / 孤兒開頭段的濾除守門

⛔ 這支動的是**所有股票的歷史 K 線** → 判準寧可漏抓也不可誤刪。
   全市場實測(2,488 檔):只動 34 檔 / 525 根,而且全部是「開頭量 0 且價格不動」與 1 根幽靈棒。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / 'miner.py').read_text(encoding='utf-8')
i = src.index('def _bar_date')   # ⛔ 要從這裡開始 —— _drop_bad_bars 會用到 _orphan_head
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

# ⑤ 孤兒開頭段 —— 真實案例 0052:2017/12 那 22 根之後跳到 2023/06
def mkd(items):
    """items = [(date, close, volume), …]"""
    return [{'date': d, 'open': c, 'high': c, 'low': c, 'close': c, 'volume': v}
            for d, c, v in items]


def seq(y, m, d0, n, c0, step=0.1, vol=1000):
    """從 y-m-d0 起連 n 根(日期只要遞增即可,不必是真的交易日)"""
    out = []
    for k in range(n):
        dd = d0 + k
        mm, dd = m + (dd - 1) // 28, (dd - 1) % 28 + 1
        yy, mm = y + (mm - 1) // 12, (mm - 1) % 12 + 1
        out.append((f'{yy:04d}-{mm:02d}-{dd:02d}', round(c0 + k * step, 2), vol))
    return out


r5 = mkd(seq(2017, 12, 1, 22, 50.0) + seq(2023, 6, 12, 600, 110.0))
o5, n5 = D(list(r5), '0052')
ok('⑤ 孤兒開頭段(22 根 + 5.5 年的洞)→ 砍掉前段', len(o5) == 600 and o5[0]['date'].startswith('2023'),
   f'{len(o5)} 首={o5[0]["date"] if o5 else "-"}')
ok('⑤a 訊息要說出「真正的歷史從哪天開始」',
   any('孤兒段' in x and '2023-06-12' in x for x in n5), str(n5))

# ⑤a2 兩層孤島(0051/006208 那種)要一次砍到底,⛔ 不可只砍一層
r5x = mkd(seq(2017, 6, 1, 22, 40.0) + seq(2017, 12, 1, 21, 50.0) + seq(2023, 6, 12, 600, 110.0))
o5x, n5x = D(list(r5x), '0051')
ok('⑤a2 兩層孤島要砍到收斂(⛔ 不可只砍第一層)',
   len(o5x) == 600 and o5x[0]['date'].startswith('2023') and len([x for x in n5x if '孤兒段' in x]) == 2,
   f'{len(o5x)} 首={o5x[0]["date"] if o5x else "-"} {n5x}')

# ⑤b 前段 >60 根 → ⛔ 不砍(1435/8163 那種「真的深歷史配一個真的洞」)
r5b = mkd(seq(2021, 1, 4, 389, 20.0) + seq(2023, 3, 20, 600, 30.0))
o5b, n5b = D(list(r5b), '1435')
ok('⑤b 前段 389 根 → ⛔ 不可砍(那是真的深歷史)', len(o5b) == len(r5b), f'{len(o5b)}/{len(r5b)} {n5b}')

# ⑤c 洞只有 30 天(短期停牌/連假)→ ⛔ 不砍
r5c = mkd(seq(2026, 1, 1, 22, 50.0) + seq(2026, 2, 20, 600, 52.0))
o5c, _ = D(list(r5c), 'gap30')
ok('⑤c 洞只有約 30 天 → ⛔ 不可砍', len(o5c) == len(r5c), f'{len(o5c)}/{len(r5c)}')

# ⑤d 後面剩不到 200 根 → ⛔ 不砍(不可把短歷史的股票掏空)
r5d = mkd(seq(2017, 12, 1, 22, 50.0) + seq(2023, 6, 12, 150, 110.0))
o5d, _ = D(list(r5d), 'short')
ok('⑤d 後面只剩 150 根 → ⛔ 不可砍', len(o5d) == len(r5d), f'{len(o5d)}/{len(r5d)}')

# ⑤e ⛔ 只看第一個洞:第一個洞前面有 300 根(不砍)→ 後面就算還有小段也不再砍
r5e = mkd(seq(2021, 1, 4, 300, 20.0) + seq(2022, 8, 1, 30, 25.0) + seq(2023, 6, 12, 500, 30.0))
o5e, _ = D(list(r5e), 'multi')
ok('⑤e ⛔ 只看第一個洞(前面 300 根 → 整檔不動)', len(o5e) == len(r5e), f'{len(o5e)}/{len(r5e)}')

# ⑤f 日期解不出來 → 整個不動(⛔ 寧可不砍)
r5f = mkd(seq(2017, 12, 1, 22, 50.0) + seq(2023, 6, 12, 600, 110.0))
r5f[3]['date'] = 'N/A'
o5f, _ = D(list(r5f), 'baddate')
ok('⑤f 有一根日期解不出來 → 整檔不動', len(o5f) == len(r5f), f'{len(o5f)}/{len(r5f)}')

# ⑤g ③ 要排在 ① 之前:孤島 + 孤島之後又有「量 0 且價格不動」的開頭 → 兩個都要砍
r5g = mkd(seq(2017, 12, 1, 22, 50.0)
          + [(d, 9.99, 0) for d, _, _ in seq(2023, 6, 12, 8, 0)]
          + seq(2023, 7, 20, 600, 110.0))
o5g, n5g = D(list(r5g), 'both')
ok('⑤g ③ 排在 ① 之前 → 孤島與量 0 開頭兩段都要砍',
   len(o5g) == 600 and float(o5g[0]['close']) > 100,
   f'{len(o5g)} 首收={o5g[0]["close"] if o5g else "-"} {n5g}')

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
