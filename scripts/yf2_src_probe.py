#!/usr/bin/env python3
"""🔎 換掉 yfinance 第二階段:免金鑰的官方 / 公開來源在 GitHub Actions 上拿不拿得到、多新、什麼格式。

為什麼要有這支:使用者 11/15「推薦的繼續」(B + D + C)。Twelve Data 免費方案沒有指數 / VIX / 日經(td_plan 探針量過),
其中幾格有免金鑰的官方來源,要先確認(⚠️ 沙箱連不到這些網站 → 只能在 Actions 跑,log 說了算):
 ① VIX:芝加哥期權交易所(Cboe)官方每日 CSV —— 最後一列是哪天、伺服器說檔案什麼時候改的(趕不趕得上台北 08:00)
 ② FRED:日經 225 / 標普 / 那指 / 道瓊 / VIXCLS / WTI / 布蘭特 最新一筆是哪天(對照「晚幾天」)
 ③ 期交所 OpenAPI 期貨每日交易行情:台指期那幾列有哪些欄位、有沒有「交易時段(一般 / 盤後)」→ 夜盤能不能走官方
 ④ 比特幣(D 方案):Coinbase Exchange / Kraken 公開 API 日 K(免金鑰)

只讀:⛔ 不寫任何分支 / 資料檔;⛔ 不用金鑰;⛔ 偽裝瀏覽器(UA 寫明是誰);同一個主機間隔 ≥ 2 秒。
結論分三種(陷阱 #23):連不上 / 被擋(401、403、429、回 HTML)/ 有回但格式不同。

跑法:python3 scripts/yf2_src_probe.py [--selftest]
"""
import csv
import io
import json
import sys
import time
from datetime import datetime, timezone

UA = 'Mozilla/5.0 (compatible; StockAI-DB yf2_src_probe/1.0; +https://github.com/xin7355-collab/stockai-db)'
CBOE_VIX = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'
FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2026-10-01'
FRED_IDS = ['NIKKEI225', 'SP500', 'NASDAQCOM', 'DJIA', 'VIXCLS', 'DCOILWTICO', 'DCOILBRENTEU']
TAIFEX = 'https://openapi.taifex.com.tw/v1/DailyMarketReportFut'
COINBASE = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400'
KRAKEN = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440'


def last_rows_csv(text, n=2):
    """CSV 文字 → (表頭, 最後 n 列)。純函式。"""
    rows = [r for r in csv.reader(io.StringIO(text or '')) if r and any(c.strip() for c in r)]
    if not rows:
        return [], []
    return rows[0], rows[-n:] if len(rows) > 1 else []


def classify(code, body):
    if code in (401, 403, 429):
        return 'block', f'HTTP {code}'
    if code != 200:
        return 'fail', f'HTTP {code}'
    if (body or '').lstrip()[:1] == '<':
        return 'block', '回 HTML(擋頁 / 改版)'
    return 'ok', ''


def tx_rows(data):
    """期交所 OpenAPI 每日行情 → 台指期(TX)那幾列(⛔ 週契約)。純函式。"""
    out = []
    for r in data if isinstance(data, list) else []:
        if not isinstance(r, dict):
            continue
        c = str(r.get('Contract') or r.get('契約') or '').strip()
        if c in ('TX', 'TXF', '臺股期貨'):
            out.append(r)
    return out


CBOE_DQ = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/{sym}.json'
CBOE_SYMS = [x for x in (__import__('os').environ.get('CBOE_SYMS') or '_VIX,_SPX,_NDX,_DJX').split(',') if x]
TAIFEX_MIS = 'https://mis.taifex.com.tw/futures/api/getQuoteList'


def live(s, H):
    """⑤ Cboe 延遲報價(官網自己在用的公開 JSON)⑥ 期交所行情網夜盤(官方行情系統)—— 趕不趕得上台北 08:00 的關鍵。
    ⛔ 不帶 Referer / Origin、⛔ 偽裝瀏覽器;被擋(403 / 回 HTML)就記下來,⛔ 換方式再試。"""
    for sym in CBOE_SYMS:
        try:
            r = s.get(CBOE_DQ.format(sym=sym), headers=H, timeout=20)
            st, why = classify(r.status_code, r.text[:200])
            if st == 'ok':
                d = (r.json() or {}).get('data') or {}
                keep = {k: d.get(k) for k in ('symbol', 'current_price', 'prev_day_close', 'price_change',
                                              'price_change_percent', 'close', 'last_trade_time', 'tick')}
                print(f"⑤ Cboe {sym} ✅ {json.dumps(keep, ensure_ascii=False)} ・timestamp={(r.json() or {}).get('timestamp')}")
            else:
                print(f'⑤ Cboe {sym} ❌ {st}:{why}')
        except Exception as e:  # noqa: BLE001
            print(f'⑤ Cboe {sym} ❌ 連不上 / 格式不同 {type(e).__name__}')
        time.sleep(2)
    if __import__('os').environ.get('CBOE_ONLY'):
        return
    body = {"MarketType": "1", "SymbolType": "F", "KindID": "1", "CID": "TXF", "ExpireMonth": "",
            "RowSize": "全部", "PageNo": "", "SortColumn": "", "AscDesc": "A"}
    try:
        r = s.post(TAIFEX_MIS, json=body, headers={**H, 'Content-Type': 'application/json'}, timeout=20)
        st, why = classify(r.status_code, r.text[:200])
        if st == 'ok':
            j = r.json()
            rows = (((j or {}).get('RtData') or {}).get('QuoteList') or [])
            print(f"⑥ 期交所行情網(盤後)✅ RtCode={(j or {}).get('RtCode')} ・{len(rows)} 列 ・欄位 {list(rows[0].keys())[:40] if rows else []}")
            for row in rows[:3]:
                print('   ', json.dumps(row, ensure_ascii=False)[:500])
        else:
            print(f'⑥ 期交所行情網 ❌ {st}:{why} ・開頭 {r.text[:160]!r}')
    except Exception as e:  # noqa: BLE001
        print(f'⑥ 期交所行情網 ❌ 連不上 / 格式不同 {type(e).__name__}')


def main():
    import os
    import requests
    if os.environ.get('WHICH') == 'live':
        s = requests.Session()
        live(s, {'User-Agent': UA, 'Accept': '*/*'})
        return 0
    s = requests.Session()
    H = {'User-Agent': UA, 'Accept': '*/*'}
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    print(f'🕐 探針時間 {now}(週日 = 上一個美股交易日是週五)')

    def get(url, **kw):
        try:
            r = s.get(url, headers=H, timeout=25, **kw)
            st, why = classify(r.status_code, r.text[:200])
            return r, st, why
        except Exception as e:  # noqa: BLE001
            return None, 'fail', f'連不上 {type(e).__name__}'

    # ① Cboe VIX
    r, st, why = get(CBOE_VIX)
    if st == 'ok':
        head, last = last_rows_csv(r.text)
        print(f"① Cboe VIX ✅ 表頭 {head} ・最後兩列 {last} ・Last-Modified={r.headers.get('Last-Modified')} ・{len(r.text):,} bytes")
    else:
        print(f'① Cboe VIX ❌ {st}:{why}')
    time.sleep(2)
    # ② FRED
    for sid in FRED_IDS:
        r, st, why = get(FRED.format(sid=sid))
        if st == 'ok':
            head, last = last_rows_csv(r.text, 3)
            print(f'② FRED {sid:<13} ✅ 最後三筆 {last}')
        else:
            print(f'② FRED {sid:<13} ❌ {st}:{why}')
        time.sleep(2)
    # ③ 期交所 OpenAPI
    r, st, why = get(TAIFEX, )
    if st == 'ok':
        try:
            data = r.json()
            rows = tx_rows(data)
            keys = list(data[0].keys()) if data else []
            print(f'③ 期交所 OpenAPI ✅ {len(data)} 列 ・欄位 {keys}')
            sess_keys = [k for k in keys if any(w in k for w in ('Session', '時段', 'Trading'))]
            print(f'   → 像「交易時段」的欄位:{sess_keys or "沒有"}')
            for row in rows[:8]:
                print('   TX 列:', json.dumps(row, ensure_ascii=False)[:400])
        except ValueError:
            print('③ 期交所 OpenAPI ❌ 不是 JSON')
    else:
        print(f'③ 期交所 OpenAPI ❌ {st}:{why}')
    time.sleep(2)
    # ④ 比特幣
    r, st, why = get(COINBASE)
    if st == 'ok':
        try:
            j = r.json()
            print(f'④ Coinbase BTC-USD 日 K ✅ {len(j)} 根 ・最新兩根 [時間, 低, 高, 開, 收, 量] = {j[:2]}'
                  f" ・最新那根 UTC {datetime.fromtimestamp(j[0][0], timezone.utc):%Y-%m-%d}")
        except Exception as e:  # noqa: BLE001
            print(f'④ Coinbase 格式不同:{type(e).__name__} {r.text[:200]}')
    else:
        print(f'④ Coinbase ❌ {st}:{why}')
    time.sleep(2)
    r, st, why = get(KRAKEN)
    if st == 'ok':
        try:
            j = r.json()
            res = j.get('result') or {}
            k = next(x for x in res if x != 'last')
            rows = res[k]
            print(f'④ Kraken XBTUSD 日 K ✅ error={j.get("error")} ・{len(rows)} 根 ・最後兩根 {rows[-2:]}')
        except Exception as e:  # noqa: BLE001
            print(f'④ Kraken 格式不同:{type(e).__name__} {r.text[:200]}')
    else:
        print(f'④ Kraken ❌ {st}:{why}')
    return 0


def selftest():
    bad = []

    def ok(n, c, g=''):
        print(f"{'✅' if c else '❌'} {n}" + ('' if c else f' → {g}'))
        if not c:
            bad.append(n)
    h, last = last_rows_csv('DATE,OPEN,HIGH,LOW,CLOSE\n11/12/2026,18,19,17,18.5\n11/13/2026,18.5,20,18,18.8\n\n')
    ok('① CSV 最後兩列(空行不算)', h[0] == 'DATE' and last[-1][0] == '11/13/2026' and len(last) == 2, (h, last))
    ok('② 空的 CSV 不當掉', last_rows_csv('') == ([], []))
    ok('③ 403 = 被擋、回 HTML = 被擋', classify(403, '')[0] == 'block' and classify(200, '<html>')[0] == 'block')
    rows = tx_rows([{'Contract': 'TX', 'ContractMonth(Week)': '202612'}, {'Contract': 'MTX'}, {'Contract': 'TX '}, 'x'])
    ok('④ 只挑台指期那幾列', len(rows) == 2, rows)
    print(f"\n{'✅ 全過' if not bad else '❌ 失敗 ' + str(len(bad)) + ' 條'}")
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
