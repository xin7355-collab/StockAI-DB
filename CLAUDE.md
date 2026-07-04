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

### 版本號規則(STRATEGY TERMINAL Vx.y)⭐ 使用者明示(2026-07-04 更新):純 +0.1 里程表,不分大小改
- **一律 +0.1**:每次 push 都 bump 小數位 **+0.1**,不管改動大小(UI 調整、bug fix、小功能、大功能、採礦、workflow 全都 +0.1) → V49.4 → V49.5 → V49.6 …
- **逢 .9 進位**:`.9` 的下一版 = 主版本 +1、小數歸 0 → **V49.9 → V50.0 → V50.1 …**,以此類推(像里程表)
- **不再分「小改 vs 大改」**:舊的「大事件才主版本 +1」規則已作廢,一律 +0.1 讓版本一直往上加
- **位置**:`index.html` 兩處必須**同步**改(用 `sed` 一次改兩處最保險):
  - 版本註解:`<!-- STRATEGY TERMINAL Vx.y … -->` (~line 18)
  - 置頂 badge:`<span …>Vx.y</span>` (~line 912)
  - (`<title>首席</title>` 不含版本號,不用動)
- **時機**:每次 push main 前 bump 一次,commit message 開頭寫「Vx.y → Vx.z」
- **驗證**:push 前 `grep -c '>Vx.y</span>' index.html` 確認新版號有改到(=1)

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
- **改完三驗證**:`node --check`(inline JS) + `python3 -m py_compile`(py) + `scripts/check_prompt_vars.py`
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

**每次 push main 前必跑的「四驗證」**(原三驗證 + 新增第 4 個):
1. `node --check`(抽 inline JS 語法)
2. `python3 -m py_compile *.py`(後端語法)
3. `python3 scripts/check_prompt_vars.py`(prompt 變數齊全)
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

**修 bug 4 步驟流程**:
1. **重現**:使用者截圖 / console log / 確切操作步驟
2. **診斷**:加 console.log / 黃色 fixed toast / 強制 print 真實狀態(如 V24.9 救命)
3. **對症**:看診斷結果決定改 HTML / CSS / JS / 後端 — 不靠猜
4. **驗證**:四驗證 + 使用者實測一次

**Claude 主動巡邏**:每 5-10 次 push 後 Claude 自己跑一次:
- awk div 平衡(避免新加 HTML 又巢狀)
- grep `silent return` / `return;\s*}\s*$` 找潛在空白 bug
- grep `display:\s*none` 看是否新加 hidden 元素未對應 show 邏輯

### 🔗 連動更新檢查清單(V27.6 後新增,使用者要求:改/加資料要判斷連動)
**改一個資料/欄位時,必連帶檢查的觸點**(避免「改一處、別處沒跟上」,如 `published_time`/`us_macro` 對接斷掉的 bug):

| 改動 | 必連帶檢查 |
|------|-----------|
| **macro_risk.json 新增/改欄位**(macro_miner.py) | ① 前端讀取卡(grep 欄名)② 首席 AI prompt 注入(`runUnifiedGroqAnalysis`)③ `_calcRiskScore` 風險指數 ④ `risk_history.json` 快照欄位 ⑤ 前端欄名跟後端**完全一致** |
| **後端改/加欄位名** | 前端 fallback 鏈要含新欄名(別只讀舊名);grep 雙向確認前後端同名(記取 `us_macro` 不存在、`published_time` 前端沒讀的 bug) |
| **新增 data/*.json 檔** | ① daily_miner deploy 底層 `git archive origin/data` 會保留(append 類檔靠這保命,如 risk_history)② 前端 fetch 用動態 `ghBase` + `?t=${Date.now()}` ③ 確認 daily_miner.yml push paths 是否需納入觸發 |
| **新計分因子**(獵鷹/主力出貨/多空) | ① 卡片「因子來源」說明文字同步 ② 首席 AI 若注入該訊號要更新 ③ 數值單位確認(億/張/口/%,記取 `fi_spot_net`=億) |
| **改燈號/verdict 文案** | 同一決策的多張卡(首席/綜合評分/系統燈號)語義要一致,別紅綠相反(V27.5 已統一改「寫字不靠色」) |
| **加新偵測器/型態**(朱家泓/林穎 K 棒) | 務必**同時**加進三處清單:`renderKbarTactics` + `renderKbarScore` patSigs + `runKlineAudit` grab list(V41.29 教訓,漏一處該訊號就不同步) |
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

### 二分之一價(½價)定義(兩種並存,別亂統一)
- **突破棒防守(V31.8 既有)**:爆量長紅 ½ = `(開+收)/2`,結構防守價(`#breakoutGuard`,refreshStrategy 內計算)
- **K棒戰法(V36.0 新)**:½ = `(最高+最低)/2` = 課程定義「當天平均成本」

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

### FinMind 免費版限制(實證,別再踩)
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
盤點朱家泓/林穎技術流,補齊漏掉的型態。**全照單一型態引擎**回 `{tone,title,val,msg}`,自動同步進**三處**:`renderKbarTactics`(K棒戰法卡)+ `renderKbarScore` patSigs(K線型態量評分)+ `runKlineAudit`(K線AI報告 grab list)。新增偵測器**務必同時加進這三個清單**。
| 函式 | 內容 |
|------|------|
| `_detectMaKoudi` | 均線扣抵值:今收 vs 扣抵值(`data[last-(N-1)].close`)判月線/季線明日揚抑;補「扣低→翻揚(領先偏多)」+「跌破扣抵→提前1-2天轉弱」 |
| `_detectGap` | 缺口跳空+分類:向上/向下、是否回補、突破缺口(帶量)vs 竭盡缺口(高檔連漲後);朱「缺口不補繼續走」 |
| `_detectIndicatorDivergence` | KD/MACD 頂底背離:讀 `this.indicators.k/.dif`(worker 現成陣列,index 對齊 activeData);價創高但指標沒創高=頂背離 |
| `_detectGranville` | 葛蘭碧八大買賣點(月線 20MA):買1突破/買2假跌破/買3回測支撐 ・ 賣1跌破/賣2假突破/賣3反彈受阻(買4/賣4乖離已由 `_detectMaDeviation` 涵蓋) |
| `_detectTopBreakdown` | 頭部頸線跌破(M頭/頭肩頂/三重頂,對稱 `_detectBottomBreakout`)+ 等幅測跌目標價 |
| `_detectTrendline` | 趨勢線:兩上升低點連線跌破=轉弱 / 兩下降高點連線突破=轉強 |
- **已完整覆蓋**:½價/晨昏星/吞噬貫穿/假突破/測壓測撐/量價背離/回後買上漲/四大金剛/K棒強弱(林穎)/底部頸線/均線糾結/乖離/處置股。
- **刻意不做**:艾略特波浪(太主觀,`頭頭高底底高`波段結構已涵蓋實務需求)。

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

## GitHub 帳號
- 帳號:`xin7355-collab`
- 主要 repo:`StockAI-DB`(此專案)
- 其他:`gdp-dashboard`(保留)、`pro-terminal-v4`(已刪除)
- GitHub Pages 1GB 限制:目前使用約 100MB,無虞
