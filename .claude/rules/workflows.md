---
paths:
  - ".github/workflows/**"
  - "cloud-worker/**"
  - "scripts/intraday_window.py"
  - "scripts/miner_superseded.py"
  - "scripts/art_merge.py"
  - "alert_system.py"
  - "live_snapshot_miner.py"
  - "tick_flow_miner.py"
---
# GitHub Actions 工作流 / 排程配額 / 盤中迴圈 / Worker 叫醒

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 36~214 行 -->
## GitHub Actions Workflow

### 三支 workflow 分工（重要）
| Workflow | 觸發 | 用途 | 生效時間 |
|----------|------|------|----------|
| `daily_miner.yml` | cron / 手動 / push `miner.py`·`macro_miner.py`·`radar_miner.py`·`chief_ai_batch.py`·`daily_miner.yml` | 完整採礦 + 部署 gh-pages/data | 30-60 分 |
| `deploy_pages.yml` | push `index.html` / `sw.js` 到 main / 手動 | **只部署 index.html + sw.js 到 gh-pages,不採礦** | **~1 分鐘** |
| `macro_probe.yml` | (自身用途) | 總經探針 | — |
| `weekly_backtest.yml` | `workflow_run` ← daily_miner(**只在週五**那一輪真的跑;手動 force=true)/ ⛔ 無 cron | 🔁 **每週自動回測**:`signal_backtest`(135 個 K 線訊號,最近 3 年)+ `portfolio_backtest`(決策台;🧾 **V79.5.1 起全市場 + 照 App 前一晚名單買**:交易快取 4 片 → 名單前 60 筆 → `list_trig` TOPN=60 → 兩趟 🅿️ 停 0050 / 💵 錢放現金(🟥 **V82.3.9 起兩趟都 `NOLOCK=1`**:訊號那天收盤鎖漲停 = 買不到,同作戰室看板 `geneNolock`;⛔ 放 step env,`test_backtest_edge ②m / ③i2`),任何一段失敗紅燈;`build_backtest_edge` 守門:名單要接上判觸發、可能不準 ≤ max(5, 1%) 晚、🅿️ 跟嵌入版比用「股票 + 0050」合計,`③i / ②j / ②l`)→ `data/backtest_edge.json`(推 gh-pages + data)。🔁 **V79.4.5 起 App 一律讀內嵌的 16 年 `_SIGNAL_EDGE`**(使用者選的),產物只在實驗室模式當「最近幾年」參考(`_btEdgeNote`);成績單設定 = **App 現行預設**(= `_DECK_TRACK49`:🅿️ 85/60・chand2・MAXD 20・空頭照買・照平均排・斷崖・1,200 天・個股破線不買・停 0050・收盤成交・股利 + 二代健保,`test_backtest_edge ③h` 跨檔比對 —— ⚠️ 改 App 預設要一起改);🔓 **整支 ⛔ 不拿共用部署鎖 `gh-pages-push`**(V79.5.0 先拿掉回測 job 的:以前寫在 workflow 層級 → 每天跟 playbook_scan 同一秒進鎖、擠掉排隊中的明日清單;2026-10-23 部署 job 也拿掉:#57 排在鎖後面被 news_express 擠掉 → 網站停在上一週 → 改自己的鎖 `weekly-backtest-deploy` + 5 次重試(重抓 → 重放產物 → 再推),`test_backtest_edge ③c / ③c3`);⛔ **只標示不換預設**(V75.0.9 五條件由人判);空過守門 訊號 n / 成績單筆數 < 上一版 80% 不推,**cfg 或訊號方法換了那一次重新起算**(⛔ 但絕對下限 `FLOOR` 照樣要過)。🚨 9/21~10/20 每週都被擋 = 守門拿舊引擎的 1,233 筆比(同設定現在 926)。測試 `scripts/test_backtest_edge.mjs` | ~40 分(組合回測約 20 分) |

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
- 🧟 **2026-10-23 起:被新的一輪取代的那輪 ⛔ 不部署** —— 部署 job 是 `always()`(某個節點跑滿 90 分仍要部署),以前連「被取代」也照跑 26 分、佔著共用部署鎖,新的那輪只能排隊(10/23 #640 → #641 等了 27 分)。→ 部署前的 `gate` job 問 GitHub 同分支有沒有編號比較大、還沒結束的 run(`scripts/miner_superseded.py`),有才跳過;問不到一律照舊部署;自己按 Cancel(沒有新的一輪)照舊部署已採到的。⛔ 部署條件寫成 `!= '0'`(fail-open),⛔ 改成 `== '1'`。測試 `test_deploy_relay ⑧`
- deploy_pages.yml 1 分鐘部署不會被新 push cancel(`cancel-in-progress: false`),完整性優先
- 🚨 **2026-11-21 推採礦檔撞上還在跑的排程那輪**(V82.6.3 實例):push 帶起的新一輪會把排程那輪標成 `cancelled` —— 資料不會少(新的一輪整個重跑;那次排程那輪的部署 job 已經在跑,`always()` 照樣推完),但**跟車的全部看到 cancelled 就跳過**:`weekly_backtest`(只跟週五排程那輪 → 那一週就沒回測)、`kbar5`(只跟排程那輪 → 那天沒有 5 分 K)、`playbook_scan` 第二輪。⛔ 推 daily_miner push paths 裡的檔(`miner.py` / `radar_miner.py` / `daily_miner.yml`…)之前先 `actions_list` 看有沒有 in_progress 的**排程** daily_miner,有就等它跑完再推;撞到了 → 新的一輪跑完後手動派:`weekly_backtest`(force=true)、`kbar5`(週末派 = 用週五的量排行)、`playbook_scan`

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
⚠️ Cloudflare 免費版 cron 上限 5 個而**已用滿** → 新功能一律掛在既有 handler 裡,⛔ 別想加第 6 個。🧊 V82.7.1:要多一個時間點就在既有那條**加分鐘**(一條排程多個分鐘 ≠ 第 6 條,同 scan 那條)—— `CRON.pre = '0,10 0 * * MON-FRI'`:08:00 那輪換倉 / 大跌 / 叫醒總經 / 作戰清單 / 盤中快照,08:10 那輪**只**發盤前簡報(`_preBriefSlot` 看 `scheduledTime` 的分鐘;⛔ 08:10 重跑那幾件 = 👑 推兩次、再叫一次總經、砍掉盤中主迴圈,`test_worker_cron ⑤c ⑥c2`)。
🗓️ **Worker V22.7(2026-10-23)星期欄一律寫 `MON-FRI`,⛔ 不可寫數字** —— Cloudflare 的星期 1 = 週日(⛔ 跟 GitHub 的 0 = 週日不一樣),以前 `1-5` = 週日~週四 → **每個星期五整天沒跑**(盤前簡報 / 盤中提醒 / 叫醒採礦全停)、週日白跑。排程字串只在 `wrangler.toml` + `worker.js` 的 `CRON` 兩處(一字不差,`event.cron` 就是原文);`scheduled()` 台北週末一律不做。測試 `scripts/test_worker_cron.mjs`(照 Cloudflare 規則算星期,舊 `1-5` 必判錯)。
⚠️ 需要使用者設 `GH_DISPATCH_TOKEN`(步驟在 `cloud-worker/README.md`);沒設就整段跳過。
⏰ **V79.1.9 daily_miner 也由 worker 台北 17:00 叫醒**(`minerKick`,event `daily-miner`,只在 gh-pages screener 還不是今天才發);`playbook_scan` 跟 schedule / repository_dispatch / workflow_dispatch 那輪(⛔ push 不跟)。測試 `scripts/test_miner_kick.mjs`。
📶 **V79.4.8 永豐帳號每天流量上限 524 MB(同一個帳號的 `auto_trade.py` 也吃這個額度)**:10/21 13:03 就用完 —— 逐筆內外盤每 10 分鐘把前 80 檔「開盤到現在的全部逐筆」重抓(每拍 3.5 → 26 MB,一天 449 MB = 86%)→ 13:30 收盤那拍快照與逐筆都沒有。→ 逐筆改**只抓上一拍之後的**(`tick_flow_miner.collect_ticks`:狀態存 /tmp、起點往前多抓 1 秒再用時間戳去重、每拍輪流抽一檔整天重抓對帳、對不上當天改回整天重抓;`TICK_INCR=0` 逃生門)+ 快照 timeout 300 → **345**(worker 08:00 叫醒要撐到 13:31:30)。⛔ 新增任何會用 Shioaji 的盤中採礦之前,先算一天要吃多少流量(log 每拍都印 `📶 今日流量`)。測試 `scripts/test_tick_incr.py` / `test_intraday_loop ⑦g`。
🌅 **V79.3.4 macro_cron 也由 worker 台北 08:00 叫醒**(`macroKick`,event `macro-cron`,只在 gh-pages `macro_risk.updated` 還早於最近一次美股收盤(紐約 16:00 = 夏令 20:00 / 冬令 21:00 UTC)才發;🧊 V82.7.1 起**今天早上那份還沒凍結**(`premktFrozen` 是 null)也發 —— 夏令 04:00~04:59 跑的那輪算收盤後、但在 05:00 寫入時間之前 → 以前判 fresh 不叫、整天沒凍結,`test_macro_kick ①i~①k`)+ 跟車多掛 `news_premarket`(07:46~10:40 飄,備援)—— 以前最後一輪都在台北 20:30~02:30,盤前體檢永遠是美股盤中的數字。前端 `_macroPreUsClose` 灰字說明(🌙 V82.0.8 講到「收盤後 12 小時」與「收盤後下一個台股開盤 + 7 小時」比較晚的那個 → 週五美股收盤前抓的那份講到週一 16:00;週末那句也看它,⛔ 把盤中數字寫成「上週五收盤」;停在盤前頁 08:05 後 `_premktRefreshTick` 每 5 分鐘補抓);`_lastUsCloseMs` index / worker 同一條規則。測試 `scripts/test_macro_kick.mjs`。
📲 **V82.0.5 Telegram 🔥 作戰清單 / 尾盤買點也改由 worker 叫醒**(`tgKick`,event `tg-list` 台北 08:00「今天的作戰清單」/ `tg-eod` 13:15「尾盤買點」→ `tg_push.yml` → `alert_system.py` playbook_am / eod)—— 以前走 `telegram_alert.yml` 排程:13:20 那輪最近 10 個交易日最早台北 18:35 才跑(一次都沒在收盤前送到)、20:00 那輪凌晨 1~5 點才到。擁有者選 👑 → 不派(選 👑 只講 👑);休市 / 週末不派;每天每種一次。`telegram_alert.yml` 排程那兩輪改 `ALERT_MODE=none`(⛔ 刪 cron:它是 macro_cron / news_express 的 host)。測試 `scripts/test_tg_kick.mjs` / `test_tgalert.py`。

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


