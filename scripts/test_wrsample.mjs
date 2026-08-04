#!/usr/bin/env node
/**
 * 🎲 樣本守門 + 乾淨對照組(V72.2.2)
 *
 * 由 `scripts/page_sweep.mjs`(實際渲染後掃 innerText)抓出來的兩個真 bug ——
 * ⛔ **靜態 grep 看不到**,因為問題出在「數字組合起來很荒謬」而不是某個關鍵字。
 *
 * ① 打法適配儀:「📐 ABC下降切線突破 勝率 **100%** ・賺賠比 **全贏** ・**3 次**」
 *    還掛 ⭐主打 + 閃爍,並在上方寫「今天 K 線出現這檔歷史最會賺的型態 → **可依紀律進場**」。
 *    3 次 100% 不是好用,是**還不知道**(陷阱 #27:1/1 = 100% 的假信心)。
 *    ⚠️ `_winRateConfidence` 早在 V71.8.6 就寫好了,CLAUDE.md 也寫著
 *      「任何顯示『勝率 X%・N 次』的地方都該配這個」——**但全 App 只接了 1 處**。
 *
 * ② 當沖「隔日沖勝率回測」:0050 顯示
 *    「🏆 這檔最高勝率:爆量突破 **0%**」+「成功率最高的做法(**鐵律**)」。
 *    0% 不是最高勝率。真因是**沒有對照組** —— 只跟 0 比、沒跟「隨便挑一天」比。
 *    實測 0050 的基準是 **7%**,2317 是 **29%**,3231 是 **37%** ——
 *    ⭐ 基準隨個股波動率差很多,⛔ 拿 50% 或寫死門檻都會判錯
 *      (2317「爆量長紅 47%」對 50% 會被標成「跟丟銅板差不多」,但它明明贏基準 18pp)。
 *
 * 跑法:node scripts/test_wrsample.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const txt = h => String(h == null ? '' : h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._wrTag, null, { timeout: 25000 });

// ══ ① 共用門檻與徽章 ════════════════════════════════════════
const A = await page.evaluate(() => ({
    enough10: app._wrEnough(10), enough9: app._wrEnough(9), enough0: app._wrEnough(0),
    tag3: app._wrTag(100, 3), tag40: app._wrTag(68, 40), tagBad: app._wrTag(52, 50),
    // ⭐ 向後相容:第 3 參數不給時行為必須跟改版前**完全一樣**
    c12_old: app._winRateConfidence(67, 12),
    c12_p05: app._winRateConfidence(67, 12, 0.5),
    // ⭐ 換基準:2317 實例(勝率 47%、17 次、基準 29%)
    c2317_coin: app._winRateConfidence(47, 17, 0.5),
    c2317_base: app._winRateConfidence(47, 17, 0.29),
}));
ok('① `_wrEnough` 門檻 = 10 次', A.enough10 === true && A.enough9 === false && A.enough0 === false,
   JSON.stringify(A));
ok('① ⭐ n<10 的徽章要直接寫「只有 N 次」(⛔ 不能只給圖示,使用者看不懂)',
   /⏳/.test(A.tag3) && /只有 3 次/.test(A.tag3), A.tag3);
// ⚠️ 只驗**看得見的字**(徽章本體),⛔ 別連 title 一起比 —— tooltip 裡本來就有「機率只有 2%」,
//    第一版拿整串 HTML 比 `!/只有/` 直接假失敗(這是本 session 第 8 次踩「否定式比對」)。
ok('① 樣本夠且顯著 → ✅,且⛔ 不再掛「只有 N 次」', /✅/.test(A.tag40) && !/只有/.test(txt(A.tag40)), txt(A.tag40));
ok('① 跟丟銅板差不多 → ⛔', /⛔/.test(A.tagBad), A.tagBad);
ok('① ⛔ 徽章不可用 🔴🟢(燈號鐵則:那兩顆只准表示漲跌方向)',
   !/[🔴🟢]/.test(A.tag3 + A.tag40 + A.tagBad), A.tag3 + A.tag40 + A.tagBad);

ok('① ⭐ 第 3 參數向後相容(不給 == 給 0.5)',
   JSON.stringify(A.c12_old) === JSON.stringify(A.c12_p05), JSON.stringify([A.c12_old, A.c12_p05]));
ok('① ⭐⛔ 換成該場景的真基準,結論要跟著變(47%/17次:對 50% 是 ⛔、對 29% 不是)',
   A.c2317_coin.icon === '⛔' && A.c2317_base.icon !== '⛔',
   JSON.stringify({ coin: A.c2317_coin.icon, base: A.c2317_base.icon }));
ok('① 基準不是 50% 時,文案要講出基準數字(⛔ 別再寫「純靠運氣」讓人對不上畫面)',
   /基準 29%/.test(A.c2317_base.txt) && !/純靠運氣/.test(A.c2317_base.txt), A.c2317_base.txt);
ok('① 基準是 50% 時,文案維持「純靠運氣」(⛔ 別改壞既有那 1 處呼叫端)',
   /純靠運氣/.test(A.c12_old.txt), A.c12_old.txt);

// ══ ② 當沖隔日沖回測:必須有乾淨對照組 ══════════════════════
//   ⚠️ 用**真實 data/*.json**,⛔ 別用合成資料 —— 基準勝率本來就是「這檔自己的波動率」,
//      合成的等差 K 線基準會是 0,那等於什麼都沒驗到(本 session 已踩過「空過」兩次)。
const dt = {};
for (const s of ['0050', '2317', '3231']) {
    const p = path.join(ROOT, 'data', `${s}.json`);
    if (!fs.existsSync(p)) { console.log(`   ⏭️ 沒有 data/${s}.json,略過`); continue; }
    dt[s] = await page.evaluate(r => app._dtWinRateBacktest(r), JSON.parse(fs.readFileSync(p, 'utf8')));
}
if (dt['0050']) {
    const t = txt(dt['0050']);
    console.log(`   ↳ 0050:${t.slice(0, 150)}`);
    ok('② ⭐ 一定要顯示基準(隨便挑一天做同一套是幾%)', /基準\(隨便挑一天做同一套\):\s*\d+%/.test(t), t.slice(0, 200));
    ok('② ⭐⛔ 0% 勝率絕不可掛 🏆「這檔最高勝率」', !/🏆 這檔最高勝率/.test(t), t.slice(0, 260));
    ok('② ⭐⛔ 沒贏基準時不可給「成功率最高的做法(鐵律)」', !/成功率最高的做法/.test(t), t.slice(0, 260));
    ok('② ⭐ 要誠實說「沒有值得做的隔日沖型態」+ 給替代方向',
       /沒有值得做的隔日沖型態/.test(t) && /換一檔|波段做法/.test(t), t.slice(-260));
}
if (dt['3231']) {
    const t = txt(dt['3231']);
    console.log(`   ↳ 3231:${t.slice(0, 130)}`);
    ok('② ⭐ 真的贏過基準時,🏆 與操作指令要照給(⛔ 別矯枉過正變成全部不給)',
       /🏆 這檔最高勝率/.test(t) && /成功率最高的做法/.test(t) && /贏過基準 \d+%/.test(t), t.slice(0, 300));
}
if (dt['2317']) {
    const t = txt(dt['2317']);
    ok('② ⭐ 沒贏基準的那幾列要標出來(使用者才知道為什麼沒被選)', /沒贏基準/.test(t), t.slice(0, 300));
    ok('② ⭐ 勝率 47%(基準 29%)⛔ 不可被標成「跟丟銅板差不多」',
       !/47% ⛔/.test(t), (t.match(/47%[^ ]* ./) || [''])[0]);
}
// 顏色門檻必須相對基準(⛔ 寫死 60/45 會把「47% vs 基準 29%」染成綠色)
const src = await page.evaluate(() => app._dtWinRateBacktest.toString());
ok('② ⭐⛔ 勝率顏色門檻不可寫死,要相對 baseWr',
   /wrCls = w => w >= baseWr \+ \d+ \? .* : w > baseWr \?/.test(src), (src.match(/const wrCls = [^\n]*/) || [''])[0]);
ok('② ⭐ 基準是用**同一條勝負定義**掃全部交易日算的(⛔ 不可寫死一個數字)',
   /for \(let i = 6; i < arr\.length - 1; i\+\+\)[\s\S]{0,220}bn\+\+/.test(src), '');

// ══ ③ 打法適配儀:樣本 + 空頭 兩道守門 ══════════════════════
const play = (count, trend) => page.evaluate(async a => {
    const realFit = app._patternFitBacktest, realPer = app._stockPersonality;
    app._patternFitBacktest = () => ([
        { key: '📐 測試型態', winRate: 100, plRatio: 99, count: a.count, expectancy: 3.3, firedToday: true },
        { key: '📐 陪跑', winRate: 30, plRatio: 0.8, count: 40, expectancy: -0.5, firedToday: false },
    ]);
    app._stockPersonality = () => ({ tag: 'x', desc: 'y' });
    app.currentSymbolId = '9999';
    app.activeData = Array.from({ length: 200 }, (_, i) => ({ date: `2026-01-${(i % 28) + 1}`, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100 + i * 0.1, volume: 1000 }));
    app._ovTrend = a.trend ? { sym: '9999', trend: a.trend, txt: 'x' } : null;
    try { localStorage.removeItem('playbook_9999'); } catch (_) { }
    app.analyzeStockPlaybook();
    await new Promise(r => setTimeout(r, 260));
    const h = document.getElementById('playbookCard').innerHTML;
    app._patternFitBacktest = realFit; app._stockPersonality = realPer;
    return h;
}, { count, trend });

const P3 = txt(await play(3, 'flat'));
ok('③ ⭐⛔ 只有 3 次時,不可寫「可依紀律進場」', !/可依紀律進場/.test(P3), P3.slice(0, 300));
ok('③ ⭐ 要直接說「只出現過 3 次…還不能當結論」', /只出現過 3 次/.test(P3) && /不能當結論/.test(P3), P3.slice(0, 320));
ok('③ ⭐ 排名列旁邊要有樣本徽章', /只有 3 次/.test(P3), P3.slice(0, 400));

const P20 = txt(await play(20, 'flat'));
ok('③ ⭐ 樣本夠 + 非空頭 → 指令照給(⛔ 別矯枉過正)', /可依紀律進場/.test(P20), P20.slice(0, 300));

const PB = txt(await play(20, 'bear'));
ok('③ ⭐⛔ 主結論空頭時,⛔ 不可寫「可依紀律進場」(講反話第 7 處)',
   !/可依紀律進場/.test(PB), PB.slice(0, 320));
ok('③ ⭐ 空頭時要改講「先別加碼 / 反彈偏減碼」,但**事實描述照留**',
   /先別加碼|反彈仍偏減碼/.test(PB) && /現在觸發/.test(PB), PB.slice(0, 340));
const bgSrc = await page.evaluate(() => app.analyzeStockPlaybook.toString());
ok('③ ⭐⛔ 空頭判斷一律走 `_bearGate`(⛔ 別自己寫一份判斷式)',
   /_bearGate\?\.\(sym\)/.test(bgSrc), (bgSrc.match(/_bearGate[^\n]*/) || [''])[0]);
ok('③ ⭐⛔ 樣本門檻一律走 `_wrEnough`(⛔ 別在顯示端寫死數字)',
   /this\._wrEnough\(r0\.count\)/.test(bgSrc), '');

// ══ ④ 推播:主動叫人進場的門檻不可比畫面上還鬆 ════════════════
const alertSrc = await page.evaluate(() => {
    for (const k of Object.keys(app)) {
        if (typeof app[k] === 'function' && /主打型態觸發/.test(app[k].toString())) return app[k].toString();
    }
    return '';
});
ok('④ 找得到主打型態推播', alertSrc.length > 0, '');
ok('④ ⭐⛔ 推播門檻要用 `_wrEnough`,不可寫死 `count >= 5`',
   /this\._wrEnough\(r\.count\)/.test(alertSrc) && !/r\.count >= 5/.test(alertSrc),
   (alertSrc.match(/if \(!\(r\.expectancy[^\n]*/) || [''])[0]);

ok('⑤ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ WRSAMPLE_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ WRSAMPLE_TEST_PASS');
