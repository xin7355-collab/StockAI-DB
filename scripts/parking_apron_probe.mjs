#!/usr/bin/env node
/**
 * 🛬 V80.1.3 停機坪(漲停之後連幾天窄幅整理)有沒有用 —— 19 個專案評估 4-1
 *   出處:myhhub instock/core/strategy/parking_apron.py(Apache-2.0;規則照它、程式自己寫)
 *   原規則:近 15 天內有一根漲幅 > 9.5% 而且是 15 日收盤新高;之後 3 天開盤與收盤都高於那天收盤、
 *           |收 − 開| ÷ 開 < 3%、當天漲跌 ±5% 內。
 *   原作的問題(⛔ 不照抄):① 15 天內出現過就一直成立 → 同一件事算好幾天 ② 漲停寫死 9.5%
 *           ③ 收盤選、收盤買、沒算成本、股票池用今天的清單(倖存者偏誤)。
 *
 * 我們的版本:
 *   ・漲停 = lib_limit.upLimitClose(2015-06 以前 ±7%);那天收盤 = 前 15 天(含那天)收盤最高
 *   ・整理第 N 天(預設 3)收盤才成立,而且只在「第 N 天就是今天」那一次算(⛔ 一直成立)
 *   ・隔天開盤買(開盤一價鎖漲停 = 買不到 → 剔除計數);抱 5 / 10 / 20 天收盤
 *   ・對照 = 同一天全部股票同樣買法的平均(lib_evgate,大盤抵銷);同一檔 10 天內只算一次;
 *     碰到價格斷崖的窗口剔除(lib_cliff,⛔ 整檔剔除)
 *   ・跟 🧬(一年位階 ≥85 + 20 日年化波動 ≥60,= playbook_scan hq)重疊多少 → 另外分「是 🧬 / 不是 🧬」兩組看
 *   高原:整理天數 2 / 3 / 4 × 實體寬度 2 / 3 / 4%(九格都要同號才算一片高原)
 *
 * 跑法:DATA_DIR=<d16(含已下市)> node scripts/parking_apron_probe.mjs [out.json]
 *       node scripts/parking_apron_probe.mjs --selftest
 * ⚠️ 事件層過了才值得疊到 🔥 上(PSRC=ext 那條路);沒過就寫進 LAB「沒用」。
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { baseAdd, increments, gates, fmtG } from './lib_evgate.mjs';
import { upLimitClose, lockedBar } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

export const HOLDS = [5, 10, 20], HI = 1, DEDUP = 10, LOOK = 15;
export const DAYS = [2, 3, 4], BODY = [2, 3, 4], CENTER = { days: 3, body: 3 };
const D = s => String(s || '').slice(0, 10).replace(/\//g, '-');

/** rows → 精簡陣列(價格 Float64Array、日期共用同一個字串)—— 16 年 2,400 檔整份載入時省記憶體(結果逐位相同) */
const _dtPool = new Map();
export function compact(rows) {
    const n = rows.length, o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n), dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        o[i] = +r.open; h[i] = +r.high; l[i] = +r.low; c[i] = +r.close; v[i] = +r.volume || 0;
        const d = D(r.date);
        let p = _dtPool.get(d);
        if (p === undefined) { _dtPool.set(d, d); p = d; }
        dt[i] = p;
    }
    return { n, o, h, l, c, v, dt };
}
const vkey = (days, body) => `d${days}b${body}`;

/** 第 i 根收盤:是不是「漲停之後整理第 N 天」—— ⛔ 只用 ≤ i 的資料 */
export function apronAt(o, c, dt, i, opt = {}) {
    const N = opt.days ?? 3, body = (opt.body ?? 3) / 100, mv = (opt.move ?? 5) / 100;
    const L = i - N;
    if (L < LOOK) return false;
    if (!upLimitClose(dt[L], c[L], c[L - 1])) return false;
    for (let k = L - LOOK + 1; k < L; k++) if (!(c[k] > 0) || c[k] > c[L]) return false;      // 15 日收盤新高(含那天)
    for (let k = L + 1; k <= i; k++) {
        if (!(o[k] > c[L] && c[k] > c[L])) return false;                                       // 開收都在漲停那天收盤之上
        if (Math.abs(c[k] - o[k]) / o[k] >= body) return false;                               // 實體窄
        if (!(c[k - 1] > 0) || Math.abs(c[k] / c[k - 1] - 1) > mv) return false;              // 當天漲跌 ±5% 內
    }
    return true;
}

/** 🧬 = 一年(250 根)收盤位階 ≥85 且 20 日年化波動 ≥60(playbook_scan hq / index _cbtSym geneAt 同一條)*/
export function geneAt(c, i) {
    let w = 0, le = 0;
    for (let k = Math.max(0, i - 249); k <= i; k++) if (c[k] > 0) { w++; if (c[k] <= c[i]) le++; }
    let s2 = 0, n2 = 0;
    for (let k = Math.max(1, i - 19); k <= i; k++) if (c[k - 1] > 0 && c[k] > 0) { s2 += ((c[k] - c[k - 1]) / c[k - 1]) ** 2; n2++; }
    const rank = w ? le / w * 100 : 0, vol = n2 ? Math.sqrt(s2 / n2) * Math.sqrt(252) * 100 : 0;
    return rank >= 85 && vol >= 60;
}

/** universe:[{sym, rows}] → {base:[Map per hold], ev:{變體: {all, gene, nogene: [[{d,r}] per hold]}}, skip}
 *  opt.rule(o, c, dt, i, v) 可以換掉判斷(selftest 用);opt.variants = [{days, body}] */
export function scan(U, opt = {}) {
    const variants = opt.variants || DAYS.flatMap(d => BODY.map(b => ({ days: d, body: b })));
    const base = HOLDS.map(() => new Map()), ev = {}, last = {}, skip = { lock: 0, cliff: 0, bad: 0 };
    for (const v of variants) ev[vkey(v.days, v.body)] = { all: HOLDS.map(() => []), gene: HOLDS.map(() => []), nogene: HOLDS.map(() => []) };
    for (const u of U) {
        const sym = u.sym, { n, o, h, l, c, dt } = u.A || compact(u.rows);   // loadUniverse 已經轉好(省記憶體);selftest 給 rows
        const pre = cliffPrefix(c, o);
        for (let i = LOOK + 1; i < n - 1; i++) {
            const e = o[i + 1];
            if (!(c[i] > 0) || !(e > 0)) { skip.bad++; continue; }
            if (lockedBar(dt[i + 1], c[i], o[i + 1], h[i + 1], l[i + 1]) === 1) { skip.lock++; continue; }   // 隔天開盤一價鎖漲停 = 買不到
            const rets = HOLDS.map(H => (i + H < n && c[i + H] > 0 && !cliffIn(pre, i, i + H)) ? (c[i + H] / e - 1) * 100 : null);
            rets.forEach((r, k) => { if (r != null) baseAdd(base[k], dt[i], r); });
            let g = null;
            for (const v of variants) {
                const K = vkey(v.days, v.body);
                const on = opt.rule ? opt.rule(o, c, dt, i, v) : apronAt(o, c, dt, i, v);
                if (!on) continue;
                if (cliffIn(pre, i - v.days - LOOK, i)) { skip.cliff++; continue; }   // 訊號窗口裡有斷崖 → 那根「漲停」不可信
                const lk = K + '|' + sym;
                if (last[lk] != null && i - last[lk] < DEDUP) continue;
                last[lk] = i;
                if (g == null) g = geneAt(c, i);
                rets.forEach((r, k) => { if (r == null) return; ev[K].all[k].push({ d: dt[i], r }); ev[K][g ? 'gene' : 'nogene'][k].push({ d: dt[i], r }); });
            }
        }
    }
    return { base, ev, skip };
}

function loadUniverse(dir) {
    const files = fs.readdirSync(dir).filter(f => /^[1-9]\d{3}\.json$/.test(f));
    const U = [];
    for (const f of files) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const rows = Array.isArray(j) ? j : (j.data || []); if (rows.length >= 260) U.push({ sym: f.slice(0, 4), A: compact(rows) }); } catch { }
    }
    return U;
}

function main() {
    const DIR = process.env.DATA_DIR || 'data';
    const U = loadUniverse(DIR);
    if (U.length < 300) { console.log(`❌ ${DIR} 只有 ${U.length} 檔(<300)→ 母體不夠,停`); process.exit(1); }
    const t0 = Date.now();
    const S = scan(U);
    const d0 = [...S.base[HI].keys()].sort();
    console.log(`📦 ${U.length} 檔 ・${d0[0]} ~ ${d0.at(-1)} ・隔天開盤買 ・對照 = 同一天全部股票 ・鎖漲停買不到剔除 ${S.skip.lock.toLocaleString()} 次 ・斷崖剔除 ${S.skip.cliff}`);
    const out = { meta: { dir: DIR, syms: U.length, from: d0[0], to: d0.at(-1), holds: HOLDS, dedup: DEDUP, cost: 0.44, skip: S.skip }, v: {} };
    const ck = vkey(CENTER.days, CENTER.body);
    for (const K of Object.keys(S.ev)) {
        const E = S.ev[K];
        const gs = HOLDS.map((_, hi) => gates(increments(E.all[hi], S.base[hi])));
        const gg = gates(increments(E.gene[HI], S.base[HI])), gn = gates(increments(E.nogene[HI], S.base[HI]));
        out.v[K] = { g: gs.map(g => ({ d: g.d, n: g.n, p: g.p, nPass: g.nPass, H: g.H, YR: g.YR })),
                     gene: { d: gg.d, n: gg.n, nPass: gg.nPass }, nogene: { d: gn.d, n: gn.n, nPass: gn.nPass },
                     geneShare: E.all[HI].length ? E.gene[HI].length / E.all[HI].length : null };
        const tag = K === ck ? '⭐ ' : '   ';
        console.log(tag + fmtG(`停機坪 ${K}`, gs[HI]) + `  (5日 ${gs[0].d.toFixed(2)} / 20日 ${gs[2].d.toFixed(2)})`);
        console.log(`      🧬 佔 ${(out.v[K].geneShare * 100 || 0).toFixed(0)}% ・是 🧬 ${gg.d >= 0 ? '+' : ''}${gg.d.toFixed(2)}pp(n=${gg.n}・${gg.nPass}/6)・不是 🧬 ${gn.d >= 0 ? '+' : ''}${gn.d.toFixed(2)}pp(n=${gn.n}・${gn.nPass}/6)`);
    }
    const signs = Object.values(out.v).map(x => Math.sign(x.g[HI].d));
    const c = out.v[ck];
    out.verdict = { center: ck, centerPass: c.g[HI].nPass, plateau: signs.every(s => s === signs[0]), plateauPos: signs.filter(s => s > 0).length, cells: signs.length };
    out.meta.secs = Math.round((Date.now() - t0) / 1000);
    console.log('\n' + '═'.repeat(90));
    console.log(`⭐ 中心(整理 ${CENTER.days} 天・實體 < ${CENTER.body}%):抱 ${HOLDS[HI]} 天增量 ${c.g[HI].d.toFixed(2)}pp・${c.g[HI].nPass}/6(成本 0.44)・九格同號 ${out.verdict.plateau ? '是' : '否'}(正的 ${out.verdict.plateauPos}/${signs.length})`);
    console.log('⚠️ 限制:隔天開盤買(App 是尾盤觸價買)・未計滑價 ・事件層過了才疊到 🔥 上看增量');
    const f = process.argv.slice(2).find(a => a.endsWith('.json'));
    if (f) { fs.writeFileSync(f, JSON.stringify(out, null, 1)); console.log(`💾 ${f}`); }
}

// ═══════════ 自我測試 ═══════════
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    const days = []; { const d = new Date(Date.UTC(2013, 0, 2)); while (days.length < 900) { if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
    // 一段:前面 20 天平盤 → 第 L 天漲停 → N 天窄幅整理在漲停價之上
    const mk = (startIdx, lim, N = 3, opt = {}) => {
        const rows = days.slice(0, 120).map((d, i) => ({ date: d, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
        if (startIdx < days.length && days[0] >= '2015-06-01') { }
        const L = 40, up = 100 * (1 + lim);
        rows[L] = { ...rows[L], open: 100, high: up, low: 100, close: up };
        for (let k = 1; k <= N; k++) {
            const op = opt.openBelow && k === 2 ? up * 0.99 : up * 1.005, cl = opt.wide && k === 2 ? up * 1.05 : up * 1.01;
            rows[L + k] = { ...rows[L + k], open: op, high: Math.max(op, cl) * 1.002, low: Math.min(op, cl) * 0.998, close: cl };
        }
        for (let k = L + N + 1; k < rows.length; k++) rows[k] = { ...rows[k], open: up * 1.01, high: up * 1.015, low: up * 1.005, close: up * 1.01 };
        return rows;
    };
    const arr = rows => ({ o: rows.map(r => r.open), c: rows.map(r => r.close), dt: rows.map(r => r.date) });
    // ① 2013 年(漲跌停 ±7%):漲 7% 那根算漲停 → 第 3 天成立、第 2 天 / 第 4 天 ⛔(只在「第 N 天就是今天」算一次)
    const A = arr(mk(0, 0.07));
    ok('① 2013 年漲 7% = 漲停(lib_limit)→ 整理第 3 天成立', apronAt(A.o, A.c, A.dt, 43, { days: 3, body: 3 }));
    ok('① 第 2 天 / 第 4 天 ⛔ 成立(只算「第 N 天就是今天」那一次)', !apronAt(A.o, A.c, A.dt, 42, { days: 3, body: 3 }) && !apronAt(A.o, A.c, A.dt, 44, { days: 3, body: 3 }));
    // ② 決定性對照:同一份改成 2016 年(漲跌停 ±10%)→ 漲 7% 不是漲停 → ⛔ 成立
    const A16 = { ...A, dt: A.dt.map(d => '2016' + d.slice(4)) };
    ok('② 決定性對照:同一份日期改成 2016 → 7% 不是漲停 → ⛔ 成立', !apronAt(A16.o, A16.c, A16.dt, 43, { days: 3, body: 3 }));
    // ③ 整理那幾天有一天開盤跌回漲停價以下 / 實體太寬 → ⛔
    const B = arr(mk(0, 0.07, 3, { openBelow: true })), W = arr(mk(0, 0.07, 3, { wide: true }));
    ok('③ 整理有一天開在漲停價之下 → ⛔;實體 ≥3% → ⛔', !apronAt(B.o, B.c, B.dt, 43) && !apronAt(W.o, W.c, W.dt, 43));
    // ④ 不是 15 日收盤新高(前面有更高的收盤)→ ⛔
    const R4 = mk(0, 0.07); R4[30] = { ...R4[30], close: 120, open: 119, high: 121, low: 118 };
    const A4 = arr(R4);
    ok('④ 前 15 天有更高的收盤 → ⛔(漲停那天要是 15 日收盤新高)', !apronAt(A4.o, A4.c, A4.dt, 43));
    // ⑤ ⛔ 前視:第 i 根之後的資料換成亂數,判斷一個字都不變
    const A5 = arr(mk(0, 0.07)), A5b = { o: A5.o.slice(), c: A5.c.slice(), dt: A5.dt };
    for (let k = 44; k < A5b.c.length; k++) { A5b.c[k] = 1 + k; A5b.o[k] = 2 + k; }
    ok('⑤ 第 i 根之後換成亂數 → 判斷不變(⛔ 前視)', apronAt(A5b.o, A5b.c, A5b.dt, 43) === apronAt(A5.o, A5.c, A5.dt, 43));
    // ⑥ scan:注入「停機坪之後多漲」→ 增量明顯為正;同樣的股票不注入 → ≈0(對照組真的在抵銷)
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // 合成:隨機走勢 + 偶爾一根漲停(2013 年 7%)接三天窄幅整理在漲停價之上;edge > 0 → 停機坪成立後「進場那天之後」整段價格多 edge
    //   (⛔ 加在進場那根開盤之前 = 買進價已經含進去,量不到 —— 第一版就是這樣寫錯的)
    const mkU = (nSym, edge) => Array.from({ length: nSym }, (_, s) => {
        const rows = []; let p = 50, force = 0, up = 0;
        for (let i = 0; i < days.length; i++) {
            let op = p * (1 + (rnd() - 0.5) * 0.004), cl = op * (1 + (rnd() - 0.5) * 0.03);
            if (force > 0) { op = up * (1.002 + rnd() * 0.004); cl = up * (1.004 + rnd() * 0.006); force--; }
            else if (i > 20 && i < days.length - 30 && i % 97 === (s % 50) + 20) { cl = p * 1.072; op = p * 1.01; force = 3; up = cl; }
            rows.push({ date: days[i], open: op, high: Math.max(op, cl) * 1.003, low: Math.min(op, cl) * 0.997, close: cl, volume: 1000 });
            p = cl;
        }
        if (edge) {
            const o = rows.map(r => r.open), c = rows.map(r => r.close), dt = rows.map(r => r.date);
            const hits = []; for (let i = LOOK + 1; i < rows.length - 2; i++) if (apronAt(o, c, dt, i, CENTER)) hits.push(i);
            for (const i of hits) for (let k = i + 2; k < rows.length; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= 1 + edge;
        }
        return { sym: String(1100 + s), rows };
    });
    const U0 = mkU(80, 0), S0 = scan(U0, { variants: [CENTER] }), K = vkey(CENTER.days, CENTER.body);
    const U1 = mkU(80, 0.04), S1 = scan(U1, { variants: [CENTER] });
    const g0 = gates(increments(S0.ev[K].all[0], S0.base[0])), g1 = gates(increments(S1.ev[K].all[0], S1.base[0]));
    ok('⑥ 有事件出現(合成資料真的走到停機坪)', S0.ev[K].all[0].length >= 20, S0.ev[K].all[0].length);
    ok('⑥ 注入「之後多漲 4%」→ 增量明顯 > 不注入', g1.d - g0.d > 2, `${g1.d.toFixed(2)} vs ${g0.d.toFixed(2)}`);
    // ⑦ 偷看隔天收盤的規則 → 量到大正數(報酬窗口真的在訊號之後;規則若前視一定被看見)
    const peek = (o, c, dt, i) => c[i + 1] > c[i] * 1.01;
    const S2 = scan(U0, { variants: [CENTER], rule: peek }), g2 = gates(increments(S2.ev[K].all[0], S2.base[0]));
    ok('⑦ 偷看隔天的規則 → 量到大正數(前視一定會被看見)', g2.d > 0.8, g2.d.toFixed(2));
    // ⑧ 隔天開盤一價鎖漲停 → 買不到(計數、⛔ 進對照組)
    const rowsL = days.slice(0, 60).map(d => ({ date: d, open: 10, high: 10, low: 10, close: 10, volume: 1000 }));
    rowsL[30] = { ...rowsL[30], open: 10.7, high: 10.7, low: 10.7, close: 10.7 };
    const SL = scan([{ sym: '9999', rows: rowsL }], { variants: [CENTER] });
    ok('⑧ 隔天開盤一價鎖漲停(2013 年 7%)→ 算「買不到」', SL.skip.lock === 1, SL.skip.lock);
    // ⑨ 去重:每天都亮 → 同一檔 10 天內只算一次
    const always = () => true;
    const SD = scan([{ sym: '9998', rows: U0[0].rows }], { variants: [CENTER], rule: always });
    const nA = SD.ev[K].all[HI].length, expect = Math.ceil((U0[0].rows.length - 1 - (LOOK + 1) - HOLDS[HI] + 1) / 10);
    ok('⑨ 每天都亮 → 10 天去重後約 n/10 筆', Math.abs(nA - expect) <= 2, `${nA} vs ${expect}`);
    // ⑩ 🧬 判斷:平盤一年 → 不是;最後 20 天大漲大跌又創新高 → 是
    const cf = Array.from({ length: 300 }, () => 100), ch = cf.slice();
    for (let k = 280; k < 300; k++) ch[k] = 100 + (k - 279) * 2 + (k % 2 ? 8 : -8);
    ch[299] = 200;
    ok('⑩ 🧬:平盤 → 否;最後 20 天大幅震盪又創一年新高 → 是', !geneAt(cf, 299) && geneAt(ch, 299));
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ PARKING_APRON_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

// ⛔ 被 import 的時候不跑(同 dispo_backtest IS_MAIN)
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest(); else if (IS_MAIN) main();
