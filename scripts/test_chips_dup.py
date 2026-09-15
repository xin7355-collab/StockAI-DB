#!/usr/bin/env python3
"""
🚨 分點淨額的兩個「幾何式膨脹」來源(V77.0.5)

📊 實跑證據(⛔ 不是推論):
  ・買超榜 164,881 格裡 **67,651 格(41.0%)是重複的分點名**(600 檔)
  ・**買方淨額合計 ÷ 當日成交量 中位 5.43**、87.7% 的天 > 1(物理上不可能)
    —— 而且 P10 0.78 → P90 15.48 散得很開 = ⛔ 跟單位換算無關,是「跑過幾輪」的差別

真因兩層,都在 `_fetch_chips` 的 `by_date` 這一層:
  ① **同一天被抓一次又被還原一次** —— 逐檔模式有 `_have_dates` 擋著,
     **批次模式沒有**;而還原那份以**名稱**為鍵、API 那份以 **broker_id** 為鍵
     → 落在不同 key、逃過覆蓋 → `_agg_period` 按名稱併起來 = 加倍,
     再被 `_day_snaps` 寫回 hist → **下一輪再加一次**。
  ② **同名分點沒有先併就丟進 top-15** —— 一個顯示名底下有多個 broker_id
     → 新抓的日子寫成好幾列、還原的日子只有一列(**形狀不一致**),
     而且任何用名稱當鍵的消費端(前端 `_chipRunBuy`)只會留下**最後那列**
     = 淨額由大到小排的最後一個 = 最小的碎片(中位少算 94.7%)。

⛔ 這支釘住的是**用意**(⛔ 不釘字串):
  ① 本輪抓到的日子⛔ 不可再從 hist 還原(否則同一天加兩次)
  ② hist 寫入前同名要**先併再截斷** top-15
  ③ 併均價要**加權**(⛔ 不可直接取其中一列)
  ④ 前端 `_chipRunBuy` 要**先加總再比門檻**(⛔ 不可 `m.set` 覆蓋)
     —— 這一層⛔ 不可因為「採礦已經修了」就拿掉:gh-pages 上**既有的歷史天補不回來**
"""
import ast, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []
def ok(n, c, e=''):
    print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
    if not c: fails.append(n)

# ⚠️ 斷言先剝掉註解再比 —— 本 repo 已踩過 6 次「被自己寫的註解救活」
raw = (ROOT / 'miner.py').read_text(encoding='utf-8')
src = re.sub(r'(?m)^\s*#[^\n]*$', '', raw)
src = re.sub(r'(?m)#[^\n\'"]*$', '', src)

# ── ① 本輪抓到的日子不可再還原
ok('① 有算出「本輪自己抓到哪幾天」', '_fresh_dates' in src)
ok('① 還原迴圈會跳過那幾天(⛔ 否則同一天加兩次)',
   re.search(r'_fresh_dates\s*:\s*\n\s*continue', src) is not None
   or re.search(r'if\s+_hd\s+in\s+_fresh_dates', src) is not None)
# 順序:_fresh_dates 必須算在還原迴圈**之前**
# ⚠️ `for _h in (existing_obj.get('hist')` 在檔案裡有**兩處**(另一處是算 `_have_dates` 的)
#    → ⛔ 不可用 `find` 抓第一個(我第一版就是這樣寫出假失敗的)。
#    用**還原迴圈自己的特徵** `_slot = by_date.setdefault` 往回找那一圈的開頭。
i_slot = src.find('_slot = by_date.setdefault')
i_loop = src.rfind("for _h in (existing_obj.get('hist')", 0, i_slot) if i_slot > 0 else -1
i_fresh = src.find('_fresh_dates =')
ok('①b 而且要算在還原迴圈之前(排後面等於沒接上)', 0 <= i_fresh < i_loop, f'{i_fresh} vs {i_loop}')

# ── ② hist 寫入前同名先併
ok('② hist 寫入前有同名合併表', '_merge2' in src)
mseg = src[src.find('_merge2'): src.find('_b2 = sorted')] if '_merge2' in src else ''
ok('②b 合併是**累加**淨額(⛔ 不是覆蓋)', re.search(r"_m2\['net'\]\s*\+=", mseg) is not None)
# 併必須排在 top-15 截斷之前
i_m, i_cut = src.find('_merge2'), src.find('_b2 = sorted')
ok('②c 先併、再截斷 top-15(⛔ 反過來等於沒修)', 0 <= i_m < i_cut, f'{i_m} vs {i_cut}')

# ── ③ 均價加權
ok('③ 合併均價是加權的(pv/vol 一起累加)',
   re.search(r"_m2\['pv'\]\s*\+=", mseg) is not None and re.search(r"_m2\['vol'\]\s*\+=", mseg) is not None)

# ── ④ 前端先加總再比門檻
html = (ROOT / 'index.html').read_text(encoding='utf-8')
seg = html[html.find('_chipRunBuy('): html.find('_chipRunBuy(') + 3000]
seg_nc = '\n'.join(l.split('//')[0] for l in seg.split('\n'))
ok('④ 前端 _chipRunBuy 先加總同名再比門檻',
   re.search(r'sum\.set\([^)]*sum\.get\(', seg_nc) is not None)
ok('④b ⛔ 不可再出現「邊讀邊 set net」的覆蓋寫法',
   re.search(r'm\.set\(String\(row\[0\]\),\s*net\)', seg_nc) is None)

# ── ⑤ 語法還活著
try:
    ast.parse(raw); ok('⑤ miner.py 語法 OK', True)
except SyntaxError as e:
    ok('⑤ miner.py 語法 OK', False, e)

print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ CHIPS_DUP_PASS'))
sys.exit(1 if fails else 0)
