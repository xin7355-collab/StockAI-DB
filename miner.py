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
import threading
from concurrent.futures import ThreadPoolExecutor
import traceback
import sqlite3
import requests
import io
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import time
import random
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

from common import is_finite_num, SECTOR_MEMBERS, parse_twse_margin_ms   # 🧩 共用工具 / 板塊成分股 / TWSE 融資解析(皆單一真相來源)

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
FINMIND_PAID = None                # 💰 None=未偵測 / True=付費有效 / False=免費或付費失效(自動降版)
FINMIND_PAID_TOKEN = ''            # 💰 探測時第一把通過付費的 token(向下相容,單把用途仍讀這個)
# 🚀 V71.2.7 付費 token 池 —— 這是全市場分點採礦真正的天花板所在。
#   舊寫法 fm_paid_get() **從頭到尾只用 FINMIND_PAID_TOKEN 一把**,
#   等於不管 Secrets 放幾把,分點永遠只吃得到「單把 6000 req/hr = 100 req/min」。
#   實測:35 分鐘預算跑約 4,000~4,500 次呼叫 ≈ 每分鐘 120 次 —— 剛好卡在單把的額度天花板,
#   所以「跑不完全市場」不是程式慢,是額度只用了 1/N。
#   改成把所有驗證過付費的 token 收進池子輪流用 → 上限變成 N × 6000/hr。
FINMIND_PAID_TOKENS: list = []
_fm_paid_idx = 0
_fm_paid_lock = threading.Lock()
# 🔑 V71.2.8 免費/付費分流(使用者:1 把付費 999 + 3 把免費)
#   分點(TaiwanStockTradingDailyReport)是 Sponsor 專屬,免費金鑰**抓不到** → 付費那把是硬天花板。
#   所以要做的不是「用免費抓分點」(做不到),而是「把免費金鑰扛得動的通通接手」,
#   讓付費那把的 6,000 req/hr **一滴都不浪費在別的資料集上**。
#   舊版 fm_request() 是對「全部」token 輪動 → 每 4 次就有 1 次在吃付費額度。
FINMIND_FREE_TOKENS: list = []      # 探測後:非付費(免費層)的 token
_FM_PAID_RATE_MAX = int(os.getenv('FM_PAID_RATE_MAX', '95'))   # 付費單把 6000/hr=100/min,留 5% 安全邊
_fm_paid_calls: list = []           # 最近一分鐘的呼叫時間戳(節流用)


def detect_finmind_paid() -> bool:
    """💰 V68.2.6 自動偵測 FinMind 付費(Sponsor)是否有效:打一個付費專屬 dataset(分點)看回 200 還是 402。
    ⭐ 付費失效/退訂/未設 → 回 False → 上層自動「降版」:分點只走免費 BSR、覆蓋縮回免費安全值,
    不會噴錯也不會拿垃圾。全域只探一次(快取)。"""
    global FINMIND_PAID, FINMIND_PAID_TOKEN
    if FINMIND_PAID is not None:
        return FINMIND_PAID
    if not FINMIND_TOKENS:
        FINMIND_PAID = False
        print('💰 FinMind:後端未設 token(GitHub Secrets FINMIND_TOKENS 為空)→ 免費模式(降版)')
        return False
    # 💰 V68.2.7 正解(FinMind 官方 skill 文件):分點 TaiwanStockTradingDailyReport 走「專屬端點」
    #   /api/v4/taiwan_stock_trading_daily_report(不是 /data!),參數用 date(單日)、要 Bearer 標頭。
    #   之前打 /data?dataset=...&start_date= 是錯端點 → 回 400/illegal。改對端點才能真正驗證付費。
    recent_dates = _recent_finmind_dates(7)   # 近 7 個日曆日(含非交易日,交易日才回 data)
    # 💰 逐把 token 直接試(不靠輪動,避免舊/壞 token 擋住真正付費金鑰),每把試幾個近日直到有回。
    last_status, last_msg = None, ''
    per_token = []            # [(遮罩後 token, status, msg)]
    for ti, tok in enumerate(FINMIND_TOKENS):
        tok_status, tok_msg = None, ''
        hdrs = {**_rnd_hdrs(), 'Authorization': f'Bearer {tok}'}
        for d in recent_dates:
            url = ('https://api.finmindtrade.com/api/v4/taiwan_stock_trading_daily_report'
                   f'?data_id=2330&date={d}')
            try:
                res = http_session.get(url, headers=hdrs, timeout=15)
                j = res.json() if res is not None else {}
            except Exception as _e:
                tok_status, tok_msg = 'EXC', str(_e)[:80]
                continue
            tok_status, tok_msg = j.get('status'), str(j.get('msg', ''))[:80]
            if j.get('status') == 200 and (j.get('data') or []):
                FINMIND_PAID = True
                if not FINMIND_PAID_TOKEN:
                    FINMIND_PAID_TOKEN = tok
                # 🚀 V71.2.7:不再「找到一把就 break 整個迴圈」——每把都要驗,
                #   全部收進池子才能把額度乘上去(見 FINMIND_PAID_TOKENS 註解)。
                if tok not in FINMIND_PAID_TOKENS:
                    FINMIND_PAID_TOKENS.append(tok)
                break   # 這把已確認可用,不用再試其他日期;外層繼續驗下一把
            if tok_status in (402, 403) or (tok_msg and 'illegal' in tok_msg.lower()):
                break   # 這把 token 就是不行(非付費/貼錯),不用再試其他日期
        mask = (tok[:6] + '…' + tok[-4:]) if len(tok) > 12 else '(短)'
        per_token.append((mask, tok_status, tok_msg))
        last_status, last_msg = tok_status, tok_msg
    # 🔑 V71.2.8 沒通過付費驗證的 = 免費層 token → 專門去扛「免費也能抓」的資料集,
    #   把付費那把整整 6,000 req/hr 全部留給分點(Sponsor 專屬,免費金鑰抓不到)。
    FINMIND_FREE_TOKENS[:] = [t for t in FINMIND_TOKENS if t not in FINMIND_PAID_TOKENS]
    if FINMIND_PAID:
        print(f'💰 FinMind:付費(Sponsor)有效 → 付費 {len(FINMIND_PAID_TOKENS)} 把 / 免費 {len(FINMIND_FREE_TOKENS)} 把'
              f'(分點可用額度 {len(FINMIND_PAID_TOKENS) * 6000:,} req/hr;'
              f'一般資料集改由免費金鑰扛,不再吃掉分點額度)')
    if not FINMIND_PAID:
        illegal = any('illegal' in (m or '').lower() for _, _, m in per_token)
        need_pay = any(s in (402, 403) for _, s, _ in per_token)
        hint = ('token 字串貼錯/不完整(FinMind 回 illegal)→ 請重貼完整金鑰到 GitHub Secrets FINMIND_TOKENS' if illegal
                else 'token 有效但非付費層級 → 需升級 FinMind Sponsor' if need_pay
                else '參數/連線問題' if last_status not in (None, 200) else '連不到/回空(近日皆非交易日?)')
        detail = ' ; '.join(f'{m}:status={s}/{msg}' for m, s, msg in per_token)
        print(f'⚠️ FinMind:付費失效/未生效({len(FINMIND_TOKENS)} 把 token 全試過｜{hint})→ 自動降版免費模式(分點只用 BSR)')
        print(f'   逐把探測:{detail}')
    return FINMIND_PAID


def _recent_finmind_dates(n_days: int) -> list:
    """回近 n_days 個日曆日(今天起往回),字串 YYYY-MM-DD。分點端點用單日 date;
    非交易日 FinMind 回空,交易日才回資料,故多給幾天讓呼叫端自然命中最近交易日。"""
    today = date.today()
    return [(today - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n_days)]


def fm_paid_get(endpoint: str, params: str, timeout: int = 15):
    """💰 付費專屬端點統一入口(Bearer 標頭 + 探測時通過的付費 token)。
    endpoint 例:'taiwan_stock_trading_daily_report'。params 例:'data_id=5483&date=2026-07-16'。
    回 dict(FinMind 標準 {status,data,msg}) 或 None。未偵測到付費 token 時回 None。"""
    # 🚀 V71.2.7 從付費池輪流取(thread-safe),把額度乘上 token 把數;
    #   池子空(還沒偵測/只有一把)時退回原本的單把行為,行為不變。
    global _fm_paid_idx
    if FINMIND_PAID_TOKENS:
        with _fm_paid_lock:
            tok = FINMIND_PAID_TOKENS[_fm_paid_idx % len(FINMIND_PAID_TOKENS)]
            _fm_paid_idx += 1
    else:
        tok = FINMIND_PAID_TOKEN or (FINMIND_TOKENS[0] if FINMIND_TOKENS else '')
    if not tok:
        return None
    # 🚦 V71.2.8 付費額度節流:單把 6,000 req/hr = 100 req/min。
    #   只有 1 把付費金鑰時,超打就是 429 —— 而 429 一樣消耗掉這一分鐘的機會、還要重試,
    #   等於「打越快、拿到越少」。這裡用滑動視窗把速率壓在 95/min/把,寧可等也不要撞牆。
    _cap = _FM_PAID_RATE_MAX * max(1, len(FINMIND_PAID_TOKENS))
    while True:
        with _fm_paid_lock:
            _now = time.time()
            _fm_paid_calls[:] = [t for t in _fm_paid_calls if _now - t < 60.0]
            if len(_fm_paid_calls) < _cap:
                _fm_paid_calls.append(_now)
                break
            _wait = 60.0 - (_now - _fm_paid_calls[0]) + 0.05
        time.sleep(max(0.05, min(_wait, 5.0)))
    url = f'https://api.finmindtrade.com/api/v4/{endpoint}?{params}'
    hdrs = {**_rnd_hdrs(), 'Authorization': f'Bearer {tok}'}
    try:
        res = http_session.get(url, headers=hdrs, timeout=timeout)
        return res.json() if res is not None else None
    except Exception:
        return None


def get_finmind_token() -> str:
    """[Token 輪動] 取得目前輪動中的 FinMind Token；斷路器觸發後回傳空字串。

    🔑 V71.2.8:一般資料集(法人/融資券/營收/財報/PER/股利…)**優先用免費金鑰**,
       把付費那把的 6,000 req/hr 完整留給 Sponsor 專屬的分點。
       沒有免費金鑰時才退回全部 token(行為同舊版)。
    """
    if _FINMIND_BLOCKED or not FINMIND_TOKENS:
        return ''
    pool = FINMIND_FREE_TOKENS or FINMIND_TOKENS
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
    pool = FINMIND_FREE_TOKENS or FINMIND_TOKENS
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
            err = str(e)
            print(f"  ⚠️ yfinance {tk}: {err[:120]}")
            # V15.0:偵測「possibly delisted / No data found」字樣 → 加進黑名單下次跳過
            if any(kw in err.lower() for kw in ('possibly delisted', 'no data found', 'no price data')):
                _mark_delisted(symbol, f"yfinance: {err[:60]}")
                print(f"  ⛔ 標記 {symbol} 為已下市(下次跳過,每月 1 號自動 reset)")
            continue
    return []


# ── TWSE MIS 快照補丁 (盤中防退回昨日) ──────────────────────────────────────
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

    # 🏛️ 1.5. TWSE OpenAPI v1 第二條源:rwd 端點 2026/06 起改回彙總表後,改試官方 OpenAPI
    #    端點:https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN(RESTful list[dict])
    #    僅在 step 1 沒拿到任何個股(res 空)時試,避免徒耗 API。OpenAPI 成功則直接補上市段
    if not res:
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


# ── 產業類別 → 個股 映射(供 industry_pe.json 算「產業相對 PE」)────────────
# 景氣循環產業:PE 低反而是高點(航運/塑化/鋼鐵等),前端會顯示警語
CYCLICAL_INDUSTRIES = {
    '航運業', '塑膠工業', '橡膠工業', '鋼鐵工業', '水泥工業',
    '造紙工業', '化學工業', '化學生技醫療', '油電燃氣業',
}


def fetch_industry_map() -> dict:
    """從 TWSE openapi 抓上市公司「產業別」對照表,輸出 {sym: industry_name}。
    上市 t187ap03_L + 上櫃 t187ap03_O 兩個資料集,免費無 token。"""
    industry_map = {}
    for url, label in [
        ('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', 'TWSE 上市'),
        ('https://openapi.twse.com.tw/v1/opendata/t187ap03_O', 'TPEX 上櫃'),
    ]:
        ok = False
        for attempt in range(3):
            try:
                r = http_session.get(url, headers=_rnd_hdrs(), timeout=20)
                if r.status_code != 200:
                    print(f"  ⚠️ {label} 產業別 HTTP {r.status_code} (attempt {attempt+1}/3)")
                    time.sleep(2 ** attempt)
                    continue
                data = r.json()
                if not isinstance(data, list) or not data:
                    print(f"  ⚠️ {label} 產業別回應非預期 list 或空 (type={type(data).__name__}, sample={str(data)[:120]})")
                    time.sleep(2 ** attempt)
                    continue
                added = 0
                for row in data:
                    sym = str(row.get('公司代號') or row.get('SecuritiesCompanyCode') or '').strip()
                    ind = str(row.get('產業別') or row.get('IndustryCategory') or '').strip()
                    if sym and ind and sym.isdigit() and 4 <= len(sym) <= 6:
                        industry_map[sym] = ind
                        added += 1
                print(f"  ✅ {label} 產業別:本次 +{added} / 累計 {len(industry_map)} (回應 {len(data)} 列,前 3:{[r.get('公司代號') or r.get('SecuritiesCompanyCode') for r in data[:3]]})")
                ok = True
                break
            except Exception as e:
                print(f"  ⚠️ {label} 產業別抓取失敗 (attempt {attempt+1}/3):{e}")
                time.sleep(2 ** attempt)
        if not ok:
            print(f"  ❌ {label} 產業別 3 次重試皆失敗,跳過此源")
        time.sleep(random.uniform(1.0, 2.0))
    return industry_map


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
def compute_market_pb_percentiles(fund_cache: dict) -> dict:
    pbs = []
    for fund in (fund_cache or {}).values():
        pb = (fund or {}).get('pb') or (fund or {}).get('pbr')
        if pb is not None and 0 < pb < 50:
            pbs.append(pb)
    if len(pbs) < 50:
        return {}
    sorted_pbs = sorted(pbs)
    n = len(sorted_pbs)
    return {
        'updated': date.today().isoformat(),
        'count': n,
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
    # 🐛 V71.3.4 資料集名稱打錯 —— 實測 log:
    #   ⚠️ TaiwanBrokerInfo 回傳異常: {'detail': [{'type': 'enum', 'loc': ['query','dataset'], ...
    #   FinMind 根本沒有 TaiwanBrokerInfo 這個資料集(回 enum 錯誤 = 名稱不在合法清單裡)。
    #   正確名稱是 TaiwanSecuritiesTraderInfo(證券商資訊,免費層)。
    #   影響:券商代碼→中文名的「官方完整對照表」從來沒載入過,分點顯示只能靠
    #   逐日採礦累積的名稱,沒出現過的分點就顯示數字代號。
    #   舊名保留當備援(萬一哪天又被 FinMind 加回來),先試新名。
    for attempt in range(3):
        url = ('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanSecuritiesTraderInfo'
               if attempt < 2 else
               'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanBrokerInfo')
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
                print(f"  📖 券商對照表載入:{len(mapping)} 家券商代碼→中文名")
                return mapping
            else:
                print(f"  ⚠️ 券商對照表回傳異常({url.split('dataset=')[-1]}): {str(j)[:100]}")
                break
        except Exception as e:
            print(f"  ⚠️ 券商對照表第{attempt+1}次失敗: {e}")
            if attempt < 2:
                time.sleep(5)
    return {}


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
        def _margin_trend(type_names):
            num_rows = sorted([r for r in rows if r.get('type') in type_names], key=lambda x: x.get('date', ''))
            num_by_q = {r['date']: float(r.get('value', 0) or 0) for r in num_rows[-6:]}
            cq = sorted(set(num_by_q) & set(rev_by_q))[-3:]
            ms = [round(num_by_q[q] / rev_by_q[q] * 100, 1) for q in cq if rev_by_q.get(q, 0) > 0]
            if len(ms) >= 2:
                d = round(ms[-1] - ms[0], 1)
                return '→'.join(f'{m}%' for m in ms) + f'（{"↑" if d > 0 else "↓"}{abs(d)}pp）'
            return None
        op_trend  = _margin_trend({'OperatingIncome'})
        net_trend = _margin_trend({'IncomeAfterTaxes', 'ProfitAfterTax', 'NetIncome'})
        if op_trend:  result['op_margin_trend']  = op_trend
        if net_trend: result['net_margin_trend'] = net_trend
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

            # 近 4 季加總 = 年化股利(對齊使用者預期)
            total_4q = sum(q['cash'] + q['stock'] for q in qdivs[-4:])
            result['total_dividend_4q'] = round(total_4q, 2)

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
                            # (b) 校正殘留盤中快照(收盤差 ≥1.5%;auto_adjust=False 無除權息誤差,官方≈yfinance 通常 <0.1%)
                            n_fix = 0
                            for ds in stale_recent:
                                yr = yf_by_date.get(ds)
                                if not yr or ds in existing_dates:
                                    continue
                                old_c = existing_map[ds].get('close') or 0
                                if old_c > 0 and abs(yr['close'] - old_c) / old_c >= 0.015:
                                    new_rows.append(yr); existing_dates.add(ds); n_fix += 1
                                    print(f"  🔧 {sym} {ds} 疑殘留盤中快照(收 {old_c}→yfinance {yr['close']}),yfinance 校正覆蓋")
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
    return uniq if uniq else None


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
            tag = url.split('tpex.org.tw')[-1][:42]
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
                _tbl_keys = []
                if not data and isinstance(j.get('tables'), list):
                    for _t in j['tables']:
                        if not isinstance(_t, dict):
                            continue
                        _tbl_keys = list(_t.keys())
                        for _k, _v in _t.items():
                            if _k in ('fields', 'notes', 'hints'):      # 這些是欄位名/說明,不是資料
                                continue
                            if isinstance(_v, list) and _v and isinstance(_v[0], (list, tuple)) and len(_v[0]) >= 5:
                                data = _v
                                break
                        if data:
                            break
                if not data:
                    # 連表內欄位名一起印出來,下一輪就能直接看出資料到底放在哪個 key
                    why.append(f"{tag}→200 但無資料(stat={str(j.get('stat'))[:30]!r}, "
                               f"tables={len(j.get('tables') or [])}, 表內欄位={_tbl_keys[:8]})")
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
               'twoii': '^TWO',     # 台股上櫃指數（OTC,供個股查詢頁查上櫃整體走勢)
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
            _period = '2y' if is_long else '10d'
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
def _fetch_chips_bulk(dates, need_days=11, top_per_day=25, min_syms=200):
    """🚀 V71.2.6 分點「單日全市場批次」——把全市場採礦從 1 萬次呼叫壓成 11 次。

    【為什麼要做】
    舊做法是「逐檔 × 逐日」:熱門股 11 天 = 11 次呼叫、冷門股 3 天 = 3 次,
    全市場 2,620 檔 ≈ **每天 1 萬次 HTTP**。即使付費額度夠(6000/hr/把 × 多把),
    卡住的是「單執行緒逐次來回」的牆鐘時間 —— 實測 40 分鐘只跑得完約 6 成,
    而且每輪都從成交值最高的開始排,**排在後面的長尾永遠輪不到**
    (實測抽樣 300 檔:39% 還停在 2026-05-20 的舊格式,兩個多月沒更新過)。

    【正解】
    FinMind 官方規則:「省略 data_id、只給日期 → 回該日全市場」(需 Backer/Sponsor)。
    使用者是 Sponsor,所以一天一次呼叫就能拿到**全市場所有分點**。
    11 個交易日 = 11 次呼叫,取代原本的 ~10,000 次。

    【安全設計(拿不到就退回舊路,不能讓全市場分點開天窗)】
    ・第一天就失敗 → 立刻回 None(只浪費 1 次呼叫),上層走原本的逐檔路徑
    ・回來的股票數 < min_syms → 判定「不是真的全市場」(可能只回了單一檔或錯誤格式)→ 回 None
    ・每 (股票, 日期) 只留淨額絕對值前 top_per_day 家分點 → 記憶體有上限
      (2,620 檔 × 11 日 × 25 家 ≈ 72 萬列,GitHub runner 吃得下)
    ・環境變數 CHIPS_BULK=0 可一鍵關掉回舊行為

    回傳 {stock_id: [row, ...]},row 的欄位與逐檔端點完全一致 → 下游解析不用改。
    拿不到回 None。
    """
    idx: dict = {}
    got_dates: list = []
    t0 = time.time()
    for d in dates:
        if len(got_dates) >= need_days:
            break
        j = fm_paid_get('taiwan_stock_trading_daily_report', f'date={d}', timeout=180) or {}
        st = j.get('status')
        rows = j.get('data') or []
        if st != 200 or not rows:
            if not got_dates:
                print(f"  ℹ️ 分點全市場批次:{d} 回 status={st} msg={str(j.get('msg',''))[:60]!r}"
                      f" → 這個帳號/端點不支援省略 data_id,改用逐檔模式(只花掉 1 次呼叫)")
                return None
            continue   # 已經成功過 → 這天可能不是交易日,跳過就好
        # 污染防呆(對齊逐檔路徑):欄位必須真的是分點,否則整份丟掉,不讓髒資料進 chips
        if not any(k in rows[0] for k in ('secBrokerId', 'securities_trader_id', 'broker_id')):
            print(f"  ⚠️ 分點全市場批次:{d} 欄位不對 keys={list(rows[0].keys())[:8]}"
                  f" → 放棄批次改用逐檔(避免污染)")
            return None
        # 分桶 + 防呆:必須看得到多檔不同股票,才算真的全市場
        bucket: dict = {}
        for r in rows:
            sid = str(r.get('stock_id') or '').strip()
            if not sid:
                continue
            bucket.setdefault(sid, []).append(r)
        if len(bucket) < min_syms:
            print(f"  ⚠️ 分點全市場批次:{d} 只回 {len(bucket)} 檔股票(<{min_syms})"
                  f" → 不像全市場,保險起見改用逐檔模式")
            return None
        # 每檔當日只留淨額最大的前 N 家(記憶體上限;下游本來也只取 top15)
        for sid, rs in bucket.items():
            if len(rs) > top_per_day:
                def _net(x):
                    try:
                        return abs(int(x.get('buy', 0)) - int(x.get('sell', 0)))
                    except Exception:
                        return 0
                rs = sorted(rs, key=_net, reverse=True)[:top_per_day]
            idx.setdefault(sid, []).extend(rs)
        got_dates.append(d)
        print(f"  📦 分點全市場批次 {d}:{len(bucket)} 檔 / {len(rows)} 列(累計 {len(got_dates)}/{need_days} 日)")
    if not got_dates:
        return None
    print(f"  🚀 分點全市場批次完成:{len(idx)} 檔 × {len(got_dates)} 個交易日,"
          f"共 {len(got_dates)} 次呼叫、{time.time() - t0:.0f} 秒"
          f"(舊逐檔模式同樣覆蓋需約 1 萬次呼叫)")
    return idx


def _prefetch_chips_parallel(syms_days, budget_s):
    """🚀 V71.2.7 逐檔模式的併發預抓(批次那條路走不通時的第二條路)。

    【為什麼單純「跑久一點」沒用】
    舊的逐檔迴圈是單執行緒 + 只用一把 token。FinMind 付費是 6,000 req/hr/把 = 100 req/min,
    實測 35 分鐘跑約 4,000~4,500 次呼叫 ≈ 120 次/分 —— 剛好貼在單把額度天花板上。
    也就是說慢的原因不是程式,是**額度只用到 1/N**(Secrets 裡有 N 把卻只用 1 把)。

    【修法】
    ・fm_paid_get 改成付費池輪流(見 FINMIND_PAID_TOKENS)→ 上限變 N × 6,000/hr
    ・這裡再用執行緒池把「等網路回應」的時間疊起來,worker 數綁 token 把數
      (每把 ~2 條,再夾在 2~12 之間),不會超抽額度
    ・只平行「抓」,不平行「解析/寫檔」—— 回傳的索引形狀跟 _fetch_chips_bulk 完全一樣,
      交給原本的序列迴圈處理,共用同一套解析與污染防呆,不新增併發寫檔的風險

    syms_days: [(sym, need_days, lookback), ...]
    回 {sym: [row, ...]};時間預算到就把已完成的先回(未完成的下輪再補)。
    """
    if not syms_days:
        return {}
    ntok = max(1, len(FINMIND_PAID_TOKENS))
    workers = max(2, min(12, ntok * 2))
    idx: dict = {}
    t0 = time.time()
    stop = {'flag': False}

    def one(item):
        sym, need_days, lookback = item
        if stop['flag']:
            return sym, None
        rows_all = []
        seen = set()
        for d in _recent_finmind_dates(lookback):
            if stop['flag'] or len(seen) >= need_days:
                break
            j = fm_paid_get('taiwan_stock_trading_daily_report', f'data_id={sym}&date={d}') or {}
            st, rows = j.get('status'), j.get('data') or []
            if st in (402, 403):
                return sym, None
            if st == 200 and rows:
                if not any(k in rows[0] for k in ('secBrokerId', 'securities_trader_id', 'broker_id')):
                    return sym, None          # 污染防呆(同逐檔路徑)
                rows_all.extend(rows)
                seen.add(d)
        return sym, rows_all

    print(f"  🧵 分點逐檔併發預抓:{len(syms_days)} 檔 / {workers} 執行緒 / "
          f"{ntok} 把付費 token(上限 {ntok * 6000:,} req/hr)")
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for sym, rows in ex.map(one, syms_days):
            if rows:
                idx[sym] = rows
            if time.time() - t0 > budget_s and not stop['flag']:
                stop['flag'] = True
                print(f"  ⏳ 併發預抓達時間預算 {budget_s}s,已取得 {len(idx)} 檔,其餘下輪續抓")
    print(f"  🧵 併發預抓完成:{len(idx)}/{len(syms_days)} 檔,耗時 {time.time() - t0:.0f} 秒")
    return idx


def fetch_broker_chips():
    """
    分點籌碼採礦：由於台灣官方無免費分點 API，
    此處使用 FinMind 匿名公開額度 (每小時 300 次限制)。
    """
    chips_dir = Path(DATA_DIR) / 'chips'
    chips_dir.mkdir(parents=True, exist_ok=True)
    today_str = date.today().strftime('%Y-%m-%d')
    # 💰 V68.2.6 自動偵測付費層級 → 決定分點來源 + 覆蓋上限(付費失效自動降版)
    paid = detect_finmind_paid()
    # V16.4 — chips_miner 平行 job 開頭寫狀態(會疊在 ohlcv_batch 之上)
    write_miner_status('chips_fundamentals', 'mining',
                       {'note': '分點籌碼 + 基本面 + 雷達 + 全球新聞 採礦中'})
    # ── V68.9.8 全市場滾動分點：不再只抓最熱門 ~180 檔 ──────────────────────────
    # 痛點:付費卻只抓最熱門 ~180 檔(中華電 2412 等中大型排不進 → 顯「無分點」)。
    # 解法:抓「全市場」,但受單一付費 token ~6000/hr 硬限 → 分層 + 時間預算 + 逐日續抓:
    #   ・熱門股(CHIP_WATCHLIST ∪ 成交值 Top N):11 交易日深度(1/3/5/10 週期)、含完整基本面
    #   ・冷門股(其餘全市場):淺層 3 交易日(1/3 週期)、跳過昂貴逐檔基本面(用 TWSE bulk PE/殖利率)
    #   ・時間預算(CHIPS_TIME_BUDGET,預設 40 分)到 → 收工,已抓的存檔;下輪「今日已抓→跳過」續抓未完成
    #   ・熱門股永遠排最前(成交值高→低)→ 大盤主力天天新鮮;冷門長尾每幾天輪一次(同 fund_sweep 滾動哲學)
    #   ・CHIPS_BATCH/CHIPS_TOTAL round-robin(供未來 matrix 平行;預設 0/1 不分割)
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
    if paid:
        # 🐛 V71.2.6 修「長尾永遠輪不到」:
        #   舊排序是「熱門 → 冷門(成交值高→低)」,而且**每天都從同一個位置開始**。
        #   時間預算 40 分鐘只跑得完約 6 成 → 排在後面那 4 成天天被砍在同一刀口上,
        #   永遠輪不到。實測抽樣 300 檔:39% 還停在 2026-05-20 的舊格式,兩個多月沒更新。
        #   註解寫「滾動續抓」是誤會 —— 那要靠「同一天跑很多輪」才成立,
        #   但 daily_miner 一天只跑一次,所以根本沒有下一輪來接。
        #   修法:冷門股改「分點資料最舊的排最前面」(同 fund_sweep 的滾動哲學),
        #   這樣就算預算中途收工,下一次跑會換一批最舊的先做 → 長尾一定輪得到。
        _own_dt_cache: dict = {}
        for _f in chips_dir.glob('*.json'):
            try:
                _o = json.loads(_f.read_text(encoding='utf-8'))
                _c = (_o if isinstance(_o, list) else (_o.get('chips') or []))
                if _c:
                    _own_dt_cache[_f.stem] = str(_c[-1].get('date') or '')
            except Exception:
                continue
        # 熱門:維持成交值高→低(大盤主力天天要新鮮)
        # 冷門:分點日期舊的優先(''=從沒抓過 → 排最前),同日期再比成交值
        #   (兩組的 key 一律 4 元組、型別逐位對齊,避免長度不一造成的比較地雷)
        ordered = sorted(universe, key=lambda s: (
            (0, '', -turnover.get(s, 0.0), s) if s in hot_set
            else (1, _own_dt_cache.get(s, ''), -turnover.get(s, 0.0), s)))
    else:
        # 免費(BSR only):維持小清單避免限流(全市場需付費 token)
        ordered = sorted(set(CHIP_WATCHLIST) & universe)[:100]
    if CHIPS_TOTAL > 1:
        ordered = [ordered[i] for i in range(CHIPS_BATCH, len(ordered), CHIPS_TOTAL)]
    watchlist = ordered
    print(f"  📋 分點籌碼目標(全市場滾動):{len(watchlist)} 檔 | 熱門深度 {len(hot_set)} 檔 | "
          f"批次 {CHIPS_BATCH}/{CHIPS_TOTAL} | 付費={paid}")

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
            fund_cache = {s: {'pe': v.get('pe'), 'yield_rate': v.get('yield_rate')}
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

        if twse_fund:

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

                industries = aggregate_industry_pe(fund_cache, industry_map)
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

                # V16.2 — 全市場 P/B 分位數寫 data/market_stats.json(供前端動態判斷取代固定 <2/>5)
                try:
                    pb_pct = compute_market_pb_percentiles(fund_cache)
                    if pb_pct:
                        ms_path = Path('data', 'market_stats.json')
                        existing_ms = {}
                        if ms_path.exists():
                            try: existing_ms = json.loads(ms_path.read_text(encoding='utf-8'))
                            except Exception: pass
                        existing_ms['pb'] = pb_pct
                        ms_path.write_text(json.dumps(existing_ms, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                        print(f"  💾 全市場 P/B 分位 → data/market_stats.json(P25/P50/P75/P90 = {pb_pct['p25']}/{pb_pct['p50']}/{pb_pct['p75']}/{pb_pct['p90']},{pb_pct['count']} 檔)")
                    else:
                        print("  ⏭️ 全市場 P/B 樣本不足(< 50),不寫 market_stats.json")
                except Exception as e:
                    print(f"  ⚠️ 全市場 P/B 分位失敗(不影響主流程):{e}")
            except Exception as e:
                print(f"  ⚠️ 產業 PE 聚合失敗(不影響主流程):{e}")
        else:
            print("  ⏭️ TWSE 基本面回空,跳過產業 PE 聚合(YoY/毛利已獨立補入既有快取)")
    except Exception as e:
        print(f"  ⚠️ fundamentals_cache 寫檔失敗(不影響主流程):{e}")

    # 新增：一次查全台券商代碼→中文名對照（FinMind TaiwanBrokerInfo 免費）
    print("\n📖 載入券商對照表（TaiwanBrokerInfo）...")
    broker_info_map = _load_broker_info_map()

    print(f"\n🕵️ 啟動分點籌碼 + 基本面探測 ({len(watchlist)} 檔，請耐心等候避免限流)...")

    updated = 0
    _skipped_today = 0
    broker_name_map: dict = {}  # 累積 bid→中文名 供 broker_names.json
    _fund_extra: dict = {}      # V35.8 — 收集觀察清單已算好的 {sym:{rev_yoy,gross_margin}},迴圈後併入全市場快取
    _chips_start = time.time()
    _chips_budget = int(os.getenv('CHIPS_TIME_BUDGET', '2400'))   # V68.9.8 預設 40 分,到點收工續抓
    # 🐛 V71.1.5 全市場「目前最新的分點日」= 現有 chips 檔裡最大的那個日期。
    #    當跳過判斷的基準:自己的分點日還沒追上這個日期 → 代表它拿到的是舊資料,本輪要重抓。
    #    (取 P95 而非最大值,避免單一髒檔的未來日期把門檻拉高害全部重抓。)
    _corpus_latest_dt = ''
    try:
        _all_dt = []
        for _f in chips_dir.glob('*.json'):
            try:
                _o = json.loads(_f.read_text(encoding='utf-8'))
                # 舊檔可能是純 list(見下方 existing_obj 的同樣兼容處理),不吃這種會靜靜漏算
                _c = (_o if isinstance(_o, list) else (_o.get('chips') or []))
                if _c:
                    _d = str(_c[-1].get('date') or '')
                    if _d:
                        _all_dt.append(_d)
            except Exception:
                continue
        if len(_all_dt) >= 20:
            _all_dt.sort()
            _corpus_latest_dt = _all_dt[int(len(_all_dt) * 0.95)]
        print(f"  📅 全市場最新分點日基準(由現有檔推估):{_corpus_latest_dt or '(無現有分點檔)'}")
    except Exception as _e:
        print(f"  ⚠️ 分點日基準計算失敗(退回舊行為:只看今日是否抓過):{_e}")
    # 🎯 V71.3.6 用「上游真的出到哪一天」當基準,而不是「我手上最新是哪一天」。
    #
    #   為什麼非改不可 —— 沒有這段,晚上那輪會 100% 空轉:
    #     下午 16:30 那輪跑的時候,證交所當日分點還沒出 → 全市場都只拿到前一交易日,
    #     於是 _corpus_latest_dt(由現有檔推估)= 前一交易日。
    #     晚上 20:00 那輪起跑時,雖然當日分點已經出來了,但基準還是停在前一交易日
    #     → 每一檔都判定「我已經追上基準了」→ 全部跳過 → 一檔都不會更新。
    #
    #   修法:開跑前用台積電探一次「最新有資料的日期」(1 次呼叫)。
    #   探到比手上更新的日期,就把基準拉上去 → 所有還停在舊日期的股票自動重抓。
    #   附帶好處:下午那輪若剛好資料早出,也會立刻抓到當日,不必等隔天。
    if paid:
        try:
            for _pd in _recent_finmind_dates(4):
                _pj = fm_paid_get('taiwan_stock_trading_daily_report', f'data_id=2330&date={_pd}') or {}
                if _pj.get('status') == 200 and (_pj.get('data') or []):
                    if _pd > (_corpus_latest_dt or ''):
                        print(f"  🎯 上游最新分點日 {_pd} 比手上的 {_corpus_latest_dt or '(無)'} 新 → 基準拉到 {_pd},落後的股票本輪重抓")
                        _corpus_latest_dt = _pd
                    else:
                        print(f"  🎯 上游最新分點日 {_pd},與手上基準一致")
                    break
        except Exception as _e:
            print(f"  ⚠️ 上游分點日探測略過(沿用現有檔推估的基準):{str(_e)[:60]}")
    # 🚀 V71.2.6 先試「單日全市場批次」:成功的話全市場只要 ~11 次呼叫,當天就能全部採完;
    #    失敗(帳號不支援/回傳不像全市場)自動退回原本的逐檔模式,不影響既有行為。
    _bulk_idx = None
    if paid and os.getenv('CHIPS_BULK', '1') == '1':
        try:
            _bulk_idx = _fetch_chips_bulk(_recent_finmind_dates(16), need_days=11)
        except Exception as _e:
            print(f"  ⚠️ 分點全市場批次例外(退回逐檔):{str(_e)[:80]}")
            _bulk_idx = None
    if _bulk_idx:
        # 批次模式下時間預算沒有意義(資料都在記憶體裡了),放寬到 job timeout 之前
        _chips_budget = max(_chips_budget, int(os.getenv('CHIPS_TIME_BUDGET_BULK', '3300')))
    elif paid and os.getenv('CHIPS_PARALLEL', '1') == '1':
        # 🚀 V71.2.7 批次走不通 → 第二條路:逐檔但「多 token 併發」。
        #   先濾掉「今天已抓過且已追上最新分點日」的,只預抓真正需要的那些。
        _todo = []
        for _s in watchlist:
            _f = chips_dir / f'{_s}.json'
            _eo: dict = {}
            if _f.exists():
                try:
                    _raw = json.loads(_f.read_text(encoding='utf-8'))
                    _eo = {'chips': _raw} if isinstance(_raw, list) else _raw
                except Exception:
                    _eo = {}
            _od = ''
            try:
                _ec = _eo.get('chips') or []
                if _ec:
                    _od = str(_ec[-1].get('date') or '')
            except Exception:
                pass
            _cur = (not _corpus_latest_dt) or (_od and _od >= _corpus_latest_dt)
            if (os.environ.get('FORCE_CHIPS_REFRESH') != '1'
                    and _eo.get('chips_fetched_on') == today_str
                    and _eo.get('periods') and _cur):
                continue
            _hot = _s in hot_set
            _todo.append((_s, 11 if _hot else 3, 16 if _hot else 6))
        try:
            _bulk_idx = _prefetch_chips_parallel(_todo, budget_s=_chips_budget)
            if _bulk_idx:
                # 預抓已花掉大部分預算,後面只剩解析寫檔(不打網路)→ 放寬避免白抓
                _chips_budget = max(_chips_budget, int(os.getenv('CHIPS_TIME_BUDGET_BULK', '3300')))
        except Exception as _e:
            print(f"  ⚠️ 併發預抓例外(退回原本單執行緒逐檔):{str(_e)[:80]}")
            _bulk_idx = None

    for sym in watchlist:
        # ⏱️ V68.9.8 時間預算到 → 本輪收工(已抓存檔;下輪「今日已抓→跳過」續抓未完成的股)
        if time.time() - _chips_start > _chips_budget:
            print(f"  ⏳ 分點時間預算 {_chips_budget}s 到,本輪先收工"
                  f"(更新 {updated} 檔 / 跳過今日已抓 {_skipped_today} 檔);剩餘下輪續抓")
            break
        _is_hot = sym in hot_set
        # ① 提前讀取 out_file → existing_obj（供 TTL 判斷和後面寫入共用）
        out_file = chips_dir / f'{sym}.json'
        existing_obj: dict = {}
        if out_file.exists():
            try:
                raw = json.loads(out_file.read_text(encoding='utf-8'))
                existing_obj = {'chips': raw} if isinstance(raw, list) else raw
            except Exception: pass

        # 🔁 V68.9.8 今日已抓過分點 → 跳過(滾動續抓核心:時間預算內往未抓的股推進)
        #    marker=chips_fetched_on(今日曆日),不靠交易日,盤中資料未出時也能正確跳過
        # 🐛 V71.1.5 修「越熱門越拿不到新資料」:
        #    舊條件只看「今天有沒有抓過」,不看「抓到的是不是最新那天」。
        #    實際發生的事:傍晚那輪先跑熱門股,當時 FinMind 還沒出當日分點 → 拿到前一交易日,
        #    卻被標記「今天抓過」→ 之後每一輪都跳過它;冷門股排在後面,輪到時當日分點已出 → 反而最新。
        #    實測結果完全顛倒:成交值前 100 名「全部」是舊的,冷門股 633 檔卻是最新的(5483 中美晶排第 34 也中招)。
        #    修法:再多比一個條件 —— 這檔自己的分點日必須「已經追上全市場最新分點日」才准跳過。
        _own_dt = ''
        try:
            _ec = existing_obj.get('chips') or []
            if _ec:
                _own_dt = str(_ec[-1].get('date') or '')
        except Exception:
            pass
        _is_current = (not _corpus_latest_dt) or (_own_dt and _own_dt >= _corpus_latest_dt)
        if (os.environ.get('FORCE_CHIPS_REFRESH') != '1'
                and existing_obj.get('chips_fetched_on') == today_str
                and existing_obj.get('periods')
                and _is_current):
            _skipped_today += 1
            continue

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
            data_rows = []
            if paid:   # 💰 降版:未付費 → 不打付費分點(免浪費 + 免錯誤重試),只靠上面 BSR
                # 💰 V68.2.7 分點正解:專屬端點 taiwan_stock_trading_daily_report(單日 date + Bearer)。
                #   逐日往回累積 ~11 個交易日(供 1/3/5/10 週期),含上櫃/冷門股如中美晶 5483。
                # V68.9.8 分層深度:熱門 11 交易日(1/3/5/10 週期);冷門 3 交易日(1/3 週期)控管額度
                _need_days = 11 if _is_hot else 3
                _lookback = 16 if _is_hot else 6
                seen_dates: set = set()
                # 🚀 V71.2.9【增量採礦】只補「本地還沒有的日期」——這是 1 把付費金鑰下當天採完的唯一解。
                #   實測(run 30423842005)證明:
                #     ・單日全市場批次被官方擋掉 → FinMind 回
                #       status=400 "parameter data_id can't be none on TaiwanStockTradingDailyReport"
                #     ・逐檔模式 35 分鐘只更新 143 檔(≈14.7 秒/檔),全市場 2,696 檔要 11 小時
                #   舊做法每天把 3~11 天「整個窗」重抓一次,但其中只有最新那 1 天是新的,
                #   其餘早在前幾輪就抓過、也已經存在本地 hist 裡 → 等於每天重複買 2~10 次同樣的資料。
                #   改成只抓缺的:穩定狀態下每檔每天 1 次 → 全市場 2,696 次 ≈ 28 分(95 次/分),裝得進預算。
                _have_dates = set()
                if os.environ.get('FORCE_CHIPS_REFRESH') != '1':
                    for _h in (existing_obj.get('hist') or []):
                        if isinstance(_h, dict) and _h.get('d'):
                            _have_dates.add(str(_h['d']))
                if _bulk_idx is not None:
                    # 🚀 V71.2.6 批次模式:資料已在記憶體,零 HTTP。
                    #   冷門股仍只留最近 3 個交易日(維持既有 JSON 大小,不讓 gh-pages 暴增),
                    #   熱門股拿滿 11 日 → 週期深度與舊行為一致。
                    _all = _bulk_idx.get(sym) or []
                    if _all:
                        _keep = sorted({str(r.get('date') or '') for r in _all})[-_need_days:]
                        data_rows = [r for r in _all if str(r.get('date') or '') in _keep]
                        seen_dates = set(_keep)
                for _d in ([] if _bulk_idx is not None else _recent_finmind_dates(_lookback)):
                    if len(seen_dates) >= _need_days:
                        break
                    if _d in _have_dates:
                        # 已經有這天的本地快照 → 不重複買。算進 seen_dates 讓「湊滿 N 天」正確收斂,
                        # 否則會一路往回翻到 _lookback 底,把省下來的呼叫又花掉。
                        seen_dates.add(_d)
                        continue
                    j = fm_paid_get('taiwan_stock_trading_daily_report', f'data_id={sym}&date={_d}') or {}
                    st = j.get('status'); rows = j.get('data') or []
                    if st in (402, 403):
                        print(f"    💰 分點 {sym} 回 {st}（{j.get('msg', '需付費')}）— 跳過")
                        data_rows = []
                        break
                    if st == 200 and rows:
                        sample = rows[0]
                        # 污染防呆:驗證是分點欄位(不是被誤導向其他資料)
                        if not any(k in sample for k in ('secBrokerId', 'securities_trader_id', 'broker_id')):
                            print(f"    ⚠️ 分點 {sym} 欄位不對 keys={list(sample.keys())[:8]} — 跳過避免污染")
                            data_rows = []
                            break
                        data_rows.extend(rows)
                        seen_dates.add(_d)
                    time.sleep(0.12)   # 溫柔節流(付費額度高,仍防打太快)
            if data_rows:
                by_date: dict = {}
                # 🚀 V71.2.9 增量採礦的另一半:只抓新的一天,舊的日子從本地 hist 還原,
                #   3/5/10 日週期才算得出來(否則只有 1 天資料,10d 會退化成 1d 完全失真)。
                #   hist 每天存的是當日前 N 名買/賣分點 [名稱, net, 均價];
                #   把 avg 還原成 pv/vol(以 |net| 當權重),下面既有的加權均價算式就能一體適用。
                for _h in (existing_obj.get('hist') or []):
                    if not isinstance(_h, dict) or not _h.get('d'):
                        continue
                    _hd = str(_h['d'])
                    _slot = by_date.setdefault(_hd, {})
                    for _arr in list(_h.get('b') or []) + list(_h.get('s') or []):
                        try:
                            _nm = str(_arr[0]); _nt = int(_arr[1])
                            _av = float(_arr[2]) if len(_arr) > 2 and _arr[2] is not None else None
                        except Exception:
                            continue
                        if not _nm or not _nt:
                            continue
                        _e = _slot.setdefault(_nm, {'broker_id': '', 'broker_name': _nm,
                                                    'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0})
                        _e['net'] += _nt
                        if _av is not None:
                            _e['pv'] += _av * abs(_nt); _e['vol'] += abs(_nt)
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
                    try: price = float(r.get('price') or 0)
                    except Exception: price = 0.0
                    slot = by_date.setdefault(d, {})
                    e = slot.setdefault(bid, {'broker_id': bid, 'broker_name': bnm, 'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0})
                    e['buy'] += buy; e['sel'] += sel; e['net'] += (buy - sel)
                    if price > 0:   # 💎 V68.3 均價:Σ(價×量)/Σ量(分點頁顯券商成交均價)
                        e['pv'] += price * (buy + sel); e['vol'] += (buy + sel)
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
                                # 🚀 V71.2.9 彙總鍵一律正規化成「分點名稱」——
                                #   新抓的日子以 broker_id 為鍵、從 hist 還原的日子以名稱為鍵,
                                #   不統一的話同一家分點會被當成兩筆各自累加(淨額直接腰斬/灌水)。
                                _k = (e.get('broker_name') or b) if not str(e.get('broker_name') or '').isdigit() else b
                                a = agg.setdefault(_k, {'broker_id': e.get('broker_id') or b,
                                                        'broker_name': e['broker_name'],
                                                        'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0})
                                a['net'] += e['net']
                                a['buy'] += e.get('buy', 0)
                                a['sel'] += e.get('sel', 0)
                                a['pv'] += e.get('pv', 0.0); a['vol'] += e.get('vol', 0)
                                if e['broker_name'] and not str(e['broker_name']).isdigit():
                                    a['broker_name'] = e['broker_name']
                                if not a.get('broker_id') and e.get('broker_id'):
                                    a['broker_id'] = e['broker_id']   # hist 還原的沒有 id,補上新抓到的
                        vals = list(agg.values())
                        for a in vals:   # 💎 均價 + 清掉中間累加欄(縮小 JSON)
                            a['avg'] = round(a['pv'] / a['vol'], 2) if a.get('vol') else None
                            a.pop('pv', None); a.pop('vol', None)
                        buy_top  = sorted([x for x in vals if x['net'] > 0], key=lambda x: -x['net'])[:15]
                        sell_top = sorted([x for x in vals if x['net'] < 0], key=lambda x:  x['net'])[:15]
                        return {'buy': buy_top, 'sell': sell_top}
                    # V68.9.8 熱門股完整 1/3/5/10 週期;冷門股只抓 3 日 → 只給 1/3d(5/10d 前端顯「熱門股才有」)
                    periods = {f'{n}d': _agg_period(n) for n in ((1, 3, 5, 10) if _is_hot else (1, 3))}
                    # Sniper 已拿到今日真分點時不被 FinMind 覆蓋(Sniper=官方 TWSE 較準);
                    # 否則用 FinMind 當日資料
                    if not sniper_data:
                        latest_chip_date = sorted(by_date.keys())[-1]
                        brokers_list = [{'bid': b, 'bnm': e['broker_name'], 'buy': e['buy'], 'sel': e['sel'], 'net': e['net']} for b, e in by_date[latest_chip_date].items()]
                        buyers  = sorted([b for b in brokers_list if b['net'] > 0], key=lambda x: -x['net'])[:15]
                        sellers = sorted([b for b in brokers_list if b['net'] < 0], key=lambda x: x['net'])[:15]
                time.sleep(3 if _is_hot else 1)   # V68.9.8 冷門股節流減半,全市場滾動更快
        except Exception as e:
            print(f"    ⚠️ 分點籌碼 {sym} 失敗: {e}")
            time.sleep(5)

        # ② 基本面 TTL 快取：若距上次查詢未逾 FUND_CACHE_DAYS 天，跳過 FinMind
        # V15.8 — 加版本檢查:cached_ver != MINER_VERSION 強制重抓(治本:schema 改動自動失效)
        # V15.9 — FORCE_FUND_REFRESH=1 env 一次性繞過 cache(不必 bump version 也能強制重抓)
        cached_fund = existing_obj.get('fundamentals') or {}
        generated_str = cached_fund.get('generated', '')
        cached_ver = cached_fund.get('miner_version', '')
        skip_finmind = False
        if generated_str and os.environ.get('FORCE_FUND_REFRESH') != '1':
            try:
                age_days = (date.today() - date.fromisoformat(generated_str)).days
                skip_finmind = (age_days < FUND_CACHE_DAYS) and (cached_ver == MINER_VERSION)
            except Exception: pass
        # 💎 V68.2.8 自我修復:快取雖「未過期」但根本沒 EPS/月營收(舊金鑰壞掉時抓到空的)→
        #   付費金鑰已修好時強制重抓,補上中美晶等上櫃冷門股的財報/月營收(對應基本面頁「暫無」)。
        if skip_finmind and detect_finmind_paid():
            _has_fund = bool(cached_fund.get('eps') or cached_fund.get('eps_history')
                             or cached_fund.get('revenue') or cached_fund.get('rev_yoy')
                             or cached_fund.get('monthly_revenue'))
            if not _has_fund:
                skip_finmind = False
                print(f"  ♻️ {sym} 快取無 EPS/營收(舊金鑰壞時抓空)→ 付費有效,強制重抓基本面")

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
            'periods': out_periods,   # 多週期：熱門{1d,3d,5d,10d} / 冷門{1d,3d}，各含 buy/sell（broker_name）
            'chips': [records_map[d] for d in recent_dates],
            'data_completeness': data_completeness,
            'tier': 'hot' if _is_hot else 'cold',   # V68.9.8 分層標記(冷門股週期較淺,前端據此顯示)
        }
        # 🔁 V68.9.8 只在真的拿到週期資料時才標記「今日已抓」→ 失敗不會誤標而永久跳過;
        #    失敗則沿用舊標記(舊標記若非今日,下輪仍會重試)
        if out_periods:
            output['chips_fetched_on'] = today_str
        elif existing_obj.get('chips_fetched_on'):
            output['chips_fetched_on'] = existing_obj['chips_fetched_on']

        # 📅 V69.1.6 逐日分點快照(rolling 10 交易日):供前端「昨日 vs 今日」真實比對誰跑掉/誰新進。
        #    每個交易日把當日(1d)前 15 買/賣分點壓縮成 [名稱, net] 存進 hist,dedup by date,只留最近 10 天。
        #    existing_obj 由 workflow「git checkout origin/data -- data/」還原 → hist 跨採礦累積不流失。
        try:
            def _compact_side(lst):
                out = []
                # 🚀 V71.2.9 15 → 25:hist 現在不只給前端看「昨日 vs 今日」,
                #   還要當增量採礦的「本地歷史底」重算 3/5/10 日週期。
                #   只留前 15 名的話,長天期彙總會漏掉常駐第 16~25 名的分點。
                for x in (lst or [])[:25]:
                    nm = x.get('broker_name') or str(x.get('broker_id') or '')
                    net = int(x.get('net') or 0)
                    if nm and not str(nm).isdigit() and net:
                        av = x.get('avg')
                        try:
                            av = round(float(av), 2) if av is not None else None
                        except Exception:
                            av = None
                        out.append([nm, net, av])   # [名稱, net(股), 買賣均價]
                return out
            _hist = existing_obj.get('hist')
            if not isinstance(_hist, list):
                _hist = []
            _p1 = (out_periods or {}).get('1d') or {}
            _dd = output.get('data_date')
            if _dd and (_p1.get('buy') or _p1.get('sell')):
                _snap = {'d': _dd, 'b': _compact_side(_p1.get('buy')), 's': _compact_side(_p1.get('sell'))}
                if _hist and isinstance(_hist[-1], dict) and _hist[-1].get('d') == _dd:
                    _hist[-1] = _snap        # 同一交易日重跑 → 覆蓋,不重複
                else:
                    _hist.append(_snap)
                _hist = _hist[-12:]          # 🚀 V71.2.9 10 → 12:10 日週期要算得完整,得多留 2 天緩衝
            if _hist:
                output['hist'] = _hist
        except Exception:
            if existing_obj.get('hist'):
                output['hist'] = existing_obj['hist']

        out_file.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')

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

    print(f"  ✅ 分點籌碼完成：更新 {updated} 檔、今日已抓跳過 {_skipped_today} 檔"
          f"（全市場滾動；熱門股天天更新、冷門長尾每幾天輪一次）")

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
            'vma5': vma5, 'upper_bb': upper_bb, 'recent_vols': vols[-3:]}


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


# ══════════════════════════════════════════════════════════════════
# 💎 V68.3.0 付費(FinMind Sponsor)壓箱寶:八大行庫護盤 / 借券空方 / 主力分點雷達
#    全部掛 detect_finmind_paid() → 未付費自動跳過(降版),不噴錯。輸出獨立 JSON,
#    靠 daily deploy 的 git archive origin/data 保留。欄名依 FinMind 官方 datasets 文件。
# ══════════════════════════════════════════════════════════════════
def fetch_govbank_buysell():
    """🏦 八大行庫(官股)買賣超 → data/govbank.json(政府護盤訊號)。
    近 ~16 日依 stock_id 聚合官股淨買賣(張)+ 近5/10日累計。未付費跳過。"""
    if not detect_finmind_paid():
        print("  ⏭️ 八大行庫:未付費,跳過(降版)")
        return
    # ✅ V68.3.4 實測 FinMind 探針定案(finmind_check.py):
    #    · 正確名 TaiwanStockGovernmentBankBuySell(大寫 S;文件小寫 Taiwanstock… 是錯的)
    #    · 這是 single-day 資料集:只帶「單一 start_date」、不帶 end_date(帶了回 400「size too large, we only send one day data」)、不帶 data_id(帶了回 400「data_id don't provide」)
    #    · 一次回全市場當日八大行庫買賣 → 逐交易日累積近 ~11 日
    DS = 'TaiwanStockGovernmentBankBuySell'
    rows = []
    seen_days = 0
    for d in _recent_finmind_dates(16):
        if seen_days >= 11:
            break
        jj = fm_paid_get('data', f'dataset={DS}&start_date={d}') or {}
        rr = jj.get('data') or []
        if rr:
            rows.extend(rr)
            seen_days += 1
        time.sleep(0.12)   # 溫柔節流(付費額度高,仍防打太快)
    if not rows:
        print("  ⚠️ 八大行庫:逐日單日抓皆無資料 — 保留舊檔")
        return
    by_stock: dict = {}
    for r in rows:
        sid = str(r.get('stock_id') or '').strip()
        if not _valid_stock(sid):
            continue
        d = str(r.get('date') or '')
        try:
            buy = int(float(r.get('buy') or 0)); sell = int(float(r.get('sell') or 0))
        except Exception:
            continue
        slot = by_stock.setdefault(sid, {})
        slot[d] = slot.get(d, 0) + (buy - sell)
    out: dict = {}
    for sid, dd in by_stock.items():
        ds = sorted(dd.keys())
        if not ds:
            continue
        out[sid] = {'d': ds[-1], 'net': dd[ds[-1]],
                    'net5': sum(dd[x] for x in ds[-5:]),
                    'net10': sum(dd[x] for x in ds[-10:]), 'days': len(ds)}
    if len(out) < 5:
        print(f"  ⚠️ 八大行庫只算到 {len(out)} 檔 — 保留舊檔不覆寫")
        return
    Path(DATA_DIR).mkdir(exist_ok=True)
    payload = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'data': out}
    tgt = Path(DATA_DIR) / 'govbank.json'; tmp = tgt.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(tmp), str(tgt))
    buyers = sum(1 for v in out.values() if v['net'] > 0)
    print(f"  ✅ 八大行庫護盤:{len(out)} 檔(今日官股買超 {buyers} 檔)→ data/govbank.json")


def fetch_securities_lending():
    """🩳 借券成交(空方布局)→ data/lending.json。觀察清單逐檔近 ~40 日,
    彙整借券量趨勢 + 費率 + 近5/前5日暴增倍數(暴增=有人大舉放空)。未付費跳過。"""
    if not detect_finmind_paid():
        print("  ⏭️ 借券:未付費,跳過(降版)")
        return
    sd = (date.today() - timedelta(days=45)).strftime('%Y-%m-%d')
    ed = date.today().strftime('%Y-%m-%d')
    out: dict = {}
    for sym in CHIP_WATCHLIST:
        j = fm_paid_get('data', f'dataset=TaiwanStockSecuritiesLending&data_id={sym}&start_date={sd}&end_date={ed}') or {}
        if j.get('status') in (402, 403):
            print(f"  💰 借券 {sym} 回 {j.get('status')} — 停(非付費層級)")
            break
        rows = j.get('data') or []
        by_date: dict = {}
        for r in rows:
            d = str(r.get('date') or '')
            try:
                vol = int(float(r.get('volume') or 0))
            except Exception:
                vol = 0
            e = by_date.setdefault(d, {'vol': 0, 'fee': None})
            e['vol'] += vol
            fr = r.get('fee_rate')
            if fr is not None:
                try: e['fee'] = float(fr)
                except Exception: pass
        ds = sorted(by_date.keys())
        if not ds:
            continue
        vol5 = sum(by_date[x]['vol'] for x in ds[-5:])
        prev5 = sum(by_date[x]['vol'] for x in ds[-10:-5]) if len(ds) >= 10 else 0
        out[str(sym)] = {'d': ds[-1], 'vol': by_date[ds[-1]]['vol'], 'fee': by_date[ds[-1]]['fee'],
                         'vol5': vol5, 'surge': round(vol5 / prev5, 2) if prev5 > 0 else None}
        time.sleep(0.12)
    if not out:
        print("  ⚠️ 借券:0 檔(非交易日/無資料)— 保留舊檔")
        return
    Path(DATA_DIR).mkdir(exist_ok=True)
    payload = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'data': out}
    tgt = Path(DATA_DIR) / 'lending.json'; tmp = tgt.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(tmp), str(tgt))
    surging = sum(1 for v in out.values() if v.get('surge') and v['surge'] >= 1.5)
    print(f"  ✅ 借券空方:{len(out)} 檔(借券暴增 {surging} 檔)→ data/lending.json")


# ══════════════════════════════════════════════════════════════════
# 💎 V69.7.8 付費資料第二彈:官方處置 / 當沖比 / 外資水位 / 鉅額 / 產業鏈 / CB / 權證溢價
#    同 V68.3.0 模式:detect_finmind_paid() 守門、空資料保留舊檔、原子寫檔。
#    ⚠️ 新檔案必須同步加進 daily_miner.yml chips-data artifact path 清單(V35.x 教訓)。
# ══════════════════════════════════════════════════════════════════
def _fm_write_json(fname: str, out: dict, label: str, extra: str = ''):
    """統一原子寫檔 + log(空 out 由呼叫端先擋)。"""
    Path(DATA_DIR).mkdir(exist_ok=True)
    payload = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'data': out}
    tgt = Path(DATA_DIR) / fname; tmp = tgt.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(tmp), str(tgt))
    print(f"  ✅ {label}:{len(out)} 檔{extra} → data/{fname}")


def _fm_bulk_days(dataset: str, want_days: int, look_back: int, sleep_s: float = 0.12) -> list:
    """single-day 資料集逐日 bulk(比照八大行庫實測:只帶單一 start_date、不帶 data_id/end_date)。
    回累積 rows;命中 want_days 個有資料的交易日就停。"""
    rows = []
    seen = 0
    for d in _recent_finmind_dates(look_back):
        if seen >= want_days:
            break
        jj = fm_paid_get('data', f'dataset={dataset}&start_date={d}') or {}
        rr = jj.get('data') or []
        if rr:
            rows.extend(rr)
            seen += 1
        time.sleep(sleep_s)
    return rows


def fetch_disposition_official():
    """🚨 官方處置有價證券(TaiwanStockDispositionSecuritiesPeriod)→ data/disposition.json。
    取代前端 8 款規則「推估」:官方公告的處置起迄日/第幾次/分盤條件。保留處置中 + 出關 14 天內。"""
    if not detect_finmind_paid():
        print("  ⏭️ 官方處置:未付費,跳過(降版)")
        return
    sd = (date.today() - timedelta(days=120)).strftime('%Y-%m-%d')
    ed = date.today().strftime('%Y-%m-%d')
    j = fm_paid_get('data', f'dataset=TaiwanStockDispositionSecuritiesPeriod&start_date={sd}&end_date={ed}') or {}
    rows = j.get('data') or []
    if not rows:   # 有些公告類資料集不吃 range → 退回逐日 bulk
        rows = _fm_bulk_days('TaiwanStockDispositionSecuritiesPeriod', 8, 20)
    if not rows:
        print(f"  ⚠️ 官方處置:無資料(status={j.get('status')} msg={str(j.get('msg'))[:60]})— 保留舊檔")
        return
    cutoff = (date.today() - timedelta(days=14)).strftime('%Y-%m-%d')
    out: dict = {}
    for r in rows:
        sid = str(r.get('stock_id') or '').strip()
        if not _valid_stock(sid):
            continue
        pe = str(r.get('period_end') or '')[:10]
        if not pe or pe < cutoff:
            continue   # 早就出關的舊公告不留
        rec = {'d': str(r.get('date') or '')[:10], 'cnt': r.get('disposition_cnt'),
               'cond': str(r.get('condition') or '')[:160], 'meas': str(r.get('measure') or '')[:120],
               'ps': str(r.get('period_start') or '')[:10], 'pe': pe}
        old = out.get(sid)
        if not old or pe > old['pe']:
            out[sid] = rec
    if not out:
        print("  ⚠️ 官方處置:過濾後 0 檔(近期無處置股?罕見)— 保留舊檔")
        return
    _fm_write_json('disposition.json', out, '官方處置', f"(處置中/剛出關)")


def fetch_daytrade_ratio():
    """⚡ 當沖比率(TaiwanStockDayTrading bulk ÷ SQLite 總量)→ data/daytrade.json。
    當沖比 5 成以上=浮額全是隔日沖客、籌碼虛;餵籌碼乾淨度 + 當沖頁。"""
    if not detect_finmind_paid():
        print("  ⏭️ 當沖比:未付費,跳過(降版)")
        return
    # 🩹 V69.8.4 P0-5:改讀 data/{sym}.json 的 volume 算總量。原版依賴 SQLite,
    #    但 chips job 沒有 stock_hunter.db → 永遠「保留舊檔」跳過,daytrade.json 從未產出。
    #    data/ 由 workflow 從 origin/data 還原(昨日 K),比率最多落後一天,誠實可接受。
    rows = _fm_bulk_days('TaiwanStockDayTrading', 6, 12)
    if not rows:
        print("  ⚠️ 當沖比:bulk 無資料 — 保留舊檔")
        return
    dt: dict = {}
    for r in rows:
        sid = str(r.get('stock_id') or '').strip()
        if not _valid_stock(sid):
            continue
        d = str(r.get('date') or '')[:10]
        try:
            v = int(float(r.get('Volume') or 0))
        except Exception:
            continue
        if v > 0:
            dt.setdefault(sid, {})[d] = v
    all_dates = sorted({d for m in dt.values() for d in m})
    if not all_dates:
        print("  ⚠️ 當沖比:0 檔 — 保留舊檔")
        return
    # 總量來源:data/{sym}.json(日K,date 格式 YYYY/MM/DD,volume 單位=股,與 FinMind 同)
    out: dict = {}
    for sid, m in dt.items():
        kf = Path(DATA_DIR) / f"{sid}.json"
        if not kf.exists():
            continue
        try:
            krows = json.loads(kf.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(krows, list):
            continue
        vol_map = {}
        for r in krows[-30:]:   # 只看近 30 根,夠涵蓋 6 個交易日
            d = str((r or {}).get('date') or '').replace('/', '-')
            try:
                v = int(float(r.get('volume') or 0))
            except Exception:
                continue
            if d and v > 0:
                vol_map[d] = v
        ds = sorted(m.keys())
        ratios = []
        last_d = None
        for d in ds:
            tot = vol_map.get(d)
            if tot and tot > 0:
                ratios.append(min(100.0, m[d] / tot * 100))
                last_d = d
        if not ratios:
            continue
        out[sid] = {'d': last_d, 'r': round(ratios[-1], 1), 'r5': round(sum(ratios[-5:]) / len(ratios[-5:]), 1)}
    if len(out) < 50:
        print(f"  ⚠️ 當沖比只算到 {len(out)} 檔(data/*.json 未還原?)— 保留舊檔")
        return
    hot = sum(1 for v in out.values() if v['r5'] >= 50)
    _fm_write_json('daytrade.json', out, '當沖比率', f"(5日均當沖比≥50% {hot} 檔)")


def fetch_foreign_shareholding():
    """🌐 外資持股水位(TaiwanStockShareholding bulk)→ data/foreign_hold.json。
    比單日買賣超更硬的趨勢:持股 % 現值 + 5/20 交易日前 + 窗內高低。"""
    if not detect_finmind_paid():
        print("  ⏭️ 外資水位:未付費,跳過(降版)")
        return
    rows = _fm_bulk_days('TaiwanStockShareholding', 21, 32)
    if not rows:
        print("  ⚠️ 外資水位:bulk 無資料 — 保留舊檔")
        return
    series: dict = {}
    for r in rows:
        sid = str(r.get('stock_id') or '').strip()
        if not _valid_stock(sid):
            continue
        d = str(r.get('date') or '')[:10]
        try:
            ratio = float(r.get('ForeignInvestmentSharesRatio'))
        except (TypeError, ValueError):
            continue
        if ratio > 100:   # 有些日期 FinMind 回千分比污染,防呆
            ratio = ratio / 10 if ratio <= 1000 else None
        if ratio is None or ratio < 0:
            continue
        series.setdefault(sid, {})[d] = ratio
    out: dict = {}
    for sid, m in series.items():
        ds = sorted(m.keys())
        if len(ds) < 3:
            continue
        vals = [m[d] for d in ds]
        r_now = vals[-1]
        r5 = vals[-6] if len(vals) >= 6 else vals[0]
        r20 = vals[-21] if len(vals) >= 21 else vals[0]
        out[sid] = {'d': ds[-1], 'r': round(r_now, 2), 'r5': round(r5, 2), 'r20': round(r20, 2),
                    'hi': round(max(vals), 2), 'lo': round(min(vals), 2)}
    if len(out) < 100:
        print(f"  ⚠️ 外資水位只算到 {len(out)} 檔 — 保留舊檔")
        return
    rising = sum(1 for v in out.values() if v['r'] - v['r20'] >= 0.5)
    _fm_write_json('foreign_hold.json', out, '外資持股水位', f"(20日增≥0.5% {rising} 檔)")


def fetch_block_trade():
    """🐘 鉅額交易(TaiwanStockBlockTrade bulk)→ data/blocktrade.json。
    大股東鉅額轉讓=出貨或引進策略投資人前兆;近月事件彙整,前端條件觸發警示。"""
    if not detect_finmind_paid():
        print("  ⏭️ 鉅額交易:未付費,跳過(降版)")
        return
    rows = _fm_bulk_days('TaiwanStockBlockTrade', 20, 30)
    if not rows:
        print("  ⚠️ 鉅額交易:bulk 無資料 — 保留舊檔")
        return
    agg: dict = {}
    for r in rows:
        sid = str(r.get('stock_id') or '').strip()
        if not _valid_stock(sid):
            continue
        d = str(r.get('date') or '')[:10]
        try:
            money = float(r.get('trading_money') or 0)
            vol = int(float(r.get('volume') or 0))
            price = float(r.get('price') or 0)
        except Exception:
            continue
        if money <= 0:
            continue
        e = agg.setdefault(sid, {'n': 0, 'm': 0.0, 'last': None})
        e['n'] += 1
        e['m'] += money
        if not e['last'] or d >= e['last']['d']:
            e['last'] = {'d': d, 'p': price, 'v': round(vol / 1000), 'm': round(money / 1e8, 2)}
    out = {sid: {'n': e['n'], 'm': round(e['m'] / 1e8, 2), 'last': e['last']}
           for sid, e in agg.items() if e['m'] >= 5e7}   # 近月合計 ≥5000 萬才留(雜訊過濾)
    if not out:
        print("  ⚠️ 鉅額交易:0 檔 — 保留舊檔")
        return
    _fm_write_json('blocktrade.json', out, '鉅額交易', f"(近月)")


def fetch_industry_chain():
    """🔗 產業鏈上下游(TaiwanStockIndustryChain)→ data/industry_chain.json。
    {sym: [[產業鏈, 子產業], …]};前端做「上游誰/下游誰/同鏈點名」。"""
    if not detect_finmind_paid():
        print("  ⏭️ 產業鏈:未付費,跳過(降版)")
        return
    j = fm_paid_get('data', 'dataset=TaiwanStockIndustryChain', timeout=30) or {}
    rows = j.get('data') or []
    if not rows:   # 需要日期參數的話退回帶今天
        j = fm_paid_get('data', f'dataset=TaiwanStockIndustryChain&start_date={date.today().strftime("%Y-%m-%d")}', timeout=30) or {}
        rows = j.get('data') or []
    if len(rows) < 300:
        print(f"  ⚠️ 產業鏈:僅 {len(rows)} 筆(status={j.get('status')})— 保留舊檔")
        return
    out: dict = {}
    for r in rows:
        sid = str(r.get('stock_id') or '').strip()
        if not _valid_stock(sid):
            continue
        ind = str(r.get('industry') or '').strip()
        sub = str(r.get('sub_industry') or '').strip()
        if not ind:
            continue
        lst = out.setdefault(sid, [])
        pair = [ind, sub]
        if pair not in lst and len(lst) < 12:
            lst.append(pair)
    if len(out) < 200:
        print(f"  ⚠️ 產業鏈:僅 {len(out)} 檔 — 保留舊檔")
        return
    _fm_write_json('industry_chain.json', out, '產業鏈')


def fetch_cb_balance():
    """💳 可轉債餘額異動(TaiwanStockConvertibleBondDailyOverview)→ data/cb_overview.json。
    CB 餘額近月大減=大戶轉換出貨/拉抬前兆(連籌碼K線都沒做);前端條件觸發警示。"""
    if not detect_finmind_paid():
        print("  ⏭️ 可轉債:未付費,跳過(降版)")
        return
    def _snap(anchor: date) -> dict:
        for i in range(8):
            d = (anchor - timedelta(days=i)).strftime('%Y-%m-%d')
            jj = fm_paid_get('data', f'dataset=TaiwanStockConvertibleBondDailyOverview&start_date={d}') or {}
            rr = jj.get('data') or []
            if rr:
                snap = {}
                for r in rr:
                    cb = str(r.get('cb_id') or '').strip()
                    try:
                        outamt = float(r.get('OutstandingAmount') or 0)
                        cp = float(r.get('ConversionPrice') or 0)
                    except Exception:
                        continue
                    if cb and outamt > 0:
                        snap[cb] = {'out': outamt, 'cp': cp, 'd': d}
                return snap
            time.sleep(0.12)
        return {}
    now_snap = _snap(date.today())
    if not now_snap:
        print("  ⚠️ 可轉債:今檔無資料 — 保留舊檔")
        return
    base_snap = _snap(date.today() - timedelta(days=30))
    out: dict = {}
    for cb, cur in now_snap.items():
        sid = cb[:4]
        if not _valid_stock(sid):
            continue
        base = base_snap.get(cb)
        chg = round((cur['out'] - base['out']) / base['out'] * 100, 1) if (base and base['out'] > 0) else None
        rec = {'cb': cb, 'd': cur['d'], 'out': round(cur['out'] / 1e8, 2), 'cp': cur['cp'], 'chg': chg}
        old = out.get(sid)
        if not old or cur['out'] > old['out'] * 1e8:
            rec['n'] = (old.get('n', 1) + 1) if old else 1
            out[sid] = rec
        else:
            old['n'] = old.get('n', 1) + 1
    if len(out) < 30:
        print(f"  ⚠️ 可轉債僅 {len(out)} 檔 — 保留舊檔")
        return
    dumping = sum(1 for v in out.values() if v.get('chg') is not None and v['chg'] <= -10)
    _fm_write_json('cb_overview.json', out, '可轉債餘額', f"(近月大減≥10% {dumping} 檔)")


def fetch_warrant_premium():
    """📜 權證溢價率(TaiwanStockInfoWithWarrantSummary)→ data/warrant_premium.json。
    補注意股 8 款規則裡一直缺資料的「第 8 款權證溢價」。認購權證溢價% 的中位數(每標的)。
    端點行為未實測:bulk 失敗自動退 data_id=標的;都失敗誠實跳過(前端規則8維持隱藏)。"""
    if not detect_finmind_paid():
        print("  ⏭️ 權證溢價:未付費,跳過(降版)")
        return
    rows = []
    for d in _recent_finmind_dates(6):
        jj = fm_paid_get('data', f'dataset=TaiwanStockInfoWithWarrantSummary&start_date={d}', timeout=30) or {}
        rr = jj.get('data') or []
        if rr:
            rows = rr
            break
        time.sleep(0.12)
    if not rows:
        # 退而求其次:data_id=標的逐檔(只掃觀察清單,驗證端點是否吃 target)
        probe = fm_paid_get('data', f'dataset=TaiwanStockInfoWithWarrantSummary&data_id=2330&start_date={_recent_finmind_dates(6)[-1]}') or {}
        pr = probe.get('data') or []
        if pr and str(pr[0].get('target_stock_id') or '') == '2330':
            for sym in CHIP_WATCHLIST:
                jj = fm_paid_get('data', f'dataset=TaiwanStockInfoWithWarrantSummary&data_id={sym}&start_date={_recent_finmind_dates(6)[-1]}') or {}
                rows.extend(jj.get('data') or [])
                time.sleep(0.12)
    if not rows:
        print("  ⚠️ 權證溢價:兩種端點形式皆無資料(需下次實測)— 跳過,前端規則8維持隱藏")
        return
    by_target: dict = {}
    for r in rows:
        tgt_id = str(r.get('target_stock_id') or '').strip()
        if not _valid_stock(tgt_id):
            continue
        typ = str(r.get('type') or '')
        if typ and ('售' in typ or 'put' in typ.lower()):
            continue   # 只算認購(溢價率過熱訊號)
        try:
            wc = float(r.get('close') or 0)          # 權證價
            tc = float(r.get('target_close') or 0)   # 標的價
            ratio = float(r.get('exercise_ratio') or 0)
            strike = float(r.get('fulfillment_price') or 0)
        except Exception:
            continue
        if wc <= 0 or tc <= 0 or ratio <= 0 or strike <= 0:
            continue
        prem = (wc / ratio + strike - tc) / tc * 100
        if -80 < prem < 300:
            by_target.setdefault(tgt_id, []).append(prem)
    out: dict = {}
    for sid, ps in by_target.items():
        if len(ps) < 3:
            continue
        ps.sort()
        out[sid] = {'n': len(ps), 'prem': round(ps[len(ps) // 2], 1)}
    if len(out) < 20:
        print(f"  ⚠️ 權證溢價僅 {len(out)} 檔 — 保留舊檔")
        return
    hot = sum(1 for v in out.values() if v['prem'] >= 30)
    _fm_write_json('warrant_premium.json', out, '權證溢價', f"(中位溢價≥30% {hot} 檔)")


def build_fmx_pack():
    """⚡ V69.8.6 P1-3:把付費第二彈 7 個小檔合併成單一 data/fmx_pack.json,
    前端啟動從 7 個 HTTP 請求降為 1 個(行動網路省 6 次 RTT)。
    各檔缺就略過該 key(前端有逐檔 fallback,不會壞)。"""
    files = {'dt': 'daytrade.json', 'fh': 'foreign_hold.json', 'bt': 'blocktrade.json',
             'cb': 'cb_overview.json', 'wp': 'warrant_premium.json', 'disp': 'disposition.json',
             'chain': 'industry_chain.json'}
    pack = {}
    for k, fname in files.items():
        f = Path(DATA_DIR) / fname
        if not f.exists():
            continue
        try:
            j = json.loads(f.read_text(encoding='utf-8'))
            if isinstance(j, dict) and j.get('data'):
                pack[k] = j['data']
        except Exception:
            continue
    if len(pack) < 3:
        print(f"  ⚠️ fmx_pack:只湊到 {len(pack)}/7 檔 — 保留舊檔")
        return
    _fm_write_json('fmx_pack.json', pack, 'fmx七合一', f"({len(pack)}/7 檔)")


def fetch_holder_distribution():
    """📊 集保股權持股分級 → data/holders.json(籌碼分佈:千張大戶/散戶 + 週趨勢)。
    欄位經 finmind_check 探針對 2330 實測:level(more than 1,000,001=千張大戶)/people/percent/unit;週頻(每週五結算)。
    HoldingSharesPer 是 Backer 層級,前端匿名抓不到 → 靠採礦 Sponsor 金鑰產靜態檔。逐檔觀察清單帶 data_id+start_date 取近~10週。"""
    if not detect_finmind_paid():
        print("  ⏭️ 集保分級:未付費,跳過")
        return
    DS = 'TaiwanStockHoldingSharesPer'
    BIG = 'more than 1,000,001'
    RETAIL = {'1-999', '1,000-5,000', '5,001-10,000'}
    sd = (date.today() - timedelta(days=75)).strftime('%Y-%m-%d')
    out: dict = {}
    for sym in CHIP_WATCHLIST:
        jj = fm_paid_get('data', f'dataset={DS}&data_id={sym}&start_date={sd}') or {}
        rows = jj.get('data') or []
        time.sleep(0.15)
        if not rows:
            continue
        by_date: dict = {}
        for r in rows:
            by_date.setdefault(str(r.get('date') or ''), {})[str(r.get('HoldingSharesLevel') or '')] = r
        dates = sorted(d for d in by_date.keys() if d)
        if not dates:
            continue

        def _pct(d, lv):
            try:
                return float((by_date[d].get(lv) or {}).get('percent') or 0)
            except Exception:
                return 0.0
        big_at = lambda d: _pct(d, BIG)
        retail_at = lambda d: sum(_pct(d, lv) for lv in RETAIL)
        latest = dates[-1]
        prev = dates[-2] if len(dates) >= 2 else None
        big_now = round(big_at(latest), 2)
        big_prev = round(big_at(prev), 2) if prev else None
        retail_now = round(retail_at(latest), 1)
        mid_now = round(max(0.0, 100.0 - big_now - retail_now), 1)
        big_row = by_date[latest].get(BIG) or {}
        try:
            people = int(float(big_row.get('people') or 0))
        except Exception:
            people = 0
        try:
            lots = round(float(big_row.get('unit') or 0) / 1000)
        except Exception:
            lots = 0
        hist = [round(big_at(d), 2) for d in dates[-8:]]
        out[sym] = {'d': latest, 'big': big_now, 'bigPrev': big_prev,
                    'retail': retail_now, 'mid': mid_now, 'people': people, 'lots': lots, 'hist': hist}
    if len(out) < 5:
        print(f"  ⚠️ 集保分級只算到 {len(out)} 檔 — 保留舊檔不覆寫")
        return
    Path(DATA_DIR).mkdir(exist_ok=True)
    payload = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'data': out}
    tgt = Path(DATA_DIR) / 'holders.json'
    tmp = tgt.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(tmp), str(tgt))
    adding = sum(1 for v in out.values() if v.get('bigPrev') is not None and v['big'] - v['bigPrev'] >= 0.3)
    print(f"  ✅ 集保籌碼分佈:{len(out)} 檔(大戶加碼 {adding} 檔)→ data/holders.json")


def build_broker_radar():
    """🕵️ 主力分點雷達 → data/broker_radar.json:彙整各股 data/chips/*.json 今日(1d)分點,
    產「今日主力最猛買超/賣超股票排行」+「各分點跨股買賣」(跟單神器)。純後處理零 API。"""
    cdir = Path(DATA_DIR) / 'chips'
    if not cdir.exists():
        print("  ⏭️ 主力雷達:無 chips 目錄,跳過")
        return
    stock_top: list = []
    broker_map: dict = {}
    for f in cdir.glob('*.json'):
        sym = f.stem
        try:
            obj = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(obj, dict):   # 🛡️ 有些 chips 檔是純 list(舊格式)→ 無 periods,跳過
            continue
        periods = obj.get('periods')
        per = (periods.get('1d') if isinstance(periods, dict) else None) or {}
        if not isinstance(per, dict):
            continue
        buys = per.get('buy') or []; sells = per.get('sell') or []
        if buys:
            t = buys[0]
            stock_top.append({'sym': sym, 'side': 'buy', 'broker': t.get('broker_name'), 'net': int(t.get('net') or 0)})
        if sells:
            t = sells[0]
            stock_top.append({'sym': sym, 'side': 'sell', 'broker': t.get('broker_name'), 'net': int(t.get('net') or 0)})
        for x in buys:
            bn = x.get('broker_name'); net = int(x.get('net') or 0)
            if bn and not str(bn).isdigit() and net > 0:
                broker_map.setdefault(bn, {'buy': [], 'sell': []})['buy'].append({'sym': sym, 'net': net})
        for x in sells:
            bn = x.get('broker_name'); net = int(x.get('net') or 0)
            if bn and not str(bn).isdigit() and net < 0:
                broker_map.setdefault(bn, {'buy': [], 'sell': []})['sell'].append({'sym': sym, 'net': net})
    buy_rank = sorted([x for x in stock_top if x['side'] == 'buy'], key=lambda x: -x['net'])[:30]
    sell_rank = sorted([x for x in stock_top if x['side'] == 'sell'], key=lambda x: x['net'])[:30]
    brokers: dict = {}
    for bn, d in broker_map.items():
        d['buy'] = sorted(d['buy'], key=lambda x: -x['net'])[:10]
        d['sell'] = sorted(d['sell'], key=lambda x: x['net'])[:10]
        if d['buy'] or d['sell']:
            brokers[bn] = d
    Path(DATA_DIR).mkdir(exist_ok=True)
    payload = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'buy_rank': buy_rank, 'sell_rank': sell_rank, 'brokers': brokers}
    tgt = Path(DATA_DIR) / 'broker_radar.json'; tmp = tgt.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(tmp), str(tgt))
    print(f"  ✅ 主力雷達:買超榜 {len(buy_rank)} / 賣超榜 {len(sell_rank)} / 分點 {len(brokers)} 家 → data/broker_radar.json")


# ── 外資/官股/隔日沖 分點名稱樣式(供屬性標籤) ──────────────────────────────
_FOREIGN_KW = ('美林', '摩根', '高盛', '瑞銀', '野村', '港商', '花旗', '美商', '摩根士丹利',
               '德意志', '麥格理', '里昂', '瑞信', '新加坡商', '法商', '摩根大通', 'jp', 'ubs')
_GOVBANK_KW = ('合庫', '合作金庫', '臺灣銀行', '台銀', '土地銀行', '土銀', '兆豐', '第一金',
               '華南', '彰銀', '臺企銀', '台企銀', '農業金庫', '國泰世華')


def _classify_broker(bid, name):
    """🏷️ 分點屬性標籤(純規則零 API)。回 list[str]:daytrade/foreign/govbank/trust/retail_hub。"""
    tags = []
    nm = str(name or '')
    tag_src = str(TACTICAL_TAGS.get(bid, '')) + ' ' + nm
    if any(k in tag_src for k in ('隔日沖', '當沖', '虎爺')):
        tags.append('daytrade')
    low = nm.lower()
    if any(k in nm for k in _FOREIGN_KW) or any(k in low for k in ('jp', 'ubs')):
        tags.append('foreign')
    if any(k in nm for k in _GOVBANK_KW):
        tags.append('govbank')
    if '投信' in nm:
        tags.append('trust')
    if '避險' in tag_src:
        tags.append('hedge')   # 權證避險分點(大量進出 ETF/權值,非主力布局訊號)
    if '總公司' in nm or '總部' in nm:
        tags.append('retail_hub')
    return tags


def build_broker_book():
    """🕵️ 分點檔案 → data/broker_book.json:以 broker_id 併檔(修「美林/美林證券」名稱裂開),
    多週期(1d/5d/10d)反查各分點在買/賣什麼股 + 屬性標籤 + 歷史勝率(接 broker_perf)
    + 行為(布局型 vs 隔日沖型)+ 新卡位偵測 + 排行榜 + 聯軍偵測。純後處理零 API。"""
    cdir = Path(DATA_DIR) / 'chips'
    if not cdir.exists():
        print("  ⏭️ 分點檔案:無 chips 目錄,跳過"); return
    from collections import Counter
    PERIODS = ('1d', '5d', '10d')
    book: dict = {}   # bid -> {'names':Counter, 'per':{p:{sym:{net,buy,sel,avg}}}}
    sym_totbuy: dict = {}   # sym -> {p: 全市場當期總買超股數}(供算集中度,unit-safe 同源分點資料)
    # 產業對照(供資金流向板塊;缺檔則略)
    industry_map: dict = {}
    try:
        industry_map = json.loads((Path(DATA_DIR) / 'industry_map.json').read_text(encoding='utf-8')) or {}
    except Exception:
        industry_map = {}
    for f in cdir.glob('*.json'):
        sym = f.stem
        if not _valid_stock(sym):
            continue
        try:
            obj = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        pers = obj.get('periods')
        if not isinstance(pers, dict):
            continue
        recs = obj.get('chips') or []
        sym_totbuy[sym] = {wn: sum(int(r.get('tot_buy') or 0) for r in recs[-nd:] if isinstance(r, dict))
                           for wn, nd in (('1d', 1), ('5d', 5), ('10d', 10))}
        for p in PERIODS:
            pd = pers.get(p)
            if not isinstance(pd, dict):
                continue
            for side in ('buy', 'sell'):
                for x in (pd.get(side) or []):
                    bid = str(x.get('broker_id') or '').strip()
                    if not bid or ',' in bid or len(bid) > 5:
                        continue
                    bnm = x.get('broker_name')
                    b = book.setdefault(bid, {'names': Counter(), 'per': {}})
                    if bnm and not str(bnm).isdigit():
                        b['names'][str(bnm)] += 1
                    slot = b['per'].setdefault(p, {})
                    e = slot.setdefault(sym, {'net': 0, 'buy': 0, 'sel': 0, 'avg': None})
                    e['net'] += int(x.get('net') or 0)
                    e['buy'] += int(x.get('buy') or 0)
                    e['sel'] += int(x.get('sel') or 0)
                    if x.get('avg'):
                        e['avg'] = x.get('avg')

    # 歷史勝率:接 broker_perf(以「分點名」比對,近似)
    perf_by_name: dict = {}
    try:
        pf = json.loads((Path(DATA_DIR) / 'broker_perf.json').read_text(encoding='utf-8'))
        for bucket in ('daytrade', 'short', 'swing'):
            for r in (pf.get(bucket) or []):
                nm = str(r.get('broker') or '')
                perf_by_name.setdefault(nm, {})[bucket] = {'win': r.get('win_rate'), 'ret': r.get('avg_ret'), 'n': r.get('count')}
    except Exception:
        perf_by_name = {}

    def _match_perf(name):
        if name in perf_by_name:
            return perf_by_name[name]
        base = re.split(r'[-(（]', name)[0]
        for k, v in perf_by_name.items():
            if base and (k.startswith(base) or base in k):
                return v
        return {}

    def _behavior(sym, per):
        """布局型 vs 隔日沖型:比 1d/5d/10d 淨額 + 當日買賣對敲。"""
        n1 = (per.get('1d', {}).get(sym) or {}).get('net', 0)
        n5 = (per.get('5d', {}).get(sym) or {}).get('net', 0)
        n10 = (per.get('10d', {}).get(sym) or {}).get('net', 0)
        d1 = per.get('1d', {}).get(sym) or {}
        buy1, sel1 = d1.get('buy', 0), d1.get('sel', 0)
        churn = (min(buy1, sel1) / max(buy1, sel1)) if max(buy1, sel1) > 0 else 0
        if churn >= 0.6 and (buy1 + sel1) > 0:
            return 'churn'        # 當日對敲/當沖(買賣都大、淨額小)
        if n1 > 0 and n10 >= n1 * 1.8:
            return 'accumulate'   # 布局型:多日持續加碼(10日淨額遠大於今日)
        if n1 > 0 and n5 <= n1 * 0.6:
            return 'daytrade'     # 隔日沖型:今天買、5日內沒留住
        if n1 > 0:
            return 'hold'         # 有留倉但非明顯加碼
        return 'flat'

    brokers: dict = {}
    for bid, b in book.items():
        name = TACTICAL_TAGS.get(bid) or (b['names'].most_common(1)[0][0] if b['names'] else bid)
        per = b['per']
        out_per: dict = {}
        for p in PERIODS:
            slot = per.get(p, {})
            buys = sorted([{'sym': s, **v} for s, v in slot.items() if v['net'] > 0], key=lambda x: -x['net'])[:15]
            sells = sorted([{'sym': s, **v} for s, v in slot.items() if v['net'] < 0], key=lambda x: x['net'])[:15]
            if p == '1d':
                for it in buys:
                    it['beh'] = _behavior(it['sym'], per)
                    n1 = it['net']; n10 = (per.get('10d', {}).get(it['sym']) or {}).get('net', 0)
                    it['new'] = bool(n1 > 0 and n10 <= n1 * 1.25)   # 新卡位:部位幾乎全來自今天
                    # 🎯 集中度/鎖籌:此分點買超股數佔全市場當日總買超 %(unit-safe,同源分點資料)
                    tot = (sym_totbuy.get(it['sym']) or {}).get('1d', 0)
                    it['conc'] = round(it['buy'] / tot * 100, 1) if tot > 0 else None
            out_per[p] = {'buy': buys, 'sell': sells}
        tot_buy_1d = sum(x['net'] for x in out_per['1d']['buy'])
        if not (out_per['1d']['buy'] or out_per['1d']['sell'] or out_per['5d']['buy'] or out_per['10d']['buy']):
            continue
        # 💵 資金流向:今日總買超金額(股×均價,元)+ 板塊分布(top2 產業)
        tot_buy_val = 0.0
        sec_agg: dict = {}
        for it in out_per['1d']['buy']:
            val = (it.get('buy') or 0) * (it.get('avg') or 0)
            tot_buy_val += val
            ind = industry_map.get(it['sym'])
            if ind:
                sec_agg[ind] = sec_agg.get(ind, 0) + val
        sectors = [{'name': k, 'val': int(v)} for k, v in sorted(sec_agg.items(), key=lambda x: -x[1])[:2]]
        # 🌱 認養股:近 10 日 ∩ 近 5 日都在買超榜(持續布局同一檔)= 該分點的「本命股」
        _b5 = {x['sym'] for x in out_per['5d']['buy']}
        _b10 = {x['sym']: x['net'] for x in out_per['10d']['buy']}
        adopt = sorted([{'sym': s, 'net': n} for s, n in _b10.items() if s in _b5],
                       key=lambda x: -x['net'])[:4]
        brokers[bid] = {
            'id': bid, 'name': name, 'tags': _classify_broker(bid, name),
            'win': _match_perf(name), 'per': out_per,
            'tot_buy_1d': tot_buy_1d, 'n_buy_1d': len(out_per['1d']['buy']),
            'tot_buy_val': int(tot_buy_val), 'sectors': sectors, 'adopt': adopt,
        }

    # ── 排行榜 ──────────────────────────────────────────────────────────────
    lst = list(brokers.values())
    buy_today = sorted(lst, key=lambda x: -x['tot_buy_1d'])[:20]
    def _best_win(b):
        vs = [v.get('win') for v in b['win'].values() if isinstance(v, dict) and v.get('win') is not None]
        return max(vs) if vs else -1
    win_rank = sorted([b for b in lst if _best_win(b) >= 0], key=lambda b: -_best_win(b))[:20]
    # 神秘黑馬:高勝率 + 非大型連鎖(名字沒總公司/知名隔日沖標)
    mystery = sorted([b for b in lst if _best_win(b) >= 55 and 'retail_hub' not in b['tags']
                      and 'daytrade' not in b['tags'] and b['tot_buy_1d'] > 0],
                     key=lambda b: -_best_win(b))[:15]
    daytrade_fire = sorted([b for b in lst if 'daytrade' in b['tags'] and b['tot_buy_1d'] > 0],
                           key=lambda x: -x['tot_buy_1d'])[:15]

    def _slim(b):
        return {'id': b['id'], 'name': b['name'], 'tags': b['tags'], 'win': b['win'],
                'tot_buy_1d': b['tot_buy_1d'], 'n_buy_1d': b['n_buy_1d'],
                'top': [x['sym'] for x in b['per']['1d']['buy'][:5]]}
    rank = {'buy_today': [_slim(b) for b in buy_today], 'win': [_slim(b) for b in win_rank],
            'mystery': [_slim(b) for b in mystery], 'daytrade_fire': [_slim(b) for b in daytrade_fire]}

    # ── 聯軍偵測:哪些分點常「一起買同一檔」(5日買超交集) ──────────────────
    #   只看今日活躍(tot_buy_1d>0)且非隔日沖的分點,取 5日買超股集合兩兩交集 ≥2 檔
    active = [b for b in lst if b['tot_buy_1d'] > 0 and 'daytrade' not in b['tags']]
    active = sorted(active, key=lambda x: -x['tot_buy_1d'])[:60]   # 限前 60 家算 pair,控複雜度
    setmap = {b['id']: set(x['sym'] for x in b['per']['5d']['buy']) for b in active}
    namemap = {b['id']: b['name'] for b in active}
    alliances = []
    ids = list(setmap.keys())
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            common = setmap[ids[i]] & setmap[ids[j]]
            if len(common) >= 2:
                alliances.append({'a': namemap[ids[i]], 'b': namemap[ids[j]],
                                  'stocks': sorted(common)[:6], 'n': len(common)})
    alliances = sorted(alliances, key=lambda x: -x['n'])[:20]

    # ── 🎯 跟單精選榜:合成「今日最值得跟的主力買盤」──────────────────────────
    #   只取「高品質分點」(排隔日沖/避險/散戶大本營)× 好行為(布局/新卡位/留倉),
    #   依 行為 + 歷史勝率 + 身分(官股/外資/投信/神秘) + 集中度 給分,同股多家好分點買 → 分數疊加。
    picks: dict = {}
    for b in lst:
        tags = b['tags']
        if any(t in tags for t in ('daytrade', 'hedge', 'retail_hub')):
            continue
        bw = _best_win(b)
        for it in b['per']['1d']['buy']:
            if str(it['sym']).startswith('00'):
                continue   # 排 ETF(銀行/官股買 ETF=定期定額/護盤,非主力布局個股;精選只留真個股)
            beh = it.get('beh')
            if beh in ('churn', 'daytrade', 'flat'):
                continue
            sc = {'accumulate': 40, 'new': 25, 'hold': 12}.get(beh, 0)
            if it.get('new'):
                sc += 20
            if bw >= 60:
                sc += 30
            elif bw >= 55:
                sc += 20
            elif bw >= 50:
                sc += 10
            if 'govbank' in tags:
                sc += 20
            if 'foreign' in tags:
                sc += 15
            if 'trust' in tags:
                sc += 10
            conc = it.get('conc') or 0
            if conc >= 15:
                sc += 15
            elif conc >= 8:
                sc += 8
            if sc <= 0:
                continue
            pk = picks.setdefault(it['sym'], {'sym': it['sym'], 'score': 0, 'whos': []})
            pk['score'] += sc
            pk['whos'].append({'name': b['name'], 'beh': beh, 'new': bool(it.get('new')),
                               'win': (bw if bw >= 0 else None), 'conc': it.get('conc'), 'tags': tags})
    follow_picks = sorted(picks.values(), key=lambda x: -x['score'])[:20]
    for fp in follow_picks:
        fp['whos'] = sorted(fp['whos'], key=lambda w: -((w['win'] or 0)))[:5]
        fp['n_broker'] = len(fp['whos'])
        fp['score'] = round(fp['score'])

    # ── ⚔️ 對敲/作價警示:同分點同股當日買賣都大(churn)──────────────────────
    churn_list = []
    for b in lst:
        if 'hedge' in b['tags']:
            continue   # 避險本來就大進大出,不算作價
        for it in b['per']['1d']['buy']:
            if str(it['sym']).startswith('00'):
                continue   # 排 ETF(槓桿型 ETF 大進大出是常態,非作價)
            if it.get('beh') == 'churn':
                churn_list.append({'broker': b['name'], 'sym': it['sym'],
                                   'buy': it.get('buy', 0), 'sel': it.get('sel', 0)})
    churn_list = sorted(churn_list, key=lambda x: -(x['buy'] + x['sel']))[:15]

    # ── 🏛️ 重要券商:官股/外資/大型/中型/小型 分點損益(近5/10日浮動,萬元)──────────
    #   以「券商公司」(分點名去分行後綴)彙整各分行 5d/10d 持股浮動損益 =(現價−買超均價)×淨股數。
    _close_cache: dict = {}

    def _latest_close(sym):
        if sym in _close_cache:
            return _close_cache[sym]
        c = None
        try:
            arr = json.loads((Path(DATA_DIR) / f'{sym}.json').read_text(encoding='utf-8'))
            if isinstance(arr, list):
                for r in reversed(arr):
                    cc = r.get('close')
                    if cc and float(cc) > 0:
                        c = float(cc); break
        except Exception:
            c = None
        _close_cache[sym] = c
        return c

    def _slot_pnl(slot):
        tot = 0.0
        for sym, v in slot.items():
            cl = _latest_close(sym)
            if cl and v.get('avg') and v.get('net'):
                tot += (cl - float(v['avg'])) * v['net']   # 元
        return tot / 10000.0   # → 萬元

    firms: dict = {}   # firm -> {pnl5,pnl10,activity,gov,foreign}
    for bid, b in book.items():
        name = TACTICAL_TAGS.get(bid) or (b['names'].most_common(1)[0][0] if b['names'] else bid)
        firm = re.split(r'[-－(（]', str(name))[0].strip() or str(name)
        tags = _classify_broker(bid, name)
        per = b['per']
        p5 = _slot_pnl(per.get('5d', {}))
        p10 = _slot_pnl(per.get('10d', {}))
        act = sum(abs(v.get('net', 0)) for v in per.get('5d', {}).values())
        fr = firms.setdefault(firm, {'name': firm, 'pnl5': 0.0, 'pnl10': 0.0, 'activity': 0, 'gov': False, 'foreign': False})
        fr['pnl5'] += p5; fr['pnl10'] += p10; fr['activity'] += act
        if 'govbank' in tags:
            fr['gov'] = True
        if 'foreign' in tags:
            fr['foreign'] = True
    flist = list(firms.values())
    for fr in flist:
        fr['pnl5'] = round(fr['pnl5'], 1); fr['pnl10'] = round(fr['pnl10'], 1)
    gov = sorted([f for f in flist if f['gov']], key=lambda x: -x['pnl5'])[:8]
    foreign = sorted([f for f in flist if f['foreign'] and not f['gov']], key=lambda x: -x['pnl5'])[:8]
    rest = sorted([f for f in flist if not f['gov'] and not f['foreign']], key=lambda x: -x['activity'])
    large, mid, small = rest[:8], rest[8:23], rest[23:38]
    large = sorted(large, key=lambda x: -x['pnl5'])
    mid = sorted(mid, key=lambda x: -x['pnl5'])
    small = sorted(small, key=lambda x: -x['pnl5'])
    def _slimf(f):
        return {'name': f['name'], 'pnl5': f['pnl5'], 'pnl10': f['pnl10']}
    important = {'gov': [_slimf(f) for f in gov], 'foreign': [_slimf(f) for f in foreign],
                 'large': [_slimf(f) for f in large], 'mid': [_slimf(f) for f in mid],
                 'small': [_slimf(f) for f in small]}

    payload = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'brokers': brokers, 'rank': rank, 'alliances': alliances,
               'follow_picks': follow_picks, 'churn': churn_list, 'important': important}
    tgt = Path(DATA_DIR) / 'broker_book.json'; tmp = tgt.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(str(tmp), str(tgt))
    print(f"  ✅ 分點檔案:{len(brokers)} 家(id 併檔) / 排行 {len(buy_today)} / 聯軍 {len(alliances)} 組 → data/broker_book.json")


def build_broker_perf():
    """🧙 券商分點勝率榜 → data/broker_perf.json(前瞻回測 + 即時浮動雙軌)
    ① 累積:每日把各股當日(1d)分點買超(broker, sym, 買超均價)存進 data/broker_signals.json(滾動 ~45 交易日)。
    ② 前瞻回測:對每筆歷史訊號,查 SQLite 該股訊號日之後 1/5/20 交易日收盤 → 隔日沖/短線/波段的勝率+平均報酬。
    ③ 即時浮動:當日/20日買超均價 vs 最新收盤(day-1 就有資料,前瞻累積夠之前先頂著)。
    純後處理零 API;需 chips + SQLite stock_history(chips job 已 restore origin/data)。"""
    cdir = Path(DATA_DIR) / 'chips'
    if not cdir.exists():
        print("  ⏭️ 券商勝率榜:無 chips 目錄,跳過")
        return

    series_cache: dict = {}

    def get_series(sym):
        # 🐛 V68.9.5 修:chips job(ONLY_CHIPS)沒把 OHLCV 灌進 SQLite → 原本查 stock_history 全空
        #   → 收盤價 None → 前瞻/浮動/回填全 0。改讀 data/{sym}.json(chips job 已 restore origin/data,
        #   同 top_picks/radar 的來源)。日期正規化成橫線(JSON 是 2026/07/20 斜線、訊號日是橫線,不統一字串比對會全 skip)。
        if sym in series_cache:
            return series_cache[sym]
        s = []
        try:
            p = Path(DATA_DIR) / f'{sym}.json'
            if p.exists():
                arr = json.loads(p.read_text(encoding='utf-8'))
                if isinstance(arr, list):
                    for r in arr:
                        d = str(r.get('date') or '')[:10].replace('/', '-')
                        c = r.get('close')
                        v = r.get('volume', 1)
                        if d and c and float(c) > 0 and (v is None or float(v) > 0):
                            s.append((d, float(c)))
                    s.sort(key=lambda x: x[0])
        except Exception:
            s = []
        series_cache[sym] = s
        return s

    def latest_close(sym):
        s = get_series(sym)
        return s[-1][1] if s else None

    # ── ① 讀既有累積訊號(chips job 已從 origin/data restore data/)──
    sig_path = Path(DATA_DIR) / 'broker_signals.json'
    try:
        hist = json.loads(sig_path.read_text(encoding='utf-8')) if sig_path.exists() else []
    except Exception:
        hist = []
    if not isinstance(hist, list):
        hist = []

    float_short: dict = {}
    float_swing: dict = {}

    def fadd(agg, name, ret):
        a = agg.setdefault(name, {'wins': 0, 'total': 0, 'ret': 0.0})
        a['total'] += 1
        a['ret'] += ret
        if ret > 0:
            a['wins'] += 1

    todays = []
    seen_dates = set()
    for f in cdir.glob('*.json'):
        sym = f.stem
        try:
            obj = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        periods = obj.get('periods')
        if not isinstance(periods, dict):
            continue
        sig_date = str(obj.get('data_date') or '')[:10]
        cur = latest_close(sym)
        # 即時浮動(1d / 20d 買超均價 vs 現價)
        for win, agg in (('1d', float_short), ('10d', float_swing)):   # 🐛 V68.9.5 chips 無 20d bucket → 用 10d(最長)
            buys = (periods.get(win) or {}).get('buy') or []
            if not buys or not cur:
                continue
            for x in buys:
                name = x.get('broker_name'); avg = x.get('avg'); net = int(x.get('net') or 0)
                if not name or str(name).isdigit() or not avg or float(avg) <= 0 or net <= 0:
                    continue
                ret = (cur - float(avg)) / float(avg) * 100
                if -30 <= ret <= 30:
                    fadd(agg, name, ret)
        # 累積訊號(當日 1d 買超前 5 大分點)
        if sig_date:
            seen_dates.add(sig_date)
            for x in ((periods.get('1d') or {}).get('buy') or [])[:5]:
                name = x.get('broker_name'); avg = x.get('avg'); net = int(x.get('net') or 0)
                if not name or str(name).isdigit() or not avg or float(avg) <= 0 or net <= 0:
                    continue
                todays.append({'d': sig_date, 'b': name, 's': sym, 'p': round(float(avg), 2)})

    # 去掉今日既有(避免同日重複累積)再併入,滾動保留最近 45 交易日
    if seen_dates:
        hist = [h for h in hist if h.get('d') not in seen_dates]
    hist.extend(todays)
    keep_dates = set(sorted({h['d'] for h in hist if h.get('d')}, reverse=True)[:45])
    hist = [h for h in hist if h.get('d') in keep_dates]

    # ── ② 前瞻回測(訊號日均價 → N 交易日後收盤)──
    HZ = (('daytrade', 1), ('short', 5), ('swing', 20))
    fwd = {k: {} for k, _ in HZ}
    for h in hist:
        sym = h.get('s'); entry = h.get('p'); d = h.get('d')
        if not sym or not entry or entry <= 0 or not d:
            continue
        series = get_series(sym)
        if not series:
            continue
        idx = None
        for i, (dt, _c) in enumerate(series):
            if dt >= d:
                idx = i
                break
        if idx is None:
            continue
        for k, n in HZ:
            j = idx + n
            if j >= len(series):
                continue   # 訊號太新,還沒到 N 交易日後
            ret = (series[j][1] - entry) / entry * 100
            if ret < -40 or ret > 60:
                continue
            a = fwd[k].setdefault(h['b'], {'wins': 0, 'total': 0, 'ret': 0.0})
            a['total'] += 1
            a['ret'] += ret
            if ret > 0:
                a['wins'] += 1

    # ── ②b 歷史回推(近似,過渡用):沒逐日分點史 → 用現有 chips 的 5d/20d 買超均價當合成訊號,
    #     forward-test 到最新收盤(≈持有 5/20 交易日的結果),讓短線/波段榜「不用等」立刻有樣本。
    #     ⚠️ 近似:entry 是區間均價非逐日精確。獨立計數 bf_added,真實前瞻訊號逐日累積後自然稀釋為真數據。
    bf_added = {'short': 0, 'swing': 0}
    for f in cdir.glob('*.json'):
        sym = f.stem
        try:
            obj = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        periods = obj.get('periods') if isinstance(obj, dict) else None
        if not isinstance(periods, dict):
            continue
        cur = latest_close(sym)
        if not cur:
            continue
        for win, hz in (('5d', 'short'), ('10d', 'swing')):   # 🐛 V68.9.5 chips 無 20d → swing 回填改用 10d bucket
            for x in ((periods.get(win) or {}).get('buy') or [])[:5]:
                name = x.get('broker_name'); avg = x.get('avg'); net = int(x.get('net') or 0)
                if not name or str(name).isdigit() or not avg or float(avg) <= 0 or net <= 0:
                    continue
                ret = (cur - float(avg)) / float(avg) * 100
                if ret < -40 or ret > 60:
                    continue
                a = fwd[hz].setdefault(name, {'wins': 0, 'total': 0, 'ret': 0.0})
                a['total'] += 1; a['ret'] += ret
                if ret > 0:
                    a['wins'] += 1
                bf_added[hz] += 1
    print(f"  📼 歷史回推(近似):短線 +{bf_added['short']} 筆、波段 +{bf_added['swing']} 筆 合成訊號")

    def rank(agg, min_pos):
        rows = []
        for name, a in agg.items():
            if a['total'] < min_pos:
                continue
            rows.append({'broker': name,
                         'win_rate': round(a['wins'] / a['total'] * 100, 1),
                         'avg_ret': round(a['ret'] / a['total'], 2),
                         'count': a['total']})
        rows.sort(key=lambda r: (-r['win_rate'], -r['avg_ret']))
        return rows[:30]

    payload = {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'daytrade': rank(fwd['daytrade'], 12),
        'short': rank(fwd['short'], 8),
        'swing': rank(fwd['swing'], 8),
        'float_short': rank(float_short, 8),
        'float_swing': rank(float_swing, 8),
        'signals': len(hist), 'days': len(keep_dates),
        'backfill': bf_added,   # 短線/波段榜含幾筆歷史回推近似(前端標註;真實累積後占比自然下降)
    }
    Path(DATA_DIR).mkdir(exist_ok=True)
    for name, obj in (('broker_signals.json', hist), ('broker_perf.json', payload)):
        tgt = Path(DATA_DIR) / name
        tmp = Path(str(tgt) + '.tmp')
        tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        os.replace(str(tmp), str(tgt))
    print(f"  ✅ 券商勝率榜:訊號累積 {len(hist)} 筆/{len(keep_dates)} 日;前瞻 隔日沖{len(payload['daytrade'])}/短線{len(payload['short'])}/波段{len(payload['swing'])}、浮動{len(payload['float_swing'])} → broker_perf.json")


if __name__ == '__main__':
    # V15.0:ONLY_CHIPS=1 → 跳過 OHLCV 採礦,直接跑全市場 fundamentals + chips + futures + macro
    #        (對應 daily_miner.yml 新增的 chips_miner 平行 job)
    ONLY_CHIPS = bool(int(os.getenv('ONLY_CHIPS', '0')))
    if ONLY_CHIPS:
        print("🎯 V15.0 ONLY_CHIPS=1:跳過 OHLCV,直接跑全市場 chips + fundamentals + futures + macro")
        init_db()   # DB 初始化屬前提,失敗就該中止(不吞)
        # 不跑 cleanup_weekend_rows / run / export_json(OHLCV 由 mine matrix 跑)
        # 🛡️ 各步驟彼此獨立 → 逐步包 _safe_step,一步失敗仍續跑其餘(不讓整批停更)
        # ⚡ V68.3.1 順序修正:govbank/借券「快」(各~1-2分)先跑,避免被最慢的分點迴圈(~29分)
        #    卡到 chips job 的 30 分 timeout 外(前版 govbank 排分點後→從沒跑到就超時,govbank.json 一直缺)
        _safe_step("八大行庫 fetch_govbank_buysell", fetch_govbank_buysell)   # 💎 付費:官股護盤(先跑,快)
        _safe_step("借券空方 fetch_securities_lending", fetch_securities_lending)  # 💎 付費:借券做空(先跑,快)
        _safe_step("集保分級 fetch_holder_distribution", fetch_holder_distribution)  # 📊 付費:籌碼分佈大戶/散戶(先跑,快)
        # 💎 V69.7.8 付費第二彈(全部快步驟,合計 ~90 次 bulk ≈3-4 分,放分點慢迴圈前)
        _safe_step("官方處置 fetch_disposition_official", fetch_disposition_official)
        _safe_step("產業鏈 fetch_industry_chain", fetch_industry_chain)
        _safe_step("當沖比率 fetch_daytrade_ratio", fetch_daytrade_ratio)
        _safe_step("外資水位 fetch_foreign_shareholding", fetch_foreign_shareholding)
        _safe_step("鉅額交易 fetch_block_trade", fetch_block_trade)
        _safe_step("可轉債餘額 fetch_cb_balance", fetch_cb_balance)
        _safe_step("權證溢價 fetch_warrant_premium", fetch_warrant_premium)
        _safe_step("分點籌碼 fetch_broker_chips", fetch_broker_chips)           # 🐢 最慢(分點+基本面 ~29分)放後面
        _safe_step("主力雷達 build_broker_radar", build_broker_radar)         # 🕵️ 後處理 chips → 主力排行(需在 chips 後)
        _safe_step("券商勝率榜 build_broker_perf", build_broker_perf)         # 🧙 後處理 chips + SQLite 現價 → 分點浮動勝率榜(需在 chips 後)
        _safe_step("分點檔案 build_broker_book", build_broker_book)           # 🕵️ 後處理 chips + broker_perf → 分點視角(在雷達/勝率後,可讀其產出)
        _safe_step("外資期貨 fetch_futures_cache", fetch_futures_cache)
        _safe_step("美股宏觀 fetch_us_macro_cache", fetch_us_macro_cache)
        _safe_step("雷達掃描 build_radar_cache", build_radar_cache)   # 讀 SQLite 既有 OHLCV(從 origin/data restore)
        _safe_step("泡沫預警 build_bubble_warning", build_bubble_warning)
        _safe_step("板塊熱度 build_sector_heat", build_sector_heat)
        _safe_step("三位一體選股 generate_top_picks", generate_top_picks)
        # ⛔ V69.8.6 P3-5:此處的 macro_miner 呼叫已移除 — 產出的 macro_risk.json/risk_history.json
        #    不在 chips-data artifact 清單 → 跑完即丟(整支白燒 3-5 分);deploy job 並行階段本來就會跑一次。
        _safe_step("fmx七合一 build_fmx_pack", build_fmx_pack)   # ⚡ P1-3:前端啟動 7 個請求 → 1 個
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
        _safe_step("分點籌碼 fetch_broker_chips", fetch_broker_chips)    # data/chips/*.json （FinMind 重度依賴）
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