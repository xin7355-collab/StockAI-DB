// ═══════════════════════════════════════════════════════════════════════════
// 台股首席 AI 司令部 — Service Worker
// 負責：PWA 快取、Push 通知、背景週期查價告警 (Periodic Background Sync)
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'stockai-v1';

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
// 資料來源：gh-pages 靜態 JSON（GitHub Actions 每日更新）
//   GET data/{symbol}.json → 陣列，最後一筆含 close 欄位
//
// 流程：
//   1. 從 Cache Storage 讀取告警設定（由前端寫入 /sw-alert-config）
//   2. 用 self.location.origin + pathname 推算 gh-pages 根網址
//   3. 逐一 fetch data/{symbol}.json 取最新收盤價
//   4. 若現價跌破防守底線（defPrice），立刻推送系統通知
//
// 防護設計：
//   - 每檔獨立 try/catch，單支失敗不中斷整體迴圈
//   - 每次 fetch 間隔 1 秒，避免瞬間大量請求被 GitHub CDN 限速
//   - fetch 加 cache:'no-store'，確保拿到最新採礦結果而非瀏覽器舊快取
// ═══════════════════════════════════════════════════════════════════════════
async function checkPriceAlerts() {
    // ── 讀取前端存入 Cache Storage 的告警設定 ─────────────────────────────
    const cache    = await caches.open(CACHE_NAME);
    const alertRes = await cache.match('/sw-alert-config');
    if (!alertRes) return;

    const config = await alertRes.json();
    if (!config?.alerts?.length) return;

    // ── 推算 gh-pages 靜態資料根目錄 ──────────────────────────────────────
    // SW 的 self.location.href 例如：
    //   https://xin7355-collab.github.io/StockAI-DB/sw.js
    // 取到 /sw.js 前的目錄即為根目錄，再拼上 data/ 就是資料位置
    const ghRoot = self.location.href.replace(/\/sw\.js.*$/, '/');

    // ── 逐一即時查價並比對防守底線 ────────────────────────────────────────
    for (const alert of config.alerts) {
        if (!alert.symbol || !alert.defPrice) continue;

        // 每次 fetch 前等 1 秒，避免對 GitHub CDN 造成瞬間大流量
        await sleep(1000);

        try {
            const res = await fetch(`${ghRoot}data/${alert.symbol}.json`, {
                // 繞過快取，確保拿到 GitHub Actions 最新推送的採礦結果
                cache: 'no-store',
            });

            if (!res.ok) {
                console.warn(`[SW] 查價失敗 ${alert.symbol}: HTTP ${res.status}`);
                continue;
            }

            const rows = await res.json();
            if (!Array.isArray(rows) || rows.length === 0) continue;

            // 後端 / 採礦機輸出的陣列按日期升序，最後一筆是最新交易日
            const latestRow    = rows[rows.length - 1];
            const currentPrice = latestRow.close ?? latestRow.c;

            if (typeof currentPrice !== 'number') {
                console.warn(`[SW] ${alert.symbol} JSON 無 close 欄位`, latestRow);
                continue;
            }

            // ── 核心比對：現價跌破防守底線則推播緊急通知 ─────────────────
            if (currentPrice < alert.defPrice) {
                const name     = alert.name || alert.symbol;
                const priceFmt = currentPrice.toFixed(2);
                const defFmt   = Number(alert.defPrice).toFixed(2);

                await self.registration.showNotification('🚨 首席特急令：防守底線告警', {
                    body: `${name} 現價 ${priceFmt}，已跌破防守底線 ${defFmt}！請立刻執行紀律停損！`,
                    icon:  `${ghRoot}icon-192.png`,
                    badge: `${ghRoot}icon-192.png`,
                    tag:   `alert-${alert.symbol}`,   // 同檔只保留最新一則通知
                    requireInteraction: true,
                    vibrate: [300, 100, 300, 100, 600],
                    data: { url: ghRoot, symbol: alert.symbol }
                });
            }

        } catch (err) {
            // 單支股票查詢失敗（網路中斷、JSON 格式異常等），記錄後繼續下一支
            console.warn(`[SW] ${alert.symbol} 查價例外:`, err.message);
        }
    }
}

// 簡易延遲工具，避免對 GitHub CDN 瞬間大流量
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
