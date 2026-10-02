#!/usr/bin/env node
/**
 * 🤖 V78.1.7 AI 股神(機器人)⛔ 不可跟總覽講相反的話 —— 使用者截圖國巨:
 *   機器人寫「🔴 續抱・守好停損 / 停利 跌破 547 賣一半 / 停損 532.95 / 持有 59 天 / AI 總評分 47/100」,
 *   而總覽寫「⏳ 已超過 20 天」。真因:機器人是第二份自己的判斷引擎(陷阱 #37)。
 * 釘住:
 *   ⓐ 個股模式大字 == `_ovDecide().badge`;⛔ 沒有「續抱」「🔴」「賣一半」「AI 總評分」「−10%」「5 日線」
 *   ⓑ 0.07 張 → 「70 股」;天數 = `_exitDistance().maxd.held` 且寫「交易日」(⛔ 日曆天)
 *   ⓒ 價位 chip 一律對到跳動單位(`_floorTick`)
 *   ⓓ 決定性對照:`_ovDecLast` 的 badge 改成 XYZ → 機器人跟著變
 *   ⓔ 空手 → ⛔ 沒有「可以布局 / 買後停損」;大字仍 == `_ovDecide().badge`
 *   ⓕ 庫存模式:到期那檔「⏳ 已抱」、ETF「🐢」、遠的「🛡️ 續抱」
 *   ⓖ 靜態:總覽卡與機器人共用 `_ovDueBlockHtml`;機器人函式裡⛔ 不可再自己算均線或總評分
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const CODE = src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

// ⓖ 靜態
const fnBody = name => { const i = CODE.indexOf(`    ${name}(`); if (i < 0) return ''; const j = CODE.indexOf('\n    },\n', i); return CODE.slice(i, j); };
const adv = fnBody('_aiGodAdviceHtml');
ok('🚧 找得到 _aiGodAdviceHtml', adv.length > 500, adv.length);
ok('ⓖ 機器人讀 `_ovDecide` / `_ovDecLast`(⛔ 自己判)', /_ovDecide\(/.test(adv) && /_ovDecLast/.test(adv), '');
ok('ⓖ2 機器人函式裡⛔ 不可再自己算均線 / 總評分', !/slice\(m - k\)|ma20prev|_favQuickScore|score >= 62/.test(adv), '');
ok('ⓖ3 總覽卡與機器人共用 `_ovDueBlockHtml`', /_ovDueBlockHtml\(d, inv\)/.test(CODE) && /_ovDueBlockHtml\(d, ''\)/.test(adv), '');
const stockMode = fnBody('async _renderAiGodStockMode'.replace('async ', '')) || CODE.slice(CODE.indexOf('async _renderAiGodStockMode'), CODE.indexOf('async _renderAiGodStockMode') + 4000);
ok('ⓖ4 個股模式⛔ 不再算 / 顯示總評分', !/_favQuickScore\(/.test(stockMode) && !/AI 總評分/.test(stockMode), '');

const _exec = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._ovDecide && !!app._aiGodAdviceHtml, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const out = {};
    const mk = (lock, slope = 0.4, n = 80) => {
        const rows = [];
        for (let i = 0; i < n; i++) {
            const c = +(100 + i * slope).toFixed(2);
            const d = new Date(Date.UTC(2026, 3, 1) + i * 86400000).toISOString().slice(0, 10).replace(/\//g, '-').replace(/-/g, '/');
            rows.push({ date: d, open: c - 0.2, high: c + 0.5, low: c - 0.6, close: c, volume: 1000 });
        }
        if (lock) { const P = rows[n - 2].close, c = +(P * 1.1).toFixed(2); rows[n - 1] = { ...rows[n - 1], open: P * 1.03, high: c, low: P * 1.02, close: c }; }
        return rows;
    };
    const N = app._maxHold();
    app._tpeMinutes = () => ({ wd: 'Wed', min: 14 * 60, ymd: '2026-10-01' });
    app.isMarketOpen = () => false;
    app.getStockName = s => ({ '2327': '國巨', '2330': '台積電', '0050': '元大台灣50' }[s] || s);
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d; };
    // ── 個股模式:持有 N+20 天、鎖漲停、0.07 張 ──
    const rows = mk(true);
    const bi = rows.length - 1 - (N + 20);
    app.currentSymbolId = '2327'; app.activeData = rows; app.rawDailyData = rows; app._ovDecLast = null;
    app._getInventory = () => [{ symbol: '2327', cost: rows[bi].close, shares: 0.07, buyDate: rows[bi].date.replace(/\//g, '-') }];
    const d = app._ovDecide(rows, '2327');
    const ed = app._exitDistance(rows, '2327');
    const h = app._aiGodAdviceHtml('2327', rows);
    const el = txt(h);
    out.a = { badge: d && d.badge, state: d && d.state, html: h, text: el.textContent, adBadge: (el.querySelector('[data-aigod-badge]') || {}).textContent,
              pos: (el.querySelector('[data-aigod-pos]') || {}).textContent || '', held: ed && ed.maxd && ed.maxd.held, chips: [...el.querySelectorAll('[data-aigod-chips] b')].map(b => b.textContent) };
    out.ft = out.a.chips.filter(v => /^[\d,.]+$/.test(v)).map(v => { const x = +v.replace(/,/g, ''); return [x, app._floorTick(x)]; });
    out.hardRaw = (ed.lines.find(l => l.k === 'hard') || {}).v;
    // ⓓ 決定性對照
    app._ovDecLast = { sym: '2327', d: { ...d, badge: 'XYZ測試徽章' } };
    out.d99 = (txt(app._aiGodAdviceHtml('2327', rows)).querySelector('[data-aigod-badge]') || {}).textContent;
    app._ovDecLast = null;
    // ── 個股模式真的打開(modal)──
    app.fetchHistoricalData = async () => rows;
    try { await app.openAiGod('stock'); } catch (e) { out.openErr = String(e); }
    out.modalText = (document.getElementById('aiGodChat') || {}).textContent || '';
    // ⓔ 空手、空頭
    const bear = mk(false, -0.5);
    app._getInventory = () => [];
    app.currentSymbolId = '2603'; app.activeData = bear; app.rawDailyData = bear; app._ovDecLast = null;
    const db = app._ovDecide(bear, '2603');
    const hb = app._aiGodAdviceHtml('2603', bear);
    out.e = { badge: db && db.badge, adBadge: (txt(hb).querySelector('[data-aigod-badge]') || {}).textContent, text: txt(hb).textContent };
    // ⓕ 庫存模式
    const far = mk(false, 0.6);
    const map = { '2327': rows, '2330': far, '0050': mk(false, 0.1) };
    const inv = [
        { symbol: '2327', cost: rows[bi].close, shares: 0.07, buyDate: rows[bi].date.replace(/\//g, '-') },
        { symbol: '2330', cost: far[far.length - 4].close, shares: 1, buyDate: far[far.length - 4].date.replace(/\//g, '-') },
        { symbol: '0050', cost: 100, shares: 1, buyDate: '2026-04-01' },
    ];
    app.inventory = inv; app._getInventory = () => inv;
    app.fetchHistoricalData = async s => map[s];
    try { await app.openAiGod(); } catch (e) { out.invErr = String(e); }
    const chat = document.getElementById('aiGodChat');
    out.f = {};
    for (const s of ['2327', '2330', '0050']) { const b = chat && chat.querySelector(`[data-aigod-bubble="${s}"] [data-aigod-exit]`); out.f[s] = b ? [b.getAttribute('data-aigod-exit'), b.textContent] : null; }
    return out;
});
await browser.close();

const A = R.a;
ok('🚧 國巨情境真的走到「時間到期」', A.state === 'exit' && /已超過/.test(A.badge || ''), A.badge);
ok('ⓐ 機器人大字 == 總覽 `_ovDecide().badge`', A.adBadge === A.badge, `${A.adBadge} vs ${A.badge}`);
ok('ⓐ2 ⛔ 沒有「續抱」「🔴」「賣一半」「−10%」「5 日線」「AI 總評分」', !/續抱|🔴|賣一半|-10%|−10%|5 日線|AI 總評分/.test(A.text), A.text.slice(0, 300));
ok('ⓐ3 到期 → 機器人也有同一份精簡區塊(四行 + 明日規則)', /data-ovdue-card/.test(A.html) && /data-ovdue-rules/.test(A.html), '');
ok('ⓑ 0.07 張 → 「70 股」(部位那一行)', /70 股/.test(A.pos) && !/0\.07 張/.test(A.text), A.pos);
ok('ⓑ2 部位那一行:天數 = maxd.held 且寫「交易日」(⛔ 日曆天;斷言只框部位那一行)', A.held != null && new RegExp(`已抱 ${A.held} 個交易日`).test(A.pos) && !/持有 \d+ 天/.test(A.pos), `${A.held} | ${A.pos}`);
ok('ⓒ 價位 chip 一律對到跳動單位', R.ft.length >= 2 && R.ft.every(([x, f]) => Math.abs(x - f) < 1e-9), JSON.stringify(R.ft) + ' raw hard ' + R.hardRaw);
ok('ⓒ2 決定性:硬停損原始值不在格上,顯示的已捨去', R.hardRaw != null && Math.abs(R.hardRaw - Math.floor(R.hardRaw * 2) / 2) > 1e-9 && R.ft.some(([x]) => x < R.hardRaw && R.hardRaw - x < 0.5 + 1e-9), JSON.stringify(R.ft) + ' raw ' + R.hardRaw);
ok('ⓓ 決定性對照:總覽結論改成 XYZ → 機器人跟著變', R.d99 === 'XYZ測試徽章', R.d99);
ok('ⓐ4 真的打開 modal:沒有總評分 / 五維拆解,大字一樣', !R.openErr && R.modalText.includes(A.badge) && !/AI 總評分|五維拆解/.test(R.modalText), (R.openErr || '') + R.modalText.slice(0, 200));
ok('ⓔ 空手:大字 == `_ovDecide().badge`、⛔ 沒有「可以布局 / 買後停損」', R.e.adBadge === R.e.badge && !/可以布局|買後停損/.test(R.e.text), JSON.stringify(R.e).slice(0, 300));
ok('ⓕ 庫存模式:2327 到期那檔「⏳ 已抱」', R.f['2327'] && R.f['2327'][0] === 'due' && /⏳ 已抱/.test(R.f['2327'][1]), JSON.stringify(R.f));
ok('ⓕ2 ETF「🐢」', R.f['0050'] && R.f['0050'][0] === 'etf', JSON.stringify(R.f));
ok('ⓕ3 剛買、離線遠那檔不是「已跌破 / 到期」', R.f['2330'] && /far|watch|today/.test(R.f['2330'][0]), JSON.stringify(R.f));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails.length ? `\n❌ AIGOD_FAIL(${fails.length}):${fails.join(' / ')}` : '\n✅ AIGOD_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
