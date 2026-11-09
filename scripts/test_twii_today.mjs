#!/usr/bin/env node
/**
 * 📈 V82.0.9「今天加權漲跌 %」只能是今天的 + 行情頁指數盤中真的會動 + 方塊標日期
 *   使用者 11/09 09:45 截圖:大盤 › 行情 的加權方塊一直是上週五收盤 ▼−4.51%(沒標日期),
 *   市場廣度卡「大盤 vs 你手上那檔」拿那個 −4.51% 配今天的中位數 +2.15% →「今天指數被權值股拖累 −6.66pp」;
 *   同一時間 0050 / 台指期都漲約 5% = 正好相反。真因:舊 `_taiexTodayPct` = FinMind 日線最後一根(盤中 = 上一個交易日)。
 *
 *   ⓐ 只有日線、最後一根 = 上週五 → `_twiiToday()` null;⭐ 決定性對照:同一份最後一根改成今天 → 有值(close)
 *   ⓑ 優先序:盤中快照自己的 idx.twii > 富果今天 > 今天收盤;富果報價日期是上週五 → ⛔ 收
 *   ⓒ 在 📈 行情頁真的會去抓(fetchFugleData 換成假的):三格寫「盤中 09:45」、回 true;
 *      報價是上週五的 → 方塊寫「11/06(五)收盤」、⛔「盤中」;台北 08:40 拿到今天日期的報價 → ⛔ 當成今天
 *   ⓓ 不在大盤頁 → 不抓(省富果額度);設定關掉 → 不抓
 *   ⓔ 市場廣度卡:週五日線 + 今天快照(沒有 twii)→ ⛔「拖累 / 拉上去 / 指數跌(」;快照有 twii +5 →「被權值股拉上去」
 *   ⓕ 靜態:`this._taiexTodayPct` 0 處;5 個讀取點都走 `_twiiTodayPct()`;守門讀 tabContentMarket
 *   ⓖ 390px 行情頁不橫捲、無 pageerror
 * 注入:INJECT=stale(日線不看日期)→ ⓐ ⓔ 必紅;INJECT=noguard(守門改回盤前那頁的扁平列)→ ⓒ 必紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'stale') SRC = SRC.replace('if (D && D.d === today && Number.isFinite(D.pct))', 'if (D && Number.isFinite(D.pct))');
if (INJ === 'noguard') SRC = SRC.replace("const mk = document.getElementById('tabContentMarket');", "const mk = document.getElementById('mktTWII_main');");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_twii_today.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails.push(n); };

// ⓕ 靜態
ok('ⓕ1 `this._taiexTodayPct` 讀 / 寫都是 0 處(⛔ 復活:它是日線最後一根,盤中 = 上一個交易日)', !/this\._taiexTodayPct/.test(SRC.replace(/\/\/[^\n]*/g, '')));
ok('ⓕ2 5 個讀取點都走 `_twiiTodayPct()`(當沖相對大盤 / 套牢診斷 / 中位數卡 / 廣度背離 / 當沖頁)', (SRC.match(/this\._twiiTodayPct\(\)/g) || []).length >= 5, (SRC.match(/this\._twiiTodayPct\(\)/g) || []).length);

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const benign = t => /Cache': Request scheme 'file'|Failed to load resource|net::ERR_/i.test(t);
try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { if (!benign(e.message)) errs.push(e.message); });
    await page.clock.setFixedTime(new Date('2026-11-09T01:45:00Z'));   // 台北 11/09(一)09:45
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.addInitScript(() => { try { localStorage.clear(); } catch (_) {} });
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    // ⚠️ 沙箱連不到 Tailwind CDN → `.hidden` 什麼都沒藏 → 「盤前那頁的扁平列看不看得到」永遠是看得到(INJECT=noguard 第一次跑就這樣溜過去)。
    //    只補這一條(Tailwind 的 .hidden 排在 .flex 後面,一樣贏),⛔ 假裝補齊整套。
    await page.addStyleTag({ content: '.hidden{display:none}' });
    await page.waitForFunction(() => typeof app !== 'undefined' && Array.isArray(app.navStack) && app.navStack.includes('desk'), null, { timeout: 90000 });
    await page.waitForTimeout(300);

    const FRI = { taiex: [{ date: '2026-11-05', close: 41577 }, { date: '2026-11-06', close: 39702 }], tpex: [{ date: '2026-11-05', close: 321.5 }, { date: '2026-11-06', close: 304.02 }], fiShort: null };
    const TODAY = { taiex: [{ date: '2026-11-06', close: 39702 }, { date: '2026-11-09', close: 41700 }], tpex: [{ date: '2026-11-06', close: 304.02 }, { date: '2026-11-09', close: 318.5 }], fiShort: null };

    // ⓐ 日線只有上週五 → null;最後一根是今天 → close
    const A = await page.evaluate(([fri, tod]) => {
        app._liveIdx = {}; app._liveUpdated = null; app._idxLiveF = {}; app._idxDaily = {}; app._idxAsOf = {};
        app.processMacroData(fri);
        const a1 = app._twiiToday(), a1o = app._idxToday('twoii');
        app.processMacroData(tod);
        const a2 = app._twiiToday();
        return { a1, a1o, a2 };
    }, [FRI, TODAY]);
    ok('ⓐ1 ⭐ 日線最後一根是上週五 → `_twiiToday()` / 櫃買都是 null(⛔ 拿上一個交易日頂替)', A.a1 === null && A.a1o === null, JSON.stringify(A));
    ok('ⓐ2 ⭐ 決定性對照:同一份日線最後一根改成今天 → 有值、來源 close', !!A.a2 && A.a2.src === 'close' && Math.abs(A.a2.pct - 5.03) < 0.01, JSON.stringify(A.a2));

    // ⓑ 優先序
    const B = await page.evaluate(([fri]) => {
        app._liveIdx = {}; app._liveUpdated = null; app._idxLiveF = {}; app._idxDaily = {};
        app.processMacroData(fri);
        app._idxLiveF = { twii: { pct: 4.9, price: 41650, d: '2026-11-09', at: Date.now() } };
        const b1 = app._twiiToday();
        app._liveIdx = { twii: { p: 41700, c: 5.03 } }; app._liveUpdated = new Date().toISOString();
        const b2 = app._twiiToday();
        app._liveIdx = {}; app._idxLiveF = { twii: { pct: -4.51, price: 39702, d: '2026-11-06', at: Date.now() } };
        const b3 = app._twiiToday();
        return { b1, b2, b3, p: app._twiiTodayPct() };
    }, [FRI]);
    ok('ⓑ1 富果今天的報價 → 收(src fugle)', B.b1 && B.b1.src === 'fugle' && B.b1.pct === 4.9, JSON.stringify(B.b1));
    ok('ⓑ2 盤中快照自己有加權 → 優先(跟中位數同一個時間點)', B.b2 && B.b2.src === 'snap' && B.b2.pct === 5.03, JSON.stringify(B.b2));
    ok('ⓑ3 ⭐ 富果報價日期是上週五 → ⛔ 收(null)', B.b3 === null && B.p === null, JSON.stringify(B));

    // ⓒ 行情頁真的去抓
    const fugleQ = (d) => page.evaluate((dd) => {
        app._liveIdx = {}; app._liveUpdated = null; app._idxLiveF = {}; app._idxDaily = {}; app._idxAsOf = {}; app._idxFugleAt = 0;
        app.settings.liveTwIndex = true;
        app._getFugleKeys = () => ['k1'];
        app._fugleCalls = 0;
        app.fetchFugleData = async (code) => { app._fugleCalls++; return code === 'IX0001' ? { price: 41700, prevClose: 39702, date: dd } : { price: 318.5, prevClose: 304.02, date: dd }; };
        app.switchAppTab('market'); app.switchMarketSubTab('idx');
    }, d);
    await page.evaluate(([fri]) => { app.processMacroData(fri); }, [FRI]);
    await fugleQ('2026/11/09');
    let C = await page.evaluate(async ([fri]) => {
        app.processMacroData(fri);   // 先畫上週五那一根(跟正式環境一樣:日線先到)
        const got = await app._refreshLiveTwIndices();
        const row = document.getElementById('mktIndexRow');
        return { got, txt: row ? row.innerText : '', tw: app._twiiToday(), calls: app._fugleCalls, f: app._idxLiveF };
    }, [FRI]);
    ok('ⓒ1 ⭐ 在 📈 行情頁會去抓、回 true、`_twiiToday()` = 富果今天', C.got === true && C.tw && C.tw.src === 'fugle' && Math.abs(C.tw.pct - 5.03) < 0.01 && C.calls >= 1, JSON.stringify({ got: C.got, tw: C.tw, calls: C.calls }));
    ok('ⓒ2 三格的加權寫今天的值 + 「盤中 09:45」(⛔ 還是上週五的 39702)', /41700/.test(C.txt) && /盤中 09:45/.test(C.txt) && !/39702/.test(C.txt), C.txt.replace(/\n/g, ' | '));
    await fugleQ('2026/11/06');
    C = await page.evaluate(async ([fri]) => {
        app.processMacroData(fri);
        const got = await app._refreshLiveTwIndices();
        const row = document.getElementById('mktIndexRow');
        return { got, txt: row ? row.innerText : '', tw: app._twiiToday() };
    }, [FRI]);
    ok('ⓒ3 ⭐ 報價是上週五的 → 回 false、⛔ 當成今天、方塊寫「11/06(五)收盤」', C.got === false && C.tw === null && /11\/06\(五\)收盤/.test(C.txt) && !/盤中/.test(C.txt), C.txt.replace(/\n/g, ' | '));
    await page.clock.setFixedTime(new Date('2026-11-09T00:40:00Z'));   // 台北 08:40
    await fugleQ('2026/11/09');
    C = await page.evaluate(async ([fri]) => { app.processMacroData(fri); const got = await app._refreshLiveTwIndices(); return { got, tw: app._twiiToday() }; }, [FRI]);
    ok('ⓒ4 台北 08:40 拿到「今天」日期的報價 → ⛔ 當成今天的即時(開盤前常常是上一個交易日的收盤)', C.got === false && C.tw === null, JSON.stringify(C));
    await page.clock.setFixedTime(new Date('2026-11-09T01:45:00Z'));

    // ⓓ 不在大盤頁 / 設定關掉 → 不抓
    await fugleQ('2026/11/09');
    const D = await page.evaluate(async () => {
        app.switchAppTab('desk');
        await new Promise(r => setTimeout(r, 50));   // 切頁那一下觸發的抓取先跑完,只量「人在決策台時」那一次
        app._fugleCalls = 0; app._idxFugleAt = 0;
        const g1 = await app._refreshLiveTwIndices(), c1 = app._fugleCalls;
        app.switchAppTab('market'); app.switchMarketSubTab('idx');
        await new Promise(r => setTimeout(r, 50));
        app._fugleCalls = 0; app.settings.liveTwIndex = false;
        const g2 = await app._refreshLiveTwIndices(), c2 = app._fugleCalls;
        app.settings.liveTwIndex = true;
        return { g1, c1, g2, c2 };
    });
    ok('ⓓ1 不在大盤頁 → 不抓(0 次)', D.g1 === false && D.c1 === 0, JSON.stringify(D));
    ok('ⓓ2 設定「加權/櫃買前端即時」關掉 → 不抓', D.g2 === false && D.c2 === 0, JSON.stringify(D));

    // ⓔ 市場廣度卡
    const E = await page.evaluate(([fri]) => {
        app.switchAppTab('market'); app.switchMarketSubTab('idx');
        app._idxLiveF = {}; app._idxDaily = {}; app._breadthHist = [];
        app.processMacroData(fri);
        app._liveQuotes = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`s${i}`, { c: i < 470 ? -1 : (i < 1000 ? 1.5 : 2.5) }]));   // 76% 上漲、中位數 +2
        app._liveUpdated = new Date().toISOString(); app._liveTs = '11/09 09:40';
        app._liveIdx = {};
        app.renderMarketBreadth();
        const t1 = document.getElementById('marketBreadthCard').innerText;
        app._liveIdx = { twii: { p: 41700, c: 5.0 } };
        app.renderMarketBreadth();
        const t2 = document.getElementById('marketBreadthCard').innerText;
        return { t1, t2 };
    }, [FRI]);
    ok('ⓔ1 ⭐ 週五日線 + 今天快照(沒有加權)→ ⛔「拖累 / 拉上去 / 指數跌(」,寫「還沒拿到」', !/拖累|拉上去|指數跌\(/.test(E.t1) && /還沒拿到/.test(E.t1), E.t1.replace(/\n/g, ' | ').slice(0, 700));
    ok('ⓔ2 快照有今天的加權 +5%、中位數 +2% → 「被權值股拉上去」', /拉上去/.test(E.t2) && !/拖累/.test(E.t2), E.t2.replace(/\n/g, ' | ').slice(0, 700));

    // ⓖ 390px 不橫捲
    const G = await page.evaluate(() => { window.scrollTo(80, 0); return window.scrollX; });
    ok('ⓖ1 390px 行情頁不橫捲', G <= 2, G);
    await ctx.close();
} finally {
    await browser.close();
    try { fs.unlinkSync(TMP); } catch (_) {}
}
ok('ⓖ2 無 pageerror', errs.length === 0, errs.join(' | ').slice(0, 500));
console.log(fails.length ? `\n❌ TWII_TODAY_FAIL: ${fails.length} 條 ${JSON.stringify(fails)}` : '\n✅ TWII_TODAY_PASS');
process.exit(fails.length ? 1 : 0);
