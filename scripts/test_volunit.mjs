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

// 🗑️ V77.2.0 原本 ② ③ 兩組(共 8 條)驗的是「深度診斷」的 facts 與提示詞 ——
//   那個功能這一版被使用者明示刪掉了 → 這兩組跟著移除。
//   ⚠️ ⛔ 這不是放寬斷言:①「量的單位」那組(本檔的主題)一條都沒動,
//     而「資料日期要標出來」「價格要標官方收盤」這兩條規則還活在報告頁,
//     由 `test_dupnum` ⓐ / `test_report` 繼續把關。

await browser.close();
console.log();
if (fails.length) { console.log(`❌ VOLUNIT_TEST_FAIL:${fails.length} 條`); process.exit(1); }
console.log('✅ VOLUNIT_TEST_PASS');
