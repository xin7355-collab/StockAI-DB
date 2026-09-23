#!/usr/bin/env node
/**
 * ⚡ V77.5.0 當沖實測摺疊 `_dtEdgeHtml` / `_DT_EDGE` 守門
 *
 * 釘住的用意:
 *   ① 數字**只讀 `_DT_EDGE`**(⛔ 顯示端寫死 = 重跑探針就對不上)→ 決定性對照:改常數,畫面要跟著變
 *   ② 🟥「收盤鎖漲停」那一行**只在條件成立時出現**:沒開盤 + 最後一根鎖在漲停;盤中 / 沒鎖 / 別檔 → ⛔ 不出現
 *   ③ 那一行一定要講「給已經有的人」+「⛔ 不是買進訊號」(鎖住的漲停買不到)
 *   ④ 「每一格期望值都是負的」那句要**跟著資料**(⛔ 寫死的話重跑出現正的一格就在說謊)
 *   ⑤ ⛔ 不可用 🔴🟢 當燈號;當沖頁 hero 真的有接上這支
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.DTE_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };

// ── 靜態 ──
const fn = (() => { const i = SRC.indexOf('    _dtEdgeHtml(sym) {'); const j = SRC.indexOf('\n    },\n', i); return i > 0 ? SRC.slice(i, j) : ''; })();
const code = fn.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // ⚠️ 先剝註解(被自己的註解救活已經七次)
ok('⓪ 空過守門:切得到 _dtEdgeHtml', code.length > 800, code.length);
ok('⓪b 當沖頁 hero 真的有接上(renderDayTradeTab 裡呼叫 _dtEdgeHtml(sym))', /\$\{this\._dtEdgeHtml\(sym\)\}/.test(SRC));
ok('① ⛔ 顯示端不寫死實測數字(2.19 / 69.7 / 0.85 / 13.6 / 74.4 都要從 _DT_EDGE 讀)',
   !/2\.19|69\.7|0\.85|13\.6|74\.4|\b2334\b|2,334/.test(code), (code.match(/2\.19|69\.7|0\.85|13\.6|74\.4|2334/g) || []).join(','));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._dtEdgeHtml, null, { timeout: 30000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // 合成 K 線:30 根緩漲,最後一根鎖漲停(收 = 高 = 前收 × 1.10)
    const mk = (lock) => { const d = []; let c = 100;
        for (let i = 0; i < 30; i++) { const o = c; c = c * 1.003; d.push({ date: `2026/08/${String(i + 1).padStart(2, '0')}`, open: o, high: c * 1.005, low: o * 0.995, close: c, volume: 1e6 }); }
        const pc = d[d.length - 1].close; const cl = +(pc * 1.1).toFixed(2);
        d.push({ date: '2026/09/15', open: pc * 1.02, high: lock ? cl : cl * 1.01, low: pc * 1.01, close: cl, volume: 3e6 }); return d; };
    const openBak = A.isMarketOpen;
    A.currentSymbolId = '9999';
    A.isMarketOpen = () => false;
    A.rawDailyData = mk(true);
    out.lock = A._dtEdgeHtml('9999');
    out.lockTxt = strip(out.lock);
    // 決定性對照:改常數 → 畫面一定要跟著變
    const E = A._DT_EDGE, bak = JSON.stringify(E);
    E.lu.up.open[0] = 9.87; E.lu.dn.open[0] = 9.87; E.f6[0][2] = 12.3;
    out.patched = strip(A._dtEdgeHtml('9999'));
    // 讓一格變正 → 「每一格都是負的」那句不可以再出現
    E.f6[5][3] = 0.5;
    out.onePos = strip(A._dtEdgeHtml('9999'));
    Object.assign(A._DT_EDGE, JSON.parse(bak));
    // 沒鎖 / 盤中 / 別檔 → ⛔ 不可出現那一行
    A.rawDailyData = mk(false); out.noLock = A._dtEdgeHtml('9999');
    A.rawDailyData = mk(true); A.isMarketOpen = () => true; out.intraday = A._dtEdgeHtml('9999');
    A.isMarketOpen = () => false; out.otherSym = A._dtEdgeHtml('1234');
    A.isMarketOpen = openBak;
    return out;
});
await browser.close();

ok('② 收盤鎖漲停 → 出現 🟥 那一行(data-dtlu)', /data-dtlu/.test(R.lock), R.lockTxt.slice(0, 160));
ok('②b 沒鎖漲停 → ⛔ 不出現', !/data-dtlu/.test(R.noLock));
ok('②c 盤中(還不知道會不會打開)→ ⛔ 不出現', !/data-dtlu/.test(R.intraday));
ok('②d 別檔的 K 線 → ⛔ 不出現(切股殘留,陷阱 #19)', !/data-dtlu/.test(R.otherSym));
ok('③ 一定要講「給已經有的人」+「⛔ 不是買進訊號」+ 買不到', /已經有/.test(R.lockTxt) && /不是買進訊號/.test(R.lockTxt) && /買不到/.test(R.lockTxt), R.lockTxt.slice(0, 240));
ok('①b 🔬 決定性對照:改 _DT_EDGE → 畫面跟著變成 +9.87% 與 12.3%', /\+9\.87%/.test(R.patched) && /12\.3%/.test(R.patched), R.patched.slice(0, 200));
ok('④ 「每一格期望值都是負的」跟著資料:有一格變正 → 那句不可以再出現', /每一格的期望值都是負的/.test(R.lockTxt) && !/每一格的期望值都是負的/.test(R.onePos) && /只在 1 格是正的/.test(R.onePos));
ok('⑤ 摺疊本身一定在(data-dtedge),而且不用 🔴🟢 當燈號', /data-dtedge/.test(R.noLock) && !/[🔴🟢]/u.test(R.lock + R.noLock));
ok('⑤b 要講清楚限制:分K 天數 + 量前 80 的偏誤', /個交易日/.test(R.lockTxt) && /前 80/.test(R.lockTxt));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ DTEDGE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
