#!/usr/bin/env node
/**
 * 🧱 全站無框(V77.0.0)—— 使用者:「整個系統比照無框邏輯製作」
 *
 * ⭐ 釘的是**用意**(⛔ 不釘 class 字串、⛔ 不釘「有幾個框」):
 *   ⓐ 一整段的外框**真的**被拉平了(量 computed style,⛔ 不是看 class 還在不在)
 *   ⓑ 而且左右 padding 真的還給內容了
 *   ⓒ 🔒 框在講事情的**一個都不可以被拉平**:按鈕 / ⚠️ 警示左色條 / `.keepbox` 格子
 *   ⓓ pro.html 的 `.panel` 同步無框,而一排一張的 `.vcard` 保留
 *
 * ⚠️ 幾何一律先注入 `scripts/lib_rwdshim.mjs`(沙箱沒有 Tailwind → 不注入量到的全是假的,陷阱 #40)。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { rwdShim } = await import(path.join(ROOT, 'scripts/lib_rwdshim.mjs'));
const fail = [];
const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) fail.push(m); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });

// ══════════ index.html ══════════
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app.analyze === 'function', null, { timeout: 25000 });
await page.evaluate(async () => { const A = window.app || app; A.switchAppTab('diag'); await A.analyze('2330'); });
await page.waitForTimeout(4500);
const shimBad = await page.evaluate(rwdShim);
ck(shimBad.length === 0, `🚧 版面 shim 全過(沒生效的:${shimBad.join('、') || '無'})—— ⛔ 非空的話底下幾何全部不可信`);

// ⚠️ 一頁只有 1~2 個框是**正常的**(box_inventory 實測:總覽 2 個、K線 9 個)——
//   ⛔ 只量一頁會讓「空過守門」誤判成「切不過去」。→ 逐頁量、累加(照 box_inventory 的走法)。
const PROBE = () => {
    const vis = el => {
        if (!el.offsetParent) return false;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const d = n.style && n.style.display;
            if (d === 'none') return false;
            if (!d && n.classList && n.classList.contains('hidden')) return false;
        }
        return true;
    };
    const isFrame = c => /(^|\s)border(\s|$)/.test(c) && /border-\[#30363d\]/.test(c);
    const out = { boxes: [], raw: 0, cw: (document.getElementById('appMainArea') || {}).clientWidth || 0 };
    for (const el of document.querySelectorAll('div,details,section,button,a,label')) {
        const c = String(el.className || '');
        if (!isFrame(c)) continue;
        out.raw += 1;
        if (!vis(el)) continue;
        const st = getComputedStyle(el);
        const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(st.borderTopColor);
        const noPad = parseFloat(st.paddingLeft) === 0 && parseFloat(st.paddingRight) === 0;
        const tag = el.tagName.toLowerCase();
        const keep = ['button', 'input', 'textarea', 'select', 'a', 'label'].includes(tag)
            || /cursor-pointer/.test(c) || /border-l-\d|border-l-\[/.test(c) || /\bkeepbox\b/.test(c);
        out.boxes.push({ keep, flat: transparent && noPad, cls: c.slice(0, 56), tag });
    }
    return out;
};
const R = { boxes: [], raw: 0, cw: 0 };
for (const t of ['strategy', 'chip', 'chart', 'corp', 'daytrade', 'bullbear']) {
    await page.evaluate(t => { const A = window.app || app; A.switchAppTab('diag'); A.switchSubTab(t); }, t);
    await page.waitForTimeout(1600);
    const r = await page.evaluate(PROBE);
    R.boxes.push(...r.boxes); R.raw = Math.max(R.raw, r.raw); R.cw = Math.max(R.cw, r.cw);
}
for (const [o] of [['inv'], ['radar'], ['market'], ['fav']]) {
    await page.evaluate(o => app.switchAppTab(o), o);
    await page.waitForTimeout(1400);
    const r = await page.evaluate(PROBE);
    R.boxes.push(...r.boxes);
}
await page.close();

ck(R.cw >= 350, `🚧 空過守門:量測容器有 ${R.cw}px(⛔ 太窄的話下面沒有鑑別力)`);
ck(R.raw >= 20, `🚧 空過守門:整份文件只有 ${R.raw} 個四邊框 class → 選擇器過時,⛔ 這一輪不算數`);
const sec = R.boxes.filter(b => !b.keep), keep = R.boxes.filter(b => b.keep);
ck(sec.length >= 5, `ⓐ0 🚧 空過守門:只掃到 ${sec.length} 個一整段的外框 → 這一輪不算數(切不過去或選擇器過時)`);
const notFlat = sec.filter(b => !b.flat);
ck(notFlat.length === 0,
   `ⓐ 有 ${notFlat.length} 個一整段的外框沒被拉平 → 框又把左右空間吃回去了:${notFlat.slice(0, 3).map(b => b.cls).join(' | ')}`);
ck(keep.length >= 3, `ⓒ0 🚧 空過守門:只掃到 ${keep.length} 個「該保留」的框 → ⓒ 不算數`);
const broke = keep.filter(b => b.flat);
ck(broke.length === 0,
   `ⓒ 有 ${broke.length} 個**框在講事情**的被拉平了(按鈕 / ⚠️ 警示邊 / keepbox 格子):${broke.slice(0, 3).map(b => b.tag + ' ' + b.cls).join(' | ')}`);

// ══════════ pro.html ══════════
const p2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
p2.on('pageerror', () => {});
await p2.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(2500);
const P = await p2.evaluate(() => {
    // ⚠️ `.vcard` / `.tab-btn` 是 **JS 模板字串**產的,載入當下 DOM 裡不一定有
    //   → 建一個臨時元素量**那條 CSS 規則**本身(⛔ 不靠畫面上剛好有一個,否則是 null 假失敗)
    const one = sel => {
        const d = document.createElement('div'); d.className = sel.replace(/^\./, '');
        document.body.appendChild(d);
        const s = getComputedStyle(d);
        const r = { bw: parseFloat(s.borderTopWidth) || 0, bb: parseFloat(s.borderBottomWidth) || 0,
                    pl: parseFloat(s.paddingLeft), bg: s.backgroundColor };
        d.remove(); return r;
    };
    return { panel: one('.panel'), vcard: one('.vcard'), btn: one('.tab-btn'), n: (document.head.innerHTML.match(/\.panel\{/g) || []).length
             + document.querySelectorAll('.panel').length };
});
await p2.close();
await browser.close();

ck(P.n >= 1, `ⓓ0 🚧 空過守門:pro.html 找不到 .panel 的規則或元素 → 這幾條不算數`);
if (P.panel) {
    ck(P.panel.bw === 0 && P.panel.pl === 0,
       `ⓓ pro.html 的 .panel 還有框(上邊框 ${P.panel.bw}px ・左內距 ${P.panel.pl}px)→ 沒跟著無框`);
    ck(P.panel.bb >= 1, 'ⓓ2 .panel 沒有底部分隔線 → 段跟段會糊成一片(⛔ 使用者選的是「留分隔線」不是「只靠留白」)');
} else ck(false, 'ⓓ0b 找不到 .panel');
ck(!!P.vcard && P.vcard.bw >= 1,
   'ⓔ pro.html 的 .vcard 也被拉平了 → ⛔ 那是**一排一張**的卡,框在分「這是第幾張」');
ck(!!P.btn && P.btn.bw >= 1, 'ⓔ2 pro.html 的分頁鈕沒有框了 → ⛔ 框在講「這裡可以點」');

console.log();
if (fail.length) { console.log(`❌ NOFRAME_FAIL:${fail.length} 條`); process.exit(1); }
console.log('✅ NOFRAME_PASS(全部通過)');
