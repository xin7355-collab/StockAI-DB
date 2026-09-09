#!/usr/bin/env python3
"""🪶 V74.3.8 hist 深度守門 —— 陷阱 #10 的第三次犯案。

實測 #534 的 job log:
  「chips_deep 還原:分支上 469 天・這輪要 43 天・**取得 15 天**」  ← V74.3.1 修好了
  「分點籌碼完成:更新 64 檔、**今日已抓跳過 2,625 檔**」          ← 卡在這一關
15 天已經在 `_bulk_idx` 記憶體裡,卻因為「今天抓過」被跳過 → hist 中位仍然是 2。

這支釘住三件事(⛔ 拿掉任何一件都會讓功能安靜地退回去):
  ① 跳過條件必須**同時**看「做過沒」「最新那天對不對」「hist 夠不夜深」
  ② 只補 hist 的那條路徑必須是**零 API**(⛔ 不可打 Sniper 免費爬蟲)
  ③ 逐檔模式(_bulk_idx is None)⛔ 不可受影響 —— 那裡每天都要真的打 HTTP

已用注入驗證:拿掉 `_hist_deep_ok`、讓 Sniper 無條件呼叫 → 都要被抓出來。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
fails = []


def ok(name, cond, extra=''):
    print(('✅' if cond else '❌') + f' {name}' + ('' if cond else f'  {str(extra)[:220]}'))
    if not cond:
        fails.append(name)


# 抽出跳過條件那個 if 的完整條件式
# ⚠️⚠️ 第一版用 `if \(os.environ.get\('FORCE_CHIPS_REFRESH'\)...(.*?)_skipped_today` 全檔搜 ——
#   結果匹配到**另一處** FORCE_CHIPS_REFRESH 判斷(預掃那段),而且範圍跨過中間幾百行、
#   把 `_hist_deep_ok` 的定義也吃進來 → 注入「拿掉 _hist_deep_ok」時**照樣綠**。
#   ⭐ 這個錯只有靠注入驗證才抓得到(同 V73.8.7「全檔比對抓到不相干的排序」)。
#   正解:以 `_skipped_today += 1` 為錨**往前**抓,只看它自己那個 if。
_anchor = SRC.index('_skipped_today += 1')
_ifstart = SRC.rindex("if (os.environ.get('FORCE_CHIPS_REFRESH')", 0, _anchor)
cond = SRC[_ifstart:_anchor]
ok('① 找得到跳過條件(且只抓它自己那一段)', 0 < len(cond) < 700, len(cond))

ok('①a 條件含「今天做過沒」(V68.9.8)', "chips_fetched_on" in cond, cond)
ok('①b 條件含「最新那天對不對」(V71.1.5,⛔ 拿掉會讓熱門股永遠拿舊資料)',
   "_is_current" in cond, cond)
ok('①c 🚨 條件含「hist 夠不夠深」(V74.3.8,⛔ 拿掉 hist 中位會卡在 2 天)',
   "_hist_deep_ok" in cond, cond)

# _hist_deep_ok 的算法:必須跟「這輪手上有幾天」比,⛔ 不可寫死天數
m2 = re.search(r"_hist_deep_ok = True(.*?)_hist_only = ", SRC, re.S)
calc = m2.group(1) if m2 else ''
ok('② hist 深度要跟「_bulk_idx 這輪手上有幾天」比,⛔ 不可寫死數字',
   "_bulk_idx.get(sym)" in calc and "CHIP_HIST_KEEP" in calc and "_avail_days" in calc, calc[:200])
ok('②b ⛔ 逐檔模式(_bulk_idx is None)不可受影響 —— 那裡每天都要真的打 HTTP',
   "if _bulk_idx is not None:" in calc, calc[:200])

# ③ 零 API:_hist_only 時不可打 Sniper
m3 = re.search(r"sniper_data = (.*?)\n", SRC[SRC.index('_hist_only = '):])
sn = re.search(r"sniper_data = None if _hist_only else _fetch_twse_bsr\(sym\)", SRC)
ok('③ 🚨 只補 hist 時⛔ 不可打 Sniper 免費爬蟲(每檔 2~3 秒 × 2,600 檔 = 兩小時)',
   bool(sn), '找不到 `None if _hist_only else _fetch_twse_bsr`')

# ③b 批次模式下不會走逐檔 FinMind(那段本來就有 if/else,這裡確認沒被改壞)
ok('③b 批次模式不走逐檔 FinMind 迴圈(零 API 的另一半)',
   "for _d in ([] if _bulk_idx is not None else _recent_finmind_dates(_lookback)):" in SRC)

# ④ 要印出來(⛔ 靜默的話下一個人看不出這條有沒有作用)
ok('④ 收尾要印「hist 補深度 N 檔」(⛔ 不可靜默 —— 那是唯一看得出它有沒有作用的線索)',
   "_hist_fixed" in SRC and "hist 補深度" in SRC)
ok('④b _hist_fixed 有初始化(⛔ 否則 NameError 會被外層 except 吞掉)',
   re.search(r"_hist_fixed = 0", SRC) is not None)

# ⑤ 純邏輯重演:守門在四種情境下的行為
def gate(fetched_today, is_current, own_hist, avail_days, bulk=True):
    """重演 miner 的判斷(⚠️ 這是**重演**不是複製 —— 上面 ①~③ 已經釘住原始碼長什麼樣)"""
    deep_ok = True
    if bulk and avail_days:
        deep_ok = own_hist >= min(22, avail_days)
    skip = fetched_today and is_current and deep_ok
    hist_only = is_current and not deep_ok and fetched_today
    return skip, hist_only


for name, args, exp_skip, exp_ho in [
    ('已抓+最新+hist夠深 → 跳過', (True, True, 15, 15), True, False),
    ('已抓+最新+hist只有2天(#534 實況)→ ⛔ 不可跳過,走零 API 補 hist', (True, True, 2, 15), False, True),
    ('沒抓過 → 正常抓', (False, True, 2, 15), False, False),
    ('已抓但不是最新 → 正常抓(V71.1.5)', (True, False, 15, 15), False, False),
    ('逐檔模式(無批次)hist 淺也照跳', (True, True, 2, 0, False), True, False),
]:
    sk, ho = gate(*args)
    ok(f'⑤ {name}', sk == exp_skip and ho == exp_ho, f'skip={sk}(期望{exp_skip}) hist_only={ho}(期望{exp_ho})')

print()
if fails:
    print(f'❌ TEST_HISTGATE_FAIL({len(fails)}):', fails)
    sys.exit(1)
print('✅ TEST_HISTGATE_PASS(全部通過)')
