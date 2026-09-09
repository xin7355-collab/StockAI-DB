#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌅 盤前台指期採礦(V73.7.7)測試

使用者:「新增期貨,因為期貨比現股早開盤,我覺得可以用來比對」
→ 台指期 08:45 開盤、現貨 09:00,但 `live_snapshot.yml` 的排程從台北 09:00 才開始,
  而且 `live_snapshot_miner.py` 有 MIN_STOCKS=300 守門 → 盤前現貨沒開盤會把台指期一起擋掉。

⛔ 這支要釘死的六件事(⚠️ 這是全專案風險最高的改動之一 —— 盤中快照是當沖頁的命脈):
  ① **盤前模式絕不碰 `live_quotes.json`** —— 只寫 `live_index.json`。
  ② **MIN_STOCKS 守門不可被放寬** —— 那是盤中快照的自我保護(抓太少就保留舊檔)。
  ③ **時間判定要正確**:台北 08:30~09:00 平日才算盤前;排程延遲到 09:00 後自動走一般模式。
  ④ **盤前也要有空過守門** —— 期貨沒抓到就 exit 1,⛔ 不可寫空檔覆蓋前一輪。
  ⑤ **期貨抓取只能有一份**(盤前/盤中共用),⛔ 不可複製第二份(陷阱 #37)。
  ⑥ **workflow 部署要分檔** —— 盤前那輪的產物不可寫進 `data/live_quotes.json`。
"""
import importlib.util
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:240]}'))
    if not cond:
        fails.append(name)


SRC = (ROOT / 'live_snapshot_miner.py').read_text(encoding='utf-8')
WF = (ROOT / '.github/workflows/live_snapshot.yml').read_text(encoding='utf-8')

spec = importlib.util.spec_from_file_location('lsm', ROOT / 'live_snapshot_miner.py')
lsm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lsm)

# ── ③ 時間判定 ────────────────────────────────────────────────────────
TW = timezone(timedelta(hours=8))


class _FakeDT:
    """只替換 now(),其餘行為委派給真的 datetime(⛔ 不改系統時鐘)。"""
    _fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls._fixed

    def __getattr__(self, k):
        return getattr(datetime, k)


def at(y, mo, d, h, mi):
    _FakeDT._fixed = datetime(y, mo, d, h, mi, tzinfo=TW)
    return lsm._is_premarket()


real_dt = lsm.datetime
lsm.datetime = _FakeDT
try:
    # 2026-08-20 是星期四;2026-08-22 是星期六
    ok('③ 08:45(平日)→ 盤前', at(2026, 8, 20, 8, 45) is True)
    ok('③b 08:30 邊界(含)→ 盤前', at(2026, 8, 20, 8, 30) is True)
    ok('③c 08:59 → 盤前', at(2026, 8, 20, 8, 59) is True)
    ok('③d 08:29 → ⛔ 不是盤前', at(2026, 8, 20, 8, 29) is False)
    ok('③e 09:00 邊界(不含)→ ⛔ 一般模式(現貨已開,全市場掃才對)', at(2026, 8, 20, 9, 0) is False)
    ok('③f 09:05(排程延遲)→ ⛔ 自動走一般模式', at(2026, 8, 20, 9, 5) is False)
    ok('③g 盤後 14:00 → ⛔ 不是盤前', at(2026, 8, 20, 14, 0) is False)
    ok('③h 週六 08:45 → ⛔ 不是盤前(休市)', at(2026, 8, 22, 8, 45) is False)
finally:
    lsm.datetime = real_dt

# ── ① 盤前分支絕不碰 live_quotes.json ─────────────────────────────────
i0 = SRC.index('if _is_premarket():')
i1 = SRC.index('# ── 1) 全上市櫃股票合約 ──')
PRE = SRC[i0:i1]
ok('① 🚨 盤前分支裡 ⛔ 不可出現 live_quotes.json', 'live_quotes.json' not in PRE, PRE[:200])
ok('①b 盤前只寫 live_index.json', "open('live_index.json'" in PRE)
ok('①c 盤前分支要提早 return(⛔ 不可繼續跑全市場掃描)', re.search(r'\n\s+return\n', PRE) is not None)
ok('①d 盤前不掃股票(⛔ 不可呼叫 api.snapshots 抓一堆股票)', 'stock_contracts' not in PRE)

# ── ② MIN_STOCKS 不可被放寬 ───────────────────────────────────────────
m = re.search(r'MIN_STOCKS\s*=\s*(\d+)', SRC)
ok('② 🚨 MIN_STOCKS 仍是 300(⛔ 不可為了盤前放寬 —— 那是盤中快照的自我保護)',
   bool(m) and m.group(1) == '300', m.group(0) if m else 'NOT FOUND')
ok('②b 一般路徑的守門還在', 'if len(data) < MIN_STOCKS:' in SRC and 'sys.exit(1)' in SRC)

# ── ④ 盤前空過守門 ────────────────────────────────────────────────────
ok('④ 盤前沒抓到期貨 → exit 1(⛔ 不寫空檔覆蓋前一輪)',
   'if not idx or not any(' in PRE and 'sys.exit(1)' in PRE, PRE[-400:])

# ── ⑤ 期貨抓取只有一份 ────────────────────────────────────────────────
ok('⑤ `_fetch_index_futures` 只定義一次', SRC.count('def _fetch_index_futures(') == 1)
ok('⑤b 🚨 抓期貨的實作 ⛔ 不可複製第二份(api.Contracts.Futures 只能出現在那支裡)',
   SRC.count('api.Contracts.Futures') == 1, f"出現 {SRC.count('api.Contracts.Futures')} 次")
# ⚠️ 扣掉定義那行(`def _fetch_index_futures(api):` 也含這個字串)—— 第一版就是這樣誤判成 3 次
_calls = SRC.count('_fetch_index_futures(api)') - SRC.count('def _fetch_index_futures(api)')
ok('⑤c 盤前與盤中都呼叫同一支(剛好 2 個呼叫端)', _calls == 2, f'呼叫 {_calls} 次')

# ── ⑥ workflow ───────────────────────────────────────────────────────
crons = re.findall(r"cron:\s*'([^']+)'", WF)
ok('⑥ 有 3 組 cron(盤前 + 盤中 + 收盤)', len(crons) == 3, str(crons))
ok('⑥b 盤前 cron 是 UTC 00:45~00:55(= 台北 08:45~08:55)、且只在平日',
   any(c.startswith('45,50,55 0 ') and c.endswith('1-5') for c in crons), str(crons))
ok('⑥c 🚨 部署步驟要分檔(盤前 → data/live_index.json、盤中 → data/live_quotes.json)',
   'data/live_index.json' in WF and 'data/live_quotes.json' in WF, '')
ok('⑥d 兩個檔都沒有時要失敗(⛔ 不可靜默成功)', 'else echo "❌ 沒產出 JSON,略過部署"; exit 1; fi' in WF)
ok('⑥e ⛔ 盤前產物不可被寫成 live_quotes.json',
   re.search(r'live_index\.json;\s*DST=data/live_quotes\.json', WF) is None)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ PRESNAPSHOT_PASS(全部通過)')
sys.exit(1 if fails else 0)
