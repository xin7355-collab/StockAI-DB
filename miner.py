"""
首席 AI 司令部 — 雲端籌碼採礦機 (極速引擎 + 終極 WAL 同步與時間護盾)
資料來源：TWSE / TPEX / TAIFEX 官方免費 API + MIS 快照 + yfinance + FinMind(匿名)
特色：無痛部署、無須 API Token、1GB RAM 記憶體極限防禦、SQLite WAL 讀寫分離、智慧市場判定、ETF字母防誤殺
"""
import csv
import json
import math
import os, sys
import random
import re
import signal
import statistics
import threading
from concurrent.futures import ThreadPoolExecutor
import traceback
import sqlite3
import requests
import io
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import urllib.parse       # ⚠️ 只 import urllib3 不會帶進 urllib(check_undefined_py 當場擋下這個 NameError)
import urllib.request
import time
import random
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

from common import is_finite_num, SECTOR_MEMBERS, parse_twse_margin_ms   # 🧩 共用工具 / 板塊成分股 / TWSE 融資解析(皆單一真相來源)



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

# 🐛 V43.3 — HEADERS 過去未定義:_fetch_twii/otc_history_official 每次 NameError→被 except 吞→回 None。
#   加權靠 yfinance ^TWII 補故無感,櫃買 ^TWO yfinance 回空+官方 NameError→twoii_history 全空(盤前體檢櫃買永遠採集中)。
#   定義後官方 TWSE/TPEX 端點才會真正被呼叫。
HEADERS = {
    'User-Agent': _UA_LIST[0],
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.tpex.org.tw/',
}

# [Token 輪動] 優先讀 FINMIND_TOKENS（複數），再 fallback 到 FINMIND_TOKEN（向下相容）
_fm_env        = os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')
# 🧹 V68.2.8 每把 token 清掉「所有」空白字元(不只頭尾)。JWT 金鑰內不得有空白,
#    但從 FinMind 帳號頁複製金鑰時,常把換行處的空格一起帶進來 → 簽章壞掉 → "Token is illegal"。
#    (實證:少 1 個空格就從 illegal → 付費分點回 9113 筆。清空白對 JWT 絕對安全。)
FINMIND_TOKENS = [''.join(t.split()) for t in _fm_env.split(',') if t.strip()]
FINMIND_TOKEN  = FINMIND_TOKENS[0] if FINMIND_TOKENS else ''  # 向下相容舊引用

# [Token 輪動] 全域輪動狀態
_finmind_token_idx: int  = 0      # 目前使用的 Token 索引
_FINMIND_BLOCKED:   bool = False   # 所有 Token 均耗盡時觸發，保護程式不當機


def _recent_finmind_dates(n_days: int) -> list:
    """回近 n_days 個日曆日(今天起往回),字串 YYYY-MM-DD。分點端點用單日 date;
    非交易日 FinMind 回空,交易日才回資料,故多給幾天讓呼叫端自然命中最近交易日。"""
    today = date.today()
    return [(today - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n_days)]


def get_finmind_token() -> str:
    """[Token 輪動] 取得目前輪動中的 FinMind Token；斷路器觸發後回傳空字串。

    🔑 V71.2.8:一般資料集(法人/融資券/營收/財報/PER/股利…)**優先用免費金鑰**,
       把付費那把的 6,000 req/hr 完整留給 Sponsor 專屬的分點。
       沒有免費金鑰時才退回全部 token(行為同舊版)。
    """
    if _FINMIND_BLOCKED or not FINMIND_TOKENS:
        return ''
    pool = FINMIND_TOKENS
    return pool[_finmind_token_idx % len(pool)]


def rotate_finmind_token(tried: set) -> bool:
    """
    [Token 輪動] 切換到下一個 Token。
    tried: 本輪已嘗試過的 Token 索引集合。
    回傳 False 表示所有 Token 均已嘗試（觸發斷路器）。
    """
    global _finmind_token_idx, _FINMIND_BLOCKED
    # 🔑 V71.2.8 輪動範圍要跟 get_finmind_token() 用同一個池子(免費優先),
    #    否則會出現「取 free 池、卻用 all 池的長度取模」→ 有些 token 永遠輪不到、
    #    斷路器也會在錯的次數觸發。
    pool = FINMIND_TOKENS
    n = max(1, len(pool))
    tried.add(_finmind_token_idx % n)
    _finmind_token_idx = (_finmind_token_idx + 1) % n
    if len(tried) >= n:
        # [Token 輪動] 終極斷路器:池內 token 全數耗盡,停止 FinMind 呼叫
        _FINMIND_BLOCKED = True
        print(f'  🚫 [Token 輪動] 所有 {n} 組 FinMind Token 均已耗盡，觸發斷路器')
        return False
    print(f'  🔄 [Token 輪動] 切換至 Token #{_finmind_token_idx + 1}（共 {n} 組）')
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
        # 🐛 修:伺服器暫時錯誤(5xx)也換 token 重試,對齊「非200 fallback」精神;
        #   用同一 tried 集合確保會終止(全試過即回 None),不碰 402 付費牆熱路徑
        if res.status_code in (500, 502, 503, 504):
            print(f'  ⚠️ [fm_request] 收到 {res.status_code}(伺服器暫時錯誤),換 token 重試...')
            if not FINMIND_TOKENS or not rotate_finmind_token(tried):
                return None
            time.sleep(1.0)
            continue
        try:
            body = res.json()
        except Exception:
            return None
        # 🐛 V68.2.7 token 本身被判非法(貼錯/失效)→ FinMind 回 {status:400, msg:"Token is illegal"}。
        #   這把 token 不會因重試變好,直接換下一把(可能有另一把有效的付費金鑰);全試過才回 None。
        #   讓每支 job(法人/基本面…)都不會被「第一把壞 token」整條打死。
        _bmsg = str(body.get('msg', '')).lower() if isinstance(body, dict) else ''
        if isinstance(body, dict) and (body.get('status') in (400, 401)) and ('token' in _bmsg or 'illegal' in _bmsg):
            idx = _finmind_token_idx % max(len(FINMIND_TOKENS), 1)
            print(f'  ⚠️ [Token 輪動] Token #{idx + 1} 被判非法({body.get("msg")}),換下一把...')
            if len(FINMIND_TOKENS) > 1 and rotate_finmind_token(tried):
                time.sleep(0.5)
                continue
        return body

BATCH_INDEX    = int(os.getenv('BATCH_INDEX', '0'))
TOTAL_BATCHES  = int(os.getenv('TOTAL_BATCHES', '1'))
SKIP_GLOBAL    = bool(int(os.getenv('SKIP_GLOBAL', '0')))  # 批次 1-4 略過全市場抓取

# V14.12 — per-stock per-step timing log,給下一輪找瓶頸用
_TIMING_CSV = f"/tmp/miner_timing_{BATCH_INDEX}.csv"
try:
    with open(_TIMING_CSV, 'w', encoding='utf-8') as _tf:
        _tf.write("sym,step,sec\n")
except Exception:
    pass

def _log_t(sym: str, step: str, t0: float):
    try:
        with open(_TIMING_CSV, 'a', encoding='utf-8') as _tf:
            _tf.write(f"{sym},{step},{round(time.time() - t0, 2)}\n")
    except Exception:
        pass

# V16.4 — 採礦狀態檔:前端 poll data/miner_status.json 即可知「採礦中 / ready」+ 階段
#         寫入位置:① mine batch 開頭 ② chips_miner 開頭 ③ deploy 結尾(workflow 寫)
#         失敗不擾,主流程繼續(前端拿不到等同 ready,fallback 既有行為)
def write_miner_status(stage: str, status: str = 'mining', extra: dict | None = None):
    try:
        from datetime import datetime, timezone
        payload = {
            'status':     status,                                              # 'mining' / 'ready'
            'stage':      stage,                                               # 'ohlcv_batch' / 'chips_fundamentals' / 'deploy_done'
            'batch_idx':  BATCH_INDEX,
            'total_batches': TOTAL_BATCHES,
            'updated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        }
        if extra:
            payload.update(extra)
        Path('data').mkdir(parents=True, exist_ok=True)
        Path('data', 'miner_status.json').write_text(
            json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8'
        )
    except Exception as _e:
        print(f"  ⚠️ miner_status 寫入失敗(不影響採礦): {_e}")

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
    '5483','5274','4966','6531','1795','8996',   # V68.2.6 補上櫃常看股(中美晶 5483 等),付費分點必採

    # 高股息與權值 ETF（前端 etf_heavy 10 檔）
    '0050','0056','00878','00929','00919',
    '00713','00692','006208','00900','00939',   # ← 新增 5 檔（之前缺失導致該類別半壞）
    '00981A','00988A',
    # 9 大資金板塊指標股（與頂部指揮部 sector matrix 對齊）
    '2382','6669',                              # 伺服器代工：廣達、緯穎（緯創 3231 已在）
    '1519','1503','1513',                       # 重電基建：華城、士電、中興電
    '2330','3711','3131',                       # 先進封裝 CoWoS:台積電、日月光投控、弘塑
    '3081','3450','3363',                       # 高速傳輸 CPO:聯亞、聯鈞、上詮
    '3017','3324','3653',                       # 散熱:奇鋐、雙鴻、健策
    '2359','6188','1568',                       # 實體機器人:所羅門、廣明、盟立
    '2881','2882','2891',                       # 金融避風港：富邦金、國泰金、中信金
    '3491','2313','6285',                       # 低軌衛星：昇達科、華通、啟碁
    '2408','2344','8299',                       # 記憶體 DRAM：南亞科、華邦電、群聯（8299 已在,補 2408/2344 確保板塊每輪必採）
]))
HOT_CHIPS_LIMIT = 180   # 分點籌碼 + 基本面 FinMind 呼叫上限(V68.2.6 付費 6000/hr → 100→180 擴大冷門股覆蓋)
FUND_CACHE_DAYS = 7     # 基本面快取有效天數（財報季更新，7天重查一次即可）
# V15.8 — fundamentals schema 版本標記:每次 miner.py 改動 fundamentals 結構就 bump,
#         自動 invalidate 全市場 cache(避免 V15.7 修了欄位但 cache 7 天內擋住新邏輯)
MINER_VERSION = 'V16.6'   # V16.6 bump:三率 op_margin_trend/net_margin_trend(2026-07-02 新增)未 bump 版本 → 舊快取(<7天)不失效,強制重抓補三率



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
    # 🚀 批次 upsert:原本雙層迴圈逐筆 execute → 攤平成一個 batch 用 executemany 一次寫入,
    #    大幅減少 Python↔SQLite 往返;整個函式仍是單次 commit(不影響交易語意)。
    batch = [
        (strategy, item['sym'], item.get('close', 0), today,
         json.dumps({k: v for k, v in item.items() if k != 'sym'}))
        for strategy, items in results.items()
        for item in items
    ]
    if batch:
        c.executemany(
            "INSERT OR REPLACE INTO radar_results VALUES (?,?,?,?,?)",
            batch)
    conn.commit()
    conn.close()
    print(f"  ✅ 雷達寫入 SQLite（{len(batch)} 筆,批次寫入）")


# ── TWSE OHLCV（上市股票月資料）──────────────────────────────────────────────
def _roc_to_gregorian(roc_date: str) -> str:
    """'115/05/02' → '2026/05/02'"""
    parts = roc_date.strip().split('/')
    return f'{int(parts[0]) + 1911}/{parts[1]}/{parts[2]}'


def twse_ohlcv(symbol: str, year_month: str, _max_retries: int = 3) -> list:
    """TWSE 上市股月 OHLCV。year_month='YYYYMM'。
    🛡️ 反防火牆強化(2026-06-12 Gemini 建議的免費招式):
    - timeout 10 → 20 秒(TWSE 自家 server 確實慢,常 10 秒 connect 不上)
    - 每股每月之間 random.uniform(0.8, 2.0) 秒模擬人類看盤速度
    - timeout/ConnectionError 用 exponential backoff(2/4/8 秒)重試 3 次
    """
    url = (f'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY'
           f'?response=json&date={year_month}01&stockNo={symbol}')
    # 🎲 隨機遲緩:模糊機器人連點特徵(必做,即使第一次成功)
    time.sleep(random.uniform(0.8, 2.0))
    for attempt in range(_max_retries):
        try:
            j = http_session.get(url, headers=_HDRS, timeout=20).json()
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
            # 🛡️ Timeout / Connection error → exponential backoff 重試
            if attempt < _max_retries - 1:
                wait = 2 ** (attempt + 1)  # 2 / 4 / 8 秒
                print(f"  ⏳ TWSE {symbol} {year_month} {type(e).__name__},{wait}s 後重試({attempt + 1}/{_max_retries})")
                time.sleep(wait)
                continue
            print(f"  ⚠️  TWSE STOCK_DAY {symbol} {year_month}({_max_retries}次重試後仍失敗):{e}")
            return []
    return []


def tpex_ohlcv(symbol: str, year_month: str, _max_retries: int = 3) -> list:
    """TPEX 上櫃股月 OHLCV。year_month='YYYYMM'。
    🛡️ 反防火牆強化:timeout 10 → 20 秒,random delay 0.8-2s,exponential backoff 3 次
    """
    y, m = int(year_month[:4]), year_month[4:]
    roc_year = y - 1911
    url = (f'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/'
           f'st43_result.php?l=zh-tw&d={roc_year}/{m}&stkno={symbol}&o=json')
    time.sleep(random.uniform(0.8, 2.0))
    for attempt in range(_max_retries):
        try:
            res = http_session.get(url, headers=_HDRS, timeout=20)
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
            if attempt < _max_retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"  ⏳ TPEX {symbol} {year_month} {type(e).__name__},{wait}s 後重試({attempt + 1}/{_max_retries})")
                time.sleep(wait)
                continue
            print(f"  ⚠️  TPEX {symbol} {year_month}({_max_retries}次重試後仍失敗):{e}")
            return []
    return []


# V15.0 — 已下市股黑名單(yfinance possibly delisted 偵測後寫入,下次直接跳過)
#         每月 1 號自動 reset(避免永久誤殺剛恢復的股)
_DELISTED_FILE = Path(DATA_DIR) / 'delisted_stocks.json'
_DELISTED_CACHE = None
def _load_delisted_blacklist() -> dict:
    global _DELISTED_CACHE
    if _DELISTED_CACHE is not None:
        return _DELISTED_CACHE
    try:
        if _DELISTED_FILE.exists():
            data = json.loads(_DELISTED_FILE.read_text(encoding='utf-8'))
            # 每月 1 號 reset(根據今天日期判斷)
            if date.today().day == 1:
                print(f"  🔄 每月 1 號 reset delisted blacklist({len(data)} 筆)")
                _DELISTED_CACHE = {}
                return _DELISTED_CACHE
            _DELISTED_CACHE = data
        else:
            _DELISTED_CACHE = {}
    except Exception:
        _DELISTED_CACHE = {}
    return _DELISTED_CACHE

def _mark_delisted(symbol: str, reason: str = ''):
    bl = _load_delisted_blacklist()
    if symbol in bl: return
    bl[symbol] = {'first_detected': date.today().isoformat(), 'reason': reason[:80]}
    try:
        Path(DATA_DIR).mkdir(exist_ok=True)
        _DELISTED_FILE.write_text(json.dumps(bl, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        print(f"  ⚠️ 寫 delisted blacklist 失敗:{e}")


# 📏 V77.7.0 台股跳動單位(陷阱 #46)—— ⛔ 跟 index.html._tickOf / playbook_scan.mjs tickOf 同一張階梯,
#    scripts/test_ticksize.mjs 會跨語言比對。ETF(00 開頭)另一套:<50 → 0.01、≥50 → 0.05。
def _tick_of(p, etf=False):
    p = float(p)
    if etf:
        return 0.01 if p < 50 else 0.05
    if p < 10: return 0.01
    if p < 50: return 0.05
    if p < 100: return 0.1
    if p < 500: return 0.5
    if p < 1000: return 1.0
    return 5.0


def _on_tick(p, etf=False) -> bool:
    """收盤價在不在跳動單位格上。容許 1% 個 tick 的浮點殘差(yfinance 給 float32)。"""
    try:
        p = float(p)
    except (TypeError, ValueError):
        return False
    if not (p > 0):
        return False
    t = _tick_of(p, etf)
    q = p / t
    return abs(q - round(q)) < 0.01


_YF_OFFGRID = {'rows': 0, 'syms': set()}   # 本輪被跳動單位守門擋掉的 yfinance 列(log 用)


# ── yfinance OHLCV 補洞（TWSE/TPEX 回應不全時用 Yahoo Finance 補檔）─────────
def yfinance_ohlcv_fallback(symbol: str, market_type: str, days_back: int = 30) -> list:
    """
    用 yfinance 抓近 days_back 天的 OHLCV，回傳跟 twse_ohlcv 同格式的 rows。
    market_type='twse' → {symbol}.TW，'tpex' → {symbol}.TWO，None 兩個都試。
    失敗或無資料回 [] 不 raise。
    """
    # V15.0:已下市股直接跳過,省 yfinance 15s timeout × N 股 + log noise
    if symbol in _load_delisted_blacklist():
        return []
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
            # 🛡️ yfinance.history 無 timeout 參數、網路卡死會無限 hang → SIGALRM 硬逾時
            # V14.9 採礦加速:60s → 15s。yfinance hang 通常代表那 ticker 拿不到資料,
            #   等久也不會變;15 秒夠正常股拿 730 天 K 線,新股/復牌股直接放棄改隔天重採。
            #   實測 ~10-20% 觸發 timeout 的股每股省 45 秒,全市場估省 3-5 分。
            hist = call_with_timeout(
                lambda: yf.Ticker(tk).history(period=f'{days_back}d', auto_adjust=False),
                15, None)
            if hist is None or hist.empty:
                continue
            out = []
            _etf = str(symbol).startswith('00')
            _rej = 0
            for idx, row in hist.iterrows():
                cls = float(row.get('Close', 0) or 0)
                if cls <= 0:
                    continue
                # 🚨 V77.7.0 陷阱 #46:yfinance 給的台股 Close 就算 auto_adjust=False 仍常是**還原過除權息/配股**的價
                #    (實測上櫃 40.7% 的歷史列是這樣進來的,偏差中位 4%、P90 23%)→ 收盤不在跳動單位格上 = 不是官方成交價
                #    → ⛔ 不寫(留洞 > 寫錯);⛔ 不四捨五入湊格(那是竄改)。
                if not _on_tick(cls, _etf):
                    _rej += 1
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
            if _rej:
                _YF_OFFGRID['rows'] += _rej
                _YF_OFFGRID['syms'].add(symbol)
                print(f"  📏 {symbol} yfinance {_rej} 列收盤不在跳動單位格上(還原價)→ ⛔ 不寫")
            return out
        except Exception as e:
            err = str(e)
            print(f"  ⚠️ yfinance {tk}: {err[:120]}")
            # V15.0:偵測「possibly delisted / No data found」字樣 → 加進黑名單下次跳過
            if any(kw in err.lower() for kw in ('possibly delisted', 'no data found', 'no price data')):
                _mark_delisted(symbol, f"yfinance: {err[:60]}")
                print(f"  ⛔ 標記 {symbol} 為已下市(下次跳過,每月 1 號自動 reset)")
            continue
    return []


# 🚨 V74.2.1 — 「這一根要不要用 yfinance 覆蓋?」抽成純函式,⛔ 因為原本內嵌的判斷式漏掉最嚴重的情況。
#
# 🐛 原本寫 `old_c = existing_map[ds].get('close') or 0` + `if old_c > 0 and 差幅 >= 1.5%`
#    → **close 是 None 時 old_c 變 0,`old_c > 0` 為 False,整個跳過** ——
#    而「close 是 None」正是盤中快照留下的空殼(open/high/low/volume 都有、就是沒有收盤價),
#    也就是這段程式碼**本來要修的那個情況**。結果它只修得了「有值但不準」,修不了「根本沒值」。
#
# 📊 實測災情(2026-08-29):上櫃股 08/27・08/28 兩根 close 全是 None(TPEX 端點已對機房 IP 失效),
#    全市場抽驗 382 檔有 **188 檔(49%)** 最後一根 close=None →
#    `screener_miner` 算不出東西而略過 → `screener.json` 從 2,300+ 縮到 **1,301 檔**,
#    前端選股/AI 鏈上整批上櫃股數字全空,而且 workflow 全綠、零錯誤訊息。
def needs_price_fix(old_close, new_close, tol=0.015) -> bool:
    """既有這根要不要用 yfinance 的收盤價覆蓋?

    ⭐ 兩種都要修(⛔ 缺一不可):
      ① 根本沒有收盤價(None / 0 / 負)—— 盤中快照空殼,最嚴重
      ② 有值但與官方差 ≥ tol —— 殘留的盤中價
    ⛔ new_close 本身無效時一律不覆蓋(不可拿壞值蓋掉好值)。
    """
    try:
        nc = float(new_close)
    except (TypeError, ValueError):
        return False
    if not (nc > 0):
        return False
    if old_close is None:
        return True
    try:
        oc = float(old_close)
    except (TypeError, ValueError):
        return True
    if not (oc > 0):
        return True
    return abs(nc - oc) / oc >= tol


# 🚨 V74.2.2 — 「這一根 K 算不算有效」。⛔ 舊版只看 `volume > 0`,**完全沒看 close**。
#
# 🐛 災情鏈(2026-08-29,上櫃股整批數字消失的真因,比 V74.2.1 更前面一層):
#    盤中快照會寫下 open/high/low/**volume** 但 close 還沒有(未收盤)→ 那一根 volume 有值、close 是 None。
#    ① `latest_valid_date` 只看 volume → 認定「今天的 K 線有了」
#    ② `has_gap` 只看「日期在不在」→ 認定「沒有缺口」
#    ③ 於是走進「⚡ 本日 K 線與最終籌碼已完整,安全略過證交所請求」→ **整檔跳過**,
#       連 V74.2.1 剛修好的 yfinance 校正都沒機會執行(log 實證:6488 就是印這一行)。
#    → 上櫃股的 close 永遠補不回來,而 workflow 全綠、零錯誤訊息。
#
# ⭐ 這正是 CLAUDE.md 陷阱 #10 的同型:**跳過條件要同時看「做過」與「做到的內容夠不夠好」**。
#    ⛔ 只要「那一天有列」就當成完成,是這個專案重複踩過的坑。
def bar_is_complete(rec) -> bool:
    """一根 K 要「收盤價與成交量都有」才算數。rec 可以是 dict 或 sqlite Row。"""
    if rec is None:
        return False
    try:
        c = rec['close']
        v = rec['volume']
    except (KeyError, IndexError, TypeError):
        try:
            c, v = rec.get('close'), rec.get('volume')
        except AttributeError:
            return False
    try:
        return float(c) > 0 and float(v) > 0
    except (TypeError, ValueError):
        return False


# ── TWSE MIS 快照補丁 (盤中防退回昨日) ──────────────────────────────────────
_MIS_NO_D_WARNED = [False]


def fetch_mis_closing_snapshot(sym: str) -> dict:
    """證交所 MIS 盤中/盤後快照補丁，填補歷史 API 尚未更新的真空期"""
    tw_now = datetime.now(timezone(timedelta(hours=8)))
    # 週末不抓 MIS 快照（台股不開盤,date 會被誤標為週六/週日,污染前端 K 線）
    if tw_now.weekday() >= 5:
        return {}
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_{sym}.tw|otc_{sym}.tw"
    try:
        res = http_session.get(url, timeout=5, headers={'User-Agent': random.choice(_UA_LIST)}).json()
        if res.get('msgArray'):
            msg = res['msgArray'][0]
            z = msg.get('z', '-')
            # 🐛 V16.7 根治「非交易日幽靈 K 棒」(端午 6/19 / 颱風假 / 臨時休市 等):
            #   非交易日 MIS 沒有真實成交價 → z='-';舊版 fallback 到 y(昨收)並寫入一根量體極小的假 K,
            #   污染前端 K 線(6/19 量 178245、假日尾棒量 0)。改為「今日必須有真實成交價 z 且量 > 0」才補快照,
            #   自動涵蓋所有非交易日(不必維護節日/颱風行事曆)。週末已在上方擋掉,這裡再擋平日休市。
            if z == '-':
                return {}
            # 🎑 V77.9.2 假日 MIS 會回「上一個交易日」的成交 → 看它自己帶的日期,不是今天就不補。
            _today = _mis_is_today(msg, tw_now)
            if _today is False:
                return {}
            if _today is None and not _MIS_NO_D_WARNED[0]:
                _MIS_NO_D_WARNED[0] = True
                print("  ⚠️ MIS 回應沒有交易日期欄 d → 無法確認是不是今天的成交(照舊補快照)")
            try:
                live_price = float(z)
            except (TypeError, ValueError):
                return {}
            # 🐛 V16.8 MIS 'v'(累積成交量)單位=「張」,但歷史 STOCK_DAY/yfinance volume=「股」→ ×1000 對齊,
            #   否則今日快照量柱比歷史小 ~1000 倍(5日均量/量比失真、殭屍股誤判;且會被前端「量<中位量2%」濾除)。
            #   v 可能為 '-'/''/含逗號 → 穩健解析,失敗或 0 視為無成交(非交易日/極冷門)不補。
            _vraw = str(msg.get('v', '0')).replace(',', '').strip()
            try:
                vol = int(float(_vraw)) * 1000 if _vraw not in ('', '-') else 0
            except (TypeError, ValueError):
                vol = 0
            # 🐛 V16.9 o/h/l 穩健解析:MIS 可能回 ''/非數字(非只 '-')→ 舊版 float('') 崩潰被外層 except 吞掉、
            #   整根快照靜默漏補;改用安全轉型,壞值 fallback 到 live_price。
            def _sf(k):
                try:
                    raw = str(msg.get(k, '')).replace(',', '').strip()
                    return float(raw) if raw not in ('', '-') else live_price
                except (TypeError, ValueError):
                    return live_price
            if live_price > 0 and vol > 0:
                return {
                    'date': tw_now.strftime('%Y/%m/%d'),
                    'open': _sf('o'),
                    'high': _sf('h'),
                    'low': _sf('l'),
                    'close': live_price,
                    'volume': vol
                }
    except Exception:
        pass
    return {}


# ── TWSE 三大法人（每日全市場批次）──────────────────────────────────────────
def _otc_inst_rows(j):
    """上櫃三大法人回應 → (資料列, 欄名)。新站 {tables:[{fields,data}]}、舊站 {aaData:[...]} 都吃。"""
    if isinstance(j, dict) and j.get('tables'):
        for t in j.get('tables') or []:
            if t.get('data'):
                return t.get('data') or [], t.get('fields') or []
        return [], []
    if isinstance(j, dict):
        return (j.get('aaData') or j.get('data') or []), (j.get('fields') or [])
    return [], []


def _otc_inst_parse(rows, fields):
    """欄位用名稱找(⛔ 寫死位置是舊站專用的最後備援):
    外資 = 「外資及陸資(不含外資自營商)」的買賣超(跟上市 T86 同一個口徑)・投信買賣超・自營商買賣超(合計,不是自行/避險)。"""
    F = [str(f or '') for f in fields]
    def find(pred):
        for i, f in enumerate(F):
            if pred(f):
                return i
        return None
    i_id = find(lambda f: '代號' in f)
    i_f = find(lambda f: '外資' in f and '買賣超' in f and '不含' in f) if F else None
    if i_f is None and F:
        i_f = find(lambda f: '外資' in f and '買賣超' in f and '自營' not in f)
    i_t = find(lambda f: '投信' in f and '買賣超' in f) if F else None
    i_d = find(lambda f: '自營' in f and '買賣超' in f and not any(x in f for x in ('外資', '自行', '避險'))) if F else None
    if None in (i_id, i_f, i_t, i_d):
        if F and len(F) < 19:
            return {}
        i_id, i_f, i_t, i_d = 0, 4, 11, 18   # 舊站 aaData 的位置(V78.6.3 前就是這樣寫死、2026-09 以前實測可用)
    out = {}
    for r in rows:
        try:
            sid = str(r[i_id]).strip()
            if not _valid_stock(sid):
                continue
            num = lambda x: int(float(str(x).replace(',', '').strip() or 0))
            out[sid] = {'foreign_net': num(r[i_f]), 'trust_net': num(r[i_t]), 'dealer_net': num(r[i_d])}
        except (ValueError, IndexError, TypeError):
            pass
    return out


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
            # 🐛 V16.8 fields 正規化成字串:防某欄為 None → `'外' in f` TypeError → 整批上市法人斷檔
            fields = [str(f) if f is not None else '' for f in j.get('fields', [])]
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
    # 🚨 V78.6.3:舊端點(/web/stock/3insti/...)從 2026-10-01 起上櫃股全部變 0(log 沒報錯,只是沒資料列)
    #   → 照上櫃融資券(V75.1.x)的做法:新站優先、舊站備援,欄位用**名稱**找,一條都沒拿到要把每條的原因印出來
    #   ⛔ 新站網址沒在 runner 上驗過(沙箱連不到 TPEx,陷阱 #23)→ 由 log 的 [上櫃法人] 那行說了算
    _ce = d.strftime('%Y/%m/%d')
    _otc_cands = [
        f'https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={_ce}&response=json',
        f'https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={d_tpex}&response=json',
        f'https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d={d_tpex}',
    ]
    _why, n_otc = [], 0
    for url_otc in _otc_cands:
        _tag = url_otc.split('tpex.org.tw')[-1][:40]
        try:
            r_otc = http_session.get(url_otc, headers=_rnd_hdrs(), timeout=15)
            if r_otc.status_code != 200:
                _why.append(f"{_tag}→HTTP {r_otc.status_code}"); continue
            try:
                j = r_otc.json()
            except Exception:
                _why.append(f"{_tag}→非 JSON {str(r_otc.text or '')[:120].strip()!r}"); continue
            rows, fields = _otc_inst_rows(j)
            if not rows:
                _why.append(f"{_tag}→200 但無資料列 raw={str(j)[:160]!r}"); continue
            got = _otc_inst_parse(rows, fields)
            if len(got) < 100:
                _why.append(f"{_tag}→只解析出 {len(got)} 檔 fields={[str(f)[:12] for f in fields][:20]}"); continue
            for k, v in got.items():
                res[k] = v
            n_otc = len(got)
            print(f"  [上櫃法人] {_tag} → {n_otc} 檔")
            break
        except Exception as e:
            _why.append(f"{_tag}→{type(e).__name__}: {str(e)[:80]}")
    if not n_otc:
        print(f"  ⚠️ 上櫃法人 0 檔(正常約 800):" + ' | '.join(_why))
    fetch_market_institutional.last_otc = {'n': n_otc, 'why': _why}
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
                # 🐛 修:FinMind 此 dataset 的 name 是英文列舉(Foreign_Investor/Investment_Trust/
                #   Dealer_self/Dealer_Hedging/Foreign_Dealer_Self),舊版只比中文 → 全部落空補 0。
                #   中英雙比對;Foreign 先判(讓 Foreign_Dealer_Self 歸外資,不誤入自營)。
                if '外資' in inst or 'Foreign' in inst:
                    a['foreign_net'] += int(net)
                elif '投信' in inst or 'Trust' in inst or 'Investment' in inst:
                    a['trust_net'] += int(net)
                elif '自營' in inst or 'Dealer' in inst:
                    a['dealer_net'] += int(net)
            cnt_fix = 0
            for sid, v in agg.items():
                v_has = bool(v.get('foreign_net') or v.get('trust_net') or v.get('dealer_net'))
                if sid not in res:
                    res[sid] = v
                    cnt_new += 1
                elif v_has and not (res[sid].get('foreign_net') or res[sid].get('trust_net') or res[sid].get('dealer_net')):
                    # 🐛 V68.2.2 既有但三大法人全 0(TPEx 上櫃 se=EW 缺漏/回 0)→ 用 FinMind 非零值覆蓋(如中美晶 5483)
                    res[sid] = v
                    cnt_fix += 1
            print(f"  [FinMind 法人] 補齊 {cnt_new} 檔（缺漏補進）＋覆蓋 {cnt_fix} 檔（TPEx 回 0 → FinMind 修正）")
        except Exception as e:
            print(f"  ⚠️ [FinMind 法人] 備援失敗：{e}")

    return res


def fetch_market_margin(d: date, is_latest: bool = True) -> dict:
    """整合 TWSE (上市) 與 TPEX (上櫃) 的融資融券餘額；TWSE 失敗時用 FinMind fallback

    is_latest:`d` 是不是這一批要抓的**最新交易日**。
      🚨 V75.1.4:step 1.5 的 TWSE OpenAPI 端點**沒有日期參數 → 永遠回最新一天**,
         而呼叫端是拿最近 20 個交易日逐日呼叫 → 舊日期會被填進「最新那天」的數字。
         實證(gh-pages margin_cache_stock.json):2330 的 20 天 margin_balance
         **全部是 27,577**(2317/2603 同樣只有 1 種值)。
      ⭐ 目前還沒造成明顯髒資料(下游「只補 0」擋住了),但那是未爆彈 →
         非最新交易日一律**不採用** OpenAPI,留給 deploy job 那條**帶日期**的回補路徑。
      ⛔ 預設 True 是為了向後相容(其他呼叫端行為不變)。
    """
    res = {}
    d8 = d.strftime('%Y%m%d')
    d_iso = d.strftime('%Y-%m-%d')
    roc_y = d.year - 1911
    d_tpex = f"{roc_y}/{d.strftime('%m/%d')}"
    # 💳 V75.1.3 來源計數(寫進結果的 `_src`,呼叫端存進 margin_cache):
    #   ⭐ 沒有這幾個數字,「上櫃全 0」會被誤讀成「上櫃本來就沒融資」(實際是 TPEx 對 runner 403 一個月)。
    _src = {'twse': 0, 'tpex': 0, 'finmind': 0, 'why': ''}
    _n_before = 0

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
                # 🚨 V75.1.4:這條路現在**必定失敗**,而且不是 bug —— rwd 端點 2026/06 起改回彙總表:
                #    id 欄叫「代號」(這裡找的是「股票代號/證券代號」),而且**整張表的欄名裡
                #    完全沒有「融資/融券」字樣**(是「買進/賣出/現金償還/前日餘額/今日餘額」,
                #    前半融資、後半融券,只靠位置區分)→ 就算修好 id 比對,下面的 _find_col 一樣回 None。
                # ⛔ **別再試圖修 rwd 的解析** —— 硬修就要靠位置猜融資/融券,比現在更脆弱;
                #    實際供料的是下面 step 1.5 的 TWSE OpenAPI(欄位是具名的,安全得多)。
                # ⚠️ 警告降成一次性:呼叫端一輪跑 20 個交易日,每天印一次 = 20 行雜訊,
                #    而雜訊會讓人養成忽略警告的習慣。
                if not getattr(fetch_market_margin, '_rwd_warned', False):
                    fetch_market_margin._rwd_warned = True
                    titles = [t.get('title', '') for t in tables]
                    print(f"  ℹ️ [MI_MARGN rwd] 找不到個股表(2026/06 起改彙總表,已知且預期)→ 改走 OpenAPI;"
                          f"tables 標題={titles}(本輪只印這一次)")
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

    # 🏛️ 1.5. TWSE OpenAPI v1 第二條源:rwd 端點 2026/06 起改回彙總表後,改試官方 OpenAPI
    #    端點:https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN(RESTful list[dict])
    #    僅在 step 1 沒拿到任何個股(res 空)時試,避免徒耗 API。OpenAPI 成功則直接補上市段
    if not res and not is_latest:
        print(f"  ⏭️ [TWSE OpenAPI] {d} 不是最新交易日 → 跳過(該端點沒有日期參數,只會回最新一天)")
    if not res and is_latest:
        try:
            url_oapi = 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'
            r_oapi = http_session.get(url_oapi, headers=_rnd_hdrs(), timeout=15)
            if r_oapi.status_code == 200:
                rows_oapi = r_oapi.json()
                if isinstance(rows_oapi, list) and rows_oapi:
                    print(f"  [TWSE OpenAPI] 首筆 keys: {list(rows_oapi[0].keys())[:8]}")
                    cnt_oapi = 0
                    for row in rows_oapi:
                        if not isinstance(row, dict):
                            continue
                        sid = str(row.get('Code') or row.get('股票代號') or row.get('證券代號') or '').strip()
                        if not _valid_stock(sid):
                            continue
                        try:
                            mb_raw = row.get('MarginPurchaseTodayBalance') or row.get('融資今日餘額') or row.get('融資現在餘額') or 0
                            sb_raw = row.get('ShortSaleTodayBalance')      or row.get('融券今日餘額') or row.get('融券現在餘額') or 0
                            res[sid] = {
                                'margin_balance': int(str(mb_raw).replace(',', '') or 0),
                                'short_balance':  int(str(sb_raw).replace(',', '') or 0),
                            }
                            cnt_oapi += 1
                        except Exception:
                            continue
                    print(f"  [TWSE OpenAPI 融資券] 命中 {cnt_oapi} 檔")
                else:
                    print(f"  ⚠️ [TWSE OpenAPI] 回應非 list 或為空:{type(rows_oapi).__name__}")
            else:
                print(f"  ⚠️ [TWSE OpenAPI] HTTP {r_oapi.status_code}")
        except Exception as e:
            print(f"  ⚠️ [TWSE OpenAPI] 失敗(不影響 TPEX/FinMind/yfinance fallback):{str(e)[:80]}")
        time.sleep(random.uniform(2.0, 4.0))

    # 2. 抓取上櫃 (TPEX)
    #   🚨 V75.1.3:舊站 `margin_bal_result.php` 對 GitHub runner 早就 403(V73.6.1 實測整站 403),
    #      上櫃融資券自 2026-08-12 起全 0 卻零錯誤訊息。改成:新站候選(欄位**用名稱定位**,⛔ 不用 r[6]/r[13])
    #      → 舊站 php 當最後備援;每個候選失敗都印原因 + raw 前 200 字(陷阱 #23:不存在的路徑常回 200 + HTML)。
    #   ⚠️ 沙箱 proxy 擋 tpex → 這段只能在 GHA 驗;先跑 `scripts/otc_margin_probe.py` 看哪條活著。
    _src['twse'] = len(res)
    _n_before = len(res)
    _ce = d.strftime('%Y/%m/%d')
    _otc_cands = [
        f'https://www.tpex.org.tw/www/zh-tw/margin/balance?date={_ce}&response=json',
        f'https://www.tpex.org.tw/www/zh-tw/margin/balance?date={d_tpex}&response=json',
        f'https://www.tpex.org.tw/rwd/zh/margin/balance?date={_ce}&response=json',
        f'https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d={d_tpex}',
    ]
    _otc_why = []
    for url_otc in _otc_cands:
        _tag = url_otc.split('tpex.org.tw')[-1][:44]
        try:
            r_otc = http_session.get(url_otc, headers=_rnd_hdrs(), timeout=15)
            if r_otc.status_code != 200:
                _otc_why.append(f"{_tag}→HTTP {r_otc.status_code}"); continue
            try:
                j = r_otc.json()
            except Exception:
                _otc_why.append(f"{_tag}→非 JSON {str(r_otc.text or '')[:200].strip()!r}"); continue
            # 新站是 {tables:[{fields,data}]};舊站是 {aaData:[...]} —— 兩種都吃,欄位用名稱找,找不到才退回舊位置
            rows_otc, fields_otc = [], []
            if isinstance(j, dict) and j.get('tables'):
                for t in j.get('tables') or []:
                    if (t.get('data') or []):
                        rows_otc, fields_otc = (t.get('data') or []), (t.get('fields') or []); break
            elif isinstance(j, dict):
                rows_otc, fields_otc = (j.get('aaData') or j.get('data') or []), (j.get('fields') or [])
            if not rows_otc:
                _otc_why.append(f"{_tag}→200 但無資料列 stat={j.get('stat') if isinstance(j, dict) else '?'} raw={str(j)[:200]!r}"); continue
            # 🚨 V75.1.4:TPEx 的欄名是**簡寫**「資餘額 / 券餘額」,⛔ 不是 TWSE 的「融資今日餘額」。
            #    V75.1.3 找 '融資'/'融券' → **一個都配不到** → 一路 fall through 到寫死的 6/13,
            #    而 13 是「券償」(當日券償還)不是「券餘額」(=14) → 上櫃融券值全錯。
            #    實測(scripts/otc_margin_probe.py,2026-09-08)真實欄位:
            #      0 代號 1 名稱 2 前資餘額(張) 3 資買 4 資賣 5 現償 6 資餘額 7 資屬證金
            #      8 資使用率(%) 9 資限額 10 前券餘額(張) 11 券賣 12 券買 13 券償 14 券餘額 15 券屬證金
            #    佐證:修前 5483 融券/融資 = 0.02%、3105 = 0.00%(上市正常是 0.5~5%)。
            def _col(exact, k1, default):
                for i, f in enumerate(fields_otc):          # ① 精確:欄名就是「資餘額」/「券餘額」
                    if str(f or '').strip() == exact:
                        return i
                for i, f in enumerate(fields_otc):          # ② 寬鬆:含「資/券」+「餘」
                    f = str(f or '')
                    # 🚨「前」一定要排除 —— 前資餘額(張)/前券餘額(張) 也含「資/券」+「餘」,
                    #    配到就變成**昨天**的餘額(而且完全不會報錯)。
                    if k1 in f and '餘' in f and not any(x in f for x in ('前', '買', '賣', '償', '限額', '屬證金', '使用率')):
                        return i
                return default                              # ③ 寫死(最後備援)
            i_mb = _col('資餘額', '資', 6); i_sb = _col('券餘額', '券', 14)
            n_ok = 0
            _otc_ratio = []     # 🚧 只收**這一批 TPEx** 的融券/融資比值
            #    ⛔ 不可拿整個 `res` 去算 —— 裡面混著 TWSE 的上市股(比值 0.5~6%),
            #    max() 永遠不會落在門檻內 → 守門形同虛設(這個錯是測試 ⑧f 抓到的)。
            for r in rows_otc:
                sid = str(r[0]).strip()
                if not _valid_stock(sid):   # 跳過總計列 / 非個股列
                    continue
                try:
                    res[sid] = {
                        'margin_balance': int(str(r[i_mb]).replace(',', '') or 0),
                        'short_balance':  int(str(r[i_sb]).replace(',', '') or 0),
                    }
                    if res[sid]['margin_balance']:
                        _otc_ratio.append(res[sid]['short_balance'] / res[sid]['margin_balance'])
                    n_ok += 1
                except Exception:
                    pass
            if n_ok:
                print(f"  [TPEx 融資券] {_tag} 命中 {n_ok} 檔(欄位 融資={i_mb} 融券={i_sb})")
                # 🚧 合理性守門(V75.1.4):欄位抓錯**不會丟例外**,只會給出合法但錯誤的整數
                #    → 唯一看得出來的訊號是「融券/融資比值」。實測上市 0.14~6.17%,
                #    而抓到「券償」時全部 ≤0.02% → 門檻取 0.05% 並要求**樣本夠**才判。
                if len(_otc_ratio) >= 50 and max(_otc_ratio) <= 0.0005:
                    print(f"  ::warning::[TPEx 融資券] {len(_otc_ratio)} 檔的融券/融資比值全部 ≤0.05%"
                          f"(正常 0.5~5%)→ 疑似 i_sb={i_sb} 抓到「券償」而不是「券餘額」;"
                          f"完整 fields={fields_otc}")
                break
            _otc_why.append(f"{_tag}→{len(rows_otc)} 列但一檔都解不出(fields={fields_otc[:8]})")
        except Exception as e:
            _otc_why.append(f"{_tag}→EXC {str(e)[:120]}")
    _src['tpex'] = len(res) - _n_before
    if _src['tpex'] < 200:
        print(f"  ⚠️ 上櫃融資券只拿到 {_src['tpex']} 檔(正常約 800):" + ' | '.join(_otc_why)[:600])
    time.sleep(random.uniform(3.0, 5.0))

    # 3. FinMind 備援：兩種情況啟動 —(a) TWSE/TPEX 整批失敗;(b) 有資料但融券全 0(TWSE 欄位抓錯)
    #    後者是融券長期全 0 的根因:TWSE 給了融資卻漏融券,改由 FinMind 整批覆蓋補回融券
    _short_all_zero = bool(res) and all((v.get('short_balance', 0) == 0) for v in res.values())
    # 🚨 V75.1.3 第三種觸發:**上櫃太少**(< 200 檔;正常約 800)。⛔ 以前只看「全部失敗」或「融券全 0」
    #    → TWSE 上市成功時永遠不會為上櫃補 → 上櫃全 0 一個月零錯誤訊息。判準看「夠不夠」不看「有沒有」(陷阱 #10)。
    _otc_short = _src['tpex'] < 200
    print(f"  [融資券來源] twse={_src['twse']} tpex={_src['tpex']} ・_FINMIND_BLOCKED={_FINMIND_BLOCKED} ・tokens={len(FINMIND_TOKENS)} 把")
    if (not res or _short_all_zero or _otc_short) and not _FINMIND_BLOCKED:
        # 🚨 V75.1.4:⛔ 不可再無條件寫「TPEx 對 runner 403?」—— 那是**錯的歸因**。
        #    探針實測(otc_margin_probe.py)TPEx 三個端點全部 HTTP 200、回 920 列;
        #    而 09-09 那天 tpex=0 的真因是採礦跑在台北 08:52(**盤都還沒開**),當日資料本來就還沒公布。
        _tw_now = datetime.now(timezone(timedelta(hours=8)))
        # 未來日期,或「今天而且還沒到收盤後的公布時間(台北 18:00)」→ 本來就不該有資料
        _not_yet = d > _tw_now.date() or (d == _tw_now.date() and _tw_now.hour < 18)
        _otc_reason = (f"上櫃 {_src['tpex']} 檔:{d} 的資料尚未公布(採礦時間台北 {_tw_now:%m-%d %H:%M},早於收盤後的公布時間)"
                       if _not_yet else
                       f"上櫃只有 {_src['tpex']} 檔(正常約 800;⛔ 先看上面 _otc_why 的每條原因,別直接歸因 403)")
        reason = "TWSE+TPEX 兩條都失敗" if not res else (f"融券全 0({len(res)} 檔,疑 TWSE 欄位抓錯)" if _short_all_zero else _otc_reason)
        _src['why'] = reason
        _fill_only = bool(res) and not _short_all_zero   # ⛔ 只補「還沒有」的,不覆蓋 TWSE/TPEx 已抓到的
        print(f"  ⚠️ [融資券] {reason}，啟動 FinMind TaiwanStockMarginPurchaseShortSale 備援…(只補缺的={_fill_only})")
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
                if _fill_only and sid in res:
                    continue
                try:
                    res[sid] = {
                        'margin_balance': int(row.get('MarginPurchaseTodayBalance') or 0),
                        'short_balance':  int(row.get('ShortSaleTodayBalance')      or 0),
                    }
                    cnt += 1
                except Exception:
                    pass
            _src['finmind'] = cnt
            print(f"  [FinMind 融資券] 命中 {cnt} 檔(只補缺的={_fill_only})")
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

    fetch_market_margin.last_src = _src   # 💳 V75.1.3 來源計數(⛔ 不塞進 res —— 下游把 res 的鍵當股號迭代)
    return res


# ── 產業類別 → 個股 映射(供 industry_pe.json 算「產業相對 PE」)────────────
# 景氣循環產業:PE 低反而是高點(航運/塑化/鋼鐵等),前端會顯示警語
# ⛔ 值域是 screener_miner.IND 的**代碼**,⛔ 不是中文名 —— industry_map 存的是代碼('01'),
#    V74.6.8 起這裡放中文名 → `ind in CYCLICAL_INDUSTRIES` 對 33 個產業**全部 False**,
#    旗標從上線就沒作用過(V77.4.4 修;測試 scripts/test_industry_gate.py ⓕ 釘住)。
#    名單維持原本那 8 類,⛔ 不擴充(外部規格的 20 類清單沒有回測背書)。
CYCLICAL_INDUSTRIES = {
    '15',   # 航運
    '03',   # 塑膠
    '11',   # 橡膠
    '10',   # 鋼鐵
    '01',   # 水泥
    '09',   # 造紙
    '21',   # 化學
    '23',   # 油電燃氣
    '07',   # 化學生技(原名單的「化學生技醫療」,上櫃的舊分類;照原名單留著)
}


_COMPANY_GEO: dict = {}   # 🗺️ V71.9.8 {sym: 縣市},由 fetch_industry_map 順便填(零額外 API)
_COMPANY_NAME: dict = {}  # 🏷️ V75.1.4 {sym: 中文簡稱},同樣由 fetch_industry_map 順便填(零額外 API)
#   🚨 這份表的存在理由:前端股名本來**只靠 FinMind 匿名 API**,而它被擋之後
#      `allStockList` 變空 → 名字全變代號、**搜尋一起失效**(使用者回報的正是這個)。
#   ⛔ 官方公司基本資料**一檔 ETF 都沒有** → ETF 那半要另外補(見 build_stock_names)。

# 🗺️ V71.9.8 地緣分點用:公司住址 → 縣市。逐字稿說「關鍵分點常常就是**地緣分點**」
#    (公司在彰化,關鍵分點常在台中;「入港的分點怎麼都在買股票」)。
# ⭐ 零額外 API:`t187ap03_L/O` 就是我本來在抓產業別的那一支,它同時有「住址」欄。
_GEO_CITIES = ('台北市', '臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
               '台中市', '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣',
               '台南市', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '臺東縣',
               '澎湖縣', '金門縣', '連江縣')


def _addr_city(addr: str) -> str:
    """從住址字串取出縣市;取不到回 ''。台/臺 統一成「台」。"""
    a = str(addr or '').strip()
    if not a:
        return ''
    for c in _GEO_CITIES:
        if c in a:
            return c.replace('臺', '台')
    return ''


def fetch_industry_map() -> dict:
    """從 TWSE openapi 抓上市公司「產業別」對照表,輸出 {sym: industry_name}。
    上市 t187ap03_L + 上櫃 t187ap03_O 兩個資料集,免費無 token。
    ⭐ V71.9.8 順便把「住址→縣市」收進全域 _COMPANY_GEO(地緣分點用,零額外 API)。"""
    industry_map = {}
    global _COMPANY_GEO, _COMPANY_NAME
    _COMPANY_GEO = {}
    _COMPANY_NAME = {}
    _geo_miss_keys = None
    _added_by = {}
    # 🚨 V76.4.0 上櫃換門牌 —— 舊的 `openapi.twse.com.tw/v1/opendata/t187ap03_O` 回 **HTTP 200
    #   但 body 不是 JSON**(`r.json()` 丟 `Expecting value: line 1 column 1`),
    #   **連續 6 輪 run 全中**(08-31 / 09-07 / 09-08 / 09-09 / 09-10 / 09-11)→
    #   那個路徑在 TWSE 主機上根本不存在(陷阱 #23:API 對不存在的路徑回 200 + 網頁,不是 404)。
    #   ⭐ 同一個 repo 裡另外四支(theme_news / universal_radar / stockname_probe / otc_probe)
    #     用的是**櫃買自己的主機**,而且資料集名多了 `mopsfin_` 前綴;
    #     `stockname_probe.py` 2026-09-09 在 Actions 實跑拿回 L+O **合計 1,984 檔** → 那條是通的。
    #   ⚠️ 但 www.tpex.org.tw 對 runner 會間歇 SSLError(09-12~14 三輪都是)→ ⛔ 不可只靠一條腿:
    #     舊網址留成備援,兩條都不通還有下面的 FinMind `TaiwanStockInfo`。
    SOURCES = [
        ('TWSE 上市', ['https://openapi.twse.com.tw/v1/opendata/t187ap03_L']),
        ('TPEX 上櫃', ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
                       'https://www.tpex.org.tw/openapi/v1/t187ap03_O',
                       'https://openapi.twse.com.tw/v1/opendata/t187ap03_O']),
    ]
    for label, urls in SOURCES:
        ok = False
        for url in urls:
            if ok:
                break
            for attempt in range(2):
                try:
                    r = http_session.get(url, headers=_rnd_hdrs(), timeout=20)
                    if r.status_code != 200:
                        print(f"  ⚠️ {label} 產業別 HTTP {r.status_code} @{url.split('/')[-1]} (attempt {attempt+1}/2)")
                        time.sleep(2 ** attempt)
                        continue
                    try:
                        data = r.json()
                    except Exception as _ej:
                        # 🚨 陷阱 #23:回 200 但 body 是網頁 → ⛔ 不可只印例外訊息(那看起來像「網路壞了」),
                        #   把 **body 前 160 字**印出來,下次一眼看得出是「網址錯」還是「被擋」。
                        _bs = (r.text or '')[:160].replace('\n', ' ').strip()
                        print(f"  ⚠️ {label} 產業別 @{url.split('/')[-1]} 回 200 但不是 JSON({type(_ej).__name__})→ body 前 160 字:{_bs}")
                        break            # 同一個網址再試也是一樣的東西,換下一個
                    if not isinstance(data, list) or not data:
                        print(f"  ⚠️ {label} 產業別回應非預期 list 或空 (type={type(data).__name__}, sample={str(data)[:120]})")
                        time.sleep(2 ** attempt)
                        continue
                    added = 0
                    for row in data:
                        sym = str(row.get('公司代號') or row.get('SecuritiesCompanyCode') or row.get('Code') or '').strip()
                        ind = str(row.get('產業別') or row.get('IndustryCategory')
                                  or row.get('SecuritiesIndustryCode') or row.get('IndustryCode') or '').strip()
                        if sym and ind and sym.isdigit() and 4 <= len(sym) <= 6:
                            industry_map[sym] = ind
                            added += 1
                        # 🏷️ V75.1.4 同一列順便取「公司簡稱」= 中文股名(零額外 API)
                        #   ⚠️ 條件刻意跟產業別那行**分開**:有些列可能有名字但沒產業別,
                        #      綁在一起會讓那幾檔的名字一起漏掉(同 _COMPANY_GEO 的做法)。
                        if sym and sym.isdigit() and 4 <= len(sym) <= 6:
                            _nm = str(row.get('公司簡稱') or row.get('CompanyAbbreviation')
                                      or row.get('CompanyName') or '').strip()
                            if len(_nm) >= 2:
                                _COMPANY_NAME[sym] = _nm
                        # 🗺️ 地緣:同一列順便取住址縣市(欄名兩種寫法都吃)
                        if sym and sym.isdigit() and 4 <= len(sym) <= 6:
                            _city = _addr_city(row.get('住址') or row.get('地址')
                                               or row.get('Address') or row.get('CompanyAddress') or '')
                            if _city:
                                _COMPANY_GEO[sym] = _city
                            elif _geo_miss_keys is None:
                                _geo_miss_keys = sorted(row.keys())[:25]   # 只記一次,供診斷欄名
                    _added_by[label] = _added_by.get(label, 0) + added
                    print(f"  ✅ {label} 產業別:本次 +{added} / 累計 {len(industry_map)} @{url.split('/')[-1]} (回應 {len(data)} 列)")
                    if added == 0:
                        # 🚨 陷阱 #23 的另一半:有資料但一列都認不出來 = **欄名不同** → 把實際欄名印出來,
                        #   ⛔ 別讓下一個人再猜一輪(同 _taifex_list_endpoints 的做法)。
                        print(f"     ⚠️ 回了 {len(data)} 列卻一檔都沒收到 → 實際欄名 = {sorted(data[0].keys())[:25]}")
                    ok = True
                    break
                except Exception as e:
                    print(f"  ⚠️ {label} 產業別抓取失敗 @{url.split('/')[-1]} (attempt {attempt+1}/2):{type(e).__name__}: {str(e)[:120]}")
                    time.sleep(2 ** attempt)
        if not ok:
            print(f"  ❌ {label} 產業別 {len(urls)} 個來源全部失敗,跳過此源")
        time.sleep(random.uniform(1.0, 2.0))
    # 🆘 V76.4.0 上櫃一檔都沒拿到 → 走 FinMind `TaiwanStockInfo`(付費 token 本來就有,含上櫃)
    #   ⭐ 同 V71.7.0「台指 VIX 不必付費,換來源就好」的前例:上游不通就換一條腿,⛔ 別讓那一格永遠空著。
    #   🚨 但 FinMind 給的是**中文產業名**、TWSE 給的是**兩位數代碼** —— 直接混進去就是陷阱 #17
    #      (同一個欄位兩種格式,下游 aggregate_industry_pe 會把同一個產業拆成兩組)
    #      → 一律用 screener_miner.IND 反查回**代碼**;查不到的就跳過(⛔ 不硬塞)。
    if _added_by.get('TPEX 上櫃', 0) == 0:
        try:
            from screener_miner import IND as _IND_NAMES          # ⛔ 不另抄一份對照表(單一真相)
            # 🚨 V76.4.1 實跑 #577:FinMind 回 4,321 列卻只補進 327 檔、**1,635 檔對不到代碼**。
            #   真因不是資料缺,是**同一個產業兩邊的寫法不同**:FinMind 給「半導體**業**」「電腦**及週邊設備**業」,
            #   而 IND 存的是「半導體」「電腦週邊」→ 字串直接比當然對不上(陷阱 #17 的近親)。
            #   ⭐ 修法是**正規化**(去掉「業/工業/事業」尾巴 + 一張只放「真的寫法不同」的別名表),
            #      ⛔ 不是在這裡另抄一份產業表 —— IND 仍然是唯一真相。
            def _nrm(s):
                s = str(s or '').strip()
                for suf in ('工業', '事業', '業'):
                    if len(s) > len(suf) and s.endswith(suf):
                        s = s[:-len(suf)]; break
                return s
            # ⚠️ 只收「正規化之後還是對不上」的那幾個(實跑 log 印出來的 + 官方 33 類逐一核過)
            _ALIAS = {
                '電腦及週邊設備': '電腦週邊', '紡織纖維': '紡織', '建材營造': '營建',
                '觀光': '觀光餐旅', '觀光餐旅': '觀光餐旅', '電子': '電子',
                '化學生技醫療': '化學生技', '生技醫療': '生技醫療', '油電燃氣': '油電燃氣',
                '其他電子': '其他電子', '電子通路': '電子通路', '資訊服務': '資訊服務',
                '文化創意': '文化創意', '數位雲端': '數位雲端', '綠能環保': '綠能環保',
                '運動休閒': '運動休閒', '居家生活': '居家生活', '農業科技': '農業科技',
                '電子商務': '電子商務', '航運': '航運', '金融保險': '金融保險',
            }
            _base = {v: k for k, v in _IND_NAMES.items()}
            _name2code = dict(_base)
            for k, v in _base.items():                 # 正規化過的鍵也收(「半導體業」→「半導體」)
                _name2code.setdefault(_nrm(k), v)
            for a, b in _ALIAS.items():                # 別名 → 正規名 → 代碼
                c = _base.get(b) or _base.get(_nrm(b))
                if c:
                    _name2code.setdefault(a, c)
            jj = fm_request('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo') or {}
            rows = jj.get('data') or []
            got = miss = skip_ok = 0
            _miss_names = {}
            for row in rows:
                sym = str(row.get('stock_id') or '').strip()
                nm = str(row.get('industry_category') or '').strip()
                if not (sym.isdigit() and 4 <= len(sym) <= 6 and nm):
                    continue
                if sym in industry_map:
                    continue
                code = _name2code.get(nm) or _name2code.get(_nrm(nm))
                if code:
                    industry_map[sym] = code
                    got += 1
                elif nm in ('ETF', 'ETN', 'Index', '大盤', '存託憑證', '受益證券', '不動產投資信託'):
                    skip_ok += 1          # ⭐ 這幾種**本來就沒有產業別**,⛔ 不可算進「對不到」(會讓真的漏接被淹掉)
                else:
                    miss += 1
                    _miss_names[nm] = _miss_names.get(nm, 0) + 1
            print(f"  🆘 上櫃改走 FinMind TaiwanStockInfo:回 {len(rows)} 列 → 補進 {got} 檔"
                  f"(ETF 等本來就沒產業別 {skip_ok} 檔;⚠️ 真的對不到代碼 {miss} 檔"
                  f"{';前 8 種:' + str(sorted(_miss_names, key=_miss_names.get, reverse=True)[:8]) if miss else ''})")
        except Exception as _e_fm:
            print(f"  ⚠️ 上櫃 FinMind 備援也失敗:{type(_e_fm).__name__}: {str(_e_fm)[:120]}")
    # 🗺️ 地緣診斷:抓不到縣市時把**實際欄名**印出來(同陷阱 #23:別讓人猜欄名)
    if _COMPANY_GEO:
        print(f"  🗺️ 公司所在縣市:{len(_COMPANY_GEO)} 檔(地緣分點用)")
    else:
        print(f"  ⚠️ 公司所在縣市:0 檔 — 住址欄可能改名。實際欄名 = {_geo_miss_keys}")
    if _COMPANY_NAME:
        print(f"  🏷️ 公司中文簡稱:{len(_COMPANY_NAME)} 檔(前端股名離線表用)")
    else:
        print(f"  ⚠️ 公司中文簡稱:0 檔 — 「公司簡稱」欄可能改名。實際欄名 = {_geo_miss_keys}")
    return industry_map



def build_stock_names(industry_map: dict) -> int:
    """🏷️ V75.1.4 產出 data/stock_names.json —— 前端股名的**離線來源**(免金鑰)。

    🚨 為什麼要有這份表(使用者回報「個股中文名稱怎麼不見了」):
       前端 `fetchStockList` 本來**只靠 FinMind 匿名 API**(而且那支 URL 連 token 都沒帶),
       它被擋之後 `allStockList` 變成空的 → `getStockName` 回傳代號本身 → 名字全變代號;
       ⛔ 更嚴重的是 `_filterStockList` 清單空就直接 return [] → **搜尋整個失效**,零錯誤訊息。

    ⭐ 成本:一般股那半是**零額外 API** —— `_COMPANY_NAME` 由 fetch_industry_map 在
       同一份官方回應裡順手收的(跟 _COMPANY_GEO 同一個模式)。

    ⚠️ 已知缺口:官方公司基本資料**一檔 ETF 都沒有**,而 `data/` 裡 ETF 佔 361/2718 = 13%。
       目前先用 etf_tracking.json(約 45 檔,含 0050)保底;
       完整的 361 檔要等 `scripts/stockname_probe.py` 在 Actions 跑完定案來源再補。
       ⛔ 在那之前 **不可** 假裝已經涵蓋 ETF —— 產物裡的 `src` 統計會誠實說出各來源幾檔。

    回傳寫進去的檔數(0 = 沒寫)。
    """
    names: dict = {}
    src = {}

    # ① 官方公司基本資料(一般股)—— 零額外 API
    for sym, nm in (_COMPANY_NAME or {}).items():
        names[sym] = [nm, (industry_map or {}).get(sym, '')]
    src['official'] = len(names)

    # ② ⭐ 每日收盤行情 —— **ETF 名字的正解**(免金鑰、官方、含 ETF)
    #   探針實測(2026-09-09,scripts/stockname_probe.py):
    #     官方公司表 1,984 檔 / ETF **0 檔**  ⛔ 六檔試金石漏掉 0050・009816・00981A
    #     ⭐ 每日收盤 12,402 檔 / ETF 359 檔 ・**六檔試金石全中**
    #        0050 元大台灣50 ・009816 凱基台灣TOP50 ・00981A 主動統一台股增長
    #   ⚠️ 那 12,402 檔**含權證**(TPEx 那份 4.2MB)→ 一定要過濾。
    #   🚨 ⛔ 不可用「代號格式」過濾:主動式 ETF `00981A`(5 數字 + 1 英文)跟權證
    #      `03013T` **格式一模一樣**,規則分不開。
    #   ⭐ 正解沿用 CLAUDE.md 既有做法:**拿代號問 `data/{code}.json` 存不存在**
    #      —— 有 K 線就是有效標的,自動涵蓋 ETF/槓桿反向/主動式,零維護。
    #      代價:今天剛上市、data/ 還沒有的會漏掉一輪(可接受,FinMind 那層還在)。
    _known = set()
    try:
        _known = {f.stem for f in Path('data').glob('*.json')}
    except Exception:
        pass
    n_quote, n_skip, _n_mkt = 0, 0, 0
    if _known:
        # 🏦 V76.2.2 第三欄 = **市場別**(twse / tpex)—— 零額外 API,這個迴圈本來就分兩個來源,
        #   以前只是沒把「是從哪一支回來的」記下來。前端融資追繳線要用它分成數(上市 6 成 / 上櫃 5 成);
        #   在這之前前端 `_marginCallState` 的 `known` 恆為 false → §13 一律顯「融資資料不足」,
        #   而融資資料其實 795 列全都有(陷阱 #28:「資料源沒有」被當成「條件沒過」,訊息還講錯原因)。
        for _url, _lbl, _ck, _nk, _mkt in [
            ('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 'TWSE 收盤', 'Code', 'Name', 'twse'),
            ('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', 'TPEx 收盤',
             'SecuritiesCompanyCode', 'CompanyName', 'tpex'),
        ]:
            try:
                _r = http_session.get(_url, headers=_rnd_hdrs(), timeout=30)
                if _r.status_code != 200:
                    print(f"  ⚠️ {_lbl} HTTP {_r.status_code} → 這輪沒有它的名字")
                    continue
                _rows = _r.json()
                if not isinstance(_rows, list) or not _rows:
                    print(f"  ⚠️ {_lbl} 回應非預期 list(type={type(_rows).__name__})")
                    continue
                _add = 0
                for _row in _rows:
                    _sy = str(_row.get(_ck) or '').strip()
                    _nm = str(_row.get(_nk) or '').strip()
                    if not _sy or len(_nm) < 2:
                        continue
                    if _sy not in _known:      # 🚧 權證/沒在追的標的一律不收
                        n_skip += 1
                        continue
                    if _sy not in names:       # ⛔ 官方公司表為準,不覆蓋**名字**
                        names[_sy] = [_nm, (industry_map or {}).get(_sy, ''), _mkt]
                        _add += 1
                    else:
                        # ⭐ 名字保留官方的,但**市場別要補上去** —— 官方公司基本資料沒有這一欄,
                        #   只有這兩支收盤行情分得出來(⛔ 代號格式分不出上市/上櫃,4 碼兩邊都有)。
                        _r0 = names[_sy]
                        if isinstance(_r0, list) and len(_r0) < 3:
                            names[_sy] = [_r0[0], _r0[1] if len(_r0) > 1 else '', _mkt]
                            _n_mkt += 1
                print(f"  📇 {_lbl}:回 {len(_rows)} 列 → 新增 {_add} 檔")
                n_quote += _add
            except Exception as e:
                print(f"  ⚠️ {_lbl} 失敗:{type(e).__name__}: {e}")
    else:
        print("  ⚠️ data/ 讀不到任何 *.json → 跳過收盤行情那層(⛔ 沒有白名單就不敢收,會混進權證)")
    src['daily_quote'] = n_quote
    src['market_tagged'] = _n_mkt      # 🏦 V76.2.2 補到市場別的檔數(給資料體檢看)
    src['skipped_not_in_data'] = n_skip

    # ③ ETF 保底:etf_tracking.json 本來就有 name 欄(⛔ 只補前面沒有的,不覆蓋)
    n_etf = 0
    try:
        _p = Path('data', 'etf_tracking.json')
        if _p.exists():
            _j = json.loads(_p.read_text(encoding='utf-8'))
            for _k in ('concentration', 'etfs'):
                for _x in (_j.get(_k) or []):
                    _sy = str(_x.get('symbol') or '').strip()
                    _nm = str(_x.get('name') or '').strip()
                    if _sy and len(_nm) >= 2 and _sy not in names:
                        names[_sy] = [_nm, '']
                        n_etf += 1
    except Exception as e:
        print(f"  ⚠️ ETF 名字保底讀取失敗:{type(e).__name__}: {e}")
    src['etf_tracking'] = n_etf

    # ④ 🏷️ V77.2.0 FinMind `TaiwanStockInfo` 補「上面三層都沒有名字」的那批(使用者問第二次:
    #    「興櫃為何還是沒有中文個股名稱」)。
    #    ⭐ 先量過才做:實測 `data/` 2,368 檔個股裡 **381 檔(16.1%)**沒有名字,
    #      而 `industry_map.json` 對這 381 檔**一檔都沒有** —— 上面兩個官方來源
    #      (公司基本資料 + 每日收盤行情)天生只涵蓋**上市櫃**,興櫃不在那兩份上。
    #    ⛔ **獨立一步,不掛在任何 if 底下**(陷阱 #44:一個閘門掛好幾個不相干的產物)。
    #    🚨 **市場別存 FinMind 回的原字串**(⛔ 不硬塞成 twse/tpex)——
    #      前端 `_offListed` 靠「不是 twse/tpex」判「你可能買不到」,硬塞會把**比名字更重要的
    #      那個資訊**弄丟(V77.1.5 就是為了保住它才刻意沒補名字)。
    #    ⚠️ 沙箱連不到 FinMind → 這一步**抓不到就照實印出來**(陷阱 #22),⛔ 不靜默。
    n_fm, n_fm_mkt = 0, 0
    _fm_types = {}
    try:
        _jj = fm_request('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo') or {}
        _rows = _jj.get('data') or []
        for _row in _rows:
            _sy = str(_row.get('stock_id') or '').strip()
            _nm = str(_row.get('stock_name') or '').strip()
            _ty = str(_row.get('type') or '').strip().lower()
            if not (_sy in _known and len(_nm) >= 2):
                continue           # 🚧 一樣拿 data/*.json 當白名單濾權證
            _fm_types[_ty or '?'] = _fm_types.get(_ty or '?', 0) + 1
            if _sy not in names:
                names[_sy] = [_nm, (industry_map or {}).get(_sy, ''), _ty]
                n_fm += 1
            else:
                _r0 = names[_sy]   # ⭐ 名字保留官方的,只補市場別(⛔ 不覆蓋名字)
                if isinstance(_r0, list) and len(_r0) < 3 and _ty:
                    names[_sy] = [_r0[0], _r0[1] if len(_r0) > 1 else '', _ty]
                    n_fm_mkt += 1
        print(f"  🏷️ FinMind TaiwanStockInfo:回 {len(_rows)} 列 → 補名字 {n_fm} 檔、補市場別 {n_fm_mkt} 檔"
              f"(白名單內的市場別分佈:{dict(sorted(_fm_types.items(), key=lambda x: -x[1])[:6])})")
    except Exception as _e_nm:
        print(f"  ⚠️ FinMind 股名備援失敗:{type(_e_nm).__name__}: {str(_e_nm)[:120]}")
    src['finmind_name'] = n_fm
    src['finmind_market'] = n_fm_mkt
    # 🔍 誠實揭露:補完之後**還有幾檔沒有名字**(⛔ 不可只報「補了幾檔」就當事情做完了)
    if _known:
        _still = sorted(k for k in _known
                        if k.isdigit() and len(k) == 4 and k not in names)
        src['still_no_name'] = len(_still)
        if _still:
            print(f"  ⚠️ 補完仍有 {len(_still)} 檔沒有中文名(前 10:{_still[:10]})"
                  f" —— 多半是**興櫃**:官方那兩份與 FinMind 都沒有。"
                  f"⭐ 前端 `_offListed` 會把它們標成「🏷️ 非上市櫃」提醒流動性,⛔ 不是壞掉。")

    # ⑤ 合併舊檔:這輪某個來源掛掉時,舊的名字要留著(⛔ 不可讓它整份消失)
    out_path = Path('data', 'stock_names.json')
    n_old = 0
    try:
        if out_path.exists():
            _old = json.loads(out_path.read_text(encoding='utf-8')).get('names') or {}
            for _sy, _v in _old.items():
                if _sy not in names and isinstance(_v, list) and _v and _v[0]:
                    names[_sy] = _v
                    n_old += 1
    except Exception as e:
        print(f"  ⚠️ 舊 stock_names.json 讀取失敗(當成沒有):{type(e).__name__}: {e}")
    src['merged_old'] = n_old

    # 🚧 空過守門:半份表比沒有更糟 —— 前端會把「查不到」顯示成「這檔不存在」。
    #    ⛔ 不覆寫舊檔,讓線上維持上一輪的好資料(同 fund_sweep / chips_backfill 的自我保護)。
    MIN_OK = 1500
    if len(names) < MIN_OK:
        print(f"  ⏭️ 股名表只有 {len(names)} 檔(<{MIN_OK})→ ⛔ 不覆寫,保留既有 data/stock_names.json"
              f"(來源:{src})")
        return 0

    n_etf_total = sum(1 for k in names if k.startswith('00'))
    payload = {
        'updated': datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds'),
        'n': len(names),
        'n_etf': n_etf_total,
        'src': src,
        'caveat': '一般股來自官方公司基本資料(零額外 API);ETF 來自每日收盤行情,並用 data/*.json 當白名單濾掉權證 —— 今天剛上市、data/ 還沒有的會漏一輪',
        'names': names,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"  💾 股名離線表 → data/stock_names.json({len(names)} 檔,其中 00 開頭 {n_etf_total} 檔)")
    print(f"     來源分佈:{src}")
    # 🚧 ETF 覆蓋率守門:探針實測 data/ 裡 ETF 約 361 檔,收盤行情那層應該補得到 300+。
    #    掉到 100 以下 = 收盤行情那兩支掛了 → ⛔ 不可靜默(前端那些 ETF 會全部顯示代號)。
    if n_etf_total < 100:
        print(f"  ⚠️ ETF 只有 {n_etf_total} 檔(data/ 裡約 361 檔)→ 前端那些 ETF 仍會顯示代號。"
              f"多半是每日收盤行情那兩支沒抓到,看上面的 HTTP 狀態。")
    return len(names)


def fetch_bulk_revenue_yoy() -> dict:
    """V35.3 — FinMind TaiwanStockMonthRevenue bulk(不帶 data_id):全市場最新月營收 YoY。
    回 {sym: yoy_float}。供前端「同業數據對比」用,失敗回 {} 不影響主流程。"""
    try:
        end = date.today()
        start = end - timedelta(days=70)   # 涵蓋最近 1~2 個月公告
        url = ('https://api.finmindtrade.com/api/v4/data'
               '?dataset=TaiwanStockMonthRevenue'
               f'&start_date={start.strftime("%Y-%m-%d")}&end_date={end.strftime("%Y-%m-%d")}')
        j = fm_request(url, timeout=40)
        rows = (j or {}).get('data') or []
        latest = {}   # sym -> (date, yoy)
        for r in rows:
            sid = str(r.get('stock_id') or '').strip()
            if not _valid_stock(sid):
                continue
            d = str(r.get('date') or '')
            yoy = r.get('revenue_year_growth')
            if yoy is None:
                continue
            if sid not in latest or d > latest[sid][0]:
                latest[sid] = (d, yoy)
        out = {}
        for sid, (_d, yoy) in latest.items():
            try:    out[sid] = round(float(yoy), 1)
            except Exception: pass
        return out
    except Exception as e:
        print(f"  ⚠️ bulk 營收 YoY 失敗:{e}")
        return {}


def fetch_bulk_gross_margin() -> dict:
    """V35.3 — FinMind TaiwanStockFinancialStatements bulk(不帶 data_id):全市場最新季毛利率。
    回 {sym: gm_float}(毛利率 %)。失敗回 {} 不影響主流程。"""
    try:
        end = date.today()
        start = end - timedelta(days=150)   # 涵蓋最近 1~2 季財報
        url = ('https://api.finmindtrade.com/api/v4/data'
               '?dataset=TaiwanStockFinancialStatements'
               f'&start_date={start.strftime("%Y-%m-%d")}&end_date={end.strftime("%Y-%m-%d")}')
        j = fm_request(url, timeout=60)
        rows = (j or {}).get('data') or []
        acc = {}   # sym -> { date -> {Revenue, GrossProfit} }
        for r in rows:
            sid = str(r.get('stock_id') or '').strip()
            if not _valid_stock(sid):
                continue
            typ = (r.get('type') or '').strip()
            if typ not in ('Revenue', 'GrossProfit'):
                continue
            d = str(r.get('date') or '')
            try:    val = float(r.get('value') or 0)
            except Exception: continue
            acc.setdefault(sid, {}).setdefault(d, {})[typ] = val
        out = {}
        for sid, by_date in acc.items():
            for d in sorted(by_date.keys(), reverse=True):   # 取最新一季同時有 Revenue+GrossProfit
                rev = by_date[d].get('Revenue')
                gp  = by_date[d].get('GrossProfit')
                if rev and gp and rev > 0:
                    out[sid] = round(gp / rev * 100, 1)
                    break
        return out
    except Exception as e:
        print(f"  ⚠️ bulk 毛利率失敗:{e}")
        return {}


def aggregate_industry_pe(fund_cache: dict, industry_map: dict) -> dict:
    """把全市場 PE/PB 按產業分組,算每組中位數 + P25/P75/P90 + 標記景氣循環產業。
    V16.2:加 PB 分位數(median/p25/p75/p90),供前端動態 P/B 判斷取代固定門檻。
    輸出 dict 供寫進 data/industry_pe.json。"""
    if not fund_cache or not industry_map:
        return {}
    by_industry = {}
    for sym, fund in fund_cache.items():
        ind = industry_map.get(sym)
        if not ind: continue
        pe = (fund or {}).get('pe')
        pb = (fund or {}).get('pb') or (fund or {}).get('pbr')
        slot = by_industry.setdefault(ind, {'pes': [], 'pbs': []})
        if pe is not None and 0 < pe < 200:
            slot['pes'].append(pe)
        if pb is not None and 0 < pb < 50:
            slot['pbs'].append(pb)

    industries = {}
    for ind, d in by_industry.items():
        if len(d['pes']) < 3:   # 至少 3 檔才算中位數,避免單一個股 distortion
            continue
        sorted_pes = sorted(d['pes'])
        median_pe = sorted_pes[len(sorted_pes) // 2]
        out = {
            'median_pe': round(median_pe, 2),
            'stocks': len(d['pes']),
            'is_cyclical': ind in CYCLICAL_INDUSTRIES,
        }
        if len(d['pbs']) >= 3:
            sorted_pbs = sorted(d['pbs'])
            n = len(sorted_pbs)
            out.update({
                'median_pb': round(sorted_pbs[n // 2], 2),
                'pb_p25':    round(sorted_pbs[max(0, int(n * 0.25) - 1)], 2),
                'pb_p75':    round(sorted_pbs[min(n - 1, int(n * 0.75))], 2),
                'pb_p90':    round(sorted_pbs[min(n - 1, int(n * 0.90))], 2),
            })
        industries[ind] = out
    return industries


# V16.2 — 全市場 P/B 分位數(供前端動態判斷取代固定 <2/>5 門檻)
def _mf(v) -> float:
    """寬鬆轉 float(欄位可能是 None / 空字串 / 帶逗號的字串);轉不動回 0.0"""
    try:
        if v is None:
            return 0.0
        return float(str(v).replace(',', '').strip() or 0)
    except (TypeError, ValueError):
        return 0.0


def compute_market_margin_health() -> dict:
    """💳 V72.0.3 全市場「融資維持率」—— 危機時刻最關鍵的溫度計,我原本完全沒有。

    來源:使用者提供的巨人傑逐字稿【恐慌中獲利:130% 融資市場反彈策略】:
      「整戶擔保維持率 = 股票市值 ÷ 融資金額。**跌破 130% 券商就打電話追繳,
        不補隔天電腦自動強制賣掉** —— 這跟人性恐慌無關,是硬性規定。」
      「市場一跌破 130%,全市場斷頭令一個一個爆,券商電腦無情自動拋售;
        等被迫賣出的浮額清乾淨,賣壓突然消失 → V 型反彈。這叫**強制去槓桿**。」
      SOP:①接近 **140%** 開始注意 ②從維持率低於 130% 的股票挑觀察名單
          ③⭐**不要第一天就衝**,要等「長下影線 K 棒」或「隔天強力紅 K」

    ⭐ 為什麼值得做:個股版 `_marginCallState`(前端)早就有,但那是**單股**推估;
       他講的是**全市場整體**水位 —— 那是完全不同的東西,而且是判斷「系統性風險」的關鍵。

    📐 算法(跟前端 `_marginCallState` 同一套,⛔ 不另立第二套):
       維持率 = 融資部位現值 ÷ 融資金額
              = Σ(融資張數 × 現價) ÷ Σ(融資張數 × 推估成本 × 融資成數)
       推估成本用「**融資餘額增加日**的加權均價」(只有增加的那幾天才是新進場的融資)。

    ⚠️⚠️ 誠實揭露(必須跟著數字一起輸出,⛔ 不可省):
       ① `margin_balance` **只回溯到 2026/05**(約 55 個交易日)→ 更早進場的融資部位
          成本抓不到,推估會偏向「近期成本」。窗口拉長後會更準。
       ② 融資成數用 6 成(上市)概估;個股被降成數/停資時會失準。
       ③ ⛔ 他宣稱「26 年回測勝率 85%、6 個月報酬 27.4%」—— **那是他的數字,我沒有驗證過**,
          我的融資資料窗口根本不夠驗(需要涵蓋 2000/2008/2020 那種等級的崩盤)。
          → 前端只能顯示**現在的水位與機制說明**,⛔ 不可引用那個勝率。
    """
    data_dir = Path(DATA_DIR)
    if not data_dir.exists():
        return {}
    tot_val = 0.0        # 融資部位現值(元)
    tot_amt = 0.0        # 推估融資金額(元)
    n_ok = n_skip = 0
    tot_lots = 0.0
    for f in sorted(data_dir.glob('*.json')):
        sym = f.stem
        if not (sym.isdigit() and 4 <= len(sym) <= 6):
            continue
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(rows, list) or len(rows) < 10:
            continue
        mrows = [r for r in rows if _mf(r.get('margin_balance')) > 0]
        if len(mrows) < 8:
            n_skip += 1
            continue
        # 成本推估:只算「餘額增加」的那幾天(= 新進場的融資),權重 = 增加量
        wsum = psum = 0.0
        for i in range(1, len(mrows)):
            dq = _mf(mrows[i].get('margin_balance')) - _mf(mrows[i - 1].get('margin_balance'))
            if dq <= 0:
                continue
            h, l, c = _mf(mrows[i].get('high')), _mf(mrows[i].get('low')), _mf(mrows[i].get('close'))
            px = (h + l + c) / 3 if (h > 0 and l > 0 and c > 0) else c
            if px <= 0:
                continue
            wsum += dq
            psum += dq * px
        if wsum <= 0:
            n_skip += 1
            continue
        cost = psum / wsum
        last = mrows[-1]
        price = _mf(last.get('close'))
        lots = _mf(last.get('margin_balance'))
        if price <= 0 or lots <= 0 or cost <= 0:
            n_skip += 1
            continue
        shares = lots * 1000
        tot_val += price * shares
        tot_amt += cost * shares * 0.6      # 上市融資 6 成(概估)
        tot_lots += lots
        n_ok += 1

    if n_ok < 200 or tot_amt <= 0:
        print(f"  ⏭️ 全市場融資維持率:有效樣本僅 {n_ok} 檔(<200)→ 不寫,保留舊值")
        return {}
    ratio = tot_val / tot_amt * 100
    lvl = ('danger' if ratio < 130 else 'warn' if ratio < 140
           else 'normal' if ratio < 165 else 'high')
    out = {
        'ratio': round(ratio, 1),
        'level': lvl,
        'n': n_ok,
        'skipped': n_skip,
        'lots': int(round(tot_lots)),
        'val_e': round(tot_val / 1e8, 1),      # 融資部位現值(億)
        'amt_e': round(tot_amt / 1e8, 1),      # 推估融資金額(億)
        'date': str((_recent_finmind_dates(1) or [''])[0] or ''),
        # ⚠️ 誠實欄位:讓前端與日後的我都看得到這個估計的可信度
        'note': 'margin_balance 只回溯到 2026/05,成本推估偏向近期;融資成數用 6 成概估',
    }
    print(f"  💳 全市場融資維持率:{ratio:.1f}%({lvl})・{n_ok} 檔有效/{n_skip} 略過"
          f"・融資現值 {out['val_e']:,.0f} 億 vs 推估金額 {out['amt_e']:,.0f} 億")
    return out


def compute_market_pb_percentiles(fund_cache: dict) -> dict:
    """全市場 P/B 分位數。樣本 < 50 回 {}(呼叫端就不寫檔,保留舊值)。

    ⚠️ V71.6.2:原本樣本不足只印「< 50」不印**實際數字**,所以
    「一直是 0 檔」跟「今天只有 40 檔」長得一樣 → market_stats.json 從上線到現在
    一次都沒產出,卻沒人看得出來(真因是 fund_cache 組裝時把 pbr 丟掉了)。
    現在一律印出「掃了幾檔 / 有 pb 欄幾檔 / 過範圍幾檔」,下次一眼就知道卡在哪一關。
    """
    total = len([k for k in (fund_cache or {}) if not str(k).startswith('__')])
    has_field, pbs = 0, []
    for key, fund in (fund_cache or {}).items():
        if str(key).startswith('__'):
            continue
        pb = (fund or {}).get('pb') or (fund or {}).get('pbr')
        if pb is None:
            continue
        has_field += 1
        try:
            pb = float(pb)
        except (TypeError, ValueError):
            continue
        if 0 < pb < 50:
            pbs.append(pb)
    if len(pbs) < 50:
        print(f"  ⏭️ 全市場 P/B 樣本不足:掃 {total} 檔 → 有 pb/pbr 欄 {has_field} 檔 "
              f"→ 落在 0~50 合理區間 {len(pbs)} 檔(需 ≥50)")
        return {}
    sorted_pbs = sorted(pbs)
    n = len(sorted_pbs)
    return {
        'updated': date.today().isoformat(),
        'count': n,
        # 📊 覆蓋率一起存進 market_stats.json:下次懷疑「分位數怪怪的」時,
        #    看得出是「只有 60 檔算得出來」還是「800 檔都有」,不用再回頭猜。
        'scanned': total,
        'has_pb_field': has_field,
        'p25': round(sorted_pbs[max(0, int(n * 0.25) - 1)], 2),
        'p50': round(sorted_pbs[n // 2], 2),
        'p75': round(sorted_pbs[min(n - 1, int(n * 0.75))], 2),
        'p90': round(sorted_pbs[min(n - 1, int(n * 0.90))], 2),
    }


# ── TWSE 全市場基本面（本益比 / 殖利率 / 股價淨值比）────────────────────────
def fetch_twse_fundamentals(d: date) -> dict:
    """一次查全上市股票的 PE / 殖利率 / PBR（TWSE BWIBBU_d）"""
    d8  = d.strftime('%Y%m%d')
    url = (f'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d'
           f'?response=json&date={d8}&selectType=ALL')
    res = {}
    try:
        j = http_session.get(url, headers=_rnd_hdrs(), timeout=20).json()
        # 🚨 V76.4.0 回空要**說得出原因**(陷阱 #22)—— 以前只是靜靜回 {},
        #   而上游那句 log 只寫「TWSE 基本面回空」,分不出是「非交易日 / 還沒收盤」還是「端點改版 / 被擋」。
        #   ⚠️ 實測 2026-09-12 那輪是台北 12:56 跑的(還沒收盤)、09-13/14 是週末 → 回空**本來就是對的**;
        #      真正的 bug 是它把三個不相干的產物一起擋掉(見 V76.4.0 那段註解)。
        if j.get('stat') != 'OK':
            print(f"  ⚠️ BWIBBU_d({d8}) stat={str(j.get('stat'))[:60]} → 回空"
                  f"(常見原因:非交易日 / 當天還沒收盤;⛔ 這跟端點改版是兩件事)")
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


# ── TPEx 上櫃全市場基本面(本益比 / 殖利率 / 股價淨值比)────────────────────────
def fetch_tpex_fundamentals() -> dict:
    """🆕 V72.4.3 一次查全**上櫃**股票的 PE / 殖利率 / PBR。

    ⚠️ 為什麼需要:`fetch_twse_fundamentals`(BWIBBU_d)**只涵蓋上市**,
       於是 `fundamentals_cache.json` 840 檔全是上市 —— 上櫃股票的本益比/殖利率
       **一檔都沒有**。使用者實測中美晶(5483,上櫃)時,深度診斷誠實回報
       「缺乏基本面的本益比和殖利率數據」,查下來就是這個缺口。
    ⭐ 這是**真的缺資料**(不是沒載入),所以照使用者指示補採礦。
       TPEx OpenAPI 免金鑰、免登入,跟既有的 `t187ap03` 同一個站。

    ⛔ 候選端點是猜的(沙箱連不到 tpex)→ 全部試一輪,失敗時把「站方到底回了什麼」
       印出來,不要只印一句「失敗」(陷阱 #23:回 200 + HTML 去 parse JSON 的簽名)。
    """
    urls = [
        "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
        "https://www.tpex.org.tw/openapi/v1/mainboard_peratio_analysis",
        "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics",
    ]
    res, errs = {}, []
    for url in urls:
        try:
            r = http_session.get(url, headers=_rnd_hdrs(), timeout=25)
            if r.status_code != 200:
                errs.append(f"{url.rsplit('/', 1)[-1]}:HTTP {r.status_code}")
                continue
            try:
                rows = r.json()
            except Exception as je:
                ct = (r.headers.get("Content-Type") or "?")[:40]
                errs.append(f"{url.rsplit('/', 1)[-1]}:非JSON({ct}) {str(je)[:40]}")
                continue
            if not isinstance(rows, list) or not rows:
                errs.append(f"{url.rsplit('/', 1)[-1]}:空或結構不符({type(rows).__name__})")
                continue
            # 欄位名依站方版本而異 → 用關鍵字比對,⛔ 不寫死
            sample = rows[0] if isinstance(rows[0], dict) else {}
            def pick(*kws):
                for k in sample:
                    if any(w in str(k) for w in kws):
                        return k
                return None
            k_id = pick("SecuritiesCompanyCode", "股票代號", "Code", "代號")
            k_pe = pick("本益比", "PERatio", "PriceEarningRatio")
            k_yd = pick("殖利率", "YieldRatio", "DividendYield")
            k_pb = pick("股價淨值比", "PBRatio", "PriceBookRatio")
            if not k_id or not (k_pe or k_yd):
                errs.append(f"{url.rsplit('/', 1)[-1]}:欄位對不上 keys={list(sample)[:8]}")
                continue

            def flt(v):
                s = str(v).replace(",", "").strip()
                try:
                    return float(s) if s not in ("--", "", "N/A", "-") else None
                except ValueError:
                    return None

            for row in rows:
                if not isinstance(row, dict):
                    continue
                sym = str(row.get(k_id, "")).strip()
                if not sym or not sym[0].isdigit():
                    continue
                res[sym] = {
                    "pe": flt(row.get(k_pe)) if k_pe else None,
                    "yield_rate": flt(row.get(k_yd)) if k_yd else None,
                    "pbr": flt(row.get(k_pb)) if k_pb else None,
                }
            if res:
                print(f"  ✓ TPEx 上櫃基本面 {len(res)} 檔(來源 {url.rsplit('/', 1)[-1]})")
                break
        except Exception as e:
            errs.append(f"{url.rsplit('/', 1)[-1]}:{type(e).__name__} {str(e)[:60]}")
    if not res:
        # ⛔ 只印「失敗」查不出真因 → 把每一條的實際回應都留下來
        print(f"  ⚠️ TPEx 上櫃基本面全部失敗:{' | '.join(errs)[:400]}")
    time.sleep(random.uniform(1.0, 2.0))
    return res


# ── FinMind 個股基本面（含 Q1~Q4 履歷、次季預估、創新高雷達）────────────────
# V15.9 — FinMind TaiwanStockPER 免費 dataset:當 TWSE BWIBBU_d 拿不到時補 PE/PBR/yield
#         填滿 V15.7 P/B 缺口 + V15.7 yield_rate 缺口 + 對齊 TWSE IP 被擋問題
def _fetch_finmind_per(sym: str) -> dict:
    """FinMind TaiwanStockPER 拿 PE/PBR/yield(取代 BWIBBU_d 當被擋時的官方等價值)"""
    today_str = date.today().strftime('%Y-%m-%d')
    start_d = (date.today() - timedelta(days=14)).strftime('%Y-%m-%d')
    url = (f'https://api.finmindtrade.com/api/v4/data'
           f'?dataset=TaiwanStockPER&data_id={sym}'
           f'&start_date={start_d}&end_date={today_str}')
    try:
        j = fm_request(url, timeout=15) or {}
        rows = j.get('data') or []
        if not rows:
            return {}
        last = sorted(rows, key=lambda x: x.get('date', ''))[-1]
        def _flt(k):
            v = last.get(k)
            try: return float(v) if v not in (None, '', '-') else None
            except Exception: return None
        return {
            'pe':    _flt('PER'),
            'pb':    _flt('PBR'),
            'yield_rate': _flt('dividend_yield'),
        }
    except Exception as _e:
        print(f"    ⚠️ FinMind PER {sym}: {_e}")
        return {}



# ── 📄 V75.1.2 兩支純函式(報告頁「最新月營收 / 累計年增 / 近一年配息」的資料源)──────────
def _calc_revenue_ytd(rows):
    """月營收「累計年增」:今年 1 月 ~ 最新月合計 vs 去年**同一段**。
    rows = FinMind TaiwanStockMonthRevenue 列(需 revenue_year / revenue_month / revenue),順序不拘。
    回 (ytd_yoy_pct, months) 或 (None, 0)。
    ⛔ 去年同一段任何一個月缺列就回 None(⛔ 不可拿不完整的分母硬算 —— 那會把 YoY 灌成幾倍)。
    ⚠️ FinMind 沒有累計欄 → 一律自算;既有 730 天窗口剛好夠(今年 + 去年)。"""
    try:
        by = {}
        for r in rows or []:
            y = int(r.get('revenue_year') or 0); m = int(r.get('revenue_month') or 0)
            v = float(r.get('revenue', 0) or 0)
            if y and 1 <= m <= 12 and v > 0:
                by[(y, m)] = v
        if not by:
            return None, 0
        ly, lm = max(by.keys())
        cur = [by.get((ly, m)) for m in range(1, lm + 1)]
        prv = [by.get((ly - 1, m)) for m in range(1, lm + 1)]
        if any(v is None for v in cur) or any(v is None for v in prv):
            return None, 0
        s_cur, s_prv = sum(cur), sum(prv)
        if s_prv <= 0:
            return None, 0
        return round((s_cur - s_prv) / s_prv * 100, 1), lm
    except Exception:
        return None, 0


def _div_ttm(qdivs, asof=None):
    """近一年配息合計(TTM)。回 (total, method)。
    🚨 V75.1.2 之前寫 `sum(qdivs[-4:])` = 「近 4 **筆**」—— 對季配公司剛好是一年,
       但半年配的中美晶 5483 會被算成**兩年**(12.8 元 / 配息率 174%)、年配公司算成四年
       → X 光機誤標「吃老本」。⭐ 通用:**近 N 筆 ≠ 近 N 季**,配息頻率不同的公司會差 2~4 倍。
    method:'12m' = 除息日落在近 365 天內的列合計;'last' = 近一年一筆都沒有、但 550 天內有最後一筆
           (年配公司資料稍舊時的退路,⛔ 不可直接回 0 —— 那會顯示「沒配息」);None = 沒有任何紀錄。
    ⚠️ 用 ex_date(除息交易日)判斷,沒有的列退回公告日 date。"""
    from datetime import date as _d, datetime as _dt, timedelta as _td
    asof = asof or _d.today()
    def _p(s):
        s = str(s or '').strip().replace('/', '-')[:10]
        try:
            return _dt.strptime(s, '%Y-%m-%d').date()
        except Exception:
            return None
    rows = []
    for q in qdivs or []:
        dt = _p(q.get('ex_date')) or _p(q.get('date'))
        if not dt:
            continue
        rows.append((dt, float(q.get('cash', 0) or 0) + float(q.get('stock', 0) or 0)))
    if not rows:
        return 0.0, None
    lo = asof - _td(days=365)
    win = [v for dt, v in rows if lo < dt <= asof + _td(days=30)]   # +30 天:已公告、除息日就在眼前的也算
    if win:
        return round(sum(win), 2), '12m'
    rows.sort()
    last_dt, last_v = rows[-1]
    if last_dt >= asof - _td(days=550):
        return round(last_v, 2), 'last'
    return 0.0, None


def fetch_finmind_fundamentals(sym: str) -> dict:
    """V14.9 採礦加速 — 斧三:把 3 個獨立 FinMind 端點(財報/月營收/股利)
    從序列改 ThreadPoolExecutor 並行,單股省 6-13 秒。
    並行 fetch raw rows 後,後處理仍按原順序(payout_ratio 依賴 eps)。
    sleep 從「3 段各 2-3.5 秒 = 8-10 秒」變「並行區後一次 random 2.5 秒」。
    """
    from concurrent.futures import ThreadPoolExecutor
    today_str = date.today().strftime('%Y-%m-%d')
    start_fs  = (date.today() - timedelta(days=1095)).strftime('%Y-%m-%d') # V16.5 近3年財報(原 730→1095 保證 8 季 PEG YoY)
    start_rev = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d') # 近2年營收
    start_div = (date.today() - timedelta(days=1095)).strftime('%Y-%m-%d')
    result: dict = {}

    # 並行打 3 個 FinMind API(同股共用 token 池,RPS 限額不會因此惡化 — 跨 batch 才是瓶頸)
    def _fetch_fs():
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockFinancialStatements&data_id={sym}'
               f'&start_date={start_fs}&end_date={today_str}')
        return fm_request(url, timeout=20) or {}

    def _fetch_rev():
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockMonthRevenue&data_id={sym}'
               f'&start_date={start_rev}&end_date={today_str}')
        return fm_request(url, timeout=20) or {}

    def _fetch_div():
        url = (f'https://api.finmindtrade.com/api/v4/data'
               f'?dataset=TaiwanStockDividend&data_id={sym}'
               f'&start_date={start_div}&end_date={today_str}')
        return fm_request(url, timeout=20) or {}

    fs_json, rev_json, div_json = {}, {}, {}
    try:
        with ThreadPoolExecutor(max_workers=3) as ex:
            fut_fs  = ex.submit(_fetch_fs)
            fut_rev = ex.submit(_fetch_rev)
            fut_div = ex.submit(_fetch_div)
            try: fs_json  = fut_fs.result(timeout=25)
            except Exception as e: print(f"    ⚠️ FinMind FS {sym} 並行 fetch: {e}")
            try: rev_json = fut_rev.result(timeout=25)
            except Exception as e: print(f"    ⚠️ FinMind Revenue {sym} 並行 fetch: {e}")
            try: div_json = fut_div.result(timeout=25)
            except Exception as e: print(f"    ⚠️ FinMind Dividend {sym} 並行 fetch: {e}")
    except Exception as e:
        print(f"    ⚠️ FinMind ThreadPool {sym}: {e}")

    # 🩺 V73.4.1 診斷:三支 fetch 到底拿回幾列 —— **寫進產物**,⛔ 不是只印 log
    #   🚨 為什麼要加:使用者截圖 2327 股利全空 → 實測 gh-pages 全市場 2,074 檔
    #      **只有 46 檔(2.2%)有股利**,而且 2330/2317/2327 連 eps 都空,2454 卻有。
    #      而 `scripts/fund_gap_probe.py` 雲端實測證明 **FinMind 那三支全都給得出來**
    #      (2330:股利 31 列 / 財報 714 列 / 月營收 120 列,CashEarningsDistribution=6.0)
    #      → **不是資料源問題,是這邊的問題**,但光看程式碼推不出來是哪一步斷掉。
    #   ⭐ 照 CLAUDE.md 鐵則:「先加診斷,再下結論」+「診斷要寫進 JSON,不是只印 log」
    #      (job log 會過期,寫進產物才能 `git show origin/gh-pages:...` 直接讀)。
    result['_fetch_diag'] = {
        'fs': len((fs_json or {}).get('data') or []),
        'rev': len((rev_json or {}).get('data') or []),
        'div': len((div_json or {}).get('data') or []),
        'start_div': start_div,
    }
    if not any(result['_fetch_diag'][k] for k in ('fs', 'rev', 'div')):
        # ⛔ 三支全空 → 一定要留原因,否則下一個人只會看到「欄位都是 None」而查不出為什麼
        result['fund_error'] = f"FinMind 三支全回空(fs/rev/div=0);窗口 {start_div}~{today_str}"

    # 1. 財務報表 (Q1~Q4 EPS 歷史與毛利) ──────────────────────────────
    try:
        j = fs_json
        rows = j.get('data') or []
        
        # 處理 EPS 與 Q1~Q4 歷史標籤
        eps_rows = sorted([r for r in rows if r.get('type') == 'EPS'], key=lambda x: x.get('date', ''))
        if eps_rows:
            result['eps'] = float(eps_rows[-1].get('value', 0) or 0)
            eps_history = []
            for r in eps_rows[-8:]:  # V16.5 改 8 季(對齊 quarterly_eps,給前端 PEG ≥8 季 YoY 用)
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
        # 🆕 三率三升:營業利益率 + 淨利率 趨勢(與毛利率同法,供前端三率三升卡 + 多空計分 F 系列因子)
        # 🔢 V71.8.5 除了「趨勢箭頭」,把**最新一季的實際數值**也存下來。
        #   為什麼:趨勢只能回答「變好還變壞」,回答不了「這個水準在同業裡算高還算低」。
        #   而「同業比較」正是判斷體質的關鍵 —— 封測毛利 20% 是正常,IC 設計 20% 是警訊,
        #   用同一條 40% 的線去量兩者一定有一邊被誤判。
        #   數值本來就在下面算出來了(ms[-1]),以前只是沒存 → 幾乎零成本。
        def _margin_trend(type_names):
            num_rows = sorted([r for r in rows if r.get('type') in type_names], key=lambda x: x.get('date', ''))
            num_by_q = {r['date']: float(r.get('value', 0) or 0) for r in num_rows[-6:]}
            cq = sorted(set(num_by_q) & set(rev_by_q))[-3:]
            ms = [round(num_by_q[q] / rev_by_q[q] * 100, 1) for q in cq if rev_by_q.get(q, 0) > 0]
            if len(ms) >= 2:
                d = round(ms[-1] - ms[0], 1)
                return '→'.join(f'{m}%' for m in ms) + f'（{"↑" if d > 0 else "↓"}{abs(d)}pp）', ms[-1]
            return None, (ms[-1] if ms else None)
        op_trend,  op_val  = _margin_trend({'OperatingIncome'})
        net_trend, net_val = _margin_trend({'IncomeAfterTaxes', 'ProfitAfterTax', 'NetIncome'})
        if op_trend:  result['op_margin_trend']  = op_trend
        if net_trend: result['net_margin_trend'] = net_trend
        if op_val  is not None: result['op_margin_pct']  = op_val    # 最新一季營業利益率(%)
        if net_val is not None: result['net_margin_pct'] = net_val   # 最新一季淨利率(%)
        if gms:                 result['gross_margin_pct'] = gms[-1]  # 最新一季毛利率(%)
        # 最近4季 EPS + Revenue 摘要（季別格式：date 欄直接用）
        rev_sorted = sorted([r for r in rows if r.get('type') == 'Revenue'],
                            key=lambda x: x.get('date', ''))
        rev_by_date = {r['date']: float(r.get('value', 0) or 0) for r in rev_sorted}
        quarterly = []
        for er in eps_rows[-8:]:   # V16.5 改 8 季(原 -4:)— 前端 PEG 要 last4 vs prev4 YoY,4 季不夠
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

    # 2. 月營收 YoY + 歷史新高判定(已由並行 fetch 取得 rev_json)──────────────
    try:
        j = rev_json
        rows = sorted(j.get('data') or [], key=lambda x: x.get('date', ''))
        if rows:
            latest = rows[-1]
            yoy = latest.get('revenue_year_growth') or latest.get('RevenueYear')
            # 🛡️ FinMind 沒給 yoy 欄位時自己回推（找去年同月營收對比）
            if yoy is None:
                try:
                    lm = int(latest.get('revenue_month') or 0)
                    ly = int(latest.get('revenue_year') or 0)
                    cur_rev = float(latest.get('revenue', 0) or 0)
                    if lm and ly and cur_rev > 0:
                        for r in rows[:-1]:
                            if int(r.get('revenue_month') or 0) == lm and int(r.get('revenue_year') or 0) == ly - 1:
                                prev_rev = float(r.get('revenue', 0) or 0)
                                if prev_rev > 0:
                                    yoy = (cur_rev - prev_rev) / prev_rev * 100
                                break
                except Exception: pass
            if yoy is not None:
                result['revenue_yoy'] = round(float(yoy), 1)
            # 順手存 12 月歷史 → 前端可畫完整 12 月圖（取代「最新月摘要」救援）
            try:
                hist = [{'ym': f"{int(r.get('revenue_year') or 0):04d}-{int(r.get('revenue_month') or 0):02d}",
                         'rev': float(r.get('revenue', 0) or 0)}
                        for r in rows[-12:] if r.get('revenue_year') and r.get('revenue_month')]
                if hist:
                    result['monthly_revenue_history'] = hist
            except Exception: pass
            # 歷史新高判定：當月營收 vs 前 23 個月最大值
            latest_rev = float(latest.get('revenue', 0) or 0)
            result['latest_revenue'] = latest_rev
            if len(rows) >= 2 and latest_rev > 0:
                prior_max = max(float(r.get('revenue', 0) or 0) for r in rows[:-1])
                result['is_record_high'] = latest_rev >= prior_max
            else:
                result['is_record_high'] = False
            # 📄 V75.1.2 累計年增(報告頁要的;FinMind 沒有累計欄 → 自算,去年同段缺月就 None)
            _ytd, _ytdm = _calc_revenue_ytd(rows)
            if _ytd is not None:
                result['revenue_ytd_yoy'] = _ytd
                result['revenue_ytd_months'] = _ytdm
    except Exception as e:
        print(f"    ⚠️ FinMind Revenue {sym}: {e}")

    # 3. 股利與發配率(已由並行 fetch 取得 div_json)──────────────
    # V15.7 治本修:原本用 'CashDividend'/'StockDividend' 永遠抓 0(FinMind 實際欄位不同),
    #    對齊前端 index.html:6590 解析:Cash/StockEarningsDistribution + Cash/StockStatutorySurplus
    def _div_cash(r):
        return float(r.get('CashEarningsDistribution', 0) or 0) + float(r.get('CashStatutorySurplus', 0) or 0)
    def _div_stock(r):
        return float(r.get('StockEarningsDistribution', 0) or 0) + float(r.get('StockStatutorySurplus', 0) or 0)
    try:
        j = div_json
        rows = sorted(j.get('data') or [], key=lambda x: x.get('date', ''))
        if rows:
            # 近 8 季明細(供前端細表顯示)
            qdivs = []
            for r in rows[-8:]:
                c = _div_cash(r)
                s = _div_stock(r)
                qdivs.append({
                    'date': r.get('date', ''),
                    'ex_date': r.get('CashExDividendTradingDate') or r.get('CashDividendPaymentDate') or '',
                    'cash':  c,
                    'stock': s,
                })
            result['quarterly_dividends'] = qdivs

            # 最新單筆(向下相容)
            latest = rows[-1]
            cash_div = _div_cash(latest)
            stk_div  = _div_stock(latest)
            result['total_dividend'] = cash_div + stk_div

            # 近一年配息合計(⛔ V75.1.2 起不再是「近 4 筆」—— 半年配/年配會被算成 2~4 年,見 _div_ttm)
            #   欄位名不改(total_dividend_4q / div / payout 的語意本來就是「近一年」,改名會動到前端與 api.py)
            total_4q, _div_method = _div_ttm(qdivs)
            result['total_dividend_4q'] = round(total_4q, 2)
            result['div_win'] = _div_method or 'none'

            # 發配率改用近 4 季加總,搭配近 4 季 EPS
            eps_hist = result.get('quarterly_eps', [])
            if eps_hist and len(eps_hist) >= 4:
                eps_4q = sum(float(q.get('eps', 0) or 0) for q in eps_hist[-4:])
                if eps_4q > 0:
                    result['payout_ratio'] = round(total_4q / eps_4q * 100, 1)
            else:
                eps = result.get('eps')
                if eps and abs(eps) > 0:
                    result['payout_ratio'] = round(total_4q / (abs(eps) * 4) * 100, 1)
    except Exception as e:
        print(f"    ⚠️ FinMind Dividend {sym}: {e}")
    # V14.9:原本 3 段各 2-3.5 秒 sleep 改為單一 2 秒節流,單股省 4-8 秒
    time.sleep(random.uniform(1.5, 2.5))

    return result


# V14.15 — 填息歷史計算(在 export_json 階段呼叫,需 OHLCV 對齊除息日)
def compute_dividend_fill_history(quarterly_dividends, ohlcv_rows):
    """
    quarterly_dividends: [{date, ex_date, cash, stock}, ...] 近 8 季
    ohlcv_rows: [{date: 'YYYY/MM/DD', close: float, ...}, ...] 近 5 年
    Returns:
      fill_history: [{ex_date, cash, ex_price, fill_date, fill_days, status}, ...]
      fill_prob:    填息機率 % (filled/total*100)
      avg_fill_days: 平均填息天數
    """
    if not quarterly_dividends or not ohlcv_rows: return [], None, None
    by_date = {r.get('date', '').replace('-', '/'): r for r in ohlcv_rows if r.get('date')}
    dates_sorted = sorted(by_date.keys())
    fill_history = []
    for q in quarterly_dividends:
        cash = float(q.get('cash', 0) or 0)
        if cash <= 0: continue  # 跳過股票股利、純股票無除息
        ex_raw = q.get('ex_date') or ''
        if not ex_raw: continue
        ex_date = ex_raw.replace('-', '/')
        if ex_date not in by_date:
            # 找 ex_date 後第一個交易日
            ex_idx = None
            for i, d in enumerate(dates_sorted):
                if d >= ex_date:
                    ex_idx = i
                    ex_date = d
                    break
            if ex_idx is None: continue
        else:
            ex_idx = dates_sorted.index(ex_date)
        if ex_idx == 0: continue
        prev_close = float(by_date[dates_sorted[ex_idx - 1]].get('close', 0) or 0)
        if prev_close <= 0: continue
        ex_price = round(prev_close - cash, 2)  # 理論除息參考價
        # 找之後第一天 close >= prev_close → 填息
        fill_date = None
        fill_days = None
        for j in range(ex_idx, len(dates_sorted)):
            if (dates_sorted[j] != ex_date) and (float(by_date[dates_sorted[j]].get('close', 0) or 0) >= prev_close):
                fill_date = dates_sorted[j]
                fill_days = j - ex_idx
                break
            if j - ex_idx > 180: break  # 6 個月內未填息視為未填
        fill_history.append({
            'ex_date':   ex_date,
            'cash':      cash,
            'ex_price':  ex_price,
            'fill_date': fill_date,
            'fill_days': fill_days,
            'status':    'filled' if fill_date else 'unfilled',
        })
    if not fill_history: return [], None, None
    filled = [r for r in fill_history if r['status'] == 'filled']
    fill_prob = round(len(filled) / len(fill_history) * 100, 1)
    avg_days  = round(sum(r['fill_days'] for r in filled) / len(filled), 1) if filled else None
    return fill_history, fill_prob, avg_days


# ── SQLite ↔ JSON 橋接（gh-pages 靜態部署用）────────────────────────────────
def _bar_date(rec):
    """K 線列的日期 → (y, m, d);⛔ 兩種寫法都要吃(`2026/09/01` 與 `2026-09-01`)。"""
    try:
        p = str(rec.get('date') or '').replace('/', '-').split('-')
        return (int(p[0]), int(p[1]), int(p[2]))
    except Exception:
        return None


def _orphan_head(records, max_head=60, min_gap_days=120, min_rest=200):
    """孤兒開頭段有幾根(0 = 沒有)。判準與門檻的理由見 `_drop_bad_bars` 的說明。"""
    import datetime as _dt
    ds = []
    for r in records:
        t = _bar_date(r)
        if t is None:
            return 0                   # 🚧 日期有一根解不出來就整個不動(⛔ 寧可不砍)
        try:
            ds.append(_dt.date(*t))
        except ValueError:
            return 0
    for i in range(1, len(ds)):
        if (ds[i] - ds[i - 1]).days >= min_gap_days:
            if i <= max_head and len(records) - i >= min_rest:
                return i
            # ⛔ 只看第一個洞:中間的洞是另一回事(兩邊都是真資料,砍哪邊都是錯的)。
            # ⚠️ 誠實記錄:這個 early return 跟 `continue` **行為上等價** ——
            #    兩道檢查(`i <= max_head`、`len-i >= min_rest`)都隨 i 變大而更難通過,
            #    所以第一個洞過不了的話,後面每一個都過不了。
            #    注入驗證確認「改成 continue」測試照樣綠 → ⛔ 別以為 ⑤e 有釘住這一行
            #    (⑤e 釘的是 `i <= max_head`,拿掉它會紅)。留著它是為了表達意圖 + 省掉後面的迴圈。
            return 0
    return 0


def _mis_is_today(msg, tw_now):
    """🎑 V77.9.2 MIS 回的那一筆是不是「今天」的成交 —— True / False / None(沒有日期欄,判不出來)。

    🚨 V16.7 的守門假設「非交易日 MIS 的成交價 z = '-'」**不成立**:2026-09-25(中秋)、
       09-28(教師節)MIS 回的是**上一個交易日**的 z 與 v → 那一版照樣補了一根,
       還蓋上今天的日期 → 約 1,240 檔多出兩根假 K(收盤 = 前一天、兩天的量一模一樣)。
    ⭐ MIS 自己帶交易日期欄 `d`(YYYYMMDD)→ 跟台北今天比就好,⛔ 不必維護節日行事曆。
    """
    d = str((msg or {}).get('d') or '').strip()
    if len(d) != 8 or not d.isdigit():
        return None
    return d == tw_now.strftime('%Y%m%d')


def _twii_calendar(path=None):
    """🎑 V77.9.2 讀 `^TWII.json` 當「真的有開盤的日子」—— 回 (dates:set, lo, hi, why)。
    讀不到或不到 200 根 → dates=None + why(⛔ 呼叫端整段跳過,不猜)。"""
    p = Path(path) if path else Path(DATA_DIR) / '^TWII.json'
    try:
        arr = json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:
        return None, None, None, f'讀不到 {p.name}({type(e).__name__})'
    ds = sorted({str(r.get('date') or '')[:10].replace('-', '/') for r in arr
                 if isinstance(r, dict) and r.get('date')})
    if len(ds) < 200:
        return None, None, None, f'{p.name} 只有 {len(ds)} 根(< 200),不拿來當行事曆'
    return set(ds), ds[0], ds[-1], ''


def _holiday_ghost_dates(day_stats, cal, lo, hi, min_n=20, min_same=0.5):
    """🎑 V77.9.2 找出「確定沒開盤、卻被寫了 K 棒」的日子。

    day_stats = {'YYYY/MM/DD': (有幾檔在那天有一根, 其中幾根收盤 = 前一根收盤)}
    一個日子要**兩個條件同時成立**才算:
      ① 落在加權指數的日期範圍內(lo ≤ d < hi),而加權那天**沒有**一根
      ② 那天的 K 棒有**過半**收盤跟前一天一模一樣(真的交易日實測只有約一成)
    ⛔ ② 是防「加權自己漏一天」的保險:那種日子個股是真的有交易,收盤相同的比例很低 → 不會被刪。
    ⛔ 那天不到 min_n 檔 → 樣本太少判不出來,⛔ 不刪(寧可不砍)。
    ⛔ hi(加權最新那天)之後的日子一律不判 —— 加權還沒更新到,無法分辨。
    """
    out = set()
    if not cal:
        return out
    for d, (n, same) in day_stats.items():
        if not (lo <= d < hi) or d in cal:
            continue
        if n >= min_n and same / n >= min_same:
            out.add(d)
    return out


def _drop_bad_bars(records, sym=''):
    """🧹 V74.9.5 濾掉三種「物理上不可能是連續歷史」的壞 K 棒 —— 回 (records, notes)。

    ⭐ 三種都是**先量全市場再訂判準**的(⛔ 不是憑印象):
      ① **掛牌前殘留**(實測 33 檔):開頭連續好幾根 `volume == 0` 而且**收盤價一模一樣**。
         實例 `data/3644.json`:3.63 且量 0 連兩根 → 之後才是真的(218~370)。
         `data/4170.json` 有 **152 根**、`8098` 有 110 根 —— 那些會讓「一年位階」「近 250 日高低」
         拿一個從沒成交過的價格當歷史。
      ② **幽靈棒**(實測全市場**只有 1 根**):單日離譜、**隔天又回來**。
         實例 `data/3114.json` 2025-04-25:20.90 → **2118.96** → 21.57(×101 隔天回來)
         → K 線圖整個被壓扁、位階溫度計失真。
      ③ **孤兒開頭段**(實測 **136 檔**,共 2,727 根):開頭有一小段(15~22 根),
         接著是一個**幾年的洞**,然後才是真正的連續歷史。
         實例 `data/0052.json`:2017/12/01~12/29 共 22 根 → **跳到 2023/06/12**;
         `1506` 那段甚至在 **2000 年**(洞 8,412 天)。
         🚨 **133/136 檔的前段剛好是「某一年的某一個月」整月** —— 那是資料源的產物,
         ⛔ 不是真的歷史。留著會讓 K 線圖前面掛一段年代不明的孤島、
         也會讓任何「用整條序列」的計算把 2017 年的價格跟 2023 年的混在一起。

    ⛔ 判準刻意訂得很嚴(誤刪真實資料比留著髒資料更糟):
      ・① 要求 **量 0 且收盤價完全相同**,而且只看**開頭**那一段(⛔ 中間的不動 ——
        冷門股整天沒成交是常態,實測 1,541 檔近 250 根裡有 volume=0,那些是真的)。
      ・② 要求**前後兩根彼此接近**(0.8~1.25)**而且**中間那根相對**兩邊都**離譜 →
        「漲停之後隔天跌停」這種真實走勢前後不會接近,不會被誤刪。
      ・② 一檔最多濾 3 根 —— 超過就代表整段資料源有問題,⛔ 不該一根一根挑。
      ・③ 🚨 **前段 ≤60 根**才砍。實測前段 >60 根的只有 5 檔
        (`1435` 389 根 ・`8163` 468 根 …),那些是**真的深歷史配一個真的洞**
        (停牌或回算失敗)—— ⛔ 砍下去等於丟掉一年多的真實 K 線。
      ・③ 洞要 **≥120 天**(⛔ 不是連假)、而且後面**至少還有 200 根**
        (⛔ 不可把短歷史的股票掏空)。⛔ 只看**第一個**洞:中間的洞是另一回事
        (兩邊都是真資料,砍哪邊都是錯的)。
    ⛔ 濾除一律**印出來**(同「任何守門都要說出原因」的鐵則)。
    """
    if not records or len(records) < 10:
        return records, []
    notes = []
    # ③ 孤兒開頭段(⛔ 要排在 ① 之前 —— 砍完孤島之後,① 才對得到真正的開頭)
    #    🚨 要**迴圈砍到收斂**:實測 `0051`/`006208` 是兩層孤島
    #    (2017/06 → 洞 → 2017/12 → 洞 → 2023/06)→ 只砍一層的話第二層會留著,
    #    要等隔天那輪(JSON 讀回 SQLite 之後)才砍得到。⛔ 上限 5 圈,免得判準寫壞時無限砍。
    for _ in range(5):
        orph = _orphan_head(records)
        if not orph:
            break
        notes.append(f"開頭 {orph} 根孤兒段({records[0].get('date')}~{records[orph - 1].get('date')})"
                     f"後面接一個大洞 → 真正的歷史從 {records[orph].get('date')} 開始")
        records = records[orph:]
    C = []
    V = []
    for r in records:
        try:
            C.append(float(r.get('close') or 0))
        except (TypeError, ValueError):
            C.append(0.0)
        try:
            V.append(float(r.get('volume') or 0))
        except (TypeError, ValueError):
            V.append(0.0)
    # ① 開頭「量 0 且價格完全不動」那一段
    head = 0
    while head < len(records) and V[head] == 0 and C[head] > 0 and C[head] == C[0]:
        head += 1
    if head < 5:
        head = 0                       # ⛔ 少於 5 根不動(可能只是連假前後真的沒成交)
    if head >= len(records) - 10:
        head = 0                       # 🚧 幾乎整檔都是 → ⛔ 不砍(那是資料源問題,不是殘留)
    if head:
        notes.append(f"開頭 {head} 根掛牌前殘留(量 0 且收盤價全部是 {C[0]})")
    # ② 幽靈棒(在 head 之後找)
    drop = set()
    for i in range(head + 1, len(records) - 1):
        a, b, c = C[i - 1], C[i], C[i + 1]
        if a <= 0 or b <= 0 or c <= 0:
            continue
        if not (0.8 < a / c < 1.25):
            continue                   # 前後兩根不接近 → 那是真的走勢
        r1, r2 = b / a, b / c
        if (r1 > 1.8 and r2 > 1.8) or (r1 < 0.55 and r2 < 0.55):
            drop.add(i)
    if len(drop) > 3:
        notes.append(f"幽靈棒疑似 {len(drop)} 根(>3)→ ⛔ 不砍(整段資料源可能有問題)")
        drop = set()
    for i in sorted(drop):
        notes.append(f"幽靈棒 {records[i].get('date')} 收 {C[i]}(前 {C[i-1]} 後 {C[i+1]})")
    if head or drop:
        records = [r for i, r in enumerate(records) if i >= head and i not in drop]
    return records, notes


def _backadjust_splits(records, sym='', verbose=False):
    """🔧 V71.7.9 股票分割 / 減資 → 回溯調整舊 K 線,讓歷史連續。

    ⚠️⚠️ V76.2.4 先講一個**不要修**的情況:**除權日**會留下 −16% 這種級距的斷崖,
      而那是**合法的**(⛔ 不是壞資料、⛔ 不是這支函式漏掉的)。
      實例 2327 國巨 2024-08-15:官方 745.0 → 623.51(−16.3%),
      `data/dividends_hist.json` 那一筆記的就是 `["2024-08-15", 121.4837, "權", 745.0, 623.51]`。
      本站刻意 `auto_adjust=False`(收盤價要對得上證交所官方)→ 那根本來就會是 −16%。
      ⛔ **不可為了「修掉」它去放寬倍率表或殘差門檻** —— 放寬會把真實的除權/大跌亂乘,
      製造出新的錯誤(同下面 V74.9.4 那段「gap > 120 天那 48 次是資料洞,不可亂乘」的教訓)。
      ⭐ 判準差別:分割是**整數倍**(÷2~÷10,殘差落在漲跌停內),除權是**任意比例**(這裡是 0.837)。

    為什麼需要(2026-07-31 在回答使用者「分析師買 0050」時撈出來的真 bug):
      yfinance 那邊刻意用 `auto_adjust=False`(原始價),這樣才對得上證交所官方收盤 —— 這個
      選擇是對的,不要改。但副作用是:**股票分割/減資當天,價格會斷崖,而且已經存進
      SQLite / JSON 的舊列不會回頭調整**。
      實測 `data/0050.json`:2024/07/01 46.61→186.60(×4.00)、2025/06/11 188.65→47.16(÷4.00)
      → 中間整整一年的價位是別的尺標,K線、均線、位階溫度計、回測全部歪掉。
      而 0050 正是最多人看的 ETF。全市場掃出 **23 檔**同樣中招(0050/2327 國巨/8422/2607/
      1808/6919/4763/5904/00674R/00715L… 含正二反一槓桿 ETF)。

    判斷依據:台股上市櫃單日漲跌幅上限 **±10%** → 相鄰交易日出現 ×2/×3/×4/×5/×10
    (或其倒數)這種整數倍跳空,**物理上不可能是真實漲跌**,只能是分割/減資/反分割。
      ・只比「相鄰交易日」(日期差 ≤5 天),中間停牌很久的不算(那是缺資料不是分割)
      ・只認整數倍(2~10 或其倒數)且殘差要落在漲跌停容許範圍內(避免把興櫃無漲跌停的暴漲誤判成分割)
      ・調整方向:**保留最新的價,回頭改舊的**(最新價要等於官方收盤,不能動)
      ・成交量同步反向調整(分割後股數變多,量才可比)
    ⛔ 不動 foreign_net / margin_balance 等「張數」欄位 —— 那些是當日實際成交張數,
       不是價格尺標,改了反而失真(法人買超張數本來就該是當時的張數)。
    """
    if not records or len(records) < 3:
        return records
    # 🚨 V74.9.4 倍率表補齊 2~10(原本只有 2/3/4/5/10)——
    #   實測 `data/0052.json`(富邦科技)2025-11-19 245.30 → 35.04 = **精確的 1/7**(殘差 0.0%),
    #   而 7 不在表裡 → 那一檔的歷史價格從那天起就斷成兩截、K線與位階全歪。
    #   ⚠️⚠️ 這條的歸因**跟 CLAUDE.md V74.4.5 寫的不一樣**:那裡寫「分割 + 停牌 > 5 天修不掉」,
    #     但 0052 的 gap 是 **1 天**(不是停牌)—— 真因單純是倍率表沒有 7。
    #     ⭐ 是「先量再改」救回來的:全市場掃出的斷崖裡,gap > 120 天的那 48 次**全部**是
    #        合併深歷史留下的資料洞(2017 年孤兒段 → 2023-06),⛔ 那些不是分割,
    #        放寬 `gap > 5` 反而會把它們亂乘 = 製造新的錯誤 → 那道守門**必須留著**。
    RATIOS = tuple(range(2, 11))
    events = []
    for i in range(1, len(records)):
        try:
            c0 = float(records[i - 1].get('close') or 0)
            c1 = float(records[i].get('close') or 0)
        except (TypeError, ValueError):
            continue
        if c0 <= 0 or c1 <= 0:
            continue
        d0 = str(records[i - 1].get('date') or '').replace('/', '-')
        d1 = str(records[i].get('date') or '').replace('/', '-')
        try:
            gap = (date.fromisoformat(d1) - date.fromisoformat(d0)).days
        except ValueError:
            continue
        if gap > 5:                      # 中間缺很多天 → 不是「單日」跳空
            continue
        rat = c1 / c0
        if 0.8 < rat < 1.25:             # 正常波動(含除權息小缺口)不碰
            continue
        # 台股上市櫃單日漲跌幅上限 ±10% → 跨 n 個交易日最多也只能到 1.1^n。
        # 超出這個「物理上限」就不可能是真實漲跌,只能是分割/減資/反分割。
        # (gap 是日曆天,含週末 → 用 gap 當交易日數是**高估**,對判定偏保守,不會亂認。)
        limit = 1.10 ** max(1, gap)
        if (1.0 / limit) <= rat <= limit:
            continue                     # 還在漲跌停能解釋的範圍內 → 不是分割
        # 找最接近的整數倍(或其倒數),殘差要落在漲跌停容許範圍內才算數;
        # ⚠️ 用「最接近的整數倍」而不是直接拿 rat 當倍率,是為了**不誤傷興櫃**
        #    (興櫃無漲跌幅限制,真的可能單日翻倍,但不會剛好是整數倍 ±漲跌停)。
        best = None
        for k in RATIOS:
            for cand in (float(k), 1.0 / k):
                resid = rat / cand                       # 扣掉分割後剩下的「真實漲跌」
                if (1.0 / limit) <= resid <= limit:
                    err = abs(resid - 1.0)
                    if best is None or err < best[1]:
                        best = (cand, err)
        if best:
            events.append((i, best[0]))
    if not events:
        return records
    # 先算出「每一列的累積倍率」,最後只乘一次再四捨五入。
    # ⚠️ 別寫成「每個事件各跑一輪、每輪都 round(…, 2)」—— 連兩次分割時,第一輪的
    #    四捨五入誤差會被第二輪放大(實測 46.61 ÷4 ×4 會變成 46.60),看起來像資料髒掉。
    cum = [1.0] * len(records)
    for idx, factor in events:
        for i in range(idx):
            cum[i] *= factor
    for i, r in enumerate(records):
        k = cum[i]
        if k == 1.0:
            continue
        for f in ('open', 'high', 'low', 'close'):
            try:
                v = float(r.get(f) or 0)
                if v > 0:
                    r[f] = round(v * k, 2)
            except (TypeError, ValueError):
                pass
        try:
            v = float(r.get('volume') or 0)
            if v > 0:
                r['volume'] = int(round(v / k))   # 股數與價格反向
        except (TypeError, ValueError):
            pass
    if verbose:
        desc = '、'.join(f"{records[i].get('date')} ×{f:.4g}" for i, f in events)
        print(f"  🔧 {sym} 偵測到 {len(events)} 次分割/減資,已回溯調整舊 K 線:{desc}")
    return records


# 🧱 V77.7.0 陷阱 #46 修復:用 FinMind 原始價(klines_deep 分支)把「還原價」列換回官方成交價
#
# 🚨 為什麼要這支:正式產物 data/*.json 上櫃股 40.7% 的列(2023~2025)是 yfinance 填進來的**還原價**
#    (偏差中位 4%、P90 23%,在除權息日階梯狀跳一格)。官方月資料只回抓近 3 個月、TPEx 舊端點又已失效
#    → 那些列**永遠不會被換掉**,而 seed_db_from_json 每輪把它讀回來 = 自我延續。
# ⭐ 真值:klines_deep 分支 = FinMind TaiwanStockPrice 原始價(2021-01 起;實測 2023-05 起上櫃不在格上只有 0.1%,
#    那 0.1% 是分割還原過的舊列)。**零 API**,workflow 在 batch job 把它解到 KLINES_DEEP_DIR。
# ⛔ 判準不能只看跳動單位(分割還原過的舊列本來就不在格上;<10 元的還原價被 _round_prices 收到 2 位後又剛好在格上)
#    → 用「我們的收盤 ÷ 深歷史收盤」:兩邊都過同一支 _backadjust_splits,合法列 ≈ 1。
#    ① r ≈ 1 或 2~10 或其倒數 → 合法(後者 = 兩邊分割尺標不同),不動
#    ② 其餘 → 換成「深歷史 × 前後合法列的倍數」,**籌碼欄一個都不動**;前後倍數不同(卡在分割邊界)⛔ 不換。
#    冪等:換過的列下一輪 r 就是合法倍數,零動作。
_DEEP_FIX = {'rows': 0, 'syms': 0, 'split_skip': [], 'nodeep': 0, 'dir': None}
_DEEP_CACHE = {}


def _deep_dir():
    d = os.environ.get('KLINES_DEEP_DIR') or ''
    if not d:
        return None
    for c in (os.path.join(d, 'klines_deep'), d):
        if os.path.isdir(c):
            return c
    return None


def _load_deep(sym):
    d = _deep_dir()
    if not d:
        return None
    f = os.path.join(d, f'{sym}.json.gz')
    if not os.path.exists(f):
        return None
    try:
        import gzip
        with gzip.open(f, 'rt', encoding='utf-8') as fh:
            j = json.load(fh)
        return j.get('k') or []
    except Exception as e:
        print(f"  ⚠️ {sym} klines_deep 讀不到:{e}")
        return None


_SPLIT_FACTORS = [1.0] + [float(k) for k in range(2, 11)] + [1.0 / k for k in range(2, 11)]


def _split_factor_of(r, tol=0.005):
    """r 若 ≈ 1 或 2~10 或其倒數 → 回那個倍數;否則 None。"""
    for f in _SPLIT_FACTORS:
        if abs(r / f - 1) <= tol:
            return f
    return None


def _repair_from_deep(records, sym='', deep=None):
    """回 (records, 換了幾列, 原因字串或 None)。deep = [[YYYY-MM-DD, o, h, l, c, v], ...]

    ⭐ 分段尺標:兩邊分割還原不一定同步(0050/2327 那種「分割 + 停牌 >5 天」一邊修得掉一邊修不掉)
       → 每一列先問「r 是不是 1 或 2~10 倍」;是 = 合法列,記下它的倍數 f。
       不是 = 還原價列 → 換成「深歷史 × f」,f 取**前後最近的合法列**;前後兩邊 f 不一樣(剛好卡在分割邊界)→ ⛔ 不換。
    """
    if deep is None:
        deep = _load_deep(sym)
    if not deep:
        return records, 0, 'no-deep'
    dmap = {}
    for row in deep:
        try:
            if row and row[4] and float(row[4]) > 0:
                dmap[str(row[0])[:10]] = row
        except (TypeError, ValueError, IndexError):
            continue
    info = []          # (i, dk, f 或 None)
    for i, r in enumerate(records):
        ds = str(r.get('date', '')).replace('/', '-')[:10]
        dk = dmap.get(ds)
        c = r.get('close')
        if not dk or not isinstance(c, (int, float)) or c <= 0:
            continue
        info.append((i, dk, _split_factor_of(c / float(dk[4]))))
    n = len(info)
    prev_f = [None] * n; nxt_f = [None] * n
    last = None
    for k in range(n):
        prev_f[k] = last
        if info[k][2] is not None:
            last = info[k][2]
    last = None
    for k in range(n - 1, -1, -1):
        nxt_f[k] = last
        if info[k][2] is not None:
            last = info[k][2]
    # ⭐ 以「段」為單位換(⛔ 不逐列、⛔ 不挑):兩列合法列(r = 合法倍數)之間的**整段**都換成「深歷史 × 倍數」。
    #    🚨 第一版逐列挑(「不在格上才換」「比值穩定才換」)實測**製造了 3,900 個假跳空** ——
    #       同一段裡被挑剩的那幾列(剛好在格上、比值差一點點、那天深歷史沒資料)留著還原價,
    #       跟換過的鄰居一比就是 20%~30% 的斷崖。還原價是**整段一起歪**的,修也要整段一起修。
    #    深歷史那天沒資料的列:用段內最近那一列的換算比例縮放(⛔ 不可留原值)。
    #    兩端合法列的倍數不一樣(剛好卡在分割邊界)→ ⛔ 整段不動。
    fixed = 0; amb = 0; dirty = 0
    legit_k = [k for k, x in enumerate(info) if x[2] is not None]
    bounds = [-1] + legit_k + [n]
    for bi in range(len(bounds) - 1):
        k0, k1 = bounds[bi] + 1, bounds[bi + 1] - 1
        if k0 > k1:
            continue
        a = info[bounds[bi]][2] if bounds[bi] >= 0 else None
        b = info[bounds[bi + 1]][2] if bounds[bi + 1] < n else None
        if a is not None and b is not None and a != b:
            amb += k1 - k0 + 1
            continue
        g = a if a is not None else b
        if g is None:
            amb += k1 - k0 + 1
            continue
        i_lo, i_hi = info[k0][0], info[k1][0]
        scale_at = {}
        for k in range(k0, k1 + 1):
            i, dk, _f = info[k]
            r = records[i]
            old_c = r['close']
            r['open'], r['high'], r['low'], r['close'] = (round(float(dk[1]) * g, 4), round(float(dk[2]) * g, 4),
                                                          round(float(dk[3]) * g, 4), round(float(dk[4]) * g, 4))
            try:
                if dk[5] is not None:
                    r['volume'] = int(round(int(dk[5]) / g))
            except (TypeError, ValueError, IndexError):
                pass
            scale_at[i] = r['close'] / old_c
            fixed += 1
        # 段內深歷史沒資料的列 → 用最近那一列的換算比例
        idxs = sorted(scale_at)
        for i in range(i_lo, i_hi + 1):
            if i in scale_at:
                continue
            r = records[i]
            if not isinstance(r.get('close'), (int, float)) or r['close'] <= 0:
                continue
            near = min(idxs, key=lambda x: abs(x - i))
            f2 = scale_at[near]
            for key in ('open', 'high', 'low', 'close'):
                if isinstance(r.get(key), (int, float)):
                    r[key] = round(r[key] * f2, 4)
            fixed += 1
    note = []
    if amb: note.append(f'{amb} 列卡在分割邊界/沒有合法鄰居')
    return records, fixed, ('、'.join(note) + ' → 沒換' if note else None)


def _round_prices(records):
    """📏 V77.2.6 把 OHLC 對到「台股價格真正的精度」= 小數 2 位。

    🚨 為什麼需要(使用者回報:「個股的現價的小數點怎麼這麼多?」):
       `data/*.json` 裡有大量 `93.69999694824219` / `70.80000305175781` 這種尾巴
       —— 那是 **float32 被放大成 float64** 的殘留(49.0 的 float32 就是 49.000633239746094)。
       實測隨機 300 檔:**165 檔(55%)** 的近 60 根中招。
       ⛔ 台股沒有任何一檔的報價會有 3 位以上小數(跳動單位最細是 0.01)
          → 那些位數**沒有一位是真的**,只是把畫面弄髒、還會讓「進場價 = 出場價」看起來不相等。

    ⛔ 三條不可改掉:
      ① 只動 OHLC(`volume` / 法人 / 融資是整數,⛔ 不碰)
      ② **冪等** —— `seed_db_from_json` 每輪把 JSON 讀回 SQLite,不冪等就會越跑越歪
         (round 到 2 位本來就冪等:round(round(x,2),2) == round(x,2))
      ③ 排在 `_backadjust_splits` **之後** —— 它自己也 round(…, 2),
         這裡是收尾,順便蓋掉沒被調整過的那些列
    ⚠️ ⛔ 不可改成「對到跳動單位」:除權息/減資回溯調整完的**歷史**價位本來就不會落在跳動單位上
       (那是換算出來的尺標,不是當天掛得出去的價),硬對會竄改歷史。
    """
    for r in records:
        for f in ('open', 'high', 'low', 'close'):
            v = r.get(f)
            if isinstance(v, float):
                r[f] = round(v, 2)
    return records


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

    # 🎑 V77.9.2 假日幽靈 K:加權那天沒開盤、個股卻有一根而且過半收盤跟前一天一樣 → 整天刪掉。
    #    實測 origin/data:06-19(端午)、07-10(颱風)、09-25(中秋)、09-28(教師節)都有(MIS 假日回舊成交)。
    _ghost = set()
    _cal, _clo, _chi, _cwhy = _twii_calendar()
    if _cal is None:
        print(f"  🎑 假日幽靈 K 清理跳過:{_cwhy}")
    else:
        try:
            _stats = {}
            for d, n, same in conn.execute("""
                SELECT trade_date, COUNT(*), SUM(CASE WHEN close = prev THEN 1 ELSE 0 END)
                FROM (SELECT trade_date, close,
                             LAG(close) OVER (PARTITION BY symbol ORDER BY trade_date) AS prev
                      FROM stock_history)
                GROUP BY trade_date"""):
                _stats[str(d).replace('-', '/')] = (n, same or 0)
            _ghost = _holiday_ghost_dates(_stats, _cal, _clo, _chi)
            if _ghost:
                print(f"  🎑 假日幽靈 K:{sorted(_ghost)} 加權沒有開盤 → 匯出時整天刪掉")
        except Exception as e:
            print(f"  ⚠️ 假日幽靈 K 判斷失敗(不影響匯出,這輪不刪): {e}")
            _ghost = set()
    _ghost_rows = 0

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

        # 🧹 V74.2.3 濾掉「沒有收盤價」的壞列(⛔ 一根沒有收盤價的 K 線本來就不該存在)。
        #    來源:盤中快照寫下 open/high/low/volume 但 close 還沒有;官方收盤沒回來覆蓋就留成空殼。
        #    ⚠️ V74.2.2 的 yfinance 校正只看**最近 10 個交易日**,補不到歷史中間殘留的那幾根 →
        #       而下游只要遇到一根 `float(None)` 就整檔算不出東西(screener_miner 就是這樣把
        #       6690/3131/6187 三檔略過的)。這裡在寫檔前一次濾乾淨,所有下游都受益。
        #    ⛔ 只濾「沒有收盤價」的,其餘欄位缺值不動(法人/融資本來就常態是 0)。
        _n0 = len(records)
        records = [r for r in records if isinstance(r.get('close'), (int, float)) and r['close'] > 0]
        if len(records) != _n0:
            print(f"  🧹 {sym} 濾掉 {_n0 - len(records)} 根沒有收盤價的空殼 K(盤中快照殘留)")
        if not records:
            continue        # 🚧 全部都是壞列 → ⛔ 不可寫出空檔覆蓋掉原本的好資料

        if _ghost:
            _n1 = len(records)
            records = [r for r in records if r['date'] not in _ghost]
            _ghost_rows += _n1 - len(records)
            if not records:
                continue

        # 🧹 V74.9.5 再濾兩種「物理上不可能是交易日」的壞棒(掛牌前殘留 / 幽靈棒)。
        #    ⛔ 要排在分割還原**之前** —— 幽靈棒會干擾「相鄰交易日比值」的判斷。
        try:
            records, _bad_notes = _drop_bad_bars(records, sym)
            for _nt in _bad_notes:
                print(f"  🧹 {sym} {_nt}")
        except Exception as e:
            print(f"  ⚠️ {sym} 壞棒濾除失敗(不影響匯出): {e}")
        if not records:
            continue

        # 🧱 V77.7.0 陷阱 #46:還原價列換回官方成交價(klines_deep = FinMind 原始價)。⛔ 要排在分割還原**之前**
        #    (兩邊都要過同一支 _backadjust_splits 才是同一把尺)。沒設 KLINES_DEEP_DIR 就整段跳過。
        if _deep_dir():
            try:
                records, _nfx, _why = _repair_from_deep(records, sym)
                if _nfx:
                    _DEEP_FIX['rows'] += _nfx; _DEEP_FIX['syms'] += 1
                    print(f"  🧱 {sym} {_nfx} 列還原價 → 換回官方成交價(klines_deep)")
                if _why == 'no-deep':
                    _DEEP_FIX['nodeep'] += 1
                elif _why:
                    _DEEP_FIX['split_skip'].append(sym)
                    print(f"  🧱 {sym} {_why}")
            except Exception as e:
                print(f"  ⚠️ {sym} 還原價修復失敗(不影響匯出): {e}")

        # 🔧 V71.7.9 分割/減資回溯調整(見 _backadjust_splits 的說明)。
        #    放在寫檔前的最後一步 → 全市場 2,700 檔都會過這關,而且最新那筆價格不會被動到。
        try:
            records = _backadjust_splits(records, sym, verbose=True)
        except Exception as e:
            print(f"  ⚠️ {sym} 分割調整失敗(不影響匯出): {e}")

        # 📏 V77.2.6 價格小數收尾(float32 殘留)—— ⛔ 放在最後一步,全市場都會過
        try:
            records = _round_prices(records)
        except Exception as e:
            print(f"  ⚠️ {sym} 價格小數正規化失敗(不影響匯出): {e}")

        p = Path(DATA_DIR) / f'{sym}.json'
        p.write_text(
            json.dumps(records, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8')
        exported += 1

    conn.close()
    if _ghost:
        print(f"  🎑 假日幽靈 K 共刪 {_ghost_rows} 根")
    print(f"  ✅ JSON 匯出完成：{exported} 檔（供 gh-pages 靜態部署）")
    # 🧱 V77.7.0 陷阱 #46 摘要(⛔ 沒設就要說出來,陷阱 #22)
    if _deep_dir():
        print(f"  🧱 還原價修復:{_DEEP_FIX['syms']} 檔 {_DEEP_FIX['rows']} 列換回官方價 ・"
              f"深歷史沒有 {_DEEP_FIX['nodeep']} 檔 ・有列卡在分割邊界沒換 {len(_DEEP_FIX['split_skip'])} 檔"
              + (f"({','.join(_DEEP_FIX['split_skip'][:10])})" if _DEEP_FIX['split_skip'] else ''))
    else:
        print("  🧱 還原價修復:⏭️ 沒有 KLINES_DEEP_DIR → 這一輪沒修(陷阱 #46)")
    if _YF_OFFGRID['rows']:
        print(f"  📏 yfinance 跳動單位守門:擋掉 {_YF_OFFGRID['rows']} 列 / {len(_YF_OFFGRID['syms'])} 檔(還原價 ⛔ 不寫)")


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
        # V14.9 斧四:從「連續切片」改「round-robin 交錯分配」,讓 20 batch 負載均勻
        # 連續切片問題:
        #   batch 0:0050, 0051, ... 早期 ETF/老股(歷史長、量大、API 多 → 慢)
        #   batch 19:9xxx 系列(新上市股、邊緣股,有的快有的慢)
        #   → 觀察 V14.8 run:同 run 內 batch 跑 25-73 分,差 2.9 倍,整體被最慢的拖垮
        # Round-robin 分配:
        #   batch 0:sorted_syms[0], sorted_syms[20], sorted_syms[40], ...
        #   batch 1:sorted_syms[1], sorted_syms[21], sorted_syms[41], ...
        #   每個 batch 都拿到「字典序均勻分散」的股票 → ETF/中型/大型/小型混合
        #   → 各 batch 採礦時間趨近,整體被最慢拖垮的程度大幅降低
        # 行為不變:union = 全市場(無重疊、無遺漏);batch 0 仍是 sorted_syms[0]
        base = [sorted_syms[i] for i in range(batch_idx, len(sorted_syms), total)]

    # 「今日活躍但尚無 JSON」的新上市股 —— V71.2.3 起改「所有 batch 均分」
    #
    # 🐛 為什麼要改(實測 run 30407318252 的根因):
    #    舊寫法把新上市股「全部」塞給 batch 0。這些股在 data/ 沒有任何 JSON
    #    → 每一檔都是「冷啟動」:現有 0 筆 < 480,要回溯 24 個月 TWSE 月檔 + yfinance 730d,
    #    是所有情況裡最慢的一種。實測 batch 0 拿到 265 檔(基本盤 ~128 + 新上市 ~137),
    #    其他 19 個節點都是 2~5 分鐘跑完,只有 batch 0 卡 90 分鐘被 timeout 砍。
    #    連鎖後果:整個 run 被拖到 1.5 小時、artifact 被截斷、deploy 拖延。
    #
    # ✅ 修法:new_listings 也走 round-robin。所有節點都從**同一份** data 分支快照算出
    #    相同的 universe / inst_cache → sorted() 後的 new_listings 完全一致 →
    #    切片彼此不重疊、也不遺漏(跟上面 base 的分法同一個道理)。
    #    某節點的 inst_cache 還原失敗時只會少拿,不會跟別人重疊。
    if inst_cache:
        actives: set = set()
        for day_data in inst_cache.values():
            actives.update(day_data.keys())
        new_listings = sorted({s for s in actives if _valid_stock(s)} - universe)
        if new_listings:
            mine = new_listings if total <= 1 else \
                [new_listings[i] for i in range(batch_idx, len(new_listings), total)]
            if mine:
                base = list(base) + mine
                print(f"  🆕 batch {batch_idx} 分到 {len(mine)}/{len(new_listings)} 檔新上市股(冷啟動,已均分給 {total} 個節點)")

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
                # ⭐ V75.1.4:只有最新交易日才准用 TWSE OpenAPI(那個端點沒有日期參數)
                marg = fetch_market_margin(d, is_latest=(d == trading_days[-1]))
                if marg:
                    margin_cache[dd] = marg
                    print(f"  融券 {dd}: {len(marg)} 筆")
                # 💳 V75.1.3 來源計數寫進快取(`_src` 底線鍵,下游 `sym not in by_sym` 天然跳過):
                #   ⛔ 不寫的話「上櫃全 0」永遠分不出是「沒融資」還是「TPEx 被擋」
                try:
                    margin_cache.setdefault('_src', {})[dd] = dict(getattr(fetch_market_margin, 'last_src', {}) or {})
                except Exception:
                    pass
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
                # 🚨 偵測「全 free 源失效」:所有日期、所有 sid 的 short_balance 都是 0 → 寫 metadata 旗標
                #    用底線開頭 key 供前端跳過,不污染既有 dict[date_str → {sid → data}] 迭代
                _all_short_zero = True
                for dd_data in margin_cache.values():
                    if not isinstance(dd_data, dict):
                        continue
                    for sid_data in dd_data.values():
                        if isinstance(sid_data, dict) and sid_data.get('short_balance', 0) > 0:
                            _all_short_zero = False
                            break
                    if not _all_short_zero:
                        break
                if _all_short_zero:
                    margin_cache['_status'] = 'free-sources-exhausted'
                    margin_cache['_reason'] = 'TWSE rwd/OpenAPI、TPEX、FinMind、yfinance 4 條 free 源皆無個股融券明細(2026/06 起 TWSE 改回彙總表),需付費 API'
                    print(f"  🚨 全部日期融券皆 0:寫入 _status='free-sources-exhausted' 旗標供前端顯示『需付費解鎖』")
                MARGIN_CACHE_FILE.write_text(json.dumps(margin_cache, ensure_ascii=False), encoding='utf-8')
                print(f"  💾 融資券快取已更新 → {MARGIN_CACHE_FILE}({len(margin_cache)} 天)")
            elif _has_real_payload(MARGIN_CACHE_FILE):
                print(f"  ⏭️ 融資券抓取失敗,保留既有 last-good 不覆寫 → {MARGIN_CACHE_FILE}")
            else:
                MARGIN_CACHE_FILE.write_text(json.dumps({'_last_attempt': datetime.now().strftime('%Y-%m-%d %H:%M'), '_status': 'free-sources-exhausted', '_reason': 'TWSE/TPEX/FinMind/yfinance 四源皆失敗,需付費 API'}, ensure_ascii=False), encoding='utf-8')
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

    # V16.4 — 寫採礦狀態(只 batch 0 寫,避免 20 個批次並行覆蓋)
    #         前端 poll 此檔 + GitHub Actions API 雙保險知道採礦中
    if BATCH_INDEX == 0:
        write_miner_status('ohlcv_batch', 'mining',
                           {'note': f'OHLCV + 法人 / 融券 批次採礦中 ({TOTAL_BATCHES} 平行宇宙)'})

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
            _t_stock = time.time()  # V14.12 timing
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
                # 🚨 V74.2.2 ⛔ 不可只看 volume —— 盤中快照會留下「有量但沒收盤價」的空殼,
                #    只看量會把它當成「今天採完了」,於是整檔跳過(上櫃股數字整批消失的真因)。
                if bar_is_complete(row):
                    latest_valid_date = fmt_date  # 記錄最新「收盤價與量都有」的交易日

            # ── 🛡️ 防封鎖機制（時間感知版）：盤後才強制覆蓋 ──
            target_today_str = trading_days[-1].strftime('%Y/%m/%d')
            today_record  = existing_map.get(target_today_str, {})
            has_final_chips = today_record.get('foreign_net', 0) != 0

            now = datetime.now(timezone(timedelta(hours=8)))   # 台灣時間（修正 GitHub Actions UTC 誤判）
            is_post_market = (now.hour > 13) or (now.hour == 13 and now.minute >= 40)

            # 缺口偵測：若最近 10 個交易日有任一天缺資料，不允許跳過（修復 5/24 後資料斷層）
            recent_10 = {d.strftime('%Y/%m/%d') for d in trading_days[-10:]}
            # 🚨 V74.2.2 「有這一天」不等於「這一天是好的」→ 收盤價空殼也要算缺口,
            #    ⛔ 否則 has_gap=False 會讓整檔走進「安全略過」分支。
            has_gap = any((d not in existing_map) or not bar_is_complete(existing_map[d])
                          for d in recent_10)

            # 資料稀疏偵測:現有 < 480 筆(約 2 年交易日)→ 補抓 24 個月,讓回測有完整 2 年歷史
            # V15.0:歷史補洞門檻 480 → 240(2 年 → 1 年),減少 yfinance 730 天強化補洞觸發率
            #        歷史 1-2 年的股票不再過度補洞,240MA 由前端 V14.17 週 K 邏輯取代不依賴
            if len(existing_map) < 240:
                fetch_months = []
                _tmp = today.replace(day=1)
                for _ in range(24):
                    fetch_months.append(_tmp.strftime('%Y%m'))
                    _tmp = (_tmp - timedelta(days=1)).replace(day=1)
                print(f"  📉 歷史不足 2 年(現有 {len(existing_map)} 筆 < 480),延長至 24 個月回溯")
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
                        print(f"  ⚠️ {sym} {ym}：TWSE/TPEX 雙源無資料，將靠後段 yfinance 補洞（若 Yahoo 也缺，當日 K 線將漏記）")
                    if i == 1 and first_ym_empty and rows:
                        print(f"  📅 {sym} {fetch_months[0]} 無資料，改用 {fetch_months[1]}（{len(rows)} 筆）")

                    new_rows.extend(rows)
                    time.sleep(0.15)
                    
                # ── 🛡️ yfinance OHLCV 補洞:TWSE/TPEX 失敗時用 Yahoo Finance 補檔 ──
                got_dates = {r['date'] for r in new_rows} | set(existing_map.keys())

                # 🎯 兩段式補洞策略:
                # (a) 歷史不足 2 年(< 480 筆)→ yfinance 抓 730 天 + 全範圍補洞
                # (b) 歷史已足夠 → yfinance 只看最近 10 天補當日資料
                is_history_short = len(existing_map) < 240   # V15.0 同步調整

                if is_history_short:
                    # 模式 A:歷史不足 → 用 yfinance 抓 2 年,全部沒有的日期都補
                    yf_rows = yfinance_ohlcv_fallback(sym, market_type, days_back=730)
                    if yf_rows:
                        before_len = len(new_rows)
                        existing_dates = {r['date'] for r in new_rows}
                        for r in yf_rows:
                            if r['date'] in got_dates: continue
                            if r['date'] in existing_dates: continue
                            new_rows.append(r)
                            existing_dates.add(r['date'])
                            got_dates.add(r['date'])
                        added = len(new_rows) - before_len
                        if added > 0:
                            new_rows.sort(key=lambda x: x['date'])
                            print(f"  📈 {sym} yfinance 強化補洞 {added} 筆(歷史不足 2 年,抓 730 天範圍 / 共 {len(yf_rows)} 天可用)")
                else:
                    # 模式 B:歷史已足 → 補最近 10 天「缺漏」+ 校正「殘留盤中快照」
                    recent_10 = [d.strftime('%Y/%m/%d') for d in trading_days[-10:]]
                    missing_recent = [ds for ds in recent_10 if ds not in got_dates]
                    # 🆕 V54.x — 上櫃股 TPEX 舊端點(www.tpex.org.tw/web/...st43/3itrade)已失效 → 最近交易日常殘留
                    #    MIS 盤中快照(收盤/量非最終),官方這次沒回來校正,舊邏輯「只補缺漏」永遠不覆蓋它(如 5483 07/03=196.5)。
                    #    修:用 yfinance(auto_adjust=False=原始價=官方收盤)校正「最近 10 日、官方這次沒重抓到、且收盤與現存
                    #    差 ≥1.5%」的日子 → 判定為殘留快照,加進 new_rows 讓下方覆蓋邏輯改為最終值。TWSE 股官方有回→不受影響。
                    official_dates = {r['date'] for r in new_rows}   # 這次 TWSE/TPEX 真的有回的日子
                    stale_recent = [ds for ds in recent_10 if ds in existing_map and ds not in official_dates]
                    # 🚨 V74.2.1 官方這次「有回」但收盤價仍是空的(TPEX 回了空殼)→ 也要進校正名單,
                    #    ⛔ 否則 official_dates 會把它排除掉,永遠修不到。
                    _bad = [ds for ds in recent_10
                            if ds in existing_map and not (existing_map[ds].get('close') or 0) > 0]
                    stale_recent = sorted(set(stale_recent) | set(_bad))
                    if missing_recent or stale_recent:
                        yf_rows = yfinance_ohlcv_fallback(sym, market_type, days_back=30)
                        if yf_rows:
                            before_len = len(new_rows)
                            yf_by_date = {r['date']: r for r in yf_rows}
                            existing_dates = {r['date'] for r in new_rows}
                            # (a) 補完全缺漏的日子
                            for ds in missing_recent:
                                yr = yf_by_date.get(ds)
                                if yr and ds not in existing_dates:
                                    new_rows.append(yr); existing_dates.add(ds)
                            # (b) 校正殘留盤中快照(收盤差 ≥1.5%)。🚨 V77.7.0 更正:auto_adjust=False **仍可能是還原價**(陷阱 #46)→ 已在 fallback 裡用跳動單位擋掉
                            n_fix = 0
                            for ds in stale_recent:
                                yr = yf_by_date.get(ds)
                                if not yr or ds in existing_dates:
                                    continue
                                old_c = existing_map[ds].get('close')
                                # 🚨 V74.2.1 走共用純函式:⛔ 舊寫法 `or 0` + `old_c > 0` 會把
                                #    「close 根本是 None」(盤中快照空殼)整個跳過 —— 那才是最該修的情況。
                                if needs_price_fix(old_c, yr['close']):
                                    new_rows.append(yr); existing_dates.add(ds); n_fix += 1
                                    print(f"  🔧 {sym} {ds} {'無收盤價' if not old_c else '疑殘留盤中快照'}"
                                          f"(收 {old_c}→yfinance {yr['close']}),yfinance 校正覆蓋")
                            added = len(new_rows) - before_len
                            if added > 0:
                                new_rows.sort(key=lambda x: x['date'])
                                print(f"  📈 {sym} yfinance 補洞/校正 {added} 筆 (缺 {len(missing_recent)} + 殘留快照校正 {n_fix})")

                # ── 🛡️ 【時間護盾與 MIS 即時快照補丁】 ──
                tw_now = datetime.now(timezone(timedelta(hours=8)))
                current_time = tw_now.time()
                is_pre_market = (current_time.hour == 8) or (current_time.hour == 9 and current_time.minute == 0)
                is_weekend = tw_now.weekday() >= 5  # 5=六,6=日 — 台股不開盤,跨午夜跑時別把日期寫成週日

                if not is_pre_market and not is_weekend:
                    today_slashed = tw_now.strftime('%Y/%m/%d')
                    if not new_rows or new_rows[-1]['date'] != today_slashed:
                        snap = fetch_mis_closing_snapshot(sym)
                        if snap:
                            new_rows.append(snap)
                # ────────────────────────────────────

            _log_t(sym, 'fetch', _t_stock)  # V14.12 — TWSE/TPEX/yfinance/snapshot 全段
            _t_db = time.time()
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
            _log_t(sym, 'db', _t_db)         # V14.12 — DB write + chips merge
            _log_t(sym, 'total', _t_stock)   # V14.12 — 整檔 OHLCV 處理總耗時

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
            # 🐛 修:name 為英文列舉(Foreign_Investor…)中英雙比對;
            #   且此 dataset 無 open_interest_net_volume 欄 → 改用多空未平倉餘額相減算淨口數。
            foreign_data = [d for d in j['data'] if '外資' in d.get('name', '') or 'Foreign' in d.get('name', '')]
            if foreign_data:
                latest = foreign_data[-1]
                long_bal  = int(latest.get('long_open_interest_balance_volume') or 0)
                short_bal = int(latest.get('short_open_interest_balance_volume') or 0)
                net_oi = long_bal - short_bal
                long_oi = max(0, net_oi)
                short_oi = max(0, -net_oi)
                if long_oi > 0 or short_oi > 0:
                    _write_futures_cache(net_oi, long_oi, short_oi, latest.get('date'))
    except Exception as e:
        print(f"  ⚠️ FinMind 外資期貨連線失敗: {e}")


# ── 🏛️ TWSE/TPEX 官方台股指數(主要來源,優先於 yfinance)──────────────────
def _roc_to_iso(s):
    """民國日期 '114/07/29' / '1140729' → '2026/07/29';解不出回 None。
    抽成純函式讓沙箱測得到(TWSE 在沙箱被 proxy 擋,只能測解析)。"""
    import re as _re
    m = _re.match(r'^\s*(\d{2,3})[/\-]?(\d{1,2})[/\-]?(\d{1,2})\s*$', str(s or ''))
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{y + 1911:04d}/{mo:02d}/{d:02d}"


def _parse_fmtqik(j):
    """TWSE FMTQIK(每日市場成交資訊)月份檔 → {ISO日期: (成交股數, 成交金額_元)}。

    欄位實測:['日期','成交股數','成交金額','成交筆數','發行量加權股價指數','漲跌點數']
    但欄序在官方改版時動過,所以一律用**欄名**定位,不寫死 index。
    """
    out = {}
    fields = [str(f or '').replace(' ', '') for f in ((j or {}).get('fields') or [])]

    def _fi(*kws):
        for i, f in enumerate(fields):
            if any(k in f for k in kws):
                return i
        return None

    i_d, i_v, i_a = _fi('日期'), _fi('成交股數'), _fi('成交金額')
    if i_d is None or (i_v is None and i_a is None):
        return out
    for row in ((j or {}).get('data') or []):
        try:
            iso = _roc_to_iso(row[i_d])
            if not iso:
                continue

            def _num(i):
                if i is None:
                    return None
                v = str(row[i]).replace(',', '').strip()
                return float(v) if v not in ('', '--', '-') else None
            vol, amt = _num(i_v), _num(i_a)
            if vol is None and amt is None:
                continue
            out[iso] = (vol, amt)
        except (IndexError, TypeError, ValueError):
            continue
    return out


def _months_span(rows, cap=30):
    """rows 的日期範圍涵蓋哪些 (年, 月) —— 由舊到新,最多 cap 個月(從最新往回算)。
    純函式,給 FMTQIK 決定要抓幾個月份檔用。"""
    ms = []
    seen = set()
    for r in (rows or []):
        d = str(r.get('date') or '')
        if len(d) < 7:
            continue
        try:
            y, m = int(d[0:4]), int(d[5:7])
        except ValueError:
            continue
        if 1 <= m <= 12 and (y, m) not in seen:
            seen.add((y, m))
            ms.append((y, m))
    ms.sort()
    return ms[-cap:] if cap else ms


def _merge_twii_volume(rows, vol_map):
    """把 FMTQIK 的官方成交股數/金額併進 MI_5MINS_HIST 的 OHLC 列。

    ⛔ **絕對不要寫進 `volume` 欄**(V71.6.2 差點踩下去,實測擋下來的):
       `^TWII.json` 裡既有的 423 列 volume 來自 yfinance,中位數 **3,734,300**;
       FMTQIK 的「成交股數」是 **~54 億** —— 兩者差約 1,500 倍,根本不是同一個東西
       (yfinance 對指數的 volume 一向可疑)。混進同一欄會產生 1000 倍斷崖:
       均量 / OBV / 量價背離 全部算出垃圾,而且前端會畫出一根天柱 —— **比現在的 0 更糟**。
       更危險的是前端 V71.4.9 的「幽靈棒過濾」只看**最後 60 根**的零量佔比:
       一旦近 3 個月被填滿,佔比從 ~100% 掉到 ~0% → 過濾器對整個 486 列陣列生效
       → 更舊的零量列可能被整批刪掉(就是 V71.4.9 那個「486→424 根」的老 bug 復活)。

    所以官方值一律寫**獨立欄位**,`volume` 原封不動:
      ・`mkt_vol`  集中市場成交股數(股)
      ・`amount`   集中市場成交金額(元)—— 電視上講的「今天量能站回一兆」就是這個
    回 (rows, 補到幾列),讓呼叫端印覆蓋率 —— 「補了 0 列」跟「來源掛了」必須看得出差別
    (market_stats.json 躲過診斷那麼久就是因為訊息分不出這兩件事)。
    """
    hit = 0
    for r in (rows or []):
        pair = (vol_map or {}).get(r.get('date'))
        if not pair:
            continue
        vol, amt = pair
        if vol is not None:
            r['mkt_vol'] = int(vol)
        if amt is not None:
            r['amount'] = int(amt)
        if vol is not None or amt is not None:
            hit += 1
    return rows, hit


FMTQIK_TRIES = 3


def _fetch_fmtqik_months(months, _get=None):
    """抓 FMTQIK 月份檔並合併成 {ISO日期: (股數, 金額)}。連不到就回空 dict(呼叫端就是沒有那兩個欄位)。

    ⚠️ 為什麼要重試(V71.6.4,看 log 才知道的):首次上線實測 25 個月份檔中,
       **2024/07、2026/06、2026/07 三個月回 HTTP 307**,其餘 22 個月正常 →
       442/486 列拿到值,而且缺的正好是「最近兩個月」這段最該有的。
       307 是這專案已知的老問題(見 _fetch_bfi82u_rows 的說明:
       「原本只打 www.twse.com.tw 的 rwd 端點,GHA runner 常被回 HTTP 307(WAF/轉址)」),
       **是間歇性的、不是這幾個月份沒資料** —— 同一支 URL 對其他 22 個月都通。
       所以照這支檔案既有的反 WAF 做法處理:`_rnd_hdrs()` 隨機 UA + 重試 3 次遞增退避。

    ⚠️ 節流:一次可能要抓 ~30 個月份檔,TWSE 對連續快速請求會擋
       (同 fetch_twse_fundamentals 已經在 sleep 的理由),每檔之間停一下。

    `_get` 只給測試注入用(沙箱連不到 twse),正式路徑一律用 requests。
    """
    getter = _get or (lambda url: requests.get(
        url, headers={**HEADERS, **_rnd_hdrs()}, timeout=10, allow_redirects=True))
    vol_map = {}
    for _i, (y, m) in enumerate(months):
        if _i:
            time.sleep(random.uniform(0.25, 0.45))
        url = f"https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json&date={y:04d}{m:02d}01"
        for _try in range(1, FMTQIK_TRIES + 1):
            try:
                r = getter(url)
                if r.status_code != 200:
                    print(f"  [TWSE FMTQIK] {y}/{m:02d} HTTP {r.status_code}"
                          f"(第 {_try}/{FMTQIK_TRIES} 次)")
                    if _try < FMTQIK_TRIES:
                        time.sleep(_try * 1.5)     # 307/403 多半是間歇 WAF,退避後換 UA 再試
                        continue
                    break
                j = r.json()
                if j.get('stat') and j.get('stat') != 'OK':
                    print(f"  [TWSE FMTQIK] {y}/{m:02d} stat={str(j.get('stat'))[:60]}")
                    break                          # 官方明講沒資料 → 重試也沒用
                got = _parse_fmtqik(j)
                if not got:
                    print(f"  [TWSE FMTQIK] {y}/{m:02d} 解析 0 列,fields={j.get('fields')}")
                vol_map.update(got)
                break
            except Exception as e:
                print(f"  [TWSE FMTQIK] {y}/{m:02d} 抓取失敗(第 {_try}/{FMTQIK_TRIES} 次): {str(e)[:60]}")
                if _try < FMTQIK_TRIES:
                    time.sleep(_try * 1.5)
    return vol_map


def _fetch_twii_history_official(months_back=2):
    """TWSE 加權指數 OHLC 官方歷史 — MI_5MINS_HIST 月份檔。
    回傳 list of OHLC dict(date='YYYY/MM/DD');網路失敗/空白回 None,讓 yfinance fallback。
    端點對 GHA runner(美國 IP)穩定,連不上時靜默退回。"""
    import re as _re
    rows_out = []
    today = date.today()
    months_to_fetch = []
    cur_y, cur_m = today.year, today.month
    for _ in range(months_back + 1):
        months_to_fetch.append((cur_y, cur_m))
        cur_m -= 1
        if cur_m == 0:
            cur_m = 12
            cur_y -= 1
    months_to_fetch.reverse()
    for y, m in months_to_fetch:
        url = f"https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date={y:04d}{m:02d}01"
        try:
            r = requests.get(url, headers=HEADERS, timeout=10)
            if r.status_code != 200:
                print(f"  [TWSE TAIEX] {y}/{m:02d} HTTP {r.status_code}")
                continue
            j = r.json()
            if j.get('stat') and j.get('stat') != 'OK':
                print(f"  [TWSE TAIEX] {y}/{m:02d} stat={str(j.get('stat'))[:60]}")
                continue
            data = j.get('data') or []
            if not data:
                print(f"  [TWSE TAIEX] {y}/{m:02d} 回 200 但 data 空")
            for row in data:
                try:
                    mtch = _re.match(r'(\d{2,3})/(\d{1,2})/(\d{1,2})', str(row[0]))
                    if not mtch:
                        continue
                    iso = f"{int(mtch.group(1))+1911:04d}/{int(mtch.group(2)):02d}/{int(mtch.group(3)):02d}"
                    def _flt(s):
                        return float(str(s).replace(',', ''))
                    o, h, l, c = _flt(row[1]), _flt(row[2]), _flt(row[3]), _flt(row[4])
                    # ⚠️ volume 只能給 0:MI_5MINS_HIST 這個端點只有 OHLC,沒有成交量。
                    #   這不是 bug,是資料源限制 —— 但下游務必知道:
                    #   ① 前端 applyLatestPrice 的「幽靈棒過濾」不能用量門檻砍指數 K 棒,
                    #      否則會把整段近期資料當假日棒刪掉(V71.4.9 實測 ^TWII 486→424 根,
                    #      個股頁停在 3 個月前、現價跟大盤頁對不上)。前端已加「零量佔比 ≥20% 就不濾」守門。
                    #   ② 指數頁的量能類判讀(量價背離/OBV/均量)拿不到真量。
                    #      ✅ V71.6.2 已補官方量能,但寫在**獨立欄位** mkt_vol / amount,
                    #         `volume` 這欄刻意保持 0 —— 因為既有列的 volume 來自 yfinance,
                    #         跟官方成交股數差約 1,500 倍,混同一欄會做出 1000 倍斷崖,
                    #         也會讓前端「零量佔比 ≥20% 就不濾」那道守門失效(詳見
                    #         _merge_twii_volume 的說明)。
                    rows_out.append({'date': iso, 'open': round(o, 2), 'high': round(h, 2),
                                     'low': round(l, 2), 'close': round(c, 2), 'volume': 0})
                except Exception:
                    continue
        except Exception as e:
            print(f"  [TWSE TAIEX] {y}/{m:02d} 抓取失敗: {str(e)[:60]}")
            continue
    # 去重(月份重疊)+ 排序
    seen, uniq = set(), []
    for r in rows_out:
        if r['date'] not in seen:
            seen.add(r['date'])
            uniq.append(r)
    uniq.sort(key=lambda x: x['date'])
    # 📌 官方量能(FMTQIK)**不在這裡併** —— 這支只回最近 3 個月,在這裡併只會蓋到那 63 列。
    #    要涵蓋 ^TWII.json 完整 486 列,必須在 _merge_official_over_yf 之後再併(見下方呼叫處)。
    return uniq if uniq else None


def _hist_stale_error(key, official_rows, long_rows):
    """長歷史指數(twii / twoii)在「官方來源全空」時,要回一句寫得出原因的錯誤字串;沒事回 None。

    🚨 V77.4.5 陷阱 #22 —— 實測 `macro_cache.json` 的 `twoii_history` **只有 1 筆、日期 2024/10/12**
       (兩年前),而檔案裡**一個字都沒說**:`twoii` 這個 flat key 根本不存在、也沒有 `twoii_error`
       → 前端只顯「採集中」、資料體檢 C 類完全掃不到,靠人去翻 Actions log 才看得到真相。
       實測那一輪的 log 是**三個來源各壞一種**:
         ・FinMind TPEx →「回空」(V73.6.1 說的 ✅ 已經不成立)
         ・TPEx 官網 → **200 但 totalCount=0**(⛔ 不再是 403;V73.6.1 那個結論也過期了)
         ・yfinance ^TWOII →「空」
       → 然後磁碟 fallback 把那 1 筆舊的寫回去,**下一輪再讀回來**,自我延續。
    ⛔ 措辭刻意避開「沿用 / 備援 / fallback / 已保留」那幾個詞 —— `data_audit` 的 C 類把它們
       當成「有交代的降級」而不報 ❌,而**指數收盤是當日快照**,用兩年前的值是錯的(陷阱 #34)。
    ⭐ 一定要把**判斷用的原始數字**(幾筆、最新哪一天)一起寫進去,否則永遠分不出
       「今天剛好沒抓到」跟「這條線早就斷了」。
    """
    n = len(long_rows or [])
    if official_rows and n >= 2:
        return None
    last = '?'
    try:
        last = str((long_rows or [])[-1].get('date') or '?')
    except Exception:
        pass
    #   ⭐ 兩種原因要分開講 —— 下一步完全不同(一個是去查來源、一個是歷史檔本身壞了),
    #   ⛔ 不可像 V76.4.2 那次把「連不上」跟「名字猜錯」混成同一句(都寫「抓不到」)。
    if not official_rows:
        why = (f'{key} 官方來源這一輪 0 筆'
               f'(FinMind / 官網 / yfinance 三條都沒給新資料)')
    else:
        why = f'{key} 官方來源有給值,但長歷史只剩 {n} 筆(歷史檔可能被截斷)'
    return (f'{why} → 目前畫面上用的是磁碟舊檔 {n} 筆、最新 {last};'
            f'⛔ 別把這個日期當成收盤日,⛔ 也別當成「今天剛好沒抓到」')


def _fetch_otc_history_finmind(days_back=400):
    """🏪 V73.6.1 櫃買指數歷史 —— **FinMind `TaiwanStockPrice` + data_id='TPEx'**。

    ⭐ 為什麼新增這條:`data/^TWOII.json` **從上線到現在一次都沒產出過**,
       前面五輪(V71.2.5~V71.6.8)都在猜「TPEX 的日期格式 / 資料鍵值」——
       `scripts/otc_probe.py` 一次試完 22 個候選,答案完全不是那個方向:

         ・TPEx **整站對 GitHub runner 回 403**(連本專案一直在用、從沒出過事的
           `/openapi/v1/t187ap03_O` 也 403)→ ⛔ 不是端點改版、不是日期格式,是 **IP 被擋**。
         ・FinMind `TaiwanStockPrice` + `data_id='TPEx'` → ✅ 完整 OHLCV + 成交量/成交金額。
         ・⚠️ `data_id='OTC'` **回空**(HTTP 200、msg=success)—— 坊間文章常寫 'OTC',
           那是**錯的**;正確代碼是 `TPEx`(⛔ 別改回去)。
         ・yfinance `^TWO` 抓到的是**美國 CBOE 選擇權**(currency USD),不是台灣櫃買 →
           舊註解說「^TWO 幾乎永遠回空」其實是抓錯東西;正確是 `^TWOII`。

    ⛔ 安全:走既有的 `fm_request()`(它會做 token 輪動 + 429 斷路器),⛔ 不另外處理金鑰。
    """
    try:
        start = (datetime.utcnow() - timedelta(days=days_back)).strftime('%Y-%m-%d')
    except Exception:
        return []
    url = ('https://api.finmindtrade.com/api/v4/data'
           f'?dataset=TaiwanStockPrice&data_id=TPEx&start_date={start}')
    j = fm_request(url, timeout=25) or {}
    rows = (j.get('data') or []) if isinstance(j, dict) else []
    out = []
    for r in rows:
        try:
            d = str(r.get('date') or '')[:10]
            o, h, l, c = r.get('open'), r.get('max'), r.get('min'), r.get('close')
            if not d or c in (None, ''):
                continue
            c = float(c)
            if c <= 0:
                continue
            out.append({
                'date':   d,
                'open':   round(float(o), 2) if o not in (None, '') else c,
                'high':   round(float(h), 2) if h not in (None, '') else c,
                'low':    round(float(l), 2) if l not in (None, '') else c,
                'close':  round(c, 2),
                # ⚠️ 指數的 volume 給 0,金額另存(同 ^TWII 的 `amount`,陷阱 #17:
                #    不同來源/不同單位就不可共用欄位名)
                'volume': 0,
                'amount': int(float(r.get('Trading_money') or 0)) or None,
            })
        except Exception:
            continue
    out.sort(key=lambda x: x['date'])
    if out:
        print(f"  🏪 櫃買指數(FinMind TPEx):{len(out)} 筆(最新 {out[-1]['date']} 收 {out[-1]['close']})")
    else:
        print("  🚨 櫃買指數(FinMind TPEx)回空 → 退回 yfinance ^TWOII / TPEX 官網")
    return out


def _fetch_otc_history_official(months_back=2):
    """TPEX 上櫃指數 OHLC 官方歷史 — st41 月份檔。
    端點:https://www.tpex.org.tw/web/stock/aftertrading/daily_index/st41_result.php
    民國年格式(d=114/06);TPEX 對美國 IP 偶爾擋,失敗回 None 讓 yfinance fallback。"""
    import re as _re
    rows_out = []
    today = date.today()
    months_to_fetch = []
    cur_y, cur_m = today.year, today.month
    for _ in range(months_back + 1):
        months_to_fetch.append((cur_y, cur_m))
        cur_m -= 1
        if cur_m == 0:
            cur_m = 12
            cur_y -= 1
    months_to_fetch.reverse()

    def _flt(s):
        return float(str(s).replace(',', '').replace('--', 'nan'))

    for y, m in months_to_fetch:
        roc = f"{y - 1911}/{m:02d}"       # 民國 115/07(舊 web 端點格式)
        ce_first = f"{y:04d}{m:02d}01"    # 西元 20260701
        # 🔍 V71.2.5 —— 靠 V71.2.3 加的診斷,終於查出櫃買指數為何從沒抓成功過(實測 log):
        #   ・/rwd/zh/...        → 回 `<!DOCTYPE html>`(不是 JSON,端點已死)
        #   ・/www/zh-tw/...     → **HTTP 200 且是 JSON**,keys=['tables','date','flagField','stat']
        #                          → 這台是活的,只是 tables 空 ⇒ 日期參數格式不對
        #   ・/web/...st41_result.php → 也回 HTML(2024 改版後死透)
        #   所以正解不是「換一台主機」,是「在這台活的端點上換對日期格式」。
        #   下面把 4 種常見寫法都試一次(西元無分隔 / 西元帶斜線 / 民國帶日 / 民國到月),
        #   哪個成功就停;全失敗時新版診斷會把 stat 原文印出來,直接看官方怎麼說。
        _www = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc/st41"
        url_candidates = [
            f"{_www}?date={ce_first}&response=json",
            f"{_www}?date={y:04d}/{m:02d}/01&response=json",
            f"{_www}?date={y - 1911}/{m:02d}/01&response=json",
            f"{_www}?date={roc}&response=json",
            f"https://www.tpex.org.tw/rwd/zh/afterTrading/otc/st41?date={ce_first}&response=json",
            f"https://www.tpex.org.tw/web/stock/aftertrading/daily_index/st41_result.php?l=zh-tw&d={roc}",
        ]
        got = False
        why = []          # 🔊 V71.2.3 每個候選端點失敗的真正原因(以前全部靜默 continue,
                          #    log 只留一句「全端點抓取失敗」,完全無從判斷是被擋、改版還是格式變了)
        for url in url_candidates:
            if got:
                break
            # 🚨 V77.4.5:原本截 42 字 → log 印出來的是 `?date=2026`(日期參數被切掉一半),
            #   於是「200 但 totalCount=0」到底是**參數格式錯**還是**真的沒資料**分不出來。
            #   ⭐ 同本站鐵則「把判斷用的原始數字一起輸出」。TPEx ⛔ 不需要金鑰 → 印完整 query 是安全的。
            tag = url.split('tpex.org.tw')[-1][:90]
            try:
                r = requests.get(url, headers=HEADERS, timeout=10)
                if r.status_code != 200:
                    why.append(f"{tag}→HTTP {r.status_code}")
                    continue
                try:
                    j = r.json()
                except Exception:
                    why.append(f"{tag}→非 JSON({(r.text or '')[:40].strip()!r})")
                    continue
                # 🔍 V71.2.5:tables 不一定只有一張、也不一定在第 0 張有 data → 逐張找第一張有 data 的
                data = j.get('aaData') or j.get('data') or []
                # 🔍 V71.3.4 實測 log 進一步縮小範圍:
                #   /www/zh-tw/... 四種日期格式**全部**回 stat='ok' 且 tables=1
                #   → 端點活著、日期也吃得下,問題出在「那張表裡裝資料的欄位不叫 data」。
                #   所以不再只認 't["data"]',改成掃過表內每個欄位,取第一個「像資料列」的陣列
                #   (元素是 list、且長度 ≥5 → 日期+開高低收)。
                # 🔍 V71.6.8 —— 上一輪 log 已經把表內欄位印出來了,關鍵線索是:
                #     表內欄位=['title','date','category','totalCount','fields','data','summary','notes']
                #   **`data` 明明就在裡面**,卻還是判成「無資料」→ 代表不是「資料放在別的 key」,
                #   而是 `data` 的**列不是 list**(TPEX 新版 API 很可能回 dict 列),
                #   被 `isinstance(_v[0], (list, tuple))` 這個條件擋掉了。
                #   所以:① 也接受 dict 列(轉成 [日期,開,高,低,收] 再走同一套解析)
                #         ② 診斷改印 totalCount + 第一列的**長相**(型別/鍵名/長度)
                #            —— 舊訊息只印欄位名,分不出「那個月真的沒資料(totalCount=0)」
                #            跟「有資料但格式不同」,這正是它卡了好幾版沒解掉的原因。
                _tbl_keys, _diag = [], ''
                if not data and isinstance(j.get('tables'), list):
                    for _t in j['tables']:
                        if not isinstance(_t, dict):
                            continue
                        _tbl_keys = list(_t.keys())
                        _tc = _t.get('totalCount')
                        _raw = _t.get('data')
                        if isinstance(_raw, list) and _raw:
                            _first = _raw[0]
                            _diag = (f"totalCount={_tc}, data 共 {len(_raw)} 列, "
                                     f"首列型別={type(_first).__name__}, "
                                     f"首列={(list(_first.keys())[:8] if isinstance(_first, dict) else _first)!r}"[:220])
                        else:
                            _diag = f"totalCount={_tc}, data={type(_raw).__name__}(空)"
                        for _k, _v in _t.items():
                            if _k in ('fields', 'notes', 'hints'):      # 這些是欄位名/說明,不是資料
                                continue
                            if not (isinstance(_v, list) and _v):
                                continue
                            _f = _v[0]
                            if isinstance(_f, (list, tuple)) and len(_f) >= 5:
                                data = _v
                                break
                            # dict 列 → 照 fields 的順序攤平成 list,再走同一套解析
                            if isinstance(_f, dict) and len(_f) >= 5:
                                _fields = _t.get('fields') or list(_f.keys())
                                data = [[r.get(fd) for fd in _fields] if isinstance(r, dict) else r
                                        for r in _v]
                                print(f"  [TPEX OTC] {tag} data 是 dict 列 → 依 fields 攤平({len(data)} 列)")
                                break
                        if data:
                            break
                if not data:
                    why.append(f"{tag}→200 但無資料(stat={str(j.get('stat'))[:30]!r}, "
                               f"tables={len(j.get('tables') or [])}, 表內欄位={_tbl_keys[:8]}"
                               + (f", {_diag}" if _diag else '') + ")")
                    continue
                added = 0
                for row in data:
                    try:
                        mtch = _re.match(r'(\d{2,3})/(\d{1,2})/(\d{1,2})', str(row[0]))
                        if not mtch:
                            continue
                        iso = f"{int(mtch.group(1))+1911:04d}/{int(mtch.group(2)):02d}/{int(mtch.group(3)):02d}"
                        o, h, l, c = _flt(row[1]), _flt(row[2]), _flt(row[3]), _flt(row[4])
                        if not (c == c and c > 0):   # 跳過 NaN/0 收盤
                            continue
                        rows_out.append({'date': iso, 'open': round(o, 2), 'high': round(h, 2),
                                         'low': round(l, 2), 'close': round(c, 2), 'volume': 0})
                        added += 1
                    except Exception:
                        continue
                if added:
                    got = True
                else:
                    why.append(f"{tag}→有 data 但沒解出任何一列(欄位格式可能改了)")
            except Exception as _e:
                why.append(f"{tag}→{type(_e).__name__}: {str(_e)[:40]}")
                continue
        if not got:
            print(f"  [TPEX OTC] {y}/{m:02d} 全端點抓取失敗 ・ {' | '.join(why)}")
    seen, uniq = set(), []
    for r in rows_out:
        if r['date'] not in seen:
            seen.add(r['date'])
            uniq.append(r)
    uniq.sort(key=lambda x: x['date'])
    return uniq if uniq else None


def _merge_official_over_yf(yf_rows, official_rows):
    """官方近期資料優先覆蓋 yfinance 長歷史的重疊日期,長歷史部分維持 yfinance 補足 240MA。
    yf_rows: list[dict] (date='YYYY/MM/DD');official_rows 同格式。
    回傳合併後 sorted list。"""
    if not official_rows:
        return yf_rows
    if not yf_rows:
        return official_rows
    by_date = {r['date']: r for r in yf_rows}
    for r in official_rows:
        by_date[r['date']] = r   # 官方覆蓋 yfinance
    return sorted(by_date.values(), key=lambda x: x['date'])


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
               'asx': 'ASX', 'umc': 'UMC',   # 🌅 V36.8 日月光 ADR / 聯電 ADR(盤前大盤體檢用)
               'sox': '^SOX', 'nvda': 'NVDA', 'aapl': 'AAPL', 'msft': 'MSFT',
               'us02y': '^IRX',     # 13W T-Bill 短債利率（Fed 政策風向）
               'ukoil': 'BZ=F',     # 布蘭特原油期貨
               'dxy':   'DX-Y.NYB', # 美元指數
               'twii':  '^TWII',    # 台股加權指數（供泡沫預警 K 線型態判讀 + 個股查詢頁）
               # 🐛 V73.6.1 `^TWO` 是**錯的 ticker** —— 實測(scripts/otc_probe.py)yfinance 回的是
               #    `exchangeName: CBO / currency: USD` = **美國 CBOE 的選擇權**,根本不是台灣櫃買。
               #    這就是舊註解說「^TWO yfinance 幾乎永遠回空」的真相:不是回空,是抓錯東西被過濾掉。
               #    正確 ticker 是 `^TWOII`(實測 66 根)。
               'twoii': '^TWOII',   # 台股上櫃指數（OTC,供個股查詢頁查上櫃整體走勢)
               }
    # 🎯 台股指數特例:這些 ticker 抓 period=2y 充足歷史(支援前端 240MA/季線等技術指標)
    LONG_HIST_KEYS = {'twii', 'twoii'}
    print(f"\n🌐 抓取美股昨收資料（{today}）...")
    result = {}
    for key, ticker in symbols.items():
        try:
            is_long = key in LONG_HIST_KEYS
            # 🛡️ SIGALRM 硬逾時，防 yfinance 無限 hang
            #    台股指數抓 2y(供前端個股頁完整功能)、其他維持 10d(省 API 額度)
            # 📏 V73.2.8 指數 2y → 5y:回測窗口的天花板是**指數**不是個股 ——
            #   個股有 763 筆(3 年)但 ^TWII 只有 486 筆(2 年),而超額報酬要扣同期大盤
            #   → 整套回測只能算 2 年,連 2022 那次 −32% 空頭都涵蓋不到。
            #   ⛔ 只放寬指數(2 檔);2,700 檔個股全部重抓會被 yfinance 限流。
            _period = '5y' if is_long else '10d'
            hist = call_with_timeout(lambda: yf.Ticker(ticker).history(period=_period), 30, None)
            yf_empty = (hist is None or hist.empty)
            # 🐛 V40.1 長線台股指數(twii/twoii)即使 yfinance 空/逾時也「不可 continue」,
            #    否則跳過官方來源 + 不寫 ^TWII.json → 個股頁加權 K 線停更(實測停在 6/10)。
            #    twoii(^TWO)yfinance 幾乎永遠回空 → 櫃買全靠官方 TPEX。非長線指數維持空就跳過。
            if yf_empty and not is_long:
                continue
            yf_rows = []
            if not yf_empty:
                prev = hist.iloc[-2] if len(hist) >= 2 else hist.iloc[-1]
                last = hist.iloc[-1]
                result[key] = {
                    'date':    str(last.name.date()),
                    'close':   round(float(last['Close']), 2),
                    'prev':    round(float(prev['Close']), 2),
                    'chg_pct': round((float(last['Close']) - float(prev['Close'])) /
                                      float(prev['Close']) * 100, 2),
                }
                if is_long:
                    yf_rows = [
                        {'date':   str(idx.date()).replace('-', '/'),
                         'open':   round(float(row['Open']), 2),
                         'high':   round(float(row['High']), 2),
                         'low':    round(float(row['Low']), 2),
                         'close':  round(float(row['Close']), 2),
                         'volume': (int(row['Volume']) if (row['Volume'] == row['Volume']) else 0)}
                        for idx, row in hist.iterrows()
                        if (row['Close'] == row['Close'])   # dropna
                    ]
            # 🎯 ^TWII / ^TWOII 寫成 data/^*.json 個股格式(對齊 list of OHLCV),供前端 analyze('^TWII') 查完整 K 線。
            if is_long:
                # 🏛️ 官方來源(主要):TWSE TAIEX(twii)/ TPEX OTC(twoii)抓最近 2 個月權威 OHLC
                official_rows = None
                try:
                    if key == 'twii':
                        official_rows = _fetch_twii_history_official(months_back=2)
                    elif key == 'twoii':
                        # ⭐ V73.6.1 先走 FinMind(實測唯一穩定拿得到的);⛔ 空了才退回 TPEX 官網
                        #   (官網對 GitHub runner 會 403,見 _fetch_otc_history_finmind 的說明)
                        official_rows = _fetch_otc_history_finmind(days_back=400)
                        if not official_rows:
                            official_rows = _fetch_otc_history_official(months_back=2)
                except Exception as _e:
                    print(f"  ⚠️ 官方來源 {key} 抓取例外: {str(_e)[:80]}")
                # 🔊 V71.2.3:官方來源掛掉時要「大聲講」,不能靜靜退回 yfinance。
                #    這條線斷掉時 ^TWII.json 會停在舊日期(加權指數整整落後一天,前端所有
                #    「站回 5 日線 / 指數跌幅 / M 頭頸線」全部用到錯的收盤),但以前只印一行
                #    小小的 HTTP code,淹沒在 2 千行 log 裡完全看不到。
                if official_rows:
                    print(f"  🏛️ 官方來源 {key}: {len(official_rows)} 筆(最新 {official_rows[-1]['date']})")
                else:
                    print(f"  🚨 官方來源 {key} 掛了(0 筆)→ 只能退回 yfinance/磁碟,"
                          f"指數收盤可能落後一天。查上方 [TWSE TAIEX]/[TPEX OTC] 訊息找原因")
                fname = '^TWOII.json' if key == 'twoii' else f"^{key.upper()}.json"
                # yfinance 逾時/空時,讀磁碟既有 ^*.json(origin/data restore)當長歷史底,官方鮮值疊上 → 保歷史又即時
                base_rows = yf_rows
                if not base_rows:
                    try:
                        _p = Path(DATA_DIR, fname)
                        if _p.exists():
                            base_rows = json.loads(_p.read_text(encoding='utf-8')) or []
                            print(f"  ♻️ {key} yfinance 空 → 沿用磁碟 {len(base_rows)} 筆長歷史,官方鮮值疊上")
                    except Exception as _e:
                        print(f"  ⚠️ 讀既有 {fname} 失敗:{_e}")
                long_rows = _merge_official_over_yf(base_rows, official_rows) if official_rows else base_rows
                # 📊 V71.6.2 官方量能(成交股數/金額)併入 —— 放在**合併之後**,才蓋得到完整長歷史。
                #   踩過的坑:一開始寫在 _fetch_twii_history_official 裡面,但那支只回最近 3 個月
                #   → 只有最新 63 列拿到 amount,舊的 423 列永遠沒有,量能類指標算不出一年趨勢。
                #   ⛔ 只有 twii(集中市場)適用;twoii 是櫃買,FMTQIK 不含它,不可套用。
                #   ⛔ 一律寫獨立欄位 mkt_vol / amount,**不動 volume**(volume 來自 yfinance,
                #      跟官方股數差約 1,500 倍,混同一欄會做出 1000 倍斷崖 —— 詳見 _merge_twii_volume)。
                if key == 'twii' and long_rows:
                    try:
                        # 📊 只抓「還缺 amount」的月份 —— 拉長到 5 年後若照舊 cap=30,
                        #   最舊那 2 年永遠拿不到 amount(指數量能是「整條序列換成 amount」,
                        #   缺了會出現空洞 → 陷阱 #29/#17)。改成自我限縮:
                        #   首次補歷史時抓多一點,之後每天只剩 1~2 個月要補。
                        _need = [r for r in long_rows if not r.get('amount')]
                        # ⚠️ 補完之後 _need 會變空 —— 這時**只刷最近 3 個月**(當月數字會被官方回補),
                        #   ⛔ 不可退回全量,否則拉長到 5 年後每天都要打 60 次 FMTQIK。
                        _mo = _months_span(_need, cap=70) if _need else _months_span(long_rows, cap=3)
                        long_rows, _hit = _merge_twii_volume(long_rows, _fetch_fmtqik_months(_mo))
                        print(f"  📊 官方量能(mkt_vol/amount)併入 {_hit}/{len(long_rows)} 列"
                              f"(FMTQIK {len(_mo)} 個月份檔)")
                    except Exception as _e:
                        print(f"  ⚠️ FMTQIK 量能併入失敗(不影響 OHLC): {str(_e)[:80]}")
                # 個股格式檔
                if long_rows:
                    try:
                        Path(DATA_DIR, fname).write_text(
                            json.dumps(long_rows, ensure_ascii=False, separators=(',', ':')),
                            encoding='utf-8')
                        print(f"  💾 {fname}: {len(long_rows)} 筆 OHLCV ({long_rows[-1].get('date','?')})")
                    except Exception as _e:
                        print(f"  ⚠️ 寫 {fname} 失敗:{_e}")
                # macro_cache 內保留 twii_history / twoii_history(120 日,泡沫預警 + 盤前大盤體檢櫃買用)
                hist_key = 'twii_history' if key == 'twii' else 'twoii_history'
                result[hist_key] = long_rows[-120:] if long_rows else []
                # 🚨 V77.4.5 陷阱 #22:三條來源全空時要**說出原因**,⛔ 不可靜靜沿用磁碟舊檔
                _stale = _hist_stale_error(key, official_rows, long_rows)
                if _stale:
                    result[f'{key}_error'] = _stale
                    print(f"  🚨 {key}: {_stale}")
                else:
                    result.pop(f'{key}_error', None)
                # 單值(date/close/prev/chg_pct):官方最準優先,否則 yfinance(已設),否則 long_rows 末兩根
                src2 = official_rows if (official_rows and len(official_rows) >= 2) else (long_rows if len(long_rows) >= 2 else None)
                if src2 and (official_rows or key not in result):
                    lo, po = src2[-1], src2[-2]
                    if po.get('close', 0) > 0:
                        result[key] = {
                            'date': str(lo['date']).replace('/', '-'),
                            'close': lo['close'],
                            'prev': po['close'],
                            'chg_pct': round((lo['close'] - po['close']) / po['close'] * 100, 2),
                        }
            if key in result:
                print(f"  {key}: {result[key]['close']} ({result[key]['chg_pct']:+.2f}%)")
        except Exception as e:
            print(f"  ⚠️  {ticker}: {e}")
    if not result:
        return
    result['generated'] = today.strftime('%Y-%m-%d')
    with open('macro_cache.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"  ✅ macro_cache.json（{len(result)-1} 指標）")



def fetch_free_fundamentals():
    """🆓 V79.0.0 每檔基本面 + 全市場免費產物(取代已刪除的 fetch_broker_chips)。

    FinMind 付費金鑰 2026-10-01 失效 → 券商分點與 10 個付費資料集整組移除(使用者決定)。
    這支只留舊函式裡「免費」那一半,⛔ 邏輯一行沒改,只是搬家:
      fundamentals_cache / industry_map / industry_pe / stock_names / company_geo /
      market_stats(融資維持率推估)/ data/chips/{sym}.json(⭐ 只放 fundamentals,⛔ 不再有分點)。
    ⚠️ chips/{sym}.json 路徑不改:X 光機、報告頁、top_picks、radar 都讀它的 fundamentals。
    """
    chips_dir = Path(DATA_DIR) / 'chips'
    chips_dir.mkdir(parents=True, exist_ok=True)
    today_str = date.today().strftime('%Y-%m-%d')
    write_miner_status('chips_fundamentals', 'mining',
                       {'note': '基本面 + 雷達 + 全球新聞 採礦中'})
    CHIPS_BATCH = int(os.getenv('CHIPS_BATCH', '0'))
    CHIPS_TOTAL = max(1, int(os.getenv('CHIPS_TOTAL', '1')))
    HOT_TURNOVER_TOP = int(os.getenv('HOT_TURNOVER_TOP', '220'))   # 成交值前 N 視為熱門(深度採)
    # 全市場宇宙 = data/*.json ∪ CHIP_WATCHLIST(有效股)
    _skip_names = {'radar', 'futures_cache', 'macro_cache', 'broker_names', 'top_picks',
                   'global_news', 'radar_news', 'tech_giants_news'}
    universe = set(CHIP_WATCHLIST) | {f.stem for f in Path(DATA_DIR).glob('*.json')
                                      if f.stem not in _skip_names}
    universe = {s for s in universe if _valid_stock(s)}
    # 成交值(價×量)排序 → 涵蓋高價中大型(中華電/台積電等)。
    # 🐛 V68.9.9 修:chips job(ONLY_CHIPS)的 SQLite stock_history 是空的(同 broker_perf V68.9.5 教訓),
    #    原本查 SQLite → turnover 全空 → 熱門只剩 CHIP_WATCHLIST、2412 這種被當冷門排到後面永遠採不到。
    #    改「直接讀 data/{sym}.json 近 25 筆算 avg(close×volume)」→ chips job 有還原 origin/data 的 JSON,必有值。
    turnover: dict = {}
    for _sym in universe:
        _p = Path(DATA_DIR) / f'{_sym}.json'
        if not _p.exists():
            continue
        try:
            _rows = json.loads(_p.read_text(encoding='utf-8'))
            if not isinstance(_rows, list) or not _rows:
                continue
            _tv = [float(r.get('close') or 0) * float(r.get('volume') or 0)
                   for r in _rows[-25:] if isinstance(r, dict) and r.get('close') and r.get('volume')]
            if _tv:
                turnover[_sym] = sum(_tv) / len(_tv)
        except Exception:
            continue
    print(f"  📊 成交值排序:{len(turnover)}/{len(universe)} 檔有 OHLCV 可排(其餘殿後)")
    # 熱門集合:精選清單 + 成交值 Top N(→ 中華電這類中大型必進熱門、天天深度採)
    _top_by_tv = sorted((s for s in universe if s in turnover),
                        key=lambda s: -turnover[s])[:HOT_TURNOVER_TOP]
    # 🧭 V71.1.5 板塊成分股一律進熱門:它們餵「板塊籌碼輪動 → 券商群聚」,
    #   但實測 73 檔裡有 20 檔成交值排 225~1816 名,照純成交值排會排到很後面 → 那段永遠用舊分點。
    _sector_syms = {x for v in SECTOR_MEMBERS.values() for x in v}
    hot_set = ({s for s in (set(CHIP_WATCHLIST) | set(_top_by_tv) | _sector_syms) if s in universe})
    # 熱門(精選清單 + 成交值前 N + 板塊成分股)先做、依成交值高→低;其餘依成交值。
    #   熱門股才逐檔打 FinMind 補基本面(7 天快取);冷門股只寫 TWSE/TPEx 的 PE/殖利率(零 API)。
    ordered = sorted(universe, key=lambda s: ((0 if s in hot_set else 1), -turnover.get(s, 0.0), s))
    if CHIPS_TOTAL > 1:
        ordered = [ordered[i] for i in range(CHIPS_BATCH, len(ordered), CHIPS_TOTAL)]
    watchlist = ordered
    print(f"  📋 基本面目標(全市場滾動):{len(watchlist)} 檔 | 熱門深度 {len(hot_set)} 檔 | "
          f"批次 {CHIPS_BATCH}/{CHIPS_TOTAL}")

    # 新增：一次查全市場 PE / 殖利率（TWSE）
    print("\n📊 抓取 TWSE 全市場本益比 / 殖利率快取...")
    # 【極限防禦】加上 or {}，確保即使 API 崩潰回傳 None，也絕對不會引發 'NoneType' 錯誤
    twse_fund = fetch_twse_fundamentals(date.today()) or {}

    # 🦅 獵鷹建倉分:把全市場 PE/殖利率 dump 成 cache,供 radar_miner 算「低本益比」因子(全市場覆蓋)
    #    抓成功才覆寫,失敗(空 dict)時保留昨日 last-good,避免洗掉。
    try:
        fc_path = Path('data', 'fundamentals_cache.json')
        # 基底 PE/殖利率:TWSE 成功用新值;TWSE 回空則沿用既有快取(不洗掉),YoY/毛利照樣補
        if twse_fund:
            # 🐛 V71.6.2 修「market_stats.json 從上線到現在一次都沒產出」:
            #   這裡只挑 pe / yield_rate,**把 pbr 丟掉了** —— 而 fetch_twse_fundamentals
            #   明明抓得到(BWIBBU_d 有「股價淨值比」欄)。
            #   下游 compute_market_pb_percentiles 讀 fund['pb'] or fund['pbr'],永遠拿到 None
            #   → 樣本數恆為 0 < 50 → 恆回 {} → market_stats.json 永遠不寫
            #   → 前端 X 光機 P/B 判斷退回固定 <2 / >5 門檻(有 silent catch,所以零錯誤訊息)。
            #   實證:gh-pages 的 fundamentals_cache.json 876 檔,pe 833 / yield_rate 833,
            #        pb+pbr 合計 **0** 檔。
            fund_cache = {s: {'pe': v.get('pe'), 'yield_rate': v.get('yield_rate'),
                              'pbr': v.get('pbr')}
                          for s, v in twse_fund.items() if isinstance(v, dict)}
            base_src = 'TWSE'
        else:
            try:
                _ex = json.loads(fc_path.read_text(encoding='utf-8'))
                fund_cache = {k: v for k, v in _ex.items() if not str(k).startswith('__')} if isinstance(_ex, dict) else {}
            except Exception:
                fund_cache = {}
            base_src = 'cache(TWSE空)'
            print(f"  ⏭️ TWSE 基本面回空,沿用既有 fundamentals_cache.json({len(fund_cache)} 檔)再補 YoY/毛利")

        # 🆕 V72.4.3 併入**上櫃**基本面 —— BWIBBU_d 只有上市,上櫃(4/5/6/8 開頭居多)
        #   本益比/殖利率一檔都沒有。使用者實測中美晶 5483(上櫃)時發現的缺口。
        #   ⚠️ 只補「TWSE 沒給的」與「TWSE 給了但值是 None」的欄位,⛔ 不覆蓋上市既有值。
        #   ⛔ 失敗一律不擋(它是加值資料),而且不可洗掉既有快取。
        try:
            tpex_fund = fetch_tpex_fundamentals() or {}
        except Exception as _te:
            tpex_fund = {}
            print(f"  ⚠️ TPEx 基本面例外(不擋):{str(_te)[:100]}")
        if tpex_fund:
            _new = _fill = 0
            for s, v in tpex_fund.items():
                if not isinstance(v, dict):
                    continue
                cur = fund_cache.get(s)
                if not isinstance(cur, dict):
                    fund_cache[s] = {'pe': v.get('pe'), 'yield_rate': v.get('yield_rate'),
                                     'pbr': v.get('pbr')}
                    _new += 1
                else:
                    for k in ('pe', 'yield_rate', 'pbr'):
                        if cur.get(k) is None and v.get(k) is not None:
                            cur[k] = v[k]; _fill += 1
            print(f"  ✓ 併入上櫃基本面:新增 {_new} 檔、補齊 {_fill} 個欄位 → 合計 {len(fund_cache)} 檔")

        # V35.8 — bulk YoY/毛利:經 __status 實證 FinMind 免費版「不帶 data_id」抓營收/財報回 0,已棄用。
        #   改在下方分點逐檔迴圈把「觀察清單已算好的 YoY/毛利」併入(免費、零額外 API);全市場 YoY/毛利需 Sponsor。
        if fund_cache:
            yoy_hits = sum(1 for v in fund_cache.values() if isinstance(v, dict) and 'rev_yoy' in v)
            gm_hits  = sum(1 for v in fund_cache.values() if isinstance(v, dict) and 'gross_margin' in v)
            fund_cache['__status'] = {'base': base_src, 'updated': date.today().strftime('%Y-%m-%d'),
                                      'yoy_src': 'watchlist', 'yoy_hits': yoy_hits, 'gm_hits': gm_hits}
            fc_path.write_text(json.dumps(fund_cache, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            print(f"  💾 全市場基本面快取(PE/殖利率)→ data/fundamentals_cache.json({len([k for k in fund_cache if not str(k).startswith('__')])} 檔);YoY/毛利待逐檔迴圈後併入")
        else:
            print("  ⏭️ fund_cache 為空(TWSE 回空且無既有快取),跳過")

        # 🏭🚨 V76.4.0 這一整段**從 `if twse_fund:` 底下搬出來**(使用者:「要挖礦就挖礦」)。
        #   實跑證據(daily_miner #576 的 chips job log 逐字):
        #     ⏭️ TWSE 基本面回空,沿用既有 fundamentals_cache.json(1799 檔)再補 YoY/毛利
        #     ⏭️ TWSE 基本面回空,跳過產業 PE 聚合(YoY/毛利已獨立補入既有快取)
        #   2026-09-12、13、14 **連三輪**都是這樣,而這個閘門底下掛著四件事:產業 PE 聚合 /
        #   industry_map.json / stock_names.json(中文股名離線表)/ company_geo.json →
        #   後面三個**跟本益比完全無關**的產物一起沒更新,而且全綠、零錯誤訊息。
        #   ⚠️ 最諷刺的是下面那個 build_stock_names 的註解自己就寫著「⛔ 獨立 try:它失敗
        #   ⛔ 不可拖累 industry_map / company_geo」——**內層拆開了,外層這個閘門沒拆**;
        #   而 market_stats 那一段(下方 V72.1.1 / V72.2.1)已經因為同一個坑修過兩次。
        #   ⭐⭐ 通用:一個閘門只能管**真的需要它**的那一件事(陷阱 #44)。

        # 🏷️ 產業相對 PE 聚合(供前端 X 光機算「比同業便宜?」)
        print("  🏭 抓產業類別 + 算每產業中位數 PE...")
        ipe_path = Path('data', 'industry_pe.json')
        imap_path = Path('data', 'industry_map.json')
        try:
            industry_map = fetch_industry_map()
            # industry_map 非空 → 永遠寫(分組 PE 失敗也保留對照表,前端可獨立用)
            if industry_map:
                imap_path.write_text(
                    json.dumps(industry_map, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                print(f"  💾 個股→產業對照 → data/industry_map.json({len(industry_map)} 檔)")
            else:
                print("  ⏭️ 產業對照表為空,保留既有 industry_map.json(若有)")

            # 🏷️ V75.1.4 股名離線表 — 同一次 API 產出(零額外 API)
            #   ⛔ 獨立 try:它失敗 ⛔ 不可拖累 industry_map / company_geo
            #      (V72.2.1 的教訓:兩個獨立指標綁同一個 try,一個失敗會拖垮另一個)
            try:
                build_stock_names(industry_map)
            except Exception as _e_sn:
                print(f"  ⚠️ 股名離線表產出失敗(不影響其他產物):{type(_e_sn).__name__}: {_e_sn}")

            # 🗺️ V71.9.8 公司所在縣市(地緣分點用)— 跟 industry_map 同一次 API 產出
            #    ⛔ 空的時候不覆蓋(同「保留舊檔」原則),否則上游一次抽風就整份消失
            try:
                _geo_path = Path('data', 'company_geo.json')
                if _COMPANY_GEO and len(_COMPANY_GEO) >= 500:
                    _geo_path.write_text(json.dumps(
                        {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                         'n': len(_COMPANY_GEO), 'data': _COMPANY_GEO},
                        ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                    print(f"  💾 公司所在縣市 → data/company_geo.json({len(_COMPANY_GEO)} 檔)")
                else:
                    print(f"  ⏭️ 公司縣市僅 {len(_COMPANY_GEO)} 檔(<500)— 保留既有 company_geo.json")
            except Exception as _e_geo:
                print(f"  ⚠️ company_geo.json 寫入失敗:{str(_e_geo)[:80]}")

            # 🚦 V76.4.0 只有「產業 PE 聚合」真的需要 twse_fund —— ⛔ 它不可以再把上面三個產物一起擋掉
            if twse_fund:
                industries = aggregate_industry_pe(fund_cache, industry_map)
            else:
                industries = None
                print("  ⏭️ TWSE 基本面回空 → **只**跳過產業 PE 聚合(產業對照表 / 股名離線表 / 公司縣市已獨立產出)")
            if industries:
                ipe_path.write_text(json.dumps({
                    'updated': date.today().strftime('%Y-%m-%d'),
                    'industries': industries,
                    '_note': '中位數 PE(避免極端值偏誤);is_cyclical=true 為景氣循環產業,PE 低不等於便宜',
                }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                print(f"  💾 產業相對 PE → data/industry_pe.json({len(industries)} 個產業)")
            elif not ipe_path.exists():
                # 首次失敗(檔案還不存在)→ 寫一個有 _status 的最小 JSON,讓前端能判斷顯示「採集失敗」
                ipe_path.write_text(json.dumps({
                    'updated': date.today().strftime('%Y-%m-%d'),
                    'industries': {},
                    '_status': 'failed',
                    '_reason': f'industry_map 空({len(industry_map)} 檔) 或 fund_cache 無 PE 對應',
                }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                print(f"  ⚠️ 產業 PE 聚合無資料且首次跑,寫入 _status=failed 旗標 → data/industry_pe.json")
            else:
                print("  ⏭️ 產業 PE 聚合無資料,保留既有 industry_pe.json")

        except Exception as e:
            print(f"  ⚠️ 產業 PE 聚合失敗(不影響主流程):{e}")

        # V16.2 — 全市場 P/B 分位數寫 data/market_stats.json(供前端動態判斷取代固定 <2/>5)
        # 🐛 V72.1.1 → V72.2.1 **同一個坑修了兩次才修對,兩層巢狀都要拆**:
        #   ① V72.1.1 拆掉內層 `if pb_pct:` —— P/B 算不出來時融資維持率不該跟著沒有。
        #   ② ⚠️ **但外面還有一層 `if twse_fund:`**,那次沒看到 →
        #      實跑 workflow log 寫著「⏭️ TWSE 基本面回空,跳過產業 PE 聚合」,
        #      整段連進都沒進去,所以 V72.1.1 修完**仍然一次都沒產出過**。
        #   ⭐ 融資維持率只讀 data/*.json 的 margin_balance + 收盤價,
        #      `compute_market_margin_health()` **連參數都不收** —— 它跟 TWSE 基本面完全無關。
        #   ⭐⭐ 通用教訓:**拆巢狀時要往上追到函式頂層**,別只拆看得到的那一層;
        #      而且「修完沒生效」時要去看 **workflow log 的實際輸出**,
        #      log 那句「跳過產業 PE 聚合」就是答案,比再讀十遍程式碼快。
        try:
            ms_path = Path('data', 'market_stats.json')
            existing_ms = {}
            if ms_path.exists():
                try: existing_ms = json.loads(ms_path.read_text(encoding='utf-8'))
                except Exception: pass
            _ms_dirty = False

            pb_pct = compute_market_pb_percentiles(fund_cache)
            if pb_pct:
                existing_ms['pb'] = pb_pct
                _ms_dirty = True
                print(f"  💾 全市場 P/B 分位(P25/P50/P75/P90 = {pb_pct['p25']}/{pb_pct['p50']}/{pb_pct['p75']}/{pb_pct['p90']},{pb_pct['count']} 檔)")
            else:
                # 明細已由 compute_market_pb_percentiles 印出(掃幾檔/有欄幾檔/合理區間幾檔)
                print("  ⏭️ P/B 分位算不出來,保留既有值(⭐ 不影響下面的融資維持率)")

            # 💳 V72.0.3 全市場融資維持率 + 逐日歷史(危機溫度計;跌破 130% = 斷頭區)
            #   ⭐ V72.1.1 起與 P/B **完全獨立**,各自成功各自寫。
            try:
                mh = compute_market_margin_health()
                # 🗑️ V79.0.0 官方融資維持率(fetch_official_margin_maintenance)是 FinMind 付費資料集 → 已移除,只留推估值
                if mh:
                    mh['src'] = 'estimate'
                    existing_ms.pop('margin_official_error', None); existing_ms.pop('margin_hist_official', None)
                if mh:
                    existing_ms['margin'] = mh
                    existing_ms.pop('margin_error', None)
                    # 歷史:一天一筆(同日重跑覆蓋),留 500 筆
                    _h = existing_ms.get('margin_hist')
                    if not isinstance(_h, list):
                        _h = []
                    # 🐛 V72.3.0 原本寫 `datetime.now(TW)`,但 miner.py **從來沒有定義過 `TW`** ——
                    #   `mh['date']` 目前一定有值,所以那條 `or` 分支沒被走到,是顆**未爆彈**:
                    #   一旦走到就 `NameError`,而它外面正好有 `except Exception as _e_mh` → 被吞成 margin_error。
                    #   全檔其他地方都是寫 `timezone(timedelta(hours=8))`,統一成一致寫法。
                    _d = mh.get('date') or datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
                    _rec = {'d': _d, 'r': mh['ratio'], 'n': mh['n']}
                    if _h and _h[-1].get('d') == _d:
                        _h[-1] = _rec
                    else:
                        _h.append(_rec)
                    existing_ms['margin_hist'] = _h[-500:]
                    _ms_dirty = True
                    print(f"  💳 全市場融資維持率 {mh['ratio']}%({mh['n']} 檔有效)")
                else:
                    # ⭐ 陷阱 #22:算不出來要留原因,否則從 JSON 分不出「沒跑」還是「被守門擋掉」
                    existing_ms['margin_error'] = '樣本不足(有效檔數 < 200)或無融資餘額資料'
                    _ms_dirty = True
                    print("  ⏭️ 全市場融資維持率:樣本不足,寫入 margin_error 留線索")
            except Exception as _e_mh:
                existing_ms['margin_error'] = f'計算失敗:{str(_e_mh)[:120]}'
                _ms_dirty = True
                print(f"  ⚠️ 全市場融資維持率計算失敗(不影響其他):{str(_e_mh)[:80]}")

            if _ms_dirty:
                ms_path.write_text(json.dumps(existing_ms, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                print(f"  💾 → data/market_stats.json({ms_path.stat().st_size} bytes)")
            else:
                print("  ⏭️ market_stats.json 無新內容,保留既有檔")
        except Exception as e:
            print(f"  ⚠️ market_stats 寫入失敗(不影響主流程):{e}")
    except Exception as e:
        print(f"  ⚠️ fundamentals_cache 寫檔失敗(不影響主流程):{e}")

    print(f"\n📈 啟動逐檔基本面 ({len(watchlist)} 檔)...")
    _fund_extra: dict = {}      # V35.8 — 收集觀察清單已算好的 {sym:{rev_yoy,gross_margin}},迴圈後併入全市場快取
    _done = 0
    _t0 = time.time()
    _budget = int(os.getenv('CHIPS_TIME_BUDGET', '2400'))
    for sym in watchlist:
        if time.time() - _t0 > _budget:
            print(f"  ⏳ 時間預算 {_budget}s 到,本輪先收工(已寫 {_done} 檔);剩下的下輪續做")
            break
        _is_hot = sym in hot_set
        out_file = chips_dir / f'{sym}.json'
        existing_obj: dict = {}
        if out_file.exists():
            try:
                raw = json.loads(out_file.read_text(encoding='utf-8'))
                existing_obj = raw if isinstance(raw, dict) else {}
            except Exception:
                existing_obj = {}
        cached_fund = existing_obj.get('fundamentals') or {}
        generated_str = cached_fund.get('generated', '')
        cached_ver = cached_fund.get('miner_version', '')
        skip_finmind = False
        if generated_str and os.environ.get('FORCE_FUND_REFRESH') != '1':
            try:
                age_days = (date.today() - date.fromisoformat(generated_str)).days
                skip_finmind = (age_days < FUND_CACHE_DAYS) and (cached_ver == MINER_VERSION)
            except Exception: pass

        # V68.9.8 冷門股:daily 分點迴圈「不」做昂貴逐檔基本面(每檔多次 FinMind call)→ 省額度給全市場分點。
        #   冷門股基本面走 TWSE bulk PE/殖利率 + 夜間 fund_sweep 滾動補;深度基本面仍留給熱門股。
        if not _is_hot:
            skip_finmind = True

        # 【極限防爆】提前提取並確保字典絕對不會是 None
        tw_fund = twse_fund.get(sym, {}) or {}

        if skip_finmind:
            print(f"  ⚡ 基本面快取有效（{generated_str} / {cached_ver}），跳過 FinMind")
            fundamentals = {**cached_fund,
                            'pe':         tw_fund.get('pe') or cached_fund.get('pe'),
                            'pb':         tw_fund.get('pbr') or cached_fund.get('pb'),
                            'yield_rate': tw_fund.get('yield_rate') or cached_fund.get('yield_rate'),
                            'miner_version': MINER_VERSION}   # V15.8
        else:
            print(f"  📈 基本面採礦 {sym}...", end=' ', flush=True)
            fm_fund = fetch_finmind_fundamentals(sym) or {}  # 加上 or {} 終極防爆
            # V14.15:讀 data/{sym}.json 的 OHLCV 算填息歷史
            fill_hist, fill_prob, avg_days = [], None, None
            try:
                ohlcv_path = Path(DATA_DIR) / f'{sym}.json'
                if ohlcv_path.exists():
                    ohlcv_rows = json.loads(ohlcv_path.read_text(encoding='utf-8'))
                    if isinstance(ohlcv_rows, list) and ohlcv_rows:
                        fill_hist, fill_prob, avg_days = compute_dividend_fill_history(
                            fm_fund.get('quarterly_dividends', []), ohlcv_rows)
            except Exception as _e:
                print(f"    ⚠️ 填息歷史 {sym}: {_e}")

            # V15.9 — 當 TWSE BWIBBU_d 拿不到 PE/PBR/yield 時,先打 FinMind TaiwanStockPER
            #         (官方等價,免費 dataset,治本 TWSE IP 被擋 + 補 V15.7 P/B 缺口)
            fm_per = {}
            if tw_fund.get('pe') is None or tw_fund.get('pbr') is None or tw_fund.get('yield_rate') is None:
                fm_per = _fetch_finmind_per(sym) or {}
            _pe  = tw_fund.get('pe')  or fm_per.get('pe')  or fm_fund.get('pe')
            _pbr = tw_fund.get('pbr') or fm_per.get('pb')  or fm_fund.get('pb')
            _yld = tw_fund.get('yield_rate') or fm_per.get('yield_rate')
            fundamentals = {
                'eps':                fm_fund.get('eps'),
                'eps_history':        fm_fund.get('eps_history'),
                'revenue_yoy':        fm_fund.get('revenue_yoy'),
                'is_revenue_high':    fm_fund.get('is_revenue_high'),
                'revenue_est_next_q': fm_fund.get('revenue_est_next_q'),
                'pe':                 _pe,
                'pe_source':          ('TWSE_TTM' if tw_fund.get('pe') else
                                       'FinMind_PER' if fm_per.get('pe') else 'FinMind'),
                'pb':                 _pbr,
                'pb_unavailable':     (_pbr is None),   # V15.7 P/B 無資料源 flag(V15.9 多了 FinMind PER source 後 false rate 大降)
                'yield_rate':         _yld,
                'gross_margin_trend': fm_fund.get('gross_margin_trend'),
                'op_margin_trend':    fm_fund.get('op_margin_trend'),    # 🆕 營業利益率趨勢(三率三升)
                'net_margin_trend':   fm_fund.get('net_margin_trend'),   # 🆕 淨利率趨勢(三率三升)
                'payout_ratio':       fm_fund.get('payout_ratio'),
                # 🩺 V73.4.1 診斷欄位一定要挑進來 —— `fundamentals` 是**逐欄挑**的,
                #   加在 fetch 端卻沒挑進來 = 白加(陷阱 #37:寫好了卻沒接上)。
                '_fetch_diag':        fm_fund.get('_fetch_diag'),
                'fund_error':         fm_fund.get('fund_error'),
                'total_dividend':     fm_fund.get('total_dividend'),
                'total_dividend_4q':  fm_fund.get('total_dividend_4q'),
                'quarterly_dividends': fm_fund.get('quarterly_dividends', []),
                'dividend_fill_history': fill_hist,
                'dividend_fill_prob':    fill_prob,
                'dividend_avg_fill_days':avg_days,
                'is_record_high':     fm_fund.get('is_record_high', False),
                'latest_revenue':     fm_fund.get('latest_revenue'),
                'monthly_revenue_history': fm_fund.get('monthly_revenue_history', []),
                'quarterly_eps':      fm_fund.get('quarterly_eps', []),
                'generated':          today_str,
                'miner_version':      MINER_VERSION,   # V15.8 cache 版本標記
            }
            # V15.7 — 後端 fallback:TWSE BWIBBU_d 對某些股拿不到 PE/yield(GitHub Actions IP 可能被封),
            #         用 FinMind 4 季 EPS 加總 + SQLite 最新 close 算 PE 寫進 chips JSON
            if fundamentals.get('pe') is None:
                try:
                    qeps = fundamentals.get('quarterly_eps', [])
                    if len(qeps) >= 4:
                        eps_4q = sum(float(q.get('eps', 0) or 0) for q in qeps[-4:])
                        if eps_4q > 0:
                            _cur = get_db_conn()
                            _cur.row_factory = sqlite3.Row
                            _row = _cur.execute(
                                "SELECT close FROM stock_history WHERE symbol=? AND volume > 0 "
                                "ORDER BY trade_date DESC LIMIT 1", (sym,)).fetchone()
                            _cur.close()
                            if _row and _row[0] > 0:
                                latest_close = float(_row[0])
                                fundamentals['pe'] = round(latest_close / eps_4q, 2)
                                fundamentals['pe_source'] = 'FinMind_calc'
                                if fundamentals.get('total_dividend_4q', 0) and fundamentals['total_dividend_4q'] > 0:
                                    fundamentals['yield_rate'] = round(fundamentals['total_dividend_4q'] / latest_close * 100, 2)
                except Exception as _e:
                    print(f"    ⚠️ V15.7 PE/yield fallback {sym}: {_e}")
            print("✅")

        # ⭐ 只寫基本面(⛔ 不再有 chips / periods / hist / bstat / data_completeness)
        output = {
            'fundamentals': fundamentals,
            'data_date': today_str,
            'tier': 'hot' if _is_hot else 'cold',
            'generated': today_str,
        }
        out_file.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')
        _done += 1

        # V35.8 — 收集本檔已算好的 YoY/毛利,迴圈後併入全市場快取(免費,零額外 API;取代失效的 bulk)
        try:
            _fd = fundamentals or {}
            _ry = _fd.get('revenue_yoy')
            _gmt = _fd.get('gross_margin_trend') or ''
            _gm = None
            if _gmt:
                _ms = re.findall(r'([\d.]+)%', _gmt)   # 趨勢字串末值 = 最新毛利率
                if _ms: _gm = float(_ms[-1])
            _ex = {}
            if _ry is not None:
                try: _ex['rev_yoy'] = round(float(_ry), 1)
                except Exception: pass
            if _gm is not None: _ex['gross_margin'] = _gm
            # 🔥 V48.1 獲利跳訊號(給長線潛力 f3;觀察清單才有,冷門股略過)
            try:
                _tri = sum(1 for k in ('gross_margin_trend', 'op_margin_trend', 'net_margin_trend') if '↑' in (_fd.get(k) or ''))
                if _tri: _ex['tri_up'] = _tri                       # 三率上升數 0-3
                if _fd.get('is_record_high'): _ex['is_record_high'] = True   # 創營收新高
                _mrh = _fd.get('monthly_revenue_history') or []
                if len(_mrh) >= 3:
                    _r = [float(x.get('rev', 0) or 0) for x in _mrh[-3:]]
                    if _r[0] > 0 and _r[2] > _r[1] > _r[0]: _ex['rev_mom_up'] = True   # 近3月營收連續走高
            except Exception: pass
            if _ex: _fund_extra[sym] = _ex
        except Exception: pass
    print(f"  ✅ 基本面完成:寫入 {_done} 檔")

    # V35.8 — 把觀察清單已算好的 YoY/毛利併入全市場 fundamentals_cache.json(bulk 免費版抓不到,改逐檔重用)
    try:
        if _fund_extra and fc_path.exists():
            _fc = json.loads(fc_path.read_text(encoding='utf-8'))
            if isinstance(_fc, dict):
                for s, ex in _fund_extra.items():
                    if isinstance(_fc.get(s), dict): _fc[s].update(ex)
                    else: _fc[s] = dict(ex)
                _yh = sum(1 for k, v in _fc.items() if not str(k).startswith('__') and isinstance(v, dict) and 'rev_yoy' in v)
                _gh = sum(1 for k, v in _fc.items() if not str(k).startswith('__') and isinstance(v, dict) and 'gross_margin' in v)
                _st = _fc.get('__status') if isinstance(_fc.get('__status'), dict) else {}
                _st.update({'yoy_src': 'watchlist', 'watchlist_extra': len(_fund_extra), 'yoy_hits': _yh, 'gm_hits': _gh})
                _fc['__status'] = _st
                fc_path.write_text(json.dumps(_fc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                print(f"  💾 觀察清單 YoY/毛利併入全市場快取:{len(_fund_extra)} 檔(命中 YoY {_yh}/毛利 {_gh})")
    except Exception as e:
        print(f"  ⚠️ 觀察清單 YoY/毛利併入失敗:{e}")


def _quick_ind(data):
    if len(data) < 22: return None
    # 🛡️ 只留「有限」收盤價:排除 None / 字串 / NaN / ±Inf。
    #    json.loads 預設 allow_nan=True,上游若寫出 NaN,讀回即 float('nan');
    #    isinstance(nan, float) 為 True 會漏網,污染 MA/布林全變 NaN 卻無聲。
    closes = [d['close'] for d in data if is_finite_num(d.get('close'))]
    # 🛡️ 成交量同樣防呆:volume 為 null(None)時 sum() 會直接 TypeError 崩潰
    vols   = [v if is_finite_num(v) else 0 for v in (d.get('volume', 0) for d in data)]
    if len(closes) < 22: return None
    ma   = lambda n, a=closes: sum(a[-n:]) / n
    pma  = lambda n, a=closes: sum(a[-n-1:-1]) / n
    ma5, ma10, ma20 = ma(5), ma(10), ma(20)
    pma5, pma10, pma20 = pma(5), pma(10), pma(20)
    vma5 = sum(vols[-5:]) / 5 if vols else 0
    var20    = sum((c - ma20) ** 2 for c in closes[-20:]) / 20
    upper_bb = ma20 + 2 * var20 ** 0.5
    # 🛡️ 雙保險:任一指標非有限值(理論上已被上面過濾擋掉)則整筆放棄,不讓 NaN 流入雷達
    if not all(math.isfinite(x) for x in (ma5, ma10, ma20, pma5, pma10, pma20, vma5, upper_bb)):
        return None
    return {'close': closes[-1], 'prev_close': closes[-2],
            'ma5': ma5, 'ma10': ma10, 'ma20': ma20,
            'pma5': pma5, 'pma10': pma10, 'pma20': pma20,
            # 🚨🚨 V76.1.6 這裡以前是 `vols[-3:]`(長度 3)—— 而 V76.1.5 的妖股修法要拿
            #   `rv[-8:-3]`(那 3 根之前的 5 日均量)當爆量基準 → `len(rv) >= 8` **永遠不成立**
            #   → 基準恆為 0 → `vol_burst` 恆為 0 → 🐲 妖股榜**修完還是空的**,而且一樣零錯誤訊息。
            #   ⛔ 長度必須 ≥ 8(= 3 根被判斷的 + 5 根基準),改這個數字之前先看 build_radar_cache 的 rv 用法。
            #   ⭐ 教訓(陷阱 #40 第六例):我當時是在**獨立模擬腳本**上量「修正後 8 檔」的,
            #      那裡有完整的 vols,沒有走這條正式路徑 → 假綠燈。驗修法一定要走正式入口。
            'vma5': vma5, 'upper_bb': upper_bb, 'recent_vols': vols[-8:]}


def build_radar_cache():
    results   = {'bottom': [], 'surge': [], 'score': [], 'monster': [], 'wrongkill': [],
                 'foreign3': [], 'trust3': []}   # 🏦 V57.6 外資/投信連 3 買榜(對標專業 App 多方分類)
    processed = 0

    print("\n🚀 啟動全局雷達掃描 (植入高勝率量化三引擎 + 妖股雷達 + 錯殺雷達)...")

    # 👑 族群領頭羊用:預載概念股對照(concept_stocks.json by_stock);檔案缺=不產 concept_leaders
    _cl_map = {}
    try:
        _cj = json.loads(Path(DATA_DIR).joinpath('concept_stocks.json').read_text(encoding='utf-8'))
        if isinstance(_cj, dict) and isinstance(_cj.get('by_stock'), dict):
            _cl_map = _cj['by_stock']
    except Exception:
        pass
    _cl_acc = {}

    # 🩹 錯殺雷達用:預載全市場營收 YoY(fundamentals_cache 主 + 夜間 fund_yoy_gm 補),檔案缺=該項不計分
    _wk_yoy = {}
    try:
        _fc = json.loads(Path(DATA_DIR).joinpath('fundamentals_cache.json').read_text(encoding='utf-8'))
        for _k, _v in _fc.items():
            if not str(_k).startswith('__') and isinstance(_v, dict) and _v.get('rev_yoy') is not None:
                _wk_yoy[_k] = float(_v['rev_yoy'])
    except Exception:
        pass
    try:
        _fg = json.loads(Path(DATA_DIR).joinpath('fund_yoy_gm.json').read_text(encoding='utf-8'))
        for _k, _v in _fg.items():
            if not str(_k).startswith('__') and isinstance(_v, dict) and _v.get('yoy') is not None:
                _wk_yoy.setdefault(_k, float(_v['yoy']))
    except Exception:
        pass
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
                # 🚨🚨 V76.1.5 這一行以前拿 `vma5`(近 5 日均量,**含爆量棒自己**)當爆量基準 →
                #   第一根爆 3 倍會把均量自己墊高,第二根幾乎不可能再超過新門檻。
                #   📊 全市場實測(2,719 檔):`vol_burst>=2` 通過 **0 檔** → 妖股榜**從上線到現在一直是空的**,
                #      而「漲幅」那一關本身有 43 檔 → 卡住的百分之百是這裡。
                #   ⭐ 修法:基準改成「**那 3 根之前**的 5 日均量」(rv[-8:-3]),這才是「爆量」的標準定義。
                #      修正後同樣的 3 倍 × 2 根 → **8 檔**(合理),⛔ 門檻本身一個數字都沒放寬。
                _vbase = (sum(rv[-8:-3]) / 5) if len(rv) >= 8 else 0
                vol_burst = sum(1 for v in (rv[-3:] if rv else []) if _vbase > 0 and v > _vbase * 3)
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
            # 👑 族群領頭羊:每檔按概念歸戶,存 5 日漲幅;掃完後每個概念取前 3 強(純數據,零 AI)
            try:
                _cl_tags = _cl_map.get(sym)
                if _cl_tags and len(raw) >= 6 and raw[-6]['close'] > 0:
                    _g5 = (c - raw[-6]['close']) / raw[-6]['close'] * 100
                    for _tag in _cl_tags[:8]:
                        if _tag:
                            _cl_acc.setdefault(_tag, []).append((sym, round(_g5, 1), round(c, 2)))
            except Exception:
                pass

            # 🏦 V57.6 外資/投信連 3 買榜:法人資料單位「股」→ 張;ETF 不列(法人買 ETF 非個股訊號)
            try:
                if not sym.startswith('00') and len(raw) >= 3:
                    _chg1 = (c - pc) / pc * 100 if pc > 0 else 0
                    _f3 = [(r.get('foreign_net') or 0) for r in raw[-3:]]
                    _t3 = [(r.get('trust_net') or 0) for r in raw[-3:]]
                    if all(v > 0 for v in _f3):
                        results['foreign3'].append({'sym': sym, 'close': round(c, 2),
                                                    'chg': round(_chg1, 1), 'sum3': round(sum(_f3) / 1000)})
                    if all(v > 0 for v in _t3):
                        results['trust3'].append({'sym': sym, 'close': round(c, 2),
                                                  'chg': round(_chg1, 1), 'sum3': round(sum(_t3) / 1000)})
            except Exception:
                pass

            # 🩹 錯殺雷達:今日大跌 ≤-4% 但體質沒壞(原多頭+回測月/季線支撐+法人沒跑+營收成長)
            #   ETF 不算(族群齊跌非錯殺);放在乖離守門前,大跌股不會被多頭追高濾網跳過
            #   🐛 V58.3 三修(2026-07-07 跌停潮實證):
            #   ①|chg|>11% 排除 — 普通股跌停頂多 -10%,超過=興櫃(無漲跌幅限制)暴走或大除息缺口,不是錯殺
            #   ②前一日暴漲 ≥8% 的隔日回檔=妖股獲利了結(雷虎生 +46.6% 隔天 -13.3% 竟得 100 分),不是錯殺
            #   ③「月線附近」補上限 — 原只查 c≥ma20×0.97,高於月線 51% 也算「附近」;改回測支撐帶 0.97~1.08
            try:
                wk_chg = (c - pc) / pc * 100 if pc > 0 else 0
                _ppc = raw[-3]['close'] if len(raw) >= 3 else 0
                _prev_gain = (pc - _ppc) / _ppc * 100 if _ppc > 0 else 0
                if -11 <= wk_chg <= -4 and _prev_gain < 8 and not sym.startswith('00') and len(raw) >= 60:
                    ma60 = sum(r['close'] for r in raw[-60:]) / 60
                    was_bull = ma60 > 0 and pc > ma20 and ma20 >= ma60
                    near_ma20 = ma20 > 0 and ma20 * 0.97 <= c <= ma20 * 1.08
                    near_ma60 = ma60 > 0 and ma60 * 0.97 <= c <= ma60 * 1.08
                    if was_bull and (near_ma20 or near_ma60):
                        wk_score, wk_max, wk_flags = 25, 40, ['✓原本多頭']
                        if near_ma20:
                            wk_score += 15; wk_flags.append('✓月線附近')
                        else:
                            wk_score += 10; wk_flags.append('✓季線附近')
                        wk_max += 30
                        if inst_net_5d >= 0:
                            wk_score += 30; wk_flags.append('✓法人沒跑')
                        else:
                            wk_flags.append('✗法人賣')
                        _yoy = _wk_yoy.get(sym)
                        if _yoy is not None:
                            wk_max += 30
                            if _yoy > 0:
                                wk_score += 30; wk_flags.append(f'✓營收+{_yoy:.0f}%')
                            else:
                                wk_flags.append(f'✗營收{_yoy:.0f}%')
                        wk_pct = round(wk_score / wk_max * 100)
                        if _yoy is None:
                            # 缺營收驗證不給滿分(修「全榜齊 100 分」的虛胖信心)
                            wk_pct = min(wk_pct, 90)
                            wk_flags.append('⚠️營收未驗')
                        if wk_pct >= 50:
                            results['wrongkill'].append({
                                'sym': sym, 'close': round(c, 2), 'chg': round(wk_chg, 1),
                                'score': wk_pct, 'flags': wk_flags, 'ma20': round(ma20, 2)})
            except Exception:
                pass

            bias_20 = (c - ma20) / ma20 if ma20 > 0 else 0
            if bias_20 > 0.15:
                continue

            # 🟢 底部起漲波段股：均線黃金交叉 + 法人不大舉流出（放寬：原 >0 改 >= -5000）
            if ((c > ma20 and pc <= pma20) or (ma5 > ma10 and pma5 <= pma10)) and c > pc and inst_net_5d >= -5000:
                results['bottom'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2), 'bb_upper': round(upper_bb, 2), 'ma5': round(ma5, 2)})

            # 🔥 飆股動能突破股：貼著布林上軌，量增 20%（原 1.3 改 1.2）+ 收紅K + 法人不大流出
            # 📏 逐字稿(4-3 高檔爆量三型):貼上軌但「收黑」= 高檔出貨,不是突破 → 須收紅(收>開)才算真突破
            _o_last = (raw[-1].get('open') if isinstance(raw[-1].get('open'), (int, float)) else c) or c
            if c >= upper_bb * 0.97 and c > _o_last and (rv[-1] > vma5 * 1.2 if rv and vma5 > 0 else False) and inst_net_5d >= -5000:
                results['surge'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2), 'bb_upper': round(upper_bb, 2), 'ma5': round(ma5, 2)})

            # ⚡ 綜合多頭強勢股：放寬為「站上月線 + 5MA > 20MA」+ 量增 10%（原完美四線多排太嚴）
            if (c > ma20 and ma5 > ma20) and c > pc and \
               (rv[-1] > vma5 * 1.1 if rv and vma5 > 0 else False) and inst_net_5d >= -5000:
                results['score'].append({'sym': sym, 'close': round(c, 2), 'ma20': round(ma20, 2), 'bb_upper': round(upper_bb, 2), 'ma5': round(ma5, 2)})
        except Exception:
            continue

    # 妖股依 5 日漲幅排序，最妖在前
    results['monster'].sort(key=lambda x: x.get('gain5d', 0), reverse=True)
    # 🩹 錯殺榜:分數高在前、同分跌深在前,取前 30
    results['wrongkill'].sort(key=lambda x: (-x.get('score', 0), x.get('chg', 0)))
    results['wrongkill'] = results['wrongkill'][:30]
    # 🏦 外資/投信連買榜:3 日買超合計(張)大在前,取 30 檔
    results['foreign3'].sort(key=lambda x: -x.get('sum3', 0)); results['foreign3'] = results['foreign3'][:30]
    results['trust3'].sort(key=lambda x: -x.get('sum3', 0)); results['trust3'] = results['trust3'][:30]
    # 👑 族群領頭羊:每概念取 5 日漲幅前 3 強(成員 ≥3 檔的概念才列,避免一人族群沒意義)
    results['concept_leaders'] = {
        tag: [{'sym': s, 'g5': g, 'close': cl} for s, g, cl in sorted(members, key=lambda x: -x[1])[:3]]
        for tag, members in _cl_acc.items() if len(members) >= 3
    }

    Path(DATA_DIR).mkdir(exist_ok=True)
    Path(DATA_DIR).joinpath('radar.json').write_text(
        json.dumps({'updated': date.today().isoformat(), 'data': results},
                   ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8')

    print(f"  ✅ 雷達：掃描 {processed} 檔，"
          f"底部 {len(results['bottom'])} / 飆股 {len(results['surge'])} / 綜合 {len(results['score'])} / 妖股 {len(results['monster'])} / 錯殺 {len(results['wrongkill'])}"
          f" / 外資連買 {len(results['foreign3'])} / 投信連買 {len(results['trust3'])}")


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
        # 🧩 V71.1.7 解析改走 common.parse_twse_margin_ms(單一真相來源)
        #    —— macro_miner 的「歷史回補」要解同一份 JSON,兩邊各留一份 schema A/B 解析必然漂移。
        total_100m = parse_twse_margin_ms(j)
        if total_100m is None:
            print(f"  ⚠️ [融資MS] {d8} 解析失敗或數字超出合理區間")
            continue
        if offset > 0:
            print(f"  ℹ️ [融資MS] 採用 {try_d.isoformat()} 資料(回退 {offset} 日)")
        return total_100m
    print(f"  ⚠️ [融資MS] 連 {max_fallback_days} 日皆無有效資料")
    return None


def _mark_floor_days(raw, by_date, lookback_rows, pctl=5.0, vol_x=2.0, min_bars=260):
    """⭐ V72.4.9 標記「這一天這檔是不是地板股」,累加進 by_date 的 flr / flrv。

    ⛔ 判定必須跟前端 `_detectFloorBounce` 完全一致(同一套定義,不另立第二份真相):
      乖離 = (收盤 − 20MA) / 20MA;落在「這檔**自己**歷史分布的最低 pctl%」才算。
      ⚠️ 用「相對自己的位階」不是寫死的乖離門檻 —— 台積電跌 8% 跟小型股跌 8% 不是同一件事
      (同 V71.1.6 外資期貨、V71.8.1 波動率的教訓)。

    ⚠️ **不可有前視偏誤**:第 i 天的位階只能用第 0~i 天的乖離去排,⛔ 不能用整段排序。
      這裡用 bisect 維護一個「到今天為止」的排序陣列,插入後再算名次。
    """
    import bisect
    closes, vols, dks = [], [], []
    for r in raw:
        try:
            c = float(r['close'])
            v = float(r.get('volume') or 0)
            d = str(r.get('date') or '')
        except (TypeError, ValueError, KeyError):
            continue
        if c > 0 and d:
            closes.append(c)
            vols.append(v)
            dks.append(d.replace('-', '/'))
    n = len(closes)
    if n < min_bars:
        return
    bias = [None] * n
    run = sum(closes[:20])
    for i in range(19, n):
        if i > 19:
            run += closes[i] - closes[i - 20]
        m = run / 20
        if m > 0:
            bias[i] = (closes[i] - m) / m * 100
    start = max(0, n - lookback_rows)      # 只標最近這段(跟 breadth 回算範圍一致)
    hist = []
    for i in range(n):
        b = bias[i]
        if b is None:
            continue
        bisect.insort(hist, b)             # ⚠️ 先插入,分母才跟 `_detectFloorBounce` 的 hist 一致
        if i < start or len(hist) < 200:
            continue
        if bisect.bisect_left(hist, b) / len(hist) * 100 > pctl:
            continue
        rec = by_date[dks[i]]
        rec['flr'] += 1
        vs = [v for v in vols[max(0, i - 20):i] if v > 0]
        if len(vs) >= 10:
            vma = sum(vs) / len(vs)
            if vma > 0 and vols[i] / vma >= vol_x:
                rec['flrv'] += 1


def build_breadth_history():
    """全市場漲跌家數 → data/breadth.json,**同時回算歷史**(累積騰落線 ADL 的資料源)。
    回傳「今日漲停家數」給 build_bubble_warning 用。

    ⚠️ V71.4.8 為什麼要獨立成一支、而且要排在分點採礦「之前」跑:
      這段原本長在 build_bubble_warning 裡,而 ONLY_CHIPS 流程是
      「分點籌碼(🐢 ~35 分)→ … → 泡沫預警」。
      只要 chips job 在分點那步被砍(逾時、或被新一輪 daily_miner 的
      cancel-in-progress 取消),後面全部不會跑 → breadth.json 就寫不出來。
      這段只讀本地 data/*.json、零 API,沒有理由排在網路重活後面。

    🆕 V71.5.5 **回算歷史(backfill)**,不再「從今天開始累積」:
      使用者明示「要馬上能用,不是等好幾天」。data/{sym}.json 本身就存了 2~3 年日 K
      (2330 有 762 筆、回溯 2023/06),所以每一個過去交易日的漲跌家數都算得出來 ——
      不需要等它一天一天長。實測可回算 303 個交易日(2025/05/07 ~ 2026/07/29,
      檔數 ≥500 的天數),ADL 立刻就有一年以上可看。

      誠實揭露(寫進資料裡的 bf 旗標):
      ・回算只涵蓋「目前還在 data/ 裡的股票」→ 已下市的不算,有倖存者偏誤。
        對 ADL 的**方向**影響很小(每天的 up/dn 都用同一批股票),
        但**絕對水位**不能拿去跟證交所官方歷史家數對比。
      ・當天實跑寫入的那筆(live)優先,回算只補「歷史上缺的日子」,不覆蓋既有值。
    """
    import collections
    LOOKBACK_ROWS = 320        # 夠回算約 300 個交易日
    KEEP_DAYS = 250            # 檔案滾動保留(約一年)
    MIN_TOTAL = 500            # 少於這麼多檔代表資料沒鋪好,不記(避免髒點汙染 ADL)

    # 🆕 V71.5.6 amt = 全市場成交金額(元)= Σ(收盤 × 成交量)。
    #   為什麼要自己加總:^TWII.json 的 volume 一律是 0(證交所 MI_5MINS_HIST 只給 OHLC),
    #   所以「大盤量能」這件事本來完全算不出來 —— 而它是止跌判斷的第一個條件
    #   (2026-07-30 理財達人秀,主持人開場第一個問題就是「今天量能有沒有站回 1 兆」)。
    #   實測驗算:07/29 = 1.129 兆、07/27 = 0.881 兆、07/28 = 0.916 兆
    #   → 跟節目講的「今天站回 1 兆」完全對上,數量級正確。
    #   ⚠️ 這是「上市+上櫃」全市場加總(data/ 兩者都有),不等於證交所公布的「加權指數成交值」
    #      (那只含上市)→ UI 文案必須寫「全市場成交金額」,不可標成加權成交值。
    # ⭐ V72.0.4 多收一個 `chgs`(當日每檔漲跌幅)→ 算「中位數個股漲跌幅」med。
    #   為什麼要:加權指數是**市值加權**,台積電一檔就佔約四成(實測 2,676 檔市值加總
    #   150.7 兆、2330 佔 37.95%)→ 常出現「大盤紅、但多數人手上是綠的」。
    #   ⛔ 我**不去推估官方權重**(官方用流通股數/free float,我只有總股數,推出來會錯);
    #      改用「中位數個股漲跌幅」—— 零假設、零推估,而且它才是「你隨便挑一檔」的真實基準。
    #   ⭐ 這跟 `_SIGNAL_EDGE` 基準勝率只有 36%(不是 50%)是同一件事的一體兩面。
    # ⭐ V72.4.9 多收 flr / flrv =「全市場地板股家數」(權證小哥《哥有籌必爆》S2 第22集 +
    #   兆華艾綸說 2026-07-08:「假如**地板股有大概 100 檔,那大概就是短線的低點**」)。
    #   ⛔ 別跟個股版 `_detectFloorBounce` 混為一談 —— 那張回答「**這一檔**該不該接刀」
    #      (V71.8.9 實測:接刀平均輸大盤);這裡問的是完全不同的問題:「**大盤**跌完了沒」。
    #   定義跟前端 `_detectFloorBounce` 同一套(⛔ 不另立第二份真相):
    #     地板股 = 對 20MA 的乖離落在「這檔自己歷史分布的最低 5%」
    #     flrv 另外要求「當日量 ≥ 20 日均量 × 2」(他強調的「一定要有量」)
    #   📊 `floorcount_probe.py` 實測(2,251 檔 × 486 個交易日,2024-07-30 ~ 2026-07-30):
    #     ・**不看量 ≥300 檔**(n=51 天):後 5/10/20 日加權指數中位 +2.38/+2.99/+4.77%,
    #       邊際 **+1.55/+1.44/+1.45pp**、勝率 67/78/74%(基準 61/64/74%)→ 三天期方向一致 ✅
    #     ・⚠️ **非單調** —— 中間段(50~299 檔)反而是 −0.15~−0.58pp;只有極端那一端有邊際
    #     ・⚠️ 他說的「**有量** 100 檔」在 2 年窗口只出現 **11 天** → 樣本不足,無法驗證
    #     ・⚠️ 窗口整段是多頭(基準 20 日勝率就有 73.6%)→ ⛔ 不可外推到空頭
    #   → 所以前端只在「極端多」時下結論,平時只做事實描述。⛔ 別把它做成連續計分因子。
    by_date = collections.defaultdict(
        lambda: dict(up=0, dn=0, flat=0, lu=0, ld=0, st=0, wk=0, total=0, amt=0.0,
                     chgs=[], flr=0, flrv=0))
    for f in Path(DATA_DIR).glob('*.json'):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()):
            continue
        # 🐛 V71.4.8 排除 4 碼 ETF(0050/0056/0061…):漲跌家數統計的是「公司」,
        #   ETF 是一籃子、本來就跟著指數走,算進去等於把指數自己的方向重複計一次,
        #   會讓廣度略微偏向指數(掩蓋「指數漲但多數個股在跌」—— 而那正是 ADL 要抓的)。
        #   證交所的上漲/下跌家數也不含 ETF。5 碼以上的新 ETF(00878 等)本來就被 len==4 擋掉。
        # ⚠️ ETF 排除只適用「家數」統計;成交金額(amt)不排除 ——
        #   量能看的是市場總周轉,0050 的成交額是真金白銀,排掉會低估。
        #   所以下面把 amt 的累加寫在 is_etf 判斷之外。
        is_etf = sym.startswith('00')
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list) or len(raw) < 2:
                continue
            rows = raw[-LOOKBACK_ROWS:]
            for _a, _b in zip(rows, rows[1:]):
                try:
                    pc = float(_a['close'])
                    c = float(_b['close'])
                    d = str(_b.get('date') or '')
                except Exception:
                    continue
                if pc <= 0 or not d:
                    continue
                dk = d.replace('-', '/')
                try:
                    _v = float(_b.get('volume') or 0)
                except Exception:
                    _v = 0.0
                if _v > 0 and c > 0:
                    by_date[dk]['amt'] += c * _v      # 金額:含 ETF
                if is_etf:
                    continue                          # 家數:排除 ETF
                chg = (c - pc) / pc * 100
                r = by_date[dk]
                if chg >= 9.0:
                    r['lu'] += 1
                elif chg <= -9.0:
                    r['ld'] += 1
                if chg > 0.05:
                    r['up'] += 1
                elif chg < -0.05:
                    r['dn'] += 1
                else:
                    r['flat'] += 1
                if chg >= 3:
                    r['st'] += 1
                elif chg <= -3:
                    r['wk'] += 1
                r['chgs'].append(chg)
                r['total'] += 1
            # ⭐ V72.4.9 地板股判定(⛔ 只算個股,ETF 前面已 continue 掉家數但這裡要自己再擋)
            if not is_etf:
                _mark_floor_days(raw, by_date, LOOKBACK_ROWS)
        except Exception:
            continue

    dates = sorted(by_date)
    if not dates:
        print("  ⏭️ 市場廣度:data/*.json 讀不到任何個股 K 線,本輪不記錄")
        return 0
    # 🐛 V71.5.9 「今天」要取**樣本數足夠的最新交易日**,不能直接用 dates[-1]。
    #   踩到的事(2026-07-30 09:47 那輪):data/ 裡有少數股票已經有 07/30 的盤中列
    #   → dates[-1] = 07/30,但它樣本不足(<500)被 `continue` 略過;
    #     而真正的最新交易日 07/29 就落到「d in have → 跳過」那條路,
    #     保留了上一輪寫的舊列 → **07/29 的成交金額永遠是 0**(前兩天卻是對的,超難察覺)。
    #   通則:任何「今天/最新」的判斷都不能用『資料裡的最大日期』,
    #   要用『通得過品質門檻的最大日期』—— 否則一筆稀疏的部分資料就會把整個判斷帶偏。
    _qualified = [d for d in dates if by_date[d]['total'] >= MIN_TOTAL]
    today_key = _qualified[-1] if _qualified else dates[-1]
    today = by_date[today_key]
    limit_up = today['lu']
    if _qualified and dates[-1] != today_key:
        print(f"  ℹ️ 最新日期 {dates[-1]} 樣本只有 {by_date[dates[-1]]['total']} 檔(<{MIN_TOTAL},"
              f"盤中/部分資料)→ 以 {today_key} 當最新交易日")

    # ⭐ V72.0.4 當日加權指數漲跌% —— 跟 med 存在同一列,前端就不必再 fetch 一次 ^TWII。
    #   ⛔ 別在前端自己算:^TWII.json 有幽靈棒/零量列要過濾,採礦端這裡讀一次就好,
    #      而且「大盤 vs 中位數個股」這條落差線要有歷史才有意義,存進來才回算得到。
    _idx_chg = {}
    try:
        _tw_rows = json.loads((Path(DATA_DIR) / '^TWII.json').read_text(encoding='utf-8'))
        _tw = {}
        for _r in _tw_rows if isinstance(_tw_rows, list) else []:
            try:
                _c = float(_r.get('close') or 0)
                _d = str(_r.get('date') or '').replace('-', '/')
            except (TypeError, ValueError):
                continue
            if _c > 0 and _d:
                _tw[_d] = _c
        _tds = sorted(_tw)
        for _i in range(1, len(_tds)):
            _p = _tw[_tds[_i - 1]]
            if _p > 0:
                _idx_chg[_tds[_i]] = round((_tw[_tds[_i]] - _p) / _p * 100, 2)
    except Exception as _e:
        print(f"  ⚠️ 市場廣度:讀不到 ^TWII 日 K,本輪不寫 idx 欄({str(_e)[:60]})")

    try:
        _bd_path = Path(DATA_DIR) / 'breadth.json'
        _bd = {}
        if _bd_path.exists():
            try:
                _bd = json.loads(_bd_path.read_text(encoding='utf-8')) or {}
            except Exception:
                _bd = {}
        _hist = _bd.get('history')
        if not isinstance(_hist, list):
            _hist = []
        # 既有(實跑寫入)的日期優先,回算只補缺的
        have = {str(h.get('d')) for h in _hist if isinstance(h, dict)}
        added = 0
        _healed = 0
        for d in dates:
            r = by_date[d]
            if r['total'] < MIN_TOTAL:
                continue
            _med = round(statistics.median(r['chgs']), 2) if r['chgs'] else None
            _idx = _idx_chg.get(d)
            _extra = {}
            if _med is not None:
                _extra['med'] = _med
            if _idx is not None:
                _extra['idx'] = _idx
            # ⭐ V72.4.9 地板股家數 —— 照同一條 schema self-heal 通則(陷阱 #15),
            #   歷史列一次補齊,⛔ 不要「從今天開始累積」(使用者鐵則:要馬上就能用)。
            _extra['flr'] = r['flr']
            _extra['flrv'] = r['flrv']
            if d == today_key:
                # 今天這筆一律用最新算出來的覆蓋(同日重跑要能更新)
                _hist = [h for h in _hist if isinstance(h, dict) and str(h.get('d')) != d]
                _hist.append({'d': d, 'amt': round(r['amt'] / 1e8, 1), **_extra,
                              **{k: r[k] for k in ('up', 'dn', 'flat', 'lu', 'ld', 'st', 'wk', 'total')}})
                continue
            if d in have:
                # 🐛 V71.5.9 舊列缺新欄位時要補齊(schema self-heal)。
                #   這是第二次被「新欄位只有往後才有」咬到(第一次是 breadth 本身),
                #   所以做成通則:已存在的日期若缺 amt 而本輪算得出來 → 就地補,
                #   其餘既有數值不動(仍遵守「實跑寫入優先」)。
                #   ⭐ V72.0.4 med(中位數個股漲跌幅)是第三個新欄位,照同一條通則補;
                #      ⛔ 別只補 amt —— 不補的話 med 永遠只有「往後」才有,
                #      而「大盤 vs 中位數個股」的落差圖就永遠畫不出歷史。
                for _h in _hist:
                    if not (isinstance(_h, dict) and str(_h.get('d')) == d):
                        continue
                    if r['amt'] > 0 and not _h.get('amt'):
                        _h['amt'] = round(r['amt'] / 1e8, 1)
                        _healed += 1
                    for _k, _v in _extra.items():
                        if _h.get(_k) is None:
                            _h[_k] = _v
                            _healed += 1
                    break
                continue
            _hist.append({'d': d, 'bf': 1, 'amt': round(r['amt'] / 1e8, 1), **_extra,
                          **{k: r[k] for k in ('up', 'dn', 'flat', 'lu', 'ld', 'st', 'wk', 'total')}})
            added += 1
        if today['total'] < MIN_TOTAL and added == 0:
            print(f"  ⏭️ 市場廣度只算到 {today['total']} 檔(<{MIN_TOTAL}),且無歷史可補,本輪不記錄")
            return limit_up
        _hist.sort(key=lambda x: str(x.get('d') or ''))
        _hist = _hist[-KEEP_DAYS:]
        _bd_path.write_text(json.dumps(
            {'updated': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M'),
             'history': _hist}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        _adl = 0
        for h in _hist:
            _adl += (h.get('up') or 0) - (h.get('dn') or 0)
        print(f"  📊 市場廣度 {today_key}:漲 {today['up']} / 跌 {today['dn']} / 漲停 {limit_up}"
              f" / 跌停 {today['ld']}(共 {today['total']} 檔)"
              f"・成交金額 {today['amt'] / 1e12:.3f} 兆"
              + (f"・中位數個股 {statistics.median(today['chgs']):+.2f}%" if today['chgs'] else ''))
        print(f"     → breadth.json 共 {len(_hist)} 日"
              f"(本輪回算補了 {added} 日歷史"
              f"{f'、補齊 {_healed} 個舊列缺的欄位(成交金額/中位數漲跌幅)' if _healed else ''})"
              f"・累積騰落線 ADL = {_adl:+,}")
    except Exception as _e:
        print(f"  ⚠️ 市場廣度歷史寫入失敗(不影響其他):{str(_e)[:80]}")
    return limit_up


def _themes_from_pro():
    """🎯 從 pro.html 的 PRO.THEMES 讀題材表(V74.3.5)。

    ⭐ 題材表**全 App 只有一份**(pro.html),這裡用 regex 讀 —— ⛔ 不在 python 再寫第二份
      (陷阱 #37:兩份名單遲早只改到一邊)。pro.html 那段的註解有寫「改格式要同步改這支」。
    ⛔ 為什麼不用 concept_stocks.json(megatime):實測那張表過期 ——
      231 個群組裡沒有矽光子/CPO、沒有散熱液冷、沒有記憶體,還留著元宇宙/五倍券。
    回傳 ({key:[syms]}, {key:題材名});讀不到 → (None, None) 並印原因,
    呼叫端**整個 themes 鍵不寫**(⛔ 不可寫空的 —— 前端要分得出「還沒產出」跟「空」)。
    """
    try:
        import re as _re
        p = Path(__file__).resolve().parent / 'pro.html'
        s = p.read_text(encoding='utf-8')
        i = s.index('THEMES: [')
        blk = s[i:s.index('],', i) + 2]
        groups, names = {}, {}
        for m in _re.finditer(r"\{\s*k:\s*'([a-z0-9_]+)',\s*n:\s*'([^']+)',\s*syms:\s*\[([^\]]*)\]", blk):
            syms = _re.findall(r"'(\d{4,5})'", m.group(3))
            if syms:
                groups[m.group(1)] = syms
                names[m.group(1)] = m.group(2)
        # 🚧 空過守門:regex 跟 pro.html 格式脫鉤時要**當場看得出來**,⛔ 不可默默回空
        n_sym = sum(len(v) for v in groups.values())
        if len(groups) < 10 or n_sym < 50:
            print(f'  ⚠️ 題材表只解析到 {len(groups)} 個題材 / {n_sym} 檔(門檻 10/50)→ 視同讀不到,themes 不產出')
            return None, None
        return groups, names
    except Exception as _e:
        print(f'  ⚠️ 題材表讀取失敗(themes 不產出):{str(_e)[:100]}')
        return None, None


def build_sector_rotation():
    """💧 板塊輪動歷史 → data/sector_rot.json(零 API,只讀本地 data/*.json)。

    ⭐ 為什麼是「20 日報酬」而不是「錢流」——`scripts/sector_rotation_probe.mjs` 實測
      (1,087 檔上市股 × 33 產業 × 775 個交易日,主判準「前 3 產業 − 後 3 產業」的
       未來報酬價差,扣同期加權):

        ① 價格動能(N 日報酬)   20 日窗口 → 未來 20 日 **+1.44pp** ✅ 四關全過
                               (前半 +1.28 / 後半 +1.58、逐年 +0.9/+1.4/+1.2/+2.2)
        ② 外資淨流入金額       最好也只有 +0.83pp,而且**去最好年只剩 +0.40**、
                               20 日窗口那格前後半**不同向** ❌
        ③ 外資買超佔成交額比   ±0.2pp 內,大多數格子前後半不同向 ❌
        ④ 成交額佔比的變化     ≈0 甚至是負的 ❌
                               ⛔⛔ 這正是最直覺、最好做動畫的那個「錢在板塊間搬家」——
                                  **實測完全沒有預測力**,所以⛔ 不可拿它當訊號。

      ⭐ 而且邊際是**不對稱**的:20 日窗口那格,前 3 名相對全產業平均只有 **+0.63pp**,
        後 3 名卻是 **−0.80pp** → **避開最弱的板塊比追最強的板塊更有價值**。

    ⛔ 誠實限制:`industry_map.json` 只涵蓋**上市**(1,087 檔)→ 這是「上市板塊輪動」。
       上櫃股沒有官方產業別,⛔ 不可宣稱是全市場。

    輸出(滾動 120 個交易日,約 30KB):
      {updated, days:[日期], ind:{產業碼:{n:成分股數, r20:[每日 20 日報酬中位 %],
                                          fi5:[每日 近5日外資淨流入 億元]}}}
    ⚠️ `fi5` 是**描述用**(讓使用者看得到「外資錢往哪流」這件事),
       ⛔ 但實測它排不出有效順序 → 前端不可拿它排名或下多空(測試釘住)。
    """
    KEEP = 120          # 滾動保留的交易日
    WIN = 20            # 動能窗口(實測最佳實用值)
    FIWIN = 5
    MIN_MEMB = 5        # 該產業當天至少要有這麼多檔算得出報酬(⛔ 1~2 檔就能決定 = 沒意義)
    MIN_IND = 20        # 當天至少要有這麼多個產業算得出來才收這一天
    try:
        _dir = Path(DATA_DIR)
        _map_p = _dir / 'industry_map.json'
        if not _map_p.exists():
            print('  ⏭️ 板塊輪動:沒有 industry_map.json,略過')
            return
        ind_of = json.loads(_map_p.read_text(encoding='utf-8'))
        # 🎯 題材板塊(V74.3.5):同一趟掃描順便算 —— 分組定義讀 pro.html(單一來源)。
        #    一檔可屬多個題材;題材成員可含上櫃股(它們沒有官方產業別,只進題材那組)。
        th_groups, th_names = _themes_from_pro()
        th_of = {}
        if th_groups:
            for _tk, _ss in th_groups.items():
                for _s in _ss:
                    th_of.setdefault(_s, []).append(_tk)
        # (kind, 分組鍵) → 日期 → {rets:[], f/t/dl/mg:元};kind = 'i' 官方產業 / 't' 題材
        agg = {}
        n_sym = 0
        need = KEEP + WIN + 5
        for sym in sorted(set(ind_of) | set(th_of)):
            grp_keys = ([('i', ind_of[sym])] if sym in ind_of else []) + \
                       [('t', _tk) for _tk in th_of.get(sym, ())]
            p = _dir / f'{sym}.json'
            if not p.exists():
                continue
            try:
                rows = json.loads(p.read_text(encoding='utf-8'))
            except Exception:
                continue
            if not isinstance(rows, list) or len(rows) < 40:
                continue
            rows = [r for r in rows if isinstance(r, dict) and r.get('close') not in (None, '')][-need:]
            if len(rows) < 25:
                continue
            n_sym += 1
            prev = None
            prev_mb = None
            for r in rows:
                try:
                    c = float(r['close'])
                except Exception:
                    prev = None
                    continue
                d = str(r.get('date') or '').replace('/', '-')
                if prev and prev > 0 and c > 0 and d:
                    # ⭐ 每檔每天只算一次,再加進它所屬的每一組(官方產業 + 題材)
                    _adds = {'f': 0.0, 't': 0.0, 'dl': 0.0, 'mg': 0.0}
                    _ret = (c / prev - 1) * 100
                    # 💰 V74.7.5 每日成交額(收盤 × 成交股數 = 元)—— ⭐ 零額外成本,
                    #    close 與 volume 本來就在同一筆裡。⛔ 以前沒存 → 前端熱力圖的
                    #    磚面積只能固定在最新一天、拉時間軸不會回放(使用者回報的第 3 點)。
                    try:
                        _amt = float(r.get('volume') or 0) * c
                    except Exception:
                        _amt = 0.0
                    # 👥 三大法人(股 × 收盤 = 元)
                    for _k, _fld in (('f', 'foreign_net'), ('t', 'trust_net'), ('dl', 'dealer_net')):
                        try:
                            _adds[_k] += float(r.get(_fld) or 0) * c
                        except Exception:
                            pass
                    # 💳 融資餘額變化(散戶槓桿代理)—— ⚠️ margin_balance 是**張**,要 ×1000 換成股
                    #    ⛔ 這裡刻意**不用「−(三大法人)」當散戶** —— 那是恆等式不是資料
                    #       (每一股都有買賣雙方 → 非三大法人淨額必然等於三大法人的相反數),
                    #       畫出來會是完美鏡像、零資訊,而且那個「非三大」還包含主力/公司派/ETF。
                    try:
                        _mb = float(r.get('margin_balance') or 0)
                        if prev_mb is not None and _mb:
                            _adds['mg'] += (_mb - prev_mb) * 1000 * c
                        if _mb:
                            prev_mb = _mb
                    except Exception:
                        pass
                    for _gk in grp_keys:
                        o = agg.setdefault(_gk, {}).setdefault(
                            d, {'rets': [], 'f': 0.0, 't': 0.0, 'dl': 0.0, 'mg': 0.0, 'amt': 0.0})
                        o['rets'].append(_ret)
                        o['amt'] += _amt
                        for _k in ('f', 't', 'dl', 'mg'):
                            o[_k] += _adds[_k]
                prev = c
        if not agg:
            print('  ⏭️ 板塊輪動:一個產業都算不出來,略過')
            return
        # 每天每組的中位漲跌幅 —— 官方產業與題材分開存
        # ⚠️ 題材成員少(機殼 3 檔),MIN_MEMB 用 3;官方產業維持 5,⛔ 兩個別互換
        MIN_MEMB_TH = 3
        per = {}            # d -> {產業碼: (medret, 流)}(官方,決定 days)
        per_th = {}         # d -> {題材鍵: (medret, 流)}
        for (_kind, _g), m in agg.items():
            _tgt = per if _kind == 'i' else per_th
            _min = MIN_MEMB if _kind == 'i' else MIN_MEMB_TH
            for d, o in m.items():
                if len(o['rets']) < _min:
                    continue
                _tgt.setdefault(d, {})[_g] = (statistics.median(o['rets']),
                                              {k: o[k] for k in ('f', 't', 'dl', 'mg')},
                                              o.get('amt', 0.0))
        days = sorted(d for d, v in per.items() if len(v) >= MIN_IND)
        if len(days) < WIN + 10:
            print(f'  ⏭️ 板塊輪動:可用交易日只有 {len(days)} 天(需 >{WIN + 10}),略過')
            return
        keep = days[-(KEEP + WIN):]
        out_days = keep[WIN:]                       # 前 WIN 天只當暖身,不輸出
        def _series(_per, _kind):
            """同一套滾動窗口邏輯,官方產業與題材共用(⛔ 不複製第二份)。"""
            _out = {}
            for _g in sorted({i for d in keep for i in _per.get(d, {})}):
                r20 = []
                amt = []                            # 💰 每日成交額(億元)—— 給前端熱力圖的磚面積
                flow = {k: [] for k in ('f', 't', 'dl', 'mg')}
                for k, d in enumerate(out_days):
                    win = keep[k + 1:k + 1 + WIN]   # 到 d 為止(含)的 WIN 天
                    vals = [_per[x][_g][0] for x in win if x in _per and _g in _per[x]]
                    r20.append(round(sum(vals), 2) if len(vals) >= WIN - 2 else None)
                    # 👥 四條資金流:**每日**淨額(億元)—— 讓前端自己決定要疊幾天
                    _c = _per.get(d, {}).get(_g)
                    for _k in flow:
                        flow[_k].append(round(_c[1][_k] / 1e8, 2) if _c else None)
                    amt.append(round(_c[2] / 1e8, 2) if (_c and len(_c) > 2) else None)
                # ⛔ 整段都算不出來的組不輸出(⛔ 不留一排 null 讓前端顯示空殼)
                if not any(v is not None for v in r20):
                    continue
                n_memb = max((len(o['rets']) for o in agg.get((_kind, _g), {}).values()), default=0)
                _out[_g] = {'n': n_memb, 'r20': r20, 'amt': amt, 'flow': flow}
            return _out
        out_ind = _series(per, 'i')
        out_th = _series(per_th, 't') if th_groups else {}
        if len(out_ind) < MIN_IND:
            print(f'  ⏭️ 板塊輪動:只有 {len(out_ind)} 個產業算得出來(<{MIN_IND}),不覆寫舊檔')
            return
        _doc = {'updated': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M'),
                'win': WIN, 'listed_only': True,
                'flow_keys': {'f': '外資', 't': '投信', 'dl': '自營', 'mg': '融資(散戶代理)'},
                'days': out_days, 'ind': out_ind}
        # 🎯 題材板塊:解析失敗/算不出來 → **整個鍵不寫**,前端顯「還沒產出」(陷阱 #22)
        if out_th:
            _doc['themes'] = out_th
            _doc['theme_names'] = th_names
        (_dir / 'sector_rot.json').write_text(json.dumps(
            _doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        _last = out_days[-1]
        _rank = sorted(((v['r20'][-1], k) for k, v in out_ind.items() if v['r20'][-1] is not None),
                       reverse=True)
        print(f'  💧 板塊輪動 {_last}:{len(out_ind)} 個產業 + {len(out_th)} 個題材 × {len(out_days)} 個交易日'
              f'(母體 {n_sym} 檔)')
        if _rank:
            print(f'     → 最強 {_rank[0][1]} {_rank[0][0]:+.1f}% / 最弱 {_rank[-1][1]} {_rank[-1][0]:+.1f}%(近 {WIN} 日)')
    except Exception as _e:
        print(f'  ⚠️ 板塊輪動寫入失敗(不影響其他):{str(_e)[:120]}')


def build_stock_tags():
    """🏷️ 個股題材標籤 → data/stock_tags.json(零 API,只讀本地 data/*.json)。V74.4.8

    ⭐ 為什麼要做:使用者看南亞科(2408)的標籤是
      「#台塑 #Windows11 #美中貿易戰受惠 #蘋果供應商 #Smart TV」——
      **一個跟記憶體有關的都沒有**。真因是 `concept_stocks.json`(megatime)
      雖然每天抓、`updated` 是今天,但**上游的題材定義本身凍結在 2021 年左右**:
      231 個群組裡沒有記憶體/CPO/散熱液冷/ASIC,卻還留著 Google眼鏡/iPad Pro/五倍券。
      → 這正是 CLAUDE.md「寫死的對照表沒有更新機制就會過期」那條的現行犯。

    ⭐⭐ 做法(這是本檔最重要的設計決定):
      **題材「定義」是人工的(pro.html PRO.THEMES,17 個題材 76 檔),
        但題材「成員」每天自動重算** —— 兩件事要分開看。
      自動擴散的判準是 **扣掉大盤之後的殘差相關**(近 120 個交易日):
        殘差 = 個股日報酬 − 大盤日報酬
        題材殘差 = 該題材成員殘差的**中位數**(⛔ 算某一檔時要把它自己從中位數裡拿掉,
                   否則種子成員會拿到灌水的自我相關)
        相關 ≥ 門檻 → 標成「連動」
    ⛔ 為什麼一定要扣大盤:不扣的話多頭行情裡**每一檔都跟每一個題材高度相關**,
       標籤會變成「大家都一樣」= 零鑑別度(同 V72.5.2「活躍度不是方向」的同型錯誤)。

    ⛔ 門檻用**當天分布的分位數**(P90)而不是寫死一個數字,並設 0.45 下限;
       兩個數字都寫進輸出讓人查得到(本專案已犯過太多次「憑空訂門檻」)。

    ⚠️⚠️ **誠實限制(⛔ 前端文案不可省略)**:
      ① 這是「**這檔最近跟哪一族走得最像**」,⛔ **不是**「這檔的業務屬於這個題材」——
         台股沒有免費的結構化「主要產品/營收比重」來源(V72 已實測:TWSE/TPEX
         公司基本資料只有產業別,沒有業務說明欄位)。
      ② 種子成員(人工確認)與自動連動要**分開標**,⛔ 不可長得一樣。
      ③ **大型權值股會抓不到** —— 台積電佔大盤約四成,它的「殘差」幾乎等於
         「大盤扣掉自己」的相反數 → 跟所有題材都是 0 或負相關(實測 2330 最佳只有 +0.05)。
         這是方法的結構限制,⛔ 不是資料壞掉;那種股票靠種子表與產業別涵蓋。
      ④ 相關性是**同期**的(V73 評估紀錄⑧的鐵則)→ ⛔ 只能拿來分類,不可拿來預測。

    ✅ 實測(2026-08-31,2,304 檔算得出殘差):最佳相關中位 0.28、P90 0.43、P95 0.51。
       門檻 0.45 → 約 190 檔拿得到題材標籤。前段班抽驗全部正確而且**都是種子沒收的**:
       2630 亞航→軍工 0.90・6215 和椿→機器人 0.78・2208 台船→軍工 0.76・
       7402 龍德造船→軍工 0.76・1514 亞力→重電 0.75・2375 智寶→被動元件 0.75・
       3189 景碩→ABF載板 0.69・3081 聯亞→光通訊 0.72・2451 創見→記憶體 0.54。

    👑 順便自動算**龍頭**(近 20 日成交值中位數最大的那一檔)——
       ⭐ 這是為了取代 index.html 裡寫死的 `_LEADER_MAP`(那張表同樣會過期)。
    """
    WIN = 120           # 相關性窗口(交易日)
    MIN_OVERLAP = 60    # 至少要有這麼多天對得起來才算
    MIN_MEMB = 3        # 題材至少要有這麼多檔算得出殘差
    THR_FLOOR = 0.45    # 門檻下限(⛔ 分位數再低也不放行)
    TOP_N = 2           # 一檔最多幾個「連動」題材
    try:
        _dir = Path(DATA_DIR)
        th_groups, th_names = _themes_from_pro()
        if not th_groups:
            print('  ⏭️ 個股題材標籤:讀不到題材表,略過(⛔ 不寫空檔)')
            return

        def _rows(sym, need):
            p = _dir / f'{sym}.json'
            if not p.exists():
                return None
            try:
                rows = json.loads(p.read_text(encoding='utf-8'))
            except Exception:
                return None
            if not isinstance(rows, list):
                return None
            rows = [r for r in rows if isinstance(r, dict) and r.get('close') not in (None, '')]
            return rows[-need:] if len(rows) >= MIN_OVERLAP + 1 else None

        mk = _rows('^TWII', WIN + 1)
        if not mk:
            print('  ⏭️ 個股題材標籤:沒有加權指數,略過')
            return
        mret, _md = {}, [str(r['date']).replace('/', '-')[:10] for r in mk]
        for j in range(1, len(mk)):
            try:
                mret[_md[j]] = float(mk[j]['close']) / float(mk[j - 1]['close']) - 1
            except Exception:
                pass

        # 個股母體:4 碼純數字且非 00 開頭(⛔ 排除 ETF/權證/特別股 —— 使用者明示 ETF 不加)
        cand = sorted({f[:-5] for f in os.listdir(_dir) if f.endswith('.json')}
                      & {f'{i}' for i in range(1000, 10000)})
        cand = [s for s in cand if not s.startswith('00')]
        resid, amt20, data_date = {}, {}, ''
        for sym in cand:
            rows = _rows(sym, WIN + 1)
            if not rows:
                continue
            out, amts = {}, []
            for j in range(1, len(rows)):
                d = str(rows[j]['date']).replace('/', '-')[:10]
                if d > data_date:
                    data_date = d
                if d not in mret:
                    continue
                try:
                    c0, c1 = float(rows[j - 1]['close']), float(rows[j]['close'])
                    r = c1 / c0 - 1
                except Exception:
                    continue
                if abs(r) > 0.5:      # ⛔ 分割/減資殘留的斷崖不可當報酬(陷阱 #21)
                    continue
                out[d] = r - mret[d]
                try:
                    amts.append(c1 * float(rows[j].get('volume') or 0))
                except Exception:
                    pass
            if len(out) >= MIN_OVERLAP:
                resid[sym] = out
                a = sorted(amts[-20:])
                if a:
                    amt20[sym] = a[len(a) // 2]

        def _med(a):
            a = sorted(a)
            n = len(a)
            return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2

        def _theme_series(k, excl=None):
            ms = [resid[x] for x in th_groups[k] if x in resid and x != excl]
            if len(ms) < MIN_MEMB:
                return None
            ds = set(ms[0])
            for m in ms[1:]:
                ds &= set(m)
            if len(ds) < MIN_OVERLAP:
                return None
            return {d: _med([m[d] for m in ms]) for d in ds}

        def _corr(a, b):
            ds = [d for d in a if d in b]
            if len(ds) < MIN_OVERLAP:
                return None
            xa = [a[d] for d in ds]
            xb = [b[d] for d in ds]
            ma, mb = sum(xa) / len(xa), sum(xb) / len(xb)
            num = sum((p - ma) * (q - mb) for p, q in zip(xa, xb))
            da = math.sqrt(sum((p - ma) ** 2 for p in xa))
            db = math.sqrt(sum((q - mb) ** 2 for q in xb))
            return None if da * db == 0 else num / (da * db)

        base = {k: _theme_series(k) for k in th_groups}
        base = {k: v for k, v in base.items() if v}
        # 🧲 題材「內聚度」= 種子成員**兩兩之間**的平均相關。
        #   ⭐ 這是擴散的前提:成員自己都不一起動的話,那個中位數就是雜訊,
        #     任何「跟它很像」的比對都是假的 → 內聚度太低就**只留種子、不擴散**。
        #   實測(2026-08-31):軍工 0.67 / 玻纖布 0.65 / 矽晶圓 0.62 / 被動元件 0.61 …
        #     但 **晶圓代工 0.07 ・網通 0.07 ・電源 0.13** —— 那幾組本來就不同步
        #     (晶圓代工那組有台積電,而它幾乎等於大盤本身 → 殘差近 0)。
        #   ⛔ 內聚度要**寫進輸出**讓前端顯示,不可只在後台判斷(使用者才知道這個標籤有多可信)。
        COH_MIN = 0.20
        coh = {}
        for k in base:
            ms = [x for x in th_groups[k] if x in resid]
            cs = []
            for i in range(len(ms)):
                for j in range(i + 1, len(ms)):
                    c = _corr(resid[ms[i]], resid[ms[j]])
                    if c is not None:
                        cs.append(c)
            coh[k] = round(sum(cs) / len(cs), 3) if cs else None
        if len(base) < 5:
            print(f'  ⏭️ 個股題材標籤:只有 {len(base)} 個題材算得出序列,略過(⛔ 不寫半套)')
            return
        # 每檔對每個題材算相關(自己是成員時把自己從題材中位數裡拿掉)
        allc, best = {}, []
        for sym, r in resid.items():
            cs = []
            for k in base:
                t = _theme_series(k, sym) if sym in th_groups[k] else base[k]
                if not t:
                    continue
                c = _corr(r, t)
                if c is not None:
                    cs.append((round(c, 3), k))
            if cs:
                cs.sort(reverse=True)
                allc[sym] = cs
                best.append(cs[0][0])
        if not best:
            print('  ⏭️ 個股題材標籤:一檔都算不出相關,略過')
            return
        best.sort()
        p90 = best[int(len(best) * 0.90)]
        thr = round(max(THR_FLOOR, p90), 3)

        by_stock, theme_memb = {}, {k: set(th_groups[k]) for k in base}
        for sym, cs in allc.items():
            seed = [k for k in base if sym in th_groups[k]]
            near = [[k, c] for c, k in cs
                    if c >= thr and k not in seed and (coh.get(k) or 0) >= COH_MIN][:TOP_N]
            for k, _c in near:
                theme_memb[k].add(sym)
            if seed or near:
                by_stock[sym] = {'s': seed, 'n': near}
        # 👑 龍頭 = 該題材**種子成員**裡近 20 日成交值中位數最大的(⭐ 自動更新,取代寫死的對照表)
        # ⛔ 兩條不可改掉:
        #   ① **只從種子挑**,⛔ 不可把自動連動進來的也算 —— 實測 3081 聯亞(光通訊股)
        #      靠 0.454 勉強連動進「低軌衛星」,又剛好成交值最大 → 被封成「低軌衛星龍頭」。
        #      龍頭是**身分**,只能由人工確認過的名單產生。
        #   ② key 用**題材**不是股票代號 —— 一檔可能是兩個題材的第一名,
        #      用代號當 key 會被後面那個蓋掉(實測矽光子的龍頭就這樣消失了)。
        lead = {}
        for k in base:
            ranked = sorted(((amt20.get(x, 0), x) for x in th_groups[k] if x in amt20), reverse=True)
            if ranked and ranked[0][0] > 0:
                lead[k] = ranked[0][1]
        doc = {
            'updated': datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds'),
            'data_date': data_date, 'win': WIN, 'thr': thr, 'p90': round(p90, 3),
            'universe': len(resid),
            'names': {k: th_names.get(k, k) for k in base},
            'seed': {k: th_groups[k] for k in base},
            'coh': coh, 'coh_min': COH_MIN,
            'by_stock': by_stock, 'lead': lead,
        }
        (_dir / 'stock_tags.json').write_text(json.dumps(
            doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        n_near = sum(1 for v in by_stock.values() if v['n'])
        _noexp = [th_names.get(k, k) for k in base if (coh.get(k) or 0) < COH_MIN]
        print(f'  🏷️ 個股題材標籤 {data_date}:母體 {len(resid)} 檔 ・門檻 {thr}(當日 P90={p90:.3f})'
              f' → {len(by_stock)} 檔有標籤(其中 {n_near} 檔是自動連動出來的)・龍頭 {len(lead)} 檔')
        if _noexp:
            print(f'     ⚠️ 內聚度 <{COH_MIN} 只留種子不擴散:{"・".join(_noexp)}(成員自己就不同步,擴散出來的會是雜訊)')
    except Exception as _e:
        print(f'  ⚠️ 個股題材標籤寫入失敗(不影響其他):{str(_e)[:120]}')


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
        abs_status = '⛔ 極度危險' if total_100m > 3200 else '⚠️ 警戒' if total_100m > 2800 else '✅ 健康'
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
    # 📊 V71.3.8 順手把「市場廣度」整組算出來並存歷史。
    #
    #   為什麼要存歷史(使用者問「廣度要不要跟前一天比」):
    #   ・前端的廣度卡是「當下快照」——今天上漲幾家、下跌幾家,看完就沒了。
    #   ・真正有用的是**累積騰落線(ADL)**:每天把 (上漲家數 − 下跌家數) 累加起來畫成一條線。
    #     指數創新高、但 ADL 沒跟著創新高 = 只有權值股在撐、多數股票已經在跌 = 頂部背離,
    #     這是機構在用的經典領先訊號,單看「今天 vs 昨天」看不出來。
    #   ・沒有歷史就永遠算不出這條線,所以從今天開始存(滾動 250 個交易日 ≈ 1 年)。
    #
    #   為什麼放在這個迴圈:它本來就已經走訪全市場每一檔的最新兩根 K 棒算漲停家數,
    #   順便統計上漲/下跌/跌停/強弱勢是零成本(不多打任何一次 API)。
    #   而且用的是**收盤價**,比前端那份 15:41 的盤中快照更準。
    limit_up = build_breadth_history()
    # 💧 板塊輪動歷史(零 API,只讀本地 data/*.json)
    # ⛔ 跟上面那支**各自獨立**呼叫 —— 綁在同一個 try/if 裡的話,一個失敗會拖累另一個
    #    (V72.2.1 market_stats 的 pb 拖垮 margin 就是這樣,而且全綠零錯誤訊息)。
    build_sector_rotation()
    # 🏷️ 個股題材標籤(零 API,只讀本地 data/*.json)—— ⛔ 同樣獨立呼叫,不綁在別人的 try 裡
    build_stock_tags()
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
            # 🚨🚨 V76.1.6 這段的「量」以前只讀 `volume` —— 而**指數的 volume 是 0**(陷阱 #29,
            #   資料源不給指數成交量)。實測 origin/gh-pages:macro_cache.json 的 twii_history
            #   **120 根 volume 全部是 0** → avg_v=0 → vol_ratio 掉進 fallback **恆為 1.0**
            #   → 「爆量長上影」「上影警示」兩個等級的**量那條腿,從上線到現在一次都不可能觸發**,
            #      而且沒有任何 *_error 說出來(陷阱 #22)。前端兩處在顯示它。
            #   ⭐ 修法:改吃 amount(元,證交所官方集中市場成交值)→ mkt_vol(股數)→ volume 三層。
            #   ⛔ 照陷阱 #17:**整條序列用同一個欄位**(今日與基準必須同尺),不可今日 amount、基準 volume。
            def _vseries(key):
                vals = [float(t.get(key, 0) or 0) for t in twii_hist]
                return vals if all(x > 0 for x in vals[-6:]) and len(vals) >= 6 else None
            _vkey, _vals = None, None
            for _k in ('amount', 'mkt_vol', 'volume'):
                _vals = _vseries(_k)
                if _vals:
                    _vkey = _k
                    break
            vol_ratio, vol_err = None, None
            if _vals:
                past5 = _vals[-6:-1]
                avg_v = sum(past5) / len(past5)
                vol_ratio = (_vals[-1] / avg_v) if avg_v > 0 else None
            if vol_ratio is None:
                vol_err = '指數資料源不給成交量(amount/mkt_vol/volume 都取不到)'

            # ⛔ 量算不出來時,含「量」的那兩個等級整條不判(只用上影線),
            #    ⛔ 不可再用 1.0 假裝「量能正常」—— 那會讓卡片天天顯「多頭整理」= 拿常數當訊號。
            _vr = vol_ratio if vol_ratio is not None else None
            if shadow_ratio >= 0.4 and _vr is not None and _vr >= 1.3:
                lbl, lvl, dsc = '⚠️ 爆量長上影', 'red', '主力高檔派發'
            elif shadow_ratio >= 0.3 or (_vr is not None and _vr >= 1.5):
                lbl, lvl, dsc = '⚠️ 上影警示', 'orange', '上檔有壓力'
            elif c >= o and shadow_ratio < 0.2:
                lbl, lvl, dsc = '✅ 健康收紅', 'gray', '量價穩健'
            else:
                lbl, lvl, dsc = '🟢 多頭整理', 'gray', '盤面平穩'
            out['kline_status'] = {
                'label': lbl, 'level': lvl, 'desc': dsc,
                'shadow_ratio': round(shadow_ratio, 2),
                'vol_ratio':    (round(vol_ratio, 2) if vol_ratio is not None else None),
                'vol_src':      _vkey,
            }
            if vol_err:
                out['kline_status']['vol_error'] = vol_err
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
    'ai_core':  {'icon': '🖥️', 'name': 'AI 核心硬體', 'syms': ['2382', '6669', '3017', '3324', '3653', '3081', '3450', '3363', '2330', '3711', '3131']},
    'power':    {'icon': '⚡', 'name': '重電與基建',  'syms': ['1519', '1503', '1513']},
    'finance':  {'icon': '🛡️', 'name': '金融與避風港','syms': ['2881', '2882', '2891', '2886']},
}
SUB_SECTORS = {
    'us':        ['2330', '3711'],
    'server':    ['2382', '6669', '3231'],
    'power':     ['1519', '1503', '1513'],
    'packaging': ['2330', '3711', '3131'],
    'cpo':       ['3081', '3450', '3363'],
    'cooling':   ['3017', '3324', '3653'],
    'robot':     ['2359', '6188', '1568'],
    'finance':   ['2881', '2882', '2891'],
    'leo':       ['3491', '2313', '6285'],
    'dram':      ['2408', '2344', '8299'],   # 💾 記憶體 DRAM:南亞科/華邦電/群聯
    # 🆕 V69.5.0 新增熱門板塊(前端 _sectorStocks 對齊)
    'defense':   ['2634', '8033', '6753'],   # 🎖️ 軍工國防:漢翔/雷虎/龍德造船
    'wafer':     ['6488', '5483', '6182'],   # 🧊 矽晶圓:環球晶/中美晶/合晶
    'pcb':       ['3037', '8046', '3189'],   # 🔲 PCB/載板:欣興/南電/景碩
    'asic':      ['3661', '3443', '6533'],   # 🧠 ASIC矽智財:世芯/創意/晶心科
    'security':  ['6690', '3029', '6214'],   # 🛡️ 資安:安碁資訊/零壹/精誠
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
    """篩選:基本面(YoY>0) + 法人5日淨流入>0。
    🗑️ V79.0.0 第三維「分點集中度」已移除(券商分點停了,chips 檔只剩 fundamentals)→ concentration 恆 0。"""
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

            # 🗑️ V79.0.0 分點集中度那一維已移除(券商分點停了)→ 只剩 YoY + 法人兩維,⛔ 不再貼「分點集中」標籤

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


def cleanup_weekend_rows():
    """一次性掃 data/*.json,移除 date 為週六/週日的紀錄(MIS 快照跨午夜跑時被誤標的污染)。
    Idempotent — 每次跑都安全,沒污染時就不動。"""
    data_dir = Path(DATA_DIR)
    if not data_dir.exists():
        return
    cleaned_files = 0
    cleaned_rows = 0
    for f in data_dir.glob('*.json'):
        if f.name in ('radar.json', 'top_picks.json', 'broker_names.json',
                      'industry_pe.json', 'industry_map.json', 'fundamentals_cache.json',
                      'attention_status.json', 'sector_heat.json', 'bubble_warning.json',
                      'signal_history.json', 'strategy_backtest.json', 'paper_trades.json',
                      'combo_backtest.json', 'walk_forward.json', 'radar_news.json',
                      'macro_risk.json'):
            continue
        try:
            arr = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(arr, list):
                continue
            kept = []
            removed = 0
            for r in arr:
                d_str = r.get('date', '') if isinstance(r, dict) else ''
                if not d_str:
                    kept.append(r)
                    continue
                try:
                    dt = datetime.strptime(d_str.replace('-', '/'), '%Y/%m/%d').date()
                    if dt.weekday() >= 5:
                        removed += 1
                        continue
                except Exception:
                    pass
                kept.append(r)
            if removed > 0:
                f.write_text(json.dumps(kept, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                cleaned_files += 1
                cleaned_rows += removed
        except Exception:
            pass
    if cleaned_rows > 0:
        print(f"  🧹 清掉週末污染紀錄:{cleaned_rows} 筆橫跨 {cleaned_files} 個股檔")


def _safe_step(label, fn, *args, **kwargs):
    """執行一個「彼此獨立」的採礦步驟。任一步失敗只記錄 traceback 並回 None,
    不讓單一步驟的例外中斷後續獨立步驟(避免一步掛掉就讓雷達/選股 JSON 全部停更變舊值)。"""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        print(f"  ⚠️ 步驟「{label}」失敗,已跳過並續跑後續:{type(e).__name__}: {e}")
        traceback.print_exc()
        return None


# ═══ 💾 V74.6.9 「現在不存,以後永遠測不了」的三類資料 ═══
# 使用者:「都做」。⭐ 動機:K 線可以回補,但**每日快照類**的資料一旦沒存就再也拿不回來
#   —— 鉅額交易、借券餘額、融資限額 都屬於這一類(CLAUDE.md 多處寫著「想做要先開始存」)。
# ⛔ 共用同一支 `_snap_hist`,⛔ 不寫三份(陷阱 #37:三份實作遲早只改到一份)。
SNAP_HIST_DAYS = 500          # 保留幾個**日曆天**(約兩年)


def _tw_today_str() -> str:
    # 台北今天(⛔ 不可用 UTC —— 台北晚上會差一天)
    return datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d')


def _snap_hist(fname: str, day_map: dict, label: str, keep_days: int = SNAP_HIST_DAYS):
    """把「日期 → {股號: 值}」併進 data/<fname>(滾動 keep_days 個日曆天)。

    ⛔ 四條守門(照 `universal_radar.build_news_history` 同一套,已被實跑驗證過):
      ① 空的不寫(⛔ 壞資料混進歷史之後永遠分不出來)
      ② 同一天重跑 → 用新的覆蓋那一天(⛔ 不重複累加)
      ③ 滾動保留 keep_days 天
      ④ 🚧 **只增不減**(⚠️ 這一層是保險,⛔ 別以為它擋得住「還原失敗」)——
         🚨 誠實說清楚它的極限:`hist` 是從**本機那份檔案**讀出來再加上今天的,
         所以只要檔案讀得到,天數就**不可能**變少 → 這條判斷式在正常路徑下永遠不會觸發;
         而 workflow 還原失敗時檔案**根本不存在** → `old_days` 是空的 → 它也不會觸發。
         ⭐ **真正擋得住還原失敗的是 workflow 那層**(`scripts/news_hist_guard.py`,
         推之前跟 data 分支上現有的那份比一次)。這裡留著只當「檔案被別的東西改小」的保險。
         ⚠️ 基準要**扣掉被窗口正當裁掉的**,⛔ 不可直接比總天數(否則窗口一滿就永遠拒絕覆蓋)。
    ⛔ 純加值:失敗只印警告,不影響任何既有輸出。
    """
    # 🚧 ① 空的一律不寫 —— 🚨 最危險的情況是「**檔案不存在 + 這輪也沒資料**」:
    #    沒有守門就會寫出一份 `days:{}` 的空檔,把還原回來的歷史整個換成空的。
    #    ⚠️ 誠實說:這一道跟下面「合併後再判一次」重疊(注入驗證確認:拿掉這一道,
    #    下面那道照樣擋得住)→ 它只多提供一句更精確的 log,⛔ 別以為它是唯一防線。
    if not day_map:
        print(f"  ⏭️ {label}歷史:這一輪沒有可存的資料 → ⛔ 不寫(空的混進去就分不出來了)")
        return
    try:
        tgt = Path(DATA_DIR) / fname
        hist, old_days = {}, set()
        try:
            _o = json.loads(tgt.read_text(encoding='utf-8'))
            hist = _o.get('days') or {}
            old_days = set(hist)
        except Exception:
            pass
        n_new = 0
        for d, m in day_map.items():
            if not m:
                continue
            if d not in hist:
                n_new += 1
            hist[d] = m                       # 同一天重跑 → 覆蓋(⛔ 不累加)
        # 🚨 測試 ③c 抓到的洞:`day_map` 非空**但每一天的內容都是空的**(例如那天一檔都沒解析出來)
        #    → 上面的迴圈全部 skip → hist 還是 {} → 照樣寫出一份空檔把歷史換成空的。
        #    ⛔ 所以「空」要在**合併之後**再判一次,不能只判入口。
        if not hist:
            print(f"  ⏭️ {label}歷史:合併後一天都沒有 → ⛔ 不寫(⛔ 不可建立空檔)")
            return
        cut = (datetime.now(timezone(timedelta(hours=8))) - timedelta(days=keep_days)).strftime('%Y-%m-%d')
        for d in [d for d in hist if d < cut]:
            hist.pop(d, None)
        n_base = len([d for d in old_days if d >= cut])
        if n_base and len(hist) < n_base:
            print(f"  ⛔ {label}歷史:算出來只有 {len(hist)} 天、少於舊檔在窗口內的 {n_base} 天 → 拒絕覆蓋(疑似還原失敗)")
            return
        Path(DATA_DIR).mkdir(exist_ok=True)
        out = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'days_kept': keep_days, 'days': hist}
        tmp = tgt.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        os.replace(str(tmp), str(tgt))
        n_cell = sum(len(v) for v in hist.values())
        print(f"  ✅ {label}歷史:新增 {n_new} 天 ・累積 {len(hist)} 天 / {n_cell:,} 筆 → data/{fname}")
    except Exception as e:
        print(f"  ⚠️ {label}歷史失敗(不影響其他輸出):{type(e).__name__}: {e}")


def fetch_margin_limit():
    """💳 個股融資**限額**與餘額 → data/margin_limit_hist.json(每日快照,滾動 500 天)。

    ⭐ 為什麼要存:融資**使用率** = 餘額 ÷ 限額(權證小哥的四大融資指標裡我唯一缺的那個)。
      CLAUDE.md 評估紀錄⑥ 當時決定不做,理由是「無法回算、只能從今天開始存」——
      ⭐ 那正是「現在不存以後永遠沒有」那一類,所以現在開始存。
      ⛔ 在累積滿一年之前**不上任何前端顯示、不計分**(門檻 20/50/70% 未經本站驗證)。

    ⚠️ 只有**上市**(TWSE MI_MARGN);上櫃的 TPEx 對 GitHub runner 整站 403(V73.6.1 實測)。
    ⛔ 零額外成本:一天一個請求(OpenAPI 通了就不再打 rwd)。

    🚨🚨 2026-09-09 實測:**這支從 V74.6.9 上線到現在,`margin_limit_hist.json` 一天都沒寫出來**
       (本地 / origin/gh-pages / origin/data 三邊都沒有這個檔;同一個 job 的
        `lending_hist` 37 天、`blocktrade_hist` 23 天都寫成功了 → 管線無罪)。
       死在第三道 early-return:舊版找「欄名同時含**融資**與今日餘額」的欄,
       而 rwd 版 MI_MARGN 的欄名是
       `['代號','名稱','買進','賣出','現金償還','前日餘額','今日餘額','次一營業日限額',
         '買進','賣出','現券償還','前日餘額']`
       —— **整張表沒有「融資/融券」四個字**,前半融資、後半融券,只靠**位置**區分
       → `i_bal = None` → 直接 return。⭐ 這跟 `fetch_market_margin` 的 rwd 端點是
       **同一份 schema 變更**(miner.py 那邊 V75.1.4 已記過),只是沒人回頭看這支也吃它。

    ⭐ 修法(三層,一層比一層不安全,⛔ 位置解析只能當最後手段):
      ① **TWSE OpenAPI**(list[dict],欄位是**具名**的)—— 跟 `fetch_market_margin`
         step 1.5 同一個端點,那邊實測供料正常。⭐ 一律先印首筆 keys,
         下一輪就算又改名也能從 log 直接看到真名(⛔ 不用再猜一輪)。
      ② rwd JSON **用欄名找**(維持舊行為,萬一哪天欄名加回「融資」就自動走回這條)。
      ③ rwd JSON **靠位置**,但要先過**表頭指紋**:欄數 = 12、第 0 欄含「代號」、
         只有一欄含「限額」而且它在 index 7、index 6 是「今日餘額」。
         ⛔ 指紋對不上就**印出完整 hdr 然後不寫**(⛔ 不硬猜)。
      ④ 不管走哪一層,寫檔前都要過**資料合理性守門**:限額 > 0、而且
         「餘額 ≤ 限額」的比例 ≥ 90%(融資餘額不可能超過限額)。
         ⛔ 不合理就印數字然後不寫 —— 那代表欄位配錯了。

    ⚠️ **語意**:TWSE 那一欄叫「**次一營業日限額**」,不是「今天的限額」。
       它是該股的融資**額度上限**(隔天生效),拿來當使用率的分母是對的,
       但文案⛔ 不可寫成「今日限額」。輸出裡用 `lim_next` 這個名字把它釘住。
    """
    import urllib.request
    day_map = {}
    m = {}
    src = ''

    def _num(v):
        try:
            return float(str(v).replace(',', '').strip() or 0)
        except Exception:
            return 0.0

    def _sane(mm, where):
        """限額 > 0 且「餘額 ≤ 限額」佔比 ≥ 90% —— 不合理代表欄位配錯,⛔ 不寫。"""
        if len(mm) < 200:
            print(f"  ⚠️ 融資限額[{where}]:只解析出 {len(mm)} 檔(<200)→ 保留舊檔(⛔ 不寫半份)")
            return False
        ok = sum(1 for b, l in mm.values() if l > 0 and b <= l)
        pct = ok / len(mm) * 100
        if pct < 90:
            samp = list(mm.items())[:3]
            print(f"  ⚠️ 融資限額[{where}]:只有 {pct:.1f}% 的列滿足「餘額 ≤ 限額」(<90%)"
                  f" → 欄位很可能配錯,保留舊檔。抽樣 {samp}")
            return False
        return True

    # ── ① TWSE OpenAPI(具名欄位,最安全)────────────────────────────
    try:
        url_o = 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'
        req = urllib.request.Request(url_o, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=25) as r:
            rows_o = json.loads(r.read().decode('utf-8', 'ignore'))
        if isinstance(rows_o, list) and rows_o and isinstance(rows_o[0], dict):
            keys = list(rows_o[0].keys())
            print(f"  [融資限額/OpenAPI] 首筆 keys: {keys}")
            k_lim = next((k for k in keys if 'Limit' in k or '限額' in k), None)
            k_bal = next((k for k in keys
                          if k in ('MarginPurchaseTodayBalance', '融資今日餘額', '融資現在餘額')), None)
            k_id = next((k for k in keys if k in ('Code', 'StockNo', '股票代號', '證券代號', '代號')), None)
            if k_lim and k_bal and k_id:
                mm = {}
                for row in rows_o:
                    if not isinstance(row, dict):
                        continue
                    sid = str(row.get(k_id) or '').strip()
                    if not _valid_stock(sid):
                        continue
                    lim, bal = _num(row.get(k_lim)), _num(row.get(k_bal))
                    if lim <= 0:
                        continue
                    mm[sid] = [int(bal), int(lim)]
                if _sane(mm, 'OpenAPI'):
                    m, src = mm, f'OpenAPI({k_bal}/{k_lim})'
            else:
                print(f"  ⚠️ 融資限額[OpenAPI]:找不到需要的欄"
                      f"(id={k_id!r} bal={k_bal!r} lim={k_lim!r})→ 改試 rwd")
        else:
            print(f"  ⚠️ 融資限額[OpenAPI]:回應非 list 或為空 → 改試 rwd")
    except Exception as e:
        print(f"  ⚠️ 融資限額[OpenAPI] 失敗:{type(e).__name__}: {str(e)[:80]} → 改試 rwd")

    # ── ②③ rwd JSON:先用欄名,再用「有指紋守門」的位置 ────────────────
    if not m:
        try:
            d8 = _tw_today_str().replace('-', '')
            url = f'https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date={d8}&selectType=ALL'
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=25) as r:
                j = json.loads(r.read().decode('utf-8', 'ignore'))
            if str(j.get('stat') or '') != 'OK':
                print(f"  ⚠️ 融資限額[rwd]:TWSE 回 stat={j.get('stat')!r} → 保留舊檔(⛔ 不寫空的)")
                return
            # ⚠️ MI_MARGN 有多張表 → 找欄位含「限額」而且第一欄是股票代號的那一張
            rows, hdr = [], []
            for t in (j.get('tables') or []):
                f = [str(x) for x in (t.get('fields') or [])]
                if any('限額' in x for x in f):
                    hdr, rows = f, (t.get('data') or [])
                    break
            if not rows:
                titles = [str(t.get('title', ''))[:40] for t in (j.get('tables') or [])]
                print(f"  ⚠️ 融資限額[rwd]:找不到含「限額」的表(表數 {len(j.get('tables') or [])},"
                      f"標題 {titles})→ 保留舊檔")
                return
            i_lim = next((k for k, x in enumerate(hdr) if '限額' in x), None)
            i_bal = next((k for k, x in enumerate(hdr)
                          if '融資' in x and ('今日餘額' in x or ('今日' in x and '餘額' in x))), None)
            how = '欄名'
            if i_bal is None:
                # 表頭指紋:對得上才敢用位置(⛔ 對不上就印完整 hdr 然後不寫)
                lim_cols = [k for k, x in enumerate(hdr) if '限額' in x]
                fp = (len(hdr) == 12 and '代號' in hdr[0] and lim_cols == [7]
                      and hdr[6] == '今日餘額')
                if not fp:
                    print(f"  ⚠️ 融資限額[rwd]:欄名找不到融資餘額,而且**表頭指紋對不上**"
                          f" → ⛔ 不靠位置硬猜,保留舊檔。完整 hdr = {hdr}")
                    return
                i_bal, how = 6, '位置(指紋已核對)'
            if i_lim is None:
                print(f"  ⚠️ 融資限額[rwd]:找不到限額欄 → 保留舊檔。完整 hdr = {hdr}")
                return
            mm = {}
            for r0 in rows:
                try:
                    sid = str(r0[0]).strip()
                    if not _valid_stock(sid):
                        continue
                    lim, bal = _num(r0[i_lim]), _num(r0[i_bal])
                    if lim <= 0:
                        continue
                    mm[sid] = [int(bal), int(lim)]   # [今日融資餘額(張), 次一營業日融資限額(張)]
                except Exception:
                    continue
            if not _sane(mm, f'rwd/{how}'):
                print(f"     ↳ 參考:hdr = {hdr}")
                return
            m, src = mm, f'rwd/{how}(bal=hdr[{i_bal}]{hdr[i_bal]!r} lim=hdr[{i_lim}]{hdr[i_lim]!r})'
        except Exception as e:
            print(f"  ⚠️ 融資限額[rwd] 抓取失敗:{type(e).__name__}: {e} → 保留舊檔")
            return

    if not m:
        print("  ⚠️ 融資限額:三條路都沒拿到 → 保留舊檔")
        return
    day_map[_tw_today_str()] = m
    print(f"  💳 融資限額:{len(m)} 檔(上市;來源 {src};"
          f"⚠️ 限額欄是「次一營業日限額」不是今日限額;⚠️ 上櫃的 TPEx 對機房 IP 403,拿不到)")
    _snap_hist('margin_limit_hist.json', day_map, '融資限額')


if __name__ == '__main__':
    # V15.0:ONLY_CHIPS=1 → 跳過 OHLCV 採礦,直接跑全市場 fundamentals + chips + futures + macro
    #        (對應 daily_miner.yml 新增的 chips_miner 平行 job)
    ONLY_CHIPS = bool(int(os.getenv('ONLY_CHIPS', '0')))
    if ONLY_CHIPS:
        print("🎯 V15.0 ONLY_CHIPS=1:跳過 OHLCV,直接跑全市場 fundamentals + futures + macro(V79.0.0 起沒有分點)")
        init_db()   # DB 初始化屬前提,失敗就該中止(不吞)
        # 不跑 cleanup_weekend_rows / run / export_json(OHLCV 由 mine matrix 跑)
        # 🛡️ 各步驟彼此獨立 → 逐步包 _safe_step,一步失敗仍續跑其餘(不讓整批停更)
        # 📊 V71.4.8 市場廣度歷史排在最前面 —— 它只讀本地 data/*.json、零 API、幾秒跑完。
        _safe_step("市場廣度歷史 build_breadth_history", build_breadth_history)
        # 💳 V74.6.9 融資限額(TWSE,免付費、一天一個請求)—— 只存歷史,⏳ 累積滿一年前不上前端
        _safe_step("融資限額 fetch_margin_limit", fetch_margin_limit)
        # 🗑️ V79.0.0 券商分點 + 10 個付費資料集(八大行庫/借券/集保分級/處置/產業鏈/當沖比/外資水位/
        #   鉅額/可轉債/權證)與分點後處理(主力雷達/券商勝率/分點檔案/七合一包)全部移除 ——
        #   FinMind 付費金鑰 2026-10-01 失效(使用者決定一起拿掉)。只留每檔基本面這一半。
        _safe_step("每檔基本面 fetch_free_fundamentals", fetch_free_fundamentals)
        _safe_step("外資期貨 fetch_futures_cache", fetch_futures_cache)
        _safe_step("美股宏觀 fetch_us_macro_cache", fetch_us_macro_cache)
        _safe_step("雷達掃描 build_radar_cache", build_radar_cache)   # 讀 SQLite 既有 OHLCV(從 origin/data restore)
        _safe_step("泡沫預警 build_bubble_warning", build_bubble_warning)
        _safe_step("板塊熱度 build_sector_heat", build_sector_heat)
        _safe_step("三位一體選股 generate_top_picks", generate_top_picks)
        # ⛔ V69.8.6 P3-5:此處的 macro_miner 呼叫已移除 — 產出的 macro_risk.json/risk_history.json
        #    不在 chips-data artifact 清單 → 跑完即丟(整支白燒 3-5 分);deploy job 並行階段本來就會跑一次。
        print("✅ ONLY_CHIPS 完成")
        sys.exit(0)

    init_db()
    cleanup_weekend_rows()   # 🛡️ 進場先掃週末污染(MIS 快照跨午夜誤標)
    print("🚀 首席 AI 司令部 — 完全免費採礦機（TWSE/TAIFEX/yfinance）")
    inst_cache, margin_cache, watchlist = run()             # 採礦：OHLCV + 法人 → SQLite
    export_json(inst_cache, margin_cache)                   # 匯出 JSON：疊上最新法人快取

    # V15.0:chips_miner job 接手全市場 fundamentals 跟 chips,batch 0 不再扛
    #        若你仍想在 batch 0 跑(本地測試),維持 SKIP_GLOBAL=0 即可走原流程
    if not SKIP_GLOBAL and os.getenv('SKIP_CHIPS_IN_BATCH0', '1') == '1':
        print("⚡ V15.0:全市場 chips/fundamentals 已交給 chips_miner job 跑,batch 0 略過")
    elif not SKIP_GLOBAL:
        # 🥇 把吃 FinMind 額度最重的工作放最前面：分點分布要逐檔打 API，token 池滿格時搶先消化
        # 🛡️ 各步驟彼此獨立 → 逐步包 _safe_step,一步失敗仍續跑其餘(避免單點失敗讓 radar/top_picks 全停更)
        _safe_step("每檔基本面 fetch_free_fundamentals", fetch_free_fundamentals)    # data/chips/*.json(只放基本面)
        _safe_step("外資期貨 fetch_futures_cache", fetch_futures_cache)   # futures_cache.json （TAIFEX，不吃 FinMind 額度）
        _safe_step("美股宏觀 fetch_us_macro_cache", fetch_us_macro_cache)  # macro_cache.json （yfinance）
        _safe_step("雷達掃描 build_radar_cache", build_radar_cache)     # 雷達掃描（從 SQLite 讀）→ SQLite + radar.json
        _safe_step("泡沫預警 build_bubble_warning", build_bubble_warning)  # 💥 → data/bubble_warning.json
        _safe_step("板塊熱度 build_sector_heat", build_sector_heat)     # 🌡️ → data/sector_heat.json
        _safe_step("三位一體選股 generate_top_picks", generate_top_picks)    # → data/top_picks.json （需 chips 已就緒）

        print("🌍 啟動全局宏觀風險採礦 (macro_miner)...")
        _safe_step("宏觀風險 macro_miner", lambda: os.system("python3 macro_miner.py"))
        # ── 🧹 【資料庫自動瘦身術】 ──（VACUUM 失敗不該讓整批採礦白跑,故也包起來）
        print("\n🧹 執行資料庫碎片重組與瘦身 (VACUUM)...")
        def _vacuum():
            vac_conn = sqlite3.connect(DB_PATH, timeout=30.0)
            try:
                vac_conn.execute("VACUUM;")
            finally:
                vac_conn.close()
            print("  ✅ 瘦身完成！")
        _safe_step("資料庫瘦身 VACUUM", _vacuum)
        # ──────────────────────────────
    else:
        print("⚡ SKIP_GLOBAL=1：略過籌碼/期貨/美股/雷達（純 OHLCV 批次）")

    # 🧹 artifact 修剪改由 daily_miner.yml 的「if: always()」step 依 mined_manifest.txt 執行，
    # 確保即使本批 timeout 被砍，上傳前仍會修剪（不再污染合併）。prune_artifact 保留供本地手動使用。