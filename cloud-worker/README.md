# StockAI Telegram 雲端個股提醒 — 部署手冊

**架構**:Cloudflare Workers + KV(免費)+ Telegram Bot
**成本**:$0/月,直到 5000+ 同時用戶
**用戶體驗**:綁定 1 次,以後手機鎖屏 / 關 App 都會收到提醒

---

## ⚙️ 一次性部署步驟

### 1️⃣ 申請 / 安裝工具

| 項目 | 連結 |
|------|------|
| Cloudflare 帳號 | https://dash.cloudflare.com/sign-up |
| Node.js 18+ | https://nodejs.org/ |
| Telegram(申請 bot) | 手機已有就好 |

```bash
npm install -g wrangler
wrangler login   # 開瀏覽器授權 Cloudflare
```

---

### 2️⃣ 建 Telegram bot

1. 開 Telegram,搜尋 `@BotFather`,傳 `/newbot`
2. 命名:`StockAI 個股提醒` (顯示名)
3. username:例如 `stockai_xin_bot`(全球唯一,要 `_bot` 結尾)
4. BotFather 會回一串 token,長這樣:`1234567890:ABCDEFghijklmn-OpqRstUvwxyz`
5. **存好這個 token,稍後要設成 secret**

---

### 3️⃣ 建 KV namespace + 設 secrets

```bash
cd cloud-worker

# 建 KV namespace
wrangler kv:namespace create "KV"
# 回傳長這樣:
# 🌀 Creating namespace with title "stockai-alerts-KV"
# ✨ Success! Add the following to your wrangler.toml:
# [[kv_namespaces]]
# binding = "KV"
# id = "abcd1234..."

# 把 id 貼到 wrangler.toml 的 kv_namespaces[0].id
```

接著設 secret:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
# 貼上步驟 2 拿到的 token,Enter

# (選填)防 webhook 被偽造
wrangler secret put WEBHOOK_SECRET
# 隨便打一串 32 字以上的亂數,例如:abc123XYZ$%^def456...

# (選填)Gemini AI 短評(F4),沒設則盤後總結不附 AI 短評,功能仍正常
# 申請:https://aistudio.google.com/app/apikey(免費 1500 req/day)
wrangler secret put GEMINI_API_KEY
# 貼上 Gemini API key
```

---

### 4️⃣ 部署 Worker

```bash
wrangler deploy
```

成功會看到:

```
✨ Built successfully...
🌍 Uploaded stockai-alerts (3.45 sec)
🌎 Published stockai-alerts (1.23 sec)
   https://stockai-alerts.YOUR-NAME.workers.dev
```

**把這個網址記下來**(等下要填到網頁設定)。

---

### 5️⃣ 把 Telegram webhook 綁到 Worker

把 `<TOKEN>` 換成步驟 2 的 token,`<WORKER_URL>` 換成步驟 4 的網址,`<WEBHOOK_SECRET>` 換成你在步驟 3 設的(沒設 secret 就拿掉那段):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/bot&secret_token=<WEBHOOK_SECRET>"
```

回傳 `{"ok":true,"result":true,"description":"Webhook was set"}` 就成功。

驗證:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
# 看 "url" 欄是不是你的 Worker 網址
```

---

### 6️⃣ 把 Worker 網址告訴網頁

1. 開網頁 → 戰情設定 → 「📨 Telegram 雲端推送」
2. 「Worker 網址」貼上步驟 4 的 URL(例如 `https://stockai-alerts.your-name.workers.dev`)
3. 「Bot username」貼步驟 2 的 username(例如 `stockai_xin_bot`)
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

### 盤後每日總結(台北 17:00,F3)
- 自選股當日漲跌 Top 3
- 庫存今日對成本盈虧 + 部位加權報酬率
- 獵鷹分 ≥ 設定閾值的命中名單
- 全市場戰略選股(top_picks.json)
- 設了 `GEMINI_API_KEY` → 附「💬 AI 短評」(權證小哥風格)

---

## 🎮 Telegram 指令(F1+F2)

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

## 🔍 維運

```bash
# 看 Worker 即時 log
wrangler tail

# 列出所有用戶
wrangler kv:key list --binding=KV --prefix=user: --remote

# 看某用戶資料
wrangler kv:key get "user:<chat_id>" --binding=KV --remote

# 刪某用戶
wrangler kv:key delete "user:<chat_id>" --binding=KV --remote

# 升級 Worker(改完 worker.js 後)
wrangler deploy
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

### Worker 部署後綁定一直失敗
- `wrangler tail` 看 Worker log,看 `/bot` 請求有沒有進來
- 沒進來 → webhook 沒設好,重跑步驟 5
- 進來但 403 → WEBHOOK_SECRET 沒一致,重設

### 收不到推送
- Telegram 傳 `/list` 看雲端清單對不對
- `wrangler tail` 看 cron 有沒有跑(每 30 分跑一次,Mon-Fri 09:00-13:30 台北)
- 看 `radar.json` 在 gh-pages 上面有沒有資料(daily_miner 跑完才有)

### 多個 cron 沒觸發
- Cloudflare 免費版 cron 只能 5 個,worker.js 目前 1 個
- 不夠用再升 Workers Paid($5/月 unlimited cron)

### 想自訂推送內容 / 加新訊號
- 改 `worker.js` 的 `scanUser` 函式
- 跑 `wrangler deploy` 即生效
