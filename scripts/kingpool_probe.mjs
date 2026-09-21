#!/usr/bin/env node
/**
 * 👑 「成交額前 50 + 外部那套釣魚漏斗」有沒有優勢 —— V77.4.0
 *
 * 使用者拿一套外部「股王釣魚選股」邏輯問「有沒有比較厲害」。那套漏斗的每一層本站幾乎都量過
 * (ma5up +0.07 / ma20up +0.22 / plt100 0.00 / amt5·amt20 扣成本負 / PB<1 +0.09 / 外資連買六關 0 過 /
 *  AI 評分無預測力 / 隔日表態碰得到≠賺得到 / 3 日時間停損全滅),⭐ **唯一沒測過的是「成交額當日橫斷面排名前 N」**
 * (本站 127 個選股條件全是絕對億元門檻)。這支就只做那件事,而且要**當增量疊在 🧬 之上**測。
 *
 * 桶:
 *   BASE_ALL     全市場股·日(amt ≥ 0.1 億;⛔ 不含 00 開頭 ETF —— 股王講的是個股)
 *   BASE_TOP50   當日成交額排名 ≤50 的全體(K0 的第二個對照組:⛔ 只跟全市場比會把「前 50」的功勞算進漏斗)
 *   K0           外部漏斗原樣:rank≤50 ∧ b5>0 ∧ b20>0(代理「30 日均線向上」)∧ (c>300 ∨ amt>5) ∧ f5+t5>0 ∧ ¬(當日跌≥3% ∧ vr≥150)
 *   K1 −X        拆層:各拿掉一層(拿掉 rank 那版改 amt≥1 億當流動性門檻)
 *   GENE         🧬 pos252≥75 ∧ amp20≥3.2 ∧ amt≥1(pro.html CAST_MIN_AMT)—— K2 的對照組
 *   K2 N=…       GENE ∧ rank≤N,N=20/30/50/75/100/200(門檻高原)
 *   SHAM N=…     每天從 GENE 隨機抽「跟 K2 N 同樣檔數」(固定種子)—— V77.3.3 方法學:候選濾網的增量一律跟 sham 比
 *   K2′ amt≥5/20 GENE ∧ 絕對門檻 —— 相對排名 vs 絕對門檻誰乾淨
 *   K2″ N=50¬🧬  rank≤50 ∧ ¬GENE —— 增量來自排名還是 🧬
 *
 * ⛔ 零第二份定義:七個欄位一律照 `screener_miner.py::build_one` 的公式
 *    (amt = c×vol/1e8 ・ vr = vol/mean(vol[-20:])×100 ・ pos252 只用收盤 ・ amp20 = Σ(hi−lo)/cl/20×100 ・
 *     b5/b20 = (c/MA−1)×100 ・ f5/t5 = 近 5 日法人加總(股→張,None 不補 0)),
 *    而且 `--selftest` ⓪ 會拿 `screener.json` 的真實產物**逐檔對表**(⛔ 對不上就 exit 1)。
 *    🚨 `cast_probe.mjs` 的 amp 是 mean(|c/c₋₁−1|),跟 screener 的 amp20 **不是同一個數字** → 這支不照抄它。
 *
 * ⚠️ 兩個窗口分開講(⛔ 逐年那關不可放同一張表):
 *    K0/K1 用到 f5/t5 → `foreign_net` 2023-06 起才有 → 窗口 ≈ 2023-06~今(**不含 2022 空頭**)
 *    K2 系列不用法人欄 → 2021-01~今(含 2022;要用合併過 klines_deep 的 DATA_DIR)
 *
 * 進場 = t+1 開盤(排名用訊號日 t 當天的成交額 —— 收盤後才知道、隔天才進場,合法;selftest ⑤ 反向釘住)
 * 報酬扣同期加權 ・同桶同檔 20 日去重 ・t+1 開盤漲停剔除 ・斷崖守門(相鄰收盤 ±40% 整檔不跑)
 * 七關:①全期 ②前後半 ③逐年 ④去最好年 ⑤扣成本 0.44 ⑥z 檢定 p≤0.05 ⑦買得到(漲停剔除 + 成交額門檻)
 *
 * 用法:DATA_DIR=<合併過 klines_deep 的目錄> node --max-old-space-size=6144 scripts/kingpool_probe.mjs [out.json]
 *       node scripts/kingpool_probe.mjs --selftest        (SCR=<screener.json> SCR_DATA=<同一天的 K 線目錄> 可覆寫對表來源)
 * ⛔ 探針 exit 0、不進四驗證;要接進 App 必須六關全過 + V75.0.9 五條件。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => !a.startsWith('--'));

const HOLDS = [5, 10, 20];
const COST = 0.44;
const DEDUP = 20;
const WARM = 253;                 // pos252 要 252 根 + 1
const LIMIT_UP = 1.095;
const TOP_K0 = 50;
const NS = [20, 30, 50, 75, 100, 200];
const GENE_POS = 75, GENE_AMP = 3.2, GENE_AMT = 1;   // pro.html _EDGE_RULES.gene / CAST_MIN_AMT(⛔ 改一邊要改兩邊)
const KING_PX = 300, KING_AMT = 5;                    // 外部那套的「股王版」
const DUMP_CHG = -3, DUMP_VR = 150;                   // 「放量跌 >3% 剔除」
const MIN_EV = 100;
const BASE_MIN_AMT = 0.1;

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => x == null ? '—'.padStart(w) : (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
};
const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);
const rng = seed => { let x = seed >>> 0 || 1; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };

// ═══════════ 欄位(⛔ 一律照 screener_miner.py::build_one)═══════════
/** rows(舊→新,已 sort)→ 每根 t 的七欄。t 指「以 t 為最新日」時 build_one 會算出的值。 */
function features(rows) {
    const n = rows.length;
    const c = new Float64Array(n), op = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n), vo = new Float64Array(n);
    const fn = new Float64Array(n).fill(NaN), tn = new Float64Array(n).fill(NaN);
    const dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        c[i] = +r.close; op[i] = +r.open; hi[i] = +(r.high || r.close); lo[i] = +(r.low || r.close); vo[i] = +(r.volume || 0);
        if (r.foreign_net != null) fn[i] = +r.foreign_net / 1000;   // lots():股 → 張
        if (r.trust_net != null) tn[i] = +r.trust_net / 1000;
        dt[i] = nd(r.date);
    }
    const amt = new Float64Array(n), vr = new Float64Array(n).fill(NaN), pos = new Float64Array(n).fill(NaN);
    const amp = new Float64Array(n).fill(NaN), b5 = new Float64Array(n).fill(NaN), b20 = new Float64Array(n).fill(NaN);
    const chg = new Float64Array(n).fill(NaN), f5 = new Float64Array(n).fill(NaN), t5 = new Float64Array(n).fill(NaN);
    let vsum20 = 0, csum5 = 0, csum20 = 0, asum20 = 0;
    // 滑動窗口(⛔ 全部「含今日」—— 這裡是位階/乖離/量比,不是「爆量基準」,含今日是對的,見陷阱 #43)
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
        // pos252:cl[-252:](不足 252 就全部)—— 用單調隊列會更快,但 2,800 檔 × 1,400 根直接掃 252 也只要幾秒
        { const s = Math.max(0, t - 251); let h = -Infinity, l = Infinity; for (let k = s; k <= t; k++) { if (c[k] > h) h = c[k]; if (c[k] < l) l = c[k]; } if (h > l) pos[t] = (c[t] - l) / (h - l) * 100; }
        // f5/t5:近 5 根有值的加總(None 不補 0;一根都沒有 → NaN)
        { let s = 0, k0 = 0, s2 = 0, k2 = 0; for (let k = Math.max(0, t - 4); k <= t; k++) { if (!Number.isNaN(fn[k])) { s += fn[k]; k0++; } if (!Number.isNaN(tn[k])) { s2 += tn[k]; k2++; } } if (k0) f5[t] = s; if (k2) t5[t] = s2; }
    }
    return { n, c, op, hi, lo, vo, dt, amt, vr, pos, amp, b5, b20, chg, f5, t5 };
}

// ═══════════ 累加器 + 關卡(照 laoyu_probe)═══════════
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
    return { M, H, YR, dropBest, pass, nPass: Object.values(pass).filter(Boolean).length };
}

// ═══════════ 主迴圈 ═══════════
/**
 * universe: Map sym → features;TW: {days, c:Map};
 * 回 { ACC, SKIP, win, nDay, hook }。halfCut 分 K0 窗口與全窗口(各自的中位交易日)。
 */
function run(universe, TW, opt = {}) {
    const days = TW.days;
    const DI = new Map(days.map((d, i) => [d, i]));
    // 每檔:全域日 → 本檔 index
    const syms = [...universe.keys()];
    const AT = new Map();
    for (const s of syms) {
        const F = universe.get(s); const at = new Int32Array(days.length).fill(-1);
        for (let i = 0; i < F.n; i++) { const g = DI.get(F.dt[i]); if (g != null) at[g] = i; }
        AT.set(s, at);
    }
    // K0 窗口起點:第一個「≥100 檔 f5 有值」的交易日(⛔ 不寫死日期)
    let k0From = -1;
    for (let g = 0; g < days.length && k0From < 0; g++) {
        let k = 0; for (const s of syms) { const i = AT.get(s)[g]; if (i >= WARM && !Number.isNaN(universe.get(s).f5[i])) { if (++k >= (opt.k0MinSyms ?? 100)) break; } }
        if (k >= (opt.k0MinSyms ?? 100)) k0From = g;
    }
    const gEnd = days.length - 1;
    const half = { full: days[Math.floor((WARM + gEnd) / 2)], k0: k0From >= 0 ? days[Math.floor((k0From + gEnd) / 2)] : '9999' };
    const ACC = new Map(), last = new Map();
    const SKIP = { limitUp: 0, cliff: 0 };
    const rnd = rng(20260921);
    const bump = (key, y, h, rets) => {
        let a = ACC.get(key); if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()] }; ACC.set(key, a); }
        let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
        for (let i = 0; i < HOLDS.length; i++) { const v = rets[i]; if (v === null) continue; for (const t of [a.all[i], yy[i], a.byHalf[h][i]]) { t.n++; t.s += v; t.ss += v * v; if (v > 0) t.w++; } }
    };
    let nDay = 0;
    for (let g = WARM; g < gEnd; g++) {
        const D = days[g], twE = TW.c.get(days[g + 1]);
        if (!twE) continue;
        // 今天所有算得出來的股·日
        const todays = [];
        for (const s of syms) {
            const i = AT.get(s)[g]; if (i < WARM) continue;
            const F = universe.get(s);
            if (!(F.amt[i] >= BASE_MIN_AMT) || Number.isNaN(F.b20[i]) || Number.isNaN(F.pos[i]) || Number.isNaN(F.amp[i]) || Number.isNaN(F.vr[i])) continue;
            todays.push({ s, i, F });
        }
        if (todays.length < (opt.minSyms ?? 100)) continue;
        nDay++;
        // 橫斷面排名(用訊號日當天的 amt;⛔ 不可用 t+1)
        todays.sort((a, b) => b.F.amt[b.i] - a.F.amt[a.i]);
        for (let r = 0; r < todays.length; r++) todays[r].rank = r + 1;
        if (opt.onDay) opt.onDay(D, todays);
        const inK0 = g >= k0From && k0From >= 0;
        const emit = (key, x) => {
            const F = x.F, t = x.i, e = t + 1;
            if (e >= F.n) return;
            const kk = key + '|' + x.s, p = last.get(kk);
            if (p != null && t - p < DEDUP) return;
            last.set(kk, t);
            if (!(F.op[e] > 0) || F.op[e] >= F.c[t] * LIMIT_UP) { SKIP.limitUp++; return; }
            const rets = HOLDS.map(H => { const j = e + H; if (j >= F.n || !(F.c[j] > 0)) return null; const tw = TW.c.get(F.dt[j]); if (!tw) return null; return (F.c[j] / F.op[e] - 1) * 100 - (tw / twE - 1) * 100; });
            if (rets.every(v => v === null)) return;
            const y = +D.slice(0, 4);
            bump(key, y, D < half.full ? 0 : 1, rets);
            if (inK0) bump(key + '@K0', y, D < half.k0 ? 0 : 1, rets);
        };
        const gene = [];
        for (const x of todays) {
            const F = x.F, i = x.i;
            emit('BASE_ALL', x);
            if (x.rank <= TOP_K0) emit('BASE_TOP50', x);
            const L = {
                rank: x.rank <= TOP_K0, liq: F.amt[i] >= GENE_AMT,
                b5: F.b5[i] > 0, b20: F.b20[i] > 0,
                king: F.c[i] > KING_PX || F.amt[i] > KING_AMT,
                inst: !Number.isNaN(F.f5[i]) && !Number.isNaN(F.t5[i]) && (F.f5[i] + F.t5[i]) > 0,
                instKnown: !Number.isNaN(F.f5[i]) && !Number.isNaN(F.t5[i]),
                dump: !(F.chg[i] <= DUMP_CHG && F.vr[i] >= DUMP_VR),
            };
            if (inK0 && L.instKnown) {
                if (L.rank && L.b5 && L.b20 && L.king && L.inst && L.dump) emit('K0', x);
                if (L.liq && L.b5 && L.b20 && L.king && L.inst && L.dump) emit('K1 −rank(改amt≥1)', x);
                if (L.rank && L.b20 && L.king && L.inst && L.dump) emit('K1 −b5>0', x);
                if (L.rank && L.b5 && L.king && L.inst && L.dump) emit('K1 −b20>0', x);
                if (L.rank && L.b5 && L.b20 && L.inst && L.dump) emit('K1 −股王(c>300∨amt>5)', x);
                if (L.rank && L.b5 && L.b20 && L.king && L.dump) emit('K1 −法人5日>0', x);
                if (L.rank && L.b5 && L.b20 && L.king && L.inst) emit('K1 −放量跌剔除', x);
            }
            const isGene = F.pos[i] >= GENE_POS && F.amp[i] >= GENE_AMP && L.liq;
            if (isGene) { gene.push(x); emit('GENE', x); if (F.amt[i] >= 5) emit('K2′ 🧬∧amt≥5億', x); if (F.amt[i] >= 20) emit('K2′ 🧬∧amt≥20億', x); }
            else if (x.rank <= TOP_K0) emit('K2″ rank≤50∧¬🧬', x);
        }
        // K2 高原 + sham(每天從 🧬 隨機抽同樣檔數)
        for (const N of NS) {
            const inN = gene.filter(x => x.rank <= N);
            for (const x of inN) emit(`K2 🧬∧rank≤${N}`, x);
            if (inN.length && gene.length > inN.length) {
                const pool = gene.slice();
                for (let k = 0; k < inN.length; k++) { const j = k + Math.floor(rnd() * (pool.length - k)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
                for (let k = 0; k < inN.length; k++) emit(`SHAM N=${N}(🧬隨機抽同檔數)`, pool[k]);
            }
        }
    }
    return { ACC, SKIP, half, k0From: k0From >= 0 ? days[k0From] : null, nDay, days: [days[WARM], days[gEnd]] };
}

function loadTwii(dir) {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8')).map(r => ({ d: nd(r.date), c: +r.close })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
    return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])) };
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
/** 合成母體:NSYM 檔、NBAR 根,全部緩漲(pos 高)、振幅 4%(🧬 過門檻)、量按 idx 幾何遞減(排名固定)。 */
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
            rows.push(row); px = cl;
        }
        U.set(String(1000 + s), features(rows));
    }
    return U;
}
function selftest() {
    console.log('🧪 selftest —— ⓪ 對表 screener.json + 合成資料注入已知邊際\n');
    let bad = 0;
    const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };

    // ⓪ 對表:探針算的七欄 vs screener_miner.py 的真實產物(⛔ 這條才是「零第二份定義」的實質保證)
    {
        const scrP = process.env.SCR || path.join(DATA, 'screener.json');
        let scr = null; try { scr = JSON.parse(fs.readFileSync(scrP, 'utf8')); } catch (_) {}
        const kdir = process.env.SCR_DATA || DATA;
        if (!scr || !scr.rows || !scr.cols) ck(false, `⓪ 讀不到 screener.json(${scrP})→ ⛔ 對表沒做,不算過`);
        else {
            const CI = Object.fromEntries(scr.cols.map((k, i) => [k, i]));
            const keys = Object.keys(scr.rows).filter(s => /^\d{4}$/.test(s) && !s.startsWith('00'));
            const r0 = rng(7); const sample = []; while (sample.length < Math.min(300, keys.length)) { const k = keys[Math.floor(r0() * keys.length)]; if (!sample.includes(k)) sample.push(k); }
            let cmp = 0, miss = 0, dateMis = 0; const bad7 = {};
            const FIELDS = [['amt', 'amt', 0.05], ['vr', 'vr', 0.15], ['pos252', 'pos', 0.15], ['amp20', 'amp', 0.05], ['b5', 'b5', 0.05], ['b20', 'b20', 0.05], ['f5', 'f5', 1.5], ['t5', 't5', 1.5], ['chg', 'chg', 0.05]];
            for (const s of sample) {
                const rows = readRows(kdir, s + '.json'); if (!rows) { miss++; continue; }
                const F = features(rows); const t = F.n - 1;
                if (F.dt[t] !== nd(scr.data_date)) { dateMis++; continue; }
                cmp++;
                const v = scr.rows[s];
                for (const [col, fld, tol] of FIELDS) {
                    const a = v[CI[col]], b = F[fld][t];
                    if (a == null && Number.isNaN(b)) continue;
                    if (a == null || Number.isNaN(b) || Math.abs(a - b) > tol + Math.abs(a) * 0.005) { bad7[col] = (bad7[col] || 0) + 1; if ((bad7[col] || 0) <= 2) console.log(`   ⚠️ ${s} ${col}: screener ${a} vs 探針 ${Number.isNaN(b) ? 'NaN' : b.toFixed(3)}`); }
                }
            }
            const nb = Object.values(bad7).reduce((a, b) => a + b, 0);
            ck(cmp >= 100 && nb === 0, `⓪ 對表 screener.json(${scr.data_date}):比了 ${cmp} 檔(K 線目錄 ${kdir}${dateMis ? `;${dateMis} 檔最後一根不是那天` : ''}${miss ? `;${miss} 檔沒有 K 線` : ''})・不合 ${nb} 格 ${JSON.stringify(bad7)}${cmp < 100 ? ' 🚧 樣本不足(K 線目錄的最後一根要等於 data_date;用 SCR_DATA= 指定)' : ''}`);
        }
    }

    const NSYM = 120, NBAR = 900, days = mkDays(NBAR);
    const TW = { days, c: new Map(days.map(x => [x, 10000])) };
    // 2022 年中起才有法人欄(模擬 foreign_net 晚起);⛔ 只有第 0 檔法人是買的,其餘全是賣的 —— 否則合成母體人人過六層,K0 = 整個前 50
    const instAll = (s, i) => (i >= 300 ? (s === 0 ? { f: 1000, t: 500 } : { f: -1000, t: 0 }) : null);
    const K0N = a => a && a.all[1] ? a.all[1].n : 0;

    // ① 決定性注入:第 0 檔在訊號日全市場成交額第 1 + 六層全過,t+2 起 ×1.05 → K0 增量 ≥ +3pp(對照 = TOP50)
    {
        const sig = new Set(); for (let i = 320; i < NBAR - 25; i += 40) sig.add(i);
        const U = synth(NSYM, NBAR, days, {
            inst: instAll,
            volAt: (s, i, v) => (s === 0 && sig.has(i)) ? 1e9 : (s === 0 ? 1e5 : v),   // 平常排很後面,訊號日衝到第 1
        });
        // lift:訊號日 t 的 t+2 起 ×1.05(⛔ t+1 開盤不動 → 前視偷不到)
        const F0 = U.get('1000');
        for (const t of sig) for (let k = t + 2; k < F0.n; k++) { F0.c[k] *= 1.05; F0.op[k] *= 1.05; }
        const R = run(U, TW, { minSyms: 50, k0MinSyms: 50 });
        const k0 = R.ACC.get('K0@K0'), base = R.ACC.get('BASE_TOP50@K0');
        ck(K0N(k0) >= 8 && K0N(k0) <= sig.size, `① K0 事件 n=${K0N(k0)}(注入 ${sig.size} 次;要等於注入次數上下:六層在合成資料上全過)`);
        if (k0 && base) { const m = margin(k0.all[1], base.all[1]); ck(m.d >= 3, `① K0 vs TOP50 10 日增量 ${f2(m.d)}pp(注入 +5)`); }
        else ck(false, '① 桶不存在');
    }
    // ② 前視:只在 t+1 開盤起**整段**跳 +5%(t 收盤不動)→ 正確的 t+1 開盤進場量到 ≈0;用 t 收盤進場才會偷到 +5
    {
        const sig = new Set(); for (let i = 320; i < NBAR - 25; i += 40) sig.add(i);
        const U = synth(NSYM, NBAR, days, { inst: instAll, volAt: (s, i, v) => (s === 0 && sig.has(i)) ? 1e9 : (s === 0 ? 1e5 : v) });
        const F0 = U.get('1000');
        for (const t of sig) for (let k = t + 1; k < F0.n; k++) { F0.c[k] *= 1.05; F0.op[k] *= 1.05; }
        const R = run(U, TW, { minSyms: 50, k0MinSyms: 50 });
        const k0 = R.ACC.get('K0@K0'), base = R.ACC.get('BASE_TOP50@K0');
        if (k0 && base) { const m = margin(k0.all[1], base.all[1]); ck(Math.abs(m.d) < 0.5, `② 只在 t+1 開盤跳 +5%:增量 ${f2(m.d)}pp 必須 ≈0(進場 = t+1 開盤,⛔ 不是 t 收盤)`); }
        else ck(false, '② 桶不存在');
    }
    // ③ 去重:同一檔連續 3 天都是第 1 → K0 只算 1 次
    {
        const sig = new Set([400, 401, 402]);
        const U = synth(NSYM, NBAR, days, { inst: instAll, volAt: (s, i, v) => (s === 0 && sig.has(i)) ? 1e9 : (s === 0 ? 1e5 : v) });
        const R = run(U, TW, { minSyms: 50, k0MinSyms: 50 });
        ck(K0N(R.ACC.get('K0@K0')) === 1, `③ 連續 3 天同檔 → K0 n=${K0N(R.ACC.get('K0@K0'))}(要 1)`);
    }
    // ④ 鎖漲停:t+1 開盤 = c×1.10 → 不進桶、SKIP.limitUp ≥ 1
    {
        const sig = new Set([400]);
        const U = synth(NSYM, NBAR, days, { inst: instAll, volAt: (s, i, v) => (s === 0 && sig.has(i)) ? 1e9 : (s === 0 ? 1e5 : v) });
        const F0 = U.get('1000'); F0.op[401] = F0.c[400] * 1.10;
        const R = run(U, TW, { minSyms: 50, k0MinSyms: 50 });
        ck(K0N(R.ACC.get('K0@K0')) === 0 && R.SKIP.limitUp >= 1, `④ 隔天開盤漲停 → K0 n=${K0N(R.ACC.get('K0@K0'))}(要 0)・擋 ${R.SKIP.limitUp}`);
    }
    // ⑤ 排名合法性:A 在 t 放量 → t 的前 50 有 A;B 在 t+1 才放量 → ⛔ t 的前 50 不可有 B(排名只能用當天的量)
    {
        const t = 400;
        const U = synth(NSYM, NBAR, days, { volAt: (s, i, v) => (s === 118 && i === t) || (s === 119 && i === t + 1) ? 1e9 : v });
        let top = null;
        run(U, TW, { minSyms: 50, onDay: (D, todays) => { if (D === days[t]) top = new Set(todays.filter(x => x.rank <= 50).map(x => x.s)); } });
        ck(!!top && top.has('1118') && !top.has('1119'), `⑤ t 當天前 50:含 A(當天放量)${top ? top.has('1118') : '?'} ・含 B(隔天才放量)${top ? top.has('1119') : '?'}(要 true / false)`);
    }
    // ⑥ 高原機械:🧬 全體;rank≤20 每日 +0.30%、21~50 +0.20%、51~100 +0.10%、其餘 0 → K2 增量隨 N 單調遞減
    {
        const U = synth(NSYM, NBAR, days, { drift: (s, i) => s < 20 ? 0.003 : s < 50 ? 0.002 : s < 100 ? 0.001 : 0 });
        const R = run(U, TW, { minSyms: 50 });
        const G = R.ACC.get('GENE');
        const inc = NS.map(N => { const a = R.ACC.get(`K2 🧬∧rank≤${N}`); return a && G ? margin(a.all[1], G.all[1]).d : null; });
        const mono = inc.every(x => x != null) && inc.every((x, i) => i === 0 || x <= inc[i - 1] + 1e-9);
        ck(!!G && G.all[1].n >= 200, `⑥ 🧬 對照組 n=${G ? G.all[1].n : 0}(合成資料位階/振幅要過門檻,🚧 空過守門)`);
        ck(mono && inc[0] > inc[NS.length - 1] + 1, `⑥ K2 增量隨 N 單調遞減:${NS.map((N, i) => `N${N} ${f2(inc[i], 5)}`).join(' ・')}`);
    }
    // ⑦ sham 無注入:全體同 drift → |sham − 🧬| < 0.3、|K2 − 🧬| < 0.3
    {
        const U = synth(NSYM, NBAR, days, {});
        const R = run(U, TW, { minSyms: 50 });
        const G = R.ACC.get('GENE'), sh = R.ACC.get('SHAM N=50(🧬隨機抽同檔數)'), k2 = R.ACC.get('K2 🧬∧rank≤50');
        const ds = sh && G ? margin(sh.all[1], G.all[1]).d : null, dk = k2 && G ? margin(k2.all[1], G.all[1]).d : null;
        ck(ds != null && Math.abs(ds) < 0.3 && dk != null && Math.abs(dk) < 0.3, `⑦ 沒注入時 sham ${f2(ds)} / K2 ${f2(dk)} 都要 ≈0`);
    }
    // ⑧ 沒有法人欄 → K0 一筆都不可以有(⛔ 不可把「沒資料」補成 0 然後判「>0 沒過」以外的事);而 K2 照常有
    {
        const U = synth(NSYM, NBAR, days, {});
        const R = run(U, TW, { minSyms: 50 });
        ck(!R.ACC.get('K0') && R.k0From == null && !!R.ACC.get('K2 🧬∧rank≤50'), `⑧ 沒有 foreign_net/trust_net → K0 窗口 = ${R.k0From}、K0 桶 ${R.ACC.get('K0') ? '有' : '無'}、K2 桶 ${R.ACC.get('K2 🧬∧rank≤50') ? '有' : '無'}`);
    }
    console.log('\n' + (bad ? `❌ SELFTEST_FAIL:${bad} 條` : '✅ SELFTEST_PASS'));
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) selftest();

// ═══════════ 實跑 ═══════════
const TW = loadTwii(DATA);
console.log(`📅 大盤日曆 ${TW.days[0]} ~ ${TW.days[TW.days.length - 1]}(${TW.days.length} 個交易日)`);
if (TW.days[0] > '2022-06-01') console.log('🚨 窗口沒有涵蓋 2022 空頭 → K2 逐年那關意義打折(要用合併過深歷史的 DATA_DIR)');
const SKIPL = { cliff: 0 };
const U = loadUniverse(DATA, SKIPL);
console.log(`📂 母體 ${U.size} 檔個股(⛔ 不含 00 開頭 ETF;斷崖守門擋掉 ${SKIPL.cliff} 檔)`);
const R = run(U, TW);
console.log(`📊 掃 ${R.nDay} 個交易日 ・全窗口 ${R.days[0]} ~ ${R.days[1]}(前後半切點 ${R.half.full})・K0 窗口 ${R.k0From || '—'} ~ ${R.days[1]}(切點 ${R.half.k0})`);
console.log(`🛒 第七關「買得到嗎」:t+1 開盤漲停擋掉 ${R.SKIP.limitUp.toLocaleString()} 個事件;成交額門檻 全市場≥${BASE_MIN_AMT} 億 / 🧬≥${GENE_AMT} 億\n`);

const report = { window: { full: R.days, k0: [R.k0From, R.days[1]] }, nSym: U.size, nDay: R.nDay, cost: COST, ns: NS, buckets: {}, plateau: [], limits: [
    '「30 日均線向上」用 b20>0(收盤 > 20 日均)代理 —— 月線斜率本站 turnover_stage_probe 已判方向相反,⛔ 不再另寫第二份定義',
    '「淨值>0」幾乎恆真、PB 只有快照 → 沒進漏斗',
    'K0/K1 用到法人 5 日 → 窗口 2023-06 起(不含 2022 空頭);K2 系列不用法人欄 → 含 2022',
    '排名母體 = 有 K 線的個股(不含 ETF);外部那套若把 ETF 算進前 50,0050 那種會佔掉幾個名額',
    '不含股利;倖存者偏誤(只有目前還在 data/ 的股票)',
] };
const table = (title, baseKey, keys, suffix = '') => {
    const base = R.ACC.get(baseKey + suffix);
    console.log('═'.repeat(96)); console.log(title);
    if (!base || base.all[1].n < MIN_EV) { console.log(`  🚧 空過守門:對照組 ${baseKey} 只有 ${base ? base.all[1].n : 0} 筆 → ⛔ 不給結論\n`); return; }
    const bm = HOLDS.map((_, i) => stat(base.all[i]));
    console.log(`  對照組 ${baseKey} n=${base.all[1].n.toLocaleString()} ・超額 ${HOLDS.map((H, i) => `${H}日 ${f2(bm[i].m, 6)}`).join(' ・')} ・10 日勝率 ${bm[1].w.toFixed(1)}%`);
    console.log(`  ${'桶'.padEnd(28)} ${'n'.padStart(7)} ${'5日'.padStart(8)} ${'10日'.padStart(8)} ${'20日'.padStart(8)}  扣成本  勝率%  絕對10  關卡`);
    for (const k of keys) {
        const a = R.ACC.get(k + suffix);
        if (!a || a.all[1].n < 30) { console.log(`  ${k.padEnd(28)} ${String(a ? a.all[1].n : 0).padStart(7)}   —— 樣本太少`); report.buckets[k] = { n: a ? a.all[1].n : 0, thin: true }; continue; }
        const ds = HOLDS.map((_, i) => margin(a.all[i], base.all[i]).d);
        const G = gates(a, base, 1), S = stat(a.all[1]);
        const flag = G.nPass === 6 ? '✅ 六關全過' : `${G.nPass}/6`;
        console.log(`  ${k.padEnd(28)} ${String(G.M.n).padStart(7)} ${f2(ds[0], 8)} ${f2(ds[1], 8)} ${f2(ds[2], 8)} ${f2(ds[1] - COST, 7)} ${S.w.toFixed(1).padStart(6)} ${f2(S.m, 7)}  ${flag} p=${G.M.p.toFixed(4)}${G.M.n < 200 ? ' ⚠️樣本薄' : ''}`);
        console.log(`      逐年:${G.YR.map(x => `${x.y} ${f2(x.d, 6)}(n=${x.n})`).join(' ・')} ・前半 ${f2(G.H[0], 6)} / 後半 ${f2(G.H[1], 6)} ・去最好年 ${f2(G.dropBest, 6)}`);
        report.buckets[k] = { base: baseKey, n: G.M.n, d: ds, abs: S.m, w: S.w, net: ds[1] - COST, p: G.M.p, pass: G.pass, nPass: G.nPass, half: G.H, byYear: G.YR, dropBest: G.dropBest };
    }
    console.log();
};
table('👑 K0 外部漏斗原樣 vs 全市場(K0 窗口)', 'BASE_ALL', ['BASE_TOP50', 'K0'], '@K0');
table('👑 K0 vs 成交額前 50 全體(⭐ 這才是漏斗自己的功勞)+ 拆層(各拿掉一層)', 'BASE_TOP50', ['K0', 'K1 −rank(改amt≥1)', 'K1 −b5>0', 'K1 −b20>0', 'K1 −股王(c>300∨amt>5)', 'K1 −法人5日>0', 'K1 −放量跌剔除'], '@K0');
table('🧬 K2 「成交額排名前 N」疊在 🧬 之上(對照組 = 🧬 全體;全窗口含 2022)', 'GENE', [...NS.map(N => `K2 🧬∧rank≤${N}`), ...NS.map(N => `SHAM N=${N}(🧬隨機抽同檔數)`), 'K2′ 🧬∧amt≥5億', 'K2′ 🧬∧amt≥20億']);
table('🧬 K2″ 只有排名、沒有 🧬(對照組 = 全市場;全窗口)', 'BASE_ALL', ['K2″ rank≤50∧¬🧬', 'GENE']);
// 高原:K2 − sham 隨 N
console.log('═'.repeat(96)); console.log('⛰️ 門檻高原:K2(🧬∧rank≤N)− SHAM(同檔數隨機)的 10 日增量 —— ⛔ 只有一格好 = 孤峰');
for (const N of NS) {
    const a = R.ACC.get(`K2 🧬∧rank≤${N}`), s = R.ACC.get(`SHAM N=${N}(🧬隨機抽同檔數)`), g = R.ACC.get('GENE');
    if (!a || !s || !g || a.all[1].n < 30) { console.log(`  N=${String(N).padStart(3)}:樣本太少`); continue; }
    const vsS = margin(a.all[1], s.all[1]), vsG = margin(a.all[1], g.all[1]);
    console.log(`  N=${String(N).padStart(3)} n=${String(a.all[1].n).padStart(6)} ・vs sham ${f2(vsS.d)}pp p=${vsS.p.toFixed(3)} ・vs 🧬 ${f2(vsG.d)}pp ・扣成本 ${f2(vsS.d - COST)}`);
    report.plateau.push({ N, n: a.all[1].n, vsSham: vsS.d, pSham: vsS.p, vsGene: vsG.d, net: vsS.d - COST });
}
console.log('\n🚨 「絕對10」= 那一桶自己的 10 日超額(扣同期加權)。⭐ 邊際為正 ≠ 賺得到 —— 對照組本身常是負的。');
console.log('⚠️ ' + report.limits.join('\n⚠️ '));
console.log('⛔ 探針不是測試(exit 0);要接進 App 必須六關全過 + V75.0.9 五條件。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`\n💾 ${OUT}`); }
