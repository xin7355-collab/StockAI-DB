// 🌪️ lib_crash.mjs —— 大盤修正段研究共用(V81.0.2):stopfall_probe / nsf_probe / crash_cycle_probe 一起用
//
// ⭐ 三件事只寫在這裡(⛔ 各支探針各抄一份):
//   ① loadIndex:加權 2000 起(idx_long_early + idx_long + ^TWII,接法同 dipbuy_probe.mergeIdx)+ 成交金額
//   ② corrLegs:修正段 = 收盤比近 250 天最高收盤低 ≥10%(同 ftd_probe 的「修正中」);收盤回到離高點 5% 以內 = 結束
//   ③ evVsCorr:事件 vs「修正段隨便一天」(真正的對手:同樣是跌深之後,等那個徵兆有沒有比較好)
// 只用到那天為止的資料判斷;「離那一段最低點多遠」是事後量的成績,⛔ 不拿來當訊號。
import fs from 'fs';
import { mergeIdx, rollMax, rng, bh } from './dipbuy_probe.mjs';

export { rollMax, bh, rng };
export const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
export const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);
export const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const rd = p => p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;

/** 加權 2000 起 + 成交金額(元;early / long 的第 6 欄、^TWII 的 amount) */
export function loadIndex(env = process.env) {
    const long = rd(env.IDX_LONG), early = rd(env.IDX_EARLY), nowRaw = rd(env.TWII_NOW);
    const now = Array.isArray(nowRaw) ? nowRaw : (nowRaw && (nowRaw.data || nowRaw.rows)) || null;
    if (!long) throw new Error('IDX_LONG 沒給');
    const S = mergeIdx(long, early, now);
    const am = new Map();
    for (const r of (early ? early.twii || [] : [])) if (r[5] > 0) am.set(String(r[0]).replace(/\//g, '-').slice(0, 10), +r[5]);
    for (const r of (long.twii || [])) if (r[5] > 0) am.set(String(r[0]).replace(/\//g, '-').slice(0, 10), +r[5]);
    for (const r of (now || [])) if (r.amount > 0) am.set(String(r.date).replace(/\//g, '-').slice(0, 10), +r.amount);
    S.a = S.d.map(d => am.get(d) || null);
    return S;
}

/** 修正段:回 { corr: Int32Array(每天屬於第幾段,−1 = 不在修正段), legs: [{s, e, peak, peakI, low, lowI, depth}] }
 *  s = 第一天收盤 ≤ 近 W 天高點 × (1 − DD);e = 收盤回到高點 END 以內的前一天(還沒結束 = 最後一天)
 *  ⚠️ low / lowI / depth 是整段走完才知道的(只拿來量「離底多遠」,⛔ 不當訊號) */
export function corrLegs(c, W = 250, DD = 10, END = 5) {
    const hi = rollMax(c, W), n = c.length, corr = new Int32Array(n).fill(-1), legs = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
        const d = c[i] / hi[i] - 1;
        if (!cur) {
            if (d <= -DD / 100) { let pk = i; while (pk > 0 && pk > i - W && c[pk] < hi[i]) pk--; cur = { s: i, e: i, peak: hi[i], peakI: pk, low: c[i], lowI: i, open: true }; }
        } else if (d > -END / 100) { cur.open = false; legs.push(cur); cur = null; continue; }
        if (cur) { cur.e = i; if (c[i] < cur.low) { cur.low = c[i]; cur.lowI = i; } corr[i] = legs.length; }
    }
    if (cur) legs.push(cur);
    for (const L of legs) L.depth = (L.low / L.peak - 1) * 100;
    return { corr, legs, hi };
}

/** 每一段只留第一次(ev 是由舊到新的日子) */
export function firstPerLeg(ev, corr) { const seen = new Set(), out = []; for (const i of ev) { const k = corr[i]; if (k < 0 || seen.has(k)) continue; seen.add(k); out.push(i); } return out; }
/** 同一段裡隔 gap 天以上才算新的一次 */
export function gapDedup(ev, corr, gap = 10) { const out = []; let last = -1e9, lk = -2; for (const i of ev) { if (corr[i] < 0) continue; if (corr[i] === lk && i - last < gap) continue; out.push(i); last = i; lk = corr[i]; } return out; }

/** 第 i 天收盤之後的事後成績:h 天報酬(A 可以有 null)、之後到那段結束(或 120 天)還再跌多少、是不是在那段最低點 3% 以內、60 天內有沒有再跌 ≥5% */
export function after(S, A, legs, corr, i, h) {
    const x = (A[i] != null && i + h < A.length && A[i + h] != null) ? (A[i + h] / A[i] - 1) * 100 : null;
    const L = legs[corr[i]];
    let mn = S.c[i]; const end = L ? Math.min(L.open ? S.c.length - 1 : L.e, i + 250) : Math.min(S.c.length - 1, i + 120);
    for (let k = i + 1; k <= end; k++) if (S.c[k] < mn) mn = S.c[k];
    let deeper = null; if (i + 60 < S.c.length) { deeper = false; for (let k = 1; k <= 60; k++) if (S.c[i + k] <= S.c[i] * 0.95) { deeper = true; break; } }
    return { x, more: (mn / S.c[i] - 1) * 100, near: L ? S.c[i] <= L.low * 1.03 : null, deeper };
}

/** 事件 vs 修正段隨便一天:h 天平均差、從修正段日子抽一樣多次 SIMS 次的 p 值;另附離底多遠 / 再跌 5% 比例(事件 vs 修正段)
 *  ⚠️ 事件的那一段還沒走完時(最後一段),near 與 more 只算到今天 → 印出 open 筆數
 *  🚨 from:對照組只收第 from 天以後的修正段日子 —— 徵兆的資料起點比指數晚(VIX 2009 / 廣度 2010 / 融資 2004)時一定要給,
 *     不然對照組含資料起點之前的空頭(2008)、平均被拉低 → 差距灌水(陷阱 #50:事件窗口跟對照組期間對不上) */
export function evVsCorr(S, A, CL, ev, hs, seed = 7, SIMS = 2000, from = 0) {
    const { corr, legs } = CL, R = rng(seed), out = { n: ev.length, legs: new Set(ev.map(i => corr[i])).size, h: {}, from: S.d[from] };
    const pool = []; for (let i = from; i < S.c.length; i++) if (corr[i] >= 0) pool.push(i);
    for (const h of hs) {
        const f = i => after(S, A, legs, corr, i, h).x;
        const base = pool.map(f).filter(v => v != null), e = ev.map(i => [i, f(i)]).filter(z => z[1] != null);
        if (e.length < 3 || base.length < 30) { out.h[h] = { n: e.length }; continue; }
        const em = mean(e.map(z => z[1])), bm = mean(base);
        let ge = 0; for (let s = 0; s < SIMS; s++) { let sum = 0; for (let k = 0; k < e.length; k++) sum += base[Math.floor(R() * base.length)]; if (sum / e.length >= em) ge++; }
        const half = e.length >> 1, h1 = mean(e.slice(0, half).map(z => z[1])), h2 = mean(e.slice(half).map(z => z[1]));
        const yr = {}; for (const [i, x] of e) (yr[S.d[i].slice(0, 4)] = yr[S.d[i].slice(0, 4)] || []).push(x);
        const ys = Object.values(yr);
        out.h[h] = { n: e.length, ev: r2(em), base: r2(bm), diff: r2(em - bm), up: r2(e.filter(z => z[1] > 0).length / e.length * 100),
            upBase: r2(base.filter(v => v > 0).length / base.length * 100), p: +(ge / SIMS).toFixed(3),
            h1: r2((h1 ?? NaN) - bm), h2: r2((h2 ?? NaN) - bm), yrsWin: ys.filter(a => mean(a) > bm).length, yrsN: ys.length };
    }
    const A0 = ev.map(i => after(S, A, legs, corr, i, 20));
    const P0 = pool.filter((_, k) => k % 3 === 0).map(i => after(S, A, legs, corr, i, 20));
    const pc = (a, f) => { const b = a.filter(z => z[f] != null); return b.length ? r2(b.filter(z => z[f]).length / b.length * 100) : null; };
    out.near = pc(A0, 'near'); out.nearBase = pc(P0, 'near');
    out.deeper = pc(A0, 'deeper'); out.deeperBase = pc(P0, 'deeper');
    out.more = r2(med(A0.map(z => z.more))); out.moreBase = r2(med(P0.map(z => z.more)));
    out.open = ev.filter(i => legs[corr[i]] && legs[corr[i]].open).length;
    out.dates = ev.map(i => S.d[i]);
    return out;
}

/** 美股日期對到「第一個日期 > 那天」的台股交易日(同一天 = 前視;同 us_tw_lead_probe.nextTwFactory) */
export function usToTw(twDates) { return d => { let lo = 0, hi = twDates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (twDates[m] > d) hi = m; else lo = m + 1; } return lo < twDates.length ? lo : -1; }; }

/** 簡單移動平均(含今天)與 Wilder RSI */
export function sma(c, n) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
export function rsi(c, n = 14) {
    const o = new Array(c.length).fill(null); let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
        if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
        else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    return o;
}
