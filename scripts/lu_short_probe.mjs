#!/usr/bin/env node
/**
 * 🟥⬇️ lu_short_probe.mjs —— 「漲停隔天能不能空?條件到了才空」(V82.1.0,外部評估紀錄:權證小哥 11/09 文宣)
 *
 * 他的原話:「不是漲停就空,而是條件到了才空 —— 周轉率要夠、前面要漲過一段、空的理由要能疊起來」。
 * 以前本站只測過漲停隔天「做多 / 已經有的人隔天開盤賣」(lu_split / dt_daily / lu_touch),⛔ 沒測過放空 → 這一支補上。
 *
 * 事件:第 i 天收盤鎖漲停(downday_lu_probe.lockUp,⛔ 第二份;2015-06 前 7%,除權息日不判)
 * 進場:第 i+1 天開盤放空
 *   ⛔ 開盤就在跌停 → 空不到(沒人接)→ 剔除並計數
 *   ⚠️ 平盤以下(開盤 < 前收)→ 融券 / 當沖先賣有限制 → 每一格都印「只算平盤以上」與「全部」兩種
 * 回補:dt = 當天收盤(現股當沖,成本 0.25%)・h3 / h5 / h10 = 第 i+h 天收盤(融券,來回 0.665% 同 short_inverse_probe F)
 *   🚨 回補那天收盤鎖漲停 = 買不回來 → 一直延到第一個「開盤沒在漲停」的那天開盤價補(記延了幾天、最慘一筆)
 *   除權息:用調整價(放空要賠股利)
 * 條件(全部只用第 i 天收盤以前看得到的):
 *   換手率 = 第 i 天成交股數 ÷ 第 i−1 天(含以前最近一筆)發行股數(stock_deep/share)
 *   前面漲一段 = 第 i−1 天收盤 ÷ 第 i−21 天收盤 −1(⛔ 不含漲停那天)
 *   位階(含當天,同 lu_split posOf)・連續第幾根
 * 對照:
 *   ① 同一天全部股票(開盤放空 → 同一天回補,⛔ 不處理鎖死 → 對照偏好、事件偏難 = 保守)
 *   ② 🎲 安慰劑:同一天、同樣換手桶 × 前漲桶、但當天「沒有」鎖漲停的股票 → 回答「是漲停的關係,還是本來就漲很多、換手很高的股票隔天會跌」
 * 六關(maxim_kbar5_probe.gates,⛔ 第二份):增量 = 放空報酬 − 同一天全部股票放空報酬
 * 高原:換手 ≥3/5/10/15% × 前漲 ≥20/30/50% 共 12 格
 * 熱門股另用 5 分 K 09:05 放空量一次(開盤撮合價假象,陷阱 lu-gapdown 那次)
 * 盤勢:加權嚴格空頭(收 < 60 日線且 20 < 60)/ 多頭(收 > 60 日線且 20 > 60)/ 其他 分開印
 *
 * 跑法:DATA_DIR=$S/d16 DIV=$S/d16/_div16.json SHARE_DIR=$S/sd/stock_deep/share \
 *       KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5:$S/k5lu/kbar5_lu node --max-old-space-size=12000 scripts/lu_short_probe.mjs out.json
 *       node scripts/lu_short_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { lockUp } from './downday_lu_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';
import { posOf, streakOf } from './lu_split_probe.mjs';
import { limitOf } from './lib_limit.mjs';

export const COST = { dt: 0.25, h3: 0.665, h5: 0.665, h10: 0.665 };
export const EXITS = { dt: 1, h3: 3, h5: 5, h10: 10 };
const DEDUP = 20;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, q) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };

/** 換手率 %(第 i 天量 ÷ 前一天以前最近一筆發行股數);沒有股數回 NaN */
export function turnoverOf(S, i, cal, sh) {
    if (!sh || !(S.V[i] > 0)) return NaN;
    const d = cal[i]; let lo = 0, hi = sh.d.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (sh.d[m] < d) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 && sh.v[k] > 0 ? 100 * S.V[i] / sh.v[k] : NaN;
}
/** 前面漲一段 %:第 i−1 天收盤 ÷ 第 i−21 天收盤 − 1(⛔ 不含漲停那天);除權息用調整價 */
export function preRun(S, i) { const e = process.env.LS_INJECT === 'peek' ? i : i - 1;   // 注入:含漲停那天(前視)→ selftest ⑥ 必紅
    const a = S.A[e], b = S.A[e - 20]; return a > 0 && b > 0 ? 100 * (a / b - 1) : NaN; }
/** 斷崖守門:窗口內任一天(含)漲跌超過漲跌幅 +1.5% → 尺標壞了 */
function cliff(S, a, b, cal) { for (let j = Math.max(1, a); j <= b; j++) { const p = S.C[j - 1], c = S.C[j]; if (p > 0 && c > 0 && Math.abs(c * S.F[j] / p - 1) > limitOf(cal[j]) + 0.015) return true; } return false; }

/**
 * 第 i 天鎖漲停 → 第 i+1 天開盤放空 → 照 ex 回補。回 {r: 放空報酬 %(未扣成本), lag: 延幾天, below, gap} / 'nofill' / null
 * 放空報酬 = −(多頭報酬);多頭報酬用調整價(放空要賠股利)
 */
export function shortFwd(S, i, ex, cal, entryPx = null) {
    const n = cal.length, pc = S.C[i], o1 = entryPx ?? S.O[i + 1], h = EXITS[ex];
    if (!(pc > 0 && o1 > 0 && S.C[i + 1] > 0) || i + h >= n) return null;
    if (o1 <= pc * (1 - limitOf(cal[i + 1]) + 0.003)) return 'nofill';
    let e = i + h; if (!(S.C[e] > 0 && S.A[e] > 0 && S.A[i + 1] > 0)) return null;
    let long, lag = 0;
    if (!lockUp(S, e, cal)) long = (S.C[i + 1] / o1) * (S.A[e] / S.A[i + 1]) - 1;
    else {   // 回補那天收盤鎖漲停 → 買不回來 → 第一個開盤沒在漲停的日子開盤補
        let k = e + 1;
        while (k < n && S.O[k] > 0 && S.C[k - 1] > 0 && S.O[k] >= S.C[k - 1] * (1 + limitOf(cal[k]) - 0.003)) k++;
        if (k >= n || !(S.O[k] > 0 && S.A[k - 1] > 0)) return null;
        lag = k - e;
        long = (S.C[i + 1] / o1) * (S.A[k - 1] / S.A[i + 1]) * (S.O[k] * S.F[k] / S.C[k - 1]) - 1;
    }
    return { r: -100 * long, lag, below: o1 < pc, gap: 100 * (o1 / pc - 1) };
}

const tBin = t => (t < 2 ? '<2' : t < 5 ? '2~5' : t < 10 ? '5~10' : t < 20 ? '10~20' : '≥20');
const rBin = r => (r < 0 ? '<0' : r < 20 ? '0~20' : r < 40 ? '20~40' : '≥40');
export const GRID_T = [3, 5, 10, 15], GRID_R = [20, 30, 50];

export function scan(ctx, opt = {}) {
    const { cal, stocks } = ctx, n = cal.length, shares = opt.shares || {}, k5 = opt.k5 || null, reg = opt.reg || null;
    const out = { ev: {}, cnt: { lu: 0, nofill: 0, cliff: 0, noShare: 0, k5scale: 0 } };
    const put = (k, ex, o) => ((out.ev[k] = out.ev[k] || {})[ex] = (out.ev[k][ex] || [])).push(o);
    const meta = new Map();   // 每檔每天的 換手桶|前漲桶(安慰劑用),依需要算
    const binOf = (S, i) => { const key = S.k * 100000 + i; if (meta.has(key)) return meta.get(key);
        const t = turnoverOf(S, i, cal, shares[S.sym]), r = preRun(S, i); const b = Number.isFinite(t) && Number.isFinite(r) ? tBin(t) + '|' + rBin(r) : null; meta.set(key, b); return b; };
    stocks.forEach((S, k) => { S.k = k; });
    // 同一天全部股票 / 安慰劑:開盤放空 → 同一個回補日收盤(對照不處理鎖死)
    const dayAll = new Map(), dayPl = new Map();
    const ctrlShort = (S, i, h) => { const o1 = S.O[i + 1], e = i + h; if (!(o1 > 0 && S.C[i + 1] > 0 && S.A[e] > 0 && S.A[i + 1] > 0 && S.C[i] > 0)) return NaN;
        if (o1 <= S.C[i] * (1 - limitOf(cal[i + 1]) + 0.003)) return NaN; return -100 * ((S.C[i + 1] / o1) * (S.A[e] / S.A[i + 1]) - 1); };
    const allMean = (i, h) => { const key = i * 100 + h; if (dayAll.has(key)) return dayAll.get(key); const a = [];
        for (const S of stocks) { const v = ctrlShort(S, i, h); if (Number.isFinite(v)) a.push(v); }
        const v = a.length >= 30 ? mean(a) : NaN; dayAll.set(key, v); return v; };
    const plMean = (i, h, bin) => { const key = i * 100 + h; let M = dayPl.get(key);
        if (!M) { M = new Map(); for (const S of stocks) { if (!(S.C[i] > 0) || lockUp(S, i, cal)) continue; const b = binOf(S, i); if (!b) continue; const v = ctrlShort(S, i, h); if (!Number.isFinite(v)) continue; const a = M.get(b) || []; a.push(v); M.set(b, a); }
            for (const [b, a] of M) M.set(b, a.length >= 5 ? mean(a) : NaN); dayPl.set(key, M); }
        return M.has(bin) ? M.get(bin) : NaN; };
    const last = new Map();
    for (let i = 22; i < n - 1; i++) {
        if (opt.FROM && cal[i] < opt.FROM) continue;
        for (const S of stocks) {
            if (!lockUp(S, i, cal)) continue;
            out.cnt.lu++;
            if (cliff(S, i - 21, Math.min(n - 1, i + 12), cal)) { out.cnt.cliff++; continue; }
            const t = turnoverOf(S, i, cal, shares[S.sym]), r = preRun(S, i), pos = posOf(S, i), st = streakOf(S, i, cal);
            if (!Number.isFinite(t)) out.cnt.noShare++;
            const tags = ['全部'];
            if (Number.isFinite(t)) { tags.push('換手:' + tBin(t)); for (const T of GRID_T) if (t >= T) tags.push(`換手≥${T}`); }
            if (Number.isFinite(r)) { tags.push('前20日:' + rBin(r)); for (const R of GRID_R) if (r >= R) tags.push(`前20日≥${R}`); }
            if (Number.isFinite(pos) && pos >= 80) tags.push('位階≥80');
            tags.push(st >= 2 ? '連續:第≥2根' : '連續:第1根');
            if (Number.isFinite(t) && Number.isFinite(r)) for (const T of GRID_T) for (const R of GRID_R) if (t >= T && r >= R) {
                tags.push(`組合:換手≥${T}×前漲≥${R}`);
                if (Number.isFinite(pos) && pos >= 80) tags.push(`組合+位階≥80:換手≥${T}×前漲≥${R}`); }
            const g1 = S.O[i + 1] > 0 ? 100 * (S.O[i + 1] / S.C[i] - 1) : NaN;
            if (Number.isFinite(g1)) tags.push('隔天開盤(事後):' + (g1 >= 3 ? '開高≥3%' : g1 > -3 ? '開平±3%' : '開低≤−3%'));
            const okTags = tags.filter(tg => { const key = S.sym + '|' + tg, lp = last.get(key); if (lp != null && i - lp < DEDUP) return false; last.set(key, i); return true; });
            if (!okTags.length) continue;
            const bin = Number.isFinite(t) && Number.isFinite(r) ? tBin(t) + '|' + rBin(r) : null;
            const rg = reg ? reg[i] : '';
            for (const ex of Object.keys(EXITS)) {
                const h = EXITS[ex], f = shortFwd(S, i, ex, cal);
                if (f === 'nofill') { if (ex === 'dt') out.cnt.nofill++; continue; }
                if (!f) continue;
                const am = allMean(i, h); if (!Number.isFinite(am)) continue;
                const pl = bin ? plMean(i, h, bin) : NaN;
                let r905 = null;
                if (ex === 'dt' && k5) { const D1 = k5[cal[i + 1]], b1 = D1 && D1.k && D1.k[S.sym];
                    if (b1 && b1.length > 2 && b1[0][0] === 540 && b1[1][0] === 545 && b1[1][1] > 0) {
                        if (Math.abs(b1[0][1] / S.O[i + 1] - 1) <= 0.02) { const f9 = shortFwd(S, i, 'dt', cal, b1[1][1]); if (f9 && f9 !== 'nofill') r905 = f9.r - COST.dt; }
                        else out.cnt.k5scale++; } }
                const o = { d: cal[i], s: S.sym, r: f.r, net: f.r - COST[ex], inc: f.r - am, incPl: Number.isFinite(pl) ? f.r - pl : NaN, lag: f.lag, below: f.below, nlu: lockUp(S, i + 1, cal) ? 1 : 0, rg, r905 };
                for (const tg of okTags) put(tg, ex, o);
            }
        }
    }
    return out;
}

function sumArr(arr) {
    if (!arr.length) return null;
    const g = gates(arr.map(o => ({ d: o.d, v: o.inc })), arr.map(o => o.net), +1);
    const pl = arr.filter(o => Number.isFinite(o.incPl)).map(o => o.incPl);
    const nets = arr.map(o => o.net), k9 = arr.filter(o => Number.isFinite(o.r905));
    const byRg = {}; for (const o of arr) (byRg[o.rg || '?'] = byRg[o.rg || '?'] || []).push(o.net);
    return { n: arr.length, net: +mean(nets).toFixed(2), med: +pct(nets, 0.5).toFixed(2), win: +(100 * nets.filter(x => x > 0).length / nets.length).toFixed(1),
        p10: +pct(nets, 0.1).toFixed(1), worst: +Math.min(...nets).toFixed(1), stuck: +(100 * mean(arr.map(o => (o.lag > 0 ? 1 : 0)))).toFixed(1), nlu: +(100 * mean(arr.map(o => o.nlu))).toFixed(1),
        inc: g.inc, t: g.t, pass: g.pass, gates: g.gates, years: g.years,
        pl: pl.length >= 30 ? { n: pl.length, inc: +mean(pl).toFixed(2), t: +(mean(pl) / (Math.sqrt(mean(pl.map(a => (a - mean(pl)) ** 2))) / Math.sqrt(pl.length) || 1)).toFixed(1) } : null,
        k5: k9.length >= 20 ? { n: k9.length, open: +mean(k9.map(o => o.net)).toFixed(2), at905: +mean(k9.map(o => o.r905)).toFixed(2) } : null,
        rg: Object.fromEntries(Object.entries(byRg).map(([k, a]) => [k, [a.length, +mean(a).toFixed(2)]])) };
}

export function summarize(out) {
    const res = {};
    for (const [k, byEx] of Object.entries(out.ev)) { res[k] = {};
        for (const [ex, arr] of Object.entries(byEx)) res[k][ex] = { flat: sumArr(arr.filter(o => !o.below)), all: sumArr(arr), belowPct: +(100 * mean(arr.map(o => (o.below ? 1 : 0)))).toFixed(1) }; }
    return res;
}

/** 加權盤勢:嚴格空頭 / 多頭 / 其他(第 i 天收盤,只用當天以前) */
export function regimeOf(tw) {
    const n = tw.length, out = new Array(n).fill('');
    for (let i = 59; i < n; i++) { let a = 0, b = 0; for (let j = i - 59; j <= i; j++) { b += tw[j]; if (j > i - 20) a += tw[j]; } a /= 20; b /= 60;
        out[i] = tw[i] < b && a < b ? '空頭' : tw[i] > b && a > b ? '多頭' : '其他'; }
    return out;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 340, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10));
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const mk = (sym, mod) => { const C = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), L = new Float64Array(n), V = new Float64Array(n).fill(1e6), F = new Float64Array(n).fill(1);
        let p = 100; for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.02; C[i] = p; O[i] = i ? C[i - 1] : p; H[i] = Math.max(O[i], C[i]) * 1.001; L[i] = Math.min(O[i], C[i]) * 0.999; }
        const S = { sym, C, O, H, L, V, F }; if (mod) mod(S); S.A = S.C.slice(); return S; };
    // 第 i 天鎖漲停(之後整段 ×1.1,開盤 = 前收 × opn)
    const lockAt = (S, i, opn = 1.0) => { const k = 1.1; S.C[i] = S.C[i - 1] * k; S.H[i] = S.C[i]; S.L[i] = Math.min(S.L[i], S.C[i - 1]);
        for (let j = i + 1; j < n; j++) { S.C[j] *= k; S.H[j] *= k; S.L[j] *= k; S.O[j] *= k; } S.O[i + 1] = S.C[i] * opn; S.H[i + 1] = Math.max(S.H[i + 1], S.O[i + 1], S.C[i + 1]); S.L[i + 1] = Math.min(S.L[i + 1], S.O[i + 1], S.C[i + 1]); };
    const sh = v => ({ d: [cal[0]], v: [v] });
    const others = Array.from({ length: 60 }, (_, k) => mk(String(5000 + k)));
    const shares = Object.fromEntries(others.map(S => [S.sym, sh(1e8)]));
    // ① 基本:隔天開平盤放空、收盤回補 = −(收/開 −1)
    const X = mk('1001', S => { lockAt(S, 300, 1.0); S.C[301] = S.O[301] * 0.97; S.L[301] = Math.min(S.L[301], S.C[301]); S.A = S.C.slice(); });
    const fx = shortFwd(X, 300, 'dt', cal);
    t(fx && Math.abs(fx.r - 3) < 1e-6 && fx.lag === 0, '① 開平放空、收盤 −3% → 放空 +3%');
    // ② 開盤就在跌停 → 空不到
    const Y = mk('1002', S => { lockAt(S, 300, 0.9); S.A = S.C.slice(); });
    t(shortFwd(Y, 300, 'dt', cal) === 'nofill', '② 隔天開盤在跌停 → 空不到(nofill)');
    // ③ 平盤以下標 below
    const Z = mk('1003', S => { lockAt(S, 300, 0.97); S.A = S.C.slice(); });
    const fz = shortFwd(Z, 300, 'dt', cal); t(fz && fz.below === true && Math.abs(fz.gap + 3) < 1e-6, '③ 開盤低於前收 → 標「平盤以下」');
    // ④ 回補那天收盤又鎖漲停 → 延到下一個沒開在漲停的開盤
    const W = mk('1004', S => { lockAt(S, 300, 1.02); lockAt(S, 301, 1.0); S.A = S.C.slice(); });
    const fw = shortFwd(W, 300, 'dt', cal);
    t(fw && fw.lag === 1 && Math.abs(fw.r - (-100 * (W.O[302] / W.O[301] - 1))) < 1e-6 && fw.r < -5, `④ 當天收盤又鎖漲停 → 隔天開盤才補(延 ${fw && fw.lag} 天、放空 ${fw && fw.r.toFixed(1)}%)`);
    // ⑤ 換手率用前一天以前的股數(⛔ 前視):股數在當天改 → 不吃當天那筆
    const T = mk('1005'); const shT = { d: [cal[0], cal[300]], v: [1e8, 1e6] };
    t(Math.abs(turnoverOf(T, 300, cal, shT) - 1) < 1e-9, '⑤ 換手率用第 i−1 天以前的股數(當天才變的 ⛔ 用)');
    // ⑥ 前漲不含漲停那天
    const P = mk('1006', S => { for (let j = 0; j < n; j++) { S.C[j] = 100; S.O[j] = 100; S.H[j] = 100.1; S.L[j] = 99.9; } lockAt(S, 300); S.A = S.C.slice(); });
    t(Math.abs(preRun(P, 300)) < 1e-9, '⑥ 前 20 日漲幅 ⛔ 含漲停那天(平盤 20 天 → 0)');
    // ⑦ scan + 決定性對照:埋「漲停股隔天跌 4%」→ 增量量得到;沒埋 ≈ 0
    const mkSet = (drop) => { const ev = Array.from({ length: 40 }, (_, k) => mk(String(1100 + k), S => { const d0 = 60 + 6 * k; lockAt(S, d0, 1.0); S.C[d0 + 1] = S.O[d0 + 1] * (1 - drop); S.H[d0 + 1] = Math.max(S.H[d0 + 1], S.O[d0 + 1]); S.L[d0 + 1] = Math.min(S.L[d0 + 1], S.C[d0 + 1]); for (let j = d0 + 2; j < n; j++) { S.C[j] *= 1 - drop; S.O[j] *= 1 - drop; S.H[j] *= 1 - drop; S.L[j] *= 1 - drop; } S.A = S.C.slice(); }));
        const all = [...ev, ...others]; const shs = { ...shares, ...Object.fromEntries(ev.map(S => [S.sym, sh(5e6)])) };
        return summarize(scan({ cal, stocks: all }, { shares: shs })); };
    const s4 = mkSet(0.04), s0 = mkSet(0);
    const a4 = s4['全部'].dt.all, a0 = s0['全部'].dt.all;
    t(a4 && a4.inc > 3 && a0 && Math.abs(a0.inc) < 1, `⑦ 決定性對照:埋隔天 −4% → 增量 ${a4 && a4.inc}(>3);沒埋 → ${a0 && a0.inc}(≈0)`);
    t(s4['換手:≥20'] && s4['換手:≥20'].dt && s4['換手:≥20'].dt.all.n === a4.n, '⑧ 換手率 = 量 ÷ 股數(1e6 ÷ 5e6 = 20%)進「≥20」那桶');
    // ⑨ 同一檔 20 天內只算一次
    const R3 = mk('1200', S => { lockAt(S, 200); lockAt(S, 201); lockAt(S, 202); S.A = S.C.slice(); });
    const o9 = scan({ cal, stocks: [R3, ...others] }, { shares });
    t(((o9.ev['全部'] || {}).dt || []).filter(e => e.s === '1200').length === 1, '⑨ 連三天鎖漲停「全部」那桶只算第一天');
    // ⑩ 前視注入:把第 i+1 天的收盤偷看進條件 → 這裡用 preRun(i) 是否改變判斷(改 i+1 的價格,條件不可變)
    const Q = mk('1300', S => { lockAt(S, 300); S.A = S.C.slice(); }); const before = preRun(Q, 300); Q.A[301] *= 2; Q.A[305] *= 3;
    t(preRun(Q, 300) === before && turnoverOf(Q, 300, cal, sh(1e8)) === 1, '⑩ 改掉之後的價格,條件不變(⛔ 前視)');
    // ⑪ 安慰劑:同桶沒漲停的股票也一樣跌 → 對安慰劑增量 ≈ 0
    const flat = (S, d0) => { const b = S.C[d0 - 22]; for (let j = d0 - 21; j < d0; j++) { S.C[j] = b * 1.25 ** ((j - (d0 - 21)) / 20); S.O[j] = S.C[j - 1]; S.H[j] = S.C[j] * 1.001; S.L[j] = Math.min(S.O[j], S.C[j]) * 0.999; } for (let j = d0; j < n; j++) { S.C[j] *= 1.25; S.O[j] *= 1.25; S.H[j] *= 1.25; S.L[j] *= 1.25; } };   // 前 20 日剛好漲 25%(之後整段跟著換尺標,⛔ 假斷崖) → 事件與雙胞胎同一桶(其他股票不會在這桶)
    const evs = Array.from({ length: 40 }, (_, k) => mk(String(1400 + k), S => { const d0 = 60 + 6 * k; flat(S, d0); lockAt(S, d0, 1.0); S.C[d0 + 1] = S.O[d0 + 1] * 0.97; S.L[d0 + 1] = Math.min(S.L[d0 + 1], S.C[d0 + 1]); for (let j = d0 + 2; j < n; j++) { S.C[j] *= 0.97; S.O[j] *= 0.97; S.H[j] *= 0.97; S.L[j] *= 0.97; } S.A = S.C.slice(); }));
    const twins = Array.from({ length: 40 }, (_, k) => Array.from({ length: 15 }, (_, z) => mk(String(2000 + k * 15 + z), S => { const d0 = 60 + 6 * k; flat(S, d0); S.C[d0] = S.C[d0 - 1]; S.O[d0 + 1] = S.C[d0]; S.C[d0 + 1] = S.O[d0 + 1] * 0.97; S.L[d0 + 1] = Math.min(S.L[d0 + 1], S.C[d0 + 1]); for (let j = d0 + 2; j < n; j++) { S.C[j] *= 0.97; S.O[j] *= 0.97; S.H[j] *= 0.97; S.L[j] *= 0.97; } S.A = S.C.slice(); }))).flat();
    const shAll = { ...shares, ...Object.fromEntries([...evs, ...twins].map(S => [S.sym, sh(5e6)])) };
    const sp = summarize(scan({ cal, stocks: [...evs, ...twins, ...others] }, { shares: shAll }))['全部'].dt.all;
    t(sp && sp.pl && Math.abs(sp.pl.inc) < 0.5 && sp.inc > 1.5, `⑪ 安慰劑:同樣換手 / 前漲但沒漲停的也跌 3% → 對安慰劑增量 ${sp && sp.pl && sp.pl.inc}(≈0),對全部股票 ${sp && sp.inc}`);
    // ⑫ 盤勢
    const rg = regimeOf(Array.from({ length: 120 }, (_, i) => (i < 60 ? 100 + i : 160 - 2 * (i - 60))));
    t(rg[59] === '多頭' && rg[119] === '空頭', '⑫ 盤勢:一路漲 = 多頭、一路跌 = 空頭');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('lu_short_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const { loadCtx } = await import('./leader_probe.mjs');
    const ctx = loadCtx(process.env.DATA_DIR, process.env.DIV);
    const shares = {}; let shN = 0;
    if (process.env.SHARE_DIR) for (const S of ctx.stocks) { const f = path.join(process.env.SHARE_DIR, S.sym + '.json.gz'); if (!fs.existsSync(f)) continue;
        const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()); const ci = (j.c || []).indexOf('NumberOfSharesIssued'); const col = ci >= 0 ? ci : (j.v[0] || []).length - 1;
        shares[S.sym] = { d: j.d.map(x => String(x).slice(0, 10)), v: j.v.map(r => +r[col]) }; shN++; }
    let k5 = null; if (process.env.KBAR5_DIR) { const { loadKbar5 } = await import('./dt_kbar5_probe.mjs'); k5 = loadKbar5(process.env.KBAR5_DIR, { mergeSyms: true }).days; console.log(`kbar5 ${Object.keys(k5).length} 天`); }
    const tw = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, '^TWII.json'), 'utf8'));
    const twm = new Map(tw.map(r => [String(r.date).replace(/\//g, '-').slice(0, 10), +r.close]));
    const reg = regimeOf(ctx.cal.map(d => twm.get(d) || NaN));
    console.log(`${ctx.stocks.length} 檔 ・日曆 ${ctx.cal[0]} ~ ${ctx.cal.at(-1)}(${ctx.cal.length} 天)・有股數 ${shN} 檔`);
    const out = scan(ctx, { shares, k5, reg, FROM: process.env.FROM || '' });
    const res = summarize(out);
    if (out.cnt.lu < 5000) { console.log('❌ 漲停事件 <5,000,資料不對'); process.exit(1); }
    console.log(`鎖漲停 ${out.cnt.lu} 次 ・斷崖剔除 ${out.cnt.cliff} ・沒有股數 ${out.cnt.noShare} ・隔天開盤在跌停空不到 ${out.cnt.nofill} ・5分K 尺標不合 ${out.cnt.k5scale}`);
    const line = (k, ex, x, bp) => x ? `${k.padEnd(26)} ${ex.padEnd(3)} n=${String(x.n).padStart(6)} 平盤下${String(bp).padStart(5)}% ・放空扣成本 ${x.net}%(中位 ${x.med} 賺 ${x.win}% 最差10% ${x.p10} 最慘 ${x.worst})・補不回 ${x.stuck}% ・增量 ${x.inc} t${x.t} 關${x.pass}` +
        (x.pl ? ` ・vs安慰劑 ${x.pl.inc}(t${x.pl.t})` : '') + (x.k5 ? ` ・5分K n=${x.k5.n} 開盤 ${x.k5.open} / 09:05 ${x.k5.at905}` : '') + ` ・盤勢 ${Object.entries(x.rg).map(([a, b]) => a + b[1] + '/' + b[0]).join(' ')}` : `${k} ${ex} —`;
    const ORDER = ['全部', '換手:', '換手≥', '前20日:', '前20日≥', '位階', '連續', '隔天開盤', '組合:', '組合+'];
    const keys = Object.keys(res).sort((a, b) => ORDER.findIndex(p => a.startsWith(p)) - ORDER.findIndex(p => b.startsWith(p)) || a.localeCompare(b, 'zh-Hant'));
    for (const k of keys) for (const ex of Object.keys(EXITS)) { const r = res[k][ex]; if (!r) continue; console.log(line(k, ex, r.flat, r.belowPct)); }
    console.log('\n—— 只算平盤以上 vs 全部(dt)——');
    for (const k of keys) { const r = res[k].dt; if (r && r.all) console.log(`${k.padEnd(26)} 平盤以上 ${r.flat ? r.flat.net : '—'}% ・全部 ${r.all.net}%(n ${r.all.n})`); }
    console.log('\n—— 逐年(全部・dt・平盤以上)——', JSON.stringify((res['全部'].dt.flat || {}).years));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ from: ctx.cal[0], to: ctx.cal.at(-1), cnt: out.cnt, res }));
}
