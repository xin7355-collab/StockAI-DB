#!/usr/bin/env node
/**
 * 🧭 V82.1.2 👑 Walk-forward —「看板上的數字是在全部年份上挑出來的,實盤大概要打幾折?」(SELF_EVOLVING_AUDIT G3)
 *
 * 做法(⛔ 第二份挑股邏輯:每一組都跑 leader_probe 的 simulate):
 *   ① 網格 U 50/100/200 × N 3/5/8 × L 5/10/20 × R 5/10/20 × pos 0/85 = 162 組(含現行 U100 N5 L10 R10 pos85),
 *      每組 16 年(2011-01-03 起)跑 3 條起點(間隔 0 / 3 / 7 個交易日,錯開換倉排法)→ 每一組每一年的報酬(3 條平均)
 *   ② 每一年 Y 只用「Y 之前的年份」挑一組(事先寫死:訓練期複利總報酬最高;擴張窗 = 2011~Y−1、滾動 3 年 = Y−3~Y−1),
 *      套到 Y 年,一年一年串起來 = 「當時的人照規則挑」的成績
 *   ③ 跟「現行那組(全部年份挑出來的)」同一段年份比 → 膨脹率;也列網格中位、全樣本最好那組(純樣本內上限)、0050 含息
 *   ⚠️ 換組那天的換股成本沒算(各組自己的交易成本有算);2026 只到資料最後一天
 *
 * 跑法:DATA_DIR=<d16> DIV=<d16>/_div16.json node --max-old-space-size=9000 scripts/lead_wf_probe.mjs run <cache.json>(可中斷續跑,約 1 小時)
 *       node scripts/lead_wf_probe.mjs analyze <cache.json> [out.json]
 *       node scripts/lead_wf_probe.mjs --selftest(WF_INJECT=peek = 拿當年挑 → 必紅)
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, simulate, DEF } from './leader_probe.mjs';

export const GRID = { U: [50, 100, 200], N: [3, 5, 8], L: [5, 10, 20], R: [5, 10, 20], posMin: [0, 85] };
export const CUR = { U: DEF.U, N: DEF.N, L: DEF.L, R: DEF.R, posMin: DEF.posMin };
export const OFFS = [0, 3, 7];
export const FIRST_TEST = 2014;          // 前 3 年(2011~2013)只當訓練
const r2 = x => Math.round(x * 100) / 100;
export const keyOf = c => `U${c.U}_N${c.N}_L${c.L}_R${c.R}_p${c.posMin}`;
export function grid() { let out = [{}]; for (const [k, vs] of Object.entries(GRID)) out = out.flatMap(o => vs.map(v => ({ ...o, [k]: v }))); return out; }

/** 日淨值 → {年: 報酬}(年底最後一個交易日 ÷ 去年底;第一年從起點算) */
export function yearRets(eq, dates) {
    const out = {}; let prevV = eq[0], prevY = dates[0].slice(0, 4);
    for (let i = 1; i < eq.length; i++) {
        const y = dates[i].slice(0, 4);
        if (y !== prevY) { out[prevY] = eq[i - 1] / prevV - 1; prevV = eq[i - 1]; prevY = y; }
    }
    out[prevY] = eq[eq.length - 1] / prevV - 1;
    return out;
}

/** 走一遍:table = {config: {年: 報酬}};mode 'exp' 擴張窗 / 'roll3' 滾動 3 年。只用 Y 之前的年份(WF_INJECT=peek → 拿當年挑,selftest 必紅) */
export function walk(table, years, mode = 'exp', first = FIRST_TEST) {
    const peek = process.env.WF_INJECT === 'peek', keys = Object.keys(table), picks = [];
    let wealth = 1;
    for (const Y of years.filter(y => +y >= first)) {
        const train = peek ? [Y] : years.filter(y => +y < +Y && (mode === 'roll3' ? +y >= +Y - 3 : true));   // 注入:拿當年挑 = 偷看答案
        let best = null, bv = -Infinity;
        for (const k of keys) {
            let w = 1, ok = true; for (const y of train) { const r = table[k][y]; if (!Number.isFinite(r)) { ok = false; break; } w *= 1 + r; }
            if (ok && w > bv) { bv = w; best = k; }
        }
        const r = table[best][Y]; wealth *= 1 + r;
        picks.push({ Y, pick: best, r });
    }
    return { wealth, picks };
}
export function chain(rets, years, first = FIRST_TEST) { let w = 1; for (const y of years.filter(y => +y >= first)) w *= 1 + rets[y]; return w; }
const cagr = (w, nY) => (Math.pow(w, 1 / nY) - 1) * 100;

async function run(cacheFile) {
    const DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const ctx = loadCtx(DATA, DIV);
    if (ctx.meta.stocks < 1000 || ctx.meta.d50 < 10) { console.error('🚨 檔數 < 1000 或 0050 股利 < 10 筆,拒跑'); process.exit(1); }
    const s0 = ctx.cal.findIndex(d => d >= (process.env.FROM || '2011-01-03'));
    const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { meta: {}, cfg: {} };
    cache.meta = { from: ctx.cal[s0], to: ctx.cal.at(-1), stocks: ctx.meta.stocks, offs: OFFS };
    const trS = ctx.etf.tr; if (!(trS[s0] > 0)) { console.error(`🚨 起點 ${ctx.cal[s0]} 沒有 0050 含息值(_bench0050.json 不在?)`); process.exit(1); }
    cache.bench = yearRets(Array.from(trS.slice(s0)), ctx.cal.slice(s0));
    const G = grid(), t0 = Date.now();
    let done = 0;
    for (const c of G) {
        const k = keyOf(c);
        if (cache.cfg[k]) { done++; continue; }
        const ys = OFFS.map(o => { const s = s0 + o, r = simulate(ctx, s, c, 1000 + o); return yearRets(r.eq, ctx.cal.slice(s, s + r.eq.length)); });
        const yrs = Object.keys(ys[0]);
        cache.cfg[k] = Object.fromEntries(yrs.map(y => [y, ys.reduce((a, x) => a + (x[y] ?? 0), 0) / ys.length]));
        done++;
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
        console.log(`[${done}/${G.length}] ${k} 16 年 ×${r2(Object.values(cache.cfg[k]).reduce((w, r) => w * (1 + r), 1))}・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
    }
    console.log(`✅ 全部 ${G.length} 組完成`);
}

export function analyze(cache) {
    const T = cache.cfg, years = Object.keys(cache.bench).sort(), testY = years.filter(y => +y >= FIRST_TEST), nY = testY.length;
    const cur = keyOf(CUR);
    if (!T[cur]) throw new Error(`快取裡沒有現行那組 ${cur}`);
    const out = { meta: { ...cache.meta, configs: Object.keys(T).length, test: `${testY[0]}~${testY.at(-1)}`, n: nY } };
    const curW = chain(T[cur], years), b50 = chain(cache.bench, years);
    const all = Object.keys(T).map(k => ({ k, w: chain(T[k], years) })).sort((a, b) => b.w - a.w);
    const med = all[all.length >> 1];
    out.cur = { k: cur, w: curW, cagr: cagr(curW, nY), rank: all.findIndex(x => x.k === cur) + 1 };
    out.best = { k: all[0].k, w: all[0].w, cagr: cagr(all[0].w, nY) };
    out.median = { k: med.k, w: med.w, cagr: cagr(med.w, nY) };
    out.b0050 = { w: b50, cagr: cagr(b50, nY) };
    out.beat0050 = all.filter(x => x.w > b50).length;                        // 網格裡幾組贏 0050 含息(整個測試期)
    out.yrs = testY.map(y => ({ Y: y, cur: r2(T[cur][y] * 100), b: r2(cache.bench[y] * 100) }));
    for (const mode of ['exp', 'roll3']) {
        const W = walk(T, years, mode);
        out[mode] = { w: W.wealth, cagr: cagr(W.wealth, nY), picks: W.picks.map(p => ({ Y: p.Y, k: p.pick, r: r2(p.r * 100) })), beatY: W.picks.filter(p => p.r > cache.bench[p.Y]).length,
            hitCur: W.picks.filter(p => p.pick === cur).length,
            inflate: r2((1 - W.wealth / curW) * 100),                       // 現行那組的最後財富,有多少 % 是「事後挑」來的
            cagrGap: r2(cagr(curW, nY) - cagr(W.wealth, nY)) };
    }
    return out;
}

function report(A) {
    const w = x => `×${r2(x)}`;
    console.log(`\n🧭 👑 Walk-forward(${A.meta.configs} 組・${A.meta.from}~${A.meta.to}・測試年 ${A.meta.test} 共 ${A.meta.n} 年)`);
    console.log(`  現行(全部年份挑出來的)${A.cur.k}:${w(A.cur.w)}・年化 ${r2(A.cur.cagr)}%・在網格裡第 ${A.cur.rank} 名`);
    console.log(`  全樣本最好那組 ${A.best.k}:${w(A.best.w)}・年化 ${r2(A.best.cagr)}%(純樣本內上限)`);
    console.log(`  網格中位 ${A.median.k}:${w(A.median.w)}・年化 ${r2(A.median.cagr)}%`);
    console.log(`  0050 含息:${w(A.b0050.w)}・年化 ${r2(A.b0050.cagr)}%・網格 ${A.meta.configs} 組裡贏 0050 的 ${A.beat0050} 組`);
    for (const [m, name] of [['exp', '擴張窗(用之前全部年份挑)'], ['roll3', '滾動 3 年']]) {
        const X = A[m];
        console.log(`  🔁 ${name}:${w(X.w)}・年化 ${r2(X.cagr)}%(比現行少 ${X.cagrGap} 個百分點/年;現行的最後財富有 ${X.inflate}% 是事後挑來的)・挑中現行 ${X.hitCur}/${A.meta.n} 年・贏 0050 ${X.beatY}/${A.meta.n} 年`);
        console.log('     ' + X.picks.map(p => `${p.Y} ${p.k} ${p.r}%`).join(' ・'));
    }
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const years = Array.from({ length: 12 }, (_, i) => String(2011 + i));
    // ① 兩組交替好壞:去年好的今年一定壞 → 照規則挑一定挑錯(擴張窗:前面累積領先的那組下一年剛好輸)
    const A = {}, B = {}; years.forEach((y, i) => { A[y] = i % 2 ? 0.30 : -0.10; B[y] = i % 2 ? -0.10 : 0.30; });
    const W = walk({ A, B }, years, 'roll3', 2014), oracle = chain(Object.fromEntries(years.map(y => [y, 0.30])), years, 2014);
    t(W.wealth < oracle * 0.5 && W.picks.every(p => p.r < 0.3), `① 交替好壞:照前幾年挑 ×${r2(W.wealth)} 遠小於事後最好 ×${r2(oracle)}(偷看當年就會等於它)`);
    // ② 一組一直比較好 → 一定挑它、跟它一樣
    const G1 = Object.fromEntries(years.map(y => [y, 0.2])), G2 = Object.fromEntries(years.map(y => [y, 0.1]));
    const W2 = walk({ G1, G2 }, years, 'exp', 2014);
    t(W2.picks.every(p => p.pick === 'G1') && Math.abs(W2.wealth - chain(G1, years, 2014)) < 1e-9, `② 一直比較好的那組:每年都挑中、成績一樣`);
    // ③ 年報酬:跨年切對
    const yr = yearRets([1, 1.1, 1.21, 1.21 * 0.5], ['2020-12-30', '2020-12-31', '2021-01-04', '2021-01-05']);
    t(Math.abs(yr['2020'] - 0.1) < 1e-9 && Math.abs(yr['2021'] - (0.5 * 1.1 - 1)) < 1e-9, `③ 年報酬切在年底:2020 ${r2(yr['2020'] * 100)}%・2021 ${r2(yr['2021'] * 100)}%`);
    // ④ 網格 162 組、含現行
    t(grid().length === 162 && grid().some(c => keyOf(c) === keyOf(CUR)), `④ 網格 ${grid().length} 組、含現行 ${keyOf(CUR)}`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === '--selftest') process.exit(selftest());
    else if (cmd === 'run') await run(a);
    else if (cmd === 'analyze') { const A = analyze(JSON.parse(fs.readFileSync(a, 'utf8'))); report(A); if (b) fs.writeFileSync(b, JSON.stringify(A)); }
    else { console.error('用法:run <cache> | analyze <cache> [out] | --selftest'); process.exit(1); }
}
