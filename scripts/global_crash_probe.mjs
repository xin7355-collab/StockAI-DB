// 🌎 global_crash_probe.mjs —— 全球一起大跌:台股是不是回得比美股慢(EXP-B)?大跌撿美股(換成台幣)能不能賺(EXP-C)?
//
// 為什麼要測:2026-11-25 使用者:「目前全球股市都有大跌嗎?會對台灣股市有什麼影響,當提款機?另外如果都將大跌的話,
//   以全球來講是不是撿美股也是一個好方法,我想要做的是你自己找會賺錢的方法」。
//   照規則:大盤層級「之後會怎樣」要先驗證過才能寫成建議(.claude/rules/linkage.md「大盤層級的警示」);台股的版本已經測過
//   (dip-buy-0050:大跌那天買不比隨便一天好、存現金等大跌輸給每月買;crash-recovery;twd-weak)→ 這次問美股、問「一起跌」。
//
// 資料:加權 2000 起(lib_crash.loadIndex;含息 twii_tr 2003 起)・標普 ^GSPC / 韓國 ^KS11(world_hist.json.gz,只有價格)
//       美元兌台幣 DEXTAUS / 美元兌韓元 DEXKOUS(fred_hist.json,紐約中午)・外資現貨每日(fi_mkt_hist.json spot[0],億,2004 起;只描述)
// ⚠️ 標普只有價格(沒有股利,一年約 1.5~2%)→ 「台股 − 美股」價格版對台股不利約 1~2 個百分點 / 年(台股殖利率比較高);
//    含息版(加權含息 vs 標普價格)當敏感度一起印。
// 時間點(⛔ 前視):
//   EXP-B 台股某天收盤時看得到的標普 = 美國日期比那天早的最後一筆收盤(同一天的美股還沒開);
//         買:台股那天收盤 / 標普在「美國日期 ≥ 那天」的第一個收盤(那天晚上)・匯率 = 那個美國日期或之前最後一筆;
//         賣:台股 h 個交易日後收盤 / 標普在「美國日期 ≥ 那天」的第一個收盤。
//   EXP-C 標普某天收盤離 250 天最高收盤 ≥ D%(每一段修正第一次)→ 台灣早上才看得到 → 隔一個美股交易日收盤用台幣買,抱 h 個美股交易日;
//         「同一天買台股」= 看到之後第一個台股交易日(台灣日期 > 美國那天)收盤買加權含息,賣在台灣日期 ≥ 美股賣出那天的第一個收盤。
// ⭐ 判定(EXP 寫死,⛔ 跑完再改)見 RULE / judgeB() / judgeC():只用到 2026-11-06(之後封存,只描述現在這一段)。
//
// 跑法:IDX_LONG IDX_EARLY TWII_NOW FRED_HIST WORLD_HIST [FI_HIST] node scripts/global_crash_probe.mjs [out.json]
//       node scripts/global_crash_probe.mjs --selftest
import fs from 'fs';
import zlib from 'zlib';
import { loadIndex, corrLegs, rollMax, mean, med, r2, rng } from './lib_crash.mjs';
import { loadFx } from './usd_dd_probe.mjs';

// ⭐ 事先登記的判定(EXP-20261125-01 全球一起大跌 / -02 撿美股 寫死;⛔ 跑完再改)
export const RULE = {
    cut: '2026-11-06', W: 250, FX_STALE: 10, seed: 20261125,
    // EXP-B:台股 − 標普(台幣)250 天平均 ≤ −effect・正負號隨機翻轉 p(台股比較差那一側)≤ p・前後半都 < 0・韓股(− 標普換韓元)也 < 0 且 ≥ krMinN 次
    B: { D: 15, h: 250, minN: 6, effect: 5, p: 0.05, krMinN: 5, Ds: [10, 15, 20], hs: [120, 250] },
    // EXP-C:標普離高點 ≥ 15% 每段第一次,隔天收盤用台幣買抱 250 天 vs 同期間隨便一天買:平均多 ≥ effect・抽樣 p ≤ p・前後半都 > 0・旁邊 4 格 ≥ 3 格 > 0
    C: { D: 15, h: 250, minN: 5, effect: 5, p: 0.05, nbr: [[10, 250], [20, 250], [15, 120], [15, 500]], nbrNeed: 3, Ds: [10, 15, 20, 25], hs: [120, 250, 500], sims: 4000, from: '2000-01-01' },
};

const T = s => Date.parse(s + 'T00:00:00Z');
const dayGap = (a, b) => Math.round((T(b) - T(a)) / 864e5);
/** 第一個 ≥ x 的位置(沒有 → −1) */
export function firstGE(ds, x) { let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] < x) lo = m + 1; else hi = m; } return lo < ds.length ? lo : -1; }
/** 第一個 > x 的位置(沒有 → −1) */
export function firstGT(ds, x) { let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] <= x) lo = m + 1; else hi = m; } return lo < ds.length ? lo : -1; }
/** 最後一個 ≤ x / < x 的位置(沒有 → −1) */
export function lastLE(ds, x) { const k = firstGT(ds, x); return (k < 0 ? ds.length : k) - 1; }
export function lastLT(ds, x) { const k = firstGE(ds, x); return (k < 0 ? ds.length : k) - 1; }
/** 那個日期(含)之前最後一筆匯率;比那天早超過 FX_STALE 個日曆天 → null(⛔ 拿很舊的匯率換算) */
export function fxOn(F, d) { const k = lastLE(F.d, d); return (k < 0 || dayGap(F.d[k], d) > RULE.FX_STALE) ? null : F.v[k]; }

/** 截到 cut(含)為止;陣列欄位一起切 */
export function cutSer(S, cut) {
    let n = S.d.length; while (n > 0 && S.d[n - 1] > cut) n--;
    const o = {}; for (const [k, v] of Object.entries(S)) o[k] = Array.isArray(v) && v.length === S.d.length ? v.slice(0, n) : v;
    return o;
}
export const cutFx = (F, cut) => { let n = F.d.length; while (n > 0 && F.d[n - 1] > cut) n--; return { d: F.d.slice(0, n), v: F.v.slice(0, n) }; };

export function loadWorld(buf, key) {
    const txt = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const j = JSON.parse(txt), s = j && j.s && j.s[key];
    if (!s || !Array.isArray(s.d) || !Array.isArray(s.c) || s.d.length !== s.c.length || s.d.length < 500) throw new Error(`world_hist 沒有 ${key}(或太短)`);
    return { d: s.d.slice(), c: s.c.map(Number) };
}

/** 正負號隨機翻轉(配對差;虛無假設 = 差對 0 對稱)。side 'lo' = 平均 ≤ 觀察值的比例;n ≤ 16 全部列舉 */
export function signFlipP(x, side = 'lo', sims = 20000, seed = 1) {
    const n = x.length; if (!n) return null;
    const obs = mean(x), hit = v => side === 'lo' ? v <= obs + 1e-9 : v >= obs - 1e-9;
    if (n <= 16) {
        let c = 0; const tot = 1 << n;
        for (let m = 0; m < tot; m++) { let s = 0; for (let k = 0; k < n; k++) s += ((m >> k) & 1) ? -x[k] : x[k]; if (hit(s / n)) c++; }
        return +(c / tot).toFixed(4);
    }
    const R = rng(seed); let c = 0;
    for (let s = 0; s < sims; s++) { let t = 0; for (let k = 0; k < n; k++) t += R() < 0.5 ? -x[k] : x[k]; if (hit(t / n)) c++; }
    return +((c + 1) / (sims + 1)).toFixed(4);
}

// ═══════════════════════════ EXP-B 全球一起大跌 ═══════════════════════════
/** A = 本地市場 { d, c, tr? };U = 標普 { d, c };F = 美元兌本地貨幣 { d, v };D = 門檻 %
 *  事件 = A 每一段修正(corrLegs)裡第一次「A 離 250 天高點 ≥ D% 而且看得到的標普也 ≥ D%」那天 */
export function coCrash(A, U, F, D, hs, W = RULE.W) {
    const hiA = rollMax(A.c, W), hiU = rollMax(U.c, W), CL = corrLegs(A.c, W, 10, 5), seen = new Set(), ev = [];
    for (let i = W - 1; i < A.d.length; i++) {
        const k = CL.corr[i]; if (k < 0 || seen.has(k)) continue;
        const dA = A.c[i] / hiA[i] - 1; if (dA > -D / 100) continue;
        const j = lastLT(U.d, A.d[i]); if (j < W - 1) continue;            // ⛔ 同一天的美股(台股收盤時還沒開)
        const dU = U.c[j] / hiU[j] - 1; if (dU > -D / 100) continue;
        seen.add(k);
        ev.push({ i, d: A.d[i], usd: U.d[j], dd: r2(dA * 100), ddUs: r2(dU * 100), leg: k });
    }
    const outc = (e, h) => {
        const i = e.i, x = i + h; if (x >= A.d.length) return null;
        const u0 = firstGE(U.d, A.d[i]), u1 = firstGE(U.d, A.d[x]); if (u0 < 0 || u1 < 0) return null;
        const f0 = fxOn(F, U.d[u0]), f1 = fxOn(F, U.d[u1]); if (f0 == null || f1 == null) return null;
        const loc = (A.c[x] / A.c[i] - 1) * 100, usd = (U.c[u1] / U.c[u0] - 1) * 100, usLoc = (U.c[u1] / U.c[u0] * (f1 / f0) - 1) * 100;
        const tr = A.tr && A.tr[i] && A.tr[x] ? (A.tr[x] / A.tr[i] - 1) * 100 : null;
        return { loc, usd, usLoc, diff: loc - usLoc, tr, diffTr: tr == null ? null : tr - usLoc };
    };
    for (const e of ev) { e.h = {}; for (const h of hs) { const o = outc(e, h); if (o) e.h[h] = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? null : r2(v)])); } }
    // 之後 250 天裡最多再跌多少(本地 / 標普台幣)、回到事件那天的 250 天高點要幾個交易日(各自的貨幣)
    for (const e of ev) {
        const i = e.i, end = Math.min(A.d.length - 1, i + 250); let mn = A.c[i];
        for (let k = i + 1; k <= end; k++) mn = Math.min(mn, A.c[k]);
        e.more = r2((mn / A.c[i] - 1) * 100);
        let rec = null; for (let k = i + 1; k < A.d.length; k++) if (A.c[k] >= hiA[i]) { rec = k - i; break; }
        const j = lastLT(U.d, A.d[i]); let recU = null; for (let k = j + 1; k < U.d.length; k++) if (U.c[k] >= hiU[j]) { recU = k - j; break; }
        e.rec = rec; e.recUs = recU;
    }
    return { ev, legs: CL.legs.length };
}

/** 一組事件在 h 天的統計 */
export function statB(ev, h, f = 'diff') {
    const rows = ev.filter(e => e.h[h] && e.h[h][f] != null), x = rows.map(e => e.h[h][f]);
    if (!rows.length) return { n: 0 };
    const half = rows.length >> 1;
    return { n: rows.length, mean: r2(mean(x)), med: r2(med(x)), p: signFlipP(x, 'lo'), pHi: signFlipP(x, 'hi'),
        h1: r2(mean(x.slice(0, half))), h2: r2(mean(x.slice(half))), neg: rows.filter(e => e.h[h][f] < 0).length,
        loc: r2(mean(rows.map(e => e.h[h].loc))), usLoc: r2(mean(rows.map(e => e.h[h].usLoc))), usd: r2(mean(rows.map(e => e.h[h].usd))) };
}

/** 同期間隨便一天(台股收盤買、同一套)「台股 − 標普(台幣)」的平均 —— 只描述(看長期誰比較會漲,⛔ 拿來判) */
export function baseB(A, U, F, h, from) {
    const x = []; for (let i = Math.max(RULE.W - 1, from); i + h < A.d.length; i += 5) {
        const u0 = firstGE(U.d, A.d[i]), u1 = firstGE(U.d, A.d[i + h]); if (u0 < 0 || u1 < 0) continue;
        const f0 = fxOn(F, U.d[u0]), f1 = fxOn(F, U.d[u1]); if (f0 == null || f1 == null) continue;
        x.push((A.c[i + h] / A.c[i] - 1) * 100 - (U.c[u1] / U.c[u0] * (f1 / f0) - 1) * 100);
    }
    return { n: x.length, mean: r2(mean(x)), med: r2(med(x)) };
}

export function judgeB(tw, kr) {
    const R = RULE.B, s = tw.st[R.D][R.h], k = kr.st[R.D][R.h];
    const c = [
        ['台灣 250 天有成績的次數 ≥ ' + R.minN, s.n >= R.minN],
        ['台股 − 標普(台幣)平均 ≤ −' + R.effect + ' 個百分點', s.n > 0 && s.mean <= -R.effect],
        ['正負號隨機翻轉 p(台股比較差那一側)≤ ' + R.p, s.p != null && s.p <= R.p],
        ['前半、後半都 < 0', s.n >= 2 && s.h1 < 0 && s.h2 < 0],
        ['韓股(− 標普換韓元)也 < 0 且 ≥ ' + R.krMinN + ' 次', k.n >= R.krMinN && k.mean < 0],
    ];
    return { pass: c.every(z => z[1]), checks: c.map(([t, ok]) => ({ t, ok })) };
}

// ═══════════════════════════ EXP-C 大跌撿美股 ═══════════════════════════
/** 標普每一段修正裡第一次離 250 天高點 ≥ D% 那天(j);from 之前的 ⛔ 算(那一段照樣用掉) */
export function dipDays(U, D, W = RULE.W, from = RULE.C.from) {
    const hi = rollMax(U.c, W), CL = corrLegs(U.c, W, 10, 5), seen = new Set(), ev = [];
    for (let j = W - 1; j < U.d.length; j++) {
        const k = CL.corr[j]; if (k < 0 || seen.has(k)) continue;
        if (U.c[j] / hi[j] - 1 > -D / 100) continue;
        seen.add(k); if (U.d[j] >= from) ev.push(j);
    }
    return ev;
}
/** 隔一個美股交易日收盤用台幣買(a = j + 1)、抱 h 個美股交易日 → 台幣報酬 %(換不到匯率 / 還沒到期 → null) */
export function usTwdRet(U, F, a, h) {
    const b = a + h; if (a < 0 || b >= U.d.length) return null;
    const f0 = fxOn(F, U.d[a]), f1 = fxOn(F, U.d[b]); if (f0 == null || f1 == null) return null;
    return (U.c[b] / U.c[a] * (f1 / f0) - 1) * 100;
}
export function dipBuy(U, F, D, h, S = null, sims = RULE.C.sims, seed = RULE.seed) {
    const js = dipDays(U, D), rows = [];
    for (const j of js) {
        const r = usTwdRet(U, F, j + 1, h); if (r == null) continue;
        const row = { d: U.d[j], buy: U.d[j + 1], r: r2(r), usd: r2((U.c[j + 1 + h] / U.c[j + 1] - 1) * 100) };
        if (S && S.tr) {   // 同一天改買台股(加權含息):看到之後第一個台股交易日收盤買、賣在台灣日期 ≥ 美股賣出那天的第一個收盤
            const t0 = firstGT(S.d, U.d[j]), t1 = firstGE(S.d, U.d[j + 1 + h]);
            if (t0 >= 0 && t1 > t0 && S.tr[t0] && S.tr[t1]) { row.tw = r2((S.tr[t1] / S.tr[t0] - 1) * 100); row.vsTw = r2(r - row.tw); }
        }
        rows.push(row);
    }
    // 對照:同期間(第一個合格的 a 起)隨便一天買
    const aMin = Math.max(RULE.W, firstGE(U.d, RULE.C.from) + 1), pool = [];
    for (let a = aMin; a + h < U.d.length; a++) { const r = usTwdRet(U, F, a, h); if (r != null) pool.push(r); }
    const o = { D, h, n: rows.length, rows, base: r2(mean(pool)), baseN: pool.length };
    if (rows.length < 2 || pool.length < 30) return o;
    const x = rows.map(z => z.r), em = mean(x), R = rng(seed);
    let ge = 0; for (let s = 0; s < sims; s++) { let t = 0; for (let k = 0; k < x.length; k++) t += pool[Math.floor(R() * pool.length)]; if (t / x.length >= em - 1e-9) ge++; }
    const half = rows.length >> 1, bm = mean(pool);
    Object.assign(o, { mean: r2(em), med: r2(med(x)), diff: r2(em - bm), p: +((ge + 1) / (sims + 1)).toFixed(4),
        h1: r2(mean(x.slice(0, half)) - bm), h2: r2(mean(x.slice(half)) - bm), up: r2(x.filter(v => v > 0).length / x.length * 100),
        upBase: r2(pool.filter(v => v > 0).length / pool.length * 100), worst: r2(Math.min(...x)) });
    const vt = rows.filter(z => z.vsTw != null).map(z => z.vsTw);
    if (vt.length) Object.assign(o, { vsTwN: vt.length, vsTw: r2(mean(vt)), vsTwMed: r2(med(vt)), vsTwP: signFlipP(vt, 'hi'), vsTwWin: vt.filter(v => v > 0).length });
    return o;
}
export function judgeC(grid) {
    const R = RULE.C, g = grid[`${R.D}_${R.h}`] || { n: 0 };
    const nb = R.nbr.map(([D, h]) => grid[`${D}_${h}`]).filter(Boolean), nbOk = nb.filter(z => z.diff != null && z.diff > 0).length;
    const c = [
        ['標普離高點 ≥ ' + R.D + '%、抱 ' + R.h + ' 天有成績的次數 ≥ ' + R.minN, g.n >= R.minN],
        ['比同期間隨便一天買多 ≥ ' + R.effect + ' 個百分點(台幣)', g.diff != null && g.diff >= R.effect],
        ['抽樣 p ≤ ' + R.p, g.p != null && g.p <= R.p],
        ['前半、後半都 > 0', g.h1 != null && g.h1 > 0 && g.h2 > 0],
        [`旁邊 ${R.nbr.length} 格(離高點 10 / 20%、抱 120 / 500 天)≥ ${R.nbrNeed} 格也 > 0`, nbOk >= R.nbrNeed],
    ];
    return { pass: c.every(z => z[1]), nbOk, checks: c.map(([t, ok]) => ({ t, ok })) };
}

// ═══════════════════════════ 只描述 ═══════════════════════════
/** 每月第一個美股交易日存 1 萬台幣:Y 直接買標普;X 先放現金,碰到 EXP-C 的事件(隔天收盤)才把現金全部買進 —— 期末價值 */
export function cashWait(U, F, D = RULE.C.D, from = '2001-01-01') {
    const ev = new Set(dipDays(U, D).map(j => j + 1)), last = U.d.length - 1, fL = fxOn(F, U.d[last]);
    let uY = 0, uX = 0, cash = 0, put = 0, m0 = '';
    for (let a = firstGE(U.d, from); a >= 0 && a <= last; a++) {
        const fx = fxOn(F, U.d[a]); if (fx == null) continue;
        const px = U.c[a] * fx;
        if (U.d[a].slice(0, 7) !== m0) { m0 = U.d[a].slice(0, 7); put += 1; uY += 1 / px; cash += 1; }
        if (ev.has(a) && cash > 0) { uX += cash / px; cash = 0; }
    }
    const pL = U.c[last] * fL;
    return { from, to: U.d[last], put, y: r2(uY * pL), x: r2(uX * pL + cash), cashLeft: r2(cash), ratio: r2((uX * pL + cash) / (uY * pL)) };
}
/** 一半加權含息 + 一半標普(台幣,價格)每年第一個台股交易日再平衡 vs 全部加權含息(台股日曆;美股用台股那天之前最後一個收盤) */
export function mix5050(S, U, F, from = '2003-01-02') {
    const usTw = i => { const j = lastLT(U.d, S.d[i]), f = j >= 0 ? fxOn(F, U.d[j]) : null; return j >= 0 && f != null ? U.c[j] * f : null; };
    let i0 = firstGE(S.d, from); while (i0 >= 0 && i0 < S.d.length && (!S.tr[i0] || usTw(i0) == null)) i0++;
    let wT = 0.5, wU = 0.5, pT = S.tr[i0], pU = usTw(i0), y0 = S.d[i0].slice(0, 4), peak = 1, peakA = 1, mdd = 0, mddA = 0;
    const yr = {}, yrA = {}; let v = 1, vA = 1, yv = 1, yvA = 1;
    for (let i = i0 + 1; i < S.d.length; i++) {
        const t = S.tr[i], u = usTw(i); if (!t || u == null) continue;
        v = wT * (t / pT) + wU * (u / pU); vA = vA * (t / S.tr[i - 1] || 1);
        const y = S.d[i].slice(0, 4);
        if (y !== y0) { yr[y0] = r2((v / yv - 1) * 100); yrA[y0] = r2((vA / yvA - 1) * 100); yv = v; yvA = vA; y0 = y; wT = v / 2; wU = v / 2; pT = t; pU = u; }
        peak = Math.max(peak, v); peakA = Math.max(peakA, vA); mdd = Math.min(mdd, v / peak - 1); mddA = Math.min(mddA, vA / peakA - 1);
    }
    yr[y0] = r2((v / yv - 1) * 100); yrA[y0] = r2((vA / yvA - 1) * 100);
    const yrs = (T(S.d[S.d.length - 1]) - T(S.d[i0])) / (365.25 * 864e5), cagr = x => r2((Math.pow(x, 1 / yrs) - 1) * 100);
    const worst = o => { const k = Object.keys(o).reduce((a, b) => o[a] <= o[b] ? a : b); return [k, o[k]]; };
    return { from: S.d[i0], to: S.d[S.d.length - 1], mix: { x: r2(v), cagr: cagr(v), mdd: r2(mdd * 100), worst: worst(yr) }, tw: { x: r2(vA), cagr: cagr(vA), mdd: r2(mddA * 100), worst: worst(yrA) }, yr, yrA };
}
/** 外資現貨(億)事件那天(含)之前 20 個交易日合計 —— 只描述 */
export function fiBefore(FM, d, n = 20) {
    if (!FM || !FM.spot) return null;
    const ks = Object.keys(FM.spot).map(k => k.replace(/\//g, '-').slice(0, 10)).sort(), m = new Map(Object.entries(FM.spot).map(([k, v]) => [k.replace(/\//g, '-').slice(0, 10), Array.isArray(v) ? +v[0] : null]));
    const e = lastLE(ks, d); if (e < n - 1 || ks[0] > d) return null;
    let s = 0; for (let k = e - n + 1; k <= e; k++) { const x = m.get(ks[k]); if (x == null || !isFinite(x)) return null; s += x; }
    return r2(s);
}

// ═══════════════════════════ 跑 ═══════════════════════════
export function run(S0, U0, K0, F0, FK0, FM = null, log = console.log) {
    const S = cutSer(S0, RULE.cut), U = cutSer(U0, RULE.cut), K = cutSer(K0, RULE.cut), F = cutFx(F0, RULE.cut), FK = cutFx(FK0, RULE.cut);
    const out = { meta: { cut: RULE.cut, tw: [S.d[0], S.d.at(-1)], us: [U.d[0], U.d.at(-1)], kr: [K.d[0], K.d.at(-1)], fx: [F.d[0], F.d.at(-1)], rule: RULE } };
    // ── EXP-B
    const B = RULE.B, tw = { st: {} }, kr = { st: {} };
    for (const D of B.Ds) {
        const a = coCrash(S, U, F, D, B.hs), b = coCrash(K, U, FK, D, B.hs);
        tw.st[D] = {}; kr.st[D] = {};
        for (const h of B.hs) { tw.st[D][h] = statB(a.ev, h); kr.st[D][h] = statB(b.ev, h); tw.st[D][h].tr = statB(a.ev, h, 'diffTr'); }
        if (D === B.D) { tw.ev = a.ev; kr.ev = b.ev; tw.legs = a.legs; kr.legs = b.legs; }
    }
    const i2003 = firstGE(S.d, '2001-01-01');
    tw.base = { 120: baseB(S, U, F, 120, i2003), 250: baseB(S, U, F, 250, i2003) };
    if (FM) {   // 外資:一起大跌那幾次 vs 只有台股離高點 ≥ D%(標普 < D%)的那幾次 —— 只描述
        const hiS = rollMax(S.c, RULE.W), hiU = rollMax(U.c, RULE.W), CL = corrLegs(S.c, RULE.W, 10, 5), seen = new Set(), solo = [];
        for (let i = RULE.W - 1; i < S.d.length; i++) {
            const k = CL.corr[i]; if (k < 0 || seen.has(k) || S.c[i] / hiS[i] - 1 > -B.D / 100) continue;
            seen.add(k); const j = lastLT(U.d, S.d[i]); if (j >= RULE.W - 1 && U.c[j] / hiU[j] - 1 > -B.D / 100) solo.push(S.d[i]);
        }
        const co = tw.ev.map(e => fiBefore(FM, e.d)).filter(v => v != null), so = solo.map(d => fiBefore(FM, d)).filter(v => v != null);
        tw.fi = { co: { n: co.length, mean: r2(mean(co)), med: r2(med(co)) }, solo: { n: so.length, mean: r2(mean(so)), med: r2(med(so)), dates: solo } };
    }
    out.B = { tw, kr, judge: judgeB(tw, kr) };
    // ── EXP-C
    const C = RULE.C, grid = {};
    for (const D of C.Ds) for (const h of C.hs) grid[`${D}_${h}`] = dipBuy(U, F, D, h, S);
    out.C = { grid, judge: judgeC(grid), cashWait: { 10: cashWait(U, F, 10), 15: cashWait(U, F, 15), 20: cashWait(U, F, 20) }, mix: mix5050(S, U, F) };
    print(out, log);
    return out;
}

export function print(o, log = console.log) {
    const B = o.B, C = o.C, R = RULE;
    log(`===== 🌎 全球一起大跌 / 大跌撿美股:加權 ${o.meta.tw.join('~')}・標普 ${o.meta.us.join('~')}・韓國 ${o.meta.kr.join('~')}・台幣匯率 ${o.meta.fx.join('~')}(判定只用到 ${R.cut})=====`);
    log(`\n── EXP-B 台股 vs 標普(台幣):兩邊都離 250 天高點 ≥ D%(台股每段第一次)→ 台股那天收盤買 vs 同一晚標普收盤買,h 天後 ──`);
    for (const D of R.B.Ds) for (const h of R.B.hs) { const s = B.tw.st[D][h], t = s.tr, k = B.kr.st[D][h];
        log(`  D ${D}% ・ ${h} 天:台灣 ${s.n} 次 台股 ${s.loc}% vs 標普(台幣)${s.usLoc}%(美元 ${s.usd}%)→ 差 ${s.mean}(中位 ${s.med}、台股比較差 ${s.neg}/${s.n}、p ${s.p}、前半 ${s.h1} / 後半 ${s.h2})`
            + `・含息版差 ${t.mean}(${t.n} 次)・韓國 ${k.n} 次 差 ${k.mean}(p ${k.p})`); }
    log(`  對照(只描述):隨便一天 台股 − 標普(台幣)120 天 ${B.tw.base[120].mean}・250 天 ${B.tw.base[250].mean}(長期誰比較會漲,⛔ 拿來判)`);
    log(`  事件(D ${R.B.D}%):`);
    for (const e of B.tw.ev) { const h = e.h[R.B.h] || {}; log(`   ${e.d}(標普 ${e.usd})台股離高點 ${e.dd}% / 標普 ${e.ddUs}% → 250 天 台股 ${h.loc ?? '—'}% 標普台幣 ${h.usLoc ?? '—'}% 差 ${h.diff ?? '—'}・之後再跌 ${e.more}%・回前高 台股 ${e.rec ?? '還沒'} / 標普 ${e.recUs ?? '還沒'} 個交易日`); }
    if (B.tw.fi) log(`  外資(只描述):一起大跌那幾次前 20 天合計 ${B.tw.fi.co.mean} 億(中位 ${B.tw.fi.co.med}、${B.tw.fi.co.n} 次)vs 只有台股跌那幾次 ${B.tw.fi.solo.mean} 億(${B.tw.fi.solo.n} 次)`);
    log(`  ⭐ EXP-B 判定:${B.judge.pass ? '✅' : '⛔'} ${B.judge.checks.map(c => (c.ok ? '✓' : '✗') + c.t).join(' / ')}`);
    log(`\n── EXP-C 標普離 250 天高點 ≥ D%(每段第一次)→ 隔天收盤用台幣買、抱 h 個美股交易日 vs 同期間隨便一天買 ──`);
    for (const D of R.C.Ds) for (const h of R.C.hs) { const g = C.grid[`${D}_${h}`];
        log(`  D ${D}% ・ ${h} 天:${g.n} 次 平均 ${g.mean ?? '—'}%(中位 ${g.med ?? '—'}、有賺 ${g.up ?? '—'}%、最差 ${g.worst ?? '—'})vs 隨便一天 ${g.base}%(有賺 ${g.upBase ?? '—'}%)→ 多 ${g.diff ?? '—'}(p ${g.p ?? '—'}、前半 ${g.h1 ?? '—'} / 後半 ${g.h2 ?? '—'})`
            + (g.vsTwN ? `・比同一天買加權含息 ${g.vsTw}(中位 ${g.vsTwMed}、贏 ${g.vsTwWin}/${g.vsTwN}、p ${g.vsTwP})` : '')); }
    const g0 = C.grid[`${R.C.D}_${R.C.h}`];
    for (const z of g0.rows) log(`   ${z.d} → ${z.buy} 買:台幣 ${z.r}%(美元 ${z.usd}%)${z.tw != null ? `・同一天買加權含息 ${z.tw}%` : ''}`);
    for (const D of [10, 15, 20]) { const w = C.cashWait[D]; log(`  只描述:每月存 1 萬,先放現金等標普離高點 ≥ ${D}% 才買 → ${w.x} 萬 vs 每月直接買 ${w.y} 萬(${w.ratio} 倍、手上還有現金 ${w.cashLeft} 萬;${w.from}~${w.to}、共存 ${w.put} 萬)`); }
    const m = C.mix; log(`  只描述:一半加權含息 + 一半標普(台幣,價格)每年再平衡 vs 全部加權含息(${m.from}~${m.to}):${m.mix.x} 倍(年化 ${m.mix.cagr}%、最多賠 ${m.mix.mdd}%、最差一年 ${m.mix.worst.join(' ')}%)vs ${m.tw.x} 倍(年化 ${m.tw.cagr}%、最多賠 ${m.tw.mdd}%、最差一年 ${m.tw.worst.join(' ')}%)`);
    log(`  ⭐ EXP-C 判定:${C.judge.pass ? '✅' : '⛔'} ${C.judge.checks.map(c => (c.ok ? '✓' : '✗') + c.t).join(' / ')}`);
}

// ═══════════════════════════ selftest ═══════════════════════════
export function bdays(n, y = 2001) { const out = []; let t = Date.UTC(y, 0, 1); while (out.length < n) { const w = new Date(t).getUTCDay(); if (w && w < 6) out.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; } return out; }
function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + x}`); if (!c) bad++; };
    ok('① firstGE / firstGT / lastLE / lastLT', firstGE(['a', 'c', 'e'], 'c') === 1 && firstGT(['a', 'c', 'e'], 'c') === 2 && lastLE(['a', 'c', 'e'], 'd') === 1 && lastLT(['a', 'c', 'e'], 'c') === 0 && firstGE(['a'], 'b') === -1 && lastLT(['b'], 'a') === -1);
    const F = { d: ['2001-01-01', '2001-01-10', '2001-03-01'], v: [30, 31, 32] };
    ok('① fxOn:那天或之前最後一筆;隔超過 10 天 → null', fxOn(F, '2001-01-10') === 31 && fxOn(F, '2001-01-15') === 31 && fxOn(F, '2001-01-25') === null && fxOn(F, '2000-12-31') === null);
    ok('② 正負號翻轉:全部是負的 8 筆 → p = 1/256;一正一負對稱 → p 0.75', signFlipP([-1, -2, -3, -1, -2, -3, -1, -2]) === +(1 / 256).toFixed(4) && signFlipP([1, -1]) === 0.75, signFlipP([1, -1]));
    // 合成市場:台股 / 標普每 500 天一起跌 30% 再回來;匯率固定 30
    const N = 4000, d = bdays(N), wave = (i, amp) => 100 * (1 + i / N) * (1 - amp * Math.max(0, Math.sin((i % 500) / 500 * Math.PI * 2)));
    const mk = (amp, slow = 0) => ({ d: d.slice(), c: d.map((_, i) => wave(i, amp) * (slow && (i % 500) > 250 ? 1 - slow * ((i % 500) - 250) / 250 : 1)) });
    const Fx = { d: d.slice(), v: d.map(() => 30) };
    const A0 = mk(0.3), U0 = mk(0.3);
    const c0 = coCrash(A0, U0, Fx, 15, [120, 250]);
    ok('③ 一起大跌事件:每 500 天一次、看得到的標普日期 < 台股日期', c0.ev.length >= 5 && c0.ev.every(e => e.usd < e.d), JSON.stringify(c0.ev.slice(0, 2).map(e => [e.d, e.usd])));
    const s0 = statB(c0.ev, 250);
    ok('③ 兩邊一模一樣 → 差 = 0、⛔ 判成台股比較差', Math.abs(s0.mean) < 0.01 && !judgeB({ st: { 15: { 250: s0 } } }, { st: { 15: { 250: s0 } } }).pass, JSON.stringify(s0));
    // 埋效果:台股那段後半一路落後(回得慢)→ 差 < −5、p 小
    const A1 = { d: d.slice(), c: A0.c.map((x, i) => x * Math.pow(0.9997, i % 500 > 100 ? (i % 500) - 100 : 0) * ((i % 500) > 100 ? 1 : 1)) };
    const c1 = coCrash(A1, U0, Fx, 15, [120, 250]), s1 = statB(c1.ev, 250);
    const j1 = judgeB({ st: { 15: { 250: s1 } } }, { st: { 15: { 250: s1 } } });
    ok('④ 埋「台股回得慢」→ 判得出來(差 ≤ −5、p ≤ 0.05、前後半 < 0)', j1.pass, JSON.stringify(s1));
    // ⑤ 匯率換算對手算:台幣從 30 → 33(美元升 10%)、標普 +10% → 台幣 +21%
    const U2 = { d: bdays(600), c: bdays(600).map((_, i) => i < 300 ? 100 : 110) }, F2 = { d: U2.d, v: U2.d.map((_, i) => i < 300 ? 30 : 33) };
    const r2_ = usTwdRet(U2, F2, 10, 400);
    ok('⑤ 台幣報酬 = (1 + 10%) × (33 / 30) − 1 = 21%', Math.abs(r2_ - 21) < 1e-9, r2_);
    // ⑥ EXP-C:每一段修正第一次離高點 ≥ 15%;隔天才買
    const js = dipDays(U0, 15, 250, '2001-01-01');
    ok('⑥ 撿美股事件:每 500 天一段、每段一次', js.length >= 5 && new Set(js.map(j => Math.floor(j / 500))).size === js.length, js.join(','));
    // 埋效果:大跌之後一定反彈(合成波動本來就是)→ diff > 0;沒埋:隨機漫步 → 判不出
    const d8 = bdays(9000), U8 = { d: d8, c: d8.map((_, i) => 100 * (1 + i / 9000) * (1 - 0.35 * Math.max(0, Math.sin((i % 500) / 500 * Math.PI * 2)))) }, F8 = { d: d8, v: d8.map(() => 30) };
    const g1 = {}; for (const D of [10, 15, 20]) for (const h of [120, 250, 500]) g1[`${D}_${h}`] = dipBuy(U8, F8, D, h, null, 1000);
    ok('⑦ 埋「大跌之後會回來」→ EXP-C 判得出來', judgeC(g1).pass, JSON.stringify(judgeC(g1).checks.map(c => c.ok)));
    const R = rng(3), rw = [100]; for (let i = 1; i < N; i++) rw.push(rw[i - 1] * (1 + (R() - 0.4997) * 0.03));
    const Urw = { d: d.slice(), c: rw }, g2 = {}; for (const D of [10, 15, 20]) for (const h of [120, 250, 500]) g2[`${D}_${h}`] = dipBuy(Urw, Fx, D, h, null, 1000);
    ok('⑦ 沒埋(隨機漫步)→ EXP-C 判不出來', !judgeC(g2).pass, JSON.stringify(g2['15_250'] && [g2['15_250'].n, g2['15_250'].diff, g2['15_250'].p]));
    // ⑧ 偷看未來:把「看得到的標普」改成同一天(lastLE)→ 事件日期會變(注入的版本要判得出不一樣)
    const Ushift = { d: U0.d.slice(), c: U0.c.slice() };
    const evLE = (() => { const hiA = rollMax(A0.c, 250), hiU = rollMax(Ushift.c, 250), CL = corrLegs(A0.c, 250, 10, 5), seen = new Set(), ev = [];
        for (let i = 249; i < A0.d.length; i++) { const k = CL.corr[i]; if (k < 0 || seen.has(k) || A0.c[i] / hiA[i] - 1 > -0.15) continue; const j = lastLE(Ushift.d, A0.d[i]); if (j < 249 || Ushift.c[j] / hiU[j] - 1 > -0.15) continue; seen.add(k); ev.push({ d: A0.d[i], usd: Ushift.d[j] }); } return ev; })();
    ok('⑧ 對照:同一天的標普(偷看)那一版 usd = 台股日期 → 真的那一版每一筆 usd 都比較早(守門有作用)', evLE.some(e => e.usd === e.d) && c0.ev.every(e => e.usd < e.d));
    // ⑨ 封存日之後亂改 → 判定一模一樣
    const dd = bdays(7300, 2000), wv = i => 100 * (1 + i / 7300) * (1 - 0.3 * Math.max(0, Math.sin((i % 500) / 500 * Math.PI * 2)));
    const mkS = () => ({ d: dd.slice(), c: dd.map((_, i) => wv(i)), tr: dd.map((_, i) => wv(i) * (1 + i / 20000)) }), Fx9 = { d: dd.slice(), v: dd.map(() => 30) };
    const q = () => {}, Sa = mkS(), Ua = mkS(), Ka = mkS();
    ok('⑨ 合成資料真的跨過封存日(不然這一條沒有鑑別力)', dd.at(-1) > RULE.cut, dd.at(-1));
    const oA = run(Sa, Ua, Ka, Fx9, Fx9, null, q);
    const garb = X => ({ ...X, c: X.c.map((x, i) => X.d[i] > RULE.cut ? x * (i % 2 ? 3 : 0.2) : x), tr: X.tr ? X.tr.map((x, i) => X.d[i] > RULE.cut ? x * 5 : x) : undefined });
    const Fg = { d: Fx9.d, v: Fx9.v.map((x, i) => Fx9.d[i] > RULE.cut ? 99 : x) };
    const oB = run(garb(Sa), garb(Ua), garb(Ka), Fg, Fg, null, q);
    const key = o => JSON.stringify([o.B.judge, o.B.tw.st, o.B.kr.st, o.C.judge, o.C.grid['15_250']]);
    ok('⑨ 封存日之後的價格與匯率亂改 → EXP-B / EXP-C 判定與數字一模一樣', key(oA) === key(oB));
    // ⑩ 外資:事件那天(含)之前 20 天合計
    const sp = {}; bdays(30).forEach((x, k) => { sp[x] = [k < 10 ? 0 : -10, 0]; });
    ok('⑩ 外資 20 天合計(最後 20 天都 −10 → −200;不到 20 天 → null)', fiBefore({ spot: sp }, bdays(30)[29]) === -200 && fiBefore({ spot: sp }, bdays(30)[10]) === null, fiBefore({ spot: sp }, bdays(30)[29]));
    // ⑪ 5050:兩邊一樣 → 跟全部台股同一個倍數
    const S11 = { d: dd.slice(0, 1500), c: dd.slice(0, 1500).map((_, i) => 100 + i), tr: dd.slice(0, 1500).map((_, i) => 100 + i) };
    const U11 = { d: dd.slice(0, 1500), c: S11.c.slice() }, m11 = mix5050(S11, U11, { d: dd.slice(0, 1500), v: dd.slice(0, 1500).map(() => 30) }, '2000-01-03');
    ok('⑪ 一半一半:兩邊走勢一樣 → 倍數差不到 2%(美股晚一天收盤)', Math.abs(m11.mix.x / m11.tw.x - 1) < 0.02, JSON.stringify([m11.mix.x, m11.tw.x]));
    let threw = false; try { loadWorld(Buffer.from(JSON.stringify({ s: {} })), '^GSPC'); } catch (_) { threw = true; }
    ok('⑫ world_hist 沒有 ^GSPC → 丟例外(⛔ 當成沒事件)', threw);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ GLOBAL_CRASH_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('global_crash_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(process.env);
    for (const k of ['FRED_HIST', 'WORLD_HIST']) if (!process.env[k]) throw new Error(k + ' 沒給');
    const FJ = JSON.parse(fs.readFileSync(process.env.FRED_HIST, 'utf8')), WB = fs.readFileSync(process.env.WORLD_HIST);
    const F = loadFx(FJ, 'usdtwd'), FK = loadFx(FJ, 'krw'), U = loadWorld(WB, '^GSPC'), K = loadWorld(WB, '^KS11');
    const FM = process.env.FI_HIST ? JSON.parse(fs.readFileSync(process.env.FI_HIST, 'utf8')) : null;
    const out = run(S, U, K, F, FK, FM);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
