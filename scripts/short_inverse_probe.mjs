#!/usr/bin/env node
/**
 * 🩳 short_inverse_probe.mjs —— 大跌時「放空 / 買反一」有沒有用(V82.0.2)
 *
 * 使用者 11/06:「檢視附圖,另外放空有用嗎?還是買反一之類的」(附圖:高盛建議放空台灣半導體、斷頭潮、下週一補跌…)
 * 已經有的(⛔ 不重測):盤前極度偏空那天開盤放空 ≈ 0(premkt-bear-day)・星期五大跌隔天偏弱(fri-drop,只當參考)・
 *   大跌當天熱門股跌最多的之後多漲(dip-hot-3pct)・斷頭股(margin-call-bounce)・止跌徵兆 / 崩盤前兆 0 過關。
 * ⚠️ bear-season 寫「反向 ETF 只有 2023-06 起的資料,測不了」→ 這支用指數合成「每天 −1 倍」補上(台股 2000 起 + 33 國)。
 *
 * ⛔⛔ 事先登記(2026-11-06 寫死,跑完 ⛔ 改中心參數;左右一格只看高原):
 *  A 合成反一:每天 −1 × 指數報酬 + 每年 carry ÷ 252(⛔ 第二份定義:L=2 時跟 crash_playbook_probe.synth2x 逐位相同)。
 *     台股主資產 = 加權報酬指數(含息:放空要付股息)2003 起;加權價格 2000 起 = 對反一有利的版本(沒扣股息)。
 *     各國 = 價格指數(假設股息 ≈ 現金利率)。carry 主 −1%/年(費用),另列 −4% / +2%。全部跟「放現金(報酬 0)」比。
 *     校正:真反一(最長沒斷崖那段,2023-06 起)vs −1 ×(0050 含息)每天,解出實際每年 carry;比 −1% 差就加一個「校正版」。
 *     反一來回成本 RT = 0.385%(手續費 0.1425% × 2 + ETF 證交稅 0.1%)。
 *  B 大跌之後放空(事件;訊號當天收盤看到 → 隔天收盤進,⛔ 當天收盤):
 *     E1 單日大跌:台股收盤跌 ≥3%(格 2.5 / 3.5)・各國 log 報酬 ≤ −2.5σ(σ 用前 250 天,⛔ 含當天;格 2.25 / 2.75);10 天內只算一次
 *     E2 離一年高點跌 10%(段首;格 8 / 12)・E3 25 天內跌 15%(格 20 天 / 30 天)・E4 跌 20%(格 18 / 22)—— 中心 = crash_events.legsWithEvents
 *       (App 大跌通知同一份定義,跑的時候逐市場比對)・E5 嚴格空頭第一天(收盤 < 60 日線且 20 日線 < 60 日線、前一天不是;20 天內只算一次;
 *       格 (40,120) / (50,200))。抱 h = 5 / 20 / 60 / 120 天(中心 20、60)。
 *     看:平均 / 中位 / 賺的比例 / 抱著期間最多倒賠(中位)/ 賺 ≥10% / 賠 ≥10%。對照 = 同市場「修正中隨便一天放空」。
 *     過關(全部):①扣成本平均 > 0 ②贏對照 ③前後半同向 ④有 ≥2 次的市場六成同向 ⑤拿掉最好的危機群還 > 0 ⑥左右一格同向
 *       ⑦全部格子一起 BH q ≤ 0.10(t 值用危機群:相隔 ≤90 天算同一群)。高通膨市場(^MERV / XU100.IS)不進主判準。
 *  C 星期五大跌 → 下一個交易日(fri-drop 的國外樣本外):星期五(UTC)收盤跌 ≥2%(格 1.5 / 2.5;另一版 ≤ −2.5σ)→ 下一個交易日收盤對收盤,
 *     跟同市場「星期一~四同樣跌」比。過關:國外合併(⛔ 台股)比較差、群(同一週)t ≤ −2、六成市場同向、打亂星期幾 p ≤ 0.05、高原;
 *     要拿來放空還要:放空一天平均 > 0 且拿掉最大 3 次還 > 0(已扣 RT)。以色列(以前週日~週四開盤)不算。
 *  D 空頭時抱反一(拿錢做,1 元起跑):①一直抱 ②空頭換現金 ③空頭換反一 ④空頭一半反一一半現金。
 *     空頭 = 收盤 < 長均線且短均線 < 長均線;第 t 天收盤判定 → 第 t+1 天收盤換(⛔ 同一天);中心 (20,60),格 (40,120) / (50,200),
 *     另一版「收盤 < 200 日線」。換手成本:買 ETF 0.0855%、賣 0.1855%(= crash_playbook_probe FEE_BUY / FEE_SELL)。
 *     看:年化、最多賠、逐年 ③ 贏 ② 的比例、最差一年。安慰劑 = 空頭日子整段循環平移(≥250 天)200 次。
 *     過關:六成市場 ③ > ② 且中位 > 0、一半以上市場贏安慰劑第 90 百分位、台股兩版都贏、格子同向。
 *  E 股市在高點、信用利差變大(高盛那種股債背離):前一個美股交易日收盤看到 → 下一個交易日收盤進(台股 = 第一個比美國日期晚的台股日)。
 *     C1 標普 ≥ 一年高點 ×0.95 且 BAA10Y 創一年新高 ・C2 標普 ≥ ×0.95 且 BAA10Y 60 天升 ≥0.5(格 0.3 / 0.75)
 *     ・C3 標普 ≥ ×0.97 且 HYG ÷ IEF ≤ 60 日高 ×0.97(格 0.96 / 0.98,2007 起);60 天內只算一次。
 *     之後 20 / 60 / 120 天報酬 + 「60 天內最多跌 ≥10%」比例:標普、那斯達克、加權含息;對照 = 同樣在高點附近的全部日子。
 *     安慰劑 = 利差序列整段循環平移 1,000 次。六關:①比對照差(報酬低、大跌比例高)②前後半同向 ③逐 10 年六成同向
 *       ④拿掉最差那次還差 ⑤高原 ⑥安慰劑 p ≤ 0.10;+ BH。
 *  F 放空個股(台股 d16 2010 起含下市;PARTS 有 F 才跑):
 *     F1 跟「大跌撿便宜」反著做:加權跌 ≥3% 那天,熱門股(近 20 日成交額前 100)當天跌最多 10 檔(= dipleader RSlo)→ 隔天開盤融券、
 *       抱 5 / 20 天(格 2.5 / 3.5%);F2 嚴格空頭的日子每 20 天一次,放空熱門股裡 60 天跌最多的 10 檔、抱 20 天(格 5 / 15 檔、40 / 120 天)。
 *     兩版:(a) 開盤低於前一天收盤 → 空不到(平盤以下限制)(b) 不管限制(開在跌停一樣空不到)。
 *     成本 0.665%(手續費 ×2 + 證交稅 0.3% + 融券手續費 0.08%);⚠️ 股東會 / 除權息停券強制回補沒模擬(寫明)。
 *     對照 = 同一天放空 0050(反一,隔天開盤進)。過關同 B(①扣成本 > 0 ②贏放空 0050 ③前後半 ④逐年六成 ⑤拿掉最好一年 ⑥高原)。
 *
 * 跑法:
 *   WORLD=<world_hist.json.gz> IDX_LONG=… IDX_EARLY=… TWII_NOW=… [INV=<00632R.json>] [B50=<0050.json>] [DIV50=<_div0050.json>] \
 *     [CUT=2026-11-05] node scripts/short_inverse_probe.mjs out.json
 *   PARTS=F D16=<d16 目錄> DIV=<_div16.json> node --max-old-space-size=8000 scripts/short_inverse_probe.mjs outF.json
 *   node scripts/short_inverse_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadIndex, corrLegs, mean, med, r2, rng, bh, sma, rollMax } from './lib_crash.mjs';
import { prepMarket, loadWorld, clusters, clusterStats, HIGH_INF } from './rebound_lab_probe.mjs';
import { synth2x, FEE_BUY, FEE_SELL } from './crash_playbook_probe.mjs';
import { legsWithEvents } from './crash_events.mjs';
import { wdOf } from './dipbuy_probe.mjs';
import { trSeries, d10 } from './lib_totalreturn.mjs';
import { limitOf } from './lib_limit.mjs';

export const RT = 2 * 0.001425 + 0.001;                     // 反一來回 0.385%
export const SHORT_COST = 2 * 0.001425 + 0.003 + 0.0008;     // 融券來回 0.665%
export const CARRY = -0.01, CARRY_GRID = [-0.04, 0.02];
export const HB = [5, 20, 60, 120];
export const PRE = {
    E1tw: { x: 3, grid: [2.5, 3.5] }, E1: { k: 2.5, grid: [2.25, 2.75] },
    E2: { dd: 10, grid: [8, 12] }, E3: { x: 15, w: 25, grid: [20, 30] }, E4: { x: 20, grid: [18, 22] },
    E5: { ma: [20, 60], grid: [[40, 120], [50, 200]] },
    C: { x: 2, grid: [1.5, 2.5], k: 2.5 },
    D: { ma: [20, 60], grid: [[40, 120], [50, 200]], ma200: 200 },
    CR: { c2: 0.5, c2g: [0.3, 0.75], c3: 0.97, c3g: [0.96, 0.98] },
    F1: { x: 3, grid: [2.5, 3.5], hs: [5, 20] }, F2: { n: 10, L: 60, h: 20, gridN: [5, 15], gridL: [40, 120], every: 20 },
};
const SEED = 23;
const INJ = process.env.SI_INJECT || '';
const NOT_WEEK = new Set(['^TA125.TA']);
export const pct = x => (x == null || !Number.isFinite(x) ? null : r2(x * 100));
const share = (a, f) => (a.length ? a.filter(f).length / a.length : null);
export const normCdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804014327 * Math.exp(-z * z / 2); const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return z > 0 ? 1 - p : p; };
const firstPos = P => { for (let i = 0; i < P.length; i++) if (P[i] > 0) return i; return -1; };

// ═════════ A 合成反一 + 校正 ═════════
/** 合成 L 倍:每天 L × 報酬 + 每年 carry ÷ 252;from 那天 = 1;P 沒值的天沿用前一天 */
export function synthL(P, from, L, carry = CARRY) {
    const out = new Array(P.length).fill(null); if (from < 0) return out; out[from] = 1;
    for (let i = from + 1; i < P.length; i++) {
        if (!(P[i] > 0) || !(P[i - 1] > 0)) { out[i] = out[i - 1]; continue; }
        out[i] = out[i - 1] * (1 + L * (P[i] / P[i - 1] - 1) + carry / 252);
    }
    return out;
}
/** 最長沒斷崖那段(單日 |漲跌| > 30% 切開) */
export function longestClean(px) {
    let best = [0, 0], s = 0;
    for (let i = 1; i <= px.length; i++) {
        const cut = i === px.length || Math.abs(px[i].c / px[i - 1].c - 1) > 0.3;
        if (cut) { if (i - s > best[1] - best[0]) best = [s, i]; s = i; }
    }
    return px.slice(best[0], best[1]);
}
/** 真反一([{d,c}])vs −1 × 含息序列({d,v}):解出每年 carry(合成 = 真的) */
export function calibrate(inv, tr) {
    const seg = longestClean(inv), m = new Map(tr.d.map((d, i) => [d, tr.v[i]]));
    const rows = seg.filter(x => m.get(x.d) > 0).map(x => ({ d: x.d, inv: x.c, tr: m.get(x.d) }));
    if (rows.length < 100) return null;
    for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].tr / rows[i - 1].tr - 1) > 0.3) return { error: `含息序列 ${rows[i].d} 單日變動 > 30%(斷崖)→ 不校正` };
    const P = rows.map(r => r.tr), real = rows.at(-1).inv / rows[0].inv - 1;
    const synAt = c => synthL(P, 0, -1, c).at(-1) - 1;
    let lo = -0.5, hi = 0.5;
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (synAt(mid) < real) lo = mid; else hi = mid; }
    const ri = [], rs = [];
    for (let i = 1; i < rows.length; i++) { ri.push(rows[i].inv / rows[i - 1].inv - 1); rs.push(-(rows[i].tr / rows[i - 1].tr - 1)); }
    const mi = mean(ri), ms = mean(rs); let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < ri.length; i++) { sxy += (ri[i] - mi) * (rs[i] - ms); sxx += (ri[i] - mi) ** 2; syy += (rs[i] - ms) ** 2; }
    return { from: rows[0].d, to: rows.at(-1).d, days: rows.length, real: pct(real), syn: pct(synAt(CARRY)), tr: pct(P.at(-1) / P[0] - 1), carryFit: pct((lo + hi) / 2), corr: r2(sxy / Math.sqrt(sxx * syy)) };
}

// ═════════ B 事件 ═════════
const dedup = (ev, gap) => { const out = []; let last = -1e9; for (const t of ev) if (t - last > gap) { out.push(t); last = t; } return out; };
/** 收盤跌 ≥X%(10 天內只算一次)*/
export function dropPct(c, X, gap = 10) { const ev = []; for (let t = 1; t < c.length; t++) if (c[t] / c[t - 1] - 1 <= -X / 100) ev.push(t); return dedup(ev, gap); }
/** log 報酬 ≤ −k × σ(前 250 天)*/
export function dropSigma(M, k, gap = 10) { const ev = []; for (let t = 1; t < M.c.length; t++) if (Number.isFinite(M.sig[t]) && M.r[t] <= -k * M.sig[t]) ev.push(t); return dedup(ev, gap); }
/** 段首:離 250 日高點跌 DD% 的第一天 */
export function legStarts(c, DD = 10) { return corrLegs(Array.from(c), 250, DD, 5).legs.map(L => L.s); }
/** 25 天內跌 X%(每段第一次;段 = 10% 修正段)*/
export function fastFirst(c, X = 15, Wn = 25) {
    const cc = Array.from(c), { corr, legs } = corrLegs(cc, 250, 10, 5), out = [];
    legs.forEach((L, k) => { for (let i = Math.max(L.s, Wn); i <= L.e; i++) { if (corr[i] !== k) continue; let mx = -Infinity; for (let j = i - Wn; j < i; j++) if (cc[j] > mx) mx = cc[j]; if (cc[i] <= mx * (1 - X / 100)) { out.push(i); break; } } });
    return out;
}
/** 離 250 日高點跌 X%(每段第一次)*/
export function ddFirst(c, X = 20) {
    const cc = Array.from(c), { corr, legs, hi } = corrLegs(cc, 250, 10, 5), out = [];
    legs.forEach((L, k) => { for (let i = L.s; i <= L.e; i++) if (corr[i] === k && cc[i] / hi[i] - 1 <= -X / 100) { out.push(i); break; } });
    return out;
}
/** 嚴格空頭:收盤 < b 日線且 a 日線 < b 日線(均線沒好 = null)*/
export function bearState(c, a = 20, b = 60) {
    const cc = Array.from(c), ma = sma(cc, a), mb = sma(cc, b);
    return cc.map((x, i) => (ma[i] == null || mb[i] == null ? null : x < mb[i] && ma[i] < mb[i]));
}
export function belowMA(c, n = 200) { const cc = Array.from(c), m = sma(cc, n); return cc.map((x, i) => (m[i] == null ? null : x < m[i])); }
export function bearStarts(st, gap = 20) { const ev = []; for (let t = 1; t < st.length; t++) if (st[t] && !st[t - 1]) ev.push(t); return dedup(ev, gap); }
/** 中心定義 == App 大跌通知(crash_events.legsWithEvents);回 {leg10, fast15, bear20} 的索引 */
export function appEvents(c, d) {
    const pos = new Map(d.map((x, i) => [x, i])), o = { leg10: [], fast15: [], bear20: [] };
    for (const L of legsWithEvents(Array.from(c), d)) for (const e of L.ev) if (o[e.k]) o[e.k].push(pos.get(e.d));
    return o;
}

/** 一次放空:第 t 天收盤看到 → 第 t+1 天收盤進反一、抱 h 天 */
export function shortRun(N, t, h, cost = RT) {
    const e = INJ === 'peek' ? t - 1 : t + 1, x = e + h;
    if (e < 0 || x >= N.length || !(N[e] > 0) || !(N[x] > 0)) return null;
    let mn = N[e]; for (let k = e + 1; k <= x; k++) if (N[k] < mn) mn = N[k];
    return { ret: N[x] / N[e] - 1 - cost, mae: mn / N[e] - 1 };
}
const navOf = (M, carry) => { M._N = M._N || {}; if (!M._N[carry]) M._N[carry] = synthL(M.P, firstPos(M.P), -1, carry); return M._N[carry]; };
const baseOf = (M, N, h, carry, all = false) => {
    const key = `${carry}|${h}|${all ? 1 : 0}`; M._B = M._B || {};
    if (!M._B[key]) { const b = []; for (let t = 0; t + 1 + h < N.length; t++) { if (!all && M.corr[t] < 0) continue; const e = t + 1, x = e + h; if (N[e] > 0 && N[x] > 0) b.push(N[x] / N[e] - 1 - RT); } M._B[key] = b; }
    return M._B[key];
};
/** 一組事件在一批市場:每個事件 vs 同市場「修正中隨便一天」*/
export function evalEvents(markets, evOf, h, opt = {}) {
    const carry = opt.carry ?? CARRY, exclude = opt.exclude ?? HIGH_INF, rows = [];
    for (const M of markets) {
        if (exclude.has(M.sym)) continue;
        const N = navOf(M, carry), base = baseOf(M, N, h, carry);
        if (base.length < 30) continue;
        const bm = mean(base);
        for (const t of evOf(M)) { if (t == null) continue; const r = shortRun(N, t, h); if (r) rows.push({ sym: M.sym, d: M.d[t], t, ...r, x: r.ret - bm, base }); }
    }
    return summarize(rows, opt.seed ?? SEED, opt.sims ?? 1000);
}
export function summarize(rows, seed = SEED, sims = 1000) {
    if (rows.length < 3) return { n: rows.length };
    const xs = rows.map(r => r.ret), ex = rows.map(r => r.x), maes = rows.map(r => r.mae);
    const cl = clusters(rows.map(r => r.d)), cs = clusterStats(xs, cl);
    const srt = [...rows].sort((a, b) => (a.d < b.d ? -1 : 1)), k = srt.length >> 1;
    const h1 = mean(srt.slice(0, k).map(r => r.ret)), h2 = mean(srt.slice(k).map(r => r.ret));
    const by = new Map(); for (const r of rows) { if (!by.has(r.sym)) by.set(r.sym, []); by.get(r.sym).push(r.ret); }
    const mk = [...by.values()].filter(a => a.length >= 2), mkPos = mk.filter(a => mean(a) > 0).length;
    const R = rng(seed), em = mean(xs); let ge = 0;
    for (let s = 0; s < sims; s++) { let sum = 0; for (const r of rows) sum += r.base[Math.floor(R() * r.base.length)]; if (sum / rows.length >= em) ge++; }
    return {
        n: rows.length, mkts: by.size, clusters: cs.k, mean: pct(em), med: pct(med(xs)), win: pct(share(xs, v => v > 0)),
        g10: pct(share(xs, v => v >= 0.10)), l10: pct(share(xs, v => v <= -0.10)), maeMed: pct(med(maes)), mae10: pct(share(maes, v => v <= -0.10)),
        worst: pct(Math.min(...xs)), best: pct(Math.max(...xs)), ex: pct(mean(ex)),
        t: cs.t == null ? null : +cs.t.toFixed(2), pT: cs.t == null ? null : +(1 - normCdf(cs.t)).toFixed(4), noBest: pct(cs.noBest),
        h1: pct(h1), h2: pct(h2), mkPos: `${mkPos}/${mk.length}`, mkShare: mk.length ? mkPos / mk.length : null, pCtl: +(ge / sims).toFixed(3),
        first: srt[0].d, last: srt.at(-1).d,
    };
}
export function gatesB(s, nbs = []) {
    if (!s || !s.n || s.n < 3) return null;
    return { pos: s.mean > 0, ctl: s.ex > 0, halves: s.h1 > 0 && s.h2 > 0, mkts: s.mkShare == null ? null : s.mkShare >= 0.6, noBest: s.noBest > 0, plateau: nbs.length ? nbs.every(z => z && z.n >= 3 && z.mean > 0) : null };
}
const passAll = g => !!g && Object.values(g).every(v => v === true || v === null);

// ═════════ C 星期五大跌 ═════════
export const mondayOf = d => { const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00Z'), wd = new Date(t).getUTCDay(); return new Date(t - ((wd + 6) % 7) * 864e5).toISOString().slice(0, 10); };
export function friCollect(M, X, opt = {}) {
    const c = M.c, F = [], T = [];
    for (let t = 1; t + 1 < c.length; t++) {
        const hit = opt.sigma ? (Number.isFinite(M.sig[t]) && M.r[t] <= -opt.sigma * M.sig[t]) : c[t] / c[t - 1] - 1 <= -X / 100;
        if (!hit) continue;
        const wd = wdOf(M.d[t]); if (wd < 1 || wd > 5) continue;
        (wd === 5 ? F : T).push({ sym: M.sym, d: M.d[t], nx: c[t + 1] / c[t] - 1, wk: mondayOf(M.d[t]) });
    }
    return { F, T };
}
export function friEval(markets, X, opt = {}) {
    const exclude = opt.exclude ?? new Set(), per = [];
    for (const M of markets) { if (exclude.has(M.sym) || NOT_WEEK.has(M.sym)) continue; per.push({ sym: M.sym, ...friCollect(M, X, opt) }); }
    const F = per.flatMap(p => p.F), T = per.flatMap(p => p.T);
    if (F.length < 5 || T.length < 5) return { nF: F.length, nT: T.length };
    const nx = a => a.map(r => r.nx), mF = mean(nx(F)), mT = mean(nx(T)), diff = mF - mT;
    const cm = rows => { const by = new Map(); for (const r of rows) { if (!by.has(r.wk)) by.set(r.wk, []); by.get(r.wk).push(r.nx); } return [...by.values()].map(a => mean(a)); };
    const v = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1); };
    const cF = cm(F), cT = cm(T), t = (mean(cF) - mean(cT)) / Math.sqrt(v(cF) / cF.length + v(cT) / cT.length);
    const mk = per.filter(p => p.F.length >= 3 && p.T.length >= 3), mkNeg = mk.filter(p => mean(nx(p.F)) < mean(nx(p.T))).length;
    const cut = [...F].sort((a, b) => (a.d < b.d ? -1 : 1))[F.length >> 1].d;
    const half = f => { const a = F.filter(r => f(r.d)), b = T.filter(r => f(r.d)); return a.length && b.length ? mean(nx(a)) - mean(nx(b)) : null; };
    const R = rng(opt.seed ?? SEED), sims = opt.sims ?? 2000; let le = 0;
    for (let s = 0; s < sims; s++) {
        let sF = 0, nF = 0, sT = 0, nT = 0;
        for (const p of per) {
            const all = [...p.F, ...p.T].map(r => r.nx), k = p.F.length;
            for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
            for (let i = 0; i < all.length; i++) { if (i < k) { sF += all[i]; nF++; } else { sT += all[i]; nT++; } }
        }
        if (sF / nF - sT / nT <= diff) le++;
    }
    const sh = F.map(r => -r.nx - RT).sort((a, b) => b - a);
    return {
        nF: F.length, nT: T.length, mkts: per.filter(p => p.F.length).length, weeksF: cF.length, mF: pct(mF), mT: pct(mT), diff: pct(diff), t: +t.toFixed(2),
        upF: pct(share(nx(F), x => x > 0)), upT: pct(share(nx(T), x => x > 0)), mkNeg: `${mkNeg}/${mk.length}`, mkShare: mk.length ? mkNeg / mk.length : null,
        h1: pct(half(d => d < cut)), h2: pct(half(d => d >= cut)), pPerm: +(le / sims).toFixed(4),
        short: pct(mean(sh)), shortNoTop3: pct(mean(sh.slice(3))), shortWin: pct(share(sh, x => x > 0)), cut,
    };
}

// ═════════ D 空頭時抱反一 ═════════
/** st[t] = 第 t 天收盤判定;第 k 天的報酬(k−1 → k)用 st[k−2](第 t+1 天收盤才換)*/
export function regimeRun(d, P, st, carry = CARRY) {
    const n = P.length, keys = ['A', 'B', 'C', 'D'], nav = { A: 1, B: 1, C: 1, D: 1 }, peak = { ...nav }, mdd = { A: 0, B: 0, C: 0, D: 0 };
    let prev = null, k0 = -1, kL = -1, days = 0, bearDays = 0, sw = 0; const yEnd = new Map();
    for (let k = 2; k < n; k++) {
        const s = st[k - 2];
        if (s == null || !(P[k] > 0) || !(P[k - 1] > 0)) continue;
        if (k0 < 0) { k0 = k; yEnd.set('start', { ...nav }); }
        const bear = !!s;
        if (prev != null && bear !== prev) {
            sw++;
            if (bear) { nav.B *= 1 - FEE_SELL; nav.C *= (1 - FEE_SELL) * (1 - FEE_BUY); nav.D *= (1 - FEE_SELL) * (1 - 0.5 * FEE_BUY); }
            else { nav.B *= 1 - FEE_BUY; nav.C *= (1 - FEE_SELL) * (1 - FEE_BUY); nav.D *= (1 - 0.5 * FEE_SELL) * (1 - FEE_BUY); }
        }
        prev = bear;
        const a = P[k] / P[k - 1] - 1, inv = -a + carry / 252;
        nav.A *= 1 + a;
        if (bear) { nav.C *= 1 + inv; nav.D *= 1 + 0.5 * inv; bearDays++; } else { nav.B *= 1 + a; nav.C *= 1 + a; nav.D *= 1 + a; }
        days++; kL = k;
        for (const key of keys) { if (nav[key] > peak[key]) peak[key] = nav[key]; const x = nav[key] / peak[key] - 1; if (x < mdd[key]) mdd[key] = x; }
        yEnd.set(String(d[k]).slice(0, 4), { ...nav });
    }
    if (k0 < 0 || kL - k0 < 250) return null;
    const yrs = (Date.parse(d[kL]) - Date.parse(d[k0 - 1])) / (365.25 * 864e5);
    const cagr = Object.fromEntries(keys.map(key => [key, Math.pow(nav[key], 1 / yrs) - 1]));
    const yr = []; let pv = yEnd.get('start');
    for (const [y, e] of yEnd) { if (y === 'start') continue; yr.push({ y, ...Object.fromEntries(keys.map(key => [key, e[key] / pv[key] - 1])) }); pv = e; }
    return { from: d[k0 - 1], to: d[kL], yrs, nav, cagr, mdd, yr, bearShare: bearDays / days, swPerYr: sw / yrs };
}
export function shiftState(st, o) {
    const v0 = st.findIndex(x => x != null); if (v0 < 0) return st.slice();
    const seg = st.slice(v0), n = seg.length, out = st.slice(0, v0);
    for (let i = 0; i < n; i++) out.push(seg[(i + o) % n]);
    return out;
}
export function regimeEval(M, st, opt = {}) {
    const carry = opt.carry ?? CARRY, r = regimeRun(M.d, M.P, st, carry); if (!r) return null;
    const act = r.cagr.C - r.cagr.B, R = rng((opt.seed ?? SEED) + M.d.length), sims = [];
    const v0 = st.findIndex(x => x != null), L = st.length - v0;
    for (let s = 0; s < (opt.sims ?? 200) && L > 600; s++) { const o = 250 + Math.floor(R() * (L - 500)); const q = regimeRun(M.d, M.P, shiftState(st, o), carry); if (q) sims.push(q.cagr.C - q.cagr.B); }
    sims.sort((a, b) => a - b);
    const p90 = sims.length ? sims[Math.floor(sims.length * 0.9)] : null;
    const yrsCB = r.yr.filter(y => y.C > y.B).length;
    return { sym: M.sym, from: r.from, to: r.to, yrs: r2(r.yrs), A: pct(r.cagr.A), B: pct(r.cagr.B), C: pct(r.cagr.C), D: pct(r.cagr.D),
        mddA: pct(r.mdd.A), mddB: pct(r.mdd.B), mddC: pct(r.mdd.C), mddD: pct(r.mdd.D), CB: pct(act), yrCB: `${yrsCB}/${r.yr.length}`, yrShare: r.yr.length ? yrsCB / r.yr.length : null,
        worstC: pct(Math.min(...r.yr.map(y => y.C))), worstB: pct(Math.min(...r.yr.map(y => y.B))), bear: pct(r.bearShare), swPerYr: r2(r.swPerYr),
        plP90: pct(p90), beatPl: p90 != null && act > p90, plPct: sims.length ? r2(sims.filter(x => x < act).length / sims.length * 100) : null };
}

// ═════════ E 股債背離 ═════════
/** 對齊:每個 dates[i] 取「日期 ≤ dates[i]」最後一個有值的 */
export function asofAlign(dates, srcD, srcV) {
    const out = new Array(dates.length).fill(null); let j = -1, last = null;
    for (let i = 0; i < dates.length; i++) { while (j + 1 < srcD.length && srcD[j + 1] <= dates[i]) { j++; const v = srcV[j]; if (v != null && Number.isFinite(+v)) last = +v; } out[i] = last; }
    return out;
}
function rollMaxNull(X, W) {
    const n = X.length, mx = new Array(n).fill(null), cnt = new Int32Array(n), q = []; let c = 0, h = 0;
    for (let i = 0; i < n; i++) {
        if (X[i] != null) { while (q.length > h && X[q[q.length - 1]] <= X[i]) q.pop(); q.push(i); c++; }
        if (i - W >= 0 && X[i - W] != null) c--;
        while (q.length > h && q[h] <= i - W) h++;
        mx[i] = q.length > h ? X[q[h]] : null; cnt[i] = c;
    }
    return { mx, cnt };
}
/** 訊號(對齊標普日期的布林):near = 標普 ≥ 一年高 × nh */
export function credSig(near, X, kind, par) {
    const n = X.length, out = new Array(n).fill(false);
    const R = kind === 'C1' ? rollMaxNull(X, 250) : kind === 'C3' ? rollMaxNull(X, 60) : null;
    for (let t = 250; t < n; t++) {
        if (!near[t] || X[t] == null) continue;
        if (kind === 'C1') out[t] = R.cnt[t] >= 200 && X[t] >= R.mx[t];
        else if (kind === 'C2') out[t] = X[t - 60] != null && X[t] - X[t - 60] >= par;
        else if (kind === 'C3') out[t] = R.cnt[t] >= 50 && X[t] <= R.mx[t] * par;
    }
    return out;
}
export const firstEvery = (b, gap) => { const out = []; let last = -1e9; for (let t = 0; t < b.length; t++) if (b[t] && t - last > gap) { out.push(t); last = t; } return out; };
const firstAfter = (ds, D) => { let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] <= D) lo = m + 1; else hi = m; } return lo < ds.length ? lo : -1; };
/** 資產 A({d,v})在美國日期 D 之後第一個交易日收盤進:h 天報酬、60 天內最多跌 ≥10% */
export function outAt(A, D, h) {
    const e = firstAfter(A.d, D); if (e < 0 || e + Math.max(h, 60) >= A.v.length || !(A.v[e] > 0)) return null;
    let mn = A.v[e]; for (let k = e; k <= e + 60; k++) if (A.v[k] > 0 && A.v[k] < mn) mn = A.v[k];
    return { r: A.v[e + h] / A.v[e] - 1, dd: mn / A.v[e] - 1 <= -0.10 };
}
export function credEval(spx, X, kind, par, nh, assets, opt = {}) {
    const near = (() => { const hi = rollMax(Array.from(spx.c), 250); return Array.from(spx.c, (x, i) => i >= 249 && x >= hi[i] * nh); })();
    const evIdx = firstEvery(credSig(near, X, kind, par), 60);
    const ctlIdx = []; for (let t = 250; t < spx.c.length; t++) if (near[t] && X[t] != null) ctlIdx.push(t);
    const res = {};
    for (const [name, A] of Object.entries(assets)) {
        res[name] = {};
        for (const h of [20, 60, 120]) {
            const ev = evIdx.map(t => ({ d: spx.d[t], o: outAt(A, spx.d[t], h) })).filter(z => z.o), ctl = ctlIdx.map(t => outAt(A, spx.d[t], h)).filter(Boolean);
            if (ev.length < 3 || ctl.length < 100) { res[name][h] = { n: ev.length }; continue; }
            const er = ev.map(z => z.o.r), cr = ctl.map(o => o.r), mE = mean(er), mC = mean(cr);
            const ddE = share(ev, z => z.o.dd), ddC = share(ctl, o => o.dd);
            const srt = [...ev].sort((a, b) => (a.d < b.d ? -1 : 1)), k = srt.length >> 1;
            const h1 = mean(srt.slice(0, k).map(z => z.o.r)) - mC, h2 = mean(srt.slice(k).map(z => z.o.r)) - mC;
            const dec = new Map(); for (const z of ev) { const y = z.d.slice(0, 3); if (!dec.has(y)) dec.set(y, []); dec.get(y).push(z.o.r); }
            const decs = [...dec.values()].filter(a => a.length >= 2), decW = decs.filter(a => mean(a) < mC).length;
            const noWorst = mean([...er].sort((a, b) => a - b).slice(1));
            res[name][h] = { n: ev.length, mean: pct(mE), ctl: pct(mC), diff: pct(mE - mC), dd: pct(ddE), ddCtl: pct(ddC), h1: pct(h1), h2: pct(h2), dec: `${decW}/${decs.length}`, decShare: decs.length ? decW / decs.length : null, noWorst: pct(noWorst - mC), dates: ev.map(z => z.d) };
        }
    }
    // 安慰劑:利差整段循環平移(標普 60 天)
    const main = Object.keys(assets)[0], m60 = res[main][60];
    if (m60 && m60.n >= 3 && opt.sims !== 0) {
        const v0 = X.findIndex(x => x != null), seg = X.slice(v0), L = seg.length, Rr = rng((opt.seed ?? SEED) + Math.round(par * 1000)), sims = [], simsDD = [];
        const A = assets[main];
        const ctl60 = ctlIdx.map(t => outAt(A, spx.d[t], 60)).filter(Boolean), mC = mean(ctl60.map(o => o.r));
        for (let s = 0; s < (opt.sims ?? 1000) && L > 1000; s++) {
            const o = 250 + Math.floor(Rr() * (L - 500)), X2 = X.slice(0, v0); for (let i = 0; i < L; i++) X2.push(seg[(i + o) % L]);
            const ev = firstEvery(credSig(near, X2, kind, par), 60).map(t => outAt(A, spx.d[t], 60)).filter(Boolean);
            if (ev.length >= 3) { sims.push(mean(ev.map(z => z.r)) - mC); simsDD.push(share(ev, z => z.dd)); }
        }
        const act = m60.diff / 100, actDD = m60.dd / 100;
        res.placebo = { sims: sims.length, p: sims.length ? +(sims.filter(x => x <= act).length / sims.length).toFixed(3) : null, pDD: simsDD.length ? +(simsDD.filter(x => x >= actDD).length / simsDD.length).toFixed(3) : null, med: pct(med(sims)) };
    }
    // 現在亮不亮(最後一個有利差的日子)
    let lastT = -1; for (let t = X.length - 1; t >= 0; t--) if (X[t] != null) { lastT = t; break; }
    const sig = credSig(near, X, kind, par);
    res.now = lastT >= 0 ? { d: spx.d[lastT], lit: !!sig[lastT], near: !!near[lastT], x: X[lastT] } : null;
    return res;
}

// ═════════ F 放空個股 ═════════
/** 第 i 天收盤看到 → 第 i+1 天開盤融券、第 i+h 天收盤回補;rule 'uptick' = 開盤低於前一天收盤就空不到 */
export function shortOf(ctx, S, i, h, rule = 'uptick') {
    const n = ctx.cal.length, a = i + 1, b = i + h;
    if (b >= n || a >= n || !(S.O[a] > 0) || !(S.C[i] > 0)) return null;
    const ratio = S.O[a] * S.F[a] / S.C[i];
    if (ratio <= 1 - limitOf(ctx.cal[a]) + 0.003) return 'lock';
    if (rule === 'uptick' && ratio < 1 - 1e-9) return 'noshort';
    if (!(S.C[b] > 0) || S.jump[b] > i) return null;
    let f = 1; for (let k = a + 1; k <= b; k++) f *= S.F[k];
    return -(S.C[b] * f / S.O[a] - 1) - SHORT_COST;
}
/** 0050 含息:第 i+1 天開盤買 → 第 i+h 天收盤(= dipleader bench 'o',V82.0.2 修好的那一版)*/
export function bench50(ctx, i, h) {
    const tr = ctx.etf.tr, b = i + h; if (b >= tr.length) return NaN;
    const o = ctx.b50o ? ctx.b50o[i + 1] : NaN, k = Number.isFinite(o) && o > 0 ? 1 / o : 1;
    return k * tr[b] / tr[i + 1] - 1;
}
function fStats(rows, key = 'ep') {
    if (rows.length < 3) return { n: rows.length };
    const xs = rows.map(r => r.ret), inv = rows.map(r => r.inv);
    const by = new Map(); for (const r of rows) { const k = r[key]; if (!by.has(k)) by.set(k, []); by.get(k).push(r.ret); }
    const cm = [...by.values()].map(a => mean(a)), m = mean(cm), sd = cm.length > 1 ? Math.sqrt(cm.reduce((s, x) => s + (x - m) ** 2, 0) / (cm.length - 1)) : NaN;
    const srt = [...rows].sort((a, b) => a.i - b.i), k = srt.length >> 1;
    const yr = new Map(); for (const r of rows) { const y = r.d.slice(0, 4); if (!yr.has(y)) yr.set(y, []); yr.get(y).push(r.ret); }
    const ys = [...yr.entries()].map(([y, a]) => [y, mean(a)]), best = ys.slice().sort((a, b) => b[1] - a[1])[0][0];
    const t = sd > 0 ? m / (sd / Math.sqrt(cm.length)) : null;
    return { n: rows.length, eps: cm.length, mean: pct(mean(xs)), med: pct(med(xs)), win: pct(share(xs, v => v > 0)), inv: pct(mean(inv)), vsInv: pct(mean(xs) - mean(inv)),
        t: t == null ? null : +t.toFixed(2), pT: t == null ? null : +(1 - normCdf(t)).toFixed(4), h1: pct(mean(srt.slice(0, k).map(r => r.ret))), h2: pct(mean(srt.slice(k).map(r => r.ret))),
        yrPos: `${ys.filter(y => y[1] > 0).length}/${ys.length}`, yrShare: ys.filter(y => y[1] > 0).length / ys.length, noBestYr: pct(mean(rows.filter(r => !r.d.startsWith(best)).map(r => r.ret))), best,
        fill: pct(mean(rows.map(r => r.fill))), worst: pct(Math.min(...xs)) };
}
const gatesF = (s, nbs = []) => (!s || s.n < 3 ? null : { pos: s.mean > 0, beatInv: s.vsInv > 0, halves: s.h1 > 0 && s.h2 > 0, years: s.yrShare >= 0.6, noBestYr: s.noBestYr > 0, plateau: nbs.length ? nbs.every(z => z && z.n >= 3 && z.mean > 0) : null });
export async function runF(env, log) {
    const { loadCtx, mom } = await import('./leader_probe.mjs');
    const { idxRet, dropEvents, lists, rankAt } = await import('./dipleader_probe.mjs');
    const { loadPx } = await import('./lib_totalreturn.mjs');
    const DATA = env.D16; if (!DATA) throw new Error('PARTS=F 要 D16');
    const t0 = Date.now(), ctx = loadCtx(DATA, env.DIV);
    const twR = loadPx(DATA, '^TWII'), tmap = new Map(twR.map(x => [x.d, x.c])), tw = ctx.cal.map(d => tmap.get(d));
    if (tw.some(x => !(x > 0))) throw new Error('加權日曆對不上');
    const p50 = path.join(DATA, '0050.json'), idx = new Map(ctx.cal.map((d, i) => [d, i]));
    ctx.b50o = new Float64Array(ctx.cal.length).fill(NaN);
    if (fs.existsSync(p50)) for (const r of JSON.parse(fs.readFileSync(p50, 'utf8'))) { const k = idx.get(d10(r.date)); if (k !== undefined && +r.open > 0 && +r.close > 0) ctx.b50o[k] = +r.open / +r.close; }
    const ir = idxRet(tw), out = { from: ctx.cal[130], to: ctx.cal.at(-1), stocks: ctx.stocks.length, F1: {}, F2: {} };
    log(`\n📂 F 放空個股:${ctx.stocks.length} 檔 ・${ctx.cal[130]} ~ ${ctx.cal.at(-1)}(${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    // F1
    const f1 = (X, rule) => {
        const D = dropEvents(ir, X), cache = new Map(), rows = { 5: [], 20: [] };
        for (const i of [...D.set].sort((a, b) => a - b)) {
            if (i < 130 || i + 1 >= ctx.cal.length) continue;
            const L = lists(ctx, i, cache).RSlo; if (L.length < 5) continue;
            for (const h of PRE.F1.hs) {
                const v = [], st = { lock: 0, noshort: 0 };
                for (const S of L) { const r = shortOf(ctx, S, i, h, rule); if (typeof r === 'number') v.push(r); else if (r) st[r]++; }
                const b = bench50(ctx, i, h); if (!v.length || !Number.isFinite(b)) continue;
                rows[h].push({ i, d: ctx.cal[i], ep: D.ep.get(i), ret: mean(v), fill: v.length / L.length, inv: -b - RT, ...st });
            }
            for (const k of [...cache.keys()]) if (k < i - 2) cache.delete(k);
        }
        return rows;
    };
    for (const rule of ['uptick', 'free']) {
        out.F1[rule] = {};
        const sets = Object.fromEntries([PRE.F1.x, ...PRE.F1.grid].map(X => [X, f1(X, rule)]));
        for (const h of PRE.F1.hs) {
            const c = fStats(sets[PRE.F1.x][h]), nbs = PRE.F1.grid.map(X => fStats(sets[X][h]));
            out.F1[rule][h] = { ...c, gates: gatesF(c, nbs), grid: Object.fromEntries(PRE.F1.grid.map((X, k) => [X, { n: nbs[k].n, mean: nbs[k].mean }])) };
            log(`  F1 ${rule === 'uptick' ? '平盤以下空不到' : '不管限制'} 跌 ≥${PRE.F1.x}% 抱 ${h} 天:n ${c.n}(${c.eps} 段)・放空平均 ${c.mean}%(中位 ${c.med}・賺 ${c.win}%)・同一天放空 0050 ${c.inv}% ・差 ${c.vsInv} ・群 t ${c.t} ・前後 ${c.h1}/${c.h2} ・逐年 ${c.yrPos} ・拿掉 ${c.best} ${c.noBestYr} ・空得到 ${c.fill}% ・最差 ${c.worst}% ・格 ${PRE.F1.grid.map((X, k) => `${X}% ${nbs[k].mean}`).join(' / ')}`);
        }
    }
    // F2
    const f2 = (N, Lm, rule) => {
        const rows = [], n = ctx.cal.length; let last = -1e9;
        for (let i = 130; i + PRE.F2.h < n; i++) {
            if (!ctx.bear[i] || i - last < PRE.F2.every) continue;
            const { u100 } = rankAt(ctx, i);
            const pick = u100.map(S => ({ S, m: mom(S, i, Lm) })).filter(x => Number.isFinite(x.m)).sort((a, b) => a.m - b.m).slice(0, N).map(x => x.S);
            if (pick.length < Math.min(5, N)) continue;
            const v = [], st = { lock: 0, noshort: 0 };
            for (const S of pick) { const r = shortOf(ctx, S, i, PRE.F2.h, rule); if (typeof r === 'number') v.push(r); else if (r) st[r]++; }
            const b = bench50(ctx, i, PRE.F2.h); if (!v.length || !Number.isFinite(b)) continue;
            rows.push({ i, d: ctx.cal[i], ep: d10(ctx.cal[i]).slice(0, 7), ret: mean(v), fill: v.length / pick.length, inv: -b - RT, ...st });
            last = i;
        }
        // 群 = 同一段空頭(相隔 ≤ 90 天)
        const cl = clusters(rows.map(r => r.d)); rows.forEach((r, k) => { r.ep = cl[k]; });
        return rows;
    };
    for (const rule of ['uptick', 'free']) {
        const c = fStats(f2(PRE.F2.n, PRE.F2.L, rule)), nbs = [...PRE.F2.gridN.map(N => fStats(f2(N, PRE.F2.L, rule))), ...PRE.F2.gridL.map(Lm => fStats(f2(PRE.F2.n, Lm, rule)))];
        out.F2[rule] = { ...c, gates: gatesF(c, nbs), grid: nbs.map(z => ({ n: z.n, mean: z.mean })) };
        log(`  F2 ${rule === 'uptick' ? '平盤以下空不到' : '不管限制'} 空頭放空最弱 ${PRE.F2.n} 檔(${PRE.F2.L} 天)抱 ${PRE.F2.h} 天:n ${c.n}(${c.eps} 段)・平均 ${c.mean}%(中位 ${c.med}・賺 ${c.win}%)・放空 0050 ${c.inv}% ・差 ${c.vsInv} ・群 t ${c.t} ・前後 ${c.h1}/${c.h2} ・逐年 ${c.yrPos} ・拿掉 ${c.best} ${c.noBestYr} ・空得到 ${c.fill}% ・格 ${nbs.map(z => z.mean).join(' / ')}`);
    }
    return out;
}

// ═════════ 主程式 ═════════
export function worldMarkets(W, cut) {
    const S = W.s || {}, BONDS = new Set(['HYG', 'JNK', 'LQD', 'IEF', 'TLT', 'SHY']), out = [];
    for (const [sym, x] of Object.entries(S)) {
        if (BONDS.has(sym) || sym === '^VIX' || sym === '^TWII' || !x.d || x.d.length < 1000) continue;
        let n = x.d.length; while (n > 0 && x.d[n - 1] > cut) n--;
        const M = prepMarket(sym, x.d.slice(0, n), Float64Array.from(x.c.slice(0, n))); M.P = M.c; out.push(M);
    }
    return out;
}
const ser = x => ({ d: x.d, v: x.c });

export async function run(env = process.env, log = console.log) {
    const PARTS = env.PARTS || 'ABCDE', CUT = env.CUT || '2026-11-05';
    const out = { asof: new Date().toISOString().slice(0, 10), cut: CUT, parts: PARTS, pre: PRE, rt: RT, carry: CARRY };
    if (/[ABCDE]/.test(PARTS)) {
        const W = loadWorld(env.WORLD), world = worldMarkets(W, CUT);
        const I = loadIndex(env); let n = I.d.length; while (n > 0 && I.d[n - 1] > CUT) n--;
        const TW = prepMarket('TW', I.d.slice(0, n), Float64Array.from(I.c.slice(0, n))); TW.P = TW.c;
        const TWtr = { ...TW, sym: 'TW含息', P: I.tr.slice(0, n).map(v => (v > 0 ? v : null)), _N: undefined, _B: undefined };
        const all = [...world, TW];
        log(`📂 ${world.length} 個國外市場 + 台股(價格 ${TW.d[0]}~、含息 ${TW.d[firstPos(TWtr.P)]}~ ${TW.d.at(-1)})`);
        // 中心定義 == App 大跌通知
        let mis = 0; for (const M of all) { const a = appEvents(M.c, M.d); if (a.leg10.join() !== legStarts(M.c, 10).join() || a.fast15.join() !== fastFirst(M.c, 15, 25).join() || a.bear20.join() !== ddFirst(M.c, 20).join()) { mis++; log(`  ⚠️ ${M.sym} 事件定義跟 crash_events 對不上`); } }
        log(`✅ 段首 / 25 天跌 15% / 跌 20% 跟 App 大跌通知逐市場比對:${all.length - mis}/${all.length} 一致`);
        if (mis) throw new Error('事件定義跟 crash_events 對不上');

        // ── A ──
        if (PARTS.includes('A')) {
            out.A = {};
            const inv = env.INV && fs.existsSync(env.INV) ? JSON.parse(fs.readFileSync(env.INV, 'utf8')).map(r => ({ d: d10(r.date), c: +r.close })).filter(r => r.c > 0) : null;
            if (inv) {
                const trTW = { d: TW.d, v: TWtr.P };
                out.A.vsTaiex = calibrate(inv, trTW);
                if (env.B50 && fs.existsSync(env.B50)) {
                    const bars = JSON.parse(fs.readFileSync(env.B50, 'utf8')).map(r => ({ d: d10(r.date), c: +r.close })).filter(r => r.c > 0);
                    let d50 = []; if (env.DIV50 && fs.existsSync(env.DIV50)) { const raw = JSON.parse(fs.readFileSync(env.DIV50, 'utf8')); d50 = Array.isArray(raw) ? raw : (raw.h || ((raw.d || raw)['0050'] || {}).h || []); }
                    out.A.vs0050 = calibrate(inv, trSeries(bars, d50));
                    out.A.div50 = d50.length;
                }
                for (const [k, z] of Object.entries(out.A)) if (z && z.from) log(`🧪 A 真反一 vs −1×${k === 'vs0050' ? '0050 含息' : '加權報酬指數'}(${z.from}~${z.to},${z.days} 天):真的 ${z.real}% ・合成(carry −1%)${z.syn}% ・指數本身 ${z.tr}% ・解出 carry ${z.carryFit}%/年 ・每天相關 ${z.corr}`); else if (z && z.error) log(`⚠️ A ${k}:${z.error}`);
            } else log('⚠️ A:沒給 INV(真反一)→ 不校正');
        }
        const fit = out.A && (out.A.vs0050 || out.A.vsTaiex) && (out.A.vs0050 || out.A.vsTaiex).carryFit;
        const carries = [CARRY, ...CARRY_GRID]; if (fit != null && fit / 100 < CARRY) carries.push(+(fit / 100).toFixed(4));

        // ── B ──
        if (PARTS.includes('B')) {
            out.B = { cells: [] };
            const pools = { world: all, twtr: [TWtr], twpx: [TW] };
            const E = {
                E1: { world: M => dropSigma(M, PRE.E1.k), tw: M => dropPct(M.c, PRE.E1tw.x), nb: { world: PRE.E1.grid.map(k => M => dropSigma(M, k)), tw: PRE.E1tw.grid.map(x => M => dropPct(M.c, x)) } },
                E2: { all: M => legStarts(M.c, PRE.E2.dd), nb: PRE.E2.grid.map(x => M => legStarts(M.c, x)) },
                E3: { all: M => fastFirst(M.c, PRE.E3.x, PRE.E3.w), nb: PRE.E3.grid.map(w => M => fastFirst(M.c, PRE.E3.x, w)) },
                E4: { all: M => ddFirst(M.c, PRE.E4.x), nb: PRE.E4.grid.map(x => M => ddFirst(M.c, x)) },
                E5: { all: M => bearStarts(bearState(M.c, ...PRE.E5.ma)), nb: PRE.E5.grid.map(([a, b]) => M => bearStarts(bearState(M.c, a, b))) },
            };
            const NAME = { E1: '單日大跌', E2: '跌 10%(段首)', E3: '25 天內跌 15%', E4: '跌 20%', E5: '嚴格空頭第一天' };
            const POOL = { world: '33 國(含台股價格)', twtr: '台股含息 2003~', twpx: '台股價格 2000~' };
            for (const [pk, mk] of Object.entries(pools)) {
                log(`\n━━ B 大跌之後放空(反一,隔天收盤進)・${POOL[pk]} ━━`);
                // 隨便一天放空 / 修正中隨便一天放空(背景)
                for (const h of [20, 60]) {
                    const allD = mk.filter(M => !HIGH_INF.has(M.sym)).flatMap(M => baseOf(M, navOf(M, CARRY), h, CARRY, true)), corrD = mk.filter(M => !HIGH_INF.has(M.sym)).flatMap(M => baseOf(M, navOf(M, CARRY), h, CARRY));
                    out.B[`${pk}_base${h}`] = { all: pct(mean(allD)), allWin: pct(share(allD, v => v > 0)), corr: pct(mean(corrD)), corrWin: pct(share(corrD, v => v > 0)) };
                    log(`  背景 ${h} 天:隨便一天放空 ${pct(mean(allD))}%(賺 ${pct(share(allD, v => v > 0))}%)・修正中隨便一天 ${pct(mean(corrD))}%(賺 ${pct(share(corrD, v => v > 0))}%)`);
                }
                for (const [ek, def] of Object.entries(E)) {
                    const fn = def.all || (pk === 'world' ? def.world : def.tw);
                    const nbf = def.all ? def.nb : (pk === 'world' ? def.nb.world : def.nb.tw);
                    for (const h of HB) {
                        const s = evalEvents(mk, fn, h), nbs = nbf.map(f => evalEvents(mk, f, h, { sims: 0 }));
                        const g = gatesB(s, nbs);
                        out.B.cells.push({ pool: pk, ev: ek, h, ...s, gates: g, grid: nbs.map(z => z.mean) });
                        if (s.n >= 3) log(`  ${NAME[ek].padEnd(8)} ${String(h).padStart(3)} 天:n ${s.n}(${s.mkts} 市場 ${s.clusters} 群)放空 ${s.mean}%(中位 ${s.med}・賺 ${s.win}%・≥+10% ${s.g10}%・≤−10% ${s.l10}%・期間最多倒賠中位 ${s.maeMed}%)・比修正中隨便一天 ${s.ex} ・群 t ${s.t} ・前後 ${s.h1}/${s.h2} ・市場 ${s.mkPos} ・拿掉最好群 ${s.noBest} ・格 ${nbs.map(z => z.mean).join(' / ')}  ${passAll(g) ? '✅' : '⛔ ' + Object.entries(g || {}).filter(([, v]) => v === false).map(([k]) => k).join('/')}`);
                        else log(`  ${NAME[ek].padEnd(8)} ${h} 天:樣本 ${s.n}`);
                    }
                }
            }
            const qs = bh(out.B.cells.map(c => (c.pT == null ? null : c.pT)));
            out.B.cells.forEach((c, i) => { c.q = qs[i]; });
            out.B.pass = out.B.cells.filter(c => [20, 60].includes(c.h) && passAll(c.gates) && c.q != null && c.q <= 0.10).map(c => `${c.pool}/${c.ev}/${c.h}`);
            log(`\n  B 過關(中心 h=20/60 全部關卡 + BH q ≤0.10):${out.B.pass.length ? out.B.pass.join(' ・') : '0 格'}`);
            // carry 敏感度(中心 E2/E3/E4 × 60 天,33 國)
            out.B.carry = {};
            for (const c of carries) {
                const row = {}; for (const [ek, f] of [['E2', M => legStarts(M.c, 10)], ['E3', M => fastFirst(M.c, 15, 25)], ['E4', M => ddFirst(M.c, 20)]]) { const s = evalEvents(all, f, 60, { carry: c, sims: 0 }); row[ek] = s.mean; }
                out.B.carry[c] = row; log(`  carry ${pct(c)}%/年:33 國 60 天放空 段首 ${row.E2}% ・急跌 15% ${row.E3}% ・跌 20% ${row.E4}%`);
            }
            // 高通膨市場(只列)
            for (const sym of HIGH_INF) { const M = world.find(x => x.sym === sym); if (!M) continue; const s = evalEvents([M], m => fastFirst(m.c, 15, 25), 60, { exclude: new Set(), sims: 0 }); log(`  (只列)${sym} 急跌 15% 60 天:n ${s.n} 放空 ${s.mean}%`); }
        }

        // ── C ──
        if (PARTS.includes('C')) {
            out.C = {};
            log('\n━━ C 星期五大跌 → 下一個交易日(國外樣本外;台股另列)━━');
            const ex = new Set([...HIGH_INF, 'TW']);
            for (const X of [PRE.C.x, ...PRE.C.grid]) {
                const w = friEval(all, X, { exclude: ex }), t = friEval([TW], X, { sims: 2000 });
                out.C[X] = { world: w, tw: t };
                log(`  跌 ≥${X}%:國外 星期五 ${w.nF} 次(${w.mkts} 市場・${w.weeksF} 週)下一個交易日 ${w.mF}% vs 星期一~四 ${w.mT}%(${w.nT} 次)・差 ${w.diff}(群 t ${w.t}・打亂星期幾 p ${w.pPerm})・收高 ${w.upF}% vs ${w.upT}% ・市場 ${w.mkNeg} ・前後 ${w.h1}/${w.h2} ・放空一天 ${w.short}%(拿掉最大 3 次 ${w.shortNoTop3}%・賺 ${w.shortWin}%)`);
                log(`           台股:星期五 ${t.nF} 次 ${t.mF}% vs ${t.mT}%(${t.nT} 次)・差 ${t.diff} ・p ${t.pPerm} ・放空一天 ${t.short}%(拿掉最大 3 次 ${t.shortNoTop3}%)`);
            }
            const s = friEval(all, null, { exclude: ex, sigma: PRE.C.k }); out.C.sigma = s;
            log(`  ≤−${PRE.C.k}σ:國外 星期五 ${s.nF} 次 ${s.mF}% vs ${s.mT}% ・差 ${s.diff}(t ${s.t}・p ${s.pPerm})・放空一天 ${s.short}%(拿掉最大 3 次 ${s.shortNoTop3}%)`);
            const c = out.C[PRE.C.x].world, nb = PRE.C.grid.map(X => out.C[X].world);
            out.C.gates = { worse: c.diff < 0, t: c.t <= -2, mkts: c.mkShare >= 0.6, perm: c.pPerm <= 0.05, halves: c.h1 < 0 && c.h2 < 0, plateau: nb.every(z => z.diff < 0), shortPos: c.short > 0 && c.shortNoTop3 > 0 };
            log(`  C 關卡:${Object.entries(out.C.gates).map(([k, v]) => `${k} ${v ? '✅' : '⛔'}`).join(' ')}`);
        }

        // ── D ──
        if (PARTS.includes('D')) {
            out.D = {};
            log('\n━━ D 空頭時抱反一(①一直抱 ②空頭換現金 ③空頭換反一 ④一半反一一半現金;前一天收盤判定、隔天收盤換)━━');
            const variants = [['ma20_60', M => bearState(M.c, 20, 60)], ['ma40_120', M => bearState(M.c, 40, 120)], ['ma50_200', M => bearState(M.c, 50, 200)], ['below200', M => belowMA(M.c, 200)]];
            for (const [vk, stf] of variants) {
                const rows = [], tw = [];
                for (const M of [...world, TW, TWtr]) { const r = regimeEval(M, stf(M), { sims: vk === 'ma20_60' ? 200 : 60 }); if (!r) continue; (M.sym.startsWith('TW') ? tw : rows).push(r); }
                const main = rows.filter(r => !HIGH_INF.has(r.sym));
                const cb = main.map(r => r.CB), nCB = main.filter(r => r.CB > 0).length, nCA = main.filter(r => r.C > r.A).length, nBA = main.filter(r => r.B > r.A).length, nPl = main.filter(r => r.beatPl).length;
                out.D[vk] = { rows: [...rows, ...tw], n: main.length, cbPos: nCB, caPos: nCA, baPos: nBA, plBeat: nPl, cbMed: r2(med(cb)), mddMed: { A: r2(med(main.map(r => r.mddA))), B: r2(med(main.map(r => r.mddB))), C: r2(med(main.map(r => r.mddC))) }, tw };
                log(`  ${vk}:${main.length} 國 ③ 贏 ② ${nCB} 國・③ 贏 ① ${nCA} 國・② 贏 ① ${nBA} 國 ・③−② 年化中位 ${r2(med(cb))}pp ・贏安慰劑第 90 百分位 ${nPl} 國 ・最多賠中位 ① ${out.D[vk].mddMed.A}% ② ${out.D[vk].mddMed.B}% ③ ${out.D[vk].mddMed.C}%`);
                for (const r of tw) log(`     ${r.sym}(${r.from}~${r.to}):① ${r.A}% ② ${r.B}% ③ ${r.C}% ④ ${r.D}%/年 ・最多賠 ${r.mddA} / ${r.mddB} / ${r.mddC} / ${r.mddD}% ・逐年 ③ 贏 ② ${r.yrCB} ・空頭天數 ${r.bear}% ・一年換 ${r.swPerYr} 次 ・安慰劑第 90 百分位 ${r.plP90}(${r.beatPl ? '贏' : '沒贏'})`);
                if (vk === 'ma20_60') { const top = [...main].sort((a, b) => b.CB - a.CB).slice(0, 5), bot = [...main].sort((a, b) => a.CB - b.CB).slice(0, 3); log(`     ③−② 最好:${top.map(r => `${r.sym} ${r.CB}`).join(' ・')}  最差:${bot.map(r => `${r.sym} ${r.CB}`).join(' ・')}`); }
            }
            const c = out.D.ma20_60, nbs = ['ma40_120', 'ma50_200'].map(k => out.D[k]);
            const twOk = c.tw.length === 2 && c.tw.every(r => r.CB > 0);
            out.D.gates = { mkts: c.cbPos >= 0.6 * c.n, med: c.cbMed > 0, placebo: c.plBeat >= 0.5 * c.n, tw: twOk, plateau: nbs.every(z => z.cbPos >= 0.6 * z.n && z.cbMed > 0) };
            log(`  D 關卡:${Object.entries(out.D.gates).map(([k, v]) => `${k} ${v ? '✅' : '⛔'}`).join(' ')}`);
        }

        // ── E ──
        if (PARTS.includes('E')) {
            out.E = {};
            log('\n━━ E 股市在高點、信用利差變大(高盛那種「股債背離」)━━');
            const S = W.s, spx = S['^GSPC'];
            const baa = W.fred && W.fred.BAA10Y, Xb = baa ? asofAlign(spx.d, baa.d, baa.c) : null;
            let Xr = null;
            if (S.HYG && S.IEF) { const m = new Map(S.IEF.d.map((d, i) => [d, S.IEF.c[i]])), d = [], v = []; S.HYG.d.forEach((dd, i) => { if (m.get(dd) > 0) { d.push(dd); v.push(S.HYG.c[i] / m.get(dd)); } }); Xr = spx.d.map((dd, i) => null); const mm = new Map(d.map((x, i) => [x, v[i]])); spx.d.forEach((dd, i) => { if (mm.has(dd)) Xr[i] = mm.get(dd); }); }
            const assets = { spx: ser(spx), ixic: ser(S['^IXIC']), twtr: { d: TW.d, v: TWtr.P } };
            const defs = [];
            if (Xb) { defs.push(['C1', 0, 0.95, Xb, 'BAA10Y 創一年新高']); for (const p of [PRE.CR.c2, ...PRE.CR.c2g]) defs.push(['C2', p, 0.95, Xb, `BAA10Y 60 天升 ≥${p}`]); }
            if (Xr) for (const p of [PRE.CR.c3, ...PRE.CR.c3g]) defs.push(['C3', p, 0.97, Xr, `高收益債 ÷ 公債 ≤ 60 日高 ×${p}`]);
            const ps = [];
            for (const [kind, par, nh, X, label] of defs) {
                const center = (kind === 'C1') || (kind === 'C2' && par === PRE.CR.c2) || (kind === 'C3' && par === PRE.CR.c3);
                const r = credEval(spx, X, kind, par, nh, assets, { sims: center ? 1000 : 0 });
                out.E[`${kind}_${par}`] = r;
                const a = r.spx[60] || {};
                log(`  ${label}(標普 ≥ 高點 ×${nh}):${a.n ?? 0} 次 ・標普 60 天 ${a.mean}% vs 對照 ${a.ctl}%(差 ${a.diff})・60 天內跌 ≥10% ${a.dd}% vs ${a.ddCtl}% ・前後 ${a.h1}/${a.h2} ・逐 10 年 ${a.dec} ・拿掉最差 ${a.noWorst}${r.placebo ? ` ・安慰劑 p ${r.placebo.p}(大跌比例 p ${r.placebo.pDD})` : ''}`);
                for (const nm of ['ixic', 'twtr']) { const z = r[nm][60]; if (z && z.n >= 3) log(`       ${nm === 'ixic' ? '那斯達克' : '加權含息'} 60 天 ${z.mean}% vs ${z.ctl}%(差 ${z.diff})・跌 ≥10% ${z.dd}% vs ${z.ddCtl}%`); }
                if (r.now) log(`       現在(${r.now.d}):${r.now.lit ? '🔔 亮著' : '沒亮'}(標普在高點附近 ${r.now.near ? '是' : '否'}・值 ${r2(r.now.x)})`);
                if (center && r.placebo) ps.push(r.placebo.p);
                if (center) out.E[`${kind}_${par}`].gates = { worse: a.diff < 0 && a.dd > a.ddCtl, halves: a.h1 < 0 && a.h2 < 0, dec: a.decShare >= 0.6, noWorst: a.noWorst < 0, placebo: r.placebo && r.placebo.p <= 0.10 };
            }
            out.E.bh = bh(ps);
            for (const k of Object.keys(out.E)) if (out.E[k] && out.E[k].gates) log(`  ${k} 關卡:${Object.entries(out.E[k].gates).map(([g, v]) => `${g} ${v ? '✅' : '⛔'}`).join(' ')}(高原看格子那幾行)`);
        }
    }
    if (PARTS.includes('F')) out.F = await runF(env, log);
    return out;
}

// ═════════ selftest ═════════
function mkDates(n, start = '2000-01-03') { const d = []; let t = Date.parse(start + 'T00:00:00Z'); while (d.length < n) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) d.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; } return d; }
function walk(n, seed, mu = 0.0003, sd = 0.01, hook) { const R = rng(seed), c = [100]; for (let i = 1; i < n; i++) { const z = Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R()); let r = mu + sd * z; if (hook) r = hook(i, r, c); c.push(c[i - 1] * (1 + r)); } return c; }
function selftest() {
    let fail = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fail++; };
    // ① 合成 L 倍跟 synth2x 逐位相同
    { const P = walk(800, 1); const a = synthL(P, 0, 2, -(0.015 + 0.01)), b = synth2x(P, 0, 0.015, 0.01); ok(a.every((v, i) => v === b[i]), '① synthL(L=2, carry=−(現金+費用)) 跟 crash_playbook_probe.synth2x 逐位相同'); }
    // ② 每天重設的損耗:指數 +10% / −9.0909% 來回 → 指數不動,反一變少
    { const P = [100]; for (let i = 1; i <= 100; i++) P.push(i % 2 ? P[i - 1] * 1.1 : P[i - 1] / 1.1); const N = synthL(P, 0, -1, 0);
      ok(Math.abs(P[100] / P[0] - 1) < 1e-9 && N[100] < 0.45 && N[100] > 0.35, `② 指數來回 50 次不動 → 反一剩 ${N[100].toFixed(3)}(每來回 ×0.9818,每天重設的損耗)`); }
    // ③ 前視:事件只用到當天;隔天收盤進(注入 peek = 前一天收盤進,必紅)
    { const c = walk(3000, 3, 0, 0.02), d = mkDates(3000);
      const ev = dropPct(c, 3), c2 = c.slice(); for (let i = 1500; i < 3000; i++) c2[i] *= 1.3;   // 改後半段
      ok(dropPct(c2, 3).filter(t => t < 1500).join() === ev.filter(t => t < 1500).join(), '③a 改第 1500 天以後的價格 → 之前的大跌日一個都不變');
      const M = { sym: 'X', d, c: Float64Array.from(c), P: c, corr: new Int32Array(3000).fill(0) };
      const s = evalEvents([M], m => dropPct(m.c, 3), 20, { exclude: new Set(), sims: 0 });
      ok(s.n > 30 && Math.abs(s.mean + RT * 100 + 1 * 20 / 252) < 1.6, `③b 隨機漫步:大跌之後放空 20 天 ≈ 只扣成本(${s.mean}%,n ${s.n})—— 注入 SI_INJECT=peek(前一天收盤進)這條必紅`); }
    // ④ 埋效果:大跌後 20 天每天 −0.5% → 放空賺;沒埋 → 不賺
    { const d = mkDates(4000); let left = 0;
      const c = walk(4000, 4, 0.0004, 0.012, (i, r) => { if (left > 0) { left--; return r - 0.005; } if (r <= -0.03) left = 20; return r; });
      const c0 = walk(4000, 4, 0.0004, 0.012);
      const mk = cc => { const M = prepMarket('T', d, Float64Array.from(cc)); M.P = M.c; return M; };
      const a = evalEvents([mk(c)], M => dropPct(M.c, 3), 20, { exclude: new Set(), sims: 200 }), b = evalEvents([mk(c0)], M => dropPct(M.c, 3), 20, { exclude: new Set(), sims: 200 });
      ok(a.mean > 5 && gatesB(a).pos && a.ex > 0, `④a 埋「大跌後 20 天每天 −0.5%」→ 放空 ${a.mean}%(比修正中隨便一天 ${a.ex})`);
      ok(!(b.mean > 2), `④b 沒埋 → 放空 ${b.mean}%(不會賺)`); }
    // ⑤ 星期五:埋「星期五跌 ≥2% → 下一個交易日 −1%」抓得到;沒埋打亂星期幾 p 大
    { const d = mkDates(6000); const mk = (hook, sd) => { const c = walk(6000, sd, 0.0003, 0.012, hook); const M = prepMarket('W' + sd, d, Float64Array.from(c)); M.P = M.c; return M; };
      const plant = (i, r, c) => (i >= 2 && wdOf(d[i - 1]) === 5 && c[i - 1] / c[i - 2] - 1 <= -0.02 ? r - 0.01 : r);
      const A = [5, 6, 7].map(s => mk(plant, s)), B = [5, 6, 7].map(s => mk(null, s));
      const a = friEval(A, 2, { sims: 500 }), b = friEval(B, 2, { sims: 500 });
      ok(a.diff < -0.6 && a.pPerm <= 0.05, `⑤a 埋了:星期五大跌下一天差 ${a.diff}(p ${a.pPerm})`);
      ok(b.pPerm > 0.05, `⑤b 沒埋:差 ${b.diff}(p ${b.pPerm})`);
      ok(wdOf('2026-11-06') === 5 && mondayOf('2026-11-06') === '2026-11-02' && mondayOf('2026-11-02') === '2026-11-02', '⑤c 星期幾用 UTC:2026-11-06 是星期五、那週星期一 11/02'); }
    // ⑥ 空頭抱反一:空頭真的會跌 → ③ > ② > ①;空頭狀態打亂 → ③ 不會贏 ②
    { const d = mkDates(5000); const st = new Array(5000).fill(null); for (let i = 60; i < 5000; i++) st[i] = Math.floor(i / 250) % 3 === 0;
      const c = walk(5000, 9, 0.0005, 0.01, (i, r) => (i >= 2 && st[i - 2] ? r - 0.003 : r));
      const r = regimeRun(d, c, st, 0);
      ok(r.cagr.C > r.cagr.B && r.cagr.B > r.cagr.A, `⑥a 空頭每天 −0.3% → ① ${pct(r.cagr.A)} ② ${pct(r.cagr.B)} ③ ${pct(r.cagr.C)}%/年`);
      const c0 = walk(5000, 9, 0.0005, 0.01), r0 = regimeRun(d, c0, st, 0);
      ok(r0.cagr.C < r0.cagr.B + 0.01, `⑥b 空頭不會跌 → ③ ${pct(r0.cagr.C)} 沒有贏 ② ${pct(r0.cagr.B)}`);
      const sh = shiftState(st, 100); ok(sh.length === st.length && sh.filter(Boolean).length === st.filter(Boolean).length && sh[60] === st[160], '⑥c 循環平移:長度、空頭天數不變'); }
    // ⑦ 股債背離:埋「利差升 → 60 天後跌」抓得到;沒埋安慰劑 p 大
    { const n = 7000, d = mkDates(n); const X = new Array(n).fill(null); let x = 2; const R = rng(77); const hits = new Set();
      for (let i = 0; i < n; i++) { x += (R() - 0.5) * 0.02; if (i % 500 === 300) { x += 1.0; hits.add(i); } X[i] = x; }
      const c = walk(n, 11, 0.0004, 0.008, (i, r) => ([...hits].some(h => i > h + 2 && i <= h + 40) ? r - 0.004 : r));
      const spx = { d, c }, A = { spx: { d, v: c } };
      const a = credEval(spx, X, 'C2', 0.5, 0.95, A, { sims: 200 }), z = a.spx[60];
      ok(z.n >= 3 && z.diff < -3 && a.placebo && a.placebo.p <= 0.10, `⑦a 埋了:利差 60 天升 ≥0.5 之後 60 天 ${z.mean}% vs ${z.ctl}%(p ${a.placebo && a.placebo.p},n ${z.n})`);
      const c0 = walk(n, 11, 0.0004, 0.008), b = credEval({ d, c: c0 }, X, 'C2', 0.5, 0.95, { spx: { d, v: c0 } }, { sims: 200 });
      ok(!b.placebo || b.placebo.p > 0.10 || b.spx[60].diff > -1, `⑦b 沒埋:差 ${b.spx[60].diff}(p ${b.placebo && b.placebo.p})`);
      ok(asofAlign(['2020-01-02', '2020-01-03'], ['2020-01-02', '2020-01-06'], [1, 2]).join() === '1,1', '⑦c 對齊只用當天以前的值(⛔ 拿到之後的)'); }
    // ⑧ 放空個股:進 100 出 90 → +10% − 成本;平盤以下空不到;開在跌停空不到
    { const cal = mkDates(10, '2020-01-02'), S = { O: Float64Array.from([0, 100, 0, 0, 0, 0, 0, 0, 0, 0]), C: Float64Array.from([100, 95, 92, 90, 0, 0, 0, 0, 0, 0]), F: new Float64Array(10).fill(1), jump: new Int32Array(10).fill(-1) };
      const ctx = { cal };
      ok(Math.abs(shortOf(ctx, S, 0, 3, 'uptick') - (0.10 - SHORT_COST)) < 1e-12, `⑧a 開盤 100 融券、第 3 天收 90 回補 → +10% − ${pct(SHORT_COST)}%`);
      const S2 = { ...S, O: Float64Array.from([0, 99, 0, 0, 0, 0, 0, 0, 0, 0]) }, S3 = { ...S, O: Float64Array.from([0, 90, 0, 0, 0, 0, 0, 0, 0, 0]) };
      ok(shortOf(ctx, S2, 0, 3, 'uptick') === 'noshort' && typeof shortOf(ctx, S2, 0, 3, 'free') === 'number', '⑧b 開盤 99 < 前一天收盤 100:平盤以下空不到、不管限制那版空得到');
      ok(shortOf(ctx, S3, 0, 3, 'free') === 'lock', '⑧c 開在跌停(2020 年 −10%)→ 兩版都空不到'); }
    // ⑨ 中心事件定義 == crash_events.legsWithEvents
    { const c = walk(6000, 13, 0.0003, 0.015), d = mkDates(6000), a = appEvents(c, d);
      ok(a.leg10.length > 3 && a.leg10.join() === legStarts(c, 10).join() && a.fast15.join() === fastFirst(c, 15, 25).join() && a.bear20.join() === ddFirst(c, 20).join(), `⑨ 段首 ${a.leg10.length} / 急跌 15% ${a.fast15.length} / 跌 20% ${a.bear20.length} 次:跟 App 大跌通知同一份定義`); }
    // ⑩ 校正:用 carry −3% 合成的「真反一」→ 解得回 −3%
    { const d = mkDates(900, '2023-06-01'), tr = walk(900, 17, 0.0006, 0.01), inv = synthL(tr, 0, -1, -0.03).map((v, i) => ({ d: d[i], c: 30 * v }));
      const k = calibrate(inv, { d, v: tr }); ok(k && Math.abs(k.carryFit + 3) < 0.05 && k.corr > 0.999, `⑩ 用 −3%/年合成的反一 → 解出 carry ${k && k.carryFit}%/年(相關 ${k && k.corr})`); }
    console.log(fail ? `❌ ${fail} 條沒過` : '✅ 全部通過');
    return fail ? 1 : 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    run(process.env).then(out => { if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); }).catch(e => { console.error('❌', e); process.exit(1); });
}
