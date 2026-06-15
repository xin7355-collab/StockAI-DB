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

### 三支 workflow 分工（重要）
| Workflow | 觸發 | 用途 | 生效時間 |
|----------|------|------|----------|
| `daily_miner.yml` | cron / 手動 / push `miner.py`·`macro_miner.py`·`radar_miner.py`·`chief_ai_batch.py`·`daily_miner.yml` | 完整採礦 + 部署 gh-pages/data | 30-60 分 |
| `deploy_pages.yml` | push `index.html` / `sw.js` 到 main / 手動 | **只部署 index.html + sw.js 到 gh-pages,不採礦** | **~1 分鐘** |
| `macro_probe.yml` | (自身用途) | 總經探針 | — |

- **`daily_miner.yml` 執行策略**：採 **20 批次同步併發 (Matrix Parallel)**，打破時間限制，大幅縮短全市場採礦時間。
- **無損合併**：每個子任務獨立抓取負責的股票後，`merge` 任務將 JSON 完美合併。
- **`deploy_pages.yml` 原理**：checkout gh-pages（非 orphan,保留 `data/`）→ 只覆蓋 `index.html` + `sw.js` → commit push。這是**既有**的秒級前端部署 workflow,純前端改動 push 到 main 即自動跑。
- ⚠️ **`index.html` 已從 `daily_miner.yml` 的 push paths 移除** → 純前端改動只觸發秒級的 `deploy_pages.yml`，不再浪費 30-60 分跑採礦（避免一次 push 同時觸發兩條部署互相 race）。
- ⛔ **不要再新增第二支「只部署前端」的 workflow** — 已有 `deploy_pages.yml`,重複會導致兩條同時 force-push gh-pages 打架。
- 可手動觸發：Actions → 對應 workflow → Run workflow → 選 **`main`**。

---

## 部署與同步規則（鐵律）

### 觸發來源
1. **`schedule cron`**（daily_miner）：每週一~五 16:30 (UTC 08:30) 自動完整採礦
2. **`workflow_dispatch`**：各 workflow 皆可 Actions UI 手動 Run
3. **`push branches: [main]`**：
   - 改 `index.html` → **`deploy_pages.yml` 秒級部署**（~1 分鐘）
   - 改 `miner.py` / `macro_miner.py` / `radar_miner.py` / `chief_ai_batch.py` / `daily_miner.yml` → `daily_miner.yml` 完整採礦+部署（30-60 分）

### 「自動同步發佈」的金科玉律
- **純前端改 `index.html` 只 push 到 main** → `deploy_pages.yml` 自動秒級部署，**不要手動編輯 gh-pages**
- **採礦相關 `*.py` 改動 push 到 main** → `daily_miner.yml` 完整採礦+部署
- **不要 hotfix `git push origin … gh-pages --force`** — 會被下次 workflow 自動部署覆蓋，且打亂時間軸

### Claude 的部署工作流（自動化）⭐ 使用者要求:每次介面做好就自動發佈到前端
- **Claude 修改 `index.html` 後直接 push 到 `main`，不開 PR** → `deploy_pages.yml` ~1 分鐘部署，使用者硬重新整理即可看到
- **若在 feature branch 開發,完成後必須 merge 回 main 並 push main**，否則 gh-pages 永遠看不到（push trigger 只認 main）
- 每次 push 前必跑三驗證：`node --check`（index.html inline JS）+ `python3 -m py_compile *.py` + `python3 scripts/check_prompt_vars.py`
- 出錯時使用者可以 `git revert HEAD` 回退，或叫 Claude 修

### 版本號規則(STRATEGY TERMINAL Vx.y)⭐ 使用者要求:每次更新版本號要一直往上加
- **小數位 +0.1**:每次 Claude push 純前端/小邏輯改動(UI 調整、bug fix、小功能補強) → V14.2 → V14.3 → V14.4 ...
- **主版本 +1**:大事件改版(架構大改、採礦機重做、新增整個 tab、AI 模型升級、整批功能重做) → V14.x → V15.0
- **位置**:`index.html` 兩處必須**同步**改:
  - `<title>首席 AI 司令部 | 戰略終端 V14.x</title>` (~line 12)
  - `<span ...>STRATEGY TERMINAL V14.x</span>` (~line 694)
- **時機**:每次 push main 前 bump 一次,commit message 寫「Vx.y → Vx.z」
- **判斷小 vs 大**:Claude 自行判斷,有疑問問使用者

### 部署後「看到舊版」處理（Service Worker 快取，已根治）⭐ 使用者常反映
- **「還是舊版」≠「沒合併」**：先確認部署本身有沒有成功，不要急著重推。指令：
  `diff <(git show origin/gh-pages:index.html | md5sum) <(git show origin/main:index.html | md5sum)` →
  **md5 相同＝已上線**，看到舊版只是用戶端 SW 快取 / GitHub Pages CDN 傳播延遲。
- **根因（勿回退）**：舊版 `sw.js` 的 `CACHE_NAME='stockai-v2'` 是固定字串，每次部署內容不變 → 瀏覽器不認得新 SW → 既有的 `controllerchange` 自動 reload 不觸發。
- **已根治機制**：`deploy_pages.yml` 部署時用 `sed` 把 `CACHE_NAME` 注入 commit SHA（`stockai-<sha8>`）→ 每次部署 sw.js 內容必變 → 新 SW 自動 install→skipWaiting→activate→clients.claim→controllerchange→自動 reload。`index.html` 的 `registerServiceWorker` 每 10 分鐘 + 切回前景即 `reg.update()`。
  - ⚠️ **不要把 `sw.js` 的 `CACHE_NAME` 改回固定字串**；main 模板留 `stockai-v2` 即可，注入只發生在 gh-pages 部署產物。
- **Claude 每次前端部署後必做**：① 用上面 md5 指令確認 gh-pages == main；② 明確回報使用者「已部署，開著的分頁最久約 10 分鐘自動換新版、切回前景更快，硬重整可立即見效（iOS PWA 可能需完全關閉 App 重開）」。
- **AI 結果快取**：`_aiCacheKey` 已含「提示詞雜湊」→ 改 `set_aiPrompt` 自動重算；**雙擊 🧠 首席 AI 全盤分析鈕**＝強制重抽（`runUnifiedGroqAnalysis({force:true})`，耗 1 次額度）。

### deploy 階段保護
`daily_miner.yml` deploy job 內 `if [ "$STOCKS" -lt 100 ] then exit 1`：
- 採礦結果不足 100 檔（artifact 下載失敗、merge 跑掉）→ 拒絕 force-push
- 看到 workflow 整體 success 但 gh-pages 沒更新時，先看 deploy job log 有沒有這條訊息

### 修改後驗證流程
1. 改 main → push（純前端 index.html 走 `deploy_pages.yml`；採礦 py 走 `daily_miner.yml`）
2. 至 Actions 看對應 workflow run 啟動
3. 純前端等 deploy_pages 綠燈（~1 分鐘）；採礦等所有 batch + deploy 綠燈（30-60 分）
4. 開網站硬重新整理（SW + meta cache-control 會自動拉新版）
5. 手機 PWA：因 index.html 有 `setInterval(reg.update(), 1hr)`，最多 1 小時內自動換新版（iOS PWA 因系統限制可能需要完全關閉 app 重開）

---

## 資料檔案位置

```
data/*.json          每支股票的 OHLCV + 法人籌碼（最多1200筆，約5年）
data/chips/*.json    主力分點籌碼（滾動20個交易日）
data/broker_names.json  券商代碼→名稱對照表（從 TWSE T86 累積建立）
data/radar.json      雷達預運算結果（底部/飆股/綜合強勢）
data/top_picks.json  AI 戰略選股（三位一體篩選前 30 名）
futures_cache.json   外資台指期未平倉淨口數
macro_cache.json     美股大盤日收資料（SP500/NASDAQ/VIX/TSM）
margin_cache_stock.json  個股融資融券餘額快取
```

### 資料流圖（K 線從採礦到渲染怎麼跑）

```
[ miner.py ] (SQLite stock_hunter.db 中介)
     │  export JSON
     ▼
data/{sym}.json (OHLCV+法人)、data/chips/{sym}.json (分點)、
broker_names.json、radar.json、top_picks.json、
futures_cache.json、macro_cache.json、margin_cache_stock.json
     │  daily_miner.yml force-push (orphan, 永遠 1 個 commit)
     ▼
[ gh-pages 分支 ]  ←→  [ data 分支 ]  (snapshot 備份)
     │  fetch (動態 ghBase + ?t=Date.now() 破 cache)
     ▼
[ index.html ] → IndexedDB cache (proTerm_kline_{sym}) → 渲染
```

**前端讀資料 URL 範本**：`https://xin7355-collab.github.io/StockAI-DB/data/{sym}.json?t=<timestamp>`

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
