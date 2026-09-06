#!/usr/bin/env node
/**
 * 🔍 V74.7.6 實測總表:搜尋 + 主題歸納 + 標題分層
 *
 * 使用者:「實測總表裡面可以重新歸納嗎?還有裡面很多贅詞,還有有能搜尋內容的搜尋框」。
 * ⛔ 四條鐵則:
 *  ① 🚨 **一個字都不准刪** —— 那些數字與限制是決策紀錄。「贅詞」用**版面層級**解決
 *     (標題破折號後半降成小字副標),⛔ 不是砍掉。
 *  ② 🔍 搜尋**跨全部判定欄**,而且要標出「這條原本在哪一欄」。
 *  ③ 📌 主題是**橫切標籤**,⛔ 不取代既有的判定分類(有用/沒用/坑/測不了)。
 *  ④ 找不到 → 誠實說 + 給可以直接按的建議,⛔ 不可留白。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── ⓪ LAB_TABS ⛔ 不可有空洞(多一個逗號 → for...of 會產出 undefined 而炸掉) ──
{
    const i = SRC.indexOf('  LAB_TABS: ['), j = SRC.indexOf('\n  ],', i);
    let arr = null;
    try { arr = new Function('return ' + SRC.slice(i + 12, j + 4))(); } catch (_) {}
    // 🚨🚨 注入驗證抓到:第一版用 `arr.some(x => x === undefined)` —— **`.some()` 也會跳過空洞**,
    //   等於用「會跳過空洞的方法」去檢查空洞 → 塞回空洞照樣綠。
    //   ⭐ 正解:`arr.length !== Object.keys(arr).length`(空洞不會出現在 keys 裡)。
    const holes = !!arr && arr.length !== Object.keys(arr).length;
    ok('⓪ 🚨 LAB_TABS ⛔ 不可有空洞(`.map()`/`.some()` 都會跳過、`for...of` 不會 → 直接炸)',
       !!arr && arr.length > 0 && !holes, arr ? `len=${arr.length} keys=${Object.keys(arr).length}` : 'parse fail');
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const perr = [];
page.on('pageerror', e => perr.push(e.message.slice(0, 160)));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const P = window.PRO;
    P.switchTab('lab'); await new Promise(r => setTimeout(r, 900));
    const n = () => document.querySelectorAll('#labList .labitem').length;
    const o = {};
    // 總條數(⛔ 一個字都不准刪 → 這個數字是守門)
    o.total = P.LAB_TABS.reduce((a, t) => a + ((P.LAB[t[0]] || []).length), 0);
    o.base = n();
    o.rankBase = document.querySelectorAll('#labList .lrank').length;
    o.topics = [...document.querySelectorAll('#labTopics .tpc')].map(e => e.textContent.trim());
    // 🔍 搜尋
    P.labSearch('分點'); await new Promise(r => setTimeout(r, 400));
    o.q = n(); o.marks = document.querySelectorAll('#labList mark').length;
    o.from = document.querySelectorAll('#labList .labfrom').length;
    o.rankQ = document.querySelectorAll('#labList .lrank').length;
    o.qCols = new Set([...document.querySelectorAll('#labList .labitem')].map(e => e.className)).size;
    // 找不到
    P.labSearch('zzz不可能存在zzz'); await new Promise(r => setTimeout(r, 300));
    o.none = (document.getElementById('labList').innerText || '');
    o.noneBtns = document.querySelectorAll('#labList .tpc').length;
    // 📌 主題
    P.labSearch(''); await new Promise(r => setTimeout(r, 300));
    P.labTopic('exit'); await new Promise(r => setTimeout(r, 300));
    o.topic = n(); o.topicFrom = document.querySelectorAll('#labList .labfrom').length;
    P.labTopic(''); await new Promise(r => setTimeout(r, 300));
    o.back = n();
    // 🧹 標題分層:主標 + 副標拼回來必須**等於原標題**(⛔ 一個字都沒刪)
    const bad = [];
    for (const t of P.LAB_TABS) for (const it of (P.LAB[t[0]] || [])) {
        const T = P._labTitle(it.t);
        const joined = T.b ? `${T.a} —— ${T.b}` : T.a;
        if (joined !== it.t) bad.push(it.t.slice(0, 40));
    }
    o.titleLossless = bad.length === 0; o.badTitles = bad.slice(0, 3);
    o.subs = document.querySelectorAll('#labList .lsub').length;
    return o;
});
await browser.close();

ok('⓪b 沒有 pageerror', perr.length === 0, perr.join('|'));
ok('⓪c 空過守門:實測總表真的有東西', R.base > 10 && R.total > 100, `base=${R.base} total=${R.total}`);

// ── ① 一個字都不准刪 ──
ok('① 🚨 標題分層必須**無損**(主標 + 副標拼回來 = 原標題,⛔ 不可砍字)',
   R.titleLossless, R.badTitles.join(' | '));
ok('①b ⭐ 而且真的有分層(⛔ 全部都沒副標 = 這個功能等於沒做)', R.subs > 0, `subs=${R.subs}`);

// ── ② 搜尋 ──
ok('② 🔍 搜尋要**跨全部判定欄**(⛔ 只搜當前欄等於沒解決「168 條找不到」)',
   R.q > 0 && R.qCols > 1, `hits=${R.q} 欄種類=${R.qCols}`);
ok('②b ⭐ 每一條要標它原本在哪一欄(⛔ 跨欄混在一起會看不出判定)',
   R.from === R.q, `from=${R.from} hits=${R.q}`);
ok('②c 命中處要高亮', R.marks > 0, `marks=${R.marks}`);
ok('②d 🚨 搜尋時 ⛔ 不可再標名次(跨欄混合,名次沒有意義)',
   R.rankQ === 0 && R.rankBase > 0, `rankQ=${R.rankQ} rankBase=${R.rankBase}`);
ok('②e ⛔ 找不到 ≠ 留白 —— 要說清楚查了什麼 + 幾條紀錄',
   /找不到符合的紀錄/.test(R.none) && /168|\d{3}\s*條實測紀錄/.test(R.none), R.none.slice(0, 120));
ok('②f ⭐ 而且要給**可以直接按**的建議(⛔ 不是叫人自己想關鍵字)', R.noneBtns >= 4, `btns=${R.noneBtns}`);

// ── ③ 主題 ──
ok('③ 📌 主題列要算得出來而且不留空按鈕', R.topics.length >= 5, R.topics.join(','));
ok('③b 主題篩要真的篩(⛔ 篩完等於全部 = 沒作用)',
   R.topic > 0 && R.topic < R.total && R.topicFrom === R.topic, `topic=${R.topic}/${R.total}`);
ok('③c 取消主題要回得去', R.back === R.base, `${R.back} vs ${R.base}`);
ok('③d ⭐ 主題是**橫切**,⛔ 不可取代判定分類 —— 篩主題時每條仍要標原本的欄位',
   R.topicFrom === R.topic);

console.log(fails ? `\n❌ LABSEARCH_FAIL(${fails})` : '\n✅ LABSEARCH_PASS(全部通過)');
process.exit(fails ? 1 : 0);
