#!/usr/bin/env node
/**
 * 🧭 V82.2.4 🔥 / 🅿️ Walk-forward —「看板上的 85 / 60 是在全部年份上挑的,實盤大概要打幾折?」(EXP-20261112-05 事先登記)
 *
 * 網格 RANK_MIN 75/80/85/90 × VOLAT_MIN 50/60/70 = 12 組;每組在 GitHub Actions(hot_wf.yml,一組一個 job)照 PROBES ①~③ 跑:
 *   d16 研究資料包 → 交易快取(ALLFIRE,這一組自己的門檻;⛔ 共用 —— 快取只留過門檻那天的 🧬,門檻不同內容就不同)
 *   → 每一晚名單前 60 筆 → list_trig 判觸發 → 17 條起點(WARMUPS 251+3k)EQUITY_OUT → 這支 `years` 算每年報酬 = 17 條中位
 * `analyze`:每個測試年 Y(2014 起)只用 2011~Y−1 挑複利最高那組(同分取離 85/60 近的)套到 Y、一年一年串起來 = WF;
 *   跟現行 85/60 同一段年份比 → 膨脹率 = 1 − WF / 現行(現行那組的最後財富有多少 % 是事後挑來的);滾動 3 年只描述。
 *   ⛔ 看結果改網格 / 改挑法(要改就重新登記)。
 *
 * 📎 V82.2.7 `b0050` + analyze 第 3 個參數:跟 0050 含息比(事後補看,⛔ 不是登記的判定;結果出來後才加的描述)——
 *   0050 每年報酬用同一支 yearRets(每年最後一天 ÷ 前一年最後一天;2011 起跑日在 1~3 月,🅿️ 那年不是整年)。
 *
 * 跑法:node scripts/hot_wf_probe.mjs years <eq 資料夾(eq_{W}.json)> <組名 R85_V60> <out.json>
 *       node scripts/hot_wf_probe.mjs b0050 <研究資料包 d16(_bench0050 + _div0050)> <out.json>
 *       node scripts/hot_wf_probe.mjs analyze <放 12 個組名.json 的資料夾> [out.json] [b0050 那個 out.json]
 *       node scripts/hot_wf_probe.mjs --selftest(WF_INJECT=peek = 拿當年挑 → ② 必紅)
 */
import fs from 'fs';
import path from 'path';
import { yearRets, chain } from './lead_wf_probe.mjs';
import { trSeries } from './lib_totalreturn.mjs';

export const GRID = { RANK_MIN: [75, 80, 85, 90], VOLAT_MIN: [50, 60, 70] };
export const CUR = 'R85_V60';
export const FIRST_TEST = 2014;
export const keyOf = (r, v) => `R${r}_V${v}`;
export const WARMUPS = Array.from({ length: 17 }, (_, k) => 251 + 3 * k);
const dist = k => { const m = String(k).match(/^R(\d+)_V(\d+)$/); return m ? Math.abs(+m[1] - 85) + Math.abs(+m[2] - 60) : 1e9; };
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const cagr = (w, nY) => (Math.pow(w, 1 / nY) - 1) * 100;

/** 一組:17 條 EQUITY_OUT → {年: 中位報酬};淨值 = cash + park + mv */
export function yearsOf(dir) {
    const files = fs.readdirSync(dir).filter(f => /^eq_\d+\.json$/.test(f)).sort();
    const per = files.map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const rows = (j.rows || []).filter(r => r && r.d); const eq = rows.map(r => (+r.cash || 0) + (+r.park || 0) + (+r.mv || 0));
        return yearRets(eq, rows.map(r => String(r.d).replace(/\//g, '-'))); });
    const ys = [...new Set(per.flatMap(o => Object.keys(o)))].sort();
    return { paths: files.length, years: Object.fromEntries(ys.map(y => [y, med(per.map(o => o[y]))])) };
}

/** 走一遍(寫死):Y 只用 Y 之前的年份(擴張窗 / 滾動 3 年)挑複利最高那組,同分取離 85/60 近的 */
export function walkHot(table, years, mode = 'exp', first = FIRST_TEST) {
    const peek = process.env.WF_INJECT === 'peek', keys = Object.keys(table).sort((a, b) => dist(a) - dist(b) || (a < b ? -1 : 1)), picks = [];
    let wealth = 1;
    for (const Y of years.filter(y => +y >= first)) {
        const train = peek ? [Y] : years.filter(y => +y < +Y && (mode === 'roll3' ? +y >= +Y - 3 : true));
        let best = null, bv = -Infinity;
        for (const k of keys) { let w = 1, ok = true; for (const y of train) { const r = table[k][y]; if (!Number.isFinite(r)) { ok = false; break; } w *= 1 + r; } if (ok && w > bv + 1e-12) { bv = w; best = k; } }
        if (best == null || !Number.isFinite(table[best][Y])) continue;
        wealth *= 1 + table[best][Y]; picks.push({ Y, pick: best, r: table[best][Y] });
    }
    return { wealth, picks };
}

export function analyzeHot(table) {
    if (!table[CUR]) throw new Error(`沒有現行那組 ${CUR}`);
    const years = Object.keys(table[CUR]).filter(y => Object.values(table).every(t => Number.isFinite(t[y]))).sort();
    const testY = years.filter(y => +y >= FIRST_TEST), nY = testY.length;
    const curW = chain(table[CUR], years), all = Object.keys(table).map(k => ({ k, w: chain(table[k], years) })).sort((a, b) => b.w - a.w);
    const out = { meta: { configs: all.length, test: `${testY[0]}~${testY.at(-1)}`, n: nY, years: years.length },
        cur: { k: CUR, w: r2(curW), cagr: r2(cagr(curW, nY)), rank: all.findIndex(x => x.k === CUR) + 1 },
        best: { k: all[0].k, w: r2(all[0].w), cagr: r2(cagr(all[0].w, nY)) }, median: { k: all[all.length >> 1].k, w: r2(all[all.length >> 1].w) },
        all: all.map(x => ({ k: x.k, w: r2(x.w), cagr: r2(cagr(x.w, nY)) })) };
    for (const mode of ['exp', 'roll3']) {
        const W = walkHot(table, years, mode);
        out[mode] = { w: r2(W.wealth), cagr: r2(cagr(W.wealth, nY)), inflate: r2((1 - W.wealth / curW) * 100), cagrGap: r2(cagr(curW, nY) - cagr(W.wealth, nY)),
            hitCur: W.picks.filter(p => p.pick === CUR).length, picks: W.picks.map(p => ({ Y: p.Y, k: p.pick, r: r2(p.r * 100) })) };
    }
    return out;
}

/** 📎 跟 0050 含息比(事後補看):b = {年: 0050 含息當年報酬(小數)};A = analyzeHot 的輸出(拿它的挑法) */
export function vs0050(table, A, b) {
    const years = Object.keys(table[CUR]).filter(y => Object.values(table).every(t => Number.isFinite(t[y])) && Number.isFinite(b[y])).sort();
    const testY = years.filter(y => +y >= FIRST_TEST), preY = years.filter(y => +y < FIRST_TEST), nY = testY.length;
    // ⛔ 0050 少一年還硬比:測試期年數要跟 analyze 一樣
    if (nY !== A.meta.n) throw new Error(`0050 的年份對不上(測試期 ${nY} 年 ≠ analyze 的 ${A.meta.n} 年)`);
    const bw = chain(b, testY, 0), pk = m => Object.fromEntries(A[m].picks.map(p => [p.Y, p.k]));
    const beat = rOf => testY.filter(y => rOf(y) > b[y]).length, E = pk('exp'), R3 = pk('roll3');
    return { cagr: r2(cagr(bw, nY)), w: r2(bw), n: nY,
        beatY: { cur: beat(y => table[CUR][y]), exp: beat(y => (table[E[y]] || {})[y]), roll3: beat(y => (table[R3[y]] || {})[y]) },
        beatAll: Object.keys(table).filter(k => chain(table[k], testY, 0) > bw).length,
        pre: preY.length ? { from: preY[0], to: preY.at(-1), cur: r2(chain(table[CUR], preY, 0)), b: r2(chain(b, preY, 0)) } : null };
}

/** 研究資料包的 0050(收盤 + 除息日收盤再投入,lib_totalreturn 同一套)→ {年: 報酬};股利太少 = 不含息 → ⛔ 寫 */
export function b0050Years(dir) {
    const bars = JSON.parse(fs.readFileSync(path.join(dir, '_bench0050.json'), 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.c > 0);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '_div0050.json'), 'utf8'));
    const d50 = Array.isArray(raw) ? raw : (raw.h || ((raw.d || raw)['0050'] || {}).h || []);
    if (d50.length < 10) throw new Error(`0050 股利只有 ${d50.length} 筆 → 不含息,⛔ 拿來比`);
    const tr = trSeries(bars, d50);
    return { from: tr.d[0], to: tr.d.at(-1), divs: d50.length, years: yearRets(tr.v, tr.d) };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① yearsOf:3 條起點、每年 +10% / +20% / +30% → 中位 +20%
    const dir = fs.mkdtempSync('/tmp/hotwf-');
    [0.1, 0.2, 0.3].forEach((g, k) => { const rows = []; let v = 1e6;
        for (let y = 2011; y <= 2013; y++) for (let m = 1; m <= 12; m++) { if (m === 1 && y > 2011) v *= 1 + g; rows.push({ d: `${y}-${String(m).padStart(2, '0')}-02`, cash: v, park: 0, mv: 0 }); }
        rows.push({ d: '2014-01-02', cash: v * (1 + g), park: 0, mv: 0 });
        fs.writeFileSync(path.join(dir, `eq_${251 + k}.json`), JSON.stringify({ rows })); });
    const Y = yearsOf(dir);
    t(Y.paths === 3 && Math.abs(Y.years['2012'] - 0.2) < 1e-9 && Math.abs(Y.years['2013'] - 0.2) < 1e-9, `① 17 條取中位:${JSON.stringify(Y.years)}`);
    // ② 挑法:A 前面都最好 → 一直挑 A;同分 → 離 85/60 近的
    const yrs = ['2011', '2012', '2013', '2014', '2015'];
    const T = { R85_V60: { 2011: 0.1, 2012: 0.1, 2013: 0.1, 2014: 0.1, 2015: 0.1 }, R75_V50: { 2011: 0.3, 2012: 0.3, 2013: 0.3, 2014: -0.2, 2015: -0.2 }, R90_V70: { 2011: 0.1, 2012: 0.1, 2013: 0.1, 2014: 0.5, 2015: 0.5 } };
    const W = walkHot(T, yrs);
    // 2014 只看 2011~2013 → R75_V50(1.3³ 最高)、當年 −20%;2015 看 2011~2014 → R90_V70(1.331×1.5)、當年 +50% → ×0.8×1.5 = 1.2
    //   WF_INJECT=peek(拿當年挑)會兩年都挑 R90_V70 → ×2.25 → 這條必紅
    t(W.picks.map(p => p.pick).join() === 'R75_V50,R90_V70' && Math.abs(W.wealth - 1.2) < 1e-9, `② 每年只用之前的年份挑(擴張窗每年重算)→ ${W.picks.map(p => p.Y + ':' + p.pick).join(' ')}、財富 ×${r2(W.wealth)}`);
    const Tt = { R90_V70: { 2011: 0.1, 2012: 0.1, 2013: 0.1, 2014: 0.2 }, R85_V60: { 2011: 0.1, 2012: 0.1, 2013: 0.1, 2014: 0.0 } };
    t(walkHot(Tt, ['2011', '2012', '2013', '2014']).picks[0].pick === 'R85_V60', '③ 同分取離 85/60 近的(⛔ 照字母)');
    // ④ 膨脹率:WF 挑到比現行差 → 正的;⑤ 注入偷看當年 → 一定挑到 R90_V70(2014、2015 最好)
    const A = analyzeHot(T);
    t(A.exp.inflate > 0 && A.cur.k === 'R85_V60', `④ 膨脹率 = 1 − WF / 現行 → ${A.exp.inflate}%`);
    // ⑤ 跟 0050 比:2014 / 2015 0050 各 +15% → 現行(+10%)兩年都輸、WF 挑的 2014 輸(−20%)2015 贏(+50%);
    //    整段贏 0050(1.3225)的只有 R90_V70(2.25);2011~2013 現行 1.331、0050 1.0×1.0×1.0
    const B = { 2011: 0, 2012: 0, 2013: 0, 2014: 0.15, 2015: 0.15 }, V = vs0050(T, A, B);
    t(V.beatY.cur === 0 && V.beatY.exp === 1 && V.beatAll === 1 && V.pre.cur === 1.33 && V.pre.b === 1 && V.w === 1.32 && V.n === 2,
        `⑤ 跟 0050 比:每年贏幾年 / 整段贏幾組 / 2011~2013 各變幾倍 → ${JSON.stringify(V)}`);
    let thr = false; try { vs0050(T, A, { 2011: 0, 2012: 0, 2013: 0, 2014: 0.15 }); } catch (_) { thr = true; }
    t(thr, '⑤b 0050 少一年 → 拒絕(⛔ 少比一年還寫結果)');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('hot_wf_probe.mjs')) {
    const [cmd, a, b, c] = process.argv.slice(2);
    if (cmd === '--selftest') process.exit(selftest());
    if (cmd === 'years') {
        const Y = yearsOf(a);
        if (Y.paths !== 17) { console.error(`🚨 ${a} 只有 ${Y.paths} 條 EQUITY_OUT(要 17)→ ⛔ 寫`); process.exit(1); }
        fs.writeFileSync(c, JSON.stringify({ k: b, ...Y }));
        console.log(`✅ ${b}:${Object.entries(Y.years).map(([y, r]) => `${y} ${r2(r * 100)}%`).join(' ・')}`);
    } else if (cmd === 'analyze') {
        const files = fs.readdirSync(a).filter(f => /^R\d+_V\d+\.json$/.test(f));
        const table = Object.fromEntries(files.map(f => { const j = JSON.parse(fs.readFileSync(path.join(a, f), 'utf8')); return [j.k, j.years]; }));
        console.log(`組數 ${files.length}(${Object.keys(table).sort().join(' ')})`);
        if (files.length < 12) console.log(`⚠️ 少了 ${12 - files.length} 組(看哪一個 job 失敗)—— 照有的算,但 ⛔ 當正式結果`);
        const A = analyzeHot(table);
        if (c) { const B = JSON.parse(fs.readFileSync(c, 'utf8')); A.b0050 = vs0050(table, A, B.years); A.b0050.src = { from: B.from, to: B.to, divs: B.divs }; }
        console.log(`測試期 ${A.meta.test}(${A.meta.n} 年)・現行 ${CUR} ×${A.cur.w}(年化 ${A.cur.cagr}%,12 組第 ${A.cur.rank})・全樣本最好 ${A.best.k} ×${A.best.w}・中位 ${A.median.k} ×${A.median.w}`);
        for (const m of ['exp', 'roll3']) console.log(`${m === 'exp' ? '⭐ 擴張窗(判定)' : '滾動 3 年(只描述)'}:WF ×${A[m].w}(年化 ${A[m].cagr}%)→ 膨脹率 ${A[m].inflate}%・年化差 ${A[m].cagrGap}pp・挑到現行 ${A[m].hitCur} 年・${A[m].picks.map(p => `${p.Y}:${p.k}`).join(' ')}`);
        if (A.b0050) { const V = A.b0050; console.log(`📎 跟 0050 含息比(事後補看,不是登記的判定):0050 ×${V.w}(年化 ${V.cagr}%)・每年贏 0050:現行 ${V.beatY.cur} / 擴張窗 ${V.beatY.exp} / 滾動 ${V.beatY.roll3}(共 ${V.n} 年)・整段贏 0050 ${V.beatAll} 組` + (V.pre ? `・${V.pre.from}~${V.pre.to} 現行 ×${V.pre.cur} vs 0050 ×${V.pre.b}` : '')); }
        if (b) fs.writeFileSync(b, JSON.stringify(A, null, 1));
    } else if (cmd === 'b0050') {
        const B = b0050Years(a);
        fs.writeFileSync(b, JSON.stringify(B));
        console.log(`✅ 0050 含息 ${B.from}~${B.to}(股利 ${B.divs} 筆):${Object.entries(B.years).map(([y, r]) => `${y} ${r2(r * 100)}%`).join(' ・')}`);
    } else { console.error('用法見檔頭'); process.exit(1); }
}
