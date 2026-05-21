# api.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import sqlite3

app = FastAPI(title="台股首席策略 API 伺服器")

# 允許所有來源 (CORS) 讓你的手機網頁可以無縫接軌
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "stock_hunter.db"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row # 讓回傳結果像 Dict
    return conn

@app.get("/api/stock/{symbol}")
def get_stock_data(symbol: str, days: int = 300):
    """
    提供給前端雷達與 ECharts K 線圖的核心 API (含法人與融資券籌碼)
    """
    conn = get_db_connection()
    c = conn.cursor()

    c.execute('''
        SELECT trade_date as date, open, high, low, close, volume,
               foreign_inv, invest_trust, dealer_inv, margin_bal, short_bal
        FROM stock_history
        WHERE symbol = ?
        ORDER BY trade_date DESC
        LIMIT ?
    ''', (symbol, days))

    rows = c.fetchall()
    conn.close()

    if not rows:
        raise HTTPException(status_code=404, detail="本地資料庫找不到此股票，請確認是否已下載。")

    data = [dict(row) for row in reversed(rows)]
    return data

@app.get("/api/macro")
def get_macro_data():
    """
    獲取宏觀風控數據（VIX、美股大盤等），回傳最新一筆
    """
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM market_macro ORDER BY trade_date DESC LIMIT 1")
    row = c.fetchone()
    conn.close()
    if not row:
        return {"status": "no_data"}
    return dict(row)


@app.get("/api/radar/{strategy}")
def get_radar(strategy: str):
    valid = {'bottom', 'surge', 'score'}
    if strategy not in valid:
        raise HTTPException(status_code=400, detail=f"strategy must be one of {valid}")
    conn = get_db_connection()
    c = conn.cursor()
    try:
        c.execute('''
            SELECT symbol, close, signal_date, extra_data
            FROM radar_results
            WHERE strategy = ?
            ORDER BY signal_date DESC, symbol ASC
        ''', (strategy,))
        rows = c.fetchall()
    except Exception:
        rows = []
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/chips/{symbol}")
def get_broker_chips(symbol: str):
    conn = get_db_connection()
    c = conn.cursor()
    try:
        c.execute('''
            SELECT date, broker_id, broker_name, buy_vol, sell_vol, net_vol
            FROM broker_chips
            WHERE symbol = ?
            ORDER BY date DESC
            LIMIT 300
        ''', (symbol,))
        rows = c.fetchall()
    except Exception:
        rows = []
    conn.close()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    import uvicorn
    print("🚀 CTO 啟動命令：伺服器啟動！請在手機前端對接 http://127.0.0.1:8000")
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)