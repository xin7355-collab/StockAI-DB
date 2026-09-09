#!/usr/bin/env node
/**
 * 🧮 成交量單位(股 vs 張)+ 深度診斷資料來源標示(V72.4.3)
 *
 * ⚠️ 使用者截圖抓到的兩個問題:
 *
 * ① 頂部顯示「總量 **4331.8萬張**・量增 **117944%**」—— 實際只有 4.3 萬張。
 *    根因:`_chuVolumeProgress` 的 `prevVol` 有做「股/張」自動偵測,
 *    但 `cur`(即時報價)**沒有** → 走 Yahoo fallback 時拿到的是**股**
 *    (`regularMarketVolume`),被當成張直接顯示,差 1000 倍。
 *    量增% =(43,318,000 − 36,700)/36,700 = **+117,944%** ✓ 完全吻合。
 *    ⚠️ **盤前最容易踩到**(Fugle 還沒資料 → 退 Yahoo)。
 *    ⭐ 通用:同一個量在兩個地方換算,**一定要用同一支函式**,否則遲早只改到一邊。
 *
 * ② 同一畫面兩個現價:頂部 181.00(即時報價商)vs 深度診斷 182.00(證交所官方收盤)。
 *    **兩個都沒算錯,是不同來源** → 照「不同來源就給不同名字」鐵則,
 *    深度診斷一律標成「官方收盤(日期)」,⛔ 不冒充即時價。
 *
 * 跑法:node scripts/test_volunit.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

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
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._volToLots, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    // 使用者那筆的真實數字:5483 於 2026/08/04 官方成交 36,697,462 股(=36,697 張)
    const raw = [{ date: '2026/08/01', volume: 30000000 }, { date: '2026/08/04', volume: 36697462 }];
    const fromShares = app._chuVolumeProgress({ volume: 43318000 }, raw);   // Yahoo fallback:股
    const fromLots = app._chuVolumeProgress({ volume: 43318 }, raw);        // Fugle:張
    const pct = v => (v && v.cur && v.prevVol) ? (v.cur - v.prevVol) / v.prevVol * 100 : null;
    return {
        lots: [app._volToLots(43318000), app._volToLots(43318), app._volToLots(0), app._volToLots(999999)],
        curShares: fromShares?.cur, curLots: fromLots?.cur, prev: fromShares?.prevVol,
        deltaShares: pct(fromShares), deltaLots: pct(fromLots),
        progSrc: app._chuVolumeProgress.toString(),
        factsSrc: app._deepBriefFacts.toString(),
        aiSrc: app.analyzeStockDeep.toString(),
        briefSrc: app.renderDeepBrief.toString(),
    };
});

// ── ① 單位正規化 ──────────────────────────────────────────────────
ok('① _volToLots:4331.8 萬股 → 43,318 張', R.lots?.[0] === 43318, JSON.stringify(R.lots));
ok('① _volToLots:已經是張就不再除(43,318 → 43,318)', R.lots?.[1] === 43318, JSON.stringify(R.lots));
ok('① _volToLots:0 與 999,999 不誤轉', R.lots?.[2] === 0 && R.lots?.[3] === 999999, JSON.stringify(R.lots));

ok('① ⭐⛔ 即時報價給「股」時,cur 必須是張(修前差 1000 倍)',
   R.curShares === 43318, `cur=${R.curShares}`);
ok('① ⭐ 給股 vs 給張要得到**同一個** cur(⛔ 不可只修一邊)',
   R.curShares === R.curLots, `${R.curShares} vs ${R.curLots}`);
ok('① 昨量也正確換算成張', R.prev === 36697, `prev=${R.prev}`);
ok('① ⭐⛔ 量增% 不可再出現天文數字(修前 +117,944%)',
   R.deltaShares != null && Math.abs(R.deltaShares) < 300, `${R.deltaShares}%`);
ok('① 兩種來源算出的量增% 一致', Math.abs((R.deltaShares ?? 0) - (R.deltaLots ?? 0)) < 0.01,
   `${R.deltaShares} vs ${R.deltaLots}`);
ok('① ⭐ cur 與 prevVol 都走同一支 _volToLots(⛔ 不可各寫一份換算)',
   (R.progSrc.match(/_volToLots/g) || []).length >= 2, R.progSrc.slice(0, 200));

// ── ② 資料來源標示(同畫面兩個現價的解法)────────────────────────
ok('② ⭐ facts 有帶資料日期', /dataDate/.test(R.factsSrc || ''));
ok('② ⭐ 提示詞把價格標成「官方收盤」而非「現價」',
   /官方收盤/.test(R.aiSrc || ''), (R.aiSrc || '').slice(0, 120));
ok('② ⭐ 有明講「頂部那個是即時報價商,兩邊可能差幾角」(⛔ 不可讓使用者以為打架)',
   /即時報價商/.test(R.aiSrc || ''));
ok('② ⭐⛔ 明令 AI 不准把它講成「現價」', /不要講成「現價」|不要講成"現價"/.test(R.aiSrc || ''));
ok('② ⭐ 卡片標題要標出資料日期(V70.2.0 鐵則)', /dataDate/.test(R.briefSrc || ''));

// ── ③ 基本面(使用者明確要求補的)──────────────────────────────────
ok('③ ⭐ facts 改讀全市場基本面快取(⛔ 不再只靠開過基本頁才有的 _fundCache)',
   /_fundAllCache/.test(R.factsSrc || ''), (R.factsSrc || '').slice(0, 120));
ok('③ ⭐ renderDeepBrief 會預載全市場基本面快取',
   /_loadFundCache/.test(R.briefSrc || ''));
ok('③ 提示詞有本益比與殖利率欄位', /本益比/.test(R.aiSrc || '') && /殖利率/.test(R.aiSrc || ''));

await browser.close();
console.log();
if (fails.length) { console.log(`❌ VOLUNIT_TEST_FAIL:${fails.length} 條`); process.exit(1); }
console.log('✅ VOLUNIT_TEST_PASS');
