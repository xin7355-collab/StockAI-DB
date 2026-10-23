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
| `weekly_backtest.yml` | `workflow_run` ← daily_miner(**只在週五**那一輪真的跑;手動 force=true)/ ⛔ 無 cron | 🔁 **每週自動回測**:`signal_backtest`(135 個 K 線訊號,最近 3 年)+ `portfolio_backtest`(決策台;🧾 **V79.5.1 起全市場 + 照 App 前一晚名單買**:交易快取 4 片 → 名單前 60 筆 → `list_trig` TOPN=60 → 兩趟 🅿️ 停 0050 / 💵 錢放現金,任何一段失敗紅燈;`build_backtest_edge` 守門:名單要接上判觸發、可能不準 ≤ max(5, 1%) 晚、🅿️ 跟嵌入版比用「股票 + 0050」合計,`③i / ②j / ②l`)→ `data/backtest_edge.json`(推 gh-pages + data)。🔁 **V79.4.5 起 App 一律讀內嵌的 16 年 `_SIGNAL_EDGE`**(使用者選的),產物只在實驗室模式當「最近幾年」參考(`_btEdgeNote`);成績單設定 = **App 現行預設**(= `_DECK_TRACK49`:🅿️ 85/60・chand2・MAXD 20・空頭照買・照平均排・斷崖・1,200 天・個股破線不買・停 0050・收盤成交・股利 + 二代健保,`test_backtest_edge ③h` 跨檔比對 —— ⚠️ 改 App 預設要一起改);🔒 **V79.5.0 共用部署鎖 `gh-pages-push` 只在最後的部署 job**(回測 job ⛔ 不拿;以前寫在 workflow 層級 → 每天跟 playbook_scan 同一秒進鎖、擠掉排隊中的明日清單,`test_backtest_edge ③c`);⛔ **只標示不換預設**(V75.0.9 五條件由人判);空過守門 訊號 n / 成績單筆數 < 上一版 80% 不推,**cfg 或訊號方法換了那一次重新起算**(⛔ 但絕對下限 `FLOOR` 照樣要過)。🚨 9/21~10/20 每週都被擋 = 守門拿舊引擎的 1,233 筆比(同設定現在 926)。測試 `scripts/test_backtest_edge.mjs` | ~40 分(組合回測約 20 分) |

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
🚨🚨 **V75.2.0 更正:上面那句「每天 1~2 次 100% 可靠」被反例推翻了**。
近 9 天實測:全 repo 只有 **100 筆**排程進得來(cron 要求約 250 筆),而被丟掉的是**固定五支**
(`macro_cron` / `news_express` / `rotation_probe` / `stock_futures` / `insider_cron` 全部 **0 筆**)。
⛔ `insider_cron` 一天只要 **1 次**也是 0,而 `fund_sweep` 同樣一天 1 次卻正常
→ **判準不是頻率,是「這一支實測進不進得來」**(先問 `actions_list` 的 `total_count`)。
⭐ **現行修法:餓死的那幾支改掛 `workflow_run`**(⛔ 不是 schedule → 不吃配額),
跟在實測跑得到的 host 後面;cron 一行不刪當備援。
本 repo 早有驗證過的前例:`playbook_scan` ← `daily_miner`(66 筆)。
⛔ 四條設計(測試 `scripts/test_wf_quota.py`):host 名字要**完全一致**(差一字永遠不觸發且零訊息)/
host 必須是實測跑得到的 / cron 不刪 / job 只跟 host 的**排程**那一輪。
🚨 夜盤採礦(`stock_futures`)的 host **必須落在夜盤時段**,白天跑會把日盤寫成「夜盤」。

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
✅ 排程那一半後來證實 GitHub 常常整天不給(見下面 2026-09-10 那段)→ 改由 worker `repository_dispatch` 叫醒,
   ⛔ 不再靠 08:44 那條 cron(cron 照留當備援)。

⏭️ **怎麼驗有沒有修好**(⛔ 一律看**產物的日期**,不是 Actions 頁面的顏色):
```bash
for f in live_quotes live_index tick_flow daytrade_pack stock_futures_night; do
  echo -n "$f: "; git show origin/gh-pages:data/$f.json 2>/dev/null | grep -oE '"updated"[^,}]*' | head -1 || echo "不存在"
done
```
盤中 `live_quotes` 應該 **5 分鐘內**、`tick_flow` **10 分鐘內**。
⚠️ 若釋出配額後 `stock_futures` / `macro_cron` 仍然 0 筆 → 那才輪到查它們自己的程式。
✅ **2026-09-10 已走這條**:實測排程**遲到 4.5~5 小時、常常整天不進來**,而台北早上
08:00~10:30 只有 4 支排程、其中 3 支正是「餓死」的那幾支 → **沒有 host 可以掛 `workflow_run`**。
→ `cloud-worker/worker.js` 的 `ghDispatch()` 用 **`repository_dispatch`**(⛔ 不吃排程配額)
叫醒 `live_snapshot`(台北 08:00 那輪)與 `tick_flow`(09:00 那輪),盤中每 15 分再當**看門狗**
(⛔ 只在「產物太久沒更新」才補發 —— 無條件發會一直砍掉自己的主迴圈)。
⛔ 兩支的 cron **一行不刪**當備援;🚨 事件名兩邊要完全一致,測試 `scripts/test_intraday_relay.py` ④
**雙向**比(發了沒人收 / 收了沒人發 都要叫得出來)。
⚠️ Cloudflare 免費版 cron 上限 5 個而**已用滿** → 新功能一律掛在既有 handler 裡,⛔ 別想加第 6 個。
⚠️ 需要使用者設 `GH_DISPATCH_TOKEN`(步驟在 `cloud-worker/README.md`);沒設就整段跳過。
⏰ **V79.1.9 daily_miner 也由 worker 台北 17:00 叫醒**(`minerKick`,event `daily-miner`,只在 gh-pages screener 還不是今天才發);`playbook_scan` 跟 schedule / repository_dispatch / workflow_dispatch 那輪(⛔ push 不跟)。測試 `scripts/test_miner_kick.mjs`。
📶 **V79.4.8 永豐帳號每天流量上限 524 MB(同一個帳號的 `auto_trade.py` 也吃這個額度)**:10/21 13:03 就用完 —— 逐筆內外盤每 10 分鐘把前 80 檔「開盤到現在的全部逐筆」重抓(每拍 3.5 → 26 MB,一天 449 MB = 86%)→ 13:30 收盤那拍快照與逐筆都沒有。→ 逐筆改**只抓上一拍之後的**(`tick_flow_miner.collect_ticks`:狀態存 /tmp、起點往前多抓 1 秒再用時間戳去重、每拍輪流抽一檔整天重抓對帳、對不上當天改回整天重抓;`TICK_INCR=0` 逃生門)+ 快照 timeout 300 → **345**(worker 08:00 叫醒要撐到 13:31:30)。⛔ 新增任何會用 Shioaji 的盤中採礦之前,先算一天要吃多少流量(log 每拍都印 `📶 今日流量`)。測試 `scripts/test_tick_incr.py` / `test_intraday_loop ⑦g`。
🌅 **V79.3.4 macro_cron 也由 worker 台北 08:00 叫醒**(`macroKick`,event `macro-cron`,只在 gh-pages `macro_risk.updated` 還早於最近一次美股收盤(紐約 16:00 = 夏令 20:00 / 冬令 21:00 UTC)才發)+ 跟車多掛 `news_premarket`(07:46~10:40 飄,備援)—— 以前最後一輪都在台北 20:30~02:30,盤前體檢永遠是美股盤中的數字。前端 `_macroPreUsClose` 灰字說明;`_lastUsCloseMs` index / worker 同一條規則。測試 `scripts/test_macro_kick.mjs`。

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

✅ `stock_futures_night.json` 停在 08-08 那次已查清楚:**一筆 run 都沒有**(排程配額,V73.9.0 / V75.2.0 改掛 `workflow_run` 後恢復)。
🔎 **V79.5.2 新的一次**:10/20 起每輪都是「登入成功、找到 271 檔合約、報價 0 檔」而且**沒有任何例外** ——
失敗那幾天正好是白天快照 12:50~13:03 就把永豐當天流量用完的日子(10/19~10/21),成功那幾輪(10/14 06:46、10/16 08:40)在之後
→ ✅ **V79.5.6 證實**:10/23 04:16 那輪 log「📶 今日流量:已用 429.6 MB / 524.3 MB」—— 凌晨看到的「今日」是**前一天白天一路累積的**(10/22 逐筆改增量後白天只用 181 MB → 夜盤 268/271 檔有價)。⭐ 收盤後兩輪被延遲的排程備援各重抓整天逐筆 50 MB → V79.5.6 起跳過(`test_tick_backup_skip.py`);5 分 K 回補用到 85% 就停,夜盤那輪至少留 15%。⏳ 夜盤「漲跌 %」的基準有的是前一天、有的是當天日盤 → 每檔多存 `ref` / `st`,有證據再修自選列的「期夜・補漲?」。
⛔ 它是**夜盤**採礦,白天手動觸發會把日盤資料寫成「夜盤」(程式有守門,白天會直接結束)。

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
- 🏃 **2026-10-23 使用者明示:「你就直接一直做下去就好」(不要一直停下來要我確認)** → 改 workflow、改採礦、大改版面、動 `data/` 快取都**直接做**,做完回報「做了什麼 + 怎麼換回」。
- ⛔ **只剩兩件仍須先問使用者**(做錯了沒辦法用 `git revert` 救回來):① **會動真錢的開關**(自動下單真實帳戶,例如 `PARK_LIVE_OK`、`LIVE`)② **刪掉使用者自己存的資料 / 不可回復的刪除**(例:IndexedDB 的貼上報告、AI 圖,或 force-push 蓋掉別人的東西)
- ⚠️ 雲端 session 的「Plan(計畫)」模式本來就會停下來等核准、排程工具(send_later / update_trigger)在 Auto 模式也可能被攔 —— 那兩個不是 CLAUDE.md 管得到的;要不被問,使用者在輸入框旁的下拉選單選「Auto」,並自己把 `permissions.allow` 寫進 `.claude/settings.json`(Claude 自己改那個檔會被安全檢查擋下,⛔ 不可繞過)
- 壞了 → 使用者說「壞了」→ Claude 直接修;或 `git revert HEAD` 回退

### 🔁 V75.0.9 策略預設值「自動替換」規則(使用者明示,永久授權)
使用者原話:「爾後有回測或者厲害的策略,**比我原本設定的策略還要好就直接替換,我不要等我發現你才替換,
這樣我回測就沒有意義**,請記起來」。

⭐ 這個訴求成立,而且查證之後照出兩件真正的事:
① 🚨 **他其實沒有辦法發現** —— V75.0.0 他自己要求把更新提醒關掉,`_checkVersionUpdate` 現在只蓋章不跳窗
   → V74.5.4 我把預設出場從「跌破 5 日線」換成 ATR 時,**他沒有任何管道會知道**,
   而出場規則變更會**直接改變他手上部位的防守價**。
② 🚨 **引用舊成績的地方沒有跟著換** —— 決策台的 `_DECK_TRACK49` 是用**舊出場**跑的
   → 畫面上那個「這套實測賺多少」**在低估自己**。那正是「回測沒有意義」的另一種形式。

#### ✅ 直接換(⛔ 不用問)—— 五個條件**同時**成立
1. **八道關卡全過**:六道(全期正 / 前後半同向 / 逐年同向 / 去最好年或最好月 / 扣成本 0.44% / 增量檢定)
   + 兩道追加(**買得到嗎** / **疊在現行配置之上還有增量**)
2. **正式配置下判定**(V74.4.4:資金設定會翻轉穩健性,寬鬆配置全過不算數)
3. **是一片高原不是孤峰**(門檻左右各挪兩格仍成立;V74.3.8 chand2 / V74.4.7 證券股都死在這關)
4. **窗口涵蓋一次空頭**(目前最長 49 個月含 2022)
5. ⭐ **判準 = 總獲利最大**(使用者 2026-09-08 明示「**賺最多就換**」)
   —— ⛔ **不是**風險調整後、⛔ **不是**回撤優先。⚠️ 但代價(回撤變大)**必須寫進通知**。
6. 🧭 **V77.4.9 追加:多條路徑都要贏**(`portfolio_backtest.mjs WARMUP=240~320`,每 5 日一條、共 17 條,看**配對勝場**)——
   🚨 資金有限的組合回測是**路徑相依**的:同一套規則挪 10 個交易日起點,總獲利就差 140 萬(唐奇安 428 → 572 萬)。
   V75.0.9 「唐奇安 590 > ATR 531」就是單一路徑判的;17 條路徑下兩者**分不出高下**(配對 11/17、差距中位 +31 萬),
   唯一穩定的是 ATR 回撤 17/17 較小。⛔ 只比一個總數就換預設 = 拿運氣當證據(`_EXIT_EDGE.rob` 存著那張表)。

#### ⛔ 不換(照舊做法:寫進實測總表 + 給選項 + 標實測數字)
- **任何一關沒過** → 那不是「更好」,是「這一段剛好比較好」(全庫 16 項裡有 15 項死在這)
- **取捨型**(賺更多但回撤更大 / 回撤更小但少賺)→ 做成**設定選項**,預設不動
  ⚠️ 例外:上面第 5 條的判準已經把「賺最多」定為優先 → 純粹「多賺但回撤大」的**要換**,但要寫代價
- **混用沒單獨測過** → ⛔ 不可把各自最佳值直接疊起來(V73.0.0 停損 −3% 的教訓)
- **意外發現** → 沒單獨驗證前不採用(don10w +708 萬全表最高,但那是第一版寫錯造成的意外)

#### 🚨 換掉之後必做四件(⛔ 一件都不能少)
1. **`_STRAT_CHANGES` 加一筆 + 開 App 跳一次窗**(使用者選的:「開 App 跳一次,按了才消失」)——
   必須同時寫 `from` / `to` / `why`(**數字**)/ `cost`(**代價**)/ `you`(**對你的影響**),
   而且要有「**換回舊的**」一鍵。🧹 **V78.3.4 起散戶 App 彈窗只印 from / to / you + 一句白話代價**(使用者:實測數字不給別人看)
   —— `why` / `cost` 的數字寫進產業作戰室實測總表(LAB),⛔ 不再出現在 index.html 畫面。🚨 **按了「知道了」才蓋章**(⛔ 不可 render 就蓋)。
   ⛔ 一般功能更新**仍然不跳窗**(`_checkVersionUpdate` 一行都不動)。
2. **舊的留成選項**(⛔ 不刪 —— 他可能已經照舊的在做,同 `_SIGNAL_EDGE` 對 C 級的處置)
3. **所有呼叫點一起換**(陷阱 #37),清單**必含 `auto_trade.py`** —— 那支會動真錢,漏了就是真的賣錯條件
4. 🚨 **把「引用舊成績的地方」一起重跑並更新**:`_DECK_TRACK49` / `PRO._SIG_DEEP` / 設定 UI 文案 /
   `PRO.BT` 情境庫 / LAB 條目。⛔ 這條就是這次漏掉才發現決策台在低估自己。
   ⭐ 而且資料裡要留 **`exit` 欄位**(這次換預設才發現對不上,測試 ⓪b2 釘住)
   與**舊出場的對照數字**(`ma5:` 欄,那個對照本身就是證據)。

#### 🔥🔥🔥🔥 V79.4.9 換掉的第四項:🔥 照保守下界・一檔 2 招・空頭不買・錢放現金 → **照平均排(≥8 次・每招都算)・空頭也照買・閒錢停 0050(🅿️ 變預設,自動下單也做)**(使用者 10/21 三個決定)
- ⭐ 三件**合起來**重測(⛔ 不疊單獨的結果),回測先再對齊 App:個股自己跌破 20 與 60 日線不買(`SELF=…+nobear`)、`MIN_MKT_N=0`(四捨五入差 0.21% ⛔ 不加)。全市場 d16・照 App 名單買法・17 條。
- 數字(萬,不含本金):錯開 4 年 / 16 年 V79.4.8 預設 +64 / +118 → **+502 / +1,945**(兩段 17/17);0050 含息 +322 / +1,097 → **第一次兩段都贏 0050 含息**。看板窗口 100 萬 → 620 / 2,045 萬。每一件單獨拿掉都 17/17 變差;名單隨機排 +357 / +992;成本 ×2 仍 +464 / +1,581。
- 🚨 **誠實的另一半**:多賺的大部分是停 0050(錢放現金那版 +189 / +371,仍輸 0050);錢在 0050 = 跟大盤一起跌(16 年回撤 37.2%,舊 43.6%);空頭照買是取捨(停 0050 時 16 年逐年 8/16)。⛔ 「16 年輸 0050 含息」那句對 🅿️ 不再成立(🔥 錢放現金仍輸)→ 文案讀看板 / `_BEAR_GATE_EDGE`,⛔ 不寫死。
- 唯一一份規則 `lib_hotrule.mjs` / `.py`;playbook_scan 每列 `r` / `o` + 檔頭 `rule`(舊的 pick_history 沒有 rule = 舊排法)。🔥 守門 `_bearGateOn()` 預設關(搬家 `hotMigr7949`),👑 `_leadBearOn()` 固定開。auto_trade `HOT_RULE` / `BEAR_GATE` / `LEADER_BEAR_GATE` / `PARK*`;`park_step` 13:27 一天一次、只碰自己買的 0050、一天最多 30 萬、實盤查不到交割款就不買。換回舊的 = App 彈窗一鍵(`backHot`)/ auto_trade `HOT_RULE=lb BEAR_GATE=1 PARK=0`。
- 🛡️ auto_trade 停 0050(會動真錢):**真實帳戶 `PARK_LIVE_OK = False` 先只預覽**(永豐交割款正負號沒有官方文件 → 使用者選「看過 log 再開」;對完才改 True)。⛔ 湊交割款一定先做,不可被「帳戶總資金過期」/ PARK=0 / 沒設帳戶擋掉;0050 買單隔天對到永豐庫存才算自己的(送出 ≠ 成交);👑 要留的錢不拿去停;DRY_RUN 不寫狀態檔;模擬 / 真實**分兩個狀態檔**(真實第一次跑新版:沒標模式的舊部位一律當成模擬的搬到 `legacy`,⛔ 不自動賣・⛔ 不擋買・⛔ 不拿永豐庫存去猜;模擬第一次跑接著用舊檔的紀錄,⛔ 舊檔不動);整張 + 零股拆單其中一筆出錯 → 只記已送出的那段(`SendError.sent_sh`),⛔ 下一輪不重送,賣單剩下的它自己接著賣(👑 當天延後賣);送 0050 單前再看一次鐘(過了 13:30 不送)。測試 `test_auto_park.py` ⑲~㉚ / `test_auto_send.py`。

#### 🔁🔁🔁 V77.7.6 換掉的第三項:唐奇安 40 日・40 天 → **吊燈 ATR 2 倍・最長 20 天**(空頭不開新倉照留)
- ⭐ V77.6.5 那次的 409 萬是**日 K 混了還原價**(陷阱 #46)撐出來的;修好後唐奇安 40 只剩 4 年 179 / 16 年 285 萬,吊燈 ATR 2 倍 324 / 494 萬(兩段 17/17、ATR 2~3 倍高原)。
- 🚨 **逐年同向沒過**(2011~2020 吊燈 47 vs 唐奇安 40 115 萬)—— 使用者明示「以現行最厲害的執行」才換;代價寫在 `_STRAT_CHANGES` 的 cost。仍輸 0050 含息(4 年約 350、16 年約 1,068 萬)。
- 🔄 使用者要「情勢變了自動換」→ 引擎 `EXIT_SCHED` + `exit_switch_probe.mjs` 回測:贏隨機、**輸固定用吊燈**(4 年最多 2/17)→ ⛔ 沒做自動切換。⛔ 下次有人提「自動換策略」,先重跑這支,別直接做。
- 搬家旗標 `exitMigr776`(index/pro 同一個判斷,只動存著 don40 的人);換回舊的 = don40。吊燈線一律用**進場那天**的 ATR(`_exitLevelAt` / `_exitLines` / 回測 `chand2` / `auto_trade.py atr2` 同一把尺)。

#### 🔁🔁 V77.6.5 換掉的第二項:唐奇安 20 日・最長 20 天 → **唐奇安 40 日・最長 40 天・大盤嚴格空頭不開新倉**(使用者:「把最強的策略換上」)
- ⭐ 三件**一起**換(回測就是三件一起跑的,⛔ 不可只換一件):出場 `don40` / 最長天數 `_maxHold()`(跟著規則走)/ 🐻 `bearGate`(大盤收盤 < 60 日線且 20 日線 < 60 日線 → 當天不開新倉,只擋買進)。
- 數字(收盤成交、17 條路徑中位):本站 2022-09~2026-09 **107 → 409 萬**(17/17 贏、回撤 17/17 較小、贏 0050 1 → 16 條);16 年(外部資料 + **真的加權**)舊預設破產、新 **648 萬**(最差 587)。
- 🚨 **誠實的另一半**:16 年窗口 **0050 買了放著含息 +1,035%**(中途最多賠約 −34%)> 新預設 648 萬 —— 主動策略裡它最穩,但 16 年來看**沒贏過 0050 含息**(4 年窗口則是 409 > 311 萬)。⛔ 這句必須跟數字一起講。
- 🚨 智慧單:這組停損「盤中碰到就賣」只有 253 萬(17 條只贏 1 條)→ 決策台與 📋 複製的文字都要講「尾盤確認再賣」(`_STOPFILL_EDGE.rows.don40`)。
- 搬家:存著舊預設 `don` 的人換一次(`exitMigr765` 旗標,index/pro 同一個判斷);⛔ 自己選 ATR/移動停利/5 日線的一個都不動;彈窗「換回舊的」= `don` + 關掉空頭守門(`backBear:false`)。
- ⛔ 下次換預設前:`test_beargate` / `test_stratchange` / `test_recoledger 🚪⑧` 釘的是**三份實作一致**,⛔ 不是某個值。

#### 🚨🚨 V75.0.9 換掉的第一項:出場預設 ATR 追蹤 → 唐奇安 20 日
| 出場 | 累積 | 中途最多賠 | 六關 | 判定 |
|---|---|---|---|---|
| don10w | +708 萬 | −24.5% | ✅ | ⛔ **不採用**(意外,沒單獨驗證過那個設計) |
| don10 | +627 萬 | −31.8% | ❌ 2022 −2 萬 | ⛔ 逐年沒過 |
| ⭐ **don20(唐奇安 20 日低)** | **+590 萬** | −25.2% | ✅ 全過 | ✅ **換成這個** |
| chand2(ATR,舊預設) | +531 萬 | **−20.0%** | ✅ 全過 | → 降為選項 |
| trail8 / ma5 | +476 / +193 萬 | −25.4 / −32.3% | | 選項 |

⭐⭐ **換完重跑決策台的成績單,照出這一輪最有價值的一件事**
(600 檔・49 個月・每天 2 檔・每筆 15 萬,**同一批股票、同一套選股,只換出場**):
| | 舊(跌破 5 日線) | ⭐ 新(唐奇安 20 日) |
|---|---|---|
| 🧬 高位階+高波動 | +195.5 萬 ・回撤 −32.4% | **+589.8 萬 ・−25.2%** |
| 不挑 🧬 | +107.8 萬 ・−31.8% | **+308.1 萬 ・−25.1%** |
| 🆚 0050 買了放著 | +264.1 萬 | +264.1 萬 |
| 判定 | 🚨 **兩種都輸** | ✅ **兩種都贏**(而且回撤還變小) |

⭐⭐⭐ **通用鐵則(這條比換掉哪一條更重要):贏不贏大盤高度取決於「出場」,不是「選股」。**
⛔ 不可解讀成「選股變厲害了」—— 選股一模一樣。真因是**太早出場會把贏家洗掉**
(勝率只有 30%,整套會賺完全靠讓對的那幾筆抱久一點)。
⚠️ 而且這個「贏」要打折:窗口偏多頭(加權自己就漲 208%)、倖存者偏誤、中途最多賠 −25%。
⛔ 那幾句限制**必須跟數字一起顯示**(測試 ⑪a/⑪a2 釘住:數字說贏的時候更要寫限制,⛔ 不可變成推銷)。

⚠️ **`sw`(空頭改抱 0050 切換策略)那組數字是用舊出場跑的** → ⛔ 不可跟新的三個數字直接相減,
它只回答「切換 vs 不切換」那一個問題。

### 🔁 V75.1.0 「怎麼好幾天都是同幾條?」+ 🧺 漁獲籃看不出賺賠 —— ⭐ 先量再答
使用者:「已經好幾天釣魚都是一樣魚,這是對的嗎?另外目前這樣子看,還是覺得不好清楚看到現在比較起來賺賠多少」。

#### 🔁 ① 拋竿名單黏不黏 —— `cast_probe.mjs --STICKY`(769 個交易日重放同一套漏斗)
| | 實測 |
|---|---|
| 隔 1 天跟上次一樣 | **54.7%**(其中 **41.7% 的日子完全沒換**) |
| 隔 3 / 5 / 10 / 20 天 | 35.8% / 23.6% / 9.7% / 2.2% |
| 一條魚連續上榜 | **中位 1 天** ・P75 2 天 ・**最長 23 天** |
| 最近 5 / 10 / 20 天總共出現幾檔不同的 | **3.8 / 6.2 / 10.6**(上限 10 / 20 / 40) |

⭐⭐ **他的感覺是對的,而且這是設計的必然,⛔ 不是壞掉**:漏斗四層
(一年位階 / 20 日振幅 / 20 日板塊動能 / 板塊內 20 日最強)**全部是 20 日以上的窗口**
→ 一天只換掉窗口頭尾各一天,本來就不會天天翻盤。
⛔ **不可為了「看起來新鮮」硬換一批** —— 那是用隨機性冒充多樣性(同 V73.8.7 的定調)。

🚨🚨 **但有一件事必須講,而且以前沒講**:**回測是「同一檔 20 個交易日內只算一次」**
(`cast_probe` 的 `DEDUP = 20`)→ **連續幾天一直買同一檔,⛔ 不在那份回測涵蓋的範圍內**,
⛔ 不可拿那份成績替重複押注背書。同一檔已經有部位就看那個部位的出場規則,⛔ 不是再買一次。
📍 落地 `_castStickyHtml`(⛔ 沒新增卡片,是拋竿卡裡一段摺疊):數字全部讀 `_CAST_STICKY`
(⛔ 不寫死,重跑探針要跟著變)+ **直接標出「這條你 N 天前已經釣過了」**
—— ⭐ 那是最實際的一件事:**拋竿本身不知道你已經有了**。

#### 🧺 ② 「看不清楚賺賠多少」是**三件事**(⛔ 只修一件仍然看不清楚)
| # | 真因 |
|---|---|
| ① | 🚨 **已結算的那幾條還在用「今天的價」算浮動** —— 出場之後那個數字就不該再動 |
| ② | 🚨 **兩個「一張合計」同名不同義** —— 頂端是**帳面浮動**、成績單是**已實現**,兩個數字對不起來 |
| ③ | 🚨 **11 欄的 table 在 390px 手機上把「贏大盤」整欄切到畫面外** —— 而那正是「這條魚有沒有用」的那一欄 |
📍 修法:已結算一律用**結算價**(`st.exitP`/`st.net`/`st.ex`)、頂端拆成
「📌 持有中(帳面浮動)/ 🧾 已結算(已實現)/ 💰 兩個加起來」三格並明說**意思不一樣**、
表格改成**一行一張卡**(⭐ CLAUDE.md 既有鐵則:**手機上的資料列,欄位 ≥3 個就別用 table**)。
✅ 實測 390px:橫向溢出 **0**、每一列的「贏大盤」都在畫面內。

#### 🚨 順手抓到我自己 V75.0.9 漏的第三處(陷阱 #37,而且我的新規則第 3 條就寫著)
**`pro.html` 的 `_exitRule()` 預設仍是 `atr2`** —— 出場規則是**第三份實作**
(`index.html` / `auto_trade.py` / `pro.html`)。使用者沒去設定中心點過的話,
產業作戰室用 ATR、散戶救星用唐奇安,**而且畫面上完全看不出來**。
⭐ 測試 `test_recoledger` 🚪⑧ **直接比對兩個檔案的預設值**,⛔ 以後改一邊會被擋下來。
⚠️ V77.2.4 起那條從已刪除的 `test_fishtank.mjs` 搬過來(釣魚池整組下架)。

#### 🐛 順手修:實測總表把 markdown 的 `**粗體**` 原樣印給使用者看
LAB 條目是手寫的、混著 `**x**`,而 **template literal 不會幫你轉** → 那兩顆星是印出來的(20+ 處)。
⭐ 在**唯一的顯示入口** `_labHi` 轉掉(⛔ 不改那 20+ 條資料字串 —— 那會打到一堆釘住字串的測試,
而且下次寫錯還是會再犯);樣式刻意不吃跨標籤的 `**`(`[^*<>]`)以免切壞 HTML 標記。

⚠️ **注入驗證的誠實紀錄**:7 種注入裡**第一輪有 1 種沒抓到** —— 把頂端標籤改回「一張合計」
測試照樣綠,因為「帳面浮動」四個字在**每一列的註腳**也有。
⭐ 通用(又一次):**斷言的搜尋範圍要縮到「被改的那一塊」**(改成只取 `.fishcard > .kv`),
否則它會被頁面別處的同樣字串救活 = 假綠燈。

### 🔓 V78.4.2 鐵則:散戶 App「有價值的進階功能」統一放「連點版本號 5 次」解鎖區(使用者明示,永久)
使用者:「爾後有這種有價值的統一都放在那裡,放進去的時候也要排序或者設計好,不要盲目一直新增功能,請記起來」。
- 一律登記進 `_DECK_SECTIONS` 並標 `unlock:true`(⛔ 不另開第二個開關區、⛔ 不另存清單);設定裡「🔓 進階功能」照登記表順序列出,**順序 = 重要度**(⛔ 不照新增時間)。
- ⛔ 新增前先問:①能不能**併進既有那一項**(例:新的觸發專欄 = 加一個條件 id,⛔ 不是新開一區)②要排在第幾、為什麼 ③沒解鎖時畫面一個字都不可多。
- 解鎖後的內容仍照 V78.3.4:只講「怎麼做」⛔ 不放研究數字(`lib_retailbad.mjs` / `test_retail_clean` 👑 模式會掃)。測試 `scripts/test_advunlock.mjs`。

### 🧹 V78.3.4 鐵則:散戶 App(index.html)畫面⛔ 不放任何實測 / 回測文字 —— 一律在產業作戰室(pro.html)
使用者:「散戶 app 裡面太多實測資訊,還有 xx 版本實測資料,相關我不想給別人看到…整份資料我都要查」→ 選「只留『怎麼做』」。
- ⛔ 畫面(含 `title` 提示、說明彈窗、`jargonDict`)不可出現:實測 / 回測研究 / 探針 / 六關 / 起點中位 / 對照組 / 安慰劑 / 樣本外 /
  含息比較 / 贏輸 0050 / 勝率 X% / 期望值 X% / 幾 pp / 版本號字樣(設定版本徽章除外)/ 模擬成績。
  交易術語「回測月線 / 回測不破」(股價回頭測試)不算。
- ✅ 只講**怎麼做**:怎麼選、什麼時候買、怎麼賣、空頭不買、錢放哪、白話的風險(「中途可能賠掉一半」⛔ 不給數字)。
- ⭐ **判斷邏輯一行不改** —— `_SIGNAL_EDGE` / `_LEADER_EDGE` / `_EDGE_RULES`… 照樣在背後排序、守門;只是不印出來。
- 🔬 實驗室模式 `index.html?lab=1`(`app._labMode()`,`<html class="lab">`):`[data-labonly]` 只有這個模式看得到
  (自訂回測 / 盲測 / 個股回測分頁)。⛔ 一般模式不放任何連到 lab 或 pro 的入口。
- 🧪 守門 `scripts/test_retail_clean.mjs`(🧬 / 👑 × 全部頁面 + 設定 + 說明彈窗 + title;`SCOPE=` 分區、`REPORT=1` 只列、`INJECT=1` 注入必紅)。
- ⛔ 新增任何卡片 / 說明 / 提示詞以外的畫面文字,先問「這是怎麼做,還是研究成績」—— 研究成績寫進 pro.html LAB。

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

### 🗑️ FinMind 付費金鑰 2026-10-01 失效 → V79.0.0 起**沒有付費資料**(使用者決定整組移除)
- `FINMIND_TOKENS` 現在只剩**免費層**(register,約 600 req/hr/把)。⛔ 別再寫「付費版 6000/hr」、⛔ 別再設計任何要付費資料集的功能。
- **已移除(畫面 + 採礦)**:券商分點(含 `chips_deep` 累加、BSR 爬蟲、主力雷達、券商勝率榜、分點檔案)+ 10 個付費資料集(八大行庫 / 借券 / 集保分級 holders / 官方處置 / 產業鏈細項 / 當沖比 / 外資水位 / 鉅額 / 可轉債 / 權證)+ 官方融資維持率。決策紀錄見 `docs/DECISIONS.md` V79.0.0。
- ⭐ **`data/chips/{sym}.json` 路徑照舊,但只放 `fundamentals`**(`miner.fetch_free_fundamentals`)—— X 光機 / 報告頁 / `top_picks` 讀它,⛔ 不可整個刪。
- ⛔ `chips_deep` 分支**沒刪**(兩年分點歷史,探針還讀得到);只是不再寫入。
- 核心策略(🧬 / 決策台 / 三條出場 / 👑 / `auto_trade.py`)本來就一行 FinMind 都不用,不受影響。
- 想加回分點:要使用者重新買 Sponsor,⛔ 而且要先問 —— 那是採礦 + workflow + 畫面的大改。

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
3. ~~分點籌碼~~:🗑️ V79.0.0 已移除(付費金鑰失效)。`data/chips/{sym}.json` 只剩每檔基本面。
4. **外資期貨**：優先直連 **TAIFEX (期交所) 官方 CSV** 解析多空淨額，不再依賴容易斷線或缺漏的第三方 API。
5. **美股大盤**：yfinance

### 重要規則
- `fm_get()` 任何非200回應都會 fallback 到匿名請求
- 分點籌碼「已是最新跳過」時，仍呼叫 `_refresh_broker_names()` 更新對照表
- OHLCV 補丁邏輯：若舊記錄缺少 `foreign_net` 欄位，下次採礦時自動補上
- **採礦補挖機制**:每次 daily_miner 跑都全市場重抓,沒有「N 次後永久放棄」黑名單。某支股票連續 10 天 FinMind 拉失敗,下次跑還是會試。週末無 cron(只跑週一~五 16:30),所以週六/日資料缺只能等週一或手動觸發 Actions UI 重跑

### 監控清單
`CHIP_WATCHLIST` = 約50檔上市上櫃熱門股 + ETF(V79.0.0 起只用來決定「熱門股先補基本面」)。

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
⭐ **V75.1.7 補記:那次只刪了一半** —— 實跑 grep 又找到 **9 處**還活著
(`twiiState`+`emergencyMode` / 深度診斷 chip / 全球情報 fiLine / 順逆價差判讀 / 小卡+圓點 /
當沖方向訊號 ×2 / **AI prompt 的 fiLabel** / 明日機率 `_pBear`),
後果是每天進緊急模式、每天顯「極空」、每天餵 AI「極空」、每天多 15 分。
現已全數接完,並用 `scripts/test_fifut_gate.mjs` 把「⛔ 舊寫法不可再出現」釘住。
⭐⭐ 通用:**寫下「一律改用 X」時,當場 grep 舊寫法還有幾處、逐一接完,再寫一條測試釘住** ——
否則規則只活在文件裡(陷阱 #37)。

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
- **問問題時機**(2026-10-23 更新,使用者:「直接一直做下去就好」):**只有兩件先問** —— ① 會動真錢的開關 ② 刪掉使用者自己存的資料 / 不可回復的刪除(詳見上面「Claude 永久授權」)。其他(含架構大改、改 GitHub Actions、動採礦邏輯)直接做、做完回報怎麼換回;拿不準的取捨挑一個合理預設先做,回報時寫出來。連「需要繼續嗎/部署嗎/版本要不要 bump」都不用問
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
  - **新聞翻譯 / 簡訊 / 輕量建議判讀** → **Groq**(主力,速度成本優勢;模型名自動挑 —— 🤖 V79.5.8 起 llama 已全部下架:`qwen/qwen3.8-27b` 首選(中文強、預設不思考)→ `gpt-oss` 備援(低強度思考、額度 +400)、⛔ `allam`(阿拉伯文)永遠不用)
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
- 🚨 **注入驗證的每一輪之間要清 `__pycache__`**(V75.1.5 實測踩到):`cp` 還原後 mtime 常在**同一秒**內
  → Python 沿用**上一輪注入版本**的 `.pyc` → 你驗的是上一輪的程式,會得到跟資料矛盾的結論。
  `find . -name __pycache__ -exec rm -rf {} +` 再跑。
- 🚨 **測試紅燈先分類再修**:V75.1.5 一次修 26 支,真 bug 只有 **1 個** —— 其餘是
  ① 本地沒有採礦產物(跑 `bash scripts/fetch_testdata.sh`,⛔ 別去改測試把真因蓋掉)
  ② 斷言釘住「當時的實作/當天的資料」(⭐ 改成釘**用意**:跟唯一真相來源比對,或用固定測資走那條分支)。
  ③ ⏰ 讀**真的時鐘**(沙箱瀏覽器是 UTC:測資更新後到 UTC 午夜,台北前一天收盤那根會被當成「今天盤中」)→ 把 `_lastBarIsToday` / `_tpeMinutes` 釘住(V79.5.6 `test_dupnum ⓚ`、`test_mktwarn ③d`)。
  ⭐ **永遠紅的測試等於沒有測試** —— 看久了會養成忽略的習慣,真的壞掉那次也會被當成又一個誤報。
- 🚨 **合成測資要「整組」合成**:只換一半(如只換 `_fenPeriods` 卻留著真實 `_fenHist`)會被真實資料汙染,
  分支根本沒走到 = 假失敗/假綠燈。凡是同一個計算會讀到的欄位都要一起換掉。
- 💀 **`git show … > CACHE` 失敗會留下 0 bytes**(shell 的 `>` 先建檔)→ `existsSync` 是 true →
  之後每次讀空檔、**永遠不會自己好**(陷阱 #18/#20 第三次犯案)。測試取雲端測資一律走
  `scripts/lib_ghdata.mjs` 的 `ghJson()/ghJsonOrDie()`(驗內容 → 壞的刪掉重抓 → 拿不到就誠實 exit 1)。
- **多代理審查 + 人工驗證流程(鐵則,V41.27 起實證有效)**:
  1. 派 2+ 個 `Explore` 代理平行掃(前端一組、採礦/workflow 一組),各自只回「確認的 bug + 行號 + 具體失敗情境 + CONFIRMED/SUSPICIOUS」。
  2. **人工逐條讀原始碼驗證真偽** —— 約 1/3 是誤報或設計取捨,**別照單全收**。
  3. 只修「人工確認為真」的,誤報要在 commit message 寫明「已驗證非 bug」留紀錄。
  4. 四驗證 + 分 Batch commit,每個 Batch 版本 +0.1。
- 🚨 **注入驗證要先確認「注入真的注進去了」**(V75.2.6 實測踩到):我把測試字串插進 `seasonModal`
  而不是要驗的 `chartHud`(「布林上軌」四個字在檔案裡出現在**三處**,改到了第一處)→
  「沒抓到」被誤讀成「偵測器有洞」,差點去修一個沒壞的東西。
  ⭐ 注入後先 grep 確認被改的是你以為的那一段(或直接印出那張卡的 innerText)。
- **git/workflow 類 bug 要「實測」不要用猜的**:改 workflow 的 git 流程時,開 `/tmp` 小 repo 實測 `git checkout -f` / `git add -f` / gitignore 交互(如 V49.4 實測 `checkout -f` 可越過 gitignore untracked 衝突),別靠推理。

**每次 push main 前必跑的「四驗證」**(⚠️ 全專案以這份為準,別處若寫「三驗證」是過期敘述):
1. `node scripts/smoke_test.mjs`(headless 真載入:app init / 43 個偵測器 / render 函式 / 無 pageerror。比舊的 `node --check` 只驗語法強得多)
2. `python3 -m py_compile *.py`(後端語法)+ **`python3 scripts/check_main_order.py`**(採礦進入點順序 — V71.1.1 新增,見下方陷阱 #9)
   + **`python3 scripts/check_workflow_paths.py`**(採礦產物有沒有真的被 artifact 上傳 — V71.4.7 新增,見下方陷阱 #11)
   + **`python3 scripts/check_wf_bash.py`**(🐚 每支 workflow 的 run 步驟先過 `bash -n` —— V79.3.8 新增:`stock_deep_backfill.yml` 還原步驟少一個右引號,YAML 合法、其他檢查全綠,**只有接力的下一棒真的跑到才會語法錯** → 補挖整串半夜無聲斷掉;有 `--selftest`)
   + **`python3 scripts/check_undefined_py.py`**(用到不存在的名字 = 潛在 NameError — V72.3.0 新增)
   + **`python3 scripts/check_dup_def.py`**(同一個檔案裡重複定義同名函式 → Python 用最後那個,前面等於死碼 — V74.6.9 新增,實跑踩到才寫的)
   + **`python3 scripts/check_env_default.py`**(🔧 workflow 從 `inputs.*` 餵的環境變數,Python 端必須 `or 預設` —— 排程觸發時是**空字串**不是不存在;V75.1.3 新增,pe_band 四個週日零產出就是這個坑,V74.7.0 intraday_probe 是第一次)
   + **`python3 scripts/test_intraday_relay.py`**(🛟 盤中即時檔「留不留得住」—— 2026-09-10 新增:兩支盤中 workflow 都要**也推 data 分支**,⭐ 開真的 git repo 實跑 yaml 裡抽出來的 `deploy()`,而且有**決定性對照組**(拿掉那段必須重現「daily_miner 洗版後消失」)
   + **`python3 scripts/test_tick_backup_skip.py`**(⏭️ V79.5.6 盤後才到的排程備援:今天主迴圈已經抓到 13:20 以後那一拍 → ⛔ 不再整天重抓(一次約 50 MB 永豐流量);只有「排程 + 平日 + 收盤後」才可能跳過,在登入之前判斷、原檔一個位元組不差交回;⭐ 決定性對照:同一份資料改成手動觸發 → 一定往下走)
   + **`node scripts/test_xraycache.mjs`**(💾 V79.5.6 基本頁本地快取真的寫得進去(以前 _ts ReferenceError 被吞,從 V72.5.5 起一次都沒存)・每檔一份有上限・資料日期帶著 `data/chips/{sym}.json` 檔頭的 data_date、⛔ 不可寫「資料日期未知」;INJECT=1 / 2 兩種舊寫法都紅)
   + **`node scripts/test_nodirective.mjs`**(🧹 V79.5.6 行事曆 📚 `_MACRO_EVENT_PLAYBOOK` 與個股頁頂端訊號標籤 ⛔ 不可再下買賣 / 部位指令(減碼・加碼・買進・賣 1/3・現金比例・分批建倉);事後一律收在「手上的照你的出場規則走」;🧹 V79.5.7 ③ 全檔靜態掃描:看得到的字 ⛔「分批停利 / 減量或空手 / 持股減碼 / 現金為王 / 空手觀望 / 反向操作」(⛔ 註解不算;死碼與理論原文頁列白名單附理由,白名單每條都要用到)・④ 永豐智慧單「直接照抄」價位 = `_exitDistance`、⛔ 停利觸發 / 先賣一半 / 回檔 5% / −10%;🧹 V79.5.9 ⑤ K 線頁「🗣️ 朱老師這樣看」(含最上面的共振框、主升段體檢)⛔ 自己給進出指令(停利 / 分批出 / 就撤 / 快進快出 / 再進 / 以偏多為主 / 高信度買點 …),💡 操作一律「要不要買照決策台、手上的照你的出場規則走」(空頭守門那句照留);🔕 V79.6.1 ⑥ 盤中即時警報 `_watchlistPulse`:K 線偵測器類(量價情境 / 頂背離 / 口袋支點・費波納契)先過 `_alertWorthIt`、低基期起漲 / 權值股超跌反彈 / 共振只記在 🔔(`quiet`,關掉嚴格提醒 = 舊行為)、六脈只在實驗室,⛔「停損設今日最低 / 可小量搏反彈 / 最高信度買點 / 持股快出 / 停利訊號」;實跑假資料三次(一般 / 實驗室 / 關掉嚴格提醒的決定性對照);🌇 V79.6.2 ⑥l 收盤後零股盤點(六脈)只在實驗室、⛔「可考慮零股分批 / 先不要加碼」;📢 ⑦ 法說會提醒 ⛔ 過去平均漲跌與偏多 / 偏空 / 利多出盡,`_findEarningsEvent` 先讀法說會一覽表(45 天,決定性對照:拿掉一覽表 → 找不到、財經行事曆有 → 備援);INJECT=1~8 八種舊寫法都紅)
   + **`python3 scripts/test_tick_incr.py`**(📶 V79.4.8 逐筆只抓上一拍之後的新成交:假行情商重放一整天 27 拍,每一拍 == 整天重抓、流量 < 25%(實測 9.5%);區間查詢不含起點那一秒 / 漏筆 / 丟例外 / 時間戳差 8 小時 / 換日 / 新進榜都要對;⭐ 決定性對照:拿掉多抓的 1 秒 + 拿掉每拍對帳 → 一定算錯)
   + **`node scripts/test_recorace.mjs`**(🏁 V79.5.3 成績單起算日 + 100 萬同一天起跑:跨檔(一天幾檔 / 每筆 / 本金 / 0050 成本 == index `_DECK_TRACK49` 與回測引擎)・🔥 名單隔天收盤 ≥ 觸發價才買、沒有觸發價不買・🅿️ 先賣 0050・沒有買進時 🅿️ == 📏・0050 除息・決定性對照(0050 不動且沒成本 → 🅿️ == 🔥)・👑 每檔 = 總資產 ÷ N、起算日之前的換倉不算・舊表 0050 == 📏;`INJECT=1` 五種注入全紅)
   + **`node scripts/test_premkt_age.mjs`**(🌅 V79.5.2 盤前體檢逐欄位日期:亞股比台股上一個交易日舊、ADR 比美股指數那天舊 → 只列不計分(決定性對照:同一份資料日期改新 → 照常算分);⛔ 盤中型態 / 順勢做多;分析師與全球快讀照日期講,前一天的⛔ 不可說成「今天開盤」)
   + **`node scripts/test_premkt_formula.mjs`**(🌅 V79.5.4 盤前分數全 App 唯一一支 `app._preOpenScore`:50 條權重 / 門檻釘死(改任何一個先跑 `premkt_app_probe`)・抓不到(null)⛔ 當 0(恐懼貪婪 null 以前 +0.5)・接線(實跑 == 直接呼叫、每項說明 = 餵進去的值)・亞股三項只列出來 0 分・產業作戰室 `PRO._premktScore` 抄本跨檔 300 組逐一相同;`INJECT=1` 五種注入全紅) + `node scripts/premkt_app_probe.mjs --selftest`(6 條,含「拿到當天美股 = 前視 → 方向對 0%」決定性對照) + **`python3 scripts/test_rh_fallback.py`**(🏦 V79.5.4 外資期貨「相對自己」的基準:本機沒有 risk_history 就讀已發佈的(macro_cron 乾淨 checkout 以前一天 5~6 輪寫「基準累積中」)・景氣燈號 ⛔ 宣告 br(runner 沒 brotli → 亂碼)) + **`python3 scripts/test_premkt_log.py`**(🌅 V79.5.5 盤前紀錄:平日台北 05:00~08:59 那幾輪把產業作戰室計分會讀的欄位存成今天那一筆(開盤前最後一輪為準;09:00 以後只沿用、週末不寫)→ `macro_risk.premkt_recent` 留 5 天;晚上 daily_miner 那輪(有底層資料才寫)併進 `data/premkt_log.json` 留 400 天(同一天晚到的才蓋、壞檔⛔ 不覆蓋);⭐ 決定性對照:晚上那輪只讀本機那份 → 少今天(要合併已發佈那份);`PREMKT_SNAP_KEYS` 涵蓋 pro `_premktScore` 與 index `_premktFieldAge` 讀的每一個欄位(跨檔實跑);`INJECT=1` 六種注入全紅) + **`node scripts/test_premkt_track.mjs`**(🌅 V79.5.5 產業作戰室「早上那份準不準」:判準跟 `premkt_app_probe` 一字不差(±0.3%、≥3 / ≤−3 跨檔比對)・0050 除息日 / 沒開盤 / 資料不足不算・講話 <20 天寫還在累積・表頭排序反向・⛔ 紅綠;`INJECT=1` 四種注入全紅)
   + **`python3 scripts/test_etf_chg.py`**(🗓️ V79.5.2 主動式 ETF 換股:基準一律是前一個交易日最後那份(`etf_miner._etf_day_step`),同一天第二輪⛔ 不可洗掉紀錄、換股頻率一天只衰減一次、抓不到什麼都不動;決定性對照:今天比今天一定是空的)
   + **`node scripts/test_idxparse.mjs`**(🎣 pro.html 從**正式網站的壓縮版** index.html 解析常數 —— V77.6.7 新增:讀 `origin/gh-pages:index.html`,舊 regex 在那份上六個全滅,而讀原檔的測試永遠綠) 🗜️ V79.1.3 起①改成自己用 `build_min.mjs` 壓一份來驗(gh-pages 是哪種形狀要看最後誰部署:deploy_pages 壓縮、daily_miner 推原檔),同時擋住「壓縮在部署時默默失敗」(V79.0.0~V79.1.2 抽樣清單留著已刪的 `_brokerEl`,每次退回未壓縮版、workflow 全綠)
   + **`node scripts/test_ovtruth.mjs`**(總覽/決策台講的話跟回測一致 —— V77.6.7:量堆積包住現價 / 不挑 🧬 少賺幾 % 讀常數 / 閒錢停 0050 數字 / 16 年輸 0050 含息那句;V77.6.8 ⑤ 決策台「看錯要不要先跑」七問全部讀常數、空頭清倉沒跑完要明說)
   + **`node scripts/test_ussig.mjs`**(🇺🇸 V77.7.7 回測引擎 `USSIG=<kind>|sham:<kind>` 外部逐日訊號候選層濾網:⛔ 不進 CACHE_KEY、不設時逐位相同;全部日期放行 → 筆數同基準;缺鍵 = 剔除並計數 ⛔ 不放行;⭐ 反向注入(只放行基準裡賠錢那幾筆)成績必低於基準;sham 通過率對齊實測、固定種子;對照表讀不到 / <100 鍵 → exit 1。真跑引擎約 3 分)
   + **`node scripts/test_equity_out.mjs`**(📈 V77.7.7 回測引擎 `EQUITY_OUT` 逐日市值淨值:不設時 summary 逐位相同(mdd 仍用舊的成本計 equity);天數 = 暖身後每一個交易日(bear60 擋掉的日子也有);最後一天 cash+park+cost−CAPITAL == 已出場筆的淨損益(從 TAKEN_OUT 重算);市值真的在動。約 2 分)
   + **`node scripts/test_statswin.mjs`**(🪟 V79.4.6 回測引擎 `STATS_WIN` / `STATS_FROM` 每檔打法成績只算最近 N 個交易日 / 某天以後進場的交易:⛔ 不進 CACHE_KEY、不設 == 原本(STATS_WIN=99999 / STATS_FROM=1900 逐位相同含逐日淨值)、STATS_WIN=60 一定要變、格式錯 exit 1;注入「視窗不生效」4 條紅。約 2 分)
   + **`node scripts/test_pbgate.mjs`**(🎯🧱🔁 V79.4.7 回測引擎對齊 App:`GATE=lb`(這檔這招 ≥8 次・照保守下界排・一檔最多 2 招 = playbook_scan,公式 `lib_lb.mjs` 跟 App 原始碼逐筆比)・`CLIFF=N` 斷崖守門(注入 1 拆 20,剔除筆數 == lib_cliff 逐筆算)・`WARMUPS` / `YEARRUNS` 一次跑多個起點 / 逐年格 == 單獨跑逐位相同(含隨機排序、停車 0050、yearly_bt `YB_BATCH`);⭐ 決定性對照 `GATE=lb LB_Z=0 MIN_N=4 LB_TOP=99` == 不設;3 種注入全紅;🧾 V79.4.7 `LISTK=K`(照前一晚名單前 K 檔、觸發才買 = App 實際買法):`LIST_FIRED/BEST/SELF=0` + K 很大 == 不設(決定性對照)、LISTK=1 一天最多 1 筆、WARMUPS 逐位相同。約 6 分)
   + **`node scripts/test_tradecache.mjs`**(🗃️ V79.4.7 交易快取 `.ndjson` == `.json`、兩片 `SHARD` 合併 == 單一建逐位相同、分片快取不可直接跑、缺片合併 exit 1)
   + **`node scripts/test_listtrig.mjs`**(🎯🔥 V79.4.8 回測重現 App 的「怎麼買」:`list_trig.mjs` 跟**真的 playbook_scan** 同一份資料逐筆比「列 / 不列 / 今天已觸發 / 不靠價位」+ NEAR=1% 必對不上的決定性對照;引擎 `LIST_DUMP` 開著逐位相同、`LIST_TRIG` 全可觸發 == 不設、全不可觸發 → 一筆都沒進場、缺一半要記「可能不準」;`ALLFIRE` 裡 seq=1 那幾筆 == 原本一筆接一筆的快取(逐筆相同)、進 CACHE_KEY、跟 REENTRY 互斥;名單快取跨起點逐位相同。約 4 分)
   + **`python3 scripts/test_auto_park.py`**(🅿️ V79.4.9 `auto_trade.py park_step` 閒錢停 0050(會動真錢):假永豐 66 條 —— 沒設帳戶不下單 / 每天上限 / 整張 + 零股 / ETF 跳動單位 / 一天一次 / 只賣自己買的 / 保留現金 / DRY_RUN 不寫狀態檔 / ⛔ 不碰 👑 / 每天重置保留 park / App `_parkPlan` == `park_plan` 跨檔比對;🚨 湊交割款 ⛔ 不可被「帳戶總資金過期」/ PARK=0 / 沒設帳戶擋掉、0050 買單隔天對永豐庫存才算自己的、真實帳戶 `PARK_LIVE_OK` 沒開只預覽、過了 13:30 不送單;⭐ 決定性對照:拿掉每天上限 → 一天買滿)
   + **`python3 scripts/test_auto_send.py`**(🧾 V79.4.9 送單出錯 ⛔ 不重送:整張 + 零股其中一筆出錯 → 🔥 / 👑 / 出場 / 延後賣只記已送出的那段(`SendError.sent_sh`)、下一輪不再送;今天的 0050 處理過就不再買 🔥;真實 / 模擬分兩個狀態檔;真實帳戶第一次跑新版沒標模式的舊部位一律搬 legacy(`_legacy_check`,⛔ 不查庫存・⛔ 不自動賣・⛔ 不擋買);模擬帳戶第一次跑接著用舊檔(子程序 + 暫存 HOME,舊檔一個位元組都沒動);👑 賣一半出錯剩下的當天延後賣;只有 👑 買也提醒湊交割款;👑 標模式;每條都有舊寫法必紅的對照)
   + **`python3 scripts/test_auto_hot.py`**(🔥 V79.4.9 `hot_step`:已持有的⛔ 不再買、原本的持倉紀錄一個字都不動 / 空頭預設照買(`BEAR_GATE=1` 決定性對照 → 一檔都不買)/ `fetch_picks` 照 `HOT_RULE` 篩列與排序)
   + **`node scripts/test_hotrule.mjs`**(🔥 V79.4.9 選股規則唯一一份:`lib_hotrule.mjs` == index `_HOT_RULE` == `lib_hotrule.py`;App 排序跟著設定(翻開關前 2 名真的變,決定性對照);auto_trade `fetch_picks` == 決策台 `_deckBuyOf`;playbook_scan 真的跑一次)
   + **`node scripts/test_pbmirror.mjs`**(🪞 V79.4.9 回測對齊 App 的開關 `SELF=…+nobear` / `MIN_MKT_N=0` / `NOLOCK` / `EOD_DUMP`:不設時逐位相同、設了真的生效)
   + **`python3 scripts/check_eval_scope.py`**(🧭 V79.4.7 `page.evaluate` 的回呼在**瀏覽器裡**跑,⛔ 不可用 Node 端才有的名字 —— 陷阱 #57;有 `--selftest`,含「拿掉 playbook_scan 瀏覽器裡那行 tickOf」必抓到)
   + **`node scripts/test_pbscan_run.mjs`**(🎯 V79.4.7 明日作戰清單**真的跑一次**(30 檔、正式入口):至少一筆有觸發價、觸發價 / 停損對齊跳動單位、分析例外 0 檔;⭐ 決定性對照:拿掉瀏覽器裡的 tickOf → 必須 exit 1 且⛔ 不寫檔。約 40 秒)
   + **`node scripts/test_pbpick_same.mjs`**(🧬 V79.4.7「今天可以買的」三處同一條:決策台 `_deckBuyOf` / 尾盤提醒 `_eodTriggerSweep` / `auto_trade.py fetch_picks` 都要「🧬 + 這一檔自己不是空頭」;同一份清單前 2 名跨語言比對;⭐ 決定性對照:🧬 只剩 1 檔 → 兩邊都只給 1 檔(舊版 auto_trade 會補別的))
   + **`node scripts/test_exitsched.mjs`**(🔄 V77.7.6 回測引擎 `EXIT_SCHED`(照排程換出場規則):⛔ 不進 CACHE_KEY、不設時一字不變;⭐ 決定性對照 = 排程全期同一套 == 直接跑那一套(逐位相同);交替排程兩套都要真的成交;缺快取 / 快取參數對不上 → exit 1;含 `exit_switch_probe --selftest`(零前視 / STEP)。真跑引擎約 4 分)
   + **`node scripts/test_volcap.mjs`**(🧱🛡️ V79.0.4 回測引擎 `VOLCAP`(一筆不可超過訊號日成交額 P%)與 `EQGATE`(看不設閘門那次的淨值決定暫停開新倉):⛔ 不進 CACHE_KEY、不設時逐位相同;上限很寬 = 不設;shift K=0 決定性對照;沒給 src / 一天沒暫停 → exit 1。真跑引擎約 3 分)
   + **`node scripts/test_lib_limit.mjs`**(📏🧱 V79.4.2 回測共用的漲跌幅制度與斷崖守門:2015-06 前 ±7%(`lib_limit`)、×1.5 / ×0.67 只剔窗口 ⛔ 不整檔剔除(`lib_cliff`);已接上的探針 ⛔ 不可再寫死 9.7 / 1.095 / 整檔剔除(決定性對照:塞回舊寫法要抓得到);還沒改的只列出來,S2 重跑那一支時改並加進清單;🔁 V79.4.3 Python 版 `scripts/lib_limit.py` + **跨語言比對**(同一批案例 JS == Python,注入「Python 忘了 2015」必紅)、掃描擴到 `.py`、`screener_miner` 的 `lim` 照日期)
   + **`node scripts/test_holdshade.mjs`**(📦 V79.0.5 K 線「回測持有區間」:只在實驗室模式、塊數 == `_patternFitBacktest` 那一招的趟數、紅賺綠賠用收盤獨立驗、換出場規則跟著變、樣本不夠不畫、trips ⛔ 不進 localStorage)+ **`node scripts/test_cbtlog.mjs`**(📚 自訂回測紀錄:取消的不存、只存摘要、留 20 筆、表頭排序可反向、勾兩筆並排差值、母體不同要警告、prune ⛔ 不清、id 不撞號)
   + **`python3 scripts/test_newscluster.py`**(🧩 V79.0.6 新聞同一事件歸群:三條規則 / 不同事件不併 / 不同天不併 / 中性被取代連來源一起換 / 歷史第 4 欄;門檻 1.0 決定性對照;正式入口欄位讀得到;真資料台積電剩 ≥90%)+ **`node scripts/test_newsdup.mjs`**(「另 N 家也報」兩處都接、跳脫含引號、灰字)
   + **`python3 scripts/test_namematch.py`**(🏷️ V79.0.7 新聞股名誤配:origin/data news_hist 重放,已知誤配全擋、已知正確全留、擋掉 ≤15%;清單清空 → 一則都擋不掉的決定性對照;index.html `_NAME_GUARD` 跨檔比對 + 真標題行為一致;AI 指令當標題丟掉)+ **`node scripts/test_accrfilter.mjs`**(💵 應計避雷:月門檻切法 / 嚴格早於 / 不知道保留 / ⛔ 不進 CACHE_KEY / sham 對齊 / 空過停)
   + **`node scripts/test_rotate.mjs`**(🔁💸 V77.7.4 回測引擎 `ROTATE`(錢不夠時賣掉最弱那檔換新候選;`lose` 只換帳面虧損的、`shamlose` 安慰劑)與 `COST_X` 成本壓力:兩個都⛔ 不進 CACHE_KEY、⛔ 不改 `vic.ret`(選股門檻的歷史成績)、換掉那筆用實際賣出價與賣出前的股利、0050 對照⛔ 不跟著放大成本;真跑引擎約 3 分)
   + **`node scripts/test_labplain.mjs`**(🗣️ V77.7.9 實測總表白話層:✅ 每條必帶 `pl:[分組,環節,可信度,一句話,對你的意思,白話數字]`、分組順序、第一張仍 🧬 🥇、⛔ 白話層不可有 🔴🟢、沒 pl 的欄照附件 build.py 規則推、點環節 = 搜尋、匯出 = 畫面順序;⭐ 決定性對照:改 pl 畫面與匯出一起變;5 種注入全紅)
   + **`node scripts/test_selllog.mjs`**(🎯 V78.5.7 編輯庫存賣出:淨損益 / 部分賣 / `_oi` 決定性對照 / 只有一處寫日誌)+ **`node scripts/test_daytrades.mjs`**(📼 當日全部逐筆:翻頁到開盤、每頁大小不寫死、額度用完不假裝完整、只補新的、即時串流併入、IndexedDB)
   + **`node scripts/test_ai_model_pick.mjs`**(🤖 V78.5.6 AI 模型下架自動換:清單有照用 / 沒有換同級 / 問不到用原名 / 404 只重試一次、一般 400 不換;groq chat 只在 `_groqFetch`、Gemini 只在 `_callGemini`;三份 Gemini 規則跨檔比對;🤖 V79.5.8 Groq 真清單(沒有 llama)挑 qwen、每個模型帶自己的參數、偏好序與參數 index == groq_common 跨語言比對)+ **`python3 scripts/test_groqmodel.py`**(採礦端 Groq:真清單 × 20 種亂序都挑 qwen、⛔ allam、緊急退路不抽籤、換模型清掉上一個的參數;⭐ 決定性對照:舊偏好 + 舊硬清單 → 第一發就是已下架的 llama) + **`python3 scripts/test_techgiants.py`**(🛰️ V79.5.9 新聞來源:科技巨頭每一個來源桶都收得到(以前寫死 4 桶,earnings 從 V73.9.1 起一直是空的)、翻譯每一桶都跑、index.html 每一桶都有讀;抓不到的 RSS 要印出實際拿到的狀態碼 / 類型 / 開頭;決定性對照:臨時多加一個來源 → 輸出也要有、抓得到文章 → 不印診斷;🗑️ V79.6.1 ⑥ 已失效的 4 個來源(鉅亨 ×2 / MoneyDJ / 工商時報)⛔ 放回 `RSS_SOURCES`、空過守門 ≥5 個) + **`python3 scripts/test_macro_groq.py`**(🤖 V79.6.0 財經行事曆的 Groq 呼叫:走真的 `_groq_chat_mm` / `build_macro_events_ai` 只換網路 —— qwen 一次就中帶 none、404 → gpt-oss-120b → 20b 帶 low 且額度不疊、`<think>` 剝掉、`macro_events_ai.model` = 真的回答的那個;決定性對照:groq_apply 換回只換模型名 / 不記真的回答的模型 → 各自紅)
   + **`python3 scripts/test_confcall_deck.py`** + `python3 confcall_deck.py --selftest`(📞 V79.6.3 法說會簡報讀取:假網路、真的 PDF / PPTX 位元組、走正式入口 `run()` —— 抽字帶頁碼、免責聲明⛔ 當展望、同一份簡報只讀一次、「第一次提到」跟這家公司前幾份比(沒有上一份⛔ 說新)、回網頁 / 連 5 份失敗收工、一份都沒讀到 rc=1;AI 數字核對:編的數字整點丟掉(決定性對照:關掉核對 → 編的那句留下來);📚 回補:清單一個月一個月查、被擋的月份下一輪重抓、讀的順序(最近 → 這些公司前 4 份 → 其他)、more=1 接力、「第一次提到」跟著回補變準、日期改成最早那場、「大家都在講」只看之前 100 天(⛔ 前視)、data/cc 內容沒變不重寫;AI 被限流換下一把只等 1 秒、連 3 份失敗本輪不再叫;🐢 一份最多下載 2 分鐘、抽字在子程序裡 60 秒時限(卡住整個砍掉);⚡ 抽字先用 pdftotext、沒有退回 pypdf(⑱ 兩條路頁數一樣))
   + **`node scripts/test_confcall_ui.mjs`**(📞 V79.6.3 法說會簡報重點的畫面:產業作戰室法說會頁預設 🆕 剛開完(7 天)・👜 我的排最前・其餘照「第一次提到」多寡排・四種標籤(新東西 N / 第一次收錄 / 沿用舊簡報 / 沒有新的詞)・展開才讀 `data/cc/{sym}.json`(數字 / 頁碼 / 上一份有這次沒講 / 開完到現在 vs 0050,決定性對照:K 線換一組數字跟著變)・讀不到 digest / cc 檔 ≠ 簡報沒內容 ≠ 沒有法說會・搜簡報裡的詞(決定性對照:拿掉 tm 搜不到)・AI 文字跳脫・⛔ 方向詞・390px;散戶 App 基本頁那一格:有資料才顯示、數字只列前 3 句、連結用採礦給的樣板、await 回來切走 ⛔ 畫上一檔(決定性對照:沒切走照常畫))
   + `node scripts/retail_inst_probe.mjs --selftest` + `node scripts/margin_call_port.mjs --selftest`(🎭💥 V79.6.3 散戶 vs 大戶:融資 × 三大法人事件研究 7 條(含前視注入)/ 融資斷頭組合 4 條;追繳線 `marginCallAt` == App `_marginCallState` 同一條,App 觸發 `retail_catch` / `margin_call` 由 `test_advunlock ③q2/③q3` 釘「成立 vs 不成立」)
   + `python3 scripts/confcall_feat_dump.py --selftest` + `node scripts/confcall_content_probe.mjs --selftest`(📞 V79.6.3 法說會「內容」研究:特徵一律呼叫 `confcall_deck` 自己的 `novelty_all` / `tone_of`(⛔ 第二份);隔天開盤進、比同一天所有股票 + **同月低組**(量內容 ⛔ 量「有開法說會」)、安慰劑同月打亂;⭐ 決定性對照 ⑦:只埋「有開法說會」本身 → 比同一天是負的、比同月低組 ≈ 0)
   + **`node scripts/test_contrast.mjs`**(👁️ V78.5.6 灰色說明小字對比 ≥4.5:1:真資料 13 頁量 computed color;決定性對照拿掉那條 CSS 必 0%;hover 仍要變亮)
   + **`node scripts/test_ainumgate.mjs`**(🧾 V77.8.1 App 內 AI 回答數字核對:日期/編號⛔ 不當主張、格式變體⛔ 不誤報、⭐ 真實 2330 提示詞重述 0 個找不到 + 插一個編的恰好抓 1 個、五處接線、全部對得上⛔ 不顯示;4 種注入全紅)
   + **`node scripts/test_promptaudit.mjs`**(🧾 V77.7.9 提示詞稽核:盤前速報⛔ 不可再有憑空係數的「機率」/ 點名個股進場 / AI 自寫點數 / 🟢 當進攻;總經深度分析⛔ 不給部位成數;事件影響⛔ 不問利多利空、⛔ 不叫 AI 寫代號;對照舊版 13 條全紅)
   + **`node scripts/test_labexport.mjs`**(📤 V77.7.3 實測總表匯出給 AI:條數 = LAB 加總、沒有 HTML 標籤、一定帶回測方法段 + 提問範本、排序跟畫面同一套、複製失敗⛔ 不靜默;⭐ 決定性對照:改 LAB 一條數字匯出要跟著變)
   + **`node scripts/test_leaderdeck.mjs`**(👑 V77.8.8~V77.8.9 決策台「領頭羊短線輪動」第二套:池子 = `amt20` 前 100 ⛔ 不是今天的 `amt`、趨勢過濾用乖離推 `b20 > 0 且 b20 < b60`、排名 = `chg10` ⛔ 不拿 chg5/chg20 湊、欄位缺 → notyet、空頭只擋買不藏名單、換倉日 = 共用錨點 `_LEADER_EDGE.anchor`(⛔ 不存手機)、實測數字讀 `_LEADER_EDGE`(決定性對照);⑤ **規則 / 錨點 App == `auto_trade.py`**、Python `leader_calc` == JS(合成 + 正式 screener,chg20 決定性對照)、舊名單⛔ 不下單;⑥ 決策台每列 🚧量薄(`amt20` < `_DECK_THIN_AMT` = pro `CAST_MIN_AMT`);⑦ K棒轉多/轉空榜每列實測成績(標題反查 `_SIGNAL_EDGE`,單根變盤線⛔ 不借成績))
   + **`node scripts/test_generank.mjs`**(🧬 V78.0.7 位階門檻四份實作同一個數字:`playbook_scan` hq / index `_GENE_RULE` / pro `_HQ_RULE` / `auto_trade.py GENE_RANK`;⭐ 決定性對照:設定換回 75 → 位階 80 那筆變成 🧬、排序跟著變;pro `_recoPicks` 重建過去刻意讀當時的 hq)
   + **`node scripts/test_leader_deck_ledger.mjs`**(📒 V78.0.3 決策台領頭羊模擬帳 == 產業作戰室成績單,逐筆比對 + 名單倒過來的決定性對照;讀不到每日名單要說原因)
   + **`node scripts/test_rodload.mjs`**(🎣 V77.9.4 釣魚頁:財報慢 8 秒 3 秒內仍有魚、💎 讀取中、預設 👑 池、戴冠 = 前 N、拋竿 = 前 N;2 種注入全紅)
   + **`node scripts/test_settings_slim.mjs`**(🧹 V78.1.1 設定瘦身:三件刪掉的⛔ 不可復活、搬家 33 個 id 都在、常用四件在摺疊外 + 四組收起來、第一眼 ≤1,600 字;🅿️ 只在解鎖時出現且 `_strat()` 仍是 gene、停車金額決定性對照;機率 chip 頂端一行綁 sym、成交額前 100 用 amt1 決定性對照)
   + **`node scripts/test_pickboard.mjs`**(🏆 V78.1.0 實測總表「選哪一套」:🔥/🅿️/🐢 跟 0050 同一組 17 起點(`gene_board.mjs` 對齊看板,0050 交叉驗證)・一句答案金額 == 看板・0050 及格線、線下變淡・名字表不重複且⛔ 不用版本號當名字・🧬 看不到 👑・預設頁籤 = 選哪一套)
   + **`node scripts/test_profitboard.mjs`**(💰 V77.9.4 回測數字頁「100 萬變多少」:同一組起點、0050 只有一個數字、每欄可排序、中途最多賠不可拿掉、小資金三件事、舊表收進研究用)
   + **`node scripts/test_leader_ledger.mjs`**(📒👑 V77.9.3 成績單領頭羊模擬帳:只在換倉日動、成交在隔天收盤、掉出前 10 才賣、空頭不買、漲停不補、幽靈日不算、`--leader` 不洗掉既有 `lead`;4 種注入全紅)
   + **`python3 scripts/test_auto_leader.py`**(🤖 V77.8.9 `auto_trade.py` 領頭羊 `leader_step`:假 Shioaji 12 條 —— V78.2.4 ⑭⑮ 預設開盤 / 09:01 才做 / 抓不到重試 / 過 09:10 跳過;非換倉日只記 log、⛔ 不碰 `pos`、整張+零股拆單、下次換倉賣掉出前 2N、空頭只擋買、舊名單不下單、漲停不補第 6 名、LEADER_ACCOUNT=0 只看、一天一次、DRY_RUN、硬剎車)
   + **`python3 scripts/test_margin_placeholder.py`**(💳 V77.8.9 `screener_miner._margin_placeholder_to_none`:採礦寫 0 當融資佔位 → 5 日增減 −100% 的假數字;一直 0 照留;走真的 `build_one`;拿掉守門必算出 −100 的決定性對照)
   + **`node scripts/test_etfhold.mjs`**(🐢 V77.6.8 手上的 ETF ⛔ 不套個股三條出場:`_invExitScan` 另列 / 決策台 `[data-exitetf]` / `_ovDecide` state `etfhold` / `_exitDistance` 回 `etf:true` 的空三條 ⛔ 不回 null;⭐ 決定性對照:同一份 K 線換代號 2330 就要「抱滿 40」;2 種注入全紅)
   + **`node scripts/test_dispohold.mjs`**(🚨 V77.6.8 持股進處置/注意 → 決策台賣出列要有徽章 + 說明;⭐ 離線遠的持股本來一列都不畫 → 在名單上的另列一區 `[data-exitatt]`;`_DISPO_HOLD_EDGE.hold` 是 null 要明說「還沒測」⛔ 不編答案)
   + **`node scripts/test_forceexit.mjs`**(🐻🚨 V77.6.8 回測引擎 `BEAR_EXIT` / `FORCE_EXIT` 鉤子:真的跑引擎(repo `data/` 25 檔,約 3 分);空頭日賣收盤、事件日之後第一個交易日賣**開盤**(⛔ 事件日收盤是前視);兩個一定進 CACHE_KEY;不設時 key 一字不變;設了卻 0 筆 → exit 1;⚠️ 被提早賣掉的那一檔會多出**新**交易,斷言只比兩邊都有的那些筆)
   + **`node scripts/test_noframe.mjs`**(🧱 全站無框守門 — V77.0.0 新增:量 **computed style** 證明「一整段的外框真的拉平了」+「⚠️ 警示左色條 / 按鈕 / 輸入框 / `.keepbox` 格子一個都沒被拉平」,含 `pro.html` 的 `.panel`。⛔ 不釘 class 字串)
   + **`node scripts/test_fishapp.mjs`**(🎣 V77.9.7 股海釣手 = `pro.html?app=fish`:作戰室分頁/池子/規則段藏起來、⛔ 整頁不可有選股規則用語、⭐ 名單 == `_castPick`(一般模式同一支,動畫 stub 前後相同)、台股配色、reduced-motion、安全閥、manifest/圖示;V77.9.9 一次 10 條前面 == `_castPick`、四魚種外形不同、釣起價 = 即時價、帶回家養;V78.0.0 一按只釣一條(cast→wait→bite→fight→breach→show)、斷線同一條留佇列最前、魚色 = 一年高低位置且⛔ 不受今天漲跌影響、大小 = 市值、震動開關、公司簡介無選股用語)
   + **`python3 scripts/test_futures_night_gate.py`**(🌙 V78.1.4 個股期貨夜盤採礦:平日台北 08:45~15:00 ⛔ 不登入、不寫(排程被延到白天時會把日盤寫成夜盤);注入「拿掉守門」必紅)
   + **`node scripts/test_mktwarn.mjs`**(🔕 V79.3.5 大盤警示只描述:風險指數 / 反攻雷達黑天鵝 / 全球熔斷 ⛔ `_fireAlert` 只進鈴鐺、⛔ 減碼 / 空手 / 現金為王 / 全出清 /「頭部前兆」、出貨日用成交金額(決定性對照)、死卡⛔ 復活、worker ⛔「持股減 1/3」、`crash_warn_probe --selftest`;4 種注入全紅)
   + **`node scripts/test_retailsign.mjs`**(👥 V79.0.9~V79.1.1 散戶多空比:正值 = 散戶淨多(`_retailLsDir`);回測沒方向 → 主力出貨指數 / Telegram ⛔ 不計分(+54.7 / 0 / −54.7 分數一樣的決定性對照)、因子卡只寫「散戶偏多 / 偏空」、情緒卡⛔ 🚨⚠️💡;⛔ 舊寫法「< −25 = 過度看多」不可復活)
   + **`node scripts/test_leadbooks.mjs`**(📚 V79.2.5 👑 兩本帳:四份錨點一字不差、兩本⛔ 不同一天換倉、一本帳 == 舊時鐘(決定性對照)、只賣這本的 / 兩本都有賣一半 / 另一本有這本照買、每檔 ÷10、App == worker;2 種注入全紅)
   + **`node scripts/test_leadlive.mjs`**(📡 V79.1.6 👑 表:欄位順序 / 標籤在代號旁 / 表頭標日期 / WebSocket 分片 5·5·4 / REST 不併發 / 跳價只改格子 / 15% 怪價丟掉 / 離開決策台就關 / 七種口吻 / 手上已有不叫你買(決定性對照)/ 帳戶總資金過期不算 / 👑 時 13:00 提醒不讀名單;4 種注入全紅)
   + **`node scripts/test_leadday.mjs`**(⏰ V79.1.5 👑 今天 / 明天 `_leadPhase`・決策台上色 + 每天列會買哪 5 檔(名單倒過來的決定性對照)・硬停損提醒 = `_unifiedExitPlan().stopFinal`、尾盤確認、排除 👑・連續技同一個現價・開盤 / 13:20 提醒各一則・`lead` 提醒分類排第一・worker leadOwnedFrom / leadDayLines / leadTiming;3 種注入全紅)
   + **`node scripts/test_leakfree.mjs`**(🔒 V79.1.2 預設(沒解鎖)時畫面⛔ 沒有領頭羊字樣:主頁 + 設定(含展開「決策台要顯示什麼」)+ 個股 9 分頁 + 更新紀錄掃 `領頭羊|👑|換倉|LEADER_|成交額前 100|停車 0050`;⭐ 決定性對照:解鎖 + 👑 同一支掃描要掃得到 ・跑馬燈⛔ 不可復活、大盤風險推播照舊 ・預設決策台 📈 開 🔥 收 ・讀不到全市場快照⛔ 不可記住失敗(60 秒後自動再抓);3 種注入全紅)
   + **`node scripts/test_nobroker.mjs`**(🗑️ V79.0.0 券商分點 + 付費資料集移除:付費檔⛔ 不可再 fetch、刪掉的 id / 函式⛔ 不可復活、籌碼頁三大法人 / 融資券 / 集保沒刪過頭、報告頁本益比讀 chips fundamentals 的決定性對照)+ **`node scripts/test_trapbal.mjs`**(⚖️ V79.0.1 上面套牢 vs 下面賺錢:數字只讀 `_trappedRatio`、上方量 ×2 決定性對照、⛔「的人」、K 線不足 / 指數藏起來、總覽那行同一個數字)+ **`python3 scripts/test_free_fund.py`**(`fetch_free_fundamentals` 用假網路跑:chips 檔只剩 fundamentals、舊分點欄位被洗掉、冷門股零 API)
   + **`node scripts/test_dtlab.mjs`**(🔬 V79.0.3 即時頁 / 當沖頁 / 當沖雷達沒回測過的判讀只在實驗室模式:一般模式看不到、⛔ 不推播(六脈 / 09:15 候選 / 逐筆動能)、實驗室同一份資料看得到(決定性對照)・大戶散戶日期 = 成交日・當沖頁第一行在成本關卡前・即時頁現價 → 分時圖 → 五檔;3 種注入全紅)
   + **`node scripts/test_deckbuytbl.mjs`**(🎯 V79.0.8 決策台「今天可以買的」= 👑 那種表格:表頭排序 / 同欄反向 / 沒觸發價排最後、標籤走 `_pbTagsHtml`、張數走 `_lotsForPlaybook`(決定性對照)、⛔ 研究數字)
   + **`node scripts/test_lugap.mjs`**(🟥 V78.6.7 漲停隔天開低提醒:庫存開平開低 / 自選(V78.6.8)開低 ≥5% 或量縮鎖(量 ≤ 前 20 天六成,⛔ 基準不含鎖那天)開低 ≥1%,且第 1 根 ・09:00~10:30 ・一檔一天一次 ・👑 持股⛔ 不套 ・決定性對照(門檻改 −7 / 量縮改 0.4)・隔日沖盤點⛔「開低別接刀」)
   + **`node scripts/test_leadtiming.mjs`**(⏱️ V78.4.4 👑 換倉那天幾點買賣:`_leadWhen` 全 App 唯一一份 ・設定 leadTiming=open 決定性對照(⛔ 不再出現 13:25)・App 預設 == `auto_trade.py LEADER_WINDOW=split` ・Telegram 讀同一個設定 ・`_STRAT_CHANGES` 換回鈕)+ `python3 scripts/test_auto_leader.py` ⑯a~⑯g(split:開盤跌 ≥3% 例外、13:25 才買、過 10:00 尾盤補賣、隔天不買舊名單)
   + **`node scripts/test_leadheld.mjs`**(👑 V78.2.0 選 👑 的持股:不在名單寫「不在前 10 名」⛔ 不是「掉出」、`_keyLevels` 不存 🔥 的硬停損 / 出場線(價格尺・提示詞・接下來怎麼看)、切回 🔥 決定性對照、鎖漲停那行讀 `_LEAD_LU_EDGE`;3 種注入全紅)
   + **`node scripts/test_labmode.mjs`**(🔬 實驗室模式:直接開 `index.html?lab=1&sym=&sub=` 真的切到回測分頁、一般模式帶 `?sub=` ⛔ 不切、index ⛔ 無 pro 入口;🗑️ V79.0.8 pro.html 個股實測 / 今日訊號 / 財報三個分頁⛔ 不可復活)
   + **`node scripts/test_evening.mjs`**(📰 V78.4.0 盤後晚報 / 本週回顧只轉述既有(改 breadth idx / 法人 / 門檻 → 畫面跟著變)・⛔ 法人週合計 ・👀 差一點沒入選門檻讀 `_geneRank()`)+ **`node scripts/test_column.mjs`**(📰 專欄:每篇五段 ・⛔ AI 才懂的字 ・數字讀條目 pl[5](決定性對照)・新回測條目必有 col ・第一篇金額 == `_PROFIT_BOARD` ・V78.4.1 每篇有 range / 封面數字章讀 pl[5] / 分類篇數 / NEW / ⛔ 瀏覽按讚 / 👑 模式) ・V78.4.2 ⑰⑱ 每篇專欄必寫 `trig`(或 'none' + 為什麼)・散戶 App `_COL_TRIG` 抄本 == pro
   + **`node scripts/test_advunlock.mjs`**(🔓📰 V78.4.2 進階功能只在解鎖後・照登記表排序・觸發條件 15 組「成立 vs 不成立」決定性對照・K 線過期 / ETF⛔ 不判・畫面⛔ 研究字樣;3 種注入全紅)
   + **`node scripts/test_ovopen.mjs`**(🌅 V78.5.2 總覽開盤怎麼做:👑 split/open 決定性對照・改出場線分界跟著移・改觸發價文字跟著變・鎖漲停四列 == `d.due.rules`・跳動單位・盤中 👉 只一列;3 種注入全紅)
   + **`node scripts/test_ovprob.mjs`**(📊 V78.4.3 總覽機率圖:頂端那行已拿掉・數字讀 `_probBox`(決定性對照)・一般股票那條讀 base・綁 sym・390px 不溢出;3 種注入全紅)+ **`node scripts/test_attcard.mjs`**(🚨 V78.4.3 處置/注意股卡⛔ 怕關/新手別碰・要有照出場規則走 + 別用市價單・+30% 決定性對照;2 種注入全紅)
   + **`node scripts/test_stratrank.mjs`**(🏆 V78.1.9 設定的策略數字 == pro `_PROFIT_BOARD`、策略 / 出場規則照 16 年 → 4 年排(獨立重算)、靜態按鈕順序、leadpark / lead / park 三種判斷、總覽讀 `_deckRankOf`(沒固定觸發價的也⛔ 不寫觀望)、決定性對照與空頭守門;4 種注入全紅)+ **`node scripts/test_deckfin.mjs`**(🗑️ 營收加速開關⛔ 不可復活;決策台與總覽同一份名單)
   + **`node scripts/test_aigod.mjs`**(🤖 V78.1.7 AI 股神個股模式只轉述 `_ovDecide`:大字 == badge(決定性對照)、⛔ 沒有 🔴 續抱 / 賣一半 / AI 總評分、停損 floorTick、`_lotTxt`、持有寫交易日、庫存每檔有出場行;7 種注入全紅;V78.1.8 ⓗ~ⓙ3 提問清單⛔ 該買該賣・提示詞帶本站數字・位階 == `_basePos` ⛔ 紅綠・白話解析⛔ 預測・盤中⛔ 比量,5 種注入全紅)
   + **`node scripts/test_ovdue.mjs`**(⏳ V78.1.6 精簡卡:四行 / 明日 4 條規則讀 `_LUNEXT_EDGE` / 長說明在摺疊 / 提示⛔ 紅框 / 390 單欄・768 兩欄 / `openWhen` 明天・下週一・今天;V78.1.4 總覽「時間到期」文案:超過上限寫「已超過 N 天」⛔ 不寫「到了」、尾盤窗口過了 / 週末寫「下一個交易日」(共用 `_dueWhen`)、收盤鎖漲停那一行讀 `_DT_EDGE.lu` + `_LUDEFER_EDGE`(決定性對照)、鎖漲停判斷只有 `_luLock` 一份;3 種注入全紅)
   + **`node scripts/test_ludefer.mjs`**(🟥 V78.1.4 回測 `LUDEFER=1`:抱滿 MAXD 那天鎖漲停 → 隔天開盤賣;定義 = `dt_daily_probe.lockUp`、進 CACHE_KEY、不設時一字不變、被延的每一筆用獨立 oracle 驗;真跑引擎約 4 分)
   + **`python3 scripts/test_peband_carry.py`**(📐 V78.1.2 `pe_band_miner` 這一輪抓不到 / 沒輪到的⛔ 不可從檔案消失 —— 沿用上一輪那一筆、歷史太短才拿掉;決定性對照「不讀上一輪」= 舊版會紅;V78.1.3 ⑦~⑪ 輪動補齊(沒舊值先抓、舊 d 由舊到新)/ 連續 40 檔 402/403 收工 / 部分成功且不縮就寫檔)
   + **`python3 scripts/test_screener_mcap.py`**(🎣 V78.0.0 screener 新欄 `mcap` 市值(億)= 收盤 × 集保總股數 ÷ 1e8,沒有總股數 → None、欄位排最後)
   + **`node scripts/test_fishhome.mjs`**(🏠 V77.9.9 散戶救星「🎣 魚池」:`fishHome_v1` / 匯入碼 → 自選群組 + 每列釣起價 / 賺賠(`_netPL`)、刪掉不回來、⛔ 不碰庫存、⛔ 不連股海釣手)
   + **`node scripts/test_stratswitch.mjs`**(🎯 V77.9.6 全站策略開關:預設 🧬、沒解鎖一律 🧬、連點版本號 5 次解鎖;🧬 時 App / 產業作戰室 / 更新紀錄 / 實測總表看不到 👑;👑 時總覽 / 決策台 / 提醒 / 背景提醒 / Telegram 只講領頭羊;⭐ 決定性對照:同一檔切回 🧬 回到三條出場;worker 名單 / 錨點 == App)
   + **`python3 scripts/test_lead_ghost.py`**(👑 V77.9.5 領頭羊快照:K 線跑到加權日曆前面(假日幽靈 K)時,當天 screener ⛔ 不當實跑存、改 K 線回補 bf:1;⭐ 決定性對照:拿掉守門就會被當實跑存)
   + **`python3 scripts/test_holiday_ghost.py`**(🎑 V77.9.2 假日幽靈 K:MIS 快照要看成交日期、匯出前整天刪「加權沒開盤且過半收盤同前一天」的日子;⭐ 決定性對照:加權漏一天但個股真交易 ⛔ 不刪)
   + **`python3 scripts/test_kline_repair.py`**(🧱 V77.7.0 陷阱 #46:日 K 還原價整段換回官方價 + yfinance 跳動單位守門;⭐ 決定性對照:逐列挑的舊寫法會留下假跳空)
   + **`python3 scripts/test_otc_hist.py`**(🏪 長歷史指數「沿用舊檔」⛔ 不可靜默 —— V77.4.5 新增,陷阱 #22;⭐ 它**跨檔比對** `data_audit.py` 的「有交代的降級」白名單,確保寫出來的原因真的報得出來,⛔ 不抄第二份)
   + **`python3 scripts/test_industry_gate.py`**(🏭 產業對照表 / 股名離線表 / 公司縣市 ⛔ 不可再被「TWSE 基本面回空」一起擋掉 —— V76.4.0 新增,陷阱 #44;順便釘住上櫃的門牌(`mopsfin_t187ap03_O`)與 FinMind 備援。⭐ 它用 **AST** 問「這個呼叫被哪些 if 包著」,⛔ 不是 grep 縮排)
   + **`python3 scripts/test_key_header.py`**(🔐 Gemini 金鑰⛔ 不可放網址參數,一律 `x-goog-api-key` 標頭 —— V77.5.5 新增;⭐ 自己逐行掃,⛔ 不依賴 guardrails 掃描器(它會跳過 index.html))
   + **`python3 scripts/test_no_token_leak.py`**(🔐 金鑰片段不可印進公開的 Actions log — V74.0.5 新增,見下方)
     ⭐ 它有 `--selftest`;實測 43 支只報 **1 筆而且是真的**(`miner.py` 寫 `datetime.now(TW)`,
     而 `TW` **從來沒定義過** —— 那條 `or` 分支目前沒被走到,是顆未爆彈,一走到就被
     `except Exception as _e_mh` 吞成 `margin_error`)。⛔ 誤報率高的版本已丟棄(第一版 345 筆全是閉包誤判)。
3. `python3 scripts/check_dom_ids.py`(DOM id 唯一性 — V71.0.7 起取代已失效的 check_prompt_vars.py)
   + **`node scripts/check_dup_key.mjs`**(同一個物件字面量裡重複定義同名鍵 → 後面那個贏、前面整段變死碼 — V74.7.4 新增,實跑踩到才寫的)
   + **`python3 scripts/test_deploy_relay.py`**(🛟 daily_miner 部署窗口的「撿回」守門 — 2026-09-10 新增,見下方陷阱 #41;⑥ V79.5.5 部署 job 時間預算:訊號掃描自己限時 + job 時限夠;⑦ V79.6.0 瀏覽器在並行那步背景先裝、掃描那步裝好就不重裝 —— 實跑 yaml 兩段 bash(平常 / 背景失敗 / 檔案不在 / 沒紀錄 + pipefail),決定性對照:拿掉背景安裝 → 掃描又自己裝、拿掉 wait → 印不出「已先裝好」)
   + **`node scripts/test_dupnum.mjs`**(🔢 同一畫面⛔ 不可有兩個數字 / 文案⛔ 不可跟實測打架 —— V77.1.4 新增:今日漲跌幅唯一來源 ・行事曆⛔ 不給部位指令 ・前綴撞名 ・產業別⛔ 不印代碼 ・全市場統計要標日期 ・clamp 夾到要說出來。⭐ 6 種注入全部叫得出來)
   + **`node scripts/test_exitdist.mjs`**(🚪 距出場線多遠 / 今天會不會碰到 / 智慧單觸發價 —— V77.4.9 新增;三條線讀既有函式、ATR 用今天、觸發價 `_floorTick`、有要盯的就⛔ 不可寫「沒有」;5 種注入全紅)
   + **`node scripts/test_beargate.mjs`**(🐻 V77.6.5 新預設的守門:App `_bear60Of` 跟回測 `notBear60` **逐日一致** ・最長天數三份實作一致 ・唐奇安 40 日 App == `auto_trade.py`(會動真錢)・決策台空頭只擋買進 + 決定性對照 ・一次性搬家只動舊預設 `don`;4 種注入全紅)
   + **`node scripts/test_pbexit.mjs`**(🧮 回測 EXIT 解析守門 —— V77.4.9 新增:裸字 `don` 要正規化成 `don20`、認不得一律 exit 1、`WARMUP` ⛔ 不進 CACHE_KEY、唐奇安回看不可取負索引;4 種注入全紅)
   + **`node scripts/test_ovslim.mjs`**(🧹 總覽只留最強策略 —— V77.5.2 新增:看得到的地方⛔ 沒有舊朱家泓劇本字眼 ・三條出場 = `_exitDistance` ・跌破 5 日線⛔ 不翻出場 + 決定性對照(硬停損被破必須翻)・盯價⛔ 沒有 5 日線/前高 ・舊卡照算不顯示的產生者還活著 ・基本頁 0 個關著的 details、⛔ 沒有體質分/投資屬性/市場預期)
   + **`node scripts/test_dtprune.mjs`**(🗑️ 當沖頁刪掉的 11 塊 ⛔ 不可復活 + 當沖頁 0 個主動推播 + 第一眼順序 🚦 → 成本關卡 → 當沖實測 —— V77.5.1 新增;注入「順序對調」「dtScanCard 復活」都紅)
   + **`node scripts/test_dtedge.mjs`**(⚡ 當沖實測摺疊 —— V77.5.0 新增:數字只讀 `_DT_EDGE` ・🟥 收盤鎖漲停那一行只在「沒開盤 + 真的鎖住 + 目前這一檔」出現 ・「每一格都是負的」跟著資料;4 種注入全紅)
   + **`node scripts/test_skills.mjs`**(🧩 Skill/代理定義守門 — 2026-09-09 新增:frontmatter 合法 ・ **Skill 裡提到的腳本檔名要真的存在** ・ 兩支 description 不可太像 ・ 有寫「⛔ 這支不做什麼」。⭐ 那些檔**沒有任何程式會引用**,壞掉時零錯誤訊息 = 陷阱 #37 最極端的形式)
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
| 19 | **切股時只清「一部分」卡片** → 載入失敗的卡會原封不動留著**上一檔**的內容 | 最危險的一種:畫面上完全沒有錯誤訊息,使用者會拿別檔的判讀去做決定。實例(V71.7.6,使用者截圖):標題是「大成鋼 43.10 −1.37%」,下面的分時圖卻是另一檔**漲停**的股票(100→102.8、+9.30%),連盤中六脈都跟著算成「多方共振 6多/0空」。根因兩層:① `analyze()` 切股時**只清 2 個 AI 結果框**,其他 async 才填的卡都沒清;② `loadIntradayKline` 有**四條**失敗路徑(沒金鑰/無回應/額度用盡/當日無資料)都是直接 `return` 而不清畫面 | ⛔ 三條一起做才算修好:**(a) 清空要早於載入**(切股當下就清,不是等資料回來);**(b) 每一條 early return 都要清畫面 + 指名是哪一檔**(「⚠️ 大成鋼 的盤中資料抓不到」);**(c) await 回來要檢查 `currentSymbolId` 還是不是原來那檔**,不是就別畫。個股頁新增任何「async 才填的卡」,一律加進 `analyze()` 的切股清空清單。測試 `test_switchclean.mjs` 8 條把三層都釘住。🚨 **V77.2.0 第四種形式**:`_chipEdgeState(sym)` **收了 `sym` 參數卻從頭到尾沒用過**(資料一律讀 `this.rawDailyData`)→ 拿別檔代號問它,回的是當前這一檔的籌碼。⭐⭐ 它是 `test_ovdigest ⑥b` **長期紅燈**在報的事,而我差點又把它當成過期斷言 —— ⛔ **永遠紅的測試等於沒有測試**,看到長期紅燈要先確認它報的是不是真的。⭐ 巡邏法:grep 「收了 `sym` 參數但函式體裡沒有 `sym`」的函式。|
| 22 | **守門把值設成 None 卻不寫原因** → 前端只顯「沒有資料」,而且從 JSON 也查不出是「抓不到」還是「抓到但被擋掉」 | 實例(V71.8.0,使用者回報反攻雷達「價差翻正」長期沒資料):`macro_risk.json` 的 `taifex_backwardation` 是 None、`taifex_backwardation_error` **也是 None** → 零線索。真因是兩層:① V71.4.9 加的「期貨與現貨必須同一交易日」守門,只有 **yfinance** 那條腿會設 `_LAST_TX_FUT_DATE`,而 **OpenAPI 才是主要來源** → 主線根本沒被守到 ② 差一天算出的離譜值被下游「離譜值守門」默默設成 None 而不留原因 | ⛔ **任何把值設成 None 的守門,都必須同時寫 `*_error`**;⭐ 而且要把**判斷用的原始數字一起輸出**(這裡是 `taifex_near`/`taiex_close` 與各自日期)—— 沒有那兩個數字,永遠查不出是差一天還是抓不到。同理:**加守門時要檢查所有來源分支都有設判斷所需的欄位**,別只補主要那條以外的。測試 `scripts/test_basis_legs.py` |
| 34 | **守門把值設成 None,但「斷崖防護(last-good)」又把昨天的舊值填回去** | 兩個防呆機制打架,結果是**顯示了不該相信的數字**(比空白更危險),而且 JSON 裡會出現「`x_error` 說不算、`x` 卻有值」的自相矛盾。實例(V72.1.2,資料體檢抓到):`taifex_backwardation = -156.0` 配 `taifex_backwardation_error = '期貨(08-03)與現貨(08-04)不同交易日,不計價差'` → 前端拿到的是**昨天的價差配今天的日期**。⚠️ 順逆價差是**當日快照**(昨天 +50 今天可能 −200),沿用昨天在語意上就是錯的(同陷阱 #16);而 `fetch_taifex_backwardation` 自己的註解本來就寫「不硬給一個看起來合理的假數字」—— 斷崖防護等於推翻了那個明確意圖 | ⭐ **區分兩件事**:「**今天暫時抓不到**」可以沿用(匯率/金價那種變化慢的)、「**守門刻意判定不可信**」⛔ 不可沿用。`macro_miner._NO_CARRY_ON_ERROR` 清單 + 斷崖防護迴圈開頭 `if key in _NO_CARRY_ON_ERROR and out.get(f"{key}_error"): continue`。⚠️ **那行必須排在「沿用」之前**,排後面等於沒接上(測試有釘順序)。⚠️ 新增任何「有守門會把值設成 None」的**當日快照**欄位,記得加進清單。測試 `scripts/test_basis_legs.py` ⑦ |
| 25 | **指數(^TWII/^TWO)沿用個股版面** → 對它顯示「買進/停損/掛單價」 | 使用者截圖:加權指數頁寫「這檔在盤整,先等它表態」「帶量突破前高 45,323 → 買進」「跌破前低 → 這檔不做」「🛑 停損防守」。⚠️ **指數不能買**,那些價位使用者根本下不了單,看了只會誤導;而且指數也沒有 EPS/本益比/營收,「基本」整頁對它是空的 | `_isIndexSym()` + `_renderIndexCommand()`(V71.8.2):指數走專用卡「🏛️ 現在什麼位置」—— 一年位階/年線/月線季線/量能/波動率/外資,⛔ **刻意不給任何買賣價位**,並白話寫「指數不能直接買,要跟大盤就買 0050/006208」。**指數只留「總覽 + K線」兩個分頁**(V71.8.4):藏掉 進場・出場 頁籤與 基本・當沖・回測・即時・籌碼・多空。理由都是「永遠不會有資料」而不是「今天剛好沒有」——即時(報價商只給個股逐筆/五檔,指數也沒有掛單簿)、籌碼(法人買賣超是**逐檔**資料,指數沒有自己的一份;也沒有融資券/借券)、多空(28 條有 27 條要籌碼/基本面/價量 → 永遠「訊號不足 1/28」)。⭐ 大盤層級的三大法人本來就在「大盤」頁,不必再開空殼。換回個股自動復原。⚠️ **踩過的坑**:`switchOvTab` 尾端會整個重寫 `b.className` → 先 `classList.add('hidden')` 會被洗掉,hidden 必須寫進那個 className 字串裡。測試 `scripts/test_indexpage.mjs` |
| 31 | **靠「程式碼裡沒人參照這個 id」去猜哪些是空殼** | V71.8.8 想做「空殼卡自動收起」,用靜態掃描找出 26 個「沒有 JS 參照」的容器,其中 `directActionBox` / `ovBodyEntry` / `ovBodyExit` 被列入白名單 —— 實測才發現它們是**包住整段活內容的外殼**(進場明細、四關卡、位階溫度計、法人目標價全在裡面),掃下去會讓整段消失。靜態掃描看不到 `subContent${t}`、`'chipTabBtn-'+k` 這種**動態組出來的 id** | ⛔ 白名單一律**實測量字數**才敢列入(headless 載入後印 `innerText.replace(/\s/g,'').length`),不可用靜態參照數猜。掃描條件也不能只看「直接子層是否全 hidden」—— 外殼裡常還包一層沒 hidden 但本身空的 wrapper。⛔ 含 `canvas/img/input/button` 的容器不掃(圖表沒文字但不是空的);已有「誠實空狀態文字」的卡也不列入(那是有用的說明,而且非同步才填,掃太早會誤藏)。測試 `scripts/test_emptyshell.mjs` 把「白名單不可含活外殼」釘死 |
| 32 | **卡片放錯頁籤 → 使用者找不到,以為沒做** | 使用者連兩次問「找不到上方套牢區」。功能做好了、測試也綠,但它被放在**總覽→出場**頁籤裡 —— 而「我現在買還有多少賺頭」是**進場**才會問的事。功能存在 ≠ 使用者找得到 | 依「使用者在什麼情境會問這個問題」決定放哪頁:上檔空間→進場、防守價→出場。⭐ 拆開後在留下的那張加**一行指路**(「上檔空間在『進場』頁籤」)。⚠️ 新增卡片時務必確認它在 `data-ovpane="xxx"` 的 div **裡面** —— 放在兩個 pane 中間會變成「不管切哪頁都顯示」(V71.8.8 第一版就插在 entry 收尾之後,測試用 `closest('[data-ovpane]')` 才抓到) |
| 30 | **「壓力」只用前高、而且只看現價附近** → 暴跌後那格永遠是空的 | 使用者問「分析師說國巨壓力在 800,這是籌碼還是 K 線看的?」→ 是 **K 線+成交量的套牢賣壓**,跟籌碼無關。但我這邊看不到,兩個限制:① `_chuResistanceZones` 只收 **+15% 以內**的前高 —— 國巨從 1,220 殺到 502,最近前高在 **+46%**,全被濾掉 ② 量價密集區只挑**單一最大格**,而國巨最大那格是暴漲前的底部(250~325,在現價**下方**)→ 上方四層量堆積完全沒被提到 | ① 前高上限 15% → **60%**(暴跌後最需要知道上面套牢在哪)② 新增 `_overheadSupply(data,last,pC)`:近 120 日成交量分布,取現價**上方**、單格 ≥2% 的桶,相鄰併層,由近到遠最多 3 層,每層標「佔總量幾%」。併進 `_upsideRoom` 統一排序。實測國巨 502 → 613~705(9.3%)、**773~865(9.7%)**、957~980(2.5%),中間那層正是分析師講的 800。⭐ 通用:**壓力要有「量」的證據,不能只有「價」** —— 前高是一個點,套牢區是一整片。測試 `scripts/test_overhead.mjs`(用真的 gh-pages 2327 資料)。⭐⭐ **V76.0.6 補**:那道牆後來回測過了(`overhead_probe.mjs`,2,259 檔・含 2022 空頭・11.9 萬筆)—— **量的證據能預測「穿不穿得過」(79.0 → 73.3 → 47.6%,單調),⛔ 不能預測「賺不賺得到」**(邊際 −0.19pp < 成本 0.44%,六關 0 過、門檻 5 格 0 過)。⛔ 所以它跟 `_trappedRatio` 一樣**只准描述**,別寫成「彈到這就跑」 |
| 29 | **指數的 `volume` 是 0,但 `amount` 每根都有** | `data/^TWII.json` 486 根裡**最近 44 根 volume=0**(資料源不給指數成交量)→ 量柱空白、量能判斷失效、六脈「量能」那條算不出來。但 V71.6.5 併進來的 `amount`(證交所官方集中市場成交值,元)**486 根全有**,一直沒被前端用到 | `applyLatestPrice` 對指數把 **整條序列** 的 `volume` 換成 `amount`,並標 `_volIsAmount`。⚠️ 照陷阱 #17:**必須整條一次換完**,只補缺的那 44 根會造成「張數 vs 元」的雙峰分布;⛔ 而且顯示端的單位與名稱要一起換(「成交金額(兆)」),否則 1.1 兆 ÷1000 會顯示成「1149185.3K張」。個股維持張數,兩邊不混。測試 `scripts/test_idxvol.mjs`(用真的 gh-pages 資料當測資) |
| 27 | **占比/百分比沒有「最少樣本」守門** → 1÷1 = 100% 的假信心 | 使用者截圖:加權指數多空頁「多方 1 項・1 分 / 0 項 空方 → **多方優勢 100%**」,而同畫面總覽寫「高檔回檔中」、六脈寫「訊號不足」→ 三個結論打架。28 條規則只命中 1 條就下結論,那個 100% 完全沒有意義。⚠️ **不只影響指數** —— 任何籌碼/基本面資料不齊的冷門股都會踩到 | `_calcBullBearScan` 加 `HITS_MIN=4`:命中數不足就回 `verdict='訊號不足'` + `lowSample:true`,顯示層改秀「命中 N/28」而**不是百分比**。⭐ 通用規則:**任何 `a/(a+b)` 型的占比,都要先問「a+b 夠不夠大」**;不夠就誠實說樣本不足,別給方向(同「寧可不給方向」原則)。測試 `scripts/test_lowsample.mjs` —— ⚠️ 測試要呼叫**真的**函式,別在測試裡複製一份判定邏輯(那會變成第二份真相,程式改了測試還是綠的) |
| 28 | **「資料源本來就沒有」被當成「條件沒過」** | 加權指數的資料源不給成交量、也沒有券商分點 → 六脈的「量能」「籌碼」兩條被算成失分,分母又寫死 5 → **還沒開始比就先扣兩分**,永遠不可能達標。同理任何缺資料的個股 | 缺資料的條件標 `na:true`(既有機制,量能那條漏掉了),分母改用 `applicable`(真的算得出來的條件數),門檻用 `Math.max(3, N-1)` 之類跟著縮。⭐ 通用規則:**「沒有資料」與「條件不成立」是兩件事,不可混為一談**;顯示分母時也不可寫死(`${okN}/5` → `${okN}/${applicable}`) |
| 26 | **自我修復程式放在「它要修的那段程式」裡面** | V71.8.2 第一版把「文件被截斷就清快取重載」寫在主 script 裡 → 實測(砍掉檔案後 30%)發現:主 script 一旦被截斷,修復程式自己也不會執行,於是**永遠修不好**。這跟「壞掉的快取會被 SWR 永久固化」是同一類問題 | 自我修復一律放 **`<head>` 最前面的獨立 `<script>`**,只依賴「檔尾哨兵 `window.__pageComplete`」這個最小契約。⭐ 通用原則:**檢查者不可以跟被檢查者同生共死**。另外要**上鎖只修一次**(sessionStorage),否則「壞的 → reload → 還是壞的」會變成無限重整。測試 `scripts/test_selfheal.mjs` 16 條(含「連主程式都死掉時仍要修得起來」) |
| 24 | **「等資料源修好」等成無限期 → 那一格永遠空著** | 使用者連續回報兩次「台指 VIX 沒有資料」。前兩版我都只改**說明文字**(講原因、講進度),但格子還是空的、還是不計分 —— 對使用者來說沒有任何差別。⚠️ 教訓:**解釋 ≠ 修好**;上游要幾輪才通的東西,先問「我自己算得出替代品嗎?」 | V71.8.1:台指 VIX(選擇權隱含波動率)拿不到 → 改用 `_twRealizedVol()`(加權近 20 日**實現**波動率年化 + 近一年位階),零採礦、零 API,當場有數字且會計分。⛔ **名字必須不同**(不同公式不同名字):有 VIX 叫「台指 VIX 退燒」、沒有叫「台股波動率退燒」,並在說明裡寫清楚「一個看未來、一個看過去」;上游通了自動換回,不並存。門檻用**自己的歷史位階**不用寫死數字(同 V71.1.6 外資期貨的教訓)。測試 `scripts/test_twvol.mjs` |
| 23 | **API 對「不存在的路徑」回 HTTP 200 + 網頁,而不是 404** | 期交所 OpenAPI 實測如此 → 候選端點全試一輪,得到的是 5 個 `Expecting value: line 1 column 1`(= 拿到 HTML 去 parse JSON),看起來像「全部失敗」但其實是**名字猜錯**。更糟的是連 `swagger.json` 也回網頁 → 原本設計來「讓官方自己說答案」的端點列舉函式也一起失效,於是一輪一輪猜、永遠猜不到 | `_taifex_list_endpoints` 改成:JSON parse 失敗時**從 HTML 用 regex 撈 `/v1/<Name>`**;⭐ 並且把撈到的清單**寫進回傳的錯誤字串**(會存進 `macro_risk.json`)—— 只印在 workflow log 沒用,log 要翻 job 又會過期,寫進 JSON 才能 `git show origin/gh-pages:...` 直接讀到 |
| 21 | **`auto_adjust=False`(原始價)+ 舊列不回溯調整 → 分割/減資當天永久斷崖** | 實例(2026-07-31,在回答「分析師買 0050」時做回測撈到):`data/0050.json` 有 2024/07/01 ×4.00、2025/06/11 ÷4.00 兩個跳空 → **中間整整一年的價位是別的尺標**,K線/均線/位階溫度計/回測全歪,而 0050 正是最多人看的 ETF。全市場掃出 **72 檔**同樣中招(0050・2327 國巨・4763 潤泰全・1808・8422・6919・00674R 等槓桿反向 ETF)。⚠️ `auto_adjust=False` 是**刻意**的(才對得上證交所官方收盤),⛔ 別改成 True 去「解決」它 —— 那會讓現價跟官方對不起來 | `_backadjust_splits()`(V71.7.9,在 `export_json` 寫檔前)。判斷依據是**物理不可能**:上市櫃單日 ±10% 漲跌停 → 相鄰交易日超過 `1.1^gap` 就不可能是真實漲跌 → 找最接近的整數倍(2~10 或其倒數),**殘差要落在漲跌停範圍內**才認定。⭐ 三個關鍵設計:① **只改舊的、最新價不動**(要等於官方收盤)② **倍率先累乘再一次四捨五入**(分兩輪各自 round 會把 46.61 變成 46.60)③ **冪等** —— `seed_db_from_json` 每次 run 都把 JSON 讀回 SQLite,不冪等就會越調越歪。⛔ 不動 `foreign_net`/`margin_balance`(那是當時真實張數,不是價格尺標)。測試 `scripts/test_backadjust.py` 20 條 |⚠️ **V74.9.4 補**:倍率表原本只有 `(2,3,4,5,10)` → **0052 富邦科技 2025-11-19 的 1:7 分割**(245.30 → 35.04,精確 ÷7、殘差 0.0%)修不掉。⭐⭐ 而 CLAUDE.md V74.4.5 把這類殘留歸因成「分割 + 停牌 > 5 天」——**那個歸因是錯的**,0052 的 gap 是 **1 天**。⭐ 是「先量再改」救回來的:全市場掃出的斷崖裡 gap > 120 天的那 **48 次全部是合併深歷史留下的資料洞**(2017 孤兒段 → 2023-06),⛔ 放寬 `gap > 5` 會把它們亂乘 = 製造新錯誤 → **那道守門必須留著**。→ 倍率補齊 **2~10**,全市場模擬:2,488 檔裡**只動 2 檔**(0052 / 7780),單日斷崖 13 → 11 次,其餘 2,486 檔一列未改。⚠️ 補倍率的**真實代價**:相鄰倍率間隙(6→7 是 16.7%、9→10 是 11.1%)小於漲跌停容許 ±10% → **比值 ≥5 的區域殘差門檻形同虛設**;可接受的理由是「單日比值 ≥5 物理上不可能是真漲跌」,而髒資料由測試 ⑦f 守住(**單日 ×N 隔天 ÷N 回來的,⛔ 不可污染前面的列**)。⚠️ 7780(2.97 → 21.90、×7.37)**量的方向跟反分割不符**(量反而暴增 4.7 倍)→ 那一檔的倍率可能不精確,但斷崖會讓回測算出單日 +637%,調整後至少歷史連續。⛔ **不加「量的方向」守門** —— 分割當天量常因市場關注暴增,方向不可靠。|
| 20 | **Service Worker 快取裡那份 `index.html` 也可能是「半截的」** | 症狀跟 #18 一模一樣(`SyntaxError: Unexpected EOF`),但**位置是文件本身**:`?source=pwa:1`。⚠️ 這裡的「第 1 行」不是線索不足 —— 部署產物是**壓縮過的單行 HTML**,所以「第 1 行」就是整份檔案,`Unexpected EOF` = script 讀到一半就沒了。iOS 對 PWA 有儲存空間上限,`cache.put()` 寫到一半被中止時存進去的是**不完整的 body,而且不會 reject**;`sw.js` 的導覽請求走 stale-while-revalidate → 每次都先吐快取 → **每次開 App 必爆,而且自己永遠好不了**。⛔ 別再往 `JSON.parse` 方向找(V71.6.9 已把 localStorage 那條全數修掉,錯誤照跳就代表不是那條) | `sw.js` 加 `_isWholePage(res)`:回傳快取**之前**先驗尾巴 512 bytes 有沒有 `</html>`,不完整就 `cache.delete()` 改走網路;寫入快取前也驗一次(免得把壞的存進去)。⚠️ **V77.5.5 更正:實際是整份 `arrayBuffer()` 再取尾巴**(~2.7MB/次導覽;原文寫「只讀尾巴」與程式不符)。⭐ 通用教訓:**任何「先吐快取再背景更新」的路徑都要有完整性檢查** —— 快取本身壞掉時,SWR 會把壞值永久固化。測試 `scripts/test_swcache.mjs` 8 條(含「網路也掛掉時不可吐白畫面」) |
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
| 40 | 🚨🚨 **測試環境跟正式環境不一樣 → 測試變成假綠燈**(一天之內踩到兩次,型態一模一樣) | 兩個實例:① **V74.3.1**:`git fetch --filter=blob:none` + `git archive` 在雲端拿不到 blob,**但我本機是完整 clone 所以永遠測得過** → chips_deep 還原一聲不吭回 0 天。② **V74.3.4**:板塊明細的成分股表在真實資料上 **32 個產業全部是空的**,而測試全綠、注入驗證也全過 —— 因為**測資自己把產業寫成代碼**(`'2382':'24'`),真實 `screener.json` 存的是中文名(`'2382':'半導體'`)→ **測資跟正式程式一起錯,兩邊「對得上」**。⚠️ 兩個都是「功能安靜地沒作用」,workflow / 測試全綠、零錯誤訊息 | ⛔ **測資的欄位格式必須跟真實產物一樣** —— 寫測資前先 `git show origin/gh-pages:data/x.json` 看一眼實際長相,⛔ 別憑印象編。⭐ 而且**跨檔案對照的功能**(A 檔的鍵去 B 檔查)一定要**用真實資料實跑一次**,測資對得上不代表真實資料對得上(V74.3.4 就是這樣抓到的:32 個產業逐一展開、數列數)。⭐ 同理任何跟 **git / 網路 / 檔案系統 / 瀏覽器環境**有關的事,「本機測得過」都不算數。 ⭐⭐ **同型第四例(2026-09-10):檢查工具本身沒有鑑別力** —— `node --check cloud-worker/worker.js` 對**插進 `export default {}` 物件字面量裡的 `const`** 照樣 rc=0 放行(`package.json` 沒有 `"type":"module"` → node 用 CJS 解析 `.js`)。⭐ 驗之前**複製成 `.mjs`** 才抓得到。⛔ 通用:**「檢查工具沒報錯」不等於「它有能力報錯」** —— 拿它當守門之前,先注入一個已知的壞東西問它一次(測試 `test_intraday_relay.py` ⑤b 就是這條)。⛔ 對不上時要**說出來**不可靜默空白(陷阱 #22)。 ⭐⭐ **同型第六例(2026-09-12,V76.1.6):我在寫下這條教訓的同一版又犯一次** —— V76.1.5 修妖股時,我是在**獨立模擬腳本**上量到「修正後 8 檔」的,那裡有完整的 `vols`;而**正式路徑** `_quick_ind` 只回 `vols[-3:]` → `len(rv) >= 8` 恆 False → **修完還是 0 檔**。⭐ 通用:**驗修法一定要走正式入口**(這裡是 `import miner` 直接呼叫 `_quick_ind`),⛔ 自己另寫一份等價邏輯去量 = 量的是那份等價邏輯,不是產品。 ⭐⭐ **同型第五例(2026-09-10,V75.2.8):拿本地 `data/` 量出來的比例,跟雲端完全相反** —— 修陷阱 #14 時我用本地那份(舊 clone)實測「只有 2.8% 的股票有當天盤中列」,於是把 `data_date` 改成**眾數**就收工。⛔ 但讀 daily_miner 實際部署的 `origin/data` 才發現:**382/400(95.5%)** 的最後一根就是那根未收盤的盤中列 → **眾數 = 最大值**,修法等於沒修,而測試(只驗「有沒有 `dateCnt`」)**照樣全綠**。⭐ 兩條通用:① **要量「正式環境會長什麼樣」就得去讀正式環境的產物**(`git show origin/data:...`),⛔ 本地 `data/` 只是某一輪的殘留;② **驗修法要驗「行為」不是「有沒有那個欄位」** —— 加一組**只換情境、同一批測資**的對照(㊀ 盤中 vs ㊁ 收盤後)並注入「拿掉守門」確認會紅(`test_todaysig.mjs` ㊀㊁㊂)。 |
| 42 | 🚨 **寫在 template literal 裡的 HTML 註解,只要有一個反引號就會把整個字串切斷** | `SyntaxError: Unexpected identifier 'xxx'`、`window.app` 整個不存在 → **全 App 白畫面**,而錯誤訊息指向一個看起來無關的識別字。⚠️ 這是**註解**造成的 bug —— 讀原始碼時眼睛會自動跳過那幾行。V76.0.6 第一次、V76.0.9 同一天**再踩兩次**(兩次都是在寫「這張卡為什麼下架」的說明)、**V76.1.3 第四次**(寫「這支函式為什麼被刪」的說明) | ⛔ 在 `<!-- ... -->` 註解裡**一個反引號都不要用**(要提函式名就直接寫 `_fooBar`,不加引號);⭐ 或把說明寫成 JS 的 `//` 註解放在 template literal **外面**。`node scripts/smoke_test.mjs` 一定抓得到(它是真載入),⛔ 別只 `node --check` |
| 41 | 🚨 **orphan force-push 會把「它開跑後才推上來的別人的東西」無聲吃掉** | `daily_miner` 的 deploy job 在**開頭**用 `git archive origin/data` 抓快照,跑 20~25 分鐘,最後 orphan force-push gh-pages 與 data → **中間那段窗口內別支推上去的產物全部消失**。實例(2026-09-09 實測):22:04:25 抓快照 → 22:22:57 `pe_band` push **成功**(log 有 `2c75e7a..312f8f0`)→ 22:28:46 force-push → 沒了,`pe_band.json` 因此停在 08-14 **一個月**。⛔ 最陰的是**零訊息**:兩支 workflow 全綠、兩邊 log 都寫「部署成功」,而兩個分支都是 orphan→ **git 歷史上完全看不出被吃掉**。⚠️ 全 repo 有 **20 支** workflow 會自己 push gh-pages/data,而 daily_miner 一天跑 2 次以上又可被 push 隨時觸發 → 窗口不固定,⛔「避開它」治不乾淨。⭐ 檔案裡本來就有兩塊逐檔補丁(`git checkout origin/main -- index.html sw.js` 註解寫「🛡️ 防 race」、`data/scr_edge.json` 註解寫「⚠️ 這裡是 orphan force-push,不接就每天被洗掉」)—— 病摸到過,只是沒通用化 | 部署**之前**加一步「🛟 撿回」:重新 `git fetch origin data`,把「**本輪沒產出、而遠端比較新**」的檔撿回工作區。⭐ 一個插入點治兩邊(gh-pages 是 orphan,內容全部來自工作區的 `data/`)。⛔ 判準用 **mtime**(`-nt /tmp/base.stamp`)⛔ 不用 `git diff BASE_SHA origin/data` —— deploy job 是 `--depth=1` shallow fetch,拿不到舊 commit 的物件,而且別支若改成 orphan 推 BASE_SHA 直接不可達(**陷阱 #40:本機完整 clone 永遠測得過**)。⚠️ `origin/data` 這個 remote-tracking ref 在 single-branch clone 下**不一定建得起來** → 要有 `FETCH_HEAD` 備援(本機實跑第一次就踩到)。🚨🚨 **第一版用 mtime 判準,上線後實測整個失效**(2026-09-10,**陷阱 #40 第三次**):`mine-data-*` artifact 的 path 是 **`data/`(整個目錄)**,而每個 batch job 開頭都會 `git archive origin/data | tar -x` 還原整個 `data/`;「🧹 修剪 artifact」只修剪**股票 K 線檔**,`pe_band.json` 這種非股票檔會原封不動跟著 artifact 回來 → `download-artifact` 疊上去,**mtime 變成下載時間** → 全部被誤判成「本輪自己產的」。實測 log 逐字:「**本輪自己產出 5521 檔 ・沒變動 0 檔 ・🛟 撿回別支的 0 檔**」—— `cmp` 那行**一次都沒被執行到**。⛔ 而且 K=0 時「窗口內沒人推東西」跟「判斷式失效」**長得一模一樣**,輸出看起來完全正常。🚨🚨 **同版還照出另一件完全不同、藏更久的事**:`live_quotes.json` / `live_index.json` 這種「**只在 gh-pages、不進 data 分支**」的檔,⛔ **不是「窗口內才有風險」—— 是每一輪 daily_miner 都會讓它消失**(gh-pages 是 orphan,內容全部來自工作區的 `data/`,而那來自 `git archive origin/data`)。⛔ 撿回那一步**救不了它**(它只比對 data 側)。實測 2026-09-09:live_snapshot log 逐字「✅ push 成功」4 次,隔天兩個分支都查不到。⭐ 修法是**照抄 `tick_flow` 早就有的「也推 data 分支」**(V69.8.4 P0-2 當初只接了一支 = 陷阱 #37),測試 `scripts/test_intraday_relay.py`。⭐ 判準改成**內容指紋三方比對**(鋪底層當下算一張 md5 表 → push 前:遠端跟基準不同 = 別支動過、本輪跟基準相同 = 本輪沒動 → 撿回;兩邊都動 → 本輪贏),**對「用同樣的舊內容覆蓋」免疫**。測試 `scripts/test_deploy_relay.py`:順序釘住 + **開真的 git repo 實跑 yaml 裡那段原始腳本**(⛔ 測試裡不複製一份邏輯),兩種 clone 形態各跑一次,而且**必須重現「artifact 用相同舊內容覆蓋整個 data/」那一格**—— 把判準退回 mtime,那條功能測試就會紅。⚠️ 測資補到 **121 檔**(撿回腳本有「基準 <100 檔不可信」的空過守門)—— ⛔ 不可反過來調鬆守門去遷就測試。三種注入(退回 mtime / 排到部署之後 / 拿掉「本輪贏」那關)都叫得出來 |
| 43 | 🚨🚨 **基準區間把「被判斷的那幾根」自己算進去** | 兩種後果,而且**都不會報錯、只會讓功能安靜地不作用**:**(a) 致命** —— `c > max(closes[-N:])` / `pC < min(lows[-20:])` 這種,今日自己就在視窗裡 → **數學上不可能成立**。實例:🐲 妖股雷達爆量基準含爆量那 3 根 → 全市場 2,719 檔通過 **0 檔**(V76.1.5);多空計分卡 P7「跌破 20 日低」→ 41.6 萬根實測**少抓 99.75%**,一條 weight=3 的**空方**規則整條是死碼;P5「爆量突破 60 日新高」少抓 **67%**(V76.1.6)。**(b) 不精確** —— 單根事件時實際門檻 = `m·(N−1)/(N−m)`:N=5 m=1.5 → **1.71×**(少抓 19%)、N=5 m=0.6 → 0.545×(少抓 19%)、N=20 m=2 → 2.11×(少抓 9%)。⭐ `m = 1.0` 時**完全無害**(代數上等價)。🚨 **變形:切片長度餵不飽基準視窗** —— V76.1.5 的妖股修法自己再踩一次:上游只回 `vols[-3:]`,而新基準要 `rv[-8:-3]` → `len(rv) >= 8` **恆 False** → 基準恆 0 → **修完還是 0 檔**;而且我是在**獨立模擬腳本**上量到「修完有 8 檔」的(那裡有完整 `vols`)= **陷阱 #40 第六例**。🚨 **另一個變形:基準的來源欄位本身全是 0** —— `bubble_warning` 的大盤 K 線量比讀指數 `volume`(陷阱 #29:資料源不給指數成交量,120 根全 0)→ `vol_ratio` 恆為 fallback **1.0** → 「爆量長上影」「上影警示」兩個等級**從上線就不可能觸發**,而且沒寫 `*_error`(陷阱 #22) | ⛔ **任何「爆量/放大/異常/創新高/跌破前低」的基準區間,不可包含被判斷的那幾根**:`sum(x[-N-k:-k])`、`slice(n-N-1, n-1)`、`max(closes[-21:-1])`。⭐ **`>=` 是合法的例外**(`v >= max(vols[-60:])` = 「今日就是天量」語意正確);位階/距高幾%/乖離/停損價/流動性門檻**含今日也是對的**,⛔ 別亂改。⭐ 前端一律先過 **`app._closedTail(data)`**(V76.1.6,砍掉今日那根未收盤的 K)—— 實測 **95.5% 的 `data/*.json` 最後一根就是今天那根**(V75.2.8)。🔍 巡邏 `python3 scripts/check_vol_baseline.py`(⛔ exit 0、**不進四驗證**;有 `--selftest` 6 條)—— ⚠️ 它**看不到藏在 helper / 預算好的陣列裡的基準**,所以每次實跑都會把那份**盲區清單印出來**(`backtest.py` 的 `_avg_volume_lots`、`index.html` 的 `ind.vma5` …)⛔ 不可把「0 筆」讀成「都沒問題」。測試 `scripts/test_lowsample.mjs` ⑦⑧(P5/P7 合成 K 走真的 `_calcBullBearScan`;注入退回舊切片會紅) |
| 44 | 🚨 **一個閘門底下掛了好幾個「不相干」的產物** | 上游一支 API 回空,**三個完全無關的產物一起不更新**,而且全綠、零錯誤訊息。實例(V76.3.9 從實跑 log 抓到):`miner.py` 的 `if twse_fund:` 底下掛了 產業 PE 聚合 / `industry_map.json` / `stock_names.json`(中文股名離線表)/ `company_geo.json` —— 而 2026-09-12、09-13、09-14 **連三輪** `⏭️ TWSE 基本面回空` → 後面那三個跟本益比毫無關係的產物整批沒更新。⚠️ 更諷刺的是**同一段程式碼的註解自己就寫著**「⛔ 獨立 try:它失敗 ⛔ 不可拖累 industry_map / company_geo」——**內層拆開了,外層那個閘門沒拆** | ⛔ 一個閘門只能管**真的需要它**的那一件事;其餘的搬出去無條件執行(空的時候仍然不覆蓋舊檔)。⭐ 巡邏方式:讀採礦 job log,看 `⏭️`/`❌` 之後**接著少印了哪幾行** —— 產物的 `updated` 停住而 workflow 全綠時,先往「它被誰的 if 擋住」找 |
| 45 | 🚨🚨 **回測的賣價用了「條件成立那一刻賣不到」的價** | 硬停損寫成 `if (收盤 <= 停損) 賣價 = 停損價` —— 用**收盤**才知道的事,卻用**盤中**的價成交;收盤跌破那天,收盤平均再低 **2.4%**(🧬 高波動股)。實測(V77.5.9,600 檔・49 個月・17 條路徑):唐奇安 20 日 **526 → 107 萬**(收盤賣,= `auto_trade.py` 的做法)/ **205 萬**(盤中碰到,= 複製智慧單)、ATR 追蹤 **566 → 206 / 17 萬**;同期 0050 約 264 萬 → 決策台「贏 0050」**是這個 bug 撐出來的**。而且全綠零訊息,本 repo **五處**同一寫法(`portfolio_backtest` / `lib_exitsim` / `crash_exit_probe` / `index.html` 兩處回測)| ⭐ **賣價必須是條件成立的當下真的賣得到的價**:收盤判斷 → 收盤價(`STOPFILL=close`);盤中觸價 → `min(開盤, 停損價)`(`STOPFILL=touch`,跳空開低要吃開盤價)。✅ **V77.6.0 起全站預設 = `close`**(使用者選「全站改算法重算」;`portfolio_backtest` / `lib_exitsim` / `breakout_exit_probe` / `crash_exit_probe` / `index.html` 兩處 App 內回測 / `pro.html` 漁獲結算)。`stop` 只留給**重現舊數字**,⛔ 不可再當預設。⛔ 實際下單**一行都沒改**(使用者選「維持現狀,只寫出差異」)→ 兩種賣法的差距寫在 `_STOPFILL_EDGE`(設定中心 + 決策台一行)。⭐ **新寫任何回測**:停損成交價一律照 `close`,換預設規則的判定也一律用收盤成交判。⭐ 通用:回測裡每一個 `exitP = X`,都要問「X 在那個條件被確認的時候還存在嗎」。測試 `scripts/test_stopfill.mjs` / `breakout_exit_probe --selftest` ⑨ |
| 46 | 🚨🚨 **日 K 混了兩種尺:「官方成交價」與「還原過除權息的價格」**(V77.6.9 第一次有 5 分 K 當真值才看到) | 正式產物 `origin/data` 的個股日 K,**上櫃 898 檔有 40.7% 的列**收盤價不在台股跳動單位格上(516 檔 ≥50% 的列;上市 5.1%、214 檔 ≥5%;逐年 2023 83k / 2024 127k / 2025 75k / 2026 只剩 4.5k)。用 5 分 K 13:30 那根當真值:**格外的列 98.4% 真的偏離 >0.5%,偏差中位 4.08%、P90 23%**;逐日看是整段連續、比值固定、在除權息日階梯狀跳一格(5483 2023-08~2024-01 一律 −10.20%、2024-01-25 起 −8.63%;3483 半年一律 −19.59%)= yfinance 那條腿填進來的**還原價**。後果:① 位階 / 均線 / 🧬 用的是被壓低 4~20% 的價;② 調整段接回官方段那天出現**假跳空**(熱門 442 檔有 58 檔 80 處接縫,接縫日 \|漲跌\| 中位 4.58%、35 處 ≥5%、17 處 ≥9.5% 像漲跌停,34 處集中在 2026-06);③ 任何拿日 K 跟盤中資料對照的東西(前收 / 跳空 / 今日漲跌幅)都會錯 —— F7 就這樣被灌了 56% 假事件。⛔ 陷阱 #17 的第三種形式(單位張 vs 元 → 半天 vs 整天 → **官方價 vs 還原價**) | ⭐ **判準一行:收盤價不在跳動單位格上就不是官方成交價**(<10 元 0.01 / 10~50 元 0.05 / 50~100 元 0.1 / 100~500 元 0.5 / 500~1000 元 1 / ≥1000 元 5;⚠️ ETF 另一套、興櫃沒有限制)。⛔ **探針要拿日 K 跟盤中資料對照時,前收 / 昨高一律用盤中資料自己算**(`dt_kbar5_probe.gapF7`)。✅ **V77.7.0 已修**(使用者「都做」):① `miner.yfinance_ohlcv_fallback` 收盤不在格上 ⛔ 不寫(`_on_tick`,跟 JS `_tickOf` 同一張階梯,`test_ticksize ①c` 跨語言比);② `miner._repair_from_deep`:匯出前拿 `klines_deep`(FinMind 原始價)**整段換**(兩列合法列之間整段換成「深歷史 × 倍數」,倍數 1 或 2~10 或其倒數 = 分割尺標差;兩端倍數不同 ⛔ 不動;籌碼欄一個都不動)。🚨 第一版**逐列挑**(不在格上才換 / 比值穩定才換)離線模擬**製造 3,900 個假跳空** —— 還原價是整段一起歪的,修也要整段一起修;改整段後上櫃格外列 29 萬 → 7,650、假跳空 667 → 24。`daily_miner` batch job 加一步解 `klines_deep` → `KLINES_DEEP_DIR`(拿不到照跑、印原因)。深歷史之後(2026-09 起)的列靠 ① 守門。③ 資料體檢 **F 類**(上市櫃個股 2023-05 起不在格上 ≥2% ⚠️、≥5% ❌)。測試 `scripts/test_kline_repair.py`(含決定性對照)。🔍 巡邏一行:`python3 -c` 掃 `origin/data` 收盤是否在格上(這次的 census 腳本在 DECISIONS V77.6.9 節) |
| 47 | 🚨🚨 **加權指數(^TWII)的「開盤價」是湊出來的** —— 09:00 只有一部分股票成交,還沒成交的股票用**昨收**算進指數 → 指數開盤價被系統性壓向昨收,「開→收」會把**跳空吃進去** | 拿 ^TWII 開→收去跟 0050(真的開盤價)開→收相減,會**憑空多出約 +1pp「超額」**,而且六關全過、p<0.001、Z×W 12 格高原全正 —— 完全像一個真的 alpha。實例(V77.7.7 `us_tw_lead_probe` 第一版):美股 ≥2σ 隔天「加權開盤買」T+0~T+20 全部 +0.9~+1.4pp、6/6;改用 0050 自己當資產之後 **0/35 過 BH、高原全負**。⭐ 美股大漲那晚台股當然跳空,跳空被算進「開→收」= 把買不到的那一段當成賺到的 | ⛔ **任何「開盤買」口徑的回測,資產一律用真的有開盤成交價的東西**(0050 / 個股),⛔ 不可用 ^TWII / ^TWOII 的開盤價;指數層級要講「隔天」只能用**收盤→收盤**(那是描述、不是可交易)。⭐ 探針 `--selftest` ⑪ 是決定性對照:同一批資料把 0050 的開盤改成「昨收」→ 憑空量到 +3(真開盤量到 0)。⭐ 通用:**看到六關全過、高原一片綠、p<0.001 的「開盤買」結果,先問資產的開盤價是不是真的成交價**。🚨 **第二例(V79.5.4)**:盤前體檢「高分日開盤後還多 0.594pp、6 年同向」也是 `premkt_probe.py` 拿 ^TWII 開盤價算的 → 改 0050 真開盤只剩 **0.09pp**(扣成本為負)= 盤前分數**只預測開盤**,⛔ 不可再寫成「開盤後也有用」 |
| 48 | 🚨 **假日 MIS 回「上一個交易日」的成交,被蓋上今天的日期**(V77.9.2) | 休市日(中秋 / 教師節 / 端午 / 颱風)全市場多一根收盤 = 前一天的假 K,「抱滿 N 天」/ 均線 / 動能 / 回測全部被推移;`seed_db_from_json` 每輪讀回 → **永遠留著**;而且看起來像「那天缺資料」(使用者就是這樣問的) | 快照一律比對 MIS 自帶的交易日期 `d`(`_mis_is_today`);匯出前 `_holiday_ghost_dates`(加權沒那天 + 過半收盤同前一天 + ≥20 檔 → 整天刪)。⛔ 不維護節日行事曆;⛔ 加權最新日之後不判。測試 `scripts/test_holiday_ghost.py` |
| 49 | 🚨🚨 **同一條判斷式兩邊不同尺(原始價 vs 還原除權息的調整價)** —— `leader_probe.mjs` 的趨勢過濾寫成「原始收盤 > 調整價算的 20 日線」(V77.8.5~V79.2.3) | 調整價 = 原始價 × 累積除權息倍數,倍數從資料起點一路累乘(2026 池子中位 **1.17**、82% 的股票 >1.10)→ 條件等於「收盤要比 20 日線高 17% 才算多頭」,而且**配息越多越被擋**;抽 10 個換倉日:錯尺只放行 **14.5%** 的池子、App 真正在跑的那條(screener `b20/b60`,原始 vs 原始)放行 **48%**,前 5 名 10 天裡 6 天不一樣 → **回測跑的不是 App 在跑的規則**,而 17 條全綠、安慰劑全輸,什麼都看不出來。⚠️ 修好之後中位只差 −9% / −4%(988 → 902、6,997 → 6,687),最差那條反而變好(438 → 603、2,618 → 3,524)—— ⛔ 「結論沒翻」不等於「沒事」:中間所有「加 X 比較好」的配對判定都是在錯的池子上做的 | ⭐ **任何同一個條件式裡出現兩個以上的價格序列,先問「它們是不是同一把尺」**(同陷阱 #17 單位、#46 官方價 vs 還原價);一律抽成**唯一一份**函式(`trendOk`),三個數字同一來源,其他探針 import 它(⛔ 不各抄一份,selftest ㊹ 釘住);selftest 要有「配過股利的股票 → 舊寫法擋掉、新寫法放行;沒股利 → 逐位相同」的決定性對照(㊶)。⭐ 修完一律**重跑全部引用那組成績的地方**(`_LEADER_EDGE` / `_PROFIT_BOARD` / `_YEARLY_BT` 👑 列 / LAB / `auto_trade.py` 註解),⛔ 不可只修程式留舊數字 |
| 50 | 🚨🚨 **事件窗口拉長了,對照組沒跟著拉長**(V79.4.1)—— `dispo_backtest.mjs` 的對照組寫死 `FROM='2023-06-01'`,我把事件拉到 2005 / 2010 起卻沒動它 → 2010~2022 的事件被拿去跟 2023 年以後的平均比 | 那幾年的「邊際」整段被墊高:注意股 16 年 **+1.28pp → 同一天對照 +0.05pp**、進處置 +2.62 → +1.07、「噴 ≥30% 進注意」+0.39(2010~2023 +1.65 vs 2023 起 −1.55「方向相反」)→ **−1.03(兩段都是負的、17 年 13 年負)**(含陷阱 #52 那一修)。⛔ 最陰的是**它還長得像一個有意義的發現**(「近三年才變弱」),我差點寫成結論、而且已經上了實測總表一個早上。對照組只印一次「平均 −1.95%」,看不出它是哪一段的 | ⭐ **事件研究的對照組一律「同一天」**:每一筆事件減掉**同一個進場日、同樣抱 N 天**的全部股票平均(同一天太少檔就不算,⛔ 不拿別天湊);⛔ 不用「整段對照組平均」(事件在各年份分布不均時就會錯配)。⭐ 拉長任何探針的窗口(`DATA_DIR` 指到 d16)之前,**先 grep 它的對照組是不是寫死期間**。selftest 要有決定性對照:兩段行情不同、事件只在前段、跟大家一模一樣 → 同一天對照 ≈ 0,整段平均 > +2pp(`dispo_backtest --selftest` ①)。⚠️ 對照組也要套**同一條**排除規則(鎖死 / 斷崖),⛔ 只剔事件不剔對照 = 兩邊不同規則 |
| 51 | 🚨 **換尺標只換了價格、沒換成交量 / 股數欄位**(V79.4.1 建 d16 時量到)—— `merge_deep_klines.mjs` 把 klines_deep 接到 data/ 前面時價格 ÷ 尺標比,成交量原封不動(2021-01~2023-05 那段) | 分割 / 面額變更 / 整數倍減資的股票(實測 29 檔:2327 國巨 ×4、2380、3086 ×10、0050…)那三年「價格是新尺標、成交量還是舊股數」→ **成交金額少算(或多算)好幾倍**;👑 用成交金額排池子、決策台成績單的量比與「買得到嗎」都吃它。⛔ 全綠零訊息,只有拿「外資買超 ÷ 成交量」逐年比才看出來(2327 那三年 0.50,其他年 0.10~0.21)。同類第二個:`_backadjust_splits` 只換價格與成交量、⛔ 不動法人買賣超與融資券(那是當時的張數)→ 事件之前那段「法人 ÷ 成交量」差 N 倍 | ⭐ **價格乘 k,成交量就要除 k(股數與價格反向);股數欄位要跟成交量同一個基準**(研究用的 d16 由 `merge_stock_deep.apply_share_scale` 用「收盤 ÷ 當天原始收盤」判斷尺標、連續 5 天且比例固定才算,標 `_sk`;⛔ 不改 data/)。selftest 一律要有「成交金額 = 原始成交金額」的決定性對照(`merge_deep_klines --selftest` ④、`merge_stock_deep --selftest` ⑩)。⭐ 量法:**拿一個比率逐年列出來看有沒有斷層**,比看單一數字有用 |
| 52 | 🚨 **規則在回測窗口中間改過:2015-06-01 起漲跌幅 ±7% → ±10%** —— 16 年回測寫死 9.7% / 1.095 的「開盤鎖死買不到」判斷,2010~2015 開盤鎖 +7% 的那幾筆被當成買得到(V79.4.2 實測)| 追高類訊號被灌水,而且**只在拉長窗口時才出現**:「噴 ≥30% 進注意」少了 36 筆就從 −0.56 變 −1.03pp、17 年負的年份 9 → 13;V79.4.1 那版的「幅度只有一半、可信度降一級」因此作廢。S2 要重跑的 25 支探針裡 12 支也寫死 ±10% | ⭐ 漲跌幅一律 `import { limitOf, lockedBar } from './lib_limit.mjs'`(⛔ 不在探針裡寫 9.7 / 1.095 / 1.1);selftest 放一筆「2012 年鎖 +7%」並注入「2015 前也當 ±10%」必紅。⭐ 通用:**把窗口拉長之前,先問「這段期間有沒有交易制度改過」**(漲跌幅、當沖稅率這一類;⛔ 憑印象寫日期,先查官方公告)|
| 53 | 🚨 **資料源把「那天沒有交易」整列省略,而不是給 0**(V79.4.3 實測:FinMind 個股法人 2012~2022)| 有資料的列裡「三大法人全 0」只有 1.0~1.8%(2023 起證交所 T86 是 14~18%)、沒資料那幾天的成交量中位 2.9 萬股 vs 有資料 35 萬 → 那些日子其實是「法人沒買賣」,卻被當成「不知道」:① 母體縮水而且偏向熱門股(外資連買那支 2,123 → 補完 2,307 檔)② 「連買 N 天」被缺口打斷 ③ 「同一天對照」那天的母體也跟著少。⛔ 全綠零訊息,只有逐年比「全 0 比例」才看得到斷層 | ⭐ 先量**逐年「有資料的列裡全 0 的比例」**(有斷層 = 來源省略零值);資料源**完整的那幾天**(當天 ≥60% 檔有列)缺的補 0 並標 `_i0:1`(`merge_inst_deep.fill_zero`),⛔ 不完整的日子(2012-01~04、週六補班)不補、⛔ 不覆蓋已有值;selftest ⑦ 決定性對照。⚠️ 用到這份資料的探針仍要把「不知道」跟「0」分開(⛔ 缺值不可當 0)|
| 54 | 🚨🚨 **輔助資料的起點晚於回測窗口** —— `data/dividends_hist.json` 從 **2021** 起,16 年回測(2011~)拿它當 `DIV_TRADES` → 2010~2020 個股**一毛股利都沒算**,對照組卻是「0050 含息」(`_div0050.json` 一路到 2010)(V79.4.6 補挖 div10 到齊才看到) | 16 年那一欄系統性低估、全綠零訊息:👑 16 年 7,047% → 只補股利 8,907%(+26%);「16 年輸 0050 含息」那幾句有一部分是這個缺口撐出來的。⚠️ 同一類兩個:d16 的 `0050.json` 只有 2021 起 1,399 天 → `PARK=idle` 沒設 `BENCH0050` 被守門擋下(17 條全失敗 —— ⭐ 守門救了一次);`yearly_bt` 沒設 `BENCH0050` / `DIV` → 2011~2020 的 0050 對照是 null(那一列跟誰比都不知道) | ⭐ **拉長窗口之前,每一份輔助資料都要印出「實際涵蓋的起訖日」**(股利、0050、指數、法人、融資)跟窗口比,⛔ 不可憑檔名猜;16 年一律 `DIV_TRADES=<d16>/_div16.json`(2010 起)+ `BENCH0050=<d16>/_bench0050.json` + `DIV=<d16>/_div0050.json`(跑法見 `docs/PROBES.md` V79.4.6)。⛔ 對照組含息、策略不含息 = 拿兩把尺比(陷阱 #49 的跨檔版) |
| 55 | 🚨🚨 **組合回測只抽 600 檔,成績很看「剛好抽到哪幾檔」**(V79.4.6 實測)—— `portfolio_backtest.mjs 600 2` 用「代號開頭輪流抽」從全市場抽 600 檔,而 App 的 🔥 是**掃全市場** | 同一天起點、同一套設定:舊資料賺 316 萬・回撤 −29%;把其中 41 檔換成早就下市的(= 新資料 d16 的抽樣)→ 189 萬・−47%(41 檔裡 5314 一檔就直接貢獻 63 萬)。每天只買 2 檔 × 15 萬 → 幾檔大贏家在不在名單裡就決定一大半成績;看起來像「新資料比較差」,⛔ 其實是抽樣換了一批。已排除:價格 / 成交量逐筆相同、股利檔逐位相同、每檔成績回看起點拉齊只差 22 萬 | ⭐ 換一份資料重跑之前,**先比兩份的 600 檔抽樣重疊多少**(`sample()` 照引擎的分層抽法算);重疊不到 100% 就⛔ 不可把差距歸給資料。⭐ 要對齊 App 就跑**全市場**(下一版引擎快取改 .ndjson + 分片);在那之前看板 🧬 列標 `old`(`embed_profit_board --keep-gene`)。⚠️ 以前的換預設判斷是同一份 600 檔裡的配對比較 → 方向比絕對金額可靠,但都要用全市場再驗一次。同版順手:引擎加 `STATS_WIN` / `STATS_FROM`(每檔成績只看最近 N 天;App 最多 1,200 根,`test_statswin`)|
| 56 | 🚨🚨 **回測引擎的選股規則跟 App 不一樣 —— App 改了規則,引擎沒跟**(V79.4.7 實測)—— App 的 🔥(`playbook_scan.mjs`)從 V72.9.2 起是「這檔這招 ≥8 次、照**保守下界**(平均 − 1.28×標準差/√n)排、一檔最多 2 招」;`portfolio_backtest.mjs` 一直是舊的「≥4 次、照平均排、每一招都算」→ 看板 / 決策台成績單 / 每週回測**測的不是 App 在用的那套**。抽 600 檔時看不太出來,全市場時兩邊差很大(同一條:舊規則 +155 萬 vs App 規則 +17 萬)。同版另一個:**全市場有 385 檔碰過價格斷崖**(5314 / 6949 1 拆 20 沒還原 → 回測當成 −92%),引擎沒有斷崖守門 → 假虧損 / 假大賺**還會污染每檔成績**,同一條光剔掉 0.25% 的候選就 +34 → +155 萬 | ⭐ 引擎 `GATE=lb`(預設值跨檔比對 playbook_scan,公式只在 `lib_lb.mjs`,`test_pbgate` ⓢ2 / ⓛ1)+ `CLIFF=20`(lib_cliff 同一組門檻,只剔窗口)。⛔ 改 App 的選股規則(playbook_scan 的門檻 / 排序 / 一檔幾招)時,**當場改引擎與 test_pbgate 的跨檔比對**;⛔ 看板、決策台成績單、每週回測都要用同一組(全市場 + GATE=lb + CLIFF + STATS_WIN=1200)。⭐ 通用:**回測「App 的策略」之前,先逐條比對 App 的選股程式與回測引擎**(門檻、排序、樣本數、一檔幾招、資料窗口),⛔ 不可假設「當初寫引擎時是一致的」 |
| 57 | 🚨🚨 **`page.evaluate` 的回呼在瀏覽器裡跑,看不到 Node 端的名字** —— V76.2.9(2026-09-14)把 `playbook_scan.mjs` 的 `tickOf` 從回呼裡搬到檔案最上面(為了給停損價用),算觸發價那段還在回呼裡 → `ReferenceError` → 被每檔的 `catch (_) { continue; }` 吞掉 | 凡是「有真的觸發價」的股票整檔消失:2026-09-14 ~ 10-20 明日作戰清單**每天 0 筆有觸發價**(只剩 4~17 筆「無價格閘門」),`auto_trade.py` 遇到沒有觸發價一律跳過 → 🔥 **五週沒有買過任何一檔**;決策台「今天可以買的」/ 盤中提醒 / 📒 成績單一起空掉。workflow 全綠、檔案照寫、`test_ticksize`(比對原始碼字串)全綠 —— 是讀 `pick_history.json` 逐日數「有觸發價幾筆」才看到 | ⭐ Node 端的值一律走 evaluate 的**第二個參數**,或在回呼裡自己定義(playbook_scan 改借 App 的 `_tickOf`,跟三份階梯同一份);每檔的 catch ⛔ 不可靜默:記數 + 前 5 則原文,超過 1% → exit 1、名單 ≥20 筆卻沒有一筆有觸發價 → exit 1(⛔ 壞名單不可蓋掉昨天的)。`scripts/check_eval_scope.py`(四驗證)+ `scripts/test_pbscan_run.mjs`(走正式入口真的跑)。⭐ 通用:**搬動一個 helper 之前,先 grep 它被誰用、那幾處跑在哪個環境**;⛔ 「字串比對測試全綠」不等於「那段程式跑得起來」 |
| 58 | 🚨🚨 **回測的「怎麼買」跟 App 不一樣**(V79.4.8)—— 引擎一直是「今天**所有觸發的**裡面挑最好的 2 檔」+「一筆出場之後才找同一招的下一次」;App(決策台「今天可以買的」/ `auto_trade.py`)是**前一晚排好名單、只看前 2 名**(名單先拿掉「明天漲 6% 內都觸發不了」的招與「今天已觸發」的)、**隔天尾盤到觸發價才買**,而且每天都看「今天有沒有觸發」 | 引擎永遠有東西可買 = 比實際樂觀:全市場同一套規則 16 年 —— 當天觸發的裡面挑最好(每天觸發都算)+319 萬、舊引擎一筆接一筆 +230 萬、**照 App 名單買 +117 萬**(4 年 +143 / +24 / **+60** 萬;0050 含息 +1,097 / +375 萬)。名單上會觸發的招有一半在舊快取裡找不到(持有中又觸發的那幾天不見了);🚨 名單判斷**只判每晚前 30 筆**時 16 年有 229 晚「名單可能不準」→ +98 萬,判到前 60 筆只剩 5 晚 → +117 萬(17 條全部不同) | ⭐ 照 App 買法三件一起:`ALLFIRE=1`(每天觸發都當候選,成績照舊一筆接一筆)+ `LISTK=2 LIST_DUMP` → `scripts/list_trig.mjs`(用 App 自己的 `_playbookPatternDefs` 合成明天那根 K,同 playbook_scan trigOf)→ `LIST_TRIG`(跑法見 `docs/PROBES.md` V79.4.8);⭐ **名單判斷要判到每晚前 60 筆**(App 規則 99% 的晚上在前 43 筆內湊滿 2 檔;summary 的 `listk.inexact` 要接近 0,⛔ 幾百晚就是判太淺)。`test_listtrig` 跟**真的 playbook_scan** 同一份資料逐筆比。⛔ 回測「App 的策略」之前,先逐條比對 App 的**選股規則**(陷阱 #56)**與買法**(名單怎麼排 / 哪些不列 / 什麼時候買 / 一天幾檔 / 同一招持有中又觸發算不算) |
| 59 | 🚨 **自動下單的「每天重新開始」重建整份狀態 → 新欄位被清掉**;同一版還查到「已經持有的股票再出現買點會重買一次,而且蓋掉原本的持倉紀錄」(V79.4.9) | 前者:V79.4.9 新加的 0050 停車股數 `park` 每天被清掉 → 第二天起程式以為自己沒買過 0050(真錢重複買、賣的時候又賣不到自己的);後者:部位變兩倍、停損線 / 買進日被新的覆蓋。回測引擎與 App 一直是「持有中跳過」,只有 auto_trade 不一樣,全綠零訊息 | ⭐ 每天重置一律只清當日欄位(`DAILY_KEYS` 白名單 + `reset_day`),⛔ 不可重建整份 dict;買進前先查 `st['pos']`,已持有就跳過(`hot_step`)。⭐ 會動真錢的流程一律抽成函式 + 假永豐測試(`test_auto_hot.py` / `test_auto_park.py`),⛔ 不可留在 main 迴圈裡(測不到)。🚨 同版檢查代理再抓到停 0050 的三個:**湊交割款被「帳戶總資金過期」那道判斷擋掉**(0050 停滿後一天買兩檔就會)、**買單送出就記成自己的**(颱風假 / 退單也算 → 之後賣到你手動買的)、**DRY_RUN 寫狀態檔**(之後真的跑以為做過了)→ ⭐ 會動錢的「一定要做」(湊交割款)排在所有「可以不做」的判斷**前面**;⛔ 送出 ≠ 成交,隔天對到券商庫存才算;預覽 ⛔ 寫任何狀態。查不到官方文件的券商欄位(交割款正負號)→ 真實帳戶先只預覽(`PARK_LIVE_OK`),拿使用者的 log + 券商 App 截圖對過才開。🚨 修完重讀又抓到:**整張 + 零股拆兩筆送,一筆出錯就當整筆失敗 → 下一輪把已送出的那段再送一次**(⭐ 送單函式要回報「已經送出幾股」,買只記那幾股、賣從紀錄扣掉);**模擬 / 真實共用狀態檔**(⭐ 分兩個檔;舊檔第一次用真實帳戶跑:沒標模式的一律當成模擬的搬走、⛔ 不自動賣・⛔ 不擋買 —— ⛔ 不拿券商庫存去猜(庫存夠也可能是手動買的);模擬第一次跑接著用舊檔的紀錄,⛔ 不可讓部位一夜之間不見)|

**修 bug 4 步驟流程**:
1. **重現**:使用者截圖 / console log / 確切操作步驟
2. **診斷**:加 console.log / 黃色 fixed toast / 強制 print 真實狀態(如 V24.9 救命)
3. **對症**:看診斷結果決定改 HTML / CSS / JS / 後端 — 不靠猜
4. **驗證**:四驗證 + 使用者實測一次

**Claude 主動巡邏**:每 5-10 次 push 後 Claude 自己跑一次:
- ⭐ **`node scripts/page_sweep.mjs`(V72.2.2 新增,最有效的一支,先跑這個)**
- 📐 **`node scripts/rwd_audit.mjs`(V76.2.4 擴掃 60 頁;V76.3.2 加「🧱 垂直空間」—— 誰吃掉幾 px 逐項列出,`RWD_ONLY=stock RWD_FONT=medium` 可只跑幾頁迭代)** + 🔠 **`node scripts/font_audit.mjs`(15 頁)** —— ⛔ 兩支都 exit 0、不進四驗證。🚧 它們各有「空過守門」與「shim 自我檢查」:看到 `🚨 版面 shim 有規則沒生效` 或 `掃到 0 個可見元素` 就代表**那一頁的乾淨不算數**,⛔ 不可讀成「沒問題」
- 🧮 **`python3 scripts/check_vol_baseline.py`(V76.1.6 新增)** —— 抓陷阱 #43「基準把被判斷的那幾根自己算進去」;⛔ exit 0、不進四驗證,每次實跑都會印**它自己的盲區清單**
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

⚠️ **V76.0.1 第三個「安靜地量錯」**:`folded` 對**關起來的 `<details>` 永遠算成 0** ——
Chromium 的 `innerText` 看不到它的內容,舊版用 `dt - sm` 相減自然恆為 0。
實測報告頁 9 節**全是 `<details>`**,那一欄卻報「摺疊 0」,看起來像「什麼都沒收起來」。
⭐ 修法:兩種摺疊**分開算** —— `<details>` 用 `innerHTML` 剝標籤量(⛔ 且不可從攤開字數再扣一次,
它本來就不在 `innerText` 裡);Tailwind `.hidden` 才要扣(沙箱載不到 CDN → 它有被算進去)。
🚨 **同版另一個**:`SUBTABS` 陣列**沒有 `'report'`** → 報告頁從 V75.1.1 上線到 V76.0.1
**一次都沒被巡邏過**(`page_sweep` / `card_inventory` / `swallow_hunt` 三支全中,陷阱 #37)。

📊 **實測 2330(V76.0.1 重量,⛔ 舊的 12,419 那份已過期)**:
合計 **11,360** 字(含報告頁;⛔ 舊版沒掃報告頁所以看起來比較少)。
最重四張:回測 `playbookCard` **1,154**(瘦身前 1,523)・當沖 `dayTradeBody` **1,018** ・
總覽 `ovCommandCenter` **972**(⛔ 這張是主結論,**不是**瘦身對象)・報告 `rpRisk` **560**。
⚠️ 舊文寫的 `chipVerdictCard` / `chuMergedCard` **早就不在前 20 名了** ——
⭐ 通用:**砍卡之前先重跑一次盤點**,⛔ 別照文件裡上一輪的清單去砍(那會砍一個已經不存在的問題)。

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

### 📋 鐵則(使用者明示 2026-08-31):**爾後每一次回測/探針,結論都要同步記進 `pro.html` 的 `PRO.LAB`(🔬 實測總表)**
- 分五欄:`ok` 實測有用 / `trap` 實測沒用 / `method` 回測自己的坑 / `blocked` 還測不了 / `next` 推薦下一步。
- 每一條都要附**實測數字 + 來源探針檔名**(測試 ㉔d 釘住「沒有數字的意見不准進來」)。
- ⚠️ CLAUDE.md 的決策紀錄與 LAB 是**同一件事的兩個讀者**(Claude vs 使用者)——
  寫完 CLAUDE.md 那節,**當場**補 LAB 那條,⛔ 別留到「下次順手」(陷阱 #37 的溫床)。
- ⭐⭐ **使用者追加(2026-08-31 第二則):驗證完成的條目要「當場歸類」** ——
  從 `next` 欄**移進** ok/trap/blocked,⛔ 不可留在推薦欄掛「✅已測完」
  (實例:處置股/時間停損/板塊內部挑法三條測完了還掛在推薦欄,被使用者抓到)。
  `next` 欄唯一合法的狀態是「還沒做」。
- 🗣️ **V77.7.9 白話層(使用者附件 overlay/build 的做法)**:✅ 每一條**必帶** `pl:['do'|'ref'|'avoid'|'long'|'old', 環節, 可信度1~3, 一句話, 對你的意思, 白話數字]`(`test_labplain` 釘住,新條目沒帶就紅);
  「old」的「對你的意思」要寫出被誰取代(⛔ 不寫編號 —— 名次會變)。其他欄不用寫,照標題「——」前半/後半自動推。⛔ 分組、可信度、環節一律中性色。
- 📌 **使用者追加(2026-10-04):「個股或日期、連假前後、結算等觸發專欄的條件就跳出來…爾後都記住,不要我想到才做」** —— ⛔ 寫專欄時**同一次**寫觸發條件 `col.trig:[條件 id]`(條件要在 index.html `_COL_TRIG_IDS` 裡、判斷寫在 `_colTrigEval` 並**呼叫既有函式**);真的沒有觸發日就寫 `trig:'none'` + `trigWhy`。寫完跑 `node scripts/embed_col_trig.mjs`(抄進散戶 App)。`test_column ⑰⑱` 釘住:沒寫 / 沒抄 → 紅。新條件 id 要在 `test_advunlock ③` 補一組「成立 vs 不成立」。 📰 V78.4.3 個股總覽也有一格 `#ovColBox`(`_renderOvCol`,⛔ 同一個 `col` 開關、同一支 `_colTrigEval`,正在看的那一檔用 `ctx.view` → scope「🔎 這一檔」;大盤/日子收摺疊)。
- 📰⭐ **V79.0.8 使用者:「有進專欄的就把原本刪除,實測總表也一樣,我不要重複訊息」** —— 有 `col.q` 的 ok / trap 條目,實測總表**畫面上不再重印**(搜尋只留一行「📰 看專欄」;⛔ `PRO.LAB` 資料不刪,匯出照舊);雜訊清單 `_NOISE_KEEP` / `_NOISE_GONE` 最後一欄填同一個結論的專欄主題鍵就不列。⭐ 可信度星星 = `pl[2]`,一律走 `PRO._stars` / `_starRank`(專欄與總表同一份順序)。測試 `test_prohtml ㊿` / `test_noise ⑧`。
- 📰 **使用者追加(2026-10-03):「爾後如果我有回測等等,有價值的資訊就直接幫我做成專欄」** —— 寫 LAB 條目時一併寫 `col:{s,q,do:[…],warn,how,range,u}`(V78.4.1 起 `range` = 📏 資料範圍,必填)(問答式,散戶看得懂、⛔ pp / 六關 / 安慰劑 / 探針名這類字);一句話 / 數字 / 對你的意思⛔ 不重抄,讀條目 `pl[3]/pl[5]/pl[4]`(迷思那欄沒有 pl 才自帶 `a/num/mean`)。產業作戰室「📰 專欄」分頁自動出現。`scripts/test_column.mjs ④`:`u ≥ 2026-10-03` 的有用條目沒有 col → 紅。
- 🔁 **使用者追加(2026-09-27):「每次回測完都要依照我的習慣排序方法紀錄,⛔ 不要每次都開新的卡片」** ——
  回測完**先找同一個主題的那一條改它**(用主題鍵 `k:` grep;沒有 k 的舊條目就用標題/探針名找),
  更新數字 + `u:`(最後更新日)+ 把被取代的舊數字收進那一條的「📜 歷次」段;**找不到才新增**,新增一律帶 `k` + `u`。
  排序照他的習慣:✅有用 依 `r` 排名(V74.4.4 那條)、其他欄 **`u` 新→舊**(剛更新的在最上面)。
  🏅 **V78.0.9 起 ⛔ 沒用也排名**(使用者:「排名全部重新排」):✅ 與 ⛔ 兩欄**每條必帶 `r`**(`test_labplain ⑫`);⛔ 沒用的 r = 江湖常見程度 × 實測錯得多嚴重(方向相反 > 扣成本後賠 > 打平),✅ 的 r 規則寫在 `LAB_TABS.ok` 說明。名次一律**渲染時照 r 算**(🧬 藏掉 👑 條目也連號,⛔ 不存死)。
  🧱 **V78.0.9 版面**:條目無框(一列一條 + 分隔線)、收起只留「名次 + 一句話 + 數字」、✅ 照分組、其他欄照主題 `LAB_TOPICS` 收合(⛔ 沒用多一組「🔝 前 10 名」攤開);頁籤分「結論 / 數字表」兩排、⏳ 還測不了 + 🔬 推薦下一步 同一頁(資料欄不動)。
  ⛔ 同一個 `k` 只能有一條(`scripts/test_labkey.mjs`,含決定性對照);同一欄兩條標題幾乎一樣也會紅。
  🏆 **V78.1.0 實測總表一進來是「🏆 選哪一套」**(使用者:「看不出最強策略能賺多少、有沒有比 0050 強,重新規劃介面」):三層 = 🏆 選哪一套(每一套 100 萬變多少 + 📏 0050 含息及格線 + 三種人怎麼選)/ 🔬 為什麼(有用・沒用・坑・還沒測)/ 📊 原始數字(回測數字・情境・機率・指標)。
  ⛔ 策略名字一律讀 `PRO.STRAT_NAMES`(🔥 高檔飆股 / 🅿️ 高檔飆股+停車 0050 / 🐢 唐奇安長抱 / 👑⚖️🪂🌇 領頭羊四種 / 📏 0050)——⛔ 不用版本號當名字、⛔ emoji 不重複;🧬 留給「這檔股票符合條件」的徽章。
  ⭐ 新做法要上排行榜:`portfolio_backtest EQUITY_OUT` 17 條,**WARMUP = 看板起點的索引**(📅 V79.6.2 起兩段都用 d16(含已下市):16 年 = 2011-01-03 起 → d16 的 251+3k、最近 4 年 = 2022-09-16 起 → d16 的 3125+3k;都算到看板的 `to`。⛔ 舊寫法「4 年 dd2 240+3k / 16 年 d10n 251+3k」是 V78.1.0 那一版的對照)→ `gene_board.mjs` → `embed_profit_board.mjs --gene`(0050 對不上看板 exit 1)。⛔ 不可拿 WARMUP 240~320 那 17 條直接放上去(起點不同)。
- ⭐ **同一則授權:「值得驗證及回測的,直接幫我驗證及回測」** —— 純回測/探針(只讀、不改 App 判定、
  不動 workflow)不用問,直接做;⛔ 但「要開始存新資料 / 改採礦」仍照原規則先問。
- 🔍 **漏收錄巡邏指令**:比對「`docs/PROBES.md` 探針登記表的檔名」與「LAB 條目的 `s:` 來源」——
  登記表有、LAB 沒引用的就是漏的(V74.4.3 一次抓出 11 支,補了 8 條)。
  ⭐ **V75.2.1 已寫成腳本**:`python3 scripts/check_lab_coverage.py`(⛔ 巡邏工具,exit 0、不進四驗證)。
  ⚠️ 比對用「探針名字的**字首**」不是完整檔名 —— LAB 有些條目一次涵蓋多支
  (來源欄寫成 `volstall/volseq/turnover/arbr/turnover_stage`),那是**合法的**收錄方式。
  📊 V75.2.1 實跑抓出 4 支真的漏收(`orb_probe` / `regime_probe` / `broker_habit_probe` / `trust_probe`),
  已補進 LAB;⭐ 那四支**本來就測過**,只是結論沒進到使用者看得到的那張表 = 等於白測。

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
| 板塊「偷布局」回測 | ✅ **V79.4.3 已用 16 年重跑**(`inst_deep` 2012 起個股法人) | ⭐ **結論:2012~2026(含 2015 / 2018 / 2022)+0.41pp・3/6 → 改列「沒用」**(舊的 809 天 +1.65pp 是 2020 起那幾年撐的;詳 DECISIONS V79.4.3)。以下是舊紀錄:🚨 **原本這一格寫「只能到 2026/05」—— 那是錯的**(同 V75.2.6 券資比那次,⭐ **同一句錯誤敘述在兩個不同欄位上各犯一次**)。2026-09-15 實跑:探針自己印出「外資資料實際範圍 **2023/05/22 ~ 2026/09/08(805 個交易日)**」,多檔抽驗(2330/2881/2882/2891/1101/3231/6415)**每一檔 `foreign_net` 都是 795~796 根全有**。⭐ 通用(第三次):**寫下「資料只回溯到 X」之前,先實跑印出真正的範圍** —— 憑印象寫的限制會讓一支能跑的探針被擱置好幾個月。⚠️ 但**窗口不含 2022 空頭**(`klines_deep` 有 2021 起的 K 線,但**只有 OHLCV、沒有 `foreign_net`**,已實查)→ 逐年那關只驗得到 2023~2026。 |
| 韓股 vs 日經 誰對台股更有預測力 | ✅ **已測(V74.7.0,Actions 實跑 5 年)** | 日經同期相關 0.665 / 韓股 0.648,**隔天只有 +0.047 / +0.062 ≈ 0** = 同步但不領先(LAB trap);S&P/那斯達克隔天 +0.469 / +0.487 是**時區**不是 alpha。🚨 原本這一格寫「❌ 不能、要等幾個月」是過時的 |
| 🇺🇸 美股隔夜異常 → 台股(個股 / 板塊 / 疊在 🧬 上)| ✅ **V77.7.8 已測(資料 `us_hist.yml` 每天自動更新)** | ⛔ 三層都量不到買得到的優勢(加權 0/35、板塊 1/98 負、個股名單重疊 0%);🚨 加權層⛔ 不可用 ^TWII 開盤價(陷阱 #47)。走完一次空頭後可重跑 |
| 🗣️ 盤中口訣「非分 K 不可」的三條(下午時段 / 開盤 10 分鐘站回 / 第一根 5 分 K 上影) | ✅ **V78.2.5 已測完**(`maxim_kbar5_probe.mjs` 用 `kbar5_deep` 5 年 5 分 K,三條都沒過;第一根上影 ≥50% 不追反而方向相反)→ ⛔ 別再當「等資料」 | (以下是 V77.0.3 當時的紀錄)🚨 以前卡住的不是程式是資料:**分 K 一根都沒有存下來** —— 三支會抓分 K 的程式(`orb_probe` / `intraday_probe` / `volseq_probe`)都是現抓 Shioaji、只寫結論 JSON;`live_quotes.json` 每 5 分覆蓋、`tick_flow.json` 每天覆蓋、`tick_hist.json` 每天每檔只留 4 個數。✅ **V77.0.3 起 `kbar5_miner.py` 收盤後跑一次**(掛 `daily_miner` 的 `workflow_run`,⛔ 不吃排程配額),抓當日量前 80 檔 1 分 K → agg 成 5 分 K → **獨立分支 `kbar5`** 的 `kbar5/{YYYY-MM}.json.gz`(每月一檔 + gzip,實測壓縮率 3.4x → 約 42KB/天、250 日 ~10.5MB;⛔ 不進 gh-pages → 連帶避開陷阱 #41)。⭐ **第一次跑就有約 80 個交易日**(kbars 回溯 81~120 天,⛔ 不是「等半年」),但「逐年同向」那一關要滿一年 → 約 **2027-02**。⚠️⚠️ **母體是「當日成交量前 80」**(使用者選的)→ 名單每天變 → ① 某檔在歷史上斷斷續續 ② **天生只收「當天夠熱」的日子 = 選樣偏誤**。→ 檔案存了**每日實際清單**(`d[date].syms`)+ `bias` 欄;**用它回測時一律先算「這檔在窗口內有幾天」**,⛔ 結論不可講得像全市場。⚠️ 而且那三條抓的幅度只有 0.3~0.5%,當沖來回成本就 0.25%(ORB 就是這樣死的)|
| **券資比 / 軋空**(V71.9.2 → **2026-09-09 重跑,結論不變但理由要更正**) | ✅ **資料已經夠了**(2023-05-22 起)・⏳ 2010 起的融資券補挖還在跑(`stock_deep_backfill`,還差約 866 檔) | ⏭️ 補齊後用 16 年資料重跑 `short_probe.py` 才走得到 2015 / 2018 / 2022 空頭。以下是舊紀錄:🚨 **原本這一格寫「只回溯到 2026/05/14、約 55 個交易日」—— 那是錯的**:2026-09-09 實測 `margin_balance`/`short_balance` 從 **2023-05-22** 就有(隨機 200 檔:2023 年 13,227 列 / 2024 年 23,185 / 2025 年 23,380 / 2026 年 14,159)。⭐ 重跑規模 **1,736 檔 ・對照組 895,349 股·日 ・事件 64,820 筆**(舊版 1,002 檔 / 9,893 筆),並修掉舊版兩個**前視偏誤**(自身百分位用了含未來的整檔排序;用當天收盤進場而融資券是收盤後才公布)→ 改 expanding 百分位 + **隔天開盤**進場 + 排除鎖漲停,補齊六關與格內對照。**結果:自身百分位最高 10% = +0.04pp(扣成本 −0.40)、門檻敏感度 P80→P99 = +0.09 / +0.08 / +0.04 / −0.01 / −0.22(越嚴越差且單調)、絕對門檻高原檢定 5 個相鄰區間 0 個站得住。** 🚨 **要更正 2026-08 的兩句**:①「方向跟軋空**相反** −1.65pp」→ 重跑是 **+0.43pp**,正確說法是「**不是反向,是零**」;②「券資比額外貢獻 **−1.95pp**、還扣分」→ 重跑是 **+0.38pp**,結論(⛔ 不為券資比開功能)不變但理由改成「**加不到成本**」。⚠️ 窗口 2024-05-30~2026-08-11 三年全多頭 → 空頭沒驗到;**但 2026-08 那 55 天窗口正好是空頭、結果也是負的** → 兩種盤都沒有東西 |

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
| **D3** | **macro_cache 對接**(V75.2.5):前端用**巢狀形狀**(`X.key.close` / `X.key.chg_pct`)讀的欄名,那份檔到底有沒有 | `es_fut`/`nq_fut`/`gold`/`usdjpy` 在 macro_cache 裡根本不存在 → 風險指數那四個因子**從來沒作用過**;`_renderUsFutNight` 的「🌙 美股期貨夜盤」**一直是「夜盤 --」**。⚠️ A/B/C/D/D2 五類**全部放過它們** |
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

### 🆕 V77.4.5 補強:C 類**自己誤報了很久**,而真因是「沒辦法被測」
`confcall.json` 每次都被報 ❌「`src` 有值但 `src_error` 說有問題」,但 `src_error = {'sii':None,'otc':None,'names':None}`
= **三格都空 = 根本沒事**。🚨 真因:`if k.endswith('_error') and v:` —— **非空 dict 恆為 truthy**。
⭐ 修法三道:① `_err_parts(v)`(dict/list 往下走**一層**,葉子全 falsy 視為沒錯;有值的子項**逐一報**
`src_error.sii = …`,⛔ 不整包丟掉 —— 那會放過 V72.3.2 的巢狀 error)② **矛盾偵測只對字串型 error 做**
(陷阱 #34 的實例全是字串;dict 型 error 講「哪條腿掛了」,值是其他腿湊的 → 有值⛔ 不算矛盾)
③ 抽成 module-level `c_findings(f, j)` + **`--selftest` 15 條**。
⭐⭐ **③ 才是根治**:整段以前長在要打 git 的 `audit()` 裡 → **無法用合成資料問它「你叫不叫得出來」**
= 這個偵測器從來沒被驗過。⛔ 以後新增 A~E 任一類的判定,先確認它**測得動**。
⭐ 同版 **D3 也照 D2 那條原則**(有 `*_error` → ⚠️、沒有 → ❌)降級。
🚨 **誠實紀錄**:注入「條件退回裸 `and v`」時測試**照樣全綠** —— 兩道修法任一道都足以壓掉誤報
→ 那條執行期斷言對「條件那一行」**沒有鑑別力**,另補靜態釘 ⑤s/⑤s2。⚠️ 靜態釘要
**只剝 COMMENT ⛔ 不剝 STRING**(剝了會把 `'_error'` 字面量吃掉 = 假紅燈),而且 token 用 `''` 接
→ 樣式要寫**無空白版**;⛔ 禁止的寫法**不可逐字出現在任何 docstring**(本 repo 第七次)。

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
| **macro_risk.json 新增/改欄位**(macro_miner.py) | ⚠️ **macro_miner 讀任何本機 `data/*.json`,早上的 macro_cron(乾淨 checkout)都讀不到** → 一律走「本機 → 已發佈那份」(`_load_prev_macro` / `_rh_from_local_or_published` / `_twii_rows`),⛔ 只讀本機 = 白天那幾輪默默退化(V79.5.2 日期守門 / V79.5.4 外資期貨基準 / V79.6.0 順逆價差三次都是這樣)。① 前端讀取卡(grep 欄名)② 首席 AI prompt 注入(`runUnifiedGroqAnalysis`)③ `_calcRiskScore` 風險指數 ④ `risk_history.json` 快照欄位 ⑤ 前端欄名跟後端**完全一致** |
| **後端改/加欄位名** | 前端 fallback 鏈要含新欄名(別只讀舊名);grep 雙向確認前後端同名(記取 `us_macro` 不存在、`published_time` 前端沒讀的 bug) |
| **新增 data/*.json 檔** | ① daily_miner deploy 底層 `git archive origin/data` 會保留(append 類檔靠這保命,如 risk_history)② 前端 fetch 用動態 `ghBase` + `?t=${Date.now()}` ③ 確認 daily_miner.yml push paths 是否需納入觸發 |
| **新計分因子**(獵鷹/主力出貨/多空) | ① 卡片「因子來源」說明文字同步 ② 首席 AI 若注入該訊號要更新 ③ 數值單位確認(億/張/口/%,記取 `fi_spot_net`=億) |
| **改燈號/verdict 文案** | 同一決策的多張卡(首席/綜合評分/系統燈號)語義要一致,別紅綠相反(V27.5 已統一改「寫字不靠色」) |
| **加新偵測器/型態**(朱家泓/林穎 K 棒) | 加進 `renderKbarTactics`(唯一活的一處;舊「三處清單」的 `renderKbarScore`/`runKlineAudit` 死碼已於 V69.8.8 P2-4 清除) |
| **顯示或計分用到任何美股/總經指標** | ⛔ 一律走 `app._macroPick(key)` / `app._macroChg(key)`(V75.2.4)。🚨 兩份檔**形狀不一樣**:`macro_risk` 扁平(`sox`/`sox_chg_pct`)、`macro_cache` 巢狀(`sox.close`/`sox.chg_pct`)→ 自己寫 `m.sox?.chg_pct` 就注定只讀到一份。**實測後果**:`es_fut`/`nq_fut`/`gold`/`usdjpy` 在 macro_cache 裡根本不存在 → 風險指數那四個因子**從來沒作用過**(而註解寫著「期貨夜盤優先」)。⚠️ 有些指標**只有漲跌%沒有價位**(gold)→ 判斷來源要「兩個欄位任一有值」。測試 `scripts/test_vixsrc.mjs` |
| **新增任何「量條 / 刻度尺 / 進度條」的顏色** | ⛔ 一律走 `app._gaugeRamp(kind, pct)` / `app._gaugeFill(kind, pct)`(V77.1.1,**全 App 唯一一份色階表 `_GAUGE_RAMP`**)—— 回的是 **CSS 字串**不是 Tailwind class(沙箱沒有 Tailwind,用 class 上的色在測試裡量不到 = 假綠燈,陷阱 #40)。🎨 **一律同色系明暗漸變(深 → 亮)**,⛔ **不可用綠→黃→紅跨色**(燈號鐵則也管刻度尺 —— 同一顆綠在 A 卡是「跌」、B 卡變成「安全」,使用者會看反)。⭐ canvas 海報用 `createLinearGradient` 吃**同一份** ramp,⛔ 不可在 `_RP_STYLE` 另寫一組 hex(V76.3.8 就是兩邊各寫一組才被看出「配色有差」)。⭐ 那一批**動態色**的比例條(`${theme.bar}` / `${lvl.bar}` / `${barC}` / `${col}`)⛔ 不逐一改 class —— 由 `<style>` 裡**一條 CSS**(`[class~="rounded-full"][class~="overflow-hidden"] > [class~="h-full"]` 疊一層透明黑→白)統一處理,**物理上就不可能變成跨色**。🚨 順手抓到的漏網:`_renderTriRateCard` 的股價位階尺一直是綠→灰→紅 —— **位階是「位置」卻用紅綠**,V74.8.8 稽核 29 處時漏掉。測試 `scripts/test_gauge2.mjs` ⓐ/ⓐ2/ⓖs |
| **新增任何「跟上一期比 / 一年前是多少」的顯示** | ⛔ 一律走 `app._ppTxt(now, prev, {unit,fmt})`(V77.1.3,全 App 一份)—— 比率類用 **pp**、金額類用 **%**,金額**跨越零**(去年賠今年賺)時⛔ 不給 %(那個百分比沒有意義)。🚦 **↑↓ 一律灰字,⛔ 不可用紅綠** —— 燈號鐵則:🔴🟢 只准講漲跌方向,而「ROE 上升」是**好**不是**漲**。⛔ 需要「近 4 季(TTM)往前挪」時一律走 `app._finTtmAt(F, back)`,⛔ 不在顯示端 inline 第二份公式 —— 它必須跟採礦端 `scripts/fin_slice.mjs` **完全一致**,測試 `test_fintrend` ⓑ 直接比對 `_finTtmAt(F,0)` 與 `F.roe4/fcf4/capex4`,公式一分叉當場紅。🚨 **斷言⛔ 不可用 `||` 串進「即使缺陷存在也會不同」的項目** —— 第一版把 `roe4` 也放進去,而它的 `eqL` 仍然吃 `back` → 注入「back 不生效」時整條被救活(假綠燈);只比**純窗口加總**的 `fcf4`/`capex4` 而且用 `&&` 才叫得出來。⚠️ 籌碼那幾格(`C.s5`/`C.s20`)是**彙總值沒有逐期序列** → 做不到就在卡底說出來(陷阱 #22),⛔ 不硬做。 |
| **任何跨越長天期的計算(季線/半年線/年線 ・ 位階 ・ 回測)** | ⛔ **先問「這一檔的歷史有沒有價格斷崖」**(V77.2.1,使用者問「很多個股都有分拆,你知道嗎」)。⭐ 實測 gh-pages **2,520 檔 → 41 次物理不可能的跳空 / 31 檔**,其中 **19 檔是興櫃**(⛔ 沒有 ±10% 漲跌幅限制 → 那是**真實行情**),真正要當心的是**上市櫃 12 檔**(`1538`/`3593`/`1808`/`2025`/`2603`/`3494`/`3710`/`6461`/`6885`/`6949`/`8059`/`8277`)。🚨 **⛔ 不可為了修它們去放寬 `miner._backadjust_splits` 的倍率表** —— 那支只還原**整數倍 2~10**(物理上不可能的才動),而這 12 檔多數是 **×1.63 / ×2.22 / ÷2.5 / ÷20** 這種**非整數比的減資**,還有長榮 2023/06/30 ×0.603 那種**除權息**;放寬會把**真實的除權與大跌亂乘** = 製造新錯誤(函式註解已明文禁止,同 V74.9.4「gap > 120 天那 48 次是資料洞」的教訓)。⭐ **正解是「讓使用者看得到」而不是猜**:`app._splitGapWarn(data, sym)` → 頂端 `⚠️ 歷史價格斷崖` 徽章 + 說明「那一天以前的均線/位階/回測是另一把尺」,⛔ **一個價格都不竄改**。⛔ 興櫃一律不判(會天天誤報)。測試 `scripts/test_dupnum.mjs` ⓧs~ⓧ7。⚠️ **決定性對照的「陽性那一半」要自己造得出來**(合成 K 線注入一次 ×2)—— 第一版拿 6696 真實資料當對照就紅了,而它報的是真的:**6696 根本沒有跳空**(807 根零斷崖,它是真的一年從 15.2 漲到 200)。|
| **顯示或計分用到「今天漲跌幾 %」/「昨收」** | ⛔ 前收一律**優先用報價商給的** `_fuglePrevClose`(官方參考價,除權息當天會自動調整),拿不到才退回 `data[n-1].close`,而且要把**來源**(`chgSrc`)與**前收**(`prevC`)一起帶出去 —— 只給結果的話,下次對不上時**查不出是哪一邊算的**。🚨 V77.1.4 實例(6894):頂端 **−3.16%**、報告頁海報 **−4.2%**,真因是 `applyLatestPrice` 把**即時價寫進最後一根**但**前收沒跟著換** → 兩條路、兩個前收。⚠️ 我們的 K 線 09/14 收 368.00、報價商前收 364.00 差 4 元,而 `dividends.json` / `dividends_hist.json` **都沒有 6894**→ ⛔ 沒查清之前**不片面宣稱誰對**,但**顯示端一律以報價商為準**(它至少跟券商 App 一致)。⚠️ 順帶:實測 **95.5%** 的 `data/*.json` 最後一根是**未收盤的盤中列**(6894 那根 15 張,而全日 34 張)→ 講「收盤」之前先過 `app._closedTail(data)`。測試 `scripts/test_dupnum.mjs` ⓐs~ⓐ2c(⭐ 決定性對照:把 `_fuglePrevClose` 改成 999,兩邊要一起變;🚨 `renderReportTab` 是 **async**,沒 `await` 的話注入根本沒生效) |
| **顯示或計分用到「月營收 / 年增 / 累計年增」** | ⛔ 一律走 `app._revYoY(fy, fc, fen)`,而它的**第一順位是 `this._revLive`**(V77.1.7)—— 基本頁用**使用者自己的金鑰即時抓** FinMind 的那一份。🚨 實例(5483 中美晶):基本頁畫著「26/08 營收 **67.17 億** ・年增 **+11.7%**」,報告頁同時印「最新月營收 **—**・年增 **+7.6%**・累計年增 **—**」→ 真因是**兩條腿**,報告頁只讀採礦快取(`fund_yoy_gm[5483]` 根本沒有 `mrev`/`ytd`/`mrh`)。⛔ 報告頁**不可自己再打一次 API**(那要吃使用者額度)→ 讀基本頁存下來的 `_revLive`。⚠️ **累計年增要自己算**(採礦那份沒有):今年 1 月~最新月 vs 去年同一段,**月份不齊就不給**(⛔ 不硬算)。🔁 報告頁常常先畫好才等到資料 → 要補畫一次(同 V76.0.2 `_rpNeedsDec`),而且**一檔只補一次**(⛔ 不然會跟渲染互相觸發)。測試 `scripts/test_dupnum.mjs` ⓞ~ⓞ4 |
| **同一張卡/同一張圖出現兩個名字很像的數字** | ⛔ 判準⛔ 不只是「同名不同值」,**一個名字是另一個的前綴也算**(V77.1.4)——「自由現金流」與「自由現金流近4季」不是同一個字串,但使用者讀起來就是「兩個自由現金流,值還不一樣」。⭐ 規則:**前綴相關而值不同 → 紅**;值相同不算(趨勢「毛利率 37.1%」vs 格子「毛利率(2026-06 季) 37.1%」是同一件事的兩種寫法),任一邊是「—」也不比。🚨 實例三件:① 毛利率 **35.8(上一季)** vs **37.1(最新季)**,兩邊都沒標季別→ 抽 `app._gmLatest(C)` 當唯一那份(財報切片優先、採礦快取備援,**一定帶季別**);② 自由現金流 近4季 1.2 億 vs **單季** 0.4 億(標籤沒寫「單季」= V77.1.3 自己造成的);③ 🚨 **顯示點永遠比你以為的多一個** —— 以為只有 4 個,第 5 個是 `_reportFacts`(**餵給外部 AI 的提示詞**),跟「產業別印代碼 35」同一個型態(陷阱 #37 的第二個出口)。⚠️ canvas 要驗這一類,**趨勢那幾條也要進 `_rpOwnDbg.labels`** —— 只收 `cells()` 的話那一類永遠抓不到。測試 `scripts/test_dupnum.mjs` ⓒs~ⓒ2d / ⓓs~ⓓ2c |
| **新增任何「兩個同類型比值」(風報比 / 賺賠比 / 佔比)** | ⛔ **先問「它們是不是同一把尺」** —— 本 repo 實測同一個個股頁有**兩個風報比**:`_upsideRoom.rr`(第一道技術壓力 vs 出場總表停損,**扣**費稅,寫成 `1:X`)與主卡 `rr`(目標價 vs 5日線/月線/前低,**不扣**費稅,寫成 `X:1`)→ 同一檔同時出現「1:1.8」與「3.2:1」,連比例都反過來(使用者講最多次的「同名不同義」)。⛔ **不可統一成同一支** —— 主卡那個有 `if (rr < 1) warn = …`,它**會驅動顯示給使用者的操作指令**,動它 = 碰訊號邏輯;而且 `_upsideStash` 比主卡晚算出來,主卡讀不到。✅ 正解是**兩邊各自把口徑寫進括號**(「到第一道壓力 vs 出場總表停損」/「到目標價 vs ○○線」)+ 主動寫一句「⛔ 兩個不可互相比較」。⭐⭐ **任何比值都要把「分母怎麼來的」印出來**:風報比一定同時印「**停損距現價幾 %**」—— 停損只距現價 1% 時比值天生就漂亮(12 倍那種),那不是上檔空間大;<2% 時要額外跳一句講清楚。測試 `scripts/test_upside.mjs` ⑨/⑨b/⑨c |
| **在 canvas(海報 / 圖)上畫 emoji 或符號欄** | ⛔ **不可用 `textAlign:'right'` + 預設 alphabetic 基線**(V77.1.1)—— 那跟 V77.0.9 修 HTML 那次是**同一個病**:22px 的 emoji 跟 26px 的數字共用同一條基線、而 emoji(≈1.275em)與 CJK(1.0em)的 advance 不同 → 五列高低左右都不一致(使用者:「大盤右手邊那個三角型驚嘆號沒有對齊」)。⭐ 一律**畫在「它對齊的那個東西」的垂直中心 + 固定寬格子的水平中心**(`textBaseline='middle'` + `align='center'` + 固定 `BADGE_W`)。⚠️ 改過的 `textBaseline` **一定要復原**,否則後面每一行字都會跑掉。🚨 **沙箱沒有彩色 emoji 字型**(六個符號量到同一個寬度)→ 這類問題**重現不了** → 修法要做成「不依賴 glyph 度量」的結構修法,測試只釘幾何(⛔ 不斷言 glyph 寬度 = 永遠會過的假綠燈)。測試 `scripts/test_gauge2.mjs` ⓑ/ⓑ2/ⓑs2 |
| **給任何數字格「上色說它是好是壞」** | ⛔ **門檻只能用本站已經上線中的判準,⛔ 一個都不可新編**(V77.1.1,陷阱 #38)。實例(📈 個股數據速覽):年增/累計年增 → `_xrayScoreOf` 的 30/10/0;ROE近4季 / 淨利率 / 自由現金流 → `_lossCapOf` 的「< 0 就是在虧錢」;融資追繳壓力區 → `_marginCallState` 的 `level`。⭐⭐ **沒有實測過門檻的格子(月營收 / 毛利率 / 存貨天數 / 千張大戶 / 散戶)一律不上色,並在卡底明講為什麼**(陷阱 #22:不講原因 = 沒講)——「看起來沒事」跟「我們不知道」⛔ 不可長得一樣。⚠️ 千張大戶/散戶⛔ **不可上成「好」**(`tdcc_probe` 實測「兩上兩下」第 1 名只是打平大盤)。⚠️ **好壞用 ✅⚠️⛔ + 琥珀三階**;法人買賣超是**方向**才用台股紅買綠賣,⛔ 不配 ✅⚠️⛔(燈號鐵則)。測試 `scripts/test_gauge2.mjs` ⓒ/ⓒ2 |
| **新增「一節一節的報告 / 分類清單」的標題** | ⛔ 標題分色一律走 `app._rpSecTone(n)` / `app._rpCardHex(title)`(V77.1.1,**全 App 唯一一份 `_RP_SECTONE`**;「📖 完整報告」的 §N 與 canvas 海報的節標題共用)。⛔ **不可用紅綠** —— 這裡的顏色講的是「**這一節在講哪一類事**」不是「好還是壞」,用紅綠會讓使用者把「風險節」讀成「跟跌有關」(燈號鐵則)。⭐ 一定要在卡底附**一行圖例**(⛔ 不可讓使用者自己猜顏色代表什麼);⚠️ 舊格式(沒有 §N)的內容維持原樣,⛔ 不硬分色。測試 `scripts/test_gauge2.mjs` ⓕ/ⓕ2/ⓕ3 |
| **任何會 clamp(夾上下限)的分數 / 量表** | ⛔ **夾到的時候一定要說出來**(V77.1.0)。實例:盤前體檢 `sPct = clamp(0..100, 50 + s×5)` —— 量表只吃得下 `s ∈ [−10,+10]`,而 s 實際走得到 **±20** → 實測 2026-09-15 是 **s=−14.5 → 原始 −22.5 → 顯示 0**,於是「剛好到底」跟「比極度偏空還要再空一倍」**在畫面上長得一模一樣**,而使用者只會問「0 分對嘛」。⭐ 三件一起做:① **把原始分(沒夾過的)一起存下來**(`_preOpenCalc.raw` / `.clamped`)② 夾到時在畫面上明寫「今天已經超出量表,算出來是 X 分」③ **逐項明細**(每個因子扣幾分 + 當時的值)—— ⛔ 顯示端只讀存下來的,一個數字都不重算。⚠️ 逐項改走共用的 `_add(名稱, 分數, 值)` 之後要**兩條測試分開釘**:靜態釘「⛔ 不可再有裸的 `s +=` 繞過 helper」、執行期釘「逐項加總 == 實際分數」—— 只留後者的話,「`_add` 整個被拿掉」時 s 跟明細**一起少**、加總仍然相等,叫不出來。測試 `scripts/test_deckfit.mjs` ⓒs/ⓒ2/ⓒ4。🚨 **V77.1.4 補:這條當時只接了盤前體檢一處**(陷阱 #37)—— 五維儀表列的**技術**那格也是 clamp 的(`Math.max(2, Math.min(98, 50 + sc*6))`,`sc ≥ 8` 一律顯示 98,而其他四格是百分比不會被夾),使用者截圖問「98 分?」才發現。→ `_lastTechScore` 存 `raw`/`clamped` → dims → `_gaugeStripHtml` 那一列寫「(已到量表上限,原始分 ○○)」。⛔ **公式一個字都不可改**(改門檻 = 偷改判定)。測試 `scripts/test_dupnum.mjs` ⓕs~ⓕ2c |
| **新增任何「會過濾決策台候選」的開關** | 🗑️ V78.1.9 第一個實例「📦 只挑營收年增加速的」已移除(少賺且贏不了隨機)。⛔ 新增前先跟同通過率隨機抽比;五條(V77.4.3):① **取捨型一律預設關** —— 判準是**總獲利最大**(V75.0.9 第 5 條),賺更少就算回撤更小也⛔ 不換預設 ② ⛔ **不可靜默過濾**(V74.8.8):擋掉誰、各自的數字一律寫在畫面上;被擋光時要走**專屬空狀態**(「都被你開的濾網擋掉了」+ 一鍵關掉),⛔ 不可跟「今天沒有」長得一樣,而且那時候⛔ 不可同時顯示「✅ 今天不用做」 ③ ⭐⭐ **`null` 是「不知道」⛔ 不是「沒過」** —— 那一列照留 + 掛標記(⚠️ 這跟回測端 `finOk` 對 null 回 `false` **刻意相反**:回測要乾淨的統計母體,畫面是給人看的名單) ④ 🚨 **先量全市場有幾 % 會亮**並印在畫面上(V77.1.6;50.6% = 篩子不是警示),數字讀常數 ⛔ 不寫字面值 —— ⚠️ 沒有彙總產物可讀時照 `_FIN_STRUCT_BASE` 用**內嵌常數 + 實測日期 + 分母 + 來源腳本**(V77.0.9 那條「讀產物」的前提是有產物) ⑤ 判定公式若是採礦端 lib 的**前端複製品**(`index.html` 不能 import `.mjs`),一律寫**跨檔比對測試**(`test_finfilter ⑦` 把函式體抽出來用 `new Function` 跑、把 `Date` 影子掉逐日比);⚠️ **測資要有季節性** —— 固定成長的測資會讓「k−4 vs k−1」算出同一個布林值 = 注入叫不出來。測試 `scripts/test_deckfin.mjs` |
| **新增任何「全市場候選清單」到決策台** | ⛔ **先答得出「它跟既有那張清單問的是不是同一個問題」**(V77.1.0)。實例:決策台本來只有 `playbook_edge` 的「🎯 今天可以買的」(=「**這一檔自己**最會賺的那一招今天觸發價多少」),而「📈 符合進場」是**另一個問題**(=「🧬 + 今天出現期望值為正的看多訊號」在哪幾檔亮)→ 兩者**並列但必須寫明差別**,⛔ 混在一起就是使用者最討厭的「邏輯不打架」的反面。⭐ 四條:① 門檻讀 `_EDGE_RULES.gene`、黑名單讀 `_ovBlockWhy`(⛔ 不另寫一份)② 前端算不出 `_bearGate`(那要個股 K 線)→ 一律叫「**候選**」並寫「點進去個股頁會再擋一次」③ 🚨 **每一列都要扣來回成本**(成本讀 `playbook_edge.cost`,⛔ 不寫死)—— 實測今天那一檔期望值只有 0.08%,扣 0.44% 之後是 −0.36%,**列出來卻不講 = 讓人以為可以買**;全部為負時再加一行總結 ④ 有候選時「今天不用做」那一格**必須關掉**(⛔ 同頁不可一邊列股票一邊說沒事)。測試 `scripts/test_deckfit.mjs` ⓓ/ⓔ |
| **任何「全市場有幾檔 / 佔比多少」的統計數字** | ⛔ **一律讀採礦產物,不可寫死**(V77.0.9)。實例:總覽「觀望」那句寫死「全市場 2,326 檔裡…只有約 200 檔」,而當天產物是 `scanned 2,320 / no_edge 1,315`(→ 有招的約 1,005 檔)—— **兩個數字都過期了**,而且它是用來說服使用者「不是你這檔特別差」的,講錯就失去說服力。⭐ 走 `app._ovRarityNote()`:讀 `playbook_edge.json`(`scanned`/`picks_syms`)與 `today_signals.json`(`bull_syms`),**載不到就回空字串**(呼叫端退回原本那句),⛔ 不可編一組數字(陷阱 #22)。⚠️ **第一眼有字數上限**(`test_gauge` ⑨/㉚/㉟ 釘 ≤600,實測基準 694)→ 新增的句子要先量,⛔ 不可為了塞新東西把第一眼撐大(我第一版撐到 798,壓回 693 才進)。⭐ 而且光說「這是常態」沒有可操作性 → 一定要**指路**到全市場的榜(選股頁「🎯 今日訊號」/ 決策台)。測試 `scripts/test_ovrarity.mjs` |
| **在 canvas 上畫「每一列都要對齊的符號」** | ⛔ **不要用 emoji**(V77.1.5,使用者講第二次才根治)。🚨 實測 `measureText` 把 `🔴🟢➖✅⚠️⛔` **六個量成完全一樣**(advance 27.45、墨水框 28×27),**但畫出來明顯不一樣**(系統 emoji fallback 的 glyph 跟第一順位字型的度量不是同一套)——⭐⭐ **量得到的跟看得到的不是同一件事** → 靠 `actualBoundingBox` / advance / 固定寬格子去「置中」emoji **全部是假修法**(V77.1.1 的固定寬格子就沒有解決)。⭐ 真修法 = **改印兩個 CJK 字**(偏多/偏空/持平 ・安全/注意/危險 ・偏強/普通/偏弱):CJK 兩字 advance 必然相同(2em),天生對齊,而且**測試量得到**(釘「四格字寬完全相同」;⚠️ emoji 版在沙箱也會通過那條 → 要**同時**釘「⛔ 不可是 emoji」)。⛔ HTML 那格不動(`_gaugeRow` 的 flex 置中格沒有這個問題);⭐ 門檻走共用的 `app._gaugeBadge(kind, pct)`(58/42 ・60/45 全 App 一份,回 `{sym, word, tone}`)。測試 `scripts/test_dupnum.mjs` ⓖ~ⓖ4 / `scripts/test_gauge2.mjs` ⓑs3 |
| **新增任何「分組排名 / 板塊榜」** | ⛔ **先問「這個榜有沒有回測過」,⛔ 不可把別的榜的實測數字借過來用**(V77.1.7)。🗓️ **V77.2.0 追加:天期也是「別的榜」** —— `_ROT_EDGE` 的 +1.44pp 是拿**官方產業 × 20 日**測的,板塊輪動加了 1/3/5 日選單之後,非 20 日的那幾頁**整句換掉**(明寫「這個天期沒有回測過」並拿掉「避開最弱」那個可操作結論)。⏳ 而且 **3 日那一欄採礦本來沒有** → 補進 `screener_miner.py` 的 `chg3`,採到之前那顆鈕 disabled + 「待採礦」,⛔ 不拿 1 日或 5 日湊一個 3 日出來(陷阱 #22)。測試 `test_rottab` ⑨。實例:板塊輪動新增「🎯 概念股」分頁時,旁邊那張官方產業榜有 `sector_rotation_probe` 的「前3強−後3弱 **+1.44pp**、含 2022 空頭」背書,而**題材名單是本站自己框的、從來沒有回測過** → 題材頁一律寫「**沒有回測過**・那條數字是拿官方產業測的,**⛔ 不可以套到題材上**」。⛔⛔ **而且⛔ 不可換一份資料來源去排名次**:`sector_rot.json` 的 `themes[].r20` 是**採礦端另一條公式**(每日中位數再滾動加總),跟 `_regimeStats()` 的「成員 `chg20` 中位數」**不是同一個數字** → 兩張表並排就會出現「同一族兩個漲跌幅」。⭐ 正解是讓 `_regimeStats()` **多算一份**(`tmed`),用**完全一樣**的算法只換分組。⚠️ 分組成員數差很多時(題材實測 3~35 檔)要有**樣本守門**:`< 5 檔`標「⏳ 樣本少」並**排除在最強/最弱那句之外**(陷阱 #27);一檔可同時屬多組時要寫「加起來會超過總檔數」。測試 `scripts/test_dupnum.mjs` ⓡ~ⓡ8 |
| **把一張卡從「自動展開」改成「預設折疊」** | ⭐ **折疊 ≠ 藏起來**(V77.1.7,使用者明示要折疊 §12・§13・§18・§19)。三件事缺一不可:① **summary 仍要寫出「有沒有事」**(「⚠️ N 則預警 ・出貨徵兆 x/8」)而且 tone 照舊(有事 = 琥珀標題)② **按鈕留在摺疊外面**(複製提示詞 / 開 Perplexity / 選圖存起來 —— 收起來還是要按得到)③ **既有測試如果釘的是「會自動展開」,要改釘新的用意**(⛔ 不是放寬成「有字就算過」)。🚨 **量的時候注意**:關著的 `<details>` 讀不到 `innerText` → 要驗裡面的東西得先 `open = true`(⛔ 別把「讀不到」當成「內容不見了」)。📉 實測報告頁第一眼 **2,575 → 750 字**。 |
| **新增任何「異常 / 分歧 / 罕見」的旗標** | ⛔ **先量全市場有幾 % 會亮,再決定它是不是警示**(V77.1.6,陷阱 #36 的變形)。實例:「近 4 季淨利↑但自由現金流↓」門檻 ±5% 時**全市場 2,212 檔切片有 736 檔(33%)會亮** —— 那不是旗標是背景雜訊;逐級實測 ±5% 37.9% ・±10% 31.1% ・±20% **22.6%** ・±30% 15.7% ・±50% **8.0%**(自由現金流本來就逐年跳動,再嚴都不罕見)。⭐ **兩件事一起做**:① 門檻照**既有旗標的規格**訂(EPS 崩 ≥50% / 股本變 >20% → 這個用 ±20%),⛔ 不是為了湊命中率挑數字 ② 畫面上**一定要印出全市場基準率**(`_FIN_STRUCT_BASE`,帶實測日期 + 分母),而且命中率高到這種程度就⛔ **不可做成 ⚠️ 警示** —— 23% 的股票都會亮的燈,看久了會養成忽略的習慣。⭐ 判準用**稅後淨利** ⛔ 不用 EPS(面額變更會讓 EPS ÷4,V76.2.0);**跨越零⛔ 不給**(去年賠今年賺算出來的 % 沒有意義,同 `_ppTxt`)。測試 `scripts/test_dupnum.mjs` ⓛ~ⓛ5 |
| **「去重 / 精簡」的收益要量對地方** | ⛔ **不可拿「攤開總字數」當 KPI**(V77.1.6:去重之後攤開反而 24,680 → 25,396,因為同一版也新增了東西)—— 去重的收益在**第一眼 / 折疊狀態**(`rpRisk` **1,678 → 1,338**)。⭐ 做法一律是**摺疊不是刪除**:出貨徵兆「沒亮的那幾條」收進 `<details>`,⛔ 不可把它們的 `why`(實際張數/百分比)丟掉;⛔ 亮的那幾條一律攤開不打折(使用者鐵則:警示寧可多提醒)。⚠️ **去重⛔ 不可去掉唯一的那一份** —— 毛利率「趨勢在就不印上面那行」必須留一個 fallback 分支(沒有財報切片的股票畫不出趨勢),測試用 `data-rpgmcap` 釘住。⚠️ 判定「這個數字重複太多次」要**逐一讀過再砍**:`2413~2505` 出現 7 次,但七處是七種不同的問法 → **不砍**(陷阱 #31)|
| **新增任何「跟上次比 / 跟上一版比」的顯示** | ⛔ 快照一律綁**資料日期**,⛔ 不綁「開啟時間」(V77.1.6)—— 綁時間的話同一天開第二次就被自己蓋掉,那一格**永遠是空的** = 功能安靜地沒作用。⭐ 第一次看 → **只存不比**(⛔ 不編一個「跟上次比」出來);沒變的一個字都不顯。⚠️ 每個欄位要有自己的**雜訊門檻**(⛔ 四捨五入誤差不報);localStorage 走 `_lsJson` + **必接 `_lruTrim`**(V76.2.7)。🚨 **測試陷阱**:`_rpSnapDiff` 比完就**寫回**新快照 → 接著呼叫 `_rpSnapHtml` 會變成「同一個資料日期」= 空字串(假失敗)→ ⭐ **會寫回狀態的函式,每一次量測前都要各擺一次初始狀態**。測試 `scripts/test_dupnum.mjs` ⓝ~ⓝ6 |
| **顯示「這一檔是不是一般上市櫃股」** | 🚨 **V77.2.1 起判「要不要對它套上市櫃規則」一律走三態的 `app._isTwListed(sym)`**(`true` 確定上市櫃 / `false` 確定不是 / `null` 還不知道)—— ⛔ **不可拿 `_offListed` 當守門**:它的 `null` 有**三個**意思(清單沒載好 / 市場別欄位空 / 確定是上市櫃),呼叫端分不出來。🚨 實例:`_splitGapWarn` 第一版寫 `_offListed(sym) !== null` → **上市櫃也被自己擋掉**,2603 長榮那個真的存在的斷崖回 `null`(⭐ 是**實跑**當場抓到的,⛔ 不是推理出來的)。⭐ 徽章仍走 `_offListed`,判斷邏輯**全 App 只有一份**(它已改成一行轉呼叫)。📍 V77.2.1 補上**個股頁頂端**那顆 `🏷️ 非上市櫃` —— V77.1.5 只接了決策台/訊號榜/釣魚池三個榜的每一列,而**個股頁才是使用者實際在看的地方**(陷阱 #37 又一次)。| ⛔ 一律走 `app._offListed(sym)`(V77.1.5)—— 回 `null` = **不知道**(清單沒載好),⛔ **不可把「還沒載好」說成「它不在名單裡」**。🚨 實測(2026-09-15)`data/` 2,358 檔個股裡**379 檔(16%)**不在 `stock_names.json`(它的兩個來源是官方上市櫃公司基本資料與每日收盤行情,**興櫃不在那兩份上**);抽樣 40 檔**只有 2 檔有融資餘額**(有名字組 34 檔)、近 20 日中位成交量 **24 張 vs 151 張**、67% 不到 50 張/日。⭐⭐ **該講的不是「沒有中文名」,是「你可能買不到」** —— 這套回測的進場是「尾盤觸價買」,一天成交 24 張(甚至 0 張)那個價買不到、或你一買就把價格墊高 → `_pbRowHtml`(決策台/會賺訊號/釣魚池**共用那一支**)每列多一顆 **🏷️非上市櫃**。⛔ **名單刻意不刪**(同處置股:刪了就不是那個榜真正的成績)。⏳ **⛔ 不可為了補中文名就去加採礦來源** —— FinMind `TaiwanStockInfo` 補得到,但補完 `_offListed` 就失效 =**拿掉了比名字更重要的資訊**;正確順序是**先有「市場別」欄位**(要靠興櫃專屬端點,陷阱 #23 ⛔ 不可猜網址)。測試 `scripts/test_dupnum.mjs` ⓙ~ⓙ3 |
| **新增任何「每一列都要對齊的小符號欄」**(✅⚠️⛔ / 🔴🟢➖ / 強中弱) | ⛔ **不可用 `text-align:center` 靠 glyph 自己對齊**(V77.0.9)—— `text-align` 只管水平,垂直是**行盒的 strut** 決定:9px 的巢狀 `<span>` 要去對齊 11px 的基準線,在格子裡就會偏低;而 emoji(≈1.275em)與 CJK(1.0em)的 advance 又不同 → 五列看起來高低左右都不一致。⭐ 一律用 `display:flex;align-items:center;justify-content:center;line-height:1` 的固定寬格子(`_gaugeRow` 的 `BADGECELL`)—— **flex 容器沒有 strut**,不管什麼符號都置中。🚨 **沙箱沒有彩色 emoji 字型**(`✅⚠️⛔🔴🟢➖` 六個量到**同一個寬度**)→ 這一類問題**headless 重現不了**(陷阱 #40)→ 修法要做成「不依賴 glyph 度量」的結構修法,⛔ 不是針對某個符號調偏移;測試也只釘「每格都是置中的 flex + 幾何一致」,⛔ 不斷言 glyph 寬度(那永遠會過 = 假綠燈) |
| **新增任何「排行 / 榜單 / 多欄資料表」** | ⛔ **表頭一律可點排序**(V76.3.0,使用者明示:「爾後類似這種的都要有排序功能,**不要我又提醒**」)。三件事缺一不可:① **目前照哪一欄排要看得出來**(▼/▲ + 變色)② **同一個表頭再點一次要反向** ③ **每一個數值欄都要能排**(⛔ 少一欄就會出現「照那一欄排但表頭沒有它」= 看不出現在照什麼排)。⚠️ 換分類/換頁籤時**排序要回到那一類自己的預設**,⛔ 不可把上一類的排序帶過去。測試 `scripts/test_broker_league.mjs` ⑨ |
| **新增任何卡片 / 容器** | ⛔ 先問一句「**這個框在講什麼事**」—— 講不出來就不要框,改 `標題 + border-b border-[#21262d]`(V76.4.1 使用者明示,完整判準見「🧱 去框判準」)。⚠️ 量任何幾何之前一律先注入 `scripts/lib_rwdshim.mjs`,而且⛔ 只可用 shim 認得的邊框 class(`border` / `border-b` / `border-t` / `border-l` / `border-r` / `border-l-2` / `border-l-4`)—— 用任意值量到的是假的(陷阱 #40) |
| **密集資料表的版面** | ⭐ 使用者明示(V76.3.0):「我要能像專業介面一樣**版面使用空間最大化**」。對標作法 = **左欄凍結的窄分類欄(≤70px)+ 右側緊湊表格**,**每列一行、列高 ≤34px** → 一頁(844px)至少看得到 10 列。⛔ 舊的「4×3 大方格橫擺當選擇器」光選擇器就吃掉半個畫面、右邊只剩 4 列。⛔ 一列塞兩行(名稱一行、次數徽章一行)是密度殺手 —— 次數/徽章要嘛併進同一行、要嘛獨立成欄。📐 幾何一律 inline style(Tailwind 是 CDN,沙箱載不到 → 用 class 排的版在測試裡完全沒作用)。測試 `test_broker_league.mjs` ⑩ |
| **任何「會重繪的容器」裡有 `<details>`** | 🚨 `innerHTML =` 會把 `<details open>` 全部關掉、而且高度一變畫面就被推走 —— 使用者原話「**📖 完整報告展開會一直跳掉**」。⭐ 修在**唯一的寫入入口**(報告頁是 `app._rpSet`),⛔ 別在各張卡各補一次。三條:① 每個 `<details>` 要有**穩定鍵** `data-dk`(⛔ 不可用 DOM 順序 —— 內容會變多變少)② ⭐⭐ **只還原「使用者自己點 summary 開的」**(`data-utog`,由 click 事件標記;⛔ 不可聽 `toggle`,程式改 open 也會觸發)——把「程式自動展開」也記住的話,會**蓋掉「這一節有預警才自動展開」那條規則**(V76.3.0 第一版就這樣打破 `test_report 📄b2`)③ 卡片整個在視窗上方時,高度差要補回 `scrollY`。測試 `scripts/test_report.mjs` 🔁a~🔁e(含決定性對照組) |
| **顯示任何「上漲 / 下跌機率」** | ⛔ 一律走 `app._probBox(sym, {mode})`(V77.4.6,全 App 一份,位置共用:報告頁 / **總覽的機率圖 `#ovProbBox`(mode:'chart',V78.4.3 從頂端那一行搬進總覽;頂端 `quoteProbLine` 已刪⛔ 別加回來)** / 決策台每列 chip / 到價監控 / `pro.html` 實測總表)。圖一定有「一般股票」那條與贏大盤白線(`test_ovprob.mjs`)。🚨 **口徑 = 今天尾盤買**(V77.4.8 統一,`h=1` 就是「明天收盤」)—— ⛔ 不可再寫「隔天開盤買」。⛔ 四條一個都不可省:① **同時印全市場基準率**(明天 漲 33.6 / 平 29.9 / 跌 36.5;抱 20 天 漲 45.2 / 平 6.0 / 跌 48.8)—— 少了它「漲 45%」會被讀成「這檔很差」,而那是常態 ② 🚨 **同時印「🆚 贏大盤」** —— 抱 20 天漲的機率最高那一格(谷底・很會跳・大盤在年線之下)有 63.6%,但贏大盤只有 36.9%(基準 37.4)、超額 −1.64%(那 63% 全是大盤自己反彈)→ **「漲的機率」與「賺不賺得到」是兩件事**;⛔ 那組數字一律**從表裡現讀**(`_probBox` 的 `topWarn`),⛔ 不可寫死在文案裡(V77.4.7 寫死 63.1/36.2,換口徑當場過期)③ 樣本 <200 筆說「**樣本不足**」,⛔ 不補值、⛔ 不借隔壁格 ④ 🚨 **「明天」那個尺度要同時講三件事**:漲跌幾乎對半(33.6 vs 36.5,只差 2.9pp)/ **三成的日子是「平」**(扣完成本白做)/ 超額平均 −0.09% = **量不到優勢** → ⛔ 只描述、不給買賣指令。⛔ **不把三個機率加權成一個分數**(陷阱 #38)。⚠️ 機率**不含出場規則**(假設抱滿 N 天)→ 文案要寫「真的做要照出場總表那一條走」。測試 `scripts/test_prob.mjs` |
| **新增任何「會列出出場規則成績」的地方** | ⛔ 本站有**兩份**出場成績,⛔ 不可互相比較也⛔ 不可擇一刪掉(V77.4.6):① `_EXIT_EDGE` = **組合回測**(49 個月・本金 100 萬・一天最多 2 檔)的**總獲利**(唐奇安 590 萬 vs 5 日線 193 萬)② `_BREAKOUT_EXIT_EDGE` = **每一趟**的平均超額,母體是「創 60 日新高」那 15,533 次事件(唐奇安 +1.43pp vs 5 日線 +0.03pp)。⭐ **單位不同、母體不同** —— 但**結論一致**,而「兩套完全不同的方法得到同一個結論」正是它的價值 → 顯示時**兩邊都要寫出口徑**並主動說「⛔ 不可互相比較」(同風報比那兩個的處置)。⛔ 新增第三份之前先問「它回答的是不是同一個問題」。測試 `scripts/test_breakexit.mjs` |
| **任何顯示「進場價 / 什麼價位才可以買」** | ⛔ 一律讀 `app._keyLevels.trigPx`(V77.5.3;產生者 `_ovKeyLevelsHtml` 從 `_pbEdgeOf` 算一次,條件同主卡:沒持有・⛔ 空頭・⛔ loose)—— 價格尺 / 報告 §11 價格牆 / §21 / 海報共用。⛔ **不可再畫 `buyPx`(回測 5 日線/月線承接)與 `addPx`(帶量過前高)當進場價**(舊朱家泓劇本,沒實測過);那兩個欄位只剩**空頭的 👀 觀察價**(描述,⛔ 不是買點,價位不動)。沒有觸發價 → 明寫「沒有進場價」,⛔ 不退回均線。⛔ 顯示端不可自己呼叫 `_pbEdgeOf`(第二份真相)。測試 `test_ovrarity` ⓒ2~ⓒ2f / `test_gauge2` ⓓ~ⓓ4 / `test_ovslim` ⓪d⓪e |
| **任何顯示或下單用到「硬停損」** | ⛔ 一律走 `app._unifiedExitPlan().stopFinal`(V77.5.2)= **min(買進當天最低, 成本 × 0.95),進場後固定不動** —— 跟 `portfolio_backtest.mjs` STOP=lo5 與 `auto_trade.py` 同一條。🚨 舊版是 `max(朱家泓發動K低, 成本 −5%)` 而且會往上移(沒回測過,常比自動下單更早叫你賣)。⛔ 不可再讓硬停損往上移 —— 往上移是「你設定的出場線」的工作。沒填買進日 → 只能用 −5% 並寫原因。⛔ 總覽的「建議減碼 / 出場」也⛔ 不可再由 5 日線觸發(`_exitMode.on` 只看三條出場 + 中期空頭)。測試 `scripts/test_guardtime.mjs`(讀回測原始碼比對)/ `scripts/test_ovslim.mjs` |
| **顯示「距出場線多遠 / 今天會不會碰到 / 智慧單觸發價」** | ⛔ 一律走 `app._exitDistance(data, sym)`(V77.4.9,全 App 唯一一份;決策台 / 總覽主卡 / 價格位置圖 / 報告 §11 / 到價監控 / 跑馬燈共用)。⭐ **三條都算**(使用者選的,跟 `portfolio_backtest` 與 `auto_trade.py` 同一把尺、三條先到先賣):① 硬停損 = `_unifiedExitPlan().stopFinal` ② 你設定的線 = `_exitPrimary()` ③ 抱滿 `_maxHold()` 個交易日(K 線根數;V77.6.5 起跟著出場規則走:唐奇安 40 日 = 40 天、其他 = 20 天,`_MAX_HOLD_BY_RULE` 三份實作 index/pro/auto_trade 由 `test_beargate` 跨檔比對)。⭐ 「今天會不會碰到」= 距最近那條 ÷ **今天的** ATR14(`_atrTR14(data, n)`,⛔ 不是 `_exitLines.atr` —— 那是進場日的);門檻讀 `_EXIT_DIST`(≤1 🚨 / ≤2 ⚠️)。⛔ 觸發價一律 `_floorTick`。⛔ 算不出的那條寫進 `missing` 並印原因(陷阱 #22)。🚨 **⛔ 不可再寫寫死的「兩條一致」宣稱** —— V77.4.9 使用者截圖:主卡「守住 511」(唐奇安)vs 價格位置圖「停損 533」(硬停損),文案卻寫它們一致。⚠️ 掃**手上每一檔**時 `ind` 傳 `{}`(`this.indicators` 只對齊當前個股,陷阱 #19)。測試 `scripts/test_exitdist.mjs` |
| **新增任何「停損價 / 觸發價 / 掛單價」** | ⛔ 一律對到**台股跳動單位**(V76.2.9):停損價走 `app._floorTick(p)`(**無條件捨去**)、觸發價走 `Math.ceil`。⭐ 同一個原則:**買要真的漲過、賣要真的跌破**,⛔ 不在條件還沒成立時就動作 —— 四捨五入(`_roundTick`)會把停損價修到比 −5% **還高** = 提早把使用者洗出去。🚨 實測(V76.2.9):`playbook_edge.json` 300 檔裡 **257 檔(85.7%)的停損價對不到跳動單位**,那種價格**掛不出去**,而 `auto_trade.py` 正是拿它掛**真的**停損單;而同一份檔案的**觸發價 300/300 全對** —— 只差 11 行外的停損沒接上(陷阱 #37)。⚠️ 階梯有**三份**(`index.html._tickOf` / `pro.html._tickOf` / `playbook_scan.mjs` 的 `tickOf`)—— 三個檔沒辦法互相 import,靠 `scripts/test_ticksize.mjs` 跨檔比對擋住「只改一邊」。⚠️ **回測端(`portfolio_backtest.mjs`)刻意還沒對**(差半檔、中位 0.088%)→ 實際下單會比回測略差,已寫在畫面免責裡;要改就得重跑 49 個月回測並更新 `_DECK_TRACK49`。測試 `scripts/test_ticksize.mjs` |
| **報告頁 §10 籌碼總表要加一列 / 改狀態** | ⛔ 狀態一律走 `app._chipVerdict(row)` 讀 `_CHIP_VERDICT`(V77.3.4);文案裡的數字用 `{key.field}` 模板從 `_CHIP_EDGE` / `_FSTREAK_EDGE` 帶入,⛔ 不寫死(探針重跑只改常數)。四種標籤只有 ✅ 實測有效 / △ 證據偏弱 / ❌ 實測無效 / ○ 只描述,⛔ 不可出現看多/看空/⚠️(這張表講「能不能預測」不是方向)。⛔ 這張表**不新增指標**,每一列的數字仍由既有取數函式來。測試 `scripts/test_rpchip.mjs` |
| **顯示或計分用到「券商/分點」** | 🗑️ **V79.0.0 已整組移除**(FinMind 付費金鑰失效,使用者決定)。⛔ 不可再做任何讀分點 / `broker_*.json` / 付費資料集的功能 —— `test_nobroker.mjs` 會擋。研究結論(三支探針:跟著分點做沒有預測力)照留在 LAB。 |
| **顯示或計分用到「這一族排第幾 / 族群強弱」** | ⛔ 一律走 `app._stockRegime(sym)` / `app._regimeStats()`(V76.0.0)—— K 棒戰法卡與報告頁**共用同一份**。🚨 `sector_rot.json` **只准拿來畫走勢與資金流**,⛔ 不可拿它再排一次名次:實測一注入「自己從 sector_rot 排」,同一檔當場變成「排第 **29**」vs 真值「排第 **27**」= 兩個「排第幾」打架。⚠️ 名次是**官方產業**的,而分群可能是**題材** → 顯示時名次一定要帶自己的族名(⛔ 不可只寫「這一族排第 N」)。⚠️ 那四條資金流(`flow.f/t/dl/mg`)是**描述用**,實測排不出有效順序。測試 `scripts/test_report.mjs` 🏭b |
| **新增任何「每檔一份」的 localStorage 快取** | ⛔ 一律接上 `app._lruTrim(prefix, keep)`(V76.2.7;全 App 只有這一份)—— 實測 `brokerChips_v2_` **一檔 108 KB 且無上限**,看 45 檔就把 iOS 的 ~5 MB 配額吃光,使用者存自己的東西時就會跳「存不下來」。⭐ **使用者自己產的、不可重建**的資料(貼上的報告 `rpNote_`、AI 圖 `rpImg_`)一律放 **IndexedDB**,⛔ 不跟可重算的快取搶 localStorage;放進去就要在 `idb.prune()` 開白名單(它的規則是「ts 超過 7 天**或沒有 ts**就刪」)。⚠️ `idb.put` 回 true/false(V76.2.7 前成功回 `undefined`,害判斷式永遠當成失敗)。測試 `scripts/test_report.mjs` 💾a~💾e2 |
| **改報告頁的卡片(新增/下架/搬家)** | ⛔ 下架一張卡之前先問「**它是不是某個東西的唯一產生者**」——`_rpActHtml` 那張可以刪,但它上面那兩行 `_ovDecide()` / `_regaugeStrip()` **一行都不能拿掉**(⚡ 快速判別表整張讀前者,總覽儀表列靠後者重畫;同 V76.1.2 `_overallGaugeHtml` 的教訓)。⭐ 各節卡片一律**照 § 由小到大**排(V76.2.5;使用者拿外部 AI 的 20 節報告逐節對照),`§0 資料日期`是附錄排最後。⛔ 搬數字到別頁時先查目的地**有沒有同一個數字**(基本頁 X 光機已有本益比/殖利率/股價淨值比/月營收 → 重點數字卡刻意不重複放,並在卡底指路)。測試 `scripts/test_report.mjs` ⑪a2/⑪a3/📄a2/📄c3 |
| **改任何「固定框架」的高度**(頂端列 / 底部分頁列 / 個股置頂 / sticky 表頭) | ⛔ 改之前先量:`node scripts/rwd_audit.mjs` 的 **「🧱 垂直空間」** 那一行(V76.3.2)—— 它會印「視窗高 → 頂端 X + 分頁列 Y + 個股置頂 Z → 內容剩 N%」並**逐項列出是誰吃掉的**。🚨 實測桌機個股頁曾經 **410px / 內容只剩 54%**(使用者:「螢幕可觀看地方變窄」)。⭐ **桌機是橫的、手機是直的** —— 手機上下疊是對的,桌機同一批東西應該**並排**(`#quoteHeadBox` 就是這樣從 214px 壓到 140px,⛔ 資訊一個字都沒刪)。⛔ 桌機的壓縮一律寫在 `@media (min-width:1024px)` 裡,**手機一行都不准動**(測試 `scripts/test_vspace.mjs` ② 專門釘這條,把斷點改成 100px 會紅)。|
| **新增任何「資料表 / 排行榜」的欄寬** | ⛔ 不可寫死 px 欄寬(`grid-cols-[96px_66px_…]`)—— 那在手機剛好、在桌機**右邊會永遠空著**(庫存表實測空了 **774px**,V76.3.2)。⭐ 一律 `minmax(原本的 px, 比例fr)`:min 加起來維持原寬 → **手機一格都沒變窄、照舊橫捲**;桌機才把多出來的按比例分掉;外框用 `w-full` + `min-w-[原寬]`(⛔ 不是 `w-max`)。⭐ 表頭與每一列**共用同一個 class**(`.inv-grid`),⛔ 別兩處各寫一份(改一邊就對不齊)。🚨 **驗的時候⛔ 不可量「列有多寬」** —— grid 容器本來就會撐滿父層,欄位寫死時它照樣是滿的;要量「**最後一欄的右緣離列的右緣多遠**」(我第一版就是這樣寫出假綠燈的)。|
| **改字級 / 新增字級** | ⛔ 先讀 `index.html:274-320`(V44.2 起共 **四張**表):`html[data-font=small/medium/large/xl]` 的 root 縮放 + **一張無條件的 `!important` 放大表**(`text-[8/9/10/11px]` → 9/10/11/12px)+ large/xl 兩張加碼表 + **V76.3.2 新增的 small 縮回表**。🚨 那張無條件表的後果是:**「小」這個選項對全 App 最多的那批字一點作用都沒有**(寫死的 px 不吃 root 縮放,而放大表又把它們墊高)—— 使用者連續反映「調到最小還是很大」的真因就是它。⛔ 新字級一律落在這四張表裡;⛔ 改 medium 的預設值會讓全 App 密集格爆版(V44.2 的理由仍成立)。測試 `scripts/test_vspace.mjs` ④。|
| **寫任何「量幾何」的測試 / 巡邏** | ⛔ 一律先 `await page.evaluate(rwdShim)`(`scripts/lib_rwdshim.mjs`,**全 repo 只有這一份**)—— 沙箱連不到 Tailwind CDN,`flex` / `min-w-[466px]` / `grid-cols-*` 這些 class 型規則**整個不生效**,不注入的話量到的幾何**全是假的**(陷阱 #40)。⛔ 不可複製第二份:漏一條規則就整片誤報,而那種誤報跟真問題**長得一模一樣**。⭐ 它會回「沒生效的規則」清單 → 非空就直接當紅燈,⛔ 不是印個警告繼續跑。|
| **任何「距 X 幾 %」的欄位** | ⛔ 先問一句「**這是位置還是漲跌**」。⭐ **位置**(那個價位在現價上面/下面、距一年高幾 %)⛔ **不准碰紅綠** —— 一律灰字 + **▲ 在上面 / ▼ 在下面**;只有**真的漲跌**(今日 %、近 20 日 %)才用紅漲綠跌(燈號鐵則)。🚨 V76.3.5 實例:本站自己畫的圖把「季線 +28.2%」塗紅 → 讀起來像「季線漲了 28%」,而上方的價位其實是**壓力**。⭐ 這跟 V76.2.6 批評外部 AI 圖的是**同一個錯** → 修自己那邊的同時,**做圖提示詞也要把這條教給 AI**(3c 條)。測試 `scripts/test_rpown.mjs` ⓖ |
| **新增任何「大盤層級」的警示 / 推播 / 「崩盤前兆」說法** | ⛔ 先過 `crash_warn_probe.mjs` 的六關(V79.3.5:加權 2000~2026、24 種常見徵兆 **0 種過關** —— 頭部背離 +1.4pp、騰落線背離 −1.1、過熱只差安慰劑、趨勢類是高點之後才亮;照著出場 23 年 ×15.9 vs 放著 ×24.9)。沒過 → **只描述 + 只進 🔔 鈴鐺**(`_alertQuiet`,⛔ `_fireAlert`),⛔ 不可叫人減碼 / 空手 / 現金為王 / 全出清,一律「手上的照你的出場規則走;大盤轉空只先不買新的」。外資台指期一律 `_fiFutState()`(worker `fiFutChg5` / macro_miner `fi_fut_state` 同一條);指數成交量是 0 → 量價判斷用成交金額(陷阱 #29)。測試 `scripts/test_mktwarn.mjs` / `test_fifut_gate.mjs` ③ |
| **任何「事件 / 行事曆」要講「所以呢」** | ⛔ **只准講「那幾天波動會不會變大」與「盯哪個數字看它有沒有兌現」** —— `calendar_stock_probe.mjs` 實測 **37 種財經行事曆日**(逐檔 + 期外驗證)**方向 0 個成立**。⛔ 不可給多空、⛔ 不可給部位成數、⛔ 不可寫「減碼/出清/加碼/留倉」。🚨 V76.3.5 實例:`macro_miner.build_macro_events_ai` 的提示詞**明文要求**「幾成部位、要不要留倉」→ 產出「⛔ 建議部位降至 3 成以下或全出清」。⭐ 這是**陷阱 #37 再犯**(同一條規則 V76.1.8 已寫進報告頁 §12,行事曆那處沒接到)→ 寫下「一律只講波動」時,**當場 grep 全 repo 還有哪幾處在講方向**。⚠️ AI 產的「怎麼做」若要保留,必須標「🤖 AI 建議(⛔ 沒有實測背書)」並把實測結論寫在同一塊。測試 `scripts/test_rpown.mjs` ⓗⓙ。🚨🚨 **V77.1.4 第三次漏接**:總覽最上方**紅框「🚨 緊急警示(最優先)」**只因為「這幾天有 FOMC/CPI」就寫「波動放大,**部位先收、別裸壓**」—— 比任何實測訊號都顯眼。→ 文案只講波動,並降級成 `_lastGauge.emgNote`(不閃、不紅框、不叫「緊急」;它講**未來幾天**,而 🚨 那格講**今天已經發生的事**)。⭐⭐ 而我第一版把它掛在 `emgHtml` 上,**那整段是 dead code** → 提醒直接消失,測試卻照樣綠 = 假綠燈;**把東西搬到別的變數之後,要確認那個變數真的會被畫出來**。⚠️ 斷言範圍要**只框行事曆那一則**(同一段裡 `riskS ≥ 68` 與「反彈減碼」是合法的,⛔ 不可因為含「減碼」就一起擋)。測試 `scripts/test_dupnum.mjs` ⓑs~ⓑ2d。🚨🚨 **V79.5.6 第四次漏接**:行事曆每一列的 📚(`_MACRO_EVENT_PLAYBOOK`,7 個事件)「事前要做 / 事後要做」整段在下指令(減碼、現金拉到 30%、跳空高開買進、先賣 1/3)→ 改成「📌 事前留意 / 📌 事後看什麼」,每一則收在「手上的照你的出場規則走」;個股頁頂端訊號標籤的說明(「賣 1/3 ~ 1/2」「可分批建倉」)同一版改成描述。測試 `scripts/test_nodirective.mjs` |
| **新增任何「圖 / 報告」要給使用者存下來或分享的** | ⭐ 先問「本站自己畫得出來嗎」——⛔ 別預設要外包給 AI。`app._rpDrawOwn(sym)`(V76.3.4,純 **Canvas**)是現成範本:零 API、零等待、**零幻覺**(數字直接讀 `_rpLast` / `_keyLevels` / `_upsideStash` / `_lastGauge`,⛔ 一個都不重算),而且顏色**完全受控**(台股紅漲綠跌、風險用 ✅⚠️⛔ —— 外部 AI 那張圖 V76.2.6 就在同一張圖上把「好=綠」跟「−4.90% 用綠」畫成自相矛盾)。⛔ **不用 ECharts**(V74.7.2:圖表元件載不到會把整個 App 帶走)。⛔ 圖上**不可出現融合總分**(陷阱 #38)。⛔ 免責(不是買賣建議 / 不是 AI 畫的)不可省。🎨 **顏色 / 字級 / 畫布寬一律讀 `app._RP_STYLE`**(V76.3.8;做圖提示詞也從它帶入 —— ⛔ 兩邊各寫一組 hex 就會再次「配色有差」;測試 ⓟⓠ)。📖 **海報上每一個數字都要配一句白話**,一律走 `app._RP_GLOSSARY`(V76.3.9;canvas 的 `cells()` 與**餵給外部 AI 的提示詞**共用同一份,⛔ 兩邊各寫一組 = 同一個數字兩種解釋);五個面向的白話**用現成的 `_GAUGE_SPEC[].tip`**,⛔ 別再寫第二份。🔠 **字級要用「顯示寬 ÷ 畫布寬 × 字級」去算,⛔ 不是直接看字級數字** —— 這是一張固定寬度的圖片再被縮放,真正的旋鈕是 `_RP_STYLE.W`(V76.3.9:1080 → 780,手機 8px → 11px、筆電 13px → 18.5px;⚠️ 改它每行少 28% 寬,**一定要重跑 snapshot 逐段肉眼看**,測試一條都抓不到那四處爆版)。📏 價格類清單一律走 `priceLadder()`(直式價格軸,價位按真實高度排;⛔ 它自己排序,不依賴呼叫端的順序)。量條顏色照 `_GAUGE_SPEC` 的 kind(方向紅綠 / 風險琥珀三階 / 位置天藍,測試 ⓢ 取樣像素)。🖥️ **畫布與外部圖片的字級⛔ 不吃 App 的四張字級表** → 桌機一律 `.rp-poster` 限寬 600px 置中(1080 畫布 24px 在 600px ≈ 13px),兩張海報都要掛(測試 ⓡ)。🧱 **V76.4.1 起海報是無框的**(節號 + 標題 + 一條分隔線;內容左右界 = `PAD`,⛔ 不再 +18 內縮 —— 判準見「🧱 去框判準」),body 起點要離標題基線 ≥ 30px(V76.3.8 第一版就疊字,測試 ⓤ 讀 `_rpOwnDbg`);⛔ `priceLadder` 回傳的高度必須收**最後一列**(`max(AH, lastY−TOP+18)`)⛔ 不是軸高 —— 兩者當成同一個數字時**數學上不可能收斂**,下一段會被壓到(測試 ⓖ3);⭐ **畫面類改動一律先 snapshot 肉眼看**(`node scripts/snap_rpown.mjs out.png 2330`,⛔ 巡邏工具不進四驗證),測試只守得住已知的錯 —— V76.4.1 就是靠它抓到「② 的價格軸最後三列壓在 ③ 上面」,而全部測試都是綠的。📌 **「接下來怎麼看」那三行一律讀 `app._rpNextLines(sym)`**(V76.3.7;自己畫的圖與做圖提示詞同一份,⛔ 提示詞不可留模板空位給 AI 填 —— 出場線在現價上面時它會拿融資追繳線去填「跌破 ___」)。🧪 測試要驗**真的有畫**(非背景像素數 + PNG 位元組)、**紅漲綠跌**(取樣範圍只框住現價那幾個字 —— 框太大會把別行的顏色算進來)、**數字不是寫死**(改來源後**現價那一塊**的像素指紋要變 —— ⛔ 只比整張圖的指紋不夠,寫死一格照樣溜過去)。`scripts/test_rpown.mjs` |
| **一張卡換了資料來源** | ⛔ **當場把卡上的說明整段重寫** —— V76.3.0 把釣魚池的拋竿換成「決策台那一套」,但 `_castPicksBarHtml` 還在講舊漏斗的「照近 20 日漲幅排 / −1.44pp」= **講一個已經不存在的東西**,使用者看到就問「釣魚池的選股已經變成決策台的了嗎?」(邏輯打架)。🚨 而且**釘住舊數字的測試會反過來逼文案說謊**(`test_fishtank 🎣⑪b` 釘 `−1.44pp`)→ 那種斷言一律改成釘**用意**。⭐ 兩個地方用同一份資料但**結果不同**時(決策台把 👜 庫存/自選排最前、釣魚池用不含持股的純推薦版),⛔ 不可讓使用者自己去發現 —— **兩邊都要主動寫出差異與理由**。|
| **任何「持股要不要賣 / 距出場線多遠」的顯示** | 🐢 **先問「這一檔是不是 ETF」**(V77.6.8,使用者:「我的庫存有 0050,他的出場怎麼不是你說的持續持有」)—— 三條出場(硬停損 / 唐奇安 40 / 抱滿 40 天)是替 🧬 高波動**個股**回測出來的,而本站對 ETF 自己的實測是反的(`etf_signal_probe`:63 檔 ETF 沒有任何買賣訊號贏過含息放著;16 年 0050 含息 > 這套)。⛔ 一律走 `app._etfHoldNote(sym)`(全 App 唯一判斷點;`_invExitScan` / 決策台 / `_ovDecide` / `_exitMode` / 報告 §11 都接它),`_exitDistance` 對 ETF 回 `etf:true` 的空三條 **⛔ 不回 null**(null 在呼叫端是「還沒辦法幫你看」,陷阱 #22)。🚨 這是陷阱 #19/#37 型:決策台把 0050 / 009816 寫成「⏳ 抱滿 40 個交易日了 → 今天尾盤賣」,而 `auto_trade.py` 本來就只賣自己買的部位 → **畫面講錯、錢沒危險**。⚠️ 決策台 far(離線遠)的持股本來**一列都不畫** → 在官方處置/注意名單上的要另列 `[data-exitatt]`(V77.6.8 第二個實例)。測試 `scripts/test_etfhold.mjs` / `test_dispohold.mjs` |
| **決策台新增 / 下架任何一塊** | ⛔ 一律登記進 `app._DECK_SECTIONS`(設定裡的勾選清單),由 `_deckShowApply` 藏 / 顯示;⛔ 不在 renderDeck 另寫一個開關。收起的要在頂端寫出來(`data-deckhidden`,⛔ 不靜默);「今天不用做」⛔ 不可跟任何列著股票的區塊同時出現。標了 `leaderMine_v1` 的持股⛔ 不套三條出場(同一檔一套規則)。測試 `test_leaderdeck ⑧` |
| **改釣魚(pro.html 的 `_fish*` / `_cast*` / `_fpv*`)** | ⛔ 釣魚只有一份程式:股海釣手 = `pro.html?app=fish`,排名一律來自 `_leaderCalc` / `_castPick`(⛔ 不另寫一份挑法)。🐟 V78.6.2 App 模式的海 = **今天排行前 10 名**(每天換;`_fpvTen(D, R)`,⭐ = 今天會買的)—— V78.6.0~V78.6.1 曾改成「扣掉決策台那一批」,回測比今天前 10 名差(`fresh_fish_probe`)→ 改回,⛔ 別再扣那一批(`test_fishapp ⓛ1` 決定性對照)。⚠️ 魚每天換 ≠ 買賣每天換:組合回測每天換倉兩段 0/17 輸 10 天換(見 LAB `fresh-fish`)。App 模式⛔ 不可顯示任何選股規則(使用者:「策略不用寫出來」)。⛔ 其它程式(作戰室 / 散戶救星)⛔ 不可放連進去的入口(V77.9.8 使用者:「其它程式都不能連進來」,`test_fishapp ⓘ`)—— 新加的文字要嘛放在 App 模式藏起來的區塊,要嘛不含規則用語(`test_fishapp ⓑ` 掃整頁)。新增部署檔要**兩支 workflow 都加**(`deploy_pages.yml` + `daily_miner.yml`,否則每輪 orphan 部署洗掉)。改了魚的外觀想換主畫面圖示 → `node scripts/make_fish_icon.mjs`。釣起價一律 `_fpvLive`(即時快照比選股那天新就用快照,⛔ 不拿舊收盤);帶回家養只寫 `fishHome_v1` + 匯入碼,散戶救星那邊由 `_fishHomeSync` 放進「🎣 魚池」(⛔ 不碰庫存)。魚的長相在 `_FPV_SP`,置中一律 `_fpvOx`。🎨 V78.0.0 魚身顏色 = 一年高低位置 `pos252`(高紅低綠漸變 —— 使用者核准的燈號鐵則例外,**只限魚身**;今天漲跌只寫在卡片數字)、大小 / 魚種 = 市值(screener `mcap`,沒有就讀 `data/fin` 用淨利 ÷ EPS 推股數);畫面比例一律 `_fpvFit`(⛔ 不可再讓每條魚各自撐滿畫面)。釣法是手動的:`_fpvOne` / `_fpvGameStep`(跟畫圖分開,測試直接驅動),斷線 / 太慢⛔ 不可讓佇列往前走。公司簡介 `_fpvProfile` 只放本站真資料,未來計畫一律外連 Perplexity(⛔ 不讓 App 內 AI 寫)。🎴 V78.0.1 點開魚 = 遊戲卡 `_fpvCardHtml`(`#fpvCardWrap`):五項能力(體型 / 熱度 / 活力 / 成長 / 賺錢力)各自講「比全市場幾 %」(`_fpvRanks` / `_fpvPct`,樣本 <50 回 null)——⛔ 不加總、⛔ 沒有戰力 / 總分、橫條琥珀單色、卡框金屬色(⛔ 紅綠);特性 / ⚠️ 弱點全是規則寫的事實句。🎣 V78.0.2 App 模式 `_castPick` **一律 👑**(用 `_fpvOn()` 判,主畫面 App 讀不到作戰室設定)、海裡 ⛔ 不補魚;`fpvSea_v1` 每天記住(同一資料日接著釣、釣完就沒魚);拋竿只能點捲線器(`S.reel`,⛔ 不可再加拋竿鈕);往左游用 `opt.flip` 鏡像(⛔ 不轉 π);🕸️ 拋網 `fpvNet` / `_fpvNetStep`(V78.0.3 撒網時⛔ 不畫竿子,改 `_fpvHands` + `_fpvRope`)。🌊 V78.0.4 放回海裡 `fpvRelease` / `fpvReleaseAll` 只動 `fpvSea_v1`(⛔ 不碰漁獲籃 `proWar_catch`、釣魚 / 拋網中⛔ 不可放);沒在釣時線收在竿尖(⛔ 不可再把閒置鉤子畫在水面)。測試 `test_fishapp.mjs` / `test_fishhome.mjs` |
| **改 🧬 選股門檻(位階 / 波動率)** | ⛔ 四份一起動:`scripts/playbook_scan.mjs` 的 hq(採礦)/ index `_GENE_RULE`(`_hqOf` / `_geneRank` 全 App 唯一判斷點)/ pro `_HQ_RULE` / `auto_trade.py` `GENE_RANK`;⛔ 顯示端不可再讀裸的 `x.hq`(那是採礦當時的門檻,設定換回舊的時會不跟著變)—— 例外是 pro `_recoPicks`(重建**過去**哪天推薦了誰,要用當時的旗標)。⚠️ `_EDGE_RULES.gene`(20 日振幅代理,釣魚池)是**另一個量法**,⛔ 不可跟著改。測試 `test_generank.mjs` |
| **總覽「🌅 開盤怎麼做」表** | ⛔ 一律走 `app._ovOpenPlan(data, sym, d)`(V78.5.2),⛔ 不寫新門檻 —— 每列只轉述既有:`_leadTiming`/`_leadWhen`、`d.due.rules`(`_LUNEXT_EDGE`)、出場線「收盤確認」、`_keyLevels.trigPx`「尾盤 ≥ 觸發價」、ETF 買了放著。規則列收成「📌 你的規則」,底下固定五列「開盤後通常怎麼走」(V78.5.4 `_gapFive`:漲停 / 開高 ≥3% / ±3% / 開低 ≥3% / 跌停;怎麼走只讀 `_GAP_BASE.after` = 全部股票 2015 起,⛔ 不用這一檔自己的 —— `gap_after_probe` 實測單一檔前一年猜下一年輸全部股票)。價位對跳動單位。🌅 V78.5.3 每列的比例 = 這檔 `_gapStats`(最近 250 根已收盤、剔除 \|跳空\|>11%、<120 天不給)+ 一般股票 `_GAP_BASE`(`gap_base.mjs` → `embed_gap_base.mjs`,規則一字不差,⛔ 手改)・⛔ 只描述不是預測;「明天收盤」一行 = `_probBox(mode:'tom')`(⛔ 不另算,機率圖 `#ovProbBox` 已刪⛔ 別加回來)。🌅 V78.5.5 卡片 HTML 由 `_ovOpenHtml` 產生、`_renderOvCommand` 排在 📏 價格位置圖**前面**(`#ovOpenBox` 在 `#ovCommandCenter` 裡;第一眼字數測試要排除它);五列色條讀 `_OV_OPEN_TONE`(紅 = 開高、綠 = 開低,方向色)。測試 `scripts/test_ovopen.mjs` / `test_ovprob.mjs` / `test_leadsplit.mjs` ⓗ |
| **任何顯示財報數字(營收 / 毛利率 / 營益率 / 現金流 / 負債比)** | ⛔ 一律讀 `data/fin/{sym}.json`(`fin_slice.mjs` 唯一算的地方;負債比 `debt`、流動比 `cur` 也在那裡算),⛔ 前端不另算比率、⛔ 不叫 AI 上網再查一份(V78.6.9)。新欄位要加在 `fin_backfill.py FIELDS` **最後**。散戶 App 報告頁 §4 趨勢(`_finTrend`,V79.0.8 起含負債比 / 流動比)與 `.claude/agents/financial-analyst.md` 讀同一份(🗑️ 產業作戰室財報分頁 V79.0.8 已刪)。測試 `test_fintrend.mjs` 🏦 / `test_fin_slice.mjs` ⑨ |
| **當沖頁 / 即時頁 / 當沖雷達新增任何「方向 / 勝率 / 燈號」** | ⛔ 先跑 `dt_selfgap_probe` / `intraday_six_probe` 那套樣本外檢查(V79.0.3)—— 「這檔過去 N 天的勝率」是樣本內,換到之後的日子就不準;沒過 = 只放實驗室模式(`data-labonly` + 函式入口 `_labMode()` + 推播一起擋)。一般畫面只放事實(現價・五檔・分時圖・成本關卡)與 `_dtTopLine`(讀 `_DT_EDGE.lu`)。測試 `test_dtlab.mjs` |
| **決策台 👑 表 / 今天要做的事的「現價」** | ⛔ 一律走 `app._deckQuoteOf(sym)`(V79.1.6:富果 WebSocket → 富果報價 → 今天的全市場快照,⛔ 不是今天的一律回 null);WebSocket 分片一律 `_fugleWsOpen`(庫存頁共用,⛔ 不另抄);跳價只改 `[data-lqp]` / `[data-lqc]` / `[data-lqr]` / `[data-lqlim]`(⛔ 不重畫整張表);沒有今天的價 → 表頭寫日期(「10/08收盤」)。每檔金額一律 `_leadSlot()`(帳戶總資金 < 股票 + 0050 = 過期,⛔ 不算)。測試 `scripts/test_leadlive.mjs` |
| **👑 任何「今天 / 明天」「還有幾天換倉」的文案或提醒** | ⛔ 一律走 `app._leadPhase(clk, dataDate)` / `_leadPhaseTxt`(V79.1.5)—— `clk` 是照採礦資料日算的,買賣那天白天採礦還沒更新 → 寫死「明天」就會錯;要賣 / 要買的名單一律 `_leadActs`(決策台 / 換倉提醒 / 開盤提醒共用)。worker 那邊是 KV `leadstate`(`leadOwnedFrom` 區分 👑 / 🔥 持股)。測試 `scripts/test_leadday.mjs` |
| **漲停隔天的任何提醒 / 文案** | ⛔ 一律走 `_luLock`(昨天鎖漲停)+ `_luGapPick`(今天開在哪)+ `_LUGAP` 門檻(V78.6.7)。庫存照 limitup-hold:開盤就鎖抱著、開高沒鎖開盤賣、**開平開低別在開盤殺**;自選只在「開低 ≥5%」或「量縮鎖死又開低 ≥1%」且第 1 根才講(V78.6.8:開低 1~5% 的一般漲停股 09:05 買中位 ≈ 0),而且⛔ 不可叫人掛開盤價(一般股票的開低反彈 09:05 就轉負,lu_split_probe)→「等開盤 5 分鐘後、收盤前賣完」。⛔ 不可再出現「開低別接刀」(跟實測相反)。👑 持股⛔ 不套。開盤價來自 live_quotes 的 `o`(live_snapshot_miner)。測試 `test_lugap.mjs` |
| **處置 / 注意股的任何文案** | ⛔ 只講三件事(V78.4.3):① 被列管⛔ 看不出之後會漲還會跌(`dispo_probe`)② 手上有的⛔ 不用先賣,照出場規則走(`_DISPO_HOLD_EDGE`)③ ⛔ 別用市價單(分盤撮合)。⛔ 不可再寫「怕關/不怕關」「出關常噴」「新手別碰」「高手才玩」;注意股只有「前 5 天已漲 ≥30%」才叫人減碼(專欄 avoid-attn30)。卡片 `_renderAttentionDetailHtml` 與決策台 `_dispoHoldNoteHtml` 同一套說法;觸發式專欄 `attn` 只給**注意股**(處置有自己那張卡)。測試 `scripts/test_attcard.mjs` |
| **新增任何「會下買賣指令 / 會推播」的東西** | 🔒 **V79.1.2 使用者:「預設策略符合進場,我要點進階才能是領頭羊…文字不要露餡」**→ 預設 = 📈 符合進場(決策台 `fit` 開、🔥 `pb` 收,`pb.def:'lead'` = 只有 👑 時預設開);👑 兩個選項在設定「🔓 進階功能」那一區(上面只列 📈 / 🅿️);沒選 👑 時更新紀錄用 `_LEAD_HIDE_LOG_RE`(比 `_LEAD_HIDE_RE` 寬:換倉 / LEADER_ / 前 5 名 / 停車 0050 / 🅿️)擋、說明文字裡跟 👑 有關的片段寫成 `{LEAD:…}`(`_deckShowDesc` 沒選 👑 就拿掉);跟領頭羊無關的地方⛔ 不用 👑 圖示(題材最強 🏅、四大金剛趨勢 🧭)。⛔ 新增任何畫面文字前先問「沒解鎖的人看得到嗎」,`test_leakfree.mjs` 會掃。📒 產業作戰室**成績單**例外:`PRO._recoLeadOn()` 永遠有 👑(使用者選的)。🔬 V79.1.8 **實測總表**也永遠有 👑(`PRO._labLeadOn()`;選哪一套 / 回測數字 / 逐年表 / 條目 / 專欄);池子 / 拋竿 / 更新紀錄 / 「你現在用的」照舊要解鎖。 ⛔ 先問「它屬於哪一套策略」,一律走 `app._strat()` / `_isLead()` / `_park()`(index;V78.1.9 起 strategy 有 gene / park / lead / leadpark 四種,`_strat()` 只回 gene / lead)、`PRO._isLead()` / `_isPark()`(pro)、worker `settings.strategy`(V77.9.6,使用者:「我選什麼策略,其它也要同步變更」)。🧬 時⛔ 不可出現領頭羊的任何東西(使用者:「不想讓別人隨意知道」),👑 時名單上的⛔ 不可再跑 🧬 的三條出場 / 買點提醒(名單外的照 🔥,見下)。持股判斷一律讀 `_leaderMine()`(🧬 = 空),⛔ 不另寫一份。🔥 V78.5.5 起 👑 時分兩套,唯一判斷點 `_leadOwns(sym, held)`:持股在上次換倉快照(換倉日看上一次)才算 👑、沒持有在今天 👑 買進名單才算 👑,其餘照 🔥(三條出場 / 觸發價);名單沒載好照舊 👑。`_leadStk` / `_leaderMine` 都走它(測試 `test_leadsplit.mjs`)。⚠️ 藏起來只是畫面上,程式碼公開。測試 `test_stratswitch.mjs` |
| **成績單的「領頭羊模擬帳」** | ⛔ V78.2.2 起只有一份:pro.html `_leaderLedgerLoad`(📒 成績單 👑;決策台那份刪了,只留一行指路 —— 使用者:「決策頁面裡面把模擬改買移到成績單裡面」)。成交 = 換倉隔天**開盤**(`leader_probe` 回測最好的買法;V78.2.4 起 `auto_trade.py` 預設也是開盤 09:01~09:10,`LEADER_WINDOW=eod` 才是尾盤)。成績單四頁共用起點 = **`_recoStart()`**(🏁 V79.5.3 起可以換,預設 10/22;⛔ 不再直接讀 `_RECO_COMMON` —— 它只是其中一個選項),頂端「🏁 同一起點比一比」每一列直接讀各頁結算(⛔ 不另算);🏆 只在每一套**已賣掉** ≥10 筆才給(V78.2.3,⛔ 不算帳面)。`scripts/test_leader_deck_ledger.mjs`(開盤價用 node 讀 K 線逐筆比)/ `test_recoledger.mjs` 🏁。⛔ 一定寫明「模擬」。 |
| **成績單(pro 📒)的任何區塊 / 「100 萬同一天起跑」** | 🏁 V79.5.3:起算日一律 `_recoStart()`(pro 自己的 `proRecoStart`;選回預設 = 刪鍵,⛔ 不存死)。🔥 那頁 = App 真正的買法(前一晚名單前 2 名 `_recoPicks` → 隔天收盤 ≥ 觸發價才買、收盤價成交;沒有觸發價 ⛔ 不買、⛔ 不遞補;已抱著不重買)——⛔ 不可再用「名單那天收盤」(名單收盤後才出來 = 買不到的價,陷阱 #58)。📈 / 🧪 沒有觸發價 → 一定標「紙上」。👑 錨點不動、起算日之前成交的換倉不算(空手開始)。「100 萬同一天起跑」只有一份:`_raceHot`(= `portfolio_backtest PARK=idle`)/ `_raceLead`(= leader_probe slot)/ `_race50`(`_poliTr` 含息);「現在價值」一律 = 今天收盤全部賣掉拿回多少;同一頁任何「0050 買了放著」⛔ 不可另算(舊表那列讀 `_race50`)。線的顏色只分哪一套(⛔ 紅綠);每一套賣掉 10 筆之前 ⛔ 不給 🏆。測試 `scripts/test_recorace.mjs` |
| **改「領頭羊短線輪動」的任何一條規則**(池子大小 / 動能天數 / 幾檔 / 幾天換 / 續抱門檻) | ⛔ 四份要一起動:① `scripts/leader_probe.mjs` 的 `DEF`(先重跑兩窗口 17 條)② `index.html` `_LEADER_EDGE.rule` + 重跑後的數字 ③ `screener_miner.py` 若天數變了要加欄(`chg10` / `amt20` 是為 L=10 / 20 日均額加的,⛔ 前端不可用別的天數湊)④ LAB `k:'leader-rotation'` ⑤ 🚨 **`lib_leader.py` 的 `LEADER_RULE` / `LEADER_ANCHOR` / `leader_calc`**(V77.9.3 從 `auto_trade.py` 搬出來;auto_trade 與 `pick_snapshot.py --leader` 共用,會動真錢)⑥ `pro.html` 成績單 `_LEAD`(U/N/R/L/hyst/anchor)+ `_leaderLedgerLoad` ⑦ 🎣 **`pro.html` `_leaderCalc`**(V77.9.4 第三份實作:釣魚 👑 池 + 拋竿;⛔ 不讀 index.html)⑧ 重跑 `leader_probe` 後用 `embed_profit_board.mjs` 更新 `_PROFIT_BOARD`。 ⑨ 🔔 **`cloud-worker/worker.js` `LEAD_RULE` / `leadCalc`**(Telegram 換倉推播,第四份實作;V78.0.5 起 `pos` 與 `settings.leadPosOff`)⑩ `pick_snapshot.py` 每列存 `p`(位置)/ `b`(真的會買),模擬帳照 `b` 買。測試 `test_leaderdeck` ⑩ 四份實作同一份名單。測試 `test_leaderdeck.mjs` ⑤ 跨檔 + 跨語言比對、⑨ pro == index、`test_auto_leader.py` ⑪ 📚 **V79.2.5 兩本帳**:第 2 本錨點 `anchor2` / `LEADER_ANCHOR2` / `LEAD_ANCHOR2` 與本數四份一字不差;App 時鐘一律 `_leadClk`(⛔ 不直接叫 `_leaderClock`)、這本 / 另一本手上的 = `snap.kRank / oRank`、`_leadActs` 的 `half / addOne / waitOther`、每檔 = 總資金 ÷ (N × 本數);自動下單 `st['lead'] / st['lead2']`;📚 **V79.2.6 改成選項、預設一本帳**:開 = `settings.leadBooks === 2`(🔓 進階功能 `_DECK_SECTIONS` 的 `books`,⛔ 不另存 deckShow)/ `LEADER_BOOKS=2`;一本帳時各處一個字都不多。兩本的名字與顏色一律 `_LEAD_BOOK_ID`(甲帳青・乙帳紫,⛔ 紅綠琥珀;pro `_LEAD_BOOK_NAME` / worker `LEAD_BOOK_NAME` / auto_trade 同一組字),每檔屬於哪本 = `_leadBookOf`(讀 kRank / oRank)。測試 `test_leadbooks.mjs` / `test_auto_leader.py` ⑰ |
| **政治人物持股(pro.html 🏛️ 分頁)** | ⛔ 含息一律走 `PRO._poliTr`(= `lib_totalreturn.trSeries` 複製品,只多 `opt.stock` 配股加股數 —— 本站 K 線沒還原配股);改 lib 要兩邊一起改(`test_polihold ①a` 跨檔比對)。資料 `data/legislator_holdings.json` 只手動抓(`legislator_holdings.yml`,⛔ 不加 cron),來源是 legislator-wealth.tw 的公開 API(開源 MIT)。⛔ 不給「跟著買」,一定寫「不是他真實的報酬」。🏆 V79.2.1 排行(全部立委)在 Actions 由 `scripts/poli_rank.mjs` **從 pro.html 抽 `_poli*` 函式**算好寫進 `rank` / `rank_meta`(⛔ 不另寫一份、⛔ 手機不重算);workflow mode=out 推 data 分支 + gh-pages。 |
| **顯示「股名 + 代號」** | ⛔ 一律走 `app._nmPair(code, cls)`(兩層版面用 `_nmSub`)—— `getStockName` 在清單沒載入時**回傳代號本身**,自己寫 `${name} ${code}` 會印成「2327 2327」。🚨 **這個坑本專案已經踩第四次**(V72.2.0 / V74.3.9 / V74.7.7 / V76.0.0),而且每次都是**實跑真實資料**才看得到,單元測試抓不到 |
| **盤前體檢分數(開高偏多 / 開低偏空)** | ⛔ 一律走 `app._preOpenScore(x)`(V79.5.4,全 App 唯一一份;renderMarketBriefing 只負責取值);產業作戰室 `PRO._premktScore` 是抄本(兩個檔案沒辦法 import),`test_premkt_formula ⑧` 跨檔比對 —— ⛔ 只改一邊會紅。⛔ 改任何權重 / 門檻之前先跑 `scripts/premkt_app_probe.mjs`(App 這條 2010 起逐日重建、0050 真開盤;判準 = 方向猜對與相關都 ≥13/17 年 + 高原)。📊 2010~2026:方向猜對 72.2%、開反 7.0%、最近一年 84%;🧪 亞股三項 V79.5.4 起只列出來(前一天收盤、台股已反映,16/17 年拿掉比較準)、國內四項 V79.3.8 起只列出來。🕘 **它只預測開盤**:開盤到收盤高分日只比低分日多 0.09pp(扣成本為負)→ ⛔ 不可寫「開高走高 / 順勢做多 / 開盤之後會繼續漲」;🚨 舊紀錄的「開盤後多 0.59pp」是 ^TWII 開盤價假象(陷阱 #47)。null 一律當沒有資料(⛔ `+null === 0`)。Telegram 盤前簡報 / alert_system 是只看標普 + 那斯達克 + VIX 的簡化版(不含亞股)。🗓️ V79.5.5 起每天早上那份會存下來:`macro_miner.PREMKT_SNAP_KEYS`(⛔ 計分多讀一個欄位就要加進來,`test_premkt_log ⑦` 跨檔實跑會紅)→ `macro_risk.premkt_recent`(平日 05:00~08:59,開盤前最後一輪為準)→ `data/premkt_log.json`(只有 daily_miner 那輪寫,⛔ 不改 workflow);產業作戰室「🌅 早上那份準不準」= `PRO._premktTrack`(判準 = `premkt_app_probe`,⛔ 散戶 App 不讀這個檔)。測試 `test_premkt_formula.mjs` / `test_premkt_log.py` / `test_premkt_track.mjs` |
| **顯示或計分用到亞股 / ADR / 匯率的漲跌** | ⛔ 一律先過 `app._premktFieldAge(mr)`(V79.5.2,全 App 唯一):亞股早於「台股上一個交易日」(taiex 與法人日期取早的)、ADR 早於「美股指數那天」→ 只列出來、⛔ 不算分;要講「今天」一定是那一格的日期 = 今天,前一天的寫「台股那天已經一起反映」。🚨 2026-10-22 早上那份檔案時間是新的,但日經 / 韓股 / 恆指 / 三個 ADR 都是兩個交易日前的,照樣算進分數。採礦端 `macro_miner._load_prev_macro` 本機沒有上一份就讀已發佈那份當「日期不可倒退」的基準(⛔ 只讀本機 = macro_cron 乾淨 checkout 時守門從來不作用),匯率也記 `_date` 走同一道守門。測試 `test_premkt_age.mjs` / `test_yf_no_regress.py` ㉑~㉗ |
| **任何「跟上一次比」的累積紀錄(換股 / 持股變化 / 頻率)** | ⛔ 基準一律是「**前一個交易日最後那份**」,⛔ 不可拿「上一輪」—— 採礦一天常跑 2 輪以上,第二輪 = 今天比今天 = 空的,會把今天的紀錄洗掉(V79.5.2 `etf_miner._etf_day_step`:10/20 換股紀錄全空、10/21 只剩 1 筆)。存檔要帶「這份是哪天的」(`hold_d`)與「今天拿來比的那份」(`base_all`);同一天已經有的紀錄⛔ 不可被空的蓋掉;抓不到就什麼都不動。測試 `test_etf_chg.py` |
| **顯示或計分用到 VIX** | ⛔ 一律走 `app._vixState()`(V75.2.3)—— 兩份採礦檔都有 VIX(`macro_risk` 新 / `macro_cache` 舊),實測同一天 16.41 vs 16.31(**抓的時間不同**,不是誰算錯)。⛔ 別再直接讀 `m.vix.close`。🚨 V75.2.3 修掉的正是「**顯示的 VIX 跟風險指數算進去的 VIX 不是同一個數字**」。測試 `scripts/test_vixsrc.mjs` |
| **新增任何「賺/賠多少元」的顯示** | ⛔ 一律走 `app._netPL(buy, sell, shares)`(V71.7.8)+ `app._feeDisc()` —— 淨損益公式全 App 只有一份(已扣買賣手續費 0.1425%×使用者折數 + 賣出證交稅 0.3%)。⛔ 別再 inline 寫一份(V71.7.8 前「今天這檔怎麼做」卡就有一份複製品),折數規則一改就會有兩個版本的金額 |
| **新增任何「量表 / 刻度尺 / 進度條」式的顯示** | ⛔ 一律走 `app._gaugeRow(label, pct, o)`(V76.0.7)—— 全 App 只有一種尺(灰階底條 + ▼)。`kind:'pos'` 位置灰階 ・`'dir'` 方向才准紅綠(58/42)・`'risk'` 安全/危險用 ✅⚠️⛔(燈號鐵則)。⛔ 別再自己畫 `bg-gradient-to-r … ▼`(估值尺 V76.0.2 就是這樣先各畫一份才收回來的)。🧭 五維儀表列 = `_gaugeStripHtml(sym)`,**總覽與報告頁同一支**,只讀 `_lastGauge.dims`(⛔ 不重算、⛔ 不顯融合總分 —— 陷阱 #38)。📏 價格尺 = `_priceRulerHtml()`,只讀 `_keyLevels`(關鍵價位卡存的)+ `_upsideStash`,由 `_renderGuardRuler` 回填(同 V76.0.6)。🎨 **填色一律走 `app._gaugeFill(kind, pct)`**(V76.0.8)—— ⛔ 一個 kind 一種色系,跨系不混用:`dir` 紅/綠(方向,燈號鐵則唯一准用紅綠的情形)・`risk` **琥珀同色系用亮度**(⛔ 不可紅綠,安全/危險由 ✅⚠️⛔ 說)・`pos` 固定天藍(「基本面強」≠「會漲」)。⭐ 摺疊區 `_overallGaugeHtml` 的 `dimCells` 也走同一支,⛔ 別讓同五個分數在兩個地方是不同顏色。📐 **版面幾何(flex/absolute/寬度)一律 inline style,⛔ 不靠 Tailwind class** —— Tailwind 是 CDN、沙箱連不到,用 class 排的版在測試裡整個沒作用 → 「有沒有對齊 / 有沒有被切」量到的全是假的(陷阱 #40)。🔣 **每一格都要有符號**(V76.0.9):`dir` 🔴/🟢/➖(方向)・`risk` ✅⚠️⛔ ・`pos` **文字 強/中/弱**(⛔ 位置類不可借用 🔴🟢);**每一格都畫 ▼**(含 risk —— ▼ 只講位置,安不安全由徽章講)。🧲 **量價分布只有一份**:`app._volProfile(data,last)` 是唯一分桶源,`_overheadSupply`(現價上方壓力)與「量卡在哪」清單都從它來;結果存進 `_keyLevels.stuck`,⛔ 顯示端不自己分桶。⚠️ 文案只准寫「**成交量**卡在哪」,⛔ 不可寫成「幾 % 的**人**套在那」(買了又賣掉的也算在內)。📖 **價格位置圖的完整說明走 `app._rulerHelp()`**(V76.1.0,彈窗;⛔ 別印在卡上 —— 第一眼有 600 字上限)。🚨 **空頭時⛔ 不可給買點**:`_priceRulerHtml` 一律先過 `app._bearGate(sym)` —— `K.exitMode` 擋不住(它來自 `/出場|離場|反彈再出/`,而空頭沒部位時 `big='🔴 別碰'` **不在那組字裡**)。bear 時把 🛒/🔺 改成 👀 **觀察價** + 一句「不是叫你買」,⭐ **價位一個都不動**(事實不竄改)。🎯 **估值對照價一律讀 `app._instTargetStash`**(`fetchInstitutionTarget` 算的 年化EPS×同業中位PE),⛔ **不准叫「目標價」**、⛔ 不是外資/分析師喊的、⛔ **不可進 `_upsideRoom` 的 `first`/風報比**(它沒回測過)。測試 `scripts/test_gauge.mjs` |
| **新增任何「上檔目標/壓力價位」** | ⛔ 一律加進 `app._upsideRoom(pC, data, last)` 的來源清單,由它統一排序 + 算 %/元/風報比;顯示端讀 `_upsideStash`,⛔ 不自己再算一份。⭐ **來源要含「量」不能只有「價」**(V71.8.7):前高只是一個價位,`_overheadSupply()` 的**套牢區**是「一整片有量的區間」,對「彈上去會不會被壓下來」解釋力更強。⚠️ `_upsideRoom` 必須在顯示端**之前**跑,且 stash 有比對現價防跨股殘留。測試 `scripts/test_upside.mjs` / `test_overhead.mjs` |
| **新增 setCell 純公式卡**(取代 AI) | ① 指標暫存 `this._xrayMetrics` 逐項寫入 ② 末端統一產結論(如 `_renderXrayVerdict`)③ **資料充足度守門**:缺關鍵維度顯「整備中」別硬判 ④ 切股競態守門 `currentSymbolId!==sym` return |
| **任何「跟上次比沒差多少就不要重做」的判斷**(AI 快取 / 重算守門) | ⛔ **不可以把值「量化成桶」**(V77.1.8,測試當場抓到)—— 桶是**絕對座標、有固定邊界**,只要剛好跨過去,**+0.4% 也會換桶** → 「微跳不重做」根本沒做到。⭐ 正解:**把上次那個值一起存下來,之後跟它比**(相對座標),差 < X% 就直接吃舊的。⚠️ 比較用**比值**⛔ 不用固定金額(10 元股的 1% 是 0.1 元、1000 元股是 10 元)。⛔ 而且**不可以乾脆拿掉敏感度** —— 真的走遠了還是要重做(否則盤中大漲 5% 還在顯示早上那份結論,同 V27.5)。🔍 實例:🔮 明日劇本原本綁「15 分鐘時鐘」= 盤中每隔 15 分再點一次就真的重打一次 OpenRouter 推理模型。⚠️ 排查時**別被 `_aiCacheKey` 的 `sigState` 騙了** —— 那支(首席 AI)的呼叫 V51.4 就被註解掉,看起來像兇手但**根本不會被執行**。🗑️ **V77.2.0 補:那支 `_aiPriceNear` 與 🔮 明日劇本已隨使用者要求刪除** → 這條規則**本身照舊**(下次寫快取守門照這個做),只是 repo 裡暫時沒有實例。⚠️ **同版更正**:V77.1.8 把「價格跳一下就重生成」歸給明日劇本**只對了一半** —— 快取鍵確實綁時鐘,但那顆按鈕**自 V44.4 起就包在 `hidden` 裡、使用者點不到**。⭐ 通用:查「誰在耗額度」除了快取鍵,還要確認**那條路使用者按不按得到**。測試 `scripts/test_dupnum.mjs` ⓢ(現在釘的是「這六個刪掉的功能⛔ 不可復活」)|
| **新增任何「叫 App 內的 AI 生成內容」的功能** | ⛔ **先問「它會不會上網」** —— 本 App 能叫的三條鏈(Gemini API / OpenRouter / Groq)**一條都不會上網**(V77.1.8)。所以任何要求「每一條附日期 + 來源網址」的提示詞,交給它們就是**逼它編網址**。⭐ 三件一起做:① 選單把「外部(會查網路)」與「App 內」**分開標示** ② App 內產出的內容**硬掛一行警語**並在提示詞裡**額外**叫它那幾節寫「查不到」 ③ 存檔要帶 `by`(哪個模型)與 `offline` 旗標,⛔ 沒有那兩個欄位就永遠不知道手上這份是誰寫的、能不能信。⛔ **比較模型時不可以給「綜合品質分數」**(陷阱 #38)—— 只列數得出來的(切到幾節 / 帶網址幾條 / 帶數字幾行 / 廢話詞幾次 / 字數),好不好用使用者自己看。🆓 **要列「現在有哪些免費模型」一律當場問官方 `/models`**,⛔ 不可憑記憶寫 slug(V73.8.0:OpenRouter 會下架,寫死的隔天就 404)。⚠️ `<select>` 的 `innerText` 會把**每一個 `<option>`** 都算進「第一眼字數」→ 選單只印名字,說明搬進摺疊。測試 `test_dupnum.mjs` ⓣ/ⓥ ・`test_report.mjs` 🗑️a |
| **記一筆賣出 / 勝率鏡子的賺賠** | ⛔ 只走 `app._invSellCommit`(編輯庫存的 🎯 賣出;舊的 ⋯ 結算平倉只是轉接)—— 全檔只有它寫 `proTerminalTradeLog`(`test_selllog ⑤b` 釘住);鏡子讀 `_tradeLogNet()`(淨損益,`_netPL`)。逐筆成交畫面讀 `_dayTrades`(`_fetchFugleTradesDay` + `_dayTradesPush`),⛔ 沒抓到開盤不可寫「全日」(`test_daytrades`) |
| **任何呼叫 Gemini / Groq** | ⛔ 模型名一律走 `app._aiModel(provider, 想要的名字, key)`(V78.5.6;Groq 只准經 `_groqFetch`、Gemini 只准經 `_callGemini`,OpenRouter 只准經 `_orChat`)—— 名字只是「想要的」,清單沒有就自動換同級;採礦端 Gemini 走 `macro_miner._gemini_model_mm`、Groq 走 `groq_common.groq_model`、worker 走 `geminiModel`。三份 Gemini 規則 `test_ai_model_pick.mjs` 跨檔比對。🧠 V79.5.8 **每個模型帶的參數不一樣**(qwen 明寫不思考、gpt-oss 低強度 + 不回傳思考 + 額度 +400、llama ⛔ 什麼都不帶 —— 帶了會被拒):採礦端一律 `groq_common.groq_apply`(universal_radar / macro_miner;換模型先清上一個的參數、額度從原本的值重算)、App 一律 `_groqBody`(`_groqExtra` / `_groqBudget`);Groq 偏好序與參數 index == `groq_common.py` 由 `test_ai_model_pick ④d/④e` 跨語言比對。⛔ 新增偏好時兩邊一起改;⛔ 不適合中文的模型在取清單時就濾掉(`_UNSUITED`) |
| **新增任何「App 內 AI 產生文字」的輸出** | ⛔ 一律接 `app._aiNumGate(送出去的提示詞, 回答)` + `_aiNumGateHtml`(V77.8.1,全 App 一份)—— 回答裡的數字對不上這一輪提示詞就列出來(⚠️ 可能是它自己算的或編的)。⛔ 不改正文、⛔ 沒有提示詞(舊快取)就不顯示、全部對得上不顯示;有快取的要把 `ng` 一起存。⛔ 外部 AI(會上網)貼回來的不接。測試 `scripts/test_ainumgate.mjs` |
| **任何「今天的量 / 今天的值」除以「歷史均值」的比值** | ⛔ **盤中⛔ 不可以給那個比值**(V77.1.9)—— 分子是「今天**到現在為止**」、分母是「前 N 天**整天**」,⭐⭐ **期間不同不可相比**(陷阱 #17 的時間版:以前是單位張 vs 元,這次是半天 vs 整天)。🚨 實例:使用者截圖台北 09:20 的「量能倍數 **0.0×**」—— 公式與基準都沒錯(V77.1.6 已照陷阱 #43 排除今日),錯的是**拿 20 分鐘去比一整天**,而畫面讀起來像「量萎縮」。⭐ 修法:`_lastBarIsToday()` 為真時**回 `null` 並說出原因**(現在成交幾張 vs 基準整天幾張),收盤後照常給。🐛 V79.5.6:「盤中」= 最後一根是今天 **而且** 台北還沒過 13:30(以前只看前者 → 收盤後一路講「還沒收盤」講到半夜);測試要把時鐘一起釘(沙箱是 UTC)。⛔ **不做「按已交易時間換算成全日」** —— 沒有回測過(陷阱 #38),而且開盤量天生前重後輕會系統性高估。🚨 **記得第二個出口 `_reportFacts`**(餵外部 AI 的提示詞)—— 不改它的話 AI 看到 0.0× 就會寫「量能極度萎縮」,而那是本站餵給它的錯誤前提(顯示點永遠比你以為的多一個,第三次)。測試 `scripts/test_dupnum.mjs` ⓦ~ⓦ6 |
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

### 🎨 `frontend-design` 外掛(2026-09-11 已裝,專案層)—— 哪裡聽它、哪裡以本節為準

🚨 **先更正我自己**:上一版這裡寫「它主打 bold aesthetic・high-impact animations,**跟視覺降噪鐵則直接對立**」
—— **那是錯的**,而且來源是**部落格的二手摘要**。讀它真正的 `SKILL.md` 之後:

✅ **它其實跟本節同一邊**(這幾句可以直接當本專案的補充):
- 「**Spend your boldness in one place** —— 讓一個元素成為記憶點,其餘保持安靜克制,
  **砍掉任何不服務主題的裝飾**」
- 「**gradient washes as decoration**(漸層當裝飾)」被它列為**一眼看出是 AI 做的** tell → 同本節「⛔ 禁用霓虹漸層」
- 「非使用者觸發的動畫要**極少且刻意**;每一段都 fade-and-slide-up、每張卡都 hover 特效 = AI 味」
- 「⛔ 標籤不要用全大寫」「行長 < 80 字元」「結構性裝置(框線/編號/分隔)要**承載資訊**不是裝飾」

⚠️ **真正的衝突是另一件事,而且很具體**:它把下面三樣列為「AI 生成的 tell」,
但那三樣正是**本專案刻意的設計**(仿券商 App,使用者指定):
| 它說是 tell | 本專案的現況 | 判定 |
|---|---|---|
| 「near-black 背景 + 單一亮色 accent」 | `bg-[#0d1117]` 深色終端機 | ⛔ **不改**(券商 App 慣例) |
| 「SaaS-card kit:一堆一模一樣的圓角卡、同一個 border-radius」 | `bg-[#161b22] border-[#30363d] rounded-lg p-3` 全站重複 | 🚨 **V76.4.1 使用者明示推翻了原本的「⛔ 不改」** —— 見下方「🧱 去框判準」 |
| 「小資料標籤用等寬字」 | `font-mono` 用在所有數值 | ⛔ **不改**(數字要對齊,而且使用者會拿畫面數字驗算) |

⭐ **判準**:它服務的是「**做出不像 AI 做的網頁**」;本專案是**每天用的密集型金融終端機**,
一致與可掃視 > 獨特。→ **版面決策(顏色/卡片/字體/燈號)一律以本節為準**;
它的「克制、砍裝飾、動畫要有理由、標籤不全大寫」照收。
⛔ **裝了它也不會讓 2330 那頁的字變少** —— 資訊密度要靠 `_TIDY` 與砍卡流程,不是設計外掛。
(⚠️ 舊文寫的 12,419 字已過期,V76.0.1 重量是 **11,360**;⭐ 砍卡前一律重跑 `card_inventory.mjs`。)

### 🧱 去框判準(V76.4.1,使用者明示;⭐ 推翻上表那一格的「⛔ 不改」)
使用者原話:「**設計上一定要有框框嗎?沒有框框可以放的東西比較多,另外其它頁面也一樣不必要就不要框框,
改設計別種的,我是要整份資料都是這樣子**」。⭐ 先量,他看到的是真的:

| | 去框前 | 去框後 |
|---|---|---|
| 🖼️ 海報(canvas)每一行的內容寬 | 672 / 780 = **86.2%**(外框 + 內縮吃掉左右各 54px) | **724px = 92.8%**,而且跟頁首同一條邊 |
| 🖼️ 海報每張卡的固定開銷 | **118px**(標題區 84 + 底 18 + 間距 16)× 9 張 = 1,062px | **98px** |
| 📄 報告頁 `#rpWalls` 那條鏈 | 8+1+12+11+8 = 左右各 **40px** → 390 手機只剩 **310px** | 左右各 16px → **361px** |

> ⭐⭐ **判準一句話:框如果在講事情就留;只是把東西「圍起來」的就拿掉。**

| 拿掉 ❌ | 保留 ✅ |
|---|---|
| 卡片底色 + 四周邊框 + 圓角(`bg-[#161b22] border border-[#30363d] rounded-lg p-3`)—— 它只說「這裡是一張卡」,而「標題 + 一條 `border-b border-[#21262d]`」說得一樣清楚且**完全不吃寬度** | ⚠️ **Alert Box 的左色條**(`border-l-4`,全站 **253** 處)—— 顏色在講「這一節有事」 |
| 框裡再包一層框(巢狀外殼)—— 兩層邊框中間那幾 px 什麼都沒講 | 🔘 **按鈕(525)/ 輸入框(65)/ textarea(4)** —— 框在講「這裡可以點 / 可以打字」 |
| 純裝飾、沒有語意的圓角小盒 | 📊 **量條 / 刻度尺的底槽** ・📋 **一格一筆的清單/格子卡**(價格尺的 `cell()`、重點數字的每一格) |

⛔ **三條不可違反**:
- ⛔ **不走「只靠留白」** —— 資料密的頁面會糊成一片(使用者選的就是「留分隔線」那個)。
- ⛔ **不可用任意值 `border-l-[3px]`** —— `scripts/lib_rwdshim.mjs` 只認 `border` / `border-b` / `border-t` /
  `border-l` / `border-r` / `border-l-2` / `border-l-4`,用別的寬度**沙箱量到的幾何是假的**(陷阱 #40)。
  要換寬度先去改那份**唯一**的 shim(改完記得同步它的自我檢查條數與 `rwd_audit.mjs` 那行訊息)。
- ⛔ **沒有底色之後,「這可以點」只剩文字提示** → `_rpDetails` 的 `展開 ▾` 雪佛龍**一個字都不可拿掉**。
- ⭐ 三種 tone 一律都掛 `border-l-4`,只有**顏色**不同(中性用 `border-l-transparent`)——
  只有 warn 縮排會讓整排標題看起來歪掉。

### 🧱 V77.0.0 起:**全站**無框,而且是**一條 CSS** 不是改 349 處 class
使用者:「**整個系統比照無框邏輯製作**」。
⭐ **先量**(`node scripts/box_inventory.mjs`,⛔ 巡邏工具不進四驗證):靜態 grep 說 349 處,
**實跑只有 111 個框看得見** —— 其餘是**條件式/隱藏**的卡。
→ 只改看得見的那些 = **改一半**(那些卡一被觸發又是有框的),所以必須是一條規則管全部。

📍 **機制:`index.html` `<style>` 裡一條規則 + `.keepbox` 例外**(⛔ 不逐一改 class 字串)
- 選到誰:**`[class~="border"]`**(class 裡有**獨立的 `border`** = 四邊框)+ `border-[#30363d]`。
  ⭐ 這個選法天生就漏掉要保留的那幾種:`border-b` / `border-t` / `border-l-4` / `border-y border-r`
  **都不含獨立的 `border`** → 分隔線與 ⚠️ 警示左色條**自動**不會被選到。
- ⛔ 排除 `button/input/textarea/select/a/label` **與 `cursor-pointer`** ——
  全站有一批**用 `<div>` 做的按鈕**(設定的切換鈕、選股吸頂列、大盤指數方塊),
  只排除 `<button>` 會把那批一起拉平(`box_inventory` 實跑當場抓到 4 種)。
- ⛔ 排除 `border-[#21262d]`(那是**分隔線** token,用它當四邊框的都是內層小格子)。
- 🔒 `.keepbox`:一排 ≥2 個同款框的**格子**(設定 5 格 / 當沖數字格)——⛔ 框在分「這是第幾格」。
- ⚠️ `border-color: transparent` **而不是** `border-width: 0` —— 寬度留著,版面才不會左右各跳 1px。
- ⚠️ 只清**左右** padding(那才是使用者說的「左右還有空間」),垂直留著當段落間距。
- `pro.html` 同步:`.panel` 拉平(⭐ **class 名一個都不改** —— `test_prohtml` 拿 `.closest('.panel')`
  當**結構**選擇器在用);`.vcard` / `.fishcard` / `.bkrow` / `.labitem` 這些**一排/一列一張**的不動。

🧪 `scripts/test_noframe.mjs`(進四驗證):量 **computed style** 證明「真的拉平了」+「該留的一個都沒被拉平」。
🔍 `scripts/box_inventory.mjs`(巡邏,exit 0):分 📦 section / 🔲 cell / 🔒 keep 三類並印出
**沒拉平的**與**被誤拉平的**。⚠️ 它自己的空過守門:⛔ 只數 class 的話去框前後數字一模一樣 = 沒有鑑別力
→ 一律量 computed style。

📍 **已改的範圍(V76.4.1)**:`_rpDrawOwn` 的 `card()` ・`_rpCard` ・`_rpDetails` ・`_priceRulerHtml` 的外層盒
(⚠️ 最後一支是**總覽與報告頁共用**,兩邊會一起變無框,這是刻意的)・`#subContentReport` 的 `gap-2 → gap-0`
・做圖提示詞 `_reportChartPrompt` 的版面段。
✅ **V77.0.0 起全站都是無框的** —— ⛔ 新東西一律照無框寫,別再照上面那張「卡片三段式樣板」加框;
要加框請先答得出「這個框在講什麼事」,答不出來就用 `標題 + border-b border-[#21262d]`。
測試 `scripts/test_rpown.mjs` ⓐ2/ⓑ2/ⓒ2/ⓓ2/ⓔ2/ⓕ2/ⓖ2/ⓖ3(6 種注入全部叫得出來)。

### Emoji 規則(V25.8 使用者明示:保留)
- ✅ **保留所有 emoji**(使用者明確要求:無 emoji 不知怎麼操作)
- 漲跌幅旁的 🔺🔻 / verdict 開頭的 🟢🟡🔴 / 警報的 🚨 / 標題的 📊📐💰🚀⚠️📌🧩🎯💡 全保留
- 不必改 Lucide / SVG icon(那是過度設計)

### 卡片三段式樣板(Equal Height)
⚠️ **V76.4.1 起這張樣板只適用「還沒去框的頁面」** —— 新增卡片前先讀上面的「🧱 去框判準」:
框講不出它在說什麼事,就改成 `標題 + border-b border-[#21262d]`,⛔ 不要再加 `bg-[#161b22] border … rounded-lg`。
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

**再驗時機**:✅ **V77.0.5 已用八關標準重跑完畢(809 個交易日)—— ⛔ 別再重跑一次**。

🚨 **原本寫「等外資資料滿 1 年」是錯的**(實跑:`foreign_net` **2023/05/22 ~ 2026/09/14、809 個交易日**)。
🚨🚨 **而 V77.0.4 我寫的「C 版變成最強」也是錯的,而且錯在同一個 bug 上** ——
那一版的平均值是用 **n=893 的原始列**算的,而 `_episodes()` 只被拿去印。
⭐ 改用**獨立事件**重算之後**名次整個翻回來**:

| 變體 | 舊(原始列) | ⭐ **新(獨立事件)** | 事件數 | 八關 |
|---|---|---|---|---|
| 🕵️ 基本版(跌+外資買) | +1.83 | +1.17pp | 338 | 4/6 |
| A 買超佔量比 ≥0.5% | +1.89 | +1.47pp | 307 | 5/6 |
| B 改看投信 | +0.22 | **−1.40pp** | 364 | 1/6 |
| C 外資 10 日買 ≥6 天 | ⭐ +3.89(看起來最強) | +1.48pp | 146 | 5/6 |
| ⭐ **D 跌深 12%(現在上線的)** | +1.99 | **+1.72pp(最高)** | 260 | **5/6** |

⭐⭐ **結論:現在上線的 D 版本來就是最好的那個** —— 之前看起來輸給 C,
純粹是因為**一次長行情被拆成很多列、權重偏向走得久的那幾波**。
⛔ **所以預設一個字都不用改**(而且這是「先修方法、再看結論」救回來的一次)。

⛰️ **門檻高原檢定**(V77.0.5 新增)又給了第二個獨立理由:
- **D 的跌幅門檻是一片高原**:−0.5 / −1.0 / −1.5 / −2.0 / −2.5 → +1.41 / +1.32 / **+1.72** / +1.94 / +2.19pp(全部為正、單調)
- 🚨 **C 的「10 日買超天數」是一根孤峰**:≥4 / ≥5 / **≥6** / ≥7 / ≥8 → +0.90 / +1.05 / **+1.48** / **−0.11** / **−8.61**pp
  → 門檻往右挪一格就崩掉 = ⛔ **C 不可拿來換掉 D**(同 V74.3.8 chand2 死在這一關)

⛔ **但五個變體沒有一個通過六關** —— **全部死在「逐年同向」**(2023 那年每一個都是負的)
→ 照 V75.0.9 的自動替換規則,**預設維持 D、不換**。
⚠️ **窗口不含 2022 空頭**(`klines_deep` 有 2021 起的 K 線,但**只有 OHLCV、沒有 `foreign_net`**,已實查)
→ 那一關補不起來;⭐ **走完下一次空頭後才值得重跑**。
⭐ 探針已有 `--selftest`(含**決定性對照**:同一批資料下原始列平均 9.09 vs 事件平均 5.00)。

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

⭐ 通則(從 V68.9.2 分點無限迴圈留下來的):**任何「load 失敗還無條件重呼叫 render」的遞歸都要 gate 在成功條件上,否則無資料 = 無限迴圈**。(原始說明與分點勝率榜「為何要等」已隨 V79.0.0 移除,搬進 `docs/DECISIONS.md`。)

## 🎯 V72.2.0 「今天出現實測會賺的訊號」—— 全市場掃描
使用者:「只要給我最好、勝率最高的資料」。
問題:`_SIGNAL_EDGE` 的成績只在**個股頁**看得到 → 使用者得先想到要看哪一檔,
等於要他自己翻 2,315 檔(**陷阱 #32 的極端版**)。

`scripts/daily_signal_scan.mjs`:採礦端跑**真正的 JS 偵測器**(同 `signal_backtest.mjs`
的做法,⛔ 不複製判定邏輯),只掃**最後一根 K**。
📊 **實測:2,315 檔 / 177 秒 / 產出僅 3.6 KB**;命中 **17 檔**(全市場!)。

⛔ **五條鐵則**:
- **看多只收 `app._sigProven(e)`**(🔁 V79.4.5 使用者選的;舊版是 `exp > 0`)—— A/B 級 **且** `xr`(每趟比同一天平均股票)**> 來回成本**(`_sigCost()` = meta.cost = `playbook_scan.mjs` COST)**且** 樣本 ≥ `_wrEnough`。
  ⛔ `exp` 是對加權算的、**沒扣成本**,拿它判「會賺」會放行一堆扣完成本就白做的。沒過關的日子寫 `bull_why`(⛔ 不可跟「沒跑」長得一樣)。
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
     ⭐⭐ **V75.1.6 追加第二道:`app._mktGate()`(大盤守門)** —— `_bearGate` 只問「這檔自己是不是空頭」,
     ⛔ 問不到「大盤過熱/轉弱/盤整」。實測 `page_sweep` 掃到頂端跑馬燈寫「絕不追高」、
     底下打法適配儀寫「可依紀律進場」、多空計分卡寫「可順勢操作」。
     ⛔ **新增任何會講「進場/加碼/順勢做多」的卡,兩道都要過**:
     ① `_bearGate(sym)` ② `_mktGate()`(回非 null 就把措辭降級成「別重押、別追高」,
     ⛔ 不是叫人放空、⛔ 不動任何數字)。文案一律引用 `_chuPositionAdvice()` 的 `regimeLabel`/`pct`。
     測試 `scripts/test_mktgate.mjs`。(🗑️ V79.1.2 頂部跑馬燈已移除;守門照留 —— 卡片之間照樣不可打架)
     ⭐⭐ **V75.1.9 補:守門要「換掉那句指令」,⛔ 不是在後面補一句但書** ——
     第一版寫成「可依紀律進場,**但**大盤過熱…別追高」,前半仍是完整指令 →
     使用者只讀粗體那半就會照做,巡邏工具也照樣判打架。正解:
     「**條件是到了**(事實),但大盤 X、總部位 Y → **只能小量,⛔ 別追高**(指令)」。
     ⚠️ 而且**新增一道守門時要去看哪些既有測試會被它影響**(`test_wrsample ③` 當場假失敗)——
     那些測試驗的是別的軸,應該把新那道 **stub 掉**,⛔ 不是放寬斷言。
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

🔁 **V79.4.5 起是 16 年版**(2010-12 ~ 2026-09・2,422 檔含下市・135 個訊號・對照組 = 同一天的全部股票),每列 **10 欄**
`[等級, n, e10, w10, p, e20, 賺賠比, exp, xr, tone]`。⭐ **全 App 判「這個看多訊號值不值得照做」只有一支 `app._sigProven(e)`**
(A/B 級 且 `xr > _sigCost()` 且 n ≥ `_wrEnough`)—— 提醒 / K 線頁「值得參考」/ 進場體檢 / 總覽「📈 符合進場」/ 今日訊號 / 決策台名單 / 雜訊清單(pro)同一把尺。
⛔ **App 一律讀內嵌表**(`_sigTable()`),每週自動回測的產物只在實驗室模式當「最近幾年」參考(使用者選的,⛔ 不可再蓋掉內嵌表)。
⚠️ 舊 key「(接刀要小心)」16 年表改叫「(接刀請看實測)」→ `_sigEdge` 先查原 key 再查舊 key(⛔ 不然那列永遠查不到)。
📊 那把尺過關的看多訊號只有 **1 種**(換手量,xr +0.80 > 0.44)→ 每天新出現的看多訊號 5 種 ≈ 48 個(原本在用的每週 3 年表、exp>0)→ 19 種 ≈ 536 個(16 年 exp>0)→ **1 種 ≈ 4 個**;很多天一個都沒有是**正常的**。

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

### 📐 V76.1.9 「版面修正」—— ⭐ 先量,而「左右被切」跟第一眼想的不是同一回事
使用者只給一張報告頁截圖 + 「1.版面修正」。
🚨 **截圖左右被切不是橫向溢出** —— `index.html:355` 有 `html,body{overflow-x:hidden}` 擋著,
而 viewport 開了 `maximum-scale=5.0` → 他是**捏放大在看**。會放大是因為字小、每列三行、還印英文函式名。

#### 🔠 字級:App 早就有三張放大表,新字級要落在表裡
⛔ **加新字級前先看 `index.html:274-296` 與 `:338-342`**:V44.2 有一張 `!important` 放大表
(`text-[8px]`→9 / `[9px]`→10 / `[10px]`→11 / `[11px]`→12),另有 `html[data-font="large"]` / `"xl"` 兩級使用者可調。
🚨 我第一版把說明字改成 **`text-[10.5px]`** —— 它**不在任何一張表裡** → 預設只比原本大 0.5px,
而且使用者切「大字」時**完全不會跟著放大**(= 變相退步)。
⭐ 正解:**一律用表裡有的字級**(`10px` / `11px`);要用 12/13px 就**先把它補進 large/xl 兩張表**(V76.1.9 已補)。
⭐ 巡邏 `node scripts/font_audit.mjs`(⛔ exit 0、**不進四驗證**)——
🚨 它**必須自己注入字級 shim**(沙箱沒有 Tailwind,`text-[Npx]` 完全沒生效,直接量 computed 全是 16px)。
⚠️ 而且**驗 shim 有沒有生效⛔ 不可拿 `text-[9px]`** —— V44.2 那張 `!important` 表會贏過 shim,
量到 10px 是**對的**;要驗就驗**不在表裡**的字級(13px)。這一條第一版就踩到。
📊 實跑:個股 9 個分頁只有 **12 段**低於 10px(不是想像中的上千處 —— 那張表早就把大部分撐住了),已全部修掉。

#### 📱 溢出判準:`scrollWidth` 是**假綠燈**,⛔ 不可再用
`test_report.mjs` 原本用 `scrollWidth > clientWidth` —— 正是 CLAUDE.md「橫版檢查鐵則」明文說**不能用**的
(會把被 clip 的內容也算進去),加上 `overflow-x:hidden` 夾著 → **從頭到尾綠**。
⭐ 換成兩條:① `scrollTo(80,0)` 後 `scrollX ≤ 2` ② **逐元素跟父層比**(照 `rwd_audit.mjs:43-50`)。
🚨 **量之前要把報告頁複製到「已知寬度」的容器**(358px)—— 沙箱沒有 Tailwind,祖先鏈壓到只剩 **200px**,
原地量出來的「超出 36px」是假的;而且要有**空過守門**斷言那個容器真的有 350px 以上(⛔ 0 就沒有鑑別力)。
✅ 換完**第一次跑就抓到三處真的被切掉的版面**(價格牆表 / 壓力測試列 / 估值對照表)。

#### 🚨 `grid-cols-[1fr_auto]` **不等於** `grid-cols-2`
Tailwind **具名** `grid-cols-N` 會編成 `minmax(0,1fr)`;**任意值** `[1fr_auto]` 是原生 `1fr` = `minmax(auto,1fr)`
→ 左欄被 max-content 撐開、右邊 `auto` 欄又永不收縮(`-154,312` 這種千分位是不可斷 token)→ 整列撐寬。
⭐ 一律改 inline `grid-template-columns:minmax(0,1fr) auto`。
⚠️ 全檔還有 **5 處**在別的頁(L13331 / 40365 / 44283 / 44372 / 44384)—— 這一版沒動,列在 `docs/DECISIONS.md` 待辦。

#### 🚨 我自己推錯的一件事(要記住)
`_gaugeRow` 的刻度標籤兩端會掛在軌道外(`_priceRulerHtml` V76.0.8 修過的同型病,當時沒一起修)。
我推論「刻度只落在 5~95%,碰不到兩端所以沒事」→ **錯的**,實測 2330 最右那個標籤超出 **21px**。
⭐ 是新的逐元素檢查當場抓到的。**⛔ 用「門檻不會被觸發」推論安全之前,先實際量一次**(同陷阱 #35)。
修法:刻度線位置不動,**只有標籤**在兩端改對齊(`translateX(0)` / `-100%`),⛔ 不加 `overflow:hidden`(會切掉 ▼ 上方的字)。

#### 🧾 順手修掉的兩個數字
- 🚨 **「法人連3賣 −14,067,577 張」漏 /1000** —— 那三欄(`foreign_net`/`trust_net`/`dealer_net`)**單位是股**,
  正確是 −14,068 張。⭐ 在**源頭**換算(同一個值還餵給 `chipSafety` → AI prompt)。全檔會印「張」的 8 處只有這個漏。
- 🚨 **位階兩個數字**:徽章 91%(high/low)vs 報告頁 §11 93%(收盤)→ 抽 **`app._basePos(data)`** 當唯一真相,
  ⛔ 口徑固定 high/low(徽章的 `pos>=80` / `pos<=35 && dd>=25` 門檻是對它調的,換口徑等於偷改門檻)。
  ⚠️ `dd`(距 250 日高)與 `dd60`(距 60 日高)是兩件事,名字不同、兩個都留。
- 📦 新增 `app._lotTxt(shares)`:整張講「張」、零股直接講「股」(⛔ 不印「2.35 張」)。

### 📝 V76.2.0 「你貼上的 AI 報告」(§22 搬成獨立一格 `#rpPaste`)+ 🚨 面額變更把淨利率算錯 4 倍
使用者貼了外部 AI 產的國巨 22 節報告:「我看不出來,只有數據;貼上存起來下次不用再產;過期要提醒;重點用別的顏色;結合價格牆」。
⭐ 先量:貼上存檔 **V76.1.8 早就有**,但藏在「產業」節第 ⑤ 小段的摺疊裡 → 使用者不知道(陷阱 #32 又一次)。
#### 現行規則
- 存檔仍是 `rpNote_{sym}`(v2:`{t, ts, asof, v:2}`;`asof` = 報告首行「分析基準日期」,抓不到退回 `ts`;上限 30k;舊 v1 照讀)。
- ⛔ **鐵線一條都沒放寬**:不進 `_ovDecide`、不進任何計分、不進「📋 複製整份報告」(`_rpCopyPlain` 用 `!d.closest('#rpPaste')` 排掉整格);
  AI 的價位⛔ 不進 `_keyLevels` / `_upsideRoom`,只在 `_rpPasteVsWalls` **對照**(±3% 內找本站的牆,並排「AI 說 / 本站說」,⛔ 不裁決)。
- 切節 `_rpPasteParse`:鍵帽數字 `1️⃣` = `1` + U+FE0F + U+20E3(`2️⃣2️⃣` 是兩個鍵帽)→ 先拆成純數字;有 `§N` 就只認 `§N`。
  🚨 「8月營收達 163 億」「9/4 法說會」「20 日線」這種行**不可**被當成 §8/§9/§20 標題 → 標題不可以單位/數字/斜線開頭,而且編號要**遞增**。
- 第一眼只留 §1 結論 + §22 筆記(其餘 20 節再包一層摺疊,測試釘 ≤800 字);§19 因子評分 / §20 星等 / §14 機率照顯但標「AI 主觀」(陷阱 #38)。
- 🖍️ 上色 `_rpHi`:**先 `_escHtml`**,再只對標籤外的文字動手(切標籤 `split(/(<[^>]*>)/)`,照 pro.html `_labHi`);
  琥珀 `.rp-hi` = 重點詞、粗體 = 帶單位數字、`==x==` 手標。⛔ **不用紅綠**(燈號鐵則:紅綠只講漲跌;測試釘 mark 不可含 `text-red|text-green`)。
- 🔁 過期 `_rpNoteStale`:判準是「貼上之後有沒有**新資料**」,⛔ 不只看天數 —— ①新月營收(`C.fy.mrh` 末月 > 基準日看得到的月;基準日 ≤10 號時上個月也還沒公布)
  ②財報法定日落在基準日與今天之間 ③法說會 ④除息 ⑤股價偏離報告寫的價 ≥8% ⑥≥30 天。**只在頁內顯示**(V76.1.7 不打擾),快速表第 11 列同步標「需更新」。
- 🔎 提示詞 `_reportPrompt` 改 22 節骨架:標題一律 `§N`、首行基準日、結尾 `§23 來源表`(有網址);明列本站已算好的節⛔ 不要自己算(§1/§4/§10/§11/§14~§17);
  ⛔ §19/§20 評分星等;**本益比一律寫現在的**(要講預估要標「預估」—— 這次 AI 把 2027 預估 PE 寫成「本益比約 20 倍」,而現在是 36.6 倍、位階 90%)。
  測試 ⑫d 長度上限 3,800 → **6,500**。
- 🚨 淨利率:`fin_slice.mjs` 與前端 `_rpFinParQ` **同一條規則**判疑似面額變更 → 那一季起 nm/ni/roe4 = null + `nm_error`;有官方 `ni` 欄時用官方值並由 `ni ÷ eps` 反推股數證實(旗標 `par_chg`)。
  ⚠️ gh-pages 上的舊切片要等使用者手動跑「📦 財報三表深歷史回算」才會換新;在那之前靠前端那道雙保險(測試 §f10 用舊形狀的 fixture 釘住)。
- 📋 **V76.2.1 深連結帶不進去**(使用者實測:點開 Perplexity 輸入框是空的):提示詞 2,400 字 → `encodeURIComponent` 後 **16,000 字元**,
  iOS 用 universal link 交棒給 App 時那串 query **帶不過去**。⛔ 這不是程式壞掉,⛔ 也不可「把提示詞縮短到塞得進網址」(那等於把 22 節砍光)。
  ⭐ 修法:**開之前先複製**。`app._copyText(t)` 是報告頁唯一那份複製工具,**必須同步**(⛔ 不可 `async`/`await` ——
  await 之後 `<a>.click()` 會被瀏覽器當成非使用者操作擋掉),且 `execCommand` 要排在 clipboard API **之前**(手勢裡一定有授權)。
  複製失敗⛔ 不可靜默 → `_reportPromptManual` 跳手動選取視窗。測試 ⑫f~⑫i 釘住(含「順序反過來 / 改成 async / 靜默失敗」三種注入)。
- 💳 **V76.2.2 §13 融資壓力**:`_marginCallState` 只看**近 60 個交易日**(`MARGIN_WIN`)——
  融資是短期部位,⛔ 不可吃整條 K 線(實測 2327 有 795 根:成本 331→追繳線 259→距現價 **52%**,`level` 永遠 safe = 常數,
  同 V71.1.6 外資期貨那個教訓;改 60 日後成本 683→追繳線 533→**距現價 2%**)。
  ⛔ **市場別不明⛔ 不可整格不給** —— 用上市六成推並**標明**(陷阱 #28:「資料源沒有分類」被當成「沒有資料」,
  訊息還講錯原因)。市場別來自 `data/stock_names.json` **第三欄**(`miner.py` 那個迴圈本來就分 TWSE/TPEx 兩個來源,零額外 API)。
- 📐 **V76.2.2 貼上區版面**:已經貼過之後,輸入框 / 按鈕 / 操作說明**全部收進 `⚙️ 換一份` 摺疊**(第一眼 655 → 334 字);
  卡頭已有「基準日」→ 內文⛔ 不再重複;AI 段落開頭的破折號剝掉。測試 📐a~c / 💳a~d。
- 🔬 **`rwd_audit.mjs` 注入版面 shim**(V76.2.2):沙箱沒有 Tailwind → 祖先鏈整個塌掉(報告頁卡片只有 **166px**,
  正式環境 373px)→ 量到的「沒有溢出」是假的。shim 只補 box-sizing / padding / width / flex / 換行 / `text-[Npx]`,
  ⛔ 不假裝補齊 Tailwind(`max-w-*` / `md:` / `hidden` / 顏色仍沒補,要真機看)。
  ⚠️ **`box-sizing:border-box` 那一條最關鍵** —— 少了它,`w-full` + `p-2` 的 textarea 會被誤報成「超出父層 5px」。
- 🔢 **V76.2.3 § 編號是 1~20**(⛔ 砍掉舊的 §19 因子評分 / §20 星等評等;舊 §21 觀察清單 → §19、舊 §22 筆記 → §20)。
  ⚠️ 「第一眼留哪兩節」⛔ **不可寫死編號** —— 用「第一節 + **最後一節**」,使用者手上那份舊的 22 節報告才顯示得對。
  ⭐ **⚡ 快速判別表按 § 由小到大排**(它是**對照表**);⚠️ 各節詳細卡的順序**不動**(V75.3.2 刻意的決策順序:結論最先)。
- 📊 **`app._reportFacts(sym)` = 提示詞數字的唯一一份**(研究提示詞與做圖提示詞共用,⛔ 不組第二份)。
  🚨 **任何一格印「—」,外部 AI 就會自己算** —— 實測使用者那張圖季線寫 707.4 / 半年線 594.5,本站真值 704.4 / 606.9。
  → ① 能算的一律補算(`_rpMaLevels` 加了 K 線 fallback:`indicators` 是 worker 算的,切到報告頁時常常還沒好)
     ② 提示詞明寫「看到『—』⛔ 不可以自己算」③ **出場線 ≠ 融資追繳線**(AI 拿後者當前者用過)。
  ⛔ 新增欄位一律加進 `_reportFacts`,⛔ 不在 `_reportPrompt` 裡 inline。
- 🎨 **`_reportChartPrompt(sym)` 做圖提示詞**:🚨 **台股紅漲綠跌寫死在提示詞裡**,而且⛔ **紅綠只准表示漲跌、
  絕對不可表示好壞/安全風險** —— 使用者那張實測圖「基本面亮點=綠、評價面警訊=紅」跟同圖上「收盤 −4.90% 用綠」直接打架。
  風險一律 ✅⚠️⛔🚨 圖示;⛔ 不畫「綠牛 vs 紅熊」(歐美配色,台股相反)。
- 🖼️ **AI 圖存 IndexedDB**(`rpImg_{sym}`,壓成最寬 1400px / JPEG 0.82)。⛔ **不可存 localStorage**(一張 150~400KB,全站才 ~5MB)。
  🚨 **`idb.prune()` 的規則是「ts 超過 7 天**或沒有 ts**就刪」→ 已開 `rpImg_` 白名單**;
  ⛔ 新增任何「使用者自己存的東西」進那個 store,都要在 prune 開白名單,否則 7 天後自己消失。
  ⚠️ 圖排在 `rpAct`(本站結論)**之後** —— 外部 AI 畫的⛔ 不可壓在本站自己的結論上面(主結論最大)。
  鐵線同 §20 筆記:⛔ 不進 `_ovDecide` / 計分 / 「📋 複製整份報告」。
- 🗑️ **提示詞入口全 App 只留一個**(§20 那張卡)—— 重點數字卡那顆「🔎 問 Perplexity 產業面」是**同一支函式**,已刪。
- 測試 `scripts/test_report.mjs` 📝a~g / ⑫f~⑫i / 🎨a~d / 🖼️a~e / 🔢a / 🗑️a / 📐a~c / 💳a~d / 📱4 / §f9~§f10(fixture 是使用者那份報告的**真實形狀**);`scripts/test_fin_slice.mjs` ③d~③i / ⑦f。
  四種注入(拿掉月營收那條 / mark 換紅 / 拿掉面額守門 / 貼上區不排除在複製之外)都叫得出來。

### 📄 V76.1.8 報告頁 = 「法人級 22 節提示詞」的骨架 —— ⭐ 一頁兩層,⛔ 不是拿提示詞取代報告
使用者貼了一份 22 節的研究提示詞問「能不能取代報告、用真實數據填、查不到才用 AI」。
⭐ **先量**:22 節裡 ✅ 8 節本站已有、⚠️ 9 節有一半、❌ 5 節(3 節質化只能外包、**2 節刻意不做**)。
→ 拿它當**骨架**:每一節標題帶 **§ 編號**(使用者拿外部 AI 的產出來對照時一眼對得上),
補 4 節本站算得出來卻沒放進報告頁的純公式,質化 5 節加進 🔎 提示詞(回來的文字只能貼成 §22 筆記)。

| 層 | 內容 | 函式 |
|---|---|---|
| ⚡ 第一層 快速判別表 | 11 個面向,每列 = 事實 / 本站實測怎麼說 / **來源標籤**(✅ 真實資料 🧮 純公式 🔎 要自己查 ⛔ 本站沒有 🚫 實測打掉) | `_rpQuickHtml` —— ⛔ **零現算**,只讀 `_ovDecide` 結果 / `_keyLevels` / `_upsideStash` / `_rpLast` / `indicators`(測試 §z1 釘住) |
| 🧱 §11・§16・§17 | 價格牆表(由高到低:套牢區 / 均線 / 密集區 / 你的出場線 / 融資追繳線,距現價 % + 一張差多少元)+ 價格位置圖(**整段轉述 `_priceRulerHtml()`**,§w3 逐字比對)+ 下跌壓力測試 10/20/30/40%(`_netPL`,有部位算你的張數,途中撞到哪幾道牆) | `_rpWallsHtml` |
| 🧮 §14 | 敏感度:獲利 ±20% × P25/中位/P75 = 9 個對照價;⛔ **沒有機率欄**(沒有母體可估,硬給的是編的) | `_rpSensitivityHtml` |
| 📦 §4 | 財報三表切片:存貨天數 / 自由現金流 / 資本支出 / ROE / 淨利率 / 股本 + **兩道旗標** ①「EPS 崩但營收毛利沒掉」(= 業外/一次性)②「股本一季變 >20%」 | `_rpFinDeepHtml` 讀 `data/fin/{sym}.json` |
| 🗓️ §12・§21 | 財報法定日 / 月營收日 / 除息日(`dividends.json`,以前只有 pro.html 讀)/ 法說會(沒抓到就誠實 + 🔎);只講「波動大」⛔ 不講方向 | `_rpEventsHtml` |

⛔ **刻意不做並寫在畫面上**:§19 因子總分、§20 ★ 評等(陷阱 #38 憑空權重;V74.2.9 AI 五級無預測力)、
§14 三情境機率、§5/§6 市場預期與 EPS 上修下修(台股沒有免費共識 → 「本站沒有」)。
🔄 **法人真的在看、提示詞沒寫的那條**:循環股(`industry_pe.json` 的 `is_cyclical`)獲利頂峰時本益比最低 → 估值節加一行「位階要反著讀」。

#### 📦 fin_deep 接前端的做法(⛔ 不動 daily_miner)
- `fin_deep/fin_deep.json` **7.8 MB** ⛔ 不可整檔給手機讀 → `scripts/fin_slice.mjs` 切成每檔 `data/fin/{sym}.json`(1~2 KB)。
- 🚨 FinMind 三表**混的**:損益表(rev/cogs/eps)單季、現金流量表(capex/dep/ocf)**累計** → 切片時用
  `lib_fundamentals.mjs` 的 `detectCumulative` / `quarterValue` 還原成單季(從 `doi_probe` 搬進去共用,⛔ 不複製第二份),檔內標 `cum_fixed`。
- `fin_backfill.yml` 新步驟「✂️ 每檔切片 → 推 **data 分支**」+ `slice_only` 輸入(1 分鐘、不吃額度)。
  ⭐ 推 data 分支就會被 daily_miner 的 `git archive origin/data` 底層 + 🛟 撿回自動帶上 gh-pages(同 tick_flow「也推 data 分支」)。
  測試 `scripts/test_fin_relay.py`(開真的 git repo 實跑 yaml 那段;對照組:只推 fin_deep 分支 → 鋪底層看不到)、`scripts/test_fin_slice.mjs`(累計還原 / DOI / 兩道旗標 / 注入「把累計當單季」必須紅)。
- ⚠️ 第一次要手動跑 `📦 財報三表深歷史回算` workflow 並把 `slice_only` 設 **1**,切片才會出現;之後每季回算時自動切。

#### 🚨🚨 這次我自己犯的推論錯誤 —— **而且改口那一次也是錯的**(V76.2.0 更正,要記住)
國巨 2025Q3 季 EPS 9.74 → **3.10**、營收 ↑ → 我第一版推論「疑似分割/股本變動」;
查 `fin_deep` 的 `cap` 欄「那一季股本一毛沒變」→ V76.1.8 改口成「**真因是業外不是股本**,淨利率 15.4% → 4.9%」。
🚨 **V76.2.0 查證:改口那一版也是錯的。真因是「面額變更」(10 元 → 2.5 元)**:股本(元)一毛不變、**股數 ×4**、EPS ÷4 —— 淨利其實**上升**。
而「淨利率 4.9%」是 `fin_slice.mjs` 用 `EPS × 股本÷10` 推的(**寫死面額 10**)→ 本站自己算錯 4 倍,再拿算錯的數字當「業外」的證據。
⭐⭐ **通用鐵則:「股本(元)沒變」⛔ 不等於「股數沒變」** —— 面額變更正是股本不變、股數變的情況。
任何用 `cap / 10` 推股數的地方(fin_slice / 前端 `_rpFinParQ`)都要有守門:EPS 掉 ≥50% + 營收毛利沒掉 + 股本沒動 → 那一季起淨利率/ROE **不給數字**並寫原因(陷阱 #22);
真正的修法是抓官方「稅後淨利」欄(`fin_backfill.py` V76.2.0 起 `ni: IncomeAfterTaxes`,下一次回算後生效)。
⭐ 通用(上一版寫的仍成立,只是要加一句):**有欄位可以直接查的事,⛔ 不可從別的數字推論** —— **但要先確認那個欄位真的能回答那個問題**(`cap` 回答的是「股本金額」,不是「股數」)。

#### 提示詞本身的檢視結論(給使用者的,寫在 `docs/DECISIONS.md`)
§10 分點集中度/主力成本、§15 PE 低=便宜、§11 跌破月線、§10 大戶↑散戶↓、§19/§20 評分、§14 機率、§12 事件方向 ——
全部是本站**已實測打掉**的(chips_deep / pe_probe / ma20_probe / tdcc_probe / 陷阱 #38 / calendar_stock_probe),
畫面上一律標 🚫 或只做事實描述。

### 🔕 V76.1.7 ⚠️⚠️ 上面那條「看空一律不打折」**只適用於「畫面上的計分」,⛔ 不適用於「主動提醒」**
使用者 2026-09-12 明示:「我只想提醒有用資訊,**如果不準就不用提醒**」,並在我把代價講明之後
(我直接問他「風險類也要套同一把尺嗎?這會推翻你以前定的鐵則」)仍選 **「風險類也一樣」**。
→ **提醒(彈窗 / toast / 系統通知)這一層,多空兩邊都要過實測門檻。**

⭐ **唯一守門 `app._alertWorthIt(det, sigTitle, tone)`** —— 一個原則、**兩把尺**:
| 訊號自稱 | 過關條件 | 為什麼 |
|---|---|---|
| 多方 `tone==='bull'` | 🔁 V79.4.5 `_sigProven(e)` = A/B 級 且 `xr > _sigCost()`(扣來回成本還比同一天平均股票賺)且 `n ≥ _wrEnough()` | 買了要**真的賺得到**(⛔ 舊版的 `exp > 0` 沒扣成本)|
| 空方/警示 `bear`/`warn` | `e10 < 0` 且 `p ≤ 0.25` | 警告之後要**真的比大盤差**,而且不是雜訊 |
| 查不到成績 | ⛔ 一律擋 | 未驗證 ≠ 有效 |

⛔⛔ **兩把尺不可互換**(最容易被「順手統一」):拿多方的尺量空方會全滅;拿空方的尺量多方
會放行「高勝率做多買點」「多頭回檔等買點」這種**實測方向相反的買訊**當成警告。所以 `tone` 一定要傳。

⛔⛔ **「你的部位 / 你自己設的線」⛔ 不可以走這支**:庫存鐵血停損・停損到了・停利條件到了・
第 2 擊跌破你設的出場線・到價提醒・13:25 平倉倒數・官方處置股名單(事實不是預測)。
那不是「訊號準不準」,是**你的錢到了你自己設的點** —— 拿統計去擋它等於幫使用者改他的停損。

⭐ **被擋下來的⛔ 不可消失** → 走 `app._alertQuiet()`(只寫 🔔 通知歷史 + 點亮紅點),
個股頁 K線分頁照顯。使用者要的是**不被打擾**,不是查不到。

🔕 **三類「方法本身已被實測打掉」→ 整組只記不吵**(⛔ 別再接回主動推):
🔮 明日劇本(V73.2.2「不能當閘門」)・🧙 跟單分點(`broker_habit`/`broker_ally`/`broker_ind` 三支全滅)・
🎯 主打型態觸發(`perstock_playbook_probe` 實測**名單穩定度 ≈ 隨機**)・⚡ 隔日沖盤點(`dtflip` 碰得到≠賺得到)。

📊 實測:開 App 14 秒 **大視窗 2→0 ・toast 7→3 ・`_fireAlert` 9→3**(`scripts/popup_audit.mjs`)。
🔁 逃生門:設定中心 `alertStrict`(預設**開**)關掉 = 回舊行為。
🧪 測試 `scripts/test_alertgate.mjs`(⓪ 兩把尺各自的名單 / ⓒ 不可互換 / ⓓ 未驗證要擋 /
ⓔ 停損停利⛔ 不走守門 / ⓕ 被擋的要進鈴鐺 / ⓖ **使用者截圖那 6 則釘住 5 砍 1 留** / ⓗ `_tagPush` 沒接就紅),
4 種注入全部叫得出來。
⚠️ 它的原始碼斷言**要先剝掉 `//` 註解再比** —— 第一版兩條假失敗都是被**我自己寫的註解**害的
(註解裡引用了要禁止的舊寫法)。

### 🧪 探針登記表 → `docs/PROBES.md`(2026-10-17 搬出去,一個字沒刪)
⭐ **做任何回測 / 探針之前,先 `grep -n 關鍵字 docs/PROBES.md`** —— 每支寫了「回答什麼・何時該重跑・⛔ 別再測」。
新增探針:在 `docs/PROBES.md` 的表加一列(這支回答什麼、何時該重跑、跑法)。`scripts/check_lab_coverage.py` 讀那份比對實測總表。

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

## GitHub 帳號
- 帳號:`xin7355-collab`
- 主要 repo:`StockAI-DB`(此專案)
- 其他:`gdp-dashboard`(保留)、`pro-terminal-v4`(已刪除)
- GitHub Pages 1GB 限制:**2026-07-27 實測 388MB**;V69.9.6 起 inst_cache_stock.json(18.5MB 採礦中介)已移出 gh-pages 改存 data 分支(P3-7),下次 daily_miner 後約 370MB

---

## 🧩 這個專案有哪 5 支 Skill + 1 支代理(2026-09-09)

⛔ **本節只留索引,內文在各自的檔案裡** —— 同「決策紀錄搬去 `docs/`」的理由。
完整說明與「怎麼自己加一支」見 **`.claude/skills/README.md`**。

| 打什麼 | 何時用 | ⛔ 這支不做 |
|---|---|---|
| `/ship` | 要 push / 上線 / 發佈 / bump | 改功能本身、開 PR |
| `/probe` | 「這個策略有沒有用」「幫我回測」 | 改 App 判定邏輯、動採礦 |
| `/audit` | 跑資料體檢 / 巡邏 / 找 bug | 把誤報也修掉、放寬斷言 |
| `/mining` | 採礦沒跑 / 資料停在舊日期 / workflow 全綠卻沒東西 | 改 workflow(那要先問使用者) |
| `/uicard` | 加卡片 / 改版面 / 改文案 | 改判定門檻(要先回測) |
| 代理 `scout` | 同時掃前端/採礦/workflow 找 bug | 改任何檔案(它只回清單) |

📦 **另有 7 支外部技能**(skl 技能庫裝的:`senior-data-scientist` / `senior-prompt-engineer` / `app-guardrails-audit` / `llm-cost-optimizer` / `strict-api` / `dependency-auditor` / `context-budget`;2026-10-17 移除 `sql-database-assistant`)——
⛔ 不要直接改內容(update 會蓋回去),說明與更新指令見 `.claude/skills/README.md` 最後一節。

⛔ **三條不可違反的設計**(`scripts/test_skills.mjs` 釘住):
- ⛔ **Skill 不可複製 CLAUDE.md 的內容** —— 本檔每個 session 都完整載入,複製 = 兩份真相。
  Skill 只寫「步驟 + 指令 + **指向本檔哪一節**」,一支控制在 60~120 行。
- ⛔ **不可新增跟 `.claude/commands/finmind.md` 功能重疊的 Skill** —— 描述太像會互相搶
  (同「⛔ 不要再新增第二支只部署前端的 workflow」)。
- ⛔ **`.claude/` 在 `.gitignore` 裡** → 新增 Skill 一律 `git add -f`,否則**只活在你這台機器上**。

---

## 📚 完整決策紀錄在哪(⭐ 本檔只留「現行規則」)

CLAUDE.md 原本 10,737 行 / 50.7 萬字元(約 38~50 萬 token)→ **超過 context window**,
每個 session 一開場就把額度吃光,講沒幾句就 `Prompt is too long`。

→ 2026-09-09 把 **211 個章節 / 9,035 行**搬進 `docs/`,**一個字都沒刪**:

| 檔案 | 內容 | 章節數 |
|---|---|---|
| `docs/DECISIONS.md` | 版本歷程・回測結論・踩過的坑 | 188 |
| `docs/EXTERNAL_REVIEWS.md` | 外部參考資料評估紀錄 ①~㉕ | 24 |
| `docs/INDEX.md` | 上面兩份的章節索引(2026-10-17 搬來) | — |
| `docs/PROBES.md` | 探針登記表(2026-10-17 搬來) | — |

⛔ **本檔留的是「下次寫程式會用到的規則」**:鐵律・四驗證・40 條陷阱清單・部署規則・
UI 規範・使用者偏好・資料體檢・連動檢查清單(探針登記表與決策索引 2026-10-17 搬去 `docs/PROBES.md` / `docs/INDEX.md`)。

⭐ **要查「這題以前測過沒 / 為什麼當初這樣決定」→ 去 `docs/` 那兩個檔 grep**。
⚠️ 新增決策紀錄一律寫進 `docs/DECISIONS.md`,⛔ 不要再往 CLAUDE.md 累加
(那正是它漲到 50 萬字元的原因)。

### ⛔⛔ 鐵則:`CLAUDE.md` **不可以加進 `.gitignore`,也不可以移出版控**
(2026-09-11 評估紀錄㉕:有外部建議叫我們這樣做,照做會直接弄壞整個工作流)

🚨 **Claude Code on the web 每個 session 是靠 repo 裡的這個檔載入專案規則的** ——
移出版控 = **四驗證、41 條陷阱、燈號鐵則、部署規則、連動檢查清單當場全部消失**。

⛔ 那個建議的理由(「GitHub Pages 的儲存庫是公開的,不排除的話架構筆記會公開」)**三層都錯**:
- **`.gitignore` 不會讓已經 push 出去的東西消失**(還在 git 歷史裡)→ 目的根本沒達到。
- **歸因錯**:公開的原因是 **repo 本身是 public**,跟 Pages 無關;而且
  **main 分支的內容從來不會被部署到網站**(`deploy_pages.yml` 只覆蓋 `index.html` + `sw.js`)。
- ⭐⭐ **顧慮本身是假的**:所有判定邏輯與回測成績(`_SIGNAL_EDGE` / `_STREAK_EDGE` /
  `_DECK_TRACK49` / `_SCR_EDGE`…)**本來就嵌在公開的 `index.html` 裡**,那份才是真的掛在網站上。
  藏 `CLAUDE.md` = **假隱私、真代價**。

✅ 真正要守的是**金鑰**,而這條早就做對了(⛔ key 絕不硬編,全在 GitHub Secrets)。
⛔ 同理**不新增 `PROGRESS.md`** —— 本檔(現行規則)+ `docs/DECISIONS.md`(含待辦盤點)
已經是兩個地方,再開第三個就是使用者最討厭的「邏輯不打架」的反面。進度寫進 `docs/DECISIONS.md`。

---

### 📇 決策紀錄索引 → `docs/INDEX.md`(2026-10-17 搬出去,一個字沒刪)
⭐ 要查「這題以前做過 / 測過沒」→ `grep -n 關鍵字 docs/INDEX.md`(或直接 grep `docs/DECISIONS.md`、`docs/EXTERNAL_REVIEWS.md`)。
新增決策紀錄:`docs/DECISIONS.md` 加一節 + `docs/INDEX.md` 最上面補一行 —— ⛔ 不再往本檔加索引行(它曾把本檔撐到 602KB)。
