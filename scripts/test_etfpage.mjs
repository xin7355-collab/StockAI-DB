#!/usr/bin/env node
/**
 * 🧩 ETF 頁面:不可沿用個股版面 + 數字要有「作用」(V72.4.1)
 *
 * ⚠️ 使用者截圖抓到的 bug(**陷阱 #19 再犯**):
 *   打開 00981A(主動式 ETF),基本頁顯示「毛利率 +3.0pp(從 2 季前 20.2%)」
 *   「每季 EPS 2.64」「投資屬性 波段52/存股75/短線80」——
 *   ⛔ ETF **沒有毛利率、沒有 EPS、沒有本益比**,那些全是**上一檔個股的殘留**。
 *   根因:`fetchFundamentalAnalysis` 的 ETF 早退**只清了好清的那幾格**
 *   (xrayYoy/xrayPe/…),⛔ 沒清 `xrayGmCompare`(毛利率趨勢文字)、
 *   `xrayEpsTrend`(EPS 圖)、`xrayInv*`(投資屬性雷達)。
 *   🚨 畫面零錯誤訊息,使用者會拿別檔的財報數字判斷這檔 ETF。
 *
 * 另外釘住使用者要求的:「那裡數字還要分析出他到底有什麼作用」——
 *   ⛔ 每個數字都要配一句「所以呢」,不可只排數字。
 *
 * 跑法:node scripts/test_etfpage.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'getInstanceByDom' ? (() => null) : (k === 'graphic' ? {} : noop)) }),
        writable: true, configurable: true,
    });
});
const pageErrs = [];
page.on('pageerror', e => pageErrs.push(String(e).slice(0, 200)));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._etfNumbersMeaning, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const out = {};
    // ── ① 重現殘留 bug:先把個股的欄位塞滿,再切到 ETF ──────────────
    const DIRTY = {
        xrayGmCompare: '↑ +3.0pp(從 2 季前 20.2%)',
        xrayInvBest: '主屬性「短線價差」80分',
        xrayInvSwing: '52', xrayInvHold: '75', xrayInvShort: '80',
        xrayInvFactors: '評分構成因子',
        xrayGmSpark: '<canvas></canvas>',
        xrayEpsTrend: '<canvas>2.64</canvas>',
        xrayInvRadar: '<canvas></canvas>',
        xrayGrossMargin: '23.2%', xrayPe: '18.5x',
    };
    Object.entries(DIRTY).forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.innerHTML = v; });
    out.dirtyBefore = Object.keys(DIRTY).filter(id => (document.getElementById(id)?.innerText || document.getElementById(id)?.innerHTML || '').trim().length > 0);

    app.currentSymbolId = '00981A';
    app._xrayInFlightSym = null;
    try { await app.fetchFundamentalAnalysis('00981A'); } catch (e) { out.err = String(e).slice(0, 200); }
    out.leftOver = Object.keys(DIRTY).filter(id => {
        const el = document.getElementById(id); if (!el) return false;
        const t = (el.innerText || '').replace(/\s+/g, '');
        return t.length > 0 && t !== '—' && t !== '-';
    });
    // ⚠️ 用 innerHTML 不用 innerText —— 這塊在沒被切到的分頁裡(display:none),
    //    Chrome 的 innerText 對 display:none 會回空字串 → 第一版用 innerText 得到假失敗。
    out.xrayMsg = (document.getElementById('xrayAIResult')?.innerHTML || '').replace(/<[^>]+>/g, '').slice(0, 300);

    // ── ② 數字解讀 ────────────────────────────────────────────────
    const etf = {
        symbol: '00981A', name: '主動統一台股增長',
        fund_size: 53e8, expense_ratio: 1.05, cash_ratio: 4.2, nav: 27.75, premium: -0.61,
        turnover_score: 6.3, top1: { sym: '2330', name: '台積電', weight: 9.3 },
        hist: Array.from({ length: 30 }, (_, i) => ({ d: `2026-07-${String(i + 1).padStart(2, '0')}`, p: -2 + i * 0.1, s: 40 + i * 0.5 })),
        changes: {
            added: [{ sym: '6274', name: '台燿' }],
            weight_up: [{ sym: '2454', name: '聯發科', dw: 1.46 }],
            weight_down: [{ sym: '2345', name: '智邦', dw: -0.86 }],
            removed: [],
        },
        holdings: [{ sym: '2330', name: '台積電', weight: 9.3 }, { sym: '2393', name: '台光電', weight: 8.38 }],
    };
    out.meaning = app._etfNumbersMeaning(etf);
    out.moves = app._etfManagerMoves(etf);
    out.meaningEmpty = app._etfNumbersMeaning({});
    out.movesEmpty = app._etfManagerMoves({ changes: {} });
    // 基準重建守門:整批 added、其餘全 0 → 不可顯示「新買進」
    out.movesRebuilt = app._etfManagerMoves({
        changes: { added: Array.from({ length: 20 }, (_, i) => ({ sym: `${3000 + i}`, name: 'X' })), removed: [], weight_up: [], weight_down: [] },
    });
    // 歷史不足時要誠實說「累積中」而不是硬給位階
    out.meaningNoHist = app._etfNumbersMeaning({ ...etf, hist: [] });
    out.isETF = [app._isETF('00981A'), app._isETF('0050'), app._isETF('2330')];
    return out;
});

ok('⓪ 沒有 pageerror', pageErrs.length === 0, pageErrs.join(' | '));
ok('⓪ 測試前真的先弄髒了(否則下面在驗空氣)', (R.dirtyBefore || []).length >= 8, JSON.stringify(R.dirtyBefore));

// ── ① 殘留 bug ────────────────────────────────────────────────────
ok('① ⭐⛔ ETF 頁不可留下個股的毛利率/EPS/投資屬性殘留(陷阱 #19)',
   (R.leftOver || []).length === 0, `還留著:${JSON.stringify(R.leftOver)}`);
ok('① ETF 有給誠實說明(講清楚不適用個股指標)',
   /ETF/.test(R.xrayMsg || '') && /不適用/.test(R.xrayMsg || ''), R.xrayMsg);
// ⭐ 指路必須指對地方:ETF 兩張卡在「總覽 → 進場」,⛔ 不在籌碼分頁(陷阱 #32 的變形)
ok('① ⭐⛔ 指路要指到「總覽 → 進場」,不可寫成籌碼分頁',
   /總覽/.test(R.xrayMsg || '') && !/籌碼分頁/.test(R.xrayMsg || ''), R.xrayMsg);
ok('① _isETF 判斷正確(00 開頭是、個股不是)',
   R.isETF?.[0] === true && R.isETF?.[1] === true && R.isETF?.[2] === false, JSON.stringify(R.isETF));

// ── ② 數字要有「作用」 ───────────────────────────────────────────
const m = R.meaning || '';
ok('② ⭐ 有「這些數字代表什麼」區塊', /這些數字代表什麼/.test(m));
for (const [label, kw] of [['折溢價', '折溢價'], ['規模', '規模'], ['現金水位', '現金水位'],
                           ['集中度', '集中度'], ['換股頻率', '換股頻率'], ['費用率', '費用率']]) {
    ok(`② 含「${label}」`, new RegExp(kw).test(m));
}
ok('② ⭐ 費用率要換算成「實際金額」(使用者鐵則:% 一定要配元)',
   /每放 10 萬元/.test(m) && /元（?不管賺賠|元\(不管賺賠/.test(m.replace(/<[^>]+>/g, '')) || /1,050 元/.test(m), m.slice(0, 300));
ok('② ⭐ 折溢價要講出「所以呢」(買貴/便宜),⛔ 不可只給數字',
   /買貴|貴 |便宜/.test(m));
ok('② ⭐ 規模要講出「經理人被迫買/賣成分股」的傳導',
   /必須買進成分股|賣股票換現金|變化/.test(m));
ok('② ⭐ 歷史不足時要誠實說「累積中」,⛔ 不可硬給位階',
   /累積中/.test(R.meaningNoHist || ''), (R.meaningNoHist || '').slice(0, 200));
ok('② ⛔ 沒有任何欄位時整段不顯示(不留空殼)', (R.meaningEmpty || '') === '');

// ── ③ 經理人動作(正查)────────────────────────────────────────────
const mv = R.moves || '';
ok('③ ⭐ 有「經理人最近動了誰」區塊', /經理人最近動了誰/.test(mv));
ok('③ 顯示新買進 / 加碼 / 減碼', /新買進/.test(mv) && /加碼/.test(mv) && /減碼/.test(mv));
ok('③ 加減碼要附權重變動幅度(pp)', /pp/.test(mv));
ok('③ 可點進該成分股', /app\.analyze\('6274'\)|app\.analyze\('2454'\)/.test(mv));
ok('③ ⭐ 要寫明「是經理人的判斷不是保證」+ 有時間差', /不是保證/.test(mv) && /時間差/.test(mv));
ok('③ ⛔ 沒有動作時整段不顯示', (R.movesEmpty || '') === '');
ok('③ ⭐⛔ 基準重建(整批 added、其餘全 0)不可顯示成「新買進」(沿用 V72.3.1 守門)',
   !/新買進/.test(R.movesRebuilt || ''), (R.movesRebuilt || '').slice(0, 160));

await browser.close();
console.log();
if (fails.length) { console.log(`❌ ETFPAGE_TEST_FAIL:${fails.length} 條`); process.exit(1); }
console.log('✅ ETFPAGE_TEST_PASS');
