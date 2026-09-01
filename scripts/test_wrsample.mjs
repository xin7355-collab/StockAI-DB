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
    // ⚠️ 少了 `--allow-file-access-from-files`,analyze() 會**靜默**抓不到 data/*.json → 測試假綠
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|scheme 'file' is unsupported/i.test(t);
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

// ══ ② 當沖隔日沖回測 —— 🗑️ V74.2.0 已刪除,這裡改釘「真的刪乾淨 + 依據還在」══
//   dtflip_probe 全市場 pooled(2,329 檔 / 270.9 萬個(股·日)):「碰到 +1.5%」機率 53~72% 是真的,
//   但務實損益(碰 1.5% 停利否則收盤出、扣成本 0.25%)三型態**全負** → 碰得到 ≠ 賺得到。
//   ⚠️ 原本這一段驗「對照組/不給 0% 掛冠軍」—— 功能刪了,那些行為自然不存在;
//      改驗:① 函式永遠回空(⛔ 不可有人偷偷把它接回畫面)② 墓碑要引用 dtflip_probe(復活門檻)。
{
    const p = path.join(ROOT, 'data', '2330.json');
    if (fs.existsSync(p)) {
        const out = await page.evaluate(r => app._dtWinRateBacktest(r), JSON.parse(fs.readFileSync(p, 'utf8')));
        ok('② 🗑️ _dtWinRateBacktest 已刪除 → 餵真實資料也永遠回空字串', out === '', JSON.stringify(out).slice(0, 120));
    }
    const src = await page.evaluate(() => app._dtWinRateBacktest.toString());
    ok('② 🗑️ 墓碑要引用 dtflip_probe + 「碰得到 ≠ 賺得到」(⛔ 要復活先讓務實損益轉正)',
       /dtflip_probe/.test(src) && /碰得到/.test(src), src.slice(0, 200));
}

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


// ══ ⑤ 多空計分卡:一邊掛零 / 命中不夠 / 空頭 三道守門 ══════════
//   `page_sweep` 掃到 1101:「多方 7 項・14 分 / **0 項** 空方 → 多方 100%
//    → **四面向同步攻擊,可放心做多**」。⚠️ 一邊掛零多半是「那類資料還沒到齊」
//    而不是「真的沒有利空」(陷阱 #28),7/28 條就給最強多方指令太滿。
//   ⛔ 而且它一直沒過 `_bearGate` —— ratio 講的是「規則命中比」不是「價格趨勢」,兩者會背離。
//
// ⚠️ 規則是在函式裡就地組出來的(沒有可以 stub 的 `_bullBearRules`)→
//    ⭐ 一律用**真實資料跑真的函式**(同 test_lowsample 的原則:⛔ 不在測試裡複製判定邏輯),
//    只有「主結論趨勢」用 `_ovTrend` 覆寫 —— 那本來就是外部狀態,不是判定邏輯。
const bbPage = await browser.newPage();
await bbPage.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
await bbPage.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await bbPage.waitForFunction(() => typeof app !== 'undefined' && !!app._calcBullBearScan, null, { timeout: 25000 });

const scanOf = (sym, trend) => bbPage.evaluate(async a => {
    app.switchAppTab('diag');
    await app.analyze(a.sym, true, false, true);
    // ⚠️ 籌碼/基本面快取是**非同步**載入的 —— 沒等它,第一次掃只會命中技術面那 2~3 條,
    //    結論變成「訊號不足」→ 測試會驗到錯的分支(第一版就踩到:第 1 次 2多/1空、第 2 次才 7多/0空)。
    try { await app._ensureBullBearCaches(); } catch (_) { }
    await new Promise(r => setTimeout(r, 1500));
    app._ovTrend = a.trend ? { sym: a.sym, trend: a.trend, txt: 'x' } : app._ovTrend;
    const r = app._calcBullBearScan(a.sym);
    return r && { verdict: r.verdict, hits: r.hits, bull: r.bullCount, bear: r.bearCount, low: r.lowSample, one: r.oneLiner, n: (app.rawDailyData || []).length };
}, { sym, trend });

// ⚠️ ⛔ **不可綁死「1101 一定是 7多/0空」** —— 命中數會隨採礦資料浮動(V72.1.8 的教訓)。
//    → 掃幾檔,找到「真的一邊掛零」的那檔再驗;找不到就誠實略過(下面另有原始碼層的守門)。
let zeroCase = null, anyCase = null;
for (const sym of ['1101', '6919', '2881', '2327', '2330']) {
    const r = await scanOf(sym, null);
    if (!r || !(r.n >= 100)) continue;
    anyCase = anyCase || { sym, ...r };
    console.log(`   ↳ ${sym}:${r.verdict}・${r.bull}多/${r.bear}空｜${txt(r.one).slice(0, 70)}`);
    if (!r.low && (r.bull === 0 || r.bear === 0)) { zeroCase = { sym, ...r }; break; }
}
ok('⑤ 測資有效(至少有一檔真的載到資料)', !!anyCase, 'analyze 全部沒載到 data/');
if (zeroCase) {
    ok(`⑤ ⭐⛔ 一邊掛零(${zeroCase.sym} ${zeroCase.bull}多/${zeroCase.bear}空)時不可寫「可放心做多」`,
       !/可放心做多/.test(zeroCase.one), txt(zeroCase.one));
    ok('⑤ ⭐ 要主動點出「一邊掛零可能只是資料沒到齊,不等於沒有風險」',
       /一條都沒亮/.test(zeroCase.one) && /不等於沒有風險/.test(zeroCase.one), txt(zeroCase.one));
} else {
    console.log('   ⏭️ 今天掃的這幾檔都沒有「一邊掛零」的情況 → 該情境改由下面的原始碼守門把關');
}
if (anyCase && !anyCase.low) {
    ok('⑤ ⭐ 判方向時要把命中數寫進結論(⛔ 別只留一個 100%)',
       new RegExp(`命中 ${anyCase.hits} 條`).test(txt(anyCase.one)) || /四面向同步攻擊/.test(anyCase.one), txt(anyCase.one));
    // 同一檔強制主結論空頭 → 多方指令必須收掉,但**方向判定本身不動**
    if (anyCase.verdict === '多方優勢') {
        const BB = await scanOf(anyCase.sym, 'bear');
        ok('⑤ ⭐⛔ 主結論空頭時不可下多方指令(講反話第 8 處)',
           !/可順勢操作|可放心做多/.test(BB.one), txt(BB.one));
        ok('⑤ ⭐ 空頭時改講「當反彈看待、別加碼」,但 verdict 本身不動(事實不竄改)',
           /別加碼/.test(BB.one) && BB.verdict === anyCase.verdict, `${BB.verdict} vs ${anyCase.verdict}｜${txt(BB.one)}`);
    }
}
await bbPage.close();

const bbSrc = await page.evaluate(() => app._calcBullBearScan.toString());
ok('⑤ ⭐⛔ 空頭判斷一律走 `_bearGate`(⛔ 別自己寫一份判斷式)', /_bearGate\?\.\(sym\)/.test(bbSrc), '');
ok('⑤ ⭐⛔ 原始碼要有「一邊掛零」的提醒(⛔ 這條不可因為今天剛好沒命中就被刪掉)',
   /const _zero = \(bullCount === 0 \|\| bearCount === 0\)/.test(bbSrc) && /不等於沒有風險/.test(bbSrc),
   (bbSrc.match(/const _zero = [^\n]*/) || [''])[0]);
ok('⑤ ⭐ 「可順勢操作」要同時滿足「四面向多數」與「命中夠多」',
   /top\.length >= 3 && hits >= STRONG_HITS/.test(bbSrc), (bbSrc.match(/top\.length >= 3[^\n]*/) || [''])[0]);
ok('⑤ ⭐⛔ 空方(風險)那側不加樣本門檻 —— 多空不對稱,寧可多提醒',
   /bad\.length >= 3 \? '多面向警訊齊發/.test(bbSrc) && !/bad\.length >= 3 && hits/.test(bbSrc), '');
const rendSrc = await page.evaluate(() => app._renderBullBearCardSync.toString());
// ⚠️ V72.5.5 起分母改成 `scan.rulesN`(實跑 29 條,⛔ 不再寫死 28)→ 這裡也不可寫死數字,
//    否則規則一增減測試就假失敗(同 V72.1.8「測試不可綁死會浮動的資料狀態」)。
ok('⑤ ⭐ 百分比旁一定要同時顯示「命中 N/總數」(⛔ 100% 不可孤零零出現)',
   /多方 \$\{pct\}%<\/span><span[^>]*>\(命中 \$\{scan\.hits\}\/\$\{scan\.rulesN[^}]*\}\)/.test(rendSrc),
   (rendSrc.match(/多方 \$\{pct\}%[^\n]{0,160}/) || [''])[0]);


// ══ ⑥ ⭐主打 的星星本身也要樣本夠(V72.2.4)═══════════════════
//   實測 2603:「🌅 晨星轉折 ⭐主打 勝率 100% ・3 次」—— 旁邊雖然有 ⏳ 徽章,
//   但那顆星的視覺份量壓過一切,使用者只會看到「主打」。⛔ 不刪那一列,只是拿掉星。
const S3 = txt(await play(3, 'flat'));
ok('⑥ ⭐⛔ 只有 3 次不可掛 ⭐主打', !/⭐主打/.test(S3), S3.slice(0, 300));
ok('⑥ ⭐ 改標「⏳樣本不足」(⛔ 不可整列刪掉,資料照顯示)',
   /⏳樣本不足/.test(S3) && /測試型態/.test(S3), S3.slice(0, 300));
const S20 = txt(await play(20, 'flat'));
ok('⑥ ⭐ 樣本夠就照掛 ⭐主打(⛔ 別矯枉過正)', /⭐主打/.test(S20), S20.slice(0, 300));
const firedSrc = await page.evaluate(() => {
    for (const k of Object.keys(app)) {
        if (typeof app[k] === 'function' && /⭐主打<\/span>/.test(app[k].toString()) && /animate-pulse/.test(app[k].toString())) return app[k].toString();
    }
    return '';
});
ok('⑥ 另一處會閃爍的 ⭐主打 也要接上樣本門檻',
   /top3\.has\(r\.key\) && r\.expectancy > 0 && this\._wrEnough\(r\.count\)/.test(firedSrc),
   (firedSrc.match(/const isStar = [^\n]*/) || [''])[0]);

// ⑦ 當沖儀表板:「距 0.0%」= 已經鎖住了,不可跟「還差 0.0%」長一樣
const dtSrc = await page.evaluate(() => {
    for (const k of Object.keys(app)) {
        if (typeof app[k] === 'function' && /🔺 漲停/.test(app[k].toString())) return app[k].toString();
    }
    return '';
});
ok('⑦ 找得到當沖儀表板三格', dtSrc.length > 0, '');
ok('⑦ ⭐ 距離 ≈0 時要明寫「已鎖漲停/已鎖跌停」(⛔ 別只顯「距0.0%」)',
   /已鎖\$\{word\}/.test(dtSrc) && /d <= 0\.05/.test(dtSrc), (dtSrc.match(/const _lim = [^\n]*/) || [''])[0]);


// ══ ⑨ ⭐⭐ 全檔盤點:每一個「勝率 X%」的呼叫端都要有樣本門檻(陷阱 #37)══
//   V72.2.2 說「已經接上了」,V72.2.4 又漏一處(⭐主打 的星),V72.2.5 再漏四處
//   —— 其中最嚴重的是**多空訊號仲裁**:它拿「本股回測勝率」裁決要不要「以偏多為主」,
//      卻**完全沒有樣本門檻**(打過 1 次的型態也算)。
//   ⭐ 所以這裡改成**盤點式**斷言:把所有相關函式抓出來,逐一確認有 `_wrEnough`。
//     ⛔ 不是驗某一處,是驗「沒有漏網的」—— 這才擋得住下一次又漏。
const audit = await page.evaluate(() => {
    const need = {
        // 函式判別特徵 → 用途說明(找不到就算失敗,代表函式被改名了要更新這份清單)
        '以偏多為主': '多空訊號仲裁',
        '⚡買點 ': '清單列的閃爍買點 badge',
        '平常就盯這幾招': '「這檔的專屬招」',
        '最吃 <b class="text-red-300">': '個股 DNA 一句話',
        '等訊號:主打': '打法雷達「要等哪個訊號」',
    };
    const out = {};
    for (const [mark, desc] of Object.entries(need)) {
        let found = null;
        for (const k of Object.keys(app)) {
            if (typeof app[k] !== 'function') continue;
            const src = app[k].toString();
            if (src.includes(mark)) { found = { fn: k, ok: /_wrEnough\(/.test(src) }; break; }
        }
        out[desc] = found;
    }
    return out;
});
for (const [desc, r] of Object.entries(audit)) {
    ok(`⑨ ⭐ 「${desc}」找得到,而且有樣本門檻 _wrEnough`, !!(r && r.ok),
       r ? `在 ${r.fn} 找到但沒有 _wrEnough` : '整個函式找不到(是不是改名了?清單要更新)');
}
// ⭐ 打法雷達要「優先挑樣本夠的」,真的都不夠才退回第一名並明講
const radarSrc = await page.evaluate(() => {
    for (const k of Object.keys(app)) {
        if (typeof app[k] === 'function' && app[k].toString().includes('等訊號:主打')) return app[k].toString();
    }
    return '';
});
ok('⑨ ⭐ 打法雷達要優先挑「樣本夠」的當主打',
   /tops\.find\(r => this\._wrEnough\(r\.count\)\) \|\| tops\[0\]/.test(radarSrc), '');
ok('⑨ ⭐ 退回樣本不足的那個時,要明講「先別把它當依據」+ 指出回測頁也這樣標(⛔ 兩頁不可各說各話)',
   /先別把它當依據/.test(radarSrc) && /回測頁同一列也標/.test(radarSrc), '');

ok('⑩ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ WRSAMPLE_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ WRSAMPLE_TEST_PASS');
