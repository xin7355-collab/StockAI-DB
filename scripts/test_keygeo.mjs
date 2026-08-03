#!/usr/bin/env node
/**
 * 🧙🗺️ 關鍵分點(低檔大買/高檔大賣)+ 地緣分點 測試(V71.9.8)
 *
 * 逐字稿 SOP:「第一個找**高檔大賣**分點、第二個找**低檔大買**分點」
 *            「關鍵分點常常就是**地緣分點**」(公司在彰化,分點常在台中)
 *
 * 釘住四件最容易做錯的事:
 *   ① 位階用「該股自己的區間」算,⛔ 不寫死價格門檻
 *   ② bstat(長期累計)優先、periods(20 日)當回退 —— 歷史深度會自己長
 *   ③ ⛔ **有歧義的地名一律不對照**(中山/中正/信義/民權…好幾個縣市都有)
 *   ④ ⛔ 不可宣稱預測力(地緣我沒回測過;低檔大買只說明買在哪,不保證會漲)
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._keyBrokers && !!app._brokerCity, null, { timeout: 20000 });

// 30 根日 K:價格 100 → 130(區間 100~130)
const BARS = Array.from({ length: 30 }, (_, i) => {
    const c = 100 + i;
    return { date: `2026/07/${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c, volume: 1e6 };
});

// ── ① 分點名 → 縣市 ──────────────────────────────────────
const city = n => page.evaluate(x => app._brokerCity(x), n);
ok('① 「華南高雄」→ 高雄市', (await city('華南高雄')) === '高雄市');
ok('① 「凱基斗六」→ 雲林縣', (await city('凱基斗六')) === '雲林縣');
ok('① 「統一臺中」→ 台中市(臺/台通用)', (await city('統一臺中')) === '台中市');
ok('① 「永昌彰化」→ 彰化縣', (await city('永昌彰化')) === '彰化縣');
ok('① 「凱基永康」→ 台南市', (await city('凱基永康')) === '台南市');
ok('① 括號註記不影響', (await city('凱基-台北(🔥全台最大最兇隔日沖)')) === '台北市');

// ⭐ ③ 歧義地名一律不對照
for (const amb of ['第一中山', '群益民權', '德信和平', '富邦建國', '統一忠孝', '元大信義', '凱基中正']) {
    ok(`③ ⭐ 歧義地名「${amb}」→ 不對照(回空)`, (await city(amb)) === '', await city(amb));
}
ok('③ 外資分點無地名 → 空', (await city('美商美林')) === '');

// ── ② 關鍵分點:低檔大買 / 高檔大賣 ────────────────────────
const runKey = ({ p20, bstat = null, bars = BARS }) => page.evaluate(a => {
    app.rawDailyData = a.bars;
    app._fenPeriods = { '20d': a.p20, '1d': a.p20 };
    app._bstat = a.bstat ? { '2330': a.bstat } : {};
    return app._keyBrokers('2330');
}, { p20, bstat, bars });

// 區間 100~130:買均價 105 → 位階 17%(低檔);賣均價 128 → 位階 97%(高檔)
let r = await runKey({ p20: {
    buy: [{ broker_name: '凱基斗六', net: 500000, avg: 105 }],
    sell: [{ broker_name: '華南高雄', net: -500000, avg: 128 }],
} });
ok('② 低檔大買抓到(位階 ~17%)', r && r.buyLow.length === 1 && r.buyLow[0].pos < 30, JSON.stringify(r));
ok('② 高檔大賣抓到(位階 ~97%)', r && r.sellHigh.length === 1 && r.sellHigh[0].pos > 70, JSON.stringify(r));
ok('② 回退來源標成 periods', r && r.src === 'periods', JSON.stringify(r && r.src));

// 買在高檔 → ⛔ 不可算成「低檔大買」
r = await runKey({ p20: { buy: [{ broker_name: '凱基斗六', net: 500000, avg: 128 }], sell: [] } });
ok('② 買在區間高檔 → ⛔ 不算低檔大買', !r || !r.buyLow.length, JSON.stringify(r));

// 張數太少 → 不算
r = await runKey({ p20: { buy: [{ broker_name: '凱基斗六', net: 20000, avg: 105 }], sell: [] } });
ok('② 只有 20 張 → 不算', !r || !r.buyLow.length, JSON.stringify(r));

// 均價落在區間外(資料對不上)→ 不算
r = await runKey({ p20: { buy: [{ broker_name: '凱基斗六', net: 500000, avg: 500 }], sell: [] } });
ok('② 均價 500 落在區間外 → 安靜跳過', !r || !r.buyLow.length, JSON.stringify(r));

// ── ⭐ bstat 優先(歷史更深)────────────────────────────────
r = await runKey({
    p20: { buy: [{ broker_name: '華南高雄', net: 500000, avg: 105 }], sell: [] },
    bstat: { d0: '2026-05-01', days: 25, b: { '凱基斗六': [900000, 900000 * 103, 20] } },
});
ok('⭐ bstat 有值時優先用它', r && r.src === 'bstat' && r.buyLow[0].nm === '凱基斗六', JSON.stringify(r));
ok('⭐ bstat 均價 = 金額 ÷ 淨股數 = 103', r && Math.abs(r.buyLow[0].av - 103) < 0.01, JSON.stringify(r && r.buyLow[0]));
ok('⭐ 要回報累計天數(讓使用者知道歷史多深)', r && r.win === 25, JSON.stringify(r && r.win));
// bstat 太淺 → 退回 periods
r = await runKey({
    p20: { buy: [{ broker_name: '華南高雄', net: 500000, avg: 105 }], sell: [] },
    bstat: { d0: '2026-07-25', days: 5, b: { '凱基斗六': [900000, 900000 * 103, 3] } },
});
ok('⭐ bstat 只有 5 天(太淺)→ 退回 periods', r && r.src === 'periods', JSON.stringify(r && r.src));

// ── ④ 地緣分點 ─────────────────────────────────────────
const runGeo = ({ geo, buys }) => page.evaluate(a => {
    app._companyGeo = a.geo;
    return app._geoBrokers('2330', a.buys);
}, { geo, buys });

let g = await runGeo({ geo: { '2330': '彰化縣' }, buys: [
    { broker_name: '永昌彰化', net: 300000 },
    { broker_name: '統一臺中', net: 200000 },     // 鄰近(他的例子:彰化公司→台中分點)
    { broker_name: '凱基-台北', net: 500000 },
] });
ok('④ 同縣市抓到', g && g.same.length === 1, JSON.stringify(g && g.same));
ok('④ ⭐ 鄰近縣市也算(他的例子:彰化公司→台中分點)', g && g.adj.length === 1, JSON.stringify(g && g.adj));
ok('④ 台北分點不算(非同縣市也非鄰近)', g && g.pct < 100, JSON.stringify(g && g.pct));
ok('④ 佔比算得對(50萬/100萬 = 50%)', g && Math.abs(g.pct - 50) < 0.1, JSON.stringify(g && g.pct));

ok('④ 沒有公司縣市 → null', (await runGeo({ geo: {}, buys: [{ broker_name: '永昌彰化', net: 300000 }] })) === null);
ok('④ 沒有地緣分點 → null',
   (await runGeo({ geo: { '2330': '彰化縣' }, buys: [{ broker_name: '凱基-台北', net: 300000 }] })) === null);

// ── ⑤ ⛔ 文案不可宣稱預測力 ──────────────────────────────
const html = await page.evaluate(() => app._renderBrokerFenDian.toString());
ok('⑤ ⭐ 地緣要註明「沒有回測過預測力」', /沒有回測過/.test(html), '');
ok('⑤ ⭐ 地緣要註明歧義地名不對照', /不對照/.test(html), '');
ok('⑤ ⭐ 低檔大買要註明「不保證後續會漲」', /不保證後續會漲/.test(html), '');
ok('⑤ 兩條都真的接進分點解讀', /_keyBrokers/.test(html) && /_geoBrokers/.test(html));

ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ KEYGEO_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ KEYGEO_TEST_PASS');
