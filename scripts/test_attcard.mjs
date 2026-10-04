#!/usr/bin/env node
/**
 * 🚨 V78.4.3 處置 / 注意股卡(使用者截圖嘉晶:「處置股有沒有要改」)守門
 *   ⓐ ⛔ 不可再有:「已關禁閉」那列、怕關 / 不怕關、洗盤後噴出、易崩、新手、OpenAPI、慣犯 / 投機性高
 *   ⓑ 💡 怎麼做:要有「照你原本的出場規則走」+「別用市價單」(跟決策台 `_dispoHoldNoteHtml` 同一套說法)
 *   ⓒ 手上有那一檔 → 開頭換成「👜 你手上有」
 *   ⓓ ⭐ 決定性對照:注意股前 5 天漲 29% ⛔ 不出「分批減碼」、31% 出
 *   ⓔ 有真正原因 → 顯示「原因」;「已關禁閉」→ 不顯示
 *   ⓕ 緊急列⛔「新手別碰」,改成不閃的 note;說明字典⛔「新手勿碰 / 高手才玩」
 *   ⓖ ⛔ 研究字樣(lib_retailbad)
 * 注入:INJECT=oldfear(怕關那句加回去)/ nohot(拿掉 30% 那行)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'oldfear') SRC = SRC.replace(`if (isDisp) how.push(\`處置期間有些要先把錢存進去`, `how.push('💡 <b>怕關 vs 不怕關</b>:熱門題材股被關常洗盤後噴出'); if (isDisp) how.push(\`處置期間有些要先把錢存進去`);
if (INJ === 'nohot') SRC = SRC.replace('if (hot) how.push(', 'if (false) how.push(');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_attcard.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._renderAttentionDetailHtml === 'function', null, { timeout: 60000 });
const R = await page.evaluate(() => {
    const o = {};
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent; };
    const mk = (n, last5) => { const a = []; let p = 100; for (let i = 0; i < n; i++) { const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10); a.push({ date: d, open: p, high: p, low: p, close: p, volume: 1000 }); } a[n - 1].close = 100 * (1 + last5 / 100); return a; };
    app._getInventory = () => [];
    app.attentionStatus = {
        '3016': { status: '🚨 處置 5 分盤', threshold: '已關禁閉', interval: 5, end_date: '2026-10-15' },
        '2330': { status: '⚠️ 注意股', threshold: '第一款 六個營業日累積漲幅過大' },
    };
    app.activeData = mk(30, 0);
    o.disp = app._renderAttentionDetailHtml('3016'); o.dispT = txt(o.disp);
    app._getInventory = () => [{ symbol: '3016', shares: 1, cost: 50 }];
    o.dispHeld = txt(app._renderAttentionDetailHtml('3016'));
    app._getInventory = () => [];
    app.activeData = mk(30, 29); o.n29 = txt(app._renderAttentionDetailHtml('2330'));
    app.activeData = mk(30, 31); o.n31 = txt(app._renderAttentionDetailHtml('2330'));
    o.src = app._renderAttentionDetailHtml.toString();
    return o;
});
const ALL = R.dispT + '\n' + R.n31 + '\n' + R.src;
ok('ⓐ ⛔ 舊說法(禁閉 / 怕關 / 洗盤後噴出 / 易崩 / 新手 / OpenAPI / 慣犯 / 投機性高)', !/禁閉|怕關|怕被關|洗盤後噴出|易崩|新手|OpenAPI|慣犯|投機性高/.test(R.dispT + R.n31), (R.dispT + R.n31).match(/禁閉|怕關|怕被關|洗盤後噴出|易崩|新手|OpenAPI|慣犯|投機性高/g));
ok('ⓑ 💡 怎麼做:照出場規則走 + 別用市價單', /照你原本的出場規則走/.test(R.dispT) && /別用市價單/.test(R.dispT) && /怎麼做/.test(R.dispT), R.dispT);
ok('ⓑ2 處置寫分盤與出關日', /每 5 分鐘 1 次/.test(R.dispT) && /2026-10-15/.test(R.dispT));
ok('ⓒ 手上有 → 「你手上有」', /你手上有/.test(R.dispHeld) && !/你手上有/.test(R.dispT), R.dispHeld);
ok('ⓓ ⭐ 決定性對照:前 5 天 29% ⛔ 不出、31% 出「分批減碼」', !/分批減碼/.test(R.n29) && /前 5 天已經漲了 31%/.test(R.n31) && /分批減碼/.test(R.n31), [R.n29.slice(-120), R.n31.slice(-160)]);
ok('ⓔ 真正原因顯示「原因」;已關禁閉不顯示', /原因/.test(R.n31) && /第一款/.test(R.n31) && !/原因/.test(R.dispT));
const IDX = fs.readFileSync(TMP, 'utf8');
ok('ⓕ 緊急列⛔「新手別碰」、說明字典⛔「新手勿碰 / 高手才玩」', !/新手別碰|新手勿碰|高手才玩/.test(IDX));
ok('ⓕ2 處置那句改走不閃的 emgNote', /emgNote\.push\('📋 官方處置\/注意股/.test(IDX));
ok('ⓖ ⛔ 研究字樣', !badOf(R.dispT + R.n31 + R.dispHeld).length, badOf(R.dispT + R.n31));
ok('ⓩ 無 pageerror', !errs.length, errs.slice(0, 2));
void ALL;
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_attcard 全過');
process.exit(fails.length ? 1 : 0);
