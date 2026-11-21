---
paths:
  - "miner.py"
  - "macro_miner.py"
  - "*_miner.py"
  - "lib_*.py"
  - "fund_sweep.py"
  - "universal_radar.py"
  - "groq_common.py"
  - "scripts/fetch_testdata.sh"
  - "scripts/*backfill*"
---
# 採礦機(*.py)與資料來源、資料回算

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 470~563 行 -->
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
   🏪 V80.1.1 上櫃逐股月 K 走新站 `www/zh-tw/afterTrading/tradingStock`(舊 st43 從 runner 一律回網頁 → 2026-06 起上櫃最新那根常是沒收完的);當天那根兩個市場都先用官方全市場行情(`TW_DAILY_ALL=1`)。上櫃舊 K 線要整批換:手動派 daily_miner 填 `tpex_months`(12)。
2. **盤中快照補丁**：若當天歷史 K 線尚未產出，會自動去證交所 MIS 抓取即時快照填補。
3. ~~分點籌碼~~:🗑️ V79.0.0 已移除(付費金鑰失效)。`data/chips/{sym}.json` 只剩每檔基本面。
4. **外資期貨**：優先直連 **TAIFEX (期交所) 官方 CSV** 解析多空淨額，不再依賴容易斷線或缺漏的第三方 API。
5. **美股大盤 / ADR / 原物料 / 亞股 / 美股期貨**:yfinance(⚠️ 要冒充瀏覽器 —— 只剩「沒有趕得上台北 08:00 的免費官方來源」的那幾格,清單與理由見 `docs/DECISIONS.md` 最上面那節);🏛️ **美債殖利率**(10 年 / 2 年 / 3 個月)= 美國財政部 → FRED 備援、**加權 / 櫃買長歷史** = 磁碟那份 + 證交所 / FinMind 免費層(`lib_official.py`,⛔ 再拿 Yahoo 當底)。新抓取 ⛔ 再加 yfinance;要換掉剩下的先照那節的選項問使用者

### 重要規則
- `fm_get()` 任何非200回應都會 fallback 到匿名請求
- 分點籌碼「已是最新跳過」時，仍呼叫 `_refresh_broker_names()` 更新對照表
- OHLCV 補丁邏輯：若舊記錄缺少 `foreign_net` 欄位，下次採礦時自動補上
- **採礦補挖機制**:每次 daily_miner 跑都全市場重抓,沒有「N 次後永久放棄」黑名單。某支股票連續 10 天 FinMind 拉失敗,下次跑還是會試。週末無 cron(只跑週一~五 16:30),所以週六/日資料缺只能等週一或手動觸發 Actions UI 重跑

### 監控清單
`CHIP_WATCHLIST` = 約50檔上市上櫃熱門股 + ETF(V79.0.0 起只用來決定「熱門股先補基本面」)。

---


<!-- 舊 CLAUDE.md 第 1135~1153 行 -->
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


<!-- 舊 CLAUDE.md 第 1216~1229 行 -->
**目前還在「只能等」的清單**(想加新功能時先查這裡,能回算就回算):
| 項目 | 能不能回算 | 說明 |
|------|-----------|------|
| 市場廣度 / ADL | ✅ 已回算(V71.5.5) | 303 個交易日 |
| 外資**月累計**買賣超 | ✅ 直接向官方要(V71.6.1) | ⛔ **不是回算**,是 TWSE BFI82U **月報**一次給累計值。⚠️ **千萬別自己加總 `risk_history.json` 的每日 `fi_spot_net`** —— 那是「每天採礦時的快照」,上游當天沒更新就沿用前值(實測 07/09·07/10·07/13 都是 −472.53、07/29·07/30 都是 −222.52)→ 加總會重複計算、嚴重灌水。同理:**任何「每日快照檔」都不可拿來做時間軸加總**,只能拿來看趨勢方向 |
| 券商分點勝率榜 | ❌ 不能 | `data/chips/` 只有滾動 20 日快照,沒有逐日歷史;免費分點史被付費牆擋 |
| 板塊「偷布局」回測 | ✅ **V79.4.3 已用 16 年重跑**(`inst_deep` 2012 起個股法人) | ⭐ **結論:2012~2026(含 2015 / 2018 / 2022)+0.41pp・3/6 → 改列「沒用」**(舊的 809 天 +1.65pp 是 2020 起那幾年撐的;詳 DECISIONS V79.4.3)。以下是舊紀錄:🚨 **原本這一格寫「只能到 2026/05」—— 那是錯的**(同 V75.2.6 券資比那次,⭐ **同一句錯誤敘述在兩個不同欄位上各犯一次**)。2026-09-15 實跑:探針自己印出「外資資料實際範圍 **2023/05/22 ~ 2026/09/08(805 個交易日)**」,多檔抽驗(2330/2881/2882/2891/1101/3231/6415)**每一檔 `foreign_net` 都是 795~796 根全有**。⭐ 通用(第三次):**寫下「資料只回溯到 X」之前,先實跑印出真正的範圍** —— 憑印象寫的限制會讓一支能跑的探針被擱置好幾個月。⚠️ 但**窗口不含 2022 空頭**(`klines_deep` 有 2021 起的 K 線,但**只有 OHLCV、沒有 `foreign_net`**,已實查)→ 逐年那關只驗得到 2023~2026。 |
| 韓股 vs 日經 誰對台股更有預測力 | ✅ **已測(V74.7.0,Actions 實跑 5 年)** | 日經同期相關 0.665 / 韓股 0.648,**隔天只有 +0.047 / +0.062 ≈ 0** = 同步但不領先(LAB trap);S&P/那斯達克隔天 +0.469 / +0.487 是**時區**不是 alpha。🚨 原本這一格寫「❌ 不能、要等幾個月」是過時的 |
| 🇺🇸 美股隔夜異常 → 台股(個股 / 板塊 / 疊在 🧬 上)| ✅ **V77.7.8 已測(資料 `us_hist.yml` ⛔ 不是每天更新:V78.2.5 起**只有手動 Run**,預設 2009-01-01 起;要用最新的先按一次 —— V82.2.6 更正)** | ⛔ 三層都量不到買得到的優勢(加權 0/35、板塊 1/98 負、個股名單重疊 0%);🚨 加權層⛔ 不可用 ^TWII 開盤價(陷阱 #47)。走完一次空頭後可重跑 |
| 🗣️ 盤中口訣「非分 K 不可」的三條(下午時段 / 開盤 10 分鐘站回 / 第一根 5 分 K 上影) | ✅ **V78.2.5 已測完**(`maxim_kbar5_probe.mjs` 用 `kbar5_deep` 5 年 5 分 K,三條都沒過;第一根上影 ≥50% 不追反而方向相反)→ ⛔ 別再當「等資料」 | (以下是 V77.0.3 當時的紀錄)🚨 以前卡住的不是程式是資料:**分 K 一根都沒有存下來** —— 三支會抓分 K 的程式(`orb_probe` / `intraday_probe` / `volseq_probe`)都是現抓 Shioaji、只寫結論 JSON;`live_quotes.json` 每 5 分覆蓋、`tick_flow.json` 每天覆蓋、`tick_hist.json` 每天每檔只留 4 個數。✅ **V77.0.3 起 `kbar5_miner.py` 收盤後跑一次**(掛 `daily_miner` 的 `workflow_run`,⛔ 不吃排程配額),抓當日量前 80 檔 1 分 K → agg 成 5 分 K → **獨立分支 `kbar5`** 的 `kbar5/{YYYY-MM}.json.gz`(每月一檔 + gzip,實測壓縮率 3.4x → 約 42KB/天、250 日 ~10.5MB;⛔ 不進 gh-pages → 連帶避開陷阱 #41)。⭐ **第一次跑就有約 80 個交易日**(kbars 回溯 81~120 天,⛔ 不是「等半年」),但「逐年同向」那一關要滿一年 → 約 **2027-02**。⚠️⚠️ **母體是「當日成交量前 80」**(使用者選的)→ 名單每天變 → ① 某檔在歷史上斷斷續續 ② **天生只收「當天夠熱」的日子 = 選樣偏誤**。→ 檔案存了**每日實際清單**(`d[date].syms`)+ `bias` 欄;**用它回測時一律先算「這檔在窗口內有幾天」**,⛔ 結論不可講得像全市場。⚠️ 而且那三條抓的幅度只有 0.3~0.5%,當沖來回成本就 0.25%(ORB 就是這樣死的)|
| **券資比 / 軋空**(V71.9.2 → **2026-09-09 重跑,結論不變但理由要更正**) | ✅ **資料已經夠了**(2023-05-22 起)・⏳ 2010 起的融資券補挖還在跑(`stock_deep_backfill`,還差約 866 檔) | ⏭️ 補齊後用 16 年資料重跑 `short_probe.py` 才走得到 2015 / 2018 / 2022 空頭。以下是舊紀錄:🚨 **原本這一格寫「只回溯到 2026/05/14、約 55 個交易日」—— 那是錯的**:2026-09-09 實測 `margin_balance`/`short_balance` 從 **2023-05-22** 就有(隨機 200 檔:2023 年 13,227 列 / 2024 年 23,185 / 2025 年 23,380 / 2026 年 14,159)。⭐ 重跑規模 **1,736 檔 ・對照組 895,349 股·日 ・事件 64,820 筆**(舊版 1,002 檔 / 9,893 筆),並修掉舊版兩個**前視偏誤**(自身百分位用了含未來的整檔排序;用當天收盤進場而融資券是收盤後才公布)→ 改 expanding 百分位 + **隔天開盤**進場 + 排除鎖漲停,補齊六關與格內對照。**結果:自身百分位最高 10% = +0.04pp(扣成本 −0.40)、門檻敏感度 P80→P99 = +0.09 / +0.08 / +0.04 / −0.01 / −0.22(越嚴越差且單調)、絕對門檻高原檢定 5 個相鄰區間 0 個站得住。** 🚨 **要更正 2026-08 的兩句**:①「方向跟軋空**相反** −1.65pp」→ 重跑是 **+0.43pp**,正確說法是「**不是反向,是零**」;②「券資比額外貢獻 **−1.95pp**、還扣分」→ 重跑是 **+0.38pp**,結論(⛔ 不為券資比開功能)不變但理由改成「**加不到成本**」。⚠️ 窗口 2024-05-30~2026-08-11 三年全多頭 → 空頭沒驗到;**但 2026-08 那 55 天窗口正好是空頭、結果也是負的** → 兩種盤都沒有東西 |

---


<!-- 舊 CLAUDE.md 第 1839~1860 行 -->
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
- 預設 `aiPreferGroq`:深度分析也 Groq 優先(Groq 失敗才退 Gemini/OpenRouter)。🚦 2026-11-13 起失敗先分類、冷卻記在模型上(額度用完的模型換同一家下一個;每個候選都在冷卻才整家跳過),設定「🔑 金鑰與 AI」裡的「📡 AI 現在狀態」看得到誰在休息、還要多久(`test_ai429.mjs`)。
- 全球即時情報/即時情報與新聞解析 **已取消前端 AI**(標題吃採礦端翻好的);新聞時間 `_fmtNewsTime` 統一 Asia/Taipei 台灣格式。


<!-- 舊 CLAUDE.md 第 1867~1867 行 -->


<!-- 舊 CLAUDE.md 第 1908~1919 行 -->
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


