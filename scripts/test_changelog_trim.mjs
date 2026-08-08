#!/usr/bin/env node
/**
 * 📚 `_CHANGELOG` 瘦身守門(V72.1.8)
 *
 * 背景:App 內的更新紀錄累積到 **343 筆 / 147 KB**,佔 index.html 的 5.1%,
 *      每次開 App 都要下載,而使用者實際上不會往回翻 300 版。
 *      → 只留最近 60 筆,更早的**完整封存在 CHANGELOG.md**(一個字都沒刪)。
 *      同 V69.8.7 把第 18 行歷史搬出去的做法。
 *
 * ⛔ 這支釘住三件事:
 *   ① 筆數不可再無限膨脹(超過門檻就該再搬一次)
 *   ② ⭐ **搬走的內容必須真的在 CHANGELOG.md 裡** —— 否則就是「刪資料」不是「搬移」
 *   ③ 跳窗要指路,⛔ 別讓使用者以為舊紀錄被刪了
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && Array.isArray(app._CHANGELOG), null, { timeout: 20000 });

const cl = await page.evaluate(() => app._CHANGELOG.map(e => ({ v: e.v, dt: e.dt, t: e.t, n: (e.d || []).length })));
const md = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');

// ── ① 筆數守門 ─────────────────────────────────────────────
ok('① App 內筆數不可膨脹(≤ 80 筆,超過就該再搬一次)', cl.length <= 80, `目前 ${cl.length} 筆`);
ok('① 至少要留得夠看(≥ 20 筆)', cl.length >= 20, `目前 ${cl.length} 筆`);

// ── ② ⭐ 最關鍵:搬走的必須真的在 CHANGELOG.md 裡(是搬移不是刪除)──
const oldest = cl[cl.length - 1].v;
ok('② App 內最舊那筆之前的版本,必須能在 CHANGELOG.md 找到',
   /封存第二批/.test(md), 'CHANGELOG.md 沒有「封存第二批」區塊');
// 抽驗幾個已搬走的版本號真的在封存檔裡
for (const v of ['V71.5.6', 'V70.0.0', 'V69.0.0', 'V68.0.0']) {
    if (cl.some(e => e.v === v)) continue;   // 還在 App 內就不用驗
    ok(`② ⭐ 已搬走的 ${v} 必須在 CHANGELOG.md 裡(⛔ 不可是刪掉)`,
       md.includes(v), `CHANGELOG.md 找不到 ${v}`);
}
const archivedCount = (md.match(/^### V/gm) || []).length;
ok('② 封存檔的版本數要合理(≥ 200 筆)', archivedCount >= 200, `目前 ${archivedCount} 筆`);

// ── ③ 跳窗要指路(⛔ 別讓使用者以為紀錄被刪了)──────────────
const modalHtml = await page.evaluate(() => {
    try { app._showUpdateLog(); } catch (_) {}
    const b = document.getElementById('updateLogBody');
    return b ? b.innerHTML : '';
});
const mt = String(modalHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
ok('③ ⭐ 跳窗要說明「只顯示最近 N 個版本」', /這裡顯示最近\s*\d+\s*個版本/.test(mt), mt.slice(-320));
ok('③ ⭐⛔ 要明說「完整保存在雲端紀錄檔、一個字都沒刪」',
   /完整保存在 ?雲端紀錄檔/.test(mt) && /一個字都沒刪/.test(mt), mt.slice(-320));
ok('③ 要給得到檔案位置', /CHANGELOG\.md/.test(mt), mt.slice(-320));
ok('③ 要交代為什麼這樣做(省下載)', /少下載/.test(mt), mt.slice(-320));

// ── ④ 版本號一致性:最新那筆要等於 _APP_VERSION ────────────────
const ver = await page.evaluate(() => app._APP_VERSION);
ok('④ ⭐ _CHANGELOG 第一筆必須等於 _APP_VERSION(否則更新提醒會失準)',
   cl[0].v === ver, `changelog=${cl[0].v} app=${ver}`);

// ── ⑤ 大小守門:_CHANGELOG 不可再吃掉太多檔案 ─────────────────
const size = await page.evaluate(() => JSON.stringify(app._CHANGELOG).length);
ok('⑤ ⭐ _CHANGELOG 序列化後 ≤ 80 KB', size <= 80 * 1024, `${(size / 1024).toFixed(1)} KB`);
console.log(`   ↳ 目前 ${cl.length} 筆 ・${(size / 1024).toFixed(1)} KB ・封存檔 ${archivedCount} 筆`);

ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ CHANGELOG_TRIM_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ CHANGELOG_TRIM_PASS');
