#!/usr/bin/env node
/**
 * 🎲 V79.8.7 觸發專欄的「發生率」(使用者 10/25:「都要用發生率去說,不能用無法查等等方式回覆」)
 *   ① 合成 K 線埋 N 次事件 → `_colOcc` 次數精確(lu / ma20_break / nh60_held / fi_streak5);同一件事 gap 天內只算一次
 *   ② ⛔ 前視:第 i 根後面換成亂數 K 線,每一個條件在第 i 根的判斷都不變;結果(`_colOutAt`)只看第 i+1~i+h 根
 *   ③ 決定性對照:把「隔天開盤漲停」改成看今天開盤(INJECT=peek)→ ② 必紅
 *   ④ `_colOccTxt`:三個比例一起(這檔 / 這檔平常 / 一般股票)、數字讀 `_COL_BASE`(改了跟著變)、次數少 / 猜不準要寫、ETF / K 線太短不印
 *   ⑤ 大盤四條:App 真的 `_colTrigEval` 逐日 == col_rate_base 的 `mktEvents`(⛔ 兩份定義分叉)
 *   ⑥ 接線:決策台 / 個股總覽那一格的 🎲 掛 `data-occ`(個股 stk / 法說會 cc / 大盤 mkt)
 *   ⑦ 嵌入的 `_COL_BASE`:每個條件都有、16 年(2010 起)、含已下市;⛔ 研究字樣、⛔ 方向 / 買賣字
 *   注入:INJECT=peek / INJECT=nobase(一般股票那段拿掉)/ INJECT=nodedup(gap 不生效)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
import { buildApp, mktEvents } from './col_rate_base.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'peek') SRC = SRC.replace("const op = +b[i + 1].open; if (!(op > 0)) return null;", "const op = +b[i].open; if (!(op > 0)) return null;");
if (INJ === 'nobase') SRC = SRC.replace(" ・一般股票${D.ev}(${G.from} 起 ${Number(G.n).toLocaleString()} 次)→ ${this._occPct(G.p)}", '');
if (INJ === 'nodedup') SRC = SRC.replace("if (i - last < D.gap || !this._colEvAt(id, b, i, sym)) continue;", "if (!this._colEvAt(id, b, i, sym)) continue;");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

const A = buildApp(SRC);
A._COL_BASE = (0, eval)('({' + (SRC.match(/\n    (_COL_BASE: \{.*\}),\n/) || [, '_COL_BASE: {}'])[1] + '})')._COL_BASE;
for (const k of ['_occPct', '_colOccTxt', '_colMktOccTxt']) {
    const m = new RegExp(`\\n    ${k}\\(`).exec(SRC); const s = SRC.indexOf('{', m.index); let d = 0, i = s;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
    A[k] = (0, eval)('({' + SRC.slice(m.index + 5, i + 1) + '})')[k];
}
// ── 合成 K 線:平日、平常每天 +0.05%,加權不動
const days = (n, y0 = 2020) => { const D = []; let t = Date.UTC(y0, 0, 2); while (D.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; } return D; };
const D = days(500);
const mk = (fn) => { let c = 50; return D.map((d, i) => { const p = c; const r = fn(i, p); c = r.c; return { date: d, open: r.o ?? p, high: Math.max(r.h ?? c, r.o ?? p, c), low: Math.min(r.o ?? p, c), close: c, volume: 1000, foreign_net: r.f ?? 0 }; }); };
const M = new Map(D.map(d => [d, 100]));
// ① 鎖漲停:第 100 / 200 / 300 根(隔天開盤在漲停、之後打開)+ 第 400、401 連兩天鎖死(隔天都開平盤)
const LU = [100, 200, 300, 400, 401], NX = [101, 201, 301];
const bLu = mk((i, p) => LU.includes(i) ? { c: A._floorTick(p * 1.1) } : NX.includes(i) ? { o: A._floorTick(p * 1.1), c: +(A._floorTick(p * 1.1) * 0.97).toFixed(2) } : { c: +(p * 1.0005).toFixed(4) });
const r1 = A._colOcc('lu', bLu, '9999', M);
ok('① 收盤鎖漲停 5 次(連兩天鎖死 = 各算一次,問的是「隔天開盤」)', r1.n === 5, JSON.stringify(r1));
ok('① 隔天開盤就在漲停 3 次(100 / 200 / 300 的隔天)', r1.k === 3, JSON.stringify([r1.n, r1.k]));
ok('① 第一次的日期 = 第 100 根', r1.f === D[100], r1.f);
// 跌破月線:一路漲,第 150 / 300 根各跌 8%
const bMa = mk((i, p) => [150, 300].includes(i) ? { c: +(p * 0.92).toFixed(2) } : { c: +(p * 1.003).toFixed(4) });
const r2 = A._colOcc('ma20_break', bMa, '9999', M);
ok('① 跌破月線 2 次', r2.n === 2, JSON.stringify(r2));
// 創 60 日新高:一路跌,第 200 根大漲 30%(之後 20 天內又創新高也不重算)
const bNh = mk((i, p) => i === 200 ? { c: +(p * 1.3).toFixed(2) } : i > 200 && i < 215 ? { c: +(p * 1.01).toFixed(4) } : { c: +(p * 0.998).toFixed(4) });
const r3 = A._colOcc('nh60_held', bNh, '9999', M);
ok('① 創 60 日新高(之後 14 天續創新高 = 同一件事)→ 1 次', r3.n === 1, JSON.stringify(r3));
// 外資連 5 天買:第 100~104、300~306 根買超
const bFi = mk((i, p) => ({ c: +(p * 1.0005).toFixed(4), f: (i >= 100 && i <= 104) || (i >= 300 && i <= 306) ? 5000 : -100 }));
const r4 = A._colOcc('fi_streak5', bFi, '9999', M);
ok('① 外資連 5 天買超 2 段 → 2 次', r4.n === 2, JSON.stringify(r4));

// ② 前視:每個條件、很多個 i,把 i 之後換成亂數 → 判斷不變
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const real = mk((i, p) => { const r = (rnd() - 0.49) * 0.12; const c = +(p * (1 + Math.max(-0.095, Math.min(0.095, r)))).toFixed(2); return { c, o: +(p * (1 + (rnd() - 0.5) * 0.04)).toFixed(2), f: Math.round((rnd() - 0.45) * 8000) }; })
    .map((r, i) => ({ ...r, margin_balance: 2000 + Math.round(800 * Math.sin(i / 17)), short_balance: 100 + Math.round(90 * Math.sin(i / 11)), trust_net: Math.round((rnd() - 0.5) * 900), dealer_net: Math.round((rnd() - 0.5) * 400) }));
const junk = (b, i) => b.slice(0, i + 1).concat(Array.from({ length: 30 }, (_, j) => ({ ...b[i], date: D[Math.min(D.length - 1, i + 1 + j)], open: 999, high: 999, low: 1, close: 1 + j, foreign_net: 99999, margin_balance: 1, short_balance: 99999 })));
let bad = [], fired = 0;
for (const id of Object.keys(A._COL_OCC)) for (let i = 30; i < real.length - 40; i += 3) {
    const a = A._colEvAt(id, real, i, '9999'), z = A._colEvAt(id, junk(real, i), i, '9999');
    if (!!a !== !!z) bad.push(`${id}@${i}`); if (a) fired++;
}
ok('② ⛔ 前視:第 i 根之後換成亂數,11 個條件的判斷全部不變', !bad.length, bad.slice(0, 5).join(','));
ok('② 有鑑別力:亂數 K 線上條件真的有成立過(⛔ 全部 0 也算過)', fired >= 30, fired);
// 結果只看後面:第 i 根(含)以前換掉 → 結果不變;第 i+1 根開盤換掉 → lunext 會變
const bLu2 = bLu.map(x => ({ ...x })); for (let j = 0; j < 100; j++) { bLu2[j].close = bLu2[j].open = bLu2[j].high = bLu2[j].low = 10 + j; }
bLu2[100] = { ...bLu[100], open: 1 };
ok('② 結果只看第 i+1 根以後(前面整段換掉,lunext / up1 不變)', A._colOutAt('lunext', bLu2, 100, M) === A._colOutAt('lunext', bLu, 100, M) && A._colOutAt('up1', bLu2, 100, M) === A._colOutAt('up1', bLu, 100, M) && A._colOutAt('lunext', bLu, 100, M) === 1);
const bLu3 = bLu.map(x => ({ ...x })); bLu3[101].open = bLu3[100].close;
ok('③ 決定性對照:第 i+1 根開盤改成平盤 → 隔天開盤漲停變成 0', A._colOutAt('lunext', bLu3, 100, M) === 0);

// ④ 那一行
const G0 = A._COL_BASE.stk || {};
const t1 = A._colOccTxt('lu', bLu, '9999', M);
ok('④ 三個比例一起(這檔 5 次 → 3 次 / 這檔平常 / 一般股票 N 次 → p%)', /這檔過去收盤鎖漲停 5 次 → 3 次/.test(t1) && /這檔平常隨便一天 [\d.]+%/.test(t1) && t1.includes(`一般股票收盤鎖漲停(${G0.lu && G0.lu.from} 起 ${G0.lu && Number(G0.lu.n).toLocaleString()} 次)→ ${A._occPct(G0.lu && G0.lu.p)}`), t1);
const t1b = A._colOccTxt('nh60_held', bNh, '9999', M);
ok('④ 次數 <5 → 先看一般股票那個比例;一律寫「⛔ 不是會漲或會跌」', /次數少/.test(t1b) && /不是會漲或會跌/.test(t1) && /不是會漲或會跌/.test(t1b), t1b);
const keep = JSON.stringify(A._COL_BASE); A._COL_BASE.stk = A._COL_BASE.stk || {}; A._COL_BASE.stk.lu = { ...G0.lu, n: 12345, p: 66.6 };
const t2 = A._colOccTxt('lu', bLu, '9999', M); A._COL_BASE = JSON.parse(keep);
ok('④ 決定性對照:`_COL_BASE` 換數字 → 畫面跟著變', /12,345 次\)→ 67%/.test(t2), t2);
ok('④ ETF(00 開頭)/ K 線太短 → 不印', A._colOccTxt('lu', bLu, '0050', M) === '' && A._colOccTxt('lu', bLu.slice(0, 100), '9999', M) === '');
ok('④ 一般股票沒有那一條 → 不印(⛔ 只印這檔自己的)', (() => { const k = JSON.stringify(A._COL_BASE); delete A._COL_BASE.stk.lu; const t = A._colOccTxt('lu', bLu, '9999', M); A._COL_BASE = JSON.parse(k); return t === ''; })());
const bMany = mk((i, p) => i % 40 === 20 ? { c: A._floorTick(p * 1.1) } : { c: +(p * 1.0005).toFixed(4) });
const t3 = A._colOccTxt('lu', bMany, '9999', M);
const own = v => { const k = JSON.stringify(A._COL_BASE); A._COL_BASE.stk.lu = { ...A._COL_BASE.stk.lu, own: v }; const t = A._colOccTxt('lu', bMany, '9999', M); A._COL_BASE = JSON.parse(k); return t; };
const tF = own(false), tT = own(true);
ok('④ 次數夠 + 一般股票說「這檔自己的次數猜不準」→ 寫出來;說猜得準 → 不寫(決定性對照)', /猜不準/.test(tF) && !/猜不準|次數少/.test(tT), JSON.stringify([tF, tT]).slice(0, 300));
const tm = A._colMktOccTxt('bear_on');
ok('④ 大盤那一行:加權幾次 → 幾次 + 平常隨便一天', /加權剛轉成空頭 \d+ 次 → \d+ 次/.test(tm) && /平常隨便一天 [\d.]+%/.test(tm), tm);

// ⑤ 大盤四條:App 真的 `_colTrigEval` == mktEvents
const twR = (() => { let c = 10000; seed = 11; return days(700, 2015).map((d, i) => { const r = i > 300 && i < 360 ? -0.012 : i > 500 && i < 520 ? -0.035 * (i % 4 === 0) : (rnd() - 0.47) * 0.03; c = +(c * (1 + r)).toFixed(2); return { date: d, open: c, high: c, low: c, close: c }; }); })();
const ev = mktEvents(A, twR);
const evArr = {}; for (const id of ['bear_on', 'bull_on', 'crash20', 'idx_drop3']) evArr[id] = twR.map((_, i) => !!ev[id](i));
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TMP = path.join(ROOT, '.test_colocc.html'); fs.writeFileSync(TMP, SRC);
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = []; let W = {};
try {
    const pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto('file://' + TMP);
    await pg.waitForFunction(() => typeof app !== 'undefined' && typeof app._colTrigEval === 'function', null, { timeout: 60000 });
    W = await pg.evaluate(({ twR, evArr, bLu }) => {
        const mis = [], cnt = {}; let tried = 0;
        for (const id of Object.keys(evArr)) cnt[id] = 0;
        for (let i = 80; i < twR.length; i++) {
            let hits; try { hits = app._colTrigEval({ tw: twR.slice(0, i + 1), today: { tdy: '2099-01-07', wk: 3, weekday: true }, held: new Map(), bars: new Map(), fav: [], events: [] }); tried++; } catch (e) { mis.push('throw ' + e.message); break; }
            for (const id of Object.keys(evArr)) { const a = hits.some(h => h.id === id), me = evArr[id][i]; if (a !== me) mis.push(`${id}@${i}:${a}/${me}`); if (me) cnt[id]++; }
        }
        // ⑥ 接線:持有 9999、最後一根鎖漲停 → 決策台那一格有 data-occ="stk"、大盤那幾條 data-occ="mkt"
        const b = bLu.slice(0, 401);
        const hits = app._colTrigEval({ tw: twR.slice(0, 520).map((r, j) => ({ ...r, date: b[Math.min(j, b.length - 1)].date })), today: { tdy: '2099-01-07', wk: 3, weekday: true }, held: new Map([['9999', { cost: 50 }]]), bars: new Map([['9999', b]]), fav: [], events: [] });
        const box = document.createElement('div'); box.innerHTML = app._deckColHtml(app._colTrigGroups(hits));
        return { mis, cnt, tried, luOcc: (hits.find(h => h.id === 'lu_held') || {}).occ || '', stk: (box.querySelector('[data-occ="stk"]') || {}).innerText || '', mkt: !!box.querySelector('[data-occ="mkt"]'), mktIds: hits.filter(h => !h.sym).map(h => h.id) };
    }, { twR, evArr, bLu });
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
const mis = W.mis || [], cnt = W.cnt || {}, tried = W.tried || 0;
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
ok('⑤ 大盤四條:App 真的 `_colTrigEval` 逐日 == mktEvents', tried > 500 && !mis.length, mis.slice(0, 5).join(' | ') || 'tried ' + tried);
ok('⑤ 有鑑別力:合成加權上四條都成立過', Object.values(cnt).every(v => v > 0), JSON.stringify(cnt));

// ⑥ 接線(原始碼)
ok('⑥ 決策台 / 個股總覽同一支 `_deckColHtml`:個股 data-occ = stk / cc,大盤 = mkt', /data-occ="\$\{h\.occk \|\| 'stk'\}"/.test(SRC) && /data-occ="mkt"/.test(SRC) && /occk = 'cc'/.test(SRC));
const nOcc = (SRC.match(/occ\('(\w+)', b, sym\)/g) || []).length, nMocc = (SRC.match(/mocc\('(\w+)'\)/g) || []).length;
ok('⑥ 實跑:持有的這檔今天鎖漲停 → 決策台那一格 data-occ="stk" 有 🎲 三個比例', /一般股票收盤鎖漲停/.test(W.stk || '') && /這檔過去收盤鎖漲停/.test(W.luOcc || ''), JSON.stringify([W.luOcc, W.stk]).slice(0, 300));
ok('⑥ 實跑:大盤條件有成立 → 那一行掛 data-occ="mkt"', (W.mktIds || []).length === 0 || W.mkt, JSON.stringify(W.mktIds));
ok('⑥ 11 個個股條件 + 4 個大盤條件都接上 🎲', nOcc === Object.keys(A._COL_OCC).length && nMocc === 4, JSON.stringify([nOcc, nMocc]));

// ⑦ 嵌入的 _COL_BASE
const B = A._COL_BASE;
ok('⑦ `_COL_BASE` 每個條件都有、n > 0', B.stk && Object.keys(A._COL_OCC).every(id => B.stk[id] && B.stk[id].n > 0), Object.keys(B.stk || {}).join(','));
ok('⑦ 16 年(2010 起)・含已下市', B.win && B.win[0] <= '2011-01-31' && /含已下市/.test(B.src || '') && B.syms >= 2000, JSON.stringify([B.win, B.syms]));
ok('⑦ 大盤四條都有', ['bear_on', 'bull_on', 'crash20', 'idx_drop3'].every(id => B.mkt && B.mkt[id] && B.mkt[id].n > 0));
const all = [t1, t3, tm, ...['bull_on', 'crash20', 'idx_drop3'].map(id => A._colMktOccTxt(id)), ...Object.keys(A._COL_OCC).map(id => A._colOccTxt(id, real, '9999', M))].join('\n');
ok('⑦ ⛔ 研究字樣(lib_retailbad)', !badOf(all).length, badOf(all).join(','));
ok('⑦ ⛔ 方向 / 買賣字(勝率 / 期望值 / 偏多 / 偏空 / 買進 / 賣出)', !/勝率|期望值|偏多|偏空|看多|看空|買進|賣出|加碼|減碼/.test(all), (all.match(/勝率|期望值|偏多|偏空|看多|看空|買進|賣出|加碼|減碼/) || [])[0]);
if (fails.length) { console.log(`❌ COLOCC_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ COLOCC_TEST_PASS');
