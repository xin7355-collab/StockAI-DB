---
paths:
  - ".claude/skills/**"
  - ".claude/agents/**"
  - ".claude/commands/**"
---
# 這個專案的 Skill 與代理

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 2472~2497 行 -->
## 🧩 這個專案有哪 5 支 Skill + 1 支代理(2026-09-09)

⛔ **本節只留索引,內文在各自的檔案裡** —— 同「決策紀錄搬去 `docs/`」的理由。
完整說明與「怎麼自己加一支」見 **`.claude/skills/README.md`**。

| 打什麼 | 何時用 | ⛔ 這支不做 |
|---|---|---|
| `/ship` | 要 push / 上線 / 發佈 / bump | 改功能本身、開 PR |
| `/probe` | 「這個策略有沒有用」「幫我回測」 | 改 App 判定邏輯、動採礦 |
| `/audit` | 跑資料體檢 / 巡邏 / 找 bug | 把誤報也修掉、放寬斷言 |
| `/mining` | 採礦沒跑 / 資料停在舊日期 / workflow 全綠卻沒東西 | 改 workflow(那要先問使用者) |
| `/uicard` | 加卡片 / 改版面 / 改文案 | 改判定門檻(要先回測) |
| 代理 `scout` | 同時掃前端/採礦/workflow 找 bug | 改任何檔案(它只回清單) |

📦 **另有 7 支外部技能**(skl 技能庫裝的:`senior-data-scientist` / `senior-prompt-engineer` / `app-guardrails-audit` / `llm-cost-optimizer` / `strict-api` / `dependency-auditor` / `context-budget`;2026-10-17 移除 `sql-database-assistant`)——
⛔ 不要直接改內容(update 會蓋回去),說明與更新指令見 `.claude/skills/README.md` 最後一節。

⛔ **三條不可違反的設計**(`scripts/test_skills.mjs` 釘住):
- ⛔ **Skill 不可複製 CLAUDE.md 的內容** —— 本檔每個 session 都完整載入,複製 = 兩份真相。
  Skill 只寫「步驟 + 指令 + **指向本檔哪一節**」,一支控制在 60~120 行。
- ⛔ **不可新增跟 `.claude/commands/finmind.md` 功能重疊的 Skill** —— 描述太像會互相搶
  (同「⛔ 不要再新增第二支只部署前端的 workflow」)。
- ⛔ **`.claude/` 在 `.gitignore` 裡** → 新增 Skill 一律 `git add -f`,否則**只活在你這台機器上**。

---


