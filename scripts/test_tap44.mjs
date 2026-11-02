#!/usr/bin/env node
/**
 * 👆 V80.2.1 常用按鈕的點擊範圍 ≥ 44×44(觸控螢幕)
 *   手機(390×844、觸控 = pointer: coarse):每一顆的中心往上下左右各 21px 點下去,一定點到它自己
 *   (= 點擊範圍夠大,而且跟隔壁那顆沒有重疊)
 *     頂端 🔍 🤖 產 ⚙️ 🔔 ・消息面三顆分頁鈕 ・大盤五顆子分頁 ・個股頁子分頁
 *   ① 頂端列高度跟滑鼠版(pointer: fine)一模一樣(⛔ 為了放大按鈕把頂端撐高)
 *   ② ⭐ 決定性對照:同一頁換成滑鼠(pointer: fine)→ 頂端那幾顆一定有點不到的(證明是那段 CSS 讓它過的)
 *   ③ 空過守門:觸控那一輪 matchMedia('(pointer: coarse)') 一定要成立;每一組至少量到一顆
 *   INJECT=nocss → 拿掉那段 @media → ⓐ 必紅
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let HTML = path.join(ROOT, 'index.html');
if (process.env.INJECT === 'nocss') {
    const s = fs.readFileSync(HTML, 'utf8'), a = '    @media (pointer: coarse) {\n        header .hdr-left { overflow: visible; }';
    if (!s.includes(a)) { console.error('❌ 注入點找不到'); process.exit(1); }
    HTML = path.join(os.tmpdir(), 'tap44_nocss.html');
    fs.writeFileSync(HTML, s.replace(a, '    @media (pointer: nonexistent) {\n        header .hdr-left { overflow: visible; }'));
    console.log('🧪 INJECT=nocss:那段 CSS 不生效');
}
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails++; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
async function probe(touch) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await ctx.newPage();
    await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app.switchNewsPane === 'function', null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const shimBad = await page.evaluate(rwdShim);
    const R = await page.evaluate(async () => {
        const out = { coarse: matchMedia('(pointer: coarse)').matches, groups: {} };
        const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const hitOK = el => {
            try { el.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (_) {}   // 個股子分頁那排可以橫捲 → 畫面外的點不到(elementFromPoint 回 null)
            const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, miss = [];
            for (const [dx, dy] of [[-21, 0], [21, 0], [0, -21], [0, 21]]) {
                const h = document.elementFromPoint(cx + dx, cy + dy);
                if (!h || !(h === el || el.contains(h))) miss.push(`${dx},${dy}→${h ? (h.id || h.tagName) : 'null'}`);
            }
            const cs = getComputedStyle(el);
            return { w: Math.round(r.width), h: Math.round(r.height), mbox: Math.round(r.height + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0)), miss };
        };
        const take = (key, els) => { out.groups[key] = els.filter(vis).map(el => ({ t: (el.id || el.getAttribute('title') || el.textContent || '').trim().slice(0, 12), ...hitOK(el) })); };
        const hdr = document.querySelector('.header-fixed header');
        out.headH = Math.round(hdr.getBoundingClientRect().height);
        const pro = document.getElementById('hdrProBtn'); if (pro) pro.style.display = 'flex';   // 產 那顆預設藏著,打開量一次
        take('頂端', [...hdr.querySelectorAll('button')]);
        out.headH2 = Math.round(hdr.getBoundingClientRect().height);
        if (pro) pro.style.display = 'none';
        app.switchAppTab('market'); app.switchMarketSubTab('global'); app.switchNewsPane('news');
        await new Promise(r => setTimeout(r, 400));
        take('消息面分頁', [...document.querySelectorAll('[data-newspane]')]);
        take('大盤子分頁', [...document.querySelectorAll('button[onclick^="app.switchMarketSubTab("]')]);
        app.switchAppTab('diag');
        await new Promise(r => setTimeout(r, 400));
        take('個股子分頁', [...document.querySelectorAll('.sub-tab-btn')]);
        return out;
    });
    await ctx.close();
    return { ...R, shimBad };
}
const T = await probe(true), M = await probe(false);
ok('③ 觸控那一輪真的是觸控(pointer: coarse);滑鼠那一輪不是', T.coarse && !M.coarse, `${T.coarse}/${M.coarse}`);
ok('③ 版面 shim 全部生效(⛔ 量到假的幾何)', !T.shimBad.length && !M.shimBad.length, [...T.shimBad, ...M.shimBad].join('・'));
for (const g of ['頂端', '消息面分頁', '大盤子分頁', '個股子分頁']) {
    const L = T.groups[g] || [];
    ok(`③ ${g}:至少量到一顆`, L.length > 0, JSON.stringify(L));
    const bad = L.filter(x => x.miss.length);
    ok(`ⓐ 觸控:${g} 每一顆中心 ±21px 都點得到自己(${L.length} 顆)`, L.length > 0 && !bad.length, JSON.stringify(bad));
}
ok('ⓐ 頂端含「產」那顆(有自己的框,用 ::after 擴)', (T.groups['頂端'] || []).some(x => x.t === 'hdrProBtn' && !x.miss.length), JSON.stringify(T.groups['頂端']));
// ⚠️ 沙箱沒有 Tailwind 的 preflight(按鈕預設邊框 / svg 行內留白)→ 滑鼠那一輪的頂端本來就比正式環境高,⛔ 不能比「一樣高」
//   → 改釘兩件:觸控 ≤ 滑鼠(⛔ 撐高),而且每顆按鈕佔的高度(含 −4px 外距)≤ 36px = 正式環境頂端內容高(🔍 28px 圖示 + p-1 上下 4px)
ok('① 頂端列:觸控 ≤ 滑鼠(⛔ 為了放大按鈕把頂端撐高)', T.headH > 0 && T.headH <= M.headH && T.headH2 <= M.headH2, `觸控 ${T.headH}/${T.headH2} ・滑鼠 ${M.headH}/${M.headH2}`);
ok('① 頂端每顆按鈕佔的高度(含 −4px 外距)≤ 36px(= 正式環境頂端內容高,所以頂端不會變高)', (T.groups['頂端'] || []).filter(x => x.t !== 'hdrProBtn').every(x => x.mbox <= 36), JSON.stringify((T.groups['頂端'] || []).map(x => [x.t, x.mbox])));
{
    const mb = (M.groups['頂端'] || []).filter(x => x.miss.length);
    ok('② ⭐ 決定性對照:滑鼠(pointer: fine)頂端一定有點不到的(是那段 CSS 讓觸控過的)', mb.length > 0, JSON.stringify(M.groups['頂端']));
}
await browser.close();
console.log(fails ? `\n❌ ${fails} 條沒過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
