#!/usr/bin/env node
/**
 * 🇺🇸→🇹🇼 美股隔夜異常 → 台股 lead-lag 探針(V77.7.7)
 *
 * 起因:外部 AI 建議做「US→TW Alpha Engine」(美股隔夜異常報酬 → 台股 T+0 開盤/收盤、T+1~T+20;
 *   「美股很強、台股開盤還沒反映」的 information gap;美股板塊 → 台股板塊;美股個股 → 台股個股 β)。
 *   本站以前只有**大盤層級**的兩條:盤前體檢分數(+0.574pp,大盤 ✅;套個股 −0.27% ⛔)與
 *   S&P/NASDAQ → 台股隔天相關 +0.47(⚠️ 那是時區同步不是 alpha,LAB r:66)。個股/板塊層級與「疊在 🧬 上的增量」從來沒測過。
 *
 * 輸入:
 *   US_HIST=<data/us_hist.json>(us_hist_miner.py 產物;欄式 {days, syms:{T:{o,c,v}}})
 *   DATA_DIR=<台股日 K 目錄>(要有 ^TWII.json / 0050.json / 各板塊成分股)
 *   DIV=<dividends_hist.json>(0050 含息對照;不給就退回 0050 原始價並在 meta 註明)
 *   IDX_HTML=<index.html>(從**原地**解析 `_sectorStocks`,⛔ 不抄第二份)
 *   Z=2 W=120(事件門檻與 Z 分數窗口)・BENCH=^IXIC(相對報酬基準)・SEMI_BENCH=^SOX
 *   EMIT_USSIG=<out.json> USSIG_KIND=idx|gap|sector|stock → 另寫 portfolio_backtest `USSIG_MAP` 用的對照表
 *
 * 事件定義(⛔ 基準區間不含被判斷的那一根,陷阱 #43):
 *   r = c[D]/c[D−1]−1;rel = r − r_bench(指數本身用絕對報酬;半導體個股/ETF 的 bench 是 ^SOX)
 *   z = (rel[D] − mean(rel[D−W..D−1])) / sd(rel[D−W..D−1]);事件 = |z| ≥ Z(正負分開)
 *   volShock = v[D] / median(v[D−20..D−1])(只當附屬欄)
 * 台股映射:nextTW(D) = ^TWII 日曆裡**第一個 > D** 的交易日(美股 D 日收盤 = 台北 D+1 凌晨;⛔ 不可同日期 = 前視)
 * 可交易的口徑:T 日**開盤買**(美股收盤後台股才開)→ T+h 收盤賣。
 *   板塊 / 個股層級:扣同期 0050(開盤→收盤,含窗口內除息)。
 *   🚨 加權層級**不用 ^TWII**:加權指數的「開盤價」是用還沒成交的股票的**昨收**湊出來的(09:00 只有一部分股票成交)→
 *      開盤價被系統性壓向昨收,「開→收」會把跳空吃進去;拿它跟 0050(真的開盤價)相減會憑空多出 +1pp「超額」
 *      (第一版就是這樣量到 6/6 全過的假結果)。⭐ 加權層級一律用 **0050 本身**(買得到的東西)當資產,
 *      超額 = 0050 開→收(T+h)報酬 − 同天期全部交易日的平均(去掉多頭漂移),對照組 sham 同一套。
 *   T+0 跳空(gap0 = o[T]/c[T−1]−1)只當描述 —— 那是**買不到**的那一段(V74.4.5「開盤前掛前一日收盤價」實測最糟)。
 * 對照組:(a) 同批事件日**不加** gap 條件 (b) sham = 固定種子同數量隨機美股日走同一套映射 (c) 全部交易日
 * 六關:全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 0.44 / vs sham 顯著(p ≤ 0.05);高原 Z×W;BH 分三 family。
 * ⚠️ 樣本:5 年 ≈ 1,250 美股日,單檔 ≥2σ 去重後 <60 次;個股每對 n<30 標「樣本不足」不進 BH。
 *
 * 用法:
 *   US_HIST=$S/us_hist.json DATA_DIR=$S/dd2 DIV=$S/od/data/dividends_hist.json node scripts/us_tw_lead_probe.mjs out.json
 *   node scripts/us_tw_lead_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { trSeries, loadPx, d10 } from './lib_totalreturn.mjs';
import { pTwoSided } from './lib_perf.mjs';
import { bhQ } from './lib_fdr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env;
const Z_DEF = +(ENV.Z || 2), W_DEF = +(ENV.W || 120);
const BENCH = ENV.BENCH || '^IXIC', SEMI_BENCH = ENV.SEMI_BENCH || '^SOX';
const COST = 0.44;                                 // 來回成本 %(同 portfolio_backtest COST0)
const HORIZONS = [0, 1, 2, 3, 5, 10, 20];          // h=0 → 開盤買收盤賣
const MAX_H = 20;
const DEDUP = MAX_H;                                // 同一個事件源在最長天期窗內再觸發 ⛔ 不算獨立事件
const GAP_SLACK = 0.5;                              // information gap:實際跳空 < 預期 − 0.5pp
const MIN_PAIR_N = 30;
const INDEX_TICKERS = new Set(['^GSPC', '^IXIC', '^SOX', '^DJI', '^VIX']);
const SEMI = new Set(['TSM', 'ASX', 'UMC', 'NVDA', 'AMD', 'AVGO', 'MU', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'ASML', 'SMH', 'SOXX']);
const FUTURES = new Set(['ES=F', 'NQ=F']);         // 換月假報酬 → ⛔ 不當事件源
// 美股板塊代理(對照 macro_miner.py SECTOR_ETF_MAP;selftest ⑧ 用 regex 逐板塊比對,漂了就紅)
export const US_SECTOR = {
    server: ['SMH', 'NVDA', 'SMCI'], power: ['GRID'], packaging: ['SOXX', 'TSM', 'ASML'], cpo: ['MRVL', 'AVGO'],
    cooling: ['XLI'], robot: ['BOTZ', 'TSLA'], finance: ['XLF'], leo: ['ITA'], dram: ['MU'],
    defense: ['PPA'], wafer: ['SOXX', 'TSM'], pcb: ['SOXX'], asic: ['AVGO', 'MRVL'], security: ['CIBR'],
};
const IDX_EVENT_SRC = ['^GSPC', '^IXIC', '^SOX', 'NVDA', 'TSM'];   // 加權層級的事件源

// ── 小工具 ───────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const r3 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;
// 固定種子亂數(sham 要可重現)
const rng = seed => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
// 差異檢定(兩組平均):Welch z
const diffTest = (A, B) => {
    if (A.length < 3 || B.length < 3) return { d: null, z: null, p: null };
    const ma = mean(A), mb = mean(B), sa = sd(A), sb = sd(B);
    const se = Math.sqrt((sa * sa) / A.length + (sb * sb) / B.length);
    const z = se > 0 ? (ma - mb) / se : 0;
    return { d: ma - mb, z, p: pTwoSided(z) };
};
// 台股跳動單位(跟 index.html / pro.html / playbook_scan 一字不差)
const tickOf = v => v < 10 ? 0.01 : v < 50 ? 0.05 : v < 100 ? 0.1 : v < 500 ? 0.5 : v < 1000 ? 1 : 5;
const limitUpPx = pc => { const t = tickOf(pc * 1.1); return Math.floor(pc * 1.1 / t + 1e-9) * t; };

// ── 從 index.html 原地解析 _sectorStocks(⛔ 不抄第二份)──────────────────
export function cutLiteral(src, name) {
    const m = new RegExp('(?:^|[\\s,{;])' + name + '\\s*:\\s*([\\[{])').exec(src);
    if (!m) return null;
    const openCh = m[1], closeCh = openCh === '[' ? ']' : '}';
    let i = m.index + m[0].length - 1, depth = 0, inStr = null, esc = false;
    for (; i < src.length; i++) {
        const c = src[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (inStr) { if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return src.slice(m.index + m[0].length - 1, i + 1); }
    }
    return null;
}
export function loadSectorStocks(idxHtml) {
    const src = fs.readFileSync(idxHtml, 'utf8');
    const lit = cutLiteral(src, '_sectorStocks');
    if (!lit) throw new Error('index.html 找不到 _sectorStocks');
    const obj = new Function('return (' + lit + ')')();
    const out = {};
    for (const [sk, arr] of Object.entries(obj)) out[sk] = (arr || []).map(x => String(x[0]));
    return out;
}

// ── 美股序列 ─────────────────────────────────────────────────────────
export function loadUS(file) {
    const J = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(J.days) || !J.syms) throw new Error('us_hist.json 形狀不對(要有 days / syms)');
    return J;
}
/** 每檔:r(絕對報酬%)、rel(相對基準%)、z(相對報酬 Z 分數,窗口不含當根)、vs(量能衝擊倍數) */
export function usFeatures(U, { W = W_DEF, bench = BENCH, semiBench = SEMI_BENCH } = {}) {
    const n = U.days.length;
    const ret = t => { const c = U.syms[t]?.c || []; const r = new Array(n).fill(null); for (let i = 1; i < n; i++) if (c[i] != null && c[i - 1] != null && c[i - 1] > 0) r[i] = (c[i] / c[i - 1] - 1) * 100; return r; };
    const rB = U.syms[bench] ? ret(bench) : new Array(n).fill(null);
    const rS = U.syms[semiBench] ? ret(semiBench) : rB;
    const out = {};
    for (const t of Object.keys(U.syms)) {
        if (FUTURES.has(t)) continue;
        const r = ret(t);
        const isIdx = INDEX_TICKERS.has(t);
        const b = isIdx ? null : (SEMI.has(t) && t !== semiBench ? rS : rB);
        const rel = r.map((x, i) => x == null ? null : (b ? (b[i] == null ? null : x - b[i]) : x));
        const z = new Array(n).fill(null);
        const win = [];
        for (let i = 0; i < n; i++) {
            if (win.length >= Math.round(W * 0.8)) {            // ⛔ 基準用 D−W..D−1,不含當根
                const m = mean(win), s = sd(win);
                if (rel[i] != null && s > 0) z[i] = (rel[i] - m) / s;
            }
            if (rel[i] != null) { win.push(rel[i]); if (win.length > W) win.shift(); }
        }
        const v = U.syms[t].v || [];
        const vs = new Array(n).fill(null);
        for (let i = 20; i < n; i++) { const prev = v.slice(i - 20, i).filter(x => x != null && x > 0); if (prev.length >= 15 && v[i] != null) { const md = median(prev); if (md > 0) vs[i] = v[i] / md; } }
        out[t] = { r, rel, z, vs, isIdx, bench: isIdx ? null : (b === rS ? semiBench : bench) };
    }
    return out;
}

// ── 台股序列 ─────────────────────────────────────────────────────────
export function loadBars(dir, sym) {
    const p = path.join(dir, `${sym}.json`);
    if (!fs.existsSync(p)) return null;
    let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
    if (!Array.isArray(rows)) return null;
    const out = [];
    for (const r of rows) { const c = +r.close, o = +r.open; if (c > 0 && o > 0) out.push({ d: d10(r.date), o, c }); }
    out.sort((a, b) => a.d < b.d ? -1 : 1);
    return out.length ? out : null;
}
/** 對照組:0050 開盤(T)→ 收盤(T+h),窗口內除息把現金加回去(⛔ 不含 T 那天的除息 —— 開盤買進時已除) */
export function benchFactory(b50, divs) {
    const idx = new Map(b50.map((b, i) => [b.d, i]));
    const divAt = new Map();
    for (const [dt, amt, typ] of (divs || [])) { if (typ === '權') continue; const i = idx.get(d10(dt)); if (i != null && +amt > 0) divAt.set(i, (divAt.get(i) || 0) + +amt); }
    return (d, h) => {
        const k = idx.get(d); if (k == null || k + h >= b50.length) return null;
        let cash = 0; for (let j = k + 1; j <= k + h; j++) cash += divAt.get(j) || 0;
        return ((b50[k + h].c + cash) / b50[k].o - 1) * 100;
    };
}
/** 台股 T 日開盤買 → T+h 收盤的報酬 % 與跳空;鎖漲停開盤(≥ 前收 × 1.1 對到跳動單位)= 買不到 → null + 計數 */
export function twRet(bars, k, h) {
    if (k <= 0 || k + h >= bars.length) return null;
    return (bars[k + h].c / bars[k].o - 1) * 100;
}
export const twGap = (bars, k) => (k <= 0 || k >= bars.length) ? null : (bars[k].o / bars[k - 1].c - 1) * 100;
export const twLimitUp = (bars, k) => k > 0 && k < bars.length && bars[k].o >= limitUpPx(bars[k - 1].c);

// ── 映射:美股 D → 第一個 > D 的台股交易日 ─────────────────────────────
export function nextTwFactory(twDays) {
    return D => { const i = lowerBound(twDays, D); const j = twDays[i] === D ? i + 1 : i; return j < twDays.length ? j : null; };   // 回台股日曆索引
}
/** 事件清單(去重:同一事件源映射到的台股日,距上一事件 < DEDUP 根 ⛔ 不算) */
export function eventsOf(F, t, U, nextTw, { Z = Z_DEF, sign = +1 } = {}) {
    const f = F[t]; if (!f) return [];
    const out = []; let lastK = -Infinity;
    for (let i = 0; i < U.days.length; i++) {
        const z = f.z[i]; if (z == null) continue;
        if (sign > 0 ? z < Z : z > -Z) continue;
        const k = nextTw(U.days[i]); if (k == null) continue;
        if (k - lastK < DEDUP) continue;
        lastK = k;
        out.push({ usD: U.days[i], k, z, rel: f.rel[i], vs: f.vs[i], lag: null });
    }
    return out;
}

// ── 統計:六關 ────────────────────────────────────────────────────────
/** rows: [{k, d(台股日期), x(有號超額 pp)}] ・sham: [x] */
export function gates(rows, sham, { cost = COST, minYear = 8 } = {}) {
    const xs = rows.map(r => r.x).filter(x => x != null);
    if (xs.length < 5) return { n: xs.length, mean: r2(mean(xs)), pass: null, why: '樣本 <5' };
    const m = mean(xs);
    const half = Math.floor(rows.length / 2);
    const h1 = mean(rows.slice(0, half).map(r => r.x)), h2 = mean(rows.slice(half).map(r => r.x));
    const byY = {}; for (const r of rows) (byY[r.d.slice(0, 4)] ||= []).push(r.x);
    const yrs = Object.entries(byY).filter(([, a]) => a.length >= minYear).map(([y, a]) => [y, mean(a)]);
    const yrSame = yrs.length >= 2 && yrs.every(([, v]) => Math.sign(v) === Math.sign(m));
    const bestY = yrs.length ? yrs.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) && Math.sign(b[1]) === Math.sign(m) ? b : a))[0] : null;
    const dropBest = bestY ? mean(rows.filter(r => r.d.slice(0, 4) !== bestY).map(r => r.x)) : null;
    const t = diffTest(xs, sham);
    const g = [m > 0, h1 != null && h2 != null && Math.sign(h1) === Math.sign(m) && Math.sign(h2) === Math.sign(m), yrSame,
               dropBest != null && Math.sign(dropBest) === Math.sign(m), m - cost > 0, t.p != null && t.p <= 0.05 && Math.sign(t.d) === Math.sign(m)];
    return { n: xs.length, mean: r2(m), med: r2(median(xs)), win: r2(xs.filter(x => x > 0).length / xs.length * 100), h1: r2(h1), h2: r2(h2),
             byYear: Object.fromEntries(yrs.map(([y, v]) => [y, r2(v)])), dropBest: r2(dropBest), netCost: r2(m - cost),
             sham: { n: sham.length, mean: r2(mean(sham)) }, vsSham: { d: r2(t.d), p: r3(t.p) }, gates: g, pass: g.filter(Boolean).length, p: t.p };
}

// ── 主流程 ───────────────────────────────────────────────────────────
export function run(opt) {
    const { U, DATA, DIV, IDX_HTML, Z = Z_DEF, W = W_DEF, seed = 20260927, quiet = false } = opt;
    const log = (...a) => { if (!quiet) console.log(...a); };
    const F = usFeatures(U, { W });
    const twii = loadBars(DATA, '^TWII'); if (!twii) throw new Error(`${DATA} 沒有 ^TWII.json`);
    const twDays = twii.map(b => b.d);
    const nextTw = nextTwFactory(twDays);
    const b50raw = loadBars(DATA, '0050'); if (!b50raw) throw new Error(`${DATA} 沒有 0050.json`);
    let divs = [];
    if (DIV && fs.existsSync(DIV)) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); const DV = raw.d || raw; divs = (DV['0050'] || {}).h || []; }
    const bench = benchFactory(b50raw, divs);
    const sectors = loadSectorStocks(IDX_HTML);
    const stockSyms = [...new Set(Object.values(sectors).flat())];
    const bars = new Map(); for (const s of stockSyms) { const b = loadBars(DATA, s); if (b) bars.set(s, b); }
    // 台股日期索引 → 各檔的索引(對齊 ^TWII 日曆;個股缺那天就 null)
    const idxOf = new Map(); for (const [s, b] of bars) idxOf.set(s, new Map(b.map((x, i) => [x.d, i])));
    const i50 = new Map(b50raw.map((x, i) => [x.d, i]));
    log(`🇺🇸 ${Object.keys(F).length} 檔美股序列 ・${U.days[0]} ~ ${U.days[U.days.length - 1]} ・Z≥${Z} W=${W}`);
    log(`🇹🇼 ^TWII ${twDays.length} 天 ・0050 ${b50raw.length} 天(含息除息 ${divs.length} 筆)・板塊 ${Object.keys(sectors).length} 組 / 成分股 ${bars.size}/${stockSyms.length} 檔有資料`);

    // 有號超額:方向 sign(+1 事件 → 台股報酬;−1 事件 → 台股報酬取負)
    const excessVs0050 = (ret, k, h) => { const b = bench(twDays[k], h); return (ret == null || b == null) ? null : ret - b; };
    let limitDropped = 0;
    // 對一個「台股報酬序列取法」跑全部天期(含 sham / all)
    const evalLayer = (events, getBars, tag, mode = 'vs0050') => {
        const res = {};
        const kAll = [...Array(twDays.length).keys()].filter(k => k > 0 && k + MAX_H < twDays.length);
        const rnd = rng(seed + tag.length * 7919 + (events.length || 1));
        for (const h of HORIZONS) {
            // dedrift 模式(加權層級用 0050 當資產):超額 = 報酬 − 全部交易日同天期平均(⛔ 不能再扣 0050,那是它自己)
            let excess = excessVs0050;
            if (mode === 'dedrift') { const raw = []; for (const k of kAll) { const b = getBars(k); if (!b || b.limitUp) continue; const r = b.ret(h); if (r != null) raw.push(r); } const mu = mean(raw) || 0; excess = (ret, k, h2) => ret == null ? null : ret - mu; }
            const rows = [];
            for (const e of events) {
                const b = getBars(e.k); if (!b) continue;
                if (b.limitUp) { if (h === HORIZONS[0]) limitDropped++; continue; }
                const x = excess(b.ret(h), e.k, h); if (x == null) continue;
                rows.push({ k: e.k, d: twDays[e.k], x: x * (e.sign || 1), gap: b.gap });
            }
            // sham:同數量隨機台股日(固定種子),同一套報酬取法、正負號照事件比例隨機
            const sham = []; const nUp = events.filter(e => (e.sign || 1) > 0).length;
            for (let j = 0; j < Math.max(rows.length * 5, 100); j++) {
                const k = kAll[Math.floor(rnd() * kAll.length)]; const b = getBars(k); if (!b || b.limitUp) continue;
                const x = excess(b.ret(h), k, h); if (x == null) continue;
                sham.push(x * (rnd() < nUp / Math.max(events.length, 1) ? 1 : -1));
            }
            const allX = []; for (const k of kAll) { const b = getBars(k); if (!b || b.limitUp) continue; const x = excess(b.ret(h), k, h); if (x != null) allX.push(x); }
            res[`T+${h}`] = { ...gates(rows, sham), all: { n: allX.length, mean: r2(mean(allX)) } };
            if (h === 0) res.gap0 = { n: rows.length, mean: r2(mean(rows.map(r => r.gap).filter(x => x != null))) };
        }
        return res;
    };
    const barsGetter = b => k => (k <= 0 || k + MAX_H >= b.length) ? null : ({ limitUp: twLimitUp(b, k), gap: twGap(b, k), ret: h => twRet(b, k, h) });
    // 依日期對齊的取法(0050 / 個股的日曆跟 ^TWII 不一定一樣)
    const dateGetter = (b, io) => k => { const j = io.get(twDays[k]); return (j == null || j <= 0 || j + MAX_H >= b.length) ? null : ({ limitUp: twLimitUp(b, j), gap: twGap(b, j), ret: h => twRet(b, j, h) }); };
    const get50 = dateGetter(b50raw, i50);
    // 板塊籃子:成分股等權(每檔各自對齊日期;<3 檔有資料就 null)
    const basketGetter = members => k => {
        const d = twDays[k]; const ms = [];
        for (const s of members) { const b = bars.get(s); const j = idxOf.get(s)?.get(d); if (b && j != null && j > 0 && j + MAX_H < b.length && !twLimitUp(b, j)) ms.push([b, j]); }
        if (ms.length < 3) return null;
        return { limitUp: false, gap: mean(ms.map(([b, j]) => twGap(b, j))), ret: h => mean(ms.map(([b, j]) => twRet(b, j, h))) };
    };
    const withSign = (evs, sign) => evs.map(e => ({ ...e, sign }));
    const bothSides = t => [...withSign(eventsOf(F, t, U, nextTw, { Z, sign: +1 }), +1), ...withSign(eventsOf(F, t, U, nextTw, { Z, sign: -1 }), -1)].sort((a, b) => a.k - b.k);

    // ① 加權層級:每個事件源 × 正/負/雙向
    const idx = {};
    for (const t of IDX_EVENT_SRC) {
        if (!F[t]) continue;
        const up = withSign(eventsOf(F, t, U, nextTw, { Z, sign: +1 }), +1), dn = withSign(eventsOf(F, t, U, nextTw, { Z, sign: -1 }), -1);
        idx[t] = { asset: '0050(開→收,超額 = 減全部交易日平均)', nUp: up.length, nDn: dn.length, up: evalLayer(up, get50, 'idx-up-' + t, 'dedrift'), dn: evalLayer(dn, get50, 'idx-dn-' + t, 'dedrift'), both: evalLayer([...up, ...dn].sort((a, b) => a.k - b.k), get50, 'idx-both-' + t, 'dedrift') };
    }
    log(`① 加權層級:${Object.keys(idx).map(t => `${t} ${idx[t].nUp}↑/${idx[t].nDn}↓`).join(' ・')}`);

    // ② 板塊層級:US_SECTOR 成員事件聯集(依台股日去重)→ 台股板塊籃子
    const sector = {};
    for (const [sk, members] of Object.entries(sectors)) {
        const usm = (US_SECTOR[sk] || []).filter(t => F[t]);
        if (!usm.length || !members.length) continue;
        const merged = new Map();
        for (const t of usm) for (const e of bothSides(t)) { const cur = merged.get(e.k); if (!cur || Math.abs(e.z) > Math.abs(cur.z)) merged.set(e.k, { ...e, src: t }); }
        const evs = [...merged.values()].sort((a, b) => a.k - b.k);
        // 去重(聯集後再做一次)
        const ded = []; let last = -Infinity; for (const e of evs) { if (e.k - last < DEDUP) continue; last = e.k; ded.push(e); }
        sector[sk] = { us: usm, n: ded.length, both: evalLayer(ded, basketGetter(members), 'sec-' + sk), up: evalLayer(ded.filter(e => e.sign > 0), basketGetter(members), 'sec-up-' + sk) };
    }
    log(`② 板塊層級:${Object.keys(sector).length} 組`);

    // ③ information gap(加權 + 板塊):expGap = β250 × rel_US(β 用 D−250..D−1 對的滾動迴歸,⛔ 不含 D)
    const gapLayer = (src, getBars, tag, mode = 'vs0050') => {
        const f = F[src]; if (!f) return null;
        const pairs = []; // 台股日 k ↔ 美股前一日 rel
        for (let i = 0; i < U.days.length; i++) { if (f.rel[i] == null) continue; const k = nextTw(U.days[i]); if (k == null) continue; const b = getBars(k); if (!b || b.gap == null) continue; pairs.push({ i, k, x: f.rel[i], g: b.gap, z: f.z[i] }); }
        const beta250 = j => { const s = Math.max(0, j - 250); const P = pairs.slice(s, j); if (P.length < 120) return null; const mx = mean(P.map(p => p.x)), mg = mean(P.map(p => p.g)); let sxy = 0, sxx = 0; for (const p of P) { sxy += (p.x - mx) * (p.g - mg); sxx += (p.x - mx) ** 2; } return sxx > 0 ? sxy / sxx : null; };
        const cond = [], nocond = []; let last = -Infinity;
        for (let j = 0; j < pairs.length; j++) {
            const p = pairs[j]; if (p.z == null || p.z < Z) continue;
            if (p.k - last < DEDUP) continue; last = p.k;
            const beta = beta250(j); if (beta == null) continue;
            const exp = beta * p.x;
            const e = { k: p.k, sign: +1, z: p.z, exp, gap: p.g };
            nocond.push(e); if (p.g < exp - GAP_SLACK) cond.push(e);
        }
        return { src, nCond: cond.length, nNoCond: nocond.length, cond: evalLayer(cond, getBars, 'gap-c-' + tag, mode), nocond: evalLayer(nocond, getBars, 'gap-n-' + tag, mode) };
    };
    const gap = { idx: gapLayer(BENCH, get50, 'idx', 'dedrift'), idxSox: gapLayer('^SOX', get50, 'sox', 'dedrift') };
    for (const [sk, members] of Object.entries(sectors)) { const src = (US_SECTOR[sk] || []).find(t => F[t]); if (src) gap[`sector:${sk}`] = gapLayer(src, basketGetter(members), sk); }
    log(`③ information gap:加權(${BENCH})有條件 ${gap.idx?.nCond} / 無條件 ${gap.idx?.nNoCond}`);

    // ④ 個股層級:前半估 β(台股跳空 vs 美股 rel)、取 |β| 前 20 對;後半驗事件;兩半名單 Jaccard
    const usStocks = Object.keys(F).filter(t => !F[t].isIdx);
    const mid = twDays[Math.floor(twDays.length / 2)];
    const betaOf = (t, s, from, to) => { const f = F[t], b = bars.get(s), io = idxOf.get(s); if (!b) return null; const xs = [], gs = []; for (let i = 0; i < U.days.length; i++) { if (f.rel[i] == null) continue; const k = nextTw(U.days[i]); if (k == null) continue; const d = twDays[k]; if (d < from || d >= to) continue; const j = io.get(d); if (j == null || j <= 0) continue; xs.push(f.rel[i]); gs.push(twGap(b, j)); } if (xs.length < 120) return null; const mx = mean(xs), mg = mean(gs); let sxy = 0, sxx = 0, syy = 0; for (let q = 0; q < xs.length; q++) { sxy += (xs[q] - mx) * (gs[q] - mg); sxx += (xs[q] - mx) ** 2; syy += (gs[q] - mg) ** 2; } if (!(sxx > 0 && syy > 0)) return null; const beta = sxy / sxx, rho = sxy / Math.sqrt(sxx * syy); return { beta, rho, n: xs.length, t: rho * Math.sqrt((xs.length - 2) / Math.max(1e-9, 1 - rho * rho)) }; };
    const topPairs = (from, to) => { const all = []; for (const t of usStocks) for (const s of bars.keys()) { const b = betaOf(t, s, from, to); if (b) all.push({ us: t, tw: s, ...b }); } all.sort((a, b) => Math.abs(b.t) - Math.abs(a.t)); return all.slice(0, 20); };
    const top1 = topPairs(twDays[0], mid), top2 = topPairs(mid, twDays[twDays.length - 1] + 'z');
    const key = p => `${p.us}|${p.tw}`;
    const s1 = new Set(top1.map(key)), s2 = new Set(top2.map(key));
    const inter = [...s1].filter(k => s2.has(k)).length;
    const jaccard = s1.size + s2.size - inter ? inter / (s1.size + s2.size - inter) : null;
    const pairs = top1.map(p => {
        const evs = bothSides(p.us).filter(e => twDays[e.k] >= mid);           // 後半的事件
        const r = evalLayer(evs, dateGetter(bars.get(p.tw), idxOf.get(p.tw)), 'pair-' + key(p));
        const t1 = r['T+1'], t5 = r['T+5'];
        return { us: p.us, tw: p.tw, beta: r3(p.beta), rho: r3(p.rho), t: r2(p.t), n2: evs.length, ok: evs.length >= MIN_PAIR_N, t1: { mean: t1.mean, pass: t1.pass, p: t1.p }, t5: { mean: t5.mean, pass: t5.pass, p: t5.p } };
    });
    log(`④ 個股層級:前半 β 前 20 對 vs 後半前 20 對 名單重疊率 ${jaccard == null ? '—' : (jaccard * 100).toFixed(1) + '%'}(交集 ${inter})`);

    // ⑤ 高原(加權層級 ^IXIC 雙向,T+1 / T+5):Z × W
    const plateau = [];
    for (const Zp of [1.5, 2, 2.5, 3]) for (const Wp of [60, 120, 250]) {
        const Fp = usFeatures(U, { W: Wp });
        const t = BENCH; if (!Fp[t]) continue;
        const up = eventsOf(Fp, t, U, nextTw, { Z: Zp, sign: +1 }).map(e => ({ ...e, sign: +1 })), dn = eventsOf(Fp, t, U, nextTw, { Z: Zp, sign: -1 }).map(e => ({ ...e, sign: -1 }));
        const r = evalLayer([...up, ...dn].sort((a, b) => a.k - b.k), get50, `pl-${Zp}-${Wp}`, 'dedrift');
        plateau.push({ Z: Zp, W: Wp, n: up.length + dn.length, t1: r['T+1'].mean, t5: r['T+5'].mean, t1pass: r['T+1'].pass, t5pass: r['T+5'].pass });
    }

    // ⑥ BH 分三 family(加權 / 板塊 / 個股)
    const fam = (rows, label) => { const q = bhQ(rows.map(r => r.p ?? 1)); return { label, n: rows.length, rejected: rows.filter((r, i) => q[i] <= 0.1).map((r, i) => ({ ...r.id, p: r3(r.p), q: r3(q[rows.indexOf(r)]) })) }; };
    const fIdx = []; for (const [t, v] of Object.entries(idx)) for (const h of HORIZONS) fIdx.push({ id: { src: t, h }, p: v.both[`T+${h}`].p });
    const fSec = []; for (const [sk, v] of Object.entries(sector)) for (const h of HORIZONS) fSec.push({ id: { sector: sk, h }, p: v.both[`T+${h}`].p });
    const fPair = pairs.filter(p => p.ok).map(p => ({ id: { us: p.us, tw: p.tw, h: 1 }, p: p.t1.p }));
    const bh = { idx: fam(fIdx, '加權 × 天期'), sector: fam(fSec, '板塊 × 天期'), stock: fam(fPair, '個股對 T+1') };

    return {
        meta: { win: [twDays[0], twDays[twDays.length - 1]], usWin: [U.days[0], U.days[U.days.length - 1]], nUS: Object.keys(F).length, nTWdays: twDays.length, Z, W, bench: BENCH, semiBench: SEMI_BENCH, cost: COST, entry: 'T 日開盤買(美股收盤後台股才開)', benchNote: divs.length ? '0050 開→收 + 窗口內除息' : '0050 原始價(⚠️ 沒給 DIV,不含息)', limitDropped, dedup: DEDUP, mid, sectorSrc: IDX_HTML, generated: new Date().toISOString().slice(0, 16) },
        idx, sector, gap, stock: { pairs, jaccard: r3(jaccard), inter, top2: top2.map(p => ({ us: p.us, tw: p.tw, beta: r3(p.beta), t: r2(p.t) })) }, plateau, bh,
        _F: F, _nextTw: nextTw, _twDays: twDays, _sectors: sectors, _b50: b50raw, _i50: i50,
    };
}

// ── EMIT_USSIG:給 portfolio_backtest 的對照表 ────────────────────────
export function emitUssig(R, U, kind, { Z = Z_DEF } = {}) {
    const { _F: F, _nextTw: nextTw, _twDays: twDays, _sectors: sectors } = R;
    const map = {};
    // 每個有美股前一日的台股日先寫 0(有資料但沒訊號 ≠ 沒資料;PB 缺鍵會剔除並計數)
    for (let i = 0; i < U.days.length; i++) { const k = nextTw(U.days[i]); if (k != null) map[`*|${twDays[k]}`] = 0; }
    const stamp = (key, v) => { map[key] = Math.max(map[key] || 0, v); };
    if (kind === 'idx') { for (const t of ['^IXIC', '^SOX']) for (const e of eventsOf(F, t, U, nextTw, { Z, sign: +1 })) stamp(`*|${twDays[e.k]}`, 1); }
    else if (kind === 'gap') { const g = R.gap.idx; if (!g) throw new Error('沒有 gap.idx'); /* 重算條件日 */
        const f = F[R.meta.bench]; const twii = null;
        // 直接用 run() 裡同一套規則:這裡重跑一次 gapLayer 的條件邏輯(以 meta.bench 為源)
        const pairs = []; for (let i = 0; i < U.days.length; i++) { if (f.rel[i] == null) continue; const k = nextTw(U.days[i]); if (k == null) continue; pairs.push({ i, k, x: f.rel[i], z: f.z[i] }); }
        // gap0 用 0050 自己的開盤(⛔ 不用 ^TWII —— 加權指數開盤價是湊的,見檔頭)
        const b = R._b50, io = R._i50; if (!b) throw new Error('emit gap 需要 R._b50');
        const gapAt = k => { const j = io.get(twDays[k]); return (j != null && j > 0) ? (b[j].o / b[j - 1].c - 1) * 100 : null; };
        const P = pairs.map(p => ({ ...p, g: gapAt(p.k) })).filter(p => p.g != null);
        let last = -Infinity;
        for (let j = 0; j < P.length; j++) { const p = P[j]; if (p.z == null || p.z < Z) continue; if (p.k - last < DEDUP) continue; last = p.k; const s = Math.max(0, j - 250), Q = P.slice(s, j); if (Q.length < 120) continue; const mx = mean(Q.map(q => q.x)), mg = mean(Q.map(q => q.g)); let sxy = 0, sxx = 0; for (const q of Q) { sxy += (q.x - mx) * (q.g - mg); sxx += (q.x - mx) ** 2; } if (!(sxx > 0)) continue; const exp = (sxy / sxx) * p.x; if (p.g < exp - GAP_SLACK) stamp(`*|${twDays[p.k]}`, 1); }
    }
    else if (kind === 'sector') { for (const [sk, members] of Object.entries(sectors)) for (const t of (US_SECTOR[sk] || [])) { if (!F[t]) continue; for (const e of eventsOf(F, t, U, nextTw, { Z, sign: +1 })) for (const s of members) stamp(`${s}|${twDays[e.k]}`, 1); } }
    else if (kind === 'stock') { for (const p of R.stock.pairs) { if (!p.ok || !(p.beta > 0)) continue; for (const e of eventsOf(F, p.us, U, nextTw, { Z, sign: +1 })) stamp(`${p.tw}|${twDays[e.k]}`, 1); } }
    else throw new Error(`USSIG_KIND=${kind} 不認得(idx|gap|sector|stock)`);
    const nOn = Object.values(map).filter(v => v >= 1).length;
    return { kind, min: 1, Z, generated: new Date().toISOString().slice(0, 10), nOn, nKeys: Object.keys(map).length, map };
}

// ── selftest ─────────────────────────────────────────────────────────
function synth(tmp, { nUS = 900, inject = null, injectSameDay = false, limitUpAt = null, gap0050 = false } = {}) {
    // 美股日曆:週一~五;台股日曆:同一批日期(美股 D → 台股 D+1 個交易日)
    const days = []; let d = new Date('2023-01-02T00:00:00Z');
    while (days.length < nUS) { if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
    const R = rng(7);
    const mk = (base, vol) => { const c = [], o = [], v = []; let px = base; for (let i = 0; i < days.length; i++) { const r = (R() - 0.5) * vol; px *= 1 + r; c.push(+px.toFixed(2)); o.push(+(px * (1 + (R() - 0.5) * 0.004)).toFixed(2)); v.push(Math.round(1e6 * (0.8 + R() * 0.4))); } return { o, c, v }; };
    const syms = {}; for (const t of ['^GSPC', '^IXIC', '^SOX', 'NVDA', 'TSM', 'SMH', 'SMCI', 'GRID', 'SOXX', 'ASML', 'MRVL', 'AVGO', 'XLI', 'BOTZ', 'TSLA', 'XLF', 'ITA', 'MU', 'PPA', 'CIBR', 'AMD']) syms[t] = mk(100 + t.length * 10, t.startsWith('^') ? 0.02 : 0.04);
    // 注入:^IXIC 每 22 天一個 +6% 的日子(≫ 2σ);SMH(server 板塊代理)同一天 +12%(相對 ^IXIC 仍 +6% → 板塊層級也有事件)
    const shockDays = []; for (let i = 130; i < nUS - 30; i += 22) { shockDays.push(i); syms['^IXIC'].c[i] = +(syms['^IXIC'].c[i - 1] * 1.06).toFixed(2); syms['SMH'].c[i] = +(syms['SMH'].c[i - 1] * 1.12).toFixed(2); }
    const U = { asof: days[days.length - 1], adj: true, days, syms, meta: { n_syms: Object.keys(syms).length, n_days: nUS }, errors: {} };
    fs.writeFileSync(path.join(tmp, 'us_hist.json'), JSON.stringify(U));
    const dd = path.join(tmp, 'dd'); fs.mkdirSync(dd, { recursive: true });
    const sectors = loadSectorStocks(path.join(ROOT, 'index.html'));
    const twSyms = ['^TWII', '0050', ...new Set(Object.values(sectors).flat())];
    const shockSet = new Set(shockDays);
    for (const s of twSyms) {
        const rows = []; let px = s === '^TWII' ? 18000 : 100 + (s.charCodeAt(0) % 7) * 10;
        const R2 = rng(s.split('').reduce((a, ch) => a + ch.charCodeAt(0), 3));
        for (let i = 0; i < days.length; i++) {
            const prevC = px;
            let o = prevC * (1 + (R2() - 0.5) * 0.01); let c = o * (1 + (R2() - 0.5) * 0.02);
            // 注入:shock 日「隔天」(i-1 是 shock → 今天 i)開→收:0050 +inject%、板塊成分股 +2×inject%(籃子 − 0050 = +inject)
            //   ^TWII 不注(加權層級已改用 0050 當資產;它只提供日曆)
            const hitNext = inject && !injectSameDay && shockSet.has(i - 1) && s !== '^TWII';
            const hitSame = inject && injectSameDay && shockSet.has(i) && s !== '^TWII';
            if (hitNext || hitSame) c = o * (1 + (s === '0050' ? inject : 2 * inject) / 100);
            if ((hitNext || hitSame) && gap0050 && s === '0050') { o = prevC * (1 + inject / 100); c = o; }   // 跳空式:漲幅全在開盤、盤中 0
            if (limitUpAt && s === '0050' && shockSet.has(i - 1) && i === limitUpAt) { o = prevC * 1.1; c = o; }
            px = c;
            rows.push({ date: days[i].replace(/-/g, '/'), open: +o.toFixed(2), high: +Math.max(o, c).toFixed(2), low: +Math.min(o, c).toFixed(2), close: +c.toFixed(2), volume: 1000 });
        }
        fs.writeFileSync(path.join(dd, `${s}.json`), JSON.stringify(rows));
    }
    return { U, dd, shockDays, sectors, twDays: days };
}
function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 220)}`); if (!c) fails.push(n); };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ustw-'));
    const IDX_HTML = path.join(ROOT, 'index.html');
    // ⑧ 板塊常數:_sectorStocks 解析出 14 組;US_SECTOR 對得上 macro_miner.SECTOR_ETF_MAP
    const sec = loadSectorStocks(IDX_HTML);
    ok('⑧a index.html 解析出 _sectorStocks(≥14 組、每組 ≥3 檔)', Object.keys(sec).length >= 14 && Object.values(sec).every(a => a.length >= 3), Object.keys(sec).join(','));
    const mm = fs.readFileSync(path.join(ROOT, 'macro_miner.py'), 'utf8');
    const lit = (mm.match(/SECTOR_ETF_MAP = \{[\s\S]*?\n\}\n/) || [''])[0];
    const secTickers = {}; let cur = null;
    for (const line of lit.split('\n')) { const h = line.match(/^\s{4}'(\w+)':\s*\{/); if (h) { cur = h[1]; secTickers[cur] = []; continue; } const t = line.match(/'ticker':\s*'([^']+)'/); if (t && cur) secTickers[cur].push(t[1]); }
    const drift = Object.entries(US_SECTOR).filter(([sk, arr]) => !secTickers[sk] || arr.some(t => !secTickers[sk].includes(t)));
    ok('⑧b US_SECTOR 每一組都是 macro_miner.SECTOR_ETF_MAP 的子集合(漂了就紅)', Object.keys(secTickers).length >= 14 && drift.length === 0, JSON.stringify(drift.map(d => d[0])) + ' / parsed ' + Object.keys(secTickers).length);
    ok('⑧c US_SECTOR 涵蓋 _sectorStocks 全部板塊', Object.keys(sec).every(sk => US_SECTOR[sk]), Object.keys(sec).filter(sk => !US_SECTOR[sk]).join(','));

    // ① 注入:shock 隔天台股 +3% → idx T+0 量到 ≈ +3(0050 沒注 → 超額 ≈ 3)
    const A = synth(tmp, { inject: 3 });
    const RA = run({ U: A.U, DATA: A.dd, DIV: null, IDX_HTML, quiet: true });
    const upA = RA.idx['^IXIC'].up;
    ok('① 注入 shock 隔天 0050 +3% → 加權層級(0050 去漂移)T+0 ≈ +3、事件數 = 注入數', upA && Math.abs(upA['T+0'].mean - 3) < 0.6 && RA.idx['^IXIC'].nUp === A.shockDays.length, `mean=${upA?.['T+0']?.mean} n=${RA.idx['^IXIC'].nUp} vs ${A.shockDays.length}`);
    ok('①0 加權層級的資產是 0050 不是 ^TWII(加權開盤價是湊的)', /0050/.test(RA.idx['^IXIC'].asset || ''), RA.idx['^IXIC'].asset);
    ok('①b 板塊層級也量到(server T+0 ≈ +3)', RA.sector.server && Math.abs(RA.sector.server.up['T+0'].mean - 3) < 0.8, RA.sector.server?.up?.['T+0']?.mean);
    ok('①c 六關:注入夠大時 T+0 全過(含 vs sham 顯著)', upA['T+0'].pass === 6, JSON.stringify(upA['T+0'].gates));
    // ② 前視必紅:注入在**同日期**(美股 D = 台股 D)→ 正確映射(D+1)量到 ≈ 0
    const B = synth(tmp + '_b', { inject: 3, injectSameDay: true }, fs.mkdirSync(tmp + '_b', { recursive: true }));
    const RB = run({ U: B.U, DATA: B.dd, DIV: null, IDX_HTML, quiet: true });
    ok('② 前視守門:同日期注入 → 正確映射(第一個 > D 的交易日)量到 ≈ 0', Math.abs(RB.idx['^IXIC'].up['T+0'].mean) < 0.8, RB.idx['^IXIC'].up['T+0'].mean);
    // ⑥ Z 窗不含當根:單一 +6% 日 z 應 ≫ 2(含當根會被自己壓低)
    const zs = A.shockDays.map(i => RA._F['^IXIC'].z[i]);
    ok('⑥ Z 分數窗口不含當根:注入日 z 全部 ≥ 3', zs.every(z => z != null && z >= 3), zs.slice(0, 4).map(z => z?.toFixed(1)).join(','));
    // ③ 去重:連續兩天 shock 只算一個事件
    const C = synth(tmp + '_c', { inject: 3 }, fs.mkdirSync(tmp + '_c', { recursive: true }));
    const i0 = C.shockDays[0]; C.U.syms['^IXIC'].c[i0 + 1] = +(C.U.syms['^IXIC'].c[i0] * 1.06).toFixed(2);
    const FC = usFeatures(C.U); const nx = nextTwFactory(C.twDays);
    const evC = eventsOf(FC, '^IXIC', C.U, nx, { Z: 2, sign: +1 });
    ok('③ 連續兩天 shock 只算一個獨立事件(20 根內去重)', evC.filter(e => e.usD === C.U.days[i0] || e.usD === C.U.days[i0 + 1]).length === 1, evC.slice(0, 3).map(e => e.usD).join(','));
    // ④ sham ≈ 0(沒注入的資料,sham 平均在 ±0.3 內)
    const D = synth(tmp + '_d', {}, fs.mkdirSync(tmp + '_d', { recursive: true }));
    const RD = run({ U: D.U, DATA: D.dd, DIV: null, IDX_HTML, quiet: true });
    ok('④ 沒注入時事件平均 ≈ 0、sham 平均 ≈ 0、六關⛔ 不會全過', Math.abs(RD.idx['^IXIC'].up['T+1'].mean) < 1.0 && Math.abs(RD.idx['^IXIC'].up['T+1'].sham.mean) < 0.5 && RD.idx['^IXIC'].up['T+1'].pass < 6, JSON.stringify(RD.idx['^IXIC'].up['T+1']));
    // ⑤ 漲停剔除:某個 shock 隔天 ^TWII 開在漲停價 → limitDropped ≥ 1
    const E = synth(tmp + '_e', { inject: 3, limitUpAt: A.shockDays[1] + 1 }, fs.mkdirSync(tmp + '_e', { recursive: true }));
    const RE = run({ U: E.U, DATA: E.dd, DIV: null, IDX_HTML, quiet: true });
    ok('⑤ 開盤鎖漲停(買不到)→ 剔除並計數', RE.meta.limitDropped >= 1, RE.meta.limitDropped);
    // ⑪ 決定性對照:把 0050 的開盤改成「昨收」(模擬加權指數那種湊出來的開盤)→ 開→收會把跳空吃進去、量到假超額
    const G = synth(tmp + '_g', { inject: 3, gap0050: true }, fs.mkdirSync(tmp + '_g', { recursive: true }));
    const RG1 = run({ U: G.U, DATA: G.dd, DIV: null, IDX_HTML, quiet: true });
    { const f = path.join(G.dd, '0050.json'); const rows = JSON.parse(fs.readFileSync(f, 'utf8')); for (let i = 1; i < rows.length; i++) rows[i].open = rows[i - 1].close; fs.writeFileSync(f, JSON.stringify(rows)); }
    const RG2 = run({ U: G.U, DATA: G.dd, DIV: null, IDX_HTML, quiet: true });
    ok('⑪ 對照:漲幅全在跳空、盤中 0 → 真開盤量到 ≈0;開盤改成「昨收」湊的 → 憑空量到 ≈+3(這正是⛔ 不可用 ^TWII 的原因)', Math.abs(RG1.idx['^IXIC'].up['T+0'].mean) < 0.6 && Math.abs(RG2.idx['^IXIC'].up['T+0'].mean - 3) < 0.6, `${RG1.idx['^IXIC'].up['T+0'].mean} → ${RG2.idx['^IXIC'].up['T+0'].mean}`);
    // ⑦ β250 不含 D:gap 層對「條件日」那天的極端值不敏感 —— 用 nextTw 保證 pairs 不含當天(結構性);這裡驗 gap 條件日 ⊂ 無條件日
    ok('⑦ gap 條件日是無條件日的子集合、且 <= 無條件', RA.gap.idx && RA.gap.idx.nCond <= RA.gap.idx.nNoCond && RA.gap.idx.nNoCond === RA.idx['^IXIC'].nUp, `${RA.gap.idx?.nCond}/${RA.gap.idx?.nNoCond} vs ${RA.idx['^IXIC'].nUp}`);
    // ⑨ BH:沒注入的資料 rejected 應該很少(≤ 2 個 family 各 ≤ 1)
    ok('⑨ 沒注入時 BH 幾乎沒有 rejected', (RD.bh.idx.rejected.length + RD.bh.sector.rejected.length) <= 2, `${RD.bh.idx.rejected.length}/${RD.bh.sector.rejected.length}`);
    // ⑩ EMIT_USSIG:idx kind → 台股日鍵數 ≈ 台股日數、亮的天數 = 事件數
    const M = emitUssig(RA, A.U, 'idx');
    ok('⑩ EMIT_USSIG idx:每個有美股前一日的台股日都有鍵(0 或 1)、亮的 = ^IXIC∪^SOX 事件數', M.nKeys >= A.twDays.length - 5 && M.nOn >= A.shockDays.length && M.nOn <= A.shockDays.length + RA.idx['^SOX'].nUp, `${M.nKeys} keys / ${M.nOn} on`);
    const Mg = emitUssig(RA, A.U, 'gap'); const Ms = emitUssig(RA, A.U, 'sector');
    ok('⑩b gap / sector 也產得出來、sector 鍵是 sym|date', Mg.nOn <= M.nOn && Object.keys(Ms.map).some(k => /^\d{4}\|\d{4}-/.test(k)), `${Mg.nOn} / ${Ms.nOn}`);
    let threw = false; try { emitUssig(RA, A.U, 'xyz'); } catch (_) { threw = true; }
    ok('⑩c 認不得的 USSIG_KIND → throw', threw);
    for (const t of [tmp, tmp + '_b', tmp + '_c', tmp + '_d', tmp + '_e', tmp + '_g']) fs.rmSync(t, { recursive: true, force: true });
    console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ selftest 全部通過'}`);
    process.exit(fails.length ? 1 : 0);
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else {
        const out = process.argv[2] || 'us_tw_lead.json';
        const US_HIST = ENV.US_HIST; const DATA = ENV.DATA_DIR; const DIV = ENV.DIV || null; const IDX_HTML = ENV.IDX_HTML || path.join(ROOT, 'index.html');
        if (!US_HIST || !fs.existsSync(US_HIST)) { console.error('❌ 要 US_HIST=<us_hist.json>(先 git show origin/data:data/us_hist.json > …)'); process.exit(1); }
        if (!DATA || !fs.existsSync(path.join(DATA, '^TWII.json'))) { console.error('❌ 要 DATA_DIR=<有 ^TWII.json 的目錄>'); process.exit(1); }
        const U = loadUS(US_HIST);
        if ((U.meta?.n_days || U.days.length) < 500) { console.error(`❌ 美股序列只有 ${U.days.length} 天(<500)→ 樣本不夠,停`); process.exit(1); }
        const R = run({ U, DATA, DIV, IDX_HTML, Z: Z_DEF, W: W_DEF });
        if (ENV.EMIT_USSIG) { const kind = ENV.USSIG_KIND || 'idx'; const M = emitUssig(R, U, kind); fs.writeFileSync(ENV.EMIT_USSIG, JSON.stringify(M)); console.log(`📤 USSIG 對照表 kind=${kind}:${M.nKeys} 鍵 / 亮 ${M.nOn} → ${ENV.EMIT_USSIG}`); }
        const { _F, _nextTw, _twDays, _sectors, _twii, ...pub } = R;
        fs.writeFileSync(out, JSON.stringify(pub, null, 1));
        // 摘要
        const fmt = g => g ? `${g.mean == null ? '—' : (g.mean >= 0 ? '+' : '') + g.mean}pp(n=${g.n},${g.pass ?? '—'}/6,p=${g.p == null ? '—' : g.p.toFixed(3)})` : '—';
        console.log('\n① 加權層級(有號超額 vs 0050,雙向事件):');
        for (const [t, v] of Object.entries(pub.idx)) console.log(`  ${t.padEnd(6)} ↑${v.nUp}/↓${v.nDn}  gap0 ${v.both.gap0?.mean}  T+0 ${fmt(v.both['T+0'])}  T+1 ${fmt(v.both['T+1'])}  T+5 ${fmt(v.both['T+5'])}  T+20 ${fmt(v.both['T+20'])}`);
        console.log('③ information gap(加權):'); for (const k of ['idx', 'idxSox']) { const g = pub.gap[k]; if (g) console.log(`  ${g.src}: 有條件 n=${g.nCond} T+0 ${fmt(g.cond['T+0'])} T+1 ${fmt(g.cond['T+1'])} T+5 ${fmt(g.cond['T+5'])} ・無條件 n=${g.nNoCond} T+1 ${fmt(g.nocond['T+1'])}`); }
        console.log('② 板塊層級(T+1 / T+5 雙向):'); for (const [sk, v] of Object.entries(pub.sector)) console.log(`  ${sk.padEnd(10)} n=${v.n} T+0 ${fmt(v.both['T+0'])} T+1 ${fmt(v.both['T+1'])} T+5 ${fmt(v.both['T+5'])}`);
        console.log(`④ 個股層級:前後半 β 前 20 對 名單重疊率 ${pub.stock.jaccard == null ? '—' : (pub.stock.jaccard * 100).toFixed(1) + '%'};後半事件 T+1 全過六關的對數 ${pub.stock.pairs.filter(p => p.ok && p.t1.pass === 6).length}/${pub.stock.pairs.filter(p => p.ok).length}`);
        console.log(`⑤ 高原(^IXIC 雙向 T+1):${pub.plateau.map(p => `Z${p.Z}W${p.W}=${p.t1}(${p.t1pass})`).join(' ')}`);
        console.log(`⑥ BH q≤0.1:加權 ${pub.bh.idx.rejected.length}/${pub.bh.idx.n} ・板塊 ${pub.bh.sector.rejected.length}/${pub.bh.sector.n} ・個股 ${pub.bh.stock.rejected.length}/${pub.bh.stock.n}`);
        console.log(`⚠️ 漲停剔除 ${pub.meta.limitDropped} ・對照 ${pub.meta.benchNote} ・→ ${out}`);
    }
}
