#!/usr/bin/env python3
"""🏭 產業對照表 / 股名離線表 / 公司縣市 —— ⛔ 不可再被「TWSE 基本面回空」一起擋掉(陷阱 #44)

⭐ 釘的是**用意**,不是行號:
  ⓐ `fetch_industry_map()` / `build_stock_names()` / company_geo ⛔ 不可包在 `if twse_fund:` 裡;
     只有 `aggregate_industry_pe()` 可以(它真的需要那份本益比)。
  ⓑ 上櫃要走**實測會通的那個網址**(`mopsfin_t187ap03_O`),舊的 twse 那條只能當備援。
  ⓒ FinMind 備援要把中文產業名**反查回代碼**,而且用 `screener_miner.IND`(⛔ 不另抄一份 → 陷阱 #17)。
  ⓓ JSON 解不開時要把 **body 印出來**(陷阱 #23:回 200 + 網頁,只印例外訊息看起來像網路壞了)。

📊 為什麼寫這支(實跑證據,daily_miner #576 chips job log 逐字):
   ⏭️ TWSE 基本面回空,跳過產業 PE 聚合(YoY/毛利已獨立補入既有快取)
   → 2026-09-12/13/14 連三輪,而那個閘門底下還掛著 industry_map / stock_names / company_geo。
   而上櫃那支從 08-31 到 09-11 **6 輪全部** `Expecting value: line 1 column 1`(= 回 200 但不是 JSON)。
"""
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
# ⚠️ 原始碼斷言一律先剝掉 `#` 註解 —— 本 repo 被自己的註解救活斷言已經三次
NOCOM = re.sub(r'(?m)#[^\n]*', '', SRC)
# ⚠️ 斷言一律**只比 fetch_industry_map 那一段** —— 整檔比會被別處的同名字串救活:
#   實測注入「拿掉 FinMind 備援」時,`TaiwanStockInfo` 因為 `TaiwanStockInfoWithWarrantSummary`
#   在檔案別處出現而照樣綠(本 repo 第五次踩到「斷言被別處的同樣字串救活」)。
SEG = NOCOM[NOCOM.find('def fetch_industry_map'):NOCOM.find('def build_stock_names')]
fails = []


def ck(cond, msg):
    print(('✅ ' if cond else '❌ ') + msg)
    if not cond:
        fails.append(msg)


tree = ast.parse(SRC)

# ── 建 parent 連結,才問得出「這個呼叫被哪些 if 包著」 ──────────────
parent = {}
for node in ast.walk(tree):
    for child in ast.iter_child_nodes(node):
        parent[child] = node


def gated_by_twse_fund(call_node):
    """這個呼叫是不是被 `if twse_fund:` 的**成立分支**包著"""
    cur = call_node
    while cur in parent:
        p = parent[cur]
        if isinstance(p, ast.If) and isinstance(p.test, ast.Name) and p.test.id == 'twse_fund' \
                and any(cur is s or cur in _descend(s) for s in p.body):
            return True
        cur = p
    return False


def _descend(node):
    out = set()
    for n in ast.walk(node):
        out.add(n)
    return out


calls = {}
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        calls.setdefault(node.func.id, []).append(node)

FREE = ['fetch_industry_map', 'build_stock_names']
NEED = 'aggregate_industry_pe'
for name in FREE:
    ns = calls.get(name, [])
    ck(len(ns) >= 1, f'ⓐ0 找不到 {name}() 的呼叫 → 這一條不算數(切片或函式改名)')
    for n in ns:
        ck(not gated_by_twse_fund(n),
           f'ⓐ {name}() 又被包回 `if twse_fund:` 裡了 —— 一支不相干的 API 回空就會讓它整批不更新(陷阱 #44)')

ns = calls.get(NEED, [])
ck(len(ns) >= 1, f'ⓐ2-0 找不到 {NEED}() 的呼叫 → 這一條不算數')
ck(all(gated_by_twse_fund(n) for n in ns),
   f'ⓐ2 {NEED}() 沒有被 `if twse_fund:` 包住 —— 它**真的**需要那份本益比,沒有就別算(空過守門)')

# ── ⓑ 上櫃的門牌 ────────────────────────────────────────────────
ck('mopsfin_t187ap03_O' in SEG,
   'ⓑ 上櫃沒有走 `mopsfin_t187ap03_O`(repo 裡另外四支在用、而且 2026-09-09 實測拿得到 1,984 檔的那個)')
m = re.search(r"\('TPEX 上櫃',\s*\[(.*?)\]\)", SEG, re.S)
ck(bool(m), 'ⓑ0 找不到上櫃的來源清單 → 這一條不算數')
if m:
    urls = re.findall(r"'([^']+)'", m.group(1))
    ck(len(urls) >= 2, f'ⓑ2 上櫃只有 {len(urls)} 個來源 —— www.tpex.org.tw 對 runner 會間歇 SSLError,⛔ 不可只靠一條腿')
    ck(urls and 'mopsfin' in urls[0], f'ⓑ3 上櫃的**第一順位**不是那個實測會通的網址:{urls[:1]}')

# ── ⓒ FinMind 備援:中文產業名要反查回代碼,而且⛔ 不另抄一份對照表 ──
ck("dataset=TaiwanStockInfo'" in SEG, 'ⓒ 上櫃沒有 FinMind 備援 —— 兩個官方網址都不通時那一格就永遠空著')
ck('from screener_miner import IND' in SEG,
   'ⓒ2 產業代碼對照表沒有走 screener_miner.IND → 抄第二份就會有兩種格式(陷阱 #17)')
ck("'01': '水泥'" not in SRC, 'ⓒ3 miner.py 裡自己抄了一份產業代碼表 → ⛔ 單一真相')

# ── ⓓ 回 200 但不是 JSON 時要把 body 印出來(陷阱 #23)──────────
seg = SEG
ck(len(seg) > 800, 'ⓓ0 切不到 fetch_industry_map → 這一條不算數')
ck('r.text' in seg, 'ⓓ JSON 解不開時沒有把 body 印出來 → 「網址錯」跟「被擋」永遠分不出來(陷阱 #23)')
ck('sorted(data[0].keys())' in seg,
   'ⓓ2 回了資料卻一列都認不出來時沒有印**實際欄名** → 下一個人又要猜一輪')

print()
if fails:
    print(f'❌ INDUSTRY_GATE_FAIL:{len(fails)} 條')
    sys.exit(1)
print('✅ INDUSTRY_GATE_PASS')
