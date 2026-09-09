#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""💰 dividend_miner 測試(stub 掉網路;守門一律注入實測,⛔ 不只看程式碼有沒有那幾個字)。"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ['DIV_SLEEP'] = '0'
os.environ['FINMIND_TOKENS'] = 'AAAAAAAAAAAA,BBBBBBBBBBBB'
import dividend_miner as DM  # noqa: E402

fails = []
def ok(n, c, e=''):
    print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {str(e)[:200]}')); (None if c else fails.append(n))

RES = [{'date': '2026-06-11', 'stock_id': '2330', 'before_price': 2255.0, 'after_price': 2248.99,
        'stock_and_cache_dividend': 6.000035, 'stock_or_cache_dividend': '息', 'reference_price': 2248.99},
       {'date': '2025-12-11', 'stock_id': '2330', 'before_price': 1500.0, 'stock_and_cache_dividend': 5.0,
        'stock_or_cache_dividend': '息', 'reference_price': 1495.0},
       {'date': '2025-09-11', 'stock_id': '2330', 'stock_and_cache_dividend': None, 'stock_or_cache_dividend': '息'}]  # 沒股利數字 → 丟
POL = [{'date': '2026-09-22', 'CashExDividendTradingDate': '2026-09-11', 'CashEarningsDistribution': 6.0, 'CashStatutorySurplus': 0.0},
       {'date': '2026-06-01', 'CashExDividendTradingDate': '2026-06-11', 'CashEarningsDistribution': 6.0},   # 已經在 h 裡 → 不重複列進 up
       {'date': '2026-03-01', 'CashExDividendTradingDate': '2026-03-12', 'CashEarningsDistribution': 5.0},   # 過去的 → 不進 up
       {'date': '2026-09-01', 'CashExDividendTradingDate': '', 'CashEarningsDistribution': 1.0}]              # 沒日期 → 丟

# ① compact 純函式
c = DM.compact(RES, POL, '2026-09-01')
ok('① 歷史列由舊到新、沒股利數字的丟掉', [x[0] for x in c['h']] == ['2025-12-11', '2026-06-11'], c['h'])
ok('①b 歷史列格式 [日期, 股利, 類型, 除息前價, 參考價]', c['h'][-1] == ['2026-06-11', 6.0, '息', 2255.0, 2248.99], c['h'][-1])
ok('①c 未來除息日只留「今天之後、不在歷史裡」的', c['up'] == [['2026-09-11', 6.0]], c['up'])

# ② 探路守門:免費層 → exit 1、⛔ 不寫檔
with tempfile.TemporaryDirectory() as d:
    DM.DATA = Path(d); DM.OUT = DM.DATA / 'dividends.json'; DM.OUT_HIST = DM.DATA / 'dividends_hist.json'
    for s in ['2330', '2317', '0050']:
        (DM.DATA / f'{s}.json').write_text('[]')
    DM._paid_k = None; DM.STAT['reasons'].clear()
    DM._http = lambda url: (None, 'HTTP 400 Your level is register. Please update your user level.')
    rc = DM.main([])
    ok('② 免費層 → exit 1 且不寫檔', rc == 1 and not DM.OUT.exists() and DM.STAT['reasons'].get('帳號等級是免費層', 0) >= 2, (rc, DM.STAT['reasons']))

    # ③ 正常路徑 + 合併舊檔 + 每一把都試
    old = {'updated': 'x', 'd': {'9999': {'h': [['2024-01-01', 1.0, '息', 10.0, 9.0]], 'up': []}, '2317': {'h': [['2024-07-01', 5.0, '息', 200.0, 195.0]], 'up': []}}}
    DM.OUT_HIST.write_text(json.dumps(old))
    calls = []
    def fake(url):
        calls.append(url)
        if 'token=AAAAAAAAAAAA' in url:
            return None, 'HTTP 400 Token is illegal.'             # 第 1 把壞 → 要換第 2 把
        if 'data_id=2317' in url:
            return None, 'HTTP 500 timeout'                        # 這輪抓失敗 → 保留舊資料
        if 'data_id=0050' in url:
            return ([{'date': '2026-07-21', 'stock_and_cache_dividend': 0.6, 'stock_or_cache_dividend': '息', 'before_price': 99.2, 'reference_price': 98.6}] if 'Result' in url else []), ''
        return (RES if 'Result' in url else POL), ''
    DM._http = fake; DM._paid_k = None; DM.MIN_OK = 2
    for k in ('ok', 'empty', 'fail', 'kept_old'): DM.STAT[k] = 0
    rc = DM.main([])
    lite = json.loads(DM.OUT.read_text()); hist = json.loads(DM.OUT_HIST.read_text())
    ok('③ 第 1 把壞會換第 2 把(探路後鎖定第 2 把)', rc == 0 and DM._paid_k == 1, (rc, DM._paid_k))
    ok('③b 成功的股票以新為準、失敗的保留舊資料、舊檔裡別的股票不丟', hist['d']['2330']['h'][-1][0] == '2026-06-11' and hist['d']['2317']['h'][0][0] == '2024-07-01' and '9999' in hist['d'], list(hist['d']))
    ok('③c ETF(0050)也有抓(含息回測要用)', hist['d']['0050']['h'][0][1] == 0.6)
    ok('③d 精簡檔每檔最多 12 筆且有 up;深檔不截斷', all(len(v['h']) <= 12 for v in lite['d'].values()) and lite['d']['2330']['up'] == [['2026-09-11', 6.0]])
    ok('③e 分類統計:失敗 1(保留舊 1)', DM.STAT['fail'] == 1 and DM.STAT['kept_old'] == 1, DM.STAT)
    ok('③f 每檔 2 次呼叫(Result + 政策),探路只多 1 次', len([u for u in calls if 'token=BBBB' in u]) == 1 + 3 * 2, len(calls))
    # ④ 有效檔數不足 → 不覆寫
    DM.MIN_OK = 500; DM._paid_k = None
    before = DM.OUT.read_text()
    rc = DM.main([])
    ok('④ 有紀錄的檔數 < MIN_OK → exit 1 且舊檔原封不動', rc == 1 and DM.OUT.read_text() == before)

    # ⑥ ⏱️ 時間預算(V74.3.8 首跑實測 94 分撞 90 分逾時、89 分白抓)
    #    順序:舊檔裡沒有的先、再來最後一筆除息日最舊的 —— ⛔ 不可按代號(後段代號永遠輪不到)
    old2 = {'updated': 'x', 'd': {'2330': {'h': [['2026-06-11', 6.0, '息', 2255.0, 2249.0]], 'up': []},
                                  '9999': {'h': [['2024-01-01', 1.0, '息', 10.0, 9.0]], 'up': []}}}
    order = DM.order_syms(['9999', '2330', '2317', '0050'], old2['d'])
    ok('⑦ 抓取順序:沒抓過的(0050/2317)先,再來最舊的(9999),最新的(2330)最後', order == ['0050', '2317', '9999', '2330'], order)
    DM.OUT_HIST.write_text(json.dumps(old2)); DM.OUT.unlink(missing_ok=True)
    calls.clear(); DM._paid_k = None; DM.MIN_OK = 2; DM.BUDGET_MIN = 0
    for k in ('ok', 'empty', 'fail', 'kept_old'): DM.STAT[k] = 0
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): rc = DM.main([])
    outp = buf.getvalue()
    hist2 = json.loads(DM.OUT_HIST.read_text())
    ok('⑦b 預算用完 → 一檔都不抓(只有探路那 1 次呼叫)、印出剩幾檔、⛔ 但仍 exit 0 並把舊資料寫出去',
       rc == 0 and len([u for u in calls if 'token=BBBB' in u]) == 1 and '時間預算' in outp and __import__('re').search(r'剩 \d+ 檔', outp) and set(hist2['d']) == {'2330', '9999'}, (rc, outp[-200:]))
    DM.BUDGET_MIN = 100
    wf = (ROOT / '.github/workflows/dividend_sweep.yml').read_text()
    ok('⑦c workflow 有給 DIV_BUDGET_MIN,且 job timeout 大於預算(逾時只當最後保險)',
       __import__('re').search(r"DIV_BUDGET_MIN: '(\d+)'", wf)
       and int(__import__('re').search(r'timeout-minutes: (\d+)', wf).group(1))
           > int(__import__('re').search(r"DIV_BUDGET_MIN: '(\d+)'", wf).group(1)))

# ⑤ 🔐 不印金鑰
src = (ROOT / 'dividend_miner.py').read_text(encoding='utf-8')
ok('⑤ 🔐 只印「第幾把」,⛔ 不印金鑰片段', 'tok[:' not in src and 'TOKENS[k][' not in src and '第 {k+1} 把' in src)
# ⑥ workflow 佈線
wf = (ROOT / '.github/workflows/dividend_sweep.yml').read_text(encoding='utf-8')
ok('⑥ workflow:先還原舊深檔、再跑、rc≠0 不部署、深檔只推 data', 'dividends_hist.json' in wf and 'git archive origin/data' in wf and 'steps.sweep.outputs.rc' in wf and '[ "$BR" = "data" ]' in wf)
ok('⑥b 排程一週一次(⛔ 不可每天,撞配額)', "cron: '30 21 * * 6'" in wf and 'FINMIND_TOKENS' in wf)
print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ DIVIDEND_MINER_PASS'))
sys.exit(1 if fails else 0)
