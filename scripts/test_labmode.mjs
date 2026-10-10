// 🔬 實驗室模式守門(V79.0.8 從 test_expframe.mjs 改名:產業作戰室「🔬 個股實測」分頁已刪除,使用者明示)
//   ① ⛔ pro.html 的個股實測 / 今日訊號 / 財報三個分頁⛔ 不可復活
//   ② 直接開 index.html?lab=1&sym=2330&sub=backtest → 實驗室模式、真的切到回測分頁、有內容(這條路照舊能用)
//   ③ ⛔ 一般模式帶同樣的 ?sub=backtest → 不可切過去(散戶 App 沒有入口)
//   ④ ⛔ index.html 一般模式不可有任何連到 pro.html / lab 的入口(V74.0.1 鐵則照舊)
//   ⑥ ⛔ 一般模式帶 ?noise=1 不開雜訊清單(V78.3.8)
import fs from 'fs';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const PRO = fs.readFileSync(new URL('../pro.html', import.meta.url), 'utf8');
const IDX = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const PROC = PRO.replace(/<!--[\s\S]*?-->/g, '');

for (const [k, C, nm] of [['exp', 'Exp', '個股實測'], ['sig', 'Sig', '今日訊號'], ['fin', 'Fin', '財報']]) {
    ok(`① ⛔ pro.html「${nm}」分頁已刪(按鈕 / 容器 / TABS 都不可回來)`,
       !new RegExp(`id="tabBtn${C}"`).test(PROC) && !new RegExp(`<div id="tab${C}"`).test(PROC) && !new RegExp(`\\['${k}',\\s*'${C}'\\]`).test(PROC));
}
ok('① 連帶的函式也刪了(expOpen / renderSig / finLoad)', !/expOpen\(what\)/.test(PRO) && !/async renderSig\(\)/.test(PRO) && !/async finLoad\(\)/.test(PRO));
ok('④ index.html 一般畫面⛔ 沒有連到 pro.html 的入口', !/href=["'][^"']*pro\.html/.test(IDX) && !/location\.href\s*=\s*['"`][^'"`]*pro\.html/.test(IDX));
ok('④ ?sub= / ?open= 只在實驗室模式才認', /if \(this\._labMode\(\)\) \{\s*const sub = qp\.get\('sub'\)/.test(IDX) && /this\._labMode\(\) && op\)/.test(IDX));

const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + new URL('../index.html', import.meta.url).pathname + '?lab=1&sym=2330&sub=backtest');
    let r = null;
    for (let i = 0; i < 40; i++) {
        await p.waitForTimeout(1000);
        try { r = await p.evaluate(() => (typeof app !== 'undefined' && app.currentSymbolId === '2330' && app._activeSubTab === 'backtest') ? { lab: document.documentElement.classList.contains('lab'), disp: getComputedStyle(document.getElementById('subContentBacktest')).display, len: document.getElementById('subContentBacktest').innerText.length } : null); } catch (_) {}
        if (r) break;
    }
    ok('② 直接開 ?lab=1 = 實驗室模式', r && r.lab, JSON.stringify(r));
    ok('② 真的切到 2330 的回測分頁而且有內容', r && r.disp === 'flex' && r.len > 200, JSON.stringify(r));

    const q = await browser.newPage({ viewport: { width: 390, height: 844 } });
    q.on('pageerror', e => errs.push(String(e)));
    await q.goto('file://' + new URL('../index.html', import.meta.url).pathname + '?sym=2330&sub=backtest');
    let s = null;
    for (let i = 0; i < 40; i++) { await q.waitForTimeout(1000); s = await q.evaluate(() => (typeof app !== 'undefined' && app.currentSymbolId === '2330') ? { lab: document.documentElement.classList.contains('lab'), sub: app._activeSubTab } : null); if (s && s.sub) break; }
    ok('③ 一般模式帶 ?sub=backtest ⛔ 不切過去', s && !s.lab && s.sub !== 'backtest', JSON.stringify(s));
    // 🔬 V78.3.8 ?noise=1(雜訊清單 = 研究內容)一般模式⛔ 不開
    const w = await browser.newPage({ viewport: { width: 390, height: 844 } });
    w.on('pageerror', e => errs.push(String(e)));
    await w.goto('file://' + new URL('../index.html', import.meta.url).pathname + '?noise=1');
    await w.waitForTimeout(6000);
    const nz = await w.evaluate(() => { const m = document.getElementById('updateLogModal'); const t = document.getElementById('updateLogTitle'); return { open: !!m && !m.classList.contains('hidden') && m.style.display !== 'none', title: t ? t.textContent : '' }; });
    ok('⑥ 一般模式帶 ?noise=1 ⛔ 不開雜訊清單', !(nz.open && /雜訊清單/.test(nz.title)), JSON.stringify(nz));
} finally { await browser.close(); }
ok('pageerror 0', errs.length === 0, errs.slice(0, 3).join(' | '));
if (fails.length) { console.log(`❌ LABMODE_FAIL(${fails.length}):${fails.join(' / ')}`); process.exit(1); }
console.log('✅ LABMODE_TEST_PASS');
