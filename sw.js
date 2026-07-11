// ═══════════════════════════════════════════════════════════════════════════
// 台股首席 AI 司令部 — Service Worker
// 負責：PWA 快取、Push 通知、背景週期查價告警 (Periodic Background Sync)
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'stockai-v3';   // V60.0 — bump 快取版本:強制淘汰舊快取,PWA 抓最新前端

// ─── 1. 安裝事件：立即接管，不等舊 SW 失效 ─────────────────────────────────
self.addEventListener('install', () => {
    self.skipWaiting();
});

// ─── 2. 啟動事件：立即清除舊快取並控制所有分頁 ──────────────────────────────
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        }).then(() => clients.claim())
    );
});

// ─── 3. 網路攔截 (Fetch)：PWA 的靈魂！確保能安裝且支援離線開啟 ───────────────
// 【修復】加入網路優先 (Network First) 策略。沒加這個，手機不會認定你是合格的 PWA！
self.addEventListener('fetch', e => {
    // 排除非 GET 請求，以及跨網域請求 (如 Groq API, 證交所 API) 不做快取
    if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) {
        return;
    }

    // 【修復 K 線缺資料】動態資料（K線/籌碼/各式 cache JSON）一律走純網路，永不快取，
    // 杜絕手機 PWA 吃到舊的採礦結果。斷網時才退而求其次拿舊快取。
    // V18.2 — fetch 加 18 秒 hard timeout(防 iOS PWA 網路堆疊偶爾 hang 不返,
    //         頁面 AbortSignal 在 SW 範圍內救不到 → 整個 e.respondWith 卡死 → 卡 loading)
    const reqUrl = new URL(e.request.url);
    if (reqUrl.pathname.includes('/data/') || reqUrl.pathname.endsWith('.json')) {
        const fetchWithTimeout = Promise.race([
            fetch(e.request),
            new Promise((_, rej) => setTimeout(() => rej(new Error('SW fetch timeout 18s')), 18000))
        ]);
        e.respondWith(fetchWithTimeout.catch(() => caches.match(e.request) || new Response('{}', { status: 504, headers: { 'Content-Type': 'application/json' } })));
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then(response => {
                // 如果網路通暢，把最新抓到的檔案存進快取備用
                const resClone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(e.request, resClone);
                });
                return response;
            })
            .catch(() => {
                // 如果斷網（搭捷運、無訊號），退而求其次從快取拿舊畫面，避免恐龍出現
                return caches.match(e.request);
            })
    );
});

// ─── 4. Push 通知：由伺服器主動推送觸發（WebPush 協議）─────────────────────
self.addEventListener('push', e => {
    const data  = e.data ? e.data.json() : {};
    const title = data.title || '首席 AI';
    const body  = data.body  || '請立刻檢視您的持倉！';
    const icon  = data.icon  || '/icon-192.png';
    const tag   = data.tag   || 'stockai-alert';
    
    // 【修復】使用 self.registration.scope 取代 '/'，完美適應 GitHub Pages 路徑
    const targetUrl = data.url || self.registration.scope; 

    e.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            tag,
            badge: icon,
            vibrate: [200, 100, 200, 100, 400],
            requireInteraction: true,
            data: { url: targetUrl }
        })
    );
});

// ─── 5. 通知點擊：聚焦已開啟的分頁，或另開新視窗 ────────────────────────────
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

// ─── 6. Periodic Background Sync：瀏覽器定期喚醒 SW 執行背景查價 ─────────────
self.addEventListener('periodicsync', e => {
    if (e.tag === 'price-check') {
        e.waitUntil(checkPriceAlerts());
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 【核心函式】背景即時查價告警
// ═══════════════════════════════════════════════════════════════════════════
async function checkPriceAlerts() {
    // ── 讀取前端存入 Cache Storage 的告警設定 ─────────────────────────────
    const cache    = await caches.open(CACHE_NAME);
    const alertRes = await cache.match('/sw-alert-config');
    if (!alertRes) return;

    const config = await alertRes.json();
    if (!config?.alerts?.length) return;

    // ── 推算 gh-pages 靜態資料根目錄 ──────────────────────────────────────
    // 【修復】直接使用 Service Worker 註冊的作用域，這是最標準、最安全的做法
    const ghRoot = self.registration.scope;

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

                await self.registration.showNotification('🚨 首席停損', {
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