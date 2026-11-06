#!/usr/bin/env node
// 🎯 V79.3.2 「大跌那天撿 👑 今天前 5 名還是前 10 名?還是別的?」(使用者:「我相信一定有,只是你想不出來」)
//
//  大盤事件(加權收盤對收盤):
//    d2 / d3   = 當天跌 ≥2% / ≥3%
//    d2e1      = 跌 ≥2% 而且是這一段跌勢的第一天(前 20 個交易日沒有 ≥2% 的跌)
//    d3k2      = 同一段跌勢第二次以上跌 ≥3%(恐慌加深)
//    conf      = 前 3 天內有一天跌 ≥3%,今天加權第一次收紅(止跌確認)
//  候選(全部只用「買的那一刻已經知道的事」):
//    L5 / L10      = 👑 排名前 5 / 前 10(成交額前 100 大 + 收盤 > 20 日線 > 60 日線 + 10 日動能;**用前一天收盤排**
//                    = 大跌那天白天 App 上看到的名單)
//    L5t           = 同一套、用**當天收盤**排(收盤後才知道,只能隔天開盤買)
//    L10dn         = L10 裡今天跌最多的一半(強勢股被大盤錯殺)
//    POOL          = 成交額前 100 大裡過趨勢的全部
//    U100          = 成交額前 100 大全部(不看趨勢)
//    RShi / RSlo   = 成交額前 100 大裡今天最抗跌 10 檔 / 跌最多 10 檔
//    UPDAY         = 成交額前 100 大裡今天逆勢收紅的
//    ALL           = 全部上市櫃普通股
//    0050          = 0050 含息
//  進場:當天尾盤(收盤價)/ 隔天開盤;出場:第 h 天收盤(h = 1/5/10/20);扣來回成本 0.44%(0050 不扣)
//    收盤鎖漲停買不到、隔天開盤接近漲停買不到 → 剔除
//  比較(每一個「候選 × 事件 × h × 進場」):
//    ① 絕對:扣完成本平均賺多少
//    ② 撿便宜增量(雙重差分)= 同一組在大跌日買 − 同一組在平常日子買(⭐ 這才回答「大跌是不是比較便宜」)
//    ③ vs 0050 同一天
//    t 值以「跌勢波段」為單位(同一段只算一個平均)→ ⛔ 不讓 2020 / 2025 連續好幾天重複計算(V79.3.1 的教訓)
//    六關:增量 t≥2 / 前後半同向 / 去最好年 / 扣成本絕對 >0 / 贏 0050 / 逐年 ≥60% 年份為正;BH 多重比較校正
//  另外兩件:
//    (B) 個股:大盤大跌那天跌停的股票,隔天收紅(≥3%)→ 再隔天開盤買、抱 20 天:成交額前 100 大 vs 其他
//        (= 本站唯一三種行情都過的「跌停後紅K」,看「熱門股」是不是更好)
//    (C) 組合:0050 為主 + 大跌那天拿 30% 去買候選、抱 h 天再換回 0050 vs 一直抱 0050 vs 同次數隨便挑日子(安慰劑)
//
// 跑法:
//   DATA_DIR=$S/d10n DIV=data/dividends_hist.json node --max-old-space-size=11000 scripts/dipleader_probe.mjs out.json
//   node scripts/dipleader_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCtx, prepStock, trendOk, mom, rng, DEF } from './leader_probe.mjs';
import { loadPx } from './lib_totalreturn.mjs';

export const HS = [1, 5, 10, 20, 40];
export const FEE = 0.001425, TAX = 0.003, COST = 2 * FEE + TAX;
export const EP_GAP = 20;
const limitOf = d => d < '2015-06-01' ? 0.07 : 0.10;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const r3 = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
const INJ = process.env.DL_INJECT || '';

// ───────── 大盤事件 ─────────
export function idxRet(tw) { const r = new Float64Array(tw.length).fill(NaN); for (let i = 1; i < tw.length; i++) r[i] = tw[i] / tw[i - 1] - 1; return r; }
/** 回 {name: Set(i)};ep = 每個事件屬於哪一段(段首的 i) */
export function events(ir) {
    const n = ir.length, E = { d2: [], d3: [], d2e1: [], d3k2: [], conf: [] }, ep = new Map();
    let last2 = -1e9, epStart = -1, last3 = -1e9, k3 = 0;
    for (let i = 1; i < n; i++) {
        const r = ir[i] * 100;
        if (r <= -2) {
            if (i - last2 > EP_GAP) { E.d2e1.push(i); epStart = i; k3 = 0; }
            last2 = i; E.d2.push(i); ep.set(i, epStart);
        }
        if (r <= -3) {
            E.d3.push(i); if (!ep.has(i)) ep.set(i, epStart);
            if (i - last3 <= EP_GAP) k3++; else k3 = 1;
            last3 = i;
            if (k3 >= 2) E.d3k2.push(i);
        }
    }
    // 止跌確認:前 3 天內有 ≥3% 的跌,今天第一次收紅
    for (let i = 4; i < n; i++) {
        if (!(ir[i] > 0)) continue;
        let had = -1; for (let j = i - 3; j < i; j++) if (ir[j] * 100 <= -3) had = j;
        if (had < 0) continue;
        let firstUp = true; for (let j = had + 1; j < i; j++) if (ir[j] > 0) firstUp = false;
        if (firstUp) { E.conf.push(i); if (!ep.has(i)) ep.set(i, ep.get(had) ?? had); }
    }
    return { E, ep };
}

/** 跌 ≥X% 的日子 + 波段(前 20 個交易日沒有 ≥X% 的跌 = 新的一段) */
export function dropEvents(ir, X) {
    const set = new Set(), ep = new Map(); let last = -1e9, st = -1;
    for (let i = 1; i < ir.length; i++) if (ir[i] * 100 <= -X) { if (i - last > EP_GAP) st = i; last = i; set.add(i); ep.set(i, st); }
    return { set, ep };
}
// ───────── 排名(同 leader_probe / fresh_fish 的 rankAt 預設路徑)─────────
export function rankAt(ctx, i, U = 100, L = 10) {
    const univ = [];
    for (const S of ctx.stocks) if (S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0) univ.push(S);
    univ.sort((a, b) => b.val20[i] - a.val20[i]);
    const u100 = univ.slice(0, U);
    const ok = u100.filter(S => trendOk(S, i, true));
    const ranked = ok.map(S => ({ S, m: mom(S, i, L) })).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m).map(x => x.S);
    return { ranked, ok, u100 };
}
const dayRet = (S, i) => i > 0 && S.C[i] > 0 && S.C[i - 1] > 0 && S.jump[i] !== i ? S.C[i] * S.F[i] / S.C[i - 1] - 1 : NaN;

/** 單檔報酬:entry 'c' = 第 i 天收盤買、'o' = 第 i+1 天開盤買;第 i+h 天收盤賣;扣成本。'lock' = 買不到 */
export function retOf(ctx, S, i, h, entry) {
    const n = ctx.cal.length, b = i + h; if (b >= n) return null;
    let px, from;
    if (entry === 'c') {
        if (!(S.C[i] > 0) || !(S.C[i - 1] > 0)) return null;
        if (S.C[i] * S.F[i] >= S.C[i - 1] * (1 + limitOf(ctx.cal[i]) - 0.003)) return 'lock';   // 收盤鎖漲停買不到
        px = S.C[i]; from = i + 1;
    } else {
        const a = i + 1; if (a >= n || !(S.O[a] > 0) || !(S.C[i] > 0)) return null;
        if (S.O[a] * S.F[a] >= S.C[i] * (1 + limitOf(ctx.cal[a]) - 0.003)) return 'lock';
        px = S.O[a]; from = a + 1;
    }
    if (!(S.C[b] > 0) || S.jump[b] > i) return null;
    let f = 1; for (let k = from; k <= b; k++) f *= S.F[k];
    if (INJ === 'peek' && entry === 'c') px = S.C[i - 1];     // 注入:拿前一天收盤當成交價(把當天跌幅算進報酬)
    return S.C[b] * f / px - 1 - COST;
}
function grp(ctx, list, i, h, entry) { const v = []; for (const S of list) { const r = retOf(ctx, S, i, h, entry); if (typeof r === 'number') v.push(r); } return v.length ? mean(v) : NaN; }
function bench(ctx, i, h, entry) {
    const tr = ctx.etf.tr, b = i + h; if (b >= tr.length) return NaN;
    if (entry === 'c') return tr[b] / tr[i] - 1;
    const o = ctx.b50o ? ctx.b50o[i + 1] : NaN;            // 0050 隔天開盤 / 隔天收盤
    return (Number.isFinite(o) ? o : 1) * tr[b] / tr[i + 1] - 1;
}

export const GROUPS = ['L5', 'L10', 'L5t', 'L10dn', 'POOL', 'U100', 'RShi', 'RSlo', 'UPDAY', 'ALL'];
/** 第 i 天每一組的名單 */
export function lists(ctx, i, cache) {
    const rk = k => { if (!cache.has(k)) cache.set(k, rankAt(ctx, k)); return cache.get(k); };
    const prev = rk(i - 1), cur = rk(i);
    const u = cur.u100.map(S => ({ S, r: dayRet(S, i) })).filter(x => Number.isFinite(x.r)).sort((a, b) => b.r - a.r);
    const L10 = prev.ranked.slice(0, 10), L10r = L10.map(S => ({ S, r: dayRet(S, i) })).filter(x => Number.isFinite(x.r)).sort((a, b) => a.r - b.r);
    const all = ctx.stocks.filter(S => S.C[i] > 0 && S.C[i - 1] > 0 && i - S.jump[i] > 120);
    return {
        L5: prev.ranked.slice(0, 5), L10, L5t: cur.ranked.slice(0, 5),
        L10dn: L10r.slice(0, Math.max(1, L10r.length >> 1)).map(x => x.S),
        POOL: prev.ok, U100: cur.u100, RShi: u.slice(0, 10).map(x => x.S), RSlo: u.slice(-10).map(x => x.S),
        UPDAY: u.filter(x => x.r > 0).map(x => x.S), ALL: all,
    };
}

/** 每一天 × 每一組 × h × 進場 的報酬表(平常日子也要,做雙重差分)
 *  DL_GROUPS=RSlo,U100 / DL_HS=20,40 只算那幾組那幾天(資金版補驗用;⛔ 不設 = 原本全部,輸出逐位相同) */
export function table(ctx, s0) {
    const n = ctx.cal.length, cache = new Map(), rows = [];
    const GS = process.env.DL_GROUPS ? process.env.DL_GROUPS.split(',') : GROUPS;
    const HH = process.env.DL_HS ? process.env.DL_HS.split(',').map(Number) : HS;
    for (let i = s0; i < n - 1; i++) {
        const Lz = lists(ctx, i, cache);
        if (Lz.L10.length < 10) continue;
        const row = { i, d: ctx.cal[i], g: {} };
        for (const g of GS) for (const e of ['c', 'o']) {
            if (g === 'L5t' && e === 'c') continue;                  // 當天收盤才排得出 → 只能隔天開盤
            for (const h of HH) row.g[`${g}|${e}|${h}`] = Lz[g].length ? grp(ctx, Lz[g], i, h, e) : NaN;
        }
        for (const e of ['c', 'o']) for (const h of HH) row.g[`0050|${e}|${h}`] = bench(ctx, i, h, e);
        if (cache.size > 6) for (const k of [...cache.keys()]) if (k < i - 2) cache.delete(k);
        rows.push(row);
    }
    return rows;
}

// ───────── 統計 ─────────
const normP = t => { const x = Math.abs(t) / Math.SQRT2; const tt = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * tt - 1.453152027) * tt) + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-x * x); return 1 - y; };   // 雙尾
export function bh(ps, q = 0.1) { const o = ps.map((p, k) => [p, k]).sort((a, b) => a[0] - b[0]); const m = ps.length; let cut = -1; o.forEach(([p], r) => { if (p <= q * (r + 1) / m) cut = r; }); const pass = new Set(o.slice(0, cut + 1).map(x => x[1])); return ps.map((_, k) => pass.has(k)); }

/** 一個(事件集 × key)的檢定:以波段為單位 */
export function judge(rows, evSet, ep, key) {
    const byI = new Map(rows.map(r => [r.i, r]));
    const evRows = [...evSet].map(i => byI.get(i)).filter(r => r && Number.isFinite(r.g[key]));
    if (evRows.length < 5) return { n: evRows.length };
    const base = rows.filter(r => !evSet.has(r.i) && Number.isFinite(r.g[key])).map(r => r.g[key]);
    const bm = mean(base);
    const bk = key.replace(/^[^|]+/, '0050');
    // 波段平均
    const E = new Map(); for (const r of evRows) { const k = ep.get(r.i) ?? r.i; (E.get(k) || E.set(k, []).get(k)).push(r); }
    const epV = [...E.values()].map(a => ({ d: a[0].d, v: mean(a.map(r => r.g[key])) - bm, raw: mean(a.map(r => r.g[key])), vs: mean(a.map(r => r.g[key] - r.g[bk]).filter(Number.isFinite)) }));
    const m = mean(epV.map(e => e.v)), sd = Math.sqrt(mean(epV.map(e => (e.v - m) ** 2))), t = m / (sd / Math.sqrt(epV.length) || 1);
    const half = epV[epV.length >> 1].d, A = epV.filter(e => e.d < half), B = epV.filter(e => e.d >= half);
    const yr = {}; epV.forEach(e => (yr[e.d.slice(0, 4)] = yr[e.d.slice(0, 4)] || []).push(e.v));
    const ym = Object.entries(yr).map(([y, a]) => [y, mean(a)]);
    const best = ym.slice().sort((a, b) => b[1] - a[1])[0];
    const noBest = epV.filter(e => !e.d.startsWith(best[0])).map(e => e.v);
    const raw = mean(epV.map(e => e.raw)), vs = mean(epV.map(e => e.vs).filter(Number.isFinite));
    const g = { '增量t≥2': m > 0 && t >= 2, 前後半同向: mean(A.map(e => e.v)) > 0 && mean(B.map(e => e.v)) > 0, 去最好年: mean(noBest) > 0,
        扣成本絕對: raw > 0, 贏0050: vs > 0, 逐年六成: ym.filter(x => x[1] > 0).length >= 0.6 * ym.length };
    return { n: evRows.length, ep: epV.length, inc: r3(m * 100), t: +t.toFixed(2), p: normP(t), raw: r3(raw * 100), base: r3(bm * 100), vs0050: r3(vs * 100),
        A: r3(mean(A.map(e => e.v)) * 100), B: r3(mean(B.map(e => e.v)) * 100), yrPos: `${ym.filter(x => x[1] > 0).length}/${ym.length}`, gates: g, pass: Object.values(g).filter(Boolean).length };
}

// ───────── (B) 跌停 → 隔天紅K → 再隔天開盤買 ─────────
export function ldRed(ctx, ir, s0, X = 2, H = 20, cache = new Map()) {
    const n = ctx.cal.length, out = { hot: [], cold: [], hotN: [], coldN: [] };
    for (let i = s0; i + 2 + H - 1 < n; i++) {
        const big = ir[i] * 100 <= -X;
        let u100 = null;
        for (const S of ctx.stocks) {
            const r = dayRet(S, i); if (!(r <= -(limitOf(ctx.cal[i]) - 0.008))) continue;
            const r1 = dayRet(S, i + 1); if (!(r1 >= 0.03)) continue;
            const a = i + 2, b = a + H - 1; if (!(S.O[a] > 0 && S.C[b] > 0) || S.jump[b] > i) continue;
            if (S.O[a] * S.F[a] >= S.C[i + 1] * (1 + limitOf(ctx.cal[a]) - 0.003)) continue;
            let f = 1; for (let k = a + 1; k <= b; k++) f *= S.F[k];
            const v = S.C[b] * f / S.O[a] - 1 - COST;
            const bm = ctx.etf.tr[b] / ctx.etf.tr[i + 1] - 1;
            if (!u100) { if (!cache.has(i)) cache.set(i, new Set(rankAt(ctx, i - 1).u100)); u100 = cache.get(i); }
            const hot = u100.has(S);
            (big ? (hot ? out.hot : out.cold) : (hot ? out.hotN : out.coldN)).push({ d: ctx.cal[i], v, x: v - bm });
        }
    }
    const sum = a => a.length ? { n: a.length, net: r3(mean(a.map(e => e.v)) * 100), vs0050: r3(mean(a.map(e => e.x)) * 100), win: r3(a.filter(e => e.v > 0).length / a.length * 100) } : { n: 0 };
    return { big_hot: sum(out.hot), big_cold: sum(out.cold), norm_hot: sum(out.hotN), norm_cold: sum(out.coldN) };
}

// ───────── (C) 0050 為主 + 大跌那天 30% 換成候選 ─────────
export function overlay(rows, evSet, key, W = 0.3, seed = 3) {
    const h = +key.split('|')[2], bk = key.replace(/^[^|]+/, '0050');
    const run = days => { let v = 1, busy = -1, k = 0; const idx = rows; for (let j = 0; j < idx.length; j++) { const r = idx[j]; if (j <= busy) continue; if (days.has(r.i) && Number.isFinite(r.g[key]) && Number.isFinite(r.g[bk])) { v *= 1 + W * (r.g[key] - r.g[bk] - 0.0024); busy = j + h - 1; k++; } } return { v, k }; };
    const real = run(evSet);
    const R = rng(seed + h), pool = rows.map(r => r.i), sims = [];
    for (let s = 0; s < 300; s++) { const set = new Set(); while (set.size < evSet.size) set.add(pool[Math.floor(R() * pool.length)]); sims.push(run(set).v); }
    sims.sort((a, b) => a - b);
    return { extra: r3((real.v - 1) * 100), trades: real.k, shamMed: r3((sims[150] - 1) * 100), pct: r3(sims.filter(x => x < real.v).length / sims.length * 100) };
}

// ───────── (D) 資金版補驗(V82):照 App 真的會怎麼做 ─────────
/** 0050 為主,觸發日拿 W 換成候選、隔天開盤買、第 h 天收盤賣;回 {v, k, trades}
 *  policy:'one'   = 同時只抱一批(抱著時再觸發不買 = overlay;⭐ 事先登記的主判準 = 現行規則)
 *          'each'  = 每次觸發都開一批,每批 W/maxB,同時最多 maxB 批(三批合計 = W)
 *          'first' = 每一段只做第一次(dropEvents 的段起點那天)
 *  x = 候選 − 0050 − 0050 來回 0.24% − xc(成本 ×2 用)
 *  批次佔用照「日曆索引」:第 i 天觸發那批在 i+h 收盤賣完 → 第 t 天再觸發要 i+h ≤ t(跟 overlay 一樣) */
export function money(rows, evSet, key, opt = {}) {
    const W = opt.W ?? 0.3, policy = opt.policy || 'one', maxB = opt.maxB ?? 3, xc = opt.xc ?? 0, ep = opt.ep || null;
    const h = +key.split('|')[2], bk = key.replace(/^[^|]+/, '0050');
    let v = 1, open = []; const trades = [];
    for (const r of rows) {
        if (!evSet.has(r.i)) continue;
        if (policy === 'first' && ep && ep.get(r.i) !== r.i) continue;
        open = open.filter(end => end > r.i);
        if (policy === 'each' ? open.length >= maxB : open.length > 0) continue;
        const a = r.g[key], b = r.g[bk]; if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const w = policy === 'each' ? W / maxB : W, x = a - b - 0.0024 - xc;
        v *= 1 + w * x; open.push(r.i + h); trades.push({ d: r.d, x, w });
    }
    return { v, k: trades.length, trades };
}
/** 資金版矩陣:候選 × 門檻 × 重疊規則 → 16 年多幾 %、逐年、拿掉 2026 / 最好那年、成本 ×2、同次數隨便挑日子(安慰劑) */
export function moneyReport(rows, ir, s0, cal, opt = {}) {
    const out = [], pool = rows.map(r => r.i);
    for (const key of opt.keys || ['RSlo|o|20', 'RSlo|o|40', 'U100|o|20']) for (const X of opt.xs || [2.5, 3, 3.5, 4]) {
        if (!rows.some(r => Number.isFinite(r.g[key]))) continue;
        const D = dropEvents(ir, X), set = new Set([...D.set].filter(i => i >= s0));
        for (const policy of ['one', 'each', 'first']) {
            const run = (S, o = {}) => money(rows, S, key, { policy, ep: D.ep, ...o });
            const base = run(set);
            if (!base.k) { out.push({ key, X, policy, k: 0 }); continue; }
            const yr = {}; for (const t of base.trades) { const y = t.d.slice(0, 4); yr[y] = (yr[y] ?? 1) * (1 + t.w * t.x); }
            const ys = Object.entries(yr).map(([y, f]) => [y, f - 1]);
            const best = ys.slice().sort((a, b) => b[1] - a[1])[0][0];
            const sub = f => run(new Set([...set].filter(i => f(cal[i]))));
            const no26 = sub(d => d < '2026'), noBest = sub(d => !d.startsWith(best)), c2 = run(set, { xc: COST + 0.0024 });
            // 安慰劑:同樣多次的觸發日從全部日子隨便挑(first = 段數)
            const nTrig = policy === 'first' ? [...set].filter(i => D.ep.get(i) === i).length : set.size;
            const R = rng(7 + Math.round(X * 10)), sims = [];
            for (let s = 0; s < 300; s++) { const S = new Set(); while (S.size < Math.min(nTrig, pool.length)) S.add(pool[Math.floor(R() * pool.length)]); sims.push(money(rows, S, key, { policy: policy === 'first' ? 'one' : policy }).v); }
            sims.sort((a, b) => a - b);
            const half = base.trades.length >> 1, prod = a => a.reduce((v, t) => v * (1 + t.w * t.x), 1) - 1;
            out.push({ key, X, policy, k: base.k, extra: r3((base.v - 1) * 100), h1: r3(prod(base.trades.slice(0, half)) * 100), h2: r3(prod(base.trades.slice(half)) * 100), yrPos: `${ys.filter(y => y[1] > 0).length}/${ys.length}`, yrN: ys.length, yrUp: ys.filter(y => y[1] > 0).length,
                yrs: ys.map(([y, v]) => [y, r3(v * 100)]), no2026: r3((no26.v - 1) * 100), noBest: r3((noBest.v - 1) * 100), best, cost2: r3((c2.v - 1) * 100),
                shamMed: r3((sims[150] - 1) * 100), pct: r3(sims.filter(x => x < base.v).length / sims.length * 100), trades: base.trades.map(t => [t.d, r3(t.x * 100)]) });
        }
    }
    return out;
}
/** 事先登記的過關條件(計畫 A1):主判準 key=RSlo|o|20、policy=one;中心 3% 與左右一格(2.5 / 3.5)都贏一直放 0050、逐年 ≥6 成 */
export function moneyGate(rep, key = 'RSlo|o|20', policy = 'one') {
    const at = X => rep.find(r => r.key === key && r.policy === policy && r.X === X);
    const a = at(2.5), b = at(3), c = at(3.5);
    const g = { '2.5%贏0050': !!a && a.extra > 0, '3%贏0050': !!b && b.extra > 0, '3.5%贏0050': !!c && c.extra > 0, '逐年六成': !!b && b.yrN > 0 && b.yrUp >= 0.6 * b.yrN };
    return { key, policy, gates: g, pass: Object.values(g).every(Boolean) };
}

// ───────── selftest ─────────
function synth(opt = {}) {
    const nDay = 400, cal = []; for (let k = 0; k < nDay; k++) cal.push(new Date(Date.UTC(2023, 0, 2) + k * 864e5).toISOString().slice(0, 10));
    const tw = []; let p = 100; const drops = new Set(opt.drops || [200, 260, 262, 320]);
    for (let k = 0; k < nDay; k++) { p *= drops.has(k) ? 0.965 : (k === 263 ? 1.01 : 1.0004); tw.push(p); }
    const stocks = [];
    for (let s = 0; s < 40; s++) {
        const rows = []; let c = 50 + s;
        for (let k = 0; k < nDay; k++) {
            let g = 0.0006 + s * 0.0001 + ((k * 7 + s * 3) % 5 - 2) * 0.002;
            if (drops.has(k)) g = -0.04;
            if (opt.inject && s >= 30 && [...drops].some(d => k > d && k <= d + 5)) g += 0.01;   // 注入:強的那幾檔大跌後 5 天每天 +1%
            const o = c; c *= 1 + g; rows.push({ d: cal[k], o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1000 + s * 80 });
        }
        stocks.push(prepStock(String(1100 + s), rows, cal, []));
    }
    return { ctx: { cal, stocks, etf: { tr: Float64Array.from(tw.map(x => x / tw[0])) } }, tw };
}
function selftest() {
    let fail = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fail++; };
    const { ctx, tw } = synth(), ir = idxRet(tw), { E, ep } = events(ir);
    ok(E.d3.length === 4 && E.d2e1.length === 3, `① 跌 ≥3% 4 天、波段 3 段(${E.d3.length}/${E.d2e1.length})`);
    ok(E.d3k2.length === 1 && E.d3k2[0] === 262, `② 同一段第二次 ≥3% = 262(${E.d3k2})`);
    ok(E.conf.includes(263) && !E.conf.includes(264), `③ 止跌確認 = 263(第一次收紅;${E.conf})`);
    ok(ep.get(262) === 260, '④ 262 屬於 260 那一段');
    // ⑤ 零前視:排名用前一天
    const cache = new Map(), Lz = lists(ctx, 300, cache);
    const save = ctx.stocks.map(S => [S.C[300], S.A[300]]);
    ctx.stocks.forEach((S, k) => { if (k < 5) { S.C[300] *= 3; S.A[300] *= 3; } });
    const Lz2 = lists(ctx, 300, new Map());
    ok(Lz.L5.map(S => S.sym).join() === Lz2.L5.map(S => S.sym).join(), '⑤ 今天前 5 名用前一天排(當天價格 ×3 不影響)');
    ctx.stocks.forEach((S, k) => { [S.C[300], S.A[300]] = save[k]; });
    // ⑥ 收盤進場不含當天跌幅
    const S0 = ctx.stocks[0], i = 200, r = retOf(ctx, S0, i, 1, 'c');
    ok(Math.abs(r - (S0.C[201] / S0.C[200] - 1 - COST)) < 1e-12, '⑥ 尾盤買:報酬從當天收盤起算(不含當天 −4%)');
    // ⑦ 收盤鎖漲停買不到
    const sv = S0.C[150]; S0.C[150] = S0.C[149] * 1.1; ok(retOf(ctx, S0, 150, 1, 'c') === 'lock', '⑦ 收盤鎖漲停 = 買不到'); S0.C[150] = sv;
    // ⑧ 注入 → 雙重差分量得到;沒注入 ≈ 0
    const DR = [150, 175, 200, 225, 250, 275, 300, 325, 350, 375];
    const A1 = synth({ inject: true, drops: DR }), A0 = synth({ drops: DR });
    const t1 = table(A1.ctx, 140), t0 = table(A0.ctx, 140), e1 = events(idxRet(A1.tw));
    const j1 = judge(t1, new Set(e1.E.d3), e1.ep, 'ALL|c|5'), j0 = judge(t0, new Set(e1.E.d3), e1.ep, 'ALL|c|5');
    const dd = j1.inc - j0.inc;
    ok(dd > 0.8 && dd < 1.6, `⑧ 注入(1/4 的股票大跌後 5 天每天 +1%)→ 全部股票增量多 ≈1pp(平常日子也有一部分吃到注入)(${dd.toFixed(2)})`);
    const jL = judge(t1, new Set(e1.E.d3), e1.ep, 'RShi|c|5'), jL0 = judge(t0, new Set(e1.E.d3), e1.ep, 'RShi|c|5');
    ok(Number.isFinite(jL.inc) && Number.isFinite(jL0.inc), `⑨ 分組也算得出來(最抗跌組 ${jL.inc} / ${jL0.inc})`);
    // ⑪ BH
    const b = bh([0.001, 0.2, 0.04, 0.5], 0.1); ok(b[0] && !b[1] && b[2] && !b[3], '⑪ BH 校正');
    // ⑫ 資金版:同時只抱一批 == overlay(決定性對照:兩份寫法同一個數字)
    { const ov = overlay(t1, new Set(DR), 'ALL|c|20'), m1 = money(t1, new Set(DR), 'ALL|c|20', { policy: 'one' });
      ok(r3((m1.v - 1) * 100) === ov.extra && m1.k === ov.trades, `⑫ 同時只抱一批 == overlay(${r3((m1.v - 1) * 100)} / ${ov.extra},${m1.k} / ${ov.trades} 次)`); }
    // ⑬ 重疊規則:200 / 205 / 210 / 230 觸發、抱 20 天
    { const S = new Set([200, 205, 210, 230]), epM = new Map([[200, 200], [205, 200], [210, 200], [230, 230]]);
      const one = money(t1, S, 'ALL|c|20', { policy: 'one' }), each = money(t1, S, 'ALL|c|20', { policy: 'each' }), first = money(t1, S, 'ALL|c|20', { policy: 'first', ep: epM });
      ok(one.k === 2 && one.trades.map(t => t.d).join() === [t1.find(r => r.i === 200).d, t1.find(r => r.i === 230).d].join(), `⑬a 只抱一批:200 買、205 / 210 抱著不買、230(200+20)可以再買(${one.k} 次)`);
      ok(each.k === 4 && each.trades.every(t => Math.abs(t.w - 0.1) < 1e-12), `⑬b 每次一批:三批同時 + 230 那批(上一批 220 已賣)、每批 1 成(${each.k} 次)`);
      ok(first.k === 2, `⑬c 每段第一次:200 與 230(${first.k} 次)`);
      const cap = money(t1, new Set([200, 201, 202, 203]), 'ALL|c|20', { policy: 'each' }); ok(cap.k === 3, `⑬d 同時最多 3 批(第 4 次不買;${cap.k})`); }
    // ⑭ 注入 → 資金版多賺;沒注入 → 差不多(決定性對照)
    { const v1 = money(t1, new Set(DR), 'ALL|c|5').v, v0 = money(t0, new Set(DR), 'ALL|c|5').v, dv = (v1 - v0) * 100;
      ok(dv > 2 && dv < 6, `⑭ 注入(1/4 股票大跌後 5 天每天 +1%)→ 0050 為主 + 3 成換過去多 ≈3.75%(${dv.toFixed(2)})`); }
    // ⑮ 過關條件:合成報告剛好一格是負的 → 不過
    { const fake = [2.5, 3, 3.5].map(X => ({ key: 'RSlo|o|20', policy: 'one', X, extra: X === 2.5 ? -1 : 2, yrN: 10, yrUp: 7 }));
      ok(!moneyGate(fake).pass && moneyGate(fake.map(r => ({ ...r, extra: 2 }))).pass, '⑮ 過關條件:2.5% 那格是負的就不過;三格都正 + 逐年 7/10 才過'); }
    console.log(fail ? `❌ ${fail} 條沒過` : '✅ 全部通過'); return fail ? 1 : 0;
}

// ───────── main ─────────
function main() {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const DATA = process.env.DATA_DIR; if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, process.env.DIV);
    const twR = loadPx(DATA, '^TWII'); const tmap = new Map(twR.map(x => [x.d, x.c]));
    const tw = ctx.cal.map(d => tmap.get(d));
    if (tw.some(x => !(x > 0))) { console.error('🚨 加權日曆對不上'); process.exit(1); }
    // 0050 開盤 ÷ 收盤(隔天開盤買的 0050 對照)
    const p50 = path.join(DATA, '0050.json'), idx = new Map(ctx.cal.map((d, i) => [d, i]));
    ctx.b50o = new Float64Array(ctx.cal.length).fill(NaN);
    if (fs.existsSync(p50)) for (const r of JSON.parse(fs.readFileSync(p50, 'utf8'))) { const k = idx.get(String(r.date).replace(/\//g, '-').slice(0, 10)); if (k !== undefined && +r.open > 0 && +r.close > 0) ctx.b50o[k] = +r.open / +r.close; }
    const ir = idxRet(tw), { E, ep } = events(ir);
    const FROM = process.env.FROM || '2011-01-03';
    const s0 = Math.max(130, ctx.cal.findIndex(d => d >= FROM));
    console.log(`📂 ${ctx.stocks.length} 檔 ・${ctx.cal[s0]} ~ ${ctx.cal.at(-1)} ・事件 ${Object.entries(E).map(([k, v]) => `${k} ${v.filter(i => i >= s0).length}`).join(' ・')}`);
    const rows = table(ctx, s0);
    console.log(`⏱️ 報酬表 ${rows.length} 天(${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    if (process.env.DL_MONEY === '1') {                       // (D) 資金版補驗:跑完就結束(⛔ 不跑後面的全表)
        const rep = moneyReport(rows, ir, s0, ctx.cal, process.env.DL_KEYS ? { keys: process.env.DL_KEYS.split(',') } : {});
        console.log('\n━━ (D) 資金版:0050 為主、加權收盤跌 ≥X% 那天拿 3 成換過去(隔天開盤買、抱 h 天)vs 一直放 0050 ━━');
        for (const r of rep) console.log(r.k ? `  ${r.key.padEnd(10)} ≥${String(r.X).padEnd(3)}% ${r.policy.padEnd(5)} 多 ${String(r.extra).padStart(7)}%(${String(r.k).padStart(2)} 次)・前/後半 ${r.h1}/${r.h2}% ・逐年 ${r.yrPos} ・拿掉2026 ${r.no2026}% ・拿掉最好年(${r.best}) ${r.noBest}% ・成本×2 ${r.cost2}% ・隨便挑日子中位 ${r.shamMed}% 贏 ${r.pct}%` : `  ${r.key} ≥${r.X}% ${r.policy} 0 次`);
        const c = rep.find(r => r.key === 'RSlo|o|20' && r.X === 3 && r.policy === 'one');
        if (c && c.k) { console.log('\n  主判準那一格(≥3%・只抱一批・抱 20 天)每一筆(超額 %):'); for (const [d, x] of c.trades) console.log(`    ${d} ${x}`); console.log('  逐年:' + c.yrs.map(([y, v]) => `${y} ${v}%`).join(' ・')); }
        const gate = moneyGate(rep);
        console.log(`\n${gate.pass ? '✅ 資金版過關' : '⛔ 資金版沒過'}(事先登記:RSlo・隔天開盤・抱 20 天・只抱一批;2.5 / 3 / 3.5% 都贏一直放 0050 + 逐年 ≥6 成):${Object.entries(gate.gates).map(([k, v]) => `${k} ${v ? '✓' : '✗'}`).join(' ・')}`);
        if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ from: ctx.cal[s0], to: ctx.cal.at(-1), money: rep, gate }, null, 1));
        console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
        return;
    }
    const res = [];
    for (const [ek, ev] of Object.entries(E)) {
        const set = new Set(ev.filter(i => i >= s0));
        for (const g of GROUPS) for (const e of ['c', 'o']) for (const h of HS) {
            if (g === 'L5t' && e === 'c') continue;
            const key = `${g}|${e}|${h}`, j = judge(rows, set, ep, key);
            if (j.n >= 5) res.push({ ev: ek, g, e, h, ...j });
        }
    }
    const pass = bh(res.map(r => r.p), 0.1); res.forEach((r, k) => { r.bh = pass[k]; });
    const fmt = r => `${r.ev.padEnd(5)} ${r.g.padEnd(6)} ${r.e === 'c' ? '尾盤' : '隔開'} ${String(r.h).padStart(2)}天 n${String(r.n).padStart(4)}/${String(r.ep).padStart(3)}段 扣成本 ${String(r.raw).padStart(7)}% 平常 ${String(r.base).padStart(7)}% 增量 ${String(r.inc).padStart(7)}pp t ${String(r.t).padStart(5)} vs0050 ${String(r.vs0050).padStart(7)} 前/後 ${r.A}/${r.B} 年 ${r.yrPos} 關 ${r.pass}/6${r.bh ? ' BH✓' : ''}`;
    console.log('\n━━ 使用者問的:👑 前 5 / 前 10(尾盤買 = 白天看到的名單)━━');
    for (const r of res.filter(r => ['L5', 'L10', 'L5t'].includes(r.g) && ['d2', 'd3', 'd3k2', 'conf'].includes(r.ev) && [5, 10, 20].includes(r.h))) console.log(fmt(r));
    console.log('\n━━ 全部組合裡過 ≥5 關的(依增量排序)━━');
    for (const r of res.filter(r => r.pass >= 5).sort((a, b) => b.inc - a.inc).slice(0, 40)) console.log(fmt(r));
    console.log(`\n六關全過 ${res.filter(r => r.pass === 6).length} / ${res.length} 組 ・BH 過 ${res.filter(r => r.bh).length} 組`);
    console.log('\n━━ (B) 大盤跌 ≥2% 那天跌停 → 隔天收紅 ≥3% → 再隔天開盤買、抱 20 天 ━━');
    const B = ldRed(ctx, ir, s0, 2, 20); for (const [k, v] of Object.entries(B)) console.log(`  ${k.padEnd(10)} n ${v.n} ・扣成本 ${v.net}% ・vs0050 ${v.vs0050}pp ・賺的 ${v.win}%`);
    console.log('\n━━ (C) 0050 為主、大跌那天 30% 換成候選抱 h 天(多賺幾 % vs 安慰劑)━━');
    const top = res.filter(r => r.pass >= 5).sort((a, b) => b.inc - a.inc).slice(0, 8);
    const OV = [];
    for (const r of [...top, ...res.filter(r => ['L5', 'L10'].includes(r.g) && r.ev === 'd2' && r.e === 'c' && [10, 20].includes(r.h))]) {
        const o = overlay(rows, new Set(E[r.ev].filter(i => i >= s0)), `${r.g}|${r.e}|${r.h}`); OV.push({ ev: r.ev, key: `${r.g}|${r.e}|${r.h}`, ...o });
        console.log(`  ${r.ev.padEnd(5)} ${r.g}|${r.e}|${r.h}:16 年多 ${o.extra}%(${o.trades} 次)・同次數隨便挑日子中位 ${o.shamMed}% ・贏過 ${o.pct}% 的安慰劑`);
    }
    // ━━ 穩健度:門檻高原 + 跟「熱門股全部」比 + 每一段列出來(最差那段)━━
    for (const r of rows) for (const e of ['c', 'o']) for (const h of [10, 20]) {
        for (const g of ['RSlo', 'L5', 'L10', 'L10dn']) { const a = r.g[`${g}|${e}|${h}`], b = r.g[`U100|${e}|${h}`]; r.g[`${g}-U100|${e}|${h}`] = Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN; }
    }
    const DET = { plateau: [], vsHot: [], episodes: {} };
    console.log('\n━━ 門檻高原(加權跌 ≥X%,尾盤買 / 隔天開盤買,抱 20 天;增量 pp・t・段數)━━');
    for (const key of ['U100|c|20', 'RSlo|c|20', 'RSlo|o|20', 'L5|c|20', 'L10|c|20', 'L10dn|c|20', 'ALL|c|20', '0050|c|20', 'U100|c|10', 'RSlo|o|10']) {
        const line = [];
        for (const X of [2, 2.5, 3, 3.5, 4]) { const D = dropEvents(ir, X), set = new Set([...D.set].filter(i => i >= s0)); const j = judge(rows, set, D.ep, key); line.push(j.n >= 5 ? `≥${X}%: ${j.inc}pp t${j.t} ${j.ep}段 ${j.pass}關` : `≥${X}%: n${j.n}`); DET.plateau.push({ key, X, ...j }); }
        console.log(`  ${key.padEnd(11)} ${line.join(' ・')}`);
    }
    console.log('\n━━ 挑法本身有沒有比「熱門股全部」好(同一天相減,跌 ≥3%)━━');
    for (const key of ['RSlo-U100|c|20', 'RSlo-U100|o|20', 'L5-U100|c|20', 'L10-U100|c|20', 'L10dn-U100|o|20', 'RSlo-U100|o|10']) {
        const D = dropEvents(ir, 3), set = new Set([...D.set].filter(i => i >= s0)), j = judge(rows, set, D.ep, key);
        DET.vsHot.push({ key, ...j }); console.log(`  ${key.padEnd(16)} 大跌日 ${j.raw}pp(平常 ${j.base}pp)・增量 ${j.inc}pp t ${j.t} ・前/後 ${j.A}/${j.B} ・年 ${j.yrPos}`);
    }
    console.log('\n━━ 跌 ≥3% 每一段(同一段平均;0050 同期)━━');
    { const D = dropEvents(ir, 3), byEp = new Map();
      for (const i of D.set) if (i >= s0) { const r = rows.find(x => x.i === i); if (!r) continue; const k = D.ep.get(i); (byEp.get(k) || byEp.set(k, []).get(k)).push(r); }
      const K = ['U100|c|20', 'RSlo|c|20', 'L5|c|20', '0050|c|20'];
      DET.episodes = [...byEp.entries()].map(([k, a]) => ({ d: ctx.cal[k], n: a.length, ...Object.fromEntries(K.map(x => [x, r3(mean(a.map(r => r.g[x]).filter(Number.isFinite)) * 100)])) }));
      for (const e of DET.episodes) console.log(`  ${e.d}(${e.n} 天)熱門股 ${e['U100|c|20']}% ・跌最多 10 檔 ${e['RSlo|c|20']}% ・👑前5 ${e['L5|c|20']}% ・0050 ${e['0050|c|20']}%`);
      const w = K.map(x => [x, Math.min(...DET.episodes.map(e => e[x]).filter(Number.isFinite))]); console.log('  最差那一段:' + w.map(([x, v]) => `${x.split('|')[0]} ${v}%`).join(' ・'));
    }
    console.log('\n━━ 跌 ≥3%:大盤當時是不是已經在空頭(收盤 < 60 日線且 20 日線 < 60 日線)━━');
    DET.bear = [];
    { const D = dropEvents(ir, 3);
      for (const [nm, f] of [['已經在空頭', i => ctx.bear[i] === 1], ['還不是空頭', i => ctx.bear[i] !== 1]]) {
        const set = new Set([...D.set].filter(i => i >= s0 && f(i)));
        for (const key of ['U100|c|20', 'RSlo|o|20', 'L5|c|20', '0050|c|20', 'U100|c|40']) { const j = judge(rows, set, D.ep, key); DET.bear.push({ nm, key, ...j }); console.log(`  ${nm} ${key.padEnd(10)} ${j.n >= 5 ? `n${j.n}/${j.ep}段 扣成本 ${j.raw}% 增量 ${j.inc}pp t ${j.t} vs0050 ${j.vs0050}` : `n${j.n}`}`); }
      } }
    console.log('\n━━ 抱 40 天(跌 ≥3%)━━');
    { const D = dropEvents(ir, 3), set = new Set([...D.set].filter(i => i >= s0));
      for (const key of ['U100|c|40', 'RSlo|o|40', 'L5|c|40', 'L10|c|40', 'ALL|c|40', '0050|c|40']) { const j = judge(rows, set, D.ep, key); console.log(`  ${key.padEnd(10)} 扣成本 ${j.raw}% 平常 ${j.base}% 增量 ${j.inc}pp t ${j.t} vs0050 ${j.vs0050} 前/後 ${j.A}/${j.B} 年 ${j.yrPos} 關 ${j.pass}/6`); } }
    console.log('\n━━ (C2) 0050 為主、加權跌 ≥X% 那天拿 30% 換成候選抱 20 天 ━━');
    DET.ov = [];
    for (const X of [2.5, 3, 3.5]) { const D = dropEvents(ir, X), set = new Set([...D.set].filter(i => i >= s0));
      for (const key of ['U100|c|20', 'RSlo|o|20', 'L5|c|20', 'L10|c|20']) { const o = overlay(rows, set, key); DET.ov.push({ X, key, ...o }); console.log(`  ≥${X}% ${key.padEnd(10)} 16 年多 ${o.extra}%(${o.trades} 次)・隨便挑日子中位 ${o.shamMed}% ・贏過 ${o.pct}% 安慰劑`); } }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ from: ctx.cal[s0], to: ctx.cal.at(-1), events: Object.fromEntries(Object.entries(E).map(([k, v]) => [k, v.filter(i => i >= s0).length])), res, B, OV, DET }, null, 1));
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
