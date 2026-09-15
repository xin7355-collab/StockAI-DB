#!/usr/bin/env node
/**
 * 🎨 V77.1.1 —— 使用者五點的守門
 *
 *   ① 所有量條用**同色系明暗漸變**(⛔ 不是綠→黃→紅跨色 —— 燈號鐵則也管刻度尺)
 *   ② 總覽的「🧭 N 個面向一眼看」統一成報告頁海報那個樣子 + canvas 那顆 ⚠️ 要對齊
 *   ③ 📈 個股數據速覽的基本面/籌碼用顏色講「危險 / 好」——⛔ 門檻只能用既有的
 *   ④ 關鍵價位補上進場價 / 追買價(⛔ 只讀 _keyLevels,零新計算)
 *   ⑤ 完整報告 / 摘述報告的標題用顏色區隔
 *
 * ⛔ 每一條先想「注入什麼它會叫」:
 *   ⓐ 漸變改回單色   ⓑ 徽章改回右靠      ⓒ 沒門檻的格子也上色
 *   ⓓ 關鍵價位自己算 buyPx                ⓔ 空頭時把價位改掉
 *   ⓕ 完整報告標題全部同色                ⓖ 兩邊各寫一份色階表
 *
 * ⚠️ 幾何一律先注入 `scripts/lib_rwdshim.mjs`(沙箱沒有 Tailwind,量到的是假的 —— 陷阱 #40)。
 * ⚠️ 原始碼斷言先剝掉 `//` 註解(本 repo 被自己的註解救活已經六次)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

for (const s of ['2330', '2327']) if (!fs.existsSync(path.join(ROOT, 'data', `${s}.json`))) {
    console.log(`❌ 沒有 data/${s}.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1);
}

// ═══ 靜態:唯一真相 ══════════════════════════════════════════════
{
    const ramp = CODE.slice(CODE.indexOf('_GAUGE_RAMP: {'), CODE.indexOf('_gaugeRow(label, pct, o = {}) {'));
    ok('⓪a 切得到 _GAUGE_RAMP / _gaugeRamp / _gaugeFill(空過守門)',
       ramp.length > 300 && /_gaugeRamp\(kind, pct\)/.test(ramp) && /_gaugeFill\(kind, pct\)/.test(ramp), String(ramp.length));
    ok('ⓐs _gaugeFill 回的是 linear-gradient(⛔ 不可退回單色 / Tailwind class —— 沙箱量不到 class)',
       /linear-gradient\(90deg,\$\{c\[0\]\},\$\{c\[1\]\}\)/.test(ramp) && !/bg-red-400|bg-sky-500\/80'/.test(ramp), '');
    // ⓖ 色階表只有一份 —— canvas 海報⛔ 不可自己另寫一組 hex
    const draw = CODE.slice(CODE.indexOf('_rpDrawOwn(sym) {'), CODE.indexOf('_rpOwnSave(sym) {'));
    ok('ⓖs0 切得到 _rpDrawOwn(空過守門)', draw.length > 2000, String(draw.length));
    ok('ⓖs ⭐ 海報的量條色階讀共用的 _gaugeRamp(⛔ 不可回頭寫死 S.up/S.dn/S.risk 那組單色)',
       /this\._gaugeRamp\(k, v\)/.test(draw) && !/const fill = k === 'dir'/.test(draw), '');
    ok('ⓐs2 海報的量條是 createLinearGradient(⛔ 單色 fill 叫「漸變」是說謊)',
       /createLinearGradient\(/.test(draw) && /addColorStop\(0, ramp\[0\]\)/.test(draw), '');
    ok('ⓑs ⭐ 海報徽章走「固定寬 + 置中 + textBaseline middle」(⛔ 不可回到 align 右靠 + alphabetic 基線)',
       /BADGE_W/.test(draw) && /textBaseline = 'middle'/.test(draw) && /txt\(sym2, bcx, bcy, 22, S\.fg, '900', 'center'\)/.test(draw), '');
    ok('ⓑs2 ⭐ 改過的 textBaseline 一定要復原(⛔ 不復原後面每一行字都會跑掉)',
       /textBaseline = 'middle'[\s\S]{0,200}textBaseline = 'alphabetic'/.test(draw), '');
    // ⑤ 標題分色:兩邊同一份表
    const tone = CODE.slice(CODE.indexOf('_RP_SECTONE: ['), CODE.indexOf('_rpWallList(C) {'));
    ok('ⓕs0 切得到 _RP_SECTONE / _rpSecTone / _rpCardHex(空過守門)',
       tone.length > 300 && /_rpSecTone\(n\)/.test(tone) && /_rpCardHex\(title\)/.test(tone), String(tone.length));
    ok('ⓕs ⭐ 標題分色⛔ 不可用紅綠(紅綠只准講漲跌 —— 燈號鐵則)',
       !/text-red-|text-green-/.test(tone), '');
    ok('ⓕs2 海報的節標題讀同一份表(⛔ 不可另訂一套顏色)', /this\._rpCardHex\(title\)/.test(draw), '');
    // ④ 關鍵價位:只讀 _keyLevels
    const facts = CODE.slice(CODE.indexOf('_rpOwnFacts(sym) {'), CODE.indexOf('_RP_STYLE: {'));
    ok('ⓓs0 切得到 _rpOwnFacts(空過守門)', facts.length > 1000, String(facts.length));
    ok('ⓓs ⭐ 關鍵價位的進場/追買只讀 _keyLevels(⛔ 不可自己去算前高或均線)',
       /K\.buyPx/.test(facts) && /K\.addPx/.test(facts) && !/_chuResistanceZones|this\.peaks|_rpMaLevels\(\)\[20\]/.test(facts), '');
    const wl = CODE.slice(CODE.indexOf('_rpWallList(C) {'), CODE.indexOf('_rpWallsHtml(C) {'));
    ok('ⓓs2 §11 價格牆表也補上了(⛔ 陷阱 #37:同一份資料三個消費端,不可只接兩個)',
       /K\.buyPx > 0/.test(wl) && /K\.addPx > 0/.test(wl) && /_bearGate/.test(wl), '');
}

// ═══ 執行期 ═════════════════════════════════════════════════════
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', () => {});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(2500);
// 🚧 版面 shim:沒生效的話下面量到的幾何全是假的 → 直接紅燈,⛔ 不是印個警告繼續跑
const shimBad = await page.evaluate(rwdShim);
ok('⓪b 版面 shim 全部生效(⛔ 沒生效就代表底下量到的幾何是假的 —— 陷阱 #40)',
   Array.isArray(shimBad) && shimBad.length === 0, JSON.stringify(shimBad));

await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, '2330');
await page.waitForTimeout(8000);

// ── ② 總覽儀表列:白話逐字 == _GAUGE_SPEC[].tip ──────────────────
const R2 = await page.evaluate(() => {
    const st = document.querySelector('[data-gaugestrip]');
    if (!st) return { no: 1 };
    const rows = [...st.querySelectorAll('[data-gauge]')].map(e => {
        const tip = e.nextElementSibling && e.nextElementSibling.dataset.gaugetip ? e.nextElementSibling.textContent.trim() : null;
        const bar = e.querySelector('[data-bar]');
        return { k: e.dataset.gauge, kind: e.dataset.kind, tip, bh: bar ? +getComputedStyle(e.querySelector('[data-fill]')).height.replace('px', '') : null };
    });
    const spec = {};
    for (const [nm, v] of Object.entries(app._GAUGE_SPEC)) spec[v.key] = v.tip;
    return { rows, spec, hasRule: !!st.querySelector('.border-b'), n: st.querySelector('[data-gaugen]') ? +st.querySelector('[data-gaugen]').dataset.gaugen : -1 };
});
ok('ⓗ0 總覽儀表列抓得到、而且有 ≥3 列(空過守門)', !R2.no && R2.rows && R2.rows.length >= 3, JSON.stringify(R2).slice(0, 200));
ok('ⓗ ⭐ 每一列底下都有白話,而且**逐字**等於 _GAUGE_SPEC[].tip(⛔ 不可在呼叫端另寫一份)',
   R2.rows && R2.rows.length >= 3 && R2.rows.every(r => r.tip && r.tip === R2.spec[r.k]),
   JSON.stringify((R2.rows || []).map(r => [r.k, r.tip, R2.spec[r.k]])));
ok('ⓗ2 量條加粗到 8px(跟海報一致;⛔ 不可回到 6px)', R2.rows && R2.rows.every(r => r.bh === 8), JSON.stringify((R2.rows || []).map(r => r.bh)));
ok('ⓗ3 標題底下有一條分隔線(無框版面:標題 + border-b,⛔ 不是外框)', !!R2.hasRule, '');
ok('ⓗ4 標題的數字跟著實際列數走(⛔ 不可寫死「五個」)', R2.n === (R2.rows || []).length, `${R2.n} vs ${(R2.rows || []).length}`);

// ── ① 漸變:每一條都是「左深右亮」的同色系 ─────────────────────
const R1 = await page.evaluate(() => {
    const st = document.querySelector('[data-gaugestrip]');
    const rows = [...st.querySelectorAll('[data-fill]')].map(f => getComputedStyle(f).backgroundImage);
    const ruler = document.querySelector('[data-rulerfill]');
    return { rows, ruler: ruler ? getComputedStyle(ruler).backgroundImage : '' };
});
ok('ⓐ ⭐ 每一條量條的填色都是 linear-gradient(注入:改回單色 → 紅)',
   R1.rows.length >= 3 && R1.rows.every(x => /linear-gradient/.test(x)), JSON.stringify(R1.rows).slice(0, 220));
ok('ⓐ2 價格位置圖的填色也是漸變(「所有量條」= 包含這一條)', /linear-gradient/.test(R1.ruler), R1.ruler);

// ── ③ 速覽格子上色 + ② canvas 徽章對齊 ───────────────────────────
const R3 = await page.evaluate(async () => {
    const A = (typeof window !== "undefined" && window.app) || app;   // ⚠️ 陷阱 #5:const app = {} 沒掛 window
    A.switchSubTab('report');
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 600)); if (document.getElementById('rpOwnCv') && A._rpOwnDbg && A._rpOwnDbg.badges.length) break; }
    const d = A._rpOwnDbg || {};
    const F = A._rpOwnFacts('2330') || {};
    const K = A._keyLevels;
    return { badges: d.badges || [], bars: d.bars || [], tones: d.tones || [],
             lv: (F.lv || []).map(x => [x.n, x.v, x.t]),
             K: K ? { buyPx: K.buyPx, addPx: K.addPx, sym: String(K.sym) } : null };
});
ok('ⓑ0 canvas 徽章記到 ≥3 顆(空過守門)', R3.badges.length >= 3, String(R3.badges.length));
ok('ⓑ ⭐ 每顆徽章的繪製中心 == 它那條量條的垂直中心(注入:改回右靠 + alphabetic → 紅)',
   R3.badges.length >= 3 && R3.badges.every((b, i) => R3.bars[i] && Math.abs(b.y - (R3.bars[i].y + R3.bars[i].h / 2)) < 0.01),
   JSON.stringify(R3.badges.map((b, i) => [b.name, b.y, R3.bars[i] && (R3.bars[i].y + R3.bars[i].h / 2)])));
ok('ⓑ2 ⭐ 每顆徽章的 x **完全一致**(⛔ 不可讓 glyph 寬度決定位置 —— 沙箱沒有彩色 emoji 字型,重現不了,所以只釘幾何)',
   R3.badges.length >= 3 && R3.badges.every(b => Math.abs(b.x - R3.badges[0].x) < 0.01),
   JSON.stringify(R3.badges.map(b => [b.name, b.x])));
ok('ⓒ0 速覽有上色的格子 ≥1(空過守門 —— 0 筆代表這一條不算數)', R3.tones.length >= 1, JSON.stringify(R3.tones));
{
    // ⭐ 只有這幾個鍵可以上 ✅⚠️⛔ —— 其餘**本站沒有實測過的好壞門檻**,⛔ 不猜(陷阱 #38)
    const ALLOW = ['年增', '累計年增', '自由現金流近4季', 'ROE近4季', '淨利率', '融資追繳壓力區', '距現價'];
    const bad = R3.tones.filter(t => !ALLOW.some(a => String(t.k).startsWith(a)));
    ok('ⓒ ⭐ 只有「本站已經有門檻」的格子才上 ✅⚠️⛔(注入:給毛利率/千張大戶上色 → 紅)', bad.length === 0, JSON.stringify(bad));
    ok('ⓒ2 徽章只用 ✅⚠️⛔(⛔ 不可用 🔴🟢 —— 那是講漲跌的)', R3.tones.every(t => ['✅', '⚠️', '⛔'].includes(t.b)), JSON.stringify(R3.tones.map(t => t.b)));
}

// ── ④ 關鍵價位:值逐字 == _keyLevels ────────────────────────────
const nm = R3.lv.map(x => String(x[0]));
ok('ⓓ ⭐ 關鍵價位有「進場價 / 轉強價」與「追買價」(使用者:要知道等到這時候才能買)',
   nm.some(n => /進場價|轉強價|轉強觀察價/.test(n)) && nm.some(n => /追買價|前一個波段高點/.test(n)), JSON.stringify(nm));
ok('ⓓ2 值逐字 == _keyLevels.buyPx / addPx(⛔ 顯示端不自己算)',
   !!R3.K && R3.lv.some(x => x[2] === 'buy' && Math.abs(x[1] - R3.K.buyPx) < 1e-9)
         && R3.lv.some(x => x[2] === 'add' && Math.abs(x[1] - R3.K.addPx) < 1e-9),
   JSON.stringify([R3.K, R3.lv.filter(x => x[2] === 'buy' || x[2] === 'add')]));
// ⭐ 決定性對照:把 _keyLevels 換成**不可能巧合**的數字,畫面必須跟著變
//   ⛔ 只比「有沒有那幾個字」會被「buyPx 剛好等於月線」救活(V77.0.9 踩過)
const R4 = await page.evaluate(() => {
    const A = ((typeof window !== "undefined" && window.app) || app), K0 = A._keyLevels;
    A._keyLevels = Object.assign({}, K0, { buyPx: 987.65, addPx: 1234.56 });
    const F = A._rpOwnFacts('2330') || {};
    const W = A._rpWallList(A._rpLast) || [];
    A._keyLevels = K0;
    return { lv: (F.lv || []).filter(x => x.t === 'buy' || x.t === 'add').map(x => x.v),
             wall: W.filter(x => /進場價|轉強價|追買價|轉強觀察價|前一個波段高點/.test(x.n)).map(x => x.v) };
});
ok('ⓓ3 ⭐ 決定性對照:把 _keyLevels 換成 987.65 / 1234.56,海報要跟著變(注入:自己算 buyPx → 紅)',
   R4.lv.includes(987.65) && R4.lv.includes(1234.56), JSON.stringify(R4.lv));
ok('ⓓ4 ⭐ §11 價格牆表同樣跟著變(⛔ 兩個消費端不可只接一個)',
   R4.wall.includes(987.65) && R4.wall.includes(1234.56), JSON.stringify(R4.wall));
// ── ⓔ 空頭:價位一個都不動,只改名稱 ────────────────────────────
const R5 = await page.evaluate(() => {
    const A = ((typeof window !== "undefined" && window.app) || app), T0 = A._ovTrend, K = A._keyLevels;
    A._ovTrend = { sym: String(A.currentSymbolId), trend: 'bear', txt: '' };
    const F = A._rpOwnFacts('2330') || {};
    const W = A._rpWallList(A._rpLast) || [];
    A._ovTrend = T0;
    return { lv: (F.lv || []).filter(x => x.t === 'buy' || x.t === 'add').map(x => [x.n, x.v]),
             wallN: W.filter(x => /觀察價|前一個波段高點|進場價|轉強價|追買價/.test(x.n)).map(x => x.n),
             K: { buyPx: K.buyPx, addPx: K.addPx } };
});
ok('ⓔ ⭐ 空頭時名稱改成觀察價 / 前一個波段高點(⛔ 不可還寫「進場價 / 追買價」)',
   R5.lv.length >= 1 && R5.lv.every(([n]) => /觀察價|前一個波段高點/.test(n)) && !R5.wallN.some(n => /^進場價|^追買價/.test(n)),
   JSON.stringify([R5.lv, R5.wallN]));
ok('ⓔ2 ⭐ 但**價位一個都沒變**(事實不竄改 —— 只改叫人怎麼做的那句話)',
   R5.lv.length >= 1 && R5.lv.every(([, v]) => v === R5.K.buyPx || v === R5.K.addPx), JSON.stringify([R5.lv, R5.K]));

// ── ⑤ 完整報告標題分色 ─────────────────────────────────────────
const R6 = await page.evaluate(() => {
    const A = ((typeof window !== "undefined" && window.app) || app), sym = String(A.currentSymbolId);
    // 合成一份有 §N 的報告(⚠️ 測資形狀要跟真的一樣:標題帶 §N、第一行是基準日 —— 陷阱 #40)
    const txt = ['分析基準日期:2026-09-14', '§1 結論 這是結論', '§4 財務 這是財務', '§12 風險 這是風險', '§20 投資筆記 這是筆記'].join('\n');
    const NC0 = A._rpNoteCache;
    A._rpNoteCache = Object.assign({}, NC0 || {}, { [sym]: { t: txt, ts: Date.now(), asof: '2026-09-14', v: 2 } });
    const h = A._rpPasteHtml(A._rpLast);
    const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d);
    d.querySelectorAll('details').forEach(x => { x.open = true; });   // ⚠️ 關著的 <details> innerText 讀不到
    const rows = [...d.querySelectorAll('[data-rpsectone]')].map(e => ({ n: +e.dataset.rpsectone, cls: e.getAttribute('class') || '' }));
    const leg = d.querySelector('[data-rpsecleg]');
    const expect = rows.map(r => A._rpSecTone(r.n).cls);
    d.remove(); A._rpNoteCache = NC0;
    return { rows, expect, leg: !!leg, red: rows.some(r => /text-red-|text-green-/.test(r.cls)) };
});
ok('ⓕ0 完整報告切出 ≥3 個 §N 標題(空過守門)', R6.rows.length >= 3, JSON.stringify(R6.rows));
ok('ⓕ ⭐ 每個 §N 標題的顏色 == _rpSecTone(n).cls(注入:全部同色 → 紅)',
   R6.rows.length >= 3 && R6.rows.every((r, i) => r.cls.includes(R6.expect[i])) && new Set(R6.rows.map((r, i) => R6.expect[i])).size >= 3,
   JSON.stringify(R6.rows.map((r, i) => [r.n, r.cls, R6.expect[i]])));
ok('ⓕ2 ⛔ 標題不可用紅綠(紅綠只准講漲跌)', !R6.red, JSON.stringify(R6.rows.map(r => r.cls)));
ok('ⓕ3 有一行圖例說明顏色代表什麼(⛔ 不可讓使用者自己猜)', R6.leg, '');

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
