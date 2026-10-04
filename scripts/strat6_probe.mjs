#!/usr/bin/env node
/**
 * 🧪 V78.4.6 使用者給的六套完整策略(S1~S5 + 3D-TRB)整套回測
 *   使用者:「上述有沒有價值,去回測,有用一樣依照我的習慣做」
 *
 * ⭐ 先查登記表(零件多半已測過沒用):48 指標(含 ADX / VWAP / 凱特納)六關 0 過(indicator_zoo)・
 *   OBV 五種 0 過(obv_probe)・布林壓縮突破進場三次驗證為負(strat_probe A / kobo / pdf_daytrade)・
 *   盤整突破 × OBV 0/108(squeeze_obv_probe)・背離 C 級(_SIGNAL_EDGE)。
 *   🆕 沒測過的是「整套規則(進場 + 他指定的出場)」與四個出場零件(+1.5ATR 移到成本 / 吊燈 2.5 倍 /
 *   上彎 20 日線不出場 / OBV 背離減半)。
 *
 * 進場 = 訊號日收盤(V72.9.0 尾盤);收盤鎖漲停剔除;20 日均額 ≥ 3,000 萬;同一檔持有中不重複進場。
 * 所有「前 N 日最高 / 均量」基準 ⛔ 不含被判斷那根(陷阱 #43)。指標一律 lib_indicators.seriesFor(⛔ 不另寫)。
 * 出場:(a) 他指定的那套(收盤判斷 → 收盤價成交;S5 停利用限價 = max(開盤, 目標))
 *       (b) 現行 🔥 吊燈 ATR 2 倍・最長 20 天(lib_exitsim atr2,stopFill close)—— 拆開「進場有沒有用」與「出場有沒有用」
 * 報酬:扣成本 0.44% 再扣同期加權(超額)。
 * 對照:BASE 同一批股票隨機日子(同一套出場;≈5% 的股·日,固定種子)= 「隨便哪天買」
 *       LOOSE 拿掉一層條件(每套各自定義)= 那一層有沒有加分
 * 六關(cmp,同 squeeze_obv_probe):全期 > 0 / 前後半 / 逐年 70% / 拿掉最好年 / 扣成本絕對 > 0 / p ≤ 0.05
 * 高原:每套 2 個參數 × 3 格。另外四個出場零件套在同一批「創 60 日新高」事件上,跟 atr2 配對比。
 *
 * 跑法:DATA_DIR=<合併過深歷史> node --max-old-space-size=10000 scripts/strat6_probe.mjs out.json
 *       node scripts/strat6_probe.mjs --selftest
 * ⛔ 只讀、不打 API。exit 0。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seriesFor, EMA, SMA, anchoredVwap } from './lib_indicators.mjs';
import { simExits } from './lib_exitsim.mjs';
import { cmp } from './squeeze_obv_probe.mjs';

const COST = 0.44, LIQ_MIN = 3e7, WARM = 260, MAXD = 120, BASE_P = 0.05;
const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const r2 = x => Math.round(x * 100) / 100;
const sdv = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

// ═══ 共用小工具(全部只看 ≤ t 的資料)═══
const maxPrev = (a, t, K) => { let m = -Infinity; for (let k = t - K; k < t; k++) if (a[k] > m) m = a[k]; return m; };   // ⛔ 不含 t
const minPrev = (a, t, K) => { let m = Infinity; for (let k = t - K; k < t; k++) if (a[k] < m) m = a[k]; return m; };
const avgPrev = (a, t, K) => { let s = 0; for (let k = t - K; k < t; k++) s += a[k]; return s / K; };

/** 20 日線扣抵值低:未來 k 天要被扣掉的那幾根(c[t−N+1 .. t−N+k])平均 < 今天收盤 → 均線接下來會往上(⛔ 只用過去) */
export function koudiLow(C, t, N, k) { let s = 0; for (let q = t - N + 1; q <= t - N + k; q++) s += C[q]; return s / k < C[t]; }

/** 底背離(⛔ 前視:轉折低點要等右邊 W 根都比它高才確認 → 第 t 根只看得到 j ≤ t − W 的低點)
 *  回 { low, j } 或 null:最近兩個確認低點 p1 < p2,低[p2] < 低[p1] 且 osc[p2] > osc[p1],p2 落在近 look 根內,
 *  而且 低[p2] 是它之前 20 根的新低 */
export function bullDiv(L, osc, t, { W = 3, look = 20 } = {}) {
    const piv = [];
    for (let j = t - W; j >= Math.max(W, t - 60) && piv.length < 2; j--) {
        let isP = true; for (let q = j - W; q <= j + W; q++) if (q !== j && L[q] <= L[j]) { isP = false; break; }
        if (isP) piv.push(j);
    }
    if (piv.length < 2) return null;
    const [p2, p1] = piv;
    if (t - p2 > look || !(L[p2] < L[p1]) || osc[p2] == null || osc[p1] == null || !(osc[p2] > osc[p1])) return null;
    if (!(L[p2] <= minPrev(L, p2, 20))) return null;
    return { low: L[p2], j: p2 };
}

// ═══ 進場(每一套一個函式;p = 參數)═══
export const ENTRY = {
    // S1 帶量突破動能:帶寬在近 60 日最低 q% ∧ 收盤 > 前 K 日最高收盤 ∧ OBV > 其 20MA 且創 20 日高
    S1: (X, t, p) => {
        const { C, S } = X; if (!(C[t] > maxPrev(C, t, p.K))) return false;
        if (p.noSq !== true) { const w = []; for (let k = t - 60; k < t; k++) if (S.bbw[k] != null) w.push(S.bbw[k]); if (w.length < 40) return false;
            const lowest = w.slice().sort((a, b) => a - b)[Math.floor(w.length * p.q)]; if (!(S.bbw[t - 1] <= lowest)) return false; }
        if (p.noObv !== true) { if (!(S.obv[t] > X.obvMA[t] && S.obv[t] >= maxPrev(S.obv, t, 20))) return false; }
        return true;
    },
    // S2 趨勢強度:EMA 快線上穿慢線 ∧ ADX > a ∧ +DI > −DI
    S2: (X, t, p) => {
        const f = X.ema[p.f], s = X.ema[p.s], S = X.S;
        const cross = p.state ? f[t] > s[t] : (f[t] > s[t] && f[t - 1] <= s[t - 1]);
        return cross && S.adx[t] > p.a && S.pDI[t] > S.nDI[t];
    },
    // S3 主力籌碼均價:收盤 > 週 VWAP ∧ 突破前 K 日最高 ∧ ATR14 > m × 其 20 日均
    S3: (X, t, p) => {
        const { C, S } = X; if (!(C[t] > maxPrev(C, t, p.K))) return false;
        if (p.noVw !== true && !(C[t] > S.wvwap[t])) return false;
        if (p.noAtr !== true && !(S.atr14[t] > p.m * X.atrMA[t])) return false;
        return true;
    },
    // S4 海龜:收盤創前 K 日新高 ∧ 量 > v × 前 20 日均量 ∧ RSI > 50
    S4: (X, t, p) => {
        const { C, V, S } = X; if (!(C[t] > maxPrev(C, t, p.K))) return false;
        if (p.noVol !== true && !(V[t] > p.v * avgPrev(V, t, 20))) return false;
        if (p.noRsi !== true && !(S.rsi[t] > 50)) return false;
        return true;
    },
    // S5 背離 + 扣抵:近 20 根內有底背離(RSI / MACD 柱)→ 今天放量站上 20MA ∧ 20MA 扣抵值低
    S5: (X, t, p) => {
        const { C, V, L, S } = X;
        if (!(C[t] > S.sma20[t] && C[t - 1] <= S.sma20[t - 1])) return false;
        if (!(V[t] > p.v * avgPrev(V, t, 20))) return false;
        if (p.noKoudi !== true && !koudiLow(C, t, 20, 5)) return false;
        if (p.noDiv === true) { X._div = { low: minPrev(L, t + 1, 10) }; return true; }
        const osc = p.osc === 'rsi' ? [S.rsi] : p.osc === 'macd' ? [S.macdHist] : [S.rsi, S.macdHist];
        for (const o of osc) { const d = bullDiv(L, o, t); if (d && d.low < C[t]) { X._div = d; return true; } }
        return false;
    },
    // 3D-TRB:前置(擠壓 ∧ 吸籌 ∧ 扣抵低)+ 觸發(長紅實體 > b ∧ 突破前 20 日高 ∧ 凱特納上軌 ∧ OBV 創 30 日高 ∧ 量 > v × 均量 ∧ 週月 VWAP 之上)
    D3: (X, t, p) => {
        const { C, O, H, V, S } = X;
        if (!((C[t] - O[t]) / O[t] * 100 > p.b)) return false;
        if (!(C[t] > maxPrev(H, t, 20) && S.kcU[t] != null && C[t] > S.kcU[t])) return false;
        if (!(S.obv[t] >= maxPrev(S.obv, t, 30))) return false;
        if (!(V[t] > p.v * avgPrev(V, t, 20))) return false;
        if (!(C[t] > S.wvwap[t] && C[t] > S.mvwap[t])) return false;
        if (p.trigOnly) return true;
        let sq = false; for (let k = t - 5; k < t; k++) if (S.bbU[k] != null && S.kcU[k] != null && S.bbU[k] <= S.kcU[k] && S.bbL[k] >= S.kcL[k]) { sq = true; break; }
        if (!sq) return false;
        if (p.sqOnly) return true;
        const hi10 = maxPrev(C, t, 10), lo10 = minPrev(C, t, 10);
        if (!((hi10 - lo10) / lo10 < 0.08)) return false;
        if (!(S.obv[t - 1] > S.obv[t - 6])) return false;
        if (!(avgPrev(V, t, 5) < 0.7 * avgPrev(V, t - 5, 20))) return false;
        if (!(koudiLow(C, t, 20, 10) && koudiLow(C, t, 60, 10))) return false;
        return true;
    },
};

// ═══ 他指定的出場(收盤判斷 → 收盤價;回 {ret 毛報酬 %, out} 或 null = 資料不夠走完)═══
const done = (X, t, i, extra = 0) => ({ ret: (X.C[i] / X.C[t] - 1) * 100 + extra, out: i });
export const EXIT = {
    S1: (X, t) => { const { C, L, S } = X; for (let i = t + 1; i < X.n; i++) { if (C[i] < S.sma20[i] || C[i] < minPrev(L, i, 10) || i - t >= MAXD) return done(X, t, i); } return null; },
    S2: (X, t, p) => { const f = X.ema[p.f], s = X.ema[p.s], S = X.S; for (let i = t + 1; i < X.n; i++) { if ((f[i] < s[i] && f[i - 1] >= s[i - 1]) || S.adx[i] < 20 || i - t >= MAXD) return done(X, t, i); } return null; },
    S3: (X, t) => { const { C, S } = X, a = S.atr14[t]; let mx = C[t]; for (let i = t + 1; i < X.n; i++) { mx = Math.max(mx, C[i]); if (C[i] < mx - 2 * a || C[i] < S.wvwap[i] || i - t >= MAXD) return done(X, t, i); } return null; },
    // S4:跌破 20MA 先賣一半,跌破前 10 日低賣剩下的 → 報酬 = 兩半平均
    S4: (X, t) => { const { C, L, S } = X; let half = null;
        for (let i = t + 1; i < X.n; i++) {
            if (half == null && C[i] < S.sma20[i]) half = (C[i] / C[t] - 1) * 100;
            if (C[i] < minPrev(L, i, 10) || i - t >= MAXD) { const r = (C[i] / C[t] - 1) * 100; return { ret: half == null ? r : (half + r) / 2, out: i }; }
        } return null; },
    // S5:停損 = 背離低點(收盤跌破)、停利 = 進場 + rr × 風險(限價:max(開盤, 目標));rr='half' = 一半 1:2、一半 1:3;最長 60 天
    S5: (X, t, p, ctx) => { const { C, O, H } = X; const e = C[t], stop = ctx.low, risk = e - stop; if (!(risk > 0)) return null;
        const tg = p.rr === 'half' ? [e + 2 * risk, e + 3 * risk] : [e + p.rr * risk]; const got = [];
        for (let i = t + 1; i < X.n; i++) {
            for (let g = got.length; g < tg.length; g++) { if (H[i] >= tg[g]) got.push((Math.max(O[i], tg[g]) / e - 1) * 100); else break; }
            if (got.length === tg.length) return { ret: mean(got), out: i };
            if (C[i] < stop || i - t >= 60) { const r = (C[i] / e - 1) * 100; const rest = tg.length - got.length; return { ret: (got.reduce((s, x) => s + x, 0) + r * rest) / tg.length, out: i }; }
        } return null; },
    D3: (X, t, p) => d3Exit(X, t, { stop0: Math.min(X.L[t], minPrev(X.L, t, 10)), be: true, chand: 2.5, ma20hold: true, obvTrim: true }),
};

/** 3D-TRB 的出場(也拿來單獨測四個零件):初始停損 → +1.5ATR 移到成本 → 吊燈(最高收盤 − k×ATR)→ 上彎 20MA 之上不出 → 價創高 OBV 3 天沒創高減半 */
export function d3Exit(X, t, o) {
    const { C, S } = X, a = S.atr14[t], e = C[t]; let stop = o.stop0, mx = e, obvMx = S.obv[t], lastObvHi = t, half = null;
    for (let i = t + 1; i < X.n; i++) {
        const newHi = C[i] > mx; mx = Math.max(mx, C[i]);
        if (S.obv[i] > obvMx) { obvMx = S.obv[i]; lastObvHi = i; }
        if (o.be && mx >= e + 1.5 * a) stop = Math.max(stop, e);
        if (o.chand) stop = Math.max(stop, mx - o.chand * a);
        if (o.obvTrim && half == null && newHi && i - lastObvHi >= 3) half = (C[i] / e - 1) * 100;
        const hold = o.ma20hold && S.sma20[i] > S.sma20[i - 1] && C[i] > S.sma20[i];
        if ((!hold && C[i] < stop) || i - t >= (o.maxD || MAXD)) { const r = (C[i] / e - 1) * 100; return { ret: half == null ? r : (half + r) / 2, out: i }; }
    }
    return null;
}

// ═══ 參數網格(中心點 = 使用者原文)═══
export const GRID = {
    S1: { center: { K: 20, q: 0.2 }, a: ['K', [10, 20, 40]], b: ['q', [0.1, 0.2, 0.3]], loose: [['只突破(沒擠壓沒OBV)', { noSq: true, noObv: true }], ['擠壓+突破(沒OBV)', { noObv: true }]] },
    S2: { center: { f: 10, s: 50, a: 25 }, a: ['a', [20, 25, 30]], b: ['fs', [[5, 20], [10, 50], [20, 60]]], loose: [['只要快線在慢線上(不要交叉)', { state: true }]] },
    S3: { center: { K: 20, m: 1.0 }, a: ['K', [10, 20, 40]], b: ['m', [1.0, 1.1, 1.2]], loose: [['只突破', { noVw: true, noAtr: true }]] },
    S4: { center: { K: 20, v: 1.5 }, a: ['K', [10, 20, 55]], b: ['v', [1.2, 1.5, 2.0]], loose: [['只創 20 日高', { noVol: true, noRsi: true }]] },
    S5: { center: { v: 1.2, osc: 'any', rr: 2 }, a: ['v', [1.0, 1.2, 1.5]], b: ['rr', [2, 3, 'half']], loose: [['沒背離(放量站上月線+扣抵)', { noDiv: true }], ['沒扣抵', { noKoudi: true }]] },
    D3: { center: { b: 2.5, v: 1.8 }, a: ['b', [2.0, 2.5, 3.0]], b: ['v', [1.5, 1.8, 2.2]], loose: [['只看觸發(沒前置)', { trigOnly: true }], ['觸發+擠壓', { sqOnly: true }]] },
};
const setP = (base, k, v) => k === 'fs' ? { ...base, f: v[0], s: v[1] } : { ...base, [k]: v };
export function cellsOf(st) {
    const g = GRID[st], out = [];
    for (const va of g.a[1]) for (const vb of g.b[1]) out.push({ key: `${st}|${g.a[0]}=${JSON.stringify(va)}|${g.b[0]}=${JSON.stringify(vb)}`, p: setP(setP(g.center, g.a[0], va), g.b[0], vb) });
    for (const [nm, ov] of g.loose) out.push({ key: `${st}|LOOSE|${nm}`, p: { ...g.center, ...ov }, loose: nm });
    return out;
}
const CENTER_KEY = st => cellsOf(st).find(c => !c.loose && JSON.stringify(c.p) === JSON.stringify(GRID[st].center)).key;

export function prep(rows) {
    const R = rows.map(r => ({ d: nd(r.date), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 }));
    const S = seriesFor(R), C = S.C;
    const ema = {}; for (const n of [5, 10, 20, 50, 60]) ema[n] = EMA(C, n);
    return { R, S, n: R.length, C, O: R.map(r => r.o), H: R.map(r => r.h), L: R.map(r => r.l), V: S.V, ema, obvMA: SMA(S.obv, 20), atrMA: SMA(S.atr14.map(x => x ?? 0), 20), amt: R.map(r => r.c * r.v) };
}

/** 一檔 → 事件。acc = {ev: Map(key → [{d,u,un,a,days}]), ex: Map(rule → [{d,u,ua}]), skip} */
export function scanStock(rows, twMap, acc, rnd) {
    if (rows.length < WARM + 40) return 0;
    const X = prep(rows); if (!X.R.every(r => r.c > 0)) return 0;
    for (let i = 1; i < X.n; i++) { const q = X.C[i] / X.C[i - 1]; if (q > 1.4 || q < 0.6) { acc.skip.cliff++; return 0; } }
    const CELLS = Object.keys(GRID).flatMap(cellsOf);
    const busy = new Map(); let ev = 0;
    const exAt = (t, r) => { const a = twMap.get(X.R[t].d), b = twMap.get(X.R[r.out].d); if (!(a > 0 && b > 0)) return null; const net = r.ret - COST; return { net, ex: net - (b / a - 1) * 100, days: r.out - t }; };
    const cur = t => { const s = simExits(X.R, t, { rules: ['atr2'], maxD: 20 }); return s && s.atr2 ? exAt(t, { ret: s.atr2.ret, out: s.atr2.outIdx }) : null; };
    const push = (key, t, own) => { const U = exAt(t, own); if (!U) return; const A = cur(t); let arr = acc.ev.get(key); if (!arr) acc.ev.set(key, arr = []); arr.push({ d: X.R[t].d, u: U.ex, un: U.net, a: A ? A.ex : null, days: U.days }); ev++; };
    let lastHi = -99;
    for (let t = WARM; t < X.n - 2; t++) {
        if (avgPrev(X.amt, t, 20) < LIQ_MIN) { acc.skip.illiq++; continue; }
        if (X.C[t] >= X.C[t - 1] * 1.095) { acc.skip.limit++; continue; }
        // 🎲 BASE:隨機日子(固定種子)× 每套自己的出場
        if (rnd() < BASE_P) for (const st of Object.keys(GRID)) {
            let own;
            if (st === 'S5') own = EXIT.S5(X, t, GRID.S5.center, { low: minPrev(X.L, t + 1, 10) });
            else own = EXIT[st](X, t, GRID[st].center);
            if (own) push(`${st}|BASE`, t, own);
        }
        for (const c of CELLS) {
            if ((busy.get(c.key) || 0) >= t) continue;
            X._div = null;
            if (!ENTRY[c.key.split('|')[0]](X, t, c.p)) continue;
            const st = c.key.split('|')[0];
            const own = st === 'S5' ? EXIT.S5(X, t, c.p, X._div) : EXIT[st](X, t, c.p);
            if (!own) continue;
            busy.set(c.key, own.out);
            push(c.key, t, own);
        }
        // 🚪 四個出場零件:同一批「創 60 日新高」事件(20 日去重)
        if (t - lastHi >= 20 && X.C[t] > maxPrev(X.C, t, 60)) {
            lastHi = t;
            const s = simExits(X.R, t, { rules: ['atr2', 'don20'], maxD: 20 });
            const base = s && s.atr2 ? exAt(t, { ret: s.atr2.ret, out: s.atr2.outIdx }) : null;
            if (base) {
                const st0 = Math.min(X.L[t], minPrev(X.L, t, 10));
                const rules = {
                    don20: s.don20 ? { ret: s.don20.ret, out: s.don20.outIdx } : null,
                    chand25: d3Exit(X, t, { stop0: st0, chand: 2.5, maxD: 60 }),
                    be_chand25: d3Exit(X, t, { stop0: st0, be: true, chand: 2.5, maxD: 60 }),
                    full3d: d3Exit(X, t, { stop0: st0, be: true, chand: 2.5, ma20hold: true, obvTrim: true, maxD: 60 }),
                    noHold: d3Exit(X, t, { stop0: st0, be: true, chand: 2.5, obvTrim: true, maxD: 60 }),
                    noTrim: d3Exit(X, t, { stop0: st0, be: true, chand: 2.5, ma20hold: true, maxD: 60 }),
                };
                for (const [k, r] of Object.entries(rules)) { if (!r) continue; const U = exAt(t, r); if (!U) continue;
                    let arr = acc.ex.get(k); if (!arr) acc.ex.set(k, arr = []); arr.push({ d: X.R[t].d, u: U.ex, a: base.ex, days: U.days }); }
            }
        }
    }
    return ev;
}

/** 配對差(同一批事件換出場):d = u − a */
export function paired(arr) {
    const d = arr.map(e => e.u - e.a); if (d.length < 30) return { n: d.length, small: true };
    const m = mean(d), z = m / (sdv(d) / Math.sqrt(d.length)), ds = arr.map(e => e.d).sort(), cut = ds[ds.length >> 1];
    const h1 = mean(arr.filter(e => e.d < cut).map(e => e.u - e.a)), h2 = mean(arr.filter(e => e.d >= cut).map(e => e.u - e.a));
    const yrs = [...new Set(arr.map(e => e.d.slice(0, 4)))].sort().map(y => { const x = arr.filter(e => e.d.startsWith(y)).map(e => e.u - e.a); return x.length >= 15 ? [y, mean(x)] : null; }).filter(Boolean);
    const yrOK = yrs.filter(x => Math.sign(x[1]) === Math.sign(m)).length;
    return { n: d.length, d: r2(m), z: r2(z), h1: r2(h1), h2: r2(h2), yr: `${yrOK}/${yrs.length}`, u: r2(mean(arr.map(e => e.u))), a: r2(mean(arr.map(e => e.a))), days: r2(mean(arr.map(e => e.days))) };
}

// ═══════ selftest ═══════
function mkRows(n, f, vol = () => 1e7, start = Date.UTC(2015, 0, 5)) { const days = []; let d = new Date(start); for (let i = 0; i < n; i++) { while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5); days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    return days.map((dd, i) => { const c = f(i); return { date: dd, open: c * 0.998, high: c * 1.006, low: c * 0.994, close: c, volume: vol(i) }; }); }
function selftest() {
    let ok = 0, bad = 0; const T = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // ① 前 K 日最高 ⛔ 不含今天
    T(!(12 > maxPrev([10, 12, 11, 12], 3, 3)) && maxPrev([10, 12, 11, 99], 3, 3) === 12, '① 前 K 日最高 ⛔ 不含今天(今天 = 前高 → 不算突破)');
    // ② 週 / 月 VWAP 在週一 / 月初重置
    const R2 = [{ d: '2024-01-29', h: 10, l: 10, c: 10, v: 1 }, { d: '2024-01-31', h: 20, l: 20, c: 20, v: 1 }, { d: '2024-02-01', h: 30, l: 30, c: 30, v: 1 }, { d: '2024-02-05', h: 40, l: 40, c: 40, v: 1 }];
    const wk = anchoredVwap(R2, d => { const t = Date.parse(d + 'T00:00:00Z'); const day = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - day * 864e5).toISOString().slice(0, 10); });
    const mo = anchoredVwap(R2, d => d.slice(0, 7));
    T(wk[2] === 20 && wk[3] === 40 && mo[1] === 15 && mo[2] === 30, `② VWAP 週一重置(${wk.join(',')})、月初重置(${mo.join(',')})`);
    // ③ 扣抵值只用過去:koudiLow 的索引都 ≤ t
    const C3 = Array.from({ length: 40 }, (_, i) => 100 + i);
    T(koudiLow(C3, 30, 20, 5) === true && koudiLow(C3.map(x => 200 - x), 30, 20, 5) === false, '③ 扣抵:一路漲 → 扣抵低(均線會上彎);一路跌 → ⛔ 不是');
    // ④ ⭐ 截斷驗證(零前視):對每一套、隨機 t,用 R[0..t] 算的進場判斷 == 用整條 R 算的
    const n4 = 700; let p = 100; const px = [], vv = [];
    for (let i = 0; i < n4; i++) { p *= 1 + (rnd() - 0.48) * 0.04; px.push(p); vv.push(1e6 * (0.3 + 2 * rnd())); }
    const rows4 = mkRows(n4, i => px[i], i => vv[i]);
    const full = prep(rows4); let mism = 0, fired = 0;
    for (let t = 300; t < n4 - 5; t += 3) { const cut = prep(rows4.slice(0, t + 1));
        for (const st of Object.keys(GRID)) for (const c of cellsOf(st)) { full._div = cut._div = null; const a = ENTRY[st](full, t, c.p), b = ENTRY[st](cut, t, c.p); if (a !== b) mism++; if (a) fired++; } }
    T(mism === 0 && fired > 20, `④ ⭐ 截斷驗證:只看到今天為止 vs 看到整條,進場判斷完全一樣(不一致 ${mism} ・觸發 ${fired} 次)`);
    // ④b 決定性對照:注入「用明天收盤」的進場 → 截斷驗證必須抓到
    const peek = (X, t) => X.C[t + 1] > X.C[t]; let caught = 0;
    for (let t = 300; t < n4 - 5; t += 7) { const cut = prep(rows4.slice(0, t + 1)); if (peek(full, t) !== peek(cut, t)) caught++; }
    T(caught > 5, `④b 注入「偷看明天」→ 截斷驗證抓得到(${caught} 次不一致)`);
    // ⑤ 底背離要等右邊 3 根才確認
    const Lb = [10, 9, 8, 7, 8, 9, 10, 9, 8, 6.5, 7, 7.5, 8, 8.5];
    const os = [30, 28, 25, 20, 25, 30, 35, 32, 30, 26, 30, 32, 34, 36];
    T(bullDiv(Lb, os, 13, { look: 20 }) && bullDiv(Lb, os, 13).low === 6.5 && bullDiv(Lb, os, 11) === null, '⑤ 底背離:新低 + 指標墊高 → 抓到;低點右邊還不到 3 根 → ⛔ 不可提前');
    // ⑥ S4 減半:報酬 = 兩半平均
    const R6 = mkRows(300, i => i < 270 ? 100 + Math.sin(i / 5) : i === 272 ? 90 : i < 280 ? 105 : 80);
    const X6 = prep(R6); const e6 = EXIT.S4(X6, 271);
    T(e6 && e6.out > 271, `⑥ S4 出場有結束(${e6 && e6.out})`);
    const n6 = 280, X6b = { n: n6, C: new Array(n6).fill(100), L: new Array(n6).fill(95), S: { sma20: new Array(n6).fill(98) } };
    X6b.S.sma20[273] = 99; X6b.C[273] = 97; X6b.C[275] = 90;
    const h6 = EXIT.S4(X6b, 271);
    T(h6 && h6.out === 275 && Math.abs(h6.ret - ((97 / 100 - 1) * 100 + (90 / 100 - 1) * 100) / 2) < 1e-9, `⑥b 先跌破 20MA 賣一半(97)、再跌破 10 日低賣剩下(90)→ 兩半平均 −6.5%(${h6 && r2(h6.ret)}%)`);
    // ⑦ 收盤鎖漲停剔除 + 不重複持有
    const tw = new Map(); const acc = { ev: new Map(), ex: new Map(), skip: { cliff: 0, illiq: 0, limit: 0 } };
    const rows7 = mkRows(900, i => 100 * Math.pow(1.0008, i) * (1 + 0.03 * Math.sin(i / 9)), () => 1e7 * (0.3 + 2 * rnd())); rows7[600].close = rows7[599].close * 1.1;
    rows7.forEach(r => tw.set(r.date, 10000)); scanStock(rows7, tw, acc, rnd);
    let overlap = 0; for (const [k, arr] of acc.ev) { if (k.endsWith('|BASE')) continue; for (let i = 1; i < arr.length; i++) if (arr[i].d < arr[i - 1].d) overlap++; }
    T(acc.skip.limit >= 1, `⑦ 收盤鎖漲停那天剔除(${acc.skip.limit})`);
    const s4 = acc.ev.get(CENTER_KEY('S4')) || [];
    let ovl = 0; { const X7 = prep(rows7); const idx = new Map(X7.R.map((r, i) => [r.d, i])); for (let i = 1; i < s4.length; i++) if (idx.get(s4[i].d) <= idx.get(s4[i - 1].d) + s4[i - 1].days) ovl++; }
    T(s4.length > 2 && ovl === 0, `⑦b 同一檔持有中不重複進場(S4 中心 ${s4.length} 筆、重疊 ${ovl})`);
    // ⑧ 注入:S4 每次觸發後 10 根每根 +0.5% → S4 vs BASE 量得到
    const acc8 = { ev: new Map(), ex: new Map(), skip: { cliff: 0, illiq: 0, limit: 0 } }; seed = 99;
    for (let s = 0; s < 50; s++) {
        let q = 100; const b = [], v = []; for (let i = 0; i < 1200; i++) { q *= 1 + (rnd() - 0.5) * 0.03; b.push(q); v.push(1e6 * (0.3 + 2 * rnd())); }
        const X0 = prep(mkRows(1200, i => b[i], i => v[i] * 100)); const mult = new Float64Array(1200).fill(1);
        for (let t = WARM; t < 1180; t++) if (ENTRY.S4(X0, t, GRID.S4.center)) for (let k = t + 1; k <= t + 10; k++) mult[k] *= 1.005;
        let mm = 1; const rows = b.map((x, i) => { mm *= mult[i]; return x * mm; });
        const R8 = mkRows(1200, i => rows[i], i => v[i] * 100); if (!s) R8.forEach(r => tw.set(r.date, 10000)); scanStock(R8, tw, acc8, rnd);
    }
    const c8 = cmp(acc8.ev.get(CENTER_KEY('S4')) || [], acc8.ev.get('S4|BASE') || [], 'a');
    T(!c8.small && c8.d > 1, `⑧ 注入 S4 觸發後 +5% → 量得到(現行出場 vs 隨便哪天 ${c8.d}pp,n=${c8.n})`);
    // ⑨ 雜訊兩組 → 六關不可全過
    const nz = () => Array.from({ length: 400 }, (_, i) => ({ d: `20${15 + (i % 8)}-0${1 + (i % 9)}-10`, u: (rnd() - 0.5) * 5 }));
    T(cmp(nz(), nz()).pass < 6, '⑨ 兩組雜訊 → 六關不可全過');
    // ⑩ 3D 出場:上彎 20MA 之上就算跌破停損也不出
    const R10 = mkRows(300, i => i <= 270 ? 50 + i * 0.2 : 50 + 270 * 0.2 - (i - 270) * 0.05);
    const X10 = prep(R10); const keep = d3Exit(X10, 270, { stop0: X10.C[270] * 0.999, ma20hold: true, maxD: 5 }), cut10 = d3Exit(X10, 270, { stop0: X10.C[270] * 0.999, maxD: 5 });
    T(keep && cut10 && keep.out > cut10.out, `⑩ 上彎 20MA 之上不出場(有 ${keep && keep.out - 270} 天 vs 沒有 ${cut10 && cut10.out - 270} 天)`);
    console.log(`\n${bad ? '❌' : '✅'} STRAT6_SELFTEST ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const NAMES = { S1: '① 帶量突破動能(布林壓縮 + 突破 20 日高 + OBV 創高 → 破 20MA 或 10 日低出)', S2: '② 趨勢強度雙重確認(EMA10 上穿 50 + ADX>25 + DI → 死叉或 ADX<20 出)', S3: '③ 主力籌碼均價(週 VWAP 之上 + 突破 + ATR 擴張 → 2ATR 移動停利或破週 VWAP 出)', S4: '④ 海龜唐奇安(創 20 日高 + 量 1.5 倍 + RSI>50 → 破 20MA 減半、破 10 日低全出)', S5: '⑤ 背離轉折 + 扣抵(底背離後放量站上月線 + 扣抵低 → 背離低點停損、1:2 停利)', D3: '⑥ 3D-TRB 三維量價籌碼共振' };

function main() {
    const DATA = process.env.DATA_DIR; if (!DATA) { console.log('❌ DATA_DIR'); process.exit(1); }
    const OUT = process.argv.slice(2).find(a => a.endsWith('.json'));
    const FROM = process.env.FROM || '';
    const tw = new Map(JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => [nd(r.date), +r.close]));
    const acc = { ev: new Map(), ex: new Map(), skip: { cliff: 0, illiq: 0, limit: 0 } };
    let seed = 20261004; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const files = fs.readdirSync(DATA).filter(f => /^[1-9]\d{3}\.json$/.test(f)).sort();
    let used = 0;
    for (const f of files) {
        let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(rows)) continue; rows.sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
        if (FROM) rows = rows.filter(r => nd(r.date) >= FROM);
        if (scanStock(rows, tw, acc, rnd)) used++;
        if (used % 200 === 0) process.stdout.write(`\r  ${used} 檔…`);
    }
    const E = k => acc.ev.get(k) || [];
    const allD = E('S4|BASE').map(e => e.d).sort();
    console.log(`\r📊 ${used} 檔 ・窗口 ${allD[0]} ~ ${allD.at(-1)} ・剔除:斷崖 ${acc.skip.cliff} 檔 ・量少 ${acc.skip.illiq.toLocaleString()} ・收盤漲停 ${acc.skip.limit.toLocaleString()}`);
    const avg = (a, f) => r2(mean(a.map(e => e[f]).filter(v => v != null)));
    const fmt = x => x.small ? `樣本不足(${x.n})` : `n=${x.n} ・${x.ma} vs ${x.mb} → ${x.d >= 0 ? '+' : ''}${x.d}pp ・前後半 ${x.h1}/${x.h2} ・p=${x.p} ・六關 ${x.pass}/6`;
    const out = { win: [allD[0], allD.at(-1)], used, strat: {}, exits: {} };
    for (const st of Object.keys(GRID)) {
        const ck = CENTER_KEY(st), C0 = E(ck), B = E(`${st}|BASE`);
        const pf = arr => { const w = arr.filter(e => e.un > 0).reduce((s, e) => s + e.un, 0), l = -arr.filter(e => e.un < 0).reduce((s, e) => s + e.un, 0); return l > 0 ? r2(w / l) : null; };
        const r = { n: C0.length, own: avg(C0, 'u'), net: avg(C0, 'un'), cur: avg(C0, 'a'), days: avg(C0, 'days'), win: r2(C0.filter(e => e.un > 0).length / Math.max(1, C0.length) * 100), pf: pf(C0),
            base: { n: B.length, own: avg(B, 'u'), cur: avg(B, 'a') }, vsBase: cmp(C0, B, 'u'), vsBaseCur: cmp(C0, B, 'a'), loose: {}, grid: [] };
        for (const c of cellsOf(st)) {
            const A = E(c.key);
            if (c.loose) { r.loose[c.loose] = { n: A.length, own: avg(A, 'u'), inc: cmp(C0, A, 'u'), incCur: cmp(C0, A, 'a') }; continue; }
            const g = cmp(A, B, 'u'), gc = cmp(A, B, 'a');
            r.grid.push({ key: c.key, n: A.length, own: avg(A, 'u'), cur: avg(A, 'a'), pass: g.small ? null : g.pass, passCur: gc.small ? null : gc.pass, d: g.d, dc: gc.d });
        }
        out.strat[st] = r;
        console.log(`\n══ ${NAMES[st]} ══`);
        console.log(`  中心點 ${r.n} 筆 ・他的出場:平均超額 ${r.own}%(扣成本毛利 ${r.net}%・賺錢 ${r.win}%・獲利因子 ${r.pf}・平均抱 ${r.days} 天)・換現行吊燈 2 倍 20 天:${r.cur}%`);
        console.log(`  🎲 隨便哪天(同出場):他的出場 ${r.base.own}% / 吊燈 ${r.base.cur}%(n=${r.base.n})`);
        console.log(`  vs 隨便哪天・他的出場:${fmt(r.vsBase)}`);
        console.log(`  vs 隨便哪天・現行出場:${fmt(r.vsBaseCur)}`);
        for (const [nm, x] of Object.entries(r.loose)) console.log(`  🧩 對照「${nm}」(n=${x.n}、${x.own}%):多那一層 ${fmt(x.inc)}`);
        const valid = r.grid.filter(g => g.pass != null);
        console.log(`  ⛰️ 高原 ${valid.length}/9 格有樣本:他的出場六關全過 ${valid.filter(g => g.pass === 6).length} 格・超額為正 ${valid.filter(g => g.d > 0).length} 格 ・現行出場全過 ${valid.filter(g => g.passCur === 6).length} 格`);
        for (const g of r.grid) console.log(`     ${g.key.split('|').slice(1).join(' ')}:n=${g.n} 他的出場 ${g.own}%(${g.pass ?? '-'}/6)・吊燈 ${g.cur}%(${g.passCur ?? '-'}/6)`);
    }
    console.log('\n══ 🚪 四個出場零件(同一批「創 60 日新高」事件,跟現行吊燈 2 倍 20 天配對比)══');
    for (const [k, arr] of acc.ex) { const p = paired(arr); out.exits[k] = p; console.log(`  ${k.padEnd(11)} n=${p.n} ・平均 ${p.u}% vs 吊燈 ${p.a}% → ${p.d >= 0 ? '+' : ''}${p.d}pp(z=${p.z}・前後半 ${p.h1}/${p.h2}・逐年同向 ${p.yr}・抱 ${p.days} 天)`); }
    if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out)); console.log(`💾 ${OUT}`); }
}

const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (_isMain) { if (process.argv.includes('--selftest')) process.exit(selftest()); else main(); }
