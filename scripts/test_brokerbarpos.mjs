#!/usr/bin/env node
/**
 * 🎯 買超均價在「當日 K 棒」的位置 —— 追價買 vs 低檔吃貨(V71.9.4)
 *
 * 逐字稿原話:「買超第一名是大摩,**它就不一定是隔日沖,因為它的買超均價並不是漲停板**」
 * → 他是拿「買超均價 vs 當天高點」在判這家分點的性質。
 *
 * 這支釘住三個守門(少一個就會算錯,而且錯得很難發現):
 *   ① 只在 **1 日** 成立(5/10 日的 avg 橫跨多天,比單根 K 棒無意義)
 *   ② 必須用**分點那天**的 K 棒,不是 rawDailyData 最後一根(分點常落後 1 天)
 *   ③ 當天振幅太小(<1.5%)不判 —— 窄幅時 avg 必然貼著高點,是數學必然不是行為訊號
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

// 直接跑真的 render，抓它產出的 insights HTML
const run = ({ avg, period = '1d', chipDate = '2026-07-30', bars, lots = 500 }) => page.evaluate(a => {
    let box = document.getElementById('chipPaneBroker');
    if (!box) { box = document.createElement('div'); box.id = 'chipPaneBroker'; document.body.appendChild(box); }
    box.innerHTML = '';
    app.currentSymbolId = '2330';
    app.rawDailyData = a.bars;
    app._fenSym = '2330';
    app._fenDataDate = a.chipDate;
    const one = { buy: [{ broker_id: '9200', broker_name: '凱基-台北', net: a.lots * 1000, avg: a.avg }], sell: [] };
    app._fenPeriods = { '1d': one, '5d': one, '10d': one };
    try { app._renderBrokerFenDian(a.period); } catch (e) { return 'ERR:' + e.message; }
    return box.innerHTML;
}, { avg, period, chipDate, bars, lots });

// 當日 K 棒 100~110(振幅 10%),前一天是完全不同的區間(用來抓「拿錯 K 棒」)
const BARS = [
    { date: '2026/07/29', open: 200, high: 260, low: 200, close: 205, volume: 9e6 },
    { date: '2026/07/30', open: 101, high: 110, low: 100, close: 108, volume: 1e7 },
    { date: '2026/07/31', open: 300, high: 380, low: 300, close: 310, volume: 1e7 },
];

// ── ① 買在高檔 → 追價買 ─────────────────────────────────────
let h = await run({ avg: 109, bars: BARS });            // (109-100)/10 = 90%
ok('① 買在當日 90% 位置 → 判「追價買」', /追價買/.test(h), h.slice(-500));
ok('① 要顯示位置百分比', /90%/.test(h), h.slice(-400));
ok('① 要警告別當成大咖看好', /別把這種買超當成/.test(h), h.slice(-400));
ok('① ⛔ 不可誤判成低檔吃貨', !/低檔吃貨/.test(h));

// ── ② 買在低檔 → 吃貨 ──────────────────────────────────────
h = await run({ avg: 101, bars: BARS });                // 10%
ok('② 買在當日 10% 位置 → 判「低檔吃貨」', /低檔吃貨/.test(h), h.slice(-500));
ok('② ⭐ 不可講成保證會漲(只說明買法)', /不保證/.test(h), h.slice(-400));
ok('② ⛔ 不可誤判成追價買', !/追價買/.test(h));

// ── ③ 買在中間 → 兩邊都不報(免得洗版)────────────────────────
h = await run({ avg: 105, bars: BARS });                // 50%
ok('③ 買在中間 50% → 兩個都不報', !/追價買/.test(h) && !/低檔吃貨/.test(h));

// ── ④ ⭐ 守門一:5 日不可判(avg 橫跨多天,比單根 K 棒無意義)──────
h = await run({ avg: 109, period: '5d', bars: BARS });
ok('④ ⭐ 5 日週期 ⛔ 不可判', !/追價買/.test(h) && !/低檔吃貨/.test(h), h.slice(-300));

// ── ⑤ ⭐ 守門二:必須用「分點那天」的 K 棒,不是最後一根 ──────────
// 分點日 07/30(區間 100~110),最後一根是 07/31(區間 300~380)。
// 若誤用最後一根,avg=109 會落在 07/31 K 棒之外 → 不會報「追價買」。
h = await run({ avg: 109, chipDate: '2026-07-30', bars: BARS });
ok('⑤ ⭐ 有正確抓到分點當天(07/30)那根,而不是最後一根(07/31)', /追價買/.test(h), h.slice(-300));
// 分點日指向 07/29(區間 200~260):avg=109 落在該 K 棒外 → 應該安靜跳過
h = await run({ avg: 109, chipDate: '2026-07-29', bars: BARS });
ok('⑤ avg 落在該日 K 棒之外 → 安靜跳過(不硬判)', !/追價買/.test(h) && !/低檔吃貨/.test(h), h.slice(-300));
// 找不到那天 → 不判
h = await run({ avg: 109, chipDate: '2026-06-01', bars: BARS });
ok('⑤ 找不到對應交易日 → ⛔ 不退而求其次拿最後一根', !/追價買/.test(h) && !/低檔吃貨/.test(h));

// ── ⑥ ⭐ 守門三:當天振幅太小不判(數學必然,不是行為訊號)──────────
const FLAT = [{ date: '2026/07/30', open: 100, high: 100.5, low: 100, close: 100.3, volume: 1e7 }];
h = await run({ avg: 100.5, bars: FLAT });              // 位置 100% 但振幅只有 0.5%
ok('⑥ ⭐ 振幅 0.5%(<1.5%)→ ⛔ 不判(否則天天誤報追價買)',
   !/追價買/.test(h) && !/低檔吃貨/.test(h), h.slice(-300));

// ── ⑦ 張數太小不判 ────────────────────────────────────────
h = await run({ avg: 109, lots: 20, bars: BARS });
ok('⑦ 只買 20 張 → 不判(雜訊)', !/追價買/.test(h));

// ── ⑧ 跟「精準低接」是兩條不同的判斷,⛔ 不可被合併掉 ─────────────
const src = await page.evaluate(() => app._renderBrokerFenDian.toString());
ok('⑧ 「精準低接」(比區間均價)仍在', /精準低接/.test(src));
ok('⑧ 新判斷(比當日 K 棒)也在', /追價買/.test(src) && /低檔吃貨/.test(src));
ok('⑧ ⭐ 新判斷有綁 period===1d 守門', /period === '1d'/.test(src));

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ BROKERBARPOS_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ BROKERBARPOS_TEST_PASS');
