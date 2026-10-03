#!/usr/bin/env node
/**
 * 🚨 V77.6.8 「持股進處置/注意 → 決策台賣出列要講」守門
 *
 * 使用者(大甲 2221 處置中、2026-10-06 出關):「進處置股不用先賣嗎?還要等唐奇安 40 日嗎?」
 * 以前 `_invExitScan` / 賣出列**完全不讀 `attentionStatus`**,只有總覽主卡補一行警示 → 決策台上看不出這檔在處置。
 *
 * 釘住的用意:
 *   ⓐ 持股在處置名單 → 賣出/盯的那一列有 🚨 處置 徽章 + `[data-dispohold="disp"]` 說明(分盤流動性 + dispo_probe 數字)
 *   ⓑ `_DISPO_HOLD_EDGE.hold` 是 null 時畫面**明說「還沒測」**(⛔ 不編答案,陷阱 #22);有值時印那組數字
 *   ⓒ 決定性對照:同一檔不在名單 → 沒有徽章、沒有說明
 *   ⓓ 注意股走 ⚠️ 那條、⛔ 不可寫成處置
 *   ⓔ 數字讀常數(改 `dispMed` 畫面跟著變)
 * 注入(逐一確認會紅):拿掉 `ed.att = this._heldAttention(sym)` → ⓐ 紅;`hold` 為 null 時仍印數字 → ⓑ 紅
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderDeck && !!app._invExitScan && !!app._dispoHoldNoteHtml, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const out = {};
    const rows = []; for (let i = 0; i < 60; i++) { const c = i < 40 ? 95 + (i % 5) : 100 + (i - 39) * 0.5; const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'); rows.push({ date: d, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }); }
    const buyDate = rows[50].date.replace(/\//g, '-');   // 抱 9 天 → 不到期,落在「盯 / 沒有」那一區也要有徽章
    app.currentSymbolId = '9999';
    app._getInventory = () => [{ symbol: '2221', cost: 90, shares: 2, buyDate }];
    app.getStockName = s => ({ '2221': '大甲' }[s] || s);
    await app.idb.put('proTerm_kline_2221', { data: rows, ts: Date.now() });
    const render = async () => { app._invExitAt = 0; await app.renderDeck(); const el = document.querySelector('[data-exitrow="2221"]'); return { attBox: !!document.querySelector('[data-exitatt]'), row: el ? el.innerText.replace(/\s+/g, ' ') : null, note: (el && el.querySelector('[data-dispohold]')) ? el.querySelector('[data-dispohold]').getAttribute('data-dispohold') : null, noteTxt: (el && el.querySelector('[data-dispohold]')) ? el.querySelector('[data-dispohold]').innerText.replace(/\s+/g, ' ') : '' }; };
    // ⓒ 對照:不在名單
    app.attentionStatus = {};
    out.none = await render();
    // ⓐ 處置中、hold 還沒測
    app.attentionStatus = { '2221': { status: '🚨 處置中', threshold: '已關禁閉', interval: 5, end_date: '2026-10-06' } };
    const H0 = app._DISPO_HOLD_EDGE.hold; app._DISPO_HOLD_EDGE.hold = null;
    out.disp = await render();
    // ⓔ 數字讀常數
    const m0 = app._DISPO_HOLD_EDGE.dispMed; app._DISPO_HOLD_EDGE.dispMed = -77.7;
    out.disp77 = await render(); app._DISPO_HOLD_EDGE.dispMed = m0;
    // ⓑ 有測過 → 印數字
    app._DISPO_HOLD_EDGE.hold = { paths: 17, base: { med: 409, dd: 26.1 }, dispo: { med: 123, wins: 4, dd: 25.5, verdict: '測試判定甲' }, att: { med: 321, wins: 9, dd: 24.4, verdict: '測試判定乙' } };
    out.dispH = await render();
    // ⓓ 注意股
    app.attentionStatus = { '2221': { status: '⚠️ 注意股', threshold: '注意條款觸發' } };
    out.notice = await render();
    // ⓕ 抱滿到期(sell 那一區)也要有徽章 —— 同一檔改買進日到第 5 根 → 抱 55 天 > 40
    app._getInventory = () => [{ symbol: '2221', cost: 90, shares: 2, buyDate: rows[4].date.replace(/\//g, '-') }];
    app.attentionStatus = { '2221': { status: '🚨 處置中', interval: 20, end_date: '2026-10-06' } };
    out.due = await render();
    out.dueBox = !!document.querySelector('[data-exitatt]');
    app._DISPO_HOLD_EDGE.hold = H0;
    return out;
});
await browser.close();

ok('🚧 空過守門:在名單時 2221 那一列渲染得出來(離線遠的持股本來一列都不畫 → 靠新的那一區)', !!(R.disp && R.disp.row && R.disp.attBox === true), JSON.stringify(R.disp));
ok('ⓒ 決定性對照:不在名單 → 離線遠的持股照舊不畫、⛔ 沒有處置那一區、沒有說明', !!(R.none && R.none.row === null && R.none.attBox === false && R.none.note === null), JSON.stringify(R.none));
ok('ⓐ 處置中 → 徽章「🚨 處置 5 分盤」+ `[data-dispohold="disp"]`', !!(R.disp && /🚨 處置 5 分盤/.test(R.disp.row) && R.disp.note === 'disp'), R.disp && R.disp.row);
// 🧹 V78.3.6 散戶 App 不印 dispo_probe 數字 → 改釘:講分盤流動性 + 出關日 + 別用市價單,⛔ 不可出現實測/探針數字
const _RES = /實測|回測|還沒測|dispo_probe|配對|\\d+\\s*萬|−4\\.8%|-4\\.8%|中位/;
ok('ⓐb 說明講分盤流動性 + 出關日 + 別用市價單,⛔ 不印 dispo_probe 中位數(🧹 V78.3.6)', !!(R.disp && /分盤撮合/.test(R.disp.noteTxt) && /10\/06/.test(R.disp.noteTxt) && /市價單/.test(R.disp.noteTxt) && !_RES.test(R.disp.noteTxt)), R.disp && R.disp.noteTxt);
// 🧹 V78.3.6 一般模式不講「還沒測」(研究狀態)→ 改釘:回答「要不要先賣」= 照你原本的出場規則走,⛔ 不印「… 萬」比較數字
ok('ⓑ `hold` 是 null → 回答「照你原本的出場規則走」,⛔ 不印研究狀態與任何「… 萬」數字(🧹 V78.3.6)', !!(R.disp && /要不要先賣/.test(R.disp.noteTxt) && /照你原本的出場規則走/.test(R.disp.noteTxt) && !_RES.test(R.disp.noteTxt)), R.disp && R.disp.noteTxt);
// 🧹 V78.3.6 數字已不印 → 決定性對照改成「改常數 → 畫面仍不出現那個數字」
ok('ⓔ dispMed 改 −77.7 → 一般模式畫面仍⛔ 不出現那個數字(🧹 V78.3.6)', !!(R.disp77 && R.disp77.noteTxt.length > 20 && !/77\.7/.test(R.disp77.noteTxt) && /分盤撮合/.test(R.disp77.noteTxt)), R.disp77 && R.disp77.noteTxt);
// 🧹 V78.3.6 有測過時一般模式只講結論「⛔ 不用,照原本出場」,⛔ 不印 123 萬 / 409 萬 / 4/17 / 判定文字
ok('ⓑ2 `hold` 有值 → 講「⛔ 不用,照你原本的出場規則走」,⛔ 不印萬元比較 / 配對勝場 / 判定文字(🧹 V78.3.6)', !!(R.dispH && /不用,照你原本的出場規則走/.test(R.dispH.noteTxt) && !/123|409|4\/17|測試判定甲/.test(R.dispH.noteTxt) && !_RES.test(R.dispH.noteTxt)), R.dispH && R.dispH.noteTxt);
// 🧹 V78.3.6 注意股不再印判定文字(測試判定乙)→ 改釘「注意股⛔ 不能拿來預測方向」+ ⛔ 不印研究數字
ok('ⓓ 注意股 → ⚠️ 注意 徽章、`data-dispohold="notice"`、⛔ 不寫成處置、⛔ 不印研究數字(🧹 V78.3.6)', !!(R.notice && /⚠️ 注意/.test(R.notice.row) && R.notice.note === 'notice' && !/處置中/.test(R.notice.noteTxt) && /注意股⛔ 不能拿來預測方向/.test(R.notice.noteTxt) && !/測試判定乙/.test(R.notice.noteTxt) && !_RES.test(R.notice.noteTxt)), R.notice && (R.notice.row + ' || ' + R.notice.noteTxt));
ok('ⓕ 抱滿到期那一列(sell 區)也帶 🚨 處置 20 分盤 徽章,而且⛔ 不重複列進 far 那一區', !!(R.due && /🚨 處置 20 分盤/.test(R.due.row) && /抱滿|時間到期/.test(R.due.row) && R.due.note === 'disp' && R.dueBox === false), R.due && (R.due.row + ' box=' + R.dueBox));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails.length ? `\n❌ DISPOHOLD_FAIL(${fails.length}):${fails.join(' / ')}` : '\n✅ DISPOHOLD_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
