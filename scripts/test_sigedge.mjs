#!/usr/bin/env node
/**
 * 📊 訊號實測成績表 + K線頁分區顯示 測試(V71.9.9)
 *
 * 使用者要求:「K線/總覽只把**有用的、勝率高的**顯示出來,不要全部打出來根本不知道看哪一個」
 * → `scripts/signal_backtest.mjs` 跑真正的偵測器回測 250 檔 × 3 年,結果嵌成 `_SIGNAL_EDGE`。
 *
 * 這支釘住四件最容易被改壞的事:
 *   ① ⭐ **基準勝率是 34.6% 不是 50%** —— 說明文字一定要寫出來,否則 41% 會被誤讀成「輸」
 *   ② A 級要置頂並顯示勝率徽章;C 級/未驗證要收進摺疊區
 *   ③ ⛔ **不可把 C 級刪掉** —— 裡面有風險提醒(長黑棒之類),刪掉會讓人以為沒風險
 *   ④ 查不到成績的訊號 → 回 null,⛔ 不可假裝有成績
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._sigEdge, null, { timeout: 25000 });

// ── ① 成績表本身 ────────────────────────────────────────────
const meta = await page.evaluate(() => ({ ...app._SIGNAL_EDGE_META, n: Object.keys(app._SIGNAL_EDGE).length }));
ok('① 成績表有載入(122 個訊號)', meta.n >= 100, JSON.stringify(meta));
ok('① ⭐ 基準勝率記錄下來且 ≠ 50%', meta.base_win > 25 && meta.base_win < 45, String(meta.base_win));
ok('① 分級數量合理(A 少、C 多)', meta.A > 0 && meta.C > meta.A, JSON.stringify(meta));
ok('① 回測涵蓋 ≥200 檔', meta.syms >= 200, String(meta.syms));

// ── ② 查表 ────────────────────────────────────────────────
const e1 = await page.evaluate(() => app._sigEdge('_detectStarPatterns', '晨星轉折'));
ok('② 查得到晨星轉折', e1 && e1.grade === 'A' && e1.n > 50, JSON.stringify(e1));
ok('② 欄位齊全(grade/n/e10/w10/p)',
   e1 && ['grade', 'n', 'e10', 'w10', 'p'].every(k => e1[k] != null), JSON.stringify(e1));
ok('② ⛔ 查不到 → null(不假裝有成績)',
   (await page.evaluate(() => app._sigEdge('_detectNope', '不存在'))) === null);
ok('② ⛔ 空參數 → null', (await page.evaluate(() => app._sigEdge('', ''))) === null);

// ── ③ 偵測器有被標記來源(否則查不到表)──────────────────────
const tagged = await page.evaluate(() => {
    const src = app.renderKbarTactics.toString();
    return { tag: (src.match(/_tagPush/g) || []).length, edge: /_sigEdge/.test(src),
             unshiftTagged: /_r\.forEach\(x => \{ if \(x\) x\._d =/.test(src) };
});
ok('③ renderKbarTactics 用 _tagPush 收訊號(≥15 處)', tagged.tag >= 15, JSON.stringify(tagged));
ok('③ ⭐ unshift 的那幾個也有標記來源(否則永遠查不到成績)', tagged.unshiftTagged, JSON.stringify(tagged));
ok('③ 有呼叫 _sigEdge 查成績', tagged.edge);

// ── ④ 實際渲染:A 級置頂 + 徽章 + C 級收合 ───────────────────
const html = await page.evaluate(() => {
    // 造一段會觸發多種訊號的資料:先跌深再放量長紅(晨星/底部型態容易中)
    const a = [];
    let c = 100;
    for (let i = 0; i < 300; i++) {
        c = i < 200 ? c * 1.002 : c * 0.985;
        a.push({ date: `2026/01/${String((i % 28) + 1).padStart(2, '0')}`,
                 open: c, high: c * 1.02, low: c * 0.98, close: c, volume: 1e6 });
    }
    const p = a[a.length - 1].close;
    a.push({ date: '2026/07/29', open: p * 0.99, high: p * 0.995, low: p * 0.94, close: p * 0.95, volume: 3e6 });
    a.push({ date: '2026/07/30', open: p * 0.95, high: p * 0.96, low: p * 0.94, close: p * 0.952, volume: 1e6 });
    a.push({ date: '2026/07/31', open: p * 0.955, high: p * 1.03, low: p * 0.95, close: p * 1.02, volume: 5e6 });
    let box = document.getElementById('kbarHalfTactics');
    if (!box) { box = document.createElement('div'); box.id = 'kbarHalfTactics'; document.body.appendChild(box); }
    box.innerHTML = '';
    app.currentSymbolId = 'T';
    app.rawDailyData = a;
    try { app.renderKbarTactics(a); } catch (e) { return 'ERR:' + e.message; }
    return box.innerHTML;
});
ok('④ 有渲染出東西', html && html.length > 200 && !html.startsWith('ERR:'), String(html).slice(0, 160));
ok('④ ⭐ 有「實測有效的訊號」分區標題或誠實說今天沒有',
   /實測有效的訊號|今天沒有出現「實測有效」/.test(html), html.slice(0, 400));
ok('④ ⭐ 其餘訊號收在 <details> 摺疊區(不是全部攤開)', /<details/.test(html), html.slice(0, 300));
ok('④ 摺疊區要說明「觀察用,別當進場理由」', /別當進場理由/.test(html), html.slice(0, 900));
ok('④ 有「怎麼看」教學按鈕', /怎麼看/.test(html), html.slice(0, 600));

// ⭐ ① 的延伸:教學裡一定要寫明基準不是 50%
ok('④ ⭐ 教學必須寫明基準勝率(否則 41% 會被誤讀成輸)',
   new RegExp(String(meta.base_win.toFixed(1))).test(html), html.slice(0, 1200));
ok('④ 教學要說明沒扣交易成本', /沒有扣交易成本|未扣交易成本|沒有.{0,4}扣.{0,4}交易成本/.test(html), '');
ok('④ ⭐ 教學要說明「不是保證」', /不是保證/.test(html), '');

// ── ⑤ ⛔ C 級不可被刪掉(裡面有風險提醒)────────────────────
const src = await page.evaluate(() => app.renderKbarTactics.toString());
ok('⑤ ⭐ 註解要寫明「不直接刪掉 C 級」的理由', /不直接刪掉/.test(src));
ok('⑤ rest 有被渲染(不是丟掉)', /rest\.slice/.test(src));

// ── ⑥ 排序穩定(同級維持原順序,⛔ 不可用不穩定排序打亂置頂邏輯)──
ok('⑥ ⭐ 用穩定排序(保留 unshift 的置頂用意)', /_stable/.test(src) && /a\[1\] - b\[1\]/.test(src));

// ── ⑦ _winRateP 向後相容(既有呼叫端不可受影響)────────────────
const wp = await page.evaluate(() => ({
    old: app._winRateP(8, 10),                 // 預設 0.5
    withP0: app._winRateP(8, 10, 0.5),         // 明寫 0.5 應相同
    lower: app._winRateP(8, 10, 0.346),        // 基準低 → p 應更小
}));
ok('⑦ ⭐ 預設仍是跟 50% 比(向後相容)', Math.abs(wp.old - 56 / 1024) < 1e-9, JSON.stringify(wp));
ok('⑦ 傳 0.5 跟不傳結果相同', Math.abs(wp.old - wp.withP0) < 1e-12, JSON.stringify(wp));
ok('⑦ 基準降到 34.6% → p 值變小(更容易顯著)', wp.lower < wp.old, JSON.stringify(wp));

// ── ⑨ V72.0.0 總覽「進場體檢」也依實測分級 ──────────────────────
const ec = await page.evaluate(() => {
    const a = []; let c = 100;
    for (let i = 0; i < 300; i++) { c = i < 200 ? c * 1.002 : c * 0.985;
        a.push({ date: `2026/01/${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c * 1.02, low: c * 0.98, close: c, volume: 1e6 }); }
    const p0 = a[a.length - 1].close;
    a.push({ date: '2026/07/29', open: p0 * 0.99, high: p0 * 0.995, low: p0 * 0.94, close: p0 * 0.95, volume: 3e6 });
    a.push({ date: '2026/07/30', open: p0 * 0.95, high: p0 * 0.96, low: p0 * 0.94, close: p0 * 0.952, volume: 1e6 });
    a.push({ date: '2026/07/31', open: p0 * 0.955, high: p0 * 1.03, low: p0 * 0.95, close: p0 * 1.02, volume: 5e6 });
    let el = document.getElementById('entryCheckup');
    if (!el) { el = document.createElement('div'); el.id = 'entryCheckup'; document.body.appendChild(el); }
    el.innerHTML = ''; app.currentSymbolId = 'T'; app.rawDailyData = a;
    const res = app._entryCheckup(a);
    try { app.renderEntryCheckup(a); } catch (e) { return { err: e.message }; }
    return { res, html: el.innerHTML };
});
ok('⑨ _entryCheckup 有回 proven 清單', ec.res && Array.isArray(ec.res.proven), JSON.stringify(ec.res && Object.keys(ec.res || {})));
ok('⑨ 渲染成功', !ec.err && ec.html && ec.html.length > 300, String(ec.err || '').slice(0, 120));
ok('⑨ ⭐ 有「實測有效」專區或誠實說今天沒有',
   /實測有效|沒有.{0,3}出現實測有效/.test(ec.html), ec.html.slice(0, 500));
ok('⑨ 沒有時要勸阻「別硬找理由進場」或有清單', /別硬找理由進場|勝率 /.test(ec.html), ec.html.slice(0, 600));
ok('⑨ ⭐ 要標明基準勝率', new RegExp(String(meta.base_win.toFixed(1))).test(ec.html), ec.html.slice(0, 900));
ok('⑨ 有共用教學按鈕 _showEdgeHelp', /_showEdgeHelp/.test(ec.html));

// ⑩ ⭐ 多空不對稱:看多打折、看空⛔不打折(風險寧可多提醒)
const wsrc = await page.evaluate(() => app._entryCheckup.toString());
ok('⑩ ⭐ 看多訊號依分級打折', /_gw/.test(wsrc) && /0\.3/.test(wsrc), '');
ok('⑩ ⭐⛔ 看空/警示不可打折(註解要寫明理由)', /風險不打折|一律不打折/.test(wsrc), '');
ok('⑩ bear 分支沒有乘上分級係數',
   /else if \(s\.tone === 'bear'\) \{ bear \+= w;/.test(wsrc), '');

// ⑪ 教學只有一份(⛔ 別寫兩套文案)
ok('⑪ ⭐ K線頁與總覽共用同一份教學', /_showEdgeHelp/.test(await page.evaluate(() => app.renderEntryCheckup.toString())));

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ SIGEDGE_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ SIGEDGE_TEST_PASS');
