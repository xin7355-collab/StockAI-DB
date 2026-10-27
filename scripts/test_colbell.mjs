#!/usr/bin/env node
/**
 * 🎲 V79.9.4 你的庫存碰到專欄裡的情況 → 🔔 鈴鐺記一筆發生率(`_colOccBell`)
 *   使用者 10/27:「專欄提到發生什麼可能會跌,用機率的方式提醒告知」
 *   ① 庫存今天收盤跌破月線 → 記 ≥1 筆,原因帶日期、帶兩行 🎲(這檔過去 N 次 / 一般股票),走 _alertQuiet(⛔ 跳窗)
 *   ② 同一天再掃 → 0 筆;隔天 → 再記
 *   ③ 決定性對照:同一份 K 線只放自選(不在庫存)→ 0 筆;沒打開 📰 專欄 → 0 筆
 *   ④ 數字讀 `_COL_BASE`(把 ma20_break 的 p 改成 77.7 → 文字寫 78%)
 *   ⑤ 文字 ⛔ 叫你賣 / 先賣 / 買回 / 減碼 / 勝率 / 方向字 / 研究字樣;一定有「⛔ 不是會漲或會跌」與「照你的出場規則走」
 *   注入:INJECT=nogate(拿掉「沒打開專欄不記」→ ③ 紅)/ INJECT=noheld(拿掉「只記庫存」→ ③ 紅)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
const G0 = "    _colOccBell(hits, lastD) {\n        if (!lastD || !this._deckShow().col) return 0;";
if (INJ === 'nogate') SRC = SRC.replace(G0, "    _colOccBell(hits, lastD) {\n        if (!lastD) return 0;");
if (INJ === 'noheld') SRC = SRC.replace("h.sym && h.sc === 'held' && ok(h.id)", "h.sym && ok(h.id)");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
ok('⓪ 抓 `_colTrigScan` 有接上 `_colOccBell`', /try \{ this\._colOccBell\(hits, lastD\); \} catch/.test(ORIG));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TMP = path.join(ROOT, '.test_colbell.html'); fs.writeFileSync(TMP, SRC);
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = []; let R = {};
try {
    const pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto('file://' + TMP);
    await pg.waitForFunction(() => typeof app !== 'undefined' && typeof app._colOccBell === 'function', null, { timeout: 60000 });
    R = await pg.evaluate(() => {
        const o = {}, iso = d => d.toISOString().slice(0, 10);
        const mkK = (n, endIso, f) => { const out = []; const e = new Date(endIso + 'T00:00:00Z'); let d = new Date(e); d.setUTCDate(d.getUTCDate() - n * 2); while (out.length < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w === 0 || w === 6) continue; out.push({ date: iso(d), open: 100, high: 101, low: 99, close: 100 + (out.length % 7) * 0.3, volume: 1000 }); } out[out.length - 1].date = endIso; if (f) f(out); return out; };
        const END = '2026-10-16', tw = mkK(220, END);
        // 前一天收在月線之上、今天收盤 92 → 跌破月線
        const brk = () => mkK(220, END, k => { const p = k[k.length - 2]; Object.assign(p, { close: 103, high: 103.5 }); Object.assign(k[k.length - 1], { open: 100, close: 92, high: 100, low: 91.5 }); });
        const run = ctx => app._colTrigEval({ tw, today: { tdy: END, wk: 5, weekday: true }, held: new Map(), bars: new Map(), fav: [], events: [], ...ctx });
        const held = run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', brk()]]) });
        const fav = held.map(h => ({ ...h, sc: h.sym ? 'fav' : h.sc }));   // 同一批條件,只是不在庫存(自選)
        o.heldIds = held.filter(h => h.sym === '2330').map(h => [h.id, h.sc, !!h.occ]);
        o.favIds = fav.filter(h => h.sym === '2330').map(h => [h.id, h.sc]);
        const calls = [], aq = app._alertQuiet, ds = app._deckShow;
        app._alertQuiet = (t, b, s) => calls.push([t, b, s]);
        const clr = () => { try { localStorage.removeItem('colOccBell_v1'); } catch (_) {} };
        clr(); app._deckShow = () => ({ col: true });
        o.b1 = app._colOccBell(held, END); o.b2 = app._colOccBell(held, END); o.b3 = app._colOccBell(held, '2026-10-19');
        clr(); o.bFav = app._colOccBell(fav, END);
        clr(); app._deckShow = () => ({ col: false }); o.bOff = app._colOccBell(held, END);
        o.calls = calls.map(c => [c[0], c[1], c[2]]);
        // ④ 數字讀 _COL_BASE
        const G = app._COL_BASE.stk.ma20_break, p0 = G && G.p; if (G) G.p = 77.7;
        const held2 = run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', brk()]]) });
        if (G) G.p = p0;
        const c2 = []; app._alertQuiet = (t, b) => c2.push(b); clr(); app._deckShow = () => ({ col: true });
        app._colOccBell(held2, END); o.c2 = c2;
        app._alertQuiet = aq; app._deckShow = ds; clr();
        return o;
    });
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
ok('① 庫存今天跌破月線 → 條件判到(scope 庫存、帶 🎲)', (R.heldIds || []).some(x => x[0] === 'ma20_break' && x[1] === 'held' && x[2]), JSON.stringify(R.heldIds));
const n1 = (R.heldIds || []).filter(x => x[1] === 'held' && x[2] && x[0] !== 'qlab_trap').length;
ok('① 🔔 記 = 庫存碰到幾條就幾筆(≥1),走 _alertQuiet、帶這一檔代號', R.b1 >= 1 && R.b1 === n1 && (R.calls || []).length >= 1 && R.calls[0][2] === '2330', JSON.stringify([R.b1, n1]));
const body = (R.calls || []).map(c => c[1]).join('\n');
ok('① 每一筆有兩行 🎲(這檔過去 / 一般股票)', (R.calls || []).slice(0, R.b1).every(c => /🎲 這檔/.test(c[1]) && /🎲 一般股票/.test(c[1])), body.slice(0, 300));
ok('② 同一天再掃 0 筆、隔天再記', R.b2 === 0 && R.b3 === R.b1, JSON.stringify([R.b1, R.b2, R.b3]));
ok('③ 決定性對照:同一批條件、只是不在庫存(自選)→ 0 筆', (R.favIds || []).length >= 1 && R.bFav === 0, JSON.stringify([R.favIds, R.bFav]));
ok('③ 決定性對照:沒打開 📰 專欄 → 0 筆', R.bOff === 0, R.bOff);
ok('④ 數字讀 `_COL_BASE`(ma20_break p 改 77.7 → 78%)', (R.c2 || []).some(b => /一般股票收盤跌破月線[^\n]*78%/.test(b)), (R.c2 || []).join(' || ').slice(0, 300));
ok('⑤ 一定寫「⛔ 不是會漲或會跌」+「照你的出場規則走」', (R.calls || []).every(c => c[1].includes('⛔ 不是會漲或會跌') && c[1].includes('照你的出場規則走')));
const txt = (R.calls || []).map(c => c[0] + '\n' + c[1]).join('\n');
ok('⑤ ⛔ 叫你賣 / 先賣 / 買回 / 減碼 / 勝率 / 方向字', !/先賣|賣掉|賣出|買回|減碼|加碼|勝率|期望值|偏多|偏空|看多|看空/.test(txt), (txt.match(/先賣|賣掉|賣出|買回|減碼|加碼|勝率|期望值|偏多|偏空|看多|看空/g) || []).join(','));
ok('⑤ ⛔ 研究字樣(lib_retailbad)', !badOf(txt).length, badOf(txt).join(','));
console.log(fails.length ? `\n❌ COLBELL_FAIL ${fails.length}` : '\n✅ COLBELL_PASS');
process.exit(fails.length ? 1 : 0);
