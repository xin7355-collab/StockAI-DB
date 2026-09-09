#!/usr/bin/env node
/**
 * 😱 V75.2.3 VIX 的唯一真相來源 `app._vixState()`
 *
 * 🚨 為什麼有這支(資料體檢 E 類抓到的):**兩份採礦產物都有 VIX** ——
 *    `macro_risk.json`(每 4 小時那輪)與 `macro_cache.json`(daily_miner 那輪)。
 *    實測同一天 **16.41 vs 16.31**(更早一次 15.99 vs 15.72)。
 *    ⛔ 不是誰算錯,是**抓的時間不同**(VIX 是美股盤中即時報價)——
 *    但畫面上同時出現兩個「VIX」就是打架(使用者講最多次的那句)。
 * 🚨 更糟的是 `_calcRiskScore` 吃的是**舊的那份** →
 *    **顯示的 VIX 跟風險指數算進去的 VIX 不是同一個數字**。
 *
 * ⛔ 釘死的五件事:
 *   ① 優先序:`macro_risk` 優先 → `macro_cache` 備援(V58.7 定的,理由是 macro_cache 曾停更)
 *   ② 兩份都沒有 → 回 null,⛔ 不可 throw、⛔ 不可亂編一個數字
 *   ③ ⛔ 全 App 不可再直接讀 `m.vix.close`(那就是第二份真相)
 *   ④ **顯示與計分同一個數字** —— 風險指數也要走這支
 *   ⑤ 要帶得出 `src`,呼叫端需要時說得出來源(⛔ 呼叫端不准自己再挑一次)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails++; };

// ── 靜態:⛔ 不可再有第二處直接讀原始欄位 ──
{
    const bad = [];
    SRC.split('\n').forEach((ln, i) => {
        const t = ln.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        // 允許的只有 `_vixState` 自己那一份
        if (/\b\w*\.vix\s*(&&\s*\w+\.vix)?\.close\b|\bvix\?\.close\b/.test(ln) && !/_vixState/.test(ln)
            && !/const b = N\(m\.vix && m\.vix\.close\)/.test(ln)) bad.push(`L${i + 1}: ${t.slice(0, 110)}`);
    });
    ok('③ ⛔ 全 App 不可再直接讀 macro_cache 的 `vix.close`(一律走 `_vixState()`)',
       bad.length === 0, bad.join('\n   '));
    ok('🚧 空過守門:`_vixState` 真的有被接上(⛔ 否則上面那條可能只是掃不到)',
       (SRC.match(/_vixState\(\)/g) || []).length >= 4,
       `${(SRC.match(/_vixState\(\)/g) || []).length} 處`);
    ok('④ ⭐ 風險指數也要走同一支(⛔ 顯示與計分不可用不同數字)',
       /const vix = this\._vixState\(\)\.val;/.test(SRC), '');
}

// ── 動態 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._vixState, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const realMR = app._macroRiskCache, realMS = app._marketSnapshot, realUM = app.usMacroCache;
    const o = {};
    const CACHE = { vix: { date: '2026-09-09', close: 16.31, chg_pct: 3.75 } };
    // ① 兩份都有 → 要拿 macro_risk 那份
    app._macroRiskCache = { vix: 16.41, vix_chg_pct: 4.39, vix_date: '2026-09-09' };
    app._marketSnapshot = CACHE;
    o.both = app._vixState();
    o.bothRisk = app._calcRiskScore();
    // ② 只有 macro_cache → 退回它
    app._macroRiskCache = {};
    o.onlyCache = app._vixState();
    // ③ 兩份都沒有 → null,⛔ 不可 throw
    app._macroRiskCache = {}; app._marketSnapshot = {}; app.usMacroCache = {};
    try { o.none = app._vixState(); } catch (e) { o.none = 'THROW:' + e.message; }
    try { o.noneRisk = app._calcRiskScore(); } catch (e) { o.noneRisk = 'THROW:' + e.message; }
    // ④ macro_risk 的值是 NaN/字串 → 也要退回備援(⛔ 不可把 NaN 當有值)
    app._macroRiskCache = { vix: 'x' }; app._marketSnapshot = CACHE;
    o.badPrimary = app._vixState();
    app._macroRiskCache = realMR; app._marketSnapshot = realMS; app.usMacroCache = realUM;
    return o;
});
await browser.close();

ok('① ⭐ 兩份都有 → 取 macro_risk(比較新的那份)',
   R.both.val === 16.41 && R.both.src === 'macro_risk', JSON.stringify(R.both));
ok('⑤ ⭐ 要帶得出 chg / date / src', R.both.chg === 4.39 && R.both.date === '2026-09-09', JSON.stringify(R.both));
ok('① ⭐ 只有 macro_cache → 退回備援(⛔ 不可整個變空)',
   R.onlyCache.val === 16.31 && R.onlyCache.src === 'macro_cache', JSON.stringify(R.onlyCache));
ok('② ⛔ 兩份都沒有 → 回 null,不可 throw、不可亂編',
   typeof R.none === 'object' && R.none.val === null && R.none.src === null, JSON.stringify(R.none));
ok('② ⛔ 風險指數在沒有 VIX 時也不可 throw',
   typeof R.noneRisk !== 'string', String(R.noneRisk).slice(0, 80));
ok('① ⭐ 主來源是 NaN/字串 → 要退回備援(⛔ 不可把 NaN 當有值)',
   R.badPrimary.val === 16.31 && R.badPrimary.src === 'macro_cache', JSON.stringify(R.badPrimary));
ok('④ ⭐ 風險指數吃得到那個值(⛔ 不是永遠 null)',
   R.bothRisk !== null && R.bothRisk !== undefined, String(R.bothRisk));


// ══ 🌍 V75.2.4 通用入口 `_macroPick` —— 風險指數的四個因子曾經**永遠是 null** ══
//   🚨 `_calcRiskScore` 從頭到尾只讀 macro_cache,而 `es_fut` / `nq_fut` / `gold` / `usdjpy`
//      這四個 key 在 macro_cache 裡**根本不存在** → 那幾個因子永遠不計分,
//      而註解卻寫著「美股方向期貨夜盤優先」(V32.7)—— 那條優先**從來沒有生效過**。
{
    const b2 = await chromium.launch({
        executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    });
    const p2 = await b2.newPage();
    await p2.addInitScript(() => {
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
        Object.defineProperty(window, 'echarts', {
            value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
            writable: true, configurable: true,
        });
    });
    await p2.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p2.waitForFunction(() => typeof app !== 'undefined' && !!app._macroPick, null, { timeout: 25000 });
    const M = await p2.evaluate(() => {
        const rMR = app._macroRiskCache, rMS = app._marketSnapshot, rUM = app.usMacroCache;
        const o = {};
        // 只有 macro_risk 有的那幾個(扁平形狀)
        app._macroRiskCache = { gold_chg_pct: 1.56, es_fut: 7658.25, es_fut_chg_pct: null,
                                nq_fut: 29514, nq_fut_chg_pct: 0.8, sp500: 7652.61, sp500_chg_pct: -0.27 };
        // 只有 macro_cache 有的那個(巢狀形狀)
        app._marketSnapshot = { ukoil: { close: 100.71, chg_pct: 2.85, date: '2026-09-09' },
                                sp500: { close: 7652.71, chg_pct: -9.99, date: '2026-09-09' } };
        o.gold = app._macroChg('gold');
        o.nq = app._macroChg('nq_fut');
        o.oil = app._macroChg('ukoil');
        o.sp500 = app._macroChg('sp500');          // 兩邊都有 → 要拿 macro_risk 那個
        o.usdjpy = app._macroChg('usdjpy');        // 兩邊都沒有 → null
        o.esChg = app._macroChg('es_fut');         // 有值但 chg 刻意是 null
        o.esPick = app._macroPick('es_fut');
        app._macroRiskCache = rMR; app._marketSnapshot = rMS; app.usMacroCache = rUM;
        return o;
    });
    await b2.close();
    ok('⑥ 🚨 只有 macro_risk 有的因子(黃金)要讀得到 —— ⛔ 它以前永遠是 null', M.gold === 1.56, M.gold);
    ok('⑥ 🚨 那斯達克期同理(⛔ 以前永遠不計分)', M.nq === 0.8, M.nq);
    ok('⑥ ⭐ 只有 macro_cache 有的(油價)要走備援', M.oil === 2.85, M.oil);
    ok('⑥ ⭐ 兩邊都有 → 取 macro_risk(⛔ 不可拿到舊的 −9.99)', M.sp500 === -0.27, M.sp500);
    ok('⑥ ⛔ 兩份都沒有的(usdjpy)回 null —— 誠實,⛔ 不可去別處硬湊', M.usdjpy === null, M.usdjpy);
    ok('⑥ ⭐ 有價位但漲跌%刻意留空(期貨)→ val 有值、chg 是 null(⛔ 不可拿 0 充數)',
       M.esPick.val === 7658.25 && M.esChg === null, JSON.stringify(M.esPick));
    // 靜態:風險指數的那幾行不可再直接讀 m.xxx
    const _rs = SRC.slice(SRC.indexOf('_calcRiskScore() {'), SRC.indexOf('_calcRiskScore() {') + 4200);
    ok('⑥ ⛔ 風險指數不可再直接讀 `m.xxx?.chg_pct`(一律 `_macroChg`)',
       !/m\.(es_fut|nq_fut|gold|usdjpy|dxy|sox|tsm|ukoil|sp500)\?\.chg_pct/.test(_rs),
       (_rs.match(/m\.\w+\?\.chg_pct/g) || []).join(' '));
}

console.log(fails ? `❌ ${fails} 條失敗` : '✅ VIXSRC_PASS(全部通過)');
process.exit(fails ? 1 : 0);
