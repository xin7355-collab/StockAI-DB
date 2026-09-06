#!/usr/bin/env node
/**
 * 🚨 V74.7.2 「圖表元件載不到 → 整個總覽空白」的守門
 *
 * 使用者 2026-09-05 07:01 截圖(4G・電量 15%):個股頁價格顯示「--」、卡在「讀取中…」,
 * 而 A/B/C/D 四個 Block **整區空白**,畫面上零錯誤訊息;同一時間庫存頁卻是正常的。
 *
 * ⭐⭐ 真因鏈(⛔ 不是資料壞掉):
 *   圖表函式庫(CDN)載不到 → `init()` 在 `echarts.init` 那行 throw
 *   → 後面的 `masterWorker.onmessage` 綁定**沒跑到** → `this.indicators` 永遠是空
 *   → `refreshStrategy` 第一行 `if (!this.indicators.ma20) return`(靜默 return,陷阱 #4)
 *   → 總覽整區空白。
 *
 * ⭐ 這個沙箱**天生連不到 CDN**,所以它就是那個情境的天然重現環境 —— ⛔ 別 stub echarts。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── ① worker 訊息綁定必須在 init() 外面 ──
const initStart = SRC.indexOf('    async init() {');
// ⚠️ ⛔ 不可用 `indexOf('masterWorker.onmessage')` —— **說明這個 bug 的註解裡就有那串字**,
//   會讓「刪掉真正的綁定」照樣通過(實測踩過,本專案第 13 次踩同一個坑)。
//   → 只認**行首、沒有縮排**的真賦值(縮排的 = 在 init() 裡面)。
const wLines = SRC.split('\n');
const wAt = wLines.findIndex(l => /^masterWorker\.onmessage\s*=/.test(l));
const wIdx = wAt < 0 ? -1 : SRC.split('\n').slice(0, wAt).join('\n').length;
ok('①⓪ 空過守門:真的找得到那個綁定(⛔ 找不到的話下一條等於沒驗)', wAt >= 0);
ok('① 🚨 masterWorker.onmessage 綁定必須在 init() **之前**(⛔ 掛在會 throw 的初始化鏈後面 = 整個 App 沒有指標)',
   wIdx > 0 && initStart > 0 && wIdx < initStart, `onmessage@${wIdx} init@${initStart}`);
ok('①b ⛔ init() 裡面不可以再綁一次(兩份會讓上面那條假通過)',
   !/^\s+masterWorker\.onmessage\s*=/m.test(SRC));

// ── ② echarts.init 必須包起來 ──
const eIdx = SRC.indexOf("echarts.init(document.getElementById('mainChart')");
const before = SRC.slice(Math.max(0, eIdx - 400), eIdx);
ok('② 🚨 `echarts.init` ⛔ 不可裸呼叫(要 try/catch + no-op 空殼,否則後面的初始化全部陪葬)',
   eIdx > 0 && /try\s*\{[^}]*$/.test(before), before.slice(-120));
ok('②b 失敗時要記旗標 `_chartDead`(⛔ 靜默降級 = 使用者不知道圖為什麼不見)',
   /_chartDead\s*=\s*true/.test(SRC));

// ── ③ refreshStrategy ⛔ 不可再靜默 return ──
const rsIdx = SRC.indexOf('    refreshStrategy() {');
const rsHead = SRC.slice(rsIdx, rsIdx + 700);
ok('③ refreshStrategy 早退時要呼叫 `_ovWaitNotice`(⛔ 靜默 return = 空白畫面,陷阱 #4)',
   /!this\.indicators\.ma20[\s\S]{0,260}_ovWaitNotice/.test(rsHead), rsHead.slice(0, 260));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const out = {};
    out.echartsMissing = (typeof echarts === 'undefined');   // ⭐ 空過守門:確認真的重現了「載不到」
    A.switchAppTab && A.switchAppTab('diag');
    await A.analyze('2327');
    await new Promise(r => setTimeout(r, 3000));
    out.hasMa20 = !!(A.indicators && A.indicators.ma20);
    const el = () => document.getElementById('ovCommandCenter');
    out.ovLen = (el().innerHTML || '').length;
    out.ovTxt = (el().innerText || '').slice(0, 200);
    // ④ 指標還沒回來時的佔位(⭐ 直接把 indicators 清掉重現)
    // ⚠️ 這個沙箱的 `_chartDead` 天生就是 true(真的載不到)→ 要先關掉才驗得到「還在算」那一種
    const keep = A.indicators, keepDead = A._chartDead;
    A._chartDead = false;
    A.indicators = {}; el().innerHTML = '';
    A.refreshStrategy();
    out.waitTxt = (el().innerText || '').slice(0, 160);
    // ⑤ 圖表壞掉那一種要講不一樣的話
    A._chartDead = true; el().innerHTML = '';
    A.refreshStrategy();
    out.deadTxt = (el().innerText || '').slice(0, 200);
    A._chartDead = keepDead; A.indicators = keep;
    return out;
});
await browser.close();

ok('⓪ 空過守門:這個環境真的載不到圖表元件(⛔ 載得到的話下面那條等於沒驗)', R.echartsMissing);
ok('④ 🚨🚨 圖表元件載不到時,總覽仍要算得出指標並畫出內容(⛔ 這正是使用者截圖的空白畫面)',
   R.hasMa20 && R.ovLen > 500, `hasMa20=${R.hasMa20} len=${R.ovLen}`);
ok('④b 而且要真的是「現在該做什麼」不是佔位', /現在該做什麼|要注意的事|系統怎麼判/.test(R.ovTxt), R.ovTxt);
ok('⑤ 指標還沒算好 → 要說「正在計算」(⛔ 不可留白)', /正在計算技術指標/.test(R.waitTxt), R.waitTxt);
ok('⑥ 🚨 圖表元件掛掉 → 要說的是**不一樣的話**(重整才會好,⛔ 不可叫人乾等)',
   /圖表元件沒有載入成功/.test(R.deadTxt) && /重新整理/.test(R.deadTxt), R.deadTxt);
ok('⑥b ⭐ 而且要講明「不是你的資料壞掉」(⛔ 使用者第一反應會以為是資料問題)',
   /不是你的資料壞掉/.test(R.deadTxt), R.deadTxt);

console.log(fails ? `\n❌ INITCHAIN_FAIL(${fails})` : '\n✅ INITCHAIN_PASS(全部通過)');
process.exit(fails ? 1 : 0);
