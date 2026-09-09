---
name: mining
description: 採礦沒跑、資料沒更新、某個 JSON 檔停在舊日期、workflow 全綠卻沒東西、或問「為什麼前端讀不到這個資料」時使用。⛔ 順序不可換：先確認有沒有被觸發過，再看產物日期，最後才查程式。
---

# 採礦／workflow 排查（mining）

⛔ **這支不做**：改 workflow 邏輯（那是**要先問使用者**的五種例外之一）、動 `data/` 內快取。
⛔ 畫面／卡片壞掉 → 那是 **audit**，不是這支。

---

## 🚨 排查順序（⛔ 不可換，每換一次就多繞一輪）

### ① 它到底**有沒有被觸發過**？

```
mcp__github__actions_list  → 看該 workflow 的 total_count
```
- `total_count: 0` = **一筆 run 都沒有**，跟程式完全無關 → 跳到 ⑤ 排程配額
- ⛔ 「workflow 是 active」「Actions 頁面全綠」**都不等於它有在產出**
- ⛔ 「有幾處 `sys.exit(1)` 所以大概是跑了但失敗」只是**可能性**，⛔ 不是結論

### ② 看**產物的日期**（⛔ 不看 Actions 頁面的顏色）

```bash
for f in live_quotes live_index tick_flow daytrade_pack stock_futures_night; do
  echo -n "$f: "; git show origin/gh-pages:data/$f.json 2>/dev/null \
    | grep -oE '"updated"[^,}]*' | head -1 || echo "不存在"
done
```

### ③ 🚨 **先確認那個 `updated` 是誰的日期**（自己踩過）

同樣叫 `updated`，可能是：**抓取時間** / **官方資料的期別**（`data/insider.json` 的 07-20 → 08-20
是正常的月報更新）/ **某一檔的滾動游標**（`data/fundamentals_rotation.json` 根本沒有頂層 `updated`，
grep 會抓到 1101 的欄位）。⛔ 沒確認就下結論會修一個沒壞的東西。

### ④ 才輪到**查程式** —— 四個最常見的陷阱

| # | 症狀（都是「全綠、零錯誤訊息」） | 檢查 |
|---|---|---|
| #9 | `if __name__ == '__main__':` 放在檔案中段，新函式在它下面 → NameError 被 try/except 吞掉 | `python3 scripts/check_main_order.py` |
| #11 | artifact `path: \|` 清單**行尾寫 `#` 註解** → 那個 pattern 永遠比對不到 | `python3 scripts/check_workflow_paths.py` |
| #12 | 同一支腳本在 A workflow 有給金鑰、B workflow 漏給 → 有值的版本被蓋成 null | 同上（`check_script_secrets`） |
| — | `inputs.*` 餵的環境變數，排程觸發時是**空字串**不是不存在 | `python3 scripts/check_env_default.py` |

### ⑤ 排程配額（本 repo 的頭號真因）

近 9 天實測：全 repo 只有 **100 筆**排程進得來，而 cron 要求約 **250 筆** —— 被丟掉的**連 run 都沒產生**。
🚨 **判準不是頻率，是「這一支實測進不進得來」**（`insider_cron` 一天 1 次也是 0 筆，
`fund_sweep` 一天 1 次卻正常）。

**現行修法**（⛔ 不是再開一支 cron）：
- 餓死的那幾支改掛 **`workflow_run`**，跟在**實測跑得到**的 host 後面；cron 一行不刪當備援
- 四條設計：host 名字**完全一致**（差一字永遠不觸發且零訊息）／ host 必須實測跑得到 ／
  cron 不刪 ／ job 只跟 host 的**排程**那一輪 → `python3 scripts/test_wf_quota.py`
- 高頻的改成「排 1 次、自己在 job 裡迴圈」（`scripts/intraday_window.py` + `once()`）
  → `python3 scripts/test_intraday_loop.py`（六條不可改掉的設計，37 條測試釘住）
- 🚨 夜盤採礦的 host **必須落在夜盤時段**，白天跑會把日盤寫成「夜盤」

---

## ⑥ 部署沒動的兩種情況（⛔ 是兩件事）

| 現象 | 判讀 |
|---|---|
| `run.conclusion=failure` 但 `job.conclusion=cancelled` 且**用量 0 ms** | GitHub 配不出 runner，**不是程式的問題** |
| job 有跑、有 log、有失敗訊息 | 才是程式的問題 |

deploy job 有守門：採礦結果 `STOCKS < 100` 會 `exit 1` 拒絕 force-push
→ 「workflow success 但 gh-pages 沒更新」先看有沒有這條訊息。

---

## ⑦ 加新採礦產物時的連動清單

1. 加進 `daily_miner.yml` 的 artifact `path:` 清單（註解寫在 `path: |` **那一行之上**）
2. deploy 的 `git archive origin/data` 會保留 append 類檔
3. 前端 fetch 用動態 `ghBase` + `?t=${Date.now()}`
4. 加進 `scripts/data_audit.py` 的 `EXPECTED_KEYS`（多區塊的檔）
5. 前後端欄名 **grep 雙向**確認完全一致

---

## ⑧ 兩條鐵則

- **「腳本 rc=0」不等於「功能有跑」** → 新增採礦函式後去 gh-pages 確認檔案真的出現：
  `git show origin/gh-pages:data/x.json | wc -c`
- **任何「今天已處理過就跳過」的快取**，判斷式要綁「**資料的日期**」不是「處理的日期」（陷阱 #10）
