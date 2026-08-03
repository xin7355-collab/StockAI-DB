#!/usr/bin/env node
/**
 * 🫗 買盤竭盡(籌碼版)測試(V72.0.2)
 *
 * 使用者:「買盤竭盡的部分如果缺成交量那就補籌碼」。
 *
 * 他的原始機制是**盤中逐秒**的(每 5 秒內外盤 PK、多方連 N 次獲勝後出現第一次內盤大量),
 * 我沒有逐秒序列(連次量已驗兩次不成立),但 `tick_flow.json` 有當日真實逐筆聚合:
 *   out=外盤(主動買) ・in=內盤(主動賣) ・bb=大單買 ・bs=大單賣
 * → 做它的**本質**:「小單在追買、大單在倒貨」。
 * ⭐ 他自己也說「不能看到買盤竭盡就空,還要研究籌碼」,所以直接把籌碼結構攤開給使用者看。
 *
 * ⛔ 這支最重要的任務:**擋住有人把它變成買賣訊號**。
 *    tick_flow 是每天覆蓋的快照、沒有歷史 → 預測力**未經驗證**。
 *    V72.0.2 起才開始累積 tick_hist,累積夠並回測過之前只能做事實描述。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._buyExhaust, null, { timeout: 20000 });

// 直接餵 tick_flow 快取 + 假裝盤中(_realInOut 有盤中守門)
const run = ({ out, inn, bb, bs, fresh = true, marketOpen = true }) => page.evaluate(a => {
    app._tickFlowCache = {
        updated: new Date(Date.now() - (a.fresh ? 60000 : 40 * 60000)).toISOString(),
        data: { '2330': { in: a.inn, out: a.out, bb: a.bb, bs: a.bs, mx: 100, n: 9999 } },
    };
    app.isMarketOpen = () => a.marketOpen;
    return { r: app._buyExhaust('2330'), html: app._buyExhaustHtml('2330') };
}, { out, inn, bb, bs, fresh, marketOpen });

// ── ① 買盤竭盡:外盤佔優(60%)但大單淨賣 ─────────────────────
let x = await run({ out: 6000, inn: 4000, bb: 200, bs: 800 });   // 外盤 60%、大單淨 −60%
ok('① 判定為 exhaust', x.r && x.r.kind === 'exhaust', JSON.stringify(x.r));
ok('① 外盤佔比算對(60%)', /60%/.test(x.html), x.html.slice(0, 300));
ok('① 要顯示大單買/賣張數', /200/.test(x.html) && /800/.test(x.html), x.html.slice(0, 400));
ok('① ⭐ 要點出「小單在買、大單在倒」的本質', /小單在買.{0,3}大單在倒/.test(x.html), x.html.slice(0, 600));
ok('① 要引用他「不能看到就空,還要研究籌碼」', /還要研究籌碼/.test(x.html), x.html.slice(0, 700));

// ── ② ⭐ 最關鍵:⛔ 不可下方向、必須標未驗證 ──────────────────
// ⚠️ 「不是買賣訊號」這句**本身含「賣訊」二字**,那是正確的免責寫法 → 比對前先拿掉
//    (同 test_tdcc4 / test_trustvol 的做法)。⛔ 別把測試放寬成不檢查。
const strip = h => h.replace(/不是買賣訊號/g, '').replace(/(?:不是|並非)\s*[「『]?(?:買訊|賣訊)[」』]?/g, '');
const BAD = /買訊|賣訊|該空|可以空|建議空|會跌|會漲|進場|加碼/;
ok('② ⭐ ⛔ 不可出現方向性指令', !BAD.test(strip(x.html)), (strip(x.html).match(BAD) || []).join(','));
ok('② ⭐ 必須明寫「還沒有驗證過預測力」', /還沒有驗證過預測力/.test(x.html), x.html.slice(0, 900));
ok('② ⭐ 必須明寫「不是買賣訊號」', /不是買賣訊號/.test(x.html), x.html.slice(0, 900));
ok('② 要說明何時會驗(累積約 3 個月)', /3 個月|累積夠/.test(x.html), x.html.slice(0, 900));
ok('② 要說明只有熱門股才有逐筆', /冷門股不顯示|前 80 名/.test(x.html), x.html.slice(0, 900));

// ── ③ 反向:賣盤竭盡(小單殺、大單接)─────────────────────────
x = await run({ out: 4000, inn: 6000, bb: 900, bs: 100 });
ok('③ 判定為 absorb', x.r && x.r.kind === 'absorb', JSON.stringify(x.r));
ok('③ 要說明「小單在殺、大單在接」', /小單在殺.{0,3}大單在接/.test(x.html), x.html.slice(0, 600));
ok('③ ⛔ 一樣不可下方向', !BAD.test(strip(x.html)), (strip(x.html).match(BAD) || []).join(','));

// ── ④ 沒有明顯結構 → 不顯(條件觸發、不佔版面)────────────────
ok('④ 外盤 50% + 大單持平 → 不顯', (await run({ out: 5000, inn: 5000, bb: 500, bs: 500 })).html === '');
ok('④ 外盤高但大單也是買 → 不顯(不是竭盡)', (await run({ out: 6000, inn: 4000, bb: 800, bs: 200 })).html === '');
ok('④ 外盤高、大單只微賣(−10%) → 不顯', (await run({ out: 6000, inn: 4000, bb: 450, bs: 550 })).html === '');

// ── ⑤ 沒有大單 → ⛔ 不可硬判 ────────────────────────────
ok('⑤ 完全沒有大單 → null', (await run({ out: 6000, inn: 4000, bb: 0, bs: 0 })).html === '');

// ── ⑥ 守門:盤後 / 資料過期 → 不用(⛔ 不拿殘值硬算)───────────
ok('⑥ ⭐ 收盤後不顯示(_realInOut 有盤中守門)',
   (await run({ out: 6000, inn: 4000, bb: 200, bs: 800, marketOpen: false })).html === '');
ok('⑥ ⭐ 資料過期 40 分 → 不顯示',
   (await run({ out: 6000, inn: 4000, bb: 200, bs: 800, fresh: false })).html === '');

// ── ⑦ 沒有 tick_flow 資料 → null ────────────────────────
ok('⑦ 沒有快取 → null', (await page.evaluate(() => {
    app._tickFlowCache = null; return app._buyExhaust('2330');
})) === null);
ok('⑦ 此股不在逐筆名單 → null', (await page.evaluate(() => {
    app._tickFlowCache = { updated: new Date().toISOString(), data: { '2317': { in: 1, out: 9, bb: 0, bs: 9 } } };
    app.isMarketOpen = () => true;
    return app._buyExhaust('2330');
})) === null);

// ── ⑧ 真的接進當沖頁 ────────────────────────────────────
const wired = await page.evaluate(() => /_buyExhaustHtml/.test(app.renderDayTradeTab.toString()));
ok('⑧ renderDayTradeTab 有呼叫', wired);

// ── ⑨ 採礦端有開始累積歷史(否則永遠驗不了)────────────────────
ok('⑨ ⭐ 註解要指出 tick_hist 正在累積', /tick_hist/.test(await page.evaluate(() => app._buyExhaust.toString())));

ok('⑩ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ BUYEXHAUST_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ BUYEXHAUST_TEST_PASS');
