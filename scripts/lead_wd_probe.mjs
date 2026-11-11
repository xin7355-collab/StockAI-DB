#!/usr/bin/env node
/**
 * 📅 V82.1.1 👑 領頭羊「星期幾買最好?」—— 機率層(使用者:「近 2 次購買日都剛好遇到高點然後大跌,找週一~週五最適合進場的時機機率」)
 *
 * 做法(⛔ 第二份挑股邏輯:一律用 leader_probe 引擎自己的 rankAt + candOk,經 simulate 的 dayTrace):
 *   每一個交易日都假裝「今天收盤排名、明天開盤買 👑 前 5 名、抱 10 個交易日」→ 記:
 *     贏 0050 嗎(含息)・這 10 天內籃子收盤最多跌幾 %(≤ −8% = 「買完就大跌」)・買進價是不是之後 10 天最高(= 買在高點)・前 3 天
 *   依「買進日」是星期幾分組(一律 UTC)。大盤嚴格空頭那天 App 不買 → 主表排除(bear = 1)。
 *
 * 判斷(⛔ 跟大盤那幾週好壞混在一起):同一週裡比 —— 每週各星期減同週平均,再把「星期幾」在同一週內打亂 2,000 次當安慰劑;
 *   5 天 × 2 個主要指標(贏 0050 多少、買完就大跌的比例)一起 BH;逐年同向數;兩段窗口(16 年 / 近 4 年)。
 *   另算「連 2 次換倉都買完就大跌」:照現行每 10 個交易日一次,10 種排法都數一遍。
 *
 * 跑法:DATA_DIR=<d16> DIV=<d16>/_div16.json [WINS=2011-01-03,2022-09-16] node --max-old-space-size=8000 scripts/lead_wd_probe.mjs out.json
 *       --selftest(合成資料,不用引擎)
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, simulate, rng } from './leader_probe.mjs';
import { bhQ } from './lib_fdr.mjs';

export const WD_NAME = ['日', '一', '二', '三', '四', '五', '六'];
export const DD_TH = -8;                         // 10 天內籃子收盤最多跌 ≥ 8% = 「買完就大跌」
const r2 = x => Math.round(x * 100) / 100;
/** 星期幾一律 UTC(⛔ 本地時區會差一天)。注入 WD_INJECT=peek → 改用「決策日」(前一天)的星期 = 標錯天,selftest 必紅 */
export const wdOf = row => new Date((process.env.WD_INJECT === 'peek' ? row.dd : row.d) + 'T00:00:00Z').getUTCDay();
const monOf = d => { const t = new Date(d + 'T00:00:00Z'); const w = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - w * 86400000).toISOString().slice(0, 10); };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

/** 兩個主要指標 + 描述用指標 */
export const METRICS = {
    ex: x => x.r - x.b,                          // 10 天贏 0050 幾 %(含息)
    dd: x => (x.mdd <= DD_TH ? 1 : 0),           // 買完 10 天內最多跌 ≥ 8%
};
const DESC = { beat: x => (x.r > x.b ? 1 : 0), win: x => (x.r > 0 ? 1 : 0), top: x => x.top, ex3: x => x.r3 - x.b3, r: x => x.r, mdd: x => x.mdd };

/** 每個星期幾的平均(描述) */
export function table(rows) {
    const out = {};
    for (let w = 1; w <= 5; w++) {
        const g = rows.filter(x => wdOf(x) === w);
        out[w] = { n: g.length };
        for (const [k, f] of Object.entries({ ...METRICS, ...DESC })) out[w][k] = r2(mean(g.map(f)) * (['dd', 'beat', 'win', 'top'].includes(k) ? 100 : 1));
    }
    const all = { n: rows.length }; for (const [k, f] of Object.entries({ ...METRICS, ...DESC })) all[k] = r2(mean(rows.map(f)) * (['dd', 'beat', 'win', 'top'].includes(k) ? 100 : 1));
    return { by: out, all };
}

/** 同週比 + 週內打亂星期幾的安慰劑。回 {w: {dev, p, years:{y:dev}}} */
export function withinWeek(rows, f, iters = 2000, seed = 7) {
    const weeks = new Map();
    for (const x of rows) { const k = monOf(x.d); if (!weeks.has(k)) weeks.set(k, []); weeks.get(k).push({ w: wdOf(x), v: f(x), y: x.d.slice(0, 4) }); }
    const W = [...weeks.values()].filter(a => a.length >= 2);
    const dev = arr => { const m = mean(arr.map(z => z.v)); return arr.map(z => z.v - m); };
    const D = W.map(dev);
    const stat = lab => { const s = [0, 0, 0, 0, 0, 0, 0], c = [0, 0, 0, 0, 0, 0, 0]; W.forEach((a, i) => a.forEach((z, k) => { s[lab(i, k)] += D[i][k]; c[lab(i, k)]++; })); return s.map((v, w) => c[w] ? v / c[w] : NaN); };
    const real = stat((i, k) => W[i][k].w);
    const rand = rng(seed), ge = [0, 0, 0, 0, 0, 0, 0];
    for (let it = 0; it < iters; it++) {
        const perm = W.map(a => { const l = a.map(z => z.w); for (let k = l.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [l[k], l[j]] = [l[j], l[k]]; } return l; });
        const s = stat((i, k) => perm[i][k]);
        for (let w = 1; w <= 5; w++) if (Math.abs(s[w]) >= Math.abs(real[w]) - 1e-12) ge[w]++;
    }
    const out = {};
    for (let w = 1; w <= 5; w++) {
        const ys = {}; W.forEach((a, i) => a.forEach((z, k) => { if (z.w !== w) return; (ys[z.y] = ys[z.y] || []).push(D[i][k]); }));
        const yd = Object.fromEntries(Object.entries(ys).map(([y, a]) => [y, mean(a)]));
        const same = Object.values(yd).filter(v => Math.sign(v) === Math.sign(real[w]) && v !== 0).length;
        out[w] = { dev: real[w], p: (ge[w] + 1) / (iters + 1), years: yd, same, ny: Object.keys(yd).length };
    }
    return { weeks: W.length, by: out };
}

/** 照現行「每 10 個交易日一次」的 10 種排法,數「連 2 次換倉都買完就大跌」的比例(只看 App 會買的日子) */
export function twoInRow(rowsAll, R = 10) {
    let pairs = 0, both = 0, one = 0, n = 0;
    for (let ph = 0; ph < R; ph++) {
        const seq = rowsAll.filter((_, k) => k % R === ph).filter(x => !x.bear);
        for (let k = 0; k < seq.length; k++) { n++; if (seq[k].mdd <= DD_TH) one++; if (k) { pairs++; if (seq[k].mdd <= DD_TH && seq[k - 1].mdd <= DD_TH) both++; } }
    }
    const p = one / n;
    return { p1: r2(p * 100), pair: r2(both / pairs * 100), indep: r2(p * p * 100), pairs };
}

export function analyze(rowsAll, iters = 2000) {
    const rows = rowsAll.filter(x => !x.bear);
    const T = table(rows), WW = {};
    for (const [k, f] of Object.entries(METRICS)) WW[k] = withinWeek(rows, f, iters, k === 'ex' ? 7 : 11);
    const ps = [], keys = [];
    for (const k of Object.keys(METRICS)) for (let w = 1; w <= 5; w++) { ps.push(WW[k].by[w].p); keys.push([k, w]); }
    const q = bhQ(ps); keys.forEach(([k, w], i) => { WW[k].by[w].q = q[i]; });
    return { n: rows.length, nBear: rowsAll.length - rows.length, table: T, within: WW, two: twoInRow(rowsAll) };
}

function report(name, A) {
    console.log(`\n📅 ${name}:${A.n} 個買進日(大盤嚴格空頭不買的 ${A.nBear} 天不算)・${A.within.ex.weeks} 週`);
    console.log('  星期 | 次數 | 10 天贏 0050 機率 | 平均多賺 % | 買完就大跌(10 天內跌 ≥8%)| 買在最高 | 同週比:多賺 pp (p / q) | 同週比:大跌 pp (p / q) | 逐年同向');
    for (let w = 1; w <= 5; w++) {
        const t = A.table.by[w], e = A.within.ex.by[w], d = A.within.dd.by[w];
        console.log(`  ${WD_NAME[w]} | ${t.n} | ${t.beat}% | ${t.ex} | ${t.dd}% | ${t.top}% | ${r2(e.dev)} (${r2(e.p)} / ${r2(e.q)}) | ${r2(d.dev * 100)} (${r2(d.p)} / ${r2(d.q)}) | ${e.same}/${e.ny}`);
    }
    const a = A.table.all;
    console.log(`  全部 | ${a.n} | ${a.beat}% | ${a.ex} | ${a.dd}% | ${a.top}%`);
    console.log(`  🎲 照現行每 10 天一次:單次「買完就大跌」${A.two.p1}%・連 2 次都大跌 ${A.two.pair}%(若各次無關 ${A.two.indep}%,共 ${A.two.pairs} 對)`);
}

/** 回測層判定(事先寫死,⛔ 跑完再改):leader_probe SETS = 「現行」+ wd{1~5}k{0,1};兩段窗口各 17 條。
 *  過關 = 星期 X 兩種週別在兩段都:中位 > 現行、配對 ≥ 13/17、中途最多賠沒有差超過 3 個百分點,而且在 5 天裡都是前兩名。 */
export function cmpBoard(sets) {
    const byWin = new Map();
    for (const R of sets) { if (!byWin.has(R.from)) byWin.set(R.from, []); byWin.get(R.from).push(R); }
    const out = { wins: {}, pass: {} };
    for (const [w, arr] of byWin) {
        const base = arr.find(R => R.name === '現行'); if (!base) throw new Error(`${w} 沒有「現行」那組`);
        const rows = arr.filter(R => /^wd[1-5]k[01]$/.test(R.name)).map(R => {
            const wins = R.eqEnd.filter((v, k) => v > base.eqEnd[k]).length;
            return { name: R.name, wd: +R.name[2], wk: +R.name[4], tot: R.tot, worst: r2(Math.min(...R.eqEnd)), mdd: R.mdd, wins, dMdd: r2(R.mdd - base.mdd) };
        });
        for (const wk of [0, 1]) { const g = rows.filter(x => x.wk === wk).sort((a, b) => b.tot - a.tot); g.forEach((x, k) => { x.rank = k + 1; }); }
        const be = [...base.eqEnd].sort((a, b) => a - b);
        out.wins[w] = { base: { tot: base.tot, worst: be[0], best: be.at(-1), q1: be[4], q3: be[12], mdd: base.mdd }, rows };
    }
    for (let wd = 1; wd <= 5; wd++) {
        const cells = [...Object.values(out.wins)].flatMap(W => W.rows.filter(x => x.wd === wd).map(x => ({ x, b: W.base })));
        out.pass[wd] = cells.length === 2 * byWin.size && cells.every(({ x, b }) => x.tot > b.tot && x.wins >= 13 && x.dMdd >= -3 && x.rank <= 2);
    }
    return out;
}

function main() {
    if (process.argv[2] === '--cmp') {
        const C = cmpBoard(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).sets);
        for (const [w, W] of Object.entries(C.wins)) {
            console.log(`\n📊 ${w} 起(100 萬 → 萬,17 條中位):現行 ${r2(100 + W.base.tot)}(17 條 = 10 種換倉排法都有:最差 ${r2(100 + W.base.worst)}・第 5 條 ${r2(100 + W.base.q1)}・第 13 條 ${r2(100 + W.base.q3)}・最好 ${r2(100 + W.base.best)})・中途最多賠 ${W.base.mdd}%`);
            const inBand = W.rows.filter(x => x.tot >= W.base.worst && x.tot <= W.base.best).length;
            console.log(`  🎲 10 組星期幾 × 週別的中位,落在現行 17 條(= 換倉剛好排到哪一天的運氣)最差~最好之間:${inBand}/10`);
            for (const x of W.rows.sort((a, b) => a.wd - b.wd || a.wk - b.wk)) console.log(`  星期${WD_NAME[x.wd]}・第${x.wk ? '二' : '一'}種週別:${r2(100 + x.tot)}(最差 ${r2(100 + x.worst)})・最多賠 ${x.mdd}%(${x.dMdd >= 0 ? '+' : ''}${x.dMdd})・配對贏現行 ${x.wins}/17・5 天裡第 ${x.rank}`);
        }
        console.log('\n🧾 事先寫死的取代條件:' + [1, 2, 3, 4, 5].map(w => `星期${WD_NAME[w]} ${C.pass[w] ? '✅ 過' : '⛔ 沒過'}`).join('・'));
        return;
    }
    const out = process.argv[2], DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const t0 = Date.now(), ctx = loadCtx(DATA, DIV);
    console.log(`📂 ${ctx.meta.stocks} 檔・日曆 ${ctx.cal[0]}~${ctx.cal.at(-1)}・0050 股利 ${ctx.meta.d50} 筆`);
    if (ctx.meta.stocks < 1000 || ctx.meta.d50 < 10) { console.error('🚨 檔數 < 1000 或 0050 股利 < 10 筆,拒跑'); process.exit(1); }
    const WINS = (process.env.WINS || '2011-01-03,2022-09-16').split(',');
    const res = { meta: { from: ctx.cal[0], to: ctx.cal.at(-1), stocks: ctx.meta.stocks, dd: DD_TH }, wins: {} };
    for (const w of WINS) {
        const s0 = ctx.cal.findIndex(d => d >= w), rows = [];
        simulate(ctx, s0, { dayTrace: rows }, 1);
        if (rows.length < 300) { console.error(`🚨 ${w} 只有 ${rows.length} 筆,拒跑`); process.exit(1); }
        const A = analyze(rows, +(process.env.ITERS || 2000));
        res.wins[w] = { ...A, rows: process.env.KEEP_ROWS ? rows : undefined };
        report(`${w} 起`, A);
    }
    if (out) fs.writeFileSync(out, JSON.stringify(res));
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // 合成:2015-01-05(星期一)起 600 週的交易日;每週有一個大盤共同因子(很大),星期三另外多 +1.5%(只在 eff = true 時)
    const mk = (eff, seed) => {
        const rand = rng(seed), rows = []; let d = Date.UTC(2015, 0, 5);
        for (let wk = 0; wk < 600; wk++) {
            const mkt = (rand() - 0.5) * 20;
            for (let k = 0; k < 5; k++) {
                const day = new Date(d + (wk * 7 + k) * 86400000).toISOString().slice(0, 10), prev = new Date(d + (wk * 7 + k - (k ? 1 : 3)) * 86400000).toISOString().slice(0, 10);
                const r = mkt + (rand() - 0.5) * 8 + (eff && k === 2 ? 1.5 : 0), mdd = Math.min(0, r - 4 - rand() * 6);
                rows.push({ d: day, dd: prev, r, b: mkt * 0.3, m: mkt, mdd, top: r < 0 ? 1 : 0, r3: r / 3, b3: mkt / 4, bear: 0 });
            }
        }
        return rows;
    };
    const A1 = analyze(mk(true, 3), 500), A0 = analyze(mk(false, 3), 500);
    const qWed = A1.within.ex.by[3].q, minQ0 = Math.min(...[1, 2, 3, 4, 5].map(w => A0.within.ex.by[w].q));
    t(qWed <= 0.1 && A1.within.ex.by[3].dev > 1, `① 埋「星期三多 1.5%」→ 抓得到(同週比 +${r2(A1.within.ex.by[3].dev)}、q ${r2(qWed)})`);
    t(minQ0 > 0.1, `② 沒埋 → 5 天都抓不到(最小 q ${r2(minQ0)})`);
    // ③ 大盤好的那幾週剛好只剩星期三、五(其他天放假)→ 直接平均會以為星期三比較好;同週比要 ≈ 0(決定性對照)
    const rowsC = []; { const raw = mk(false, 5); for (let k = 0; k < raw.length; k += 5) { const wk = raw.slice(k, k + 5), good = wk[0].m > 3; for (const x of wk) if (!good || [3, 5].includes(wdOf(x))) rowsC.push(x); } }
    const A3 = analyze(rowsC, 300), naive = A3.table.by[3].ex - A3.table.by[1].ex;
    t(naive > 1 && Math.abs(A3.within.ex.by[3].dev) < 0.5, `③ 大盤好的週只剩星期三、五:直接平均星期三比星期一多 ${r2(naive)}pp、同週比 ${r2(A3.within.ex.by[3].dev)}pp ≈ 0`);
    // ④ 星期幾一律 UTC:2024-01-03 是星期三
    t(wdOf({ d: '2024-01-03', dd: '2024-01-02' }) === 3 && monOf('2024-01-07') === '2024-01-01', `④ 星期幾 UTC:2024-01-03 = 星期${WD_NAME[wdOf({ d: '2024-01-03', dd: '2024-01-02' })]}、那週一 ${monOf('2024-01-07')}`);
    // ⑤ 空頭那天排除;連 2 次大跌:每次都大跌 → 100%
    const rb = mk(true, 3).map((x, k) => ({ ...x, bear: k % 2 }));
    const Ab = analyze(rb, 100), allDD = twoInRow(mk(false, 3).map(x => ({ ...x, mdd: -20 })));
    t(Ab.n === rb.length / 2 && allDD.pair === 100 && allDD.p1 === 100, `⑤ 空頭那天不算(${Ab.n} / ${rb.length})、全部大跌 → 連 2 次 ${allDD.pair}%`);
    // ⑥ 回測層判定:星期三兩種週別兩段都贏 17/17 → 過;其他天輸 → 沒過;最多賠差 4pp → 沒過
    const mkSet = (name, from, tot, mdd) => ({ name, from, tot, mdd, eqEnd: Array.from({ length: 17 }, (_, k) => tot + k * 0.01) });
    const sets = [];
    for (const w of ['A', 'B']) { sets.push(mkSet('現行', w, 100, -40)); for (let wd = 1; wd <= 5; wd++) for (const wk of [0, 1]) sets.push(mkSet(`wd${wd}k${wk}`, w, wd === 3 ? 120 : wd === 4 ? 110 : 90 - wd, wd === 4 ? -44 : -40)); }
    const C = cmpBoard(sets);
    t(C.pass[3] && !C.pass[4] && !C.pass[1] && C.wins.A.rows.find(x => x.name === 'wd3k0').wins === 17, `⑥ 回測層判定:星期三過、星期四(最多賠多 4pp)沒過、星期一沒過`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
