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
const PUSH_DEDUP_TTL = 4 * 3600;   // V21.3:6h → 4h,讓重要事件 1 天可推 2 次
const GH_PAGES_BASE = 'https://xin7355-collab.github.io/StockAI-DB';
const MAX_TG_LEN = 3800;
const NAMES_TTL = 30 * 24 * 3600;   // V21.3:names:map TTL 30 天

// V21.3 ── 訊息優先級星數定義 ───────────────────────────────────────
//   ★★★ (P1):黑天鵝 / 庫存停損觸發 / 漲跌停 / 融資爆表 / 處置股出獄
//   ★★  (P2):獵鷹建倉 / 朱家泓訊號 / 主力出貨指數紅燈 / 庫存停利
//   ★   (P3):盤後總結 / 開盤前簡報 / 午盤戰報 / 隔夜美股
// 使用者可在前端設 tg_level: 'all' | '2plus' | '3only',Worker 發送前過濾
const PRIORITY_MIN = { all: 1, '2plus': 2, '3only': 3 };

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

// V21.3 ── 帶優先級過濾的發送包裝(stars: 1/2/3),低於使用者 tg_level 直接 skip
const tgWithLevel = async (env, user, text, stars, opts = {}) => {
    const userMin = PRIORITY_MIN[user?.settings?.tg_level || 'all'] || 1;
    if (stars < userMin) return;   // 過濾:此訊息優先級不夠
    return tg(env, user.chat_id, text, opts);
};

// V21.3 ── 股票代號 → 中文名 lookup(從 KV names:map 讀,fallback 純代號)
async function stockLabel(env, sym) {
    if (!sym) return '';
    try {
        const map = await env.KV.get('names:map', 'json');
        const name = map?.[String(sym).toUpperCase()];
        return name ? `${name} ${sym}` : String(sym);
    } catch (_) {
        return String(sym);
    }
}

// V21.3 ── 個股深連結(Telegram 訊息底部一鍵跳該股完整分析)
function tplDeepLink(sym) {
    return `${GH_PAGES_BASE}/?sym=${encodeURIComponent(sym)}`;
}

// V21.3 ── 統一分隔線
const SEP = '━━━━━━━━━━━━━━━━━━━━';

// V21.3 ── 計算進場/停損/目標價(統一規則,避免每個模板自己算)
//   進場區:現價 ± 1%(寬鬆;盤中追價或拉回都接得到)
//   停損:現價 × 0.96(-4%)
//   目標:現價 × 1.08(+8%)
function calcLevels(price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return null;
    const entryLow  = (p * 0.99).toFixed(2);
    const entryHigh = (p * 1.01).toFixed(2);
    const stop      = (p * 0.96).toFixed(2);
    const target    = (p * 1.08).toFixed(2);
    return { entryLow, entryHigh, stop, target };
}

// V21.3 ── 7 個事件模板生成器(全部回傳 Markdown 字串,呼叫者用 tgWithLevel 發)
//   每則三段式:核心數字 → 明確操作 → 為什麼觸發(3 條理由) → 深連結

function tplFalcon(label, sym, score, price, reasons) {
    const lv = calcLevels(price);
    const lvBlock = lv
        ? `🎯 *操作建議*\n  ▸ 進場:${lv.entryLow} ~ ${lv.entryHigh} 區間\n  ▸ 停損:${lv.stop}(-4%)\n  ▸ 目標:${lv.target}(+8%)`
        : `🎯 *操作建議*\n  ▸ 等明日 9:00 開盤定價`;
    const why = (reasons && reasons.length)
        ? `💡 *為什麼觸發?*\n${reasons.slice(0, 3).map((r, i) => `  ${['①','②','③'][i]} ${r}`).join('\n')}`
        : `💡 系統綜合條件達標(細節看完整分析)`;
    return [
        `🦅 *【建倉訊號 ★★★】${label}*`,
        SEP,
        `📊 獵鷹分 *${score}/100* — 極高`,
        Number.isFinite(price) ? `💰 現價 *${price}* 元` : '',
        '',
        lvBlock,
        '',
        why,
        '',
        `📱 [看完整分析](${tplDeepLink(sym)})`,
    ].filter(Boolean).join('\n');
}

function tplInventoryStop(label, sym, cost, price, ret, type) {
    const isProfit = type === 'tp';
    const icon = isProfit ? '💰' : '🛑';
    const title = isProfit ? '庫存停利線觸發 ★★★' : '庫存停損線觸發 ★★★';
    const action = isProfit
        ? `🎯 *操作建議*\n  ▸ 出 1/2 鎖利(現價賣 50%)\n  ▸ 留半碼追蹤,若跌破成本就全出\n  ▸ 不要貪心等回檔,先拿走+20%`
        : `🎯 *操作建議*\n  ▸ *立刻全出*,不要凹單\n  ▸ 朱老師心法:-8% 是硬停損,不討價還價\n  ▸ 出場後觀察,確認止跌再考慮接`;
    return [
        `${icon} *【${title}】${label}*`,
        SEP,
        `📊 損益 *${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%*`,
        `💰 成本 *${cost}* → 現價 *${price}*`,
        '',
        action,
        '',
        `📱 [看完整分析](${tplDeepLink(sym)})`,
    ].join('\n');
}

function tplChu5MA(label, sym, price, ma5, volRatio) {
    const lv = calcLevels(price);
    return [
        `🎯 *【朱家泓 5MA 進場訊號 ★★】${label}*`,
        SEP,
        `📊 收 *${price}* > 5MA *${ma5?.toFixed(2)}*`,
        `📈 量增 *${volRatio?.toFixed(1)}×* 5日均量`,
        '',
        lv ? `🎯 *操作建議*\n  ▸ 進場:${lv.entryLow} ~ ${lv.entryHigh}\n  ▸ 停損:跌破 5MA *${ma5?.toFixed(2)}* 立停\n  ▸ 目標:${lv.target}(+8%)`
           : `🎯 進場:盤中拉回 5MA 附近(${ma5?.toFixed(2)})`,
        '',
        `💡 *為什麼觸發?*`,
        `  ① 整日沒跌破 5MA(主力守得住)`,
        `  ② 紅 K 收(買盤強於賣盤)`,
        `  ③ 量增放大(資金進駐)`,
        '',
        `📱 [看完整分析](${tplDeepLink(sym)})`,
    ].join('\n');
}

function tplBlackswan(reason, severity, vix, foreignNet) {
    const tag = severity === 'high' ? '★★★ 緊急' : '★★ 警示';
    const action = severity === 'high'
        ? `🎯 *操作建議*\n  ▸ *持股減 50%*(現金為王)\n  ▸ 別接刀(等紅 K 反包再考慮)\n  ▸ 避開:航運/金融/中小型題材股\n  ▸ 防禦:電信/民生必需(中華電 / 統一 / 全家)`
        : `🎯 *操作建議*\n  ▸ 持股減 1/3(留半碼觀察)\n  ▸ 新單暫緩 1-2 日\n  ▸ 關注 VIX 是否續升 + 美股反應`;
    return [
        `🚨 *【黑天鵝 ${tag}】*`,
        SEP,
        `⚠️ ${reason}`,
        Number.isFinite(vix) ? `📊 VIX *${vix.toFixed(1)}* / 外資 *${foreignNet > 0 ? '+' : ''}${foreignNet} 億*` : '',
        '',
        action,
        '',
        `📱 [看完整總經分析](${GH_PAGES_BASE}/)`,
    ].filter(Boolean).join('\n');
}

function tplAttention(label, sym, status, endDate, daysLeft) {
    return [
        `⚠️ *【處置股關注 ★★】${label}*`,
        SEP,
        `📊 ${status}`,
        endDate ? `📅 出獄日:*${endDate}*(剩 ${daysLeft} 天)` : '',
        '',
        `🎯 *操作建議*(雙刀流)`,
        `  ▸ 跟對做:出獄前 1 日低接,博反彈(高風險高報酬)`,
        `  ▸ 對著做:出獄當日反向放空(主力出場常崩)`,
        `  ▸ 兩者皆不做:觀望即可,別碰`,
        '',
        `📱 [看完整處置分析](${tplDeepLink(sym)})`,
    ].filter(Boolean).join('\n');
}

function tplLimitUpDown(label, sym, price, pct, type) {
    const isUp = type === 'up';
    const icon = isUp ? '🔴' : '🟢';
    const title = isUp ? '漲停板 ★★★' : '跌停板 ★★★';
    const action = isUp
        ? `🎯 *操作建議*\n  ▸ 已持有:留半碼,賣半碼鎖利\n  ▸ 空手:*不追*(漲停隔日易拉回)\n  ▸ 等回測 5MA 再考慮接`
        : `🎯 *操作建議*\n  ▸ 已持有:盤後檢視原因,若基本面無變化可留\n  ▸ *別接刀*(連續跌停常見)\n  ▸ 觀察隔日是否有量反彈確認止跌`;
    return [
        `${icon} *【${title}】${label}*`,
        SEP,
        `💰 現價 *${price}* 元 (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
        '',
        action,
        '',
        `📱 [看完整分析](${tplDeepLink(sym)})`,
    ].join('\n');
}

function tplPriceAlert(label, sym, hitPrice, livePrice, condText) {
    const icon = condText.includes('上') ? '🚨' : '🛑';
    return [
        `${icon} *【到價提醒 ★★★】${label}*`,
        SEP,
        `📊 觸及${condText} *${hitPrice}*`,
        `💰 現價 *${livePrice}*`,
        '',
        `🎯 *操作建議*`,
        `  ▸ 立刻回顧當初設這個價的原因`,
        `  ▸ 若是停利價 → 出 1/3 鎖利`,
        `  ▸ 若是進場價 → 確認大盤無壓再進`,
        '',
        `📱 [看完整分析](${tplDeepLink(sym)})`,
    ].join('\n');
}

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
        // V17.5 + V21.3 — 5 cron 排程分流(UTC → 台北 +8):
        //   "0 21 * * 0-4"  → 05:00 台北 🌃 隔夜美股戰報(V21.3 新)
        //   "30 0 * * 1-5"  → 08:30 台北 🌅 盤前簡報(V21.3 新)
        //   "0 1 * * 1-5"   → 09:00 台北 開盤掃 monitorList 推朱家泓 5MA 觸發 + ETF 跟單 Top 5
        //   "0 4 * * 1-5"   → 12:00 台北 🌞 午盤戰報(V21.3 新)
        //   "0 9 * * 1-5"   → 17:00 台北 🌆 盤後總結(加強既有)
        //   "*/5 1-5 ..."   → 09:00-13:55 台北 盤中即時掃描
        if (event.cron === '0 9 * * 1-5') {
            ctx.waitUntil(runDailySummary(env));
        } else if (event.cron === '0 1 * * 1-5') {
            ctx.waitUntil(runMonitorChuMorningScan(env));
            ctx.waitUntil(runEtfFollowMorningPush(env));  // V17.18
        } else if (event.cron === '0 21 * * 0-4') {
            ctx.waitUntil(runOvernightUS(env));    // V21.3 隔夜美股
        } else if (event.cron === '30 0 * * 1-5') {
            ctx.waitUntil(runPreMarket(env));      // V21.3 盤前簡報
        } else if (event.cron === '0 4 * * 1-5') {
            ctx.waitUntil(runMidday(env));         // V21.3 午盤戰報
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
    const sanitized = sanitizePayload(body.payload || {});
    // V21.3 ── 股名對照同步:從 sanitized._stockNamesUpdate merge 進 KV names:map
    const namesUpdate = sanitized._stockNamesUpdate;
    delete sanitized._stockNamesUpdate;
    if (namesUpdate) {
        try {
            const existingMap = (await env.KV.get('names:map', 'json')) || {};
            let dirty = false;
            for (const [k, v] of Object.entries(namesUpdate)) {
                const key = String(k).toUpperCase();
                const name = String(v || '').trim().slice(0, 30);
                if (name && /^[一-龥A-Za-z0-9·\-+ ]+$/.test(name) && existingMap[key] !== name) {
                    existingMap[key] = name;
                    dirty = true;
                }
            }
            if (dirty) await env.KV.put('names:map', JSON.stringify(existingMap), { expirationTtl: NAMES_TTL });
        } catch (e) {
            console.warn('[names:map merge]', e?.message);
        }
    }
    const merged = {
        ...existing,
        ...sanitized,
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
    // V17.6 / V17.21 — 個股到價監控
    // 新格式 [{id, sym, cond:'gte'|'lte', price, enabled, addedAt}](一條件一筆,同股可多筆)
    // 舊格式 [{sym, upper, lower}] 向後相容(過渡期 KV 內可能還有舊資料)
    if (Array.isArray(payload.priceAlerts)) {
        out.priceAlerts = payload.priceAlerts
            .filter(a => a && typeof a === 'object')
            .map(a => {
                const sym = String(a.sym || '').trim().toUpperCase();
                if (a.cond === 'gte' || a.cond === 'lte') {
                    const price = Number.isFinite(+a.price) && +a.price > 0 ? +a.price : null;
                    if (price == null) return null;
                    return {
                        id: String(a.id || `${sym}_${a.cond}_${price}`).slice(0, 80),
                        sym, cond: a.cond, price,
                        enabled: a.enabled !== false,
                    };
                }
                // 舊格式 fallback
                const upper = Number.isFinite(+a.upper) && +a.upper > 0 ? +a.upper : null;
                const lower = Number.isFinite(+a.lower) && +a.lower > 0 ? +a.lower : null;
                if (upper == null && lower == null) return null;
                return { sym, upper, lower };
            })
            .filter(a => a && isValidSym(a.sym))
            .slice(0, 200);
    }
    if (payload.settings && typeof payload.settings === 'object') {
        out.settings = {
            // V21.3:預設閾值適度鬆綁(85→75 / 5→7 / 5→7),讓自選股動態更頻繁
            falcon_threshold: clamp(payload.settings.falcon_threshold, 60, 95, 75),
            surge_threshold: clamp(payload.settings.surge_threshold, 2, 10, 7),
            drop_threshold: clamp(payload.settings.drop_threshold, 2, 10, 7),
            chuMorningPush: payload.settings.chuMorningPush !== false,
            // V21.3:訊息優先級篩選(all / 2plus / 3only)
            tg_level: ['all', '2plus', '3only'].includes(payload.settings.tg_level)
                ? payload.settings.tg_level
                : 'all',
        };
        const ft = String(payload.settings.fugleToken1 || '').trim();
        if (ft && ft.length >= 8 && ft.length <= 100) out.settings.fugleToken1 = ft;
    }
    // V21.3 ── 股名對照表(前端 sync 時帶上來,Worker merge 進 KV names:map)
    //   payload.stockNames = { "2330": "台積電", "2454": "聯發科", ... }
    out._stockNamesUpdate = payload.stockNames && typeof payload.stockNames === 'object'
        ? payload.stockNames
        : null;
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
    // V17.6 — 限價告警的 sym 也納入掃描,即使不在自選/監控/庫存
    (user.priceAlerts || []).forEach(a => { if (a?.sym) symbols.add(a.sym); });

    const settings = user.settings || {};
    // V21.3:預設值改 75/7/7(對齊 sanitizePayload),沒設定的用戶套用新預設
    const falconTh = settings.falcon_threshold || 75;
    const surgeTh = settings.surge_threshold || 7;
    const dropTh = settings.drop_threshold || 7;

    // V21.3:訊息改用「逐則發送(帶優先級過濾)」,放棄單則合併以利精準篩選
    // 為避免轟炸,單次 scan 一個用戶最多 6 則(超出 skip),保留最高優先
    const queue = [];   // {stars, text} 物件陣列,結尾按 stars 排序取前 6 則

    if (macroAlert && !(await wasPushed(env, user.chat_id, '__macro__', 'daily'))) {
        const severity = macroAlert.includes('★★★') || macroAlert.includes('暴跌') ? 'high' : 'medium';
        queue.push({ stars: 3, text: tplBlackswan(macroAlert, severity, null, null) });
        await markPushed(env, user.chat_id, '__macro__', 'daily', 24 * 3600);
    }

    for (const sym of symbols) {
        const stock = falconMap.get(sym) || { sym };
        const live = liveQuotes ? liveQuotes.get(sym) : null;
        const close = live ? live.z : Number(stock.close);
        const pct   = live ? live.pct : Number(stock.change_pct ?? stock.chg_pct);
        const label = await stockLabel(env, sym);

        const fs = Number(stock.falcon_score ?? stock.score);
        if (Number.isFinite(fs) && fs >= falconTh) {
            const ptype = `falcon_${falconTh}`;
            if (!(await wasPushed(env, user.chat_id, sym, ptype))) {
                // 從 stock.tags 拆出「為什麼觸發」3 條
                const reasons = Array.isArray(stock.tags) ? stock.tags.slice(0, 3) : [];
                queue.push({ stars: 2, text: tplFalcon(label, sym, fs, close, reasons) });
                await markPushed(env, user.chat_id, sym, ptype);
            }
        }

        if (Number.isFinite(pct)) {
            // 漲跌停 (±9.5%+) → P3 star=3
            if (pct >= 9.5 && !(await wasPushed(env, user.chat_id, sym, 'limitUp'))) {
                queue.push({ stars: 3, text: tplLimitUpDown(label, sym, close, pct, 'up') });
                await markPushed(env, user.chat_id, sym, 'limitUp');
            } else if (pct <= -9.5 && !(await wasPushed(env, user.chat_id, sym, 'limitDown'))) {
                queue.push({ stars: 3, text: tplLimitUpDown(label, sym, close, pct, 'down') });
                await markPushed(env, user.chat_id, sym, 'limitDown');
            } else if (pct >= surgeTh && !(await wasPushed(env, user.chat_id, sym, 'surge'))) {
                queue.push({ stars: 2, text: tplFalcon(label, sym, Math.round(fs || 0), close, [`當日漲幅 +${pct.toFixed(2)}% (≥${surgeTh}%)`]) });
                await markPushed(env, user.chat_id, sym, 'surge');
            } else if (pct <= -dropTh && !(await wasPushed(env, user.chat_id, sym, 'drop'))) {
                queue.push({ stars: 2, text: `📉 *【大跌警示 ★★】${label}*\n${SEP}\n💰 現價 *${close}* (${pct.toFixed(2)}%)\n\n🎯 *操作建議*\n  ▸ 確認是否破月線(20MA)\n  ▸ 庫存族:已虧 5% 以上先出半碼\n  ▸ 空手:別接刀,等紅 K 反包\n\n📱 [看完整分析](${tplDeepLink(sym)})` });
                await markPushed(env, user.chat_id, sym, 'drop');
            }
        }

        const inv = (user.inventory || []).find(i => i.sym === sym);
        if (inv?.cost > 0 && Number.isFinite(close) && close > 0) {
            const ret = ((close - inv.cost) / inv.cost) * 100;
            if (ret >= 20 && !(await wasPushed(env, user.chat_id, sym, 'tp20'))) {
                queue.push({ stars: 2, text: tplInventoryStop(label, sym, inv.cost, close, ret, 'tp') });
                await markPushed(env, user.chat_id, sym, 'tp20');
            } else if (ret <= -8 && !(await wasPushed(env, user.chat_id, sym, 'sl8'))) {
                queue.push({ stars: 3, text: tplInventoryStop(label, sym, inv.cost, close, ret, 'sl') });
                await markPushed(env, user.chat_id, sym, 'sl8');
            }
        }

        // V16.0 — 量爆 + 突破 5MA(只在盤中 elapsed >= 30 分後判)
        if (live && volBaseCache && elapsed >= 30) {
            const base = await fetchVolumeBaseline(sym, volBaseCache);
            if (base && base.ma5 > 0 && base.vma5 > 0) {
                const vTodayLots = (live.v || 0);
                const vRatio = vTodayLots / (base.vma5 * (elapsed / 270));
                const breakMa5 = live.z > base.ma5;
                if (vRatio > 1.5 && breakMa5 && !(await wasPushed(env, user.chat_id, sym, 'volBreak5ma'))) {
                    queue.push({ stars: 2, text: tplChu5MA(label, sym, live.z, base.ma5, vRatio) });
                    await markPushed(env, user.chat_id, sym, 'volBreak5ma');
                }
            }
        }

        // V17.6 / V17.21 — 個股到價監控
        if (live && Number.isFinite(live.z)) {
            for (const a of (user.priceAlerts || []).filter(x => x.sym === sym && x.enabled !== false)) {
                let hit = false, condTxt = '', hitPrice = null, dedupKey = '';
                if (a.cond === 'gte' && Number.isFinite(+a.price) && live.z >= +a.price) {
                    hit = true; condTxt = '上限'; hitPrice = +a.price;
                    dedupKey = a.id ? `pa_${String(a.id).slice(0, 40)}` : `pa_gte_${hitPrice}`;
                } else if (a.cond === 'lte' && Number.isFinite(+a.price) && live.z <= +a.price) {
                    hit = true; condTxt = '下限'; hitPrice = +a.price;
                    dedupKey = a.id ? `pa_${String(a.id).slice(0, 40)}` : `pa_lte_${hitPrice}`;
                } else if (a.upper != null && live.z >= +a.upper) {
                    hit = true; condTxt = '上限'; hitPrice = +a.upper;
                    dedupKey = 'priceUpper';
                } else if (a.lower != null && live.z <= +a.lower) {
                    hit = true; condTxt = '下限'; hitPrice = +a.lower;
                    dedupKey = 'priceLower';
                }
                if (!hit) continue;
                if (await wasPushed(env, user.chat_id, sym, dedupKey)) continue;
                queue.push({ stars: 3, text: tplPriceAlert(label, sym, hitPrice, live.z.toFixed(2), condTxt) });
                await markPushed(env, user.chat_id, sym, dedupKey);
            }
        }

        // V16.0 — Fugle 內外盤(需 user.settings.fugleToken1,沒設則跳過)
        const fugleToken = settings.fugleToken1 || '';
        if (fugleToken && live) {
            const fq = await fetchFugleQuote(sym, fugleToken);
            if (fq && fq.bid > 0 && fq.ask > 0) {
                const askBidRatio = fq.ask / fq.bid;
                if (askBidRatio > 2 && !(await wasPushed(env, user.chat_id, sym, 'fugleStrongBuy'))) {
                    queue.push({ stars: 2, text: `💪 *【主力強買盤 ★★】${label}*\n${SEP}\n外盤 ${fq.ask} / 內盤 ${fq.bid} = *${askBidRatio.toFixed(1)}×*\n💰 現價 ${live.z.toFixed(2)}\n\n🎯 *操作建議*\n  ▸ 已持有:留住,別輕易賣\n  ▸ 空手:可拉回低接\n\n📱 [看完整分析](${tplDeepLink(sym)})` });
                    await markPushed(env, user.chat_id, sym, 'fugleStrongBuy');
                } else if (askBidRatio < 0.5 && !(await wasPushed(env, user.chat_id, sym, 'fugleStrongSell'))) {
                    queue.push({ stars: 3, text: `🩸 *【主力強殺盤 ★★★】${label}*\n${SEP}\n內盤 ${fq.bid} / 外盤 ${fq.ask} = *${(1/askBidRatio).toFixed(1)}×*\n💰 現價 ${live.z.toFixed(2)}\n\n🎯 *操作建議*\n  ▸ 已持有:盤中先出半碼\n  ▸ 空手:絕對別接刀\n\n📱 [看完整分析](${tplDeepLink(sym)})` });
                    await markPushed(env, user.chat_id, sym, 'fugleStrongSell');
                }
            }
        }
    }

    if (!queue.length) return;

    // V21.3 ── 按優先級排序,單次 scan 最多送 6 則(避免轟炸)
    queue.sort((a, b) => b.stars - a.stars);
    const userMin = PRIORITY_MIN[settings.tg_level || 'all'] || 1;
    const filtered = queue.filter(q => q.stars >= userMin).slice(0, 6);
    for (const item of filtered) {
        await tg(env, user.chat_id, item.text);
    }
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

async function gemini(env, prompt, systemInstruction = null) {
    if (!env.GEMINI_API_KEY) return null;
    // V19.3 — 同步 frontend 三大強化:safetySettings BLOCK_NONE × 4 + thinkingBudget=0
    //         + 可選 systemInstruction(角色/字數規矩塞這裡)
    try {
        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 300,
                thinkingConfig: { thinkingBudget: 0 },
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',         threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
            ],
        };
        if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
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
    const [radarRes, topRes, matrixRes] = await Promise.all([
        fetch(`${GH_PAGES_BASE}/data/radar.json?t=${t}`).catch(() => null),
        fetch(`${GH_PAGES_BASE}/data/top_picks.json?t=${t}`).catch(() => null),
        fetch(`${GH_PAGES_BASE}/data/radar_matrix.json?t=${t}`).catch(() => null),
    ]);
    const radar = radarRes?.ok ? await radarRes.json().catch(() => null) : null;
    const topPicks = topRes?.ok ? await topRes.json().catch(() => null) : null;
    const radarMatrix = matrixRes?.ok ? await matrixRes.json().catch(() => null) : null;

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
                await sendDailySummary(env, userData, falconMap, topPicks, radarMatrix);
            } catch (_) { /* continue */ }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
}

async function sendDailySummary(env, user, falconMap, topPicks, radarMatrix) {
    const symbols = new Set();
    (user.watchlist || []).forEach(s => symbols.add(s));
    (user.inventory || []).forEach(i => { if (i?.sym) symbols.add(i.sym); });

    // V21.3:收集每檔當日漲跌 + 獵鷹分 + tags,並補上中文名 label
    const rows = [];
    for (const sym of symbols) {
        const s = falconMap.get(sym);
        if (!s) continue;
        const pct = Number(s.change_pct ?? s.chg_pct);
        const label = await stockLabel(env, sym);
        rows.push({
            sym,
            label,
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
        invLines.push(`${row.label} 收 ${row.close} (${formatPct(dayPct)} 今日 / ${formatPct(costRet)} 對成本)`);
        if (inv.qty > 0) {
            invSumWeighted += costRet * inv.qty;
            invSumQty += inv.qty;
        }
    }
    const portReturn = invSumQty > 0 ? invSumWeighted / invSumQty : null;

    // 命中高分股(獵鷹 ≥ 設定閾值)
    const settings = user.settings || {};
    const falconTh = settings.falcon_threshold || 75;   // V21.3:85 → 75
    const hot = rows.filter(r => r.falcon >= falconTh).slice(0, 5);

    // top_picks.json 全市場戰略選股(最多 3 檔)
    const topGlobalRaw = (topPicks?.picks || topPicks?.list || []).slice(0, 3);
    const topGlobal = [];
    for (const p of topGlobalRaw) {
        const sym = p.sym || p.symbol;
        if (sym) {
            const lab = await stockLabel(env, sym);
            topGlobal.push(`${lab} (${p.strategy || p.reason || ''})`);
        }
    }

    // 📚 朱家泓今日選股(4 大模組,各取前 3 檔)
    const chuBlocks = [
        { label: '🍀 六六大順', key: 'chu_perfect6' },
        { label: '🔥 特別報價', key: 'chu_top_gainer' },
        { label: '🥣 底部轉折', key: 'chu_bottom' },
        { label: '🚀 5MA飆股',  key: 'chu_riding5ma' },
    ];
    const chuMatrixData = (radarMatrix?.data) || {};
    const chuLines = [];
    for (const blk of chuBlocks) {
        const picks = (chuMatrixData[blk.key] || []).slice(0, 3);
        if (picks.length) {
            const syms = picks.map(p => {
                const g = Number(p.gain) || 0;
                const sign = g > 0 ? '+' : '';
                return `${p.sym}(${sign}${g.toFixed(1)}%)`;
            }).join(' ');
            chuLines.push(`${blk.label}: ${syms}`);
        }
    }

    // 組原始彙整(V21.3:用 label 含中文名)
    const parts = [];
    parts.push(`🌆 *【盤後總結 ★】${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}*`);
    parts.push(SEP);
    if (upTop.length) parts.push(`*🚀 自選漲幅 Top*\n${upTop.map(r => `  ▸ ${r.label} ${formatPct(r.pct)}`).join('\n')}`);
    if (dnTop.length) parts.push(`*📉 自選跌幅 Top*\n${dnTop.map(r => `  ▸ ${r.label} ${formatPct(r.pct)}`).join('\n')}`);
    if (invLines.length) parts.push(`*💼 庫存今日*\n${invLines.map(l => '  ▸ ' + l).join('\n')}` + (portReturn !== null ? `\n\n總部位對成本: *${formatPct(portReturn)}*` : ''));
    if (hot.length) parts.push(`*🦅 獵鷹 ≥${falconTh}*\n${hot.map(r => `  ▸ ${r.label} 分${r.falcon}${r.tags.length ? ` (${r.tags.join('/')})` : ''}`).join('\n')}`);
    if (topGlobal.length) parts.push(`*🎯 全市場戰略選股*\n${topGlobal.map(s => '  ▸ ' + s).join('\n')}`);
    if (chuLines.length) parts.push(`*📚 朱家泓今日選股*\n${chuLines.join('\n')}\n_盤後篩選, 隔日參考進場, 跌破 5MA 立停_`);
    parts.push(`📱 [看完整作戰指揮部](${GH_PAGES_BASE}/)`);

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

// ── V21.3: 4 段排程訊息生成 ──────────────────────────────────────────
//   🌃 05:00 隔夜美股 / 🌅 08:30 盤前 / 🌞 12:00 午盤 / 🌆 17:00 盤後(已有)

// 共用:廣播給全部用戶(過濾 muted + 按 tg_level 篩優先級)
async function broadcastAllUsers(env, msgText, stars) {
    let cursor = undefined;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                const userMin = PRIORITY_MIN[userData.settings?.tg_level || 'all'] || 1;
                if (stars < userMin) continue;
                await tg(env, userData.chat_id, msgText);
            } catch (_) {}
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
}

// 🌃 05:00 台北 — 隔夜美股戰報
async function runOvernightUS(env) {
    const t = Date.now();
    let macro = null;
    try {
        const r = await fetch(`${GH_PAGES_BASE}/data/macro_risk.json?t=${t}`);
        if (r.ok) macro = await r.json();
    } catch (_) {}
    if (!macro) return;

    const sp500 = macro.sp500, sp500Pct = macro.sp500_chg_pct;
    const nasdaq = macro.nasdaq, nasdaqPct = macro.nasdaq_chg_pct;
    const vix = macro.vix;
    const dxy = macro.dxy;
    const fmt = (v, dec = 2) => v == null ? '--' : Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const pctClr = (p) => p == null ? '' : (p > 0 ? `🔴 +${p.toFixed(2)}%` : `🟢 ${p.toFixed(2)}%`);

    // 對台股預判
    let verdict, advice;
    const usAvg = ((sp500Pct || 0) + (nasdaqPct || 0)) / 2;
    if (usAvg > 1.0) {
        verdict = '🟢 美股強勢 → 台股早盤偏多';
        advice = '今天可順勢:科技股(2330/2454/3008)+ AI 概念股(廣達/緯穎/技嘉)';
    } else if (usAvg < -1.0) {
        verdict = '🔴 美股重挫 → 台股早盤恐開低';
        advice = '今天保守:減碼追蹤,別接刀,等止跌訊號';
    } else {
        verdict = '🟡 美股平穩 → 台股看自身籌碼';
        advice = '今天看個股表現,大盤無方向看法人態度';
    }
    if (vix >= 25) advice += '\n⚠️ VIX 已過 25 → 全球避險,小心黑天鵝';

    const text = [
        `🌃 *【隔夜美股戰報 ★】 ${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}*`,
        SEP,
        `🇺🇸 SP500 *${fmt(sp500, 0)}* (${pctClr(sp500Pct)})`,
        `💻 NASDAQ *${fmt(nasdaq, 0)}* (${pctClr(nasdaqPct)})`,
        `😱 VIX *${fmt(vix)}* / 💵 DXY *${fmt(dxy)}*`,
        '',
        `📊 *對台股預判*`,
        `${verdict}`,
        '',
        `🎯 *今日操作*`,
        advice,
        '',
        `📱 [看完整總經分析](${GH_PAGES_BASE}/)`,
    ].join('\n');
    await broadcastAllUsers(env, text, 1);
}

// 🌅 08:30 台北 — 盤前簡報
async function runPreMarket(env) {
    const t = Date.now();
    const [macroRes, radarRes, attentionRes] = await Promise.all([
        fetch(`${GH_PAGES_BASE}/data/macro_risk.json?t=${t}`).catch(() => null),
        fetch(`${GH_PAGES_BASE}/data/radar.json?t=${t}`).catch(() => null),
        fetch(`${GH_PAGES_BASE}/data/attention_status.json?t=${t}`).catch(() => null),
    ]);
    const macro = macroRes?.ok ? await macroRes.json().catch(() => null) : null;
    const radar = radarRes?.ok ? await radarRes.json().catch(() => null) : null;
    const attention = attentionRes?.ok ? await attentionRes.json().catch(() => null) : {};
    const falconMap = buildFalconMap(radar);

    // 主力出貨指數簡易計算(取 macro_risk 5 因子 → 0-100)
    let mmIndex = 0;
    const factors = [];
    if (macro) {
        const retail = macro.retail_ls_pct;
        if (retail < -25) { mmIndex += 20; factors.push('散戶過度看多'); }
        if (macro.taifex_backwardation < -100) { mmIndex += 25; factors.push('期貨大貼水'); }
        if (macro.business_signal?.light === 'red') { mmIndex += 20; factors.push('景氣紅燈'); }
        if (macro.vix >= 25) { mmIndex += 25; factors.push('VIX 恐慌'); }
    }
    const mmVerdict = mmIndex >= 70 ? '🔴 主力可能殺出' : mmIndex >= 40 ? '🟠 警戒' : mmIndex >= 0 ? '🟡 中性' : '🟢 託盤';

    // 對每用戶推:加入個人化重點 3 檔
    let cursor = undefined;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                const userMin = PRIORITY_MIN[userData.settings?.tg_level || 'all'] || 1;
                if (1 < userMin) continue;   // P3 訊息,3only 用戶 skip

                // 今日重點:自選股獵鷹分 ≥ falconTh 的前 3 檔
                const falconTh = userData.settings?.falcon_threshold || 75;
                const watchSyms = new Set([...(userData.watchlist || []), ...(userData.inventory || []).map(i => i.sym)]);
                const focus = [];
                for (const sym of watchSyms) {
                    const s = falconMap.get(sym);
                    if (s && Number(s.falcon_score ?? s.score) >= falconTh) {
                        const label = await stockLabel(env, sym);
                        focus.push(`${label} 獵鷹分 ${s.falcon_score ?? s.score}`);
                        if (focus.length >= 3) break;
                    }
                }
                // 處置出獄 D-1 / D-0
                const attMap = attention || {};
                const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
                const outSoon = [];
                for (const sym of watchSyms) {
                    const a = attMap[sym];
                    if (a?.end_date) {
                        const days = Math.ceil((new Date(a.end_date) - new Date(todayStr)) / 86400000);
                        if (days >= 0 && days <= 1) {
                            const lab = await stockLabel(env, sym);
                            outSoon.push(`${lab} ${days === 0 ? '今日出獄' : '明日出獄'}`);
                        }
                    }
                }

                const text = [
                    `🌅 *【盤前簡報 ★】${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}*`,
                    SEP,
                    macro ? `🇺🇸 SP500 *${macro.sp500_chg_pct >= 0 ? '+' : ''}${macro.sp500_chg_pct?.toFixed(2)}%* / NASDAQ *${macro.nasdaq_chg_pct >= 0 ? '+' : ''}${macro.nasdaq_chg_pct?.toFixed(2)}%* / VIX *${macro.vix?.toFixed(1)}*` : '',
                    '',
                    `🐂 *主力出貨指數 ${mmIndex} 分*`,
                    `${mmVerdict}${factors.length ? ` (${factors.slice(0, 2).join(' / ')})` : ''}`,
                    '',
                    focus.length ? `🎯 *今日自選股重點*\n${focus.map(f => `  ▸ ${f}`).join('\n')}` : '🟢 自選股無高分股,可看通用情報',
                    outSoon.length ? `\n⚠️ *處置股出獄*\n${outSoon.map(s => `  ▸ ${s}`).join('\n')}` : '',
                    '',
                    `📱 [看完整作戰指揮部](${GH_PAGES_BASE}/)`,
                ].filter(Boolean).join('\n');
                await tg(env, userData.chat_id, text);
            } catch (_) {}
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
}

// 🌞 12:00 台北 — 午盤戰報
async function runMidday(env) {
    const t = Date.now();
    const radarRes = await fetch(`${GH_PAGES_BASE}/data/radar.json?t=${t}`).catch(() => null);
    const radar = radarRes?.ok ? await radarRes.json().catch(() => null) : null;
    const falconMap = buildFalconMap(radar);

    let cursor = undefined;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                const userMin = PRIORITY_MIN[userData.settings?.tg_level || 'all'] || 1;
                if (1 < userMin) continue;

                const watchSyms = [...(userData.watchlist || []), ...(userData.inventory || []).map(i => i.sym)];
                const rows = [];
                for (const sym of watchSyms) {
                    const s = falconMap.get(sym);
                    if (!s) continue;
                    const pct = Number(s.change_pct ?? s.chg_pct);
                    if (Number.isFinite(pct)) {
                        const label = await stockLabel(env, sym);
                        rows.push({ label, sym, pct, close: s.close });
                    }
                }
                if (!rows.length) continue;
                const upTop = [...rows].sort((a, b) => b.pct - a.pct).slice(0, 3).filter(r => r.pct > 0);
                const dnTop = [...rows].sort((a, b) => a.pct - b.pct).slice(0, 3).filter(r => r.pct < 0);

                const text = [
                    `🌞 *【午盤戰報 ★】 ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}*`,
                    SEP,
                    upTop.length ? `🚀 *自選漲幅 Top*\n${upTop.map(r => `  ▸ ${r.label} +${r.pct.toFixed(2)}% (${r.close})`).join('\n')}` : '',
                    dnTop.length ? `\n📉 *自選跌幅 Top*\n${dnTop.map(r => `  ▸ ${r.label} ${r.pct.toFixed(2)}% (${r.close})`).join('\n')}` : '',
                    '',
                    `🎯 *午後操作*`,
                    `  ▸ 強勢股:量價齊揚續抱,跌破即停利`,
                    `  ▸ 弱勢股:已虧 5% 以上出半碼`,
                    `  ▸ 觀察 13:00-13:25 主力動向(最後 30 分常見急拉/急殺)`,
                    '',
                    `📱 [看自選股完整動態](${GH_PAGES_BASE}/)`,
                ].filter(Boolean).join('\n');
                await tg(env, userData.chat_id, text);
            } catch (_) {}
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
}

// ── V17.5: 隔日 09:00 開盤 — 掃 monitorList 推朱家泓 5MA 進場觸發 ────────────
//
// 機制:前端 V17.4 已加「全綠燈一鍵加入監控」,使用者加完關 App 即可。
//       本 cron 隔日 09:00 台北跑,對每 user 的 monitorList 逐檔判:
//         整日 low ≥ ma5*0.99(整日沒跌破 5MA)+ 紅 K(close > open)+ 量 ≥ vma5*0.8
//       觸發推 Telegram「🎯 朱老師六六大順 進場訊號觸發」+ 24h throttle 不重推
//
// 等同前端 _checkChu5MAEntry (index.html line 14833),確保 worker 跟前端一致判定。

async function runMonitorChuMorningScan(env) {
    let cursor = undefined;
    let scanned = 0, sent = 0;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                // 使用者可關此功能(預設開)
                if (userData.settings?.chuMorningPush === false) continue;
                if (!Array.isArray(userData.monitorList) || userData.monitorList.length === 0) continue;
                scanned++;
                const did = await scanMonitorChuTriggers(env, userData);
                if (did) sent++;
            } catch (e) {
                console.warn('[chu morning scan] user error', e?.message);
            }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
    console.log(`[chu morning scan] scanned ${scanned} users · sent ${sent} pushes`);
}

async function scanMonitorChuTriggers(env, user) {
    const triggered = [];
    for (const item of user.monitorList) {
        const sym = typeof item === 'string' ? item : item?.sym;
        if (!sym) continue;
        try {
            const yClose = await fetchYesterdayKLineForChu(sym);
            if (!yClose) continue;
            const hit = evalChu5MAEntry(yClose);
            if (!hit) continue;
            // throttle:同股 / chu5ma type / 24h 只推 1 次
            if (await wasPushed(env, user.chat_id, sym, 'chu5ma')) continue;
            triggered.push({ sym, ...hit });
            await markPushed(env, user.chat_id, sym, 'chu5ma', 86400);
        } catch (e) {
            console.warn(`[chu scan] ${sym}`, e?.message);
        }
    }
    if (!triggered.length) return false;
    // V17.7.1 bugfix — tg() 用 parse_mode='Markdown',不能用 HTML <b>。改 *...* markdown 粗體
    // 組推送(最多 5 檔,避免訊息過長)
    const lines = triggered.slice(0, 5).map(t =>
        `• *${t.sym}*(收 ${t.lastClose})— 站 5MA *${t.ma5}* + 紅 K + 量${t.volRatio >= 1 ? '增' : '縮'} *${t.volRatio.toFixed(1)}x*`
    );
    const more = triggered.length > 5 ? `\n…還有 ${triggered.length - 5} 檔(打開 App 看完整)` : '';
    const msg =
        `🎯 *朱老師六六大順 進場訊號觸發*\n` +
        `(你監控的股票今早符合站穩 5MA + 紅 K + 量增條件)\n\n` +
        `${lines.join('\n')}${more}\n\n` +
        `📋 操作:開盤後 5-10 分等量穩,守 5MA 進(跌破 5MA 立停)`;
    await tg(env, user.chat_id, msg);
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// V17.18 — ETF 跟單訊號 09:00 開盤前推送
//   3-gate 勝率篩選:① ETF 共識看多 ② Falcon ≥ 70 ③ 主力連 N 日買超
//   Top 5(score ≥ 2)推給所有開啟 etfFollowPush 的使用者
// ════════════════════════════════════════════════════════════════════════════
async function runEtfFollowMorningPush(env) {
    // 1. fetch etf_tracking + falcon_scores 一次,所有使用者共用
    let etf, falconMap;
    try {
        const [etfR, falconR] = await Promise.all([
            fetch(`${GH_PAGES_BASE}/data/etf_tracking.json?t=${Date.now()}`),
            fetch(`${GH_PAGES_BASE}/data/falcon_scores.json?t=${Date.now()}`),
        ]);
        if (!etfR.ok) return console.warn('[etf follow push] etf_tracking 404');
        etf = await etfR.json();
        const falcon = falconR.ok ? await falconR.json() : { stocks: {} };
        falconMap = falcon.stocks || {};
    } catch (e) {
        return console.warn('[etf follow push] fetch error', e?.message);
    }

    // 2. 算 consensus_stocks(後端沒料就 fallback)
    let stocks = (etf.consensus_stocks || []).filter(s => s.etf_count > 0);
    if (!stocks.length) stocks = buildConsensusFromEtfsForWorker(etf.etfs || []);
    if (!stocks.length) return console.log('[etf follow push] no stocks');

    // 3. 算 follow score + 排序 + 取 Top 5(score ≥ 2)
    const scored = stocks.map(s => {
        const f = falconMap[s.sym] || {};
        const gEtf    = s.etf_count >= 5 && s.shares_delta > 0;
        const gFalcon = (f.score || 0) >= 70;
        const gChip   = (f.factors || []).some(x => /主力連\d日買超/.test(x));
        const score = (gEtf ? 1 : 0) + (gFalcon ? 1 : 0) + (gChip ? 1 : 0);
        return { ...s, _score: score, _falcon: f.score || 0, _close: f.close, _chip: gChip };
    }).filter(s => s._score >= 2)
       .sort((a, b) => b._score - a._score || b.shares_delta - a.shares_delta)
       .slice(0, 5);

    if (!scored.length) return console.log('[etf follow push] no candidates ≥ 2');

    // 4. 組訊息(Markdown)
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    let msg = `🌟 *ETF 跟單訊號 Top ${scored.length}* (${date} 09:00 開盤前)\n\n`;
    scored.forEach((s, i) => {
        const stars = s._score === 3 ? '✅✅✅' : '✅✅';
        const label = s._score === 3 ? '高勝率' : '中勝率';
        const idxEmoji = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'][i] || `${i+1}.`;
        msg += `${idxEmoji} *${s.sym} ${s.name || ''}* ${stars} (${s._score}/3 ${label})\n`;
        msg += `   ETF×${s.etf_count} 加碼 \`${(s.shares_delta / 1000).toFixed(1)}\` 千張 · Falcon \`${s._falcon}\``;
        if (s._chip) msg += ` · 主力連買`;
        msg += `\n   昨收 \`$${s._close != null ? s._close : '—'}\`\n\n`;
    });
    msg += `💡 跟單訊號 = ETF 共識 ∩ Falcon ≥ 70 ∩ 主力連買\n`;
    msg += `⚠️ 僅供參考,非投資建議。實戰請看技術面 + 個股新聞`;

    // 5. 推給所有訂閱使用者(用 dedup 24h)
    let cursor, sent = 0;
    while (true) {
        const list = await env.KV.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            try {
                const userData = JSON.parse((await env.KV.get(key.name)) || '{}');
                if (!userData.chat_id) continue;
                if (userData.muted_until && userData.muted_until > Date.now()) continue;
                if (userData.settings?.etfFollowPush === false) continue;  // 預設開,可關
                if (await wasPushed(env, userData.chat_id, '__etf_follow__', `day_${date}`)) continue;
                await tg(env, userData.chat_id, msg);
                await markPushed(env, userData.chat_id, '__etf_follow__', `day_${date}`, 86400);
                sent++;
            } catch (e) {
                console.warn('[etf follow push] user error', e?.message);
            }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
    console.log(`[etf follow push] ${scored.length} stocks · sent ${sent} users`);
}

// V17.18 — 對齊前端 _buildConsensusFromEtfs:後端 consensus_stocks 沒料時兜底
function buildConsensusFromEtfsForWorker(etfs) {
    const map = new Map();
    const bump = (etfSym, sym, name, delta) => {
        if (!sym) return;
        const cur = map.get(sym) || { sym, name: name || '', etf_count: 0, shares_delta: 0,
                                      market_val_delta_e: 0, total_shares: 0, _etfs: new Set() };
        if (!cur._etfs.has(etfSym)) { cur._etfs.add(etfSym); cur.etf_count = cur._etfs.size; }
        cur.shares_delta += (Number(delta) || 0);
        if (!cur.name && name) cur.name = name;
        map.set(sym, cur);
    };
    for (const e of (etfs || [])) {
        const c = e.changes || {};
        for (const x of (c.added       || [])) bump(e.symbol, x.sym, x.name,  Number(x.est_shares) || 0);
        for (const x of (c.weight_up   || [])) bump(e.symbol, x.sym, x.name,  Number(x.est_shares_delta) || 0);
        for (const x of (c.weight_down || [])) bump(e.symbol, x.sym, x.name,  Number(x.est_shares_delta) || 0);
        for (const x of (c.removed     || [])) bump(e.symbol, x.sym, x.name, -(Number(x.est_shares) || 0));
    }
    return [...map.values()].filter(v => v.etf_count > 0).map(o => { delete o._etfs; return o; });
}

// V17.5 — 抓 gh-pages data/{sym}.json 拿昨日 OHLCV + 算 ma5/vma5
//          (worker.js 既有 fetchVolumeBaseline 只回 ma5/vma5,本函式同時要昨日 row)
async function fetchYesterdayKLineForChu(sym) {
    try {
        const url = `${GH_PAGES_BASE}/data/${encodeURIComponent(sym)}.json?t=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const rows = await res.json().catch(() => null);
        if (!Array.isArray(rows) || rows.length < 5) return null;
        const last5 = rows.slice(-5);
        const closes = last5.map(r => Number(r.close)).filter(Number.isFinite);
        const vols = last5.map(r => Number(r.volume)).filter(Number.isFinite);
        if (closes.length !== 5 || vols.length !== 5) return null;
        const yesterday = last5[4];   // 最後一根 = 昨日(剛採完的 K 線)
        return {
            ma5: closes.reduce((s, v) => s + v, 0) / 5,
            vma5: vols.reduce((s, v) => s + v, 0) / 5,
            yLow: Number(yesterday.low),
            yClose: Number(yesterday.close),
            yOpen: Number(yesterday.open),
            yVol: Number(yesterday.volume),
        };
    } catch (_) { return null; }
}

// V17.5 — 等同 index.html line 14833 _checkChu5MAEntry,worker 版
//          朱家泓心法:整日沒跌破 5MA(low ≥ ma5*0.99)+ 紅 K(close > open)
//          加量增 ≥ vma5*0.8 過濾「假紅 K」(無量上漲容易回測)
function evalChu5MAEntry(base) {
    const { ma5, vma5, yLow, yClose, yOpen, yVol } = base;
    if (!Number.isFinite(ma5) || ma5 <= 0) return null;
    if (!Number.isFinite(yLow) || !Number.isFinite(yClose) || !Number.isFinite(yOpen)) return null;
    const heldAboveMA5 = yLow >= ma5 * 0.99;
    const isRedK = yClose > yOpen;
    const volOk = vma5 > 0 ? (yVol >= vma5 * 0.8) : true;
    if (heldAboveMA5 && isRedK && volOk) {
        return {
            ma5: ma5.toFixed(2),
            lastClose: yClose.toFixed(2),
            volRatio: vma5 > 0 ? yVol / vma5 : 0,
        };
    }
    return null;
}
