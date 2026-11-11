# 🔏 實盤發布紀錄(會改到 auto_trade 實際下單的換版)

> 使用者 2026-11-11 決定(SELF_EVOLVING_AUDIT §10 ①):**會改到自動下單實際行為的策略參數,要使用者核准才可以推**。
> 守門:`scripts/test_release_gate.py`(四驗證)比對 `scripts/live_fingerprint.py` 抽出的指紋與 `research/approved_live.json`。
> ⛔ Claude 不可以自己改 `approved_live.json` 讓它變綠。程式修 bug(修復)不用走這裡;改門檻 / 預設 / 錨點 / 規則(優化)要走。
> App 那邊的同一個預設**一起等**(⛔ App 先換、自動下單沒換 = 兩邊規則不同)。

## 發布報告樣板(每一次換版複製一份,寫在最上面)

```
## R-YYYYMMDD-nn 一句話講換什麼(狀態:⏳ 等核准 / ✅ 已核准 YYYY-MM-DD / ⛔ 不換)
- 改哪些常數:(貼 test_release_gate.py 印出的「舊 → 新」)
- 為什麼:實測數字 + 實驗登錄 id(research/experiments.ndjson)+ 實測總表條目 k
- 代價:回撤變大多少 / 哪幾年少賺 / 換手變多少
- 對你的影響:哪一天開始、手上的部位怎麼處理、會不會多買 / 多賣
- 怎麼換回:環境變數 / 改回哪一行
- 核准:使用者原話 + 日期(⛔ 沒有這一行就不可以更新 approved_live.json)
```

核准之後:`approved_live.json` 的 fp / hash 換成新的,`history` 加一筆 `{date, hash, why: "R-…"}`。

---

## 紀錄

### R-20261111-00 基準線(✅ 2026-11-11)
- 當天正在跑的現行參數(49 個常數,指紋 `95ae59b3064e8000`)= 之後每一次比較的起點。
- 核准:使用者 11/11「你建議都做」(採用 §10 ①)。
