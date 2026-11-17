#!/usr/bin/env python3
"""💱 報價來源(換掉 yfinance 第二階段):比特幣交易所公開 API + Twelve Data(要金鑰的免費方案)+ 美元指數自己算。

為什麼要有這支:yfinance 1.x 靠 curl_cffi 冒充 Chrome 才連得到 Yahoo(違反「⛔ 偽裝瀏覽器」)。第一階段(lib_official.py,
V82.3.6)換掉有官方來源的美債 / 加權長歷史;使用者 11/15「推薦的繼續」= 第二階段:
  D 比特幣 → 交易所公開 API(Coinbase Exchange,失敗退 Kraken;免金鑰,⚠️ 是交易所報價不是「官方」)
  B 美股個股 / ADR / 黃金 / 匯率 / 指數型 ETF / 板塊 ETF → Twelve Data 免費方案(Basic:每天 800、每分鐘 8 個代號)
    ⚠️ 免費方案**沒有**指數本身、VIX、原油、銅(2026-11-15 td_plan 探針用官方 show_plan 量過)。
  美元指數 → 用 ICE 公開的公式拿 6 個匯率算(Twelve Data 免費有那 6 個匯率)

規則(同 lib_official / lib_http):
  · 一律走 lib_http.Gate(UA 寫明身分、⛔ Referer、同一個網站有間隔、被擋斷路、退避)
  · 金鑰只從環境變數(repo Secrets)讀,**只放 HTTP 標頭**(`Authorization: apikey …`),⛔ 放網址、⛔ 印出來
  · 結果分三種:ok / 還沒設定(沒金鑰 → 安靜跳過,⛔ 發失敗通知)/ 抓失敗(要說下一步)
"""
import math
import os
import sys
from datetime import datetime, timedelta, timezone

UA = 'Mozilla/5.0 (compatible; StockAI-DB/1.0; +https://github.com/xin7355-collab/stockai-db)'
COINBASE_DAILY = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400'
KRAKEN_DAILY = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440'
TD_BASE = 'https://api.twelvedata.com'
TD_KEY_ENV = 'TWELVEDATA_API_KEY'
# ⏱️ Twelve Data 免費方案每分鐘 8 個代號(每個代號 1 點):一次最多問 8 個、兩次之間隔 61 秒
TD_BATCH = 8
TD_GAP = 61.0
# 📈 Cboe 延遲報價:Cboe 官網自己在用的公開 JSON(免金鑰;⚠️ 沒寫成正式 API 文件,改版會失敗 → 一律寫 *_error)。
#    2026-11-15 yf2_live / yf2_cboe 探針:VIX / 標普 500 / 道瓊(DJX = 道瓊 ÷ 100)/ ADR / 美股 / 美國上市 ETF 收盤後就有,
#    標普收盤跟 FRED 官方 SP500 一字不差;⛔ 那斯達克綜合(_COMP / _IXIC 403)、⚠️ 費半 _SOX 停在 11/04(→ 日期守門擋)
CBOE_DQ = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/{sym}.json'
CBOE_SYM = {'^VIX': '_VIX', '^GSPC': '_SPX', '^DJI': '_DJX', '^NDX': '_NDX', '^RUT': '_RUT', '^SOX': '_SOX'}   # Yahoo 寫法 → Cboe
CBOE_SCALE = {'_DJX': 100.0}
# 🌙 期交所行情網(官方行情系統,官網自己在用;盤後 = MarketType 1)—— 早上 8 點就看得到剛收的夜盤(OpenAPI 要等下午)
TAIFEX_MIS = 'https://mis.taifex.com.tw/futures/api/getQuoteList'
GAPS = {'api.exchange.coinbase.com': 1.0, 'api.kraken.com': 1.0, 'api.twelvedata.com': TD_GAP,
        'cdn.cboe.com': 0.5, 'mis.taifex.com.tw': 1.0}

# 美元指數(ICE 公開公式):50.14348112 × EURUSD^−0.576 × USDJPY^0.136 × GBPUSD^−0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036
DXY_W = (('EUR/USD', -0.576), ('USD/JPY', 0.136), ('GBP/USD', -0.119), ('USD/CAD', 0.091), ('USD/SEK', 0.042), ('USD/CHF', 0.036))
DXY_K = 50.14348112


def make_gate(send=None, sleep=None, clock=None, timeout=20, backoff=(2, 4)):
    from lib_http import Gate
    kw = {k: v for k, v in (('send', send), ('sleep', sleep), ('clock', clock)) if v is not None}
    return Gate(gaps=GAPS, backoff=tuple(backoff), timeout=timeout, ua=UA, **kw)


def _f(v):
    try:
        x = float(str(v).replace(',', '').strip())
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def _utc_day(ts):
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).strftime('%Y-%m-%d')
    except (TypeError, ValueError, OSError, OverflowError):
        return None


# ───────────────────────── 比特幣(D 方案)─────────────────────────
def parse_coinbase_daily(j):
    """Coinbase Exchange 日 K:[[時間, 低, 高, 開, 收, 量], …](新到舊)→ [(UTC 日, 收盤)…] 由舊到新。純函式。
    ⚠️ 最後一根是「今天(UTC)還在跑的」—— 跟 Yahoo BTC-USD 的日線同一個切法(UTC 午夜換日)。"""
    out = {}
    for row in j if isinstance(j, list) else []:
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        d, c = _utc_day(row[0]), _f(row[4])
        if d and c and c > 0:
            out[d] = c
    return sorted(out.items())


def parse_kraken_daily(j):
    """Kraken OHLC:{'error': [], 'result': {'XXBTZUSD': [[時間, 開, 高, 低, 收, vwap, 量, 筆數], …], 'last': …}} → 同上。"""
    if not isinstance(j, dict) or j.get('error'):
        return []
    res = j.get('result') or {}
    out = {}
    for k, rows in res.items():
        if k == 'last' or not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 5:
                continue
            d, c = _utc_day(row[0]), _f(row[4])
            if d and c and c > 0:
                out[d] = c
    return sorted(out.items())


def btc_daily(gate):
    """→ (status, [(日, 收盤)…], 來源, 附註)。① Coinbase ② Kraken(備援,附註寫「備援」)。"""
    res, why = gate.get(COINBASE_DAILY, expect='json')
    pts = parse_coinbase_daily(res.json()) if res is not None else []
    if len(pts) >= 2:
        return 'ok', pts, 'Coinbase', ''
    why1 = why or ('Coinbase 回的日 K 不到 2 根' if res is not None else '')
    res, why = gate.get(KRAKEN_DAILY, expect='json')
    pts = parse_kraken_daily(res.json()) if res is not None else []
    if len(pts) >= 2:
        return 'ok', pts, 'Kraken', f'Coinbase 抓不到({why1})→ 改用 Kraken(備援)'
    return 'fail', None, '', f'Coinbase:{why1} ・Kraken:{why or "回的日 K 不到 2 根"}'


# ───────────────────────── Twelve Data(B 方案)─────────────────────────
def td_key():
    """金鑰只從環境變數讀(repo Secrets → workflow env)。⛔ 印出來。"""
    return (os.environ.get(TD_KEY_ENV) or '').strip()


def parse_td_quote(j, symbols):
    """/quote 的回應 → ({代號: {close, prev, chg, date}}, {代號: 錯誤原因})。純函式。
    一個代號回單一物件、多個代號回「代號 → 物件」;某個代號錯 = 那一格是 {status: 'error', code, message}。"""
    ok, bad = {}, {}
    if not isinstance(j, dict):
        return ok, {s: '回應不是 JSON 物件' for s in symbols}
    if j.get('status') == 'error' and 'symbol' not in j:
        return ok, {s: f"{j.get('code')} {str(j.get('message'))[:80]}" for s in symbols}
    items = {symbols[0]: j} if (len(symbols) == 1 and 'symbol' in j) else j
    for s in symbols:
        q = items.get(s)
        if not isinstance(q, dict):
            bad[s] = '沒有這一格'
            continue
        if q.get('status') == 'error':
            bad[s] = f"{q.get('code')} {str(q.get('message'))[:80]}"
            continue
        c, p = _f(q.get('close')), _f(q.get('previous_close'))
        if not c or c <= 0:
            bad[s] = '收盤不是正數'
            continue
        chg = _f(q.get('percent_change'))
        if chg is None and p:
            chg = (c - p) / p * 100
        ok[s] = {'close': c, 'prev': p, 'chg': round(chg, 2) if chg is not None else None,
                 'date': str(q.get('datetime') or '')[:10] or None}
    return ok, bad


def td_quote(gate, symbols, key=None):
    """→ (status, {代號: …}, 附註)。status:ok / partial / nokey(還沒設定,安靜)/ fail。
    ⏱️ 一次最多 8 個代號、兩次之間 61 秒(Gate 的網站間隔);額度用完(429 / 回應寫 run out)→ 剩下的 ⛔ 再問。"""
    key = td_key() if key is None else key
    if not key:
        return 'nokey', {}, f'還沒設定 {TD_KEY_ENV}(repo Secrets)→ 這幾格先不換'
    symbols = [s for s in dict.fromkeys(symbols) if s]
    got, bad, notes = {}, {}, []
    for i in range(0, len(symbols), TD_BATCH):
        part = symbols[i:i + TD_BATCH]
        res, why = gate.get(f'{TD_BASE}/quote', expect='json', params={'symbol': ','.join(part)},
                            headers={'Authorization': f'apikey {key}', 'Accept': 'application/json'})
        if res is None:
            for s in part:
                bad[s] = why
            notes.append(why)
            if why.startswith('斷路'):
                break
            continue
        try:
            j = res.json()
        except ValueError:
            j = None
        if isinstance(j, dict) and j.get('code') in (401, 403) and 'symbol' not in j:
            for s in symbols[i:]:
                bad[s] = '金鑰被拒'
            notes.append(f"金鑰被拒({j.get('code')})→ 去 Twelve Data 後台確認金鑰、重填 repo Secrets 的 {TD_KEY_ENV}")
            break
        if isinstance(j, dict) and j.get('code') == 429 and 'symbol' not in j:
            for s in symbols[i:]:
                bad[s] = '額度用完'
            notes.append('Twelve Data 額度用完或太頻繁(免費方案每天 800、每分鐘 8)→ 剩下的這輪不問')
            break
        o, b = parse_td_quote(j, part)
        got.update(o)
        bad.update(b)
    if got and not bad:
        return 'ok', got, ''
    if got:
        return 'partial', got, f"{len(bad)} 個沒拿到:" + ', '.join(f'{s}({w})' for s, w in list(bad.items())[:6])
    return 'fail', {}, ' ・'.join(dict.fromkeys(notes)) or ('全部沒拿到:' + ', '.join(f'{s}({w})' for s, w in list(bad.items())[:6]))


def parse_cboe(j, sym):
    """Cboe 延遲報價 JSON → ({close, chg, date, time}, '') 或 (None, 原因)。純函式。
    ⚠️ 用 `close`(正式收盤)+ `price_change_percent`(收盤 vs 前一天收盤);⛔ 用 current_price(美股含盤後成交)、
       ⛔ 用 prev_day_close(收盤後過一陣子會被換成當天收盤 —— 11/15 探針 NVDA 那份就是)。"""
    d = (j or {}).get('data') if isinstance(j, dict) else None
    if not isinstance(d, dict):
        return None, 'Cboe 回應沒有 data'
    close = _f(d.get('close')) or _f(d.get('current_price'))
    if not close or close <= 0:
        return None, 'Cboe 收盤不是正數'
    pct = _f(d.get('price_change_percent'))
    if pct is None:
        pc = _f(d.get('price_change'))
        pct = pc / (close - pc) * 100 if (pc is not None and close - pc > 0) else None
    ltt = str(d.get('last_trade_time') or '')
    date = ltt[:10] if len(ltt) >= 10 and ltt[4:5] == '-' else None
    tm = ltt[11:19] if len(ltt) >= 19 else None
    sc = CBOE_SCALE.get(sym, 1.0)
    return {'close': round(close * sc, 2), 'chg': round(pct, 2) if pct is not None else None, 'date': date, 'time': tm}, ''


def cboe_quotes(gate, tickers, today=None, max_age_days=5):
    """一輪要的 Cboe 代號一次問完(Yahoo 寫法 ^VIX / TSM …)→ ({代號: 報價}, {代號: 原因})。
    🛡️ 日期守門(同 V71.5.1「成功但過期」那一課):以這一批最新的那天為準,比它舊的代號 = 停住了(例:_SOX 停在 11/04)→ ⛔ 收;
       最新那天本身比今天(美東)早超過 max_age_days 天 → 整批 ⛔ 收(連假最多 4 天)。
       最新那天、但成交時間早於 15:59(美東)= 盤中那份 → 收、但附 note「盤中價,方向待確認」(⛔ 說成收盤)。"""
    got, bad = {}, {}
    for tk in dict.fromkeys(tickers):
        sym = CBOE_SYM.get(tk, tk)
        res, why = gate.get(CBOE_DQ.format(sym=sym), expect='json')
        if res is None:
            bad[tk] = f'Cboe {why}'
            continue
        try:
            q, why = parse_cboe(res.json(), sym)
        except ValueError:
            q, why = None, 'Cboe 回應不是 JSON'
        if q is None:
            bad[tk] = why
        else:
            got[tk] = q
    dates = [q['date'] for q in got.values() if q.get('date')]
    if not dates:
        return {}, {**bad, **{tk: 'Cboe 沒有成交日期' for tk in got}}
    ref = max(dates)
    from datetime import date as _date, timedelta
    t0 = today or (datetime.now(timezone.utc) - timedelta(hours=5)).date()
    if (t0 - _date.fromisoformat(ref)).days > max_age_days:
        return {}, {**bad, **{tk: f'Cboe 整批停在 {ref}(超過 {max_age_days} 天)' for tk in got}}
    for tk in list(got):
        q = got[tk]
        if not q.get('date'):
            bad[tk] = 'Cboe 沒有成交日期'
            del got[tk]
        elif q['date'] < ref:
            bad[tk] = f"Cboe 停在 {q['date']}(其他的已到 {ref})"
            del got[tk]
        elif q.get('time') and q['time'] < '15:59:00':
            # data_audit 認得「方向待確認」= 有交代的降級(值在、error 也在 ⛔ 算矛盾)
            q['note'] = f"Cboe 那份停在美東 {q['time'][:5]}(盤中價,方向待確認)"
    return got, bad


def _et_offset_hours(now_utc):
    """美東跟 UTC 差幾小時:夏令 −4、平常 −5。美國 2007 起:3 月第二個星期日 02:00(= 07:00 UTC)~ 11 月第一個星期日 02:00(= 06:00 UTC)。
    ⛔ 不靠 zoneinfo(有的機器沒有時區資料庫 → 例外,這一格就整個不判);純函式。"""
    y = now_utc.year

    def nth_sunday(month, n):
        first = (6 - datetime(y, month, 1).weekday()) % 7   # weekday():星期一 0 … 星期日 6
        return 1 + first + 7 * (n - 1)
    start = datetime(y, 3, nth_sunday(3, 2), 7, tzinfo=timezone.utc)
    end = datetime(y, 11, nth_sunday(11, 1), 6, tzinfo=timezone.utc)
    return -4 if start <= now_utc < end else -5


US_CASH_OPEN, US_CASH_GRACE_END = '09:30', '16:20'


def us_cash_intraday(bar_date, now_utc=None):
    """美股現貨(指數 / 個股 / ADR)這一格「美股還沒收盤」嗎?→ 美東 'HH:MM'(是;抓的時候美東幾點)或 ''(不是)。純函式(now 可注入)。
    規則:美東現在是平日、這一格的日期 == 美東今天、而且 09:30 ≤ 美東現在 < 16:20(延遲報價晚 15 分 + 5 分緩衝)。
    為什麼:2026-11-16 每日採礦機的排程晚了快 7 小時(台北 02:42 才跑,美股還在交易)→ macro_cache 寫進美東 13:28 的
      盤中價、日期 11/16,App 當成收盤(標普 −1.81%,收盤其實 −1.92%;台積電 ADR −5.70% vs −6.34%)。
    ⛔ 只給美股現貨:期貨 / 原油 / 匯率幾乎 24 小時在交易,這條規則不適用(那幾格本來就是「現在」的價)。
    ⚠️ 半天市(感恩節隔天等 13:00 收)收完到 16:20 之間會被當成盤中 → 寧可說「還不是收盤」也 ⛔ 把盤中價說成收盤。"""
    now = now_utc or datetime.now(timezone.utc)
    et = now + timedelta(hours=_et_offset_hours(now))
    if et.weekday() >= 5 or str(bar_date or '')[:10] != et.strftime('%Y-%m-%d'):
        return ''
    hm = et.strftime('%H:%M')
    return hm if US_CASH_OPEN <= hm < US_CASH_GRACE_END else ''


def parse_taifex_night(j):
    """期交所行情網(盤後)→ 台指期近月夜盤 {price, chg, ref, date, time, contract} 或 None。純函式。
    近月 = 成交量最大的那個月份(⛔ 現貨 TXF-P);漲跌% = 最後成交 vs 參考價(= 前一個日盤結算)。
    日期 = 夜盤**結束**那天(CTime 早於 06:00 = 過了午夜 → CDate + 1 天;11/15 探針:CDate 20261113、CTime 045959 = 11/14 清晨收的那一盤)。"""
    rows = (((j or {}).get('RtData') or {}).get('QuoteList') or []) if isinstance(j, dict) else []
    best, best_v = None, -1.0
    for r in rows:
        sid = str((r or {}).get('SymbolID') or '')
        # ⛔ 現貨那一列:盤後叫 TXF-P、日盤叫 TXF-S(11/15 探針;名字都是「臺指現貨」)
        if not sid.startswith('TXF') or sid.endswith(('-P', '-S')) or '現貨' in str(r.get('DispCName') or ''):
            continue
        v = _f(r.get('CTotalVolume')) or 0.0
        if v > best_v:
            best, best_v = r, v
    if not best:
        return None
    last, ref = _f(best.get('CLastPrice')), _f(best.get('CRefPrice'))
    if not last or not ref or last <= 0 or ref <= 0:
        return None
    cd, ct = str(best.get('CDate') or ''), str(best.get('CTime') or '')
    if len(cd) != 8 or not cd.isdigit():
        return None
    from datetime import date as _date, timedelta
    d = _date(int(cd[:4]), int(cd[4:6]), int(cd[6:]))
    if len(ct) == 6 and ct.isdigit() and ct < '060000':
        d += timedelta(days=1)
    return {'price': round(last, 2), 'chg': round((last - ref) / ref * 100, 2), 'ref': round(ref, 2), 'date': d.isoformat(),
            'time': f'{ct[:2]}:{ct[2:4]}:{ct[4:]}' if len(ct) == 6 else None, 'contract': best.get('DispCName')}


def taifex_mis(gate, market='1'):
    """→ (報價 dict 或 None, 原因)。market '1' = 盤後(夜盤)、'0' = 一般(日盤)。
    ⛔ Referer / Origin、⛔ 偽裝瀏覽器(lib_http 的 UA)。"""
    body = {'MarketType': market, 'SymbolType': 'F', 'KindID': '1', 'CID': 'TXF', 'ExpireMonth': '',
            'RowSize': '全部', 'PageNo': '', 'SortColumn': '', 'AscDesc': 'A'}
    nm = '盤後' if market == '1' else '日盤'
    res, why = gate.post(TAIFEX_MIS, expect='json', json=body, headers={'Content-Type': 'application/json'})
    if res is None:
        return None, f'期交所行情網({nm}){why}'
    try:
        q = parse_taifex_night(res.json())
    except ValueError:
        return None, f'期交所行情網({nm})回應不是 JSON'
    return (q, '') if q else (None, f'期交所行情網({nm})沒有台指期近月的成交')


def dxy_from_fx(fx):
    """{'EUR/USD': {close, prev}, …} → (今天的 DXY, 前一天的 DXY, 漲跌%)。少任何一個匯率 → (None, None, None)。純函式。"""
    try:
        def idx(field):
            v = DXY_K
            for p, w in DXY_W:
                x = fx[p][field]
                if not x or x <= 0:
                    return None
                v *= x ** w
            return v
        now, prev = idx('close'), idx('prev')
    except (KeyError, TypeError):
        return None, None, None
    if now is None:
        return None, None, None
    chg = round((now - prev) / prev * 100, 2) if prev else None
    return round(now, 3), (round(prev, 3) if prev else None), chg


# ───────────────────────── 自我測試(離線、網路全假)─────────────────────────
def selftest():
    import json as _json
    fails, n = [], [0]

    def ok(name, cond, got=''):
        n[0] += 1
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    class R:
        def __init__(self, code, body):
            self.status_code = code
            self.content = body.encode('utf-8') if isinstance(body, str) else body

        def json(self):
            return _json.loads(self.content.decode('utf-8'))

    def fake(routes, key_seen=None):
        calls = []

        def send(method, url, **kw):
            calls.append((url, kw.get('params'), (kw.get('headers') or {})))
            for frag, v in routes.items():
                if frag in url:
                    x = v.pop(0) if isinstance(v, list) else v
                    if isinstance(x, Exception):
                        raise x
                    return x
            return R(404, 'not found')
        return make_gate(send=send, sleep=lambda s: None, clock=lambda: 0.0), calls

    # 比特幣
    cb = _json.dumps([[1794700800, 61946, 65564, 64118, 64411.56, 7648], [1794614400, 63270, 68380, 68236, 64118.79, 16354]])
    g, calls = fake({'coinbase': R(200, cb)})
    st, pts, src, note = btc_daily(g)
    ok('① Coinbase 日 K(新到舊)→ 由舊到新、UTC 日', st == 'ok' and src == 'Coinbase' and pts == [('2026-11-14', 64118.79), ('2026-11-15', 64411.56)] and note == '', (st, pts))
    ua = calls[0][2].get('User-Agent', '')
    ok('①b UA 寫明 StockAI-DB、⛔ 冒充瀏覽器', 'StockAI-DB' in ua and 'Chrome' not in ua and 'Safari' not in ua, ua)
    kr = _json.dumps({'error': [], 'result': {'XXBTZUSD': [[1794614400, '68237', '68369', '63242', '64115.1', '0', '1', 2], [1794700800, '64115', '65593', '61970', '64317.7', '0', '1', 2]], 'last': 1794700800}})
    g, calls = fake({'coinbase': R(403, '<html>denied</html>'), 'kraken': R(200, kr)})
    st, pts, src, note = btc_daily(g)
    ok('② Coinbase 被擋 → Kraken,附註寫「備援」+ 原因', st == 'ok' and src == 'Kraken' and pts[-1] == ('2026-11-15', 64317.7) and '備援' in note and '403' in note, (st, src, note))
    g, calls = fake({'coinbase': R(200, '[]'), 'kraken': R(200, _json.dumps({'error': ['EGeneral:Too many requests']}))})
    st, pts, src, note = btc_daily(g)
    ok('③ 兩家都沒拿到 → fail、兩個原因都寫', st == 'fail' and pts is None and 'Coinbase' in note and 'Kraken' in note, (st, note))
    ok('③b 收盤不是正數 / 壞列 ⛔ 收進來', parse_coinbase_daily([[1794614400, 1, 2, 3, 0, 1], ['x'], None, [1794700800, 1, 2, 3, 'NaN', 1]]) == [])

    # Twelve Data
    os.environ.pop(TD_KEY_ENV, None)
    g, calls = fake({})
    st, got, note = td_quote(g, ['TSM', 'NVDA'])
    ok('④ 沒金鑰 → nokey(還沒設定,安靜)、⛔ 送任何請求', st == 'nokey' and not calls and TD_KEY_ENV in note, (st, calls))
    many = {s: {'symbol': s, 'datetime': '2026-11-13', 'close': '100', 'previous_close': '98', 'percent_change': '2.0408'} for s in
            ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']}
    first = {k: v for k, v in many.items() if k != 'I'}
    g, calls = fake({'twelvedata': [R(200, _json.dumps(first)), R(200, _json.dumps(many['I']))]})
    st, got, note = td_quote(g, list(many), key='SECRET123')
    ok('⑤ 9 個代號 → 分兩次問(8 + 1),全部拿到', st == 'ok' and len(got) == 9 and len(calls) == 2
       and calls[0][1]['symbol'].count(',') == 7 and calls[1][1]['symbol'] == 'I', (st, len(got), [c[1] for c in calls]))
    ok('⑤b 金鑰只在標頭(Authorization: apikey …)、⛔ 在網址 / 參數裡', all(c[2].get('Authorization') == 'apikey SECRET123'
       and 'SECRET123' not in c[0] and 'SECRET123' not in str(c[1]) for c in calls), calls)
    ok('⑤c 單一代號回單一物件也收、漲跌照回應的 percent_change', got['I'] == {'close': 100.0, 'prev': 98.0, 'chg': 2.04, 'date': '2026-11-13'}, got.get('I'))
    mixed = {'TSM': many['A'] | {'symbol': 'TSM'}, 'ZZZ': {'code': 404, 'message': 'symbol not found', 'status': 'error'}}
    g, calls = fake({'twelvedata': R(200, _json.dumps(mixed))})
    st, got, note = td_quote(g, ['TSM', 'ZZZ'], key='k')
    ok('⑥ 一個代號錯 → partial、寫是哪一個', st == 'partial' and 'TSM' in got and 'ZZZ' in note and '404' in note, (st, note))
    g, calls = fake({'twelvedata': [R(200, _json.dumps({'code': 429, 'message': 'You have run out of API credits', 'status': 'error'}))]})
    st, got, note = td_quote(g, list(many), key='k')
    ok('⑦ 額度用完 → 剩下的 ⛔ 再問(只送 1 次)、說明白', st == 'fail' and len(calls) == 1 and '額度' in note, (st, len(calls), note))
    g, calls = fake({'twelvedata': [R(200, _json.dumps({'code': 401, 'message': 'invalid api key', 'status': 'error'}))]})
    st, got, note = td_quote(g, list(many), key='k')
    ok('⑧ 金鑰被拒 → 說要去重填 Secrets、⛔ 再問、⛔ 印出金鑰', st == 'fail' and len(calls) == 1 and TD_KEY_ENV in note and 'k' != note, (st, note))

    # Cboe 延遲報價(11/15 探針的真實格式)
    def cq(sym, close, pct, ltt, cur=None, prev=None):
        return R(200, _json.dumps({'timestamp': '2026-11-14 01:04:08', 'data': {
            'symbol': sym, 'current_price': cur if cur is not None else close, 'prev_day_close': prev if prev is not None else close,
            'price_change_percent': pct, 'close': close, 'last_trade_time': ltt}}))
    from datetime import date as _d
    g, calls = fake({'_VIX.json': cq('^VIX', 19.3, 3.1088, '2026-11-13T16:15:01'),
                     '_DJX.json': cq('^DJX', 523.48, 0.0974, '2026-11-13T16:43:26'),
                     '/TSM.json': cq('TSM', 398.73, -1.6671, '2026-11-13T16:00:00', cur=394.5, prev=405.49),
                     '/NVDA.json': cq('NVDA', 162.85, -2.051, '2026-11-13T15:59:59', prev=162.85),
                     '_SOX.json': cq('^SOX', 10268.65, -3.1296, '2026-11-04T16:05:23'),
                     '/SMH.json': cq('SMH', 486.75, -2.9857, '2026-11-13T14:30:00')})
    got, bad = cboe_quotes(g, ['^VIX', '^DJI', 'TSM', 'NVDA', 'SOXX_X', 'SMH'] + ['^SOX'], today=_d(2026, 11, 16))
    ok('⑩ Cboe:VIX / ADR 用正式收盤 + 收盤漲跌%(⛔ 盤後成交價 394.5、⛔ 被換掉的 prev_day_close)',
       got.get('^VIX') == {'close': 19.3, 'chg': 3.11, 'date': '2026-11-13', 'time': '16:15:01'}
       and got.get('TSM', {}).get('close') == 398.73 and got['TSM']['chg'] == -1.67 and got['NVDA']['chg'] == -2.05, got)
    ok('⑩b 道瓊 = DJX × 100(同一個指數)', got.get('^DJI', {}).get('close') == 52348.0, got.get('^DJI'))
    ok('⑩c 🛡️ 停住的代號(_SOX 停在 11/04,其他到 11/13)⛔ 收、寫原因', '^SOX' not in got and '11-04' in bad.get('^SOX', ''), bad.get('^SOX'))
    ok('⑩d 盤中那份(14:30)收、但附「盤中價,方向待確認」(data_audit 認得的字)', '14:30' in got.get('SMH', {}).get('note', '')
       and '方向待確認' in got['SMH']['note'], got.get('SMH'))
    ok('⑩e 沒有這個代號(404)→ 寫原因、⛔ 整批失敗', 'SOXX_X' in bad and len(got) == 5, bad)
    ok('⑩f 走 Yahoo 寫法換成 Cboe 寫法(^VIX → _VIX)', any('_VIX.json' in c[0] for c in calls) and not any('%5E' in c[0] or '^' in c[0] for c in calls))
    g, calls = fake({'_VIX.json': cq('^VIX', 19.3, 3.1, '2026-11-02T16:15:01')})
    got, bad = cboe_quotes(g, ['^VIX'], today=_d(2026, 11, 16))
    ok('⑩g 整批都停在兩週前 → ⛔ 收(⛔ 拿舊的當今天)', not got and '超過' in bad['^VIX'], bad)
    # 期交所行情網夜盤(11/15 探針的真實格式)
    mis = {'RtCode': '0', 'RtData': {'QuoteList': [
        {'SymbolID': 'TXF-P', 'DispCName': '臺指現貨', 'CLastPrice': '', 'CRefPrice': '43675.12', 'CDate': '20261113', 'CTime': ''},
        {'SymbolID': 'TXFK6-M', 'DispCName': '臺指期116', 'CLastPrice': '43706.00', 'CRefPrice': '43839.00', 'CTotalVolume': '55924', 'CDate': '20261113', 'CTime': '045959'},
        {'SymbolID': 'TXFL6-M', 'DispCName': '臺指期126', 'CLastPrice': '43796.00', 'CRefPrice': '43917.00', 'CTotalVolume': '1472', 'CDate': '20261113', 'CTime': '045711'}]}}
    q = parse_taifex_night(mis)
    ok('⑪ 夜盤:近月(量最大)、漲跌 = 最後成交 vs 前一個日盤結算、⛔ 現貨那列', q and q['price'] == 43706.0 and q['chg'] == -0.3 and q['contract'] == '臺指期116', q)
    ok('⑪b 日期 = 夜盤結束那天(過了午夜 → CDate + 1)', q and q['date'] == '2026-11-14' and q['time'] == '04:59:59', q)
    live = {'RtData': {'QuoteList': [dict(mis['RtData']['QuoteList'][1], CDate='20261116', CTime='223000')]}}
    ok('⑪c 晚上還在跑的那一盤(22:30)日期 = 當天', parse_taifex_night(live)['date'] == '2026-11-16')
    ok('⑪d 沒有成交 / 格式不對 → None(⛔ 硬算)', parse_taifex_night({'RtData': {'QuoteList': [{'SymbolID': 'TXFK6-M', 'CLastPrice': '', 'CRefPrice': '43839'}]}}) is None
       and parse_taifex_night(None) is None)
    g, calls = fake({'getQuoteList': R(200, _json.dumps(mis))})
    q, why = taifex_mis(g)
    ok('⑪e 送的是 POST JSON、⛔ Referer / Origin、UA 寫明身分', q and calls and 'Referer' not in calls[0][2] and 'Origin' not in calls[0][2]
       and 'StockAI-DB' in calls[0][2].get('User-Agent', ''), calls[:1])
    day = {'RtData': {'QuoteList': [dict(mis['RtData']['QuoteList'][1], CDate='20261116', CTime='120500', CLastPrice='44000', CRefPrice='43839')]}}
    g, calls = fake({'getQuoteList': R(200, _json.dumps(day))})
    q, why = taifex_mis(g, '0')
    ok('⑪f 日盤(MarketType 0)同一套解析:盤中 12:05 → 當天、漲跌照算', q and q['date'] == '2026-11-16' and q['chg'] == 0.37, q)
    dayrows = {'RtData': {'QuoteList': [
        {'SymbolID': 'TXF-S', 'DispCName': '臺指現貨', 'CTotalVolume': '', 'CLastPrice': '43675.12', 'CRefPrice': '43091.87', 'CDate': '20261113', 'CTime': '133315'},
        {'SymbolID': 'TXFK6-F', 'DispCName': '臺指期116', 'CTotalVolume': '166583', 'CLastPrice': '43834.00', 'CRefPrice': '43128.00', 'CDate': '20261113', 'CTime': '134459'}]}}
    q = parse_taifex_night(dayrows)
    ok('⑪g 日盤的現貨那列叫 TXF-S(⛔ 拿現貨當期貨);11/15 探針真實格式:收盤 43834、昨結 43128',
       q and q['price'] == 43834.0 and q['chg'] == 1.64 and q['date'] == '2026-11-13', q)
    only_spot = {'RtData': {'QuoteList': [dayrows['RtData']['QuoteList'][0]]}}
    ok('⑪h 只剩現貨那列 → None(⛔ 硬拿現貨)', parse_taifex_night(only_spot) is None)

    # 🕐 V82.4.2 美股還沒收盤(盤中)的判斷 —— 時間一律注入(⛔ 看機器現在幾點)
    U = lambda *a: datetime(*a, tzinfo=timezone.utc)
    ok('⑫a 11/16(平常時間 −5)18:28 UTC = 美東 13:28、同一天那格 → 盤中 13:28(11/16 每日採礦機延遲那一輪)',
       us_cash_intraday('2026-11-16', U(2026, 11, 16, 18, 28)) == '13:28', us_cash_intraday('2026-11-16', U(2026, 11, 16, 18, 28)))
    ok('⑫b 收完 + 緩衝:美東 16:10 還算盤中、16:25 就不是(11/17 台北 05:25 那輪 = 收盤)',
       us_cash_intraday('2026-11-16', U(2026, 11, 16, 21, 10)) == '16:10' and us_cash_intraday('2026-11-16', U(2026, 11, 16, 21, 25)) == '')
    ok('⑫c 美東開盤前(09:00)那格是前一天 → 不是盤中;同一天那格開盤前也不是',
       us_cash_intraday('2026-11-16', U(2026, 11, 17, 14, 0)) == '' and us_cash_intraday('2026-11-17', U(2026, 11, 17, 14, 0)) == '')
    ok('⑫d 週末 → 不是盤中(美股沒開)', us_cash_intraday('2026-11-14', U(2026, 11, 14, 18, 0)) == '')
    ok('⑫e 夏令(−4):7/15 17:28 UTC = 美東 13:28 → 盤中;13:00 UTC = 09:00 → 還沒開',
       us_cash_intraday('2026-07-15', U(2026, 7, 15, 17, 28)) == '13:28' and us_cash_intraday('2026-07-15', U(2026, 7, 15, 13, 0)) == '')
    ok('⑫f 夏令交界:2026 是 3/8 07:00 UTC 開始、11/1 06:00 UTC 結束(差 1 分鐘就換)',
       _et_offset_hours(U(2026, 3, 8, 6, 59)) == -5 and _et_offset_hours(U(2026, 3, 8, 7, 0)) == -4
       and _et_offset_hours(U(2026, 11, 1, 5, 59)) == -4 and _et_offset_hours(U(2026, 11, 1, 6, 0)) == -5)
    ok('⑫g 沒有日期 → 不判(⛔ 例外)', us_cash_intraday(None, U(2026, 11, 16, 18, 28)) == '' and us_cash_intraday('', U(2026, 11, 16, 18, 28)) == '')

    # 美元指數
    fx = {'EUR/USD': {'close': 1.16, 'prev': 1.17}, 'USD/JPY': {'close': 150.0, 'prev': 149.0}, 'GBP/USD': {'close': 1.33, 'prev': 1.34},
          'USD/CAD': {'close': 1.38, 'prev': 1.37}, 'USD/SEK': {'close': 9.5, 'prev': 9.4}, 'USD/CHF': {'close': 0.80, 'prev': 0.79}}
    now, prev, chg = dxy_from_fx(fx)
    ok('⑨ 美元指數照 ICE 公式算得出來(歐元變弱 → 指數變高)', now and prev and now > prev and chg > 0 and 90 < now < 110, (now, prev, chg))
    fx2 = dict(fx)
    del fx2['USD/SEK']
    ok('⑨b 少一個匯率 → 不算(⛔ 用 5 個硬湊)', dxy_from_fx(fx2) == (None, None, None))
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 {n[0]} 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else 0)
