#!/usr/bin/env node
/**
 * 🧭 V76.0.7 「看得懂的第一眼」:儀表列 + 價格尺 + 總覽摺疊 —— 測試
 *
 * 使用者(自述「我不是很懂」):「總覽資訊量太大…把套牢區列出來…有沒有更簡單的敘述或者量表,還是圖」
 *
 * ⛔ 每一條先想「注入什麼它會叫」(注入紀錄在 docs/DECISIONS.md):
 *   ① 五格分數自己算一份  ② 位置類上紅綠  ③ 方向類不上紅綠  ④ 缺維補 --  ⑤ 兩頁各畫一份儀表列
 *   ⑥ 價格尺自己算前高   ⑦ 套牢帶自己算   ⑧ 🔔 顆數寫死    ⑨ 免責段搬回第一眼  ⑩ 換股不清 _lastGauge
 *   ⑪ 有部位破線的 🚨 被收進摺疊 ⑫ 出場狀態還畫買點 ⑬ 手機/橫版溢出 ⑭ 「收起」變「刪除」
 *
 * 測資:本機 data/(2327 / 2330 / 0050 / 009816);沒有就誠實 exit 1(陷阱 #40)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 320)}`}`); if (!c) fails.push(n); };
for (const s of ['2327', '2330', '0050', '009816']) if (!fs.existsSync(path.join(ROOT, 'data', `${s}.json`))) { console.log(`❌ 沒有 data/${s}.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }

// ── 靜態:全 App 只有一種尺 ──
{
    const strip = (x) => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '');
    const fnRuler = strip(SRC.slice(SRC.indexOf('    _rpValRuler(C) {'), SRC.indexOf('    _rpValHtml(C) {')));
    ok('Ⓐ 估值尺改走 _gaugeRow(⛔ 不再自己畫底條與 ▼)', /_gaugeRow\(/.test(fnRuler) && !/bg-gradient-to-r/.test(fnRuler) && !/▼/.test(fnRuler), '');
    const fnStrip = strip(SRC.slice(SRC.indexOf('    _gaugeStripHtml(sym) {'), SRC.indexOf('    _riskHot(sym) {')));
    ok('①s 儀表列只讀 _lastGauge.dims(⛔ 不可出現 _lastTechScore/_lastChipScore/_calcRiskScore = 自己再算一份)',
       /_lastGauge/.test(fnStrip) && !/_lastTechScore|_lastChipScore|_lastXrayScore|_lastExpectScore|_calcRiskScore|_entryCheckup/.test(fnStrip), '');
    const fnRuler2 = strip(SRC.slice(SRC.indexOf('    _priceRulerHtml() {'), SRC.indexOf('    _ovEmergencyBar() {')));
    ok('⑥s 價格尺只讀 _keyLevels / _upsideStash(⛔ 不可出現 _overheadSupply/_chuResistanceZones/peaks = 自己算價位)',
       /_keyLevels/.test(fnRuler2) && /_upsideStash/.test(fnRuler2) && !/_overheadSupply|_chuResistanceZones|this\.peaks|this\.troughs|\.ma20|\.ma5/.test(fnRuler2), '');
    ok('⑤s 報告頁與總覽都呼叫同一支 _gaugeStripHtml(⛔ 不可另有 _rpGaugeStrip 之類)', (SRC.match(/this\._gaugeStripHtml\(sym\)/g) || []).length >= 2 && !/_rpGaugeStrip|_ovGaugeStrip/.test(SRC), '');
    ok('⑭s ovWhyBox 在 analyze() 切股清空清單裡(陷阱 #19)', /'rpSrc',\s*\n\s*'ovWhyBox'/.test(SRC), '');
}

// ── 🎨 V76.0.8 靜態 ──
{
    const strip = (x) => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '');
    const fnV = strip(SRC.slice(SRC.indexOf('    _renderXrayVerdict() {'), SRC.indexOf('    _renderXrayVerdict() {') + 2600));
    ok('㉒a 體質分只有一份公式:_renderXrayVerdict 必須呼叫 _xrayScoreOf,⛔ 不可自己再算一遍',
       /this\._xrayScoreOf\(/.test(fnV) && !/let score = 0, max = 0/.test(fnV), '');
    const fnE = strip(SRC.slice(SRC.indexOf('    _renderXrayExpectation(revData) {'), SRC.indexOf('    _renderXrayExpectation(revData) {') + 1200));
    ok('㉒b 預期分同理:_renderXrayExpectation 必須呼叫 _expectScoreOf', /this\._expectScoreOf\(/.test(fnE) && !/let risk = 0/.test(fnE), '');
    const fnStrip2 = strip(SRC.slice(SRC.indexOf('    _gaugeStripHtml(sym) {'), SRC.indexOf('    _riskHot(sym) {')));
    ok('㉒c 顯示層⛔ 不可自己去讀採礦快取算分數(算的地方在上游 _seedXrayFromCache)',
       !/_loadFundCache|_loadFundYoyGm|_xrayScoreOf|_expectScoreOf/.test(fnStrip2), '');
    const fnAuto = strip(SRC.slice(SRC.indexOf('    async _autoLoadFundamentals(sym) {'), SRC.indexOf('    async _autoLoadFundamentals(sym) {') + 1400));
    // 🚨 seed 必須排在那句 `if (!res.ok) return;` **之前** —— 沒有 chips 檔的股票(2,300 檔裡的絕大多數)
    //    會在那裡直接 return,排後面等於對它們完全沒作用(使用者回報的 2426 正是這一類)。
    ok('㉑s seed 排在 chips fetch 的 early-return 之前(⛔ 排後面對沒有 chips 檔的股票完全沒作用)',
       fnAuto.indexOf('_seedXrayFromCache') > 0 && fnAuto.indexOf('_seedXrayFromCache') < fnAuto.indexOf('if (!res.ok) return;'), '');
    // 版面幾何一律 inline style —— Tailwind 是 CDN,沙箱連不到,用 class 排版的話測試量到的幾何是假的(陷阱 #40)
    const fnRow = strip(SRC.slice(SRC.indexOf('    _gaugeRow(label, pct, o = {}) {'), SRC.indexOf('    _rpValRuler(C) {')));
    ok('⑯s 量條的版面幾何走 inline style(⛔ 不靠 Tailwind class —— 沙箱沒有 Tailwind,靠 class 量到的對齊是假的)',
       /position:relative;flex:1 1 0/.test(fnRow) && /flex:0 0 54px/.test(fnRow), '');
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
async function boot(viewport) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported/.test(m)) errs.push(m.slice(0, 160)); });
    await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
    await page.waitForTimeout(2500);
    return page;
}
const load = async (page, sym) => { await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, sym); await page.waitForTimeout(7000); };
const snap = async (page) => page.evaluate(() => {
    const txt = el => (el && el.innerText || '').replace(/\s+/g, ' ').trim();
    const cc = document.getElementById('ovCommandCenter'), why = document.getElementById('ovWhyBox');
    const g = [...cc.querySelectorAll('[data-gauge]')].map(e => {
        const bar = e.querySelector('[data-bar]'), fl = e.querySelector('[data-fill]');
        const r = bar ? bar.getBoundingClientRect() : null;
        return { k: e.dataset.gauge, pct: +e.dataset.pct, kind: e.dataset.kind, html: e.innerHTML,
                 fill: fl ? fl.getAttribute('class') : null, fw: fl ? +fl.dataset.fill : null,
                 bx: r ? [+r.left.toFixed(1), +r.right.toFixed(1)] : null };
    });
    const sr = cc.querySelector('[data-priceruler]');
    return {
        sym: app.currentSymbolId, ccLen: txt(cc).length, ccTxt: txt(cc),
        gauges: g, dims: (app._lastGauge && String(app._lastGauge.sym) === String(app.currentSymbolId)) ? app._lastGauge.dims.map(d => [d.name, d.score]) : null,
        marks: sr ? [...sr.querySelectorAll('[data-mark]')].map(e => [e.dataset.mark, +e.dataset.v]) : [],
        bands: sr ? [...sr.querySelectorAll('[data-supplyband]')].map(e => e.dataset.supplyband) : [],
        bell: (cc.querySelector('[data-bell]') || {}).dataset?.bell ?? null,
        stashN: (app._armTrigStash && String(app._armTrigStash.sym) === String(app.currentSymbolId)) ? app._armTrigStash.triggers.length : 0,
        K: app._keyLevels ? { sym: app._keyLevels.sym, sl: app._keyLevels.slPx, buy: app._keyLevels.buyPx, add: app._keyLevels.addPx, C: app._keyLevels.C } : null,
        stash: (app._upsideStash && Array.isArray(app._upsideStash.list)) ? app._upsideStash.list.filter(x => +x.sup > 0).slice(0, 2).map(x => `${Math.round(x.lo)}~${Math.round(x.hi)}`) : [],
        whyTxt: txt(why), whyParent: why.parentElement.id, whyInDetails: !!why.closest('#ovMoreWrap'),
        stripOuter: (cc.querySelector('[data-gaugestrip]') || {}).outerHTML || '',
        // 🎨 V76.0.8:標題那個數字 / 少幾格的說明 / 價格尺圖例 / 有沒有跑出卡片外
        stripN: (() => { const e = cc.querySelector('[data-gaugen]'); return e ? +e.dataset.gaugen : null; })(),
        stripTitle: (() => { const e = cc.querySelector('[data-gaugen]'); return e ? e.innerText.trim() : ''; })(),
        stripNote: (() => { const e = cc.querySelector('[data-gaugestrip]'); return e ? (e.innerText.match(/還在讀財報[^\n]*|ETF 是一籃子[^\n]*/) || [''])[0] : ''; })(),
        legend: sr ? [...sr.querySelectorAll('[data-leg]')].map(e => e.innerText.trim()) : [],
        prOver: (() => { if (!sr) return []; const cb = sr.getBoundingClientRect(); const bad = [];
            sr.querySelectorAll('[data-leg],[data-mark],[data-supplyband]').forEach(e => { const b = e.getBoundingClientRect();
                if (b.left < cb.left - 1 || b.right > cb.right + 1) bad.push(e.getAttribute('data-leg') || e.getAttribute('data-mark') || e.getAttribute('data-supplyband')); });
            return bad; })(),
        rulerTrackHasText: sr ? ((sr.querySelector('[data-rulertrack]') || {}).innerText || '').replace(/\s/g, '') : '',
    };
});
const page = await boot({ width: 390, height: 844 });

// ── 2327:有套牢帶、有追買 ──
await load(page, '2327'); const A = await snap(page);
console.log(`   2327 第一眼 ${A.ccLen} 字 ・格 ${A.gauges.map(x => x.k + '=' + x.pct).join(',')} ・標記 ${A.marks.map(m => m.join('@')).join(',')} ・套牢帶 ${A.bands}`);
ok('① 每一格 data-pct == _lastGauge.dims 同名分數(注入:某格寫死 50 → 紅)',
   A.dims && A.gauges.length === A.dims.length && A.gauges.every(x => { const nm = { tech: '技術', mkt: '大盤', chip: '籌碼', fund: '基本面', expect: '預期' }[x.k]; const d = A.dims.find(y => y[0] === nm); return d && Math.round(d[1]) === x.pct; }),
   JSON.stringify({ g: A.gauges.map(x => [x.k, x.pct]), dims: A.dims }));
ok('② 位置類(基本面/預期)與大盤那格**不可**出現 text-red/text-green(燈號鐵則:安全/危險、位置不用紅綠)',
   A.gauges.filter(x => ['fund', 'expect', 'mkt'].includes(x.k)).every(x => !/text-red-|text-green-/.test(x.html)), '');
{
    const t = A.gauges.find(x => x.k === 'tech'), c = A.gauges.find(x => x.k === 'chip');
    const clsOf = x => x && (/text-red-3/.test(x.html) ? 'red' : /text-green-3/.test(x.html) ? 'green' : 'grey');
    const want = p => p >= 58 ? 'red' : p <= 42 ? 'green' : 'grey';
    ok('③ 方向類(技術/籌碼)▼ 顏色 = 58/42 門檻(≤42 綠、≥58 紅、中間灰)', t && c && clsOf(t) === want(t.pct) && clsOf(c) === want(c.pct), JSON.stringify({ t: [t && t.pct, clsOf(t)], c: [c && c.pct, clsOf(c)] }));
    const mk = A.gauges.find(x => x.k === 'mkt');
    ok('③b 大盤那格用 ✅⚠️⛔ 徽章、不畫 ▼', mk && /✅|⚠️|⛔/.test(mk.html) && !/▼/.test(mk.html), mk && mk.html.slice(0, 100));
}
{
    // ⚠️ V76.0.8 這條原本釘的是「這個環境沒跑 X 光 → 本來就沒有那兩格」—— 那個**前提已經不成立**
    //    (採礦快取 seed 之後 2327/2330 就有了)。改成釘**用意**:把分數 stub 成 null,那一列就該整列消失。
    const S = await page.evaluate(() => {
        // ⚠️ `_regaugeStrip` 要有 `_gaugeArgs` 才動得了(它是 `_overallGaugeHtml` 跑過才會有)——
        //    沒有的話這條會**安靜地量到舊畫面** = 假綠燈 → 先確定它在(不在就先跑一次 refreshStrategy 補上)。
        if (!app._gaugeArgs) { try { app.refreshStrategy(); } catch (_) {} }
        const sv = [app._lastXrayScore, app._lastExpectScore];
        app._lastXrayScore = null; app._lastExpectScore = null; app._regaugeStrip(app.currentSymbolId);
        const e = document.getElementById('ovCommandCenter').querySelector('[data-gaugestrip]');
        const r = { ks: [...e.querySelectorAll('[data-gauge]')].map(x => x.dataset.gauge), out: e.outerHTML, n: +e.querySelector('[data-gaugen]').dataset.gaugen, ga: !!app._gaugeArgs };
        app._lastXrayScore = sv[0]; app._lastExpectScore = sv[1]; app._regaugeStrip(app.currentSymbolId); return r; });
    ok('④ 缺維 → 那一列**整列不存在**、不顯 --(stub 成 null 再重畫)', S.ga && !S.ks.some(k => ['fund', 'expect'].includes(k)) && !/--/.test(S.out) && S.n === S.ks.length, JSON.stringify(S));
}
ok('⑥ 價格尺每個標記價位 == _keyLevels(注入:自己算前高 → 紅)',
   A.K && A.marks.length >= 3 && A.marks.every(([n, v]) => ({ 停損: A.K.sl, 防線: A.K.sl, 現價: A.K.C, 轉強: A.K.buy, 買進: A.K.buy, 追買: A.K.add }[n] || 0).toFixed(2) === v.toFixed(2)),
   JSON.stringify({ marks: A.marks, K: A.K }));
ok('⑦ ⭐ 套牢帶 == _upsideStash 同一層的 lo~hi(注入:自己呼叫 _overheadSupply → 紅)', A.bands.length >= 1 && A.bands.every(b => A.stash.includes(b)), JSON.stringify({ bands: A.bands, stash: A.stash }));
ok('⑦b 更遠的那道(774~866,超過 +35%)用一句話交代,⛔ 不硬畫進尺裡把尺壓扁', /更遠還有套牢區 774~866/.test(A.ccTxt) && !A.bands.includes('774~866'), A.ccTxt.slice(-300));
ok('⑧ 🔔 顆數 == _armTrigStash.triggers.length(2327 這一天沒有觸發價 → 沒有鈕也對)', (A.bell == null ? 0 : +A.bell) === A.stashN, JSON.stringify({ bell: A.bell, stashN: A.stashN }));
ok('⑨ ⭐ 第一眼字數 ≤ 600(舊版 778;三檔實測 474~487 +20%)(注入:把 ⚖️ 4 個系統搬回第一眼 → 紅)', A.ccLen <= 600, String(A.ccLen));
ok('⑨b 第一眼**不再出現**規則說明句(刻意不給點位 / 只採用實測有效 / 個系統在講方向)', !/刻意不給點位|只採用實測有效|個系統在講方向|系統怎麼判的/.test(A.ccTxt), '');
ok('⑭ ⭐ 那些段落**還在**(收進 ovWhyBox,⛔ 是收不是刪),而且 ovWhyBox 已被搬進既有的 ovMoreWrap 摺疊區',
   /系統怎麼判的|要注意的事/.test(A.whyTxt) && /個系統在講方向/.test(A.whyTxt) && A.whyParent === 'ovMoreWrap', JSON.stringify({ parent: A.whyParent, len: A.whyTxt.length }));
ok('⑭b 空手時預警(⚠️ 要注意的事)在摺疊區裡、不在第一眼', /要注意的事/.test(A.whyTxt) && !/要注意的事/.test(A.ccTxt), '');
ok('⑭c 「不是你設定的那條」那類預警排在預警清單**最後**', (() => { const i = A.whyTxt.indexOf('不是你設定的那條'); const j = A.whyTxt.indexOf('中期趨勢是空頭'); return i < 0 || j < 0 || i > j; })(), '');

// ⑤ 報告頁同一條儀表列
await page.evaluate(() => app.switchSubTab('report')); await page.waitForTimeout(3500);
// 儀表列放在結論卡 rpAct 上方(⛔ 不放 rpLead —— test_report ⓪b 釘住「有結論時 lead 要空」)
const R = await page.evaluate(() => { const l = document.getElementById('rpAct'); const s = l && l.querySelector('[data-gaugestrip]'); return { has: !!s, outer: s ? s.outerHTML : '' }; });
ok('⑤ ⭐ 報告頁頂端的儀表列 outerHTML == 總覽的(同一支函式;注入:報告頁改呼叫另一份 → 紅)', R.has && R.outer === A.stripOuter, `${R.has} ${R.outer.length} vs ${A.stripOuter.length}`);
await page.evaluate(() => app.switchSubTab('strategy'));

// ⑩ 換股後 _lastGauge 沒 sym 相符 → 儀表列不畫(直接假造殘留)
{
    const r = await page.evaluate(() => { const bak = app._lastGauge; app._lastGauge = { ...bak, sym: '9999' }; const h = app._gaugeStripHtml(app.currentSymbolId); app._lastGauge = bak; return h; });
    ok('⑩ _lastGauge.sym 對不上現在這檔 → 儀表列整條不畫(陷阱 #19 跨股殘留)', r === '', r.slice(0, 80));
}
// ⑫ 出場狀態:價格尺不畫買點
{
    const r = await page.evaluate(() => { const bak = app._keyLevels; app._keyLevels = { ...bak, exitMode: true }; const h = app._priceRulerHtml(); app._keyLevels = bak; return h; });
    ok('⑫ 出場狀態的價格尺:⛔ 沒有 🛒/🔺,套牢帶改講「反彈減碼位」', r && !/data-mark="轉強"|data-mark="買進"|data-mark="追買"/.test(r) && /反彈減碼位/.test(r), r.slice(0, 120));
}
// ⑪ 有部位 + 你設定的出場線被跌破 → 🚨 留在第一眼
{
    const r = await page.evaluate(() => {
        const bakInv = app.inventory, bakEx = app._exitLines;
        app.inventory = [{ symbol: '2327', cost: 700, shares: 1 }];
        app._exitLines = (d, s) => { const o = bakEx.call(app, d, s) || {}; const k = app._exitRuleKey(); return { ...o, [k]: 9999 }; };   // 你設定的那條硬設在現價之上 = 已跌破
        app._renderOvCommand(app.activeData);
        const txt = el => (el && el.innerText || '').replace(/\s+/g, ' ');
        const out = { cc: txt(document.getElementById('ovCommandCenter')), why: txt(document.getElementById('ovWhyBox')) };
        app.inventory = bakInv; app._exitLines = bakEx; app._renderOvCommand(app.activeData);
        return out;
    });
    ok('⑪ ⭐ 有部位且你設定的出場線被跌破 → 🚨 那一條留在第一眼(⛔ 不可被收進摺疊)', /🚨 已經/.test(r.cc), r.cc.slice(0, 200));
}

// ⑬ 手機 / 橫版不溢出(⚠️ 用 scrollX,不用 scrollWidth)
{
    const sx = await page.evaluate(() => { window.scrollTo(80, 0); return window.scrollX; });
    ok('⑬a 390px 不橫向溢出', sx <= 2, String(sx));
}
await page.close();
{
    const p2 = await boot({ width: 844, height: 390 }); await load(p2, '2327');
    const sx = await p2.evaluate(() => { window.scrollTo(80, 0); return window.scrollX; });
    ok('⑬b 844×390 橫版不橫向溢出', sx <= 2, String(sx)); await p2.close();
}
// 2330 / 0050:沒有套牢層也要畫得出尺(停損 + 現價 + 買進);ETF 009816 報告頁估值節誠實
{
    const p3 = await boot({ width: 390, height: 844 });
    await load(p3, '2330'); const B = await snap(p3);
    ok('⑥b 2330 沒有上方套牢層 → 尺仍畫得出(停損/買進/現價 ≥3 個標記)、沒有假的套牢帶', B.marks.length >= 3 && B.bands.length === 0 && B.ccLen <= 600, JSON.stringify({ marks: B.marks, bands: B.bands, len: B.ccLen }));
    ok('⑧b 2330 🔔 顆數 == _armTrigStash', (B.bell == null ? 0 : +B.bell) === B.stashN && B.stashN > 0, JSON.stringify({ bell: B.bell, stashN: B.stashN }));
    await p3.close();
}
// ── 🎨 V76.0.8 上色 / 對齊 / 五個面向真的有五個 ──
{
    const p4 = await boot({ width: 390, height: 844 });
    await load(p4, '2327'); const D = await snap(p4);
    console.log(`   2327 填色 ${D.gauges.map(x => x.k + '=' + (x.fill || '').replace(/bg-/, '')).join(',')} ・條 ${JSON.stringify(D.gauges[0] && D.gauges[0].bx)}`);
    // 🚨 沙箱沒有 Tailwind → 頁面上那張卡的祖先沒有寬度,量到的條寬可能是 **0**(0 == 0 會讓這條變成假綠燈)。
    //    → 把儀表列渲染進一個**寬度已知**的容器再量,並且先斷言「條真的有寬度」。
    const G = await p4.evaluate(() => {
        const d = document.createElement('div');
        d.style.cssText = 'width:340px;position:absolute;left:0;top:0';
        d.innerHTML = app._gaugeStripHtml(app.currentSymbolId);
        document.body.appendChild(d);
        const rows = [...d.querySelectorAll('[data-gauge]')].map(e => { const b = e.querySelector('[data-bar]').getBoundingClientRect();
            return { k: e.dataset.gauge, kind: e.dataset.kind, x: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1) }; });
        d.remove(); return rows;
    });
    console.log(`   340px 容器實測:${G.map(x => `${x.k} ${x.x}~${x.r}`).join(' ・')}`);
    ok('⑯ ⭐ 每一條量條的左右端點落在**同一條 x 軸**上(注入:非 risk 列不留徽章佔位 → 紅)',
       G.length >= 3 && G.every(x => x.w > 80) && G.every(x => Math.abs(x.x - G[0].x) <= 1 && Math.abs(x.r - G[0].r) <= 1),
       JSON.stringify(G));
    // ⚠️ 這裡一定要量**畫出來的寬度**,⛔ 不可比 `data-fill` 屬性 —— 屬性跟分數本來就是同一個變數算的,
    //    比它等於自己跟自己比(注入「寬度寫死 100%」時屬性照樣是對的 = 假綠燈,實測踩到過)。
    const F = await p4.evaluate(() => {
        const d = document.createElement('div'); d.style.cssText = 'width:340px;position:absolute;left:0;top:0';
        d.innerHTML = app._gaugeStripHtml(app.currentSymbolId); document.body.appendChild(d);
        const rows = [...d.querySelectorAll('[data-gauge]')].map(e => {
            const bw = e.querySelector('[data-bar]').getBoundingClientRect().width;
            const fw = e.querySelector('[data-fill]') ? e.querySelector('[data-fill]').getBoundingClientRect().width : null;
            return { k: e.dataset.gauge, pct: +e.dataset.pct, rel: fw == null ? null : +(fw / bw * 100).toFixed(1) };
        }); d.remove(); return rows;
    });
    ok('⑰ 每一條都有填色,而且**畫出來的**寬度 == 分數(注入:寬度寫死 100% → 紅)',
       F.length >= 3 && F.every(x => x.rel != null && Math.abs(x.rel - x.pct) <= 2), JSON.stringify(F));
    ok('⑰b ⭐ 燈號鐵則:位置類(基本面/預期)與大盤那格的**填色**⛔ 不可是紅或綠(② 只驗了文字色)',
       D.gauges.filter(x => ['fund', 'expect', 'mkt'].includes(x.k)).every(x => !/bg-red|bg-green/.test(x.fill || '')),
       JSON.stringify(D.gauges.map(x => [x.k, x.fill])));
    ok('⑰c 方向類(技術/籌碼)的填色照 58/42 紅綠',
       D.gauges.filter(x => x.kind === 'dir').every(x => /bg-(red|green|gray)-/.test(x.fill || '')
           && (x.pct >= 58 ? /bg-red/ : x.pct <= 42 ? /bg-green/ : /bg-gray/).test(x.fill)),
       JSON.stringify(D.gauges.filter(x => x.kind === 'dir').map(x => [x.pct, x.fill])));
    ok('⑱ ⭐ 價格尺沒有任何東西跑出卡片外(注入:把標籤放回軌道上 → 紅)。⛔ 不可用 scrollWidth 判 —— overflow-x:hidden 會把它救成假綠燈',
       D.prOver.length === 0, JSON.stringify(D.prOver));
    ok('⑱b 軌道上只有圖示、⛔ 沒有字(字全部搬到下面的圖例)', !/[0-9]/.test(D.rulerTrackHasText), D.rulerTrackHasText);
    ok('⑱c 圖例把每個價位都講完(停損/現價各一,數量 == 標記數 + 套牢層數)',
       D.legend.length === D.marks.length + D.bands.length, JSON.stringify({ legend: D.legend, marks: D.marks.length, bands: D.bands.length }));
    ok('⑲ ⭐ 標題那個數字 == 實際列數(注入:寫死「五個」→ 紅)',
       D.stripN === D.gauges.length && D.stripTitle.includes(String(D.gauges.length)) && !/五個面向/.test(D.stripTitle),
       JSON.stringify({ n: D.stripN, rows: D.gauges.length, t: D.stripTitle }));
    ok('㉑ ⭐ 一般股在總覽載入後就有 🧬 基本面 與 🎯 預期(注入:拿掉 _seedXrayFromCache → 紅)',
       D.gauges.some(x => x.k === 'fund') && D.gauges.some(x => x.k === 'expect'), JSON.stringify(D.gauges.map(x => x.k)));
    ok('⑳ 五格到齊時⛔ 不留那句「還在讀財報」的說明', D.gauges.length < 5 || D.stripNote === '', D.stripNote);
    // ㉓ 切股要清乾淨(陷阱 #19):2327 有分數 → 換一檔沒有基本面資料的,⛔ 不可沿用上一檔
    const sw = await p4.evaluate(async () => { await app.analyze('0050'); await new Promise(r => setTimeout(r, 1500));
        return { x: app._lastXrayScore, e: app._lastExpectScore, ga: app._gaugeArgs && app._gaugeArgs.sym }; });
    ok('㉓ 切股後 _lastXrayScore / _lastExpectScore / _gaugeArgs ⛔ 不可殘留上一檔(陷阱 #19)',
       (sw.x == null || String(sw.x.sym) === '0050') && (sw.e == null || String(sw.e.sym) === '0050') && (sw.ga == null || String(sw.ga) === '0050'), JSON.stringify(sw));
    await p4.waitForTimeout(6000); const E = await snap(p4);
    ok('⑳b ETF 只有 3 格,而且說的是「ETF 本來就沒有」不是「還在讀」(⛔ 不可讓使用者以為壞掉)',
       E.stripN === 3 && /ETF 是一籃子/.test(E.stripNote), JSON.stringify({ n: E.stripN, note: E.stripNote }));
    await p4.close();
}
ok('⑮ 無 pageerror', errs.length === 0, errs[0] || '');
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ GAUGE_TEST_PASS');
process.exit(fails.length ? 1 : 0);
