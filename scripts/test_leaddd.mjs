#!/usr/bin/env node
/**
 * ✂️ V82.0.7 👑「跌 20% 收一半」散戶 App 端守門(使用者 11/07 選「做成開關並幫我打開」)
 *   ⓪ 三份一字不差:index `_LEAD_DD_LIVE` == lib_leaddd `LEAD_DD.live` == auto_trade `LEADER_DD_LIVE`;預設都是開
 *   ① index `_ddWaChain` == lib_leaddd `waChain`(一本帳一條;300 組亂數 × top 0/1 × 起用日)
 *   ② `_leadDdPlan`:收一半那次換倉(trim)/ 收一半中(⛔ 再收)/ 回到最高點但空頭(先不補)/ 回到最高點(top)/
 *      狀態沒更新(stale,照上一次)/ 讀不到(nodata)/ 關掉(一模一樣)/ 打開那天之前的換倉一律全額 / 非換倉日的預告 / 兩本帳各算各的
 *   ③ `_leadActs`:trim = 這本帳留著的、topup 空頭不做;⭐ 決定性對照:關掉 → sell / keep / buy 跟開著時逐欄相同,trim / topup 空
 *   ④ 決策台「今天要做的事」:收一半那次寫出要賣幾股、新買的每檔只買一半(每檔金額 × 0.5);關掉 → 一個 ✂️ 都沒有
 *      讀不到 / 沒更新要明講(⛔ 跟「全額」長得一樣)
 *   ⑤ 換倉提醒:收一半寫進那一則;狀態還沒到 → ⛔ 先蓋章(沒事要做時);先發了換倉提醒、之後狀態才到 → 補一則收一半
 *   ④b V82.2.6 賣一半拿回來的錢:金額只看持股市值(帳戶總資金過期也照算)、「今天要買股票的錢先扣掉」只在今天真的有買時講
 *   ④c V82.2.6 換倉那天過了 10:00(= auto_trade `mins > LEADER_DEFER_SELL_TO`)→ 賣 / 賣一半改「13:00 起尾盤賣」;10:00 / 09:05 照舊(決定性對照)
 *   ⑥ 開盤提醒:賣一半跟賣出同一個時段、補回跟買進同一個時段;⑥b 過了 10:00 才第一次跳 → 「還沒做的事」、⛔「現在開盤…」
 *   ⑦ 設定:🔓 進階功能只在 👑 + 解鎖時列 ddhalf、預設勾、取消 = settings.leadDdHalf false(⛔ 存進 deckShow)
 *   ⑧ Telegram 同步送 leadDdHalf / leadDdAt;策略變更那一筆只給 👑、「換回舊的」= 關掉
 *   ⑨ ⛔ App 不存也不印「離最高點幾 %」(只留 rot / def / since);390px 決策台那段不橫向溢出
 *   ⑩ Worker(Telegram)== App:同一條鏈 / 同一組換倉日答案 / trim 同一份;沒傳設定或關掉 = 一個 ✂️ 都沒有
 * 注入:INJECT=nochain(拿掉「想要的比較小就收」)/ notrim(trim 恆空)/ nobear(空頭也補回)/ nostale(狀態沒到也蓋章)
 *       / wtrim(worker trim 恆空)/ wbear(worker 空頭也補回)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { waChain, LEAD_DD } from './lib_leaddd.mjs';
import { rwdShim } from './lib_rwdshim.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nochain') SRC = SRC.replace('            else if (r.W < wa) wa = r.W;\n            else if (r.W > wa && (!top || !r.bear)) wa = r.W;\n            cur = wa;', '            else if (r.W > wa && (!top || !r.bear)) wa = r.W;\n            cur = wa;');
if (INJ === 'notrim') SRC = SRC.replace("const trim = dd.mode === 'trim' ? kHeld.slice() : []", 'const trim = []');
if (INJ === 'nobear') SRC = SRC.replace('            else if (r.W > wa && (!top || !r.bear)) wa = r.W;\n            cur = wa;', '            else if (r.W > wa) wa = r.W;\n            cur = wa;');
if (INJ === 'nostale') SRC = SRC.replace("if (!(D.on && D.err === 'stale')) { try { localStorage.setItem('leadRebalFired', key); } catch (_) {} }", "try { localStorage.setItem('leadRebalFired', key); } catch (_) {}");
if (INJ && !/^w/.test(INJ) && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_leaddd.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 600)}`); if (!c) fails.push(n); };

// ⓪ 三份一字不差
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
const iLive = (SRC.match(/_LEAD_DD_LIVE: '(\d{4}-\d\d-\d\d)'/) || [])[1];
const aLive = (AT.match(/^LEADER_DD_LIVE = '(\d{4}-\d\d-\d\d)'/m) || [])[1];
ok('⓪ 起用日三份一字不差(index `_LEAD_DD_LIVE` / lib_leaddd / auto_trade)', iLive && iLive === LEAD_DD.live && aLive === LEAD_DD.live, JSON.stringify({ iLive, lib: LEAD_DD.live, aLive }));
ok('⓪ 預設開:index `settings.leadDdHalf !== false`、auto_trade `LEADER_DD_HALF` 沒設 = 開',
    /_leadDdOn\(\) \{ const s = this\.settings \|\| \{\}; return s\.leadDdHalf !== false; \}/.test(SRC) && /^LEADER_DD_HALF = \(os\.getenv\('LEADER_DD_HALF'\) or '1'\) == '1'/m.test(AT));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leadDdPlan === 'function' && typeof app._deckTodoLead === 'function', null, { timeout: 60000 });

// ① 亂數序列(跟 lib 同一組):index 那份一本帳一條 → 逐本拿出來比
let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const cases = [];
for (let k = 0; k < 300; k++) {
    const n = 2 + Math.floor(rnd() * 14), d0 = Date.parse('2026-08-03T00:00:00Z');
    const rots = []; for (let i = 0; i < n; i++) rots.push({ d: new Date(d0 + i * 14 * 864e5).toISOString().slice(0, 10), b: 'A', W: rnd() < 0.5 ? 0.5 : 1, bear: rnd() < 0.3 ? 1 : 0 });
    const live = rots[Math.floor(rnd() * n)].d, top = rnd() < 0.5 ? 0 : 1;
    cases.push({ rots, live, top, want: waChain(rots, { top }, live).map(r => r.wa) });
}
const ch = await page.evaluate(cs => cs.map(c => app._ddWaChain(c.rots, c.top, c.live).map(r => r.wa)), cases);
const bad = cases.findIndex((c, i) => JSON.stringify(c.want) !== JSON.stringify(ch[i]));
ok('① index `_ddWaChain` == lib_leaddd `waChain`(300 組亂數 × top 0 / 1 × 起用日)', bad < 0, bad >= 0 ? JSON.stringify({ c: cases[bad], got: ch[bad] }) : '');
ok('① 亂數真的有收也有補(⛔ 全部 1 的空過)', cases.some(c => c.want.includes(0.5)) && cases.some(c => c.want.some((w, i) => i > 0 && w === 1 && c.want[i - 1] === 0.5)));

const R = await page.evaluate(() => {
    const o = {};
    app.settings = app.settings || {};
    delete app.settings.leadDdHalf; delete app.settings.leadDdAt;
    const rule = { th: 20, lo: 0.5, rec: 'hi', top: 1, live: '2026-11-12', from: '2024-07-01' };
    const J = (rot, data_date, def = 1) => ({ data_date, def, since: def ? '2026-07-24' : null, rule, rot });
    const clkR = (book = 'A') => ({ started: true, day: 21, isRebal: true, left: 0, book, books: 1 });
    const clkW = (left) => ({ started: true, day: 21, isRebal: false, left, book: 'A', books: 1 });
    const plan = (X, data) => { app._leadDdData = data; return app._leadDdPlan(X); };
    const R1 = [{ d: '2026-10-29', b: 'A', W: 0.5, bear: 0 }, { d: '2026-11-12', b: 'A', W: 0.5, bear: 0 }];
    o.trim = plan({ clk: clkR(), date: '2026-11-12' }, J(R1, '2026-11-12'));
    const R2 = R1.concat([{ d: '2026-11-26', b: 'A', W: 0.5, bear: 0 }]);
    o.still = plan({ clk: clkR(), date: '2026-11-26' }, J(R2, '2026-11-26'));
    const R3 = R2.concat([{ d: '2026-12-10', b: 'A', W: 1, bear: 1 }]);
    o.bear = plan({ clk: clkR(), date: '2026-12-10' }, J(R3, '2026-12-10', 0));
    const R4 = R3.concat([{ d: '2026-12-24', b: 'A', W: 1, bear: 0 }]);
    o.top = plan({ clk: clkR(), date: '2026-12-24' }, J(R4, '2026-12-24', 0));
    o.stale = plan({ clk: clkR(), date: '2026-11-12' }, J(R1.slice(0, 1), '2026-11-06'));
    o.staleHalf = plan({ clk: clkR(), date: '2026-11-26' }, J(R1, '2026-11-12'));
    o.nodata = plan({ clk: clkR(), date: '2026-11-12' }, null);
    app.settings.leadDdHalf = false;
    o.off = plan({ clk: clkR(), date: '2026-11-12' }, J(R1, '2026-11-12'));
    app.settings.leadDdHalf = true; app.settings.leadDdAt = '2026-11-13';
    o.lateOn = plan({ clk: clkR(), date: '2026-11-12' }, J(R1, '2026-11-12'));
    o.lateOn2 = plan({ clk: clkR(), date: '2026-11-26' }, J(R2, '2026-11-26'));
    delete app.settings.leadDdAt; delete app.settings.leadDdHalf;
    // 非換倉日預告:11/12 那次全額,11/16 狀態變成收一半 → 下次換倉會收(next trim);狀態不是今天的 / 起用日之前 → ⛔ 預告
    const RP = [{ d: '2026-11-12', b: 'A', W: 1, bear: 0 }];
    o.preview = plan({ clk: clkW(6), date: '2026-11-16' }, J(RP, '2026-11-16', 1));
    o.previewOld = plan({ clk: clkW(6), date: '2026-11-16' }, J(RP, '2026-11-13', 1));
    o.previewPre = plan({ clk: clkW(3), date: '2026-11-09' }, J(R1.slice(0, 1), '2026-11-09', 1));
    o.previewHalf = plan({ clk: clkW(6), date: '2026-11-16' }, J([{ d: '2026-11-12', b: 'A', W: 0.5, bear: 0 }], '2026-11-16', 0));
    const RB = [{ d: '2026-11-12', b: 'A', W: 0.5, bear: 0 }, { d: '2026-11-18', b: 'B', W: 1, bear: 0 }];
    o.bookB = plan({ clk: clkR('B'), date: '2026-11-18' }, J(RB, '2026-11-18', 0));
    // ③ _leadActs:前 10 名 = 1001..1010、買進 = 1001..1005;手上 1001、1003(續抱)、1011(掉出)
    const all = new Map(); for (let i = 1; i <= 12; i++) all.set(String(1000 + i), { sym: String(1000 + i), rank: i, c: 50 + i });
    const L = { all, buy: [1, 2, 3, 4, 5].map(i => ({ sym: String(1000 + i) })), date: '2026-11-12' };
    const mine = ['1001', '1003', '1011'];
    app.settings.leadBooks = 1;
    app._leadDdData = J(R1, '2026-11-12');
    app._leadCtx = { clk: clkR(), date: '2026-11-12', snap: {} };
    o.aOn = app._leadActs(L, false, mine, mine);
    o.aBear = app._leadActs(L, true, mine, mine);
    app._leadDdData = J(R4, '2026-12-24', 0); app._leadCtx = { clk: clkR(), date: '2026-12-24', snap: {} };
    o.aTop = app._leadActs({ ...L, date: '2026-12-24' }, false, mine, mine);
    o.aTopBear = app._leadActs({ ...L, date: '2026-12-24' }, true, mine, mine);
    app.settings.leadDdHalf = false; app._leadDdData = J(R1, '2026-11-12'); app._leadCtx = { clk: clkR(), date: '2026-11-12', snap: {} };
    o.aOff = app._leadActs(L, false, mine, mine);
    delete app.settings.leadDdHalf;
    // ④ 決策台(換倉日收盤後 = eve)
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent; };
    app._tpeMinutes = () => ({ ymd: '2026-11-12', wd: 'Thu', min: 18 * 60 });
    app._mktClosedToday = () => false;
    app._deckQuoteOf = s => ({ p: 100, chg: 0 });
    app.inventory = [{ symbol: '1001', shares: 3, cost: 90 }, { symbol: '1003', shares: 1.5, cost: 90 }, { symbol: '1011', shares: 2, cost: 90 }];
    app.settings.accountSize = 5000000;
    app._leadTiming = () => 'split';
    const held = mine.map(s => ({ sym: s, mine: true }));
    const todo = () => app._deckTodoLead({ clk: app._leadCtx.clk, bearOn: false, L, held, H: 10, inv: mine });
    app._leadDdData = J(R1, '2026-11-12'); app._leadCtx = { clk: clkR(), date: '2026-11-12', snap: {} };
    o.dTrimH = todo(); o.dTrim = txt(o.dTrimH);
    o.slotOk = app._leadSlot();
    app.settings.leadDdHalf = false;
    o.dOffH = todo(); o.dOff = txt(o.dOffH);
    delete app.settings.leadDdHalf;
    app._leadDdData = null;
    o.dNoH = todo();
    app._leadDdData = J(R1.slice(0, 1), '2026-11-06');
    o.dStaleH = todo();
    // ④b 💵 V82.2.6(11/13 截圖):賣一半拿回來的錢 —— 金額只要持股市值就算得出來、「今天要買股票的錢先扣掉」只在今天真的有買時才講
    app._leadDdData = J(R1, '2026-11-12'); app._leadCtx = { clk: clkR(), date: '2026-11-12', snap: {} };
    const oPark = app._park; app._park = () => true;
    try {
        o.pkBuyH = todo();                                                                                          // 有買 → 括號要在(決定性對照)
        o.pkBearH = app._deckTodoLead({ clk: app._leadCtx.clk, bearOn: true, L, held, H: 10, inv: mine });     // 空頭不買 → ⛔ 括號
        app.settings.accountSize = 100000;                                                                          // 10 萬 < 手上 65 萬 → 過期
        o.pkStale = app._leadSlot().st;
        o.pkStaleH = todo();
        app.settings.accountSize = 5000000;
        // ④c ⏰ 換倉那天過了 10:00、還沒收盤 → 賣的那幾行改口(= auto_trade 開盤沒賣成的尾盤補賣);09:05 照舊(決定性對照)
        app._tpeMinutes = () => ({ ymd: '2026-11-13', wd: 'Fri', min: 10 * 60 + 30 }); o.lateH = todo(); o.latePh = app._leadPhase(app._leadCtx.clk, '2026-11-12').ph;
        app._tpeMinutes = () => ({ ymd: '2026-11-13', wd: 'Fri', min: 10 * 60 }); o.at10H = todo();
        app._tpeMinutes = () => ({ ymd: '2026-11-13', wd: 'Fri', min: 9 * 60 + 5 }); o.earlyH = todo();
        app._leadTiming = () => 'open';
        app._tpeMinutes = () => ({ ymd: '2026-11-13', wd: 'Fri', min: 10 * 60 + 30 }); o.lateOpenH = todo();
        app._leadTiming = () => 'split';
    } finally { app._park = oPark; app._tpeMinutes = () => ({ ymd: '2026-11-12', wd: 'Thu', min: 18 * 60 }); }
    return o;
});

const R5 = await page.evaluate(async () => {
    const o = {};
    const rule = { th: 20, lo: 0.5, rec: 'hi', top: 1, live: '2026-11-12', from: '2024-07-01' };
    const J = (rot, data_date, def = 1) => ({ data_date, def, since: def ? '2026-07-24' : null, rule, rot });
    const clkR = () => ({ started: true, day: 21, isRebal: true, left: 0, book: 'A', books: 1 });
    const all = new Map(); for (let i = 1; i <= 12; i++) all.set(String(1000 + i), { sym: String(1000 + i), rank: i, c: 50 + i });
    const L = { all, buy: [1, 2, 3, 4, 5].map(i => ({ sym: String(1000 + i) })), date: '2026-11-12' };
    const fired = []; app._fireAlert = (t, b) => { fired.push({ t, b }); };
    app._isLead = () => true;
    app._leadPhase = () => ({ ph: 'eve', when: '明天', leftNow: null });
    const run = async (data, held, invAll) => {
        app._leadDdData = data; app._loadLeadDd = async () => app._leadDdData;
        const X = { clk: clkR(), date: '2026-11-12', L, bearOn: false, snap: {} };
        app._leadCtx = X; app._leadCtxLoad = async () => X;
        app._leaderMine = () => new Set(held);
        app.inventory = invAll.map(s => ({ symbol: s, shares: 1, cost: 50 }));
        await app._leadRebalAlert();
    };
    const R1 = [{ d: '2026-10-29', b: 'A', W: 0.5, bear: 0 }, { d: '2026-11-12', b: 'A', W: 0.5, bear: 0 }];
    // (a) 只有續抱 + 收一半 → 一則,寫收一半
    localStorage.removeItem('leadRebalFired'); localStorage.removeItem('leadDdFired'); fired.length = 0;
    await run(J(R1, '2026-11-12'), ['1001', '1002', '1003', '1004', '1005'], ['1001', '1002', '1003', '1004', '1005']);
    o.a = fired.slice();
    // (b) 只有續抱、狀態還沒到 → ⛔ 不發也⛔ 不蓋章;狀態到了 → 發收一半那一則
    localStorage.removeItem('leadRebalFired'); localStorage.removeItem('leadDdFired'); fired.length = 0;
    await run(J(R1.slice(0, 1), '2026-11-06'), ['1001', '1002', '1003', '1004', '1005'], ['1001', '1002', '1003', '1004', '1005']);
    o.b1 = { n: fired.length, stamp: localStorage.getItem('leadRebalFired') };
    await run(J(R1, '2026-11-12'), ['1001', '1002', '1003', '1004', '1005'], ['1001', '1002', '1003', '1004', '1005']);
    o.b2 = fired.slice();
    // (c) 有換倉(1011 掉出、要買 1005)、狀態還沒到 → 先發換倉;狀態到了 → 另外補一則收一半;再跑一次 ⛔ 重複
    localStorage.removeItem('leadRebalFired'); localStorage.removeItem('leadDdFired'); fired.length = 0;
    await run(J(R1.slice(0, 1), '2026-11-06'), ['1001', '1002', '1003', '1004', '1011'], ['1001', '1002', '1003', '1004', '1011']);
    o.c1 = fired.slice();
    await run(J(R1, '2026-11-12'), ['1001', '1002', '1003', '1004', '1011'], ['1001', '1002', '1003', '1004', '1011']);
    await run(J(R1, '2026-11-12'), ['1001', '1002', '1003', '1004', '1011'], ['1001', '1002', '1003', '1004', '1011']);
    o.c2 = fired.slice();
    // (d) 關掉 → 只有續抱 → 沒事,蓋章
    localStorage.removeItem('leadRebalFired'); localStorage.removeItem('leadDdFired'); fired.length = 0;
    app.settings.leadDdHalf = false;
    await run(J(R1, '2026-11-12'), ['1001', '1002', '1003', '1004', '1005'], ['1001', '1002', '1003', '1004', '1005']);
    o.d = { n: fired.length, stamp: localStorage.getItem('leadRebalFired') };
    delete app.settings.leadDdHalf;
    // ⑥ 開盤提醒(act):賣一半開盤、補回 13:25
    localStorage.removeItem('leadDayOpen'); localStorage.removeItem('leadDay1320'); fired.length = 0;
    app._leadPhase = () => ({ ph: 'act', when: '今天', past: false, leftNow: null });
    app._tpeMinutes = () => ({ ymd: '2026-11-13', wd: 'Fri', min: 9 * 60 + 15 });
    app._leadTiming = () => 'split';
    app._loadLiveQuotes = async () => {}; app._liveQuotes = {};
    app._leadQuoteOf = async s => ({ p: 100, o: 100, prev: 100, gap: s === '1002' ? -4 : 0 });
    await run(J(R1, '2026-11-12'), ['1001', '1002', '1003', '1004', '1011'], ['1001', '1002', '1003', '1004', '1011']);
    await app._leadDayPulse();
    o.open = fired.filter(f => /開盤要做的事/.test(f.t));
    // ⑥b ⏰ V82.2.6 過了 10:00 才第一次跳 → 標題「還沒做的事」、賣的改尾盤(⛔「現在開盤賣」)
    localStorage.removeItem('leadDayOpen'); localStorage.removeItem('leadDay1320'); fired.length = 0;
    app._tpeMinutes = () => ({ ymd: '2026-11-13', wd: 'Fri', min: 10 * 60 + 30 });
    await app._leadDayPulse();
    o.openLate = fired.slice();
    localStorage.removeItem('leadDayOpen');
    const R4 = R1.concat([{ d: '2026-11-26', b: 'A', W: 1, bear: 0 }]);
    localStorage.removeItem('leadDayOpen'); localStorage.removeItem('leadDay1320'); fired.length = 0;
    app._leadDdData = J(R4, '2026-11-26', 0);
    const X2 = { clk: clkR(), date: '2026-11-26', L: { ...L, date: '2026-11-26' }, bearOn: false, snap: {} };
    app._leadCtx = X2; app._leadCtxLoad = async () => X2;
    app._tpeMinutes = () => ({ ymd: '2026-11-27', wd: 'Fri', min: 13 * 60 + 21 });
    await app._leadDayPulse();
    o.top1320 = fired.slice();
    return o;
});

// ② _leadDdPlan
const P = R;
ok('② 收一半那次換倉:mode trim、這次 0.5、上次 1(起用日之前的換倉一律全額)', P.trim.mode === 'trim' && P.trim.W === 0.5 && P.trim.WP === 1 && P.trim.on, JSON.stringify(P.trim));
ok('② 收一半中的下一次換倉:⛔ 再收(mode 空、0.5 / 0.5)', P.still.mode === '' && P.still.W === 0.5 && P.still.WP === 0.5, JSON.stringify(P.still));
ok('② 回到最高點但大盤嚴格空頭:先不補(block bear、照 0.5)', P.bear.mode === '' && P.bear.block === 'bear' && P.bear.W === 0.5, JSON.stringify(P.bear));
ok('② 回到最高點、不是空頭:補回(top、1 / 0.5)', P.top.mode === 'top' && P.top.W === 1 && P.top.WP === 0.5, JSON.stringify(P.top));
ok('② 狀態還沒更新到這次換倉:err stale、照上一次(1 / 1)、⛔ 收', P.stale.err === 'stale' && P.stale.W === 1 && P.stale.mode === '', JSON.stringify(P.stale));
ok('② 狀態還沒更新、上一次是一半 → 照一半(0.5)', P.staleHalf.err === 'stale' && P.staleHalf.W === 0.5, JSON.stringify(P.staleHalf));
ok('② 讀不到:err nodata、全額(⛔ 跟「沒在收」混在一起 —— 有 err 欄)', P.nodata.err === 'nodata' && P.nodata.W === 1, JSON.stringify(P.nodata));
ok('② 關掉:on false、1 / 1、⛔ 任何動作', P.off.on === false && P.off.W === 1 && P.off.WP === 1 && !P.off.mode, JSON.stringify(P.off));
ok('② 你 11/13 才打開:11/12 那次照全額;下一次(11/26)才收', P.lateOn.W === 1 && P.lateOn.mode === '' && P.lateOn2.mode === 'trim' && P.lateOn2.W === 0.5, JSON.stringify([P.lateOn, P.lateOn2]));
ok('② 非換倉日:照最新狀態預告「下次換倉會收一半」(next trim、現在照全額);回到最高點 → 預告補回(next top)',
    P.preview.next === 'trim' && P.preview.W === 1 && P.previewHalf.next === 'top' && P.previewHalf.W === 0.5, JSON.stringify([P.preview, P.previewHalf]));
ok('② 非換倉日預告:狀態不是今天的 / 起用日之前 → ⛔ 預告(next 空)', P.previewOld.next === '' && P.previewPre.next === '', JSON.stringify([P.previewOld, P.previewPre]));
ok('② 兩本帳各算各的:乙帳第一次換倉、想要全額 → 1 / 1(⛔ 被甲帳的收一半帶走)', P.bookB.W === 1 && P.bookB.WP === 1 && P.bookB.mode === '', JSON.stringify(P.bookB));

// ③ _leadActs
const on = P.aOn, off = P.aOff;
ok('③ 收一半:trim = 留著的(1001 / 1003),⛔ 含要賣的 1011;topup 空', JSON.stringify(on.trim) === JSON.stringify(['1001', '1003']) && !on.topup.length && on.sell.includes('1011'), JSON.stringify(on));
ok('③ 空頭那次:賣一半照做(trim 照舊)、不買', JSON.stringify(P.aBear.trim) === JSON.stringify(['1001', '1003']) && !P.aBear.buy.length, JSON.stringify(P.aBear));
ok('③ 回到最高點:topup = 留著的;空頭那次 topup 空', JSON.stringify(P.aTop.topup) === JSON.stringify(['1001', '1003']) && !P.aTopBear.topup.length, JSON.stringify([P.aTop.topup, P.aTopBear.topup]));
ok('③ ⭐ 決定性對照:關掉 → sell / keep / buy 跟開著逐欄相同,trim / topup 空',
    ['sell', 'keep', 'buy', 'half', 'waitOther'].every(k => JSON.stringify(on[k]) === JSON.stringify(off[k])) && !off.trim.length && !off.topup.length, JSON.stringify({ on, off }));

// ④ 決策台
const slot = P.slotOk && P.slotOk.slot;
ok('④ 收一半那次:寫出「跌 20% 收一半」+ 每檔要賣幾股(1001 持 3 張 → 賣 1,500 股・留 1,500 股)',
    /data-tododdhalf="trim"/.test(P.dTrimH) && /data-todotrim="1001"[^>]*>賣 <b[^>]*>1,500 股<\/b>・留 <span[^>]*>1,500 股/.test(P.dTrimH) && /跌 20% 收一半/.test(P.dTrim), P.dTrim);
ok('④ 新買的每檔只買一半:每檔金額 = 平常的一半(總資金 500 萬 ÷ 5 × 0.5 = 50 萬)、標「每檔只買一半」',
    slot === 1000000 && /每檔約 <b class="font-mono">50 萬<\/b>/.test(P.dTrimH) && /data-tododdslot="1"/.test(P.dTrimH) && /每檔只買一半/.test(P.dTrim), P.dTrimH.slice(0, 1500));
ok('④ 賣一半拿回來的錢有寫去處(0050 或現金)', /賣一半拿回來的錢/.test(P.dTrim), P.dTrim);
ok('④ ⭐ 決定性對照:關掉 → 一個 ✂️ 都沒有、每檔金額回到 100 萬', !/✂️|data-tododd|data-todotrim|每檔只買一半/.test(P.dOffH) && /每檔約 <b class="font-mono">100 萬<\/b>/.test(P.dOffH), P.dOff);
ok('④ 讀不到 / 沒更新要明講(⛔ 跟全額長得一樣)', /data-tododdhalf="nodata"/.test(P.dNoH) && /data-tododdhalf="stale"/.test(P.dStaleH), P.dNoH.slice(0, 300));
ok('④ 規則那一段有「跌 20% 收一半(開著)」+ 一鍵關掉', /data-leaddd="off"/.test(P.dTrimH) && !/data-leaddd="off"/.test(P.dOffH));
// ④b 💵 V82.2.6 賣一半拿回來的錢
const nowBox = h => String(h || '').split('data-todo="buy"')[0];
ok('④b 有買的那天 → 「停 0050(今天要買股票的錢先扣掉)」(決定性對照)', /停 0050<\/b>\(今天要買股票的錢先扣掉\)/.test(P.pkBuyH), nowBox(P.pkBuyH).slice(-600));
ok('④b 空頭不買那天 → ⛔「今天要買股票的錢先扣掉」(11/13 截圖)、賣一半照講', /賣一半拿回來的錢/.test(P.pkBearH) && !/今天要買股票的錢先扣掉/.test(P.pkBearH), nowBox(P.pkBearH).slice(-600));
ok('④b 帳戶總資金過期(10 萬 < 手上 65 萬)→ 賣一半拿回來的錢照算(1001 30 萬 + 1003 15 萬 的一半 = 22.5 萬)、另外叫你改總資金',
    P.pkStale === 'stale' && /賣一半拿回來的錢約 <b class="font-mono">22\.5 萬<\/b>/.test(P.pkStaleH) && /比手上的股票 \+ 0050/.test(P.pkStaleH), nowBox(P.pkStaleH).slice(-700));
// ④c ⏰ 10:00 以後改口
ok('④c 換倉那天 10:30 → 賣 / 賣一半那兩行改成「13:00 起尾盤賣(開盤時段已過…)」、⛔「開盤賣」',
    P.latePh === 'act' && (nowBox(P.lateH).match(/data-todolate="sell"/g) || []).length === 2 && /13:00<\/span> 起尾盤賣/.test(P.lateH) && !/開盤賣/.test(nowBox(P.lateH)), nowBox(P.lateH).slice(0, 900));
ok('④c ⭐ 決定性對照:10:00 那一分鐘(= auto_trade 還在時段內)/ 09:05 → 照舊「開盤賣」、⛔ data-todolate',
    !/data-todolate/.test(P.at10H) && /開盤賣/.test(nowBox(P.at10H)) && !/data-todolate/.test(P.earlyH) && /開盤賣/.test(nowBox(P.earlyH)), nowBox(P.earlyH).slice(0, 600));
ok('④c 全部開盤模式 10:30 → 買的那一行也改口(還沒買的等下一次換倉;自動下單錯過開盤也是跳過)、split 的 13:25 買照舊',
    /data-todolate="buy"/.test(P.lateOpenH) && !/data-todolate="buy"/.test(P.lateH) && /13:25<\/span> 買/.test(nowBox(P.lateH)), nowBox(P.lateOpenH).slice(0, 900));

// ⑤ 換倉提醒
const a5 = R5;
ok('⑤ 只有續抱 + 收一半 → 照發一則,寫「跌 20% 收一半」「賣一半」', a5.a.length === 1 && /跌 20% 收一半/.test(a5.a[0].b) && /賣一半/.test(a5.a[0].b), JSON.stringify(a5.a));
ok('⑤ 狀態還沒到、沒有別的事 → ⛔ 發也⛔ 蓋章;狀態到了 → 發收一半', a5.b1.n === 0 && !a5.b1.stamp && a5.b2.length === 1 && /跌 20% 收一半/.test(a5.b2[0].b), JSON.stringify(a5));
ok('⑤ 先發了換倉、狀態後到 → 補一則收一半(一天一則,⛔ 重複)',
    a5.c1.length === 1 && !/賣一半/.test(a5.c1[0].b) && /狀態還沒更新/.test(a5.c1[0].b) && a5.c2.length === 2 && /跌 20% 收一半/.test(a5.c2[1].t) && /每檔賣一半/.test(a5.c2[1].b), JSON.stringify(a5.c2));
ok('⑤ ⭐ 決定性對照:關掉 → 只有續抱 = 沒事,不發、蓋章', a5.d.n === 0 && !!a5.d.stamp, JSON.stringify(a5.d));
// ⑥ 開盤提醒
const op = (a5.open[0] || {}).b || '';
ok('⑥ 開盤提醒:賣一半跟賣出同一個時段(現在開盤賣一半 / 開盤跌 3% 以上等到 09:30~10:00)、新買的寫每檔只買一半',
    /現在開盤賣一半/.test(op) && /等到 09:30~10:00 再賣一半/.test(op) && /每檔只買一半/.test(op), op);
ok('⑥ 13:20 那一則:補回跟買進同一個時段(13:25 補回)', a5.top1320.some(f => /13:25 補回/.test(f.b)), JSON.stringify(a5.top1320));
const ol = a5.openLate || [], olB = ol.map(f => f.b).join('\n');
ok('⑥b 過了 10:00 才第一次跳 → 標題「還沒做的事」、賣 / 賣一半寫「開盤時段已過 → 13:00 起尾盤」、⛔「現在開盤…」、13:25 買照舊',
    ol.length === 1 && /還沒做的事/.test(ol[0].t) && /開盤時段已過 → 還沒賣的 13:00 起尾盤賣:/.test(olB) && /開盤時段已過 → 還沒賣一半的 13:00 起尾盤賣一半:/.test(olB)
    && !/現在開盤/.test(olB) && /下午 13:25 再買/.test(olB), JSON.stringify(ol));

// ⑦ 設定 + ⑧ Telegram / 策略變更 + ⑨ 不存 dd%
const R7 = await page.evaluate(() => {
    const o = {};
    app.settings = app.settings || {}; delete app.settings.leadDdHalf; delete app.settings.leadDdAt;
    app._strat = () => 'lead'; app.settings.stratUnlock = true;
    o.advLead = app._advBoxHtml('');
    o.showDef = app._deckShow().ddhalf;
    const _set = app.setLeadDdHalf.bind(app);
    app.toggleDeckShow('ddhalf', false); o.afterOff = app.settings.leadDdHalf; o.showOff = app._deckShow().ddhalf; o.stored = !!(app.settings.deckShow && 'ddhalf' in app.settings.deckShow);
    o.payOff = app.telegramCloud && app.telegramCloud._buildPayload ? app.telegramCloud._buildPayload().settings : null;
    app.toggleDeckShow('ddhalf', true); o.afterOn = app.settings.leadDdHalf; o.at = app.settings.leadDdAt;
    o.payOn = app.telegramCloud && app.telegramCloud._buildPayload ? app.telegramCloud._buildPayload().settings : null;
    app.settings.stratUnlock = false; o.showLocked = app._deckShow().ddhalf;
    app._strat = () => 'gene'; app.settings.stratUnlock = true;
    o.advGene = app._advBoxHtml(''); o.showGene = app._deckShow().ddhalf;
    const c = (app._STRAT_CHANGES || []).find(x => x.backDd);
    o.chg = c ? { v: c.v, lead: !!c.lead, first: app._STRAT_CHANGES[0] === c } : null;
    // 「換回舊的」那顆:照 backJs 做 → 關掉
    app.settings.leadDdHalf = true;
    try { app._showStratChange(c); const b = [...document.querySelectorAll('#richHelpModal button')].find(x => /換回舊的/.test(x.textContent)); b && b.click(); } catch (e) { o.err = String(e); }
    o.afterBack = app.settings.leadDdHalf;
    document.getElementById('richHelpModal')?.classList.add('hidden');
    return o;
});
ok('⑦ 🔓 進階功能:選 👑 + 解鎖才列 ddhalf、預設勾;選 🔥 不列;沒解鎖 → false', /data-advk="ddhalf"/.test(R7.advLead) && R7.showDef === true && !/data-advk="ddhalf"/.test(R7.advGene) && R7.showGene === false && R7.showLocked === false, R7.advLead.slice(0, 200));
ok('⑦ 取消 = settings.leadDdHalf false、打開 = true + 記打開那天(⛔ 存進 deckShow)', R7.afterOff === false && R7.showOff === false && R7.afterOn === true && /^\d{4}-\d\d-\d\d$/.test(R7.at || '') && !R7.stored, JSON.stringify(R7));
ok('⑧ Telegram 同步送 leadDdHalf / leadDdAt(關掉 → false、打開 → true + 日期)', R7.payOff && R7.payOff.leadDdHalf === false && R7.payOn && R7.payOn.leadDdHalf === true && R7.payOn.leadDdAt === R7.at, JSON.stringify([R7.payOff && R7.payOff.leadDdHalf, R7.payOn && R7.payOn.leadDdHalf, R7.payOn && R7.payOn.leadDdAt]));
ok('⑧ 策略變更:最新那一筆就是這條、只給 👑、「換回舊的」= 關掉', R7.chg && R7.chg.v === 'V82.0.7' && R7.chg.lead && R7.chg.first && R7.afterBack === false, JSON.stringify(R7));
const ldd = SRC.slice(SRC.indexOf('    async _loadLeadDd(force) {'), SRC.indexOf('    _ddWaChain(rots, top, live) {'));
ok('⑨ ⛔ App 不存「離最高點幾 %」:只留 data_date / def / since / rule / rot', /const keep = \{ data_date: J\.data_date, def: J\.def, since: J\.since, rule: J\.rule, rot: J\.rot \};/.test(ldd) && !/J\.now|J\.peak|\.dd\b/.test(ldd), ldd.slice(0, 400));

// ⑨ 390px 不橫向溢出
await page.evaluate(rwdShim);
const ov = await page.evaluate(h => {
    const box = document.createElement('div'); box.style.cssText = 'width:358px;position:absolute;left:16px;top:0;'; box.innerHTML = h; document.body.appendChild(box);
    const R0 = box.getBoundingClientRect(); let worst = 0, who = '';
    for (const e of box.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && r.right - R0.right > worst) { worst = r.right - R0.right; who = e.outerHTML.slice(0, 120); } }
    box.remove(); return { worst, who, w: R0.width };
}, R.dTrimH);
ok('⑨ 390px:決策台收一半那一段 ⛔ 超出容器', ov.w >= 350 && ov.worst <= 2, JSON.stringify(ov));

// ⑩ Worker(Telegram)== App:同一條鏈、同一組換倉日答案、trim / topup 同一份;沒傳設定 = 舊行為(決定性對照)
let WK = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
if (INJ === 'wtrim') { const W0 = WK; WK = WK.replace("const trim = ddMode === 'trim' ? kHeld.slice() : []", 'const trim = []'); if (W0 === WK) { console.log('❌ 注入沒有注進去'); process.exit(1); } }
if (INJ === 'wbear') { const W0 = WK; WK = WK.replace('        else if (r.W > wa && (!top || !r.bear)) wa = r.W;\n        cur = wa;', '        else if (r.W > wa) wa = r.W;\n        cur = wa;'); if (W0 === WK) { console.log('❌ 注入沒有注進去'); process.exit(1); } }
const tmpW = path.join(ROOT, 'scripts', '.tmp_worker_leaddd.mjs'); fs.writeFileSync(tmpW, WK);
const M = await import('file://' + tmpW + '?t=' + Date.now());
try { fs.unlinkSync(tmpW); } catch (_) {}
ok('⑩ worker `LEAD_DD_LIVE` == lib_leaddd', M.LEAD_DD_LIVE === LEAD_DD.live, M.LEAD_DD_LIVE);
const badW = cases.findIndex(c => JSON.stringify(c.want) !== JSON.stringify(M.leadDdChain(c.rots, c.top, c.live).map(r => r.wa)));
ok('⑩ worker `leadDdChain` == lib `waChain`(同 300 組)', badW < 0, badW >= 0 ? JSON.stringify(cases[badW]) : '');
const rule = { th: 20, lo: 0.5, rec: 'hi', top: 1, live: '2026-11-12' };
const Jw = (rot, data_date, def = 1) => ({ data_date, def, since: '2026-07-24', rule, rot });
const R1 = [{ d: '2026-10-29', b: 'A', W: 0.5, bear: 0 }, { d: '2026-11-12', b: 'A', W: 0.5, bear: 0 }];
const R3 = R1.concat([{ d: '2026-11-26', b: 'A', W: 0.5, bear: 0 }, { d: '2026-12-10', b: 'A', W: 1, bear: 1 }]);
const R4 = R3.concat([{ d: '2026-12-24', b: 'A', W: 1, bear: 0 }]);
const pick = o => o ? JSON.stringify({ on: o.on, W: o.W, WP: o.WP, mode: o.mode || '', block: o.block || null, err: o.err || null }) : 'null';
const wTrim = M.leadDdPlan(Jw(R1, '2026-11-12'), 'A', '2026-11-12', {}), wBear = M.leadDdPlan(Jw(R3, '2026-12-10', 0), 'A', '2026-12-10', {}), wTop = M.leadDdPlan(Jw(R4, '2026-12-24', 0), 'A', '2026-12-24', {});
const wStale = M.leadDdPlan(Jw(R1.slice(0, 1), '2026-11-06'), 'A', '2026-11-12', {}), wNo = M.leadDdPlan(null, 'A', '2026-11-12', {}), wOff = M.leadDdPlan(Jw(R1, '2026-11-12'), 'A', '2026-11-12', { leadDdHalf: false });
const wLate = M.leadDdPlan(Jw(R1, '2026-11-12'), 'A', '2026-11-12', { leadDdAt: '2026-11-13' });
ok('⑩ worker `leadDdPlan` == App `_leadDdPlan`(收一半 / 空頭先不補 / 補回 / 沒更新 / 讀不到 / 關掉 / 晚打開)',
    pick(wTrim) === pick(P.trim) && pick(wBear) === pick(P.bear) && pick(wTop) === pick(P.top) && pick(wStale) === pick(P.stale) && pick(wNo) === pick(P.nodata)
    && JSON.stringify([wOff.on, wOff.W, wOff.WP]) === JSON.stringify([P.off.on, P.off.W, P.off.WP]) && pick(wLate) === pick(P.lateOn),
    JSON.stringify({ wTrim: pick(wTrim), app: pick(P.trim), wBear: pick(wBear), appB: pick(P.bear), wTop: pick(wTop), wStale: pick(wStale), appS: pick(P.stale), wNo: pick(wNo), appN: pick(P.nodata), wLate: pick(wLate), appL: pick(P.lateOn) }));
const top10 = Array.from({ length: 10 }, (_, i) => String(1001 + i)), buy5 = ['1001', '1002', '1003', '1004', '1005'];
const wA = M.leadActs(['1001', '1003', '1011'], top10, buy5, false, null, null, 'trim'), wA0 = M.leadActs(['1001', '1003', '1011'], top10, buy5, false, null, null);
ok('⑩ worker `leadActs` trim == App(1001 / 1003);沒傳 = 舊行為(trim 空、其他逐欄相同)',
    JSON.stringify(wA.trim) === JSON.stringify(P.aOn.trim) && !wA0.trim.length && ['sell', 'keep', 'buy'].every(k => JSON.stringify(wA[k]) === JSON.stringify(wA0[k])), JSON.stringify({ wA, wA0 }));
const st = { date: '2026-11-12', book: 'A', top: top10, topOld: top10, buy: buy5, buyOld: buy5, bear: false, kOwn: null, oOwn: null, dd: Jw(R1, '2026-11-12') };
const q = new Map(['1001', '1002', '1003', '1004', '1005', '1011'].map(s => [s, { z: 100, y: 100, o: s === '1003' ? 96 : 100 }]));
const lNew = M.leadDayLines(st, ['1001', '1003', '1011'], true, q, 'open', false, s => s, {});
const lOld = M.leadDayLines(st, ['1001', '1003', '1011'], true, q, 'open', false, s => s);
const lOff = M.leadDayLines(st, ['1001', '1003', '1011'], true, q, 'open', false, s => s, { leadDdHalf: false });
ok('⑩ worker 開盤那一則:賣一半跟賣出同一個時段(1001 現在賣一半、1003 開盤跌 4% → 等到 09:30~10:00)、新買的每檔只買一半',
    lNew.some(x => /現在開盤賣一半:1001/.test(x)) && lNew.some(x => /等到 09:30~10:00 再賣一半:1003/.test(x)) && lNew.some(x => /每檔只買一半/.test(x)), lNew.join(' | '));
ok('⑩ ⭐ 決定性對照:沒傳設定 / 關掉 → 一個 ✂️ 都沒有', !lOld.join('').includes('✂️') && JSON.stringify(lOld) === JSON.stringify(lOff), JSON.stringify({ lOld, lOff }));
ok('⑩ worker 收 leadDdHalf(預設開)/ leadDdAt(只收日期)', /leadDdHalf: payload\.settings\.leadDdHalf !== false,/.test(WK) && /leadDdAt: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(String\(payload\.settings\.leadDdAt/.test(WK));
const ddLnSrc = WK.slice(WK.indexOf('export function leadDdLines('), WK.indexOf('export function leadDayLines('));
ok('⑩ ⛔ Telegram 不印「離最高點幾 %」(收一半那幾行沒有讀 now / peak / dd)', ddLnSrc.length > 200 && !/\.now\b|\.peak\b|\.dd\b/.test(ddLnSrc), ddLnSrc.slice(0, 200));

ok('無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(`\n${fails.length ? '❌' : '✅'} LEADDD ${fails.length ? fails.length + ' 條失敗' : '全部通過'}`);
process.exit(fails.length ? 1 : 0);
