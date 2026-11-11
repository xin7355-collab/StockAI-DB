# 🧭 SELF_EVOLVING_AUDIT —「AI 股票策略自我進化工程」Phase 0 盤點(2026-11-11,V82.1.1)

> 只讀盤點,⛔ 沒有改任何正式程式。這份是給你(與你要拿去複查的 AI)看的:
> **現在已經有什麼、跟提案哪裡對不上、真正缺什麼、建議先做哪幾件**。
> 數字都是本 repo 當下實數(檔案數、條目數、測試數),不是估的。

---

## 0. 先講結論(一頁版)

1. **提案的七個角色,本專案約七成已經存在**,只是分散在 CLI 工具、測試、實測總表與 Claude Code 工作階段裡,沒有被叫成「Agent」。
   照提案「重建七大 Agent + 14 張資料表 + 12 頁前端」⛔ **會做出第二套真相**(本專案踩過最多次的坑,陷阱 #37)。
2. **真正的缺口只有六個**(§9):研究資料包不可重現、實驗沒有機器可讀的登錄、沒有系統化的 Walk-forward、
   績效指標不齊(沒有 Sharpe / Sortino / Calmar)、失效預警只看淨值不看交易、驗證跟研究是同一個 AI。
3. **最重要的一句誠實話**:現在看板上每一個「100 萬變多少」都是**樣本內**的數字 —— 2011~2026 每一年都已經被拿來挑過規則
   (LAB `oos-seal`,2026-11-07 封存)。**真正的樣本外從 2026-11-07 才開始累積**。
   提案最怕的「為了回測漂亮過度最佳化」,在本專案不是假設,是已經存在、需要量化有多大的事 → Walk-forward 是第一優先。
4. **有一個要你先決定的衝突**(§10 決策 ①):你在 V75.0.9 給過「比我原本的策略好就直接換、不要等我發現」的永久授權;
   提案要求「正式策略一律人工核准」。兩者相反,必須你選一個。

---

## 1. 現有系統架構

| 層 | 是什麼 | 規模(實數) |
|---|---|---|
| 前端 | `index.html`(散戶救星,單檔 PWA)+ `pro.html`(產業作戰室:研究、實測總表、成績單、量化實驗室、App 體檢) | 兩個靜態頁,GitHub Pages |
| 採礦 | 71 支根目錄 `*.py` + 63 支 GitHub Actions workflow | daily_miner 20 批並行;盤中由 Cloudflare Worker 叫醒 |
| 研究 / 回測 | `scripts/` 512 支 `.mjs` + 190 支 `.py`(探針、引擎、嵌入腳本、測試) | 探針登記 `docs/PROBES.md` 171 列 |
| 驗證 | 四驗證全套 **246 條**(smoke_test 真載入 + 383 支 test_* 中的守門組)+ `ci_verify.yml`(push 後紅燈,⚠️ 不是硬閘門) | 每次 push 前跑 |
| 實盤 | `auto_trade.py`(永豐;🔥 / 👑 / 🅿️ 停 0050;真實帳戶 `PARK_LIVE_OK = False` 只預覽 0050) | 收工對帳 `reconcile_day`、成交紀錄 `FILLS_LOG` |
| 推播 | Cloudflare Worker(5 個 cron 已滿)+ Telegram(`tg_push.yml`) | |
| 研究資料分支 | `data` / `gh-pages`(orphan)+ 21 個研究分支(klines_deep・stock_deep・inst_deep・fin_deep・kbar5_*・world_hist・tw_deep04…) | ⛔ 不進 gh-pages(1GB 上限) |
| 決策紀錄 | `CLAUDE.md`(現行規則,2,476 行)+ `docs/DECISIONS.md`(22,272 行)+ `docs/INDEX.md` + `docs/EXTERNAL_REVIEWS.md` | |
| AI 工作流 | Claude Code 工作階段 + 5 支專案 Skill(`/ship` `/probe` `/audit` `/mining` `/uicard`)+ 代理 `scout`(只掃不改)、`financial-analyst` | ⛔ 沒有 Hooks(`.claude/settings.json` 只有外掛設定) |

⚠️ **架構前提跟提案不同**:提案假設「本機資料庫 + Python 服務」。本專案是 **靜態網站 + GitHub Actions + JSON 分支**,
沒有常駐伺服器、沒有本機 DB(SQLite 只是採礦中介)。→ 提案的 14 張表要改成「研究分支裡的 NDJSON 檔」才接得上(§9 G2)。

---

## 2. 資料流向

```
證交所 / 櫃買 / 期交所 / FinMind(免費層)/ yfinance / 永豐 Shioaji
   │  daily_miner(20 批並行)、盤中 live_snapshot / tick_flow(Worker 叫醒)、macro_cron …
   ▼
data 分支(orphan,一個 commit)──► gh-pages(網站 + data/*.json)──► index.html / pro.html(IndexedDB 快取)
   │
   └─ 研究分支(klines_deep / stock_deep / inst_deep / fin_deep / kbar5_* / tw_deep04 …)
        │  每次研究在工作階段裡「現場組」研究資料夾 d16(2010 起含已下市 2,496 檔)
        ▼
   探針 / 引擎 → 結論寫進 pro.html PRO.LAB(實測總表)+ docs/PROBES.md + docs/DECISIONS.md
        │  通過換預設規則(V75.0.9)才改 App / auto_trade 預設
        ▼
   auto_trade.py(實盤)─► FILLS_LOG / 收工對帳 ─►(⛔ 目前沒有系統化回饋到研究)
```

🚨 **資料流的最大弱點**:研究資料夾 d16 **每個工作階段手動重組、沒有版本**。
今天(11/11)第一次跑星期幾探針就因為 d16 少了 `_bench0050.json` / `_div0050.json`,
16 年的「贏 0050」整欄是空的(印出 NaN 才發現)。→ §9 G1。

---

## 3. 策略模組清單(現行正式版本)

| 策略 | 選股 | 進場 | 出場 | 實作份數(⚠️ 跨檔守門) |
|---|---|---|---|---|
| 📈 符合進場(散戶 App 預設) | `today_signals` + `_sigProven`(A/B 級且扣成本後贏同一天平均) | 只列候選 | 三條出場 | index |
| 🔥 / 🅿️ 高檔飆股(+ 閒錢停 0050) | `playbook_scan.mjs`:這檔這招 ≥8 次、照平均排、位階 ≥85・波動 ≥60 | 前一晚名單前 2 名,尾盤 ≥ 觸發價才買 | 吊燈 ATR 2 倍・最長 20 天・硬停損 | 規則 `lib_hotrule.mjs/.py`;出場 3 份(index / pro / auto_trade) |
| 👑 領頭羊短線輪動(解鎖才看得到) | 成交額前 100、20>60 日線、位階 ≥85、10 日動能前 5 | 每 10 個交易日換倉(錨點 2026-09-24),開盤賣、13:25 買 | 掉出前 10 才賣;跌 20% 收一半(V82.0.7) | **4 份**(lib_leader.py / index / pro / worker),`test_leaderdeck ⑤⑨⑩` 跨檔比對 |
| 📉 大跌撿便宜 | 加權收盤跌 ≥3% → 熱門股跌最多 10 檔 | 隔天開盤 | 抱 40 個交易日 | `dip_pick.mjs` 唯一一份 |
| 🐢 唐奇安長抱 / 其他出場 | 選項(預設不用) | | | |
| 曾經測試但失敗 | **實測總表 ⛔ 欄 206 條**(每條有數字 + 來源探針 + 試了幾種 `tries`)+ 量化實驗室判 ⛔ 的那幾支 | | | |

✅ 失敗紀錄**已經**完整保留(提案要求的「失敗實驗資料庫」),只是格式是給人讀的,不是給程式讀的(§9 G2)。

---

## 4. 回測引擎分析

| 引擎 | 回答什麼 | 關鍵設計(已做對的) |
|---|---|---|
| `portfolio_backtest.mjs` | 🔥 / 🅿️ 組合 | 全市場 + 照 App 名單買法(`LISTK` + `list_trig`,陷阱 #58)、收盤成交停損(陷阱 #45)、漲停買不到、斷崖守門、`STATS_WIN` 只用當時看得到的成績 |
| `leader_probe.mjs` | 👑 | 隔天開盤成交、跌停賣不掉(`ldLock`)、兩本帳、收一半兩趟模擬、17 個起點間距 3(涵蓋 10 種換倉排法)、`selftest` 65 條 |
| `quant_lab_build.mjs` | 量化實驗室(積木條件) | 八道關卡 + 高原 + 安慰劑 + 「比同一年亂買」 |
| `signal_backtest.mjs` | 135 個 K 線訊號 | 對照組 = 同一天全部股票、BH(`lib_fdr`) |
| `weekly_backtest.yml` | 每週五自動重跑訊號 + 決策台成績單 | 空過守門(< 上一版 80% 不推、絕對下限 FLOOR) |

**已有的防偽機制**:前視注入必紅(每支新探針的 selftest)、決定性對照、六關(`maxim_kbar5_probe.gates`)、門檻高原、安慰劑、
BH 多重比較、`tries`(V82.0.5 起每條新結論必寫試了幾種)、樣本外封存(`oos-seal`)、事先寫死判定條件(例:今天 `lead_wd_probe --cmp`)。

**引擎的已知弱點**:
- 🚨 **沒有 Walk-forward**:參數(👑 的 U/N/R/L/pos、🔥 的 85/60/chand2/20)都是在**全樣本**上挑的;只有兩支舊探針用過滾動驗證(`ump_wf_probe.py` / `accel_probe.mjs`)。
- 17 個起點**不是 17 個獨立樣本**(同一份歷史,16 年約只有 6 條獨立路徑,陷阱 #62)。
- 績效指標只有總報酬 / 年化 / 最大回撤 / 滾動 12 月贏 0050 / 逐年;**沒有 Sharpe / Sortino / Calmar / 滾動 24 月**。
- 同一條規則多份實作(👑 4 份、出場 3 份、跳動單位 3 份)靠跨檔測試守住 —— 有效,但每次改規則都是高風險操作。

---

## 5. 0050 基準計算方式(提案的要求逐條對照)

| 提案要求 | 現況 |
|---|---|
| 同期起訖日 | ✅ 同一組 17 個起點、同一個截止日(`embed_profit_board --to`) |
| 相同起始資金 | ✅ 100 萬(`capital: 1e6`,真實股數 + 最低手續費 20 元) |
| 股利再投入 | ✅ `lib_totalreturn.trSeries` 含息指數(除息日再投入);16 年用 `_bench0050.json` + `_div0050.json`(2010 起 27 次除息) |
| 相同交易成本 | ✅ 0050 買進手續費;策略端手續費 + 證交稅 + 最低手續費 |
| 閒置現金納入 | ✅ 淨值 = 現金 + 0050 停車 + 持股市值(⛔ 不是只算持股報酬) |
| 交叉驗證 | ✅ `gene_board.mjs` 兩個引擎算出的 0050 要一樣,對不上 exit 1 |
| CAGR / MDD | ✅ |
| Sharpe / Sortino / Calmar / 滾動 24 月 | ❌ 缺(§9 G4) |

---

## 6. 已知問題(現在就存在的)

1. **看板數字是樣本內**(§0-3)。沒有任何數字告訴你「實盤大概會打幾折」。
2. **研究資料夾不可重現**(§2):今天 0050 對照缺檔;同一個問題換一個工作階段可能用到不同版本的 d16。
3. **2008 不在任何 16 年回測裡**:2004~2009 全市場日 K 還在抓(61/71 個月,明天台北 18:30 最後一輪)。
4. **研究與驗證是同一個 AI、同一個工作階段**:防偽靠 selftest 與事先寫死條件,但沒有「不知道結論的第二雙眼」。
5. **實盤 vs 回測沒有回饋迴路**:`FILLS_LOG` 有記每一筆成交跟回測假設差多少,但沒有任何報表或守門讀它。
6. **CI 只是事後紅燈**(`ci_verify.yml` 註明不是硬閘門;直接 push main)。
7. **排程靠不住的歷史**:GitHub 排程配額會把整支 workflow 餓死(V73.9.0 / V75.2.0)→ 已改 Worker 叫醒;
   每週回測曾連 5 週被空過守門擋下(9/21~10/20)而沒人發現 → **自動化本身也需要被監控**。
8. **失效預警只有一條**:`PRO._healthCheck`(👑 / 🅿️ 淨值落在 16 年同天數最差 2.5% 以內、連 2 次才標),看淨值不看交易。

## 7. 資料品質風險

| 風險 | 狀態 |
|---|---|
| 日 K 混還原價(陷阱 #46) | ✅ 已修(深歷史整段換回官方價 + 跳動單位守門);2026-09 起靠守門 |
| 假日幽靈 K(陷阱 #48) | ✅ 已修 |
| 上櫃 2026-06 起收盤 / 量錯(陷阱 #63) | ✅ 已修 + 回補 |
| 上市融資 2026-05~06 錯一天(陷阱 #60) | ✅ 已修;那段做的融資研究要重跑 |
| 指數成交量 = 0(陷阱 #29) | ✅ 已知,改用成交金額 |
| 非整數倍減資 12 檔(價格斷崖) | ⚠️ 刻意不調,畫面標示;回測用斷崖守門剔窗口 |
| 2021 前部分資料只有上市、法人 2012 起 | ⚠️ 已揭露;影響早期年份 |
| FinMind 付費金鑰失效(2026-10-01) | ⚠️ 只剩免費層,分點資料整組移除 |
| 資料體檢 | ✅ `data_audit.py` A~G 類;⚠️ 抓不到「自洽但錯」的數字(要外部對照) |

## 8. 過度擬合風險(按嚴重度)

1. 🚨 **規則是從大網格挑出來的**:👑 中心點來自 216 組網格 + 31 組單參數 + 19 種新做法;🔥 的位階 / 波動 / 出場也是多輪比較後定的。
   → 全樣本最佳 ≠ 會持續最佳。**不知道膨脹了多少**(Walk-forward 才量得出來)。
2. ⚠️ 換預設規則(V75.0.9)判準是「總獲利最大」+ 多路徑配對,但路徑不獨立(陷阱 #62)。
3. ⚠️ 名單層濾網的「17/17 全贏」可以是同一筆大贏家撐的(陷阱 #62 已有逐筆檢查規範)。
4. ✅ 已有的抑制:`tries` 記錄、BH、高原、安慰劑、事先寫死條件、樣本外封存、失敗全保留。

---

## 9. 真正的缺口(建議修改項目)—— 照「價值 ÷ 風險」排序

| # | 缺口 | 做法(⭐ 接在既有工具上,⛔ 不另起一套) | 驗收 |
|---|---|---|---|
| **G1** | 研究資料包不可重現 | `scripts/research_pack.mjs`:一鍵從各研究分支組出 d16(含 0050 含息、加權長歷史、股數、股利),寫 `MANIFEST.json`(來源分支 commit、每檔筆數與起訖、內容雜湊);引擎讀到沒有 manifest 或缺件就 exit 1 | 今天這種「0050 對照缺檔」必紅;同一份 manifest 兩次組出來雜湊一樣 |
| **G2** | 實驗沒有機器可讀登錄 | `research/experiments.ndjson`(新 orphan 分支或 main 的 `research/`,只增不刪):每一筆 = 事先登記(問題、判定條件、試幾種)→ 結果(程式 commit、資料 manifest 雜湊、指令、數字、判定);LAB 條目帶 `x:` 指回去 | 新的 LAB 條目沒有登錄 id → 測試紅;事先條件在結果之後才寫 → 紅 |
| **G3** | 沒有 Walk-forward | 新探針:每年用「之前 N 年」重新挑 👑 / 🔥 的參數(只在既有網格裡挑),套用下一年,串成一條淨值,跟「全樣本挑一次」比 → 得到**樣本內膨脹率** | 有數字寫進 App 體檢與看板旁邊(例:「實盤預期打 X 折」);注入「偷看下一年」必紅 |
| **G4** | 績效指標不齊 | `leader_probe.metrics()` / `portfolio_backtest` 摘要補 Sharpe / Sortino / Calmar / 滾動 24 月超額 / 年換手 / 成本;看板加欄(⛔ 不改排序判準) | 不設時舊欄位逐位相同;0050 那列兩引擎一致 |
| **G5** | 失效預警只看淨值 | 擴充 `_healthCheck`:滾動最近 20 / 60 筆交易 vs 16 年同筆數的分布(百分位)、實盤 `FILLS_LOG` 滑價 vs 回測假設;規則事先寫死、⛔ 不自動停用 | 用 2022 那段重播能標出來;正常年份誤報率 ≤ 事先定的值 |
| **G6** | 驗證不獨立 | 改 `/probe` Skill:每支新探針下結論前,派一個**不知道結論**的子代理只讀程式碼找前視 / 洩漏 / 成本漏算(提案的 Validator),它的回覆原文附進 DECISIONS | 一支故意埋前視的探針會被它抓到 |

**次要(做了有用,但不急)**:
- H1 Hooks:改 `index.html` 後自動跑 smoke_test(⚠️ 要你自己改 `.claude/settings.json`,Claude 改那個檔會被安全檢查擋下)。
- H2 每週一份「L1 總報告」:把 data_audit + 每週回測 + 失效預警 + FILLS_LOG 合成一個 JSON,App 體檢頁讀它(用 Actions,⛔ 不用付費 AI)。

### ⛔ 建議不做(或改成接在既有東西上)

| 提案項目 | 為什麼不照做 |
|---|---|
| 14 張資料表 | 沒有資料庫可放;改 G2 的 NDJSON(一個檔就夠,欄位照提案) |
| 12 頁「AI 自我進化中心」 | `pro.html` 已有 研究 › App 體檢 / 實測總表 / 選哪一套 / 量化實驗室 / 成績單;再開 12 頁 = 兩套畫面講同一件事。新東西進 App 體檢頁。⛔ 散戶 App 不放研究(V78.3.4 鐵則) |
| 用 Python 重寫引擎 | 引擎是 Node 因為它直接跑 App 自己的程式(`_tickOf`、masterWorker、偵測器);改寫 = 第二份真相 |
| 七個常駐自主 Agent | 本專案的「AI 研究」= 你開的 Claude Code 工作階段;改成自主循環會無上限地產生假設(多重比較的製造機)。保留「人觸發研究 + 程式自動跑 L1」 |
| 美股領先台股研究引擎(重建) | **已做過三層**(`us_tw_lead_probe.mjs`,V77.7.7~V77.7.8;加權 0/35、板塊 1/98、疊在 🧬 上名單重疊 0%),而且提案列的 NVDA / AMD / AVGO / MU / TSM / AMAT / LRCX / KLAC / ANET / MRVL / MSFT / GOOGL / AMZN / META、SOX、VIX、美債、美元指數**每天都已經在抓**(`us_hist.yml`)。走完一次空頭或資料多兩年再重跑同一支,⛔ 不重建 |
| 自動修復程式後自動上線 | 現在已是「改 → 246 條四驗證 → 推」;再加自動就變成 AI 改測試讓自己過關的風險。修復維持工作階段內人看得到 |

---

## 10. 要你先決定的事

> ✅ **2026-11-11 使用者:「你建議都做」** → ① 只有會改到 auto_trade 下單參數的換版要先核准(`docs/RELEASES.md` + `scripts/test_release_gate.py` + `research/approved_live.json`)② 實驗登錄放 main 的 `research/` ③ Walk-forward 先 👑 再 🔥。§11 P1~P8 全做,外加 2004~2009 到齊後含 2008 重跑。

1. **正式策略要不要改成「人工核准才換」?**
   - A(提案):研究可以一直做,但任何改到 App 預設或 `auto_trade.py` 行為的換版,一律先出「發布報告」等你按核准。
   - B(現行 V75.0.9):五個條件全過就直接換,換完跳一次窗 + 一鍵換回舊的。
   - 💡 我的建議:**A,但只限「會改到 auto_trade 實際下單」的換版**;純畫面 / 研究數字照 B。理由:你要打敗的是 0050,最貴的錯是實盤用了過度最佳化的規則。
2. **G2 實驗登錄放哪?** main 的 `research/`(跟程式一起版本化,建議)或另開 orphan 分支(不佔 main 歷史)。
3. **G3 Walk-forward 先做哪一套?** 建議 👑(你自己實際在用、而且參數是大網格挑的)。

---

## 11. 開發計畫(建議;每一階段都:有交付、有測試、不破壞舊功能、完成後更新文件)

| 階段 | 內容 | 交付 | 驗收 | 預估 |
|---|---|---|---|---|
| P1 | G1 研究資料包 + manifest | `research_pack.mjs` + selftest;引擎讀 manifest | 缺件必紅、雜湊可重現 | 1 個工作階段 |
| P2 | G2 實驗登錄 + 補登最近 20 條結論 | `research/experiments.ndjson` + `exp_log.mjs` + 測試 | LAB ↔ 登錄雙向對得上 | 1 |
| P3 | G4 績效指標補齊 | 引擎摘要 + 看板欄位 | 舊欄位逐位相同 | 1 |
| P4 | G3 Walk-forward(👑 → 🔥) | 新探針 + LAB 條目 + App 體檢一行「樣本內膨脹率」 | 偷看下一年注入必紅 | 1~2 |
| P5 | G5 失效預警(交易層 + 實盤滑價) | `_healthCheck` 擴充 + 規則事先寫死 | 2022 重播標得出來 | 1 |
| P6 | G6 獨立審查寫進 `/probe` | Skill 更新 + 一支埋錯的測試探針 | 抓得到 | 0.5 |
| P7 | 發布核准流程(看決策 ①) | 發布報告格式 + 核准紀錄 | 未核准不改 auto_trade | 1 |
| P8 | H1 / H2 | 你改 settings.json(我給內容)+ 每週總報告 | | 0.5 |

⏭️ **2004~2009 資料到齊後**(預計 11/11 晚上):重組 d16 → 用 P1 的資料包重跑 👑 / 🅿️ / 📉 含 2008 的版本 —— 那是目前唯一能拿到的「沒挑過規則的舊年份」,價值等同一段樣本外。

---

## 12. 提案裡我同意、而且本專案已經在做的原則

- 程式修復 ≠ 策略優化(本專案:修 bug 用決定性對照證明「修完回到正確」;換策略走 V75.0.9 八道關卡)。
- 不准為了贏 0050 改對的程式(陷阱 #45 / #46 / #49 都是「修完數字變差」照樣上線)。
- 失敗全保留(⛔ 欄 206 條、method 欄 105 條「回測自己的坑」)。
- 承認沒有優勢(今天的星期幾研究、昨天的漲停放空,結論都是「⛔ 不換」)。

---

## 13. V82.1.2 做完了什麼(2026-11-11,「你建議都做」)

| 階段 | 交付 | 驗收 |
|---|---|---|
| B0 規則 | CLAUDE.md「先問使用者」第 ③ 件:換版會改到 auto_trade / lib_leader / lib_hotrule / lib_leaddd 的策略參數 → `docs/RELEASES.md` 發布報告 → 核准才更新 `research/approved_live.json` | — |
| P7 發布守門 | `scripts/live_fingerprint.py`(49 個策略常數的預設值指紋)+ `research/approved_live.json`(2026-11-11 核准 = 現行)+ `scripts/test_release_gate.py`(四驗證) | selftest 5 條;改註解 / 函式內容不擋、新增像策略常數的名字沒收進指紋也擋 |
| P1 資料包 | `scripts/research_pack.mjs`:data / klines_deep / stock_deep 分支 + idx_long → d16 + `MANIFEST.json`(來源 commit、內容雜湊);引擎起點那天 0050 含息不是數字就停 | selftest 5 條;實包雜湊 aaa094538cd18ee7、組兩次一樣 |
| P2 實驗登錄 | `research/experiments.ndjson` + `scripts/exp_log.mjs` + `scripts/test_exp_registry.mjs`(四驗證);補登 23 筆(標 retro) | 2026-11-12 起新的 ✅ / ⛔ 條目一定要有 x 而且是事先登記的 |
| P3 績效 | `scripts/lib_perf.mjs perf()`(Sharpe / Sortino / Calmar / 滾動 24 月);`leader_probe` 摘要多帶(舊欄位不變);App 體檢第 3 節 E | 👑 近 4 年 Sharpe 1.54 vs 0050 1.77、16 年 1.00 vs 0.95 |
| P4 Walk-forward | `scripts/lead_wf_probe.mjs`(👑 162 組);App 體檢第 3 節 F | 看板年化高估 2.1~6.7 個百分點;🔥 列在推薦下一步(一組要 1~2 小時) |
| P5 失效預警 | `scripts/trade_base.mjs`(👑 16 年逐筆基準)+ pro `_healthTrades`(每 10 筆看一次、連 2 次低於 2.5 百分位才標)+ `scripts/fills_report.py`(在你電腦跑,讀自動下單成交紀錄) | test_evolve ④;fills_report selftest 4 條 |
| P6 獨立審查 | `/probe` ③b + 示範(埋兩個錯都抓到,另抓到 5 個真的) | LAB method `probe-review` |
| P8 H2 | `scripts/l1_report.py` + `data_audit.py --json` + `weekly_backtest.yml` 部署前多產 `data/l1_report.json`(⛔ 不擋部署);App 體檢第 3 節 H | test_evolve ⑥;第一份要等下一次週五那一輪 |
| P8 H1 | ↓ 下面那段你自己貼 | — |
| B9 | ⏳ 2004~2009 資料到齊後(tw_deep04 第 6 輪之後) | — |

### 🪝 H1:改 `index.html` 後自動跑 smoke_test(你自己貼進 `.claude/settings.json`)

⛔ Claude 改 `.claude/settings.json` 會被安全檢查擋下,所以請你自己貼。把 `"hooks"` 那一塊加進現有的 `.claude/settings.json`(跟 `extraKnownMarketplaces` / `enabledPlugins` 並排,外面那層大括號只要一個):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "timeout": 240,
            "command": "f=$(python3 -c \"import json,sys;print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))\"); case \"$f\" in *index.html) cd \"$CLAUDE_PROJECT_DIR\" && node scripts/smoke_test.mjs > /tmp/smoke_hook.log 2>&1 || { tail -25 /tmp/smoke_hook.log >&2; exit 2; } ;; esac"
          }
        ]
      }
    ]
  }
}
```

- 只在改到 `index.html` 時跑(其他檔不跑,省時間);跑過不出聲,壞了把最後 25 行丟回給 Claude(exit 2 = 讓 Claude 看到並自己修)。
- 一次約 1~2 分鐘。嫌慢就把 `Edit|Write` 改成只在你說「推」之前手動跑 —— 四驗證本來就會跑。
- 換回:把 `"hooks"` 那一塊刪掉。
