#!/usr/bin/env node
/**
 * 🏔️🕳️ V74.6.0 兩個「六關全過但一直沒接上通知」的型態(streak_probe.mjs,含 2022 空頭)
 *   使用者:「我有這麼多指數有沒有都加入在當今天發生什麼狀況的時候就會跳出來,
 *            然後告訴我會發生什麼事還有可能會有幾% 勝率」
 *   ⭐ 答案不是「全部加進去」(48 個經典指標六關 0 過,加了會把真訊號淹掉),
 *     而是「把**已經六關全過、卻沒接上通知**的補上」—— 查了一遍剛好有兩個。
 *
 * ⛔ 五條釘死:
 *  ① 數字一律讀 `_STREAK_EDGE`,⛔ 不可寫死(換一份假表,畫面要跟著變)
 *  ② 🚨 勝率旁邊一定要寫基準 41.1%(⛔ 不是 50%)
 *  ③ 🚨 一定要寫「扣成本後只剩多少」(不寫就變成在推薦重壓)
 *  ④ ⛔ 空頭(`_bearGate`)不顯示 —— 它們講的是偏多的事
 *  ⑤ ⛔ 不給買賣價位、不下進場指令(單一劇本原則)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import fs from 'fs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, x) => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + JSON.stringify(x ?? ''))); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
// ⚠️ 沙箱連不到 CDN → echarts 未載入是**環境限制**不是 App bug(其他測試同樣處置)
page.on('pageerror', e => { if (!/echarts is not defined/.test(String(e))) errs.push(String(e)); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && app._STREAK_EDGE, null, { timeout: 30000 });

// 🧪 造兩組**剛好命中**的測資(⛔ 測資自己要先驗一遍,別讓斷言去猜實際輸出)
const R = await page.evaluate(() => {
    const mk = (arr) => arr.map((x, i) => ({ date: '2026-0' + (1 + i % 9) + '-01', open: x.o, high: x.h, low: x.l, close: x.c, volume: 1000 }));
    // ── 🏔️ 回測不破:前 60 根爬到 100,最近 5 根回檔但沒破 95,今天收紅站回 ──
    // ⭐ 測資自己先算過一遍(⛔ 別讓斷言去猜):
    //   nh = 更早 60 根(i-65..i-6)的最高收盤 = 100;新高必須落在**最近 5 根(不含今天)**裡
    const A = [];
    for (let i = 0; i < 254; i++) A.push({ o: 60 + i * (40 / 253), h: 60 + i * (40 / 253) + .5, l: 60 + i * (40 / 253) - .5, c: 60 + i * (40 / 253) });
    A.push({ o: 100, h: 103.5, l: 100, c: 103 });                   // 254:創新高(≥ nh=100)
    for (let k = 0; k < 4; k++) A.push({ o: 99, h: 100, l: 98.5, c: 99 });  // 255~258:回檔但低點 98.5 ≥ 100×0.95
    A.push({ o: 99, h: 101.5, l: 98.8, c: 101 });                   // 259(今天):收紅且 ≥ 100×0.98
    // ── 🕳️ 向上跳空 × 高位階:一路走高(位階 100),今天低點 > 昨高 且缺口 ≥1% ──
    const B = [];
    for (let i = 0; i < 260; i++) { const c = 50 + i * 0.2; B.push({ o: c, h: c * 1.005, l: c * 0.995, c }); }
    const yh = B[B.length - 2].h;
    B[B.length - 1] = { o: yh * 1.02, h: yh * 1.05, l: yh * 1.02, c: yh * 1.04 };
    const run = (rows, bear) => {
        app._ovTrend = bear ? { sym: 'TEST', trend: 'bear', txt: '' } : null;
        app._exitMode = null;
        return (app._ovNewEdges(mk(rows), 'TEST') || []).map(x => x.ic + '|' + x.txt);
    };
    const out = { A: run(A, false), B: run(B, false), Abear: run(A, true), Bbear: run(B, true) };
    // ①的驗證:換一份假表,畫面要跟著變
    const real = JSON.parse(JSON.stringify(app._STREAK_EDGE));
    app._STREAK_EDGE = { base: 99.9, cost: 7.77, yrs: '1999~2000',
        retest: { n: 12345, e10: 8.88, wr: 66.6, worst: 1, net: 5.55, yr: '+9/+9' },
        gapHi: { n: 54321, e10: 7.77, wr: 55.5, worst: 1, net: 4.44, yr: '+8/+8' } };
    out.fakeA = run(A, false); out.fakeB = run(B, false);
    app._STREAK_EDGE = real;
    return out;
});
await browser.close();

const a = R.A.join(' '), b = R.B.join(' ');
ok('① 🏔️「創60日高後回測不破」今天命中就要跳出來', /🏔️/.test(a), R.A.length ? R.A[0].slice(0, 60) : R.A);
// 🗑️ V78.4.7:「向上跳空 × 高位階」16 年重跑沒過(前半段為負、扣成本為負)→ 下架;決定性對照:同一份會命中的 K 線,⛔ 不可再出現
ok('② 🗑️ 🕳️「向上跳空 × 高位階」已下架,命中的 K 線也⛔ 不可再跳出來', !/🕳️/.test(b), R.B.length ? R.B[0].slice(0, 60) : R.B);
// 🧹 V78.3.4 使用者:「散戶 App 不放實測數字」→ 決定性對照反過來:換假表,畫面⛔ 不可出現表裡的數字;
//   基準勝率 / 扣成本 / 個百分點 這些研究數字一律在產業作戰室
ok('③ 🧹 換假表,畫面⛔ 不可出現表裡的數字', !/8\.88|7\.77|66\.6|55\.5/.test(R.fakeA.join(' ') + R.fakeB.join(' ')), [R.fakeA.length, R.fakeB.length]);
ok('④ 🧹 ⛔ 不印基準勝率 / 次數', !/41\.1%|基準|次實測/.test(a + b));
ok('⑤ 🧹 仍要說「不是叫你重壓 / 不是進場指令」(⛔ 不印扣成本後的數字)', /不是叫你重壓|不是進場指令/.test(a) && !/0\.29|0\.19|實測/.test(a + b));
ok('⑥ ⛔ 空頭時兩個都不可顯示(`_bearGate` 鐵則)',
   !/🏔️/.test(R.Abear.join(' ')) && !/🕳️/.test(R.Bbear.join(' ')), [R.Abear.length, R.Bbear.length]);
ok('⑦ ⛔ 不可給買賣價位 / 不可下進場指令(單一劇本原則)',
   !/(掛單|買進價|進場價|目標價|停損價)/.test(a + b) && /(不是進場指令|不是叫你重壓|以總覽)/.test(a + b),
   (`${a} ${b}`.match(/掛單|買進價|進場價|目標價|停損價/) || [])[0]);
ok('⑧ 🗑️ 跳空那條⛔ 不可復活(原始碼不可再有 gap_hi)', !/['"]gap_hi['"]/.test(SRC.replace(/^\s*\/\/.*$/gm, '')));
// 🚧 空過守門:定義要跟探針一字不差 → 原始碼裡要出現那幾個關鍵門檻
// ⚠️ 錨點用**定義**(`    _ovNewEdges(data, sym) {`)⛔ 不用呼叫字串 —— V77.5.2 新增的 `_ovFoldEdgesHtml` 先呼叫
//    `_ovTopEdge(data, sym)` 再呼叫 `_ovNewEdges(data, sym)` → 用呼叫字串切會切到空字串(假紅燈;反過來也可能是假綠燈)
const _i0 = SRC.indexOf('    _ovNewEdges(data, sym) {');
const fn = SRC.slice(_i0, SRC.indexOf('    _ovTopEdge(data, sym) {', _i0) > 0 ? SRC.indexOf('    _ovTopEdge(data, sym) {', _i0) : _i0 + 8000);
ok('⑨ 🚧 定義要跟 streak_probe 一字不差(0.95 / 0.98)',
   /0\.95/.test(fn) && /0\.98/.test(fn));
ok('⑩ 載入無 pageerror', errs.length === 0, errs.join(' | '));
console.log();
// ⏱️ V74.8.7:這兩個實測**沒有反應時點**(前 5 天只走完 7% / 2%)→ 文案要說出來
ok('⑪ ⏱️ 🏔️ 要寫「慢慢漂、別期待幾天內表態」(🧹 ⛔ 不印前 5 天比例)', /慢慢漂/.test(a) && /別期待/.test(a) && !/前 5 天只走完/.test(a));
// ⚠️ 這時 browser 已關 → 直接從原始碼讀(⛔ 不可再 page.evaluate)
const _r5 = k => { const m = SRC.match(new RegExp(k + ':\\s*\\{[^}]*r5:\\s*(\\d+)')); return m ? +m[1] : NaN; };
ok('⑪b 常數要真的有 r5 這一欄(⛔ 不可只改文案不改資料)',
    Number.isFinite(_r5('retest')) && _r5('retest') < 25 && !/gapHi:/.test(SRC),
    `retest.r5=${_r5('retest')}`);

console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ STREAKEDGE_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
