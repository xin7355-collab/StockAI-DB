#!/usr/bin/env node
/**
 * 🎯 大盤 vs 中位數個股(V72.0.4)測試
 *
 * 來源:巨人傑逐字稿「加權指數幾乎就等於台積電」。
 *
 * ⛔ 這支最重要的任務是**擋住兩件事**:
 *   ① 有人日後把它「優化」成推估台積電權重 —— 官方權重用流通股數,我只有總股數,
 *      推出來會錯而且很難察覺(實測我自己加總含上櫃+ETF 是 150.7 兆、2330 佔 37.95%,
 *      跟官方口徑不同)。中位數才是零假設的做法。
 *   ② 把「落差」用紅綠上色 —— 落差是**方向差**不是漲跌,用紅綠會跟台股語意打架
 *      (同 CLAUDE.md 燈號鐵則:🔴🟢 只准表示漲跌方向)。
 *
 * 實測基準(採礦端真資料,248 個交易日):
 *   大盤平均每天贏中位數個股 +0.40pp、60% 的天數大盤贏。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._medGapState, null, { timeout: 20000 });

// 造 N 天歷史:idx 固定比 med 高 gapPP(除非 flip 指定反向天數)
const hist = (n, gapPP, flipN = 0) => Array.from({ length: n }, (_, i) => ({
    d: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
    med: 0.10, idx: 0.10 + (i < flipN ? -gapPP : gapPP), total: 2300,
    up: 1000, dn: 1000, flat: 300, lu: 5, ld: 5, st: 100, wk: 100, amt: 4000,
}));

const run = ({ h = hist(60, 0.4), live = null, taiex = null }) => page.evaluate(a => {
    app._breadthHist = a.h;
    app._liveQuotes = a.live;
    app._taiexTodayPct = a.taiex;
    return { s: app._medGapState(), html: app._medGapHtml() };
}, { h, live, taiex });

// ── ① 盤後:讀 breadth 最後一筆 ──────────────────────────────
let x = await run({ h: [...hist(59, 0.4), { d: '2026-07-30', med: -1.02, idx: -0.26, total: 2314 }] });
ok('① 盤後用 breadth 最後一筆', x.s && x.s.med === -1.02 && x.s.idx === -0.26, JSON.stringify(x.s));
ok('① 落差算對(−0.26 −(−1.02) = +0.76)', Math.abs(x.s.gap - 0.76) < 1e-9, x.s.gap);
ok('① live=false', x.s.live === false);
ok('① 要顯示「收盤 2314 檔」', /收盤 2314 檔/.test(x.html), x.html.slice(0, 400));
ok('① ⭐ 落差 +0.76 < 1 → 判「方向一致」', /方向一致/.test(x.html), x.html.slice(0, 900));

// ── ② 盤中:用 _liveQuotes 現算中位數(優先於收盤檔)──────────
const mkLive = arr => Object.fromEntries(arr.map((c, i) => [`s${i}`, { c }]));
// 600 檔:300 檔 −2%、300 檔 +0% → 中位數 −1%
x = await run({ live: mkLive([...Array(300).fill(-2), ...Array(300).fill(0)]), taiex: 1.5 });
ok('② 盤中改用即時快照', x.s && x.s.live === true, JSON.stringify(x.s));
ok('② 中位數算對(−1%)', Math.abs(x.s.med - (-1)) < 1e-9, x.s.med);
ok('② idx 取 _taiexTodayPct', x.s.idx === 1.5, x.s.idx);
ok('② 要顯示「盤中即時 600 檔」', /盤中即時 600 檔/.test(x.html), x.html.slice(0, 400));

// ── ③ ⭐ 落差判讀三段 ──────────────────────────────────────
ok('③ ⭐ 落差 +2.5pp → 要說「被權值股拉上去的」', /被「?權值股拉上去/.test(x.html), x.html.slice(0, 900));
ok('③ ⭐ 要點出「指數好看不代表你手上那檔有跟到」', /不代表你手上那檔有跟到/.test(x.html), x.html.slice(0, 900));
x = await run({ live: mkLive([...Array(300).fill(2), ...Array(300).fill(4)]), taiex: -1 });
ok('③ 落差 −4pp → 要說「被權值股拖累」', /被權值股拖累/.test(x.html), x.html.slice(0, 900));

// ── ④ ⭐⛔ 落差不可用紅綠(方向差 ≠ 漲跌,同燈號鐵則)────────────
x = await run({ live: mkLive([...Array(300).fill(-2), ...Array(300).fill(0)]), taiex: 1.5 });
const gapCell = (x.html.match(/落差<\/div><div[^>]*>[\s\S]{0,120}/) || [''])[0];
ok('④ ⭐⛔ 落差數字不可用 text-red-/text-green-',
   !/text-(red|green)-\d/.test(gapCell), gapCell);
ok('④ 指數/中位數本身仍照台股色(紅漲綠跌)',
   /加權指數<\/div><div[^>]*text-red-300/.test(x.html) && /中位數個股<\/div><div[^>]*text-green-300/.test(x.html),
   x.html.slice(0, 900));

// ── ⑤ ⭐ 歷史基準:平均落差 + 大盤贏的天數% ────────────────────
x = await run({ h: hist(100, 0.4, 40) });   // 60 天 +0.4、40 天 −0.4 → 平均 +0.08、大盤贏 60%
ok('⑤ 平均落差算對(+0.08)', Math.abs(x.s.avgGap - 0.08) < 1e-6, x.s.avgGap);
ok('⑤ ⭐ 大盤贏的天數 60%', Math.abs(x.s.winPct - 60) < 1e-6, x.s.winPct);
ok('⑤ 要顯示「平均每天贏中位數個股」', /平均每天贏中位數個股/.test(x.html), x.html.slice(-700));
ok('⑤ ⭐ 要把它跟「基準勝率 36% 不是 50%」串起來',
   /36%/.test(x.html) && /不是 50%/.test(x.html), x.html.slice(-700));

// ── ⑥ 樣本不足 → 誠實說累積中,⛔ 不硬給長期落差 ────────────────
x = await run({ h: hist(8, 0.4) });
ok('⑥ <20 日 → avgGap 為 null', x.s && x.s.avgGap === null, JSON.stringify(x.s));
ok('⑥ ⭐ 要誠實說「歷史基準累積中」', /歷史基準累積中/.test(x.html), x.html.slice(-400));
ok('⑥ ⛔ 不可硬掰平均落差', !/平均每天贏/.test(x.html), x.html.slice(-400));

// ── ⑦ 盤中快照不足 500 檔 → ⛔ 不用(退回收盤檔)────────────────
x = await run({ live: mkLive(Array(120).fill(5)), taiex: 3, h: [{ d: '2026-07-30', med: -1.02, idx: -0.26, total: 2314 }] });
ok('⑦ ⭐ 快照只有 120 檔 → 不當即時用', x.s && x.s.live === false, JSON.stringify(x.s));
ok('⑦ 退回收盤值', x.s.med === -1.02, x.s.med);

// ── ⑧ 缺資料 → null(⛔ 不硬算)────────────────────────────
ok('⑧ 沒有歷史也沒有快照 → null', (await run({ h: [], live: null })).s === null);
ok('⑧ html 為空字串', (await run({ h: [], live: null })).html === '');
ok('⑧ 歷史列缺 idx → 濾掉 → null',
   (await run({ h: [{ d: '2026-07-30', med: -1, total: 2300 }] })).s === null);
ok('⑧ 盤中有快照但拿不到大盤漲跌 → null(⛔ 不拿收盤 idx 配盤中 med)',
   (await run({ live: mkLive(Array(600).fill(-1)), taiex: null, h: [{ d: '2026-07-30', med: -1.02, idx: -0.26, total: 2314 }] })).s === null);

// ── ⑨ ⭐⛔ 不可宣稱台積電權重 / 不可下買賣方向 ──────────────────
x = await run({ live: mkLive([...Array(300).fill(-2), ...Array(300).fill(0)]), taiex: 1.5 });
const help = await page.evaluate(() => { let t = ''; const o = window.alert; window.alert = s => { t = s; }; app._showMedGapHelp(); window.alert = o; return t; });
// ⚠️ 兩句正確的免責寫法本身就含被禁的字串 → 比對前一律先拿掉否定形
//    ①「沒有去推估台積電的官方權重」含「權重」 ②「不是買賣訊號」含「賣訊」
//    (第 6 次踩同一個坑,已寫進 CLAUDE.md;⛔ 別把 BAD 放寬成不檢查)
const strip = t => t
    .replace(/【?我?】?\s*沒有去?推估台積電的?官方權重[^\n]*/g, '')
    .replace(/不是買賣訊號/g, '');
ok('⑨ ⭐⛔ 卡片不可出現具體權重百分比(如「台積電佔 38%」)',
   !/台積電[^\n]{0,8}(佔|權重)[^\n]{0,6}\d+(\.\d+)?\s?%/.test(x.html + strip(help)), '出現了推估權重');
ok('⑨ ⭐ 教學要明說「沒有去推估台積電的官方權重」', /沒有.{0,3}推估台積電的官方權重/.test(help), help.slice(0, 1400));
ok('⑨ 教學要說明為什麼(流通股數 vs 總股數)', /流通股數/.test(help), help.slice(0, 1400));
const BAD = /買訊|賣訊|該買|該空|建議進場|保證|必漲/;
ok('⑨ ⛔ 不可下買賣方向', !BAD.test(strip(x.html + help)), (strip(x.html + help).match(BAD) || []).join(','));
ok('⑨ 要明說「不是買賣訊號」', /不是買賣訊號/.test(help), help.slice(-400));

// ── ⑩ 真的接進市場廣度卡(合併,⛔ 沒開新卡)────────────────────
ok('⑩ ⭐ 併進 renderMarketBreadth', await page.evaluate(() => /_medGapHtml/.test(app.renderMarketBreadth.toString())));
ok('⑩ ⛔ 沒有新增 DOM 容器 id', !/id="medGap/.test(await page.content()));

ok('⑪ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ MEDGAP_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ MEDGAP_TEST_PASS');
