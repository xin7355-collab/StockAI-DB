// 🔬 V78.3.7 產業作戰室「🔬 個股實測」分頁守門
//   ① pro.html 有分頁鈕 + TABS 有 exp(⛔ 少了 TABS 那格,切頁時 div 永遠藏著)
//   ② 內嵌 index.html?lab=1&sym=2330&sub=backtest → 實驗室模式、真的切到回測分頁、有內容
//   ③ ⛔ 一般模式帶同樣的 ?sub=backtest → 不可切過去(散戶 App 沒有入口)
//   ④ ⛔ index.html 一般模式不可有任何連到 pro.html / lab 的入口(V74.0.1 鐵則照舊)
//   ⑤ ⛔ 不複製偵測器:pro.html 只能用 iframe 內嵌,⛔ 不可出現 _patternFitBacktest / _SIGNAL_EDGE 的實作
import fs from 'fs';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const PRO = fs.readFileSync(new URL('../pro.html', import.meta.url), 'utf8');
const IDX = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

ok('① pro.html 有「🔬 個股實測」分頁鈕', /id="tabBtnExp"[^>]*>🔬 個股實測</.test(PRO));
ok('① TABS 有 exp', /\['exp',\s*'Exp'\]/.test(PRO) && /<div id="tabExp"/.test(PRO));
ok('⑤ pro.html 用 iframe 內嵌 index.html?lab=1(⛔ 不複製偵測器)', /index\.html\?\$\{q\}/.test(PRO) && /lab=1&sym=/.test(PRO) && !/_patternFitBacktest\s*\(/.test(PRO));
ok('④ index.html 一般畫面⛔ 沒有連到 pro.html 的入口', !/href=["'][^"']*pro\.html/.test(IDX) && !/location\.href\s*=\s*['"`][^'"`]*pro\.html/.test(IDX));
ok('④ ?sub= / ?open= 只在實驗室模式才認', /if \(this\._labMode\(\)\) \{\s*const sub = qp\.get\('sub'\)/.test(IDX) && /this\._labMode\(\) && op\)/.test(IDX));

const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + new URL('../pro.html', import.meta.url).pathname);
    await p.waitForTimeout(2000);
    await p.evaluate(() => PRO.switchTab('exp'));
    const vis = await p.evaluate(() => !document.getElementById('tabExp').classList.contains('hidden'));
    ok('① 切到 exp 分頁看得到', vis);
    await p.evaluate(() => { document.getElementById('expSym').value = '2330'; PRO.expOpen('backtest'); });
    let r = null;
    for (let i = 0; i < 40; i++) {
        await p.waitForTimeout(1000);
        const fr = p.frames().find(f => /index\.html/.test(f.url()));
        if (!fr) continue;
        try { r = await fr.evaluate(() => (typeof app !== 'undefined' && app.currentSymbolId === '2330' && app._activeSubTab === 'backtest') ? { lab: document.documentElement.classList.contains('lab'), disp: getComputedStyle(document.getElementById('subContentBacktest')).display, len: document.getElementById('subContentBacktest').innerText.length } : null); } catch (_) {}
        if (r) break;
    }
    ok('② 內嵌 = 實驗室模式', r && r.lab, JSON.stringify(r));
    ok('② 真的切到 2330 的回測分頁而且有內容', r && r.disp === 'flex' && r.len > 200, JSON.stringify(r));
    await p.evaluate(() => { document.getElementById('expSym').value = '12'; PRO.expOpen('backtest'); });
    ok('① 代號格式錯 → 說出來', await p.evaluate(() => /代號格式不對/.test(document.getElementById('expNote').textContent)));

    const q = await browser.newPage({ viewport: { width: 390, height: 844 } });
    q.on('pageerror', e => errs.push(String(e)));
    await q.goto('file://' + new URL('../index.html', import.meta.url).pathname + '?sym=2330&sub=backtest');
    let s = null;
    for (let i = 0; i < 40; i++) { await q.waitForTimeout(1000); s = await q.evaluate(() => (typeof app !== 'undefined' && app.currentSymbolId === '2330') ? { lab: document.documentElement.classList.contains('lab'), sub: app._activeSubTab } : null); if (s && s.sub) break; }
    ok('③ 一般模式帶 ?sub=backtest ⛔ 不切過去', s && !s.lab && s.sub !== 'backtest', JSON.stringify(s));
} finally { await browser.close(); }
ok('pageerror 0', errs.length === 0, errs.slice(0, 3).join(' | '));
if (fails.length) { console.log(`❌ EXPFRAME_FAIL(${fails.length}):${fails.join(' / ')}`); process.exit(1); }
console.log('✅ EXPFRAME_TEST_PASS');
