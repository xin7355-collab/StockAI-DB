#!/usr/bin/env node
/**
 * 👑 V78.2.0 選 👑 的持股:總覽只講 👑 的規則,⛔ 不混進 🔥 的停損線 / 漲停隔天四條
 *   使用者(國巨 2327,選 👑+停車 0050):「漲停隔天那四條不用照做嗎?我看到你改策略直接請我賣出」
 *   查證:App 寫的是「等換倉日」(沒叫他今天賣),但 ① 徽章說「掉出前 10 名」而國巨從來不在名單上
 *         ② 同一頁的價格位置圖還畫 🔥 的 🛑 硬停損 / 🚪 吊燈出場線 → 兩套規則混在一起。
 * 釘住:
 *   ⓐ 持有 + 不在名單(沒過趨勢)→ 徽章「不在前 10 名」⛔ 不是「掉出」;why 有「今天不用賣」
 *   ⓑ 曾是第 15 名 → 「掉出前 10 名」
 *   ⓒ 👑 持有 → `_keyLevels.slPx/exitRulePx` = null、`lead`;價格位置圖⛔ 沒有 🛑 / 🚪、有「沒有停損線」;
 *      提示詞 `_reportFacts` ⛔ 沒有硬停損那一行、有「沒有停損線」;`_rpNextLines` 講 👑
 *   ⓓ 決定性對照:同一檔切回 🔥 → 硬停損 / 出場線回來
 *   ⓔ 最近一根收盤鎖漲停 → why 有「🔥 高檔飆股的規則,👑 不用」(🧹 V78.3.6 ⛔ 不印回測數字);沒鎖 → 沒有
 *   ⓕ `_LEAD_LU_EDGE` == leader_probe 實跑結果(三種都輸現行)
 *   📸 V78.5.3 短版:上次換倉名單快照 在 / 不在 / 讀不到 三種;⭐ 決定性對照(快照改成有這檔 → ✅ 第 k 名);不要提早賣收進摺疊;
 *      `_leaderRebPx` 順便回 rank(⛔ 不打第二次)
 *   ⓖ V78.2.1 卡片「⛔ 不要提早賣」(🧹 V78.3.6 改講「少賺很多」⛔ 不印 %) ・ⓗ 決策台持股清單「不在 / 掉出」分清楚
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 300) : ''}`); } };

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + HTML);
await page.waitForFunction(() => typeof app !== 'undefined' && app._ovDecide && app._leadOvText, null, { timeout: 30000 });
const R = await page.evaluate(async () => {
    const A = app, o = {};
    // 300 根緩漲 K 線,最後一根收盤鎖漲停(+10%、收在最高)
    const mk = lock => { const rows = []; for (let i = 0; i < 300; i++) { const c = +(500 + i * 0.4).toFixed(2); rows.push({ date: new Date(Date.UTC(2025, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'), open: c - 1, high: c + 2, low: c - 3, close: c, volume: 5000 }); }
        if (lock) { const p = rows[298].close, c = +(p * 1.1).toFixed(1); rows[299] = { ...rows[299], open: p, high: c, low: p, close: c }; }
        return rows; };
    A.isMarketOpen = () => false;
    A.settings.stratUnlock = true; A.settings.strategy = 'leadpark';
    A._getInventory = () => [{ symbol: '2327', cost: 561, shares: 0.07, buyDate: '2026-07-01' }]; A.inventory = A._getInventory();
    const ctx = (rank, inPool) => {
        const all = new Map(); if (rank) all.set('2327', { rank, posOk: true, pos: 90 });
        return { at: Date.now(), L: { all, poolSet: new Set(inPool ? ['2327'] : []), buy: [], pos: 85 }, clk: { left: 7, isRebal: false }, bearOn: false, date: '2026-10-01' };
    };
    const run = (rows, c) => { A.currentSymbolId = '2327'; A.activeData = rows; A.rawDailyData = rows; A._leadCtx = c; return A._ovDecide(rows, '2327'); };
    let d = run(mk(false), ctx(null, true));
    o.a = { badge: d && d.badge, why: d && d.why };
    d = run(mk(false), ctx(15, true));
    o.b = { badge: d && d.badge, why: d && d.why };
    // 📸 V78.5.3 換倉快照三種 + 決定性對照
    const withSnap = (sn) => { const c = ctx(null, true); c.snap = sn; return c; };
    d = run(mk(false), withSnap({ date: '2026-09-24', rank: new Map([['3443', 1], ['2327', 3]]), err: null })); o.sIn = d && d.why;
    d = run(mk(false), withSnap({ date: '2026-09-24', rank: new Map([['3443', 1]]), err: null })); o.sOut = d && d.why;
    d = run(mk(false), withSnap({ date: '2026-09-24', rank: null, err: '2026-09-24 換倉那天的名單沒有存到' })); o.sErr = d && d.why;
    // keep 也有快照那行
    { const c = ctx(4, true); c.snap = { date: '2026-09-24', rank: new Map([['2327', 2]]) }; d = run(mk(false), c); o.sKeep = d && d.why; }
    // _leaderRebPx 回 rank(stub fetch)
    { const f0 = window.fetch; window.fetch = async () => ({ ok: true, json: async () => ({ days: [{ d: '2026-09-24', lead: { rows: [{ s: '3443', c: 100, r: 1 }, { s: '2327', c: 500, r: 2 }] } }] }) });
      A._leadRebPx = null; const rb = await A._leaderRebPx('2026-09-24'); o.rb = rb && rb.rank ? [...rb.rank.entries()] : null; window.fetch = f0; }
    // ⓖ 決定性對照:改 _LEAD_LU_EDGE → ⛔ 不提早賣那行的 % 跟著變
    const _E0 = JSON.parse(JSON.stringify(A._LEAD_LU_EDGE));
    A._LEAD_LU_EDGE = { ..._E0, ai: { ..._E0.ai, now: 300, all: 200 }, long: { ..._E0.long, now: 1100, all: 600 } };
    d = run(mk(false), ctx(null, true)); o.g = d && d.why;
    A._LEAD_LU_EDGE = _E0;
    // ⓗ 決策台持股清單:沒過趨勢 → ⛔ 不寫「掉出」;曾第 15 名 → 「掉出」
    try {
        const L0 = { date: '2026-10-01', all: new Map([['2330', { rank: 1, sym: '2330', c: 1000, chg10: 5, chg: 1, amt20: 500 }]]), ranked: [{ rank: 1, sym: '2330', c: 1000, chg10: 5, chg: 1, amt20: 500 }], buy: [], poolSet: new Set(['2327', '5483']), pos: 85 };
        A._loadScreener = async () => ({}); A._leaderCalc = () => L0; A._getTwiiRows = async () => null;
        A._leaderClock = () => ({ left: 7, isRebal: false, day: 4 });
        A._getInventory = () => [{ symbol: '2327', cost: 561, shares: 0.07 }, { symbol: '5483', cost: 100, shares: 1 }]; A.inventory = A._getInventory();
        L0.all.set('5483', { rank: 15, sym: '5483', c: 100, chg10: 1, chg: 0, amt20: 50 });
        const host = document.createElement('div'); host.innerHTML = await A._leaderDeckHtml();
        o.h = { a: host.querySelector('[data-leaderheld="2327"]')?.innerText || '', b: host.querySelector('[data-leaderheld="5483"]')?.innerText || '' };
    } catch (e) { o.h = { err: String(e) }; }
    // ⓒ 價位:👑 持有
    const rows = mk(false), C = rows.at(-1).close;
    A.currentSymbolId = '2327'; A.activeData = rows; A.rawDailyData = rows; A._leadCtx = ctx(null, true);
    A._upsideStash = { pC: C, list: [{ lo: C * 1.05, hi: C * 1.1, sup: 8 }] };   // 上方一層套牢區(國巨截圖那種)
    A._ovKeyLevelsHtml(rows, C, 561, { exitMode: false, slF: 533 });
    o.K = { sl: A._keyLevels.slPx, rule: A._keyLevels.exitRulePx, lead: A._keyLevels.lead };
    const rh = A._priceRulerHtml() || '';
    o.ruler = { sl: /data-mark="硬停損"|data-mark="防線"/.test(rh), rule: /data-mark="出場線"/.test(rh), note: /data-leadnote="1"/.test(rh) && /沒有停損線/.test(rh) };
    A._rpLast = { sym: '2327', pC: C };
    try { o.facts = String(A._reportFacts('2327') || ''); } catch (e) { o.facts = 'ERR ' + e; }
    try { o.next = (A._rpNextLines('2327') || []).join(' | '); } catch (e) { o.next = 'ERR ' + e; }
    // ⓓ 決定性對照:切回 🔥
    A.settings.strategy = 'gene';
    A._ovKeyLevelsHtml(rows, C, 561, { exitMode: false, slF: 533 });
    o.Kg = { sl: A._keyLevels.slPx, lead: !!A._keyLevels.lead };
    const rg = A._priceRulerHtml() || '';
    o.rulerG = { sl: /data-mark="硬停損"/.test(rg), note: /data-leadnote/.test(rg) };
    try { o.factsG = String(A._reportFacts('2327') || ''); } catch (e) { o.factsG = 'ERR ' + e; }
    A.settings.strategy = 'leadpark';
    // ⓔ 鎖漲停
    d = run(mk(true), ctx(null, true));
    o.e1 = d && d.why;
    d = run(mk(false), ctx(3, true));
    o.e0 = d && d.why;
    d = run(mk(true), ctx(3, true));
    o.e2 = { badge: d && d.badge, why: d && d.why };
    o.E = JSON.parse(JSON.stringify(A._LEAD_LU_EDGE));
    return o;
});
await browser.close();

ok('ⓐ V78.5.3 標題「⏳ 續抱到換倉日(還有 7 個交易日)」', /續抱到換倉日\(還有 7 個交易日\)/.test(R.a.badge || ''), R.a.badge);
ok('ⓐ2 不在名單 → 「不在前 10 名」⛔ 不是「掉出」;今天不用賣 + 續抱條件 + 賣出條件 + 隔天開盤', /不在前 10 名/.test(R.a.why || '') && !/掉出/.test(R.a.why || '') && /今天不用賣/.test(R.a.why) && /續抱條件/.test(R.a.why) && /換倉日那天還在 10 名外/.test(R.a.why) && /隔天\s*(<b>)?(09:00 )?開盤賣/.test(R.a.why), (R.a.why || '').slice(0, 400));
ok('ⓐ3 趨勢條件方向對:「要 收盤 > 20日線 > 60日線 才算」、⛔ 沒有「收盤價 < 20日線」', /要 收盤 &gt; 20日線 &gt; 60日線 才算|要 收盤 > 20日線 > 60日線 才算/.test(R.a.why || '') && !/收盤價? *<|收盤價? *&lt;/.test(R.a.why || ''), (R.a.why || '').slice(0, 300));
ok('ⓑ 曾是第 15 名 → 「掉出前 10 名」', /掉出前 10 名/.test(R.b.why || '') && /續抱到換倉日/.test(R.b.badge || ''), R.b.badge);
const cut = w => Math.round((1 - (w.all - 100) / (w.now - 100)) * 100);
// 🧹 V78.3.6 散戶 App 不印回測 % → 改釘「會少賺很多」白話 + ⛔ 不可有 %;決定性對照:改 _LEAD_LU_EDGE 之後一般模式畫面仍不出現那些數字
ok('📸a 上次換倉名單有這檔 → ✅ 第 3 名(⭐ 決定性對照:同一份 ctx 只改快照)', /data-leadsnap="in"/.test(R.sIn || '') && /✅ 第 3 名/.test(R.sIn) && /09\/24|09-24/.test(R.sIn), (R.sIn || '').slice(0, 300));
ok('📸b 快照裡沒有這檔 → ❌ 不在名單上', /data-leadsnap="out"/.test(R.sOut || '') && /❌ 不在名單上/.test(R.sOut), (R.sOut || '').slice(0, 300));
ok('📸c 讀不到 → 寫原因(⛔ 不可說成不在名單上)', /data-leadsnap="err"/.test(R.sErr || '') && /讀不到\(2026-09-24 換倉那天的名單沒有存到\)/.test(R.sErr) && !/不在名單上/.test(R.sErr), (R.sErr || '').slice(0, 300));
ok('📸d 沒有快照資料 → 讀不到(還沒讀到)', /data-leadsnap="err"/.test(R.a.why || '') && /還沒讀到/.test(R.a.why), (R.a.why || '').slice(0, 300));
ok('📸e 續抱(前 10 名內)也有快照那行', /data-leadsnap="in"/.test(R.sKeep || '') && /✅ 第 2 名/.test(R.sKeep), (R.sKeep || '').slice(0, 300));
ok('📸f 不要提早賣 / 續抱條件 收進摺疊(⛔ 不刪)', (() => { const w = R.a.why || ''; const i = w.indexOf('<details'); return i > 0 && w.indexOf('data-leadearly') > i && w.indexOf('data-leadkeepif') > i && w.indexOf('data-leadsellif') < i; })(), (R.a.why || '').slice(0, 500));
ok('📸g _leaderRebPx 順便回 rank(照 r 欄)', JSON.stringify(R.rb) === JSON.stringify([['3443', 1], ['2327', 2]]), JSON.stringify(R.rb));
ok('ⓖ ⛔ 不提早賣那行講「會少賺很多」、⛔ 不印回測 %(🧹 V78.3.6;改常數也⛔ 不出現數字)', /不要提早賣/.test(R.a.why || '') && /少賺很多/.test(R.a.why || '') && !/少 <b[^>]*>\d+%/.test(R.a.why || '') && !/少 <b[^>]*>\d+%/.test(R.g || '') && !/70%|50%/.test(R.g || '') && !/70%/.test(R.a.why || ''), (R.g || '').slice(-400));
ok('ⓗ 決策台持股:沒過趨勢 → ⛔ 不寫「掉出」、寫「不在前 10 名」;第 15 名 → 「掉出前 10 名」;非換倉日用 ⏳', /不在前 10 名/.test(R.h.a || '') && !/掉出/.test(R.h.a || '') && /掉出前 10 名/.test(R.h.b || '') && /⏳/.test(R.h.a || '') && !/⛔ 掉出|⛔ 不在/.test(R.h.a + R.h.b), JSON.stringify(R.h));
ok('ⓒ 👑 持有 → _keyLevels 沒有硬停損 / 出場線、標 lead', R.K.sl == null && R.K.rule == null && R.K.lead === true, JSON.stringify(R.K));
ok('ⓒ2 價格位置圖⛔ 沒有 🛑 / 🚪,有「沒有停損線」', !R.ruler.sl && !R.ruler.rule && R.ruler.note, JSON.stringify(R.ruler));
ok('ⓒ3 提示詞⛔ 沒有「硬停損(成本 −5%」那一行、有「沒有停損線」+「請不要自己替他編停損價」', !/- 硬停損\(成本/.test(R.facts) && /沒有停損線/.test(R.facts) && /不要自己替他編停損價/.test(R.facts), R.facts.slice(0, 120));
ok('ⓒ4 「接下來怎麼看」講 👑 換倉日、⛔ 不講 🔥 出場線', /👑 你選的是領頭羊/.test(R.next) && !/三條出場/.test(R.next), R.next.slice(0, 240));
ok('ⓓ 決定性對照:切回 🔥 → 硬停損 533 回來、價格位置圖有 🛑、提示詞有硬停損', R.Kg.sl === 533 && !R.Kg.lead && R.rulerG.sl && !R.rulerG.note && /- 硬停損\(成本/.test(R.factsG), JSON.stringify([R.Kg, R.rulerG]));
ok('ⓔ 最近一根收盤鎖漲停 → why 講「🔥 高檔飆股的規則,👑 不用」(🧹 V78.3.6 ⛔ 不印回測數字)', /🔥 高檔飆股<\/b>的規則,👑 不用/.test(R.e1 || '') && !new RegExp(R.E.ai.all.toLocaleString('en-US')).test(R.e1 || '') && !/\d[\d,]* 萬|回測|實測/.test(R.e1 || ''), (R.e1 || '').slice(-300));
ok('ⓔ2 續抱那一種也會講;沒鎖漲停 → ⛔ 不講', /👑 不用/.test(R.e2.why || '') && /續抱/.test(R.e2.badge || '') && !/👑 不用/.test(R.e0 || ''), (R.e0 || '').slice(-200));
const E = R.E;
ok('ⓕ `_LEAD_LU_EDGE`:三種都輸現行(兩個窗口)、贏的條數 < 一半', ['gap5', 'gap0', 'all'].every(k => E.ai[k] < E.ai.now && E.long[k] < E.long.now && E.ai.beat[k] < 9 && E.long.beat[k] < 9), JSON.stringify(E));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails ? `\n❌ LEADHELD_FAIL(${fails})` : '\n✅ LEADHELD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
