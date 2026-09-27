#!/usr/bin/env node
/**
 * 💧 OBV(能量潮)還沒測過的幾種用法 —— V77.7.0(使用者上傳 13 份 OBV 逐字稿:「有沒有用?以前測過嗎?要不要跟別的一起用?」)
 *
 * ⭐ 先查登記表:**已經測過、⛔ 這支不重測**:
 *   ・OBV 頂/底背離(`_detectObvDivergence`)→ `_SIGNAL_EDGE` 兩條都是 C 級(底背離 −0.29pp、頂背離 +0.06)
 *   ・OBV 與價格同步創 20 日新高 +0.25pp、OBV 創新高但價格沒有(量先價行)+0.02 → `indicator_zoo_probe` 六關 0 過
 *   ・OBV×MACD×量「量能動能發動」→ 以前**從來沒被驗過**(回測環境沒給 indicators),V77.7.0 修好 signal_backtest 一起跑
 * 🆕 這支只測逐字稿裡**真的沒切過**的:
 *   O1 OBV 上穿**自己的 N 日均線**(N = 20 / 30 / 34 高原)       對照組 = 所有(股·日)
 *   O2 **真假突破**:價格創 60 日新高那天,OBV 是不是**已經先**創 60 日新高(前 5 天內)   對照組 = 所有創 60 日新高
 *   O3 OBV **橫盤**一段(淨流量 ÷ 總成交量 ≤ 門檻)之後突破      對照組 = 所有(股·日)
 *   O4 **洗盤**:回檔到月線時 OBV 還守在自己的 30 日均線之上       對照組 = 所有回檔到月線
 *   O5 「要不要跟別的一起用」:O1~O3 疊在**高位階(一年位階 ≥75%,🧬 的一半)**上   對照組 = 高位階全部
 *
 * 方法(照 laoyu_probe):條件用 t 日收盤後才知道的資料 → 進場 t+1 開盤;t+1 開盤漲停剔除;20 日均額 ≥ 3,000 萬;
 *   同檔同桶 20 日去重;扣同期加權;六關(全期 / 前後半 / 逐年 / 去最好年 / 扣成本 0.44 / p ≤ 0.05)。
 *   🚧 基準區間 ⛔ 不含被判斷的那一根(陷阱 #43):「創 60 日新高」比的是 [t-60, t-1] 的最高收盤;OBV 同理。
 * ⚠️ 限制:倖存者偏誤;不含股利;日 K;OBV 用的是股數(不是金額)。
 *
 * 用法:DATA_DIR=<合併過 klines_deep 的目錄> node --max-old-space-size=6144 scripts/obv_probe.mjs [輸出.json]
 *       node scripts/obv_probe.mjs --selftest
 * ⛔ 只讀、不打 API。exit 0(探針不進四驗證)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';

const COST = 0.44;
const HOLDS = [5, 10, 20];
const DEDUP = 20;
const MIN_EV = 400;
const WARM = 250;
const LIQ_MIN = 3e7;
const LIMIT_UP = 1.095;
const NH = 60;             // 創 N 日新高
const LEAD = 5;            // OBV「先」創新高:前 LEAD 天內
const BASE_OF = { O1: 'ALL', O2: 'BRK_ALL', O3: 'ALL', O4: 'PB_ALL', O5: 'HI_ALL' };
const DIR_OF = { O1: +1, O2: +1, O3: +1, O4: +1, O5: +1 };

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
};
const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);

function loadTwii() {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
        .map(r => ({ d: nd(r.date), c: +r.close }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
        .sort((a, b) => a.d < b.d ? -1 : 1);
    return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])) };
}


// ═══════════ 累加器 ═══════════
const mk = () => HOLDS.map(() => ({ n: 0, s: 0, ss: 0, w: 0 }));
const ACC = new Map();
const SKIP = { limitUp: 0, illiquid: 0 };
function bump(g, b, y, half, rets) {
    const k = `${g}|${b}`;
    let a = ACC.get(k);
    if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()] }; ACC.set(k, a); }
    let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
    for (let i = 0; i < HOLDS.length; i++) {
        const v = rets[i]; if (v === null) continue;
        for (const t of [a.all[i], yy[i], a.byHalf[half][i]]) { t.n++; t.s += v; t.ss += v * v; if (v > 0) t.w++; }
    }
}
const stat = t => t.n ? { n: t.n, m: t.s / t.n, v: Math.max(0, t.ss / t.n - (t.s / t.n) ** 2), w: t.w / t.n * 100 } : { n: 0, m: 0, v: 0, w: 0 };
const margin = (a, b) => {
    const A = stat(a), B = stat(b);
    if (!A.n || !B.n) return { n: A.n, d: 0, z: 0, p: 1 };
    const se = Math.sqrt(A.v / A.n + B.v / B.n);
    const z = se > 0 ? (A.m - B.m) / se : 0;
    return { n: A.n, d: A.m - B.m, z, p: pTwoSided(z) };
};

// ═══════════ 每一根的條件(抽出來給 selftest 直接測)═══════════
export function obvSeries(c, vol) {
    const n = c.length, obv = new Float64Array(n);
    for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + (c[i] > c[i - 1] ? vol[i] : c[i] < c[i - 1] ? -vol[i] : 0);
    return obv;
}
const maAt = (a, t, N) => { if (t < N - 1) return NaN; let s = 0; for (let k = t - N + 1; k <= t; k++) s += a[k]; return s / N; };
const maxPrev = (a, t, N) => { let m = -Infinity; for (let k = t - N; k < t; k++) if (a[k] > m) m = a[k]; return m; };   // ⛔ 不含今日
const minPrev = (a, t, N) => { let m = Infinity; for (let k = t - N; k < t; k++) if (a[k] < m) m = a[k]; return m; };

export function barConds(t, c, h, l, vol, obv) {
    const out = [];
    const add = (g, b) => out.push([g, b]);
    add('O1', 'ALL'); add('O3', 'ALL');
    // O1 上穿自己的 N 日均線
    for (const N of [20, 30, 34]) {
        const m0 = maAt(obv, t, N), m1 = maAt(obv, t - 1, N);
        if (obv[t] > m0 && obv[t - 1] <= m1) add('O1', `OBV 上穿自己的 ${N} 日均線`);
    }
    // O2 創 60 日新高(收盤 > 前 60 根最高收盤,⛔ 不含今日)
    const brk = c[t] > maxPrev(c, t, NH);
    let lead = false;
    if (brk) {
        add('O2', 'BRK_ALL');
        for (let k = t - LEAD; k <= t - 1; k++) if (obv[k] > maxPrev(obv, k, NH)) { lead = true; break; }
        const sync = obv[t] > maxPrev(obv, t, NH);
        add('O2', lead ? 'OBV 先創新高(前 5 天內)= 他說的真突破' : 'OBV 沒有先創新高 = 他說的假突破');
        add('O2', sync ? '  OBV 今天也創新高' : '  OBV 今天沒有創新高');
    }
    // O3 OBV 橫盤後突破:前 N 根淨流量 ÷ 總量 ≤ flat,今天 OBV > 前 N 根最高
    let o3 = false;
    for (const N of [40, 60, 80]) {
        let tv = 0; for (let k = t - N; k < t; k++) tv += vol[k];
        if (!(tv > 0)) continue;
        const band = (maxPrev(obv, t, N) - minPrev(obv, t, N)) / tv;
        for (const fl of [0.15, 0.25]) {
            if (band <= fl && obv[t] > maxPrev(obv, t, N)) { add('O3', `OBV 橫盤 ${N} 天(區間≤${fl}×總量)後突破`); if (N === 60 && fl === 0.25) o3 = true; }
        }
    }
    // O4 回檔到月線:近 10 天最高收盤回落 ≥5%、今天最低碰到月線、收在月線之上、月線上彎
    const ma20 = maAt(c, t, 20), ma20p = maAt(c, t - 5, 20);
    if (ma20 > 0 && ma20 > ma20p && l[t] <= ma20 * 1.01 && c[t] >= ma20 && c[t] <= maxPrev(c, t, 10) * 0.95) {
        add('O4', 'PB_ALL');
        const om = maAt(obv, t, 30);
        add('O4', obv[t] >= om ? 'OBV 仍在自己 30 日均線之上(他說的洗盤)' : 'OBV 已跌破自己 30 日均線(他說的出貨)');
    }
    // O5 高位階疊加
    let L250 = Infinity, H250 = -Infinity;
    for (let k = t - WARM + 1; k <= t; k++) { if (l[k] > 0 && l[k] < L250) L250 = l[k]; if (h[k] > H250) H250 = h[k]; }
    const pos = H250 > L250 ? (c[t] - L250) / (H250 - L250) : 0;
    if (pos >= 0.75) {
        add('O5', 'HI_ALL');
        const m0 = maAt(obv, t, 30), m1 = maAt(obv, t - 1, 30);
        if (obv[t] > m0 && obv[t - 1] <= m1) add('O5', '高位階 + OBV 上穿 30 日均線');
        if (brk) add('O5', lead ? '高位階 + 創新高 + OBV 先創新高' : '高位階 + 創新高 + OBV 沒先創新高');
        if (o3) add('O5', '高位階 + OBV 橫盤 60 天後突破');
    }
    return out;
}

// ═══════════ 逐檔掃 ═══════════
function scanSymbol(rows, TW, halfCut, dateTally) {
    const n = rows.length;
    if (n < WARM + 30) return 0;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
    const vol = new Float64Array(n), amt = new Float64Array(n), dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        o[i] = +r.open; h[i] = +r.high; l[i] = +r.low; c[i] = +r.close; vol[i] = +r.volume || 0;
        amt[i] = c[i] * vol[i]; dt[i] = nd(r.date);
    }
    for (let i = 1; i < n; i++) if (c[i] > 0 && c[i - 1] > 0 && (c[i] / c[i - 1] > 1.4 || c[i] / c[i - 1] < 0.6)) return 0;
    const obv = obvSeries(c, vol);
    const last = new Map();
    let ev = 0;
    for (let t = WARM; t < n - 1; t++) {
        if (!(o[t] > 0 && c[t] > 0)) continue;
        let aSum = 0, aCnt = 0;
        for (let k = t - 20; k < t; k++) if (amt[k] > 0) { aSum += amt[k]; aCnt++; }
        if (!aCnt || aSum / aCnt < LIQ_MIN) { SKIP.illiquid++; continue; }
        const e = t + 1;
        if (!(o[e] > 0) || o[e] >= c[t] * LIMIT_UP) { SKIP.limitUp++; continue; }
        const twEnter = TW.c.get(dt[e]);
        if (!twEnter) continue;
        const rets = HOLDS.map(H => {
            const x = e + H; if (x >= n || !(c[x] > 0)) return null;
            const twX = TW.c.get(dt[x]); if (!twX) return null;
            return (c[x] / o[e] - 1) * 100 - (twX / twEnter - 1) * 100;
        });
        if (rets.every(v => v === null)) continue;
        const y = +dt[t].slice(0, 4);
        for (const [g, b] of barConds(t, c, h, l, vol, obv)) {
            const k = `${g}|${b}`;
            if (last.has(k) && t - last.get(k) < DEDUP) continue;
            last.set(k, t); ev++;
            if (dateTally) { if (b === BASE_OF[g]) dateTally[g].set(dt[t], (dateTally[g].get(dt[t]) || 0) + 1); continue; }
            bump(g, b, y, dt[t] < halfCut[g] ? 0 : 1, rets);
        }
    }
    return ev;
}

// ═══════════ 關卡 ═══════════
function gates(a, base, hi, dir = +1) {
    const M = margin(a.all[hi], base.all[hi]);
    const H = [0, 1].map(k => margin(a.byHalf[k][hi], base.byHalf[k][hi]).d);
    const yrs = [...a.byYear.keys()].sort();
    const YR = yrs.map(y => ({ y, n: a.byYear.get(y)[hi].n, d: base.byYear.has(y) ? margin(a.byYear.get(y)[hi], base.byYear.get(y)[hi]).d : 0 }))
        .filter(x => x.n >= 20);
    const sgn = dir;
    const sameHalf = H.every(d => Math.sign(d) === sgn);
    const sameYear = YR.length >= 3 && YR.every(x => Math.sign(x.d) === sgn);
    let dropBest = 0;
    if (YR.length >= 3) {
        const bi = YR.reduce((b, x, i) => (sgn > 0 ? x.d > YR[b].d : x.d < YR[b].d) ? i : b, 0);
        const rest = YR.filter((_, i) => i !== bi);
        const tot = rest.reduce((s, x) => s + x.n, 0);
        dropBest = tot ? rest.reduce((s, x) => s + x.d * x.n, 0) / tot : 0;
    }
    const pass = {
        '①全期': Math.sign(M.d) === sgn && M.d !== 0,
        '②前後半': sameHalf,
        '③逐年': sameYear,
        '④去最好年': Math.sign(dropBest) === sgn && dropBest !== 0,
        '⑤扣成本': sgn * M.d - COST > 0,
        '⑥檢定': M.p <= 0.05,
    };
    const bearRuler = dir < 0 ? (M.d < 0 && M.p <= 0.25) : null;   // V76.1.7 空方尺
    return { M, H, YR, dropBest, pass, nPass: Object.values(pass).filter(Boolean).length, bearRuler };
}

// ═══════════ selftest 工具 ═══════════
function mkDays(NBAR) {
    const days = []; let d = new Date(Date.UTC(2021, 0, 4));
    for (let i = 0; i < NBAR; i++) {
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5);
        days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5);
    }
    return days;
}
// ═══════════ selftest ═══════════
function selftest() {
    console.log('🧪 selftest —— 條件本身 + 注入已知邊際量不量得到\n');
    let bad = 0;
    const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    // ① OBV 公式
    const cc = Float64Array.from([10, 11, 11, 10, 12]), vv = Float64Array.from([5, 3, 4, 2, 6]);
    const ob = obvSeries(cc, vv);
    ck(ob[1] === 3 && ob[2] === 3 && ob[3] === 1 && ob[4] === 7, `① OBV = 漲加量、跌減量、平不動(${[...ob].join(',')})`);
    // ② 創新高比的是前 60 根,⛔ 不含今日(陷阱 #43):今天剛好等於前高 → 不算
    const N = 400, c = new Float64Array(N).fill(100), h = new Float64Array(N).fill(101), l = new Float64Array(N).fill(99), v = new Float64Array(N).fill(1000);
    for (let i = 0; i < N; i++) c[i] = 100 + (i % 7) * 0.1;
    c[350] = 100.6;
    const o2 = obvSeries(c, v);
    const has = (arr, g, b) => arr.some(x => x[0] === g && x[1] === b);
    ck(!has(barConds(350, c, h, l, v, o2), 'O2', 'BRK_ALL'), '② 收盤 = 前 60 根最高 → ⛔ 不算創新高(基準不含今日)');
    c[351] = 105; const o2b = obvSeries(c, v);
    ck(has(barConds(351, c, h, l, v, o2b), 'O2', 'BRK_ALL'), '②b 收盤 > 前 60 根最高 → 算創新高');
    // ③ OBV 先創新高:把前 3 天的量灌大(價格小漲)→ lead
    const c3 = Float64Array.from(c), v3 = Float64Array.from(v);
    for (let i = 300; i < 400; i++) c3[i] = 100 + (i % 7) * 0.1;
    for (let k = 346; k <= 349; k++) { c3[k] = c3[k - 1] + 0.01; v3[k] = 90000; }
    c3[350] = 120; const o3 = obvSeries(c3, v3);
    ck(has(barConds(350, c3, h, l, v3, o3), 'O2', 'OBV 先創新高(前 5 天內)= 他說的真突破'), '③ 前幾天量先衝 → 判成「OBV 先創新高」');
    const c3b = new Float64Array(N); for (let i = 0; i < N; i++) c3b[i] = 100 - (i % 7) * 0.1; c3b[350] = 120; const o3b = obvSeries(c3b, v);   // 六跌一漲 → OBV 一路往下
    ck(has(barConds(350, c3b, h, l, v, o3b), 'O2', 'OBV 沒有先創新高 = 他說的假突破'), '③b 前幾天量沒動 → 判成「沒有先創新高」');
    // ④ 注入:只有「OBV 上穿 30 日均線」那幾天之後的走勢多 +3%,探針要量得到;其餘桶 ≈ 0
    const days = mkDays(1300); const TW = { days, c: new Map(days.map(x => [x, 10000])) };
    ACC.clear();
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const halfCut = { O1: days[650], O2: days[650], O3: days[650], O4: days[650], O5: days[650] };
    for (let s = 0; s < 60; s++) {
        const rows = []; let p = 50;
        const vol = []; for (let i = 0; i < 1300; i++) vol.push(1e6 * (0.5 + rnd()));
        const pc = [];
        for (let i = 0; i < 1300; i++) { p *= 1 + (rnd() - 0.5) * 0.03; pc.push(p); }
        // 先算一次 OBV 找上穿日,之後 12 根每根 +0.3%
        const ob4 = obvSeries(Float64Array.from(pc), Float64Array.from(vol));
        const bump4 = new Float64Array(1300).fill(1);
        for (let t = 260; t < 1270; t++) {
            const m0 = maAt(ob4, t, 30), m1 = maAt(ob4, t - 1, 30);
            if (ob4[t] > m0 && ob4[t - 1] <= m1) for (let k = t + 2; k <= t + 12; k++) bump4[k] *= 1.003;
        }
        let mult = 1;
        for (let i = 0; i < 1300; i++) {
            mult *= bump4[i];
            const cl = pc[i] * mult;
            rows.push({ date: days[i], open: i ? rows[i - 1].close : cl, high: cl * 1.01, low: cl * 0.99, close: cl, volume: vol[i] });
        }
        scanSymbol(rows, TW, halfCut, null);
    }
    const A = ACC.get('O1|OBV 上穿自己的 30 日均線'), B = ACC.get('O1|ALL');
    const m = A && B ? margin(A.all[1], B.all[1]) : { d: 0 };
    ck(m.d > 1, `④ 注入 +0.3%×11 根的邊際量得到(10 日 ${m.d.toFixed(2)}pp)`);
    const A2 = ACC.get('O2|OBV 沒有先創新高 = 他說的假突破'), B2 = ACC.get('O2|BRK_ALL');
    ck(!A2 || Math.abs(margin(A2.all[1], B2.all[1]).d) < 1.5, '④b 沒注入的桶 ≈ 0(⛔ 不可憑空冒出邊際)');
    // ⑤ 去重:同一條件 20 天內只算一次
    ACC.clear();
    const rows5 = []; for (let i = 0; i < 400; i++) rows5.push({ date: days[i], open: 100, high: 101, low: 99, close: 100 + (i >= 300 ? (i - 299) * 0.5 : 0), volume: 1e6 });
    scanSymbol(rows5, TW, halfCut, null);
    const d5 = ACC.get('O2|BRK_ALL');
    ck(d5 && d5.all[1].n <= 6, `⑤ 連漲 100 天每天都創新高 → 20 日去重後只算 ${d5 ? d5.all[1].n : 0} 次`);
    // ⑥ t+1 漲停剔除
    ACC.clear(); SKIP.limitUp = 0;
    const rows6 = rows5.map((r, i) => i === 320 ? { ...r, open: rows5[319].close * 1.1 } : r);
    scanSymbol(rows6, TW, halfCut, null);
    ck(SKIP.limitUp >= 1, `⑥ t+1 開盤漲停那天剔除(${SKIP.limitUp})`);
    console.log(`\n${bad ? '❌ ' + bad + ' 條沒過' : '✅ 全過'}`);
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) selftest();

// ═══════════ 實跑 ═══════════
const TW = loadTwii();
console.log(`📅 大盤日曆 ${TW.days[0]} ~ ${TW.days[TW.days.length - 1]}(${TW.days.length} 個交易日)`);
if (TW.days[0] > '2022-06-01') console.log('🚨 窗口沒有涵蓋 2022 空頭 → 要用合併過深歷史的 DATA_DIR');
const files = fs.readdirSync(DATA).filter(x => /^[1-9]\d{3}\.json$/.test(x));
const readRows = fn => {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { return null; }
    if (!Array.isArray(rows) || rows.length < WARM + 60) return null;
    rows.sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
    return rows;
};
const tally = Object.fromEntries(Object.keys(BASE_OF).map(g => [g, new Map()]));
for (const fn of files) { const r = readRows(fn); if (r) scanSymbol(r, TW, null, tally); }
const halfCut = {}, gWin = {};
for (const g of Object.keys(tally)) {
    const ds = [...tally[g].entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const tot = ds.reduce((s, x) => s + x[1], 0);
    let acc = 0, cut = ds.length ? ds[ds.length - 1][0] : '9999';
    for (const [d, n] of ds) { acc += n; if (acc >= tot / 2) { cut = d; break; } }
    halfCut[g] = cut; gWin[g] = ds.length ? [ds[0][0], ds[ds.length - 1][0], cut, tot] : ['—', '—', '—', 0];
}
SKIP.limitUp = 0; SKIP.illiquid = 0;
let used = 0, evTot = 0;
for (const fn of files) { const rows = readRows(fn); if (!rows) continue; const e = scanSymbol(rows, TW, halfCut, null); if (e) { used++; evTot += e; } }
console.log(`📊 掃 ${used} 檔 ・事件 ${evTot.toLocaleString()} 筆(同檔同桶 ${DEDUP} 日去重)`);
console.log(`🛒 買得到嗎擋掉:t+1 開盤漲停 ${SKIP.limitUp.toLocaleString()} ・20 日均額 < 3,000 萬 ${SKIP.illiquid.toLocaleString()} 個(股·日)\n`);
const GROUPS = [
    ['O1', '💧 O1 OBV 上穿自己的均線(對照組 = 所有股·日)', 'ALL', ['OBV 上穿自己的 20 日均線', 'OBV 上穿自己的 30 日均線', 'OBV 上穿自己的 34 日均線']],
    ['O2', '💧 O2 真假突破:創 60 日新高那天,OBV 有沒有先創新高(對照組 = 所有創 60 日新高)', 'BRK_ALL',
     ['OBV 先創新高(前 5 天內)= 他說的真突破', 'OBV 沒有先創新高 = 他說的假突破', '  OBV 今天也創新高', '  OBV 今天沒有創新高']],
    ['O3', '💧 O3 OBV 橫盤後突破(對照組 = 所有股·日)', 'ALL',
     [40, 60, 80].flatMap(N => [0.15, 0.25].map(fl => `OBV 橫盤 ${N} 天(區間≤${fl}×總量)後突破`))],
    ['O4', '💧 O4 洗盤還是出貨:回檔到月線時 OBV 在不在自己 30 日均線上(對照組 = 所有回檔到月線)', 'PB_ALL',
     ['OBV 仍在自己 30 日均線之上(他說的洗盤)', 'OBV 已跌破自己 30 日均線(他說的出貨)']],
    ['O5', '💧 O5 跟別的一起用:疊在高位階(一年位階 ≥75%)上(對照組 = 高位階全部)', 'HI_ALL',
     ['高位階 + OBV 上穿 30 日均線', '高位階 + 創新高 + OBV 先創新高', '高位階 + 創新高 + OBV 沒先創新高', '高位階 + OBV 橫盤 60 天後突破']],
];
const report = { window: [TW.days[0], TW.days[TW.days.length - 1]], syms: used, events: evTot, cost: COST, groups: {} };
for (const [g, title, baseKey, buckets] of GROUPS) {
    const base = ACC.get(`${g}|${baseKey}`);
    console.log('═'.repeat(88)); console.log(title);
    console.log(`  窗口 ${gWin[g][0]} ~ ${gWin[g][1]} ・前後半切點 ${gWin[g][2]}`);
    if (!base || base.all[1].n < MIN_EV) { console.log(`  🚧 對照組只有 ${base ? base.all[1].n : 0} 筆 → ⛔ 不給結論\n`); continue; }
    const bm = HOLDS.map((_, i) => stat(base.all[i]));
    console.log(`  對照組 n=${base.all[1].n.toLocaleString()} ・超額 ${HOLDS.map((H, i) => `${H}日 ${f2(bm[i].m, 6)}`).join(' ・')} ・10 日勝率 ${bm[1].w.toFixed(1)}%`);
    const gout = { base: { n: base.all[1].n, m: bm.map(x => x.m), w: bm[1].w }, buckets: {} };
    for (const b of buckets) {
        const a = ACC.get(`${g}|${b}`);
        if (!a || a.all[1].n < 30) { console.log(`  ${b.padEnd(34)} ${String(a ? a.all[1].n : 0).padStart(7)}   —— 樣本太少`); continue; }
        const ds = HOLDS.map((_, i) => margin(a.all[i], base.all[i]).d);
        const G = gates(a, base, 1, +1); const S = stat(a.all[1]);
        console.log(`  ${b.padEnd(34)} ${String(G.M.n).padStart(7)} ${f2(ds[0], 7)} ${f2(ds[1], 7)} ${f2(ds[2], 7)}  扣成本 ${f2(ds[1] - COST, 6)} 勝率 ${S.w.toFixed(1)}% 絕對10 ${f2(S.m, 6)}  ${G.nPass === 6 ? '✅ 六關全過' : G.nPass + '/6'} p=${G.M.p.toFixed(4)}`);
        console.log(`      逐年:${G.YR.map(x => `${x.y} ${f2(x.d, 5)}`).join(' ・')} ・前半 ${f2(G.H[0], 5)} / 後半 ${f2(G.H[1], 5)}`);
        gout.buckets[b] = { n: G.M.n, d: ds, abs: S.m, w: S.w, p: G.M.p, nPass: G.nPass, pass: G.pass, half: G.H, byYear: G.YR };
    }
    gout.window = gWin[g]; report.groups[g] = gout; console.log();
}
console.log('🚨 「絕對10」= 那一桶自己的 10 日超額(扣同期加權)。邊際為正 ≠ 賺得到。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`💾 ${OUT}`); }
