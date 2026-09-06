#!/usr/bin/env node
/**
 * 🛡️ 防守價的時間 / 一致性守門(V72.0.7)
 *
 * 使用者截圖(2327 國巨,2026-08-04 盤中 565、成本 561、0.07 張):
 *   卡片寫「成本 561 ・ +280 元(獲利) +0.7%」,同一張卡卻寫
 *   「⛔ 已跌破防守價 676.00 → 🚪 停利出場」。
 *   ⛔ **防守價比成本高 115 元(20%)** = 一進場就已經破防,邏輯上不可能成立。
 *
 * 根因:`stopFinal = max(發動K低, 成本×0.95)`,而那根發動K是 **2026/07/22**
 *   (國巨還在 700 以上)那根,低點正好 676。使用者 08/01 才買在 561 ——
 *   那根 K 是他買進**之前**的事,跟他完全不相干。
 *
 * ⛔ `max()` 本身是對的(移動停利)—— 這支測試同時釘住「不可誤擋正常情境」。
 *
 * 兩層守門:
 *   ① ⏱️ 時間:發動K 早於買進日 → 不算(使用者說的「要用時間判斷」)
 *   ② 📏 一致性:發動K低 > 成本 且 現價已在它下方 → 那條線早就破了,是壓力不是防守
 *      ⭐ ② 不需要日期就成立 → buyDate 沒填時仍擋得住
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._unifiedExitPlan, null, { timeout: 20000 });

// ⭐ 用**真實**的 2327 日 K(重現使用者那張截圖),⛔ 不用合成資料
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2327.json'), 'utf8'));
const setup = await page.evaluate(rows => {
    // 補上截圖當下那根盤中(08/04 現價 565)
    const d = rows.slice();
    if (String(d[d.length - 1].date).indexOf('08/04') < 0) {
        d.push({ date: '2026/08/04', open: 552, high: 568, low: 550, close: 565, volume: 9e6 });
    }
    app.currentSymbolId = '2327'; app.rawDailyData = d; app.activeData = d;
    const cl = d.map(r => +r.close);
    const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((a, v) => a + v, 0) / k);
    app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
    app._d = d;
    const t = app._chuFindTriggerBarLow(d, d.length - 1);
    return t ? { idx: t.idx, low: t.low, date: String(t.date) } : null;
}, rows);

// ── ① 先確認測資真的重現了截圖(⛔ 否則下面全是空過)──────────────
ok('① ⭐ 真實資料真的挑到 07/22 那根發動K(低 676)',
   setup && Math.abs(setup.low - 676) < 0.01 && /07\/22/.test(setup.date), JSON.stringify(setup));

const plan = (cost, buyDate) => page.evaluate(a =>
    app._unifiedExitPlan(app._d, a.cost, a.buyDate), { cost, buyDate });

// ── ② ⏱️ 時間守門:發動K 早於買進日 → 不採用 ────────────────────
let r = await plan(561, '2026/08/01');
ok('② ⭐ 防守價變成成本−5%(532.95),不再是 676', r && r.stopFinal === 532.95, JSON.stringify(r && r.stopFinal));
ok('② ⭐ 必須留下原因(陷阱 #22:拿掉值要說為什麼)', /早於你的買進日/.test(r.stopADropped || ''), r.stopADropped);
ok('② 原因裡要有兩個日期(否則查不出真因)',
   /2026-07-22/.test(r.stopADropped || '') && /2026-08-01/.test(r.stopADropped || ''), r.stopADropped);
ok('② 原始值要保留在 stopARaw(⛔ 不可整個丟掉)', r.stopARaw && r.stopARaw.low === 676, JSON.stringify(r.stopARaw));
ok('② ⭐⛔ 防守價不可高於成本(一進場就破防是不可能的)', r.stopFinal <= 561, r.stopFinal);

// ── ③ 📏 一致性守門:沒填買進日也要擋得住 ──────────────────────
r = await plan(561, null);
ok('③ ⭐ 沒填買進日 → 一樣是 532.95', r && r.stopFinal === 532.95, JSON.stringify(r && r.stopFinal));
ok('③ ⭐ 原因要說「早就破了・是上方壓力」', /早就破了/.test(r.stopADropped || '') && /上方壓力/.test(r.stopADropped || ''), r.stopADropped);
ok('③ 原因要帶原始數字(發動K低 / 成本 / 現價)',
   /676/.test(r.stopADropped) && /561/.test(r.stopADropped) && /565/.test(r.stopADropped), r.stopADropped);

// ── ④ ⛔ 不可誤擋正常情境(移動停利是對的,別把 max 改壞)──────────
r = await plan(700, null);   // 成本 700 > 發動K低 676 → 那是正常停損,不該擋
ok('④ ⭐⛔ 成本高於發動K低 → 照舊採用 676(正常停損,不可誤擋)', r && r.stopFinal === 676, JSON.stringify(r && r.stopFinal));
ok('④ 沒有被擋 → stopADropped 為 null', r.stopADropped == null, r.stopADropped);

r = await plan(561, '2026/07/01');   // 買在發動K之前 → 時間守門不該觸發
ok('④ 買進日早於發動K → 時間守門不觸發(但一致性守門仍會擋)',
   /早就破了/.test(r.stopADropped || ''), r.stopADropped);

// ── ⑤ 移動停利:發動K低 > 成本 但現價**還在它之上** → 必須保留 ────
const mv = await page.evaluate(() => {
    // 造一段「發動K低 300、成本 250、現價 320」的資料 → 這是合法的移動停利
    const d = [];
    for (let i = 0; i < 60; i++) d.push({ date: `2026-05-${String(i % 28 + 1).padStart(2, '0')}`, open: 240, high: 245, low: 238, close: 242, volume: 1e6 });
    d.push({ date: '2026-07-01', open: 302, high: 340, low: 300, close: 336, volume: 9e6 });   // 爆量長紅=發動K,低 300
    for (let i = 0; i < 8; i++) d.push({ date: `2026-07-${String(2 + i).padStart(2, '0')}`, open: 320, high: 325, low: 315, close: 320, volume: 2e6 });
    const cl = d.map(r => +r.close);
    const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((a, v) => a + v, 0) / k);
    app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
    const t = app._chuFindTriggerBarLow(d, d.length - 1);
    return { trig: t ? t.low : null, plan: app._unifiedExitPlan(d, 250, null) };
});
ok('⑤ ⭐ 這組測資真的有發動K(⛔ 否則下面空過)', mv.trig != null, JSON.stringify(mv.trig));
ok('⑤ ⭐⛔ 現價還在發動K低之上 → 移動停利必須保留(⛔ 別為了修 bug 把這個弄壞)',
   mv.plan && mv.plan.stopFinal === mv.trig && mv.plan.stopADropped == null,
   JSON.stringify({ stopFinal: mv.plan && mv.plan.stopFinal, trig: mv.trig, dropped: mv.plan && mv.plan.stopADropped }));
ok('⑤ 移動停利要高於成本−5%(這正是 max() 存在的理由)',
   mv.plan.stopFinal > 250 * 0.95, mv.plan.stopFinal);

// ── ⑥ 空手 / 無成本 → 不可崩,也不套用需要成本的守門 ──────────────
r = await plan(null, null);
ok('⑥ 沒有成本 → 仍回得出 plan(不可 null)', r != null, JSON.stringify(r));
ok('⑥ 沒有成本時不套用一致性守門(那條需要成本)', r.stopADropped == null, r.stopADropped);

// ── ⑦ 三個呼叫端都要把 buyDate 傳進來(否則守門①等於沒接上)────────
//   ⚠️ 這三支才是真正的呼叫端(第一版測試寫成 _entryCheckup 是猜的,實測不是):
//     _aiGodAdviceHtml(截圖上那張「現在怎麼做」)/ _renderTrendCommand / renderMktCompare
const wired = await page.evaluate(() => ({
    god: /_unifiedExitPlan\([^)]*,\s*_buyDate\)/.test(app._aiGodAdviceHtml.toString()),
    trend: /_unifiedExitPlan\([^)]*,\s*_buyDate\)/.test(app._renderTrendCommand.toString()),
    cmp: /_unifiedExitPlan\([^)]*pos\.buyDate\)/.test(app.renderMktCompare.toString()),
}));
ok('⑦ ⭐ _aiGodAdviceHtml(「現在怎麼做」卡)有傳 buyDate', wired.god, '');
ok('⑦ ⭐ _renderTrendCommand 有傳 buyDate', wired.trend, '');
ok('⑦ ⭐ renderMktCompare 有傳 buyDate', wired.cmp, '');
// ⚠️ 註解寫在函式**之前** → toString() 拿不到,必須讀原始檔
const fileSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('⑦ ⭐ 註解要寫明⛔別把 max 改掉(移動停利的理由)',
   /別把它改成\s*`min`|⛔ 別把它改成/.test(fileSrc) && /移動停利/.test(fileSrc), '');

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ GUARDTIME_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ GUARDTIME_TEST_PASS');
