// StockAI Cloudflare Worker — Telegram 雲端個股提醒
//
// 路徑:
//   POST /pending  — 前端發起綁定:把綁定碼 + 自選清單暫存 KV(10 分鐘 TTL)
//   GET  /check    — 前端 polling 看 bot 那邊有沒有完成綁定
//   POST /sync     — 前端在自選 / 庫存 / 監控有變時推同步
//   POST /unbind   — 前端解除綁定
//   POST /bot      — Telegram webhook(/start /bind /list /mute /unmute /unbind /help)
//   GET  /health   — 健康檢查
//
// scheduled — 台北盤中每 30 分掃自選股 + 推送
//
// 環境變數:
//   TELEGRAM_BOT_TOKEN  (secret,必填)
//   WEBHOOK_SECRET      (secret,選填,擋偽造 webhook)
//
// KV bindings:
//   KV  (namespace)
//
// KV schema:
//   pending:<code>        → JSON payload   (TTL 10min)
//   user:<chat_id>        → JSON 用戶資料
//   code:<code>           → chat_id        (反查,供 /sync /check)
//   pushed:<chat_id>:<sym>:<type>  → 1     (TTL 6h,防重複推)

const BIND_TTL = 600;
const PUSH_DEDUP_TTL = 6 * 3600;
const GH_PAGES_BASE = 'https://xin7355-collab.github.io/StockAI-DB';
const MAX_TG_LEN = 3800;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
});

const tg = async (env, chatId, text, opts = {}) => {
    const truncated = String(text || '').slice(0, MAX_TG_LEN);
    return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: truncated, parse_mode: 'Markdown', disable_web_page_preview: true, ...opts }),
    });
};

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname}`;

        try {
            if (route === 'POST /pending') return await handlePending(request, env);
            if (route === 'GET /check')    return await handleCheck(url, env);
            if (route === 'POST /sync')    return await handleSync(request, env);
            if (route === 'POST /unbind')  return await handleUnbind(request, env);
            if (route === 'POST /bot')     return await handleBot(request, env);
            if (route === 'GET /health')   return json({ ok: true, t: Date.now() });
        } catch (e) {
            return json({ error: 'internal', detail: String(e?.message || e) }, 500);
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    },

    async scheduled(event, env, ctx) {
        // 兩個 cron 排程分流:17:00 台北每日總結 / 其餘 30 分掃描
        if (event.cron === '0 9 * * 1-5') {
            ctx.waitUntil(runDailySummary(env));
        } else {
            ctx.waitUntil(runScan(env));
        }
    },
};

async function handlePending(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !isValidCode(body.code)) return json({ error: 'invalid code' }, 400);
    const payload = sanitizePayload(body.payload || {});
    await env.KV.put(`pending:${body.code}`, JSON.stringify(payload), { expirationTtl: BIND_TTL });
    return json({ ok: true, ttl: BIND_TTL });
}

async function handleCheck(url, env) {
    const code = url.searchParams.get('code');
    if (!isValidCode(code)) return json({ error: 'invalid code' }, 400);
    const chatId = await env.KV.get(`code:${code}`);
    return json({ bound: !!chatId, chat_id: chatId || null });
}

async function handleSync(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !isValidCode(body.code)) return json({ error: 'invalid code' }, 400);
    const chatId = await env.KV.get(`code:${body.code}`);
    if (!chatId) return json({ error: 'not bound' }, 401);
    const existing = JSON.parse((await env.KV.get(`user:${chatId}`)) || '{}');
    const merged = {
        ...existing,
        ...sanitizePayload(body.payload || {}),
        chat_id: chatId,
        code: body.code,
        last_sync: Date.now(),
    };
    await env.KV.put(`user:${chatId}`, JSON.stringify(merged));
    return json({ ok: true });
}

async function handleUnbind(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || !isValidCode(body.code)) return json({ error: 'invalid code' }, 400);
    const chatId = await env.KV.get(`code:${body.code}`);
    if (!chatId) return json({ ok: true, already: true });
    await env.KV.delete(`user:${chatId}`);
    await env.KV.delete(`code:${body.code}`);
    return json({ ok: true });
}

async function handleBot(request, env) {
    if (env.WEBHOOK_SECRET) {
        const got = request.headers.get('x-telegram-bot-api-secret-token');
        if (got !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    }

    const update = await request.json().catch(() => null);
    const msg = update?.message;
    if (!msg?.text || !msg.chat?.id) return new Response('ok');

    const chatId = String(msg.chat.id);
    const text = String(msg.text).trim();

    if (text === '/start') {
        await tg(env, chatId,
            '👋 *StockAI 個股雲端提醒*\n\n' +
            '請回網頁的「⚙️ 戰情設定」→「📨 Telegram 雲端推送」,按「啟用」拿綁定碼,' +
            '然後傳 `/bind 你的綁定碼` 給我即可完成。\n\n' +
            '*指令清單*\n' +
            '`/list` - 看雲端清單\n' +
            '`/set 閾值 數值` - 調獵鷹/漲跌警戒\n' +
            '`/cost 代號 成本` - 設庫存成本\n' +
            '`/mute` - 暫停 24 小時\n' +
            '`/unmute` - 恢復推送\n' +
            '`/unbind` - 解除綁定\n' +
            '`/help` - 全部指令'
        );
    } else if (text.startsWith('/bind ')) {
        const code = text.slice(6).trim().toUpperCase();
        if (!isValidCode(code)) {
            await tg(env, chatId, '❌ 綁定碼格式不對(應為 6-12 碼大寫英數)');
            return new Response('ok');
        }
        const pending = await env.KV.get(`pending:${code}`);
        if (!pending) {
            await tg(env, chatId, '❌ 綁定碼無效或已過期(10 分鐘內有效)。請回網頁重點「啟用」拿新綁定碼。');
        } else {
            const payload = JSON.parse(pending);
            const userObj = {
                ...payload,
                chat_id: chatId,
                code,
                bound_at: Date.now(),
                last_sync: Date.now(),
            };
            await env.KV.put(`user:${chatId}`, JSON.stringify(userObj));
            await env.KV.put(`code:${code}`, chatId);
            await env.KV.delete(`pending:${code}`);
            const watchN = (payload.watchlist || []).length;
            const invN = (payload.inventory || []).length;
            const monN = (payload.monitorList || []).length;
            await tg(env, chatId,
                `✅ *綁定成功*\n\n已同步 *${watchN} 檔自選股* + *${invN} 檔庫存* + *${monN} 檔監控股*。\n\n` +
                `以後盤中遇到重要訊號會在這推送(獵鷹分突破 / 大漲跌 / 庫存到停利停損 / 黑天鵝)。\n\n` +
                `傳 \`/list\` 看雲端清單,\`/help\` 看全部指令。`
            );
        }
    } else if (text === '/list') {
        const userData = await env.KV.get(`user:${chatId}`);
        if (!userData) {
            await tg(env, chatId, '❌ 尚未綁定。請回網頁點「啟用」拿綁定碼。');
            return new Response('ok');
        }
        const u = JSON.parse(userData);
        const watch = (u.watchlist || []).slice(0, 30).join(', ') || '(空)';
        const inv = (u.inventory || []).map(i => `${i.sym}(${i.cost})`).slice(0, 20).join(', ') || '(空)';
        const monitor = (u.monitorList || []).slice(0, 30).join(', ') || '(空)';
        const muted = u.muted_until && u.muted_until > Date.now()
            ? `\n\n🔕 *目前暫停中*(到 ${new Date(u.muted_until).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})` : '';
        await tg(env, chatId,
            `📋 *雲端清單*\n\n*自選*: ${watch}\n*庫存*: ${inv}\n*監控*: ${monitor}${muted}\n\n` +
            `_最後同步: ${new Date(u.last_sync).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}_`
        );
    } else if (text === '/mute') {
        const userData = JSON.parse((await env.KV.get(`user:${chatId}`)) || '{}');
        if (!userData.chat_id) {
            await tg(env, chatId, '❌ 尚未綁定');
            return new Response('ok');
        }
        userData.muted_until = Date.now() + 86400000;
        await env.KV.put(`user:${chatId}`, JSON.stringify(userData));
        await tg(env, chatId, '🔕 已暫停推送 24 小時,傳 `/unmute` 隨時恢復');
    } else if (text === '/unmute') {
        const userData = JSON.parse((await env.KV.get(`user:${chatId}`)) || '{}');
        if (!userData.chat_id) {
            await tg(env, chatId, '❌ 尚未綁定');
            return new Response('ok');
        }
        delete userData.muted_until;
        await env.KV.put(`user:${chatId}`, JSON.stringify(userData));
        await tg(env, chatId, '🔔 已恢復推送');
    } else if (text === '/unbind') {
        const userData = JSON.parse((await env.KV.get(`user:${chatId}`)) || '{}');
        if (userData.code) await env.KV.delete(`code:${userData.code}`);
        await env.KV.delete(`user:${chatId}`);
        await tg(env, chatId, '👋 已解除綁定,清單已刪除。要重綁請回網頁點「啟用」。');
    } else if (text === '/set' || text.startsWith('/set ')) {
        await handleSet(env, chatId, text);
    } else if (text === '/cost' || text.startsWith('/cost ')) {
        await handleCost(env, chatId, text);
    } else if (text === '/help' || text === '/?') {
        await tg(env, chatId,
            '*指令清單*\n\n' +
            '`/bind 綁定碼` - 用網頁拿到的綁定碼綁定\n' +
            '`/list` - 看你的雲端清單\n' +
            '`/set 閾值 數值` - 調閾值(`falcon 80` / `surge 7` / `drop 4`)\n' +
            '`/cost 代號 成本 [張數]` - 設庫存成本(例 `/cost 2330 1000`)\n' +
            '`/mute` - 暫停推送 24 小時\n' +
            '`/unmute` - 恢復推送\n' +
            '`/unbind` - 解除綁定(清空清單)'
        );
    } else {
        await tg(env, chatId, '收到!傳 `/help` 看可用指令');
    }

    return new Response('ok');
}

// ── Validators & sanitizers ─────────────────────────────────────────

function isValidCode(code) {
    return typeof code === 'string' && /^[A-Z0-9]{6,12}$/.test(code);
}

function isValidSym(s) {
    return typeof s === 'string' && /^[0-9A-Z]{4,8}$/.test(s);
}

function sanitizePayload(payload) {
    const out = {};
    if (Array.isArray(payload.watchlist)) {
        out.watchlist = [...new Set(payload.watchlist.map(s => String(s).trim().toUpperCase()))]
            .filter(isValidSym)
            .slice(0, 200);
    }
    if (Array.isArray(payload.monitorList)) {
        out.monitorList = [...new Set(payload.monitorList.map(s => String(s).trim().toUpperCase()))]
            .filter(isValidSym)
            .slice(0, 200);
    }
    if (Array.isArray(payload.inventory)) {
        out.inventory = payload.inventory
            .filter(i => i && typeof i === 'object')
            .map(i => ({
                sym: String(i.sym || i.symbol || '').trim().toUpperCase(),
                cost: Number(i.cost) || 0,
                qty: Number(i.qty) || 0,
            }))
            .filter(i => isValidSym(i.sym))
            .slice(0, 100);
    }
    if (payload.settings && typeof payload.settings === 'object') {
        out.settings = {
            falcon_threshold: clamp(payload.settings.falcon_threshold, 60, 95, 85),
            surge_threshold: clamp(payload.settings.surge_threshold, 2, 10, 5),
            drop_threshold: clamp(payload.settings.drop_threshold, 2, 10, 5),
        };
        // V16.0 — Fugle token 帶上雲,供 Worker 跑內外盤分析(只 trim 不加密,KV 內部已加密儲存)
        const ft = String(payload.settings.fugleToken1 || '').trim();
        if (ft && ft.length >= 8 && ft.length <= 100) out.settings.fugleToken1 = ft;
    }
    return out;
}

function clamp(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
}

// ── Scheduled scan & push ───────────────────────────────────────────

// V16.0 — 拿單檔股票歷史 OHLCV 算 5MA 價 + 5 日均量(供盤中量爆 / 突破 5MA 規則)
async function fetchVolumeBaseline(sym, cache) {
    if (cache.has(sym)) return cache.get(sym);
    let baseline = null;
    try {
        const url = `${GH_PAGES_BASE}/data/${encodeURIComponent(sym)}.json?t=${Date.now()}`;
        const res = await fetch(url);
        if (res.ok) {
            const rows = await res.json().catch(() => null);
            if (Array.isArray(rows) && rows.length >= 5) {
                const last5 = rows.slice(-5);
                const closes = last5.map(r => Number(r.close)).filter(Number.isFinite);
                const vols = last5.map(r => Number(r.volume)).filter(Number.isFinite);
                if (closes.length === 5 && vols.length === 5) {
                    baseline = {
                        ma5: closes.reduce((s, v) => s + v, 0) / 5,
                        vma5: vols.reduce((s, v) => s + v, 0) / 5,   // 5 日均量(股,× 1000 才是張)
                    };
                }
            }
        }
    } catch (_) { /* silent */ }
    cache.set(sym, baseline);
    return baseline;
}

// V16.0 — Fugle 即時報價(含內外盤 bidVol/askVol),需 user 自己的 fugleToken
async function fetchFugleQuote(sym, token) {
    if (!token) return null;
    try {
        const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(sym)}?apiKey=${encodeURIComponent(token)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        if (!j) return null;
        const bid = Number(j.bidVolume ?? j.bidVol ?? j.bestBidVolume ?? 0);
        const ask = Number(j.askVolume ?? j.askVol ?? j.bestAskVolume ?? 0);
        return { bid, ask };
    } catch (_) { return null; }
}

// V15.9 — 直連 TWSE MIS 拿盤中即時報價(免費、免 token、無 rate limit,推薦 polling ≥ 5 秒)
//         一批最多 50 檔(以 '|' 串接),回 JSON.msgArray 含 z(成交價)、y(昨收)、v(累計量)、tv(當筆量)
async function fetchTwseMisQuote(symbols) {
    const map = new Map();
    if (!symbols.length) return map;
    // 一次最多 50 檔批量(超過分批)
    const batches = [];
    for (let i = 0; i < symbols.length; i += 50) batches.push(symbols.slice(i, i + 50));
    for (const batch of batches) {
        const exch = batch.map(s => `tse_${s}.tw`).join('|');
        const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exch}&json=1&delay=0`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 StockAI-Worker' } });
            if (!res.ok) continue;
            const j = await res.json().catch(() => null);
            for (const m of (j?.msgArray || [])) {
                const sym = String(m.c || '').trim();
                if (!sym) continue;
                const z = parseFloat(m.z);    // 最後成交價
                const y = parseFloat(m.y);    // 昨收
                if (!Number.isFinite(z) || !Number.isFinite(y) || y <= 0) continue;
                const pct = (z - y) / y * 100;
                map.set(sym, {
                    z, y, pct,
                    v: parseFloat(m.v || '0'),    // 累計成交量(張)
                    o: parseFloat(m.o || '0'),    // 開盤
                    h: parseFloat(m.h || '0'),    // 最高
                    l: parseFloat(m.l || '0'),    // 最低
                });
            }
        } catch (_) { /* batch failed, skip */ }
    }
    return map;
}

async function runScan(env) {
    const t = Date.now();
    const [radarRes, macroRes] = await Promise.all([
        fetch(`${GH_PAGES_BASE}/data/radar.json?t=${t}`).catch(() => null),
        fetch(`${GH_PAGES_BASE}/data/macro_risk.json?t=${t}`).catch(() => null),
    ]);

    const radar = radarRes?.ok ? await radarRes.json().catch(() => null) : null;
    const macro = macroRes?.ok ? await macroRes.json().catch(() => null) : null;

    const falconMap = buildFalconMap(radar);
    const macroAlert = buildMacroAlert(macro);

    // V15.9 — 收集所有 user 的監看股 + 庫存,一批打 TWSE MIS 拿即時報價
    const allSymbols = new Set();
    let cursor = undefined;
    const users = [];
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                users.push(userData);
                (userData.watchlist || []).forEach(s => allSymbols.add(s));
                (userData.monitorList || []).forEach(s => allSymbols.add(s));
                (userData.inventory || []).forEach(i => { if (i?.sym) allSymbols.add(i.sym); });
            } catch (e) { /* continue */ }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }

    const liveQuotes = await fetchTwseMisQuote([...allSymbols]);
    if (!falconMap.size && !macroAlert && !liveQuotes.size) return;

    // V16.0 — vma5/ma5 baseline 跨用戶共用 cache(同股不重複 fetch data/{sym}.json)
    const volBaseCache = new Map();
    // 計算「盤中已過分鐘」(09:00-13:30 台北,跳午休 11:30-13:00,共 270 分)
    const tpe = new Date(Date.now() + 8 * 3600e3);   // UTC+8
    const utcH = tpe.getUTCHours(), utcM = tpe.getUTCMinutes();
    let elapsed = 0;
    if (utcH >= 9 && (utcH < 13 || (utcH === 13 && utcM <= 30))) {
        if (utcH < 11 || (utcH === 11 && utcM < 30)) {
            elapsed = (utcH - 9) * 60 + utcM;
        } else if (utcH < 13) {
            elapsed = 150;   // 午休:09:00-11:30 = 150 分
        } else {
            elapsed = 150 + (utcM);   // 下午:09:00-11:30 + 13:00-13:30
        }
    }

    for (const userData of users) {
        try { await scanUser(env, userData, falconMap, macroAlert, liveQuotes, volBaseCache, elapsed); }
        catch (e) { /* continue */ }
    }
}

function buildFalconMap(radar) {
    const map = new Map();
    if (!radar) return map;
    // radar.json 結構可能是 {falcon: [...]} / {stocks: [...]} / {by_strategy: ...}
    const lists = [
        radar.falcon, radar.stocks, radar.list,
        radar.by_strategy?.falcon, radar.by_strategy?.flag,
        ...Object.values(radar.by_strategy || {}).filter(Array.isArray),
    ].filter(Array.isArray);
    for (const arr of lists) {
        for (const s of arr) {
            if (!s) continue;
            const sym = String(s.sym || s.symbol || s.id || '').trim().toUpperCase();
            if (!sym) continue;
            const cur = map.get(sym) || { sym };
            for (const [k, v] of Object.entries(s)) {
                if (cur[k] == null && v != null) cur[k] = v;
            }
            map.set(sym, cur);
        }
    }
    return map;
}

function buildMacroAlert(macro) {
    if (!macro) return null;
    const events = macro.upcoming_macro_events || macro.events || [];
    if (!Array.isArray(events) || !events.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const hot = events.filter(e => {
        if (!e) return false;
        const sev = (e.severity || e.level || '').toString();
        const isHi = sev.includes('高') || /high/i.test(sev);
        const days = Number(e.days_until ?? e.days);
        const isDDay = e.date === today || (Number.isFinite(days) && days <= 1);
        return isHi && isDDay;
    });
    if (!hot.length) return null;
    return hot.map(e => `⚠️ ${e.date || '今日'} ${e.event || e.name || ''}`).join('\n');
}

async function scanUser(env, user, falconMap, macroAlert, liveQuotes, volBaseCache, elapsed) {
    const symbols = new Set();
    (user.watchlist || []).forEach(s => symbols.add(s));
    (user.monitorList || []).forEach(s => symbols.add(s));
    (user.inventory || []).forEach(i => { if (i?.sym) symbols.add(i.sym); });

    const settings = user.settings || {};
    const falconTh = settings.falcon_threshold || 85;
    const surgeTh = settings.surge_threshold || 5;
    const dropTh = settings.drop_threshold || 5;

    const alerts = [];

    if (macroAlert && !(await wasPushed(env, user.chat_id, '__macro__', 'daily'))) {
        alerts.push(`🚨 *今日總經風險警報*\n${macroAlert}`);
        await markPushed(env, user.chat_id, '__macro__', 'daily', 24 * 3600);
    }

    for (const sym of symbols) {
        const stock = falconMap.get(sym) || { sym };
        // V15.9 — 即時報價優先(MIS z = 最後成交價,pct = 即時漲跌幅),fallback radar.json 盤後值
        const live = liveQuotes ? liveQuotes.get(sym) : null;
        const close = live ? live.z : Number(stock.close);
        const pct   = live ? live.pct : Number(stock.change_pct ?? stock.chg_pct);

        const fs = Number(stock.falcon_score ?? stock.score);
        if (Number.isFinite(fs) && fs >= falconTh) {
            const ptype = `falcon_${falconTh}`;
            if (!(await wasPushed(env, user.chat_id, sym, ptype))) {
                const tags = Array.isArray(stock.tags) ? stock.tags.slice(0, 3).join(' / ') : (stock.strategy || '建倉訊號');
                alerts.push(`🦅 *${sym}* 獵鷹分 *${fs}*(≥${falconTh})— ${tags}`);
                await markPushed(env, user.chat_id, sym, ptype);
            }
        }

        if (Number.isFinite(pct)) {
            // V15.9 — 朱老師「位階過高」即時規則(漲幅 > 7% → 別追)
            if (pct > 7 && !(await wasPushed(env, user.chat_id, sym, 'overheat7'))) {
                alerts.push(`⚠️ *${sym}* 位階過高 *+${pct.toFixed(2)}%*${Number.isFinite(close) ? ` — ${close}` : ''}\n朱老師心法:漲幅 >7% 別追,放鎖股等回檔`);
                await markPushed(env, user.chat_id, sym, 'overheat7');
            } else if (pct >= surgeTh && !(await wasPushed(env, user.chat_id, sym, 'surge'))) {
                alerts.push(`🚀 *${sym}* 大漲 *+${pct.toFixed(2)}%*${Number.isFinite(close) ? ` — ${close}` : ''}`);
                await markPushed(env, user.chat_id, sym, 'surge');
            } else if (pct <= -dropTh && !(await wasPushed(env, user.chat_id, sym, 'drop'))) {
                alerts.push(`📉 *${sym}* 大跌 *${pct.toFixed(2)}%*${Number.isFinite(close) ? ` — ${close}` : ''}`);
                await markPushed(env, user.chat_id, sym, 'drop');
            }
        }

        const inv = (user.inventory || []).find(i => i.sym === sym);
        if (inv?.cost > 0 && Number.isFinite(close) && close > 0) {
            const ret = ((close - inv.cost) / inv.cost) * 100;
            if (ret >= 20 && !(await wasPushed(env, user.chat_id, sym, 'tp20'))) {
                alerts.push(`💰 *${sym}* 庫存浮盈 *+${ret.toFixed(1)}%*(${inv.cost}→${close})達 +20% 停利線`);
                await markPushed(env, user.chat_id, sym, 'tp20');
            } else if (ret <= -8 && !(await wasPushed(env, user.chat_id, sym, 'sl8'))) {
                alerts.push(`🛑 *${sym}* 庫存浮虧 *${ret.toFixed(1)}%*(${inv.cost}→${close})達 -8% 停損線`);
                await markPushed(env, user.chat_id, sym, 'sl8');
            }
        }

        // V16.0 — 量爆 + 突破 5MA(只在盤中時段 elapsed >= 30 分後判,避開開盤 noise)
        if (live && volBaseCache && elapsed >= 30) {
            const base = await fetchVolumeBaseline(sym, volBaseCache);
            if (base && base.ma5 > 0 && base.vma5 > 0) {
                const vTodayLots = (live.v || 0);   // MIS v 在 TWSE MIS 是「累計成交股數」?實測對齊「張」單位較常見
                const vRatio = vTodayLots / (base.vma5 * (elapsed / 270));
                const breakMa5 = live.z > base.ma5;
                if (vRatio > 1.5 && breakMa5 && !(await wasPushed(env, user.chat_id, sym, 'volBreak5ma'))) {
                    alerts.push(`🚀 *${sym}* 量爆突破 5MA *${live.z.toFixed(2)}*(>${base.ma5.toFixed(2)})\n預估量 ${vRatio.toFixed(1)}× 5日均 — 朱老師「量增突破」進場訊號`);
                    await markPushed(env, user.chat_id, sym, 'volBreak5ma');
                }
            }
        }

        // V16.0 — Fugle 內外盤強買賣(需 user.settings.fugleToken1,沒設則跳過)
        const fugleToken = settings.fugleToken1 || '';
        if (fugleToken && live) {
            const fq = await fetchFugleQuote(sym, fugleToken);
            if (fq && fq.bid > 0 && fq.ask > 0) {
                const askBidRatio = fq.ask / fq.bid;
                if (askBidRatio > 2 && !(await wasPushed(env, user.chat_id, sym, 'fugleStrongBuy'))) {
                    alerts.push(`💪 *${sym}* 主力強勢買盤(外盤 ${fq.ask} / 內盤 ${fq.bid} = ${askBidRatio.toFixed(1)}×)\n當前價 ${live.z.toFixed(2)}`);
                    await markPushed(env, user.chat_id, sym, 'fugleStrongBuy');
                } else if (askBidRatio < 0.5 && !(await wasPushed(env, user.chat_id, sym, 'fugleStrongSell'))) {
                    alerts.push(`🩸 *${sym}* 主力強勢殺盤(內盤 ${fq.bid} / 外盤 ${fq.ask} = ${(1/askBidRatio).toFixed(1)}×)\n當前價 ${live.z.toFixed(2)}`);
                    await markPushed(env, user.chat_id, sym, 'fugleStrongSell');
                }
            }
        }
    }

    if (!alerts.length) return;

    const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const text = `🤖 *StockAI 個股提醒*\n\n${alerts.join('\n\n')}\n\n_${ts}_`;
    await tg(env, user.chat_id, text);
}

async function wasPushed(env, chatId, sym, type) {
    return !!(await env.KV.get(`pushed:${chatId}:${sym}:${type}`));
}

async function markPushed(env, chatId, sym, type, ttl = PUSH_DEDUP_TTL) {
    await env.KV.put(`pushed:${chatId}:${sym}:${type}`, '1', { expirationTtl: ttl });
}

// ── F1: /set <key> <value> — 用戶調閾值 ───────────────────────────────

const SET_KEY_RANGES = {
    falcon: { min: 60, max: 95, field: 'falcon_threshold', label: '🦅 獵鷹建倉分' },
    surge:  { min: 2,  max: 10, field: 'surge_threshold',  label: '🚀 大漲警戒(%)' },
    drop:   { min: 2,  max: 10, field: 'drop_threshold',   label: '📉 大跌警戒(%)' },
};

async function handleSet(env, chatId, text) {
    const userData = JSON.parse((await env.KV.get(`user:${chatId}`)) || '{}');
    if (!userData.chat_id) {
        await tg(env, chatId, '❌ 尚未綁定。請回網頁點「啟用」拿綁定碼。');
        return;
    }
    const settings = userData.settings || {};
    const parts = text.split(/\s+/).slice(1);
    if (parts.length === 0) {
        const lines = Object.entries(SET_KEY_RANGES).map(([k, cfg]) => {
            const cur = settings[cfg.field] ?? '預設';
            return `\`${k}\` ${cfg.label} — 目前: *${cur}* (範圍 ${cfg.min}-${cfg.max})`;
        });
        await tg(env, chatId,
            '*目前閾值設定*\n\n' + lines.join('\n') + '\n\n' +
            '*用法*\n`/set falcon 80` — 獵鷹分 ≥80 才推\n`/set surge 7` — 漲幅 ≥7% 才推\n`/set drop 4` — 跌幅 ≤-4% 才推'
        );
        return;
    }
    const [key, valStr] = parts;
    const cfg = SET_KEY_RANGES[key];
    if (!cfg) {
        await tg(env, chatId, `❌ 未知閾值 \`${key}\`,可用:\`falcon\` / \`surge\` / \`drop\``);
        return;
    }
    const val = Number(valStr);
    if (!Number.isFinite(val) || val < cfg.min || val > cfg.max) {
        await tg(env, chatId, `❌ 數值需在 ${cfg.min}-${cfg.max} 之間(收到「${valStr}」)`);
        return;
    }
    settings[cfg.field] = val;
    userData.settings = settings;
    await env.KV.put(`user:${chatId}`, JSON.stringify(userData));
    await tg(env, chatId, `✅ ${cfg.label} → *${val}*\n\n下一輪 cron 開始生效。`);
}

// ── F2: /cost <sym> <price> [qty] — 用戶設庫存成本 ──────────────────

async function handleCost(env, chatId, text) {
    const userData = JSON.parse((await env.KV.get(`user:${chatId}`)) || '{}');
    if (!userData.chat_id) {
        await tg(env, chatId, '❌ 尚未綁定。請回網頁點「啟用」拿綁定碼。');
        return;
    }
    const parts = text.split(/\s+/).slice(1);
    if (parts.length === 0) {
        const inv = userData.inventory || [];
        const lines = inv.length
            ? inv.map(i => `*${i.sym}* — 成本 ${i.cost}${i.qty ? ` × ${i.qty} 張` : ''}`).join('\n')
            : '(空)';
        await tg(env, chatId,
            '*目前庫存*\n\n' + lines + '\n\n' +
            '*用法*\n`/cost 2330 1100` — 設成本 1100\n`/cost 2330 1100 5` — 成本 1100 / 5 張\n`/cost 2330` — 只查目前成本'
        );
        return;
    }
    const sym = String(parts[0] || '').trim().toUpperCase();
    if (!isValidSym(sym)) {
        await tg(env, chatId, `❌ 股票代號格式不對:\`${parts[0]}\``);
        return;
    }
    const inv = userData.inventory || [];
    if (parts.length === 1) {
        const found = inv.find(i => i.sym === sym);
        await tg(env, chatId, found
            ? `*${sym}* 目前成本 *${found.cost}*${found.qty ? ` / ${found.qty} 張` : ''}`
            : `*${sym}* 不在庫存中,傳 \`/cost ${sym} 成本\` 新增`);
        return;
    }
    const cost = Number(parts[1]);
    if (!Number.isFinite(cost) || cost <= 0) {
        await tg(env, chatId, `❌ 成本需為大於 0 的數字(收到「${parts[1]}」)`);
        return;
    }
    let qty = parts[2] != null ? Number(parts[2]) : undefined;
    if (parts[2] != null && (!Number.isFinite(qty) || qty < 0)) {
        await tg(env, chatId, `❌ 張數需為 ≥ 0 的數字(收到「${parts[2]}」)`);
        return;
    }
    const idx = inv.findIndex(i => i.sym === sym);
    if (idx >= 0) {
        inv[idx].cost = cost;
        if (qty != null) inv[idx].qty = qty;
    } else {
        inv.push({ sym, cost, qty: qty || 0 });
    }
    userData.inventory = inv;
    await env.KV.put(`user:${chatId}`, JSON.stringify(userData));
    await tg(env, chatId, `✅ *${sym}* 成本記為 *${cost}*${qty != null ? ` / ${qty} 張` : ''}\n\n達 +20% 自動推停利、-8% 推停損。`);
}

// ── F4: Gemini AI 短評(只在每日總結用)────────────────────────────────

async function gemini(env, prompt) {
    if (!env.GEMINI_API_KEY) return null;
    try {
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { maxOutputTokens: 300, temperature: 0.5 },
                }),
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!r.ok) return null;
        const j = await r.json();
        return (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim() || null;
    } catch (_) {
        return null;
    }
}

// ── F3: 每日 17:00 台北 盤後總結(cron '0 9 * * 1-5')─────────────────

async function runDailySummary(env) {
    const t = Date.now();
    const [radarRes, topRes] = await Promise.all([
        fetch(`${GH_PAGES_BASE}/data/radar.json?t=${t}`).catch(() => null),
        fetch(`${GH_PAGES_BASE}/data/top_picks.json?t=${t}`).catch(() => null),
    ]);
    const radar = radarRes?.ok ? await radarRes.json().catch(() => null) : null;
    const topPicks = topRes?.ok ? await topRes.json().catch(() => null) : null;

    const falconMap = buildFalconMap(radar);
    if (!falconMap.size) return;

    let cursor = undefined;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                await sendDailySummary(env, userData, falconMap, topPicks);
            } catch (_) { /* continue */ }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
}

async function sendDailySummary(env, user, falconMap, topPicks) {
    const symbols = new Set();
    (user.watchlist || []).forEach(s => symbols.add(s));
    (user.inventory || []).forEach(i => { if (i?.sym) symbols.add(i.sym); });

    // 收集每檔的當日漲跌、獵鷹分、命中策略
    const rows = [];
    for (const sym of symbols) {
        const s = falconMap.get(sym);
        if (!s) continue;
        const pct = Number(s.change_pct ?? s.chg_pct);
        rows.push({
            sym,
            close: Number(s.close) || 0,
            pct: Number.isFinite(pct) ? pct : null,
            falcon: Number(s.falcon_score ?? s.score) || 0,
            tags: Array.isArray(s.tags) ? s.tags.slice(0, 2) : [],
        });
    }

    const withPct = rows.filter(r => r.pct !== null);
    if (!withPct.length && !(user.inventory || []).length) {
        // 完全沒資料就跳過(避免推空訊息)
        return;
    }

    // 漲幅 / 跌幅 top 3
    const upTop = [...withPct].sort((a, b) => b.pct - a.pct).slice(0, 3).filter(r => r.pct > 0);
    const dnTop = [...withPct].sort((a, b) => a.pct - b.pct).slice(0, 3).filter(r => r.pct < 0);

    // 庫存當日盈虧 + 對成本
    const invLines = [];
    let invSumWeighted = 0, invSumQty = 0;
    for (const inv of (user.inventory || [])) {
        const row = rows.find(r => r.sym === inv.sym);
        if (!row || !inv.cost) continue;
        const dayPct = row.pct;
        const costRet = ((row.close - inv.cost) / inv.cost) * 100;
        invLines.push(`${inv.sym} 收 ${row.close} (${formatPct(dayPct)} 今日 / ${formatPct(costRet)} 對成本)`);
        if (inv.qty > 0) {
            invSumWeighted += costRet * inv.qty;
            invSumQty += inv.qty;
        }
    }
    const portReturn = invSumQty > 0 ? invSumWeighted / invSumQty : null;

    // 命中高分股(獵鷹 ≥ 設定閾值)
    const settings = user.settings || {};
    const falconTh = settings.falcon_threshold || 85;
    const hot = rows.filter(r => r.falcon >= falconTh).slice(0, 5);

    // top_picks.json 全市場戰略選股(最多 3 檔)
    const topGlobal = (topPicks?.picks || topPicks?.list || []).slice(0, 3)
        .map(p => `${p.sym || p.symbol} (${p.strategy || p.reason || ''})`).filter(s => s.length > 4);

    // 組原始彙整
    const parts = [];
    parts.push(`📊 *${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })} 盤後總結*`);
    if (upTop.length) parts.push(`*🚀 自選漲幅 Top*\n${upTop.map(r => `${r.sym} ${formatPct(r.pct)}`).join(' / ')}`);
    if (dnTop.length) parts.push(`*📉 自選跌幅 Top*\n${dnTop.map(r => `${r.sym} ${formatPct(r.pct)}`).join(' / ')}`);
    if (invLines.length) parts.push(`*💼 庫存今日*\n${invLines.join('\n')}` + (portReturn !== null ? `\n\n總部位對成本: *${formatPct(portReturn)}*` : ''));
    if (hot.length) parts.push(`*🦅 獵鷹 ≥${falconTh}*\n${hot.map(r => `${r.sym} 分${r.falcon}${r.tags.length ? ` (${r.tags.join('/')})` : ''}`).join('\n')}`);
    if (topGlobal.length) parts.push(`*🎯 全市場戰略選股*\n${topGlobal.join('\n')}`);

    const rawSummary = parts.join('\n\n');

    // F4: 送 Gemini 拿白話短評
    const aiText = await gemini(env, buildDailyPrompt(rawSummary, user));
    const finalText = aiText
        ? `${rawSummary}\n\n💬 *AI 短評(權證小哥風)*\n${aiText}`
        : rawSummary;

    await tg(env, user.chat_id, finalText);
}

function formatPct(n) {
    if (!Number.isFinite(n)) return '--';
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function buildDailyPrompt(rawSummary, user) {
    const symbolCount = (user.watchlist?.length || 0) + (user.inventory?.length || 0);
    return [
        '你是台股「權證小哥」風格的分析師。針對以下使用者的今日持股動態,給 2-3 句白話短評。',
        '禁止算數學(所有數字已備好);禁止套話如「以下為您分析」。',
        '重點: ① 今天最該注意什麼  ② 明日操作節奏建議(進場/抱牢/減碼/觀望)。',
        `使用者目前共追蹤 ${symbolCount} 檔。`,
        '',
        rawSummary,
        '',
        '請用台股口語,2-3 句,直接給操作建議:',
    ].join('\n');
}
