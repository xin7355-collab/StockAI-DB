#!/usr/bin/env node
/**
 * 👩 投量比(投信買超 ÷ 當日成交量)測試(V71.9.5)
 *
 * 逐字稿他更正了常見誤用:「坊間一堆投本比(占股本),但這是占成交量,那叫投量比」,
 * 並舉例「成交量 205 張、投信買 40 張 → 上不了排行榜,但佔了 20%」。
 *
 * ⛔ 這支最重要的任務是**擋住日後有人把它變成買賣訊號**:
 *    `trust_probe.py` 實測發現 trust_net>0 的列全部落在 2026 年(169 萬列裡只有 8,818 列),
 *    根本做不出分桶統計 → 預測力**未經驗證**。
 *    所以顯示層只准做單位換算、不准下方向,而且必須誠實寫「還沒驗證過」。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._trustVolRatioNote, null, { timeout: 20000 });

const run = bars => page.evaluate(a => { app.rawDailyData = a; return app._trustVolRatioNote(); }, bars);
const bar = (d, vol, tn) => ({ date: d, open: 10, high: 10, low: 10, close: 10, volume: vol, trust_net: tn });

// ── ① 他舉的那個例子:成交 205 張、投信買 40 張 → 20% ──────────────
let h = await run([bar('2026/07/29', 100000, 0), bar('2026/07/30', 205000, 40000)]);
ok('① 205 張成交、投信買 40 張 → 投量比 19.5%', /19\.5%/.test(h), h);
ok('① 要顯示原始張數(40 張)讓人對得起來', /40 張/.test(h), h);
ok('① 佔比高 → 標示出來', /佔比不低/.test(h), h);

// ── ② ⭐ 最關鍵:⛔ 絕不可下方向判斷 ────────────────────────
// ⚠️ 同 test_tdcc4 的教訓:教學裡「投量比高**會不會漲**我還沒驗證過」是**免責句**,是對的寫法。
//    比對前先拿掉這類疑問/否定句式,只抓真正的正面主張。⛔ 別把測試放寬成不檢查。
const positive = t => t
    .replace(/會不會漲/g, '')
    .replace(/(?:不是|並非|而非|絕非)\s*[「『]?\s*(?:買訊|賣訊|買賣訊號|建議)\s*[」』]?/g, '');
const BAD = /買訊|賣訊|會漲|看好|建議買|可以買|加碼|布局|強勢|偏多|偏空/;
ok('② ⭐ ⛔ 不可正面下方向', !BAD.test(positive(h)), (positive(h).match(BAD) || []).join(','));

// ── ③ ⭐ 教學必須誠實說「還沒驗證過預測力」──────────────────
ok('③ ⭐ 必須寫明還沒驗證', /還沒驗證過/.test(h), h);
ok('③ 要說明為什麼(資料 2026 才開始)', /2026/.test(h), h);
ok('③ 要說明「不是買賣訊號」', /不是買賣訊號/.test(h), h);
ok('③ 要說明日後怎麼處理(累積滿一年再驗)', /滿一年|累積滿/.test(h), h);
ok('③ 要解釋為什麼不看張數(他的核心論點)', /排行榜/.test(h), h);

// ── ④ 大型股:投信買很多張但佔比很小 → 不標「佔比不低」──────────
h = await run([bar('2026/07/30', 200000000, 1000000)]);   // 100 萬股 / 2 億股 = 0.5%
ok('④ 大型股佔比 0.5% → 算得出來', /0\.5%/.test(h), h);
ok('④ 佔比低 → ⛔ 不標「佔比不低」', !/佔比不低/.test(h), h);

// ── ⑤ 沒有投信買超 / 資料不足 → 回 '' ─────────────────────
ok('⑤ 投信賣超 → 空字串', (await run([bar('2026/07/30', 205000, -40000)])) === '');
ok('⑤ 投信 0 → 空字串', (await run([bar('2026/07/30', 205000, 0)])) === '');
ok('⑤ 沒有成交量 → 空字串', (await run([bar('2026/07/30', 0, 40000)])) === '');
ok('⑤ 空陣列 → 空字串', (await run([])) === '');
ok('⑤ ⭐ 只有 1 根 K 棒也要算得出來(本函式不需要前一根)', /19\.5%/.test(await run([bar('2026/07/30', 205000, 40000)])));
ok('⑤ 不足 1 張 → 空字串', (await run([bar('2026/07/30', 205000, 500)])) === '');

// ── ⑥ 法人資料落後 → 往回找,但不無限往回 ──────────────────
h = await run([bar('2026/07/28', 205000, 40000), bar('2026/07/29', 100000, 0), bar('2026/07/30', 100000, 0)]);
ok('⑥ 最後兩天沒投信 → 往回抓 07/28 那筆', /19\.5%/.test(h), h);
const far = [bar('2026/07/01', 205000, 40000)].concat(
    Array.from({ length: 10 }, (_, i) => bar(`2026/07/${String(10 + i).padStart(2, '0')}`, 100000, 0)));
ok('⑥ ⭐ 超過 6 根還沒有 → 不硬抓陳年資料', (await run(far)) === '');

// ── ⑦ 要真的接進法人圖表區(合併,⛔ 沒開新卡)───────────────
const wired = await page.evaluate(() => {
    const s = Object.getOwnPropertyNames(app).filter(k => typeof app[k] === 'function')
        .map(k => app[k].toString()).join('\n');
    return /instDateEl\.innerHTML[^\n]*_trustVolRatioNote/.test(s);
});
ok('⑦ ⭐ 併進「三大法人」圖表的資料日期列(沒開新卡)', wired);

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ TRUSTVOL_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ TRUSTVOL_TEST_PASS');
