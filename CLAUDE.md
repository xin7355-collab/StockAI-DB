# StockAI-DB — Claude Code 專案說明

## 專案是什麼
台股 AI 終端機，單一 `index.html` 靜態網站 + Python 採礦機，部署在 GitHub Pages。
網站網址：`https://xin7355-collab.github.io/StockAI-DB/`

---

## Git 分支架構（三分支，各司其職）

| 分支 | 用途 | 更新方式 |
|------|------|----------|
| `main` | 程式碼（miner.py、index.html、workflow） | 手動 commit |
| `data` | 採礦後的 JSON 資料（orphan，永遠只有1個commit） | GitHub Actions force-push |
| `gh-pages` | 網站 + 資料（orphan，永遠只有1個commit） | GitHub Actions force-push |

**重要**：gh-pages 和 data 分支都用 orphan force-push，不累積歷史，空間不會爆炸。

## 開發分支
**直接在 `main` 分支開發**。GitHub Actions cron 排程只從 default branch（main）讀取，
若開新分支會導致採礦機無法用到最新程式碼。
手動觸發時，永遠選 **`main`** 分支。

---

## GitHub Actions Workflow
檔案：`.github/workflows/daily_miner.yml`
- **執行策略**：採用 **5 個批次同步併發 (Matrix Parallel)** 技術，打破時間限制，大幅縮短全市場採礦時間。
- **無損合併**：每個子任務 (batch 0~4) 獨立抓取負責的股票後，會觸發 `merge` 任務將 JSON 完美合併。
- 可手動觸發：Actions → 每日籌碼採礦機 → Run workflow → 選 **`main`**。
- 執行順序：5 併發獨立採礦(miner.py) → 下載 Artifacts 合併 → 部署 gh-pages 與 data 分支。

---

## 資料檔案位置

```
data/*.json          每支股票的 OHLCV + 法人籌碼（最多800筆，約3年）
data/chips/*.json    主力分點籌碼（滾動20個交易日）
data/broker_names.json  券商代碼→名稱對照表（從 TWSE T86 累積建立）
data/radar.json      雷達預運算結果（底部/飆股/綜合強勢）
futures_cache.json   外資台指期未平倉淨口數
macro_cache.json     美股大盤日收資料（SP500/NASDAQ/VIX/TSM）
```

---

## 採礦機重點（miner.py）

### 資料來源與極限防禦
1. **OHLCV 與法人**：直接抓取 TWSE/TPEX 免費 API，並具備 SQLite WAL 鎖死防護與 JSON 分散式合併。
2. **盤中快照補丁**：若當天歷史 K 線尚未產出，會自動去證交所 MIS 抓取即時快照填補。
3. **分點籌碼**：透過 FinMind 匿名公開額度 (自動 Token 輪動防 429 封鎖)。
4. **外資期貨**：優先直連 **TAIFEX (期交所) 官方 CSV** 解析多空淨額，不再依賴容易斷線或缺漏的第三方 API。
5. **美股大盤**：yfinance

### 重要規則
- `fm_get()` 任何非200回應都會 fallback 到匿名請求
- 分點籌碼「已是最新跳過」時，仍呼叫 `_refresh_broker_names()` 更新對照表
- OHLCV 補丁邏輯：若舊記錄缺少 `foreign_net` 欄位，下次採礦時自動補上

### 監控清單
`CHIP_WATCHLIST` = 約50檔上市上櫃熱門股 + ETF，分點籌碼只追蹤這些。

---

## 前端重點（index.html）

### 資料載入 URL 規則
**所有 fetch URL 必須用動態 ghBase，不可硬編碼路徑**
```javascript
const ghBase = window.location.href.split('?')[0].split('#')[0];
✂️ **刪除並貼上新代碼**（我們把 `?t=Date.now()` 的鐵律加進去，警告 AI 絕對不准拿掉）：
```markdown
// 正確：new URL('data/xxx.json', ghBase).href + `?t=${Date.now()}`
// 錯誤：'[https://xin7355-collab.github.io/stockai-db/data/xxx.json](https://xin7355-collab.github.io/stockai-db/data/xxx.json)'  ← 大小寫錯誤
```
過去曾因為硬編碼小寫 `stockai-db` 導致 futures_cache、macro_cache、radar.json 全部 fetch 失敗。

### 籌碼頁面結構
「籌碼全面追蹤」為單一卡片，由上到下：
1. 三大法人淨買賣（近10日圖表）
2. 融資融券走勢（圖表）
3. 主力分點追蹤（買超/賣超 Top10）
4. 🤖 AI 籌碼全面解析（一個按鈕，涵蓋法人+分點）

### AI 分析風格與防呆約束
- 口吻：**權證小哥風格**，大白話文，國中生都看得懂（例如把郭榮哲折數解釋為「大拍賣打幾折」）。
- 首席分析：技術面 → 籌碼面 → 全球觀 → 產品/消息面 → 總監戰術室。
- 🛑 **絕對禁止 AI 算數學（防幻覺鐵律）**：語言模型不會算均線！所有 MA5、MA20、營收 YoY、乖離率等數值，**必須在 JS 或 Python 端精確計算好之後，再當作變數塞入 Prompt**。嚴禁把原始 K 線丟給 AI 叫它自己算！
- **正面約束**：禁止 AI 使用「根據資料」、「以下為您分析」等廢話，必須給出具體點位與操作指令（🟢/🟡/🔴）。
- **JSON 防呆**：在 `universal_radar.py` 等純數據解析中，嚴格要求輸出純 JSON，禁止 Markdown (如 ```json) 標籤導致程式崩潰。

### 外資期貨顯示邏輯
- `fi_net > -10000`：多方無憂（綠色）
- `-25000 < fi_net <= -10000`：⚠️ 暗流湧動（黃色）
- `-40000 < fi_net <= -25000`：🔴 紅色警戒（橙色）
- `fi_net <= -40000`：🚨 黑天鵝警報（緊急橫幅）

---

## 使用者偏好

- **語言**：繁體中文回答
- **風格**：直接給答案，不要長篇解釋，重點條列
- **分析口吻**：白話文，像在跟初學者解釋
- **功能方向**：以初學者友善為主，複雜功能要有白話說明
- **命名習慣**：不用「照妖鏡」這三個字（已從 UI 移除）

---

## 常見問題與已知解法

| 問題 | 原因 | 解法 |
|------|------|------|
| gh-pages 部署失敗 exit 128 | 首次執行 broker_names.json 不存在 | git add 前先判斷檔案存在 |
| 三大法人空白 | FinMind status=None 不 fallback | fm_get 改為任何非200都 fallback |
| 外資期貨/美股無資料 | URL 硬編碼小寫路徑 | 改用動態 ghBase |
| 主力顯示 ABC 而非券商名 | 資料已最新跳過→T86未呼叫 | 跳過時仍呼叫 _refresh_broker_names |
| broker_names.json 不存在 | T86 被雲端 sandbox 阻擋 | GitHub Actions 環境可存取 TWSE |

---

## GitHub 帳號
- 帳號：`xin7355-collab`
- 主要 repo：`StockAI-DB`（此專案）
- 其他：`gdp-dashboard`（保留）、`pro-terminal-v4`（已刪除）
- GitHub Pages 1GB 限制：目前使用約 100MB，無虞
