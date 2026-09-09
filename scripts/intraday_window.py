#!/usr/bin/env python3
"""
⏱️ 盤中常駐迴圈的「下一拍」計算器(V73.9.0)

🚨 為什麼需要這支 —— 真因不是 concurrency,是 **GitHub 根本不把高頻 schedule 變成 run**:

  實測(2026-08-19 ~ 08-25,repo 全部 workflow 都是 state=active):
  ┌────────────────────────┬──────────────┬──────────────┐
  │ workflow               │ cron 要求/天 │ 實際 run     │
  ├────────────────────────┼──────────────┼──────────────┤
  │ live_snapshot(每 5 分) │      ~58     │ **3**(6 天) │
  │ tick_flow    (每 10 分)│      ~27     │ **0**        │
  │ macro_cron / news_expr │       5~6    │ **0**        │
  │ stock_futures          │       2      │ **0**        │
  │ theme_news / daily_miner│      1~2    │ ✅ 全部正常  │
  └────────────────────────┴──────────────┴──────────────┘

  ⭐⭐ 分界線很清楚:**一天 1~2 次的排程 100% 可靠,高頻的幾乎全被丟掉**。
  ⛔ 而且它們**不是 `cancelled`,是連 run 都沒有** —— 所以 Actions 頁面一片乾淨,
     看不出任何異常(陷阱 #9 的極端版:連「有沒有跑」都看不到)。

⭐ 所以架構要換:**⛔ 不要求 GitHub 幫我們排 58 次,改成排 1 次、自己在 job 裡面迴圈。**
   這支負責回答「現在該跑了嗎 / 還要睡多久 / 收盤了沒」,單獨抽出來是為了**可以測**
   (⛔ 時間邊界寫在 bash 裡沒辦法注入假時間驗證)。

用法:
    python3 scripts/intraday_window.py quotes            # 用現在的台北時間
    python3 scripts/intraday_window.py ticks --now 09:07 # 注入時間(測試用)

輸出**恰好一行**,三種之一:
    RUN          → 現在就跑一輪
    SLEEP <秒>   → 還沒到下一拍,睡這麼久
    DONE         → 今天的窗口結束,跳出迴圈

⛔ 三條刻意的設計:
  ① **窗口結束用「超過 END」而不是「等於 END」** —— 13:30 那一拍要跑得到
     (收盤價就是那一拍抓的,漏掉等於整天白做)。
  ② **SLEEP ⛔ 不可回 0** —— 回 0 會讓 bash 迴圈空轉燒 CPU;最少 5 秒。
  ③ **假日/非交易日直接 DONE** —— ⛔ 但「手動觸發要能測」由呼叫端負責
     (workflow 會先無條件跑一輪再進迴圈),這支不管那件事。
"""
import sys
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))

# (開始, 結束, 每幾分鐘, 分鐘偏移)
#  ⚠️ ticks 的 offset=3 是刻意的 —— 錯開 quotes 的整 5 分,兩支同時 push gh-pages 會互相 rebase。
#  ⚠️ 改這裡要同步改 workflow 的 timeout-minutes(窗口長度 + 緩衝),否則會被 GitHub 中途砍掉。
PROFILES = {
    #          start        end          every offset
    'quotes': ((8, 45), (13, 30), 5, 0),   # 台北 08:45(台指期先開)~13:30 收盤
    'ticks':  ((9,  3), (13, 23), 10, 3),  # ticks 比較重 → 10 分一拍
}


def decide(profile: str, now: datetime) -> str:
    """回 'RUN' / 'SLEEP <秒>' / 'DONE'。now 必須是帶時區的台北時間。"""
    (sh, sm), (eh, em), every, off = PROFILES[profile]

    # ③ 週末直接收工(台股沒有盤)
    if now.weekday() >= 5:
        return 'DONE'

    start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = now.replace(hour=eh, minute=em, second=0, microsecond=0)

    # ① ⛔ 用 `now > end` 不是 `>=` —— 13:30 那一拍要跑得到(收盤價就在那一拍)。
    #    多給 90 秒容忍,避免剛好卡在 13:30:05 就整天少最後一筆。
    if now > end + timedelta(seconds=90):
        return 'DONE'

    if now < start:
        return _sleep(max(5, int((start - now).total_seconds())))

    # 現在這一分鐘是不是節拍上?(秒數 <30 才算,避免同一拍跑兩次)
    if (now.minute - off) % every == 0 and now.second < 30:
        return 'RUN'

    # 算下一拍
    ahead = (off - now.minute) % every
    if ahead == 0:
        ahead = every
    nxt = (now.replace(second=0, microsecond=0) + timedelta(minutes=ahead))
    # ⛔ 下一拍已經超出窗口 → 直接 DONE,別白睡幾分鐘才發現收工了
    if nxt > end + timedelta(seconds=90):
        return 'DONE'
    return _sleep(max(5, int((nxt - now).total_seconds())))


def _sleep(sec: int) -> str:
    # ② ⛔ 永不回 0(bash `sleep 0` = 空轉燒 CPU)
    return f'SLEEP {max(5, int(sec))}'


def main(argv):
    if len(argv) < 2 or argv[1] not in PROFILES:
        print(f'用法: {argv[0]} [{"|".join(PROFILES)}] [--now HH:MM[:SS]]', file=sys.stderr)
        return 2
    profile = argv[1]
    now = datetime.now(TPE)
    if '--now' in argv:
        raw = argv[argv.index('--now') + 1]
        parts = [int(x) for x in raw.split(':')]
        while len(parts) < 3:
            parts.append(0)
        now = now.replace(hour=parts[0], minute=parts[1], second=parts[2], microsecond=0)
    if '--weekday' in argv:  # 測試用:強制指定星期(0=一 … 6=日)
        want = int(argv[argv.index('--weekday') + 1])
        now = now + timedelta(days=(want - now.weekday()))
    print(decide(profile, now))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
