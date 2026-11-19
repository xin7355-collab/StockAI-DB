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
# 🛟 2026-11-19 data/ 裡有幾個檔是**有版控的**(manual_events / signal_edge / scr_edge / day_facts,.gitignore 用 ! 開的例外)。
#    上面那一行會把它們蓋成 gh-pages 那一份 —— 而 gh-pages 要等下一輪採礦才會跟上 main,所以常常是**舊的**:
#    實例:main 剛補了 12/25 休市那一筆,取完測試資料就被蓋回去 → test_macro_calendar / test_dayfacts 紅 4 條,
#    看起來像程式壞了,其實是測試資料把原始碼蓋掉。→ 取完一律換回 main 這一份(⛔ 不可留著被蓋掉的版本去 commit)。
tracked=$(git ls-files data | wc -l)
if [ "$tracked" -gt 0 ]; then
  git ls-files -z data | xargs -0 git checkout --
  echo "🛟 data/ 裡有版控的 $tracked 個檔已換回目前分支這一份(⛔ 用 gh-pages 的舊版蓋掉)"
fi
echo "✅ data/*.json     : $(ls data/*.json 2>/dev/null | wc -l) 檔"
echo "✅ data/chips/*.json: $(ls data/chips/*.json 2>/dev/null | wc -l) 檔"
