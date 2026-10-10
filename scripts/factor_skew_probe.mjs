#!/usr/bin/env node
/**
 * 🧮 偏態 / alpha / beta 單因子選股 —— 外部 repo AlexChiang0208/Robo-Advisor-Backtesting 的做法(V79.0.9)
 *
 * 它的做法(module/calculate.py + backtest.py,⛔ 沒有授權 → 只參考做法,程式自己寫):
 *   每 240 個交易日,用過去 240 天算每檔的 alpha / beta(對大盤 OLS)/ 日報酬偏態 / 年報酬偏態 → 取最大的 5 檔
 *   → 最小變異配重(上限 0.2 → 5 檔時等於等權)→ 抱到下一次再平衡。宣稱年化 21.9~28.6%(大盤 5.6%)。
 *   ⚠️ 它的三個偏誤:用 2020 年市值前 150 回頭挑 2006 年的股票(倖存者)・大盤用沒含息的價格・沒扣成本。
 *
 * 本站重測(⛔ 不照抄它的偏誤):
 *   ⭐ 母體 = 每個再平衡日「過去 60 天平均成交額前 150」(只用當天以前的資料;不含 ETF)
 *   ⭐ 因子只用再平衡日(含)以前 240 天;**隔天開盤**買、下一次再平衡隔天開盤賣(零前視,selftest ①)
 *   ⭐ 等權、抱著不動(期間漂移);換手部分扣 0.44%(來回)
 *   ⭐ 對照:① 同一個母體等權(同樣不含息)② **同檔數隨機安慰劑**(每條路徑 50 個種子)③ 0050(價格 / 含息)
 *   ⭐ 17 條起點路徑(240 日每 14 天一條、月度每天一條),看配對勝場
 *   ⚠️ 限制:2011~2020 只有上市、只有 2023 年底還活著的股票(k66 資料);個股價格**沒含息**(股利歷史 2021 起才有)
 *        → 跟 0050 含息比一定吃虧(約每年 3%),**主要看「贏不贏同母體等權」與「贏不贏隨機」**
 *
 * 跑法:DATA_DIR=$S/d10n [FROM=2012-01-02] node --max-old-space-size=8000 scripts/factor_skew_probe.mjs [out.json]
 *       node scripts/factor_skew_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trSeries } from './lib_totalreturn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COST = 0.0044, WIN = 240, LIQ_WIN = 60;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** 讀資料夾 → {dates, mkt(Float64Array 收盤), S:[{sym, o, c, amt}]};日曆 = 加權的交易日 */
export function loadDir(dir) {
    const rd = f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return Array.isArray(j) ? j : j.data; };
    const tw = rd('^TWII.json');
    const dates = tw.map(r => String(r.date).replace(/\//g, '-'));
    const ix = new Map(dates.map((d, i) => [d, i]));
    const mkt = Float64Array.from(tw, r => +r.close);
    const S = [];
    for (const f of fs.readdirSync(dir)) {
        const sym = f.replace(/\.json$/, '');
        if (!f.endsWith('.json') || !/^[1-9]\d{3}$/.test(sym)) continue;   // ⛔ ETF(00 開頭)/ 指數 / 權證 / 檔案庫不收
        let rows; try { rows = rd(f); } catch (_) { continue; }
        if (!Array.isArray(rows) || rows.length < WIN + LIQ_WIN) continue;
        const o = new Float64Array(dates.length).fill(NaN), c = new Float64Array(dates.length).fill(NaN), amt = new Float64Array(dates.length).fill(NaN);
        for (const r of rows) {
            const i = ix.get(String(r.date).replace(/\//g, '-'));
            if (i === undefined || !(+r.close > 0) || !(+r.open > 0)) continue;
            o[i] = +r.open; c[i] = +r.close; amt[i] = +r.close * (+r.volume || 0);
        }
        S.push({ sym, o, c, amt });
    }
    return { dates, mkt, S };
}

/** 第 i 天(含)以前 win 天的對數日報酬;中間有缺 → null */
function rets(c, i, win) {
    if (i - win < 0) return null;
    const out = new Float64Array(win);
    for (let k = 0; k < win; k++) {
        const a = c[i - win + k], b = c[i - win + k + 1];
        if (!(a > 0) || !(b > 0)) return null;
        out[k] = Math.log(b / a);
    }
    return out;
}
const skew = r => { const n = r.length, m = mean(r); let s2 = 0, s3 = 0; for (const x of r) { const d = x - m; s2 += d * d; s3 += d * d * d; } s2 /= n; s3 /= n; return s2 > 0 ? s3 / Math.pow(s2, 1.5) : null; };
export function ols(y, x) {
    const n = y.length, mx = mean(x), my = mean(y); let sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; }
    const beta = sxx > 0 ? sxy / sxx : null;
    return { beta, alpha: beta == null ? null : my - beta * mx };
}

/** 因子值(只用 ≤ i 的收盤)。skew2 = 過去 240 個「240 日報酬」的偏態(要 480 天) */
export function factor(kind, st, mkt, i) {
    if (kind === 'skew2') {
        if (i - 2 * WIN < 0) return null;
        const r = new Float64Array(WIN);
        for (let k = 0; k < WIN; k++) { const b = st.c[i - k], a = st.c[i - k - WIN]; if (!(a > 0) || !(b > 0)) return null; r[k] = Math.log(b / a); }
        return skew(r);
    }
    const y = rets(st.c, i, WIN);
    if (!y) return null;
    if (kind === 'skew1') return skew(y);
    const x = rets(mkt, i, WIN);
    if (!x) return null;
    const f = ols(y, x);
    return kind === 'beta' ? f.beta : f.alpha;
}

/** 第 i 天的母體:過去 60 天平均成交額前 U 名(只用 ≤ i)、而且 i+1 有開盤價 */
export function universe(D, i, U = 150) {
    const cand = [];
    for (let s = 0; s < D.S.length; s++) {
        const st = D.S[s];
        if (!(st.o[i + 1] > 0) || !(st.c[i] > 0)) continue;
        let sum = 0, n = 0;
        for (let k = i - LIQ_WIN + 1; k <= i; k++) { if (st.amt[k] >= 0) { sum += st.amt[k]; n++; } }
        if (n < LIQ_WIN * 0.9) continue;
        cand.push([s, sum / n]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    return cand.slice(0, U).map(x => x[0]);
}

/** 一條路徑:從 i0 起每 R 天再平衡,pick(i, U) 回這一期要買的股票索引(等權)。
 *  回 {eq:[{i, v}](逐日收盤市值), turnover}。賣價 = 下一次再平衡隔天開盤;股票中途沒價 → 用最後一個收盤 */
export function runPath(D, i0, R, pick, cost = COST) {
    const N = D.dates.length, eq = [];
    let v = 1, prevW = null, turn = 0;
    for (let i = i0; i + 1 < N; i += R) {
        const U = universe(D, i);
        const picks = pick(i, U);
        if (!picks.length) continue;
        const inA = i + 1, outA = Math.min(N - 1, i + R + 1);
        // 換手:上一期漂移後的權重 vs 這一期等權
        const w = new Map(picks.map(s => [s, 1 / picks.length]));
        let chg = 0;
        if (prevW) { const keys = new Set([...w.keys(), ...prevW.keys()]); for (const k of keys) chg += Math.abs((w.get(k) || 0) - (prevW.get(k) || 0)); chg /= 2; } else chg = 1;
        v *= 1 - chg * cost; turn += chg;
        const entry = picks.map(s => D.S[s].o[inA]);
        const last = picks.map(s => D.S[s].o[inA]);
        for (let t = inA; t <= outA; t++) {
            let val = 0;
            for (let k = 0; k < picks.length; k++) {
                const st = D.S[picks[k]];
                const px = t === outA && i + R + 1 < N ? st.o[t] : st.c[t];
                if (px > 0) last[k] = px;
                val += last[k] / entry[k];
            }
            val /= picks.length;
            if (t < outA || i + R + 1 >= N) eq.push({ i: t, v: v * val });
            if (t === outA) {
                const tot = picks.reduce((a, s, k) => a + last[k] / entry[k], 0);
                prevW = new Map(picks.map((s, k) => [s, (last[k] / entry[k]) / tot]));
                v *= val;
            }
        }
    }
    return { eq, turn };
}

/** 逐日市值 → CAGR / MDD / 逐年 / 前後半 */
export function stats(D, eq, split = '2019-01-01') {
    if (eq.length < 2) return null;
    const yrs = (eq.length - 1) / 245;
    const cagr = Math.pow(eq[eq.length - 1].v / eq[0].v, 1 / yrs) - 1;
    let pk = -Infinity, mdd = 0; for (const p of eq) { pk = Math.max(pk, p.v); mdd = Math.min(mdd, p.v / pk - 1); }
    const byY = {}; for (const p of eq) { const y = D.dates[p.i].slice(0, 4); (byY[y] = byY[y] || [p.v, p.v])[1] = p.v; }
    const yearly = {}; let prev = null;
    for (const y of Object.keys(byY).sort()) { const st = prev ?? byY[y][0]; yearly[y] = byY[y][1] / st - 1; prev = byY[y][1]; }
    const half = (lo, hi) => { const a = eq.filter(p => D.dates[p.i] >= lo && D.dates[p.i] < hi); return a.length > 245 ? Math.pow(a[a.length - 1].v / a[0].v, 245 / (a.length - 1)) - 1 : null; };
    return { cagr, mdd, yearly, h1: half('0000', split), h2: half(split, '9999') };
}

/** 0050:同一段時間、同樣「起點隔天開盤買」;價格 / 含息兩條 */
function bench0050(dir, D, iStart, iEnd) {
    const f = path.join(dir, '_bench0050.json'); if (!fs.existsSync(f)) return null;
    const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
    const m = new Map(rows.map(r => [String(r.date).replace(/\//g, '-'), r]));
    const bars = [];
    for (let i = iStart; i <= iEnd; i++) { const r = m.get(D.dates[i]); if (r && +r.close > 0) bars.push({ d: D.dates[i], c: +r.close, o: +r.open, i }); }
    if (bars.length < 245) return null;
    const dv = path.join(dir, '_div0050.json');
    const divs = fs.existsSync(dv) ? JSON.parse(fs.readFileSync(dv, 'utf8')).d['0050'].h : [];
    const tr = trSeries(bars, divs);
    const o0 = bars[0].o;
    return { px: bars.map(b => ({ i: b.i, v: b.c / o0 })), tr: bars.map((b, k) => ({ i: b.i, v: tr.v[k] * bars[0].c / o0 })) };
}

function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

export const FACTORS = ['alpha', 'beta', 'skew1', 'skew2'];
export function makePick(D, kind, dir, N, cache) {
    return (i, U) => {
        const key = kind + ':' + i;
        let sc = cache.get(key);
        if (!sc) { sc = new Map(); for (const s of U) { const v = factor(kind, D.S[s], D.mkt, i); if (v != null && Number.isFinite(v)) sc.set(s, v); } cache.set(key, sc); }
        const arr = U.filter(s => sc.has(s)).sort((a, b) => dir * (sc.get(b) - sc.get(a)));
        return arr.slice(0, N);
    };
}
export const ewPick = (i, U) => U;
// 🎲 安慰劑:每檔一個隨機分數,**每 240 天才重抽一次**(⛔ 不可每次再平衡都重抽 —— 月度時會每月全換、
//   白白多付約 4~5%/年 的手續費,變成「很好贏」的假對照;V79.0.9 第一版就這樣,隨機 20 檔 8.1% vs 等權 13.0%)
//   → 換手主要來自母體進出與一年一次重抽,跟用 240 天窗口算的因子同一個量級(報表會印換手給你比)
export const shamPick = (N, seed) => {
    const memo = new Map();
    return (i, U) => {
        const blk = Math.floor(i / WIN), sc = s => { const k = blk * 100003 + s; if (!memo.has(k)) memo.set(k, rng(seed * 7919 + k)()); return memo.get(k); };
        return [...U].sort((a, b) => sc(a) - sc(b)).slice(0, N);
    };
};

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    // 合成資料:300 檔 × 1400 天
    const mk = (plant, seed = 3) => {
        const r = rng(seed), T = 1400, dates = [], mkt = new Float64Array(T);
        for (let t = 0; t < T; t++) { dates.push(new Date(Date.UTC(2015, 0, 1) + t * 864e5).toISOString().slice(0, 10)); }
        let m = 100; const mr = []; for (let t = 0; t < T; t++) { const x = (r() - 0.5) * 0.02; mr.push(x); m *= Math.exp(x); mkt[t] = m; }
        const S = [];
        for (let s = 0; s < 300; s++) {
            const o = new Float64Array(T), c = new Float64Array(T), amt = new Float64Array(T);
            const beta = 0.5 + r() * 1.5, jump = r() < 0.5 ? 0.06 : 0;   // 一半的股票偶爾有正跳(高偏態)
            let p = 50;
            for (let t = 0; t < T; t++) {
                let x = beta * mr[t] + (r() - 0.5) * 0.02 + (r() < 0.02 ? jump : 0) - jump * 0.02;
                if (plant && jump > 0) x += 0.002;                        // ③ 埋:高偏態那一半每天多 0.2%
                o[t] = p; p *= Math.exp(x); c[t] = p; amt[t] = p * 1000 * (1 + (s % 7));
            }
            S.push({ sym: String(1000 + s), o, c, amt });
        }
        return { dates, mkt, S };
    };
    const D = mk(false);
    // ① 零前視:把 i 以後的價格全部改掉 → 第 i 天的因子值不變
    const i = 700, st = D.S[5];
    const f1 = ['alpha', 'beta', 'skew1', 'skew2'].map(k => factor(k, st, D.mkt, i));
    const c2 = Float64Array.from(st.c); for (let t = i + 1; t < c2.length; t++) c2[t] *= 3;
    const m2 = Float64Array.from(D.mkt); for (let t = i + 1; t < m2.length; t++) m2[t] *= 0.3;
    const f2 = ['alpha', 'beta', 'skew1', 'skew2'].map(k => factor(k, { ...st, c: c2 }, m2, i));
    ok('① 改掉第 i 天以後的價格 → 四個因子值都不變(零前視)', JSON.stringify(f1) === JSON.stringify(f2), JSON.stringify([f1, f2]));
    // ② OLS
    const x = Array.from({ length: 500 }, (_, k) => Math.sin(k) * 0.01), y = x.map((v, k) => 1.5 * v + 0.0003 + Math.cos(k * 7) * 0.0001);
    const o = ols(y, x);
    ok('② OLS 抓得到 beta 1.5 / alpha 0.0003', Math.abs(o.beta - 1.5) < 0.02 && Math.abs(o.alpha - 0.0003) < 0.0001, JSON.stringify(o));
    // ③ 埋邊際:高偏態那一半每天 +0.2% → skew1 取最大的 20 檔要贏同母體等權
    const P = mk(true), cache = new Map();
    const a = stats(P, runPath(P, 500, 60, makePick(P, 'skew1', 1, 20, cache)).eq);
    const e = stats(P, runPath(P, 500, 60, ewPick).eq);
    ok('③ 埋「高偏態那一半每天 +0.2%」→ 偏態最大 20 檔年化贏同母體等權', a.cagr > e.cagr + 0.05, `${a.cagr} vs ${e.cagr}`);
    // ④ 安慰劑 ≈ 同母體等權
    const sh = [1, 2, 3, 4, 5, 6, 7, 8].map(sd => stats(D, runPath(D, 500, 60, shamPick(20, sd)).eq).cagr);
    const e0 = stats(D, runPath(D, 500, 60, ewPick).eq).cagr;
    ok('④ 沒埋 → 隨機 20 檔中位數 ≈ 同母體等權(|差| < 3%)', Math.abs(median(sh) - e0) < 0.03, `${median(sh)} vs ${e0}`);
    // ④b 安慰劑同一個 240 天區塊內不換股(⛔ 每次再平衡都重抽 = 假對照)
    const sp = shamPick(5, 3), Ux = D.S.map((_, k) => k);
    ok('④b 安慰劑在同一個 240 天區塊內挑的一樣(⛔ 每月重抽會多付手續費、變成很好贏)', sp(500, Ux).join() === sp(521, Ux).join() && sp(500, Ux).join() !== sp(500 + WIN, Ux).join());
    // ⑤ 成本
    const c0 = stats(D, runPath(D, 500, 20, shamPick(5, 9), 0).eq).cagr, c1 = stats(D, runPath(D, 500, 20, shamPick(5, 9), 0.0044).eq).cagr;
    ok('⑤ 扣成本 → 年化變低', c1 < c0, `${c1} vs ${c0}`);
    // ⑥ 母體只用當天以前:把第 i 天以後的成交額改掉 → 母體不變
    const U1 = universe(D, 700).join(); const D2 = { ...D, S: D.S.map(s => { const amt = Float64Array.from(s.amt); for (let t = 701; t < amt.length; t++) amt[t] = Math.random() * 1e12; return { ...s, amt }; }) };
    ok('⑥ 母體(成交額前 150)只用當天以前', universe(D2, 700).join() === U1);
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ FACTORSKEW_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const dir = process.env.DATA_DIR;
    if (!dir || !fs.existsSync(path.join(dir, '^TWII.json'))) { console.error('❌ 要 DATA_DIR(含 ^TWII.json 的 K 線資料夾,長歷史用 d10n)'); process.exit(1); }
    const t0 = Date.now();
    const D = loadDir(dir);
    const FROM = process.env.FROM || '2012-01-02';
    const iFrom = D.dates.findIndex(d => d >= FROM);
    console.log(`📦 ${D.S.length} 檔 ・日曆 ${D.dates[0]} ~ ${D.dates[D.dates.length - 1]} ・從 ${D.dates[iFrom]} 起 ・${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const SETUPS = [{ R: 240, N: 5, step: 14 }, { R: 240, N: 20, step: 14 }, { R: 21, N: 5, step: 1 }, { R: 21, N: 20, step: 1 }];
    const PATHS = 17, SHAMS = +(process.env.SHAMS || 30);
    const cache = new Map();
    const out = { generated: new Date().toISOString(), from: D.dates[iFrom], to: D.dates[D.dates.length - 1], n: D.S.length, setups: [] };
    for (const su of SETUPS) {
        const starts = Array.from({ length: PATHS }, (_, k) => iFrom + k * su.step);
        const ew = starts.map(s => stats(D, runPath(D, s, su.R, ewPick).eq));
        const shamRuns = starts.map((s, k) => Array.from({ length: SHAMS }, (_, j) => runPath(D, s, su.R, shamPick(su.N, 1000 * k + j + 1))));
        const sham = shamRuns.map(rs => rs.map(r => stats(D, r.eq).cagr));
        const shamTurn = median(shamRuns.flat().map(r => r.turn / ((r.eq.length - 1) / 245)));
        const b50 = starts.map(s => bench0050(dir, D, s + 1, D.dates.length - 1));
        const b50s = b50.map(b => b && { px: stats(D, b.px), tr: stats(D, b.tr) });
        const shamMed = sham.map(median);
        console.log(`\n══ 每 ${su.R} 天換一次 ・${su.N} 檔(17 條路徑中位)── 同母體等權 ${(median(ew.map(e => e.cagr)) * 100).toFixed(2)}%/年 ・隨機 ${su.N} 檔 ${(median(shamMed) * 100).toFixed(2)}%(換手 ${(shamTurn * 100).toFixed(0)}%/年)・0050 價格 ${(median(b50s.map(b => b.px.cagr)) * 100).toFixed(2)}% / 含息 ${(median(b50s.map(b => b.tr.cagr)) * 100).toFixed(2)}%`);
        const rows = [];
        for (const kind of FACTORS) for (const dir2 of [1, -1]) {
            const runs = starts.map(s => runPath(D, s, su.R, makePick(D, kind, dir2, su.N, cache)));
            const res = runs.map(r => stats(D, r.eq));
            const turnY = median(runs.map(r => r.turn / ((r.eq.length - 1) / 245)));
            const cg = res.map(r => r.cagr);
            const winSham = res.filter((r, k) => r.cagr > shamMed[k]).length;
            const winEw = res.filter((r, k) => r.cagr > ew[k].cagr).length;
            const win50 = res.filter((r, k) => b50s[k] && r.cagr > b50s[k].tr.cagr).length;
            // 中位那條路徑看逐年 / 前後半
            const mi = cg.map((c, k) => [c, k]).sort((a, b) => a[0] - b[0])[Math.floor(PATHS / 2)][1];
            const r0 = res[mi], e0 = ew[mi];
            const ys = Object.keys(r0.yearly).filter(y => e0.yearly[y] != null);
            const exc = ys.map(y => r0.yearly[y] - e0.yearly[y]);
            const yrWin = exc.filter(x => x > 0).length;
            const dropBest = exc.reduce((a, b) => a + b, 0) - Math.max(...exc);
            const pctl = shamMed.length ? median(res.map((r, k) => sham[k].filter(x => x < r.cagr).length / sham[k].length)) : null;
            const g = {
                '贏隨機(配對 ≥13/17)': winSham >= 13,
                '前後半都贏等權': r0.h1 > e0.h1 && r0.h2 > e0.h2,
                '逐年贏等權 ≥60%': yrWin / ys.length >= 0.6,
                '去最好年仍贏等權': dropBest > 0,
                '贏等權(配對 ≥13/17)': winEw >= 13,
                '扣成本後年化 > 0050 價格': median(cg) > median(b50s.map(b => b.px.cagr)),
            };
            const pass = Object.values(g).filter(Boolean).length;
            const name = `${kind}${dir2 > 0 ? ' 取最大' : ' 取最小'}`;
            rows.push({ name, turnY: +(turnY * 100).toFixed(0), cagr: +(median(cg) * 100).toFixed(2), mdd: +(median(res.map(r => r.mdd)) * 100).toFixed(1), winSham, winEw, win50,
                shamPctl: pctl == null ? null : +(pctl * 100).toFixed(0), yrWin: `${yrWin}/${ys.length}`, h1: +((r0.h1 - e0.h1) * 100).toFixed(2), h2: +((r0.h2 - e0.h2) * 100).toFixed(2), pass, gates: g });
            console.log(`${pass === 6 ? '✅' : pass >= 4 ? '⚠️' : '⛔'} ${name.padEnd(12)} 年化 ${(median(cg) * 100).toFixed(2).padStart(6)}%(換手 ${(turnY * 100).toFixed(0)}%/年)・最大回撤 ${(median(res.map(r => r.mdd)) * 100).toFixed(1)}% ・贏隨機 ${winSham}/17(在隨機分布第 ${(pctl * 100).toFixed(0)} 百分位)・贏等權 ${winEw}/17 ・贏 0050 含息 ${win50}/17 ・逐年 ${yrWin}/${ys.length} ・前半 ${((r0.h1 - e0.h1) * 100).toFixed(2)} / 後半 ${((r0.h2 - e0.h2) * 100).toFixed(2)}pp ・六關 ${pass}/6`);
        }
        out.setups.push({ ...su, shamTurn: +(shamTurn * 100).toFixed(0), ew: +(median(ew.map(e => e.cagr)) * 100).toFixed(2), sham: +(median(shamMed) * 100).toFixed(2),
            b50px: +(median(b50s.map(b => b.px.cagr)) * 100).toFixed(2), b50tr: +(median(b50s.map(b => b.tr.cagr)) * 100).toFixed(2), rows });
    }
    console.log(`\n⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
