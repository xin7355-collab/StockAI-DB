#!/usr/bin/env node
/**
 * 🔮 美股期貨「有價位沒方向」要誠實說(V72.0.5)
 *
 * 實測 gh-pages 的 macro_risk.json(2026-08-04):
 *   es_fut = 7479.5 ・es_fut_chg_pct = null ・es_fut_error = null
 *   nq_fut / ym_fut 一模一樣 → **三支期貨長期都只有價位、沒有方向**。
 *
 * 「不給方向」本身是**正確的設計**(採礦端拿不到「上一個結算」基準時,
 *  寧可不給也不給反的 —— test_yf_no_regress ⑮ 已釘住)。
 * ⛔ 但前端原本只顯一個光禿禿的價位、什麼都不說:
 *   使用者無從分辨「還沒抓到」vs「刻意不給」,
 *   而卡片下方那句「🔮 美股期貨=隔日開盤風向」沒有方向就等於失效。
 *
 * ⭐ 這支釘住:有價位但沒有漲跌% → 必須標「方向待確認」,⛔ 不可靜默。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderMarketBriefing, null, { timeout: 20000 });

// gCell 是 renderMarketBriefing 內的區域函式 → 從函式原始碼把它取出來單獨跑
// ⛔ 別在測試裡複製一份判定邏輯(那會變成第二份真相,程式改了測試還是綠的)
const cell = (val, chg) => page.evaluate(a => {
    const src = app.renderMarketBriefing.toString();
    const i = src.indexOf('const gCell = (label, val, chg) =>');
    const j = src.indexOf('\n        };', i);
    // eslint-disable-next-line no-new-func
    const gPct = c => (c == null || isNaN(c)) ? '' : `${+c >= 0 ? '+' : ''}${(+c).toFixed(2)}%`;
    // ⚠️ slice(i, j) 的結尾**不含**那個 `};`(j 指向 '\n        };' 的開頭)→ 要自己補回去
    const fn = new Function('gPct', src.slice(i, j) + '\n};\n return gCell;')(gPct);
    return fn('🔮 標普期', a.val, a.chg);
}, { val, chg });

// ── ① ⭐ 有價位、沒方向 → 必須標「方向待確認」──────────────────
let h = await cell(7479.5, null);
ok('① ⭐ 有價無方向 → 要標「方向待確認」', /方向待確認/.test(h), h);
ok('① 價位仍要顯示出來(⛔ 不因為沒方向就整格空掉)', /7,480|7,479/.test(h), h);
ok('① ⛔ 不可顯示假的 0.00%', !/0\.00%/.test(h), h);
ok('① 要有 title 說明為什麼(寧可不給也不給反的)',
   /title="[^"]*寧可不給[^"]*"/.test(h), h);
ok('① ⛔「方向待確認」不可用紅綠(它不是漲跌)',
   !/text-(red|green)-\d+[^"]*">・方向待確認|方向待確認[\s\S]{0,20}text-(red|green)/.test(h), h);

// ── ② 正常有方向 → 照舊顯示 %,⛔ 不可多出「待確認」──────────────
h = await cell(7479.5, 0.43);
ok('② 有方向 → 顯示 +0.43%', /\+0\.43%/.test(h), h);
ok('② ⛔ 有方向時不可出現「方向待確認」', !/方向待確認/.test(h), h);
ok('② 漲用紅色(台股色)', /text-red-300[^>]*>\+0\.43%/.test(h), h);
h = await cell(7479.5, -1.2);
ok('② 跌用綠色(台股色)', /text-green-300[^>]*>−1\.20%|text-green-300[^>]*>-1\.20%/.test(h), h);

// ── ③ 完全沒資料 → 顯「採集中」(既有行為不可退化)──────────────
h = await cell(null, null);
ok('③ 無價無方向 → 採集中', /採集中/.test(h), h);
ok('③ ⛔ 不可出現「方向待確認」(那是「有價」才用的)', !/方向待確認/.test(h), h);

// ── ④ 只有方向沒有價位(理論上不會,但不可崩)────────────────────
h = await cell(null, 0.5);
ok('④ 只有方向 → 顯示 -- 加 %', /--/.test(h) && /\+0\.50%/.test(h), h);
ok('④ ⛔ 不可標「方向待確認」', !/方向待確認/.test(h), h);

// ── ⑤ 三支期貨都走同一個 gCell(⛔ 別有人另外寫一份)──────────────
const src = await page.evaluate(() => app.renderMarketBriefing.toString());
for (const k of ['es_fut', 'ym_fut', 'nq_fut']) {
    ok(`⑤ ${k} 走 gCell`, new RegExp(`gCell\\([^)]*mr\\.${k},\\s*mr\\.${k}_chg_pct`).test(src), '');
}

ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ FUTDIR_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ FUTDIR_TEST_PASS');
