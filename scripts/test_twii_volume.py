#!/usr/bin/env python3
"""^TWII 官方量能補齊(V71.6.2,FMTQIK)離線測試。

背景:MI_5MINS_HIST 只給 OHLC,^TWII.json 近 3 個月的 volume 一直是 0。
V71.6.2 改向 FMTQIK(每日市場成交資訊)要官方成交股數/金額按日期併入。

⛔ 本檔最重要的守門是 ⑤:官方值只能寫進**獨立欄位** mkt_vol / amount,
   **絕不可寫進 volume** —— 既有列的 volume 來自 yfinance(實測中位數 3,734,300),
   官方成交股數是 ~54 億,差約 1,500 倍。混同一欄會做出 1000 倍斷崖,
   還會讓前端 V71.4.9 的「幽靈棒過濾」守門失效(那個 486→424 根的老 bug 會復活)。

沙箱連不到 twse.com.tw,所以解析(_parse_fmtqik / _roc_to_iso)、合併
(_merge_twii_volume)、月份推算(_months_span)都抽成純函式在這裡測;
網路層只負責取資料且全程 fallback。
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

fails = []


def eq(name, got, want):
    ok = got == want
    print(f"{'✅' if ok else '❌'} {name}: {got!r}" + ('' if ok else f' (期望 {want!r})'))
    if not ok:
        fails.append(name)


# ── ① 民國年轉換(FMTQIK 與 MI_5MINS_HIST 都是民國,兩邊要轉成同一格式才併得起來)──
eq('① 115/07/29', M._roc_to_iso('115/07/29'), '2026/07/29')
eq('① 3 碼年 + 單位數月日', M._roc_to_iso('115/7/1'), '2026/07/01')
eq('① 無分隔 1150729', M._roc_to_iso('1150729'), '2026/07/29')
eq('① 前後空白', M._roc_to_iso('  115/07/29 '), '2026/07/29')
eq('① 空字串', M._roc_to_iso(''), None)
eq('① None', M._roc_to_iso(None), None)
eq('① 月份離譜(13 月)不硬轉', M._roc_to_iso('115/13/01'), None)
eq('① 已是西元不誤判', M._roc_to_iso('2026/07/29'), None)   # 4 碼年不吃,避免年份被 +1911

# ── ② FMTQIK 解析 ────────────────────────────────────────────────
J = {
    'stat': 'OK',
    'fields': ['日期', '成交股數', '成交金額', '成交筆數', '發行量加權股價指數', '漲跌點數'],
    'data': [
        ['115/07/27', '5,120,000,000', '881,000,000,000', '3,100,000', '41,500.00', '-120.00'],
        ['115/07/28', '5,400,000,000', '916,000,000,000', '3,200,000', '41,600.00', '100.00'],
        ['115/07/29', '6,800,000,000', '1,129,000,000,000', '4,050,000', '40,039.00', '-1,561.00'],
    ],
}
vm = M._parse_fmtqik(J)
eq('② 解析 3 天', len(vm), 3)
eq('② 07/29 成交股數', vm['2026/07/29'][0], 6_800_000_000)
eq('② 07/29 成交金額(元)', vm['2026/07/29'][1], 1_129_000_000_000)
# 金額換成「兆」要對得上電視講的數字(1.13 兆)
eq('② 換算成兆', round(vm['2026/07/29'][1] / 1e12, 2), 1.13)

# ── ③ 欄序被官方改過也要吃(一律用欄名定位,不寫死 index)──
J2 = {'fields': ['發行量加權股價指數', '日期', '成交金額', '成交股數'],
      'data': [['40,039.00', '115/07/29', '1,129,000,000,000', '6,800,000,000']]}
eq('③ 換欄序仍正確', M._parse_fmtqik(J2)['2026/07/29'], (6_800_000_000.0, 1_129_000_000_000.0))

# ── ④ 壞 payload 一律回空,不 throw ──────────────────────────────
eq('④ None', M._parse_fmtqik(None), {})
eq('④ 沒 fields', M._parse_fmtqik({'data': [['115/07/29', '1']]}), {})
eq('④ 休市(data 空)', M._parse_fmtqik({'fields': ['日期', '成交股數'], 'data': []}), {})
eq('④ 髒值那列跳過、好的留下',
   len(M._parse_fmtqik({'fields': ['日期', '成交股數'],
                        'data': [['115/07/29', '--'], ['115/07/28', '5,400,000,000']]})), 1)

# ── ⑤ 合併:寫獨立欄位,**絕不碰 volume** ─────────────────────────
#   這是本次最重要的一條。既有列的 volume 來自 yfinance(^TWII 實測中位數 3,734,300),
#   FMTQIK 成交股數是 ~54 億 —— 差約 1,500 倍。寫進同一欄會:
#     ① 均量/OBV/量價背離 算出垃圾、前端畫出一根天柱
#     ② 前端 V71.4.9 幽靈棒過濾只看「最後 60 根」的零量佔比,近 3 個月被填滿後
#        佔比從 ~100% 掉到 ~0% → 過濾器對整個 486 列生效 → 更舊的零量列被整批刪
#        (就是「486→424 根、個股頁停在 3 個月前」那個老 bug 復活)
rows = [
    {'date': '2026/07/27', 'close': 41500.0, 'volume': 0},
    {'date': '2026/07/28', 'close': 41600.0, 'volume': 0},
    {'date': '2026/07/29', 'close': 40039.0, 'volume': 0},
    {'date': '2026/07/30', 'close': 40100.0, 'volume': 0},      # FMTQIK 還沒出這天
    {'date': '2026/07/24', 'close': 41300.0, 'volume': 3734300},  # yfinance 既有量
]
out, hit = M._merge_twii_volume(rows, vm)
eq('⑤ 補了 3 列', hit, 3)
eq('⑤ 官方股數進 mkt_vol', out[2]['mkt_vol'], 6_800_000_000)
eq('⑤ 官方金額進 amount', out[2]['amount'], 1_129_000_000_000)
eq('⑤ ⛔ volume 一律不動(零量列維持 0)', out[2]['volume'], 0)
eq('⑤ ⛔ volume 一律不動(yfinance 既有值原封不動)', out[4]['volume'], 3734300)
eq('⑤ FMTQIK 沒有的日期整列沒那兩個欄位', ('mkt_vol' in out[3], 'amount' in out[3]), (False, False))
# 明確斷言「1000 倍斷崖」沒有發生:所有 volume 還是同一個數量級
_vs = [r['volume'] for r in out if r['volume']]
eq('⑤ volume 沒有跨數量級混雜', max(_vs) / min(_vs) < 10, True)

# ── ⑥ 空 vol_map(FMTQIK 掛掉)→ 什麼都不加,不 throw,回 hit=0 ──
rows2 = [{'date': '2026/07/29', 'close': 40039.0, 'volume': 0}]
out2, hit2 = M._merge_twii_volume(rows2, {})
eq('⑥ 來源掛掉 hit=0', hit2, 0)
eq('⑥ 來源掛掉 volume 維持 0', out2[0]['volume'], 0)
eq('⑥ 來源掛掉不會亂加欄位', 'mkt_vol' in out2[0], False)
eq('⑥ rows 為 None 不 throw', M._merge_twii_volume(None, vm), (None, 0))

# ── ⑦ 前端「幽靈棒過濾」守門必須維持有效:
#     volume 沒被動過 → 最後 60 根的零量佔比不變 → 過濾器照樣不會誤砍指數 K 棒。
part = [{'date': f'2026/07/{d:02d}', 'close': 40000.0, 'volume': 0} for d in range(1, 31)]
_, hit7 = M._merge_twii_volume(part, vm)
zero_ratio = sum(1 for r in part if not r['volume']) / len(part)
eq('⑦ 併入後 volume 零量佔比仍是 100%(守門有效)', zero_ratio, 1.0)
eq('⑦ 但官方量能確實補到了', hit7, 3)

# ── ⑧ _months_span:抓幾個月份檔由資料範圍決定,不寫死 ──────────────
span = M._months_span([{'date': '2024/07/30'}, {'date': '2025/01/21'}, {'date': '2026/07/30'}])
eq('⑧ 月份去重排序', span, [(2024, 7), (2025, 1), (2026, 7)])
eq('⑧ cap 從最新往回取', M._months_span([{'date': f'2026/{m:02d}/01'} for m in range(1, 13)], cap=3),
   [(2026, 10), (2026, 11), (2026, 12)])
eq('⑧ 壞日期跳過不 throw',
   M._months_span([{'date': ''}, {'date': None}, {'date': 'xx'}, {'date': '2026/13/01'}, {'date': '2026/07/29'}]),
   [(2026, 7)])
eq('⑧ 空 rows', M._months_span([]), [])

print()
if fails:
    print(f'❌ TWII_VOLUME_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ TWII_VOLUME_TEST_PASS')
