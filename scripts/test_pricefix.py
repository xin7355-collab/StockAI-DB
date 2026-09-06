#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🚨 V74.2.1 收盤價空殼修復(`miner.needs_price_fix`)測試

**這個 bug 的樣子**(2026-08-29 從 pro.html 加矽晶圓時抓到):
  `data/6488.json`(環球晶,上櫃)最後兩根:
    {"date":"2026/08/27","open":966,"high":969,"low":925,"close":null,"volume":7976458}
  —— open/high/low/volume **全都有值,就是沒有收盤價**。那是「盤中快照」留下的空殼;
  上櫃股的官方收盤資料抓不到(TPEX 端點對機房 IP 失效),所以沒有東西回來覆蓋它。

**為什麼躲過所有檢查**:
  miner.py 本來就有一段 yfinance 校正,註解白紙黑字寫著「上櫃股…最近交易日常殘留 MIS 盤中快照」,
  ⛔ 但判斷式寫成 `old_c = ....get('close') or 0` + `if old_c > 0 and 差幅 >= 1.5%`
  → **close 是 None 時 old_c 變 0,`old_c > 0` 為 False,整段跳過** ——
  它只修得了「有值但不準」,修不了「根本沒值」,而後者才是最嚴重的。
  災情:全市場抽驗 382 檔有 **188 檔(49%)** 最後一根 close=None →
  `screener.json` 從 2,300+ 縮到 **1,301 檔**,而 workflow 全綠、零錯誤訊息。

⛔ 這支要釘死的事:
  ① close 是 None / 0 / 負 → **一定要修**(這是原本漏掉的那一半)
  ② 有值但差 ≥1.5% → 要修(原本就有的行為,⛔ 不可改壞)
  ③ 差 <1.5% → ⛔ 不可動(避免每天無謂覆寫)
  ④ 🚨 新值本身無效(None/0/字串)→ ⛔ **絕不可覆蓋** —— 拿壞值蓋掉好值比不修還糟
  ⑤ 呼叫端真的接上了這支函式,而且 stale 名單涵蓋「官方有回但收盤價是空的」
  ⑥ 🚧 空過守門:函式存在且真的被 miner.py 呼叫(⛔ 防「寫了但沒接」)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import miner  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else f'  {extra}'}")
    if not cond:
        fails.append(name)


# ── ①~④ 純函式行為 ───────────────────────────────────────────
CASES = [
    # (old, new, 期望, 說明)
    (None, 949.0, True,  '① close 是 None(盤中快照空殼)→ 必須修'),
    (0,    949.0, True,  '① close 是 0 → 必須修'),
    (-5,   949.0, True,  '① close 是負數 → 必須修'),
    ('',   949.0, True,  '① close 是空字串 → 必須修'),
    (100.0, 103.0, True, '② 差 3% ≥ 門檻 → 修'),
    (100.0, 97.0,  True, '② 反向差 3% → 修'),
    (100.0, 100.0, False, '③ 完全一樣 → ⛔ 不動'),
    (100.0, 101.0, False, '③ 差 1% < 1.5% → ⛔ 不動'),
    (100.0, 101.4, False, '③ 差 1.4% → ⛔ 不動'),
    (100.0, None,  False, '④ 🚨 新值 None → ⛔ 絕不可覆蓋'),
    (100.0, 0,     False, '④ 🚨 新值 0 → ⛔ 絕不可覆蓋'),
    (100.0, 'x',   False, '④ 🚨 新值非數字 → ⛔ 絕不可覆蓋'),
    (None,  None,  False, '④ 兩邊都壞 → ⛔ 不動(沒有好值可用)'),
    (None,  0,     False, '④ 舊的壞、新的也壞 → ⛔ 不動'),
]
for old, new, exp, desc in CASES:
    got = miner.needs_price_fix(old, new)
    ok(desc, got == exp, f'needs_price_fix({old!r}, {new!r}) = {got},期望 {exp}')

# 邊界:剛好等於門檻要修(>=)
ok('③b 剛好等於 1.5% 門檻 → 修(用 >=)', miner.needs_price_fix(100.0, 101.5) is True)

# ── ⑦ V74.2.2 `bar_is_complete`:這根 K 算不算數(⛔ 不可只看 volume)──────
#    🚨 這是比 needs_price_fix 更前面一層的守門 —— 它被騙過的話,
#       後面的 yfinance 校正**根本沒機會執行**(實測 log:6488 印「⚡ 本日 K 線與最終籌碼已完整」)。
BAR_CASES = [
    ({'close': 949.0, 'volume': 9687682}, True,  '⑦ 收盤價與量都有 → 完整'),
    ({'close': None, 'volume': 11494305}, False, '⑦ 🚨 有量但沒收盤價(6488 真實情況)→ ⛔ 不可當成完整'),
    ({'close': 0, 'volume': 100},         False, '⑦ 收盤 0 → 不完整'),
    ({'close': -1, 'volume': 100},        False, '⑦ 收盤負數 → 不完整'),
    ({'close': 949.0, 'volume': 0},       False, '⑦ 有價沒量(假日空棒)→ 不完整'),
    ({'close': 949.0, 'volume': None},    False, '⑦ 量是 None → 不完整'),
    ({'close': 'x', 'volume': 100},       False, '⑦ 壞值 → 不完整'),
    (None,                                False, '⑦ 沒有這根 → 不完整'),
    ({},                                  False, '⑦ 空 dict → 不完整'),
]
for rec, exp, desc in BAR_CASES:
    got = miner.bar_is_complete(rec)
    ok(desc, got == exp, f'bar_is_complete({rec!r}) = {got},期望 {exp}')

# ── ⑤⑥ 呼叫端真的接上 ────────────────────────────────────────
src = (ROOT / 'miner.py').read_text(encoding='utf-8')
ok('⑥ 🚧 空過守門:needs_price_fix 有定義', 'def needs_price_fix(' in src)
ok('⑥b 🚧 空過守門:呼叫端真的用它(⛔ 防「寫了但沒接」)',
   len(re.findall(r'(?<!def )needs_price_fix\(', src)) >= 1,
   re.findall(r'.{0,40}needs_price_fix\(.{0,40}', src))
ok('⑤ ⛔ 舊的壞判斷式已移除(`old_c > 0 and abs(`)',
   not re.search(r"old_c > 0 and abs\(", src))
# ⑦b 兩處守門都要接上 bar_is_complete —— ⛔ 只接一處等於沒修
#    (latest_valid_date 決定「今天採完沒」、has_gap 決定「近 10 日有沒有洞」)
ok('⑦b latest_valid_date 走 bar_is_complete(⛔ 不可只看 volume)',
   re.search(r"if bar_is_complete\(row\):\s*\n\s*latest_valid_date = fmt_date", src) is not None)
ok('⑦c has_gap 也要把「收盤價空殼」算成缺口',
   re.search(r"has_gap = any\(\(d not in existing_map\) or not bar_is_complete", src) is not None)
ok('⑦d ⛔ 舊的「只看 volume」判斷式已移除',
   not re.search(r"if row\['volume'\] is not None and row\['volume'\] > 0:\s*\n\s*latest_valid_date", src))
ok('⑤b stale 名單涵蓋「官方有回但收盤價是空的」',
   re.search(r"_bad = \[ds for ds in recent_10[\s\S]{0,200}get\('close'\) or 0\) > 0\]", src) is not None)

# ⚠️ 這個 bug 的本體是「拿 `or 0` 去判斷 None」→ 全檔掃一次同型寫法,免得別處還有。
# 🚨 掃之前**一定要先把註解行拿掉** —— 上面那段說明 bug 的註解裡就寫著壞寫法本身,
#    不排除的話會被自己的文件擋下(本專案第 8 次踩這個坑,見 CLAUDE.md)。
code_only = '\n'.join(l for l in src.split('\n') if not l.lstrip().startswith('#'))
# ⛔ `_bad` 名單那一處是**刻意**用 `not (... or 0) > 0` 找出壞掉的日子,是修法不是 bug → 排除它
code_only = re.sub(r"_bad = \[ds for ds in recent_10[\s\S]{0,220}?\]\n", '', code_only)
same_bug = re.findall(r"\.get\('close'\)\s+or\s+0\b[\s\S]{0,60}?>\s*0", code_only)
ok('⑤c ⚠️ 程式碼(排除註解)裡沒有其他「`.get(close) or 0` 之後又拿 >0 當守門」的同型寫法',
   len(same_bug) == 0, f'{len(same_bug)} 處:{same_bug}')
# 🚧 空過守門:排除註解後檔案不可被砍太多(⛔ 否則上面那條變成「掃了個空字串」的假通過)
ok('⑤d 🚧 空過守門:排除註解後仍保留大部分程式碼', len(code_only) > len(src) * 0.7,
   f'{len(code_only)}/{len(src)}')

# ── ⑧ V74.2.3 寫檔前濾掉「沒有收盤價」的空殼(根治歷史中間殘留的壞列)─────
#    ⚠️ V74.2.2 的 yfinance 校正只看**最近 10 個交易日** → 補不到歷史中間那幾根;
#       而下游只要 `float(None)` 就整檔算不出東西(6690/3131/6187 就是這樣被 screener 略過的)。
ok('⑧ export_json 寫檔前濾掉沒有收盤價的列',
   re.search(r"records = \[r for r in records if isinstance\(r\.get\('close'\), \(int, float\)\) and r\['close'\] > 0\]", src) is not None)
ok('⑧b 🚧 全部都是壞列時 ⛔ 不可寫出空檔覆蓋好資料',
   re.search(r"if not records:\s*\n\s*continue", src) is not None)
ok('⑧c 濾掉時要印出來(⛔ 不可靜默刪資料)',
   re.search(r'print\(f".{0,6}\{sym\} 濾掉 \{_n0 - len\(records\)\} 根', src) is not None)

scr_src = (ROOT / 'screener_miner.py').read_text(encoding='utf-8')
ok('⑧d screener_miner 也要防禦(即使 K 線還有壞列也要算得出來)',
   re.search(r"d = \[r for r in d if isinstance\(r\.get\('close'\), \(int, float\)\) and r\['close'\] > 0\]", scr_src) is not None)

print()
print(f"❌ {len(fails)} 條失敗" if fails else '✅ PRICEFIX_PASS(全部通過)')
sys.exit(1 if fails else 0)
