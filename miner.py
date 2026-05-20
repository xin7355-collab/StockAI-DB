"""
首席 AI 司令部 — 雲端籌碼採礦機
策略：每天只需 3 次 FinMind batch API 呼叫，即可更新全台 2000+ 檔
      OHLCV + 法人三大買賣超 + 融資融券，省流量、不被 Ban。
"""
import os
import json
import requests
import time
from datetime import date, timedelta
from pathlib import Path

DATA_DIR = "data"
FINMIND_TOKEN = os.environ.get('FINMIND_TOKEN', '')
MASSIVE_API_KEY = os.environ.get('MASSIVE_API_KEY', '')
BASE_URL = 'https://api.finmindtrade.com/api/v4/data'

# ── 分點籌碼監控清單（對應前端雷達池，保持同步）────────────────────
CHIP_WATCHLIST = [
    # 上市熱門大將
    '2330','2317','2454','2382','3231','2303','2881','2886','2002','2603',
    '2308','3711','1301','1303','2801','2884','2885','2892','6505','1216',
    '2207','2301','2327','6415','2357','2395','3034','2379','2376','4938',
    # 上櫃活潑中小型
    '3105','3529','8069','5347','8299','3293','6142','6274',
    '6488','6515','6770','3037','8046','4977','6278','6191',
    # 高股息與權值 ETF
    '0050','0056','00878','00929','00919',
]
CHIP_WATCHLIST = sorted(set(CHIP_WATCHLIST))

Path(DATA_DIR).mkdir(exist_ok=True)


def fm_get(dataset, **params):
    """FinMind API wrapper — returns data list or [] on failure."""
    p = {'dataset': dataset, **params}
    if FINMIND_TOKEN:
        p['token'] = FINMIND_TOKEN
    for attempt in range(3):
        try:
            res = requests.get(BASE_URL, params=p, timeout=60)
            j = res.json()
            if j.get('status') == 200:
                return j.get('data', [])
            print(f"  ⚠️  FinMind {dataset} status={j.get('status')} msg={j.get('msg')}")
            return []
        except Exception as e:
            print(f"  ⚠️  FinMind {dataset} attempt {attempt+1} failed: {e}")
            time.sleep(5 * (attempt + 1))
    return []


def load_json(symbol):
    p = Path(DATA_DIR) / f"{symbol}.json"
    if p.exists():
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return []


def save_json(symbol, records):
    p = Path(DATA_DIR) / f"{symbol}.json"
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, separators=(',', ':'))


def run():
    today = date.today()
    # Fetch a rolling 15-day window so we catch any delayed settlement data
    start = (today - timedelta(days=15)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')

    # ── 1. OHLCV (全台股，一次拿完) ──────────────────────────────────
    print(f"📊 [1/3] TaiwanStockPrice {start}~{end} ...")
    prices = fm_get('TaiwanStockPrice', start_date=start, end_date=end)
    print(f"       {len(prices)} 筆")

    # ── 2. 法人三大買賣超 ──────────────────────────────────────────────
    print(f"🏦 [2/3] TaiwanStockInstitutionalInvestors {start}~{end} ...")
    inst_raw = fm_get('TaiwanStockInstitutionalInvestors', start_date=start, end_date=end)
    print(f"       {len(inst_raw)} 筆")

    # ── 3. 融資融券 ────────────────────────────────────────────────────
    print(f"💳 [3/3] TaiwanStockMarginPurchaseShortSale {start}~{end} ...")
    margin_raw = fm_get('TaiwanStockMarginPurchaseShortSale', start_date=start, end_date=end)
    print(f"       {len(margin_raw)} 筆")

    # ── Build lookup: (date_str, stock_id) ───────────────────────────
    inst = {}
    for r in inst_raw:
        k = (r['date'], r['stock_id'])
        if k not in inst:
            inst[k] = {'foreign_net': 0, 'trust_net': 0, 'dealer_net': 0}
        net = int(r.get('buy', 0)) - int(r.get('sell', 0))
        name = r.get('name', '')
        if '外資' in name:
            inst[k]['foreign_net'] = net
        elif '投信' in name:
            inst[k]['trust_net'] = net
        elif '自營' in name:
            inst[k]['dealer_net'] = net

    margin = {}
    for r in margin_raw:
        margin[(r['date'], r['stock_id'])] = {
            'margin_balance': int(r.get('MarginPurchaseToday', 0)),
            'short_balance':  int(r.get('ShortSaleToday', 0))
        }

    # ── Group prices by symbol ────────────────────────────────────────
    by_sym = {}
    for r in prices:
        sym = r['stock_id']
        by_sym.setdefault(sym, []).append(r)

    # ── Merge & save each symbol ──────────────────────────────────────
    print(f"\n💾 合併寫入 {len(by_sym)} 檔股票...")
    updated = 0
    for sym, rows in by_sym.items():
        existing = load_json(sym)
        existing_dates = {rec['date'] for rec in existing}

        new_recs = []
        for r in rows:
            raw_date = r['date']                         # "2024-01-02"
            fmt_date = raw_date.replace('-', '/')        # "2024/01/02"
            if fmt_date in existing_dates:
                continue

            close = float(r.get('close', 0))
            if close == 0:
                continue

            rec = {
                'date':   fmt_date,
                'open':   float(r.get('open', close)),
                'high':   float(r.get('max',  close)),
                'low':    float(r.get('min',  close)),
                'close':  close,
                'volume': int(r.get('Trading_Volume', 0)),
                # 法人籌碼
                'foreign_net': inst.get((raw_date, sym), {}).get('foreign_net', 0),
                'trust_net':   inst.get((raw_date, sym), {}).get('trust_net',   0),
                'dealer_net':  inst.get((raw_date, sym), {}).get('dealer_net',  0),
                # 融資融券
                'margin_balance': margin.get((raw_date, sym), {}).get('margin_balance', 0),
                'short_balance':  margin.get((raw_date, sym), {}).get('short_balance',  0),
            }
            new_recs.append(rec)

        if new_recs:
            combined = sorted(existing + new_recs, key=lambda x: x['date'])
            combined = combined[-800:]   # 保留約 3 年 (800 個交易日)
            save_json(sym, combined)
            updated += 1

    print(f"\n🎉 採礦完成！更新 {updated} 檔，略過 {len(by_sym)-updated} 檔（已是最新）。")


def fetch_futures_cache():
    """每日抓取外資台指期未平倉淨口數，存為 futures_cache.json 供前端讀取。"""
    today = date.today()
    start = (today - timedelta(days=10)).strftime('%Y-%m-%d')
    print(f"\n🔮 抓取外資台指期淨口數 {start}~{today} ...")
    rows = fm_get('TaiwanFuturesInstitutionalInvestors', data_id='TX', start_date=start)
    # 優先比對 FinMind 正式欄位 institutional_investors，再 fallback 舊版 name 欄
    foreign = [r for r in rows if
               r.get('institutional_investors') == '外資及陸資' or
               r.get('name') == '外資及陸資' or
               '外資' in r.get('institutional_investors', '') or
               '外資' in r.get('name', '')]
    if not foreign:
        all_names = list(set(r.get('institutional_investors', r.get('name', '?')) for r in rows[:10]))
        print(f"  ⚠️  無外資期貨資料，跳過寫入（共 {len(rows)} 筆，法人欄位值：{all_names}）")
        return
    last = foreign[-1]
    try:
        # 優先用直接淨口數欄位，再退回長短相減
        if last.get('open_interest_net_volume') is not None:
            net = int(last['open_interest_net_volume'])
        else:
            net = int(last.get('long_open_interest_balance', 0)) - int(last.get('short_open_interest_balance', 0))
    except (KeyError, ValueError) as e:
        print(f"  ⚠️  欄位解析失敗: {e}，原始資料: {last}")
        return
    long_val  = int(last.get('long_open_interest_balance', 0))
    short_val = int(last.get('short_open_interest_balance', 0))
    cache = {
        'date': last.get('date', today.strftime('%Y-%m-%d')),
        'fi_net': net,
        'long': long_val,
        'short': short_val,
        'generated': today.strftime('%Y-%m-%d'),
    }
    with open('futures_cache.json', 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    print(f"  ✅ 外資台指期淨口數: {net:+,} 口  ({cache['date']})")


def fetch_us_macro_cache():
    """抓取美股大盤與台積電 ADR 昨收資料，存為 macro_cache.json 供前端靜態讀取。"""
    try:
        import yfinance as yf
    except ImportError:
        print("\n⚠️  yfinance 未安裝，跳過美股快取（pip install yfinance）")
        return

    today = date.today()
    symbols = {
        'sp500':  '^GSPC',
        'nasdaq': '^NDX',
        'tsm':    'TSM',
        'dji':    '^DJI',
        'vix':    '^VIX',
    }
    print(f"\n🌐 抓取美股昨收資料（{today}）...")
    result = {}
    for key, ticker in symbols.items():
        try:
            hist = yf.Ticker(ticker).history(period='5d')
            if hist.empty:
                continue
            prev = hist.iloc[-2] if len(hist) >= 2 else hist.iloc[-1]
            last = hist.iloc[-1]
            result[key] = {
                'date':    str(last.name.date()),
                'close':   round(float(last['Close']), 2),
                'prev':    round(float(prev['Close']), 2),
                'chg_pct': round((float(last['Close']) - float(prev['Close'])) / float(prev['Close']) * 100, 2),
            }
            print(f"  {key}: {result[key]['close']} ({result[key]['chg_pct']:+.2f}%)")
        except Exception as e:
            print(f"  ⚠️  {ticker} 失敗: {e}")

    if not result:
        print("  ⚠️  美股資料全部失敗，跳過寫入")
        return

    result['generated'] = today.strftime('%Y-%m-%d')
    with open('macro_cache.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"  ✅ macro_cache.json 寫入完成（{len(result)-1} 個指標）")


def get_trading_days(n=20):
    """回傳最近 n 個交易日（跳過週末；不處理國定假日，容忍少量空值）"""
    days, d = [], date.today()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return sorted(days)


def _massive_scrape(url, api_key):
    """透過 Massive API residential IP 代爬目標 URL，回傳已解析的 dict 或 None。"""
    try:
        resp = requests.post(
            'https://api.massiveapi.com/v1/scrape',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json={'url': url, 'method': 'GET', 'anti_bot': True,
                  'proxy_type': 'residential', 'render_js': False},
            timeout=30
        )
        if resp.status_code != 200:
            print(f"  ⚠️  Massive API HTTP {resp.status_code}")
            return None
        outer = resp.json()
        # Massive API 可能將內容放在 body / content / html 欄位
        raw = outer.get('body') or outer.get('content') or outer.get('html') or ''
        if isinstance(raw, dict):
            return raw
        if raw:
            return json.loads(raw)
        return None
    except Exception as e:
        print(f"  ⚠️  Massive API 例外: {e}")
        return None


def fetch_broker_chips():
    """
    每天17:00後抓取分點籌碼，存入 data/chips/{sym}.json。
    ‧ 第一盾：FinMind TaiwanStockBrokerTrading（一次拿完整日期範圍，免逐日打）
    ‧ 第二盾：Massive API → TWSE 官方端點（residential IP，不被 Ban）
    ‧ 滾動視窗：只保留最近 20 個交易日，超過自動刪除
    """
    if not FINMIND_TOKEN and not MASSIVE_API_KEY:
        print("\n⚠️  FINMIND_TOKEN 與 MASSIVE_API_KEY 均未設定，跳過分點籌碼")
        return

    chips_dir = Path(DATA_DIR) / 'chips'
    chips_dir.mkdir(parents=True, exist_ok=True)

    trading_days = get_trading_days(20)
    cutoff_str   = trading_days[0].strftime('%Y-%m-%d')
    today_str    = date.today().strftime('%Y-%m-%d')

    # ── 自動剪枝：刪除超過 20 個交易日的舊檔 ─────────────────────────
    for f in chips_dir.glob('*.json'):
        try:
            existing_data = json.loads(f.read_text(encoding='utf-8'))
            pruned = [r for r in existing_data if r.get('date', '') >= cutoff_str]
            if len(pruned) != len(existing_data):
                f.write_text(json.dumps(pruned, ensure_ascii=False, separators=(',', ':')),
                             encoding='utf-8')
        except Exception:
            pass

    print(f"\n🔍 分點籌碼採礦（{cutoff_str} ~ {today_str}），監控 {len(CHIP_WATCHLIST)} 檔...")
    updated = 0

    for sym in CHIP_WATCHLIST:
        out_file = chips_dir / f'{sym}.json'

        # 載入既有資料，建立 date → record 字典
        existing: dict = {}
        if out_file.exists():
            try:
                for rec in json.loads(out_file.read_text(encoding='utf-8')):
                    existing[rec['date']] = rec
            except Exception:
                pass

        # 判斷需要補齊的最早日期
        missing = [d for d in trading_days if d.strftime('%Y-%m-%d') not in existing]
        if not missing:
            continue

        fetch_start = missing[0].strftime('%Y-%m-%d')
        rows = []

        # ── 第一盾：FinMind ────────────────────────────────────────────
        if FINMIND_TOKEN:
            rows = fm_get('TaiwanStockBrokerTrading',
                          data_id=sym, start_date=fetch_start, end_date=today_str)

        # ── 第二盾：Massive API → TWSE ────────────────────────────────
        if not rows and MASSIVE_API_KEY:
            start_twse = missing[0].strftime('%Y%m%d')
            end_twse   = today_str.replace('-', '')
            twse_url   = (f'https://www.twse.com.tw/rwd/zh/fund/fundQueryDate'
                          f'?stockNo={sym}&startDate={start_twse}&endDate={end_twse}&response=json')
            data = _massive_scrape(twse_url, MASSIVE_API_KEY)
            if data and data.get('stat') == 'OK':
                fields = data.get('fields', [])
                # TWSE 回傳整段期間的彙總（非逐日），以今天為日期掛上
                for row in (data.get('data') or []):
                    def _int(v):
                        try: return int(str(v).replace(',', ''))
                        except: return 0
                    rows.append({
                        'date':        today_str,
                        'stock_id':    sym,
                        'broker_id':   row[0] if len(row) > 0 else '',
                        'broker_name': row[1] if len(row) > 1 else '',
                        'buy':         _int(row[2]) if len(row) > 2 else 0,
                        'sell':        _int(row[3]) if len(row) > 3 else 0,
                    })

        if not rows:
            continue

        # ── 整理成每日前 15 買超 / 前 15 賣超 ────────────────────────
        by_date: dict = {}
        for r in rows:
            d_str = str(r.get('date', ''))[:10]
            if not d_str or d_str < cutoff_str:
                continue
            by_date.setdefault(d_str, []).append({
                'bid': str(r.get('broker_id', '')),
                'bnm': str(r.get('broker_name', '')),
                'buy': int(r.get('buy', 0)),
                'sel': int(r.get('sell', 0)),
                'net': int(r.get('buy', 0)) - int(r.get('sell', 0)),
            })

        for d_str, brokers in by_date.items():
            buyers  = sorted([b for b in brokers if b['net'] > 0], key=lambda x: -x['net'])[:15]
            sellers = sorted([b for b in brokers if b['net'] < 0], key=lambda x:  x['net'])[:15]
            existing[d_str] = {
                'date':    d_str,
                'buyers':  buyers,
                'sellers': sellers,
                'tot_buy': sum(b['buy'] for b in brokers),
                'tot_sel': sum(b['sel'] for b in brokers),
            }

        # 只保留 trading_days 範圍內的日期
        keep = {d.strftime('%Y-%m-%d') for d in trading_days}
        final = sorted([v for k, v in existing.items() if k in keep], key=lambda x: x['date'])

        out_file.write_text(json.dumps(final, ensure_ascii=False, separators=(',', ':')),
                            encoding='utf-8')
        updated += 1
        time.sleep(0.3)  # 禮貌性間隔

    print(f"  ✅ 分點籌碼完成：更新 {updated}/{len(CHIP_WATCHLIST)} 檔")


if __name__ == '__main__':
    print("🚀 首席 AI 司令部 — 雲端籌碼採礦機")
    print(f"🔑 FinMind Token:  {'✅ 有' if FINMIND_TOKEN  else '⚠️  無'}")
    print(f"🔑 Massive API Key: {'✅ 有' if MASSIVE_API_KEY else '⚠️  無'}\n")
    run()
    fetch_futures_cache()
    fetch_us_macro_cache()
    fetch_broker_chips()
