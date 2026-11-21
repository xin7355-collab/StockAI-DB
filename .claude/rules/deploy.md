---
paths:
  - "index.html"
  - "sw.js"
  - "pro.html"
  - ".github/workflows/**"
  - "CHANGELOG.md"
  - "scripts/fourcheck.txt"
  - "scripts/run_fourcheck.py"
---
# 部署 / 分支 / 版本號 / Service Worker 快取

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 9~19 行 -->
## Git 分支架構（三分支，各司其職）

| 分支 | 用途 | 更新方式 |
|------|------|----------|
| `main` | 程式碼（miner.py、index.html、workflow） | 手動 commit |
| `data` | 採礦後的 JSON 資料（orphan，永遠只有1個commit） | GitHub Actions force-push |
| `gh-pages` | 網站 + 資料（orphan，永遠只有1個commit） | GitHub Actions force-push |

**重要**：gh-pages 和 data 分支都用 orphan force-push，不累積歷史，空間不會爆炸。
- 💬 V82.1.9 `ptt_meta`(orphan,只有 `ptt_meta.yml` 寫):PTT 股板列表頁中繼資料(標題 / 分類 / 推文數 / 發文時間 / 代號 / [標的] 多空;⛔ 內文、⛔ 作者帳號),研究用、⛔ 進 gh-pages。


<!-- 舊 CLAUDE.md 第 215~234 行 -->
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


<!-- 舊 CLAUDE.md 第 413~469 行 -->
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
- ⚠️ **push 不一定會觸發部署(2026-08-06 實例)**:當天 16:06~18:35 UTC GitHub **hosted runner 配不出來**
  —— 4 支採礦 workflow 全部「job 從來沒開始跑」(`total_ms: 0`、無 steps、無 log,統一在 15 分被砍;
  `macro_cron` 自己的 timeout 是 8 分卻活了 15 分 → 證明那個上限**不是 workflow 訂的**)。
  ⛔ **別去查 miner.py / Shioaji 金鑰 / FinMind 額度** —— 同一個 commit 當天稍早跑成功過 7 次。
  同一時段之後 push 的 V72.5.6 / V72.6.0 **也沒有產生 push 觸發的 deploy_pages run**(只有手動 dispatch 那筆)。
  ⭐ **所以 push 完一定要用上面的版本號指令確認**;沒動就 Actions → `🚀 部署到 GitHub Pages` → Run workflow(main)。
  ⛔ 「workflow 沒跑」跟「workflow 跑了但失敗」是兩件事:前者 `run.conclusion=failure` 但 `job.conclusion=cancelled`
  且**用量 0 ms**,看到這個組合就是 GitHub 那邊的事,不是程式的問題。
- **Claude 每次前端部署後必做**：① 用上面**版本號**指令確認 gh-pages == main；② 明確回報使用者「已部署，開著的分頁最久約 10 分鐘自動換新版、切回前景更快，硬重整可立即見效（iOS PWA 可能需完全關閉 App 重開）」。
- **AI 結果快取**：`_aiCacheKey` 已含「提示詞雜湊」→ 改 `set_aiPrompt` 自動重算。
  ⚠️ 舊文寫的「雙擊 🧠 首席 AI 全盤分析鈕＝強制重抽 `runUnifiedGroqAnalysis({force:true})`」**已作廢** —
  該功能 V51.4 停用(entry 即 return)、V71.0.7 整條死鏈刪除,現在沒有這顆按鈕也沒有這支函式。

### deploy 階段保護
`daily_miner.yml` deploy job 內 `if [ "$STOCKS" -lt 100 ] then exit 1`：
- 採礦結果不足 100 檔（artifact 下載失敗、merge 跑掉）→ 拒絕 force-push
- 看到 workflow 整體 success 但 gh-pages 沒更新時，先看 deploy job log 有沒有這條訊息
- ⏱️ V79.5.5 deploy job 時限 **30 → 40 分**、「🎯 今日訊號掃描」那一步**自己最多 8 分**(使用者 10/22 選;V79.6.0 起 10 分,見這段最後):第二輪平常整個 job 就要 26 分,10/22 #634 再加上安裝瀏覽器卡 7 分 → 撞 30 分,撿回 / 部署 / 推 data 三步全部沒跑(資料由前一輪部署,沒遺失)。⭐ **標了「不擋部署」(`continue-on-error`)的步驟也要有自己的時限** —— 不然它照樣吃得掉整個 job 的時限。⛔ job 時限也別超過 60(共用部署鎖)。`test_deploy_relay ⑥` 釘住(兩個決定性對照)。🌐 **V79.6.0 瀏覽器改在「⚡ 並行跑」那步背景先裝**(10/22 #637 訊號掃描 7 分 25 秒 = 裝瀏覽器 5 分 39 秒 + 掃描 106 秒;並行那步本身 16~22 分 → 藏進去):掃描那步看到 `/tmp/parallel/pw.log` RC=0 **而且**瀏覽器檔案在就不重裝,否則在那裡補裝(上限 8 → 10 分)。⛔ 別把安裝搬回掃描那步。`test_deploy_relay ⑦` 實跑兩段 bash

### 修改後驗證流程
1. 改 main → push（純前端 index.html 走 `deploy_pages.yml`；採礦 py 走 `daily_miner.yml`）
2. 至 Actions 看對應 workflow run 啟動
3. 純前端等 deploy_pages 綠燈（~1 分鐘）；採礦等所有 batch + deploy 綠燈（30-60 分）
4. 開網站硬重新整理（SW + meta cache-control 會自動拉新版）
5. 手機 PWA：因 index.html 有 `setInterval(reg.update(), 1hr)`，最多 1 小時內自動換新版（iOS PWA 因系統限制可能需要完全關閉 app 重開）

---


<!-- 舊 CLAUDE.md 第 665~671 行 -->
### 開發流程
- **直接 push main**:純前端改 → `deploy_pages.yml` ~1 分鐘上線
- **改完跑四驗證**(清單見「每次 push main 前必跑的四驗證」一節)
- **commit 用 HEREDOC**:多行 commit message + Co-Authored-By
- **PR 寫測試清單**:每張 PR body 給 Test plan(使用者上線後可逐項勾)
- **PR rebase**:撞 main conflict 時 `git rebase origin/main` + `git push --force`


<!-- 舊 CLAUDE.md 第 2049~2068 行 -->
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


<!-- 舊 CLAUDE.md 第 2464~2471 行 -->
## GitHub 帳號
- 帳號:`xin7355-collab`
- 主要 repo:`StockAI-DB`(此專案)
- 其他:`gdp-dashboard`(保留)、`pro-terminal-v4`(已刪除)
- GitHub Pages 1GB 限制:**2026-07-27 實測 388MB**;V69.9.6 起 inst_cache_stock.json(18.5MB 採礦中介)已移出 gh-pages 改存 data 分支(P3-7),下次 daily_miner 後約 370MB

---


