# 🧩 這個專案有哪些 Skill（給使用者看的速查表）

**Skill = 說明書**（符合情境時 Claude 自動載入，也可以打 `/名字` 直接叫）
**代理 = 分身**（可以同時派好幾個平行做事）

---

## 5 支 Skill

| 打什麼 | 什麼時候用 | 它會做什麼 |
|---|---|---|
| `/ship` | 「可以推了嗎」「上線」「發佈」 | 四驗證 → 版本號同步五處 → commit → push main → **部署後用版本號確認真的上線了** |
| `/probe` | 「這個策略有沒有用」「幫我回測」 | 先查以前測過沒 → 寫探針（防前視偏誤）→ **六道關卡** → 結論當場寫進實測總表並歸類 |
| `/audit` | 「跑資料體檢」「巡邏」「找 bug」 | 資料體檢六類 + 四支巡邏工具 → **逐條人工驗真偽（約 1/3 是誤報）** → 分批修 |
| `/mining` | 「採礦沒跑」「資料停在舊日期」 | ① 先問有沒有被觸發過 ② 看產物日期 ③ 確認那個日期是誰的 ④ 才查程式 |
| `/uicard` | 「加一張卡」「改版面」「改文案」 | 燈號鐵則 + 兩道守門 + 共用函式清單 + 連動檢查 + 390px／橫版驗證 |

## 2 支代理

| 名字 | 什麼時候用 |
|---|---|
| `scout`（`.claude/agents/scout.md`） | 要**同時**掃前端／採礦／workflow 找 bug 時，一次派 2~3 個，只回「問題 + 行號 + 失敗情境 + CONFIRMED/SUSPICIOUS」 |
| `financial-analyst`（`.claude/agents/financial-analyst.md`） | 「幫我整理某一檔的財報數字」—— 先讀本站 `data/fin` 切片、本站沒有才上網；每個數字附季別與來源、查不到寫 null，⛔ 不評分不給買賣。網頁版是產業作戰室「📑 財報」分頁（同一份資料） |

## 1 支既有的 slash command（⛔ 不要再包一支同樣的 Skill）

| 名字 | 用途 |
|---|---|
| `/finmind` | 查 FinMind 的資料集與欄位（`.claude/commands/finmind.md`） |

---

## ⛔ 刻意**不**做成 Skill 的（做了會出事）

| 想加的 | 為什麼不要 |
|---|---|
| 「查 FinMind 資料」 | 已經有 `/finmind`，兩支描述太像會互相搶（同「⛔ 不要再新增第二支只部署前端的 workflow」） |
| 把 CLAUDE.md 包成一支 | CLAUDE.md **每個 session 本來就完整載入** → 會變成兩份真相，改一邊會忘另一邊 |
| 「UI 設計規範」單獨一支 | 那是**查表**不是**流程** → 已併進 `/uicard` |
| 「修 bug」單獨一支 | 觸發詞跟 `/audit` 幾乎一樣（檢查／巡邏／找 bug）→ 一定會選錯 → 已併進 `/audit` |
| 「使用者偏好／講話風格」 | 那是 CLAUDE.md 的工作，重複寫等於多一個會過期的地方 |
| 每支測試各一支 | 專案有 290 支 scripts，各開一支等於永遠選不到對的那支 |
| 「自動下單」 | 🔐 那支會動真錢，⛔ 不做成自動觸發的東西 |

---

## 🛠️ 怎麼自己改 / 自己加一支

1. 建資料夾 `.claude/skills/<名字>/SKILL.md`
2. 檔案最前面是 YAML frontmatter，**只有兩個必填**：
   ```yaml
   ---
   name: 名字（要跟資料夾同名，小寫、可含 -）
   description: 什麼時候該用這支（← 這句就是「提示詞」，決定它何時被叫出來）
   ---
   ```
3. 底下寫**步驟 + 指令**，並在需要細節的地方**指向 CLAUDE.md 的哪一節**
   （⛔ 不要把 CLAUDE.md 的內容複製過來）
4. 每支都要有一段「**⛔ 這支不做什麼**」—— 邊界寫清楚，兩支才不會搶同一件事
5. 一支控制在 **60~120 行**（超過通常就是在複製 CLAUDE.md）
6. 改完跑：
   ```bash
   node scripts/test_skills.mjs
   ```
   它會擋下三件事：frontmatter 不合法 ・兩支 description 太像 ・
   **Skill 裡提到的腳本檔名根本不存在**（腳本改名後 Skill 會開始教錯的東西，而沒有人會發現）

---

## 📦 外部技能（從 skl 技能庫裝進來的，2026-09-24 / 2026-10-07）

用 `xin7355-collab/skl` 的 `bootstrap_app.py install --skills … --no-hook` 裝的，清單在 `.claude/skills/.skl-vendor.json`。
⛔ **不要直接改這幾支的內容** —— 下次 update 會被蓋回去；要改就去 skl 改。

| 技能 | 為什麼留著 | ⛔ 不拿來做 |
|---|---|---|
| `senior-data-scientist` | 回測的統計方法：多重比較校正、信賴區間、資料洩漏 / 過度擬合檢查、基準對照 | 流程照 `/probe`；它教的 XGBoost / MLflow ⛔ 不套（`ml_probe` 已實測 ML 沒有樣本外預測力） |
| `senior-prompt-engineer` | 餵給 AI 的提示詞（報告、做圖、新聞翻譯、純 JSON）：`scripts/prompt_optimizer.py` 量長度、冗詞，並跟上一版比對 | ⛔ 不拿來改 AI 模型分工（CLAUDE.md 已定案） |
| `app-guardrails-audit` | 安裝器**一定會裝**；查 OOM、SQLite 鎖、API 限流與退避、金鑰進網址、工作流逾時 | 資料體檢與巡邏仍是 `/audit`；它是靜態掃描，每一條都要人工驗真偽 |
| `sql-database-assistant` | `miner.py` 的 SQLite(`stock_hunter.db`,WAL):查詢、索引、鎖死排查 | ⛔ 不拿來改資料結構 / 加 migration —— 那份庫每輪都由 JSON 重建(`seed_db_from_json`),是丟棄式中介庫 |
| `llm-cost-optimizer` | AI 額度:提示詞長度、`max_tokens`、快取(Gemini / Groq / OpenRouter) | ⛔ 不拿來改 AI 模型分工(CLAUDE.md 已定案);⛔ 不叫你改用 Claude API |
| `strict-api` | 寫程式前先確認函式 / 套件版本真的存在(Shioaji 釘 `<1.7`、FinMind 資料集名曾猜錯) | ⛔ 不取代「先實跑再下結論」 —— 它只管 API 存不存在 |

**2026-10-07 那次跳過的 9 支**(使用者點名 12 支,只裝 3 支):

| 技能 | 為什麼不裝 |
|---|---|
| `env-secrets-manager` | 安裝器的安全掃描沒過(PROMPT-EXFIL)⛔ 不用 `--no-security-scan` 硬裝;改成實際查一次歷史(見 DECISIONS 2026-10-07) |
| `security-guidance` | 本體是 PreToolUse hook,安裝器只會複製說明檔(hook 不會接上);就算接上,它看到 `.innerHTML =` 就擋,index.html 有上千處 |
| `database-designer` | 選 SQL/NoSQL、設計 schema、migration —— 本 repo 的 SQLite 是每輪重建的中介庫 |
| `api-design-reviewer` / `api-test-suite-builder` / `senior-backend` | 本 repo 沒有對外 REST API(`api.py` 沒接上、`cloud-worker` 是排程 + Telegram) |
| `cost-aware-llm-pipeline` | 整篇是 Anthropic SDK 範例,本站沒用 Claude API;主題跟 `llm-cost-optimizer` 重疊 |
| `prompt-optimizer` | 綁 ECC 生態(對應 ECC 的 skills/commands);改提示詞已有 `senior-prompt-engineer` |
| `oil-ui` | 新介面一律要做三處動效 + 滾動敘事、推銷付費版;跟 CLAUDE.md 的 UI 規範(無框、克制動畫、終端機密度)衝突,設計判斷已有 frontend-design 外掛 |

`scripts/test_skills.mjs` 對這幾支**只檢查** name / 描述相似度 / 撞名，
不要求「⛔ 這支不做」與行數，因為那是本專案寫技能的規範；而專案自己的 5 支**不可**列進那份清單。

**更新**：
```bash
(git -C /tmp/skl pull -q || git clone -q --depth 1 https://github.com/xin7355-collab/skl /tmp/skl)
python3 /tmp/skl/xin-toolkit/skills/app-bootstrap/scripts/bootstrap_app.py update --target . --no-hook
```
