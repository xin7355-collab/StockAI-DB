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
    """FinMind API wrapper — returns data list or [] on failure.
    Always falls back to anonymous when token request returns any non-200 status."""
    def _try(use_token: bool):
        p = {'dataset': dataset, **params}
        if use_token and FINMIND_TOKEN:
            p['token'] = FINMIND_TOKEN
        for attempt in range(3):
            try:
                res = requests.get(BASE_URL, params=p, timeout=60)
                j = res.json()
                if j.get('status') == 200:
                    return j.get('data', [])
                msg = str(j.get('msg', '') or '')
                print(f"  ⚠️  FinMind {dataset} status={j.get('status')} msg={msg}")
                return None  # always signal fallback on any non-200
            except Exception as e:
                print(f"  ⚠️  FinMind {dataset} attempt {attempt+1} failed: {e}")
                time.sleep(5 * (attempt + 1))
        return None

    if FINMIND_TOKEN:
        result = _try(True)
        if result is None:
            print(f"  ↩️  FinMind {dataset} 失敗，改用匿名請求...")
            result = _try(False)
    else:
        result = _try(False)
    return result or []


def twse_institutional(date_str: str) -> dict:
    """TWSE MI_QFIIS：三大法人每日全市場買賣超，回傳 {stock_id: {foreign_net, trust_net, dealer_net}}。"""
    url = (f'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS'
           f'?response=json&date={date_str}&selectType=ALL')
    try:
        resp = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        j = resp.json()
        if j.get('stat') != 'OK':
            return {}
        fields = j.get('fields', [])
        # 找欄位索引
        def fi(kw):
            for i, f in enumerate(fields):
                if kw in f: return i
            return -1
        idx_id    = fi('證券代號')
        idx_fnet  = fi('外資及陸資淨')
        idx_tnet  = fi('投信淨')
        idx_dnet  = fi('自營商淨')
        if idx_id < 0: return {}
        result = {}
        for row in (j.get('data') or []):
            try:
                sid = str(row[idx_id]).strip()
                def to_int(idx):
                    if idx < 0 or idx >= len(row): return 0
                    return int(str(row[idx]).replace(',', '').replace('+', '') or 0)
                result[sid] = {
                    'foreign_net': to_int(idx_fnet),
                    'trust_net':   to_int(idx_tnet),
                    'dealer_net':  to_int(idx_dnet),
                }
            except Exception:
                continue
        return result
    except Exception as e:
        print(f"  ⚠️  TWSE MI_QFIIS {date_str} 失敗: {e}")
        return {}


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
    # TWSE 備援：FinMind 拿不到時，改抓 TWSE 官方每日全市場法人資料
    twse_inst: dict = {}  # {(date, stock_id): {foreign_net, trust_net, dealer_net}}
    if not inst_raw:
        print(f"  ↩️  FinMind 法人資料空，改從 TWSE MI_QFIIS 取得...")
        from datetime import datetime
        cur = datetime.strptime(start, '%Y-%m-%d').date()
        end_d = datetime.strptime(end, '%Y-%m-%d').date()
        while cur <= end_d:
            if cur.weekday() < 5:  # 只抓工作日
                d_str = cur.strftime('%Y%m%d')
                daily = twse_institutional(d_str)
                if daily:
                    for sid, v in daily.items():
                        twse_inst[(cur.strftime('%Y-%m-%d'), sid)] = v
                    print(f"    TWSE {d_str}: {len(daily)} 檔")
                time.sleep(0.5)
            cur += timedelta(days=1)

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
    # 合併 TWSE 備援資料
    for k, v in twse_inst.items():
        if k not in inst:
            inst[k] = v

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
        existing_map = {rec['date']: rec for rec in existing}

        changed = False
        for r in rows:
            raw_date = r['date']                         # "2024-01-02"
            fmt_date = raw_date.replace('-', '/')        # "2024/01/02"

            close = float(r.get('close', 0))
            if close == 0:
                continue

            chip_data = {
                'foreign_net': inst.get((raw_date, sym), {}).get('foreign_net', 0),
                'trust_net':   inst.get((raw_date, sym), {}).get('trust_net',   0),
                'dealer_net':  inst.get((raw_date, sym), {}).get('dealer_net',  0),
                'margin_balance': margin.get((raw_date, sym), {}).get('margin_balance', 0),
                'short_balance':  margin.get((raw_date, sym), {}).get('short_balance',  0),
            }

            if fmt_date in existing_map:
                # Patch existing record if it's missing chip fields
                if 'foreign_net' not in existing_map[fmt_date]:
                    existing_map[fmt_date].update(chip_data)
                    changed = True
                continue

            # New record
            rec = {
                'date':   fmt_date,
                'open':   float(r.get('open', close)),
                'high':   float(r.get('max',  close)),
                'low':    float(r.get('min',  close)),
                'close':  close,
                'volume': int(r.get('Trading_Volume', 0)),
                **chip_data,
            }
            existing_map[fmt_date] = rec
            changed = True

        if changed:
            combined = sorted(existing_map.values(), key=lambda x: x['date'])
            combined = combined[-800:]   # 保留約 3 年 (800 個交易日)
            save_json(sym, combined)
            updated += 1

    print(f"\n🎉 採礦完成！更新 {updated} 檔，略過 {len(by_sym)-updated} 檔（已是最新）。")

    # ── 補丁模式：TaiwanStockPrice 無新資料時，直接將 TWSE 法人資料 patch 進現有檔案 ──
    if not by_sym and inst:
        print(f"\n💉 價格資料為空，啟動法人欄位補丁模式（patch {len(inst)} 筆法人資料到現有檔案）...")
        patch_count = 0
        for f in Path(DATA_DIR).glob('*.json'):
            sym = f.stem
            if sym in ('radar',): continue
            existing = load_json(sym)
            if not existing: continue
            existing_map = {rec['date']: rec for rec in existing}
            changed = False
            for (raw_date, sid), chip_data in inst.items():
                if sid != sym: continue
                fmt_date = raw_date.replace('-', '/')
                if fmt_date in existing_map and 'foreign_net' not in existing_map[fmt_date]:
                    existing_map[fmt_date].update(chip_data)
                    changed = True
            if changed:
                combined = sorted(existing_map.values(), key=lambda x: x['date'])
                save_json(sym, combined)
                patch_count += 1
        print(f"  ✅ 法人補丁完成：{patch_count} 檔已更新法人欄位")


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
    - 第一盾：TWSE T86 直連（有真實券商名稱，同時建立代碼對照表）
    - 第二盾：FinMind 逐股查（T86 完全失敗時備用）
    - 附產出：broker_names.json（券商代碼->名稱全表，供前端顯示真名）
    - 滾動視窗：只保留最近 20 個交易日，超過自動刪除
    """
    chips_dir = Path(DATA_DIR) / 'chips'
    chips_dir.mkdir(parents=True, exist_ok=True)

    trading_days = get_trading_days(20)
    cutoff_str   = trading_days[0].strftime('%Y-%m-%d')
    today_str    = date.today().strftime('%Y-%m-%d')

    # 判斷哪些日期尚未有資料
    have_dates: set = set()
    for f in chips_dir.glob('*.json'):
        try:
            for rec in json.loads(f.read_text(encoding='utf-8')):
                have_dates.add(rec.get('date', ''))
        except Exception:
            break

    missing_days = [d for d in trading_days if d.strftime('%Y-%m-%d') not in have_dates]
    if not missing_days:
        print(f"\n分點籌碼已是最新，跳過（{cutoff_str} ~ {today_str}）")
        _prune_chips(chips_dir, cutoff_str)
        # 即使跳過，仍呼叫 T86 更新 broker_names.json（讓券商名稱顯示正確）
        _refresh_broker_names(chips_dir, trading_days[-1])
        return

    fetch_start = missing_days[0].strftime('%Y-%m-%d')
    print(f"\n分點籌碼採礦（{fetch_start} ~ {today_str}，{len(CHIP_WATCHLIST)} 檔監控清單）...")

    def _int(v):
        try: return int(str(v).replace(',', ''))
        except: return 0

    all_rows = []
    # 券商代碼->名稱累積對照表（從 T86 蒐集）
    broker_lookup: dict = {}

    # 載入既有對照表（合併累積）
    lookup_file = Path(DATA_DIR) / 'broker_names.json'
    if lookup_file.exists():
        try:
            broker_lookup = json.loads(lookup_file.read_text(encoding='utf-8'))
        except Exception:
            pass

    # 第一盾：TWSE T86 直連（有真實券商名稱）
    t86_headers = {'User-Agent': 'Mozilla/5.0 (compatible; StockBot/1.0)'}
    t86_total = 0
    for target_day in missing_days:
        day_str = target_day.strftime('%Y%m%d')
        day_iso = target_day.strftime('%Y-%m-%d')
        for sym in CHIP_WATCHLIST:
            try:
                url = (f'https://www.twse.com.tw/rwd/zh/fund/T86'
                       f'?response=json&date={day_str}&stock_no={sym}')
                resp = requests.get(url, headers=t86_headers, timeout=15)
                data = resp.json()
                if data.get('stat') == 'OK':
                    for row in (data.get('data') or []):
                        # T86: [序號, 券商代號, 券商名稱, 買進股數, 賣出股數, 買賣差]
                        if len(row) < 5:
                            continue
                        bid = str(row[1]).strip()
                        bnm = str(row[2]).strip()
                        if bid and bnm:
                            broker_lookup[bid] = bnm  # 累積對照表
                        all_rows.append({
                            'date':        day_iso,
                            'stock_id':    sym,
                            'broker_id':   bid,
                            'broker_name': bnm,
                            'buy':         _int(row[3]),
                            'sell':        _int(row[4]),
                        })
                        t86_total += 1
            except Exception as e:
                print(f"    T86 {sym} {day_str}: {e}")
            time.sleep(0.5)
    print(f"  TWSE T86 回傳 {t86_total} 筆（{len(missing_days)} 天 x {len(CHIP_WATCHLIST)} 檔）")

    # 第二盾：FinMind 逐股查（T86 完全沒資料時備用）
    if not all_rows and FINMIND_TOKEN:
        print(f"  T86 無資料，改用 FinMind 逐股查...")
        for sym in CHIP_WATCHLIST:
            rows = fm_get('TaiwanStockBrokerTrading',
                          data_id=sym, start_date=fetch_start, end_date=today_str)
            for r in rows:
                bid = str(r.get('broker_id', ''))
                bnm = str(r.get('broker_name', ''))
                if bid and bnm:
                    broker_lookup[bid] = bnm
                all_rows.append({
                    'date':        str(r.get('date', ''))[:10],
                    'stock_id':    str(r.get('stock_id', sym)),
                    'broker_id':   bid,
                    'broker_name': bnm or broker_lookup.get(bid, ''),
                    'buy':         _int(r.get('buy', 0)),
                    'sell':        _int(r.get('sell', 0)),
                })
            time.sleep(0.3)
        print(f"  FinMind 逐股回傳 {len(all_rows)} 筆（{len(CHIP_WATCHLIST)} 檔）")

    if not all_rows:
        print("  無分點資料，跳過")
        return

    # 儲存更新後的券商代碼對照表
    if broker_lookup:
        lookup_file.write_text(
            json.dumps(broker_lookup, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8'
        )
        print(f"  券商代碼對照表更新：{len(broker_lookup)} 筆")

    # 按股票代號分組
    by_sym_date: dict = {}
    for r in all_rows:
        sym   = str(r.get('stock_id', ''))
        d_str = str(r.get('date', ''))[:10]
        if not sym or not d_str or d_str < cutoff_str:
            continue
        key = (sym, d_str)
        bid = str(r.get('broker_id', ''))
        bnm = str(r.get('broker_name', '')) or broker_lookup.get(bid, '')
        by_sym_date.setdefault(key, []).append({
            'bid': bid,
            'bnm': bnm,
            'buy': int(r.get('buy', 0)),
            'sel': int(r.get('sell', 0)),
            'net': int(r.get('buy', 0)) - int(r.get('sell', 0)),
        })

    # 彙整每股每日前15買超/賣超，合併既有資料後寫檔
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
    print(f"  分點籌碼完成：寫入 {updated} 檔（{len(CHIP_WATCHLIST)} 檔監控清單）")


def _refresh_broker_names(chips_dir: Path, latest_day):
    """呼叫 TWSE T86 取得最新一天的券商名稱，更新 broker_names.json。"""
    lookup_file = Path(DATA_DIR) / 'broker_names.json'
    broker_lookup: dict = {}
    if lookup_file.exists():
        try:
            broker_lookup = json.loads(lookup_file.read_text(encoding='utf-8'))
        except Exception:
            pass

    day_str = latest_day.strftime('%Y%m%d')
    t86_headers = {'User-Agent': 'Mozilla/5.0 (compatible; StockBot/1.0)'}
    new_count = 0
    # 只取前幾檔熱門標的，快速建立名稱表
    sample = CHIP_WATCHLIST[:10]
    for sym in sample:
        try:
            url = (f'https://www.twse.com.tw/rwd/zh/fund/T86'
                   f'?response=json&date={day_str}&stock_no={sym}')
            resp = requests.get(url, headers=t86_headers, timeout=15)
            data = resp.json()
            if data.get('stat') == 'OK':
                for row in (data.get('data') or []):
                    if len(row) < 3: continue
                    bid = str(row[1]).strip()
                    bnm = str(row[2]).strip()
                    if bid and bnm and bid not in broker_lookup:
                        broker_lookup[bid] = bnm
                        new_count += 1
            time.sleep(0.3)
        except Exception:
            pass

    if broker_lookup:
        lookup_file.write_text(
            json.dumps(broker_lookup, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8'
        )
        print(f"  券商名稱對照表更新：共 {len(broker_lookup)} 筆（新增 {new_count} 筆）")


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
