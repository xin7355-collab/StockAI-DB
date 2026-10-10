#!/usr/bin/env node
/**
 * 📚 V79.0.5 自訂回測紀錄 + 並排比較守門(外部評估㊽:StockAgent 的回測歷史)
 *   ① 跑完(沒取消)才存一筆;只存摘要(⛔ 每一趟不存)
 *   ② 最多留 `_CBT_LOG_KEEP` 筆、最新在前;🗑️ 刪掉就不見
 *   ③ 表頭可排序:點一次照那一欄、再點一次反向,而且看得出現在照哪一欄
 *   ④ 勾兩筆 → 並排比較,「後−前」差值算對;母體 / 窗口不同要寫出來
 *   ⑤ `idb.prune()` ⛔ 不可把紀錄清掉(它沒有新鮮度,是使用者自己跑的)
 *   ⑥ 入口在實驗室模式(⛔ 一般畫面不放回測成績)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.CL_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\s\/\/\s.*$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };

// ── 靜態 ──
ok('①s 取消的⛔ 不存(!st.abort)', /if \(!st\.abort && res\.overall && res\.overall\.n\) \{ try \{ await this\._cbtLogAdd\(res\)/.test(CODE));
ok('⑥s 自訂回測入口在 data-labonly 區塊裡', (() => { const i = SRC.indexOf('onclick="app._openSignalScore()"'); const lab = SRC.lastIndexOf('data-labonly', i); const close = SRC.lastIndexOf('</div>', i); return i > 0 && lab > 0 && i - lab < 1500; })());

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._cbtLogAdd && !!app.idb, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = app, out = {};
    await A.idb.del(A._CBT_LOG_KEY);
    document.documentElement.classList.add('lab');
    // 合成兩次結果:同母體同窗口,第二次每趟比較好
    const mkTr = (n, ret, y0) => Array.from({ length: n }, (_, k) => ({ key: k % 2 ? 'A' : 'B', d: `${y0 + (k % 3)}-0${1 + (k % 9)}-15`, ret: ret + (k % 5) - 2, hold: 10, sym: '2330' }));
    const mkRes = (tr, cfg) => { const byKey = {}; for (const t of tr) (byKey[t.key] ||= []).push(t); const res = { cfg, syms: 40, scanned: 30, trades: tr.length, overall: A._cbtStats(tr), byKey: {} }; for (const [k, a] of Object.entries(byKey)) res.byKey[k] = A._cbtStats(a); return res; };
    const r1 = mkRes(mkTr(40, 0.5, 2023), { universe: 'fav', n: 40, exit: 'don40', gene: false, patterns: null });
    const r2 = mkRes(mkTr(40, 2.0, 2023), { universe: 'fav', n: 40, exit: 'chand2', gene: true, patterns: ['A'] });
    out.put1 = await A._cbtLogAdd(r1);
    await new Promise(r => setTimeout(r, 5));
    out.put2 = await A._cbtLogAdd(r2);
    const rows = await A._cbtLogGet();
    out.n = rows.length; out.firstPer = rows[0].per; out.r2per = r2.overall.per; out.hasTrades = JSON.stringify(rows).includes('"ret"');
    // 開視窗 → 畫紀錄
    A._openSignalScore(); await new Promise(r => setTimeout(r, 300));
    const box = () => document.getElementById('cbtLogBox');
    out.list1 = [...box().querySelectorAll('[data-cbtlog]')].map(e => +e.dataset.cbtlog);
    // ③ 照「每趟」排(由大到小)、再點一次反向
    A._cbtLogSortBy('per'); await new Promise(r => setTimeout(r, 100));
    const perOf = () => [...box().querySelectorAll('[data-cbtlog]')].map(e => rows.find(r => r.id === +e.dataset.cbtlog).per);
    out.sortDesc = perOf(); out.sortMark = (box().querySelector('[data-cbtsort="per"]') || {}).textContent;
    A._cbtLogSortBy('per'); await new Promise(r => setTimeout(r, 100));
    out.sortAsc = perOf(); out.sortMark2 = (box().querySelector('[data-cbtsort="per"]') || {}).textContent;
    // ④ 勾兩筆
    A._cbtLogPick(rows[0].id, true); A._cbtLogPick(rows[1].id, true); await new Promise(r => setTimeout(r, 100));
    const cmp = box().querySelector('[data-cbtcmp]');
    out.cmpTxt = cmp ? cmp.innerText : '';
    out.expDelta = +(r2.overall.per - r1.overall.per).toFixed(2);
    // 母體不同 → 要警告:改一筆的 n
    const rr = await A._cbtLogGet(); rr[0].n = 80; await A.idb.put(A._CBT_LOG_KEY, { ts: Date.now(), rows: rr });
    await A._cbtLogRender(); out.cmpTxt2 = (box().querySelector('[data-cbtcmp]') || {}).innerText || '';
    // ② 上限
    for (let k = 0; k < 25; k++) await A._cbtLogAdd(r1);
    out.capN = (await A._cbtLogGet()).length; out.keep = A._CBT_LOG_KEEP;
    { const ids = (await A._cbtLogGet()).map(r => r.id); out.uniq = new Set(ids).size === ids.length; }
    // ② 刪
    const before = await A._cbtLogGet(); await A._cbtLogDel(before[0].id);
    out.afterDel = (await A._cbtLogGet()).length; out.delGone = !(await A._cbtLogGet()).some(r => r.id === before[0].id);
    // ⑤ prune 放過紀錄(就算 ts 很舊)
    const cur = await A._cbtLogGet(); await A.idb.put(A._CBT_LOG_KEY, { ts: 1, rows: cur });
    await A.idb.prune(); out.afterPrune = (await A._cbtLogGet()).length;
    out.overflow = document.documentElement.scrollWidth > window.innerWidth + 2 ? (() => { window.scrollTo(80, 0); return window.scrollX; })() : 0;
    await A.idb.del(A._CBT_LOG_KEY);
    return out;
});

ok('🚧 put 回 true', R.put1 === true && R.put2 === true, `${R.put1} ${R.put2}`);
ok('① 存了兩筆、最新在前', R.n === 2 && R.firstPer === R.r2per, `${R.n} ${R.firstPer} ${R.r2per}`);
ok('① 只存摘要(⛔ 每一趟不存)', !R.hasTrades);
ok('② 畫出兩列', R.list1.length === 2, JSON.stringify(R.list1));
ok('③ 照「每趟」由大到小 + 標 ▼', R.sortDesc[0] >= R.sortDesc[1] && /▼/.test(R.sortMark || ''), `${R.sortDesc} ${R.sortMark}`);
ok('③ 再點一次反向 + 標 ▲', R.sortAsc[0] <= R.sortAsc[1] && /▲/.test(R.sortMark2 || '') && R.sortAsc[0] !== R.sortDesc[0], `${R.sortAsc} ${R.sortMark2}`);
ok('④ 勾兩筆 → 有並排比較,而且「每趟」差值算對', /並排比較/.test(R.cmpTxt) && R.cmpTxt.includes((R.expDelta >= 0 ? '+' : '') + R.expDelta.toFixed(2)), `${R.expDelta} | ${R.cmpTxt.slice(0, 200)}`);
ok('④ 同母體同窗口 → 寫「差別只在你換的條件」', /差別只在你換的條件/.test(R.cmpTxt));
ok('④b 母體不同 → 寫出「⛔ 不可直接說哪個條件比較好」', /不可直接說哪個條件比較好/.test(R.cmpTxt2), R.cmpTxt2.slice(-160));
ok('② 最多留 KEEP 筆', R.capN === R.keep, `${R.capN} vs ${R.keep}`);
ok('②b 同一毫秒連存也不撞號(撞號會讓 🗑️ 一次刪兩筆)', R.uniq);
ok('② 🗑️ 刪掉就不見', R.delGone && R.afterDel === R.keep - 1);
ok('⑤ prune ⛔ 不清掉紀錄(ts 很舊也一樣)', R.afterPrune === R.keep - 1, R.afterPrune);
ok('📱 390px 沒有橫向捲動', R.overflow <= 2, R.overflow);
ok('🚧 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ test_cbtlog 全過');
process.exit(fails ? 1 : 0);
