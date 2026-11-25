#!/usr/bin/env python3
"""🛟 V82.6.9 Cboe 拿不到 → 退回 yfinance 當備援(使用者 11/25 選)

為什麼:2026-11-20 起 Cboe 延遲報價對 GitHub 機器整批回 HTTP 403(11/25 macro_probe yf2_live:_VIX / _SPX / _NDX / _DJX 全部 403),
  標普 / 道瓊 / VIX / 台積電·日月光·聯電 ADR 在 macro_risk 與 macro_cache 兩份都卡在 11/19 五天 → 大跌那幾天盤前體檢少了美股。

⛔ 釘住(網路全換假的,⛔ 真的連網):
  ① macro_miner._fetch_cboe_close:Cboe 拿不到 → 用 _fetch_yf_close 的值;error 寫原本的 Cboe 原因 +「→ 備援 yfinance」
     (data_audit 認得「備援」= 有交代的降級)
  ② Cboe 拿得到 → ⛔ 去問 yfinance(備援只在失敗時)
  ③ 兩邊都拿不到 → None + 兩邊的原因都寫
  ④ VIX / 三檔 ADR 也在 _US_CASH_YF(備援在美股盤中抓到的照樣標盤中,App ⛔ 當收盤算分)
  ⑤ miner.fetch_us_macro_cache:Cboe 那幾格拿不到 → 同一輪 yfinance 補上、error 寫「→ 備援 yfinance」;
     Cboe 拿得到的那幾格 ⛔ 去問 yfinance;yfinance 也沒有 → 保留 Cboe 原因 + 備援也失敗
  ⑥ 單一檔停住、其他的都有到(用真的 lib_quotes.cboe_quotes 產生那句;例:GRID 停在 11/04)→ macro_miner / miner 兩邊 ⛔ 退 yfinance
     (那一檔自己停了,yfinance 會把同一根舊 K 當今天 → 板塊對標的平均被拉歪;test_yf2 ⑤b 同一件事)
INJECT=1:macro_miner 拿掉備援 / miner 拿掉備援 / 備援不寫「備援」/ VIX 拿出盤中清單 / 停住那檔也退(兩邊各一)/
          lib_quotes 那句改字(記號對不上)→ 每一種都要紅
"""
import io
import json
import os
import sys
import tempfile
import types
from contextlib import redirect_stdout
from datetime import date as _date, datetime as _dt, timezone as _tz
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
SRC = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')
MSRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
LQSRC = (ROOT / 'lib_quotes.py').read_text(encoding='utf-8')


def load(src, path, name):
    mod = types.ModuleType(name)
    mod.__file__ = str(path)
    exec(compile(src, str(path), 'exec'), mod.__dict__)
    return mod


def _restore(saved):
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


class _TS:
    def __init__(self, d):
        self._d = d

    def date(self):
        return self._d


class _G:
    """假的 Cboe 連線:GRID / ASX 停在 11/04,其他的都到 11/24(格式同 cdn.cboe.com delayed_quotes)。"""
    def get(self, url, expect=None):
        sym = url.rsplit('/', 1)[-1].replace('.json', '')
        ltt = '2026-11-04T15:59:59' if sym in ('GRID', 'ASX') else '2026-11-24T16:00:00'
        body = {'data': {'close': 100.0, 'current_price': 100.0, 'price_change_percent': 1.0, 'last_trade_time': ltt}}
        return types.SimpleNamespace(json=lambda: body), ''


def miner_run(msrc, lqstub):
    """跑一次 miner.fetch_us_macro_cache(yfinance / lib_quotes 換假的、cwd 換暫存資料夾)→ (macro_cache, 問過 yfinance 的代號)。"""
    hist_calls = []

    class _Row(dict):
        def __init__(self, d, c):
            super().__init__(Close=c)
            self.name = _TS(d)

    class _Iloc:
        def __init__(self, rows):
            self.rows = rows

        def __getitem__(self, i):
            return self.rows[i]

    class _Hist:
        empty = False

        def __init__(self, rows):
            self.iloc = _Iloc(rows)
            self._n = len(rows)

        def __len__(self):
            return self._n
    yf2 = types.ModuleType('yfinance')

    def _ticker(t):
        def history(**kw):
            hist_calls.append(t)
            if t == 'UMC':
                return None
            return _Hist([_Row(_date(2026, 11, 21), 100.0), _Row(_date(2026, 11, 24), 98.0)])
        return types.SimpleNamespace(history=history)
    yf2.Ticker = _ticker
    saved = {k: sys.modules.get(k) for k in ('yfinance', 'lib_quotes')}
    sys.modules['yfinance'] = yf2
    sys.modules['lib_quotes'] = lqstub
    cwd = os.getcwd()
    tmp = tempfile.mkdtemp(prefix='cfb-')
    try:
        MI = load(msrc, ROOT / 'miner.py', 'miner_cfb')
        MI.call_with_timeout = lambda fn, sec, default: fn()
        MI._us02y_official = lambda result, gate: None
        MI._index_long_official = lambda key, result, gate, _get=None: None
        os.chdir(tmp)
        with redirect_stdout(io.StringIO()):
            MI.fetch_us_macro_cache(_gate=object(), _get=lambda *a, **k: None, _qgate=object(), _now=_dt(2026, 11, 25, 0, 0, tzinfo=_tz.utc))
        return json.loads(Path(tmp, 'macro_cache.json').read_text(encoding='utf-8')), hist_calls
    finally:
        os.chdir(cwd)
        _restore(saved)


def run(src, msrc, lqsrc, quiet=False):
    fails = []

    def ok(name, cond, extra=''):
        if not quiet:
            print(f"{'✅' if cond else '❌'} {name}" + (f'  → {extra}' if not cond else ''))
        if not cond:
            fails.append(name)

    # ── ① ~ ④ macro_miner(lib_quotes 從原始碼載入 → 注入改得到它)
    LQ = load(lqsrc, ROOT / 'lib_quotes.py', 'lib_quotes_cfb')
    saved = {k: sys.modules.get(k) for k in ('yfinance', 'lib_quotes')}
    yfstub = types.ModuleType('yfinance')
    yfstub.Ticker = lambda *a, **k: None
    sys.modules['yfinance'] = yfstub
    sys.modules['lib_quotes'] = LQ
    try:
        M = load(src, ROOT / 'macro_miner.py', 'macro_miner_cfb')
    finally:
        _restore(saved)
    calls = []
    M._fetch_yf_close = lambda t, n: (calls.append(t), (7100.5, -1.23, None))[1]
    M._CBOE_BOOK = ({}, {'*': 'Cboe 斷路中:HTTP 403'})
    with redirect_stdout(io.StringIO()):
        sp = M.fetch_sp500()
        vx = M.fetch_vix()
        ts = M.fetch_tsm_adr()
    ok('① Cboe 403 → 標普 / VIX / 台積電 ADR 改用 yfinance 的值', sp[:2] == (7100.5, -1.23) and vx[0] == 7100.5 and ts[0] == 7100.5 and calls == ['^GSPC', '^VIX', 'TSM'], (sp, vx, ts, calls))
    ok('① error 寫原本的 Cboe 原因 +「→ 備援 yfinance」', all('HTTP 403' in (x[2] or '') and '備援 yfinance' in (x[2] or '') for x in (sp, vx, ts)), (sp[2], vx[2], ts[2]))
    calls.clear()
    M._CBOE_BOOK = ({'^GSPC': {'close': 7250.0, 'chg': 0.5, 'date': '2026-11-24', 'time': '16:00:00', 'note': None}}, {})
    with redirect_stdout(io.StringIO()):
        sp2 = M.fetch_sp500()
    ok('② Cboe 拿得到 → 用 Cboe 的值、⛔ 去問 yfinance', sp2[:2] == (7250.0, 0.5) and not calls and sp2[2] is None, (sp2, calls))
    M._CBOE_BOOK = ({}, {'^DJI': 'Cboe 斷路中:HTTP 403'})
    M._fetch_yf_close = lambda t, n: (None, None, 'yfinance 回空(period=1mo)')
    with redirect_stdout(io.StringIO()):
        dj = M.fetch_dji()
    ok('③ 兩邊都拿不到 → None,而且兩邊的原因都寫', dj[0] is None and dj[1] is None and 'HTTP 403' in (dj[2] or '') and 'yfinance 回空' in (dj[2] or ''), dj)
    ok('④ VIX / 台積電 / 日月光 / 聯電 ADR 都在 _US_CASH_YF(備援在美股盤中抓到的照樣標盤中)',
       all(t in M._US_CASH_YF for t in ('^VIX', 'TSM', 'ASX', 'UMC', '^GSPC', '^DJI')), M._US_CASH_YF)

    # ── ⑥ 單一檔停住(真的 cboe_quotes 產生那句)→ macro_miner ⛔ 退 yfinance
    got6, bad6 = LQ.cboe_quotes(_G(), ['^GSPC', 'GRID'], today=_date(2026, 11, 25))
    M._CBOE_BOOK = (got6, bad6)
    calls.clear()
    M._fetch_yf_close = lambda t, n: (calls.append(t), (55.0, 1.5, None))[1]
    with redirect_stdout(io.StringIO()):
        g6 = M._fetch_cboe_close('GRID', '美智慧電網')
        s6 = M.fetch_sp500()
    ok('⑥ 單一檔停住、其他的都有到(真的 cboe_quotes 那句)→ macro_miner ⛔ 退 yfinance、回 None + 原因',
       g6[0] is None and not calls and '停在 2026-11-04' in (g6[2] or '') and '備援 yfinance' not in (g6[2] or ''), (g6, calls, bad6))
    ok('⑥ 同一批沒停的那一格(標普)照用 Cboe', s6[:2] == (100.0, 1.0) and not calls, (s6, calls))

    # ── ⑤ miner.fetch_us_macro_cache:Cboe 403(NVDA 例外)
    def _cq5(gate, tickers):
        got = {'NVDA': {'close': 180.0, 'chg': 1.0, 'date': '2026-11-24', 'time': '16:00:00', 'note': None}}
        return got, {tk: 'Cboe 斷路中:HTTP 403' for tk in tickers if tk not in got}
    stub = dict(us_cash_intraday=lambda d, now=None: '', make_gate=lambda: None, CBOE_STOPPED_MARK=LQ.CBOE_STOPPED_MARK)
    mc, hist_calls = miner_run(msrc, types.SimpleNamespace(cboe_quotes=_cq5, **stub))
    sp = mc.get('sp500') or {}
    ok('⑤ macro_cache:Cboe 403 的標普 / VIX / 台積電 → 同一輪 yfinance 補上(close 98、漲跌 −2%)',
       sp.get('close') == 98.0 and sp.get('chg_pct') == -2.0 and (mc.get('vix') or {}).get('close') == 98.0 and (mc.get('tsm') or {}).get('close') == 98.0, {k: mc.get(k) for k in ('sp500', 'vix', 'tsm')})
    ok('⑤ 補上的那幾格 error 寫原本的 Cboe 原因 +「→ 備援 yfinance」', all('HTTP 403' in str(mc.get(f'{k}_error')) and '備援 yfinance' in str(mc.get(f'{k}_error')) for k in ('sp500', 'vix', 'tsm', 'dji', 'asx')),
       {k: mc.get(f'{k}_error') for k in ('sp500', 'vix', 'tsm', 'dji', 'asx')})
    ok('⑤ Cboe 拿得到的那一格(NVDA)⛔ 去問 yfinance、⛔ error', 'NVDA' not in hist_calls and (mc.get('nvda') or {}).get('close') == 180.0 and 'nvda_error' not in mc, (hist_calls, mc.get('nvda'), mc.get('nvda_error')))
    ok('⑤ yfinance 也沒有(UMC)→ 沒有值、error 保留 Cboe 原因 + 備援也失敗', 'umc' not in mc and 'HTTP 403' in str(mc.get('umc_error')) and '備援 yfinance' in str(mc.get('umc_error')), (mc.get('umc'), mc.get('umc_error')))

    # ── ⑥b miner:ASX 單一檔停住(真的 cboe_quotes),其他的到 11/24
    mc6, hc6 = miner_run(msrc, types.SimpleNamespace(cboe_quotes=lambda g, t: LQ.cboe_quotes(_G(), t, today=_date(2026, 11, 25)), **stub))
    ok('⑥b macro_cache:ASX 單一檔停住 → ⛔ 退 yfinance、沒有值、error 寫停在哪天(⛔「備援」)',
       'ASX' not in hc6 and 'asx' not in mc6 and '停在 2026-11-04' in str(mc6.get('asx_error')) and '備援' not in str(mc6.get('asx_error')), (hc6, mc6.get('asx'), mc6.get('asx_error')))
    ok('⑥b 同一批沒停的(標普 / 台積電)照用 Cboe、⛔ 去問 yfinance', (mc6.get('sp500') or {}).get('close') == 100.0 and (mc6.get('tsm') or {}).get('close') == 100.0
       and not ({'^GSPC', 'TSM'} & set(hc6)), (mc6.get('sp500'), mc6.get('tsm'), hc6))
    return fails


if os.environ.get('INJECT'):
    INJ = {
        'macronofb': ('src', "        v, chg, err = _fetch_yf_close(ticker, name)\n        if v is not None:", "        v, chg, err = None, None, '注入'\n        if v is not None:"),
        'minernofb': ('msrc', "    _fb = {k: tk for k, tk in _CBOE_MACRO_SYMBOLS.items()\n           if k not in result and f'{k}_error' in result and _LQ.CBOE_STOPPED_MARK not in result[f'{k}_error']}", "    _fb = {}"),
        'nonote': ('src', 'note = f"{name}:{why} → 備援 yfinance"', 'note = f"{name}:{why}"'),
        'vixout': ('src', "_US_CASH_YF = ('^IXIC', '^SOX', '^GSPC', '^DJI', '^VIX', 'TSM', 'ASX', 'UMC')", "_US_CASH_YF = ('^IXIC', '^SOX', '^GSPC', '^DJI', 'TSM', 'ASX', 'UMC')"),
        'stopfb': ('src', "        if _LQ.CBOE_STOPPED_MARK in why:\n            return None, None, f\"{name}:{why}(那一檔自己停了 → ⛔ 退備援;下一輪再試)\"\n", ""),
        'minerstopfb': ('msrc', " and _LQ.CBOE_STOPPED_MARK not in result[f'{k}_error']}", "}"),
        'markword': ('lqsrc', "({CBOE_STOPPED_MARK} {ref})", "(其他已經到 {ref})"),
    }
    bad = 0
    for k, (which, a, b) in INJ.items():
        base = {'src': SRC, 'msrc': MSRC, 'lqsrc': LQSRC}
        if a not in base[which]:
            print(f'❌ 注入 {k}:找不到要改的那一行(測試過期了)')
            bad += 1
            continue
        base[which] = base[which].replace(a, b, 1)
        f = run(base['src'], base['msrc'], base['lqsrc'], quiet=True)
        print(f"{'✅' if f else '❌'} 注入 {k} → {'紅:' + ' / '.join(f)[:150] if f else '⛔ 全綠(這個注入沒被抓到)'}")
        bad += 0 if f else 1
    print(f'\n❌ {bad} 種注入沒被抓到' if bad else f'\n✅ {len(INJ)} 種注入全部叫得出來')
    sys.exit(1 if bad else 0)

fails = run(SRC, MSRC, LQSRC)
print(f'\n❌ {len(fails)} 條失敗:{fails}' if fails else '\n✅ CBOE_FALLBACK_PASS(全部通過)')
sys.exit(1 if fails else 0)
