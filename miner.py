"""
首席 AI 司令部 — 雲端籌碼採礦機
策略：每天只需 3 次 FinMind batch API 呼叫，即可更新全台 2000+ 檔
      OHLCV + 法人三大買賣超 + 融資融券，省流量、不被 Ban。
"""
import os
import json
import sqlite3
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

DB_PATH = "stock_hunter.db"

def init_db():
    """Create SQLite tables if they don't exist."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.executescript('''
        CREATE TABLE IF NOT EXISTS stock_history (
            symbol TEXT, trade_date TEXT, open REAL, high REAL, low REAL,
            close REAL, volume INTEGER, foreign_inv INTEGER, invest_trust INTEGER,
            dealer_inv INTEGER, margin_bal INTEGER,
            PRIMARY KEY (symbol, trade_date)
        );
        CREATE TABLE IF NOT EXISTS broker_chips (
            symbol TEXT, date TEXT, broker_id TEXT, broker_name TEXT,
            buy_vol INTEGER, sell_vol INTEGER, net_vol INTEGER,
            PRIMARY KEY (symbol, date, broker_id)
        );
        CREATE TABLE IF NOT EXISTS radar_results (
            strategy TEXT, symbol TEXT, close REAL, signal_date TEXT, extra_data TEXT,
            PRIMARY KEY (strategy, symbol)
        );
        CREATE TABLE IF NOT EXISTS market_macro (
            trade_date TEXT PRIMARY KEY,
            fi_net INTEGER, taiex_close REAL, taiex_chg_pct REAL,
            tpex_close REAL, tpex_chg_pct REAL,
            sp500_close REAL, sp500_chg_pct REAL,
            nasdaq_close REAL, nasdaq_chg_pct REAL,
            vix REAL, tsm_close REAL, tsm_chg_pct REAL
        );
    ''')
    conn.commit()
    conn.close()


def write_radar_to_db(results):
    """Write pre-computed radar signals to SQLite radar_results table."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    today = date.today().isoformat()
    c.execute("DELETE FROM radar_results")
    for strategy, items in results.items():
        for item in items:
            c.execute(
                "INSERT OR REPLACE INTO radar_results (strategy, symbol, close, signal_date, extra_data) VALUES (?,?,?,?,?)",
                (strategy, item['sym'], item.get('close', 0), today, json.dumps({k:v for k,v in item.items() if k != 'sym'}))
            )
    conn.commit()
    conn.close()
    print(f"  ✅ 雷達快取寫入 SQLite radar_results ({sum(len(v) for v in results.values())} 筆)")


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
    ‧ 第一盾：FinMind TaiwanStockBrokerTrading 批次（同 OHLCV 作法，一次拿全台股）
    ‧ 第二盾：Massive API → TWSE 逐日批次檔（一天一次請求，拿全市場）
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

    # ── 判斷已有哪些日期（避免重複下載）─────────────────────────────
    # 掃描現有所有 chips 檔案，找出已完整涵蓋的日期
    have_dates: set = set()
    for f in chips_dir.glob('*.json'):
        try:
            for rec in json.loads(f.read_text(encoding='utf-8')):
                have_dates.add(rec.get('date', ''))
        except Exception:
            break  # 任一檔出錯就重新全量更新

    missing_days = [d for d in trading_days if d.strftime('%Y-%m-%d') not in have_dates]
    if not missing_days:
        print(f"\n🔍 分點籌碼已是最新，跳過（{cutoff_str} ~ {today_str}）")
        _prune_chips(chips_dir, cutoff_str)
        return

    fetch_start = missing_days[0].strftime('%Y-%m-%d')
    print(f"\n🔍 分點籌碼批次採礦（{fetch_start} ~ {today_str}）全台股...")

    all_rows = []

    # ── 第一盾：FinMind 全台股批次（不帶 data_id，同 OHLCV 作法）──────
    if FINMIND_TOKEN:
        all_rows = fm_get('TaiwanStockBrokerTrading',
                          start_date=fetch_start, end_date=today_str)
        print(f"  FinMind 回傳 {len(all_rows)} 筆")

    # ── 第二盾：Massive API → TWSE 逐日批次（每天1次，涵蓋全市場）──
    if not all_rows and MASSIVE_API_KEY:
        for target_day in missing_days:
            day_str  = target_day.strftime('%Y%m%d')
            twse_url = (f'https://www.twse.com.tw/rwd/zh/fund/fundQueryDate'
                        f'?date={day_str}&response=json&selectType=ALLBUT0999')
            data = _massive_scrape(twse_url, MASSIVE_API_KEY)
            if data and data.get('stat') == 'OK':
                day_iso = target_day.strftime('%Y-%m-%d')
                def _int(v):
                    try: return int(str(v).replace(',', ''))
                    except: return 0
                for row in (data.get('data') or []):
                    if len(row) < 5:
                        continue
                    all_rows.append({
                        'date':        day_iso,
                        'stock_id':    str(row[0]),
                        'broker_id':   str(row[2]),
                        'broker_name': str(row[3]),
                        'buy':         _int(row[4]) if len(row) > 4 else 0,
                        'sell':        _int(row[5]) if len(row) > 5 else 0,
                    })
            time.sleep(1)  # TWSE 每日一請求，禮貌性間隔
        print(f"  Massive API 回傳 {len(all_rows)} 筆（{len(missing_days)} 天）")

    if not all_rows:
        print("  ⚠️  無分點資料，跳過")
        return

    # ── 按股票代號分組 ────────────────────────────────────────────────
    by_sym_date: dict = {}
    for r in all_rows:
        sym   = str(r.get('stock_id', ''))
        d_str = str(r.get('date', ''))[:10]
        if not sym or not d_str or d_str < cutoff_str:
            continue
        key = (sym, d_str)
        by_sym_date.setdefault(key, []).append({
            'bid': str(r.get('broker_id', '')),
            'bnm': str(r.get('broker_name', '')),
            'buy': int(r.get('buy', 0)),
            'sel': int(r.get('sell', 0)),
            'net': int(r.get('buy', 0)) - int(r.get('sell', 0)),
        })

    # ── 彙整每股每日前15買超/賣超，合併既有資料後寫檔 ───────────────
    keep   = {d.strftime('%Y-%m-%d') for d in trading_days}
    syms   = {k[0] for k in by_sym_date}
    updated = 0

    for sym in syms:
        out_file = chips_dir / f'{sym}.json'
        existing: dict = {}
        if out_file.exists():
            try:
                for rec in json.loads(out_file.read_text(encoding='utf-8')):
                    existing[rec['date']] = rec
            except Exception:
                pass

        for d_str in keep:
            brokers = by_sym_date.get((sym, d_str))
            if not brokers:
                continue
            buyers  = sorted([b for b in brokers if b['net'] > 0], key=lambda x: -x['net'])[:15]
            sellers = sorted([b for b in brokers if b['net'] < 0], key=lambda x:  x['net'])[:15]
            existing[d_str] = {
                'date':    d_str,
                'buyers':  buyers,
                'sellers': sellers,
                'tot_buy': sum(b['buy'] for b in brokers),
                'tot_sel': sum(b['sel'] for b in brokers),
            }

        final = sorted([v for k, v in existing.items() if k in keep], key=lambda x: x['date'])
        if final:
            out_file.write_text(json.dumps(final, ensure_ascii=False, separators=(',', ':')),
                                encoding='utf-8')
            updated += 1

    _prune_chips(chips_dir, cutoff_str)
    print(f"  ✅ 分點籌碼完成：寫入 {updated} 檔（全台股）")


def _prune_chips(chips_dir: Path, cutoff_str: str):
    """刪除各檔案中早於 cutoff_str 的紀錄，並移除空檔。"""
    for f in chips_dir.glob('*.json'):
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            pruned = [r for r in data if r.get('date', '') >= cutoff_str]
            if not pruned:
                f.unlink()
            elif len(pruned) != len(data):
                f.write_text(json.dumps(pruned, ensure_ascii=False, separators=(',', ':')),
                             encoding='utf-8')
        except Exception:
            pass


def _quick_ind(data):
    """Compute quick technical indicators for one stock (same logic as frontend)."""
    if len(data) < 22:
        return None
    closes = [d['close'] for d in data if isinstance(d.get('close'), (int, float))]
    vols   = [d.get('volume', 0) for d in data]
    if len(closes) < 22:
        return None
    ma  = lambda n, arr=closes: sum(arr[-n:]) / n
    pma = lambda n, arr=closes: sum(arr[-n-1:-1]) / n
    ma5, ma10, ma20 = ma(5), ma(10), ma(20)
    pma5, pma10, pma20 = pma(5), pma(10), pma(20)
    vma5 = sum(vols[-5:]) / 5 if vols else 0
    var20 = sum((c - ma20) ** 2 for c in closes[-20:]) / 20
    upper_bb = ma20 + 2 * var20 ** 0.5
    return {
        'close': closes[-1], 'prev_close': closes[-2],
        'ma5': ma5, 'ma10': ma10, 'ma20': ma20,
        'pma5': pma5, 'pma10': pma10, 'pma20': pma20,
        'vma5': vma5, 'upper_bb': upper_bb,
        'recent_vols': vols[-3:],
    }


def build_radar_cache():
    """
    Pre-compute radar signals for all saved stock JSONs.
    Outputs data/radar.json — frontend reads this instead of scanning one-by-one.
    """
    data_dir = Path(DATA_DIR)
    files = sorted(data_dir.glob('*.json'))
    results = {'bottom': [], 'surge': [], 'score': []}
    processed = 0

    for f in files:
        sym = f.stem
        if sym in ('radar',):
            continue
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not data or len(data) < 22:
            continue

        ind = _quick_ind(data)
        if not ind:
            continue
        processed += 1

        c, pc = ind['close'], ind['prev_close']
        ma5, ma10, ma20 = ind['ma5'], ind['ma10'], ind['ma20']
        pma5, pma10, pma20 = ind['pma5'], ind['pma10'], ind['pma20']
        vma5, upper_bb = ind['vma5'], ind['upper_bb']
        rv = ind['recent_vols']

        # 底部起漲：站上月線 or 黃金交叉 + 今日收紅
        crossed_ma20 = c > ma20 and pc <= pma20
        golden_cross = ma5 > ma10 and pma5 <= pma10
        if (crossed_ma20 or golden_cross) and c > pc:
            results['bottom'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2)})

        # 飆股動能：貼近布林上軌 + 連3日爆量
        near_upper = c >= upper_bb * 0.97
        vol_surge  = all(v > vma5 for v in rv) if rv and vma5 > 0 else False
        if near_upper and vol_surge:
            results['surge'].append({'sym': sym, 'close': round(c, 2), 'bb_upper': round(upper_bb, 2)})

        # 綜合強勢：多頭排列 + 爆量 + 收紅
        bullish  = c > ma20 and ma5 > ma10 and ma10 > ma20
        vol_ok   = rv[-1] > vma5 * 1.2 if rv and vma5 > 0 else False
        if bullish and vol_ok and c > pc:
            results['score'].append({'sym': sym, 'close': round(c, 2), 'ma5': round(ma5, 2)})

    out_path = data_dir / 'radar.json'
    out_path.write_text(
        json.dumps({'updated': date.today().isoformat(), 'data': results}, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8'
    )
    write_radar_to_db(results)
    total = sum(len(v) for v in results.values())
    print(f"  ✅ 雷達快取完成：掃描 {processed} 檔，底部 {len(results['bottom'])} / 飆股 {len(results['surge'])} / 綜合 {len(results['score'])} 檔 → data/radar.json")


if __name__ == '__main__':
    init_db()
    print("🚀 首席 AI 司令部 — 雲端籌碼採礦機")
    print(f"🔑 FinMind Token:  {'✅ 有' if FINMIND_TOKEN  else '⚠️  無'}")
    print(f"🔑 Massive API Key: {'✅ 有' if MASSIVE_API_KEY else '⚠️  無'}\n")
    run()
    fetch_futures_cache()
    fetch_us_macro_cache()
    fetch_broker_chips()
    build_radar_cache()
