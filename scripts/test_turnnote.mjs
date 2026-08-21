#!/usr/bin/env node
/**
 * 🔄 週轉率實測提醒 `_scrTurnNote`(V73.8.2)測試
 *
 * 使用者:「高周轉率有沒有參考價值」→ 實測第三次:**沒有獨立的參考價值**。
 * 但選股頁本來就有「5 日週轉率 > 10%」這個條件,旁邊**一個實測數字都沒有**
 * → 使用者勾了會以為是驗證過的做法。依 `_SIGNAL_EDGE` 對 C 級的處置:
 * **條件照留、資料照顯示,但要誠實標成績**。
 *
 * ⛔ 這支要釘死的六件事:
 *   ① **條件觸發**:⛔ 沒用週轉率排序、也沒勾週轉率條件時,整條不可出現(不留空殼)。
 *   ② 用週轉率排序 **或** 勾任一週轉率條件 → 要出現。
 *   ③ 🚨 **必須寫出「前後半段不同向」** —— 只列 +1.68pp 會讓人以為高週轉有效。
 *   ④ 🚨 **必須寫出「疊在高位階+高波動之上增量幾乎歸零」**(V73.2.5 的重點)。
 *   ⑤ ⛔ **不可下操作指令**(不可出現「可以買/進場/追」),它只是提醒不是訊號。
 *   ⑥ ⛔ **不可用紅綠**:講的是「有沒有用」不是漲跌(燈號鐵則)。
 *   ⑦ 顯示的數字必須**來自 `_SCR_TURN_EDGE`**,⛔ 不可在文案裡寫死第二份(陷阱 #37)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._scrTurnNote, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const out = {};
    const save = app._scrSort;
    app._scrSort = 'score';
    out.none = app._scrTurnNote([]);                                   // 沒排序沒勾 → 空
    out.other = app._scrTurnNote([{ id: 'pe15' }]);                    // 勾別的條件 → 空
    out.hi = app._scrTurnNote([{ id: 'turn5hi' }]);
    out.lo = app._scrTurnNote([{ id: 'turn5lo' }]);
    app._scrSort = 'turn5';
    out.bySort = app._scrTurnNote([]);                                 // 只用排序 → 要出現
    app._scrSort = save;
    out.E = app._SCR_TURN_EDGE;
    return out;
});
await browser.close();

const strip = s => String(s).replace(/⛔[^<。]*/g, '').replace(/別把它當成[^<。]*/g, '');

// ① 條件觸發
ok('① 沒用週轉率排序也沒勾 → ⛔ 整條不出現(不留空殼)', R.none === '', R.none.slice(0, 80));
ok('①b 勾的是別的條件 → 也不出現', R.other === '', R.other.slice(0, 80));
// ②
ok('② 勾「高週轉」→ 出現', R.hi.length > 200);
ok('②b 勾「排除冷門」→ 出現', R.lo.length > 200);
ok('②c 只用週轉率排序 → 也要出現(⛔ 別只綁條件)', R.bySort.length > 200);

// ③ 前後半不同向必須寫出來
// ⚠️ 這條第一版寫成 `/前後半段.{0,6}不同向|前半.{0,40}後半/` —— **太鬆**:
//    把警告句拿掉之後,第二個 alternative 還是會在別處配到 → 注入缺陷時測試照樣綠。
//    ⭐ 那正是「注入已知缺陷」自我驗證擋下來的;釘就要釘**那個關鍵字本身**。
ok('③ 🚨 要寫出「不同向」這個關鍵警告(⛔ 只列漂亮數字會誤導)',
    R.hi.includes('不同向') && /只存在於|只在.{0,8}這一段/.test(R.hi), R.hi.slice(0, 220));
ok('③b 而且要把前半那個負數印出來',
    R.hi.includes(String(R.E.h1.a820)) || R.hi.includes(R.E.h1.a820.toFixed(2)), '');

// ④ 增量歸零
ok('④ 🚨 要寫出「疊在高位階+高波動之上增量幾乎歸零」',
    /高位階.{0,6}高波動/.test(R.hi) && /增量/.test(R.hi), R.hi.slice(0, 200));
ok('④b 要提到來回成本', R.hi.includes(String(R.E.cost)));

// ⑤ 不可下操作指令
const CMD = /(可以買|可以追|建議買|進場價|掛單|停損|可進場|值得買)/;
ok('⑤ ⛔ 不可下操作指令', !CMD.test(strip(R.hi)) && !CMD.test(strip(R.lo)), (strip(R.hi).match(CMD) || [''])[0]);

// ⑥ 不可用紅綠(燈號鐵則)
const RG = /text-(red|green)-\d/;
ok('⑥ ⛔ 不可用紅綠上色(講的是有沒有用,不是漲跌)', !RG.test(R.hi) && !RG.test(R.lo), (R.hi.match(RG) || [''])[0]);

// ⑦ 數字來自常數
ok('⑦ 顯示的數字來自 _SCR_TURN_EDGE(⛔ 不可在文案寫死第二份)',
    R.hi.includes(R.E.n.toLocaleString()) && R.hi.includes(String(R.E.d.a820)), '');
ok('⑦b ⭐ 要指路「唯一有效的用法在當沖頁」', /當沖頁/.test(R.hi) && /只有次日/.test(R.hi));
ok('⑦c 要標明窗口偏多頭的限制', /偏多頭/.test(R.hi));

// 靜態:⛔ 不可有第二份寫死的成績表
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('⑦d _SCR_TURN_EDGE 只定義一次', (src.match(/_SCR_TURN_EDGE:\s*\{/g) || []).length === 1);
ok('⑧ 已接進選股結果渲染(⛔ 定義了卻沒接上等於沒做,陷阱 #37)',
    /_scrValNote\(conds\)\s*\+\s*this\._scrTurnNote\(conds\)/.test(src));
ok('⑨ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ TURNNOTE_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
