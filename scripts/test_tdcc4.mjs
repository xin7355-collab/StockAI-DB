#!/usr/bin/env node
/**
 * 🧊 「兩上兩下」籌碼四因子測試(V71.9.0)
 *
 * 背景:使用者提供的 113 份逐字稿裡,權證小哥自述的選股順序是
 *   大戶↑ ・ 主力↑ ・ 散戶↓ ・ 融資↓(觀察半年到一年)。
 * 照鐵則「探針先行、實測不猜」,先跑 `tdcc_probe.py` 用自己的資料驗:
 *   7,221 個事件 / 8 種組合,「大戶↑・散戶↓・融資↓」排第 1(20 日 +0.00%、勝率 50.1%),
 *   但拆解後發現 **融資方向做掉大部分的工作**(四個融資↓全在前段、四個融資↑全在後段)。
 *   而且第 1 名只是「打平大盤」不是「會賺」(同期中位數個股輸大盤 1.85%)。
 *
 * 這支測試把上面幾件事釘死,免得日後有人把文案改成「會賺」或把限制拿掉:
 *   ① 三項因子各自的 ✅/❌/⏳ 要跟資料對得起來
 *   ② 結論必須帶**實測數字**,且 ⛔ 不可出現「會賺 / 保證 / 必漲」
 *   ③ 必須點名「融資是最關鍵那項」
 *   ④ 必須揭露 13 週的硬限制
 *   ⑤ 沒有集保資料時要回 '',不可硬掰
 *   ⑥ 卡片要真的出現在籌碼分佈頁(不是只有函式活著)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${String(extra).slice(0, 220)}`}`);
    if (!cond) fails.push(name);
};

// 集保列格式:[YYYYMMDD, 大戶%, 中實戶%, 散戶%, 股東數]
const mkTdcc = (bigPrev, bigNow, retPrev, retNow) => ({
    '2330': { t: 25930000000, h: [[20260718, bigPrev, 10, retPrev, 500000], [20260725, bigNow, 10, retNow, 499000]] },
});
const mkDaily = (mgNow, mgPrev) => Array.from({ length: 8 }, (_, i) => ({
    date: `2026/07/${String(20 + i).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100, volume: 10000,
    margin_balance: i === 7 ? mgNow : (i === 2 ? mgPrev : mgPrev),
}));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const errs = [];
// file:// 離線載入時 CDN(echarts/tailwind)拿不到,那不是本次要測的東西
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._tdccFourFactor, null, { timeout: 20000 });

const run = (tdcc, daily) => page.evaluate(([t, d]) => {
    app._tdccHoldersCache = t;
    app.rawDailyData = d;
    return { f: app._tdccFourFactor('2330'), html: app._tdccFourFactorHtml('2330') };
}, [tdcc, daily]);

// ── ① 三項全過 ─────────────────────────────────────────────
let r = await run(mkTdcc(60.0, 61.5, 25.0, 23.8), mkDaily(900, 1000));
ok('① 大戶上升 → bigUp=true', r.f && r.f.bigUp === true, JSON.stringify(r.f));
ok('① 散戶下降 → retDown=true', r.f && r.f.retDown === true, JSON.stringify(r.f));
ok('① 融資減少 → mgDir=down', r.f && r.f.mgDir === 'down', JSON.stringify(r.f));
ok('① hits=3', r.f && r.f.hits === 3, JSON.stringify(r.f));
ok('① 三項全過時三個 ✅', (r.html.match(/✅/g) || []).length >= 3, r.html.slice(0, 200));

// ⭐ 最重要的一條:結論必須帶實測數字,而且⛔不可講成「會賺」
ok('② 結論帶實測數字(+0.00% / 50.1%)', /\+0\.00%/.test(r.html) && /50\.1%/.test(r.html), r.html);
// ⚠️ 卡片上「不是『會賺』」「不是保證」是**否定句**,那是對的寫法 → 比對前先把否定式拿掉,
//    只抓真正的正面宣稱。⛔ 別把測試放寬成不檢查(那條正是這張卡最容易被改壞的地方)。
const positive = h => h.replace(/(?:不是|並非|而非|絕非)\s*[「『]?\s*(?:會賺|保證|必漲|穩賺|一定漲)\s*[」』]?/g, '');
ok('② ⛔ 不可正面宣稱「會賺 / 保證 / 必漲 / 穩賺」',
   !/會賺|保證|必漲|穩賺|一定漲/.test(positive(r.html)),
   (positive(r.html).match(/會賺|保證|必漲|穩賺|一定漲/g) || []).join(','));
ok('② 要講明是「打平」不是贏', /打平/.test(r.html), r.html.slice(0, 300));
ok('② 要揭露同期中位數個股輸大盤 1.85%', /1\.85/.test(r.html), r.html.slice(0, 400));
ok('③ 必須點名融資是最關鍵那項', /最關鍵/.test(r.html), r.html.slice(0, 400));
ok('④ 必須揭露 13 週硬限制', /13\s*週/.test(r.html), r.html.slice(0, 600));
ok('④ 必須揭露倖存者偏誤(不含已下市)', /已下市/.test(r.html), r.html.slice(0, 600));
ok('④ 必須寫非投資建議', /非投資建議/.test(r.html));

// ── ⑤ 融資還在增 → 最差那組,文案要講「基本上無效」──────────────
r = await run(mkTdcc(60.0, 61.5, 25.0, 23.8), mkDaily(1100, 1000));
ok('⑤ 融資增加 → mgDir=up、hits=2', r.f.mgDir === 'up' && r.f.hits === 2, JSON.stringify(r.f));
ok('⑤ 融資↑ 要帶實測墊底數字(−2.21~−2.60)',
   /2\.21/.test(r.html) && /2\.60/.test(r.html), r.html.slice(0, 500));
ok('⑤ 融資↑ 要明說這套選股法無效', /無效/.test(r.html), r.html.slice(0, 500));

// ── ⑥ 大戶↓散戶↑ 但融資↓ → 中間那檔,不可顯示成三項全過 ────────
r = await run(mkTdcc(61.5, 60.0, 23.8, 25.0), mkDaily(900, 1000));
ok('⑥ 大戶下降/散戶上升 → hits=1', r.f.hits === 1 && !r.f.bigUp && !r.f.retDown, JSON.stringify(r.f));
ok('⑥ 不可誤標成三項全過', !/三項全過/.test(r.html), r.html.slice(0, 200));

// ── ⑦ 沒有融資資料 → ⏳ 而不是判成過關 ─────────────────────
r = await page.evaluate(t => {
    app._tdccHoldersCache = t; app.rawDailyData = [];
    return { f: app._tdccFourFactor('2330'), html: app._tdccFourFactorHtml('2330') };
}, mkTdcc(60.0, 61.5, 25.0, 23.8));
ok('⑦ 沒有日 K → mgDir=null(不當作過關)', r.f && r.f.mgDir === null, JSON.stringify(r.f));
ok('⑦ 沒有融資資料要顯 ⏳', /⏳/.test(r.html), r.html.slice(0, 300));

// ── ⑧ 沒有集保資料 → 回 '',⛔ 不可硬掰 ────────────────────
r = await page.evaluate(() => {
    app._tdccHoldersCache = {}; app.rawDailyData = [];
    return { f: app._tdccFourFactor('9999'), html: app._tdccFourFactorHtml('9999') };
});
ok('⑧ 沒有集保資料 → null / 空字串', r.f === null && r.html === '', JSON.stringify(r));

// ── ⑨ 卡片要真的接進籌碼分佈頁(不是孤兒函式)────────────────
const wired = await page.evaluate(() => {
    const src = app._renderChipDistribution.toString();
    return { call: src.includes('_tdccFourFactorHtml'), letHtml: /\blet html\s*=/.test(src) };
});
ok('⑨ _renderChipDistribution 有呼叫 _tdccFourFactorHtml', wired.call);
// ⭐ 順手釘住同一段的舊 bug:`const html` + 後面 `html += idHtml` → TypeError 被 catch 吞掉,
//    V69.8.1 的「持股身份分布」因此從沒顯示過。改 let 之後不准再被改回 const。
ok('⑨ ⭐ html 必須是 let(後面有 html += idHtml,const 會被靜默吞掉)', wired.letHtml);

ok('⑩ 全程無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ TDCC4_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ TDCC4_TEST_PASS');
