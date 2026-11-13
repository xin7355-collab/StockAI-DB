#!/usr/bin/env node
/**
 * 🧭 V82.2.5 買進理由 → 勝率鏡子照理由分組(使用者 11/13「可以做的都做」)
 *
 *  ① 分組(純函式 `_mirrorWhyGroups`):筆數 / 賺幾筆 / 平均 % / 合計元、未填單獨一組放最後、補填幾筆、
 *     停損那兩組只算有記 planStop 的(決定性對照:把一筆的理由換掉 → 它從一組搬到另一組、合計跟著搬)
 *  ② 編輯庫存:選理由、勾「買之前想好停損價」→ 💾 儲存後存進 proTerminalInv;亂寫的理由存成未填
 *  ③ 賣出:買的時候選過 → 照抄、⛔ 標補填;沒選、賣的時候才選 → whyLate = 1;賣一部分 → 剩下那筆理由還在;
 *     停損有沒有想好照抄;什麼都沒選的舊庫存 → 日誌⛔ 多出 why / planStop(⛔ 假裝有填)
 *  ④ 鏡子實際打開:有填 → 分組那塊、未滿 10 筆寫「(還太少)」;全部沒填 → 一行教學;390px ⛔ 橫向溢出
 *  ⑤ 新的字 ⛔ 研究字樣(散戶 App 鐵則,lib_retailbad 同一份清單)、⛔ 🔴🟢
 * 跑法:node scripts/test_buywhy.mjs ・INJECT=1 node scripts/test_buywhy.mjs(注入必紅)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 🧪 注入:每一種壞寫法 → 至少一條要紅
const INJ = {
    nolate: ['if (_wL || (_w0 && item.whyLate)) log.whyLate = 1;', ''],
    nocopy: ['if (_w0 || _wL) log.why = _w0 || _wL;', 'if (_wL) log.why = _wL;'],
    unfilledFirst: [".sort((a, b) => (b.k ? 1 : 0) - (a.k ? 1 : 0) || b.n - a.n);", ".sort((a, b) => b.n - a.n);"],
    nokeep: ["...(this._whyOk(log.why) ? { why: log.why, ...(log.whyLate ? { whyLate: 1 } : {}) } : {}), ", ''],
    nodraft: ["if (this._whyOk(log.why)) { item.why = log.why; if (log.whyLate) item.whyLate = 1; }", ''],
    anyWhy: ["this._invEditDraft[idx].why = this._WHY_LIST.some(x => x[0] === v) ? v : '';", "this._invEditDraft[idx].why = v;"],
    lateCarry: ["if (_wL || (_w0 && item.whyLate)) log.whyLate = 1;", "if (_wL) log.whyLate = 1;"],
};

async function run(html) {
    const fails = [];
    const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buywhy-')), 'index.html');
    fs.writeFileSync(tmp, html);
    const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
        const errs = [];
        page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|fetch/i.test(t)) errs.push(t); });
        await page.goto(pathToFileURL(tmp).href, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._mirrorWhyGroups === 'function', null, { timeout: 60000 });
        await page.waitForTimeout(800);

        // ── ① 分組 ──
        const G = await page.evaluate(() => {
            const A = app;
            const L = [
                { why: 'app', pnlNTD: 3000, pnlPct: 3 }, { why: 'app', pnlNTD: -1000, pnlPct: -1 },
                { why: 'tip', pnlNTD: -5000, pnlPct: -5, whyLate: 1 },
                { pnlNTD: 2000, pnlPct: 2 },                                   // 未填
                { why: 'bogus', pnlNTD: -100, pnlPct: -0.1 },                  // 亂寫 → 未填
                { why: 'news', pnlNTD: 100, pnlPct: 0.5, planStop: 1 }, { why: 'news', pnlNTD: -400, pnlPct: -2, planStop: 0 },
            ];
            const a = A._mirrorWhyGroups(L);
            const L2 = L.map((t, i) => i === 0 ? { ...t, why: 'tip' } : t);   // 決定性對照:第一筆改成「別人報的」
            const b = A._mirrorWhyGroups(L2);
            return { a, b };
        });
        const gOf = (r, k) => r.groups.find(g => g.k === k);
        ok('① 筆數 / 有填 / 補填', G.a.n === 7 && G.a.filled === 5 && G.a.late === 1, JSON.stringify(G.a));
        ok('① App 推薦那組:2 筆、賺 1 筆、平均 +1.0%、合計 +2000', gOf(G.a, 'app')?.n === 2 && gOf(G.a, 'app').win === 1 && Math.abs(gOf(G.a, 'app').avgPct - 1) < 1e-9 && gOf(G.a, 'app').sum === 2000, JSON.stringify(gOf(G.a, 'app')));
        ok('① 未填 2 筆(含亂寫的)而且排最後', gOf(G.a, '')?.n === 2 && G.a.groups[G.a.groups.length - 1].k === '', JSON.stringify(G.a.groups.map(g => g.k)));
        ok('① 停損兩組只算有記的:有 1 筆 +0.5%、沒有 1 筆 −2%', G.a.plan.yes?.n === 1 && G.a.plan.no?.n === 1 && G.a.plan.no.avgPct === -2, JSON.stringify(G.a.plan));
        ok('① 決定性對照:第一筆改成別人報的 → App 推薦剩 1 筆、別人報的合計 −5000 + 3000', gOf(G.b, 'app')?.n === 1 && gOf(G.b, 'tip')?.sum === -2000, JSON.stringify([gOf(G.b, 'app'), gOf(G.b, 'tip')]));

        // ── ② 編輯庫存:選理由 + 勾停損 → 儲存 ──
        const E = await page.evaluate(async () => {
            const A = app;
            localStorage.setItem('proTerminalInv', JSON.stringify([
                { symbol: '2330', cost: 1000, shares: 2, buyDate: '2026-10-01' },
                { symbol: '2317', cost: 200, shares: 1, buyDate: '2026-10-02' },
                { symbol: '2412', cost: 120, shares: 1, buyDate: '2026-10-03' },
            ]));
            A.inventory = JSON.parse(localStorage.getItem('proTerminalInv'));
            A.refreshInventoryPrices = () => {};
            A.openInventoryEditPage();
            await new Promise(r => setTimeout(r, 200));
            const sel0 = document.querySelector('[data-whysel="0"]'), sel1 = document.querySelector('[data-whysel="1"]'), cb0 = document.querySelector('[data-planstop="0"]');
            const opts = sel0 ? [...sel0.options].map(o => o.value) : [];
            sel0.value = 'app'; sel0.dispatchEvent(new Event('change'));
            cb0.checked = true; cb0.dispatchEvent(new Event('change'));
            A._updateInvEditDraft(1, 'why', 'not-a-key');                      // 亂寫 → 存成未填
            const modal = document.getElementById('inventoryEditPageModal');
            const ow = modal ? modal.scrollWidth - modal.clientWidth : -1;
            A.saveInventoryEditPage();
            return { opts, inv: JSON.parse(localStorage.getItem('proTerminalInv')), ow, row: (document.querySelector('[data-whyrow="0"]') || {}).outerHTML || '' };
        });
        ok('② 下拉選單:未填 + 8 種理由', E.opts.length === 9 && E.opts[0] === '' && E.opts.includes('app') && E.opts.includes('tip'), E.opts.join(','));
        ok('② 儲存後:第一檔 why=app、planStop=true', E.inv[0].why === 'app' && E.inv[0].planStop === true, JSON.stringify(E.inv[0]));
        ok('② 亂寫的理由存成未填', E.inv[1].why === '', JSON.stringify(E.inv[1]));
        ok('② 編輯頁 390px ⛔ 橫向溢出', E.ow <= 1, `溢出 ${E.ow}px`);

        // ── ③ 賣出 ──
        const S = await page.evaluate(async () => {
            const A = app;
            localStorage.setItem('proTerminalTradeLog', '[]');
            A.showToast = () => {}; A.vibrate = () => {};
            A.openInventoryEditPage();
            await new Promise(r => setTimeout(r, 100));
            const out = {};
            // a. 買的時候選過(2330:app、planStop),在編輯頁改成「營收財報」但還沒按儲存 → 賣一半
            //    ⭐ 剩下那筆要跟著草稿(⛔ 退回存檔裡的 app —— 跟成本 / 買進日同一條規則)
            A._updateInvEditDraft(0, 'why', 'fund');
            out.a = A._invSellCommit(0, { price: 1100, shares: 1000, date: '2026-11-10' });
            out.invAfterA = JSON.parse(localStorage.getItem('proTerminalInv'))[0];
            // b. 沒選(2412,在草稿裡是第 3 列)→ 賣的時候才補「別人報的」
            out.b = A._invSellCommit(2, { price: 110, shares: 1000, date: '2026-11-10', why: 'tip' });
            // b2. 2412 還剩 0 股(全賣了)→ 另外做一檔:先賣一半補選「新聞消息」、再賣剩下的 → 第二筆也要標補填
            A.inventory.push({ symbol: '1301', cost: 80, shares: 2 });
            localStorage.setItem('proTerminalInv', JSON.stringify(A.inventory));
            A.openInventoryEditPage();
            const iN = () => A._invEditDraft.findIndex(x => x.symbol === '1301');
            out.b2a = A._invSellCommit(iN(), { price: 85, shares: 1000, date: '2026-11-10', why: 'news' });
            out.b2rest = JSON.parse(localStorage.getItem('proTerminalInv')).find(x => x.symbol === '1301');
            out.b2b = A._invSellCommit(iN(), { price: 86, shares: 1000, date: '2026-11-11' });
            // c. 什麼都沒選(2317)→ 全賣、⛔ 補
            out.c = A._invSellCommit(A._invEditDraft.findIndex(x => x.symbol === '2317'), { price: 210, shares: 1000, date: '2026-11-10', why: '' });
            out.log = JSON.parse(localStorage.getItem('proTerminalTradeLog'));
            // 賣出面板:有理由 → 只顯示;沒理由 → 問
            A.inventory = [{ symbol: '1101', cost: 30, shares: 1, why: 'long' }, { symbol: '1102', cost: 40, shares: 1 }];
            localStorage.setItem('proTerminalInv', JSON.stringify(A.inventory));
            A.openInventoryEditPage();
            A._invSellIdx = 0; out.p0 = A._invSellPanelHtml(0); out.p1 = A._invSellPanelHtml(1);
            A.closeInventoryEditPage();
            return out;
        });
        const lg = sym => (S.log || []).find(t => t.symbol === sym) || {};
        ok('③ 買的時候選過 → 照抄(編輯頁上看到的那個)、⛔ 標補填、停損照抄', S.a === true && lg('2330').why === 'fund' && !lg('2330').whyLate && lg('2330').planStop === 1, JSON.stringify(lg('2330')));
        ok('③ 賣一部分 → 剩下那筆理由跟著草稿、停損還在', S.invAfterA && S.invAfterA.why === 'fund' && S.invAfterA.planStop === true && Math.abs(S.invAfterA.shares - 1) < 1e-9, JSON.stringify(S.invAfterA));
        ok('③ 賣的時候才補 → whyLate = 1、停損記成沒想好', S.b === true && lg('2412').why === 'tip' && lg('2412').whyLate === 1 && lg('2412').planStop === 0, JSON.stringify(lg('2412')));
        const l1301 = (S.log || []).filter(t => t.symbol === '1301');
        ok('③ 賣一半時才補選 → 剩下那筆帶著「補的」、再賣也標補填', S.b2a === true && S.b2b === true && S.b2rest && S.b2rest.why === 'news' && S.b2rest.whyLate === 1
            && l1301.length === 2 && l1301.every(t => t.why === 'news' && t.whyLate === 1), JSON.stringify([S.b2rest, l1301]));
        ok('③ 都沒選 → 日誌⛔ 多出 why / planStop', S.c === true && !('why' in lg('2317')) && !('planStop' in lg('2317')), JSON.stringify(lg('2317')));
        ok('③ 賣出面板:有理由只顯示、沒理由才問', /data-sellwhy="have"/.test(S.p0) && /存股長抱/.test(S.p0) && !/data-sellf="why"/.test(S.p0) && /data-sellwhy="ask"/.test(S.p1) && /data-sellf="why"/.test(S.p1), '');

        // ── ④ 鏡子實際打開 ──
        const M = await page.evaluate(async () => {
            const A = app;
            A.fetchHistoricalData = async () => [];
            A._xcCache = {};
            const mk = (why, p) => ({ symbol: 'X', name: '測試', cost: 100, sellPrice: 100 + p, shares: 1, pnlNTD: p * 1000, pnlPct: p, date: '2026/11/10', net: 1, ...(why ? { why } : {}) });
            localStorage.setItem('proTerminalTradeLog', JSON.stringify([mk('app', 3), mk('app', -1), mk('', 2)]));
            const h1 = A._tradeJournalHtml();
            const w1 = A._mirrorWhyHtml([mk('app', 3), mk('app', -1), mk('', 2)]), w0 = A._mirrorWhyHtml([mk('', 3)]);
            localStorage.setItem('proTerminalTradeLog', JSON.stringify([mk('', 3), mk('', -1)]));
            const h0 = A._tradeJournalHtml();
            localStorage.setItem('proTerminalTradeLog', JSON.stringify([mk('app', 3), mk('tip', -1), mk('', 2)]));
            A._showTradeMirror();
            await new Promise(r => setTimeout(r, 400));
            const body = document.getElementById('updateLogBody');
            const det = body && body.querySelector('[data-mirrorwhy="1"]');
            if (det) det.open = true;
            await new Promise(r => setTimeout(r, 50));
            const ov = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            const txt = det ? det.innerText : '';
            return { h1, h0, w1, w0, txt, ov, has: !!det };
        });
        ok('④ 有填 → 分組那塊、兩筆寫「(還太少)」、未填一組', /data-mirrorwhy="1"/.test(M.h1) && /data-whygrp="app"/.test(M.h1) && /data-whygrp="none"/.test(M.h1) && /2 筆\(還太少\)/.test(M.h1), M.h1.slice(0, 200));
        ok('④ 全部沒填 → 一行教學、⛔ 分組表', /data-mirrorwhy="0"/.test(M.h0) && !/data-whygrp=/.test(M.h0), '');
        ok('④ 鏡子實際打開看得到分組、390px ⛔ 橫向溢出', M.has && /照「為什麼買」分/.test(M.txt) && M.ov <= 1, `has=${M.has} ov=${M.ov}`);

        // ── ⑤ 散戶 App 鐵則 ──
        // ⚠️ 只掃這次新加的那幾塊(鏡子其他地方的舊字不歸這支管,test_retail_clean 會掃整頁)
        const sellWhy = h => (h.match(/<(?:div|label)[^>]*data-sellwhy="[^"]*"[\s\S]*?<\/(?:div|label)>/) || [''])[0];
        const newTxt = [E.row, sellWhy(S.p0), sellWhy(S.p1), M.w1, M.w0, M.txt].join('\n');
        ok('⑤ 抓得到新加的那幾塊(⛔ 空字串假綠燈)', E.row.length > 50 && sellWhy(S.p0).length > 20 && sellWhy(S.p1).length > 20 && M.w1.length > 50, '');
        ok('⑤ 新的字 ⛔ 研究字樣', badOf(newTxt).length === 0, badOf(newTxt).join(' '));
        ok('⑤ 新的字 ⛔ 🔴🟢(燈號只講漲跌)', !/[🔴🟢]/u.test(newTxt), '');
        ok('⑥ 沒有 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));
    } finally {
        await browser.close();
    }
    return fails;
}

if (process.env.INJECT) {
    let missed = 0;
    for (const [k, pairs] of Object.entries(INJ)) {
        const list = Array.isArray(pairs[0]) ? pairs : [pairs];
        let h = SRC, okRep = true;
        for (const [a, b] of list) { if (!h.includes(a)) { okRep = false; break; } h = h.replace(a, b); }
        if (!okRep) { console.log(`❌ 注入 ${k}:原始碼找不到要換的那一段(程式改了?)`); missed++; continue; }
        process.env.QUIET = '1';
        const f = await run(h);
        delete process.env.QUIET;
        console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? `紅 ${f.length} 條(${f.slice(0, 2).join(' / ')})` : '⛔ 沒有任何一條紅'}`);
        if (!f.length) missed++;
    }
    process.exit(missed ? 1 : 0);
}
const fails = await run(SRC);
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ 全部通過');
process.exit(fails.length ? 1 : 0);
