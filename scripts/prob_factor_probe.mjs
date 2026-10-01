#!/usr/bin/env node
/**
 * 📊🧪 機率表能不能更準?—— 在 72 格之上再加一個因子,**樣本外**機率有沒有變準(V78.1.1)
 *
 * 使用者:「新增預判上漲下跌的機率,你現在已經有回測出來的東西,另外還有還沒回測提高準確度的東西嗎?」
 *
 * ⭐ 現行 `_PROB_TABLE` = 72 格(位階 4 × 振幅 3 × 創新高 3 × 大盤 2)的歷史頻率(`lib_prob.mjs`)。
 *    這支只問一件事:**把一個「別的探針已經證明有東西」的因子切進每一格,後半段的機率有沒有比較準?**
 *    ⛔ 不是問「這個因子會不會賺」(那是各自探針的事),是問「它能不能讓機率更準」。
 *
 * 候選 6 個(定義全部照抄來源,⛔ 不另發明):
 *   acc   營收年增加速         ← lib_finaccel.finOnAt(accel_probe 六關全過)
 *   sync  外資連買 5 天 ∧ 投信 3 日內有買 ← fstreak_probe ②(六關全過)
 *   amt   近 20 日平均成交額全市場前 100(不含 ETF)← kingpool / leader 池子
 *   tri   下降三角(避雷)      ← index.html _descTriangle(N=20、k=0.05、flat=0.5)
 *   ldred 昨天跌停、今天收紅    ← index.html _ldRedKHtml(≤ −9.2% → > 0)
 *   retest 創 60 日高後回測不破 ← streak_probe ⑨
 *
 * 方法(⛔ 少一個都會誤導):
 *   ① 口徑 = lib_prob.outcomeAt(今收買 → h 天後收盤;鎖漲停剔除;平盤帶 ±0.44%)—— 跟 `_PROB_TABLE` 同一把尺
 *   ② 前半學、後半驗(再反過來一次):基準 = 只用 72 格;加強 = 72 格 × 因子有/無(子格 < MIN_SUB 筆退回 72 格)
 *   ③ 準不準 = Brier 分數(三類:漲/平/跌)與「贏大盤」的 Brier;越小越準
 *   ④ 安慰劑 sham:同一個觸發率、隨機亂標 5 次 —— 加強必須比 **5 次 sham 都好**(⛔ 子格變多本身就會讓訓練段變準)
 *   ⑤ 方向要穩:因子觸發時「漲%」相對同格的差,前後半同號、逐年多數同號
 *   ⑥ 零前視:所有因子只看到第 i 根為止(selftest 會改 i+1 之後的資料確認旗標不變)
 *
 * 用法:DATA_DIR=<合併過 klines_deep 的目錄> FIN_DEEP=<fin_deep.json> node --max-old-space-size=8192 scripts/prob_factor_probe.mjs out.json
 *      node scripts/prob_factor_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { N_CELLS, featuresAt, labelOf, outcomeAt, rowOf } from './lib_prob.mjs';
import { finSeries, finOnAt } from './lib_finaccel.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const FIN_DEEP = process.env.FIN_DEEP || '';
const OUT = process.argv.find(a => a.endsWith('.json')) || null;
const LIMIT = +(process.env.LIMIT || 0);
const HZ = [1, 5, 20];
const MIN_SUB = +(process.env.MIN_SUB || 100);
const FACTORS = ['acc', 'sync', 'amt', 'tri', 'ldred', 'retest'];
const FNAME = {
    acc: '📦 營收年增加速', sync: '🏦👩 外資連買∧投信同步', amt: '💰 成交額前 100',
    tri: '📐 下降三角', ldred: '🕯️ 跌停後收紅', retest: '🏔️ 創高回測不破',
};
const N_SHAM = 5;

// ── 因子定義(只吃到 i 為止) ──
export function triAt(R, i) {
    const N = 20, k = 0.05, flatK = 0.5;
    if (i < N + 22) return false;
    let trs = 0, trc = 0;
    for (let q = i - 20; q < i; q++) {
        if (!(R[q - 1].c > 0 && R[q].h >= R[q].l && R[q].l > 0)) continue;
        trs += Math.max(R[q].h - R[q].l, Math.abs(R[q].h - R[q - 1].c), Math.abs(R[q].l - R[q - 1].c)); trc++;
    }
    if (trc < 16) return false;
    const atr = trs / trc; if (!(atr > 0)) return false;
    let sx = 0, sy = 0, sxy = 0, sxx = 0; const ls = [];
    for (let j = 0; j < N; j++) { const q = i - N + 1 + j; sx += j; sy += R[q].h; sxy += j * R[q].h; sxx += j * j; ls.push(R[q].l); }
    const slope = (N * sxy - sx * sy) / (N * sxx - sx * sx);
    ls.sort((a, b) => a - b);
    return slope <= -k * atr && (ls[2] - ls[0]) <= flatK * atr;
}
export const ldredAt = (R, i) => i >= 2 && R[i - 2].c > 0 && R[i - 1].c > 0 && (R[i - 1].c / R[i - 2].c - 1) * 100 <= -9.2 && R[i].c > R[i - 1].c;
export function retestAt(R, i) {
    if (i < 66) return false;
    let nh = -Infinity; for (let q = i - 65; q < i - 5; q++) if (R[q].c > nh) nh = R[q].c;
    let made = false, lo = Infinity;
    for (let q = i - 5; q < i; q++) { if (R[q].c >= nh) made = true; if (R[q].l < lo) lo = R[q].l; }
    return made && lo >= nh * 0.95 && R[i].c > R[i - 1].c && R[i].c >= nh * 0.98;
}
export function syncAt(R, i) {
    if (i < 5) return false;
    for (let q = i - 4; q <= i; q++) if (!(R[q].fn > 0)) return false;
    for (let q = i - 2; q <= i; q++) if (R[q].tn > 0) return true;
    return false;
}
export function amt20At(R, i) {
    if (i < 19) return null;
    let s = 0; for (let q = i - 19; q <= i; q++) s += R[q].c * R[q].v;
    return s / 20;
}
const hash01 = (str, seed) => { let h = 2166136261 ^ seed; for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000003) / 1000003; };

/**
 * 評估一個旗標:回 { dBrier, dBeatBrier, lift:{h1,h2}, liftBeat, yrs:{y:lift}, n } —— 給 selftest 用合成樣本測
 * S = { cell:Int, h:[{lab,beat}] per HZ, flag:bool, half:0|1, yr:'YYYY' }[]
 */
export function evalFlag(S, getFlag, hi, learnHalf) {
    const testHalf = 1 - learnHalf;
    const C = new Map();   // key → [n, up, flat, dn, beatN, beat]
    const add = (key, s) => { let a = C.get(key); if (!a) { a = [0, 0, 0, 0, 0, 0]; C.set(key, a); } const o = s.h[hi]; a[0]++; a[1 + o.lab]++; if (o.beat != null) { a[4]++; if (o.beat) a[5]++; } };
    for (const s of S) { if (s.half !== learnHalf || !s.h[hi]) continue; add('c' + s.cell, s); add('c' + s.cell + (getFlag(s) ? '+' : '-'), s); }
    const probs = a => a && a[0] ? [a[1] / a[0], a[2] / a[0], a[3] / a[0], a[4] ? a[5] / a[4] : null] : null;
    let bB = 0, bA = 0, kB = 0, kA = 0, n = 0, nb = 0;
    const lifts = {}, yl = {};   // 測試段:格+有無 → [n, 漲, n贏大盤, 贏]
    for (const s of S) {
        if (s.half !== testHalf || !s.h[hi]) continue;
        const pc = probs(C.get('c' + s.cell)); if (!pc) continue;
        const f = getFlag(s);
        const sub = C.get('c' + s.cell + (f ? '+' : '-'));
        const pa = (sub && sub[0] >= MIN_SUB) ? probs(sub) : pc;
        const o = s.h[hi];
        for (let k = 0; k < 3; k++) { const y = o.lab === k ? 1 : 0; bB += (pc[k] - y) ** 2; bA += (pa[k] - y) ** 2; }
        n++;
        if (o.beat != null && pc[3] != null) { const y = o.beat ? 1 : 0; kB += (pc[3] - y) ** 2; kA += ((pa[3] ?? pc[3]) - y) ** 2; nb++; }
        // ⭐ 方向:**同一段時間、同一格**裡,有因子 vs 沒因子(⛔ 不拿學習段的格機率當對照 ——
        //    兩段時間大盤不同,那樣量到的是「後半段比較好賺」不是因子;第一版就是這樣量出整排 −x / +y)
        const kk = s.cell + (f ? '+' : '-');
        const W = lifts[kk] || (lifts[kk] = [0, 0, 0, 0]); W[0]++; if (o.lab === 0) W[1]++; if (o.beat != null) { W[2]++; if (o.beat) W[3]++; }
        const yk = s.yr + '|' + kk; const Y = yl[yk] || (yl[yk] = [0, 0]); Y[0]++; if (o.lab === 0) Y[1]++;
    }
    // 加權(權重 = 該格觸發的筆數)的同格差
    const within = (get, keyOf) => {
        let w = 0, sUp = 0, sB = 0, wb = 0;
        for (let c = 0; c < N_CELLS; c++) {
            const on = get(keyOf(c, '+')), off = get(keyOf(c, '-'));
            if (!on || !off || on[0] < 5 || off[0] < 30) continue;
            w += on[0]; sUp += on[0] * (on[1] / on[0] - off[1] / off[0]);
            if (on.length > 2 && on[2] >= 5 && off[2] >= 30) { wb += on[0]; sB += on[0] * (on[3] / on[2] - off[3] / off[2]); }
        }
        return { n: w, up: w ? sUp / w * 100 : 0, beat: wb ? sB / wb * 100 : 0 };
    };
    const L = within(k => lifts[k], (c, sg) => c + sg);
    const years = [...new Set(Object.keys(yl).map(k => k.split('|')[0]))];
    const yrs = {};
    for (const y of years) { const r = within(k => yl[k], (c, sg) => y + '|' + c + sg); if (r.n >= 30) yrs[y] = +r.up.toFixed(1); }
    return {
        n, nOn: L.n,
        dBrier: n ? (bA - bB) / n : 0, rel: bB ? (bA - bB) / bB * 100 : 0,
        dBeat: nb ? (kA - kB) / nb : 0,
        liftUp: L.up, liftBeat: L.beat, yrs,
    };
}

/** 一個因子在一個天期的總判定 */
export function judge(S, fk, rate, hi) {
    const real = [0, 1].map(lh => evalFlag(S, s => s.f[fk], hi, lh));
    const shams = [];
    for (let k = 0; k < N_SHAM; k++) shams.push([0, 1].map(lh => evalFlag(S, s => hash01(s.id, 7919 * (k + 1) + fk.length) < rate, hi, lh)));
    const dReal = (real[0].dBrier + real[1].dBrier) / 2;
    const dSham = shams.map(x => (x[0].dBrier + x[1].dBrier) / 2);
    const sameSign = Math.sign(real[0].liftUp) === Math.sign(real[1].liftUp) && real[0].liftUp !== 0;
    const ys = Object.values(Object.assign({}, real[0].yrs, real[1].yrs));
    const sg = Math.sign(real[0].liftUp + real[1].liftUp);
    const yrOk = ys.length ? ys.filter(v => Math.sign(v) === sg).length : 0;
    const gates = {
        betterThanAllSham: dReal < Math.min(...dSham),
        oosBetter: real[0].dBrier < 0 && real[1].dBrier < 0,
        sameSign,
        years: ys.length >= 2 && yrOk >= ys.length - 1,
        size: Math.abs((real[0].liftUp + real[1].liftUp) / 2) >= 2,
    };
    return { real, dReal, dSham, gates, pass: Object.values(gates).every(Boolean), yrOk, yrN: ys.length };
}

// ────────────────────────────── selftest ──────────────────────────────
if (process.argv.includes('--selftest')) {
    let bad = 0;
    const ok = (nm, c, x = '') => { if (!c) bad++; console.log(`${c ? '✅' : '❌'} ${nm}${c ? '' : '  → ' + JSON.stringify(x)}`); };
    // 合成樣本:每格基準漲 35%;因子 10% 觸發,觸發時漲 60%(前後半都一樣)
    const mkS = (lift, seed) => {
        const S = []; let r = seed;
        const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
        for (let i = 0; i < 60000; i++) {
            const cell = i % 8, f = rnd() < 0.1, p = f ? 0.35 + lift : 0.35, u = rnd();
            const lab = u < p ? 0 : (u < p + 0.3 ? 1 : 2);
            S.push({ id: 's' + i, cell, half: (i >> 3) % 2, yr: String(2023 + (i % 3)), f: { x: f }, h: [{ lab, beat: lab === 0 }] });
        }
        return S;
    };
    {
        const J = judge(mkS(0.25, 1), 'x', 0.1, 0);
        ok('① 注入「觸發時漲 +25pp」→ 樣本外 Brier 變小、贏 5 次 sham、判定通過', J.pass && J.dReal < 0, { d: J.dReal, sham: J.dSham, g: J.gates });
        ok('①b 量到的 lift ≈ +25pp(同格、同一段時間:有 vs 沒有;±5)', Math.abs(J.real[1].liftUp - 25) < 5, J.real[1].liftUp);
    }
    {
        const J = judge(mkS(0, 2), 'x', 0.1, 0);
        ok('② 沒有效果的因子 → ⛔ 不可通過(假因子不可被當成有用)', !J.pass, J.gates);
    }
    {
        // ③ 零前視:改 i 之後的資料,旗標不變
        const R = []; for (let i = 0; i < 300; i++) R.push({ o: 100, h: 101 + Math.sin(i) , l: 99 - Math.cos(i) * 0.1, c: 100 + Math.sin(i / 3), v: 1000, fn: 1, tn: 1 });
        R[200].c = R[199].c * 0.9; R[201].c = R[200].c * 1.02;   // 跌停後收紅 @201
        const before = [triAt(R, 201), ldredAt(R, 201), retestAt(R, 201), syncAt(R, 201), amt20At(R, 201)];
        for (let q = 202; q < 300; q++) { R[q].c *= 3; R[q].h *= 3; R[q].l *= 3; R[q].v *= 9; R[q].fn = -1; R[q].tn = -1; }
        const after = [triAt(R, 201), ldredAt(R, 201), retestAt(R, 201), syncAt(R, 201), amt20At(R, 201)];
        ok('③ 零前視:改 i+1 之後的資料,六個因子的值都不變', JSON.stringify(before) === JSON.stringify(after), { before, after });
        ok('③b 跌停後收紅那一根判得出來', ldredAt(R, 201) === true && ldredAt(R, 200) === false);
    }
    {
        const R = []; for (let i = 0; i < 20; i++) R.push({ c: 10, v: 100, fn: 1, tn: 0 });
        ok('④ 外資連買 5 天但投信 3 日內沒買 → 不算同步', syncAt(R, 19) === false);
        R[18].tn = 5;
        ok('④b 投信 3 日內有買 → 同步', syncAt(R, 19) === true);
        R[16].fn = 0;
        ok('④c 中間斷一天 → 不算連買', syncAt(R, 19) === false);
    }
    {
        // ⑤ 創高回測不破:i-5..i-1 有一天創 60 日高,之後沒跌破 95%,今天收紅
        const R = []; for (let i = 0; i < 80; i++) R.push({ c: 100, h: 100.5, l: 99.5 });
        R[74].c = 110; R[74].h = 110.5; R[75].c = 108; R[76].c = 107; R[77].c = 106; R[78].c = 106; R[79].c = 108;
        for (const q of [75, 76, 77, 78, 79]) { R[q].h = R[q].c + 0.5; R[q].l = R[q].c - 0.5; }
        ok('⑤ 創高後拉回沒破 95%、今天收紅 → 回測不破', retestAt(R, 79) === true);
        R[77].l = 94;    // 舊 60 日高 = 100 → 95% = 95
        ok('⑤b 中間跌破舊高點的 95% → ⛔ 不算', retestAt(R, 79) === false);
    }
    console.log(bad ? `\n❌ PROBFACTOR_SELFTEST_FAIL ${bad} 條` : '\n✅ PROBFACTOR_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

// ────────────────────────────── 實跑 ──────────────────────────────
const norm = d => String(d).replace(/\//g, '-').slice(0, 10);
const t0 = Date.now();
const TW = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
const MKT = new Map(), TWI = new Map(), TWC = TW.map(r => +r.close);
TW.forEach((r, i) => {
    TWI.set(norm(r.date), i);
    if (i >= 200) { let s = 0; for (let q = i - 199; q <= i; q++) s += TWC[q]; MKT.set(norm(r.date), TWC[i] < s / 200 ? 1 : 0); }
});
const mktRet = (d, h) => { const i = TWI.get(d); if (i == null || i + h >= TWC.length) return null; return (TWC[i + h] - TWC[i]) / TWC[i] * 100; };
const dates = [...MKT.keys()].sort();
const SPLIT = dates[Math.floor(dates.length / 2)];
const FD = FIN_DEEP && fs.existsSync(FIN_DEEP) ? JSON.parse(fs.readFileSync(FIN_DEEP, 'utf8')) : null;
if (!FD) console.log('⚠️ 沒有 FIN_DEEP → 營收加速那一項全部當「沒有」(會在報告裡標出來)');

const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const syms = (LIMIT ? files.slice(0, LIMIT) : files).map(f => f.replace('.json', ''));
const load = sym => {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(DATA, sym + '.json'), 'utf8')); } catch { return null; }
    if (!Array.isArray(d) || d.length < 300) return null;
    const R = d.map(r => ({ d: norm(r.date), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +(r.volume || 0), fn: r.foreign_net == null ? null : +r.foreign_net, tn: r.trust_net == null ? null : +r.trust_net }));
    if (!R.every(r => r.c > 0 && r.o > 0 && r.h > 0 && r.l > 0)) return null;
    for (let q = 1; q < R.length; q++) { const rr = R[q].c / R[q - 1].c; if (rr > 1.4 || rr < 0.6) return null; }   // 斷崖剔除(同 prob_probe)
    return R;
};

// pass 1:每天的成交額前 100 門檻
const AMT = new Map();
for (const sym of syms) {
    const R = load(sym); if (!R) continue;
    for (let i = 19; i < R.length; i++) { const a = amt20At(R, i); if (a > 0) { let arr = AMT.get(R[i].d); if (!arr) { arr = []; AMT.set(R[i].d, arr); } arr.push(a); } }
}
const AMT_TH = new Map();
for (const [d, arr] of AMT) { if (arr.length < 500) continue; arr.sort((a, b) => b - a); AMT_TH.set(d, arr[Math.min(99, arr.length - 1)]); }
AMT.clear();
console.log(`💰 成交額前 100 門檻:${AMT_TH.size} 天`);

// pass 2:樣本
const S = [];
// ⭐ 過關的因子要嵌進 `_PROB_TABLE` → 同時收「成交額前 100」那一組明天(h=1)的完整一列(同 prob_probe 的 schema,rowOf 共用)
const mkAcc = () => ({ lab: [0, 0, 0], ret: [], mae: [], mfe: [], ex: [] });
const AMT1 = Array.from({ length: N_CELLS }, mkAcc), AMT1B = mkAcc();
let nSym = 0, nFinNull = 0;
for (const sym of syms) {
    const R = load(sym); if (!R) continue;
    nSym++;
    const fs_ = FD ? finSeries(FD, sym) : null;
    for (let i = 250; i < R.length - 21; i++) {
        const d = R[i].d, mk = MKT.get(d); if (mk == null) continue;
        const f = featuresAt(R, i, mk); if (!f) continue;
        const h = HZ.map(hz => { const o = outcomeAt(R, i, hz); if (!o) return null; const mr = mktRet(d, hz); return { lab: labelOf(o.ret), beat: mr == null ? null : o.ret - mr > 0 }; });
        if (!h[0] && !h[2]) continue;
        const fin = fs_ ? finOnAt(fs_, d) : null; if (fin == null) nFinNull++;
        const a = amt20At(R, i), th = AMT_TH.get(d);
        if (th != null && a >= th) {
            const o = outcomeAt(R, i, 1);
            if (o) { const mr = mktRet(d, 1); for (const T of [AMT1[f.cell], AMT1B]) { T.lab[labelOf(o.ret)]++; T.ret.push(o.ret); T.mae.push(o.mae); T.mfe.push(o.mfe); if (mr != null) T.ex.push(o.ret - mr); } }
        }
        S.push({ id: sym + d, cell: f.cell, half: d < SPLIT ? 0 : 1, yr: d.slice(0, 4), h, f: {
            acc: fin === true, sync: syncAt(R, i), amt: th != null && a >= th, tri: triAt(R, i), ldred: ldredAt(R, i), retest: retestAt(R, i),
        } });
    }
    if (nSym % 300 === 0) process.stdout.write(`\r   ${nSym} 檔 ・${S.length.toLocaleString()} 股·日`);
}
console.log(`\r   ✅ ${nSym} 檔 ・${S.length.toLocaleString()} 股·日 ・切點 ${SPLIT} ・營收加速未知 ${nFinNull.toLocaleString()} 筆(當成「沒有」)`);

const res = {};
for (const fk of FACTORS) {
    const nOn = S.filter(s => s.f[fk]).length, rate = nOn / S.length;
    res[fk] = { name: FNAME[fk], nOn, rate: +(rate * 100).toFixed(3), hz: {} };
    for (let hi = 0; hi < HZ.length; hi++) {
        const J = judge(S, fk, rate, hi);
        res[fk].hz[HZ[hi]] = {
            pass: J.pass, gates: J.gates,
            dBrier: +J.dReal.toExponential(3), dSham: J.dSham.map(x => +x.toExponential(3)),
            rel: [+J.real[0].rel.toFixed(3), +J.real[1].rel.toFixed(3)],
            liftUp: [+J.real[0].liftUp.toFixed(2), +J.real[1].liftUp.toFixed(2)],
            liftBeat: [+J.real[0].liftBeat.toFixed(2), +J.real[1].liftBeat.toFixed(2)],
            dBeat: [+J.real[0].dBeat.toExponential(3), +J.real[1].dBeat.toExponential(3)],
            nOnTest: [J.real[0].nOn, J.real[1].nOn], years: `${J.yrOk}/${J.yrN}`, yrs: Object.assign({}, J.real[0].yrs, J.real[1].yrs),
        };
    }
}
console.log('\n' + '═'.repeat(100));
console.log('因子              天期  觸發%   樣本外漲%差(前→後 / 後→前)  贏大盤%差      Brier 變化(真 vs sham 最好)   逐年   判定');
console.log('═'.repeat(100));
for (const fk of FACTORS) for (const h of HZ) {
    const r = res[fk].hz[h], g = r.gates;
    console.log(`${res[fk].name.padEnd(14)} ${String(h).padStart(3)}日 ${res[fk].rate.toFixed(2).padStart(6)}%  ${r.liftUp.map(v => (v >= 0 ? '+' : '') + v.toFixed(1)).join(' / ').padEnd(16)}  ${r.liftBeat.map(v => (v >= 0 ? '+' : '') + v.toFixed(1)).join(' / ').padEnd(14)} ${String(r.dBrier).padStart(11)} vs ${String(Math.min(...r.dSham)).padStart(11)}  ${r.years.padStart(5)}  ${r.pass ? '✅ 更準' : '⛔ ' + Object.entries(g).filter(([, v]) => !v).map(([k]) => k).join(',')}`);
}
const MIN_N = +(process.env.MIN_N || 200);
const amt1 = {}; for (let c = 0; c < N_CELLS; c++) { const r = rowOf(AMT1[c]); if (r && r[0] >= MIN_N) amt1[c] = r; }
console.log(`\n💰 成交額前 100 那一組「明天」:${Object.keys(amt1).length} 格夠樣本(≥ ${MIN_N} 筆)・整體 ${JSON.stringify(rowOf(AMT1B))}`);
const out = { amt1, amt1Base: rowOf(AMT1B), src: 'scripts/prob_factor_probe.mjs', built: new Date().toISOString().slice(0, 10), syms: nSym, samples: S.length, split: SPLIT, win: [dates[0], dates.at(-1)], hz: HZ, minSub: MIN_SUB, nSham: N_SHAM, finNull: nFinNull, res };
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log(`\n💾 ${OUT}`); }
console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
