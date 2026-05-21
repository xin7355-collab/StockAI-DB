"""
首席 AI 司令部 — 雲端籌碼採礦機 (方案 A 完全體 + 備援強化版)
策略：
  1. 動態清單：CHIP_WATCHLIST 基礎 + data/ 中使用者自行新增的個股
  2. 個股精準狙擊：每股獨立 API 呼叫 (data_id=sym)，完美繞過批次限制
  3. TWSE MI_QFIIS 備援：FinMind 三大法人空值時自動切換官方資料
  4. TAIFEX 備援：外資期貨 FinMind 回零時改爬 TAIFEX 官網
  5. 多 Token 彈匣：FINMIND_TOKENS 逗號分隔，自動輪替不中斷
  6. 30 天滾動視窗：分點籌碼超期自動裁切
  7. 籌碼戰術分點：小哥邏輯完全體（隔日沖、外資、權證總公司、波段抄底）
"""
import os
import json
import re
import sqlite3
import requests
import time
from datetime import date, timedelta
from pathlib import Path

DATA_DIR = "data"
BASE_URL  = 'https://api.finmindtrade.com/api/v4/data'
MASSIVE_API_KEY = os.environ.get('MASSIVE_API_KEY', '')

# ── 多 Token 彈匣：支援 FINMIND_TOKENS（逗號分隔）或舊版 FINMIND_TOKEN ──
_raw = os.environ.get('FINMIND_TOKENS', '') or os.environ.get('FINMIND_TOKEN', '')
FINMIND_TOKENS: list = [t.strip() for t in _raw.split(',') if t.strip()] if _raw else []

# ── 基礎監控清單（方案 A 種子；data/ 中的使用者個股會自動附加）────────────
CHIP_WATCHLIST = sorted(set([
    '2330','2317','2454','2382','3231','2303','2881','2886','2002','2603',
    '2308','3711','1301','1303','2801','2884','2885','2892','6505','1216',
    '2207','2301','2327','6415','2357','2395','3034','2379','2376','4938',
    '3105','3529','8069','5347','8299','3293','6142','6274',
    '6488','6515','6770','3037','8046','4977','6278','6191',
    '0050','0056','00878','00929','00919',
]))

Path(DATA_DIR).mkdir(exist_ok=True)
DB_PATH = "stock_hunter.db"


# ── 資料庫 ─────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.executescript('''
        CREATE TABLE IF NOT EXISTS stock_history (
            symbol TEXT, trade_date TEXT, open REAL, high REAL, low REAL,
            close REAL, volume INTEGER, foreign_inv INTEGER, invest_trust INTEGER,
            dealer_inv INTEGER, margin_bal INTEGER, short_bal INTEGER,
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
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    today = date.today().isoformat()
    c.execute("DELETE FROM radar_results")
    for strategy, items in results.items():
        for item in items:
            c.execute(
                "INSERT OR REPLACE INTO radar_results VALUES (?,?,?,?,?)",
                (strategy, item['sym'], item.get('close', 0), today,
                 json.dumps({k: v for k, v in item.items() if k != 'sym'}))
            )
    conn.commit()
    conn.close()
    print(f"  ✅ 雷達寫入 SQLite（{sum(len(v) for v in results.values())} 筆）")


# ── FinMind API（多 Token 輪替 + 匿名 fallback）────────────────────────────
def fm_get(dataset, **params):
    """FinMind API 核心引擎：多 Token 自動輪替，全部失敗改匿名。"""
    def _try(token: str):
        p = {'dataset': dataset, **params}
        if token:
            p['token'] = token
        for attempt in range(3):
            try:
                res = requests.get(BASE_URL, params=p, timeout=60)
                j   = res.json()
                msg = str(j.get('msg', '') or '').lower()
                if res.status_code == 429 or 'limit' in msg:
                    return 'RATE_LIMITED'
                if j.get('status') == 200:
                    return j.get('data', [])
                print(f"  ⚠️  FinMind {dataset} status={j.get('status')} msg={msg[:80]}")
                return None
            except Exception as e:
                print(f"  ⚠️  FinMind {dataset} attempt {attempt+1}: {e}")
                time.sleep(5 * (attempt + 1))
        return None

    # 逐一嘗試所有 Token
    for tok in FINMIND_TOKENS:
        result = _try(tok)
        if result == 'RATE_LIMITED':
            print(f"  🔄 Token 額度耗盡，嘗試下一把...")
            continue
        if result is not None:
            return result

    # 所有 Token 耗盡或無 Token → 匿名
    if FINMIND_TOKENS:
        print(f"  ↩️  所有 Token 失敗，改用匿名...")
    result = _try('')
    if result in ('RATE_LIMITED', None):
        return []
    return result or []


# ── TWSE 備援：三大法人每日全市場（免費，不需帳號）────────────────────────
def twse_institutional(date_str: str) -> dict:
    """TWSE MI_QFIIS 全市場法人資料。date_str: 'YYYYMMDD'。"""
    url = (f'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS'
           f'?response=json&date={date_str}&selectType=ALL')
    try:
        resp = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        j = resp.json()
        if j.get('stat') != 'OK':
            return {}
        fields = j.get('fields', [])
        def fi(kw):
            for i, f in enumerate(fields):
                if kw in f: return i
            return -1
        idx_id   = fi('證券代號')
        idx_fnet = fi('外資及陸資淨')
        idx_tnet = fi('投信淨')
        idx_dnet = fi('自營商淨')
        if idx_id < 0:
            return {}
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


# ── TAIFEX 備援：外資期貨未平倉淨口數（免費，不需帳號）──────────────────
def taifex_tx_net(target_date) -> int | None:
    """TAIFEX TX 外資未平倉淨口數。target_date: date object。"""
    try:
        date_slash = target_date.strftime('%Y/%m/%d')
        url  = 'https://www.taifex.com.tw/cht/3/futContractsDate'
        form = {'queryType': '1', 'marketCode': '0', 'contractCode': 'TX',
                'dateaddcnt': '0', 'queryDate': date_slash}
        hdrs = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
                'Referer': url, 'Accept-Encoding': 'gzip, deflate, br'}
        r = requests.post(url, data=form, headers=hdrs, timeout=30)
        r.raise_for_status()
        rows_html = re.findall(r'<tr[^>]*>(.*?)</tr>', r.text, re.DOTALL)
        for row_html in rows_html:
            if '外資及陸資' not in row_html:
                continue
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row_html, re.DOTALL)
            nums = []
            for c in cells:
                val = re.sub(r'<[^>]+>', '', c).strip().replace(',', '').replace('+', '')
                if val.lstrip('-').isdigit() and len(val.lstrip('-')) >= 2:
                    nums.append(int(val))
            print(f'  🔍 TAIFEX 外資TX數字序列: {nums}')
            # 欄位順序：多方口數, 多方金額, 空方口數, 空方金額, 淨多空口數, 淨多空金額
            if len(nums) >= 5:
                return nums[4]
            if len(nums) >= 3:
                return nums[0] - nums[2]
        print('  ⚠️  TAIFEX: 找不到外資及陸資 TX 資料')
        return None
    except Exception as e:
        print(f'  ⚠️  TAIFEX TX fallback 失敗: {e}')
        return None


# ── JSON 讀寫 ───────────────────────────────────────────────────────────────
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


# ── 動態監控清單 ────────────────────────────────────────────────────────────
def get_active_symbols():
    """
    方案 A 核心：CHIP_WATCHLIST 種子 + data/ 中使用者自行新增的個股。
    上限 100 檔，避免 API 呼叫爆炸。
    """
    base  = set(CHIP_WATCHLIST)
    extra = set()
    skip  = {'radar', 'futures_cache', 'macro_cache', 'broker_names'}
    for f in Path(DATA_DIR).glob('*.json'):
        if f.stem not in skip and f.stem not in base:
            extra.add(f.stem)
    # 保留最多 50 個額外個股（使用者新增）
    return sorted(base | set(sorted(extra)[:50]))


# ── 主採礦：個股精準狙擊 + TWSE 備援 ───────────────────────────────────────
def run():
    """
    方案 A 精準採礦：每股獨立呼叫 data_id=sym，完美繞過批次配額限制。
    FinMind 三大法人空值時自動啟用 TWSE MI_QFIIS 備援（只抓一次，多股共用）。
    """
    today = date.today()
    start = (today - timedelta(days=30)).strftime('%Y-%m-%d')
    end   = today.strftime('%Y-%m-%d')

    watchlist = get_active_symbols()
    print(f"\n🎯 偵測到 {len(watchlist)} 檔個股，執行精準採礦（{start}~{end}）...")

    # TWSE MI_QFIIS 批次備援快取（懶載入：第一個需要時才抓，之後所有股票共用）
    twse_cache: dict = {}   # {(date_str, symbol): {foreign_net, trust_net, dealer_net}}
    twse_fetched = False

    def _load_twse_if_needed():
        nonlocal twse_fetched
        if twse_fetched:
            return
        twse_fetched = True
        print(f"  ↩️  啟用 TWSE MI_QFIIS 批次備援（{start}~{end}）...")
        from datetime import datetime as dt_cls
        cur   = dt_cls.strptime(start, '%Y-%m-%d').date()
        end_d = dt_cls.strptime(end,   '%Y-%m-%d').date()
        total = 0
        while cur <= end_d:
            if cur.weekday() < 5:
                d_str = cur.strftime('%Y%m%d')
                daily = twse_institutional(d_str)
                if daily:
                    for sid, v in daily.items():
                        twse_cache[(cur.strftime('%Y-%m-%d'), sid)] = v
                    total += len(daily)
                time.sleep(0.5)
            cur += timedelta(days=1)
        print(f"  TWSE 備援完成：{total} 筆")

    updated_total = 0
    for idx, sym in enumerate(watchlist):
        print(f"  🛰️  [{idx+1}/{len(watchlist)}] {sym} ...", end=' ', flush=True)

        prices_raw = fm_get('TaiwanStockPrice',
                            data_id=sym, start_date=start, end_date=end)
        inst_raw   = fm_get('TaiwanStockInstitutionalInvestors',
                            data_id=sym, start_date=start, end_date=end)
        margin_raw = fm_get('TaiwanStockMarginPurchaseShortSale',
                            data_id=sym, start_date=start, end_date=end)

        # 若 FinMind 三大法人回空，啟動 TWSE 批次備援（只抓一次）
        if not inst_raw:
            _load_twse_if_needed()

        # 建立法人查詢表 {date_str: {foreign_net, trust_net, dealer_net}}
        inst: dict = {}
        for r in inst_raw:
            dt_s = r['date']
            if dt_s not in inst:
                inst[dt_s] = {'foreign_net': 0, 'trust_net': 0, 'dealer_net': 0}
            net  = int(r.get('buy', 0)) - int(r.get('sell', 0))
            name = r.get('name', '')
            if   '外資' in name: inst[dt_s]['foreign_net'] = net
            elif '投信' in name: inst[dt_s]['trust_net']   = net
            elif '自營' in name: inst[dt_s]['dealer_net']  = net
        # 補入 TWSE 備援
        for (dt_s, sid), v in twse_cache.items():
            if sid == sym and dt_s not in inst:
                inst[dt_s] = v

        # 融資融券查詢表
        margin: dict = {}
        for r in margin_raw:
            margin[r['date']] = {
                'margin_balance': int(r.get('MarginPurchaseToday', 0)),
                'short_balance':  int(r.get('ShortSaleToday', 0)),
            }

        # 合併現有資料
        existing     = load_json(sym)
        existing_map = {rec['date']: rec for rec in existing}
        changed = False

        for r in prices_raw:
            raw_date = r['date']
            fmt_date = raw_date.replace('-', '/')
            close    = float(r.get('close', 0))
            if close == 0:
                continue

            chip_data = {
                'foreign_net':    inst.get(raw_date, {}).get('foreign_net', 0),
                'trust_net':      inst.get(raw_date, {}).get('trust_net',   0),
                'dealer_net':     inst.get(raw_date, {}).get('dealer_net',  0),
                'margin_balance': margin.get(raw_date, {}).get('margin_balance', 0),
                'short_balance':  margin.get(raw_date, {}).get('short_balance',  0),
            }

            if fmt_date in existing_map:
                if 'foreign_net' not in existing_map[fmt_date]:
                    existing_map[fmt_date].update(chip_data)
                    changed = True
                continue

            existing_map[fmt_date] = {
                'date':   fmt_date,
                'open':   float(r.get('open', close)),
                'high':   float(r.get('max',  close)),
                'low':    float(r.get('min',  close)),
                'close':  close,
                'volume': int(r.get('Trading_Volume', 0)),
                **chip_data,
            }
            changed = True

        # 補丁模式：TaiwanStockPrice 無新資料但有 TWSE 法人資料時，直接 patch 現有記錄
        if not prices_raw and inst:
            for dt_s, chip_data in inst.items():
                fmt_date = dt_s.replace('-', '/')
                if fmt_date in existing_map and 'foreign_net' not in existing_map[fmt_date]:
                    existing_map[fmt_date].update(chip_data)
                    changed = True

        if changed:
            combined = sorted(existing_map.values(), key=lambda x: x['date'])
            combined = combined[-800:]
            save_json(sym, combined)
            # 同步 SQLite
            try:
                conn = sqlite3.connect(DB_PATH)
                c    = conn.cursor()
                for nr in combined[-5:]:   # 只寫最新 5 筆，避免太慢
                    dt_s = nr['date'].replace('/', '-')
                    c.execute(
                        "INSERT OR REPLACE INTO stock_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (sym, dt_s, nr.get('open'), nr.get('high'), nr.get('low'),
                         nr.get('close'), nr.get('volume'),
                         nr.get('foreign_net', 0), nr.get('trust_net', 0),
                         nr.get('dealer_net', 0),  nr.get('margin_balance', 0),
                         nr.get('short_balance', 0))
                    )
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"\n    ⚠️ SQLite 寫入 {sym}: {e}")
            updated_total += 1
            print("✅")
        else:
            print("skip")

        time.sleep(0.3)

    print(f"\n🎉 精準採礦完畢：更新 {updated_total}/{len(watchlist)} 檔。")


# ── 外資期貨（FinMind → TAIFEX 備援，全零不覆寫）──────────────────────────
def fetch_futures_cache():
    """外資台指期未平倉淨口數。FinMind → TAIFEX 備援。全部失敗保留舊快取。"""
    today = date.today()
    start = (today - timedelta(days=10)).strftime('%Y-%m-%d')
    print(f"\n🔮 抓取外資台指期淨口數 {start}~{today} ...")

    net, long_val, short_val, last_date = None, 0, 0, today.strftime('%Y-%m-%d')

    # 1. FinMind
    rows    = fm_get('TaiwanFuturesInstitutionalInvestors', data_id='TX', start_date=start)
    foreign = [r for r in rows if
               '外資' in r.get('institutional_investors', '') or
               '外資' in r.get('name', '')]
    if foreign:
        last      = foreign[-1]
        last_date = last.get('date', last_date)
        lv = int(last.get('long_open_interest_balance',  0))
        sv = int(last.get('short_open_interest_balance', 0))
        nv = last.get('open_interest_net_volume')
        calc = int(nv) if nv is not None else (lv - sv)
        print(f'  FinMind 外資TX: long={lv:,} short={sv:,} net={calc:+,}')
        if calc != 0 or lv != 0 or sv != 0:
            net, long_val, short_val = calc, lv, sv
        else:
            print(f'  ⚠️  FinMind 全零（匿名層無餘額欄位），改用 TAIFEX...')
    else:
        names = list(set(r.get('institutional_investors', r.get('name', '?')) for r in rows[:5]))
        print(f'  ⚠️  FinMind 無外資列（{len(rows)} 筆，名稱: {names}），改用 TAIFEX...')

    # 2. TAIFEX 直連備援
    if net is None:
        target = today - timedelta(days=1)
        while target.weekday() >= 5:   # 跳過週末
            target -= timedelta(days=1)
        taifex_net = taifex_tx_net(target)
        if taifex_net is not None:
            net, last_date = taifex_net, target.strftime('%Y-%m-%d')
            print(f'  ✅ TAIFEX TX 外資淨口數: {net:+,} 口  ({last_date})')
        else:
            print(f'  ⚠️  TAIFEX 也失敗，保留舊快取不覆寫')
            return

    cache = {'date': last_date, 'fi_net': net, 'long': long_val,
             'short': short_val, 'generated': today.strftime('%Y-%m-%d')}
    with open('futures_cache.json', 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    print(f"  ✅ 外資台指期淨口數: {net:+,} 口  ({last_date})")


# ── 美股大盤快取 ────────────────────────────────────────────────────────────
def fetch_us_macro_cache():
    try:
        import yfinance as yf
    except ImportError:
        print("\n⚠️  yfinance 未安裝，跳過美股快取")
        return
    today   = date.today()
    symbols = {'sp500': '^GSPC', 'nasdaq': '^NDX', 'tsm': 'TSM',
               'dji': '^DJI', 'vix': '^VIX'}
    print(f"\n🌐 抓取美股昨收資料（{today}）...")
    result  = {}
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
                'chg_pct': round((float(last['Close']) - float(prev['Close'])) /
                                  float(prev['Close']) * 100, 2),
            }
            print(f"  {key}: {result[key]['close']} ({result[key]['chg_pct']:+.2f}%)")
        except Exception as e:
            print(f"  ⚠️  {ticker}: {e}")
    if not result:
        return
    result['generated'] = today.strftime('%Y-%m-%d')
    with open('macro_cache.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"  ✅ macro_cache.json（{len(result)-1} 指標）")


# ── 分點籌碼 ────────────────────────────────────────────────────────────────
def get_trading_days(n=30):
    """最近 n 個交易日（跳週末）"""
    days, d = [], date.today()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return sorted(days)


def get_all_taiwan_brokers() -> dict:
    """
    動態下載全台券商分點名冊。
    優先線上 FinMind，失敗時用本地快取，最後追加戰術標籤。
    """
    broker_map: dict = {}

    # 先載入本地快取
    lookup_file = Path(DATA_DIR) / 'broker_names.json'
    if lookup_file.exists():
        try:
            broker_map = json.loads(lookup_file.read_text(encoding='utf-8'))
        except Exception:
            pass

    # 嘗試線上下載（匿名即可）
    try:
        url = f"{BASE_URL}?dataset=TaiwanBrokerList"
        res = requests.get(url, timeout=15)
        if res.status_code == 200:
            for item in res.json().get('data', []):
                b_id = str(item.get('broker_id', '')).strip()
                b_nm = str(item.get('broker_name', '')).strip()
                if b_id and b_nm:
                    broker_map[b_id] = b_nm
            if broker_map:
                print(f"  🏢 線上下載 {len(broker_map)} 家券商名冊")
    except Exception as e:
        print(f"  ⚠️  線上券商清單失敗: {e}")

    # =====================================================================
    # 🎯 籌碼小哥戰術分點庫 (完全體版)
    # =====================================================================
    TACTICAL_TAGS = {
        # 🚀 【一級戰區：極度兇狠隔日沖大戶】(看到大量買進，隔天追高必死)
        '9268': '凱基-台北(🔥全台最大最兇隔日沖)',
        '984e': '元大-土城永寧(⚡極速隔日沖/常鎖漲停)',
        '700b': '富邦-建國(🏹隔日沖大戶/常跟土城永寧聯手)',
        '9211': '凱基-松山(🔥虎爺/知名當沖隔日沖)',
        '7004': '富邦-嘉義(⚡傳統中南部老牌隔日沖)',
        '075a': '康和-永和(⚡知名隔日沖/喜歡鎖漲停)',
        '9a08': '永豐金-三重(⚡短線暴力隔日沖)',
        '8881': '國泰-敦南(⚡短線隔日沖大戶)',
        '585d': '統一-城中(⚡短線主力)',
        '9216': '凱基-信義(⚡隔日沖大戶)',
        '9132': '群益金鼎-東門(⚡短線大戶)',
        
        # 🛸 【外資皮台資骨 / 外資短線隔日沖客】
        '1480': '美商美林(⚡外資最大隔日沖/常大買大賣)',
        '8440': '摩根大通(⚡小摩/外資極速短線客)',
        '1560': '港商野村(⚡外資短線/常跟美林聯手)',
        '1520': '美商高盛(🏛️波段與短線交錯)',
        '1470': '台灣摩根士丹利(🏛️大摩/外資波段指標)',
        
        # 🧙‍♂️ 【權證小哥核心：發行商避險分點】(主力大買權證，發行商被迫買現股的足跡)
        '9800': '元大-總公司(🛡️權證最大避險分點)',
        '9200': '凱基-總公司(🛡️權證避險)',
        '7000': '富邦-總公司(🛡️權證避險)',
        '9100': '群益金鼎-總公司(🛡️權證避險)',
        '5850': '統一-總公司(🛡️權證避險)',
        '8880': '國泰-總公司(🛡️權證避險)',
        '5920': '元富-總公司(🛡️權證避險)',
        '7750': '兆豐-總公司(🛡️權證避險)',
        '9A00': '永豐金-總公司(🛡️權證避險)',
        
        # 🎯 【高勝率波段神人 / 地緣大戶抄底】(右側打底翻揚的關鍵觀察指標)
        '9130': '群益金鼎-大安(🧙‍♂️小哥常提/波段高勝率大戶)',
        '9240': '凱基-板橋(🧙‍♂️短線與波段高手/擅長低接)',
        '1260': '宏遠-綜合(🧙‍♂️特定主力/波段發動點)',
        '9A14': '永豐金-忠孝(🧙‍♂️波段操作勝率極高)',
        '7002': '富邦-台南(🧙‍♂️傳說中低買高賣抄底王)',
        '5380': '盈溢-綜合(🧙‍♂️神祕低調大戶/眼光精準)',
        '9203': '凱基-市政(🐋中台灣超級大鯨魚)',
        '9282': '凱基-復興(🎯關鍵波段大戶)',
        '1020': '合庫-綜合(🎯神祕波段大戶)',
        
        # 🏛️ 【國家隊護盤 / 八大官股】(大跌時的定海神針，右側建倉的底氣來源)
        '1040': '臺銀-證券(🛡️官股護盤大哥)',
        '5360': '第一金-綜合(🛡️八大官股)',
        '2810': '彰化銀行(🛡️八大官股)',
        '5440': '華南永昌-綜合(🛡️八大官股)',
        '0040': '臺灣銀行(🛡️八大官股)', 
        '7750': '兆豐-綜合(🛡️八大官股)',
        '5700': '合庫-綜合(🛡️八大官股)',
        '5380': '台企銀-綜合(🛡️八大官股)',
    }
    broker_map.update(TACTICAL_TAGS)
    return broker_map


def fetch_broker_chips():
    """
    分點籌碼採礦：30 天滾動視窗。
    第一盾：FinMind 全市場批次（有 token 才用，一次拿完最快）
    第二盾：FinMind 逐日全市場（批次失敗時）
    第三盾：TWSE T86 直連（完全無 token 時最後防線）
    """
    chips_dir = Path(DATA_DIR) / 'chips'
    chips_dir.mkdir(parents=True, exist_ok=True)

    trading_days = get_trading_days(30)
    cutoff_str   = trading_days[0].strftime('%Y-%m-%d')
    today_str    = date.today().strftime('%Y-%m-%d')

    have_dates: set = set()
    for f in chips_dir.glob('*.json'):
        try:
            for rec in json.loads(f.read_text(encoding='utf-8')):
                have_dates.add(rec.get('date', ''))
        except Exception:
            pass

    missing_days = [d for d in trading_days if d.strftime('%Y-%m-%d') not in have_dates]

    if not missing_days:
        print(f"\n分點籌碼已是最新（{cutoff_str} ~ {today_str}）")
        _prune_chips(chips_dir, cutoff_str)
        _refresh_broker_names(chips_dir, trading_days[-1])
        return

    fetch_start = missing_days[0].strftime('%Y-%m-%d')
    print(f"\n分點籌碼採礦（{fetch_start}~{today_str}，{len(missing_days)} 個交易日）...")

    # 動態載入全台券商名冊（線上 + 本地快取 + 戰術標籤）
    ALL_BROKERS   = get_all_taiwan_brokers()
    broker_lookup = dict(ALL_BROKERS)
    print(f"  🏢 券商名冊 {len(ALL_BROKERS)} 筆已就緒")

    def _int(v):
        try: return int(str(v).replace(',', ''))
        except: return 0

    def _parse_rows(rows, fallback_sym=''):
        out = []
        for r in rows:
            bid      = str(r.get('broker_id', '')).strip()
            raw_name = str(r.get('broker_name', '')).strip()
            bnm = ALL_BROKERS.get(bid) or (raw_name if raw_name and not raw_name.isdigit()
                                           else f'未知分點_{bid}')
            if bid: broker_lookup[bid] = bnm
            out.append({
                'date':        str(r.get('date', ''))[:10],
                'stock_id':    str(r.get('stock_id', fallback_sym)),
                'broker_id':   bid,
                'broker_name': bnm,
                'buy':  _int(r.get('buy',  0)),
                'sell': _int(r.get('sell', 0)),
            })
        return out

    all_rows = []

    # ── 第一盾：FinMind 全市場批次（最快，需 token）──────────────────────
    if FINMIND_TOKENS:
        print(f"  【第一盾】FinMind 批次（{fetch_start}~{today_str}）...")
        rows     = fm_get('TaiwanStockBrokerTrading',
                          start_date=fetch_start, end_date=today_str)
        all_rows = _parse_rows(rows)
        print(f"  第一盾回傳 {len(all_rows)} 筆")

    # ── 第二盾：FinMind 逐日（批次失敗時）──────────────────────────────
    if not all_rows and FINMIND_TOKENS:
        print(f"  【第二盾】FinMind 逐日（{len(missing_days)} 天）...")
        for target_day in missing_days:
            day_iso = target_day.strftime('%Y-%m-%d')
            rows    = fm_get('TaiwanStockBrokerTrading', date=day_iso)
            day_rows = _parse_rows(rows)
            all_rows.extend(day_rows)
            print(f"    {day_iso}: {len(day_rows)} 筆")
            time.sleep(1)
        print(f"  第二盾共 {len(all_rows)} 筆")

    # ── 第三盾：TWSE T86 直連（完全無 token 時的免費防線）──────────────
    if not all_rows:
        watchlist = get_active_symbols()
        print(f"  【第三盾】TWSE T86（{len(watchlist)} 檔 × {len(missing_days)} 天）...")
        t86_hdrs  = {'User-Agent': 'Mozilla/5.0 (compatible; StockBot/1.0)'}
        t86_total = 0
        for target_day in missing_days:
            day_str = target_day.strftime('%Y%m%d')
            day_iso = target_day.strftime('%Y-%m-%d')
            for sym in watchlist:
                try:
                    url  = (f'https://www.twse.com.tw/rwd/zh/fund/T86'
                            f'?response=json&date={day_str}&stock_no={sym}')
                    data = requests.get(url, headers=t86_hdrs, timeout=15).json()
                    if data.get('stat') == 'OK':
                        for row in (data.get('data') or []):
                            if len(row) < 5: continue
                            bid = str(row[1]).strip()
                            bnm = str(row[2]).strip()
                            if bid and bnm: broker_lookup[bid] = bnm
                            all_rows.append({
                                'date': day_iso, 'stock_id': sym,
                                'broker_id': bid,
                                'broker_name': ALL_BROKERS.get(bid, bnm),
                                'buy': _int(row[3]), 'sell': _int(row[4]),
                            })
                            t86_total += 1
                except Exception as e:
                    print(f"    T86 {sym} {day_str}: {e}")
                time.sleep(0.5)
        print(f"  T86 共 {t86_total} 筆")

    # 儲存更新的券商名冊
    if broker_lookup:
        lookup_file = Path(DATA_DIR) / 'broker_names.json'
        lookup_file.write_text(
            json.dumps(broker_lookup, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8')
        print(f"  券商名冊更新：{len(broker_lookup)} 筆")

    if not all_rows:
        print("  ⚠️  無分點資料，跳過")
        return

    # 彙整每股每日前15買/賣超
    by_sym_date: dict = {}
    for r in all_rows:
        sym   = str(r.get('stock_id', ''))
        d_str = str(r.get('date',     ''))[:10]
        if not sym or not d_str or d_str < cutoff_str:
            continue
        bid = str(r.get('broker_id',   ''))
        bnm = str(r.get('broker_name', '')) or broker_lookup.get(bid, '')
        by_sym_date.setdefault((sym, d_str), []).append({
            'bid': bid, 'bnm': bnm,
            'buy': int(r.get('buy',  0)), 'sel': int(r.get('sell', 0)),
            'net': int(r.get('buy',  0)) - int(r.get('sell', 0)),
        })

    keep    = {d.strftime('%Y-%m-%d') for d in trading_days}
    syms    = {k[0] for k in by_sym_date}
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
            if not brokers: continue
            buyers  = sorted([b for b in brokers if b['net'] > 0], key=lambda x: -x['net'])[:15]
            sellers = sorted([b for b in brokers if b['net'] < 0], key=lambda x:  x['net'])[:15]
            existing[d_str] = {
                'date': d_str, 'buyers': buyers, 'sellers': sellers,
                'tot_buy': sum(b['buy'] for b in brokers),
                'tot_sel': sum(b['sel'] for b in brokers),
            }
        final = sorted([v for k, v in existing.items() if k in keep], key=lambda x: x['date'])
        if final:
            out_file.write_text(
                json.dumps(final, ensure_ascii=False, separators=(',', ':')),
                encoding='utf-8')
            updated += 1

    _prune_chips(chips_dir, cutoff_str)
    print(f"  ✅ 分點籌碼完成：{updated} 檔（全台股）")


def _refresh_broker_names(chips_dir: Path, latest_day):
    """最新一天的 T86 快速更新 broker_names.json。"""
    lookup_file = Path(DATA_DIR) / 'broker_names.json'
    broker_lookup: dict = {}
    if lookup_file.exists():
        try:
            broker_lookup = json.loads(lookup_file.read_text(encoding='utf-8'))
        except Exception:
            pass
    day_str = latest_day.strftime('%Y%m%d')
    hdrs    = {'User-Agent': 'Mozilla/5.0 (compatible; StockBot/1.0)'}
    new_cnt = 0
    for sym in CHIP_WATCHLIST[:10]:
        try:
            url  = (f'https://www.twse.com.tw/rwd/zh/fund/T86'
                    f'?response=json&date={day_str}&stock_no={sym}')
            data = requests.get(url, headers=hdrs, timeout=15).json()
            if data.get('stat') == 'OK':
                for row in (data.get('data') or []):
                    if len(row) < 3: continue
                    bid = str(row[1]).strip()
                    bnm = str(row[2]).strip()
                    if bid and bnm and bid not in broker_lookup:
                        broker_lookup[bid] = bnm
                        new_cnt += 1
            time.sleep(0.3)
        except Exception:
            pass
    if broker_lookup:
        lookup_file.write_text(
            json.dumps(broker_lookup, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8')
        print(f"  券商名稱更新：{len(broker_lookup)} 筆（新增 {new_cnt} 筆）")


def _prune_chips(chips_dir: Path, cutoff_str: str):
    """裁切超過滾動視窗的舊資料。"""
    for f in chips_dir.glob('*.json'):
        try:
            data   = json.loads(f.read_text(encoding='utf-8'))
            pruned = [r for r in data if r.get('date', '') >= cutoff_str]
            if not pruned:
                f.unlink()
            elif len(pruned) != len(data):
                f.write_text(
                    json.dumps(pruned, ensure_ascii=False, separators=(',', ':')),
                    encoding='utf-8')
        except Exception:
            pass


# ── 雷達預運算 ──────────────────────────────────────────────────────────────
def _quick_ind(data):
    if len(data) < 22: return None
    closes = [d['close'] for d in data if isinstance(d.get('close'), (int, float))]
    vols   = [d.get('volume', 0) for d in data]
    if len(closes) < 22: return None
    ma   = lambda n, a=closes: sum(a[-n:]) / n
    pma  = lambda n, a=closes: sum(a[-n-1:-1]) / n
    ma5, ma10, ma20 = ma(5), ma(10), ma(20)
    pma5, pma10, pma20 = pma(5), pma(10), pma(20)
    vma5 = sum(vols[-5:]) / 5 if vols else 0
    var20    = sum((c - ma20) ** 2 for c in closes[-20:]) / 20
    upper_bb = ma20 + 2 * var20 ** 0.5
    return {'close': closes[-1], 'prev_close': closes[-2],
            'ma5': ma5, 'ma10': ma10, 'ma20': ma20,
            'pma5': pma5, 'pma10': pma10, 'pma20': pma20,
            'vma5': vma5, 'upper_bb': upper_bb, 'recent_vols': vols[-3:]}


def build_radar_cache():
    data_dir = Path(DATA_DIR)
    results  = {'bottom': [], 'surge': [], 'score': []}
    processed = 0
    skip = {'radar', 'futures_cache', 'macro_cache', 'broker_names'}
    for f in sorted(data_dir.glob('*.json')):
        if f.stem in skip: continue
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not data or len(data) < 22: continue
        ind = _quick_ind(data)
        if not ind: continue
        processed += 1
        c, pc = ind['close'], ind['prev_close']
        ma5, ma10, ma20 = ind['ma5'], ind['ma10'], ind['ma20']
        pma5, pma10, pma20 = ind['pma5'], ind['pma10'], ind['pma20']
        vma5, upper_bb = ind['vma5'], ind['upper_bb']
        rv = ind['recent_vols']
        sym = f.stem
        if ((c > ma20 and pc <= pma20) or (ma5 > ma10 and pma5 <= pma10)) and c > pc:
            results['bottom'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2)})
        if c >= upper_bb * 0.97 and (all(v > vma5 for v in rv) if rv and vma5 > 0 else False):
            results['surge'].append({'sym': sym, 'close': round(c, 2), 'bb_upper': round(upper_bb, 2)})
        if (c > ma20 and ma5 > ma10 and ma10 > ma20) and c > pc and \
           (rv[-1] > vma5 * 1.2 if rv and vma5 > 0 else False):
            results['score'].append({'sym': sym, 'close': round(c, 2), 'ma5': round(ma5, 2)})

    data_dir.joinpath('radar.json').write_text(
        json.dumps({'updated': date.today().isoformat(), 'data': results},
                   ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8')
    write_radar_to_db(results)
    print(f"  ✅ 雷達：掃描 {processed} 檔，"
          f"底部 {len(results['bottom'])} / 飆股 {len(results['surge'])} / 綜合 {len(results['score'])}")


# ── 主程式 ──────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    has_token = bool(FINMIND_TOKENS)
    print("🚀 首席 AI 司令部 — 方案A完全體採礦機")
    print(f"🔑 FinMind Token: {'✅ ' + str(len(FINMIND_TOKENS)) + ' 把' if has_token else '⚠️  無（建議免費註冊）'}")
    print(f"🔑 Massive API:   {'✅ 有' if MASSIVE_API_KEY else '⚠️  無'}\n")
    run()
    fetch_futures_cache()
    fetch_us_macro_cache()
    fetch_broker_chips()
    build_radar_cache()