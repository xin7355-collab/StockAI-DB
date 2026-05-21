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
    prompt:      str,
    model:       str   = GROQ_MODEL,
    max_tokens:  int   = 900,
    temperature: float = 0.3,
    json_mode:   bool  = False,
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
    payload: dict[str, Any] = {
        "model":       model,
        "messages":    [{"role": "user", "content": prompt}],
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
# DB 連線管理
# ══════════════════════════════════════════════════════════════════════════════
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    FastAPI Depends yield 模式：路由執行完畢（或拋出例外）後自動關閉連線。
    杜絕 connection leak，在長時間運行的微型主機上至關重要。
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
# 本機啟動
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    print("🚀 首席 API 伺服器啟動 → http://127.0.0.1:8000")
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
