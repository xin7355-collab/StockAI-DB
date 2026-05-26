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
from datetime import date, datetime, timedelta
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

# [Token 輪動] 優先讀 FINMIND_TOKENS（複數），再 fallback 到 FINMIND_TOKEN（向下相容）
_fm_env        = os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')
FINMIND_TOKENS = [t.strip() for t in _fm_env.split(',') if t.strip()]
FINMIND_TOKEN  = FINMIND_TOKENS[0] if FINMIND_TOKENS else ''  # 向下相容舊引用

# [Token 輪動] 全域輪動狀態
_finmind_token_idx: int  = 0      # 目前使用的 Token 索引
_FINMIND_BLOCKED:   bool = False   # 所有 Token 均耗盡時觸發，保護程式不當機


def get_finmind_token() -> str:
    """[Token 輪動] 取得目前輪動中的 FinMind Token；斷路器觸發後回傳空字串"""
    if _FINMIND_BLOCKED or not FINMIND_TOKENS:
        return ''
    return FINMIND_TOKENS[_finmind_token_idx % len(FINMIND_TOKENS)]


def rotate_finmind_token(tried: set) -> bool:
    """
    [Token 輪動] 切換到下一個 Token。
    tried: 本輪已嘗試過的 Token 索引集合。
    回傳 False 表示所有 Token 均已嘗試（觸發斷路器）。
    """
    global _finmind_token_idx, _FINMIND_BLOCKED
    tried.add(_finmind_token_idx % len(FINMIND_TOKENS))
    _finmind_token_idx = (_finmind_token_idx + 1) % len(FINMIND_TOKENS)
    if len(tried) >= len(FINMIND_TOKENS):
        # [Token 輪動] 終極斷路器：4 組 Token 全數耗盡，停止 FinMind 呼叫
        _FINMIND_BLOCKED = True
        print(f'  🚫 [Token 輪動] 所有 {len(FINMIND_TOKENS)} 組 FinMind Token 均已耗盡，觸發斷路器')
        return False
    print(f'  🔄 [Token 輪動] 切換至 Token #{_finmind_token_idx + 1}（共 {len(FINMIND_TOKENS)} 組）')
    return True


def fm_request(url_base: str, timeout: int = 20):
    """
    [Token 輪動] 帶自動輪動的 FinMind API GET 請求統一入口。
    url_base: 不含 &token= 的完整 URL。
    遇到 429 自動切換下一組 Token 並重試；斷路器觸發後回傳 None。
    """
    if _FINMIND_BLOCKED:
        return None
    tried: set = set()
    while True:
        tok = get_finmind_token()
        # [Token 輪動] 有效 Token 才附加，否則匿名請求
        token_param = f'&token={tok}' if tok and '請' not in tok else ''
        try:
            res = requests.get(url_base + token_param, headers=_rnd_hdrs(), timeout=timeout)
        except Exception as e:
            print(f'  ⚠️ [fm_request] 連線失敗: {e}')
            return None
        if res.status_code == 429:
            idx = _finmind_token_idx % max(len(FINMIND_TOKENS), 1)
            print(f'  ⚠️ [Token 輪動] Token #{idx + 1} 收到 429，額度耗盡，自動切換至下一組...')
            if not FINMIND_TOKENS or not rotate_finmind_token(tried):
                return None
            time.sleep(1.0)  # 切換後稍待再打
            continue
        try:
            return res.json()
        except Exception:
            return None
BATCH_INDEX    = int(os.getenv('BATCH_INDEX', '0'))
TOTAL_BATCHES  = int(os.getenv('TOTAL_BATCHES', '1'))
SKIP_GLOBAL    = bool(int(os.getenv('SKIP_GLOBAL', '0')))  # 批次 1-4 略過全市場抓取

# ── 監控清單 ──────────────────────────────────────────────────────────────────
CHIP_WATCHLIST = sorted(set([
    '2330','2317','2454','2382','3231','2303','2881','2886','2002','2603',
    '2308','3711','1301','1303','2801','2884','2885','2892','6505','1216',
    '2207','2301','2327','6415','2357','2395','3034','2379','2376','4938',
    '3105','3529','8069','5347','8299','3293','6142','6274',
    '6488','6515','6770','3037','8046','4977','6278','6191',
    '0050','0056','00878','00929','00919',
]))
HOT_CHIPS_LIMIT = 100   # 分點籌碼 + 基本面 FinMind 呼叫上限（可調整）
FUND_CACHE_DAYS = 7     # 基本面快取有效天數（財報季更新，7天重查一次即可）

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
        res = requests.get(url, headers=_HDRS, timeout=20)
        body = res.text.strip()
        if not body or body[0] == '<':  # 空白或 HTML = 當月尚未公布，靜默略過
            return []
        j = res.json()
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


# ── TWSE 全市場基本面（本益比 / 殖利率 / 股價淨值比）────────────────────────
def fetch_twse_fundamentals(d: date) -> dict:
    """一次查全上市股票的 PE / 殖利率 / PBR（TWSE BWIBBU_d）"""
    d8  = d.strftime('%Y%m%d')
    url = (f'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d'
           f'?response=json&date={d8}&selectType=ALL')
    res = {}
    try:
        j = requests.get(url, headers=_rnd_hdrs(), timeout=20).json()
        if j.get('stat') == 'OK':
            fields = j.get('fields', [])
            fi = lambda kw: next((i for i, f in enumerate(fields) if kw in f), None)
            i_id = fi('證券代號')
            i_yd = fi('殖利率')
            i_pe = fi('本益比')
            i_pb = fi('股價淨值比')
            if None in (i_id, i_yd, i_pe):
                print(f"  ⚠️ BWIBBU_d 欄位找不到：{fields[:6]}")
                return res
            for r in (j.get('data') or []):
                try:
                    sym = str(r[i_id]).strip()
                    def flt(i):
                        v = str(r[i]).replace(',', '').strip()
                        return float(v) if v not in ('--', '') else None
                    res[sym] = {
                        'yield_rate': flt(i_yd),
                        'pe':         flt(i_pe),
                        'pbr':        flt(i_pb) if i_pb is not None else None,
                    }
                except Exception: pass
    except Exception as e:
        print(f"  ⚠️ TWSE BWIBBU_d 失敗: {e}")
    time.sleep(random.uniform(1.5, 2.5))
    return res


# ── FinMind 個股基本面（EPS / YoY / 毛利率趨勢 / 發配率）────────────────────
def fetch_finmind_fundamentals(sym: str) -> dict:
    """
    三支 FinMind API（順序呼叫，各帶 2~3.5s 隨機延遲）：
    1. TaiwanStockFinancialStatements → EPS（最新季）+ 毛利率趨勢（近3季）
    2. TaiwanStockMonthRevenue        → 最新月 YoY
    3. TaiwanStockDividend            → 現金+股票股利 → 股利發配率
    [Token 輪動] 改用 fm_request()，遇 429 自動輪換 Token。
    """
    today_str = date.today().strftime('%Y-%m-%d')
    start_fs  = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d')
    start_rev = (date.today() - timedelta(days=90)).strftime('%Y-%m-%d')
    start_div = (date.today() - timedelta(days=1095)).strftime('%Y-%m-%d')
    result: dict = {}

    # 1. 財務報表 ─────────────────────────────────────────────────────────────
    try:
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockFinancialStatements&data_id={sym}'
               f'&start_date={start_fs}&end_date={today_str}')
        j = fm_request(url, timeout=20)  # [Token 輪動]
        if j is None: j = {}
        rows = j.get('data') or []
        # 最新季 EPS
        eps_rows = sorted([r for r in rows if r.get('type') == 'EPS'],
                          key=lambda x: x.get('date', ''))
        if eps_rows:
            result['eps'] = float(eps_rows[-1].get('value', 0) or 0)
        # 毛利率趨勢（近3季）
        rev_rows = sorted([r for r in rows if r.get('type') == 'Revenue'],
                          key=lambda x: x.get('date', ''))
        gp_rows  = sorted([r for r in rows if r.get('type') == 'GrossProfit'],
                          key=lambda x: x.get('date', ''))
        rev_by_q = {r['date']: float(r.get('value', 0) or 0) for r in rev_rows[-6:]}
        gp_by_q  = {r['date']: float(r.get('value', 0) or 0) for r in gp_rows[-6:]}
        common_q = sorted(set(rev_by_q) & set(gp_by_q))[-3:]
        gms = [round(gp_by_q[q] / rev_by_q[q] * 100, 1)
               for q in common_q if rev_by_q.get(q, 0) > 0]
        if len(gms) >= 2:
            diff  = round(gms[-1] - gms[0], 1)
            arrow = '↑' if diff > 0 else '↓'
            result['gross_margin_trend'] = (
                '→'.join(f'{g}%' for g in gms) + f'（{arrow}{abs(diff)}pp）')
    except Exception as e:
        print(f"    ⚠️ FinMind FS {sym}: {e}")
    time.sleep(random.uniform(2.0, 3.5))

    # 2. 月營收 YoY ─────────────────────────────────────────────────────────
    try:
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockMonthRevenue&data_id={sym}'
               f'&start_date={start_rev}&end_date={today_str}')
        j = fm_request(url, timeout=20)  # [Token 輪動]
        if j is None: j = {}
        rows = sorted(j.get('data') or [], key=lambda x: x.get('date', ''))
        if rows:
            latest = rows[-1]
            yoy = latest.get('revenue_year_growth') or latest.get('RevenueYear')
            if yoy is not None:
                result['revenue_yoy'] = round(float(yoy), 1)
    except Exception as e:
        print(f"    ⚠️ FinMind Revenue {sym}: {e}")
    time.sleep(random.uniform(2.0, 3.5))

    # 3. 股利 → 發配率 ────────────────────────────────────────────────────────
    try:
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockDividend&data_id={sym}'
               f'&start_date={start_div}&end_date={today_str}')
        j = fm_request(url, timeout=20)  # [Token 輪動]
        if j is None: j = {}
        rows = sorted(j.get('data') or [], key=lambda x: x.get('date', ''))
        if rows:
            latest   = rows[-1]
            cash_div = float(latest.get('CashDividend',  0) or 0)
            stk_div  = float(latest.get('StockDividend', 0) or 0)
            total_div = cash_div + stk_div
            result['total_dividend'] = total_div
            eps = result.get('eps')
            if eps and abs(eps) > 0:
                result['payout_ratio'] = round(total_div / (abs(eps) * 4) * 100, 1)
    except Exception as e:
        print(f"    ⚠️ FinMind Dividend {sym}: {e}")
    time.sleep(random.uniform(2.0, 3.5))

    return result


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

    trading_days = get_trading_days(20)

    inst_cache:   dict = {}
    margin_cache: dict = {}
    if not SKIP_GLOBAL:
        print(f"\n📊 批次抓取三大法人 + 融資融券（最近 {len(trading_days)} 個交易日）...")
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
    else:
        print(f"\n⚡ SKIP_GLOBAL=1：跳過法人/融資券抓取（OHLCV 模式）")

    # 從法人資料衍生全市場清單，依批次分割
    watchlist = get_batch_symbols(inst_cache, BATCH_INDEX, TOTAL_BATCHES)
    print(f"\n🎯 批次 {BATCH_INDEX}/{TOTAL_BATCHES}：{len(watchlist)} 檔個股 | 月份: {months}")

    PROGRESS_FILE = f'miner_progress_{BATCH_INDEX}.txt'

    # ── 斷點續傳：偵測上次中斷位置 ──────────────────────────────────────────────
    if os.path.exists(PROGRESS_FILE):
        try:
            last_sym = open(PROGRESS_FILE, encoding='utf-8').read().strip()
            if last_sym in watchlist:
                resume_idx = watchlist.index(last_sym)
                watchlist = watchlist[resume_idx + 1:]
                print(f"🔄 偵測到中斷紀錄（{PROGRESS_FILE}），從 {last_sym} 的下一檔開始，剩餘 {len(watchlist)} 檔待處理")
            else:
                print(f"🔄 進度檔紀錄的 {last_sym} 不在本批清單，從頭開始")
                os.remove(PROGRESS_FILE)
        except Exception:
            pass

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
        latest_valid_date = ""
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
            if row['volume'] is not None and row['volume'] > 0:
                latest_valid_date = fmt_date  # 記錄最新有成交量的交易日

        # ── 🛡️ 防封鎖機制（時間感知版）：盤後才強制覆蓋 ──
        target_today_str = trading_days[-1].strftime('%Y/%m/%d')
        today_record  = existing_map.get(target_today_str, {})
        has_final_chips = today_record.get('foreign_net', 0) != 0

        now = datetime.now()
        is_post_market = (now.hour > 13) or (now.hour == 13 and now.minute >= 40)

        if latest_valid_date == target_today_str and (not is_post_market or has_final_chips):
            print(f"⚡ 本日 K 線與最終籌碼已完整，安全略過證交所請求")
            new_rows = []
        else:
            if is_post_market and latest_valid_date == target_today_str and not has_final_chips:
                print(f"🔄 盤後採礦：K 線存在但籌碼尚未更新，強制重新下載...")
            new_rows = []
            first_ym_empty = False
            for i, ym in enumerate(months):
                rows = twse_ohlcv(sym, ym)
                if not rows: rows = tpex_ohlcv(sym, ym)
                if not rows: time.sleep(0.5); rows = tpex_ohlcv(sym, ym)
                if i == 0 and not rows: first_ym_empty = True
                if i == 1 and first_ym_empty and rows:
                    print(f"  📅 {sym} {months[0]} 無資料，改用 {months[1]}（{len(rows)} 筆）")
                new_rows.extend(rows)
                time.sleep(0.15)

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
                # 盤後終極覆蓋：close 或 volume 不同時強制更新 OHLCV
                price_changed = (rec.get('close') != r.get('close')) or (rec.get('volume') != r.get('volume'))
                if price_changed:
                    rec.update({'open': r['open'], 'high': r['high'], 'low': r['low'],
                                'close': r['close'], 'volume': r['volume']})
                    changed = True
                # 補寫尚未有的籌碼資料
                if rec.get('foreign_net', 0) == 0 and (chip.get('foreign_net', 0) != 0 or chip.get('margin_balance', 0) != 0):
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

        # 斷點續傳：記錄已完成的股票代號（覆蓋寫入）
        try:
            with open(PROGRESS_FILE, 'w', encoding='utf-8') as _pf:
                _pf.write(sym)
        except Exception:
            pass

    # 全批次完成，清除進度檔讓下次排程從頭開始
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)
        print(f"🗑️  進度檔 {PROGRESS_FILE} 已清除")

    db_conn.close()
    print(f"\n🎉 採礦完畢：更新 {updated_total}/{len(watchlist)} 檔。")
    return inst_cache, margin_cache


# ── 外資期貨（改用 FinMind API 防 Ban 版）────────────────────────────────────
def _fetch_futures_taifex_fallback() -> dict | None:
    """
    TAIFEX 公開三大法人台指期備援（不需 Token）。
    抓 TAIFEX 期交所 CSV，解析外資未平倉多空口數。
    """
    try:
        import csv, io
        today = date.today()
        for days_back in range(0, 5):
            d = today - timedelta(days=days_back)
            if d.weekday() >= 5:   # 跳過週末
                continue
            date_tw = d.strftime('%Y/%m/%d')
            url = 'https://www.taifex.com.tw/cht/3/futContractsDateDown'
            params = {'queryStartDate': date_tw, 'queryEndDate': date_tw, 'commodityId': 'TX'}
            res = requests.get(url, params=params, headers=_rnd_hdrs(), timeout=15)
            body = res.content
            if not body:
                continue
            # TAIFEX CSV 為 UTF-8 with BOM，偶爾為 Big5
            for enc in ('utf-8-sig', 'big5', 'utf-8'):
                try:
                    text = body.decode(enc)
                    break
                except Exception:
                    text = None
            if not text:
                continue
            text = text.strip()
            if text.startswith('<') or len(text) < 20:   # HTML 回應 = 無資料
                continue
            reader = csv.reader(io.StringIO(text))
            rows = [r for r in reader if r]
            # 找外資/外資自營商合計列（第1或第2欄含「外資」）
            for row in rows:
                name = (row[0] if row else '') + (row[1] if len(row) > 1 else '')
                if '外資' not in name:
                    continue
                # 格式：期貨契約, 身份別, 多方口數, 多方契約金額, 空方口數, 空方契約金額, 多空淨額
                try:
                    # 嘗試找到包含數字的欄位群
                    nums = []
                    for cell in row[2:]:
                        v = cell.replace(',', '').strip()
                        if v.lstrip('-').isdigit():
                            nums.append(int(v))
                    if len(nums) >= 5:
                        long_oi  = nums[0]   # 多方口數
                        short_oi = nums[2]   # 空方口數
                        net_oi   = long_oi - short_oi
                        if long_oi > 0 or short_oi > 0:
                            print(f"  📡 TAIFEX 備援：外資台指期多={long_oi:,} 空={short_oi:,} 淨={net_oi:+,} ({d})")
                            return {'long': long_oi, 'short': short_oi, 'net': net_oi, 'date': d.strftime('%Y-%m-%d')}
                except Exception:
                    continue
        return None
    except Exception as e:
        print(f"  ⚠️ TAIFEX 備援失敗: {e}")
        return None


def _write_futures_cache(net_oi: int, long_oi: int, short_oi: int, target_date: str):
    today_str = date.today().strftime('%Y-%m-%d')
    cache = {'date': target_date, 'fi_net': net_oi, 'long': long_oi, 'short': short_oi, 'generated': today_str}
    with open('futures_cache.json', 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    print(f"  ✅ 外資台指期淨口數: {net_oi:+,} 口 ({target_date})")


def fetch_futures_cache():
    """
    外資台指期未平倉淨口數。
    主路徑：FinMind TaiwanFuturesInstitutionalInvestors（需 Token）。
    備援路徑：TAIFEX 公開 CSV（不需 Token）。
    """
    today_str = date.today().strftime('%Y-%m-%d')
    start_str = (date.today() - timedelta(days=7)).strftime('%Y-%m-%d')

    url_base = (f'https://api.finmindtrade.com/api/v4/data'
                f'?dataset=TaiwanFuturesInstitutionalInvestors&data_id=TX'
                f'&start_date={start_str}&end_date={today_str}')

    tok_label = f'Token #{_finmind_token_idx + 1}' if FINMIND_TOKENS else '匿名'
    print(f"\n🔮 抓取外資台指期 (使用 FinMind {tok_label} 防封鎖通道 [Token 輪動])...")
    finmind_ok = False
    try:
        # [Token 輪動] 改用 fm_request，遇 429 自動切換並重試
        j = fm_request(url_base, timeout=15)
        if j is None:
            print("  ⚠️ FinMind 期貨 API 失敗（Token 可能缺失或耗盡），改用 TAIFEX 備援...")
        elif j.get('status') == 200 and j.get('data'):
            foreign_data = [d for d in j['data'] if '外資' in d.get('name', '')]

            if foreign_data:
                latest = foreign_data[-1]
                target_date = latest.get('date')

                long_oi_val  = latest.get('long_open_interest_balance') or latest.get('long_open_interest') or latest.get('buy_open_interest')
                short_oi_val = latest.get('short_open_interest_balance') or latest.get('short_open_interest') or latest.get('sell_open_interest')
                net_direct   = latest.get('open_interest_net_volume')
                if not long_oi_val and not short_oi_val and net_direct is not None:
                    print(f"  ℹ️ OI balance 欄位缺失，改用 open_interest_net_volume: {net_direct}")
                    net_oi   = int(net_direct)
                    long_oi  = max(0,  net_oi)
                    short_oi = max(0, -net_oi)
                else:
                    if not long_oi_val and not short_oi_val:
                        print(f"  ⚠️ FinMind 期貨 OI 欄位找不到，available keys: {list(latest.keys())}")
                    long_oi  = int(long_oi_val  or 0)
                    short_oi = int(short_oi_val or 0)
                    net_oi   = long_oi - short_oi

                if long_oi > 0 or short_oi > 0:
                    _write_futures_cache(net_oi, long_oi, short_oi, target_date)
                    finmind_ok = True
                    return
                else:
                    print(f"  ⚠️ FinMind TX 所有 OI 欄位為零，改用 TAIFEX 備援...")
            else:
                print("  ⚠️ FinMind TX 無外資資料（可能今日盤後尚未更新），改用 TAIFEX 備援...")
        else:
            print(f"  ⚠️ FinMind 回傳異常 status={j.get('status') if j else 'None'}，改用 TAIFEX 備援...")
    except Exception as e:
        print(f"  ⚠️ FinMind 外資期貨連線失敗: {e}，改用 TAIFEX 備援...")

    if not finmind_ok:
        result = _fetch_futures_taifex_fallback()
        if result:
            _write_futures_cache(result['net'], result['long'], result['short'], result['date'])
        else:
            print("  ⚠️ FinMind + TAIFEX 均失敗，保留舊快取。")


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
    # ── 動態熱門股清單：CHIP_WATCHLIST（必選）∪ SQLite 近 14 天高量股 ──────────
    priority_set = set(CHIP_WATCHLIST)   # 用戶精選股永遠優先
    if Path(DB_PATH).exists():
        try:
            conn = sqlite3.connect(DB_PATH)
            rows = conn.execute("""
                SELECT symbol, AVG(volume) AS avg_vol
                FROM stock_history
                WHERE trade_date >= date('now', '-14 days')
                  AND volume IS NOT NULL AND volume > 0
                GROUP BY symbol
                ORDER BY avg_vol DESC
            """).fetchall()
            conn.close()
            for sym, _ in rows:
                priority_set.add(sym)
                if len(priority_set) >= HOT_CHIPS_LIMIT:
                    break
        except Exception as e:
            print(f"  ⚠️ 熱門股查詢失敗，回退至 CHIP_WATCHLIST: {e}")
    watchlist = sorted(priority_set)[:HOT_CHIPS_LIMIT]
    print(f"  📋 分點籌碼目標：{len(watchlist)} 檔（精選 {len(CHIP_WATCHLIST)} + 熱門補充）")

    # 新增：一次查全市場 PE / 殖利率（TWSE）
    print("\n📊 抓取 TWSE 全市場本益比 / 殖利率快取...")
    twse_fund = fetch_twse_fundamentals(date.today())
    # [Token 輪動] token_param 已由 fm_request() 統一管理，此處不再需要

    print(f"\n🕵️ 啟動分點籌碼 + 基本面探測 ({len(watchlist)} 檔，請耐心等候避免限流)...")

    updated = 0
    broker_name_map: dict = {}  # 累積 bid→中文名 供 broker_names.json
    for sym in watchlist:
        # ① 提前讀取 out_file → existing_obj（供 TTL 判斷和後面寫入共用）
        out_file = chips_dir / f'{sym}.json'
        existing_obj: dict = {}
        if out_file.exists():
            try:
                raw = json.loads(out_file.read_text(encoding='utf-8'))
                existing_obj = {'chips': raw} if isinstance(raw, list) else raw
            except Exception: pass

        # ── 分點籌碼（抓近 10 交易日窗口，算多週期；初始化移到 try 前）──
        buyers, sellers, brokers_list = [], [], []
        periods: dict = {}
        latest_chip_date = None
        try:
            # [Token 輪動] 改用 fm_request，自動帶 Token 並在 429 時切換
            # 抓 14 天（≈10 交易日）窗口，一次請求成本與單日相同，供多週期聚合
            chip_start = (date.today() - timedelta(days=14)).strftime('%Y-%m-%d')
            url_base = (f'https://api.finmindtrade.com/api/v4/data'
                        f'?dataset=TaiwanStockLocalSecuritiesBrokerTransactions'
                        f'&data_id={sym}&start_date={chip_start}')
            j = fm_request(url_base, timeout=15)
            if j is None: j = {}
            if j.get('status') == 200 and j.get('data'):
                # ── 依日期分組，券商中文名稱絕不丟棄 ──
                by_date: dict = {}   # {date: {bid: {'broker_id','broker_name','net','buy','sel'}}}
                for r in j['data']:
                    d   = r.get('date') or today_str
                    bid = r.get('secBrokerId') or r.get('securities_trader_id') or r.get('broker_id') or ''
                    raw_nm = (r.get('secBrokerName') or r.get('securities_trader') or r.get('broker_name') or '').strip()
                    bnm = TACTICAL_TAGS.get(bid, raw_nm if raw_nm and not raw_nm.isdigit() else bid)
                    buy, sel = int(r.get('buy', 0)), int(r.get('sell', 0))
                    slot = by_date.setdefault(d, {})
                    e = slot.setdefault(bid, {'broker_id': bid, 'broker_name': bnm, 'net': 0, 'buy': 0, 'sel': 0})
                    e['buy'] += buy; e['sel'] += sel; e['net'] += (buy - sel)
                    if bnm and not str(bnm).isdigit():
                        e['broker_name'] = bnm

                if by_date:
                    # 累積券商名稱字典（中文名稱）
                    for d_data in by_date.values():
                        for bid, e in d_data.items():
                            if bid and e['broker_name'] and not str(e['broker_name']).isdigit():
                                broker_name_map[bid] = e['broker_name']

                    # ── 多週期聚合（1/3/5/10 日，各取淨買/淨賣 Top15）──
                    def _agg_period(n: int) -> dict:
                        wdates = sorted(by_date.keys())[-n:]
                        agg: dict = {}
                        for wd in wdates:
                            for b, e in by_date[wd].items():
                                a = agg.setdefault(b, {'broker_id': b, 'broker_name': e['broker_name'], 'net': 0})
                                a['net'] += e['net']
                                if e['broker_name'] and not str(e['broker_name']).isdigit():
                                    a['broker_name'] = e['broker_name']
                        vals = list(agg.values())
                        buy_top  = sorted([x for x in vals if x['net'] > 0], key=lambda x: -x['net'])[:15]
                        sell_top = sorted([x for x in vals if x['net'] < 0], key=lambda x:  x['net'])[:15]
                        return {'buy': buy_top, 'sell': sell_top}
                    periods = {f'{n}d': _agg_period(n) for n in (1, 3, 5, 10)}

                    # ── 最新交易日 → 舊格式 buyers/sellers（向後相容 generate_top_picks）──
                    latest_chip_date = sorted(by_date.keys())[-1]
                    brokers_list = [
                        {'bid': b, 'bnm': e['broker_name'], 'buy': e['buy'], 'sel': e['sel'], 'net': e['net']}
                        for b, e in by_date[latest_chip_date].items()
                    ]
                    buyers  = sorted([b for b in brokers_list if b['net'] > 0], key=lambda x: -x['net'])[:15]
                    sellers = sorted([b for b in brokers_list if b['net'] < 0], key=lambda x: x['net'])[:15]
            time.sleep(3)
        except Exception as e:
            print(f"    ⚠️ 分點籌碼 {sym} 失敗: {e}")
            time.sleep(5)

        # ② 基本面 TTL 快取：若距上次查詢未逾 FUND_CACHE_DAYS 天，跳過 FinMind
        cached_fund = existing_obj.get('fundamentals') or {}
        generated_str = cached_fund.get('generated', '')
        skip_finmind = False
        if generated_str:
            try:
                age_days = (date.today() - date.fromisoformat(generated_str)).days
                skip_finmind = age_days < FUND_CACHE_DAYS
            except Exception: pass

        if skip_finmind:
            print(f"  ⚡ 基本面快取有效（{generated_str}），跳過 FinMind")
            tw_fund = twse_fund.get(sym, {})
            fundamentals = {**cached_fund,
                            'pe':         tw_fund.get('pe') or cached_fund.get('pe'),
                            'yield_rate': tw_fund.get('yield_rate') or cached_fund.get('yield_rate')}
        else:
            print(f"  📈 基本面採礦 {sym}...", end=' ', flush=True)
            fm_fund = fetch_finmind_fundamentals(sym)  # [Token 輪動] token 由 fm_request 統一管理
            tw_fund = twse_fund.get(sym, {})
            fundamentals = {
                'eps':                fm_fund.get('eps'),
                'revenue_yoy':        fm_fund.get('revenue_yoy'),
                'pe':                 tw_fund.get('pe') or fm_fund.get('pe'),
                'yield_rate':         tw_fund.get('yield_rate'),
                'gross_margin_trend': fm_fund.get('gross_margin_trend'),
                'payout_ratio':       fm_fund.get('payout_ratio'),
                'total_dividend':     fm_fund.get('total_dividend'),
                'generated':          today_str,
            }
            print("✅")

        # ③ 寫入新格式 JSON（existing_obj 已在迴圈頂部讀取，不重複讀檔）
        records_map = {r['date']: r for r in existing_obj.get('chips', []) if isinstance(r, dict)}
        rec_date = latest_chip_date or today_str   # 以實際最新交易日為 key（非強制今天）
        if buyers or sellers:
            records_map[rec_date] = {
                'date': rec_date, 'buyers': buyers, 'sellers': sellers,
                'tot_buy': sum(b['buy'] for b in brokers_list),
                'tot_sel': sum(b['sel'] for b in brokers_list)
            }
            updated += 1
        recent_dates = sorted(records_map.keys())[-20:]
        # 本次抓取失敗（429/空）時，保留上次的 periods，避免覆蓋成空
        out_periods = periods if periods else (existing_obj.get('periods') or {})
        output = {
            'fundamentals': fundamentals,
            'data_date': recent_dates[-1] if recent_dates else None,  # 最新可用交易日
            'periods': out_periods,   # 多週期：{1d,3d,5d,10d}，各含 buy/sell（broker_name）
            'chips': [records_map[d] for d in recent_dates]
        }
        out_file.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')

    print(f"  ✅ 分點籌碼完成：更新了 {updated} 檔股票的主力動向")

    # 寫入券商名稱字典（broker_names.json），合併舊資料再更新
    if broker_name_map:
        bn_file = Path(DATA_DIR) / 'broker_names.json'
        existing_bn: dict = {}
        if bn_file.exists():
            try: existing_bn = json.loads(bn_file.read_text(encoding='utf-8'))
            except Exception: pass
        merged_bn = {**existing_bn, **broker_name_map}
        bn_file.write_text(json.dumps(merged_bn, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f"  📋 券商名稱字典更新：{len(merged_bn)} 筆（本次新增/更新 {len(broker_name_map)} 筆）→ broker_names.json")


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


# ── 三位一體選股 ─────────────────────────────────────────────────────────────
def generate_top_picks():
    """三位一體篩選：基本面(YoY>0) + 法人5日淨流入>0 + 分點集中度"""
    results = []
    conn = sqlite3.connect(DB_PATH)
    chips_path = Path(DATA_DIR) / 'chips'

    if not chips_path.exists():
        print("  ⚠️ chips 目錄不存在，跳過 generate_top_picks")
        conn.close()
        return

    for f in sorted(chips_path.glob('*.json')):
        sym = f.stem
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if isinstance(raw, list):
                continue
            fund      = raw.get('fundamentals') or {}
            chips_list = raw.get('chips') or []

            # ① 基本面：revenue_yoy > 0
            try:
                yoy_f = float(fund.get('revenue_yoy') or 0)
            except Exception:
                continue
            if yoy_f <= 0:
                continue

            # ② 法人5日淨流向 > 0（從 SQLite）
            rows = conn.execute("""
                SELECT foreign_inv, invest_trust, dealer_inv
                FROM stock_history WHERE symbol=?
                ORDER BY trade_date DESC LIMIT 5
            """, (sym,)).fetchall()
            if len(rows) < 3:
                continue
            five_day_net = sum((r[0] or 0) + (r[1] or 0) + (r[2] or 0) for r in rows)
            if five_day_net <= 0:
                continue

            # ③ 分點集中度（近3日Top3買超 / 總買超）
            recent = chips_list[-3:]
            total_buy = sum(c.get('tot_buy', 0) for c in recent)
            top3_buy  = sum(
                sum(b.get('buy', 0) for b in
                    sorted(c.get('buyers', []), key=lambda x: -x.get('net', 0))[:3])
                for c in recent
            )
            concentration = round(top3_buy / total_buy * 100, 1) if total_buy > 0 else 0.0

            # 最新收盤
            pr = conn.execute(
                "SELECT close, trade_date FROM stock_history WHERE symbol=? ORDER BY trade_date DESC LIMIT 1",
                (sym,)
            ).fetchone()

            # 入選理由 badge
            reasons = []
            reasons.append('🔥 營收高速增長' if yoy_f >= 20 else '📈 營收成長')
            fi_rows = conn.execute(
                "SELECT foreign_inv FROM stock_history WHERE symbol=? ORDER BY trade_date DESC LIMIT 3",
                (sym,)
            ).fetchall()
            consec_fi = sum(1 for r in fi_rows if (r[0] or 0) > 0)
            if consec_fi >= 3:
                reasons.append('💰 外資連買3日')
            elif five_day_net > 0:
                reasons.append('💰 法人淨流入')
            if concentration >= 40:
                reasons.append('🎯 主力強力建倉')
            elif concentration >= 20:
                reasons.append('🎯 分點籌碼集中')

            results.append({
                'sym':          sym,
                'close':        round(float(pr[0] or 0), 2) if pr else 0,
                'trade_date':   pr[1] if pr else '',
                'revenue_yoy':  round(yoy_f, 1),
                'five_day_net': five_day_net,
                'concentration': concentration,
                'eps':          fund.get('eps'),
                'pe':           fund.get('pe'),
                'reasons':      reasons,
            })
        except Exception as e:
            print(f"  ⚠️ top_picks skip {sym}: {e}")
            continue

    conn.close()

    def _score(x):
        return (min(x['revenue_yoy'], 100) * 0.3 +
                min(abs(x['five_day_net']) / 50000, 100) * 0.4 +
                x['concentration'] * 0.3)
    results.sort(key=_score, reverse=True)

    output = {
        'updated': date.today().isoformat(),
        'count':   len(results),
        'data':    results[:30],
    }
    Path(DATA_DIR).joinpath('top_picks.json').write_text(
        json.dumps(output, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8'
    )
    print(f"  ✅ AI 戰略選股：三位一體篩選 {len(results)} 檔，前 {min(30, len(results))} 名 → top_picks.json")


# ── 主程式 ────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    print("🚀 首席 AI 司令部 — 完全免費採礦機（TWSE/TAIFEX/yfinance）")
    inst_cache, margin_cache = run()                        # 採礦：OHLCV + 法人 → SQLite
    export_json(inst_cache, margin_cache)                   # 匯出 JSON：疊上最新法人快取
    if not SKIP_GLOBAL:
        fetch_futures_cache()   # 外資期貨 → futures_cache.json
        fetch_us_macro_cache()  # 美股大盤 → macro_cache.json
        fetch_broker_chips()    # 分點籌碼 → data/chips/*.json
        build_radar_cache()     # 雷達掃描（從 SQLite 讀）→ SQLite + radar.json
        generate_top_picks()    # 三位一體選股 → data/top_picks.json
    else:
        print("⚡ SKIP_GLOBAL=1：略過籌碼/期貨/美股/雷達（純 OHLCV 批次）")