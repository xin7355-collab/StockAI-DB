#!/usr/bin/env node
/**
 * 🧪 rebound_lab_probe.mjs —— 大跌「何時搶反彈 / 何時開始進場」自創招式 + 各國樣本外(V82.0.1,計畫 B2)
 *
 * 使用者 11/06:「如果已知的方法都無效,就請你自創招式找出方法…需要比對別的國家要挖礦就挖礦」。
 * 已測過、⛔ 不重測(約 40 種,見 LAB crash-* / stopfall-signs / ftd 等):跌幅門檻、急跌、整數關卡、乖離、連跌、破底翻、
 *   追盤日、跌家比、90% 日、Zweig、跌停家數固定門檻、地板股、McClellan、VIX、融資、外資、P/C、散戶多空比、國安基金、反攻雷達…
 *
 * ⛔⛔ 事先登記(2026-11-06 寫死,跑完 ⛔ 改中心參數;左右一格只拿來看高原):
 *   修正段 = lib_crash.corrLegs(近 250 天最高收盤跌 ≥10% 起算、收盤回到高點 5% 以內結束);另跑「固定高點」(歷史最高)版當穩健度。
 *   短(搶反彈)S1:單日報酬 ≤ −2.5 × σ(前 250 天日報酬標準差,只用到前一天)→ 隔天收盤買指數、抱 20 天。(格:2.25 / 2.75)
 *   長(開始進場)—— 每一段只算第一次,全部只用當天(含)以前看得到的:
 *     L1 🌡️ 退燒:20 日波動 ≤ 這一段到今天最高 20 日波動 × 0.7,且最高那天已過 ≥10 天(格:0.6 / 0.8)
 *        安慰劑 L1p:這一段最大單日跌那天之後第 20 天(只看時間,不看波動)
 *     L2 🧱 守底:這一段到今天的最低收盤已經 15 個交易日沒破(格:10 / 20)
 *     L3 🪃 彈離:收盤 ≥ 這一段到今天最低收盤 × 1.10(格:1.07 / 1.13)
 *     L4 📉 新低變少(台股、D16 給了才算):創 250 日新低的家數 ≤ 這一段最多那天的一半,且最多那天已過 ≥5 天(格:0.35 / 0.65)
 *     L5 🌏 全球回暖:全部市場裡「離自己 250 日最低 ≥10%」的比例,這一段曾 <30%、前一個日曆日 >60%(格:25→55 / 35→65)
 *     L6 🇺🇸 美股先站穩:標普 500(前一個美股交易日)已經 15 天沒創 120 日新低(格:10 / 20)
 *     L7 💳 信用退燒:HYG ÷ IEF(前一個美股交易日)≥ 60 日最低 × 1.03 而且 > 20 日均線(格:1.02 / 1.04)
 *     L8 🟩 跌停潮退(台股、BREADTH16 給了才算):跌停家數 ≤ 這一段最多那天的 20%,且最多那天已過 ≥5 天(格:0.1 / 0.3)
 *   進場:訊號隔天收盤(⛔ 當天收盤 = 前視)。
 *   ⭐ 主判準(資金版):每一段開始那天手上有一筆錢 →
 *     ①馬上買(段首隔天收盤)②等訊號(訊號隔天收盤;這一段走完都沒等到 → 回到離高點 5% 內那天的隔天收盤買)
 *     ③12 個月平均(段首隔天起每 21 天買 1/12);H = 段首隔天起 500 個交易日比總資產(log 比)。
 *     每次買扣 0.1%;⛔ 現金利息算 0(⚠️ 價格指數沒算股息 = 對「等」有利的偏差,兩個方向的偏差要一起講)。
 *   對照 / 安慰劑:
 *     事件研究 —— 訊號隔天收盤買,20 / 60 / 120 / 250 天 vs 同一市場「修正中隨便一天」(隔天收盤買、同樣天數)。
 *     資金版 —— 把「等了幾天」打亂配給別段(保留等待天數的分布)200 次;贏安慰劑 = 真的資訊,不是「晚一點買」本身。
 *   判準:六關 = ①全部平均 > 0 ②前後半(照段首日期)同向 ③有 ≥2 段的市場六成以上同向 ④拿掉最好那一個危機群還 > 0
 *     ⑤扣成本(已含)⑥贏安慰劑(p ≤ 0.10);+ 高原(左右一格同向)+ 全部方法一起 BH(q ≤ 0.10)。
 *   危機群:段首日期照順序,跟群裡第一段相隔 ≤ 90 天的算同一群(2008 / 2020 各國同時崩 ⛔ 被算成 30 次獨立樣本);
 *     t 值用「每一群的平均」算。
 *   ⛔ 高通膨市場(^MERV、XU100.IS)不進主判準(名目價格 + 現金 0 利率 → 對「等」不公平),另外列。
 *   資料怪癖:Yahoo 指數成交量不能用(量類只做台股);單日 |報酬| > 50% 當成資料斷點接起來(土耳其 2020 除以 100 那種),25~50% 照收。
 *
 * 跑法:
 *   WORLD=<world_hist.json.gz> IDX_LONG=… IDX_EARLY=… TWII_NOW=… [D16=<d16 目錄>] [BREADTH16=<breadth16.json>] \
 *     node scripts/rebound_lab_probe.mjs out.json
 *   node scripts/rebound_lab_probe.mjs --selftest
 */
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { corrLegs, loadIndex, mean, med, r2, rng, bh } from './lib_crash.mjs';
import { loadPx } from './lib_totalreturn.mjs';

export const H = 500, COST = 0.001, TRANCHES = 12, STEP = 21, PLACEBO = 200, SEED = 11;
export const HIGH_INF = new Set(['^MERV', 'XU100.IS']);
export const HS = [20, 60, 120, 250];
export const PRE = {
    S1: { k: 2.5, grid: [2.25, 2.75] },
    L1: { k: 0.7, grid: [0.6, 0.8], wait: 10 },
    L2: { k: 15, grid: [10, 20] },
    L3: { k: 1.10, grid: [1.07, 1.13] },
    L4: { k: 0.5, grid: [0.35, 0.65], wait: 5 },
    L5: { k: [0.30, 0.60], grid: [[0.25, 0.55], [0.35, 0.65]] },
    L6: { k: 15, grid: [10, 20], win: 120 },
    L7: { k: 1.03, grid: [1.02, 1.04] },
    L8: { k: 0.2, grid: [0.1, 0.3], wait: 5 },
};
export const NAMES = { S1: '⚡ 單日跌 ≥2.5σ(搶反彈)', L1: '🌡️ 退燒', L1p: '🌡️ 安慰劑(最大跌後第 20 天)', L2: '🧱 守底', L3: '🪃 彈離',
    L4: '📉 新低變少', L5: '🌏 全球回暖', L6: '🇺🇸 美股先站穩', L7: '💳 信用退燒', L8: '🟩 跌停潮退' };

// ───────── 基本序列 ─────────
/** 日報酬(log);第 0 天 NaN */
export function logRet(c) { const r = new Float64Array(c.length).fill(NaN); for (let i = 1; i < c.length; i++) r[i] = Math.log(c[i] / c[i - 1]); return r; }
/** σ_t = 第 t−W ~ t−1 天日報酬標準差(⛔ 含當天);不足 W/2 天 → NaN */
export function sigmaPrev(r, W = 250) {
    const n = r.length, out = new Float64Array(n).fill(NaN);
    let s = 0, s2 = 0, k = 0;
    for (let t = 1; t < n; t++) {
        // 視窗 = [t−W, t−1]
        const add = r[t - 1];
        if (Number.isFinite(add)) { s += add; s2 += add * add; k++; }
        const drop = t - 1 - W;
        if (drop >= 1 && Number.isFinite(r[drop])) { s -= r[drop]; s2 -= r[drop] * r[drop]; k--; }
        if (k >= W / 2) out[t] = Math.sqrt(Math.max(0, (s2 - s * s / k) / (k - 1)));
    }
    return out;
}
/** 20 日波動(含當天,t−19..t) */
export function vol20(r) {
    const n = r.length, out = new Float64Array(n).fill(NaN);
    for (let t = 20; t < n; t++) { let s = 0, s2 = 0; for (let k = t - 19; k <= t; k++) { s += r[k]; s2 += r[k] * r[k]; } out[t] = Math.sqrt(Math.max(0, (s2 - s * s / 20) / 19)); }
    return out;
}
/** 單日漲 >50% 或跌 >50% 當成資料斷點(土耳其 2020 除以 100 那種):把斷點之前全部乘一個倍數接起來 = 那天報酬算 0 */
export function spliceBreaks(c) {
    const out = Float64Array.from(c); let breaks = 0;
    for (let i = out.length - 1; i >= 1; i--) {
        const x = out[i] / out[i - 1];
        if (x > 1.5 || x < 0.5) { const f = x; for (let k = 0; k < i; k++) out[k] *= f; breaks++; }   // 單日漲 >50% 或跌 >50%
    }
    return { c: out, breaks };
}

// ───────── 訊號(每一段只算第一次;全部只用到當天)─────────
/** 段 L(s..e)裡第一個讓 pred(t) 成立的 t;沒有 → −1 */
const firstIn = (L, pred) => { for (let t = L.s; t <= L.e; t++) if (pred(t)) return t; return -1; };

export function sigS1(M, k = 2.5) {
    const ev = [];
    for (let t = 1; t < M.c.length; t++) if (M.corr[t] >= 0 && Number.isFinite(M.sig[t]) && M.r[t] <= -k * M.sig[t]) ev.push(t);
    return ev;
}
export function sigL1(M, L, k = 0.7, wait = 10) {
    let mx = -1, mxI = -1;
    return firstIn(L, t => { const v = M.v20[t]; if (!Number.isFinite(v)) return false; if (v > mx) { mx = v; mxI = t; } return t - mxI >= wait && v <= k * mx; });
}
export function sigL1p(M, L, n = 20) {
    let mn = Infinity, mnI = -1;
    return firstIn(L, t => { if (M.r[t] < mn) { mn = M.r[t]; mnI = t; } return mnI >= 0 && t - mnI >= n; });
}
export function sigL2(M, L, k = 15) {
    let lo = Infinity, loI = -1;
    return firstIn(L, t => { if (M.c[t] < lo) { lo = M.c[t]; loI = t; } return t - loI >= k; });
}
export function sigL3(M, L, k = 1.10) {
    let lo = Infinity;
    return firstIn(L, t => { if (M.c[t] < lo) lo = M.c[t]; return M.c[t] >= lo * k; });
}
/** 外部每日序列 X(對齊 M 的日子,⛔ 已經是「當天以前看得到的」)的「峰值消退」:X ≤ 峰 × k 且峰已過 ≥ wait 天 */
export function sigFade(X, L, k, wait) {
    if (!X) return -1;                                    // 這個市場沒有這份序列(台股以外)
    let mx = -1, mxI = -1;
    return firstIn(L, t => { const v = X[t]; if (v == null || !(v >= 0)) return false; if (v > mx) { mx = v; mxI = t; } return mx > 0 && t - mxI >= wait && v <= k * mx; });   // ⚠️ null >= 0 在 JS 是 true → 先擋 null
}
/** 全球回暖:G[t] = 前一個日曆日的回暖比例;這一段曾 < lo、今天 > hi */
export function sigL5(G, L, lo = 0.30, hi = 0.60) {
    let seenLo = false;
    return firstIn(L, t => { const g = G[t]; if (!(g >= 0)) return false; if (g < lo) seenLo = true; return seenLo && g > hi; });
}
/** 布林序列(對齊 M 的日子)在段內第一次為真 */
export function sigBool(B, L) { return firstIn(L, t => !!B[t]); }

// ───────── 市場準備 ─────────
export function prepMarket(sym, d, c0, W = 250) {
    const { c, breaks } = spliceBreaks(c0);
    const r = logRet(c), sig = sigmaPrev(r, W), v20 = vol20(r);
    const CL = corrLegs(Array.from(c), W, 10, 5);
    const CLf = corrLegs(Array.from(c), c.length + 1, 10, 5);
    return { sym, d, c, r, sig, v20, corr: CL.corr, legs: CL.legs, legsF: CLf.legs, corrF: CLf.corr, breaks };
}

// ───────── 資金版 ─────────
/** 一段:①馬上買 ②等訊號(t;−1 = 沒等到 → 段尾隔天)③12 個月平均。回 {imm, sig, dca}(總資產倍數)或 null(不夠 H 天 / 還沒走完) */
export function moneyLeg(M, L, t) {
    const n = M.c.length, b0 = L.s + 1, T = b0 + H;
    if (T >= n || L.open) return null;
    const v = b => (b <= T ? (1 - COST) * M.c[T] / M.c[b] : 1);
    const imm = v(b0);
    const bs = t >= 0 ? t + 1 : L.e + 2;
    const sig = bs <= T ? v(bs) : 1;
    let dca = 0; for (let k = 0; k < TRANCHES; k++) dca += v(b0 + k * STEP) / TRANCHES;
    return { imm, sig, dca, wait: bs - b0 };
}

/** 危機群:照段首日期排,跟群裡第一段相隔 ≤ gap 天(日曆日)= 同一群 */
export function clusters(dates, gap = 90) {
    const ix = dates.map((d, i) => [Date.parse(d), i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(dates.length); let cid = -1, first = -Infinity;
    for (const [ms, i] of ix) { if (ms - first > gap * 864e5) { cid++; first = ms; } out[i] = cid; }
    return out;
}
/** 群穩健:每群平均 → t;拿掉最好那一群 */
export function clusterStats(xs, cl) {
    const by = new Map(); xs.forEach((x, i) => { if (!by.has(cl[i])) by.set(cl[i], []); by.get(cl[i]).push(x); });
    const cm = [...by.values()].map(a => mean(a));
    const k = cm.length, m = mean(cm);
    const sd = k > 1 ? Math.sqrt(cm.reduce((s, x) => s + (x - m) ** 2, 0) / (k - 1)) : NaN;
    let best = -Infinity, bestK = null; for (const [key, a] of by) { const mm = mean(a); if (mm > best) { best = mm; bestK = key; } }
    const rest = xs.filter((_, i) => cl[i] !== bestK);
    return { k, mean: m, t: k > 1 && sd > 0 ? m / (sd / Math.sqrt(k)) : null, noBest: rest.length ? mean(rest) : null };
}

/** 一個方法 × 參數 在全部市場的資金版:每段 log(sig/imm)、log(sig/dca);安慰劑 = 把等待天數打亂配給別段 */
export function moneyEval(markets, sigFn, { legsKey = 'legs', exclude = HIGH_INF, seed = SEED } = {}) {
    const rows = [];
    for (const M of markets) {
        if (exclude.has(M.sym)) continue;
        for (const L of M[legsKey]) {
            if (L.open) continue;
            const t = sigFn(M, L);
            const m = moneyLeg(M, L, t);
            if (!m) continue;
            rows.push({ sym: M.sym, d: M.d[L.s], M, L, t, ...m, x: Math.log(m.sig / m.imm), xd: Math.log(m.sig / m.dca), xdi: Math.log(m.dca / m.imm) });
        }
    }
    if (!rows.length) return { n: 0 };
    const cl = clusters(rows.map(r => r.d));
    const xs = rows.map(r => r.x), xd = rows.map(r => r.xd);
    const half = [...rows].sort((a, b) => a.d < b.d ? -1 : 1), h = half.length >> 1;
    const h1 = mean(half.slice(0, h).map(r => r.x)), h2 = mean(half.slice(h).map(r => r.x));
    const bySym = new Map(); for (const r of rows) { if (!bySym.has(r.sym)) bySym.set(r.sym, []); bySym.get(r.sym).push(r.x); }
    const mk = [...bySym.values()].filter(a => a.length >= 2), mkPos = mk.filter(a => mean(a) > 0).length;
    // 安慰劑:等待天數(相對段首)打亂
    const R = rng(seed), waits = rows.map(r => r.t >= 0 ? r.t - r.L.s : -1), sims = [];
    for (let s = 0; s < PLACEBO; s++) {
        const p = waits.slice(); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
        let sum = 0; rows.forEach((r, i) => { const w = p[i]; const t2 = w >= 0 && r.L.s + w <= r.L.e ? r.L.s + w : -1; const m = moneyLeg(r.M, r.L, t2); sum += Math.log(m.sig / m.imm); });
        sims.push(sum / rows.length);
    }
    const mx = mean(xs), cs = clusterStats(xs, cl);
    const pPl = sims.filter(v => v >= mx).length / sims.length;
    const fired = rows.filter(r => r.t >= 0).length;
    return {
        n: rows.length, fired, mkts: bySym.size, clusters: cs.k,
        x: r2(mx * 100), xMed: r2(med(xs) * 100), win: r2(xs.filter(v => v > 0).length / xs.length * 100),
        xd: r2(mean(xd) * 100), dcaVsImm: r2(mean(rows.map(r => r.xdi)) * 100),
        t: cs.t == null ? null : +cs.t.toFixed(2), noBest: r2(cs.noBest * 100), h1: r2(h1 * 100), h2: r2(h2 * 100),
        mkPos: `${mkPos}/${mk.length}`, mkShare: mk.length ? mkPos / mk.length : null,
        plMed: r2(med(sims) * 100), pPl: +pPl.toFixed(3), waitMed: med(rows.map(r => r.wait)),
        gates: { all: mx > 0, halves: h1 > 0 && h2 > 0, mkts: mk.length ? mkPos / mk.length >= 0.6 : false, noBest: cs.noBest > 0, cost: true, placebo: pPl <= 0.10 },
    };
}

/** 事件研究:事件(訊號隔天收盤買)h 天 vs 同一市場修正中隨便一天(隔天收盤買)h 天;回每 h 的平均超額、群 t、p(抽樣) */
export function eventEval(markets, evFn, { exclude = HIGH_INF, seed = SEED, sims = 1000 } = {}) {
    const out = {};
    const ctl = new Map();
    for (const M of markets) {
        if (exclude.has(M.sym)) continue;
        const pool = []; for (let i = 0; i < M.c.length; i++) if (M.corr[i] >= 0) pool.push(i);
        ctl.set(M.sym, pool);
    }
    for (const h of HS) {
        const rows = [];
        for (const M of markets) {
            if (exclude.has(M.sym)) continue;
            const pool = ctl.get(M.sym), n = M.c.length;
            const f = i => (i + 1 + h < n ? Math.log(M.c[i + 1 + h] / M.c[i + 1]) - 2 * COST : null);
            const base = pool.map(f).filter(v => v != null);
            if (base.length < 50) continue;
            const bm = mean(base);
            for (const i of evFn(M)) { const v = f(i); if (v != null) rows.push({ sym: M.sym, d: M.d[i], x: v - bm, raw: v, base, i }); }
        }
        if (rows.length < 5) { out[h] = { n: rows.length }; continue; }
        const xs = rows.map(r => r.x), cl = clusters(rows.map(r => r.d)), cs = clusterStats(xs, cl);
        const half = [...rows].sort((a, b) => a.d < b.d ? -1 : 1), k = half.length >> 1;
        // 抽樣 p:每個事件從它自己市場的修正日子抽一個,平均 ≥ 事件平均的比例
        const R = rng(seed + h), em = mean(rows.map(r => r.raw)); let ge = 0;
        for (let s = 0; s < sims; s++) { let sum = 0; for (const r of rows) sum += r.base[Math.floor(R() * r.base.length)]; if (sum / rows.length >= em) ge++; }
        const bySym = new Map(); for (const r of rows) { if (!bySym.has(r.sym)) bySym.set(r.sym, []); bySym.get(r.sym).push(r.x); }
        const mk = [...bySym.values()].filter(a => a.length >= 2);
        out[h] = { n: rows.length, mkts: bySym.size, clusters: cs.k, x: r2(mean(xs) * 100), t: cs.t == null ? null : +cs.t.toFixed(2), noBest: r2(cs.noBest * 100),
            h1: r2(mean(half.slice(0, k).map(r => r.x)) * 100), h2: r2(mean(half.slice(k).map(r => r.x)) * 100),
            mkPos: `${mk.filter(a => mean(a) > 0).length}/${mk.length}`, p: +(ge / sims).toFixed(3) };
    }
    return out;
}

// ───────── 外部序列 ─────────
/** 對齊到 M 的日子:每天取「日期 < M 那天」的最後一個值(⛔ 同一天 = 前視;美股收盤比亞洲晚) */
export function lagAlign(dates, srcD, srcV) {
    const out = new Array(dates.length).fill(null); let j = -1;
    for (let i = 0; i < dates.length; i++) { while (j + 1 < srcD.length && srcD[j + 1] < dates[i]) j++; out[i] = j >= 0 ? srcV[j] : null; }
    return out;
}
/** 同一天對齊(台股自己的廣度:收盤後就知道,當天收盤買不行,但訊號當天 + 隔天收盤買 OK) */
export function sameAlign(dates, srcD, srcV) { const m = new Map(srcD.map((d, i) => [d, srcV[i]])); return dates.map(d => (m.has(d) ? m.get(d) : null)); }

/** 美股站穩:收盤 k 天沒創 win 日新低(k 天前那個最低還是最低) */
export function usStable(c, k = 15, win = 120) {
    const n = c.length, out = new Array(n).fill(false);
    for (let t = win; t < n; t++) { let lo = Infinity, loI = -1; for (let j = t - win + 1; j <= t; j++) if (c[j] <= lo) { lo = c[j]; loI = j; } out[t] = t - loI >= k; }
    return out;
}
/** 信用退燒:比值 ≥ 60 日最低 × k 而且 > 20 日均線 */
export function creditCool(ratio, k = 1.03) {
    const n = ratio.length, out = new Array(n).fill(false);
    for (let t = 60; t < n; t++) { let lo = Infinity, s = 0; for (let j = t - 59; j <= t; j++) lo = Math.min(lo, ratio[j]); for (let j = t - 19; j <= t; j++) s += ratio[j]; out[t] = ratio[t] >= lo * k && ratio[t] > s / 20; }
    return out;
}
/** 全球回暖比例:每個日曆日,每個市場取「日期 ≤ D」最後一筆(10 天內),看離自己 250 日最低 ≥ 10%;回 {dates, share} */
export function globalShare(markets, minAlive = 15) {
    const all = [...new Set(markets.flatMap(M => M.d))].sort();
    const ptr = markets.map(() => -1), share = [];
    const lowRec = markets.map(M => { const n = M.c.length, rec = new Array(n).fill(null); for (let t = 249; t < n; t++) { let lo = Infinity; for (let j = t - 249; j <= t; j++) lo = Math.min(lo, M.c[j]); rec[t] = M.c[t] >= lo * 1.10; } return rec; });
    for (const D of all) {
        let alive = 0, rec = 0; const dm = Date.parse(D);
        markets.forEach((M, k) => { while (ptr[k] + 1 < M.d.length && M.d[ptr[k] + 1] <= D) ptr[k]++; const j = ptr[k]; if (j < 249) return; if (dm - Date.parse(M.d[j]) > 10 * 864e5) return; alive++; if (lowRec[k][j]) rec++; });
        share.push(alive >= minAlive ? rec / alive : null);
    }
    return { dates: all, share };
}

// ───────── 台股廣度(D16 / BREADTH16)─────────
/** 創 250 日新低家數比例(收盤 ≤ 前 249 天最低):讀 D16 每一檔;回 Map(date → 比例) */
export function newLowShare(dir) {
    const files = fs.readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f));
    const cnt = new Map(), tot = new Map();
    for (const f of files) {
        const px = loadPx(dir, f.replace('.json', '')); if (!px || px.length < 260) continue;
        const c = px.map(x => x.c);
        for (let t = 249; t < c.length; t++) {
            let lo = Infinity; for (let j = t - 249; j < t; j++) lo = Math.min(lo, c[j]);
            const d = px[t].d; tot.set(d, (tot.get(d) || 0) + 1); if (c[t] <= lo) cnt.set(d, (cnt.get(d) || 0) + 1);
        }
    }
    const out = new Map(); for (const [d, n] of tot) if (n >= 300) out.set(d, (cnt.get(d) || 0) / n);
    return out;
}

/** 只留段首那天 X 有值的段(台股廣度只有 2010 起);corr / corrF 照留下來的段重建(事件研究的對照池也只剩那段期間) */
export function restrictTo(M, X) {
    const keep = legs => legs.filter(L => X[L.s] != null);
    const rebuild = legs => { const c = new Int32Array(M.c.length).fill(-1); legs.forEach((L, k) => { for (let i = L.s; i <= L.e; i++) c[i] = k; }); return c; };
    const legs = keep(M.legs), legsF = keep(M.legsF);
    return { ...M, legs, legsF, corr: rebuild(legs), corrF: rebuild(legsF) };
}

// ───────── 主程式 ─────────
export function loadWorld(p) {
    const raw = fs.readFileSync(p); const j = JSON.parse((p.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
    return j;
}

export function run(env = process.env, log = console.log) {
    const W = loadWorld(env.WORLD);
    const S = W.s || {};
    const BONDS = new Set(['HYG', 'JNK', 'LQD', 'IEF', 'TLT', 'SHY']);
    const markets = [];
    for (const [sym, x] of Object.entries(S)) {
        if (BONDS.has(sym) || sym === '^VIX' || sym === '^TWII') continue;
        if (!x.d || x.d.length < 1000) continue;
        markets.push(prepMarket(sym, x.d, x.c));
    }
    // 台股用官方(2000 起;Yahoo ^TWII 不重複算)
    let TW = null;
    if (env.IDX_LONG) { const I = loadIndex(env); TW = prepMarket('TW', I.d, Float64Array.from(I.c)); markets.push(TW); }
    log(`📂 ${markets.length} 個市場:${markets.map(M => `${M.sym}(${M.d[0].slice(0, 4)}~${M.legs.length}段${M.breaks ? `・斷點${M.breaks}` : ''})`).join(' ')}`);
    // 外部:美股站穩 / 信用 / 全球回暖
    const spx = S['^GSPC'];
    const G = globalShare(markets.filter(M => M.sym !== 'TW'));
    const credit = S.HYG && S.IEF ? (() => { const m = new Map(S.IEF.d.map((d, i) => [d, S.IEF.c[i]])); const d = [], v = []; S.HYG.d.forEach((dd, i) => { if (m.has(dd)) { d.push(dd); v.push(S.HYG.c[i] / m.get(dd)); } }); return { d, v }; })() : null;
    const ext = M => {
        if (M._ext) return M._ext;
        const e = {};
        e.G = lagAlign(M.d, G.dates, G.share);
        if (spx) { e.us = {}; for (const k of [PRE.L6.k, ...PRE.L6.grid]) e.us[k] = lagAlign(M.d, spx.d, usStable(spx.c, k, PRE.L6.win)); }
        if (credit) { e.cr = {}; for (const k of [PRE.L7.k, ...PRE.L7.grid]) e.cr[k] = lagAlign(M.d, credit.d, creditCool(credit.v, k)); }
        M._ext = e; return e;
    };
    // 台股廣度
    if (TW && env.D16) {
        log('📉 讀 D16 算創 250 日新低家數…');
        const nl = newLowShare(env.D16); TW.nl = sameAlign(TW.d, [...nl.keys()], [...nl.values()]);
        log(`   ${nl.size} 天`);
    }
    if (TW && env.BREADTH16) {
        const b = JSON.parse(fs.readFileSync(env.BREADTH16, 'utf8'));
        const ci = (b.cols || []).indexOf('ld'), ni = (b.cols || []).indexOf('n');
        const rows = Array.isArray(b.v) ? b.v : null;
        if (rows && Array.isArray(b.days) && rows.length === b.days.length && ci >= 0 && ni >= 0) {
            TW.ld = sameAlign(TW.d, b.days.map(d => String(d).slice(0, 10)), rows.map(r => (r && r[ni] > 0 ? r[ci] / r[ni] : null)));
            log(`🟩 跌停家數比例:${TW.ld.filter(v => v != null).length} 天(${b.days[0]} ~ ${b.days.at(-1)})`);
        } else log(`⚠️ BREADTH16 格式不對(要 {cols, days, v})→ 跌停潮退不算`);
    }
    // 方法 × 參數
    const methods = [];
    const add = (id, label, k, fn, onlyTW = null) => methods.push({ id, label, k, fn, onlyTW });   // onlyTW = 限定期間的台股市場(只算它)
    for (const k of [PRE.L1.k, ...PRE.L1.grid]) add('L1', `退燒 ×${k}`, k, (M, L) => sigL1(M, L, k, PRE.L1.wait));
    add('L1p', '退燒安慰劑(最大跌後 20 天)', 20, (M, L) => sigL1p(M, L, 20));
    for (const k of [PRE.L2.k, ...PRE.L2.grid]) add('L2', `守底 ${k} 天`, k, (M, L) => sigL2(M, L, k));
    for (const k of [PRE.L3.k, ...PRE.L3.grid]) add('L3', `彈離 ×${k}`, k, (M, L) => sigL3(M, L, k));
    for (const [lo, hi] of [PRE.L5.k, ...PRE.L5.grid]) add('L5', `全球回暖 ${lo}→${hi}`, `${lo}-${hi}`, (M, L) => sigL5(ext(M).G, L, lo, hi));
    if (spx) for (const k of [PRE.L6.k, ...PRE.L6.grid]) add('L6', `美股先站穩 ${k} 天`, k, (M, L) => (M.sym === '^GSPC' ? -2 : sigBool(ext(M).us[k], L)));
    if (credit) for (const k of [PRE.L7.k, ...PRE.L7.grid]) add('L7', `信用退燒 ×${k}`, k, (M, L) => sigBool(ext(M).cr[k], L));
    const TWnl = TW && TW.nl ? restrictTo(TW, TW.nl) : null, TWld = TW && TW.ld ? restrictTo(TW, TW.ld) : null;
    if (TWnl) for (const k of [PRE.L4.k, ...PRE.L4.grid]) add('L4', `新低變少 ×${k}`, k, (M, L) => sigFade(M.nl, L, k, PRE.L4.wait), TWnl);
    if (TWld) for (const k of [PRE.L8.k, ...PRE.L8.grid]) add('L8', `跌停潮退 ×${k}`, k, (M, L) => sigFade(M.ld, L, k, PRE.L8.wait), TWld);

    const res = { asof: new Date().toISOString().slice(0, 10), H, markets: markets.map(M => ({ sym: M.sym, from: M.d[0], to: M.d.at(-1), legs: M.legs.length, legsF: M.legsF.length, breaks: M.breaks })), money: [], moneyFixed: [], moneyHi: [], events: [], short: [] };
    const fmtM = r => `n ${r.n}(等到 ${r.fired})・${r.mkts} 市場 ${r.clusters} 群|等 vs 馬上 ${r.x}%(中位 ${r.xMed}・贏 ${r.win}%・群 t ${r.t})前後 ${r.h1}/${r.h2}・市場 ${r.mkPos}・拿掉最好群 ${r.noBest}|vs 12 個月平均 ${r.xd}%(平均 vs 馬上 ${r.dcaVsImm})|安慰劑中位 ${r.plMed} p ${r.pPl}・等中位 ${r.waitMed} 天`;
    log(`\n━━ 資金版(段首有一筆錢,H = ${H} 天;⛔ 高通膨市場)━━`);
    for (const m of methods) {
        const mk = m.onlyTW ? [m.onlyTW] : markets;
        const fn = (M, L) => { const t = m.fn(M, L); return t === -2 ? L.s : t; };
        const r = moneyEval(mk, fn);
        if (!r.n) { log(`  ${m.label}:沒有樣本`); continue; }
        res.money.push({ id: m.id, label: m.label, k: m.k, ...r });
        log(`  ${m.label.padEnd(16)} ${fmtM(r)}  ${Object.values(r.gates).every(Boolean) ? '✅ 六關' : '⛔ ' + Object.entries(r.gates).filter(([, v]) => !v).map(([k]) => k).join('/')}`);
        const rf = moneyEval(mk, fn, { legsKey: 'legsF' });
        if (rf.n) res.moneyFixed.push({ id: m.id, label: m.label, k: m.k, ...rf });
        const rh = m.onlyTW ? { n: 0 } : moneyEval(markets.filter(M => HIGH_INF.has(M.sym)), fn, { exclude: new Set() });
        if (rh.n) res.moneyHi.push({ id: m.id, label: m.label, k: m.k, x: rh.x, n: rh.n });
    }
    // BH:中心參數 + 格一起
    const qs = bh(res.money.map(r => r.pPl));
    res.money.forEach((r, i) => { r.q = qs[i]; });
    log('\n━━ 固定高點版(歷史最高,長空頭不拆段)━━');
    for (const r of res.moneyFixed) log(`  ${r.label.padEnd(16)} n ${r.n}・等 vs 馬上 ${r.x}%(群 t ${r.t})・安慰劑 p ${r.pPl}`);
    log('\n━━ 事件研究(訊號隔天收盤買 vs 同一市場修正中隨便一天)━━');
    const evRows = [];
    for (const m of methods) {
        const mk = m.onlyTW ? [m.onlyTW] : markets;
        const ev = eventEval(mk, M => { const out = []; for (const L of M.legs) { const t = m.fn(M, L); if (t >= 0) out.push(t); } return out; });
        res.events.push({ id: m.id, label: m.label, k: m.k, h: ev });
        log(`  ${m.label.padEnd(16)} ` + HS.map(h => ev[h] && ev[h].n >= 5 ? `${h}天 ${ev[h].x}%(t ${ev[h].t}・p ${ev[h].p}・n ${ev[h].n})` : `${h}天 —`).join(' ・'));
        for (const h of HS) if (ev[h] && ev[h].p != null) evRows.push({ m: m.label, h, p: ev[h].p });
    }
    log('\n━━ 搶反彈 S1:單日跌 ≥kσ(隔天收盤買)━━');
    for (const k of [PRE.S1.k, ...PRE.S1.grid]) {
        const first = eventEval(markets, M => { const seen = new Set(), out = []; for (const i of sigS1(M, k)) { const L = M.corr[i]; if (seen.has(L)) continue; seen.add(L); out.push(i); } return out; });
        const all = eventEval(markets, M => { const out = []; let last = -1e9; for (const i of sigS1(M, k)) { if (i - last < 20) continue; out.push(i); last = i; } return out; });
        res.short.push({ k, first, all });
        log(`  ${k}σ 每段第一次:` + HS.map(h => first[h] && first[h].n >= 5 ? `${h}天 ${first[h].x}%(t ${first[h].t}・p ${first[h].p}・n ${first[h].n}・前後 ${first[h].h1}/${first[h].h2}・市場 ${first[h].mkPos})` : `${h}天 —`).join(' ・'));
        log(`  ${k}σ 隔 20 天以上都算:` + HS.map(h => all[h] && all[h].n >= 5 ? `${h}天 ${all[h].x}%(t ${all[h].t}・p ${all[h].p}・n ${all[h].n})` : `${h}天 —`).join(' ・'));
        for (const h of HS) { if (first[h] && first[h].p != null) evRows.push({ m: `S1 ${k}σ 第一次`, h, p: first[h].p }); }
    }
    const qe = bh(evRows.map(r => r.p)); res.eventBH = evRows.map((r, i) => ({ ...r, q: qe[i] })).filter(r => r.q != null && r.q <= 0.10);
    log(`\n事件研究 BH(q ≤ 0.10):${res.eventBH.length ? res.eventBH.map(r => `${r.m} ${r.h}天 q ${r.q}`).join(' ・') : '0 個'}`);
    // 現在亮了哪幾個(每個市場最後一段若還沒走完)
    res.now = [];
    for (const M of markets) {
        const L = M.legs.at(-1); if (!L || !L.open) continue;
        const lit = methods.filter(m => (!m.onlyTW || M.sym === 'TW') && m.id !== 'L1p').filter(m => { const MM = m.onlyTW || M, LL = MM.legs.at(-1); if (!LL || !LL.open) return false; const t = m.fn(MM, LL); return t >= 0 || t === -2; }).map(m => m.label);
        res.now.push({ sym: M.sym, since: M.d[L.s], dd: r2((M.c.at(-1) / L.peak - 1) * 100), lit });
    }
    log(`\n━━ 這一段(還沒走完的修正)亮了哪幾個 ━━`);
    for (const x of res.now) log(`  ${x.sym} 從 ${x.since} 起、離高點 ${x.dd}%:${x.lit.join('、') || '一個都沒有'}`);
    return res;
}

// ───────── selftest ─────────
function selftest() {
    const fails = []; const ok = (n, c, g = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(g).slice(0, 200)}`); if (!c) fails.push(n); };
    // ① σ 只用前一天以前
    const R0 = rng(3), c = [100]; for (let i = 1; i < 800; i++) c.push(c[i - 1] * Math.exp((R0() - 0.5) * 0.04));
    const r = logRet(c), s1 = sigmaPrev(r, 250);
    const c2 = c.slice(); c2[500] *= 0.7; const s2 = sigmaPrev(logRet(c2), 250);
    ok('① σ_t 不含當天:第 500 天暴跌,σ_500 不變;σ_501 才變', s1[500] === s2[500] && s1[501] !== s2[501], [s1[500], s2[500]]);
    // ② 訊號因果:截斷資料後,截斷點以前的訊號一樣
    const mk = (cc, d0 = '2000-01-03') => { const d = []; const t0 = Date.parse(d0); for (let i = 0; i < cc.length; i++) d.push(new Date(t0 + i * 864e5).toISOString().slice(0, 10)); return prepMarket('X', d, Float64Array.from(cc)); };
    const crashC = []; let p = 100; for (let i = 0; i < 1400; i++) { const ph = i % 350; p *= ph < 250 ? 1.0015 : ph < 290 ? 0.992 : 1.004; p *= Math.exp((R0() - 0.5) * 0.01); crashC.push(p); }
    const Mfull = mk(crashC), Mcut = mk(crashC.slice(0, 1000));
    const same = Mcut.legs.filter(L => !L.open).every(L => { const F = Mfull.legs.find(x => x.s === L.s); return F && ['L2', 'L3'].every(() => sigL2(Mfull, F, 15) === sigL2(Mcut, L, 15) && sigL3(Mfull, F, 1.1) === sigL3(Mcut, L, 1.1)); });
    ok('② 截斷資料:已走完的段,守底 / 彈離訊號日一樣(⛔ 偷看未來)', same && Mcut.legs.length >= 2, Mcut.legs.length);
    const L0 = Mfull.legs[0]; const tl1 = sigL1(Mfull, L0); const cutAt = tl1 >= 0 ? tl1 + 1 : L0.e;
    const Mc2 = mk(crashC.slice(0, cutAt + 1));
    ok('②b 退燒:截在訊號隔天,訊號還是同一天', tl1 >= 0 && sigL1(Mc2, Mc2.legs[0]) === tl1, [tl1, sigL1(Mc2, Mc2.legs[0])]);
    // ③ 資金版算術
    const toy = { c: Float64Array.from({ length: 700 }, (_, i) => 100 + i), d: [], corr: [] };
    const Lt = { s: 10, e: 50, open: false };
    const m = moneyLeg(toy, Lt, 20);
    const T = 11 + H, exp = (1 - COST) * toy.c[T] / toy.c[21];
    ok('③ 資金版:訊號第 20 天 → 第 21 天收盤買、第 11+H 天比', Math.abs(m.sig - exp) < 1e-12 && Math.abs(m.imm - (1 - COST) * toy.c[T] / toy.c[11]) < 1e-12, [m.sig, exp]);
    const m2 = moneyLeg(toy, Lt, -1);
    ok('③b 沒等到 → 段尾隔天(e+2)收盤買', Math.abs(m2.sig - (1 - COST) * toy.c[T] / toy.c[52]) < 1e-12, m2.sig);
    // ④ 決定性對照:埋「守底 15 天之後大漲」→ 守底資金版贏安慰劑;沒埋 → 安慰劑 p 不小
    const build = (inject, seed) => {
        const R = rng(seed), ms = [];
        for (let k = 0; k < 12; k++) {
            const cc = []; let q = 100, lo = Infinity, loI = 0, mode = 0, since = 0;
            for (let i = 0; i < 2600; i++) {
                const ph = (i + k * 37) % 400;
                let mu = ph < 280 ? 0.0006 : ph < 320 ? -0.008 : 0.0002;
                if (inject) { if (q < lo) { lo = q; loI = i; } if (ph >= 320 && i - loI >= 15) mu = 0.004; }
                q *= Math.exp(mu + (R() - 0.5) * 0.02); cc.push(q);
            }
            ms.push(prepMarket(`M${k}`, Array.from({ length: cc.length }, (_, i) => new Date(Date.parse('1990-01-01') + (i + k * 3) * 864e5).toISOString().slice(0, 10)), Float64Array.from(cc)));
        }
        return ms;
    };
    const yes = moneyEval(build(true, 5), (M, L) => sigL2(M, L, 15));
    const no = moneyEval(build(false, 5), (M, L) => sigL2(M, L, 15));
    ok('④ 埋「守底後大漲」→ 等訊號贏馬上買而且贏安慰劑', yes.n > 20 && yes.x > 0 && yes.pPl <= 0.1, JSON.stringify({ x: yes.x, p: yes.pPl, n: yes.n }));
    ok('④b 沒埋 → 安慰劑 p 不小(> 0.1)', no.n > 20 && no.pPl > 0.1, JSON.stringify({ x: no.x, p: no.pPl, n: no.n }));
    // ⑤ 危機群
    const cl = clusters(['2008-09-15', '2008-10-01', '2008-12-20', '2020-03-01', '2020-03-10']);
    ok('⑤ 危機群:90 天內同一群、隔年另一群', cl[0] === cl[1] && cl[1] !== cl[2] && cl[3] === cl[4] && cl[2] !== cl[3], cl);
    // ⑥ 美股前一天:同一天 ⛔ 用
    const la = lagAlign(['2020-01-02', '2020-01-03'], ['2020-01-02', '2020-01-03'], [1, 2]);
    ok('⑥ 外部序列只用「日期 < 當天」(同一天 = 前視)', la[0] === null && la[1] === 1, la);
    // ⑦ 斷點接起來
    const sp = spliceBreaks(Float64Array.from([100, 101, 1.02, 1.03]));
    ok('⑦ 單日 ÷100 當斷點接起來(那天報酬 = 0、前後的漲跌不變;⛔ 當成真的崩 99%)', sp.breaks === 1 && Math.abs(sp.c[2] / sp.c[1] - 1) < 1e-9
       && Math.abs(sp.c[1] / sp.c[0] - 1.01) < 1e-9 && Math.abs(sp.c[3] / sp.c[2] - 1.03 / 1.02) < 1e-9, Array.from(sp.c));
    ok('⑦b 真的大跌 −38%(阿根廷 2019)照收', spliceBreaks(Float64Array.from([100, 62])).breaks === 0);
    // ⑧ 高通膨市場不進主判準
    const hi = moneyEval([Object.assign(build(true, 9)[0], { sym: '^MERV' })], (M, L) => sigL2(M, L, 15));
    ok('⑧ ^MERV 不進主判準', hi.n === 0);
    // ⑨ S1 只看修正中、σ 用前一天
    const ms = mk(crashC); const ev = sigS1(ms, 2.5);
    ok('⑨ 單日 2.5σ 只收修正中的日子', ev.every(i => ms.corr[i] >= 0));
    // ⑩ 沒資料(null)⛔ 當成 0:前面全是 null、後面才有值 → 照有值那段判
    const Lx = { s: 0, e: 9 }, X = [null, null, null, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.04];
    ok('⑩ 峰值消退:null 不算 0(⛔ 被 null >= 0 騙)', sigFade(X, Lx, 0.2, 2) === 7 && sigFade([null, null, null], { s: 0, e: 2 }, 0.2, 1) === -1, sigFade(X, Lx, 0.2, 2));
    // ⑪ 只留段首有資料的段 + 對照池跟著縮
    const Mr = restrictTo({ c: new Float64Array(10), legs: [{ s: 1, e: 2 }, { s: 5, e: 7 }], legsF: [{ s: 1, e: 7 }] }, [null, null, null, null, 1, 1, 1, 1, 1, 1]);
    ok('⑪ 台股廣度只用有資料的段、修正中對照池只剩那段', Mr.legs.length === 1 && Mr.legs[0].s === 5 && Mr.legsF.length === 0 && Mr.corr[1] === -1 && Mr.corr[6] === 0, JSON.stringify({ l: Mr.legs, c: Array.from(Mr.corr) }));
    console.log(`\n${fails.length ? `❌ ${fails.length} 條失敗` : '✅ 全過'}(共 15 條)`);
    return fails.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    if (!process.env.WORLD) { console.error('要 WORLD=<world_hist.json.gz>'); process.exit(1); }
    const res = run();
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(res, (k, v) => (k === 'M' || k === 'L' || k === 'base' ? undefined : v), 1));
}
