# api.py — 台股首席策略 FastAPI 伺服器
# ════════════════════════════════════════════════════════════════════════════
# 【1GB RAM 微型主機防禦準則】
#
#   1. 連線管理：Depends(get_db) yield 模式 → 請求結束一定關閉連線，
#      杜絕 SQLite 檔案句柄洩漏。
#
#   2. K線快取：_TTLCache 快取熱門股票查詢 5 分鐘；
#      maxsize=256 控制記憶體上限 ~10MB。
#
#   3. Groq 節流閥：_GroqRateLimiter 令牌桶（15 RPM）。
#      超速請求進入排隊等待（asyncio.sleep），而非直接拋錯，
#      讓前端體驗優雅降級而非白屏。
#      純 asyncio 實作，不依賴 Redis，記憶體佔用 < 1KB。
#
#   4. Groq 重試：call_groq_api() 捕捉 429/逾時，
#      指數退避最多 3 次（2→4→8 秒），重試耗盡才回傳優雅錯誤。
#      使用 httpx 非同步發送，不阻塞事件迴圈。
#
#   5. 零外部快取依賴：所有快取均為純 Python，不需 Redis/Memcached。
# ════════════════════════════════════════════════════════════════════════════
import asyncio
import json
import os
import sqlite3
import time
import requests
import httpx  # 【終極修復】引入真正的非同步網路庫，解除 FastAPI 櫃檯阻塞危機
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ── 🛡️ 【前線防卡死網路引擎】 ──
def create_robust_session():
    session = requests.Session()
    retry = Retry(total=3, connect=3, read=3, backoff_factor=0.3)
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    return session

http_session = create_robust_session()
# ───────────────────────────────
from datetime import datetime, timezone, timedelta
from threading import Lock
from typing import Any, Generator, Optional

import httpx
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="台股首席策略 API 伺服器")

# 允許所有來源（CORS），讓 gh-pages 前端可直接呼叫本地伺服器
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH      = "stock_hunter.db"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.3-70b-versatile"   # 免費層支援的最強模型


# ══════════════════════════════════════════════════════════════════════════════
# 【核心防禦元件 1】令牌桶節流閥 (Token Bucket Rate Limiter)
# ══════════════════════════════════════════════════════════════════════════════
class _GroqRateLimiter:
    """
    令牌桶限流器 — 純記憶體、asyncio 協程安全。

    ┌─────────────────────────────────────────────────────────────┐
    │  為何選擇令牌桶而非固定視窗（Fixed Window）？               │
    │  ─────────────────────────────────────────────────────────  │
    │  固定視窗在每分鐘邊界會「重置」，若請求剛好集中在邊界前後  │
    │  兩秒，實際速率會瞬間達到 2×RPM，依舊觸發 Groq 429。       │
    │                                                             │
    │  令牌桶以「秒」為單位連續補充，允許適度突發但長期速率受控，  │
    │  且只需記錄 tokens + last_refill 兩個數字，記憶體極省。     │
    └─────────────────────────────────────────────────────────────┘

    運作流程：
      1. 桶初始滿載（rpm 個令牌）
      2. 每次 acquire() 呼叫時，先依流逝時間補充令牌（連續補充）
      3. 若桶有令牌 → 消耗 1 個，立即返回
      4. 若桶空     → 計算距下一個令牌生成還需幾秒，await sleep
      5. 在鎖外 sleep，不阻塞其他協程；sleep 後回到步驟 2 重試
    """

    def __init__(self, rpm: int = 15):
        # rpm：每分鐘最大請求數，預設 15（Groq 免費層上限約 30 RPM，保留 50% 緩衝）
        self._rpm         = rpm
        self._tokens      = float(rpm)      # 初始滿桶
        self._last_refill = time.monotonic()
        # 延遲初始化 asyncio.Lock：模組載入時事件迴圈可能尚未啟動
        self._lock: Optional[asyncio.Lock] = None

    def _get_lock(self) -> asyncio.Lock:
        """第一次呼叫時在當前事件迴圈建立鎖（執行緒安全無需額外保護，因為都在同一事件迴圈）"""
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def acquire(self) -> None:
        """
        取得一個令牌（阻塞直到成功）。呼叫方無需處理任何例外。

        【為何用 while True 而非遞迴？】
        多個協程同時被喚醒時（Thundering Herd），可能在同一個令牌上競爭。
        while True 保證每個協程被喚醒後一定重新檢查桶狀態，
        不會因遞迴深度而 stack overflow。
        """
        while True:
            async with self._get_lock():
                now      = time.monotonic()
                elapsed  = now - self._last_refill
                # 連續補充：依流逝時間按比例增加令牌，但不超過桶容量
                refill   = elapsed * (self._rpm / 60.0)
                self._tokens      = min(float(self._rpm), self._tokens + refill)
                self._last_refill = now

                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return              # 成功取得令牌，結束等待

                # 計算距下一個令牌還需幾秒（在鎖內計算，出鎖後再 sleep）
                wait_secs = (1.0 - self._tokens) / (self._rpm / 60.0)

            # 在鎖外 sleep：讓其他協程有機會執行，不造成死鎖
            await asyncio.sleep(wait_secs + 0.05)   # +0.05s 安全緩衝，避免浮點誤差


# 全域節流閥實例（整個 FastAPI 程序共用一個，即跨請求共用）
_groq_limiter = _GroqRateLimiter(rpm=15)


# ══════════════════════════════════════════════════════════════════════════════
# 【核心防禦元件 2】Groq 非同步呼叫封裝（含指數退避重試）
# ══════════════════════════════════════════════════════════════════════════════
async def call_groq_api(
    prompt:        str,
    model:         str   = GROQ_MODEL,
    max_tokens:    int   = 900,
    temperature:   float = 0.3,
    json_mode:     bool  = False,
    system_prompt: str   = "",
) -> str:
    """
    非同步呼叫 Groq Chat Completion，內建雙重防禦：
      ① 節流閥（令牌桶）：超速時排隊等待，不直接拒絕
      ② 指數退避重試：429/逾時最多重試 3 次（2→4→8 秒）

    參數：
      json_mode  若 True，傳入 response_format={"type":"json_object"}，
                 要求 Groq 強制回傳合法 JSON（用於 /api/ai/investigate）

    回傳：
      AI 回覆的純文字（或 JSON 字串），已從 choices[0].message.content 取出。

    例外：
      HTTPException(503) — API 金鑰未設定 或 重試耗盡仍 429
      HTTPException(502) — 網路錯誤或 Groq 5xx
    """
    if not GROQ_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="伺服器未設定 GROQ_API_KEY 環境變數，請聯絡系統管理員。"
        )

    # ── ① 先通過節流閥（超速時在此排隊，不拋錯）──────────────────────────
    await _groq_limiter.acquire()

    # ── 準備請求 Payload ──────────────────────────────────────────────────
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }
    _msgs: list[dict] = []
    if system_prompt:
        _msgs.append({"role": "system", "content": system_prompt})
    _msgs.append({"role": "user", "content": prompt})
    payload: dict[str, Any] = {
        "model":       model,
        "messages":    _msgs,
        "max_tokens":  max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        # Groq 支援 OpenAI 相容的 JSON mode，強制輸出可解析的 JSON
        payload["response_format"] = {"type": "json_object"}

    # ── ② 指數退避重試（最多 3 次：等待 2→4→8 秒）───────────────────────
    # RETRY_DELAYS 的長度即最大重試次數；最後一輪 delay=None 代表已無退路
    RETRY_DELAYS = [2, 4, 8]
    last_err: Exception = RuntimeError("未知錯誤")

    # httpx.AsyncClient 使用 async with，確保連線池在請求結束後釋放
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        for attempt, delay in enumerate(RETRY_DELAYS + [None]):
            try:
                resp = await client.post(GROQ_API_URL, headers=headers, json=payload)

                # ── 429 Too Many Requests（Groq 速率限制）───────────────
                if resp.status_code == 429:
                    if delay is None:   # 已重試 3 次，放棄
                        raise HTTPException(
                            status_code=503,
                            detail=f"Groq API 速率限制，已重試 {len(RETRY_DELAYS)} 次仍失敗，請稍後再試。"
                        )
                    # Groq 有時在標頭提供 Retry-After；取其最大值以防萬一
                    retry_after = int(resp.headers.get("Retry-After", 0))
                    wait = max(delay, retry_after)
                    await asyncio.sleep(wait)
                    continue

                resp.raise_for_status()     # 其他 4xx/5xx → 拋出 HTTPStatusError
                data = resp.json()
                return data["choices"][0]["message"]["content"]

            except HTTPException:
                raise   # FastAPI 例外直接往上拋，不再重試

            except (httpx.TimeoutException, httpx.NetworkError) as e:
                last_err = e
                if delay is None:
                    break
                await asyncio.sleep(delay)

            except httpx.HTTPStatusError as e:
                last_err = e
                if delay is None:
                    break
                await asyncio.sleep(delay)

    raise HTTPException(
        status_code=502,
        detail=f"Groq API 連線失敗（已重試 {len(RETRY_DELAYS)} 次）：{str(last_err)[:200]}"
    )


# ══════════════════════════════════════════════════════════════════════════════
# 【核心防禦元件 3】K線 TTL 記憶體快取
# ══════════════════════════════════════════════════════════════════════════════
class _TTLCache:
    """
    純標準庫執行緒安全 TTL 快取（threading.Lock，非 asyncio.Lock）。

    【為何不用 asyncio.Lock？】
    SQLite 路由（get_stock_data 等）是同步函式，執行在 FastAPI 的執行緒池，
    而非事件迴圈。使用 threading.Lock 可同時被同步和非同步程式碼安全存取。

    maxsize=256：每筆 K線約 ~40KB，256 筆共 ~10MB，1GB RAM 主機安全範圍。
    """

    def __init__(self, ttl: int = 300, maxsize: int = 256):
        self._ttl     = ttl
        self._maxsize = maxsize
        self._store:  dict = {}          # {key: (value, monotonic_timestamp)}
        self._lock    = Lock()

    def get(self, key: str):
        """惰性刪除：過期時才移除，不需要後台掃描執行緒，節省 RAM。"""
        with self._lock:
            if key not in self._store:
                return None
            val, ts = self._store[key]
            if time.monotonic() - ts > self._ttl:
                del self._store[key]
                return None
            return val

    def set(self, key: str, value):
        """容量滿時踢出最舊項目（近似 LRU）。"""
        with self._lock:
            if len(self._store) >= self._maxsize:
                oldest_key = min(self._store, key=lambda k: self._store[k][1])
                del self._store[oldest_key]
            self._store[key] = (value, time.monotonic())

    def invalidate(self, key: str):
        with self._lock:
            self._store.pop(key, None)


_stock_cache = _TTLCache(ttl=300, maxsize=256)


# ══════════════════════════════════════════════════════════════════════════════
# DB 連線管理 (WAL 並發防禦裝甲)
# ══════════════════════════════════════════════════════════════════════════════
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    FastAPI Depends yield 模式：路由執行完畢（或拋出例外）後自動關閉連線。
    杜絕 connection leak，在長時間運行的微型主機上至關重要。
    並啟用 WAL 寫入預前日誌模式防禦併發鎖死。
    """
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    try:
        yield conn
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# Pydantic Request Models
# ══════════════════════════════════════════════════════════════════════════════
class AnalyzeRequest(BaseModel):
    """
    /api/ai/analyze 請求體。
    前端把完整 prompt（含均線、籌碼、全球觀等數據）預先組好後傳入，
    後端只負責節流與重試，不重複建構 prompt，職責分明。
    """
    prompt:      str
    model:       str   = Field(default=GROQ_MODEL)
    max_tokens:  int   = Field(default=900,  ge=100, le=4096)
    temperature: float = Field(default=0.3,  ge=0.0, le=2.0)


class InvestigateRequest(BaseModel):
    """
    /api/ai/investigate 請求體。
    前端傳入新聞標題與股票代號，prompt 在後端建構（避免 injection）。
    強制要求 Groq 回傳 JSON 格式，前端可直接 JSON.parse()。
    """
    headlines: str   = Field(..., description="一或多行新聞標題，\\n 分隔")
    symbol:    str   = Field(default="", description="股票代號，選填")
    max_tokens: int  = Field(default=500, ge=100, le=2048)


class AuditRequest(BaseModel):
    """
    /api/ai/audit 請求體。
    傳入大師歷史預測紀錄與現在股價，後端建構毒舌點評 prompt。
    """
    symbol:        str
    prediction:    str   = Field(..., description="大師當時的預測文字")
    current_price: float = Field(..., gt=0, description="現在股價（元）")
    max_tokens:    int   = Field(default=350, ge=80, le=1024)


# ══════════════════════════════════════════════════════════════════════════════
# 資料查詢路由（同步，執行在 FastAPI 執行緒池）
# ══════════════════════════════════════════════════════════════════════════════
@app.get("/api/stock/{symbol}")
def get_stock_data(
    symbol: str,
    days:   int = 300,
    db:     sqlite3.Connection = Depends(get_db),
):
    """
    個股 K線 + 三大法人 + 融資融券。

    快取邏輯：
      Cache Hit  → 記憶體直接返回，延遲 < 1ms，完全不碰 SQLite
      Cache Miss → 查 SQLite，寫入快取（TTL 5 分鐘）
    """
    cache_key = f"{symbol}:{days}"

    cached = _stock_cache.get(cache_key)
    if cached is not None:
        return cached

    rows = db.execute("""
        SELECT trade_date   AS date,
               open, high, low, close, volume,
               foreign_inv  AS foreign_net,
               invest_trust AS trust_net,
               dealer_inv   AS dealer_net,
               margin_bal   AS margin_balance,
               short_bal    AS short_balance
        FROM   stock_history
        WHERE  symbol = ?
        ORDER  BY trade_date DESC
        LIMIT  ?
    """, (symbol, days)).fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"找不到 {symbol} 的資料，請確認股票代號或先執行採礦。"
        )

    data = [dict(r) for r in reversed(rows)]   # 時間正序（舊→新）

    # ── 【5MA 盤中動態校準補丁】 ──
    try:
        tw_now = datetime.now(timezone(timedelta(hours=8)))
        today_str = tw_now.strftime('%Y/%m/%d')
        last_db_date = data[-1]['date'].replace('-', '/') if data else ""
        current_time = tw_now.time()

        is_market_open = (
            (current_time.hour == 9 and current_time.minute >= 0) or
            (current_time.hour > 9 and current_time.hour < 14 and not (current_time.hour == 13 and current_time.minute > 30))
        )

# 【效能修復】在同步函式內若要發起網路請求，務必捕捉所有例外，且 timeout 設短一點
            if last_db_date != today_str and is_market_open:
                try:
                    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_{symbol}.tw|otc_{symbol}.tw"
                    # 將 timeout 縮短至 2 秒，避免證交所 API 緩慢時卡死背景執行緒
                    res = requests.get(url, timeout=2.0, headers={'User-Agent': 'Mozilla/5.0'})
                    res.raise_for_status()
                    res_json = res.json()
                    if res_json.get('msgArray'):
                        msg = res_json['msgArray'][0]
                        z = msg.get('z', '-')
                        live_price = float(z) if z != '-' else float(msg.get('y', 0))
                        if live_price > 0:
                            rows.append((today_str, live_price, int(msg.get('v', 0))))
                except Exception as e:
                    print(f"⚠️ [Agent盤中校準錯誤] {symbol}: {e}")
                z = msg.get('z', '-')
                live_price = float(z) if z != '-' else float(msg.get('y', 0))
                if live_price > 0:
                    data.append({
                        'date': today_str.replace('/', '-'),
                        'open': float(msg.get('o', live_price) if msg.get('o', '-') != '-' else live_price),
                        'high': float(msg.get('h', live_price) if msg.get('h', '-') != '-' else live_price),
                        'low': float(msg.get('l', live_price) if msg.get('l', '-') != '-' else live_price),
                        'close': live_price,
                        'volume': int(msg.get('v', 0)),
                        'foreign_net': 0, 'trust_net': 0, 'dealer_net': 0,
                        'margin_balance': 0, 'short_balance': 0
                    })
    except Exception as e:
        print(f"⚠️ [盤中校準錯誤] {symbol}: {e}")
    # ────────────────────────────────

    _stock_cache.set(cache_key, data)
    return data


@app.get("/api/macro")
def get_macro_data(db: sqlite3.Connection = Depends(get_db)):
    """最新一筆宏觀風控資料（VIX、SP500、NASDAQ 等），由 miner.py 每日寫入。"""
    row = db.execute(
        "SELECT * FROM market_macro ORDER BY trade_date DESC LIMIT 1"
    ).fetchone()

    if not row:
        return {"status": "no_data", "message": "尚無宏觀資料，請先執行採礦。"}

    return dict(row)


@app.get("/api/macro/futures")
def get_futures_cache():
    """
    外資台指期未平倉快取代理路由。
    讀取 miner.py 每日寫入的 futures_cache.json，
    讓沒有 gh-pages 存取權的手機端能透過後端代理取得資料，免疫 CORS。
    """
    futures_path = os.path.join(os.path.dirname(DB_PATH) or ".", "futures_cache.json")
    try:
        with open(futures_path, encoding="utf-8") as f:
            return json.loads(f.read())
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="futures_cache.json 尚未產生，請先執行採礦。")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/radar/{strategy}")
def get_radar(
    strategy: str,
    db:       sqlite3.Connection = Depends(get_db),
):
    """
    雷達預運算結果。strategy 合法值：bottom / surge / score。
    資料由 miner.py 的 build_radar_cache() 寫入 radar_results 表。
    """
    valid = {"bottom", "surge", "score"}
    if strategy not in valid:
        raise HTTPException(
            status_code=400,
            detail=f"strategy 必須是 {valid} 其中之一，收到：{strategy!r}"
        )

    rows = db.execute("""
        SELECT symbol, close, signal_date, extra_data
        FROM   radar_results
        WHERE  strategy = ?
        ORDER  BY signal_date DESC, symbol ASC
    """, (strategy,)).fetchall()

    return [dict(r) for r in rows]


@app.get("/api/chips/{symbol}")
def get_broker_chips(
    symbol: str,
    db:     sqlite3.Connection = Depends(get_db),
):
    """主力分點籌碼（近 300 筆），無資料時回空陣列，不拋 404。"""
    rows = db.execute("""
        SELECT date, broker_id, broker_name, buy_vol, sell_vol, net_vol
        FROM   broker_chips
        WHERE  symbol = ?
        ORDER  BY date DESC
        LIMIT  300
    """, (symbol,)).fetchall()

    return [dict(r) for r in rows]


@app.post("/api/cache/invalidate/{symbol}")
def invalidate_cache(symbol: str):
    """採礦完成後主動清除個股快取，讓下次請求立即取得新資料。"""
    _stock_cache.invalidate(f"{symbol}:300")
    return {"status": "ok", "message": f"{symbol} 快取已清除"}


# ══════════════════════════════════════════════════════════════════════════════
# AI 戰情路由（非同步，執行在事件迴圈，搭配 httpx 非阻塞 IO）
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/ai/analyze")
async def ai_analyze(req: AnalyzeRequest):
    """
    首席五維分析代理端點（對應前端 runUnifiedGroqAnalysis）。

    前端將均線數據、籌碼摘要、全球宏觀等組成完整 prompt 後傳入，
    後端通過節流閥 + 重試後代為呼叫 Groq，金鑰不暴露在前端。

    回傳：{ "content": "<AI 分析文字>" }
    """
    content = await call_groq_api(
        prompt=req.prompt,
        model=req.model,
        max_tokens=req.max_tokens,
        temperature=req.temperature,
    )
    return {"content": content}


@app.post("/api/ai/investigate")
async def ai_investigate(req: InvestigateRequest):
    """
    戰情室新聞研判端點（對應前端 autoInvestigateWarRoom）。

    接收新聞標題字串，後端建構 prompt 並強制要求 Groq 回傳 JSON，
    讓前端可直接 JSON.parse() 取得結構化欄位：
      analyst       分析師暱稱（AI 自取台股風格名字）
      verdict       "看多" | "看空" | "中立"
      bull_reason   看多/支撐理由（2-3 句）
      bear_risk     潛在風險（2-3 句）
      confidence    信心指數 0-100

    注意：json_mode=True 對應 Groq 的 response_format={"type":"json_object"}，
    但 prompt 本身也必須要求 JSON 輸出，否則部分模型仍會包夾說明文字。
    """
    sym_tag = f"（標的：{req.symbol}）" if req.symbol else ""
    prompt = f"""你是台股首席研究員{sym_tag}，以「權證小哥」白話風格寫作。
請根據以下新聞標題，判斷對該標的的短線影響，並以合法 JSON 格式回覆。

【新聞標題】
{req.headlines}

請嚴格回傳以下 JSON 結構，不得包含任何額外說明文字：
{{
  "analyst": "一個有趣的台股老手暱稱（如「阿信師」「飆股獵人」）",
  "verdict": "看多" 或 "看空" 或 "中立",
  "bull_reason": "用國中生都能看懂的語言說明看多或支撐理由（2-3句）",
  "bear_risk": "潛在風險或看空理由（2-3句）",
  "confidence": 信心指數數字（0到100的整數）
}}"""

    raw = await call_groq_api(
        prompt=prompt,
        max_tokens=req.max_tokens,
        temperature=0.5,
        json_mode=True,     # 強制 Groq 回傳合法 JSON
    )

    # 嘗試解析，若模型還是夾帶說明文字則提取 JSON 區塊
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        # 從回覆中提取第一個 {...} 區塊
        start, end = raw.find("{"), raw.rfind("}") + 1
        if start != -1 and end > start:
            result = json.loads(raw[start:end])
        else:
            result = {"analyst": "AI", "verdict": "中立",
                      "bull_reason": raw[:200], "bear_risk": "", "confidence": 50}

    return result


@app.post("/api/ai/audit")
async def ai_audit(req: AuditRequest):
    """
    大師預測稽核端點（對應前端 aiCheckWarRoomEntry）。

    傳入大師當時的預測文字與現在股價，AI 以毒舌但有教育意義的台股老手口吻
    點評預測是否準確，讓使用者從回顧中學習。

    回傳：{ "verdict": "準確" | "失準" | "尚未驗證", "comment": "<毒舌點評>" }
    """
    prompt = f"""你是「股市良心」AI，以台灣股市老手的毒舌但有教育意義的風格，
點評以下這筆歷史預測是否準確。

【標的】{req.symbol}
【當時預測】
{req.prediction}

【現在結果】
目前股價：{req.current_price} 元

請用 2-3 句話給出犀利點評：
- 若預測正確：先讚美，再提醒「不要太得意，行情永遠有例外」
- 若預測錯誤：毒舌批評，但一定要說清楚「錯在哪裡、下次要注意什麼」
- 若無法判斷（如目標未到期）：如實說明，給出觀察重點

最後一行請標示：✅ 準確 / ❌ 失準 / ⏳ 尚未驗證

請嚴格回傳以下 JSON：
{{
  "verdict": "準確" 或 "失準" 或 "尚未驗證",
  "comment": "毒舌點評（純文字，2-3句）"
}}"""

    raw = await call_groq_api(
        prompt=prompt,
        max_tokens=req.max_tokens,
        temperature=0.7,    # 毒舌風格需要稍高創意度
        json_mode=True,
    )

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}") + 1
        if start != -1 and end > start:
            result = json.loads(raw[start:end])
        else:
            result = {"verdict": "尚未驗證", "comment": raw[:300]}

    return result


# ══════════════════════════════════════════════════════════════════════════════
# 開盤戰略日報（GET /api/morning_brief）
# ══════════════════════════════════════════════════════════════════════════════
# 12 小時 TTL 快取：全天所有使用者共享同一份日報，只消耗一次 Groq Token。
# 使用現有 _TTLCache（純標準庫，無外部依賴，符合 1GB RAM 防禦準則）。
_brief_cache = _TTLCache(ttl=12 * 3600, maxsize=4)
_BRIEF_CACHE_KEY = "morning_brief_v1"


@app.get("/api/morning_brief")
async def morning_brief(db: sqlite3.Connection = Depends(get_db)):
    """
    開盤前宏觀戰略日報。

    資料來源：
      ① market_macro 表 — 最新一天：台指期淨口數、台股/美股指數、VIX
      ② radar_results 表 — 最多 3 檔最新 bottom / surge 訊號股
      ③ macro_cache.json — 新增指標（SOX / NVDA / US02Y / UKOIL / DXY）

    快取：12 小時 TTL，全天共用，只呼叫一次 Groq。
    回傳：{"status": "success"|"error", "report": "...", "cached": bool}
    """
    # ── ① 命中快取則直接返回 ─────────────────────────────────────────────────
    cached = _brief_cache.get(_BRIEF_CACHE_KEY)
    if cached is not None:
        return {**cached, "cached": True}

    # ── ② 從 SQLite 撈取最新宏觀數據 ─────────────────────────────────────────
    macro_row = db.execute(
        "SELECT * FROM market_macro ORDER BY trade_date DESC LIMIT 1"
    ).fetchone()

    if not macro_row:
        return {
            "status": "error",
            "report": "⚠️ 尚無宏觀資料，請先執行採礦機 (miner.py)。",
            "cached": False,
        }

    macro = dict(macro_row)

    # ── ③ 從 SQLite 撈取雷達強勢股（最多 3 檔 bottom + surge）────────────────
    radar_rows = db.execute("""
        SELECT symbol, strategy, close, signal_date, extra_data
        FROM   radar_results
        WHERE  strategy IN ('bottom', 'surge')
        ORDER  BY signal_date DESC, strategy ASC
        LIMIT  3
    """).fetchall()

    radar_stocks = []
    for r in radar_rows:
        try:
            extra = json.loads(r["extra_data"] or "{}")
            name = extra.get("name", r["symbol"])
        except (json.JSONDecodeError, KeyError):
            name = r["symbol"]
        label = "底部起漲" if r["strategy"] == "bottom" else "飆股動能"
        radar_stocks.append(f"{r['symbol']} {name}（{label}，收 {r['close']:.1f}）")

    # ── ④ 補充讀取 macro_cache.json（新增指標：SOX/NVDA/US02Y/UKOIL/DXY）────
    extra_macro_lines = []
    try:
        macro_cache_path = os.path.join(os.path.dirname(DB_PATH) or ".", "macro_cache.json")
        with open(macro_cache_path, encoding="utf-8") as f:
            mc = json.load(f)
        def _mc(key: str) -> str:
            d = mc.get(key)
            if not d:
                return "N/A"
            sign = "+" if d["chg_pct"] > 0 else ""
            return f"{d['close']} ({sign}{d['chg_pct']:.2f}%)"
        extra_macro_lines = [
            f"費城半導體 SOX：{_mc('sox')}",
            f"輝達 NVDA：{_mc('nvda')}",
            f"美債2Y利率：{_mc('us02y')}%",
            f"布蘭特原油：{_mc('ukoil')} USD/桶",
            f"美元指數 DXY：{_mc('dxy')}",
        ]
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass   # macro_cache.json 不存在時安靜略過，不影響基本日報

    # ── ⑤ 組合 AI Prompt ─────────────────────────────────────────────────────
    fi_net    = macro.get("fi_net") or 0
    fi_label  = ("多方無憂" if fi_net > -10000
                 else "⚠️ 暗流湧動" if fi_net > -25000
                 else "🔴 紅色警戒" if fi_net > -40000
                 else "🚨 黑天鵝")

    vix_val   = macro.get("vix") or 0
    vix_label = ("恐慌" if vix_val > 30 else "警戒" if vix_val > 25
                 else "正常" if vix_val >= 15 else "平靜")

    sp500_chg = macro.get("sp500_chg_pct") or 0
    ndx_chg   = macro.get("nasdaq_chg_pct") or 0
    tsm_chg   = macro.get("tsm_chg_pct") or 0

    radar_section = (
        "、".join(radar_stocks) if radar_stocks
        else "今日無符合條件強勢股"
    )
    extra_section = "\n".join(extra_macro_lines) if extra_macro_lines else ""

    prompt = f"""你是台股首席戰略官。請根據以下昨晚的宏觀數據與今日雷達強勢股，寫一份約 150-200 字的「開盤戰略日報」。
語氣需專業、犀利，直接點出今日台股是該「偏多操作」、「防禦保守」還是「緊盯強勢股」，不說廢話。

【外資台指期】淨口數 {fi_net:+,} 口（{fi_label}）
【台股】加權 {macro.get('taiex_close', '--')} / 上櫃 {macro.get('tpex_close', '--')}
【美股】S&P 500 昨漲跌 {sp500_chg:+.2f}% / NASDAQ {ndx_chg:+.2f}%
【台積電 ADR】{tsm_chg:+.2f}%
【VIX】{vix_val:.1f}（{vix_label}）
{extra_section}

【今日雷達強勢股】{radar_section}

請直接輸出日報正文，不要加任何標題或解釋。結尾務必以一句「今日戰略方針：」開頭的總結收尾。"""

    # ── ⑥ 呼叫 Groq，寫入快取後回傳 ─────────────────────────────────────────
    try:
        report = await call_groq_api(
            prompt=prompt,
            max_tokens=400,
            temperature=0.4,
        )
    except HTTPException as e:
        return {
            "status": "error",
            "report": f"⚠️ AI 服務暫時無法連線（{e.detail}），請稍後再試。",
            "cached": False,
        }

    result = {"status": "success", "report": report}
    _brief_cache.set(_BRIEF_CACHE_KEY, result)
    return {**result, "cached": False}


# ══════════════════════════════════════════════════════════════════════════════
# 【自主代理人】Agent Skills（同步函式，由 asyncio.to_thread 包裝執行）
# ══════════════════════════════════════════════════════════════════════════════

def get_radar_list() -> str:
    """
    從 SQLite 的 radar_results 表撈取最新一批雷達強勢股名單。
    回傳三個策略（底部/飆股/綜合強勢）各自的股票清單，含代號、收盤價與股票名稱。
    若查無資料，回傳「查無雷達資料，可能今日尚未採礦」。
    """
    try:
        conn = sqlite3.connect(DB_PATH, timeout=15.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        cur = conn.cursor()
        cur.execute("SELECT MAX(signal_date) FROM radar_results")
        row = cur.fetchone()
        if not row or not row[0]:
            conn.close()
            return "查無雷達資料，可能今日尚未採礦"
        latest_date = row[0]
        cur.execute(
            "SELECT strategy, symbol, close, extra_data FROM radar_results WHERE signal_date = ?",
            (latest_date,)
        )
        rows = cur.fetchall()
        conn.close()
        if not rows:
            return "查無雷達資料，可能今日尚未採礦"
        buckets: dict = {"bottom": [], "surge": [], "score": []}
        for strategy, symbol, close, extra_data in rows:
            name = symbol
            try:
                ed = json.loads(extra_data or "{}")
                name = ed.get("name") or ed.get("股名") or symbol
            except Exception:
                pass
            buckets.setdefault(strategy, []).append(f"{symbol}({name}) 收{close}")
        label_map = {"bottom": "底部訊號", "surge": "飆股訊號", "score": "綜合強勢"}
        lines = [f"雷達日期：{latest_date}"]
        for key, label in label_map.items():
            items = buckets.get(key, [])
            lines.append(f"【{label}】{'、'.join(items) if items else '無'}")
        return "\n".join(lines)
    except Exception as e:
        return f"查詢雷達資料失敗：{e}"


def query_stock_data(symbol: str) -> str:
    """
    從 SQLite 的 stock_history 表查詢指定股票最近 5 天的收盤價、MA5、MA20 與成交量。
    需取最近 25 筆資料才能計算 MA20；回傳最後 5 筆的格式化結果。
    若查無資料，回傳「查無 {symbol} 的歷史資料」。
    """
    try:
        conn = sqlite3.connect(DB_PATH, timeout=15.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        cur = conn.cursor()
        cur.execute(
            "SELECT trade_date, close, volume FROM stock_history "
            "WHERE symbol = ? ORDER BY trade_date DESC LIMIT 25",
            (symbol,)
        )
        rows = cur.fetchall()
        conn.close()
        if not rows:
            return f"查無 {symbol} 的歷史資料"
        rows = list(reversed(rows))  # 轉為時間正序

        # ── 【AI 5MA 盤中動態校準補丁】 ──
        try:
            tw_now = datetime.now(timezone(timedelta(hours=8)))
            today_str = tw_now.strftime('%Y-%m-%d')
            last_db_date = rows[-1][0] if rows else ""
            current_time = tw_now.time()

            is_market_open = (
                (current_time.hour == 9 and current_time.minute >= 0) or
                (current_time.hour > 9 and current_time.hour < 14 and not (current_time.hour == 13 and current_time.minute > 30))
            )

            if last_db_date != today_str and is_market_open:
                url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_{symbol}.tw|otc_{symbol}.tw"
                res = http_session.get(url, timeout=5, headers={'User-Agent': 'Mozilla/5.0'}).json()
                if res.get('msgArray'):
                    msg = res['msgArray'][0]
                    z = msg.get('z', '-')
                    live_price = float(z) if z != '-' else float(msg.get('y', 0))
                    if live_price > 0:
                        rows.append((today_str, live_price, int(msg.get('v', 0))))
        except Exception:
            pass # 備援接口失敗則靜默降級，維持原歷史陣列計算
        # ────────────────────────────────────────

        closes = [r[1] for r in rows]
        ma5  = round(sum(closes[-5:]) / min(5, len(closes)), 2) if len(closes) >= 1 else None
        ma20 = round(sum(closes[-20:]) / min(20, len(closes)), 2) if len(closes) >= 1 else None
        recent5 = rows[-5:]
        lines = [f"股票代號：{symbol}（最近 {len(recent5)} 天數據）"]
        lines.append(f"MA5={ma5}  MA20={ma20}")
        for date_val, close_val, vol in recent5:
            lines.append(f"  {date_val}  收盤={close_val}  成交量={vol:,}")
        return "\n".join(lines)
    except Exception as e:
        return f"查詢 {symbol} 股價失敗：{e}"


def search_latest_news(symbol: str) -> str:
    """
    使用 DuckDuckGo 搜尋指定股票最近的 3 則台股新聞標題與摘要。
    回傳每則新聞的標題與內文摘要，以換行分隔。
    若搜尋失敗，回傳「新聞搜尋失敗：{錯誤訊息}」。
    """
    try:
        from duckduckgo_search import DDGS
        query = f"{symbol} 台股 新聞"
        results = DDGS().text(query, max_results=3)
        if not results:
            return f"查無 {symbol} 相關新聞"
        lines = []
        for i, r in enumerate(results, 1):
            title = r.get("title", "")
            body  = r.get("body", "")[:120]
            lines.append(f"[新聞{i}] {title}\n{body}")
        return "\n\n".join(lines)
    except Exception as e:
        return f"新聞搜尋失敗：{e}"


# ── Tool Schema（傳給 Groq 的 JSON 結構定義）────────────────────────────────
CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_radar_list",
            "description": "從資料庫撈取今日最新的雷達強勢股名單（底部/飆股/綜合分數三類）",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_stock_data",
            "description": "查詢指定股票最近5天的收盤價、MA5、MA20與成交量",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "台股股票代號，如 '2330'"}
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_latest_news",
            "description": "搜尋指定股票最近的3則台股新聞標題與摘要",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "台股股票代號，如 '2330'"}
                },
                "required": ["symbol"],
            },
        },
    },
]

_CHAT_SKILL_DISPATCH = {
    "get_radar_list":    get_radar_list,
    "query_stock_data":  query_stock_data,
    "search_latest_news": search_latest_news,
}

_CHAT_SYSTEM_PROMPT = (
    "你是台股首席 AI 總裁，精通朱家泓技術分析。"
    "你可以使用工具查資料，請根據工具回傳的真實數據，"
    "給出犀利、有紀律的決策，絕不瞎掰數據。"
)


# ══════════════════════════════════════════════════════════════════════════════
# 【個股基本面 X 光機】POST /api/analyze_fundamentals
# ══════════════════════════════════════════════════════════════════════════════

class FundamentalsRequest(BaseModel):
    symbol:             str
    eps:                Optional[float] = None
    yoy:                Optional[float] = None
    pe:                 Optional[float] = None
    yield_rate:         Optional[float] = None
    gross_margin_trend: Optional[str]   = None
    payout_ratio:       Optional[float] = None
    dividend:           Optional[float] = None
    is_record_high:     Optional[bool]  = None   # 本月營收是否創近24個月新高
    quarterly_eps:      Optional[list]  = None   # [{period, eps, revenue}, ...] 近4季
    max_tokens:         int             = Field(default=350, ge=80, le=600)


class TechAIRequest(BaseModel):
    symbol:     str
    query_type: str                              # trend / pullback / breakout / defense
    max_tokens: int = Field(default=200, ge=80, le=400)


@app.post("/api/tech_ai")
async def tech_ai_diagnose(req: TechAIRequest):
    # 【終極修復】query_stock_data 內含同步的 requests.get 網路請求。
    # 必須用 to_thread 丟到背景執行緒，否則每次點擊都會讓 FastAPI 全站卡死 5 秒！
    stock_info = await asyncio.to_thread(query_stock_data, req.symbol)
    _prompts = {
        "trend":    "你是台股技術大師。請判斷目前是否為「頭頭高、底底高」的多頭排列？請用大白話給出具體的進場條件與防守價位。",
        # 【體驗優化】將深奧的折數與 0.382 轉化為小白聽得懂的「大拍賣打幾折」
        "pullback": "你是台股技術大師，精通郭榮哲的折數過濾。請用大白話解釋目前股價從高點跌下來「打了幾折」？現在買算不算撿便宜？並給出停損點。",
        "breakout": "你是台股技術大師。請判斷目前的突破是否為「主力真金白銀換手」？還是假突破？請給出明確的追價條件與停損守則。",
        "defense":  "你是台股風險控管大師。請無情且犀利地點出目前的破線危機，並給出絕對不能跌破的逃命價位，絕不留戀。",
    }
    sys_prompt = _prompts.get(req.query_type, "你是台股實戰大師，給出簡短技術面評估。")
    user_msg = f"{stock_info}\n\n請用 100 字以內，犀利、專業的台股老手語氣給出大白話結論。"
    content = await call_groq_api(
        user_msg,
        system_prompt=sys_prompt,
        max_tokens=req.max_tokens,
        temperature=0.3,
    )
    return {"status": "success", "reply": content}


@app.post("/api/analyze_fundamentals")
async def analyze_fundamentals(req: FundamentalsRequest):
    def _v(val, unit=''):
        return f"{val}{unit}" if val is not None else "無資料"

    # Python-side 下季 QoQ 移動平均預測（禁止讓 AI 算複利）
    next_q_str = "無資料"
    if req.quarterly_eps and len(req.quarterly_eps) >= 2:
        revs = [q.get('revenue', 0) or 0 for q in req.quarterly_eps]
        valid_revs = [(revs[i], revs[i-1]) for i in range(1, len(revs))
                      if revs[i-1] > 0 and revs[i] > 0]
        if valid_revs:
            qoq_list = [(cur / prev - 1) * 100 for cur, prev in valid_revs]
            avg_qoq = sum(qoq_list) / len(qoq_list)
            latest_rev = revs[-1] if revs[-1] > 0 else None
            if latest_rev:
                next_q_rev = latest_rev * (1 + avg_qoq / 100)
                next_q_str = f"預估 {next_q_rev / 1e8:.1f} 億元（均值 QoQ {avg_qoq:+.1f}%）"

    # 季報摘要字串（近4季）
    quarterly_str = "無資料"
    if req.quarterly_eps:
        lines = []
        for q in req.quarterly_eps:
            rev_b = q.get('revenue', 0) or 0
            rev_s = f"{rev_b / 1e8:.1f}億" if rev_b > 0 else "--"
            lines.append(f"  {q.get('period', '?')}：EPS {q.get('eps', 0):.2f} 元 / 營收 {rev_s}")
        quarterly_str = "\n".join(lines)

    record_high_tag = "🔥 本月營收創近24個月歷史新高！\n" if req.is_record_high else ""

    prompt = f"""你是台股身經百戰的操盤總裁，講話犀利直接，專門戳破上市公司財報粉飾。
根據以下 {req.symbol} 的基本面數據，輸出 150~200 字大白話實戰解析：

{record_high_tag}【最新基本面】
EPS（最新季）：{_v(req.eps, ' 元')}
營收 YoY（最新月）：{_v(req.yoy, '%')}
本益比 PE：{_v(req.pe, 'x')}
殖利率：{_v(req.yield_rate, '%')}
毛利率趨勢：{req.gross_margin_trend or '無資料'}
股利發配率：{_v(req.payout_ratio, '%')}
最新每股股利：{_v(req.dividend, ' 元')}

【近4季季報摘要】（Python 計算，勿自行算）
{quarterly_str}

【下季營收預測】（Python 移動均值 QoQ，勿自行算）
{next_q_str}

解讀矩陣（符合就標記，都不符合就說「中性觀察」）：
🔥 嚴重低估的成長火箭：高 YoY + PE<15 + 毛利增
⚠️ 靠題材炒作的空氣泡泡：低/負 YoY + PE>40
🚨 價值陷阱/掏空資本警告：殖利率>8% + 負YoY 或 發配率>100%
📐 右下角建倉形態：若下季預測成長 + 目前為均線支撐區，給出具體建倉區間與停損點

先點判定結果，再大白話解讀體質與操作建議。"""

    content = await call_groq_api(prompt, max_tokens=req.max_tokens, temperature=0.5)
    return {"content": content}


# ══════════════════════════════════════════════════════════════════════════════
# 【自主代理人】POST /api/chat — Groq Tool Calling 迴圈
# ══════════════════════════════════════════════════════════════════════════════

class ChatRequest(BaseModel):
    message:     str
    model:       str   = GROQ_MODEL
    max_tokens:  int   = Field(default=1200, ge=100, le=4096)
    temperature: float = Field(default=0.4, ge=0.0, le=2.0)


@app.post("/api/chat")
async def agent_chat(req: ChatRequest):
    """
    自主代理人聊天端點。
    接收使用者提問，透過 Groq Tool Calling 迴圈自動查詢雷達、股價、新聞，
    最終回傳基於真實數據的分析報告。
    回傳格式：{"status": "success", "reply": "..."}
    """
    if not GROQ_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="伺服器未設定 GROQ_API_KEY 環境變數，請聯絡系統管理員。"
        )

    messages: list[dict] = [
        {"role": "system", "content": _CHAT_SYSTEM_PROMPT},
        {"role": "user",   "content": req.message},
    ]
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }

    MAX_ITERS = 5
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        for _iter in range(MAX_ITERS):
            await _groq_limiter.acquire()

            payload = {
                "model":       req.model,
                "messages":    messages,
                "tools":       CHAT_TOOLS,
                "tool_choice": "auto",
                "max_tokens":  req.max_tokens,
                "temperature": req.temperature,
            }

            try:
                resp = await client.post(GROQ_API_URL, headers=headers, json=payload)
                if resp.status_code == 429:
                    retry_after = int(resp.headers.get("Retry-After", 4))
                    await asyncio.sleep(retry_after)
                    continue
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                raise HTTPException(status_code=502, detail=f"Groq API 錯誤：{e}")
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                raise HTTPException(status_code=502, detail=f"Groq 連線失敗：{e}")

            data = resp.json()
            choice = data["choices"][0]
            finish_reason = choice.get("finish_reason", "")
            assistant_msg = choice["message"]

            tool_calls = assistant_msg.get("tool_calls") or []

            # ── 無 tool_calls → Groq 給出最終回覆，直接回傳 ────────────────
            if not tool_calls:
                return {"status": "success", "reply": assistant_msg.get("content", "")}

            # ── 有 tool_calls → 執行各 Skill，結果回填後繼續迴圈 ───────────
            messages.append(assistant_msg)  # 含 tool_calls 的 assistant 訊息

            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                fn_args_raw = tc["function"].get("arguments", "{}")
                try:
                    fn_args = json.loads(fn_args_raw)
                except json.JSONDecodeError:
                    fn_args = {}

                skill_fn = _CHAT_SKILL_DISPATCH.get(fn_name)
                if skill_fn is None:
                    tool_result = f"未知工具：{fn_name}"
                else:
                    try:
                        tool_result = await asyncio.to_thread(skill_fn, **fn_args)
                    except Exception as e:
                        tool_result = f"工具執行失敗：{e}"

                messages.append({
                    "role":         "tool",
                    "tool_call_id": tc["id"],
                    "content":      str(tool_result),
                })

    # 超過最大迭代仍未回覆（極少發生）
    return {"status": "success", "reply": "AI 迭代次數已達上限，無法產生最終回覆，請稍後重試。"}


# ══════════════════════════════════════════════════════════════════════════════
# 籌碼大三元多週期解析（備用端點）
# 前端預設走 /api/ai/analyze（_callAI），手機無後端時直連 Groq；
# 此端點供有自架後端者使用，語氣維持白話 5 段。
# ══════════════════════════════════════════════════════════════════════════════
class ChipAnalysisRequest(BaseModel):
    symbol:      str
    chip_trends: str   # 前端濃縮的 1/3/5/10 日趨勢字串
    max_tokens:  int = Field(default=800, ge=100, le=1024)


@app.post("/api/ai/chip_analysis")
async def ai_chip_analysis(req: ChipAnalysisRequest):
    """大三元籌碼多週期透視（白話 5 段升級版）"""
    # 【升級】採用正面約束，去除 AI 廢話，強制精準對齊結構
    prompt = f"""你是華爾街頂級避險基金的首席籌碼分析師，說話風格完全模仿權證小哥：直接、有個性、白話、切中要害。請用國中生都能秒懂的生活化比喻，為初學者解析籌碼資料，直接將數據融入對話，省略所有 AI 常見套話。

【股票代號：{req.symbol}】
【1/3/5/10 日多週期籌碼動態（張）】
{req.chip_trends}

請嚴格依照下列 5 個重點依序輸出（請加上表情符號，標題本身不可加粗）：
1️⃣ 外資動向：外資目前是在倒貨還是囤貨？力道強弱？
2️⃣ 內資大哥（投信與自營）：內資有沒有偷偷進場護盤的跡象？
3️⃣ 散戶指標（融資券）：現在車上是不是太擠了？散戶正在被割韭菜嗎？
4️⃣ 主力分點建倉：大戶的成本大約落在哪裡？有沒有券商在偷偷吃貨？
5️⃣ 實戰戰略結論：綜合上述籌碼面，現在該上車、觀望，還是快逃？

最後獨立一行輸出：⚠️ 投資有風險，以上僅供參考，請自行判斷。"""
    content = await call_groq_api(prompt=prompt, max_tokens=req.max_tokens, temperature=0.5)
    return {"status": "success", "reply": content}


# ══════════════════════════════════════════════════════════════════════════════
# 本機啟動
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    print("🚀 首席 API 伺服器啟動 → http://127.0.0.1:8000")
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)