#!/usr/bin/env node
/**
 * ⏰ V79.1.5 👑 換倉節拍「今天 / 明天」+ 決策台上色 + 提前列名單 + 開盤提醒 + 硬停損彈窗 守門
 *   ① `_leadPhase`:換倉日收盤後 = 明天 / 週五 = 下週一;買賣那天白天(採礦還沒更新)= 今天;換倉日當天 = rebalToday;其餘 leftNow 從今天算
 *   ② 決策台「今天要做的事」:買賣那天寫「今天」⛔ 不寫「明天」;今天要動的那行有琥珀左色條;⛔ 不用 🔴🟢;
 *      每天都列「現在會買」名單 —— ⭐ 決定性對照:名單倒過來,畫面跟著倒
 *   ③ 硬停損提醒:價位 = `_unifiedExitPlan().stopFinal`(⭐ 決定性對照:買進當天最低 < 成本 −5% → 價位跟著變);文案講尾盤、⛔ 沒有「朱」;
 *      盤中那支有排除 👑 持股
 *   ④ 連續技用彈窗同一個即時價(⛔ 同一個視窗不可兩個現價)
 *   ⑤ `_leadDayPulse`:買賣那天 09:05 一則、13:21 一則,同一個時點不重跳,非買賣日不跳
 *   ⑥ 提醒分類:「13:25」⛔ 不可被 ⚡ 當沖吃掉(那一類關得掉);沒選 👑 時設定清單看不到
 *   ⑦ worker:leadOwnedFrom(名單外的持股 ⛔ 不算 👑)/ leadDayLines / leadTiming 有同步也有收
 * 注入:INJECT=tomorrow(_leadPhase 一律回明天)/ c95(硬停損寫死 ×0.95)/ nomine(盤中硬停損不排除 👑)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'tomorrow') SRC = SRC.replace("if (clk.isRebal) return step ? { ph: 'act', when: '今天'", "if (clk.isRebal) return false ? { ph: 'act', when: '今天'");
if (INJ === 'c95') SRC = SRC.replace("if (plan && plan.stopFinal > 0) return { px: +plan.stopFinal,", "if (false) return { px: +plan.stopFinal,");
if (INJ === 'nomine') SRC = SRC.replace("if (entryCost && !this._leaderMine().has(String(sym))) {", "if (entryCost) {");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_leadday.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leadPhase === 'function' && typeof app._deckTodoLead === 'function', null, { timeout: 60000 });

const R = await page.evaluate(async () => {
    const o = {};
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent; };
    const T = (ymd, wd, min) => { app._tpeMinutes = () => ({ ymd, wd, min }); };
    // ① phase(10/08 週四是換倉日)
    const reb = { started: true, day: 11, isRebal: true, left: 0 };
    T('2026-10-08', 'Thu', 18 * 60); o.eve = app._leadPhase(reb, '2026-10-08');
    T('2026-10-09', 'Fri', 10 * 60); o.act = app._leadPhase(reb, '2026-10-08');
    T('2026-10-09', 'Fri', 14 * 60); o.actPast = app._leadPhase(reb, '2026-10-08');
    T('2026-10-09', 'Fri', 18 * 60); o.eveFri = app._leadPhase(reb, '2026-10-09');
    T('2026-10-10', 'Sat', 10 * 60); o.eveSat = app._leadPhase(reb, '2026-10-09');
    T('2026-10-09', 'Fri', 10 * 60); o.rebT = app._leadPhase({ started: true, day: 10, isRebal: false, left: 1 }, '2026-10-08');
    T('2026-10-09', 'Fri', 10 * 60); o.wait = app._leadPhase({ started: true, day: 7, isRebal: false, left: 4 }, '2026-10-08');
    // ② 決策台今天要做的事
    app.settings = app.settings || {}; delete app.settings.leadTiming;
    app.getStockName = s => ({ 2330: '台積電', 2454: '聯發科', 3008: '大立光', 2317: '鴻海' })[s] || s;
    app._liveQuote = s => ({ 2330: { p: 1450, c: 1.2 }, 2454: { p: 1300, c: -0.8 } })[s] || null;
    const mkL = buy => ({ buy: buy.map(sym => ({ sym })), all: new Map([['3008', { rank: 15, c: 2000, chg: -1 }]]), ranked: [], date: '2026-10-08' });
    const held = [{ sym: '3008', mine: true, keep: false }];
    T('2026-10-09', 'Fri', 10 * 60);
    o.todoAct = app._deckTodoLead({ clk: reb, bearOn: false, L: mkL(['2330', '2454']), held, H: 10 });
    T('2026-10-08', 'Thu', 18 * 60);
    o.todoEve = app._deckTodoLead({ clk: reb, bearOn: false, L: mkL(['2330', '2454']), held, H: 10 });
    T('2026-10-09', 'Fri', 10 * 60);
    const wclk = { started: true, day: 7, isRebal: false, left: 4 };
    o.todoWait = app._deckTodoLead({ clk: wclk, bearOn: false, L: mkL(['2330', '2454', '2317']), held: [], H: 10 });
    o.todoWaitRev = app._deckTodoLead({ clk: wclk, bearOn: false, L: mkL(['2317', '2454', '2330']), held: [], H: 10 });
    o.todoActTxt = txt(o.todoAct); o.todoEveTxt = txt(o.todoEve); o.todoWaitTxt = txt(o.todoWait); o.todoWaitRevTxt = txt(o.todoWaitRev);
    // ③ 硬停損
    const k = Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10), open: 100, high: 102, low: 98, close: 100, volume: 1000 }));
    k[40].low = 90;   // 買進當天最低 90 < 成本 100 × 0.95
    app._getInventory = () => [{ symbol: '5483', cost: 100, shares: 1, buyDate: k[40].date }];
    o.hsBuyday = app._hardStopOf(k, '5483', 100);
    app._getInventory = () => [{ symbol: '5483', cost: 100, shares: 1 }];
    o.hsNoDate = app._hardStopOf(k, '5483', 100);
    o.hsTxt = app._hardStopTxt(93, o.hsNoDate, true);
    o.stopSrc = (() => { const s = app._watchlistPulse.toString(); const i = s.indexOf("trigger('stop5'"); return s.slice(Math.max(0, i - 700), i + 120); })();
    // ④ 連續技現價 = 即時價
    app._isLead = () => false;
    app._livePx = { 5483: { p: 87.5, at: Date.now() } };
    try { const p = app._comboPlan('5483', k); o.comboPC = p ? p.pC : null; } catch (e) { o.comboPC = 'err ' + e.message; }
    // ⑤ 開盤提醒
    const fired = [];
    app._fireAlert = (t, b) => fired.push(t + '|' + b);
    app._isLead = () => true;
    app._leaderMine = () => new Set(['3008']);
    const X = { L: { ...mkL(['2330', '2454']), all: new Map() }, clk: reb, bearOn: false, date: '2026-10-08' };
    app._leadCtxLoad = async () => X;
    app._loadLiveQuotes = async () => {}; app._liveQuotes = {};
    app._leadQuoteOf = async s => ({ 3008: { p: 1900, o: 1900, prev: 2000, gap: -5 }, 2330: { p: 1450, o: 1440, prev: 1430, gap: 0.7 }, 2454: { p: 1300, o: 1250, prev: 1300, gap: -3.8 } })[s];
    for (const k2 of ['leadDayOpen', 'leadDay1320']) localStorage.removeItem(k2);
    T('2026-10-09', 'Fri', 9 * 60 + 5); await app._leadDayPulse(); o.f1 = fired.slice();
    await app._leadDayPulse(); o.f1b = fired.length;
    T('2026-10-09', 'Fri', 13 * 60 + 21); await app._leadDayPulse(); o.f2 = fired.slice(o.f1b);
    const n3 = fired.length;
    for (const k2 of ['leadDayOpen', 'leadDay1320']) localStorage.removeItem(k2);
    T('2026-10-08', 'Thu', 10 * 60); X.clk = { started: true, day: 10, isRebal: false, left: 1 }; X.date = '2026-10-07';
    await app._leadDayPulse(); o.fNon = fired.length - n3;
    // ⑥ 分類
    o.cat = app._alertCatOf('👑 換倉日・13:25 要買').k;
    o.catOpen = app._alertCatOf('👑 換倉日・開盤要做的事').k;
    o.catOn = app._alertCatOn('👑 換倉日・13:25 要買');
    o.urgent = app._isUrgentAlert('👑 換倉日・13:25 要買');
    app._isLead = () => false;
    const box = document.getElementById('alertCatList');
    if (box) { app._renderAlertCatList(); o.listNoLead = box.innerText.includes('換倉日'); app._isLead = () => true; app._renderAlertCatList(); o.listLead = box.innerText.includes('換倉日'); }
    return o;
});

// ①
ok('① 換倉日收盤後 → eve / 明天', R.eve.ph === 'eve' && R.eve.when === '明天', JSON.stringify(R.eve));
ok('①b ⭐ 買賣那天白天(採礦還沒更新)→ act / 今天(⛔ 不再寫明天)', R.act.ph === 'act' && R.act.when === '今天' && !R.act.past, JSON.stringify(R.act));
ok('①c 買賣那天 14:00 → 標已收盤', R.actPast.ph === 'act' && R.actPast.past === true, JSON.stringify(R.actPast));
ok('①d 週五換倉 / 週六 → 下週一', R.eveFri.when === '下週一' && R.eveSat.ph === 'eve' && R.eveSat.when === '下週一', JSON.stringify([R.eveFri, R.eveSat]));
ok('①e 今天就是換倉日(資料日是前一天)→ rebalToday、週五 → 下週一買賣', R.rebT.ph === 'rebalToday' && R.rebT.buyWhen === '下週一', JSON.stringify(R.rebT));
ok('①f 其他日子:剩幾天從今天算(資料日剩 4 → 今天剩 3)', R.wait.ph === 'wait' && R.wait.leftNow === 3, JSON.stringify(R.wait));
// ②
ok('② 買賣那天:寫「今天」、⛔ 沒有「明天」,賣大立光、買台積電 + 聯發科', /今天要做/.test(R.todoActTxt) && !/明天/.test(R.todoActTxt.split('🛒 怎麼買')[0]) && /今天\s*09:00\s*開盤賣:大立光/.test(R.todoActTxt) && /今天\s*13:25\s*買:台積電/.test(R.todoActTxt), R.todoActTxt);
ok('②b 換倉日收盤後:名單已定案 → 明天', /名單已定案/.test(R.todoEveTxt) && /明天\s*13:25\s*買:台積電/.test(R.todoEveTxt), R.todoEveTxt);
ok('②c 今天要動的那行有琥珀左色條 + 時間琥珀小框;⛔ 不用 🔴🟢', /data-todohot="1"/.test(R.todoAct) && /border-l-4 border-amber-500/.test(R.todoAct) && /data-todochip="1"/.test(R.todoAct) && !/[🔴🟢]/u.test(R.todoAct + R.todoWait), '');
ok('②d 平常日子也列「現在會買」+ 現價 + 會變', /現在會買:台積電 1450\.0 \+1\.2%/.test(R.todoWaitTxt) && /會變/.test(R.todoWaitTxt), R.todoWaitTxt);
const ordA = ['台積電', '聯發科', '鴻海'].map(n => R.todoWaitTxt.indexOf(n)), ordB = ['台積電', '聯發科', '鴻海'].map(n => R.todoWaitRevTxt.indexOf(n));
ok('②e ⭐ 決定性對照:名單倒過來,畫面跟著倒(⛔ 不另排一份)', ordA[0] < ordA[1] && ordA[1] < ordA[2] && ordB[2] < ordB[1] && ordB[1] < ordB[0], JSON.stringify([ordA, ordB]));
// ③
ok('③ 硬停損 = 買進當天最低(90,比成本 −5% 低)', R.hsBuyday && Math.abs(R.hsBuyday.px - 90) < 0.01, JSON.stringify(R.hsBuyday));
ok('③b ⭐ 決定性對照:沒填買進日 → 成本 −5% = 95', R.hsNoDate && Math.abs(R.hsNoDate.px - 95) < 0.01, JSON.stringify(R.hsNoDate));
ok('③c 文案:盤中只提醒、尾盤確認才賣;⛔ 沒有「朱」', /尾盤賣/.test(R.hsTxt) && /不用現在急賣/.test(R.hsTxt) && !/朱/.test(R.hsTxt), R.hsTxt);
ok('③d 盤中那支:讀 _hardStopOf、排除 👑 持股、⛔ 不寫死 ×0.95', /_hardStopOf\(/.test(R.stopSrc) && /_leaderMine\(\)\.has\(String\(sym\)\)/.test(R.stopSrc) && !/entryCost \* 0\.95/.test(R.stopSrc), R.stopSrc.slice(-400));
// ④
ok('④ 連續技現價 = 彈窗那個即時價(87.5,⛔ 不是 K 線快取的 100)', R.comboPC === 87.5, R.comboPC);
// ⑤
ok('⑤ 09:05 一則:大立光開盤跌 5% → 等到 09:30~10:00;聯發科開盤跌 3.8% → 現在買;台積電 → 13:25', R.f1.length === 1 && /09:30~10:00 再賣:大立光/.test(R.f1[0]) && /現在開盤買:聯發科/.test(R.f1[0]) && /13:25 再買:台積電/.test(R.f1[0]), JSON.stringify(R.f1));
ok('⑤b 同一個時點不重跳', R.f1b === 1, R.f1b);
ok('⑤c 13:21 一則「13:25 要買」只列還沒買的台積電(聯發科開盤已買)', R.f2.length === 1 && /13:25 要買/.test(R.f2[0]) && /台積電/.test(R.f2[0]) && !/聯發科/.test(R.f2[0]), JSON.stringify(R.f2));
ok('⑤d 非買賣日不跳', R.fNon === 0, R.fNon);
// ⑥
ok('⑥ 「13:25」⛔ 不可被當沖吃掉 → 👑 換倉日類、鎖住、會跳大視窗', R.cat === 'lead' && R.catOpen === 'lead' && R.catOn === true && R.urgent === true, JSON.stringify([R.cat, R.catOpen, R.catOn, R.urgent]));
ok('⑥b 沒選 👑 → 設定清單看不到「換倉日」;選了才有', R.listNoLead === false && R.listLead === true, JSON.stringify([R.listNoLead, R.listLead]));
// ⑦ worker
const W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const tmpW = path.join(ROOT, 'scripts', '.tmp_worker_leadday.mjs'); fs.writeFileSync(tmpW, W);
const M = await import(tmpW + '?t=' + Date.now());
const hist = { days: [{ d: '2026-09-24', lead: { rows: [{ s: '1111' }, { s: '2222' }] } }, { d: '2026-10-08', lead: { rows: [{ s: '3008' }, { s: '2330' }] } }] };
const own = M.leadOwnedFrom(hist, { reb: '2026-10-08', prev: '2026-09-24', isRebal: false });
const ownR = M.leadOwnedFrom(hist, { reb: '2026-10-08', prev: '2026-09-24', isRebal: true });
ok('⑦ worker:歸 👑 = 上次換倉名單;換倉日當天再加上上上次;讀不到 → null(⛔ 不猜)', own && own.has('3008') && !own.has('5483') && !own.has('1111') && ownR.has('1111') && M.leadOwnedFrom(null, { reb: 'x' }) === null, JSON.stringify([own && [...own], ownR && [...ownR]]));
const st = { top: ['3008x', '2330'], topOld: [], buy: ['2330', '2454'], buyOld: [], bear: false };
const q = new Map([['3008', { z: 1900, y: 2000, o: 1900 }], ['2454', { z: 1250, y: 1300, o: 1250 }], ['2330', { z: 1450, y: 1430, o: 1440 }]]);
const lo = M.leadDayLines(st, ['3008'], true, q, 'open', false, s => ({ 3008: '大立光', 2454: '聯發科', 2330: '台積電' })[s] || s);
const lb = M.leadDayLines(st, ['3008'], true, q, 'buy', false, s => ({ 2330: '台積電' })[s] || s);
ok('⑦b worker 開盤那則:開盤跌 ≥3% 的賣等 09:30~10:00、買現在買;13:15 那則只列 13:25 要買的', /09:30~10:00 再賣:大立光/.test(lo.join()) && /現在買:聯發科/.test(lo.join()) && /13:25 再買:台積電/.test(lo.join()) && lb.length === 1 && /13:25 買:台積電/.test(lb[0]) && !/2454|聯發科/.test(lb[0]), JSON.stringify([lo, lb]));
ok('⑦c leadTiming:App 有送、worker 有收(⛔ 以前兩邊都沒有)', /leadTiming:\s+app\._leadTiming/.test(ORIG) && /leadTiming: payload\.settings\.leadTiming === 'open'/.test(W), '');
ok('⑦d worker 盤中掃描讀 leadstate、名單外的持股照 🔥', /env\.KV\.get\('leadstate'\)/.test(W) && /_LEAD_OWNED\.has/.test(W) && /runLeaderDayPing\(env, leadSt\)/.test(W), '');
try { fs.unlinkSync(tmpW); } catch (_) {}
ok('ⓩ 無 pageerror', !errs.length, errs.slice(0, 2));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_leadday 全過');
process.exit(fails.length ? 1 : 0);
