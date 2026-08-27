#!/usr/bin/env node
/**
 * 🔽 板塊表排序按鈕(V73.9.6)測試 —— 使用者:「附圖新增排序按鈕」
 *
 * ⛔ 這支要釘死的六件事:
 *   ① 預設 ⛔ **不排序**(維持原本的板塊順序)—— 不然每次打開順序都不一樣。
 *   ② 🚨 **沒有值的板塊一律排最後**。JS 的 `null < 15` 是 **true**,
 *      照 `a-b` 排會把「沒資料」的排到最前面,看起來像最弱(或最強)——
 *      本專案 V73.5.1 已經踩過同一個坑。
 *   ③ 點同一欄第二次 → 反向;第三次 → 回復原順序。
 *   ④ 排序用的數字 ⛔ 必須跟畫面顯示的是**同一個來源**(⛔ 不可另外算一份 = 第二份真相)。
 *   ⑤ 狀態要記得住 —— `renderSectorGapTable` 在籌碼資料載完後會**再重繪一次**,
 *      存區域變數的話使用者排好的順序會自己跳回去。
 *   ⑥ 表頭要看得出「現在照哪一欄排、哪個方向」(▼/▲)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ④ 靜態:⛔ 不可另外算一份數字
{
    const i = src.indexOf('const _val = (sk) =>');
    const blk = i > 0 ? src.slice(i, i + 700) : '';
    ok('④ 🚨 空過守門:抓得到排序取值那段', blk.length > 200, blk.length);
    ok('④b 排序取值要用**跟顯示同一個**來源(etfMap / _intraTw / _shTw / _cf)',
       ['etfMap[sk]', '_intraTw[sk]', '_shTw[sk]', '_cf[sk]'].every(k => blk.includes(k)), blk.slice(0, 200));
    ok('② 🚨 排序時 ⛔ 不可讓 null 參與大小比較(要 Number.isFinite 判斷後排最後)',
       /Number\.isFinite/.test(src.slice(i, i + 1400)) && /if \(na\) return 1/.test(src.slice(i, i + 1400)));
}
ok('⑤ 狀態存在 this 上(⛔ 不可用區域變數,重繪會跳回去)',
   /this\._secSortKey/.test(src) && /this\._secSortDir/.test(src));
ok('⑤b 而且會寫進 localStorage(下次打開還記得)', src.includes("'proTerm_secSort'"));
ok('⑤c 還原時走 `_lsJson`(⛔ 裸 JSON.parse 壞值會炸掉 App,陷阱 #18)',
   /_lsJson\('proTerm_secSort'/.test(src));

// ── 前端實跑 ─────────────────────────────────────────────────────
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._secSort && !!app.renderSectorGapTable, null, { timeout: 25000 });

const R2 = await page.evaluate(() => {
    // 🚧 空過守門的前置:`renderSectorGapTable` 有 `_checkMacroReady()` 守門
    //    (要 sector_etfs ≥5 個)—— ⚠️ 少了它整張表根本不會渲染,
    //    而測試會變成「兩邊都 undefined 所以相等」的**假綠燈**(第一版就是這樣)。
    const SK = ['server', 'power', 'packaging', 'cpo', 'cooling', 'robot', 'finance', 'leo'];
    app._macroRiskCache = { sector_etfs: Object.fromEntries(SK.map((k, i) => [k, { chg_pct: (i - 3) * 0.5 }])) };
    app._sectorChipFlow = { updated: '2026-08-26', sectors: { server: { fi5: -60000 }, power: { fi5: 8000 } } };
    // 只給前 3 個板塊台股漲跌(+1 / +3 / +2),其餘**刻意沒有值** → 驗它們排最後
    app._sectorHeatCache = {
        updated: new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toISOString().slice(0, 10),
        sectors: { server: { chg: 1 }, power: { chg: 3 }, packaging: { chg: 2 } },
    };
    try { localStorage.removeItem('proTerm_secSort'); } catch (_) {}
    app._secSortKey = undefined;

    const box = () => document.getElementById('predictGapTableResult');
    const rowKeys = () => [...box().querySelectorAll('[onclick*="_toggleSectorRow"]')]
        .map(e => (e.getAttribute('onclick').match(/_toggleSectorRow\('([^']+)'\)/) || [])[1])
        .filter(Boolean);

    app.renderSectorGapTable();
    const def = rowKeys();

    app._secSort('tw');  const desc = rowKeys(); const dir1 = app._secSortDir;
    app._secSort('tw');  const asc = rowKeys();
    app._secSort('tw');  const reset = rowKeys(); const resetKey = app._secSortKey;

    app._secSort('fi5');
    const hdr = box().innerHTML.slice(0, 2000);
    let saved = null; try { saved = localStorage.getItem('proTerm_secSort'); } catch (_) {}
    app.renderSectorGapTable();                 // ⑤ 模擬籌碼載完的重繪
    const afterRerender = app._secSortKey;
    const afterRows = rowKeys();
    return { def, desc, asc, reset, resetKey, dir1, hdr, saved, afterRerender, afterRows,
             withVal: ['server', 'power', 'packaging'] };
});
await browser.close();

// 🚧 空過守門:⛔ 沒渲染出東西的話,下面全部會變成「兩邊都 undefined 所以相等」的假綠燈
ok('🚧 空過守門:表格真的渲染出板塊列了', R2.def.length >= 8, R2.def);
ok('① 預設 ⛔ 不排序(維持原本的板塊順序)',
   R2.def.slice(0, 3).join(',') === 'server,power,packaging', R2.def.slice(0, 4));
ok('③ 第一次點 → 由大到小(+3% 的 power 排最前)', R2.desc[0] === 'power', R2.desc.slice(0, 4));
ok('③b 第二次點 → 反向(+1% 的 server 排最前)', R2.asc[0] === 'server', R2.asc.slice(0, 4));
ok('③c 第三次點 → 回復原順序', R2.resetKey === null && R2.reset.join(',') === R2.def.join(','), R2.resetKey);
{
    // ② 沒有值的板塊必須排最後
    const withVal = new Set(R2.withVal.filter(Boolean));
    const idx = R2.desc.map((k, i) => withVal.has(k) ? i : -1).filter(i => i >= 0);
    ok('② 🚨 有值的三個必須全部排在前面(⛔ null 不可被當成最小值排到最前)',
       idx.length === 3 && Math.max(...idx) === 2, idx);
}
ok('⑥ 表頭要顯示目前排序欄位與方向(▼/▲)', /▼|▲/.test(R2.hdr), R2.hdr.slice(0, 200));
ok('⑤d 選擇有存進 localStorage', !!R2.saved && R2.saved.includes('fi5'), R2.saved);
ok('⑤e 🚨 重繪之後排序 ⛔ 不可跳回去(籌碼資料載完會再重繪一次)',
   R2.afterRerender === 'fi5' && R2.afterRows.length === R2.def.length, R2.afterRerender);
ok('⑦ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ SECSORT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
