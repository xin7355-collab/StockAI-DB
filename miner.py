"""
首席 AI 司令部 — 雲端籌碼採礦機 (極速引擎 + 終極 WAL 同步與時間護盾)
資料來源：TWSE / TPEX / TAIFEX 官方免費 API + MIS 快照 + yfinance + FinMind(匿名)
特色：無痛部署、無須 API Token、1GB RAM 記憶體極限防禦、SQLite WAL 讀寫分離、智慧市場判定、ETF字母防誤殺
"""
import csv
import json
import math
import os
import random
import re
import signal
import sqlite3
import requests
import io
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import time
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

# ── 🎯 分點 Sniper 選用相依(雲端 batch 0 才裝;裝不到就靜默退回 FinMind)──
# Pillow 10+ 移除 ANTIALIAS 會讓 ddddocr 啟動崩潰,先補相容墊片
try:
    from PIL import Image as _PILImage
    if not hasattr(_PILImage, 'ANTIALIAS'):
        _PILImage.ANTIALIAS = _PILImage.LANCZOS
except Exception:
    pass
try:
    import ddddocr as _ddddocr
except Exception:
    _ddddocr = None
try:
    from bs4 import BeautifulSoup as _BeautifulSoup
except Exception:
    _BeautifulSoup = None


# ── ⏱️ SIGALRM 硬逾時護盾：包住「無 timeout 參數」的阻塞呼叫（主因 yfinance.history 會無限 hang）──
class _HardTimeout(Exception):
    pass


def _alarm_handler(signum, frame):
    raise _HardTimeout()


def call_with_timeout(fn, secs, default, *args, **kwargs):
    """在主執行緒用 SIGALRM 強制中斷阻塞呼叫；逾時回傳 default，永不讓單一呼叫卡死整批採礦。
    僅在主執行緒有效（miner.py 單執行緒，OK）。非 Unix 或無 SIGALRM 時退化為直接呼叫。"""
    if not hasattr(signal, 'SIGALRM'):
        try:
            return fn(*args, **kwargs)
        except Exception:
            return default
    old = signal.signal(signal.SIGALRM, _alarm_handler)
    signal.alarm(int(secs))
    try:
        return fn(*args, **kwargs)
    except _HardTimeout:
        print(f"  ⏱️ {getattr(fn, '__name__', 'call')} 逾時 {secs}s，跳過（防 hang）")
        return default
    except Exception:
        return default
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)

# 【修復】極限防禦準則第 4 條：初始化具備自動退避重試機制的全局 Session
http_session = requests.Session()
retry_strategy = Retry(
    total=3,                # 總共重試 3 次
    backoff_factor=1.5,     # 每次重試間隔: 1.5s, 3s, 6s...
    status_forcelist=[429, 500, 502, 503, 504], # 遇到限流或伺服器錯誤自動重試
    allowed_methods=["HEAD", "GET", "OPTIONS"]
)
adapter = HTTPAdapter(max_retries=retry_strategy)
http_session.mount("https://", adapter)
http_session.mount("http://", adapter)

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
            res = http_session.get(url_base + token_param, headers=_rnd_hdrs(), timeout=timeout)
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
# 涵蓋前端 _RADAR_POOLS（上市熱門/上櫃中小型/高股息ETF）+ 9 大資金板塊指標股，
# 確保前端雷達分頁的每一類都能 filter 到資料。
CHIP_WATCHLIST = sorted(set([
    # 上市熱門大將（前端 hot_twse 40 檔）
    '2330','2317','2454','2382','3231','2303','2881','2886','2002','2603',
    '2308','3711','1301','1303','2801','2884','2885','2892','6505','1216',
    '2207','2301','2327','6415','2357','2395','3034','2379','2376','4938',
    '3105','3529','8069','5347','8299','3293','6142','6274',
    # 上櫃活潑中小型（前端 hot_otc 24 檔）
    '6488','6515','6770','3037','8046','4977','6278','6191',
    # 高股息與權值 ETF（前端 etf_heavy 10 檔）
    '0050','0056','00878','00929','00919',
    '00713','00692','006208','00900','00939',   # ← 新增 5 檔（之前缺失導致該類別半壞）
    '00981A','00988A',
    # 9 大資金板塊指標股（與頂部指揮部 sector matrix 對齊）
    '2382','6669',                              # 伺服器代工：廣達、緯穎（緯創 3231 已在）
    '1519','1503','1513',                       # 重電基建：華城、士電、中興電
    '2330','3711','3105',                       # 先進封裝：台積電(在)、矽品(在)、PMC
    '3450','3380','6491',                       # 高速傳輸 CPO：聯亞光電、明泰、晶碩
    '3017','3324','3653',                       # 散熱：奇鋐、雙鴻、健策
    '2049','4551','2206',                       # 實體機器人：上銀、智伸科、三陽
    '2881','2882','2891',                       # 金融避風港：富邦金、國泰金、中信金
    '3491','2313','6285',                       # 低軌衛星：昇達科、華通、啟碁
    '2408','2344','8299',                       # 記憶體 DRAM：南亞科、華邦電、群聯（8299 已在,補 2408/2344 確保板塊每輪必採）
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


# ── 【同步 API WAL 防禦裝甲】統一連線管理 ────────────────────────────────────
def get_db_conn():
    """確保所有寫入動作皆開啟 WAL 模式，避免與 api.py 的讀取產生衝突鎖死"""
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


# ── 資料庫 ────────────────────────────────────────────────────────────────────
def init_db():
    conn = get_db_conn()
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
    conn = get_db_conn()
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
    """TWSE 上市股月 OHLCV。year_month='YYYYMM'。將超時降為10秒防卡死"""
    url = (f'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY'
           f'?response=json&date={year_month}01&stockNo={symbol}')
    try:
        j = http_session.get(url, headers=_HDRS, timeout=10).json()
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
    except (json.JSONDecodeError, ValueError):
        # 興櫃 006xxx 等 TWSE 無資料的股票會回空字串，靜默略過避免 log 淹沒
        return []
    except Exception as e:
        print(f"  ⚠️  TWSE STOCK_DAY {symbol} {year_month}: {e}")
        return []


def tpex_ohlcv(symbol: str, year_month: str) -> list:
    """TPEX 上櫃股月 OHLCV。year_month='YYYYMM'。將超時降為10秒防卡死"""
    y, m = int(year_month[:4]), year_month[4:]
    roc_year = y - 1911
    url = (f'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/'
           f'st43_result.php?l=zh-tw&d={roc_year}/{m}&stkno={symbol}&o=json')
    try:
        res = http_session.get(url, headers=_HDRS, timeout=10)
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


# ── yfinance OHLCV 補洞（TWSE/TPEX 回應不全時用 Yahoo Finance 補檔）─────────
def yfinance_ohlcv_fallback(symbol: str, market_type: str, days_back: int = 30) -> list:
    """
    用 yfinance 抓近 days_back 天的 OHLCV，回傳跟 twse_ohlcv 同格式的 rows。
    market_type='twse' → {symbol}.TW，'tpex' → {symbol}.TWO，None 兩個都試。
    失敗或無資料回 [] 不 raise。
    """
    try:
        import yfinance as yf
    except ImportError:
        return []
    tickers = []
    if market_type == 'twse':
        tickers = [f'{symbol}.TW']
    elif market_type == 'tpex':
        tickers = [f'{symbol}.TWO']
    else:
        tickers = [f'{symbol}.TW', f'{symbol}.TWO']
    for tk in tickers:
        try:
            # 🛡️ yfinance.history 無 timeout 參數、網路卡死會無限 hang → SIGALRM 硬逾時 30s
            hist = call_with_timeout(
                lambda: yf.Ticker(tk).history(period=f'{days_back}d', auto_adjust=False),
                30, None)
            if hist is None or hist.empty:
                continue
            out = []
            for idx, row in hist.iterrows():
                cls = float(row.get('Close', 0) or 0)
                if cls <= 0:
                    continue
                date_str = idx.strftime('%Y/%m/%d')
                out.append({
                    'date':   date_str,
                    'open':   float(row.get('Open',  cls) or cls),
                    'high':   float(row.get('High',  cls) or cls),
                    'low':    float(row.get('Low',   cls) or cls),
                    'close':  cls,
                    'volume': int(row.get('Volume', 0) or 0),
                })
            return out
        except Exception as e:
            print(f"  ⚠️ yfinance {tk}: {e}")
            continue
    return []


# ── TWSE MIS 快照補丁 (盤中防退回昨日) ──────────────────────────────────────
def fetch_mis_closing_snapshot(sym: str) -> dict:
    """證交所 MIS 盤中/盤後快照補丁，填補歷史 API 尚未更新的真空期"""
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_{sym}.tw|otc_{sym}.tw"
    try:
        res = http_session.get(url, timeout=5, headers={'User-Agent': random.choice(_UA_LIST)}).json()
        if res.get('msgArray'):
            msg = res['msgArray'][0]
            z = msg.get('z', '-')
            live_price = float(z) if z != '-' else float(msg.get('y', 0))
            if live_price > 0:
                tw_now = datetime.now(timezone(timedelta(hours=8)))
                return {
                    'date': tw_now.strftime('%Y/%m/%d'),
                    'open': float(msg.get('o', live_price) if msg.get('o', '-') != '-' else live_price),
                    'high': float(msg.get('h', live_price) if msg.get('h', '-') != '-' else live_price),
                    'low': float(msg.get('l', live_price) if msg.get('l', '-') != '-' else live_price),
                    'close': live_price,
                    'volume': int(msg.get('v', 0))
                }
    except Exception:
        pass
    return {}


# ── TWSE 三大法人（每日全市場批次）──────────────────────────────────────────
def fetch_market_institutional(d: date) -> dict:
    """整合 TWSE (上市) 與 TPEX (上櫃) 的三大法人買賣超；缺漏時用 FinMind 補齊"""
    res = {}
    d8 = d.strftime('%Y%m%d')
    d_iso = d.strftime('%Y-%m-%d')
    roc_y = d.year - 1911
    d_tpex = f"{roc_y}/{d.strftime('%m/%d')}"

    # 1. 抓取上市 (TWSE T86)
    try:
        url = f'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date={d8}&selectType=ALL'
        j = http_session.get(url, headers=_rnd_hdrs(), timeout=15).json()
        if j.get('stat') == 'OK':
            fields = j.get('fields', [])
            idx_id = next((i for i, f in enumerate(fields) if '證券代號' in f), None)
            idx_f  = next((i for i, f in enumerate(fields) if '外' in f and '買賣超' in f), None)
            idx_t  = next((i for i, f in enumerate(fields) if '投信買賣超' in f), None)
            idx_d  = next((i for i, f in enumerate(fields) if '自營商買賣超股數' in f and '自行' not in f and '避險' not in f and '外' not in f), None)
            if idx_d is None:
                # T86 schema 變動時：「自行買賣」+「避險」加總，明確排除「外」字避免抓到「外資自營商買賣超股數」(極小或 0)
                idx_d_self  = next((i for i, f in enumerate(fields) if '自營' in f and '自行' in f and '買賣超' in f and '外' not in f), None)
                idx_d_hedge = next((i for i, f in enumerate(fields) if '自營' in f and '避險' in f and '買賣超' in f and '外' not in f), None)
            else:
                idx_d_self = idx_d_hedge = None
            if idx_d is not None:
                print(f"  [T86] dealer col idx={idx_d}: {fields[idx_d]}")
            elif idx_d_self is not None and idx_d_hedge is not None:
                print(f"  [T86] dealer = self({idx_d_self})+hedge({idx_d_hedge}): {fields[idx_d_self]} + {fields[idx_d_hedge]}")
            if None in (idx_id, idx_f, idx_t) or (idx_d is None and (idx_d_self is None or idx_d_hedge is None)):
                print(f"  ⚠️ 上市法人欄位找不到，headers={fields}")
                return res
            for r in (j.get('data') or []):
                try:
                    if idx_d is not None:
                        dealer_net = int(str(r[idx_d]).replace(',',''))
                    else:
                        ds = int(str(r[idx_d_self]).replace(',','')) if idx_d_self is not None else 0
                        dh = int(str(r[idx_d_hedge]).replace(',','')) if idx_d_hedge is not None else 0
                        dealer_net = ds + dh
                    res[str(r[idx_id]).strip()] = {
                        'foreign_net': int(str(r[idx_f]).replace(',','')),
                        'trust_net':   int(str(r[idx_t]).replace(',','')),
                        'dealer_net':  dealer_net,
                    }
                except (ValueError, IndexError): pass
    except Exception as e: print(f"  ⚠️ 上市法人失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    # 2. 抓取上櫃 (TPEX)
    try:
        url_otc = f'https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d={d_tpex}'
        j = http_session.get(url_otc, headers=_rnd_hdrs(), timeout=15).json()
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

    # 3. FinMind 備援：TPEX 新版 API 可能變動，缺漏的上櫃股（如 8299/4904）用 FinMind 補齊
    if not _FINMIND_BLOCKED:
        try:
            url_fm = (
                f'https://api.finmindtrade.com/api/v4/data'
                f'?dataset=TaiwanStockInstitutionalInvestorsBuySell'
                f'&start_date={d_iso}&end_date={d_iso}'
            )
            j_fm = fm_request(url_fm, timeout=20)
            cnt_new = 0
            # FinMind 一檔股票會回多列（每個 institution 一列），需要依 stock_id 聚合
            agg = {}
            for row in ((j_fm or {}).get('data') or []):
                sid = str(row.get('stock_id') or '').strip()
                if not _valid_stock(sid):
                    continue
                a = agg.setdefault(sid, {'foreign_net': 0, 'trust_net': 0, 'dealer_net': 0})
                inst = (row.get('name') or '').strip()
                net  = (row.get('buy') or 0) - (row.get('sell') or 0)
                if '外資' in inst:
                    a['foreign_net'] += int(net)
                elif '投信' in inst:
                    a['trust_net'] += int(net)
                elif '自營' in inst:
                    a['dealer_net'] += int(net)
            for sid, v in agg.items():
                if sid not in res:
                    res[sid] = v
                    cnt_new += 1
            print(f"  [FinMind 法人] 補齊 {cnt_new} 檔（多半為上櫃股 / TPEX 失敗的票）")
        except Exception as e:
            print(f"  ⚠️ [FinMind 法人] 備援失敗：{e}")

    return res


def fetch_market_margin(d: date) -> dict:
    """整合 TWSE (上市) 與 TPEX (上櫃) 的融資融券餘額；TWSE 失敗時用 FinMind fallback"""
    res = {}
    d8 = d.strftime('%Y%m%d')
    d_iso = d.strftime('%Y-%m-%d')
    roc_y = d.year - 1911
    d_tpex = f"{roc_y}/{d.strftime('%m/%d')}"

    # 1. 抓取上市 (TWSE MI_MARGN)
    try:
        url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={d8}&selectType=ALL'
        j = http_session.get(url, headers=_rnd_hdrs(), timeout=15).json()
        print(f"  [MI_MARGN] stat={j.get('stat')} tables={len(j.get('tables', []) or [])}")
        if j.get('stat') != 'OK':
            # 🔍 診斷強化:stat 非 OK 時印 raw 前 300 字,GHA log 一眼看出是限流/無資料/格式變更
            print(f"  ⚠️ [MI_MARGN] stat != OK,raw={str(j)[:300]}")
        if j.get('stat') == 'OK':
            tables = j.get('tables', []) or []
            # 🛡️【關鍵修復】MI_MARGN 回傳多個 table，舊版誤抓「市場總計表」(僅 3-7 列、
            # key 變成 8,873,952 之類的總計數字)。改為：在每個含「股票代號」欄位的 table 中，
            # 挑「id 欄含最多合法股號」的那張個股表（~1500 列），徹底避開總計表。
            best = None  # (valid_count, table, idx_id)
            for t in tables:
                fields = t.get('fields', []) or []
                idx_id = next((i for i, f in enumerate(fields)
                               if '股票代號' in (f or '') or '證券代號' in (f or '')), None)
                if idx_id is None:
                    continue
                data = t.get('data', []) or []
                valid = sum(1 for r in data
                            if len(r) > idx_id and _valid_stock(str(r[idx_id]).strip()))
                if valid > 50 and (best is None or valid > best[0]):
                    best = (valid, t, idx_id)

            if best is None:
                titles = [t.get('title', '') for t in tables]
                print(f"  ⚠️ 上市融資券找不到個股表（無 table id 欄含 >50 股號）；tables 標題={titles}")
            else:
                _, target_table, idx_id = best
                fields = target_table.get('fields', [])
                # 🔍 欄位定位多級 fallback:先精確(融資+今日/現在餘額)→ 再寬鬆(含「資/券」+「餘」排除買賣進出)
                def _find_col(fields, key1):
                    # key1 = '融資' or '融券';先精確後寬鬆,涵蓋 TWSE 各種 schema 變體
                    exact = next((i for i, f in enumerate(fields) if key1 in (f or '') and ('今日餘額' in f or '現在餘額' in f)), None)
                    if exact is not None:
                        return exact
                    loose = next((i for i, f in enumerate(fields) if key1 in (f or '') and '餘額' in f and '買進' not in f and '賣出' not in f and '償還' not in f), None)
                    if loose is not None:
                        return loose
                    # 最寬鬆:單字「資/券」+「餘」(對付欄名被簡寫)
                    short_key = key1[-1]   # '資' or '券'
                    return next((i for i, f in enumerate(fields) if short_key in (f or '') and '餘' in (f or '') and '買' not in (f or '') and '賣' not in (f or '')), None)
                idx_mb = _find_col(fields, '融資')
                idx_sb = _find_col(fields, '融券')
                print(f"  [MI_MARGN] 選中個股表：{best[0]} 檔 | 融資欄 idx={idx_mb} 融券欄 idx={idx_sb} | fields={fields}")
                if idx_mb is None or idx_sb is None:
                    # 🔍 找不到欄位印完整 fields(已在上行),GHA log 比對真實欄名後可再放寬條件
                    print(f"  ⚠️ 融資/融券餘額欄位找不到(idx_mb={idx_mb} idx_sb={idx_sb})，完整 fields={fields}")
                else:
                    short_zero = 0
                    for r in target_table.get('data', []):
                        sid = str(r[idx_id]).strip()
                        if not _valid_stock(sid):   # 跳過總計列 / 非個股列
                            continue
                        try:
                            sb = int(str(r[idx_sb]).replace(',', ''))
                            res[sid] = {
                                'margin_balance': int(str(r[idx_mb]).replace(',', '')),
                                'short_balance':  sb,
                            }
                            if sb == 0:
                                short_zero += 1
                        except Exception:
                            pass
                    # 🔍 若融券「全部」為 0(實務不可能,2330/2603 一定有券)= 欄位抓錯,印警告供診斷
                    if res and short_zero == len(res):
                        print(f"  ⚠️ [MI_MARGN] 融券餘額全 0({len(res)} 檔),疑欄位 idx_sb={idx_sb} 抓錯,fields={fields}")
    except Exception as e: print(f"  ⚠️ 上市融資券失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    # 2. 抓取上櫃 (TPEX)
    try:
        url_otc = f'https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d={d_tpex}'
        j = http_session.get(url_otc, headers=_rnd_hdrs(), timeout=15).json()
        for r in (j.get('aaData') or []):
            sid = str(r[0]).strip()
            if not _valid_stock(sid):   # 跳過總計列 / 非個股列
                continue
            try:
                res[sid] = {
                    'margin_balance': int(str(r[6]).replace(',','')), # 融資現在餘額
                    'short_balance': int(str(r[13]).replace(',',''))  # 融券現在餘額
                }
            except: pass
    except Exception as e: print(f"  ⚠️ 上櫃融資券失敗: {e}")
    time.sleep(random.uniform(3.0, 5.0))

    # 3. FinMind 備援：兩種情況啟動 —(a) TWSE/TPEX 整批失敗;(b) 有資料但融券全 0(TWSE 欄位抓錯)
    #    後者是融券長期全 0 的根因:TWSE 給了融資卻漏融券,改由 FinMind 整批覆蓋補回融券
    _short_all_zero = bool(res) and all((v.get('short_balance', 0) == 0) for v in res.values())
    if (not res or _short_all_zero) and not _FINMIND_BLOCKED:
        reason = "TWSE+TPEX 兩條都失敗" if not res else f"融券全 0({len(res)} 檔,疑 TWSE 欄位抓錯)"
        print(f"  ⚠️ [融資券] {reason}，啟動 FinMind TaiwanStockMarginPurchaseShortSale 備援…")
        try:
            url_fm = (
                f'https://api.finmindtrade.com/api/v4/data'
                f'?dataset=TaiwanStockMarginPurchaseShortSale'
                f'&start_date={d_iso}&end_date={d_iso}'
            )
            j_fm = fm_request(url_fm, timeout=20)
            cnt = 0
            for row in ((j_fm or {}).get('data') or []):
                sid = str(row.get('stock_id') or '').strip()
                if not _valid_stock(sid):
                    continue
                try:
                    res[sid] = {
                        'margin_balance': int(row.get('MarginPurchaseTodayBalance') or 0),
                        'short_balance':  int(row.get('ShortSaleTodayBalance')      or 0),
                    }
                    cnt += 1
                except Exception:
                    pass
            print(f"  [FinMind 融資券] 命中 {cnt} 檔")
        except Exception as e:
            print(f"  ⚠️ [FinMind 融資券] 備援失敗：{e}")

    # 4. 🦅 yfinance 第三條源(僅 CHIP_WATCHLIST ~50 檔,因 yf.info 慢 + 不一定每檔有)
    #    TWSE+FinMind 都失敗時觸發,info 含 sharesShort/shortRatio 可近似填補融券
    #    注意:yfinance shares 單位是「股」,÷1000 = 張(對齊 short_balance 慣例);抓不到就不寫
    _all_short_zero = bool(res) and all((v.get('short_balance', 0) == 0) for v in res.values())
    if (not res or _all_short_zero):
        print(f"  🦅 [yfinance 融券] TWSE+FinMind 後仍空,啟動 yfinance 第三條源(僅 CHIP_WATCHLIST {len(CHIP_WATCHLIST)} 檔)…")
        try:
            import yfinance as yf
            hit = 0
            for sid in CHIP_WATCHLIST:
                if not _valid_stock(sid):
                    continue
                try:
                    info = yf.Ticker(f"{sid}.TW").info  # {sym}.TW = TWSE/TPEX 通用
                    ss = info.get('sharesShort')
                    if ss is not None and ss > 0:
                        # 已有 margin_balance 則合併(yfinance 沒提供融資);無則 0 佔位
                        prev = res.get(sid, {})
                        res[sid] = {
                            'margin_balance': prev.get('margin_balance', 0),
                            'short_balance':  int(ss) // 1000,   # 股 → 張
                        }
                        hit += 1
                except Exception:
                    continue
            print(f"  [yfinance 融券] CHIP_WATCHLIST 命中 {hit} 檔")
        except ImportError:
            print(f"  ⚠️ [yfinance 融券] yfinance 未安裝,跳過")
        except Exception as e:
            print(f"  ⚠️ [yfinance 融券] 備援失敗:{e}")

    return res


# ── TWSE 全市場基本面（本益比 / 殖利率 / 股價淨值比）────────────────────────
def fetch_twse_fundamentals(d: date) -> dict:
    """一次查全上市股票的 PE / 殖利率 / PBR（TWSE BWIBBU_d）"""
    d8  = d.strftime('%Y%m%d')
    url = (f'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d'
           f'?response=json&date={d8}&selectType=ALL')
    res = {}
    try:
        j = http_session.get(url, headers=_rnd_hdrs(), timeout=20).json()
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


# ── FinMind 全台券商代碼→中文名對照（免費無 Token）────────────────────────────
def _load_broker_info_map() -> dict:
    """
    呼叫 FinMind TaiwanBrokerInfo 資料集（完全免費，不消耗 Token 額度），
    一次取得全台 ~900 家券商代碼 → 中文名稱對照表。
    優先順序：TACTICAL_TAGS > FinMind 回傳的 raw_nm > 此對照表 > 數字代碼。
    """
    url = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanBrokerInfo'
    for attempt in range(3):
        try:
            res = http_session.get(url, headers=_rnd_hdrs(), timeout=15)
            body = res.text.strip()
            if not body or body[0] == '<':
                raise ValueError('非 JSON 回應')
            j = res.json()
            if j.get('msg') == 'success' and j.get('data'):
                mapping: dict = {}
                for b in j['data']:
                    bid = str(b.get('broker_id') or b.get('securities_trader_id') or '').strip()
                    nm  = str(b.get('broker_name') or b.get('securities_trader') or '').strip()
                    if bid and nm and not nm.isdigit():
                        mapping[bid] = nm
                print(f"  📖 TaiwanBrokerInfo 載入：{len(mapping)} 家券商代碼→中文名")
                return mapping
            else:
                print(f"  ⚠️ TaiwanBrokerInfo 回傳異常: {str(j)[:80]}")
                break
        except Exception as e:
            print(f"  ⚠️ TaiwanBrokerInfo 第{attempt+1}次失敗: {e}")
            if attempt < 2:
                time.sleep(5)
    return {}


# ── FinMind 個股基本面（含 Q1~Q4 履歷、次季預估、創新高雷達）────────────────
def fetch_finmind_fundamentals(sym: str) -> dict:
    today_str = date.today().strftime('%Y-%m-%d')
    start_fs  = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d') # 近2年財報
    start_rev = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d') # 近2年營收
    start_div = (date.today() - timedelta(days=1095)).strftime('%Y-%m-%d')
    result: dict = {}

    # 1. 財務報表 (Q1~Q4 EPS 歷史與毛利) ──────────────────────────────
    try:
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockFinancialStatements&data_id={sym}'
               f'&start_date={start_fs}&end_date={today_str}')
        j = fm_request(url, timeout=20)
        if j is None: j = {}
        rows = j.get('data') or []
        
        # 處理 EPS 與 Q1~Q4 歷史標籤
        eps_rows = sorted([r for r in rows if r.get('type') == 'EPS'], key=lambda x: x.get('date', ''))
        if eps_rows:
            result['eps'] = float(eps_rows[-1].get('value', 0) or 0)
            eps_history = []
            for r in eps_rows[-6:]:  # 抓取最近 6 季
                d_str = r.get('date', '')
                val = r.get('value', 0)
                if '-03-' in d_str: q = 'Q1'
                elif '-06-' in d_str or '-05-' in d_str: q = 'Q2'
                elif '-09-' in d_str or '-08-' in d_str: q = 'Q3'
                elif '-12-' in d_str or '-11-' in d_str: q = 'Q4'
                else: q = 'Q?'
                eps_history.append(f"{d_str[:4]} {q} EPS: {val}")
            result['eps_history'] = eps_history

        # 處理毛利率趨勢
        rev_rows = sorted([r for r in rows if r.get('type') == 'Revenue'], key=lambda x: x.get('date', ''))
        gp_rows  = sorted([r for r in rows if r.get('type') == 'GrossProfit'], key=lambda x: x.get('date', ''))
        rev_by_q = {r['date']: float(r.get('value', 0) or 0) for r in rev_rows[-6:]}
        gp_by_q  = {r['date']: float(r.get('value', 0) or 0) for r in gp_rows[-6:]}
        common_q = sorted(set(rev_by_q) & set(gp_by_q))[-3:]
        gms = [round(gp_by_q[q] / rev_by_q[q] * 100, 1) for q in common_q if rev_by_q.get(q, 0) > 0]
        if len(gms) >= 2:
            diff  = round(gms[-1] - gms[0], 1)
            arrow = '↑' if diff > 0 else '↓'
            result['gross_margin_trend'] = (
                '→'.join(f'{g}%' for g in gms) + f'（{arrow}{abs(diff)}pp）')
        # 最近4季 EPS + Revenue 摘要（季別格式：date 欄直接用）
        rev_sorted = sorted([r for r in rows if r.get('type') == 'Revenue'],
                            key=lambda x: x.get('date', ''))
        rev_by_date = {r['date']: float(r.get('value', 0) or 0) for r in rev_sorted}
        quarterly = []
        for er in eps_rows[-4:]:
            qdate = er.get('date', '')
            quarterly.append({
                'period':  qdate,
                'eps':     round(float(er.get('value', 0) or 0), 2),
                'revenue': rev_by_date.get(qdate, 0),
            })
        if quarterly:
            result['quarterly_eps'] = quarterly
    except Exception as e:
        print(f"    ⚠️ FinMind FS {sym}: {e}")
    time.sleep(random.uniform(2.0, 3.5))

    # 2. 月營收 YoY + 歷史新高判定 ────────────────────────────────────────────
    try:
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockMonthRevenue&data_id={sym}'
               f'&start_date={start_rev}&end_date={today_str}')
        j = fm_request(url, timeout=20)
        if j is None: j = {}
        rows = sorted(j.get('data') or [], key=lambda x: x.get('date', ''))
        if rows:
            latest = rows[-1]
            yoy = latest.get('revenue_year_growth') or latest.get('RevenueYear')
            if yoy is not None:
                result['revenue_yoy'] = round(float(yoy), 1)
            # 歷史新高判定：當月營收 vs 前 23 個月最大值
            latest_rev = float(latest.get('revenue', 0) or 0)
            result['latest_revenue'] = latest_rev
            if len(rows) >= 2 and latest_rev > 0:
                prior_max = max(float(r.get('revenue', 0) or 0) for r in rows[:-1])
                result['is_record_high'] = latest_rev >= prior_max
            else:
                result['is_record_high'] = False
    except Exception as e:
        print(f"    ⚠️ FinMind Revenue {sym}: {e}")
    time.sleep(random.uniform(2.0, 3.5))

    # 3. 股利與發配率 ──────────────────────────────
    try:
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockDividend&data_id={sym}'
               f'&start_date={start_div}&end_date={today_str}')
        j = fm_request(url, timeout=20)
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
    conn = get_db_conn()
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
            LIMIT 1200
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
def _valid_stock(s) -> bool:
    """一般股票（4碼純數字）或 ETF（00 開頭，支援 00981A 等），排除權證"""
    s = str(s)
    return (s.isdigit() and len(s) == 4) or s.startswith('00')


def get_batch_symbols(inst_cache: dict, batch_idx: int = 0, total: int = 1) -> list:
    """依批次分割全市場清單。

    ⚡【關鍵】所有 batch 都用「相同的宇宙」(data/ glob ∪ CHIP_WATCHLIST) 做分割，
    確保 20 個批次的切片完全對齊、彼此不重疊 → 每檔股票只會被 1 個 batch 採礦，
    從根本消除 artifact 合併時的同名檔衝突（K線凍結主因之一）。
    inst_cache 僅用於：batch 0 額外補進「今日活躍但尚無 JSON」的新上市股。
    """
    skip = {'radar', 'futures_cache', 'macro_cache', 'broker_names',
            'top_picks', 'global_news', 'radar_news', 'tech_giants_news'}
    universe: set = set(CHIP_WATCHLIST)
    universe |= {f.stem for f in Path(DATA_DIR).glob('*.json') if f.stem not in skip}
    universe = {s for s in universe if _valid_stock(s)}
    sorted_syms = sorted(universe)

    if total <= 1:
        base = list(sorted_syms)
    else:
        size  = math.ceil(len(sorted_syms) / total)
        start = batch_idx * size
        end   = min(start + size, len(sorted_syms))
        base  = sorted_syms[start:end]

    # batch 0 額外納入「今日活躍但尚無 JSON」的新上市股（只在 batch 0，避免重疊）
    if batch_idx == 0 and inst_cache:
        actives: set = set()
        for day_data in inst_cache.values():
            actives.update(day_data.keys())
        new_listings = sorted({s for s in actives if _valid_stock(s)} - universe)
        if new_listings:
            base = list(base) + new_listings
            print(f"  🆕 batch 0 額外納入 {len(new_listings)} 檔新上市股")

    return list(base)


def get_trading_days(n=30):
    """最近 n 個交易日（跳週末）"""
    days, d = [], date.today()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return sorted(days)


def seed_db_from_json(watchlist: list) -> None:
    """🌱 把 checkout 下來的 data/<sym>.json 種回 SQLite，保留完整歷史。

    GitHub Actions 每次 run 都是全新空白 SQLite（.db 被 gitignore），
    若不種回，existing_map 會是空的 → 採礦只抓最近 3 個月 → export 把歷史覆寫掉。
    此函式讓 existing_map 取得完整歷史，採礦只「補新天」，且缺口偵測能正確補回。
    """
    seeded = rows_total = 0
    conn = get_db_conn()
    cur  = conn.cursor()
    for sym in watchlist:
        p = Path(DATA_DIR) / f'{sym}.json'
        if not p.exists():
            continue
        try:
            rows = json.loads(p.read_text(encoding='utf-8'))
            if not isinstance(rows, list) or not rows:
                continue
            batch = [
                (sym,
                 str(r['date']).replace('/', '-'),
                 r.get('open'), r.get('high'), r.get('low'),
                 r.get('close'), r.get('volume'),
                 r.get('foreign_net', 0),    r.get('trust_net', 0),
                 r.get('dealer_net', 0),
                 r.get('margin_balance', 0), r.get('short_balance', 0))
                for r in rows if r.get('date')
            ]
            cur.executemany(
                "INSERT OR REPLACE INTO stock_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                batch)
            seeded += 1
            rows_total += len(batch)
        except Exception as e:
            # 單檔壞掉不影響其他檔
            print(f"  ⚠️ 種子回填 {sym} 失敗：{e}")
    conn.commit()
    conn.close()
    print(f"🌱 種子回填完成：{seeded} 檔歷史載入 SQLite（共 {rows_total} 筆），採礦將只補新天")


# ── 主採礦：TWSE 完全免費版 ──────────────────────────────────────────────────
def run():
    today = date.today()

    months = []
    cur = today.replace(day=1)
    for _ in range(3):
        months.append(cur.strftime('%Y%m'))
        cur = (cur - timedelta(days=1)).replace(day=1)

    trading_days = get_trading_days(20)

    inst_cache:   dict = {}
    margin_cache: dict = {}
    MARGIN_CACHE_FILE = Path('margin_cache_stock.json')
    INST_CACHE_FILE   = Path('inst_cache_stock.json')
    if not SKIP_GLOBAL:
        print(f"\n📊 批次抓取三大法人 + 融資融券（最近 {len(trading_days)} 個交易日）...")
        for d in trading_days:
            dd = d.strftime('%Y-%m-%d')
            try:
                inst = fetch_market_institutional(d)
                if inst:
                    inst_cache[dd] = inst
                    print(f"  法人 {dd}: {len(inst)} 筆")
            except Exception as e:
                print(f"  ⚠️ fetch_market_institutional({dd}) 例外，跳過：{e}")
            time.sleep(0.8)
            try:
                marg = fetch_market_margin(d)
                if marg:
                    margin_cache[dd] = marg
                    print(f"  融券 {dd}: {len(marg)} 筆")
            except Exception as e:
                print(f"  ⚠️ fetch_market_margin({dd}) 例外，跳過：{e}")
            time.sleep(0.8)
        # 防呆：抓成功才覆寫,失敗時保留 last-good 不覆寫(避免一天的網路異常洗掉前端歷史資料)
        # 若既無新資料也無既有檔,才寫失敗標記給下游 batch 知道狀態
        def _has_real_payload(path):
            if not path.exists():
                return False
            try:
                obj = json.loads(path.read_text(encoding='utf-8'))
                return any(not str(k).startswith('_') for k in obj.keys())
            except Exception:
                return False

        try:
            if margin_cache:
                MARGIN_CACHE_FILE.write_text(json.dumps(margin_cache, ensure_ascii=False), encoding='utf-8')
                print(f"  💾 融資券快取已更新 → {MARGIN_CACHE_FILE}（{len(margin_cache)} 天）")
            elif _has_real_payload(MARGIN_CACHE_FILE):
                print(f"  ⏭️ 融資券抓取失敗,保留既有 last-good 不覆寫 → {MARGIN_CACHE_FILE}")
            else:
                MARGIN_CACHE_FILE.write_text(json.dumps({'_last_attempt': datetime.now().strftime('%Y-%m-%d %H:%M'), '_status': 'TWSE+FinMind+yfinance 三源皆失敗'}, ensure_ascii=False), encoding='utf-8')
                print(f"  💾 融資券快取首次失敗,寫入 _status 標記 → {MARGIN_CACHE_FILE}")
        except Exception as e:
            print(f"  ⚠️ 融資券快取寫檔失敗：{e}")
        try:
            if inst_cache:
                INST_CACHE_FILE.write_text(json.dumps(inst_cache, ensure_ascii=False), encoding='utf-8')
                print(f"  💾 三大法人快取已更新 → {INST_CACHE_FILE}（{len(inst_cache)} 天）")
            elif _has_real_payload(INST_CACHE_FILE):
                print(f"  ⏭️ 法人抓取失敗,保留既有 last-good 不覆寫 → {INST_CACHE_FILE}")
            else:
                INST_CACHE_FILE.write_text(json.dumps({'_last_attempt': datetime.now().strftime('%Y-%m-%d %H:%M'), '_status': 'TWSE+TPEX+FinMind 皆失敗'}, ensure_ascii=False), encoding='utf-8')
                print(f"  💾 法人快取首次失敗,寫入 _status 標記 → {INST_CACHE_FILE}")
        except Exception as e:
            print(f"  ⚠️ 法人快取寫檔失敗：{e}")
    else:
        print(f"\n⚡ SKIP_GLOBAL=1：跳過法人/融資券抓取（OHLCV 模式）")
        # 載入批次 0 儲存的法人 + 融資券快取（來自 gh-pages checkout），讓全市場個股都有籌碼
        if MARGIN_CACHE_FILE.exists():
            try:
                margin_cache = json.loads(MARGIN_CACHE_FILE.read_text(encoding='utf-8'))
                print(f"  📥 載入融資券快取：{len(margin_cache)} 天，{sum(len(v) for v in margin_cache.values())} 筆")
            except Exception as e:
                print(f"  ⚠️ 融資券快取載入失敗：{e}")
        if INST_CACHE_FILE.exists():
            try:
                inst_cache = json.loads(INST_CACHE_FILE.read_text(encoding='utf-8'))
                print(f"  📥 載入三大法人快取：{len(inst_cache)} 天，{sum(len(v) for v in inst_cache.values())} 筆")
            except Exception as e:
                print(f"  ⚠️ 三大法人快取載入失敗：{e}")

    # 全市場清單依批次對齊分割（所有 batch 用相同宇宙，彼此不重疊）
    watchlist = get_batch_symbols(inst_cache, BATCH_INDEX, TOTAL_BATCHES)
    print(f"\n🎯 批次 {BATCH_INDEX}/{TOTAL_BATCHES}：{len(watchlist)} 檔個股 | 月份: {months}")

    # 🌱 種子回填：把 checkout 的舊 JSON 歷史載回 SQLite（保留完整歷史，採礦只補新天）
    seed_db_from_json(watchlist)
    full_watchlist = list(watchlist)   # 保留完整清單供 artifact 修剪（resume 會裁切 watchlist）

    # 🧹 立刻寫 manifest（在採礦迴圈之前）：供 workflow 在「採礦 step 之後、即使 timeout」修剪 artifact。
    # 不能等 __main__ 末尾才修剪——timeout 殺進程就跑不到，會上傳未修剪的 29974 檔污染合併。
    try:
        Path('mined_manifest.txt').write_text('\n'.join(full_watchlist), encoding='utf-8')
        print(f"  📝 已寫 mined_manifest.txt（{len(full_watchlist)} 檔，供 timeout-safe 修剪）")
    except Exception as e:
        print(f"  ⚠️ 寫 manifest 失敗：{e}")

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
    db_conn = get_db_conn()
    db_conn.row_factory = sqlite3.Row
    db_conn.execute("PRAGMA journal_mode=WAL;")
    db_conn.execute("PRAGMA synchronous=NORMAL;")
    db_cur  = db_conn.cursor()

    updated_total = 0

    try:
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

            now = datetime.now(timezone(timedelta(hours=8)))   # 台灣時間（修正 GitHub Actions UTC 誤判）
            is_post_market = (now.hour > 13) or (now.hour == 13 and now.minute >= 40)

            # 缺口偵測：若最近 10 個交易日有任一天缺資料，不允許跳過（修復 5/24 後資料斷層）
            recent_10 = {d.strftime('%Y/%m/%d') for d in trading_days[-10:]}
            has_gap = any(d not in existing_map for d in recent_10)

            # 資料稀疏偵測：門檻從 60 降至 20（約 1 個月交易日），減少 6 倍回溯觸發
            # — 多數新股 20 筆已夠 bootstrap，避免 batch 卡在大量新股而 timeout
            if len(existing_map) < 20:
                fetch_months = []
                _tmp = today.replace(day=1)
                for _ in range(6):
                    fetch_months.append(_tmp.strftime('%Y%m'))
                    _tmp = (_tmp - timedelta(days=1)).replace(day=1)
                print(f"  📉 資料稀疏（現有 {len(existing_map)} 筆 < 20），延長至 6 個月回溯")
            else:
                fetch_months = months

            if not has_gap and latest_valid_date == target_today_str and (not is_post_market or has_final_chips):
                print(f"⚡ 本日 K 線與最終籌碼已完整，安全略過證交所請求")
                new_rows = []
            else:
                if is_post_market and latest_valid_date == target_today_str and not has_final_chips:
                    print(f"🔄 盤後採礦：K 線存在但籌碼尚未更新，強制重新下載...")
                new_rows = []
                first_ym_empty = False
                market_type = None  # 智慧記憶：記錄該股是上市或上櫃，不再盲目瞎猜

                for i, ym in enumerate(fetch_months):
                    rows = []
                    # 若為上市股或尚未確定，先查 TWSE
                    if market_type in (None, 'twse'):
                        rows = twse_ohlcv(sym, ym)
                        if rows: market_type = 'twse'

                    # 若 TWSE 查無資料，且為上櫃股或尚未確定，再查 TPEX
                    if not rows and market_type in (None, 'tpex'):
                        rows = tpex_ohlcv(sym, ym)
                        if rows: market_type = 'tpex'

                    # TPEX 偶發限流重試
                    if not rows and market_type == 'tpex':
                        time.sleep(0.5)
                        rows = tpex_ohlcv(sym, ym)  
                        
                    if i == 0 and not rows:
                        first_ym_empty = True
                    if i == 1 and first_ym_empty and rows:
                        print(f"  📅 {sym} {fetch_months[0]} 無資料，改用 {fetch_months[1]}（{len(rows)} 筆）")
                        
                    new_rows.extend(rows)
                    time.sleep(0.15)
                    
                # ── 🛡️ yfinance OHLCV 補洞：TWSE/TPEX 對 2330 等股回應不全時，自動拿 yfinance 填 ──
                # 偵測缺漏：對照最近 10 個交易日，看有哪些不在 new_rows
                got_dates = {r['date'] for r in new_rows} | set(existing_map.keys())
                missing_recent = [d for d in trading_days[-10:] if d.strftime('%Y/%m/%d') not in got_dates]
                if missing_recent:
                    yf_rows = yfinance_ohlcv_fallback(sym, market_type, days_back=30)
                    if yf_rows:
                        before_len = len(new_rows)
                        # 只補在 missing_recent 範圍內、且 new_rows 還沒有的日期
                        missing_set = {d.strftime('%Y/%m/%d') for d in missing_recent}
                        existing_dates = {r['date'] for r in new_rows}
                        for r in yf_rows:
                            if r['date'] in missing_set and r['date'] not in existing_dates:
                                new_rows.append(r)
                                existing_dates.add(r['date'])
                        added = len(new_rows) - before_len
                        if added > 0:
                            new_rows.sort(key=lambda x: x['date'])
                            print(f"  📈 {sym} yfinance 補洞 {added} 筆 (TWSE/TPEX 缺 {len(missing_recent)} 天)")

                # ── 🛡️ 【時間護盾與 MIS 即時快照補丁】 ──
                tw_now = datetime.now(timezone(timedelta(hours=8)))
                current_time = tw_now.time()
                is_pre_market = (current_time.hour == 8) or (current_time.hour == 9 and current_time.minute == 0)

                if not is_pre_market:
                    today_slashed = tw_now.strftime('%Y/%m/%d')
                    if not new_rows or new_rows[-1]['date'] != today_slashed:
                        snap = fetch_mis_closing_snapshot(sym)
                        if snap:
                            new_rows.append(snap)
                # ────────────────────────────────────

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
                combined = sorted(existing_map.values(), key=lambda x: x['date'])[-1200:]
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

    except Exception as e:
        # 當 GitHub Actions 超時被砍斷時，印出最後的斷點，讓您一目了然
        print(f"\n🚨 任務意外中斷！下次將從 index {idx} (股票代號: {sym}) 繼續。錯誤原因: {e}")
        raise
    finally:
        db_conn.close()

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
    print(f"\n🎉 採礦完畢：更新 {updated_total}/{len(watchlist)} 檔。")
    return inst_cache, margin_cache, full_watchlist


# ── 外資期貨（改用 FinMind API 防 Ban 版）────────────────────────────────────
def _fetch_futures_taifex_fallback() -> dict | None:
    """
    TAIFEX 公開三大法人台指期備援（不需 Token）。
    抓 TAIFEX 期交所 CSV，精準定位未平倉欄位。
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
            params = {'queryStartDate': date_tw, 'queryEndDate': date_tw, 'commodityId': 'TXF'}
            res = http_session.get(url, params=params, headers=_rnd_hdrs(), timeout=15)
            body = res.content
            if not body:
                continue
            
            text = None
            for enc in ('utf-8-sig', 'big5', 'utf-8'):
                try:
                    text = body.decode(enc)
                    break
                except Exception:
                    pass
            if not text or len(text) < 20 or text.startswith('<'):
                continue
                
            reader = csv.reader(io.StringIO(text.strip()))
            rows = [r for r in reader if r]
            
            for row in rows:
                if not any('外資' in str(cell) for cell in row):
                    continue
                try:
                    nums = []
                    for cell in row:
                        v = str(cell).replace(',', '').strip()
                        if v.lstrip('-').isdigit():
                            nums.append(int(v))
                    
                    if len(nums) >= 11:
                        long_oi  = nums[6]
                        short_oi = nums[8]
                        net_oi   = nums[10]
                        if long_oi > 0 or short_oi > 0:
                            print(f"  📡 TAIFEX 備援：外資期貨多={long_oi:,} 空={short_oi:,} 淨={net_oi:+,} ({d})")
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
    """外資台指期未平倉淨口數。"""
    print(f"\n🔮 抓取外資台指期 (優先使用 TAIFEX 官方直連)...")
    
    result = _fetch_futures_taifex_fallback()
    if result:
        _write_futures_cache(result['net'], result['long'], result['short'], result['date'])
        return
        
    print("  ⚠️ TAIFEX 官方失敗，退回 FinMind API...")
    today_str = date.today().strftime('%Y-%m-%d')
    start_str = (date.today() - timedelta(days=7)).strftime('%Y-%m-%d')
    url_base = (f'https://api.finmindtrade.com/api/v4/data'
                f'?dataset=TaiwanFuturesInstitutionalInvestors&data_id=TX'
                f'&start_date={start_str}&end_date={today_str}')
    
    try:
        j = fm_request(url_base, timeout=15)
        if j and j.get('status') == 200 and j.get('data'):
            foreign_data = [d for d in j['data'] if '外資' in d.get('name', '')]
            if foreign_data:
                latest = foreign_data[-1]
                net_direct = latest.get('open_interest_net_volume')
                net_oi = int(net_direct) if net_direct is not None else 0
                long_oi = max(0, net_oi)
                short_oi = max(0, -net_oi)
                if long_oi > 0 or short_oi > 0:
                    _write_futures_cache(net_oi, long_oi, short_oi, latest.get('date'))
    except Exception as e:
        print(f"  ⚠️ FinMind 外資期貨連線失敗: {e}")


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
               'dxy':   'DX-Y.NYB', # 美元指數
               'twii':  '^TWII',    # 台股加權指數（供泡沫預警 K 線型態判讀 + 個股查詢頁）
               'twoii': '^TWO',     # 台股上櫃指數（OTC,供個股查詢頁查上櫃整體走勢)
               }
    # 🎯 台股指數特例:這些 ticker 抓 period=2y 充足歷史(支援前端 240MA/季線等技術指標)
    LONG_HIST_KEYS = {'twii', 'twoii'}
    print(f"\n🌐 抓取美股昨收資料（{today}）...")
    result = {}
    for key, ticker in symbols.items():
        try:
            # 🛡️ SIGALRM 硬逾時，防 yfinance 無限 hang
            #    台股指數抓 2y(供前端個股頁完整功能)、其他維持 10d(省 API 額度)
            _period = '2y' if key in LONG_HIST_KEYS else '10d'
            hist = call_with_timeout(lambda: yf.Ticker(ticker).history(period=_period), 30, None)
            if hist is None or hist.empty:
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
            # 🎯 ^TWII / ^TWO 寫成 data/^TWII.json / data/^TWO.json 個股格式(對齊 list of OHLCV),
            #    讓前端 analyze('^TWII') / analyze('^TWO') 可查到加權/上櫃指數完整 K 線。
            #    同時保留舊 macro_cache 的 twii_history(120 日)向下相容 build_bubble_warning。
            if key in LONG_HIST_KEYS:
                long_rows = [
                    {'date':   str(idx.date()).replace('-', '/'),
                     'open':   round(float(row['Open']), 2),
                     'high':   round(float(row['High']), 2),
                     'low':    round(float(row['Low']), 2),
                     'close':  round(float(row['Close']), 2),
                     'volume': (int(row['Volume']) if (row['Volume'] == row['Volume']) else 0)}
                    for idx, row in hist.iterrows()
                    if (row['Close'] == row['Close'])   # dropna
                ]
                # 個股格式檔
                if long_rows:
                    fname = f"^{key.upper()}.json"   # ^TWII.json / ^TWOII.json
                    # ^TWO 的 ticker 我們寫成 ^TWOII.json 對齊前端 analyze('^TWOII') 呼叫
                    if key == 'twoii':
                        fname = '^TWOII.json'
                    try:
                        Path(DATA_DIR, fname).write_text(
                            json.dumps(long_rows, ensure_ascii=False, separators=(',', ':')),
                            encoding='utf-8')
                        print(f"  💾 {fname}: {len(long_rows)} 筆 OHLCV(供前端個股查詢頁)")
                    except Exception as _e:
                        print(f"  ⚠️ 寫 {fname} 失敗:{_e}")
                # macro_cache 內保留 twii_history(120 日,給泡沫預警用,避免改其他下游)
                if key == 'twii':
                    result['twii_history'] = long_rows[-120:] if long_rows else []
            print(f"  {key}: {result[key]['close']} ({result[key]['chg_pct']:+.2f}%)")
        except Exception as e:
            print(f"  ⚠️  {ticker}: {e}")
    if not result:
        return
    result['generated'] = today.strftime('%Y-%m-%d')
    with open('macro_cache.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"  ✅ macro_cache.json（{len(result)-1} 指標）")



# ── 🎯 分點 Sniper:TWSE BSR 驗證碼 OCR 破解(免費抓真實當日分點)──────────
def _fetch_twse_bsr(symbol: str, max_retries=4) -> dict:
    """用 ddddocr 破解證交所 BSR 驗證碼,免費抓當日券商分點主力。
    雲端裝不到 ddddocr/bs4 時回 None,靜默退回 FinMind。
    回傳 {date, tot_buy, tot_sell, buyers[], sellers[]} 或 None。
    """
    if _ddddocr is None or _BeautifulSoup is None:
        return None
    try:
        ocr = _ddddocr.DdddOcr(beta=True, show_ad=False)
    except Exception as e:
        print(f"  ⚠️ OCR 初始化失敗: {e}")
        return None

    session = requests.Session()
    session.headers.update({
        'User-Agent': random.choice(_UA_LIST),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7',
        'Connection': 'keep-alive',
        'Origin': 'https://bsr.twse.com.tw',
        'Referer': 'https://bsr.twse.com.tw/bshtm/bsMenu.aspx',
    })

    for attempt in range(max_retries):
        try:
            res = session.get("https://bsr.twse.com.tw/bshtm/bsMenu.aspx", timeout=10)
            soup = _BeautifulSoup(res.text, 'html.parser')
            viewstate = soup.find('input', {'name': '__VIEWSTATE'})
            eventval = soup.find('input', {'name': '__EVENTVALIDATION'})
            if not viewstate or not eventval:
                time.sleep(1); continue

            img_res = session.get("https://bsr.twse.com.tw/bshtm/CaptchaImage.aspx", timeout=10)
            captcha_text = ocr.classification(img_res.content)
            if not captcha_text or len(captcha_text) != 5:
                time.sleep(1); continue

            payload = {
                '__EVENTTARGET': '', '__EVENTARGUMENT': '', '__LASTFOCUS': '',
                '__VIEWSTATE': viewstate['value'], '__EVENTVALIDATION': eventval['value'],
                'RadioButton_Normal': 'RadioButton_Normal',
                'txtStkNo': symbol, 'CaptchaControl1': captcha_text, 'btnOK': '查詢',
            }
            post_res = session.post("https://bsr.twse.com.tw/bshtm/bsMenu.aspx", data=payload, timeout=10)
            if "驗證碼錯誤" in post_res.text:
                time.sleep(1.5); continue
            if "查無資料" in post_res.text:
                return None  # 上櫃股或今日無交易

            session.get("https://bsr.twse.com.tw/bshtm/bsContent.aspx?v=t", timeout=10)
            csv_res = session.get("https://bsr.twse.com.tw/bshtm/bsCSV.aspx", timeout=10)
            if not csv_res.text.strip():
                time.sleep(1); continue

            csv_text = csv_res.content.decode('big5-hkscs', errors='ignore')
            rows = list(csv.reader(io.StringIO(csv_text)))
            if len(rows) < 3:
                return None
            trade_date = rows[0][0].replace('年', '-').replace('月', '-').replace('日', '')
            try:
                p = trade_date.split('-')
                trade_date = f"{int(p[0])+1911}-{int(p[1]):02d}-{int(p[2]):02d}"
            except Exception:
                trade_date = date.today().strftime('%Y-%m-%d')

            branches = {}
            for r in rows[2:]:
                if len(r) < 11:
                    continue
                if r[1].strip():
                    br = r[1].strip()
                    b = int(r[3].replace(',', '').strip() or 0); s = int(r[4].replace(',', '').strip() or 0)
                    e = branches.setdefault(br, {'buy': 0, 'sell': 0}); e['buy'] += b; e['sell'] += s
                if len(r) > 10 and r[7].strip():
                    br = r[7].strip()
                    b = int(r[9].replace(',', '').strip() or 0); s = int(r[10].replace(',', '').strip() or 0)
                    e = branches.setdefault(br, {'buy': 0, 'sell': 0}); e['buy'] += b; e['sell'] += s

            summary = [{'br': br, 'buy': d['buy'], 'sell': d['sell'], 'net': d['buy'] - d['sell']}
                       for br, d in branches.items()]
            buyers = sorted([x for x in summary if x['net'] > 0], key=lambda x: x['net'], reverse=True)[:15]
            sellers = sorted([x for x in summary if x['net'] < 0], key=lambda x: x['net'])[:15]
            print(f"  🎯 Sniper 命中！{symbol} 分點破解成功 (嘗試 {attempt+1} 次)")
            return {
                "date": trade_date,
                "tot_buy": sum(x['buy'] for x in summary),
                "tot_sell": sum(x['sell'] for x in summary),
                "buyers":  [{'broker_id': x['br'], 'broker_name': x['br'], 'net': x['net'], 'buy': x['buy'], 'sel': x['sell']} for x in buyers],
                "sellers": [{'broker_id': x['br'], 'broker_name': x['br'], 'net': x['net'], 'buy': x['buy'], 'sel': x['sell']} for x in sellers],
            }
        except Exception:
            time.sleep(1.5)
            continue
    return None


# ── 分點籌碼（混合雙擎：TWSE Sniper + TPEX FinMind）──────────────────────
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
            conn = get_db_conn()
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
    # 【極限防禦】加上 or {}，確保即使 API 崩潰回傳 None，也絕對不會引發 'NoneType' 錯誤
    twse_fund = fetch_twse_fundamentals(date.today()) or {}

    # 🦅 獵鷹建倉分:把全市場 PE/殖利率 dump 成 cache,供 radar_miner 算「低本益比」因子(全市場覆蓋)
    #    抓成功才覆寫,失敗(空 dict)時保留昨日 last-good,避免洗掉。
    try:
        if twse_fund:
            fund_cache = {s: {'pe': v.get('pe'), 'yield_rate': v.get('yield_rate')}
                          for s, v in twse_fund.items() if isinstance(v, dict)}
            Path('data', 'fundamentals_cache.json').write_text(
                json.dumps(fund_cache, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            print(f"  💾 全市場基本面快取 → data/fundamentals_cache.json（{len(fund_cache)} 檔）")
        else:
            print("  ⏭️ TWSE 基本面回空,保留既有 fundamentals_cache.json 不覆寫")
    except Exception as e:
        print(f"  ⚠️ fundamentals_cache 寫檔失敗(不影響主流程):{e}")

    # 新增：一次查全台券商代碼→中文名對照（FinMind TaiwanBrokerInfo 免費）
    print("\n📖 載入券商對照表（TaiwanBrokerInfo）...")
    broker_info_map = _load_broker_info_map()

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

        # ── 分點籌碼：混合雙擎(Sniper 攻 TWSE 真分點 → FinMind 補多週期/上櫃)──
        buyers, sellers, brokers_list = [], [], []
        periods: dict = {}
        latest_chip_date = None
        # 🎯 Sniper 優先(只在 batch 0 且裝了 ddddocr 時有效):免費抓今日真實分點
        sniper_data = None
        try:
            sniper_data = _fetch_twse_bsr(sym)
            if sniper_data:
                latest_chip_date = sniper_data['date']
                buyers = sniper_data['buyers']
                sellers = sniper_data['sellers']
                # 今日真分點存進對照表(broker_name = 分點名,非數字代號)
                for x in buyers + sellers:
                    bn = x.get('broker_name', '')
                    if bn and not str(bn).isdigit():
                        broker_name_map[x.get('broker_id', bn)] = bn
        except Exception as _e:
            sniper_data = None
        try:
            chip_start = (date.today() - timedelta(days=14)).strftime('%Y-%m-%d')
            url_base = (f'https://api.finmindtrade.com/api/v4/data'
                        f'?dataset=TaiwanStockLocalSecuritiesBrokerTransactions'
                        f'&data_id={sym}&start_date={chip_start}')
            j = fm_request(url_base, timeout=15)
            if j is None: j = {}
            # 污染防呆：dataset 已 deprecate 時 FinMind 會回非分點資料，需驗證
            status_code = j.get('status')
            data_rows = j.get('data') or []
            if status_code in (402, 403):
                print(f"    💰 分點 {sym} FinMind 回 {status_code}（{j.get('msg', '需付費')}）— 跳過")
                data_rows = []
            elif status_code == 200 and data_rows:
                sample = data_rows[0]
                if not any(k in sample for k in ('secBrokerId', 'securities_trader_id', 'broker_id')):
                    print(f"    ⚠️ 分點 {sym} FinMind response 欄位不對，keys={list(sample.keys())[:10]} — 跳過避免污染")
                    data_rows = []
            if data_rows:
                by_date: dict = {}
                for r in data_rows:
                    d   = r.get('date') or today_str
                    bid = str(r.get('secBrokerId') or r.get('securities_trader_id') or r.get('broker_id') or '').strip()
                    # 🛡️ 污染防呆:broker_id 必須是 1-5 位純數字(無逗號/千分位)
                    # 否則代表 FinMind 把金額欄誤映射成 id(歷史曾有 "18,232,856" 這種垃圾)
                    if not bid or ',' in bid or not bid.replace('A','').replace('a','').isdigit() or len(bid) > 5:
                        continue
                    raw_nm = (r.get('secBrokerName') or r.get('securities_trader') or r.get('broker_name') or '').strip()
                    # broker_name 也防呆:純數字 + 逗號 = 金額誤映射
                    if ',' in raw_nm or (raw_nm and raw_nm.replace(',', '').isdigit() and len(raw_nm) > 5):
                        raw_nm = ''
                    if bid in TACTICAL_TAGS: bnm = TACTICAL_TAGS[bid]
                    elif raw_nm and not raw_nm.isdigit(): bnm = raw_nm
                    elif bid in broker_info_map: bnm = broker_info_map[bid]
                    else: bnm = bid
                    buy, sel = int(r.get('buy', 0)), int(r.get('sell', 0))
                    slot = by_date.setdefault(d, {})
                    e = slot.setdefault(bid, {'broker_id': bid, 'broker_name': bnm, 'net': 0, 'buy': 0, 'sel': 0})
                    e['buy'] += buy; e['sel'] += sel; e['net'] += (buy - sel)
                    if bnm and not str(bnm).isdigit(): e['broker_name'] = bnm

                if by_date:
                    for d_data in by_date.values():
                        for bid, e in d_data.items():
                            if bid and e['broker_name'] and not str(e['broker_name']).isdigit():
                                broker_name_map[bid] = e['broker_name']

                    def _agg_period(n: int) -> dict:
                        wdates = sorted(by_date.keys())[-n:]
                        agg: dict = {}
                        for wd in wdates:
                            for b, e in by_date[wd].items():
                                a = agg.setdefault(b, {'broker_id': b, 'broker_name': e['broker_name'], 'net': 0, 'buy': 0, 'sel': 0})
                                a['net'] += e['net']
                                a['buy'] += e.get('buy', 0)
                                a['sel'] += e.get('sel', 0)
                                if e['broker_name'] and not str(e['broker_name']).isdigit():
                                    a['broker_name'] = e['broker_name']
                        vals = list(agg.values())
                        buy_top  = sorted([x for x in vals if x['net'] > 0], key=lambda x: -x['net'])[:15]
                        sell_top = sorted([x for x in vals if x['net'] < 0], key=lambda x:  x['net'])[:15]
                        return {'buy': buy_top, 'sell': sell_top}
                    periods = {f'{n}d': _agg_period(n) for n in (1, 3, 5, 10)}
                    # Sniper 已拿到今日真分點時不被 FinMind 覆蓋(Sniper=官方 TWSE 較準);
                    # 否則用 FinMind 當日資料
                    if not sniper_data:
                        latest_chip_date = sorted(by_date.keys())[-1]
                        brokers_list = [{'bid': b, 'bnm': e['broker_name'], 'buy': e['buy'], 'sel': e['sel'], 'net': e['net']} for b, e in by_date[latest_chip_date].items()]
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

        # 【極限防爆】提前提取並確保字典絕對不會是 None
        tw_fund = twse_fund.get(sym, {}) or {}

        if skip_finmind:
            print(f"  ⚡ 基本面快取有效（{generated_str}），跳過 FinMind")
            fundamentals = {**cached_fund,
                            'pe':         tw_fund.get('pe') or cached_fund.get('pe'),
                            'yield_rate': tw_fund.get('yield_rate') or cached_fund.get('yield_rate')}
        else:
            print(f"  📈 基本面採礦 {sym}...", end=' ', flush=True)
            fm_fund = fetch_finmind_fundamentals(sym) or {}  # 加上 or {} 終極防爆
            fundamentals = {
                'eps':                fm_fund.get('eps'),
                'eps_history':        fm_fund.get('eps_history'),
                'revenue_yoy':        fm_fund.get('revenue_yoy'),
                'is_revenue_high':    fm_fund.get('is_revenue_high'),
                'revenue_est_next_q': fm_fund.get('revenue_est_next_q'),
                'pe':                 tw_fund.get('pe') or fm_fund.get('pe'),
                'yield_rate':         tw_fund.get('yield_rate'),
                'gross_margin_trend': fm_fund.get('gross_margin_trend'),
                'payout_ratio':       fm_fund.get('payout_ratio'),
                'total_dividend':     fm_fund.get('total_dividend'),
                'is_record_high':     fm_fund.get('is_record_high', False),
                'latest_revenue':     fm_fund.get('latest_revenue'),
                'quarterly_eps':      fm_fund.get('quarterly_eps', []),
                'generated':          today_str,
            }
            print("✅")

        # ③ 寫入新格式 JSON（existing_obj 已在迴圈頂部讀取，不重複讀檔）
        records_map = {r['date']: r for r in existing_obj.get('chips', []) if isinstance(r, dict)}
        rec_date = latest_chip_date or today_str   # 以實際最新交易日為 key（非強制今天）
        if buyers or sellers:
            records_map[rec_date] = {
                'date': rec_date, 'buyers': buyers, 'sellers': sellers,
                'tot_buy': sum(b['buy'] for b in brokers_list) if not sniper_data else sniper_data['tot_buy'],
                'tot_sel': sum(b['sel'] for b in brokers_list) if not sniper_data else sniper_data['tot_sell']
            }
            updated += 1
        recent_dates = sorted(records_map.keys())[-20:]
        
        # 本次抓取失敗（429/空）時，保留上次的 periods，避免覆蓋成空
        out_periods = periods if periods else (existing_obj.get('periods') or {})
        # 資料完整性指標
        data_completeness = {
            'ohlcv':       len(records_map) > 0,
            'chip_inst':   bool(buyers or sellers),
            'broker_chip': bool(buyers or sellers),
            'fundamentals': bool((fundamentals or {}).get('eps')),
        }
        output = {
            'fundamentals': fundamentals,
            'data_date': recent_dates[-1] if recent_dates else None,  # 最新可用交易日
            'periods': out_periods,   # 多週期：{1d,3d,5d,10d}，各含 buy/sell（broker_name）
            'chips': [records_map[d] for d in recent_dates],
            'data_completeness': data_completeness,
        }
        out_file.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')

    print(f"  ✅ 分點籌碼完成：更新了 {updated} 檔股票的主力動向")

    # 寫入券商名稱字典（broker_names.json），合併舊資料再更新
    # 同時用 TaiwanBrokerInfo 白名單清洗舊污染資料（股票公司名誤入）
    bn_file = Path(DATA_DIR) / 'broker_names.json'
    existing_bn: dict = {}
    if bn_file.exists():
        try: existing_bn = json.loads(bn_file.read_text(encoding='utf-8'))
        except Exception: pass

    # 合併：本次採礦結果覆蓋舊資料，再補入 TaiwanBrokerInfo 的完整對照
    merged_bn = {**existing_bn, **broker_name_map, **broker_info_map}
    # TACTICAL_TAGS 擁有最高優先權（含特殊標記說明）
    merged_bn.update(TACTICAL_TAGS)

    # 輕量清洗：只移除「名稱為純數字」的污染條目（股票代號誤入），
    # 不做白名單清洗，避免 TaiwanBrokerInfo 限流時把已累積的名稱全刪光
    cleaned_bn = {bid: nm for bid, nm in merged_bn.items()
                  if nm and not str(nm).replace(',','').strip().isdigit() and len(str(nm).strip()) >= 2}
    removed = len(merged_bn) - len(cleaned_bn)
    if removed:
        print(f"  🧹 清洗純數字污染 {removed} 筆")
    merged_bn = cleaned_bn

    bn_file.write_text(json.dumps(merged_bn, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"  📋 券商名稱字典：{len(merged_bn)} 筆 → broker_names.json")


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
    results   = {'bottom': [], 'surge': [], 'score': [], 'monster': []}
    processed = 0

    print("\n🚀 啟動全局雷達掃描 (植入高勝率量化三引擎 + 妖股雷達)...")
    for f in Path(DATA_DIR).glob('*.json'):
        if f.name in ('radar.json', 'top_picks.json', 'macro_cache.json', 'futures_cache.json', 'broker_names.json', 'radar_news.json'):
            continue

        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue

        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list) or len(raw) < 22:
                continue

            # 擷取最後 25 筆 K 線供技術指標計算
            data = [{'close': r['close'], 'volume': r['volume']} for r in raw[-25:]]
            ind  = _quick_ind(data)
            if not ind:
                continue

            # 【獲利引擎 2】籌碼動能確認：計算近 5 日三大法人淨買賣
            recent_5 = raw[-5:]
            inst_net_5d = sum(r.get('foreign_net', 0) + r.get('trust_net', 0) + r.get('dealer_net', 0) for r in recent_5)

            processed += 1
            c,   pc   = ind['close'],   ind['prev_close']
            ma5, ma10, ma20         = ind['ma5'],  ind['ma10'],  ind['ma20']
            pma5, pma10, pma20      = ind['pma5'], ind['pma10'], ind['pma20']
            vma5, upper_bb, rv      = ind['vma5'], ind['upper_bb'], ind['recent_vols']

            # 【獲利引擎 1】流動性防護網：5 日均量 < 200 張 (20萬股) 直接淘汰殭屍股
            if vma5 < 200_000:
                continue

            # 🐲 妖股雷達（早於乖離率防守判斷，妖股本身就是「乖離爆大」）
            # 判定：5 日漲幅 ≥ 20% 或 10 日漲幅 ≥ 30%；近 3 日中至少 2 日量比 > 3 倍均量；
            #       最新收盤 ≥ (最新 high + low) / 2（強勢吸籌、收高不收低）；
            #       流動性 vma5 ≥ 500K（妖股要追得進去）
            try:
                last_raw = raw[-1]
                last_h = last_raw.get('high', c) or c
                last_l = last_raw.get('low',  c) or c
                gain5d = (c - raw[-6]['close']) / raw[-6]['close'] * 100 if len(raw) >= 6 and raw[-6]['close'] > 0 else 0
                gain10d = (c - raw[-11]['close']) / raw[-11]['close'] * 100 if len(raw) >= 11 and raw[-11]['close'] > 0 else 0
                vol_burst = sum(1 for v in (rv[-3:] if rv else []) if vma5 > 0 and v > vma5 * 3)
                recent_strong = c >= (last_h + last_l) / 2
                day_chg = (c - pc) / pc * 100 if pc > 0 else 0
                near_limit_up = day_chg >= 9.0   # 台股 ±10%，> 9% 視為近漲停
                vol_ratio_last = (rv[-1] / vma5) if (rv and vma5 > 0) else 0
                if (gain5d >= 20 or gain10d >= 30) and vol_burst >= 2 and recent_strong and vma5 >= 500_000:
                    results['monster'].append({
                        'sym': sym, 'close': round(c, 2),
                        'ma20': round(ma20, 2), 'ma5': round(ma5, 2),
                        'gain5d': round(gain5d, 1), 'gain10d': round(gain10d, 1),
                        'vol_ratio': round(vol_ratio_last, 1),
                        'near_limit_up': near_limit_up,
                    })
            except Exception:
                pass

            # 【獲利引擎 3】乖離率防守：過濾掉偏離月線大於 15% 的股票，拒絕追高
            bias_20 = (c - ma20) / ma20 if ma20 > 0 else 0
            if bias_20 > 0.15:
                continue

            # 🟢 底部起漲波段股：均線黃金交叉 + 法人不大舉流出（放寬：原 >0 改 >= -5000）
            if ((c > ma20 and pc <= pma20) or (ma5 > ma10 and pma5 <= pma10)) and c > pc and inst_net_5d >= -5000:
                results['bottom'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2), 'bb_upper': round(upper_bb, 2), 'ma5': round(ma5, 2)})

            # 🔥 飆股動能突破股：貼著布林上軌，量增 20%（原 1.3 改 1.2）+ 法人不大流出
            if c >= upper_bb * 0.97 and (rv[-1] > vma5 * 1.2 if rv and vma5 > 0 else False) and inst_net_5d >= -5000:
                results['surge'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2), 'bb_upper': round(upper_bb, 2), 'ma5': round(ma5, 2)})

            # ⚡ 綜合多頭強勢股：放寬為「站上月線 + 5MA > 20MA」+ 量增 10%（原完美四線多排太嚴）
            if (c > ma20 and ma5 > ma20) and c > pc and \
               (rv[-1] > vma5 * 1.1 if rv and vma5 > 0 else False) and inst_net_5d >= -5000:
                results['score'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2), 'bb_upper': round(upper_bb, 2), 'ma5': round(ma5, 2)})
        except Exception:
            continue

    # 妖股依 5 日漲幅排序，最妖在前
    results['monster'].sort(key=lambda x: x.get('gain5d', 0), reverse=True)

    Path(DATA_DIR).mkdir(exist_ok=True)
    Path(DATA_DIR).joinpath('radar.json').write_text(
        json.dumps({'updated': date.today().isoformat(), 'data': results},
                   ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8')

    print(f"  ✅ 雷達：掃描 {processed} 檔，"
          f"底部 {len(results['bottom'])} / 飆股 {len(results['surge'])} / 綜合 {len(results['score'])} / 妖股 {len(results['monster'])}")


# ── 💥 牛市泡沫破裂預警系統 ─────────────────────────────────────────────────
# 證券狂熱度（擦鞋童指標）/ 融資槓桿水位 / 漲停家數 / 大盤 K 線型態
BROKER_LIST = ['2855', '6005', '9105', '6021', '6020', '6024']  # 統一證/群益證/泰金寶/元大期/元富/元大期

# ── 🆕 全市場融資餘額總額抓取(selectType=MS 彙總表,結構穩定不易被反爬擋)─────
# 採用使用者建議的方向,並補強 7 點:fields 動態定位 / _rnd_hdrs / 退日 fallback /
# 重試 / 防呆 / 不擦舊資料 / 雙判定。回傳 億元 (float) 或 None。
def _fetch_market_margin_total_ms(d: date, max_fallback_days: int = 5):
    """抓 TWSE MI_MARGN selectType=MS 彙總表的『全市場融資今日餘額』(轉億元)。

    為何用 MS 而非 ALL:MS 是 TWSE 預先彙總好的市場總額表(僅 3-7 列),
    結構穩定、被反爬擋率低;ALL 是 1500+ 個股表,易撞「市場總計表 vs 個股表」陷阱。
    退日 fallback:當日尚未交易(如假日/早盤)會自動退到前一個交易日。
    """
    for offset in range(max_fallback_days):
        try_d = d - timedelta(days=offset)
        d8 = try_d.strftime('%Y%m%d')
        url = f'https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date={d8}&selectType=MS'
        try:
            j = http_session.get(url, headers=_rnd_hdrs(), timeout=15).json()
        except Exception as e:
            print(f"  ⚠️ [融資MS] {d8} 請求例外:{e}")
            continue
        if j.get('stat') != 'OK':
            # 假日/未開市常見:stat='很抱歉,沒有符合條件的資料!'
            continue
        tables = j.get('tables', []) or []
        if not tables:
            continue
        # 兩種 schema 都見過:tables[0] 直接是 MS 表;有時 tables 多張要找含「融資」+「今日餘額」的
        target_table = None
        for t in tables:
            fields = t.get('fields', []) or []
            if any('融資' in (f or '') and '今日餘額' in (f or '') for f in fields):
                target_table = t
                break
        if target_table is None:
            target_table = tables[0]   # 退一步:就用第一張(MS 常規)
        fields = target_table.get('fields', []) or []
        data_rows = target_table.get('data', []) or []
        if not data_rows:
            continue
        # 解析兩種可能的 schema(防 TWSE 隨時改版):
        # Schema A — MS 二維表:row[0] 含「融資金額」標籤、col 含「今日餘額」(常見)
        # Schema B — ALL flat:單一 col 名稱即「融資今日餘額」(總計列在最末)
        max_val_k = 0

        # Schema A 嘗試
        idx_today_simple = next((i for i, f in enumerate(fields)
                                 if ('今日餘額' in (f or '')) or ('現在餘額' in (f or ''))), None)
        if idx_today_simple is not None:
            for r in data_rows:
                if not r or len(r) <= idx_today_simple: continue
                row_label = str(r[0] or '')
                if '融資' in row_label and '融券' not in row_label and '券' not in row_label:
                    try:
                        v = int(str(r[idx_today_simple]).replace(',', '').replace(' ', '') or 0)
                        if v > max_val_k: max_val_k = v
                    except Exception: continue

        # Schema B 嘗試(若 A 沒命中)
        if max_val_k <= 0:
            idx_today_combined = next((i for i, f in enumerate(fields)
                                       if '融資' in (f or '') and ('今日餘額' in (f or '') or '現在餘額' in (f or ''))), None)
            if idx_today_combined is not None:
                for r in data_rows:
                    if not r or len(r) <= idx_today_combined: continue
                    try:
                        v = int(str(r[idx_today_combined]).replace(',', '').replace(' ', '') or 0)
                        if v > max_val_k: max_val_k = v
                    except Exception: continue

        if max_val_k <= 0:
            print(f"  ⚠️ [融資MS] {d8} 解析失敗 fields={fields[:6]} sample_row={data_rows[0][:4] if data_rows else '無'}")
            continue
        # 仟元 → 億元 (÷ 100,000)
        total_100m = max_val_k / 100000.0
        # 合理性檢查:全市場融資餘額正常在 1500~4000 億區間,小於 500 或大於 8000 視為解析錯誤
        if total_100m < 500 or total_100m > 8000:
            print(f"  ⚠️ [融資MS] {d8} 解析數字 {total_100m:.0f} 億超出合理區間,可能抓錯欄位")
            continue
        if offset > 0:
            print(f"  ℹ️ [融資MS] 採用 {try_d.isoformat()} 資料(回退 {offset} 日)")
        return total_100m
    print(f"  ⚠️ [融資MS] 連 {max_fallback_days} 日皆無有效資料")
    return None


def build_bubble_warning():
    out = {'updated': date.today().isoformat()}

    # ── 1. 🏦 證券板塊狂熱度（擦鞋童指標）───────────────────────────────
    chgs = []
    for sym in BROKER_LIST:
        f = Path(DATA_DIR) / f'{sym}.json'
        if not f.exists():
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list) or len(raw) < 2:
                continue
            c, pc = float(raw[-1]['close']), float(raw[-2]['close'])
            if pc > 0:
                chgs.append((c - pc) / pc * 100)
        except Exception:
            continue
    avg_chg = (sum(chgs) / len(chgs)) if chgs else 0
    out['broker_heat'] = {
        'value':   round(avg_chg, 2),
        'label':   f'{"+" if avg_chg >= 0 else ""}{avg_chg:.1f}%',
        'level':   ('red' if avg_chg >= 3 else 'orange' if avg_chg >= 1.5 else 'gray'),
        'desc':    ('異常狂熱・擦鞋童' if avg_chg >= 3
                    else '偏多溫熱' if avg_chg >= 1.5
                    else '正常溫度'),
        'samples': len(chgs),
    }

    # ── 2. ⚖️ 融資槓桿水位（雙判定:絕對值 億元 主、60 日相對水位 % 輔）──
    # 主來源:TWSE MI_MARGN selectType=MS 彙總表(穩定、不被反爬擋)→ 絕對值總額
    # 輔來源:現有 margin_cache_stock.json 60 日累積 → 相對水位 %
    # 失敗 fallback:讀上次 bubble_warning.json 的 margin_leverage,寧可舊資料也不要白屏
    total_100m = _fetch_market_margin_total_ms(date.today())   # 億元,可能 None
    level_pct = None
    try:
        margin_file = Path('margin_cache_stock.json')
        if margin_file.exists():
            m = json.loads(margin_file.read_text(encoding='utf-8'))
            if isinstance(m, dict) and m:
                dates = sorted(k for k in m.keys() if not k.startswith('_'))   # 跳過 _last_attempt 等 metadata
                series = []
                for d in dates[-60:]:
                    bucket = m.get(d) or {}
                    if isinstance(bucket, dict):
                        total = sum(int((stock or {}).get('margin_balance', 0) or 0)
                                    for stock in bucket.values())
                        if total > 0:
                            series.append(total)
                if len(series) >= 5:
                    latest, peak, low = series[-1], max(series), min(series)
                    if peak > low:
                        level_pct = int(round((latest - low) / (peak - low) * 100))
                    else:
                        level_pct = 50
    except Exception as e:
        print(f"  ⚠️ 融資槓桿水位計算失敗: {e}")

    if total_100m is not None:
        # 主來源成功:用絕對值 + (有的話) 相對水位 雙判定取較嚴格訊號
        # 絕對值門檻參考使用者建議:>3200 億極度危險、>2800 億警戒
        abs_status = '🔴 極度危險' if total_100m > 3200 else '🟡 警戒' if total_100m > 2800 else '🟢 健康'
        abs_level  = 'red'         if total_100m > 3200 else 'orange'  if total_100m > 2800 else 'gray'
        if level_pct is not None:
            rel_level = 'red' if level_pct >= 80 else 'orange' if level_pct >= 60 else 'gray'
            # 取較嚴格:red > orange > gray
            sev_rank = {'red': 2, 'orange': 1, 'gray': 0}
            final_level = abs_level if sev_rank[abs_level] >= sev_rank[rel_level] else rel_level
            label = f'{total_100m:.0f} 億・{abs_status}・60日水位{level_pct}%'
            desc = ('散戶槓桿過熱・提防斷頭潮' if final_level == 'red'
                    else '融資水位偏高・盤勢易震盪' if final_level == 'orange'
                    else '槓桿安定・健康水位')
        else:
            final_level = abs_level
            label = f'{total_100m:.0f} 億・{abs_status}'
            desc = ('散戶槓桿過熱・提防斷頭潮' if final_level == 'red'
                    else '融資水位偏高・盤勢易震盪' if final_level == 'orange'
                    else '槓桿安定・健康水位')
        out['margin_leverage'] = {
            'value':       level_pct if level_pct is not None else 0,   # 前端 progress bar 仍用 0-100%
            'label':       label,
            'level':       final_level,
            'desc':        desc,
            'total_100m':  round(total_100m, 1),   # 新增欄位:絕對值 (億),AI prompt 可用
        }
    elif level_pct is not None:
        # 主來源掛、輔來源 OK:沿用舊 60 日相對水位邏輯
        out['margin_leverage'] = {
            'value': level_pct,
            'label': f'{level_pct}%・' + ('高危險區' if level_pct >= 80
                                            else '警戒區' if level_pct >= 60
                                            else '正常區' if level_pct >= 30
                                            else '低水位'),
            'level': ('red' if level_pct >= 80
                      else 'orange' if level_pct >= 60
                      else 'gray'),
            'desc':  ('隨時多殺多' if level_pct >= 80
                      else '槓桿偏高' if level_pct >= 60
                      else '健康'),
        }
    else:
        # 主+輔都掛:讀上次 bubble_warning.json 的 margin_leverage,加 stale 標記;再不行才顯示「資料整編中」
        prev = None
        try:
            prev_bw = json.loads(Path(DATA_DIR).joinpath('bubble_warning.json').read_text(encoding='utf-8'))
            prev_ml = prev_bw.get('margin_leverage') or {}
            if prev_ml.get('label') and '整編中' not in prev_ml.get('label', ''):
                prev = dict(prev_ml)
                prev['desc'] = f"⚠️ 上游今日無回應,沿用上次({prev_bw.get('updated', '?')}){prev.get('desc', '')}"
        except Exception:
            pass
        if prev:
            out['margin_leverage'] = prev
        else:
            out['margin_leverage'] = {'value': 0, 'label': '資料整編中',
                                      'level': 'gray', 'desc': '待 TWSE MS 或 60 日融資累積'}

    # ── 3. 🧟‍♂️ 群魔亂舞指數（全市場漲停家數）───────────────────────────
    limit_up = 0
    for f in Path(DATA_DIR).glob('*.json'):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()):
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list) or len(raw) < 2:
                continue
            c, pc = float(raw[-1]['close']), float(raw[-2]['close'])
            if pc > 0 and (c - pc) / pc * 100 >= 9.0:
                limit_up += 1
        except Exception:
            continue
    out['junk_count'] = {
        'value': limit_up,
        'label': f'{limit_up} 家漲停',
        'level': ('red' if limit_up >= 30
                  else 'orange' if limit_up >= 15
                  else 'gray'),
        'desc':  ('投機熱錢末路' if limit_up >= 30
                  else '投機氣氛偏熱' if limit_up >= 15
                  else '正常'),
    }

    # ── 4. 📉 大盤 K 線型態（讀 macro_cache.json twii_history）────────
    try:
        mc = json.loads(Path('macro_cache.json').read_text(encoding='utf-8'))
        twii_hist = mc.get('twii_history') or []
        if twii_hist:
            last = twii_hist[-1]
            o, h, l, c = float(last['open']), float(last['high']), float(last['low']), float(last['close'])
            v = float(last.get('volume', 0))
            total_range = h - l
            upper_shadow = h - max(o, c) if total_range > 0 else 0
            shadow_ratio = (upper_shadow / total_range) if total_range > 0 else 0
            past5 = twii_hist[-6:-1] if len(twii_hist) >= 6 else twii_hist[:-1]
            avg_v = (sum(float(t.get('volume', 0) or 0) for t in past5) / len(past5)) if past5 else v
            vol_ratio = (v / avg_v) if avg_v > 0 else 1.0

            if shadow_ratio >= 0.4 and vol_ratio >= 1.3:
                lbl, lvl, dsc = '⚠️ 爆量長上影', 'red', '主力高檔派發'
            elif shadow_ratio >= 0.3 or vol_ratio >= 1.5:
                lbl, lvl, dsc = '⚠️ 上影警示', 'orange', '上檔有壓力'
            elif c >= o and shadow_ratio < 0.2:
                lbl, lvl, dsc = '✅ 健康收紅', 'gray', '量價穩健'
            else:
                lbl, lvl, dsc = '🟢 多頭整理', 'gray', '盤面平穩'
            out['kline_status'] = {
                'label': lbl, 'level': lvl, 'desc': dsc,
                'shadow_ratio': round(shadow_ratio, 2),
                'vol_ratio':    round(vol_ratio, 2),
            }
        else:
            out['kline_status'] = {'label': '資料整編中', 'level': 'gray', 'desc': '待 ^TWII 抓取'}
    except Exception as e:
        out['kline_status'] = {'label': '資料整編中', 'level': 'gray', 'desc': f'讀取失敗 {str(e)[:30]}'}

    # ── 輸出 ────────────────────────────────────────────────────────
    Path(DATA_DIR).mkdir(exist_ok=True)
    _btarget = Path(DATA_DIR).joinpath('bubble_warning.json')
    _btmp = _btarget.with_suffix('.json.tmp')
    _btmp.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(_btmp), str(_btarget))
    print(f"  ✅ 泡沫預警：證券 {out['broker_heat']['label']} ({out['broker_heat']['samples']}檔)"
          f" / 漲停 {out['junk_count']['value']}"
          f" / 融資 {out['margin_leverage']['label']}"
          f" / K線 {out['kline_status']['label']}")


# ── 🌡️ 4 戰區 + 9 細分板塊熱度（取代前端逐檔 fetch，治本板塊燈號全灰）─────────
WARZONES = {
    'us':       {'icon': '🇺🇸', 'name': '美股大氣候',  'syms': ['2330', '3711']},
    'ai_core':  {'icon': '🖥️', 'name': 'AI 核心硬體', 'syms': ['2382', '6669', '3017', '3324', '3653', '3450', '3380', '2330', '3711']},
    'power':    {'icon': '⚡', 'name': '重電與基建',  'syms': ['1519', '1503', '1513']},
    'finance':  {'icon': '🛡️', 'name': '金融與避風港','syms': ['2881', '2882', '2891', '2886']},
}
SUB_SECTORS = {
    'us':        ['2330', '3711'],
    'server':    ['2382', '6669', '3231'],
    'power':     ['1519', '1503', '1513'],
    'packaging': ['2330', '3711', '3105'],
    'cpo':       ['3450', '3380', '6491'],
    'cooling':   ['3017', '3324', '3653'],
    'robot':     ['2049', '4551', '2206'],
    'finance':   ['2881', '2882', '2891'],
    'leo':       ['3491', '2313', '6285'],
    'dram':      ['2408', '2344', '8299'],   # 💾 記憶體 DRAM:南亞科/華邦電/群聯
}

def _avg_chg_pct(syms):
    pcts = []
    for s in syms:
        f = Path(DATA_DIR) / f'{s}.json'
        if not f.exists():
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list) or len(raw) < 2:
                continue
            c, pc = float(raw[-1]['close']), float(raw[-2]['close'])
            if pc > 0:
                pcts.append((c - pc) / pc * 100)
        except Exception:
            continue
    return (sum(pcts) / len(pcts)) if pcts else None

def _warzone_label(avg):
    if avg is None:
        return 'neutral', '➖ 整編中', '待資料就緒'
    if avg >= 2.0:
        return 'hot',     '🔥 狂熱',       '短線追高警戒'
    if avg >= 0.5:
        return 'surge',   '🌊 資金湧入',   '順勢偏多操作'
    if avg > -0.5:
        return 'neutral', '➖ 整理',       '觀望待方向'
    if avg > -2.0:
        return 'cool',    '❄️ 量縮防守',   '逢回測月線建倉'
    return 'dump', '💤 資金流出', '暫不介入'

def _sector_color(avg):
    if avg is None:
        return 'gray'
    if avg > 1:    return 'red_strong'
    if avg > 0.2:  return 'red'
    if avg > -0.2: return 'gray'
    if avg > -1:   return 'green'
    return 'green_strong'

def build_sector_heat():
    out = {'updated': date.today().isoformat(), 'warzones': {}, 'sectors': {}}
    for key, meta in WARZONES.items():
        avg = _avg_chg_pct(meta['syms'])
        level, label, advice = _warzone_label(avg)
        out['warzones'][key] = {
            'icon':   meta['icon'],
            'name':   meta['name'],
            'chg':    None if avg is None else round(avg, 2),
            'level':  level,
            'label':  label,
            'advice': advice,
        }
    for key, syms in SUB_SECTORS.items():
        avg = _avg_chg_pct(syms)
        out['sectors'][key] = {
            'chg':   None if avg is None else round(avg, 2),
            'color': _sector_color(avg),
        }
    Path(DATA_DIR).mkdir(exist_ok=True)
    # 原子寫入：tempfile + os.replace 避免任何併發/重複呼叫導致尾部 garbage 殘留
    _target = Path(DATA_DIR).joinpath('sector_heat.json')
    _tmp = _target.with_suffix('.json.tmp')
    _tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(_tmp), str(_target))
    wz = ' / '.join(f"{v['name']}{v['label']}" for v in out['warzones'].values())
    print(f"  ✅ 板塊熱度：{wz}")


# ── 三位一體選股 ─────────────────────────────────────────────────────────────
def generate_top_picks():
    """三位一體篩選：基本面(YoY>0) + 法人5日淨流入>0 + 分點集中度
    降級模式：chips 目錄不存在或某檔沒有 chip 資料時，自動用 2 維（YoY+法人）繼續算"""
    results = []
    chips_path = Path(DATA_DIR) / 'chips'
    degraded = not chips_path.exists()
    if degraded:
        print("  ⚠️ chips 目錄不存在，啟動 2 維降級模式（YoY + 法人）")
    else:
        print("🚀 啟動三位一體選股 (從 JSON 快取合併)...")

    # 來源檔案：有 chips 走 chips 目錄；無 chips 走 data/*.json + chips 缺值用 0
    source_files = (sorted(chips_path.glob('*.json')) if not degraded
                    else sorted(Path(DATA_DIR).glob('*.json')))

    for f in source_files:
        sym = f.stem
        # 降級模式下排除非個股 JSON（macro/futures/radar/top_picks/broker_names）
        if degraded and not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue

        try:
            fund: dict = {}
            chips_list: list = []
            if not degraded:
                raw = json.loads(f.read_text(encoding='utf-8'))
                if isinstance(raw, list):
                    continue
                fund       = raw.get('fundamentals') or {}
                chips_list = raw.get('chips') or []
            else:
                # 降級：嘗試從 data/chips/{sym}.json 撈基本面（即使 chips 目錄缺，個別檔可能存在）
                chip_file = Path(DATA_DIR) / 'chips' / f'{sym}.json'
                if chip_file.exists():
                    raw = json.loads(chip_file.read_text(encoding='utf-8'))
                    if isinstance(raw, dict):
                        fund       = raw.get('fundamentals') or {}
                        chips_list = raw.get('chips') or []

            # ① 基本面：revenue_yoy > 0
            try:
                yoy_f = float(fund.get('revenue_yoy') or 0)
            except Exception:
                continue
            if yoy_f <= 0:
                continue

            # 讀取合併好的 K 線 JSON
            kline_file = Path(DATA_DIR) / f'{sym}.json'
            if not kline_file.exists():
                continue

            kline_data = json.loads(kline_file.read_text(encoding='utf-8'))
            if not isinstance(kline_data, list) or len(kline_data) < 5:
                continue

            # ② 法人5日淨流向 > 0
            recent_5 = kline_data[-5:]
            five_day_net = sum(
                (r.get('foreign_net', 0) + r.get('trust_net', 0) + r.get('dealer_net', 0))
                for r in recent_5
            )
            if five_day_net <= 0:
                continue

            # ③ 分點集中度（近3日Top3買超 / 總買超）— chips 缺值時為 0
            concentration = 0.0
            if chips_list:
                recent_chips = chips_list[-3:]
                total_buy = sum(c.get('tot_buy', 0) for c in recent_chips)
                top3_buy  = sum(
                    sum(b.get('buy', 0) for b in
                        sorted(c.get('buyers', []), key=lambda x: -x.get('net', 0))[:3])
                    for c in recent_chips
                )
                concentration = round(top3_buy / total_buy * 100, 1) if total_buy > 0 else 0.0

            pr_close = kline_data[-1].get('close', 0)
            pr_date  = kline_data[-1].get('date', '')

            reasons = []
            reasons.append('🔥 營收高速增長' if yoy_f >= 20 else '📈 營收成長')

            consec_fi = sum(1 for r in kline_data[-3:] if r.get('foreign_net', 0) > 0)
            if consec_fi >= 3:
                reasons.append('💰 外資連買3日')
            elif five_day_net > 0:
                reasons.append('💰 法人淨流入')

            if concentration >= 40:
                reasons.append('🎯 主力強力建倉')
            elif concentration >= 20:
                reasons.append('🎯 分點籌碼集中')
            elif not chips_list:
                reasons.append('（已用 2 維簡化）')

            results.append({
                'sym':          sym,
                'close':        round(float(pr_close), 2),
                'trade_date':   pr_date,
                'revenue_yoy':  round(yoy_f, 1),
                'five_day_net': five_day_net,
                'concentration': concentration,
                'eps':          fund.get('eps'),
                'pe':           fund.get('pe'),
                'reasons':      reasons,
            })
        except Exception:
            continue

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
def prune_artifact(watchlist: list) -> None:
    """🧹 修剪 artifact：每個 batch 只保留自己採的股票，徹底消除合併同名衝突。

    checkout origin/data 會把全部 ~2556 檔鋪到 data/，但本 batch 只採其中一小段。
    若把全部上傳，20 個 artifact 同名檔在 merge 時會互相覆蓋（K線凍結主因）。
    故上傳前刪掉非本批的個股 JSON；deploy 端會以 origin/data 為底層，再疊上各 batch 的新鮮資料。
    全域檔（chips / radar / 三大快取）只由 batch 0 提供，batches 1-19 一律刪除避免衝突。
    """
    keep = set(watchlist)
    removed = 0
    for f in Path(DATA_DIR).glob('*.json'):
        sym = f.stem
        if _valid_stock(sym) and sym not in keep:
            try:
                f.unlink(); removed += 1
            except Exception:
                pass
    print(f"🧹 artifact 修剪：保留本批 {len(keep)} 檔、移除 {removed} 檔非本批殘留")

    if SKIP_GLOBAL:
        # batches 1-19 不負責全域資料，刪掉 checkout 殘留避免與 batch 0 衝突
        import shutil
        shutil.rmtree(Path(DATA_DIR) / 'chips', ignore_errors=True)
        for g in ('radar.json', 'top_picks.json', 'global_news.json', 'radar_news.json', 'tech_giants_news.json'):
            (Path(DATA_DIR) / g).unlink(missing_ok=True)
        for c in ('futures_cache.json', 'macro_cache.json',
                  'margin_cache_stock.json', 'inst_cache_stock.json'):
            Path(c).unlink(missing_ok=True)
        print("🧹 SKIP_GLOBAL：已移除全域檔（chips / radar / 快取），僅由 batch 0 提供")


if __name__ == '__main__':
    init_db()
    print("🚀 首席 AI 司令部 — 完全免費採礦機（TWSE/TAIFEX/yfinance）")
    inst_cache, margin_cache, watchlist = run()             # 採礦：OHLCV + 法人 → SQLite
    export_json(inst_cache, margin_cache)                   # 匯出 JSON：疊上最新法人快取

    if not SKIP_GLOBAL:
        # 🥇 把吃 FinMind 額度最重的工作放最前面：分點分布要逐檔打 API，token 池滿格時搶先消化
        fetch_broker_chips()    # 分點籌碼 → data/chips/*.json （FinMind 重度依賴）
        fetch_futures_cache()   # 外資期貨 → futures_cache.json （TAIFEX，不吃 FinMind 額度）
        fetch_us_macro_cache()  # 美股大盤 → macro_cache.json （yfinance）
        build_radar_cache()     # 雷達掃描（從 SQLite 讀）→ SQLite + radar.json
        build_bubble_warning()  # 💥 牛市泡沫預警 → data/bubble_warning.json （讀現成 artifacts）
        build_sector_heat()     # 🌡️ 4 戰區+9 細分板塊熱度 → data/sector_heat.json （治本前端燈號全灰）
        generate_top_picks()    # 三位一體選股 → data/top_picks.json （需 chips 已就緒）

        print("🌍 啟動全局宏觀風險採礦 (macro_miner)...")
        os.system("python3 macro_miner.py")
        # ── 🧹 【資料庫自動瘦身術】 ──
        print("\n🧹 執行資料庫碎片重組與瘦身 (VACUUM)...")
        vac_conn = sqlite3.connect(DB_PATH, timeout=30.0)
        vac_conn.execute("VACUUM;")
        vac_conn.close()
        print("  ✅ 瘦身完成！")
        # ──────────────────────────────
    else:
        print("⚡ SKIP_GLOBAL=1：略過籌碼/期貨/美股/雷達（純 OHLCV 批次）")

    # 🧹 artifact 修剪改由 daily_miner.yml 的「if: always()」step 依 mined_manifest.txt 執行，
    # 確保即使本批 timeout 被砍，上傳前仍會修剪（不再污染合併）。prune_artifact 保留供本地手動使用。