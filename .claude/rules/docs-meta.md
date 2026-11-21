---
paths:
  - "docs/**"
  - ".gitignore"
  - ".claude/rules/**"
  - "CLAUDE.md"
---
# 決策紀錄放哪 / CLAUDE.md 本身的規則

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 2498~2541 行 -->
## 📚 完整決策紀錄在哪(⭐ 本檔只留「現行規則」)

CLAUDE.md 原本 10,737 行 / 50.7 萬字元(約 38~50 萬 token)→ **超過 context window**,
每個 session 一開場就把額度吃光,講沒幾句就 `Prompt is too long`。

→ 2026-09-09 把 **211 個章節 / 9,035 行**搬進 `docs/`,**一個字都沒刪**:

| 檔案 | 內容 | 章節數 |
|---|---|---|
| `docs/DECISIONS.md` | 版本歷程・回測結論・踩過的坑 | 188 |
| `docs/EXTERNAL_REVIEWS.md` | 外部參考資料評估紀錄 ①~㉕ | 24 |
| `docs/INDEX.md` | 上面兩份的章節索引(2026-10-17 搬來) | — |
| `docs/PROBES.md` | 探針登記表(2026-10-17 搬來) | — |

⛔ **本檔留的是「下次寫程式會用到的規則」**:鐵律・四驗證・40 條陷阱清單・部署規則・
UI 規範・使用者偏好・資料體檢・連動檢查清單(探針登記表與決策索引 2026-10-17 搬去 `docs/PROBES.md` / `docs/INDEX.md`)。

⭐ **要查「這題以前測過沒 / 為什麼當初這樣決定」→ 去 `docs/` 那兩個檔 grep**。
⚠️ 新增決策紀錄一律寫進 `docs/DECISIONS.md`,⛔ 不要再往 CLAUDE.md 累加
(那正是它漲到 50 萬字元的原因)。

### ⛔⛔ 鐵則:`CLAUDE.md` **不可以加進 `.gitignore`,也不可以移出版控**
(2026-09-11 評估紀錄㉕:有外部建議叫我們這樣做,照做會直接弄壞整個工作流)

🚨 **Claude Code on the web 每個 session 是靠 repo 裡的這個檔載入專案規則的** ——
移出版控 = **四驗證、41 條陷阱、燈號鐵則、部署規則、連動檢查清單當場全部消失**。

⛔ 那個建議的理由(「GitHub Pages 的儲存庫是公開的,不排除的話架構筆記會公開」)**三層都錯**:
- **`.gitignore` 不會讓已經 push 出去的東西消失**(還在 git 歷史裡)→ 目的根本沒達到。
- **歸因錯**:公開的原因是 **repo 本身是 public**,跟 Pages 無關;而且
  **main 分支的內容從來不會被部署到網站**(`deploy_pages.yml` 只覆蓋 `index.html` + `sw.js`)。
- ⭐⭐ **顧慮本身是假的**:所有判定邏輯與回測成績(`_SIGNAL_EDGE` / `_STREAK_EDGE` /
  `_DECK_TRACK49` / `_SCR_EDGE`…)**本來就嵌在公開的 `index.html` 裡**,那份才是真的掛在網站上。
  藏 `CLAUDE.md` = **假隱私、真代價**。

✅ 真正要守的是**金鑰**,而這條早就做對了(⛔ key 絕不硬編,全在 GitHub Secrets)。
⛔ 同理**不新增 `PROGRESS.md`** —— 本檔(現行規則)+ `docs/DECISIONS.md`(含待辦盤點)
已經是兩個地方,再開第三個就是使用者最討厭的「邏輯不打架」的反面。進度寫進 `docs/DECISIONS.md`。

---

### 📇 決策紀錄索引 → `docs/INDEX.md`(2026-10-17 搬出去,一個字沒刪)
⭐ 要查「這題以前做過 / 測過沒」→ `grep -n 關鍵字 docs/INDEX.md`(或直接 grep `docs/DECISIONS.md`、`docs/EXTERNAL_REVIEWS.md`)。
新增決策紀錄:`docs/DECISIONS.md` 加一節 + `docs/INDEX.md` 最上面補一行 —— ⛔ 不再往本檔加索引行(它曾把本檔撐到 602KB)。

