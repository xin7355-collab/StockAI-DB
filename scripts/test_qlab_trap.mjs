#!/usr/bin/env node
/**
 * 📐 V79.8.9 散戶 App「常見的追高買點」(觸發專欄 qlab_trap)—— 量化實驗室 16 年「比同一年隨便挑一天買還差」的那幾個
 *   ① index.html `_QLAB_SIGS` == pro.html PRO.QLAB 判「⛔ 比亂買還差」的那幾支(id / 名字);策略 == qlab_strategies.json
 *      中心參數代進去(⛔ 留著 $T);白話條件裡的數字 == 中心參數;⛔ 研究數字(只有 id / 名字 / 條件)
 *   ② 實跑 App 的 `_colTrigEval`:你的庫存今天跳空 3.5% 收紅 → qlab_trap(原因帶名字、帶 🎲:這檔碰過幾次 + 一般股票「比同一天所有股票好」
 *      vs「同一檔同一年隨便挑一天」兩個比例,數字讀 `_COL_BASE`(改 sy 跟著變);一般股票那個比例一定低於同一年隨便一天 = 跟判定同方向);
 *      同一份改跳空 2.5% → 沒有(決定性對照,門檻 3%);ETF / K 線過期 → 沒有;自選也判
 *   ③ 決策台那一格(`_deckColHtml`):出現量化實驗室那一篇、有 data-occ="stk" 的 🎲
 *   ④ 🔔 `_colTrigBell`:打開 📰 專欄 → 一檔一個原因一天只記一筆(⛔ 跳窗,走 _alertQuiet);隔天再記;
 *      沒打開 → 一筆都不記(決定性對照)
 *   ⑤ 畫面上的字 ⛔ 研究字樣(lib_retailbad)/ 勝率 / 期望值 / 方向
 *   注入:INJECT=noloop(拿掉 _colTrigEval 那一圈 → ②③ 紅)/ INJECT=nogate(拿掉「沒打開專欄不記」→ ④ 紅)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
import { expand } from './quant_lab_build.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'noloop') SRC = SRC.replace("for (const q of ((this._QLAB_SIGS || {}).bad || [])) { const id = 'ql_' + q.id;", "for (const q of []) { const id = 'ql_' + q.id;");
if (INJ === 'nogate') SRC = SRC.replace("if (!lastD || !this._deckShow().col) return 0;", "if (!lastD) return 0;");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ① 跨檔:_QLAB_SIGS == PRO.QLAB 的「比亂買還差」+ 中心參數
const PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const Q = JSON.parse((PRO.match(/\n  QLAB: (\{.*\}),\n/) || [, 'null'])[1]);
const SG = JSON.parse((ORIG.match(/\n    _QLAB_SIGS: (\{.*\}),\n/) || [, 'null'])[1]);
const DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8'));
const badQ = (Q && Q.fam || []).filter(x => x.verdict === 'bad');
ok('① _QLAB_SIGS 的 id / 名字 == PRO.QLAB 判「比亂買還差」的那幾支(順序一樣)', SG && badQ.length >= 1 && JSON.stringify(SG.bad.map(x => [x.id, x.name])) === JSON.stringify(badQ.map(x => [x.id, x.name])),
   JSON.stringify([SG && SG.bad.map(x => x.id), badQ.map(x => x.id)]));
const stOk = SG && SG.bad.every(x => { const d = DEF.families.find(f => f.id === x.id); const c = d && expand(d).find(v => v.center); const k = d && Object.keys(d.center)[0];
    return c && JSON.stringify(c.st) === JSON.stringify(x.st) && !JSON.stringify(x.st).includes('$') && x.ev === d.ev.split('$' + k).join(String(d.center[k])); });
ok('① 策略 == qlab_strategies.json 中心參數代進去、白話條件的數字 == 中心參數', stOk, SG ? JSON.stringify(SG.bad[0]).slice(0, 200) : 'null');
ok('① ⛔ 研究數字:只有 id / 名字 / 條件 / 策略', SG && SG.bad.every(x => Object.keys(x).sort().join() === 'ev,id,name,st'), SG ? Object.keys(SG.bad[0] || {}).join() : '');

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TMP = path.join(ROOT, '.test_qlab_trap.html'); fs.writeFileSync(TMP, SRC);
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = []; let R = {};
try {
    const pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto('file://' + TMP);
    await pg.waitForFunction(() => typeof app !== 'undefined' && typeof app._colTrigEval === 'function' && typeof QCORE !== 'undefined', null, { timeout: 60000 });
    R = await pg.evaluate(() => {
        const o = {}, iso = d => d.toISOString().slice(0, 10);
        const mkK = (n, endIso, f) => { const out = []; const e = new Date(endIso + 'T00:00:00Z'); let d = new Date(e); d.setUTCDate(d.getUTCDate() - n * 2); while (out.length < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w === 0 || w === 6) continue; out.push({ date: iso(d), open: 100, high: 101, low: 99, close: 100, volume: 1000 }); } out[out.length - 1].date = endIso; if (f) f(out); return out; };
        const END = '2026-10-16', tw = mkK(220, END);
        const gapK = (g, end = END) => mkK(220, end, k => { const r = k[k.length - 1], op = +(100 * (1 + g)).toFixed(2), c = +(op * 1.01).toFixed(2); Object.assign(r, { open: op, close: c, high: c, low: op }); });
        const run = ctx => app._colTrigEval({ tw, today: { tdy: END, wk: 5, weekday: true }, held: new Map(), bars: new Map(), fav: [], events: [], ...ctx });
        const H = s => new Map([[s, { cost: 0 }]]), q = h => h.filter(x => x.id === 'qlab_trap');
        const h35 = q(run({ held: H('2330'), bars: new Map([['2330', gapK(0.035)]]) }));
        o.h35 = h35.map(x => [x.sc, x.why, x.occ || '']);
        const G0 = app._COL_BASE.stk.ql_gap_up, sy0 = G0 && G0.sy; if (G0) G0.sy = 77.7;
        o.h35b = q(run({ held: H('2330'), bars: new Map([['2330', gapK(0.035)]]) })).map(x => x.occ || ''); if (G0) G0.sy = sy0;
        o.base = JSON.stringify(app._COL_BASE.stk.ql_gap_up || null);
        o.h25 = q(run({ held: H('2330'), bars: new Map([['2330', gapK(0.025)]]) })).length;
        o.fav = q(run({ bars: new Map([['2454', gapK(0.035)]]), fav: ['2454'] })).map(x => x.sc);
        o.etf = q(run({ held: H('0050'), bars: new Map([['0050', gapK(0.035)]]) })).length;
        o.stale = q(run({ held: H('2330'), bars: new Map([['2330', gapK(0.035, '2026-10-09')]]) })).length;
        // ③ 決策台那一格
        const all = run({ held: H('2330'), bars: new Map([['2330', gapK(0.035)]]) });
        const box = document.createElement('div'); box.innerHTML = app._deckColHtml(app._colTrigGroups(all));
        const hit = [...box.querySelectorAll('[data-colhit]')].find(x => /常見的買點|KD 黃金交叉/.test(x.innerText));
        o.deckTxt = hit ? hit.innerText : ''; o.deckOcc = hit ? !!hit.querySelector('[data-occ="stk"]') : false;
        // ④ 🔔
        const calls = [], aq = app._alertQuiet, ds = app._deckShow;
        app._alertQuiet = (t, b, s) => calls.push([t, b, s]);
        try { localStorage.removeItem('qlTrapBell_v1'); } catch (_) {}
        app._deckShow = () => ({ col: true });
        o.b1 = app._colTrigBell(all, END); o.b2 = app._colTrigBell(all, END); o.b3 = app._colTrigBell(all, '2026-10-19');
        app._deckShow = () => ({ col: false }); try { localStorage.removeItem('qlTrapBell_v1'); } catch (_) {}
        o.bOff = app._colTrigBell(all, '2026-10-20');
        o.calls = calls.map(c => c.join(' | '));
        app._alertQuiet = aq; app._deckShow = ds;
        return o;
    });
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
const gapName = (SG && SG.bad.find(x => x.id === 'gap_up') || {}).name || '跳空開高走高';
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
ok('② 庫存今天跳空 3.5% 收紅 → qlab_trap(scope 庫存、原因帶名字)', (R.h35 || []).length >= 1 && R.h35[0][0] === 'held' && R.h35[0][1].includes(gapName), JSON.stringify(R.h35));
ok('② 🎲 這檔碰過幾次 + 一般股票「比同一天所有股票好」+ 同一檔同一年隨便挑一天(三個數字一起)', (R.h35 || []).length >= 1 && /這檔 \d{4} 年起/.test(R.h35[0][2]) && /一般股票[^\n]*比同一天所有股票好 [\d.]+%/.test(R.h35[0][2]) && /同一檔同一年隨便挑一天買 [\d.]+%/.test(R.h35[0][2]), JSON.stringify(R.h35).slice(0, 400));
const GB = JSON.parse(R.base || 'null');
ok('② 數字讀 `_COL_BASE`(把 sy 改成 77.7 → 畫面寫 78%)', (R.h35b || []).length >= 1 && /同一檔同一年隨便挑一天買 78%/.test(R.h35b[0]), JSON.stringify(R.h35b).slice(0, 300));
ok('② 跟判定同方向:一般股票碰到的比例 < 同一檔同一年隨便一天(每一條 ql_ 都是)', SG && SG.bad.every(x => { const g = (JSON.parse(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/\n    _COL_BASE: (\{.*\}),\n/)[1]).stk || {})['ql_' + x.id]; return g && g.pool && g.p < g.sy; }), JSON.stringify(GB));
ok('② 決定性對照:同一份改成跳空 2.5% → 沒有(門檻 3%)', R.h25 === 0, R.h25);
ok('② 自選也判(scope fav);ETF / K 線過期 → 沒有', JSON.stringify(R.fav) === '["fav"]' && R.etf === 0 && R.stale === 0, JSON.stringify([R.fav, R.etf, R.stale]));
ok('③ 決策台那一格出現量化實驗室那一篇、帶 🎲(data-occ="stk")', !!R.deckTxt && R.deckOcc, String(R.deckTxt).slice(0, 200));
ok('④ 🔔 打開專欄:一檔一天只記一筆、隔天再記', R.b1 === 1 && R.b2 === 0 && R.b3 === 1, JSON.stringify([R.b1, R.b2, R.b3]));
ok('④ 決定性對照:沒打開專欄 → 一筆都不記', R.bOff === 0, R.bOff);
const txt = [...(R.h35 || []).map(x => x[1] + '\n' + x[2]), ...(R.calls || []), R.deckTxt || ''].join('\n');
ok('⑤ ⛔ 研究字樣(lib_retailbad)', !badOf(txt).length, badOf(txt).join(','));
ok('⑤ ⛔ 勝率 / 期望值 / 方向字', !/勝率|期望值|偏多|偏空|看多|看空|買進|賣出|加碼|減碼/.test(txt), (txt.match(/勝率|期望值|偏多|偏空|看多|看空|買進|賣出|加碼|減碼/g) || []).join(','));
ok('⑤ 鈴鐺那一則講「手上的照你的出場規則走」', (R.calls || []).every(c => /出場規則/.test(c)) && (R.calls || []).length >= 2, JSON.stringify(R.calls).slice(0, 200));
if (fails.length) { console.log(`❌ QLAB_TRAP_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ QLAB_TRAP_TEST_PASS');
