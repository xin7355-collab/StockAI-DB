#!/usr/bin/env node
/**
 * 📐 V77.3.8 下降三角避雷守門(`_TRI_EDGE` / `_descTriangle` / `_ovNewEdges` ⑤)
 *   ① 合成下降三角(高點每根降、低點平)→ `_descTriangle().ok` 為 true、`_ovNewEdges` 有 📐 那一條
 *   ② 合成上漲 / 對稱收斂 → 沒有
 *   ③ 數字一律讀 `_TRI_EDGE`(換一份假表畫面要跟著變,⛔ 不可寫死)
 *   ④ 一律先過 `_closedTail`:把今天那根(未收盤)改成離譜值,結果不變
 *   ⑤ 文案:⛔ 無 🔴🟢、要有「不是放空」、要講「別加碼」
 *   ⑥ 靜態:ATR 基準區間 ⛔ 不含今日(`k < t`);定義常數(k / flat / N)從 `_TRI_EDGE` 讀
 *   ⑦ 探針與 App 的門檻要一致(laoyu_probe.mjs 的 −0.05·ATR / 0.5·ATR / 20 根)
 * 注入:ATR 迴圈改 `k <= t` → ⑥;`ok:` 寫死 true → ②;文案數字寫死 → ③;拿掉 _closedTail → ④
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

const fn = CODE.slice(CODE.indexOf('_descTriangle(data) {'), CODE.indexOf('_ldRedKHtml(data, sym) {'));
ok('⓪ 切得到 _descTriangle', fn.length > 500 && fn.length < 4000, String(fn.length));
ok('⑥ ATR 基準區間 ⛔ 不含今日(k < t),而且先過 _closedTail', /for \(let k = t - 20; k < t; k\+\+\)/.test(fn) && /this\._closedTail\(data\)/.test(fn), '');
ok('⑥b 門檻從 _TRI_EDGE 讀(E.k / E.flat / E.N),⛔ 不寫死', /E\.k \* atr/.test(fn) && /E\.flat \* atr/.test(fn) && /N = E\.N/.test(fn) && !/-0\.05 \* atr|0\.5 \* atr/.test(fn), '');
const probe = fs.readFileSync(path.join(ROOT, 'scripts/laoyu_probe.mjs'), 'utf8');
const mTri = /_TRI_EDGE: \{[^}]*k: ([0-9.]+), flat: ([0-9.]+), N: (\d+)/.exec(SRC);
ok('⑦ App 門檻 = 探針門檻(−0.05·ATR / 0.5·ATR / 20 根)', mTri && +mTri[1] === 0.05 && +mTri[2] === 0.5 && +mTri[3] === 20 && /slope <= -0\.05 \* atr && ls\[2\] - ls\[0\] <= 0\.5 \* atr/.test(probe), mTri ? mTri.slice(1).join('/') : 'no _TRI_EDGE');

const exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(Object.assign({ args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] }, fs.existsSync(exec) ? { executablePath: exec } : {}));
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', () => {});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._descTriangle, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    const mk = (n, f) => { const d = []; const day = new Date(Date.UTC(2024, 0, 2)); for (let i = 0; i < n; i++) { const b = f(i); while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1); d.push({ date: day.toISOString().slice(0, 10).replace(/-/g, '/'), ...b, volume: 5e6 }); day.setUTCDate(day.getUTCDate() + 1); } return d; };
    // 三角:前 40 根隨機小幅(高 101~102、低 98~99),最後 20 根高點 106 → 98.4 每根 −0.4、低點 97.5 平
    const tri = mk(60, i => i < 40 ? { open: 100, close: 100 + (i % 3) * 0.2, high: 101 + (i % 4) * 0.25, low: 98 + (i % 5) * 0.2 } : { open: 100, close: 100, high: 106 - (i - 40) * 0.4, low: 97.5 });
    const flatUp = mk(60, i => ({ open: 100 + i * 0.3, close: 100.2 + i * 0.3, high: 101 + i * 0.3, low: 99.5 + i * 0.3 }));
    const symm = mk(60, i => i < 40 ? { open: 100, close: 100, high: 102, low: 98 } : { open: 100, close: 100, high: 104 - (i - 40) * 0.15, low: 96 + (i - 40) * 0.15 });
    const t1 = A._descTriangle(tri), t2 = A._descTriangle(flatUp), t3 = A._descTriangle(symm);
    out.tri = t1 && t1.ok; out.up = t2 ? t2.ok : null; out.symm = t3 ? t3.ok : null;
    const lines = A._ovNewEdges(tri, 'TEST').map(x => x.ic + '|' + x.txt);
    out.hasLine = lines.some(l => l.startsWith('📐|'));
    out.noLineUp = !A._ovNewEdges(flatUp, 'TEST').some(x => x.ic === '📐');
    const txt = (lines.find(l => l.startsWith('📐|')) || '');
    out.txt = txt;
    // ③ 換假表
    const real = JSON.parse(JSON.stringify(A._TRI_EDGE));
    A._TRI_EDGE = Object.assign({}, real, { n: 12345, e10: -8.88, wr: 66.6, base: 11.1, yr: '−9/−9' });
    const txt2 = (A._ovNewEdges(tri, 'TEST').find(x => x.ic === '📐') || {}).txt || '';
    A._TRI_EDGE = real;
    out.fake = /12,345/.test(txt2) && /8\.88/.test(txt2) && /66\.6/.test(txt2) && /11\.1/.test(txt2) && /−9\/−9/.test(txt2);
    // ④ 今天那根未收盤:加一根日期 = 今天、離譜值 → 結果要跟沒加一樣
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '/');
    const withToday = tri.concat([{ date: today, open: 100, close: 300, high: 400, low: 10, volume: 1 }]);
    const t4 = A._descTriangle(withToday);
    out.todayIgnored = !!(t4 && t4.ok) && Math.abs(t4.slope - t1.slope) < 1e-9;
    const withTodayNoClose = tri.concat([{ date: today, open: 100, close: 100, high: 100.5, low: 99.5, volume: 1 }]);
    out.lastIsToday = A._lastBarIsToday(withTodayNoClose) === true;
    return out;
});
ok('① 合成下降三角 → ok、總覽有 📐 那一條', R.tri === true && R.hasLine, JSON.stringify({ tri: R.tri, hasLine: R.hasLine }));
ok('② 上漲 / 對稱收斂 ⛔ 不觸發', R.up === false && R.symm === false && R.noLineUp, JSON.stringify({ up: R.up, symm: R.symm }));
ok('③ 數字一律讀 _TRI_EDGE(換假表畫面跟著變)', R.fake === true, '');
ok('④ 今天那根未收盤的 ⛔ 不算(結果與沒加一樣)', R.todayIgnored && R.lastIsToday, JSON.stringify({ t: R.todayIgnored, l: R.lastIsToday }));
ok('⑤ 文案:無 🔴🟢、有「不是放空」、有「別加碼」、有「含 2022」', !/🔴|🟢/.test(R.txt) && /不是放空/.test(R.txt) && /別加碼/.test(R.txt) && /2022/.test(R.txt), R.txt.slice(0, 200));
await browser.close();
console.log('\n' + (fails.length ? `❌ ${fails.length} 條失敗` : '✅ TRIEDGE_PASS'));
process.exit(fails.length ? 1 : 0);
