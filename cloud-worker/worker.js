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
        ctx.waitUntil(runScan(env));
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
    } else if (text === '/help' || text === '/?') {
        await tg(env, chatId,
            '*指令清單*\n\n' +
            '`/bind 綁定碼` - 用網頁拿到的綁定碼綁定\n' +
            '`/list` - 看你的雲端清單\n' +
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
    }
    return out;
}

function clamp(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
}

// ── Scheduled scan & push ───────────────────────────────────────────

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

    if (!falconMap.size && !macroAlert) return;

    let cursor = undefined;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                await scanUser(env, userData, falconMap, macroAlert);
            } catch (e) { /* continue */ }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
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

async function scanUser(env, user, falconMap, macroAlert) {
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
        const stock = falconMap.get(sym);
        if (!stock) continue;

        const fs = Number(stock.falcon_score ?? stock.score);
        if (Number.isFinite(fs) && fs >= falconTh) {
            const ptype = `falcon_${falconTh}`;
            if (!(await wasPushed(env, user.chat_id, sym, ptype))) {
                const tags = Array.isArray(stock.tags) ? stock.tags.slice(0, 3).join(' / ') : (stock.strategy || '建倉訊號');
                alerts.push(`🦅 *${sym}* 獵鷹分 *${fs}*(≥${falconTh})— ${tags}`);
                await markPushed(env, user.chat_id, sym, ptype);
            }
        }

        const pct = Number(stock.change_pct ?? stock.chg_pct);
        const close = Number(stock.close);
        if (Number.isFinite(pct)) {
            if (pct >= surgeTh && !(await wasPushed(env, user.chat_id, sym, 'surge'))) {
                alerts.push(`🚀 *${sym}* 大漲 *+${pct.toFixed(2)}%*${Number.isFinite(close) ? ` — 收 ${close}` : ''}`);
                await markPushed(env, user.chat_id, sym, 'surge');
            } else if (pct <= -dropTh && !(await wasPushed(env, user.chat_id, sym, 'drop'))) {
                alerts.push(`📉 *${sym}* 大跌 *${pct.toFixed(2)}%*${Number.isFinite(close) ? ` — 收 ${close}` : ''}`);
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
