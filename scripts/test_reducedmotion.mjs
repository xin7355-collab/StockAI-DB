// ♿ V80.1.2 iPhone「減少動態效果」:閃爍 / 旋轉 / 轉場停掉、JS 捲動也不滑(19 個專案評估 3-1)
//  ⓐ 靜態:index.html 有 prefers-reduced-motion 那條、⛔ 不可再有寫死的 behavior: 'smooth'
//  ⓑ 打開「減少動態效果」→ animate-pulse / animate-spin 的 animation-name = none、_scrollB() = 'auto'
//  ⓒ ⭐ 決定性對照:同一頁、沒打開 → 照樣在閃(animation-name = pulse / spin)、_scrollB() = 'smooth'
//  ⚠️ 沙箱載不到 Tailwind → 自己補 Tailwind 那兩條動畫定義(不補的話「沒在動」是因為根本沒定義,測試沒有鑑別力)
// 跑法:node scripts/test_reducedmotion.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) FAIL.push(n); };

ok('ⓐ 有 @media (prefers-reduced-motion: reduce) 而且管到 animate-pulse', /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.animate-pulse[^}]*animation:\s*none !important/.test(SRC));
ok("ⓐ2 ⛔ 不可再有寫死的 behavior: 'smooth'(要走 app._scrollB())", !/behavior:\s*'smooth'/.test(SRC) && /behavior: app\._scrollB\(\)/.test(SRC));

const TW = `@keyframes pulse{50%{opacity:.5}} .animate-pulse{animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite}
@keyframes spin{to{transform:rotate(360deg)}} .animate-spin{animation:spin 1s linear infinite}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const probe = async (reduce) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: reduce ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|echarts|Cache\.put|file' is unsupported/i.test(t)) errs.push(t); });
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._scrollB, null, { timeout: 30000 });
    await page.addStyleTag({ content: TW });
    const r = await page.evaluate(() => {
        const mk = c => { const d = document.createElement('div'); d.className = c; d.textContent = 'x'; document.body.appendChild(d); return getComputedStyle(d).animationName; };
        return { pulse: mk('animate-pulse'), spin: mk('animate-spin'), sb: app._scrollB(), mm: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    await ctx.close();
    return { ...r, errs };
};
const RED = await probe(true), NORM = await probe(false);
ok('ⓑ 打開「減少動態效果」→ 閃爍 / 旋轉都停、捲動不滑', RED.mm && RED.pulse === 'none' && RED.spin === 'none' && RED.sb === 'auto', JSON.stringify(RED));
ok('ⓒ ⭐ 決定性對照:沒打開 → 照樣在閃、在轉、捲動照樣滑', !NORM.mm && NORM.pulse === 'pulse' && NORM.spin === 'spin' && NORM.sb === 'smooth', JSON.stringify(NORM));
ok('⓪ 沒有 pageerror', !RED.errs.length && !NORM.errs.length, [...RED.errs, ...NORM.errs].slice(0, 2).join(' | '));
await browser.close();
console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
