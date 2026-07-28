# 🔧 StockAI-DB 全盤體檢與優化計畫

> 產出日期:2026-07-27(App 版本 V69.8.3)
> 方法:5 個平行代理掃描(前端死碼 / 資料流對帳 / 採礦效率 / UI 卡片 / 效能)+ **逐條人工讀原始碼驗證**
> ⚠️ 代理 findings 約 1/3 是誤報,本文件只保留**已人工驗證通過**的項目;誤報另列於文末留紀錄。
>
> **進度**:✅ P0 全部 8 條已於 V69.8.4 修復;✅ P1 七條(P1-1/2/3/5/6/7/8)已修復(V69.8.5-6),剩 P1-4(圖表局部更新,較大重構);✅ P3 五條+TDCC 去重已於 V69.8.6 修復(剩當沖四合一/company_profile/P3-7 gh-pages 瘦身)。
> **接手方式**:從 P0 開始,一次做一個 Batch,每個 Batch 跑完四驗證再 push。做完一項就在下面打勾。

---

## 📊 現況量化(實測,非估計)

| 項目 | 數字 | 備註 |
|------|------|------|
| `index.html` | 40,326 行 / 3.36 MB | gzip 後 **1.01 MB**(手機每次冷啟下載量) |
| 其中第 18 行(版本註解) | **93,540 bytes** | 單行!gzip 貢獻 45 KB |
| 其中第 12 行(icon base64) | **22,316 bytes** | gzip 貢獻 19 KB |
| 主 script 註解+縮排 | 785,806 bytes = **26.1%** | minify 可省 gzip 160 KB |
| body DOM | 2,035 標籤 / 642 id / 308 inline onclick | 8 個分頁全部一次建好 |
| Python 檔 | 31 支 / 19,042 行 | |
| GitHub Actions workflow | 28 支 | |
| gh-pages 部署體積 | **388 MB** | CLAUDE.md 寫「約 100MB」已過期;1GB 上限 |
| 啟動時 HTTP 請求 | **≥35 個** | |
| 常駐 setInterval | ≥11 個 | `setInterval` 16 處 vs `clearInterval` 7 處 |

---

## 🔴 P0 — 正在壞、使用者看得到(先修這些)

### [x] P0-1 `bubble_warning.json` 被兩支程式用不同 schema 互相覆寫 → 泡沫預警卡永遠空白
- **證據(已驗)**:線上檔實際內容只有 3 個中文 key
  `["大盤融資餘額_億元", "融資槓桿水位狀態", "警報說明"]`
  但 `miner.py:3685 build_bubble_warning()` 寫的是富 schema
  `{broker_heat, junk_count, margin_leverage, kline_status}`
- **根因**:`macro_miner.py:2146` 在 `__main__` **無條件**呼叫 `generate_bubble_warning()`,整檔覆寫。
  且執行順序讓它被蓋兩次:chips job 內 `miner.py` 呼叫 macro_miner 蓋一次 → deploy job 並行再跑 macro_miner 蓋第二次。
- **症狀**:🫧 Bubble Burst Sniffer 四格永遠是 HTML 佔位字;盤前 AI 報告那四行永遠 `--`。
- **修法**:移除 `macro_miner.py:2146` 的 `generate_bubble_warning()` 呼叫(融資水位 miner.py 的 `margin_leverage` 已更完整,含絕對值)。

### [x] P0-2 `insider.json` 完全不存在 → 董監質押卡 + 我新做的「持股身份分布」董監段全空
- **證據(已驗)**:`git ls-tree origin/gh-pages | grep insider` → **空**;`origin/data` → **空**。兩個分支都沒有。
- **根因**:`insider_cron.yml:58-72` 只 `git push origin gh-pages`,**沒推 data 分支**。
  而 daily_miner deploy 是 `git archive origin/data` + orphan force-push → 每輪把它抹掉。
- **前端影響點**:`index.html:4178 / 20175 / 20350 / 30336`(4 處)+ V69.8.1 新做的持股身份分布「董監」色帶。
- **修法**:比照 `theme_news.yml:104-106` / `tdcc_sweep.yml:103-104` 的雙分支樣板,加 `deploy_branch data`。
- **同類**:`tick_flow.yml:55-68` 也只推 gh-pages → 盤後逐筆內外盤卡 404,建議一併補。

### [x] P0-3 `this._tdccCache` 被兩個不同 shape 的檔案搶用 → 集保相關卡「忽有忽無」
- **證據(已驗)**:
  - `index.html:11618` `this._tdccCache = tdcc`(來源 `data/tdcc.json`,shape = `{updated,date,data:{sym:…}}`)
  - `index.html:12954` `this._tdccCache = await r.json()`(來源 `data/tdcc_holders.json`,shape = 扁平 `{sym:{t,n,h}}`)
  - 讀取端兩套:`11373` 用 `.data[sym]`;`12736 / 20182 / 20971 / 35438` 用 `[sym]`
  - `12949` 有 `if (this._tdccCache !== undefined) return;` → **誰先載誰贏**
- **症狀**:同一次開 App,「籌碼乾淨度的千張大戶」與「多空計分卡」必有一個空,取決於先點哪個 tab。
  **直接影響 V69.8.1 新功能**:🐘 大戶連週吃貨、🥧 持股身份分布(兩者都用扁平 shape)。
- **修法**:`_loadTdccHolders` 的快取改名 `this._tdccHoldersCache`,同步改 `12736 / 20182 / 20971 / 35438` 四個讀取點;`_ensureBullBearCaches` 保留 `_tdccCache`。

### [x] P0-4 幽靈欄位 `margin_balance_billion` → 風險分數少算一項、Telegram 融資警報從沒發過
- **證據(已驗)**:`index.html` 讀 1 次、`alert_system.py:220` 讀 1 次,**全 repo 沒有任何程式寫這個 key**。
- **症狀**:① 今日風險分數的融資水位項永遠 +0 分(系統性偏低)② Telegram「🚨 融資爆量警報」上線至今 0 次。
- **修法**:兩處改讀 `bubble.margin_leverage?.total_100m`(**必須在 P0-1 修完後**才有這個欄位)。

### [x] P0-5 `daytrade.json` 採礦永遠跳過(當沖比因子失效)
- **證據(已驗)**:`fetch_daytrade_ratio` 開頭 `if not Path(DB_PATH).exists(): return`,而 `stock_hunter.db` 在 chips job **不存在**(`grep stock_hunter.db daily_miner.yml` = 0;`origin/data` 也沒有)。
- **修法**:不要依賴 SQLite。改讀 `data/{sym}.json` 的 `volume`(已驗證該欄存在,單位=股),data/ 在 chips job 有還原。

### [x] P0-6 `tw_vix` 永遠 null(台指 VIX 沒進風險分數)
- **證據(已驗)**:線上 `macro_risk.json` 的 `tw_vix_error = "no-token"`。
- **根因**:`macro_cron.yml` 的 `run: python macro_miner.py` **完全沒有 `env:` 區塊**,FINMIND_TOKENS 沒傳進去。且它每 4 小時覆寫一次 macro_risk.json,會蓋掉 daily_miner 那次的結果。
- **修法**:`macro_cron.yml` 補 `env: FINMIND_TOKENS: ${{ secrets.FINMIND_TOKENS }}`。

### [x] P0-7 `news_express.yml` concurrency group 拼錯 → 每週約 5 次白工
- **證據(已驗)**:`news_express.yml:24` 是 `gh-pages-deploy`,其他 13 支全是 `gh-pages-push` → **完全沒序列化**。
- **症狀**:cron `0 1,5,9,13 * * 1-5` 的 09:00 UTC 那輪必落在 daily_miner deploy 窗內,非 force push 打不贏 orphan force-push → 整個 job(Groq 翻譯 20+ 篇)白燒。
- **修法**:改成 `group: gh-pages-push`(改一個字串)。

### [x] P0-8 三個新聞檔缺「命中不足保留舊檔」守門(違反專案鐵律)
- **證據(已驗)**:`universal_radar.py:429`(global_news)、`:578`(stock_news)寫檔前**無任何筆數 gate**。
  (`:639` radar_news **有** `if len(keep) < 5` 守門 — 這條是代理誤報,已排除)
- **正確範本**:`theme_news.py:99` 的 `THEME_MIN_HIT`。
- **修法**:兩處各加 `if len(x) < MIN: print('...保留舊檔'); return`。
- **同類缺守門**:`radar_miner.py:1298`(radar_matrix)、`macro_miner.py:2059`(macro_risk)、`momentum_miner.py:290`、`potential_miner.py:283`。

---

## 🟠 P1 — 效能(使用者感覺得到卡)

### [x] P1-1 盤中每 10 秒全量重跑分析 ← **最有感的卡頓,一個字元的修法**
- **證據(已驗)**:`index.html:3974` `this.analyze(this.currentSymbolId, true, true, true)`;
  簽名 `analyze(symCode, skipCheck, forceRefresh, silent)`(22856)→ 第 3 個 `true` = forceRefresh;
  `fetchHistoricalData:10032` `if (!forceRefresh)` → **跳過 IndexedDB 快取**。
- **量化**:間隔 10 秒 × 09:00–13:30 = **每日 1,620 次**全 K 線重抓 + 兩次深拷貝 + `refreshStrategy`(503 行)+ `renderChart`(216 行完整 setOption)。
- **修法**:第 3 參數改 `false`(30 分 TTL 生效),只用 `fetchFugleData` 更新最後一根 K 棒 + 輕量價格 DOM 更新。
- **預期**:盤中主執行緒佔用降 90%+,行動數據用量降一個量級。

### [x] P1-2 首屏白畫面 3–6 秒
- `index.html:40307` `window.onload = () => app.init()` → 要等 3 支 CDN script 全下載完才開始
- `index.html:3846` init 尾端 `await analyze('2330')` 跑完**才**切到庫存頁(3864)— 使用者要看的排最後
- `sw.js:45-60` 對 index.html 是 network-first → 每次開 PWA 都重下載 1.01 MB
- **修法**:① `init` 改綁 `DOMContentLoaded` ② `switchAppTab('inv')` 提到 `analyze` 前,`analyze('2330')` 改背景預熱不 await ③ SW 對 index.html 改 stale-while-revalidate
- **預期**:第二次以後開 App 首屏 3–6 秒 → <0.5 秒

### [x] P1-3 啟動轟出 ≥35 個 HTTP 請求
- `_loadFmx`(12968)一個呼叫展開成 **7 個檔案**;`fetchMacroData` 另有 7 個
- **修法**:非首屏必要的延後到 `requestIdleCallback` 或該分頁真被打開才拉;`_loadFmx` 的 7 檔請後端合併成單一 `fmx_pack.json`

### [x] P1-4 一次切股觸發 2–3 次完整圖表重建 ✅ V71.0.2
- 三條路徑:worker post #1 → `onWorkerMessage` renderChart / 報價升級 post #2 → 再一次 / `_loadExDividends().then()` 第三次
- **實作(修正原計畫:沒做 series 局部 merge)**:
  1. 新增合流器 `_scheduleChart()` — rAF 合併同幀多次呼叫;`renderChart()` 進入時若有排程就取消(手動操作優先、且不會同內容再畫一次)。
     使用者主動操作(勾疊圖 / 切週期 / 十字準星)仍走同步 `renderChart()`,手感不變。
  2. **除權息那次改成有條件**:原本無條件重繪,但多數股票沒有除權息紀錄、或使用者關掉旗標 → 那次是純浪費;
     而且 `_exDivCache` 命中(重訪同一檔)時 `.then` 照樣觸發 → 每次重訪都白畫一張。
     改成 `list.length > 0 && #toggleExDiv:checked` 才排程。
- **為何不做 series 局部 merge**:renderChart 的 option 是整份動態組出來的(markPoint/markLine/visualMap/graphic 隨疊圖選項變),
  局部 merge 要維護「哪些欄位這輪沒變」的對照表,風險遠高於收益;合流 + 條件化已把常見情況從 3 次降到 1 次。
- headless 驗證:同幀 3 呼叫→實跑 1 次 / 排程中手動呼叫→總共 1 次 / 無排程時同步照跑 / rAF flag 清乾淨可再排程。

### [x] P1-5 `_renderChipTimeline` 裸 `echarts.init` 洩漏
- **證據**:`11002`、`11032` 沒有 `getInstanceByDom() ||` 保護(同檔其他 6 處都有);從不 dispose
- **影響**:每次切股在籌碼頁 +2 個殘留 canvas + resize listener;切 20 檔 = 40 個洩漏實例
- **修法**:改成 `echarts.getInstanceByDom(el) || echarts.init(el)`。順帶檢查 `22247`、`29760`

### [x] P1-6 localStorage 淘汰清單幾乎全打不中 → iOS 5MB 爆掉會靜默丟持股
- **證據**:`3690` 的 5 個前綴中,`proTerm_kline_` 實際在 IndexedDB、`proTerm_chips_` 從沒被寫過
- **沒列入的真兇**:`chipTimeline_${sym}`、`brokerChips_v2_${sym}`、`industryReport_${sym}`、`aiCache_stockPredict_${sym}`、`aiCache_dispExit_${sym}`、`gnewsAi_*`、`evImpact_*`(其中數個存的是**渲染好的 HTML 字串**)
- **修法**:補上 7 個前綴 + 改成依 `ts` 由舊到新刪;HTML 快取改存原始 data

### [x] P1-7 IndexedDB `klineCache` 從不清理
- **證據**:`idb.put`(10039)有,但全檔 `idb.delete` / `idb.clear` = **0 處**
- **修法**:啟動時 prune >7 天,或 200 檔 LRU

### [x] P1-8 `_huntAutoTimer` 有 start 沒 stop
- **證據**:`40056` start,但全檔無 `_stopHuntAutoScan`;其他 4 個輪詢在 `switchAppTab` 都有對應 stop
- **修法**:`switchAppTab` 加 `if (tabId !== 'hunt') this._stopHuntAutoScan()`

---

## 🟡 P2 — 瘦身(不改行為,純減法)

### [x] P2-1 第 18 行版本註解 93.5 KB → 搬到 CHANGELOG.md ✅ V69.8.7
- gzip 省 45 KB。歷史已搬 `CHANGELOG.md`,line 18 只留當前版本一行,CLAUDE.md 版本規則已同步改。

### [x] P2-2 第 12 行 icon base64 22.3 KB → 改外部 .png ✅ V69.8.7
- 實作為 .jpg:`apple-touch-icon.jpg`/`icon-192.jpg`/`icon-512.jpg` 實體檔,manifest.json 77KB→982B;deploy_pages.yml + daily_miner.yml 都已加 3 檔搬運;sw.js icon 路徑同步改。**順手修 sw.js TDZ bug**(V69.8.5 的 navigate SWR 分支在 `const reqUrl` 宣告前使用 → 每次導覽 ReferenceError,SWR 從未生效)。

### [x] P2-3 部署產物壓縮 ✅ V71.0.8(**比原估計更好**:gzip 942 KB → 686 KB,省 256 KB)
- 原始檔 3,114 KB → 2,084 KB(**−33.1%**);inline script 2,803 KB → 1,773 KB
- **⛔ 沒照原計畫用「刪掉 `//` 開頭的整行」** — 那是土法且危險:樣板字串裡本來就有以 `//` 開頭的
  中文說明文字,裸刪會把**使用者看得到的文案**一起刪掉,而且**不會有語法錯誤**,壞了看不出來。
  改用 esbuild 真正的 JS parser(`scripts/build_min.mjs`)。
- **兩個踩過的坑(已寫進腳本註解)**:
  1. `keepNames: true` 是**硬需求** — `onclick="app.xxx()"` 是字串,壓縮器看不到,改名就全壞。
  2. `charset: 'utf8'` 是**必要** — esbuild 預設 `'ascii'` 會把全部中文轉成 `\uXXXX`,
     功能相同但**體積反而變大**且完全不可讀。(本專案幾乎全中文;這個坑是被腳本第 3 道驗證抓到的。)
- **4 道驗證**(任一不過 → 部署改用未壓縮原檔,絕不推未驗證產物):可被 `new Function` 解析 /
  體積有變小但沒小於 40% / 關鍵字串(版本號 + 6 個函式名 + 2 段使用者文案)齊全 / HTML 區段未被動到。
- **工作區保護**:產物寫到 `/tmp/index.deploy.html`,**絕不動工作區的 index.html** —
  一旦工作區髒,後面的 `git checkout gh-pages` 會拒絕切換。
- **連帶必改**:gh-pages 的 index.html 從此不會與 main 逐位元組相同 →
  **CLAUDE.md 的 md5 部署驗證法作廢**,已改為比對 `_APP_VERSION`
  (樣式要吃 `: ?['\"]` 兩種,因為壓縮會吃掉空格、單引號換雙引號)。
- 驗證:壓縮版跑完整 smoke_test + 5 支功能回歸測試全 PASS。

### [x] P2-4 刪除確認全死的函式(**已逐一人工驗證只有定義、無呼叫端**)✅ V69.8.8
**已刪 13 函式 ~1,175 行**:runKlineAudit / analyzeSectorRotationAI / renderPeerCompareCard / runIndustryReport / renderKbarScore / renderObvPanel(+2 呼叫點)/ analyzePredictCenter / _firePredictAlert(也無呼叫端,一併刪)/ analyzeMarketAnomaly / updatePredictionUI(+1 呼叫點)/ _snapshotPrediction / _verifyPredictions / _renderPredictionAccuracy(+設定頁 1 呼叫點)。
**修正原計畫**:「預測快照鏈」中 `renderBacktest` 是**活的**(`backtestTableBody` id 存在,L30737 呼叫)→ 保留;實際死鏈是 updatePredictionUI→snapshot→verify→accuracy 四函式(btCount/myPredHistBox id 不存在)。設定頁「快照管理」UI(讀 proTerminalPredHist)保留 — 行為不變(store 自 V41.19 起本就無人寫入)。
| 函式 | 行號 | 行數 | 驗證結果 |
|------|------|------|----------|
| `runKlineAudit` | 35660 | ~249 | 只有定義 + 一句無關註解 |
| `analyzeSectorRotationAI` | 14626 | ~130 | 只有定義(V69.8.0 我刪了它的按鈕) |
| `renderPeerCompareCard` | 9908 | ~118 | 只有定義 |
| `runIndustryReport` | 21492 | ~93 | 只有定義(V41.25 UI 已移除) |
| `renderKbarScore` | 18842 | ~78 | 只有定義,且 `kbarScoreCard` id 不存在 |
| `renderObvPanel` + 2 呼叫點 | 17348 / 30562 / 32545 | ~92 | 函式活著但 `obvJointPanel` id 不存在 → 必定 no-op |
| 預測快照鏈 4 函式 | 32372–32538 | ~170 | `btCount` 等 9 個 id 全不存在 → 必定 early-return |
| `analyzePredictCenter` + `analyzeMarketAnomaly` | 14848 / 15005 | ~250 | 只有定義 + 已刪除註解 |

⚠️ **`renderKbarTactics` 是活的**(17438 定義 + 30561 呼叫)— 代理誤報,**不可刪**。

### [x] P2-5 其餘孤兒方法 ✅ V71.0.4 刪 **40 個函式 / 815 行 / 52 KB**(39,722 → 38,907 行)
**改用程式化全掃取代代理清單**(更可靠):抽出 app 物件層級全部 954 個方法定義,對每個名字算全檔 `\bNAME\b` 出現次數,
次數 == 定義數 → 零呼叫端。得 41 個候選。

**刪除前先排除四種「grep 會漏看」的引用形式**(全部實測確認不存在):
1. 動態派發 `this[fn]` — 存在(L17687/18141/18413/31405/39337 偵測器清單、L9358 scoreFn),但取值全是**字串字面量**,grep 有算到 → 不影響。
2. 樣板組名 `app.${...}` / `` this[`...`] `` → grep 全檔為空。
3. 外部檔引用(sw.js / scripts/*.mjs)→ 只有 smoke_test 引用 `app._detectVCP`。
4. 採礦端 `.py` 產生含 `onclick="app.xxx"` 的 HTML → 無。

`_getOpenRouterKey` 因結尾行帶尾註解(`}; },  // …`)不符合安全刪除樣式 → **保守跳過**,實刪 40 個。

刪法:大括號計數找函式尾,往上吃緊鄰註解列(本檔慣例註解貼在函式上方);範圍排序後檢查無重疊;`git diff` 確認**零新增行**(純刪除)。
驗證:四驗證全過 + test_brokerel / test_p14 / test_ruler / test_v704 四支回歸全 PASS。

### [ ] P2-6 重複邏輯合併
- [x] **RSI 被實作 4 次**(3079 / 16606 / 18228 / 32225),其中兩種算法(Wilder vs SMA)**對同一檔股票會給出不同 RSI 值** → ✅ V69.9.0 已統一 `_rsiSeries()`(Wilder):背離(6)/盤勢解讀(14)/回測(14)改共用,worker 副圖本就同式保留;回測順帶從每根 O(14) 改預算整條
- [x] ~~波段轉折偵測迴圈重複 4 次 → 抽 `_swingPoints()`~~ ❌ **V71.0.4 人工驗證後判定「不是重複,是設計取捨」,不做**:
  共用版 `StrategySim.findSwings/trendStructure`(L197)**已存在且已被 L15907 使用**;其餘三處各不相同 —
  L16071 是 ±6 fractal 取**收盤**、70 日窗、回傳價格值;L16391 是 ±3 分別取**最高/最低**、40 日窗;
  L25127 是 ±3 嚴格 fractal 只取**最高價**、120 日窗、額外要求 `h > 現價`、回傳 `{price, daysAgo}`。
  k / 視窗 / 價格序列 / 回傳型別四項全不同,抽共用要吃 4 個參數 + 4 種回傳轉接,helper 會比三段迴圈還複雜,且改動會讓訊號值漂移。
- [x] ~~`_detectBlackCandleLevels` / `_detectRedCandleLevels` 逐行鏡像(~55 行)→ 合併帶 dir 參數~~ ❌ **V71.0.4 驗證後不做**:
  兩者**門檻刻意(或至少實際上)不同** — 有效區間黑 K 是 `c > hi*1.06 || c < lo*0.92`、紅 K 是 `1.08 / 0.94`;
  比較運算子黑 K 用 `>`、紅 K 用 `>=`;四段 msg 文案完全不同,`val` 回傳規則也相反。
  真正共用的只有「找近 10 根最顯著長 K」掃描(方向相反)與 ma5/ma20/trend 四行。
  合併就必須統一那些門檻 = **在使用者沒要求下改變訊號輸出**,不可接受。淨省不到 25 行,風險遠大於收益。
- [x] `^TWII.json` 抓取邏輯複製兩份(13776 / 14468)→ ✅ V69.9.1 實際找到 **4 處**(天氣趨勢/盤前簡報/派發日/年線乖離),統一 `_getTwiiRows()`(30 分快取 + 併發去重)
- [x] `JSON.parse(localStorage.getItem('proTerminalInv'))` 全檔 25 次 → ✅ V69.9.2 抽 `_getInventory()`(直讀 this.inventory — 6 個寫入端全是它的鏡像),24 讀取點全改;`fav + inv → allSyms` 樣板 4 次未動(獨立小樣板,風險/收益不划算)
- [x] `stockToSector` 硬編碼表複製 3 份 → ✅ V69.8.8 P2-4 刪死碼後只剩 1 份(在「此股預判」內,29 key 無重複);有重複 key 那份在已刪的 analyzeSectorRotationAI 裡,隨死碼一併消失

### [x] P2-7 `_syncMarketTab` 做 30 次 `innerHTML` DOM→DOM 複製 ✅ V69.8.9(修正原計畫)
- **「內容都是純數字」是誤報**:來源(mktFI/mktTWII_chg 等)是 `<span class="顏色">` 標記,改 `textContent` 會掉色 → 實作改「內容相同就跳過寫入」,免 30 次無謂 re-parse,行為零改變

---

## 🟢 P3 — 採礦效率(省額度、省時間)

### [x] P3-1 `rotation_probe` 每小時跑 24/7 → 每週浪費約 45,000 次 FinMind 呼叫
- **證據**:`rotation_probe.yml:9` `cron: '23 * * * *'`;`BATCH_N=150` × 3 endpoint = 450 次/小時 × 168 小時
- 抓的是月營收(月更)/財報(季更)/PER(日更),用每小時輪詢完全沒必要
- **修法**:cron 改 `23 1,4,7,13 * * 1-5` → 額度立降 ~85%

### [x] P3-2 `fund_sweep` 每檔 `sleep(3.0)` 序列 → 每晚 4 shard 共睡 90 分鐘
- 每個 shard 已綁專屬 token(額度獨立),卻單執行緒逐檔 sleep
- **修法**:每 shard 開 3-4 thread + Semaphore 控速,QPS 不變但 wall-clock 降到 1/3

### [x] P3-3 `macro_cron` 每 4 小時跑全天全週(含週末)
- 一週 42 輪,其中 12 輪在週末(台股/taifex/NDC 都不更新);08:00 UTC 那輪還跟 daily_miner 撞
- **修法**:`0 0,4,8,12 * * 1-5`

### [~] P3-4 重複抓取去重(V69.8.6:✅TDCC 已改讀 tdcc_holders 零下載;❌台指期「抓三次」是誤報 — TXF vs MTX 不同商品、CSV 只是 fallback;當沖四合一與 company_profile 未做,風險較高留待後批)
- **TDCC 股權分散表**同一份 CSV 被 `extras_miner.py:128` 每日抓 + `tdcc_sweep.py:32` 每週抓 → extras 改讀 tdcc_sweep 的產出
- **當沖資料有 4 套平行實作**(extras_miner / daytrade_data_miner / daytrade_probe / miner.py)打 3 個端點 → 留 `daytrade_probe.py`(唯一有多端點 fallback)當單一真相源
- **公司基本資料 t187ap03** 被 miner.py / universal_radar.py / theme_news.py 各抓一次 → 落成 `data/company_profile.json` 共用
- **台指期三大法人** 一輪內抓 3 次(macro_miner 自己就抓兩次)→ module 級 memo cache

### [x] P3-5 `miner.py:5136` 移除 ONLY_CHIPS 流程裡的 `os.system("python3 macro_miner.py")`
- 產出的 `macro_risk.json` / `risk_history.json` **不在 chips-data artifact 清單** → 整支白跑
- deploy job 的並行階段已經會跑一次
- 順便治好 P0-1 在 chips job 那次的覆寫

### [x] P3-6 刪死 workflow(V69.8.6:改 dispatch-only 不刪檔 — orb 的 CLAUDE.md 明文要保留手動重驗,四支 probe 統一拿掉 push 觸發)
- `orb_probe.yml`(ORB 已定案不做,`grep orb_ index.html` = 0)
- `etf_probe.yml`(寫死單一標的的一次性診斷,功能已由 etf_miner 正式實作)
- `insider_probe.yml`(端點探索早已定案)
- `macro_probe.yml` 改 `workflow_dispatch:` only(現在每次 push macro_miner.py 就跑一輪完整總經採礦)

### [x] P3-7 gh-pages 瘦身(388 MB / 1 GB)
- `inst_cache_stock.json` **18.5 MB**,前端 `grep` = **0 次引用**(是採礦端 cache 借放在 gh-pages)→ 改只推 data 分支
- `broker_signals.json`、`delisted_stocks.json` 同理

---

## 🔵 P1.5 — 卡片打架與殭屍卡(**使用者最在意的「邏輯不打架、資訊不爆炸」**)

> 統計:**個股頁總覽有 28 個卡片槽位,其中 6 個是永遠不顯示的殭屍卡**;約 400 行 unreachable UI 程式碼。
> 真正造成困惑的不是卡片多,是**同一個名詞在不同卡有不同數字**。
- ✅ V69.9.6 已修:gh-pages deploy 不再 cp/add inst_cache_stock;data 分支 push 補上;兩處 restore 改「data 優先(git show + [ -s ] 防空檔,/tmp 實測)→ gh-pages 過渡 fallback」。下次 daily_miner 跑完 gh-pages 即 −18.5MB。

### 同名不同數字(優先修,這是使用者最痛的)

### [x] U-1 「主力成本」全 App 有 5 個不同公式 ✅ V69.9.7 正名(公式不動):唯一「主力成本」=買超王均價(K線 markLine/設定頁 toggle/黑科技 cost 類,本就同源);分點動向卡 Σ(close×net)/Σ(net) →「吸籌加權成本」(footer 註明與 K 線主力成本線不同算法);_detectInstCostBias 外資60日加權 →「外資估算成本」(即時作戰室短版轉引自動跟改)
V69.7.5 只改了「總覽 vs 觀察頁」兩處,還有 5 處沒動:
| 位置 | 行號 | 公式 |
|---|---|---|
| 籌碼頁作戰室 | 15848 / 15885 / 15894 | Σ(close×net)/Σ(net) 分點日量加權 |
| K線訊號 + 即時頁 | 16870–16882 | 外資 60 日 \|淨額\|-加權估算 |
| 即時頁作戰室 | 27800 | 轉引上者 |
| 券商分點頁 | 31030–31036 | 分點買超王 **5 日**區間均價 |
| 設定頁說明 | 563 | 寫「區間均價」 |
- **修法**:固定一個為「主力成本」(建議分點買超王加權均價),其餘改名 —— 外資估算的叫「**外資估算成本**」、K線那條線標「**買超王均價(5日)**」。

### [x] U-2 「籌碼綜合評分」三處三個數字 ✅ V69.9.8:masterScoreCard 早在 V68.4.4 已是 hidden stub(殭屍運算)→ renderMasterScoreCard(105行)+ renderInstReverseCard(121行,_lastInstSignal 唯一活消費者就是前者;反轉/做帳資訊 chipVerdict 已自算)+ 2 個 stub div + 呼叫點全刪;進場體檢 xref 改讀 _lastChipScore(大戶籌碼總結同分,sym 守門,分帶 57/45);aiCacheKey sigState 同步。死掉的首席 AI 函式體內 2 個殘留引用留待 U-14 死鏈批
- `renderChipVerdict`(12523,籌碼頁最上方)vs `renderMasterScoreCard`(13012–13102,收在 details 內)vs 總覽進場體檢(19673–19682,引用的是被收合那張)
- **失敗情境**:外資買超但景氣紅燈 → 一張顯 72「大戶站買方」、另外兩處顯 41「偏空別碰」
- **修法**:刪 `masterScoreCard` 整卡(它 5 個因子只有 2 個是籌碼面),把「外資反轉/投信做帳」併進 `chipVerdictCard`;總覽改引 `chipVerdictCard` 的 score100

### [~] U-3 盤中多空有三套引擎,可同時給相反結論(V69.9.9 部分完成:當沖頁 biasLine 已改優先走 _dayTradeVerdict 同引擎(當沖頁本就抓分鐘K,留下 dtBars 即可),無分鐘K才退回 3 因子;剩「_intradayTruthJudge hero 降級只出因子」— 真假判讀與當沖方向語意不同,降級與否屬設計取捨,留待使用者反映再動)
- `_intradayTruthJudge`(28720,即時頁 hero)/ `_dayTradeVerdict`(27586,#dayTradeLight)/ 當沖頁 `biasLine` 自算(38768)
- **失敗情境**:同樣的盤 → hero 顯「假漲別追高」、正上方顯「別碰區間震盪」、當沖頁顯「今日偏多優先做多」。**前兩張是上下相鄰的**
- **修法**:當沖頁 `biasLine` 刪掉改讀 `_dayTradeVerdict`;`_intradayTruthJudge` 降級為只出因子 chips 不出結論

### [x] U-4 「½價」兩種算法 → **這不是 bug,是命名衝突** ✅ V69.9.3 改名不改公式:突破棒=「突破棒防守價」、K棒戰法/長紅長黑三價位/今日盤勢解讀=「當日平均成本」,全 App 32 處文案(含告警/出場總表/教學/jargon)同步,UI 不再出現「½價」;CLAUDE.md 定義段已更新
- CLAUDE.md:612 明文「兩種並存,別亂統一」:突破棒防守用 (開+收)/2、K棒戰法用 (高+低)/2 —— **公式是刻意的,不要統一**
- 但兩張卡都寫「½價」且在總覽同一個摺疊裡上下相鄰 → 使用者看到兩個數字
- ⚠️ V69.8.3 我新做的「今日盤勢解讀」(24447)也用 (H+L)/2 標「½價」,**加劇了這個衝突**
- **修法**:改名不改公式 —— 突破棒那個叫「**突破棒防守價**」、K棒戰法/今日盤勢解讀那個叫「**當日平均成本**」,兩者都不再顯示「½價」三個字

### [x] U-5 「停損價」4 個來源,進場體檢那條沒接數字中樞 ✅ 複查發現 V56.1 已修(程式內註解明寫「改引用數字中樞」,slPrice=_uni?.stopB、5MA=_uni?.takeShort,僅中樞無資料才 fallback)— 計畫過期項,已驗證非待辦
- `_unifiedExitPlan`(25635,數字中樞)/ `_ovKeyLevelsHtml`(已接)/ `renderEntryCheckup`(19689 **自算**)/ `_renderPositionSizer`(已死)
- V56.1 註解明寫「嚴禁各卡自算」,19689 違反了
- **修法**:19689–19697 改讀 `this._unifiedExitPlan(data, cost)`

### [x] U-6 「持股該抱該跑」兩套門檻 ✅ V69.9.4 進場體檢 heldHtml 整套門檻(−10%/−5%/+7%)刪除,只顯損益(%+元)+ 指向主卡(單一劇本原則)
- `renderEntryCheckup` heldHtml(19646:−10%/−5%/+7%)vs `_renderTrendCommand`(24508:破 stopFinal / 破 tpS)
- **修法**:進場體檢 heldHtml 整塊刪,只顯「你的損益 X%」並指向上方主卡(單一劇本原則)

### 殭屍卡(函式開頭就 return,底下全是 unreachable)

| # | 卡片 | 函式:死亡行 | DOM | unreachable 行數 |
|---|---|---|---|---|
| [x] U-7 | 今日掛單 | ✅ V70.0.0 函式+呼叫點+DOM 全刪(V44.5 已併進場體檢)| — | — |
| [x] U-8 | 💰該買幾張(ATR 部位管理) | ✅ V70.0.0 **依建議復活**(kill-switch 移除;headless 真渲染驗證 CTA/張數/隱藏三路徑,風控數學對:1% 帳戶=單筆最大虧)| 1471 | — |
| [x] U-9 | 🎯朱式買點 | ✅ V70.0.0 **修正原計畫:是活引擎非殭屍**(_chuActionVerdict 仲裁 3 個消費者)→ 只刪 return 後死 UI 尾段 ~37 行,引擎保留 | 1472 | — |
| [x] U-10 | ⚔️朱家泓策略狀態 | ✅ V70.0.0 函式+2 呼叫點+DOM 全刪(V53.x 已併出場總表)| — | — |
| [x] U-11 | 第一/第二目標價 | ✅ V70.0.2 tpSlReason 搬進出場總表頂端(琥珀警示框,per-stock 守門);計算本身是活的(供出場總表 stash 目標值,комment L1583 明寫)不可刪 | 1588 | — |
| [x] U-12 | 即時真假判讀 | ✅ V69.9.5 函式+hidden DOM+清理殘留全刪(功能在盤中作戰室)| — | — |
| [x] U-13 | 主升段體檢 | ✅ V69.9.5 函式+hidden DOM 刪(_mainRiseStage helper 保留,朱老師卡在用)| — | — |
| [x] U-14 | AI 首席總評 ✅ **V71.0.7 完成,刪 954 行**(38,944 → 37,989)。**修正原計畫**:`updateAITranslator`(refreshStrategy L29472 在呼叫)與 `analyzeStockPredict`(L1495 有 onclick)**都是活的,不可刪** — 原清單誤列。真死鏈只有 3 支:`runUnifiedGroqAnalysis`(458 行,entry 即 `return;` 整段不可達)→ `_renderUnifiedAIResult`(80)→ `renderSummaryCard`(20)。刪完做**級聯掃描**再清 2 波:第 1 波 10 支(`_getOpenRouterKey`/`_loadFalconScores`/`_chuPositionPlanForAI`/`_setCachedAI`/`_getLastAnyDateCache`/`typeWriterEffect`/`_ensureGlobalIntel`/`_buildDataDrivenAnalysis`/`_parseAIJson`/`_dtScanRun`,331 行)、第 2 波 3 支(`_evictOldAICache`/`_classifyStock`/`_maStanceLabel`,65 行),第 3 波 0 個收斂。DOM 保留(`geminiResultBox`/`aiTranslatorCard` 仍被 `_showAIIdleHint` 與切股重置迴圈清空)。**`check_prompt_vars.py` 依賴解法**:它驗的 prompt 就在被刪的不可達區段裡(等於在驗死碼)→ 直接退役,四驗證第 3 關換成 `scripts/check_dom_ids.py`(DOM id 唯一性,即 V71.0.3 抓到真 bug 的那招),CI `ci_verify.yml` 與 CLAUDE.md 三處同步改。 | **「仍花額度」是過期描述**:V51.4 已把 runUnifiedGroqAnalysis no-op(entry 即 return,0 額度);真正待辦=刪整條死鏈(no-op 函式體 ~400 行 + _renderUnifiedAIResult/renderSummaryCard/updateAITranslator/analyzeStockPredict + hidden DOM),⚠️ **check_prompt_vars.py 硬依賴此函式存在**,刪除須連驗證腳本一起改 → 留獨立批次 | 1486 | — |

⚠️ **U-8 決策點**:ATR 部位管理是全 App 唯一回答「該買幾張」的地方,刪掉後這個問題沒人回答。**建議復活而非刪除**(順便讓 `settings.accountSize` / `riskPct` 兩個設定項有用)。
⚠️ **U-11 附帶**:`tpSlReason`(為什麼目標價被停用)是唯一說明文字,寫進了永遠不顯示的容器 → 搬進 `chuExitSopCard`。
⚠️ **U-14 附帶**:AI 摘要花了 API 額度寫進 hidden 節點 → 刪掉可直接省額度。

### 建議合併(不損失資訊)

- [~] **U-15** 即時頁 `dayTradeLight` + `intradayWarRoom` hero → 一張(V70.0.5 評估後**暫緩**:當沖燈 V69.6.6 已極簡(燈+操作+警訊,明細摺疊),兩卡語意不同(當沖方向 vs 真假判讀)互補非重複;硬併風險>收益。即時頁現有結論卡=當沖燈/作戰室/盤中六脈/日K六脈鏡射,若使用者反映太多再併)
- [x] **U-16** ✅ V71.0.6 → 「📉 盤中量價體檢」(🩸分時均價線 + ⚡量能達標度)
  ⚠️ **修正原計畫:刻意不併入「🔴 盤中連量偵測」** — 它在**常顯區**(`cards` 陣列)且是條件觸發的**即時**警訊;
  VWAP/量能兩張在**摺疊的進階分析區**(`detail`)。把連量搬進摺疊區 = 把即時訊號藏起來,那是退步不是進步。
- [x] **U-17** ✅ V71.0.6 → 「🖼️ 今天的框」(📏今日必守價位 + 🚀開盤區間突破 + 📊波動夠不夠沖)
- **U-16/U-17 共同實作**:不改任何卡片內容,純版面收納 —— 5 張各自帶 `bg-[#161b22] border rounded-lg shadow-lg`
  外框的小卡 → 改推進 `dFrame` / `dVolPx` 兩個桶,外框換成單純 `p-3`,最後由 `_dtGroup()` 包成
  2 個共用外框(標題只出現一次 + `divide-y` 分隔線分列);內層標題由 `text-[12px] font-black` 降為
  `text-[11px] font-bold` 建立層級。headless 驗證:兩組標題都在、5 張內容一字未少、群組外框數 = 2。
- [x] **U-18** ✅ V71.0.1 **修正原計畫:不刪卡,改在最上方加「🛡️ 防守價一覽」彙整列**(`_renderGuardRuler`,`#guardRuler`)。
  原計畫要把 4 張卡併成 1 張,但那 4 張各自的「為什麼」說明(多空易位/回後買上漲/扣抵原理/四大金剛)是使用者要的教學內容,硬併會流失。
  改成:一覽列只回答「**先破哪一個**」(下方防守由近到遠 + 已跌破的標為上方壓力),各卡照舊解釋為什麼。
  ⛔ 一覽列**不自己算任何價位**,全讀既有 `_guardStash`(g5/g20/g60/boMid/boLow)+ `_dynExit.def`,名稱沿用 V69.9.3 正名結果 → 不會再生同名不同值。
  headless 真渲染驗證 4 情境:排序正確(99.20→98→95→93→88)/ 全跌破轉壓力 / 候選<2 隱藏 / pC 無效隱藏。
- [x] **U-19** ✅ 已由 V70.3.1「處置頁瘦身」取代:整個處置分頁已刪(8 款推估資料撐不起),只保留現價旁處置 badge + 官方明細卡(移到總覽,有被列管才顯)→ 原「4 張併 2 張」不再適用。

---

## 📝 文件修正(CLAUDE.md 已過期處)

### [x] D-1 「三處清單」鐵律已過期 ✅ V69.8.4 表格列 + V69.8.9 L676 段落都已改
- CLAUDE.md:317 / 676 說新增 K 棒偵測器要同步加進 `renderKbarTactics` + `renderKbarScore` + `runKlineAudit` 三處
- **實測**:`renderKbarTactics` 活的 ✅、`renderKbarScore` 死的 ❌、`runKlineAudit` 死的 ❌
- **改成**:只需加進 `renderKbarTactics`

### [x] D-2 「GitHub Pages 目前使用約 100MB」→ 實際 **388 MB** ✅ V69.8.4 已改

### [x] D-3 加一條新鐵律:**版本註解不再累加** ✅ V69.8.7 已寫進版本號規則
第 18 行已 93.5 KB,是每次 bump 累積出來的。改成只留當前版本,歷史進 CHANGELOG.md。

---

## ❌ 代理誤報紀錄(人工驗證後排除,避免下次重複踩)

| 誤報內容 | 實際情況 |
|---|---|
| `renderKbarTactics` 是孤兒 | **活的**:17438 定義 + 30561 呼叫 |
| `universal_radar.py:639` radar_news 缺守門 | **有守門**:626/629 的 `if len(keep) < 5` |
| `renderVolSurgeRadar` 是 no-op(檔內註解說的) | **活的**:37595 已改用 `aiRobotBubble`,註解過期 |
| 7 個新資料檔欄名不一致 | **全部一致**,逐欄比對通過 |

> 教訓:「函式全檔出現 ≤2 次 = 死」這個啟發法**會誤判**,必須看出現位置是「定義+呼叫」還是「定義+註解」。

| 誤報內容(續) | 實際情況 |
|---|---|
| 台指期三大法人「一輪抓三次」 | miner 抓 TXF、macro 的 CSV 是 OpenAPI 失敗才用的 fallback、_taifex_oi_rows 抓的是 MTX(小台,不同商品)— 不是重複 |
| setupAutoRefresh 只有一處 forceRefresh=true | 還有 visibilitychange 切回前景那條(L4022)— 但那是合理設計(一次性補刷),保留 |

---

## 🗺️ 建議執行順序(每個 Batch 一次 commit + 四驗證)

1. **Batch A(P0-1 → P0-4 → P0-5 → P0-6)**:資料流修復,一條因果鏈,一起改一起驗
2. **Batch B(P0-2 / P0-7 / P0-8)**:workflow 三個小修(各改幾行,但止血效果大)
3. **Batch C(P0-3)**:`_tdccCache` 改名分家(單獨 commit,影響 5 個讀取點)
4. **Batch D(P1-1 / P1-2 / P1-8)**:效能三連,改動小、有感度最高
5. **Batch E(P2-1 / P2-2 / P2-3)**:瘦身,不改行為
6. **Batch F(P2-4)**:刪死碼第一批(~950 行,零風險)
7. **Batch G 之後**:P2-5 孤兒方法分批、P2-6 重複邏輯合併(有行為風險,每項單獨 commit)
8. **最後**:P3 採礦效率、D 文件修正

⚠️ **每個 Batch 都要跑四驗證**:`node scripts/smoke_test.mjs` + `python3 -m py_compile *.py` + `python3 scripts/check_prompt_vars.py` + awk div 平衡。
⚠️ **P2-4/P2-5 刪碼前**,每個函式都要用 `grep -n "函式名" index.html` 看清楚出現位置,不可只看次數。
