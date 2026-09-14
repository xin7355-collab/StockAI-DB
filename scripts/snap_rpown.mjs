#!/usr/bin/env node
/**
 * 🖼️ 把「📈 個股數據速覽」那張 canvas 存成 PNG,肉眼逐段看。
 * ⛔ 這不是測試(exit 0)—— CLAUDE.md 鐵則:畫面類改動一律先 snapshot 肉眼看,測試只守得住已知的錯。
 * 用法:node scripts/snap_rpown.mjs [out.png] [代號]
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '/tmp/rpown.png';
const SYM = process.argv[3] || '2330';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._rpDrawOwn === 'function', null, { timeout: 25000 });

const r = await page.evaluate(async (sym) => {
    const A = window.app || app;
    A.switchAppTab('diag'); await A.analyze(sym);
    await new Promise(r => setTimeout(r, 4000));
    A.switchSubTab('report');
    for (let i = 0; i < 16; i++) { await new Promise(r => setTimeout(r, 600)); if (document.getElementById('rpOwnCv')) break; }
    const cv = document.getElementById('rpOwnCv');
    if (!cv) return { no: 1 };
    // 🚧 V77.0.3 空過守門:沙箱抓不到 `data/{sym}.json` 時 `analyze()` 會**靜默留在上一檔**
    //   → 拍出來的是別檔的圖,而輸出看起來完全正常(實測要 6706 卻拍到 2330)。
    //   ⛔ 「檢查者不可以跟被檢查者同生共死」:一定要問「現在畫的到底是哪一檔」。
    if (String(A._rpLast && A._rpLast.sym) !== String(sym)) return { wrong: String(A._rpLast && A._rpLast.sym) };
    // ⚠️ 2330 上方常常沒有套牢區 → 合成一道,才看得到 ② 那一段最擠的樣子
    const pC = +A._rpLast.pC;
    A._upsideStash = { pC, list: [{ lo: pC * 1.05, hi: pC * 1.15, sup: 21 }, { lo: pC * 1.42, hi: pC * 1.59, sup: 9 }, { lo: pC * 1.75, hi: pC * 1.80, sup: 2 }] };
    A._rpDrawOwn(sym);
    return { url: cv.toDataURL('image/png'), w: cv.width, h: cv.height, W: A._RP_STYLE.W, pad: (A._rpOwnDbg || {}).pad,
             cards: (A._rpOwnDbg || {}).cards.map(c => ({ t: c.title, x0: c.x0, x1: c.x1, yT: Math.round(c.yTitle) })) };
}, SYM);

await browser.close();
if (r.no) { console.log('❌ 找不到 canvas'); process.exit(0); }
if (r.wrong) { console.log(`❌ 要拍 ${SYM} 卻載到 ${r.wrong} —— 本機 data/${SYM}.json 抓不到(先 git show origin/gh-pages:data/${SYM}.json > data/${SYM}.json)。⛔ 不拍假圖`); process.exit(0); }
fs.writeFileSync(OUT, Buffer.from(r.url.split(',')[1], 'base64'));
console.log(`✅ ${OUT}  ${r.w}×${r.h}px(畫布 ${r.W}、PAD ${r.pad}、內容 ${r.W - 2 * r.pad}px = ${((r.W - 2 * r.pad) / r.W * 100).toFixed(1)}%)`);
for (const c of r.cards) console.log(`   ${c.t}  x ${c.x0}→${c.x1}  標題 y=${c.yT}`);
