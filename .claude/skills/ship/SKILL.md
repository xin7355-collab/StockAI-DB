---
name: ship
description: 把改動安全送上線。要 push、部署、上線、發佈、bump 版本，或問「這樣可以推了嗎」時使用。涵蓋四驗證、三段式版本號同步四處、commit、push main，以及部署後用版本號確認 gh-pages 跟 main 一致。
---

# 上線流程（ship）

⛔ **這支不做**：改功能本身、決定要不要 bump（**一律 bump**）、開 PR（使用者已永久授權直接 push main）。

---

## ① 四驗證（⛔ 一項都不能跳，全部要 rc=0）

```bash
node scripts/smoke_test.mjs                     # 1. headless 真載入
python3 -m py_compile *.py                      # 2. 後端語法
python3 scripts/check_main_order.py             #    進入點順序（陷阱 #9）
python3 scripts/check_workflow_paths.py         #    artifact 有沒有真的收（陷阱 #11、#12）
python3 scripts/check_undefined_py.py           #    潛在 NameError
python3 scripts/check_dup_def.py                #    重複定義同名函式
python3 scripts/check_env_default.py            #    inputs.* 環境變數要 or 預設
python3 scripts/test_no_token_leak.py           #    金鑰片段不可進公開 log
python3 scripts/check_dom_ids.py                # 3. DOM id 唯一性
node scripts/check_dup_key.mjs                  #    物件字面量重複鍵
```

4. **HTML div 平衡**（只要動過 `index.html` 的 HTML 結構就必跑）— awk 指令見
   CLAUDE.md「**驗證 HTML div 平衡腳本**」那一段，正確結果是「tabContentMarket 閉合於 L20XX」。

⚠️ 改到哪一塊就順便跑那一塊的測試（`ls scripts/test_*` 找對應的）。
⚠️ 測試紅燈**先分類再修**：本地沒有採礦產物 → `bash scripts/fetch_testdata.sh`；
斷言釘住了「當時的實作」→ 改成釘**用意**。⛔ 不可為了變綠而放寬斷言。
🚨 注入驗證的每一輪之間要 `find . -name __pycache__ -exec rm -rf {} +`。

---

## ② 版本號 bump（三段式 `V 大.中.小`，⛔ 四處＋pro 一處要同步）

小改 → 末位 +1；小位滿 9 → 進中位歸 0；大改 → 首位 +1、後兩位歸 0。

| # | 位置 | 確認指令 |
|---|---|---|
| 1 | `index.html` 第 18 行版本註解 | `sed -n '18p' index.html` |
| 2 | 置頂 badge | `grep -c '>V新版</span>' index.html` → 必須 = 1 |
| 3 | JS `_APP_VERSION` | `grep -n "_APP_VERSION" index.html` |
| 4 | `_CHANGELOG` **陣列最前面**補一筆 `{ v:'V新版', d:['白話簡述…'] }` | `_CHANGELOG[0].v` 必須 == `_APP_VERSION` |
| 5 | `pro.html` 的 `VER`（產業作戰室，⛔ 最常漏掉的一處） | `grep -n "VER: 'V" pro.html` |

⚠️ `_CHANGELOG` 是使用者跳窗會看到的內容 → 寫**白話**，⛔ 不寫函式名。
⚠️ 筆數超過 ~80 筆時照 CLAUDE.md「`_CHANGELOG` 瘦身」那節搬進 `CHANGELOG.md`（**搬移不是刪除**）。

---

## ③ commit（多行一律用 HEREDOC）

- 訊息開頭寫「**V舊 → V新 <一句話重點>**」
- 修 bug 跟加功能**分開 commit**
- 誤報要在 commit message 寫明「已驗證非 bug」留紀錄
- ⛔ commit message / PR / 程式碼註解**不可出現模型名稱**

---

## ④ push（⛔ 一律 main）

```bash
git push -u origin main
```
網路失敗才重試，退避 2s → 4s → 8s → 16s（最多 4 次）。

- 純前端 `index.html` / `sw.js` / `pro.html` → `deploy_pages.yml` 約 **1 分鐘**
- 採礦 `*.py` / `daily_miner.yml` → `daily_miner.yml` **30~60 分**

---

## ⑤ 部署確認（⛔ md5 比對已作廢 —— 部署產物會壓縮）

```bash
_v(){ git show "$1:index.html" | grep -oE "_APP_VERSION: ?['\"]V[0-9.]+" | head -1 | grep -oE "V[0-9.]+"; }
git fetch origin gh-pages main -q
diff <(_v origin/gh-pages) <(_v origin/main) && echo "✅ 已上線"
```

**版本號相同 = 已上線**；使用者看到舊版只是 SW 快取 / CDN 傳播。
⚠️ push **不一定**會觸發部署（GitHub 配不出 runner 時 job 從沒開始跑）→
沒動就去 Actions → `🚀 部署到 GitHub Pages` → Run workflow（選 **main**）。

---

## ⑥ 回報話術（每次部署後必講）

> 已部署。開著的分頁最久約 10 分鐘自動換新版、切回前景更快，硬重整可立即見效
> （iOS PWA 可能需要完全關閉 App 重開）。

---

## 🚨 push 前要先問使用者的五種例外

① 大規模重構／架構大改 ② 刪檔／刪資料 ③ 改 GitHub Actions workflow 邏輯
④ 動 `data/` 內快取 ⑤ 不確定會不會壞。
其餘（純前端、小邏輯、採礦小改）**直接做，⛔ 不用問**。

🔐 `auto_trade.py` 與 `SJ_CA_*` / `PERSON_ID` **絕不可進 CI**；金鑰⛔ 不可硬編進 `index.html`。
