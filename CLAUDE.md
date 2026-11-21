# StockAI-DB — Claude Code 專案說明

## 專案是什麼
台股 AI 終端機，單一 `index.html` 靜態網站 + Python 採礦機，部署在 GitHub Pages。
網站網址：`https://xin7355-collab.github.io/StockAI-DB/`

> 📏 **這份只放每個任務都用得到的規則**(上限 200 行,`scripts/check_claude_md.py` 守門)。
> 其他照主題放在 `.claude/rules/*.md`(讀或改到對應檔案時自動載入)與 `docs/`(要用時 grep),索引在最下面。
> 2026-11-21 從 2,541 行的舊版搬出:**只搬位置、一個字沒刪**(逐行比對 0 行遺失)。新規則照主題寫進那幾個檔,⛔ 往這份累加。

---

## 開發分支
**直接在 `main` 分支開發**。GitHub Actions cron 排程只從 default branch（main）讀取，
若開新分支會導致採礦機無法用到最新程式碼。
手動觸發時，永遠選 **`main`** 分支。

### 🤝 多個工作階段同時開發(2026-11-12 使用者明示:另一個工作階段也在改同一個 repo)
1. **動手前**:`git fetch origin main` → 分支先合 `origin/main`(或從它重開),⛔ 在落後的分支上改完才合。
2. **推之前再同步一次**:fetch → 合 main → 衝突照「Merge conflict」規則解(⛔ rebase / force-push 別人的東西)→ 四驗證 → ff 推 main;推被拒 = 別人剛推,重來一次。
3. **版號**:照「推的當下 origin/main 的 `_APP_VERSION`」往上加,⛔ 照自己分支上的;撞號就改下一號(V80.1.8 → V80.1.9 前例)。`_CHANGELOG` 搬移與 CHANGELOG.md 開頭計數跟著最新那份算。
4. **實驗登錄**:`exp_log.mjs pre` 之前先合 main(編號 = 日期 + 當天第幾筆,⛔ 各自從舊檔數);合併時 experiments.ndjson 兩邊的行都留(只增不改)。🧪 V82.2.5 起 pre 一定要附 `--bias`(14 條偏誤檢查,`node scripts/exp_log.mjs bias` 拿範本;不適用寫 `na:理由`)。
5. **抓官方資料互斥**:派 tw_deep04 / block_deep / 任何打證交所・櫃買・期交所的回補前,先 `actions_list` 看有沒有 in_progress / queued 的同類 run,有就不派(排程叫醒的也一樣)。
6. **排程**:建 send_later / scheduled task 前先 `list_triggers`,⛔ 兩邊各排一個做同一件事。
7. **實測總表 / 文件**:同一個主題鍵 `k` 只能一條(`test_labkey`)→ 合 main 後先 grep 那個 k 有沒有被另一邊改過,改它而不是新增。

- 🧹 (2026-11-21 使用者交代)⛔ `git stash`(另一個工作階段的改動會被你收走或還原錯地方)、⛔ `git add -A` / `git add .`(會把別人的檔或測試資料一起帶進去)→ 一律 `git add <檔名>`;`.claude/` 在 `.gitignore` 裡,新增規則檔 / Skill 要 `git add -f`。
- 🔀 合併有衝突:兩邊的行都留(實驗登錄 / 實測總表只增不改),同一個主題鍵 `k` 只留一條;CLAUDE.md 與 `.claude/rules/` 照意思併到現在的位置(⛔ 用舊版蓋掉)。
- 分支架構(main / data / gh-pages / ptt_meta 四個分支各寫什麼)→ `.claude/rules/deploy.md`。
---


## 授權與「只剩三件先問」
### ⭐ Claude 永久授權（使用者明示:看不懂程式碼,壞了再修就好）
- **純前端 / 小邏輯改動完成、四驗證通過後**：**不需問使用者**,直接 `git checkout main && git merge <feature-branch> --ff-only && git push origin main`,讓 `deploy_pages.yml` 自動上線
- **採礦 `*.py` 改動**:同上,直接 merge main + push,由 `daily_miner.yml` 接手
- **無需先開 PR**;若 web session 開在 feature branch,完成就 fast-forward 合併回 main(先合最新 origin/main,見「🤝 多個工作階段同時開發」)
- 🏃 **2026-10-23 使用者明示:「你就直接一直做下去就好」(不要一直停下來要我確認)** → 改 workflow、改採礦、大改版面、動 `data/` 快取都**直接做**,做完回報「做了什麼 + 怎麼換回」。
- ⛔ **只剩三件仍須先問使用者**(做錯了沒辦法用 `git revert` 救回來):① **會動真錢的開關**(自動下單真實帳戶,例如 `PARK_LIVE_OK`、`LIVE`)② **刪掉使用者自己存的資料 / 不可回復的刪除**(例:IndexedDB 的貼上報告、AI 圖,或 force-push 蓋掉別人的東西)
  ③ 🔏 **2026-11-11 使用者決定(SELF_EVOLVING_AUDIT §10 ①)**:換版會改到 `auto_trade.py` / `lib_leader.py` / `lib_hotrule.py` / `scripts/lib_leaddd.mjs` 的**策略參數**(門檻・預設・錨點・規則)→ 先照 `docs/RELEASES.md` 寫發布報告、在對話裡問,核准後才更新 `research/approved_live.json`(⛔ 自己改它讓測試變綠);App 那邊的同一個預設**一起等**。守門 `scripts/test_release_gate.py`(四驗證)。程式修 bug 不算(修復 ≠ 優化)。
- ⚠️ 雲端 session 的「Plan(計畫)」模式本來就會停下來等核准、排程工具(send_later / update_trigger)在 Auto 模式也可能被攔 —— 那兩個不是 CLAUDE.md 管得到的;要不被問,使用者在輸入框旁的下拉選單選「Auto」,並自己把 `permissions.allow` 寫進 `.claude/settings.json`(Claude 自己改那個檔會被安全檢查擋下,⛔ 不可繞過)
- 壞了 → 使用者說「壞了」→ Claude 直接修;或 `git revert HEAD` 回退


---

## 使用者偏好

### 溝通風格
- **語言**:繁體中文回答(永遠不英文)
- **風格**:**直接做別問**,不要長篇解釋,重點條列;一次回多件事用編號 + 短句
- **問問題時機**(2026-10-23 更新,使用者:「直接一直做下去就好」):**只有三件先問** —— ① 會動真錢的開關 ② 刪掉使用者自己存的資料 / 不可回復的刪除 ③ 會改到 auto_trade 下單參數的換版(🔏 發布報告,詳見上面「Claude 永久授權」)。其他(含架構大改、改 GitHub Actions、動採礦邏輯)直接做、做完回報怎麼換回;拿不準的取捨挑一個合理預設先做,回報時寫出來。連「需要繼續嗎/部署嗎/版本要不要 bump」都不用問
- **使用者性格**:看不懂程式碼,壞了再說;Claude 永久授權 push main 直接 deploy

- **回報格式**:驗過的 / 沒驗到的分開寫;做了什麼 + 怎麼換回;拿不準的取捨挑合理預設先做,回報時寫出來(全文 `.claude/rules/app.md`「使用者偏好」與 `.claude/rules/deploy.md`)。
- **數字**:任何 % 順便給實際金額(`+1,250 元(獲利)`)、千分位;燈號 🔴🟢 只講漲跌方向,風險一律 ✅⚠️⛔🚨(全文 `.claude/rules/app.md`「UI 風格」)。

---

## 金鑰與隱私
### Key 放哪(架構)
- **前端 localStorage**(設定頁):Fugle/FinMind/Massive/AI — 你手機即時抓用
- **GitHub Secrets**(`FINMIND_TOKENS` 逗號分隔/`MASSIVE_API_KEY`/`GROQ_API_KEYS`):採礦機 bulk 資料用,GitHub IP 跑(天然 IP 分離,不害你家 IP 被擋)
- ⛔ key 絕不硬編進 index.html(gh-pages 公開=等於貼到網路)

---
- ⛔ `CLAUDE.md` 不可加進 `.gitignore` / 移出版控(雲端每個 session 靠它載入規則;真正要守的是金鑰)→ 全文 `.claude/rules/docs-meta.md`。
- ⛔ 使用者的名字 / Email / 專案資料不可放進打給外部服務的請求(標頭、網址、內容)。

---

## 發版流程(每次 push main)
1. **合 main**:fetch → 合 `origin/main` → 再看一次 `_APP_VERSION`(照 origin/main 的往上加,撞號就下一號)。
2. **版號三段式** `V大.中.小`:小改末位 +1、逢 9 進位、大改個位 +1;四處同步 —— 版本註解(~L18,只留當前版本號)、設定 badge、`_APP_VERSION`、`_CHANGELOG` 最前面一筆(commit 開頭寫「V舊 → V新」)。全文 `.claude/rules/deploy.md`「版本號規則」。
3. **`_CHANGELOG` 那一筆是散戶 App 跳窗內容**:白話、⛔ 研究數字 / 實測字樣 —— 要過 `scripts/lib_retailbad.mjs` 的 `badOf`(`test_retail_clean` 會掃);App 內只留最近 60 筆,更早的搬 `CHANGELOG.md`。
4. **四驗證**:`python3 scripts/run_fourcheck.py`(清單 `scripts/fourcheck.txt`,每條用意 `docs/FOURCHECK.md`;先 `bash scripts/fetch_testdata.sh` 取測試資料,取完 `git status` 不該看到 `data/` 有變動)。新守門加一行進 `fourcheck.txt` + 說明寫進 `docs/FOURCHECK.md`。測試紅燈先分類再修(`.claude/rules/testing.md`),⛔ 改測試把真因蓋掉。
5. **推**:`git checkout main && git merge <分支> --ff-only && git push origin main`(被拒 = 別人剛推,重來一次)。推採礦 push paths 裡的檔之前先看有沒有排程那輪 daily_miner 在跑(`.claude/rules/workflows.md`)。
6. **部署後比版本號**(⛔ 比 md5):`_v(){ git show "$1:index.html" | grep -oE "_APP_VERSION: ?['\"]V[0-9.]+" | head -1 | grep -oE "V[0-9.]+"; }; diff <(_v origin/gh-pages) <(_v origin/main) && echo "✅ 已上線"`;回報「開著的分頁最久約 10 分鐘自動換新版,iOS PWA 可能要完全關掉重開」。全文 `.claude/rules/deploy.md`「部署後看到舊版」。

---

## ⛔ 清單(做錯了 revert 救不回來)
- ⛔ 動真錢開關:`PARK_LIVE_OK`、`LIVE`、任何自動下單真實帳戶的設定 → 先問使用者。
- ⛔ `auto_trade.py` 不可被任何 workflow 執行或 import(`check_workflow_paths.py` 的 `NEVER_IN_CI` + `test_no_trade_ci.py` 擋)。
- ⛔ 自己改 `research/approved_live.json` 讓 `test_release_gate.py` 變綠 —— 改到下單策略參數先寫 `docs/RELEASES.md` 發布報告問使用者。
- ⛔ 改或繞過 `.claude/settings.json`(安全檢查擋下就停,請使用者自己加 `permissions.allow`)。
- ⛔ 刪使用者自己存的資料(IndexedDB 的貼上報告 / AI 圖、賣出紀錄、心情日誌)、⛔ force-push 蓋別人的東西。
- ⛔ hotfix `git push … gh-pages --force`(下一輪部署會蓋掉);⛔ 新增第二支「只部署前端」的 workflow。
- ⛔ 金鑰寫進 `index.html` / 任何公開檔(gh-pages 是公開的)。

---

## 散戶 App 與研究的鐵則(一行摘要,全文在規則檔)
- 🧹 **V78.3.4 散戶 App(index.html)畫面 ⛔ 不放實測 / 回測文字**,只講「怎麼做」;研究成績一律寫在產業作戰室(pro.html)LAB。例外只有清單上那幾個(V79.8.4 頂端「產」鈕、V79.8.6 / V79.8.7 發生率、V81.0.0 每年報酬、V82.0.0 大跌撿便宜、V82.5.0 日子機率),各有固定寫法與測試 → `.claude/rules/app.md`「🧹 V78.3.4 鐵則」。守門 `test_retail_clean.mjs`。
- 🔓 **V78.4.2 有價值的進階功能統一放「連點版本號 5 次」解鎖區**(`_DECK_SECTIONS` 標 `unlock:true`、照重要度排、能併就併)→ `.claude/rules/app.md`。
- 🔒 **沒選 👑 的人畫面 ⛔ 出現領頭羊字樣**(`test_leakfree.mjs`)→ `docs/LINKAGE.md`「會下買賣指令 / 會推播」那一列。
- 🔁 **策略預設「比較好就直接換」有五個條件 + 換完必做四件**;會改到 auto_trade 下單參數的整包改成發布報告等核准 → `.claude/rules/strategy.md`。
- 🧪 **實驗登錄**:新探針先 `node scripts/exp_log.mjs pre …`(要附 `--bias`,14 條偏誤檢查)再跑;`research/experiments.ndjson` 只增不改;樣本外封存 2026-11-07 之後的資料只拿來驗 → `.claude/rules/lab.md`、`docs/FOURCHECK.md`(test_exp_registry)。
- 📋 **實測總表(pro.html `PRO.LAB`)**:每次回測結論同步寫進去、附數字 + 來源探針;同一主題鍵 `k` 只一條(先找來改,⛔ 開新卡);ok / trap 必帶 `r`、`pl`、新條目帶 `tries`;有價值的寫成專欄 `col`(含 `trig`、`fig`)→ `.claude/rules/lab.md`。
- 🗣️ **邏輯不打架**:同一名詞全 App 只有一個數字;會講「進場 / 加碼」的卡先過 `_bearGate(sym)` 與 `_mktGate()` → `.claude/rules/app.md`「使用者近期反覆強調的鐵則」。
- 🤖 **禁 AI 算數**:均線 / 營收年增 / 乖離一律 JS 或 Python 算好再塞進提示詞 → `.claude/rules/app.md`「AI 分析風格」。

---

## 做什麼事 → 看哪個檔
| 要做的事 | 看這裡(規則檔會在讀 / 改對應檔案時自動載入) |
|---|---|
| 改 `index.html` 畫面 / 卡片 / 文案 | `.claude/rules/app.md`、`.claude/rules/ui.md`;Skill `/uicard` |
| 改任何會連動的資料 / 欄位 / 共用函式 | `.claude/rules/linkage.md`(觸發清單)→ `grep -n '關鍵字' docs/LINKAGE.md` 讀那一列全文 |
| 改產業作戰室 `pro.html` / 釣魚 | `.claude/rules/pro.md`、`.claude/rules/ui.md` |
| 回測 / 探針 / 實測總表 / 專欄 | `.claude/rules/lab.md`;Skill `/probe`;`docs/PROBES.md` |
| 換策略預設 / 動 auto_trade 參數 | `.claude/rules/strategy.md`;`docs/RELEASES.md` |
| 改採礦 `*_miner.py` / `lib_*.py` / 資料回算 | `.claude/rules/mining.md`;Skill `/mining` |
| 資料體檢 / 「某個檔怪怪的」 | `.claude/rules/data-audit.md`;Skill `/audit` |
| 改 GitHub workflow / 排程配額 / Worker / Telegram 叫醒 | `.claude/rules/workflows.md` |
| 部署 / 版本號 / 分支 / SW 快取 | `.claude/rules/deploy.md`;Skill `/ship` |
| 寫測試 / 修 bug / 巡邏工具 | `.claude/rules/testing.md`;陷阱清單 `docs/TRAPS.md`(68 條,grep 編號) |
| 四驗證清單與每條的用意 | `scripts/fourcheck.txt`、`docs/FOURCHECK.md` |
| Skill / 代理清單 | `.claude/rules/skills.md`、`.claude/skills/README.md` |
| 「以前測過 / 為什麼這樣決定」 | `docs/INDEX.md` → `docs/DECISIONS.md`、`docs/EXTERNAL_REVIEWS.md`;舊盤點 `docs/CLAUDE_HISTORY.md` |
| 決策紀錄放哪 / 文件規則 | `.claude/rules/docs-meta.md`(新決策寫 `docs/DECISIONS.md` + `docs/INDEX.md`,⛔ 往這份加) |
