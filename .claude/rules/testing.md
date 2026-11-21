---
paths:
  - "scripts/test_*"
  - "scripts/check_*"
  - "scripts/smoke_test.mjs"
  - "scripts/page_sweep.mjs"
  - "scripts/card_inventory.mjs"
  - "scripts/fourcheck.txt"
  - "scripts/run_fourcheck.py"
---
# 測試寫法 / 修 bug 流程 / 巡邏工具

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 672~701 行 -->
### 🐛 定期修 bug(V25.2 後新增,使用者要求;V49.5 強化定期節奏)
**節奏鐵則(使用者明示:要定期修 bug)**:
- **每次改功能「順便修 bug」**:做新功能 / 改介面時,若順手看到附近有 bug,一併修掉(分 commit,別混在功能 commit 裡)。
- **每推 3-5 版做一次「主動巡邏」**:跑多代理 bug 掃描(見下),把確認的 bug 分批修。
- 🚨 **注入驗證的每一輪之間要清 `__pycache__`**(V75.1.5 實測踩到):`cp` 還原後 mtime 常在**同一秒**內
  → Python 沿用**上一輪注入版本**的 `.pyc` → 你驗的是上一輪的程式,會得到跟資料矛盾的結論。
  `find . -name __pycache__ -exec rm -rf {} +` 再跑。
- 🚨 **測試紅燈先分類再修**:V75.1.5 一次修 26 支,真 bug 只有 **1 個** —— 其餘是
  ① 本地沒有採礦產物(跑 `bash scripts/fetch_testdata.sh`,⛔ 別去改測試把真因蓋掉)
     (🛟 2026-11-19 這支取完會把 `data/` 裡**有版控的**那幾個檔(manual_events / signal_edge / scr_edge / day_facts)換回目前分支那一份 —— 以前直接被 gh-pages 的舊版蓋掉:測試假紅,而且一不小心就把舊版 commit 回去;取完 `git status` 不該看到 `data/` 底下有任何東西)
  ② 斷言釘住「當時的實作/當天的資料」(⭐ 改成釘**用意**:跟唯一真相來源比對,或用固定測資走那條分支)。
  ④ 📦 讀到**真的採礦產物**裡跟合成情境打架的那一段(2026-11-19 `test_dayfacts`:合成的春節 + 真的 `macro_risk.json` 官方休市表疊在一起 → 「連休 13 天」;⭐ 用合成情境的測試,把會影響它的那一段真資料在載入時拿掉 / 換掉,並加一條空過守門確認真的沒混進來)與**外面的人寫的字**(`test_retail_clean`:新聞標題剛好有「實測」→ 只放行那個固定格式,⛔ 整頁不掃)。
  ③ ⏰ 讀**真的時鐘**(沙箱瀏覽器是 UTC:測資更新後到 UTC 午夜,台北前一天收盤那根會被當成「今天盤中」)→ 把 `_lastBarIsToday` / `_tpeMinutes` 釘住(V79.5.6 `test_dupnum ⓚ`、`test_mktwarn ③d`)。
  ⭐ **永遠紅的測試等於沒有測試** —— 看久了會養成忽略的習慣,真的壞掉那次也會被當成又一個誤報。
- 🚨 **合成測資要「整組」合成**:只換一半(如只換 `_fenPeriods` 卻留著真實 `_fenHist`)會被真實資料汙染,
  分支根本沒走到 = 假失敗/假綠燈。凡是同一個計算會讀到的欄位都要一起換掉。
- 💀 **`git show … > CACHE` 失敗會留下 0 bytes**(shell 的 `>` 先建檔)→ `existsSync` 是 true →
  之後每次讀空檔、**永遠不會自己好**(陷阱 #18/#20 第三次犯案)。測試取雲端測資一律走
  `scripts/lib_ghdata.mjs` 的 `ghJson()/ghJsonOrDie()`(驗內容 → 壞的刪掉重抓 → 拿不到就誠實 exit 1)。
- **多代理審查 + 人工驗證流程(鐵則,V41.27 起實證有效)**:
  1. 派 2+ 個 `Explore` 代理平行掃(前端一組、採礦/workflow 一組),各自只回「確認的 bug + 行號 + 具體失敗情境 + CONFIRMED/SUSPICIOUS」。
  2. **人工逐條讀原始碼驗證真偽** —— 約 1/3 是誤報或設計取捨,**別照單全收**。
  3. 只修「人工確認為真」的,誤報要在 commit message 寫明「已驗證非 bug」留紀錄。
  4. 四驗證 + 分 Batch commit,每個 Batch 版本 +0.1。
- 🚨 **注入驗證要先確認「注入真的注進去了」**(V75.2.6 實測踩到):我把測試字串插進 `seasonModal`
  而不是要驗的 `chartHud`(「布林上軌」四個字在檔案裡出現在**三處**,改到了第一處)→
  「沒抓到」被誤讀成「偵測器有洞」,差點去修一個沒壞的東西。
  ⭐ 注入後先 grep 確認被改的是你以為的那一段(或直接印出那張卡的 innerText)。
- **git/workflow 類 bug 要「實測」不要用猜的**:改 workflow 的 git 流程時,開 `/tmp` 小 repo 實測 `git checkout -f` / `git add -f` / gitignore 交互(如 V49.4 實測 `checkout -f` 可越過 gitignore untracked 衝突),別靠推理。


<!-- 舊 CLAUDE.md 第 1004~1017 行 -->
**修 bug 4 步驟流程**:
1. **重現**:使用者截圖 / console log / 確切操作步驟
2. **診斷**:加 console.log / 黃色 fixed toast / 強制 print 真實狀態(如 V24.9 救命)
3. **對症**:看診斷結果決定改 HTML / CSS / JS / 後端 — 不靠猜
4. **驗證**:四驗證 + 使用者實測一次

**Claude 主動巡邏**:每 5-10 次 push 後 Claude 自己跑一次:
- ⭐ **`node scripts/page_sweep.mjs`(V72.2.2 新增,最有效的一支,先跑這個)**
- 📐 **`node scripts/rwd_audit.mjs`(V76.2.4 擴掃 60 頁;V76.3.2 加「🧱 垂直空間」—— 誰吃掉幾 px 逐項列出,`RWD_ONLY=stock RWD_FONT=medium` 可只跑幾頁迭代)** + 🔠 **`node scripts/font_audit.mjs`(15 頁)** —— ⛔ 兩支都 exit 0、不進四驗證。🚧 它們各有「空過守門」與「shim 自我檢查」:看到 `🚨 版面 shim 有規則沒生效` 或 `掃到 0 個可見元素` 就代表**那一頁的乾淨不算數**,⛔ 不可讀成「沒問題」
- 🧮 **`python3 scripts/check_vol_baseline.py`(V76.1.6 新增)** —— 抓陷阱 #43「基準把被判斷的那幾根自己算進去」;⛔ exit 0、不進四驗證,每次實跑都會印**它自己的盲區清單**
- awk div 平衡(避免新加 HTML 又巢狀)
- grep `silent return` / `return;\s*}\s*$` 找潛在空白 bug
- grep `display:\s*none` 看是否新加 hidden 元素未對應 show 邏輯


<!-- 舊 CLAUDE.md 第 1048~1122 行 -->
### 📋 `scripts/card_inventory.mjs` —— 砍卡之前先「量」(⛔ 不進四驗證,exit 0)
⛔ **憑印象砍卡是危險的**(陷阱 #31 差點砍掉包住活內容的外殼;`_SIGNAL_EDGE` 鐵則也禁止刪 C 級)。
這支只讀不改,量每張卡的:攤開字數 / 摺疊字數 / 有沒有下操作指令 / 有沒有引用實測數字。

⚠️ **它自己曾有兩個「安靜地量錯」的缺陷(V72.5.6 修)**:
① 只扣 `<details>:not([open])`,**沒扣 Tailwind `.hidden`** —— 沙箱連不到 CDN、`.hidden{display:none}`
   根本沒載入 → 那些內容全被算成「攤開」,字數**系統性高估**(同 `page_sweep` 踩過的坑)。
② `txt` 只留前 400 字 → 「有沒有下操作指令」只掃到卡片開頭,而**指令通常寫在最後**的
   「💡 對策 / 怎麼做」那一段 → 幾乎全部漏判。
⭐ 通用:**工具報出來的數字,在拿去做決策之前要先驗工具本身**(同 `test_sweep_selfcheck` 那條)。

⚠️ **V76.0.1 第三個「安靜地量錯」**:`folded` 對**關起來的 `<details>` 永遠算成 0** ——
Chromium 的 `innerText` 看不到它的內容,舊版用 `dt - sm` 相減自然恆為 0。
實測報告頁 9 節**全是 `<details>`**,那一欄卻報「摺疊 0」,看起來像「什麼都沒收起來」。
⭐ 修法:兩種摺疊**分開算** —— `<details>` 用 `innerHTML` 剝標籤量(⛔ 且不可從攤開字數再扣一次,
它本來就不在 `innerText` 裡);Tailwind `.hidden` 才要扣(沙箱載不到 CDN → 它有被算進去)。
🚨 **同版另一個**:`SUBTABS` 陣列**沒有 `'report'`** → 報告頁從 V75.1.1 上線到 V76.0.1
**一次都沒被巡邏過**(`page_sweep` / `card_inventory` / `swallow_hunt` 三支全中,陷阱 #37)。

📊 **實測 2330(V76.0.1 重量,⛔ 舊的 12,419 那份已過期)**:
合計 **11,360** 字(含報告頁;⛔ 舊版沒掃報告頁所以看起來比較少)。
最重四張:回測 `playbookCard` **1,154**(瘦身前 1,523)・當沖 `dayTradeBody` **1,018** ・
總覽 `ovCommandCenter` **972**(⛔ 這張是主結論,**不是**瘦身對象)・報告 `rpRisk` **560**。
⚠️ 舊文寫的 `chipVerdictCard` / `chuMergedCard` **早就不在前 20 名了** ——
⭐ 通用:**砍卡之前先重跑一次盤點**,⛔ 別照文件裡上一輪的清單去砍(那會砍一個已經不存在的問題)。

### 🔬 `scripts/page_sweep.mjs` —— 「實際渲染後掃一遍」(V72.2.2)
CLAUDE.md 自己早就寫了「巡邏 grep 只能抓你想得到的說法 → **真正可靠的是實際渲染後人工看一遍**」,
這支把那件事自動化:用**真實 `data/*.json`** 跑完整 `analyze()`,把 8 個分頁 + 3 個總覽 pane
全切一遍,掃**渲染後的 innerText**,找四類缺陷:
① 💥 缺值印給使用者(`跌破前低 --`)② 🗣️ 空頭卻叫人做多 ③ 📉 極端占比 ④ 🫥 空殼
⑤ ⚔️ **同一畫面兩張卡下相反的操作指令**(一張叫你進場、另一張叫你出場)——
   這條直接對應使用者講最多次的「邏輯不打架」。⛔ 只收「叫人怎麼做」的動詞、⛔ 只比**跨卡**的
   (同一張卡「可進場,跌破 X 就先出場」是完整劇本,不是矛盾)。

**它上線第一天就抓到 3 個靜態 grep 永遠找不到的真 bug**(問題不在關鍵字,在「數字湊起來很荒謬」):
| 頁 | 畫面長這樣 | 真因 |
|---|---|---|
| 回測 | 「勝率 **100%** ・賺賠比 全贏 ・**3 次**」還掛 ⭐主打 + 閃爍 + 「可依紀律進場」 | 陷阱 #27;`_winRateConfidence` 早就有,**全 App 只接了 1 處** |
| 當沖 | 0050「🏆 這檔最高勝率:爆量突破 **0%**」+「成功率最高的做法(鐵律)」 | **沒有對照組**,只跟 0 比 |
| 多空 | 「多方 7 項 / **0 項** 空方 → 多方 **100%** → 四面向同步攻擊,**可放心做多**」 | 陷阱 #28;一邊掛零是「資料沒到齊」 |

### ⚠️⚠️ V72.2.7 —— 這支工具**自己**曾有三個「看起來在工作、其實沒有」的缺陷
寫下來是因為它們**全都不會讓工具報錯,只會讓它安靜地少看很多東西**:
1. **整頁被當成「一張卡」**:`appMainArea` 沒有 inline display 也沒有 hidden → 一路暢通
   被當成一張卡收走,吃掉底下所有真正的卡(去重是「父層收了就不收子層」)。
   🚨 後果:**⑤ 跨卡打架偵測從上線到 V72.2.7 一次都不可能觸發**(它要求兩張**不同**卡),
   而我當時還寫下「偵測器收到 1 多 / 2 空、正確判定無衝突」這種**錯的推論**。
   → 排除 `appMainArea` / `tabContent*` / `subContent*`,卡片上限 4000→2500。每頁 2~3 張 → **8~14 張**。
2. **Tailwind 是 CDN、沙箱連不到** → `.hidden{display:none}` 沒載入 → `offsetParent`
   對「只靠 class 藏起來」的元素完全失效,掃到一堆使用者看不到的卡。
   → 自己往上追祖先。⚠️ 但**不能只看 class** —— `switchAppTab` 用
   `style.setProperty('display','flex','important')` 顯示分頁、**從來不移除 hidden class**,
   只看 class 會把「正在顯示的分頁」誤判成藏起來(121→50 張)。
3. **第一檔股票永遠被少掃**:`init()` 的 `switchAppTab('inv')` 在幾秒後把頁面切走。
   → 開掃前等 diag **連續兩次**站得住。

⭐⭐ **通用鐵則(這條比工具本身重要):「沒有報錯」不能當成「檢查過了」。**
任何偵測器都要有一條「**注入已知缺陷,確認它真的叫得出來**」的自我驗證 ——
`scripts/test_sweep_selfcheck.mjs` 就是幹這個的(它同時比對樣式有沒有跟 page_sweep 分歧、
外殼排除清單還在不在)。

⛔ **它是巡邏工具不是測試**:exit 0、**不進四驗證**(誤報擋 push 會讓人養成無視它的習慣),
每一筆都要人工讀原始碼驗真偽。⚠️ **四個「空過」守門都已內建,別拿掉** ——
這支工具最大的風險就是「輸出看起來乾淨,其實根本沒掃到」:
① 少了 `--allow-file-access-from-files` → `analyze()` **靜默**抓不到 data/(K 根數 <100 就 exit 1)
② 忘了先 `switchAppTab('diag')` → 個股頁整個 `display:none`(掃到 0 張卡就 exit 1)
③ `switchAppTab` 可能**在幾秒後被 init 蓋回庫存頁**(`init()` 尾端那行排在
   `await fetchMacroData()` 之後,沙箱要等 timeout)→ 切完驗一次 computedStyle
④ ⑤ 一句操作指令都沒收到時要明說(0/0 = 字典過時或沒渲染,**不是「沒打架」**)

⚠️ **排查這類問題時的鐵則**:判斷「看得見」一律用 `offsetParent` / `getComputedStyle`,
⛔ **不能用「有沒有字」** —— `innerText` 對 **display:none** 的元素**照樣回傳全文**
(V72.2.5 排查時據此以為 `tabContentMarket` 有 57k 字卻沒被收,差點誤判成 App bug 去「修」)。


