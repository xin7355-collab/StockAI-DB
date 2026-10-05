#!/usr/bin/env node
/**
 * 👑🔥 V78.5.5 選 👑 時「名單外」改照 🔥(使用者:國巨上次不在領頭羊名單,總覽卻說續抱到換倉日 →
 *   「我想要用其他我最強的交易買進賣出」;選了「改照 🔥 三條出場」+「買賣都要」)。
 * 釘住:
 *   ⓐ 持股 + 上次換倉快照有它 → 👑(`_leaderMine` 有、`_ovDecide` 回 lead)
 *   ⓑ ⭐ 決定性對照:同一檔把快照拿掉 → 🔥(`_leaderMine` 沒有、`_ovDecide` 沒有 lead、why 有「不在上次換倉」)
 *   ⓒ 換倉日當天:今天的快照沒有、上一次的有 → 仍 👑(今天要賣的是上一次買的)
 *   ⓓ 沒持有:在 👑 買進名單 → 👑;不在 → 🔥(why 有「不在今天的 👑 買進名單」)
 *   ⓔ 名單還沒載好 / 快照讀不到 → 照舊 👑(⛔ 沒有快照 ≠ 不在名單)
 *   ⓕ 🧬 模式不受影響(`_leaderMine` 空、`_leadFireNote` 空)
 *   ⓖ 收盤後日期:報價日 = 今天、最後一根是 10/02、13:30 後 → 新增今天一根、10/02 那根不變;報價日 ≠ 今天 / 沒日期 / 盤前 → 照舊
 *   ⓗ 開盤卡在 📏 價格位置圖前面、五列有方向色條(紅 = 開高、綠 = 開低)、📌 有色條
 */
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 300) : ''}`); } };
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + HTML);
await page.waitForFunction(() => typeof app !== 'undefined' && app._ovDecide && app._leadOwns, null, { timeout: 30000 });
const R = await page.evaluate(() => {
    const A = app, o = {};
    const rows = []; for (let i = 0; i < 300; i++) { const c = +(500 + i * 0.4).toFixed(2); rows.push({ date: new Date(Date.UTC(2025, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'), open: c - 1, high: c + 2, low: c - 3, close: c, volume: 5000 }); }
    A.isMarketOpen = () => false;
    A.settings.stratUnlock = true; A.settings.strategy = 'leadpark';
    const inv = held => { A._getInventory = () => held ? [{ symbol: '2327', cost: 561, shares: 1, buyDate: '2026-09-01' }] : []; A.inventory = A._getInventory(); };
    const ctx = (snapSyms, buy, isRebal, prevSyms) => ({ at: Date.now(), L: { all: new Map([['2327', { rank: 30, posOk: true, pos: 90 }]]), poolSet: new Set(['2327']), buy: (buy || []).map(s => ({ sym: s })), pos: 85 },
        clk: { left: isRebal ? 0 : 6, isRebal: !!isRebal }, bearOn: false, date: '2026-10-02',
        snap: snapSyms === null ? { date: '2026-09-24', rank: null, err: '讀不到' } : { date: '2026-09-24', rank: new Map(snapSyms.map((s, i) => [s, i + 1])), err: null, prevRank: prevSyms ? new Map(prevSyms.map((s, i) => [s, i + 1])) : null } });
    const dec = () => { A.currentSymbolId = '2327'; A.activeData = rows; A.rawDailyData = rows; return A._ovDecide(rows, '2327'); };
    const snap = d => ({ lead: !!(d && d.lead), why: String(d && d.why || ''), fire: !!(d && d.fire) });
    inv(true); A._leadCtx = ctx(['3016', '2327'], []); o.a = { mine: A._leaderMine().has('2327'), d: snap(dec()) };
    A._leadCtx = ctx(['3016'], []); o.b = { mine: A._leaderMine().has('2327'), d: snap(dec()) };
    A._leadCtx = ctx(['3016'], [], true, ['2327']); o.c = { mine: A._leaderMine().has('2327') };
    inv(false); A._leadCtx = ctx(['3016'], ['2327']); o.d1 = snap(dec());
    A._leadCtx = ctx(['3016'], ['3016']); o.d2 = snap(dec());
    inv(true); A._leadCtx = null; o.e1 = A._leaderMine().has('2327');
    A._leadCtx = ctx(null, []); o.e2 = A._leaderMine().has('2327');
    A.settings.strategy = 'gene'; A._leadCtx = ctx(['3016'], []); o.f = { mine: A._leaderMine().size, note: A._leadFireNote('2327', true) };
    // ⓖ 收盤後新增今天那根
    const td = A.getTodayStr(); const base = [{ date: '2026/10/01', open: 560, high: 602, low: 560, close: 602, volume: 7e4 }, { date: '2026/10/02', open: 604, high: 647, low: 598, close: 626, volume: 1e5 }];
    const ap = (q, after) => { A.baseRawData = JSON.parse(JSON.stringify(base)); A._isIndexSym = () => false; A._afterCloseNow = () => after; A.applyLatestPrice(q, null); return A.rawDailyData.slice(-2); };
    o.g1 = ap({ price: 640, open: 630, high: 650, low: 620, volume: 59768, date: td, isHistorical: false }, true);
    o.g2 = ap({ price: 640, open: 630, high: 650, low: 620, volume: 59768, date: '2026/10/02', isHistorical: false }, true);
    o.g3 = ap({ price: 640, open: 630, high: 650, low: 620, volume: 59768, isHistorical: false }, true);
    o.g4 = ap({ price: 640, open: 630, high: 650, low: 620, volume: 59768, date: td, isHistorical: false }, false);
    o.td = td;
    o.qd = A._quoteDay('2026-10-05');
    return o;
});
ok('ⓐ 快照有它 → 👑(_leaderMine 有、總覽走 👑)', R.a.mine && R.a.d.lead && !R.a.d.fire, JSON.stringify(R.a));
ok('ⓑ ⭐ 快照拿掉同一檔 → 🔥(_leaderMine 沒有、總覽不走 👑、why 講不在上次換倉)', !R.b.mine && !R.b.d.lead && R.b.d.fire && /不在上次換倉/.test(R.b.d.why) && /三條出場/.test(R.b.d.why), JSON.stringify(R.b).slice(0, 300));
ok('ⓒ 換倉日:今天的快照沒有、上一次有 → 仍 👑', R.c.mine);
ok('ⓓ1 沒持有、在 👑 買進名單 → 👑', R.d1.lead && !R.d1.fire, JSON.stringify(R.d1).slice(0, 200));
ok('ⓓ2 沒持有、不在 👑 買進名單 → 🔥 買點', !R.d2.lead && R.d2.fire && /不在今天的 👑 買進名單/.test(R.d2.why), JSON.stringify(R.d2).slice(0, 200));
ok('ⓔ 名單沒載好 / 快照讀不到 → 照舊 👑', R.e1 && R.e2);
ok('ⓕ 🧬 模式不受影響', R.f.mine === 0 && R.f.note === '');
ok('ⓖ1 收盤後、報價日 = 今天 → 新增今天一根,10/02 那根不變', R.g1[1].date === R.td && R.g1[1].close === 640 && R.g1[0].date === '2026/10/02' && R.g1[0].close === 626 && R.g1[0].high === 647, JSON.stringify(R.g1));
ok('ⓖ2 報價日 ≠ 今天 → 照舊(不新增)', R.g2[1].date === '2026/10/02', JSON.stringify(R.g2));
ok('ⓖ3 報價沒帶日期 → 照舊', R.g3[1].date === '2026/10/02');
ok('ⓖ4 13:30 前 → 照舊(盤前報價可能帶今天日期但還沒成交)', R.g4[1].date === '2026/10/02');
ok('ⓖ5 _quoteDay 正規化', R.qd === '2026/10/05');
// ⓗ 開盤卡位置與顏色(走真的 _renderOvCommand)
const H = await page.evaluate(() => {
    const A = app;
    A.settings.strategy = 'gene';
    const rows = []; for (let i = 0; i < 300; i++) { const c = +(500 + i * 0.4).toFixed(2); rows.push({ date: new Date(Date.UTC(2025, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'), open: c - 1, high: c + 2, low: c - 3, close: c, volume: 5000 }); }
    A._getInventory = () => []; A.inventory = [];
    A.currentSymbolId = '2327'; A.activeData = rows; A.rawDailyData = rows; A.baseRawData = rows;
    A._priceRulerHtml = () => '<div data-priceruler="1">📏 尺</div>';   // 合成資料畫不出尺 → 擺一個,只驗前後順序
    try { A._renderOvCommand(rows); } catch (e) { return { err: String(e) }; }
    const cc = document.getElementById('ovCommandCenter');
    const ob = cc && cc.querySelector('#ovOpenBox'), pr = cc && cc.querySelector('[data-priceruler]');
    const before = !!(ob && pr && (ob.compareDocumentPosition(pr) & Node.DOCUMENT_POSITION_FOLLOWING));
    const tone = Object.fromEntries([...document.querySelectorAll('[data-ovopen-five]')].map(e => [e.getAttribute('data-ovopen-five'), e.style.borderLeftColor]));
    const rule = document.querySelector('[data-ovopen-rule]');
    return { inCc: !!ob, hasRuler: !!pr, before, tone, rule: rule ? rule.style.borderLeftColor : '', ids: document.querySelectorAll('#ovOpenBox').length };
});
const rgb = s => (String(s).match(/\d+/g) || []).map(Number);
const isRed = s => { const [r, g, b] = rgb(s); return r > 150 && r > g + 60 && r > b + 60; };
const isGreen = s => { const [r, g, b] = rgb(s); return g > 150 && g > r + 40 && g > b + 40; };
ok('ⓗ1 開盤卡在 #ovCommandCenter 裡、只有一個 #ovOpenBox', H.inCc && H.ids === 1, JSON.stringify(H).slice(0, 300));
ok('ⓗ2 開盤卡排在 📏 價格位置圖前面', H.hasRuler && H.before, JSON.stringify(H).slice(0, 300));
ok('ⓗ3 開高 / 漲停 = 紅色條、開低 / 跌停 = 綠色條', isRed(H.tone.lu) && isRed(H.tone.hi) && isGreen(H.tone.lo) && isGreen(H.tone.ld) && !isRed(H.tone.flat) && !isGreen(H.tone.flat), JSON.stringify(H.tone));
ok('ⓗ4 📌 你的規則有色條(⛔ 不是紅綠)', H.rule && !isRed(H.rule) && !isGreen(H.rule), H.rule);
ok('沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條沒過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
