#!/usr/bin/env node
/**
 * 🧭 V74.2.5 當沖頁「總覽邏輯」(使用者:「接下來當沖頁」)—— 個股五頁到齊
 *
 * 第一眼 = 🎯 今日當沖作戰指令(hero:大字結論 + 💰成本關卡 + 計畫)
 *          + **有實測背書**的條件觸發訊號(漲停隔日動能);
 * 收進「📖 更多解讀」= 隔日沖 T+1 攻防預判(講的是**明天**)、買盤竭盡(未驗證)、損益試算機(工具)。
 * ⛔ 一張卡、一個字都沒刪。
 *
 * ⛔ 釘死的六件事(②③⑤ 已用注入缺陷自我驗證):
 *   ① 摺疊預設收起;隔日沖T+1/買盤竭盡/試算機在裡面
 *   ② 🚨 hero(今日作戰指令)+ 💰成本關卡 **必須留在第一眼**(⛔ 收進摺疊 = 把先決條件藏起來)
 *   ③ 🚨 **有實測數字的訊號⛔ 不可收**(漲停隔日動能;那正是使用者要第一眼看到的)
 *   ④ ⛔ 收起 ≠ 刪除:試算機的 input 仍在 DOM(details 只是不渲染)→ `_calcDayTradePnl` 照樣算得到
 *   ⑤ 沒東西可收 → 整個摺疊不顯示(⛔ 不留點開什麼都沒有的橫條)
 *   ⑥ 摺疊裡⛔ 不可出現「今天怎麼做」的第二套指令(單一劇本:以 hero 為準)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails++; };

// ── 靜態:分流要正確(這頁的「第一眼 vs 摺疊」是靠陣列決定的)──
{
    ok('② 🚨 漲停隔日動能(有實測 +1.54%)進 `cards` = 第一眼(⛔ 不可改成 dtMore)',
        /const _lu = this\._limitUpMomentumHtml\(sym, baseRaw\); if \(_lu\) cards\.push\(_lu\)/.test(SRC));
    ok('③ 買盤竭盡(未驗證)收進 dtMore', /const _bx = this\._buyExhaustHtml\(sym\); if \(_bx\) dtMore\.push\(_bx\)/.test(SRC));
    ok('③b 隔日沖 T+1(講明天)收進 dtMore', /if \(_ovnHtml\) dtMore\.unshift\(_ovnHtml\);/.test(SRC));
    ok('③c 損益試算機(工具)收進 dtMore', /dtMore\.push\(`[\s\S]{0,200}當沖損益試算機/.test(SRC));
    ok('⑤ 沒東西可收 → 整個摺疊不顯示(⛔ 不留空殼橫條)',
        /const _dtMoreHtml = dtMore\.filter\(Boolean\)\.length \? `/.test(SRC) && /` : '';/.test(SRC));
    const m = SRC.match(/<details id="dtMoreWrap"[^>]*>/);
    ok('① 摺疊⛔ 不可掛 open', !!m && !/\bopen\b/.test(m[0]), m && m[0]);
    ok('① 第一眼在前、摺疊在後(組裝順序)', /box\.innerHTML = cards\.join\(''\) \+ _dtMoreHtml;/.test(SRC));
    // ⑦ 🚨 這檔的結論要排在「掃別檔的工具」前面 —— 一開頁先看到的必須是「這檔今天怎麼做」
    ok('⑦ 🚨 作戰指令(dayTradeBody)要排在「當沖候選掃描」之上',
        SRC.indexOf('id="dayTradeBody"') < SRC.indexOf('id="dtScanCard"'));
}

// ── 動態:真的渲染一次 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderDayTradeTab, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const o = {};
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze('2330', true, false, true); } catch (e) { return { err: String(e).slice(0, 160) }; }
    await new Promise(r => setTimeout(r, 2200));
    try { app.switchSubTab('daytrade'); } catch (_) { }
    await new Promise(r => setTimeout(r, 3000));
    const body = document.getElementById('dayTradeBody');
    o.bodyLen = body.innerHTML.length;
    const wrap = document.getElementById('dtMoreWrap');
    o.hasWrap = !!wrap;
    o.closed = !!wrap && wrap.open === false;
    // 🚧 空過守門:hero 真的渲染出來了(⛔ 否則下面全是假通過)
    o.heroFirst = /今日當沖作戰指令/.test(body.innerText || '');
    // ② hero 與成本關卡都要在摺疊**外**
    const outside = (() => {
        const c = body.cloneNode(true);
        const w = c.querySelector('#dtMoreWrap'); if (w) w.remove();
        return (c.innerText || '').replace(/\s+/g, ' ');
    })();
    o.outside = outside.slice(0, 400);
    o.heroOutside = /今日當沖作戰指令/.test(outside);
    o.costOutside = /成本關卡/.test(outside);
    // ④ 收起 ≠ 刪除:試算機 input 仍在 DOM、且算得動
    o.calcInWrap = !!wrap && !!wrap.querySelector('#dtBuyPrice');
    // ⚠️ 輸出元素是 `#dtResult` —— 第一版**猜**成 dtPnlResult/dtPnlOut 就假失敗了
    //    (本 session 第 3 次踩「斷言前先去看實際輸出長什麼樣」)。
    o.calcWorks = (() => {
        const b = document.getElementById('dtBuyPrice'), s = document.getElementById('dtSellPrice');
        const out = document.getElementById('dtResult');
        if (!b || !s || !out) return false;
        b.value = '100'; s.value = '110';
        try { app._calcDayTradePnl(); } catch (_) { return false; }
        // 100 → 110 一張:毛利 10,000,扣手續費+稅後仍應是「淨賺」正數
        return /淨賺|9,\d{3}|\d,\d{3}/.test(out.innerText || out.innerHTML || '');
    })();
    // ⑥ 摺疊裡⛔ 不可有第二套「今天怎麼做」的作戰指令
    o.noSecondHero = !wrap || !/今日當沖作戰指令/.test(wrap.innerText || '');
    return o;
});
await browser.close();
if (R.err) { console.log(`❌ analyze 失敗:${R.err}`); process.exit(1); }

ok('🚧 空過守門:當沖頁真的渲染出 hero(⛔ 否則下面全是假通過)', R.heroFirst === true, R.outside.slice(0, 120));
ok('① 摺疊存在且實跑是收起的', R.hasWrap && R.closed, JSON.stringify({ w: R.hasWrap, c: R.closed }));
ok('② 🚨 作戰指令(hero)在摺疊**外** = 第一眼看得到', R.heroOutside === true, R.outside.slice(0, 160));
ok('② 🚨 💰成本關卡也在摺疊外(它是能不能當沖的**先決條件**)', R.costOutside === true, R.outside.slice(0, 200));
ok('④ ⛔ 收起 ≠ 刪除:試算機在摺疊裡,但 DOM 還在、算得動', R.calcInWrap && R.calcWorks,
    JSON.stringify({ inWrap: R.calcInWrap, works: R.calcWorks }));
ok('⑥ ⛔ 摺疊裡不可有第二套「今天怎麼做」(單一劇本:以 hero 為準)', R.noSecondHero === true, '');

console.log(fails ? `❌ ${fails} 條失敗` : '✅ DTLEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
