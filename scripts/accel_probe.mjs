#!/usr/bin/env node
/**
 * 🚀 「大漲股捕捉引擎」規格裡**真的沒測過**的那幾層 —— 加速度 flag 七個 + 共振計數 + 大漲捕捉 KPI —— V77.4.2
 *
 * 使用者貼了 62 節規格(RS 加速 / 週轉加速 / ATR 壓縮→擴張 / 位階加速 / 突破品質 / 基本面加速 / 產業確認 /
 * flag 共振 / Big Winner Capture / Miss Rate / False Positive / regime)。⭐ 先查登記表:布林壓縮(kobo −0.89pp)、
 * TTM squeeze、突破 20/60/252 日高(`_SCR_EDGE` nh20 −0.72 / nh60 +0.13 / nh252 +1.47 六關沒全過)、
 * 週轉率水準(三次)、疊加型(chain −0.84 / td_wt 聖杯 / 六脈)、狀態機(regime_probe)全部測過 → 這支只做沒測過的。
 *
 * 七個 flag(全部只用 ≤t;基準⛔ 不含被判斷的那幾根,陷阱 #43):
 *   bit0 rsacc   RS_N = 個股 N 日報酬 − 加權同期(N=20/60/120);亮 = RS20>RS60>RS120 ∧ RS20>0 ∧ RS20[t]−RS20[t−20]>0
 *                變體 rsaccEW:基準換「全市場個股當日報酬中位數」累積(等權;加權被權值股拉著、中位數個股本來就跑輸)
 *   bit1 turnacc 規格的 TR5/TR20 擴張比 —— ⭐ 分母(總股數)抵銷 = 純量能比:mean(vo[t−4..t]) ÷ mean(vo[t−24..t−5]) ∈ [1.2, 3.0]
 *   bit2 atrx    r = ATR20/ATR60(簡單均,含今日);亮 = r[t]≥1 ∧ r[t−1]<1 ∧ min(r[t−20..t−1])<0.7(壓縮後第一次擴張);變體 atrxUp 加 c[t]>c[t−20]
 *   bit3 posacc  pos252[t]≥75 ∧ pos252[t−20]<50(剛衝進 🧬 位階);對照桶 POS:old = 20 天前就 ≥75
 *   bit4 bkq     突破品質:c ≥ max(c[t−60..t−1])(⛔ 不含今日)∧ CLV=(c−l)/(h−l)≥0.7 ∧ vo[t]/mean(vo[t−20..t−1])≥1.5
 *                拆解 BK:nh60 / nh60∧CLV / nh60∧vol / bkq;另 bkq20 / bkq120 / bkq252(規格沒列一年高,但那是唯一有訊號的窗口)
 *   bit5 finacc  fin_deep 34 季:yoy_k = rev_k/rev_{k−4}−1、acc_k = yoy_k − yoy_{k−1};亮 = yoy>0 ∧ acc>0;
 *                「知道」的那一季 = 最後一個 pubDate(p) ≤ 今天(法定截止日,保守;`lib_fundamentals.pubDate`);變體 +毛利率 QoQ≥0 / +EPS YoY>0
 *   bit6 indrs   產業日報酬 = 成員當日漲跌中位數(照 sector_rotation_probe);indRS20 = Σ20 日 − 加權 20 日;亮 = 所屬產業排名前 5
 *
 * 桶:BASE_ALL(amt≥0.1 億)/ GENE(🧬 pos≥75 ∧ amp≥3.2 ∧ amt≥1)/ F:<flag> / F:<flag>∧🧬 / SHAM:<flag>(每天從 🧬 抽同檔數,固定種子)
 *     / BK:* 突破拆解 / CNT5=k、CNT7=k 共振計數(⛔ 只計數不加權)/ PL:* 門檻高原(∧🧬,配 PLS:* sham)/ REF:rs8、REF:secTop3raw 錨點
 * 窗口:finacc 用 @F6(第一天 ≥100 檔「知道 ≥6 季」)、indrs 用 @IND、CNT7 用 @C7(兩者都到);⛔ 不寫死日期。
 * 進場 t+1 開盤 ・20 日去重 ・t+1 開盤漲停剔除 ・報酬扣同期加權 ・斷崖守門 ・六關 + z 檢定 + 高原 + sham
 * KPI(每桶):Big Winner = 20/60 日內最高收盤 ≥ +20/30/50%(對 op[t+1])・False Positive = 20 日內最低 ≤ −10% 且未曾 +10%
 *            ・P10~P90(水塘 20,000)・獲利因子(10/20 日)。⚠️ dtflip 已證「碰得到 ≠ 賺得到」→ 捕捉率旁一定印務實出法的邊際。
 * Miss Rate(無前視):起點 s 事後定義(60 日內最高收盤 ≥ +30% 且 c[s] 是那一波的谷底),只問 mask[s−5..s] 有沒有亮;
 *            旁邊印 randExpect = 1−(1−亮燈率)^6 —— 沒有它「捕捉 60%」毫無意義。
 * Regime:加權 > MA200 / < MA200 兩態(規格)+ MA60 五態(regime_matrix_probe 定義)—— 對照 = 同情境的 BASE。
 *
 * 用法:DATA_DIR=<合併 klines_deep 的目錄> FIN_DEEP=<fin_deep.json> node --max-old-space-size=6144 scripts/accel_probe.mjs [out.json]
 *       node scripts/accel_probe.mjs --selftest   (SCR=/SCR_DATA= 可覆寫 ⓪ 對表來源;FIN_SLICE=<data/fin 目錄> 對 pub)
 * ⛔ 探針 exit 0、不進四驗證;要接進 App 必須六關全過 + vs sham + 高原 + V75.0.9 五條件。
 */
import fs from 'fs';
import path from 'path';
import { pubDate } from './lib_fundamentals.mjs';
import { finSeries } from './lib_finaccel.mjs';
import { pctl, Reservoir, profitFactor, propZ, randExpect, pTwoSided } from './lib_perf.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const AUX = process.env.AUX_DIR || path.join(ROOT, 'data');
const FIN = process.env.FIN_DEEP || path.join(ROOT, 'fin_deep', 'fin_deep.json');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => !a.startsWith('--'));

const HOLDS = [5, 10, 20];
const COST = 0.44;
const DEDUP = 20;
const WARM = 253;
const LIMIT_UP = 1.095;
const MIN_EV = 100;
const BASE_MIN_AMT = 0.1;
const GENE_POS = 75, GENE_AMP = 3.2, GENE_AMT = 1;   // pro.html _EDGE_RULES.gene / CAST_MIN_AMT(⛔ 改一邊要改兩邊)
const FLAGS = ['rsacc', 'turnacc', 'atrx', 'posacc', 'bkq', 'finacc', 'indrs'];
const FLAG_WIN = { finacc: '@F6', indrs: '@IND' };
const IND_TOP = 5, MIN_MEMB = 5, MIN_IND = 20;
const TH = {
    rsacc: [0, 2, 4, 6, 8, 12],
    turnacc: [1.0, 1.2, 1.5, 2.0, 2.5, 3.0],
    atrSq: [0.6, 0.7, 0.8, 0.9], atrLook: [10, 20, 40],
    posacc: [30, 40, 50, 60, 70],
    clv: [0.5, 0.6, 0.7, 0.8, 0.9], volx: [1.0, 1.2, 1.5, 2.0, 3.0],
    finacc: [-Infinity, 0, 5, 10, 20],     // acc ≥ th pp(−∞ = 只要 yoy>0)
    indrs: [3, 5, 8, 11],
    cnt: [1, 2, 3, 4, 5],
};
const BW_TH = [20, 30, 50];

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => (x == null || Number.isNaN(x)) ? '—'.padStart(w) : (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const rng = seed => { let x = seed >>> 0 || 1; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };

// ═══════════ 欄位(前七欄⛔ 一律照 screener_miner.py::build_one;kingpool_probe 同一份)═══════════
function features(rows) {
    const n = rows.length;
    const c = new Float64Array(n), op = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n), vo = new Float64Array(n);
    const fn = new Float64Array(n).fill(NaN), tn = new Float64Array(n).fill(NaN);
    const dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        c[i] = +r.close; op[i] = +r.open; hi[i] = +(r.high || r.close); lo[i] = +(r.low || r.close); vo[i] = +(r.volume || 0);
        if (r.foreign_net != null) fn[i] = +r.foreign_net / 1000;
        if (r.trust_net != null) tn[i] = +r.trust_net / 1000;
        dt[i] = nd(r.date);
    }
    const F32 = () => new Float32Array(n).fill(NaN);
    const amt = new Float64Array(n), vr = F32(), pos = F32(), amp = F32(), b5 = F32(), b20 = F32(), chg = F32(), f5 = F32(), t5 = F32();
    let vsum20 = 0, csum5 = 0, csum20 = 0, asum20 = 0;
    for (let t = 0; t < n; t++) {
        amt[t] = c[t] * vo[t] / 1e8;
        if (t >= 1 && c[t - 1] > 0) chg[t] = (c[t] / c[t - 1] - 1) * 100;
        vsum20 += vo[t]; if (t >= 20) vsum20 -= vo[t - 20];
        if (t >= 19) { const v20 = vsum20 / 20; if (v20 > 0) vr[t] = vo[t] / v20 * 100; }
        csum5 += c[t]; if (t >= 5) csum5 -= c[t - 5];
        if (t >= 4) { const m = csum5 / 5; if (m > 0) b5[t] = (c[t] / m - 1) * 100; }
        csum20 += c[t]; if (t >= 20) csum20 -= c[t - 20];
        if (t >= 19) { const m = csum20 / 20; if (m > 0) b20[t] = (c[t] / m - 1) * 100; }
        const a = c[t] > 0 ? (hi[t] - lo[t]) / c[t] : 0;
        asum20 += a; if (t >= 20) asum20 -= (c[t - 20] > 0 ? (hi[t - 20] - lo[t - 20]) / c[t - 20] : 0);
        if (t >= 19) amp[t] = asum20 / 20 * 100;
        { const s = Math.max(0, t - 251); let h = -Infinity, l = Infinity; for (let k = s; k <= t; k++) { if (c[k] > h) h = c[k]; if (c[k] < l) l = c[k]; } if (h > l) pos[t] = (c[t] - l) / (h - l) * 100; }
        { let s = 0, k0 = 0, s2 = 0, k2 = 0; for (let k = Math.max(0, t - 4); k <= t; k++) { if (!Number.isNaN(fn[k])) { s += fn[k]; k0++; } if (!Number.isNaN(tn[k])) { s2 += tn[k]; k2++; } } if (k0) f5[t] = s; if (k2) t5[t] = s2; }
    }
    // ── 加速度用的新欄(⛔ 基準不含被判斷的那幾根)──
    const tx = F32(), atrR = F32(), atrMin10 = F32(), atrMin20 = F32(), atrMin40 = F32();
    const ph20 = F32(), ph60 = F32(), ph120 = F32(), ph252 = F32(), clv = F32(), volx = F32(), pos20 = F32(), ret20 = F32();
    const tr = new Float64Array(n);
    for (let t = 0; t < n; t++) tr[t] = t ? Math.max(hi[t] - lo[t], Math.abs(hi[t] - c[t - 1]), Math.abs(lo[t] - c[t - 1])) : hi[t] - lo[t];
    let s5 = 0, s25 = 0, tr20 = 0, tr60 = 0, v20p = 0;
    for (let t = 0; t < n; t++) {
        // 量能擴張:v5 = mean(vo[t−4..t]);v20p = mean(vo[t−24..t−5])
        s5 += vo[t]; if (t >= 5) s5 -= vo[t - 5];
        s25 += vo[t]; if (t >= 25) s25 -= vo[t - 25];
        if (t >= 24) { const a = s5 / 5, b = (s25 - s5) / 20; if (b > 0) tx[t] = a / b; }
        // ATR20 / ATR60(簡單均,含今日 —— 水準窗口)
        tr20 += tr[t]; if (t >= 20) tr20 -= tr[t - 20];
        tr60 += tr[t]; if (t >= 60) tr60 -= tr[t - 60];
        if (t >= 59 && tr60 > 0) atrR[t] = (tr20 / 20) / (tr60 / 60);
        // 前高⛔ 不含今日
        const mx = (N) => { if (t < N) return NaN; let h = -Infinity; for (let k = t - N; k < t; k++) if (c[k] > h) h = c[k]; return h; };
        ph20[t] = mx(20); ph60[t] = mx(60); ph120[t] = mx(120); ph252[t] = mx(252);
        if (hi[t] > lo[t]) clv[t] = (c[t] - lo[t]) / (hi[t] - lo[t]);
        // 量比⛔ 分母不含今日(跟 screener 的 vr 不同,那是含今日的水準)
        if (t >= 20) { v20p = 0; for (let k = t - 20; k < t; k++) v20p += vo[k]; v20p /= 20; if (v20p > 0) volx[t] = vo[t] / v20p; }
        if (t >= 20) { pos20[t] = pos[t - 20]; if (c[t - 20] > 0) ret20[t] = (c[t] / c[t - 20] - 1) * 100; }
    }
    for (let t = 0; t < n; t++) {
        const mn = (N) => { if (t < N + 59) return NaN; let m = Infinity; for (let k = t - N; k < t; k++) if (atrR[k] < m) m = atrR[k]; return m; };
        atrMin10[t] = mn(10); atrMin20[t] = mn(20); atrMin40[t] = mn(40);
    }
    return { n, c, op, hi, lo, vo, dt, amt, vr, pos, amp, b5, b20, chg, f5, t5,
        tx, atrR, atrMin10, atrMin20, atrMin40, ph20, ph60, ph120, ph252, clv, volx, pos20, ret20 };
}

/** RS(相對強度)—— 個股自己的 bar 對齊基準(⛔ 不用全域 g−N,停牌會錯位);base = 每根 bar 對應的基準指數值 */
function rsSeries(F, base) {
    const n = F.n, out = {};
    for (const N of [20, 60, 120]) {
        const a = new Float32Array(n).fill(NaN);
        for (let t = N; t < n; t++) if (F.c[t - N] > 0 && base[t] > 0 && base[t - N] > 0) a[t] = (F.c[t] / F.c[t - N] - 1) * 100 - (base[t] / base[t - N] - 1) * 100;
        out['rs' + N] = a;
    }
    const d = new Float32Array(n).fill(NaN);
    for (let t = 20; t < n; t++) d[t] = out.rs20[t] - out.rs20[t - 20];
    out.drs20 = d;
    return out;
}

// finSeries 住在 lib_finaccel.mjs(跟 portfolio_backtest 的 FIN= 濾網共用,⛔ 這裡不再有第二份公式)
/** 每根 bar「已經公布的最後一季」→ finKnown / finacc / finGm / finEps / finAccV(高原用) */
function finFlags(F, series) {
    const n = F.n, known = new Uint8Array(n), fa = new Uint8Array(n), fg = new Uint8Array(n), fe = new Uint8Array(n), accV = new Float32Array(n).fill(NaN), yoyV = new Float32Array(n).fill(NaN);
    if (!series || !series.length) return { known, fa, fg, fe, accV, yoyV };
    let k = -1;
    for (let t = 0; t < n; t++) {
        while (k + 1 < series.length && series[k + 1].pub <= F.dt[t]) k++;   // ⭐ pub ≤ 今天才「知道」(法定截止日,保守)
        if (k < 0) continue;
        const q = series[k]; if (!q.ok) continue;
        known[t] = 1; accV[t] = q.acc; yoyV[t] = q.yoy;
        if (q.yoy > 0 && q.acc > 0) { fa[t] = 1; if (q.gmq >= 0) fg[t] = 1; if (q.epsy > 0) fe[t] = 1; }
    }
    return { known, fa, fg, fe, accV, yoyV };
}

// ═══════════ 累加器 + 關卡(照 kingpool_probe)═══════════
const mk = () => HOLDS.map(() => ({ n: 0, s: 0, ss: 0, w: 0 }));
const stat = t => t.n ? { n: t.n, m: t.s / t.n, v: Math.max(0, t.ss / t.n - (t.s / t.n) ** 2), w: t.w / t.n * 100 } : { n: 0, m: 0, v: 0, w: 0 };
const margin = (a, b) => {
    const A = stat(a), B = stat(b);
    if (!A.n || !B.n) return { n: A.n, d: 0, z: 0, p: 1 };
    const se = Math.sqrt(A.v / A.n + B.v / B.n);
    const z = se > 0 ? (A.m - B.m) / se : 0;
    return { n: A.n, d: A.m - B.m, z, p: pTwoSided(z) };
};
function gates(a, base, hi = 1) {
    const M = margin(a.all[hi], base.all[hi]);
    const H = [0, 1].map(k => margin(a.byHalf[k][hi], base.byHalf[k][hi]).d);
    const yrs = [...a.byYear.keys()].sort();
    const YR = yrs.map(y => ({ y, n: a.byYear.get(y)[hi].n, d: base.byYear.has(y) ? margin(a.byYear.get(y)[hi], base.byYear.get(y)[hi]).d : 0 })).filter(x => x.n >= 20);
    const sameHalf = H.every(d => d > 0);
    const sameYear = YR.length >= 3 && YR.every(x => x.d > 0);
    let dropBest = 0;
    if (YR.length >= 3) {
        const bi = YR.reduce((b, x, i) => x.d > YR[b].d ? i : b, 0);
        const rest = YR.filter((_, i) => i !== bi), tot = rest.reduce((s, x) => s + x.n, 0);
        dropBest = tot ? rest.reduce((s, x) => s + x.d * x.n, 0) / tot : 0;
    }
    const pass = { '①全期': M.d > 0, '②前後半': sameHalf, '③逐年': sameYear, '④去最好年': dropBest > 0, '⑤扣成本': M.d - COST > 0, '⑥檢定': M.p <= 0.05 };
    return { M, H, YR, dropBest, pass, nPass: Object.values(pass).filter(Boolean).length, yrShort: YR.length < 3 };
}
const mkKpi = () => ({ n20: 0, n60: 0, bw20: [0, 0, 0], bw60: [0, 0, 0], fp: 0, sw10: 0, sl10: 0, sw20: 0, sl20: 0, res: new Reservoir(20000) });

// ═══════════ 大盤情境(regime_matrix_probe 的 MA60 五態 + 規格的 MA200 兩態)═══════════
function regimes(TW) {
    const n = TW.days.length, c = TW.days.map(d => TW.c.get(d)), h = TW.h || c, l = TW.l || c;
    const r200 = new Array(n).fill(null), r60 = new Array(n).fill(null);
    const ma = (N) => { const o = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += c[i]; if (i >= N) s -= c[i - N]; if (i >= N - 1) o[i] = s / N; } return o; };
    const ma200 = ma(200), ma60 = ma(60);
    const tr = c.map((x, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]);
    const atr = new Array(n).fill(null); { let a = null; for (let i = 0; i < n; i++) { a = a == null ? tr[i] : (a * 13 + tr[i]) / 14; if (i >= 13) atr[i] = a; } }
    for (let i = 0; i < n; i++) {
        if (ma200[i] != null) r200[i] = c[i] > ma200[i] ? 'up' : 'dn';
        if (i < 60) continue;
        const up = ma60[i] > ma60[i - 1], dn = ma60[i] < ma60[i - 1];
        if (c[i] > ma60[i] && up) { r60[i] = 'bull'; continue; }
        if (c[i] < ma60[i] && dn) { r60[i] = 'bear'; continue; }
        let hh = -Infinity, ll = Infinity; for (let q = i - 19; q <= i; q++) { if (h[q] > hh) hh = h[q]; if (l[q] < ll) ll = l[q]; }
        const amp20 = (hh - ll) / c[i] * 100;
        let rank = 0, cnt = 0; for (let q = Math.max(13, i - 249); q <= i; q++) { cnt++; if (atr[q] <= atr[i]) rank++; }
        r60[i] = amp20 < 5 ? 'flat' : (cnt ? rank / cnt : 0) >= 0.8 ? 'hivol' : 'mixed';
    }
    return { r200, r60 };
}

// ═══════════ 主迴圈 ═══════════
/** universe: Map sym → features;TW: {days, c:Map, h?, l?};opt.fin: Map sym → finSeries;opt.ind: Map sym → 產業碼 */
function run(universe, TW, opt = {}) {
    const days = TW.days, DI = new Map(days.map((d, i) => [d, i]));
    const syms = [...universe.keys()], AT = new Map();
    for (const s of syms) {
        const F = universe.get(s); const at = new Int32Array(days.length).fill(-1);
        for (let i = 0; i < F.n; i++) { const g = DI.get(F.dt[i]); if (g != null) at[g] = i; }
        AT.set(s, at);
    }
    const gEnd = days.length - 1;
    // ── 等權指數(全市場個股當日漲跌中位數累積)+ 加權 20 日報酬 ──
    const ew = new Float64Array(days.length).fill(NaN); { let lvl = 100; const tmp = [];
        for (let g = 0; g < days.length; g++) { tmp.length = 0; for (const s of syms) { const i = AT.get(s)[g]; if (i >= 1) { const v = universe.get(s).chg[i]; if (!Number.isNaN(v)) tmp.push(v); } } if (tmp.length >= 30) lvl *= 1 + med(tmp) / 100; ew[g] = lvl; } }
    const twC = days.map(d => TW.c.get(d));
    const twr20 = days.map((_, g) => g >= 20 ? (twC[g] / twC[g - 20] - 1) * 100 : NaN);
    // ── 產業日報酬中位數 → indRS20 → 每日排名 ──
    const indOf = opt.ind || new Map(); const inds = [...new Set([...indOf.values()])].sort();
    const indRank = new Map(inds.map(k => [k, new Int16Array(days.length).fill(-1)]));
    if (inds.length) {
        const indRet = new Map(inds.map(k => [k, new Float64Array(days.length).fill(NaN)]));
        const members = new Map(inds.map(k => [k, []])); for (const s of syms) { const k = indOf.get(s); if (k != null && members.has(k)) members.get(k).push(s); }
        const tmp = [];
        for (let g = 1; g < days.length; g++) for (const k of inds) { tmp.length = 0; for (const s of members.get(k)) { const i = AT.get(s)[g]; if (i >= 1) { const v = universe.get(s).chg[i]; if (!Number.isNaN(v)) tmp.push(v); } } if (tmp.length >= MIN_MEMB) indRet.get(k)[g] = med(tmp); }
        for (let g = 20; g < days.length; g++) {
            const sc = [];
            for (const k of inds) { let s = 0, ok = true; for (let q = g - 19; q <= g; q++) { const v = indRet.get(k)[q]; if (Number.isNaN(v)) { ok = false; break; } s += v; } if (ok && !Number.isNaN(twr20[g])) sc.push([k, s - twr20[g]]); }
            if (sc.length < MIN_IND) continue;
            sc.sort((a, b) => b[1] - a[1]); sc.forEach(([k], r) => { indRank.get(k)[g] = r + 1; });
        }
    }
    // ── 每檔:RS / fin / ind / mask ──
    const X = new Map();
    for (const s of syms) {
        const F = universe.get(s), at = AT.get(s), n = F.n;
        const twAt = new Float64Array(n).fill(NaN), ewAt = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) { const g = DI.get(F.dt[i]); if (g != null) { twAt[i] = twC[g]; ewAt[i] = ew[g]; } }
        const RS = rsSeries(F, twAt), RE = rsSeries(F, ewAt);
        const FI = finFlags(F, opt.fin ? opt.fin.get(s) : null);
        const rk = new Int16Array(n).fill(-1); const k = indOf.get(s);
        if (k != null && indRank.has(k)) for (let i = 0; i < n; i++) { const g = DI.get(F.dt[i]); if (g != null) rk[i] = indRank.get(k)[g]; }
        const mask = new Uint8Array(n), rsE = new Uint8Array(n), atrUp = new Uint8Array(n), nh60 = new Uint8Array(n), bk = { 20: new Uint8Array(n), 120: new Uint8Array(n), 252: new Uint8Array(n) };
        for (let t = WARM; t < n; t++) {
            let m = 0;
            if (RS.rs20[t] > RS.rs60[t] && RS.rs60[t] > RS.rs120[t] && RS.rs20[t] > 0 && RS.drs20[t] > 0) m |= 1;
            if (RE.rs20[t] > RE.rs60[t] && RE.rs60[t] > RE.rs120[t] && RE.rs20[t] > 0 && RE.drs20[t] > 0) rsE[t] = 1;
            if (F.tx[t] >= 1.2 && F.tx[t] <= 3.0) m |= 2;
            if (F.atrR[t] >= 1 && F.atrR[t - 1] < 1 && F.atrMin20[t] < 0.7) { m |= 4; if (F.c[t] > F.c[t - 20]) atrUp[t] = 1; }
            if (F.pos[t] >= GENE_POS && F.pos20[t] < 50) m |= 8;
            const q = F.clv[t] >= 0.7 && F.volx[t] >= 1.5;
            if (F.c[t] >= F.ph60[t]) { nh60[t] = 1; if (q) m |= 16; }
            for (const N of [20, 120, 252]) if (F.c[t] >= F['ph' + N][t] && q) bk[N][t] = 1;
            if (FI.fa[t]) m |= 32;
            if (rk[t] >= 1 && rk[t] <= IND_TOP) m |= 64;
            mask[t] = m;
        }
        X.set(s, { RS, RE, FI, rk, mask, rsE, atrUp, nh60, bk, indKnown: rk });
        F.mask = mask; F.finKnown = FI.known; F.indRank = rk;
    }
    // ── 窗口起點(⛔ 不寫死日期)──
    const winFrom = (pred) => { for (let g = WARM; g < days.length; g++) { let k = 0; for (const s of syms) { const i = AT.get(s)[g]; if (i >= WARM && pred(s, i)) { if (++k >= (opt.minWin ?? 100)) return g; } } } return -1; };
    const f6From = winFrom((s, i) => X.get(s).FI.known[i] === 1);
    const indFrom = winFrom((s, i) => X.get(s).rk[i] >= 1);
    const c7From = (f6From < 0 || indFrom < 0) ? -1 : Math.max(f6From, indFrom);
    const WFROM = { '': WARM, '@F6': f6From, '@IND': indFrom, '@C7': c7From };
    const half = {}; for (const w of Object.keys(WFROM)) half[w] = WFROM[w] >= 0 ? days[Math.floor((WFROM[w] + gEnd) / 2)] : '9999';
    const REG = regimes(TW);
    const ACC = new Map(), last = new Map();
    const SKIP = { limitUp: 0, cliff: 0 };
    const rnd = rng(20260921);
    const getA = key => { let a = ACC.get(key); if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()], k: mkKpi() }; ACC.set(key, a); } return a; };
    const bump = (key, y, h, rets, kpi) => {
        const a = getA(key);
        let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
        for (let i = 0; i < HOLDS.length; i++) { const v = rets[i]; if (v === null) continue; for (const t of [a.all[i], yy[i], a.byHalf[h][i]]) { t.n++; t.s += v; t.ss += v * v; if (v > 0) t.w++; } }
        if (kpi) {
            const K = a.k;
            if (rets[1] != null) { if (rets[1] > 0) K.sw10 += rets[1]; else K.sl10 -= rets[1]; }
            if (rets[2] != null) { if (rets[2] > 0) K.sw20 += rets[2]; else K.sl20 -= rets[2]; K.res.push(rets[2]); }
            if (kpi.mx20 != null) { K.n20++; BW_TH.forEach((th, j) => { if (kpi.mx20 >= th) K.bw20[j]++; }); if (kpi.mn20 <= -10 && kpi.mx20 < 10) K.fp++; }
            if (kpi.mx60 != null) { K.n60++; BW_TH.forEach((th, j) => { if (kpi.mx60 >= th) K.bw60[j]++; }); }
        }
    };
    let nDay = 0, g = 0;
    const emit = (key, x, wins) => {
        const F = x.F, t = x.i, e = t + 1;
        if (e >= F.n) return;
        const kk = key + '|' + x.s, p = last.get(kk);
        if (p != null && t - p < DEDUP) return;
        last.set(kk, t);
        if (!(F.op[e] > 0) || F.op[e] >= F.c[t] * LIMIT_UP) { SKIP.limitUp++; return; }
        const twE = twC[g + 1];
        const rets = HOLDS.map(H => { const j = e + H; if (j >= F.n || !(F.c[j] > 0)) return null; const tw = TW.c.get(F.dt[j]); if (!tw) return null; return (F.c[j] / F.op[e] - 1) * 100 - (tw / twE - 1) * 100; });
        if (rets.every(v => v === null)) return;
        let mx20 = null, mn20 = null, mx60 = null;
        if (e + 20 < F.n) { let h = -Infinity, l = Infinity; for (let j = e + 1; j <= e + 20; j++) { if (F.c[j] > h) h = F.c[j]; if (F.c[j] < l) l = F.c[j]; } mx20 = (h / F.op[e] - 1) * 100; mn20 = (l / F.op[e] - 1) * 100; }
        if (e + 60 < F.n) { let h = -Infinity; for (let j = e + 1; j <= e + 60; j++) if (F.c[j] > h) h = F.c[j]; mx60 = (h / F.op[e] - 1) * 100; }
        const kpi = { mx20, mn20, mx60 };
        const D = days[g], y = +D.slice(0, 4);
        for (const w of wins) {
            if (WFROM[w] < 0 || g < WFROM[w]) continue;
            const h = D < half[w] ? 0 : 1;
            bump(key + w, y, h, rets, kpi);
            if (!key.startsWith('PL') && !key.startsWith('SHAM')) { if (REG.r200[g]) bump(key + w + '@R200:' + REG.r200[g], y, h, rets, null); if (REG.r60[g]) bump(key + w + '@R60:' + REG.r60[g], y, h, rets, null); }
        }
    };
    const ALLW = ['', '@F6', '@IND', '@C7'];
    const shamDraw = (key, pool, k, w) => {
        if (!k || pool.length <= k) { if (k && pool.length) for (const x of pool) emit('SHAM:' + key, x, w); return; }
        const p = pool.slice();
        for (let i = 0; i < k; i++) { const j = i + Math.floor(rnd() * (p.length - i)); [p[i], p[j]] = [p[j], p[i]]; }
        for (let i = 0; i < k; i++) emit('SHAM:' + key, p[i], w);
    };
    for (g = WARM; g < gEnd; g++) {
        if (!(twC[g + 1] > 0)) continue;
        const todays = [];
        for (const s of syms) {
            const i = AT.get(s)[g]; if (i < WARM) continue;
            const F = universe.get(s);
            if (!(F.amt[i] >= BASE_MIN_AMT) || Number.isNaN(F.b20[i]) || Number.isNaN(F.pos[i]) || Number.isNaN(F.amp[i]) || Number.isNaN(F.vr[i])) continue;
            todays.push({ s, i, F, X: X.get(s) });
        }
        if (todays.length < (opt.minSyms ?? 100)) continue;
        nDay++;
        if (opt.onDay) opt.onDay(days[g], todays);
        const gene = [], geneF = {}, shamK = {}, geneC5 = {}, geneC7 = {}, geneBk = {}, genePL = {};
        const need = (o, k) => (o[k] ||= []);
        for (const x of todays) {
            const F = x.F, i = x.i, M = x.X, m = M.mask[i];
            const isGene = F.pos[i] >= GENE_POS && F.amp[i] >= GENE_AMP && F.amt[i] >= GENE_AMT;
            emit('BASE_ALL', x, ALLW);
            if (isGene) { gene.push(x); emit('GENE', x, ALLW); }
            const known7 = M.FI.known[i] === 1 && M.rk[i] >= 1;
            if (known7) { emit('BASE7', x, ['@C7']); if (isGene) emit('GENE7', x, ['@C7']); }
            // 單 flag
            FLAGS.forEach((k, b) => {
                if (!(m & (1 << b))) return;
                const w = [FLAG_WIN[k] || ''];
                emit('F:' + k, x, w);
                if (isGene) { emit('F:' + k + '∧🧬', x, w); need(geneF, k).push(x); }
            });
            // 變體
            const VAR = { rsaccEW: M.rsE[i], atrxUp: M.atrUp[i], bkq20: M.bk[20][i], bkq120: M.bk[120][i], bkq252: M.bk[252][i], 'finacc+gm': M.FI.fg[i], 'finacc+eps': M.FI.fe[i] };
            for (const [k, v] of Object.entries(VAR)) { if (!v) continue; const w = [k.startsWith('finacc') ? '@F6' : '']; emit('F:' + k, x, w); if (isGene) { emit('F:' + k + '∧🧬', x, w); need(geneF, k).push(x); } }
            if (F.pos[i] >= GENE_POS && F.pos20[i] >= GENE_POS) emit('POS:old', x, ['']);
            // 突破品質拆解(對照 = 素 nh60)
            if (M.nh60[i]) { emit('BK:nh60', x, ['']); if (F.clv[i] >= 0.7) emit('BK:nh60∧CLV≥0.7', x, ['']); if (F.volx[i] >= 1.5) emit('BK:nh60∧量比≥1.5', x, ['']); if (m & 16) emit('BK:bkq(兩者)', x, ['']);
                if (isGene) for (const cv of TH.clv) for (const vx of TH.volx) if (F.clv[i] >= cv && F.volx[i] >= vx) { const k = `bkq clv≥${cv}∧volx≥${vx}`; emit('PL:' + k, x, ['']); need(genePL, k).push(x); } }
            // 錨點
            if (Number.isFinite(F.ret20[i]) && !Number.isNaN(twr20[g]) && F.ret20[i] - twr20[g] >= 8) emit('REF:rs8(20日超額≥8)', x, ['']);
            // 共振計數
            let c5 = 0; for (let b = 0; b < 5; b++) if (m & (1 << b)) c5++;
            if (opt.trace) opt.trace.push([x.s, i, c5]);
            emit('CNT5=' + c5, x, ['']);
            if (isGene) for (const k of TH.cnt) if (c5 >= k) { emit(`CNT5≥${k}∧🧬`, x, ['']); need(geneC5, k).push(x); }
            if (known7) { let c7 = 0; for (let b = 0; b < 7; b++) if (m & (1 << b)) c7++; emit('CNT7=' + Math.min(c7, 5), x, ['@C7']); if (isGene) for (const k of TH.cnt) if (c7 >= k) { emit(`CNT7≥${k}∧🧬`, x, ['@C7']); need(geneC7, k).push(x); } }
            // 高原(∧🧬)
            if (isGene) {
                const R = M.RS;
                if (R.rs20[i] > R.rs60[i] && R.rs60[i] > R.rs120[i] && R.rs20[i] > 0) for (const th of TH.rsacc) if (R.drs20[i] >= th) { const k = `rsacc Δ≥${th}`; emit('PL:' + k, x, ['']); need(genePL, k).push(x); }
                for (const th of TH.turnacc) if (F.tx[i] >= th) { const k = `turnacc 量比≥${th}`; emit('PL:' + k, x, ['']); need(genePL, k).push(x); }
                if (F.atrR[i] >= 1 && F.atrR[i - 1] < 1) for (const sq of TH.atrSq) for (const lk of TH.atrLook) if (F['atrMin' + lk][i] < sq) { const k = `atrx 壓縮<${sq}×回看${lk}`; emit('PL:' + k, x, ['']); need(genePL, k).push(x); }
                if (F.pos[i] >= GENE_POS) for (const th of TH.posacc) if (F.pos20[i] < th) { const k = `posacc 20日前<${th}`; emit('PL:' + k, x, ['']); need(genePL, k).push(x); }
                if (M.FI.known[i] && M.FI.yoyV[i] > 0) for (const th of TH.finacc) if (M.FI.accV[i] >= th) { const k = `finacc 加速≥${th === -Infinity ? '任意(只要yoy>0)' : th}`; emit('PL:' + k, x, ['@F6']); need(genePL, k).push(x); }
                if (M.rk[i] >= 1) for (const th of TH.indrs) if (M.rk[i] <= th) { const k = `indrs 產業前${th}`; emit('PL:' + k, x, ['@IND']); need(genePL, k).push(x); }
            }
        }
        // sham:每個 ∧🧬 桶抽同檔數
        for (const [k, arr] of Object.entries(geneF)) shamDraw(k, gene, arr.length, [k.startsWith('finacc') ? '@F6' : (FLAG_WIN[k] || '')]);
        for (const [k, arr] of Object.entries(geneC5)) shamDraw(`cnt5≥${k}`, gene, arr.length, ['']);
        for (const [k, arr] of Object.entries(geneC7)) shamDraw(`cnt7≥${k}`, gene.filter(x => x.X.FI.known[x.i] === 1 && x.X.rk[x.i] >= 1), arr.length, ['@C7']);
        for (const [k, arr] of Object.entries(genePL)) shamDraw('PL:' + k, gene, arr.length, [k.startsWith('finacc') ? '@F6' : k.startsWith('indrs') ? '@IND' : '']);
    }
    return { ACC, SKIP, half, WFROM: Object.fromEntries(Object.entries(WFROM).map(([w, gi]) => [w, gi >= 0 ? days[gi] : null])), nDay, days: [days[WARM], days[gEnd]], REG, ew, X };
}

/** 🎯 Miss Rate(無前視):起點 s = 之後 60 日內最高收盤 ≥ +30% 且 c[s] 是那一波的谷底 —— 前後 5 日最低且到峰頂之間沒有更低(事後定義);只問 mask[s−5..s](起點以前的資料) */
function missRate(universe, R, opt = {}) {
    const RISE = opt.rise ?? 1.30, H = 60, LOOK = 6;
    const out = { starts: 0, byFlag: {}, any5: 0, any7: 0, gene: 0, n7: 0, fire: {}, win: {}, winAny5: 0, winAny7: 0, winGene: 0, tot: 0, totF6: 0, totInd: 0, tot7: 0 };
    FLAGS.forEach(k => { out.byFlag[k] = { hit: 0, n: 0 }; out.fire[k] = 0; out.win[k] = 0; });
    for (const [s, F] of universe) {
        const X = R.X.get(s); if (!X) continue;
        let lastS = -Infinity;
        for (let t = WARM; t < F.n; t++) {
            if (!(F.amt[t] >= BASE_MIN_AMT)) continue;
            out.tot++; const kn = X.FI.known[t] === 1, ik = X.rk[t] >= 1; if (kn) out.totF6++; if (ik) out.totInd++; if (kn && ik) out.tot7++;
            // ⭐ 實測基準:任一個 6 日窗口本來就會亮的比例(⛔ 不可用 1−(1−p)^6 —— 狀態型 flag 高度自相關,獨立假設會把基準灌到 90%)
            { let a5 = 0, a7 = 0, gn = 0, fb = 0; for (let j = t - LOOK + 1; j <= t; j++) { const m = X.mask[j]; fb |= m; if (F.pos[j] >= GENE_POS && F.amp[j] >= GENE_AMP) gn = 1; }
              if (fb & 0x1f) a5 = 1; if (fb & 0x7f) a7 = 1;
              FLAGS.forEach((k, b) => { if (X.mask[t] & (1 << b)) out.fire[k]++; if (fb & (1 << b)) out.win[k]++; });
              out.winAny5 += a5; if (kn && ik) out.winAny7 += a7; out.winGene += gn; }
            if (t + H >= F.n || t - lastS < H) continue;
            let mx = -Infinity, jp = -1; for (let j = t + 1; j <= t + H; j++) if (F.c[j] > mx) { mx = F.c[j]; jp = j; }
            if (mx < F.c[t] * RISE) continue;
            // 起點 = 那一波的谷底:前後 5 日最低,而且從它到峰頂之間沒有更低的收盤
            //   (⛔ 只看「近 5 日最低」會把下跌段裡每一個雜訊低點都當起點,起點被提早 20~30 天 —— selftest ⑨ 抓到的)
            let mn = Infinity; for (let j = t - 5; j <= jp; j++) if (F.c[j] < mn) mn = F.c[j];
            if (F.c[t] > mn) continue;
            lastS = t; out.starts++;
            let any5 = false, any7 = false, gn = false;
            for (let j = t - LOOK + 1; j <= t; j++) { if (X.mask[j] & 0x1f) any5 = true; if (X.mask[j] & 0x7f) any7 = true; if (F.pos[j] >= GENE_POS && F.amp[j] >= GENE_AMP) gn = true; }
            if (any5) out.any5++; if (any7) out.any7++; if (gn) out.gene++;
            if (kn && ik) out.n7++;
            FLAGS.forEach((k, b) => { if ((k === 'finacc' && !kn) || (k === 'indrs' && !ik)) return; const o = out.byFlag[k]; o.n++; for (let j = t - LOOK + 1; j <= t; j++) if (X.mask[j] & (1 << b)) { o.hit++; break; } });
        }
    }
    for (const k of FLAGS) { const o = out.byFlag[k]; const den = k === 'finacc' ? out.totF6 : k === 'indrs' ? out.totInd : out.tot; o.rate = o.n ? o.hit / o.n * 100 : null; o.fireRate = den ? out.fire[k] / den * 100 : null; o.randExpect = den ? randExpect(out.fire[k] / den, LOOK) * 100 : null; o.winRate = den ? out.win[k] / den * 100 : null; o.lift = (o.rate != null && o.winRate != null) ? o.rate - o.winRate : null; o.pz = (o.n && den) ? propZ(o.hit, o.n, out.win[k], den).p : null; }
    out.any5Rate = out.starts ? out.any5 / out.starts * 100 : null; out.any7Rate = out.n7 ? out.any7 / out.n7 * 100 : null; out.geneRate = out.starts ? out.gene / out.starts * 100 : null;
    out.winAny5Rate = out.tot ? out.winAny5 / out.tot * 100 : null; out.winAny7Rate = out.tot7 ? out.winAny7 / out.tot7 * 100 : null; out.winGeneRate = out.tot ? out.winGene / out.tot * 100 : null;
    return out;
}

// ═══════════ 載入 ═══════════
function loadTwii(dir) {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8')).map(r => ({ d: nd(r.date), c: +r.close, h: +(r.high || r.close), l: +(r.low || r.close) })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
    return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])), h: rows.map(r => r.h), l: rows.map(r => r.l) };
}
const isStockFile = f => /^\d{4}[A-Z]?\.json$/.test(f) && !f.startsWith('00');
function readRows(dir, fn) {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch (_) { return null; }
    if (!Array.isArray(rows) || rows.length < WARM + 30) return null;
    rows = rows.filter(r => r && +r.close > 0 && +r.open > 0).sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
    return rows.length >= WARM + 30 ? rows : null;
}
function loadUniverse(dir, SKIP) {
    const U = new Map();
    for (const fn of fs.readdirSync(dir).filter(isStockFile)) {
        const rows = readRows(dir, fn); if (!rows) continue;
        let cliff = false;
        for (let i = 1; i < rows.length; i++) { const r = +rows[i].close / +rows[i - 1].close; if (r > 1.4 || r < 0.6) { cliff = true; break; } }
        if (cliff) { SKIP.cliff++; continue; }
        U.set(fn.replace('.json', ''), features(rows));
    }
    return U;
}

// ═══════════ selftest ═══════════
function mkDays(NBAR, y0 = 2021) {
    const days = []; let d = new Date(Date.UTC(y0, 0, 4));
    for (let i = 0; i < NBAR; i++) { while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5); days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    return days;
}
/** 合成母體:全部緩漲(pos 高)、振幅 4%(🧬 過門檻)、量按 idx 幾何遞減;hook:px/vol/volAt/drift/inst/rowAt(s,i,row,rows) */
function synth(NSYM, NBAR, days, o = {}) {
    const U = new Map();
    for (let s = 0; s < NSYM; s++) {
        const r = rng(1000 + s * 7919), rows = [];
        let px = o.px ? o.px(s) : 400;
        const vol = o.vol ? o.vol(s) : 5e6 * Math.pow(0.97, s);
        for (let i = 0; i < NBAR; i++) {
            const drift = o.drift ? o.drift(s, i) : 0.0006;
            const op = px * (1 + (r() - 0.5) * 0.004);
            const cl = px * (1 + drift + (r() - 0.5) * 0.006);
            const row = { date: days[i], open: op, close: cl, high: Math.max(op, cl) * 1.02, low: Math.min(op, cl) * 0.98, volume: o.volAt ? o.volAt(s, i, vol) : vol };
            if (o.inst) { const v = o.inst(s, i); if (v != null) { row.foreign_net = v.f; row.trust_net = v.t; } }
            if (o.rowAt) o.rowAt(s, i, row, rows);
            rows.push(row); px = row.close;
        }
        U.set(String(1000 + s), features(rows));
    }
    return U;
}
function selftest() {
    console.log('🧪 selftest —— ⓪ 對表 + 十一組合成注入(⛔ 每一條注入都要真的注進去,印命中數)\n');
    let bad = 0;
    const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    const N = (R, k) => { const a = R.ACC.get(k); return a ? a.all[1].n : 0; };
    const D = (R, k, b) => { const a = R.ACC.get(k), B = R.ACC.get(b); return a && B ? margin(a.all[1], B.all[1]).d : null; };

    // ⓪a 對表 screener.json(前七欄,同 kingpool)
    {
        const scrP = process.env.SCR || path.join(DATA, 'screener.json');
        let scr = null; try { scr = JSON.parse(fs.readFileSync(scrP, 'utf8')); } catch (_) {}
        const kdir = process.env.SCR_DATA || DATA;
        if (!scr || !scr.rows || !scr.cols) ck(false, `⓪a 讀不到 screener.json(${scrP})→ ⛔ 對表沒做,不算過`);
        else {
            const CI = Object.fromEntries(scr.cols.map((k, i) => [k, i]));
            const keys = Object.keys(scr.rows).filter(s => /^\d{4}$/.test(s) && !s.startsWith('00'));
            const r0 = rng(7); const sample = []; while (sample.length < Math.min(300, keys.length)) { const k = keys[Math.floor(r0() * keys.length)]; if (!sample.includes(k)) sample.push(k); }
            let cmp = 0, dateMis = 0; const badF = {};
            const FIELDS = [['amt', 'amt', 0.05], ['vr', 'vr', 0.15], ['pos252', 'pos', 0.15], ['amp20', 'amp', 0.05], ['b5', 'b5', 0.05], ['b20', 'b20', 0.05], ['chg', 'chg', 0.05]];
            for (const s of sample) {
                const rows = readRows(kdir, s + '.json'); if (!rows) continue;
                const F = features(rows); const t = F.n - 1;
                if (F.dt[t] !== nd(scr.data_date)) { dateMis++; continue; }
                cmp++; const v = scr.rows[s];
                for (const [col, fld, tol] of FIELDS) { const a = v[CI[col]], b = F[fld][t]; if (a == null && Number.isNaN(b)) continue; if (a == null || Number.isNaN(b) || Math.abs(a - b) > tol + Math.abs(a) * 0.005) badF[col] = (badF[col] || 0) + 1; }
            }
            const nb = Object.values(badF).reduce((a, b) => a + b, 0);
            ck(cmp >= 100 && nb === 0, `⓪a 對表 screener.json(${scr.data_date}):比了 ${cmp} 檔・不合 ${nb} 格 ${JSON.stringify(badF)}${cmp < 100 ? ' 🚧 樣本不足(K 線目錄最後一根要等於 data_date,用 SCR_DATA= 指定)' : ''}${dateMis ? `(${dateMis} 檔最後一根不是那天)` : ''}`);
        }
    }
    // ⓪b 真實 data/fin/*.json 的 pub 逐季 vs pubDate(p)
    {
        const dir = process.env.FIN_SLICE || path.join(ROOT, 'data', 'fin');
        let n = 0, badP = 0, files = [];
        try { files = fs.readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).slice(0, 400); } catch (_) {}
        for (const f of files) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const q of j.q || []) { n++; if (q.pub !== pubDate(q.p)) badP++; } } catch (_) {} }
        ck(n >= 1000 && badP === 0, `⓪b data/fin 切片的 pub 全部等於 lib_fundamentals.pubDate(p):比了 ${n} 季・不合 ${badP}${n < 1000 ? ' 🚧 讀不到切片(FIN_SLICE=)' : ''}`);
    }

    const NSYM = 150, NBAR = 1400, days = mkDays(NBAR);
    const TWflat = { days, c: new Map(days.map(x => [x, 10000])) };
    const SIG = []; for (let i = 320; i < NBAR - 80; i += 160) SIG.push(i);
    const near = (i, t, a, b) => i >= t + a && i <= t + b;
    const inj = (name, o, key, minN) => {
        const U = synth(NSYM, NBAR, days, o.mk);
        const R = run(U, TWflat, { minSyms: 50, minWin: 50, fin: o.fin, ind: o.ind });
        const F0 = U.get('1000'); let fires = 0; const b = FLAGS.indexOf(key.replace(/EW$/, '')); for (let t = WARM; t < F0.n; t++) if (F0.mask[t] & (1 << b)) fires++;
        const n = N(R, `F:${key}${FLAG_WIN[key] || ''}`), d = D(R, `F:${key}${FLAG_WIN[key] || ''}`, `BASE_ALL${FLAG_WIN[key] || ''}`);
        ck(fires > 0 && n >= minN && d != null && d >= 3, `①${name} F:${key} 第 0 檔亮 ${fires} 根・事件 n=${n}(≥${minN})・vs BASE 10 日 ${f2(d)}pp(要 ≥+3)`);
        return { U, R };
    };
    const drift0 = 0.0006;
    // ①a rsacc:第 0 檔 V 型(t−140..t−60 −0.1%、t−60..t−20 −0.05%、t−20..t+12 +0.6%)
    //   ⚠️ 規格的 RS20>RS60>RS120 是**累積**窗口互相包含 → 數學上等於「近 20 日強、之前 40 日與再之前 60 日都弱」(V 型),⛔ 不是「越來越快」
    inj('a', { mk: { drift: (s, i) => { if (s) return drift0; for (const t of SIG) { if (near(i, t, -140, -61)) return -0.001; if (near(i, t, -60, -21)) return -0.0005; if (near(i, t, -20, 12)) return 0.006; } return drift0; } } }, 'rsacc', 3);
    // ①b turnacc:t−4..t 量 ×3,t−3..t+12 漲 0.6%/日
    inj('b', { mk: { volAt: (s, i, v) => (!s && SIG.some(t => near(i, t, -4, 0))) ? v * 3 : v, drift: (s, i) => (!s && SIG.some(t => near(i, t, -3, 12))) ? 0.006 : drift0 } }, 'turnacc', 3);
    // ①c atrx:振幅 3% → 0.5% → 5%(用 rowAt 覆寫 high/low),擴張那幾天起漲
    inj('c', { mk: { rowAt: (s, i, row) => { if (s) return; for (const t of SIG) { let a = null; if (near(i, t, -100, -51)) a = 0.015; else if (near(i, t, -50, -6)) a = 0.0025; else if (near(i, t, -5, 0)) a = 0.025; if (a != null) { row.high = row.close * (1 + a); row.low = row.close * (1 - a); } } },
        drift: (s, i) => (!s && SIG.some(t => near(i, t, -6, 12))) ? 0.006 : drift0 } }, 'atrx', 3);
    // ①d posacc:t−60..t−21 跌到 −25%,t−20..t+12 漲回並創高(pos 從 0 → 100)
    inj('d', { mk: { drift: (s, i) => { if (s) return drift0; for (const t of SIG) { if (near(i, t, -60, -41)) return -0.014; if (near(i, t, -40, -21)) return 0; if (near(i, t, -20, 12)) return 0.02; } return drift0; } } }, 'posacc', 3);
    // ①e bkq:t 收在前 60 日高 ×1.03、CLV 0.857、量 ×2;t+2 起 ×1.05
    // ⚠️ synth 的價格是鏈式的(px = 上一根 close)→ 「跳 +5%」只能乘**一次**(那一根),之後自然延續;每根都乘會複利成 +71%
    const lift = (row, f) => { row.open *= f; row.close *= f; row.high *= f; row.low *= f; };
    const bkRow = (i, row, rows) => { let h = -Infinity; for (let k = i - 60; k < i; k++) if (rows[k].close > h) h = rows[k].close; row.close = h * 1.03; row.open = row.close * 0.995; row.high = row.close * 1.005; row.low = row.close * 0.97; row.volume *= 2; };
    const bkqMk = (liftAt = 2) => ({ rowAt: (s, i, row, rows) => { if (s) return; if (SIG.includes(i)) bkRow(i, row, rows); else if (SIG.some(t => i === t + liftAt)) lift(row, 1.05); } });
    inj('e', { mk: bkqMk() }, 'bkq', 3);
    // ①f finacc:全部股票都有財報(固定 5% 成長 → yoy>0 但 acc=0,不亮);第 0 檔每 8 季一次「yoy>0 且加速」,已知那一季期間漲 0.6%/日
    const finMk = (o = {}) => { const ser = []; const Q = ['03-31', '06-30', '09-30', '12-31'];
        for (let y = 2020; y <= 2025; y++) for (let q = 0; q < 4; q++) ser.push(`${y}-${Q[q]}`);
        const s = {};
        for (let sy = 0; sy < NSYM; sy++) { const S = {}; ser.forEach((p, k) => { const boost = o.acc ? o.acc(sy, k) : (sy === 0 && (k % 8) === 6 ? 1.5 : 1); const rev = 1e9 * boost; /* 基底固定(yoy=0 → 不亮);⛔ 用 1.05^k 會因浮點誤差讓 acc 忽正忽負 */ S[p] = [null, rev * 0.6, null, null, null, rev, null, null, 1, null]; }); s[String(1000 + sy)] = S; }
        return { q: ser, f: ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps', 'ni'], s }; };
    const finMap = FD => new Map([...Object.keys(FD.s)].map(k => [k, finSeries(FD, k)]));
    {
        const fin = finMap(finMk()); const s0 = fin.get('1000');
        const on = s0.filter(q => q.ok && q.yoy > 0 && q.acc > 0).map(q => q.pub);
        const nextPub = p => { const i = s0.findIndex(q => q.pub === p); return s0[i + 1] ? s0[i + 1].pub : '9999'; };
        const R0 = inj('f', { fin, mk: { drift: (s, i) => (!s && on.some(p => days[i] >= p && days[i] < nextPub(p))) ? 0.006 : drift0 } }, 'finacc', 3);
        const others = [...R0.U.entries()].filter(([k]) => k !== '1000').reduce((a, [, F]) => a + F.mask.reduce((x, y) => x + (y & 32 ? 1 : 0), 0), 0);
        ck(others === 0, `①f 其餘股票固定成長(acc=0)⛔ 不可亮 finacc:亮了 ${others} 根(要 0)`);
    }
    // ①g indrs:第 0~5 檔同產業 A,其餘 24 個產業各 6 檔;A 在 t−20..t+12 每日 +0.6% → 那段 A 要排第 1、第 0 檔只在那段亮
    //   (⛔ 不量 F:indrs 的邊際:每天永遠有 5 個產業在前 5,那一桶的邊際天生被稀釋 —— 這一條驗的是「排名對、只在該亮的時候亮」)
    const indMk = () => new Map([...Array(NSYM)].map((_, s) => [String(1000 + s), s < 6 ? 'A' : 'I' + (s % 24)]));
    {
        const U = synth(NSYM, NBAR, days, { drift: (s, i) => (s < 6 && SIG.some(t => near(i, t, -20, 12))) ? 0.006 : drift0 });
        const R = run(U, TWflat, { minSyms: 50, minWin: 50, ind: indMk() });
        const F0 = U.get('1000'), X0 = R.X.get('1000');
        let fires = 0; for (let t = WARM; t < F0.n; t++) if (F0.mask[t] & 64) fires++;
        const rankAtSig = SIG.map(t => X0.rk[t]);
        let winDays = 0, winTop = 0; for (const t of SIG) for (let j = t - 10; j <= t + 10; j++) { winDays++; if (X0.rk[j] === 1) winTop++; }
        ck(fires >= SIG.length && winDays === winTop && rankAtSig.every(r => r === 1), `①g indrs:第 0 檔亮 ${fires} 根・窗口 ±10 日 A 排第 1 的比例 ${winTop}/${winDays}(要全部)・訊號日排名 ${rankAtSig.join('/')}(要全 1)`);
    }

    // ② 前視:bkq 事件只在 t+1 開盤起跳 +5%(t 不動)→ 增量 ≈0;TW 在 t+1 跳 → RS20[t] 不變
    {
        const U = synth(NSYM, NBAR, days, bkqMk(1));
        const R = run(U, TWflat, { minSyms: 50, minWin: 50 });
        const d = D(R, 'F:bkq', 'BASE_ALL');
        ck(N(R, 'F:bkq') >= 3 && d != null && Math.abs(d) < 0.8, `② 只在 t+1 開盤起跳 +5%:F:bkq n=${N(R, 'F:bkq')} 增量 ${f2(d)}pp 必須 ≈0(進場 = t+1 開盤)`);
        const t = SIG[0], F0 = U.get('1000'), tw = new Float64Array(F0.n).fill(10000); const a = rsSeries(F0, tw).rs20[t]; tw[t + 1] = 12000; const b = rsSeries(F0, tw).rs20[t];
        ck(a === b, `② 加權在 t+1 跳 +20% → RS20[t] 不變(${a.toFixed(3)} vs ${b.toFixed(3)})`);
    }
    // ③ 去重:連續 3 天都是「創高 + 品質」→ n=1
    {
        const T = [400, 401, 402];
        const U = synth(NSYM, NBAR, days, { rowAt: (s, i, row, rows) => { if (!s && T.includes(i)) bkRow(i, row, rows); } });
        const R = run(U, TWflat, { minSyms: 50, minWin: 50 });
        const F0 = U.get('1000'); const fires = T.filter(t => F0.mask[t] & 16).length;
        ck(fires === 3 && N(R, 'F:bkq') === 1, `③ 連續 3 天亮 bkq(亮 ${fires} 根)→ 事件 n=${N(R, 'F:bkq')}(要 1)`);
    }
    // ④ 鎖漲停:t+1 開盤 = c×1.10 → 不進桶
    {
        const U = synth(NSYM, NBAR, days, { rowAt: (s, i, row, rows) => { if (!s && i === 400) bkRow(i, row, rows); } });
        const F0 = U.get('1000'); F0.op[401] = F0.c[400] * 1.10;
        const R = run(U, TWflat, { minSyms: 50, minWin: 50 });
        ck((F0.mask[400] & 16) && N(R, 'F:bkq') === 0 && R.SKIP.limitUp >= 1, `④ 隔天開盤漲停 → F:bkq n=${N(R, 'F:bkq')}(要 0)・擋 ${R.SKIP.limitUp}`);
    }
    // ⑤ 陷阱 #43:前高⛔ 不含今日、量比分母⛔ 不含今日
    {
        const t = 400;
        const U = synth(NSYM, NBAR, days, { rowAt: (s, i, row, rows) => { if (s || i !== t) return; let h = -Infinity; for (let k = i - 60; k < i; k++) if (rows[k].close > h) h = rows[k].close; row.close = h * 1.03; row.open = row.close * 0.995; row.high = row.close * 1.005; row.low = row.close * 0.97; let v = 0; for (let k = i - 20; k < i; k++) v += rows[k].volume; row.volume = v / 20 * 1.5; } });
        run(U, TWflat, { minSyms: 50, minWin: 50 });   // mask 是 run() 才算的
        const F0 = U.get('1000');
        const dist = (F0.c[t] / F0.ph60[t] - 1) * 100;
        ck(Math.abs(dist - 3) < 1e-6 && Math.abs(F0.volx[t] - 1.5) < 1e-9 && (F0.mask[t] & 16) !== 0, `⑤ prevHi60 不含今日(今日距前高 ${dist.toFixed(4)}%,要 3.0000)・volx=${F0.volx[t].toFixed(6)}(要 1.5;分母含今日會是 1.4634)・bkq 亮`);
    }
    // ⑥ 基本面:p=2025-03-31 → pub 5/15;pub 之前⛔ 不可亮,第一個亮日 = 第一個 ≥ pub 的交易日
    {
        const FD = finMk({ acc: (s, k) => (s === 0 && k === 20 ? 1.5 : 1) });   // k=20 → 2025-03-31
        const ser = finSeries(FD, '1000'); const q = ser.find(x => x.p === '2025-03-31');
        const U = synth(NSYM, NBAR, days, {}); const F0 = U.get('1000'); const FI = finFlags(F0, ser);
        const first = F0.dt.findIndex((d, i) => FI.fa[i] === 1);
        const before = F0.dt.filter((d, i) => d >= '2025-03-31' && d < '2025-05-15' && FI.fa[i]).length;
        const firstOk = first >= 0 && F0.dt[first] >= '2025-05-15' && F0.dt[first - 1] < '2025-05-15';
        ck(q && q.ok && q.yoy > 0 && q.acc > 0 && before === 0 && firstOk, `⑥ 季報 p=2025-03-31(pub ${q && q.pub}):季末到 5/15 之間亮 ${before} 根(要 0)・第一個亮日 ${first >= 0 ? F0.dt[first] : '—'}(要第一個 ≥ 2025-05-15 的交易日)`);
    }
    // ⑦ sham ≈ 0:無注入時每個 F:∧🧬 − GENE、SHAM − GENE 都在 ±0.3 內(n<30 的略過)
    {
        const U = synth(NSYM, NBAR, days, {});
        const R = run(U, TWflat, { minSyms: 50, minWin: 50, ind: indMk() });
        const bads = [];
        for (const [k, a] of R.ACC) { if (!/^(F:.*∧🧬|SHAM:)/.test(k) || /@R/.test(k) || a.all[1].n < 30) continue; const w = k.includes('@') ? '@' + k.split('@')[1] : ''; const d = D(R, k, 'GENE' + w); if (d == null || Math.abs(d) > 0.3) bads.push(`${k} ${f2(d)}`); }
        ck(bads.length === 0 && N(R, 'GENE') >= 200, `⑦ 沒注入時 ∧🧬 / SHAM 相對 🧬 都 ≈0(🧬 n=${N(R, 'GENE')};超出:${bads.join(' ・') || '無'})`);
    }
    // ⑧ 共振計數 = popcount;Σ n(CNT5=k) = n(BASE_ALL)
    {
        const U = synth(NSYM, NBAR, days, { drift: (s, i) => ((s * 31 + i) % 97 < 8 ? 0.01 : drift0), volAt: (s, i, v) => ((s * 17 + i) % 41 < 5 ? v * 2.2 : v) });
        const trace = [];
        const R = run(U, TWflat, { minSyms: 50, minWin: 50, trace });
        let sum = 0; for (let k = 0; k <= 5; k++) sum += N(R, 'CNT5=' + k);
        // 主迴圈用的計數 vs 從 mask 獨立重算的 popcount(⛔ 兩邊要逐筆相等)
        let badPop = 0; for (const [s, i, c5] of trace) { const m = U.get(s).mask[i]; let c = 0; for (let b = 0; b < 5; b++) if (m & (1 << b)) c++; if (c !== c5) badPop++; }
        const fired = trace.filter(x => x[2] > 0).length;
        ck(trace.length > 1000 && badPop === 0 && sum >= N(R, 'BASE_ALL') && fired > 100, `⑧ 共振計數 = mask popcount:比了 ${trace.length} 筆・不合 ${badPop}(要 0)・Σ n(CNT5=k)=${sum} ≥ BASE_ALL ${N(R, 'BASE_ALL')}(各桶各自去重,所以 ≥)・亮燈 ${fired} 筆(🚧 空過守門)`);
    }
    // ⑨ Miss Rate:5 段 +40%/60 日起漲(起點是 5 日低);起點前 mask 全灌 1 → 100%;全清 0 → 0%
    {
        const ST = [400, 560, 720, 880, 1040];
        const U = synth(NSYM, NBAR, days, { drift: (s, i) => { if (s) return drift0; for (const t of ST) { if (near(i, t, -5, 0)) return -0.01; if (near(i, t, 1, 40)) return 0.009; } return drift0; } });   // 谷底要夠深(−6%),否則雜訊會讓谷底落在 20 天前
        const R = run(U, TWflat, { minSyms: 50, minWin: 50 });
        const F0 = U.get('1000');
        for (let t = WARM; t < F0.n; t++) F0.mask[t] = 0; for (const t of ST) for (let j = t - 12; j <= t; j++) F0.mask[j] = 0x7f;   // 起點可能落在下跌段的任何一根「創 5 日低」→ 整段前面都亮
        const M1 = missRate(U, R);
        for (let t = WARM; t < F0.n; t++) F0.mask[t] = 0;
        const M0 = missRate(U, R);
        ck(M1.starts === 5 && M1.any5Rate === 100 && M1.byFlag.bkq.rate === 100 && M0.starts === 5 && M0.any5Rate === 0, `⑨ Miss Rate:起點 ${M1.starts}(要 5)・前 5 日全亮 → any5 ${M1.any5Rate}%(要 100)・全清 → ${M0.any5Rate}%(要 0)`);
    }
    // ⑩ BW / FP:事件 A 20 日內最高 +35% 後回落;事件 B −12% 且未曾 +10%
    {
        const A = 400, B = 800;
        const U = synth(NSYM, NBAR, days, { rowAt: (s, i, row, rows) => { if (s) return; if (i === A || i === B) bkRow(i, row, rows);
            if (i === A + 5) lift(row, 1.35); if (i === A + 11) lift(row, 1 / 1.35); if (i === B + 2) lift(row, 0.88); } });
        const R = run(U, TWflat, { minSyms: 50, minWin: 50 });
        const K = R.ACC.get('F:bkq') && R.ACC.get('F:bkq').k;
        ck(!!K && K.n20 === 2 && K.bw20[1] === 1 && K.bw20[2] === 0 && K.fp === 1, `⑩ BW/FP:n20=${K && K.n20}(要 2)・bw20≥30 ${K && K.bw20[1]}(要 1)・bw20≥50 ${K && K.bw20[2]}(要 0)・FP ${K && K.fp}(要 1)`);
    }
    // ⑪ regime:加權前半在 MA200 上、後半在 MA200 下 → 事件落對桶且兩桶 n 相加 = 全桶
    {
        const c = new Map(days.map((d, i) => [d, i < 700 ? 10000 + i * 5 : 13500 - (i - 700) * 8]));
        const TW = { days, c };
        const U = synth(NSYM, NBAR, days, bkqMk());
        const R = run(U, TW, { minSyms: 50, minWin: 50 });
        const up = N(R, 'F:bkq@R200:up'), dn = N(R, 'F:bkq@R200:dn'), all = N(R, 'F:bkq');
        const firstDn = SIG.filter(t => t >= 900).length, firstUp = SIG.filter(t => t < 700).length;
        ck(all > 0 && up + dn === all && up >= firstUp && dn >= firstDn, `⑪ regime:F:bkq 全 ${all} = 多頭 ${up} + 空頭 ${dn};前半事件 ${firstUp} 全在多頭、後半 ${firstDn} 全在空頭`);
    }
    console.log('\n' + (bad ? `❌ SELFTEST_FAIL:${bad} 條` : '✅ SELFTEST_PASS'));
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) selftest();

// ═══════════ 實跑 ═══════════
const TW = loadTwii(DATA);
console.log(`📅 大盤日曆 ${TW.days[0]} ~ ${TW.days[TW.days.length - 1]}(${TW.days.length} 個交易日)`);
if (TW.days[0] > '2022-06-01') console.log('🚨 窗口沒有涵蓋 2022 空頭 → 逐年那關意義打折(要用合併過深歷史的 DATA_DIR)');
const SKIPL = { cliff: 0 };
const U = loadUniverse(DATA, SKIPL);
console.log(`📂 母體 ${U.size} 檔個股(⛔ 不含 00 開頭 ETF;斷崖守門擋掉 ${SKIPL.cliff} 檔)`);
let FIN_MAP = null, nFin = 0;
try { const FD = JSON.parse(fs.readFileSync(FIN, 'utf8')); FIN_MAP = new Map(); for (const s of U.keys()) { const ser = finSeries(FD, s); if (ser && ser.some(q => q.ok)) { FIN_MAP.set(s, ser); nFin++; } } console.log(`📦 fin_deep ${FD.q[0]} ~ ${FD.q[FD.q.length - 1]}(${FD.q.length} 季)→ ${nFin} 檔算得出營收 YoY 加速(可用日 = 法定截止日,保守)`); }
catch (e) { console.log(`⚠️ 讀不到 FIN_DEEP(${FIN}):${e.message} → finacc 那一層整個不跑(先 git show origin/fin_deep:fin_deep/fin_deep.json > …)`); }
let IND_MAP = null;
try { const m = JSON.parse(fs.readFileSync(path.join(AUX, 'industry_map.json'), 'utf8')); IND_MAP = new Map(Object.entries(m).filter(([s]) => U.has(s))); console.log(`🏭 industry_map ${IND_MAP.size} 檔有官方產業碼(${new Set(IND_MAP.values()).size} 個產業)`); }
catch (e) { console.log(`⚠️ 讀不到 industry_map.json(${AUX}):${e.message} → indrs 那一層整個不跑`); }
const R = run(U, TW, { fin: FIN_MAP, ind: IND_MAP });
console.log(`📊 掃 ${R.nDay} 個交易日 ・全窗口 ${R.days[0]} ~ ${R.days[1]}(切點 ${R.half['']})・@F6 ${R.WFROM['@F6'] || '—'} 起 ・@IND ${R.WFROM['@IND'] || '—'} 起 ・@C7 ${R.WFROM['@C7'] || '—'} 起`);
console.log(`🛒 第七關「買得到嗎」:t+1 開盤漲停擋掉 ${R.SKIP.limitUp.toLocaleString()} 個事件;成交額門檻 全市場≥${BASE_MIN_AMT} 億 / 🧬≥${GENE_AMT} 億\n`);
const MR = missRate(U, R);

const report = { version: 'V77.4.2', window: { full: R.days, f6: [R.WFROM['@F6'], R.days[1]], ind: [R.WFROM['@IND'], R.days[1]], c7: [R.WFROM['@C7'], R.days[1]] }, nSym: U.size, nSymFin: nFin, nSymInd: IND_MAP ? IND_MAP.size : 0, nDay: R.nDay, cost: COST, holds: HOLDS,
    flags: { rsacc: 'RS20>RS60>RS120 ∧ RS20>0 ∧ ΔRS20>0(對加權)', turnacc: 'mean(vo[t−4..t])/mean(vo[t−24..t−5]) ∈ [1.2,3.0]', atrx: 'ATR20/ATR60 ≥1 且昨天 <1 且近 20 日最低 <0.7', posacc: 'pos252≥75 ∧ 20 日前 <50', bkq: '收盤≥前 60 日高(不含今日)∧ CLV≥0.7 ∧ 量比≥1.5(分母不含今日)', finacc: '營收 YoY>0 ∧ YoY 比上一季加速(可用日 = 法定截止日)', indrs: '所屬產業 20 日超額排名前 5(成員中位數)' },
    buckets: {}, plateau: {}, count: {}, miss: MR, spec_errors: [
        '「既有六道門檻」是回測關卡不是選股濾網;選股必要條件只有 🧬',
        '「成交額前 100」是魚缸顯示上限;實測有東西的是前 50(kingpool_probe)',
        '10 年 walk-forward 做不到:K 線 2021 起、法人 2023-06 起、財報 2018 起 → 等價物 = 前後半 + 逐年 + 前半學後半驗',
        '財報「公告日」本站只有法定截止日 → 只能做「可用日之後」,做不了「公告後 N 天內」的新鮮度',
        'Catalyst(重大訊息 / 法說會)沒有可回測的歷史(news_hist 19 天、confcall ±60 天、MOPS 零資料集)',
        'Lifecycle 六態是狀態機 —— 本站狀態機類實測全負(regime_probe / chain_probe)→ 這支只做 flag 計數',
        '「TR5/TR20 擴張比」分母(總股數)抵銷 = 純量能比',
        'Big Winner「事後最高點」型 KPI:dtflip 已證碰得到 ≠ 賺得到 → 旁邊一定印務實出法(t+1 開盤進、固定天數出、扣成本)',
    ], limits: [
        '2022 只有第四季(合併 klines_deep 的加權 2021-09 起 + 暖身 253 根)',
        'finacc 可用日 = 法定截止日(保守,多數公司提早公布 → 真實可用日更早);fin_deep 缺季的檔那一季不亮',
        'indrs 只有 industry_map 有碼的檔(含上市與部分上櫃;沒碼的不進 @IND 窗口);半導體全擠代碼 24',
        'turnacc 沒有用集保總股數(分母抵銷);週轉率「水準」V77.3.3 已判沒贏過 sham',
        'RS 用個股自己的 bar 對齊加權;等權版基準 = 全市場個股當日漲跌中位數累積(母體 = 有 K 線的個股)',
        '不含股利;倖存者偏誤(只有目前還在 data/ 的股票);t+1 開盤漲停剔除',
    ] };

const table = (title, baseKey, keys, w = '', note = '') => {
    const base = R.ACC.get(baseKey + w);
    console.log('═'.repeat(110)); console.log(title + (note ? `\n  ${note}` : ''));
    if (!base || base.all[1].n < MIN_EV) { console.log(`  🚧 空過守門:對照組 ${baseKey}${w} 只有 ${base ? base.all[1].n : 0} 筆 → ⛔ 不給結論\n`); return; }
    const bm = HOLDS.map((_, i) => stat(base.all[i])), BK = base.k;
    const bwB = BK.n60 ? BK.bw60[1] / BK.n60 * 100 : null, fpB = BK.n20 ? BK.fp / BK.n20 * 100 : null;
    console.log(`  對照組 ${baseKey}${w} n=${base.all[1].n.toLocaleString()} ・超額 ${HOLDS.map((H, i) => `${H}日 ${f2(bm[i].m, 6)}`).join(' ・')} ・10 日勝率 ${bm[1].w.toFixed(1)}% ・60日內曾 +30% ${bwB == null ? '—' : bwB.toFixed(1) + '%'} ・假訊號 ${fpB == null ? '—' : fpB.toFixed(1) + '%'}`);
    console.log(`  ${'桶'.padEnd(30)} ${'n'.padStart(7)} ${'5日'.padStart(8)} ${'10日'.padStart(8)} ${'20日'.padStart(8)}  扣成本  勝率%  絕對10  關卡`);
    for (const k of keys) {
        const a = R.ACC.get(k + w);
        if (!a || a.all[1].n < 30) { console.log(`  ${k.padEnd(30)} ${String(a ? a.all[1].n : 0).padStart(7)}   —— 樣本太少`); report.buckets[k + w] = { n: a ? a.all[1].n : 0, thin: true }; continue; }
        const ds = HOLDS.map((_, i) => margin(a.all[i], base.all[i]).d);
        const G = gates(a, base, 1), S = stat(a.all[1]), K = a.k;
        const flag = G.nPass === 6 ? '✅ 六關全過' : `${G.nPass}/6${G.yrShort ? '(逐年不足 3 年)' : ''}`;
        console.log(`  ${k.padEnd(30)} ${String(G.M.n).padStart(7)} ${f2(ds[0], 8)} ${f2(ds[1], 8)} ${f2(ds[2], 8)} ${f2(ds[1] - COST, 7)} ${S.w.toFixed(1).padStart(6)} ${f2(S.m, 7)}  ${flag} p=${G.M.p.toFixed(4)}${G.M.n < 200 ? ' ⚠️樣本薄' : ''}`);
        console.log(`      逐年:${G.YR.map(x => `${x.y} ${f2(x.d, 6)}(n=${x.n})`).join(' ・')} ・前半 ${f2(G.H[0], 6)} / 後半 ${f2(G.H[1], 6)} ・去最好年 ${f2(G.dropBest, 6)}`);
        const bw60 = K.n60 ? BW_TH.map((th, j) => `≥${th}% ${(K.bw60[j] / K.n60 * 100).toFixed(1)}%`).join(' / ') : '—';
        const bwZ = (K.n60 && BK.n60) ? propZ(K.bw60[1], K.n60, BK.bw60[1], BK.n60) : null;
        const fp = K.n20 ? (K.fp / K.n20 * 100).toFixed(1) + '%' : '—';
        const pc = K.res.pct(); const pf10 = profitFactor(K.sw10, K.sl10), pf20 = profitFactor(K.sw20, K.sl20);
        // sham 對照(只有 ∧🧬 桶有)
        let sh = null; const shKey = k.startsWith('F:') && k.endsWith('∧🧬') ? 'SHAM:' + k.slice(2, -3) : k.startsWith('CNT5≥') ? 'SHAM:cnt5≥' + k.slice(5, -3) : k.startsWith('CNT7≥') ? 'SHAM:cnt7≥' + k.slice(5, -3) : null;
        if (shKey && R.ACC.get(shKey + w)) { const s = R.ACC.get(shKey + w); const m = margin(a.all[1], s.all[1]); const sK = s.k; sh = { n: s.all[1].n, d: m.d, p: m.p, net: m.d - COST, bw: (sK.n60 && K.n60) ? propZ(K.bw60[1], K.n60, sK.bw60[1], sK.n60) : null }; }
        console.log(`      🏆 60日內曾 +${bw60}${bwZ ? `(vs 對照 ${f2(bwZ.d, 5)}pp p=${bwZ.p.toFixed(3)})` : ''} ・假訊號 ${fp} ・20日 P10/P50/P90 ${pc.map(v => f2(v, 6)).join('/')} ・獲利因子 10日 ${pf10 == null ? '—' : pf10.toFixed(2)} / 20日 ${pf20 == null ? '—' : pf20.toFixed(2)}${sh ? ` ・🎲 vs sham(n=${sh.n}) ${f2(sh.d)}pp p=${sh.p.toFixed(3)} 扣成本 ${f2(sh.net)}${sh.bw ? ` 曾+30% ${f2(sh.bw.d, 5)}pp` : ''}` : ''}`);
        const rg = {};
        for (const rk of ['@R200:up', '@R200:dn']) { const ra = R.ACC.get(k + w + rk), rb = R.ACC.get(baseKey + w + rk); if (ra && rb && ra.all[1].n >= 30) { const m = margin(ra.all[1], rb.all[1]); rg[rk.slice(6)] = { n: m.n, d: m.d, w: stat(ra.all[1]).w }; } }
        const rg60 = {};
        for (const rk of ['bull', 'bear', 'flat', 'hivol', 'mixed']) { const ra = R.ACC.get(k + w + '@R60:' + rk), rb = R.ACC.get(baseKey + w + '@R60:' + rk); if (ra && rb && ra.all[1].n >= 30) { const m = margin(ra.all[1], rb.all[1]); rg60[rk] = { n: m.n, d: m.d }; } }
        console.log(`      🌦️ 加權>MA200 ${rg.up ? `${f2(rg.up.d)}(n=${rg.up.n})` : '—'} / <MA200 ${rg.dn ? `${f2(rg.dn.d)}(n=${rg.dn.n})` : '—'} ・MA60 五態 ${Object.entries(rg60).map(([k2, v]) => `${k2} ${f2(v.d)}(${v.n})`).join(' ・') || '—'}`);
        report.buckets[k + w] = { base: baseKey + w, n: G.M.n, d: ds, abs: S.m, w: S.w, net: ds[1] - COST, p: G.M.p, pass: G.pass, nPass: G.nPass, yrShort: G.yrShort, half: G.H, byYear: G.YR, dropBest: G.dropBest,
            pf: { h10: pf10, h20: pf20 }, pct: pc, bw: { n20: K.n20, n60: K.n60, c20: K.bw20.map(v => K.n20 ? v / K.n20 * 100 : null), c60: K.bw60.map(v => K.n60 ? v / K.n60 * 100 : null), vsBase: bwZ }, fp: K.n20 ? K.fp / K.n20 * 100 : null, vsSham: sh, regime: { ma200: rg, ma60: rg60 } };
    }
    console.log();
};
const FK = ['rsacc', 'rsaccEW', 'turnacc', 'atrx', 'atrxUp', 'posacc', 'bkq'];
table('🚀 ① 單一 flag vs 全市場(全窗口;含 REF 錨點)', 'BASE_ALL', ['GENE', ...FK.map(k => 'F:' + k), 'POS:old', 'REF:rs8(20日超額≥8)']);
table('🚀 ② 單一 flag 疊在 🧬 之上(對照 = 🧬 全體;每列附 vs sham 同檔數隨機)', 'GENE', FK.map(k => 'F:' + k + '∧🧬'));
table('📦 ③ 基本面加速(@F6 窗口)', 'BASE_ALL', ['GENE', 'F:finacc', 'F:finacc+gm', 'F:finacc+eps'], '@F6');
table('📦 ③b 基本面加速 ∧🧬 vs 🧬(@F6)', 'GENE', ['F:finacc∧🧬', 'F:finacc+gm∧🧬', 'F:finacc+eps∧🧬'], '@F6');
table('🏭 ④ 產業確認(@IND 窗口)', 'BASE_ALL', ['GENE', 'F:indrs'], '@IND');
table('🏭 ④b 產業確認 ∧🧬 vs 🧬(@IND)', 'GENE', ['F:indrs∧🧬'], '@IND');
table('📈 ⑤ 突破品質拆解(對照 = 素的 60 日新高;品質的增量要跟素突破比,不是跟全市場比)', 'BK:nh60', ['BK:nh60∧CLV≥0.7', 'BK:nh60∧量比≥1.5', 'BK:bkq(兩者)', 'F:bkq20', 'F:bkq120', 'F:bkq252']);
table('📈 ⑤b 突破品質 vs 全市場', 'BASE_ALL', ['BK:nh60', 'BK:bkq(兩者)', 'F:bkq252', 'F:bkq252∧🧬']);
table('🔢 ⑥ 共振計數 CNT5(五個價量 flag 之和;⛔ 只計數不加權)vs 全市場', 'BASE_ALL', [0, 1, 2, 3, 4, 5].map(k => 'CNT5=' + k));
table('🔢 ⑥b CNT5≥k ∧🧬 vs 🧬(附 sham)', 'GENE', TH.cnt.map(k => `CNT5≥${k}∧🧬`));
table('🔢 ⑥c CNT7(七個 flag;母體 = 財報與產業都知道的股·日,@C7)', 'BASE7', [0, 1, 2, 3, 4, 5].map(k => 'CNT7=' + k), '@C7');
table('🔢 ⑥d CNT7≥k ∧🧬 vs 🧬(@C7,附 sham)', 'GENE7', TH.cnt.map(k => `CNT7≥${k}∧🧬`), '@C7');
// 單調性
const mono = (keys, w = '', baseKey = 'BASE_ALL') => { const b = R.ACC.get(baseKey + w); if (!b) return null; const ds = keys.map(k => { const a = R.ACC.get(k + w); return a && a.all[1].n >= 30 ? margin(a.all[1], b.all[1]).d : null; }); const v = ds.filter(x => x != null); return { ds, mono: v.length >= 3 && v.every((x, i) => i === 0 || x >= v[i - 1]) }; };
report.count = { five: mono([0, 1, 2, 3, 4, 5].map(k => 'CNT5=' + k)), seven: mono([0, 1, 2, 3, 4, 5].map(k => 'CNT7=' + k), '@C7', 'BASE7') };
console.log(`🔢 共振計數的邊際隨 k 單調上升?CNT5 ${report.count.five && report.count.five.mono ? '✅' : '❌'} ${report.count.five ? report.count.five.ds.map(x => f2(x, 5)).join(' → ') : '—'} ・CNT7 ${report.count.seven && report.count.seven.mono ? '✅' : '❌'} ${report.count.seven ? report.count.seven.ds.map(x => f2(x, 5)).join(' → ') : '—'}\n`);

// ⛰️ 高原
console.log('═'.repeat(110)); console.log('⛰️ ⑦ 門檻高原(∧🧬;每格 = vs 🧬 / vs sham 同檔數 / p / 扣成本)—— 相鄰 ±1 格同號且不反轉才叫高原;只有一格好 = 孤峰');
const PLAT = {
    rsacc: TH.rsacc.map(th => `rsacc Δ≥${th}`), turnacc: TH.turnacc.map(th => `turnacc 量比≥${th}`),
    atrx: TH.atrSq.flatMap(sq => TH.atrLook.map(lk => `atrx 壓縮<${sq}×回看${lk}`)), posacc: TH.posacc.map(th => `posacc 20日前<${th}`),
    bkq: TH.clv.flatMap(cv => TH.volx.map(vx => `bkq clv≥${cv}∧volx≥${vx}`)), finacc: TH.finacc.map(th => `finacc 加速≥${th === -Infinity ? '任意(只要yoy>0)' : th}`), indrs: TH.indrs.map(th => `indrs 產業前${th}`),
};
for (const [fk, cells] of Object.entries(PLAT)) {
    const w = fk === 'finacc' ? '@F6' : fk === 'indrs' ? '@IND' : '';
    const G = R.ACC.get('GENE' + w); if (!G) continue;
    console.log(`  ── ${fk} ──`);
    const rows = [];
    for (const k of cells) {
        const a = R.ACC.get('PL:' + k + w), s = R.ACC.get('SHAM:PL:' + k + w);
        if (!a || a.all[1].n < 30) { console.log(`    ${k.padEnd(34)} 樣本太少(n=${a ? a.all[1].n : 0})`); rows.push({ th: k, n: a ? a.all[1].n : 0 }); continue; }
        const vG = margin(a.all[1], G.all[1]), vS = s ? margin(a.all[1], s.all[1]) : null;
        console.log(`    ${k.padEnd(34)} n=${String(a.all[1].n).padStart(6)} ・vs 🧬 ${f2(vG.d)}pp p=${vG.p.toFixed(3)} ・vs sham ${vS ? `${f2(vS.d)}pp p=${vS.p.toFixed(3)}` : '—'} ・扣成本 ${f2((vS ? vS.d : vG.d) - COST)}`);
        rows.push({ th: k, n: a.all[1].n, vsGene: vG.d, pGene: vG.p, vsSham: vS ? vS.d : null, pSham: vS ? vS.p : null, net: (vS ? vS.d : vG.d) - COST });
    }
    const v = rows.filter(r => r.vsSham != null).map(r => r.vsSham);
    const pos = v.filter(x => x > 0).length;
    report.plateau[fk] = { cells: rows, shape: v.length < 3 ? 'none' : pos === v.length ? 'plateau+' : pos === 0 ? 'plateau−' : pos === 1 ? 'peak' : 'mixed' };
    console.log(`    → 形狀:${report.plateau[fk].shape}(${pos}/${v.length} 格 vs sham 為正)`);
}
console.log();
// 🎯 Miss Rate
console.log('═'.repeat(110)); console.log(`🎯 ⑧ Miss Rate(無前視):全市場「之後 60 日內最高收盤 ≥ +30% 且起點是那一波的谷底」的起點共 ${MR.starts.toLocaleString()} 個;問「起點當天以前 6 根有沒有亮過」`);
console.log(`  ${'flag'.padEnd(10)} ${'捕捉率'.padStart(8)} ${'日亮燈率'.padStart(9)} ${'6日窗基準(實測)'.padStart(14)} ${'獨立假設'.padStart(9)}  捕捉−基準`);
for (const k of FLAGS) { const o = MR.byFlag[k]; if (o.rate == null) { console.log(`  ${k.padEnd(10)} —`); continue; } console.log(`  ${k.padEnd(10)} ${(o.rate.toFixed(1) + '%').padStart(8)} ${(o.fireRate.toFixed(2) + '%').padStart(9)} ${(o.winRate.toFixed(1) + '%').padStart(14)} ${(o.randExpect.toFixed(1) + '%').padStart(9)}  ${f2(o.lift)}pp p=${o.pz.toFixed(3)}(n=${o.n})`); }
console.log(`  任一價量 flag(5 個)${MR.any5Rate == null ? '—' : MR.any5Rate.toFixed(1) + '%'}(基準 ${MR.winAny5Rate == null ? '—' : MR.winAny5Rate.toFixed(1) + '%'})・任一(7 個,n=${MR.n7})${MR.any7Rate == null ? '—' : MR.any7Rate.toFixed(1) + '%'}(基準 ${MR.winAny7Rate == null ? '—' : MR.winAny7Rate.toFixed(1) + '%'})・🧬 本身 ${MR.geneRate == null ? '—' : MR.geneRate.toFixed(1) + '%'}(基準 ${MR.winGeneRate == null ? '—' : MR.winGeneRate.toFixed(1) + '%'})`);
console.log('  ⚠️ 捕捉率要跟「6 日窗基準(實測)」比 = 全市場隨便挑一天往前看 6 根、本來就會亮的比例;⛔ 獨立假設 1−(1−p)^6 對狀態型 flag 會灌到 90%,只印給對照。沒贏過基準就是零資訊。\n');

console.log('🚨 「絕對10」= 那一桶自己的 10 日超額(扣同期加權)。⭐ 邊際為正 ≠ 賺得到 —— 對照組本身常是負的。');
console.log('🚨 「60日內曾 +30%」是事後最高點,dtflip 已證碰得到 ≠ 賺得到 → 一律跟同一列的 10/20 日邊際一起讀。');
console.log('⚠️ ' + report.limits.join('\n⚠️ '));
console.log('📋 規格本身的錯誤:\n   ・' + report.spec_errors.join('\n   ・'));
console.log('⛔ 探針不是測試(exit 0);要接進 App 必須六關全過 + vs sham + 高原 + V75.0.9 五條件。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, (k, v) => v === Infinity ? 'Infinity' : v, 1)); console.log(`\n💾 ${OUT}`); }
