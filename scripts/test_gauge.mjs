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
    const g = [...cc.querySelectorAll('[data-gauge]')].map(e => ({ k: e.dataset.gauge, pct: +e.dataset.pct, kind: e.dataset.kind, html: e.innerHTML }));
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
ok('④ 缺維 → 那一列不存在、不顯 --(這個環境沒跑 X 光 → 基本面/預期本來就沒有)', !A.gauges.some(x => ['fund', 'expect'].includes(x.k)) && !/--/.test(A.stripOuter), '');
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
ok('⑮ 無 pageerror', errs.length === 0, errs[0] || '');
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ GAUGE_TEST_PASS');
process.exit(fails.length ? 1 : 0);
