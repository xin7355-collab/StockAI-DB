# api.py — 台股首席策略 FastAPI 伺服器
# ════════════════════════════════════════════════════════════════════════════
# 【1GB RAM 防禦準則】
#   1. 連線管理：使用 Depends(get_db) yield 模式，確保每個請求結束後
#      一定關閉 SQLite 連線，杜絕連線洩漏 (connection leak)。
#   2. 記憶體快取：_TTLCache 快取熱門股票查詢結果 5 分鐘，
#      降低每秒 DB 讀取壓力；maxsize=256 控制記憶體上限約 ~10MB。
#   3. 零外部依賴：TTLCache 純標準庫實作，不需安裝 cachetools。
# ════════════════════════════════════════════════════════════════════════════
import sqlite3
import time
from threading import Lock
from typing import Generator

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="台股首席策略 API 伺服器")

# 允許所有來源（CORS），讓前端頁面可直接呼叫
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "stock_hunter.db"


# ── 輕量級 TTL 記憶體快取（無外部依賴）───────────────────────────────────────
class _TTLCache:
    """
    純標準庫的執行緒安全 TTL 快取。
    - ttl     : 項目存活秒數（預設 300 秒 = 5 分鐘）
    - maxsize : 最多快取幾個 key；超過時踢出最舊的項目，防止 OOM
    """
    def __init__(self, ttl: int = 300, maxsize: int = 256):
        self._ttl     = ttl
        self._maxsize = maxsize
        self._store:  dict = {}          # {key: (value, insert_monotonic_time)}
        self._lock    = Lock()           # 多執行緒安全：FastAPI 的 async worker 可能並發

    def get(self, key: str):
        """取得快取值；過期或不存在回傳 None。"""
        with self._lock:
            if key not in self._store:
                return None
            val, ts = self._store[key]
            if time.monotonic() - ts > self._ttl:
                del self._store[key]    # 惰性刪除：過期才移除，不需後台掃描執行緒
                return None
            return val

    def set(self, key: str, value):
        """寫入快取；容量滿時踢出最舊的項目（LRU-ish）。"""
        with self._lock:
            if len(self._store) >= self._maxsize:
                # 找出插入時間最早的 key 並移除
                oldest_key = min(self._store, key=lambda k: self._store[k][1])
                del self._store[oldest_key]
            self._store[key] = (value, time.monotonic())

    def invalidate(self, key: str):
        """主動失效某個 key（例如採礦完成後強制刷新）。"""
        with self._lock:
            self._store.pop(key, None)


# 全域快取實例：最多 256 支股票，每筆資料約 ~40KB（300筆 K 線），共約 10MB
_stock_cache = _TTLCache(ttl=300, maxsize=256)


# ── DB 連線管理（Depends yield 模式）─────────────────────────────────────────
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    FastAPI Depends 生成器，取代舊版 get_db_connection()。

    【為什麼用 yield 而不是直接 return？】
    使用 yield 讓 FastAPI 在路由函式執行完（或拋出例外）後，
    自動執行 finally 區塊關閉連線。
    舊版 return 模式必須在每個路由手動呼叫 conn.close()，
    一旦中途拋出例外就會洩漏連線，長時間運行後會耗盡 SQLite 的檔案句柄。

    用法：def my_route(db: sqlite3.Connection = Depends(get_db)):
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row   # 讓查詢結果可用欄位名稱存取（像 dict）
    try:
        yield conn                   # ← 把連線交給路由函式
    finally:
        conn.close()                 # ← 無論成功或例外，一定執行


# ── 路由：個股 K 線 + 籌碼（含 TTL 快取）────────────────────────────────────
@app.get("/api/stock/{symbol}")
def get_stock_data(
    symbol: str,
    days:   int = 300,
    db:     sqlite3.Connection = Depends(get_db),
):
    """
    提供前端 K 線圖所需的 OHLCV + 三大法人 + 融資融券資料。

    【快取策略】
    Cache Hit  → 直接從記憶體返回，不碰 DB，延遲 < 1ms
    Cache Miss → 查詢 SQLite，寫入快取，TTL = 5 分鐘後自動過期

    【欄位說明】
    SQLite 欄位名稱 (foreign_inv / invest_trust / dealer_inv)
    在 SELECT 時用 AS 別名改為前端期望的 foreign_net / trust_net / dealer_net，
    前端 index.html 兩種命名都相容（?? fallback）。
    """
    cache_key = f"{symbol}:{days}"

    # ── Cache Hit：直接返回，不碰 DB ──────────────────────────────
    cached = _stock_cache.get(cache_key)
    if cached is not None:
        return cached

    # ── Cache Miss：查詢 SQLite ───────────────────────────────────
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

    # 回傳時間正序（舊→新），符合前端 K 線圖期望順序
    data = [dict(r) for r in reversed(rows)]

    # 寫入記憶體快取
    _stock_cache.set(cache_key, data)

    return data


# ── 路由：總體宏觀（VIX、美股大盤）─────────────────────────────────────────
@app.get("/api/macro")
def get_macro_data(db: sqlite3.Connection = Depends(get_db)):
    """
    回傳最新一筆總體風控資料（VIX、SP500、NASDAQ、TSM 等）。
    資料由 miner.py 的 fetch_us_macro_cache() 寫入 market_macro 表。
    """
    row = db.execute(
        "SELECT * FROM market_macro ORDER BY trade_date DESC LIMIT 1"
    ).fetchone()

    if not row:
        return {"status": "no_data", "message": "尚無宏觀資料，請先執行採礦。"}

    return dict(row)


# ── 路由：雷達掃描結果 ───────────────────────────────────────────────────────
@app.get("/api/radar/{strategy}")
def get_radar(
    strategy: str,
    db:       sqlite3.Connection = Depends(get_db),
):
    """
    回傳雷達策略清單。strategy 合法值：bottom / surge / score。
    資料由 miner.py 的 build_radar_cache() 寫入 radar_results 表。
    """
    valid = {'bottom', 'surge', 'score'}
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


# ── 路由：主力分點籌碼 ───────────────────────────────────────────────────────
@app.get("/api/chips/{symbol}")
def get_broker_chips(
    symbol: str,
    db:     sqlite3.Connection = Depends(get_db),
):
    """
    回傳指定股票近 300 筆券商分點買賣資料。
    broker_chips 為選配功能，無資料時回空陣列（不拋 404）。
    """
    rows = db.execute("""
        SELECT date, broker_id, broker_name, buy_vol, sell_vol, net_vol
        FROM   broker_chips
        WHERE  symbol = ?
        ORDER  BY date DESC
        LIMIT  300
    """, (symbol,)).fetchall()

    return [dict(r) for r in rows]


# ── 快取管理端點（運維用）────────────────────────────────────────────────────
@app.post("/api/cache/invalidate/{symbol}")
def invalidate_cache(symbol: str):
    """
    主動清除指定股票的記憶體快取（採礦完成後可立即呼叫此端點，讓新資料生效）。
    範例：curl -X POST http://localhost:8000/api/cache/invalidate/2330
    """
    _stock_cache.invalidate(f"{symbol}:300")
    return {"status": "ok", "message": f"{symbol} 快取已清除"}


# ── 本機啟動 ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print("🚀 首席 API 伺服器啟動 → http://127.0.0.1:8000")
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
