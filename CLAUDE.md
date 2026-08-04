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

### V16.1 — daily_miner.yml workflow-level concurrency(新版自動 cancel 舊版)
- `daily_miner.yml` 已加 workflow-level concurrency:`group: daily-miner-${{ github.ref }}` + `cancel-in-progress: true`
- **連續 push 改 miner.py 時,舊 run 自動 cancel,只有最新版跑到完**(省配額 + 避免不同版本同寫 gh-pages 互相干擾)
- 想手動停跑中的 daily_miner:Actions UI → 該 run → 右上「Cancel workflow」按鈕,**完全無風險**(SQLite 逐股 commit、`if: always()` 上傳 artifact、deploy job STOCKS<100 守門擋空部署)
- deploy_pages.yml 1 分鐘部署不會被新 push cancel(`cancel-in-progress: false`),完整性優先

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
- 每次 push 前必跑**四驗證**（清單見下方「每次 push main 前必跑的四驗證」一節,以那節為準）
- 出錯時使用者可以 `git revert HEAD` 回退，或叫 Claude 修

### ⭐ Claude 永久授權（使用者明示:看不懂程式碼,壞了再修就好）
- **純前端 / 小邏輯改動完成、四驗證通過後**：**不需問使用者**,直接 `git checkout main && git merge <feature-branch> --ff-only && git push origin main`,讓 `deploy_pages.yml` 自動上線
- **採礦 `*.py` 改動**:同上,直接 merge main + push,由 `daily_miner.yml` 接手
- **無需先開 PR**;若 web session 開在 feature branch,完成就 fast-forward 合併回 main
- ⛔ **仍須先問使用者**的例外:① 大規模重構/架構大改 ② 刪檔/刪資料 ③ 改 GitHub Actions workflow 邏輯 ④ 動 `data/` 內快取 ⑤ 不確定是否會壞時
- 壞了 → 使用者說「壞了」→ Claude 直接修;或 `git revert HEAD` 回退

### 版本號規則(STRATEGY TERMINAL V 大.中.小)⭐ 使用者明示(2026-07-16 更新):三段式語意版號,從 V68.0.0 起
- **格式**:`V 大.中.小`(如 **V68.0.0**),像里程表:
  - **小改**(bug 修、小 UI、小功能、採礦、workflow)→ **末位(小)+1**:V68.0.0 → V68.0.1 → …→ V68.0.9
  - **逢 9 進位**:小位滿 9 → 進中位、小位歸 0:**V68.0.9 → V68.1.0**
  - **大改**(大功能、架構大改)→ **個位(大)+1、後兩位歸 0**:→ **V69.0.0**
  - ⚠️ 中位**只靠小位滿 9 進位**動,不單獨跳;沒有「中改」級,不是小改就是大改。
- **舊「一律 +0.1」規則作廢**(2026-07-04 那版),改用上面三段式。
- **位置**:`index.html` **兩處同步**改 + **一處 JS 常數** + **一筆更新紀錄**:
  - 版本註解:`<!-- STRATEGY TERMINAL V大.中.小 … -->` (~line 18)⭐ **V69.8.7 起此行只留「當前版本號」一行**,歷史寫 `_CHANGELOG` + `CHANGELOG.md`,⛔ 勿再往這行累加歷史(曾累到單行 93.5KB 拖慢載入)
  - 置頂 badge:`<span …>V大.中.小</span>` (設定中心 header,~line 586,`grep -c '>V大.中.小</span>'` 確認=1)
  - **JS `_APP_VERSION`**(openSettings 前):跟 badge 同步改,否則更新提醒判不出新版
  - **`_CHANGELOG` 陣列最前面補一筆** `{ v:'V大.中.小', d:['簡述…'] }`(白話簡述,這是跳窗會顯的內容)
- **更新提醒系統(V68.0.0 起)**:`_checkVersionUpdate()`(init 呼叫)比對 localStorage `proTerm_lastSeenVer` vs `_APP_VERSION`,有新版自動跳一次 `updateLogModal`(只顯比上次新的版本),看完記住不再跳;設定中心「🆕 更新紀錄」可回看全部、「✨ 功能總覽」開 `featuresModal`。
- **時機**:每次 push main 前 bump,commit message 開頭寫「V舊 → V新」
- **驗證**:`grep -c '>V大.中.小</span>' index.html`(=1)+ 確認 `_APP_VERSION` 與 badge 一致 + `_CHANGELOG` 有新筆

### 部署後「看到舊版」處理（Service Worker 快取，已根治）⭐ 使用者常反映
- **「還是舊版」≠「沒合併」**：先確認部署本身有沒有成功，不要急著重推。
  ⚠️ **V71.0.8 起 md5 比對法作廢** — `deploy_pages.yml` 會把部署產物壓縮(P2-3)，
  gh-pages 的 `index.html` 本來就不會跟 main 逐位元組相同。**改比對版本號**：
  ```bash
  _v(){ git show "$1:index.html" | grep -oE "_APP_VERSION: ?['\"]V[0-9.]+" | head -1 | grep -oE "V[0-9.]+"; }
  diff <(_v origin/gh-pages) <(_v origin/main) && echo "✅ 已上線"
  ```
  **版本號相同＝已上線**，看到舊版只是用戶端 SW 快取 / GitHub Pages CDN 傳播延遲。
  (壓縮會把空格吃掉、單引號換雙引號，所以樣式要 `: ?['\"]` 兩種都吃。)
- **根因（勿回退）**：舊版 `sw.js` 的 `CACHE_NAME='stockai-v2'` 是固定字串，每次部署內容不變 → 瀏覽器不認得新 SW → 既有的 `controllerchange` 自動 reload 不觸發。
- **已根治機制**：`deploy_pages.yml` 部署時用 `sed` 把 `CACHE_NAME` 注入 commit SHA（`stockai-<sha8>`）→ 每次部署 sw.js 內容必變 → 新 SW 自動 install→skipWaiting→activate→clients.claim→controllerchange→自動 reload。`index.html` 的 `registerServiceWorker` 每 10 分鐘 + 切回前景即 `reg.update()`。
  - ⚠️ **不要把 `sw.js` 的 `CACHE_NAME` 改回固定字串**；main 模板留 `stockai-v2` 即可，注入只發生在 gh-pages 部署產物。
- **Claude 每次前端部署後必做**：① 用上面**版本號**指令確認 gh-pages == main；② 明確回報使用者「已部署，開著的分頁最久約 10 分鐘自動換新版、切回前景更快，硬重整可立即見效（iOS PWA 可能需完全關閉 App 重開）」。
- **AI 結果快取**：`_aiCacheKey` 已含「提示詞雜湊」→ 改 `set_aiPrompt` 自動重算。
  ⚠️ 舊文寫的「雙擊 🧠 首席 AI 全盤分析鈕＝強制重抽 `runUnifiedGroqAnalysis({force:true})`」**已作廢** —
  該功能 V51.4 停用(entry 即 return)、V71.0.7 整條死鏈刪除,現在沒有這顆按鈕也沒有這支函式。

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

### ⭐ FinMind 是「付費版」（使用者多次明示，鐵律，別再當免費版看待）
- **使用者的 `FINMIND_TOKENS`（GitHub Secrets，逗號分隔多把）是付費會員 Token**，額度約 **6000 req/hr/把**，**不是**匿名免費額度。
- 因此**分點（`TaiwanStockTradingDailyReport`）採礦端抓得到**（付費版沒有 402 付費牆）→ 全市場滾動採礦靠的就是這個付費額度。
- **前端手機端**用的是使用者自己 localStorage 填的 key（可能也是付費），**跟採礦端的 GitHub Secrets Token 不同把、不同 IP，額度分開算**。
- ⛔ 舊文件寫「FinMind 免費版限制 / 匿名額度 / 分點被付費牆擋(402)」是**早期免費版時代的紀錄**，現在**已付費**，那些限制**多數已不適用**（保留在下方「V35.x」只作歷史脈絡，別再拿來當「做不到」的理由）。
- **要更全/更快** → 加更多 `FINMIND_TOKENS`（多把輪動額度倍增）或調高 `HOT_TURNOVER_TOP`。

#### ⚠️ 2026-07-30 實測:目前 `FINMIND_TOKENS` 沒有一把能開台指 VIX(**帳號問題,不是程式問題**)
V71.5.7 補上「每一把 token × 4 個候選資料集名稱」全輪動後,FinMind 回的原文是:
```
tok1/TaiwanOptionVix:400/Token is illegal.          ← 第 1 把:金鑰無效或已過期
tok2/TaiwanOptionVix:400/Your level is register.    ← 第 2 把:金鑰有效,但帳號等級是 register(免費層)
                          Please update your user level.
tok3/TaiwanOptionVix:400/Token is illegal.          ← 第 3 把:同第 1 把
```
→ `Your level is register` 代表**那把金鑰是通的,只是帳號在免費層**,這個資料集要更高層級;
另外兩把是無效/過期。所以「台指 VIX 沒有資料」的真因是 **Secrets 裡的金鑰組**,
⛔ **再怎麼改程式都不會有值** —— 別再花時間試資料集名稱或加輪動(已經全試過了)。

**⭐ V71.7.0 更正結論:不必為了台指 VIX 付費 —— 換來源就好。**
台指選擇權波動率指數(台指 VIX)本來就是**期交所自己公布的公開資料**,
期交所 OpenAPI **不需要金鑰、不需要付費**。之前卡住只是因為走了 FinMind 這條路,
而那個資料集在 FinMind 需要付費會員層級。
→ `fetch_tw_vix()` 已改成 **① 期交所官方(免費)→ ② FinMind(付費層,只當備援)**。
⚠️ 沙箱連不到 taifex,候選端點名稱是推測的;全猜錯時 `_taifex_list_endpoints()`
   會把官方端點清單印進 log(同 V71.3.4 解 FinMind 資料集名的做法),下一輪就能定名。
測試:`scripts/test_finmind_diag.py` ⑦(含「沒有任何 token 也拿得到值」這條)。

若期交所那條也不通,才剩下兩條路(都要使用者動手,Claude 讀不到也改不了 Secrets):
① 確認付費(Sponsor)那把金鑰有放進 `FINMIND_TOKENS` 且沒過期;
② 或接受台指 VIX 就是空的(前端已誠實顯「沒有資料」,不假造)。

⚠️ 這條**不推翻**上面「FinMind 是付費版」的鐵則 —— 分點採礦確實抓得到,付費額度是在用的。
兩件事並存:付費金鑰可能沒同時放進所有 Secrets 欄位,或某些資料集需要更高層級。
`_classify_finmind_fail()`(V71.6.2)已把三類壓成一句結論寫進 `tw_vix_error`,
以後跑 `scripts/data_audit.py` C 類就直接讀到「等級不足 / 金鑰無效 / 全部回空」,
不用再從 400 字堆疊裡挑。測試:`scripts/test_finmind_diag.py`。

### 資料來源與極限防禦
1. **OHLCV 與法人**：直接抓取 TWSE/TPEX 免費 API，並具備 SQLite WAL 鎖死防護與 JSON 分散式合併。
2. **盤中快照補丁**：若當天歷史 K 線尚未產出，會自動去證交所 MIS 抓取即時快照填補。
3. **分點籌碼**：透過 **FinMind 付費版 Token**（使用者已付費，見下方鐵律）抓取，自動 Token 輪動防 429 封鎖。
4. **外資期貨**：優先直連 **TAIFEX (期交所) 官方 CSV** 解析多空淨額，不再依賴容易斷線或缺漏的第三方 API。
5. **美股大盤**：yfinance

### 重要規則
- `fm_get()` 任何非200回應都會 fallback 到匿名請求
- 分點籌碼「已是最新跳過」時，仍呼叫 `_refresh_broker_names()` 更新對照表
- OHLCV 補丁邏輯：若舊記錄缺少 `foreign_net` 欄位，下次採礦時自動補上
- **採礦補挖機制**:每次 daily_miner 跑都全市場重抓,沒有「N 次後永久放棄」黑名單。某支股票連續 10 天 FinMind 拉失敗,下次跑還是會試。週末無 cron(只跑週一~五 16:30),所以週六/日資料缺只能等週一或手動觸發 Actions UI 重跑

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

### 外資期貨判讀邏輯(⚠️ V71.1.6 全面改寫,舊的絕對口數門檻已作廢)
**⛔ 絕對口數門檻(−10,000 / −25,000 / −40,000)已刪除,不要再寫回來。**
原因:小台/微台上市後未平倉總量放大,實測近 22 個交易日淨額區間 **−86,189 ~ −75,198**
→ **每一天都 ≤ −40,000**,於是「🚨 黑天鵝核彈+閃爍」天天亮、風險分數那個 0~30 分因子天天滿分
(等於常數,毫無鑑別力)、反攻雷達「回補到 −25,000 以內」永遠不可能轉綠。
當時全專案共 **7 處**同時失真。

**現行唯一真相來源:`app._fiFutState()`** — 回 `{net, chg5, pct, level, label, color}`,
判斷改看「相對自己」:近 20 日區間位階(`pct`)+ 5 日增減(`chg5`)。
- `🚨 急遽加空` = 5 日多空 ≥8,000 口 ・ `✅ 大幅回補` = 5 日回補 ≥8,000 口
- `⛔ 空單近期最重` = 位階 ≤15% ・ `✅ 空單近期最輕` = 位階 ≥85%
- 沒有歷史可比 → `level='unknown'`,誠實顯「基準累積中」,**不用過時門檻硬判**
⛔ 新增任何用到外資期貨的判斷,一律呼叫 `_fiFutState()`,別自己再寫一套門檻。

### 📐 順逆價差(taifex_backwardation)— 讀外資空單的必要配套
`macro_risk.json` 的 `taifex_backwardation` = 台指期近月收盤 − 加權指數(**負值=逆價差**)。
⭐ **外資期貨空單有一部分是「現貨多 + 期貨空」的避險/套利對沖**,單看口數會把避險誤判成看空:
- 空單大 **但仍正價差** → 多半是避險/套利,不是真的看壞
- 空單大 **又深度逆價差** → 才是真的在殺
- 恐慌末端的**極深逆價差**反而常是反轉領先訊號(要配 VIX 一起看)
⚠️ 期現比(`fi_ratio_alert`)一口台指期合約價值 = **指數 × 200**(V71.1.6 前誤寫 50000,
差 175 倍,導致比值恆顯示 0.0、那條判斷完全沒作用)。

---

## 使用者偏好

### 溝通風格
- **語言**:繁體中文回答(永遠不英文)
- **風格**:**直接做別問**,不要長篇解釋,重點條列;一次回多件事用編號 + 短句
- **問問題時機**:**只在「重大事件」才問**(架構大改、刪檔/刪資料、改 GitHub Actions、動採礦邏輯、不確定會不會壞);其他直接做。連「需要繼續嗎/部署嗎/版本要不要 bump」都不用問
- **使用者性格**:看不懂程式碼,壞了再說;Claude 永久授權 push main 直接 deploy

### 數字呈現
- **數學不好**:任何「賣的話虧多少%」「跌幅累積」都**順便給「實際金額」**(用 cost × shares × 1000 試算),不要只給 %
- **損益顯示**:`+1,250 元(獲利)` / `-3,500 元(虧損)`,不要只給 +1.25%
- **數字大字突顯**:重要指標用 `text-2xl` `font-black` `font-mono`,小副字用 `text-[10px]`

### UI 風格(仿券商 App)
- **參考對標 App**:元大證券、玉山證券、籌碼 K 線(全螢幕搜尋頁、現價紅底框、處置股神器)
- **漲跌停顯示**:在「現價數字本身」加紅底(漲停)/綠底(跌停)白字框 `bg-red-600 text-white px-1.5 rounded`,**不是**股名旁加 tag
- **顏色慣例**(台股):紅=漲=好、綠=跌=壞(全 UI 遵守)
- **⭐ 燈號鐵則(V70.2.8 使用者明示,推翻舊規則)**:🔴🟢 **只准表示「漲跌方向」**(🔴=偏多/上漲、🟢=偏空/下跌),
  **絕不可用來表示安全/危險** — 否則同一顆 🔴 在 A 卡是「危險」、B 卡是「上漲」,使用者會看反。
  - **風險/通過與否**一律用非顏色圖示:**✅ 安全/通過** ・ **⚠️ 警戒/注意** ・ **⛔ 危險/高風險** ・ **🚨 緊急(animate-pulse)** ・ **💀 必死** ・ **➖ 中性** ・ **⏳ 資料不足** ・ **💡 提示**
  - 文字顏色(text-red-*/text-green-*)仍照台股慣例(紅漲綠跌),**只有 emoji 改**
  - 新增任何卡片前先問自己:「這顆燈是在講方向,還是在講風險?」講風險就不准用 🔴🟢
  - ⚠️ 內部代碼(如 `computeUnifiedSignal` 的 `sig.level === '🟢'`)可保留舊值,但**只要會顯示給使用者的字串一律照上面改**
- **Badge 規格**:可疊加,沒命中時 `hidden`(不留空)
- **教學說明**:每個複雜卡片右上加「📖 教學」按鈕,點開 `alert()` 顯完整機制
- **對策建議**:每個風險警報下方加「💡 對策」一句話告訴使用者該怎麼做
- **「跟對做 / 對著做」**雙向策略:處置股、主力動向都給兩種選擇

### 功能方向
- **初學者友善**:複雜功能要有白話說明 + alert 教學 + 對策建議
- **零採礦優先**:能用前端 K 線/既有資料源算就先做,「動採礦」是最後手段
- **AI 模型分工**(2026-06-25 V22.4 後新規):
  - **新聞翻譯 / 簡訊 / 輕量建議判讀** → **Groq llama-3.3-70b / llama-3.1-8b**(主力,速度成本優勢)
  - **深度判讀**(首席全盤 / 籌碼解析 / 板塊輪動 AI / 庫存風險 AI / 處置策略 AI)→ **Gemini 2.5 Flash** 為主,**OpenRouter DeepSeek R1** 備援
  - **`_callDeepAI` 砍第三級 Groq fallback**(深度任務不該降級到 Groq 70b,失敗就 throw 讓上層處理)
  - Gemini 規格:safetySettings 4 大類全 BLOCK_NONE + thinkingBudget=0 + systemInstruction(避免廢話 + 預算保護)
  - 後端 `api.py` 已是 Groq(開盤戰略日報 / 新聞研判 / 預測稽核 → 維持 Groq ✓)
- **PWA 推播**:支援 `_fireAlert` + sw.js + 鈴鐺歷史 3 天
- **每日開 App 掃處置風險**:自動推 1 則(`_dailyDisposedAlertSweep`)

### 開發流程
- **直接 push main**:純前端改 → `deploy_pages.yml` ~1 分鐘上線
- **改完跑四驗證**(清單見「每次 push main 前必跑的四驗證」一節)
- **commit 用 HEREDOC**:多行 commit message + Co-Authored-By
- **PR 寫測試清單**:每張 PR body 給 Test plan(使用者上線後可逐項勾)
- **PR rebase**:撞 main conflict 時 `git rebase origin/main` + `git push --force`

### 🐛 定期修 bug(V25.2 後新增,使用者要求;V49.5 強化定期節奏)
**節奏鐵則(使用者明示:要定期修 bug)**:
- **每次改功能「順便修 bug」**:做新功能 / 改介面時,若順手看到附近有 bug,一併修掉(分 commit,別混在功能 commit 裡)。
- **每推 3-5 版做一次「主動巡邏」**:跑多代理 bug 掃描(見下),把確認的 bug 分批修。
- **多代理審查 + 人工驗證流程(鐵則,V41.27 起實證有效)**:
  1. 派 2+ 個 `Explore` 代理平行掃(前端一組、採礦/workflow 一組),各自只回「確認的 bug + 行號 + 具體失敗情境 + CONFIRMED/SUSPICIOUS」。
  2. **人工逐條讀原始碼驗證真偽** —— 約 1/3 是誤報或設計取捨,**別照單全收**。
  3. 只修「人工確認為真」的,誤報要在 commit message 寫明「已驗證非 bug」留紀錄。
  4. 四驗證 + 分 Batch commit,每個 Batch 版本 +0.1。
- **git/workflow 類 bug 要「實測」不要用猜的**:改 workflow 的 git 流程時,開 `/tmp` 小 repo 實測 `git checkout -f` / `git add -f` / gitignore 交互(如 V49.4 實測 `checkout -f` 可越過 gitignore untracked 衝突),別靠推理。

**每次 push main 前必跑的「四驗證」**(⚠️ 全專案以這份為準,別處若寫「三驗證」是過期敘述):
1. `node scripts/smoke_test.mjs`(headless 真載入:app init / 43 個偵測器 / render 函式 / 無 pageerror。比舊的 `node --check` 只驗語法強得多)
2. `python3 -m py_compile *.py`(後端語法)+ **`python3 scripts/check_main_order.py`**(採礦進入點順序 — V71.1.1 新增,見下方陷阱 #9)
   + **`python3 scripts/check_workflow_paths.py`**(採礦產物有沒有真的被 artifact 上傳 — V71.4.7 新增,見下方陷阱 #11)
3. `python3 scripts/check_dom_ids.py`(DOM id 唯一性 — V71.0.7 起取代已失效的 check_prompt_vars.py)
4. **`awk '...' index.html`** 確認 7 個 `tabContent*` 容器 div 開合平衡(防 V25.0 那種 HTML 巢狀 bug 重演 — `tabContentMarket` 少 1 個 `</div>` 導致 5 tab 被巢狀其中,8 次嘗試才修到)

**驗證 HTML div 平衡腳本**(每次改 main HTML 結構必跑):
```bash
awk '/id="tabContentMarket"/{start=NR; bal=0}
start && NR>=start {
    o=gsub(/<div/, "<div");
    c=gsub(/<\/div>/, "</div>");
    bal += o - c;
    if (bal==0) { print "tabContentMarket 閉合於 L"NR; exit }
}
END { if (bal>0) print "❌ tabContentMarket 少 "bal" 個 </div>!" }' index.html
```
正確結果應顯「tabContentMarket 閉合於 L20XX」(且 L20XX < tabContentFav 開頭行號)。

**已知陷阱清單(寫進來避免重蹈覆轍)**:
| # | 陷阱 | 症狀 | 修法 |
|---|------|------|------|
| 1 | HTML div 不平衡 | 5 tab 被巢狀 → display:none 連鎖 | awk 驗證 + 補閉合 |
| 2 | Tailwind `hidden` class | 與 inline display 衝突 | 改用 setProperty('display',x,'important') |
| 3 | iOS Safari/PWA SW 快取頑強 | 改動上線但使用者看舊版 | `sw.js` CACHE_NAME 注入 commit SHA(deploy_pages.yml 已做)|
| 4 | render 函式 silent return | tab 空白但無錯誤 | 函式內加 placeholder,不要默默 return |
| 5 | `const app = {}` 不掛 window | `window.app === undefined`(但 onclick `app.x` 仍 work) | 別用 `typeof window.app` 判斷 app 是否 init |
| 6 | yfinance 個股 ticker 大小寫 | NVDA 大寫 / .KS .TW 後綴 | 嚴格按官方 ticker |
| 7 | FinMind 429 限流 | 分點籌碼抓不到 | Token 輪動 + 匿名 fallback |
| 9 | **採礦腳本 `if __name__ == '__main__':` 放在檔案中段**,新函式定義在它下面 | 執行到進入點時那些名字還不存在 → `NameError`,又被「一支失敗不影響其他」的 try/except 吞掉 → **workflow rc=0、job 顯示 success、artifact 照傳,但 JSON 檔根本沒產出**。前端永遠讀不到,而且完全沒有錯誤訊息。**本地 dry-run 測不出來**(dry-run 是 import 完才直接呼叫函式,順序問題自然消失) | 進入點區塊一律搬到**檔案最後面**;`scripts/check_main_order.py` 已納入 push 前驗證會自動擋。⚠️ 教訓:**「腳本 rc=0」不等於「功能有跑」** — 新增採礦函式後,一定要去 gh-pages 確認檔案真的出現(`git show origin/gh-pages:data/x.json \| wc -c`),別只看 workflow 綠燈 |
| 11 | **artifact 路徑清單(`path: \|`)行尾寫 `#` 註解** | `path: \|` 是 YAML **block scalar**,裡面每行都是「字面路徑」,行尾 `#` **不是註解**、會變成路徑的一部分 → 該 pattern 永遠比對不到檔案 → `upload-artifact` 預設只警告不失敗 → **workflow 全綠、artifact 照傳,那一檔就是不見了**,前端讀不到而且零錯誤訊息。實例:`data/breadth.json`(V71.3.8 市場廣度歷史)因此從上線到 V71.4.7 一次都沒上過 gh-pages,前端 ADL 騰落線一直空著 | 註解一律寫在 `path: \|` **那一行之上**(block 之外才是真 YAML 註解);`scripts/check_workflow_paths.py` 已納入 push 前驗證,會同時擋「行尾註解」與「採礦產物沒被任何 artifact 收」兩件事 |
| 19 | **切股時只清「一部分」卡片** → 載入失敗的卡會原封不動留著**上一檔**的內容 | 最危險的一種:畫面上完全沒有錯誤訊息,使用者會拿別檔的判讀去做決定。實例(V71.7.6,使用者截圖):標題是「大成鋼 43.10 −1.37%」,下面的分時圖卻是另一檔**漲停**的股票(100→102.8、+9.30%),連盤中六脈都跟著算成「多方共振 6多/0空」。根因兩層:① `analyze()` 切股時**只清 2 個 AI 結果框**,其他 async 才填的卡都沒清;② `loadIntradayKline` 有**四條**失敗路徑(沒金鑰/無回應/額度用盡/當日無資料)都是直接 `return` 而不清畫面 | ⛔ 三條一起做才算修好:**(a) 清空要早於載入**(切股當下就清,不是等資料回來);**(b) 每一條 early return 都要清畫面 + 指名是哪一檔**(「⚠️ 大成鋼 的盤中資料抓不到」);**(c) await 回來要檢查 `currentSymbolId` 還是不是原來那檔**,不是就別畫。個股頁新增任何「async 才填的卡」,一律加進 `analyze()` 的切股清空清單。測試 `test_switchclean.mjs` 8 條把三層都釘住 |
| 22 | **守門把值設成 None 卻不寫原因** → 前端只顯「沒有資料」,而且從 JSON 也查不出是「抓不到」還是「抓到但被擋掉」 | 實例(V71.8.0,使用者回報反攻雷達「價差翻正」長期沒資料):`macro_risk.json` 的 `taifex_backwardation` 是 None、`taifex_backwardation_error` **也是 None** → 零線索。真因是兩層:① V71.4.9 加的「期貨與現貨必須同一交易日」守門,只有 **yfinance** 那條腿會設 `_LAST_TX_FUT_DATE`,而 **OpenAPI 才是主要來源** → 主線根本沒被守到 ② 差一天算出的離譜值被下游「離譜值守門」默默設成 None 而不留原因 | ⛔ **任何把值設成 None 的守門,都必須同時寫 `*_error`**;⭐ 而且要把**判斷用的原始數字一起輸出**(這裡是 `taifex_near`/`taiex_close` 與各自日期)—— 沒有那兩個數字,永遠查不出是差一天還是抓不到。同理:**加守門時要檢查所有來源分支都有設判斷所需的欄位**,別只補主要那條以外的。測試 `scripts/test_basis_legs.py` |
| 34 | **守門把值設成 None,但「斷崖防護(last-good)」又把昨天的舊值填回去** | 兩個防呆機制打架,結果是**顯示了不該相信的數字**(比空白更危險),而且 JSON 裡會出現「`x_error` 說不算、`x` 卻有值」的自相矛盾。實例(V72.1.2,資料體檢抓到):`taifex_backwardation = -156.0` 配 `taifex_backwardation_error = '期貨(08-03)與現貨(08-04)不同交易日,不計價差'` → 前端拿到的是**昨天的價差配今天的日期**。⚠️ 順逆價差是**當日快照**(昨天 +50 今天可能 −200),沿用昨天在語意上就是錯的(同陷阱 #16);而 `fetch_taifex_backwardation` 自己的註解本來就寫「不硬給一個看起來合理的假數字」—— 斷崖防護等於推翻了那個明確意圖 | ⭐ **區分兩件事**:「**今天暫時抓不到**」可以沿用(匯率/金價那種變化慢的)、「**守門刻意判定不可信**」⛔ 不可沿用。`macro_miner._NO_CARRY_ON_ERROR` 清單 + 斷崖防護迴圈開頭 `if key in _NO_CARRY_ON_ERROR and out.get(f"{key}_error"): continue`。⚠️ **那行必須排在「沿用」之前**,排後面等於沒接上(測試有釘順序)。⚠️ 新增任何「有守門會把值設成 None」的**當日快照**欄位,記得加進清單。測試 `scripts/test_basis_legs.py` ⑦ |
| 25 | **指數(^TWII/^TWO)沿用個股版面** → 對它顯示「買進/停損/掛單價」 | 使用者截圖:加權指數頁寫「這檔在盤整,先等它表態」「帶量突破前高 45,323 → 買進」「跌破前低 → 這檔不做」「🛑 停損防守」。⚠️ **指數不能買**,那些價位使用者根本下不了單,看了只會誤導;而且指數也沒有 EPS/本益比/營收,「基本」整頁對它是空的 | `_isIndexSym()` + `_renderIndexCommand()`(V71.8.2):指數走專用卡「🏛️ 現在什麼位置」—— 一年位階/年線/月線季線/量能/波動率/外資,⛔ **刻意不給任何買賣價位**,並白話寫「指數不能直接買,要跟大盤就買 0050/006208」。**指數只留「總覽 + K線」兩個分頁**(V71.8.4):藏掉 進場・出場 頁籤與 基本・當沖・回測・即時・籌碼・多空。理由都是「永遠不會有資料」而不是「今天剛好沒有」——即時(報價商只給個股逐筆/五檔,指數也沒有掛單簿)、籌碼(法人買賣超是**逐檔**資料,指數沒有自己的一份;也沒有融資券/借券)、多空(28 條有 27 條要籌碼/基本面/價量 → 永遠「訊號不足 1/28」)。⭐ 大盤層級的三大法人本來就在「大盤」頁,不必再開空殼。換回個股自動復原。⚠️ **踩過的坑**:`switchOvTab` 尾端會整個重寫 `b.className` → 先 `classList.add('hidden')` 會被洗掉,hidden 必須寫進那個 className 字串裡。測試 `scripts/test_indexpage.mjs` |
| 31 | **靠「程式碼裡沒人參照這個 id」去猜哪些是空殼** | V71.8.8 想做「空殼卡自動收起」,用靜態掃描找出 26 個「沒有 JS 參照」的容器,其中 `directActionBox` / `ovBodyEntry` / `ovBodyExit` 被列入白名單 —— 實測才發現它們是**包住整段活內容的外殼**(進場明細、四關卡、位階溫度計、法人目標價全在裡面),掃下去會讓整段消失。靜態掃描看不到 `subContent${t}`、`'chipTabBtn-'+k` 這種**動態組出來的 id** | ⛔ 白名單一律**實測量字數**才敢列入(headless 載入後印 `innerText.replace(/\s/g,'').length`),不可用靜態參照數猜。掃描條件也不能只看「直接子層是否全 hidden」—— 外殼裡常還包一層沒 hidden 但本身空的 wrapper。⛔ 含 `canvas/img/input/button` 的容器不掃(圖表沒文字但不是空的);已有「誠實空狀態文字」的卡也不列入(那是有用的說明,而且非同步才填,掃太早會誤藏)。測試 `scripts/test_emptyshell.mjs` 把「白名單不可含活外殼」釘死 |
| 32 | **卡片放錯頁籤 → 使用者找不到,以為沒做** | 使用者連兩次問「找不到上方套牢區」。功能做好了、測試也綠,但它被放在**總覽→出場**頁籤裡 —— 而「我現在買還有多少賺頭」是**進場**才會問的事。功能存在 ≠ 使用者找得到 | 依「使用者在什麼情境會問這個問題」決定放哪頁:上檔空間→進場、防守價→出場。⭐ 拆開後在留下的那張加**一行指路**(「上檔空間在『進場』頁籤」)。⚠️ 新增卡片時務必確認它在 `data-ovpane="xxx"` 的 div **裡面** —— 放在兩個 pane 中間會變成「不管切哪頁都顯示」(V71.8.8 第一版就插在 entry 收尾之後,測試用 `closest('[data-ovpane]')` 才抓到) |
| 30 | **「壓力」只用前高、而且只看現價附近** → 暴跌後那格永遠是空的 | 使用者問「分析師說國巨壓力在 800,這是籌碼還是 K 線看的?」→ 是 **K 線+成交量的套牢賣壓**,跟籌碼無關。但我這邊看不到,兩個限制:① `_chuResistanceZones` 只收 **+15% 以內**的前高 —— 國巨從 1,220 殺到 502,最近前高在 **+46%**,全被濾掉 ② 量價密集區只挑**單一最大格**,而國巨最大那格是暴漲前的底部(250~325,在現價**下方**)→ 上方四層量堆積完全沒被提到 | ① 前高上限 15% → **60%**(暴跌後最需要知道上面套牢在哪)② 新增 `_overheadSupply(data,last,pC)`:近 120 日成交量分布,取現價**上方**、單格 ≥2% 的桶,相鄰併層,由近到遠最多 3 層,每層標「佔總量幾%」。併進 `_upsideRoom` 統一排序。實測國巨 502 → 613~705(9.3%)、**773~865(9.7%)**、957~980(2.5%),中間那層正是分析師講的 800。⭐ 通用:**壓力要有「量」的證據,不能只有「價」** —— 前高是一個點,套牢區是一整片。測試 `scripts/test_overhead.mjs`(用真的 gh-pages 2327 資料) |
| 29 | **指數的 `volume` 是 0,但 `amount` 每根都有** | `data/^TWII.json` 486 根裡**最近 44 根 volume=0**(資料源不給指數成交量)→ 量柱空白、量能判斷失效、六脈「量能」那條算不出來。但 V71.6.5 併進來的 `amount`(證交所官方集中市場成交值,元)**486 根全有**,一直沒被前端用到 | `applyLatestPrice` 對指數把 **整條序列** 的 `volume` 換成 `amount`,並標 `_volIsAmount`。⚠️ 照陷阱 #17:**必須整條一次換完**,只補缺的那 44 根會造成「張數 vs 元」的雙峰分布;⛔ 而且顯示端的單位與名稱要一起換(「成交金額(兆)」),否則 1.1 兆 ÷1000 會顯示成「1149185.3K張」。個股維持張數,兩邊不混。測試 `scripts/test_idxvol.mjs`(用真的 gh-pages 資料當測資) |
| 27 | **占比/百分比沒有「最少樣本」守門** → 1÷1 = 100% 的假信心 | 使用者截圖:加權指數多空頁「多方 1 項・1 分 / 0 項 空方 → **多方優勢 100%**」,而同畫面總覽寫「高檔回檔中」、六脈寫「訊號不足」→ 三個結論打架。28 條規則只命中 1 條就下結論,那個 100% 完全沒有意義。⚠️ **不只影響指數** —— 任何籌碼/基本面資料不齊的冷門股都會踩到 | `_calcBullBearScan` 加 `HITS_MIN=4`:命中數不足就回 `verdict='訊號不足'` + `lowSample:true`,顯示層改秀「命中 N/28」而**不是百分比**。⭐ 通用規則:**任何 `a/(a+b)` 型的占比,都要先問「a+b 夠不夠大」**;不夠就誠實說樣本不足,別給方向(同「寧可不給方向」原則)。測試 `scripts/test_lowsample.mjs` —— ⚠️ 測試要呼叫**真的**函式,別在測試裡複製一份判定邏輯(那會變成第二份真相,程式改了測試還是綠的) |
| 28 | **「資料源本來就沒有」被當成「條件沒過」** | 加權指數的資料源不給成交量、也沒有券商分點 → 六脈的「量能」「籌碼」兩條被算成失分,分母又寫死 5 → **還沒開始比就先扣兩分**,永遠不可能達標。同理任何缺資料的個股 | 缺資料的條件標 `na:true`(既有機制,量能那條漏掉了),分母改用 `applicable`(真的算得出來的條件數),門檻用 `Math.max(3, N-1)` 之類跟著縮。⭐ 通用規則:**「沒有資料」與「條件不成立」是兩件事,不可混為一談**;顯示分母時也不可寫死(`${okN}/5` → `${okN}/${applicable}`) |
| 26 | **自我修復程式放在「它要修的那段程式」裡面** | V71.8.2 第一版把「文件被截斷就清快取重載」寫在主 script 裡 → 實測(砍掉檔案後 30%)發現:主 script 一旦被截斷,修復程式自己也不會執行,於是**永遠修不好**。這跟「壞掉的快取會被 SWR 永久固化」是同一類問題 | 自我修復一律放 **`<head>` 最前面的獨立 `<script>`**,只依賴「檔尾哨兵 `window.__pageComplete`」這個最小契約。⭐ 通用原則:**檢查者不可以跟被檢查者同生共死**。另外要**上鎖只修一次**(sessionStorage),否則「壞的 → reload → 還是壞的」會變成無限重整。測試 `scripts/test_selfheal.mjs` 16 條(含「連主程式都死掉時仍要修得起來」) |
| 24 | **「等資料源修好」等成無限期 → 那一格永遠空著** | 使用者連續回報兩次「台指 VIX 沒有資料」。前兩版我都只改**說明文字**(講原因、講進度),但格子還是空的、還是不計分 —— 對使用者來說沒有任何差別。⚠️ 教訓:**解釋 ≠ 修好**;上游要幾輪才通的東西,先問「我自己算得出替代品嗎?」 | V71.8.1:台指 VIX(選擇權隱含波動率)拿不到 → 改用 `_twRealizedVol()`(加權近 20 日**實現**波動率年化 + 近一年位階),零採礦、零 API,當場有數字且會計分。⛔ **名字必須不同**(不同公式不同名字):有 VIX 叫「台指 VIX 退燒」、沒有叫「台股波動率退燒」,並在說明裡寫清楚「一個看未來、一個看過去」;上游通了自動換回,不並存。門檻用**自己的歷史位階**不用寫死數字(同 V71.1.6 外資期貨的教訓)。測試 `scripts/test_twvol.mjs` |
| 23 | **API 對「不存在的路徑」回 HTTP 200 + 網頁,而不是 404** | 期交所 OpenAPI 實測如此 → 候選端點全試一輪,得到的是 5 個 `Expecting value: line 1 column 1`(= 拿到 HTML 去 parse JSON),看起來像「全部失敗」但其實是**名字猜錯**。更糟的是連 `swagger.json` 也回網頁 → 原本設計來「讓官方自己說答案」的端點列舉函式也一起失效,於是一輪一輪猜、永遠猜不到 | `_taifex_list_endpoints` 改成:JSON parse 失敗時**從 HTML 用 regex 撈 `/v1/<Name>`**;⭐ 並且把撈到的清單**寫進回傳的錯誤字串**(會存進 `macro_risk.json`)—— 只印在 workflow log 沒用,log 要翻 job 又會過期,寫進 JSON 才能 `git show origin/gh-pages:...` 直接讀到 |
| 21 | **`auto_adjust=False`(原始價)+ 舊列不回溯調整 → 分割/減資當天永久斷崖** | 實例(2026-07-31,在回答「分析師買 0050」時做回測撈到):`data/0050.json` 有 2024/07/01 ×4.00、2025/06/11 ÷4.00 兩個跳空 → **中間整整一年的價位是別的尺標**,K線/均線/位階溫度計/回測全歪,而 0050 正是最多人看的 ETF。全市場掃出 **72 檔**同樣中招(0050・2327 國巨・4763 潤泰全・1808・8422・6919・00674R 等槓桿反向 ETF)。⚠️ `auto_adjust=False` 是**刻意**的(才對得上證交所官方收盤),⛔ 別改成 True 去「解決」它 —— 那會讓現價跟官方對不起來 | `_backadjust_splits()`(V71.7.9,在 `export_json` 寫檔前)。判斷依據是**物理不可能**:上市櫃單日 ±10% 漲跌停 → 相鄰交易日超過 `1.1^gap` 就不可能是真實漲跌 → 找最接近的整數倍(2~10 或其倒數),**殘差要落在漲跌停範圍內**才認定。⭐ 三個關鍵設計:① **只改舊的、最新價不動**(要等於官方收盤)② **倍率先累乘再一次四捨五入**(分兩輪各自 round 會把 46.61 變成 46.60)③ **冪等** —— `seed_db_from_json` 每次 run 都把 JSON 讀回 SQLite,不冪等就會越調越歪。⛔ 不動 `foreign_net`/`margin_balance`(那是當時真實張數,不是價格尺標)。測試 `scripts/test_backadjust.py` 20 條 |
| 20 | **Service Worker 快取裡那份 `index.html` 也可能是「半截的」** | 症狀跟 #18 一模一樣(`SyntaxError: Unexpected EOF`),但**位置是文件本身**:`?source=pwa:1`。⚠️ 這裡的「第 1 行」不是線索不足 —— 部署產物是**壓縮過的單行 HTML**,所以「第 1 行」就是整份檔案,`Unexpected EOF` = script 讀到一半就沒了。iOS 對 PWA 有儲存空間上限,`cache.put()` 寫到一半被中止時存進去的是**不完整的 body,而且不會 reject**;`sw.js` 的導覽請求走 stale-while-revalidate → 每次都先吐快取 → **每次開 App 必爆,而且自己永遠好不了**。⛔ 別再往 `JSON.parse` 方向找(V71.6.9 已把 localStorage 那條全數修掉,錯誤照跳就代表不是那條) | `sw.js` 加 `_isWholePage(res)`:回傳快取**之前**先驗尾巴 512 bytes 有沒有 `</html>`,不完整就 `cache.delete()` 改走網路;寫入快取前也驗一次(免得把壞的存進去)。只讀尾巴不整份載入(2.2MB × 每次導覽太貴)。⭐ 通用教訓:**任何「先吐快取再背景更新」的路徑都要有完整性檢查** —— 快取本身壞掉時,SWR 會把壞值永久固化。測試 `scripts/test_swcache.mjs` 8 條(含「網路也掛掉時不可吐白畫面」) |
| 18 | **localStorage 的值可能是「半截的」,而且壞了永遠不會自己好** | iOS 對 PWA 的儲存空間有限額,`setItem` 寫到一半被中斷 → 之後每次 `JSON.parse` 都丟例外。Safari 的訊息是 **`SyntaxError: Unexpected EOF`**(Chrome 說 `Expected ',' or ']'` / `Unexpected end of JSON input`,同一件事)。**只 try/catch 不夠** —— 壞值沒被清掉,每次開 App 都重演一次。實例(V71.6.9,使用者截圖回報):`fetchStockList` 有 3 個裸 `JSON.parse(cached)`,最要命的那個**寫在 `catch` 區塊裡面**,自己爆掉時沒有任何東西接得住 → unhandledrejection → 錯誤紅框。而 `proTerm_stockList`(全市場約 2,000 檔)正是全 App 寫進 localStorage **最大的一筆**,最容易被截斷 | 一律走 `app._lsJson(key, fallback)` —— 壞掉就 `removeItem` 該 key 再回 fallback,下次自然重建。**`setItem` 也要包 try**(空間不足會 throw,不可讓它把已經抓好的資料一起帶走)。⭐ 重現手法(已寫成 `test_lscorrupt.mjs`):headless 載入前 `localStorage.setItem(k, '{"a":1,"b":[1,2')` 灌半截值,斷言無 pageerror / 無 unhandledrejection / 壞值已被清除 |
| 17 | **兩個來源寫進同一個欄位名,但單位/量級不同** | 合併後那一欄變成雙峰分布,所有依賴它的統計(均量、OBV、量價背離、百分位)全部算出垃圾,而且**看起來像資料異常而不是 bug**。實例(V71.6.2 差點踩下去,靠實測擋住):想把 TWSE FMTQIK 的「成交股數」補進 `^TWII.json` 的 `volume` 欄 —— 但既有 423 列的 volume 來自 yfinance,實測中位數 **3,734,300**,官方成交股數是 **~54 億**,差約 **1,500 倍**。更陰的是連帶效應:前端 V71.4.9 的「幽靈棒過濾」只看**最後 60 根**的零量佔比,一旦近 3 個月被填滿,佔比從 ~100% 掉到 ~0% → 過濾器改為對整個 486 列生效 → 更舊的零量列被整批刪掉,「486→424 根、個股頁停在 3 個月前」那個老 bug 直接復活 | **不同來源就給不同欄位名**:官方值寫 `mkt_vol`(股數)/ `amount`(金額,元),`volume` 原封不動。⭐ 通用做法:補任何欄位前,先把**新舊兩邊的中位數印出來比數量級**(`git show origin/data:data/x.json \| python3 -c ...`),差 10 倍以上就不准共用欄名 |
| 16 | **把「每日快照檔」沿時間軸加總** | `risk_history.json` 這類檔是「每天跑採礦時的即時快照」,上游(證交所/FinMind)當天還沒更新時會**沿用前一天的值**。單看每一列都對,加起來就錯得離譜 —— 實測 07/09·07/10·07/13 的 `fi_spot_net` 都是 −472.53(同一天的數字被算了 3 次)。要「累計」一律**向官方要現成的累計值**(如 BFI82U `type=month`),或先做「連續重複值去重」再加總。快照檔只適合看**趨勢方向**(連買/連賣幾天),不適合當累加來源 | V71.6.1 外資月累計改走 TWSE 官方月報;`scripts/test_fi_mtd.py` ⑦ 把「快照有連續重複值」寫成測試,防日後有人「優化」成本地加總 |
| 14 | **「今天/最新」用『資料裡的最大日期』判斷** | `data/` 裡只要有少數股票已寫入隔日的盤中列,`dates[-1]` 就會變成那個未完成的日期。實例(2026-07-30 09:47):`breadth.json` 的 07/27、07/28 成交金額都對,**只有最新的 07/29 是 0** —— 因為 5 檔有 07/30 盤中列 → 07/30 被當成「今天」但樣本不足被略過,07/29 則落到「已經有了→跳過」分支,保留了上一版沒有該欄位的舊列。**前幾天對、只有最新那天錯**,極難察覺 | 一律取「**通得過品質門檻的**最大日期」(`total >= MIN_TOTAL`),不是 `dates[-1]`;並在 log 印出「最新日期樣本不足 → 改用 X 當最新交易日」 |
| 15 | **新增欄位只有「往後」才有,舊列永遠缺** | 已存在的日期會走「跳過」分支 → 新欄位永遠補不到歷史列上。這已經咬過兩次(breadth 本身、breadth 的 amt) | 「跳過」分支要做 **schema self-heal**:舊列缺新欄位而本輪算得出來就就地補,其餘既有數值不動(仍遵守「實跑寫入優先」) |
| 12 | **同一支腳本在 A workflow 有給機密、在 B workflow 漏給** | 實例:`macro_cron.yml` 跑 `macro_miner.py` 有給 `FINMIND_TOKENS`,但 `daily_miner.yml` 的並行 deploy step 也跑同一支卻只給 GROQ → `fetch_tw_vix` 回 `no-token` 寫成 null,而 daily_miner 正是最後 force-push gh-pages 的那個 → **有值的版本被蓋成 null**,前端顯「台指 VIX 沒有資料」,整條鏈零錯誤訊息、workflow 全綠。連 `macro_probe.yml`(探針)也一把 key 都沒給 → 探針永遠驗不出真因 | `scripts/check_workflow_paths.py::check_script_secrets` 已納入 push 前驗證:只比「同一支腳本同一個機密,一邊給一邊不給」(選用機密全報會太吵),實測修前 rc=1 抓到 10 處、修後 rc=0 |
| 13 | **期貨類拿「日線收盤」當現價** | 美股期貨/台指期幾乎 24 小時交易,`history(period='5d')` 日線最後一根給的是**上一個結算**,不是現在盤中價,**兩者方向常相反**。實例(2026-07-30 對照籌碼K線):我顯 標普期 −1.69%/那指期 −2.35%/道瓊期 −2.16%,真值全是 **+0.26~+0.39%**;台指期我顯 41,613、真值 39,645(差 1,968 點)→ 正價差 +10 變成逆價差 −394,「避險退潮」誤判成相反結論。⚠️ 同一時間美股**現貨**四雄完全正確 → 別誤診成「採礦跑太早/資料舊」 | 用 `_fetch_yf_future`(30 分 K 抓盤中現價 vs 日線抓上一個結算);判斷邏輯抽成純函式 `_pick_live_vs_settle` 做單元測試(沙箱連不到 yfinance,網路層只取資料且全程 fallback) |
| 10 | **快取/跳過的判斷用「有沒有做過」而不是「做到的內容夠不夠新」** | 分點採礦的跳過條件是 `chips_fetched_on == 今天`。傍晚那輪先跑熱門股(順序:CHIP_WATCHLIST ∪ 成交值 Top220 優先),當時證交所當日分點還沒出 → 拿到前一交易日卻被標記「今天抓過」→ 之後每輪都跳過;冷門股排後面,輪到時當日分點已出 → **反而最新**。實測完全顛倒:成交值**前 100 名全部是舊的**,冷門股 633 檔卻是最新的(5483 排第 34 也中招) | 跳過條件要**同時**看「做過」+「內容已追上最新」。V71.1.5 修法:先掃現有 chips 檔取 P95 日期當「全市場最新分點日」基準(取 P95 不取 max,避免單一髒檔的未來日期害全部重抓),自己的分點日 < 基準就重抓。⚠️ 通用教訓:**任何「今天已處理過就跳過」的快取,遇到「上游資料稍後才更新」的情境都會卡在舊值** — 判斷式要綁「資料的日期」,不是「處理的日期」 |
| 8 | **modal 與頁面共用同一組 id**(modal `appendChild(document.body)` 常駐、只 hidden 不刪 → 兩份同時在 DOM) | modal 開著時操作「按了沒反應」(內容被寫進背後看不見的頁面);`getElementById` 永遠只回 DOM 順序較前的那份 | 加 scope helper:modal 沒 hidden 時先 `modal.querySelector('#id')`,否則退回 `getElementById`(見 `_brokerEl`,V71.0.3)。**巡邏指令**:`grep -oE 'id="[a-zA-Z_][\w-]*"' index.html \| sort \| uniq -d` — 但要人工判真偽,同函式多個 `return` 或同容器 `innerHTML` 互斥的**不是** bug |
| 33 | **`const x = ...` 後面又 `x += ...`,而且包在 `try/catch(_) {}` 裡** | `TypeError: Assignment to constant variable` 被那個空 catch 完全吞掉 → **零錯誤訊息、卡片直接不見**,而且沒有人會發現。實例(V71.9.0 抓到):`_renderChipDistribution` 的 `const html` + 48 行後的 `try { ... html += idHtml; } catch (_) {}` → **V69.8.1 的「持股身份分布」從上線到 V71.9.0 一次都沒顯示過**。同一類:`catch (_) {}` 把「新寫的程式本身有語法/型別錯」跟「資料剛好沒有」混為一談 | ⛔ 任何 `catch (_) {}` 裡若有**賦值**動作,先確認目標是 `let`;新增「條件性追加 HTML」時一律把容器宣告成 `let`。⭐ 通用:**空 catch 只該包「外部資料可能沒有」,不該包自己寫的邏輯** —— 包進去就等於關掉那段的錯誤回報。巡邏指令:`grep -nE "const (html|out|s) = " index.html` 後比對同函式有無 `\1 +=`。測試 `scripts/test_tdcc4.mjs` ⑨ 把這條釘住 |

**修 bug 4 步驟流程**:
1. **重現**:使用者截圖 / console log / 確切操作步驟
2. **診斷**:加 console.log / 黃色 fixed toast / 強制 print 真實狀態(如 V24.9 救命)
3. **對症**:看診斷結果決定改 HTML / CSS / JS / 後端 — 不靠猜
4. **驗證**:四驗證 + 使用者實測一次

**Claude 主動巡邏**:每 5-10 次 push 後 Claude 自己跑一次:
- awk div 平衡(避免新加 HTML 又巢狀)
- grep `silent return` / `return;\s*}\s*$` 找潛在空白 bug
- grep `display:\s*none` 看是否新加 hidden 元素未對應 show 邏輯

## 📚 資料回算(backfill)鐵則 ⭐ 使用者明示(2026-07-30):「要馬上就能用的,不是還要等好幾天」

**做任何「從今天開始累積」的功能之前,先問一句:能不能從既有 `data/*.json` 回算歷史?**

- `data/{sym}.json` 存的是 **2~3 年日 K**(實測 2330 有 762 筆、回溯 2023/06),
  所以「每天的漲跌家數 / 每天的某個統計」幾乎都算得出過去值 —— **不需要一天一天等**。
- 實例:市場廣度歷史(`breadth.json` → 累積騰落線 ADL)。
  原本設計成「從今天開始存」,要等 10 個交易日才畫得出圖。
  V71.5.5 改成一次回算 → 實測拿到 **303 個交易日**(2025/05/07 ~ 2026/07/29,檔數 ≥500 的天數),
  上線當天就有一年以上可看。

**回算的四個必要條件(缺一個就會做出髒資料):**
1. **標記來源**:回算的列要加旗標(如 `bf:1`),跟實跑寫入的分開,日後查得出哪些是推算的。
2. **實跑優先**:已經有 live 值的日期**不覆蓋**,回算只補歷史上缺的日子。
3. **樣本守門**:每一天都要檢查樣本數(如 `total >= 500`),
   早期資料稀疏的日子直接略過 —— 不然 ADL 會被「那天只有 40 檔」的假點拉歪。
4. **誠實揭露偏差**:回算只涵蓋「目前還在 `data/` 裡的股票」→ **已下市的不算(倖存者偏誤)**。
   對 ADL 的**方向**影響小(每天用同一批股票),但**絕對水位不能拿去跟證交所官方歷史家數對比**。

### 📚 外部參考資料的評估紀錄:「台股 AI 投資評價模型」(2026-08-03 使用者提供)
使用者上傳了一份 GitHub 專案(`taiwan-stock-ai-valuation`,純 Markdown、無程式碼,
需搭配 Claude Desktop Cowork + **手動填 5 項財務數字**,一次分析一檔)。
逐份讀完後的結論,**免得日後有人再問一次或重做一遍**:

**⛔ 不能照抄的部分(跟本專案鐵律衝突)**
- 它讓 **AI 自己算分、自己搜尋數字** → 直接違反「禁 AI 算數」鐵律,而且會幻覺。
- 它要**手動輸入**;本專案是 2,700 檔全自動採礦,不可能人工填。
- Capex/折舊、FCF margin、研發費用率、法說會態度、庫藏股、良率、產能利用率、
  地緣政治風險、Revenue breakdown —— **全都沒有資料源**(它是靠 AI 網路搜尋填的)。
  沒有結構化來源就做,等於做假數字。⛔ 別為了「補齊模組」去接這些。
- 「歷史 P/E 價格帶」:我只有**當前** PE、沒有歷史 EPS → 用現在的 EPS 回推歷史 PE,
  算出來只是把價格區間換個名字(等於位階溫度計),**是假的河流圖**,不要做。

**✅ 已經有了(比它更好:全自動、純公式、全市場)**
同業相對 PE(V71.4.5)、全市場 P/B 分位數(V16.2/V71.6.2)、景氣循環股標記
(`is_cyclical`)、毛利率趨勢、月營收 YoY、PEG、殖利率/填息、外資投信籌碼。

**⭐ 真正值得吸收的一個觀念:同一條門檻不能量所有產業**
它的半導體次產業門檻表(晶圓代工毛利 >45% 才算優、**封測 >22% 就算優**、
IC 設計負債比要 <25%)點出本專案的真缺口:X 光機用**同一組絕對門檻**量所有股票 →
日月光(封測,毛利 ~20%)會被判「差」,但那在封測業是正常水準。
⚠️ 但它的表**不能直接抄**:① 我沒有次產業分類(`industry_map.json` 只有 TWSE 33 大類,
半導體全擠在代碼 24)② 我沒有營益率/淨利率/ROE/負債比的**數值**。
→ **正解是用它自己也承認的那條後路**:「資料不足就改用相對位置」——
   算「該股在**同產業內**的百分位」,不寫死門檻,自動適應各產業結構。
   (這也跟 V71.1.6 外資期貨、V71.8.1 波動率同一個原則。)
- **已做第一步(V71.8.5)**:`fetch_finmind_fundamentals` 本來就算出了三率數值,
  卻只存趨勢箭頭字串、把數字丟掉 → 現在一併存 `gross_margin_pct` /
  `op_margin_pct` / `net_margin_pct`(零額外 API)。測試 `scripts/test_margin_pct.py`。
- **下一步(等數值累積後再做)**:比照 `industry_pe.json` 產一份「各產業三率百分位」,
  X 光機改用「同業百分位」判優/良/差。⛔ 別回頭去寫死那張半導體門檻表。
- ROE / 負債比要另外接 FinMind `TaiwanStockBalanceSheet`,尚未評估,別假設現成。

**✅ 另一個小收穫:用詞限制**
它明訂估值區間「僅能稱**歷史估值價格對照區間**,不得使用『進場點』『建議買點』」——
跟本專案 V71.8.2「指數刻意不給買賣價位」同一個道理,可套用到任何「估值≠時機」的卡。

### 📚 外部參考資料的評估紀錄②:「stock-analysis-team」多代理分析包(2026-08-03)
使用者上傳第二份參考(Coze/Claude Skill,對象是 **A股+美股**,不是台股)。
內容 = 8 個 AI agent 提示詞(基本面/情緒/新聞/技術分析師 → 多空辯論 → 交易員 → 風控一票否決)
+ yfinance/`ta` 抓 MA/MACD/RSI/BB 的腳本 + matplotlib 圖表 + HTML 報告產生器。

**⛔ 核心做法跟本專案衝突**:所有判斷都由 AI 產生(違反「禁 AI 算數」);它是**一次一檔的
報告產生器**,本專案是 2,700 檔的即時終端機;訊號用北向資金/上證指數(台股沒有)。

**✅ 它算的東西我幾乎都有,而且更好(全自動、純公式、全市場)**
- MA5/10/20/60 多頭排列、MACD/RSI/布林、支撐壓力 → 早就有
- 「A股三段式:進攻/均衡/防守 + 建議倉位%」→ 我的 `_chuPositionAdvice()`
  (年線/月線/季線 + 風險指數)已是同一件事,而且接在頂部跑馬燈
- 「風險評分 1-10」→ 我的 `_calcRiskScore()` 0-100,而且吃真實 VIX/外資期貨/日圓/派發日
- 「風控一票否決」→ 我的 regime 已經是「風控優先:跌破月線一律先降級」
- Sharpe/最大回撤/盈虧比 → `backtest.py` 早就有,而且是**扣手續費後**的淨報酬

**⚠️ 它的回測指南其實比本專案已知的還弱**(⛔ 別照它做):
完全沒提 ① 交易成本(ORB 探針的教訓:毛利正、扣成本後全虧)② 乾淨對照組
(sector_flow 的教訓)③ 扣掉同期個股漲跌(broker_habit 的教訓:不扣會得到相反結論)
④ 倖存者偏誤。這四點本專案都已寫成鐵則。

**⭐ 唯一真缺口(已補,V71.8.6):「幾次才算數」**
我原本只寫「樣本少、勝率別當真」,但沒回答**多少次才夠**。
→ `_winRateP(wins, n)` 二項式尾機率 + `_winRateConfidence()` 白話結論:
   假設沒有優勢(勝率 50%),純靠運氣出現這種成績的機率 p。
   p≤5% ✅ 站得住腳 / p≤25% ⚠️ 參考就好 / 其餘 ⛔ 跟丟銅板差不多;n<10 一律「還不能當結論」。
   實例:12 次 67% → p=19%(弱);40 次 68% → p=1.9%(有意義);50 次 52% → p=44%(等於銅板)。
   ⭐ 通用:**任何顯示「勝率 X% ・N 次」的地方都該配這個** —— 同樣 67%,12 次和 40 次
   的可信度差很多。⚠️ 它只檢定「跟丟銅板有沒有差」,不代表未來延續,也未扣交易成本。
   測試 `scripts/test_winrate.mjs`(用課本值釘住:P(≥8/10)=56/1024、P(≥10/10)=1/1024)。

### ⏳ 已採到但「還沒接前端」的資料(刻意的,等實測再接)
(目前無 —— `^TWII.json` 的 `amount` 已於 V71.6.5 接上,見下方說明)

### 💰 「成交金額」有兩個,名字必須不同(V71.6.5,使用者鐵則「邏輯不打架」的實例)
| 名稱 | 是什麼 | 在哪 |
|------|--------|------|
| **集中市場成交值(證交所官方)** | **只含上市**,電視/券商講「量能站回一兆」指的就是這個 | `^TWII.json` 的 `amount`(元),FMTQIK 併入 |
| 全市場成交金額(上市+上櫃,自行加總) | Σ(收盤×成交量),含上櫃 → **系統性偏高** | `breadth.json` 的 `amt`(億) |

實測對照(兆):07/29 官方 1.149 / 自算 1.191;07/30 官方 1.133 / 自算 1.151。
**兩個不是誰算錯,是不同的東西** → `_amtState()` 以官方為主、自算為備援,
並**回傳 `label` 讓呼叫端顯示**,⛔ 呼叫端不准自己寫死名字(寫死就會出現
「官方的數字配全市場的名字」這種打架)。測試:`test_amtsrc.mjs`。

**目前還在「只能等」的清單**(想加新功能時先查這裡,能回算就回算):
| 項目 | 能不能回算 | 說明 |
|------|-----------|------|
| 市場廣度 / ADL | ✅ 已回算(V71.5.5) | 303 個交易日 |
| 外資**月累計**買賣超 | ✅ 直接向官方要(V71.6.1) | ⛔ **不是回算**,是 TWSE BFI82U **月報**一次給累計值。⚠️ **千萬別自己加總 `risk_history.json` 的每日 `fi_spot_net`** —— 那是「每天採礦時的快照」,上游當天沒更新就沿用前值(實測 07/09·07/10·07/13 都是 −472.53、07/29·07/30 都是 −222.52)→ 加總會重複計算、嚴重灌水。同理:**任何「每日快照檔」都不可拿來做時間軸加總**,只能拿來看趨勢方向 |
| 券商分點勝率榜 | ❌ 不能 | `data/chips/` 只有滾動 20 日快照,沒有逐日歷史;免費分點史被付費牆擋 |
| 板塊「偷布局」回測 | ⚠️ 只能到 2026/05 | `foreign_net` 欄位才從那時開始存 |
| 韓股 vs 日經 誰對台股更有預測力 | ❌ 不能 | V71.1.9 起才開始存,要等幾個月 |
| **券資比 / 軋空**(V71.9.2 實測後**決定不做**) | ⚠️ 只能到 2026/05 | `margin_balance`/`short_balance` **只回溯到 2026/05/14**(約 55 個交易日),而那段大盤是**跌**的 —— 空頭段裡「空單多」本來就是對的,軋空要多頭段才會發生。實測 1,002 檔、9,893 事件:券資比**自身前 10%** 的 10 日 −3.07%,比自身最低 25% 的 −1.41% 還差(−1.65pp),**方向跟軋空相反**。⭐ 關鍵拆解:「外資買」在券資比不高時 −0.86%、券資比高時 −2.81% → 券資比額外貢獻 **−1.95pp**,真正有用的是外資方向。⛔ **不為券資比開功能**;⚠️ 也⛔不可據此說「軋空是假的」——正確說法是「目前唯一有的窗口裡不成立」。融資券滿 1 年且涵蓋一段多頭後重跑 `short_probe.py` 再決定 |

---

## 🩺 全盤資料體檢:怎麼讓 Claude 一次查完(而不是一輪一輪才找到)

⭐ 使用者 2026-07-30 問:「為何我請你檢查整份資料,你還是多次才找到錯?我要怎麼下指令?」

**下指令方式:直接說「跑資料體檢」** → Claude 執行 `python3 scripts/data_audit.py` 並逐項回報。

這支查五類(對象是 **gh-pages**,也就是手機真正讀到的那份,用 git 讀不打網路):
| 類 | 查什麼 | 抓到過的實例 |
|----|--------|-------------|
| A | 前端 fetch 的每個 `data/*.json`:存在 / 可解析 / **內容非空** | `day_trade.json` payload 是 `{}` → 多空計分卡當沖比空一個多月 |
| B | 新鮮度(更新時間 vs 該檔預期節奏) | `stock_news.json` 過期 66 小時 |
| C | 任何 `*_error` 欄位有值 | `tw_vix_error='no-token'` → 追出 workflow 漏給金鑰 |
| D | **前後端對接**:前端讀的欄名,後端到底有沒有產 | 前端讀 `taiex_bubble_msg`/`taiex_ma240_bias`,`macro_risk.json` 裡沒有 |
| E | **連動一致性**:同一指標在多個檔的值要一致 | 費半/道瓊/VIX/台積ADR 在 `macro_risk` 與 `macro_cache` 不一致 |

### 🆕 V72.1.2 補強:C 類新增「**值與 error 自相矛盾**」偵測
原本 C 類只會分別報「這個 `*_error` 有值」,**看不出值本身還在** ——
所以 `taifex_backwardation = -156.0` 配「不計價差」那次它**漏報了**。
⛔ 這一類比「那格空著」危險得多:使用者會拿一個不該信的數字去做決定。

⚠️ **但首跑立刻誤報 3 個**(`es_fut`/`ym_fut`/`nq_fut`)—— 它們的 error 講的是
「不給**漲跌%**」,**價位本身可信**(V72.0.5 刻意的),不算矛盾。
→ 判別要排除「針對衍生欄位」與「有交代的降級」:
`不給漲跌 / 不給方向 / 方向待確認 / 內插 / fallback / 已保留 / 沿用 / 備援`。
⭐ 這正好又示範一次「**工具報的要人工驗證,約 1/3 是誤報**」——
   而且是**我自己剛寫的工具**立刻犯的。

⚠️ 同版另加 `SUPERSEDED` 清單(如 `day_trade.json` 已被 `daytrade.json` 取代)——
**誤報留著會讓人養成忽略體檢輸出的習慣,真的壞掉那條就被淹掉了**。
實測:報告從「1 錯 + 5 誤報」收斂成**只剩 1 個真問題**。

### ⚠️ 這支抓不到什麼(誠實說明,不要以為跑過就沒事)
**它抓不到「單一數字本身是錯的」** —— 檔案內部自洽時它看不出來。
例如台指期 41,613:檔案裡日期、價格、價差全都自洽,只有拿**外部來源**比才知道錯。

→ **最有效的做法還是使用者給外部對照**(籌碼K線 / 券商 App 截圖)。
   2026-07-30 那次就是靠截圖才抓出「美股期貨方向相反」「亞股慢一天」「台指期差 1,968 點」,
   這三個都不是體檢工具能發現的。**請繼續給截圖,那是最高價值的輸入。**

### 📋 體檢已知缺口(2026-07-30 首跑 → **同日逐條查證完畢**,結論如下)
⚠️ 首跑時我把五條都寫成「缺口待修」是**錯的** —— 逐條讀原始碼後,**其中兩條是刻意的決定**,
照著「修」會把已經下架的東西又接回來。這正是 CLAUDE.md「代理找到的要人工驗證真偽」那條鐵則。

| 檔案 | 真相(已查證) | 處置 |
|------|-------------|------|
| `market_stats.json` | ✅ **真 bug,已修(V71.6.2)**。不是「TWSE 抓不到 P/B」—— `fetch_twse_fundamentals` 明明有解析「股價淨值比」欄,是 `miner.py` 組 `fund_cache` 時**只挑 pe / yield_rate,把 pbr 丟掉**(`miner.py:2996`)→ `compute_market_pb_percentiles` 讀到的樣本恆為 0 → 恆回 `{}` → 檔案**從上線到現在一次都沒寫過**。實證:gh-pages 的 `fundamentals_cache.json` 876 檔,pe 833 / yield_rate 833、**pb+pbr 合計 0 檔** | 補上 `pbr`;並讓「樣本不足」改印**實際數字**(掃幾檔/有欄幾檔/合理區間幾檔)—— 舊訊息只寫「< 50」,所以「恆為 0」跟「今天只有 40」長得一模一樣,這才是它躲過診斷這麼久的原因 |
| `chief_ai_cache.json` | ⛔ **不是缺口,是刻意刪的**。`chief_ai_batch.py` 2026-06 已退役,`daily_miner.yml:495` 每次部署都 `rm -f data/chief_ai_cache.json`。前端 `V16.7` 已有 stale 判定(>2 天視同無 cache)並自動 fallback `radar_matrix` | **不要補到 gh-pages**。補了只會讓前端拿到過期檔再自己丟掉,白繞一圈 |
| `biz_profile.json` | ⛔ **不是缺口,是刻意停用的**。`theme_news.py::main()` 裡 `ok_b = False` 是寫死的,註解說明 run#3 已把 TWSE/TPEX「公司基本資料」全部欄位印出來確認過 —— **官方 API 根本沒有業務說明文字欄**(只有產業別/統編)。函式與防呆都保留,等找到穩定來源再打開 | **不要「修」**。要做就是先找到真的有業務說明的來源,不是改程式 |
| `live_quotes.json` | ⏳ 盤中才產,收盤後不在 gh-pages 是正常的 | 需**盤中**再驗一次才能判定,別在收盤後下結論 |
| `day_trade.json` | ➖ payload `{}`、6/27 起沒更新,但已無影響 | **V71.5.4 已改讀 `daytrade.json`**,舊檔留備援 |

**通用教訓(寫下來免得再犯)**:`data_audit.py` 報「這個檔沒上 gh-pages」時,
**先去 grep 那個檔是不是被刻意刪除/停用的**(搜 `rm -f`、搜 `= False`、搜「退役」「停用」「暫停」),
再決定是補還是不補。工具只知道「檔案不在」,不知道「本來就不該在」。

---

## 🔗 連動更新檢查清單(V27.6 後新增,使用者要求:改/加資料要判斷連動)
**改一個資料/欄位時,必連帶檢查的觸點**(避免「改一處、別處沒跟上」,如 `published_time`/`us_macro` 對接斷掉的 bug):

| 改動 | 必連帶檢查 |
|------|-----------|
| **macro_risk.json 新增/改欄位**(macro_miner.py) | ① 前端讀取卡(grep 欄名)② 首席 AI prompt 注入(`runUnifiedGroqAnalysis`)③ `_calcRiskScore` 風險指數 ④ `risk_history.json` 快照欄位 ⑤ 前端欄名跟後端**完全一致** |
| **後端改/加欄位名** | 前端 fallback 鏈要含新欄名(別只讀舊名);grep 雙向確認前後端同名(記取 `us_macro` 不存在、`published_time` 前端沒讀的 bug) |
| **新增 data/*.json 檔** | ① daily_miner deploy 底層 `git archive origin/data` 會保留(append 類檔靠這保命,如 risk_history)② 前端 fetch 用動態 `ghBase` + `?t=${Date.now()}` ③ 確認 daily_miner.yml push paths 是否需納入觸發 |
| **新計分因子**(獵鷹/主力出貨/多空) | ① 卡片「因子來源」說明文字同步 ② 首席 AI 若注入該訊號要更新 ③ 數值單位確認(億/張/口/%,記取 `fi_spot_net`=億) |
| **改燈號/verdict 文案** | 同一決策的多張卡(首席/綜合評分/系統燈號)語義要一致,別紅綠相反(V27.5 已統一改「寫字不靠色」) |
| **加新偵測器/型態**(朱家泓/林穎 K 棒) | 加進 `renderKbarTactics`(唯一活的一處;舊「三處清單」的 `renderKbarScore`/`runKlineAudit` 死碼已於 V69.8.8 P2-4 清除) |
| **新增任何「賺/賠多少元」的顯示** | ⛔ 一律走 `app._netPL(buy, sell, shares)`(V71.7.8)+ `app._feeDisc()` —— 淨損益公式全 App 只有一份(已扣買賣手續費 0.1425%×使用者折數 + 賣出證交稅 0.3%)。⛔ 別再 inline 寫一份(V71.7.8 前「今天這檔怎麼做」卡就有一份複製品),折數規則一改就會有兩個版本的金額 |
| **新增任何「上檔目標/壓力價位」** | ⛔ 一律加進 `app._upsideRoom(pC, data, last)` 的來源清單,由它統一排序 + 算 %/元/風報比;顯示端讀 `_upsideStash`,⛔ 不自己再算一份。⭐ **來源要含「量」不能只有「價」**(V71.8.7):前高只是一個價位,`_overheadSupply()` 的**套牢區**是「一整片有量的區間」,對「彈上去會不會被壓下來」解釋力更強。⚠️ `_upsideRoom` 必須在顯示端**之前**跑,且 stash 有比對現價防跨股殘留。測試 `scripts/test_upside.mjs` / `test_overhead.mjs` |
| **新增 setCell 純公式卡**(取代 AI) | ① 指標暫存 `this._xrayMetrics` 逐項寫入 ② 末端統一產結論(如 `_renderXrayVerdict`)③ **資料充足度守門**:缺關鍵維度顯「整備中」別硬判 ④ 切股競態守門 `currentSymbolId!==sym` return |
| **夜間 fund_sweep 改欄位**(fund_yoy_gm.json) | ① 前端 `_loadFundYoyGm()` fallback 讀取欄名一致 ② X 光機 YoY/毛利 fallback 鏈 ③ fund_sweep.py 輸出欄名跟前端**完全一致** ④ 獨立檔靠 daily_miner `git archive origin/data` 保留,勿併回 fundamentals_cache.json(會被下午重建洗掉) |

**鐵則(⭐ 使用者明示:更新新功能時,相關的東西也要一併更新邏輯)**:
- 任何「後端產資料 → 前端讀」的改動,push 前 `grep` 雙向對欄名;新資料源先確認 daily_miner 觸發路徑 + deploy 保留機制。
- **加功能 = 順藤摸瓜**:改 A 前先想「A 連到哪些 B/C/D」(說明文字、AI prompt、評分、快取、fallback 鏈、其他共用同 DOM ID 的卡),一次補齊,別只改單點留下對接斷掉的 bug。

---

## 🎨 UI/UX 設計規範(V25.8 後新增,Senior UI/UX 規範)

### Design Tokens(嚴格限色)
| 用途 | Tailwind class |
|------|---------------|
| 漲 / 警示 | `text-red-400` `text-red-300` |
| 跌 / 健康 | `text-green-400` `text-green-300` |
| 極度危險 | `text-orange-400` (+ animate-pulse) |
| 警戒 | `text-yellow-400` |
| 主文字 | `text-gray-100` |
| 次要 | `text-gray-400` |
| 備註 | `text-gray-600` |

**背景**:
| 用途 | class |
|------|-------|
| 主背景 | `bg-[#0d1117]` |
| 卡片 | `bg-[#161b22]` |
| 次要 chip | `bg-white/5` 或 `bg-[#21262d]` |
| 預設邊框 | `border-[#30363d]` |
| 漲(警示)背景 | `bg-red-900/30` |
| 跌(健康)背景 | `bg-green-900/30` |
| 極危背景 | `bg-orange-900/30` |

⛔ **禁用霓虹漸層** — `bg-purple-*/40` / `bg-cyan-*/40` / `bg-pink-*/40` 等高飽和漸層(只在 verdict 大字 hero 用,不在普通卡)

### Emoji 規則(V25.8 使用者明示:保留)
- ✅ **保留所有 emoji**(使用者明確要求:無 emoji 不知怎麼操作)
- 漲跌幅旁的 🔺🔻 / verdict 開頭的 🟢🟡🔴 / 警報的 🚨 / 標題的 📊📐💰🚀⚠️📌🧩🎯💡 全保留
- 不必改 Lucide / SVG icon(那是過度設計)

### 卡片三段式樣板(Equal Height)
```html
<div class="bg-[#161b22] border border-[#30363d] rounded-lg p-3 flex flex-col h-32">
  <!-- 頂:指標名 + emoji icon -->
  <div class="flex items-center justify-between text-[10px] text-gray-400 mb-1">
    <span>📊 VIX 恐慌</span>
    <span class="text-gray-600 text-[9px]">⏱️ 14:32</span>
  </div>
  <!-- 中:大數值(用 flex-1 + items-end 推到底) -->
  <div class="text-2xl font-black font-mono text-gray-100 flex-1 flex items-end">15.3</div>
  <!-- 底:短評(truncate 避免溢出) -->
  <div class="text-[10px] text-gray-600 truncate">市場平穩 多頭健康</div>
</div>
```

### Alert Box 樣板(取代「整句彩色化長文」)
```html
<div class="bg-[#161b22] border-l-4 border-red-500 pl-3 py-2 rounded-r">
  <div class="text-[10px] text-red-400 font-bold mb-1">⚠️ 戰術遵照</div>
  <div class="text-[11px] text-gray-200 leading-relaxed">純文字段落 行高 1.6 不再整句紅綠黃</div>
</div>
```

### 排版層級鐵則
- 長文字段落:`leading-relaxed` (line-height 1.625) 或 `leading-loose` (1.75)
- 短卡內容:`leading-tight` (1.25) — 例如卡片 title/sub
- **絕不**對整句段落上色,只用 emoji 開頭 + 標籤 chip + Alert Box border-left 標示
- 對齊:卡片內標題列 `flex items-center justify-between`,數值列 `font-mono` 等寬

### sub-tab Sticky 規則(V25.9+ 推進)
- 全球大環境 / 台股實戰 sub-tab 需 `sticky top-0 z-30` 固定頂部
- 切換不再 layout shift
- background 配 `bg-[#0d1117]/95 backdrop-blur` 維持半透

---

## 🚨 處置股系統(⚠️ V70.3.1 已大幅下架,以下為**現況**,別照 V20.x 舊敘述重建)

**現在還活著的只有兩塊(都是「官方名單有才顯」,零推估)**:
1. **現價旁官方 badge** — ⚠️ 注意股 / 🚨 處置 N 分盤・N 天後出關(來源 `attention_status.json`)
2. **`#attentionDetailCard` 官方處置/注意明細卡** — 在**個股頁「總覽」最上方**,只有官方名單有這檔才顯(render 在 `index.html` 約 L15500)

**已下架(V70.3.1,使用者要求;因為第 8 款權證溢價無資料源、8 款推估撐不起來)**:
- 個股頁的「🚨 處置」sub-tab **整個移除**(所以個股頁現在只有 8 個 sub-tab:總覽/即時/當沖/K線/籌碼/基本/回測/多空)
- 連帶下架:8 款推估、雙刀流、越關越大尾、處置 AI、💀 必關股 badge
- ⚠️ **這些 render 函式還留在 JS 裡但永遠 no-op**(entry 就 `getElementById` 一個不存在的 id 然後 return):
  `renderAttentionScanCard` / `renderDispHeadline` / `_renderAttentionScanInner` / `_prependOfficialDisp` /
  `renderDoubleSword` 等。**看到它們別以為功能是壞的 —— 是刻意下架的死碼**,要動之前先問使用者。
- 選股頁的「處置股」榜(`radarAttentionView`,全市場官方名單)**仍在**,跟上面的個股卡是兩回事。

### 8 款 TWSE 規則閾值(V20.4 版 —— ⚠️ 已下架,僅留作日後若要重建的規格參考)
| # | 規則 | 資料源 | 閾值 |
|---|------|--------|------|
| 1 | 漲跌幅累積過大 | K 線 | 5/10/20 日 **32%/40%/60%** |
| 2 | 長期漲跌異常 | K 線 | 30/60/90 日 50%/70%/90% |
| 3 | 成交量明顯放大 | K 線 | 5×/3× 60 日均量 |
| 4 | 漲跌+量綜合 | K 線 | 單日 **±7%** 且 **5×** 量 |
| 5 | 券商分點集中度 | `data/chips/{sym}.json` | 前 10 家佔 ≥ 80% |
| 6 | PE 異常 | `_fundCache.pe` | >30 偏高 / >50 觸發 / >100 嚴重 |
| 7 | 融資餘額異常 | `rawDailyData.margin_balance` | 近 5 日 ±25% |
| 8 | 權證溢價率 | 無資料源 | 待採礦補(無公開 API) |

### 個股代號 badge(V20.3;⚠️ 第 3 顆已於 V70.3.1 下架)
- ⚠️ **注意股**(from `attention_status`)← 仍在
- 🚨 **處置 N 分盤 ・ N 天後出關**(from `attention_status.interval/end_date`)← 仍在
- ~~💀 必關股(from `_calcAttentionScan` 預測)~~ ← 已下架(推估性質,資料撐不起)

### 處置門檻(TWSE 4 條任一觸發 → 處置)
1. 連 3 日觸第 1 款 = 注意股 → 連 5 日 = 處置
2. 10 日內 6 天觸 1~8 款 = 處置
3. 30 日內 12 天觸 1~8 款 = 處置

### 越關越大尾 vs 越關越死
- ✅ 越大尾:量縮主力洗完 + 法人未撤 + 基本面健康 + 站穩 20MA + 大盤無黑
- ❌ 越關死:法人撤 + 技術破月線 + PE 嚴重高估 + 大盤黑天鵝

---

## 📋 2026-06 重大功能盤點(V18.5 ~ V20.7)

| 模組 | 版本 | 內容 |
|------|------|------|
| AI 鏈 Gemini 為主 | V18.5 / V18.7 / V19.3 | 全改 Gemini + safetySettings + thinkingBudget=0 + systemInstruction |
| 庫存表 | V18.7 / V19.1 / V19.2 | 7 欄重排(庫存股/今損益/股價漲跌/總損益/股數/均成本/市值佔比) + 漲跌停現價底色 + 雙擊刪除 |
| 置頂 UI | V18.9 / V19.0 / V19.1 | logo + 🔍 全螢幕搜尋 modal + 🔔 提醒鈴鐺 + SVG line icon + safe-area |
| 鈴鐺歷史通知 | V19.4 | priceAlertModal 加第 3 tab,3 天自動清,點任一筆跳該股 |
| 離場 SOP | V19.7 | 分區 + **每條損益試算** + 永豐 App 操作步驟濃縮 |
| 板塊輪動對標 | V19.6 / V19.7 | 10 板塊對應美股 ETF,改可摺疊速查表(避免擠) |
| ETF 跟車狀態 | V18.6 / V19.6 | 個股頁卡 + 修切股 reactive bug |
| 朱家泓策略 | V18.8 | 5MA/20MA/-5% 三條件即時 PWA 推播 |
| **🚨 處置股系統** | **V20.0-V20.7** | 上方完整 6 卡 + 每日推播 + 獨立 sub-tab |

---

## 常見問題與已知解法

| 問題 | 原因 | 解法 |
|------|------|------|
| gh-pages 部署失敗 exit 128 | 首次執行 broker_names.json 不存在 | git add 前先判斷檔案存在 |
| 三大法人空白 | FinMind status=None 不 fallback | fm_get 改為任何非200都 fallback |
| 外資期貨/美股無資料 | URL 硬編碼小寫路徑 | 改用動態 ghBase |
| 主力顯示 ABC 而非券商名 | 資料已最新跳過→T86未呼叫 | 跳過時仍呼叫 _refresh_broker_names |
| broker_names.json 不存在 | T86 被雲端 sandbox 阻擋 | GitHub Actions 環境可存取 TWSE |
| **庫存頁空白(只剩表頭)** | V18.7 row template 內 `const totalCostNTD` 跟 outer `let` 同 block 重複 → ReferenceError | 刪 inner const,用 row 內 totalCost |
| **ETF 跟車卡顯舊股資料** | render 在 `activeData` 更新前 trigger(V19.6) | render call 移到 `this.activeData = ...` 之後 |
| **ETF 跟車燈號全紅** | K 線日期 `2026/06/19` vs etf_tracking `2026-06-19`,字串比對 `/(47) > -(45)` 全 skip | normalize 日期(/ → -)+ max-search 不依賴 array 順序 |
| **搜尋 modal header 看不到** | modal z=100 vs header z=150 | modal z 改 999 |
| **庫存編輯 🗑️ 無反應** | `showConfirm` z=300 vs editor z=9999,confirm 被蓋住 | 改「雙擊確認」(2 秒紅閃)避開 z-index 衝突 |
| **Gemini 輸出字數爆短** | safetySettings false-positive 攔截 + 2.5 Thinking 吃預算 | safetySettings 4 大類全 BLOCK_NONE + thinkingBudget=0 + systemInstruction |
| **注意股掃描太寬鬆**(專業 App 1/5、我 3/5) | V20.0 閾值「漲停就 +1」太鬆 | V20.4 改 32% / 40% / 60%,單日門檻 7% 且須 5× 量 |

---

## 🎯 V26.x 階段學到的新規(2026-06-26 連推 V26.1~V26.19)

### 個股頁 5 卡架構(每張卡 onclick / ID 一旦動就會壞)
| 卡片 ID | 渲染函式 | 行號 | 角色 |
|---------|---------|------|------|
| `#costPnlBar` | (在 refreshStrategy 內) | L15206 | 倉位狀態小卡 4 格 grid + 大字現價(V26.6) |
| `#masterScoreCard` | `renderMasterScoreCard` | L7891 | 綜合操作評分 Progress Row Grid(V26.15) |
| `#instReverseCard` | `renderInstReverseCard` | L7791 | 法人反轉 + 投信做帳 Alert Box(V26.16) |
| `#chuStrategyCard` | `renderChuStrategyCard` | L3892 | 朱老師策略 Empty State + CTA(V26.17) |
| `#chipBrokerTable` | `dispBrokerTable` fallback | L9784 | 分點明細 + 維護中 Alert Box(V26.18) |

### UI 樣板鐵則(必引用,別重新設計)

**1. Equal Height Card 三段式**(V25.8)— 全球巨頭 10 卡

**2. Alert Box 樣板**(V26.1+)— 警告 / 維護中 / 失敗訊息:
```html
<div class="bg-[#161b22] border-l-4 border-{color}-500 border-y border-r border-[#30363d] rounded-r p-3">
  <div class="text-[11px] font-bold text-{color}-300 mb-1">⚠️ 標題</div>
  <div class="text-[10px] text-gray-300 leading-relaxed">純文字段落不再彩色化</div>
</div>
```

**3. 倉位狀態 4 格 grid**(V26.6)— `#costPnlBar`:
header 大字現價 + 2x2 grid(成本/帳損%/5MA/損益元),硬停損 Alert Box 條件顯示

**4. Vertical Stepper**(V26.9)— SOP 步驟條(永豐 App 下單 / 設定教學):
```html
<div class="flex gap-2.5">
  <div class="flex flex-col items-center flex-shrink-0">
    <div class="w-5 h-5 rounded-full bg-{color}-600 text-white text-[10px] font-black flex items-center justify-center">${n}</div>
    <div class="w-0.5 flex-1 bg-[#30363d] my-1"></div>   <!-- 最後一步省略 -->
  </div>
  <div class="flex-1 pb-2.5">
    <div class="text-[11px] font-bold text-{color}-300">${title}</div>
    <div class="text-[10px] text-gray-400 mt-0.5 leading-snug">${detail}</div>
  </div>
</div>
```

**5. Progress Row Grid**(V26.15)— 因子明細 / 評分列表:
```html
<div class="grid grid-cols-[1fr_auto_44px] gap-2 items-center py-1.5 border-b border-[#21262d]">
  <div>
    <div class="text-[11px] text-gray-200 font-bold flex items-center gap-1"><span>${icon}</span>${name}</div>
    <div class="text-[9px] text-gray-500 font-mono">權重 ${weight}%</div>
  </div>
  <div class="flex flex-col items-end gap-0.5">
    <span class="text-[9px] text-gray-400 truncate max-w-[120px]">${evalTxt}</span>
    <div class="w-[100px] h-1 bg-[#21262d] rounded-full overflow-hidden"><div class="h-full ${barColor}" style="width:${score}%"></div></div>
  </div>
  <div class="font-mono font-black text-right text-base ${scoreColor}">${score}</div>
</div>
```

**6. Empty State + CTA**(V26.17)— 未填資料的卡片(別顯紅警誤導):
```html
<div class="flex flex-col items-center justify-center py-6 px-3">
  <div class="text-5xl text-gray-700 mb-2">📦</div>
  <div class="text-sm text-gray-300 font-bold mb-1">尚未建立此 ${entity}</div>
  <div class="text-[10px] text-gray-500 mb-4 text-center leading-relaxed">${guideText}</div>
  <button onclick="${action}" class="px-5 py-2.5 bg-{color}-600 hover:bg-{color}-500 text-white text-xs font-black rounded-lg shadow-md">＋ ${ctaText}</button>
</div>
```

### 錯誤訊息白話化鐵則(V26.18 後)

⛔ **禁在 UI 文案暴露技術術語**(showJargon / title tooltip / fallback HTML 都算 UI):
- `GitHub Actions` / `Google Cloud` / `AWS` / `Azure` / `IP 封鎖` / `sandbox` / `runner` / `cron syntax` / `TWSE BSR 系統封鎖`
- 後端 API 名稱:`FinMind` / `Fugle` / `yfinance` 等實作細節
- 內部變數 / 函式名:`activeData` / `_macroRiskCache` / `_falconScores` 等

✅ **改用白話**:
- 「⚠️ XXX 維護中,已自動切換至 T+1 備份備援」
- 「✅ 已自動切換到替代方案」
- 「請至 [合理連結] 手動查」
- 「資料抓取中,稍後再點」

🟢 **例外**:使用者主動點「故障排查」「Telegram 推播診斷」等 power user 工具,可保留技術細節(他真要 debug 才看)

### AI 資料就緒檢查模式(V26.12/V26.13)

**鐵則**:禁 AI 在資料不全時硬判讀,避免 AI 看 null 給「健康」錯誤結論。

**工具函式**(L8480 附近):
```js
_checkMacroReady() {
    const macro = this._macroRiskCache || {};
    const hasSectors = !!(macro.sector_etfs && Object.keys(macro.sector_etfs).length >= 5);
    const missing = [];
    if (!hasSectors) missing.push('9 板塊 ETF 對標資料');
    return { ready: missing.length === 0, missing };
},
_dataNotReadyHtml(missing) { /* Alert Box 樣板,黃色警示 */ }
```

**4 個函式 entry 必加 ready check**:
- `analyzePredictCenter`(預判中心 4 段 AI)
- `analyzeMarketAnomaly`(大跌剖析)
- `analyzeSectorRotationAI`(板塊輪動 AI)
- `renderSectorGapTable`(9 板塊缺口表)

**個股 AI 不需 check**(進入個股頁就 fetch 個股資料):
- `runUnifiedGroqAnalysis` / `runKlineAudit` / `analyzeChipUnified` / `fetchFundamentalAnalysis`

**過嚴會錯殺**:V26.12 把 `us_macro.sp500/vix` 設 required 太嚴,V26.13 改成只看 `sector_etfs`(因為核心資料齊就能跑)。

### 整合卡規則(V26.14)

**重複功能必合併到一張整合卡**(避免兩個功能在不同卡分散)— V26.14「資金板塊輪動」+「9 板塊缺口表」合併示範。

**搬卡操作必驗 ID 唯一性**:
```bash
for id in sectorSource sectorIntradayBtn sectorAiBtn ...; do
  count=$(grep -c "id=\"$id\"" index.html)
  [ "$count" -ne 1 ] && echo "❌ $id 重複 $count 次"
done
```

**JS 函式不需改**:DOM ID 保留 + onclick handler 保留 → 渲染邏輯零改動

### 視覺降噪鐵則(V26.1 ~ V26.18 整套)

| 禁 | 改 | 範例 |
|----|-----|------|
| 霓虹漸層 `bg-gradient from-purple-*` | 純色 `bg-[#161b22]` + accent border | V26.2-V26.4 |
| 口語化驚嘆「!!」「啊」「對著做」 | 金融術語 + Alert Box | V26.16 |
| 長文字段落彩色化 | 純灰文字 leading-relaxed + emoji 開頭 | 全段 |
| 未填資料顯紅警誤導 | Empty State + CTA 引導行動 | V26.17 |
| 黃底 chip `bg-yellow-900/40 px-1 rounded` | 純淡黃文字 `text-yellow-300 font-bold` | V26.8 |
| 整段技術術語錯誤訊息 | 「⚠️ XXX 維護中,已切備援」 | V26.18 |

### 連推時 ID 重複防呆(V26.10/V26.11/V26.14 教訓)

搬卡 / 整合卡 / 複製貼上 HTML 後**必跑 ID 唯一性檢查**,否則 `document.getElementById` 只抓第 1 個,新位置 DOM 操作會壞。

---

## 📐 朱家泓 K棒戰法技術規格(V36.0/V36.1 — 純公式,鐵律「禁 AI 算數」)

**鐵則**:所有 K 棒型態/訊號一律 **JS 純公式判斷,嚴禁丟給 AI**(同「禁 AI 算均線」鐵律)。資料源 = `rawDailyData`(OHLCV),零採礦零 API。

### 二分之一價定義(兩種並存,別亂統一;⭐ V69.9.3 U-4 已改名,UI 不再出現「½價」)
- **「突破棒防守價」(V31.8 既有)**:爆量長紅 `(開+收)/2`,結構防守價(`#breakoutGuard`,refreshStrategy 內計算)
- **「當日平均成本」(V36.0 K棒戰法/長紅長黑三價位/今日盤勢解讀)**:`(最高+最低)/2` = 課程定義「當天平均成本」
- ⛔ 公式是刻意不同的,不要統一;UI 文案只准用上面兩個名字,別再寫「½價」造成同名不同值

### K棒戰法卡(`#kbarHalfTactics`,個股頁突破棒下方)
- 渲染:`renderKbarTactics(data)`(在 refreshStrategy 突破棒渲染後呼叫);有訊號才顯,無則 hidden
- **訊號(台股色:🔺紅=偏多 / 🔻綠=偏空 / ⚪中性)**:
  1. **止跌反彈**:大量長黑(實體跌幅≥5% + 量≥前5根均量×1.5)的 ½ 被現價突破 = 套牢賣壓消化(偏多)
  2. **假突破**:爆量長紅突破棒,隔 1-2 日黑K收破其 ½ → 多單跑(偏空);**假跌破** = 鏡像(偏多)
  3. **收盤轉強/弱**:今收 > 昨高 = 轉強 / < 昨低 = 轉弱
- **三根 K棒轉折**(`_detectStarPatterns(data)`,訊號置頂):
  - **夜星**(高檔轉下):左長紅 + 中間 1-3 變盤線(小實體 <1.8%)+ 右長黑收破左紅K中點;相對高檔(近20根高×0.94)
  - **晨星**(低檔轉上):左長黑 + 中變盤線 + 右長紅突破左黑K中點;相對低檔
  - 變體:**孤島**(兩側跳空,標最強)/ **群星**(≥2變盤線)/ **+爆量**;確認K須在最後 1-3 根內
  - 長K門檻:實體漲跌幅 ≥3%;變盤線:實體 <1.8%

### 朱家泓 5MA 推播(既有)
- chuStrategyCard / 離場 SOP:跌破 5MA 短線停利、跌破成本 -5% 鐵血停損;worker 每日 09:00 台北推

---

## 💾 V35.x 資料源學到的鐵律(2026-06-29 連推 V35.0~V36.1)

### FinMind 免費版限制(⚠️ 歷史脈絡：這是「免費版時代」的紀錄；使用者現已付費，分點 402 付費牆等限制多已不適用，見上方「⭐ FinMind 是付費版」鐵律)
- **「不帶 data_id 的全市場 bulk」抓營收/財報 = 回 0 筆**(`TaiwanStockMonthRevenue`/`FinancialStatements`);只有 institutional 可 bulk。實證靠 `fundamentals_cache.json` 的 `__status{yoy_raw,gm_raw,yoy_hits,gm_hits}` 自我診斷欄。
- **分點(`TaiwanStockTradingDailyReport`)= 付費牆擋(回 402)**;免費分點只剩證交所 BSR(破驗證碼),雲端跑極不穩(IP 被擋/驗證碼失敗),曾停更 6 週 + 解析汙染(券商名變數字)。前端 `_chipQuality()` 防呆:過期>10天/汙染→顯「維護中」不顯亂碼。
- **全市場營收 YoY/毛利**:改用「分點逐檔迴圈順便把觀察清單(~100)已算好的 `revenue_yoy`+`gross_margin_trend` 併入 `fundamentals_cache.json`」(免費,零額外 API);冷門股全市場 YoY/毛利 + 全市場分點 → 需 **FinMind Sponsor(~NT$999/月)** 或 chips job matrix 平行化。

### fundamentals_cache.json
- 結構:`{sym:{pe,yield_rate,rev_yoy?,gross_margin?}}` + `__status` 診斷鍵(前端按 sym 讀,`__` 開頭鍵 aggregate/radar 自動略過)
- **workflow 陷阱(已修)**:chips job 的 upload-artifact 清單**曾漏傳 `fundamentals_cache.json`** → deploy 用 `git archive origin/data` 鋪的舊檔從未被覆蓋。新增 data/*.json 必確認在 `.github/workflows/daily_miner.yml` 的 `chips-data` artifact `path:` 清單內。

### 法人目標價(V35.7)
- **改純公式**(取代壞掉的 AI 推估):目標價 = 年化EPS × 產業中位PE(`industry_pe.json`),區間 ±15%;配息股附殖利率法參考(年股利÷4.5%)。`fetchInstitutionTarget` 已移除 Gemini。

### X光基本面 fallback(V35.6)
- 非籌碼觀察清單股 + FinMind 即時失敗時,X光 PE/殖利率/YoY **fallback 讀全市場 `_loadFundCache()`**(免被「採礦更新中」卡成空白)。

### AI 引擎(V35.0/V35.1)
- 設定頁「🎛️ AI 引擎選擇」下拉(`set_aiEngine`):auto/gemini1/gemini2/groq/openrouter;`_forcedEngine()`+`_callForcedEngine()` 覆寫;「🩺 測試所有金鑰」= `testAllAiKeys()`。
- 預設 `aiPreferGroq`:深度分析也 Groq 優先(撞 429 才退 Gemini/OpenRouter)。
- 全球即時情報/即時情報與新聞解析 **已取消前端 AI**(標題吃採礦端翻好的);新聞時間 `_fmtNewsTime` 統一 Asia/Taipei 台灣格式。

### Key 放哪(架構)
- **前端 localStorage**(設定頁):Fugle/FinMind/Massive/AI — 你手機即時抓用
- **GitHub Secrets**(`FINMIND_TOKENS` 逗號分隔/`MASSIVE_API_KEY`/`GROQ_API_KEYS`):採礦機 bulk 資料用,GitHub IP 跑(天然 IP 分離,不害你家 IP 被擋)
- ⛔ key 絕不硬編進 index.html(gh-pages 公開=等於貼到網路)

---

## 🔎 V41.24~V41.26 — 免費查(Perplexity 深連結,零 API 額度)
- **痛點**:Gemini 自家 API 額度一下就爆。**解法**:不呼叫 API,改「帶股名+固定提示詞→`window.open` 外部免費 AI 網頁」,用它的額度。
- 核心 `_freeAiOpen(query)`(通用)+ `_openFreeAi/_openFreeAiStock/_openFreeAiMacro/_openFreeAiEtf/_openFreeAiNews`;引擎設定頁 `set_freeAiEngine`(存 `settings.freeAiEngine`):**Perplexity(預設,AI答案+來源)/ Google / ChatGPT**。⚠️ Gemini 網頁不支援 `?q=` 帶問題,故不列入。
- 佈點:基本頁「🔎 免費查公司」6 鈕、首席頁備援、盤前體檢宏觀事件、全球新聞每則「深入查」、處置股、板塊輪動、ETF。
- **分工鐵則**:質化問題(公司/新聞/產品/產業)走外部免費 AI;K線/籌碼/法人**數字**仍走 App 內自算卡(禁外部 AI 算數)。
- V41.25 移除耗額度的「產業趨勢報告 + 同業數據對比」卡(JS 保留但無 UI 觸發,切股 reset 已 null-guard)。

## 🐛 V41.27~V41.28 — Bug 大掃除(多代理審查+人工驗證,分批修)
**流程鐵則**:代理找 → **人工讀原始碼驗證真偽** → 只修確認的 → 四驗證 → 分 Batch commit。約 1/3 findings 是誤報或設計取捨,別照單全收。
- **Batch 1(前端邏輯)**:①`_lastInstSignal` 早退不重置→切股籌碼評分跨股污染 ②投信做帳 dupScore 比對字串錯→恆 50 失效 ③獵殺月線起漲用今日月線比舊K ④破底翻吃凍結 recentLow→永不觸發 ⑤radar.json 漏 `?t=` ⑥換手量負索引 ⑦回撤色綠→灰。
- **Batch 2(採礦 *.py)**:①FinMind 法人備援 name 是**英文列舉**(Foreign_Investor…)舊版只比中文→補 0 ②外資期貨讀不存在欄位→淨口數恆 0 ③macro「外資自營商」被外資+自營重複灌 ④fm_request 加 5xx 換 token ⑤法人日期改台北時區。
- **Batch 3(渲染/AI提示詞/快取)**:①**localStorage 壞任一 key→白畫面**(favGroups/monitorList/inventory/settings 的 JSON.parse 全包 try/catch)②此股預判 AI 外資漏 /1000→灌水千倍 ③`analyzeSectorRotationAI` 讀不存在 DOM `.sector-heat`→改讀 `sectorIntradayLastGood`+`_sectorHeatCache` ④`_aiCacheKey` 加引擎 ⑤切股競態守門(`currentSymbolId!==targetSym` return)⑥停籌碼/多空頁切股殘留→`_activeSubTab` 補跑 ⑦獵殺紅點 hidden class 蓋 style.display→改 classList.toggle。

## 📐 V41.29~V41.30 — 朱/林技術補完(6 個新偵測器,全純公式零採礦)
盤點朱家泓/林穎技術流,補齊漏掉的型態。**全照單一型態引擎**回 `{tone,title,val,msg}`。新增偵測器加進 `renderKbarTactics`(K棒戰法卡)即可 — 舊文件說的另兩處(`renderKbarScore`/`runKlineAudit`)已於 V69.8.8 死碼清除。
| 函式 | 內容 |
|------|------|
| `_detectMaKoudi` | 均線扣抵值:今收 vs 扣抵值(`data[last-(N-1)].close`)判月線/季線明日揚抑;補「扣低→翻揚(領先偏多)」+「跌破扣抵→提前1-2天轉弱」 |
| `_detectGap` | 缺口跳空+分類:向上/向下、是否回補、突破缺口(帶量)vs 竭盡缺口(高檔連漲後);朱「缺口不補繼續走」 |
| `_detectIndicatorDivergence` | KD/MACD 頂底背離:讀 `this.indicators.k/.dif`(worker 現成陣列,index 對齊 activeData);價創高但指標沒創高=頂背離 |
| `_detectGranville` | 葛蘭碧八大買賣點(月線 20MA):買1突破/買2假跌破/買3回測支撐 ・ 賣1跌破/賣2假突破/賣3反彈受阻(買4/賣4乖離已由 `_detectMaDeviation` 涵蓋) |
| `_detectTopBreakdown` | 頭部頸線跌破(M頭/頭肩頂/三重頂,對稱 `_detectBottomBreakout`)+ 等幅測跌目標價 |
| `_detectTrendline` | 趨勢線:兩上升低點連線跌破=轉弱 / 兩下降高點連線突破=轉強 |
- **已完整覆蓋**:½價/晨昏星/吞噬貫穿/假突破/測壓測撐/量價背離/回後買上漲/四大金剛/K棒強弱(林穎)/底部頸線/均線糾結/乖離/處置股。
- **~~刻意不做~~ → V61.x 已補(使用者要求覆蓋此決策)**:艾略特波浪 `_detectElliott`(保守純公式:只在符合三大鐵律=第2浪未破起點/第4浪不重疊第1浪/第3浪非最短 時標「推估」,嚴格 gating 防主觀誤導;偵測「完成五浪→防ABC」與「第3浪推進中」)。原理由仍成立(太主觀),故一律標「推估」非鐵律。

## 🧮 V49.x — 基本面 X 光機改純公式 + 潛力頁三層對照 + 夜間全市場補齊

### 基本面 X 光機「取消 AI 改數字」(V49.0)
- **澄清**:此頁所有**數字**(投資屬性雷達 / PE / YoY / 毛利 / 殖利率 / 填息 / PEG / P/B)本來就全是純公式(JS + FinMind + 採礦快取),已符合「禁 AI 算數」。唯一 AI 是最底下「總裁解讀」那段**質化文字**。
- **純公式體質總評**(`_renderXrayVerdict`):讀 `this._xrayMetrics` 已算好的數字 → 規則產生 🔥強勁/✅穩健/⚖️中性/🚨偏弱 + 體質分 + 利多(紅)利空(綠)chip + 白話對策。零 API、零幻覺、秒出。
- **AI 改手動按鈕**(`forceAI`):想要更白話再點,預設不跑省額度(同全球新聞 V41.2 做法)。
- **鐵則**:負向因子要**真的計入 score/max** 才會拉低分數(V49.4 修「吃老本」只顯 chip 不扣分的 bug)。
- **降噪**:移除 12 張卡的霓虹漸層(`bg-gradient-to-br to-*-950`)→ 純色,符合 V25.8 設計規範。

### 潛力/黑馬三層對照(V48.8/V48.9)
- 🌡️ **大盤環境權重**:`_calcRiskScore()` 高 → 分數打折(黑馬 0.93/0.85/0.75、長線較輕 0.97/0.92/0.85);排名不變,只反映系統性風險。
- 🏭 **同業比價**:同產業(本榜)內分數排名,🥇同業最強 / ⚠️同業落後;避免買落後補漲弱勢股。
- 💵 **停利金額**:目標價下方「每張 +X 元」=(目標−現價)×1000(僅目標>現價時顯)。

### 🌙 夜間全市場基本面滾動補齊(V49.2 — fund_sweep.py + fund_sweep.yml)
- **痛點**:FinMind 免費版「全市場 bulk」回 0 筆,daily_miner 只逐檔補 `HOT_CHIPS_LIMIT=100` 檔 → 其餘 ~1900 檔冷門股 YoY/毛利永遠「採礦更新中」。
- **解法**:另一支夜間輕量採礦,**滾動式**每晚挑「最舊/沒抓過」的 N 檔(預算 500)逐檔免費抓,節流 3s/檔防 429,~4-5 個交易夜輪完全市場,之後永遠優先刷最舊 → 全市場維持 ~5 天新鮮。
- **時間**:cron `0 18 * * 1-5` = 台北凌晨 02:00(週二~六)。
- **為何不吃白天額度(關鍵)**:採礦用 **GitHub Secrets 的 `FINMIND_TOKENS` + GitHub IP**,跟手機前端 **localStorage 的 key** 是**不同 token、不同 IP,額度完全分開**。
- **連動安全鐵則**:輸出寫**獨立檔** `data/fund_yoy_gm.json`,**不動** daily_miner 重建的 `fundamentals_cache.json`(否則會被下午完整採礦洗掉);靠 daily deploy 的 `git archive origin/data` 自動保留。前端 `_loadFundYoyGm()` 當 YoY/毛利 fallback。
- **workflow git 陷阱(實測修過,V49.4)**:`data/*.json` 在 main 是 gitignore →
  - 還原資料用 `git show origin/data:檔 > 檔`(**不要** `git checkout origin/data -- data/`,會把整批 stage 進 index 弄髒工作區)。
  - 切分支前 `git reset --hard` + `git clean -fdq`,再 `git checkout -f`(可越過 gitignore untracked 衝突,已實測)。
  - `git add -f`(強制越過 gitignore)+ `git commit -- 檔`(明確 pathspec,只提交這一檔,別洩漏無關檔到 gh-pages)。
- **自我修復**:命中 < `FUND_MIN_HITS`(20)不覆寫、不部署(保留舊檔);部分完成也 OK,下晚接著補,永不整批歸零。

## 🧪 ORB 開盤區間突破當沖 — 實測「扣成本不划算,暫不上」(2026-07-20)

**背景**:使用者要「盤前做功課、盤中確認要做哪隻」的最準當沖工具。評估「分K 開盤區間突破(ORB)」回測。

**探針(`orb_probe.py` + `orb_probe.yml`,休眠保留,可手動 Run 重驗)實測結論**:
- **資料面完全可行**:專案已整合**永豐 Shioaji**(`live_snapshot`/`tick_flow` 在用,Secrets 已有 `SHIOAJI_API_KEY`/`SECRET_KEY`)。`api.kbars()` 免費抓歷史 1 分K,深度 **~81 交易日**(每檔 ~2.1 萬根),8 檔 ~24-34s → 全清單 ~100 檔約 5 分鐘。
  - ⚠️ **釘 `shioaji<1.7`**(1.7 移除 `login(fetch_contract=)`,同 live_snapshot/tick_flow)。
  - ⚠️ **Shioaji kbars `ts` 已是台灣牆鐘(naive)**:用 `datetime.fromtimestamp(ts/1e9, tz=timezone.utc)` 讀才得正確 09:00~13:30;**別再套 TW(+8)** 否則變 17:00~21:30 → 時間閘門全誤判(實測踩過)。
- **策略面:扣成本後全部虧損 → 不上**。掃 停利/停損(0.5/0.3~1.0/0.6)× 量能確認(爆量才進)× 多空 × 過濾寬OR(震盪),pooled 8 檔:毛利僅 ~−0.05%/趟,**扣當沖來回成本 ~0.25% 後,最佳也 −0.22%/趟,無一組淨期望為正**。ORB 在 2026-03~07 震盪盤沒有超過成本的邊際。
- **鑑別度存在但不等於能賺**:各股各方向勝率 12.5%~43.8% 差很大(2454做多43.8%、2317/3037做空~39%強;2330/鴻海做多~13%爛),但整體邊際被成本吃掉。

**決策(鐵則)**:
- **暫不建 orb_miner / 前端 ORB 欄**。維持 **V68.8.9 日K「歷史勝率×開盤情境」排序**當盤前做功課工具(已上線、免採礦、誠實)。
- **未來若遇明顯趨勢盤(大多頭/大空頭)可重驗**:ORB 在趨勢盤理論上較有效;手動 Run `orb_probe.yml` 看有無正期望再決定,別憑感覺上。
- **通用教訓**:當沖/短線策略「回測看勝率」不夠,**必須扣手續費+當沖稅(來回 ~0.25%)算淨期望**,毛利正不代表能賺。探針先行、實測不猜,擋掉「做出來會賠還誤導」的功能。

## 🧭 板塊籌碼輪動「偷布局」— 探針實測結果(2026-07-28,V71.0.5)

**背景**:使用者問「我新增的板塊籌碼輪動策略有沒有用?是我想到的嗎?有更強的作法嗎?」
照 ORB 那次的教訓(探針先行、實測不猜),寫 `sector_flow_probe.py` 拿真實資料回測,不憑感覺回答。

**⚠️ 資料硬限制(先講,不然數字會被誤讀)**:`data/{sym}.json` 的 `foreign_net`
**只回溯到約 2026/05**(實測 60 個交易日),不是 5 年 → 樣本極薄,**只能當方向參考,不足以下結論**。
外資資料累積到 1 年以上再跑一次才有統計意義。另 **券商群聚那段完全無法回測**
(`data/chips/` 只有滾動 20 日快照,沒有逐日歷史)。

**方法論重點(下次做類似回測務必照做)**:
- **必須有「乾淨對照組」**:不能只跟「全體基準」比。同樣是跌下來的板塊,分成「外資買」vs「外資賣」,
  才能分離出「賺的是跌深反彈,還是真的跟籌碼有關」。實測基準組 20 日 +2.90%、純弱勢組 +4.62%
  → 光是「跌深」本身就有 +1.7pp,不設對照組會把反彈的功勞算到籌碼頭上。
- **必須做事件去重**:同板塊連續多天觸發是同一件事。47 筆原始樣本去重後只有 **18 個獨立事件**,
  報 n=47 是灌水。

**實測結果(2026/05-07,以「純弱勢」為對照)**:
| 版本 | 獨立事件 | +20 日超額報酬 | +20 日勝率 |
|------|---------|--------------|-----------|
| 基本版(跌+外資買) | 18 | +3.18 pp | 70.2%(對照 56.4%) |
| A 買超佔量比 ≥0.5% | 17 | +2.99 pp | 70.7% |
| B **改看投信** | 28 | **−2.62 pp** | 49.4% |
| C 外資10日買≥6天 | 4 | −0.79 pp | 樣本太少無效 |
| **D 基本版 + 已跌深(距60日高≥12%)** | **15** | **+3.81 pp** | **75.0%** |

**結論與已落地**:
- ✅ **變體 D 勝出**(三個天期全面優於基本版)→ 已做進 `build_sector_chip_flow`
  (`stealth_deep` 欄 + `dd60`),前端兩層徽章:`🕵️偷布局`(青)/ `🕵️偷布局·深蹲`(琥珀,較強)。
- ❌ **「投信比外資靈」是錯的**(我原本的假設):投信版 5 日還行、**10/20 日轉負**
  — 符合投信短線追價 / 作帳性格,不適合當「偷布局」的中期訊號。**別再提議改用投信。**
- ➖ 買超「佔量比」normalize 沒有明顯改善(原以為大板塊會佔便宜)→ 不做,維持絕對張數。
- **原創性誠實話**:這不是新發明,機構圈的 sector fund flow / smart money divergence 早有;
  XQ、籌碼K線 等付費工具有類似功能。**價值在於「免費工具裡少見」而非「沒人想過」** — 別對使用者說是首創。

**再驗時機**:外資資料滿 1 年後重跑 `python3 sector_flow_probe.py`(只讀 data/,不寫檔不打 API)。
若那時 D 版邊際消失 → 降級為參考資訊,別留著誤導。

---

## 📡 Fugle 即時報價方案限制(官方,2026-07 使用者提供)+ 庫存多檔 WS 架構

**Fugle 官方三方案(基本用戶=免費,註冊富果會員即用)**:
| 項目 | 基本(免費) | 開發者(NT$1499/月) | 進階(NT$2999/月) |
|------|-----------|------|------|
| 台股即時行情 **WebSocket** | **5 訂閱數 · 1 連線數** | 300 訂閱 · 2 連線 | 2000 訂閱 · 2 連線 |
| 台股日內行情 **API(REST)** | **60/min** | 600/min | 2000/min |
| 台股日內行情快照 | ❌ 不支援 | 600/min | 2000/min |
| 台股歷史行情 | 60/min | 60/min | 60/min |
| 台股技術指標 | ❌ 不支援 | 60/min | 60/min |

**鐵則(免費版 WS「5 訂閱/1 連線」是硬限制,踩過)**:
- **庫存多檔 WS(V68.9.1→V68.9.2)**:免費版一條連線只能訂 5 檔 → 必須**依金鑰分片**:`_startInvWsStream()` 每把 key 開一條連線、各訂 ≤5 檔(`PER=5`),每條連線用**不同 key**(各自 1 連線額度不互撞)。使用者 7 把 → 7 連線×5 = **35 檔毫秒級**,超過的靠 REST 局部輪詢(`_updateInvCells`,2.5s)補。**別再寫「單一連線訂 30 檔」**(V68.9.1 舊寫法超限,已修)。
- **個股頁 WS(`_startFugleStream`)**:單檔 1 連線,只在個股頁(diag)開;庫存 WS 只在庫存頁開 → **不同分頁不同時**,不會撞「1 連線」限制。切頁自動關(`_stopInvWsStream`/`_stopFugleStream`)。
- **REST 60/min/把**:庫存輪詢間隔 `_invPollMs()` = clamp(檔數/key×900ms, 2.5s, 12s),每把 key <1.2 req/s 遠低於 60/min;當沖加速 `_dtAccelMs()` = clamp(3000/key, 1s, 3s)。速度**隨金鑰數自動調**(分發給別人:1 把也穩、多把自動快),加 key 當場變快。
- **WS 純加值層**:失敗/協定不符/盤後靜默關,REST 一定頂著,現價不會消失。

### 🐛 籌碼分點「沒開過的股 App 當掉」(V68.9.2 修,無限迴圈)
- **症狀**:開「券商分點」頁對一支**沒有 `data/chips/{sym}.json`** 的股(分點只追約 50 檔熱門股/ETF,一般股沒有)→ App 凍結/當掉。
- **根因**:`_renderBrokerFenDian` 的 `!P` 分支 `.then(ok => ...再 render)` **沒判 ok** → 該股 load 永遠回 false、render 又進 `!P` 又 load → **無限 fetch 迴圈**(每圈還 `?t=Date.now()` 破快取狂打)。有 chips 的股載一次就停,所以只有無資料股會爆。
- **修法**:`.then` 只有 **`ok=true` 才重繪**;`false` 顯誠實空狀態(此股無分點資料,一般股看三大法人/融資券即可)+ `_fenLoading` 防重入。**教訓:任何「load 失敗還無條件重呼叫 render」的遞歸都要 gate 在成功條件上,否則無資料 = 無限迴圈。**

### 🧙 券商分點勝率榜「前瞻回測」為何要等(broker_perf.json)
- `miner.py::_broker_perf`:①每日把當日 top5 分點買超存 `broker_signals.json`(滾動 45 交易日)②**前瞻回測用 SQLite `stock_history`(5 年 K)算訊號日後 1/5/20 交易日收盤勝率** → 隔日沖/短線/波段三榜。
- **「outcome 已用歷史即時算,不用等」**;要等的只是**訊號日數累積**(波段需 ~20 交易日份訊號)。
- **不能完整回填的原因**:`data/chips/*.json` 是**滾動 20 日快照**,沒逐日保存過往每天的分點,免費分點史又被付費牆/BSR 擋 → 過去每日訊號無從重建。
- **可做的近似回推(待評估)**:把現有 chips 的 5d/10d/20d 買超均價當「-5/-10/-20 交易日的合成訊號」forward-test 到今日 → 立刻有短線/波段樣本(近似,非逐日精確)。屬 miner 改動,上前先確認。

## 🎯 V72.2.0 「今天出現實測會賺的訊號」—— 全市場掃描
使用者:「只要給我最好、勝率最高的資料」。
問題:`_SIGNAL_EDGE` 的成績只在**個股頁**看得到 → 使用者得先想到要看哪一檔,
等於要他自己翻 2,315 檔(**陷阱 #32 的極端版**)。

`scripts/daily_signal_scan.mjs`:採礦端跑**真正的 JS 偵測器**(同 `signal_backtest.mjs`
的做法,⛔ 不複製判定邏輯),只掃**最後一根 K**。
📊 **實測:2,315 檔 / 177 秒 / 產出僅 3.6 KB**;命中 **17 檔**(全市場!)。

⛔ **五條鐵則**:
- **看多只收 `exp > 0`** —— 常對但不賺的不進榜(V72.0.3 的教訓)。
- ⛔ **不逐檔列風險股** —— 全市場 6,158 筆,取前 N 只是**任意截斷**
  (同一訊號的期望值完全一樣,排序沒有意義),而且「全市場哪些有風險」
  對使用者沒有可操作性(他要看自己手上那幾檔,前端 `_entryCheckup` 本來就做得到)。
  → 只給 `risk_n` / `risk_syms` **總數**當大盤氛圍。
- ⛔ **不做成第 16 個榜單** —— 選股頁已有 15 個榜(都沒有實測成績),
  做成分頁會被埋掉 → 放**最上方常駐條**,沒中的日子整條不顯示(不留空殼)。
- ⛔ **採礦端不存股票名稱** —— 前端已有 `getStockName()`,存兩份會不同步。
  ⚠️ 但要注意 `getStockName` 在清單未載入時**回傳代號本身** → 顯示端要判
  `n !== sym` 否則會變成「8464 8464」(實測踩過)。
- **同期望值時第二鍵用成交量** —— ⛔ 別讓它退化成代號序(那等於「1xxx 永遠排前面」,又一種偏誤)。

⚠️ 三個免責必須在卡上:基準勝率 36% 不是 50% / 未扣交易成本(來回 0.44%) /
歷史統計不是保證、且只看 K 線沒看籌碼基本面。
測試 `scripts/test_todaysig.mjs` 30 條。

## ⚡ V72.1.9 `_CHANGELOG` 瘦身:App 內只留最近 60 筆
更新紀錄累積到 **343 筆 / 147 KB**,佔 index.html 的 **5.1%** ——
每次開 App 都要下載,而使用者不會往回翻 300 版。
(同 V69.8.7 把第 18 行歷史搬出去的做法,那次是累到單行 93.5KB。)

→ App 內只留**最近 60 筆**(約一個月),更早的 **283 筆完整搬進 `CHANGELOG.md`**。
📉 效果:index.html **2.82 MB → 2.72 MB**,`_CHANGELOG` 147 KB → 42 KB。

⛔ **三條鐵則**:
- ⭐ **是搬移不是刪除** —— 一個字都不能少。測試 ② 會**抽驗已搬走的版本號真的在
  `CHANGELOG.md` 裡**,確保日後有人「順手清一清」時不會變成真的刪掉。
- **跳窗底部要指路**(顯示幾筆 / 完整版在哪 / 為什麼這樣做),
  ⛔ 別讓使用者以為舊紀錄不見了。
- **只刪不重寫** —— 用行號刪除第 61 筆之後的整段,⛔ 別用 `JSON.stringify` 重新產生
  (那會把手寫的 `{ v: 'V..', dt: .. }` 格式洗掉,diff 變成整段重寫,看不出改了什麼)。

⚠️ 新增版本一律加在**陣列最前面**;筆數又超過 ~80 時照同樣做法再搬一次。
測試 `scripts/test_changelog_trim.mjs` 16 條(含大小守門 ≤80KB、
`_CHANGELOG[0].v` 必須等於 `_APP_VERSION`)。

## 📅 資料日期標示鐵則(V70.2.0,使用者要求:分不清今天還是上個交易日)
- **任何顯示「資料」的卡片都要標日期**,格式一律走共用工具:`app._dW(raw, {y, rel})` → `07/28(二)`;
  重要卡片加 `{rel:1}` 顯「今日/昨日/N 天前」;需要過期提醒用 `app._dChip(raw, '標籤')`(≥4 天自動轉黃 + ⚠️)
- ⛔ **禁止自己拼日期字串**(`.slice(5,10)`、`replace(/-/g,'/')` 那種)— 格式會分歧,一律用 `_dW`
- **新增任何「後端產資料 → 前端讀」的卡**,必須把該檔的 `updated`/`data_date` 一併存進 cache 變數
  (如 `_fmxUpdated`/`_attentionUpdated`/`_potPickUpdated`)並在卡片標題旁顯示
- 即時類(盤中報價/逐筆)標「日期 + HH:MM + 盤中/收盤」;週更類(集保)標結算日;月更類(董監)標月份

## 📐 橫版(landscape)檢查鐵則(V70.1.0,使用者要求記錄)
- **改版面必測橫版**:headless 844×390 載入後 `window.scrollTo(80,0)` 斷言 `scrollX ≤ 2`(頁面禁止橫向捲動;`scrollWidth` 會把被 clip 的內容也算進去,不能拿來當判準)
- 卡片禁固定 px 寬,一律 `w-full`+`max-w-*`;canvas 用 clientWidth 動態算
- 寬內容(表格/長列)包 `overflow-x-auto` 自己滾,不准撐寬整頁
- **flex 子項陷阱**:`flex-1` 預設 `min-width:auto` 會被長內容(跑馬燈/長字串)撐開 → 整頁橫向溢出;要加 `min-width:0`(V70.1.0 跑馬燈實例)
- `html,body { overflow-x:hidden }` 已當總保險,但那是止血不是治本,新增溢出仍要修元凶
- **轉向(rotate)必測**:portrait 載入 → 改 viewport 844×390 → dispatch resize → 斷言各 ECharts canvas 寬跟上(V70.1.2 已加全域 debounce resize listener,一次照顧所有 `[_echarts_instance_]`;新圖免另掛)
- **圖上文字禁裸放**:markArea/markLine label 會被柱/線蓋 → 一律加 `backgroundColor:'rgba(13,17,23,0.85)'+padding`(V70.1.2 溫度計標籤實例)

## 🗣️ 使用者近期反覆強調的鐵則(2026-07-27 彙整,使用者要求記錄)

以下是使用者在 2026-07 下旬**多次重複**講的話,每次做功能前先過這份清單:

1. **「邏輯不打架、資訊不爆炸」**(講最多次的一句):
   - 同一個名詞全 App 只能有一個數字;不同公式就要不同名字(V69.7.5 主力成本教訓)
   - 主結論最大(單一劇本原則):所有卡片的行動指令以「現在怎麼做」為準,其他卡只解讀不下指令
   - ⚠️ 全 App 尚有 5 處「主力成本」、3 處「籌碼綜合評分」、2 處「½價」同名不同值,清單見 `docs/OPTIMIZATION_PLAN.md` P1.5
   - ⭐ **時間尺度不同 ≠ 可以各講各的**(V71.7.7 使用者截圖抓到):同一畫面「分析師盤勢解讀」寫
     「偏多格局,可偏多操作」、「反攻條件雷達」寫「打底觀察中 7/10」、跑馬燈寫「多頭轉弱」
     → 三個結論互相矛盾。前者算的是**加權當下技術分數(短線)**,後者看**這波跌完沒(中期)**,
     兩個都沒算錯 —— 錯在**兩張卡都在下操作指令**。修法:**短線可以描述,但只有中期過關才准下加碼指令**
     (`_marketAnalystHtml` 讀 `this._reboundVerdict`,中期沒過門檻就改講「短線轉強、但中期未過關,
     做短不加碼」)。⛔ 新增任何會講「可以進場/加碼」的卡,一律先問「中期那張怎麼說」。
     測試 `scripts/test_verdictclash.mjs`。
   - ⭐⭐ **「主結論是空頭時,短線卡只准描述、不准下多方指令」是通則,不是個案**
     (V71.7.7 分析師解讀 → V72.0.7 明日劇本 → V72.0.8 本股vs大盤,**同一個錯犯了三次**)。
     `_renderTrendCommand` 已把主結論曝成 **`this._ovTrend` = `{sym, trend, txt}`**(綁 sym 防切股殘留)。
     ⛔ **新增任何會講「可以進場/抱好/加碼/順勢做多」的卡,一律先呼叫 `app._bearGate(sym)`**
     (V72.0.9 抽出來的**唯一守門**;前 4 次都是各寫一份判斷式 → 已統一)。
     `_bearGate` 回 true 時把**操作指令**改成「反彈減碼」,⚠️ 但**事實描述不動**
     (「今天比大盤強」是真的,不可竄改;要改的只有那句叫人怎麼做的話)。
     ⚠️ **第 4 處(V72.0.9)在「⭐ 重點判讀」常顯區** —— 比前三處更顯眼,
     卻是最後才被發現的:**巡邏時要先掃常顯區,不是只掃摺疊區**。
     測試 `scripts/test_verdictclash.mjs` ⑤~⑬ 把四處都釘住。
   - ⭐ **兩個指標黏成一句話之前,先問「它們會不會相反」**(V72.0.9,使用者 2327 截圖)。
     實例:`_chipAnalystLine` 把「方向」(大戶籌碼總結)與括號裡的
     「籌碼**乾淨度**主因」(`driver`)直接並排 → 生出
     **「大戶站買方(大戶倒貨給散戶)」** 這種自相矛盾、看不懂的句子。
     ⛔ 兩者相反時**不可並排**,要改成「…、籌碼乾淨,**但大戶倒貨給散戶**」把矛盾明講出來。
     ⭐ 通用:**括號 = 補充同一件事**;不同指標黏在一起要先判方向是否一致。
   - ⭐⭐ **同名不同義:改名之外還要「主動點出差異」**(V72.0.8,使用者 2327 截圖)。
     同一畫面出現「大戶 5 日買超 2,126 張」/「主力 偏賣 −19,503 張」/「主力今日整體大買 4,914 張」,
     **三個都沒算錯**,是三件事:①官方三大法人(`foreign_net+trust_net`,看**身分別**)
     ②券商分點前 15 大(`_chipMainForce`,看**哪家券商**)③分點**今日**淨額。
     → ①改名「法人」、②改名「分點主力・近5日」+ title 說明;
     ⭐ **而且方向相反時要主動跳一行白話解釋**(`clashNote`)——
     ⛔ **不可硬統一成一個數字**(那會失真),也⛔不可讓使用者自己去發現。
   - ⭐ **顯示的 % 與由它換算的金額必須自洽**(V72.0.8):使用者數學不好、**會拿畫面上的數字驗算**。
     實例:`per.vol` 是 7.375 → 顯示 `toFixed(1)` = 7.4%,金額卻用 7.375 算 → 41.67,
     但使用者用 7.4 算是 41.81,以為程式錯了。⛔ 一律用**顯示值**回算金額。
   - ⭐ **門檻要寫在卡上**:使用者問「7/10 何時才是反攻,要等到 10/10 嗎?」——
     其實門檻是 `max(6, 條件數−2)`(10 條時 = 8),但卡上只寫「7/10」沒寫要幾條 → 被誤會成要全亮。
     **任何「N/M 條通過」的卡都必須同時顯示門檻與「還差幾條」**,且兩個數字要從同一個式子算,
     ⛔ 別在文案裡另外寫死(條件數會變動)。測試 `scripts/test_radar_gate.mjs`。
2. **「合併卡片,不要加新卡」**:新資料一律併入既有卡片;重複的卡合併;要刪就刪,大改版面也沒關係
3. **「條件觸發、自動出現」**:訊號到了才顯示,沒事完全隱藏(不留空格、不顯紅警誤導);最好全自動,使用者不用思考要點哪裡
4. **「對標專業付費 App」**(籌碼K線/挖寶區/XQ):有用、能更厲害的才加;**沒用不要亂加**;資料撐不起的功能誠實不做(如買賣家數差),不做假數字
5. **「新增功能要考慮連動」**:改 A 之前先想 A 連到哪些 B/C/D(說明文字、AI prompt、評分、快取、fallback 鏈、artifact 清單),一次補齊
6. **「一直做不要停、不用問」**:建議過的就直接做;只有大重構/刪資料/改核心 workflow 邏輯才問
7. **「白話+實際金額」**:所有 % 順便給元;數字千分位逗號(會計格式);重要結論放頁面最上方第一眼位置
8. **「資料要最新的,老舊沒意義的刪掉」**(概念標籤教訓):寫死的對照表要有採礦更新機制,否則過期
9. **「盤後要讓持股人看懂今天」**:敘事型解讀(短線/波段雙視角),不是只丟數字
10. **圖表類改動必須用「真引擎」headless 渲染驗證**(V69.7.7 教訓:stub 測試全過,真 ECharts 直接 throw,使用者看到空白圖)

## 📋 全盤體檢待辦(2026-07-27)

`docs/OPTIMIZATION_PLAN.md` 的 45 條優化清單(P0 資料流 → P1 效能 → P1.5 卡片打架/殭屍卡 → P2 瘦身 → P3 採礦效率)**已於 V71.0.8 全數完成**。
該文件現在的價值是**決策紀錄**而非待辦:每一條都寫了「做了什麼 / 為什麼這樣做 / 哪些原計畫是錯的」。
接手前務必讀,尤其這幾條**「驗證後決定不做」**的,別再重做一次:
- **P2-6**「兩支長黑/長紅 K 偵測器合併」「波段轉折抽共用」→ 門檻與回傳型別本來就不同,合併會改變訊號輸出。
- **U-15** 當沖燈 + 作戰室 hero 合併 → 兩卡語意不同(方向 vs 真假),互補非重複。
- **U-16** 不併「🔴 盤中連量偵測」→ 它在常顯區且是即時警訊,搬進摺疊區是退步。
- **U-18** 不刪 4 張防守卡 → 各卡的「為什麼」說明是使用者要的教學,改成上方加一條「由近到遠」的尺。
- **U-14** `updateAITranslator` / `analyzeStockPredict` **是活的**,原清單誤列為死碼,照抄會刪掉功能。

## 📊 全訊號實測勝率表(V71.9.9)⭐ 使用者要求:「只顯示有用、勝率高的,不要全部打出來」

`scripts/signal_backtest.mjs` —— **跑真正的 JS 偵測器**跑歷史(⛔ 不複製一份判定邏輯)。
250 檔 × 每 2 根 K × 40 個偵測器,報酬扣同期加權,同檔同訊號 5 日內只算一次。
結果嵌成 `index.html` 的 **`_SIGNAL_EDGE`**(122 筆,約 10KB),用 `app._sigEdge(det, title)` 查。

### ⚠️ 兩個一定會被誤讀的地方(⛔ 改文案前先讀)
1. **基準勝率是 34.6%,不是 50%** —— 超額報酬是對**市值加權**的加權指數算的,
   中位數個股本來就跑輸(同 cb_probe / volstall 那幾次)。**勝率 41% 已經是贏基準**。
   → `_winRateP(wins, n, p0)` V71.9.9 加了第 3 參數,**預設 0.5 不變**(既有呼叫端零影響),
     回測一律傳實測基準。⛔ 用 50% 檢定會把訊號評得太好。
2. 「邊際」= 訊號報酬 **減掉**「隨便挑一天」的報酬,⛔ 不是絕對報酬。

### 🏅 實測結論:**六成的訊號沒有鑑別力**
| 級別 | 定義 | 個數 |
|---|---|---|
| ✅ A | p ≤ 0.05(統計上站得住腳)| **29** |
| ⚠️ B | p ≤ 0.25(證據偏弱)| 20 |
| C | 跟隨機沒差 | **73(60%)** |

最強幾個(10 日邊際):底部頸線突破 +1.47% ・晨星轉折 +1.36% ・極端超跌有量 +1.23%
・向上跳空未回補 +1.09% ・葛蘭碧買3 +1.05% ・站上長黑K高點 +0.87%。

### 🚨 V72.1.7 回測的**選樣偏誤**:「500 檔」其實只涵蓋 1xxx~2xxx
`signal_backtest.mjs` 舊版是 `files.sort()` 之後**取前 N 檔** →
所謂「500 檔」實測涵蓋 `{0:10, 1:238, 2:252}`,**完全沒有 3xxx~9xxx**
—— 那是全市場 2,356 檔裡的 **1,744 檔(74%)**,
大立光 3008 / 矽力 6415 / 緯創 3231 這些重要電子股**全部缺席**。
⛔ 「500 檔」聽起來樣本很大,實際上只有傳產金融。

⭐ **通用鐵則:任何「取前 N 檔」的抽樣,都要先問「排序之後前 N 是不是有系統性偏向」。**
台股代號本身帶產業意義(1xxx 傳產、2xxx 電子金融、3xxx~8xxx 電子居多)→
按代號排序取前 N = 按產業取樣,必然偏。

修法:預設改成**全市場**(`MAX_SYMS` 預設 99999),
並在 meta 存 `cover`(代號開頭分布)→ 日後一眼看得出有沒有偏誤。

⭐ **V72.1.8 全市場重跑完成**(實測耗時 **1,016 秒 ≈ 17 分鐘**):
| | 舊(500 檔)| 新(全市場)|
|---|---|---|
| 檔數 | 500(只有 0/1/2 開頭)| **2,227**(0~9 全涵蓋)|
| 基準樣本 | ~11.5 萬 | **498,935** |
| 基準勝率(10 日)| 36.0% | **36.4%** |
| A 級 | 42 | **54** |
| 訊號總數 | 128 | **129** |

⭐ **最強訊號是舊樣本裡看不到的**:**頭肩底(形態)期望 +3.38%・勝率 49.7%・賺賠比 1.90**
—— 它在 3xxx~9xxx 電子股上表現特別好,而舊版一檔都沒測到。
🚨 **129 個訊號裡期望值為正的只有 9 個** → K線頁只把這幾個放進「值得參考的進場訊號」。

⚠️ 回測**真實窗口只有 486 個交易日(2024-07-30 ~ 2026-07-30,約 2 年)**
—— 受 `^TWII.json` 長度限制(超額報酬要扣同期大盤,個股再長也只能算到那段)。
⛔ 教學文案曾寫死「3 年歷史」→ 已改成從 meta 的 `win_from`/`win_to`/`win_bars` 帶入。

### 📥 `scripts/embed_signal_edge.mjs` —— ⛔ 別再手動改那兩行
V72.0.2 踩過:手動 regex 換 `_SIGNAL_EDGE` 時**只換到 meta、沒換到資料表**,
於是 meta 說「500 檔 A=42」但資料還是 250 檔那版 —— 兩邊各自看起來都對,最難發現。
→ 寫成腳本:**兩行一起用行號整行替換 + 換完立刻交叉驗證**
(分級數 / 筆數 / 檔數 三項不符就 `exit 1`)。

⭐ 這支腳本第一次跑就**當場擋下自己的兩個錯**:
① 欄位名猜錯(`s.det`/`s.title` 不存在,實際是 `s.key`)→ 全變 `undefined｜undefined`
② `base.win` 是**依天期分的物件**不是數字 → 要取 `['10']`
**沒有那段交叉驗證,這兩個都會靜默寫進 index.html。**

標準流程:
```bash
node scripts/signal_backtest.mjs      # 跑回測(預設全市場,約 18 分)
node scripts/embed_signal_edge.mjs    # 嵌入 + 自動交叉驗證
node scripts/test_sigedge.mjs         # 驗證
```

### ⛔ 三條鐵則
- **`_SIGNAL_EDGE` 是偵測器的屬性,跟程式碼綁**(刻意嵌在 index.html,不走採礦)。
  → **改了任何 `_detectXxx` 的判定邏輯,必須重跑 `signal_backtest.mjs` 更新這張表**,否則成績會對不上。
- ⛔ **不可把 C 級刪掉** —— 裡面有風險提醒型訊號(長黑棒之類),刪掉會讓使用者以為沒風險。
  正確做法是**收進摺疊區**並標「觀察用,別當進場理由」。
- ⛔ 查不到成績的訊號一律當「未驗證」,**不可假裝有成績**(`_sigEdge` 回 null)。
- ⚠️ 收訊號要用 `_tagPush(sigs, '_detectX', data)` 才會記下來源;
  `unshift` 置頂的那幾個要自己補 `x._d`,否則永遠查不到成績(測試 ③ 有釘)。
- ⚠️ `renderKbarTactics` 的 `sigs` 必須是 **`let`**(重排時整個重新指派)—— 同陷阱 #33。
### 📍 落地位置(V71.9.9 K線 / V72.0.0 總覽)
- **K線頁** `renderKbarTactics`:A/B 級置頂 + 勝率徽章;C 級與未驗證收進 `<details>` 摺疊區。
- **總覽「進場體檢」** `_entryCheckup`:
  - 卡片最上方新增「🎯 今天出現實測有效的訊號」區(沒有時誠實說沒有 + 勸阻硬找理由進場)
  - ⭐ **計分改成多空不對稱**(⛔ 別「統一」成同一套):
    **看多**訊號依分級打折(A 全額 / B 七折 / C 與未驗證**三折**)——
    沒驗證過的東西不該拿來當進場理由;
    **看空與警示訊號 ⛔ 一律不打折** —— 風險提醒就算統計上沒被證實,
    **忽略它的代價(住套房)遠大於多看一眼的代價**。寧可多提醒,不可少提醒。
- 教學 `_showEdgeHelp()` **兩頁共用同一份**(⛔ 別寫兩套文案,改一邊會忘另一邊)。
測試 `scripts/test_sigedge.mjs` 38 條(含多空不對稱三條、`_winRateP` 向後相容三條)。

### 📐🔬 V72.1.3 K線頁/籌碼頁一筆一筆檢視 —— 抓到兩處「各說各話」
使用者:「幫我一筆一筆檢視…我要的是**勝率高**、**一目了然知道現在怎麼做**,
而不是多個卡片自己講自己的」。用**真實 2327 + 真實 gh-pages 分點**跑出來:

**① K線頁標「🎯 實測有效的訊號(3)」,但三個期望值全是負的**
(−0.295% / −0.802% / −0.224%)。勝率 41~44% 確實贏基準 36%,
但**輸的時候輸更大** → 標「實測有效」等於叫人進場,是誤導。
⚠️ V72.0.3 已在總覽定調「看多必須 `exp>0`」,**K線頁那時沒跟上**。
→ `renderKbarTactics` 改**三分區**(⛔ 別退回只看統計分級):
- `good` = 看多 **且 `exp>0`** → 「🎯 值得參考的進場訊號」
- `risk` = 看空/警示 → 「⚠️ 風險提醒」**獨立不收合**(⛔ 不看期望值,風險不打折),
  並標「不是賣出指令」
- `dull` = 看多但 `exp≤0` → 併進摺疊區,⛔ **不刪**
- 一個都沒有時要誠實寫「沒有」+「別硬找理由進場」

**② 籌碼頁同一頁兩個「主力」方向相反**
「明日劇本」= `periods['1d']`(**今日** +9,828 張)、
「主力動向」= `periods['5d']`(**近 5 日** −15,009 張)。
⛔ 都沒算錯,是**不同時間範圍** —— 但名字一樣又沒標範圍。
⚠️ V72.0.8 只修了總覽的「法人 vs 分點主力」,**籌碼頁的「今日 vs 近5日」沒跟上**。
→ `_chipTomorrowScenario` 加 `clash5d`:方向相反時主動講白話
(「今天轉買但 5 天整體還是賣超 → 可能只是**單日回補**,要連續 2~3 天買超才算數」)
+ 明說「下面那張看的是近 5 日,**兩張不是在吵架**」;因子清單也標「今日」。
⛔ 方向一致時不顯示(免得變雜訊)。

#### 🧭 V72.1.4 K線頁補「一句話結論」+ 全檔掃「講反話」
**① K棒戰法卡最上方加 `_headline`** —— 原本一堆訊號並列,看完不知道結論。
現在一句人話講完「有幾個正期望值訊號 / 幾條風險提醒 / 中期趨勢怎麼說」。
⭐ 讀 `_bearGate` + `_ovTrend`,**跟總覽同源**,不會各說各話。
⛔ **刻意不給買賣價位** —— 具體指令一律以總覽「現在怎麼做」為準,
這頁只負責解讀 K 線(單一劇本原則:一個畫面只能有一個地方下指令)。
測試 `test_kchip_audit.mjs` ③ 有釘「結論句不可含買進/掛單/停損價/目標價」。

**② 全檔巡邏抓到第 5 處講反話**:籌碼頁「大戶籌碼總結」的 `act`
在 `sc >= 1` 時寫「順著做、別跟大戶對作」→ 已套 `_bearGate`。

⭐ **巡邏指令**(改這類問題時先跑一次,⛔ 別只修發現的那一處):
```bash
grep -nE '順勢做多|順著做|可順勢|抱好|別提早下車|放心做|可以進場|順勢操作|抱單|可加碼|快進快出|分批試單|可以追|追要' index.html
```
⚠️ **字典要持續補** —— V72.1.7 抓到第 6 處(`renderChuKbarVerdict` 的
「型態偏多…**現在追要快進快出**」)就是因為那幾個字**不在第一版字典裡**。
⭐ 通用:巡邏 grep 只能抓「你想得到的說法」→ **真正可靠的是實際渲染後人工看一遍**
(`node` headless 餵真實資料,把卡片 innerText 印出來)。
⚠️ 實測 40 處,**多數是誤報**,人工驗證要點:
- 註解 / `_CHANGELOG` / 教學文案 → 不是實際指令
- **大盤層級**的建議(盤前預判、天氣) → `_ovTrend` 是個股趨勢,不適用
- **條件本身已含 `trend === 'bull'` 或「站上月線」** → 空頭時根本不會觸發,天然安全
  (例:`_calcBullBearScan` 需 ratio≥0.65;回檔加碼需 `C >= ma20`)

#### 🧭 V72.1.5 籌碼頁:把三張卡的結論壓成一行(`_chipConsensusLine`)
籌碼頁最上方已有主結論卡(🐘 大戶籌碼總結),但下面**明日劇本(分點今日)/
籌碼乾淨度 / 主力動向(分點近5日)** 各自也在下結論 → 使用者要自己比對三張卡。
→ 主結論卡裡加一行「🧭 其他籌碼指標怎麼說」,壓成一句 + 小標籤列。

⛔ **三條鐵則**:
- **每一項都要標時間範圍**(`法人近10日` / `分點今日` / `分點近5日`)——
  這正是 V72.1.3「今日 vs 近5日 被當成同一件事」的教訓。
- **籌碼乾淨度⛔ 不計入多空票數** —— 它是「車廂擠不擠」不是「方向」,
  只在 `clean < 45` 時另外提醒「容易被洗,倉位放小」。
- ⛔ **不開新卡、不改任何子指標的數字**(硬統一會失真);只做「收斂 + 點出分歧」。
  分歧時給**可操作的判準**:「要連續 2~3 天同向才算數,別只挑順眼的那個看」。
- 沒有分點資料 → 整行不顯示(⛔ 不留空殼)。
測試 `scripts/test_kchip_audit.mjs` ④(合計 43 條)。

##### ⚠️ V72.1.6 我自己在上一版就違反了自己的鐵則(收回來)
V72.1.5 的 `_chipConsensusLine` 在方向一致時寫「**可信度較高**」——
那是**預測性主張**,而**籌碼訊號的預測力從來沒驗證過**。

⭐ 實測資料深度(2026-08-04,掃 300 檔):
| 欄位 | 非零天數中位 | 最早日期 |
|---|---|---|
| `foreign_net` | **60** | 2026/04/29 |
| `trust_net` | 21 | 2026/05/04 |
| `margin_balance` | 56 | 2026/05/14 |
⚠️ 欄位本身回溯 763 天(約 3 年),但**值幾乎都是 0/None** ——
⛔ **「欄位存在」不等於「有資料」**,查深度一律看**非零**筆數。

→ 60 個交易日、且全落在同一段下跌行情 → **樣本不足以回測**。
改成純事實描述(「方向一致 —— 至少沒有互相矛盾」)+ 固定免責:
「預測力還沒驗證過…這裡只是把今天的籌碼長什麼樣講清楚,**不是勝率**」。

⭐ **為什麼 K線給得出勝率、籌碼給不出**:
K線只需要**股價**歷史(有 3 年)、籌碼需要**法人買賣超**歷史(只有 3 個月)。
⚠️ 累積滿 1 年後回來重跑,有效果才計分。

⚠️ 這條同時是「**自己做的東西也要用同一把尺檢查**」的實例 ——
我剛把規則寫進 CLAUDE.md,下一版就自己違反了。


#### 🐛 V72.1.7 「跌破前低 **--**」—— 缺值直接印給使用者看
`renderChuKbarVerdict` 的 `recentLow`(波段低點)可能是 `null`,
原本直接 `nf(recentLow)` → 卡上印出「跌破前低 **--** 就撤」,
**使用者根本不知道要撤在哪**(實測 2327 就長這樣)。
→ 退回「近 20 日低」(一定算得出來),⛔ 但要**改名**,別把兩種低點混為一談;
  兩個都沒有時改講「跌破你自己設的停損就撤」。

⭐ **巡邏指令**(找「動詞 + 可能為 null 的價位」):
```bash
grep -nE '(跌破|站上|守住?|突破|回測|停損|目標)\s*\$\{(nf|nfP|f2|fmt)\(' index.html
```
⚠️ 但**靜態掃描不夠** —— 真正可靠的是**實際渲染後掃 innerText**
找 `(跌破|站上|守|突破|回測|停損|目標)[^。;,]{0,10}(--|—)`。
V72.1.7 實測掃過 `chuVerdictCard` / `sixMeridianCard` / `trendCommandCard` /
`kbarHalfTactics` 四張,修完後乾淨。

#### ⚠️ V72.1.8 測試⛔ 不可綁死「會浮動的資料狀態」
`test_kchip_audit` 原本直接斷言「2327 今天**沒有**正期望值訊號」——
成績表一更新(全市場回測後 2327 多了一個 `exp>0` 的),那三條測試就**假失敗**。
⭐ 正解:用 **stub `_sigEdge`** 控制,**每種情境各驗一次**
(沒有正期望值 / 只有風險提醒 / 有正期望值 + 空頭),
⛔ 別假設實際資料一定落在某個分支。
⚠️ 這跟「實跑驗證要先確認輸入真的觸發目標路徑」是一體兩面:
   **前者防空過、後者防假失敗**,兩個都要。

⭐ **通用教訓:同一個修法要掃過所有頁面** —— V72.0.7~V72.0.9 的「講反話」犯 4 次、
V72.0.8 的「同名不同義」犯 2 次,都是因為只修了發現的那一處。
**改這類問題時,一律 grep 全檔找同類呼叫點。**
測試 `scripts/test_kchip_audit.mjs` 19 條(全部用真實資料,且先斷言「測資真的重現了情境」)。

### 💰 V72.0.3 ⭐⭐ 最重要的一次自我修正:**勝率高 ≠ 會賺錢**
巨人傑逐字稿一句話戳破前一版的盲點:**「賺賠比遠比勝率重要」**。
V71.9.9~V72.0.0 的分級**只用 `_winRateP` 的統計顯著性**(= 只問「贏的次數是不是比隨機多」),
完全沒問「贏的時候賺多少、輸的時候賠多少」。

`signal_backtest.mjs` 已補算(從既有 10 日報酬分布直接算,零額外回測):
```
aw = 贏的那些的平均漲幅 ・al = 輸的那些的平均跌幅(取絕對值)
payoff(賺賠比) = aw / al
exp(期望值)   = 勝率×aw − 敗率×al        ← 每出現一次平均賺/賠多少 %
```
`_SIGNAL_EDGE` 每筆從 6 欄擴成 **8 欄** `[grade, n, e10, w10, p, e20, payoff, exp]`;
`_sigEdge()` 回傳多 `payoff` / `exp` 兩個欄位。

🚨 **實測結論(這才是重點)**:**42 個 A 級訊號裡,36 個期望值是負的。**
→ 那些訊號「贏的次數確實比隨機多」(所以 p 值過關),但**輸的時候輸更大**,
  加總起來還是賠錢。⛔ **統計顯著 ≠ 值得進場**,這兩件事一定要分開講。

⛔ **三條鐵則**:
- **顯示層必須同時給勝率與期望值**,⛔ 不可只給勝率(那正是前一版的錯)。
  期望值為負一律**灰字**,別用綠色(綠在台股是「跌」,但這裡是「不值得」→ 用灰,不參與紅綠語意)。
- ⛔ **不可因為期望值負就把訊號刪掉/從清單藏起來** —— 同 C 級的道理,
  風險提醒型訊號本來就不是拿來賺錢的。⚠️ 這條講的是**顯示**;**計分**是另一回事,見下。
- ⚠️ 期望值**未扣交易成本**(來回約 0.44%,當沖 0.25%)→ 實際門檻比表上更高;
  文案要寫明,別讓 +0.1% 的訊號被當成有賺頭。

#### 💰 V72.0.6 把上一版留下的打架修掉:**計分**也要看期望值
V72.0.3 只改了顯示 → `_entryCheckup` 的計分**還是只看分級**(A 全額),
於是「36 個常對但不賺的 A 級訊號」照樣把進場分數拱高 —— **自己造成的邏輯打架**。
- 看多係數改成 **分級 × 期望值**:`_gw[grade] × _expK(e)`,`_expK` = 期望值 ≤0 給 0.7。
  實測 2330:bull 4.0 → 2.8、score 61 → 53。
- ⛔ **看空/警示仍不乘任何係數**(多空不對稱那條沒變)。
- 🐛 同時修一個既有排序 bug:`_sigByGrade` 原本一律 `b.e10 - a.e10`(超額報酬遞減)。
  對看多是對的,但**看空訊號後面漲最多 = 最沒兌現**,舊寫法卻排最前面。
  改用 `_deliver(x)`:看多用 `+exp`、看空/警示用 `−exp`,兩邊都變成「越大 = 講對越多」;
  `exp` 拿不到時退回 `e10`,⛔ 不可整筆濾掉。
- ⚠️ **測試踩到「空過」**:第一版實跑斷言用合成等差 K 線 → `bull` 恆為 0,
  斷言變成永遠綠但什麼都沒驗到。改用**真實 `data/2330.json`** 並往回掃切點
  (⛔ 不寫死切點 —— 哪天有訊號會隨資料變)。
  ⭐ 通用:**任何「實跑驗證」的斷言都要先確認輸入真的觸發了目標路徑**,
  否則它只是一顆假的綠燈。測試 `test_sigedge.mjs` ⑫⑬(合計 44 條)。

### 🎯 V72.1.0 「今天最該看的一件事」—— 把實測成績放到第一眼
使用者原話:「**只要給我最好、勝率最高的資料**,不要老是所有資料都打出來」。
查下來根因是**陷阱 #32 的再犯**:`_SIGNAL_EDGE` 的實測訊號只出現在
**總覽→進場**頁籤,使用者連問兩次都沒看到 → **功能做好了 ≠ 使用者找得到**。

`_ovTopEdge(data, sym)` 挑**期望值最高的一個**放進「⭐ 重點判讀」最上方(常顯區):
- ⛔ **只放一個** —— 整份搬過來就又變資訊爆炸(違反「合併不重複」鐵則);
  完整清單仍在進場頁籤,卡上有指路。
- **看多必須 `exp > 0`** 才准上第一眼(常對但不賺的不該佔版面,V72.0.3 的教訓)。
- ⛔ **看空/警示不設期望值門檻**(風險提醒不打折,同 V72.0.6 多空不對稱)。
- `_ecCache` 30 秒快取 —— `_entryCheckup` 要跑 40 個偵測器,同一次渲染別跑兩遍。

⚠️⚠️ **期望值對多空的意思是相反的,⛔ 絕不可用同一句話講**(實測時抓到):
- 看多 `+0.6%` = 這樣進場平均賺 0.6%
- 看空 `−1.4%` = 訊號後平均**跌** 1.4% = **這個警示很準**,⛔ 不是「你會賠 1.4%」
→ 看空改寫成「訊號後 10 日平均 −1.4%(跌得越多代表這個警示越準)」
  + 明寫「**這是風險提醒不是賣出指令**」。
⚠️ 圖示也要分:**✅ 在燈號鐵則是「安全/通過」,⛔ 不可拿來標警示訊號**(改用 ⚠️)。
測試 `scripts/test_topedge.mjs` 26 條(④⑤ 把這兩條釘死)。

### 💳 全市場融資維持率(V72.0.3)—— ⛔ 是**推估**,不是官方值
逐字稿【130% 融資反彈策略】:整戶維持率跌破 130% → 券商電腦自動強制斷頭 → 浮額清乾淨 → 常見 V 型反彈。
`miner.py::compute_market_margin_health()`(⛔ 放在 `compute_market_pb_percentiles` **之前**,同陷阱 #9):
```
維持率 = Σ(融資餘額 × 收盤價) ÷ Σ(融資餘額 × 推估成本 × 0.6)
推估成本 = 該股「融資餘額增加日」的加權均價   ← 這一步是推估的來源
```
寫進 `market_stats.json` 的 `margin` + `margin_hist`(500 筆歷史);`n_ok < 200` 不寫(守門)。
**實跑結果:127.3%(已在斷頭區),1,827 檔有效 / 671 檔略過,融資現值 9,948.6 億 vs 推估金額 7,812.6 億。**

⛔ **四條免責必須留在卡片上,別為了好看拿掉**:
1. **是推估不是官方公布值** —— 成本用「融資餘額增加日均價」反推,是**族群平均**不是任何人的成本;
   而且只算「餘額增加日」→ 系統性**偏高**(沒算到攤平/減碼)。
2. **融資資料只回溯到 2026/05** → **看趨勢方向**,⛔ 別對絕對值太認真。
3. ⛔ **他宣稱的「26 年 85% 勝率」我沒有驗證過** → 卡上**不出現那個數字**,教學裡寫明「不是我算的、不敢背書」。
4. ⛔ **跌破 130% ≠「跌破就該買」** —— 那只是「賣壓正在被強制清出」的觀察;
   教學要寫「不要第一天就衝、等長下影線/紅 K」「2~3 年才一次,好市況別用,不然變接刀子」。

#### 🐛 V72.1.1 它**從上線到現在一次都沒產出過**(被 P/B 卡住)
實測 2026-08-04 讀 gh-pages:`market_stats.json` **只有 118 bytes、只有 `pb` 沒有 `margin`**。
根因:margin 那段被**巢狀在 `if pb_pct:` 裡面** → P/B 分位抓不到 fundamentals 時,
整段走「保留既有值」,融資維持率完全沒機會寫 —— 即使它自己算得出來
(`compute_market_margin_health()` **不收任何參數**,只讀 `margin_balance` + 收盤價)。
⚠️ 症狀極難察覺:**檔案在、workflow 全綠、零錯誤訊息,就是少一半內容**(同陷阱 #9)。

⭐ **通用鐵則:兩個互相獨立的指標,⛔ 不可綁在同一個 `if` 裡** —— 一個失敗會拖累另一個。
修法:各自成功各自寫,用 `_ms_dirty` 旗標決定寫檔;
算不出來寫 `margin_error`(陷阱 #22),成功時要 `pop` 掉舊的 error(否則永遠掛著假警報)。
實跑確認 **127.9%・1,827 檔有效**。測試 `scripts/test_marketstats_indep.py` 19 條
(⑥ 用 `inspect.signature` 斷言它不收參數 = 證明不依賴 fundamentals;⑦ 實跑真資料)。

📍 **併進 `#bubbleCrashCard`(泡沫風控面板)的 `#marginHealthBox`,⛔ 沒開新卡。**
測試 `scripts/test_marginhealth.mjs` 22 條。

### 🎯 V72.0.4 「大盤 vs 你手上那檔」—— ⛔ 不要去推估台積電權重
逐字稿:「加權指數幾乎就等於台積電」。這句話回答的是使用者最常問的
**「大盤漲,為什麼我的股票沒漲?」**。

⛔ **第一個直覺(推估台積電權重)是錯的路,別走**:
官方權重用**流通股數 / free float**,我只有 `tdcc_holders.json` 的**總股數**。
實測我自己加總 2,676 檔市值 = **150.7 兆、2330 佔 37.95%**,但那含**上櫃 + ETF**,
跟官方口徑不同 → 推出來的數字會錯,而且錯得**很難察覺**(看起來很合理)。

⭐ **正解:「中位數個股漲跌幅」** —— 零假設、零推估,而且它才是
「你隨便挑一檔最典型會遇到的結果」。採礦端 `build_breadth_history()` 一起算:
- `med` = 當日全市場個股漲跌幅中位數(排除 ETF,同家數統計口徑)
- `idx` = 當日加權指數漲跌%(採礦端讀 `^TWII.json` 一次,⛔ 前端別自己算 —— 有幽靈棒/零量列要濾)
- 兩欄都走**既有的 schema self-heal**(陷阱 #15)→ 250 日歷史一次補齊,上線當天就有圖看

📊 **實測(248 個交易日,真資料)**:
**大盤平均每天贏中位數個股 +0.40pp、60% 的天數大盤贏。**
⭐ 這正好解釋了 `_SIGNAL_EDGE` 的基準勝率為什麼是 **36% 而不是 50%** ——
**兩件事是同一個現象的一體兩面**,顯示層有互相引用(⛔ 別把其中一邊改成 50%)。
極端例:7/21 大盤 +4.20% / 中位數 +1.12%(差 3.08pp);7/17 大盤 −6.47% / 中位數 −3.18%。

⛔ **三條鐵則**:
- **落差(gap)⛔ 不可用紅綠上色** —— 它是「方向差」不是漲跌,用紅綠會跟台股語意打架
  (同燈號鐵則)。指數與中位數各自仍照台股色,只有 gap 那格用中性灰。測試 ④ 有釘。
- 盤中優先用 `_liveQuotes` 現算(比收盤檔新),但**快照 < 500 檔就不用**(退回收盤值);
  ⛔ 盤中拿不到 `_taiexTodayPct` 時整個回 null,**不可拿收盤的 idx 配盤中的 med**(測試 ⑧)。
- 併進 `renderMarketBreadth`(市場廣度卡),⛔ **沒開新卡、沒新增 DOM id**。
測試 `scripts/test_medgap.mjs` 35 條。

### 🔮 V72.0.5 美股期貨「有價無方向」—— 陷阱 #22 的第二次犯案(這次是自己犯的)
逐字稿「要看海外期貨」→ 去對自己的資料,抓到 **`es_fut` / `nq_fut` / `ym_fut` 的
`*_chg_pct` 長期都是 `None`,而 `*_error` 也是 `None`**(實測 2026-08-04 gh-pages)。

⭐ **「不給方向」本身是正確的設計,⛔ 別去「修」它**:
`_pick_live_vs_settle` 的 `'inprogress'` 分支 —— 盤中價 ≈ 日線末根 close 時,
代表那根日線還在跑、拿不到真正的「上一個結算」→ 硬算會給**反方向**
(2026-07-30 使用者拿籌碼K線對照抓到的那次)。**寧可不給方向,也不給反的。**

⛔ **錯的是「不給就什麼都不說」**,兩層都犯:
1. **採礦端**回 `err=None` → 從 JSON 零線索,分不出「抓不到」vs「刻意不給」。
   修法:回一段原因字串,**並把判斷用的原始數字一起寫進去**
   (盤中價 / 日線末根收盤+日期 / 兩者差幾個基點)—— 沒有那幾個數字永遠查不出真因。
2. **前端**只顯一個光禿禿的價位 → 卡片下方「🔮 期貨=隔日開盤風向」那句等於失效。
   修法:有價無方向時標「**・方向待確認**」+ title 說明;
   ⛔ 那四個字**不可用紅綠**(它不是漲跌)。
   ⚠️ macro_miner 的註解本來就寫「前端會標『盤中價・漲跌待確認』」——
   **但前端從來沒實作過**。⭐ 通用:註解寫的跨層契約要有測試釘住,否則就是空頭支票。

測試:`scripts/test_yf_no_regress.py` ⑱⑲⑳(採礦端)+ `scripts/test_futdir.mjs` 17 條(前端)。

#### ✅ 順便回答「觀察日韓中美期貨」:多數已經有了,缺的那個沒有免費源
| 他說的 | 我的現況 |
|---|---|
| 美股期貨 | ✅ `ES=F` / `YM=F` / `NQ=F` 三支都有(方向見上) |
| 日 / 韓 / 港**現貨** | ✅ `^N225` / `^KS11` / `^HSI` 每輪都抓,且有「日期不可倒退」守門 |
| 亞洲股指**期貨**(日經期/A50) | ❌ **不做** —— yfinance 沒有可靠的免費 ticker,沙箱也連不到無法驗證 |

⛔ **不要為了「補齊清單」去加一個猜的 ticker**:加下去只會多一格永遠 null 的資料,
而且台股 09:00~13:30 期間日股/港股**現貨本來就在開盤**(東京 08:00~14:00 台北時間),
`^N225` 已經涵蓋;隔夜方向由美股期貨負責 → **邊際價值很低,風險卻是多一格空白**。

#### ⏳ 「美國數據時間差」—— ⛔ 沒有資料源,不做
逐字稿另一段講「美國經濟數據晚上公布,台指期夜盤反應,但隔天台股只跟一半」。
要做需要**美國經濟數據行事曆**(公布時間 + 預期值 + 實際值),**目前沒有免費結構化來源**。
盤前體檢已有 FOMC 等重大事件提示,到此為止。⛔ 別用 AI 生成行事曆(會幻覺日期)。

#### 🔧 V72.0.4 順手修:K線頁教學是**第三份**複製品,數字停在舊版
`renderKbarTactics` 的「ⓘ 怎麼看」原本是**內嵌 alert**,寫「250 檔 / 122 個訊號 / A=29」,
但 `_SIGNAL_EDGE_META` 早就是「500 檔 / 128 個 / A=42」→ **兩邊各說各話**。
改成呼叫共用的 `_showEdgeHelp()`(數字全從 meta 帶入)。
⭐ 這正是「教學兩頁共用同一份」那條鐵則在防的東西 —— **複製一份文案 = 保證有一天會不同步**。
`test_sigedge.mjs` ④ 已改成驗**共用那一份**,並交叉驗證「教學裡的檔數/分級數 == meta」。
⚠️ 該測試的 ③ 用 `strip()` 先拿掉否定形才比對 —— **這是本 session 第 5 次踩到同一個坑**:
   「⛔ 那不是「跌破就該買」」這種**正確的免責寫法本身含有被禁的字串**。
   ⭐ 通用:**任何「禁止出現某句話」的測試,都要先 strip 掉否定形**,
   否則你會被自己寫對的免責句擋下來,然後很想把測試放寬 —— 那才是真正的危險。
   踩過的清單(寫測試前先掃一遍):**「不是買賣訊號」含「賣訊」**・
   **「沒有推估台積電的官方權重」含「權重」**・「不是「會賺」」含「會賺」・
   「實測不成立:破月線是買點」含「是買點」。第 6 次是 `test_medgap.mjs` ⑨。

### 🧪 三支探針(只讀 data/、不打 API、不花額度,隨時可重跑)
| 腳本 | 回答什麼 | 何時該重跑 |
|------|---------|-----------|
| `sector_flow_probe.py` | 板塊「偷布局」訊號有沒有用 | 外資資料滿 1 年後(目前只回溯到 2026/05,僅 18 個獨立事件) |
| `edge_probe.py` | 8 個機構因子在台股有沒有效 | 走完一次空頭後(目前結論來自 3 年多頭,低波動/反轉/流動性三個因子當時是反向的) |
| `broker_habit_probe.py` | 隔日沖分點有沒有慣性(V71.7.x) | `data/chips/*.json` 的 `hist` 累積到 1~2 個月後(目前只有 7~8 天) |
| `floor_probe.py` | 「跌到地板 95% 會反彈」成不成立(V71.8.9) | 走完一次真正的空頭後(目前 2~3 年、空頭段有限) |
| `tdcc_probe.py` | 「兩上兩下」(大戶↑散戶↓融資↓)有沒有邊際(V71.9.0) | `tdcc_holders.json` 累積滿 1 年後(目前只有 13 週) |
| `cb_probe.py` | 可轉債「離轉換價多遠」有沒有預測力(V71.9.1) | 累積到有 CB 歷史快照後(目前只有今天的快照,有倖存者偏誤) |
| `ma20_probe.py` | 「跌破月線就停損」到底對不對(V71.9.2) | 走完一次真正的空頭後(大盤跌破事件目前只有 6 次) |
| `short_probe.py` | 券資比/軋空有沒有邊際(V71.9.2) | 融資券滿 1 年且涵蓋一段多頭後 |
| `trust_probe.py` | 投量比(投信買超÷成交量)有沒有預測力(V71.9.5) | `trust_net` 滿 1 年後 |
| `volstall_probe.py` | 「爆量漲不動/跌不動」日線版(V71.9.8) | ⛔ 已驗**不成立** |
| `volseq_probe.py` | 真正的「連次量」(盤中第N次爆量)分K版(V71.9.8) | ⛔ 已驗**不成立**;走完一次趨勢盤後可重驗 |
| `turnover_probe.py` | 週轉率 × 昨日漲跌幅(當沖三大指標之一,V72.0.1) | 累積更多資料後;目前 22 萬事件已足 |

### ⚡ 當沖三大指標盤點(V72.0.1)—— 他說「週轉率、連次量、籌碼」
| 指標 | 我的狀態 |
|---|---|
| 連次量 | ⛔ **驗過兩次都不成立**(日線 `volstall_probe` + 真分K `volseq_probe`),不做 |
| 籌碼 | ✅ V71.9.4(追價買/低檔吃貨)+ V71.9.6(隔日沖占比/手牽手)|
| **週轉率** | ✅ V72.0.1 補上 —— 資料本來就有(`tdcc_holders.json` 的 `t` = 總股數,零採礦)|

#### 📊 週轉率實測(2,402 檔、227,412 事件,對照組次日勝率 44.3%)
❌ **他說「昨天小漲小跌 + 今天高週轉 = 今天不錯」→ 不成立**(次日 −0.09~−0.20pp)。
❌ 單看週轉率也**幾乎沒有鑑別力**(最好與最差桶只差 0.17pp)—— 跟他自己說的「要嘛很好要嘛很差」一致。

⭐ **真正有邊際的是「漲停隔日動能」,而且週轉率決定強弱**:

| 昨漲停 × 今日週轉率 | n | 次日邊際 | 次日勝率 |
|---|---|---|---|
| 低 <1% | 1,232 | +0.82% | 53.5% |
| **中 1~3%** | 1,130 | **+1.54%** | **56.7%** |
| 高 3~8% | 993 | +1.13% | 56.1% |
| 極高 ≥8% | 720 | +0.78% | 53.9% |

⭐ 他「漲停後要看是不是在出貨」**那半句是對的**(≥8% 明顯衰減);「小漲小跌比較好」那半句不成立。
⚠️⚠️ **只有次日有效** —— 3 日、5 日邊際轉負(+1.54 → +0.78 → −0.19)。
⛔ 文案必須寫明「別當波段理由」,測試 ② 四條把這件事釘死。未扣當沖來回成本 0.25%。
已落地:`_limitUpMomentum` / `_limitUpMomentumHtml`,當沖頁**置頂**、條件觸發(沒漲停/換手不高完全不顯)。
測試 `scripts/test_limitup.mjs` 28 條。

#### 🫗 買盤竭盡(籌碼版,V72.0.2)—— ⛔ 目前只做描述、不下方向
他的原始機制是**盤中每 5 秒內外盤 PK**、多方連 N 次獲勝後出現「第一次內盤大量」。
沒有逐秒序列(連次量已驗兩次不成立),但 `tick_flow.json` 有**當日真實逐筆**聚合:
`out`(外盤/主動買)・`in`(內盤/主動賣)・`bb`(大單買)・`bs`(大單賣)。
→ 做它的本質:**外盤佔優(小單追買)+ 大單淨賣(大戶倒貨)** = 買盤竭盡;反向 = 賣盤竭盡。
⭐ 他自己就說「**不能看到買盤竭盡就空,還要研究籌碼**」,所以直接把籌碼結構攤開。

⛔ **預測力尚未驗證**:`tick_flow.json` 是每日覆蓋的快照、沒有歷史。
V72.0.2 起 `tick_flow_miner.py` 開始累積 **`tick_hist.json`**(每日 out/in/bb/bs,
保留 250 個交易日,約 1.2MB)。⚠️ 那是**累積型**檔案 →
workflow 必須**先從 data 分支還原**再跑(`git show` + `[ -s ]` 驗非空,同 V49.4 教訓),
且要同時推 gh-pages 與 data 兩個分支(否則被 daily_miner orphan force-push 抹掉)。
→ 累積約 60 個交易日後跑回測,**有效果才計分**;在那之前顯示層:
  ・只做事實描述、⛔ 不下方向、不計分 ・文案必須明寫「還沒驗證過」「不是買賣訊號」
測試 `scripts/test_buyexhaust.mjs` 26 條(⛔ 把「不可下方向」釘死)。

#### ⚠️ 更新 `_SIGNAL_EDGE` 時踩過的坑(V72.0.2)
用 regex 換整段時**只換到 meta、沒換到資料表** → meta 說「500 檔、A=42」但資料還是 250 檔那版。
這種不一致**最難發現**,因為兩邊各自看起來都對。
→ 正解:`_SIGNAL_EDGE` 是**單獨一行**,用行號整行替換,別用跨行 regex。
→ `test_sigedge.mjs` ① 已加**交叉驗證**:meta 的 A/B/C 數量必須跟資料表實際數量一致。

### 📊 連次量:日線版實測**不成立**,⛔ 別再做一次(V71.9.8)
逐字稿【當沖心法】:「用連次量抓轉折,**空在爆量漲不動、買在爆量跌不動**」。
「連次量」本身是**盤中**概念(當天第幾次爆量),沒有分 K 歷史 → 無法直接回測。
所以先把他的**原則**搬到日線驗(64,990 個爆量事件,量 ≥20 日均量×2,報酬扣同期加權):

| 型態 | n | 1 日 | 5 日 | 5 日勝率 |
|---|---|---|---|---|
| 爆量漲不動(衝高被壓、收低端)| 7,109 | −0.12% | −0.92% | 41.8% |
| 爆量跌不動(殺低被拉、收高端)| 8,495 | −0.46% | −1.51% | 38.0% |
| 其他爆量日(對照)| 11,495 | −0.24% | −1.01% | 39.8% |

❌ **兩個方向都不成立**:「漲不動」比對照組 **+0.14pp**(他說要空,實際上還略好一點);
「跌不動」**−0.45pp**(他說要買,實際上略差)—— 都在雜訊內,而且**方向跟他說的相反**。
⛔ **不上任何日線版連次量訊號**。

#### ⭐ 分 K 版也驗了(`volseq_probe.py`,2026-08-03 Actions 實跑)—— **一樣不成立,而且更明確**
不能只用日線就下定論(他講的本來就是盤中「第幾次爆量」),所以用 Shioaji `api.kbars`
抓 **101 個交易日**的 1 分 K、16 檔(大中小型+高低波動)重驗。
「連次量」照他的定義實作:當天分 K 依量排序,第 N 大 = 第 N 次量;
⛔ 排除 09:00~09:04(開盤第一根量必然最大,是**結構性必然**不是訊號)。
**報酬全部扣掉當沖來回成本 0.25%**(ORB 鐵則)。持有 10 分鐘:

| 第N次量 | 型態 | n | 10 分淨中位 | **10 分勝率** |
|---|---|---|---|---|
| 1 | ⭐ 爆量跌不動(他說**買**)| 110 | −0.250% | **18.2%** |
| 2 | ⭐ 爆量漲不動(他說**空**)| 204 | −0.250% | **24.5%** |
| 2 | ⭐ 爆量跌不動(他說**買**)| 253 | −0.250% | **20.9%** |
| 3 | ⭐ 爆量跌不動 | 276 | −0.469% | **20.7%** |
| 5 | ⭐ 爆量跌不動 | 315 | −0.250% | 30.2% |
| 1 | 量價**同漲**(對照·同樣做空)| 160 | **+0.025%** | **51.9%** |
| 2 | 量價**同漲**(對照·同樣做空)| 398 | −0.008% | 49.0% |

❌ **三個結論**:
1. 他的兩個訊號**每一格都是負的**,而且 **8 個 stall 桶的勝率全在 18~32%**;
   而**對照組(量價同向)勝率 49~52%** → 不只是「沒有邊際」,是**明顯比對照組差**。
2. 多數桶的淨中位剛好 = **−0.250%**(= 成本),代表**毛報酬中位是 0** ——
   10 分鐘內價格根本沒動,方向性不存在,只是穩定被成本吃掉。
3. ⛔ **不建 volseq_miner、不上任何連次量訊號**。

#### ⭐⭐ V2:依「該股波動率」分三組重驗(使用者質疑「他是不是只針對特定股票」)
⚠️ **第一版的方法缺陷**:把 16 檔 pooled 在一起測 = 假設所有股票一樣。
但他明說「標的要**大波**,不要中華電信、不要中鋼,太牛」,而實測年化波動率發現
第一版用的 **2330/2317/2454 都落在低波動組** → 等於拿他說「不要碰」的股票測他的方法。
→ 改成三組各 12 檔(日成交額 >3 億才有分 K 流動性),**同時輸出毛報酬與淨報酬**。

| 組別 | 型態(第1~5次量彙整) | 毛 10 分 | 淨 10 分 | 10 分勝率 |
|---|---|---|---|---|
| ⭐ 高波動(93~126%) | 爆量漲不動(他說空) | −0.10 ~ −0.00% | −0.25 ~ −0.35% | 30~42% |
| ⭐ 高波動 | 爆量跌不動(他說買) | −0.27 ~ +0.00% | −0.25 ~ −0.52% | 18~31% |
| ⭐ 高波動 | **量價同漲(對照·做空)** | **+0.19 ~ +0.25%** | −0.07 ~ **+0.00%** | **47~50%** |
| 🐢 低波動(15~46%) | 他的兩個訊號 | **全部 ±0.000%** | −0.250% | **12~17%** |

⭐ **三個結論**:
1. ✅ **「股票類型有差」這個直覺是對的,而且差很大**:低波動組**毛報酬幾乎全是 0.000%**
   —— 訊號出現後價格根本不動(不是被成本吃掉),那組**任何當沖策略都不可能成立**。
   高/中波動組才有非零毛報酬。→ 他說「不要碰太牛的股票」**這句話本身是對的**。
2. ❌ **但即使限定在他說適合的高波動股,他的訊號還是不成立,而且輸給對照組**:
   高波動組「量價**同漲**→做空」毛 +0.250%、勝率 50.0%;
   而他說的「爆量**漲不動**→做空」毛 −0.100%、勝率 30.7%。**方向剛好相反**。
3. ➖ 全表 44 格裡只有 1 格淨正(中波動 × 第2次量 × 量價同漲做空,淨 +0.034%、n=302)。
   ⛔ **這不算證據** —— 測 44 格本來就會有 2 格左右純靠運氣看起來不錯(多重比較),
   而且同一型態在高波動組是 +0.000%、低波動組是 −0.250%,**跨組不一致** → 不做。

⚠️ 已知限制(誠實寫下,別過度解讀):① 分 K 只有 101 天,涵蓋的行情型態有限,
走完一次明顯趨勢盤後可重跑;② pooled 結果會蓋掉個股差異,但每桶 n=110~315 分到 16 檔後
每檔只剩 7~20 筆,**樣本不足以做個股拆解** → 不宣稱「某些股票可以用」。

### 🧙🗺️ 關鍵分點 + 地緣分點(V71.9.8)
- **關鍵分點**(低檔大買/高檔大賣):看分點均價落在該股**自己價格區間**的位階,
  ⛔ 不寫死價格門檻。跟「券商勝率榜」問的不是同一件事(勝率榜=買了會不會漲,這個=買在哪個位置)。
- ⭐ **歷史深度的解法**:逐日快照存 60 天要多花約 **157MB**(實測每天每檔 ~1,100 bytes × 2,384 檔),
  GitHub Pages 只有 1GB(已用 388MB)→ 存不起。改成採礦端**增量聚合** `bstat`
  (每家分點只存 [累計淨股數, 累計金額, 出現天數] + 交易日清單),約 **17MB**、**深度無上限**。
  首次跑會用現有 `hist`(12 天)當**回算種子**,不用從 0 開始等。前端 bstat 不足 15 天時退回 20d periods。
- **地緣分點**:公司縣市來自 `company_geo.json`(TWSE `t187ap03` 住址欄,**跟產業別同一支 API、零額外額度**);
  分點縣市從分點名解析。⛔ **有歧義的地名一律不對照**(中山/中正/信義/民權/和平/建國… 多個縣市同名),
  寧可判不出來也不判錯。⚠️ 地緣**未回測過預測力**,文案標明是參考資訊。
測試 `scripts/test_keygeo.mjs` 31 條(含 7 個歧義地名各自斷言「不對照」)。

### 👩 投量比:⛔ 只做單位換算,不給方向(V71.9.5)
逐字稿他更正常見誤用:「坊間一堆**投本比**(占**股本**)…但這是占**成交量**,那叫**投量比**」,
並舉例「成交量 205 張、投信買 40 張 → 上不了排行榜,但佔了 **20%**」。

⭐ **對本專案的好消息**:投量比 = `trust_net ÷ volume`,兩個欄位**都已經有了,零採礦**;
   反而他反對的「投本比」需要股本、要另外採礦 —— ⛔ 別回頭去做投本比。

⛔ **但預測力驗不了**:`trust_probe.py` 實測發現 `trust_net > 0` 的列**全部落在 2026 年**
(全市場 169 萬列裡只有 **8,818** 列),每桶不到 200 筆 → 連分桶比較都做不出來
(跟 `short_probe.py` 券資比同一個死因:法人/融資券欄位都是近期才開始存)。
→ 所以 `_trustVolRatioNote()` **只做單位換算、不計分、不下方向**,
  並在教學裡明寫「還沒驗證過預測力、不是買賣訊號」。
⭐ 通用原則:**「邏輯上就成立的換算」可以直接顯示**(40 張佔 205 張的 20% 是算術事實),
  **「A 高會漲」這種預測性主張一定要先實測**。兩者要分清楚,別混在同一句話裡。
測試 `scripts/test_trustvol.mjs`(⛔ 把「不可正面下方向」釘死)。

### 📉 「跌破月線停損」實測(V71.9.2):幾乎沒有鑑別力,而且 69% 是假跌破
⚠️ 這條特別重要,因為它檢查的是**本專案自己在做的事**。`ma20_probe.py` 用 2,227 檔、
**38,923 次跌破**實測(報酬扣同期加權、10 日去重):

| | n | 5 日 | 10 日 | 20 日 | 60 日 | 20 日勝率 |
|---|---|---|---|---|---|---|
| 跌破月線當天 | 35,622 | −1.06% | −2.08% | −4.14% | −12.18% | 31.4% |
| 月線之上(對照)| 40,189 | −1.10% | −1.99% | −4.03% | −11.90% | 33.9% |

⭐ **四個結論**:
1. **跌破組只比沒跌破差 0.11pp(20 日)** → 拿「跌破月線」單獨當停損理由,依據非常薄弱。
2. **假跌破率:5 日內站回 55.3%、10 日內 69.2%** → 逐字稿說的「你不知道停損多少次」**成立**。
   再加上來回成本約 0.44%,每次跌破就砍 = 穩定漏錢。
3. ❌ 但他說的「低檔破月線反而是買點」**不成立**:低位階 −4.27% 比高位階 −3.65% 還差。
   ⛔ 別照抄那句,更別做成買訊。
4. ⏳ **大盤自己跌破月線只有 6 次 → 樣本不足,所以 regime 的「破月季線降級」維持不動。**
   ⭐ 通用鐵則:**個股的統計結論不可越推到指數**(指數是一籃子、雜訊被平均掉,均線行為本就不同)。

已落地(⛔ 沒開新卡,只改文案):盤中 `dn20` 推播從「中線停損警告」改成
「⚠️ 提醒不是賣訊:實測 69% 會在 10 天內站回」;模組 C 教學卡補上三個數字 + 成本 + 建議。
測試 `scripts/test_ma20honest.mjs`(含「引用後打臉的寫法可以、主張不行」的判別)。

### 💳 可轉債轉換價實測(V71.9.1):門檻是 100 不是 120,而且**只有高位階才成立**
逐字稿【哥有籌必爆S2】第2集把公式講死:`parity = 股價 ÷ 轉換價 × 100`;
公司發 CB 最想要「不還錢」→ 拉過轉換價讓人換股。`cb_probe.py` 用 306 檔、9,977 事件實測:

| 高位階(近一年 ≥67%)× parity | n | 20 日中位 | 60 日中位 | 60 日勝率 |
|---|---|---|---|---|
| <100 還沒過轉換價 | 762 | −0.29% | −2.87% | 45.2% |
| 100~120 剛過 | 383 | −5.76% | −14.92% | 24.0% |
| **120~150** 他說的出貨區 | 198 | **−7.20%** | **−17.57%** | 24.7% |
| ≥150 大幅超過 | 171 | −4.72% | −14.47% | 29.2% |

⭐ **四個結論(⛔ 別再重做一次)**:
1. **門檻是 100 不是 120** —— 一過轉換價就變差,不用等到他說的 120。
2. **只有高位階才成立**:同位階內「低於−高於轉換價」= 低位階 +0.55pp・中位階 +1.58pp・**高位階 +5.65pp**。
   → 低位階不報警(免得吵),⛔ 別把門檻拉成全位階通用。
3. ❌ 他說的「85~100 快摸到轉換價是甜蜜點」**不成立**(那格反而比 <85 還差)。
4. ➖ 「發 CB 的公司小股東吃虧」**看不出來**:有 CB −10.63% vs 沒 CB −12.13%(60 日)。
   ⚠️ 兩者都很負是因為**加權指數是市值加權**(台積電拉著),中位數個股本來就跑輸 —— 
   **這正是為什麼一定要有非 CB 對照組**,不然會把結構性現象誤讀成 CB 的效果。

⛔ **「低於轉換價」那格是 −0.29%(打平)→ 只能寫「不在倒貨區」,絕不可寫成買訊。**
⚠️ 偏誤方向已知:`cb_overview.json` 是**今天的快照**,當年真被拉過轉換價、換股贖回的 CB 已消失
→ 樣本偏向「拉失敗的」→ **系統性低估**這個訊號(所以正數才有意義)。
已落地:`_cbParityState()` 併進「籌碼乾淨度」的可轉債那行(⛔ 沒開新卡)。測試 `scripts/test_cbparity.mjs`。

### 🧊 「兩上兩下」實測(V71.9.0):第 1 名只是「打平大盤」,而且功勞主要在融資
逐字稿裡權證小哥自述的選股順序(大戶↑・主力↑・散戶↓・融資↓)。`tdcc_probe.py`
跑 4,015 檔集保 × 13 週 = **7,221 個事件**、8 種組合,報酬全扣同期加權指數、每檔每週最多算一次:

| 排名 | 組合 | n | 20 日超額中位 | 20 日勝率 |
|---|---|---|---|---|
| 1 | 大戶↑・散戶↓・**融資↓** | 407 | **+0.00%** | 50.1% |
| … | (其餘三個融資↓) | | −0.4 ~ −1.49% | |
| 5~8 | 四個 **融資↑** 的組合 | | **−2.21 ~ −2.60%** | 38~42% |

⭐ **三個必須寫進 UI、不可被「優化」掉的結論**:
1. **第 1 名只是打平大盤,不是會賺** —— 同窗口中位數個股輸大盤 1.85%,所以「打平」= 前段班。
   ⛔ 文案一律不准出現「會賺 / 保證 / 必漲」(否定句「不是會賺」可以)。
2. **融資方向做掉大部分的工作**:四個融資↓全在前段、四個融資↑全墊底。
   大戶↑散戶↓ 只有在融資也↓時才再加約 1.5pp;融資↑時只加 0.4pp。
   → **融資還在增加時,這套選股法基本上無效**,先看融資再看大戶散戶。
3. **13 週硬限制**:全部落在同一個市場環境、且是倖存者樣本 → 只能當方向參考。
   累積滿 1 年要重跑;邊際消失就把卡降級或移除(同 sector_flow / broker_habit 的處置原則)。

已落地:`_tdccFourFactor` / `_tdccFourFactorHtml`(個股 → 籌碼 → 分佈頁)。測試 `scripts/test_tdcc4.mjs`。

**V71.9.7 追加兩項驗證(第二批逐字稿)**:
- ✅ **股東人數(集保戶數)有邊際,但很小** —— 他說「最愛看三個指標:主力買超、主力買散戶賣、**集保戶數**」。
  `h` 每列第 5 欄就是股東人數,一直沒用。實測:人數↓(集中)20 日 −3.39% vs 人數↑ −4.28% = **+0.88pp**
  (n=12,321 / 6,567,5/10/20 日方向一致)。→ 加進卡片當**第 4 項**,但標「加分不多」,
  ⛔ **判定門檻仍只看前三項**(`core3`)—— 改成「四項全過」會讓實測最強的組合顯示不出來。
- ❌ **「高檔主力賣散戶買最慘」不成立** —— 大戶↓散戶↑ 在低/中/高位階分別差 0.55 / 0.95 / 0.79pp,
  **差距均勻、沒有集中在高檔**,而且最慘的是**中位階**(−5.05%)不是高位階(−3.69%)。
  → ⛔ **不加位階守門**(加了只會平白漏訊號)。⚠️ 這跟 `cb_probe` 可轉債那次相反 ——
  那次位階是決定性的(+5.65pp vs +0.55pp),這次不是。**「要不要加位階」每次都要實測,不能類推。**

### 🚨 風控:「跌多少一定會被迫賣」的真相(V71.7.1 查證,使用者問過)
- ⛔ **投信沒有「跌 X% 必賣」的停損線** —— 這是常見誤解。法規是「股票型基金**最低**持股 70%」
  + 「單一個股不超過基金淨值 10%」= **部位上限,不是停損** → 他們是**換股**不是清倉。
  真正的被動賣壓來自**大量贖回**與**季底作帳**。別再把投信寫成「停損殺出」。
- ✅ **唯一有明文硬性強制賣出的是散戶融資**(`_marginCallState`):
  整戶擔保維持率 = 股票市值 ÷ 融資金額;< 130% → 追繳 → 2 個營業日未補 → **第 3 日斷頭**。
  由融資成數反推:**上市(6 成)價 = 0.78×成本(跌 22%)/ 上櫃(5 成)價 = 0.65×成本(跌 35%)**。
  ⚠️ 成本只能用「融資餘額**增加日**的加權均價」推估 → 是**族群平均**不是任何人的成本;
  只回溯約 55 天;處置股被降成數/停資時公式失準;維持率是**整戶**不是單股。
  → 文案一律寫「壓力區/參考」,⛔ 不可寫成「X 元一定斷頭」。

### 🕵️ 分點慣性:實測否定了兩個直覺(V71.7.2,別再做那兩個)
`broker_habit_probe.py` 實測(646 檔、5,837 組配對)結論:
| 假設 | 實測 | 處置 |
|------|------|------|
| 「開高就倒」 | 有倒貨 vs 沒倒貨的隔日跳空只差 **0.05pp** | ❌ **不做**,無訊號 |
| 「賺 X% 才出」 | 超額報酬 P25 −0.77 / 中位 −0.06 / P75 +0.70,賺錢出場 47.6% | ❌ **不做** —— 幾乎完美對稱 = 「隔天就走不管賺賠」,**沒有獲利門檻** |
| 「特定分點會隔天倒」 | 最高 +31pp(vs 同股換日對照) | ✅ 已做進 `broker_perf.json` 的 `flip` |

⛔ **人工寫死的分點標籤(`_BROKER_GOD`)會錯** —— 實測「美商美林」被標「⚡外資最兇隔日沖」
但真效果 ≈ 0。V71.7.2 起 **`_brokerGodTag` 一律實測優先**,實測沒慣性就**不給標籤**,
人工標籤降為備援且加「?」。⛔ 別再把人工標籤當事實。

**方法論鐵則(這次踩了兩次才做對,做任何分點/板塊回測都適用)**:
① **對照組不能用「結構上必然」的基準** —— 第一版拿「所有分點出現在賣方的機率」當基準,
   算出來剛好 **50.0%**,因為每天就是 15 買 + 15 賣。正解是**同股換日對照**
   (同一檔、同一組隔日賣方名單,比「當天買方」vs「其他日買方」)。
② **報酬必須扣掉同期個股漲跌** —— 樣本窗口 2026/07/22~30 大盤 **−8.4%**,
   不扣會看到「大家都賠 3%」而誤以為是分點行為;扣完中位變 **−0.06%**,結論完全相反。
③ 已知限制:分點若**天天都買**,同股換日對照會**飽和**(edge 被低估)→ `min_n` 門檻不可拿掉。
   測試 `scripts/test_flip_edge.py` ⑦ 把這條釘住。

⚠️ **結論會過期**:若重跑後邊際消失,就把對應功能降級為參考資訊或移除,別留著誤導使用者。

## GitHub 帳號
- 帳號:`xin7355-collab`
- 主要 repo:`StockAI-DB`(此專案)
- 其他:`gdp-dashboard`(保留)、`pro-terminal-v4`(已刪除)
- GitHub Pages 1GB 限制:**2026-07-27 實測 388MB**;V69.9.6 起 inst_cache_stock.json(18.5MB 採礦中介)已移出 gh-pages 改存 data 分支(P3-7),下次 daily_miner 後約 370MB
