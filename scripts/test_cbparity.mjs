#!/usr/bin/env node
/**
 * 💳 可轉債「離轉換價多遠 × 股價位階」測試(V71.9.1)
 *
 * 逐字稿【哥有籌必爆S2】第2集把公式講死了:CB 市值 = 股價 ÷ 轉換價 × 100,
 * 公司發債是為了不還錢 → 拉過轉換價讓人換股;「高檔 + 市值 >120 + 現券償還 = 行情告一段落」。
 *
 * `cb_probe.py` 實測(306 檔、9,977 事件、報酬扣同期加權)結論有三:
 *   ❌ 他說的「85~100 是甜蜜點」不成立
 *   ➖ 「發 CB 小股東吃虧」看不出來
 *   ✅ 真正有東西的是 **parity × 位階** 的交互作用,而且門檻在 **100** 不是 120,
 *      且**只有高位階才成立**(高位階內差 +5.65pp,低位階只差 +0.55pp)
 *
 * 這支把三件最容易被改壞的事釘死:
 *   ① 低位階時**不可**因為過轉換價就報警(實測那格沒有邊際)
 *   ② 高位階 + 過轉換價 → 必須報警且扣分,文案要帶實測數字
 *   ③ 高位階 + 沒過轉換價 → ⛔ **絕不可寫成買訊**(實測是 −0.29%,只是「不在倒貨區」)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

// 造 240 根日 K:價格從 lo 線性走到 hi,最後一根 = last(決定位階)
const mkArr = (lo, hi, last) => {
    const a = Array.from({ length: 240 }, (_, i) => {
        const c = lo + (hi - lo) * (i / 239);
        return { date: `2026/01/${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c, volume: 1000 };
    });
    a[a.length - 1] = { ...a[a.length - 1], close: last };
    return a;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._cbParityState, null, { timeout: 20000 });

const run = (cp, arr) => page.evaluate(([c, a]) => app._cbParityState('9999', { cp: c }, a), [cp, arr]);

// ── ① 高位階 + 剛過轉換價(parity ~110)→ 要報警、要扣分 ─────────────
let r = await run(100, mkArr(60, 110, 110));     // 位階 100%、parity 110
ok('① 高位階+剛過轉換價 → 有扣分', r && r.score <= -10, JSON.stringify(r));
ok('① 要出現 ⛔ 警示(不可用 🔴,那是漲跌方向)', /⛔/.test(r.line) && !/🔴/.test(r.line), r.line);
ok('① 文案要帶實測數字 −5.76% / 24.0%', /5\.76/.test(r.line) && /24\.0/.test(r.line), r.line);
ok('① 要給對策', /對策/.test(r.line), r.line);

// ── ② 高位階 + 120~150(實測最差那格)→ 扣更多、帶 −7.20 / −17.57 ────
r = await run(100, mkArr(60, 130, 130));         // parity 130
ok('② 出貨區扣分要比「剛過」更重', r && r.score <= -18, JSON.stringify(r));
ok('② 帶實測最差數字 −7.20% / −17.57%', /7\.20/.test(r.line) && /17\.57/.test(r.line), r.line);

// ── ③ 高位階 + 還沒過轉換價 → ⛔ 絕不可寫成買訊 ──────────────────
r = await run(150, mkArr(60, 120, 120));         // parity 80、位階 100%
ok('③ 沒過轉換價 → 不扣分', r && r.score === 0, JSON.stringify(r));
ok('③ ⭐ ⛔ 不可出現買訊字眼', !/可以買|進場|買點|加碼|布局|逢低承接/.test(r.line),
   (r.line.match(/可以買|進場|買點|加碼|布局|逢低承接/g) || []).join(','));
ok('③ ⭐ 必須明寫「這不是買訊」', /不是買訊/.test(r.line), r.line);
ok('③ 要帶實測 −0.29%(約略打平),不可吹成有利', /0\.29/.test(r.line), r.line);
ok('③ 要顯示還差幾 %', /還差/.test(r.line), r.line);

// ── ④ 低位階 → ⛔ 即使過了轉換價也不可報警(實測那格沒邊際)───────────
r = await run(50, mkArr(40, 200, 60));           // 位階 12.5%、parity 120
ok('④ 低位階即使 parity>100 也不扣分', r && r.score === 0, JSON.stringify(r));
ok('④ 低位階不可報 ⛔ 警示', !/⛔ <b/.test(r.line), r.line);
ok('④ 要說明「只有高檔才算數」', /高檔/.test(r.line), r.line);

// ── ⑤ 沒有轉換價 / 沒有日 K → 回 null,不硬掰 ────────────────────
ok('⑤ 沒有 cb 資料 → null', (await page.evaluate(() => app._cbParityState('9999', null, []))) === null);
ok('⑤ cp=0 → null', (await run(0, mkArr(60, 110, 110))) === null);
ok('⑤ 日 K 不足 → null', (await run(100, mkArr(60, 110, 110).slice(0, 20))) === null);

// ── ⑥ 一定要真的接進籌碼乾淨度(不是孤兒函式)────────────────────
const wired = await page.evaluate(() => {
    const s = app.renderChipCleanliness.toString();
    return { call: s.includes('_cbParityState'), min: /Math\.min\(cbScore/.test(s) };
});
ok('⑥ renderChipCleanliness 有呼叫 _cbParityState', wired.call);
// ⭐ 用 Math.min 是刻意的:餘額大減(−6)與換股期(−14/−18)是兩件事,取較嚴重那個,
//    ⛔ 不可相加(會重複計分,同一件事扣兩次)。
ok('⑥ ⭐ 兩個可轉債訊號要取較嚴重者,⛔ 不可相加重複扣分', wired.min);

ok('⑦ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ CBPARITY_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ CBPARITY_TEST_PASS');
