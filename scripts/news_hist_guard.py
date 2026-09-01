#!/usr/bin/env python3
"""🚧 消息面歷史「只增不減」守門(V74.2.8)

用法:python3 scripts/news_hist_guard.py <新的> <gh-pages 上現有的>

⭐ 為什麼要有這一層(⛔ 別把它併回 universal_radar.py):
   `universal_radar.build_news_history` 自己的守門**只看得到本機那一份**。
   如果 workflow 的「還原」那步失敗(網路/權限/分支還沒建立),它會以為
   「本來就沒有歷史」→ 寫出只有今天的一份 → 推上去就把幾百天洗掉了,
   而且**完全不會報錯**(這正是累積型檔案最典型的死法)。
   → 所以推之前一定要再跟 **gh-pages 上現有的那份**比一次。

⛔ 行為:新的天數比舊的少 → 把舊的複製回去(= 這一輪不更新),並印出原因。
   ⚠️ 一律 exit 0 —— 這是保護不是失敗,⛔ 不可讓它擋掉其他新聞檔的部署。
"""
import json
import shutil
import sys


def days(path):
    """回傳這份檔案有幾天;讀不到/壞掉回 -1(⛔ 不可回 0 —— 那會跟「真的空的」混淆)。"""
    try:
        with open(path, encoding='utf-8') as f:
            return len(json.load(f).get('days') or {})
    except Exception:
        return -1


def main():
    if len(sys.argv) < 3:
        print('  ⏭️ 消息面歷史守門:參數不足,跳過')
        return 0
    new_p, prev_p = sys.argv[1], sys.argv[2]
    new, prev = days(new_p), days(prev_p)
    if new < 0:
        print('  ⏭️ 消息面歷史:這一輪沒有產出(或檔案壞掉)→ 不動 gh-pages 上的那份')
        if prev > 0:
            shutil.copyfile(prev_p, new_p)
        return 0
    if prev > 0 and new < prev:
        print(f'  ⛔ 消息面歷史:新的只有 {new} 天、少於 gh-pages 上的 {prev} 天 '
              f'→ 拒絕覆蓋(疑似還原失敗)')
        shutil.copyfile(prev_p, new_p)
        return 0
    print(f'  ✅ 消息面歷史:{new} 天(gh-pages 上原本 {prev if prev >= 0 else 0} 天)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
