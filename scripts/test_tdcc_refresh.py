#!/usr/bin/env python3
"""🏦 V82.1.5 集保週資料過期就順便更新(extras_miner.fetch_tdcc_holdings → tdcc_sweep.update)離線測試。

為什麼要有這支:tdcc_holders.json 是 tdcc_sweep 週排程產的,那支排程從來沒跑過;
  extras_miner 每天把它轉成 tdcc.json 時只寫「今天」當 updated → 看起來每天都有更新,
  資料日其實停在 2026-08-07(V75.2.x 也是被 updated 騙了才判「不用修」)。
走正式入口(網路換成假的 CSV、⛔ 真的連網),每條都有決定性對照。

跑法:python3 scripts/test_tdcc_refresh.py
"""
import json
import os
import sys
import tempfile
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp())
os.makedirs('data', exist_ok=True)

import tdcc_sweep  # noqa: E402
import extras_miner as em  # noqa: E402

FAILS = []


def ok(name, cond, got=''):
    print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:300]}'))
    if not cond:
        FAILS.append(name)


def fake_csv(d8, n=520):
    """TDCC 1-5 的長相:資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%(n 檔 × 1~15 級 + 17 合計)"""
    rows = ['資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%']
    for i in range(n):
        sym = f'{1101 + i}'
        for lv in range(1, 16):
            pct = 30.0 if lv == 15 else 70.0 / 14
            rows.append(f'{d8},{sym},{lv},{100 - lv},{1000 * lv},{pct:.2f}')
        rows.append(f'{d8},{sym},17,1500,1000000,100.00')
    return '\n'.join(rows)


CALLS = []


def stub(d8=None, fail=False):
    def f():
        CALLS.append(d8)
        if fail:
            raise OSError('fake down')
        return fake_csv(d8)
    tdcc_sweep.fetch_csv = f


OLD = {'_meta': {'data_date': '20260807'}, '1101': {'t': 1, 'n': 1, 'h': [['20260807', 25.0, 40.0, 20.0, 500]]}}
for k in range(1, 520):
    OLD[str(1101 + k)] = {'t': 1, 'n': 1, 'h': [['20260807', 25.0, 40.0, 20.0, 500]]}
with open('data/tdcc_holders.json', 'w', encoding='utf-8') as fh:
    json.dump(OLD, fh)

# ① 資料日 8/7、今天 11/11 → 順便抓最新一週,歷史接上去
stub('20261106')
em.fetch_tdcc_holdings(today=date(2026, 11, 11))
th = json.load(open('data/tdcc_holders.json', encoding='utf-8'))
tj = json.load(open('data/tdcc.json', encoding='utf-8'))
ok('① 資料日 8/7 超過 9 天 → 抓一次、11/06 那週接在 8/7 後面、tdcc.json 的資料日跟著換',
   len(CALLS) == 1 and [h[0] for h in th['1101']['h']] == ['20260807', '20261106']
   and tj.get('date') == '20261106' and th['_meta']['data_date'] == '20261106', (CALLS, th['1101'], tj.get('date')))
ok('①b 週變化用上一週算(30 − 25 = +5)', abs(tj['data']['1101']['top_pct_week_chg'] - 5.0) < 1e-6, tj['data'].get('1101'))

# ② 決定性對照:資料日 11/06、今天 11/11(5 天)→ ⛔ 再下載
em.fetch_tdcc_holdings(today=date(2026, 11, 11))
ok('② 決定性對照:資料日 5 天前 → 不下載(其他天照舊零下載)', len(CALLS) == 1, CALLS)

# ③ 過期但抓不到 → 舊檔一個字不動、tdcc.json 照舊用舊資料日、⛔ 丟例外
before = open('data/tdcc_holders.json', encoding='utf-8').read()
stub(fail=True)
err = None
try:
    em.fetch_tdcc_holdings(today=date(2026, 11, 30))
except Exception as e:  # noqa: BLE001
    err = e
after = open('data/tdcc_holders.json', encoding='utf-8').read()
tj3 = json.load(open('data/tdcc.json', encoding='utf-8'))
ok('③ 過期但抓不到 → ⛔ 丟例外、舊檔不動、tdcc.json 資料日照舊(11/06,⛔ 假裝是今天)',
   err is None and before == after and tj3.get('date') == '20261106', (err, tj3.get('date')))

# ④ 判斷函式
ok('④ is_stale:9 天內不算、10 天算、沒有資料日也算舊',
   not tdcc_sweep.is_stale('20261102', date(2026, 11, 11)) and tdcc_sweep.is_stale('20261101', date(2026, 11, 11))
   and tdcc_sweep.is_stale('', date(2026, 11, 11)) and tdcc_sweep.is_stale(None, date(2026, 11, 11)))
ok('④b data_date_of:沒有 _meta 就取各檔最後一週的最大值;讀不到回空字串',
   tdcc_sweep.data_date_of('nope.json') == '')

# ⑤ ⛔ 偽裝瀏覽器
src = open(os.path.join(ROOT, 'tdcc_sweep.py'), encoding='utf-8').read()
ok('⑤ UA 寫明 StockAI-DB、⛔ 偽裝成 Windows 瀏覽器', 'StockAI-DB tdcc_sweep' in tdcc_sweep.UA and 'Windows NT' not in src)

print(f'\n{"✅ 全過" if not FAILS else "❌ 失敗 " + str(len(FAILS)) + " 條"}(共 7 條)')
sys.exit(1 if FAILS else 0)
