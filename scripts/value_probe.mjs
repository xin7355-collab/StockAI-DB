#!/usr/bin/env node
/**
 * 💎 「價值 × 成長 × 週期」規格裡**真的沒測過**的三件 —— 資產價值(PB × ROE)/ 收益價值(四項同步改善)/ 週期價值(自身低谷反轉)—— V77.4.4
 *
 * 使用者貼了 54 節《不盯盤、不看線圖》規格。⭐ 先查登記表:PB 單獨(`valuation_deep_probe` +0.10pp = 零)、本益比(單調反向)、
 * PEG、殖利率、便宜×跌深(−1.07 六關全過**負向**)、低 PE×營收衰退、存貨天數/資本支出谷底(`doi_probe` 六關 0 過、「庫存去化加速」全表最差)、
 * 產業相對位階(`cyclical_probe` 5/6 逐年沒過)全部測過 → 這支只做沒測過的:
 *   A 資產價值   PB ≤ 0.8 ∧ ROE(近 4 季)> 10 / ≤0.5 ∧ >15 / ≤0.5 ∧ >30(規格三級;PB 用訊號日收盤)+ ex金融 + 拆解錨點 REF:pb≤0.8 / REF:roe>10
 *   B 收益價值   營收/毛利率/EPS/自由現金流**四項同時**比去年同季好,連續 ≥1 / ≥2 / ≥4 季;earnLo = 只營收好其餘沒跟(低品質);earn-noFCF = 三項(不看 FCF)
 *   C 週期價值   循環產業(miner.py 那 9 類代碼)∧ 自身 TTM 營收在近 12 個 TTM 的低谷(≤25%)∧ 最新季 rev 與 gm 同時反轉(QoQ / **YoY 必列**)
 *              拆解:trough-only / reversal-only;@wide(+半導體/光電/零組件);⭐ @noncyc = 同判式套**非循環股** → 證偽「循環」標籤有沒有資訊
 *   D 交叉      A∧B / A∧C / B∧C / A∧B∧C(規格 §22)
 *   T 價值陷阱  PB ≤ 0.8 ∧ rev/gm/fcf 三項都比去年同季差(規格 §19;對照 REF:pb≤0.8)
 * 判式全部住在 `lib_value.mjs`(portfolio_backtest 的 VAL= 濾網同一份,⛔ 這裡不寫第二份)。
 *
 * 進場 t+1 開盤 ・**60 日去重**(財報一季一變,20 日去重只是把同一狀態算三次;DEDUP= 可改)・t+1 開盤漲停剔除 ・報酬**含息**
 * (現金股利在除息日加回,股利用紀錄自帶的 before_price 對我們的收盤推分割倍率,同 total_return_probe)・扣同期加權 ・斷崖守門
 * 持有 20/60/120 日(不盯盤)・六關(以 60 日為主關)+ z 檢定 + 高原 + sham(每天從**該桶自己的母體**抽同檔數)+ regime(加權 MA200 兩態)
 * ⚠️ 持有 H > DEDUP 時同一檔的事件會重疊 → p 值用 n_eff = n × DEDUP / H(保守),表上印出來。
 * 每桶印 **fireRate**(占母體股·日 %,V77.4.3 第④條)+ 60/120 日 P10/P50/P90 + 獲利因子 + **持有期間最低收盤中位(中途最多賠)**。
 *
 * 用法:DATA_DIR=<合併 klines_deep 的目錄> FIN_DEEP=<fin_deep.json> AUX_DIR=<有 industry_map.json 的目錄> DIV=<dividends_hist.json>
 *       node --max-old-space-size=6144 scripts/value_probe.mjs [out.json]      (DEDUP=20|60|120 敏感度)
 *       node scripts/value_probe.mjs --selftest      (FIN_DEEP= 可覆寫 ⓪a 對表來源;FIN_SLICE=<data/fin 目錄>)
 * ⛔ 探針 exit 0、不進四驗證;要接進 App 必須六關全過 + vs sham + 高原 + V75.0.9 五條件。
 */
import fs from 'fs';
import path from 'path';
import { pubDate } from './lib_fundamentals.mjs';
import { valuePrep, valueSeries, valueKnownAt, valueOnAt, assetAt, earnAt, cycleAt, trapAt, KINDS, CYC_IND, CYC_IND_WIDE, FIN_IND } from './lib_value.mjs';
import { Reservoir, profitFactor, pTwoSided } from './lib_perf.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const AUX = process.env.AUX_DIR || path.join(ROOT, 'data');
const FIN = process.env.FIN_DEEP || path.join(ROOT, 'fin_deep', 'fin_deep.json');
const DIVP = process.env.DIV || path.join(ROOT, 'data', 'dividends_hist.json');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => !a.startsWith('--'));

const HOLDS = [20, 60, 120];
const HI = 1;                       // 主關 = 60 日
const COST = 0.44;
const DEDUP = +(process.env.DEDUP || 60);
const WARM = 60;
const LIMIT_UP = 1.095;
const MIN_EV = 100;
const BASE_MIN_AMT = 0.1;
const PL = { pb: [0.3, 0.5, 0.8, 1.0], roe: [10, 15, 20, 30], nImp: [1, 2, 3, 4], pos: [0, 0.25, 0.33, 0.5], nDet: [1, 2, 3] };

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => (x == null || Number.isNaN(x)) ? '—'.padStart(w) : (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const rng = seed => { let x = seed >>> 0 || 1; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };

// ═══════════ 欄位(只要 c / op / dt / amt)═══════════
function features(rows) {
    const n = rows.length;
    const c = new Float64Array(n), op = new Float64Array(n), amt = new Float64Array(n), dt = new Array(n);
    for (let i = 0; i < n; i++) { const r = rows[i]; c[i] = +r.close; op[i] = +r.open; amt[i] = c[i] * (+r.volume || 0) / 1e8; dt[i] = nd(r.date); }
    return { n, c, op, amt, dt };
}

// ═══════════ 累加器 + 關卡(照 accel_probe / kingpool_probe)═══════════
const mk = () => HOLDS.map(() => ({ n: 0, s: 0, ss: 0, w: 0 }));
const stat = t => t.n ? { n: t.n, m: t.s / t.n, v: Math.max(0, t.ss / t.n - (t.s / t.n) ** 2), w: t.w / t.n * 100 } : { n: 0, m: 0, v: 0, w: 0 };
const effScale = hi => Math.min(1, DEDUP / HOLDS[hi]);   // 持有 > 去重 → 事件重疊 → n_eff 打折
const margin = (a, b, hi = HI) => {
    const A = stat(a), B = stat(b), k = effScale(hi);
    if (!A.n || !B.n) return { n: A.n, d: 0, z: 0, p: 1 };
    const se = Math.sqrt(A.v / (A.n * k) + B.v / (B.n * k));
    const z = se > 0 ? (A.m - B.m) / se : 0;
    return { n: A.n, d: A.m - B.m, z, p: pTwoSided(z) };
};
function gates(a, base, hi = HI) {
    const M = margin(a.all[hi], base.all[hi], hi);
    const H = [0, 1].map(k => margin(a.byHalf[k][hi], base.byHalf[k][hi], hi).d);
    const yrs = [...a.byYear.keys()].sort();
    const YR = yrs.map(y => ({ y, n: a.byYear.get(y)[hi].n, d: base.byYear.has(y) ? margin(a.byYear.get(y)[hi], base.byYear.get(y)[hi], hi).d : 0 })).filter(x => x.n >= 20);
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
const mkKpi = () => ({ sw: 0, sl: 0, r60: new Reservoir(20000), r120: new Reservoir(20000), mdd: new Reservoir(20000) });

// ═══════════ 主迴圈 ═══════════
/** universe: Map sym → features;TW: {days, c:Map};opt.ser: Map sym → valueSeries;opt.ind: Map sym → 產業碼;opt.div: Map sym → [[exDate, cash, beforePrice]] */
function run(universe, TW, opt = {}) {
    const days = TW.days, DI = new Map(days.map((d, i) => [d, i]));
    const syms = [...universe.keys()], AT = new Map();
    for (const s of syms) {
        const F = universe.get(s); const at = new Int32Array(days.length).fill(-1);
        for (let i = 0; i < F.n; i++) { const g = DI.get(F.dt[i]); if (g != null) at[g] = i; }
        AT.set(s, at);
    }
    const gEnd = days.length - 1;
    const twC = days.map(d => TW.c.get(d));
    // regime:加權 MA200 兩態
    const r200 = new Array(days.length).fill(null); { let s = 0; for (let i = 0; i < days.length; i++) { s += twC[i]; if (i >= 200) s -= twC[i - 200]; if (i >= 199) r200[i] = twC[i] > s / 200 ? 'up' : 'dn'; } }
    const SER = opt.ser || new Map(), IND = opt.ind || new Map(), DIV = opt.div || new Map();
    const cycSet = new Set(opt.cyc || CYC_IND), wideSet = new Set(CYC_IND_WIDE), finSet = new Set(FIN_IND);
    const isCyc = s => IND.has(s) && cycSet.has(IND.get(s));
    const isWide = s => IND.has(s) && wideSet.has(IND.get(s));
    const isNonCyc = s => IND.has(s) && !cycSet.has(IND.get(s));
    const isFin = s => IND.has(s) && finSet.has(IND.get(s));
    // ── 窗口起點:第一天 ≥ minWin 檔「知道至少一季」(⛔ 不寫死日期)──
    let from = -1;
    for (let g = WARM; g < days.length && from < 0; g++) { let k = 0; for (const s of syms) { const i = AT.get(s)[g]; if (i >= WARM && valueKnownAt(SER.get(s), days[g])) { if (++k >= (opt.minWin ?? 100)) { from = g; break; } } } }
    if (from < 0) return null;
    const half = days[Math.floor((from + gEnd) / 2)];
    const ACC = new Map(), last = new Map();
    const SKIP = { limitUp: 0 };
    const NUL = { noSeries: 0, notYetPub: 0, noBvpsOrRoe: 0, noImp: 0, noTtm: 0, noClose: 0 };
    const LIT = {};   // 股·日 亮燈計數(去重之前)→ fireRate
    const TR = new Map();   // selftest 用:桶 → 亮過的 sym 集合
    const rnd = rng(20260921);
    const getA = key => { let a = ACC.get(key); if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()], k: mkKpi() }; ACC.set(key, a); } return a; };
    const bump = (key, y, h, rets, kpi) => {
        const a = getA(key);
        let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
        for (let i = 0; i < HOLDS.length; i++) { const v = rets[i]; if (v === null) continue; for (const t of [a.all[i], yy[i], a.byHalf[h][i]]) { t.n++; t.s += v; t.ss += v * v; if (v > 0) t.w++; } }
        if (kpi) { const K = a.k; if (rets[1] != null) { if (rets[1] > 0) K.sw += rets[1]; else K.sl -= rets[1]; K.r60.push(rets[1]); } if (rets[2] != null) K.r120.push(rets[2]); if (kpi.mdd != null) K.mdd.push(kpi.mdd); }
    };
    let nDay = 0, g = 0;
    // 含息:除息日在 (dt[e], dt[j]] 的現金股利加回;倍率 = 我們前一日收盤 ÷ 紀錄的 before_price(分割後的價格尺)
    const divBetween = (s, F, e, j) => {
        const arr = DIV.get(s); if (!arr || !arr.length) return 0;
        let dv = 0;
        for (const [dd, v, bp] of arr) {
            if (dd <= F.dt[e] || dd > F.dt[j]) continue;
            let mult = 1;
            if (bp > 0) { let k = e; while (k < j && F.dt[k + 1] < dd) k++; const ours = F.c[k]; const r = ours / bp; if (r > 0.1 && r < 10) mult = r; else continue; }
            dv += v * mult;
        }
        return dv;
    };
    const emit = (key, x, wins = ['']) => {
        const F = x.F, t = x.i, e = t + 1;
        LIT[key] = (LIT[key] || 0) + 1;
        if (e >= F.n) return;
        const kk = key + '|' + x.s, p = last.get(kk);
        if (p != null && t - p < DEDUP) return;
        last.set(kk, t);
        if (!(F.op[e] > 0) || F.op[e] >= F.c[t] * LIMIT_UP) { SKIP.limitUp++; return; }
        const twE = twC[g + 1];
        const rets = HOLDS.map(H => { const j = e + H; if (j >= F.n || !(F.c[j] > 0)) return null; const tw = TW.c.get(F.dt[j]); if (!tw) return null; return ((F.c[j] + divBetween(x.s, F, e, j)) / F.op[e] - 1) * 100 - (tw / twE - 1) * 100; });
        if (rets.every(v => v === null)) return;
        let mdd = null; if (e + 60 < F.n) { let l = Infinity; for (let j = e + 1; j <= e + 60; j++) if (F.c[j] < l) l = F.c[j]; mdd = (l / F.op[e] - 1) * 100; }
        const D = days[g], y = +D.slice(0, 4), h = D < half ? 0 : 1;
        for (const w of wins) {
            bump(key + w, y, h, rets, { mdd });
            if (!key.startsWith('PL:') && !key.startsWith('SHAM:')) bump(key + w + '@R200:' + (r200[g] || 'na'), y, h, rets, null);
        }
    };
    const shamDraw = (key, pool, k) => {
        if (!k || pool.length <= k) { if (k && pool.length) for (const x of pool) emit('SHAM:' + key, x); return; }
        const p = pool.slice();
        for (let i = 0; i < k; i++) { const j = i + Math.floor(rnd() * (p.length - i)); [p[i], p[j]] = [p[j], p[i]]; }
        for (let i = 0; i < k; i++) emit('SHAM:' + key, p[i]);
    };
    for (g = from; g < gEnd; g++) {
        if (!(twC[g + 1] > 0)) continue;
        const todays = [];
        for (const s of syms) {
            const i = AT.get(s)[g]; if (i < WARM) continue;
            const F = universe.get(s);
            if (!(F.amt[i] >= BASE_MIN_AMT)) continue;
            const ser = SER.get(s); if (!ser) { NUL.noSeries++; continue; }
            const q = valueKnownAt(ser, days[g]); if (!q) { NUL.notYetPub++; continue; }
            if (!(F.c[i] > 0)) { NUL.noClose++; continue; }
            todays.push({ s, i, F, q, c: F.c[i] });
        }
        if (todays.length < (opt.minSyms ?? 100)) continue;
        nDay++;
        if (opt.onDay) opt.onDay(days[g], todays);
        const baseV = [], baseC = [], baseW = [], baseN = [], baseCheap = [], hit = {};
        const need = k => (hit[k] ||= []);
        const lit = (k, x) => { emit(k, x); need(k).push(x); if (opt.trace) (TR.get(k) || TR.set(k, new Set()).get(k)).add(x.s); };
        for (const x of todays) {
            const { q, c, s } = x;
            emit('BASE@V', x); baseV.push(x);
            const cyc = isCyc(s), wide = isWide(s), non = isNonCyc(s), fin = isFin(s);
            if (cyc) { emit('BASE_CYC@C', x); baseC.push(x); }
            if (wide) baseW.push(x);
            if (non) { emit('BASE_NONCYC', x); baseN.push(x); }
            // ── A 資產價值 ──
            const a1 = assetAt(q, c, 1);
            if (a1 === null) NUL.noBvpsOrRoe++;
            else {
                const pb = c / q.bvps;
                if (a1) { lit('A:asset(PB≤0.8∧ROE>10)', x); if (!fin) lit('A:asset ex金融', x); if (x.F.amt[x.i] >= 1) lit('A:asset amt≥1億', x); }
                if (assetAt(q, c, 2)) lit('A:asset2(PB≤0.5∧ROE>15)', x);
                if (assetAt(q, c, 3)) lit('A:asset3(PB≤0.5∧ROE>30)', x);
                if (pb <= 0.8) { emit('REF:pb≤0.8', x); baseCheap.push(x); }
                if (q.roe4 > 10) emit('REF:roe>10', x);
                for (const tp of PL.pb) for (const tr of PL.roe) if (pb <= tp && q.roe4 > tr) lit(`PL:asset pb≤${tp}∧roe>${tr}`, x);
                // T 價值陷阱(對照 = REF:pb≤0.8)
                const tr3 = trapAt(q, c, 3);
                if (tr3) lit('T:trap(PB≤0.8∧三項惡化)', x);
                if (pb <= 0.8 && Number.isFinite(q.nDet)) for (const ndt of PL.nDet) if (q.nDet >= ndt) lit(`PL:trap pb≤0.8∧惡化≥${ndt}`, x);
            }
            // ── B 收益價值 ──
            const e1 = earnAt(q, 1);
            if (e1 === null) NUL.noImp++;
            else {
                if (e1) lit('B:earn(四項同升≥1季)', x);
                if (earnAt(q, 2)) lit('B:earn2(連續≥2季)', x);
                if (earnAt(q, 4)) lit('B:earn4(連續≥4季)', x);
                if (q.lowQ) lit('B:earnLo(只營收好)', x);
                if (q.revY > 0 && q.gmY > 0 && q.epsY > 0) lit('B:earn-noFCF(三項不看FCF)', x);
                for (const nn of PL.nImp) if (q.nImp >= nn) lit(`PL:earn 連續≥${nn}`, x);
            }
            // ── C 週期價值(只在循環股;@wide / @noncyc 是證偽用的變體)──
            const cQ = cycleAt(q, { pos: 0.25, yoy: false }), cY = cycleAt(q, { pos: 0.25, yoy: true });
            if (cY === null && cQ === null) NUL.noTtm++;
            if (cyc) {
                if (cQ) lit('C:cycle(低谷∧QoQ反轉)', x);
                if (cY) lit('C:cycleY(低谷∧YoY反轉)', x);
                if (Number.isFinite(q.ttmPos12) && q.ttmPos12 <= 0.25) lit('C:trough-only(只低谷)', x);
                if (q.revY > 0 && q.gmY > 0 && Number.isFinite(q.ttmPos12) && q.ttmPos12 > 0.25) lit('C:reversal-only(只反轉不低谷)', x);
                if (Number.isFinite(q.ttmPos12)) for (const ps of PL.pos) { if (q.ttmPos12 <= ps) { if (q.revQ > 0 && q.gmQ > 0) lit(`PL:cycle 低谷≤${ps}∧QoQ`, x); if (q.revY > 0 && q.gmY > 0) lit(`PL:cycle 低谷≤${ps}∧YoY`, x); } }
            }
            if (wide && cY) lit('C:cycleY@wide(+半導體光電零組件)', x);
            if (non && cY) lit('C:cycleY@noncyc(同判式套非循環股)', x);
            // ── D 交叉 ──
            if (a1 && e1) lit('D:A∧B', x);
            if (cyc && a1 && cY) lit('D:A∧C', x);
            if (cyc && e1 && cY) lit('D:B∧C', x);
            if (cyc && a1 && e1 && cY) lit('D:A∧B∧C', x);
        }
        // sham:每桶從自己的母體抽同檔數
        for (const [k, arr] of Object.entries(hit)) {
            const pool = k.startsWith('C:') || k.startsWith('D:A∧C') || k.startsWith('D:B∧C') || k.startsWith('D:A∧B∧C') || k.startsWith('PL:cycle')
                ? (k.includes('@wide') ? baseW : k.includes('@noncyc') ? baseN : baseC) : (k.startsWith('T:') || k.startsWith('PL:trap')) ? baseCheap : baseV;
            shamDraw(k, pool, arr.length);
        }
    }
    return { ACC, SKIP, NUL, LIT, TR, half, nDay, days: [days[from], days[gEnd]], r200 };
}

// ═══════════ 載入 ═══════════
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
function loadDiv(p) {
    const M = new Map();
    let D; try { D = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
    const src = D.d || D;
    for (const [sym, rec] of Object.entries(src)) { if (!rec || !Array.isArray(rec.h)) continue; const a = rec.h.filter(h => h[2] === '息' && +h[1] > 0).map(h => [nd(h[0]), +h[1], +h[3] || 0]).sort(); if (a.length) M.set(sym, a); }
    return M;
}

// ═══════════ selftest ═══════════
function mkDays(NBAR, y0 = 2021) {
    const days = []; let d = new Date(Date.UTC(y0, 0, 4));
    for (let i = 0; i < NBAR; i++) { while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5); days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    return days;
}
const QS = []; for (let y = 2020; y <= 2024; y++) for (const m of ['03-31', '06-30', '09-30', '12-31']) QS.push(`${y}-${m}`);
const FF = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps', 'ni'];
const SEAS = [0.8, 1.0, 1.35, 1.05];   // ⚠️ 季節性(V77.4.3 教訓:固定成長會讓「去年同季」與「上一季」的布林一樣 → 注入叫不出來)
/** 合成一檔 fin_deep:base 營收 × 季節性 × 成長;ocf/capex 做成**年內累計**(讓 detectCumulative 真的判成累計);hook 可改任一季 */
function finMk(o = {}) {
    const rec = {}; let cumO = 0, cumC = 0;
    QS.forEach((p, k) => {
        const g = o.growth ?? 1.05, base = (o.base ?? 1000) * Math.pow(g, k) * SEAS[k % 4] * (o.revMul ? o.revMul(k) : 1);
        const gmr = o.gm ? o.gm(k) : 0.30, eps = o.eps ? o.eps(k) : 1 + k * 0.05;
        const ocfQ = base * (o.ocfR ? o.ocfR(k) : 0.2), capQ = -base * (o.capR ? o.capR(k) : 0.05);
        if (p.endsWith('03-31')) { cumO = 0; cumC = 0; }
        cumO += ocfQ; cumC += capQ;
        const cap = o.cap ? o.cap(k) : 1e9, eq = o.eq ? o.eq(k) : 2e9;
        const ni = o.ni === 'off' ? null : (o.ni ? o.ni(k) : eps * cap / 10);
        rec[p] = [base * 0.4, base * (1 - gmr), cumC, base * 0.02, cumO, base, eq, cap, eps, ni];
        if (o.hook) o.hook(p, k, rec[p]);
    });
    return rec;
}
function synth(NSYM, NBAR, days, o = {}) {
    const U = new Map();
    for (let s = 0; s < NSYM; s++) {
        const r = rng(1000 + s * 7919), rows = [];
        let px = o.px ? o.px(s) : 100;
        for (let i = 0; i < NBAR; i++) {
            const drift = o.drift ? o.drift(s, i, px) : 0.0004;
            const op = px * (1 + (r() - 0.5) * 0.004);
            const cl = px * (1 + drift + (r() - 0.5) * 0.006);
            const row = { date: days[i], open: op, close: cl, high: Math.max(op, cl) * 1.01, low: Math.min(op, cl) * 0.99, volume: 5e6 };
            if (o.rowAt) o.rowAt(s, i, row);
            rows.push(row); px = row.close;
        }
        U.set(String(1000 + s), features(rows));
    }
    return U;
}
function selftest(FS) {
    console.log('🧪 selftest —— ⓪ 對表 + 合成注入(⛔ 每一條注入都要真的注進去)\n');
    let bad = 0;
    const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    const N = (R, k) => { const a = R && R.ACC.get(k); return a ? a.all[HI].n : 0; };
    const D = (R, k, b) => { const a = R && R.ACC.get(k), B = R && R.ACC.get(b); return a && B ? margin(a.all[HI], B.all[HI]).d : null; };

    // ⓪a 300 檔真實切片對表:roe4 / gm / fcf / par_chg_q 必須逐值等於 fin_slice.mjs
    {
        let FD = null; try { FD = JSON.parse(fs.readFileSync(FIN, 'utf8')); } catch (_) {}
        if (!FD) ck(false, `⓪a 讀不到 FIN_DEEP(${FIN})→ ⛔ 對表沒做,不算過`);
        else {
            const { detectAll, sliceOne } = FS;
            const CUM = detectAll(FD), P = valuePrep(FD);
            const keys = Object.keys(FD.s); const r0 = rng(7); const sample = []; while (sample.length < Math.min(300, keys.length)) { const k = keys[Math.floor(r0() * keys.length)]; if (!sample.includes(k)) sample.push(k); }
            let cmp = 0, badR = [], badG = [], badF = [], badP = [], nPar = 0;
            for (const sym of sample) {
                const sl = sliceOne(FD, CUM, sym, 40), ser = valueSeries(FD, sym, P); if (!sl || !ser || !ser.length) continue;
                const last = ser[ser.length - 1], lq = sl.q[sl.q.length - 1];
                const eqN = (a, b, tol) => (a == null && !Number.isFinite(b)) || (a != null && Number.isFinite(b) && Math.abs(a - b) <= tol);
                if (!eqN(sl.roe4, last.roe4, 0.06)) badR.push([sym, sl.roe4, last.roe4]);
                if (!eqN(lq.gm, last.gm, 0.06)) badG.push([sym, lq.gm, last.gm]);
                if (!eqN(lq.fcf, last.fcf, 1)) badF.push([sym, lq.fcf, last.fcf]);
                const parL = ser.find(q => q.par)?.p || null; if ((sl.par_chg_q || null) !== parL) badP.push([sym, sl.par_chg_q, parL]); else if (parL) nPar++;
                cmp++;
            }
            ck(cmp >= 200, `⓪a0 空過守門:對到 ${cmp} 檔(要 ≥200)`);
            ck(!badR.length, `⓪a roe4 逐值等於 fin_slice(${cmp} 檔;不符 ${badR.length}:${JSON.stringify(badR.slice(0, 3))})`);
            ck(!badG.length, `⓪a2 毛利率 逐值等於 fin_slice(不符 ${badG.length})`);
            ck(!badF.length, `⓪a3 自由現金流(單季營業現金流加單季資本支出,累計已還原)逐值等於 fin_slice(不符 ${badF.length}:${JSON.stringify(badF.slice(0, 2))})`);
            ck(!badP.length, `⓪a4 面額變更守門跟 fin_slice 同一條(不符 ${badP.length};兩邊都觸發 ${nPar} 檔)`);
        }
    }
    // ⓪b pub 對 lib_fundamentals.pubDate
    { const ser = valueSeries({ q: QS, f: FF, s: { 9: finMk() } }, '9'); ck(ser.every(q => q.pub === pubDate(q.p)) && ser.find(q => q.p === '2024-03-31').pub === '2024-05-15', '⓪b 每一季的可用日 = 法定截止日(2024-03-31 → 2024-05-15)'); }

    // ── 合成母體:80 檔 + 每檔一份財報;prep 只算一次 ──
    const NB = 1250, days = mkDays(NB, 2021);
    const mkFD = (recs) => ({ q: QS, f: FF, s: recs });
    const runOn = (U, FD, o = {}) => { const P = valuePrep(FD); const ser = new Map(); for (const s of U.keys()) { const x = valueSeries(FD, s, P); if (x) ser.set(s, x); } const TWc = new Map(days.map((d, i) => [d, 100 + i * 0.01])); return run(U, { days, c: TWc }, { ser, ind: o.ind, div: o.div, minSyms: 1, minWin: 1, cyc: o.cyc, trace: true }); };
    const IND = new Map(); for (let s = 0; s < 80; s++) IND.set(String(1000 + s), s < 20 ? '15' : (s === 24 || s === 25) ? '17' : '24');   // 0~19 循環(航運)、24~25 金融(兩檔都會亮 A)、其餘半導體

    // ①a 資產三級:px 讓 PB 分別落在 0.4 / 0.7 / 1.2;ROE 由 eps 給(eps 1.5 × 股數 1e8 ÷ eq 2e9 = 7.5% … 調 eq)
    {
        const recs = {}; for (let s = 0; s < 80; s++) recs[String(1000 + s)] = finMk({ eps: () => 2, eq: () => (s % 4 === 0 ? 0.5e9 : s % 4 === 1 ? 1.2e9 : 2.5e9) });
        // eq 0.5e9 → ROE = 4季 × 2 × 1e8 / 0.5e9 = 160%;1.2e9 → 66.7%;2.5e9 → 32%
        const U = synth(80, NB, days, { px: s => (s % 3 === 0 ? 2 : s % 3 === 1 ? 6 : 20) });   // bvps = eq/1e8 = 5 / 12 / 25 → PB 隨 s 變
        const R = runOn(U, mkFD(recs), { ind: IND });
        ck(!!R && N(R, 'BASE@V') > 200, `①0 空過守門:BASE@V n=${N(R, 'BASE@V')}`);
        // 手算一檔:s=0 → eq 0.5e9、bvps 5、px 2 → PB 0.4、ROE 160 → 三級全亮;s=2 → eq 2.5e9 bvps 25 px 20 → PB 0.8、ROE 32 → 只 asset(=0.8 ∧ >10)…px 會漂,用 ser 直接驗
        const P = valuePrep(mkFD(recs)); const q = valueKnownAt(valueSeries(mkFD(recs), '1000', P), '2024-06-01');
        ck(assetAt(q, 2, 1) === true && assetAt(q, 2, 2) === true && assetAt(q, 2, 3) === true && assetAt(q, 25, 1) === false, `①a asset 三級:PB 0.4 ∧ ROE ${q.roe4.toFixed(0)}% 三級全亮;PB 5 不亮`);
        ck(assetAt(q, 3.5, 1) === true && assetAt(q, 3.5, 2) === false, '①a2 PB 0.7:只有第一級亮(≤0.8),第二級(≤0.5)不亮');
        ck(N(R, 'A:asset(PB≤0.8∧ROE>10)') > 30 && N(R, 'A:asset ex金融') < N(R, 'A:asset(PB≤0.8∧ROE>10)'), `①a3 A 桶有事件(n=${N(R, 'A:asset(PB≤0.8∧ROE>10)')})且 ex金融 比較少(金融 2 檔被剔)`);
        ck(N(R, 'REF:pb≤0.8') >= N(R, 'A:asset(PB≤0.8∧ROE>10)') && N(R, 'REF:roe>10') >= N(R, 'A:asset(PB≤0.8∧ROE>10)'), '①a4 拆解錨點 REF:pb≤0.8 / REF:roe>10 各自 ≥ A 桶');
    }
    // ①b 收益價值:earn / earn2 / earnLo / noFCF
    {
        const FD = mkFD({
            // 全期同步改善(成長 1.05 ∧ gm 微升 ∧ eps 升 ∧ ocf 比例升)→ nImp 一路累積
            up: finMk({ gm: k => 0.30 + k * 0.002, eps: k => 1 + k * 0.05, ocfR: k => 0.2 + k * 0.003 }),
            // 只營收好:gm 降、eps 降、ocf 降
            lo: finMk({ gm: k => 0.30 - k * 0.002, eps: k => 2 - k * 0.05, ocfR: k => 0.3 - k * 0.015 }),   // ocf 比例掉得比營收成長快 → fcf 也比去年同季差
            // 三項好但 FCF 不好(capex 暴增)
            nofcf: finMk({ gm: k => 0.30 + k * 0.002, eps: k => 1 + k * 0.05, capR: k => 0.05 + k * 0.02 }),
        });
        const P = valuePrep(FD), d = '2024-06-01';
        const up = valueKnownAt(valueSeries(FD, 'up', P), d), lo = valueKnownAt(valueSeries(FD, 'lo', P), d), nf = valueKnownAt(valueSeries(FD, 'nofcf', P), d);
        ck(earnAt(up, 1) === true && earnAt(up, 2) === true && earnAt(up, 4) === true && up.nImp >= 8, `①b 四項一路同升 → earn / earn2 / earn4 全亮(nImp=${up.nImp})`);
        ck(earnAt(lo, 1) === false && lo.lowQ === true && valueOnAt(valueSeries(FD, 'lo', P), d, 'earnLo') === true, '①b2 只營收好 → earn 不亮、earnLo 亮');
        ck(earnAt(nf, 1) === false && nf.revY > 0 && nf.gmY > 0 && nf.epsY > 0 && nf.fcfY < 0, '①b3 三項好但 FCF 惡化 → earn 不亮(四項要同時);noFCF 那桶才收它');
        ck(up.lowQ === false && nf.lowQ === false, '①b4 lowQ 只在「營收好其餘都沒跟」才 true');
    }
    // ①c 週期:低谷 + 反轉;⛔ 財報完全相同的非循環股不進 C 桶;低谷但 gm 降不亮;高檔反轉不亮
    {
        // V 型營收:k 0~8 降、9~11 谷底平台、12 起升(用 revMul);gm 同步 V 型(⚠️ 季節性仍疊在上面)
        const VM = k => k <= 8 ? 1.5 - k * 0.05 : k <= 11 ? 1.0 : 1.0 + (k - 11) * 0.06, VG = k => k <= 11 ? 0.35 - k * 0.01 : 0.24 + (k - 11) * 0.015;
        const vRec = finMk({ growth: 1, revMul: VM, gm: VG });
        const vGmDn = finMk({ growth: 1, revMul: VM, gm: () => 0.30 });   // 營收反轉但 gm 平 → 不亮
        const flat = finMk({ growth: 1, gm: k => 0.30 + [0, 0, 0.02, 0.01][k % 4] });   // 零成長、只有季節性 → QoQ 每年 Q3 都會「反轉」,YoY 永遠不會
        const hi = finMk({ growth: 1.06, gm: k => 0.30 + k * 0.002 });                                                       // 高檔一路升 → 不是低谷
        const recs = {}; for (let s = 0; s < 80; s++) recs[String(1000 + s)] = s < 20 ? vRec : s === 30 ? vRec : s === 31 ? vGmDn : s === 33 ? flat : hi;   // 1030 = 非循環股拿同一份 V 型財報;1033 = 零成長季節性
        const FD = mkFD(recs), P = valuePrep(FD);
        const sV = valueSeries(FD, '1000', P);
        const rev = sV.find(q => cycleAt(q, { pos: 0.25, yoy: false }) === true);
        ck(!!rev && rev.ttmPos12 <= 0.25 && rev.revQ > 0 && rev.gmQ > 0, `①c V 型營收:谷底之後第一季 QoQ 反轉亮(${rev && rev.p} pos=${rev && rev.ttmPos12.toFixed(2)})`);
        const revY = sV.find(q => cycleAt(q, { pos: 0.25, yoy: true }) === true);
        ck(!!revY && revY.revY > 0 && revY.gmY > 0, `①c1b YoY 版也會亮(${revY && revY.p})`);
        const fl = valueSeries(FD, '1033', P);
        const flQ = fl.filter(q => cycleAt(q, { pos: 0.25, yoy: false }) === true), flY = fl.filter(q => cycleAt(q, { pos: 0.25, yoy: true }) === true);
        ck(flQ.length >= 3 && flQ.every(q => q.p.endsWith('09-30')) && flY.length === 0, `①c2 零成長只有季節性的公司:QoQ 版每年 Q3 都誤亮(${flQ.length} 次,全在 09-30)、YoY 版 0 次 —— 這正是 cycleY 必列的理由`);
        const gd = valueSeries(FD, '1031', P); ck(!gd.some(q => cycleAt(q, { pos: 0.25, yoy: false }) === true), '①c3 低谷但毛利率沒反轉 → 不亮(rev 與 gm 要同時)');
        const hs = valueSeries(FD, '1032', P); ck(!hs.some(q => cycleAt(q, { pos: 0.25, yoy: true }) === true) && hs.some(q => Number.isFinite(q.ttmPos12) && q.ttmPos12 > 0.5), '①c4 高檔一路升 → 沒有低谷 → 不亮');
        const R = runOn(synth(80, NB, days), FD, { ind: IND });
        ck(N(R, 'C:cycle(低谷∧QoQ反轉)') > 0 && N(R, 'BASE_CYC@C') > 0, `①c5 C 桶有事件(n=${N(R, 'C:cycle(低谷∧QoQ反轉)')})`);
        ck(N(R, 'C:cycleY@noncyc(同判式套非循環股)') > 0, `①c6 非循環股 1030 拿同一份財報 → 進 @noncyc 證偽桶(n=${N(R, 'C:cycleY@noncyc(同判式套非循環股)')}),⛔ 不進 C 桶`);
        // 決定性:C 桶的事件檔全部是循環股(1030 財報一模一樣但產業碼 24)
        const cs = R.TR.get('C:cycle(低谷∧QoQ反轉)') || new Set(), ny = R.TR.get('C:cycleY@noncyc(同判式套非循環股)') || new Set();
        ck(cs.size > 0 && !cs.has('1030') && [...cs].every(s => IND.get(s) === '15') && ny.has('1030'), `①c7 C 桶只收循環股(${cs.size} 檔;1030 沒漏進來,它在 @noncyc)`);
    }
    // ①d 價值陷阱:便宜 + 三項惡化 → 量得到負邊際(合成:trap 檔進場後續跌)
    {
        const recs = {}; for (let s = 0; s < 80; s++) recs[String(1000 + s)] = s < 20 ? finMk({ growth: 0.93, gm: k => 0.30 - k * 0.004, eps: () => 1, ocfR: k => 0.3 - k * 0.008, eq: () => 4e9 }) : finMk({ eq: () => 4e9 });
        const U = synth(80, NB, days, { px: () => 20, drift: (s, i) => s < 20 ? -0.0012 : 0.0004 });   // bvps 40、px 20 → PB 0.5 全便宜;trap 檔續跌
        const R = runOn(U, mkFD(recs));
        const d = D(R, 'T:trap(PB≤0.8∧三項惡化)', 'REF:pb≤0.8');
        ck(N(R, 'T:trap(PB≤0.8∧三項惡化)') > 30 && d != null && d < -5, `①d 陷阱桶 n=${N(R, 'T:trap(PB≤0.8∧三項惡化)')} vs 同樣便宜的 ${f2(d)}pp(合成 −0.12%/日 要量得到)`);
        ck(N(R, 'PL:trap pb≤0.8∧惡化≥3') === N(R, 'T:trap(PB≤0.8∧三項惡化)') && N(R, 'PL:trap pb≤0.8∧惡化≥1') >= N(R, 'PL:trap pb≤0.8∧惡化≥3'), '①d2 高原:惡化≥3 = trap 桶;≥1 ⊇ ≥3');
    }
    // ①e multi:只有三者都成立的那檔
    {
        const vRec = (eq) => finMk({ growth: 1, revMul: k => k <= 8 ? 1.5 - k * 0.06 : 1.02 + (k - 8) * 0.08, gm: k => k <= 8 ? 0.35 - k * 0.012 : 0.25 + (k - 8) * 0.015, eps: k => k <= 8 ? 2 - k * 0.15 : 0.8 + (k - 8) * 0.3, ocfR: k => k <= 8 ? 0.3 - k * 0.02 : 0.14 + (k - 8) * 0.03, eq: () => eq });
        const recs = { 1000: vRec(0.5e9), 1001: vRec(0.5e9), 1002: finMk({ eq: () => 0.5e9 }) };
        for (let s = 3; s < 80; s++) recs[String(1000 + s)] = finMk({ eq: () => 40e9 });   // PB 極高 → A 不亮
        const IND2 = new Map(IND); IND2.set('1001', '24');   // 1001 財報跟 1000 一樣但**不是循環股**
        const U = synth(80, NB, days, { px: () => 2 });   // bvps 5 → PB 0.4
        const R = runOn(U, mkFD(recs), { ind: IND2 });
        ck(N(R, 'D:A∧B∧C') > 0 && R.LIT['D:A∧B∧C'] > 0, `①e multi 有事件(n=${N(R, 'D:A∧B∧C')})`);
        const P = valuePrep(mkFD(recs)); const s0 = valueSeries(mkFD(recs), '1000', P), s2 = valueSeries(mkFD(recs), '1002', P);
        const dM = s0.find(q => valueOnAt(s0, q.pub, 'multi', { close: 2 }) === true);
        ck(!!dM && valueOnAt(s2, dM.pub, 'multi', { close: 2 }) === false && valueOnAt(s2, dM.pub, 'asset', { close: 2 }) === true, `①e2 同一天:1000 三者成立(${dM && dM.p});1002 只有 A 成立 → multi false、asset true`);
    }
    // ② 前視:季末到 5/15 之間 0 根亮(注入 `q.p <= day` 必紅);②b PB 用 t 收盤
    {
        const FD = mkFD({ 1000: finMk({ eq: () => 0.5e9, eps: k => k >= 12 ? 0.2 : 0.01 }) });   // 2023 起 eps 0.2(ni 2e7/季);近 4 季要 ≥3 季換新 ROE 才過 10% → 第一個亮的季 = 2023-09-30
        const P = valuePrep(FD), ser = valueSeries(FD, '1000', P);
        const first = ser.find(q => assetAt(q, 2, 1) === true);
        ck(!!first && first.p === '2023-09-30', `②0 第一個會亮的季 = ${first && first.p}(近 4 季 ROE 要 ≥3 季換新才過 10%)`);
        const before = valueOnAt(ser, '2023-11-13', 'asset', { close: 2 }), on = valueOnAt(ser, '2023-11-14', 'asset', { close: 2 });
        ck(before === false && on === true, `② 2023-09-30 那季在 2023-11-13 還「不知道」(用上一季 → false),2023-11-14 起才亮 —— ⛔ 拿季別當可用日就是前視(before=${before}, on=${on})`);
        ck(valueOnAt(ser, '2020-01-01', 'asset', { close: 2 }) === null && valueOnAt(ser, '2024-06-01', 'asset', {}) === null, '②c 還沒有任何一季 / 沒給 close → null(⛔ 不是 false)');
        // ②b PB 用 t 收盤:t 收盤 PB 0.9(不亮)、t+1 開盤跳低到 PB 0.6 → 仍不亮
        const U = synth(1, 600, days, { px: () => 4.5, rowAt: (s, i, row) => { if (i === 250) row.open = 3.0; } });   // ⚠️ 要 600 根:300 根時 60 日報酬欄恆 null → n 恆 0 = 假綠燈(第一版就是)
        const R = runOn(U, mkFD({ 1000: finMk({ eq: () => 0.5e9, eps: () => 2 }) }));
        ck(N(R, 'A:asset(PB≤0.8∧ROE>10)') === 0 && N(R, 'BASE@V') > 0, `②b PB 用訊號日收盤(0.9)→ 不亮;t+1 開盤跳低到 0.6 ⛔ 不可讓它亮(n=${N(R, 'A:asset(PB≤0.8∧ROE>10)')})`);
    }
    // ③ 去重:同一檔連續亮 → 每 DEDUP 根只算一次
    {
        const U = synth(1, 600, days, { px: () => 2 });
        const R = runOn(U, mkFD({ 1000: finMk({ eq: () => 0.5e9, eps: () => 2 }) }));
        const lit = R.LIT['A:asset(PB≤0.8∧ROE>10)'], n = N(R, 'A:asset(PB≤0.8∧ROE>10)');
        ck(lit > 300 && n >= 4 && n <= Math.ceil(lit / DEDUP) + 1, `③ 去重:亮 ${lit} 個股·日 → 事件 ${n}(≈ ÷${DEDUP})`);
    }
    // ④ 鎖漲停:t+1 開盤 ≥ 收盤 × 1.095 → 剔除並計數
    {
        const U = synth(1, 400, days, { px: () => 2, rowAt: (s, i, row) => { if (i >= 100) row.open = row.close * 1.2; } });
        const R = runOn(U, mkFD({ 1000: finMk({ eq: () => 0.5e9, eps: () => 2 }) }));
        ck(R.SKIP.limitUp > 0, `④ 鎖漲停剔除 ${R.SKIP.limitUp} 個事件`);
    }
    // ⑤ sham ≈ 0 且 n(SHAM:k) == n(k)(同檔數)
    {
        const recs = {}; for (let s = 0; s < 80; s++) recs[String(1000 + s)] = finMk({ eq: () => (s < 30 ? 0.5e9 : 40e9), eps: () => 2 });
        const U = synth(80, NB, days, { px: () => 2 });
        const R = runOn(U, mkFD(recs));
        const k = 'A:asset(PB≤0.8∧ROE>10)';
        ck(N(R, 'SHAM:' + k) > 100 && R.LIT['SHAM:' + k] === R.LIT[k], `⑤ sham 每天抽同檔數:股·日 ${R.LIT[k]} = ${R.LIT['SHAM:' + k]}(事件數 ${N(R, k)} vs ${N(R, 'SHAM:' + k)}:sham 散在更多檔上,去重後事件數本來就不同)`);
        const ds = D(R, 'SHAM:' + k, 'BASE@V'); ck(ds != null && Math.abs(ds) < 1.0, `⑤b sham 對母體邊際 ≈ 0(${f2(ds)}pp)`);
    }
    // ⑥ null 三種原因各 ≥1,⛔ 不是 false
    {
        const recs = { 1000: finMk({ ni: 'off', hook: (p, k, row) => { row[8] = null; } }), 1001: finMk({ hook: (p, k, row) => { row[5] = null; } }) };   // 1000 沒 eps/ni → roe4 NaN;1001 沒 rev → ttm/imp NaN
        for (let s = 2; s < 40; s++) recs[String(1000 + s)] = finMk();
        const U = synth(60, 400, days, { px: () => 2 });   // 1040~1059 沒財報 → noSeries
        const R = runOn(U, mkFD(recs));
        ck(R.NUL.noSeries > 0 && R.NUL.noBvpsOrRoe > 0 && R.NUL.noImp > 0, `⑥ null 計數:noSeries ${R.NUL.noSeries} / noBvpsOrRoe ${R.NUL.noBvpsOrRoe} / noImp ${R.NUL.noImp}`);
        const P = valuePrep(mkFD(recs)); const s0 = valueSeries(mkFD(recs), '1000', P);
        ck(valueOnAt(s0, '2024-06-01', 'asset', { close: 2 }) === null && valueOnAt(s0, '2024-06-01', 'trap', { close: 2 }) !== undefined, '⑥b 沒 ROE 的檔 asset → null(⛔ 不是 false)');
    }
    // ⑦ 累計還原:ocf/capex 是年內累計 → Q4 單季 fcf 要等於「Q4 累計 − Q3 累計」(注入拿 raw 必紅)
    {
        const FD = mkFD({ 1000: finMk() }); const P = valuePrep(FD);
        ck(P.CUM.ocf === true && P.CUM.capex === true && P.CUM.rev === false, `⑦0 detectCumulative:ocf/capex 判成累計、rev 單季(${JSON.stringify(P.CUM)})`);
        const ser = valueSeries(FD, '1000', P); const q4 = ser.find(q => q.p === '2023-12-31'), q3 = ser.find(q => q.p === '2023-09-30');
        const raw4 = FD.s['1000']['2023-12-31'], raw3 = FD.s['1000']['2023-09-30'];
        const want = (raw4[4] - raw3[4]) + (raw4[2] - raw3[2]);
        ck(Math.abs(q4.fcf - want) < 1e-6 && Math.abs(q4.fcf - (raw4[4] + raw4[2])) > 1, `⑦ Q4 單季 fcf = 累計相減(${q4.fcf.toFixed(0)});⛔ 不是 raw 累計(${(raw4[4] + raw4[2]).toFixed(0)})`);
    }
    // ⑧ 面額守門:EPS ÷4 那季起 null;同資料有官方 ni 不觸發
    {
        const par = finMk({ ni: 'off', eps: k => k >= 10 ? 0.5 : 2, eq: () => 0.5e9 });          // 2022-09-30 起 EPS ÷4、營收毛利股本都沒動、沒官方 ni → 疑似面額變更
        const parNi = finMk({ eps: k => k >= 10 ? 0.5 : 2, eq: () => 0.5e9, ni: k => 2 * 1e8 });   // 有官方 ni → 不觸發
        const FD = mkFD({ p: par, n: parNi }); const P = valuePrep(FD);
        const sp = valueSeries(FD, 'p', P), sn = valueSeries(FD, 'n', P);
        const f = sp.find(q => q.par);
        ck(!!f && f.p === '2022-09-30' && sp.filter(q => q.p >= '2022-09-30').every(q => !Number.isFinite(q.roe4) && !Number.isFinite(q.bvps)), `⑧ 面額守門:${f && f.p} 起 roe4/bvps 一律 NaN → asset/trap 回 null`);
        ck(!sn.some(q => q.par) && Number.isFinite(sn[sn.length - 1].roe4), '⑧b 同一份資料有官方淨利 → 不觸發(股數變沒變由官方淨利說了算)');
        ck(valueOnAt(sp, '2024-06-01', 'asset', { close: 2 }) === null && valueOnAt(sn, '2024-06-01', 'asset', { close: 2 }) === true, '⑧c 守門觸發 → null;沒觸發 → 正常判');
    }
    // ⑨ 高原格集合包含:pb≤0.3 ⊆ pb≤0.5 ⊆ pb≤0.8;roe>30 ⊆ roe>10
    {
        const recs = {}; for (let s = 0; s < 80; s++) recs[String(1000 + s)] = finMk({ eq: () => 0.5e9 * (1 + (s % 5)), eps: () => 0.5 + (s % 7) * 0.5 });
        const U = synth(80, NB, days, { px: s => 2 + (s % 6) });
        const R = runOn(U, mkFD(recs));
        const L = k => R.LIT[k] || 0;
        ck(L('PL:asset pb≤0.3∧roe>10') <= L('PL:asset pb≤0.5∧roe>10') && L('PL:asset pb≤0.5∧roe>10') <= L('PL:asset pb≤0.8∧roe>10') && L('PL:asset pb≤0.8∧roe>30') <= L('PL:asset pb≤0.8∧roe>10') && L('PL:asset pb≤0.8∧roe>10') > 0, `⑨ 高原格單調包含(pb≤0.3 ${L('PL:asset pb≤0.3∧roe>10')} ≤ 0.5 ${L('PL:asset pb≤0.5∧roe>10')} ≤ 0.8 ${L('PL:asset pb≤0.8∧roe>10')};roe>30 ${L('PL:asset pb≤0.8∧roe>30')})`);
        ck(L('PL:asset pb≤0.8∧roe>10') === L('A:asset(PB≤0.8∧ROE>10)'), '⑨b PL:asset pb≤0.8∧roe>10 那格 = A 桶(同一條判式)');
    }
    // ⑩ regime up+dn = 全
    {
        const recs = {}; for (let s = 0; s < 40; s++) recs[String(1000 + s)] = finMk({ eq: () => 0.5e9, eps: () => 2 });
        const U = synth(40, NB, days, { px: () => 2 });
        const R = runOn(U, mkFD(recs));
        const k = 'A:asset(PB≤0.8∧ROE>10)';
        ck(N(R, k) > 0 && N(R, k + '@R200:up') + N(R, k + '@R200:dn') + N(R, k + '@R200:na') === N(R, k) && N(R, k + '@R200:up') > 0, `⑩ regime:up ${N(R, k + '@R200:up')} + dn ${N(R, k + '@R200:dn')} + 還沒有 MA200 ${N(R, k + '@R200:na')} = ${N(R, k)}`);
    }
    console.log(bad ? `\n❌ selftest ${bad} 條失敗` : '\n✅ VALUE_PROBE_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) { const FS = await import('./fin_slice.mjs'); selftest(FS); }

// ═══════════ 實跑 ═══════════
const TW = loadTwii(DATA);
console.log(`📅 大盤日曆 ${TW.days[0]} ~ ${TW.days[TW.days.length - 1]}(${TW.days.length} 個交易日)`);
if (TW.days[0] > '2022-06-01') console.log('🚨 窗口沒有涵蓋 2022 空頭 → 逐年那關意義打折(要用合併過深歷史的 DATA_DIR)');
const SKIPL = { cliff: 0 };
const U = loadUniverse(DATA, SKIPL);
console.log(`📂 母體 ${U.size} 檔個股(⛔ 不含 00 開頭 ETF;斷崖守門擋掉 ${SKIPL.cliff} 檔)`);
let FD = null; try { FD = JSON.parse(fs.readFileSync(FIN, 'utf8')); } catch (e) { console.error(`🚨 讀不到 FIN_DEEP(${FIN}):${e.message} → 這支沒有財報就沒有東西可測,停`); process.exit(1); }
const PREP = valuePrep(FD);
const SER = new Map(); for (const s of U.keys()) { const ser = valueSeries(FD, s, PREP); if (ser && ser.length) SER.set(s, ser); }
console.log(`📦 fin_deep ${FD.q[0]} ~ ${FD.q[FD.q.length - 1]}(${FD.q.length} 季;累計欄 ${Object.entries(PREP.CUM).filter(([, v]) => v).map(([k]) => k).join('/')} 已還原)→ ${SER.size} 檔有季序列(可用日 = 法定截止日,保守)`);
let IND_MAP = new Map();
try { const m = JSON.parse(fs.readFileSync(path.join(AUX, 'industry_map.json'), 'utf8')); IND_MAP = new Map(Object.entries(m).filter(([s]) => U.has(s)).map(([s, v]) => [s, String(v)])); } catch (e) { console.log(`⚠️ 讀不到 industry_map.json(${AUX}):${e.message} → C 那一層整個不跑`); }
const nCyc = [...IND_MAP.values()].filter(v => CYC_IND.includes(v)).length;
console.log(`🏭 industry_map ${IND_MAP.size} 檔有官方產業碼 → 循環產業 ${nCyc} 檔(${CYC_IND.join('/')})・寬版 ${[...IND_MAP.values()].filter(v => CYC_IND_WIDE.includes(v)).length} 檔`);
const DIVM = loadDiv(DIVP);
console.log(DIVM ? `💰 dividends_hist ${DIVM.size} 檔有現金股利 → 報酬**含息**` : `⚠️ 讀不到 DIV(${DIVP})→ 報酬不含息(A/T 是高殖利率族,會低估)`);
const R = run(U, TW, { ser: SER, ind: IND_MAP, div: DIVM || new Map() });
if (!R) { console.error('🚨 窗口起點找不到(沒有一天 ≥100 檔知道財報)→ 停'); process.exit(1); }
console.log(`📊 掃 ${R.nDay} 個交易日 ・窗口 ${R.days[0]} ~ ${R.days[1]}(切點 ${R.half})・去重 ${DEDUP} 日 ・持有 ${HOLDS.join('/')} 日(120 日的 n_eff = n×${effScale(2).toFixed(2)})`);
console.log(`🛒 第七關「買得到嗎」:t+1 開盤漲停擋掉 ${R.SKIP.limitUp.toLocaleString()} 個事件 ・成交額門檻 ≥${BASE_MIN_AMT} 億`);
console.log(`❓ 「不知道」計數(股·日,已剔除⛔ 不當成通過):${Object.entries(R.NUL).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' ・')}\n`);

// bench:同窗口加權 / 0050 的 20/60/120 日平均報酬
const bench = (() => {
    const out = {}; const di = new Map(TW.days.map((d, i) => [d, i])); const g0 = di.get(R.days[0]), g1 = di.get(R.days[1]);
    const twc = TW.days.map(d => TW.c.get(d));
    out.twii = HOLDS.map(H => { let s = 0, n = 0; for (let g = g0; g + H <= g1; g += DEDUP) { s += (twc[g + H] / twc[g] - 1) * 100; n++; } return n ? +(s / n).toFixed(2) : null; });
    try { const r = JSON.parse(fs.readFileSync(path.join(DATA, '0050.json'), 'utf8')).map(x => [nd(x.date), +x.close]).filter(x => x[1] > 0).sort(); const m = new Map(r); const ds = r.map(x => x[0]).filter(d => d >= R.days[0] && d <= R.days[1]); out.etf50 = HOLDS.map(H => { let s = 0, n = 0; for (let g = 0; g + H < ds.length; g += DEDUP) { s += (m.get(ds[g + H]) / m.get(ds[g]) - 1) * 100; n++; } return n ? +(s / n).toFixed(2) : null; }); out.etf50From = ds[0]; out.etf50Partial = ds[0] > R.days[0]; } catch (_) {}
    return out;
})();
console.log(`📈 基準(同窗口、每 ${DEDUP} 日取樣、不扣任何東西):加權 ${HOLDS.map((H, i) => `${H}日 ${f2(bench.twii[i], 6)}%`).join(' ・')}${bench.etf50 ? ` ・0050 ${HOLDS.map((H, i) => `${H}日 ${f2(bench.etf50[i], 6)}%`).join(' ・')}${bench.etf50Partial ? `(⚠️ 0050 只從 ${bench.etf50From} 起,partial)` : ''}` : ''}\n`);

const report = { version: 'V77.4.4', window: R.days, half: R.half, dedup: DEDUP, nSym: U.size, nSymFin: SER.size, nSymInd: IND_MAP.size, nCyc, nDay: R.nDay, cost: COST, holds: HOLDS, withDiv: !!DIVM, bench,
    null_count: R.NUL, skip: R.SKIP,
    kinds: { asset: 'PB≤0.8 ∧ ROE(近4季)>10(PB 用訊號日收盤;bvps = eq ÷ (cap/10))', asset2: 'PB≤0.5 ∧ ROE>15', asset3: 'PB≤0.5 ∧ ROE>30', earn: 'rev/gm/eps/fcf 四項同時比去年同季好(連續≥1季)', earn2: '連續≥2季', earn4: '連續≥4季', earnLo: '只營收比去年同季好、其餘三項都沒有', cycle: '循環產業 ∧ TTM 營收在自身近12個TTM ≤25% ∧ 最新季 rev、gm 同時 > 上一季', cycleY: '同上但比去年同季', trap: 'PB≤0.8 ∧ rev/gm/fcf 三項都比去年同季差' },
    buckets: {}, plateau: {}, fireRate: {}, spec_errors: [
        '「PB<0.5 ∧ ROE>60%」規格自己說只是公開文章示例;本站實測 PB 單獨零邊際(valuation_deep_probe +0.10pp)、低本益比單調反向 → 估值只能避雷⛔ 不能選股,是本站已定案的結論',
        '「景氣低谷 = 買點」:doi_probe 實測存貨天數/資本支出谷底六關 0 過、「庫存去化加速」全表最差;這支只測「自身營收低谷 + 反轉」這個沒測過的版本',
        '「便宜可以便宜很久」規格說對了:便宜×跌深 −1.07/−3.35pp 六關全過(負向)—— 那是避雷不是進場',
        '5/10/15/20 年回測與 2010 起訓練段做不到:K 線 2021 起、加權 2021-09 起、財報 2018 起 → 最長 ~4.8 年只含一次空頭',
        'publication_date 本站只有法定截止日(5/15・8/14・11/14・3/31)→ 只能做「可用日之後」,⛔ 做不了「公告後 N 天內」',
        '「12 季同步改善」照字面幾乎空集合 → 台股調適成連續 ≥1/2/4 季',
        'Tier A/B/C 是研究優先序不是評級 —— 跟本站「⛔ 不顯總分」(陷阱 #38)一致',
    ], limits: [
        `最長 ${R.days[0]} ~ ${R.days[1]} 只含一次空頭(2022);財報 2018 起但加權 2021-09 起`,
        '只有法定截止日(多數公司提早公布 → 真實可用日更早,本站只能更保守)',
        '倖存者偏誤(fin_deep 只有目前還在的 2,352 檔)→ T 價值陷阱的負邊際是**低估**',
        '沒有現金・有息負債・無形資產 → 做不了 Net Cash / TBV / EV;沒有總資產 → 沒有負債比',
        '營益率 opi 欄 fin_deep 還沒回算 → 用毛利率代替',
        '淨值含非控制權益;股數 = 股本÷10(面額 10 假設;面額變更守門觸發的那一季起 null,方向是漏抓不是誤抓)',
        `產業碼只有 ${IND_MAP.size} 檔(興櫃/部分上櫃沒碼 → 不進 C)`,
        '含息(現金股利除息日加回)但加權指數是價格指數 → 對加權的超額略偏多(全桶一致,不影響桶間比較)',
        `持有 ${HOLDS.filter(H => H > DEDUP).join('/')} 日 > 去重 ${DEDUP} 日 → 事件重疊,p 值用 n_eff 打折(保守)`,
    ] };

const table = (title, baseKey, keys, note = '') => {
    const base = R.ACC.get(baseKey);
    console.log('═'.repeat(118)); console.log(title + (note ? `\n  ${note}` : ''));
    if (!base || base.all[HI].n < MIN_EV) { console.log(`  🚧 空過守門:對照組 ${baseKey} 只有 ${base ? base.all[HI].n : 0} 筆 → ⛔ 不給結論\n`); return; }
    const bm = HOLDS.map((_, i) => stat(base.all[i])), BL = R.LIT[baseKey] || 0;
    const bp = base.k.mdd.pct([0.5])[0];
    console.log(`  對照組 ${baseKey} n=${base.all[HI].n.toLocaleString()} ・超額 ${HOLDS.map((H, i) => `${H}日 ${f2(bm[i].m, 6)}`).join(' ・')} ・60 日勝率 ${bm[HI].w.toFixed(1)}% ・中途最多賠(中位)${f2(bp, 6)}%`);
    console.log(`  ${'桶'.padEnd(34)} ${'n'.padStart(6)} ${'亮%'.padStart(6)} ${'20日'.padStart(8)} ${'60日'.padStart(8)} ${'120日'.padStart(8)}  扣成本  勝率%  對加權60  關卡`);
    for (const k of keys) {
        const a = R.ACC.get(k);
        const fire = BL ? (R.LIT[k] || 0) / BL * 100 : null; report.fireRate[k] = fire;
        if (!a || a.all[HI].n < 30) { console.log(`  ${k.padEnd(34)} ${String(a ? a.all[HI].n : 0).padStart(6)} ${fire == null ? '—' : fire.toFixed(2).padStart(6)}   —— 樣本太少`); report.buckets[k] = { n: a ? a.all[HI].n : 0, thin: true, fire }; continue; }
        const ds = HOLDS.map((_, i) => margin(a.all[i], base.all[i], i).d);
        const G = gates(a, base, HI), S = stat(a.all[HI]), K = a.k;
        const flag = G.nPass === 6 ? '✅ 六關全過' : `${G.nPass}/6${G.yrShort ? '(逐年不足 3 年)' : ''}`;
        console.log(`  ${k.padEnd(34)} ${String(G.M.n).padStart(6)} ${fire.toFixed(2).padStart(6)} ${f2(ds[0], 8)} ${f2(ds[1], 8)} ${f2(ds[2], 8)} ${f2(ds[1] - COST, 7)} ${S.w.toFixed(1).padStart(6)} ${f2(S.m, 7)}  ${flag} p=${G.M.p.toFixed(4)}${G.M.n < 200 ? ' ⚠️樣本薄' : ''}`);
        console.log(`      逐年:${G.YR.map(x => `${x.y} ${f2(x.d, 6)}(n=${x.n})`).join(' ・')} ・前半 ${f2(G.H[0], 6)} / 後半 ${f2(G.H[1], 6)} ・去最好年 ${f2(G.dropBest, 6)}`);
        const p60 = K.r60.pct([0.1, 0.5, 0.9]), p120 = K.r120.pct([0.1, 0.5, 0.9]), md = K.mdd.pct([0.5, 0.9]);
        const pf = profitFactor(K.sw, K.sl);
        let sh = null; const s = R.ACC.get('SHAM:' + k);
        if (s && s.all[HI].n >= 30) { const m = margin(a.all[HI], s.all[HI]); sh = { n: s.all[HI].n, d: m.d, p: m.p, net: m.d - COST }; }
        const rg = {}; for (const r of ['up', 'dn']) { const x = R.ACC.get(k + '@R200:' + r), b = R.ACC.get(baseKey + '@R200:' + r); if (x && b && x.all[HI].n >= 30) rg[r] = { n: x.all[HI].n, d: margin(x.all[HI], b.all[HI]).d }; }
        console.log(`      60日 P10/P50/P90 ${p60.map(v => f2(v, 6)).join('/')} ・120日 ${p120.map(v => f2(v, 6)).join('/')} ・中途最多賠 中位 ${f2(md[0], 6)} / 最差10% ${f2(md[1], 6)} ・獲利因子(60日) ${pf == null ? '—' : pf === Infinity ? '∞' : pf.toFixed(2)}${sh ? ` ・🎲 vs sham(n=${sh.n}) ${f2(sh.d)}pp p=${sh.p.toFixed(3)} 扣成本 ${f2(sh.net)}` : ' ・🎲 sham —'}${Object.keys(rg).length ? ` ・regime 加權>MA200 ${rg.up ? f2(rg.up.d, 6) + '(n=' + rg.up.n + ')' : '—'} / <MA200 ${rg.dn ? f2(rg.dn.d, 6) + '(n=' + rg.dn.n + ')' : '—'}` : ''}`);
        report.buckets[k] = { n: G.M.n, fire, d: HOLDS.map((_, i) => +ds[i].toFixed(3)), net60: +(ds[1] - COST).toFixed(3), win60: +S.w.toFixed(1), abs60: +S.m.toFixed(3), p: +G.M.p.toFixed(4), pass: G.pass, nPass: G.nPass, years: G.YR.map(x => [x.y, +x.d.toFixed(2), x.n]), half: G.H.map(v => +v.toFixed(2)), dropBest: +G.dropBest.toFixed(2), p60: p60.map(v => v == null ? null : +v.toFixed(2)), p120: p120.map(v => v == null ? null : +v.toFixed(2)), mddMed: md[0] == null ? null : +md[0].toFixed(2), mddP90: md[1] == null ? null : +md[1].toFixed(2), pf: pf == null ? null : pf === Infinity ? null : +pf.toFixed(2), sham: sh ? { n: sh.n, d: +sh.d.toFixed(3), p: +sh.p.toFixed(4), net: +sh.net.toFixed(3) } : null, regime: rg };
    }
    console.log();
};
const plateau = (title, baseKey, keys) => {
    const base = R.ACC.get(baseKey); if (!base) return;
    console.log('═'.repeat(118)); console.log(title);
    const rows = [];
    for (const k of keys) { const a = R.ACC.get(k); if (!a || a.all[HI].n < 30) { rows.push([k, a ? a.all[HI].n : 0, null, null, null]); continue; } const G = gates(a, base, HI); const s = R.ACC.get('SHAM:' + k); const sd = (s && s.all[HI].n >= 30) ? margin(a.all[HI], s.all[HI]).d : null; rows.push([k, G.M.n, G.M.d, G.nPass, sd, G.M.p]); }
    for (const [k, n, d, np, sd, p] of rows) console.log(`  ${k.padEnd(36)} n=${String(n).padStart(6)}  60日 ${d == null ? '   —   ' : f2(d)}  ${np == null ? '' : `${np}/6`}  vs sham ${sd == null ? '  —  ' : f2(sd)}${p != null ? `  p=${p.toFixed(3)}` : ''}${n && n < 30 ? '  樣本太少' : ''}`);
    report.plateau[title] = rows.map(([k, n, d, np, sd, p]) => ({ k, n, d: d == null ? null : +d.toFixed(3), nPass: np, sham: sd == null ? null : +sd.toFixed(3), p: p == null ? null : +p.toFixed(4) }));
    console.log();
};

table('💰 A 資產價值(PB × ROE 交叉)—— 對照 = 全部已知財報的股·日', 'BASE@V',
    ['A:asset(PB≤0.8∧ROE>10)', 'A:asset ex金融', 'A:asset amt≥1億', 'A:asset2(PB≤0.5∧ROE>15)', 'A:asset3(PB≤0.5∧ROE>30)', 'REF:pb≤0.8', 'REF:roe>10'],
    'REF 兩桶是拆解錨點(PB 單獨已測零邊際;ROE 單獨本站沒測過)—— 交叉有沒有比任一單獨好才是問題;amt≥1億 = 買得到嗎(🧬 同門檻)');
table('📈 B 收益價值(四項同步改善)—— 對照 = BASE@V', 'BASE@V',
    ['B:earn(四項同升≥1季)', 'B:earn2(連續≥2季)', 'B:earn4(連續≥4季)', 'B:earn-noFCF(三項不看FCF)', 'B:earnLo(只營收好)'],
    'earnLo 是規格 §7 的「低品質成長」→ 若它跟 earn 一樣好,「品質」就沒有資訊');
table('🔄 C 週期價值(自身低谷 + 反轉)—— 對照 = 循環產業成員(⛔ 不拿全市場當對照)', 'BASE_CYC@C',
    ['C:cycle(低谷∧QoQ反轉)', 'C:cycleY(低谷∧YoY反轉)', 'C:trough-only(只低谷)', 'C:reversal-only(只反轉不低谷)', 'C:cycleY@wide(+半導體光電零組件)'],
    'trough-only / reversal-only 拆解哪一半在做事;@wide 是規格 §10 的 20 類版本');
table('🔄 C 證偽:同一條判式套在**非循環股** —— 對照 = 非循環成員', 'BASE_NONCYC',
    ['C:cycleY@noncyc(同判式套非循環股)'],
    '⭐ 若它跟 C:cycleY 一樣好 → 「循環」標籤沒有資訊,做事的是「自身低谷反轉」本身');
table('🔗 D 交叉(規格 §22)—— 對照 = BASE@V(A∧C/B∧C/三者 = 循環成員)', 'BASE@V', ['D:A∧B']);
table('🔗 D 交叉(含 C)—— 對照 = BASE_CYC@C', 'BASE_CYC@C', ['D:A∧C', 'D:B∧C', 'D:A∧B∧C']);
table('🪤 T 價值陷阱 —— 對照 = 同樣便宜(REF:pb≤0.8)', 'REF:pb≤0.8', ['T:trap(PB≤0.8∧三項惡化)'], '避雷用:負邊際才是「成立」;倖存者偏誤讓它被低估');
plateau('⛰️ 高原 A:PB ≤ {0.3,0.5,0.8,1.0} × ROE > {10,15,20,30}(16 格,對照 BASE@V)', 'BASE@V', PL.pb.flatMap(tp => PL.roe.map(tr => `PL:asset pb≤${tp}∧roe>${tr}`)));
plateau('⛰️ 高原 B:連續 ≥ {1,2,3,4} 季(對照 BASE@V)', 'BASE@V', PL.nImp.map(n => `PL:earn 連續≥${n}`));
plateau('⛰️ 高原 C:低谷 ≤ {min,25,33,50}% × {QoQ,YoY}(對照 BASE_CYC@C)', 'BASE_CYC@C', PL.pos.flatMap(ps => [`PL:cycle 低谷≤${ps}∧QoQ`, `PL:cycle 低谷≤${ps}∧YoY`]));
plateau('⛰️ 高原 T:PB≤0.8 ∧ 惡化 ≥ {1,2,3} 項(對照 REF:pb≤0.8)', 'REF:pb≤0.8', PL.nDet.map(n => `PL:trap pb≤0.8∧惡化≥${n}`));

console.log('📋 限制(⛔ 結論一律要帶著這幾條):'); for (const l of report.limits) console.log('  ・' + l);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`\n💾 ${OUT}`); }
