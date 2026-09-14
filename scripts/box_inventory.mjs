#!/usr/bin/env node
/**
 * 🧱 全站「框」盤點(⛔ 巡邏工具不是測試,exit 0)
 *
 * 使用者:「整個系統比照無框邏輯製作」。
 * ⭐ 砍之前先量(同 card_inventory 的理由)—— 靜態 grep 只看得到寫死在 HTML 裡的那些,
 *    而全站 213 種組合裡有一大半是 JS 模板字串**跑起來才存在**。
 *
 * 分三類(照 CLAUDE.md「🧱 去框判準」):
 *   📦 section  一整段的外框            → **拿掉**
 *   🔲 cell     一排 ≥2 個同款框的格子   → **保留**(框在分「這是第幾格」)
 *   🔒 keep     按鈕/輸入框/警示左色條   → **保留**(框在講事情)
 *
 * 用法:node scripts/box_inventory.mjs [--json]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { rwdShim } = await import(path.join(ROOT, 'scripts/lib_rwdshim.mjs'));

const SUBTABS = ['strategy', 'report', 'chart', 'chip', 'corp', 'backtest', 'bullbear', 'daytrade', 'live'];
const SUBNAME = { strategy: '總覽', report: '報告', chart: 'K線', chip: '籌碼', corp: '基本', backtest: '回測', bullbear: '多空', daytrade: '當沖', live: '即時' };
const OPENERS = [['inv', '庫存'], ['stock', '個股'], ['radar', '選股'], ['market', '大盤'], ['fav', '自選'], ['desk', '決策台'], ['settings', '設定']];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app.switchAppTab === 'function', null, { timeout: 25000 });
const shimBad = await page.evaluate(rwdShim);
if (shimBad.length) { console.log('🚨 版面 shim 有規則沒生效 → 底下數字不可信:', shimBad.join('、')); process.exit(0); }

const PROBE = () => {
    const A = window.app || app;
    const vis = el => {
        if (!el.offsetParent && el.tagName !== 'BODY') return false;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const d = n.style && n.style.display;
            if (d === 'none') return false;
            if (!d && n.classList && n.classList.contains('hidden')) return false;
        }
        return true;
    };
    // 「四邊框」= 有 `border`(不帶方向)且有邊框色 class
    const isFrame = c => /(^|\s)border(\s|$)/.test(c) && /border-\[#(30363d|21262d|3d444d)\]/.test(c);
    const out = [];
    for (const el of document.querySelectorAll('div,details,section,li,a,button,label')) {
        const c = String(el.className || '');
        if (!isFrame(c) || !vis(el)) continue;
        const tag = el.tagName.toLowerCase();
        const interactive = ['button', 'input', 'textarea', 'select', 'a', 'label'].includes(tag)
            || !!el.closest('button,label') || /cursor-pointer|-tab\b|btn/.test(c);
        const alert = /border-l-\d|border-l-\[/.test(c);
        // 一排 ≥2 個「同款框」的兄弟 → 那是格子
        //   ⚠️ 比對前要剝掉 `keepbox` —— 標過的跟沒標的會變成「不同款」,自己把自己判成 section
        const sig = x => String(x || '').replace(/\bkeepbox\b/g, '')
            .split(/\s+/).filter(t => /^(bg-|border|rounded|p-|px-)/.test(t)).sort().join(' ');
        const mysig = sig(c);
        const sibs = el.parentElement ? [...el.parentElement.children]
            .filter(s => isFrame(String(s.className || '')) && sig(s.className) === mysig).length : 1;
        //   ⚠️ 「兄弟同款」還不夠 —— 兩張**並排的標準卡**也長這樣(實測籌碼頁被誤判成格子)。
        //   ⭐ 格子的特徵是**只裝一個數字**:字很少、而且裡面沒有別的框。
        const txtLen = (el.innerText || '').replace(/\s/g, '').length;
        const hasInnerFrame = [...el.querySelectorAll('*')].some(k => isFrame(String(k.className || '')));
        let depth = 0;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement)
            if (isFrame(String(n.className || ''))) depth += 1;
        const b = el.getBoundingClientRect();
        // 🚧 空過守門:⛔ 只數 class 的話,去框前後報出來的數字**一模一樣** = 這支工具沒有鑑別力。
        //   → 量 **computed style**:框到底還在不在(邊框顏色是不是透明 + 左右 padding 是不是 0)。
        const st = getComputedStyle(el);
        const flat = /rgba\(0, 0, 0, 0\)|transparent/.test(st.borderTopColor)
            && parseFloat(st.paddingLeft) === 0 && parseFloat(st.paddingRight) === 0;
        out.push({
            id: el.id || '', cls: c.slice(0, 70), tag,
            kind: interactive ? 'keep-互動' : alert ? 'keep-警示' : (sibs >= 2 && txtLen <= 40 && !hasInnerFrame) ? 'cell' : 'section',
            sibs, depth, w: Math.round(b.width), txt: txtLen, flat,
        });
    }
    return out;
};

const nap = ms => page.waitForTimeout(ms);
const all = [];
for (const [opener, oname] of OPENERS) {
    try {
        if (opener === 'settings') { await page.evaluate(() => app.openSettings()); await nap(700); }
        else if (opener === 'stock') {
            await page.evaluate(async () => { app.switchAppTab('diag'); await app.analyze('2330'); });
            await nap(3000);
            for (const t of SUBTABS) {
                await page.evaluate(t => { app.switchAppTab('diag'); app.switchSubTab(t); }, t);
                await nap(1600);
                (await page.evaluate(PROBE)).forEach(x => all.push({ ...x, page: `個股/${SUBNAME[t]}` }));
            }
            continue;
        } else { await page.evaluate(o => app.switchAppTab(o), opener); await nap(1500); }
        (await page.evaluate(PROBE)).forEach(x => all.push({ ...x, page: oname }));
        if (opener === 'settings') await page.evaluate(() => document.getElementById('settingsModal')?.classList.add('hidden'));
    } catch (e) { console.log(`⚠️ ${oname} 掃不到:${String(e).slice(0, 80)}`); }
}
await browser.close();

if (!all.length) { console.log('🚨 掃到 0 個框 → 切不過去或選擇器過時,⛔ 這一輪不算數'); process.exit(0); }
const by = k => all.reduce((m, x) => (m[x[k]] = (m[x[k]] || 0) + 1, m), {});
console.log(`\n🧱 全站可見的「四邊框」共 ${all.length} 個(390px,⚠️ 同一個元素在多頁出現會重複計)\n`);
console.log('分類:', JSON.stringify(by('kind')));
console.log('巢狀深度:', JSON.stringify(by('depth')));
// ⭐ 這一行才是「去框有沒有生效」的答案(⛔ 上面那些只是 class 還在不在)
const sec = all.filter(x => x.kind === 'section');
const keep = all.filter(x => x.kind !== 'section');
console.log(`\n🧱 去框實際生效:📦 section ${sec.filter(x => x.flat).length}/${sec.length} 已拉平`
    + ` ・🔒/🔲 該保留的 ${keep.filter(x => !x.flat).length}/${keep.length} 框還在`);
const missed = sec.filter(x => !x.flat);
if (missed.length) {
    console.log('  ⚠️ 這幾個 section 沒被拉平(規則選不到 → 要人工看):');
    [...new Map(missed.map(x => [x.cls, x])).values()].slice(0, 10)
        .forEach(x => console.log(`     ${x.page.padEnd(10)} ${x.tag} ${x.id ? '#' + x.id + ' ' : ''}${x.cls}`));
}
const broke = keep.filter(x => x.flat);
if (broke.length) {
    console.log('  🚨 這幾個**該保留**的框被誤拉平了(⛔ 框在講事情):');
    [...new Map(broke.map(x => [x.cls, x])).values()].slice(0, 10)
        .forEach(x => console.log(`     ${x.page.padEnd(10)} ${x.kind} ${x.tag} ${x.cls}`));
}
console.log('\n每頁:');
const pages = [...new Set(all.map(x => x.page))];
for (const p of pages) {
    const r = all.filter(x => x.page === p);
    const c = r.reduce((m, x) => (m[x.kind] = (m[x.kind] || 0) + 1, m), {});
    console.log(`  ${p.padEnd(12)} 共 ${String(r.length).padStart(3)} ・📦 section ${String(c.section || 0).padStart(3)} ・🔲 cell ${String(c.cell || 0).padStart(3)} ・🔒 keep ${(c['keep-互動'] || 0) + (c['keep-警示'] || 0)}`);
}
console.log('\n🔲 會被「保留」的格子(一排 ≥2 個同款框)—— 這些就是 `.keepbox` 要標的地方:');
const cells = all.filter(x => x.kind === 'cell');
const seen = new Map();
for (const x of cells) { const k = x.cls; if (!seen.has(k)) seen.set(k, { ...x, n: 0 }); seen.get(k).n += 1; }
[...seen.values()].sort((a, b) => b.n - a.n).slice(0, 20)
    .forEach(x => console.log(`  ×${String(x.n).padStart(3)}  ${x.page.padEnd(10)} ${x.id ? '#' + x.id + ' ' : ''}${x.cls}`));
console.log('\n⚠️ 這是**巡邏工具不是測試** —— 每一筆都要人工看過。cell/section 的判準是「有沒有 ≥2 個同款框的兄弟」,');
console.log('   ⛔ 它看不出「這個框在講什麼事」,那要人判。');
if (process.argv.includes('--json')) console.log('\n__JSON__' + JSON.stringify(all));
