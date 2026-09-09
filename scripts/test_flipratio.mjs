#!/usr/bin/env node
/**
 * 🌡️ 隔日沖占比 + 手牽手家數 測試(V71.9.6)
 *
 * 逐字稿【深度解析隔日沖】:「他會幫你算一下**隔日沖的占比**…那個買超在**漲停板附近**的」
 * 另一段:「盤中手牽手、盤後下毒手」「隔天有一家隔日沖跑了、另外一家還不跑,這是最傻的」
 *
 * 釘住四件事:
 *   ① 占比要算對(買在當日高檔區的買超 ÷ 全部買超)
 *   ② ⛔ 不可寫死「漲停附近」—— 不是每檔都漲停,寫死會讓這條大部分時候失效
 *   ③ 手牽手家數要用 `_flipEdge()` 的**實測值**,⛔ 不可用人工寫死的標籤
 *      (V71.7.2 已證明人工標籤會錯)
 *   ④ 跟 V71.9.4(誰在追價)是**互補**不是重複,兩條都必須留著
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 220)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderBrokerFenDian, null, { timeout: 20000 });

// 當日 K 棒 100~110;avg≥107.5 才算「高檔區(≥75%)」
const BARS = [{ date: '2026/07/30', open: 101, high: 110, low: 100, close: 108, volume: 1e7 }];

const run = ({ buys, flip = [], bars = BARS, period = '1d' }) => page.evaluate(a => {
    let box = document.getElementById('chipPaneBroker');
    if (!box) { box = document.createElement('div'); box.id = 'chipPaneBroker'; document.body.appendChild(box); }
    box.innerHTML = '';
    app.currentSymbolId = '2330';
    app.rawDailyData = a.bars;
    app._fenSym = '2330';
    app._fenDataDate = '2026-07-30';
    app._brokerPerf = { flip: a.flip };
    app._flipMap = null;                        // 清快取,避免跨案例污染
    const one = { buy: a.buys.map((b, i) => ({ broker_id: String(9000 + i), broker_name: b.n, net: b.lots * 1000, avg: b.avg })), sell: [] };
    app._fenPeriods = { '1d': one, '5d': one, '10d': one };
    try { app._renderBrokerFenDian(a.period); } catch (e) { return 'ERR:' + e.message; }
    return box.innerHTML;
}, { buys, flip, bars, period });

// ── ① 占比算得對:600 張買在高檔 / 共 1000 張 = 60% ────────────────
let h = await run({ buys: [
    { n: '凱基-台北', lots: 600, avg: 109 },     // 高檔區(90%)
    { n: '富邦-建國', lots: 400, avg: 101 },     // 低檔(10%)
] });
ok('① 占比 60%', /隔日沖占比 60%/.test(h), h.slice(-700));
ok('① 要顯示總張數與追高張數', /1,000 張/.test(h) && /600 張/.test(h), h.slice(-700));
ok('① 要點名是哪幾家', /凱基-台北|凱基台北/.test(h), h.slice(-700));
ok('① 要說明「成本高、隔天要走」的因果', /一回落就沒賺/.test(h), h.slice(-700));
ok('① 要給對策', /對策/.test(h) && /別在隔天開高時追/.test(h), h.slice(-700));

// ── ② 分級:≥70% 要升級成 🚨 極高 ─────────────────────────
h = await run({ buys: [
    { n: '凱基-台北', lots: 800, avg: 109 },
    { n: '富邦-建國', lots: 200, avg: 101 },
] });
ok('② 80% → 判「極高」+ 🚨', /隔日沖占比 80%\(極高\)/.test(h) && /🚨/.test(h), h.slice(-700));

// ── ③ 占比低 → ⛔ 不報(免得吵)──────────────────────────
h = await run({ buys: [
    { n: '凱基-台北', lots: 200, avg: 109 },
    { n: '富邦-建國', lots: 800, avg: 101 },
] });
ok('③ 20% → 不報', !/隔日沖占比/.test(h), h.slice(-400));

// ── ④ 總量太小 → 不報(雜訊)────────────────────────────
h = await run({ buys: [{ n: '凱基-台北', lots: 50, avg: 109 }] });
ok('④ 只有 50 張 → 不報', !/隔日沖占比/.test(h));

// ── ⑤ ⭐ 手牽手:用實測 flip,⛔ 不用人工標籤 ────────────────
const FLIP = [{ broker: '凱基-台北', edge: 30.5, n: 29 }, { broker: '富邦-建國', edge: 26.1, n: 32 }];
h = await run({ buys: [
    { n: '凱基-台北', lots: 400, avg: 109 },
    { n: '富邦-建國', lots: 400, avg: 101 },
], flip: FLIP });
ok('⑤ 2 家實測隔日沖同時買 → 報「手牽手」', /2 家隔日沖同時在買/.test(h), h.slice(-700));
ok('⑤ 要帶實測邊際值(pp)', /\+3[01]pp|\+26pp/.test(h), h.slice(-700));
ok('⑤ 要引用「盤中手牽手、盤後下毒手」', /盤後下毒手/.test(h), h.slice(-700));
ok('⑤ 要說明踩踏風險', /互相踩踏|跟著砍/.test(h), h.slice(-700));
ok('⑤ ⭐ 要註明是實測不是人工標籤', /不是人工標籤/.test(h), h.slice(-700));

// ⭐ 關鍵:名字有隔日沖字樣但**實測沒有邊際** → ⛔ 不可算進手牽手
h = await run({ buys: [
    { n: '美商美林(⚡外資最大隔日沖/常大買大賣)', lots: 400, avg: 109 },
    { n: '凱基-台北(🔥全台最大最兇隔日沖)', lots: 400, avg: 101 },
], flip: [] });
ok('⑤ ⭐ 人工標籤寫「最兇隔日沖」但實測無邊際 → ⛔ 不可報手牽手',
   !/家隔日沖同時在買/.test(h), h.slice(-500));

// 只有 1 家 → 不報(手牽手至少要 2 家)
h = await run({ buys: [{ n: '凱基-台北', lots: 800, avg: 109 }], flip: FLIP });
ok('⑤ 只有 1 家 → 不報手牽手', !/家隔日沖同時在買/.test(h), h.slice(-400));

// ── ⑥ 守門:5 日不判 / 振幅太小不判 ───────────────────────
h = await run({ buys: [{ n: '凱基-台北', lots: 600, avg: 109 }, { n: '富邦-建國', lots: 400, avg: 101 }], period: '5d' });
ok('⑥ 5 日週期 ⛔ 不判', !/隔日沖占比/.test(h), h.slice(-300));
const FLAT = [{ date: '2026/07/30', open: 100, high: 100.4, low: 100, close: 100.2, volume: 1e7 }];
h = await run({ buys: [{ n: '凱基-台北', lots: 600, avg: 100.4 }, { n: '富邦-建國', lots: 400, avg: 100 }], bars: FLAT });
ok('⑥ ⭐ 振幅 0.4% → ⛔ 不判(否則天天誤報)', !/隔日沖占比/.test(h), h.slice(-300));

// ── ⑦ ⭐ 跟 V71.9.4 互補,兩條都要在 ──────────────────────
const src = await page.evaluate(() => app._renderBrokerFenDian.toString());
ok('⑦ V71.9.4「誰在追價」仍在', /追價買/.test(src) && /低檔吃貨/.test(src));
ok('⑦ V71.9.6「占多少」也在', /隔日沖占比/.test(src));
ok('⑦ ⛔ 不可寫死「漲停」當判定門檻', !/avg[^\n]{0,40}漲停價|limitUp/.test(src));

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ FLIPRATIO_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ FLIPRATIO_TEST_PASS');
