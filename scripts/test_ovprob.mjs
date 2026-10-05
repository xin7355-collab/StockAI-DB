#!/usr/bin/env node
/**
 * 📊 總覽「明天收盤」那一行守門(V78.5.3:機率圖拿掉,縮成開盤卡裡的一行 —— 使用者:「不是我要呈現的樣子」)
 *   ⓐ 總覽沒有 #ovProbBox、`_renderOvCommand` ⛔ 不再呼叫 `_renderOvProb`;開盤卡讀 `_probBox(mode:'tom')`
 *   ⓑ ⭐ 決定性對照:把這一格的「明天」改成 77.7/11.1/11.2 → 那一行數字跟著變(⛔ 不是寫死、⛔ 不另算)
 *   ⓒ 一般股票那組讀 `T.base`(⛔ 基準不可省)
 *   ⓓ 「完整表 ›」= 報告頁;⛔ 研究字樣;⛔ 🔴🟢
 *   ⓔ 樣本不足 → 一行說不給(⛔ 不補值)
 * 注入:INJECT=nobase(拿掉一般股票)/ hard(數字寫死)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nobase') SRC = SRC.replace('<span class="text-gray-600">(一般股票 ${fmt1(b1[1])}/${fmt1(b1[2])}/${fmt1(b1[3])})</span>', '');
if (INJ === 'hard') SRC = SRC.replace('明天收盤${a2} <b class="text-red-300">漲 ${fmt1(r1[1])}</b>', '明天收盤${a2} <b class="text-red-300">漲 40.0</b>');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_ovprob.html');
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
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._probBox === 'function' && app._PROB_TABLE, null, { timeout: 60000 });

const R = await page.evaluate(() => {
    const o = {};
    const mk = n => { const a = []; let p = 100; for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 7) * 0.01 + 0.0006; const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10); a.push({ date: d, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 }); } return a; };
    const data = mk(400);
    app._scrData = null;
    const T = app._PROB_TABLE, f = app._probFeatures(data);
    const i1 = T.hz.indexOf(1);
    o.b1 = T.base[i1].slice(1, 4);
    o.noBox = !document.getElementById('ovProbBox');
    o.notCalled = !/_renderOvProb\(/.test(app._renderOvCommand.toString());
    o.wired = /mode: 'tom'/.test(app._renderOvOpen.toString());
    const div = h => { const d = document.createElement('div'); d.innerHTML = h; return d; };
    const a = div(app._probBox('9999', { mode: 'tom', data }));
    o.a = a.innerText; o.aLink = (a.querySelector('[data-probtom]') || {}).getAttribute?.('onclick') || '';
    const keep = T.cells[f.cell];
    const row = keep.map(r => r ? r.slice() : r); row[i1] = row[i1].slice(); row[i1][1] = 77.7; row[i1][2] = 11.1; row[i1][3] = 11.2;
    T.cells[f.cell] = row;
    o.b = div(app._probBox('9999', { mode: 'tom', data })).innerText;
    // ⓔ 樣本不足
    const r20 = T.hz.indexOf(20); const thin = row.map(r => r ? r.slice() : r); thin[r20] = thin[r20].slice(); thin[r20][0] = 5; T.cells[f.cell] = thin;
    o.e = div(app._probBox('9999', { mode: 'tom', data })).innerText;
    T.cells[f.cell] = keep;
    return o;
});
const f1 = v => v.toFixed(1);
ok('ⓐ 總覽沒有 #ovProbBox、⛔ 不再呼叫 _renderOvProb、開盤卡讀 mode:tom', R.noBox && R.notCalled && R.wired, [R.noBox, R.notCalled, R.wired]);
ok('ⓐ2 有「明天收盤」一行', /📊 明天收盤/.test(R.a) && /漲 \d+\.\d・平 \d+\.\d・跌 \d+\.\d%/.test(R.a), R.a);
ok('ⓑ ⭐ 決定性對照:改成 77.7/11.1/11.2 → 那一行跟著變', /漲 77\.7・平 11\.1・跌 11\.2%/.test(R.b), R.b);
ok('ⓒ 一般股票那組讀 T.base', R.a.includes(`一般股票 ${f1(R.b1[0])}/${f1(R.b1[1])}/${f1(R.b1[2])}`), R.a + ' | ' + R.b1);
ok('ⓓ 「完整表 ›」= 報告頁', /完整表/.test(R.a) && /switchSubTab\('report'\)/.test(R.aLink), R.aLink);
ok('ⓓ2 ⛔ 研究字樣 / ⛔ 🔴🟢', !badOf(R.a).length && !/🔴|🟢/.test(R.a), badOf(R.a));
ok('ⓔ 樣本不足 → 一行說不給', /樣本不足/.test(R.e) && !/漲 \d/.test(R.e), R.e);
ok('ⓩ 無 pageerror', !errs.length, errs.slice(0, 2));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_ovprob 全過');
process.exit(fails.length ? 1 : 0);
