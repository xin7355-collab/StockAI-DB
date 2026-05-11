import os
import json
import yfinance as yf
import pandas as pd
import requests
import time
import random
from datetime import datetime, timedelta

# 建立存放 JSON 檔案的資料夾
DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)

def download_stock_data(symbol, years=3):
    end_date = datetime.now()
    start_date = end_date - timedelta(days=years*365)
    
    start_str = start_date.strftime('%Y-%m-%d')
    end_str = end_date.strftime('%Y-%m-%d')
    
    df = pd.DataFrame()
    # 雙軌備援：先試上市 (.TW)，再試上櫃 (.TWO)
    for suffix in ['.TW', '.TWO']:
        try:
            ticker = yf.Ticker(f"{symbol}{suffix}")
            temp_df = ticker.history(start=start_str, end=end_str)
            if not temp_df.empty:
                df = temp_df
                break
        except:
            continue

    if df.empty:
        return False
        
    records = []
    for date, row in df.iterrows():
        close_price = row.get('Close', None)
        if pd.isna(close_price) or close_price == 0: continue
            
        records.append({
            "date": date.strftime('%Y/%m/%d'), # 直接轉成前端 ECharts 要的格式
            "open": float(row.get('Open', close_price)),
            "high": float(row.get('High', close_price)),
            "low": float(row.get('Low', close_price)),
            "close": float(close_price),
            "volume": int(row.get('Volume', 0))
        })
        
    if not records:
        return False

    # 將這檔股票的歷史資料存成獨立的 JSON 檔
    file_path = os.path.join(DATA_DIR, f"{symbol}.json")
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False)
        
    print(f"🟢 {symbol} 更新完成，共 {len(records)} 筆")
    return True

if __name__ == "__main__":
    print("🔍 從 FinMind 獲取最新台股名單...")
    target_stocks = ["2330", "2317", "2454", "3231", "2603"] # 預設名單
    try:
        res = requests.get('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo', timeout=10)
        if res.status_code == 200:
            json_data = res.json()
            if json_data.get('msg') == 'success':
                target_stocks = [s['stock_id'] for s in json_data['data'] if len(s['stock_id']) == 4 and s['stock_id'].isdigit()]
    except:
        pass

    print(f"🚀 啟動 GitHub Actions 雲端採礦機，預計掃描 {len(target_stocks)} 檔...")
    success_count = 0
    
    for i, sym in enumerate(target_stocks):
        if download_stock_data(sym, years=3):
            success_count += 1
            time.sleep(random.uniform(0.1, 0.5)) # 節流閥，防止被 Yahoo 鎖 IP
            
        if (i + 1) % 100 == 0:
            time.sleep(5) # 每 100 檔稍微深呼吸
            
    print(f"🎉 雲端採礦完結！成功更新 {success_count} 檔股票。")
