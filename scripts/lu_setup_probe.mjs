#!/usr/bin/env node
/**
 * 🟥🔎 lu_setup_probe.mjs —— 「族群第一波點火 → 量縮回檔」的前一天,能不能挑出明天容易漲停、而且買得到的股票?(V78.6.4)
 *
 * 使用者(2026-10-08,光頡 3624 連兩根漲停):「前一日有什麼消息或指標可以找出端倪嗎?可以的話能不能用來找『易漲停』股票
 * (⛔ 不是找已經漲停的)」。
 * 光頡的長相(只用前一天以前的資料):10/01 被動元件整族點火(它也鎖漲停)→ 10/02~10/06 量縮回檔(量 0.5~0.6 倍)
 * → 10/07 第二波鎖漲停 → 10/08 再漲停。limitup_probe 測過「同一天同產業 ≥3 家漲停」1.48x,⛔ 沒測過這個「點火後回檔」型態。
 *
 * 族群(⛔ 不用 stock_tags —— 那是今天算的,回測會偷看未來;⛔ 不用 pro.html THEMES —— 每族只有 3~7 檔而且是事後挑的):
 *   同一個官方產業裡、過去 120 個交易日報酬相關係數最高的 10 檔(相關 ≥0.3),每 20 個交易日用「那天以前」的資料重算一次
 *   = 時間點正確版的「連動」(App 的 #被動元件 連動 63 就是同一種概念)。⚠️ 產業分類用今天的表(分類很少變,記為限制)。
 * 條件(第 t 天收盤,只用 ≤ t):
 *   IGN  族群點火:近 W 天(t−W ~ t−1)內,連動的那 10 檔裡至少 K 檔收盤鎖漲停
 *   SELF 自己近 W 天也鎖過漲停
 *   PULL 今天量 ≤ R × 前 20 天平均量(⛔ 基準不含今天,陷阱 #43)、收盤在 20 日線之上、今天沒鎖漲停(要買得到)
 *   光頡型 = IGN ∧ SELF ∧ PULL
 * 結果:隔天收盤鎖漲停的比例 vs 全部「今天買得到」的股票(倍數)・隔天開盤就在漲停的比例・
 *       今天收盤買 → 隔天收盤 / 抱 5 / 10 天收盤賣,扣同期 0050 含息與成本 0.44%;增量 = 減同一天全部買得到的股票平均
 * 另一條(10/08 那一根):今天「量縮鎖漲停」→ 隔天還會漲停嗎?⛔ 但今天鎖住的收盤價買不到 → 只報命中率與「隔天開盤還買得到嗎」
 * 流動性:20 日平均成交額 ≥ 1,000 萬元;同一檔同一條件 20 個交易日只算一次
 *
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json IND_MAP=$S/d10n/industry_map.json node --max-old-space-size=10000 scripts/lu_setup_probe.mjs out.json
 *       FROM=2022-09-16 只算那之後的事件 ・ node scripts/lu_setup_probe.mjs --selftest
 */
import fs from 'fs';
import { lockUp } from './downday_lu_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';

const COST = 0.44, DEDUP = 20, HS = [1, 5, 10, 20], CW = 120, REFRESH = 20, NPEER = 10, MINCOR = 0.3, MIN_VAL = 1e7;
const limOf = d => (d < '2015-06-01' ? 0.07 : 0.10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

/** 時間點正確的連動族群:peersAt[k] = 第 k 次重算(用 ≤ t0 的資料)的 Map(sym → [peer idx]) */
export function buildPeers(stocks, ind, n) {
    const R = stocks.map(S => { const r = new Float64Array(n).fill(NaN); for (let i = 1; i < n; i++) if (S.A[i] > 0 && S.A[i - 1] > 0) r[i] = S.A[i] / S.A[i - 1] - 1; return r; });
    const grp = new Map(); stocks.forEach((S, k) => { const g = ind[S.sym]; if (!g) return; (grp.get(g) || grp.set(g, []).get(g)).push(k); });
    const peersAt = new Map();                 // t0 → Int32Array[][] (每檔的 peer 索引)
    for (let t0 = CW; t0 < n; t0 += REFRESH) {
        const z = new Array(stocks.length).fill(null);
        for (const [, ks] of grp) for (const k of ks) {
            const r = R[k]; let c = 0, s = 0, s2 = 0;
            for (let i = t0 - CW + 1; i <= t0; i++) if (Number.isFinite(r[i])) { c++; s += r[i]; }
            if (c < CW * 0.8) continue;
            const m = s / c; for (let i = t0 - CW + 1; i <= t0; i++) if (Number.isFinite(r[i])) s2 += (r[i] - m) ** 2;
            const sd = Math.sqrt(s2 / c); if (!(sd > 0)) continue;
            const v = new Float64Array(CW); for (let i = 0; i < CW; i++) { const x = r[t0 - CW + 1 + i]; v[i] = Number.isFinite(x) ? (x - m) / sd : 0; }
            z[k] = v;
        }
        const peers = new Array(stocks.length).fill(null);
        for (const [, ks] of grp) for (const a of ks) {
            if (!z[a]) continue; const cand = [];
            for (const b of ks) { if (b === a || !z[b]) continue; let d = 0; const va = z[a], vb = z[b]; for (let i = 0; i < CW; i++) d += va[i] * vb[i]; d /= CW; if (d >= MINCOR) cand.push([d, b]); }
            cand.sort((x, y) => y[0] - x[0]); peers[a] = cand.slice(0, NPEER).map(x => x[1]);
        }
        peersAt.set(t0, peers);
    }
    return peersAt;
}

/** 第 t 天收盤買 → 第 t+h 天收盤賣(調整後),% 未扣成本 */
const fwdC = (S, t, h) => (S.A[t] > 0 && S.A[t + h] > 0 ? (S.A[t + h] / S.A[t] - 1) * 100 : null);

export function scan(ctx, peersAt, opt = {}) {
    const { cal, stocks, etf } = ctx, n = cal.length, FROM = opt.FROM || '';
    const Ks = opt.Ks || [2, 3, 4], Ws = opt.Ws || [3, 5, 10], Rs = opt.Rs || [0.5, 0.7, 0.9];
    const LU = stocks.map(S => { const u = new Uint8Array(n); for (let i = 1; i < n; i++) if (lockUp(S, i, cal)) u[i] = 1; return u; });
    const LUc = LU.map(u => { const c = new Int32Array(n + 1); for (let i = 0; i < n; i++) c[i + 1] = c[i] + u[i]; return c; });   // 前綴和:i−W..i−1 有沒有鎖過
    const anyLU = (k, a, b) => a <= b && LUc[k][b + 1] - LUc[k][a] > 0;
    const ok = (S, t) => S.C[t] > 0 && S.C[t + 1] > 0 && S.val20[t] >= MIN_VAL && S.F[t + 1] === 1;
    const bench = (t, h) => (etf.tr[t + h] > 0 && etf.tr[t] > 0 ? (etf.tr[t + h] / etf.tr[t] - 1) * 100 : NaN);
    const out = { ev: {}, base: { n: 0, lu: 0, open: 0 }, cnt: {} };
    const put = (k, o) => (out.ev[k] = out.ev[k] || []).push(o);
    const dayCache = new Map();
    const dayMean = (t, h) => { const key = t * 100 + h; if (dayCache.has(key)) return dayCache.get(key); const a = [];
        for (let k = 0; k < stocks.length; k++) { const S = stocks[k]; if (!ok(S, t) || LU[k][t]) continue; const r = fwdC(S, t, h); if (r != null) a.push(r); }
        const v = a.length >= 30 ? mean(a) : NaN; dayCache.set(key, v); return v; };
    const last = new Map();
    const t0Of = t => { const q = Math.floor((t - 1 - CW) / REFRESH); return q < 0 ? null : CW + q * REFRESH; };   // ⭐ 只用 ≤ t−1 重算的族群
    const Wmax = Math.max(...Ws);
    for (let t = Math.max(CW + 1, 21); t < n - 1; t++) {          // 尾端沒有 h 天後的價 → 那個 h 記 null(只算隔天鎖不鎖)
        if (cal[t] < FROM) continue;
        const t0 = t0Of(t); const peers = t0 != null ? peersAt.get(t0) : null; if (!peers) continue;
        for (let k = 0; k < stocks.length; k++) {
            const S = stocks[k]; if (!ok(S, t)) continue;
            const luT = LU[k][t], luN = LU[k][t + 1];
            const openLim = S.O[t + 1] >= S.C[t] * (1 + limOf(cal[t + 1]) - 0.003);
            let v20 = 0, c20 = 0; for (let j = t - 20; j < t; j++) if (S.V[j] > 0) { v20 += S.V[j]; c20++; }   // ⛔ 不含今天
            const vr = c20 >= 15 && S.V[t] > 0 ? S.V[t] / (v20 / c20) : NaN;
            if (luT) {                                  // 10/08 那一根:今天鎖漲停(量縮 vs 量大)→ 隔天
                const key = vr <= 0.6 ? '今天鎖漲停·量縮≤0.6' : '今天鎖漲停·量>0.6';
                const lk = last.get(key + S.sym); if (lk != null && t - lk < DEDUP) continue; last.set(key + S.sym, t);
                put(key, { d: cal[t], s: S.sym, nlu: luN, open: openLim ? 1 : 0, rets: null });
                continue;
            }
            out.base.n++; out.base.lu += luN; out.base.open += openLim ? 1 : 0;
            const pk = peers[k]; if (!pk || pk.length < 5) continue;
            const above = S.A[t] > S.ma20[t];
            const rets = {}; for (const h of HS) { const r = fwdC(S, t, h), b = bench(t, h), dm = dayMean(t, h);
                rets[h] = r == null || !Number.isFinite(b) ? null : { ex: r - b, raw: r - b - COST, inc: Number.isFinite(dm) ? r - dm : NaN }; }
            const base = { t, k, d: cal[t], s: S.sym, nlu: luN, open: openLim ? 1 : 0, rets };
            const emit = key => { const lk = last.get(key + S.sym); if (lk != null && t - lk < DEDUP) return; last.set(key + S.sym, t); put(key, base); };
            for (const W of Ws) {
                let ign = 0; for (const p of pk) if (anyLU(p, t - W, t - 1)) ign++;
                const self = anyLU(k, t - W, t - 1);
                for (const K of Ks) {
                    const I = ign >= K;
                    if (W === 5 && K === 3) {
                        if (I) emit('A 族群點火(連動 10 檔裡近 5 天 ≥3 檔鎖漲停)');
                        if (self) emit('B 自己近 5 天鎖過漲停');
                        if (I && self) emit('C 族群點火 ∧ 自己也鎖過');
                    }
                    for (const R of Rs) {
                        if (I && self && above && vr <= R) emit(`光頡型 K${K} W${W} R${R}`);
                    }
                }
                if (W === 5 && self && above && vr <= 0.7) emit('D 自己鎖過 ∧ 量縮(不看族群)');
            }
        }
    }
    return out;
}

export function summarize(out) {
    const bl = out.base.n ? out.base.lu / out.base.n : NaN;
    const res = { base: { n: out.base.n, lu: +(100 * bl).toFixed(2), open: +(100 * out.base.open / out.base.n).toFixed(2) } };
    for (const [k, arr] of Object.entries(out.ev)) {
        const nlu = arr.filter(o => o.nlu).length, op = arr.filter(o => o.open).length;
        const r = { n: arr.length, lu: +(100 * nlu / arr.length).toFixed(2), lift: +((nlu / arr.length) / bl).toFixed(2), open: +(100 * op / arr.length).toFixed(1) };
        if (arr[0] && arr[0].rets) for (const h of HS) {
            const a = arr.filter(o => o.rets[h]);
            const x = a.filter(o => Number.isFinite(o.rets[h].inc)).map(o => ({ d: o.d, v: o.rets[h].inc }));
            const g = gates(x, a.map(o => o.rets[h].raw), 1);
            // ⭐ 同一天、同一族常常一起亮 → 逐筆 t 會高估;另算「每天先平均」的 t、中位數、去頭尾 2% 的平均
            const byD = {}; x.forEach(e => (byD[e.d] = byD[e.d] || []).push(e.v));
            const dm = Object.values(byD).map(mean), m = mean(dm), sd = Math.sqrt(mean(dm.map(v => (v - m) ** 2)));
            const sv = x.map(e => e.v).sort((p, q) => p - q), cut = Math.floor(sv.length * 0.02), tr = sv.slice(cut, sv.length - cut);
            r['h' + h] = { n: a.length, ex: +mean(a.map(o => o.rets[h].ex)).toFixed(2), win: +(100 * a.filter(o => o.rets[h].ex > 0).length / a.length).toFixed(1),
                inc: g.inc, t: g.t, abs: g.abs, pass: g.pass, years: g.years,
                days: dm.length, dayT: +(m / (sd / Math.sqrt(dm.length) || 1)).toFixed(2), med: +(sv[sv.length >> 1] ?? NaN).toFixed(2), trim: +mean(tr).toFixed(2) };
        }
        res[k] = r;
    }
    return res;
}


/**
 * 💼 組合層(事件層正的 ≠ 拿錢做會賺,hot-drop-reversal 的教訓):100 萬分 SLOTS 格,事件當天收盤買、抱 HOLD 天收盤賣,
 *    閒錢停 0050 含息;安慰劑 = 同一天換成同樣多檔「今天買得到、流動性夠」的隨機股票;起點每 3 天一條共 17 條。
 */
export function portfolio(ctx, events, opt = {}) {
    const { cal, stocks, etf } = ctx, n = cal.length, SLOTS = opt.slots || 5, HOLD = opt.hold || 10, sham = !!opt.sham;
    let seed = opt.seed || 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const byT = new Map(); for (const e of events) (byT.get(e.t) || byT.set(e.t, []).get(e.t)).push(e.k);
    const okBuy = (k, t) => { const S = stocks[k]; return S.C[t] > 0 && S.A[t] > 0 && S.val20[t] >= MIN_VAL && !lockUp(S, t, cal); };
    let cash = 1e6; const pos = []; let trades = 0, wins = 0;
    const s0 = opt.start, end = opt.end ?? n - 1;
    for (let t = s0; t <= end; t++) {
        if (t > s0 && etf.tr[t] > 0 && etf.tr[t - 1] > 0) cash *= etf.tr[t] / etf.tr[t - 1];
        for (let j = pos.length - 1; j >= 0; j--) { const p = pos[j], S = stocks[p.k];
            if (t >= p.t + HOLD && S.A[t] > 0) { const v = p.amt * (S.A[t] / S.A[p.t]) * (1 - COST / 100); cash += v; trades++; if (v > p.amt) wins++; pos.splice(j, 1); } }
        let cand = byT.get(t) || [];
        if (sham && cand.length) { const m = cand.length; cand = []; let tries = 0; while (cand.length < m && tries++ < 5000) { const k = Math.floor(rnd() * stocks.length); if (okBuy(k, t) && !cand.includes(k)) cand.push(k); } }
        for (const k of cand) { if (pos.length >= SLOTS || pos.some(p => p.k === k)) continue;
            const eq = cash + pos.reduce((a, p) => a + p.amt * (stocks[p.k].A[t] > 0 ? stocks[p.k].A[t] / stocks[p.k].A[p.t] : 1), 0);
            const amt = Math.min(cash, eq / SLOTS); if (amt < 1000) break; cash -= amt; pos.push({ k, t, amt }); }
    }
    const fin = cash + pos.reduce((a, p) => a + p.amt * (stocks[p.k].A[end] > 0 ? stocks[p.k].A[end] / stocks[p.k].A[p.t] : 1), 0);
    return { fin, trades, win: trades ? 100 * wins / trades : NaN };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 260, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10));
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const common = Array.from({ length: n }, () => (rnd() - 0.5) * 0.02);
    const mk = (sym, mod) => { const C = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), V = new Float64Array(n).fill(1000), F = new Float64Array(n).fill(1);
        let p = 100; for (let i = 0; i < n; i++) { p *= 1 + common[i] + (rnd() - 0.5) * 0.01; C[i] = p; O[i] = i ? C[i - 1] : p; H[i] = Math.max(O[i], C[i]) * 1.001; }
        const S = { sym, C, O, H, V, F }; if (mod) mod(S);
        S.A = S.C.slice(); S.val20 = new Float64Array(n).fill(1e9); S.ma20 = new Float64Array(n);
        for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - 19); j <= i; j++) { s += S.A[j]; c++; } S.ma20[i] = s / c; }
        return S; };
    const lockAt = (S, i) => { S.C[i] = S.C[i - 1] * 1.1; S.H[i] = S.C[i]; for (let j = i + 1; j < n; j++) { S.C[j] *= 1.1; S.O[j] *= 1.1; S.H[j] *= 1.1; } };
    // 8 檔同族一起動;第 200 天其中 4 檔鎖漲停(點火),目標股 X 也鎖;第 203 天 X 量縮、站在月線上;第 204 天 X 再鎖漲停
    const fam = Array.from({ length: 8 }, (_, k) => mk(String(3000 + k), S => { if (k < 4) lockAt(S, 200); }));
    const X = mk('3999', S => { lockAt(S, 200); S.V[203] = 300; lockAt(S, 204); });
    const others = Array.from({ length: 40 }, (_, k) => mk(String(5000 + k)));
    const stocks = [X, ...fam, ...others], ind = {}; for (const S of stocks) ind[S.sym] = S.sym.startsWith('5') ? 'B' : 'A';
    const ctx = { cal, stocks, etf: { tr: new Float64Array(n).fill(1) } };
    const peers = buildPeers(stocks, ind, n);
    const t0 = 120 + Math.floor((203 - 1 - 120) / 20) * 20;
    t(peers.get(t0)[0] && peers.get(t0)[0].every(p => ind[stocks[p].sym] === 'A'), '① 連動族群只從同產業挑,而且用 ≤ t−1 的資料重算');
    const out = scan(ctx, peers, { Ks: [3], Ws: [5], Rs: [0.5] });
    const ev = (out.ev['光頡型 K3 W5 R0.5'] || []).filter(o => o.s === '3999');
    t(ev.length === 1 && ev[0].d === cal[203] && ev[0].nlu === 1, '② 第 200 天族群點火 + 自己鎖 → 第 203 天量縮(0.3 倍)站上月線 → 光頡型,隔天鎖漲停算命中');
    // 量縮基準含今天 → 0.3 倍會被稀釋成 >0.3,用 R=0.3 測:基準不含今天時 300/1000 = 0.3 剛好通過
    const out2 = scan(ctx, peers, { Ks: [3], Ws: [5], Rs: [0.3] });
    t((out2.ev['光頡型 K3 W5 R0.3'] || []).some(o => o.s === '3999'), '③ 量縮的基準是前 20 天(⛔ 不含今天,陷阱 #43)');
    // 前視:點火若發生在第 204 天(t+1)⛔ 不可讓第 203 天亮
    const fam2 = Array.from({ length: 8 }, (_, k) => mk(String(3100 + k), S => { if (k < 4) lockAt(S, 204); }));
    const Y = mk('3998', S => { lockAt(S, 200); S.V[203] = 300; });
    const st2 = [Y, ...fam2, ...others], ind2 = {}; for (const S of st2) ind2[S.sym] = S.sym.startsWith('5') ? 'B' : 'A';
    const o3 = scan({ cal, stocks: st2, etf: ctx.etf }, buildPeers(st2, ind2, n), { Ks: [3], Ws: [5], Rs: [0.5] });
    t(!(o3.ev['光頡型 K3 W5 R0.5'] || []).some(o => o.s === '3998' && o.d === cal[203]), '④ 族群第 204 天才點火 → 第 203 天⛔ 不可亮(零前視)');
    // 今天鎖漲停的不進光頡型(買不到),另記一組
    t((out.ev['今天鎖漲停·量>0.6'] || out.ev['今天鎖漲停·量縮≤0.6'] || []).some(o => o.s === '3999' && o.d === cal[200])
        && !(out.ev['光頡型 K3 W5 R0.5'] || []).some(o => o.d === cal[200]), '⑤ 今天鎖漲停的那天 ⛔ 不當光頡型(收盤買不到),另記「今天鎖漲停」組');
    // 去重
    const Z = mk('3997', S => { lockAt(S, 200); S.V[202] = 300; S.V[203] = 300; });
    const st3 = [Z, ...fam, ...others], ind3 = {}; for (const S of st3) ind3[S.sym] = S.sym.startsWith('5') ? 'B' : 'A';
    const o4 = scan({ cal, stocks: st3, etf: ctx.etf }, buildPeers(st3, ind3, n), { Ks: [3], Ws: [5], Rs: [0.5] });
    t((o4.ev['光頡型 K3 W5 R0.5'] || []).filter(o => o.s === '3997').length === 1, '⑥ 連兩天都符合 → 20 天內只算一次');
    // 注入 +3%:光頡型隔天收盤都 +3%(相對同天全部) → 增量量得到
    const s = summarize(out);
    t(s.base.n > 1000 && Number.isFinite(s.base.lu), '⑦ 基準 = 全部今天買得到(沒鎖漲停)的股票·日');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('lu_setup_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const { loadCtx } = await import('./leader_probe.mjs');
    const ctx = loadCtx(process.env.DATA_DIR, process.env.DIV);
    const ind = JSON.parse(fs.readFileSync(process.env.IND_MAP, 'utf8'));
    const t1 = Date.now(); const peersAt = buildPeers(ctx.stocks, ind, ctx.cal.length);
    console.log(`族群重算 ${peersAt.size} 次 ・${((Date.now() - t1) / 1000).toFixed(0)} 秒 ・${ctx.stocks.length} 檔`);

    if (process.env.PORT_KEYS) {                    // 組合層:PORT_KEYS='光頡型 K3 W5 R0.5|光頡型 K3 W3 R0.5'
        const out = scan(ctx, peersAt, { FROM: process.env.FROM || '' });
        const s0 = ctx.cal.findIndex(d => d >= (process.env.FROM || '2011-01-03')); const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
        const endI = process.env.END ? ctx.cal.findLastIndex(d => d <= process.env.END) : ctx.cal.length - 1;   // END=2025-12-31 → 拿掉今年看還成不成立
        const b50 = st => 1e6 * ctx.etf.tr[endI] / ctx.etf.tr[st];
        for (const key of process.env.PORT_KEYS.split('|')) { const ev = out.ev[key]; if (!ev) { console.log('⛔ 沒有這一組', key); continue; }
            for (const hold of [5, 10]) { const R = [], Q = [], B = [];
                for (let p = 0; p < 17; p++) { const st = s0 + 3 * p; R.push(portfolio(ctx, ev, { start: st, hold, end: endI })); Q.push(portfolio(ctx, ev, { start: st, hold, end: endI, sham: true, seed: 11 + p })); B.push(b50(st)); }
                const w = R.filter((r, i) => r.fin > Q[i].fin).length, wb = R.filter((r, i) => r.fin > B[i]).length;
                console.log(`💼 ${key} 抱${hold}天 ・中位 ${(med(R.map(r => r.fin)) / 1e4).toFixed(0)} 萬(最差 ${(Math.min(...R.map(r => r.fin)) / 1e4).toFixed(0)})・筆數 ${med(R.map(r => r.trades))} 勝率 ${med(R.map(r => r.win)).toFixed(1)}% ・安慰劑中位 ${(med(Q.map(r => r.fin)) / 1e4).toFixed(0)} 萬 ・贏安慰劑 ${w}/17 ・0050 含息 ${(med(B) / 1e4).toFixed(0)} 萬 ・贏 0050 ${wb}/17`); } }
        process.exit(0);
    }
    const res = summarize(scan(ctx, peersAt, { FROM: process.env.FROM || '' }));
    if (res.base.n < 200000) { console.log('❌ 基準股·日 <20 萬,資料不對'); process.exit(1); }
    console.log(`基準(今天買得到)n=${res.base.n} 隔天收鎖漲停 ${res.base.lu}% ・隔天開盤就漲停 ${res.base.open}%`);
    for (const [k, r] of Object.entries(res)) { if (k === 'base') continue;
        const h = ['h1', 'h5', 'h10', 'h20'].map(x => r[x] ? `${x} 超額${r[x].ex} 贏${r[x].win}% 增量${r[x].inc} t${r[x].t} 天t${r[x].dayT}(${r[x].days}天) 中位${r[x].med} 去頭尾${r[x].trim} 扣本${r[x].abs} 關${r[x].pass}` : '').join(' | ');
        console.log(`${k.padEnd(26)} n=${String(r.n).padStart(6)} 隔天鎖漲停 ${r.lu}% (${r.lift}x) 開盤就漲停 ${r.open}% ${h}`); }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ from: process.env.FROM || ctx.cal[0], to: ctx.cal.at(-1), res }));
}
