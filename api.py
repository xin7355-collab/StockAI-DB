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
    提供給前端雷達與 ECharts K 線圖的核心 API (含法人籌碼)
    """
    conn = get_db_connection()
    c = conn.cursor()
    
    # 提取該股票最新的 N 天資料 (按日期排序)
    c.execute('''
        SELECT trade_date as date, open, high, low, close, adj_close, volume, 
               turnover_rate, foreign_inv, invest_trust, dealer_inv, margin_bal
        FROM stock_history
        WHERE symbol = ?
        ORDER BY trade_date DESC
        LIMIT ?
    ''', (symbol, days))
    
    rows = c.fetchall()
    conn.close()
    
    if not rows:
        raise HTTPException(status_code=404, detail="本地資料庫找不到此股票，請確認是否已下載。")
        
    # 因為是 DESC 撈出來的，傳給前端要反轉回 ASC (時間由舊到新)
    data = [dict(row) for row in reversed(rows)]
    
    return data

@app.get("/api/macro")
def get_macro_data():
    """
    獲取宏觀風控數據 (VIX, 費半等)
    """
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM market_macro ORDER BY trade_date DESC LIMIT 1")
    row = c.fetchone()
    conn.close()
    
    if not row:
        return {"status": "no_data"}
    return dict(row)

if __name__ == "__main__":
    import uvicorn
    print("🚀 CTO 啟動命令：伺服器啟動！請在手機前端對接 http://127.0.0.1:8000")
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)