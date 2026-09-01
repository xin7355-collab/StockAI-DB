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

### 🚨🚨🚨 V73.9.0 ⭐⭐⭐ 真因是 **GitHub 每個 repo 的排程配額**,不是 concurrency（V73.7.9 只對了一半）

V73.7.9 搬出共用 group 之後,`live_quotes.json` **確實第一次上得了 gh-pages** —— 那部分是對的。
⛔ **但它仍然一天只跑一輪**,而且 `tick_flow` 一筆都沒有。去查 run 清單才看到真相
(2026-08-19 ~ 08-25,全部 workflow 都是 `state: active`):

| workflow | cron 要求/天 | 6 天實際 run |
|---|---|---|
| `live_snapshot`(每 5 分) | ~58 | **3** |
| `tick_flow`(每 10 分) | ~27 | **0** |
| `macro_cron` / `news_express` / `daytrade_data` | 5~8 | **0** |
| 🚨 `stock_futures`(一天只要 **2** 次) | 2 | **0**(`total_count: 0`) |
| `theme_news` / `daily_miner` / `fund_sweep` / `playbook_scan`(1~2 次) | 1~2 | ✅ 全部正常 |

⭐⭐ **全 repo 一天只有 7~10 筆 schedule run 進得來,而 cron 要求超過 100 筆。**
而且**進得來的每一筆都遲到 24~49 分鐘** —— 那不是「偶爾塞車」,是**配額用完就丟**。
高頻的那兩支(85 次/天)把配額吃光 → 連一天只要 2 次的 `stock_futures` 都擠不進來。

⛔⛔ **兩個一定要記住的誤判**:
1. 🚨 **CLAUDE.md 原本寫 `stock_futures_night` 「比較可能是**跑了但失敗**」(因為 miner 有三處
   `sys.exit(1)`)—— 那是錯的**。`total_count: 0`,它**一筆 run 都沒有**,跟程式完全無關。
   ⭐ **通用:下「程式有問題」的結論之前,先確認它到底有沒有被觸發過**
   (`actions_list` 的 `total_count`)。我當時是從「有三處 exit(1)」推理出來的,那只是**可能性**。
2. ⛔ 被丟掉的**不是 `cancelled`,是連 run 都沒產生** → Actions 頁面一片乾淨,
   什麼都看不出來。這是陷阱 #9 的極端版:**連「有沒有跑」都看不到**。

⭐ **修法:⛔ 不要求 GitHub 幫我們排 58 次,改成排 1 次、自己在 job 裡迴圈。**
`scripts/intraday_window.py`(RUN / SLEEP n / DONE)+ workflow 裡的 `once()` 迴圈。
需求從 **85 次/天 → 5 次/天**,而每天 1~2 次的頻率在這個 repo 實測 **100% 可靠**。

⛔ **六條不可改掉的設計**(測試 `scripts/test_intraday_loop.py` 37 條釘住,已用注入缺陷自我驗證):
① 🚨 **每輪開頭要 `git checkout -f "$BASE_SHA"`** —— deploy 結束時工作區停在 gh-pages/data,
   那裡**沒有採礦機**。⛔ 少了這行第二輪起全部失敗,而且**只有實跑才看得到**。
② **節拍計算器要先 `cp` 到 `/tmp`** —— 同理,gh-pages 上沒有 `scripts/`。
   而且複製完要**立刻試跑一次**,不能用就直接紅燈(否則迴圈一拍都不跑卻看起來很正常)。
③ ⭐ **先無條件跑一輪再進迴圈** —— 手動觸發(盤後測試)完全靠那一輪。
④ **收盤那一拍必須跑得到**(quotes 13:30 / ticks 13:23)—— 收盤價就在那一拍,
   所以窗口判斷用 `now > end + 90s` 而**不是** `>=`。
⑤ **空過守門**:一拍都沒成功要 `exit 1`(⛔ 不可全綠沒資料)。連 5 拍失敗要提前收工
   (⛔ 也不可無限重試 —— 金鑰過期會空轉 5 小時)。
⑥ **每輪把 gh-pages 重設到 `origin/gh-pages`**(`checkout -f -B`)—— 否則第二輪起本地分支
   落後,每次都先撞一次 push 失敗才靠 rebase 救回來。

🚨🚨 **`tick_flow` 的 `cancel-in-progress` 從 `false` 改成 `true` 是刻意推翻,⛔ 不是「順手統一」**:
V73.7.9 的理由是「執行 12 分 vs cron 每 10 分 → true 會讓它永遠跑不完」。
**新架構下已經沒有每 10 分鐘的 cron 了**(節拍在 job 裡,跑完才排下一拍,不可能自己砍自己),
而接手用的排程**必須殺得掉還活著的主迴圈**才能真的接手 → 只能是 true。
⭐ 原本那條通用鐵則(**`cancel-in-progress: true` 只有在「執行時間 ≪ 觸發間隔」時才安全**)
**仍然成立**,只是代入的數字變了(觸發間隔 90 分 ≫ 一拍 2 分)。
⛔ **判斷可不可以設 true 永遠要看「現在的」觸發間隔,不是抄上一版的結論。**

⛔ **我一度想做但收回的事**:把整點的 cron(`0 14`、`0 6`…)挪開,理由是 GitHub 文件寫
「高負載時段包含每個整點」。⛔ **但同一份資料裡有三個整點的反例照樣正常跑**
(`fund_sweep 0 18`・`daytrade_probe 0 10`・`telegram_alert 0 12`)→ 那個假設**被推翻了**,
所以**一行都沒改**。⭐ 通用:**零成本的改動也不可以基於已被反例推翻的假設** ——
它會混淆歸因,下次就分不出到底是哪個修法有效。

✅ **盤中實測已通過(2026-08-25 手動觸發,台北 12:29 起)**:
| | 實際產出時間 | 節拍 |
|---|---|---|
| 📸 `live_quotes` | 12:30:38 → 12:35:08 → 12:40:09 | 每 5 分 ✅ |
| 🔬 `tick_flow` | 12:37:57 → 12:43:59 | 每 10 分(偏移 3)✅ |
⭐ **第 2 拍才是決定性的** —— 它證明「回到主場程式碼」那行真的有效
(deploy 結束停在 gh-pages,少了它第二輪起全部失敗,而**單元測試抓不到**)。
⭐ `tick_hist` 的 `days` 從 4 → **5** → 證明累積型歷史在切分支時沒有被弄丟。
⚠️ 仍未驗:**排程本身**(08:44 那條 cron)明天才會第一次觸發 —— 迴圈證明會動了,
   但「GitHub 願不願意給那一筆 run」要等明天才知道(每天 1~3 次在這個 repo 實測 100% 可靠)。

⏭️ **怎麼驗有沒有修好**(⛔ 一律看**產物的日期**,不是 Actions 頁面的顏色):
```bash
for f in live_quotes live_index tick_flow daytrade_pack stock_futures_night; do
  echo -n "$f: "; git show origin/gh-pages:data/$f.json 2>/dev/null | grep -oE '"updated"[^,}]*' | head -1 || echo "不存在"
done
```
盤中 `live_quotes` 應該 **5 分鐘內**、`tick_flow` **10 分鐘內**。
⚠️ 若釋出配額後 `stock_futures` / `macro_cron` 仍然 0 筆 → 那才輪到查它們自己的程式。
⚠️ 若 GitHub 對「5 小時的常駐 job」有意見,下一步是走 **Cloudflare Worker cron →
`repository_dispatch`**(專案已有 `cloud-worker/`),⛔ 別退回高頻 cron。

---

### 🚨🚨 V73.7.9 ⭐⭐ 高頻採礦**不可跟別人共用 concurrency group** —— 它們會互相擠掉,而且全綠零訊息
使用者只是說「(盤前台指期)沒看到」,查下去發現的是**完全不同、而且藏了很久的**問題:

| 檔 | 實測(2026-08-20) |
|---|---|
| `data/live_quotes.json`(全市場即時報價,每 5 分) | 🚨 **從來沒出現在 gh-pages 上過** |
| `data/tick_flow.json`(逐筆內外盤,每 10 分) | 🚨 停在 **08-07**(13 天) |
| `data/daytrade_pack.json` | 🚨 停在 **08-07** |
| 手動觸發 live_snapshot(同一份程式碼) | ✅ **84 秒跑完、2,330 檔 + 台指期全對** |

⭐⭐ **真因是 GitHub concurrency 的語意,不是程式**:
**每個 group 只留一個 pending run —— 後面來的會把前面還在排隊的直接取消掉。**
盤中 `live_snapshot`(每 5 分 ≈55 次)+ `tick_flow`(每 10 分 ≈27 次)約 **82 個事件**
全擠進共用的 `gh-pages-push`(還跟 `deploy_pages` / `daily_miner` 的 deploy job 同一個)
→ 只要機器排隊超過幾分鐘就整串互相擠掉。
📊 佐證:live_snapshot 建立 38 天、cron 要求每天約 70 次,`run_number` 卻只有 **62**;
   tick_flow 每天約 27 次,`run_number` 只有 **50**。

⛔ **兩支已搬出共用 group**(`gh-pages-intraday-quotes` / `gh-pages-intraday-tick`),
⛔ **別再搬回去** —— 那正是它們產不出東西的原因。離開共用鎖之後,防撞就只剩
各自 deploy step 裡既有的「**5 次 retry + fetch/pull --rebase**」迴圈(⛔ 不可拿掉)。

⭐⭐ **`cancel-in-progress: true` 只有在「執行時間 ≪ 觸發間隔」時才安全**(這條最容易被「順手統一」):
- `live_snapshot` 跑 **84 秒** ≪ 5 分鐘 → **true**(快照要最新的,舊的還在跑就該砍)
- `tick_flow` timeout **12 分** vs 10 分一發 → ⛔ **必須 false**,設 true 會讓跑超過 10 分鐘的那輪
  被下一輪砍掉、**永遠跑不完**(把 starvation 換成另一種 starvation)
- ⚠️ **改觸發間隔時要重新檢查這條**(測試 ③d/③e 釘住現行間隔,改密了會失敗提醒你)

🔍 **同版補掉讓它瞎了 13 天的盲點**:`data_audit.py` 的 `INTRADAY_ONLY` 三個檔在
`CADENCE_H` 標 `None` → **B 類整個 continue 跳過**,A 類的 MISSING 也被**無條件**原諒
(「盤中才產出,收盤/假日沒有是正常的」)→ 停產 13 天,體檢每次都一片乾淨。
⭐ 豁免本身沒錯,錯在**無條件** → 新增 **B2 類**:
- **判準用「相對全站最新資料日」不用寫死天數** —— 連假時所有採礦一起停、基準也跟著停
  → ⛔ 不會誤報(寫死「≤4 天」會在春節整排誤報,而誤報會讓人養成忽略體檢的習慣)
- **盤中時段(台北平日 09:05~13:30)檔案不在 → 報 ❌**,⛔ 不可再回「沒有是正常的」
- 實測當場抓出上面那三個(13 天 / 13 天 / 盤中 89 分沒更新)

⭐ **通用鐵則**:① 「workflow 是 active」「run 全綠」都**不等於它有在產出**(陷阱 #9)——
判斷一支採礦活著,要看**產物的日期**,不是 Actions 頁面的顏色。
② **任何「這種檔本來就會舊」的豁免,都必須有條件**;無條件豁免 = 對體檢隱形。
測試 `scripts/test_intraday_sched.py` 17 條(已用「注入缺陷 → 確認叫得出來」自我驗證過)。

⚠️ **還沒查清楚的**:`stock_futures_night.json` 停在 **08-08**(296 小時)。
它只有每天 2 次 cron,⛔ **不像**是被擠掉;`stock_futures_miner.py` 有三處 `sys.exit(1)`
→ 比較可能是**跑了但失敗**。⛔ 它是**夜盤**採礦,白天手動觸發會把日盤資料寫成「夜盤」
→ **只能等夜盤時段看 log**,別在白天亂觸發。

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
   + **`python3 scripts/check_undefined_py.py`**(用到不存在的名字 = 潛在 NameError — V72.3.0 新增)
   + **`python3 scripts/test_no_token_leak.py`**(🔐 金鑰片段不可印進公開的 Actions log — V74.0.5 新增,見下方)
     ⭐ 它有 `--selftest`;實測 43 支只報 **1 筆而且是真的**(`miner.py` 寫 `datetime.now(TW)`,
     而 `TW` **從來沒定義過** —— 那條 `or` 分支目前沒被走到,是顆未爆彈,一走到就被
     `except Exception as _e_mh` 吞成 `margin_error`)。⛔ 誤報率高的版本已丟棄(第一版 345 筆全是閉包誤判)。
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
| 35 | **一個指標「有門檻」不代表它守得住方向** | V72.2.3 實例:多空計分卡的「可放心做多」曾被判定「`ratio ≥ 0.65` 天然安全,空頭不會觸發」→ **錯的**。`ratio` 是「28 條規則的多空命中比」、`_ovTrend` 是「價格趨勢」,**兩者完全可以背離**(空頭股籌碼面照樣可能整排亮)。同一版還發現「多方 7 項 / **0 項** 空方 → 多方 **100%**」—— 一邊掛零多半是**那類資料還沒到齊**(陷阱 #28),不是真的沒有利空 | ⛔ 判斷「這張卡天然安全」時,要確認那個門檻**真的跟價格趨勢綁在一起**,別看到有 if 就放心 → 一律呼叫 `app._bearGate(sym)`。⭐ 另外:**任何 `a/(a+b)` 的占比,一邊為 0 時要主動寫出「可能只是資料沒到齊,不等於沒有風險」**,而且百分比旁一定要同時顯示「命中 N/28」(⛔ 100% 不可孤零零出現)。測試 `scripts/test_wrsample.mjs` ⑤ |
| 36 | **「最高勝率」沒有對照組 → 0% 也能當冠軍** | V72.2.2 實例(`page_sweep` 掃出來):0050 的當沖頁顯示「🏆 這檔最高勝率:爆量突破 **0%**」,底下還接「成功率最高的做法(**鐵律**)」五條操作指令。⛔ 真因不是算錯,是**只跟 0 比、沒跟「隨便挑一天」比**。實測基準隨個股波動率差 5 倍(0050 **7%** / 2330 16% / 2317 29% / 3231 **37%**)→ 拿 50% 或寫死門檻都會判錯:2317「爆量長紅 47%」對 50% 會被標「跟丟銅板差不多」,但它明明贏基準 18pp | ⭐ **用同一條勝負定義掃全部交易日算基準**(零額外成本),沒贏基準/樣本不足就**不給操作指令**,誠實說「這檔沒有值得做的」+ 指路替代方案;⛔ 但資料照顯示,不是藏起來。`_winRateConfidence(wr, n, p0)` 第 3 參數傳**該場景的基準**(⛔ 預設 0.5 只是向後相容,不是對的答案);**顏色門檻也要相對基準**。測試 `scripts/test_wrsample.mjs` ①② |
| 37 | **共用工具寫好了卻只接了一處** | `_winRateConfidence`(V71.8.6)+ CLAUDE.md 白紙黑字寫著「**任何**顯示『勝率 X%・N 次』的地方都該配這個」—— 但實際上**全 App 只接了 1 處**,於是「勝率 100% ・賺賠比 全贏 ・**3 次**」照樣掛 ⭐主打 + 閃爍 + 「可依紀律進場」(陷阱 #27 的再犯)。⚠️ 這跟「同一個修法要掃過所有頁面」是同一種病(講反話犯 8 次、同名不同義犯 2 次) | ⛔ 寫下「任何 X 都該用 Y」這種規則時,**當場 grep 一次 X 有幾處、逐一接上**,別只接眼前那個;並且**寫一條測試釘住呼叫端數量或關鍵呼叫點**,否則規則只存在於文件裡。⭐ 找漏接最有效的方法是 `scripts/page_sweep.mjs`(實際渲染後掃畫面),⛔ 靜態 grep 找不到「數字湊起來很荒謬」這類問題 |
| 38 | **顯示給使用者的「勝率」被憑空係數加減過** | V72.5.6 實例(當沖「今天這檔怎麼做」):`adj = 大盤分數×3 + 部位訊號(±8) + 族群×4 + 量比(+3)` → `longAdj = clamp(20, 85, 勝率 + adj)`,然後標成「**勝率約 57%**」。那些係數是**憑空訂的、從來沒驗證過**,最多把數字搬動 **±15pp** —— 使用者看到的「勝率」有一半不是統計出來的。⛔ 這正是本專案批評 `aiagents-stock`「接盤總量 = 流量 × 轉化率 × 客單價」那條的同型錯誤,只是發生在自己身上。同一版還發現:沒有對照組(門檻寫死 55/45)、樣本門檻 `n < 8` 比全 App 統一的 `_wrEnough`(10)還鬆、沒配 `_wrTag` | ⭐ **同一頁的 `_dtWinRateBacktest` 早就做對了**(乾淨對照組 + `_wrEnough` + `_wrTag`)→ ⛔ 同一頁不可有兩套標準,直接照做對的那支改。修法三件:① 顯示的勝率**純歷史統計**,環境訊號降為背景並明寫「**沒有計入上面的勝率**」② 主判準改成**扣掉當沖來回成本 0.25% 後的期望值**(算完是負的就說「不值得當沖」,⛔ 不硬給方向)③ 對照組 = 同一條勝負定義套在**每一個交易日**。⭐ 通用:**任何要顯示給使用者的統計量,都不可以被沒驗證過的權重調整過** —— 要嘛是純統計,要嘛就別叫它「勝率」。測試 `scripts/test_dtverdict.mjs`,核心那條是「**環境訊號相反時,勝率數字必須完全一樣**」 |
| 39 | **「關卡/防守價」那句永遠寫做多口吻** | V72.5.6 實測 2317:結論是「🟢 偏做空」,底下卻寫「壓 X / 撐 Y(**站上壓可續、破撐就跑=停損**)」= 做多的停損說法 → 同一張卡自己跟自己打架。結論是「不值得當沖」時更糟:那是給**要進場的人**看的指令,卻顯示給被勸退的人 | ⭐ 任何「支撐/壓力 + 怎麼做」的句子,**動詞要跟著結論走**:做多→站上壓可續抱、做空→跌破撐可續抱・站回壓就回補、沒結論→**只描述界線、⛔ 不給停損指令**。通用:**價位是事實(不變),但「所以呢」要看使用者站在哪一邊** —— 同 V72.4.7「上檔空間在出場狀態改講反彈減碼點」那條 |
| 40 | 🚨🚨 **測試環境跟正式環境不一樣 → 測試變成假綠燈**(一天之內踩到兩次,型態一模一樣) | 兩個實例:① **V74.3.1**:`git fetch --filter=blob:none` + `git archive` 在雲端拿不到 blob,**但我本機是完整 clone 所以永遠測得過** → chips_deep 還原一聲不吭回 0 天。② **V74.3.4**:板塊明細的成分股表在真實資料上 **32 個產業全部是空的**,而測試全綠、注入驗證也全過 —— 因為**測資自己把產業寫成代碼**(`'2382':'24'`),真實 `screener.json` 存的是中文名(`'2382':'半導體'`)→ **測資跟正式程式一起錯,兩邊「對得上」**。⚠️ 兩個都是「功能安靜地沒作用」,workflow / 測試全綠、零錯誤訊息 | ⛔ **測資的欄位格式必須跟真實產物一樣** —— 寫測資前先 `git show origin/gh-pages:data/x.json` 看一眼實際長相,⛔ 別憑印象編。⭐ 而且**跨檔案對照的功能**(A 檔的鍵去 B 檔查)一定要**用真實資料實跑一次**,測資對得上不代表真實資料對得上(V74.3.4 就是這樣抓到的:32 個產業逐一展開、數列數)。⭐ 同理任何跟 **git / 網路 / 檔案系統 / 瀏覽器環境**有關的事,「本機測得過」都不算數。⛔ 對不上時要**說出來**不可靜默空白(陷阱 #22) |

**修 bug 4 步驟流程**:
1. **重現**:使用者截圖 / console log / 確切操作步驟
2. **診斷**:加 console.log / 黃色 fixed toast / 強制 print 真實狀態(如 V24.9 救命)
3. **對症**:看診斷結果決定改 HTML / CSS / JS / 後端 — 不靠猜
4. **驗證**:四驗證 + 使用者實測一次

**Claude 主動巡邏**:每 5-10 次 push 後 Claude 自己跑一次:
- ⭐ **`node scripts/page_sweep.mjs`(V72.2.2 新增,最有效的一支,先跑這個)**
- awk div 平衡(避免新加 HTML 又巢狀)
- grep `silent return` / `return;\s*}\s*$` 找潛在空白 bug
- grep `display:\s*none` 看是否新加 hidden 元素未對應 show 邏輯

### 🧭 V72.6.0 頁面架構:「每頁一句話」⭐ 而且**刻意不合併分頁**(評估後判定方向是錯的)
使用者:「總覽、K線、籌碼頁面資料及卡片很多,我開發者都看到混亂…
把能用歷史數據認證有用的保留,其它隱藏,或這次出現有用訊號才出現」。

⛔ **第一個直覺(8 個 sub-tab 合併成 6)是錯的路,別走**:
把「回測」併進 K線、「即時」併進當沖,只會讓**單頁更擠** —— 而痛點是**頁內雜訊**不是分頁數量。
而且 `switchSubTab` 每個 tab 各有 lazy-init(進頁才觸發 loadIntradayKline / analyzeStockPlaybook / …),
合併要重寫那段,blast radius 大、收益是負的。

⭐ **正解:每一頁最上面一句話回答「這頁在問什麼 + 答案是什麼」**,細節留在下面給想細看的人。
`_pageLeadHtml()` + `_renderPageLead(tab)` + 三支**只轉述**的函式
(`_leadBacktest` / `_leadBullBear` / `_leadCorp`)。
總覽(主卡)、K線(`_headline`)、籌碼(`_chipConsensusLine`)、當沖(hero)本來就有。

⛔ **三條鐵則(測試 `scripts/test_pagelead.mjs` 28 條釘住)**:
① **不新增卡片** —— 是一條 bar 不是卡;算不出來**整條不顯**(不留空殼)。
② ⭐⭐ **不產生第二份真相** —— 頁首條只准轉述各頁自己算好的結論,
   判準必須跟卡片內**完全一致**(如回測用 `expectancy > 0` && `_wrEnough`)。
   測試 ⑨ 直接斷言這三支的原始碼裡**不可出現** `_detectXxx` / `_patternFitBacktest(` / `_calcBullBearScan(`。
③ 會下指令的一律先過 `_bearGate` / `_inExitMode`(這個錯全 App 已犯 8 次)。

⚠️ **新增任何頁首條時**:結論來源要存成 `_lastXxx` 並**綁 sym**(防切股殘留),
   在各自渲染完後補呼叫一次 `_renderPageLead(tab)` —— 只在 `switchSubTab` 呼叫會拿到上一檔的值。

### 🚪 `_exitModeNoticeHtml()` —— 出場守門的**共用告示**(V72.5.6)
V72.4.7 只接了「進場劇本」與「上檔空間」→ 「四關卡」「分批進場計畫」在出場狀態下**照樣給買點**。
⛔ 新增任何「會給進場價 / 買幾張 / 進場條件」的卡,一律先 `if (this._inExitMode(sym))` 走這支。
⚠️ **進場體檢是例外**:它同時服務庫存股的「該抱還是該跑」→ **不整張收起**,只把「💡 對策」那句改口。
⭐ 通用:「這類狀態要收起哪些卡」的清單一旦出現第二處,就該抽成共用函式 —— 不然第三處一定會漏(陷阱 #37)。

### 📋 `scripts/card_inventory.mjs` —— 砍卡之前先「量」(⛔ 不進四驗證,exit 0)
⛔ **憑印象砍卡是危險的**(陷阱 #31 差點砍掉包住活內容的外殼;`_SIGNAL_EDGE` 鐵則也禁止刪 C 級)。
這支只讀不改,量每張卡的:攤開字數 / 摺疊字數 / 有沒有下操作指令 / 有沒有引用實測數字。

⚠️ **它自己曾有兩個「安靜地量錯」的缺陷(V72.5.6 修)**:
① 只扣 `<details>:not([open])`,**沒扣 Tailwind `.hidden`** —— 沙箱連不到 CDN、`.hidden{display:none}`
   根本沒載入 → 那些內容全被算成「攤開」,字數**系統性高估**(同 `page_sweep` 踩過的坑)。
② `txt` 只留前 400 字 → 「有沒有下操作指令」只掃到卡片開頭,而**指令通常寫在最後**的
   「💡 對策 / 怎麼做」那一段 → 幾乎全部漏判。
⭐ 通用:**工具報出來的數字,在拿去做決策之前要先驗工具本身**(同 `test_sweep_selfcheck` 那條)。

📊 修好後實測 2330(攤開字數 = 第一眼版面成本):
合計 **12,419** 字;最重的四張是 回測 `playbookCard` **1,522** ・籌碼 `chipVerdictCard` **1,446** ・
K線 `chuMergedCard` **1,283** ・當沖 `dayTradeBody` **1,276**。→ 下一輪要瘦身先從這四張下手。

### 🔬 `scripts/page_sweep.mjs` —— 「實際渲染後掃一遍」(V72.2.2)
CLAUDE.md 自己早就寫了「巡邏 grep 只能抓你想得到的說法 → **真正可靠的是實際渲染後人工看一遍**」,
這支把那件事自動化:用**真實 `data/*.json`** 跑完整 `analyze()`,把 8 個分頁 + 3 個總覽 pane
全切一遍,掃**渲染後的 innerText**,找四類缺陷:
① 💥 缺值印給使用者(`跌破前低 --`)② 🗣️ 空頭卻叫人做多 ③ 📉 極端占比 ④ 🫥 空殼
⑤ ⚔️ **同一畫面兩張卡下相反的操作指令**(一張叫你進場、另一張叫你出場)——
   這條直接對應使用者講最多次的「邏輯不打架」。⛔ 只收「叫人怎麼做」的動詞、⛔ 只比**跨卡**的
   (同一張卡「可進場,跌破 X 就先出場」是完整劇本,不是矛盾)。

**它上線第一天就抓到 3 個靜態 grep 永遠找不到的真 bug**(問題不在關鍵字,在「數字湊起來很荒謬」):
| 頁 | 畫面長這樣 | 真因 |
|---|---|---|
| 回測 | 「勝率 **100%** ・賺賠比 全贏 ・**3 次**」還掛 ⭐主打 + 閃爍 + 「可依紀律進場」 | 陷阱 #27;`_winRateConfidence` 早就有,**全 App 只接了 1 處** |
| 當沖 | 0050「🏆 這檔最高勝率:爆量突破 **0%**」+「成功率最高的做法(鐵律)」 | **沒有對照組**,只跟 0 比 |
| 多空 | 「多方 7 項 / **0 項** 空方 → 多方 **100%** → 四面向同步攻擊,**可放心做多**」 | 陷阱 #28;一邊掛零是「資料沒到齊」 |

### ⚠️⚠️ V72.2.7 —— 這支工具**自己**曾有三個「看起來在工作、其實沒有」的缺陷
寫下來是因為它們**全都不會讓工具報錯,只會讓它安靜地少看很多東西**:
1. **整頁被當成「一張卡」**:`appMainArea` 沒有 inline display 也沒有 hidden → 一路暢通
   被當成一張卡收走,吃掉底下所有真正的卡(去重是「父層收了就不收子層」)。
   🚨 後果:**⑤ 跨卡打架偵測從上線到 V72.2.7 一次都不可能觸發**(它要求兩張**不同**卡),
   而我當時還寫下「偵測器收到 1 多 / 2 空、正確判定無衝突」這種**錯的推論**。
   → 排除 `appMainArea` / `tabContent*` / `subContent*`,卡片上限 4000→2500。每頁 2~3 張 → **8~14 張**。
2. **Tailwind 是 CDN、沙箱連不到** → `.hidden{display:none}` 沒載入 → `offsetParent`
   對「只靠 class 藏起來」的元素完全失效,掃到一堆使用者看不到的卡。
   → 自己往上追祖先。⚠️ 但**不能只看 class** —— `switchAppTab` 用
   `style.setProperty('display','flex','important')` 顯示分頁、**從來不移除 hidden class**,
   只看 class 會把「正在顯示的分頁」誤判成藏起來(121→50 張)。
3. **第一檔股票永遠被少掃**:`init()` 的 `switchAppTab('inv')` 在幾秒後把頁面切走。
   → 開掃前等 diag **連續兩次**站得住。

⭐⭐ **通用鐵則(這條比工具本身重要):「沒有報錯」不能當成「檢查過了」。**
任何偵測器都要有一條「**注入已知缺陷,確認它真的叫得出來**」的自我驗證 ——
`scripts/test_sweep_selfcheck.mjs` 就是幹這個的(它同時比對樣式有沒有跟 page_sweep 分歧、
外殼排除清單還在不在)。

⛔ **它是巡邏工具不是測試**:exit 0、**不進四驗證**(誤報擋 push 會讓人養成無視它的習慣),
每一筆都要人工讀原始碼驗真偽。⚠️ **四個「空過」守門都已內建,別拿掉** ——
這支工具最大的風險就是「輸出看起來乾淨,其實根本沒掃到」:
① 少了 `--allow-file-access-from-files` → `analyze()` **靜默**抓不到 data/(K 根數 <100 就 exit 1)
② 忘了先 `switchAppTab('diag')` → 個股頁整個 `display:none`(掃到 0 張卡就 exit 1)
③ `switchAppTab` 可能**在幾秒後被 init 蓋回庫存頁**(`init()` 尾端那行排在
   `await fetchMacroData()` 之後,沙箱要等 timeout)→ 切完驗一次 computedStyle
④ ⑤ 一句操作指令都沒收到時要明說(0/0 = 字典過時或沒渲染,**不是「沒打架」**)

⚠️ **排查這類問題時的鐵則**:判斷「看得見」一律用 `offsetParent` / `getComputedStyle`,
⛔ **不能用「有沒有字」** —— `innerText` 對 **display:none** 的元素**照樣回傳全文**
(V72.2.5 排查時據此以為 `tabContentMarket` 有 57k 字卻沒被收,差點誤判成 App bug 去「修」)。

### 🎲 顯示勝率的三條鐵則(V72.2.2,`_wrTag` / `_wrEnough` / `_winRateConfidence`)
1. ⭐ **勝率一定要配樣本**:任何「勝率 X% ・N 次」旁邊都要有 `app._wrTag(wr, n, p0)`;
   **n < 10(`app._wrEnough`)一律不准下進場指令**。⛔ 別在顯示端寫死次數門檻。
2. ⭐ **一定要有乾淨對照組,而且基準不是 50%**:`_winRateConfidence(wr, n, p0)` 第 3 參數
   傳**那個場景自己的基準**(⛔ 預設 0.5 只是向後相容,不是對的答案)。
   實測隔日沖基準隨個股波動率差 5 倍:0050 **7%** / 2330 16% / 2317 29% / 3231 **37%**
   → 2317「爆量長紅 47%」拿 50% 檢定會被標「跟丟銅板差不多」,但它明明贏基準 18pp。
   同理 `_SIGNAL_EDGE` 的基準是 **36.4%**、中位數個股本來就輸大盤(V72.0.4)。
3. ⭐ **贏不過基準就不准給操作指令**,誠實說「這檔沒有值得做的」+ 指路替代方案
   (同「寧可不給方向」原則)。⛔ 但**資料照顯示**,不是把它藏起來。
   ⚠️ **顏色門檻也要相對基準**(⛔ 寫死 60/45 會把 47%-vs-29% 染成綠色 = 看起來很差)。

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

### 🎫 V73.4.0 權證分點 —— **「無資料源」那條錯了一半**(使用者上傳 `warrants-main` 照出來)

CLAUDE.md 原本有**三處**寫著權證做不到。實測(`scripts/warrant_probe.py`)結果:

| 問題 | 實測 |
|---|---|
| 權證**分點**買賣 | ✅ **拿得到,而且我的金鑰就開得了** |
| 歷史深度 | ✅ **至少 2 年**(730 天前仍有 6,955 列) |
| 權證**溢價率 / 基本資料** | ❌ 仍然沒有(`TaiwanWarrantPrice`/`TaiwanStockWarrantInfo` 全 **422**=名字不存在) |
| 權證 ↔ **標的股**對照 | ⚠️ 待確認(第一版探針判斷式寫錯,已修,下次跑才知道) |

**端點**(⚠️ 注意它**不是** `/api/v4/data` + dataset):
```
GET /api/v4/taiwan_stock_warrant_trading_daily_report?securities_trader_id=9200&date=2026-08-13
→ {securities_trader, securities_trader_id, stock_id, price, buy, sell, date}
  例:{"securities_trader":"凱基","price":0.1,"buy":0,"sell":10000,"stock_id":"03013T"}
```
⚠️ **同一份資料的 dataset 形式 `TaiwanStockWarrantTradingDailyReport` 卻回
「Your level is register」** → **專用端點通、dataset 形式要付費層**。這個不對稱很反直覺。

⭐⭐ **三條可以帶走的通則**:
① 🚨 **「我掃過一遍沒有」不等於「沒有」,只等於「我用的那個掃法沒有」。**
   我上一輪的缺口探針掃了 94 個 dataset,**結構上就掃不到專用端點** ——
   而 CLAUDE.md 那三處「權證無資料源」正是那種掃法留下的結論。
② **同一份資料可能有多個入口,層級要求還不一樣** → 一個入口被擋不代表拿不到。
③ **拿得到 ≠ 做得出功能**:權證分點有了,但要做「權證大戶在買哪一檔股票」,
   還需要「權證 ↔ 標的股」對照表 —— ⛔ **那個還沒確認**,別急著做。

⛔ **下一步的正確順序**:先確認對照表 → 再回測有沒有邊際 → 才談要不要做。
   ⚠️ 權證分點的**當事人是券商自營避險部位**,跟「主力買股票」不是同一件事,
   預測力完全未知(同 `_BROKER_GOD` 人工標籤的教訓:別假設「聽起來很厲害」就有效)。

### 📊 外部參考資料的評估紀錄⑧:24 步「台股 AI 分析」Colab 課程(2026-08-14 使用者截圖)

使用者給了一份 24 步教學(yfinance → 技術指標 → 財報籌碼 → ML → Gradio → Email 通知)。
逐步對照後**只有 1 步是我沒有的**,而那 1 步當場驗完決定**不做**。寫下來免得再問一次。

**✅ 已有且更嚴謹(20/24 步)**
K線分價量表(我還多了 `_overheadSupply` 套牢區)・MA/RSI/MACD/布林・營收毛利(1,790 檔)・
外資投信(已補到 3 年)・融資融券・ATR 停損(`_lotsForRisk`)・領先指標(macro_risk)・
回測扣手續費(我還扣同期大盤 + 六道關卡)・儀表板(完整 PWA)・通知(PWA 推播 + Telegram)・SOP。

**➖ 純教學步驟,不適用**:Colab 環境安裝・pandas 多層索引清洗・封裝成 Python 類別・
Gradio 公開連結(我是靜態網站,本來就公開)。

**⭐⭐ STEP 16「訓練 AI 模型(破解勝率迷思)」—— 它自己的副標就是答案**
原文:「用基礎特徵訓練隨機森林,**見證 50% 擲硬幣勝率**的第一課」。
→ 這份教材**自己承認** ML 在這裡只有擲硬幣的水準,跟本專案「禁 AI 算數 + 一切要實測」
   的立場完全一致。⛔ 別因為「有 AI 兩個字」就以為那是我缺的東西。

**❌ STEP 13「落後指標相關性熱力圖:找出誰最影響股價」→ 當場驗完,不做**
這是唯一我沒有的東西。用**本專案自己的資料**驗(51 檔、各 120+ 交易日):

| 問題 | 中位相關係數 | \|r\|>0.3 的檔數 |
|---|---|---|
| 外資買超 vs **當天**漲跌(同期) | **+0.298** | **25/51** |
| 外資買超 vs **明天**漲跌(預測) | **+0.028** | **0/51** |

⭐⭐ **同期相關 0.298 看起來很漂亮,但預測相關幾乎是 0,而且 51 檔裡沒有一檔超過 0.3。**
   真因很直白:**外資買超跟當天漲跌相關是廢話**(有人買才會漲),
   那是「同一件事的兩種記法」,不是因果、更不是預測。
→ ⛔ **不做相關性熱力圖** —— 它會產生一張很有說服力、但對決策毫無幫助的圖。
⭐ 通用鐵則:**看到「相關性」先問「是同期還是隔期」** ——
   同期相關再高都不能拿來預測。本專案的 `_SIGNAL_EDGE`(46 偵測器的**未來報酬**期望值)
   問的才是對的問題。

### 🏪 V73.6.1 櫃買指數:卡了五輪的真因是 **TPEx 擋 GitHub IP**,不是格式(⭐ 探針 9 秒解掉)
使用者提供 TPEx「改版」的三個解法,問「能不能抓到 OTC 即時」+「對當沖有沒有優化空間」。
⛔ **兩個前提都要先查證**,結果兩個都跟直覺不同。

#### ① 「即時」**早就有了**,那三個方案沒有一個提供即時
前端 `_applyLiveIndex('mktTWOII')` 走 **Fugle `IX0043`**,每次開大盤頁就抓。
⚠️ 使用者方案一的 `api.kbars()` 是**歷史分 K**,而且它在採礦端(一天跑一次)→ 不會變成即時。
**真正缺的是歷史日 K**(`data/^TWOII.json` 從上線到現在一次都沒產出過)。

#### ② `scripts/otc_probe.py` 一次試完 22 個候選 —— 前五輪的方向全錯
V71.2.5~V71.6.8 五輪都在猜「TPEX 的日期格式 / 資料鍵值」,每輪「改 miner → 等 workflow → 看 log」30-60 分。
⛔ 那正是本專案自己寫過的反面教材(analyst 那次犯了 7 輪)。實測結果:

| 來源 | 結果 |
|---|---|
| TPEx **整站**(openapi + www + web + rwd,9 個端點) | ❌ **全部 403** —— ⭐ **連本專案一直在用、從沒出過事的 `/openapi/v1/t187ap03_O` 也 403** |
| FinMind `TaiwanStockPrice` `data_id='TPEx'` | ✅ **完整 OHLCV + 成交量/成交金額** |
| FinMind `data_id='OTC'`(使用者方案三寫的) | ❌ 回 200 但**空** —— 那個代碼是錯的 |
| FinMind `TaiwanStockTotalReturnIndex` `TPEx` | ✅(但只有 price,沒有 OHLC)|
| yfinance `^TWOII` | ✅ 66 根 |
| yfinance `^TWO`(舊程式用的) | ❌ 抓到**美國 CBOE 選擇權**(`exchangeName:CBO`・`currency:USD`)|

⭐⭐ **兩個關鍵教訓**:
1. **「連已知會通的那條也失敗」是最重要的診斷線索** —— 探針刻意放兩個「已在用」的端點當對照,
   才分得出「端點改版」與「這台 runner 被擋」。⛔ 沒有對照組的話,又會往「再猜一次日期格式」走。
2. 舊註解寫「`^TWO` yfinance 幾乎永遠回空」→ **不是回空,是抓錯東西**(美國選擇權)被過濾掉。
   ⛔ 「回空」與「抓到別的市場的東西」是兩件事,診斷要印出 `meta` 才分得出來。

→ 已修:`_fetch_otc_history_finmind()` 走 FinMind TPEx 為主、TPEX 官網退為備援;ticker `^TWO` → `^TWOII`。

#### ③ 對當沖有沒有幫助?`scripts/otc_bench_probe.mjs` 實測:**幾乎沒有**
⛔ 沒有 `^TWOII` 歷史 → 用「上櫃股票自己的等權中位數」當代理(2,245 檔 / 760 個交易日):

| | 跟**加權**相關(中位) | 跟**自己那組中位數** | 差 |
|---|---|---|---|
| 上市股(1,078 檔) | 0.370 | 0.474 | **+0.104** |
| 上櫃股(1,167 檔) | 0.282 | 0.385 | **+0.104** |

⭐⭐ **兩組的改善幅度一模一樣**,而且 **上市中位數 vs 上櫃中位數 r = 0.961**(幾乎同步)
→ 這**不是**「上櫃自成一個系統」,而是「中位數個股 vs 市值加權指數」的老問題 ——
   那個本專案 V72.0.4 早就量過並已處理(基準勝率是 34.6~36.4% 不是 50%)。
→ ⛔ **抓到櫃買指數對當沖沒有實質幫助**;修好只是把大盤頁那一格補齊 + 上櫃股個股頁能查櫃買 K 線。
⚠️ 限制:上市/上櫃是用 `industry_map` 推導(⛔ 不是官方掛牌欄位);「上櫃中位數」≠ 官方櫃買指數(官方是市值加權)。

### 🌅 外部參考資料的評估紀錄⑩:53 份當沖逐字稿(2026-08-15 使用者上傳)
使用者:「有什麼資料適合優化…另外把沒有用的給刪除,不用一直無限疊加,把有用的濃縮精華,
讓使用者明確知道現在要怎麼操作」。53 份、688 KB(權證小哥 / 巨人傑 / 摩卡 / 兆華艾綸說)。

**⛔ 大部分已評估過**:權證小哥那批 = 評估紀錄④⑥(連次量、買盤竭盡、週轉率、處置股、分點);
巨人傑「不談勝率談賠率、期望值 = 勝率 × 盈虧比」= **本專案 V72.0.3 那次自我修正的來源**,已採納。

##### 🔁 2026-08-18 使用者又上傳 55 份 —— **53 份是同一批檔案**(⛔ 別再讀一次)
使用者第二次上傳(問「有沒有更強的策略 / 全球最強當沖策略 / 只有付費才看得到的策略」)。
⭐ **先做 md5 比對再讀**(9 秒 vs 逐份讀完一個多小時):
```
md5sum 兩批 *.txt | sort → 53 份雜湊完全相同
新增的只有 008.txt / 011.txt = 同一場 2026/08/17 郭哲榮直播的「字幕版」與「影片版」
```
內容是當天盤勢評論(哪幾檔漲停、外資買賣超),**沒有任何可驗證的規則**;
而郭哲榮已於**評估紀錄③**(17 場直播)完整評估過 → **無新資訊**。
⭐⭐ **通用做法:收到「同類型再一批」的附件,第一件事是 `md5sum` 比對,不是開始讀。**
   本專案評估外部資料已 10 次,重複率很高。

**❓ 使用者那三個問題的誠實回答(⛔ 別因為問了就硬生一個策略出來)**:
- 「更強的策略」→ 本專案已實測 **86 種**變體,採用的只有 **2 種**(每天 2 檔、高位階+高波動)。
  ⭐ 這個比例本身就是答案:**大多數「策略」加上去都是少賺**。
- 「全球最強當沖策略」→ **不存在**。逐字稿裡每一條有具體門檻的都被實測否定
  (連次量兩次、開盤跳空、ORB、順大盤 80%)。
- 「只有付費才看得到 / 沒人公開的策略」→ ⭐ **本專案已經有付費工具沒有的東西**:
  `_SIGNAL_EDGE`(129 個訊號的**實測期望值**表)、`broker_perf.flip`(分點隔日沖慣性,實測非人工標籤)、
  關鍵分點 / 地緣分點、104 週集保深歷史、`_dtCostGate`。
  ⛔ 付費工具給的是**更多指標**,本專案給的是**哪些指標實測有效** —— 方向不同,不用去補指標數量。

#### ✅ 唯一落地的一條:**當沖成本關卡**(`_dtCostGate`)—— 而且它**不需要驗證**
⭐⭐ 這是 53 份裡唯一「**不是預測、是算術**」的東西,所以可以直接顯示(同 `_trustVolRatioNote` 的原則):
```
來回成本 = 手續費 0.1425% × 折數 × 2 + 當沖證交稅 0.15%(減半) = 3 折時剛好 0.230%
跳一檔賺多少 % = 該價位的升降單位 ÷ 股價
→ 至少要跳幾檔才回本 = ceil(成本 ÷ 跳一檔%)
```
實測對上逐字稿的每一個例子:**105 元 0.48%(1 檔)・60 元 0.17%(2 檔)・91 元 0.11%(3 檔)・45 元 0.11%(3 檔)**。
📍 放在當沖頁 hero 的大字結論**正下方**(它是**先決條件** —— 回不了本就不用談方向)。
⛔ 文案不可出現「會漲/看多/勝率」(測試 ④b 釘住);差的價位要給替代做法(股票期貨 / 換一檔)。
⚠️ 順手抓到**三份**跳動單位階梯散在 `_roundTick` / `_dtLimitPrice` / 新函式(陷阱 #37)→ 已統一走 `app._tickOf()`。

#### ❌ 「開盤跳空法」(摩卡)—— 實測不成立,⛔ 別再做一次
他的三條件:① 跳空 **+2%~+4%** ② 前 5 分鐘收 K 棒上緣 ③ 前 5 分鐘量 ≥ 昨日全日量 10%。
⭐ **先用便宜的資料排除**:②③ 要 1 分 K(雲端、只有 81 天),但 ① 用**日線就驗得動**(全市場 2 年)——
若「跳空 2~4%」這個母體本身就是負的,②③ 只是它的子集合,救不回來。
`scripts/gap_probe.mjs`(2,470 檔、177 萬筆、開盤買收盤賣、扣同期大盤 + 來回成本 0.25%):

| 跳空幅度 | n | 淨超額中位 | 勝率 | vs 對照 |
|---|---|---|---|---|
| (對照組)所有交易日 | 1,773,078 | −0.48% | 36.7% | — |
| 0~1% | 564,088 | −0.66% | 30.7% | −0.18pp |
| 1~2% | 191,705 | −1.19% | 25.9% | −0.71pp |
| ⭐ **2~4%(他說的)** | 87,409 | **−1.63%** | 26.3% | **−1.15pp** |
| 4~6% | 18,211 | −1.77% | 31.1% | −1.29pp |
| >6% | 14,167 | −1.99% | 27.0% | −1.51pp |

⭐ **單調變差**,而且他說的 2~4% 跟相鄰桶沒有分別 → **那條線是隨口訂的**。
前後半段一致(−1.08 / −1.15pp);再加「昨天收上緣」「昨天爆量」都是 −1.0pp 左右,救不回來。
→ ⛔ **不做,而且不必再花雲端額度去測分 K 版。**

##### 🚨🚨 這支探針第一版**犯了前視偏誤**,寫下來免得再犯
我原本用「**今天**收在 K 棒上緣」當條件 —— 但報酬 `ex` 也是用**今天的收盤價**算的
→ 拿答案當條件,跑出 **+1.20%、勝率 66.4%** 的漂亮數字,**完全是假的**。
⭐⭐ **通用鐵則:凡是「開盤就要決定進場」的條件,只能用開盤那一刻已知的資訊。**
⛔ 不可用「全天 K 棒」代替「前 5 分鐘 K 棒」——那不是近似,是洩漏。
⚠️ 而且它**看起來非常合理**(收上緣 = 買盤強),這正是危險的地方:
   數字漂亮到不合理時,**第一件事是檢查條件有沒有用到未來資訊**,不是高興。

#### 🗑️ 「把沒有用的刪掉」:`🔴 盤中連量偵測` 從常顯區**降級**
本專案已經**測過兩次都不成立**(V71.9.8):日線版 6.5 萬個爆量日,跟對照組只差 **+0.14pp**
而且**方向跟坊間說法相反**;分 K 版(101 天真 1 分 K、扣成本 0.25%)八個情境勝率全在 **18~32%**,
而對照組(量價同向)是 **49~52%**。⛔ 但它一直放在當沖頁**常顯區、還用紅綠下多空**。
→ 移進摺疊區、改中性灰、標「⛔ 本站實測不成立」並**把那三個數字寫在卡上**。
⛔ **不刪掉**(刪了使用者會以為沒這回事,跑去別處學了再回來問)—— 同 `_SIGNAL_EDGE` 對 C 級的處置。

#### ➖ 其餘逐條對照(⛔ 不用做)
| 他說的 | 判定 |
|---|---|
| 「順大盤風向,勝率 50%→60~70%;再看族群領頭羊 →80%」 | ⛔ 那 80% **無實證**。而「順大盤」本專案測過(V73.2.0 regime):少賺但回撤小 = **取捨不是變強**。當沖頁本來就已顯示大盤方向當背景(陷阱 #38 之後改成「⛔ 不計入勝率」) |
| 「選股三關:要有波動、要有量能、價格要好衝」 | ✅ 前兩關 = 自訂選股的「高波動」「成交額」條件;第三關 = 這次做的成本關卡 |
| 「一天只做 N 檔、部位別太大」 | ✅ V73.0.0 已實測**每天 2 檔**最好(27 次實驗裡唯一沒有任何一項變差的) |
| 「大部位要先想好怎麼退場」 | ✅ 出場提醒**不限量**(V72.9.1);停損/停利規則已回測 14 種變體 |
| 「用股票期貨降成本」 | ➖ 觀念正確(已寫進成本關卡的建議),但**本站沒有個股期貨資料源**,⛔ 不做報價 |
| 五檔掛單 / 內外盤 / 委買委賣量 | ⛔ **無歷史資料源**(逐筆委託簿),V72.0.2 買盤竭盡已是能做的極限,且明標未驗證 |
| MACD 零軸起飛當沖術 | ⛔ 他自己另一支影片就叫「為什麼看 MACD 做當沖還是一直賠」;本站 `_SIGNAL_EDGE` 已有 MACD 交叉的實測成績,不另做 |

### 🤖 外部參考資料的評估紀錄⑨:Gemini「進階優化方向」6 項(2026-08-14 使用者截圖)⛔ 全部不做
承評估紀錄⑧(同一份課程的加購頁),6 項各配一顆「加入課程,解鎖實戰程式碼」按鈕。
**逐項驗完:6 項全部不做**,其中 2 項是**當場實測**否定的,不是憑意見。

| # | 它建議的 | 判定 |
|---|---|---|
| 1 | 終極全自動化腳本(Colab + Gradio 儀表板,輸入代號跑全流程) | ➖ **已有且大一個量級** —— 我是 2,700 檔全自動 PWA,不是一次一檔的筆記本;Gradio 那條在⑧已評過 |
| 2 | 引入 **XGBoost / LightGBM**(GridSearch 調參 + Feature Importance 砍指標) | ❌ **實測否定**,見下 |
| 3 | 引入 **LSTM 深度學習**(2D reshape 成 3D、MinMaxScaler) | ❌ 同上,而且更糟(參數更多、樣本更少) |
| 4 | **NLP 情感分析**(爬 PTT 股版 + Gemini 判多空) | ⛔ 違反禁 AI 算數;且 V72.8.0「分析師焦點」8 輪實測後**整組移除**,機房 IP 連 YouTube/Google News 正文都拿不到 |
| 5 | **強化學習**(FinRL / PPO / DQN 交易 agent) | ⛔ 本質是「在同一段歷史上搜尋最佳策略」= 大規模過度配適。本專案手動已測 **86 種**變體、只採用 2 種,RL 的搜尋空間大好幾個數量級 |
| 6 | **隱含資本成本 ICC**(JFQA 2026,含分析師預測偏誤修正) | ⛔ **核心輸入拿不到** —— ICC 要「分析師一致預期 EPS(未來 1~3 年)」,台股**沒有免費結構化來源**;「修正分析師偏誤」更需要歷史預測序列。我的「法人目標價」是純公式(年化 EPS × 產業中位 PE),**不是**分析師預測,⛔ 不可拿來充當 ICC 的輸入 |

#### 🧪 `scripts/ml_probe.py` —— 沙箱沒有 sklearn/xgboost,所以自己寫了一支
實測環境:`numpy / sklearn / xgboost / lightgbm / pandas / torch` **全部 ModuleNotFoundError**
→ 用**純 Python 自己實作 LightGBM 的核心**(直方圖梯度提升 + 深度 2 + logistic loss),
零依賴、只讀 `data/`、50 秒跑完。**2,252 檔 / 211,505 個樣本。**
標籤 = 未來 20 日**超額**報酬(扣同期加權)> 0;⭐ **時間切分**(⛔ 不可隨機切,那會把同一天
不同股票分到兩邊 = 抄答案)+ 中間**挖掉 25 個交易日**(標籤看得到未來 20 日,不挖就是洩漏)。

| | 樣本外(2025-12 ~ 2026-07,57,115 筆) |
|---|---|
| ③ 測試集**基準**(贏大盤比例) | **28.5%**(⛔ 不是 50%) |
| 訓練集 AUC | 0.5680 |
| ⭐ **測試集 AUC** | **0.5216**(0.5 = 丟銅板) |
| 🌲 模型前 10% | 30.3%(**+1.7pp**)・超額中位 **−4.63%** |
| 🌲 模型後 20% | 26.4%(−2.1pp) |
| 🆚 **App 現行「位階 ≥75」一條規則** | **37.7%(+9.1pp)**・n=14,079 |

⭐⭐ **三個結論**:
1. **那 +1.7pp 沒過穩健性** —— 測試集再切前後半:**前半 −1.7pp / 後半 +5.4pp,方向相反**。
2. ⭐⭐ **模型輸給 App 現在用的一條 if**(+1.7pp vs **+9.1pp**)。
   而且**特徵重要度前三名 `dd60` 26.7% / `pos252` 14.9% / `bias20` 13.6%**
   —— 正是 V73.2.3 已經在用的「距 60 日高 + 位階 + 乖離」。
   → **模型只是把既有規則學了一個比較差的版本**,⛔ 沒有帶來任何新資訊。
3. 訓練 0.568 → 測試 0.522 → 那是**過度配適**,⛔ 不是「調參/換 XGBoost 就會好」。

⭐ **佐證**:同一份課程 STEP 16 的副標自己就寫「見證 **50% 擲硬幣勝率**」(評估紀錄⑧)。

⛔ **通用鐵則(這條比 6 項判定本身重要)**:
**「換更強的模型」解決不了「資料裡沒有訊號」。**
判斷任何 ML 提案,先問三件事 —— ① 標籤是不是**未來**報酬(⛔ 同期相關是廢話,見⑧)
② 有沒有**時間切分 + purge**(⛔ 隨機切必定虛高)③ 有沒有贏過**現有那條最簡單的規則**
(⛔ 贏基準不夠,要贏現況)。這三關過不了,再花俏的模型都不用談。
⚠️ ⛔ **這不等於「機器學習在台股永遠沒用」** —— 它證明的是「**這批 K 線特徵 + 這種模型**」
沒有邊際。籌碼特徵要等 2027/05(`foreign_net` 中位只有 28 天)才驗得動。
⭐ `ml_probe.py` 有 `--selftest`(注入必然學得到的洩漏特徵,測試 AUC 必須 >0.8;
實測 **0.9997** 通過)—— ⛔ 沒有這條的話,「AUC 0.52」分不出是沒訊號還是程式壞掉。

### 📚 外部參考資料的評估紀錄⑦:`crawl4ai` 網頁爬蟲(2026-08-07 使用者上傳)
使用者問「我的附件爬蟲有沒有對這個程式有什麼用處」。逐項查完,結論存這裡**免得再讀一次**。

| 可能的期待 | 實際 |
|---|---|
| 拿 YouTube 逐字稿 | ⛔ **它沒有這個功能** —— `grep -ril "timedtext\|captionTrack\|transcript" crawl4ai/` = **0 個檔** |
| 繞過 YouTube 同意頁 | ✅ 做得到(真瀏覽器 + `playwright-stealth`)|
| 把新聞頁變成乾淨正文 | ✅ **這才是它真正的價值**(`PruningContentFilter` / `BM25ContentFilter`)|

⛔ **決定不整包引入**,三個理由:
① 依賴很重:`playwright` + chromium(~400MB)+ `litellm` / `nltk` / `numpy` / `shapely` / `alphashape`,
   而 `news_express` 一天跑 10 次 → 每次多 2-4 分鐘安裝,不划算。
② 我們要的只有「HTML → 乾淨正文」那一小塊 → **照它的觀念自己寫 10 行**(`analyst_miner._main_text`:
   先砍 script/style/nav/footer/aside,只留 `<p>`,丟掉 <20 字的段落)。
③ 它的 `LLMExtractionStrategy` 讓 AI 做抽取 → 跟「禁 AI 算數」同族的問題,而且燒 token。

⭐ **真正解決問題的是它的「觀念」不是它的「套件」** —— 這條可以套用到日後任何外部工具評估:
   先問「我需要的是它的**哪一個函式**」,而不是「要不要裝它」。

⚠️ 若哪天真的需要繞過同意頁(YouTube 搜尋頁對 GitHub 機房 IP 回同意頁,V72.6.8 實測
   `CONSENT=YES+cb` cookie **無效**),再評估**只裝 playwright**(專案已有 Chromium,
   `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`),⛔ 不必為此裝 crawl4ai。

### 🗑️ V72.8.0 「分析師焦點」**已整組移除**(使用者要求)⛔ 別再做一次
使用者看完成品:「我覺得你這樣做都沒有用」→ 下一輪直接說「這個功能刪除」。
**下面整節保留為決策紀錄**,說明為什麼這條路走不通 —— ⛔ 日後有人想再做一次,先讀完這節。
一句話總結:**拿得到的只有標題,而標題對使用者沒有用**(`analyst_probe.py` 四組實測見下)。

### 🎙️ V72.6.x~V72.7.0 分析師焦點 —— 六輪實測踩到的坑(⛔ 別重蹈)
`analyst_miner.py`(兆華與股惑仔 / 兆華艾綸說 / 股癌 / 郭哲榮)。**每一輪都是實跑輸出抓到的**:

| 輪 | 症狀 | 真因 / 修法 |
|---|---|---|
| 1 | Google News 保底回**別人的節目**(搜「兆華艾綸說」得到《理財達人秀》《理周飆股列車》)| GNews 是模糊比對 → `must`:標題**必須真的出現他的名字**才收;全不符就留空。⛔ 那比「沒有資料」更糟 —— 使用者會以為那是他講的 |
| 2 | 股癌抽到 **5903 全家** | 那是**贊助商**。`_topic_part()` 切掉「贊助/業配/優惠碼/訂閱…」之後的內容;並把大綱抽到的標成 `via:'x'` 與標題抽的分開顯示 —— **證據強弱不同就不可以長得一樣** |
| 3 | 上一版的過濾**對已經存進去的沒生效** | 舊版把「已經有 syms 就跳過」當冪等 → 規則改了不重算。⭐⭐ **冪等要冪等的是「歷史事實」(px/mkt),不是「規則的產物」(syms)** → `SYMS_V` 版本號,重算時用 `_keep` 保住價格快照 |
| 4 | 兆華兩位 0 則,`@guhuozai` 解到的頻道最新片是 2025-09 | 解到別人的頻道 → 加「最新片超過保留天數 = 可能解錯」診斷;並改成「讓 YouTube 自己說」(搜尋頻道),⛔ 但頻道名要含 `must` 才採用,**不硬選第一個** |
| 5 | 兆華兩位仍 0 則,但 log 寫 `GNews → 3 則 / 9 則` | 🚨 **被我自己設的 `KEEP_DAYS=14` 濾光**。`fresh=9` 配 `items=0` 就是線索,兩個數字要一起看。→ 60 天,新舊靠排序+相對日期表達,⛔ 不用一刀切 |
| 6 | YouTube 搜尋回 0 候選 | 上一輪補的診斷直接說出真因:**`HTML 768KB 但抓不到頻道配對(同意頁)`**。⛔ 沒有那行診斷,下一個人只會去改 regex,永遠改不對 |
| 7 | 「標題沒有用」(使用者)| 股癌標題就是「EP685 \| 🤓」→ 改抓**內容**:🎬逐字稿 / 📝shownotes / 📰新聞正文,標的從內容抽,前端顯示摘要並標來源層級;抓不到就誠實說「只有標題」 |
| **8** | **使用者:「我覺得你這樣做都沒有用」** | 🚨 **前 7 輪全是「改採礦機 → 等 workflow → 看輸出 → 再改」,每輪 10 分鐘、每次只驗一個假設** —— 違反本專案自己的「探針先行」鐵則。→ 寫 `analyst_probe.py`(只讀、手動觸發)一次試完四組,**9 秒**給出全部答案 |

#### 🧪 `analyst_probe.py` 的實測結論(2026-08-07,⛔ 別再往這幾個方向試)
| 組 | 結果 |
|---|---|
| **A. YouTube 逐字稿** | ❌ **1/4** —— watch 頁不管帶不帶 `CONSENT` cookie 都回**同意頁**(1180KB/1080KB 裡零條字幕軌);`youtubei/v1/player` 那把公開 key 回 **HTTP 400 Precondition check failed**。⛔ **GitHub 機房 IP 拿不到逐字稿**,別再試 |
| **B. Podcast shownotes** | ⚠️ 抓得到(206/422/355 字)**但整段是贊助文案** —— 「人類又找回勇氣了 本集節目由【NordVPN】贊助 優惠碼…」。⛔ **不是抓錯,是股癌就這樣寫**,切掉贊助只剩一句標語 |
| **C. 新聞正文** | ❌ Google News 新連結格式(`CBMi…`)**不再 redirect、頁面也沒有 `<a href>` 可撈** → 正文實測 **0 字**。⛔ 別再為追內文每則打一槍 |
| **D. 兆華兩位頻道** | ❌ **0/10** —— 4 個 handle 全 404,YouTube 搜尋 **0 個候選**(同意頁)。`@guhuozai` 是**砌磚工**的頻道 |

⭐ **但探針照出真正的缺口**:`_fetch_full_name_map` 來自 **TWSE/TPEX 公司基本資料** →
**一檔 ETF 都沒有**,而郭哲榮的新聞標題滿滿是「0050」「00981A」→ 全部抽不到。
⭐ 修法**不是**去弄一張 ETF 名稱表(那又是一份要維護的清單),而是
**拿代號直接問 `data/{code}.json` 存不存在** —— 有 K 線就是有效標的,自動涵蓋
ETF/槓桿反向/主動式,零維護;而且「1200萬」這種假代號天然被擋掉。

⭐ **落地結論**:影片類只給標題與連結(誠實標「這個節目不公開當集大綱」);
**媒體報導那類反而最有內容**(記者已把重點寫進標題)→ 標 `headline`、⛔ 不再顯示「內容抓不到」。

⭐⭐ **三條可以帶走的通則**:
① **「沒有資料」先查「是不是被自己這邊擋掉」**(第 5 輪;同 V72.3.3 新聞太舊那次)。
② **加任何過濾/抽取規則時,先問「已經存進去的髒資料怎麼辦」**(第 1、2、3 輪都栽在這)。
③ **先加診斷,再下結論**(第 6 輪);而診斷要**寫進 JSON**不是只印 log —— job log 會過期。
④ ⭐⭐ **會需要「改→等 workflow→看結果」超過兩輪的事,先寫探針**(第 8 輪)。
   探針 9 秒給完四組答案,而前 7 輪花了一個多小時只驗了 7 個假設。
   ⚠️ 本專案對 ORB / sector_flow / tdcc / floorcount 都乖乖照做了,**只有這次沒有** ——
   因為「這只是接個 RSS,應該很快」的直覺。⛔ 那個直覺就是要警覺的訊號。

⛔ **這一頁永遠不下多空、不計分**:名嘴說法的預測力從未驗證過(CLAUDE.md 對郭哲榮那份
評估已寫明他「準」的一半是話術結構)。價格快照從今天開始累積,**樣本夠了才談誰準**。
測試 `scripts/test_analyst_miner.py`(60 條)+ `scripts/test_analyst.mjs`(26 條)。

### 🕳️ V72.5.1 集保「13 週」是我自己設的上限,不是資料的限制 ⭐⭐ 這條可能是本專案最大的一次自我解鎖
使用者丟了一張 Gemini 講「怎麼查台股集保戶股數分佈(千張大戶與散戶比例)」的截圖。
**它講的每一項我都已經有了**(`tdcc_sweep.py` 直接抓 TDCC OpenData `id=1-5`,零金鑰、每週更新,
15 級距壓成 千張大戶 / 400張大戶 / 散戶 三個比例 + 散戶人數 + 總股數;前端已用在 6 處)。

🚨 **但順著查下去發現真缺口**:`KEEP_WEEKS = 13` 與 `start = now − 100 天`
**是當初隨手設的,不是資料的限制**。CLAUDE.md 有四、五條功能長期卡在「只有 13 週 → 樣本不足」:
兩上兩下(V71.9.0)・散戶結構(V72.4.5)・**千張大戶連週增減(多空規則 C7,weight 3,從沒驗證過)**・
大戶單週 ±3% 門檻(權證小哥 f49)・集保戶數(V71.9.7)。

⭐⭐ **而加深的 API 成本是零** —— FinMind `TaiwanStockHoldingSharesPer` 一檔仍然只打**一個**請求,
只是 `start_date` 往前推。⛔ 唯一代價是檔案大小 → 所以拆成兩個檔:

| 檔案 | 週數 | 誰在讀 |
|---|---|---|
| `tdcc_holders.json` | **13**(⛔ 不可變大) | **前端**(每次開 App 整份下載,13 週已 1.9 MB) |
| `tdcc_deep.json` | **104** | **只給探針/回測**(⛔ 前端不 fetch;約 16 MB,**只推 data 分支不推 gh-pages**) |

⛔ **四個必須留著的設計**:
① **跳過條件改綁「夠不夠深」**(`DEEP_ENOUGH`)—— 舊版 `len(h) < 2` 一跑過就永遠跳過,
   **這就是深度卡了那麼多版的真因**(陷阱 #10 的同型:快取判斷綁「有沒有做過」而不是「內容夠不夠新」)。
② **workflow 要先從 data 分支還原深檔**,否則每次都從頭抓、永遠加不深(且要 `[ -s ]` 驗非空,V49.4 教訓)。
③ **深檔 <200 檔不覆寫舊檔**(同 fund_sweep 的自我保護)。
④ **同一份 rows 寫兩個檔**,⛔ 不可為了深檔多打一次 API。

#### 🚨 V72.5.3 覆蓋率只有 55% 的真因是**金鑰權限**,不是逾時 ⭐⭐ 這條是「別用推論當結論」的教科書案例
首跑只拿到 1,003 檔、**連 2330 都缺**。我當時**推論**是「老牌大股 2 年資料量大、30 秒逾時不夠」,
還把這句話白紙黑字寫進註解。→ 加了 `REASON` 分類統計之後,實測是:
```
http403×2442 ・ http400×1549 ・ degraded_half_window×357 ・ timeout×0
```
**`timeout` 一次都沒有** —— 真因是 `_fetch_once` 遇到 **403 直接 `return []`,不換下一把 token**。
使用者的 4 把 `FINMIND_TOKENS` 並非每把都是付費層(台指 VIX 那次已查過:有的回
`Your level is register`、有的無效)→ 一檔只要**剛好輪到壞的那把**就整檔放棄,
覆蓋率因此被鎖在「好 token 的比例」≈ **55%**(實測 2,272 / 約 4,000)。
→ 403/401 改成 `continue` 換 token 再試。
⭐⭐ **通用鐵則:先加分類統計,再下結論。** 沒有 `REASON`,下一個人會照著我那句錯的註解
往「調 timeout」的方向修,永遠修不好。⚠️ 同時注意 **403 被算成「空」不是「敗」** ——
`敗 0` 看起來很健康,其實有 2,442 次權限失敗躲在「空」裡面。

⚠️ **沙箱連不到 FinMind(proxy 403)→ 這件事只能靠 Actions 實跑驗證**。
   跑法:Actions → `🏦 集保大戶散戶週採礦` → Run workflow → **backfill 選 `yes`**。
   log 會印「🕳️ 深歷史:N 檔有資料,週數中位 M」——**M 沒有明顯大於 13 就代表 FinMind 那邊給不到,
   要回頭查資料集的歷史深度**,⛔ 別假設它一定成功(同陷阱 #9:rc=0 不等於功能有跑)。
測試 `scripts/test_tdcc_deep.py` 26 條(stub 掉網路,只釘合併/保留/跳過/自我保護/workflow 接線)。

### 🧭 V72.5.2 集保「四象限矩陣」與「隱藏大戶扣抵」—— **兩個都實測不成立**(⛔ 別再做一次)
使用者貼了一整串 Gemini 對話(集保四象限、法人 vs 千張大戶衝突判讀、隱藏大戶扣抵、
地緣分點、隔日沖),問「這些資料可以怎麼運用?能不能用圖表一眼看懂」。
`tdcc_matrix_probe.py` 拿**新產出的 104 週深歷史**實測(676 檔 × 28,532 筆事件,扣同期加權):

**❌ ① 四象限矩陣(千張大戶 × 股東人數)不成立**

| 象限 | 它的說法 | 5日 | 20日 | 60日 | n |
|---|---|---|---|---|---|
| 大戶↑ 人數↓ | **主力吸籌·偏多** | +0.16 | +0.34 | +1.04pp | 9,456 |
| 大戶↓ 人數↑ | **籌碼渙散·偏空** | +0.05 | +0.33 | +0.92pp | 8,344 |
| 大戶↑ 人數↑ | 共識追捧 | +0.24 | +0.59 | +0.14pp | 4,507 |
| 大戶↓ 人數↓ | 冷門退場 | +0.14 | +0.34 | **+1.81pp** | 5,734 |

⭐ **三個致命點**:① 它說「偏多」跟「偏空」的兩格 60 日只差 **0.12pp** ——完全沒有多空鑑別力
② 它說最差的「冷門退場」反而**最好**(+1.81pp)③ **交互作用全部是負的**(−0.06 ~ −1.23pp)
= 兩條腿交叉之後**比各自相加還差** → 這個矩陣沒有帶來任何新資訊。
⚠️ 而且四格**全都**比對照組正 —— 那是**選樣效應**(有事件 = 籌碼有在動的股票),不是訊號。

**❌ ② 隱藏大戶扣抵(大戶異動張數 − 該週法人買賣超)也不成立**

| 桶 | 20日 | 60日 | n |
|---|---|---|---|
| 隱藏大戶 **賣** >3,000 張 | +1.47 | **+3.37pp** | 3,540 |
| ±300 內(沒動) | **−0.32** | **−0.24pp** | 7,652 |
| 隱藏大戶 **買** >3,000 張 | +1.19 | +2.82pp | 3,395 |

🚨 **買賣兩邊都是正的,而且「賣」比「買」還好** → 這**不是方向訊號**,
是「**動得多 vs 動得少**」的代理(唯一負的那格是「沒動」)。⛔ 不可做成多空。
⭐ 通用教訓:**看起來像訊號,其實是「活躍度」** —— 分桶時一定要看**反方向那一桶是不是也正**。

**✅ 已經有的(逐條對照,⛔ 不用做)**:地緣分點 + 關鍵分點(V71.9.8)・隔日沖分點慣性
(V71.9.6 + `broker_perf.flip`,而且**實測優先於人工標籤**,V71.7.2)・董監質押・集保戶數。
**⛔ 沒有的**:自由流通股數(Free Float,需扣董監/政府基金,無結構化來源)——
⛔ 別用「400 張以上比例」硬當代理,那是兩回事。

**✅ 實際落地的只有一個「圖表化」**:`_tdccWhoIsBuyingHtml` —— 集保分佈卡裡加**兩排迷你週趨勢**
(大戶 vs 散戶),一眼看出「誰在收、誰在放」+ 起訖值與變化量。
⛔ **只做事實描述、不下多空**,而且卡上必須留著上面那組實測數字當免責。
測試 `scripts/test_tdccwho.mjs` 28 條(把「不可出現偏多/偏空/操作指令」釘死)。

### 🔁 V73.8.7 「怎麼常常是同幾檔?」—— 感覺是對的,而且順手抓到排序打架
使用者看著會賺訊號清單問:「會賺錢訊號怎麼感覺是這幾隻」。

📊 **先量再答**(⛔ 不憑感覺回「不會啦」):隔 3 個交易日(08/19 → 08/24)
| | 舊 | 新 | 重疊 |
|---|---|---|---|
| 全清單 | 167 檔 | 164 檔 | **111 檔 = 68%** |
| 前 12 名 | — | — | **5/12** |

⭐ **他的感覺是對的,但這是設計的必然,不是 bug**:
清單問的是「**這一檔自己歷史上最會賺的那一招**」,而**歷史成績不會天天變**
→ 會不會上榜主要看它的歷史;**每天真正在變的是「離觸發價還有多遠」**。
⛔ **不可為了「看起來新鮮」硬換一批** —— 那等於用隨機性冒充多樣性,把最會賺的幾檔擠掉。
📍 落地 `_pbWhySameHtml(picks)`:清單裡一行**摺疊**說明(⛔ 沒新增卡片、預設收起不佔版面),
   打法佔比**現算**(⛔ 不寫死),並點明「最多的打法是全市場最常出現的型態,**不是它比較厲害**」。

#### 🚨 順手抓到的真 bug:看到的順序 ≠ 會被通知的順序
| | 排序鍵 |
|---|---|
| `_tomorrowWatchHtml`(使用者**看到**的清單) | `(自己的) \|\| (保守下界)` ⛔ **沒有 🧬** |
| `_eodTriggerSweep`(真的會**通知**他的) | `(自己的) \|\| (🧬) \|\| (保守下界)` |

→ 使用者看到的第 1 名,可能不是真的會推播給他的那一檔(**邏輯打架**)。
⭐ 而 V73.2.9 已實測「不挑 🧬 整套輸 0050 一百多萬」→ **🧬 是必要條件不是加分項**,
   清單當然也要照它排。已統一(兩處都吃 `settings.pbHqOff` 開關)。
⛔ **同一套規則寫兩份,遲早只改到一邊**(陷阱 #37)—— 測試 ①b 直接比對兩支函式區塊的排序鍵,
   已用「把清單那邊的 hq 拿掉」注入驗證過。

⚠️⚠️ **這支測試自己改了三次才對**,每一次都是「斷言在猜實際輸出長什麼樣」:
① 用 `list.slice().sort(` 全檔比對 → 抓到**第三個**不相干的排序而誤判
   → 改成只看那**兩支函式自己的區塊**。
② `>10</b>` 抓不到(有 class 屬性)→ ③ 改 `">10</b>` 又抓不到(class 被 strip 掉後前面不是引號)。
③ 測資兩組都用 `String(1000+i)` → 檔號重疊,檔數變 8 不是 10(**測資自己錯,不是程式錯**)。
⭐ **通用:斷言 HTML 內容前先把它正規化,⛔ 別去猜實際輸出長什麼樣子**;
   而且**測資要先自己驗一遍**,不然會把測資的錯當成程式的錯。
測試 `scripts/test_pbsort.mjs` 15 條。

### 🚨🚨 V74.0.5 「分點一直卡在不到 20 天」的真因:**FinMind 帳號掉回免費層**(⛔ 不是程式、不是 GitHub)
使用者:「分點為何一直卡在不到20天,是key問題,還是github免費帳號問題,有沒有辦法抓到1年以上分點」。

#### 📊 先量三件事(⛔ 不憑印象)
| 量什麼 | 實測(2026-08-30 讀 gh-pages) |
|---|---|
| 分點最新資料日 `data_date` | **多數停在 2026-07-28**、最新的也只到 **08-14** → **一個月沒進新資料** |
| `chips_fetched_on` | 07-28/29/30(採礦有在跑,但**抓不到東西**) |
| `hist` 天數 | **中位 1 天**(⛔ 不是 20 天;只有 15% 的 hot 股有 17 天) |
| `bstat` 累計 | 只有 **17/120 檔**有,days 中位 14 |
| gh-pages 體積 | **452 MB / 上限 1,024 MB** → ⭐ **還剩 572 MB,空間根本不是瓶頸** |

#### 🚨 真因(從 job log 逐字讀到的,⛔ 不是推理)
```
📋 分點籌碼目標(全市場滾動):85 檔 | 熱門深度 256 檔 | 批次 0/1 | 付費=None
⚠️ FinMind:付費失效/未生效(4 把 token 全試過)→ 自動降版免費模式(分點只用 BSR)
   逐把探測:…status=400/Your level is register. Please update your user level. …(4 把全部同一句)
✅ 分點籌碼完成:更新 0 檔、今日已抓跳過 63 檔
```
⭐⭐ **`Your level is register` = 金鑰是通的,但帳號等級掉回免費層** —— ⛔ 不是 token 無效、不是過期、不是額度用完。
⚠️ 跟 2026-07-30 台指 VIX 那次**不一樣**(那次是 1 把 register + 2 把 `Token is illegal`),**這次 4 把全部 register**。
⛔ **完全沒有 402/403/429** → 不是付費牆、不是 IP 被擋、不是限流。

🚨 **連帶停擺的不只分點,是 10 項付費資料集**:八大行庫・借券・集保分級・官方處置・產業鏈・當沖比・
外資水位・鉅額交易・可轉債・權證溢價,全部印「未付費,跳過(降版)」。

⭐ **而且會自我循環卡死**:`_corpus_latest_dt` 是拿「現有 chips 檔的 P95 日期」推估的
→ 全部停在 08-14,基準就是 08-14 → 每檔都判「已追上」→ 跳過。
V71.3.6 本來寫了解法(用台積電探上游真實最新日把基準拉上去),⛔ **但那段被 `if paid:` 包住**
→ log 裡 `🎯 上游最新分點日` 出現 **0 次**,整段沒進去。它自己的註解就寫著「沒有這段,晚上那輪會 100% 空轉」。

#### ⛔ 兩個常見誤判(使用者問的正是這兩個)
| 猜測 | 實測 |
|---|---|
| 「是 key 的問題嗎」 | ✅ **是**,但精確說是**帳號等級**不是金鑰本身(4 把都通、都被判 register) |
| 「是 GitHub 免費帳號的問題嗎」 | ❌ **不是**。gh-pages 452/1024 MB、Actions 分鐘數 public repo 不計費、workflow 全綠 |

#### 📐 「能不能抓 1 年以上分點」—— 能,而且 API 成本極低,卡的是**存法**
⭐ V71.2.6 的「單日全市場批次」(省略 `data_id` 只給日期)→ **一次呼叫 = 該日全市場**
→ 1 年 ≈ **245 次呼叫**,對 6,000 req/hr 是零負擔。⛔ **不是** 245 × 2,653 次。

實測每天每檔 `hist` 約 **759 bytes**(60 檔抽樣),推算:
| 存法 | 1 年體積 | 判定 |
|---|---|---|
| 全市場逐日明細 | **471 MB** | ⛔ 剩 572MB 塞得下但前端每次下載爆炸,不做 |
| ⭐ **熱門 220 檔逐日明細** | **39 MB** | ✅ **最實用** |
| ⭐⭐ **`bstat` 回算** | **約 7 MB(深度無上限)** | ✅ 機制已經有了,只是**沒回算過** |
⭐ `bstat` 的 `seen` 上限本來就寫 400 個交易日(≈1.5 年),**目前只有 18 天純粹是因為它從 2026-07-22 才開始往前累積**
→ 只要把過去 245 天的批次結果餵進 `_accum()` 就能一次灌深,⛔ 不用等一年。

⏳ **但這三件事全部要等付費層恢復** —— ⛔ Claude 讀不到也改不了 Secrets,只有使用者能處理。
⚠️ 恢復之後**要實跑驗證**,⛔ 不可看綠燈就宣告好了(陷阱 #9 / V74.2.1 的教訓):
```bash
git show origin/gh-pages:data/chips/2330.json | python3 -c "import sys,json;print(json.load(sys.stdin)['chips'][-1]['date'])"
```

#### 🔐 順手修掉的兩個真問題
① **金鑰片段被印進公開的 Actions log** —— `miner.py` 印 `tok[:6]…tok[-4:]`(每把外洩 10 字元)、
   `finmind_check.py` 印 `tok[:8]…tok[-6:]`(14 字元)。這個 repo 是 **public**,job log 也是公開的。
   ⭐ 診斷需要的只有「**第幾把** + 長度 + 錯誤訊息」。CLAUDE.md 早就寫著這條規則,
   ⛔ **但它之前只存在文件裡沒有守門,所以被違反兩處都沒人發現**
   → `scripts/test_no_token_leak.py`(納入四驗證第 2 項),已用注入驗證。
   ⚠️ 該守門第一版 regex 太寬(把 `raw`/`key` 也算進去)→ **誤報 19 處**
   (`raw` 是 K 線列的常用變數名)→ ⭐ **工具報出來的數字,拿去做決策前要先驗工具本身**。
② **BSR(免費分點)每一條失敗路徑都靜默** —— 那一輪「嘗試 22 檔、更新 0 檔」但 log **一行輸出都沒有**
   (6 條 `continue` / `return None` 全部不印)。⭐ 同 V72.5.3 集保那次的教訓:**先加分類統計再下結論**。
   → `_BSR_REASON` + 收尾印出;`updated == 0` 時直接印出「真因通常在帳號等級」那句。

### 📚 V74.0.6 「1 年全市場逐日分點」怎麼做 —— **666 MB 是存法的問題,不是資料的問題**
使用者:「1年全市場逐日要怎麼做」(承上一節,我原本把這條標成 ⛔ 太冒險)。

#### 📐 先量:同一份資料,換存法差 7 倍(實測 150 檔抽樣)
| 存法 | 1 年(245 交易日 × 2,653 檔) |
|---|---|
| 現在的(券商**名稱** + 未壓縮 + 塞進 2,653 個個股檔) | **666 MB** ⛔ |
| 改存券商**代號**(名稱平均 19.5 bytes → 代號 4;**佔總體積 51%**) | 397 MB |
| ⭐ **代號 + gzip(實測壓縮比 4.4×)** | **90 MB** ✅ |
⭐ API 成本本來就不是問題:**單日全市場批次**(V71.2.6,省略 `data_id`)→ 1 年 = **245 次呼叫**。

#### 🏛️ 三個架構決定(`scripts/chips_backfill.py`,⛔ 別改回去)
① **一天一個檔** `data/chips_deep/YYYY-MM-DD.json.gz`,⛔ **不是塞進 2,653 個個股檔**。
   每天只新增 1 顆 blob(~370 KB);塞進個股檔的話**每天要改寫 2,653 個檔**,git diff 會爆炸。
② **只推 data 分支,⛔ 不上 gh-pages** → 前端維持 20 天輕量版,**下載量完全不變**。
   先例:`tdcc_deep.json`(V72.5.1,104 週只推 data)、`inst_cache_stock.json`(V69.9.6 移出 gh-pages)。
③ **每側各留前 15 家**(跟現有 `hist` 一致)。⚠️ 是「**每側**各 15」不是「總共前 15」——
   後者會讓賣方被買方整個擠光(測試 ② 用 40 買 + 40 賣的測資釘住,注入驗證抓得到)。

#### 🚧 四個守門(⛔ 都不可拿掉)
・**沒有付費層直接 exit 1** —— 2026-08-30 實測 4 把金鑰全部 `Your level is register`,
  那時候硬跑只會產出一堆空檔。
・單日回來的股票數 < 200 → **整天不寫檔**。⛔ 不可寫半份 —— 冪等靠「檔案存不存在」,
  寫了半份之後那天**永遠補不回來**。
・**已存在的日期預設跳過**(冪等)→ 中途失敗直接再跑一次接續。
・收尾印**分類統計**(同 V72.5.3 集保的教訓:「0 天成功」要說得出為什麼)。

#### 🚨🚨 V74.0.7 付費恢復後實測:**「省略 data_id 拿全市場」那條路根本不通**(⛔ 我上一版的成本假設是錯的)
2026-08-30 使用者恢復 FinMind 付費(4 把 token 裡**第 1 把**通,rows=3759)。一驗才發現:
```
❌ A 專用端點 date=            400 / parameter data_id can't be none on TaiwanStockTradingDailyReport
❌ B 專用端點 + 空 data_id      400 / 同上      ❌ C dataset 形式 date=        400 / 同上
❌ D dataset start_date=       400 / 同上      ❌ E dataset start+end         400 / 同上
❌ F 分點聚合 SecIdAgg          (不存在)
✅ G `securities_trader_id=9200&date=X`   200 / 4,005 列
✅ 🆚 對照·八大行庫(省略 data_id)         200 / 13,392 列
```
⭐⭐ **對照組是決定性的**:同樣省略 `data_id`,八大行庫回 13,392 列、分點回 400
→ **不是帳號等級不夠,是這個 dataset 就是不給省略 `data_id`,升級也沒用。**
⛔ CLAUDE.md V71.2.6 寫的「省略 data_id → 回該日全市場」**對分點已經不成立**(或從來沒成立過)。

🚨 **而且我的探針自己下錯了結論** —— 它看到 G 回 200 就宣告「有可用的批次寫法 → 245 次呼叫」。
⛔ 錯了 2 個數量級:**G 是「一家券商 × 全市場」不是「全市場所有分點」**。
⭐ 通用:**「回 200」不等於「回的是我要的東西」** —— 探針的自動結論也要人工驗。

#### ⭐⭐ 正解:換一個軸 —— 按「**券商**」抓,不是按「股票」抓
分點淨額**極度集中**(實測 2,074 個分點檔、475 家券商):
| 前 N 家券商 | 覆蓋 \|淨額\| | 1 年呼叫數 | 時數(6,000/hr) |
|---|---|---|---|
| 30 | 87.3% | 7,350 | 1.2 h |
| 100 | 94.7% | 24,500 | 4.1 h |
| ⭐ **200** | **97.8%** | 49,000 | **8.2 h** |
| (按股票抓) | 100% | **650,285** | ⛔ **108 h** |
→ **按券商抓比按股票抓省 13 倍**,前 200 家就有 98% 覆蓋。
⚠️ GitHub Actions 單 job 上限 6 小時 → 用 `--from/--to` 分段跑(腳本是冪等的)。

⚠️ `top_brokers()` 第一版讀 `hist` 再用名稱反查 `broker_names.json` →
   **906 個反查不到、只湊出 18 家**(hist 只存名稱且帶戰術標籤)。
   ⭐ 正解:讀 `chips[].buyers/sellers[].bid` —— **那裡本來就有券商代號**。
   ⛔ 別再走名稱反查那條路(測試 ⑨i 釘住)。

#### ✅ V74.0.8 已上線並開跑(使用者:「該挖礦就挖礦…要挖兩年回撤準確度才有效果」)
**上游深度探測(7 次呼叫,⛔ 別花 16 小時才發現第二年是空的)**:
```
   2 天前 ✅3,681 列   365 天前 ✅3,191 列   1,095 天前 ✅4,004 列
  30 天前 ✅11,976 列  730 天前 ✅6,304 列
```
→ **至少 3 年**都抓得到,2 年綽綽有餘。付費 1 把 / 免費 3 把,分點額度 6,000 req/hr。

🏛️ **`chips_backfill.yml`(手動)推獨立的 orphan 分支 `chips_deep`** —— ⛔ 不碰 data 也不碰 gh-pages:
・那兩個分支都是 daily_miner orphan force-push 重建的,這支跑 6 小時**一定互相覆蓋**
・gh-pages 那步是 `git add -f index.html data/`(**整個 data/ 都收**)→ 放進 `data/` 會把
  ~170 MB 深歷史推上前端。⭐ 所以檔案放**頂層 `chips_deep/`**,不是 `data/chips_deep/`。
・⭐ **附帶好處:現有 workflow 一行都不用改。**
🚧 兩道推送守門:① 一天都沒有就拒推 ② 天數少於分支上已有的就拒推
  (orphan force-push 會**整個取代**,少了就是真的沒了)。

📊 **試跑實測(10 天,⛔ 先驗管線再排長工作)**:
每天 **2,691 檔**、gz 後 **~350 KB/天**、速度 **1.4 分/天**
→ 2 年(490 交易日)≈ **11.4 小時 / 171 MB**。分 4 段跑(單 job 上限 6 小時)。
⚠️ **一次只能排一段** —— concurrency group 只留一個 pending,多排的會互相擠掉(V73.7.9 的教訓)。

### 🚨🚨 V74.0.8 回測深歷史**永遠停在最後一次手動回算那天** —— daily_miner 只讀不寫
使用者:「重點是資料不要落後,可以最新就最新,回測數據要準確」。查下去發現的是**這個**:

`daily_miner` 每天用按券商批次抓到**全市場**分點 → 寫進 2,700 個個股檔 → 被 `CHIP_HIST_KEEP`(22)
截掉丟棄。而 `chips_deep`(回測用的深歷史)**只有 `chips_backfill.yml` 手動跑才會寫**
→ 分支永遠停在 **2026-08-28**,而所有分點回測都靠它。
⚠️ CLAUDE.md V74.0.6 原本寫著「維持:daily_miner 每天按券商批次自動接著存」—— **那句話是錯的**,
   ⭐ 通用:**寫「之後會自動維持」時要當場確認那條路真的接上了**,不然它就只是一句願望。

⭐ **修法(零額外 API —— 資料本來就在手上)**:`_fetch_chips_bulk` 每抓到一天,順手
`chips_backfill.compact_day/write_day` 存成 `chips_deep/YYYY-MM-DD.json.gz`;
artifact 收 `chips_deep/`;deploy job 加一步累加推上 `chips_deep` 分支。
⛔ 四條守門:① 壓縮/欄位**共用 chips_backfill 同一支**(⛔ 不另寫一份)
② 單日股票數 < `min_syms` ⛔ 不寫(半份的天會讓冪等誤判)
③ **只增不減** —— 先還原分支現有的天再加今天的,天數變少就**拒推**(orphan force-push 會整個取代)
④ `continue-on-error: true` —— 這步失敗⛔ 不可影響 gh-pages/data 的部署

### 📊 V74.0.8 順帶查清的三件事(使用者問「一天抓得完嗎、要不要加付費 key」)
**⛔ 兩個猜測都不是**:
・**不是 GitHub 慢** —— 時間全花在等 FinMind 回應(受 100 req/min)
・**不需要加付費金鑰** —— 按券商抓之後 **200 次呼叫 = 一整天的全市場分點**,
  穩定狀態(每天 1 個新交易日)= **2.1 分鐘 = 一小時額度的 3.3%**。
  一小時的額度可以抓 **30 個交易日**的全市場。痛點只在「斷線後補 22 天」(46 分)——
  而那個已經被 `chips_deep` 零 API 還原解掉。

**⛔ 兩個看起來合理但實際無效(⛔ 別再提)**:
① **matrix 平行 20 台**:共用同一把 key 的 6,000/hr → 互相擠成 429,一秒都省不下來
   (daily_miner 的 K 線用 matrix 有效,是因為那些是**免費** API,不受這個限制)
② **用另外 3 把免費 token 分攤**:免費層對分點這個 dataset 回 `Your level is register`

**🔍 「前 200 家券商漏掉的 85 檔是誰」**:全部是**債券 ETF / 槓桿反向 ETF / 極冷門股**
(00749B~00844B 那一整排、1341、2073…),抽驗 16 檔**當天全部沒有 K 棒**(根本沒交易)。
⭐ 所以那不是券商不夠,是那些股票那天沒人買賣 —— **調到 300 家救不回來**。
⚠️ 其中 `0054`/`0059` 的 K 線停在 **2017 年**(已下市),`data/` 裡還留著空殼。
📌 使用者仍要求調到 **300**(`CHIPS_BULK_BROKERS`,+100 次/天 ≈ +1 分鐘)→ 已調;
   它換到的是「每檔前 15 名券商的淨額涵蓋率」再往上,⛔ 不是把那 85 檔救回來。

**✅ 現況實測**(2026-08-31):K 線 **2,679/2,712 檔**到最新交易日;分點 **97%**;
一輪更新 2,689 檔(修前 172)。

### 📅 V74.0.7 `hist` 中位只有 2 天 —— 真因是「每輪只存今天那一筆」,不是抓不到
V74.0.6 修好全市場覆蓋(一輪 172 → **2,689 檔**、`data_date` 到最新交易日 4% → **97%**)之後,
`hist`(逐日分點快照)天數中位**仍然只有 2 天**。⭐ 去讀組裝碼才看到真因:

```python
_hist.append(_snap)      # ← 每輪只 append `data_date` 那一筆
```
**不管批次已經抓了幾天,hist 每輪只長 1 天** → 要 22 個交易日才滿,
而 20 日週期、「同一分點連買」偵測(V74.0.6)、日後的深歷史回算全都靠它。

⭐ **修法兩件,都是零額外 API**(那些天早就在 `_bulk_idx` / 舊 hist 的記憶體裡):
① **`by_date` 的每一天都壓成快照**(`_day_snaps`)→ hist 依日期 dict 去重 + 排序合併,
   仍受 `CHIP_HIST_KEEP`(22)封頂。最新那天仍以 `out_periods['1d']` 為準(Sniper 官方分點較準)。
② **冷門股在批次模式下拿滿 `CHIP_DAYS`**:`_need_days = CHIP_DAYS if (_is_hot or _bulk_idx is not None) else 3`。
   ⛔ **逐檔模式必須維持 3 天** —— 那裡每一天都是真的要打一次 HTTP,拿滿會多打好幾千次。

📊 **體積量過才改**(⛔ 不憑感覺):`hist` 每天每檔中位 **700 bytes**(比 V72.9.8 記的 1.38KB 小一半,
因為冷門股分點少);全市場 22 天 ≈ **40 MB**,chips 總量 55 → 約 **80 MB**;
gh-pages 目前 **465 MB / 1024 MB** → 空間充足。個股檔中位 13.8 KB,冷門股會長到約 25 KB(可接受)。

⚠️ 這條依賴 V74.0.6 的 `_load_chips_deep_local`(歷史天從 `chips_deep` 分支零 API 還原)——
   沒有它的話批次要打 22 天 × 200 家 = 4,400 次呼叫 ≈ 46 分鐘,吃不下時間預算。
測試 `scripts/test_hist_depth.py` 11 條,3 種注入缺陷驗過(只存最後一天 / 拿掉排序上限 / 冷門股砍回 3 天)。

### 🧬 V74.0.6 交叉回測第二輪(A2/J/K/L/M)—— C 全關通過並落地顯示層
承上一節,使用者:「你推薦的該驗證繼續驗,我沒想到的你沒想到的都做」。五個追加:

| 組 | 結果 | 判定 |
|---|---|---|
| **M. C 疊在 🧬(位階≥75 且波動≥P60)內** | **+0.78/+1.44pp**,前後半同向(+1.04/+0.73),n=16,337 | ✅ **C 的最後一關過了** |
| A2. 大漲日 × 隔日沖佔比【擴充式翻臉率・全窗口】 | +0.63/+0.74,前後半同向(+0.21/+0.52),n=13,139 | ⚠️ 方向確認(動能標記)但幅度貼成本線 → ⛔ 不顯示 |
| J. 漲停日 × 隔日沖佔比 | +0.85/+0.68 同向 | ⚠️ 同上 |
| K. 🔻 連賣 ≥3 天(出場警訊,三個 chg5 cell) | −0.03 ~ −0.14pp,多數不同向 | ❌ **賣方不帶資訊** |
| L. 外資系 / 官股銀行系大買 × 位階 | ±0.2pp 內,多數不同向 | ❌ 系別身分無邊際 |

⭐ **擴充式翻臉率**(逐日累積、事件日只用當天為止的統計,零前視)解掉了「訓練段版只能驗半段」
的結構限制 —— 這招以後任何「券商屬性 × 事件」的回測都該用。
⭐ K 的意義:分點**賣方也不帶資訊** —— 連同買方,「分點當天的量」徹底測完。

📍 **落地(V74.0.6,唯一過全關的 C)**:`_chipRunBuy(sym, hist)` + 併入籌碼頁**明日劇本卡**
(⛔ 沒新增卡片,條件觸發)。⛔ 五條釘死(測試 `scripts/test_chiprunbuy.mjs`,3 種注入驗過):
① **「已發動」(5日 ≥8%)是必要條件** —— 連買但還沒漲(隱形吃貨)實測 +0.06pp ≈ 0,
   ⛔ 放寬成「連買就顯示」= 把沒用的顯出來,卡上也要寫出這件事。
② **三天必須是連續交易日**(用 rawDailyData 索引驗相鄰,缺席不算連買)。
③ 淨買 ≥ 當日量 0.5%(hist 淨額與 volume 都是**股**,同單位)。
④ 文案附完整實測數字 + 「⛔ 不是進場指令;窗口偏多頭、未接組合回測」;⛔ 無指令動詞。
⑤ `_fenSym` 比對防切股殘留。⛔ **顯示層而已,不計分**;半年後重跑交叉探針,邊際消失就撤。
⚠️ headless 測試又踩陷阱 #5(`const app` 不掛 window → 要用裸 `app` 等 lexical global)
   + file:// 下 SW 的 Cache.put 必炸要過濾(環境限制不是 App bug)。

### 🧬 分點 × K線/籌碼/基本面 交叉回測(2026-08-31,`scripts/broker_cross_probe.mjs`)⭐ 使用者的質疑救回了兩個訊號
使用者:「分點絕對沒有你說的這麼沒有用…你有結合K線技術面籌碼面基本面去做分析嗎?」
⭐ **他的方法論質疑成立**:前兩支探針測的是分點**單獨**的效果 ——「單獨沒用」不等於
「配上條件也沒用」(V73.7.4 做夢行情就是配條件才過關)。九組交叉(A~I),
⭐⭐ **每一組的對照組都共用非分點的那條腿**(⛔ 拿全市場當對照量到的是條件本身,不是分點)。

**✅ 過關的(交叉後分點真的有資訊)**
| 格 | 10日 | 20日 | 檢定 |
|---|---|---|---|
| **C. 連買 ≥3 天 且 5日已漲 ≥8%**(對照:同漲幅的單日買)| **+0.85pp** | **+1.36pp** | ✅ 前後半同向(+0.70/+1.00)・n=34,505・鎖高位階仍 +0.80/+1.33(前後半 +1.01/+0.76)|
| **A. 大漲 ≥5% 日・隔日沖券商佔買超前 30%**(對照:佔比後 30%)| **+1.39pp** | **+2.11pp** | ⚠️ 只有後半段(翻臉率是前半學的)・鎖漲幅帶仍在(5~7% 內 +0.96/+1.98;7~9.5% 內 **+2.29/+3.45**)・鎖位階仍在(兩邊都正)|
| D. **投信買超日**分點又大買(反向警訊) | −0.58pp | **−1.40pp** | ✅ 前後半同向(−0.54/−0.77)・n=12,336 |
| F. **EPS YoY>0** 且分點大買(反向警訊) | −0.59pp | −1.79pp | ✅ 同向(−2.11/−0.59)⚠️ YoY 只覆蓋後段窗口 |

🚨🚨 **A 的方向跟江湖說法完全相反**:「大漲日隔日沖買最多 = 該躲」是坊間鐵律,
實測是**動能標記** —— 隔 1 日確實小輸(−0.11pp,賣壓存在),但 10~20 日大贏。
隔日沖圈選股就是在挑「還會再動」的股票,他們的出現本身是資訊。
⛔ 但它只有單段驗證(結構限制)→ **先不落地**,等下一段資料再驗一次才談接進 App。

**❌ 交叉後仍然無效的(江湖最愛的都在這排)**
低檔大買(B,前後半不同向)・隱形吃貨(連買但還沒漲,C,+0.06pp)・突破日分點集中(E)・
外資同買(D)・🧬 內分點大買(G,不同向)・技巧券商低檔買(H 低位階 0;高位階 +0.47 貼成本線)・
關鍵分點累積低成本大買(I,+0.35 但前後半不同向;鎖位階後仍不同向)。

⭐⭐ **一句話總結:分點的資訊在「動能確認」與「擁擠警訊」兩端,不在「提前潛伏」端** ——
連買有用的前提是**價格已經動了**;隔日沖佔比高不是警訊是動能;投信+分點一起擠才是警訊。
跟本專案一貫的「追強 > 抄底」完全一致。⛔ 別再做任何「分點提前布局」方向的功能。

⚠️ 方法備忘:selftest 注入「只在低位階有效」的訊號驗 within-cell 對照(低位階格 +2.68、
高位階格 0.00);抓到兩個 bug:①合成訊號太密會把低位階組推成高位階(格子變空)
②分位門檻撞上大量同值 → `>=`/`<` 退化成 all/0,切法一律**嚴格大於**。
⚠️ 基本面腿用 `fund_yoy_gm.qeps` + 財報公布日規則重建「事件當時已知」(零前視,同 pe_probe)。
⏭️ C 與 A 若下一段資料(再累積半年)重驗仍在,才談接進 App(顯示層,⛔ 不自動計分)。

### 🧙 V74.0.5 「厲害的/神秘/地緣分點」五組全測(2026-08-31,`scripts/broker_skill_probe.mjs`)
使用者:「分點券商還是有分厲害的分點神秘分點地緣分點等等…請將這些相關資訊或者是我沒想到的去做一個分析回測」。
**467 天 × 前 200 家券商 × 全市場;買超事件(≥0.5% 量,10 日去重,可成交)3,770,969 筆。**
⛔⛔ **這題最大的陷阱是循環論證**:用全期成績挑「厲害的」再報它全期成績,200 家裡**必然**有幾家看起來很神
(V72.9.2 排點估計值的教訓)→ 全部用「**前半段學、後半段考**」+ 反向再做一次。

| 組 | 實測(相對「同門檻全部買超」對照組) | 判定 |
|---|---|---|
| A 厲害的分點 | 排名**有**延續性(Spearman ρ=**0.436**);但驗收段前/後 1/5 差只有 **0.47pp**(反向 0.19pp)| ⚠️ 結構存在、幅度 < 成本 0.44% |
| B 神秘分點(60 日沒碰突然大買 ≥1% 量) | +0.20pp,**前後半不同向**(+0.76/−0.20) | ❌ |
| C 地緣分點(券商縣市==公司縣市) | **+0.01pp**(n=110,100);排除雙北 −0.07pp,皆前後半不同向 | ❌ **V71.9.8 標的「未回測」現在補上了:無邊際** |
| D 連買 ≥3 天 | +0.14pp,前後半同向但遠小於成本(n=315,437) | ➖ |
| E 高翻臉率券商的買隔天較弱? | 隔 1 日差 **0.00pp**(高翻臉組 18 萬筆 vs 低翻臉組 20 萬筆) | ❌ |

⭐⭐ **四個值得記住的**:
① **「排名有延續性」與「可以賺」是兩件事** —— ρ=0.436 是真的(爛的持續爛:訓練段墊底的
   法銀巴黎/彰銀/土銀/華南岡山…驗收段全部繼續墊底),但頭尾差 < 成本 → 沒有可交易的邊際。
   ⭐ 墊底名單有個可講的型態:**官股銀行系券商的買超後續最弱**(彰銀/土銀/華南/第一)。
② **訓練段前段班是幻覺的教科書**:元大永寧訓練段 +0.62%(第 1 名)→ 驗收段 **−2.17%**。
   ⛔ 日後任何「分點勝率榜」都必須用 held-out 驗收,⛔ 不可報同期成績。
③ **E 的翻臉率排行跟 broker_perf 的人工印象一致**(凱基台北 44%・瑞銀 43%・小摩 39%),
   但「避開他們的買」**沒有用**(隔日差 0.00)—— 翻臉是真的,傷害是零。
   ⚠️ 這不推翻 V71.7.2 的 flip(+31pp):那是 per-(broker,stock) 慣性配對,不同問題。
④ 連同 chips_deep_probe:**兩年資料把「分點籌碼當天的量」這條路整個測完了 —— 集中度、
   身分、地緣、連續性都不帶可交易的方向資訊**。⛔ 別再提「分點大買 → 看多」類功能。
   App 既有的分點**事實描述**卡照留;地緣分點卡已補上實測數字(V74.0.5)。

⚠️ 誠實限制:券商母體是「近期活躍前 200 家」(對券商有輕微選樣偏誤);窗口偏多頭。
🧪 selftest 合成「神券商/翻臉王/連買俠」三個已知訊號,**當場抓到探針自己的 4 個 bug**:
  ・E 的翻臉率把「隔天沒出現」當 null 排除 → 只剩天天出現的券商能排名
  ・D 的連買沒在缺席時歸零 → 隔幾週的三次買被當「連買 3 天」
  ・🚨 **主去重(10 日)會把「連買第 3 天」結構性擋掉 → D 永遠 0 筆且零錯誤**(D 要獨立收集)
  ・合成資料的 open 用當天收盤推 → 壓價被開盤吸收,E 永遠驗不動(open 要用**前一天**收盤)
⚠️ 效能:預建 467 天的「隔天淨額」索引 = 3,700 萬 Map 條目 → **OOM 6GB**;改滾動一天解決。
  滾動換手順序:**先換手再解決**(先解決會差一天,全部 NaN)。

### 🔬 兩年分點深歷史第一次回測(2026-08-30,`scripts/chips_deep_probe.mjs`)⛔ 結論:**分點集中度沒有方向性預測力**
回算完成當天就跑(探針在回算期間先寫好、先用 350 天驗過管線)。
**467 個交易日(2024-08-30 ~ 2026-08-28)・1,060,287 筆(股·日)・對照組 55,157 事件**;
進場價 = **隔天開盤**(分點收盤後才公布,⛔ 用訊號日收盤 = 前視偏誤;
⚠️ 所以這批數字**不可**跟 K 棒訊號那批「訊號日尾盤買」互相比較)。

| 事件(20 日,相對對照組 pp) | n | 邊際 | 勝率 |
|---|---|---|---|
| (對照組)−2.43% ・勝率 34.8% | 55,157 | — | — |
| 前5大買超佔量 最高 10% | 23,489 | **−0.60** | 32.1% |
| 前5大買超佔量 最低 25% | 40,665 | −0.23 | 32.2% |
| 前15家淨額 買方壓倒(最高10%) | 29,608 | −0.33 | 32.3% |
| 前15家淨額 賣方壓倒(最低10%) | 29,944 | −0.53 | 31.5% |
| 前5大**賣超**佔量 最高 10% | 24,680 | −0.68 | 31.5% |

⭐⭐ **三個結論**:
① **每一桶、每一年都輸對照組**(逐年拆解 2024/2025/2026 全負,去最好年也全負)——
   「分點大買」跟「分點大賣」之後**都**略差 → ⛔ 集中度不可做成多空訊號。
② **買賣兩端同號 = 活躍度不是方向**(同 V72.5.2 集保「隱藏大戶」)——
   分點大進大出的日子整體較差,跟誰買誰賣無關。
③ 5/10 日有 +0.1~+0.34pp 的微幅正漂移,但 **< 成本 0.44%** → 白做;
   增量檢定(疊在 🧬 之上)**不用跑了** —— 連基本關都沒過。
⭐ 這跟 `limitup_probe` 的發現同向(外資大買佔量 ≥20% 反而 0.64x)——
   **籌碼「當天的量」不帶方向資訊**,本專案實測到現在還是「追強(價的動能)」最有用。

⚠️ **這次否定的是「整體集中度」,⛔ 不可外推到**:
・`broker_perf.flip`(**特定券商**的隔日沖慣性,V71.7.2 實測有 +31pp)—— 那是 per-broker 的問題
・既有的分點**事實描述**卡(主力動向/關鍵分點)—— 描述不是預測,照留
⏭️ 深歷史下一個值得問的是 **per-broker**(哪幾家分點買了真的會漲)——
   資料夠了(467 天 × 前 200 家券商),還沒做。

🚨 **探針自己被實跑抓到一個 bug**:方向性檢定第一版只抓「兩端都正」,
   350 天實跑時兩端**都是負的**(−0.60/−0.68)它卻印「✅ 方向相反」→ 改成同號就報
   (±0.3pp 雜訊門檻)。⭐ selftest 的合成資料只鋪了「反號」情境,鋪不到「同號」——
   **合成資料驗得了 harness 會不會算,驗不了每一條判讀邏輯的分支**。
資料:`chips_deep` 分支 467 天 / 155 MB(⛔ 前端不讀;`git archive origin/chips_deep` 取用)。
維持:daily_miner 每天按券商批次自動接著存(V74.0.6),⛔ 不用再回算。

### 🚨🚨 V74.0.6 **每天的分點採礦也走同一條死路** —— 一輪只更新 88 檔 / 2,653
付費恢復、`data_date` 追到 08-28 之後,以為修好了。⭐ **去數產物才發現只有 88 檔**
(全市場 2,653;`hist` 天數中位仍是 **1**)。⛔ workflow 全綠、零錯誤訊息(陷阱 #9 的又一次)。

🚨 **真因跟 V74.0.7 是同一個,只是我當時只修了回算那支、沒回頭看採礦機**:
`miner._fetch_chips_bulk` 走的正是「**省略 `data_id` 只給日期**」那條**已經被官方擋掉**的路
→ 每輪浪費 1 次呼叫拿到 400 → 回 None → 退回逐檔。
而斷線一個月要補 22 天 → **2,653 檔 × 22 天 = 58,000 次呼叫 ≈ 10 小時**
→ 時間預算砍在 88 檔。⭐⭐ **這就是陷阱 #37 的又一次(共用的教訓只套到一處)** ——
V74.0.7 已經白紙黑字寫下「那條路不通」,但那句話只寫進了 `chips_backfill.py`。

⭐ **修法:採礦機改用跟回算完全相同的軸 —— 按券商抓。**
一天 **200 次**呼叫拿到全市場;按股票抓要 2,653 次 → **省 13 倍**。
⭐ 穩定狀態下每天只有 **1 個新交易日** → **200 次呼叫就採完全市場**。

📊 **截斷誤差是量過的**(2026-08-28、88 檔可比對):前 200 家券商涵蓋了個股檔
「前 15 名券商淨額」的 **中位 97.7% / P10 92.4% / P25 95.4%**,<90% 的只有 4 檔、<70% 的 0 檔。
⚠️ 那 88 檔**全是熱門股**,冷門股未驗證 → 券商數留成 `CHIPS_BULK_BROKERS`(預設 200),
並印出「前 N 家券商完全沒碰到的股票數」(`_bulk_miss`),⛔ 不靜默。

⛔ **同版修掉三個「會讓批次等於白做」的東西(每一個都不會報錯)**:
① 🚨 **批次模式還在 `time.sleep(3 if _is_hot else 1)`** —— 批次是**零 HTTP**,
   2,653 檔 × 1~3 秒 = **1~2 小時全花在睡覺**,省下來的呼叫數等於白省,
   而且看起來像「批次沒效果」。→ `if _bulk_idx is None:` 包起來。
② **先用 1 家券商探路(最多 5 天)再開火** —— 探路失敗只花 **5** 次呼叫;
   ⛔ 不可整批 1,000 次打完才發現付費層失效。
③ 🚨 **`have_dates` 改成跨全市場等距抽樣** —— 現在的狀態正是「熱門股有 08-28、
   冷門股沒有」,只抽熱門股會誤判成「全市場都有」→ 批次跳過那天 →
   **冷門股永遠補不到**(陷阱 #10:跳過條件要看「內容夠不夠」不是「做過沒」)。
   樣本 <20 檔一律不下結論。

⛔ 券商清單 `top_brokers` 跟 `scripts/chips_backfill.py` **共用同一支**,
⛔ 不在 miner 再寫第二份(測試 ②b 會擋)。
⚠️ 「名稱鍵 vs 代號鍵」的重複計算 V71.2.9 的 `_agg_period` 早就正規化過了,**不用再修**。
⚠️ push `miner.py` 會觸發 daily_miner → **跟回算共用同一把付費金鑰(6,000/hr)**,
   同時跑會互相擠成 429 → 回算期間要把它取消掉,回算跑完再手動觸發驗證。
測試 `scripts/test_chips_bulk.py` 20 條,**6 種注入缺陷全部驗過會叫**
(其中「拿掉探路」第一版注入把語法弄壞 → 測試是因為 import 失敗才紅的,**那是假的抓到**;
 ⭐ 通用:**注入之後要先確認語法還是好的**,否則驗到的是自己的手滑不是測試的能力)。

格式:`{"d":日期,"n":股票數,"k":15,"nm":{代號:名稱},"s":{股號:[[代號,淨股數,均價],…]}}`
讀法:`git show origin/chips_deep:chips_deep/2026-08-17.json.gz`(⛔ 前端不讀,只給探針/回測)。
測試 `scripts/test_chips_backfill.py` 30 條,5 種注入缺陷驗過。
⚠️ 該測試「週末不排進清單」那條第一版寫成 `all(... for d in [])` —— **空迭代恆為 True = 假綠燈**,
   已改成把 dry-run 印出的日期真的解析出來逐個檢查 weekday。

### 🔎 V74.0.3 選股頁 127 個條件全部實測(`scripts/screener_edge_probe.py`)⭐ 追強 > 抄底,再一次
使用者:「還有什麼高勝率的訊號嗎?放在選股裡面」。
⛔ **先糾正問題本身:「高勝率」是錯的目標** —— V72.9.7 實測「只做成交值 ≥1 億」勝率 +3.4pp
卻**少賺 307,528 元**。所以測的是**期望值**,勝率只當附帶資訊。

📌 **為什麼要做**:選股頁有 **170 個條件**,使用者勾了會以為那是驗證過的做法,
   但其中**只有 1 個**(5 日週轉率 V73.8.2)有實測數字。

⭐⭐ **關鍵做法:直接呼叫採礦端的 `screener_miner.build_one(rows[:i+1])` 跑歷史。**
   它的 docstring 就寫著「⛔ 只用到當天為止的資料」→ ① 天然沒有前視偏誤
   ② ⛔ **不會產生第二份欄位定義**(同名不同義是本專案犯過最多次的錯)。
   條件本身從 `_SCR_CONDS` 解析(那是**資料**不是邏輯)→ 127 個可測,43 個要自訂函式。

📊 **2,243 檔 / 37,035 個獨立事件(同檔同條件 20 日去重)/ 2024-04 ~ 2026-07,前瞻 20 日、扣同期大盤、扣成本 0.44%**
🚨 **對照組本身就是 −2.000% / 勝率 34.6%** —— ⛔ 基準不是 0% 也不是 50%。

| 領先最多 | vs 對照 | | 落後最多 | vs 對照 |
|---|---|---|---|---|
| 創一年新高 | **+3.30pp** | | 創 20 日新低 | −0.75pp |
| 漲停股 | +2.73 | | 創一年新低 | −0.67 |
| 成交額 >20 億 | +2.51 | | 位階低檔(≤25%) | −0.63 |
| 近 20 日漲幅 >20% | +1.85 | | 盤整收斂(振幅<2.5%) | −0.62 |
| 位階高檔(≥75%) | +1.76 | | 低波動(年化<30%) | −0.53 |
| 創 60 日新高 | +1.68 | | 跌破季線 | −0.52 |
| **RSI >70(超買)** | **+1.64** | | **KD 低檔(K<20)** | **−0.48** |

⭐⭐ **整張表只有一個方向明確的規律:追強 > 抄底**,而且**成對的條件方向完全相反**:
RSI 超買比超賣好 **1.34pp**・KD 高檔鈍化比 KD 低檔好 **1.74pp**・位階高檔比低檔好 **2.39pp**。
這跟本專案既有結論完全一致(V73.8.3「等回檔再買」21 個有 18 個負、V73.2.3、V73.2.9)。

🚨 **但最重要的是這句:96 個測得動的條件裡,扣掉成本後還是正的只有 4 個
(創一年新高 +0.86% / 漲停股 +0.29% / 成交額>20億 +0.07% / 近3日融券增加>1000張 +0.03%),
六道穩健性檢定全過的是 0 個。** 連最強的「創一年新高」都卡在「逐年同向」那一關。
⭐ 所以這張表的定位是「**比較條件之間誰比較有用**」,⛔ 不是「勾了就會賺」。

⚠️ **經典技術指標幾乎全部沒有鑑別力**(都擠在對照組附近):
KD 黃金交叉 +0.26pp・MACD 黃金交叉 +0.26・站上月線 +0.25・5 日線翻揚 +0.12・優於大盤 +0.05。

#### 🚨🚨 逐年拆開才看到的:**這個優勢正在衰退,2026 幾乎歸零**(V74.0.4 補)
| 條件 | 2024 | 2025 | **2026(前7月)** |
|---|---|---|---|
| 創一年新高 | +0.95 | +2.01 | **−0.01** |
| 漲停股 | +1.34 | +0.46 | **−0.51** |
| RSI > 70(超買) | +0.40 | −0.29 | **−2.26** |
| 創 60 日新高 | +0.07 | −0.63 | **−1.54** |
| 位階高檔(≥75%) | −0.26 | −0.38 | **−1.33** |
| 正乖離月線 >10% | −0.17 | −0.53 | **−1.85** |

⭐⭐ **前 12 名裡有 8 個最差的年份就是 2026**,而且**衰退集中在「追強」那一族**。
🚨 徽章顯示的是 **3 年平均**(被 2024~2025 拉高)→ ⛔ **不講這件事等於誤導** ——
使用者會拿「創一年新高 +3.3pp」當成現在還有效。
→ `_scrDecayLine()` 接在**總結**與**教學**兩處(⛔ 不可只放教學,那裡點進去才看得到)。
⚠️ 這也解釋了為什麼六關全過 0 個:最強的「創一年新高」正是死在「逐年同向」——
   ⭐ **那一關不是太嚴,是它真的抓到了東西**。
⚠️ 重跑探針後要**同時更新 `_SCR_EDGE.decay`**(逐年明細在探針輸出的「📅 前 12 名」那段)。

📍 **落地(⛔ 沒新增卡片)**:`_SCR_EDGE`(4.6KB 嵌在 index.html,同 `_SIGNAL_EDGE` 做法)
+ `_scrEdgeTag`(條件按鈕上的徽章)+ `_scrEdgeNote`(勾選後的總結)
+ **「⭐ 只看實測領先」**切換(⛔ 刻意**忽略分組** —— 答案散在 11 個分組裡,照分組看永遠拼不出全貌)。
⛔ 徽章**不用紅綠**(講「有沒有用」不是「漲跌方向」);沒測過的條件**整條不顯示**(⛔ 不可假裝有成績)。
⚠️ **改 `_SCR_CONDS` 的門檻或新增條件 → 要重跑探針更新 `_SCR_EDGE`**,否則成績會對不上。

⚠️⚠️ **測試自己犯了「複製一份判定邏輯」的錯**(注入驗證當場抓到):
`test_scredge.mjs` 第一版在 `page.evaluate` 裡**自己重寫了一份過濾**,
於是「把只看實測領先改成只看當前分組」的注入缺陷**完全抓不到**。
→ 抽出 `app._scrCondList()` 讓渲染端與測試共用,並加一條「分組過濾只准出現一次」的斷言。
⭐ 通用:**測試要呼叫真的那支函式**;而這個錯**只有靠注入已知缺陷才抓得到**。
⚠️ 該測試另一條第一版寫成「全檔不可出現 `_scrEdgeOnly ?`」→ 被切換鈕自己的**樣式三元**擋下(假失敗)
→ 改成釘「分組過濾出現次數 == 1」。測試 `scripts/test_scredge.mjs` 31 條,5 種注入缺陷驗過。

### 🚀 「漲停能不能提早知道」全面實測(2026-08-30,`scripts/limitup_probe.mjs`)⛔ 結論:**測得到、賺不到**
使用者:「個股漲停時有什麼資訊可以提早知道或者是高機率,K線、籌碼、K線加籌碼、基本面、消息面,請回測」。
站在 **t 日收盤**預測 **t+1 是否漲停**(⛔ 不是「漲停之後怎麼辦」= V72.0.1 已測過的漲停隔日動能)。
2,243 檔 × **551,352 個(股·日)**,2024-04 ~ 2026-08,可交易性守門(成交額 ≥1,000 萬)。
**對照組:隔日收漲停 2.936%(約 34 天一次)、盤中觸及 4.429%。**

#### 🚨🚨 最重要的一條:**漲停鎖死那天,你收盤根本買不到** —— 排除之後訊號直接腰斬
| 訊號 | 原始倍數 | **鎖死佔比** | ⭐ **排除鎖死後的倍數** |
|---|---|---|---|
| 今天漲停 | **6.99x** ・收盤買扣成本 +1.172% | **88.5%** | —(整個母體幾乎都買不到)|
| 創60日新高 | **4.12x** ・+0.439% | **39.0%** | 🚨 **1.29x** |
| 收最高(K棒上緣) | 2.24x | 24.4% | 🚨 **0.99x**(= 完全沒有鑑別力) |
| 爆量大漲 × 外資也在買 | 3.06x ・+0.050% | 30.1% | 2.39x |
⭐⭐ **「創60日新高預測漲停」有七成的功勞其實是「它今天本來就漲停」** ——
把買不到的那批拿掉,4.12x 只剩 1.29x。⛔ 這種**條件與標籤高度重疊**的假象,
只靠「六道關卡」抓不到,**一定要另外問一次「這些事件你買得到嗎」**(同評估紀錄⑫)。

#### 📊 買得到的版本(全部排除鎖死;倍數分母 = 所有沒鎖死的日子)
| 條件 | n | 隔日收漲停% | 倍數 | 收盤買扣成本 | 掛漲停價賣 |
|---|---|---|---|---|---|
| ⭐ 新高+量≥2倍+漲停常客 | 886 | **9.48%** | **4.02x** | −0.414% | −0.384% |
| 20日振幅 ≥6% | 54,519 | 7.85% | **3.33x** | −0.591% | −0.569% |
| 漲 7~9.5%(差一點漲停) | 8,123 | 6.76% | 2.87x | −0.636% | −0.545% |
| 跳空 ≥3% | 20,411 | 6.19% | 2.63x | −0.585% | −0.518% |
| 爆量大漲(量≥2倍且漲≥3%) | 22,428 | 5.64% | 2.39x | −0.628% | −0.609% |
| 年位階 ≥90 | 31,789 | 5.56% | 2.36x | −0.370% | −0.345% |
| 同產業 ≥3 家漲停(族群點火) | 49,285 | 3.50% | 1.48x | −0.469% | −0.425% |
| 創60日新高 | 11,863 | 3.04% | 1.29x | −0.419% | −0.409% |
| (對照)所有沒鎖死的日子 | 534,563 | 2.36% | 1.00x | −0.574% | −0.559% |

⭐⭐ **兩句話總結**:
① **命中率確實拉得高**(最好 4x,從 2.4% → 9.5%);
② **但沒有一組扣掉成本後是正的** —— 連「掛漲停價賣」這種最有利的出場都救不回來。
真因:讓一檔容易漲停的東西(高波動)**同樣讓它容易跌停**。
🚨 穩健性檢定跑出 **16 個候選,六關全過 0 個**,而且**每一個都死在「買不到」那一關**。

#### 🚨 反直覺但重要:**籌碼幾乎不能預測漲停,方向甚至相反**
| 條件 | 倍數 |
|---|---|
| 外資今日買超佔量比 **≥20%(大買)** | **0.64x**(⛔ 比隨便挑一天還低) |
| 外資近5日買超 ≥15% | 0.59x |
| 投信今日買超 ≥10%(重壓) | 0.52x |
| 外資+投信**同買** | 0.80x |
⭐ 真因很直白:**外資/投信佔量比高的多半是大型權值股,那種股票不會漲停** ——
漲停是中小型題材股的事。⛔ 別再假設「法人買 → 容易噴出」。
⚠️ 而**融資 5 日增 ≥20% 是 2.40x、減 ≥20% 也有 2.18x、中間 ±5% 只有 0.59x**
→ **兩端都高 = 那是「活躍度」不是「方向」**(同集保「隱藏大戶」那次的教訓,⛔ 不可做成多空)。

#### ➖ 基本面很弱、消息面測不了
最強的「最近一季 EPS YoY ≥+100%」只有 **1.75x**、「營收 YoY ≥+50%」**1.59x**,
而且扣成本後全部是負的(−0.46 ~ −0.63%)。
⛔ **消息面無法回測** —— `stock_news.json` / `global_news.json` / `theme_news.json`
**都只有當前快照、沒有歷史存檔**,想做要先開始存(⚠️ 那是「現在不存以後永遠沒有」那一類)。

#### ⭐ 這次順手解鎖的資料事實(⛔ CLAUDE.md 舊敘述已過期)
CLAUDE.md 多處寫「`foreign_net` 中位只有 28 天、要等 2027/05 才驗得動籌碼」——
**實測已經是 3 年全深度**(2330/2317/3231 的 foreign_net / trust_net / margin_balance 都有 780+ 天)。
⭐ 所以**籌碼類的回測現在就做得動了**,不用再等。
⚠️ 但**分點籌碼**仍然只有滾動 20 日快照(沒有逐日歷史),那條沒有解鎖。

#### 🚨 探針自己犯的兩個錯(⛔ 都不會報錯,只會讓結論變樂觀)
① **前後半的中點用了整條日期軸**(`ND/2`)—— 日期軸從 2021-08 起(加權指數 5 年),
   但個股 K 線 2023-06 才有 + 250 根暖身 → **所有事件都落在後半、前半是 NaN**,那一關等於沒作用。
   ⭐ 這是 V73.2.9「對照組期間必須跟實際樣本對齊」的**同型再犯**,改成從實際樣本推中點。
② **第一版的「買得到嗎」測法太粗** —— 把整桶都改成「隔天開盤買」,
   但實務上是**跳過鎖死的、只買買得到的**。改成「排除鎖死」重測,才看到 4.12x → 1.29x 那個真相。
#### 📍 V74.0.2 落地:`_luOdds` / `_luOddsHtml`(使用者:「我要發生這個機率時你會告訴我」)
⭐ **只做「機率」,⛔ 不做「榜單」也不做推播** —— 扣成本後全負,做成排行榜等於推薦一件會賠錢的事。
📍 掛在 **K線頁 K棒戰法卡**(⛔ 沒新增卡片),跟 `_stockRegime` 同一個位置 ——
   ⭐ 選那頁的理由:它**刻意只解讀、不給買賣價位**(V72.1.4 單一劇本原則),正好符合這條的定位。

⛔ **七條不可改掉的設計(測試 `scripts/test_luodds.mjs` 30 條釘住,已用 5 種注入缺陷自我驗證)**:
① 🚨 **命中多個條件時⛔ 不可把單一機率相乘** —— 這 7 個條件高度相關(爆量/高波動/創新高常一起來),
   相乘會嚴重高估。探針直接量「**同時命中 N 個**」的實際機率,前端讀那張聯合表。
   實測完全單調:0個 0.99% → 2個 5.92% → 3個 8.93% → 4個 11.55% → **5個以上 13.77%(5.8 倍)**。
② 🚨 **一定要寫「這樣做賺不到錢」** —— 每一格扣掉來回成本 0.44% 之後都是負的。
   少了那句,這張卡就是在推薦追漲停。測試 ④a/④b 直接釘住那兩句話。
③ 🚨 **今天漲停鎖死 → 先講「買不到」** —— 機率確實跳到 15.6~25.6%,
   ⛔ 但收盤價排隊排不到,改成隔天開盤買實測 **−0.88%**(追進去是賠的)。
   文案改成「適合判斷**手上這張要不要抱過夜**」,⛔ 不是叫人去追。
④ **命中 0~1 個 → 整條不顯示**(1 個只有 1.06 倍 = 跟平常一樣,顯示只是雜訊 + 空殼)。
⑤ ⛔ **不用紅綠** —— 這是「會不會動」的機率,不是漲跌方向(燈號鐵則)。
⑥ ⛔ **不下操作指令、不給買賣價位**(價位一律以總覽「現在怎麼做」為準)。
⑦ **數字全部讀 `_LU_ODDS`,⛔ 前端不可寫死第二份** —— 測試 ①d 會換一份假表驗畫面跟著變。
   ⚠️ 第一版就漏了一個:鎖死那段的 `−0.88%` 是寫死的 → 已收進 `_LU_ODDS.lockOpen`(測試抓到的)。
⚠️ **兩處 render path 都要接**(有 K 棒訊號 / 沒訊號),⛔ 只接一處 = 只有剛好有訊號的日子才出現。

⛔ **這不是加功能而是回答問題**:探針留著,**走完一次空頭後重跑最有價值** ——
   現有窗口整段偏多頭,而「高波動追強」正是空頭最容易受傷的組合。
   ⚠️ 重跑後若機率分布變了,**要重新產 `_LU_ODDS` 並更新測試裡的數字**(EMIT=1 跑探針即可)。

### 🐢 0050 七種買法實測 vs 打法(2026-08-24,`scripts/etf0050_probe.mjs`)
使用者:「0050 買賣策略,是定期定額買,還有大跌加買,還是有其它策略,幫我回測並與目前我的賺錢策略比拚」。

⛔⛔ **這題最大的陷阱:不能直接比「賺多少錢」** ——
打法回測是「本金 100 萬**一次到位**」,定期定額是「每月投一點、平均只有一半的錢在市場裡」。
直接比總獲利 = 讓一次投入用兩倍的錢去比。→ 主指標用 **IRR(資金加權年化)**,
並同時列「平均在市場裡的錢」讓兩種角度都看得到。

📊 **窗口 2023-06-12 ~ 2026-08-19(777 個交易日 / 39 個月),0050 +219.7%(已分割還原),
總投入一律封頂 100 萬、手續費 6 折、ETF 證交稅 0.1%(⛔ 不是股票的 0.3%)**:
| 策略 | 最終資產 | 淨賺 | 含息估* | IRR | 最大回撤 | 平均在市場的錢 |
|---|---|---|---|---|---|---|
| ⭐ ① 一次全買放著 | **3,188,243** | 2,188,243 | **2,280,743** | +45.7% | **−28.5%** | 1,000,000 |
| ③ 定期定額 + 大跌加碼 | 2,360,247 | 1,360,247 | 1,413,690 | +58.4% | −17.5% | 577,766 |
| ④ 只等大跌才買 | 2,281,202 | 1,281,202 | 1,333,628 | **+59.7%** | −19.2% | 566,763 |
| ② 定期定額 | 2,224,746 | 1,224,746 | 1,272,209 | +57.6% | −20.5% | 513,118 |
| ⑤ 定期定額(只在月線之上買) | 2,212,839 | 1,212,839 | 1,260,302 | +57.1% | **−16.7%** | 513,118 |
| ⑦ 價值平均法 | 1,542,370 | 835,516 | 872,941 | +50.6% | −17.1% | 404,593 |
| 🚨 ⑥ 站上月線買・跌破月線全賣 | 1,748,162 | **748,162** | 840,662 | **+19.9%** | −18.2% | 1,000,000 |
(*含息是**估算**:年化殖利率 3% × 平均在市場的錢 × 3.1 年。⛔ 資料源沒有配息紀錄,不是實測。)

⭐⭐ **三個結論**:
1. **有一筆錢在手 → 一次全買放著最多錢**(318 萬)。⛔ 多頭市場裡任何分批法都會輸,
   因為錢還沒進場市場就漲走了。代價是**回撤最大(−28.5%)**。
2. **每月存錢 → 定期定額 + 大跌加碼**(IRR 58.4%、回撤比純定期定額小 3pp)。
   「大跌加碼」確實有用,但只比純定期定額多賺 **13.6 萬**,⛔ 沒有想像中神。
3. 🚨🚨 **最貴的錯誤是擇時**:⑥「站上月線買、跌破月線全賣」只賺 **74.8 萬**,
   比一次全買**少賺 144 萬**。⭐ 而且它的錢也是 100% 在市場(平均 100 萬)
   → **不是資金效率的問題,純粹是進出被巴 + 手續費**。

🆚 **跟打法比**(⚠️ 兩支腳本、窗口 36 vs 39 個月 → 只比量級):
| | 淨賺 | 最大回撤 |
|---|---|---|
| 🧬 只做高位階+高波動(現行配置) | **2,896,478** | −22.4% |
| 🐢 0050 一次全買(含息估) | 2,280,743 | −28.5% |
| 📋 照清單順序做(不挑) | 1,260,926 | −24.0% |
→ **打法贏,但只贏約 61.6 萬(+27%),而且要每天盯 13:00~13:28 + 嚴格紀律**;
  0050 買了放著什麼都不用做。⭐ 這個差距值不值得那些時間,是使用者自己的取捨,⛔ 不是技術問題。
→ ⚠️ 但**不挑 🧬 的話打法輸 0050 102 萬** —— 再次印證 V73.2.9:🧬 是必要條件不是加分項。

⚠️ **最重要的限制**:分年報酬 2023 **+5.0%** / 2024 **+44.5%** / 2025 **+34.0%** / 2026 **+57.2%**
—— **沒有一年是空頭**。⛔ 所有「一直待在市場裡」的策略都天生佔便宜,不可外推。

#### ⚠️⚠️ 這支探針的兩個公平性 bug(⛔ 寫下來免得再犯)
① **`put` 沒封頂** → ③ 投了 125 萬、④ 投了 137.5 萬,拿比別人多 25~37% 的錢去比。
② 🚨 **修了 `put` 卻沒修 `buy`** —— `buy` 沒有限制在「手上有多少現金」,
   所以封頂之後買單照樣用原本金額成交(帳戶現金變負 = **透支**)。
   症狀極陰:封頂前後**淨賺完全一樣**(1,395,604),只有投入的帳面數字變了
   → 看起來像修好了,其實一毛都沒改到行為。
   ⭐ **通用:改「資金上限」時要同時檢查花錢那一端有沒有跟著受限;
      ⛔ 只改記帳的那一端 = 只改了報表。**
③ ⑦ 價值平均法第一版把「超前就賣」寫成 no-op → 那不是價值平均法,是半套。
   ⛔ 顯示一個沒實作完的策略比不顯示更糟。

⛔ **結論:App 一行都沒改**(這是回答問題,不是加功能)。探針留著,走完一次空頭後重跑最有價值。

### 🏀 V73.8.6 自選頁個股期貨 + 🚨 抓到「拿 16 天前資料當昨晚」的顯示 bug
使用者:「個股期貨新增簡短資訊放置在自選裡面,這樣比較可以快速查看」。

🚨 **做之前先在使用者自己的截圖裡抓到更嚴重的既有 bug**:
當沖頁顯示「🏀 個股期貨夜盤 **−5.06%** ・期 544.0 → 逆價差 −4.06% → 有人期貨放空避險,偏空留意」
—— 而 `stock_futures_night.json` **停在 08-08(16 天前)**,畫面卻當成**昨晚**在判讀。
⭐ 夜盤是**當日快照**(昨天 −5% 今天可能 +3%)→ 這是陷阱 #34:
**顯示一個不該相信的數字,比空白更危險**;而且原本的判讀式 `if (fut && isFinite(...))`
**完全沒有新鮮度檢查**。

📍 落地(⛔ 沒新增卡片):
| | 做什麼 |
|---|---|
| `_stockFutFresh()` | ⭐ **全 App 唯一判斷點**(⛔ 不可兩處各寫一套) |
| `_favFutChip(sym, data)` | 自選列迷你標籤 `🏀 期夜 +6.5%`,夜盤領先現貨 ≥1.5pp 加註「補漲?」 |
| 當沖卡 | 太舊 → ⛔ 不再照算,改誠實寫「資料停在 08/08(16 天前)→ 先不判讀」 |

⛔ **四條不可改掉的設計**:
① **門檻用「日曆天」(4 天)不用小時** —— 夜盤 cron 一天 2 次,但**週末沒有夜盤**,
   用 30 小時會讓**每個週一都誤報**(誤報會讓人養成忽略的習慣)。4 天涵蓋週末+一天假,
   而真的停產(16 天)一定擋得住。測試 ④ 用「3 天前」把這條釘住。
② 自選標籤資料太舊 → **整個不顯示**;但當沖卡 ⛔ **不可靜默消失**,
   要說出「停在哪一天」,否則使用者只會覺得功能壞了(陷阱 #22 的精神)。
③ 只有約 **269 檔**有個股期貨 → 沒有的列自然不顯示,不會把自選版面塞爆。
④ 紅綠在這裡表示**漲跌方向**(台股慣例),符合燈號鐵則;⛔ 文案不可寫成買賣訊號。

⚠️ **順手把 `stock_futures.yml` 搬出共用的 `gh-pages-push` group**(同 V73.7.9 的修法)——
`0 14 * * 1-5` = 台北 22:00,正好可能撞上 daily_miner 20:00 那輪的 deploy job。
一天只有 2 次機會,擠掉一次就少一天資料。
⛔ 但**這不代表已修好** —— `stock_futures_miner.py` 有三處 `sys.exit(1)`
(缺金鑰 / 登入失敗 / `len(out) < MIN_FUT`),也可能是「跑了但失敗」。
🚨 **它是夜盤採礦,⛔ 白天手動觸發會把日盤資料寫成「夜盤」** → **只能等夜盤時段看 log**。
測試 `scripts/test_favfut.mjs` 19 條(已用「拿掉守門 / 門檻改回小時制」注入驗證)。

### 📲 V73.8.5 買點提醒改走雲端(Telegram)—— 關掉 App 也收得到
承 V73.8.4 那個真缺口(`_eodTriggerSweep` 是**前端定時器**,App 完全關掉就不跑)。

⛔ **兩個新模式跟舊的 summary/watch 完全分開** —— V21.4 停用那兩個的決策**沒有被推翻**
(它們只發大盤層級籠統摘要、讀不到個人資料);新的問的是「哪一檔、什麼價、什麼時候」。

| 模式 | cron | 做什麼 |
|---|---|---|
| `playbook` | `0 12 * * 1-5`(台北 20:00) | 推明日作戰清單前 2 檔(觸發價/停損/樣本數) |
| `eod` | `20 5 * * 1-5`(台北 13:20) | 讀即時報價比對觸發價,站上了才推 |

⛔ **七條不可改掉的設計**:
① **`eod` 刻意只跑一輪** —— ⭐ 無狀態就不可能重複推(不用維護「今天推過誰」),
   而 13:20 正是實測進場時窗(13:00~13:28)的中間。
   ⛔ 別改成每 5 分鐘:要做去重,而且**會把使用者吵到關通知 = 整套失效**。
② 🚧 **即時報價超過 30 分鐘就不發** —— 拿舊價判「買點到了」會害人追高(同 V73.7.7 的教訓)。
   ⚠️ 那代表盤中快照沒跑到,要去查 `live_snapshot`,⛔ **不是把守門放寬**。
③ 🚧 清單 `data_date` 距今 >4 天不發(過期觸發價不可拿去掛單)。
④ ⛔ **文案不可出現「開盤買」**(V72.9.0 實測隔天開盤買少賺一半以上)。
⑤ 一天最多 **2 檔**(V73.0.0);排序跟前端 `_eodTriggerSweep` **同一套**
   (🧬 優先 → **保守下界** `lb`,⛔ 不是原始 `exp` —— V72.9.2)。
⑥ `loose`(不是靠價位觸發)的招 ⛔ **雲端不可自己判定成立**,交給 App 盤中重算。
⑦ 🚨 **`live_quotes.json` 只在 gh-pages,刻意不進 data 分支** →
   workflow 要**另外從 gh-pages 拉**;只拉 data 分支會永遠讀不到即時價(而且不會報錯)。

⚠️ **雲端讀不到使用者的自選/庫存**(那在手機 localStorage)→ 推的是**全市場排序**,
   文案必須誠實寫出來(App 內的清單才有「自己手上的優先」那一層)。
⚠️ 需要 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secrets;沒設就印警告 exit 0,⛔ 不炸 workflow。
🔐 `send_telegram` 只印「有/無」,⛔ 絕不印 token 或含 token 的網址(repo 是 public)。
測試 `scripts/test_tgalert.py` 21 條(守門一律**注入實測**,⛔ 不只看程式碼有沒有那幾個字;
已用「注入把 token 印出來 / 把 cron 改成每 5 分鐘」自我驗證過)。

### 🔔 V73.8.4 「買點到了通知我」—— 功能一直都在,但清單**從來沒說要開啟**
使用者:「應該是你找歷史訊息,等到買點到了…就要跟我告知,這樣不是就可以減少觀察了」。

⭐ **這套 V72.9.0 就做好了,而且比他想的更完整**:
`playbook_scan.mjs` 每晚掃全市場 → `playbook_edge.json`(這一檔自己最會賺的招 + 觸發價)→
`_tomorrowWatchHtml`(盤後清單)→ `_eodTriggerSweep`(13:00~13:28 到價推播,**自選/庫存排最前面**)。

🚨 **但清單上從來沒告訴他「有這個功能、而且要開啟」** → 等於沒有(陷阱 #32)。
更糟的是原文案**無條件**寫著「App 盤中會幫你盯,到價自動提醒」——
**沒開通知時那句是假的**,而使用者會因此不去開、然後錯過買點。

📍 落地 `_pbAlertBarHtml()`(⛔ 沒新增卡片,是清單裡多一行):
- 沒開 → 一鍵開啟 CTA(重用既有的 `_enableAlertsFromBanner`)
- 已開 → 顯示「買點到了會提醒你 ・ 13:00~13:28 ・ 最多 2 檔」
- ⛔ **開關開了但瀏覽器權限沒給 → 仍顯示 CTA**(不可假裝已就緒)
- 🚨 **兩種狀態都要寫「App 要開著或放背景才收得到」** —— 這是前端定時器的真限制,
  ⛔ 不可含糊帶過(不然使用者以為關掉 App 也會響)

⛔ **要糾正的使用者說法**:他說「當天開盤買」—— 實測那樣**少賺一半以上**
(V72.9.0:尾盤買 +1,361,088 / 隔天開盤買 +818,734 還輸 0050 / 跳空>1% 不追**倒賠**)。
→ 提醒時窗刻意只有 **13:00~13:28**,⛔ 別為了「早點知道」把它往前挪。

⏳ **已知真缺口(尚未做,要動 workflow 所以先問使用者)**:
`_eodTriggerSweep` 是**前端定時器** → App 完全關掉就收不到。
`telegram_alert.yml` 那條路存在但 ①cron 全被註解掉 ②`build_watch_alerts()` 只推**大盤層級**
(融資爆量/VIX/期現比),**完全沒有個股買點**。
⭐ 要做的話:每晚 `playbook_scan` 跑完推「明日清單」+ 13:20 讀 `live_quotes.json` 比對觸發價推「買點到了」——
   ⚠️ 後者依賴 V73.7.9 剛修好的盤中快照排程,**要先確認它真的每 5 分鐘在產出**才有意義。

⚠️⚠️ 測試 ⑤ 第一版直接掃整份 `index.html` 找那句被禁的話 → **被更新紀錄裡「引用它說明已拿掉」給擋下來**
(這是本專案第 **6** 次踩同一個坑)。⭐ 正解:只掃**真正會渲染的模板**,先排除 `_CHANGELOG` 區段,
並加一條**空過守門**(排除後仍要留著大部分內容,否則這條等於沒驗)。
測試 `scripts/test_pbalert.mjs` 14 條(已用注入缺陷自我驗證)。

### 🛰️ V74.0.1 `pro.html` 產業作戰室 PRO —— 獨立介面(⛔ 不掛在 App 內,使用者明示)
使用者:「以散戶救星當作資料庫,新增一個介面,不顯示在散戶救星裡面,完成後給我一個網址」
+ 進階產業估值系統(防幻覺 Prompt 產生器)+ AI 產業鏈儀表板重新設計。
網址:`https://xin7355-collab.github.io/StockAI-DB/pro.html`(⛔ index.html 一個字都沒改,也不放連結)。

**資料層(全部吃既有 gh-pages 產物,零新採礦)**:
`screener.json`(現價/官方PE/YoY/毛利/f5+t5 法人5日)・**`pe_band.json`**(⭐ 真實每日 PE 近3年
P5/中位/P95 —— V73.3.9 的採礦產物正好是這頁的核心)・`industry_pe.json`(同業中位)・
FinMind TaiwanStockInfo 匿名(中文名,同 App `fetchStockList`,localStorage 快取 3 天)。

**⛔ 三條誠實鐵則(改文案別動)**:
① 台股**沒有免費的分析師預估 EPS** → 一律「**年化EPS = 現價 ÷ 官方PE**」且明標「不是分析師預估」,
   prompt 的防幻覺指令也改成對應公式(⛔ 不可照上傳模板寫「市場預估 EPS」—— 那會讓 AI 把年化講成預估)。
② 隱含區間 = 年化EPS × 近3年 P5/中位/P95 → 一律稱「**歷史估值對照區間**」,⛔ 不是目標價(同 V71.8.2 用詞限制);
   prompt 內建循環股警語(獲利頂峰時 PE 最低)。虧損/無 PE 帶 → 誠實顯「不適用」,⛔ 不硬給。
③ 估值帶漸層用**藍→琥珀(冷→熱)**,⛔ 不用紅綠 —— 貴便宜不是漲跌方向(燈號鐵則)。

**⚠️ 兩個同步點(改東西時要記得)**:
- 🚨 **部署佈線 8 處**:`deploy_pages.yml` 4 處(push paths / cp 到 /tmp/deploy / cp 回 / git add)+
  `daily_miner.yml` 4 處(checkout origin/main / cp 到 /tmp/mine / cp 回 / git add)——
  少 git add 就是 V69.8.7 圖示那種「每天被洗掉、零錯誤訊息」。測試 ① 釘住。
- ⚠️ **AI 鏈名單是 index.html `_AI_CHAIN` 的副本**(獨立頁不共用程式)→ **改名單要兩邊一起改**
  (index.html `_AI_CHAIN` + pro.html `PRO.CHAIN`),陷阱 #37 的已知妥協,測試兩邊各自驗完整性。

測試 `scripts/test_prohtml.mjs` 25 條(3 種注入缺陷驗過;⭐ 測資要含**負值**,
否則「null 當 0」的壞排序也剛好把 null 排最後,注入驗證會漏)。

### 🚨🚨 V74.2.1 上櫃股「只有收盤價是 null」—— 真因是**修它的那段程式碼自己漏掉了這個情況**
做 `pro.html` 加矽晶圓時發現的,⛔ **不是前端問題,是採礦端的資料缺口**:

| 檢查 | 實測(2026-08-29) |
|---|---|
| `data/6488.json`(環球晶,上櫃) | 797 根,**只有最後 2 根**(08/27・08/28)`close` 是 null |
| 同型:5483 中美晶・3680 家登・3491 昇達科・5274 信驊… | **完全一樣**,都是最後 2 根 null |
| `data/2330.json`(上市,對照組) | 0 根 null,08/28 收 2420 ✅ |
| 全市場抽驗 382 檔 | **188 檔(49%)最後一根 close = null** |
| 連帶 `screener.json` | 只剩 **1,301 檔**(`screener_miner` 算不出東西就略過)→ AI 鏈 81 檔裡 17 檔數字全空 |

⭐⭐ **決定性線索:那兩根的 `open`/`high`/`low`/`volume` 全都有值,就是 `close` 是 null。**
⛔ 這不是「資料沒抓到」(沒抓到會整根不存在)—— 是**盤中快照留下的空殼**
(盤中還沒有收盤價),而上櫃股的官方收盤資料沒回來覆蓋它(TPEX 端點對機房 IP 失效,V73.6.1 已實測整站 403)。
⚠️ 只看「最後一根 close 是 null」會往「TPEX 抓不到」走;**把整根印出來**才看得到真相。

🚨🚨 **真因(最諷刺的部分)**:miner.py **本來就有**一段 yfinance 校正,
註解白紙黑字寫著「上櫃股 TPEX 舊端點已失效 → 最近交易日常殘留 MIS 盤中快照」——
它就是為了修這件事而寫的。⛔ **但判斷式漏掉了最嚴重的那一半**:
```python
old_c = existing_map[ds].get('close') or 0        # ← close 是 None → old_c 變 0
if old_c > 0 and abs(yr['close'] - old_c) / old_c >= 0.015:   # ← old_c > 0 為 False → 整個跳過
```
→ 它只修得了「**有值但不準**」,修不了「**根本沒值**」。
⭐ 通用鐵則:**`x = a or 0` 之後再用 `x > 0` 當守門,等於把「沒有值」跟「值是 0」一起靜默排除掉** ——
   而「沒有值」往往正是最該處理的情況。⛔ 要區分就用 `is None`,別用 `or 0` 壓平。

🚨🚨 **但 V74.2.1 修完實跑一輪,資料完全沒變** —— 因為**更前面還有一道守門**把整檔跳過了。
⭐ 是 job log 說出真相的(⛔ 不是推理出來的):`🛰️ [95/135] 6488 … ⚡ 本日 K 線與最終籌碼已完整,安全略過證交所請求`。

**第二層真因(V74.2.2)**:
```python
if row['volume'] is not None and row['volume'] > 0:   # ⛔ 只看量,完全沒看 close
    latest_valid_date = fmt_date
has_gap = any(d not in existing_map for d in recent_10)   # ⛔ 只看「日期在不在」
```
盤中快照寫下的空殼**有 volume**(6488 08/28 量 11,494,305)→ `latest_valid_date` 認定「今天採完了」、
`has_gap` 認定「沒有洞」→ 走進「安全略過」分支 → **連 V74.2.1 剛修好的校正都沒機會執行**。
→ 新增 `miner.bar_is_complete(rec)`(收盤價與量**都要有**才算數),接進**那兩處**守門(⛔ 只接一處等於沒修)。
⭐ 這正是**陷阱 #10 的第二次犯案**:跳過條件要同時看「做過」與「**做到的內容夠不夠好**」。

⭐⭐ **這次最該記住的三件事**:
① 🚨 **修完一定要實跑驗證,⛔ 不可看到「測試綠 + workflow success」就宣告修好** ——
   V74.2.1 兩者皆綠,資料卻一個位元組都沒變。
② ⭐ **修不好時先問「它到底有沒有執行到」**,而不是再改一次判斷式 ——
   答案就寫在 job log 的那一行,而我原本準備要去改的是完全正確的程式碼。
③ ⚠️ **同一個 bug 常常有兩層守門**:外層決定「要不要做」、內層決定「怎麼做」。
   只修內層 = 白修。

📍 **V74.2.1 的修法**(仍然需要,它是內層):抽成純函式 `miner.needs_price_fix(old, new)`,四種情況分開處理
(沒值→修 / 差 ≥1.5%→修 / 差很小→不動 / **新值本身無效→⛔ 絕不覆蓋**);
並且 `stale_recent` 名單要涵蓋「官方這次有回、但收盤價仍是空的」(⛔ 否則 `official_dates` 會把它排除掉)。
**第三層(V74.2.3)**:修完前兩層實跑後,86 檔裡仍有 **3 檔**(6690/3131/6187)進不了 screener ——
它們**最新一根是好的,壞的在歷史中間**,而 yfinance 校正只看**最近 10 個交易日** → 補不到。
下游只要遇到一根 `float(None)` 就整檔算不出東西,被 `except` 吞成「略過」、零錯誤訊息。
→ ① `export_json` **寫檔前濾掉沒有收盤價的列**(根治,所有下游都受益;⛔ 全是壞列時不可寫出空檔)
  ② `screener_miner` 也加同樣的防禦(⛔ 只做根治不做防禦,舊檔還在時仍然算不出來)。
測試 `scripts/test_pricefix.py` 37 條(三層守門各自釘住,6 種注入缺陷驗過)。

📊 **三層修完的實測結果**(⭐ 一律驗**產物**不看綠燈):
| | 修前 | 修後 |
|---|---|---|
| `screener.json` | **1,301 檔** | **2,336 檔** |
| 6488 環球晶 K 線 null | 2 根 | **0 根**(08/28 收 972.0) |
| AI 鏈 86 檔裡數字全空的 | 17 檔 | **3 檔 → 0 檔**(第三層修完後) |

⚠️ **`screener_miner.py` 不在 `daily_miner` 裡跑,掛在 `playbook_scan.yml`(每晚 19:00)** ——
K 線修好之後 screener 不會馬上更新,要等那支或手動觸發。⛔ 查「前端為什麼還沒好」時要記得這條鏈。
⚠️ 那支測試的 ⑤c(掃全檔有沒有同型寫法)**第一版被自己的註解擋下** —— 說明 bug 的註解裡就寫著壞寫法本身
(本專案第 8 次踩這個坑)→ 掃描前一定要先排除註解行,並加空過守門。
📍 **前端同時誠實處理**(⛔ 不可靜默):`pro.html` 戰情表上方寫「N 檔的數字目前是「—」…
   不是這幾檔沒在動,也不是程式壞掉」。⚠️ 那行提醒第一版放在**上一個 panel**,
   使用者捲到表格時根本看不到(陷阱 #32 再犯)→ 測試 ⑳b 用 `closest('.panel')` 釘死它必須跟表格同區塊。

### 📌 V74.2.0 表格凍結 + AI 鏈名單 67 → 81 檔
使用者:「滑到個股戰情表,標的這欄及這列我要固定住…標的這列文字要置中」+「矽晶圓、無人機要加嗎」。

**① 表格凍結的關鍵細節(⛔ 別退回去)**
- 🚨 **表頭 `position:sticky; top:0` 要生效,容器必須自己有垂直捲動** —— 只設 `overflow-x:auto`
  的話 sticky top 找不到捲動祖先,**看起來有寫但完全沒作用**。→ `.tblwrap` 改 `overflow:auto` + `max-height:72vh`。
- ⚠️ **`border-collapse` 必須改成 `separate`** —— collapse 模式下 sticky 儲存格的邊框會消失/穿透。
- ⚠️ **sticky 的 td 一定要有自己的 `background`**,否則捲過去的內容會透出來。
- 🚨 **容器變成「雙向都捲」之後,手勢守門要一起補**:原本只排除 `overflowX`,
  ⛔ 沒補 `overflowY` 的話,在表格裡上下滑會誤觸發「下拉重新整理」。

**② 新增 14 檔(⭐ 兩份名單要一起改:`index.html _AI_CHAIN` + `pro.html PRO.CHAIN`)**
矽晶圓 6488/5483/6182/3532・EUV光罩盒 3680・光罩 2338・均熱片 3653・UPS 6409・
連接器 3023/2392・光通訊 4979・資安 6690・無人機 8033/2634。
⛔ **誠實標註寫進 risk 欄,不可只寫好話**:矽晶圓「近年供過於求,AI 連動不如 CoWoS 直接」、
無人機「營收占比小,題材成分高」、資安「內需標案為主,AI 直接受惠有限」。
⛔ **8497 經緯航太沒有 K 線資料 → 不加**(⛔ 不可為了「補齊題材」放一個永遠沒數字的代號)。

⚠️ **測試自己又踩兩個坑(都靠空過守門/注入驗證抓到)**:
① sticky 測試在 **1280 寬**跑 → 表格塞得下、根本捲不動 → 三條斷言全部假通過。
   → 改用**手機寬度**,並加對照組「沒凍結的欄位捲動後自己要移動」。
② 「表頭置中」只驗第一個 `th` → 被 `th:first-child` 的規則遮住,
   把整排改成靠右也照樣通過。→ 改成**整排都要 center**。

### 📋 鐵則(使用者明示 2026-08-31):**爾後每一次回測/探針,結論都要同步記進 `pro.html` 的 `PRO.LAB`(🔬 實測總表)**
- 分五欄:`ok` 實測有用 / `trap` 實測沒用 / `method` 回測自己的坑 / `blocked` 還測不了 / `next` 推薦下一步。
- 每一條都要附**實測數字 + 來源探針檔名**(測試 ㉔d 釘住「沒有數字的意見不准進來」)。
- ⚠️ CLAUDE.md 的決策紀錄與 LAB 是**同一件事的兩個讀者**(Claude vs 使用者)——
  寫完 CLAUDE.md 那節,**當場**補 LAB 那條,⛔ 別留到「下次順手」(陷阱 #37 的溫床)。
- ⭐⭐ **使用者追加(2026-08-31 第二則):驗證完成的條目要「當場歸類」** ——
  從 `next` 欄**移進** ok/trap/blocked,⛔ 不可留在推薦欄掛「✅已測完」
  (實例:處置股/時間停損/板塊內部挑法三條測完了還掛在推薦欄,被使用者抓到)。
  `next` 欄唯一合法的狀態是「還沒做」。
- ⭐ **同一則授權:「值得驗證及回測的,直接幫我驗證及回測」** —— 純回測/探針(只讀、不改 App 判定、
  不動 workflow)不用問,直接做;⛔ 但「要開始存新資料 / 改採礦」仍照原規則先問。
- 🔍 **漏收錄巡邏指令**:比對「CLAUDE.md 探針登記表的檔名」與「LAB 條目的 `s:` 來源」——
  登記表有、LAB 沒引用的就是漏的(V74.4.3 一次抓出 11 支,補了 8 條)。

### 🏅 V74.4.4 實測總表排名 + 🕯️ 跌停紅K 落地(V74.0.7)+ ⭐ K線深歷史回算開跑
- **排名**(使用者:「做一個排名,爾後加進來的自動重新排名」):ok 欄每條帶 `r:` 排序分,
  `renderLab` **渲染時**依 r 遞減排(→ 新條目帶 r 就自動插進名次)、前三名 🥇🥈🥉。
  規則:配置類(差多少錢)> 事件訊號(扣成本後邊際)> 避雷 > 描述型;
  ⭐ **樣本薄的要降分**(偷布局 +3.81pp 但 n=15 → r=38),⛔ 不可只看邊際大小。
  ⛔ 新增 ok 條目**必帶 r**(測試 ㉛ 釘住,忘了會排最後顯「未評分」)。
- **🕯️ 跌停後第一根紅K 落地 index.html V74.0.7**(`_ldRedKHtml`,K線頁 K棒戰法卡,⛔ 沒新增卡片):
  定義跟探針**一字不差**(跌停 ≤−9.2%、紅K=跌停**隔一個交易日**就收漲;⛔ 改了要重跑回測);
  🚨 必顯「當初大盤有沒有一起跌」(差 4.8 倍;^TWII 非同步 → 佔位再填,填時驗 sym 防切股殘留);
  小紅要講「參考價值低很多」;⛔ 無指令動詞。測試 `scripts/test_ldredk.mjs` 13 條,2 種注入驗過
  (⚠️ 第一次注入**沒打到目標** —— 「別急著接」全檔有 7 處,replace 改到別處 → 注入前要先
  `count==1` 驗唯一性)。⚠️ 插進 render path 會弄壞 `test_luodds` ⑧b 釘的接線字串 → 一起更新。
- **⭐ K線深歷史回算**(`scripts/klines_backfill.py` + `klines_backfill.yml` 手動):
  FinMind TaiwanStockPrice 一檔一次呼叫補到 **2021-01**(涵蓋 2022 空頭)+ **2021 後下市股**
  (TaiwanStockDelisting,修倖存者偏誤)。推獨立 orphan 分支 **`klines_deep`**(⛔ 不碰 data/gh-pages);
  token 輪動共用 `dispo_probe.fm`、分割斷崖回調共用 `miner._backadjust_splits`(⛔ 不寫第二份);
  守門:2330 探路(回溯不到 2021 就不開火)/ 冪等接續 / <500 檔拒推 / 只增不減。
  ⚠️ 與 daily_miner 共用付費金鑰 → ⛔ 別同時跑。讀法:`git archive origin/klines_deep`。
  ⏭️ 分支填好後:把 portfolio_backtest / 各 regime 類探針指到深資料重跑 2021-2023 窗口 —— 那才是這件事的目的。
- 🚪 **出場 × 新配置(2檔+🧬)重測 —— 結論:⛔ 預設仍不改,但學到一課**:
  trail8/40 兩種本金設定都「賺較多+回撤小很多」(正式 15 萬版:+294.0 萬 vs ma5 +259.9 萬,
  回撤 **−24.7% → −17.0%**),🚨 但穩健性在**正式配置下沒過**(去最好月 2024-06 轉負 −19,659、
  2024/2025 兩年為負);10 萬版(使用率僅 44%)反而六關全過。
  ⭐⭐ **「資金設定會翻轉穩健性判定」**:錢常用完 → 排擠 → 挑到的單子不同 → edge 變樣。
  ⛔ 回測變體一律用**正式配置**做最終判定,寬鬆配置的全過不算數(已入 LAB method 欄)。
  → trail8 定位 = 「怕回撤的人」的取捨選項(回撤改善兩版都穩定 −7~8pp),⛔ 不是升級。

### ⭐⭐ V74.4.5 K 線深歷史(2021 起,含 2022 空頭)—— 回算完成 + 合併時踩到的坑
`klines_backfill.py` + `klines_backfill.yml` 實跑完成:**2,535 檔 ・回溯 2021-01-04**
(FinMind TaiwanStockPrice 一檔一次呼叫;含 2021 後下市股 54 檔修倖存者偏誤),
推 orphan 分支 **`klines_deep`**(⛔ 不碰 data/gh-pages;讀法 `git archive origin/klines_deep`)。

🚨🚨 **合併時第一版做錯了,而且是「實跑輸出」抓到的**(⛔ 別再犯):
直接把深歷史接到 `data/*.json` 前面 → 回測印出「**0050 買進持有 −10.32%**」配
「**加權指數 +206%**」—— 那個組合**物理上不可能**,一眼就知道基準壞了。
去查才發現 0050 在接縫處有 **×0.25 的斷崖**。
⭐ 真因:0050 分割時**停牌 8 天**,而 `miner._backadjust_splits` 有一道
`gap > 5 → 不當成分割`(那是為了避免把「長期停牌後的真實跳空」誤判成分割)
→ **「分割 + 停牌超過 5 天」這種組合它修不掉**。⚠️ 這是陷阱 #21 沒寫到的一個缺口。

⭐ **正解:用重疊期的中位比值對齊尺標**,⛔ 不去動採礦機的守門:
深歷史涵蓋 2021~今天、既有涵蓋 2023-06~今天 → **重疊 3 年**,
取每天 (深歷史收盤 ÷ 既有收盤) 的**中位數** = 兩邊的尺標差(一致→1.0、沒除分割倍數→4.0)。
一律**以既有列為準**(那是前端在用、也是所有既有回測的基準)。實測 **580 檔需要調尺標**。
🚧 **而且要有「合併後仍有斷崖就整檔不寫」的守門** —— 實測還有 129 檔對不齊
(深歷史本身有大洞、或停牌太久),⛔ 寧可那幾檔窗口短一點,也不可以讓壞掉的價格進回測母體。
✅ 驗證:抽驗 246 檔,**這次合併造成的新斷崖 0 檔**;殘留的 14 檔**合併前就有**。

⏭️ **順帶量到一個既有問題**:gh-pages 上約 **5.7% 的股票**(全市場推估約 140 檔)
本來就有價格斷崖 —— 比陷阱 #21 記載的 72 檔多。真因很可能就是上面那個
「分割時停牌 > 5 天」的缺口。⚠️ 它同時影響新舊回測(可比性不受影響),
但要修的話是**採礦端**:把 `gap > 5` 放寬、或改用「重疊期比值」那套。
⛔ 改之前要先寫測試(那會動到所有股票的歷史價格)。

#### 🚨🚨 V74.4.6 長窗口重跑(49 個月,含 2022 那段跌勢)—— **「🧬 一定贏 0050」不成立**
乾淨合併後用**完全相同的正式配置**(600 檔・每天 2 檔・每筆 15 萬・尾盤進場・跌破 5 日線出場)重跑:
| | 36 個月(舊窗口) | ⭐ **49 個月**(2022-08 ~ 2026-08) |
|---|---|---|
| 只做 🧬 高位階+高波動 | +289.6 萬 ・回撤 −22.4% | **+195.5 萬 ・回撤 −32.4%** |
| 不挑(照清單順序做) | +126.1 萬 ・回撤 −24.0% | **+107.8 萬 ・回撤 −31.8%** |
| 🆚 0050 買進放著 | +201.2 萬 | **+260.0 萬** |
| 加權指數 | — | +206.1% |

⭐ **成立的部分**:「挑 🧬 比不挑好」在長窗口**仍然成立而且差距更大**(+87.7 萬 vs 舊窗口 +163.5 萬…
比例不同但方向一致),而且這次的窗口多含了一段跌勢 → 可信度比 V73.2.3 那次又高一級。
🚨 **被推翻的部分**:V73.2.9 寫的「**挑了就贏 0050**」⛔ **只在 36 個月的窗口成立**。
長窗口下**兩種都輸給買 0050 放著**,而且 🧬 原本的**回撤優勢也消失了**(−32.4% vs −31.8%)。
→ ⭐ 對使用者的誠實說法改成「**🧬 讓你少輸,⛔ 不是讓你一定贏大盤**」,已寫進
   `pro.html` 的 `_SIG_DEEP` + 今日訊號頁 + LAB 的 r:100 條目。
⚠️ 限制:0050 在這段 +260% 是因為窗口起點(2022-08)接近那波跌勢的後段 → 買進持有天生佔便宜;
   而且 129 檔因為合併後仍有斷崖而維持短窗口(母體略有差異)。
⭐⭐ **通用鐵則**:**窗口長度會翻轉結論** —— 這是第三次了
(V73.2.9 窗口 13→36 個月翻轉、V74.3.5 出場矩陣 13→36 個月把 trail8 從墊底變第一、這次 36→49)。
⛔ 任何「這個做法贏大盤」的主張,都要標明**是在哪一段窗口量的**。

### 📖 V74.4.5 使用者鐵則:實測總表(與所有給使用者看的文字)要「一般散戶看得懂」
使用者:「文字敘述有需要就用範例,不需要的就寫簡單一點的方式敘述讓一般散戶也看得懂,
另外有些英文如果不是必要的、是什麼專業術語請翻成繁體中文,**爾後這裡面的資料也是用此方式**」。
- **非必要英文一律翻中文**:Jaccard→名單重疊率 ・cosine→行為相似度 ・parity→轉換價比值 ・
  cell→格 ・AUC→鑑別力(0.5=丟銅板)・edge→優勢 ・P95→第95百分位 ・P90/P10→最好/最差的10% ・
  ma5→跌破5日線 ・trail8→移動停利8% ・PE→本益比 ・CB→可轉債 ・per-broker→整家券商。
- **保留的**:股票代號、探針檔名、機構名(TWSE/TPEx/FinMind)、常見技術指標(RSI/KD)、模型名。
- ⭐ **常用統計字不逐條翻**(pp/n/中位/對照組)—— 逐條翻會讓每一條又臭又長 →
  改成 LAB 頂部一個**「📖 名詞速查」**摺疊區解釋一次;新增條目用到新術語要補進去。
- ⚠️ 翻譯會**打斷釘住字串的測試**(㉔f 釘 `Jaccard 0%`)→ 斷言改成兩種寫法都收。

### ⭐ V74.4.5 三種進場法(使用者提的「開盤前掛前一日收盤價」)—— 實測是最糟的
使用者:「開盤前的掛單可以用前一日的交易日收盤價格去掛,沒掛到就算了」。
⭐ 這跟已測過的「隔天開盤買」是**完全不同的東西**(限價單只在回檔時成交)→ 值得測。
`portfolio_backtest.mjs` 加 `ENTRY=prevclose_lim`(開盤已低於掛價→成交在開盤價;
盤中最低觸及→成交在掛價;都沒有→放棄)。**同一批股票、同一套配置(36個月/2檔/15萬/🧬),只改進場時機**:
| 進場 | 累積損益 | 最大回撤 | 每趟 |
|---|---|---|---|
| ⭐ 訊號日尾盤 | **+2,598,561** | −24.71% | +1.31% |
| 隔天開盤 | +1,273,162 | −31.49% | +0.72% |
| **掛前一日收盤價** | **+124,069** | **−46.10%** | +0.09% |
| 🆚 0050 買進放著 | +2,011,700 | — | — |
⭐⭐ **真因不是「掛太低買不到」** —— 是**會成交的那些正好是「訊號出了、市場卻不買單」的弱股**;
真正走遠的不會回頭讓你撿。同族:「跳空>1% 不追」倒賠。⛔ 別再提任何「等回檔再進場」的變體。
⚠️ 沒成交時 `i++` 繼續掃 → 候選訊號池比 close 版大(結構差異),但差 20 倍不影響方向。

### 🌅 V74.4.5 盤前體檢分數回測(使用者:「我覺得還滿準」→ **實測支持**)
⛔ 成分沒有歷史(`macro_risk` 只有快照、`risk_history` 42 天且缺權重最高兩項)→
`scripts/premkt_probe.py` 去 yfinance 抓 5 年海外歷史自己重建。
🚨 **時區對齊**:一律用 **T−1 的海外收盤**預測 T 日台股(零前視)。
📊 1,212 個交易日(含 2022 空頭):
| 分數 | 次數 | 開高比例 | 全天 | **開盤買收盤賣** |
|---|---|---|---|---|
| ≥3 | 522 | **84.7%** | +0.672% | **+0.281%** |
| ≤−3 | 425 | **24.5%** | −0.600% | **−0.293%** |
⭐⭐ **最重要的方法論**:「分數高 → 開高」有一大半是**同義反覆**(昨晚美股漲台股本來就開高,
那不是預測)→ 真正的預測力要看「**開盤之後還會不會續漲**」= **+0.574 個百分點,
而且 6 年每一年都同方向**(最差 +0.220)。⛔ 少了這一拆會嚴重高估這個分數。
⛔ 三條限制:① 只測得動**海外連動那一半**(外資籌碼/夜盤/技術分數無歷史)
② 那 0.574pp 是**大盤指數**、扣成本後剩不多 ③ 本站實測**拿大盤方向篩個股會少賺**
→ 正確用法是調整心理預期與部位,⛔ 不是「分數低就整天不做」。
🚨🚨 **接進前端時開了 STRICT 模式** —— 前端 `macro_risk` **沒有道瓊也沒有恆指**,
探針用 10 個成分、前端用 8 個 = **同名不同義**(前端顯示的分數配探針的成績單)。
⛔ 改前端 `_premktScore` 的成分/權重,就要重跑 `PREMKT_STRICT=1` 更新 `_PREMKT`。

### 🎯 V74.4.5 今日訊號頁(產業作戰室第 4 個分頁)
使用者:「[實測有用] 的資訊請全數收入產業作戰室,開一個高勝率訊號頁面併寫出勝率、
還有要怎麼操作、注意什麼」。**零新採礦** —— 讀 `playbook_edge.json` / `today_signals.json` /
`screener.json` / `macro_risk.json`(全是既有產物)。
⛔ 五條鐵則(測試 ㉜/㉝ 共 20 條,5 種注入驗過):
① 勝率一定配次數,<10 次標「不能當結論」 ② 必須寫「基準勝率 36% 不是 50%」
③ ⛔ 整頁不可出現「開盤買」 ④ 空頭趨勢(bear)的標的要標出來 ⑤ 資料日期要顯示、過期要擋。
⭐ 排序跟散戶救星推播**完全一致**:🧬 優先 → 保守下界(⛔ 不排原始期望值)。

### 🆕 V74.4.5 總覽提醒 `_ovNewEdges`(使用者:「把滿足條件的加入總覽頁面提醒」)
接進散戶救星總覽「⭐ 重點判讀」常顯區(⛔ 沒新增卡片、條件觸發):
① 🕯️ 跌停後第一根紅K(必須同時講「當初大盤有沒有一起跌」—— 差 4.8 倍)
② ⚠️ 5 日噴 ≥30% 且**在官方注意股名單**→ 減碼提醒(⛔ 不可自己推估誰會被列注意;⛔ 不是放空訊號)

### 🧹 V74.4.3 空白修正 + 推薦欄清倉 + 三個 next 回測(使用者:「驗證完的自動歸類、還沒做的繼續做」)
- 🚨 **實測總表上方一大塊空白**(使用者截圖):真因是 `#tabLab` 被留在 `.wrap` **外面**
  → 吃到 `.wrap` 的 `padding-bottom: 80px+safe-area`。⭐ headless 量四個分頁 panel 的 top
  (126/126/126/**206**)一眼定位。⛔ 分頁容器必須全部在 `.wrap` 裡(測試 ㉚ 釘住,注入驗過)。
- 🕳️ **「缺口不補繼續走」六關 0 過**(`gapfill_probe.mjs`):22,541 個真缺口(今低>昨高×1.005),
  第 5 天「沒回補 +0.25pp vs 已回補 −0.27pp」—— **方向跟朱家泓一致但沒有可交易邊際**
  (每一格前後半不同向、去最好年轉負、扣成本全負;沒回補×高位階也只剩 −0.30)。
- 🧙 **「券商×產業專長」不存在**(`broker_ind_probe.mjs`,546 萬筆):cell 名單跨半段
  **Jaccard 4.7% ≈ 隨機期望 5.3%**、驗收段前段班邊際 −0.03pp;
  對照 per-broker 層級 Jaccard 34.5%(有結構但已知頭尾差 < 成本)。
  ⭐ 「先報名單穩定度再談報酬」第二次派上用場(同盟集團教訓)。
- 📚 **LAB 漏收錄稽核**:diff「探針登記表檔名 vs LAB `s:` 來源」抓出 11 支沒引用 →
  補 8 條(⭐ 含使用者點名的**星期一效應**:大盤週一平均最差 −0.119% 但**中位 +0.182%**
  = 偶爾重摔不是常常跌;做濾網少賺 23 萬)。
- 🚪 出場 × 新配置(每天 2 檔+🧬)重測:見下一節的表。

### 🚨 V74.4.2 處置/注意股「官方名單」事件回測(使用者:「回測進處置及注意股 + 前幾天的漲跌」)
⭐⭐ **歷史根本不用等**(⛔ 我在 LAB next 欄原本寫「要先開始每天存」—— 錯的):
- **處置**:FinMind `TaiwanStockDispositionSecuritiesPeriod` 給 `start_date` 一次回 **2,272 列、回溯 2023-06(3.2 年,上市+上櫃都有)** —— miner 只有 120 天是**自己設的窗**,不是資料的限制(同集保 13 週那課,**第二次**)。
- **注意股**:TWSE 官網查詢端點 `rwd/zh/announcement/notice?startDate=&endDate=` 逐月抓 → **11,857 筆(2023-06 起)**。⚠️ 只有上市 —— TPEx 整站對 runner 403(V73.6.1);FinMind 沒有注意股 dataset(4 個候選名全 422)。
- 取法:探針把事件壓成 `D|`/`N|` 行印進 job log → 本地從 log 收(⛔ 不寫檔不碰分支)。⚠️ MCP proxy 擋 Azure blob(log 下載網址)→ 用 `get_job_logs` 讓結果落地成檔再解析。

🚨 **探針首跑兩個「安靜變 0 筆」的 bug**(都是實跑輸出抓到的):
① TWSE 回的日期是**點分隔民國年**(`113.03.08`),roc2iso 只吃斜線 → 271 列全被丟成 0 筆、零錯誤訊息;
② 注意名單**混著權證**(069954 中興電中信38購01)→ `is_stockish`(4 碼或 00 開頭)濾掉。

📊 **回測結論**(`dispo_backtest.mjs`,進場=公告隔天開盤、排除鎖死、扣同期加權、10 日去重;對照組 20 日:均 −1.93 / 中位 −3.11 / 勝率 34.9%):
| 事件 | n | 20日邊際 | 判定 |
|---|---|---|---|
| 進處置(全部) | 1,441 | +1.62pp・**中位 −4.81%**・勝率 40.4% | ⛔ **賠率型**:大多數繼續跌、少數妖股大噴拉高平均;逐年不同向(2023 −0.9)→ 不能當進場訊號 |
| 慣犯(cnt≥2) | 985 | +2.04pp | 方向同「越關越大尾」但 2023 負 ❌ |
| **出關後** | 1,613 | +1.19pp | ❌ 前後半不同向 → **「出關行情」量不出來** |
| 進注意(全部) | 3,543 | +0.67pp | 微弱;逐年全正但 < 有意義門檻 |
| ⭐ **前5日噴 ≥30% 才掛注意** | 524 | **−1.81pp・中位 −7.21%・勝率掉回 34.5%** | ✅ 唯一清楚的方向(**負的**):前後半同向、去最好年 −2.90 → **避雷提醒**,⛔ 不是放空訊號 |
⭐ 使用者問的「**前幾天漲跌**」分桶(處置):+1.07/+2.60/+1.04/+1.91pp **非單調** —— 進處置前噴多噴少,不改變處置後的期望。
⚠️ 限制:處置股 5/20 分盤撮合、流動性差 → 實際滑價更糟;注意股只有上市;窗口偏多頭;倖存者偏誤。⛔ App 判定邏輯一行沒改(這是回答問題);結論已入 LAB。

### 🧼 V74.4.2 「大戶洗散戶」的特定走法 —— **量不出來**(`scripts/washout_probe.mjs`)
使用者:「大戶在洗散戶籌碼的時候是不是有特定的走法?怎麼清洗?」
可測版本:噴 ≥20% 後回檔 5~25%(n=3,327),回檔期間用**集保週資料**分「洗盤樣」(大戶↑散戶人數↓,分位前 1/3)vs「出貨樣」(反向);對照組=**全部回檔事件**(共用那條腿)。
- 🧼 洗盤樣 +0.50pp vs 🏃 出貨樣 +0.58pp —— **兩邊幾乎一樣,而且都前後半不同向** → 集保方向**分不出**洗盤與出貨(同四象限❌、隱藏大戶❌ —— 這是集保「方向類」主張第三次陣亡)。
- 交叉量能後唯一漂亮的一格是「**出貨樣×量增 +3.36pp**」—— 跟坊間說法**完全相反**的那格 = 8 格多重比較的預期內,⛔ 不採。
- 「回檔量縮」單獨 +1.61pp 方向對但前後半不同向(**第三次**未過關,同評估紀錄⑪)。
⭐ 真因:集保是**週**資料,回檔 10 個交易日只夾得到 1~2 週 —— **頻率太粗,「怎麼清洗」量不到**。⛔ 別再用集保做洗盤判定;要真的答這題需要逐日分點×逐日散戶結構,而散戶結構沒有日頻來源。

### 💧 V74.4.2 板塊輪動三修(使用者三點,全在 pro.html)
① **成員名單總覽**(`#rotMemWrap` 預設打開):「整個包起來不知道個股有誰」→ 每板塊一列、成員 chips 點了跳散戶救星;題材全列、官方產業列成交額前 10。⛔ 成員判定抽成 **`_grpMembers` 全 App 唯一一份**(明細與總覽共用,陷阱 #37;測試 ㉙g 釘「`Object.keys(scr.ind).filter` 只准出現一次」)。
② **個股「資金走向」叫回來**(使用者明示推翻 V74.3.9 的「不做」):明細表加「💸 外資走向20日」欄 —— 每檔近 20 交易日逐日外資買賣超 sparkline(讀 `data/{sym}.json` 的 `foreign_net`,**股→張 /1000**)。⛔ **描述性**:0.64x 免責 +「不是跟單訊號」必須在(測試 ㉙e);只給前 10 檔(一檔 ~100KB);全 0 誠實顯「—」。⚠️ 播放中明細每拍重繪 → async 填格回來要照 `data-sy` 重找 DOM。
③ **選中樣式**:`.rotchip.on` 改實心青底+深字+光暈(「按下去沒差異」)。⚠️ `.rotchip.on` 兩個 class 的特異度天然蓋得過 `.up/.dn` 文字色。
⚠️ 測試 ㉕f 的舊句「個股逐日法人流向沒有存歷史」因 ② **已不成立** → 斷言跟著改成釘「表格是最新快照 + 走向欄要宣告自己的窗口」。㉙ 系列 4 種注入缺陷驗過。

### 🏭 V74.4.1 板塊選對之後,產業「內部」怎麼挑(`scripts/sector_pick_probe.mjs`)
V74.2.5 證明「前 3 強板塊」有 +1.44pp,⛔ 但**第二步從沒測過**。
⭐⭐ **對照組必須是「強勢板塊裡的所有股票」** —— ⛔ 拿全市場當對照,
量到的是「選對板塊」的功勞不是「挑股」的功勞(同 broker_cross_probe 共用那條腿的做法)。
**1,077 檔上市股 × 483 個交易日 ・12,209 個 pick ・對照組 7,724 ・進場=隔天開盤。**

| 在前 3 強板塊裡挑 | 10日 | 前後半 | 逐年 | 去最好年 | 扣成本 |
|---|---|---|---|---|---|
| ① **近 20 日漲最多** | **+1.34** | ✅ | ✅ | +1.18 | **+0.90** ⭐ |
| ⑦ 🧬 高位階+高波動 | +0.93 | ✅ | ❌ | +0.40 | +0.49 |
| ⑥ 龍頭(成交額最大) | +0.47 | ✅ | ❌ | **−1.41** | +0.03 |
| ③ 位階最高 | +0.46 | ✅ | ❌ | −0.44 | +0.02 |
| ④ 位階最低(便宜) | −0.15 | ❌ | ❌ | −0.98 | −0.59 |
| ⑤ 波動最大 | −0.27 | ❌ | ❌ | −0.64 | −0.71 |
| ② **最弱(補漲)** | **−0.40** | ✅ | ✅(全負) | −0.71 | −0.84 |

⭐ **結論:板塊選最強、板塊裡再選最強。** 🚨 江湖最愛的「補漲」是**穩定地差**
(逐年全負 = 不是雜訊)。⛔ 別在強勢板塊裡撿弱的、撿便宜的、或只挑龍頭。
⚠️ **🧬 在這裡沒過關不代表它失效** —— 那是 V73.2.5 的教訓:
   已經用「強勢板塊」篩過之後再加 🧬,兩者**重疊**,增量自然消失。

### 🕳️ V74.4.1 跳空缺口 + 回測不破 + 量縮爆量(併進 `streak_probe.mjs`)
| 事件 | 10日 | 六關 | 扣成本 |
|---|---|---|---|
| 🕳️ **向上跳空 × 高位階** | **+1.08** | ✅ 全過 | **+0.64** |
| 🏔️ **創60日高後回測不破(收紅)** | +0.70 | ✅ 全過 | +0.26(薄) |
| 🕳️ 向上跳空(全部) | +0.33 | ❌ 去最好年 −0.24 | −0.11 |
| 🕳️ 向上跳空 × 沒量 | +0.47 | ❌ | +0.03 |
| 🚨 🕳️ 向上跳空 × **低位階** | +0.33 | ❌ 去最好年 **−1.54** | −0.11 |
| 🕳️ 向下跳空 | +0.33 | ❌ 逐年不同向 | −0.11 |

⭐ **跳空本身沒用,要配位階** —— 高位階 ✅ / 低位階是全表最差之一。又一次追強 > 抄底。
⚠️ **「創60日高後回測不破」⛔ 不推翻 `_SIGNAL_EDGE` 對「回後買上漲」的 −0.485%** ——
   那是**絕對**期望值,這裡是**相對隨便挑一天**的超額(對照組本身 −1.26%)。
   兩個都對,問的問題不同。⛔ 別拿其中一個去否定另一個。

### 🕯️ V74.4.0 連漲連跌 + 跌停多久回彈(`scripts/streak_probe.mjs`)⭐ 這輪唯一六關全過的
使用者:「連續漲幾根或者連跌多少會回彈還是會開始跌…還有如欣興今天因被爆導致跌停,
何時會回彈,要注意什麼事件才會回彈」。
**2,268 檔 × 3 年 ・對照組 138 萬個(股·日)・進場 = 隔天開盤(⛔ 跌停那天收盤買不到)
・已排除開盤仍鎖死 ・扣同期加權 ・同檔同事件 10 日去重。**
⚠️ 對照組 10 日 **−1.26% / 勝率 37.1%** —— ⛔ 基準不是 0 也不是 50%。

#### ❌ 「連漲/連跌 N 根」全部不成立(這是使用者問的第一件事)
| | 2 根 | 3 根 | 4 根 | 5 根 | 6+ 根 |
|---|---|---|---|---|---|
| 📈 連漲(10日 pp) | +0.06 | +0.23 | +0.33 | +0.22 | +0.47 |
| 📉 連跌(10日 pp) | −0.19 | −0.10 | −0.20 | −0.16 | −0.15 |
**沒有一格超過來回成本 0.44%** → ⛔ 「連跌幾根會反彈」「連漲幾根該跑」都量不出來。

⭐⭐ **最值得記的對比**:
・🕯️ **跌停**後第一根紅K → **+4.10pp**
・🕯️ **連跌 3+ 根**後第一根紅K → **−0.03pp**
**同樣叫「止跌紅K」,一般回檔後的那種完全沒用。** ⛔ 別把兩者混為一談。

#### ⭐ 跌停後的回彈 —— 六關全過,而且「要注意什麼」有明確答案
| 事件 | 10日 | 前後半 | 逐年 | 去最好年 | 扣成本 |
|---|---|---|---|---|---|
| 🕯️ 跌停後紅K × **大紅(≥3%)** | **+6.15** | ✅ | ✅ | +3.66 | **+5.71** ⭐ |
| 🕯️ 跌停後紅K × **當初大盤也在跌** | **+5.33** | ✅ | ✅ | +4.64 | **+4.89** ⭐ |
| 🕯️ 跌停後第一根紅K(全部) | +4.10 | ✅ | ✅ | +3.08 | +3.66 ⭐ |
| 🔻 跌停 × 量縮 | +2.84 | ✅ | ✅ | +2.33 | +2.40 ⭐ |
| 🔻 跌停 × 大盤也在跌(系統性) | +2.65 | ✅ | ✅ | +1.89 | +2.21 ⭐ |
| 🚨 🕯️ 跌停後紅K × **當初大盤沒跌(個股利空)** | **+1.46** | ✅ | ✅ | +1.28 | **+1.02** |
| 🔻 跌停 × 爆量(≥2倍) | +0.53 | ❌ | ❌ | −1.22 | +0.09 |
| 🔺 漲停 | +1.72 | ✅ | ❌ | **+0.08** | +1.28 ❌ |

⭐⭐ **回答「要注意什麼事件才會回彈」:看大盤有沒有一起跌。**
・**系統性**(大盤也在跌)→ 紅K出現後 **+4.89%**
・**個股利空**(大盤沒跌、它自己被爆,= 欣興那種)→ 只有 **+1.02%**,**差 4.8 倍**
🚨 而且**還沒出現紅K之前**,「跌停 × 大盤沒跌」的 10 日是 **−0.43pp**(全表最差,勝率 36.8% ≈ 對照組)
→ ⛔ **個股自己出事的跌停,不要接刀;要等紅K,而且彈幅也只有系統性那種的五分之一。**

🚨 **另一個反直覺**:**爆量跌停(恐慌賣壓最大)後續最差**(+0.53、前後半不同向),
**量縮跌停最好**(+2.84,六關全過)。⛔ 別用「爆量代表洗乾淨」那套說法。

⚠️ **漲停這條要跟 V72.0.1 分清楚**:這裡測的是漲停後 10 日(+1.72 但去最好年只剩 +0.08 ❌);
V72.0.1 測的是**次日**動能(+1.54%,只有次日有效、3 日轉負)—— 兩個不衝突,是不同天期。

⛔ **消息面仍然無法回測**(`stock_news.json` 只有當前快照)——
但「跌停」這個**事件本身**不需要知道原因就測得動,而分條件(大盤有沒有跟著跌)
正好把「個股利空 vs 系統性」分開了。⭐ 這是「拿不到 A 就找 A 的可觀測代理」的實例。

### 📐 V74.3.7~V74.3.9 泡泡圖版面 + 個股層級:**版面可以照抄,軸不行**
使用者:「版面請參考專業設計」(附別家 App 截圖)→「題材細到個股,用一樣的邏輯,
還有它的股價高低,這樣有用嗎?有沒有我沒想到的還是說錯的」。

#### 🚨 V74.3.7 舊版 **97% 的泡泡黏在中線** —— 這是量得出來的,不是美感問題
| | 舊版 | 新版 |
|---|---|---|
| X 展開(佔畫布寬) | 14.6% | **52.5%** |
| Y 展開(佔畫布高) | 7.6% | **58.2%** |
| **黏在中線 ±5% 的泡泡** | **97%** | **19%** |
| 軸刻度標籤 | 0 | 15 |

⛔ **兩個軸的病不同,修法也刻意不同**:
① **Y(資金流)必須用對數** —— |近5日三大合計| 中位只有 **10.3 億**、最大 **2801 億**
   → 線性下中位數只佔 **0.4%** 的高度。⭐ 別家 App 的軸標籤(+100億/+20億/+5億/0/−5億)
   就是對數間距,那不是巧合。
② **X(相對強弱)尺標用全期 P95,⛔ 不用最大值** —— 全期最大 |r20| 38.5%,
   但平常那天只有 −11.4 ~ +2.1 → 用最大值只用到中間三成。⛔ 仍是**全期固定**的尺
   (改成每天各自縮放的話動畫是假的)。
⭐ 加軸刻度線+標籤:⛔ 只有兩條軸線的話,泡泡的位置根本不可解讀。
⭐ 四象限計數卡:⛔ **刻意不抄**別家的「漲潮/輪動/觀望/退潮」—— 那是用資金流**加速度**分的,
   本站實測加速度在各窗口 −0.88 ~ +0.20pp、5~10 日窗口明顯為負 = 沒有預測力。

#### 🧬 V74.3.9 個股層級:「用一樣的邏輯」**有一半要修正**
| 使用者說的 | 判定 |
|---|---|
| 「用一樣的邏輯」(照抄板塊版兩軸) | 🚨 **一半錯**。Y 軸(法人資金流)在個股層級**實測反向**:外資當日買超佔量比 ≥20% → **0.64x**(比隨便挑一天還低,`limitup_probe`);分點籌碼當天的量買賣兩端同號(`chips_deep_probe`)|
| 「還有它的股價高低」 | ✅ **對,而且是全站最強的發現** —— 但方向要講清楚:實測**高位階好**(≥75 → +1.76pp)、低位階差(−0.63pp),⛔ 不是「便宜就買」|

⭐ **正解:版面照抄,兩個軸都換成個股層級實測有效的**
X = `pos252` 一年位階 ・ Y = `amp20` 20 日振幅(screener 兩欄覆蓋率都是 100%)
→ 右上角 = 🧬「高位階+高波動」= 36 個月組合回測 **+289.6 萬**(不挑只有 126.1 萬、輸 0050)。
📊 真實資料一驗就看得出鑑別力:**記憶體(近20日 +9.2%)命中 4/6 ・矽晶圓(−23.6%)命中 0/4**。
⛔ 三條寫在圖上:① 選股條件**不是買進訊號**(回測還配尾盤進場/破5MA出場/每天2檔)
② 波動用振幅**代理**、門檻 3.2% 是全市場 P60 ③ **把 0.64x 寫在卡上** ——
⛔ 否則下一個人(包括我自己)會覺得「加個資金流軸更完整」又改回去。

⛔ **同時判定不做的**:題材內部資金流排名(同 0.64x)、個股層級加速度(板塊已測無效)、
「題材內誰最便宜」排行(那等於把實測最差的低位階端做成推薦榜)。

#### 🧪 測試自己踩的三個坑(都寫進註解了)
① **測資規模跟真實不同 = 那條沒驗到**(陷阱 #40 又兩次):測資只有 20 個 r20 值 →
   **P95 退化成最大值**;測資 cols 只有 11 欄而真實 screener 有 **80 欄**(amp20/amt 不存在)。
② ⏱️ **有 CSS transition 時「改完立刻量」會拿到舊座標** —— 泡泡 0.42s 動畫,
   兩種尺標量出來一模一樣 317px、看起來像「這個改動沒用」→ 要等 550ms。
③ ⭐ X 尺標那條改用**對照組測法**(比較兩種尺標下的展開度),⛔ 不用絕對門檻 ——
   絕對門檻會隨測資規模浮動,對照組不會。

### 🎯 V74.3.5 題材板塊輪動(THEMES)—— 官方 33 產業太粗,市場實際在炒的是題材
使用者:「目前這種板塊沒什麼用,應該分矽光子 CPO、散熱模組/液冷等等多種板塊,
裡面再細分比如記憶體裡面的南亞科、群聯等等的資金流動」。**他是對的** ——
電子零組件 104 檔把 PCB/連接器/散熱/被動元件全混在一起,看不出誰在動。

**⛔ 先排除的路:megatime `concept_stocks.json` 不能用** —— 實測 231 個群組裡
**沒有矽光子/CPO、沒有散熱液冷、沒有記憶體**,還留著元宇宙/五倍券/iPad mini
(正是「寫死的對照表沒更新機制就會過期」那條教訓的現行犯)。

**架構(⛔ 別改回去)**:
- **題材表全 App 只有一份**:`pro.html` 的 `PRO.THEMES`(17 題材 × 88 檔,人工 seed,
  以 AI 鏈成員為底 + 補充檔逐一驗過 K 線存在)。更新方式 = 使用者叫 Claude 改 seed。
- **miner 是讀者不是第二份**:`miner._themes_from_pro()` 用 regex 讀 pro.html 那段
  → ⛔ 改 THEMES 的行格式要同步改 parser;`scripts/test_themes.py` 釘住
  (≥12 題材/≥60 檔、regex 零漏抓、成員都有 K 線檔,已注入驗證)。
  解析失敗 → **themes 鍵整個不寫** + 印原因(⛔ 不可寫空的 —— 前端要分得出「還沒產出」)。
- `build_sector_rotation()` 官方產業與題材**同一趟掃描、同一支 `_series`**(⛔ 不複製窗口邏輯);
  題材 `MIN_MEMB_TH=3`(機殼只有 3 檔)、days 只由官方產業決定(⛔ 題材組數少,讓它進
  MIN_IND 門檻會把所有日子刪光)。改完**官方產業 32 組輸出逐位元組零迴歸**(有比對過)。
- 前端 `_rotMode`('ind'/'th')+ `_rotSet()` 統一取分組,quadrant/名次條/明細/誰在買全部共用。

**⛔ 三條誠實限制(寫在卡上,測試 ㉖d/㉖f 釘死)**:
① 題材名單是**人工挑的、因為熱才被挑進來** → 成員有後見之明,⛔ 不能拿它的歷史回測說嘴;
② 「20 日動能 +1.44pp」只在**官方 33 產業**上驗過,⛔ 不可套用到題材版(verdict 第三行要換句);
③ 一檔可屬多題材(台達電=電源也=液冷)→ 各題材金額**會重複計**,⛔ 不可加總。
⭐ 順手加「**買超寬度**」:題材明細顯示「外資5日買超 X/N 檔」—— 分得出「整條都在買」vs「只買龍頭」。

### 🚪 V74.3.5 出場矩陣 36 個月重測(9 種)—— 時間停損全滅,⛔ 預設不改
| 出場 | 累積損益 | 回撤 | 損益/回撤 |
|---|---|---|---|
| ① **ma5/20(現行)** | **+2,927,569** | −24.50% | 119k |
| ⑤ ma5/40 | +2,926,593 | −22.10% | 132k |
| ③ ma20/40 | +2,848,072 | −23.25% | 122k |
| ④ **移動停利 8%** | +2,516,580 | **−17.70%** | **142k** |
| ② ma10/20 | +1,742,352 | −28.76% | 61k |
| ⑧ ma20+10天沒漲3% | +2,743,926 | −26.11% | 105k |
| ⑨ ma20+7天沒漲 | +2,642,845 | −26.67% | 99k |
⭐ 三個結論:① **時間停損 4 種全滅** —— 疊在 ma5 上**輪不到**(1300 筆只觸發 0~3 筆,
沒漲的早被 5 日線砍了);疊在 ma20 上有觸發但**更差**(又一次混用輸單獨用)。
② **trail8 風險調整後最好,但舊 13 個月窗口它是墊底** —— 窗口拉長 3 倍把排名翻過來
(V73.2.9 的重演:窗口不夠長的結論不可信)。它總獲利少 41 萬 = **取捨不是變強** → ⛔ 不改預設。
③ 最長持有 20→40 天**一律不變差**(①→⑤ 回撤 −24.5→−22.1、賺一樣)。
🚨 **探針自己的 bug**:`tmP=0` 寫 `peak < entry` 而 peak 從 entry 起算 → **永遠 false**,
輸出跟基準一字不差 = 看起來像「沒差別」其實是「沒生效」→ 修 `<=` + 空過守門
(印出實際觸發筆數,0 筆直接說「沒生效」)。⭐ 任何濾網/變體都該有這條守門。

### 🚨🚨 V74.3.1 「本機跑得起來」是最危險的一種綠燈 —— chips_deep 還原在雲端**一聲不吭回 0 天**
承 V74.0.7(hist 每輪只存今天那一筆)。修完之後 hist 中位**仍然是 2**,連修兩版都沒動。

⭐⭐ **真因是用「產物的形狀」診斷出來的,⛔ 不是再讀一次程式碼**:
```
天數分布:2 天 → 1,319 檔(最多) ・1 天 → 669 檔 ・4 天 → 274 檔
```
**「剛好 2 天」= 上一輪存的 1 天 + 這一輪存的 1 天** → 歷史天**從來沒被還原進來過**。
⛔ 如果只看「中位 2」會以為是「抓得少」,看到**分布擠在 1、2** 才知道是「還原這件事整個沒發生」。

🚨 **兩層原因,兩層都不會報錯**:
① `git fetch --filter=blob:none` 拿到的是 **partial clone 的樹但沒有 blob** →
   `git archive` 在雲端取不到內容。⭐ **我本機是完整 clone,所以本機永遠測得過** ——
   這正是「本機跑得起來」最危險的地方。
② `subprocess.run(..., capture_output=True)` **沒有檢查 `returncode`** →
   失敗被吞掉、還原 0 天、log 一行都沒有。

⭐ **修法三件**:⛔ 拿掉 `--filter=blob:none`;改成**逐檔 `git show`**(⛔ 不用 `git archive`,
一個路徑不存在會讓整包失敗 —— 同一個坑我在監控腳本上也踩過一次);
**每一步都檢查 rc 並印出 stderr 前 160 字**,收尾印
「分支上 N 天 ・這輪要 M 天 ・取得 K 天」——⭐ 沒有那三個數字,下一個人還是只能猜。

⚠️ **測試原本在釘壞掉的那個實作**(⑥c 要求出現 `--filter=blob:none`)→ 反過來禁止它。
⚠️ ⑥e 第一版只驗「原始碼裡有沒有 `returncode != 0`」→ 把 fetch 那個檢查拿掉之後,
   ls-tree 那個還在,**注入缺陷照樣綠** → 改成要求 **≥2 處**。⭐ 這個錯只有靠注入才抓得到。

⭐⭐ **三條通用鐵則**:
① **`capture_output=True` 而不看 `returncode` = 主動把錯誤丟掉**,而它會表現成「功能安靜地沒作用」。
② **「本機測得過」對任何跟 git / 網路 / 檔案系統有關的事都不算數** ——
   雲端的 clone 深度、blob 有無、權限都跟本機不同。
③ ⭐ **修不好時先看「產物長什麼形狀」**,那比再讀十遍程式碼快得多(同 V74.2.2 靠 job log 那一行破案)。

### 💧 V74.3.0 板塊輪動改版:借別人的**形式**,⛔ 別借他的**軸**
使用者:「你做的板塊輪動我覺得不好看,他是一頁式的,誰在買是不是要跟動畫做在一起…
上面說明處文字在跳動,下面動畫也會因介面影響,在那上上下下,不好查看」+ 附上別的 App 截圖問「有沒有參考價值」。

**🚨 那張截圖的兩個軸,實測全部不成立(⛔ 別照抄)**
`sector_rotation_probe.mjs` 補測它用的兩個維度:
| 它的軸 | 實測(前3−後3,未來 20 日) |
|---|---|
| X:**成交額佔比的變化**(= 錢在板塊間搬家) | **+0.17pp**,20/60 日窗口**全負** ❌ |
| Y:**加速度**(近期動能 − 前期動能) | 最好一格 +0.4pp 上下,前後半不同向 ❌ |
| ⭐ 本站採用的 **20 日報酬動能** | **+1.44pp**,六關全過 ✅ |
⭐⭐ **所以:版面照抄(四象限泡泡好看又直覺),但兩個軸換成實測有效的** ——
X = 20 日報酬動能(⛔ 不是資金佔比變化)、Y = 勾選的法人淨流入(⛔ 不是加速度)。
⛔ 卡上要寫明「份量完全不同」「Y 軸只是描述」,否則使用者會以為兩軸一樣可信。

**🐛 「上上下下」是真的版面缺陷,⛔ 不是他嫌棄而已**:
結論框(`#rotVerdict`)文字每一拍都在變 → 高度跟著變 → **把下面的圖表推上推下**。
→ `.rotverdict{min-height:52px}` **用 CSS 釘死**(⛔ 不可只靠內容長度自然撐開),
並把 DOM 順序改成 控制列 → 資金流勾選 → 結論 → 圖 → 清單 → 明細(⭐ 會變高的東西一律放在圖**上面**)。
⭐ 通用:**任何逐格播放的動畫,旁邊的文字框都要先釘最小高度** —— 否則畫面必定跳。

**📱 V74.3.2 手機長版 + 速度 + 板塊內個股**(使用者:「要做長版才看得清楚」「速度可以再調整」「板塊裡面再細分」)
畫布 340×240 → **340×460**(直向);速度 0.25/0.5/1/2 倍循環,**播放中改速度要直接接上**(⛔ 不可要求重按)。
點板塊 chip 展開明細:當日外資 / 近5日 / 近20日累計 / **資金停留**(連續流入或流出 N 天) / 近20日漲跌 + 成分股表。
⛔ **一條誠實限制必須留在卡上**:上半五個數字**會跟著時間軸走**,下面的個股表**只有最新一天的快照**
(個股逐日法人流向沒有存歷史)→ 而且要明寫「你現在停在 MM/DD,個股表顯示的仍是最新交易日」。
⛔ 不可假裝拉回過去看得到。測試 `test_prohtml.mjs` ㉒~㉕i,6 種注入缺陷驗過。

### 🪜 V74.2.9 驗**自己**寫的功能:AI 五級「資金主戰場」沒有預測力,順手抓到小樣本假象
`pro.html` 的 `_frontLevel()` 標「🎯主戰場 / ⏳落後 / 🌱太早」,但那是**人工框架**、從沒驗證過。
`scripts/ailevel_probe.mjs` 用 playwright **讀 pro.html 自己的 `PRO.CHAIN`**
(⛔ 不在探針裡複製第二份名單),對照組 = **名單內部其他層**(⛔ 不是全市場 —— 那量到的是「AI 概念股」不是「哪一層」)。

❌ **結論:哪一層領先跟後續報酬沒有關係** —— 各層邊際都在雜訊內,前後半不同向。
→ ⛔ 文案維持「這是人工框架、沒有實測過預測力」,**不可改口說有用**。

🚨 **但順手抓到一個真 bug**:`_frontLevel()` 的成員數門檻寫 **5** →
**L5 只有 8 檔卻常常被判成「最強」**(42~47% 的日子),純粹因為樣本小、中位數容易跑到極端。
→ 門檻 5 → **10**。⭐ 通用:**任何「取各組中位數再比大小」的排名,組員太少的組必須排除** ——
它不會報錯,只會安靜地一直贏(同陷阱 #27「1÷1 = 100%」的變形)。

### 👥 V74.2.7 三大法人 + 散戶疊加:「誰在追誰買」實測 —— 沒有誰固定跟誰,但「外資有沒有跟」很有差
使用者:「我要的是三大加上散戶,用打勾方式各別重疊顯示,這樣可否判斷跟單還是誰在追誰買?」

#### 🚨🚨 做之前先擋掉一個一定會踩的陷阱:**散戶 ⛔ 不可以用「總量 − 三大法人」算**
每一股都有買方與賣方 → **非三大法人的淨額必然等於三大法人淨額的相反數**。
照這樣畫,散戶那條線會是三大法人的**完美鏡像**,看起來超有說服力(「法人買、散戶賣!」),
但它是**恆等式、零資訊**;而且那個「非三大」裡還混著主力分點、公司派、ETF、造市商,根本不是散戶。
→ ⭐ 本專案的「散戶」一律用**融資餘額變化**(真實獨立資料,散戶槓桿代理)。
⚠️ `margin_balance` 是**張**,要 ×1000 才跟 `volume`(股)同單位。

#### 📊 `scripts/inst_leadlag_probe.mjs`(2,575 檔 × 3 年,四條流都換成「佔當日成交量 %」)
**① 誰領先誰 → ⛔ 量不出來**
| lag | 外資→投信 | 投信→外資 | 外資→融資 | 融資→外資 |
|---|---|---|---|---|
| 0(同一天) | −0.056 | −0.056 | **−0.129** | **−0.129** |
| 1 | −0.010 | −0.020 | +0.000 | −0.004 |
| 2~5 | ≈0 | ≈0 | ≈0 | ≈0 |
⭐ **隔 1~5 天的相關全部 ≈ 0(|r| ≤ 0.02),六組配對的不對稱度全部「分不出來」**
→ ⛔ 「外資領先投信」這種說法**量不出來**,不可寫進 App。
⭐ 唯一有東西的是**同期**:**外資 ↔ 融資 −0.129**(外資買的時候融資減)
= 「散戶跟法人對做」是真的,⛔ 但那是同期不是預測(評估紀錄⑧ 的老教訓)。

**② 「隔天多一個買家」有沒有用 → 有,但⭐⭐ 一定要跟「自己續買」比**
🚨 對照組若只有「B 沒跟」,量到的是「**隔天還有買盤**」不是「**跟單**」。
→ 加一條 `a === b`(A 大買後 **A 自己**隔天又大買)當決定性對照:

| A 大買 → 隔天 | 跟了 | 沒跟 | 差 | 對照:A 自己續買 | **真正的加成** |
|---|---|---|---|---|---|
| 投信 → **外資**跟 | +2.38 | +0.33 | **+2.05pp** | **−0.07pp** | **+2.12** ⭐⭐ |
| 自營 → **外資**跟 | +1.36 | −0.11 | +1.47pp | +0.73pp | **+0.74** ⭐ |
| 融資增 → **投信**跟 | +1.53 | +0.15 | +1.38pp | +0.77pp | **+0.61** ⭐ |
| 融資增 → 外資跟 | +1.32 | +0.07 | +1.25pp | +0.77pp | +0.48 |
| 外資 → 投信跟 | +1.25 | +0.08 | +1.16pp | **+1.08pp** | **+0.08 ≈ 沒有** |
| 外資 → 自營跟 | +0.65 | +0.05 | +0.60pp | +1.08pp | **−0.48 ⛔ 比自己續買還差** |
(進場=隔天開盤・排除開盤鎖死・扣同期加權・同檔同組 20 日去重・對照組 167 萬個股·日;**過成本線的每一組逐年同向**)

⭐⭐ **一句話:重點不是「誰先買」,是「外資有沒有在隔天出現」。**
・投信/自營/融資 買了之後**外資跟進** → 加成最大
・**外資買了之後別人跟 → 幾乎沒有加成**(外資自己續買就一樣好)
・🚨 **投信自己連買兩天完全沒用(−0.07pp)** —— 這條最反直覺

#### 📍 落地(V74.2.7,`pro.html` 板塊輪動 → 「👥 誰在買」,index.html 一行未改)
`miner.build_sector_rotation()` 的 `fi5` 改成 **`flow: {f,t,dl,mg}` 每日淨額(億元)**
(32 產業 × 120 日 × 4 條,44KB → **109KB**);前端四個打勾疊加、可各別開關。
⛔ **四條不可改掉的設計**(測試 `test_prohtml.mjs` ㉓~㉓h,6 種注入缺陷驗過):
① **排序依「勾起來的那幾條加總」**,⛔ 不可寫死用外資(勾了誰就以誰為準)。
② **至少要留一個勾** —— 全部關掉會變空表。
③ **尺標用所有勾選序列的最大絕對值**,⛔ 每列各自縮放的話長度不可比。
④ 🚨 **卡上必須同時寫「沒有誰固定跟誰」與「外資買了之後沒加成」** ——
   ⛔ 不可只講對結論有利的那一半(測試 ㉓f/㉓h 釘住)。

### 💧 V74.2.5 板塊輪動:「要看幾天」是實測出來的,而且**最直覺的做法完全沒有用**
使用者:「做一個錢流動到哪裡的板塊輪動,還可以做個動畫,**要幾天才有價值**,請深入想一下」。
⭐ 「幾天」正是本專案最容易憑空訂門檻的地方(摩卡「跳空 2~4%」、Gemini「投量比 >10%」、
權證小哥「地板股 100 檔」全部是隨口訂的)→ `scripts/sector_rotation_probe.mjs` 把
**1/3/5/10/20/60 日全部測一遍**,四種「錢流」定義各測一次。

**方法**:1,087 檔上市股 × 33 產業 × 775 個交易日(2023-06 ~ 2026-08)。
每天把產業依該指標排名 → 取前 3 / 後 3 → 看它們**未來** 5/10/20 日的成分股中位報酬,扣同期加權。
⭐⭐ **主判準是「前 3 減後 3」** —— ⛔ 單看前 3 會被大盤方向帶著跑。
對照組 = 當天全部產業的平均(⛔ 不是 0)。

#### 📊 ①「價格動能」是唯一過關的,而且「幾天」有明確答案
| 窗口 | 1日 | 3日 | 5日 | 10日 | **20日** | 60日 |
|---|---|---|---|---|---|---|
| 前3−後3(未來 20 日) | +0.40 | +0.79 ✅ | +0.81 ✅ | +1.10 ✅ | **+1.44** ✅ | +2.03 ✅ |
| 前3−後3(未來 10 日) | +0.23 | +0.36 | +0.33 | +0.62 ✅ | +0.78 ✅ | +1.06 ✅ |
| 前3−後3(未來 5 日) | +0.10 | +0.00 | +0.06 | +0.30 | +0.39 | +0.48 |
⭐ **雙向單調**(窗口越長越強、看得越遠越強),⛔ 不是單點異常。
→ **1~5 天的窗口吃不掉來回成本 0.44%;10 天以上才過關。**
📍 App 用 **20 日**(+1.44pp・前半 +1.28 / 後半 +1.58・逐年 +0.9/+1.4/+1.2/+2.2・去最好年 +1.27)。
⚠️ 60 日更強(+2.03)但那已經等於「買過去一季最強的板塊」,而且 2026 衰退到 +1.1。

#### 🚨🚨 另外三種「錢流」全部不成立 —— 而最直覺的那個最糟
| 定義 | 最好的一格 | 判定 |
|---|---|---|
| ② 外資淨流入金額 | +0.83pp | ❌ **去最好年只剩 +0.40**、20 日窗口前後半**不同向**;而且**前 3 名相對全產業平均是負的**(−0.11 ~ −0.30)→ 價差全靠後 3 名差 |
| ③ 外資買超佔成交額比 | +0.23pp | ❌ ±0.2pp 內,多數格子前後半不同向 |
| ④ **成交額佔比的變化** | +0.17pp | ❌ **≈0 甚至是負的**(20/60 日窗口全負) |
⛔⛔ **④ 正是「錢在板塊間搬家」** —— 也就是**最好看、最多人想做成箭頭動畫**的那個。
**實測完全沒有預測力** → ⛔ **不做那種動畫**,而且要把原因寫在卡上,
否則下一個人看到「板塊輪動」四個字就會再做一次。

⭐ **邊際是不對稱的**:20 日窗口那格,前 3 名相對全產業平均只有 **+0.63pp**,
後 3 名卻是 **−0.80pp** → **避開最弱的板塊比追最強的更有價值**(文案要寫)。

#### 📍 落地(V74.2.5,全部在 `pro.html`,index.html 一行未改)
- `miner.build_sector_rotation()` → `data/sector_rot.json`(**零 API**,只讀本地 `data/*.json`;
  32 產業 × 120 個交易日 × {20日報酬中位, 外資5日淨流入億元},實測 **44KB**)。
  ⛔ 與 `build_breadth_history()` **各自獨立呼叫** —— 綁同一個 try/if 的話一個失敗會拖累另一個
  (V72.2.1 `market_stats` 的 pb 拖垮 margin 就是這樣,而且全綠零錯誤訊息)。
- `pro.html` 第三個分頁「💧 板塊輪動」:**排名賽跑動畫**(演的是**排名變化**,⛔ 不是資金流向箭頭)
  + 播放/拖時間軸 + 🎯前3/⛔後3 + 完整實測數字。
- 「💰 外資的錢往哪流」**只做描述**,⛔ 不排名不下多空;
  ⭐ 而且會**自動抓出當天「外資買最多、股價卻最弱」的反例** —— 上線當天就有現成的:
  **半導體外資 5 日 +871.9 億(全市場最多),近 20 日 −7.8%(倒數第二)**。
  比講道理有說服力得多。

⛔ **四條不可改掉的設計**(測試 `test_prohtml.mjs` ㉒~㉒l 釘住,5 種注入缺陷驗過):
① **尺標用全期最大絕對值,⛔ 不可每天各自縮放** —— 尺一直在變的話「動起來」是假的。
② **切走分頁要 `rotStop()`** —— ⛔ 不可留一個背景 timer 一直跑。
③ **全空的產業整條不顯示**(⛔ 不留空殼);檔案不存在時要說「還沒產出」⛔ 不可靜默空白(陷阱 #22)。
④ **swipe 改成索引前後移動** —— ⛔ 不可再寫死 `val↔chain`(加第三頁一定會漏,陷阱 #37)。

⚠️ 誠實限制(寫在卡上):`industry_map.json` 只涵蓋**上市**(1,087 檔)→ 這是「上市板塊輪動」,
⛔ 不是全市場;回測窗口整段偏多頭;⛔ 本頁不給任何買賣價位。

### 🕸️ 外部參考資料的評估紀錄⑮:Gemini 籌碼策略對話(2026-08-31 使用者上傳 .docx)⛔ 一行功能都沒改
230 段 / 18,091 字。⭐ **先做對照,再決定讀什麼** —— 它列的東西本專案這一輪剛好幾乎都測過了。

**⛔ 已經測過、而且有些**方向相反**(⛔ 別照它做)**
| 它主張 | 本站實測 |
|---|---|
| 「主力淨買超佔量比高 → 籌碼集中 → 看多」 | ❌ `chips_deep_probe`:前5大買超佔量最高 10% 的 20 日 **−0.60pp**,**買賣兩端都是負的** = 活躍度不是方向 |
| ⭐「計算主力淨買超時**自動扣除隔日沖分點**的買超量」 | 🚨 **方向相反**。`broker_cross_probe` A 組:大漲日**隔日沖佔比高**的 10/20 日 **+1.39/+2.11pp** —— 隔日沖圈選股本身就是動能標記,扣掉等於把資訊丟掉。`broker_skill_probe` E 組另測「避開高翻臉率券商的買」隔日差 **0.00pp** |
| 「地緣券商 = 波段主力」 | ❌ `broker_skill_probe` C 組:**+0.01pp**(n=110,100),排除雙北 −0.07pp,前後半都不同向 |
| 「連續小量買進的分點」 | ⚠️ 只有配上「**價格已經動了**」才成立(C 組 +0.85/+1.36pp,已落地 `_chipRunBuy`);單看連買 +0.14pp < 成本 |
| 「籌碼集中度 >+2.0σ 才算異常」 | ➖ 門檻改成 σ 不會改變結論(每一桶、每一年都輸對照組) |
| 「千張大戶 × 股東人數 四象限」 | ❌ 評估紀錄(V72.5.2):偏多與偏空兩格 60 日只差 **0.12pp**,交互作用全負 |
| 「週頻籌碼選池 → 盤中觸發」兩階段 | ✅ 觀念本站已有(`playbook_scan` 每晚選池 → `_eodTriggerSweep` 盤中觸發) |
| 「嚴禁未來事件偏誤:分點收盤後才公布」 | ✅ 本站所有籌碼回測進場價一律用**隔天開盤**,早就照做 |

**⛔ 沒有資料源(⛔ 別再評估一次)**
- **MQI(融資買進**筆數**÷ 融資餘額張數)** —— 台灣**不公布融資買進筆數**,TWSE `MI_MARGN` 只有張數。⛔ 分子拿不到。
- **借券賣出餘額 / Unused SBL** —— FinMind 借券是付費層資料集,而且**本站從來沒存過歷史** → 就算現在開始抓也要等一年才驗得動。
- **鉅額交易溢價錨定** —— `blocktrade.json` 實測**只有當前快照**(`{n, m, last}`,7.8 KB),沒有歷史 → ⛔ 現在測不了。這是「現在不存以後永遠沒有」那一類,想做要先開始存。

#### 🕸️ 唯一「沒測過 + 資料剛好夠」的一條:分點同盟集團 → **實測不成立**
它的主張:「主力為避免被追蹤把大單拆到多個分點 → 算分點兩兩 cosine similarity,>0.85 視為同一個影子集團;
同盟內 ≥3 個分點同天大買 = 高信賴度主力建倉」。`scripts/broker_ally_probe.mjs`(467 天深歷史 × 前 120 家券商 = 7,140 對)。

⭐⭐ **對照組是這題的成敗關鍵,而文件自己沒講**:事件是「**3 家**券商同天大買」。
對照組若拿「單一券商大買」,量到的是「**很多人一起買**」⛔ 不是「**同盟**」。
→ 對照組必須是「同樣 ≥3 家同天大買,但**彼此不是同盟**」。

| | 相似度算法 | 結果 |
|---|---|---|
| 第一版 | 原始 cosine | ❌ 前 2 名是 **元大↔富邦 0.960**(78,057 次共同出現)= **純規模效應**;sim≥0.7 只有 +0.65pp 且前後半不同向 |
| 第二版 | ⭐ 先減掉**每個(股·日)的共同成分**再算 | 三個門檻全部「看起來」通過(見下) |

**⚠️ 第二版(正向:前半學同盟、後半驗收)—— 看起來非常強**
| 門檻 | n | 10日 | 20日 | 勝率(對照 33.0%) | 驗收段前/後半 | 格內對照 |
|---|---|---|---|---|---|---|
| sim ≥ 0.85 | 254 | **+1.52pp** | +1.90 | 42.5% | +0.68 / +2.51 | **+1.18pp** |
| sim ≥ 0.7 | 732 | +1.35pp | +2.05 | 40.3% | +1.10 / +1.66 | **+1.45pp** |
| sim ≥ 0.5 | 4,872 | +1.09pp | +2.06 | 38.5% | +0.91 / +1.19 | +0.56pp |
單調(門檻越嚴邊際越大)、全部高於成本 0.44pp、前後半同向、**連「位階×波動×成交金額」格內對照都撐住**。

**🚨🚨 但反向驗證(後半學同盟、前半驗收)整個翻掉**
| 門檻 | n | 10日 | 20日 | 格內 |
|---|---|---|---|---|
| sim ≥ 0.85 | 402 | **−0.14pp** | −0.62 | +0.05 |
| sim ≥ 0.7 | 16,278 | **−0.35pp** | −0.38 | −0.19 |
| sim ≥ 0.5 | 17,284 | −0.34pp | −0.39 | −0.19 |

⭐⭐⭐ **而最決定性的證據不是報酬,是「同盟本身穩不穩」**:
```
sim ≥ 0.85:前半學到 5 對 ・後半學到 30 對 ・兩段都出現 0 對 → Jaccard 0.0%
sim ≥ 0.7 :前半 8 對 ・後半 56 對 ・兩段都出現 0 對 → Jaccard 0.0%
sim ≥ 0.5 :前半 12 對 ・後半 83 對 ・兩段都出現 0 對 → Jaccard 0.0%
```
前半段最像的是 `第一高雄↔群益中壢`、`元大↔富邦`;後半段變成 `華南竹北↔中信託文`、`元大大天↔永豐新竹`
—— **一對都沒重疊**。真的影子集團會在兩段都出現;學到完全不同的人 = **那不是結構,是被那一半資料湊出來的**。
⛔ **不做。**

⭐⭐ **三條可以帶走的通則(比這條策略本身重要)**:
① **相似度天然會把「規模」算進去** —— 兩家大券商在每一檔都有量,cosine 自然接近 1。
   要問「行為像不像」,必須**先減掉每個(股·日)的共同成分**,⛔ 不可直接算原始向量。
② ⭐⭐ **「學到的東西本身穩不穩」比「報酬好不好」更快、更決定性。**
   這次正向那組六道關卡 + 格內對照全過,看起來是本輪最強的發現;
   但只要問一句「換一半資料學,學到的是不是同一批人」,**Jaccard 0% 當場結案**。
   ⛔ 以後任何「先從資料學出一組成員/群集/名單,再拿它去預測」的做法,
   **一律要先報這個重疊率**,再談報酬 —— 報酬會騙人,成員名單不會。
③ **雙向驗證不是形式** —— V72.9.2「排點估計值必挑到僥倖股」、V74.0.5「元大永寧訓練段第 1 名 → 驗收段 −2.17%」
   都是同一件事的不同版本。這次是**第三次**同一個陷阱換皮出現。

#### 👩 順帶解鎖:投量比終於測得動了 → 但**六關 0 過**
文件另一條:「投信買超佔比(投信單日淨買 ÷ 當日成交量)**>10%** 且持股率 0.5~3% = 低檔初升期」。
⭐ V71.9.5 做這張卡時 `trust_net` 只回溯到 2026/05 → 當時**刻意只做單位換算、不下方向**。
2026-08-31 實測 **555 檔 ≥100 個非零日** → 現在驗得動了(⭐ 這是「等資料」等到的,不是新想法)。
`scripts/trustvol_probe.mjs`:**2,529 檔 / 對照組 1,194,979 個(股·日) / 事件 93,555 筆 / 2024-04-18 ~ 2026-07-21**,
進場 = 隔天開盤、扣同期加權、排除開盤鎖死、同檔同桶 20 日去重。**對照組 10 日 −1.15% ・勝率 37.5%**。

| 投量比 | n | 10日 | 20日 | 勝率 | 前半 / 後半 | 逐年(24/25/26) | 格內 | 疊在🧬之上 |
|---|---|---|---|---|---|---|---|---|
| 投信**賣**超 | 10,919 | **+0.21** | +0.59 | 39.5% | −0.15 / +0.58 | −0.3 / +0.1 / +0.9 | +0.11 | +0.47 |
| 沒買沒賣 ±0.1% | 58,974 | −0.06 | −0.22 | 36.7% | −0.10 / −0.02 | −0.1 / −0.1 / +0.0 | −0.05 | −0.27 |
| 買 0.1~1% | 6,493 | +0.41 | +1.08 | 41.3% | −0.05 / +0.84 | −0.3 / +0.5 / +1.1 | +0.26 | +0.23 |
| 買 1~3% | 5,333 | +0.44 | +1.24 | 41.1% | −0.02 / +0.87 | −0.1 / +0.3 / +1.3 | +0.26 | +0.23 |
| ⭐ **買 3~5%** | 3,652 | **+0.58** | **+1.71** | **41.9%** | −0.09 / +1.26 | −0.0 / +0.2 / +2.0 | +0.37 | +0.55 |
| 買 5~10% | 4,056 | +0.53 | +1.34 | 41.5% | −0.06 / +1.09 | −0.2 / +0.4 / +1.6 | +0.37 | +0.93 |
| 🚨 **買 ≥10%(文件說的)** | 4,116 | **+0.19** | +0.52 | 39.3% | −0.26 / +0.56 | −0.2 / −0.1 / +1.2 | +0.06 | +0.51 |

⭐⭐ **三個結論**:
1. 🚨 **它訂的 10% 是全部買超桶裡最弱的一格**(+0.19pp),最好的是 **3~5%**(+0.58pp)——
   **非單調** → 那條線是隨口訂的(同摩卡「跳空 2~4%」、權證小哥「地板股 100 檔」)。
2. 🚨 **投信「賣超」也是正的**(+0.21pp)→ 又一次「**兩端同號 = 活躍度不是方向**」
   (同集保隱藏大戶、融資兩端、分點集中度)。⛔ 不可做成多空。
3. 🚨 **七個桶的前半段全是負的、後半段才轉正,逐年也是 24 負 → 26 正**
   → 那個邊際**只存在 2026 這一段**,六道關卡**一關都沒過**(最好的 3~5% 扣成本後 +0.14pp,但前後半不同向)。
⛔ **`_trustVolRatioNote` 維持原樣(只做單位換算、不下方向、不計分)** ——
   ⭐ 現在它有實測數字可以寫上去了,但結論仍是「**沒有驗證出方向**」,⛔ 不可改口說有用。
⚠️ 「持股率 0.5~3%」那半 ⛔ **測不了** —— 累計持股需要**起點**,`cumsum(trust_net)` 從 2023 開始不是真持股率。

⚠️⚠️ **這支探針自己犯了兩個 CLAUDE.md 已經記過的錯**(都靠實跑輸出抓到,⛔ 不會報錯):
① 🚨 **前後半的中點用了整條日期軸**(`^TWII` 從 2021-08,個股 2023-06 + 250 根暖身)
   → **前半永遠是 NaN、那一關等於沒作用**。這是 V74.0.2 `limitup_probe` 的**同型再犯**
   → 改成從**實際樣本**推中點,並把區間印出來。
② selftest 的假雜湊寫成 `((a*2654435761 + b*40503)>>>0)/2**32` —— 固定 a、b 每 +1 只讓值增加 9.4e-6
   = **那是斜坡不是雜湊** → 事件全擠成一整段、波動率算成 0.1%。
   ⭐ 跟 V74.0.5 `broker_skill_probe` 的散兵排班是同一個錯 —— **測資自己要先驗一遍**。

### 📐 外部參考資料的評估紀錄⑭:「AI 產業成熟度系統」開發規格(2026-08-29 使用者上傳)→ V74.1.0 落地
使用者上傳一份 49 節的開發規格(要把「AI 演進五級」升級成資料驅動的成熟度與預警系統),
並提出 9 項需求。**規格本身有一半是對的、一半跟本專案鐵則直接衝突**,逐條判定如下。

**✅ 採納(而且它說對了本專案原本沒做的事)**
① §2「Level ⛔ 不得依時間固定增加」—— 完全正確,跟「憑空門檻」鐵則同源。
② §20 Leading/Coincident/Lagging + §38 供應鏈五層 + §49 Core/Infra/Enabler/Bottleneck/Frontier 分類
   —— ⭐ 這是整份規格最有價值的部分,而且**純標籤、不需要新資料源**。
③ §23/§33「不產生買賣訊號、這是研究模型不是預測器」—— 跟本專案立場一致。
④ §15 資料信心分級、§16「Why Score Changed」、§17 歷史不可覆蓋 —— 觀念正確(本專案已有同類機制)。

**⛔ 不採納(⛔ 別再接回來,理由寫下來免得下次又被說服)**
| 節 | 它要的 | 為什麼不做 |
|---|---|---|
| §3 | Level 指標(企業採用率/Agent 營收/使用量/CAPEX) | **台股與全球都沒有免費結構化來源** → 做了就是編數字 |
| §8 | `總分 = AI受惠度×20% + 成長性×20% + …` 八維加權 | 🚨 **陷阱 #38 的加強版**:八個維度都要憑空打分再憑空加權 |
| §9 | Market Expectation Gap =「產業實際進度 − 市場預期」 | **兩個數字都是編的**,相減之後看起來很精確,其實是兩個猜測 |
| §10/§11 | Next Wave Score、Forecast Level(30/90/180 天預測成熟度) | **完全無法驗證**;而且違反「預測性主張要先實測」 |
| §26/§25 | REST API + 12 張資料表 | 本專案是**靜態網站**,沒有後端 |

**🚨 規格對台股的一個實質錯誤(已修正)**:§35/§49 把「記憶體/HBM」列為 **AI Core**。
那對**全球**成立(HBM = 海力士/三星/美光),⛔ **但台廠沒有 HBM** —— 台廠是利基型 DRAM / NOR / 模組,
沒有 HBM 的定價權。標成 Core 會讓人以為台系記憶體有同等地位 → `pro.html` 標成 **B 層(Core+瓶頸)但
文案明寫「台廠做的是利基型記憶體不是 HBM」**,轉折卡也補了同一句。

**📍 V74.1.0 落地(全部在 `pro.html`,index.html 一行未改)**
| 使用者需求 | 做法 |
|---|---|
| 個股可點跳散戶救星、返回原位 | `gotoStock()` 同分頁跳 `index.html?sym=`(⛔ 不開新分頁 —— 手機會堆積、iOS PWA 留空白頁);跳前把捲動位置/分頁/篩選/估值輸入存 sessionStorage,回來時 bfcache 生效就只補捲動、整頁重載才完整還原(30 分鐘時效) |
| 手勢 | 左右滑切分頁 + 頂端下拉重新整理。⛔ **三個守門不可拿掉**:①起點在可橫向捲動容器(表格)內不攔截 ②水平位移要 **2 倍**於垂直(touchmove/touchend **兩處**都要判)③下拉只在 `scrollY<=0` 起算、拉超過 70px 才觸發。⚠️ `hardRefresh` 一定要清 `_cache`(⛔ 不清等於什麼都沒做) |
| 低/中/高基期 | ⭐ **拆成兩種且必須分開**:股價基期(`pos252`,價格在近一年的位置)vs 估值基期(PE 在自己近3年的位階)。**背離時要主動點出來**(股價高位+估值低位 = 獲利長得比股價快,⛔ 不是「貴」) |
| 目標價 | ⛔ **不叫目標價**(違反 V71.8.2 用詞限制)→ 做成「**歷史估值對照價位**」表:回到 P5/P25/中位/P75/P95 與同業中位 PE 各對應多少錢、距現價幾 %、**一張差多少元**。⛔ 表格自己那一段必須寫「這不是目標價,也不是預測」(測試釘住,⛔ 不可讓卡片別處的免責替它背書) |
| 落後產業 | `_frontLevel()` = 「最近 20 天資金打哪一層」(各層成員 `chg20` 中位最高者),每檔標 🎯主戰場/⏳落後/🌱太早。⛔ **樣本不足 5 檔不判定**;文案必須寫「不是 AI 進度預測、沒有實測過預測力」;成熟度那條 bar 要註明「人工框架、不會隨時間自己增加」 |
| Prompt 帶個股 | 新增 `buildStockPrompt(i)`:單檔版,帶入兩種基期 + 5 檔 PE 對照價位 + **AI 鏈定位(段/題材/層級/供應鏈層/風險)**,與多檔版共用同一份防幻覺 header |
| Perplexity | `_askAi()` 照 index.html `_freeAiOpen` 的做法:附今日日期前綴 + **用真實 `<a target="_blank">` 點擊**,⛔ 不可用 `window.open`(iOS PWA 會留空白 Safari 分頁) |

測試 `scripts/test_prohtml.mjs` 40 條,⭐ **5 種注入缺陷全部驗過**。
⚠️ 過程中測試自己犯兩個錯,兩個都是「測資/非同步」而不是程式:
① 灌「L3 成員都很強」時把 4585 的 null 一起蓋掉 → null 排序那條驗不到(**測資要先自己驗一遍**);
② `selLayer()` 內部的 `renderChain` 是 async,沒 await 就數 DOM → 數到舊的。
⭐ 另外兩條斷言第一版**太鬆**(注入後別處還有同樣字串 → 假通過)→ 改成「只驗它自己那一段」與「兩處都要有」。

### 🤖 外部參考資料的評估紀錄⑬:AI 產業鏈儀表板包(2026-08-29 使用者上傳 4 檔)→ V73.9.9 落地
使用者上傳 chain_growth.py / update_chain.yml / aistrategydashboardv3.tsx / ai_chain_data.json
(AI 演進五級 × 台股 64 檔受惠股 + 每週 FinMind/LLM 成長引擎),要「當作未來股票成長的參考、介面用散戶救星風格」。

**✅ 內容查證(逐檔對過 gh-pages 真資料)**:64 檔代號全部真實存在(K 線檔全有)、名稱正確、
segment/levels 框架合理(對應 OpenAI 五級 AGI 框架)。⭐ **真價值:其中 17 檔上櫃股
`industry_map.json` 完全沒收錄**(證交所 33 大類只涵蓋上市)→ 這份名單正好補了「個股沒有歸類到的產業」。
補了 3 檔它漏的:**4585 達明**(協作機器人本尊 —— 它只列母公司 6188 廣明,但達明 2025 已分拆上市)、
**3035 智原**(ASIC 設計服務第三家)、**8210 勤誠**(AI 伺服器機殼)→ 共 67 檔。

**⛔ 四個不採用(⛔ 別再接回來)**:
① **動能分數(YoY×60% + 法人×40%)與熱度門檻(35/50/65)** —— 權重門檻全是憑空訂的(陷阱 #38 同型)
   → 前端只顯示**原始數字**(近20日/外資10日/YoY,讀 `screener.json`,實測覆蓋 65/67 檔),⛔ 不混成假分數。
② **每週 FinMind 採礦引擎** —— 它要抓的 YoY/法人 App 本來就有(零採礦優先);而且 FinMind 付費層剛過期。
③ **`update_chain.yml` 每週 cron** —— 撞 GitHub 排程配額(V73.9.0:全 repo 一天只進得來 7~10 筆 schedule run);
   且改 Actions 本來就要先問。名單更新方式 = 使用者叫 Claude 改 `_AI_CHAIN` seed(跟其他人工整理內容一致)。
④ **LLM 每週自動提案新受惠股** —— 未驗證的主張不進 App(它的防幻覺三閘門設計得不錯,但價值低於維護成本)。

**📍 落地(V73.9.9,全部深色散戶救星風格)**:選股頁新 tab「🤖 AI 鏈」(`_AI_CHAIN` 靜態表嵌 index.html,
約 15KB,同 `_SIGNAL_EDGE` 做法):五級演進條(點一級=看台鏈受惠+篩名單)+ 67 檔個股地圖(段內按近20日排,
null 排最後顯 —)+ 10 個技術轉折 + 利潤池/傳導鏈 + 檢核清單(標明哪些 App 已有對應功能),全區收合防資訊爆炸;
K線頁 `_aiChainChipHtml` 一行成員 chip(⛔ 不是新卡)。免責固定:**人工整理的產業說明書,⛔ 不是買進名單、
預測力未實測、循環股別當成長股抱**。測試 `scripts/test_aichain.mjs` 18 條(3 種注入缺陷驗過)。
⚠️ 測試又踩兩個老坑:「動能分數」禁止句被自己的 ⛔ 註解擋下(**第 7 次**,驗渲染輸出不驗原始碼);
⭐ 新坑:**emoji 字元類別 regex 沒加 `u` flag 會拆成 surrogate 半碼 → 🔄 被誤判成 🔴**,以後 emoji 斷言一律加 `u`。

### 📕 外部參考資料的評估紀錄⑫:5 份教學檔(2026-08-22)—— **一行功能都沒改,但學到一課**
⚠️ 使用者明示:**這批不要寫進 App 的更新紀錄**,也**不要記作者是誰** → 只記在這裡,⛔ 不進 `_CHANGELOG`。

**先做重複比對與量化門檻掃描(⛔ 別直接開始讀,5 份 ≈ 66 頁 + 6 萬字)**:
| 份 | 內容 | 判定 |
|---|---|---|
| 2 份 | 「飆股怎麼來的」PDF 版 + 彙整版 | 🚨 **內容完全重複**,只需讀一份 |
| 3 份 | 新手教學(63 頁入門)・交易心法・股市基礎 | ⛔ **通篇沒有可量化門檻**,掃出來的「數字句」全是舉例與敘事 → 測不了 |
| 1 份 | 「飆股怎麼來的」 | ⭐ 唯一有可回測主張 |

#### 📊 `scripts/breakout_probe.mjs` 實測(2,233 檔 / 14,820 事件 / 對照組 1,679,699 個股·日)
| 他的主張 | 實測(20日 vs 對照) | 判定 |
|---|---|---|
| ⭐「**底部**(位階≤25)+ **連 2 根漲停** = 主力表態,該買」 | **−2.66pp**(n=498) | ❌ **六關全滅** |
| ⛔「**非底部**(位階≥60)連 2 漲停 = 主力成本早拉開,追進去被出貨」 | **+4.58pp**(n=4,558) | 🚨 **方向完全相反,而且六關全過** |
| ⛔「第一波沒用漲停 = 意願不強,不必切入」 | 底部強紅K −1.68pp vs 底部連2漲停 −2.66pp | ❌ 反而**沒漲停的比較好** |
| 「**連續**漲停才算數」 | 連 2 根 −2.66pp vs **只有 1 根 +1.20pp** | ❌ 「連續」**沒有加分** |
| ④「洗盤:**量縮但價不跌**」 | +2.60pp vs 爆量/破底 +0.15pp | ⚠️ **方向對**,但前後半不同向、去最好年 −0.99 → ❌ |

⭐ 前四條的方向跟本站既有結論一致(V73.2.9 追高 > 抄底、V73.8.3「等回檔」21 個有 18 個負)。

#### ⭐⭐ 這次最值得記住的是**方法論**:「六關全過」還不夠,還有兩關
「非底部連 2 漲停 +4.58pp、六關全過」看起來是很久以來最好的發現。⛔ 但它被兩道追加檢定剝到歸零:

| 關卡 | 結果 |
|---|---|
| 六道關卡(全期正・前後半同向・逐年同向・去最好年・扣成本) | ✅ +4.58pp → 扣成本 +4.14pp |
| 🚨 **A. 買得到嗎** —— 漲停鎖死時**當天收盤買不到**,改成隔天開盤買 | +4.58 → **+1.48pp**(買不到的代價 **3.1pp**) |
| 🚨 **C. 疊在現行配置(🧬 高位階+高波動)之上還有增量嗎** | **+0.46pp**,但去最好年 **−0.17**、扣成本只剩 **+0.02pp** |
| **結論** | ⛔ **不做**(重疊率 68.2% —— 大半只是把「高位階+高波動」再數一次) |

⭐⭐ **通用鐵則(比這 5 份文件本身重要)**:
① **回測用的成交價必須是「真的買得到」的價** —— 漲停/跌停鎖死那天的收盤價**不是**可成交價,
   用它回測等於前視偏誤的近親。任何「訊號當天就是漲停」的策略,都要另外跑一次「隔天開盤買」。
② **「六關全過」不是終點** —— 還要問「買得到嗎」與「疊在現有配置上有沒有增量」(V73.2.5)。
   這次三道關卡一層一層把 +4.58pp 剝到 +0.02pp。
③ 這也再次印證:**一個看起來很強的發現,越漂亮越要多查兩關**(同 V72.9.2「排點估計值必挑到僥倖股」)。

⛔ **結論:App 一行判定邏輯都沒改,版本號也沒動。** 探針留著,走完一次空頭後可重跑
(尤其「底部連 2 漲停」那格 —— 現在的窗口整段偏多頭,底部型態本來就吃虧)。

### 🚀 V73.8.3 「起漲點怎麼看」—— 答案早就測出來了,只是**沒讓使用者看到**
使用者問「起漲點要怎麼看」。⭐ 這題**不需要新的回測** —— `_SIGNAL_EDGE`(129 個訊號全市場實測)
早就答了,但那個結論**只寫在 CLAUDE.md**;App 只顯示單一訊號的分級 →
**使用者看得到每一棵樹,看不到那片森林**(陷阱 #32 的變形:功能有、洞見沒被講出來)。

📊 直接從 `_SIGNAL_EDGE` 現算(⛔ 不寫死第二份):
| | 個數 | 代表 |
|---|---|---|
| 期望值為正 | **9 / 129** | 換手量(洗籌續攻) +0.68% ・急漲過熱 +0.59% ・正乖離過大 +0.52% |
| 「等回檔再買」型 | **21 個,18 個是負的** | 費波納契回撤買點 −1.26%(22,628 次)・葛蘭碧買2 −1.33% ・多頭回檔等買點 −1.00%(22,668 次) |
| ⚠️ 例外 | 頭肩底 **+3.38%** | ⛔ **只有 147 次**(全表樣本最小),別當鐵律 |

⭐ 一句話:**追強 > 抄底** —— 跟 V73.2.9 組合回測同一個結論
(不挑「高位階+高波動」的話整套輸給買 0050)。

📍 落地:`_edgeEntrySummary()` + `_edgeEntryHelpText()` 接進**既有的** `_showEdgeHelp()`
(K線頁 K棒戰法卡「ⓘ 怎麼看」)—— ⛔ **沒有新增卡片**,只是把既有教學補完。

⛔ **五條鐵則(測試 `scripts/test_edgeentry.mjs` 15 條釘住)**:
① 數字**現算自成績表**,⛔ 不可寫死(測試會換一份假表驗它跟著變)。
② 「等回檔」與「已經在動」兩組必須**互斥** —— 第一版把「頭肩底」同時列進兩邊,自我矛盾。
③ 🚨 **例外要點名 + 附樣本數**,⛔ 不可只講對自己結論有利的那一半。
④ ⛔ 不下買賣價位(這是教學不是訊號,單一劇本原則)。
⑤ **指路的分頁名稱要真的有那顆按鈕**。

⚠️⚠️ **測試 ⑤b 第一版是「自我指涉」的**:寫成 `src.includes(分頁名)` ——
但文案本身就在 `src` 裡,亂寫一個名字也會通過(注入缺陷時實測照樣綠)。
⭐ **通用:驗「A 指到的東西真的存在」時,要在「A 自己以外的範圍」找**,
   ⛔ 否則就是拿它自己證明它自己。改成排除 `_edgeEntryHelpText` 函式本體後才抓得到。

### 🔄 V73.8.2 週轉率**第三次**實測 —— 沒有獨立的參考價值(但選股頁條件照留 + 標成績)
使用者問「高周轉率有沒有參考價值」。⚠️ **前兩次已經測過**,這次⛔ 不重測那兩組:
| 次 | 測什麼 | 結果 |
|---|---|---|
| V72.0.1 `turnover_probe.py` | 週轉率 × **昨日漲跌幅** | 單看幾乎沒有鑑別力(最好與最差桶差 **0.17pp**);「小漲小跌 + 高週轉」不成立 |
| V72.4.9 `turnover_stage_probe.py` | 週轉率 × **位階** | 「低檔高週轉=起漲」不成立;「高檔高週轉=出貨」**方向剛好相反** |
| ⭐ V73.8.2 `turnover_edge_probe.mjs` | 週轉率 **疊在現行配置之上的增量** | 見下 |

📊 **2,229 檔 / 86,749 事件 / 對照組 429,490 個股·日**(六道關卡):
| 5 日週轉率 | vs 對照(20日) | 前半 | 後半 | 疊在 🧬 高位階+高波動 之上的**增量** |
|---|---|---|---|---|
| <1%(冷門) | −0.21pp | −0.01 | −0.35 | +0.33pp |
| 1~3% | +0.86pp | −0.22 | +1.48 | +0.52pp |
| 3~8% | +1.16pp | −0.39 | +2.09 | −0.08pp |
| **8~20%** | **+1.68pp** | **−0.36** | **+2.93** | +0.51pp |
| >20%(他說「高」) | +1.22pp | −0.11 | +2.05 | +0.08pp |

⭐⭐ **三個結論**:
1. 🚨 **全市場看起來「越高越好」,但每一桶前半段都是負的、後半段才變正** →
   那個優勢**只存在於最近這一段行情**,⛔ 不是穩定規律。**六關一關都沒過。**
2. ⛔ **疊在「高位階+高波動」之上增量幾乎歸零**(−0.08 ~ +0.52pp,而來回成本 0.44%)——
   真因很單純:**「高週轉」跟「高波動」講的本來就是同一件事**(同 V73.2.5 乖離那次)。
3. ⭐ **唯一實測有效的用法是「漲停的隔一天」**(V72.0.1):中等週轉(1~3%)次日 **+1.54%**,
   **量太大(≥8%)反而衰減到 +0.78%** —— 已落地在當沖頁 `_limitUpMomentum`,⚠️ **只有次日有效**。

📍 **落地:`_scrTurnNote(conds)`** —— 選股頁的「5 日週轉率」條件與排序**照留**
(⛔ 不刪,同 `_SIGNAL_EDGE` 對 C 級的處置),但**勾了/用它排序才會跳出**這組實測。
⛔ **理由**:那個條件旁邊本來**一個實測數字都沒有** → 使用者勾了會以為是驗證過的做法。
⛔ 文案不可下操作指令、不可用紅綠(講的是「有沒有用」不是漲跌);數字一律讀 `_SCR_TURN_EDGE`。
⚠️ 分母用集保 `t`(**今天的**總股數快照)當常數 → 增資減資有偏差,但桶內外同樣受影響。
測試 `scripts/test_turnnote.mjs` 19 條。

⚠️⚠️ **這支測試第一版的 ③ 太鬆**:寫成 `/前後半段.{0,6}不同向|前半.{0,40}後半/`,
把警告句整個拿掉之後**第二個 alternative 還是配得到** → 注入缺陷時照樣綠。
⭐ **通用:「禁止/必須出現某句話」的斷言要釘那個關鍵字本身,⛔ 別用會在別處配到的寬鬆樣式**;
   而這個錯**只有靠「注入已知缺陷」才抓得到**(這次就是這樣抓到的)。

### 🎫 外部參考資料的評估紀錄⑪:《哥有籌必爆》S1+S2 再一批 40 份(2026-08-21)—— **測了 2 條,0 條成立**
使用者:「檢查有沒有有參考價值的地方,篩選出來後逐批來優化程式」。
⚠️ 這批(40 份 / 0.81 MB)= **評估紀錄⑥ 的同一個系列**(⑥ 是 57 份)。
⭐ 依鐵則先掃量化門檻再決定讀什麼,**40 份裡只有 2 條是「⑥ 沒測過 + 用既有 `data/` 測得動」的**。

#### ⛔ 掃完後確定不測的(理由寫下來免得再問一次)
融資維持率 130% / 使用率 >70%(⑥ 已評估,使用率無歷史)・週轉率一天 >20%(⑥ **已測兩次**不成立)・
券資比 >30% / 回補力道 >50%(`short_balance` 只到 2026/05,同 V71.9.2 死因)・
主力5日籌碼集中度 >5%(需**逐日**分點歷史,只有滾動快照)・可轉債市值 >120(V71.9.1 已測)・
大戶 400 張 ±3%(V71.9.0 已測)・投量比 >10%(V71.9.5 已有)・均線扣抵 / 葛蘭碧 / 光頭大紅棒 ≥5%(偵測器都在)・
權證差槓比 <0.3%(**無權證報價源**,V73.4.0 實測仍 422)・盤前試撮(無逐筆歷史)・庫藏股(無資料源)。

#### 📊 `scripts/kobo_probe.mjs` 實測(2,233 檔 / 236,262 事件 / 對照組 561,163 個股·日,六道關卡)
| 事件 | vs 對照(20日) | 前後半同向 | 逐年同向 | 去最好年 | 扣成本 0.44% | 判定 |
|---|---|---|---|---|---|---|
| 帶寬 <5%(他說「很窄」) | −0.41pp | ✅ | ❌ | −0.73 | −0.85pp | ❌ |
| 帶寬 10~20%(他說「正常」) | −0.02pp | ❌ | ❌ | −0.05 | −0.46pp | ❌ |
| **帶寬 >20%(他說「就寬」)** | **+0.42pp** | ✅ | ✅ | **+0.37** | **−0.02pp** | ❌ **卡在成本** |
| **帶寬自身最低 20%(壓縮/夾娃娃)** | **−0.89pp** | ✅ | ✅ | −1.12 | −1.33pp | ❌ **全表最差** |
| 壓縮後開始擴張 | −0.72pp | ✅ | ❌ | −0.32 | −1.16pp | ❌ |
| 站上中軌且帶寬>10% | +0.42pp | ✅ | ✅ | +0.30 | −0.02pp | ❌ 卡在成本 |
| **【B】地板(跌≥9%)+ 量≥2倍均量** | **+0.70pp** | ❌(−0.87/+2.06) | ❌ | **−1.03** | +0.26pp | ❌ |
| 【B】地板但量 <2倍(他說不能接) | −0.30pp | ❌ | ❌ | −1.34 | −0.74pp | ❌ |

⭐⭐ **三個值得記住的**:
1. **布林帶寬是單調的:越寬越好**(−0.41 → −0.32 → −0.02 → +0.42)——
   ⛔ 而他最強調的「**壓縮/夾娃娃之後會噴出**」**方向剛好相反**,壓縮那格是全表最差(−0.89pp),
   「壓縮後擴張」也是負的(−0.72pp)。⛔ 別做布林壓縮訊號。
2. ⭐ **「帶寬 >20%」與「站上中軌+帶寬>10%」通過了前四關,只卡在成本**(+0.42pp vs 來回 0.44%)
   → **統計上真的有邊際,但邊際小於手續費**。這正是 V72.0.3「統計顯著 ≠ 值得做」的again。
   ⭐ 而且**增量檢定**(V73.2.5 的做法)實測:帶寬>20% 的樣本裡 **78.4%** 同時也是「高波動」
   → 大半是把 App 已經在用的 `高位階+高波動` 再數一次。⛔ 不加。
3. 🚨 **【B】地板+有量 看起來成立(+0.70pp、方向跟他說的一致、差無量組 1.00pp),
   但「拿掉最好那一年」直接變 −1.03** —— 它整個 edge 靠 2025 那年的 +2.86。
   ⭐ **沒有那道關卡就會誤判成「他說對了」** —— 這是 V73.2.0 那道檢定第二次救場。

⛔ **結論:兩條都不上功能,App 一行判定邏輯都沒改。**
⚠️ 窗口整段偏多頭 + 倖存者偏誤 → 空頭未驗證;走完一次空頭後可重跑(尤其【B】接刀那條)。
⚠️ 這支探針第一版又踩了 **`push(...arr)` 大陣列爆堆疊**(CLAUDE.md V73.2.0 已記過一次)——
   ⭐ 通用:**已經寫進文件的陷阱,下次寫新程式時還是會再踩**,所以測試/守門比文件可靠。

### 📚 外部參考資料的評估紀錄⑥:57 份逐字稿(權證小哥《哥有籌必爆》S1+S2 全系列 + 兆華艾綸說 + 理財達人秀,2026-08-05)
使用者上傳 57 份逐字稿(~1.5MB),問「有沒有厲害的策略…**右下角策略、左側交易、抓到起漲點、題材獵人**」。
⚠️ **先澄清那四個詞**(免得日後有人去找一套不存在的方法):
「右下角」是隨口形容股價圖跌到右下角(= 跌深);「左側交易」只出現在一段 Q&A 且沒有規則;
「題材獵人」是**來賓漢偉哥的稱號**不是策略名。→ 這四個詞指向的其實是**同一件事:跌深的股票要不要撿**。

**✅ 已做(V72.4.9):全市場「地板股家數」= 大盤跌完了沒**
他的原話:「**地板股有大概 100 檔,那大概就是短線的低點**」。
⭐ 這跟個股版 `_detectFloorBounce`(V71.8.9,實測**接刀平均輸大盤**)是**完全不同的問題** ——
那張問「這一檔該不該接」,這張問「**大盤**跌完了沒」。⛔ 別把兩者混為一談或合併。
`floorcount_probe.py` 實測(2,251 檔 × 486 個交易日):

| 地板股家數(不看量) | n(交易日) | 5日邊際 | 10日邊際 | 20日邊際 |
|---|---|---|---|---|
| 10~49 | 118 | +0.12 | +0.36 | +1.64pp |
| 50~149 | 242 | −0.15 | −0.53 | −0.51pp |
| 150~299 | 74 | +0.10 | −0.33 | −0.58pp |
| ⭐ **300+** | **51** | **+1.55** | **+1.44** | **+1.45pp** |

⛔ **四條必須留在卡上的限制**:① **非單調** —— 中間段反而略差,⛔ 不可做成「越多越好」的連續計分因子
② 他說的「**有量** 100 檔」在 2 年窗口**只出現 11 天** → 樣本不足無法驗證,所以主指標改用**不看量**的、
門檻改用**實測有邊際的 300 檔**(⛔ 別「照原話」改回 100)③ 回測窗口整段是多頭(基準 20 日勝率就有 73.6%)
→ ⛔ 不可外推到空頭 ④ 交易日高度重疊 → n=51 不是 51 個獨立樣本。
📍 併進**大盤 → 市場廣度卡**(⛔ 沒開新卡);歷史走 `build_breadth_history` 的 schema self-heal
**一次回算 250 日**(⛔ 不是從今天開始累積)。測試 `scripts/test_floorcount.mjs` 31 條。

**❌ 實測不成立(⛔ 別再做一次)**
| 他的說法 | 實測(`turnover_stage_probe.py`,2,236 檔) |
|---|---|
| 「**低檔**高週轉(>20%)= 起漲」(S2 #19) | 低檔各週轉桶邊際 −0.06 ~ +0.09pp = **雜訊**,不成立 |
| 「**高檔**高週轉 = 出貨、不是好事」(同上) | 高檔 20~40% 桶邊際 **+0.44/+0.58/+0.87pp** —— **方向剛好相反** |
| 「**月線斜率 ≥1%/日 = 飆股**」(兆華艾綸說 07-08) | 5/10/20 日邊際 **−0.67 / −1.06 / −2.07pp**,n=5,207,**越陡越糟** |

⭐ 月線斜率那條特別值得記:**勝率反而較高(42.8% vs 基準 39.5%),但中位報酬更負** ——
又一次「**常對但賠更大**」(同 V72.0.3 的教訓)。⛔ 看到勝率高就放行,是這個專案最容易再犯的錯。
⚠️ 週轉率這次是**第二次**測(V72.0.1 `turnover_probe.py` 測的是「週轉率 × **昨日漲跌幅**」)——
⭐ 通用:**同一個指標配不同的第二變數,是不同的假設,要分開測**;但也要記得**前一次測過什麼**,
別重複測同一組(這次是刻意補測「× 位階」那組)。

**✅ 已經有了(逐條對照過,⛔ 不用做)**
地板股個股版(V71.8.9)・融資維持率 130%/追繳價 0.78×(V71.7.1 + V72.0.3)・
兩上兩下大戶散戶融資(V71.9.0/V71.9.7)・CB parity(V71.9.1)・投量比 >10%(V71.9.5)・
關鍵分點 + 地緣分點(V71.9.8)・集保戶數(V71.9.7)・軋空券資比(V71.9.2,**已驗不成立**)・
董監申報轉讓(`insider_miner.py`)・分批進場三步驟(= 艾綸「試探→確認→確立」,positionSizerCard)・
位階溫度計(= 他的「打幾折」)・處置股官方名單。

**⏳ 唯一真缺口但這次決定不做:融資使用率(融資餘額 ÷ 融資限額)**
他的「4 大融資指標」我有三個(增減/餘額/維持率),**只缺使用率**(>70% 天險、>50% 留意)。
⭐ 資料**其實拿得到而且零額外 API** —— TWSE `MI_MARGN` 同一份回應就有「融資限額」欄
(OpenAPI 是 `MarginPurchaseLimit`)。⛔ **但這次不做,三個理由**:
① `margin_balance` 是走 **SQLite `stock_history` 中介**進 `data/{sym}.json` 的 → 加欄位要動 DB schema,
   風險遠高於「多解析一欄」② **無法回算**(限額是每日快照)→ 只能從今天開始存
③ **無法驗證**:`margin_balance` 本身只回溯到 2026/05,他那三個門檻(20/50/70%)驗不了。
→ 要做的話正確順序是:先確認 DB schema 加欄位不影響既有匯出 → 存起來 → **累積滿 1 年再談門檻**;
   在那之前只能當**算術事實**顯示(同 `_trustVolRatioNote` 的處置),⛔ 不計分、不下方向。

**⛔ 缺資料源,別再評估**:盤前試撮 3 訊號(無逐筆歷史)・
借券/券差成本(無資料源)・可轉債「拉灌吹爆換」炒作階段(需 CB 市價/賣回價,只有轉換價)・
「浪子回頭」處置股回月線(處置系統 V70.3.1 已依使用者要求下架,⛔ 不重建)。

#### 📺 兆華艾綸說那 13 集(V72.5.0 使用者追問「有沒有新的有價值的策略」)—— 結論:**幾乎都已經有了**
逐集比對後,**沒有一條需要新做**。寫下來免得日後再讀一次:

| 他反覆教的 | 我的現況 |
|---|---|
| ⭐ **朱家泓「回後買上漲」完整定義**(f06 + f16 教了兩次):① 多頭回檔且**沒破前低** ② **在月線之上** ③ 出現**大量紅K上漲**;停損固定 5% 或跌破前低 | ✅ `_detectChuLongEntry` **已經是最嚴格版**(波段多頭 + 沒破前低 + 剛站上 5MA + 紅K≥2% + 量增 + 過昨高 + 站月線**且月線上彎**)。🚨 **而且已實測**:`高勝率做多買點` A 級 n=1,825 但**期望值 −0.485%**、`力道偏弱` 版 −0.999% → **這招被教得最多次,實測卻是負期望值**。⛔ 別因為「大師教兩次」就把它升級成主打訊號 |
| **報酬風險比 >3 倍才值得交易**(陳威良 f13/f14) | ✅ `_upsideRoom` 的 `rr` 早就有,而且門檻是 ≥2 划算 / ≥1 普通 / <1 不划算。他的 3 倍更嚴格但**沒有實證來源**,⛔ 不改門檻 |
| 融資維持率 **<135% 恐慌 / <140% 斷頭潮**(f07) | ✅ 全市場維持率已有(V72.0.3,實跑 127.9%)。⛔ **不加那兩條線** —— `margin_hist` 從 V72.2.1 才開始存,**沒有歷史可驗**,加上去就是又一個沒驗證過的預測性門檻 |
| 「**闖紅燈心法**」:能波段翻倍的股「第一天 **99% 都是漲停**」(f14) | ⛔ **敘述反了不能用** —— 那是「飆股→曾漲停」的機率,不是「漲停→會變飆股」的機率(base rate fallacy)。V72.0.1 已實測漲停隔日動能:**只有次日有效**(+1.54%),3/5 日就轉負 |
| 10 年期公債殖利率 4.5% ↔ 油價 120(f10) | ⛔ 他個人的相關性觀察,無實證;而且油價我只有單一數列,驗不了 |
| 台股平均本益比 31 倍 vs 美 32 / 日韓 20~23(f18) | ⛔ **缺資料源** —— 各國市場整體 PE 沒有免費結構化來源。我有的是**全市場 P/B 分位**(V71.6.2) |
| 分批進場「試探→確認→確立」(艾綸 f53) | ✅ `positionSizerCard` 分批進場計畫 |

⭐ **這次最值得記住的一條**:「大師講最多次的那一招」跟「實測有沒有邊際」是兩回事。
回後買上漲被教了兩集、還有專門的教戰日誌,但它在本專案 2 年全市場回測裡是**負期望值**。
⛔ 以後看到「某某老師的招」,先去 `_SIGNAL_EDGE` 查有沒有測過,別急著實作第二份。

### 📚 外部參考資料的評估紀錄③:郭哲榮(摩爾投顧)17 場直播逐字稿(2026-08-04)
使用者問「他為什麼那麼準、有什麼可以借鏡」。三個代理逐字讀完 4/13~8/4 共 17 場直播
+ 新聞,並用真實資料對帳。**結論存這裡,免得日後重讀一遍。**

**他真正的方法(可檢驗的部分)**:
- **低基期**(核心):「這檔股價對應的是幾萬點時代的大盤」——中美晶 230 元時大盤 2 萬多點,
  現在大盤 4 萬多它還是 231 → 買。本質 = 相對位階,跟本專案位階溫度計同族。
- **三五法則**:強勢股回檔 25% 可買/落難績優股回檔 35% 可買/回檔 >50% 不對勁。
  ⭐ `kuo_probe.py` 實測(2,227 檔、扣大盤、去重):**有小邊際但別神化** ——
  30~40% 桶 20 日邊際 +1.33pp/60 日 +2.17pp(勝率 41% vs 基準 33%);
  25% 桶幾乎沒邊際(+0.34pp);⚠️ **他說「不對勁」的 40~55% 桶在本樣本反而最好**(+2.24pp)
  → 那條線不是魔法,只是「跌越深反彈越大」的連續現象。中位數全是負的(樣本落在下跌窗口)。
- **EPS × 20 倍本益比 = 目標價**(= 本專案 V35.7 法人目標價純公式,他用同一招批花旗給國巨 40 倍)。
- **有價有量大型股**(動輒 2-300 億成交量)、**人棄我取**(跌停/處置日買 —— 環球晶 730 跌停加碼)、
  **產業供需只看擴產難度**(記憶體難擴產 → 缺貨鏈上矽晶圓)、韓股頸線/季線當台股領先指標。
- **一億 0050 的真正邏輯**(數據對帳):高點 47,742 → 7/30 低點 39,933 = **-16.4%/五週急跌**;
  40,000 = 整數關卡 + 他要「V 轉的感覺」;選 0050 因為①分析師不能買個股②指數不歸零③拒槓桿
  (韓國 2 倍 ETF -70% 前例)。7/28 預告 → 7/29 盤中破 40,000 買 1,100 張(93.45/93.2,永豐板新,
  可查分點)→ 7/31 +3,187 點、0050 漲停 102.85 → +9.5% ≈ 千萬。
  **本質 = 指數深跌後的正期望 + 扛得住 + 敢公開,不是預知**。

**「準」的另一半是話術結構(⛔ 本專案不學,但要能識別)**:
- **條件式預告的不對稱性**:「跌破 X 我就買」—— 沒觸發=沒錯,觸發後漲=神,跌=長期投資(他自己說「三贏」)。
- **機率化免責**(「我只有 60%」「合格分析師不能說 100%」)+ **雙向皆贏**(「利多繼續漲、利多出盡都對」)
  + **事後選擇性回放**(智原「四天兩根漲停」,少一根歸因颱風假)+ **高頻預告**(「全台灣最敢預告的男人」)。
- 實錘的錯也不少:42,000「多重底不會破」三天後破、外資史上最大賣超 1800 億賭輸(實際 1431)、
  8/1 怕「週一再崩」結果週一收漲 —— 錯的被「修正預測是分析師的權利」吸收掉。

**✅ 已有(不用做)**:位階溫度計、法人目標價、處置股見低點(attention data)、韓股/費半連動
(macro_risk 有 kospi)、期現價差、價格提醒(= 他的條件式預先承諾,使用者自己就能設)。
**⭐ 唯一值得評估的新顯示**:「這檔股價 = 幾萬點時代的大盤」—— 零採礦可算
(個股價格回到歷史哪個時期 → 對應當時 ^TWII 點位 vs 現在),比裸位階 % 更白話。⚠️ 未實測預測力,
要做先掛「參考資訊」。
**⛔ 不學**:all-in 煽動、無停損(指數可以不停損因為不歸零,個股不行 —— 他自己也是個股有停損)、
「最高已經獲利 X%」的績效口徑、複利敘事。

### 🌍 新聞「太舊」的三層真因(V72.3.3)⭐ 使用者問「地緣政治突發能不能更快抓到」
使用者:「川普老是說要打伊朗、伊朗打美軍等等,有時真的影響股價」。
⭐⭐ **查下來真因不是「抓太慢」,是「抓到之後被丟掉」** —— 而且三層,由深到淺:

| 層 | 問題 | 為什麼躲得掉 |
|---|---|---|
| ① **關鍵字白名單** | `TW_RELATED_KEYWORDS` **一個地緣政治/軍事/能源詞都沒有** → `_is_tw_relevant()` 把「Israel strikes Iran nuclear site」整條濾掉 | log 只印「對台股無關過濾掉 N 則」,看起來像正常運作 |
| ② **時間窗** | `fetch_global_news` 的 `win_end` 寫死「最近已過的 **05:00**」→ **今天 05:00 之後全丟**。舊註解自己寫著「今日盤中 → 丟棄」,但 workflow 叫「即時新聞快訊」、每 4 小時跑,前端卡片寫「盤前+盤中」→ **三邊講同一件事,只有那一行沒跟上** | 實測 `global_news.json` updated 是台北 20:33、最新一則卻是**前一天** 19:54 GMT(落後 17 小時);盤中三輪等於白跑 |
| ③ **cron 頻率** | 盤中只有 09:00/13:00 各一次(中間空 4 小時);`* * 1-5` → **週末完全不跑**,週五 21:00 到週一 09:00 空白 **60 小時**,而地緣衝突最愛週末爆 | 這層最明顯,但**單修這層完全無效** —— ①② 沒修的話跑再密也照樣被丟掉 |

⭐⭐ **通用鐵則:「資料太舊」先查「有沒有被過濾/被時間窗丟掉」,再查抓取頻率。**
頻率看得見、好改,所以是直覺反應;但過濾與窗口是**靜默**的,而且加密頻率對它們完全無效。
⚠️ 同型的還有:快取跳過條件(陷阱 #10)、守門把值設成 None(陷阱 #22)——
   都是「上游明明有資料,被自己這邊擋掉」。

**已落地**:①補 20+ 個地緣/軍事/能源關鍵字 + 配套黑名單(星際大戰/勇士隊那類)
②`win_end` → `now`(窗口**只放寬 end,start 不動** → 盤前 05:30 那輪結果幾乎不變)
③平日盤中每小時 + 週末每 6 小時 ④加 2 條專用來源(地緣突發 / 油價航運,都掛 `when:1d`)。
⚠️ 本 repo 是 **public**(GitHub Pages 免費方案的前提)→ Actions 分鐘數不計費,
   舊註解寫的「2000 分免費額度」不適用;真正的限制是 **Groq 翻譯額度**(每輪最多 10 則)。
⛔ **加關鍵字必然放大雜訊** → 黑名單要同步補,測試 `scripts/test_geonews.py`
   把「要收到 9 條 / 要擋掉 5 條 / 原本就收的仍要收」三組一起釘住。
⚠️ 該測試⑥是**實跑** `fetch_global_news`(注入假新聞 + stub feedparser),
   ⛔ 不複製一份窗口算式當第二份真相;而且有**空過守門**(收到 0 則時「舊新聞要被丟掉」
   那條會變假綠 —— 第一版就因為 output key 猜成 `news`(實際是 `items`)踩到,靠守門抓出來)。

### 🧩 ETF 不可沿用個股版面(V72.4.1)—— 陷阱 #19 的第二次犯案
使用者截圖(00981A 主動式 ETF)在**我的 App**上顯示
「毛利率 +3.0pp(從 2 季前 20.2%)」「每季 EPS 2.64」「投資屬性 52/75/80」——
🚨 **ETF 沒有毛利率、沒有 EPS、沒有本益比**,那些全是**上一檔個股的殘留**。

**根因**:`fetchFundamentalAnalysis` 的 ETF 早退**只清了好清的那幾格**
(`xrayYoy`/`xrayPe`/`xrayYield`/…),⛔ 沒清 `xrayGmCompare`(毛利率趨勢文字)、
`xrayEpsTrend`(EPS 圖)、`xrayInv*`(投資屬性雷達)。畫面零錯誤訊息 →
使用者會拿別檔的財報數字去判斷這檔 ETF。
⚠️ **ECharts 圖要 `dispose()`,只清 innerHTML 會留 canvas。**

⭐ **通用鐵則(這是第二次犯):任何「這類標的不適用 → 早退」的分支,
   都要清掉「這一整頁 async 才填的東西」,不是只清好清的那幾格。**
   同型的還有指數(陷阱 #25)。新增任何 X 光機欄位時,ETF 早退清單要一起加。

**順手抓到指路指錯地方**:那段說明寫「請看**籌碼分頁**」,
但 ETF 兩張卡實際在 **總覽 → 進場**(`data-ovpane="entry"`)。
→ 陷阱 #32 的變形:**卡片沒放錯,是指路指錯**。⚠️ 日後搬卡要連這句話一起改。

**⭐ 使用者要的「數字要分析出有什麼作用」**(`_etfNumbersMeaning`):
採了一堆欄位卻只把數字排出來 → 使用者不知道要拿它做什麼。每個數字配一句「所以呢」:
| 數字 | 作用(翻成人話) |
|---|---|
| 折溢價 | **你今天買貴了沒**;主動 ETF 溢價高→申購湧入→經理人被迫追高買成分股 |
| 規模**變化** | ⭐ 絕對值沒意義,**變化**才有:暴增=經理人必須買股(對成分股是買盤)、暴減=被迫賣股 |
| 現金水位 | 主動 ETF 經理人的攻守態度(⚠️ 是他的看法不是預測) |
| 最大持股集中度 | ≥25% = 買這檔幾乎等於買那一檔股票,分散效果有限 |
| 換股頻率 | 決定**你跟車要跟多緊**(高=清單很快過期) |
| 費用率 | 換算成「每放 10 萬一年被扣幾元」(使用者鐵則:% 一定要配元) |

⚠️ 折溢價/規模一律**跟這檔自己的歷史比**(同外資期貨 V71.1.6:寫死絕對門檻會失真)
→ 採礦端 V72.4.1 起存 `hist`(每檔滾動 250 筆 `{d,p,n,s}`);
歷史 <20 筆時**誠實說「累積中」**,⛔ 不硬給位階。
⚠️ `fetch_etf_premium` 改回傳 dict(`prem`/`nav`/`px`)—— 同一包 mis 回應本來就有
`f`=預估淨值、`e`=成交價,以前只取 `g` 就丟掉了。

**🕵️ `_etfManagerMoves`(新)**:App 原本只有**反查**(個股頁看「哪些 ETF 買了我這檔」),
⛔ 站在 ETF 自己頁面上反而看不到「這檔最近動了誰」—— 而那正是買主動式 ETF 的人最想知道的。
沿用 V72.3.1 的基準重建守門(整批 added 且其餘全 0 → 不顯示成新買進)。

**⛔ 配息不做(暫)**:籌碼K線那張「股利政策」需要 ETF 配息資料,**本專案沒有資料源**。
照鐵則寫了 `etf_div_probe.py` + `etf_div_probe.yml`(手動觸發)去問官方端點,
⛔ **在確定端點之前不准在 `etf_miner.py` 加配息欄位** —— 憑猜的欄位會永遠是 null,
而且會躲過資料體檢(`business_signal` 踩過的坑)。
測試 `scripts/test_etfpage.mjs` 26 條(含「先弄髒再驗有沒有清乾淨」的空過守門)。

### 🧠 深度診斷 `renderDeepBrief` / `analyzeStockDeep`(V72.4.0)
使用者要求:「個股有用資料 + 總經 + 台股大盤一起看,告訴我要注意什麼、怎麼做、
大戶什麼時候可能出貨、是區間操作還是低檔布局」。

⭐⭐ **架構上最關鍵的決定:JS 算完 → 一次 AI 呼叫 → AI 只做翻譯。**
參考的 `aiagents-stock` 是 **6 個 agent 各自拿原始資料自己推理 + 開會 + 下決策(7+ 次呼叫)**,
那正好違反「禁 AI 算數」—— 語言模型不會算均線,讓它自己算就是在生成幻覺。
⛔ **別被「多 agent 比較厲害」的直覺帶著走**:agent 數量不是品質,
   「數字誰算的」才是。這裡反過來做,而且**成本從 7 次呼叫降到 1 次**。

**三支純公式(⛔ 都不靠 AI,沒金鑰也要有東西看)**:
| 函式 | 回答什麼 | 關鍵設計 |
|---|---|---|
| `_distributionWatch(data, sym)` | 大戶出貨徵兆 8 條 | ⛔ **徵兆清單不是預測** —— 沒人算得出大戶哪天出貨。每條**必附佐證數字**,沒資料的條目要說「此股無分點資料」而不是留白 |
| `_playbookMode(data, sym)` | 低檔布局 / 區間操作 / 順勢做多 / 先不做 | ⛔ **一律先過 `_bearGate`** —— 空頭時位階再低也不給「布局」。箱型判定 = 近 60 日區間 ≤22% **且** 20MA 上下穿 ≥4 次(只看區間寬會把單邊趨勢誤判成箱型) |
| `_deepBriefFacts(data, sym)` | 把已算好的一切收成一包 | ⛔ 只做蒐集格式化,**不做任何新判斷**(判斷都在上面兩支與既有函式) |

⛔ **AI 那段的四條硬約束(提示詞裡明寫,測試 ③ 釘住)**:
① 「所有數字都已由程式精算完成,⛔ 不要自己做任何加減乘除」
② 「⛔ 不要給任何買賣價位」(單一劇本原則 —— 價位由既有卡精算且已扣成本)
③ 「程式已下的操作結論…**你必須跟它一致,不可改口**」(防 AI 跟純公式打架)
④ 多要兩個欄位:`invalidate`(什麼情況代表判斷錯了)+ `blindspot`(這份分析看不到什麼)
   —— ⭐ 這兩個是**主動要求 AI 講自己的極限**,比多加一個看多理由有價值得多。

#### 🚪 V72.4.7 出場管理狀態 `_exitMode` —— 單一劇本原則的**執行機制**
使用者看完總覽三張截圖:「把雜訊移除…不要模擬兩可,也不要資訊打架」。
問題不是任何一張卡算錯,而是**五張卡都在下指令、方向不一致**:

| 卡片 | 它說什麼 | 打架點 |
|---|---|---|
| 現在怎麼做 | 🚪 建議離場 | (這張是對的,應為唯一指令來源) |
| 進場劇本 | 進場 558・停損 524・目標 664.80 | 🚨 你都要走了還給進場價 |
| 上檔空間 | 還有 +8.7%、一張淨賺 +49,210 元 | 🚨 一邊叫你走一邊說還能賺 |
| 今日盤勢 / 朱老師雷達 / 深度診斷 | 各自再下一個結論 | ⚠️ 第一眼看到四個答案 |

**修法(三處吃同一個判斷點)**:
- `app._exitMode = {sym, on, big, slF}` 由 `_renderTrendCommand` **統一寫入**,
  `app._inExitMode(sym)` 是**唯一**判斷函式。⚠️ 綁 sym 防切股殘留(同 `_ovTrend`)。
  ⛔ 以前只有「分批進場計畫」有守門,其他卡各判各的 → 這就是為什麼會漏。
- 出場狀態:**進場劇本整張收起**(`renderPlaybookRadar` 早退)、
  **上檔空間改講「反彈到哪裡該分批出」**(⛔ 數字完全不變,改的是它對「要出場的人」的意義,
  清單標題改「⛔ 不是買進目標」)。
- **總覽第一眼只剩主卡**:今日盤勢/部位大小/盤中雷達收進 `<details id="ovNowMore">`,
  主卡內的「重點判讀 + 新聞」也收進摺疊,並把「照這樣做」的價位**提到大字結論正下方**。
  ⭐ **一張卡、一個字都沒刪** —— 只是預設收起(同 `_SIGNAL_EDGE` 對 C 級的處置原則)。

⚠️ 測試 `scripts/test_exitmode.mjs` 18 條**兩邊都釘**:
出場時「不可再給進場價/不可再寫還有幾%空間」**以及**非出場時「不可誤傷正常情況」——
⛔ 只驗一邊會做出「一律改掉」的過度修正。

#### 🚨 V72.4.6 「已經達成的條件」還當成指令顯示(使用者截圖 2327,最危險的一類)
| 症狀(國巨 2327,盤中 591) | 真相 |
|---|---|
| 「反彈碰到 **5 日線 533** → 先出一半」 | 🚨 **現價已經 591**。5 日線是**昨天收盤**算的,今天盤中 +4.9% 早就站上去了 → 那句話是拿**已經達成的條件**叫人「等它發生」,照著掛單會完全錯亂 |
| 「跌破 **532.95** 全部出」 | 同上,早就不是防守點,**它現在是上方壓力** |
| 摺疊列「**20MA 891.00 跌破**」 | 現價 594,891 在**上方 50%** —— 字面沒錯但會被當成可掛單的防守價 |
| 上檔空間「**一張**淨賺 +49,210 元」 | 🚨 使用者只有 **0.07 張(70 股)**,實際 +3,445 元 —— **差 14 倍**,零股族會嚴重高估 |

⭐⭐ **通用鐵則(這條最重要)**:
**任何「等它碰到 X / 跌破 X 就怎樣」的指令,顯示前都要先確認「現價還沒到 X」。**
到了就要**改口**(「已經站上/早就跌破,現在是壓力」),⛔ 不可原文照顯示。
⚠️ 特別容易在**盤中**踩到:均線/防守價是用**昨日收盤 K 線**算的,而現價是即時報價 ——
當天大漲大跌時兩者會差到 10% 以上。

⭐ 金額類同理:`app._myShares(sym)` —— **有庫存就用實際股數**,沒有才用「一張」當範例,
   而且**標籤要跟著改**(「你手上 0.07 張淨賺 …」),⛔ 不可金額改了標籤還寫「一張」。
   ⚠️ 風報比的 risk 也要用同一個股數(否則分子分母基準不同)。

#### 👥 V72.4.5 「只看大戶少了散戶」—— 使用者的觀察對,但**不能用散戶佔比去做**
使用者問:「散戶在高檔捨不得砍單,是否就區間操作?」

⚠️ **散戶佔比不能拿來下判斷**:`tdcc_holders.json` 只有 **13 週**(同 V71.9.0 的限制)
→ ⛔ 無法驗證「散戶多會怎樣」→ **只做事實描述**(幾%、幾人、平均每人幾張),不計分不下多空。
⛔ 而且**刻意不加「多殺多/信心不足」那種心理判讀** —— 那是沒驗證過的預測性主張,
   提示詞明令 AI 不准講(測試 ⑩ 釘住)。

⭐ **改測一個更直接、而且完全可回測的東西**:`_trappedRatio()` =
「近 120 日買進的人,現在還在賠錢的比例」(成交量分布中典型價 > 現價的佔比)。
`trapped_probe.py` 全市場實測(扣同期加權、20 日去重、n=11,843~28,376):

| 套牢比例 | 10日勝率 | 20日勝率 | 60日勝率 | **後 60 日波動區間** |
|---|---|---|---|---|
| 0~20%(人人賺)| 39.6% | 37.3% | **29.8%** | **32.5%** |
| 40~60% | 35.3% | 32.8% | 25.2% | 26.7% |
| 80%+(人人套)| 34.6% | 31.5% | **24.5%** | **23.8%** |
| (基準)| 36.3% | 32.8% | 25.9% | — |

⭐ **兩個單調趨勢(所以不是雜訊)**:① 套牢越多勝率越低(三個天期一致,頭尾差 5pp)
② **套牢越多,後續波動區間越小**(32.5% → 23.8%)= 越像箱型、越不會噴。

✅ **使用者的推論對了一半**:套牢多 → 波動確實變小。
⛔ **另一半不成立**:V72.4.4 才實測「區間操作」60 日 −0.55pp →
   **「波動小」不等於「適合區間操作賺錢」**。正確用法是「**期待值要放低,別當飆股買**」。
⚠️ 中位報酬邊際都在 ±0.85pp 內 → ⛔ **不可當進場/放空訊號**(卡上有寫)。

⚠️ 實作細節:用**典型價 (高+低+收)/3** 不用收盤 —— 振幅大的日子用收盤會失真。
📍 併進既有深度診斷卡的「👥 這檔現在誰在手上」區,⛔ 沒有新增卡片。

#### 📊 V72.4.4 回測 `_playbookMode`:**打臉自己寫的功能**(這比再加一個指標有價值)
`scripts/playbook_backtest.mjs` —— 跑**真正的 `app._playbookMode()`**(⛔ 不複製判定邏輯),
全市場 2,227 檔、扣同期加權、同檔同型態 20 日去重:

| 型態 | 10日 | 20日 | 60日 | 60日勝率(基準 25.8%)| n |
|---|---|---|---|---|---|
| 📈 順勢做多 | −0.06 | +0.02 | **+0.81pp** | **29.8%** ✅ | 12,271 |
| 🔪 別接刀(警告) | +0.38 | +0.65 | +0.27 | 25.4% | 9,656 |
| 📦 區間操作 | +0.18 | +0.50 | **−0.55pp** | 23.1% ⚠️ | 7,542 |
| ➖ 先不做 | −0.10 | −0.02 | +0.53 | 26.1% | 19,899 |
| 🧊 **低檔布局(分批)** | **−0.15** | **−0.25** | **−0.58pp** | **23.2%** ⛔ | 16,358 |

🚨 **「低檔布局」三個天期全是負的,而且樣本 16,358 筆不是雜訊** —— 這是我自己寫的功能,
實測說它沒有優勢甚至略差。⭐ **「便宜」本身不是買進理由。**
⛔ **但不可以刪掉**(刪了使用者會以為沒有這種情況)→ 照 `_SIGNAL_EDGE` 的做法:
**照顯示,但在卡上誠實標「⛔ 實測沒有優勢」+ 說明要等什麼才動**。
成績表 `_PLAYBOOK_EDGE` 嵌在 index.html,⚠️ **改 `_playbookMode` 判定就要重跑回測更新它**。

⚠️ 兩個方法論陷阱(第一版都踩到了):
1. **對照組不可抽樣** —— 第一版用 `i % 40 === 0`,但 `i` 本來就是 3 的倍數 →
   實際只在 120 的倍數觸發,樣本稀疏又跟固定索引對齊 → 基準勝率被壓到 23.6%,
   於是**每一種型態都「贏基準 9~15pp」**。⭐ 正解:事件本來就是「所有掃到的日子」的子集合
   → **基準就用同一個母體**(不抽樣),直接可比。
2. **回測時沒有 `_bearGate`/`_ovTrend` 快取** → 這是「沒有空頭守門」的**保守下界**,要寫進報告。

#### 💾 V72.4.4 AI 額度:快取綁「資料日期」不綁時間(使用者問「每次開啟會不會爆」)
- 舊版 `aiCache_deepBrief_{sym}` + 30 分鐘 → 開一次算一次,確實會爆。
- ⭐ **收盤資料一天只變一次** → cache key 改成 `{sym}_{dataDate}_{engine}`,
  **同一檔同一天只算一次**,開幾次 App 都直接顯示,零額度。
- `cacheOnly: true` 模式:`renderDeepBrief` 自動吃快取顯示,⛔ **沒算過就不打 AI**
  (掃榜單快速切股會連續觸發、把額度燒光)。
- ⚖️ 「換模型比對」按鈕走 `chain:'groq-only'` + `_deepBriefQuality` 量化兩邊品質。
  ⚠️ CLAUDE.md 鐵則「深度判讀不該降級到 Groq」仍成立 —— Groq **只在使用者主動比對時**用,
  ⛔ 不會變成自動 fallback。
- 🗂️ `aiVerifyLog`(滾動 200 筆)存**可回頭驗證**的東西:結論、`invalidate` 條件、當時收盤、日期。
  ⭐ 這正是 `aiagents-stock` 設計了卻沒做成的事(它 116 筆全 `executed=0`)。
  ⚠️ 只能從今天開始累積(AI 歷史判斷沒存過 → 不能回算)。

#### 🔧 V72.4.2 使用者實測:「**沒什麼屁用**」—— 逐條拆解為什麼(這段比功能本身重要)
使用者拿中美晶 5483 實測 V72.4.0 那版,四個毛病**全部是提示詞設計錯誤,不是模型爛**:

| 症狀(截圖原文) | 根因 |
|---|---|
| 「大戶出貨徵兆代表大戶減持和散戶增持的信號,**而非預測出貨的時間**」 | 🚨 **AI 在複述我寫給它的免責條款** —— 我把「⛔ 不可預測哪天出貨」寫進了**輸出欄位的說明**,它就當成內容輸出了。⭐ **約束要寫在系統規則區,不可寫進「這個欄位要放什麼」** |
| 「突破或跌破將是關鍵」「轉強或轉弱」 | **雙向都對 = 零資訊**,正是 CLAUDE.md 批評郭哲榮的「雙向皆贏」話術 —— 我自己的 AI 在做同一件事 |
| 「外資近5日和近20日的減碼行為值得關注」 | 提示詞只**建議**引用數字,沒有硬性要求也沒有驗證 |
| 「月線209.60和季線179.78的突破或跌破將是關鍵」**沒講現價 181 在哪** | 🚨 餵給 AI 的 facts **只有均線數字、沒有「現價在它上面還下面幾%」** —— 資料不給它,它當然講不出來 |
| 「量能只有 1.0×20日均量」vs 頂部「量增 17%」 | **同名不同義**:頂部是「比昨量」、facts 是「比 20 日均量」。⛔ 兩個都對但基準不同,只提一個就會被當成打架 |

⭐⭐ **最根本的一條:AI 那段沒有增加任何純公式沒有的資訊**,只是把程式的結論
用更長更模糊的句子重講一遍。→ 新增兩個**只有 AI 做得到**的欄位:
`conflict`(哪些訊號互相矛盾、該信哪一邊)+ `mistake`(這種盤最常見的錯誤動作)。

🔍 **`_deepBriefQuality()` 輸出品質守門** —— ⛔ 光靠提示詞叫它別講廢話擋不住
(「沒有報錯」≠「檢查過了」)。回來後量三件事:廢話詞 / 有沒有數字 / 是否在複述規則。
判定空泛時**照樣顯示內容**(⛔ 不藏),只在下面標一行「這次 AI 回得很空泛,建議重抽」。
⭐ **測資直接用使用者截圖那版原文** —— ⛔ 別用自己編的假廢話,那只會驗到自己想得到的說法
(同 V72.1.4「巡邏 grep 只能抓你想得到的說法」)。實測:舊版抓到 4 條、好版本 0 條誤報。
測試 `scripts/test_deepbrief.mjs` ⑦⑧(合計 60 條)。

#### 🐛 V72.4.3 使用者問「貼的資料對嗎」→ 核對後**AI 那段全對,錯的是頂部**
| 症狀 | 真相 |
|---|---|
| 頂部「總量 **4331.8萬張**・量增 **117944%**」 | 🚨 **差 1000 倍**。`_chuVolumeProgress` 的 `prevVol` 有做「股/張」自動偵測,`cur`(即時報價)**沒有** → 盤前退 Yahoo fallback 拿到的是**股**(`regularMarketVolume`)。實測 (43,318,000−36,700)/36,700 = **+117,944%** ✓ 完全吻合。→ 抽出 `app._volToLots()`,兩邊共用 |
| 頂部 181.00 vs 深度診斷 182.00 | **兩個都沒算錯,是不同來源**(即時報價商 vs 證交所官方收盤)。→ 照「不同來源就給不同名字」:深度診斷一律標「官方收盤 MM/DD」,提示詞明令 AI ⛔ 不准講成「現價」 |
| AI 說「缺乏基本面的本益比和殖利率」 | **兩層**:① `_deepBriefFacts` 讀的 `_fundCache` 要**開過「基本」分頁**才會填 → 改讀全市場 `_loadFundCache()`;② ⭐ **中美晶 5483 是上櫃,而 `fundamentals_cache.json` 840 檔全是上市** —— BWIBBU_d 只涵蓋上市,**上櫃的 PE/殖利率一檔都沒有**。這是真缺口 → 新增 `fetch_tpex_fundamentals()`(TPEx OpenAPI,免金鑰) |

⭐ **三個通用教訓**:
1. **同一個量在兩個地方換算,一定要用同一支函式** —— 否則遲早只改到一邊(這次就是)。
2. 「AI 說沒有資料」要先分辨是**真的沒有**還是**沒載進來**(V72.1.6「欄位存在 ≠ 有資料」的鏡像)。
3. ⚠️ **全市場快取要檢查「涵蓋範圍」不是只看筆數** —— 840 檔看起來很多,但**上櫃 0 檔**。
   查法:`Counter(k[0] for k in keys)` 看代號開頭分布(同 V72.1.7 回測選樣偏誤的教訓)。
⚠️ 併上櫃時**只補「上市沒給的」欄位**,⛔ 不覆蓋上市既有值(否則兩邊數字會打架)。
測試 `scripts/test_volunit.mjs` 17 條(含「給股 vs 給張要得到同一個 cur」)。

⚠️ 落地位置:**原本「此股預判 AI」那一塊整個是 `<div class="hidden">`** ——
個股頁在 V72.4.0 之前**根本沒有任何 AI 分析**(V51.4 停用、V71.0.7 刪死鏈之後就空著)。
所以這是「填回既有位置」,⛔ 沒有新增卡片。
測試 `scripts/test_deepbrief.mjs` 47 條(用**真實 data/*.json**,含空過守門「至少要有 1 條徵兆亮起來」)。

### 🗂️ 新聞類別表 `NEWS_CATEGORIES`(V72.3.4)—— 加關鍵字要連「分類」一起做
使用者:「最新科技技術、缺貨、延遲交貨、火災、地緣政治…會影響股價的也加進來,
我沒想到的你推薦」。⭐ 做法上有三個決定值得記:

1. **⛔ 不是把字加進同一個 list 就好** —— 加到 100+ 個字之後,使用者看清單會
   **分不出這則是火災還是漲價**。→ 改成**分類表** + 前端掛徽章:
   🔥事故天災 ・🌍地緣管制 ・⚡供需價格 ・🧪技術突破 ・💱匯率成本 ・📊財務事件 ・🛡️資安法律 ・📈股價異動。
   零額外採礦(`matched_keywords` 本來就有)、⛔ 零新增卡片。
   ⚠️ 徽章**一律中性灰** —— 它講「這是什麼類型的消息」**不是多空方向**,
   用紅綠會跟旁邊那行「利多/利空」打架(燈號鐵則)。
2. 🚨 **舊表只有「降價」沒有「漲價」** —— 而記憶體/面板/被動元件/矽晶圓**漲價**
   才是台股族群行情最典型的發動點,等於把最重要的一類整個漏掉。
   ⭐ 通用:**做關鍵字表時要主動找「對稱詞有沒有缺一邊」**(漲/跌、急單/砍單、升值/貶值)。
3. ⭐ **使用者沒想到、但台股最該抓的是「地震/停電/限電/缺水」** ——
   台灣在地震帶上,2024/04 花蓮地震台積電停機、2021 兩次大停電、2021 大旱竹科限水,
   殺傷力比火災更大更常見。⛔ 別只照使用者列的做,產業特有風險要主動補。

**⚠️ 兩個過濾器要一起改**:中文源走 `NEWS_CATEGORIES`(子字串)、
英文源走 `TW_RELATED_KEYWORDS`(`\b` 整詞)—— **只改一邊等於只修一半**
(同「一個修法要掃過所有頁面」)。新增的 4 條英文來源(缺貨漲價/停產事故/出口管制/技術突破)
**每條都綁產業限定詞**(`fab OR factory OR semiconductor…`)—— 不綁的話
`fire`/`shortage`/`delay` 會撈到一堆跟台股無關的社會新聞。

⛔ **刻意不收太泛的詞**(單獨的「訂單」「認證」「產能」)—— 那種每天上百則,會把真訊號淹掉。
⛔ **關鍵字不可跨類重複**(重複會讓分類結果取決於 dict 順序),測試 ⑦ 有釘。
測試 `scripts/test_geonews.py` 55 條(①~⑨,含分類 9 例 + 優先序 + 「cat 真的寫進輸出」)。

### 📚 外部參考資料的評估紀錄⑤:`aiagents-stock` 開源專案(2026-08-04)
使用者上傳一份 **A股** 的開源專案(Streamlit + DeepSeek 多 AI agent,48,926 行 Python、
100+ 檔、README 69KB),問「有沒有可以優化/參考的」。逐份讀完的結論存這裡,**別再讀一次**。

**⛔ 四個「不能學」——而且都是本專案早就繞開的坑,拿它們當反面教材**:
1. `longhubang_scoring.py` 龍虎榜評分:**寫死游資名單**(赵老哥/章盟主/92科比…)+ 拍腦袋權重
   (頂級 +10 分・知名 +5・普通 +1.5),**零實測**。= 本專案 V71.7.2 已修掉的 `_BROKER_GOD`
   人工標籤問題(實測「美商美林」被標「最兇隔日沖」但真效果 ≈ 0)。⛔ 別回頭去做人工分點標籤。
2. `news_flow_model.py`「接盤總量 = 流量 × 轉化率 × 客單價」:轉化率係數(政策 2.0/利好 1.8/
   漲停 1.8…)、基礎轉化率 0.0001、平均客單價 50,000 元、時間衰減 0.95 —— **全部是編出來的**,
   乘起來得到一個看起來很精確的數字。這正是「⛔ 預測性主張一定要先實測」在防的東西。
3. **整包沒有任何回測模組**(`grep -rl "backtest|回测" --include=*.py` → **0 檔**),
   但 README 寫「净利增长策略…**回测年化100%+**」。唯一的 `win_rate`
   (`value_stock_strategy.py:258`)是模擬交易記錄不是回測,UI 自己還寫「實際交易存在滑點、
   手續費等成本」。→ 對照本專案 `signal_backtest.mjs`(全市場 2,227 檔・扣同期加權・扣來回成本
   0.44%)+ 11 支探針,**方法論領先一整個層級,不需要向它學任何策略**。
4. 美林投資時鐘/康波周期的**象限判定丟給 AI 判**(`macro_cycle_engine.py:93`
   `merrill_lynch_clock_agent(formatted_text)`)→ 違反「禁 AI 算數」鐵律。

**⭐ 唯一真正的收穫:它照出了本專案自己的一個 bug(已修 V72.3.2)**
去比對「它有的宏觀資料 vs 我有的」時發現:`macro_risk.json` 的
`business_signal`(國發會景氣對策信號)= `{'light':None,'score':None,
'error':'Expecting value: line 1 column 1 (char 0)'}` —— **抓不到,而且是陷阱 #23 的簽名**
(站方對不存在的路徑回 HTTP 200 + HTML,拿去 parse JSON 就爆這句)。
🚨 更要命的是 **`scripts/data_audit.py` 的 C 類只掃頂層 `*_error`**,
這個 error 包在 dict 裡 + 頂層 `business_signal_error` 是 None → **體檢一路放過它**。
→ 兩處都修:C 類**往下走一層**掃巢狀 `error`/`err`(⛔ 只走一層,再深會開始誤報);
  `fetch_business_signal` 照 `_taifex_list_endpoints()` 的做法,失敗時記下 content-type +
  回應開頭、並去官方頁面 regex 撈候選端點寫進 error 字串(沙箱連不到 NDC,只能讓官方自己說)。
⭐ **通用教訓:「有 `*_error` 欄位」的檢查只做頂層是不夠的** ——
   把錯誤包進 dict 就等於對體檢隱形。新增任何「回一包 dict 且內含 error」的欄位要記得這件事。

**➖ 它有但本專案更好(不用做)**:多 AI agent 角色分工(我有首席分析 + 模型分工鐵則)、
持倉定時分析(我有庫存 + PWA 推播 + 排程)、K 線技術指標(我有 46 個偵測器**而且有實測成績表**)、
風險評分(我的 `_calcRiskScore` 吃真實 VIX/外資期貨/日圓)、通知(PWA + 鈴鐺 3 天歷史)、
董監質押/內部人(`insider_miner.py` 已有,= 它的「限售解禁/大股東減持」台版對應)。

**⚠️ 它的架構教訓(反面)**:選股功能依賴**同花順問財**,而問財對 requests 做 TLS 指紋識別 →
它得開 Playwright 無頭瀏覽器 + **要使用者自己先登入**才能用。
⛔ 本專案的「全部走官方免費 API、不靠登入態」是刻意的,**別為了多一個資料源去接需要登入的站**。

**🧪 第二輪深挖(2026-08-05,使用者問「還有什麼資料/邏輯可參考」)**
第一輪看策略與回測,第二輪翻了 `.db` 實際資料、指標實作、監控與通知。結論:

- **`.db` 檔全是 A股 開發者自己的測試資料**(龍虎榜 1,731 筆、中國平台熱搜 8,464 筆、
  AI 決策 116 筆…)→ ⛔ 對台股零用處,而且**不該把別人的資料放進本 repo**。
- **技術指標只有 RSI/MACD/KDJ/BOLL**(`ta` 套件現成的)→ 我有 46 個偵測器**而且有實測成績表**,無一可學。
- ⭐ **唯一「我沒有、而且純公式算得出來」的是 ARBR(人氣/意願指標)**
  `AR = Σ(H−O)/Σ(O−L)×100`、`BR = Σ(H−昨收)/Σ(昨收−L)×100`,只要 OHLC → 零採礦。
  照鐵則寫 `arbr_probe.py` 實測(2,227 檔、扣同期加權、去重 20 日、含相對自己位階版):

  | 情境(傳統說法)| n | 10日邊際 | 20日邊際 | 60日邊際 |
  |---|---|---|---|---|
  | AR 穿 150(過熱)| 7,993 | −0.18pp | −0.48pp | −0.61pp |
  | **AR 穿 50(超賣**可買**)** | 6,710 | −0.28pp | −0.34pp | **−1.55pp** |
  | BR 穿 300(極熱)| 1,605 | +0.06pp | −0.76pp | −0.73pp |
  | BR 穿 50(超賣)| 4,715 | +0.23pp | +0.01pp | −1.55pp |
  | AR/BR 雙低(底部)| 5,224 | +0.00pp | −0.07pp | **−1.88pp** |
  | AR 位階 ≥90% / ≤10% | 11,971 / 13,171 | −0.24 / −0.06pp | −0.55 / −0.11pp | −0.56 / −0.53pp |

  ❌ **7 個情境全部不成立**,邊際都在雜訊範圍(±0.5pp)內,而且**「超賣可買」方向跟傳統說法相反**
  (AR<50 的 60 日勝率 22.5% vs 基準 26.1%;AR/BR 雙低 −1.88pp)。
  ⛔ **不做 ARBR**,也別因為「書上都這樣寫」再評估一次。
  ⭐ 這跟 `volstall`/`volseq`(連次量)是同一類:**傳統技術指標的門檻多半沒有實證來源**。

- ⭐⭐ **唯一真正值得借鏡的是一個「邏輯」而不是指標**:它的 `smart_monitor.db` 有
  `ai_decisions` 表,欄位含 `executed` / `execution_result` —— **設計了「回頭驗證 AI 判斷」**,
  但實際上 116 筆全是 `executed=0`、`execution_result=None`,**從來沒真的驗過**。
  → 本專案可以做得比它好,而且**做得成**:V72.4.2 起深度診斷的 `invalidate` 欄位
    (「收盤跌破季線 179.78」)本來就是**可自動驗證的單一條件**。
  ⚠️ **但 AI 的歷史判斷沒存過 → 不能回算**(違反「要馬上就能用」鐵則)。
  ⭐ **可以馬上做的是回測純公式那半**:`_playbookMode`(低檔布局/區間操作/順勢做多/先不做)
    是純公式 → **完全可回算**,可以直接回答「程式說順勢做多時,後續 20 日報酬是多少?說先不做時呢?」
    —— 這是驗證**我自己的功能準不準**,比再加一個沒驗證過的指標有價值得多。⏳ 尚未做。

**⏳ 唯一可評估的候選(尚未做,要先有資料才談)**:
- **投資時鐘四象限**(成長方向 × 通膨方向)本身是**純公式可算**的,它只是實作方式錯了。
  我已有 `business_signal`(景氣對策信號分數)+ `m1b_yoy`,缺通膨那條腿。
  ⛔ **但現在做不了**:`risk_history.json` 只有 **26 筆**、而且 `business_signal` 欄位
  **有欄位但 0 筆有值**(又一次「欄位存在 ≠ 有資料」,同 V72.1.6 的教訓)→ 無法回測。
  → 先把上面那個抓取 bug 修好、讓燈號真的存進 `risk_history`,累積滿 1 年再談,
    **⛔ 在那之前不准上任何四象限卡**(不然又是一個沒驗證過的預測性主張)。
- **庫藏股**:權證小哥那次評估寫「⛔ 無庫藏股公告資料源」。它用問財撈得到 → 至少證明
  這類資料在別的市場是結構化公開的。台灣的「買回本公司股份」也是 MOPS 公告項目,
  而 `insider_miner.py` 已經在打 TWSE OpenAPI。⛔ 沙箱連不到 TWSE **無法驗證**,
  要做就寫一支 `buyback_probe.py` 丟 Actions 跑、先列端點清單,別憑猜的加欄位。

### 📚 外部參考資料的評估紀錄④:權證小哥兩份直播逐字稿(2026-08-04)
使用者上傳【台股止跌了嗎(真反彈還是誘多)】+【神祕分點建倉清單】兩份逐字稿,
問「怎麼運用、放在程式哪裡」。代理逐字讀完 + 探針實測,結論存這裡免得重讀。

**⚠️ 三個「標題 vs 內容」落差(以後看到標題別假設內容)**:
① 標題寫「外資」但全程**沒講外資買賣超**(講的是投信停損/分點/融資維持率)
② 標題寫「鎖碼」但他本人**沒講過這兩個字**(逐字稿的「標的股」是「飆」的辨識誤字)
③「神祕分點」**全片沒有定義**,開場講一次後全改口「關鍵分點」。

**✅ 他講的方法,本專案幾乎都已經有(對照後不用做)**:
關鍵分點低檔布局(=V71.9.8 關鍵分點,他的元大文英新安案例就是「低檔大買」)、
融資維持率(=V72.0.3 全市場維持率 + `_marginCallState`,他只給案例 109 沒給門檻)、
集保戶數暴增(=V71.9.7 四因子的股東人數項)、價籌背離(=主力動向/籌碼乾淨度)、
CB 轉換價 parity(=V71.9.1)、處置聽牌/連兩天第一款(=官方 attention 卡)、
折數比較「打幾折」(=位階溫度計,郭哲榮那份也同族)。

**⭐ 唯一給明確數字門檻的指標已實測落地:「乖離年線 200% 撐不久」**
`bias240_probe.py`(2,227 檔、扣同期加權、事件=向上穿越門檻、去重 20 日):
| 桶 | 10日邊際 | 60日邊際 |
|---|---|---|
| 150~200% | −0.64pp | **−3.61pp** |
| 200%+(n=135)| +0.03pp | **−6.24pp**(中位 −17.9% vs 基準 −11.7%)|
→ **短線(10/20日)完全沒有邊際**(勝率還比基準高 —— 動能還在,看到 200% 就空會被軋);
**60 日才顯現壓力** → 落地成 `_detectBias240`(warn,150% 以下不顯),
文案明寫「中期別重壓的提醒,⛔ 不是放空/立刻賣的指令」。他自己也是配處置/弱勢時機才空。

**⛔ 不做(缺資料源或無法定義,別再評估一次)**:
- 庫藏股實施「前」分點先買(他最看重的一招)→ **無庫藏股公告資料源**
- CB 到期年化殖利率(成德/佐登玩法)→ `cb_overview.json` 只有轉換價,**無賣回價/到期日/CB市價**
- 盤中停損單(「內外盤差很多、一直砍內盤」)→「差很多」無定義,且需逐筆歷史
- 雙刀配對(空處置買同族群)→ 處置系統 V70.3.1 已下架,別重建
- 「離開下軌的紅K」/「布林平行 vs 壓縮」→ 他自己判定都靠目視(「有點像」「只差沒離開」),無法程式化
- 他的全方位選股參數(主5/10/20>0+月線斜率低=剛起漲)→ 概念=飆股雷達已有;分點日史不足無法回測,不另開榜

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
| **D2** | **關鍵欄位缺漏**(V72.2.6):檔案在、能解析、不算空,但**該有的那半沒有** | `market_stats.json` 只有 `pb` 沒有 `margin` —— 融資維持率從 V72.0.3 到 V72.2.1 **一次都沒產出過**,而 A/C/D 三類全部放過它(A 覺得檔案沒問題、C 沒有 error 可報、D **只檢查 macro_risk.json**) |
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

### 🆕 V72.2.6 新增 D2:「檔案在,但少了該有的那半」
⛔ 兩個刻意的設計,**別改**:
- **用明確清單 `EXPECTED_KEYS`,不自動推導前端讀哪些欄位** —— 自動推導誤報一大堆,
  而誤報留著就會讓人養成忽略體檢輸出的習慣(同 `SUPERSEDED` 清單的理由)。
- **有寫 `*_error` → ⚠️;沒有 error → ❌** —— 前者代表守門刻意擋掉並留了原因(陷阱 #22 的正確做法),
  後者才是真的查不出「算不出來」還是「根本沒跑到」(陷阱 #9)。
⚠️ 新增任何「一個檔裡有多個**互相獨立**區塊」的採礦產物時,記得加進 `EXPECTED_KEYS`。

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
| 8 | 權證溢價率 | ⛔ 仍無資料源(V73.4.0 實測:`TaiwanWarrantPrice`/`TaiwanStockWarrantInfo` 全 422 = 名字不存在)| 別再猜 dataset 名了 |

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

## ⏰ V72.9.0 ⭐⭐ 本專案最重要的一次執行面發現:**有效進場點只有「訊號日尾盤」**
使用者要求「每晚挖礦推薦個股,開盤買點到了就大力提醒我」。
照探針先行鐵則,先驗「每晚推薦 → 隔天買」到底行不行 —— **結果推翻了整個規劃**。

`scripts/portfolio_backtest.mjs` 加 `ENTRY` 參數(close / nextopen / nextclose / nextopen_lim),
同一套邏輯、同樣的股票、同樣的打法,**只改進場時機**(600 檔・13 個月・本金 100 萬):

| 進場方式 | 賺到的錢 | vs 0050(+832,500) | 最大回撤 | 每趟 |
|---|---|---|---|---|
| ⭐ **訊號日尾盤買** | **+1,361,088** | **多賺 528,588** | −9.4% | +1.96% |
| 隔天開盤買 | +818,734 | **少賺 13,766** | −19.1% | +1.31% |
| 隔天收盤買 | +731,380 | 少賺 101,120 | −14.8% | +1.15% |
| 隔天開盤・跳空>2% 不追 | +494,340 | 少賺 338,160 | −25.0% | +0.78% |
| 隔天開盤・**跳空>1% 不追** | **−147,644(倒賠)** | 少賺 980,144 | **−36.4%** | −0.25% |

⭐ **真因**:打法的判定條件全部用**當天收盤價**算(收盤站上5MA/突破頸線/破昨高)
→ 隔天開盤時那個突破**已經被跳空反映掉**,跳空吃掉的就是全部利潤(每趟 −0.65pp)。

⭐⭐ **最反直覺、也最該記住的一條:「跳空太多就不追」實測最慘。**
聽起來很有紀律,但**跳空開高的那幾檔正是後來走最遠的** → 濾掉之後剩下「訊號出了但市場不買單」的弱股
= **專挑爛的買**。⛔ 別再提議加「不追高」濾網(同 V72.0.1 漲停隔日動能:高週轉才強)。

⛔ **落地限制(⛔ 別「優化」掉)**:
- 尾盤掃描時窗 **13:00~13:28**,⛔ 不可改成開盤或整天掃 —— 09:30 站上去、13:20 又掉下來的**不算數**。
- 盤中是**精確重算**(把今天這根 K 的真實開/高/低 + 即時價當收盤,接上歷史呼叫
  `_playbookPatternDefs().test()`),⛔ 不是拿昨晚的估計觸發價比大小。
- **推播每天最多 6 檔** —— 全市場可能上百檔觸發,全推 = 使用者三天後關通知 = 整套失效。
- 量的單位一律走 `_volToLots`(JSON 是**股**、Fugle 即時是**張**,V72.4.3 就是兩邊各判一次才出包)。
測試 `scripts/test_pbwatch.mjs` 33 條(①a 把「明天開盤買」這種指令釘死不可出現)。

### 🎯 `playbook_scan.mjs` / `playbook_edge.json` —— 選股基準的修正(差 38 倍)
🚨 **既有的 `today_signals.json` 用錯排序基準了**:它排的是「**全市場**該型態的平均期望值」,
而同一個型態當天幾十檔一起觸發、**分數完全一樣**(實跑輸出裡 6533/2101/6782/3022 全是 `exp=0.207`)
→ 等於在亂挑。實測同一支回測腳本只換排序基準:
   全市場型態平均 → **+35,491 元**(576 筆有 **479 筆**押同一招)
   **這一檔自己**的成績 → **+1,361,088 元**(分散在 21 種打法)

→ 新增 `playbook_scan.mjs`(每晚 19:00 獨立 workflow,⛔ 不併進 daily_miner —— 要跑 20-25 分):
   對全市場每一檔跑 `_patternFitBacktest()`,只收「**扣掉來回成本 0.44% 之後仍為正**且樣本 ≥8」的招。
⭐ **觸發價怎麼算**:⛔ 不替 22 種型態各寫一份公式(那就是第二份真相)——
   把「明天那根 K」合成出來(平盤開、收在 P)接上歷史,**直接問偵測器本人** `p.test()`,
   P 由低到高粗掃 + 二分細修 → 找出剛好會觸發的最低價。任何打法都適用。
⚠️ 那是**估計值**(明天真正的開高低未知);盤中會用真實開高低 + 即時價重算,以那次為準。

⛔ **兩份清單不可合併也不可互相取代**(問的問題不同):
   `today_signals` = 今天出現了哪些**全市場統計上**有效的訊號(⚠️ 收盤後才產出 → **已經來不及買**);
   `playbook_edge` = **這一檔自己**最會賺的那一招明天漲過多少觸發(⭐ **還來得及**)。

⚠️ **workflow 兩個坑已避開**:① playwright 路徑改**程式自己判斷**(`await import` fallback +
   `fs.existsSync` 判 executablePath),⛔ 不再用 `sed` 改原始碼 —— 我的 `launch()` 是多屬性,
   sed 掉一行會留下 `{ , args: … }` 語法錯,而且 workflow 全綠只有這支靜默失敗(陷阱 #9 同型)。
   ② 產物**同時推 gh-pages 與 data 分支**,否則明天 daily_miner 的 orphan force-push 會抹掉。

### 💰 `_lotsForRisk(price, stop)` —— 「該買幾張」全 App 唯一一份公式
原本只寫在 `_renderPositionSizer` 裡面。明日作戰清單也要算張數 → 照陷阱 #37
(共用工具寫好了卻只接一處)當場抽出來 + 兩邊都接上,測試 ④ 釘住「⛔ 不可有第二份 inline 公式」。
⚠️ 沒填 `settings.accountSize` 一律回 `{acc:0}` 並由呼叫端顯 CTA,⛔ 不可自己編一個本金。

### 📌 V72.9.1 紀律追蹤 —— **出場提醒⛔ 不限量**(跟進場相反)
使用者:「如果我依照紀律撤退就好」「叫我守好紀律」。
⭐ **為什麼出場比進場重要,這不是感覺是數字**:勝率只有 30~33%,十次錯七次 ——
整套會賺**完全靠**「錯的時候小賠出場」。
→ **進場提醒每天最多 6 檔**(錯過還有下一次);**出場提醒⛔ 一律不限量、也不受 13:00 時窗限制**
  (錯過一次就是住套房;少提醒的代價遠大於多提醒)。停損用 30 分鐘分桶重複提醒,直到標記已出場。

⛔ **`took` 初始必須是 `null`,⛔ 不可預設成「你買了」** —— App 不知道你有沒有真的下單。
   對著使用者沒有的部位喊停損,幾次之後他就不信這個提醒了(比不提醒更糟)。
   → 收到買點提醒 → 記一筆待確認 → 使用者按「我買了 / 沒買」才決定要不要盯。
⚠️ 停利用的是**回測同一條規則**(跌破 5MA),⛔ 別另立一套;金額走共用 `_netPL`。
測試 `scripts/test_pbwatch.mjs` ⑧(合計 44 條)。

### 📐 V72.9.2 ⭐⭐ 「排期望值取前面」= 保證挑到僥倖股(第一次全市場實跑抓到)
`playbook_scan` 首跑(2,317 檔)輸出的**第一名**是:
`每趟 +17.63% ・賺賠比 12.63 ・勝率 41.7% ・只有 24 次`;第八名 `賺賠比 28.83 ・10 次`。
🚨 那不是實力,是**選樣偏誤** —— 2,317 檔 × 22 招 ≈ 5 萬個組合,排「平均最賺」取前面,
前段班**必然**被「樣本少、剛好很賺」佔滿(陷阱 #27「1÷1 也是 100%」的大規模版)。
⚠️ `n >= 8` 這種**固定樣本門檻擋不住**這件事 —— 它只擋掉 n<8,擋不掉「n=10 但變異超大」。

⭐ **正解:排序與門檻都改用「保守下界」** `expectancy − 1.28 × sd / √n`(約 90% 信心下緣)
—— 打過越少次、波動越大,罰得越重。`_patternFitBacktest` 因此加回 `sd` 欄位(向後相容,既有呼叫端不受影響)。

📊 修前 vs 修後(同一份資料):
| | 首名 | 候選檔數 |
|---|---|---|
| 排原始期望值 | 每趟 +17.63%・**24 次** | 509 檔(碰到 300 上限) |
| ⭐ 排保守下界 | 每趟 +2.61%(下界 +1.14%)・**16 次** | 收斂到合理範圍 |

⛔ **門檻與排序要一起改** —— 只改一邊等於沒改(測試 ⑤a3 釘住)。
⭐ **通用鐵則:任何「掃全市場 → 排名 → 取前 N」的功能,都不可以直接排點估計值**
(平均報酬、勝率、期望值都一樣)。⛔ 固定樣本門檻不夠,要用**會隨樣本數變嚴的下界**。
同族:`_winRateConfidence`(勝率)、`_wrEnough`(樣本)—— 這條是它們在「排名」情境的版本。

⚠️ 同版順手修兩個**只有實跑才看得到**的顯示 bug(⛔ 靜態測試抓不到):
① `loose`(不是靠價位觸發)那 37 筆被寫成「**漲過 168.26**」而現價 **179** —— 叫人漲過一個
   比現價低的數字,而且 `stop = trig×0.95` 變成離現價 **−11%**(不是 −5%)。
   → `trig` 給 `null`、停損改用**現價**當基準,顯示改講「這招不是靠價位,盤中重算才知道」。
② 收盤價出現 `42.04999923706055`(浮點尾巴)→ 輸出前 `toFixed(2)`。
③ (V72.9.3,**第二輪實跑才浮出來**)二分搜尋算出的觸發價**比現價還低** 6 筆
   (現價 179 卻寫「漲過 168」)。語意其實是「照現在的價位明天就已經符合」,
   但寫成「漲過 168」會被讀成「等它跌回去再漲上來」—— **方向完全相反**,
   而且 `stop = trig×0.95` 又變成離現價 −11%。→ `b2 <= c0` 一律當「沒有價格閘門」。
⭐ 這三個都印證「**第一次實跑一定要人工讀輸出**,別只看 rc=0 跟檔案大小」;
⭐⭐ 而且 ③ 是**修完第一輪之後才露出來的** —— 資料類的修正要**連續驗兩輪**,
   第一輪的大問題會遮住第二輪的小問題。

④ (V72.9.4,**第三輪**)最後 1 筆「現價 90.1 → **漲過 90.1**」= 零資訊
   (二分結果只比現價高 0.0004,`toFixed(2)` 之後就一樣了)。
   同時發現觸發價**沒對齊台股跳動單位**(50~100 跳 0.1、100~500 跳 0.5…)→ 89.97 那種價**掛不出去**;
   而且用 `toFixed`(四捨五入)會把價格修到**比真正的門檻低**,等於叫人在條件還沒成立時就買。
   → 一律 **無條件進位到跳動單位**,進位後沒真的高於現價就當「無價格閘門」。

⑤ (V72.9.5,**第四輪**)⛔ 上一輪的守門**自己有浮點漏洞**:`c0=16.65` 時進位算出
   `16.650000000000002` → 通過了 `up <= c0` 的檢查,但**存檔前 `Math.round` 又變回 16.65**
   → 畫面照樣出現「現價 16.65 → 漲過 16.65」。
   ⭐⭐ **守門必須驗「將會被存下來 / 顯示出去的那個值」,⛔ 不可驗中間值。**
   (同族:V72.0.8「顯示的 % 與由它換算的金額必須自洽」—— 都是「驗算用的數字 ≠ 使用者看到的數字」。)
   同版順修:進位後可能**跨到另一個跳動單位級距**(498 → 501 從 0.5 檔進到 1 元檔)→ 再對齊一次。

⑥ (V72.9.6,**第五輪還是同一筆**)⛔ 上一輪只把**一邊**換成顯示值:
   `upR` 是 round 後的 `16.65`,但拿去比的 `c0` 還是**原始浮點** `16.649999618530273`
   → `16.65 <= 16.6499996` 為 false,守門放行;而輸出的現價寫 `+c0.toFixed(2)` = **16.65**
   → 畫面兩邊都印 16.65。
   ⭐⭐⭐ **比較的「兩邊」都必須是使用者會看到的那個值 —— 只換一邊等於沒換。**
   ⚠️ 而且輸出與守門要用**同一個取整式子**(`toFixed` 與 `Math.round` 在 .005 邊界結果不同)。

⭐⭐ **五輪下來的通用結論:凡是「要給使用者拿去掛單的價格」,都必須**
   ① 對齊該市場的**跳動單位**(不然掛不出去)② **朝保守方向進位**(買價往上、賣價往下 ——
   四捨五入會系統性地讓條件變鬆)③ 進位後**重新檢查它是否還有意義**(跟現價差不到一檔 = 沒說)——
   ⚠️ 而且這個「重新檢查」要用**四捨五入之後**的值,不然浮點會讓它漏掉。

📊 修完三輪後的全市場實況(2026-08-07 收盤,2,317 檔):
候選 **159 筆 / 144 檔**、今天已觸發 112 筆、**1,653 檔(71%)一招都沒有** ——
「大部分股票沒有值得做的打法」本來就該是常態,⛔ 清單很短不是壞事。

### 🧪 V72.9.7 ⭐⭐ 實測六種「提高勝率」的方法 —— **全部讓你賺更少**(使用者問「有沒有算籌碼」)
使用者:「你有把籌碼的策略也算進去嗎?…我要提高勝率」。

**① ⛔ 籌碼現在加不了 —— 先量再下結論(291 檔樣本)**
| 欄位 | 有值天數(每檔 764 根 K 線裡) | 最早 | 完全沒有的檔數 |
|---|---|---|---|
| `foreign_net` | 中位 **28** | 2026/05/07 | 16/291 |
| `trust_net` | 中位 **0** | 2026/05/11 | **203/291** |
| `margin_balance` | 中位 **19** | 2026/05/14 | 74/291 |
| 分點 `hist` | **3 天** | — | — |
回測窗口是 **486 天** → 加籌碼濾網只能驗最近 3 個月、而且全落在下跌段。
⏳ 等 `foreign_net` 滿 1 年(約 2027/05)再重跑。⛔ 在那之前別做。

**② 實測六種變體(600 檔・13 個月・本金 100 萬,只改一個條件)**
| 設定 | 賺到的錢 | 回撤 | 勝率 | 每趟 | 筆數 | 報酬/回撤 |
|---|---|---|---|---|---|---|
| ⭐ **原版(不加濾網)** | **+1,361,088** | −9.4% | 33.2% | +1.96% | 695 | 14.5 |
| 🏛️ 大盤站上月線才做 | +1,240,531 | **−6.6%** | 32.0% | **+2.36%** | 525 | **18.7** |
| 💧 只做成交值 ≥1 億 | +1,053,560 | −16.6% | **36.6%** | +1.59% | 662 | 6.3 |
| 🤝 至少 2 招共振 | +858,533 | −15.9% | 31.4% | +1.31% | 653 | 5.4 |
| 🍱 分散成 6 檔×5 萬 | +735,938 | −18.4% | 32.8% | +1.07% | 1381 | 4.0 |
| 🏛️ 月線 + 樣本≥12 | +739,177 | −11.5% | 32.0% | +1.44% | 513 | 6.4 |
| 🆚 0050 買進放著 | +832,500 | −15.9% | — | — | — | 5.2 |

⭐⭐ **三條可以帶走的結論**:
1. **「提高勝率」是錯的目標。** 💧 那行勝率 +3.4pp 卻**少賺 307,528 元**、回撤還惡化 7.2pp ——
   濾掉小型股 = 濾掉跑最遠的那幾檔。同族:V72.9.0「跳空>1% 不追」倒賠、
   V72.0.3「42 個 A 級訊號有 36 個期望值是負的」。
   ⛔ 以後看到「勝率變高」先問「總獲利呢?」
2. ⭐ **分散成 6 檔反而最差(−63 萬)→ 反過來證明排序是有效的。**
   若排序沒鑑別力,多挑幾檔應該差不多;結果挑到第 4~6 名就明顯拉低 →
   per-stock 期望值排序真的在做事。⛔ 別「為了分散」放寬每天檔數。
3. **唯一值得給選項的是大盤月線**(風險調整後 18.7 vs 14.5),但它是**取捨不是變強**
   —— 少賺 12 萬換回撤少 2.8pp。⛔ **不做成自動濾網**,只在清單上標事實 + 那組數字,
   讓使用者自己決定(`mktLine`)。

⚠️ **方法論自我提醒**:一次測 6 個變體、挑出「其中一個看起來不錯」本身就有多重比較問題。
大盤月線的機制講得通、回撤與每趟同方向改善,所以列為選項;⛔ 但總獲利確實是掉的,
不可以宣稱它「比較強」。

### 📅 V72.9.8 分點加到 20 日 + ETF 經理人動向開始存(使用者:「資料不夠的直接挖礦」)
**① 分點 10 日 → 20 日**(使用者:「籌碼分點請增加日期,現在只有10日」)
⭐ **之所以做得到,關鍵是 V71.2.6 的「單日全市場批次」** —— 省略 `data_id` 只給日期,
一次呼叫拿回**該日全市場**所有分點 → 加深 N 天只是多 **N 次**呼叫,⛔ **不是 N × 2,653 次**。
⛔ 沒發現這件事的話會誤以為「加深 10 天要多 2 萬次 API」而放棄。

改動集中在 `miner.py` 檔頭四個常數(⛔ 別再散在五處各寫一個數字):
`CHIP_DAYS=22`(批次抓幾個交易日)・`CHIP_HIST_KEEP=22`(每檔 hist 保留)・
`CHIP_PERIODS_HOT=(1,3,5,10,20)`・`CHIP_PERIODS_COLD=(1,3)`;前端 `app._CHIP_FEN_PERIODS` 對齊。
⚠️ 前端原本在 `_renderBrokerFenDian` 裡**寫了兩份**同樣的週期陣列(按鈕 + 「哪些週期有資料」),
只改一邊會出現「按鈕有 20 日、但判斷漏掉它」→ 已抽成常數(陷阱 #37)。

⛔ **量過才改,兩個代價都寫下來**:
① **體積**:實測 hist 每天每檔約 **1.38 KB**(2330),chips 總量 **39.2 MB → 約 53 MB**
   (gh-pages 已用 388MB / 上限 1GB)。⛔ **別再往 60 天推** —— 那要 **+140 MB**,
   而且前端每開一次個股籌碼頁要多下載 3 倍(83KB → 250KB)。
   要更深的歷史一律走 **`bstat`**(V71.9.8 增量聚合,深度無上限、體積固定)。
② **時間**:多 11 次批次呼叫(每次 timeout 180s)。
⏳ 20d 那格要**累積約兩週**才完整;在那之前顯示端已有誠實空狀態(`_availP`),⛔ 不給半截數字。

**② ETF 經理人動向 `mgr_hist` 開始存**
🚨 使用者問「ETF 跟單策略有沒有用」→ 查下來發現**根本驗不了**:
`consensus_stocks.shares_delta` 是「今天 vs 上一版快照」的差,**算完就丟**;
`etf_tracking.json` 的 `hist` 存的是**規模/折溢價,不是持股變動**(實測只有 3 天);
而且主動式 ETF **2025/05 才上市** → 過去也回算不出來(PCF 每日公布但沒存過)。
→ ⭐ 這是**「現在不存、以後永遠沒有」**的那一類 → 立刻開始存,滾動 250 個交易日。
⚠️ 體積:只存**有異動**的股票 `[代號, 張數變化]`,實測 54 檔 × 250 日 ≈ 300 KB。
⚠️ **累積型欄位必查「workflow 有沒有先還原舊檔」** —— 已確認 `deploy` job 的
`git archive origin/data`(L319)排在 `python etf_miner.py`(L398)之前 → 接得起來。
⛔ 沒確認這步的話會每天歸零,而且**完全沒有錯誤訊息**(同 V72.5.1 集保深檔的教訓)。
⛔ **前端不顯示** —— 沒驗證過的東西不上;累積約 3 個月後跑第一次探針。

**③ ⛔ 籌碼(外資/投信/融資)沒得挖,只能等**
跟上面兩個不同:那兩個是「我們沒存」,這個是「**上游本來就只從 2026/05 才有**」——
`foreign_net` 中位 28 天、`trust_net` **203/291 檔完全沒有**、`margin_balance` 中位 19 天。
⛔ 不是採礦頻率或程式的問題,加挖也變不出過去的資料。⏳ 等到約 2027/05。

### 🤖 V72.9.9 半自動交易三件套 + 🔐 **下單程式絕不可進 CI**(使用者:永豐金證券)
**🔐 最重要的一條(已寫成守門,納入四驗證第 2 項)**
本 repo 是 **public** → GitHub Actions 的 log/artifact 有外洩風險,而且任何能改 workflow
的人都能把 Secrets 印出來。而下單需要「**電子憑證 .pfx + 密碼 + 身分證字號**」=「代表本人動錢」。
⭐ **分界:行情可以在雲端跑(現在就是),下單只能在自己的電腦跑。**
→ `scripts/check_workflow_paths.py::check_no_trading_in_ci()` 擋 `auto_trade.py` 與
  `SJ_CA_*`/`PERSON_ID` 出現在任何 workflow;**已用「故意塞進去」自我驗證過**(rc 1→0)。
⛔ 這是純粹靠人記不住的規則 → 一定要有守門,別只寫在文件裡。

**三個層級(使用者三個都要,依風險由低到高做)**
| 層級 | 做了什麼 | 風險 |
|---|---|---|
| 📋 條件單複製 | `_copyCondOrder(sym)` 一次複製 代號/觸發價/停損/張數/最多虧多少元 | 零(不碰下單權限) |
| 📒 實盤成績記錄 | `_pbMark` 問**實際成交價**、`_pbClose` 問**實際賣價** → `_pbScoreHtml` 比對回測 | 零 |
| 🤖 本機自動下單 | `auto_trade.py`(Shioaji,預設 `simulation=True`) | 真錢 |

⛔ **條件單那條必須寫時點落差**(測試 ⑨a 釘住):回測 +1,361,088 元是「**尾盤**買」算的,
條件單是「**觸價就買**」—— 可能 09:30 就成交,**那個時點沒測過**。
參考:隔天開盤買只剩 +818,734 元(還輸 0050)→ 進場時點影響非常大。

⛔ **實盤記錄一定要問「實際成交價」,不可拿觸發價充數** —— 那會把**滑價藏起來**,
讓實盤看起來跟回測一樣好,這份紀錄就失去全部意義(它存在的理由就是量出兩者的差)。
⏳ `_wrEnough`(10 筆)以下一律不下結論。

**`auto_trade.py` 的安全設計(⛔ 別「優化」掉)**
`LIVE` 預設 False(`simulation=not LIVE`)・憑證只走環境變數・`MAX_LOTS_PER_TRADE` /
`MAX_AMT_PER_TRADE` 硬上限・時窗鎖 13:00~13:28・**送出後立刻寫狀態檔**(寧可漏一次也
⛔ 不可重複下單)・`trig is null` 的一律**跳過**(本機沒有 App 那套偵測器可以重算,
⛔ 不可用「差不多的條件」代替 —— 那是另一個沒驗證過的策略)。
測試 `scripts/test_pbwatch.mjs` ⑨(合計 72 條)。

### 🚪 V72.9.9 出場方式實測(14 種變體總結)—— ⛔ 維持原版
進場濾網六種全失敗後,測出場(600 檔・13 個月・本金 100 萬):
| 出場 | 賺到的錢 | 回撤 | 每趟 | 筆數 | 報酬/回撤 |
|---|---|---|---|---|---|
| ⭐ **現行 破5MA/20天** | +1,361,088 | **−9.4%** | +1.96% | 695 | **14.5** |
| 破20MA/40天 | **+1,586,079** | −21.0% | +2.96% | 535 | 7.6 |
| 移動停利 8% | +1,286,315 | −16.0% | **+3.18%** | **404** | 8.0 |
| 破5MA/40天 | +1,340,083 | −9.6% | +1.93% | 694 | 13.9 |
| 破10MA/20天 | +1,097,192 | −20.4% | +1.94% | 566 | 5.4 |
| 破20MA/40天 + 大盤月線 | +1,088,668 | −14.5% | +2.60% | 418 | 7.5 |
| 移動停利8% + 大盤月線 | +1,073,797 | −9.6% | **+3.56%** | 302 | 11.2 |

⭐ **這是唯一有東西賺贏原版的方向**(出場放寬 +22 萬)→ 證實「問題在出場不在進場」,
符合體質(勝率 33%、靠少數大賺,5MA 太敏感會把贏家洗掉)。
⛔ **但不改預設**,三個理由:
① 多賺 22 萬換回撤 **翻 2.2 倍**(−9.4% → −21.0%),風險調整後 14.5 → 7.6;
   −21% 是很多人會在最低點放棄的水位,放棄就一毛都拿不到。
② 🚨 **窗口是大多頭(0050 +83%)→「抱久賺更多」是多頭專屬**,空頭會反咬,
   而 5MA 出場正是空頭的保護傘 —— **這 13 個月沒有空頭可以驗證**。
   ⭐ 所以這個結論比進場濾網的**更不可靠**(依賴行情類型)。
③ 賺錢月份反而變少(8/13 vs 10/13),更顛簸更難堅持。
⚠️ **混用又一次更差**(兩組都是)→ 累計 14 種變體,**混用沒有一次贏過單獨用**。
⚠️ 已測 14 種變體 → 多重比較問題要主動講,⛔ 不可因為某組數字漂亮就改預設。

### ⭐⭐ V73.0.0 一天只做 **2 檔** —— 27 次實驗裡**第一次「沒有任何一項變差」**
`portfolio_backtest.mjs`(600 檔・13 個月・本金 100 萬・資金使用率都是 89~92%,比較公平):

| 每天挑幾檔 | 賺到的錢 | 回撤 | 每趟 | 筆數 | 報酬/回撤 |
|---|---|---|---|---|---|
| 1 檔×30萬 | +1,720,402 | −13.0% | +2.57% | 223 | 13.3 |
| ⭐ **2 檔×15萬** | **+1,718,529** | **−9.31%** | **+2.47%** | 463 | **18.5** |
| 現行 3 檔×10萬 | +1,361,088 | −9.39% | +1.96% | 695 | 14.5 |
| 6 檔×5萬 | +735,938 | −18.4% | +1.07% | 1381 | 4.0 |

⭐ **單調趨勢**(6→3→2 越集中越好),而且 **2 檔賺得跟 1 檔一樣多但回撤最小**
—— 1 檔少了分散,回撤反而變大 → **2 檔是甜蜜點**。
⭐⭐ 這反過來**證明 per-stock 打法排序真的有鑑別力**:挑到第 3 名以後就在拉低成績。
→ 尾盤推播上限 6 → **2**(掃 8 檔但最多推 2 則,因為不是每檔都會真的成立)。

#### ⚠️⚠️ 同版最該記住的一課:**單獨測有效 ≠ 合起來還有效**
停損從 `min(低點, −5%)` 改成固定 **−3%**,在「每天 3 檔」下:
`+1,476,423`(多賺 115,335)、回撤 −9.39% → **−6.89%**,而且 −3% > −5% > −8% > 2ATR **單調**
—— 看起來是鐵板釘釘的改善,我差點就要改預設。

**但跟「每天 2 檔」合起來測就翻了**:
| 2 檔 × | 賺到的錢 |
|---|---|
| 停損現行 `min(低點,−5%)` | **+1,718,529** |
| 停損 −4% | +1,681,883 |
| 停損 −3% | +1,489,522(**少賺 229,007**) |
| 停損 −2% | +1,155,032 |

→ 那個「改善」**不是獨立的**,它只是在補償「3 檔時挑到較差標的」的問題;
  而「只做 2 檔」已經從源頭解決了。⛔ **停損維持原樣。**
⭐ 通用鐵則:**任何參數改善都要跟「已經確定要改的那個」合起來再測一次** ——
  ⛔ 不可把各自單獨測出來的最佳值直接疊起來(累計 27 種變體,**混用沒有一次贏過單獨用**)。

⚠️ **多重比較的自我提醒**:累計已測 27 種變體。「2 檔」之所以敢採用,是因為
① **單調**(不是單點異常)② **全面改善**(賺更多 + 回撤更小 + 每趟更高,沒有取捨)
③ **機制講得通**(排序有效 → 少而精;但 1 檔失去分散)。
⛔ 其餘 25 種只要是「取捨」或「單點好看」的,一律不改預設。
⚠️ 窗口仍是大多頭(0050 +83%),空頭未驗證。

### 🚨 V73.0.1 「該買幾張」算錯了 —— 回測用等權、App 用風險法,**兩套不同**
⚠️ 這不是新實驗,是補一個**真正的對接落差**:前面所有回測都用 **等權**(每筆固定金額),
但 App 的 `_lotsForRisk` 用 **風險法**(單筆最多虧帳戶 1%,單檔上限 25%)→ 每筆金額浮動。
⛔ **「買 N 張」這個 App 直接叫使用者照做的數字,從來沒被回測過。**

📊 補測(600 檔・13 個月・本金 100 萬・每天 2 檔,**只改部位大小**):
| 部位大小 | 賺到的錢 | 回撤 | 每趟 | **資金使用率** |
|---|---|---|---|---|
| ⭐ **等權**(每筆 15 萬 = 本金 15%) | **+1,718,529** | −9.31% | +2.47% | **92%** |
| 風險法 1%(= App 原本給的) | **+593,234** | −9.15% | +1.26% | **59%** |
| 風險法 2% | +517,418 | −13.54% | +1.26% | 51% |

⭐⭐ **關鍵:風險法的回撤沒有比較小**(−9.15% vs −9.31%)→ **不是取捨,是單純比較差**
—— 少賺 1,125,295 元**沒有換到任何安全性**,而且**輸給 0050 買進放著**(+832,500)。
真因:停損寬的時候風險法只買很少張(甚至 0 張)→ 資金長期只用到 **59%**,
四成的錢一直在睡覺;而且它把錢壓在「停損很近」的標的上。

→ `_lotsForPlaybook()`(等權 15%)接上**清單 / 尾盤推播 / 條件單複製**三處。
⛔ **刻意不跟 `_lotsForRisk` 共用**(⛔ 別為了「統一」改回去):
   `_lotsForRisk` 回答「這檔用 ATR 風控該買幾張」(通用);
   `_lotsForPlaybook` 回答「照這套**實測過的**打法該投入多少」。兩個問題不同、答案不同。
⚠️ 等權的代價是「每筆風險 % 會浮動」→ 顯示端誠實寫出「這筆停損會虧本金的幾 %」,>2% 提醒減量。

#### 🚨 順帶抓到的真 bug:**函式被呼叫但根本沒定義**
改檔腳本中途 `assert` 失敗 → 只寫進了**呼叫端**,`_lotsForPlaybook` 的定義沒寫進去。
⚠️ **`smoke_test` 抓不到** —— 沙箱沒有 playbook 資料,那段程式根本不會執行。
是 `test_pbwatch` 的靜態斷言擋下來的。
⭐ **通用:新增共用函式要同時驗「定義存在」與「呼叫端都接上」,只驗其中一邊會漏。**
⭐ 而且**改檔腳本失敗要看 rc** —— 我當時看到 `AssertionError` 卻因為後面 smoke_test 綠燈就過了。

#### 🚨 同版第二次犯陷阱 #37:改了 App 卻**忘了改會下真單的那支**
`auto_trade.py` 還留著 `lots_for_risk`(風險法)—— 也就是說使用者走到階段 5 用真錢時,
部位大小會用**已經被證明少賺 112 萬**的那套。⚠️ 而且它是三處裡**唯一會動到真錢**的。
→ 改成 `lots_for_playbook`(等權 POS_PCT=15)、`MAX_PICKS` 3→2、
  停損風險 >2% 印警告;`docs/AUTO_TRADE_SETUP.md` 的過期數字一併更新。
⭐ **通用:改「該買幾張 / 該賣多少」這類參數時,清單一定要含 `auto_trade.py`** ——
  前端錯了是顯示錯,那支錯了是**真的下錯單**。測試 ⑨p~⑨r 已釘住。

### 📦 V73.1.1 網頁 / PWA / APK 三環境區分(使用者要求「區分 PWA 及 APK」)
- **`app._runtimeEnv()`** 回 `'apk' | 'pwa' | 'browser'`。⛔ **判斷順序不可換**:
  APK(TWA)也符合 PWA 的 standalone 條件 → 一定要**先**判 APK 再判 PWA。
  APK 的三個線索:① `document.referrer` 是 `android-app://…`(⚠️ **只有啟動那一頁看得到**
  → 一看到就寫 localStorage `proTerm_env_apk` 記住)② 打包時 start_url 設 `?source=twa`
  ③ localStorage 記號。PWA:display-mode standalone / `navigator.standalone`(iOS)/ `?source=pwa`。
- 設定中心版本號旁 `#envBadge`(🌐/📱/🤖),`openSettings()` 每次重算(init 那次在多個 await
  之後,沙箱等不到 → 兩處都接;⚠️ 測試走 openSettings 那條路)。
- **APK = TWA 包裝**:⛔ 不是第二套程式 —— 三種環境載同一份 index.html,push 即同步更新,
  APK **不需要**重新打包。打包用 PWABuilder,見 `docs/APK_BUILD.md`
  (Package ID `io.github.xin7355collab.stockai`,⚠️ 要跟 assetlinks 一致)。
- **`.well-known/assetlinks.json`**(APK↔網站互認,沒它 APK 頂端會有網址列;fingerprint 是
  placeholder,等使用者 PWABuilder 打包後回填)已接進**兩條**部署路徑,各**四步缺一不可**
  (paths 觸發/暫存/放回/`git add`)—— 漏 `git add` 的話「暫存放回了但沒 commit」→
  **每天被 daily_miner 洗掉且零錯誤訊息**(陷阱 #9 同型)。測試 `scripts/test_envdetect.mjs` ②cd 釘住。
- 測試 `scripts/test_envdetect.mjs` 15 條(三種環境實跑各驗一次 + 部署佈線)。

### 📅 V73.2.0 行事曆效應全測 —— **13 種全部不採用**(使用者問「週五容易跌/法說會/月份/結算見轉折」)
`scripts/calendar_probe.mjs`(只讀探針)+ `portfolio_backtest.mjs` 的 `CAL` 濾網。
交易層級 **181,908 筆**、組合回測 600 檔・13 個月・每天 2 檔・本金 100 萬。

**❌ 使用者的三個直覺,實測全部不成立**
| 直覺 | 實測 |
|---|---|
| 禮拜五比較容易跌 | ⛔ **不成立**。大盤週五 **+0.060%**,最差的是**週一 −0.119%**;交易層級週五與其他天差 **0.05pp = 雜訊** |
| 結算見轉折 | ⛔ **不成立**。反向檢定「**只**在結算日做」每趟 **+2.92%(全表最高)** → 兩邊都好 = 不是方向訊號 |
| 月份效應 | ⛔ **驗不了**(2 年 ⇒ 每個月份只有 **2 個樣本**)。⚠️ 4 月 +0.835% 只是「去年 4 月剛好漲」 |

⭐ **週一那格特別值得記**:平均 −0.119%(最差)但**中位 +0.182%(正的)**
→ 是「**偶爾重摔**」不是「**常常跌**」。⛔ 這兩件事不可混談,做成濾網會濾掉一堆小漲換掉少數大跌。
⚠️ 而且**大盤層級與交易層級方向相反**(大盤週一最差、交易層級週一第二好;結算日亦然)
→ ⭐ 通用:**「大盤那天漲跌」跟「這套打法那天賺不賺」是兩回事**,別用前者推後者。

**⛔ 法說會沒有資料源** —— FinMind 無行事曆、MOPS 無免費結構化 API。
只能用**財報公布截止日**(3/31・5/15・8/14・11/14)近似,⛔ **那不是法說會**,別在文案裡混稱。

**📊 組合回測 13 種變體(基準 +1,127,315 元 / 回撤 −14.35% / 每趟 +1.69%)**
| 濾網 | 賺到的錢 | 回撤 | 每趟 | 判定 |
|---|---|---|---|---|
| 🚫 結算日不做 | +1,257,848 | −15.28% | +1.96% | ⛔ 見下方穩健性檢定 |
| 🚫 下旬(21日後)不做 | +1,221,813 | **−14.03%** | **+2.76%** | ⛔ 同上 |
| 🚫 週五不做 | +1,138,663 | **−18.18%** | +2.01% | ❌ 多賺 1% 換回撤惡化 3.8pp |
| 🚫 長假前不做 | +1,104,110 | −15.67% | +1.72% | ❌ 反而略差 |
| 🚫 財報期不做 | +941,475 | **−12.35%** | +1.56% | ❌ 少賺 19 萬換回撤 −2pp |
| 🚫 週一不做 | +894,854 | −14.72% | +1.62% | ❌ |
| 🚫 **上旬(1-10)不做** | **+188,452** | −14.52% | +0.44% | 🚨 慘賠 94 萬 |
| ⭐ 只在中旬做 | +245,671 | −10.75% | +1.17% | ❌ |
| 混用(nolate+nofin+nohol) | +964,359 | −10.81% | +2.61% | ❌ **混用又一次更差** |

**⭐⭐ 決定性的穩健性檢定:拿掉「差最多的那一個月」之後還贏嗎?**
```
noset   總差額 +130,533 → 2026-04 貢獻 +200,092 → 拿掉後 −69,559  ⛔ 靠那一個月
nolate  總差額  +94,497 → 2026-04 貢獻 +140,605 → 拿掉後 −46,108  ⛔ 靠那一個月
```
→ **兩個「贏」的濾網,edge 全部集中在同一個月,拿掉就由正轉負。⛔ 不採用。**
⭐ 這條檢定應該變成**日後所有濾網實驗的標準關卡** —— 比「總獲利有沒有變多」嚴格得多,
   而且成本是零(每月損益本來就有)。⚠️ 唯一通過的是 nofri,但它的總 edge 只有 +1%
   而回撤惡化 3.8pp → 通過穩健性 ≠ 值得採用,兩個條件要同時滿足。

**🚨 順帶照出一件比濾網重要得多的事:獲利集中度**
基準 13 個月裡**只有 5 個月賺錢**,而**最賺的 3 個月合計佔總獲利 105%**
(2025-11 +32萬 / 2026-04 +41萬 / 2026-06 +44萬)。
→ ⭐ 真正的槓桿不是「哪一天不進場」,而是「**能不能在那 3 個月押大、其餘月份縮小**」。
⛔ 但那需要**事前**判斷得出來(regime/波動率),而 regime 濾網已測過:少賺但回撤更小(取捨)。
⚠️ 也代表**回測那個 +112% 極度依賴少數幾個月** —— 換一段行情就不會長這樣。

**🐛 順手修一個會白等 3 分鐘的靜默 bug**:`TRADES_CACHE` 載入用
`allTrades.push(...j.trades)`,267,418 筆會**爆呼叫堆疊**,又被 `try/catch` 吞成
「快取讀不起來」→ 默默重掃。⭐ 通用:**`push(...arr)` 對大陣列會爆**,一律逐筆 push;
而且 `catch` 一定要把 `e.message` 印出來(⛔ 靜默 fallback 會讓人以為快取有生效)。

⚠️ **多重比較的自我提醒**:本節一次測 13 種切法 —— 本來就會有 1~2 種看起來不錯。
累計已測 **40 種**變體(27 種部位/出場 + 13 種行事曆),**採用的只有「每天 2 檔」一項**
(它是唯一「單調 + 全面改善 + 機制講得通」的)。⛔ 別因為某組數字漂亮就改預設。

### 📰 V73.9.0~V73.9.2 國際新聞沒翻譯 —— 真因是 **Groq 模型被下架**,而且修了兩層才好

使用者:「國際新聞挖礦的時候就先翻譯」。⭐ 查下去發現**它本來就設計成採礦時翻譯**,是壞掉了。

🚨 **一個 404 打掉三件事**,因為它們全在 `analyze_sentiment` 的**同一個** Groq 呼叫裡:
| 欄位 | 後果 |
|---|---|
| `title_zh` | 國際新聞標題**完全沒翻譯**(而前端寫著「標題已由採礦機翻成中文」)|
| `sentiment` | 全部退回「中立」,判讀等於沒有 |
| `important` | 失敗時**預設 `True`** → 垃圾新聞全部放行(實測混進「美國某地回收廠火災」「MacKenzie Scott 捐款」)|

⭐⭐ **診斷線索就寫在資料裡**:`radar_news.json` 每一則的 `ai_reason` 都是「**API 錯誤 404**」。
   ⛔ 但那句話**看不出真因** —— 404 的語意是「這個模型名字不存在」,不是金鑰壞、不是額度用完。
   `universal_radar.py` 寫死 `llama-3.1-8b-instant`,Groq 已經下架它。

⛔ **第一個直覺(換一個新 slug 寫死)是錯的** → 照 V73.8.0 對 OpenRouter 的做法,
`groq_common.py` 問官方 `GET /openai/v1/models`、用**正規表示式偏好序**挑、404 時自我修復。
⚠️ 陷阱 #37:`macro_miner.py` 同樣寫死,一起接上;而 `check_undefined_py` 當場抓到我漏改的
一處 `GROQ_MODEL_MM` —— ⭐ 那正是它存在的理由(採礦端 NameError 會被 `except` 吞掉,workflow 照樣綠)。

#### 🚨🚨 修好之後**要再驗一次** —— 第一層的大問題會遮住第二層的
實跑確認 404 消失了(有一則拿到真實判讀),⛔ **但 15 則裡有 14 則變成 400**,畫面對使用者**一模一樣**。
真因:`response_format: json_object`(嚴格 JSON 模式)下,輸出被 `max_tokens: 180` **截斷**
→ 不是合法 JSON → Groq **直接回 400**(⚠️ 不是回 200 配半截內容)。換模型之後輸出變長就會踩到。
→ 三件一起做(⛔ 只調 max_tokens 是把賭注押在單一假設上):
① 180 → 500(是「輸出上限」不是花費)② **400 → 拿掉 `response_format` 再打一次**,自己撈 JSON
③ 🔍 **把對方回的原文一起寫進 `ai_reason`** —— job log 會過期,只印 log 的話下一個人還是只看得到一個狀態碼。

⭐ **通用鐵則**:① 看到「API 錯誤 <碼>」這種訊息,先問**它到底是哪一類錯**(碼要翻成白話,`groq_reason()`)。
② **資料類的修正要連續驗兩輪**(同 V72.9.3)—— 只看到「404 不見了」就宣告修好,使用者看到的畫面沒有任何改變。
③ 🔐 只印「第幾把 key」,⛔ 絕不印 token(repo 是 public)。
測試 `scripts/test_groqmodel.py` 36 條(含實跑自我修復),已用 6 種注入缺陷自我驗證。

### 📊 V73.9.1 美股巨頭財報日 —— **新聞是發生後才知道,財報日可以提前知道**
使用者:「輝達財報還有重點新聞,還有 google 等等巨頭的,沒有抓到資料」。查證後**三件都屬實**:
| # | 缺口 |
|---|---|
| ① | `TECH_GIANTS_SOURCES` **只有 4 桶**(trump/黃仁勳/SpaceX/Kuiper)—— 沒有 Google/微軟/Meta/博通,也**沒有財報桶** |
| ② | `GLOBAL_NEWS_SOURCES` 全是「公司/人名」導向,**沒有一條是財報導向** |
| ③ | 行事曆 742 筆**全是台股法說會**,⛔ 一場美股財報都沒有 |

⭐⭐ ③ 價值最高,而且是使用者沒說到的角度:**輝達財報當晚台股 AI 鏈整條會跳,
提前兩天知道才來得及調部位;等新聞出來,台股已經反映完了。**
`fetch_us_earnings()`(macro_miner,12 檔 × 未來 21 天,走 yfinance 零額外金鑰)。

⛔ **三條不可改掉的設計**:
① **標 `us_earn` 旗標**,⛔ 不靠關鍵字比對 —— 前端把 `/法說|earnings/` **整批收進摺疊區**
   (免得 742 場淹掉核彈事件),但輝達財報對台股是**宏觀等級**,不該被一起埋掉。用旗標,文案改字才不會失效。
② **每一場都附台股對應族群** —— 只寫「NVDA 財報」沒有可操作性,要寫
   「看 AI 伺服器鏈(廣達2382・緯創3231・鴻海2317・台積電2330)」。
③ 沙箱連不到 Yahoo → **只能在 Actions 驗**,所以它自己要說得出「用哪條路拿到的」與失敗原因。
   ✅ 實跑印「4 場(來源:`{'calendar.dict': 4}`)」**失敗欄位是空的**
   → 12 檔全部解析成功,其餘 8 檔只是**視窗外**(Google/微軟/蘋果都在 10 月底)。
   ⭐ 那條統計正好分得出「抓失敗」與「視窗外」—— ⛔ 沒有它只會看到「怎麼只有 4 場」然後亂猜。
測試 `scripts/test_usearnings.py` 20 條(5 種注入缺陷驗過)。

---

### 🚀 V73.8.0 OpenRouter「HTTP 404」= 模型被下架,⛔ 不可再寫死 slug
使用者截圖:財經行事曆每一列都顯「⚠️ AI 例外:OpenRouter HTTP 404」。
⭐ **404 的語意是「這個模型名字不存在」** —— ⛔ 不是金鑰壞、不是額度用完。
免費模型的 slug 會改版/下架(`deepseek-r1:free` → `deepseek-r1-0528:free` 這類),
而 slug 被**寫死在 4 個地方** → 一改版整條 AI 鏈掛掉,而且畫面只寫「HTTP 404」看不出真因。

⛔ **第一個直覺(換一個新 slug 寫死)是錯的** —— 那只是把同一顆地雷往後埋。
⭐ 照本專案「**讓官方自己說**」的做法(同 `_taifex_list_endpoints` / FinMind 資料集名那兩次):
`_orModel(key)` 去問 `/api/v1/models` 現在**實際有哪些**,用 `_OR_MODEL_PREFS`
(**正規表示式偏好序**,免費 R1 → 付費 R1 → 其他推理型 → 任何 deepseek)挑,⛔ 不比對固定字串。

⭐⭐ **而且會自我修復**:`_orChat()` 是全 App 唯一入口 —— chat 回 404 → 清快取 →
重新解析 → **換一個模型再打一次**。下次上游再改版,App 自己就接上了。

⛔ **三個必須留著的保險(⛔ 別「簡化」掉)**:
① 解析失敗 → 退回**上次成功過的**(localStorage)→ 再退回 `_OR_MODEL_LEGACY`
   —— **絕不能比改版前更糟**(⛔ 不可 throw、不可回 undefined)
② 快取 **24 小時**就好(模型下架是常態,不可永久快取)
③ 一個都配不到時,把它**實際有的 deepseek 清單**印出來 —— 不然下一個人只能重新猜一輪
   (這正是「只寫 HTTP 404」害我們查半天的原因)

🗣️ **錯誤訊息白話化**(V26.18 鐵則):`_orErr(status)` 把光禿禿的狀態碼翻成
「模型被下架 / 金鑰無效→設定中心 / 額度用完 / 用量到上限 / 對方忙碌」,⛔ 各碼不可同一句。

⚠️ **順手抓到寫死的還有 3 處**(`_pingOpenRouterKey` / `_callDeepAI` / `_callAI` 第三鏈)
—— 又是陷阱 #37。全部接到 `_orChat`;⚠️ `_callAI` 那處**指定輕量 8b**,
`_orChat` 支援「呼叫端指定模型」且它 404 時一樣會換(`pinned` 分支)。
⛔ **別在別處自己 fetch** `openrouter.ai/.../chat/completions` —— 測試 ⑥ 會擋。

⚠️ 沙箱連不到 openrouter(proxy 403)→ 測試一律 **stub `safeFetch`**,
每組都有**空過守門**(斷言 stub 真的被呼叫到)。
測試 `scripts/test_ormodel.mjs` 21 條(已用「注入缺陷 → 確認叫得出來」自我驗證過)。

### 🌅 V73.7.6 台指期「比現股早開盤」—— 前提正確,但 App 早就有了,真缺口是別的
使用者:「新增期貨,因為期貨比現股早開盤,我覺得可以用來比對,給我建議或者有沒有說錯」。

#### ✅ 前提查證:**對的**
台指期 **08:45~13:45**(現貨 09:00~13:30)→ 早 15 分鐘開、晚 15 分鐘收;
**夜盤 15:00~次日 05:00** 涵蓋整個美股時段。⭐ 夜盤比那 15 分鐘重要得多。

#### ⚠️ 但「新增期貨」是誤會 —— App 裡早就有 6 處
`_liveIdx.txf`(Shioaji 快照,真報價真漲跌)・前端 Yahoo `^TXF=F`(每 30 秒,**只在大盤頁**)・
`taifex_tx_now`(採礦端 TAIFEX OpenAPI)・估算 fallback(加權+升貼水)・結算日倒數・
**盤前體檢已把台指期夜盤納入計分**。
→ ⭐ 所以問題不是「沒有」,是**陷阱 #32 的變形:功能存在但在別的頁**(使用者在自選頁看不到)。

#### 🚨 查下來的兩個真缺口(⛔ 都不是「新增期貨」能解的)
| # | 問題 | 實測 |
|---|---|---|
| ① | **順逆價差一半的日子是空的** | `risk_history.json` 36 天裡 `taifex_backwardation` 只有 **18 天**有值。根因:`taifex_fut_date`(官方每日期貨行情)**落後現貨 2 天**(實測 08-19 跑,期貨日期是 08-17)→ V71.4.9 的「兩條腿必須同一天」守門正確地擋掉 → 但那正是「期現比對」的核心指標。⚠️ V71.8.0 已修過「OpenAPI 沒設日期」那條,程式**有**抓日期 → 這次是**官方 API 真的回舊日期**,不是程式 bug |
| ② | **盤前 08:45~09:00 採礦端完全沒跑** | `live_snapshot.yml` cron 是台北 **09:00~13:30** —— 現貨開盤後才開始。⚠️ 而且 `live_snapshot_miner.py` 有 `MIN_STOCKS = 300` 守門(抓不到 300 檔就整份不產出)→ **盤前現貨沒開盤會把台指期一起擋掉**,所以「盤前也跑」⛔ 不是改 cron 就好,要先讓守門分開處理 `idx` 與個股 |

#### 📍 落地(V73.7.6,零風險那半)
`_preOpenFutWindow()` / `_renderPreOpenFut()` + 自選頁最上方一個容器(⛔ 沒新增卡片)。
⛔ **四條不可改掉的設計**:
① **只在台北 08:30~09:20 的平日顯示** —— 其餘時間大盤頁本來就有,⛔ 不重複佔版面。
② **資料兩層**:`_liveIdx.txf`(09:00 後才有)→ Yahoo `^TXF=F`(**盤前也有,且不吃 Fugle 額度**);
   兩層都沒有 → 整條不顯示。⛔ 刻意不用 Fugle(免費版 60 req/min 要留給個股)。
③ ⛔ **不顯示「期貨 − 現貨」的價差點數** —— 基差常態就有幾百到上千點,而順逆價差歷史只有 18 筆
   (沒有「平常是多少」的基準)→ 顯示它只會被誤讀成「大漲」。
④ ⭐ **必須寫出本站實測**:V72.9.0「隔天開盤買」比「訊號日尾盤買」**少賺 54 萬**、
   「跳空 >1% 不追」**倒賠** → ⛔ 期貨方向**不可**拿來決定要不要追。
   沒有這句的話,這條等於在鼓勵一件實測會輸的事。
⚠️ 拿不到可信基準時只顯價位 + 「方向待確認」(同 V72.0.5 美股期貨的處置)。
測試 `scripts/test_preopenfut.mjs` 22 條(⚠️ **stub 掉時間窗函式**,⛔ 不可等「剛好 08:45」才驗得到)。

### 🌅 V73.7.7 盤前台指期採礦 + 順逆價差探針(承 V73.7.6 查到的兩個缺口)
使用者:「A+B 都做」。

#### 【A】盤前 08:45~09:00 的台指期 —— ⛔ 關鍵是「不能為了盤前放寬守門」
**問題**:`live_snapshot.yml` cron 從台北 09:00 才開始;而且 `live_snapshot_miner.py` 有
`MIN_STOCKS = 300` 守門(抓不到 300 檔就整份不產出)→ 盤前現貨沒開盤,**台指期會被一起擋掉**。

⛔ **第一個直覺(放寬 MIN_STOCKS)是錯的**:那個守門是**盤中快照的自我保護**
(登入/行情異常時保留舊檔),而盤中快照是當沖頁的命脈 —— 放寬 = 讓垃圾覆蓋好資料。

⭐ **正解:盤前走完全獨立的路徑**
- `_is_premarket()`(台北平日 08:30~09:00)→ **只抓期貨、只寫 `live_index.json`**,
  ⛔ `live_quotes.json` 一個位元組都不碰;寫完直接 `return`(⛔ 不繼續跑全市場掃描)。
- 盤前也有**空過守門**:期貨沒抓到 → `exit 1`(⛔ 不寫空檔覆蓋前一輪)。
- 期貨抓取抽成 `_fetch_index_futures(api)`,盤前/盤中**共用同一份**(陷阱 #37)。
- workflow 加 cron `45,50,55 0 * * 1-5`(台北 08:45/08:50/08:55);
  部署步驟**依產出的檔名分流**(`live_index.json` → `data/live_index.json`)。
- ⚠️ 排程延遲到 09:00 之後才跑 → `_is_premarket()` 自動回 False,走一般模式(那時現貨已開,全市場掃才對)。

🚨 **前端必須有新鮮度守門**(⛔ 少了它就是陷阱 #34 的再犯):
`live_index.json` 會一直留在伺服器上 → **08:35 開 App(當天第一輪 08:45 還沒跑)會讀到昨天的期貨價**。
→ `_loadPreOpenIdx()` 只認「`updated` 是台北**今天** 且 **30 分鐘內**」,否則回 null 退到電子盤。
測試 `scripts/test_presnapshot.py` 23 條(⭐ 用假的 `datetime.now` 驗時間邊界,⛔ 不改系統時鐘)
+ `scripts/test_preopenfut.mjs` ⑨(新鮮度守門 5 條)。

#### 【B】順逆價差為什麼一半是空的 —— ✅ 探針查完了,**真因不是抓不到,是配對方式錯了**
🔬 **雲端實跑結果**(2026-08-20 11:05,`macro_probe.yml` → `which=taifex`):
| 項目 | 實測 |
|---|---|
| `DailyMarketReportFut` | ✅ **通了**,2,357 列 ・ TX 近月 `Last`=44612 ・`Change`=−476 |
| 它回的日期 | **2026-08-19**(當時是 08-20 **盤中**)→ 落後 1 天 = **正常**(每日行情要收盤後才更新) |
| 對照組①(匯率) | ✅ 通 → **機器連得到期交所**,立刻排除「被擋」這條路 |
| 其他候選端點 | 全部 HTTP 200 + `text/html`(陷阱 #23:不存在的路徑回網頁不是 404) |

🚨🚨 **真因**:現貨那條腿用 `^TWII.json` 的**最後一根**(當天下午就有),
期貨那條腿**天生落後 1 天** → 兩邊永遠對不上 → V71.4.9 的守門每次都擋掉 → 36 天只有 18 天有值。

⭐ **修法(V73.7.8)**:`^TWII.json` 有完整歷史 → **把現貨對齊到期貨那一天**,
價差標成「那一天的價差」(`taiex_date` 跟著變)。
⛔ **仍然沒有放寬守門** —— 對齊不到(期貨那天不在 `^TWII` 歷史裡)還是誠實回 None,
   而且錯誤訊息要寫「歷史裡沒有那一天(共 N 天)」而不是只寫「不同交易日」。
   差一天的價差是假的(V71.4.9 記過:期貨 41,613 配現貨 40,039 = +1,574 點假正價差)。
測試 `scripts/test_basis_legs.py` ⑧(5 條,含「對齊不到仍要留白」的反向驗證)。

⭐⭐ **這次最值得記住的**:我原本的假設是「官方 API 壞了/改名了」,**完全錯**。
   是**對照組**(一個已知會通的端點)在 15 秒內把方向掰回來的 ——
   ⛔ 沒有它就會往「再猜一次端點名」走(V73.6.1 櫃買指數卡五輪的原因)。

#### 【B-附】探針本身 —— `scripts/taifex_probe.py`(只讀)
`risk_history.json` 36 天裡 `taifex_backwardation` 只有 **18 天**有值。
症狀:`taifex_fut_date` = 08-17 而 `updated` = 08-19 → 守門「期貨與現貨不同交易日」正確擋掉。
⚠️ V71.8.0 已修過「OpenAPI 沒設日期」,程式**有**從回應抓日期 → **很可能是官方 API 真的回舊日期**。

⭐⭐ **探針的三個刻意設計(⛔ 別拿掉)**:
① **對照組** —— 清單裡放兩個「本專案一直在用、已知會通」的端點。它們也失敗 = **這台機器被擋**,
   ⛔ 不是端點改名。沒有對照組會往「再猜一次欄位名」走(V73.6.1 櫃買指數卡五輪的原因)。
   ✅ 沙箱實跑已驗證這條有作用:對照組全掛 → 探針直接說「是機器連不到,下面的失敗不能解讀成端點改名」。
② **HTTP 200 不等於成功**(陷阱 #23)→ 每一筆都印 content-type + 回應開頭。
③ **讓官方自己說有哪些端點** —— JSON parse 失敗時從 HTML regex 撈 `/v1/<Name>`。
掛在 `macro_probe.yml`(手動,加 `which` 選項:`taifex`(~15 秒)/ `macro` / `both`)。

⛔ **在探針查清楚之前,不可放寬「兩條腿必須同一天」守門** ——
差一天的價差是假的(V71.4.9 記過:期貨 41,613 配現貨 40,039 算出 +1,574 點假正價差)。
⭐ 可能的正解是「改標成**最後一個兩邊都有的交易日**」或「兩邊都改用即時價」,⛔ 不是放行。

### 💰 V73.7.5 本益比篩選 —— 🚨 「由低到高」實測是**輸**的,而且單調(⛔ 別再照直覺做)
使用者:「幫我做一個本益比,由低到高的篩選器,其中還要包含同族群相比有沒有比較便宜
還有財報等等我沒想到的比拚,看一下我有沒有說錯,還有推薦」。

⭐⭐ **歷史 PE 是重建得出來的**(這是 `scripts/pe_probe.mjs` 能成立的關鍵,⛔ 別以為只有快照):
`fund_yoy_gm.json` 的 `qeps`(每季 EPS + 期別)+ **財報公布日規則**
(Q1→5/15・Q2→8/14・Q3→11/14・Q4→隔年 3/31)→ 算得出任何一天「當時已公布」的 TTM EPS,
配日收盤價 = 歷史 PE,**完全沒有前視**。實測 **1,629 檔 × 12 個月 × 13,952 個事件**。

#### 🚨 結論一:PE 分位與後續報酬**單調反向**
| 全市場 PE 分位 | 最低20% | 20-40% | 40-60% | 60-80% | 最高20% |
|---|---|---|---|---|---|
| 20日超額(vs 對照) | **−0.69pp** | −0.44 | −0.06 | +0.38 | **+0.79pp** |
⭐ **越便宜越差**,而且最便宜那格前後半段都是負的(−0.65 / −0.73)。
⛔ 這跟本專案其他實測一致(V73.2.3 高位階+高波動、漲停隔日動能、跳空不追反而倒賠)——
   **台股這幾年是「追強」贏「撿便宜」**。⚠️ 但窗口整段偏多頭,空頭未驗證。

#### 🚨 結論二:「排序取最前面」必然挑到雜訊
`PE < 5` 那批:**前半段 +4.29pp / 後半段 −4.49pp**(完全相反)。
⭐ 實跑全市場本益比最低的 5 檔是 **1.84 / 2.45 / 2.49 / 2.58 / 2.92** ——
   那種數字幾乎都是**賣土地/賣股票的一次性業外收益**,⛔ 資料上分不出來。
   同族:V72.9.2「排點估計值必定挑到僥倖股」。

#### ⭐ 結論三:唯一有用的是「**價值陷阱**」= 低 PE **配營收方向**
| | 事件數 | 20日超額 | 勝率 | 前後半段 |
|---|---|---|---|---|
| 低 PE × 營收**衰退** | 1,359 | **−1.89pp** | **29.7%** | ✅ 一致(−2.16 / −1.65) |
| 低 PE × 營收**成長** | 2,572 | +0.18pp | 34.6% | ✅ 一致 |
| (對照組) | 13,952 | — | 32.9% | — |
⭐ **低 PE 本身沒用,搭配營收方向才有意義。** ⛔ 但「成長」那格扣掉成本 0.44% 後仍是負的
   → 只能當**避雷**用,⛔ 不可宣稱是選股法。

#### ⚠️ 使用者說的「同族群相比」實測**沒有邊際**
比同業便宜 4 成以上 +0.12pp,而且**前後半段不同向**;非單調(1.15~1.5 那格最差 −1.19)。
⛔ **但照做**(使用者明確要求)—— 資料照顯示,把實測數字寫在旁邊(同 `_SIGNAL_EDGE` 對 C 級的處置)。

#### 🚨 順手查到:`industry_pe.json` 的 `is_cyclical` **目前全部是空的**
0 個產業被標記 → 「景氣循環股低 PE 陷阱」這次**測不了**(桶樣本不足),
而且 App 裡那個旗標**現在沒有任何作用**。⏳ 要做要先讓採礦端真的標出來。

#### 📍 落地(V73.7.5,全在自訂選股頁,⛔ 沒新增卡片)
- **4 個排序**:本益比低→高 / 股價淨值比低→高 / 比同業便宜 / PEG 低→高。
  ⚠️ 後兩個是**衍生值**(不在 screener 欄位裡)→ `_SCR_SORTS` 支援 `vfn`。
- **10 個估值條件**(`s: '估值'`):相對同業便宜/貴、PB 相對便宜、PE 最低 30%、
  ⛔ 價值陷阱、⭐ 低 PE+營收成長、PEG<1、⛔ 配息率>100%(實測全市場 **1,002 檔**中招)、
  ⭐ 殖利率>4% 且配息率<80%(只有 **26 檔**)。
- **`_scrValNote()` 實測提醒**:⭐ **條件觸發** —— 只有用估值排序或勾估值條件才出現。
  ⛔ 不寫的話,這個篩選器等於在幫使用者做一件實測會輸的事。

⛔ **四條不可改掉的設計**:
① **null 一律不通過、也不可排在「最便宜」前面** —— `null < 15` 在 JS 是 true(V73.5.1 踩過),
   排序時 null 當 0 會讓「沒有本益比的股票」佔滿最便宜前段班。全部走 `_scrRelPe` / `_scrPeLow` 等 null-safe 函式。
② **「便宜」用全市場分位(最低 30%)**,⛔ 不寫死「PE<15」—— 跨產業一定判反。
③ **同業中位 PE 標明母體** —— 這裡是拿**本頁有官方產業別的上市股**自算(每產業至少 5 檔),
   而個股頁用 `industry_pe.json`,母體略有不同(實測最大差:半導體 31.8 vs 29.1)。
   ⛔ 不可只寫「產業中位 PE」讓兩邊看起來是同一個數字(同名不同義)。
④ **勾「價值陷阱」時要明說這張清單是「要避開的」**,⛔ 不可讓使用者以為是選股清單。
測試 `scripts/test_pescreen.mjs` 28 條(用**真實 screener.json**,含 null 陷阱與空過守門)。

### 🏭 V73.7.4 「缺貨 / 供貨 / 做夢行情」的時機 —— 七種狀態只有一種扣完成本還有剩
使用者:「個股漲跌時機紀錄到說明,比如說缺貨時、供貨時機、做夢行情!
把我說錯的沒有說到的去回測時間點,並在個股說明中列出,或者條件到了時候觸發說明」。

#### ⛔⛔ 為什麼**不用基本面**判斷「缺貨」(⛔ 別再試一次)
「缺貨 → 漲價 → 毛利率上升 → 營收 YoY 加速」觀念完全正確,**但回測不了**:
實測 `data/fund_yoy_gm.json` 的 `qeps` 只有 **8 季(2024-06 ~ 2026-03)、918 檔**
→ 算 YoY 要 q 與 q−4,只剩 **4 個 YoY 點**,而且全擠在同一段行情;
毛利率更慘 —— 只存了 **3 個點**的趨勢字串(`gmt`)。⛔ 拿 4 個點定義週期 = 憑空門檻。
⏳ 等 `qeps` 累積到 16 季以上(約 2028)再談。

#### ⭐ 改用「盤面看得到的樣子」(`scripts/regime_probe.mjs`,1,076 檔 × 3 年 × 68,082 事件)
| 使用者說的 | 可測代理 | 理由 |
|---|---|---|
| 缺貨/漲價行情 | **整條族群一起漲** | 漲價是整條供應鏈同步反映,不會只有一家 |
| 供貨/產能開出 | **整條族群一起跌** | 同上 |
| 做夢行情 | **族群沒動,只有它獨走** | 個別題材,沒有產業基本面撐 |
⭐ 我另外補了使用者**沒說到的**兩個:**族群剛由弱轉強 / 剛由強轉弱**(轉折)——
   因為「靜態狀態不是時機,**轉折**才是」。

**判準:門檻一律用當天的橫斷面分位**(⛔ 不寫死 +10%);報酬扣同期加權;
對照組 = 同一批(股·日)全部(⛔ 不抽樣);同檔同狀態 20 日去重;
關卡 = 前後半段同向 + **逐年同向** + **拿掉最好那一年** + **扣成本 0.44%**。

| 狀態 | 事件數 | 20日平均超額 | 保守值(去最好年) | 扣成本後 | 勝率 | 判定 |
|---|---|---|---|---|---|---|
| 🏭 族群齊漲・自己跟上 | 13,027 | +0.39pp | +0.16 | −0.28 | 36.0% | ❌ 逐年不一致 |
| 🐌 族群齊漲・自己落後(補漲) | 7,809 | +0.12pp | −0.05 | −0.49 | 34.4% | ❌ |
| ⭐ **🎯 只有它獨走(做夢)** | 8,999 | **+0.89pp** | **+0.67** | **+0.23** | **37.7%** | **⭐ 全關通過** |
| 📉 族群齊跌・自己也跌 | 12,466 | −0.25pp | −0.74 | −1.18 | 34.0% | ❌ |
| 💪 族群齊跌・自己逆勢強 | 7,230 | −0.13pp | −0.23 | −0.67 | 34.9% | ❌ |
| 🌅 族群剛由弱轉強(轉折) | 9,030 | +0.66pp | **+0.11** | −0.33 | 36.6% | ⚠️ 靠 2026 一年(+3.96) |
| 🌇 族群剛由強轉弱(轉折) | 9,521 | −0.22pp | −0.53 | −0.97 | 34.2% | ❌ |
(對照組:260,383 個股·日 ・ 20 日平均超額 −1.78% ・ 中位 −3.09% ・ 勝率 34.7% ・ 賺賠比 1.23)

#### 🚨 唯一通過的「做夢行情」是**賠率型不是勝率型**(⛔ 文案必須寫)
| 20 日超額分布 | P10 | P25 | 中位 | P75 | P90 |
|---|---|---|---|---|---|
| 🎯 獨走 | **−15.76** | −9.70 | **−3.16** | +4.24 | **+15.15** |
| (對照) | −13.68 | −8.36 | −3.09 | +2.44 | +9.94 |
⭐ **中位跟平常一模一樣**,平均 +0.89pp **全部來自右尾** → 多數被打回原形、少數大賺。
⛔ 只講「平均 +0.89%」會讓使用者以為每次都賺 → 落地文案一律同時給中位與 P10/P90,
   並寫「**不能重壓**」。(同 V72.0.3 的教訓:勝率/平均高 ≠ 每次都賺。)

#### ⭐ 三個跟直覺相反、值得記住的
1. **「補漲候選」實測沒有邊際**(+0.12pp,拿掉最好年份變 −0.05)——
   落後有可能是還沒輪到,也可能它本來就比較弱,**兩種混在一起**。
2. **「族群在跌它還撐著」不是抗跌強勢股**,實測之後**略差**(−0.13pp)—— 多半是還沒補跌。
3. **「轉折」比「狀態」漂亮但更脆弱**:族群剛由弱轉強全期 +0.66pp,
   但 2026 一年就 +3.96、其餘三年只有 +0.07~0.55 → 拿掉最好那年只剩 +0.11,扣成本後是負的。

#### 📍 落地(V73.7.4)
`_stockRegime()` / `_stockRegimeHtml()` + `_REGIME_EDGE` 常數,掛在 **K線頁 K棒戰法卡**
(⛔ 沒新增卡片)。⭐ 選 K線頁的理由:那頁**刻意只解讀、不給買賣價位**(V72.1.4),
正好符合「這不能當進出場訊號」的定位。
⛔ **四條不可改掉的設計**:
① **母體必須跟回測一致** —— 只用「有官方產業別」的 **1,075 檔**算全市場分位。
   實測 `screener.json` 的 `ind` 剛好也只有那 1,075 檔(與 `industry_map` 完全對齊)。
   ⛔ 不可拿 screener 全部 2,356 檔去算(那是不同母體 = 回測數字不能用)。
② **上櫃股要誠實說「判斷不了」** —— 證交所產業分類只涵蓋上市。
   ⛔ 靜默不顯示的話使用者會以為壞了(「沒有資料」與「條件沒過」是兩件事)。
③ **K 棒沒訊號時這條仍要顯示** —— `renderKbarTactics` 的 `if (!sigs.length)` 原本直接
   `return` 並把整張卡收起 → 那條會變成「剛好有 K 棒訊號的日子才出現」= 隨機出現,不是條件觸發。
④ **screener 是非同步載入的** → 第一次進個股頁算不出來,要載完重繪;
   ⚠️ 必須有 `_regLoading` 旗標,⛔ 否則 load 失敗會無限重繪(同 V68.9.2 分點那個無限迴圈)。
⚠️ **轉折那兩個前端做不了**(screener 是單日快照,沒有 20 日前的產業分位)——
   反正它扣成本後是負的,不做正好。
測試 `scripts/test_regime.mjs` 36 條(用**真實 screener.json**,含空過守門「五種狀態至少命中 3 種」)。

### 📅 V73.7.3 財經行事曆 **37 種**逐檔全測 —— 方向 0 個可用,但「顛不顛」是真的
使用者:「財經行事曆部分有很多種類,幫我用回測方式,計算出漲跌機率,還有漲多少還是跌多少,
當然個股不同有不一樣的結果」。`scripts/calendar_stock_probe.mjs`(只讀探針,8 秒,⛔ 不打 API)。

⭐⭐ **這跟 V73.2.0 那 13 種行事曆濾網不是同一個問題,⛔ 別把結論互推**:
   那次問「拿行事曆當**打法的濾網**,總獲利會不會變多」(答案:13 種全部少賺);
   這次問「**每一種日子本身**的漲跌機率與幅度是多少」。同族前例:地板股 300+ 對大盤有邊際、
   混進個股打法卻少賺 98 萬。

**樣本**:2,055 檔 × 757 個交易日(2023-06 ~ 2026-08)= **155 萬個(股·日)**;
37 種切法(星期一~五・月初月底・上中下旬・季初季底・期貨結算日/前/後/週・長假前後・
封關開紅盤・月營收公布日・財報截止日±3・12 個月份)。
⛔ **無資料源、刻意不做**:法說會・庫藏股公告・MSCI 換股名單・除權息日・FOMC/美國經濟數據・選舉。

#### ❌ 方向:一個能用的都沒有
| 判準 | 結果 |
|---|---|
| 天數層級檢定 + 前後半段同向 + 逐年同向 | 37 個裡通過 **1 個**(結算日後一交易日 +0.334pp) |
| ⭐ **成本關卡** | +0.334pp 扣掉來回 0.44% = **−0.106pp** → 白做 |
| ⭐ **期外驗證**(2021-08~2023-06,個股樣本沒涵蓋到) | **方向相反**(−0.078pp) |
| ⚠️ 多重比較 | 37 次檢定,光靠運氣就會有約 **1.9 個** p≤0.05 → 通過 1 個 = 完全在預期內 |

⭐ **「禮拜一比較容易跌」再一次被證明是誤讀**(V73.2.0 在大盤層級已測過一次,這次個股層級重現):
星期一**平均** −0.138%(最差)但**典型日** +0.172%(比其他日的 +0.135% 還好)
→ 是「**偶爾重摔**」不是「**常常跌**」。⛔ 這兩件事的做法完全不同,不可混談。

#### ⭐ 波動:確實有,而且**機制只有一個**
| 休市間隔 | 天數 | 平均波動 | 相對 |
|---|---|---|---|
| 1 天(隔天) | 584 | 1.639% | 1.00x |
| 2-3 天(週末) | 152 | 1.788% | **1.09x** |
| 4-5 天 | 18 | 2.337% | **1.43x** |
| 6 天以上(長假) | 3 | 2.214% | 1.35x |

⭐⭐ **單調遞增 → 「星期一比較顛」與「長假後比較顛」是同一件事**(休市累積的消息一次反映完),
⛔ **不可當成兩個獨立發現**(那會讓多重比較的問題看起來比實際小)。
另一組:**月初 1-10 日 1.13x**(z=2.55)/ **月營收公布日 1.15x**(z=2.17)—— 資訊密集期。
⚠️ 4 月 1.50x 但只有 3 年,而且 2024/04 中東、2025/04 關稅 → ⛔ 當特例不採用。

📍 **落地**:`_calDayVol()` / `_calDayVolHtml()` 掛在**當沖頁 hero 成本關卡正下方**(⛔ 沒新增卡片),
命中才顯示。⛔ **只講顛不顛、不講多空、不用紅綠**(波動大 ≠ 會漲也 ≠ 會跌),
給的是「停損容易被掃到,部位放小一點」。測試 `scripts/test_calvol.mjs` 22 條。

#### 🚨 逐檔「這檔喜歡星期幾」—— **算得出來,但學不到**
使用者的直覺(個股各有各的日子)在**描述**上完全成立:
4587 星期五只有 23% 上漲、平均 −1.12%;3595 星期五 48% 上漲、平均 +0.99%。
⛔ **但那不會延續**:把每檔在前半段的表現排序、看後半段,最強 25% 減最弱 25% 只有 **+0.02~0.12pp**,
而**環狀位移對照**(把同一組日期整體平移到日曆別處)也會跑出同樣大小的數字 → 27 個裡只有星期三
超出雜訊(z=3.50),而它連 0.44% 成本的零頭都不到。
⭐ 對照組本身(不分日子,純看個股強弱延不延續)只有 **+0.004pp** —— 呼應 V73.2.3
「個股偏好哪種盤 4 種全滅」。⛔ **不可做成個股行事曆標籤。**

#### 🚨🚨 這支探針第一版有**四個「安靜地給出錯數字」**的缺陷(⛔ 寫下來免得再犯)
| # | 缺陷 | 後果 |
|---|---|---|
| ① | 窗口取 `^TWII` 的範圍(2021-08 起),但個股只有 2023-06 起 | 逐年檢定被 **2022 年那 85 列**殘尾決定(算出 +23.37pp 奪下「最好年份」)→ 那一關**等於沒作用**。⭐ 通用:**檢定期間必須跟實際樣本對齊**(同 V73.2.9 那次 0050 對照組消失) |
| ② | p 值用「股·日」當樣本單位 | 2,055 檔在同一天**不是** 2,055 個獨立樣本(全市場同漲同跌)→ p 值嚴重高估。→ 改成**天數**層級 |
| ③ | 日統計量用**中位數** | 全市場當日中位個股常常剛好 0.00%(跳動單位)→ **飽和在 0**,整排長一樣完全看不出差別。→ 改**等權平均** |
| ④ | 安慰劑用「隨機散落的日子」 | 「5 月」那 62 天是**擠成 3 塊**的,隨機抽的散落全窗口;相鄰日子的個股強弱本來就比較像 → **集中型事件天生贏過散落型安慰劑**。→ 改**環狀位移**(疏密結構不變,只打亂跟行事曆的對齊)。改完 星期二 z 從 2.37 掉到 1.86、4 月從 −2.58 掉到 −1.57 |
⭐⭐ 四個都**不會報錯**,只會安靜地把結論變樂觀 —— 全是**實跑後人工讀輸出**才抓到的(同「第一次實跑一定要人工讀輸出」)。

### 📊 V73.2.1 「特別的盤」13 種事件濾網 —— **全部少賺,而且前後半段都少賺**
使用者追問「有什麼特別的日子或事件適合推測成功率」。上一輪照出真問題是
「獲利集中在 3 個月」= **擇時問題**,所以這輪從「哪一天」轉到「什麼盤」。
資料源:`breadth.json` 250 天(漲跌家數/地板股 `flr`/中位數個股 `med`/指數 `idx`)+ `^TWII` 純算。
⛔ 全部用 **i-1(昨天)** 判斷 —— 尾盤 13:00~13:28 掃描時今天的家數還沒結算,用今天的 = 前視偏誤。

| 濾網 | 賺到的錢 | vs 基準 | 回撤 | 每趟 | 筆數 | 勝率 |
|---|---|---|---|---|---|---|
| (基準) | 1,127,315 | — | −14.35% | +1.69% | 445 | 29.9% |
| 🏔️ **不追高**(大盤距60日高<1%不做) | 1,012,639 | −114,676 | **−8.55%** | **+3.00%** | 225 | **36.0%** |
| 📊 廣度極弱不做 | 1,018,954 | −108,361 | −14.54% | +1.88% | 362 | 29.6% |
| 📅 季底最後5日不做 | 991,694 | −135,621 | −17.13% | +1.64% | 404 | 29.5% |
| 📅 月底最後3日不做 | 959,622 | −167,693 | −15.29% | +1.68% | 380 | 28.2% |
| 📉 昨天大跌>1.5%不做 | 897,637 | −229,678 | −13.30% | +1.48% | 404 | 29.2% |
| 🌊 只在高波動做 | 848,322 | −278,993 | −11.13% | +3.33% | 170 | 37.1% |
| 📅 長假後第一天不做 | 787,082 | −340,233 | −17.61% | +1.33% | 394 | 30.7% |
| 📉 **只**在昨天大跌後做 | 511,112 | −616,203 | **−2.30%** | **+6.55%** | **52** | 44.2% |
| 🏚️ **只**在地板股≥300後做 | 143,274 | −984,041 | −9.43% | +2.51% | **38** | 31.6% |

**⭐⭐ 決定性:前後半段各自檢定 —— 13 種**全部兩段都少賺**,沒有任何一個是「換個時期就會好」。**
```
nochase 前半 −107,385 / 後半  −7,291     onlyhivol 前半 −145,818 / 後半 −133,176
noqend  前半   −4,853 / 後半 −130,768     onlydrop  前半 −109,460 / 後半 −506,743
flr300  前半 −102,404 / 後半 −881,636
```

**⭐ 唯一值得留作「選項」的是「不追高」,但它是取捨不是變強**
少賺 11 萬(−10%)換回撤 −14.35% → **−8.55%(砍掉四成)**、每趟 +1.69% → **+3.00%**、勝率 +6.1pp。
風險調整後(賺到的錢÷回撤%)**78,559 → 118,437**。
⚠️ 但**兩個紅旗**:① 它砍掉**一半**的交易日,而窗口是大多頭(0050 +83%)→ 高度可能是這段行情特有
② 它跟已測的 `regime`(**只**在大盤月線之上做)**邏輯相反**,兩個都「有效」= 過度配適的典型徵兆。
→ ⛔ **不做成預設**,比照大盤月線的處置:只在清單上標事實 + 數字,讓使用者自己決定。

**⚠️ `flr300` 特別要澄清(⛔ 別跟 V72.4.9 混為一談)**
V72.4.9 實測的是「地板股家數 300+ → **大盤**未來 5/10/20 日 +1.5pp」,
這裡測的是「**這套個股打法**在那之後進場」—— **兩個是不同的問題**,前者成立不代表後者成立。
實測只有 38 筆、少賺 98 萬。⭐ 通用:**大盤層級的擇時訊號,不能直接假設對個股策略也有效**
(同一節「大盤週一最差、交易層級週一第二好」那個方向相反的例子)。

**⛔ 沒有資料源、⛔ 別再評估**:法說會・庫藏股公告・MSCI 換股名單・除權息日
(`data/*.json` 只有 OHLCV+籌碼,無除權息欄位)・FOMC/美國經濟數據行事曆・選舉。
**⛔ 樣本永遠不夠**:股災週年、選舉年 —— 1~2 次,驗不了。

⚠️ 累計已測 **53 種**變體(27 部位/出場 + 13 行事曆 + 13 事件),**採用的只有「每天 2 檔」一項**。
⭐ 這個比例本身就是結論:**「少做一點」幾乎必然少賺**,因為獲利集中在少數幾個月,
   任何濾網都是在賭「那幾個月不會被濾掉」。真正有效的是**選得準**(per-stock 打法排序)
   與**押得夠集中**(每天 2 檔),⛔ 不是「哪天不做」。

### 🎯 V73.2.2 「能不能做成每天的進出場預測?」—— **不能當閘門,只能當事實標籤**
使用者問:「這些檢測能不能變成前一天及當天提醒我要不要做的預測?」

**⭐ 先把上一輪的矛盾解開**:濾網實測「砍掉差的環境反而少賺」,原因是
**差的環境每趟還是正的**(貼著波段高 +0.86%、佔 218/445 筆)→ 砍掉它就是砍獲利。
→ ⭐ **「這種盤比較不好賺」≠「這種盤不該做」**,這兩件事全 App 都不可混談。

**📊 實際成交的 445 筆依當天環境分格(⛔ 全部用昨天的資料,無前視)**
| 環境 | n | 每趟% | 勝率% | 前半/後半是否同向 |
|---|---|---|---|---|
| 大盤**回檔 >5%** | 72 | **+4.96** | 43.1 | ✅ 一致(2.54/5.34) |
| 大盤小回 1-5% | 155 | +1.34 | 30.3 | ✅ 一致 |
| 大盤**貼著60日高** | 218 | **+0.86** | 25.2 | ❌ |
| 昨天上漲家數 **<40%** | 217 | **+2.71** | 32.3 | ✅ 一致 |
| 昨天上漲家數 40-60% | 180 | +0.68 | 26.7 | ✅ 一致 |
| 昨天**地板股 <50 檔** | 101 | **−1.24** | **18.8** | ✅ 一致(−0.98/−3.62) |
| (基準) | 445 | +1.69 | 29.9 | — |
⭐ 三格前後一致且機制一致:**這套打法在「市場剛被打過」時最賺,在「平靜/創高」時最差**
(型態多半是突破/反轉,需要波動與恐慌後的反彈)。

**⚖️ 於是測「不做閘門、改調部位大小」—— 首度出現「賺更多 + 回撤更小」**
| 部位縮放 | 賺到的錢 | 回撤 | 每趟 | 筆數 |
|---|---|---|---|---|
| (基準) | 1,127,315 | −14.35% | +1.69% | 445 |
| 地板股<50 減半 | **1,267,112** | **−13.41%** | **+1.82%** | 465 |
| 兩者相乘 | 1,161,235 | **−12.54%** | +1.68% | 462 |
| 回檔深押大 | 1,143,284 | −15.32% | +1.68% | 454 |

**🚨 但兩道穩健性關卡全部沒過 —— 而且真因是同一個月**
```
sc_flr  總差額 +139,798 → 2026-04 就貢獻 +183,941 → 拿掉後 −44,143;前半 −22,654 / 後半 +162,452
sc_both 總差額  +33,920 → 2026-04 貢獻  +96,397 → 拿掉後 −62,477;前半 −55,728
sc_dd60 總差額  +15,967 → 2026-04 貢獻  +65,294 → 拿掉後 −49,327;前半 −42,662
```
⭐⭐ **2026-04 是這 13 個月的異常月** —— `noset`/`nolate`/三種部位縮放,**五個「贏家」的 edge 全部來自它**。
→ 這解釋了為什麼一直有變體「看起來很棒」:它們不是各自有效,是**同一件事被數了五次**。
⛔ 以後看到某個變體贏,**第一件事就是查 edge 是不是集中在 2026-04**。

**✅ 所以「每天提醒」的正確做法(⛔ 與錯誤做法)**
| ⛔ 不可以 | ✅ 可以 |
|---|---|
| 「今天別做」的閘門 | 顯示**今天屬於哪一格 + 那一格的歷史每趟/勝率/樣本數** |
| 「今天多押 1.5 倍」 | 標明「照這個調整部位,實測**沒有**通過穩健性檢定」 |
| 講成「預測」 | 講成「**歷史上這種盤長這樣**」 |
理由:任何「照環境調整」的做法實測都靠單一月份,⛔ 不可包裝成預測;
但**條件表現本身是事實**,而且三格前後半段一致 → 當背景資訊誠實可用。
⚠️ 顯示時必須同時給 **n** 與「**未來不保證延續**」,且⛔ 不可用紅綠燈(那是漲跌方向,不是好壞)。

⚠️ 累計已測 **56 種**變體,採用的仍只有「每天 2 檔」。

### 🧬🚨 V73.2.3 ⭐⭐⭐ 56 種變體以來**第一個每一關都過**的:高位階 + 高波動
使用者質疑「應該用個股的資料檢測,每隻股票都有他的特性」。方向對,但實測拆成兩層,結論不同 ——
**而且順著這條線找到了本專案至今最大的一次改善。**

#### 🧬 先回答「個股特性」本身(`scripts/perstock_env_probe.mjs`,26 萬筆)
判準只有一個:**前半段學到的,後半段還成立嗎**,且必須**贏過對照組**(隨機挑一招/一個桶)——
⛔「後半段也是正的」不算數,那可能只是那段大盤在漲。

| 問題 | 結果 |
|---|---|
| ① 這檔**整體**強弱會延續嗎 | ✅ 但**很弱**。前半最好 25% → 後半 **+0.259pp**、最差 25% → **−0.217pp**,**單調**;r = **0.154** |
| ② 「這檔適合**哪一招**」會延續嗎 | ✅ **+0.226pp**(贏對照組)→ App 現行 per-stock 排序**是有作用的** |
| ③ 「這檔偏好**哪種盤**」會延續嗎 | ⛔ **四種全滅**(距60日高 +0.038 / 位階 −0.007 / 量能 −0.063 / 波動 −0.033 pp) |

⭐ 結論:**「這檔喜歡爆量」「這檔適合低檔接」是雜訊**;但同一份資料顯示
**狀態效果是「全市場通用」的**,而且比個股偏好大得多:
位階高檔 **+0.24%** vs 低檔 −0.43% ・高波動 **+0.31%** vs 低波動 −0.40% ・爆量 −0.01% vs 量縮 −0.37%(n=4~15 萬)。
⛔ 所以要做成**通用規則**,⛔ 不可做成「這檔喜歡 X」的個股標籤。
⚠️ 探針裡 0.3pp 的判定門檻是隨手訂的,⛔ 不該當結論(本專案自己批評過憑空門檻)。

#### 🚨 順著這條線測「個股自身狀態當濾網」(`SELF`)—— 前 53 種測的全是**大盤**狀態
| 濾網 | 賺到的錢 | vs 基準 | 回撤 | 每趟 | 筆數 | 勝率 |
|---|---|---|---|---|---|---|
| (基準) | 1,127,315 | — | −14.35% | +1.69% | 445 | 29.9% |
| ⭐ **位階≥80 且 波動≥60** | **2,136,115** | **+1,008,800** | **−9.35%** | **+3.08%** | 462 | **37.4%** |
| 只做高波動 | 1,917,005 | +789,690 | −8.47% | +2.79% | 458 | 35.8% |
| 只做高位階 | 1,638,371 | +511,056 | −8.55% | +2.43% | 449 | 35.9% |
| ⛔ 只做**低**位階 | −27,439 | −1,154,754 | **−35.73%** | −0.04% | 418 | 23.0% |
| ⛔ 只做**低**波動 | **−210,967** | −1,338,282 | **−65.90%** | −0.38% | 371 | 26.4% |

**✅ 六道關卡全過(⛔ 前面 5 個「贏家」都死在第 4 關)**
1. 賺更多 **+89%** ・2. 回撤更小(−14.35% → −9.35%)・3. 每趟/勝率/筆數全部更好
4. **拿掉最好的那一個月還贏:+729,797**
5. **前後半段都贏:前半 +487,204 / 後半 +521,597**(幾乎一樣多)
6. **反向檢定方向完全相反**(低位階 −27,439/回撤 −35.7%、低波動 −210,967/回撤 **−65.9%**)

**⭐ 而且是 15 種變體以來第一次「混用贏過單獨用」**(高位階 +51萬 → 高波動 +79萬 → 合用 **+101萬**)。

**⭐⭐ 門檻敏感度網格 6×4 = 24 格:全部贏過基準**(最低 1,302,645、最高 2,158,896;
回撤全部落在 −7.79% ~ −13.41%,都比基準 −14.35% 好)→ **是一片高原不是孤峰,排除過度配適**。
```
位階\波動      40         50         60         70
 >=60    1,586,811  1,939,343  2,038,338  1,815,815
 >=70    1,691,998  1,964,313  2,158,896  1,899,721
 >=75    1,746,310  1,746,322  2,090,809  1,600,166
 >=80    1,800,418  1,807,335  2,136,115  1,531,954
 >=85    1,757,660  1,727,367  1,699,680  1,554,466
 >=90    1,302,645  1,335,538  1,477,329  1,488,452
```
⭐ **取值要挑高原中央而不是峰頂**(峰頂 70/60 是 in-sample 最佳化)→ 建議 **位階 ≥75、波動 ≥60**
(已測 2,090,809 / 回撤 −9.09%);位階 ≥90 明顯衰減(樣本變太少)。

**機制講得通**:這些打法是**突破/動能型態** —— 需要波動才有空間跑,需要強勢才不會一買就套。
低波動牛皮股的型態訊號沒有兌現動力(實測回撤 −65.9%,全表最慘)。
⚠️ 方向跟直覺相反(**追高比抄底好**),但跟本專案先前多次實測一致
(漲停隔日動能 V72.0.1、跳空>1% 不追反而倒賠 V72.9.0)。

**⛔ 兩個不會因為結果好就消失的限制(⛔ 落地文案必須寫)**
① **窗口整段是大多頭**(0050 +83%)→ **空頭完全沒驗證**,而「追高 + 高波動」正是空頭最容易受傷的組合。
② 倖存者偏誤(`data/` 只有還活著的股票)。
→ 建議落地方式:**顯示 + 預設套用但可關閉**,⛔ 不可把不符合的標的整個藏起來(同 `_SIGNAL_EDGE` 對 C 級的處置)。

⚠️ 累計已測 **80 種**變體(27 部位/出場 + 13 行事曆 + 13 事件 + 3 縮放 + 7 個股狀態 + 24 網格),
採用的是「每天 2 檔」與(建議)「高位階+高波動」。

### 📋 V73.2.4 完整盤點:「還有哪些已驗證的發現沒接上提醒?」→ **沒有漏的**
使用者問「有沒有我漏掉、你已回測過有用的價值可以加入昨日及今日的提醒」。逐條對照後:

**✅ 已在提醒流程裡**(隔日清單 `playbook_scan` + 當日尾盤 `_eodTriggerSweep`)
尾盤進場(V72.9.0)・per-stock 打法排序用保守下界(V72.9.2)・每天 2 檔(V73.0.0)・
等權 15%(V73.0.1)・**高位階+高波動**(V73.2.3/V73.2.4)・停損 min(低點,−5%)・
出場破 5MA/20 日・出場提醒不限量(V72.9.1)・`_wrEnough` n≥10。

**❌ 已實測 → 對「這套打法」無效(⛔ 別再加一次)**
大盤月線 regime(−12萬)・成交值≥1億(勝率+3.4pp 但 −30萬)・共振≥2招(−50萬)・
分散 6 檔(−63萬)・跳空不追(倒賠)・13 種行事曆・13 種大盤事件・3 種部位縮放(靠單一月份)・
停損 −3% 與出場放寬(跟「2 檔」合起來就翻盤)。

**🆕 這次新測:乖離年線當排除條件 → 也是少賺**(在 高位階+高波動 之上再加)
| 條件 | 賺到的錢 | 回撤 | 每趟 | 勝率 |
|---|---|---|---|---|
| 高位階+高波動 | **2,136,115** | −9.35% | +3.08% | 37.4% |
| 再排除 乖離年線 >200% | 1,376,320 | −8.29% | +1.98% | 35.6% |
| 再排除 >150% | 1,337,907 | −9.67% | +1.90% | 34.8% |
| 再排除 >100% | 1,000,379 | −11.22% | +1.44% | 34.7% |
**單調:排除越多越差**,而且勝率也跟著掉(⛔ 不是「少賺換安全」那種取捨)。

⭐⭐ **這條的通用教訓比數字本身重要**:CLAUDE.md 明明記著「乖離年線 200% 後 60 日 −6.24%」,
那**沒有錯** —— 但那測的是「**穿越 200% 之後,該股相對大盤的報酬**」,
這裡測的是「**這套打法在那些股票上的表現**」。**兩個是不同的問題。**
⛔ 「某指標對股價有預測力」≠「這套打法在那種股票上表現差」,不可直接套用。
同型:地板股 300+(大盤 5/10/20 日有邊際,但混進個股打法 −98萬)、
漲停隔日動能(**只有次日**有效,那是當沖不是波段)。

**⏳ 唯一還沒驗、而且驗得動的候選**:`_SIGNAL_EDGE` 那 9 個期望值為正的偵測器訊號
當「額外加分」。⚠️ 要在 `portfolio_backtest` 的掃描階段呼叫偵測器 → 每組變體都要重掃(約 3 分/次),
成本比先前高一個量級,所以先記著,⛔ 別在沒測之前先接上去。

**⛔ 資料不足、驗不了的**:CB parity(`cb_overview.json` **只有今天的快照、沒有歷史**)・
籌碼類(`foreign_net` 中位 28 天、`trust_net` 203/291 檔全空)→ 等 2027/05 後重跑。

### 🔬 V73.2.5 46 個偵測器 × 個股打法 —— **測完決定不加**(疊上去沒有增量)
使用者:「46 個偵測器,有沒有比對個股打法,把可能的加進來?」
`scripts/sig_x_playbook_probe.mjs`(593 檔・115,206 個(股,日)・196 秒)。

⭐ **它問的跟 `signal_backtest.mjs` 不是同一件事**(這點是整節的關鍵):
| | signal_backtest | sig_x_playbook_probe |
|---|---|---|
| 問題 | 這個訊號**自己**有沒有預測力 | 它**疊在打法上**有沒有加分 |
| 對照組 | 隨便挑一天 | **同一批打法交易的平均** |

**🔼 通過三關(n≥300・邊際 >+0.5pp・前後半段同向)的加分訊號 12 個**
正乖離過大 **+1.86pp**(n=4,424)・負乖離過大 **+1.70pp**・W底 +1.23・換手量(洗籌續攻) +1.07・
多頭但追高 +1.05・疑似竭盡缺口(高檔) +1.05・ABC下降切線突破 +0.88・站上長黑K高點 +0.70…

**🔽 扣分 5 個**:群星晨星+爆量 **−1.48pp** ・晨星轉折+爆量 −0.74 ・群星夜星 −0.74 ・
群星晨星 −0.71 ・威科夫·出貨段 −0.51 —— ⭐ **晨星家族 4 個全中且方向一致**
(抄底型態跟這套突破/動能打法**氣質互斥**)。

**⭐⭐ 最重要的一條:⛔ 不該挑「自己會賺」的訊號**
「晨星轉折+爆量」自身是 **A 級、期望值 +0.56%**(自己拿來買會賺),疊在打法上卻是 **−0.74pp**;
而加分最多那批**有一半自身期望值是負的**(向上缺口已回補 −1.09%、量縮洗盤 −1.02%)。
→ ⛔ 我原本提議的「用那 9 個正期望值訊號當加分」**方向是錯的**。

#### 🚨 決定性的一步:看賺到的錢 → **單獨用有效,疊上去卻有害**
| 組合 | 賺到的錢 | 回撤 | 每趟 | 勝率 |
|---|---|---|---|---|
| 基準 | 1,127,315 | −14.35% | +1.69% | 29.9% |
| 只做加分訊號 | **1,493,584** | −12.05% | +2.22% | 33.6% |
| 排除扣分訊號 | 1,412,060 | −13.07% | +2.09% | 30.6% |
| 加分+排除扣分 | 1,467,047 | **−10.80%** | +2.18% | 33.9% |
| ⭐ **高位階+高波動(現行)** | **2,136,115** | **−9.35%** | **+3.08%** | **37.4%** |
| 　+只做加分 | 1,487,313 | −13.18% | +2.33% | 36.2% |
| 　+排除扣分 | 2,084,381 | −9.09% | +3.01% | 37.3% |
| 　+兩者 | 1,588,746 | −12.70% | +2.49% | 36.7% |

**增量檢定(相對「高位階+高波動」)**:
```
+只做加分  −648,802(前半 −321,401 / 後半 −327,401)⛔ 兩段都輸
+排除扣分   −51,735(前半 ±0 / 後半 −51,735)      ➖ 雜訊範圍
+兩者      −547,369                              ⛔
```
→ **⛔ 決定不加**。三組都沒有增量,最好的那組也只是持平。

⭐⭐ **真因(我事前就預測到,實測證實)**:正/負乖離加分 = **把「高波動」再數一次**。
乖離大本來就是波動大的另一種說法 → 已經用高波動篩過之後,再用它篩只是把樣本切更小。
⚠️ 同型:集保四象限(兩條腿交叉後比各自相加還差)、V73.0.0 停損 −3%(單獨好、跟「2 檔」合用就翻盤)。
⭐ **通用鐵則:任何新條件都要測「疊在**現行配置**之上」的增量,⛔ 不可只跟原始基準比。**

⚠️ 累計已測 **86 種**變體,採用的仍只有「每天 2 檔」與「高位階+高波動」。

### 🚨🚨 V73.2.9 窗口 13 → 36 個月,結論**整個翻轉**:🧬 不是加分項,是**必要條件**
階段1(指數補深)跑完後重跑回測。`^TWII` 486 → **1,213 筆**(2021/08 起,全部有 amount),
可交易窗口 13 → **36 個月**。

| | 舊窗口(13個月・整段 AI 大多頭) | ⭐ 新窗口(36個月) |
|---|---|---|
| 照清單順序做 | +1,127,315 ・回撤 −14.35% | +1,260,926 ・回撤 **−23.96%** ・每趟 +0.66% |
| 只做 🧬 高位階+高波動 | +2,136,115 ・回撤 −9.35% | **+2,896,478** ・回撤 −22.44% ・每趟 +1.51% |
| 🆚 0050 買進持有 | +832,500 | **+2,011,700** |
| 照清單做 vs 0050 | 贏 | 🚨 **輸 75pp** |
| 只做 🧬 vs 0050 | 贏 | ✅ **贏 88pp** |

⭐⭐ **最重要的結論:不挑「🧬 強勢高波動」的話,這套輸給什麼都不做買 0050。**
→ 🧬 **不是「加分項」,是「必要條件」**。前端文案已改,⛔ 不可再寫成「加分」。
⭐ 反過來說,「高位階+高波動」在**三倍長、且含 2023 震盪段**的窗口裡仍然大勝
→ 它的可信度比 V73.2.3 當時又高了一級(多了一段不同行情)。

#### 🚨 順手抓到的比較基準 bug(⛔ 沒抓到的話整份結論都是錯的)
`const from = days[WARMUP]` —— WARMUP 是從**指數**第 0 天算的。
指數補深到 5 年之後 `days[240]` 落在 **2022-08**,而個股資料 **2023-06** 才開始
→ 拿「5 年的大盤漲幅」比「3 年的策略」,而且 0050 那時還沒資料 →
**對照組直接消失**(實測輸出「0050 買進持有 **(無資料)**」「加權指數 +199.29%」)。
→ 改成 `from = 第一筆實際成交日`。修完 0050 才顯示出真正的 +201.17%,而那正是翻轉結論的關鍵。
⭐ 通用:**對照組的期間必須跟實際交易期間對齊** —— 資料源長度一改,這種錯就會冒出來,
   而且它**不會報錯**,只會讓你看到一個看起來很合理的錯數字。

⚠️ 仍然**沒有驗到空頭**:個股資料只到 2023/06,2022 那次 −32% 碰不到 —— 指數已備好,就差個股(階段2)。
⚠️ 回撤從 −9~14% 變成 **−22~24%** —— 這才是誠實的數字,舊的太好看是因為窗口太短。

#### 🔑 深歷史探針的發現(`scripts/history_probe.py`)
- 一次呼叫拿到 **4,561 筆 / 2008-01-02 起(18.6 年)**、5 秒 → 深歷史**完全拿得到**
- `TaiwanStockDelisting` **✅ 340 筆** → ⭐ **倖存者偏誤修得掉**(階段3 的成敗關鍵)
- 空間:一檔 892KB(精簡後 ~402KB)→ 2,700 檔 18 年約 1,110MB,⛔ 不能上 gh-pages;
  只取 2021 起(5 年)約 300MB
- 🚨 **4 把 FINMIND_TOKENS 只有 1 把能用**(其餘 HTTP 400)—— 同 V72.5.3 的教訓,
  探針第一版每組固定用某一把,害「還原股價/除權息」那組全用到壞的、被誤讀成「沒有這些資料」。
  → 探針 V2 一律**把每一把都試過才放棄**,並輸出「實測可用第幾把」。

### 📦 V73.1.3 APK 一鍵打包(雲端後台)+ 🐛 PWA 圖示從沒上線過
使用者:「怎麼下載 apk」→「apk 做好了嗎?」

⛔ **沙箱打不出 APK(實測,不是猜的)**:`dl.google.com` / `maven.google.com`(會 302 轉去 dl)
/ GitHub raw 的 android.jar 鏡像 **全部被 gateway 403**;Maven Central 與 Gradle 通但缺 android.jar 沒用。
→ 改成**雲端 runner 打包**(那邊本來就有 Android SDK),使用者按一顆按鈕下載 artifact。

⭐ **`android/` 外殼 ⛔ 一行 Java 都沒有** —— TWA 的 `LauncherActivity` 由 `androidx.browser` 提供,
整包只是「用哪個網址 + 什麼圖示/顏色」。功能永遠只改 `index.html`,⛔ 不用動這裡,
以後 App 更新也**不需要重新打包**(TWA 載的就是線上網站)。

⛔ **簽章金鑰刻意公開**(`android/twa-key.jks`,密碼/別名照安卓官方 debug key 慣例):
只給自己裝、不上架 Play → 它唯一的作用是「覆蓋安裝認得出同一個 App」,**不能動錢、不能存取資料**。
⚠️ 這**不推翻**「下單憑證絕不進雲端」那條 —— 兩者是完全不同的東西
(`check_workflow_paths.py::check_no_trading_in_ci` 仍然把 `auto_trade.py` / `SJ_CA_*` 擋在 workflow 外)。
SHA-256 已填進 `.well-known/assetlinks.json`(不再是 placeholder)。

⭐ **build_apk.yml 的兩個空過守門**(⛔ 別拿掉):
① 圖示 5 種尺寸沒全產出就失敗(免得打出沒有圖示的 APK)
② **打包後驗「APK 簽章 == assetlinks.json 的 fingerprint」,對不上直接失敗** ——
   那種 APK 裝上去**頂端會多一條瀏覽器網址列**,⛔ 別讓人白裝一次才發現。
⚠️ `applicationId`(app/build.gradle)與 `package_name`(assetlinks.json)**必須一模一樣**,改一邊就會出網址列。

#### 🐛 順手抓到:PWA 主畫面圖示從 V69.8.7 起**一次都沒上線過**
兩條部署路徑(`deploy_pages.yml` / `daily_miner.yml`)都**只 `cp` 圖示、沒有 `git add`**
→ 「暫存放回了但沒 commit」→ gh-pages 根目錄只有 7 個檔,`manifest.json` 指的
`icon-192.jpg` / `icon-512.jpg` **全部 404**,而且 workflow 全綠、零錯誤訊息。
⭐ 這正是 CLAUDE.md 自己在 V73.1.1 assetlinks 那段寫過的警告(**漏 `git add` = 每天被洗掉**)——
**寫下警告的下一個檔案就再犯一次**。⛔ 通用:workflow 裡任何 `cp` 進部署目錄的檔案,
**當場 grep 同一段有沒有對應的 `git add`**,別只加自己這次新增的那個。

### 🕶️ V73.1.2 低調化三件套(使用者要求,2026-08-08)⭐ 詳細內容**刻意不寫進 `_CHANGELOG`**
使用者:「①把程式的 GitHub 相關資訊刪除,我不想讓人輕易知道 ②版本更新資訊改成當天顯示而已
③這次的告知資料不要放在版本內,另外也紀錄下來」→ **這一節就是那份「另外的紀錄」**。

**① UI 可見層的 GitHub 字樣已全部改白話**(9 處):
Telegram 教學連結(原本直接連 repo)→「見專案文件 cloud-worker/README.md」・
「GitHub Pages CDN」→「雲端主機」・「GitHub Actions」→「雲端後台/雲端部署流程」・
`_CHANGELOG` 舊條目與 updateLogModal 底部的「保存在 GitHub」→「雲端紀錄檔」等。
⛔ **功能性的不能動也沒動**:`api.github.com` 呼叫(採礦中 banner)、OpenRouter 的
`HTTP-Referer`、動態 `ghBase` —— 動了 App 會壞,而且那些不顯示在畫面上。
⚠️ **誠實限制(已知會、⛔ 別假裝做得到)**:網址本身就是 `xin7355-collab.github.io`,
瀏覽器網址列藏不掉;repo 也是 public。這次做的是「畫面上不主動講」,不是匿名化。
⚠️ 日後寫 UI 文案:**GitHub/repo/Actions/push 這類字一律不出現在使用者可見層**
(V26.18 錯誤訊息白話化鐵則本來就有,這次是全面掃過一遍 + 使用者明示)。

**② 更新跳窗只在「發佈當天」自動顯示**(`_checkVersionUpdate`):
比對 `_CHANGELOG[0].dt` 與台北今天(`Intl.DateTimeFormat en-CA Asia/Taipei`,
⛔ 不可用 `toISOString` —— 那是 UTC,台北晚上會差一天)。
非當天 → 默默記 `proTerm_lastSeenVer`,⛔ 不跳窗。設定中心「🆕 更新紀錄」手動看不受影響。

**③ 敏感/內部性質的改動,`_CHANGELOG` 只寫中性一句**(如 V73.1.2「🧹 例行維護」),
詳細記在 CLAUDE.md(= 本節)。⚠️ `_CHANGELOG[0].v` 必須等於 `_APP_VERSION`(測試釘住),
所以條目本身不能省,只是內容中性化。

**順手:`_CHANGELOG` 第二次搬移**(90 筆 → 60 筆,30 筆搬進 `CHANGELOG.md`,一字不刪;
同 V72.1.9 的做法)。⚠️ `test_changelog_trim` ③ 的斷言跟著文案改成「完整保存在雲端紀錄檔」——
⛔ 改斷言要**名稱與 regex 兩邊一起改**(第一版只改到名稱那行,regex 還在驗舊字樣)。

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
     ⚠️ **第 7、8 處(V72.2.2 / V72.2.3,`page_sweep` 掃出來的)**:
     打法適配儀「今天出現這檔歷史最會賺的型態 → **可依紀律進場**」、
     多空計分卡「四面向同步攻擊,**可放心做多**」。⛔ 兩處都已改走 `_bearGate`。
     ⭐ **多空那處特別值得記住**:CLAUDE.md 曾判定它「`ratio ≥ 0.65` 天然安全」——
     **那個判斷是錯的**,`ratio` 講的是「28 條規則的命中比」、`_ovTrend` 講的是「價格趨勢」,
     **兩者完全可以背離**(空頭股的籌碼面照樣可能整排亮)。
     → ⛔ 判斷「這張卡天然安全」時,要確認那個條件**真的跟價格趨勢綁在一起**,
       別看到「有門檻」就以為安全。測試 `scripts/test_wrsample.mjs` ③⑤。
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

##### 🐛 V72.2.1 同一個坑修了**兩次**才修對 —— 巢狀有**兩層**
V72.1.1 拆掉內層 `if pb_pct:` 之後,**仍然一次都沒產出過**。
去翻 workflow log,答案就一句:**「⏭️ TWSE 基本面回空,跳過產業 PE 聚合」**
—— 外面還有一層 **`if twse_fund:`**,整段連進都沒進去。

⭐⭐ **兩個通用教訓**:
1. **拆巢狀要往上追到函式頂層**,別只拆看得到的那一層。
   測試 ⑥b 已改成**由內而外列出所有守門條件**,只要含
   `twse_fund|fund_cache|fundamentals|pb_pct` 就擋下來
   (現在的鏈是 `['else:', 'if CHIPS_TOTAL > 1:', 'def fetch_broker_chips():']`,乾淨)。
2. **「修完沒生效」時第一件事是去看 workflow log 的實際輸出** ——
   那句「跳過產業 PE 聚合」就是答案,比再讀十遍程式碼快得多。
   ⛔ 別憑程式碼推理就宣稱修好了,要看**它到底有沒有跑到**(同陷阱 #9)。

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
| `tdcc_probe.py` | 「兩上兩下」(大戶↑散戶↓融資↓)有沒有邊際(V71.9.0) | ⭐ **V72.5.1 起改讀 `tdcc_deep.json`(104 週)** —— 手動跑一次 `tdcc_sweep.yml`(backfill=yes)產出深檔後就可以重跑 |
| `cb_probe.py` | 可轉債「離轉換價多遠」有沒有預測力(V71.9.1) | 累積到有 CB 歷史快照後(目前只有今天的快照,有倖存者偏誤) |
| `ma20_probe.py` | 「跌破月線就停損」到底對不對(V71.9.2) | 走完一次真正的空頭後(大盤跌破事件目前只有 6 次) |
| `short_probe.py` | 券資比/軋空有沒有邊際(V71.9.2) | 融資券滿 1 年且涵蓋一段多頭後 |
| `trust_probe.py` | 投量比(投信買超÷成交量)有沒有預測力(V71.9.5) | `trust_net` 滿 1 年後 |
| `volstall_probe.py` | 「爆量漲不動/跌不動」日線版(V71.9.8) | ⛔ 已驗**不成立** |
| `volseq_probe.py` | 真正的「連次量」(盤中第N次爆量)分K版(V71.9.8) | ⛔ 已驗**不成立**;走完一次趨勢盤後可重驗 |
| `turnover_probe.py` | 週轉率 × 昨日漲跌幅(當沖三大指標之一,V72.0.1) | 累積更多資料後;目前 22 萬事件已足 |
| `floorcount_probe.py` | 全市場「地板股家數」是不是大盤短線低點(V72.4.9) | ⭐ **走完一次空頭後必須重跑** —— 現有窗口整段是多頭,基準 20 日勝率就有 73.6% |
| `turnover_stage_probe.py` | 週轉率 × **位階** / 月線斜率 ≥1%/日(V72.4.9) | ⛔ 兩條都已驗**不成立**(月線斜率方向還相反),別再測一次 |
| `gap_probe.mjs` | 「開盤跳空 2~4% 法」有沒有邊際(V73.6.0) | ⛔ 已驗**不成立**且**單調變差**(跳空越大越糟),別再測一次;⚠️ 它的註解記著我第一版犯的**前視偏誤**(用今天收盤價當條件又用今天收盤價算報酬),改探針前先讀 |
| `pe_probe.mjs` | 本益比(絕對/相對同業)與後續報酬的關係、價值陷阱(V73.7.5) | ⛔ 「PE 低會漲」已驗**單調反向**,別再測一次;⭐ **走完一次空頭後要重跑** —— 窗口只有 12 個月且整段偏多頭,而「撿便宜」正是空頭才可能翻身的做法;⏳ `qeps` 累積更多季之後窗口會自動變長 |
| `regime_probe.mjs` | 缺貨(族群齊漲)/ 供貨(族群齊跌)/ 做夢(獨走)/ 族群轉折 七種狀態之後的報酬(V73.7.4) | ⛔ 六種已驗**扣成本後為負**,別再測一次;⭐ **走完一次空頭後要重跑** —— 現有窗口整段偏多頭,而「獨走」正是空頭最容易受傷的型態 |
| `calendar_stock_probe.mjs` | 37 種財經行事曆日的漲跌機率/幅度/波動(逐檔 + 天數層級 + 環狀位移對照 + 期外驗證,V73.7.3) | ⛔ **方向已驗不成立**(唯一通過的扣成本後為負且期外反向),別再測一次;⭐ **波動的結論可重跑**(走完一次空頭後,現有窗口整段偏多頭)|
| `screener_edge_probe.py` | 選股頁 127 個條件各自的期望值(直接呼叫 `screener_miner.build_one` 跑歷史,V74.0.3) | ⭐ **改 `_SCR_CONDS` 門檻或新增條件就要重跑**(否則 `_SCR_EDGE` 的成績會對不上);⭐ **走完一次空頭後要重跑** —— 現有窗口整段偏多頭,而整張表的結論正是「追強 > 抄底」 |
| `limitup_probe.mjs` | 漲停能不能提早一天預測(K線/籌碼/基本面/市場面 全面比較,V74.0.2) | ⛔ 命中率拉得到 4 倍但**扣成本後全負**,而且每一組都死在「漲停鎖死買不到」;⭐ **走完一次空頭後要重跑** —— 現有窗口整段偏多頭,而高波動追強正是空頭最受傷的組合 |
| `ml_probe.py` | 梯度提升樹對「未來 20 日超額報酬」有沒有樣本外預測力(V73.4.3) | ⛔ 已驗**不成立**(測試 AUC 0.522、輸給「位階 ≥75」一條規則);⏳ **籌碼欄位滿 1 年後(約 2027/05)可加特徵重跑** —— 純 Python 零依賴、50 秒,`--selftest` 驗 harness |
| `broker_ally_probe.mjs` | 分點「同盟集團」(cosine 相似度找影子集團,≥3 家同天大買)有沒有預測力(評估紀錄⑮) | ⛔ 已驗**不成立** —— 正向那組六關 + 格內對照全過,但**反向驗證翻盤**,而且兩段學到的同盟 **Jaccard 0%**。⭐ 它的價值是**方法**:任何「先學一組成員再拿去預測」的做法,先報重疊率再談報酬。⚠️ 要 `CHIPS_DEEP_DIR` 指到 chips_deep 分支解出來的目錄 |
| `inst_leadlag_probe.mjs` | 三大法人 × 融資(散戶代理)的領先落後 + 「跟單」有沒有加成(V74.2.7) | ⛔ 「誰領先誰」已驗**量不出來**(lag≥1 相關 ≈0),別再測一次;⭐ 「隔天外資有沒有跟」的加成已落地為描述。⚠️ 它有 `a===b`(自己續買)當決定性對照 —— 任何「A 之後 B 跟」的題目都該照抄這條 |
| `trustvol_probe.mjs` | 投量比(投信單日淨買 ÷ 成交量)分桶的期望值(評估紀錄⑮) | ⛔ 已驗**六關 0 過**(邊際只存在 2026、賣超那端也是正的、文件說的 ≥10% 反而最弱);⭐ **`trust_net` 再累積一年後可重跑** —— 現在有效樣本只有 2024-04 起且整段偏多頭 |
| `sector_rotation_probe.mjs` | 板塊輪動「**要看幾天**」+ 六種「錢流」定義誰有預測力(V74.2.5 / V74.3.0) | ⛔ 「成交額佔比變化」(= 最直覺、最好做成箭頭動畫的那個)與「加速度」已驗**不成立**,別再做一次;⭐ **走完一次空頭後要重跑** —— 20 日動能那條的本質是追強,空頭最容易受傷。⚠️ 改 App 用的窗口(現在 20 日)要重跑對齊 |
| `sector_pick_probe.mjs` | 板塊選對之後,產業**內部**怎麼挑(7 種挑法的增量檢定,V74.4.1) | ⛔ 「補漲/便宜/波動最大/龍頭」已驗**全部不成立**(補漲逐年全負),別再測一次;⭐ 只有「板塊內最強」六關全過(+0.90%)。⚠️ 對照組是**強勢板塊裡的所有股票**,⛔ 換成全市場就會量到「選對板塊」的功勞 |
| `streak_probe.mjs` | 連漲/連跌 N 根 ・跌停後多久回彈 ・止跌紅K ・跳空缺口四類 ・創高回測不破 ・量縮後爆量(V74.4.0~V74.4.1) | ⛔ 連漲連跌已驗**全部 < 成本**,別再測一次;⭐ 「跌停後紅K」六關全過(+3.66%,大紅版 +5.71%)**待落地**。⭐ **走完一次空頭後要重跑** —— 跌停後回彈在多頭窗口天生佔便宜,而這正是最需要空頭驗證的一類 |
| `dispo_probe.py` + `dispo_backtest.mjs` | 進處置/進注意股事件(官方名單 3.2 年)+ 前幾天漲跌分桶 + 出關行情(V74.4.2) | ⛔ 進處置=賠率型(中位 −4.8%)不能當訊號、出關行情前後半不同向、前幾日漲跌非單調 —— 別再測;✅「噴≥30%進注意 → −1.81pp」當避雷。⚠️ 探針在 Actions 跑(沙箱連不到 FinMind/TWSE),事件從 job log 的 D\|/N\| 行收;⭐ 走完空頭後重跑(接刀類最需要空頭驗證) |
| `washout_probe.mjs` | 「大戶洗散戶」有沒有特定走法:回檔期間集保方向(大戶↑散戶↓)× 量縮/量增(V74.4.2) | ⛔ 已驗**分不出來**(洗盤樣 +0.50 vs 出貨樣 +0.58pp、唯一漂亮格與坊間相反=多重比較)。⭐ 真因是集保**週頻太粗**(回檔 10 日只夾到 1~2 週)→ 除非有日頻散戶結構來源,否則別再測 |
| `gapfill_probe.mjs` | 「缺口不補繼續走」:真缺口第 5 天分沒回補/已回補的續航(V74.4.3) | ⛔ 已驗**六關 0 過**(方向對:沒回補 +0.25 vs 已回補 −0.27pp,但前後半全不同向、扣成本全負)。⚠️ 對照組=全部缺口事件(⛔ 拿全市場量到的是跳空本身) |
| `broker_ind_probe.mjs` | 「這家券商在**這個產業**特別準」存不存在(per-(券商×產業) cell,V74.4.3) | ⛔ 已驗**不存在**(cell 名單 Jaccard 4.7% ≈ 隨機 5.3%、前段班驗收邊際 −0.03pp);per-broker 整體層級 34.5% 有結構但頭尾差 < 成本。⚠️ 要 chips_deep 分支解出來的目錄 |
| `ailevel_probe.mjs` | 驗 `pro.html` **自己**的 AI 五級「資金主戰場」有沒有預測力(V74.2.9) | ⛔ 已驗**沒有**(各層邊際在雜訊內、前後半不同向)→ 文案維持「人工框架、未實測」。⭐ 它從 pro.html 讀 `PRO.CHAIN`(⛔ 不複製第二份名單)→ **改名單後可直接重跑**;對照組是**名單內部其他層**,⛔ 不可拿全市場當對照 |
| `etf_switch_probe.mjs` | 0050 vs 2330 買進持有互比 + 00981A 體質 + 「大跌買高彈性、落後換回 0050」輪動(V74.4.7) | ⛔ 輪動已驗**不成立**(字面規則打乒乓 583 次;每波只換一次的版本前後半 9 格最多贏 3 格),別再測參數;⏳ 00981A 本尊等它經歷一次空頭後可重驗。⚠️ 內建**斷崖守門**(相鄰收盤 ±40% 拒跑)—— 00631L 的壞資料就是它抓的 |
| `sixmeridian_probe.mjs` | 六脈共振卡四種結論 + ⚡點火(跑**真的** `_sixMeridianCalc`,V74.1.9) | ⛔ 只有 🔴 強共振過六關(+0.80pp),🟡 試單級 ≈ 0 已改口;⭐ **改 `_sixMeridianCalc` 判定就要重跑**(卡上數字會對不上);⚠️ 60 檔試跑跟全市場**結論相反**,試跑只能驗管線 |
| `instcost_probe.mjs` | 「法人推估成本」站上/跌破/剛穿越有沒有邊際(V74.1.8) | ⛔ 已驗**無優勢**(±0.2pp、六關 0 過)→ 該卡 V74.2.0 已刪除;要復活先重跑且六關要過 |
| `dtflip_probe.mjs` | 隔日沖「開盤買、盤中高點賣」pooled 全市場(V74.2.0) | ⛔ 已驗**碰得到 ≠ 賺得到**(碰 +1.5% 機率 53~72% 但務實損益全負)→ 該段已刪除;⭐ 任何「盤中最高 ≥X%」型勝負定義的回測都要配它那條**務實出法** |
| `genezone_probe.mjs` | 位階×振幅 8 格的期望值 + 進框天數/掉出框(V74.1.6) | ⛔ 「高檔過熱要賣」方向相反、「買進/加碼時機」量不出來;⭐ 泡泡圖分區數字 `_GZ` 來自它 —— **改分段門檻就要重跑**;走完空頭後重跑(八格逐年那關全沒過) |

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
- 🚨 **股東人數(集保戶數):13 週說有邊際,104 週重測後「邊際消失且方向反轉」**(V72.5.4 更正)。
  13 週版:人數↓(集中)20 日 −3.39% vs 人數↑ −4.28% = **+0.88pp**(n=12,321/6,567)→ 當時列為第 4 加分項。
  **104 週深歷史版:集中 −4.06% vs 分散 −3.85% = −0.21pp**(n=99,159/78,064)→ **樣本大 8 倍後證明是短窗口雜訊**。
  → 依鐵則「重跑後邊際消失就降級或移除」:`hits` **只算前三項**,第 4 項改成**只顯示不計分**,
  卡上明寫重測前後的數字。⭐ **這正是把集保從 13 週加深到 104 週最大的價值 ——
  不是多一個訊號,而是把一個其實不成立的加分項抓出來。**
  ⛔ **判定門檻仍只看前三項**(`core3`)—— 改成「四項全過」會讓實測最強的組合顯示不出來。
- ❌ **「高檔主力賣散戶買最慘」不成立**(⭐ 104 週重測後**更確定**:低/中/高位階分別只差
  0.11 / −0.28 / 0.00pp,高位階根本一模一樣)—— 13 週版是差 0.55 / 0.95 / 0.79pp,
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

### 📐 V74.4.6 今日訊號頁四項介面修正(使用者:「字太小 / 敘述太長 / 名字在上代碼在下 / 直接告訴我掛單價」)
- **① 字級**:`.note` 10 → **11.5px**、`.warnbox` 11 → 12.5px、`.sigtbl` 11 → 12.5px、
  `.sigtag` 9 → 10.5px、`.sigwarn` 9.5 → 11px、`.memchip` 10 → 11.5px。
  ⛔ **別再往 10px 以下調** —— 手機上那個字級接近看不清楚,而這頁的免責/說明正是最不該被跳過的。
  ⚠️ 連帶:`.rotverdict` 的 `min-height` 要從 74 → **86px**(內容變高會推動下面的圖表,測試 ㉒d2b 會擋)。
- **② 縮短**:盤前分數、進場時機、配套、避雷四段各砍掉約三成字,⛔ 但測試釘住的免責句一個都沒少。
- **③ 標的欄**:`<span class="signm">中文名</span><br><span class="sigcode">代號</span>`
  —— ⭐ 使用者認股票是認名字不是認號碼。⚠️ 連帶:`🧬` 徽章要 `display:inline-block` **自己一行**,
  而且 `.sigtbl td:first-child{max-width:132px}` —— 那是 **sticky 欄**,不封寬會在手機上把價格欄整個擠出畫面(實測 390 寬看不到停損)。
- **④ 建議掛單價**:表格新增 `💰 建議掛單價`(= 觸發價,大字琥珀)+ **昨收 + 要漲幾 %**。
  ⛔ **三條不可拿掉**:(a) 一定要同時給昨收與漲幅,否則看不出這個價是遠是近;
  (b) `loose`(不看價位的招)⛔ 不可硬給一個價,顯示「這招沒有固定價位」;
  (c) 🚨 必須寫「那是**站上去才算數的觸價買單**,不是等它跌到那裡撿」——
  ⭐ 掛錯方向正是實測最糟的那種做法(掛前一日收盤價只賺 12.4 萬、回撤 −46.1%)。
- ⚠️ **舊的「⛔ 不給任何買賣價位建議」作廢**(測試 ㉜l 已改):那句話本來就跟「表格已經在顯示觸發價/停損」
  自相矛盾。改成釘**誠實揭露**:「這裡的價位是用昨天收盤算的估計值,盤中以散戶救星重算為準」。
測試 `scripts/test_prohtml.mjs` ㉜l~㉜p(5 條新增)。

### 🧮 V74.4.7 六題一次做(0050vs2330 / 00981A輪動 / 回測計算機頁 / 混合策略 / 🧬移右欄)
使用者六點 + 問「有沒有說錯」。⭐ 三個「說錯的」都用數字答:

**① 0050 vs 台積電**(`etf_switch_probe.mjs`,⛔ 不含息):5.6 年 2330 +348.7% vs 0050 +241.8%,
回撤 −45.7% vs −36.4%;定期定額也是 2330 多。⚠️ 0050 約一半就是台積電;含息差距每年縮 ~1.5pp。

**② 「大跌買 00981A、落後換回 0050」→ ⛔ 輪動不成立**:
- 00981A 只有 15 個月(beta 1.12、上市以來 +194% vs 0050 +132%)→ 本尊驗不動。
- 🚨 字面規則會**打乒乓**(落後換回→還在回檔又馬上換進去):5.6 年換 **583 次**全在繳手續費。
  改成「每波大跌只換一次」再測(合成正2 代理 + 2330 兩版):**前後半 9 格最多贏 3 格**,
  台積電版 0/0 → 方向做反(漲回來拿低彈性、下跌拿高彈性)。⭐ 要嘛直接抱高彈性(吃回撤),要嘛抱 0050。
- 🚨🚨 **`data/00631L.json` 資料是壞的**(兩處斷崖 2024/08/01 ×22.8、2026/03/25 ×0.045,
  = 陷阱 #21 那批;第一版拿它當代理跑出「+6753%/回撤 −96%」的垃圾)→ 探針已加
  **斷崖守門(相鄰收盤 ±40% 就拒跑)**;⭐ 又一次「先驗基準像不像話」救了結論。
  ⏭️ 00631L 是熱門槓桿 ETF,App 顯示的 K 線就是這份壞資料 —— 修法在採礦端(同陷阱 #21 待辦)。

**④⑥ 混合策略(多頭/盤整/空頭)**:
- 三態拆解(49 個月 1,703 筆實際成交,嚴格空頭=收<60日線且20日線<60日線):
  **多頭每趟淨 +0.98% ・盤整 +0.97% ・空頭 −0.29%** → 「空頭時這套沒優勢」成立。
- 🚨 但「跌破月線就停」**兩頭輸**(+127.9 萬 vs 195.5 萬,回撤 −36.7% 還更糟)——
  跌破月線大多是**多頭回檔**,正是最賺的時刻。⛔ 別用月線當空頭開關。
- `FILTER=bear60`(新增,嚴格空頭才停):+205.9 萬 / 回撤 −30.6%,兩項都略贏 ——
  ⛔ 但去最好月轉負(+10.4 萬 → −4.0 萬)、前後半不同向 → **當「少曝險」的選項,⛔ 不當預設**。
- ⛔ 空頭改抱 0050 不對:嚴格空頭那 169 天加權合計 **−13.8%**,空頭的正確資產是現金。

**③ 回測計算機頁**(pro.html 第 6 個分頁 `tabCalc`):
⭐ 使用者的期待對一半:⛔ 手機**不可能現場跑**全市場回測(幾百 MB 資料、一輪 10 分鐘),
而且「現場調參數」= 過度配適製造機 → 做成**預先真的跑過的情境庫**(`PRO.BT`,9 個分組 ~50 格,
每格附窗口+判定旗標 🚨=沒過穩健性)。三條鐵則(測試 ㉞ 釘住):
① 必寫「真的跑過的、不是現場算的」② 必寫「**沒列的交叉=沒測過**」+「混用 27 次 0 贏」
③ 每組標窗口(窗口會翻轉結論)。⚠️ **新增格子必須先真的跑過 portfolio_backtest 再抄數字**,⛔ 不准放推估值。

**⑤ 🧬 徽章移到清單最右欄**(標的欄只留名字+代號+警示,sticky 欄不再被撐寬)。

### 🏷️ V74.4.8 個股題材標籤重做 —— 「每天抓」不等於「資料是新的」
使用者截圖:南亞科(2408)的標籤是「**#台塑 #Windows11 #美中貿易戰受惠 #蘋果供應商 #Smart TV**」
—— 一個跟記憶體有關的都沒有,問「Smart TV 這個有用嗎?」

🚨🚨 **真因很反直覺**:`data/concept_stocks.json`(megatime)**每天都有抓、`updated` 是今天**,
但**上游的題材定義本身凍結在 2021 年左右** —— 231 個群組裡沒有記憶體/CPO/散熱液冷/ASIC,
卻還留著 Google眼鏡 / iPad Pro / 五倍券 / Smart TV。
⭐⭐ **通用鐵則:判斷一份外部資料新不新,要看「它的內容有沒有跟上」,⛔ 不是看 `updated` 欄位。**
(同陷阱 #9「workflow 全綠不等於有產出」的變形 —— 這次是「有更新不等於有變新」。)

#### ⭐ 架構:題材「定義」人工,題材「成員」每天自動重算(`miner.build_stock_tags`)
⛔ 這兩件事一定要分開講,否則會落回「寫死的表遲早過期」那個老坑:
- **定義**:`pro.html` 的 `PRO.THEMES`(18 個題材,跟板塊輪動**同一份**,陷阱 #37)。要改叫 Claude 改。
- **成員**:每天用 **扣掉大盤之後的殘差相關**(近 120 個交易日)把全市場 2,319 檔重算一次。
  ```
  殘差 = 個股日報酬 − 大盤日報酬      題材殘差 = 成員殘差的中位數
  相關 ≥ 門檻 → 標「連動」
  ```

⛔ **五條不可改掉的設計**(測試 `scripts/test_stocktags.mjs` 16 條,**7 種注入缺陷全部驗過**):
① 🚨 **一定要扣大盤** —— 不扣的話多頭裡每一檔都跟每個題材高相關 = 零鑑別度
   (同 V72.5.2「活躍度不是方向」的同型錯誤)。
② **算某一檔時要把它自己從題材中位數裡拿掉**,否則種子成員拿到灌水的自我相關(實測 0.83 → 0.72)。
③ **門檻用當天分布的 P90**(下限 0.45),兩個數字都寫進輸出 —— ⛔ 不可憑空訂。
④ 👑 **龍頭只能從種子挑** —— 實測 3081 聯亞(光通訊股)靠 0.454 勉強連動進「低軌衛星」、
   又剛好成交值最大 → 被封成「低軌衛星龍頭」。**龍頭是身分,只能由人工確認過的名單產生。**
   ⚠️ 而且 `lead` 的 key 要用**題材**不是股票代號 —— 一檔可能是兩個題材的第一名,
   用代號當 key 會被後面那個蓋掉(實測矽光子的龍頭就這樣整個消失)。
⑤ **種子與連動要長得不一樣**(實心 vs 虛線+相關數字)—— ⛔ 把「它是」跟「它跟著動」畫成一樣 = 說謊。

📊 **實測(2026-08-31,母體 2,319 檔)**:最佳相關中位 0.28 / P90 0.43 / P95 0.51;
門檻 0.45 → **224 檔有標籤(其中 153 檔是自動連動出來的)**。前段班抽驗**全部正確、而且都是種子沒收的**:
2630 亞航→軍工 0.90 ・6215 和椿→機器人 0.78 ・2208 台船→軍工 0.76 ・7402 龍德造船→軍工 0.76 ・
1514 亞力→重電 0.75 ・2375 智寶→被動元件 0.75 ・3189 景碩→ABF載板 0.69 ・2451 創見→記憶體 0.54。

⚠️⚠️ **四個誠實限制(⛔ 文案不可省略)**:
① 這是「**最近跟哪一族走得最像**」,⛔ **不是**「業務屬於這個題材」——
   台股沒有免費的結構化「主要產品/營收比重」來源(V72 已實測 TWSE/TPEX 公司基本資料只有產業別)。
② 🚨 **大型權值股抓不到** —— 台積電佔大盤約四成,它的殘差幾乎等於「大盤扣掉自己」的相反數
   → 跟所有題材都是 0 或負相關(實測最佳只有 +0.05)。**這是方法的結構限制,⛔ 不是資料壞掉**;
   那種股票靠種子表涵蓋(所以 V74.4.8 補了「晶圓代工」題材:2330/2303/6770/5347)。
③ 相關性是**同期**的(評估紀錄⑧的鐵則)→ ⛔ 只能拿來分類,不可拿來預測、不可計分。
④ 全市場 2,319 檔**每一檔都在資料裡**,但只有約一成拿得到題材標籤 ——
   ⭐ 其餘的顯示產業別就好,**「沒有明顯題材連動」本來就是常態**,⛔ 不可為了「都要有標籤」放寬門檻。

#### 🗑️ megatime 降級(⛔ 但不整包丟掉)
- **過時題材黑名單大幅擴充**(`_conceptStaleRe`):Smart TV / Windows / Google眼鏡 / iPad /
  AppleCar / 蘋果供應商 / Intel / 元宇宙 / 五倍券 / 防疫 / 美中貿易戰 / 回台掛牌 / KY股票 /
  越南設廠 / 華為 / 工業4.0 / 3D技術 / 3D感測 / 單獨的「AI人工智慧・5G・手機・網通」…
- 🏢 **集團/公司名自動濾掉**:megatime 有上百個群組其實是**股權關係**(台塑・億光・聲寶・霖園…)
  → ⛔ 沒辦法一個一個列黑名單 → ⭐ **用資料判:這個名字如果是某一檔股票的名字開頭,它就是公司名不是題材**
  (台塑→台塑1301 ✓;記憶體/散熱/光通訊 → 沒有同名股票 ✓)。
- ⛔ **只在「完全沒有題材標籤」時才補位,最多 2 個** —— 留太多會把新的好標籤稀釋掉。
- ⛔ **仍然有效的舊標籤(電動車/車用電子)照留** —— 同 `_SIGNAL_EDGE` 對 C 級的處置,⛔ 不是全刪。

✅ 實測前後對照(真實資料跑出來的):
| | 修前 | 修後 |
|---|---|---|
| 2408 南亞科 | #台塑 #Windows11 #美中貿易戰受惠 #蘋果供應商 #Smart TV | 👑記憶體龍頭 ・🏭半導體業 ・**#記憶體** |
| 2330 台積電 | #Intel #3D感測 #AI人工智慧 #3D技術 | 👑晶圓代工龍頭 ・**#晶圓代工** |
| 2451 創見 | #Intel | **#記憶體 連動54** |
| 2630 亞航 | (無) | **#軍工/無人機 連動90** |

### 📰 外部參考資料的評估紀錄⑯:BDA 期中專案「用新聞與社群預測航運股漲跌」(2026-09-01 使用者上傳)
某大學「大數據與商業分析」期中專案(25 家航運股 × 2022-03 ~ 2024-02 的新聞/Dcard/PTT)。
⭐ 它跟本專案剛開工的 `news_hist.json` 正好是同一件事,所以值得逐行讀 —— 結論存這裡**免得再讀一次**。

#### ⛔ 先講最實際的一件事:**它沒有附資料集**
`data/bda2024_202203-202402_內容數據_新聞{1,2,3}.csv`、dcard、ptt、籌碼 **全部在 `.gitignore` 裡**,
壓縮檔裡只有筆記本 + 結果 CSV + 一個 88MB 的 `model.pkl`。
→ ⛔ **不能拿它的歷史新聞來補本專案的空白**(那是我最想要的東西,但不在裡面)。

#### 🚨🚨 它的數字**有前視偏誤**,而且是教科書級的位置:**特徵選取做在切分之前**
```python
X = vectorizer.fit_transform(data['content_cleaned'])          # 用全部資料 fit
ch2 = SelectKBest(chi2, k=500)
X = ch2.fit_transform(X, data['label_day3'])   # 🚨 用**全部資料(含未來月份)的標籤**選特徵
...
if backtest:  X_train, X_test = X[train_range], X[test_range]   # ← 切分在這之後才發生
```
⭐⭐ 那 500 個詞是「**知道未來答案**」挑出來的 —— 而且 `backtest=True` 走的是**同一支** `feature_extraction`,
所以**連它引以為傲的移動回測 58.75% 也是灌水的**,不只是那幾張 80~90% 的模型比較圖。
⛔ 它的模型比較(task1/task2)另外還用 `train_test_split(shuffle=True)` —— 同一天的多篇文章
標籤完全相同,隨機切分等於把答案抄過去。
⭐ **佐證就在它自己的報告裡**:隨機切分 80~90% vs 移動回測 58.75%,差距那麼大本身就是洩漏的訊號。

#### 📊 我重新算了一次它的回測(用它自己的 `predictions_by_date` 逐日檔,417 個有出手的交易日)
| 版本 | 逐日準確率 | 多數類基準 | 贏基準 | z |
|---|---|---|---|---|
| 特徵 500 | 58.75% | 52.04% | **+6.71pp** | 2.74 |
| 特徵 500 + 籌碼 | 60.10% | 51.54% | +8.55pp | 3.51 |
| 特徵 800 | 55.88% | 52.04% | +3.84pp | 1.57 |
| 特徵 1000 | 56.46% | 52.39% | +4.07pp | 1.66 |
⭐ **基準是 52% 不是 50%**(航運那兩年跌的日子比較多)—— 這點它報告裡沒講。
🚨 **穩定性很差**:21 個月裡 **8 個月低於 50%**,月準確率從 **0.36 到 0.92**。
🚨 **加籌碼那 1.35pp 不穩健**:逐月配對比較,加籌碼比較好的只有 **5/21 個月**
   → ⭐ 跟本專案「籌碼**當天的量**不帶方向資訊」的實測一致(`chips_deep_probe` / `limitup_probe`)。
⛔ 而且**完全沒扣交易成本**(每天進出來回 0.44%),也沒換算成錢 —— 同 V72.0.3 的鐵則:
   **勝率贏基準 ≠ 會賺錢**。

#### ✅ 值得帶走的兩件事(⭐ 這才是這份資料的價值)
① ⭐⭐ **它的回測骨架是對的,而且正好是本專案 `news_hist.json` 成熟後該用的規格**:
   **取連續 3 個月訓練 → 預測第 4 個月 → 往後移一個月**(walk-forward),
   而不是隨機切分。⏳ 等 `news_hist` 累積滿 3~6 個月,第一支新聞探針就照這個做,
   ⛔ 但**特徵選取必須放進每一折裡**(只用該折訓練段的標籤),⛔ 不可像它那樣先對全部資料做。
② **標記規則可以借**:「文章刊登日 D → 看 D+n 天的漲跌;休市順延到最近的開市日」。
   ⚠️ 但它的 **±0.9% 門檻是寫死的** → 照本專案鐵則要改成**相對該標的自己的波動位階**
   (寫死門檻套到低波動股會把幾乎所有日子都丟掉;對航運這種高波動族群才剛好幾乎不影響)。

#### ⛔ 不採用的部分
- **對象是「航運族群加權指數的方向」**,不是個股 → 跟本專案「per-stock 打法」不是同一個問題。
- **CKIP 斷詞 + 1~3gram TF-IDF 需要全文**;本專案 `news_hist` 只存 48 字標題(體積考量)。
  ⚠️ 這是已知取捨:評估紀錄⑫ 實測過「媒體報導那類記者已把重點寫進標題」,
  但要做詞袋模型時 48 字會不會不夠,**要等第一支探針跑過才知道**(⛔ 現在不預先加大)。
- **Dcard / PTT**:本專案沒有社群資料源,而且它自己的比較顯示新聞那組最好。

### 🚨🚨 V74.2.8 用 2022 空頭把「等空頭再說」的探針全部重跑 —— **四條原本全過的當場陣亡**
使用者:「回測這些未完成的,資料不夠就去挖礦,或者拿以前的數據,另外消息面歷史也一樣」。

#### ⭐ 先講最重要的一件事:那批「等空頭」的探針**根本不用等**
`klines_deep` 分支(V74.4.5 回算的 2,535 檔 / 2021-01-04 起)**早就存在**,
本機 `data/*.json` 也**早就合併好了**(實測 2330 有 1,374 根、回溯 2021-01-04)——
⛔ 但除了 `portfolio_backtest` 之外,**沒有一支探針被重跑過**,
LAB 的推薦欄還掛著「把 K 線補深到 2021」與「走完空頭後重跑」兩條**已經做完的事**。
⭐⭐ 通用:**「資料備好了」跟「用它重跑過了」是兩件事** —— 前者做完要當場排後者,
   ⛔ 不可留在推薦欄(那一欄唯一合法的狀態是「還沒做」)。

#### 🚨🚨 而且三支探針**把窗口寫死了**,補深之後那道關卡等於不存在(這條最該記)
| 探針 | 寫死了什麼 | 後果 |
|---|---|---|
| `streak_probe` | **逐年檢定寫死 `['2024','2025','2026']`** | **2022 空頭與 2023 完全沒被檢查到**;而且表格也只印三欄 → 畫面上看不出來 |
| `calendar_stock_probe` | 窗口起點寫死 `'2023-06-15'` | 多出來的兩年半**整段被丟掉**,報告只印一個看起來很正常的窗口 |
| `sector_pick_probe` | 起點寫死 `'2023-09-01'` + 年份寫死四個 | 同上 |
⭐ 三支都已改成**從實際資料推**(年份取樣本裡真的有的年;起點取各檔起始日的第 75 百分位)。
⛔⛔ 通用鐵則:**寫死的窗口/年份,在資料變深的那一刻就開始過期,而過期的守門不會報錯,
   只會安靜地放行。**(同族:V74.0.2 limitup / trustvol「中點用整條日期軸」→ 前半永遠 NaN。)

#### 📉 重跑結果:**四條原本「六關全過」的結論陣亡**(窗口 2022-01 ~ 2026-08)
| 項目 | 舊(3 年多頭) | ⭐ 新(含 2022 空頭) |
|---|---|---|
| 🕯️ 跌停後第一根紅K(**整體**) | ⭐全過 +3.66% | ❌ **2023 是 −0.6pp**(逐年不同向);+2.33% |
| 🕯️ 跌停後紅K × **大紅(≥3%)** | ⭐全過 +5.71% | ✅ **仍全過 +4.33%**(逐年 +0.9/+0.5/+2.5/+7.8/+4.1) |
| 🕯️ 跌停後紅K × **系統性(大盤也在跌)** | ⭐全過 +4.89% | ✅ **仍全過 +3.78%**(五年全正) |
| 🕯️ 跌停後紅K × 個股利空 | ⭐全過 +1.02% | ❌ 2023 是 −1.0;+0.20%、勝率 40.6% < 對照 41.1% |
| 🔻 跌停 × 量縮 / × 系統性(**不等紅K就接**) | ⭐全過 +2.40 / +2.21% | ❌ 兩條都掛(2022/2023 為負)→ **「跌停就接」整組陣亡** |
| 🎯 做夢行情(族群沒動、只有它獨走) | ⭐通過 +0.23% | ❌ **2022 是 −0.34pp** → 七種族群狀態**一個都沒過** |
| 🏭 板塊選對後「板塊內最強」 | ⭐全過 +0.90% | ❌ 2022/2023 都是 −0.4;扣成本仍 +0.34% |
| 🏔️ 創 60 日高後回測不破 | ⭐全過 +0.26% | ✅ **仍全過 +0.29%**,而且**五年逐年全正**(最穩的一條) |
| 🕳️ 向上跳空 × 高位階 | ⭐全過 +0.64% | ✅ 仍全過但**掉到 +0.19%**(很薄) |
| 🏚️ 地板股 ≥300 檔(大盤層級) | +1.5pp(n=51) | ✅ **維持成立**(n=70;5/10/20 日 +1.20/+1.15/+1.50) |
| 🚀 漲停能不能提早知道 | 六關 0 過 | 六關 0 過(不變) |
| 👩 投量比 | 六關 0 過 | 六關 0 過(不變) |
| 📅 行事曆**波動** | 週末 1.09x / 長假 1.43x | ✅ 單調仍成立(1.11x / 1.32x);⛔ 但「月初 1-10 日」降到 1.09x 不顯著 → 收窄成**營收公布日 9~11 日 1.12x** |
| 🐢 0050 七種買法 | 一次全買最多錢 | ✅ 結論不變,⛔ 但**最大回撤從 −28.5% 變 −36.4%**(誠實的數字) |

⭐⭐ **陣亡的四條有一個共同點:它們都是「追強」或「接跌深」** —— 而那兩件事正是空頭最容易受傷的。
⭐ **活下來的三條也有共同點:它們都要求「已經確認」** —— 大紅(力道確認)、系統性(原因確認)、
   回測不破(支撐確認)。⛔ 「跌停就接」「族群沒動它先漲」這種**還沒確認就進場**的全滅。

📍 **前端已同步改口**(⛔ 不可只改 LAB 不改畫面):
`_LD_REDK`(K線頁跌停紅K + 總覽提醒)・`_REGIME_EDGE`(K線頁族群狀態)・`_calDayVol`(當沖頁行事曆波動)。
⚠️ 三支測試的斷言一律改成**從常數讀**,⛔ 不寫死數字(否則每次重跑都要改測試,
   而且會讓人以為是程式壞了);`test_ldredk` 另加一條「渲染端⛔ 不可自己寫死百分比」——
   ⭐ **測試自己也從常數讀 = 兩邊一起錯也會通過**,所以一定要另外釘這條。

⏳ **PE 篩選仍然重跑不了**:它靠 `fund_yoy_gm.json` 的 `qeps`(只有 8 季)→ 窗口仍是 15 個月。
   ⛔ 那不是探針的問題,是財報資料本身的深度。

#### 📈 選股 127 條件重跑(`_SCR_EDGE` 已換掉)—— **排序沒變,幅度縮水,而且衰退是從 2024 開始**
窗口 2022-01 ~ 2026-08、**69,890 個事件**(舊版 37,035);對照組 20 日 **−0.93% / 勝率 39.3%**。
| 條件 | 舊 vs 對照 | 新 vs 對照 | 扣成本後 |
|---|---|---|---|
| 創一年新高 | +3.30pp | **+2.84pp** | **+1.47%** |
| 漲停股 | +2.73 | +2.09 | +0.72% |
| 成交額 >20 億 | +2.51 | **+1.27** | −0.10% |
| 位階高檔(≥75%) | +1.76 | +1.52 | +0.15% |
| 創 60 日新高 | +1.68 | +1.50 | +0.13% |
| RSI >70(超買) | +1.64 | +1.50 | +0.13% |
⭐ **「追強 > 抄底」的排序完全沒變**,成對條件仍然方向相反 → 這條結論**通過了空頭檢驗**。
⛔ 但 96 個測得動的條件裡**六關全過仍然是 0 個** → 這張表的定位仍然是
「**比較條件之間誰比較有用**」,⛔ 不是「勾了就會賺」。

🚨🚨 **逐年拆開最反直覺的一件事:2022 那個空頭年反而是「創一年新高」最有效的一年(+2.37pp)。**
衰退是從 **2024** 開始的:+2.37 → +2.34 → **+1.18** → +1.97 → **−0.01**;
而位階高檔/創60日新高/RSI>70 更早,**2024 就轉負**。
⭐ 所以「這個優勢正在變小」跟「空頭會受傷」**是兩件不同的事**,⛔ 別混為一談。
⚠️ `_scrDecayLine` 的年份**已改成不寫死三年**(重跑之後年數會變);
   測試新增一條「**yrs 的年數要等於 eg 每一列的數字個數**」——
   ⭐ 原本那條「要寫 N 年平均」是**兩邊都從 `yrs.length` 推**的套套邏輯,
   注入驗證當場抓到(把 yrs 砍成三年照樣綠)。

#### ✅ 同時重跑、而且**確認維持成立**的三支(⭐ 這些才是可以放心留著的)
| 探針 | 結果 |
|---|---|
| `sector_rotation_probe`(板塊 20 日動能) | ✅ **一模一樣 +1.44pp**(窗口 775 → **1,214 個交易日**)。而②外資淨流入 ③外資佔成交額比 ④成交額佔比變化(= 最想做成箭頭動畫的那個)仍然全部不成立 → `pro.html` 板塊輪動的兩個軸**不用改** |
| `sixmeridian_probe`(六脈共振) | ✅ 強共振那一級仍六關全過 **+0.80pp**,逐年 +0.29/+0.65/+0.54/+0.77/+1.32 **五年全正**;試單級與點火仍然不成立 |
| `genezone_probe`(位階 × 振幅八格) | ➖ 它**本來就已經涵蓋 2021-04**(所以 `_GZ` 的數字沒變):🧬 那格 +0.60/扣成本 +0.16、高位階**低**振幅 +1.13/+0.69 |
⭐ 把「維持成立」的也寫下來很重要 —— ⛔ 否則下一輪會有人以為「空頭重跑 = 全部推翻」而去改不該改的東西。


#### 🗞️ 消息面歷史:**「無法回測」不是做不到,是沒有人開始存**
本專案已經三次寫下「消息面無法回測」(漲停預測 / 跌停回彈 / 事件研究)——
真因是 `stock_news.json` 是**當前快照、每輪覆蓋**。⭐ 這一類的特性是
**現在不存,一年後還是測不了**(K 線可以回補,新聞不行)。
→ `universal_radar.build_news_history()` + `data/news_hist.json`(滾動 500 天):
`{"days":{"YYYY-MM-DD":{"2330":[[標題,利多利空,分類],…]}}}`。

⛔ **五個刻意的設計**(測試 `scripts/test_newshist.py` 17 條,4 種注入缺陷驗過):
① ⭐ **不存股價** —— 日期 + 代號有了,價格從 `data/{sym}.json` 回推就好。
   存價格只會讓檔案變大,而且多一份可能對不上的真相(同名不同義)。
② **只存守門通過的那幾輪** —— `build_stock_news` 被守門擋下時回 `None`,
   那種輪次的資料是壞的,⛔ 混進歷史之後永遠分不出來。
③ **同一天同一檔同一標題只留一次** —— 一天跑 6~10 輪,不去重會把同一則算很多次。
④ 🚧 **「只增不減」守門要分兩層**(⭐ 這是實作時才發現的):
   ・**腳本內那層**要扣掉「被保留窗口正當裁掉」的天數 ——
     🚨 直接比總天數的話,**窗口滿了之後就永遠拒絕覆蓋**(同一天跑第二輪時今天不是新的一天,
     卻又裁掉一天最舊的 → 總數變少 → 每次被自己擋下),而畫面上只會看到「拒絕覆蓋」,
     **看起來像守門在工作,其實是整個停止累積**。
   ・**真正擋得住「還原失敗」的是 workflow 那層**(`scripts/news_hist_guard.py`):
     腳本自己只看得到本機那份,還原失敗 = 本機沒有檔 → 它會以為「本來就沒有歷史」
     → 寫出只有今天的一份 → 推上去把幾百天洗掉。所以推之前要再跟 **gh-pages 上現有的**比一次。
⑤ 🚨 **守門腳本要先 `cp` 到 `/tmp`** —— 下一步 `git checkout gh-pages`,而**那個分支上沒有 `scripts/`**
   → 少了這行,守門會靜默失敗、等於不存在(CLAUDE.md 記過的同型陷阱)。
⚠️ workflow 也補上「跑之前先從 gh-pages 還原」+ `git add data/news_hist.json`
   (漏 `git add` = 複製回去卻沒 commit → 每天被洗掉且零錯誤訊息,V73.1.3 的教訓)。
⏳ 累積約 3 個月(60 個交易日)後做第一次事件研究,⛔ 在那之前前端不顯示、不計分。

### 🧭 V74.2.7 選股頁改用「總覽邏輯」(使用者:「選股頁面」)—— ⭐ 順手抓到「量測工具自己失真」
`_tomorrowWatchHtml`(明日作戰清單,選股頁預設榜)實測**看到第一檔股票之前要先讀 593 字**。
→ 第一眼只留「**怎麼做**」那一句(⭐ 一天最多做前 2 檔 ・⛔ 不是開盤買,要漲過觸發價且**尾盤 13:00~13:25** 還站得住),
支撐它的實測數字(2 檔 1,718,529 / 3 檔 1,361,088 / 6 檔 735,938 元)與 🧬 排序依據收進
「📊 上面那兩句的實測根據」。✅ **前言 593 → 373 字**,⛔ 一個字都沒刪。

⛔ **四條不可改掉的設計**(測試 `scripts/test_radarlead.mjs` 8 條,4 種注入缺陷驗過):
① 🚨 **一個警告都沒收** —— 不是開盤買 / 尾盤時窗 / 今天大盤風險(`riskLine`)/ 買點提醒 CTA
   全部留在第一眼(⛔ 「不是開盤買」尤其不可收:實測開盤買會把賺頭吃光、跳空>1% 不追反而倒賠)。
② **指令留第一眼、數字進摺疊** —— ⭐ 這是這頁跟前五頁的差別:前五頁收的是「細節卡」,
   這頁收的是「**證據**」。判準:那句話是**要使用者去做/不做某件事**的 → 留;
   它的**根據** → 收(想查的人點得到)。
③ 🧬 那條的「**空頭沒有驗證過**」免責跟著 `hqLine` 進摺疊,⛔ 但不可消失。
④ 摺疊 summary 要**順便顯示 🧬 幾檔已排前面** —— 否則使用者不知道清單順序是怎麼來的。

⚠️⚠️ **量測本身踩了坑(⭐ 這條比改版本身重要)**:第一次量到「27,441 字」——
**那是失真的**。頁面裡 5 個 `<details>` 全是收起的(25,043 字),而 `innerText` 對收起的 details
會**退化成 textContent**,把摺疊內容一起算進去 → 看起來像「這頁爆炸了」,其實攤開只有 2,522 字。
⭐ 正確量法:clone 之後把 `details:not([open])` 的內容拿掉再量(`card_inventory.mjs` 就是這樣做的)。
⭐⭐ 通用:**工具報出來的數字,拿去做決策之前要先驗工具本身**(同 V72.5.6 card_inventory 那次)。

⚠️ **測試第一版的範圍太寬**:斷言②拿「頁面上**所有**收起的 details」當範圍 →
把那三個數字整句刪掉之後 n3/n6 **還是 true**(別的摺疊裡也有那些數字)→ 注入驗證只叫出 1/3 條。
→ 改成只認**這一個**摺疊(summary 含「實測根據」)。⭐ 通用:
**斷言的搜尋範圍要縮到「被改的那一塊」**,否則它會被頁面別處的同樣字串救活 = 假綠燈。

⚠️ 連帶:`test_pbwatch` ②a3 原本釘「一天最多做前 2 檔**就好**」(第一眼那句把「就好」拿掉了)
→ 斷言改釘**實質**不釘尾字;數字仍要在(它只是搬進摺疊)。
⚠️ `_CHANGELOG` 這次超過 80 筆 → 照 V72.1.9 的做法**再搬 24 筆**進 `CHANGELOG.md`(一字未刪)。
🚨 搬移腳本第一版把 `_CHANGELOG` 的結尾判成別的陣列(它的收尾是 **`        ] },    ],`** ——
**最後一筆的結束與整個陣列的結束寫在同一行**)→ 多刪了 500 行程式碼,
`smoke_test` 立刻報 `_migrateKeyArrays is not a function`。⭐ 通用:
**用行號切檔案前,先把「切點那一行」印出來確認**,⛔ 別假設收尾一定自己獨佔一行。

### 🧭 V74.2.6 基本面頁改用「總覽邏輯」—— 個股**六頁到齊**(使用者:「基本面」)
⭐ 這頁**本來就有**骨架(V72.6.0 `pageLeadCorp` 頁首一句話 + 🧬 體質總評 + 完整數據 `<details>`)——
⛔ 但那個 details 掛著 `open` = **摺了等於沒摺**(內層「評分構成因子」「填息歷史」也是)。三個 `open` 全拿掉。

⛔ **三條這頁特有、不可拿掉的設計**(測試 `scripts/test_corplead.mjs` 12 條,4 種注入驗過):
① 🚨 **打開時要 resize 裡面的 ECharts** —— 收起狀態容器寬 0,不 resize 圖就是空的
   (EPS 走勢/月營收/毛利率火花圖都是 `width:100%`)。⚠️ 沙箱 echarts 是 undefined
   → 測試**stub 一個會計數的假 echarts** 才驗得到(陷阱 #40)。
② 🚨 **體質總評算不出來(⏳ 財報資料整備中)→ 自動展開** ——
   ⛔ 理由不是版面好看,是**文案不可說謊**:那段 act 自己寫著「下方已顯示目前拿得到的訊號」。
③ 使用者手動點過就不再自動改(換股票時重置 —— 不同檔資料齊全度不同)。

🚨🚨 **實測發現:`<details>` 的 toggle 事件會被瀏覽器合併(coalesced)** ——
連續改 `open`(程式先開、再關、使用者再開)**只會發一次** toggle,而且帶的是最終狀態。
⛔ 所以「在 toggle handler 裡分辨這次是程式改的還是使用者點的」**天生不可靠**(第一版就是這樣寫,測試抓到)。
⭐ 正解:**使用者動過**改由 `<summary>` 的**實際 click** 記錄,toggle 只留它真正需要做的事(resize)。
⭐ 通用:**要分辨「程式改的 vs 使用者操作的」,一律綁在使用者的輸入事件上,⛔ 別靠狀態變更事件回推。**

⭐⭐ **個股六頁到齊**:總覽・K線・籌碼・即時・當沖・基本面。

⚠️ **順帶查到一個既有問題(⛔ 不是這次造成的)**:`scripts/test_deepbrief.mjs` 有 **9 條紅** ——
深度診斷卡 `deepBriefCard` 走到填內容那條路(`shown=true`)但 `innerText` 量到 **0**。
⭐ 已用 **HEAD 對照 + 逐 commit 回溯**確認 **V74.1.9(今天動工前)就已經是同樣 9 條**。
⏭️ 待查方向:它在總覽 `ovNowMore` 摺疊裡,而同樣在摺疊裡的 `chuMergedCard` 實測 innerText 是正常的
(5,619 字)→ ⛔ 別假設是「details 讓 innerText 歸零」,要先確認 `el.innerHTML` 到底有沒有被寫進去
(可能是背景 `loadBrokerChips` 重繪把它清掉,或 `_deepChipLoading` 卡住)。

### 🧭 V74.2.5 當沖頁改用「總覽邏輯」—— 個股**五頁到齊**(使用者:「接下來當沖頁」)
這頁的第一眼/摺疊分流**不在 HTML,在 JS 陣列**(`renderDayTradeTab` 用 `cards` 組 `#dayTradeBody`):
`cards` = hero(今日當沖作戰指令,含 💰成本關卡)+ **有實測背書**的條件觸發訊號;
新增 `dtMore` = 隔日沖 T+1 預判(講**明天**)、買盤竭盡(未驗證)、損益試算機(工具)。
✅ 實測第一眼 **2,015 → 387 字**(−81%),⛔ 一張卡、一個字都沒刪。

⛔ **四條不可改掉的設計**(測試 `scripts/test_dtlead.mjs` 13 條,4 種注入驗過):
① 🚨 **hero + 成本關卡必須在摺疊外** —— 成本關卡是「能不能當沖」的**先決條件**,收起來等於把門檻藏了。
② 🚨 **有實測數字的訊號⛔ 不可收**(漲停隔日動能 +1.54%);**未驗證的**(買盤竭盡)才收 ——
   ⭐ 這條分流原則跟 `_SIGNAL_EDGE` 對 A 級 / C 級的處置一致。
③ `dtMore` 空 → 整個摺疊不吐出來(⛔ 不留點開什麼都沒有的橫條,同 V74.2.4)。
④ ⭐ **收起 ≠ 停用**:損益試算機的 `<input>` 在收起的 `<details>` 裡**仍在 DOM**,
   `_calcDayTradePnl()` 照樣抓得到(測試 ④ 實際改值算一次驗證)—— ⛔ 別因為看不到就以為要改。

🚨 **順手修的版面順序問題**:`#dtScanCard`(當沖候選掃描,掃的是**別檔**)原本排在 `#dayTradeBody` **上面**
→ 一開頁第一眼是別人的清單,不是「這檔今天怎麼做」。已對調(⚠️ 掃描的自動觸發與推播不受位置影響)。
⭐ 通用:**排序也是「總覽邏輯」的一部分** —— 第一眼必須是當前標的的結論。

⭐⭐ **個股五頁到齊**:總覽(V72.4.7)・K線(V74.2.2)・籌碼(V74.2.3)・即時(V74.2.4)・當沖(V74.2.5)
= **第一眼只有結論 + 該頁主內容,其餘收「📖 更多解讀」,風險/告警與有實測背書的訊號永遠不收**。
📉 全 App 攤開字數 **7,349 → 5,675**。⏭️ 還沒套的:回測頁(1,815)、總覽 entry/exit(各 211 攤開但摺疊 ~2,000)。

⚠️ **測試又踩「猜實際輸出」**(本 session 第 3 次):斷言試算機輸出時猜成 `dtPnlResult`/`dtPnlOut`,
實際是 **`#dtResult`** → 假失敗。⭐ 一律先去看那支函式寫進哪個元素,⛔ 別猜。

### 🧭 V74.2.4 即時頁改用「總覽邏輯」—— 四頁到齊(使用者:「即時頁面也依照邏輯做」)
`#liveLead`(頁首,轉述 `_dayTradeVerdict`)+ 分時圖(主內容)+ `<details id="liveMoreWrap">`
(當沖總結燈完整卡含進場檢查明細 + 盤中作戰室)。
⚠️ **這頁沙箱量不準**(多數卡要 Fugle 金鑰 + 盤中才有內容,陷阱 #40)→
測試一律**直接餵資料呼叫渲染函式**,⛔ 不靠「今天剛好有沒有盤中資料」。

⛔ **四條不可改掉的設計**(測試 `scripts/test_livelead.mjs` 14 條,4 種注入驗過):
① 頁首只轉述 `v.verdict`/`v.sop`/`v.warns`/`v.chkOk`(⛔ 不重算);`v` 算完**立刻**給頁首,
   **含 `v=null` 的情況**(⛔ 否則盤後會殘留上一檔的「操作」那句)。
② 🚨 **「別追多警訊」的內容要露在頁首**(⛔ 只寫「有 N 條」= 沒提醒);沒警訊時整行不顯。
③ ⭐ **`_syncLiveMore()`:兩張卡都沒內容 → 連摺疊外殼一起收** ——
   ⛔ 否則盤後/沒金鑰會留一條「點開什麼都沒有」的橫條(這是把摺疊套在**條件觸發**卡片上時的必要配套,
   跟 K線/籌碼那兩頁不同 —— 那兩頁的卡幾乎恆有內容)。四個 render 出口都要呼叫。
④ `_clearLivePanels` 的清空清單要含 `liveLead`/`dayTradeLight`/`intradayWarRoom` + 呼叫 `_syncLiveMore`。

⭐ **四頁到齊後的統一版面**:總覽(V72.4.7)・K線(V74.2.2)・籌碼(V74.2.3)・即時(V74.2.4)
= **第一眼只有結論 + 該頁的主內容,其餘收「📖 更多解讀」,風險/告警永遠不收**。
⛔ 新增任何個股頁卡片前先問:它是「結論」還是「細節」?細節一律進摺疊。

⚠️ **測試取樣的老坑再犯一次**:靜態斷言用 `SRC.slice(f, f + 3000)` 取函式原始碼 →
**越界到下一個函式**(`renderDayTradeLight` 本來就該呼叫 `_dayTradeVerdict`)→ 假失敗。
⭐ 一律切到 `\n    },` 為止;**斷言前先確認取樣的是不是你以為的那一段**(本 session 第 2 次)。

### 🧭 V74.2.3 籌碼頁改用「總覽邏輯」(使用者:「依照之前邏輯做籌碼頁面」)
📊 **先量再改**(⛔ 憑印象砍卡是危險的):`card_inventory` 實測籌碼頁攤開 **2,538 字 = 全 App 最重的一頁**
(主結論卡 `chipVerdictCard` **1,489** + 明日劇本 `chipScenarioSlot` **613**)。
→ `#chipLead`(頁首,**390 字**)+ `<details id="chipMoreWrap">`(完整三張卡)。
✅ 實測第一眼 **2,538 → 864 字**(−66%),⛔ 一張卡、一個字都沒刪。

⛔ **四條不可改掉的設計**(測試 `scripts/test_chiplead.mjs` 15 條,4 種注入缺陷驗過):
① **頁首只轉述、⛔ 不重算** —— `renderChipVerdict` 算完後把 `{big,bigCls,bcls,score100,scoreCls,scoreLbl,act,sc}`
   傳給 `_renderChipLead`(同一批變數 → 不產生第二份真相);測試直接禁止它裡面出現 `_chipPeriodSums`。
② 🚨 **融資追繳風險改露在頁首** —— 它原本埋在「籌碼進出」**分頁** →「📊 看原始數據」**摺疊** → 融資券卡裡,
   **兩層收合 + 非預設分頁**,等於使用者永遠看不到(陷阱 #32 的實例)。⛔ 風險/告警類不可只放在收合裡;
   ⚠️ 但仍是**條件觸發**(`level==='safe'` 或算不出來就整段不顯,別留噪音)。
③ 「🧭 其他籌碼指標怎麼說」(方向分歧提醒)留在頁首 —— 那正是「不用自己比對三張卡」的重點。
④ 兩個早退分支都要 `_leadOff()`(⛔ 不殘留上一檔的結論);頁首⛔ 不給價位、指路總覽。

⚠️ **測試自己犯的兩個錯(都是「測資/前提錯,不是程式錯」)**:
① 靜態斷言寫 `_leadOff()` 出現 ≥3 次 —— 但定義那行是 `_leadOff = ()`(**不含** `_leadOff()`)→ 實際 2 次。
② 動態用 `renderChipVerdict('9999')` 想製造「沒資料」—— **前提就是錯的**:那支讀的是 `this.rawDailyData`,
   換 sym 不會讓它沒資料 → 那條等於沒驗到。⭐ 正解是把 `rawDailyData` 清掉,並補一條**空過守門**
   (資料還原後要能再顯示回來,否則「收掉」可能只是它壞了)。

⭐ **順帶查清一件事(V74.2.2 的疑慮解除)**:`<details>` 收起時 `innerText` 會退化成 textContent,
但**長度仍非零** → `_sweepEmptyShells`(用 `innerText.length===0` 判空殼)**不會**誤藏摺疊裡的卡。
⚠️ 受影響的只有「**片語比對**」(text 內容與換行不同),那正是 `test_kchip_audit` 那次超時的原因。

### 🧭 V74.2.2 K線頁改用「總覽邏輯」(使用者:「K線頁面我也要用總覽邏輯做」)
總覽邏輯 = V72.4.7/V73.7.0 那套:**第一眼只留一句話結論 + 主內容,其餘全收「更多解讀」摺疊、一張不刪**。
K線頁新版面:`#klineLead`(頁首一句話)→ `heavyReboundCard`(告警,**摺疊外**)→
`<details id="chartMoreWrap">`(朱老師總評 + 六脈 + K棒戰法 + 教學)→ K線圖(sticky 不動)。

⛔ **五條不可改掉的設計**(測試 `scripts/test_klinelead.mjs` 13 條,3 種注入缺陷驗過):
① **頁首條由 `renderKbarTactics` 同步渲染**(同一份 sigs/good/risk → 不產生第二份真相);
   三個分支都要寫:有訊號(_headline)/ 沒訊號(➖ 不做等表態,⛔ 不留白)/ 資料不足(收掉,⛔ 不殘留上一檔)。
② 🚨 **風險收進摺疊的交換條件:頁首要列出風險「標題」**(⚠️ 風險提醒 N 條:XX・XX)——
   只寫「有 N 條」= 沒提醒(多空不對稱鐵則)。告警類(heavyReboundCard)整張留在摺疊外。
③ **六脈亮「強共振」時頁首露一行**(唯一六關全過的複合訊號,V74.1.9)—— 條件觸發、附實測 +0.80、
   ⛔ 不下指令、⛔ 空頭(`_bearGate`)不露(講反話鐵則)。
④ 摺疊⛔ 不可掛 `open`(掛了等於沒摺);頁首⛔ 不給價位、必須指路總覽(單一劇本原則)。
⑤ 頁首不用紅綠 emoji 當風險燈(✅/⚠️/➖)。

🚨🚨 **`<details>` 是「原生」隱藏 —— 沙箱測試會被它咬到**(⭐ 這條是陷阱 #40 的新亞種):
沙箱連不到 Tailwind CDN → `.hidden` 失效 → 以前「藏起來的卡」在測試裡其實是**渲染中**的,
`innerText` 讀到的是渲染後文字;搬進**收起的 `<details>`** 後是**原生**不渲染(不靠 CSS),
`innerText` 退化成 textContent → 片語比對失準。實例:`test_kchip_audit` ⑤ 的全市場掃描
從「掃幾檔就命中」變成**掃完 2,600 檔都不命中 → 超時**,而且**看起來像測試環境慢**。
→ 修法:測試開場 `chartMoreWrap.open = true` 還原讀取語意(⛔ 不代表正式環境預設打開)。
⭐ 通用:**把卡片搬進 `<details>` 時,grep 所有讀那些卡 `innerText` 的測試/工具**;
⭐ 診斷法:先拿 **HEAD 版對照跑**同一支測試(15 秒分出「我的改動」vs「環境變慢」)。

### 🗑️ V74.2.0 雜訊清洗收尾:「沒用的就刪除」—— 4 個實測沒用的功能整段移除
使用者:「請繼續,另外沒用的就刪除」→ 從「收起」升級成**刪除**(照 V70.3.1 模式:拆 DOM/顯示,函式留 no-op 墓碑)。

#### 🎯 刪之前先驗掉最後一個懸念:隔日沖 pooled 全市場重驗(`scripts/dtflip_probe.mjs`)
逐檔版只有 12~19 次樣本 = 「驗不出」不是「驗出沒用」→ pooled 才有資格刪。
**2,329 檔 ・對照組 2,709,058 個(股·日)**;型態與勝負定義**逐字照抄** `_dtWinRateBacktest`;
事件與對照組**一致地**排除「隔天開盤仍鎖漲停」(⛔ 只排一邊會偏):
| 型態 | n | 碰 +1.5% | vs 基準 31.1% | **務實損益**(碰1.5%停利否則收盤出,扣 0.25%) | vs 基準 −0.395% |
|---|---|---|---|---|---|
| 爆量長紅 | 57,130 | **58.5%** | +27.4pp | **−0.46%** | −0.07pp ❌ |
| 爆量突破 | 45,697 | **53.5%** | +22.4pp | **−0.48%** | −0.08pp ❌ |
| 漲停後沖 | 34,400 | **71.6%** | +40.5pp | **−0.30%** | +0.10pp(逐年同向 ✅ 但 ≪ 成本)|
⚠️ K 線深歷史合併後窗口涵蓋 2021 起(dtflip 是這批探針裡第一支直接吃到深資料的)。
⭐⭐ **「碰得到 ≠ 賺得到」**:盤中最高價只是「碰到過」,不是你賣得到的價;
用做得到的出法一扣成本,50~72% 的「勝率」全變負期望值。⛔ 這是「測得到、賺不到」家族第二例
(第一例是漲停預測 `limitup_probe`)。⭐ 任何用「盤中最高 ≥X%」當勝負定義的回測,都要配一條務實出法。

#### 🗑️ 刪了什麼(墓碑都留在原地,依據寫在註解與 LAB)
| # | 刪除 | 依據 |
|---|---|---|
| D1 | 當沖作戰室「🎯 隔日沖勝率回測」段(`_dtWinRateBacktest` 挖空成 no-op,死體 60 行移除) | 上表;逐檔版樣本又只有十幾次 |
| D2 | 「🏦 法人近20日推估成本」整卡(chipRadarPanel DOM + `_renderChipPanel` no-op) | `instcost_probe`:±0.2pp、六關 0 過。⚠️ **`fetchChipCost` 照跑** —— 它同時餵 `chipCostInput` 的主力成本,那半是活的 |
| D3 | 「📊 5日訊號準確度排行」整卡(predictionAuditCard DOM;`renderPredictionAudit` entry 找不到 DOM 自然 no-op,連帶 `_backtest5DaySignals` 不再被觸發) | 只用自選 ≤30 檔小樣本,已被全市場 `_SIGNAL_EDGE` 取代 |
| D4 | 「🔴 盤中連量偵測」卡(V73.6.0 曾降級進摺疊,這次移除) | 兩次實測不成立且方向相反(volstall/volseq)。⚠️ **`_detectVolStreak` 保留**(偵測器母體要用),只拆顯示 |
⭐ **dtHubBody 解除收起**(從 `_TIDY` 移除)—— 剩下的期貨夜盤守門/正逆價差/隔日沖風險判讀是誠實描述。
`_TIDY` 只剩 2 張:etfFollowCard(等 mgr_hist,約 2026-12 可測)+ bullBearCategoryCards(明細不是沒用)。

⛔ **連帶要改的呼叫點/測試(陷阱 #37 清單,刪卡時照這份掃)**:
`_EMPTY_SHELLS` 白名單、`analyze()` 切股清空清單、`test_tidy`(觀察者測試從 chipRadarPanel 換 etfFollowCard;
新增 ⓪d/⓪e 釘「已刪的不可回清單 / DOM 真的不在」)、`test_emptyshell`(測試容器換 brokerWarRoom)、
`test_wrsample` ②(改釘「永遠回空 + 墓碑引用 dtflip_probe」)、`test_dtverdict` ⑧(註解更新)。
⚠️ 墓碑的依據要寫在**函式體內**的註解 —— `Function.toString()` 不含函式外的註解,寫在外面測試釘不到。

### ⚔️ V74.1.9 六脈全市場實測 —— **「驗到有用就加回來」的第一個實例**
`sixmeridian_probe.mjs` 跑**真的** `_sixMeridianCalc`(⛔ 不複製判定邏輯),
2,240 檔 ・對照組 **702,197 個(股·日)** ・訊號日收盤進出、扣同期加權(跟 `_SIGNAL_EDGE` 同口徑):

| 卡片結論 | n | 20日邊際 | 逐年 | 扣成本 | 六關 |
|---|---|---|---|---|---|
| 🔴 強共振・買點 | 56,435 | **+0.80pp** | 全正(+0.29→+1.32) | **+0.36** | ✅ **全過** |
| 🟡 右側第1點(原「試單」) | 76,484 | +0.02 | 混 | −0.42 | ❌ |
| ⚡ 點火(低分→高分+放量) | 24,858 | +0.24 | 全正但小 | −0.20 | ❌ |
| ⚖️ 多空未定 / 🟢 訊號不足 | 17 萬 | −0.07 / −0.37 | | | ❌ |

**處置**:卡從 `_TIDY` **拿掉(加回來)**;🔴 sop 附實測數字;
🟡 verdict 從「試單」改「觀察」、sop 明寫「實測沒有邊際,⛔ 別單憑這個進場」
(沒贏基準不給操作指令的鐵則)。LAB ok 欄 r:40。

⭐⭐ **兩個必記的教訓**:
① **60 檔試跑跟全市場結論完全反過來**:試跑時 ⚡ 點火「六關全過 +1.31」、強共振逐年不同向;
   全市場後點火只剩 +0.24 ❌、強共振六關全過 ✅ —— **小樣本連「哪一級有用」都會判反**,
   ⛔ 試跑只能拿來驗管線,不可拿來下結論。
② 🚨 `push(...大陣列)` 爆堆疊 —— **CLAUDE.md 已記過兩次、這是第三次踩**(baseYr 單年 17 萬筆),
   而且爆在**跑完 7 分鐘之後的報表階段**(浪費一整輪)。三支探針同型寫法一起修(陷阱 #37)。
③ ⚠️ 注入驗證的還原**一律用備份檔**,⛔ 不可 `git checkout`(V74.1.9 實錯:把未提交的修正連注入一起丟掉,重做一遍)。
④ ⚠️ 「禁止出現某句話」的斷言:全形括號原文用半形括號寫 regex = **捕獲組 = 空包彈**
   (`/先試單(半量)/` 配不到「先試單(半量)」)→ 改 `String.includes`,注入驗過。

### 🗂️ V74.1.8 雜訊清洗第二波 —— **收起之前先驗掉**(法人成本當場實測)
使用者:「第二波繼續做,把要驗證的加到實測總表裡面待驗證」。
⭐ 兩張候選其實**現在就測得動** → 直接驗,⛔ 不掛「待驗證」佔位:

**🏦 法人推估成本(`chipRadarPanel`)—— 驗完收起,`instcost_probe.mjs`**
成本公式照卡片同一條(近 20 日**淨買超日**加權均價)。2,305 檔、對照組 79,333 個(股·日):
| 事件 | 邊際 | 扣成本 |
|---|---|---|
| 現價在法人成本之上 | +0.20pp | −0.24 |
| 之下 | −0.24pp | −0.68 |
| 剛站上 / 剛跌破 | +0.10 / −0.15pp | 全負 |
**方向「對」但全部小於來回成本 0.44%、六關 0 過** → 是描述不是訊號 → 收起,數字寫在提示列。

**🎯 當沖作戰室隔日沖段(`dtHubBody`)—— 收起**:每檔樣本只有 12~19 次、最強只贏基準 2pp(雜訊內)。
正確驗法(pooled 全市場同一條勝負定義)已入 LAB `next` 欄。

**⚔️ 六脈(`_sixMeridianCalc`)—— 全市場探針進行中**(`sixmeridian_probe.mjs`,跑**真的**函式):
60 檔試跑:🔴 強共振 +0.69pp(逐年不同向 ❌)・⚡ 點火 +1.31pp 六關全過 —— 等全市場定案再入 LAB。

⭐ **機制補強:卡自己藏起來時,提示列也要跟著藏**(MutationObserver 盯 class+內容)——
法人成本卡沒金鑰/沒資料時整卡 hidden,⛔ 那時還顯示「已收起」= **幫一張本來就看不到的卡道歉** = 新的雜訊。
測試 `test_tidy.mjs` ⑤⑥(注入「拿掉 observer」驗過)。

⚠️ **第一波的一個誤判要記下來(陷阱 #40 又一次)**:我原本提議第二波收「🔮 此股預判 AI 空殼」——
查了才發現那顆按鈕**在正式環境早就整段 hidden**(V44.4/V46.3)。沙箱連不到 Tailwind CDN、
`.hidden` 沒生效,盤點工具把「正式環境看不到的東西」量成看得到 → **盤點清單要先過一次
「這在正式環境真的顯示嗎」再下判斷**。

### 🗂️ V74.1.7 散戶救星「雜訊清洗」第一波 —— 精簡檢視機制(`_TIDY`)
使用者:「我現在已經有回測成功率高的資料,我想要清洗裡面的雜訊…看的人因看太多不知道到底要看誰,
先使用折疊或隱藏還是刪除…未來如果我有驗到有用的雜訊再加回來,所以逐一檢視」。

⛔ **憑印象砍卡是危險的(陷阱 #31)→ 先跑 `card_inventory.mjs` 量過**(107 張卡、13,020 攤開字),
再對照實測總表逐張判斷。第一波收 4 張,每一張都有實測依據:

| 收起的卡 | 頁 | 依據 |
|---|---|---|
| `etfFollowCard` ETF 跟車狀態 | 總覽/now | **驗不了**(V72.9.8:持股變動歷史 2026-08 才開始存)而且佔 now 頁第一眼一大塊 |
| `sixMeridianCard` 新六脈共振 | K線 | **複合訊號沒回測過**,卻給「試單/加碼」指令 —— 未驗證的卡不該下指令 |
| `bullBearCategoryCards` 29 條明細 | 多空 | 純明細,結論已在上方計分條 |
| `predictionAuditCard` 5日準確度排行 | 回測 | 只用自選做小樣本回測,已被全市場 129 訊號實測表(`_SIGNAL_EDGE`)取代 |

⛔ **機制的五條鐵則**(測試 `scripts/test_tidy.mjs` 17 條,4 種注入驗過):
① **收起 ≠ 刪除** —— 卡還在 DOM、render 照跑;要加回來刪 `_TIDY` 一行即可(可逆,正是使用者要的)。
② **原地留一行「收了什麼、為什麼」+ 點開鈕** —— 靜默消失使用者會以為壞掉(陷阱 #22)。
③ 🚨 **風險提醒/官方處置類⛔ 一律不收**(多空不對稱鐵則:忽略風險的代價遠大於多看一眼)。
④ ⚠️ **用 `data-tidy` 屬性 + CSS `!important`,⛔ 不用 classList** ——
   這些卡的 render 會自己 `classList.remove('hidden')` 把卡打開,class 壓不住。
⑤ 清單 id 打錯字 = 那張卡**靜默沒收**、零錯誤訊息 → 測試 ④ 直接驗「id 全部存在於 DOM」。
⚠️ 測試的防禦性讀取:注入「提示列沒插進去」時第一版是**整包炸掉**(uncaught)而不是斷言紅
   → querySelector 後面一律給 fallback,讓注入乾淨地紅。

**⛔ 檢視過但刻意不收的**(免得下一輪又提一次):
・`chipScenarioSlot` 籌碼劇本 —— 裡面掛著**實測過關**的 `_chipRunBuy`(C 訊號),而且過期時已誠實標示
・`strategyMainBox` 摺疊區(進場劇本/四關卡/上檔空間)—— V72.4.7 使用者自己要求收的,⛔ 別展開
・`dayTradeBody` / `playbookCard` / `chipVerdictCard` —— 主卡,實測數字都在卡上
・`dtHubBody` 隔日沖鐵律段 —— 16% vs 基準 14% 邊際薄,**候選第二波**(先留)

### 🧬 V74.1.6 「能不能加其它半透明區?買進/加碼/過熱要賣」—— **先量再畫,結果三個都不畫**
使用者:「附圖目前有高位階高波動圖示,沒有辦法新增其它半透明圖示?應該有可以買進時間、
還是加碼時間、高檔過熱要賣等等,我沒有想到的,這樣有沒有用」。

⛔⛔ **憑感覺畫框正是本專案批評別人最多次的那件事**(憑空門檻 + 沒驗證過的預測性主張)
→ 寫 `scripts/genezone_probe.mjs` 把這張圖切成 **位階 4 段 × 振幅 2 段 = 8 格**先量一遍。
**2,327 檔 ・對照組 120,135 個(股·日)・2021-04 ~ 2026-07 ・未來 20 日扣同期加權
・進場=隔天開盤(已排除鎖漲停)・同檔同格 20 日去重。**
⚠️ 對照組本身是 **平均 −1.08% / 中位 −2.22% / 勝率 38.9%** —— ⛔ 基準不是 0 也不是 50%。

| 格 | n | 邊際 | 中位差 | 勝率 | 去最好年 | 扣成本 |
|---|---|---|---|---|---|---|
| 位階 ≥75 × 振幅 <3.2% | 27,200 | **+1.13** | **+0.86** | **43.1%** | +1.13 | **+0.69** |
| 位階 ≥75 × 振幅 ≥3.2%(🧬 現行框) | 26,483 | +0.60 | **−1.49** | 38.5% | +0.47 | +0.16 |
| 位階 50~75 × 低振幅 | 30,793 | +0.17 | +0.57 | 40.2% | +0.07 | −0.27 |
| 位階 50~75 × 高振幅 | 16,707 | −0.36 | −1.24 | 36.6% | −0.41 | −0.80 |
| 位階 25~50(兩格) | 49,712 | −0.23 / −0.64 | | | | |
| 位階 <25 × 高振幅 | 15,619 | −0.51 | −0.69 | 38.3% | −0.59 | −0.95 |
| **位階 <25 × 振幅 <3.2%** | 45,635 | **−0.69** | +0.02 | 37.6% | −0.76 | −1.13 |

⭐⭐ **橫軸單調:−0.64 → −0.35 → −0.02 → +0.87pp(位階四段加權)** ——
**越貴越強的那一邊比較好**,跟本站其他實測同向(RSI>70 +1.64pp、創一年新高 +3.30pp、
「等回檔再買」21 個有 18 個負)。

#### ❌ 使用者說的三個框,量完之後**一個都不畫**
| 他想要的 | 實測 |
|---|---|
| 「高檔過熱要賣」區 | 🚨 **方向剛好相反** —— 位階 ≥75 兩格都是正的、位階 <25 兩格都是負的 |
| 「買進時機 / 加碼時機」區 | ⭐ **這張圖兩個軸都是「位置」不是「時機」**。硬量的話唯一量得到的是「進 🧬 框幾天了」:剛進 **+0.52** ・2~5 天 **+0.44** ・6~20 天 **+0.89** ・>20 天 **+0.62pp** —— **沒有單調、差異在雜訊內**,而且沒有一格扣掉成本 0.44% 站得住 |
| 「掉出框就該賣」 | ❌ 剛掉出框之後 20 日是 **+0.42pp**(還是正的)|

#### ✅ 實際畫上去的只有兩個(⭐ 都有數字撐)
① **左下角「⛔ 實測最弱」半透明區**(位階<25 × 振幅<3.2%,−0.69pp、去最好年 −0.76、前後半同向)
② **X 軸下方「位階四段的實測期望值」條** —— ⭐ 這才是使用者要的「其它半透明圖示」的正解:
   **每一格都標數字**,⛔ 不敢標數字的格子就不畫框。
⛔ 兩個都用**琥珀/灰**不用紅綠(講的是「有沒有用」不是漲跌方向)。
⛔ 數字全部**現算自 `_GZ`**,測試 ㊷c 換一張假表驗畫面跟著變。

#### 🚨🚨 反直覺、而且必須誠實講的一件事:高位階配「**低**」振幅反而比 🧬 那格好
+1.13 vs +0.60、中位 **+0.86 vs −1.49**、勝率 43.1% vs 38.5%、扣成本 +0.69 vs +0.16。
⛔ **但這不推翻 🧬** —— **兩者問的不是同一件事**:
・這支探針問「**隨便買一檔在這格的股票、抱 20 天**」
・🧬 的 +289.6 萬問「**在打法訊號觸發的候選裡**再用位階+波動篩、尾盤進場、跌破 5 日線出場、每天 2 檔」
⭐ 看中位數就懂了:🧬 那格是**賠率型**(中位是負的,靠少數大賺),高位階低振幅是**勝率型**
—— **有出場機制砍得快的時候,賠率型才划算**。
⭐⭐ 通用鐵則:**同一個條件在「單獨抱著」與「配上進出場機制」下的結論可以完全不同**,
⛔ 不可拿其中一個去否定另一個(同 V74.4.1「🧬 在強勢板塊內沒過關 ≠ 它失效」)。

⚠️ **八格沒有一格通過「逐年同向」那一關**(🧬 那格 2021 −0.08 / 2022 −0.33,2023 起逐年變強
+0.30/+0.63/+1.35/+2.35)→ 這些數字是**比較用**的,⛔ 不是保證。卡上有寫。

#### ⚠️ 探針自己踩到的坑
**中點要用「事件日期的中位數」,⛔ 不可用「所有檔案出現過的日期」的中間值** ——
第一版算出中點 **2022-10-26**(因為有老股回溯到 2000 年),前半段幾乎沒有樣本
→ 「前後半同向」那一關等於沒作用。改成依樣本數取中點後是 **2024-03-20**,
🧬 那格的前半從 −0.24 變成 +0.20(結論跟著變)。這是 V74.0.2 `limitup_probe` 的**同型再犯**。

### 🌊 V74.1.5 「資料跳很快」的真因**不是窗口太短** + 六項板塊輪動改版
使用者六點:①用 5/10 日會不會比較平滑 ②兩邊版本號一致 ③兩張圖做切換頁籤+一樣大
④自訂日期區間+快選+區間前3名 ⑤說錯的修正 ⑥播放列放到泡泡卡上方。

#### ⚠️ ① 要先糾正的一件事:**軸上的值本來就不是「單日」**
橫軸是「**近 20 日**報酬中位數」、泡泡的振幅也是 20 日 —— 已經是平滑過的量。
真正在跳的是「**時間軸每一格 = 一個交易日**」:20 日窗口相鄰兩天共用 19 天資料、
只換掉頭尾各一天,換到的那天如果大漲大跌,整條就抖一下。
⛔ **所以不可以「改成 5 日報酬」** —— 那會變成另一個指標,+1.44pp 那組實測就不能用了
(實測 5 日窗口只有 +0.81pp、吃不掉來回成本 0.44%)。
⭐ 正解:對**已經算好的序列**再取一次移動平均(`_sm`,關/5日/10日),
**⛔ 只影響顯示** —— 排名、區間前 3 名、所有實測數字全部照原始序列算。

#### 🔢 ② 兩邊版本號一致(⛔ 只改一邊比沒有更糟)
`pro.html` 是**獨立檔案**,沒辦法 import index.html 的 `_APP_VERSION` → 只能各存一份
(`PRO.VER`),靠測試 ㊳ 直接比對兩個檔案擋住「只改了一邊」。
⛔ **不可拿掉那條測試** —— 一個對不上的版本號比沒有版本號更糟(使用者會以為已經更新了)。

#### 📊 ③⑥ 兩張圖切成頁籤 + 播放列移到圖卡上方
`_rotChartTab`('trend' / 'bub');兩張圖同尺寸(340×430,實測都是 296×374)。
⛔ **頁籤列與播放列必須在靜態區(只建一次)** —— 放進 `rotOneTop` 的話每一拍重建,
泡泡的 CSS transition 會被洗掉(**第四次**踩同一個坑),播放鈕的文字也會被還原。
⛔ 切頁籤**只改 `display`,不重建**(測試 ㊶c 直接禁止 `rotChartTab` 裡出現 `innerHTML`)。
⚠️ 兩條滑桿要同步(`rotSeek` 一起更新 `rotSlider` / `rotSlider2`)。
⚠️ **「成分股對不上」那行提醒⛔ 不可放進泡泡頁籤裡** —— 藏在頁籤後面等於沒說(陷阱 #22)。

#### 🚨 順手抓到自己上一版留下的版面 bug:「⏭ 回到最新」害圖上上下下
V74.1.3 我把它做成「只在不是最新那天才出現」,還把「⛔ 不佔平常的版面」寫進 CLAUDE.md
—— **那是錯的**:多出來一顆鈕會讓控制列換行,底下的圖整個往下推 **11px**,
正是使用者最早抱怨的「上上下下」。測試 ㉒d2(釘住 svgTop 不可變)當場抓到。
⭐ 正解:**讓日期本身可以點**(`2026-08-25 ⏭回最新` / `2026-08-29(最新)`)——
同一個元素、字數接近 → 不會換行。
⭐⭐ 通用:**任何「條件出現/消失」的控制項都會改變版面高度** ——
   要嘛保留位置,要嘛塞進既有元素;⛔ 別在 sticky 控制列裡增減元素。

#### 📅 ④ 日期區間 + 區間前 3 名
快選 近5/近20/近60/全部 + 自訂起訖(`<input type="date">`)。
⛔ **使用者挑的日子不一定是交易日** → 取「範圍內真的有的那幾天」,⛔ 不硬對索引;
完全沒有交易日要**說出來**(⛔ 不可靜默)。選了區間 → **滑桿範圍跟著縮**(不縮的話「區間」只是裝飾)。
🏆 前 3 名用「**區間內平均相對強弱**」排,並同時列最弱 3 個
(⭐ 實測避開最弱比追最強更有價值:+0.63pp vs −0.80pp)。
🚨 **必須寫明「這是那段期間誰比較強,⛔ 不是照這套做會賺多少」** ——
   +1.44pp 是「**每天**買前 3 名、看未來 20 日」量出來的,⛔ 不能拿一段固定區間的排名代替。

⚠️ **注入驗證的誠實紀錄**:8 種注入,**2 種抓不到**。
① `rotChartTab` 裡那次 `_stockBubSeek` 拿掉照樣綠 —— 因為 `rotSeek` 本來就會呼叫它(藏著也照跑)
→ 那行是**保險不是主路徑**,已寫進註解免得下一個人以為測試有釘住它。
② 泡泡頁籤沒切到就量 → 量到 `display:none`(高度 0、innerText 空)= 假失敗;
   測試改成 `openBub()` 先切頁籤(陷阱 #40 的又一次)。
測試 `scripts/test_prohtml.mjs` ㊳~㊶e(共 16 條)。

### 📐 V74.1.4 泡泡圖太小 + 剩下五項一次做完(使用者:「還沒做的都做 / 起泡版面那面小」)

#### 🚨 「圖太小」的真因是**畫布比例**,不是 CSS 寬度
`.sbub svg{width:100%;height:auto}` → **viewBox 的長寬比決定它在手機上多高**。
340×210(寬 1.62 倍)在 390 寬的手機上只有約 **216px** 高 → 泡泡跟名字全擠成一團。
→ 改直式 **340×430**(同板塊版 340×460 的做法),實測 296×183 → **296×374**。
⭐ 高度加倍就要**把刻度加密**(0/25/50/75/100% 各一條水平參考線 + X 軸刻度)——
⛔ 否則中間一大片沒有參考線,位置一樣不可解讀(V74.3.7 那條教訓的延伸)。

#### 🏷️ 名字疊在一起:⛔ 不可動泡泡座標,只推「名字」
使用者截圖:「台達化」「夏」糊成一團。⛔ 動泡泡本身 = 圖就是假的。
→ `_stockBubSeek` 收集實際座標後,x 靠近(<40px)且 y 靠近(<12px)就把**文字**上下錯開,
交替 `0 → −12 → +12 → −24 → +24…`,⭐ **每試一次都要重新檢查**
(只數「撞到幾個」再一次推開,推完可能又撞到別人)。實測 12 個名字 → **重疊 0**。
⚠️ 測試踩到陷阱 #40:只塞 screener 測資不夠 —— **有歷史時泡泡讀的是 `_msCache`**,
   會去抓 repo 裡真實的 `data/2344.json` → 位置自然分開 → **那條測試等於沒驗**
   (注入「拿掉錯開邏輯」照樣綠)。K 線測資也一起塞成幾乎相同的走勢才驗得到。

#### 📋📊🧲🧹🧭 其餘五項
| 項目 | 做法 / ⛔ 不可改掉的地方 |
|---|---|
| 📋 成分股表可排序 | 點欄位換 `_rotOneSortK`;⛔ **一定要 `_oneHtmlFor = null`** 逼它重建,否則 renderRot 判定「板塊沒換」只走 `_oneReflow`(那支不重畫表格)|
| 🧲 成員各走各的板塊要標出來 | `_lowCoh()`(同步程度 < **0.20**,跟採礦端 `COH_MIN` 同一個數字 —— **改一邊要改兩邊**);⛔ **只標不藏**(藏了使用者會以為壞掉),樣式用淡化+虛線,⛔ 不用紅綠(那是漲跌方向不是好壞)|
| 🧹 法人籌碼頁 | 1,398 → **949 字**:第一眼只留一句話結論 + 當天的現成反例,其餘收 `<details>`。⚠️ 那個反例**必須留在第一眼**(測試 ㉒j 直接比對它出現在摺疊區之前)|
| 🧭 策略與回測頁 | 最前面加一段目錄(五張卡疊起來,不然不知道要捲多久、也不知道想找的在不在)|
| ⏭ 回到最新 / 🎨 圖例 | 見 V74.1.3 那節 |

⚠️ **測試自己的教訓再記一次**:注入 5 種缺陷,**第一次有 1 種沒被抓到**(名字錯開那條)——
⭐ 「注入之後測試還是綠的」永遠先懷疑**測資沒有重現那個情境**,而不是急著把斷言放寬。
測試 `scripts/test_prohtml.mjs` ㊲l~㊲q(6 條),5 種注入缺陷全部驗過。

### 🫧 V74.1.3 泡泡圖「只有文字在動」—— 真因是**它讀的那份資料只有一天**
使用者:「我是要題材板塊裡面的分類,也要有泡泡那種會動的圖,例如矽光子 CPO/光通訊,
泡泡圖他就不會動,只有上面文字會動…我不要無效文字,把它折疊起來或者刪減文字」。

🚨 **不是動畫壞掉,是資料只有一天**:個股泡泡圖讀 `screener.json`,那是**最新一天的快照**
→ 拉時間軸時上面的板塊數字會變(那是 `sector_rot.json`,有 120 天),泡泡永遠停在原地。
⭐ **通用:「東西不會動」先問「它讀的那份資料有沒有歷史」,⛔ 不是先去找 transition。**

⭐ **修法:成員只有 3~12 檔 → 直接把它們的 `data/{sym}.json` 抓下來,自己算每一天的
「一年位階」與「20 日振幅」**(`_memSeries`)→ 兩個軸都有歷史,泡泡就跟著時間軸跑。
⛔ **軸刻意不換**(位階 × 振幅是個股層級實測有效的那兩個;⛔ 不可改成「誰在買」——
個股層級的法人買超佔量比實測 **0.64x**,比隨便挑一天還低)。
實測矽光子/光通訊:5 檔全部載得到歷史、命中 4/5、拉時間軸座標真的會變。

⛔ **四條不可改掉的設計**(測試 `scripts/test_prohtml.mjs` ㉘b2~㉘b4 / ㊲h~㊲i,3 種注入驗過):
① **結構只建一次,之後只改 `transform`** —— 每一拍重建 `innerHTML` 會把 CSS transition 洗掉。
   ⭐ 這是本專案**第三次**踩同一個坑(四象限計數 → 法人籌碼長條 → 這裡)。
② 🚨 **`_memSeries` 要走 `fetchJson`(共用 `_cache`),⛔ 不可用裸 `fetch`** ——
   「走向欄」剛抓過的同一份會被再抓一次;而且測試塞進 `_cache` 的測資會被繞過
   → 那條測試等於沒驗(陷阱 #40)。
③ 🚨🚨 **載入中要讓第二個呼叫者等同一個 promise(`_msPend`)** —— 這是**實跑才抓到的**:
   `renderRot` 會先射一次 `_memSeries`,它開頭就把 `_msCache[sy] = null` 佔位;
   第二個呼叫者看到「key 已存在」就直接回 → 還沒載完就去畫圖 → **永遠停在「先顯示最新一天」**。
   ⚠️ 測試 ㉘b3 第一版只釘「有共用 promise」→ 把 `want` 過濾那半拿掉照樣綠,
   **注入驗證當場抓到** → 改成兩處都釘。
④ 尺標(振幅上限)用**全期最大值**,⛔ 不隨當天縮放 —— 尺一直變的話動畫是假的。

#### 🚨 同版第二個真因:**同一個板塊有兩張明細卡**
從總覽點泡泡 → `_rotDetail`(`#rotDetail`,整頁最下面);從板塊明細點 chip → `_rotOneHtml`(`#rotOne`)。
兩張講同一件事、數字還不完全一樣,而且 `_fillStockFlows` 只認 `#rotDetail`
→ 併卡之後**走向欄整欄都是 ⏳**(測試抓到 `cells=6 rects=0`)。
→ `_rotDetail` 與 `#rotDetail` **整個刪掉**,總覽點板塊 = **跳到「板塊明細」那一頁**。
⭐ 通用:**同一件事不可有兩張卡** —— 不只是重複,是「改一邊忘另一邊」的溫床(陷阱 #37)。

#### 🧹 「我不要無效文字」怎麼量(⛔ 不是憑感覺刪)
判準是「**第一眼**看到多少字」(收合的 `<details>` 不算)。實測:
**輪動總覽 466 ・板塊明細 349 ・法人籌碼 1,398 ・策略與回測 1,913**。
⛔ **長說明是「搬家」不是「刪掉」** —— 刪了使用者就查不到「為什麼這兩個軸可信」;
搬到「📖 策略與回測」那一頁,在那裡它是主角(所以那頁**不設上限**,反而要求它 ≥800 字接得住)。
⚠️ 測試 ㊲h 第一版只設字數上限 → **把 `<details>` 加個 `open` 照樣綠**(注入驗證抓到)
→ 補 ㊲h2 直接釘「`<details class="sbnote">` ⛔ 不可有 `open`」。
⭐ 通用:**「要收起來」這種要求,字數上限抓不到,要直接釘那個收起來的機制。**

#### 📐 同版兩個「設計不良」的補強(使用者:「有沒有推薦的?或者設計不良的建議方式」)
① 🎨 **泡泡圖沒有圖例** —— 紅/綠是什麼、泡泡大小是什麼、右上角那個虛線框是什麼,全都沒寫。
   ⭐ 這是 V74.3.7「只有兩條軸線的話泡泡位置根本不可解讀」那條教訓的**第二次犯案**:
   軸有刻度了,但**編碼(顏色/大小)還是沒有圖例**。
   ⚠️ 圖例的紅綠一律用**文字上色**,⛔ 不可用 🔴🟢 emoji(pro.html 的燈號鐵則測試會擋)。
② ⏭ **拉去看過去之後回不來** —— 手機上滑桿很難拖準最右邊。
   → sticky 控制列加「⏭ 回到最新」(**只在不是最新那天才出現**,⛔ 不佔平常的版面),
   並在日期後面標「(最新)」——⛔ 只有日期的話,使用者分不出自己現在停在哪。

### 💧 V74.4.9 板塊輪動重新設計 + 🔋 新增題材(BBU / 玻纖布)+ 🧲 成員同步程度
使用者:「你現在做得很亂,很難讓人搞得清楚這個東西在做什麼,我沒有辦法知道目前看了這些數據
能做什麼事情,你全部資料都塞在這一頁…下面那個沒有播放條…我也想看單一個題材怎麼作動的」。

**① 拆四個子頁籤,而且每一頁都要說「這頁在回答什麼 + 看了能做什麼」**
🗺️ 全景(定位)・📈 單一板塊(走勢)・📇 成分股・👥 誰在買。
⛔ **只拆頁籤不解釋 = 把亂的東西分成四堆亂的** —— `ROT_SUB` 的第三個欄位就是那句話,測試 ㉟a 釘住。

**② 🚨 控制列改 `position:sticky`** —— 使用者原話「下面那個沒有播放條」:
舊版只有泡泡圖上方那一條,捲到成員名單就看不到時間軸了。現在四個子頁籤共用同一條。

**③ ☑️ 勾選過濾**(`_rotPick`,null = 全部):泡泡圖與成分股頁都吃。
⛔ 兩條:**全部取消要退回全部**(空畫面不是篩選,是壞掉);
**尺標⛔ 不可隨勾選變** —— 真實資料實測會從 10.57 變 16.71、泡泡從 223.5px 移到 208.6px,
同一個泡泡在不同勾選下位置不同 = 那張圖不可比。

**④ 📈 單一板塊走勢**(`_rotOneHtml`):整段 120 日的「相對強弱 + 外資 5 日」雙線 + 時間軸游標,
並算出**「現在在整段的位置」** —— ⭐ 那一格就是「剛發動 vs 已經漲很久」的答案。
⛔ 兩條線各自縮放(一個是 %、一個是億,共用尺會壓成一條);⛔ 只描述不下指令。

#### 🚨 這次踩到的 bug:`_rotK: 0` 讓時間軸每次都停在**最舊**那一天
拆子頁籤之後 `renderRot` 先呼叫 `rotSwitchSub`(它內部會 `rotSeek(_rotK)`),
而預設值是 **0** → `0 != null && 0 <= 119` 為真 → 停在 120 天前。
⚠️ **畫面看起來完全正常**(有圖、有資料、有數字),只是全都是三個月前的。
→ 預設改 **null**,並在 `renderRot` 裡**先定好 k 再切子頁籤**。測試 ㉟c(實跑)+ ㉟c2(釘死宣告值)。
⭐ 通用:**「0 是一個合法的索引」這種預設值最危險** —— 它不會報錯,只會安靜地給你錯的那一天。

#### 🔋 新增題材:BBU 從「電源/BBU/UPS」拆出 + 玻纖布/玻纖紗
BBU(AI 機櫃備援電池)的當事人是**電池模組廠**,跟 UPS/電源供應器是不同一批公司,
混在一起會讓「這一族在動」讀不出來。⭐ 加完**當天就自動長出成員**(BBU +7 檔、玻纖布 +13 檔)。

#### 🧲 題材「內聚度」= 成員兩兩之間的平均相關(V74.4.9 加,寫進 `stock_tags.json` 的 `coh`)
⭐ 這是**擴散的前提**:成員自己都不一起動的話,那個中位數就是雜訊,任何「跟它很像」都是假的。
實測:軍工 0.67 ・玻纖布 0.65 ・矽晶圓 0.62 ・被動元件 0.61 ・記憶體 0.55 …
🚨 **但晶圓代工 0.07 ・網通 0.07 ・電源 0.13 ・低軌衛星 0.18** —— 那幾組本來就不同步
(晶圓代工那組有台積電,而它幾乎等於大盤本身 → 殘差近 0)。
→ **內聚度 < 0.20 只留人工種子、⛔ 不自動擴散**;數字寫進輸出讓前端顯示,
⛔ 不可只在後台判斷(使用者才知道這個板塊的平均值有多可信)。
測試 `scripts/test_prohtml.mjs` ㉟~㉟i(11 條,4 種注入缺陷驗過)。

### 🧭 V74.1.1 板塊輪動照使用者版面藍圖重做(4 子頁籤 + 說明書頁)
使用者給了一份完整的版面藍圖(要求用 React + Tailwind 實作)。**架構全採納,技術棧沒換** ——
理由寫在下面,⛔ 別再提「改寫成 React」。

#### ⛔⛔ 為什麼不改 React + Tailwind(這題以後不用再評估一次)
| 他要的 | 現況 | 判定 |
|---|---|---|
| React | `pro.html` 是**單檔靜態頁**、零建置步驟(GitHub Pages 直接吐) | ⛔ 要多載 React+ReactDOM UMD、把約 2,000 行改寫成元件,**使用者看不到任何差別**,而 130+ 條測試全部要重寫 |
| Tailwind | `pro.html` **沒有載 Tailwind**(它用自己的 CSS 變數;index.html 才有 CDN 版) | ⛔ 為了寫 class 名多載一支 CDN = 多一個單點故障 |
⭐ **架構(資訊分層)才是他真正的痛點,那個跟框架無關** → 四個子頁籤、可捲膠囊列、2×2 KPI、
44px 觸控、藏捲軸、動態顯示**全部照做**,只是用既有的 vanilla JS + CSS 變數實作。

#### 📐 四個子頁籤(`ROT_SUB`)
📊 輪動總覽 ・📋 板塊明細 ・💰 法人籌碼 ・📖 策略與回測。
⭐ **「單一板塊」與「成分股」合併成「板塊明細」** —— 選了板塊本來就要一起看走勢與成分股,
分兩頁反而要來回切(這是使用者藍圖比我上一版好的地方)。

#### 📖 「策略與回測」= 把長篇說明抽出來(這頁是解決資訊爆炸的關鍵)
⛔ **但不是全部搬走**:會影響判讀的**一行**免責必須留在原地
(資金流的 0.64x、題材版不可套用官方實測數字)—— 搬到別的分頁等於使用者看不到(陷阱 #32)。
搬走的是**長篇版本**:窗口怎麼選、四道關卡、三種無效的錢流定義、內聚度、限制清單。

#### ⭐ 「每個都有動態顯示」怎麼做到(⛔ 有個坑)
🚨 **每一拍都重建 `innerHTML` 會把 CSS transition 洗掉 = 完全看不到動畫**。
→ 兩處改成「**結構只建一次,之後只改文字/style**」:
・`_rotQuad`:數字變了才改,並加 `.bump` 閃一下(看得出哪一格在長大)
・`_rotFi`:`_fiSig`(列順序+勾選組合)沒變就只改 bar 的 `width`/`left` → 條會**滑過去**
測試 ㊱e/㊱h 釘住(注入「每拍重建」「拿掉 transition」都會叫)。

#### ⚠️ 這次踩到的:`0.63 − (−0.8)` 在 JS 是 `1.4300000000000002`
說明書頁直接印出來 → 已抽成 `SPREAD = (R.top - R.bot).toFixed(2)`。
⭐ 這是本專案第 N 次「顯示給使用者的數字要自洽」——
**任何算出來的數字要顯示之前先問一句「它會不會有浮點尾巴」**。測試 ㊱a2 釘住。

#### 📏 其他照藍圖做的
・子頁籤 `flex-wrap:nowrap; overflow-x:auto` **一行橫捲**(4 顆在 390px 會擠兩行,白吃一列)
・`#rotOneBar` 封 `max-height:118px` 自己捲(⛔ 32 個產業全攤開會把走勢圖推到看不見 = 使用者說的「無限往下滑」)
・`.labbtn/.lbtn` `min-height:44px`(Apple HIG / Material 的最小觸控目標)
・`.noscb` 藏捲軸(仍可捲)・KPI 2×2(4 欄在手機上每格只剩 80px,字被壓成三行)
測試 `scripts/test_prohtml.mjs` ㊱~㊱h(9 條,6 種注入缺陷驗過)。

### 🚨🚨 V74.1.2 「為何沒有 ▶︎ 播放輪動」—— 真因是 **sticky 黏到 header 底下**,不是沒做
使用者截圖問「為何沒有題材板塊獨立的 ▶︎ 播放輪動」。⭐ 播放鈕**一直都在**,
問題是 **`.rotsticky{top:0}` 讓它黏在畫面最上緣,而 `.topbar` 也是 sticky、`top:0`、`z-index:50`**
→ 實測 header 下緣在 **166px**、控制列黏在 **0px** → **整條藏在 header 後面**,
捲下去就永遠看不到。⚠️ **不會報錯、畫面也不空**,就是那顆鈕消失了。

⭐⭐ **通用鐵則:頁面上有兩層 sticky 時,下面那層的 `top` 一定要扣掉上面那層的高度。**
⛔ 而且**不可寫死 px** —— 安全區(`env(safe-area-inset-top)`)、分頁列換行、轉向都會改變它
→ `_syncHdrVar()` 量出來寫進 CSS 變數 `--hdr`(綁 `resize`/`orientationchange`/`switchTab`)。
本頁有**兩層**:控制列 `top:var(--hdr)`、板塊頁的返回列 `top:calc(var(--hdr) + var(--ctlh))`,
`--ctlh` 同樣是量出來的。

#### 📄 板塊明細改「兩段式」(使用者:「頁面都卡在同一頁,我要用分頁方式呈現獨立題材板塊」)
舊版是「清單 + 明細**疊在同一頁**往下長」→ 選了板塊還要往下捲很久。
現在:**沒選 = 清單頁(搜尋 + chips);選了 = 那個板塊自己的頁**(清單整個收起來)。
板塊頁自己那一列有:`← 全部板塊`・`◀ ▶`(直接翻下一個板塊,⛔ 不用回清單再點一次)・
**它自己的 `▶︎ 播放這個板塊`**。⚠️ 進新頁要 `scrollTo(0)`,⛔ 不然停在半路。

⛔ **兩顆播放鈕共用同一個 timer → 標籤必須一起更新**(`_rotPlayLbl`),
否則會出現「一顆寫播放、一顆寫暫停」。測試 ㊲d 釘住(注入「只更新一顆」會叫)。
測試 `scripts/test_prohtml.mjs` ㊲~㊲g(8 條,4 種注入缺陷驗過)。
