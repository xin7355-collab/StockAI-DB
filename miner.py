"""
首席 AI 司令部 — 雲端籌碼採礦機 (完全免費版)
資料來源：TWSE / TPEX / TAIFEX 官方免費 API + yfinance
無需任何 API Token。
"""
import json
import re
import sqlite3
import requests
import time
from datetime import date, timedelta
from pathlib import Path

DATA_DIR = "data"
Path(DATA_DIR).mkdir(exist_ok=True)
DB_PATH = "stock_hunter.db"

_HDRS = {'User-Agent': 'Mozilla/5.0 (compatible; StockBot/2.0)'}

# ── 監控清單 ──────────────────────────────────────────────────────────────────
CHIP_WATCHLIST = sorted(set([
    '2330','2317','2454','2382','3231','2303','2881','2886','2002','2603',
    '2308','3711','1301','1303','2801','2884','2885','2892','6505','1216',
    '2207','2301','2327','6415','2357','2395','3034','2379','2376','4938',
    '3105','3529','8069','5347','8299','3293','6142','6274',
    '6488','6515','6770','3037','8046','4977','6278','6191',
    '0050','0056','00878','00929','00919',
]))

# ── 券商戰術標籤庫 ────────────────────────────────────────────────────────────
TACTICAL_TAGS = {
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
    '1480': '美商美林(⚡外資最大隔日沖/常大買大賣)',
    '8440': '摩根大通(⚡小摩/外資極速短線客)',
    '1560': '港商野村(⚡外資短線/常跟美林聯手)',
    '1520': '美商高盛(🏛️波段與短線交錯)',
    '1470': '台灣摩根士丹利(🏛️大摩/外資波段指標)',
    '9800': '元大-總公司(🛡️權證最大避險分點)',
    '9200': '凱基-總公司(🛡️權證避險)',
    '7000': '富邦-總公司(🛡️權證避險)',
    '9100': '群益金鼎-總公司(🛡️權證避險)',
    '5850': '統一-總公司(🛡️權證避險)',
    '8880': '國泰-總公司(🛡️權證避險)',
    '5920': '元富-總公司(🛡️權證避險)',
    '7750': '兆豐-總公司(🛡️權證避險)',
    '9a00': '永豐金-總公司(🛡️權證避險)',
    '9130': '群益金鼎-大安(🧙波段高勝率大戶)',
    '9240': '凱基-板橋(🧙短線與波段高手/擅長低接)',
    '1260': '宏遠-綜合(🧙特定主力/波段發動點)',
    '9a14': '永豐金-忠孝(🧙波段操作勝率極高)',
    '7002': '富邦-台南(🧙傳說中低買高賣抄底王)',
    '9203': '凱基-市政(🐋中台灣超級大鯨魚)',
    '9282': '凱基-復興(🎯關鍵波段大戶)',
    '1040': '臺銀-證券(🛡️官股護盤大哥)',
    '5360': '第一金-綜合(🛡️八大官股)',
    '5440': '華南永昌-綜合(🛡️八大官股)',
    '0040': '臺灣銀行(🛡️八大官股)',
    '5700': '合庫-綜合(🛡️八大官股)',
}


# ── 資料庫 ────────────────────────────────────────────────────────────────────
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


# ── TWSE OHLCV（上市股票月資料）──────────────────────────────────────────────
def _roc_to_gregorian(roc_date: str) -> str:
    """'115/05/02' → '2026/05/02'"""
    parts = roc_date.strip().split('/')
    return f'{int(parts[0]) + 1911}/{parts[1]}/{parts[2]}'


def twse_ohlcv(symbol: str, year_month: str) -> list:
    """TWSE 上市股月 OHLCV。year_month='YYYYMM'。"""
    url = (f'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY'
           f'?response=json&date={year_month}01&stockNo={symbol}')
    try:
        j = requests.get(url, headers=_HDRS, timeout=20).json()
        if j.get('stat') != 'OK':
            return []
        fields = j.get('fields', [])
        fi = lambda kw: next((i for i, f in enumerate(fields) if kw in f), -1)
        i_dt = fi('日期'); i_op = fi('開盤'); i_hi = fi('最高')
        i_lo = fi('最低'); i_cl = fi('收盤'); i_vo = fi('成交股數')
        out = []
        for row in (j.get('data') or []):
            try:
                fmt_date = _roc_to_gregorian(str(row[i_dt]))
                def num(i, t=float):
                    v = str(row[i]).replace(',', '').strip() if i >= 0 else ''
                    try: return t(v) if v not in ('--', '') else 0
                    except: return 0
                c = num(i_cl)
                if c == 0:
                    continue
                out.append({'date': fmt_date,
                            'open': num(i_op) or c, 'high': num(i_hi) or c,
                            'low':  num(i_lo) or c, 'close': c,
                            'volume': num(i_vo, int)})
            except Exception:
                continue
        return out
    except Exception as e:
        print(f"  ⚠️  TWSE STOCK_DAY {symbol} {year_month}: {e}")
        return []


def tpex_ohlcv(symbol: str, year_month: str) -> list:
    """TPEX 上櫃股月 OHLCV。year_month='YYYYMM'。"""
    y, m = int(year_month[:4]), year_month[4:]
    roc_year = y - 1911
    url = (f'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/'
           f'st43_result.php?l=zh-tw&d={roc_year}/{m}&stkno={symbol}&o=json')
    try:
        j = requests.get(url, headers=_HDRS, timeout=20).json()
        aa = j.get('aaData') or []
        # row: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 筆數]
        out = []
        for row in aa:
            try:
                fmt_date = _roc_to_gregorian(str(row[0]))
                def num(i, t=float):
                    v = str(row[i]).replace(',', '').strip()
                    try: return t(v) if v not in ('--', '') else 0
                    except: return 0
                c = num(6)
                if c == 0:
                    continue
                out.append({'date': fmt_date,
                            'open': num(3) or c, 'high': num(4) or c,
                            'low':  num(5) or c, 'close': c,
                            'volume': num(1, int)})
            except Exception:
                continue
        return out
    except Exception as e:
        print(f"  ⚠️  TPEX {symbol} {year_month}: {e}")
        return []


# ── TWSE 三大法人（每日全市場批次）──────────────────────────────────────────
def twse_institutional(date_str: str) -> dict:
    """TWSE MI_QFIIS 全市場法人資料。date_str='YYYYMMDD'。回傳 {stock_id: {...}}"""
    url = (f'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS'
           f'?response=json&date={date_str}&selectType=ALL')
    try:
        j = requests.get(url, headers=_HDRS, timeout=20).json()
        if j.get('stat') != 'OK':
            return {}
        fields = j.get('fields', [])
        fi = lambda kw: next((i for i, f in enumerate(fields) if kw in f), -1)
        idx_id = fi('證券代號'); idx_fn = fi('外資及陸資淨')
        idx_tn = fi('投信淨');   idx_dn = fi('自營商淨')
        if idx_id < 0:
            return {}
        def to_int(row, idx):
            if idx < 0 or idx >= len(row): return 0
            try: return int(str(row[idx]).replace(',', '').replace('+', '') or 0)
            except: return 0
        return {
            str(row[idx_id]).strip(): {
                'foreign_net': to_int(row, idx_fn),
                'trust_net':   to_int(row, idx_tn),
                'dealer_net':  to_int(row, idx_dn),
            }
            for row in (j.get('data') or [])
        }
    except Exception as e:
        print(f"  ⚠️  TWSE MI_QFIIS {date_str}: {e}")
        return {}


# ── TWSE 融資融券（每日全市場批次）──────────────────────────────────────────
def twse_margin(date_str: str) -> dict:
    """TWSE MI_MARGN 全市場融資融券。date_str='YYYYMMDD'。回傳 {stock_id: {...}}"""
    url = (f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN'
           f'?response=json&date={date_str}&selectType=ALL')
    try:
        j = requests.get(url, headers=_HDRS, timeout=20).json()
        if j.get('stat') != 'OK':
            return {}
        fields = j.get('fields', [])
        fi = lambda kw: next((i for i, f in enumerate(fields) if kw in f), -1)
        idx_id = fi('股票代號'); idx_mb = fi('融資今日餘額'); idx_sb = fi('融券今日餘額')
        if idx_id < 0:
            return {}
        def to_int(row, idx):
            if idx < 0 or idx >= len(row): return 0
            try: return int(str(row[idx]).replace(',', '') or 0)
            except: return 0
        return {
            str(row[idx_id]).strip(): {
                'margin_balance': to_int(row, idx_mb),
                'short_balance':  to_int(row, idx_sb),
            }
            for row in (j.get('data') or [])
        }
    except Exception as e:
        print(f"  ⚠️  TWSE MI_MARGN {date_str}: {e}")
        return {}


# ── TAIFEX 外資期貨（直連官網）───────────────────────────────────────────────
def taifex_tx_net(target_date) -> int | None:
    """TAIFEX TX 外資未平倉淨口數。target_date: date object。"""
    try:
        date_slash = target_date.strftime('%Y/%m/%d')
        url  = 'https://www.taifex.com.tw/cht/3/futContractsDate'
        form = {'queryType': '1', 'marketCode': '0', 'contractCode': 'TX',
                'dateaddcnt': '0', 'queryDate': date_slash}
        hdrs = {**_HDRS, 'Referer': url, 'Accept-Encoding': 'gzip, deflate, br'}
        r = requests.post(url, data=form, headers=hdrs, timeout=30)
        r.raise_for_status()
        for row_html in re.findall(r'<tr[^>]*>(.*?)</tr>', r.text, re.DOTALL):
            if '外資及陸資' not in row_html:
                continue
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row_html, re.DOTALL)
            nums = []
            for c in cells:
                val = re.sub(r'<[^>]+>', '', c).strip().replace(',', '').replace('+', '')
                if val.lstrip('-').isdigit() and len(val.lstrip('-')) >= 2:
                    nums.append(int(val))
            print(f'  🔍 TAIFEX TX數字: {nums}')
            if len(nums) >= 5:
                return nums[4]
            if len(nums) >= 3:
                return nums[0] - nums[2]
        print('  ⚠️  TAIFEX: 找不到外資及陸資 TX 資料')
        return None
    except Exception as e:
        print(f'  ⚠️  TAIFEX TX 失敗: {e}')
        return None


# ── JSON 讀寫 ─────────────────────────────────────────────────────────────────
def load_json(symbol):
    p = Path(DATA_DIR) / f'{symbol}.json'
    if p.exists():
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return []


def save_json(symbol, records):
    p = Path(DATA_DIR) / f'{symbol}.json'
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, separators=(',', ':'))


# ── 動態監控清單 ──────────────────────────────────────────────────────────────
def get_active_symbols():
    base = set(CHIP_WATCHLIST)
    skip = {'radar', 'futures_cache', 'macro_cache', 'broker_names'}
    extra = {f.stem for f in Path(DATA_DIR).glob('*.json')
             if f.stem not in skip and f.stem not in base}
    return sorted(base | set(sorted(extra)[:50]))


def get_trading_days(n=30):
    """最近 n 個交易日（跳週末）"""
    days, d = [], date.today()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return sorted(days)


# ── 主採礦：TWSE 完全免費版 ──────────────────────────────────────────────────
def run():
    today = date.today()
    watchlist = get_active_symbols()

    # 本月 + 上個月
    months = []
    cur = today.replace(day=1)
    for _ in range(2):
        months.append(cur.strftime('%Y%m'))
        cur = (cur - timedelta(days=1)).replace(day=1)

    # 最近 10 個交易日做批次法人/融資
    trading_days = get_trading_days(10)

    print(f"\n🎯 {len(watchlist)} 檔個股 | 月份: {months}")

    # Step 1：批次抓取三大法人 + 融資融券（一次拿全市場，所有股票共用）
    print(f"\n📊 批次抓取三大法人 + 融資融券（{len(trading_days)} 個交易日）...")
    inst_cache:   dict = {}  # {date_dash: {stock_id: {foreign_net, trust_net, dealer_net}}}
    margin_cache: dict = {}  # {date_dash: {stock_id: {margin_balance, short_balance}}}
    for d in trading_days:
        d8 = d.strftime('%Y%m%d')
        dd = d.strftime('%Y-%m-%d')
        inst = twse_institutional(d8)
        if inst:
            inst_cache[dd] = inst
            print(f"  法人 {dd}: {len(inst)} 筆")
        time.sleep(0.8)
        marg = twse_margin(d8)
        if marg:
            margin_cache[dd] = marg
            print(f"  融券 {dd}: {len(marg)} 筆")
        time.sleep(0.8)

    # Step 2：個股 OHLCV（TWSE → TPEX fallback）
    print(f"\n📈 個股 OHLCV 採礦 ({len(watchlist)} 檔)...")
    updated_total = 0
    for idx, sym in enumerate(watchlist):
        print(f"  🛰️  [{idx+1}/{len(watchlist)}] {sym} ...", end=' ', flush=True)

        new_rows = []
        for ym in months:
            rows = twse_ohlcv(sym, ym)
            if not rows:
                rows = tpex_ohlcv(sym, ym)
            new_rows.extend(rows)
            time.sleep(0.4)

        existing     = load_json(sym)
        existing_map = {rec['date']: rec for rec in existing}
        changed = False

        for r in new_rows:
            fmt_date  = r['date']               # YYYY/MM/DD
            date_dash = fmt_date.replace('/', '-')  # YYYY-MM-DD

            chip = {
                'foreign_net':    inst_cache.get(date_dash, {}).get(sym, {}).get('foreign_net', 0),
                'trust_net':      inst_cache.get(date_dash, {}).get(sym, {}).get('trust_net', 0),
                'dealer_net':     inst_cache.get(date_dash, {}).get(sym, {}).get('dealer_net', 0),
                'margin_balance': margin_cache.get(date_dash, {}).get(sym, {}).get('margin_balance', 0),
                'short_balance':  margin_cache.get(date_dash, {}).get(sym, {}).get('short_balance', 0),
            }

            if fmt_date in existing_map:
                rec = existing_map[fmt_date]
                if rec.get('foreign_net', 0) == 0 and chip.get('foreign_net', 0) != 0:
                    rec.update(chip)
                    changed = True
                continue

            existing_map[fmt_date] = {
                'date': fmt_date, 'open': r['open'], 'high': r['high'],
                'low': r['low'], 'close': r['close'], 'volume': r['volume'],
                **chip,
            }
            changed = True

        # 補丁：針對已存在但 chip=0 的記錄，用批次快取補入
        for date_dash, by_sym in inst_cache.items():
            if sym not in by_sym:
                continue
            fmt_date = date_dash.replace('-', '/')
            if fmt_date in existing_map and existing_map[fmt_date].get('foreign_net', 0) == 0:
                existing_map[fmt_date].update({
                    'foreign_net': by_sym[sym].get('foreign_net', 0),
                    'trust_net':   by_sym[sym].get('trust_net', 0),
                    'dealer_net':  by_sym[sym].get('dealer_net', 0),
                })
                changed = True
        for date_dash, by_sym in margin_cache.items():
            if sym not in by_sym:
                continue
            fmt_date = date_dash.replace('-', '/')
            if fmt_date in existing_map and existing_map[fmt_date].get('margin_balance', 0) == 0:
                existing_map[fmt_date].update({
                    'margin_balance': by_sym[sym].get('margin_balance', 0),
                    'short_balance':  by_sym[sym].get('short_balance', 0),
                })
                changed = True

        if changed:
            combined = sorted(existing_map.values(), key=lambda x: x['date'])[-800:]
            save_json(sym, combined)
            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                for nr in combined[-5:]:
                    dt_s = nr['date'].replace('/', '-')
                    c.execute(
                        "INSERT OR REPLACE INTO stock_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (sym, dt_s, nr.get('open'), nr.get('high'), nr.get('low'),
                         nr.get('close'), nr.get('volume'),
                         nr.get('foreign_net', 0), nr.get('trust_net', 0),
                         nr.get('dealer_net', 0), nr.get('margin_balance', 0),
                         nr.get('short_balance', 0)))
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"\n    ⚠️ SQLite {sym}: {e}")
            updated_total += 1
            print("✅")
        else:
            print("skip")

    print(f"\n🎉 採礦完畢：更新 {updated_total}/{len(watchlist)} 檔。")


# ── 外資期貨（TAIFEX 直連）───────────────────────────────────────────────────
def fetch_futures_cache():
    """外資台指期未平倉淨口數（TAIFEX 官網直連，無需帳號）。"""
    today = date.today()
    # 找最近一個交易日
    target = today - timedelta(days=1)
    while target.weekday() >= 5:
        target -= timedelta(days=1)
    print(f"\n🔮 抓取外資台指期（{target}）...")
    net = taifex_tx_net(target)
    if net is None:
        print('  ⚠️  TAIFEX 失敗，保留舊快取不覆寫')
        return
    cache = {
        'date': target.strftime('%Y-%m-%d'),
        'fi_net': net,
        'long': 0, 'short': 0,
        'generated': today.strftime('%Y-%m-%d'),
    }
    with open('futures_cache.json', 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    print(f"  ✅ 外資台指期淨口數: {net:+,} 口  ({target})")


# ── 美股大盤快取 ──────────────────────────────────────────────────────────────
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


# ── 分點籌碼（TWSE T86 直連，唯一資料來源）──────────────────────────────────
def _is_valid_broker_id(bid: str) -> bool:
    """有效券商代碼：4 碼英數字（如 9268、984e）"""
    return len(bid) == 4 and bid.isalnum()


def get_all_taiwan_brokers() -> dict:
    """載入本地快取（已過濾乾淨）+ 戰術標籤。"""
    broker_map: dict = {}
    lookup_file = Path(DATA_DIR) / 'broker_names.json'
    if lookup_file.exists():
        try:
            cached = json.loads(lookup_file.read_text(encoding='utf-8'))
            # 只載入有效的 4 碼券商代碼，過濾掉股票名稱等污染資料
            broker_map = {k: v for k, v in cached.items() if _is_valid_broker_id(k)}
        except Exception:
            pass
    broker_map.update(TACTICAL_TAGS)
    return broker_map


def fetch_broker_chips():
    """分點籌碼採礦：TWSE T86 直連（30 天滾動視窗）。"""
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

    ALL_BROKERS   = get_all_taiwan_brokers()
    broker_lookup = dict(ALL_BROKERS)
    print(f"  🏢 券商名冊 {len(ALL_BROKERS)} 筆就緒")

    def _int(v):
        try: return int(str(v).replace(',', ''))
        except: return 0

    all_rows = []
    watchlist = get_active_symbols()
    print(f"  【T86】{len(watchlist)} 檔 × {len(missing_days)} 天...")
    t86_total = 0
    for target_day in missing_days:
        day_str = target_day.strftime('%Y%m%d')
        day_iso = target_day.strftime('%Y-%m-%d')
        for sym in watchlist:
            try:
                url  = (f'https://www.twse.com.tw/rwd/zh/fund/T86'
                        f'?response=json&date={day_str}&stock_no={sym}')
                data = requests.get(url, headers=_HDRS, timeout=15).json()
                if data.get('stat') == 'OK':
                    for row in (data.get('data') or []):
                        if len(row) < 5:
                            continue
                        bid = str(row[1]).strip()
                        bnm = str(row[2]).strip()
                        # 只記錄有效的 4 碼券商代碼，防止股票名稱污染
                        if _is_valid_broker_id(bid):
                            resolved = TACTICAL_TAGS.get(bid) or TACTICAL_TAGS.get(bid.lower()) or bnm or f'分點{bid}'
                            broker_lookup[bid] = resolved
                        else:
                            resolved = ALL_BROKERS.get(bid, bid or f'分點{bid}')
                        all_rows.append({
                            'date': day_iso, 'stock_id': sym,
                            'broker_id':   bid,
                            'broker_name': resolved,
                            'buy': _int(row[3]), 'sell': _int(row[4]),
                        })
                        t86_total += 1
            except Exception as e:
                print(f"    T86 {sym} {day_str}: {e}")
            time.sleep(0.5)
    print(f"  T86 共 {t86_total} 筆")

    # 儲存乾淨的券商名冊（只含 4 碼有效代碼）
    clean_lookup = {k: v for k, v in broker_lookup.items() if _is_valid_broker_id(k)}
    if clean_lookup:
        lookup_file = Path(DATA_DIR) / 'broker_names.json'
        lookup_file.write_text(
            json.dumps(clean_lookup, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8')
        print(f"  券商名冊更新：{len(clean_lookup)} 筆")

    if not all_rows:
        print("  ⚠️  無分點資料，跳過")
        return

    # 彙整每股每日前15買/賣超
    by_sym_date: dict = {}
    for r in all_rows:
        sym   = str(r.get('stock_id', ''))
        d_str = str(r.get('date', ''))[:10]
        if not sym or not d_str or d_str < cutoff_str:
            continue
        bid = str(r.get('broker_id', ''))
        bnm = str(r.get('broker_name', '')) or broker_lookup.get(bid, bid)
        by_sym_date.setdefault((sym, d_str), []).append({
            'bid': bid, 'bnm': bnm,
            'buy': int(r.get('buy', 0)), 'sel': int(r.get('sell', 0)),
            'net': int(r.get('buy', 0)) - int(r.get('sell', 0)),
        })

    keep = {d.strftime('%Y-%m-%d') for d in trading_days}
    syms = {k[0] for k in by_sym_date}
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
    print(f"  ✅ 分點籌碼完成：{updated} 檔")


def _refresh_broker_names(chips_dir: Path, latest_day):
    """最新一天 T86 快速更新 broker_names.json（只補新代碼，不覆寫舊的）。"""
    lookup_file = Path(DATA_DIR) / 'broker_names.json'
    broker_lookup: dict = {}
    if lookup_file.exists():
        try:
            cached = json.loads(lookup_file.read_text(encoding='utf-8'))
            broker_lookup = {k: v for k, v in cached.items() if _is_valid_broker_id(k)}
        except Exception:
            pass
    broker_lookup.update(TACTICAL_TAGS)
    day_str = latest_day.strftime('%Y%m%d')
    new_cnt = 0
    for sym in CHIP_WATCHLIST[:10]:
        try:
            url  = (f'https://www.twse.com.tw/rwd/zh/fund/T86'
                    f'?response=json&date={day_str}&stock_no={sym}')
            data = requests.get(url, headers=_HDRS, timeout=15).json()
            if data.get('stat') == 'OK':
                for row in (data.get('data') or []):
                    if len(row) < 3:
                        continue
                    bid = str(row[1]).strip()
                    bnm = str(row[2]).strip()
                    if _is_valid_broker_id(bid) and bid not in broker_lookup:
                        broker_lookup[bid] = bnm
                        new_cnt += 1
            time.sleep(0.3)
        except Exception:
            pass
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


# ── 雷達預運算 ────────────────────────────────────────────────────────────────
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


# ── 主程式 ────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    print("🚀 首席 AI 司令部 — 完全免費採礦機（TWSE/TAIFEX/yfinance）")
    run()
    fetch_futures_cache()
    fetch_us_macro_cache()
    fetch_broker_chips()
    build_radar_cache()
