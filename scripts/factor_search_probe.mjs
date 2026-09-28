#!/usr/bin/env node
/**
 * 🎲 factor_search_probe.mjs —— 「隨機因子搜尋挑出來的策略,樣本外還剩多少?」(外部評估 ㊷ FinPilot)
 *
 * FinPilot(hu0937/FinPilot)的 strategy_explorer.py:從因子庫隨機抽 2~4 個 + 隨機參數 + 隨機排序 + 前 N 檔、
 * 月頻再平衡 → 過「訓練 → 熊市 → 樣本外」三段門檻就存檔。這支用本站資料把**同一個抽法、同一套門檻**跑一遍,
 * 並拿「每月從流動性池隨便抽 N 檔」的安慰劑走**完全相同**的門檻 —— 問題只有一個:
 *   ⭐ 那套門檻分不分得出「有東西的組合」跟「亂挑」?
 *
 * 門檻兩版(兩版都報):
 *   bug = 照它的程式碼:t = 年化 Sharpe × √月數(多乘 √12)・樣本外門檻 = 0050「未還原價」CAGR + 5%(0050 在 2025-06 做了 1:4 分割)
 *   fix = t = 年化 Sharpe × √年數 ・樣本外門檻 = 0050 還原價 CAGR + 5%
 *
 * 窗口(⚠️ 跟 FinPilot 不同,原因:fin_deep 從 2018Q1 起,近 4 季 ROE / 去年同季要到 2019 才算得出來):
 *   訓練 2019-04 ~ 2021-12 ・熊市 2022 ・樣本外 2023-01 ~ 資料最後
 *
 * 限制(一定要跟數字一起講):
 *   - 2021 以前只有上市、而且只有「現在還活著」的股票(k66 長歷史)→ 倖存者偏誤;安慰劑吃同一個母體,所以**對照是公平的**
 *   - 季財報代理月營收(營收加速 = 最新一季 ÷ 近 4 季平均),而且資訊晚 1~2 個月(用法定截止日)
 *   - 殖利率 / 法人 / 集保 / 分點 / 董監 2021 以前沒有 → 那幾個家族不進抽籤
 *   - 報酬是**價格報酬**(不含息),0050 門檻也用價格報酬比(同一把尺);MDD 用月底淨值(比日頻樂觀)
 *
 * 跑法:
 *   DATA_DIR=$S/d10n FIN_DEEP=$S/fin_deep_now.json N=300 node scripts/factor_search_probe.mjs out.json
 *   node scripts/factor_search_probe.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { valuePrep, valueSeries } from './lib_value.mjs';

export const COST_BUY = 0.001425, COST_SELL = 0.001425 + 0.003;
export const WIN = { trainFrom: '2019-04-01', trainTo: '2021-12-31', bearFrom: '2022-01-01', bearTo: '2022-12-31', oosFrom: '2023-01-01' };
export const SPLIT0050 = { date: '2025-06-18', k: 4 };

// ── 小工具 ──
export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const d10 = s => String(s).replace(/\//g, '-').slice(0, 10);

/** 月報酬 → 統計(年化 Sharpe 用月報酬、MDD 用月底淨值) */
export function stats(rets) {
    const n = rets.length; if (!n) return null;
    let eq = 1, peak = 1, mdd = 0, s = 0, s2 = 0, win = 0;
    for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); s += r; s2 += r * r; if (r > 0) win++; }
    const mu = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mu * mu));
    const cagr = Math.pow(eq, 12 / n) - 1;
    const sharpe = sd > 0 ? mu / sd * Math.sqrt(12) : 0;
    return { n, cagr, sharpe, mdd, win: win / n, tBug: sharpe * Math.sqrt(n), tFix: sharpe * Math.sqrt(n / 12) };
}
/** Spearman 等級相關 */
export function spearman(a, b) {
    const rk = x => { const o = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
    const ra = rk(a), rb = rk(b), n = a.length; if (n < 3) return NaN;
    let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
    return 1 - 6 * d2 / (n * (n * n - 1));
}

/**
 * 月頻引擎:rebs = [{entry, exit}](索引到共同日曆),pickFn(m) 回該月要持有的代號陣列 + 每檔權重 w(= 1/topN)
 * px(sym) = {O, C} 對齊日曆的陣列(NaN = 那天沒資料)
 * 回每月淨報酬(已扣換手成本;持有中的部位不重新平衡、不算成本)
 */
export function runMonthly(rebs, pickFn, px) {
    const out = []; let prev = new Map();
    for (let m = 0; m < rebs.length; m++) {
        const { entry, exit } = rebs[m];
        const { syms, w } = pickFn(m);
        const cur = new Map();
        for (const s of syms) { const p = px(s); if (p && p.O[entry] > 0) cur.set(s, w); }
        let bought = 0, sold = 0;
        for (const [s, wt] of cur) bought += Math.max(0, wt - (prev.get(s) || 0));
        for (const [s, wt] of prev) sold += Math.max(0, wt - (cur.get(s) || 0));
        let r = 0;
        for (const [s, wt] of cur) {
            const p = px(s); let e = exit;
            let x = p.O[e]; while (!(x > 0) && e > entry) { e--; x = p.C[e]; }     // 出場那天停牌 → 用之前最後一個收盤
            if (x > 0) r += wt * (x / p.O[entry] - 1);
        }
        r -= bought * COST_BUY + sold * COST_SELL;
        out.push(r); prev = cur;
    }
    return out;
}

// ── FinPilot 抽法(只留本站 2019 起算得出來的家族)──
export const POOL = [
    { key: 'pe_max', fam: 'valuation', params: { pe: [12, 15, 18, 20, 25] } },
    { key: 'roe_min', fam: 'quality', params: { roe: [8, 10, 12, 15, 18, 20] } },
    { key: 'fcf_pos', fam: 'quality', params: {} },
    { key: 'fcf_rank', fam: 'quality', params: { pct: [30, 40, 50] } },
    { key: 'op_grow', fam: 'quality', params: { op: [0, 10, 20] } },
    { key: 'rev_grow', fam: 'revenue', params: {} },
    { key: 'rev_accel', fam: 'revenue', params: { accel: [1.05, 1.1, 1.15, 1.2] } },
    { key: 'rev_mom', fam: 'revenue', params: {} },
    { key: 'ma_bull', fam: 'technical', params: { ma: [20, 60, 120] } },
    { key: 'ma_cross', fam: 'technical', params: { long: [60, 120] } },
    { key: 'high_n', fam: 'technical', params: { n: [20, 40, 60, 90, 120] } },
    { key: 'momentum', fam: 'technical', params: { n: [20, 40, 60, 90] } },
    { key: 'low_vol', fam: 'risk', params: { n: [20, 60], pct: [30, 40] } },
    { key: 'pb_low', fam: 'book_value', params: { pb: [1.0, 1.5, 2.0, 2.5, 3.0] } },
];
export const RANKS = ['fcf', 'roe', 'rev', 'peg', 'momentum60', 'op', 'pb'];
export const VOL_K = [300, 500, 1000];
export const TOP_N = [10, 15, 20, 25, 30];

export function sampleSpec(seed) {
    const r = rng(seed * 2654435761 + 1);
    const volK = pick(r, VOL_K);
    const nExtra = (() => { const u = r() * 10; return u < 2 ? 2 : u < 7 ? 3 : 4; })();
    const sh = POOL.map(f => [r(), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const chosen = [], fams = new Set();
    for (const f of sh) { if (fams.has(f.fam)) continue; fams.add(f.fam); chosen.push({ key: f.key, p: Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, pick(r, v)])) }); if (chosen.length >= nExtra) break; }
    return { seed, volK, factors: chosen, rank: pick(r, RANKS), topN: pick(r, TOP_N) };
}
export const specName = s => `均量>${s.volK}張+` + s.factors.map(f => f.key + (Object.keys(f.p).length ? '(' + Object.values(f.p).join('/') + ')' : '')).join('+') + `|排${s.rank}|前${s.topN}`;

/** 一檔一個月的特徵是否通過某個因子;缺資料 = false(FinPilot 的 & 對 NaN 也是 false) */
export function passFactor(f, x, xs) {
    const p = f.p;
    switch (f.key) {
        case 'pe_max': return x.pe > 0 && x.pe < p.pe;
        case 'roe_min': return x.roe > p.roe;
        case 'fcf_pos': return x.fcf > 0;
        case 'fcf_rank': return x.fcfPct > 1 - p.pct / 100;
        case 'op_grow': return x.niY > p.op;
        case 'rev_grow': return x.revY > 0;
        case 'rev_accel': return x.accel > p.accel;
        case 'rev_mom': return x.revQ > 0;
        case 'ma_bull': return x.c > x['ma' + p.ma];
        case 'ma_cross': return x.ma20 > x['ma' + p.long];
        case 'high_n': return x['hi' + p.n] === true;
        case 'momentum': return x['mom' + p.n] > 0;
        case 'low_vol': return x['sdPct' + p.n] < p.pct / 100;
        case 'pb_low': return x.pb > 0 && x.pb < p.pb;
    }
    return false;
}
/** 排序值:越大越優先(pb/peg 取負) */
export function rankVal(key, x) {
    switch (key) {
        case 'fcf': return x.fcf; case 'roe': return x.roe; case 'rev': return x.revTtm;
        case 'peg': return (x.pe > 0 && x.niY > 0) ? -(x.pe / x.niY) : NaN;
        case 'momentum60': return x.mom60; case 'op': return x.niY; case 'pb': return x.pb > 0 ? -x.pb : NaN;
    }
    return NaN;
}

// ── 特徵(每個調倉日一次)──
function mean(a, i0, i1) { let s = 0, n = 0; for (let i = i0; i <= i1; i++) if (a[i] > 0) { s += a[i]; n++; } return n ? s / n : NaN; }
function techAt(P, i) {
    const C = P.C, V = P.V; if (!(C[i] > 0) || i < 125) return null;
    const x = { c: C[i], vol20: mean(V, i - 19, i) / 1000 };
    for (const ma of [20, 60, 120]) x['ma' + ma] = mean(C, i - ma + 1, i);
    for (const n of [20, 40, 60, 90]) x['mom' + n] = C[i - n] > 0 ? C[i] / C[i - n] - 1 : NaN;
    for (const n of [20, 40, 60, 90, 120]) { let mx = -Infinity, ok = 0; for (let j = i - n; j < i; j++) if (C[j] > 0) { ok++; mx = Math.max(mx, C[j]); } x['hi' + n] = ok >= n * 0.8 ? C[i] >= mx : null; }
    for (const n of [20, 60]) { const r = []; for (let j = i - n + 1; j <= i; j++) if (C[j] > 0 && C[j - 1] > 0) r.push(C[j] / C[j - 1] - 1); if (r.length >= n * 0.8) { const m = r.reduce((a, b) => a + b, 0) / r.length; x['sd' + n] = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length); } }
    return x;
}
/** 那天已公布的最後一季(照法定截止日)的索引;沒有回 −1 */
export function knownIdx(series, day) { let k = -1; for (let i = 0; i < series.length; i++) { if (series[i].pub <= day) k = i; else break; } return k; }
export function fundAt(series, day, close) {
    if (!series) return null;
    const k = knownIdx(series, day); if (k < 0) return null;
    const q = series[k];
    const byP = new Map(series.map(s => [s.p, s]));
    const y4 = byP.get(String(+q.p.slice(0, 4) - 1) + q.p.slice(4));
    const f = {};
    f.roe = q.roe4; f.pb = q.bvps > 0 ? close / q.bvps : NaN;
    f.pe = (f.pb > 0 && q.roe4 > 0) ? f.pb / (q.roe4 / 100) : NaN;            // PE = PB ÷ ROE(近 4 季)
    f.revY = q.revY; f.revQ = q.revQ;
    // 營收加速(月營收 3/12 的季代理)= 最新一季 ÷ 近 4 季平均
    let s4 = 0, ok = 0, sf = 0, okf = 0;
    for (let j = k; j > k - 4 && j >= 0; j--) { if (series[j].rev > 0) { s4 += series[j].rev; ok++; } if (Number.isFinite(series[j].fcf)) { sf += series[j].fcf; okf++; } }
    f.accel = (ok === 4 && q.rev > 0) ? q.rev / (s4 / 4) : NaN;
    f.revTtm = ok === 4 ? s4 : NaN;
    f.fcf = okf === 4 ? sf : NaN;
    f.niY = (y4 && y4.ni > 0 && Number.isFinite(q.ni) && !q.par) ? (q.ni / y4.ni - 1) * 100 : NaN;
    return f;
}
function pctRank(list, key, outKey) {
    const v = list.filter(x => Number.isFinite(x[key])).sort((a, b) => a[key] - b[key]);
    const n = v.length; v.forEach((x, i) => { x[outKey] = n > 1 ? i / (n - 1) : 0.5; });
}

// ── 主程式 ──
function loadAll(dir) {
    const tw = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8'));
    const cal = tw.map(r => d10(r.date)).filter(d => d >= '2018-06-01');
    const ix = new Map(cal.map((d, i) => [d, i]));
    const PX = new Map();
    for (const f of fs.readdirSync(dir)) {
        if (!/^[1-9]\d{3}\.json$/.test(f)) continue;
        let a; try { a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(a)) continue;
        const O = new Float64Array(cal.length).fill(NaN), C = new Float64Array(cal.length).fill(NaN), V = new Float64Array(cal.length).fill(NaN);
        let n = 0;
        for (const r of a) { const i = ix.get(d10(r.date)); if (i === undefined) continue; O[i] = +r.open; C[i] = +r.close; V[i] = +r.volume; n++; }
        if (n > 150) PX.set(f.slice(0, 4), { O, C, V });
    }
    return { cal, PX };
}
export function rebalances(cal, from) {
    const out = [];
    for (let i = 0; i < cal.length - 1; i++) if (cal[i].slice(0, 7) !== cal[i + 1].slice(0, 7) && cal[i + 1] >= from) out.push({ sig: i, entry: i + 1 });
    for (let m = 0; m < out.length; m++) out[m].exit = m + 1 < out.length ? out[m + 1].entry : cal.length - 1;
    return out.filter(r => r.exit > r.entry);
}

function main(outPath) {
    const DATA = process.env.DATA_DIR, FIN = process.env.FIN_DEEP, N = +(process.env.N || 300);
    if (!DATA || !FIN) { console.error('需要 DATA_DIR 與 FIN_DEEP'); process.exit(1); }
    const t0 = Date.now();
    const { cal, PX } = loadAll(DATA);
    const FD = JSON.parse(fs.readFileSync(FIN, 'utf8'));
    const prep = valuePrep(FD);
    const SER = new Map(); for (const s of PX.keys()) SER.set(s, valueSeries(FD, s, prep));
    const rebs = rebalances(cal, WIN.trainFrom);
    console.log(`📦 ${PX.size} 檔・日曆 ${cal[0]}~${cal.at(-1)}・調倉 ${rebs.length} 次・${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (PX.size < 500 || rebs.length < 60) { console.error('🚧 資料不足,不下結論'); process.exit(1); }

    // 每月一次特徵表
    const FEAT = rebs.map(rb => {
        const day = cal[rb.sig], list = [];
        for (const [s, P] of PX) {
            const x = techAt(P, rb.sig); if (!x) continue;
            x.s = s; Object.assign(x, fundAt(SER.get(s), day, x.c) || {});
            list.push(x);
        }
        pctRank(list, 'sd20', 'sdPct20'); pctRank(list, 'sd60', 'sdPct60'); pctRank(list, 'fcf', 'fcfPct');
        return list;
    });
    const seg = m => { const d = cal[rebs[m].entry]; return d <= WIN.trainTo ? 'train' : d <= WIN.bearTo ? 'bear' : 'oos'; };
    const segRets = rets => { const o = { train: [], bear: [], oos: [] }; rets.forEach((r, m) => o[seg(m)].push(r)); return { train: stats(o.train), bear: stats(o.bear), oos: stats(o.oos), all: stats(rets), m: o }; };
    const px = s => PX.get(s);

    const runSpec = sp => runMonthly(rebs, m => {
        const c = FEAT[m].filter(x => x.vol20 > sp.volK && sp.factors.every(f => passFactor(f, x)));
        const ranked = c.map(x => [rankVal(sp.rank, x), x.s]).filter(v => Number.isFinite(v[0])).sort((a, b) => b[0] - a[0]);
        return { syms: ranked.slice(0, sp.topN).map(v => v[1]), w: 1 / sp.topN };
    }, px);
    const runSham = sp => { const r = rng(sp.seed * 7919 + 17); return runMonthly(rebs, m => {
        const pool = FEAT[m].filter(x => x.vol20 > sp.volK).map(x => x.s);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        return { syms: pool.slice(0, sp.topN), w: 1 / sp.topN };
    }, px); };

    // 0050 基準(價格)+ FinPilot 那個未還原版
    const B = JSON.parse(fs.readFileSync(path.join(DATA, '_bench0050.json'), 'utf8')).map(r => [d10(r.date), +r.close]);
    const bAt = d => { let v = null; for (const [dd, c] of B) { if (dd <= d) v = c; else break; } return v; };
    const oosD0 = cal[rebs.find(r => cal[r.entry] >= WIN.oosFrom).entry], oosD1 = cal.at(-1);
    const yrs = (new Date(oosD1) - new Date(oosD0)) / 3.15576e10;
    const b0 = bAt(oosD0), b1 = bAt(oosD1);
    const raw = (d, c) => d < SPLIT0050.date ? c * SPLIT0050.k : c;
    const benchAdj = Math.pow(b1 / b0, 1 / yrs) - 1, benchRaw = Math.pow(raw(oosD1, b1) / raw(oosD0, b0), 1 / yrs) - 1;
    console.log(`🐢 0050 樣本外 ${oosD0}~${oosD1}:還原價 CAGR ${(benchAdj * 100).toFixed(1)}% ・未還原(FinPilot 用的)${(benchRaw * 100).toFixed(1)}%`);

    const rows = [];
    for (let i = 0; i < N; i++) {
        const sp = sampleSpec(i + 1);
        const real = segRets(runSpec(sp)), sham = segRets(runSham(sp));
        const held = real.m.train.filter(r => r !== 0).length;
        rows.push({ sp, name: specName(sp), real, sham, held });
        if ((i + 1) % 50 === 0) console.log(`   … ${i + 1}/${N}(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }

    // 門檻
    const staticOk = s => s.train && s.train.cagr > 0.06 && s.train.sharpe > 0.35 && s.train.mdd > -0.60;
    const pass = new Set(rows.filter(r => staticOk(r.real)).map(r => r));
    const P10 = a => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length * 0.1)]; };
    const dyn = pass.size >= 5 ? { cagr: P10([...pass].map(r => r.real.train.cagr)), sharpe: P10([...pass].map(r => r.real.train.sharpe)) } : { cagr: 0.06, sharpe: 0.35 };
    const gates = (s, mode) => {
        const g = { floor: staticOk(s) && s.train.cagr >= dyn.cagr && s.train.sharpe >= dyn.sharpe };
        g.t = g.floor && (mode === 'bug' ? s.train.tBug : s.train.tFix) >= 3;
        g.bear = g.t && s.bear && s.bear.mdd > -0.50;
        const need = (mode === 'bug' ? benchRaw : benchAdj) + 0.05;
        g.oos = g.bear && s.oos && s.oos.cagr > need && s.oos.sharpe > 0.8 && s.oos.mdd > s.train.mdd * 1.5;
        return g;
    };
    const count = (arm, mode) => { const c = { floor: 0, t: 0, bear: 0, oos: 0 }; for (const r of rows) { const g = gates(r[arm], mode); for (const k in c) if (g[k]) c[k]++; } return c; };
    const summ = {
        n: N, bench: { oosFrom: oosD0, oosTo: oosD1, adj: benchAdj, raw: benchRaw }, dyn,
        pass: { bug: { real: count('real', 'bug'), sham: count('sham', 'bug') }, fix: { real: count('real', 'fix'), sham: count('sham', 'fix') } },
    };
    // 訓練 → 樣本外
    const ok = rows.filter(r => r.real.train && r.real.oos && r.held >= 12);
    summ.spearman = { sharpe: spearman(ok.map(r => r.real.train.sharpe), ok.map(r => r.real.oos.sharpe)), cagr: spearman(ok.map(r => r.real.train.cagr), ok.map(r => r.real.oos.cagr)), n: ok.length };
    const okS = rows.filter(r => r.sham.train && r.sham.oos);
    summ.spearmanSham = { sharpe: spearman(okS.map(r => r.sham.train.sharpe), okS.map(r => r.sham.oos.sharpe)), cagr: spearman(okS.map(r => r.sham.train.cagr), okS.map(r => r.sham.oos.cagr)), n: okS.length };
    summ.beat0050 = { real: rows.filter(r => r.real.oos && r.real.oos.cagr > benchAdj).length, sham: rows.filter(r => r.sham.oos && r.sham.oos.cagr > benchAdj).length, best: Math.max(...rows.filter(r => r.real.oos).map(r => r.real.oos.cagr)) };
    // 只修 0050 那一條(t 仍照它的寫法):還剩幾組
    summ.onlyBenchFix = rows.filter(r => { const g = gates(r.real, 'bug'); return g.bear && r.real.oos.cagr > benchAdj + 0.05 && r.real.oos.sharpe > 0.8 && r.real.oos.mdd > r.real.train.mdd * 1.5; }).length;
    summ.trainSharpeMax = Math.max(...rows.filter(r => r.real.train).map(r => r.real.train.sharpe));
    const oosSorted = [...ok].sort((a, b) => a.real.oos.cagr - b.real.oos.cagr);
    const oosPct = r => oosSorted.indexOf(r) / Math.max(1, oosSorted.length - 1);
    summ.top5train = [...ok].sort((a, b) => b.real.train.sharpe - a.real.train.sharpe).slice(0, 5).map(r => ({ name: r.name, trainSharpe: r.real.train.sharpe, trainCagr: r.real.train.cagr, oosCagr: r.real.oos.cagr, oosSharpe: r.real.oos.sharpe, oosPct: oosPct(r) }));
    const med = a => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
    summ.median = { realOos: med(ok.map(r => r.real.oos.cagr)), shamOos: med(rows.filter(r => r.sham.oos).map(r => r.sham.oos.cagr)), realTrain: med(ok.map(r => r.real.train.cagr)), shamTrain: med(rows.filter(r => r.sham.train).map(r => r.sham.train.cagr)) };
    summ.paired = { oosRealBeatsSham: rows.filter(r => r.real.oos && r.sham.oos && r.real.oos.cagr > r.sham.oos.cagr).length, n: rows.filter(r => r.real.oos && r.sham.oos).length };
    summ.passersFix = rows.filter(r => gates(r.real, 'fix').oos).map(r => ({ name: r.name, train: r.real.train.cagr, oos: r.real.oos.cagr }));
    summ.passersBug = rows.filter(r => gates(r.real, 'bug').oos).map(r => ({ name: r.name, train: r.real.train.cagr, oos: r.real.oos.cagr, oosSharpe: r.real.oos.sharpe }));
    summ.shamPassBug = rows.filter(r => gates(r.sham, 'bug').oos).length;

    // FinPilot 公開那 5 檔的本站代理(拿不到的因子直接拿掉,並寫出來)
    const PROXY = [
        { id: 's62', drop: '董監持股>5%', sp: { seed: 62, volK: 200, factors: [{ key: 'low_vol', p: { n: 60, pct: 30 } }, { key: 'pe_max', p: { pe: 20 } }, { key: 'rev_accel', p: { accel: 1.05 } }], rank: 'momentum60', topN: 5 } },
        { id: 's118', drop: '殖利率>5%', sp: { seed: 118, volK: 100, factors: [{ key: 'op_grow', p: { op: 20 } }, { key: 'rev_accel', p: { accel: 1.05 } }, { key: 'low_vol', p: { n: 60, pct: 40 } }], rank: 'pb', topN: 10 } },
        { id: 's111', drop: '分點 BI>0.52', sp: { seed: 111, volK: 100, factors: [{ key: 'op_grow', p: { op: 0 } }, { key: 'high_n', p: { n: 40 } }, { key: 'rev_accel', p: { accel: 1.1 } }], rank: 'momentum60', topN: 10 } },
    ];
    summ.proxy = PROXY.map(({ id, drop, sp }) => { const r = segRets(runSpec(sp)), s = segRets(runSham(sp)); return { id, drop, name: specName(sp), train: r.train, bear: r.bear, oos: r.oos, shamOos: s.oos, gateBug: gates(r, 'bug'), gateFix: gates(r, 'fix') }; });

    // ── 印 ──
    const P = x => (x * 100).toFixed(1) + '%';
    console.log(`\n🎲 ${N} 組隨機組合 vs ${N} 組安慰劑(每月從流動性池隨便抽 N 檔),同一套門檻`);
    console.log(`   動態地板(真組合過靜態地板的 P10):CAGR ${P(dyn.cagr)}・Sharpe ${dyn.sharpe.toFixed(2)}`);
    for (const mode of ['bug', 'fix']) {
        const a = summ.pass[mode];
        console.log(`   [${mode === 'bug' ? 'FinPilot 原樣' : '修正版'}] 真 地板 ${a.real.floor} → t ${a.real.t} → 熊市 ${a.real.bear} → 樣本外 ${a.real.oos}  |  安慰劑 地板 ${a.sham.floor} → t ${a.sham.t} → 熊市 ${a.sham.bear} → 樣本外 ${a.sham.oos}`);
    }
    console.log(`   訓練 → 樣本外 Spearman:Sharpe ${summ.spearman.sharpe.toFixed(3)} ・CAGR ${summ.spearman.cagr.toFixed(3)}(n=${summ.spearman.n})`);
    console.log(`   (對照)安慰劑自己的 訓練 → 樣本外 Spearman:Sharpe ${summ.spearmanSham.sharpe.toFixed(3)} ・CAGR ${summ.spearmanSham.cagr.toFixed(3)}(n=${summ.spearmanSham.n})`);
    console.log(`   樣本外贏 0050 還原價(${P(benchAdj)}):真 ${summ.beat0050.real} 組・安慰劑 ${summ.beat0050.sham} 組・真組合最好 ${P(summ.beat0050.best)}`);
    console.log(`   只修 0050 那一條(t 照舊):全過 ${summ.onlyBenchFix} 組 ・訓練期最高年化 Sharpe ${summ.trainSharpeMax.toFixed(2)}(修正版 t≥3 要 ${(3 / Math.sqrt(33 / 12)).toFixed(2)})`);
    console.log(`   中位 CAGR:真 訓練 ${P(summ.median.realTrain)} → 樣本外 ${P(summ.median.realOos)} ・安慰劑 訓練 ${P(summ.median.shamTrain)} → 樣本外 ${P(summ.median.shamOos)}`);
    console.log(`   配對:樣本外真組合贏自己的安慰劑 ${summ.paired.oosRealBeatsSham}/${summ.paired.n}`);
    console.log(`   訓練期 Sharpe 前 5 名 → 樣本外:`);
    for (const t of summ.top5train) console.log(`     ${t.name}  訓練 ${t.trainSharpe.toFixed(2)}/${P(t.trainCagr)} → 樣本外 ${P(t.oosCagr)}(第 ${(t.oosPct * 100).toFixed(0)} 百分位)`);
    console.log(`   FinPilot 原樣門檻全過:真 ${summ.passersBug.length} 組・安慰劑 ${summ.shamPassBug} 組`);
    for (const p of summ.passersBug.slice(0, 8)) console.log(`     ${p.name}  訓練 ${P(p.train)} → 樣本外 ${P(p.oos)}(0050 還原 ${P(benchAdj)})`);
    console.log(`\n🧪 FinPilot 公開策略的本站代理(⚠️ 代理,不是原策略):`);
    for (const p of summ.proxy) console.log(`   ${p.id}(拿掉 ${p.drop}):訓練 ${P(p.train.cagr)}/Sh ${p.train.sharpe.toFixed(2)} ・熊市 MDD ${P(p.bear.mdd)} ・樣本外 ${P(p.oos.cagr)}/Sh ${p.oos.sharpe.toFixed(2)} ・同條件安慰劑樣本外 ${P(p.shamOos.cagr)} ・原樣門檻 ${p.gateBug.oos ? '過' : '沒過'} ・修正門檻 ${p.gateFix.oos ? '過' : '沒過'}`);
    console.log(`\n⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (outPath) fs.writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), win: WIN, ...summ, rows: rows.map(r => ({ name: r.name, train: r.real.train, bear: r.real.bear, oos: r.real.oos, shamOos: r.sham.oos })) }, null, 0));
}

// ── selftest ──
function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { if (c) { ok++; console.log('  ✅ ' + m); } else { bad++; console.log('  ❌ ' + m); } };
    // ① 引擎:兩檔、零成本換算 —— 用一樣的持股不換手,報酬 = 平均
    const O = { A: [10, 11, 12.1, 13.31], B: [10, 10, 10, 10] }, px = s => ({ O: Float64Array.from(O[s]), C: Float64Array.from(O[s]) });
    const rebs = [{ entry: 0, exit: 1 }, { entry: 1, exit: 2 }, { entry: 2, exit: 3 }];
    const r1 = runMonthly(rebs, () => ({ syms: ['A', 'B'], w: 0.5 }), px);
    const expect0 = 0.5 * 0.1 - (1.0 * COST_BUY);
    t(Math.abs(r1[0] - expect0) < 1e-9 && Math.abs(r1[1] - 0.05) < 1e-9 && Math.abs(r1[2] - 0.05) < 1e-9, `① 月報酬:第一個月含買進成本 ${r1[0].toFixed(5)},之後不換手零成本 ${r1[1].toFixed(4)}`);
    // ② 成本只算換掉的部位
    const r2 = runMonthly(rebs, m => ({ syms: m === 1 ? ['B'] : ['A'], w: 0.5 }), px);
    t(Math.abs(r2[1] - (0 - 0.5 * COST_BUY - 0.5 * COST_SELL)) < 1e-9, `② 換股那個月:買 0.5 × ${COST_BUY} + 賣 0.5 × ${COST_SELL}`);
    // ③ 財報只能在法定截止日之後用
    const ser = [{ p: '2018-12-31', pub: '2019-03-31' }, { p: '2019-03-31', pub: '2019-05-15' }];
    t(knownIdx(ser, '2019-04-30') === 0 && knownIdx(ser, '2019-05-15') === 1 && knownIdx(ser, '2019-03-30') === -1, '③ 2019-04-30 只知道 2018Q4(Q1 要 5/15 才公布)');
    // ④ t 統計量:年化 Sharpe 1、36 個月 → 修正 1.73 / FinPilot 6.0
    const s = stats(Array.from({ length: 36 }, (_, i) => (i % 2 ? 0.03 : -0.01)));
    t(Math.abs(s.tBug / s.tFix - Math.sqrt(12)) < 1e-9, `④ tBug ÷ tFix = √12(${(s.tBug / s.tFix).toFixed(3)})`);
    // ⑤ 安慰劑可重現
    const a = sampleSpec(7), b = sampleSpec(7), c = sampleSpec(8);
    t(specName(a) === specName(b) && specName(a) !== specName(c), '⑤ 同種子同組合、不同種子不同組合');
    t(new Set(sampleSpec(3).factors.map(f => POOL.find(p => p.key === f.key).fam)).size === sampleSpec(3).factors.length, '⑤b 每個家族最多一個因子');
    // ⑥ 0050 未還原:分割前 ×4 → 跨分割 CAGR 變負
    const raw = (d, c) => d < SPLIT0050.date ? c * SPLIT0050.k : c;
    t(raw('2023-01-03', 27.69) / raw('2026-02-23', 77.4) > 1 && 77.4 / 27.69 > 2.5, '⑥ 還原價漲 2.8 倍、未還原價反而跌(110.8 → 77.4)');
    // ⑦ 創 N 日新高不含今天
    const C = Float64Array.from([...Array(130)].map((_, i) => 10 + (i === 128 ? 5 : 0))); C[129] = 14;
    const x = techAt({ C, V: Float64Array.from(C, () => 1e6) }, 129);
    t(x && x.hi20 === false, '⑦ 前一天 15 → 今天 14 不算創 20 日新高(基準不含今天、含昨天)');
    // ⑧ spearman
    t(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9 && Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-9, '⑧ Spearman ±1');
    // ⑨ PE = PB ÷ ROE
    const f = fundAt([{ p: '2019-12-31', pub: '2020-03-31', roe4: 20, bvps: 50, revY: 5, revQ: 1, rev: 100, fcf: 1, ni: 10 }], '2020-04-01', 100);
    t(f && Math.abs(f.pb - 2) < 1e-9 && Math.abs(f.pe - 10) < 1e-9 && Number.isNaN(f.accel), `⑨ PB 2、ROE 20% → PE 10;不到 4 季不給營收加速`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('factor_search_probe.mjs')) {
    if (process.argv.includes('--selftest')) selftest(); else main(process.argv[2]);
}
