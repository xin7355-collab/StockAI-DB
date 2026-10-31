#!/usr/bin/env python3
"""🏪🌐 V80.1.1 走正式入口 miner.run()(假網路、假時鐘、暫存資料夾)驗兩件事:

A. 「今天那根跟官方全市場那根不一樣」→ ⛔ 安全略過,換成官方那根(不多打請求)
   10/30 實測:上市網站那根 97% 是盤中快照(量只有整股)、上櫃 12/12 是沒收完的那根,
   晚上那輪因為「K 線 + 籌碼都有了」整檔略過 → 錯的那根留到每週重抓才換。
 ① 上市 1101:今天那根量 108,000(盤中快照)、全市場那根 110,203 → 換成 110,203,而且 ⛔ 打逐股端點(快速路徑)
 ② ⭐ 決定性對照:同一份資料不開 TW_DAILY_ALL → 照舊略過(量留 108,000)
 ③ 量差 < 1 張(上櫃逐股官方是張 ×1000 四捨五入)→ ⛔ 不換(⛔ 為了零股尾數每天改來改去)
 ④ 上櫃 6488:網站那根收 120 / 量 1,494,634(沒收完)、全市場那根收 119 / 量 3,055,868 → 換成官方那根(TW_DAILY_ALL=1)

B. TPEX_MONTHS 上櫃回補
 ⑤ TPEX_MONTHS=5:上櫃 6488 重抓 2026/06~10 五個月逐股官方(新站 tradingStock),7 月那根錯的收盤被換掉、量換成官方
 ⑥ ⭐ 決定性對照:同一份資料不設 TPEX_MONTHS → 7 月那根照舊是錯的(平常只抓 3 個月,而且今天完整就整檔略過)
 ⑦ 上市 1101 ⛔ 不受 TPEX_MONTHS 影響(不多打逐股)
 ⑧ 市場別讀不到(沒有 stock_names.json)→ 這一輪不回補,而且 log 要說
 ⑨ 純函式:tpex_backfill_months 上下限 / 看不懂 → []、daily_all_fix_needed 邊界
跑法:python3 scripts/test_tpex_run.py
"""
import contextlib, io, json, os, re, shutil, sqlite3, sys, tempfile
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
import miner as M  # noqa: E402

FAIL = []


def ck(c, m, extra=''):
    print(('✅ ' if c else '❌ ') + m + ('' if c or not extra else f'  {str(extra)[:400]}'))
    if not c:
        FAIL.append(m)


TODAY = date(2026, 10, 30)                       # 週五
_RealDate, _RealDT = M.date, M.datetime


class FD(_RealDate):
    @classmethod
    def today(cls):
        return cls(TODAY.year, TODAY.month, TODAY.day)


class FDT(_RealDT):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 30, 23, 7, tzinfo=tz)   # 晚上那輪(盤後)


def weekdays(a, b):
    out, d = [], a
    while d <= b:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


DAYS = weekdays(date(2025, 6, 2), TODAY)          # 370 多根(≥ 240 根才不會走「歷史不足 → 24 個月」)
S = lambda d: d.strftime('%Y/%m/%d')
ROC = lambda d: f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'


def px(i, base):
    return round(base + (i % 7) * 0.5, 1)


def official(sym, base, vol0):
    """官方那份(上市以股、上櫃以張 ×1000 —— 跟逐股端點一樣)"""
    out = {}
    for i, d in enumerate(DAYS):
        p = px(i, base)
        out[d] = {'o': p, 'h': round(p + 1, 1), 'l': round(p - 1, 1), 'c': p, 'v': vol0 + i * 1000}
    return out


OFF = {'1101': official('1101', 50.0, 100000), '6488': official('6488', 100.0, 2000000)}
JULY_BAD = date(2026, 7, 15)


def site_rows(sym, today_close=None, today_vol=None, july_bad=False):
    rows = []
    for d, b in OFF[sym].items():
        r = {'date': S(d), 'open': b['o'], 'high': b['h'], 'low': b['l'], 'close': b['c'], 'volume': b['v'],
             'foreign_net': 5, 'trust_net': 1, 'dealer_net': -1, 'margin_balance': 0, 'short_balance': 0}
        if d == TODAY:
            if today_close is not None:
                r['close'] = today_close
                r['high'] = max(r['high'], today_close)
                r['low'] = min(r['low'], today_close)
            if today_vol is not None:
                r['volume'] = today_vol
        if july_bad and d == JULY_BAD:
            r['close'] = round(r['close'] - 1, 1)     # 沒收完的那根(收盤差一點)
            r['volume'] = r['volume'] // 3
        rows.append(r)
    return rows


class R:
    def __init__(self, obj=None, code=200, text=None):
        self.status_code = code
        self.text = text if text is not None else json.dumps(obj, ensure_ascii=False)

    def json(self):
        return json.loads(self.text)


def make_router(calls, da_twse_vol=110203, da_tpex=(119.0, 3055868)):
    t = OFF['1101'][TODAY]
    u = OFF['6488'][TODAY]
    twse_all = [{'Code': '1101', 'Date': '1151030', 'OpeningPrice': str(t['o']), 'HighestPrice': str(t['h']),
                 'LowestPrice': str(t['l']), 'ClosingPrice': str(t['c']), 'TradeVolume': str(da_twse_vol)}]
    tc, tv = da_tpex
    tpex_all = [{'SecuritiesCompanyCode': '6488', 'Date': '1151030', 'Open': str(min(u['o'], tc)), 'High': str(max(u['h'], tc)),
                 'Low': str(min(u['l'], tc)), 'Close': str(tc), 'TradingShares': str(tv)}]

    def get(url, **kw):
        calls.append(url)
        if 'STOCK_DAY_ALL' in url:
            return R(twse_all)
        if 'tpex_mainboard_daily_close_quotes' in url:
            return R(tpex_all)
        if 'twse.com.tw/rwd/zh/afterTrading/STOCK_DAY' in url:
            sym = re.search(r'stockNo=(\w+)', url).group(1)
            ym = re.search(r'date=(\d{6})', url).group(1)
            if sym != '1101':
                return R({'stat': '很抱歉,沒有符合條件的資料!'})
            rows = [[ROC(d), f"{b['v']:,}", '0', f"{b['o']:.2f}", f"{b['h']:.2f}", f"{b['l']:.2f}", f"{b['c']:.2f}", '0', '1']
                    for d, b in OFF['1101'].items() if d.strftime('%Y%m') == ym]
            return R({'stat': 'OK', 'fields': ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數'],
                      'data': rows})
        if 'afterTrading/tradingStock' in url:
            sym = re.search(r'code=(\w+)', url).group(1)
            y, m = re.search(r'date=(\d{4})/(\d{2})/01', url).groups()
            if sym != '6488':
                return R({'stat': 'ok', 'tables': [{'fields': [], 'data': []}]})
            rows = [[ROC(d), f"{b['v'] // 1000:,}", '0', f"{b['o']:.2f}", f"{b['h']:.2f}", f"{b['l']:.2f}", f"{b['c']:.2f}", '0', '1']
                    for d, b in OFF['6488'].items() if d.year == int(y) and d.month == int(m)]
            return R({'stat': 'ok', 'tables': [{'fields': ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌', '筆數'],
                                                'data': rows}]})
        return R(None, 404, '')
    return get


def run_case(site, daily_all=None, tpex_months=None, names=True, da_twse_vol=110203, da_tpex=(119.0, 3055868)):
    """回 ({代號: {日期: (close, volume)}}, 打過的網址, log)"""
    tmp = tempfile.mkdtemp(prefix='tpexrun_')
    cwd = os.getcwd()
    calls, yf_calls = [], []
    saved = {k: getattr(M, k) for k in ('date', 'datetime', 'get_batch_symbols', 'yfinance_ohlcv_fallback',
                                         'fetch_mis_closing_snapshot', 'SKIP_GLOBAL', 'BATCH_INDEX', 'TOTAL_BATCHES')}
    saved_get, saved_sleep, saved_min = M.http_session.get, M.time.sleep, dict(M._DAILY_ALL_MIN)
    env_old = {k: os.environ.get(k) for k in ('TW_DAILY_ALL', 'TPEX_MONTHS', 'KLINES_DEEP_DIR')}
    buf = io.StringIO()
    try:
        os.chdir(tmp)
        os.makedirs('data')
        for sym, rows in site.items():
            with open(f'data/{sym}.json', 'w', encoding='utf-8') as f:
                json.dump(rows, f)
        if names:
            with open('data/stock_names.json', 'w', encoding='utf-8') as f:
                json.dump({'names': {'1101': ['台泥', '01', 'twse'], '6488': ['環球晶', '24', 'tpex']}}, f, ensure_ascii=False)
        for k, v in (('TW_DAILY_ALL', daily_all), ('TPEX_MONTHS', tpex_months), ('KLINES_DEEP_DIR', None)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        M.date, M.datetime = FD, FDT
        M.get_batch_symbols = lambda *a, **k: sorted(site)
        M.yfinance_ohlcv_fallback = lambda sym, *a, **k: (yf_calls.append(sym) or [])
        M.fetch_mis_closing_snapshot = lambda sym: None
        M.SKIP_GLOBAL, M.BATCH_INDEX, M.TOTAL_BATCHES = True, 3, 20
        M.http_session.get = make_router(calls, da_twse_vol, da_tpex)
        M.time.sleep = lambda *a, **k: None
        M._DAILY_ALL_MIN.update({'twse': 1, 'tpex': 1})
        for h in M._FETCH_HEALTH.values():
            h.update({'ok': 0, 'empty': 0, 'blocked': 0, 'skipped': 0, 'streak': 0,
                      'trips': 0, 'open_until': 0.0, 'dead': False, 'why': {}})
        with contextlib.redirect_stdout(buf):
            M.init_db()
            M.run()
        con = sqlite3.connect('stock_hunter.db')
        out = {}
        for sym, d, c, v in con.execute('SELECT symbol, trade_date, close, volume FROM stock_history'):
            out.setdefault(sym, {})[d.replace('-', '/')] = (c, v)
        con.close()
        return out, calls, buf.getvalue(), yf_calls
    finally:
        os.chdir(cwd)
        for k, v in saved.items():
            setattr(M, k, v)
        M.http_session.get, M.time.sleep = saved_get, saved_sleep
        M._DAILY_ALL_MIN.clear(); M._DAILY_ALL_MIN.update(saved_min)
        for k, v in env_old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(tmp, ignore_errors=True)


T = S(TODAY)
J = S(JULY_BAD)
twse_site = {'1101': site_rows('1101', today_vol=108000)}

# ── A ──
out, calls, log, _ = run_case(twse_site, daily_all='twse')
ck(out.get('1101', {}).get(T) == (50.0 + (DAYS.index(TODAY) % 7) * 0.5, 110203),
   '① 上市今天那根:盤中快照 108,000 → 換成官方全市場那根 110,203', (out.get('1101', {}).get(T), log[-400:]))
ck(not any('STOCK_DAY?' in u or 'STOCK_DAY&' in u or '/STOCK_DAY' in u and 'ALL' not in u for u in calls),
   '① 走快速路徑:⛔ 打逐股 STOCK_DAY(不多打請求)', [u for u in calls if 'STOCK_DAY' in u][:3])
ck('換成官方那根' in log and '今天那根換成官方那根 1 檔' in log, '① log 寫出換了哪根 + 健康度摘要記數', log[-600:])

out2, calls2, log2, _ = run_case(twse_site, daily_all=None)
ck(out2.get('1101', {}).get(T, (0, 0))[1] == 108000 and '安全略過' in log2,
   '② ⭐ 決定性對照:不開 TW_DAILY_ALL → 照舊安全略過,量留 108,000', (out2.get('1101', {}).get(T), log2[-300:]))

out3, _, log3, _ = run_case(twse_site, daily_all='twse', da_twse_vol=108400)
ck(out3.get('1101', {}).get(T, (0, 0))[1] == 108000 and '安全略過' in log3,
   '③ 量差 400 股(< 1 張)→ ⛔ 不換、照舊略過', (out3.get('1101', {}).get(T), log3[-300:]))

tpex_site = {'6488': site_rows('6488', today_close=120.0, today_vol=1494634)}
out4, calls4, log4, _ = run_case(tpex_site, daily_all='1')
ck(out4.get('6488', {}).get(T) == (119.0, 3055868),
   '④ 上櫃今天那根:沒收完的 120 / 1,494,634 → 換成官方全市場那根 119 / 3,055,868(TW_DAILY_ALL=1)', (out4.get('6488', {}).get(T), log4[-400:]))

# ── B ──
bad = {'6488': site_rows('6488', july_bad=True)}
# ⚠️ 不開 TW_DAILY_ALL:今天那根是完整的、籌碼也有 → 只有 TPEX_MONTHS 能讓它不被「安全略過」(隔離這一條)
out5, calls5, log5, yf5 = run_case(bad, daily_all=None, tpex_months='5')
want_j = (OFF['6488'][JULY_BAD]['c'], OFF['6488'][JULY_BAD]['v'] // 1000 * 1000)
ck(out5.get('6488', {}).get(J) == want_j, '⑤ TPEX_MONTHS=5:7 月那根錯的換成逐股官方(收盤 + 量)', (out5.get('6488', {}).get(J), want_j, log5[-300:]))
ts = sorted(re.search(r'date=(\d{4}/\d{2})', u).group(1) for u in calls5 if 'tradingStock' in u)
ck(ts == ['2026/06', '2026/07', '2026/08', '2026/09', '2026/10'], '⑤ 打了 2026/06~10 五個月新站 tradingStock(西元日期)', ts)
ck('上櫃 K 線回補' in log5 and '1 檔上櫃股 × 5 個月' in log5, '⑤ log 寫出回補幾檔 × 幾個月', log5[:600])
ck(yf5 == [], '⑤ 逐股官方都拿到 → ⛔ 叫 yfinance(以前上櫃整條靠它)', yf5)

out6, calls6, log6, _ = run_case(bad, daily_all=None, tpex_months=None)
ck(out6.get('6488', {}).get(J, (0,))[0] == round(OFF['6488'][JULY_BAD]['c'] - 1, 1),
   '⑥ ⭐ 決定性對照:不設 TPEX_MONTHS → 7 月那根照舊是錯的', (out6.get('6488', {}).get(J), log6[-300:]))
ck(not any('tradingStock' in u for u in calls6) and '安全略過' in log6, '⑥ 而且整檔安全略過、⛔ 打逐股', [u for u in calls6 if 'tradingStock' in u])
_u = OFF['6488'][TODAY]
out5b, calls5b, log5b, _ = run_case(bad, daily_all='1', tpex_months='5', da_tpex=(_u['c'], _u['v']))
ts5b = sorted(re.search(r'date=(\d{4}/\d{2})', u).group(1) for u in calls5b if 'tradingStock' in u)
ck(ts5b == ['2026/06', '2026/07', '2026/08', '2026/09', '2026/10'] and out5b.get('6488', {}).get(J) == want_j,
   '⑤b 有全市場那根而且跟今天一樣 → 回補照樣抓 5 個月(⛔ 被快速路徑吃掉)', (ts5b, out5b.get('6488', {}).get(J)))

out7, calls7, log7, _ = run_case({'1101': site_rows('1101'), '6488': site_rows('6488', july_bad=True)}, daily_all=None, tpex_months='5')
ck(not any('stockNo=1101' in u for u in calls7) and '1 檔上櫃股' in log7,
   '⑦ 上市 1101 ⛔ 受 TPEX_MONTHS 影響(不打逐股、照舊略過);回補只算上櫃那 1 檔', ([u for u in calls7 if '1101' in u][:3], log7[:400]))
ck(out7.get('6488', {}).get(J) == want_j, '⑦ 同一輪上櫃那檔照樣修好', out7.get('6488', {}).get(J))

out8, calls8, log8, _ = run_case(bad, daily_all=None, tpex_months='5', names=False)
ck('讀不到市場別' in log8 and not any('tradingStock' in u and '2026/07' in u for u in calls8),
   '⑧ 市場別讀不到 → 這一輪不回補(⛔ 猜)而且 log 要說', log8[:500])

# ── ⑨ 純函式 ──
ck(M.tpex_backfill_months('', TODAY) == [] and M.tpex_backfill_months(None, TODAY) == [] and M.tpex_backfill_months('abc', TODAY) == [],
   '⑨ 沒設 / 看不懂 → [](⛔ 回補)')
ck(M.tpex_backfill_months('3', TODAY) == [], '⑨ 不比平常 3 個月多 → []')
m24 = M.tpex_backfill_months('99', TODAY)
ck(len(m24) == 24 and m24[0] == '202610' and m24[-1] == '202411', '⑨ 上限 24 個月(202610 ~ 202411)', (len(m24), m24[:1], m24[-1:]))
ck(M.tpex_backfill_months('4', TODAY) == ['202610', '202609', '202608', '202607'], '⑨ 4 → 四個月、新 → 舊')
rec = {'close': 50.0, 'volume': 108000}
ck(M.daily_all_fix_needed(rec, {'date': T, 'close': 50.0, 'volume': 109000}, T) is True, '⑨ 量差剛好 1 張 → 換')
ck(M.daily_all_fix_needed(rec, {'date': T, 'close': 50.0, 'volume': 108999}, T) is False, '⑨ 量差 999 股 → 不換')
ck(M.daily_all_fix_needed(rec, {'date': '2026/10/29', 'close': 51.0, 'volume': 1}, T) is False, '⑨ 全市場那根不是今天 → 不換')
ck(M.daily_all_fix_needed({}, {'date': T, 'close': 51.0, 'volume': 1}, T) is False and M.daily_all_fix_needed(rec, None, T) is False,
   '⑨ 今天那根還沒有 / 沒有全市場那根 → False(交給原本的流程)')

print(f"\n{'❌ ' + str(len(FAIL)) + ' 條失敗' if FAIL else '✅ 全過'}")
sys.exit(1 if FAIL else 0)
