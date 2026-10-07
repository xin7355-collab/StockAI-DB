#!/usr/bin/env node
/**
 * 👁️ 說明小字對比(V78.5.6)—— Repo X-Ray 顧問診斷「字夠大、對比夠」
 *
 * ⭐ 用真實資料真的開頁面量(2330 的 9 個個股分頁 + 決策台 / 大盤 / 選股 / 庫存),
 *    每一個**看得見、而且自己有字**的 `.text-gray-500` / `.text-gray-600`,
 *    算它跟「最近的不透明底色」的對比,小字門檻 WCAG 4.5:1。
 *
 * ⚠️ 沙箱連不到 Tailwind CDN(陷阱 #40)→ 兩件事自己補:
 *   ① 文字色:**把 Tailwind 原本的 gray-500/600 規則追加到 <head> 最後面**(= CDN 實際插入的位置),
 *      這樣量到的是「我們那條覆寫有沒有贏過 Tailwind」—— ⭐ 決定性對照:拿掉覆寫那兩行必須紅。
 *   ② 底色:Tailwind 的 bg-* class 在沙箱沒有效果 → 照 class 名解析(bg-[#hex] / bg-white/5 / bg-red-900/30 …),
 *      解析不了的那一格**不量並計數**(⛔ 不假裝量過)。
 *   ③ hover: 還要能變亮(特異度 (0,2,0) 要贏我們的 (0,1,2))—— 合成一顆按鈕真的 hover 一次。
 * ⛔ 透明度 < 0.75 的(停用 / 淡化中的按鈕)WCAG 不要求,另外計數不算失敗。
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { rwdShim } = await import(path.join(ROOT, 'scripts/lib_rwdshim.mjs'));
const SRC = process.env.CONTRAST_SRC || path.join(ROOT, 'index.html');
const fail = [];
const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) fail.push(m); };

// Tailwind v3 預設色(只放會當底色的深色階;⛔ 不是全表)
const PAL = {
    red: { 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
    green: { 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
    yellow: { 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
    orange: { 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
    amber: { 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
    blue: { 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
    cyan: { 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
    purple: { 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
    emerald: { 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
    sky: { 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
    pink: { 800: '#9d174d', 900: '#831843', 950: '#500724' },
    teal: { 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
    indigo: { 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
    rose: { 800: '#9f1239', 900: '#881337', 950: '#4c0519' },
    violet: { 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
    slate: { 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
    gray: { 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
};
const TW_TEXT = `.text-gray-500{color:#6b7280}.text-gray-600{color:#4b5563}.hover\\:text-gray-200:hover{color:#e5e7eb}`
    + [40, 50, 60, 70, 75, 80, 90].map(o => `.opacity-${o}{opacity:${o / 100}}`).join('');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
let url = 'file://' + SRC, tmp = null;
if (process.env.CONTRAST_SRC) { tmp = path.join(ROOT, '.contrast_tmp.html'); fs.copyFileSync(SRC, tmp); url = 'file://' + tmp; }
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app.analyze === 'function', null, { timeout: 25000 });
await page.evaluate(css => { const s = document.createElement('style'); s.id = '__twShim'; s.textContent = css; document.head.appendChild(s); }, TW_TEXT);
await page.evaluate(async () => { app.switchAppTab('diag'); await app.analyze('2330'); });
await page.waitForTimeout(4500);
const shimBad = await page.evaluate(rwdShim);
ck(shimBad.length === 0, `🚧 版面 shim 全過(沒生效:${shimBad.join('、') || '無'})`);

const PROBE = (PAL) => {
    const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const rgba = s => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(x => parseFloat(x)); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
    const lum = c => { const v = c.slice(0, 3).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + bot[i] * (1 - a)).concat(1); };
    // 一個元素自己的底色(class 解析優先,其次 inline / computed);回 null = 透明;回 'unknown' = 解析不了
    const bgOf = el => {
        const st = getComputedStyle(el);
        const inl = rgba(st.backgroundColor);
        if (inl && inl[3] > 0 && el.style && el.style.background + el.style.backgroundColor) return inl;
        for (const t of String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className || '').split(/\s+/)) {
            if (!/^bg-/.test(t) || /^bg-(gradient|opacity|clip|cover|center|no-repeat|fixed)/.test(t)) continue;
            let m;
            const op = (t.match(/\/(\d+)$/) || [])[1]; const a = op ? +op / 100 : 1;
            if ((m = t.match(/^bg-\[#([0-9a-fA-F]{3,6})\]/))) return hex(m[1]).concat(a);
            if (t === 'bg-transparent') continue;
            if ((m = t.match(/^bg-(white|black)(\/\d+)?$/))) return (m[1] === 'white' ? [255, 255, 255] : [0, 0, 0]).concat(a);
            if ((m = t.match(/^bg-([a-z]+)-(\d{2,3})(\/\d+)?$/))) { const h = PAL[m[1]] && PAL[m[1]][m[2]]; return h ? hex(h).concat(a) : 'unknown'; }
        }
        // ⚠️ Tailwind preflight 會把 button/input 的瀏覽器預設灰底清成透明;沙箱沒載 preflight → 只認 inline
        if (inl && inl[3] > 0 && !/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return inl;
        return null;
    };
    const vis = el => {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const d = n.style && n.style.display; if (d === 'none') return false;
            if (!d && n.classList && n.classList.contains('hidden')) return false;
            if (n.tagName === 'DETAILS' && !n.open && n !== el && !(el.closest('summary') && el.closest('details') === n)) return false;
        }
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    };
    const out = { n: 0, pass: 0, fails: [], unknown: 0, faded: 0 };
    for (const el of document.querySelectorAll('.text-gray-500,.text-gray-600')) {
        const own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
        if (!own || !vis(el)) continue;
        let alpha = 1; for (let n = el; n; n = n.parentElement) alpha *= parseFloat(getComputedStyle(n).opacity || 1);
        if (alpha < 0.75) { out.faded++; continue; }
        const layers = []; let bad = false;
        for (let n = el; n; n = n.parentElement) {
            const b = bgOf(n); if (b === 'unknown') { bad = true; break; }
            if (b) { layers.push(b); if (b[3] >= 1) break; }
        }
        if (bad) { out.unknown++; continue; }
        let bg = [13, 17, 23, 1];
        for (let i = layers.length - 1; i >= 0; i--) bg = layers[i][3] >= 1 ? layers[i] : over(layers[i], bg);
        let fg = rgba(getComputedStyle(el).color); if (!fg) continue;
        fg = over([fg[0], fg[1], fg[2], fg[3] * alpha], bg);
        const r = ratio(fg, bg);
        out.n++;
        if (r >= 4.5) out.pass++;
        else out.fails.push({ r: +r.toFixed(2), cls: String(el.className).slice(0, 60), txt: el.textContent.trim().slice(0, 18), bg: bg.slice(0, 3).map(x => Math.round(x)).join(',') });
    }
    return out;
};

const tot = { n: 0, pass: 0, fails: [], unknown: 0, faded: 0, pages: 0 };
const add = (name, r) => { tot.n += r.n; tot.pass += r.pass; tot.unknown += r.unknown; tot.faded += r.faded; if (r.n) tot.pages++; r.fails.forEach(f => tot.fails.push({ page: name, ...f })); };
for (const t of ['strategy', 'realtime', 'daytrade', 'chart', 'chip', 'corp', 'backtest', 'report']) {
    await page.evaluate(t => { app.switchAppTab('diag'); try { app.switchSubTab(t); } catch (_) {} }, t);
    await page.waitForTimeout(1500);
    add('個股/' + t, await page.evaluate(PROBE, PAL));
}
for (const o of ['deck', 'market', 'radar', 'inv', 'fav']) {
    await page.evaluate(o => { try { app.switchAppTab(o); } catch (_) {} }, o);
    await page.waitForTimeout(1500);
    add(o, await page.evaluate(PROBE, PAL));
}
// ③ hover 仍要變亮
const hov = await page.evaluate(() => {
    const b = document.createElement('button'); b.id = '__hov'; b.className = 'text-gray-500 hover:text-gray-200';
    b.textContent = 'hover test'; b.style.cssText = 'position:fixed;top:300px;left:20px;z-index:99999;padding:10px';
    document.body.appendChild(b); return getComputedStyle(b).color;
});
await page.hover('#__hov');
const hov2 = await page.evaluate(() => getComputedStyle(document.getElementById('__hov')).color);
await browser.close();
if (tmp) fs.unlinkSync(tmp);

const pct = tot.n ? tot.pass / tot.n * 100 : 0;
console.log(`📊 量了 ${tot.pages} 頁 ${tot.n} 段小字:通過 ${tot.pass}(${pct.toFixed(1)}%)・底色解析不了 ${tot.unknown}・刻意淡化 ${tot.faded}`);
const byBg = {}; tot.fails.forEach(f => { byBg[f.bg] = (byBg[f.bg] || 0) + 1; });
if (tot.fails.length) console.log('   沒過的底色分布:', JSON.stringify(byBg), '\n   例:', tot.fails.slice(0, 6).map(f => `${f.page} ${f.r} [${f.bg}] 「${f.txt}」`).join(' / '));
ck(tot.n >= 300 && tot.pages >= 8, `🚧 空過守門:量到 ${tot.n} 段 / ${tot.pages} 頁(太少 = 沒切到頁或選擇器過時)`);
ck(pct >= 97, `⭐ 灰色小字對比 ≥4.5:1 的比例 ${pct.toFixed(1)}%(門檻 97%;剩下的是彩色 chip 底)`);
ck(hov === 'rgb(139, 148, 158)', `覆寫有贏過後插入的 Tailwind 規則(量到 ${hov})`);
ck(hov2 === 'rgb(229, 231, 235)', `hover: 仍能變亮(量到 ${hov2})`);
console.log(fail.length ? `\n❌ CONTRAST_FAIL ${fail.length}` : '\n✅ CONTRAST_PASS');
process.exit(fail.length ? 1 : 0);
