# StockAI Telegram 雲端個股提醒 — 部署手冊

**架構**:Cloudflare Workers + KV(免費)+ Telegram Bot
**成本**:$0/月,直到 5000+ 同時用戶
**用戶體驗**:綁定 1 次,以後手機鎖屏 / 關 App 都會收到提醒

---

## ⚙️ 一次性部署步驟(GitHub Actions 版,不需裝 wrangler)

### 1️⃣ 建 Telegram bot

1. 開 Telegram,搜尋 `@BotFather`,傳 `/newbot`
2. 命名:`StockAI 個股提醒`(顯示名)
3. username:例如 `stockai_xin_bot`(全球唯一,要 `_bot` 結尾)
4. BotFather 回傳一串 token:`1234567890:ABCDEFghijklmn-OpqRstUvwxyz`
5. **存好這個 token**

---

### 2️⃣ 建 Cloudflare 帳號 + KV namespace

1. 前往 https://dash.cloudflare.com/sign-up 建帳號(免費)
2. 登入後,左側選「**Workers & Pages**」→「**KV**」
3. 點「**Create a namespace**」,名稱填 `stockai-alerts-KV`,按「Add」
4. 建好後看到 KV 清單,**複製那個 namespace 的 ID**(看起來像 `abcd1234efgh5678...`)

---

### 3️⃣ 更新 wrangler.toml

把 `cloud-worker/wrangler.toml` 裡的 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 換成步驟 2 的 ID:

```toml
[[kv_namespaces]]
binding = "KV"
id = "abcd1234efgh5678..."   # ← 改這裡
```

commit + push 到 main。

---

### 4️⃣ 拿 Cloudflare API Token + 設 GitHub Secrets

**拿 Cloudflare API Token**:
1. Cloudflare 右上角頭像 → 「My Profile」
2. 左側「**API Tokens**」→「**Create Token**」
3. 選範本「**Edit Cloudflare Workers**」→「Use template」
4. 不用改設定,直接「**Create Token**」
5. **複製 token(只顯示一次!)**

**加到 GitHub Secrets**:
1. 開 `https://github.com/xin7355-collab/StockAI-DB/settings/secrets/actions`
2. 點「**New repository secret**」

| Secret 名稱 | 值 |
|------------|-----|
| `CLOUDFLARE_API_TOKEN` | 步驟 4 的 Cloudflare API token |
| `TELEGRAM_BOT_TOKEN` | 步驟 1 的 bot token(已設過可跳過) |
| `GEMINI_API_KEY` | (選填)Gemini API key,設了才有 AI 短評 |

---

### 5️⃣ 觸發部署 Worker

1. 前往 `https://github.com/xin7355-collab/StockAI-DB/actions/workflows/deploy_worker.yml`
2. 點右側「**Run workflow**」→「Run workflow」
3. 等 1-2 分鐘跑完
4. 成功後到 Cloudflare Workers 首頁可看到 `stockai-alerts`,URL 長這樣:
   `https://stockai-alerts.YOUR-NAME.workers.dev`

**把這個網址記下來**。

---

### 6️⃣ 把 Telegram webhook 綁到 Worker

把 `<TOKEN>` 換成步驟 1 的 bot token,`<WORKER_URL>` 換成步驟 5 的網址:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/bot"
```

回傳 `{"ok":true,...}` 就成功。

> 沒有電腦?可用手機的 Termux app 跑這行 curl,或找個線上 curl 工具。

---

### 7️⃣ 把 Worker 網址填到網頁

1. 開網頁 → 戰情設定 → 「📨 Telegram 雲端推送」
2. 「Worker 網址」貼步驟 5 的 URL(例如 `https://stockai-alerts.your-name.workers.dev`)
3. 「Bot username」貼步驟 1 的 username(例如 `stockai_xin_bot`)
4. 按「📨 啟用」即會生成綁定碼 + 跳到 Telegram

**部署完成!**

---

## 👤 用戶綁定流程(以後每位用戶做一次)

1. 開網頁,進「⚙️ 戰情設定」
2. 點「📨 啟用 / 取得綁定碼」
3. 網頁跳出綁定碼 + 「打開 Telegram」按鈕
4. Telegram 開 `@stockai_xin_bot`(或其他你定的 bot)
5. 點 Start → 傳 `/bind 綁定碼` → bot 回「✅ 綁定成功」
6. 完成!以後自選股 / 庫存 / 監控股有訊號自動推送

---

## 📋 推送觸發條件

### 盤中即時推送(台北 09:00-13:30 每 30 分一次)

| 訊號 | 預設閾值 | 可調 | 防重複 |
|------|--------|------|--------|
| 獵鷹建倉分突破 | ≥ 85 | 60-95 | 6h/檔 |
| 個股單日大漲 | ≥ +5% | 2-10% | 6h/檔 |
| 個股單日大跌 | ≤ -5% | 2-10% | 6h/檔 |
| 庫存浮盈停利 | ≥ +20% | 固定 | 6h/檔 |
| 庫存浮虧停損 | ≤ -8% | 固定 | 6h/檔 |
| 黑天鵝事件 | 嚴重度=高 + 1 日內 | 固定 | 1 次/天 |

### 盤後每日總結(台北 17:00)
- 自選股當日漲跌 Top 3
- 庫存今日對成本盈虧 + 部位加權報酬率
- 獵鷹分 ≥ 設定閾值的命中名單
- 全市場戰略選股(top_picks.json)
- 設了 `GEMINI_API_KEY` → 附「💬 AI 短評」(權證小哥風格)

---

## 🎮 Telegram 指令

用戶綁定後可直接在聊天室調整設定,不用回網頁:

| 指令 | 用途 | 範例 |
|------|------|------|
| `/set falcon 80` | 調獵鷹分閾值(60-95) | 推 falcon ≥80 的股 |
| `/set surge 7` | 調大漲閾值(2-10) | 漲 ≥7% 才推 |
| `/set drop 4` | 調大跌閾值(2-10) | 跌 ≤-4% 才推 |
| `/set` | 不帶 args | 顯示目前所有閾值 |
| `/cost 2330 1100` | 設庫存成本 | 2330 成本 1100 |
| `/cost 2330 1100 5` | 成本 + 張數 | 1100 / 5 張 |
| `/cost 2330` | 查目前成本 | — |
| `/cost` | 不帶 args | 顯示全部庫存 |

---

## 🔧 日後維護

### 更新 Worker(改了 worker.js 後)
改完 push 到 main → `deploy_worker.yml` 自動重新部署(約 1 分鐘)

### 看 Worker 即時 log
需要安裝 wrangler:
```bash
npm install -g wrangler && wrangler login
cd cloud-worker && wrangler tail
```

### 查用戶清單(需 wrangler)
```bash
wrangler kv:key list --binding=KV --prefix=user: --remote
```

---

## 💰 成本估算

| 資源 | 你的用量 | 免費額度 | 結論 |
|------|---------|---------|------|
| Worker requests | ~50k/day | 100k/day | ✅ |
| KV reads | ~50k/day | 100k/day | ✅ |
| KV writes | ~500/day | 1000/day | ✅ |
| KV 儲存 | < 1 MB | 1 GB | ✅ |
| Telegram bot API | 無限 | 無限 | ✅ |

**$0 / 月,直到 5000+ 用戶**。

---

## 🐛 Troubleshooting

### Worker 沒有回應 /set /bind 指令
- ✅ 確認 deploy_worker.yml 已成功跑完(GitHub Actions 綠燈)
- ✅ 確認 webhook 已設定(步驟 6)
- ✅ 確認 wrangler.toml 裡的 KV namespace id 已填入(不是 `REPLACE_WITH_YOUR...`)

### 驗證 webhook 是否設定成功
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
# 看 "url" 欄是不是你的 Worker 網址
```

### 收不到推送
- 確認已完成「用戶綁定流程」(傳 `/bind 綁定碼`)
- 傳 `/list` 到 bot 看雲端清單是否正確
- 盤中推送只有台北 Mon-Fri 09:00-13:30 才觸發

### 多個 cron 沒觸發
- Cloudflare 免費版 cron 只能 5 個,目前用 2 個

### deploy_worker.yml 失敗
- 確認 `CLOUDFLARE_API_TOKEN` 已加到 GitHub Secrets
- 確認 wrangler.toml 的 KV namespace id 已替換

## 🔔 V22.3 — 手機 Web Push(關 App 也能收推播,iOS 16.4+)

**零額外設定**:VAPID 金鑰由 Worker 第一次用到時自動生成存 KV,不用跑指令、不用設 secret。

1. 把最新版 `worker.js` 重新部署一次(照上面第 5️⃣ 步再跑一次即可)。
2. 手機用 Safari 開網站 → 分享 → **加入主畫面** → 從主畫面圖示開啟。
3. App 內 ⚙️ 設定 → 「🔔 手機推播告警」→ 啟用 → 允許通知 → 會立刻收到一則**測試推播**(收到=通了)。
4. 之後 Worker 盤中每 15 分自動盯:
   - 庫存跌破 **鐵血停損 -5%** / **絕對底線 -10%**
   - 你按「🔔 幫我盯這 N 個價」設的**到價提醒**
   → 關 App、鎖屏都會推到手機(當日去重,不轟炸)。

排錯:啟用時顯「Worker 是舊版」= 還沒重新部署;測試推播沒收到 = 確認是「從主畫面開啟」而非 Safari 分頁。
