"""
首席 AI 司令部 — 雲端籌碼採礦機 (完全免費旗艦版)
資料來源：TWSE / TPEX / TAIFEX 官方免費 API + yfinance + FinMind(匿名)
特色：無痛部署、無須 API Token、1GB RAM 記憶體極限防禦
"""
import csv
import json
import math
import os
import random
import re
import sqlite3
import requests
import time
from datetime import date, timedelta
from pathlib import Path

DATA_DIR = "data"
Path(DATA_DIR).mkdir(exist_ok=True)
DB_PATH = "stock_hunter.db"

_HDRS          = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'}
_UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
]
def _rnd_hdrs() -> dict:
    return {'User-Agent': random.choice(_UA_LIST)}
FINMIND_TOKEN  = os.getenv('FINMIND_TOKEN', '')
BATCH_INDEX    = int(os.getenv('BATCH_INDEX', '0'))
TOTAL_BATCHES  = int(os.getenv('TOTAL_BATCHES', '1'))

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
        fi = lambda kw: next((i for i, f in enumerate(fields) if kw in f), None)
        i_dt = fi('日期'); i_op = fi('開盤'); i_hi = fi('最高')
        i_lo = fi('最低'); i_cl = fi('收盤'); i_vo = fi('成交股數')
        if i_dt is None:
            print(f"  ⚠️ TWSE OHLCV '日期' 欄位找不到，headers={fields[:5]}"); return []
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
def fetch_market_institutional(d: date) -> dict:
    """整合 TWSE (上市) 與 TPEX (上櫃) 的三大法人買賣超"""
    res = {}
    d8 = d.strftime('%Y%m%d')
    roc_y = d.year - 1911
    d_tpex = f"{roc_y}/{d.strftime('%m/%d')}"

    # 1. 抓取上市 (TWSE T86)
    try:
        url = f'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date={d8}&selectType=ALL'
        j = requests.get(url, headers=_rnd_hdrs(), timeout=15).json()
        if j.get('stat') == 'OK':
            fields = j.get('fields', [])
            idx_id = next((i for i, f in enumerate(fields) if '證券代號' in f), None)
            idx_f  = next((i for i, f in enumerate(fields) if '外' in f and '買賣超' in f), None)
            idx_t  = next((i for i, f in enumerate(fields) if '投信買賣超' in f), None)
            idx_d  = next((i for i, f in enumerate(fields) if '自營商買賣超股數' in f and '自行' not in f and '避險' not in f), None)
            if idx_d is None: idx_d = next((i for i, f in enumerate(fields) if '自營商買賣超' in f), None)
            if None in (idx_id, idx_f, idx_t, idx_d):
                print(f"  ⚠️ 上市法人欄位找不到，headers={fields[:5]}")
                return res
            for r in (j.get('data') or []):
                try:
                    res[str(r[idx_id]).strip()] = {
                        'foreign_net': int(str(r[idx_f]).replace(',','')),
                        'trust_net':   int(str(r[idx_t]).replace(',','')),
                        'dealer_net':  int(str(r[idx_d]).replace(',',''))
                    }
                except (ValueError, IndexError): pass
    except Exception as e: print(f"  ⚠️ 上市法人失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    # 2. 抓取上櫃 (TPEX)
    try:
        url_otc = f'https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d={d_tpex}'
        j = requests.get(url_otc, headers=_rnd_hdrs(), timeout=15).json()
        for r in (j.get('aaData') or []):
            try:
                res[str(r[0]).strip()] = {
                    'foreign_net': int(str(r[4]).replace(',','')), # 外資買賣超
                    'trust_net': int(str(r[11]).replace(',','')),  # 投信買賣超
                    'dealer_net': int(str(r[18]).replace(',',''))  # 自營買賣超總計
                }
            except: pass
    except Exception as e: print(f"  ⚠️ 上櫃法人失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    return res


def fetch_market_margin(d: date) -> dict:
    """整合 TWSE (上市) 與 TPEX (上櫃) 的融資融券餘額"""
    res = {}
    d8 = d.strftime('%Y%m%d')
    roc_y = d.year - 1911
    d_tpex = f"{roc_y}/{d.strftime('%m/%d')}"

    # 1. 抓取上市 (TWSE MI_MARGN)
    try:
        url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={d8}&selectType=ALL'
        j = requests.get(url, headers=_rnd_hdrs(), timeout=15).json()
        if j.get('stat') == 'OK':
            target_table = next((t for t in j.get('tables', []) if '信用' in t.get('title', '')), None)
            if target_table:
                fields = target_table.get('fields', [])
                idx_id = next((i for i, f in enumerate(fields) if '股票代號' in f), -1)
                idx_mb = next((i for i, f in enumerate(fields) if '融資' in f and '今日餘額' in f), -1)
                idx_sb = next((i for i, f in enumerate(fields) if '融券' in f and '今日餘額' in f), -1)
                for r in target_table.get('data', []):
                    try:
                        res[str(r[idx_id]).strip()] = {
                            'margin_balance': int(str(r[idx_mb]).replace(',','')),
                            'short_balance': int(str(r[idx_sb]).replace(',',''))
                        }
                    except: pass
    except Exception as e: print(f"  ⚠️ 上市融資券失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    # 2. 抓取上櫃 (TPEX)
    try:
        url_otc = f'https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d={d_tpex}'
        j = requests.get(url_otc, headers=_rnd_hdrs(), timeout=15).json()
        for r in (j.get('aaData') or []):
            try:
                res[str(r[0]).strip()] = {
                    'margin_balance': int(str(r[6]).replace(',','')), # 融資現在餘額
                    'short_balance': int(str(r[13]).replace(',',''))  # 融券現在餘額
                }
            except: pass
    except Exception as e: print(f"  ⚠️ 上櫃融資券失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    return res


# ── SQLite ↔ JSON 橋接（gh-pages 靜態部署用）────────────────────────────────
def export_json(inst_cache: dict = None, margin_cache: dict = None):
    """
    從 SQLite stock_history 匯出每支股票的 JSON 檔案。
    inst_cache / margin_cache 若傳入，會用最新快取覆蓋 SQLite 中殘留的 0 值，
    確保全市場每支股票的近 10 天籌碼在當次匯出即正確。
    """
    Path(DATA_DIR).mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    symbols = [row[0] for row in
               conn.execute("SELECT DISTINCT symbol FROM stock_history")]

    exported = 0
    for sym in symbols:
        rows = conn.execute("""
            SELECT trade_date, open, high, low, close, volume,
                   foreign_inv, invest_trust, dealer_inv, margin_bal, short_bal
            FROM stock_history
            WHERE symbol = ?
            ORDER BY trade_date ASC
            LIMIT 800
        """, (sym,)).fetchall()

        if not rows:
            continue

        records = [{
            'date':           r['trade_date'].replace('-', '/'),
            'open':           r['open'],  'high': r['high'],
            'low':            r['low'],   'close': r['close'],
            'volume':         r['volume'],
            'foreign_net':    r['foreign_inv']   or 0,
            'trust_net':      r['invest_trust']  or 0,
            'dealer_net':     r['dealer_inv']    or 0,
            'margin_balance': r['margin_bal']    or 0,
            'short_balance':  r['short_bal']     or 0,
        } for r in rows]

        # 新增：整合法人與融資券資料 ── 用本次採礦快取覆蓋 SQLite 殘留的 0 值
        if inst_cache or margin_cache:
            for rec in records:
                date_dash = rec['date'].replace('/', '-')
                if inst_cache and rec.get('foreign_net', 0) == 0:
                    inst_day = (inst_cache.get(date_dash) or {}).get(sym) or {}
                    if inst_day:
                        rec['foreign_net'] = inst_day.get('foreign_net', 0)
                        rec['trust_net']   = inst_day.get('trust_net',   0)
                        rec['dealer_net']  = inst_day.get('dealer_net',  0)
                if margin_cache and rec.get('margin_balance', 0) == 0:
                    marg_day = (margin_cache.get(date_dash) or {}).get(sym) or {}
                    if marg_day:
                        rec['margin_balance'] = marg_day.get('margin_balance', 0)
                        rec['short_balance']  = marg_day.get('short_balance',  0)

        p = Path(DATA_DIR) / f'{sym}.json'
        p.write_text(
            json.dumps(records, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8')
        exported += 1

    conn.close()
    print(f"  ✅ JSON 匯出完成：{exported} 檔（供 gh-pages 靜態部署）")


# ── 動態監控清單（全市場批次版）────────────────────────────────────────────
def get_batch_symbols(inst_cache: dict, batch_idx: int = 0, total: int = 1) -> list:
    """從法人批次資料衍生全市場清單，再依批次分割。
    inst_cache 的 keys 即為當日所有活躍股票代號（~1800 檔）。
    非交易日 fallback 到舊 DB / JSON 資料。
    """
    all_syms: set = set()
    for day_data in inst_cache.values():
        all_syms.update(day_data.keys())

    # 只保留一般股票（4碼純數字）或 ETF（00 開頭純數字），排除認購/售權證
    all_syms = {s for s in all_syms if s.isdigit() and (len(s) == 4 or s.startswith('00'))}

    if not all_syms:
        # 非交易日或法人 API 失敗 → fallback 舊有資料
        all_syms = set(CHIP_WATCHLIST)
        skip = {'radar', 'futures_cache', 'macro_cache', 'broker_names'}
        if Path(DB_PATH).exists():
            try:
                conn = sqlite3.connect(DB_PATH)
                for row in conn.execute("SELECT DISTINCT symbol FROM stock_history"):
                    all_syms.add(row[0])
                conn.close()
            except Exception:
                pass
        all_syms |= {f.stem for f in Path(DATA_DIR).glob('*.json') if f.stem not in skip}

    sorted_syms = sorted(all_syms)
    if total <= 1:
        return sorted_syms
    size  = math.ceil(len(sorted_syms) / total)
    start = batch_idx * size
    end   = min(start + size, len(sorted_syms))
    return sorted_syms[start:end]


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

    months = []
    cur = today.replace(day=1)
    for _ in range(2):
        months.append(cur.strftime('%Y%m'))
        cur = (cur - timedelta(days=1)).replace(day=1)

    trading_days = get_trading_days(10)

    print(f"\n📊 批次抓取三大法人 + 融資融券（最近 {len(trading_days)} 個交易日）...")
    inst_cache:   dict = {}
    margin_cache: dict = {}
    for d in trading_days:
        dd = d.strftime('%Y-%m-%d')
        inst = fetch_market_institutional(d)
        if inst:
            inst_cache[dd] = inst
            print(f"  法人 {dd}: {len(inst)} 筆")
        time.sleep(0.8)
        marg = fetch_market_margin(d)
        if marg:
            margin_cache[dd] = marg
            print(f"  融券 {dd}: {len(marg)} 筆")
        time.sleep(0.8)

    # 從法人資料衍生全市場清單，依批次分割
    watchlist = get_batch_symbols(inst_cache, BATCH_INDEX, TOTAL_BATCHES)
    print(f"\n🎯 批次 {BATCH_INDEX}/{TOTAL_BATCHES}：{len(watchlist)} 檔個股 | 月份: {months}")

    print(f"\n📈 個股 OHLCV 採礦 ({len(watchlist)} 檔)...")
    db_conn = sqlite3.connect(DB_PATH)
    db_conn.row_factory = sqlite3.Row
    db_cur  = db_conn.cursor()

    updated_total = 0

    for idx, sym in enumerate(watchlist):
        print(f"  🛰️  [{idx+1}/{len(watchlist)}] {sym} ...", end=' ', flush=True)

        db_cur.execute("""
            SELECT trade_date, open, high, low, close, volume,
                   foreign_inv, invest_trust, dealer_inv, margin_bal, short_bal
            FROM stock_history
            WHERE symbol = ?
            ORDER BY trade_date ASC
        """, (sym,))
        existing_map: dict = {}
        for row in db_cur.fetchall():
            fmt_date = row['trade_date'].replace('-', '/')
            existing_map[fmt_date] = {
                'date':           fmt_date,
                'open':           row['open'],  'high': row['high'],
                'low':            row['low'],   'close': row['close'],
                'volume':         row['volume'],
                'foreign_net':    row['foreign_inv']  or 0,
                'trust_net':      row['invest_trust'] or 0,
                'dealer_net':     row['dealer_inv']   or 0,
                'margin_balance': row['margin_bal']   or 0,
                'short_balance':  row['short_bal']    or 0,
            }

        new_rows = []
        for ym in months:
            rows = twse_ohlcv(sym, ym)
            if not rows:
                time.sleep(1.0); rows = twse_ohlcv(sym, ym)  # retry
            if not rows:
                rows = tpex_ohlcv(sym, ym)
            if not rows:
                time.sleep(1.0); rows = tpex_ohlcv(sym, ym)  # retry
            new_rows.extend(rows)
            time.sleep(0.4)

        changed = False
        for r in new_rows:
            fmt_date  = r['date']
            date_dash = fmt_date.replace('/', '-')

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
            batch = [
                (sym,
                 r['date'].replace('/', '-'),
                 r.get('open'),   r.get('high'),  r.get('low'),
                 r.get('close'),  r.get('volume'),
                 r.get('foreign_net',    0),
                 r.get('trust_net',      0),
                 r.get('dealer_net',     0),
                 r.get('margin_balance', 0),
                 r.get('short_balance',  0))
                for r in combined
            ]
            try:
                db_cur.executemany(
                    "INSERT OR REPLACE INTO stock_history "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    batch)
                db_conn.commit()
                updated_total += 1
                print("✅")
            except Exception as e:
                db_conn.rollback()
                print(f"⚠️ SQLite {sym}: {e}")
        else:
            print("skip")

    db_conn.close()
    print(f"\n🎉 採礦完畢：更新 {updated_total}/{len(watchlist)} 檔。")
    return inst_cache, margin_cache


# ── 外資期貨（改用 FinMind API 防 Ban 版）────────────────────────────────────
def fetch_futures_cache():
    """
    外資台指期未平倉淨口數：放棄容易被 Ban 的期交所爬蟲，
    全面改用 FinMind 官方通道，穩定、合法且帶有你的專屬 Token。
    """
    today_str = date.today().strftime('%Y-%m-%d')
    start_str = (date.today() - timedelta(days=7)).strftime('%Y-%m-%d')

    token_param = f"&token={FINMIND_TOKEN}" if FINMIND_TOKEN and "請" not in FINMIND_TOKEN else ""

    url = f'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesInstitutionalInvestors&data_id=TX&start_date={start_str}&end_date={today_str}{token_param}'

    print(f"\n🔮 抓取外資台指期 (使用 FinMind {'Token' if token_param else '匿名'} 防封鎖通道)...")
    try:
        res = requests.get(url, headers=_HDRS, timeout=15)

        if res.status_code == 429:
            print("  ⚠️ 觸發 FinMind 速率限制，保留舊快取，請稍後再試。")
            return

        j = res.json()
        if j.get('status') == 200 and j.get('data'):
            foreign_data = [d for d in j['data'] if '外資' in d.get('name', '')]

            if foreign_data:
                latest = foreign_data[-1]
                target_date = latest.get('date')

                long_oi_val  = latest.get('long_open_interest_balance') or latest.get('long_open_interest') or latest.get('buy_open_interest')
                short_oi_val = latest.get('short_open_interest_balance') or latest.get('short_open_interest') or latest.get('sell_open_interest')
                if not long_oi_val and not short_oi_val:
                    print(f"  ⚠️ FinMind 期貨 OI 欄位找不到，available keys: {list(latest.keys())}")
                long_oi  = int(long_oi_val  or 0)
                short_oi = int(short_oi_val or 0)
                net_oi   = long_oi - short_oi

                cache = {
                    'date':      target_date,
                    'fi_net':    net_oi,
                    'long':      long_oi,
                    'short':     short_oi,
                    'generated': today_str,
                }

                with open('futures_cache.json', 'w', encoding='utf-8') as f:
                    json.dump(cache, f, ensure_ascii=False)

                print(f"  ✅ 外資台指期淨口數: {net_oi:+,} 口 ({target_date})")
                return

        print("  ⚠️ FinMind 目前查無最新外資期貨資料，可能今日盤後尚未更新。")
    except Exception as e:
        print(f"  ⚠️ 外資期貨連線失敗: {e}")


# ── 美股大盤快取 ──────────────────────────────────────────────────────────────
def fetch_us_macro_cache():
    try:
        import yfinance as yf
    except ImportError:
        print("\n⚠️  yfinance 未安裝，跳過美股快取")
        return
    today   = date.today()
    symbols = {'sp500': '^GSPC', 'nasdaq': '^IXIC', 'tsm': 'TSM',
               'dji': '^DJI', 'vix': '^VIX',
               'sox': '^SOX', 'nvda': 'NVDA', 'aapl': 'AAPL', 'msft': 'MSFT',
               'us02y': '^IRX',     # 13W T-Bill 短債利率（Fed 政策風向）
               'ukoil': 'BZ=F',     # 布蘭特原油期貨
               'dxy':   'DX-Y.NYB'  # 美元指數
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


# ── 分點籌碼（FinMind 匿名公開額度版）────────────────────────────────────────
def fetch_broker_chips():
    """
    分點籌碼採礦：由於台灣官方無免費分點 API，
    此處使用 FinMind 匿名公開額度 (每小時 300 次限制)。
    """
    chips_dir = Path(DATA_DIR) / 'chips'
    chips_dir.mkdir(parents=True, exist_ok=True)
    today_str = date.today().strftime('%Y-%m-%d')
    watchlist = sorted(CHIP_WATCHLIST)  # 分點籌碼僅追蹤監控清單，FinMind 每小時 300 次限制

    print(f"\n🕵️ 啟動分點籌碼探測 ({len(watchlist)} 檔，FinMind 免費通道，請耐心等候避免限流)...")

    updated = 0
    for sym in watchlist:
        url = f'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockLocalSecuritiesBrokerTransactions&data_id={sym}&start_date={today_str}'
        try:
            res = requests.get(url, headers=_HDRS, timeout=15)
            j = res.json()
            if j.get('status') == 200 and j.get('data'):
                raw_data = j['data']
                brokers_net = {}
                for r in raw_data:
                    bid = r.get('secBrokerId')
                    bnm = TACTICAL_TAGS.get(bid, r.get('secBrokerName', bid))
                    net = int(r.get('buy', 0)) - int(r.get('sell', 0))
                    if bid not in brokers_net:
                        brokers_net[bid] = {'bid': bid, 'bnm': bnm, 'buy': 0, 'sel': 0, 'net': 0}
                    brokers_net[bid]['buy'] += int(r.get('buy', 0))
                    brokers_net[bid]['sel'] += int(r.get('sell', 0))
                    brokers_net[bid]['net'] += net

                brokers_list = list(brokers_net.values())
                buyers  = sorted([b for b in brokers_list if b['net'] > 0], key=lambda x: -x['net'])[:15]
                sellers = sorted([b for b in brokers_list if b['net'] < 0], key=lambda x: x['net'])[:15]

                if buyers or sellers:
                    out_file = chips_dir / f'{sym}.json'
                    # 讀取舊紀錄，合併今日資料，保留最近 20 個交易日
                    existing = []
                    if out_file.exists():
                        try: existing = json.loads(out_file.read_text(encoding='utf-8'))
                        except Exception: pass
                    records_map = {r['date']: r for r in existing if isinstance(r, dict)}
                    records_map[today_str] = {
                        'date': today_str,
                        'buyers': buyers,
                        'sellers': sellers,
                        'tot_buy': sum(b['buy'] for b in brokers_list),
                        'tot_sel': sum(b['sel'] for b in brokers_list)
                    }
                    recent_dates = sorted(records_map.keys())[-20:]
                    out_file.write_text(
                        json.dumps([records_map[d] for d in recent_dates], ensure_ascii=False),
                        encoding='utf-8')
                    updated += 1

            time.sleep(3)
        except Exception as e:
            print(f"    ⚠️ 分點籌碼 {sym} 失敗: {e}")
            time.sleep(5)

    print(f"  ✅ 分點籌碼完成：更新了 {updated} 檔股票的主力動向")


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
    results   = {'bottom': [], 'surge': [], 'score': []}
    processed = 0

    conn = sqlite3.connect(DB_PATH)
    symbols = [row[0] for row in
               conn.execute("SELECT DISTINCT symbol FROM stock_history")]

    for sym in sorted(symbols):
        rows = conn.execute("""
            SELECT close, volume FROM stock_history
            WHERE symbol = ?
            ORDER BY trade_date DESC
            LIMIT 25
        """, (sym,)).fetchall()

        if len(rows) < 22:
            continue

        data = [{'close': r[0], 'volume': r[1]} for r in reversed(rows)]
        ind  = _quick_ind(data)
        if not ind:
            continue

        processed += 1
        c,   pc   = ind['close'],   ind['prev_close']
        ma5, ma10, ma20         = ind['ma5'],  ind['ma10'],  ind['ma20']
        pma5, pma10, pma20      = ind['pma5'], ind['pma10'], ind['pma20']
        vma5, upper_bb, rv      = ind['vma5'], ind['upper_bb'], ind['recent_vols']

        if ((c > ma20 and pc <= pma20) or (ma5 > ma10 and pma5 <= pma10)) and c > pc:
            results['bottom'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2)})
        if c >= upper_bb * 0.97 and (all(v > vma5 for v in rv) if rv and vma5 > 0 else False):
            results['surge'].append({'sym': sym, 'close': round(c, 2), 'bb_upper': round(upper_bb, 2)})
        if (c > ma20 and ma5 > ma10 and ma10 > ma20) and c > pc and \
           (rv[-1] > vma5 * 1.2 if rv and vma5 > 0 else False):
            results['score'].append({'sym': sym, 'close': round(c, 2), 'ma5': round(ma5, 2)})

    conn.close()

    Path(DATA_DIR).mkdir(exist_ok=True)
    Path(DATA_DIR).joinpath('radar.json').write_text(
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
    inst_cache, margin_cache = run()                        # 採礦：OHLCV + 法人 → SQLite
    export_json(inst_cache, margin_cache)                   # 匯出 JSON：疊上最新法人快取
    fetch_futures_cache()   # 外資期貨 → futures_cache.json
    fetch_us_macro_cache()  # 美股大盤 → macro_cache.json
    fetch_broker_chips()    # 分點籌碼 → data/chips/*.json
    build_radar_cache()     # 雷達掃描（從 SQLite 讀）→ SQLite + radar.json