const CACHE_NAME = 'stockai-v1';

self.addEventListener('install', e => {
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(clients.claim());
});

self.addEventListener('push', e => {
    const data = e.data ? e.data.json() : {};
    const title = data.title || '首席 AI 司令部告警';
    const body = data.body || '請立刻檢視您的持倉！';
    const icon = data.icon || '/icon-192.png';
    const tag = data.tag || 'stockai-alert';
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

self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            for (const client of clientList) {
                if (client.url === e.notification.data.url && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(e.notification.data.url);
        })
    );
});

// Periodic background sync for price alerts (fires when browser wakes the SW)
self.addEventListener('periodicsync', e => {
    if (e.tag === 'price-check') {
        e.waitUntil(checkPriceAlerts());
    }
});

async function checkPriceAlerts() {
    // Read alert config from cache storage
    const cache = await caches.open(CACHE_NAME);
    const alertRes = await cache.match('/sw-alert-config');
    if (!alertRes) return;
    const config = await alertRes.json();
    if (!config || !config.alerts || config.alerts.length === 0) return;
    for (const alert of config.alerts) {
        if (!alert.symbol || !alert.defPrice || !alert.currentPrice) continue;
        if (alert.currentPrice < alert.defPrice) {
            await self.registration.showNotification('🚨 首席特急令：防守底線告警', {
                body: `${alert.name || alert.symbol} 現價 ${alert.currentPrice}，已跌破防守底線 ${alert.defPrice}！請立刻執行紀律停損！`,
                tag: `alert-${alert.symbol}`,
                requireInteraction: true,
                vibrate: [300, 100, 300, 100, 600]
            });
        }
    }
}
