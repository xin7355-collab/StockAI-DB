#!/usr/bin/env node
/**
 * 📉🛑 高檔 + 外資拋售 + 大盤大跌:之後會不會真的跌?👑 該不該先停手?(V79.3.6)
 *
 * 使用者 2026-10-19(截圖:加權 47,111、外資台指期 −93,675 口、10/15 外資現貨賣 3,025 億、今天大盤收綠):
 *   「最近遇到台股高點又有新聞說外資拋售潮,今天大盤都收綠,回測這些有先找嗎?要避開嗎?以領頭羊策略來說。
 *    如果爾後都是這樣,是否要先不要操作?」→ 回覆:「沒有資料,該回測就回測、該挖礦就挖礦」
 * ⭐ 以前測不了的原因是**沒資料**:外資台指期只有 90 天、外資現貨只有個股 2023-06 起。
 *    → 先挖 data/fi_mkt_hist.json(fi_mkt_miner.py:上市外資現貨 2004 起、外資台指期 2018 起、整體融資 2004 起),再測。
 *
 * 訊號(⭐ 全部「那天收盤後」才知道:指數收盤 + 當天晚上公布的法人 / 期貨 / 融資):
 *   S1 hiDrop    加權離一年最高 ≤5%(近高)+ 當天跌 ≥ X%
 *   S2 fiSell5   外資現貨 5 日合計在自己過去 3 年的位階 ≤ X(賣得比過去九成以上的時候都兇);S2h = 再加「近高」
 *   S3 fiStreak  外資現貨真連續賣超 ≥ X 天;S3h = 再加「近高」
 *   S3d fiDay    外資現貨單日賣超位階 ≤ X(像 10/15 的 −3,025 億);S3dh = 再加「近高」
 *   S4a fiFutCut ⭐ App `_fiFutState` 的「🚨 急遽加空」:外資台指期淨未平倉 5 日變化 ≤ −X 口(App 用 8,000)
 *   S4b fiFutLow App 的「⛔ 空單近期最重」:淨未平倉在近 20 天區間位階 ≤ X(App 用 15)
 *   S5 mgHot     整體融資 20 日增幅在自己過去 3 年的位階 ≥ X + 近高(「散戶追高」)
 *   S6 combo     今天這種:近高 + 當天跌 ≥1.5% + 外資 5 日賣超位階 ≤20
 * 兩種結果:
 *   ① 大盤:之後 60 天再跌 ≥10% 的機率 vs 平常 —— 直接用 crash_warn_probe 的 assess / bh(六關:全期・分段・逐年・去最好那段・高原・平移安慰劑 BH)
 *      ⚠️ 判讀時一律把訊號**晚一天**(那天晚上才知道 → 隔天收盤才動得了),⛔ 不用當天收盤。
 *   ② 👑:訊號那天收盤起 K 個交易日不開新倉(leader_probe `pause`,⛔ 不設時逐位相同 selftest ㊿d),
 *      兩窗口(AI 時代 2022-09-16 / 長歷史 2011-01-03)× 17 條起點,對照 = 現行 + 停手日子整段平移的安慰劑(天數、一串一串的樣子都一樣)。
 *      ⚠️ 換倉日是收盤決定、隔天開盤成交 → 當天晚上公布的法人資料**來得及**擋隔天的買單(跟 App 的實際作業一致)。
 *
 * 跑法:
 *   IDX_LONG=$S/cw_idx_long.json IDX_EARLY=$S/cw_idx_long_early.json TWII_NOW=$S/cw_^TWII.json FI_MKT=$S/fi_mkt_hist.json \
 *   DATA_DIR=$S/d10n DIV=data/dividends_hist.json node --max-old-space-size=8192 scripts/hightop_sell_probe.mjs out.json
 *   (不給 DATA_DIR → 只跑 ① 大盤那一段)・LEAD_K=10 停手天數 ・SHAMS=20 安慰劑次數(停手日子整段平移)
 *   HIDROP_GRID=1 → 改跑「近高 × 跌幅 × 停手天數」高原(3×5×3 格 × 兩窗口,沒有安慰劑);再加 GRID_KEY=fiSell5h 等 → 那個訊號自己的門檻格 × 停手天數
 *   node scripts/hightop_sell_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadIndex, features, labelDown, labelUp, episodes, fastCrashes, assess, bh, pctTrail, SEGS } from './crash_warn_probe.mjs';
import { loadCtx, simulate, metrics, rng } from './leader_probe.mjs';

const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const r2 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(2);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
export const NEAR = 5;                 // 「近高」= 離一年最高 ≤5%
export const PCT_WIN = 750, PCT_MIN = 250;
export const WINS = ['2022-09-16', '2011-01-03'];
const STEP = 3, PATHS = 17;

/** fi_mkt_hist.json → 對齊加權交易日的同日陣列(⛔ 不往前補:那天沒資料就是 null) */
export function alignFi(dates, FI) {
    const n = dates.length, spot = new Array(n).fill(null), fut = new Array(n).fill(null), mg = new Array(n).fill(null);
    const S = FI.spot || {}, U = FI.fut || {}, M = FI.mg || {};
    for (let i = 0; i < n; i++) {
        const d = dates[i];
        if (Array.isArray(S[d]) && Number.isFinite(+S[d][0])) spot[i] = +S[d][0];
        if (Number.isFinite(+U[d]) && U[d] !== null) fut[i] = +U[d];
        if (Number.isFinite(+M[d]) && M[d] !== null) mg[i] = +M[d];
    }
    return { spot, fut, mg };
}

/** 外部序列的衍生量(全部只用 ≤ i):5 日合計、真連續賣超天數、期貨 5 日變化 / 20 日區間位階(= App _fiFutState)、融資 20 日增幅 */
export function fiFeatures(A) {
    const n = A.spot.length;
    const sum5 = new Array(n).fill(null), streak = new Array(n).fill(null), fchg5 = new Array(n).fill(null), fpos20 = new Array(n).fill(null), mg20 = new Array(n).fill(null);
    let run = 0;
    for (let i = 0; i < n; i++) {
        const v = A.spot[i];
        if (v == null) { run = 0; } else { run = v < 0 ? run + 1 : 0; streak[i] = run; }
        if (i >= 4) { let s = 0, ok = true; for (let k = i - 4; k <= i; k++) { if (A.spot[k] == null) { ok = false; break; } s += A.spot[k]; } if (ok) sum5[i] = s; }
        // 期貨:跟 App 一樣用「有資料的最後 N 筆」(App 讀 risk_history 每天一筆)
        if (A.fut[i] != null) {
            const hist = []; for (let k = i; k >= 0 && hist.length < 20; k--) if (A.fut[k] != null) hist.push(A.fut[k]);
            hist.reverse();
            if (hist.length >= 6) fchg5[i] = hist[hist.length - 1] - hist[hist.length - 6];
            if (hist.length >= 8) { const lo = Math.min(...hist), hi = Math.max(...hist); if (hi > lo) fpos20[i] = (A.fut[i] - lo) / (hi - lo) * 100; }
        }
        if (i >= 20 && A.mg[i] != null && A.mg[i - 20] != null && A.mg[i - 20] > 0) mg20[i] = A.mg[i] / A.mg[i - 20] - 1;
    }
    const day = A.spot.map(v => v == null ? null : v);
    return { sum5, streak, fchg5, fpos20, mg20, sum5Pct: pctTrail(sum5, PCT_WIN, PCT_MIN), dayPct: pctTrail(day, PCT_WIN, PCT_MIN), mg20Pct: pctTrail(mg20, PCT_WIN, PCT_MIN) };
}

/** App `_fiFutState` 的分級(⛔ 這裡只為了跨檔比對;門檻照 App)*/
export function fiFutLevel(chg5, pct) {
    if (chg5 == null && pct == null) return 'unknown';
    if (chg5 != null && chg5 <= -8000) return 'danger';
    if (chg5 != null && chg5 >= 8000) return 'good';
    if (pct != null && pct <= 15) return 'warn';
    if (pct != null && pct >= 85) return 'good';
    if (chg5 != null && chg5 <= -3000) return 'warn';
    if (chg5 != null && chg5 >= 3000) return 'good';
    return 'neutral';
}

const toSig = (n, f) => { const s = new Int8Array(n).fill(-1); for (let i = 0; i < n; i++) { const v = f(i); if (v != null) s[i] = v ? 1 : 0; } return s; };
/** 晚一天:sig'[i] = sig[i−1](那天晚上才知道 → 隔天收盤才動得了)*/
export function lag1(sig) { const o = new Int8Array(sig.length).fill(-1); for (let i = 1; i < sig.length; i++) o[i] = sig[i - 1]; return o; }

/** 訊號定義:build(th) 回「同一天」的 0/1/−1(收盤後知道)。assess 用的是 lag1 過的版本 */
export function signalDefs(F, X) {
    const n = F.n, defs = [];
    const near = (i, x = NEAR) => F.dd252[i] == null ? null : F.dd252[i] >= -x / 100;
    const and = (...vs) => vs.some(v => v == null) ? null : vs.every(Boolean);
    const add = o => defs.push(o);
    add({ key: 'hiDrop', name: `近高(離一年最高 ≤${NEAR}%)+ 當天跌 ≥ X%`, g: '大盤', def: 2, grid: [1, 1.5, 2, 2.5, 3],
          build: th => toSig(n, i => and(near(i), F.ret[i] == null ? null : F.ret[i] <= -th / 100)) });
    add({ key: 'hiDrop3', name: '近高(≤3%)+ 當天跌 ≥ X%', g: '大盤', def: 2, grid: [1, 1.5, 2, 2.5, 3],
          build: th => toSig(n, i => and(near(i, 3), F.ret[i] == null ? null : F.ret[i] <= -th / 100)) });
    add({ key: 'fiSell5', name: '外資現貨 5 日合計位階 ≤ X(賣得最兇)', g: '外資現貨', def: 10, grid: [3, 5, 10, 15, 20],
          build: th => toSig(n, i => X.sum5Pct[i] == null ? null : X.sum5Pct[i] <= th) });
    add({ key: 'fiSell5h', name: '近高 + 外資現貨 5 日合計位階 ≤ X', g: '外資現貨', def: 10, grid: [3, 5, 10, 15, 20],
          build: th => toSig(n, i => and(near(i), X.sum5Pct[i] == null ? null : X.sum5Pct[i] <= th)) });
    add({ key: 'fiStreak', name: '外資現貨真連續賣超 ≥ X 天', g: '外資現貨', def: 5, grid: [3, 4, 5, 6, 7],
          build: th => toSig(n, i => X.streak[i] == null ? null : X.streak[i] >= th) });
    add({ key: 'fiStreakH', name: '近高 + 外資現貨真連續賣超 ≥ X 天', g: '外資現貨', def: 5, grid: [3, 4, 5, 6, 7],
          build: th => toSig(n, i => and(near(i), X.streak[i] == null ? null : X.streak[i] >= th)) });
    add({ key: 'fiDay', name: '外資現貨單日賣超位階 ≤ X', g: '外資現貨', def: 2, grid: [0.5, 1, 2, 3, 5],
          build: th => toSig(n, i => X.dayPct[i] == null ? null : X.dayPct[i] <= th) });
    add({ key: 'fiDayH', name: '近高 + 外資現貨單日賣超位階 ≤ X', g: '外資現貨', def: 2, grid: [0.5, 1, 2, 3, 5],
          build: th => toSig(n, i => and(near(i), X.dayPct[i] == null ? null : X.dayPct[i] <= th)) });
    add({ key: 'fiFutCut', name: '外資台指期 5 日加空 ≥ X 口(App「急遽加空」= 8,000)', g: '外資期貨', def: 8000, grid: [4000, 6000, 8000, 10000, 12000],
          build: th => toSig(n, i => X.fchg5[i] == null ? null : X.fchg5[i] <= -th) });
    add({ key: 'fiFutLow', name: '外資台指期淨未平倉 20 日位階 ≤ X(App「空單近期最重」= 15)', g: '外資期貨', def: 15, grid: [5, 10, 15, 20, 25],
          build: th => toSig(n, i => X.fpos20[i] == null ? null : X.fpos20[i] <= th) });
    add({ key: 'mgHot', name: '近高 + 整體融資 20 日增幅位階 ≥ X(散戶追高)', g: '融資', def: 90, grid: [80, 85, 90, 95, 97.5],
          build: th => toSig(n, i => and(near(i), X.mg20Pct[i] == null ? null : X.mg20Pct[i] >= th)) });
    add({ key: 'combo', name: '今天這種:近高 + 當天跌 ≥ X% + 外資 5 日賣超位階 ≤20', g: '組合', def: 1.5, grid: [1, 1.25, 1.5, 2, 2.5],
          build: th => toSig(n, i => and(near(i), F.ret[i] == null ? null : F.ret[i] <= -th / 100, X.sum5Pct[i] == null ? null : X.sum5Pct[i] <= 20)) });
    return defs;
}

const readJ = (p, must) => {
    if (!p) { if (must) throw new Error('缺必要輸入'); return null; }
    try { const t = fs.readFileSync(p, 'utf8'); if (!t.trim()) throw new Error('空檔'); return JSON.parse(t); }
    catch (e) { if (must) throw new Error(`${p} 讀不到(${e.message})`); return null; }
};

/** ① 大盤:對每個訊號跑 crash_warn 的整套關卡(訊號晚一天)*/
export function marketPart(env, log = console.log) {
    const long = readJ(env.IDX_LONG, true), early = readJ(env.IDX_EARLY, false), now = readJ(env.TWII_NOW, false);
    const FI = readJ(env.FI_MKT, true);
    if (!FI.spot || Object.keys(FI.spot).length < 1000) throw new Error('FI_MKT 外資現貨 < 1,000 天(⛔ 沒資料不跑)');
    const { rows, tr } = loadIndex({ long, early, now });
    const dates = rows.map(r => r.d), n = rows.length;
    const F = features(rows), A = alignFi(dates, FI), X = fiFeatures(A);
    const cov = k => A[k].filter(v => v != null).length;
    log(`📈 加權 ${n} 天 ${dates[0]} ~ ${dates[n - 1]} ・對得上的:外資現貨 ${cov('spot')} 天 ・外資台指期 ${cov('fut')} 天 ・融資 ${cov('mg')} 天`);
    const labs = { dn60: labelDown(F.C, 60, 10), dn20: labelDown(F.C, 20, 10), deep: labelDown(F.C, 120, 20), up60: labelUp(F.C, 60, 10) };
    const eps = { L10: episodes(rows, 10), L15: episodes(rows, 15), L20: episodes(rows, 20) };
    const ctx = { F, dates, labs, eps, fast: fastCrashes(F.C), tr };
    const defs = signalDefs(F, X);
    const res = defs.map(d => {
        const lagged = { ...d, build: th => lag1(d.build(th)) };
        const r = assess(lagged, ctx);
        const raw = d.build(d.def);
        let last = -1; for (let i = n - 1; i >= 0; i--) if (raw[i] >= 0) { last = i; break; }
        r.today = last >= 0 ? { d: dates[last], on: raw[last] === 1 } : null;
        r.first = (() => { for (let i = 0; i < n; i++) if (raw[i] >= 0) return dates[i]; return null; })();
        return r;
    });
    const q = bh(res.map(r => r.p));
    res.forEach((r, i) => { r.q = q[i] == null ? null : +q[i].toFixed(4); r.gates['⑥安慰劑'] = r.q != null && r.q <= 0.05 && r.lift > 0;
        r.pass = Object.values(r.gates).every(Boolean); r.nPass = Object.values(r.gates).filter(Boolean).length; });
    const nowX = (() => { const i = n - 1; return { d: dates[i], dd252: r2(F.dd252[i] * 100), ret: r2(F.ret[i] * 100), spot: A.spot[i], sum5: r2(X.sum5[i]), sum5Pct: r2(X.sum5Pct[i]),
        streak: X.streak[i], fut: A.fut[i], fchg5: X.fchg5[i], fpos20: r2(X.fpos20[i]), futLevel: fiFutLevel(X.fchg5[i], X.fpos20[i]) }; })();
    return { rows, dates, F, X, A, defs, res, now: nowX, base: r2(res[0] ? res[0].base : null) };
}

/** ② 👑:訊號日(同一天收盤後知道)→ 那天起 K 個交易日不開新倉;17 條 × 兩窗口 vs 現行 vs 同天數隨機停手 */
export function leaderPart(M, env, log = console.log) {
    const ctx = loadCtx(env.DATA_DIR, env.DIV);
    if (ctx.meta.stocks < 1000) throw new Error(`👑 檔數 ${ctx.meta.stocks} < 1000(⛔ 不跑)`);
    const K = +(env.LEAD_K || 10), SH = +(env.SHAMS || 20);
    const cal = ctx.cal, ci = new Map(cal.map((d, i) => [d, i]));
    log(`👑 ${ctx.meta.stocks} 檔 ・日曆 ${cal[0]} ~ ${cal.at(-1)} ・停手 ${K} 個交易日 ・安慰劑 ${SH} 組`);
    const toPause = sigDates => { const a = new Uint8Array(cal.length); for (const d of sigDates) { const i = ci.get(d); if (i == null) continue; for (let k = 0; k <= K && i + k < cal.length; k++) a[i + k] = 1; } return a; };
    const runW = (w, cfg) => {
        const s0 = cal.findIndex(d => d >= w), out = [];
        for (let k = 0; k < PATHS; k++) { const s = s0 + STEP * k, r = simulate(ctx, s, cfg, 1000 + k); const trS = Array.from(ctx.etf.tr.slice(s, s + r.eq.length));
            out.push({ fin: r.eq.at(-1), m: metrics(r.eq, trS), pz: r.st.pauseReb || 0 }); }
        return out;
    };
    const base = {}; for (const w of WINS) base[w] = runW(w, {});
    const sum = (w, rs) => ({ tot: r2(median(rs.map(x => (x.fin - 1) * 100))), mdd: r2(median(rs.map(x => x.m.mdd))), worst: r2(Math.min(...rs.map(x => (x.fin - 1) * 100))),
        beat: rs.filter((x, k) => x.fin > base[w][k].fin + 1e-12).length, tie: rs.filter((x, k) => Math.abs(x.fin - base[w][k].fin) <= 1e-12).length, pz: median(rs.map(x => x.pz)) });
    const out = { K, base: Object.fromEntries(WINS.map(w => [w, sum(w, base[w])])), sigs: [] };
    for (const w of WINS) log(`   [${w}] 現行:總報酬中位 ${out.base[w].tot}% ・回撤 ${out.base[w].mdd}%`);
    for (const d of M.defs) {
        const raw = d.build(d.def);
        const sd = M.dates.filter((_, i) => raw[i] === 1);
        if (!sd.length) { out.sigs.push({ key: d.key, n: 0 }); continue; }
        const row = { key: d.key, name: d.name, nSig: sd.length, win: {} };
        for (const w of WINS) {
            const inW = sd.filter(x => x >= w && ci.has(x));
            if (inW.length < 3) { row.win[w] = { nSig: inW.length, skip: '窗口內訊號 < 3 天' }; continue; }
            const real = toPause(inW);
            const rs = runW(w, { pause: real });
            // 安慰劑:把窗口內「停手的日子」整段循環平移(⭐ 停手總天數、連在一起的樣子都一樣,只是日子不對)
            //   ⛔ 不可用「同樣幾個訊號日、隨機挑」—— 訊號是一串一串的,隨機打散之後停手天數會多好幾倍(第一版就這樣,安慰劑慘輸是假的)
            const a0 = cal.findIndex(x => x >= w), L = cal.length - a0, R = rng(97 + inW.length), shams = [];
            const pausedDays = real.slice(a0).reduce((x, y) => x + y, 0);
            for (let s = 0; s < SH; s++) {
                const off = Math.floor(L * 0.15 + R() * L * 0.7), sh = new Uint8Array(cal.length);
                for (let i = 0; i < L; i++) sh[a0 + (i + off) % L] = real[a0 + i];
                shams.push(sum(w, runW(w, { pause: sh })));
            }
            const shTot = shams.map(x => x.tot).sort((x, y) => x - y), zt = sum(w, rs).tot;
            row.win[w] = { nSig: inW.length, paused: pausedDays, ...sum(w, rs), sham: { tot: r2(median(shTot)), beat: median(shams.map(x => x.beat)), mdd: r2(median(shams.map(x => x.mdd))),
                rank: shTot.filter(x => x < zt).length, n: SH } };
            const z = row.win[w];
            log(`   [${w}] ${d.key}(訊號 ${inW.length} 天、停手 ${pausedDays} 天):${z.tot}% vs 現行 ${out.base[w].tot}% ・贏 ${z.beat}/17(平手 ${z.tie})・回撤 ${z.mdd}%(現行 ${out.base[w].mdd}%)・換倉日停手 ${z.pz} 次 ・安慰劑中位 ${z.sham.tot}%(贏現行 ${z.sham.beat}/17)・比 ${z.sham.rank}/${SH} 組安慰劑好`);
        }
        out.sigs.push(row);
    }
    return out;
}

/** ⛰️ 高原:近高 × 跌幅 × 停手天數(⛔ 沒有安慰劑,只看「贏現行幾條」跟總報酬;安慰劑看中心點那一格)。HIDROP_GRID=1 才跑 */
export function leaderGrid(M, env, log = console.log) {
    const ctx = loadCtx(env.DATA_DIR, env.DIV);
    const cal = ctx.cal, ci = new Map(cal.map((d, i) => [d, i]));
    const NEARS = [3, 5, 7], THS = [1, 1.5, 2, 2.5, 3], KS = [5, 10, 20];
    const runW = (w, cfg) => { const s0 = cal.findIndex(d => d >= w), out = [];
        for (let k = 0; k < PATHS; k++) { const s = s0 + STEP * k, r = simulate(ctx, s, cfg, 1000 + k); const trS = Array.from(ctx.etf.tr.slice(s, s + r.eq.length)); out.push({ fin: r.eq.at(-1), m: metrics(r.eq, trS) }); }
        return out; };
    const base = Object.fromEntries(WINS.map(w => [w, runW(w, {})]));
    const F = M.F, rows = [];
    // GRID_KEY=訊號 key → 改跑那個訊號自己的門檻格(def.grid)× 停手天數;不設 = 近高 × 跌幅
    const gdef = env.GRID_KEY ? M.defs.find(d => d.key === env.GRID_KEY) : null;
    if (env.GRID_KEY && !gdef) throw new Error(`GRID_KEY=${env.GRID_KEY} 不認得(⛔ 不可安靜地改跑別的)`);
    const combos = gdef ? gdef.grid.map(th => ({ nr: null, th, sd: M.dates.filter((_, i) => gdef.build(th)[i] === 1) }))
                        : NEARS.flatMap(nr => THS.map(th => ({ nr, th, sd: M.dates.filter((_, i) => F.dd252[i] != null && F.dd252[i] >= -nr / 100 && F.ret[i] != null && F.ret[i] <= -th / 100) })));
    for (const { nr, th, sd } of combos) {
        for (const K of KS) {
            const r = { near: nr, th, K, win: {} };
            for (const w of WINS) {
                const inW = sd.filter(x => x >= w && ci.has(x));
                if (!inW.length) { r.win[w] = { nSig: 0 }; continue; }
                const a = new Uint8Array(cal.length); for (const d of inW) { const i = ci.get(d); for (let k = 0; k <= K && i + k < cal.length; k++) a[i + k] = 1; }
                const rs = runW(w, { pause: a });
                r.win[w] = { nSig: inW.length, tot: r2(median(rs.map(x => (x.fin - 1) * 100))), mdd: r2(median(rs.map(x => x.m.mdd))), beat: rs.filter((x, k) => x.fin > base[w][k].fin + 1e-12).length };
            }
            rows.push(r);
            log(`   ⛰️ ${gdef ? `${gdef.key} 門檻 ${th}` : `近高 ≤${nr}% ・跌 ≥${th}%`} ・停 ${K} 天:` + WINS.map(w => { const z = r.win[w]; return z.nSig ? `[${w.slice(0, 4)}] 訊號 ${z.nSig} ・${z.tot}% ・贏 ${z.beat}/17 ・回撤 ${z.mdd}%` : `[${w.slice(0, 4)}] 沒訊號`; }).join(' ・'));
        }
    }
    return { base: Object.fromEntries(WINS.map(w => [w, { tot: r2(median(base[w].map(x => (x.fin - 1) * 100))), mdd: r2(median(base[w].map(x => x.m.mdd))) }])), rows };
}

function printMarket(M, log = console.log) {
    const s = x => x == null ? '—' : (x >= 0 ? '+' : '') + x;
    log(`\n🧭 基準:任何一天「之後 60 天再跌 ≥10%」= ${M.base}%(訊號一律晚一天才算)`);
    log('訊號(門檻)                                         亮燈天  命中%  差(pp)  p     q     分段 E/A/B             去最好  逐年+/−  高原 → 關卡');
    for (const r of M.res) {
        const seg = ['E', 'A', 'B'].map(k => r.segs[k].counted ? s(r.segs[k].lift) : '·').join('/');
        const pl = r.plateau ? r.plateau.map(x => s(x.lift)).join(',') : '—';
        log(`  ${(r.name + `(${r.th})`).padEnd(48)} ${String(r.on).padStart(5)} ${String(r.prec).padStart(6)} ${s(r.lift).padStart(7)} ${String(r.p).padStart(5)} ${String(r.q).padStart(6)}  ${seg.padEnd(20)} ${s(r.dropBest).padStart(6)}  ${r.yPos}/${r.yNeg}  [${pl}] → ${r.nPass}/6${r.pass ? ' ✅' : ''} ・從 ${r.first} 起・今天 ${r.today && r.today.on ? '🔔亮' : '—'}`);
        const h = r.act && r.act.half, o = r.act && r.act.out;
        if (h && o) log(`       怎麼防(0050 代理):放著 ×${h.hold.mult}(回撤 ${h.hold.mdd}%)・亮燈留一半 ×${h.sig.mult}(${h.sig.mdd}%)・亮燈全出 ×${o.sig.mult}(${o.sig.mdd}%)`);
    }
    log(`\n📍 最新一天 ${M.now.d}:離一年高 ${M.now.dd252}% ・當天 ${M.now.ret}% ・外資現貨 ${M.now.spot} 億(5 日 ${M.now.sum5} 億、位階 ${M.now.sum5Pct})・連賣 ${M.now.streak} 天 ・外資台指期 ${M.now.fut} 口(5 日 ${M.now.fchg5}、20 日位階 ${M.now.fpos20} → App 分級 ${M.now.futLevel})`);
}

function main() {
    const out = process.argv.slice(2).find(a => a.endsWith('.json'));
    const t0 = Date.now();
    const M = marketPart(process.env);
    printMarket(M);
    let L = null, G = null;
    if (process.env.DATA_DIR && process.env.HIDROP_GRID) G = leaderGrid(M, process.env);
    else if (process.env.DATA_DIR) L = leaderPart(M, process.env);
    const R = { meta: { generated: new Date().toISOString(), from: M.dates[0], to: M.dates.at(-1), base: M.base, near: NEAR, lag: '訊號晚一天才算(⛔ 不用當天收盤)', segs: SEGS.map(x => x[1]) },
        market: M.res.map(r => ({ key: r.key, name: r.name, th: r.th, on: r.on, prec: r.prec, lift: r.lift, p: r.p, q: r.q, segs: r.segs, years: r.years, dropBest: r.dropBest, plateau: r.plateau,
            gates: r.gates, nPass: r.nPass, pass: r.pass, first: r.first, today: r.today, act: r.act, epi: r.epi, ons: r.ons })), now: M.now, leader: L, grid: G };
    if (out) { fs.writeFileSync(out, JSON.stringify(R)); console.log(`\n💾 ${out}`); }
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① 連賣天數 / 5 日合計 / 缺資料不補
    const A = { spot: [10, -1, -2, -3, null, -4, -5, 6, -7, -8], fut: new Array(10).fill(null), mg: new Array(10).fill(null) };
    const X = fiFeatures(A);
    t(X.streak.join(',') === '0,1,2,3,,1,2,0,1,2' && X.sum5[3] === null && X.sum5[9] === -18 && X.sum5[8] === null,
      `① 連賣天數 ${X.streak.join(',')} ・5 日合計碰到缺資料就不給(${X.sum5[8]})`);
    // ② 期貨 5 日變化 / 20 日位階 = App 的算法;分級跟 index.html `_fiFutState` 逐筆一致(跨檔比對)
    const fut = Array.from({ length: 40 }, (_, i) => -80000 + Math.round(6000 * Math.sin(i / 3)) - (i > 30 ? (i - 30) * 2500 : 0));
    const XF = fiFeatures({ spot: new Array(40).fill(1), fut, mg: new Array(40).fill(null) });
    const html = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'index.html'), 'utf8');
    const a0 = html.indexOf('    _fiFutState() {'), b0 = html.indexOf('\n    },', a0);
    let appLv = null, mism = 0;
    if (a0 > 0 && b0 > a0) {
        const body = html.slice(html.indexOf('{', a0) + 1, b0);
        const fn = new Function(body);
        for (let i = 8; i < 40; i++) {
            const self = { _futuresCache: { fi_net: fut[i] }, _riskHistCache: fut.slice(Math.max(0, i - 25), i + 1).map(v => ({ fi_futures_net: v })) };
            const app = fn.call(self).level, mine = fiFutLevel(XF.fchg5[i], XF.fpos20[i]);
            if (i === 39) appLv = app;
            if (app !== mine) mism++;
        }
    }
    t(a0 > 0 && mism === 0 && appLv != null, `② 外資台指期分級跟 App _fiFutState 逐筆一致(32 天,不一致 ${mism};最後一天 ${appLv})`);
    // ③ 位階不含今天(pctTrail):最兇的那天位階 = 0
    const big = Array.from({ length: 300 }, (_, i) => -(i % 50)); big[299] = -999;
    const XP = fiFeatures({ spot: big, fut: new Array(300).fill(null), mg: new Array(300).fill(null) });
    t(XP.dayPct[299] === 0 && XP.dayPct[100] == null, `③ 單日位階不含今天、樣本 < 250 不給(最兇那天 ${XP.dayPct[299]}、第 100 天 ${XP.dayPct[100]})`);
    // ④ 晚一天
    const sg = Int8Array.from([1, 0, 1, -1, 1]), lg = lag1(sg);
    t(lg.join(',') === '-1,1,0,1,-1', `④ 晚一天:${lg.join(',')}`);
    // ⑤ 前視注入:把未來的外資改掉,今天以前的訊號一個都不能變
    const n = 400, dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2010, 0, 4 + i)).toISOString().slice(0, 10));
    const sp = Array.from({ length: n }, (_, i) => Math.round(100 * Math.sin(i / 7)));
    const FI1 = { spot: Object.fromEntries(dates.map((d, i) => [d, [sp[i], 0, 0]])), fut: {}, mg: {} };
    const FI2 = JSON.parse(JSON.stringify(FI1)); for (let i = 300; i < n; i++) FI2.spot[dates[i]][0] = -5000;
    const F0 = { n, dd252: new Array(n).fill(0), ret: new Array(n).fill(-0.03) };
    const D1 = signalDefs(F0, fiFeatures(alignFi(dates, FI1))), D2 = signalDefs(F0, fiFeatures(alignFi(dates, FI2)));
    let leak = 0; for (let k = 0; k < D1.length; k++) { const a = D1[k].build(D1[k].def), b = D2[k].build(D2[k].def); for (let i = 0; i < 300; i++) if (a[i] !== b[i]) leak++; }
    let moved = 0; { const a = D1[2].build(10), b = D2[2].build(10); for (let i = 300; i < n; i++) if (a[i] !== b[i]) moved++; }
    t(leak === 0 && moved > 0, `⑤ 改掉第 300 天以後的外資:之前的訊號變了 ${leak} 天(要 0)、之後的有反應 ${moved} 天`);
    // ⑥ 沒資料 → 不跑
    let threw = ''; try { marketPart({ IDX_LONG: '/nonexistent.json', FI_MKT: '/nonexistent.json' }, () => {}); } catch (e) { threw = e.message; }
    t(/讀不到|缺必要/.test(threw), `⑥ 讀不到資料 → throw(${threw.slice(0, 30)})`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) { try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); } }
