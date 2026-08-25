#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🚨 盤中高頻採礦的排程守門(V73.7.9)

**這支測試存在的理由**(2026-08-20 抓到的真事,而且它已經瞎了 13 天):
  `data/live_quotes.json` **從來沒出現在 gh-pages 上過**、
  `data/tick_flow.json` 停在 08-07 —— 而 workflow **全綠、零錯誤訊息**(陷阱 #9)。
  手動觸發同一份程式碼:84 秒跑完、2,330 檔 + 台指期全對 → **程式沒問題**。

真因:GitHub 的 concurrency **每個 group 只留一個 pending run** —— 後面來的會把前面
還在排隊的直接取消。盤中 live_snapshot(每 5 分)+ tick_flow(每 10 分)約 82 個事件
全擠進共用的 `gh-pages-push`(還跟 deploy_pages / daily_miner deploy 同一個)
→ 只要機器排隊超過幾分鐘就整串互相擠掉。
佐證:live_snapshot 建立 38 天、cron 要求每天約 70 次,`run_number` 卻只有 **62**;
      tick_flow 每天約 27 次,`run_number` 只有 **50**。

⛔ 這支要釘死的五件事:
  ① 高頻盤中採礦 ⛔ 不可回到共用的 `gh-pages-push` group。
  ② 兩支要用**不同**的 group(彼此也不可互相擠)。
  ③ ⭐ `cancel-in-progress: true` **只有在「執行時間 ≪ 觸發間隔」時才安全** ——
     tick_flow(12 分 timeout / 10 分一發)⛔ 不可設 true,否則永遠跑不完。
  ④ 既然離開了共用鎖,push 迴圈的 **retry + rebase 必須還在**(那是唯一的防撞機制)。
  ⑤ `data_audit.py` 的 B2 類必須還在 —— 盤中檔的豁免⛔不可改回**無條件**,
     不然下次停產又是 13 天沒人知道。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:240]}'))
    if not cond:
        fails.append(name)


def head(text, n=40):
    return '\n'.join(text.splitlines()[:n])


LS = (ROOT / '.github/workflows/live_snapshot.yml').read_text(encoding='utf-8')
TF = (ROOT / '.github/workflows/tick_flow.yml').read_text(encoding='utf-8')
AUDIT = (ROOT / 'scripts/data_audit.py').read_text(encoding='utf-8')


def wf_concurrency(src):
    """抓 workflow-level 的 concurrency(⛔ 不含 job 層縮排的那種)。"""
    m = re.search(r'^concurrency:\s*\n^\s+group:\s*(\S+)\s*\n^\s+cancel-in-progress:\s*(\w+)',
                  src, re.M)
    return (m.group(1), m.group(2) == 'true') if m else (None, None)


def crons(src):
    return re.findall(r"cron:\s*'([^']+)'", src)


ls_g, ls_c = wf_concurrency(LS)
tf_g, tf_c = wf_concurrency(TF)

# ── ① ⛔ 不可回到共用 group ────────────────────────────────────────
ok('① 🚨 live_snapshot ⛔ 不可用共用的 gh-pages-push group', ls_g not in (None, 'gh-pages-push'), f'group={ls_g}')
ok('①b 🚨 tick_flow ⛔ 不可用共用的 gh-pages-push group', tf_g not in (None, 'gh-pages-push'), f'group={tf_g}')

# ── ② 兩支的 group 要不同 ─────────────────────────────────────────
ok('② 兩支盤中採礦要各自獨立的 group(⛔ 不可互相擠)', ls_g != tf_g, f'{ls_g} vs {tf_g}')

# ── ③ ⭐ cancel-in-progress 只有「執行時間 ≪ 觸發間隔」才安全 ──────
#
# 🚨🚨 V73.9.0 這一組**刻意改寫**(⛔ 不是放寬)—— 原本 ③b/③d/③e 釘的是舊架構
#      「live_snapshot 每 5 分 / tick_flow 每 10 分 / 所以 tick_flow 必須是 false」。
#      新架構下**節拍搬進 job 裡面了**,cron 只剩每天 2~3 次 → 那三條的**前提消失**。
#      ⭐ 上面那條通用鐵則本身**仍然成立**,只是代入的數字變了:
#         觸發間隔 90~120 分 ≫ 一拍 1~2 分 → 兩支都可以、而且**必須**是 true
#         (接手用的排程要殺得掉還活著的主迴圈,才能真的接手)。
#      ⛔ 判斷「可不可以設 true」永遠要看**現在的**觸發間隔,不是抄上一版的結論。
ok('③ live_snapshot 用 cancel-in-progress: true(接手排程要殺得掉主迴圈)', ls_c is True, f'={ls_c}')
ok('③b tick_flow 也是 true —— 前提變了(已無每 10 分的 cron,不可能自己砍自己)',
   tf_c is True, f'={tf_c}')
ok('③c 檔頭要寫清楚這是「刻意推翻」而不是「順手統一」',
   '前提消失' in TF or '前提' in TF, head(TF, 32))

# ── ③d 🚨 反過來釘:cron ⛔ 不可再變密 ────────────────────────────
#    實測(2026-08-19~25)全 repo 一天只有 7~10 筆 schedule run 進得來,
#    而 cron 要求超過 100 筆 → 高頻排程會被整批丟掉(連 run 都不產生)。
#    ⛔ 任何人想把節拍改回 cron,這兩條會擋下來。
for nm, src in (('live_snapshot', LS), ('tick_flow', TF)):
    cs = crons(src)
    ok(f'③d {nm} cron ≤3 條(⛔ 高頻排程會被 GitHub 整批丟掉)', len(cs) <= 3, str(cs))
    ok(f'③e {nm} ⛔ 不可再出現 `*/N` 或逗號列舉的高頻寫法',
       all('*/' not in c.split()[0] and ',' not in c.split()[0] for c in cs), str(cs))
ok('③f 節拍改在 job 裡跑(兩支都要接上 intraday_window.py)',
   'intraday_window.py' in LS and 'intraday_window.py' in TF)

# ── ④ 離開共用鎖後,retry + rebase 是唯一防撞機制,必須還在 ────────
for nm, src in (('live_snapshot', LS), ('tick_flow', TF)):
    ok(f'④ {nm} 的 push retry 迴圈還在(⛔ 沒有共用鎖了,這是唯一防撞)',
       'for i in 1 2 3 4 5; do' in src and 'git push origin gh-pages' in src)
    ok(f'④b {nm} 失敗時要 fetch + rebase 再試',
       'pull --rebase origin gh-pages' in src)

# ── ⑤ data_audit 的 B2 盤中停產偵測 ───────────────────────────────
ok('⑤ data_audit 有 B2 類(盤中檔停產偵測)', "'B2'" in AUDIT and 'B2. 盤中檔' in AUDIT)
ok('⑤b 🚨 盤中檔的豁免 ⛔ 不可再是「無條件」—— 要比對全站最新資料日',
   'newest' in AUDIT and 'LAG_DAYS' in AUDIT, '')
ok('⑤c 盤中時段內檔案不見要報 ❌(⛔ 不可再回「盤中才產出,沒有是正常的」就算了)',
   '現在是盤中卻不在' in AUDIT)
ok('⑤d ⭐ 判準要用「相對全站最新資料日」而不是寫死天數(⛔ 寫死會在連假整排誤報)',
   'newest.date() - ts.date()' in AUDIT)
ok('⑤e 三個盤中檔都在名單裡',
   {'live_quotes.json', 'tick_flow.json', 'daytrade_pack.json'} <=
   set(re.findall(r"'([a-z_]+\.json)'", AUDIT[AUDIT.index('INTRADAY_ONLY ='):][:200])), '')

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ INTRADAY_SCHED_PASS(全部通過)')
sys.exit(1 if fails else 0)
