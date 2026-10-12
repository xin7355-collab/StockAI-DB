#!/usr/bin/env node
/**
 * 📡 V79.1.6 決策台 👑:現價即時跳動 + 表頭標日期 + 換倉前後不同口吻 + 每檔金額 + 選 👑 只講 👑
 *   使用者:「我要現價是會真實跳動的,09/24價改在左側,再來是現價」「漲停、處置移到股票代號右手邊」「億/日這列取消」
 *          「今天名次這列文字置左」「今天要做的事要依照還沒換倉及換倉當天的口吻要不一樣,也要依照我有沒有持前5名的股去告訴我改買賣」
 *   ① 欄位順序:名次 | 股票 | 09/24價 | 現價 | 今天 | 名次/動作;⛔ 沒有「億/日」;標籤(漲停 / 處置)在代號那一行;👜 = 手上有;最後一欄靠左
 *   ② 資料停在 09/28、沒有今天的價 → 表頭「09/28收盤 / 09/28漲跌 / 09/28名次」;有今天的價 → 「現價 / 今天」
 *   ③ WebSocket:14 檔、3 把金鑰 → 3 條連線(5 / 5 / 4)、每條不同金鑰;REST 一次只問一檔(⛔ 不併發);
 *      跳一次價 → 現價 / 從換倉日漲跌 / 今天漲跌一起變;漲停 → 紅底;15% 怪價丟掉;離開決策台就關;盤後 / 盤前 / 週末不開
 *   ④ 庫存頁改走共用 `_fugleWsOpen` 之後分片一樣(7 檔 2 把金鑰 → 5 + 2,不同金鑰)
 *   ⑤ 「今天要做的事」七種情況的第一行口吻 + 個人化(續抱 / 賣 / 改買);⭐ 決定性對照兩組:名單倒過來畫面跟著倒、手上已有就不叫你買
 *   ⑥ 每檔金額:帳戶總資金 正常 / 過期(比手上的股票 + 0050 少)/ 沒填;錢不夠才叫你賣 0050
 *   ⑦ 停 0050 那一行:👑 平常日子⛔ 沒有加碼 / 賣出指令;過期 ⛔ 不叫你賣 0050(🅿️ 也一樣)
 *   ⑧ 選 👑 時 13:00 🔥 尾盤買點提醒不讀名單(⭐ 決定性對照:🧬 時會讀)
 *   ⑨ 沒持有、名單外 → 👑「這一套不買它」(⛔ 沒有 🔥);持有、名單外 → 照舊 🔥
 * 注入(INJECT=):amt(放回億/日)/ nopaint(跳價不刷畫面)/ today(表頭寫死現價)/ owns(_leadOwns(false) 改回只看名單)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
const inj = (a, b) => { if (!SRC.includes(a)) { console.log('❌ 注入錨點不見了:' + a.slice(0, 80)); process.exit(1); } SRC = SRC.replace(a, b); };
if (INJ === 'amt') inj('${th(C.chg)}${bRows ? th(C.trank, true)', '${th(C.chg)}<button data-leadersort="amt20">億/日</button>${bRows ? th(C.trank, true)');
if (INJ === 'nopaint') inj('    _deckPaintAsk(sym) {\n', '    _deckPaintAsk(sym) { return;\n');
if (INJ === 'today') inj("const pxLbl = anyLive ? (afterClose ? '今天收盤' : '現價') : (md ? `${md}收盤` : '收盤');", "const pxLbl = '現價';");
if (INJ === 'owns') inj('        return true;   // 👑 V79.1.6 沒持有一律照 👑', '        return !!((X.L.buy || []).some(b => b.sym === sym));   // 👑 V79.1.6 沒持有一律照 👑');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_leadlive.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.addInitScript(() => {
    // 🔌 假的 WebSocket:記下網址 / 送出去的訊息,測試自己推成交進去(⛔ 不連真的富果)
    window.__ws = [];
    class FakeWS {
        constructor(url) { this.url = url; this.sent = []; this.readyState = 1; this.closed = false; window.__ws.push(this); setTimeout(() => { try { this.onopen && this.onopen(); } catch (_) {} }, 0); }
        send(m) { this.sent.push(String(m)); }
        close() { this.closed = true; this.readyState = 3; }
        push(obj) { try { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); } catch (_) {} }
    }
    window.WebSocket = FakeWS;
    try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'leadpark'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {}
});
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leaderDeckHtml === 'function' && typeof app._deckTodoLead === 'function', null, { timeout: 60000 });

const R = await page.evaluate(async () => {
    const o = {};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(50); return !!f(); };   // ⛔ 不用固定秒數(App 自己 init 會卡事件迴圈)
    const raf = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
    const T = (ymd, wd, min) => { app._tpeMinutes = () => ({ ymd, wd, min }); };
    // 🧱 App 自己的 init 會在幾秒內 switchAppTab('desk') → renderDeck(會蓋掉 #deckLeader)、也會呼叫富果 → 先隔開,測試自己控制
    const realSwitch = app.switchAppTab.bind(app);
    app.switchAppTab = () => {}; app.renderDeck = async () => {};
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d); d.querySelectorAll('details').forEach(x => x.open = true); const t = d.innerText; d.remove(); return t; };
    app._mktSeen = null;
    // ── 合成 screener(同 test_leaderdeck):120 檔,奇數過趨勢,chg10 越前面越大 ──
    const cols = ['c', 'chg', 'chg5', 'chg10', 'chg20', 'amt', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252'];
    const rows = {};
    for (let i = 0; i < 120; i++) {
        const chg10 = i < 100 ? (i % 2 ? 30 - i * 0.2 : -5) : 99;
        rows[String(1000 + i)] = [100, 1, 1, chg10, i, i, 200 - i, i % 2 ? 3 : -3, i % 2 ? 8 : 1, 0, 0, 0, 95];
    }
    rows['1003'][1] = 9.9; rows['1003'][9] = 1;   // 1003 那天收盤漲停
    rows['1005'][10] = 2;                          // 1005 處置
    const D = { data_date: '2026-09-28', cols, rows };
    const tw = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'].map(d => ({ date: d }));
    const BL = [{ sym: '1003', r: 1, c: 80 }, { sym: '1001', r: 2, c: 90 }, { sym: '1005', r: 3, c: 95 }, { sym: '1007', r: 4, c: 100 }, { sym: '1031', r: 5, c: 110 }];
    app._scrData = D; app._loadScreener = async () => D; app._getTwiiRows = async () => tw;
    app._mktBear60 = async () => ({ on: false, c: 1, ma20: 1, ma60: 1 });
    app._leadRebPx = { D: '2026-09-24', v: { map: new Map(BL.map(b => [b.sym, b.c])), rank: new Map(BL.map(b => [b.sym, b.r])), list: BL, err: null } };
    app._loadKline = async () => null; app._leadRebK = null;
    app._liveQuotes = {}; app._liveUpdated = null; app._deckQ = {}; app._leadCtx = null;
    app.inventory = [{ symbol: '1001', shares: 1, cost: 90 }, { symbol: '1009', shares: 1, cost: 100 }];
    app._getInventory = () => app.inventory;
    app.settings.accountSize = 0;
    app.getStockName = s => ({ 1001: '測試一', 1003: '測試三', 1005: '測試五' })[s] || s;
    const host = document.getElementById('deckLeader'), headBox = document.getElementById('deckHead');
    headBox.innerHTML = '<div id="deckTodoLead"></div>';
    host.style.width = '358px';

    // ① + ② 盤前(沒有今天的價)
    T('2026-10-12', 'Mon', 8 * 60);
    host.innerHTML = await app._leaderDeckHtml();
    const r3 = host.querySelector('[data-leaderrow="1003"]');
    o.cols = r3 ? [...r3.children].map(e => e.matches('[data-leaderreb]') ? 'reb' : e.matches('[data-leaderpx]') ? 'px' : e.matches('[data-lqc]') ? 'chg' : e.matches('[data-leaderact]') ? 'act' : e.matches('[data-leadername]') ? 'name' : 'rank') : [];
    o.hdr = [...host.querySelectorAll('[data-leadersort]')].map(e => e.dataset.leadersort);
    o.noAmt = !/億\/日/.test(host.innerText);
    const nm3 = host.querySelector('[data-leadername="1003"]'), nm5 = host.querySelector('[data-leadername="1005"]'), nm1 = host.querySelector('[data-leadername="1001"]');
    o.tag3 = nm3 ? [nm3.children[0].innerText, nm3.children[1].innerText] : [];
    o.tag5 = nm5 ? [nm5.children[0].innerText, nm5.children[1].innerText] : [];
    o.tag1 = nm1 ? nm1.children[1].innerText : '';
    const act = r3 && r3.querySelector('[data-leaderact]');
    o.actLeft = !!act && act.classList.contains('text-left') && !act.classList.contains('text-right');
    o.rkHdrLeft = !!host.querySelector('[data-leadersort="trank"].text-left');
    o.lblPre = { px: host.querySelector('[data-lqhdr="px"]')?.innerText, chg: host.querySelector('[data-lqhdr="chg"]')?.innerText, rk: host.querySelector('[data-leadersort="trank"]')?.innerText };
    o.liveNote = host.querySelector('[data-leaderlivenote]')?.innerText || '';
    o.over = [...host.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > host.getBoundingClientRect().right + 1; }).length;
    // ② 有今天的價
    T('2026-10-12', 'Mon', 10 * 60);
    app._deckQ = { '1003': { p: 88, prev: 80, o: 82, d: '2026-10-12', at: 600, src: 'ws' } };
    host.innerHTML = await app._leaderDeckHtml();
    o.lblLive = { px: host.querySelector('[data-lqhdr="px"]')?.innerText, chg: host.querySelector('[data-lqhdr="chg"]')?.innerText, rk: host.querySelector('[data-leadersort="trank"]')?.innerText };
    o.live3 = host.querySelector('[data-leaderrow="1003"] [data-lqp]')?.textContent;
    app._deckQ = {};

    // ③a 分片:14 檔、3 把金鑰
    app._getFugleKeys = () => ['K1', 'K2', 'K3'];
    app._deckTabOn = () => true;
    let inflight = 0, maxIn = 0; const calls = [];
    // 只量決策台要的代號(App 其他地方也會叫富果 → ⛔ 不算進來)
    app.fetchFugleData = async s => { if (!/^(1|2)0\d\d$/.test(String(s))) return null; inflight++; maxIn = Math.max(maxIn, inflight); calls.push(s); await sleep(4); inflight--; return { price: 102, prevClose: 100, open: 101, date: '2026/10/14' }; };
    T('2026-10-14', 'Wed', 10 * 60);
    window.__ws = [];
    app._deckLqSyms = Array.from({ length: 14 }, (_, i) => String(2000 + i));
    app._startDeckStream();
    await until(() => calls.length >= 14 && window.__ws.length >= 3 && window.__ws.every(w => w.sent.length));
    const parse = w => w.sent.map(m => { try { return JSON.parse(m); } catch (_) { return {}; } });
    o.shard = window.__ws.map(w => { const m = parse(w); return { key: (m.find(x => x.event === 'auth') || {}).data?.apikey, subs: m.filter(x => x.event === 'subscribe').map(x => x.data.symbol) }; });
    o.maxIn = maxIn; o.calls = calls.length;
    app._stopDeckStream();
    o.shardClosed = window.__ws.every(w => w.closed);

    // ③b 跳價 → 只改那幾格
    app._leadCtx = null; app._deckQ = {};
    host.innerHTML = await app._leaderDeckHtml();
    host.querySelector('details[data-leaderinfo]') && (host.querySelector('details[data-leaderinfo]').open = true);
    window.__ws = []; app._deckStreamKey = '';
    app._syncDeckStream();
    await until(() => app._deckQ && app._deckQ['1003'] && app._deckQ['1003'].prev > 0 && window.__ws.some(w => w.sent.some(m => m.includes('"symbol":"1003"'))));
    const ws3 = window.__ws.find(w => w.sent.some(m => m.includes('"symbol":"1003"')));
    o.ws3 = !!ws3;
    const rowEl = host.querySelector('[data-leaderrow="1003"]');
    o.before = rowEl.querySelector('[data-lqp]').textContent;
    ws3 && ws3.push({ event: 'data', data: { symbol: '1003', price: 110 } });
    await raf();
    const r3b = host.querySelector('[data-leaderrow="1003"]');
    o.sameNode = r3b === rowEl;   // ⛔ 不重畫整張表
    o.tick = { p: r3b.querySelector('[data-lqp]').textContent, r: r3b.querySelector('[data-lqr]').textContent, c: r3b.querySelector('[data-lqc]').textContent,
               red: r3b.querySelector('[data-lqp]').classList.contains('bg-red-600'), lim: r3b.querySelector('[data-lqlim]').textContent, live: r3b.querySelector('[data-lqp]').dataset.leaderlive };
    o.detailsStillOpen = !!host.querySelector('details[data-leaderinfo]')?.open;
    o.hdrNow = host.querySelector('[data-lqhdr="px"]')?.innerText;
    ws3 && ws3.push({ event: 'data', data: { symbol: '1003', price: 200 } });   // 怪價(+82%)
    await raf();
    o.weird = host.querySelector('[data-leaderrow="1003"] [data-lqp]').textContent;
    // ③c 離開決策台 → 關
    const deckWs = [...(app._deckWsList || [])];
    try { realSwitch('inv'); } catch (_) {}
    o.leaveClosed = deckWs.length > 0 && deckWs.every(w => w.closed);
    // ③d 盤後(資料日已是今天)/ 盤前 / 週末 → 不開 WebSocket
    app._deckLqDate = '2026-10-14';
    window.__ws = []; T('2026-10-14', 'Wed', 14 * 60); app._startDeckStream(); await sleep(50); o.afterWs = window.__ws.length;
    window.__ws = []; T('2026-10-14', 'Wed', 8 * 60); app._startDeckStream(); await sleep(50); o.preWs = window.__ws.length; o.preWake = !!app._deckWakeT;
    window.__ws = []; T('2026-10-17', 'Sat', 10 * 60); app._startDeckStream(); await sleep(50); o.wkWs = window.__ws.length;
    // 盤後、資料日還停在之前 → 抓一次今天收盤(一天一次,⛔ 不開 WebSocket)
    app._stopDeckStream(); calls.length = 0; app._deckClosePulled = {}; app._deckLqDate = '2026-10-13';
    window.__ws = []; T('2026-10-14', 'Wed', 14 * 60); app._deckLqSyms = ['1003', '1001']; app._startDeckStream(); await until(() => app._deckClosePulled['2026-10-14']);
    o.closePull = { ws: window.__ws.length, calls: calls.length, mark: app._deckClosePulled['2026-10-14'] };
    app._stopDeckStream();

    // ④ 庫存頁分片(共用 `_fugleWsOpen`)
    app.isMarketOpen = () => true;
    app.inventory = Array.from({ length: 7 }, (_, i) => ({ symbol: String(3000 + i), shares: 1, cost: 10 }));
    app._getFugleKeys = () => ['K1', 'K2'];
    window.__ws = []; app._startInvWsStream(); await until(() => window.__ws.length >= 2 && window.__ws.every(w => w.sent.length));
    o.inv = window.__ws.map(w => { const m = parse(w); return { key: (m.find(x => x.event === 'auth') || {}).data?.apikey, n: m.filter(x => x.event === 'subscribe').length }; });
    app._stopInvWsStream();
    o.invClosed = window.__ws.every(w => w.closed);
    app._getFugleKeys = () => []; app._invWsSyms = undefined; window.__ws = []; app._startInvWsStream(); await sleep(50);
    o.invNoKey = { ws: window.__ws.length, syms: app._invWsSyms };

    // ⑤ 「今天要做的事」口吻 + 個人化
    app.getStockName = s => ({ 2330: '台積電', 2454: '聯發科', 3008: '大立光', 2317: '鴻海', 2382: '廣達', 6669: '緯穎', 3231: '緯創' })[s] || s;
    app._deckQ = {}; app._liveQuotes = {}; app._mktSeen = null;
    const rk = { 2317: 1, 2330: 2, 2382: 3, 6669: 4, 3231: 5, 2454: 7, 3008: 14 };
    const mkL = (buy, date) => ({ buy: buy.map(sym => ({ sym })), all: new Map(Object.entries(rk).map(([s, r]) => [s, { rank: r, c: 100 + r, chg: 1 }])), ranked: [], date });
    const HELD = [{ sym: '2330', mine: true }, { sym: '2454', mine: true }, { sym: '3008', mine: true }];
    const INV = ['2330', '2454', '3008', '6669'], BUY = ['2317', '2330', '2382', '6669', '3231'];
    app._getInventory = () => [];
    const todo = (clk, date, t, opt = {}) => { T(...t); const h = app._deckTodoLead({ clk, bearOn: false, L: mkL(opt.buy || BUY, date), held: opt.held || HELD, H: 10, inv: opt.inv || INV }); return { h, t: txt(h), first: ((h.match(/data-todo="now"[^>]*>([\s\S]*?)<br>/) || [])[1] || '').replace(/<[^>]+>/g, '') }; };
    const W = { started: true, day: 7, isRebal: false, left: 4 }, W1 = { started: true, day: 10, isRebal: false, left: 1 }, RB = { started: true, day: 11, isRebal: true, left: 0 };
    o.p1 = todo(W, '2026-10-08', ['2026-10-08', 'Thu', 18 * 60]);
    o.p2 = todo(W1, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60]);
    o.p2b = todo(W1, '2026-10-08', ['2026-10-08', 'Thu', 18 * 60]);
    o.p3 = todo(W1, '2026-10-12', ['2026-10-13', 'Tue', 10 * 60]);
    o.p4 = todo(RB, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60]);
    app._deckQ = { 2317: { p: 105, prev: 100, o: 102, d: '2026-10-14', at: 600 }, 2382: { p: 110, prev: 100, o: 110, d: '2026-10-14', at: 600 } };
    o.p5 = todo(RB, '2026-10-13', ['2026-10-14', 'Wed', 10 * 60]);
    o.p6 = todo(RB, '2026-10-13', ['2026-10-14', 'Wed', 14 * 60]);
    app._deckQ = {};
    o.p7 = todo(W, '2026-10-08', ['2026-10-08', 'Thu', 18 * 60], { held: [], inv: [] });
    o.p7r = todo(W, '2026-10-08', ['2026-10-08', 'Thu', 18 * 60], { held: [], inv: [], buy: BUY.slice().reverse() });
    o.p4noX = todo(RB, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60], { inv: ['2330', '2454', '3008'] });
    // 🏖️ 富果報價看得出今天休市 → ⛔ 不算一天(買賣當天變回「名單已定案」)
    T('2026-10-14', 'Wed', 10 * 60); app._mktSeen = { ymd: '2026-10-14', today: 0, old: 3 };
    o.hol = app._leadPhase(RB, '2026-10-13'); app._mktSeen = null;
    o.noHol = app._leadPhase(RB, '2026-10-13');

    // ⑥ 每檔金額
    const inv6 = [{ symbol: '2454', shares: 0.1, cost: 1300, currentPrice: 1300 }, { symbol: '0050', shares: 2, cost: 100, currentPrice: 100 }];
    app._getInventory = () => inv6;
    app.settings.accountSize = 1000000; o.s1 = todo(RB, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60]).t;
    app.settings.accountSize = 500000; o.s1b = todo(RB, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60]).t;
    app.settings.accountSize = 60000; o.s2 = todo(RB, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60]).t;
    app.settings.accountSize = 0; o.s3 = todo(RB, '2026-10-13', ['2026-10-13', 'Tue', 18 * 60]).t;
    // ⑦ 停 0050 那一行
    app.settings.strategy = 'leadpark';
    app.settings.accountSize = 1000000; o.k1 = txt(app._parkAmountHtml());
    app.settings.accountSize = 60000; o.k2 = txt(app._parkAmountHtml());
    app.settings.strategy = 'park'; o.k3 = txt(app._parkAmountHtml());
    app.settings.accountSize = 1000000; o.k4 = txt(app._parkAmountHtml());
    app.settings.strategy = 'leadpark'; app.settings.accountSize = 0;

    // ⑧ 🔥 尾盤買點提醒
    let loads = 0; app._loadPlaybookEdge = async () => { loads++; return { picks: [] }; };
    app.settings.watchlistAlert = true;
    try { Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true }); } catch (_) {}
    T('2026-10-14', 'Wed', 13 * 60 + 5); app._eodBusy = false;
    await app._eodTriggerSweep(); o.eodLead = loads;
    app.settings.strategy = 'gene'; app._eodBusy = false; await app._eodTriggerSweep(); o.eodGene = loads;
    app.settings.strategy = 'leadpark';

    // ⑨ 名單外的股票
    app._leadCtx = { at: Date.now(), L: { all: new Map(), buy: [{ sym: '2317' }], poolSet: new Set(), pos: 85 }, clk: { isRebal: false, left: 6 }, bearOn: false, date: '2026-10-08', snap: { date: '2026-09-24', rank: new Map([['2330', 1]]) } };
    o.own = { notHeld: app._leadOwns('9999', false), heldOut: app._leadOwns('9999', true), heldIn: app._leadOwns('2330', true), fire: app._leadFireNote('9999', false) };
    return o;
});
fs.unlinkSync(TMP);
await browser.close();

// ①
ok('① 欄位順序:名次 | 股票 | 09/24價 | 現價 | 今天 | 名次(⛔ 沒有億/日)', JSON.stringify(R.cols) === JSON.stringify(['rank', 'name', 'reb', 'px', 'chg', 'act']) && JSON.stringify(R.hdr) === JSON.stringify(['rank', 'reb', 'c', 'chg', 'trank']) && R.noAmt, JSON.stringify([R.cols, R.hdr, R.noAmt]));
ok('①b 漲停 / 處置在代號那一行(⛔ 不在名字那一行);👜 = 手上有', !/漲停|處置/.test(R.tag3[0] || '') && /1003\s*漲停/.test(R.tag3[1] || '') && !/處置/.test(R.tag5[0] || '') && /1005.*處置/.test(R.tag5[1] || '') && /1001\s*👜/.test(R.tag1), JSON.stringify([R.tag3, R.tag5, R.tag1]));
ok('①c 最後一欄(名次 / 動作)靠左,表頭也靠左', R.actLeft && R.rkHdrLeft, JSON.stringify([R.actLeft, R.rkHdrLeft]));
ok('①d 390px 不超出', R.over === 0, R.over);
// ②
ok('② 📅 資料停在 09/28、沒有今天的價 → 表頭「09/28收盤 / 09/28漲跌 / 09/28名次」(⛔ 不寫現價 / 今天)', R.lblPre.px === '09/28收盤' && R.lblPre.chg === '09/28漲跌' && /^09\/28名次/.test(R.lblPre.rk || ''), JSON.stringify(R.lblPre));
ok('②b 有今天的價 → 「現價 / 今天」,名次照舊寫 09/28(名次是那天收盤排的)', R.lblLive.px === '現價' && R.lblLive.chg === '今天' && /^09\/28名次/.test(R.lblLive.rk || '') && R.live3 === '88.00', JSON.stringify([R.lblLive, R.live3]));
ok('②c 表下寫現價是哪來的(沒有富果金鑰 → 告訴你去設定填)', /09\/28 收盤/.test(R.liveNote) && /富果金鑰/.test(R.liveNote), R.liveNote);
// ③
ok('③ 14 檔、3 把金鑰 → 3 條連線(5 / 5 / 4)、每條不同金鑰、訂的是前 14 檔', R.shard.length === 3 && JSON.stringify(R.shard.map(x => x.key)) === JSON.stringify(['K1', 'K2', 'K3']) && JSON.stringify(R.shard.map(x => x.subs.length)) === JSON.stringify([5, 5, 4]), JSON.stringify(R.shard));
ok('③b REST 一次只問一檔(⛔ 不併發),第一輪每一檔都問(要昨收 / 開盤)', R.maxIn === 1 && R.calls >= 14, JSON.stringify([R.maxIn, R.calls]));
ok('③c ⭐ 跳一次價 → 現價 110.0、從 09/24 +37.5%、今天 +10.0%、漲停紅底 + 代號旁「漲停」;⛔ 不重畫整張表(同一個節點、摺疊沒被關掉)', R.ws3 && R.tick.p === '110.0' && R.tick.r === '+37.5%' && R.tick.c === '+10.0%' && R.tick.red && /漲停/.test(R.tick.lim) && R.tick.live === '1' && R.sameNode && R.detailsStillOpen && R.hdrNow === '現價', JSON.stringify([R.before, R.tick, R.sameNode, R.detailsStillOpen, R.hdrNow]));
ok('③d 15% 怪價直接丟掉', R.weird === '110.0', R.weird);
ok('③e 離開決策台 → WebSocket 全關', R.leaveClosed && R.shardClosed, JSON.stringify([R.leaveClosed, R.shardClosed]));
ok('③f 盤後(資料日已是今天)/ 盤前 / 週末 → ⛔ 不開 WebSocket;盤前排好 09:00 自己開', R.afterWs === 0 && R.preWs === 0 && R.preWake && R.wkWs === 0, JSON.stringify([R.afterWs, R.preWs, R.preWake, R.wkWs]));
ok('③g 盤後、資料日還停在之前 → 抓一次今天收盤(⛔ 不開 WebSocket,記一天一次)', R.closePull.ws === 0 && R.closePull.calls >= 2 && R.closePull.mark === 1, JSON.stringify(R.closePull));
// ④
ok('④ 庫存頁走共用 `_fugleWsOpen`:7 檔 2 把金鑰 → 5 + 2、不同金鑰;關掉全關;沒有金鑰 → 不開', JSON.stringify(R.inv) === JSON.stringify([{ key: 'K1', n: 5 }, { key: 'K2', n: 2 }]) && R.invClosed && R.invNoKey.ws === 0 && R.invNoKey.syms === undefined, JSON.stringify([R.inv, R.invClosed, R.invNoKey]));
// ⑤
ok('⑤a 還沒到(4 天):「還沒到換倉日,今天不用動」+ 你的 👑 續抱 / 換倉日才賣 + 名單外持股 + 規則收起來', /還沒到換倉日,今天不用動/.test(R.p1.first) && /4 個交易日後收盤換倉/.test(R.p1.first) && /台積電 第2、聯發科 第7 → 續抱/.test(R.p1.t) && /大立光 第14 → 換倉日還在 10 名外才賣/.test(R.p1.t) && /緯穎 第4 不在上次名單/.test(R.p1.t) && /data-todorules="1"/.test(R.p1.h) && !/data-todohot="1"/.test(R.p1.h), R.p1.t);
ok('⑤b 明天換倉(週二):「明天收盤換倉 → 後天照名單買賣」+ 琥珀色;週四 → 下週一', /明天收盤換倉/.test(R.p2.first) && /後天/.test(R.p2.first) && /data-todohot="1"/.test(R.p2.h) && /明天收盤換倉/.test(R.p2b.first) && /下週一/.test(R.p2b.first), JSON.stringify([R.p2.first, R.p2b.first]));
ok('⑤c 今天就是換倉日:「今天就是換倉日 → 收盤定名單,明天照做」+ 賣 / 改買 / 續抱 + 規則攤開', /今天就是換倉日/.test(R.p3.first) && /明天/.test(R.p3.first) && /賣 大立光/.test(R.p3.t) && /改買 鴻海/.test(R.p3.t) && /續抱 台積電/.test(R.p3.t) && /收盤才定案/.test(R.p3.t) && !/data-todorules/.test(R.p3.h), R.p3.t);
ok('⑤d 名單已定案:「名單已定案 → 明天照做」+ 明天 09:00 賣 / 13:25 買 / 續抱(含名單外但在前 10 的緯穎)', /名單已定案/.test(R.p4.first) && /明天\s*09:00\s*開盤賣:大立光/.test(R.p4.t) && /明天\s*13:25\s*買:鴻海/.test(R.p4.t) && /廣達/.test(R.p4.t.split('續抱')[0]) && /續抱:台積電 第2、聯發科 第7、緯穎 第4/.test(R.p4.t), R.p4.t);
ok('⑤e 買賣當天:「今天就要做」+ 每檔開盤開在哪 → 照規則講(開 +2.0% → 13:25 照買;開盤就漲停 → 不追)', /今天就要做/.test(R.p5.first) && /鴻海[^・]*開 \+2\.0% → 13:25 照買/.test(R.p5.t) && /廣達[^・]*開盤就漲停,不追/.test(R.p5.t) && !/明天/.test(R.p5.t.split('🛒 怎麼買')[0]), R.p5.t);
ok('⑤f 買賣當天收盤後:「今天的換倉時間已過」+「沒趕上的不用急」、⛔ 不再是琥珀色', /今天的換倉時間已過/.test(R.p6.first) && /沒趕上的不用急/.test(R.p6.t) && !/data-todohot="1"/.test(R.p6.h), R.p6.t);
ok('⑤g 手上沒有 👑:「你還沒有 👑 的股票 → 等換倉日照名單一起買最省事」+ 換倉時會買(⛔ 不寫改買)', /你還沒有 👑 的股票/.test(R.p7.t) && /換倉時會買:鴻海/.test(R.p7.t) && !/改買/.test(R.p7.t), R.p7.t);
const ordA = ['鴻海', '台積電', '廣達', '緯穎', '緯創'].map(n => R.p7.t.indexOf(n)), ordB = ['鴻海', '台積電', '廣達', '緯穎', '緯創'].map(n => R.p7r.t.indexOf(n));
ok('⑤h ⭐ 決定性對照:買進名單倒過來 → 畫面跟著倒(⛔ 不另排一份)', ordA.every((v, i) => i === 0 || v > ordA[i - 1]) && ordB.every((v, i) => i === 0 || v < ordB[i - 1]), JSON.stringify([ordA, ordB]));
ok('⑤i ⭐ 決定性對照:手上有名單上的緯穎 → ⛔ 不叫你買(算續抱);拿掉那一檔 → 緯穎回到要買的', !/緯穎/.test(R.p4.t.split('續抱')[0].split('🛒')[1] || '') && /🛒[^✅]*緯穎/.test(R.p4noX.t) && !/緯穎 第4/.test(R.p4noX.t.split('🛒')[0]), JSON.stringify([R.p4.t.slice(0, 300), R.p4noX.t.slice(0, 300)]));
ok('⑤j 🏖️ 富果報價看得出今天休市 → ⛔ 不算一天(買賣當天變回「名單已定案」);沒資料 = 照舊', R.hol.ph === 'eve' && R.noHol.ph === 'act', JSON.stringify([R.hol, R.noHol]));
ok('⑤k ⛔ 無 🔴🟢、⛔ 沒有研究數字', ![R.p1, R.p3, R.p4, R.p5, R.p7].some(x => /[🔴🟢]/u.test(x.h) || /實測|回測|勝率|含息/.test(x.t)), '');
// ⑥
ok('⑥a 帳戶總資金正常:每檔約 20 萬(= ÷ 5)+ 每檔約幾股;錢夠 → 0050 不用動', /每檔約 20 萬/.test(R.s1) && /鴻海 ≈ 1,980 股/.test(R.s1) && /0050 不用動/.test(R.s1), R.s1);
ok('⑥b 錢不夠 → 先用賣掉的 + 現金,不夠的再賣 0050(要 20 萬 − 現金 17 萬 = 約 3 萬)', /每檔約 10 萬/.test(R.s1b) && /再賣 0050 約 3 萬/.test(R.s1b), R.s1b);
ok('⑥c 🚨 帳戶總資金過期(6 萬 < 手上 33 萬)→ ⛔ 不算金額,叫你先改設定', /你填的帳戶總資金 6 萬/.test(R.s2) && /33 萬/.test(R.s2) && !/每檔約/.test(R.s2) && !/賣 0050 約/.test(R.s2), R.s2);
ok('⑥d 沒填 → 引導去設定填', /到 ⚙️ 設定填「帳戶總資金」/.test(R.s3) && !/每檔約/.test(R.s3), R.s3);
// ⑦
ok('⑦a 👑+停車 0050 平常日子:只講「換倉日之間不用調整、不用等它便宜」,⛔ 沒有加碼 / 賣出指令', /換倉日之間不用調整/.test(R.k1) && /不用等它便宜/.test(R.k1) && !/還可以再買|0050 多了|該停在 0050/.test(R.k1), R.k1);
ok('⑦b 帳戶總資金過期 → ⛔ 不叫你賣 0050(👑 與 🅿️ 都一樣)', /比手上的股票 \+ 0050/.test(R.k2) && !/0050 多了|還可以再買/.test(R.k2) && /比手上的股票 \+ 0050/.test(R.k3) && !/0050 多了|還可以再買/.test(R.k3), JSON.stringify([R.k2, R.k3]));
ok('⑦c 🅿️(高檔飆股+停車)帳戶正常 → 照舊算該停多少在 0050', /該停在 0050/.test(R.k4), R.k4);
// ⑧
ok('⑧ 選 👑 → 13:00 🔥 尾盤買點提醒不讀名單;⭐ 決定性對照:🧬 時會讀', R.eodLead === 0 && R.eodGene === 1, JSON.stringify([R.eodLead, R.eodGene]));
// ⑨
ok('⑨ 沒持有、名單外 → 👑(這一套不買它,⛔ 沒有 🔥);持有、名單外 → 🔥;持有、名單上 → 👑', R.own.notHeld === true && R.own.heldOut === false && R.own.heldIn === true && R.own.fire === '', JSON.stringify(R.own));
ok('ⓩ 無 pageerror', !errs.length, errs.join(' | '));
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_leadlive 全過');
process.exit(fails.length ? 1 : 0);
