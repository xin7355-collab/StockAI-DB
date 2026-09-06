# 🔗 全 App 資料連動盤查(2026-07-28,V71.1.8)

使用者要求「整份 App 連動部分全部盤查一次」。**用程式掃,不靠印象** ——
把 gh-pages 上 287 個全市場資料檔的欄位,跟 `index.html` 全部識別字做交叉比對,雙向都查。

重跑指令見本文末。

---

## ② 反方向:前端讀了、但資料檔沒這個欄位 → **0 個,乾淨** ✅

這個方向才是會**弄壞卡片**的(讀到 `undefined`,卡片靜默空白)。掃 12 個快取變數對應的資料檔,結果乾淨。

⚠️ **掃描時的兩個陷阱**(下次重跑務必照做,否則會得到假陽性):
1. **要排除賦值**：前端有些欄位是自己算完寫進快取的,不是從後端讀的。
   例:`taiex_ma240 / taiex_ma240_bias / taiex_last_close / taiex_bubble_msg / taiex_hist_stale_days`
   ——這 5 個是 `_loadTaiexMA240Bias()`(init 時呼叫)讀 `data/^TWII.json` 自己算完寫進
   `_macroRiskCache` 的,**後端本來就不該有**。第一版掃描把賦值當讀取,誤報成 5 個破口。
2. `updated` 這類共通欄位要放進白名單。

---

## ① 正方向:採礦有產、前端完全沒引用的欄位

不是 bug(不會壞),但代表**採礦花了時間算、資料佔了空間,卻沒人看**。

⚠️ 掃描要先濾掉「拿股票代號 / 券商名 / 日期當 key」的檔案(`tdcc*` / `broker_names` /
`industry_map` / `concept_stocks` 等),否則會報出上萬個假項目。

| 檔案 | 沒被引用的欄位 | 判讀 |
|------|--------------|------|
| `macro_risk.json` | `fi_complex_conclusion`、`blackswan`、`hi_60d`、`lo_60d`、`pos_60d`、`twii_pos_detail`、`gold_chg_3d`、`wti_chg_3d`、`tw_vix_chg_5d`、`m1b_label`、`m1b_note`、`nikkei_dump`、`us_market_dump`、`fi_spot_date`、`fi_three_date`、`_from_cache_yesterday` | **最有價值的一批**。`fi_complex_conclusion` 是現成的一句話結論(如「外資期現同步倒貨:真實偏空警戒」);`*_chg_3d` 系列比現用的單日變化更能濾雜訊;`tw_vix_chg_5d` 可補台指VIX那條 |
| `attention_status.json` | `tw_notice`、`tw_punish`、`otc_notice`、`otc_punish` | 上市/上櫃分開的原始名單;前端只讀合併後的欄位 → **設計取捨,不是漏接** |
| `daytrade_pack.json` | `dtRestrict`、`spec`、`suspend` | 當沖限制/警示/停牌,對當沖頁有用 |
| `macro_cache.json` | `twoii_history` | **櫃買(OTC)指數歷史** — 目前全 App 只看加權,中小型股走勢其實看櫃買更準 |
| `sector_heat.json` | `ai_core` | AI 核心族群熱度 |
| `bubble_warning.json` | `shadow_ratio` | 影子槓桿比 |
| `tick_flow.json` | `big_lots` | 大單口數 |
| `etf_tracking.json` | `_premium_status`、`top_n` | 折溢價狀態 |
| `falcon_scores.json` | `nikkei_dump`、`us_market_dump` | 與 macro_risk 同名重複,擇一即可 |
| `signal_history.json` / `strategy_backtest.json` / `walk_forward.json` | `avg_expectancy_pct`、`positive_ev_ratio`、`sortino`、`median_excess`、`chu_swing_*_backtest` … | ⚠️ **部分是 V71.1.2 刪掉回測兩卡後才變孤兒的**。若確定不再做回測頁,採礦端可考慮停算以省時間 |

---

## 重跑方式

```bash
mkdir -p /tmp/audit && cd /tmp/audit
git -C <repo> archive origin/gh-pages data futures_cache.json macro_cache.json | tar -x -C /tmp/audit
# 掃描腳本見本次 commit 訊息;要點:
#   ・把 index.html 的識別字一次抽成 set 再做集合查詢(逐個 regex 掃 3MB 會逾時)
#   ・正方向要濾掉「代號/名稱/日期當 key」的檔案
#   ・反方向要排除賦值(`var.field =`),否則前端自算欄位會被誤報成破口
```

**建議節奏**:每次新增「後端產資料 → 前端讀」的功能後重跑一次,
確認新欄位真的有被讀、也沒讀到不存在的欄位。

---

## 📌 追蹤中:加權指數(^TWII)資料落後(2026-07-28 使用者抓到)

**現象**:個股 K 線已有 07/28,但 `data/^TWII.json` 最新只到 **07/27**,且 **07/24 整天缺**;
`macro_cache.twii` 更誇張,停在 **2026-06-30**(近一個月)。
`macro_cache.twoii_history`(櫃買指數歷史)是 **0 筆空陣列**。

**影響**:盤前體檢的「關鍵壓力/支撐」「分析師解讀」、反攻雷達的「站回 5 日線」
全都拿舊收盤在算 —— 而且原本**完全沒有提示**。

**V71.2.0 已做(止血)**:`app._twiiLag()` 用 `macro_risk.fi_three_date`
(三大法人買賣超日期 = 真正的最新交易日)當基準,落後就在 UI 主動標示。
⛔ 不用「今天日期減一天」推算 —— 碰到連假會誤報。

**待辦(治本)**:`_fetch_twii_history_official` + yfinance 雙源為何會落後 1 天且缺 07/24,
需要看採礦 log 才能定位(本機打不到 TWSE,proxy 擋)。
下次 daily_miner 跑完後撈 `data/^TWII.json` 產出前後的 log 對照。
