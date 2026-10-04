#!/usr/bin/env node
/**
 * 💧📦 V78.4.4 「盤整 → 突破 N 日線 → OBV 上翹就買,沒跌破那條線就不賣」(使用者:「有回測過我沒想到的方式嗎?
 *   比如盤整突破幾日線然後 OBV 上翹可以買進,然後沒有破之前的幾日線不跑」)
 *
 * ⭐ 先查登記表(⛔ 這支不重測):OBV 五種用法(`obv_probe`)全部沒用、布林壓縮突破的進場也沒用(`strat_probe A`)。
 *   🆕 沒測過的是**三個疊在一起 + 用同一條線出場**這個組合。
 *
 * 事件(t 日收盤才知道的資料;進場 = t 日尾盤 = 收盤價,同 lib_exitsim / V72.9.0;t 日收盤鎖漲停剔除;20 日均額 ≥ 3,000 萬):
 *   盤整 = 前 K 根(⛔ 不含 t,陷阱 #43)收盤最高 − 最低 ≤ 最低 × W
 *   A 版「突破 N 日線」= 今天收盤站上 N 日均線、昨天還在下面(上穿)
 *   B 版「突破盤整區」= 今天收盤 > 前 K 根最高收盤
 *   OBV 上翹 = OBV(t) > OBV(t − M)(OBV 公式 = lib_indicators.obvSeries,⛔ 不另寫)
 * 出場:
 *   使用者那套 = 收盤跌破 N 日線就收盤賣(⛔ 沒有其他停損;最長 60 天)= lib_exitsim `ma{N}` + holdStop 99
 *   對照出場(同一批進場):現行 🔥 吊燈 ATR 2 倍・最長 20 天(lib `atr2`,停損 −5%)・唐奇安 20・最長 20 天
 * 報酬:扣成本 0.44% 再扣同期加權(超額)。
 * 對照組(⭐ 每一層各自問一個問題):
 *   BASE 同一批股票每 20 根抽一天(同樣的出場)= 「隨便哪天買」
 *   X    所有「上穿 N 日線」的日子 = 盤整有沒有加分
 *   S    盤整 + 上穿(沒有 OBV)= ⭐ OBV 有沒有加分(使用者問的就是這個)
 *   疊位階:一年位置 ≥ 85%(🧬 的一半)
 * 六關(SO vs S、SO vs BASE):① 全期 > 0 ② 前後半同號 ③ 逐年 ≥ 70% 同號 ④ 拿掉最好那年仍 > 0 ⑤ 扣成本仍贏大盤 ⑥ p ≤ 0.05
 * 高原網格:K ∈ {10,20,40} × W ∈ {8,12,20}% × N ∈ {5,10,20} × M ∈ {5,10}(A、B 兩版 = 216 格)
 *
 * 跑法:DATA_DIR=<合併過深歷史的目錄> node --max-old-space-size=10000 scripts/squeeze_obv_probe.mjs out.json
 *       node scripts/squeeze_obv_probe.mjs --selftest
 * ⛔ 只讀、不打 API。exit 0。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { obvSeries } from './lib_indicators.mjs';
import { simExits } from './lib_exitsim.mjs';

const COST = 0.44, DEDUP = 20, LIQ_MIN = 3e7, WARM = 260, MAXD_USER = 60, MAXD_CUR = 20;
export const KS = [10, 20, 40], WS = [0.08, 0.12, 0.20], NS = [5, 10, 20], MS = [5, 10];
const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sdv = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r2 = x => Math.round(x * 100) / 100;
const erf = x => { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const pTwo = z => 1 - erf(Math.abs(z) / Math.SQRT2);

function rollMa(c, N) { const n = c.length, out = new Float64Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += c[i]; if (i >= N) s -= c[i - N]; if (i >= N - 1) out[i] = s / N; } return out; }
/** 盤整:前 K 根(⛔ 不含 t)收盤的最高 / 最低 */
export function boxPrev(c, t, K) { let hi = -Infinity, lo = Infinity; for (let k = t - K; k < t; k++) { if (c[k] > hi) hi = c[k]; if (c[k] < lo) lo = c[k]; } return { hi, lo }; }

/** 一檔 → 往 acc 裡丟事件。acc = {ev: Map(key → [{d, u, a, dn, h, days, hi}]), skip} */
export function scanStock(rows, twMap, acc) {
    const n = rows.length; if (n < WARM + 40) return 0;
    const R = rows.map(r => ({ d: nd(r.date), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 }));
    if (!R.every(r => r.c > 0)) return 0;
    for (let i = 1; i < n; i++) { const q = R[i].c / R[i - 1].c; if (q > 1.4 || q < 0.6) { acc.skip.cliff++; return 0; } }
    const c = Float64Array.from(R.map(r => r.c)), v = Float64Array.from(R.map(r => r.v));
    const obv = obvSeries(c, v), MA = Object.fromEntries(NS.map(N => [N, rollMa(c, N)]));
    const amt = R.map(r => r.c * r.v);
    const last = new Map(); let ev = 0;
    const exOf = (sim, rule, t) => {
        const x = sim && sim[rule]; if (!x) return null;
        const a = twMap.get(R[t].d), b = twMap.get(R[x.outIdx].d);
        const net = x.ret - COST;
        return { net, ex: a > 0 && b > 0 ? net - (b / a - 1) * 100 : null, days: x.outIdx - t };
    };
    for (let t = WARM; t < n - 2; t++) {
        let s = 0; for (let k = t - 20; k < t; k++) s += amt[k];
        if (s / 20 < LIQ_MIN) { acc.skip.illiq++; continue; }
        if (c[t] >= c[t - 1] * 1.095) { acc.skip.limit++; continue; }      // 收盤鎖漲停:尾盤買不到
        const y = R[t].d;
        let hi250 = -Infinity, lo250 = Infinity; for (let k = t - 251; k <= t; k++) { if (c[k] > hi250) hi250 = c[k]; if (c[k] < lo250) lo250 = c[k]; }
        const hiPos = hi250 > lo250 && (c[t] - lo250) / (hi250 - lo250) >= 0.85;
        let simU = null, simC = null;
        const getU = () => simU || (simU = Object.fromEntries(NS.map(N => [N, simExits(R, t, { rules: ['ma' + N], maxD: MAXD_USER, holdStop: 99 })])));
        const getC = () => simC || (simC = simExits(R, t, { rules: ['atr2', 'don20'], maxD: MAXD_CUR }));
        const push = (key, N) => {
            if (last.has(key) && t - last.get(key) < DEDUP) return;
            last.set(key, t);
            const U = exOf(getU()[N], 'ma' + N, t), A = exOf(getC(), 'atr2', t), D = exOf(getC(), 'don20', t);
            if (!U || U.ex == null || !A || A.ex == null) return;
            let arr = acc.ev.get(key); if (!arr) acc.ev.set(key, arr = []);
            arr.push({ d: y, u: U.ex, un: U.net, days: U.days, a: A.ex, dn: D ? D.ex : null, hi: hiPos });
            ev++;
        };
        if (t % DEDUP === 0) for (const N of NS) push(`BASE|${N}`, N);
        const cross = {}; for (const N of NS) cross[N] = c[t] > MA[N][t] && c[t - 1] <= MA[N][t - 1];
        const up = {}; for (const M of MS) up[M] = obv[t] > obv[t - M];
        for (const N of NS) if (cross[N]) push(`X|${N}`, N);
        for (const K of KS) {
            const { hi, lo } = boxPrev(c, t, K);
            for (const W of WS) {
                if (!(hi - lo <= lo * W)) continue;
                const brk = c[t] > hi;
                for (const N of NS) {
                    if (cross[N]) { push(`S|${K}|${W}|${N}`, N); for (const M of MS) if (up[M]) push(`SO|${K}|${W}|${N}|${M}`, N); }
                    if (brk) { push(`B|${K}|${W}|${N}`, N); for (const M of MS) if (up[M]) push(`BO|${K}|${W}|${N}|${M}`, N); }
                }
            }
        }
    }
    return ev;
}

/** A vs B(欄位 f)的六關;dir = +1 */
export function cmp(A, B, f = 'u') {
    const a = A.map(e => e[f]).filter(x => x != null), b = B.map(e => e[f]).filter(x => x != null);
    if (a.length < 30 || b.length < 30) return { n: a.length, small: true };
    const ma = mean(a), mb = mean(b), se = Math.sqrt(sdv(a) ** 2 / a.length + sdv(b) ** 2 / b.length), z = se > 0 ? (ma - mb) / se : 0;
    const ds = A.map(e => e.d).sort(), cut = ds[ds.length >> 1];
    const half = k => { const aa = A.filter(e => (e.d < cut) === (k === 0)).map(e => e[f]), bb = B.filter(e => (e.d < cut) === (k === 0)).map(e => e[f]); return aa.length && bb.length ? mean(aa) - mean(bb) : 0; };
    const h1 = half(0), h2 = half(1);
    const yrs = [...new Set(A.map(e => e.d.slice(0, 4)))].sort();
    const yr = yrs.map(y => { const aa = A.filter(e => e.d.startsWith(y)).map(e => e[f]), bb = B.filter(e => e.d.startsWith(y)).map(e => e[f]); return aa.length >= 15 && bb.length >= 15 ? [y, mean(aa) - mean(bb)] : null; }).filter(Boolean);
    const d = ma - mb;
    const yrOK = yr.length >= 2 && yr.filter(x => Math.sign(x[1]) === Math.sign(d)).length / yr.length >= 0.7;
    let drop = false; if (yr.length >= 2) { const best = yr.reduce((p, q) => q[1] > p[1] ? q : p); const aa = A.filter(e => !e.d.startsWith(best[0])).map(e => e[f]), bb = B.filter(e => !e.d.startsWith(best[0])).map(e => e[f]); drop = mean(aa) - mean(bb) > 0; }
    const g = [d > 0, h1 > 0 && h2 > 0, yrOK && d > 0, drop, ma > 0, pTwo(z) <= 0.05 && d > 0];
    return { n: a.length, nb: b.length, ma: r2(ma), mb: r2(mb), d: r2(d), h1: r2(h1), h2: r2(h2), yr: Object.fromEntries(yr.map(x => [x[0], r2(x[1])])), p: r2(pTwo(z) * 1000) / 1000, g, pass: g.filter(Boolean).length,
        win: r2(a.filter(x => x > 0).length / a.length * 100) };
}

// ═══════ selftest ═══════
function mkRows(n, f, vol = () => 1e7) { const days = []; let d = new Date(Date.UTC(2015, 0, 5)); for (let i = 0; i < n; i++) { while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5); days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    return days.map((dd, i) => { const c = f(i); return { date: dd, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: vol(i) }; }); }
function selftest() {
    let ok = 0, bad = 0; const T = (cnd, m) => { console.log((cnd ? '  ✅ ' : '  ❌ ') + m); cnd ? ok++ : bad++; };
    const c = Float64Array.from([10, 11, 12, 11, 10, 12]);
    const b = boxPrev(c, 5, 5);
    T(b.hi === 12 && b.lo === 10 && !(c[5] > b.hi), '① 盤整區用前 K 根(⛔ 不含今天):今天收盤 = 前高 → ⛔ 不算突破');
    const o = obvSeries(Float64Array.from([10, 11, 11, 10]), Float64Array.from([1, 5, 7, 2]));
    T(o[3] === 3 && o[2] === 5, '② OBV 走 lib_indicators.obvSeries(漲加量、跌減量、平不動)');
    // ③ 注入:每次「盤整 20 天 + 上穿 10 日線 + OBV 上翹」之後 10 根每根 +0.4% → SO 比 S 好、而且量得到
    const tw = new Map(); const acc = { ev: new Map(), skip: { cliff: 0, illiq: 0, limit: 0 } };
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let s = 0; s < 60; s++) {
        const n = 1200, base = [], vol = []; let p = 100;
        for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.02; base.push(p); vol.push(1e6 * (0.5 + rnd())); }
        const cc = Float64Array.from(base), ob = obvSeries(cc, Float64Array.from(vol)), m10 = rollMa(cc, 10);
        const mult = new Float64Array(n).fill(1);
        for (let t = WARM; t < n - 15; t++) { const bx = boxPrev(cc, t, 20); if (bx.hi - bx.lo <= bx.lo * 0.12 && cc[t] > m10[t] && cc[t - 1] <= m10[t - 1] && ob[t] > ob[t - 10]) for (let k = t + 1; k <= t + 10; k++) mult[k] *= 1.004; }
        let mm = 1; const rows = base.map((x, i) => { mm *= mult[i]; return x * mm; });
        const R = mkRows(n, i => rows[i], i => vol[i] * 100);
        if (!s) R.forEach(r => tw.set(r.date, 10000));
        scanStock(R, tw, acc);
    }
    const SO = acc.ev.get('SO|20|0.12|10|10') || [], S = acc.ev.get('S|20|0.12|10') || [];
    const c3 = cmp(SO, S, 'a');
    T(SO.length > 30 && c3.d > 0.5, `③ 注入 OBV 那組多 +4% → 量得到(SO ${SO.length} 筆 vs S,吊燈出場差 ${c3.d}pp)`);
    const X = acc.ev.get('X|10') || [], BS = acc.ev.get('BASE|10') || [];
    T(X.length > SO.length && BS.length > 0, `④ 對照組都有:上穿 ${X.length} ・隨便一天 ${BS.length}`);
    // ⑤ 去重 + 漲停剔除
    const acc2 = { ev: new Map(), skip: { cliff: 0, illiq: 0, limit: 0 } };
    const R5 = mkRows(500, i => i < 400 ? 100 + (i % 3) * 0.1 : 100 * Math.pow(1.002, i - 399), () => 1e7);
    R5[450].close = R5[449].close * 1.1; R5[450].high = R5[450].close;
    scanStock(R5, tw, acc2);
    const x5 = acc2.ev.get('X|5') || [];
    T(acc2.skip.limit >= 1, `⑤ 收盤鎖漲停那天剔除(${acc2.skip.limit})`);
    let dupOk = true; const byKey = acc2.ev; for (const [, arr] of byKey) { for (let i = 1; i < arr.length; i++) if (arr[i].d === arr[i - 1].d) dupOk = false; }
    T(dupOk && x5.length < 40, `⑥ 同一個條件 ${DEDUP} 天內只算一次(上穿 5 日線 ${x5.length} 次)`);
    // ⑦ 使用者出場沒有停損:跌 8% 但仍在 5 日線上 → ⛔ 不可被 −5% 停損砍掉
    const R7 = mkRows(30, i => i < 10 ? 100 : i === 10 ? 101 : 101 * (1 + 0.001 * (i - 10)));
    R7[11].low = 92;   // 盤中大跌但收盤沒破線
    const sm = simExits(R7.map(r => ({ o: r.open, h: r.high, l: r.low, c: r.close })), 10, { rules: ['ma5'], maxD: 15, holdStop: 99 });
    T(sm.ma5.why !== '停損', `⑦ 使用者那套只有「跌破線」才賣(holdStop 99 = 沒有 −5% 停損;why = ${sm.ma5.why})`);
    // ⑧ 雜訊 → 不可全過
    const nz = Array.from({ length: 400 }, (_, i) => ({ d: `20${15 + (i % 8)}-0${1 + (i % 9)}-10`, u: (rnd() - 0.5) * 5 }));
    const nz2 = Array.from({ length: 400 }, (_, i) => ({ d: `20${15 + (i % 8)}-0${1 + (i % 9)}-10`, u: (rnd() - 0.5) * 5 }));
    T(cmp(nz, nz2).pass < 6, `⑧ 兩組雜訊 → 六關不可全過(${cmp(nz, nz2).pass}/6)`);
    console.log(`\n${bad ? '❌' : '✅'} SQUEEZE_OBV_SELFTEST ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const DATA = process.env.DATA_DIR; if (!DATA) { console.log('❌ DATA_DIR'); process.exit(1); }
    const OUT = process.argv.slice(2).find(a => a.endsWith('.json'));
    const tw = new Map(JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => [nd(r.date), +r.close]));
    const acc = { ev: new Map(), skip: { cliff: 0, illiq: 0, limit: 0 } };
    const files = fs.readdirSync(DATA).filter(f => /^[1-9]\d{3}\.json$/.test(f));
    let used = 0;
    for (const f of files) {
        let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(rows)) continue; rows.sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
        if (scanStock(rows, tw, acc)) used++;
        if (used % 400 === 0) process.stdout.write(`\r  ${used} 檔…`);
    }
    const allD = [...(acc.ev.get('BASE|10') || [])].map(e => e.d).sort();
    console.log(`\r📊 ${used} 檔 ・窗口 ${allD[0]} ~ ${allD.at(-1)} ・剔除:斷崖 ${acc.skip.cliff} 檔 ・量少 ${acc.skip.illiq.toLocaleString()} ・收盤漲停 ${acc.skip.limit.toLocaleString()}`);
    const E = k => acc.ev.get(k) || [];
    const fmtR = x => x.small ? `樣本不足(${x.n})` : `n=${x.n} ・平均 ${x.ma} vs ${x.mb} → ${x.d >= 0 ? '+' : ''}${x.d}pp ・前後半 ${x.h1}/${x.h2} ・p=${x.p} ・六關 ${x.pass}/6`;
    const avg = (arr, f) => r2(mean(arr.map(e => e[f]).filter(v => v != null)));
    const out = { win: [allD[0], allD.at(-1)], center: {}, grid: [], exits: {}, base: {} };
    console.log('\n【對照】隨便哪天買(每 20 根抽一天)・使用者出場「跌破 N 日線才賣」/ 現行吊燈 2 倍 20 天(都已扣成本、扣大盤)');
    for (const N of NS) { const b = E(`BASE|${N}`); out.base[N] = { n: b.length, u: avg(b, 'u'), a: avg(b, 'a'), days: avg(b, 'days') }; console.log(`  N=${N}:n=${b.length} ・跌破 ${N} 日線 ${avg(b, 'u')}%(抱 ${avg(b, 'days')} 天)・吊燈 ${avg(b, 'a')}%`); }
    // 中心點
    for (const V of ['A', 'B']) {
        const pre = V === 'A' ? 'S' : 'B', preO = V === 'A' ? 'SO' : 'BO';
        const K = 20, W = 0.12, N = 10, M = 10;
        const so = E(`${preO}|${K}|${W}|${N}|${M}`), s = E(`${pre}|${K}|${W}|${N}`), x = E(`X|${N}`), b = E(`BASE|${N}`);
        console.log(`\n══ 中心點 ${V === 'A' ? 'A 版:盤整 20 天(≤12%)+ 上穿 10 日線' : 'B 版:盤整 20 天(≤12%)+ 突破盤整區'} + OBV 10 日上翹 ・出場 = 跌破 10 日線 ══`);
        const r = { so: { n: so.length, u: avg(so, 'u'), un: avg(so, 'un'), days: avg(so, 'days'), win: r2(so.filter(e => e.un > 0).length / Math.max(1, so.length) * 100) },
            obvInc: cmp(so, s), squeezeInc: V === 'A' ? cmp(s, x) : null, vsBase: cmp(so, b),
            exits: { user: avg(so, 'u'), atr2: avg(so, 'a'), don20: avg(so, 'dn') },
            hi: { so: cmp(so.filter(e => e.hi), b.filter(e => e.hi)), obvIncHi: cmp(so.filter(e => e.hi), s.filter(e => e.hi)) } };
        out.center[V] = r;
        console.log(`  事件 ${so.length} ・平均超額 ${r.so.u}%(扣成本毛利 ${r.so.un}%)・賺錢比例 ${r.so.win}% ・平均抱 ${r.so.days} 天`);
        console.log(`  💧 OBV 有沒有加分(vs 同條件沒 OBV):${fmtR(r.obvInc)}`);
        if (r.squeezeInc) console.log(`  📦 盤整有沒有加分(vs 所有上穿 10 日線):${fmtR(r.squeezeInc)}`);
        console.log(`  🎲 vs 隨便哪天買(同出場):${fmtR(r.vsBase)}`);
        console.log(`  🚪 同一批進場換出場:跌破 10 日線 ${r.exits.user}% ・吊燈 2 倍 20 天 ${r.exits.atr2}% ・唐奇安 20 天 ${r.exits.don20}%`);
        console.log(`  🧬 疊一年位置 ≥85%:vs 高位階隨便哪天 ${fmtR(r.hi.so)} ・OBV 加分 ${fmtR(r.hi.obvIncHi)}`);
    }
    // 網格
    let posInc = 0, tot = 0, full = 0, fullBase = 0;
    for (const V of ['A', 'B']) for (const K of KS) for (const W of WS) for (const N of NS) for (const M of MS) {
        const so = E(`${V === 'A' ? 'SO' : 'BO'}|${K}|${W}|${N}|${M}`), s = E(`${V === 'A' ? 'S' : 'B'}|${K}|${W}|${N}`), b = E(`BASE|${N}`);
        const inc = cmp(so, s), vb = cmp(so, b); if (inc.small) continue;
        tot++; if (inc.d > 0) posInc++; if (inc.pass === 6) full++; if (vb.pass === 6) fullBase++;
        out.grid.push({ V, K, W, N, M, n: so.length, u: avg(so, 'u'), a: avg(so, 'a'), inc: inc.d, incPass: inc.pass, vb: vb.d, vbPass: vb.pass });
    }
    out.gridSum = { tot, posInc, full, fullBase };
    console.log(`\n══ 高原網格 ${tot} 格(K×W×N×M×A/B,樣本 ≥30)══\n  OBV 加分為正 ${posInc} 格 ・OBV 加分六關全過 ${full} 格 ・贏隨便哪天六關全過 ${fullBase} 格`);
    const top = [...out.grid].sort((a, b) => b.u - a.u).slice(0, 8);
    console.log('  平均超額最高的 8 格(⚠️ 挑最高 = 樂觀):'); for (const g of top) console.log(`   ${g.V} K${g.K} W${g.W * 100}% N${g.N} M${g.M}:n=${g.n} 超額 ${g.u}%(吊燈出場 ${g.a}%)・OBV 加分 ${g.inc}pp(${g.incPass}/6)・vs 隨便 ${g.vb}pp(${g.vbPass}/6)`);
    // 出場整體比較(所有 SO 事件)
    const allSO = [...acc.ev.entries()].filter(([k]) => k.startsWith('SO|') || k.startsWith('BO|')).flatMap(([, a]) => a);
    out.exits = { n: allSO.length, user: avg(allSO, 'u'), atr2: avg(allSO, 'a'), don20: avg(allSO, 'dn') };
    console.log(`\n🚪 全部格子的事件一起看(會重複算):跌破 N 日線 ${out.exits.user}% ・吊燈 ${out.exits.atr2}% ・唐奇安 20 ${out.exits.don20}%`);
    if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out)); console.log(`💾 ${OUT}`); }
}

const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (_isMain) { if (process.argv.includes('--selftest')) process.exit(selftest()); else main(); }
