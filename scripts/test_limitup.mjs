#!/usr/bin/env node
/**
 * ⚡ 漲停隔日動能 + 週轉率 測試(V72.0.1)
 *
 * 逐字稿【當沖必看的三大指標】= 週轉率 / 連次量 / 籌碼。
 * 連次量已驗兩次不成立、籌碼已做 → 只剩**週轉率**。
 *
 * `turnover_probe.py` 實測 2,402 檔、227,412 事件(對照組勝率 44.3%):
 *   ❌ 他說「昨天小漲小跌 + 今天高週轉 = 今天不錯」→ 不成立(−0.09~−0.20pp)
 *   ✅ 真正有東西的是「漲停隔日動能」,且週轉率決定強弱:
 *      低 <1% +0.82%/53.5% ・**中 1~3% +1.54%/56.7%** ・高 3~8% +1.13%/56.1% ・極高 ≥8% +0.78%/53.9%
 *
 * 這支釘住四件事:
 *   ① 分級要對得上實測數字(⛔ 不可自己改成好聽的)
 *   ② ⭐ 必須寫明「只有隔天有效」—— 3/5 日邊際會轉負,拿去做波段是錯的
 *   ③ ⭐ 必須寫明基準勝率 44.3%,否則 56.7% 會被誤讀
 *   ④ 沒漲停 + 週轉率不高 → 完全不顯示(條件觸發、不佔版面)
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._limitUpMomentum, null, { timeout: 20000 });

const TOT = 1e9;   // 總股數 10 億
// chgPct: 今天相對昨天的漲跌幅;turnPct: 想要的週轉率 → 成交量 = TOT × turn%
const run = (chgPct, turnPct, hasShares = true) => page.evaluate(a => {
    const c1 = 100, c0 = 100 * (1 + a.chg / 100);
    const vol = a.tot * a.turn / 100;
    const d = [{ date: '2026/07/29', open: 99, high: 100, low: 98, close: 99, volume: 1e6 },
               { date: '2026/07/30', open: c1, high: c1, low: c1, close: c1, volume: 1e6 },
               { date: '2026/07/31', open: c0, high: c0, low: c0, close: c0, volume: vol }];
    app._tdccHoldersCache = a.hasShares ? { '2330': { t: a.tot } } : {};
    return { r: app._limitUpMomentum('2330', d), html: app._limitUpMomentumHtml('2330', d) };
}, { chg: chgPct, turn: turnPct, tot: TOT, hasShares });

// ── ① 漲停 × 各週轉率分級:分級邏輯(r.z)仍要對得上實測,但數字⛔ 不印給散戶看 ──
// 🧹 V78.3.6 散戶 App 不印實測數字(+1.54%/56.7%、實測最強、基準 44.3%、227,412 筆)→
//    分級數字改驗**邏輯物件** r.z(判斷一行沒改),畫面改驗「白話分級標籤 + ⛔ 不出現研究數字」
const RES = /實測|回測|勝率|期望值|基準|對照組|樣本|\d+(\.\d+)?%\s*\/|44\.3|227,412|pp\b/;   // ⚠️ 不擋「+10.0%」—— 那是今天的漲幅(事實),研究數字另外逐一比
const plain = h => h.replace(/<[^>]+>/g, '');
let x = await run(10, 2);           // 漲停 + 中週轉(1~3%)= 實測最強
ok('① 漲停+中週轉 → 判 limitup', x.r && x.r.kind === 'limitup', JSON.stringify(x.r));
ok('① ⭐ 中週轉的分級仍是實測最強那格(r.z.e=1.54 / w=56.7),畫面標「(中)」(🧹 V78.3.6)',
   x.r && x.r.z && x.r.z.e === 1.54 && x.r.z.w === 56.7 && /週轉率 2\.0%\(中\)/.test(plain(x.html)), JSON.stringify(x.r && x.r.z));
ok('① ⛔ 畫面不印實測數字 / 「實測最強」字樣(🧹 V78.3.6)', !RES.test(plain(x.html)) && !/1\.54|56\.7/.test(x.html), plain(x.html).slice(0, 400));

x = await run(10, 0.5);             // 低週轉
ok('① 低週轉 → 分級 0.82/53.5、畫面標「(低)」⛔ 不印數字', x.r?.z?.e === 0.82 && x.r?.z?.w === 53.5 && /\(低\)/.test(plain(x.html)) && !/0\.82|53\.5/.test(x.html), plain(x.html).slice(0, 400));
x = await run(10, 5);               // 高週轉
ok('① 高週轉 → 分級 1.13/56.1、畫面標「(高)」⛔ 不印數字', x.r?.z?.e === 1.13 && x.r?.z?.w === 56.1 && /\(高\)/.test(plain(x.html)) && !/1\.13|56\.1/.test(x.html), plain(x.html).slice(0, 400));
x = await run(10, 12);              // 極高週轉 → 衰減
ok('① 極高週轉 → 分級 0.78/53.9、⛔ 不印數字', x.r?.z?.e === 0.78 && x.r?.z?.w === 53.9 && !/0\.78|53\.9/.test(x.html), plain(x.html).slice(0, 400));
ok('① ⭐ 極高週轉要標「換手太兇會衰減」(他那半句是對的)',
   /換手太兇/.test(x.html), x.html.slice(0, 400));

// ── ② ⭐ 必須寫明「只看隔天」──────────────────────────
x = await run(10, 2);
ok('② ⭐ 必須寫明只看隔天(🧹 V78.3.6 白話「只看隔天」)', /只看隔天|只有.{0,3}隔天有效/.test(plain(x.html)), plain(x.html).slice(0, 700));
// 🧹 V78.3.6「3/5 日邊際轉負」是回測研究結論 → 改釘:⛔ 不可出現那句研究字樣
ok('② ⛔ 不印「3 日、5 日邊際轉負」研究字樣(🧹 V78.3.6)', !/邊際|轉負/.test(plain(x.html)), plain(x.html).slice(0, 700));
ok('② ⭐ ⛔ 必須明說別當波段理由', /別拿它當波段理由|不可拿來當波段/.test(x.html), x.html.slice(0, 700));
// 🧹 V78.3.6「當沖來回成本 0.25%」改成指路當沖頁的賣法規則
ok('② 鎖漲停的持股要指路「隔天照當沖頁那幾條規則賣」(🧹 V78.3.6 取代 0.25% 成本句)', /當沖頁那幾條規則賣/.test(plain(x.html)), plain(x.html).slice(0, 700));

// ── ③ ⛔ 不印基準勝率 / 樣本數(🧹 V78.3.6)────────────────
ok('③ ⛔ 不印基準 44.3% / 樣本數 227,412 / 任何研究字樣(🧹 V78.3.6)', !RES.test(plain(x.html)), plain(x.html).slice(0, 700));
ok('③ 要寫明「非保證」', /非保證/.test(x.html), x.html.slice(0, 900));
ok('③ 要說明週轉率怎麼算 + 用總股數的偏差', /總發行股數/.test(x.html) && /略低估/.test(x.html), x.html.slice(0, 900));

// ── ④ 條件觸發:沒漲停 + 週轉不高 → 完全不顯 ──────────────────
ok('④ 平盤 + 低週轉 → 不顯示', (await run(0.5, 1)).html === '');
ok('④ 大漲但沒漲停(+5%) + 中週轉 → 不顯示', (await run(5, 2)).html === '');
ok('④ 下跌 + 低週轉 → 不顯示', (await run(-3, 0.8)).html === '');

// ⭐ 沒漲停但換手過熱 → 顯提醒,且⛔不可說成利多
x = await run(2, 12);
ok('④ 沒漲停+極高週轉 → 判 hot', x.r && x.r.kind === 'hot', JSON.stringify(x.r));
ok('④ ⭐ 換手過熱⛔不可講成動能/利多',
   /沒有.{0,3}正邊際|不是動能/.test(x.html) && !/隔日動能/.test(x.html), x.html.slice(0, 500));
ok('④ 要勸阻「別因為量大就進場」', /別因為/.test(x.html), x.html.slice(0, 500));

// ── ⑤ 沒有股數資料 → 仍可講漲停,但⛔不可假裝有週轉率 ──────────
x = await run(10, 2, false);
ok('⑤ 沒股數仍判 limitup', x.r && x.r.kind === 'limitup', JSON.stringify(x.r));
ok('⑤ ⭐ 沒股數 → 誠實說無法算週轉率', /無法算週轉率/.test(x.html), x.html.slice(0, 400));
ok('⑤ ⛔ 不可硬掰出週轉率數字', !/週轉率 \d/.test(x.html), x.html.slice(0, 400));

// ── ⑥ 資料不足 → null ─────────────────────────────────
ok('⑥ 資料不足 → null', (await page.evaluate(() => app._limitUpMomentum('2330', []))) === null);

// ── ⑦ 真的接進當沖頁,而且置頂 ────────────────────────────
const wired = await page.evaluate(() => {
    const s = app.renderDayTradeTab.toString();
    const i = s.indexOf('_limitUpMomentumHtml'), j = s.indexOf('const detail = []');
    return { has: i > 0, beforeDetail: i > 0 && j > 0 && i < j };
});
ok('⑦ renderDayTradeTab 有呼叫', wired.has);
ok('⑦ ⭐ 置頂(在其他卡之前)', wired.beforeDetail);

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ LIMITUP_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ LIMITUP_TEST_PASS');
