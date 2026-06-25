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
- 每次 push 前必跑三驗證：`node --check`（index.html inline JS）+ `python3 -m py_compile *.py` + `python3 scripts/check_prompt_vars.py`
- 出錯時使用者可以 `git revert HEAD` 回退，或叫 Claude 修

### ⭐ Claude 永久授權（使用者明示:看不懂程式碼,壞了再修就好）
- **純前端 / 小邏輯改動完成、三驗證通過後**：**不需問使用者**,直接 `git checkout main && git merge <feature-branch> --ff-only && git push origin main`,讓 `deploy_pages.yml` 自動上線
- **採礦 `*.py` 改動**:同上,直接 merge main + push,由 `daily_miner.yml` 接手
- **無需先開 PR**;若 web session 開在 feature branch,完成就 fast-forward 合併回 main
- ⛔ **仍須先問使用者**的例外:① 大規模重構/架構大改 ② 刪檔/刪資料 ③ 改 GitHub Actions workflow 邏輯 ④ 動 `data/` 內快取 ⑤ 不確定是否會壞時
- 壞了 → 使用者說「壞了」→ Claude 直接修;或 `git revert HEAD` 回退

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

### 外資期貨顯示邏輯
- `fi_net > -10000`：多方無憂（綠色）
- `-25000 < fi_net <= -10000`：⚠️ 暗流湧動（黃色）
- `-40000 < fi_net <= -25000`：🔴 紅色警戒（橙色）
- `fi_net <= -40000`：🚨 黑天鵝警報（緊急橫幅）

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
- **燈號**:🟢 安全/🟡 警戒/🔴 危險/🚨 緊急(animate-pulse)/💀 必死/💡 提示
- **Badge 規格**:可疊加,沒命中時 `hidden`(不留空)
- **教學說明**:每個複雜卡片右上加「📖 教學」按鈕,點開 `alert()` 顯完整機制
- **對策建議**:每個風險警報下方加「💡 對策」一句話告訴使用者該怎麼做
- **「跟對做 / 對著做」**雙向策略:處置股、主力動向都給兩種選擇

### 功能方向
- **初學者友善**:複雜功能要有白話說明 + alert 教學 + 對策建議
- **零採礦優先**:能用前端 K 線/既有資料源算就先做,「動採礦」是最後手段
- **AI 鏈偏好**:**Gemini 為主**(2.5 Flash + safetySettings BLOCK_NONE + thinkingBudget=0 + systemInstruction),OpenRouter 為備援,**取消 Groq**(輕量任務也是)
- **PWA 推播**:支援 `_fireAlert` + sw.js + 鈴鐺歷史 3 天
- **每日開 App 掃處置風險**:自動推 1 則(`_dailyDisposedAlertSweep`)

### 開發流程
- **直接 push main**:純前端改 → `deploy_pages.yml` ~1 分鐘上線
- **改完三驗證**:`node --check`(inline JS) + `python3 -m py_compile`(py) + `scripts/check_prompt_vars.py`
- **commit 用 HEREDOC**:多行 commit message + Co-Authored-By
- **PR 寫測試清單**:每張 PR body 給 Test plan(使用者上線後可逐項勾)
- **PR rebase**:撞 main conflict 時 `git rebase origin/main` + `git push --force`

---

## 🚨 處置股完整系統(V20.x — 大功能,獨立 sub-tab)

V20.0-V20.7 全套處置股風控,個股頁最右邊「🚨 處置」tab,含 6 張卡:

| # | 卡片 | 觸發條件 | 內容 |
|---|------|---------|------|
| 1 | 🔍 注意股 8 款掃描 | 永遠顯 | 8 款 TWSE 規則前端推估 + 4 個累積統計(連 3/連 5/10 中 N/30 中 N) |
| 2 | 預測 banner | 永遠顯 | 🟢 安全 / 💡 累積 / ⚠️ 即將注意 / 🚨 已達處置 |
| 3 | 💀 處置前/中/後 時機告警 | 已處置或必關 | 出獄前 1 天 / 出獄當日 / 出獄後 7 天 各自對策 |
| 4 | ⚔️ 雙刀流核心心法 | 注意/處置/必關 | 擒賊先擒王(同 industry 被關名單)+ 信心燈號(藍/紅/黃)+ 買盤竭盡 |
| 5 | 📈 越關越大尾預測 | 注意/處置/必關 | 5 因子評分 100 分(量縮/法人/基本面/技術/環境)→ 高機率續強 vs 出獄易崩 |
| 6 | 📖 處置股實戰操作秘訣 | 永遠顯 | 處置前/中/後 券商/ETF/大戶會做什麼 + 跟對做/對著做 |

### 8 款 TWSE 規則閾值(V20.4 嚴格版,對齊專業 App)
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

### 個股代號 badge(V20.3,可疊加)
- ⚠️ **注意股**(from `attention_status`)
- 🚨 **處置 N 分盤 ・ N 天後出關**(from `attention_status.interval/end_date`)
- 💀 **必關股**(from `_calcAttentionScan` 預測)

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
| 鈴鐺歷史通知 | V19.4 | priceAlertModal 加第 3 tab,2 天自動清,點任一筆跳該股 |
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

## GitHub 帳號
- 帳號：`xin7355-collab`
- 主要 repo：`StockAI-DB`（此專案）
- 其他：`gdp-dashboard`（保留）、`pro-terminal-v4`（已刪除）
- GitHub Pages 1GB 限制：目前使用約 100MB，無虞
