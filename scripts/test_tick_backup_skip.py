#!/usr/bin/env python3
"""⏭️ V79.5.6 盤後才到的「排程備援」:今天主迴圈已經跑到最後一拍 → ⛔ 不再整天重抓逐筆。

為什麼要有這支:10/22 的 📶 log —— 主迴圈 13:23 收工時永豐流量用了 181 MB,之後兩條被 GitHub 延遲
約 5 小時的 cron(13:57 / 15:53 才跑)各把 80 檔整天逐筆重抓(78.6 萬筆、各約 50 MB),資料跟 13:23 一樣。

釘住:
  ①  只有「排程 + 平日 + 收盤後 + 已發佈那份是今天 13:20 以後」才跳過,其他一律照常抓
  ②  main() 真的在登入之前就結束(⛔ 不 import shioaji、不碰金鑰),而且把已發佈的原檔一個位元組不差寫回
  ③  ⭐ 決定性對照:同一個時間、同一份已發佈檔,換成手動觸發 → 一定往下走(沒有金鑰 → exit 1)
  ④  主迴圈沒跑到最後一拍(11:05 就停)→ 備援照常抓
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import tick_flow_miner as M  # noqa: E402

TW = timezone(timedelta(hours=8))
FAILS = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond:
        FAILS.append(name)


def pub(upd_utc, n=80):
    return {'updated': upd_utc, 'ts': '10/22 13:23', 'big_lots': 50,
            'data': {f'{2300 + i}': {'out': 1, 'in': 1, 'bb': 0, 'bs': 0} for i in range(n)}}


THU = datetime(2026, 10, 22, 13, 57, tzinfo=TW)          # 週四 13:57(第一條延遲的 cron)
P_DONE = pub('2026-10-22T05:23:36Z')                       # 台北 13:23 —— 主迴圈最後一拍
P_EARLY = pub('2026-10-22T03:05:10Z')                      # 台北 11:05 —— 主迴圈中途掛掉
P_YDAY = pub('2026-10-21T05:23:36Z')                       # 昨天
R = M._backup_skip_reason

# ① 純函式
ok('①a 排程・收盤後・今天 13:23 已抓完 → 跳過', bool(R('schedule', THU, P_DONE)), R('schedule', THU, P_DONE))
ok('①b 15:53 第二條延遲的 cron 也跳過', bool(R('schedule', THU.replace(hour=15, minute=53), P_DONE)))
ok('①c 手動觸發 → 照常(盤後測試靠首輪)', R('workflow_dispatch', THU, P_DONE) is None)
ok('①d worker 叫醒 → 照常', R('repository_dispatch', THU, P_DONE) is None)
ok('①e 盤中的接手(10:32 準時到)→ 照常', R('schedule', THU.replace(hour=10, minute=32), P_DONE) is None)
ok('①f 13:30 還沒過收盤後門檻 → 照常', R('schedule', THU.replace(hour=13, minute=30), P_DONE) is None)
ok('①g 已發佈那份是昨天的(今天主迴圈沒跑)→ 照常', R('schedule', THU, P_YDAY) is None)
ok('①h 主迴圈 11:05 就停了 → 照常(備援要補)', R('schedule', THU, P_EARLY) is None)
ok('①i 讀不到已發佈那份 → 照常', R('schedule', THU, None) is None)
ok('①j 已發佈那份檔數太少(<MIN_STOCKS)→ 照常', R('schedule', THU, pub('2026-10-22T05:23:36Z', n=5)) is None)
ok('①k 時間格式壞掉 → 照常', R('schedule', THU, dict(P_DONE, updated='10/22 13:23')) is None)
ok('①l 週六 → 照常', R('schedule', datetime(2026, 10, 24, 13, 57, tzinfo=TW), P_DONE) is None)


# ② / ③ main() 真的接上(假時鐘 + 假的「已發佈那份」)
class _Clock(datetime):
    fixed = THU

    @classmethod
    def now(cls, tz=None):
        return cls.fixed.astimezone(tz) if tz else cls.fixed.replace(tzinfo=None)


def run_main(event, published):
    raw = json.dumps(published, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b' '
    saved = (M.datetime, M._fetch_published, dict(os.environ), os.getcwd())
    d = tempfile.mkdtemp()
    os.chdir(d)
    M.datetime = _Clock
    M._fetch_published = lambda timeout=20: (raw, published)
    os.environ['GITHUB_EVENT_NAME'] = event
    os.environ.pop('SHIOAJI_API_KEY', None)
    os.environ.pop('SHIOAJI_SECRET_KEY', None)
    sys.modules.pop('shioaji', None)
    code = None
    try:
        M.main()
    except SystemExit as e:
        code = e.code
    finally:
        out = open('tick_flow.json', 'rb').read() if os.path.exists('tick_flow.json') else None
        hist = os.path.exists('tick_hist.json')
        M.datetime, M._fetch_published = saved[0], saved[1]
        os.environ.clear()
        os.environ.update(saved[2])
        os.chdir(saved[3])
    return code, out, raw, hist


code, out, raw, hist = run_main('schedule', P_DONE)
ok('②a 排程備援:main() 正常結束(沒有 exit 1)', code is None, code)
ok('②b 寫回的 tick_flow.json 跟已發佈那份一個位元組都不差(部署會是「無變更」)', out == raw)
ok('②c ⛔ 沒有登入(連 shioaji 都沒 import)', 'shioaji' not in sys.modules)
ok('②d ⛔ 沒有動 tick_hist.json', not hist)

code, out, raw, _ = run_main('workflow_dispatch', P_DONE)
ok('③ 決定性對照:同一份資料改成手動觸發 → 往下走(沒有金鑰 → exit 1),⛔ 不可跳過', code == 1 and out is None, (code, out is not None))

code, out, _, _ = run_main('schedule', P_EARLY)
ok('④ 主迴圈 11:05 就停的那天,排程備援照常往下走(沒有金鑰 → exit 1)', code == 1 and out is None, code)

# ⑤ 靜態:跳過的判斷必須排在登入之前
src = open(os.path.join(ROOT, 'tick_flow_miner.py'), encoding='utf-8').read()
body = src[src.index('def main():'):]
ok('⑤ 跳過的判斷排在 api.login 之前', body.index('_backup_skip_reason(') < body.index('api.login('))

print(f'\n{"❌ " + str(len(FAILS)) + " 條失敗" if FAILS else "✅ 全部通過"}')
sys.exit(1 if FAILS else 0)
