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


// ══ 🌙 V75.2.5 美股期貨夜盤那條顯示 —— 它一直是「🌙 夜盤 --」══
//   🚨 讀的是 `m.es_fut?.chg_pct`(macro_cache),而那份檔**根本沒有 es_fut/nq_fut**
//      → 從上線到現在一直空著,零錯誤訊息(資料體檢新的 D3 類掃出來的)。
//   ⚠️ 而且期貨是「**有價無方向**」(V72.0.5:拿不到上一個結算基準時刻意不給漲跌%)
//      → ⛔ 這種時候不可只顯一個「--」,要把**價位**顯出來並說清楚為什麼沒有 %。
{
    const b3 = await chromium.launch({
        executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    });
    const p3 = await b3.newPage();
    await p3.addInitScript(() => {
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
        Object.defineProperty(window, 'echarts', {
            value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
            writable: true, configurable: true,
        });
    });
    await p3.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p3.waitForFunction(() => typeof app !== 'undefined' && !!app._renderUsFutNight, null, { timeout: 25000 });
    const F = await p3.evaluate(() => {
        const rMR = app._macroRiskCache, rMS = app._marketSnapshot;
        let el = document.getElementById('usFutNight');
        if (!el) { el = document.createElement('div'); el.id = 'usFutNight'; document.body.appendChild(el); }
        const run = (mr, ms) => { app._macroRiskCache = mr; app._marketSnapshot = ms; app._renderUsFutNight(); return el.innerText.replace(/\s+/g, ' '); };
        const o = {};
        o.pct  = run({ es_fut: 7658.25, es_fut_chg_pct: -0.8, nq_fut: 29514, nq_fut_chg_pct: -1.2 }, {});
        o.noPct = run({ es_fut: 7658.25, es_fut_chg_pct: null, nq_fut: 29514, nq_fut_chg_pct: null }, {});
        o.none = run({}, {});
        app._macroRiskCache = rMR; app._marketSnapshot = rMS;
        return o;
    });
    await b3.close();
    ok('⑦ 🚨 有漲跌% → 要顯出來(⛔ 以前永遠是「夜盤 --」)',
       /-0\.80%/.test(F.pct) && /-1\.20%/.test(F.pct), F.pct);
    ok('⑦ ⭐ 有價位但沒有漲跌%(期貨有價無方向)→ 要顯**價位**並說原因,⛔ 不可只給「--」',
       /7,658/.test(F.noPct) && /無漲跌基準/.test(F.noPct), F.noPct);
    ok('⑦ ⛔ 真的什麼都沒有 → 才顯「--」(⛔ 不可亂編一個數字)',
       /夜盤 --/.test(F.none) && !/無漲跌基準/.test(F.none), F.none);
}


// ══ 🕐 V82.4.2 美股還沒收盤時抓的(`intraday`)⛔ 當收盤 ══
//   🚨 2026-11-16 每日採礦機排程晚了快 7 小時(台北 02:42 才跑、美股還在交易)→ macro_cache 寫進美東 13:28 的盤中價、
//      日期 11/16,美股那一排照樣當收盤顯示(標普 −1.81%,收盤其實 −1.92%;台積電 ADR −5.70% vs −6.34%)。
//   ⭐ `_macroPick`:同一格一份盤中、另一份同一天(或更新)的收盤 → 用收盤(val / chg 一起換);只剩盤中那份 → 帶 `intraday` 出去
//   ⭐ 美股那一排:有收盤就顯示收盤;沒有 → 照顯示、旁邊寫「盤中」(⛔ 讓盤中價看起來像收盤)
{
    const b4 = await chromium.launch({
        executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    });
    const p4 = await b4.newPage();
    await p4.addInitScript(() => {
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
        Object.defineProperty(window, 'echarts', {
            value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
            writable: true, configurable: true,
        });
    });
    await p4.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p4.waitForFunction(() => typeof app !== 'undefined' && !!app._macroPick && !!app._renderUSBar, null, { timeout: 25000 });
    const P = await p4.evaluate(() => {
        const rMR = app._macroRiskCache, rMS = app._marketSnapshot, rUM = app.usMacroCache;
        const o = {};
        const pick = (mr, ms, k) => { app._macroRiskCache = mr; app._marketSnapshot = ms; return app._macroPick(k); };
        const CLOSE = { sp500: 7416.59, sp500_chg_pct: -1.92, sp500_date: '2026-11-16' };
        const MID = { sp500: { date: '2026-11-16', close: 7424.72, prev: 7561.58, chg_pct: -1.81, intraday: '13:28' } };
        o.a = pick(CLOSE, MID, 'sp500');                                                                  // macro_cache 盤中、macro_risk 收盤 → 收盤
        o.b = pick({ ...CLOSE, sp500_chg_pct: -1.81, sp500: 7424.72, sp500_intraday: '13:28' },
                   { sp500: { date: '2026-11-16', close: 7416.59, chg_pct: -1.92 } }, 'sp500');           // 反過來 → 換成 macro_cache 的收盤
        o.c = pick({ ...CLOSE, sp500_intraday: '13:28' }, { sp500: { date: '2026-11-13', close: 7561.58, chg_pct: -0.41 } }, 'sp500');   // 收盤那份比較舊 → ⛔ 換
        o.d = pick({}, { nvda: { date: '2026-11-16', close: 155.63, chg_pct: -4.43, intraday: '13:26' } }, 'nvda');   // 只有盤中那份
        o.e = pick(CLOSE, { sp500: { date: '2026-11-16', close: 7416.59, chg_pct: -1.92 } }, 'sp500');   // 都沒標 → 照舊(⛔ 多出 intraday)
        // 美股那一排(實跑 _renderUSBar;元素沒有就補)
        for (const id of ['usBar_spx', 'usBar_spx_chg', 'usBar_nvda', 'usBar_nvda_chg', 'usBar_spx_chg_main', 'usBar_nvda_chg_main']) {
            if (!document.getElementById(id)) { const el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
        }
        app._updateWarRoom = () => {}; app.renderMarketBriefing = async () => {};
        app._macroRiskCache = CLOSE;
        app._renderUSBar({ ...MID, nvda: { date: '2026-11-16', close: 155.63, prev: 162.84, chg_pct: -4.43, intraday: '13:26' } });
        const t = id => (document.getElementById(id) || {}).textContent || '';
        o.bar = { spx: t('usBar_spx'), spxChg: t('usBar_spx_chg'), spxMain: t('usBar_spx_chg_main'), nvdaChg: t('usBar_nvda_chg'), nvdaMain: t('usBar_nvda_chg_main'),
                  nvdaTag: !!document.querySelector('#usBar_nvda_chg [data-intraday="nvda"]'), spxTag: !!document.querySelector('#usBar_spx_chg [data-intraday]') };
        app._macroRiskCache = {};
        app._renderUSBar({ sp500: { date: '2026-11-16', close: 7416.59, prev: 7561.58, chg_pct: -1.92 } });
        o.bar0 = { spxChg: t('usBar_spx_chg'), tag: !!document.querySelector('#usBar_spx_chg [data-intraday]') };
        // 標記內容怪(⛔ 原樣進 innerHTML / title)→ 只留 HH:MM
        app._renderUSBar({ sp500: { date: '2026-11-16', close: 7424.72, chg_pct: -1.81, intraday: '"><img src=x onerror=alert(1)>13:05' } });
        const tg = document.querySelector('#usBar_spx_chg [data-intraday]');
        o.bad = { title: tg ? tg.getAttribute('title') : null, img: !!document.querySelector('#usBar_spx_chg img'), at: app._intraAt('x'), none: app._intraAt('') };
        app._macroRiskCache = rMR; app._marketSnapshot = rMS; app.usMacroCache = rUM;
        return o;
    });
    await b4.close();
    ok('⑧ 🕐 macro_cache 是盤中、macro_risk 是同一天收盤 → 拿收盤(−1.92%)、intraday 空', P.a.src === 'macro_risk' && P.a.chg === -1.92 && !P.a.intraday, JSON.stringify(P.a));
    ok('⑧b ⭐ 反過來:macro_risk 是盤中、macro_cache 是同一天收盤 → 換成收盤那份(val / chg 一起換)',
       P.b.src === 'macro_cache' && P.b.val === 7416.59 && P.b.chg === -1.92 && !P.b.intraday, JSON.stringify(P.b));
    ok('⑧c 收盤那份比較舊(11/13)→ ⛔ 換,照用盤中那份、帶 intraday 出去', P.c.src === 'macro_risk' && P.c.intraday === '13:28', JSON.stringify(P.c));
    ok('⑧d 只剩盤中那份 → 照給、帶 intraday', P.d.val === 155.63 && P.d.intraday === '13:26', JSON.stringify(P.d));
    ok('⑧e 都沒標 → 照舊(intraday 空)', P.e.src === 'macro_risk' && P.e.chg === -1.92 && !P.e.intraday, JSON.stringify(P.e));
    ok('⑧f 美股那一排:標普有同一天收盤 → 顯示收盤 −1.92%、⛔ 標盤中;NVDA 只有盤中那份 → −4.43% 旁邊寫「盤中」',
       /7,416\.59/.test(P.bar.spx) && P.bar.spxChg === '-1.92%' && P.bar.spxMain === '-1.92%' && !P.bar.spxTag
       && P.bar.nvdaTag && /^-4\.43%・盤中$/.test(P.bar.nvdaChg) && P.bar.nvdaMain === '-4.43%・盤中', JSON.stringify(P.bar));
    ok('⑧g 決定性對照:沒標的收盤 → 照舊、⛔ 盤中字樣', P.bar0.spxChg === '-1.92%' && !P.bar0.tag, JSON.stringify(P.bar0));
    ok('⑧h 標記內容怪 → 只留美東 HH:MM(⛔ 原樣塞進畫面);認不出時間 → 「—」、沒標 → null',
       P.bad.title === '美東 13:05 抓的盤中價,美股還沒收盤 —— 不是收盤價' && !P.bad.img && P.bad.at === '—' && P.bad.none === null, JSON.stringify(P.bad));
}

console.log(fails ? `❌ ${fails} 條失敗` : '✅ VIXSRC_PASS(全部通過)');
process.exit(fails ? 1 : 0);
