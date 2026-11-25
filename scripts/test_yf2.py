#!/usr/bin/env python3
"""💱 換掉 yfinance 第二階段(V82.4.0):走正式入口、網路全換假的(⛔ 真的連網)。

使用者 11/15「推薦的繼續」。這一版只換「同一個東西、改合規來源」的格子(App 的意思不變):
  VIX / 標普 500 / 道瓊 / 台積電・日月光・聯電 ADR / 板塊對標的美國上市代號 → Cboe 延遲報價(lib_quotes.cboe_quotes)
  比特幣 → Coinbase,失敗退 Kraken ・日經 225 → FRED NIKKEI225 ・台指期 → 期交所行情網(test_txnight)
  App:AI 提示詞讀的鍵要跟採礦寫的一樣(gold_usd / wti_oil / btc_usd;以前讀 gold / wti / btc → 一直餵「待採」)

⛔ 釘住:
  ① Cboe 一輪只問一次(VIX / 標普 / 道瓊 / ADR / 板塊代號一起問),日期記進 _YF_LAST_DATE(「日期不可倒退」守門照樣作用)
  ② 🛡️ 停住的代號(比其他舊)⛔ 收 → 那一格 None + 原因;道瓊 = DJX × 100
  ③ 比特幣 Coinbase 被擋 → Kraken,error 有「備援」(data_audit 才分得出是有交代的降級)
  ④ 日經走 FRED NIKKEI225、漲跌 = 最新 vs 前一筆
  ⑤ 板塊對標:美國上市的走 Cboe、韓股(.KS)還在舊路(⏸ 等使用者決定);加權平均照舊
  ⑥ 靜態:換掉的函式 ⛔ yfinance;Cboe 清單 ⛔ 帶交易所後綴的代號
  ⑦ App 接線:macro_miner key_alias 寫的 gold_usd / wti_oil / btc_usd,AI 提示詞那幾行讀得到
  ⑨ 🕐 V82.4.2 美股還沒收盤時抓的(Cboe 成交時間早於 15:59 + 美東還在 09:30~16:20;yfinance 的美股現貨指數同一條)
     → `{key}_intraday` = 美東 HH:MM;收盤後同一批 ⛔ 標(決定性對照);保留上一份時標記跟著走;原油期貨 ⛔ 套
  INJECT=1:拿掉 Cboe 日期守門 / fetch_vix 換回 yfinance / App 鍵名改回 gold / 四種盤中標記拿掉 → 必紅
"""
import inspect
import io
import json
import os
import re
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
SRC = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')
LQSRC = (ROOT / 'lib_quotes.py').read_text(encoding='utf-8')
HTML = (ROOT / 'index.html').read_text(encoding='utf-8')


class R:
    def __init__(self, code, body):
        self.status_code = code
        self.content = body.encode('utf-8') if isinstance(body, str) else body
        self.text = body if isinstance(body, str) else body.decode('utf-8', 'replace')

    def json(self):
        return json.loads(self.content.decode('utf-8'))


def load(src, lqsrc):
    lq = types.ModuleType('lib_quotes')
    lq.__file__ = str(ROOT / 'lib_quotes.py')
    exec(compile(lqsrc, str(ROOT / 'lib_quotes.py'), 'exec'), lq.__dict__)
    sys.modules['lib_quotes'] = lq
    mod = types.ModuleType('macro_miner_t')
    mod.__file__ = str(ROOT / 'macro_miner.py')
    with redirect_stdout(io.StringIO()):
        exec(compile(src, str(ROOT / 'macro_miner.py'), 'exec'), mod.__dict__)
    return mod, lq


def cq(close, pct, ltt):
    return R(200, json.dumps({'data': {'close': close, 'current_price': close, 'price_change_percent': pct, 'last_trade_time': ltt}}))


def run(src, lqsrc, html, quiet=False):
    fails = []

    def ok(name, cond, extra=''):
        if not quiet:
            print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
        if not cond:
            fails.append(name)

    M, LQ = load(src, lqsrc)
    D = '2026-11-13T16:00:00'
    asked = []

    def send(method, url, **kw):
        asked.append(url)
        sym = url.rsplit('/', 1)[-1].replace('.json', '')
        if 'cdn.cboe.com' in url:
            if sym == '_SOX':
                return cq(10268.65, -3.13, '2026-11-04T16:05:23')
            if sym == 'GRID':
                return cq(150.0, 1.0, '2026-11-04T15:59:59')      # 停住的那一檔 → 要被擋
            px = {'_VIX': (19.3, 3.1088), '_SPX': (7561.67, -0.4064), '_DJX': (523.48, 0.0974), 'TSM': (398.73, -1.6671)}.get(sym, (100.0, 2.0))
            return cq(px[0], px[1], D if sym != '_VIX' else '2026-11-13T16:15:01')
        if 'coinbase' in url:
            return R(403, '<html>denied</html>')
        if 'kraken' in url:
            return R(200, json.dumps({'error': [], 'result': {'XXBTZUSD': [[1794614400, '1', '1', '1', '64115.1', '0', '1', 1],
                                                                           [1794700800, '1', '1', '1', '64317.7', '0', '1', 1]], 'last': 1}}))
        return R(404, 'unknown')
    from datetime import date as _date
    gate = LQ.make_gate(send=send, sleep=lambda s: None, clock=lambda: 0.0)
    M._q_gate = lambda: gate
    real_cq = LQ.cboe_quotes
    LQ.cboe_quotes = lambda g, t, today=None, max_age_days=5: real_cq(g, t, today=_date(2026, 11, 16), max_age_days=max_age_days)
    M._LQ = LQ

    # FRED NIKKEI225(走 _off_gate)
    fred_csv = 'observation_date,NIKKEI225\n2026-11-12,60819.36\n2026-11-13,61142.35\n'
    import lib_official as LO
    LO.clear_cache()
    fgate = LO.make_gate(send=lambda m, u, **k: (asked.append(u), R(200, fred_csv) if 'NIKKEI225' in u else R(404, 'x'))[1],
                         sleep=lambda s: None, clock=lambda: 0.0)
    M._off_gate = lambda: fgate
    yf_calls = []
    M._fetch_yf_close = lambda tk, nm: (yf_calls.append(tk), (55.0, 1.5, None))[1]

    with redirect_stdout(io.StringIO()):
        vix, sp, dji, tsm = M.fetch_vix(), M.fetch_sp500(), M.fetch_dji(), M.fetch_tsm_adr()
    cboe_urls = [u for u in asked if 'cdn.cboe.com' in u]
    ok('① Cboe:VIX / 標普 / 台積電 ADR 用收盤 + 收盤漲跌%,資料日記進 _YF_LAST_DATE',
       vix == (19.3, 3.11, None) and sp == (7561.67, -0.41, None) and tsm == (398.73, -1.67, None)
       and M._YF_LAST_DATE.get('^VIX') == '2026-11-13' and M._YF_LAST_DATE.get('^GSPC') == '2026-11-13', (vix, sp, tsm))
    ok('①b 一輪只問 Cboe 一次(四個 fetch 共用同一批,⛔ 每格各問一輪)', len(cboe_urls) == len(set(cboe_urls)) and len(cboe_urls) == len(M._cboe_tickers()),
       (len(cboe_urls), len(M._cboe_tickers())))
    ok('② 道瓊 = DJX × 100', dji[0] == 52348.0 and dji[1] == 0.1, dji)

    with redirect_stdout(io.StringIO()):
        btc = M.fetch_btc()
    ok('③ 比特幣:Coinbase 被擋 → Kraken,error 有「備援」、日期記進 BTC-USD', btc[0] == 64317.7 and btc[1] == round((64317.7 - 64115.1) / 64115.1 * 100, 2)
       and '備援' in (btc[2] or '') and M._YF_LAST_DATE.get('BTC-USD') == '2026-11-15', btc)
    with redirect_stdout(io.StringIO()):
        nk = M.fetch_nikkei()
    ok('④ 日經 225 走 FRED NIKKEI225:最新 vs 前一筆', nk == (61142.35, round((61142.35 - 60819.36) / 60819.36 * 100, 2), None)
       and M._YF_LAST_DATE.get('^N225') == '2026-11-13' and any('NIKKEI225' in u for u in asked), nk)

    with redirect_stdout(io.StringIO()):
        sec = M.fetch_sector_etfs()
    ks = [t['ticker'] for m in M.SECTOR_ETF_MAP.values() for t in [m['primary']] + list(m.get('secondary') or []) if '.KS' in t['ticker']]
    ok('⑤ 板塊對標:韓股(.KS)還在舊路、其他 ⛔ 走舊路', sorted(set(yf_calls)) == sorted(set(ks)) and ks, (sorted(set(yf_calls)), ks))
    grid = (sec.get('power') or {})
    ok('⑤b 停住的那一檔(GRID 停在 11/04)⛔ 收 —— 那一組沒有可用成分 → 走原本的舊快取 / 空', 'power' not in sec or not any(c.get('ok') for c in grid.get('components', [])), grid)
    srv = sec.get('server') or {}
    ok('⑤c 加權平均照舊(美國上市的成分都拿到)', srv and all(c['ok'] for c in srv.get('components', [])) and srv.get('chg_pct') is not None, srv)

    _yfc = M._fetch_yf_close
    M._fetch_yf_close = lambda t, n: (None, None, 'yfinance(測試裡關掉)')   # 🛟 V82.6.9 Cboe 拿不到會退 yfinance → 這裡關掉,只看 Cboe 那一段
    with redirect_stdout(io.StringIO()):
        sox = M._fetch_cboe_close('^SOX', '費半')
    M._fetch_yf_close = _yfc
    ok('⑥ 🛡️ 不在這一輪清單的代號 → None + 原因(⛔ 臨時再問一輪 Cboe)', sox[0] is None and sox[2], sox)
    bad_static = []
    # 🛟 V82.6.9 `_fetch_cboe_close` 失敗時才退 yfinance(使用者 11/25 選)→ 拿出這份靜態清單,行為改由 test_cboe_fallback 釘
    for fn in (M.fetch_vix, M.fetch_sp500, M.fetch_dji, M.fetch_tsm_adr, M.fetch_asx_adr, M.fetch_umc_adr, M.fetch_btc,
               M.fetch_nikkei, M.fetch_taifex_tx_now, M._cboe_book):
        s = re.sub(r'(?m)#.*$', '', re.sub(r'"""[\s\S]*?"""', '', inspect.getsource(fn)))
        if 'yfinance' in s or 'yf.Ticker' in s or '_fetch_yf_close(' in s or '_fetch_yf_future(' in s:
            bad_static.append(fn.__name__)
    ok('⑥b 靜態:換掉的 10 個函式 ⛔ 直接用 yfinance(Cboe 那支失敗才退備援,見 test_cboe_fallback)', not bad_static, bad_static)
    ok('⑥c Cboe 清單 ⛔ 帶交易所後綴 / 期貨的代號', not [t for t in M._cboe_tickers() if '.' in t or '=' in t], M._cboe_tickers())

    # ⑧ 黃金 / 美元指數:沒金鑰 → 照舊 yfinance(安靜);有金鑰 → Twelve Data 一次問 7 個(金鑰只在標頭)
    os.environ.pop('TWELVEDATA_API_KEY', None)
    M._TD_BOOK = None
    yf_calls.clear()
    with redirect_stdout(io.StringIO()):
        g0, d0 = M.fetch_gold(), M.fetch_dxy()
    ok('⑧ 沒設 TWELVEDATA_API_KEY → 黃金 / 美元指數照舊(⛔ 送 Twelve Data、⛔ 寫失敗)', yf_calls == ['GC=F', 'DX-Y.NYB']
       and g0 == (55.0, 1.5, None) and not any('twelvedata' in u for u in asked), (yf_calls, g0))
    fx = {'XAU/USD': (2650.5, 2640.0), 'EUR/USD': (1.16, 1.17), 'USD/JPY': (150.0, 149.0), 'GBP/USD': (1.33, 1.34),
          'USD/CAD': (1.38, 1.37), 'USD/SEK': (9.5, 9.4), 'USD/CHF': (0.80, 0.79)}
    td_seen = []

    def send_td(method, url, **kw):
        td_seen.append((url, kw.get('params'), kw.get('headers') or {}))
        syms = (kw.get('params') or {}).get('symbol', '').split(',')
        return R(200, json.dumps({s: {'symbol': s, 'datetime': '2026-11-13', 'close': str(fx[s][0]), 'previous_close': str(fx[s][1])} for s in syms}))
    tgate = LQ.make_gate(send=send_td, sleep=lambda s: None, clock=lambda: 0.0)
    M._q_gate = lambda: tgate
    os.environ['TWELVEDATA_API_KEY'] = 'SECRET-TD-KEY'
    M._TD_BOOK = None
    yf_calls.clear()
    try:
        with redirect_stdout(io.StringIO()):
            g1, d1 = M.fetch_gold(), M.fetch_dxy()
    finally:
        os.environ.pop('TWELVEDATA_API_KEY', None)
    now, prev, chg = LQ.dxy_from_fx({k: {'close': a, 'prev': b} for k, (a, b) in fx.items()})
    ok('⑧b 有金鑰 → 黃金 = XAU/USD、美元指數照 ICE 公式算;只問 Twelve Data 一次(7 個代號)、⛔ 退 yfinance',
       g1 == (2650.5, round((2650.5 - 2640.0) / 2640.0 * 100, 2), None) and d1 == (now, chg, None) and len(td_seen) == 1
       and td_seen[0][1]['symbol'].count(',') == 6 and not yf_calls, (g1, d1, len(td_seen), yf_calls))
    ok('⑧c 金鑰只在 Authorization 標頭(⛔ 網址 / 參數)', td_seen and td_seen[0][2].get('Authorization') == 'apikey SECRET-TD-KEY'
       and 'SECRET-TD-KEY' not in td_seen[0][0] and 'SECRET-TD-KEY' not in json.dumps(td_seen[0][1]), td_seen[:1])
    M._q_gate = lambda: gate

    # ⑦ App 接線:採礦寫的鍵 → AI 提示詞讀得到
    alias = re.search(r'key_alias = \{([\s\S]*?)\}', src).group(1)
    keys = {k: v for k, v in re.findall(r'"(\w+)":\s*"(\w+)"', alias)}
    need = [keys.get('gold'), keys.get('wti'), keys.get('btc')]
    ok('⑦ App AI 提示詞讀得到採礦寫的鍵(gold_usd / wti_oil / btc_usd;⛔ 只讀 gold / wti / btc)',
       need == ['gold_usd', 'wti_oil', 'btc_usd'] and all(f'mr.{k}' in html for k in need)
       and all(html.count(f'fmtMr(mr.{k}') >= 2 or html.count(f'fmtMr(mr.{k} ') >= 2 for k in need), need)

    # ⑨ 🕐 V82.4.2 美股還沒收盤時抓的 → _INTRADAY → `{key}_intraday`(App 才知道 ⛔ 當收盤;11/16 每日採礦機延遲那輪)
    from datetime import datetime as _dt, timezone as _tz
    M2, LQ2 = load(src, lqsrc)
    clock = [_dt(2026, 11, 16, 18, 28, tzinfo=_tz.utc)]          # 美東 13:28(11/16 是平常時間 −5)
    real_ui, real_cq2 = LQ2.us_cash_intraday, LQ2.cboe_quotes
    LQ2.us_cash_intraday = lambda d, now_utc=None: real_ui(d, now_utc or clock[0])
    LQ2.cboe_quotes = lambda g, t, today=None, max_age_days=5: real_cq2(g, t, today=_date(2026, 11, 16), max_age_days=max_age_days)
    ltt = {'_SPX': (7424.72, -1.81, '2026-11-16T13:28:05'), 'TSM': (376.0, -5.70, '2026-11-16T13:26:00'),
           '_VIX': (23.04, 19.38, '2026-11-16T13:28:00'), 'ASX': (32.91, -7.43, '2026-11-16T16:00:00')}   # ASX 那份已是收盤

    def send2(method, url, **kw):
        sym = url.rsplit('/', 1)[-1].replace('.json', '')
        c, p, t = ltt.get(sym, (100.0, 1.0, '2026-11-16T13:28:00'))
        return cq(c, p, t)
    gate2 = LQ2.make_gate(send=send2, sleep=lambda s: None, clock=lambda: 0.0)
    M2._q_gate = lambda: gate2

    def intra_run():
        M2._CBOE_BOOK = None
        with redirect_stdout(io.StringIO()):
            got = {k: f() for k, f in (('sp500', M2.fetch_sp500), ('tsm', M2.fetch_tsm_adr), ('vix', M2.fetch_vix), ('asx', M2.fetch_asx_adr))}
        out = {}
        tk = {'sp500': '^GSPC', 'tsm': 'TSM', 'vix': '^VIX', 'asx': 'ASX'}
        for k, (v, c, e) in got.items():
            M2._apply_big_player(out, k, {k: k}, v, c, e, M2._YF_LAST_DATE.get(tk[k]), {}, M2._INTRADAY.get(tk[k]))
        return out
    o1 = intra_run()
    ok('⑨ 🕐 美股還在交易(美東 13:28)抓的 → `sp500_intraday` / `tsm_intraday` / `vix_intraday` = Cboe 成交時間,值照給、error 寫「方向待確認」',
       o1.get('sp500_intraday') == '13:28' and o1.get('tsm_intraday') == '13:26' and o1.get('vix_intraday') == '13:28'
       and o1.get('sp500') == 7424.72 and '方向待確認' in (o1.get('sp500_error') or ''), {k: v for k, v in o1.items() if k.startswith(('sp500', 'tsm_'))})
    ok('⑨b 同一輪裡已經是收盤的那一檔(ASX 16:00)⛔ 標盤中', 'asx_intraday' not in o1 and o1.get('asx') == 32.91, o1.get('asx_intraday'))
    clock[0] = _dt(2026, 11, 16, 21, 25, tzinfo=_tz.utc)          # 美東 16:25 = 收完了(11/17 台北 05:25 那輪)
    o2 = intra_run()
    ok('⑨c ⭐ 決定性對照:同一批 Cboe(成交時間一樣早)、換成收盤後才抓 → ⛔ 標盤中(半天市收完那種是真的收盤)',
       not [k for k in o2 if k.endswith('_intraday')] and o2.get('sp500') == 7424.72, [k for k in o2 if k.endswith('_intraday')])
    out3 = {}
    kept = M2._apply_big_player(out3, 'sp500', {'sp500': 'sp500'}, 7400.0, -1.0, None, '2026-11-15',
                                {'sp500': 7424.72, 'sp500_chg_pct': -1.81, 'sp500_date': '2026-11-16', 'sp500_intraday': '13:28'}, None)
    ok('⑨d 這輪抓到比較舊的 → 保留上一份時,盤中標記跟著那一份(⛔ 保留下來就變成收盤)', kept and out3.get('sp500_intraday') == '13:28', out3)

    class _TS:
        def __init__(self, d):
            self.d = d

        def date(self):
            return self.d

    class _S:
        def __init__(self, vals, days):
            self.iloc, self.index = vals, [_TS(d) for d in days]

        def dropna(self):
            return self

        def __len__(self):
            return len(self.iloc)

    class _H:
        empty = False

        def __init__(self, s):
            self.s = s

        def __getitem__(self, k):
            return self.s
    yfmod = types.ModuleType('yfinance')
    yfmod.Ticker = lambda t: types.SimpleNamespace(history=lambda **kw: _H(_S([100.0, 98.0], [_date(2026, 11, 13), _date(2026, 11, 16)])))
    _saved_yf = sys.modules.get('yfinance')
    sys.modules['yfinance'] = yfmod
    try:
        clock[0] = _dt(2026, 11, 16, 18, 28, tzinfo=_tz.utc)
        ix = M2._fetch_yf_close('^IXIC', '那斯達克')
        ix_ia = M2._INTRADAY.get('^IXIC')
        bz = M2._fetch_yf_close('BZ=F', '布蘭特')
        bz_ia = M2._INTRADAY.get('BZ=F')
        clock[0] = _dt(2026, 11, 16, 21, 25, tzinfo=_tz.utc)
        ix2 = M2._fetch_yf_close('^IXIC', '那斯達克')
        ix2_ia = M2._INTRADAY.get('^IXIC')
    finally:
        if _saved_yf is None:
            sys.modules.pop('yfinance', None)
        else:
            sys.modules['yfinance'] = _saved_yf
    ok('⑨e yfinance 的那斯達克(美股現貨)在美股盤中 → 標盤中 + error 寫美東幾點、「方向待確認」;收盤後同一根 → ⛔ 標',
       ix_ia == '13:28' and ix[0] == 98.0 and '美東 13:28' in (ix[2] or '') and '方向待確認' in (ix[2] or '')
       and ix2_ia is None and ix2[2] is None, (ix, ix_ia, ix2, ix2_ia))
    ok('⑨f 原油期貨(幾乎 24 小時在交易)⛔ 套美股盤中規則', bz_ia is None and bz[2] is None, (bz, bz_ia))
    return fails


if os.environ.get('INJECT'):
    INJ = {
        'noguard': ('lqsrc', "        elif q['date'] < ref:\n            bad[tk] = f\"Cboe 停在 {q['date']}({CBOE_STOPPED_MARK} {ref})\"\n            del got[tk]\n", ''),
        'vixyf': ('src', 'def fetch_vix():      return _fetch_cboe_close("^VIX",   "VIX 恐慌指數")', 'def fetch_vix():      return _fetch_yf_close("^VIX",   "VIX 恐慌指數")'),
        'appkey': ('html', '`🪙 黃金 ${fmtMr(mr.gold_usd ?? mr.gold)}', '`🪙 黃金 ${fmtMr(mr.gold)}'),
        # 🕐 V82.4.2:Cboe 盤中不標 / yfinance 美股現貨盤中不標 / 寫檔時不寫 `_intraday` / 保留上一份時標記沒跟著走
        'nointra': ('src', "        _INTRADAY[ticker] = q['time'][:5]\n", "        pass\n"),
        'yfintra': ('src', "            _ia = _LQ.us_cash_intraday(_YF_LAST_DATE.get(ticker)) if ticker in _US_CASH_YF else ''", "            _ia = ''"),
        'nowrite': ('src', '    if intraday and val is not None:\n        out[f"{key}_intraday"] = intraday\n', ''),
        'nokeep': ('src', '        if _prev_json.get(f"{key}_intraday"):\n            out[f"{key}_intraday"] = _prev_json[f"{key}_intraday"]\n', ''),
    }
    bad = 0
    for k, (which, a, b) in INJ.items():
        base = {'src': SRC, 'lqsrc': LQSRC, 'html': HTML}
        if a not in base[which]:
            print(f'❌ 注入 {k}:找不到要改的那一行(測試過期了)'); bad += 1; continue
        base[which] = base[which].replace(a, b, 1)
        f = run(base['src'], base['lqsrc'], base['html'], quiet=True)
        print(f"{'✅' if f else '❌'} 注入 {k} → {'紅:' + ' / '.join(f)[:160] if f else '⛔ 全綠(這個注入沒被抓到)'}")
        if not f:
            bad += 1
    print(f'\n❌ {bad} 種注入沒被抓到' if bad else f'\n✅ {len(INJ)} 種注入全部叫得出來')
    sys.exit(1 if bad else 0)

fails = run(SRC, LQSRC, HTML)
print(f"\n{'✅ YF2_PASS(全部通過)' if not fails else '❌ YF2_FAIL(' + str(len(fails)) + ')'}")
sys.exit(1 if fails else 0)
