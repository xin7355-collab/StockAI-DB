#!/usr/bin/env node
/**
 * 🕳️ 「被 catch 吞掉的程式錯誤」獵捕器(V72.2.9)
 *
 * ⚠️ 為什麼要有這支 —— 它一上線就抓到兩個**躲很久、零錯誤訊息**的真 bug:
 *   1. `loadBrokerChips`:`raw is not defined` → **券商分點對所有股票都是壞的**,
 *      畫面卻顯「⚠️ 今日分點尚未公布」(看起來完全像正常狀態)。
 *   2. `onWorkerMessage`:`fugleData is not defined` → 頂部報價的
 *      **「總量/量縮」從來沒顯示過**,被 `catch(_) {}` 吞得一乾二淨。
 *
 * ⭐ 這類 bug 為什麼所有既有檢查都抓不到:
 *   ・`node --check` / smoke_test → 語法合法、也沒有 pageerror(例外被 catch 接走了)
 *   ・page_sweep → 只看得到「畫面上有東西」,而 catch 分支**通常也會畫東西**
 *   ・靜態 grep → 實測誤報 1,281 筆,完全不可用
 *
 * 做法:把 index.html 複製一份、用 regex 把**每一個** `catch (x) {` 包上回報鉤子,
 *       載入後把 App 整個走一遍,收集「ReferenceError / TypeError / SyntaxError / RangeError」。
 *       ⛔ 只收這四種(=「程式壞了」);網路失敗 / abort / 資料沒有 一律不收。
 *
 * ⛔ 巡邏工具不是測試:exit 0,不進四驗證。但**每一筆都要當真** ——
 *    實測誤報只有一種(file:// 不能註冊 ServiceWorker,沙箱限制)。
 *
 * 跑法:node scripts/swallow_hunt.mjs [股號…]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYMS = process.argv.slice(2).length ? process.argv.slice(2) : ['2330', '2327', '0050', '^TWII'];
const INSTR = path.join(ROOT, '_swallow_instr.html');

// ── 1. 產生「每個 catch 都會回報」的複本 ────────────────────────
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let nCatch = 0;
const instrumented = src.replace(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g, (_m, v) => {
    nCatch++;
    return `catch (${v}) { try{window.__swallow&&window.__swallow(${v},${nCatch});}catch(_x){} `;
});
fs.writeFileSync(INSTR, instrumented, 'utf8');
console.log(`🕳️ 已包住 ${nCatch} 個 catch 區塊`);

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    window.__swallowed = [];
    window.__swallow = (e, id) => {
        if (!e) return;
        const nm = (e && e.name) || '';
        const msg = String((e && e.message) || e);
        // ⛔ 只收「程式壞了」那四種;網路/中止/沒資料 不是 bug
        if (!/ReferenceError|TypeError|SyntaxError|RangeError/.test(nm)) return;
        if (/Failed to fetch|NetworkError|aborted|operation was aborted|Load failed/i.test(msg)) return;
        const at = String((e && e.stack) || '').split('\n')[1] || '';
        window.__swallowed.push({ id, nm, msg: msg.slice(0, 170), at: at.trim().slice(0, 130) });
    };
    // ECharts 走 CDN(沙箱連不到)→ stub
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
    // 種假庫存/自選,庫存與自選頁才走得到真正的渲染路徑
    try {
        localStorage.setItem('proTerminalInv', JSON.stringify([{ symbol: '2330', cost: 1100, shares: 2 }, { symbol: '2327', cost: 700, shares: 1 }]));
        localStorage.setItem('proTerminalFavGroups', JSON.stringify({ 自選清單: ['2317', '3231'] }));
    } catch (_) { }
});
await page.goto(pathToFileURL(INSTR).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 30000 });

// ⭐ 自我驗證:先確認鉤子真的收得到(「沒報錯」≠「檢查過了」)
const selftest = await page.evaluate(() => {
    const before = window.__swallowed.length;
    try { undefinedFunctionForSelfTest(); } catch (e) { window.__swallow(e, 0); }
    const got = window.__swallowed.length > before;
    window.__swallowed.length = before;      // 清掉,不要污染結果
    return got;
});
if (!selftest) { console.log('❌ 自我驗證失敗:鉤子收不到例外 → 這次獵捕無效'); await browser.close(); process.exit(1); }
console.log('✅ 自我驗證通過(注入一個 ReferenceError,鉤子有收到)');

// 等 init 落地(它會把頁面切回庫存)
for (let i = 0; i < 25; i++) {
    const ok = await page.evaluate(async () => {
        try { app.switchAppTab('diag'); } catch (_) { }
        await new Promise(r => setTimeout(r, 1200));
        const el = document.getElementById('tabContentDiag');
        return !!el && getComputedStyle(el).display !== 'none';
    });
    if (ok) break;
}

const SUB = ['strategy', 'live', 'daytrade', 'chart', 'chip', 'corp', 'backtest', 'bullbear'];
for (const sym of SYMS) {
    if (!fs.existsSync(path.join(ROOT, 'data', `${sym}.json`))) { console.log(`⏭️ ${sym} 沒有本機資料`); continue; }
    process.stdout.write(`\n🔎 ${sym} `);
    await page.evaluate(async s => { try { app.switchAppTab('diag'); } catch (_) { } await app.analyze(s, true, false, true); }, sym);
    await page.waitForTimeout(2500);
    for (const t of SUB) {
        await page.evaluate(async a => {
            try { app.switchSubTab(a); } catch (_) { }
            if (a === 'strategy') for (const q of ['now', 'entry', 'exit']) { try { app.switchOvTab(q); } catch (_) { } await new Promise(r => setTimeout(r, 280)); }
            if (a === 'chip') for (const q of ['broker', 'flow', 'dist']) { try { app.switchChipTab(q); } catch (_) { } await new Promise(r => setTimeout(r, 280)); }
            await new Promise(r => setTimeout(r, 700));
        }, t);
        process.stdout.write('.');
    }
    // 按鈕型功能(平常不會自動跑,但使用者會點)
    await page.evaluate(async () => {
        for (const fn of ['analyzeStockPlaybook', '_runSignalScorecard', 'renderBrokerWarRoom']) {
            try { app[fn] && app[fn](); } catch (_) { }
            await new Promise(r => setTimeout(r, 500));
        }
    });
    process.stdout.write('+');
}
process.stdout.write('\n🌐 主分頁 ');
for (const t of ['market', 'radar', 'hunt', 'broker', 'inv', 'fav']) {
    await page.evaluate(async x => { try { app.switchAppTab(x); } catch (_) { } await new Promise(r => setTimeout(r, 1800)); }, t);
    process.stdout.write('.');
}

const sw = await page.evaluate(() => window.__swallowed);
await browser.close();
try { fs.unlinkSync(INSTR); } catch (_) { }

// ── 報告 ────────────────────────────────────────────────────────
// ⚠️ 已知的沙箱誤報:file:// 不能註冊 ServiceWorker(真機上不會發生)
const SANDBOX_ONLY = /ServiceWorker.*file:|protocol of the current origin/i;
const real = sw.filter(s => !SANDBOX_ONLY.test(s.msg));
const uniq = new Map();
for (const s of real) {
    const k = `${s.nm}|${s.msg}|${s.at}`;
    if (!uniq.has(k)) uniq.set(k, { ...s, n: 0 });
    uniq.get(k).n++;
}
console.log('\n\n' + '═'.repeat(70));
console.log(`吞掉的例外:${sw.length} 筆(扣掉沙箱限制 ${sw.length - real.length} 筆)→ 去重後 ${uniq.size} 種`);
if (!uniq.size) {
    console.log('✅ 沒有被吞掉的程式錯誤');
} else {
    console.log('');
    for (const v of [...uniq.values()].sort((a, b) => b.n - a.n)) {
        console.log(`  ×${String(v.n).padStart(3)}  ${v.nm}: ${v.msg}`);
        console.log(`         ${v.at}`);
    }
    console.log('\n⚠️ 每一筆都要當真 —— 這類例外被 catch 吞掉後**完全沒有痕跡**,');
    console.log('   而 catch 分支通常還是會畫東西,所以畫面看起來一切正常。');
}
console.log('═'.repeat(70));
