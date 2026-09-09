#!/usr/bin/env bash
# 把 origin/gh-pages 上的**真實採礦產物**取到本地 `data/`,讓測試驗得到東西。
#
# ⭐ 為什麼需要(2026-09-09):`data/*.json` 與 `data/chips/` 在 main 是 gitignore
#    (只有採礦機會產出)→ **開發/沙箱環境本地是空的**,實測只有 3 個 json、chips 0 個。
#    後果:123 支 mjs 測試裡 **26 支永遠紅**(讀到空 JSON / screener n=0),
#    而 CLAUDE.md 鐵則寫著「永遠紅的測試等於沒有測試」——誤報會讓人養成無視守門的習慣。
# ⛔ 解法不是改那 26 支測試(那是改症狀),是**把資料備齊**。
# ⚠️ data/ 有 gitignore 擋著,取下來⛔ 不會進 commit。
set -euo pipefail
cd "$(dirname "$0")/.."
echo "📥 從 origin/gh-pages 取真實採礦產物…"
git fetch origin gh-pages --quiet
git archive origin/gh-pages data/ | tar -x
echo "✅ data/*.json     : $(ls data/*.json 2>/dev/null | wc -l) 檔"
echo "✅ data/chips/*.json: $(ls data/chips/*.json 2>/dev/null | wc -l) 檔"
