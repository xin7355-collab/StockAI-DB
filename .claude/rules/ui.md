---
paths:
  - "index.html"
  - "pro.html"
  - "scripts/lib_rwdshim.mjs"
  - "scripts/rwd_audit.mjs"
  - "scripts/font_audit.mjs"
  - "scripts/box_inventory.mjs"
---
# UI / 版面 / 設計規範(散戶 App 與產業作戰室共用)

> 📦 2026-11-21 從舊 CLAUDE.md 搬來(只搬位置、一個字沒改;舊版 = commit `bddae63`,每段前面的註解寫舊行號)。新規則照主題寫在這裡,⛔ 寫回 CLAUDE.md。

<!-- 舊 CLAUDE.md 第 1444~1597 行 -->
## 🎨 UI/UX 設計規範(V25.8 後新增,Senior UI/UX 規範)

### Design Tokens(嚴格限色)
| 用途 | Tailwind class |
|------|---------------|
| 漲 / 警示 | `text-red-400` `text-red-300` |
| 跌 / 健康 | `text-green-400` `text-green-300` |
| 極度危險 | `text-orange-400` (+ animate-pulse) |
| 警戒 | `text-yellow-400` |
| 主文字 | `text-gray-100` |
| 次要 | `text-gray-400` |
| 備註 | `text-gray-600` |

**背景**:
| 用途 | class |
|------|-------|
| 主背景 | `bg-[#0d1117]` |
| 卡片 | `bg-[#161b22]` |
| 次要 chip | `bg-white/5` 或 `bg-[#21262d]` |
| 預設邊框 | `border-[#30363d]` |
| 漲(警示)背景 | `bg-red-900/30` |
| 跌(健康)背景 | `bg-green-900/30` |
| 極危背景 | `bg-orange-900/30` |

⛔ **禁用霓虹漸層** — `bg-purple-*/40` / `bg-cyan-*/40` / `bg-pink-*/40` 等高飽和漸層(只在 verdict 大字 hero 用,不在普通卡)

### 🎨 `frontend-design` 外掛(2026-09-11 已裝,專案層)—— 哪裡聽它、哪裡以本節為準

🚨 **先更正我自己**:上一版這裡寫「它主打 bold aesthetic・high-impact animations,**跟視覺降噪鐵則直接對立**」
—— **那是錯的**,而且來源是**部落格的二手摘要**。讀它真正的 `SKILL.md` 之後:

✅ **它其實跟本節同一邊**(這幾句可以直接當本專案的補充):
- 「**Spend your boldness in one place** —— 讓一個元素成為記憶點,其餘保持安靜克制,
  **砍掉任何不服務主題的裝飾**」
- 「**gradient washes as decoration**(漸層當裝飾)」被它列為**一眼看出是 AI 做的** tell → 同本節「⛔ 禁用霓虹漸層」
- 「非使用者觸發的動畫要**極少且刻意**;每一段都 fade-and-slide-up、每張卡都 hover 特效 = AI 味」
- 「⛔ 標籤不要用全大寫」「行長 < 80 字元」「結構性裝置(框線/編號/分隔)要**承載資訊**不是裝飾」

⚠️ **真正的衝突是另一件事,而且很具體**:它把下面三樣列為「AI 生成的 tell」,
但那三樣正是**本專案刻意的設計**(仿券商 App,使用者指定):
| 它說是 tell | 本專案的現況 | 判定 |
|---|---|---|
| 「near-black 背景 + 單一亮色 accent」 | `bg-[#0d1117]` 深色終端機 | ⛔ **不改**(券商 App 慣例) |
| 「SaaS-card kit:一堆一模一樣的圓角卡、同一個 border-radius」 | `bg-[#161b22] border-[#30363d] rounded-lg p-3` 全站重複 | 🚨 **V76.4.1 使用者明示推翻了原本的「⛔ 不改」** —— 見下方「🧱 去框判準」 |
| 「小資料標籤用等寬字」 | `font-mono` 用在所有數值 | ⛔ **不改**(數字要對齊,而且使用者會拿畫面數字驗算) |

⭐ **判準**:它服務的是「**做出不像 AI 做的網頁**」;本專案是**每天用的密集型金融終端機**,
一致與可掃視 > 獨特。→ **版面決策(顏色/卡片/字體/燈號)一律以本節為準**;
它的「克制、砍裝飾、動畫要有理由、標籤不全大寫」照收。
⛔ **裝了它也不會讓 2330 那頁的字變少** —— 資訊密度要靠 `_TIDY` 與砍卡流程,不是設計外掛。
(⚠️ 舊文寫的 12,419 字已過期,V76.0.1 重量是 **11,360**;⭐ 砍卡前一律重跑 `card_inventory.mjs`。)

### 🧱 去框判準(V76.4.1,使用者明示;⭐ 推翻上表那一格的「⛔ 不改」)
使用者原話:「**設計上一定要有框框嗎?沒有框框可以放的東西比較多,另外其它頁面也一樣不必要就不要框框,
改設計別種的,我是要整份資料都是這樣子**」。⭐ 先量,他看到的是真的:

| | 去框前 | 去框後 |
|---|---|---|
| 🖼️ 海報(canvas)每一行的內容寬 | 672 / 780 = **86.2%**(外框 + 內縮吃掉左右各 54px) | **724px = 92.8%**,而且跟頁首同一條邊 |
| 🖼️ 海報每張卡的固定開銷 | **118px**(標題區 84 + 底 18 + 間距 16)× 9 張 = 1,062px | **98px** |
| 📄 報告頁 `#rpWalls` 那條鏈 | 8+1+12+11+8 = 左右各 **40px** → 390 手機只剩 **310px** | 左右各 16px → **361px** |

> ⭐⭐ **判準一句話:框如果在講事情就留;只是把東西「圍起來」的就拿掉。**

| 拿掉 ❌ | 保留 ✅ |
|---|---|
| 卡片底色 + 四周邊框 + 圓角(`bg-[#161b22] border border-[#30363d] rounded-lg p-3`)—— 它只說「這裡是一張卡」,而「標題 + 一條 `border-b border-[#21262d]`」說得一樣清楚且**完全不吃寬度** | ⚠️ **Alert Box 的左色條**(`border-l-4`,全站 **253** 處)—— 顏色在講「這一節有事」 |
| 框裡再包一層框(巢狀外殼)—— 兩層邊框中間那幾 px 什麼都沒講 | 🔘 **按鈕(525)/ 輸入框(65)/ textarea(4)** —— 框在講「這裡可以點 / 可以打字」 |
| 純裝飾、沒有語意的圓角小盒 | 📊 **量條 / 刻度尺的底槽** ・📋 **一格一筆的清單/格子卡**(價格尺的 `cell()`、重點數字的每一格) |

⛔ **三條不可違反**:
- ⛔ **不走「只靠留白」** —— 資料密的頁面會糊成一片(使用者選的就是「留分隔線」那個)。
- ⛔ **不可用任意值 `border-l-[3px]`** —— `scripts/lib_rwdshim.mjs` 只認 `border` / `border-b` / `border-t` /
  `border-l` / `border-r` / `border-l-2` / `border-l-4`,用別的寬度**沙箱量到的幾何是假的**(陷阱 #40)。
  要換寬度先去改那份**唯一**的 shim(改完記得同步它的自我檢查條數與 `rwd_audit.mjs` 那行訊息)。
- ⛔ **沒有底色之後,「這可以點」只剩文字提示** → `_rpDetails` 的 `展開 ▾` 雪佛龍**一個字都不可拿掉**。
- ⭐ 三種 tone 一律都掛 `border-l-4`,只有**顏色**不同(中性用 `border-l-transparent`)——
  只有 warn 縮排會讓整排標題看起來歪掉。

### 🧱 V77.0.0 起:**全站**無框,而且是**一條 CSS** 不是改 349 處 class
使用者:「**整個系統比照無框邏輯製作**」。
⭐ **先量**(`node scripts/box_inventory.mjs`,⛔ 巡邏工具不進四驗證):靜態 grep 說 349 處,
**實跑只有 111 個框看得見** —— 其餘是**條件式/隱藏**的卡。
→ 只改看得見的那些 = **改一半**(那些卡一被觸發又是有框的),所以必須是一條規則管全部。

📍 **機制:`index.html` `<style>` 裡一條規則 + `.keepbox` 例外**(⛔ 不逐一改 class 字串)
- 選到誰:**`[class~="border"]`**(class 裡有**獨立的 `border`** = 四邊框)+ `border-[#30363d]`。
  ⭐ 這個選法天生就漏掉要保留的那幾種:`border-b` / `border-t` / `border-l-4` / `border-y border-r`
  **都不含獨立的 `border`** → 分隔線與 ⚠️ 警示左色條**自動**不會被選到。
- ⛔ 排除 `button/input/textarea/select/a/label` **與 `cursor-pointer`** ——
  全站有一批**用 `<div>` 做的按鈕**(設定的切換鈕、選股吸頂列、大盤指數方塊),
  只排除 `<button>` 會把那批一起拉平(`box_inventory` 實跑當場抓到 4 種)。
- ⛔ 排除 `border-[#21262d]`(那是**分隔線** token,用它當四邊框的都是內層小格子)。
- 🔒 `.keepbox`:一排 ≥2 個同款框的**格子**(設定 5 格 / 當沖數字格)——⛔ 框在分「這是第幾格」。
- ⚠️ `border-color: transparent` **而不是** `border-width: 0` —— 寬度留著,版面才不會左右各跳 1px。
- ⚠️ 只清**左右** padding(那才是使用者說的「左右還有空間」),垂直留著當段落間距。
- `pro.html` 同步:`.panel` 拉平(⭐ **class 名一個都不改** —— `test_prohtml` 拿 `.closest('.panel')`
  當**結構**選擇器在用);`.vcard` / `.fishcard` / `.bkrow` / `.labitem` 這些**一排/一列一張**的不動。

🧪 `scripts/test_noframe.mjs`(進四驗證):量 **computed style** 證明「真的拉平了」+「該留的一個都沒被拉平」。
🔍 `scripts/box_inventory.mjs`(巡邏,exit 0):分 📦 section / 🔲 cell / 🔒 keep 三類並印出
**沒拉平的**與**被誤拉平的**。⚠️ 它自己的空過守門:⛔ 只數 class 的話去框前後數字一模一樣 = 沒有鑑別力
→ 一律量 computed style。

📍 **已改的範圍(V76.4.1)**:`_rpDrawOwn` 的 `card()` ・`_rpCard` ・`_rpDetails` ・`_priceRulerHtml` 的外層盒
(⚠️ 最後一支是**總覽與報告頁共用**,兩邊會一起變無框,這是刻意的)・`#subContentReport` 的 `gap-2 → gap-0`
・做圖提示詞 `_reportChartPrompt` 的版面段。
✅ **V77.0.0 起全站都是無框的** —— ⛔ 新東西一律照無框寫,別再照上面那張「卡片三段式樣板」加框;
要加框請先答得出「這個框在講什麼事」,答不出來就用 `標題 + border-b border-[#21262d]`。
測試 `scripts/test_rpown.mjs` ⓐ2/ⓑ2/ⓒ2/ⓓ2/ⓔ2/ⓕ2/ⓖ2/ⓖ3(6 種注入全部叫得出來)。

### Emoji 規則(V25.8 使用者明示:保留)
- ✅ **保留所有 emoji**(使用者明確要求:無 emoji 不知怎麼操作)
- 漲跌幅旁的 🔺🔻 / verdict 開頭的 🟢🟡🔴 / 警報的 🚨 / 標題的 📊📐💰🚀⚠️📌🧩🎯💡 全保留
- 不必改 Lucide / SVG icon(那是過度設計)

### 卡片三段式樣板(Equal Height)
⚠️ **V76.4.1 起這張樣板只適用「還沒去框的頁面」** —— 新增卡片前先讀上面的「🧱 去框判準」:
框講不出它在說什麼事,就改成 `標題 + border-b border-[#21262d]`,⛔ 不要再加 `bg-[#161b22] border … rounded-lg`。
```html
<div class="bg-[#161b22] border border-[#30363d] rounded-lg p-3 flex flex-col h-32">
  <!-- 頂:指標名 + emoji icon -->
  <div class="flex items-center justify-between text-[10px] text-gray-400 mb-1">
    <span>📊 VIX 恐慌</span>
    <span class="text-gray-600 text-[9px]">⏱️ 14:32</span>
  </div>
  <!-- 中:大數值(用 flex-1 + items-end 推到底) -->
  <div class="text-2xl font-black font-mono text-gray-100 flex-1 flex items-end">15.3</div>
  <!-- 底:短評(truncate 避免溢出) -->
  <div class="text-[10px] text-gray-600 truncate">市場平穩 多頭健康</div>
</div>
```

### Alert Box 樣板(取代「整句彩色化長文」)
```html
<div class="bg-[#161b22] border-l-4 border-red-500 pl-3 py-2 rounded-r">
  <div class="text-[10px] text-red-400 font-bold mb-1">⚠️ 戰術遵照</div>
  <div class="text-[11px] text-gray-200 leading-relaxed">純文字段落 行高 1.6 不再整句紅綠黃</div>
</div>
```

### 排版層級鐵則
- 長文字段落:`leading-relaxed` (line-height 1.625) 或 `leading-loose` (1.75)
- 短卡內容:`leading-tight` (1.25) — 例如卡片 title/sub
- **絕不**對整句段落上色,只用 emoji 開頭 + 標籤 chip + Alert Box border-left 標示
- 對齊:卡片內標題列 `flex items-center justify-between`,數值列 `font-mono` 等寬

### sub-tab Sticky 規則(V25.9+ 推進)
- 全球大環境 / 台股實戰 sub-tab 需 `sticky top-0 z-30` 固定頂部
- 切換不再 layout shift
- background 配 `bg-[#0d1117]/95 backdrop-blur` 維持半透

---


<!-- 舊 CLAUDE.md 第 1675~1812 行 -->
## 🎯 V26.x 階段學到的新規(2026-06-26 連推 V26.1~V26.19)

### 個股頁 5 卡架構(每張卡 onclick / ID 一旦動就會壞)
| 卡片 ID | 渲染函式 | 行號 | 角色 |
|---------|---------|------|------|
| `#costPnlBar` | (在 refreshStrategy 內) | L15206 | 倉位狀態小卡 4 格 grid + 大字現價(V26.6) |
| `#masterScoreCard` | `renderMasterScoreCard` | L7891 | 綜合操作評分 Progress Row Grid(V26.15) |
| `#instReverseCard` | `renderInstReverseCard` | L7791 | 法人反轉 + 投信做帳 Alert Box(V26.16) |
| `#chuStrategyCard` | `renderChuStrategyCard` | L3892 | 朱老師策略 Empty State + CTA(V26.17) |
| `#chipBrokerTable` | `dispBrokerTable` fallback | L9784 | 分點明細 + 維護中 Alert Box(V26.18) |

### UI 樣板鐵則(必引用,別重新設計)

**1. Equal Height Card 三段式**(V25.8)— 全球巨頭 10 卡

**2. Alert Box 樣板**(V26.1+)— 警告 / 維護中 / 失敗訊息:
```html
<div class="bg-[#161b22] border-l-4 border-{color}-500 border-y border-r border-[#30363d] rounded-r p-3">
  <div class="text-[11px] font-bold text-{color}-300 mb-1">⚠️ 標題</div>
  <div class="text-[10px] text-gray-300 leading-relaxed">純文字段落不再彩色化</div>
</div>
```

**3. 倉位狀態 4 格 grid**(V26.6)— `#costPnlBar`:
header 大字現價 + 2x2 grid(成本/帳損%/5MA/損益元),硬停損 Alert Box 條件顯示

**4. Vertical Stepper**(V26.9)— SOP 步驟條(永豐 App 下單 / 設定教學):
```html
<div class="flex gap-2.5">
  <div class="flex flex-col items-center flex-shrink-0">
    <div class="w-5 h-5 rounded-full bg-{color}-600 text-white text-[10px] font-black flex items-center justify-center">${n}</div>
    <div class="w-0.5 flex-1 bg-[#30363d] my-1"></div>   <!-- 最後一步省略 -->
  </div>
  <div class="flex-1 pb-2.5">
    <div class="text-[11px] font-bold text-{color}-300">${title}</div>
    <div class="text-[10px] text-gray-400 mt-0.5 leading-snug">${detail}</div>
  </div>
</div>
```

**5. Progress Row Grid**(V26.15)— 因子明細 / 評分列表:
```html
<div class="grid grid-cols-[1fr_auto_44px] gap-2 items-center py-1.5 border-b border-[#21262d]">
  <div>
    <div class="text-[11px] text-gray-200 font-bold flex items-center gap-1"><span>${icon}</span>${name}</div>
    <div class="text-[9px] text-gray-500 font-mono">權重 ${weight}%</div>
  </div>
  <div class="flex flex-col items-end gap-0.5">
    <span class="text-[9px] text-gray-400 truncate max-w-[120px]">${evalTxt}</span>
    <div class="w-[100px] h-1 bg-[#21262d] rounded-full overflow-hidden"><div class="h-full ${barColor}" style="width:${score}%"></div></div>
  </div>
  <div class="font-mono font-black text-right text-base ${scoreColor}">${score}</div>
</div>
```

**6. Empty State + CTA**(V26.17)— 未填資料的卡片(別顯紅警誤導):
```html
<div class="flex flex-col items-center justify-center py-6 px-3">
  <div class="text-5xl text-gray-700 mb-2">📦</div>
  <div class="text-sm text-gray-300 font-bold mb-1">尚未建立此 ${entity}</div>
  <div class="text-[10px] text-gray-500 mb-4 text-center leading-relaxed">${guideText}</div>
  <button onclick="${action}" class="px-5 py-2.5 bg-{color}-600 hover:bg-{color}-500 text-white text-xs font-black rounded-lg shadow-md">＋ ${ctaText}</button>
</div>
```

### 錯誤訊息白話化鐵則(V26.18 後)

⛔ **禁在 UI 文案暴露技術術語**(showJargon / title tooltip / fallback HTML 都算 UI):
- `GitHub Actions` / `Google Cloud` / `AWS` / `Azure` / `IP 封鎖` / `sandbox` / `runner` / `cron syntax` / `TWSE BSR 系統封鎖`
- 後端 API 名稱:`FinMind` / `Fugle` / `yfinance` 等實作細節
- 內部變數 / 函式名:`activeData` / `_macroRiskCache` / `_falconScores` 等

✅ **改用白話**:
- 「⚠️ XXX 維護中,已自動切換至 T+1 備份備援」
- 「✅ 已自動切換到替代方案」
- 「請至 [合理連結] 手動查」
- 「資料抓取中,稍後再點」

🟢 **例外**:使用者主動點「故障排查」「Telegram 推播診斷」等 power user 工具,可保留技術細節(他真要 debug 才看)

### AI 資料就緒檢查模式(V26.12/V26.13)

**鐵則**:禁 AI 在資料不全時硬判讀,避免 AI 看 null 給「健康」錯誤結論。

**工具函式**(L8480 附近):
```js
_checkMacroReady() {
    const macro = this._macroRiskCache || {};
    const hasSectors = !!(macro.sector_etfs && Object.keys(macro.sector_etfs).length >= 5);
    const missing = [];
    if (!hasSectors) missing.push('9 板塊 ETF 對標資料');
    return { ready: missing.length === 0, missing };
},
_dataNotReadyHtml(missing) { /* Alert Box 樣板,黃色警示 */ }
```

**4 個函式 entry 必加 ready check**:
- `analyzePredictCenter`(預判中心 4 段 AI)
- `analyzeMarketAnomaly`(大跌剖析)
- `analyzeSectorRotationAI`(板塊輪動 AI)
- `renderSectorGapTable`(9 板塊缺口表)

**個股 AI 不需 check**(進入個股頁就 fetch 個股資料):
- `runUnifiedGroqAnalysis` / `runKlineAudit` / `analyzeChipUnified` / `fetchFundamentalAnalysis`

**過嚴會錯殺**:V26.12 把 `us_macro.sp500/vix` 設 required 太嚴,V26.13 改成只看 `sector_etfs`(因為核心資料齊就能跑)。

### 整合卡規則(V26.14)

**重複功能必合併到一張整合卡**(避免兩個功能在不同卡分散)— V26.14「資金板塊輪動」+「9 板塊缺口表」合併示範。

**搬卡操作必驗 ID 唯一性**:
```bash
for id in sectorSource sectorIntradayBtn sectorAiBtn ...; do
  count=$(grep -c "id=\"$id\"" index.html)
  [ "$count" -ne 1 ] && echo "❌ $id 重複 $count 次"
done
```

**JS 函式不需改**:DOM ID 保留 + onclick handler 保留 → 渲染邏輯零改動

### 視覺降噪鐵則(V26.1 ~ V26.18 整套)

| 禁 | 改 | 範例 |
|----|-----|------|
| 霓虹漸層 `bg-gradient from-purple-*` | 純色 `bg-[#161b22]` + accent border | V26.2-V26.4 |
| 口語化驚嘆「!!」「啊」「對著做」 | 金融術語 + Alert Box | V26.16 |
| 長文字段落彩色化 | 純灰文字 leading-relaxed + emoji 開頭 | 全段 |
| 未填資料顯紅警誤導 | Empty State + CTA 引導行動 | V26.17 |
| 黃底 chip `bg-yellow-900/40 px-1 rounded` | 純淡黃文字 `text-yellow-300 font-bold` | V26.8 |
| 整段技術術語錯誤訊息 | 「⚠️ XXX 維護中,已切備援」 | V26.18 |

### 連推時 ID 重複防呆(V26.10/V26.11/V26.14 教訓)

搬卡 / 整合卡 / 複製貼上 HTML 後**必跑 ID 唯一性檢查**,否則 `document.getElementById` 只抓第 1 個,新位置 DOM 操作會壞。

---


<!-- 舊 CLAUDE.md 第 2069~2085 行 -->
## 📅 資料日期標示鐵則(V70.2.0,使用者要求:分不清今天還是上個交易日)
- **任何顯示「資料」的卡片都要標日期**,格式一律走共用工具:`app._dW(raw, {y, rel})` → `07/28(二)`;
  重要卡片加 `{rel:1}` 顯「今日/昨日/N 天前」;需要過期提醒用 `app._dChip(raw, '標籤')`(≥4 天自動轉黃 + ⚠️)
- ⛔ **禁止自己拼日期字串**(`.slice(5,10)`、`replace(/-/g,'/')` 那種)— 格式會分歧,一律用 `_dW`
- **新增任何「後端產資料 → 前端讀」的卡**,必須把該檔的 `updated`/`data_date` 一併存進 cache 變數
  (如 `_fmxUpdated`/`_attentionUpdated`/`_potPickUpdated`)並在卡片標題旁顯示
- 即時類(盤中報價/逐筆)標「日期 + HH:MM + 盤中/收盤」;週更類(集保)標結算日;月更類(董監)標月份

## 📐 橫版(landscape)檢查鐵則(V70.1.0,使用者要求記錄)
- **改版面必測橫版**:headless 844×390 載入後 `window.scrollTo(80,0)` 斷言 `scrollX ≤ 2`(頁面禁止橫向捲動;`scrollWidth` 會把被 clip 的內容也算進去,不能拿來當判準)
- 卡片禁固定 px 寬,一律 `w-full`+`max-w-*`;canvas 用 clientWidth 動態算
- 寬內容(表格/長列)包 `overflow-x-auto` 自己滾,不准撐寬整頁
- **flex 子項陷阱**:`flex-1` 預設 `min-width:auto` 會被長內容(跑馬燈/長字串)撐開 → 整頁橫向溢出;要加 `min-width:0`(V70.1.0 跑馬燈實例)
- `html,body { overflow-x:hidden }` 已當總保險,但那是止血不是治本,新增溢出仍要修元凶
- **轉向(rotate)必測**:portrait 載入 → 改 viewport 844×390 → dispatch resize → 斷言各 ECharts canvas 寬跟上(V70.1.2 已加全域 debounce resize listener,一次照顧所有 `[_echarts_instance_]`;新圖免另掛)
- **圖上文字禁裸放**:markArea/markLine label 會被柱/線蓋 → 一律加 `backgroundColor:'rgba(13,17,23,0.85)'+padding`(V70.1.2 溫度計標籤實例)


<!-- 舊 CLAUDE.md 第 2273~2317 行 -->
### 📐 V76.1.9 「版面修正」—— ⭐ 先量,而「左右被切」跟第一眼想的不是同一回事
使用者只給一張報告頁截圖 + 「1.版面修正」。
🚨 **截圖左右被切不是橫向溢出** —— `index.html:355` 有 `html,body{overflow-x:hidden}` 擋著,
而 viewport 開了 `maximum-scale=5.0` → 他是**捏放大在看**。會放大是因為字小、每列三行、還印英文函式名。

#### 🔠 字級:App 早就有三張放大表,新字級要落在表裡
⛔ **加新字級前先看 `index.html:274-296` 與 `:338-342`**:V44.2 有一張 `!important` 放大表
(`text-[8px]`→9 / `[9px]`→10 / `[10px]`→11 / `[11px]`→12),另有 `html[data-font="large"]` / `"xl"` 兩級使用者可調。
🚨 我第一版把說明字改成 **`text-[10.5px]`** —— 它**不在任何一張表裡** → 預設只比原本大 0.5px,
而且使用者切「大字」時**完全不會跟著放大**(= 變相退步)。
⭐ 正解:**一律用表裡有的字級**(`10px` / `11px`);要用 12/13px 就**先把它補進 large/xl 兩張表**(V76.1.9 已補)。
⭐ 巡邏 `node scripts/font_audit.mjs`(⛔ exit 0、**不進四驗證**)——
🚨 它**必須自己注入字級 shim**(沙箱沒有 Tailwind,`text-[Npx]` 完全沒生效,直接量 computed 全是 16px)。
⚠️ 而且**驗 shim 有沒有生效⛔ 不可拿 `text-[9px]`** —— V44.2 那張 `!important` 表會贏過 shim,
量到 10px 是**對的**;要驗就驗**不在表裡**的字級(13px)。這一條第一版就踩到。
📊 實跑:個股 9 個分頁只有 **12 段**低於 10px(不是想像中的上千處 —— 那張表早就把大部分撐住了),已全部修掉。

#### 📱 溢出判準:`scrollWidth` 是**假綠燈**,⛔ 不可再用
`test_report.mjs` 原本用 `scrollWidth > clientWidth` —— 正是 CLAUDE.md「橫版檢查鐵則」明文說**不能用**的
(會把被 clip 的內容也算進去),加上 `overflow-x:hidden` 夾著 → **從頭到尾綠**。
⭐ 換成兩條:① `scrollTo(80,0)` 後 `scrollX ≤ 2` ② **逐元素跟父層比**(照 `rwd_audit.mjs:43-50`)。
🚨 **量之前要把報告頁複製到「已知寬度」的容器**(358px)—— 沙箱沒有 Tailwind,祖先鏈壓到只剩 **200px**,
原地量出來的「超出 36px」是假的;而且要有**空過守門**斷言那個容器真的有 350px 以上(⛔ 0 就沒有鑑別力)。
✅ 換完**第一次跑就抓到三處真的被切掉的版面**(價格牆表 / 壓力測試列 / 估值對照表)。

#### 🚨 `grid-cols-[1fr_auto]` **不等於** `grid-cols-2`
Tailwind **具名** `grid-cols-N` 會編成 `minmax(0,1fr)`;**任意值** `[1fr_auto]` 是原生 `1fr` = `minmax(auto,1fr)`
→ 左欄被 max-content 撐開、右邊 `auto` 欄又永不收縮(`-154,312` 這種千分位是不可斷 token)→ 整列撐寬。
⭐ 一律改 inline `grid-template-columns:minmax(0,1fr) auto`。
⚠️ 全檔還有 **5 處**在別的頁(L13331 / 40365 / 44283 / 44372 / 44384)—— 這一版沒動,列在 `docs/DECISIONS.md` 待辦。

#### 🚨 我自己推錯的一件事(要記住)
`_gaugeRow` 的刻度標籤兩端會掛在軌道外(`_priceRulerHtml` V76.0.8 修過的同型病,當時沒一起修)。
我推論「刻度只落在 5~95%,碰不到兩端所以沒事」→ **錯的**,實測 2330 最右那個標籤超出 **21px**。
⭐ 是新的逐元素檢查當場抓到的。**⛔ 用「門檻不會被觸發」推論安全之前,先實際量一次**(同陷阱 #35)。
修法:刻度線位置不動,**只有標籤**在兩端改對齊(`translateX(0)` / `-100%`),⛔ 不加 `overflow:hidden`(會切掉 ▼ 上方的字)。

#### 🧾 順手修掉的兩個數字
- 🚨 **「法人連3賣 −14,067,577 張」漏 /1000** —— 那三欄(`foreign_net`/`trust_net`/`dealer_net`)**單位是股**,
  正確是 −14,068 張。⭐ 在**源頭**換算(同一個值還餵給 `chipSafety` → AI prompt)。全檔會印「張」的 8 處只有這個漏。
- 🚨 **位階兩個數字**:徽章 91%(high/low)vs 報告頁 §11 93%(收盤)→ 抽 **`app._basePos(data)`** 當唯一真相,
  ⛔ 口徑固定 high/low(徽章的 `pos>=80` / `pos<=35 && dd>=25` 門檻是對它調的,換口徑等於偷改門檻)。
  ⚠️ `dd`(距 250 日高)與 `dd60`(距 60 日高)是兩件事,名字不同、兩個都留。
- 📦 新增 `app._lotTxt(shares)`:整張講「張」、零股直接講「股」(⛔ 不印「2.35 張」)。


