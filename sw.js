// ═══════════════════════════════════════════════════════════════════════════
// 台股首席 AI 司令部 — Service Worker
// 負責：PWA 快取、Push 通知、背景週期查價告警 (Periodic Background Sync)
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'stockai-v1';

// 後端 API 根網址（雲端部署時填入，例如 'https://api.example.com'）
// SW 無法存取 window.API_BASE_URL，所以必須在這裡獨立宣告。
// 空字串代表沒有自架後端，背景查價功能將無法運作。
const API_BASE_URL = '';

// ─── 1. 安裝事件：立即接管，不等舊 SW 失效 ─────────────────────────────────
self.addEventListener('install', () => {
    self.skipWaiting();
});

// ─── 2. 啟動事件：立即控制所有分頁 ──────────────────────────────────────────
self.addEventListener('activate', e => {
    e.waitUntil(clients.claim());
});

// ─── 3. Push 通知：由伺服器主動推送觸發（WebPush 協議）─────────────────────
self.addEventListener('push', e => {
    const data  = e.data ? e.data.json() : {};
    const title = data.title || '首席 AI 司令部告警';
    const body  = data.body  || '請立刻檢視您的持倉！';
    const icon  = data.icon  || '/icon-192.png';
    const tag   = data.tag   || 'stockai-alert';
    e.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            tag,
            badge: icon,
            vibrate: [200, 100, 200, 100, 400],
            requireInteraction: true,
            data: { url: data.url || '/' }
        })
    );
});

// ─── 4. 通知點擊：聚焦已開啟的分頁，或另開新視窗 ────────────────────────────
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            for (const client of clientList) {
                if (client.url === e.notification.data.url && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(e.notification.data.url);
        })
    );
});

// ─── 5. Periodic Background Sync：瀏覽器定期喚醒 SW 執行背景查價 ─────────────
self.addEventListener('periodicsync', e => {
    if (e.tag === 'price-check') {
        e.waitUntil(checkPriceAlerts());
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 【核心函式】背景即時查價告警
//
// 流程：
//   1. 從 Cache Storage 讀取告警設定（由前端寫入 /sw-alert-config）
//   2. 遍歷每筆告警，即時向後端 API 查詢最新收盤價
//   3. 若現價跌破防守底線（defPrice），立刻推送系統通知
//
// 防護設計：
//   - 每檔股票獨立 try/catch，單支失敗不影響其他股票
//   - 每次 fetch 之間插入 1 秒延遲，避免大量請求被後端或 TWSE 封鎖
//   - API_BASE_URL 為空時提前返回，不做無效請求
// ═══════════════════════════════════════════════════════════════════════════
async function checkPriceAlerts() {
    // 沒有設定後端 URL，無法即時查價，直接返回
    if (!API_BASE_URL) return;

    // ── 讀取前端存入 Cache Storage 的告警設定 ─────────────────────────────
    const cache    = await caches.open(CACHE_NAME);
    const alertRes = await cache.match('/sw-alert-config');
    if (!alertRes) return;

    const config = await alertRes.json();
    if (!config?.alerts?.length) return;

    // ── 逐一即時查價並比對防守底線 ────────────────────────────────────────
    for (const alert of config.alerts) {
        // 基本資料不齊全則跳過（symbol 和 defPrice 是必要欄位）
        if (!alert.symbol || !alert.defPrice) continue;

        // 每次 fetch 前先等 1 秒，避免瞬間打出大量請求
        await sleep(1000);

        try {
            // 向後端即時查詢該股票最新資料
            // 後端格式：GET /api/stock/{symbol}
            // 回傳：陣列，最新一筆（index 0 或最後一筆）含 close 欄位
            const res = await fetch(`${API_BASE_URL}/api/stock/${alert.symbol}`, {
                // 強制繞過快取，確保拿到最新股價，不是瀏覽器或 SW 快取的舊值
                cache: 'no-store',
            });

            if (!res.ok) {
                console.warn(`[SW] 查價失敗 ${alert.symbol}: HTTP ${res.status}`);
                continue;
            }

            const rows = await res.json();
            if (!rows || rows.length === 0) continue;

            // 取最後一筆（後端按日期升序，最新的在陣列末尾）
            const latestRow   = rows[rows.length - 1];
            const currentPrice = latestRow.close ?? latestRow.c;

            if (typeof currentPrice !== 'number') {
                console.warn(`[SW] ${alert.symbol} 回傳資料無 close 欄位`, latestRow);
                continue;
            }

            // ── 核心比對：現價跌破防守底線則推播緊急通知 ─────────────────
            if (currentPrice < alert.defPrice) {
                const name     = alert.name || alert.symbol;
                const priceFmt = currentPrice.toFixed(2);
                const defFmt   = Number(alert.defPrice).toFixed(2);

                await self.registration.showNotification('🚨 首席特急令：防守底線告警', {
                    body: `${name} 現價 ${priceFmt}，已跌破防守底線 ${defFmt}！請立刻執行紀律停損！`,
                    icon:  '/icon-192.png',
                    badge: '/icon-192.png',
                    tag:   `alert-${alert.symbol}`,   // 同一檔股票只保留最新一則通知
                    requireInteraction: true,
                    vibrate: [300, 100, 300, 100, 600],
                    data: { url: '/', symbol: alert.symbol }
                });
            }

        } catch (err) {
            // 單支股票查詢失敗（網路中斷、後端錯誤等），記錄後繼續處理下一支
            console.warn(`[SW] ${alert.symbol} 查價例外:`, err.message);
        }
    }
}

// 簡易延遲工具，避免背景輪詢對後端造成瞬間大流量
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
