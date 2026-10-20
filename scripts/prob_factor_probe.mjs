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
 * 🔁 V79.4.3(16 年 d16 重跑前修,陷阱 #50 / #52):
 *   ⑦ 資料不知道 ≠ 沒有:營收加速(財報 2018 起)/ 外資投信(2012-05 起)/ 成交額門檻算不出來 → 旗標 null,
 *      那一筆**不進**這個因子的學習、驗證、方向、sham(⛔ 舊版當成「沒有」→ 沒資料的年份被算進「沒有因子」那組);
 *      因子資料比整段晚開始 → 前後半切在它自己那段的中點(照日期)
 *   ⑧ 方向那幾關改成同一天對照:每一筆先扣「同一天、這個因子知道的全部樣本」的漲% / 贏大盤%,再比同格有 vs 沒有
 *      (⛔ 16 年的半段有 8 年,事件集中在某幾年時那幾年的行情會被算成因子);那天 <30 筆 → 不進方向那幾關並計數
 *   ⑨ 跌停 / 鎖漲停走 lib_limit(2015-06 前 ±7%)・斷崖只剔碰到的窗口(lib_cliff,⛔ 不再整檔剔除)
 *
 * 用法:DATA_DIR=<合併過 klines_deep 的目錄> FIN_DEEP=<fin_deep.json> node --max-old-space-size=8192 scripts/prob_factor_probe.mjs out.json
 *      node scripts/prob_factor_probe.mjs --selftest
 *      LIMIT=N 只跑前 N 檔(冒煙測試用)
 */
import fs from 'fs';
import path from 'path';
import { N_CELLS, featuresAt, labelOf, outcomeAt, rowOf } from './lib_prob.mjs';
import { finSeries, finOnAt } from './lib_finaccel.mjs';
import { upLimitClose, limitFlag } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

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
const MIN_CTRL = 30;     // 🔁 V79.4.3 同一天對照組少於這麼多筆 → 那天的樣本不進方向那幾關(⛔ 不拿別天湊)
const FEAT_BACK = 268;   // 🔁 V79.4.3 featuresAt 最遠讀到 i−268(位階 250 根 + 振幅百分位再往回 19 根)→ 斷崖窗口的左端

// 🔁 V79.4.3 訊號日收盤停在漲停價 → 尾盤買不到(lib_limit,2015-06 前 ±7%)。
//   lib_prob.outcomeAt 自己只擋 ×1.095(2015 後跟這條同一個門檻),2010~2015 那五年要在這裡先擋
export const outcomeAtL = (R, i, h) => (i > 0 && upLimitClose(R[i].d, R[i].c, R[i - 1].c)) ? null : outcomeAt(R, i, h);

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
// 🔁 V79.4.3 「昨天跌停」走 lib_limit:2015-06 前 ≤ −6.2%、之後 ≤ −9.2%(之後跟舊版一樣;舊版寫死 −9.2% → 2010~2015 一筆都不會亮)
export const ldredAt = (R, i) => i >= 2 && R[i - 2].c > 0 && R[i - 1].c > 0 && limitFlag(R[i - 1].d, (R[i - 1].c / R[i - 2].c - 1) * 100, 0.8) === -1 && R[i].c > R[i - 1].c;
export function retestAt(R, i) {
    if (i < 66) return false;
    let nh = -Infinity; for (let q = i - 65; q < i - 5; q++) if (R[q].c > nh) nh = R[q].c;
    let made = false, lo = Infinity;
    for (let q = i - 5; q < i; q++) { if (R[q].c >= nh) made = true; if (R[q].l < lo) lo = R[q].l; }
    return made && lo >= nh * 0.95 && R[i].c > R[i - 1].c && R[i].c >= nh * 0.98;
}
// 🔁 V79.4.3 法人欄位缺(d16 2012-05-02 前全部缺)= 不知道 → null(⛔ 不可當成「沒有買」);
//   知道的那幾天已經足以判 false / true 就照判(例:有一天外資賣 → false)
export function syncAt(R, i) {
    if (i < 5) return false;
    let unk = false;
    for (let q = i - 4; q <= i; q++) { const v = R[q].fn; if (v == null || !Number.isFinite(v)) unk = true; else if (!(v > 0)) return false; }
    let tUnk = false;
    for (let q = i - 2; q <= i; q++) { const v = R[q].tn; if (v == null || !Number.isFinite(v)) tUnk = true; else if (v > 0) return unk ? null : true; }
    return unk || tUnk ? null : false;
}
export function amt20At(R, i) {
    if (i < 19) return null;
    let s = 0; for (let q = i - 19; q <= i; q++) s += R[q].c * R[q].v;
    return s / 20;
}
const hash01 = (str, seed) => { let h = 2166136261 ^ seed; for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000003) / 1000003; };

/**
 * 🔁 V79.4.3 同一天對照:日期 → [n, 漲的筆數, n贏大盤, 贏的筆數],只收「這個天期有結果、而且這個因子知道」的樣本
 * (sham 的旗標只在真因子知道的那幾筆才有值 → 同一份)
 */
export function dayMeans(S, getFlag, hi) {
    const M = new Map();
    for (const s of S) {
        const o = s.h[hi]; if (!o || getFlag(s) == null) continue;
        let a = M.get(s.d); if (!a) { a = [0, 0, 0, 0]; M.set(s.d, a); }
        a[0]++; if (o.lab === 0) a[1]++; if (o.beat != null) { a[2]++; if (o.beat) a[3]++; }
    }
    return M;
}

/**
 * 評估一個旗標:回 { dBrier, dBeatBrier, lift:{h1,h2}, liftBeat, yrs:{y:lift}, n } —— 給 selftest 用合成樣本測
 * S = { d:'YYYY-MM-DD', cell:Int, h:[{lab,beat}] per HZ, flag:bool|null, half:0|1, yr:'YYYY' }[]
 * 🔁 V79.4.3 getFlag 回 null = 不知道 → 那一筆學習 / 驗證 / 方向全部不收(⛔ 不當成「沒有」)
 *    opt.halfOf(s) 換前後半(因子自己那段的中點)、opt.dayMean 預先算好的同一天對照、opt.minCtrl
 */
export function evalFlag(S, getFlag, hi, learnHalf, opt = {}) {
    const testHalf = 1 - learnHalf;
    const halfOf = opt.halfOf || (s => s.half);
    const minCtrl = opt.minCtrl ?? MIN_CTRL;
    const DM = opt.dayMean || dayMeans(S, getFlag, hi);
    const C = new Map();   // key → [n, up, flat, dn, beatN, beat]
    const add = (key, s) => { let a = C.get(key); if (!a) { a = [0, 0, 0, 0, 0, 0]; C.set(key, a); } const o = s.h[hi]; a[0]++; a[1 + o.lab]++; if (o.beat != null) { a[4]++; if (o.beat) a[5]++; } };
    for (const s of S) { if (halfOf(s) !== learnHalf || !s.h[hi]) continue; const f = getFlag(s); if (f == null) continue; add('c' + s.cell, s); add('c' + s.cell + (f ? '+' : '-'), s); }
    const probs = a => a && a[0] ? [a[1] / a[0], a[2] / a[0], a[3] / a[0], a[4] ? a[5] / a[4] : null] : null;
    let bB = 0, bA = 0, kB = 0, kA = 0, n = 0, nb = 0, nThin = 0;
    const lifts = {}, yl = {};   // 測試段:格+有無 → [n, Σ(漲 − 同一天漲%), n贏大盤, Σ(贏 − 同一天贏%)]
    for (const s of S) {
        if (halfOf(s) !== testHalf || !s.h[hi]) continue;
        const f = getFlag(s); if (f == null) continue;
        const pc = probs(C.get('c' + s.cell)); if (!pc) continue;
        const sub = C.get('c' + s.cell + (f ? '+' : '-'));
        const pa = (sub && sub[0] >= MIN_SUB) ? probs(sub) : pc;
        const o = s.h[hi];
        for (let k = 0; k < 3; k++) { const y = o.lab === k ? 1 : 0; bB += (pc[k] - y) ** 2; bA += (pa[k] - y) ** 2; }
        n++;
        if (o.beat != null && pc[3] != null) { const y = o.beat ? 1 : 0; kB += (pc[3] - y) ** 2; kA += ((pa[3] ?? pc[3]) - y) ** 2; nb++; }
        // ⭐ 方向:**同一段時間、同一格**裡,有因子 vs 沒因子(⛔ 不拿學習段的格機率當對照 ——
        //    兩段時間大盤不同,那樣量到的是「後半段比較好賺」不是因子;第一版就是這樣量出整排 −x / +y)
        // 🔁 V79.4.3 再往下一層:每一筆先扣「同一天」的漲% / 贏大盤%(16 年的半段有 8 年,事件擠在某幾年時那幾年的行情不會被算成因子)
        const dm = DM.get(s.d);
        if (!dm || dm[0] < minCtrl) { nThin++; continue; }
        const up = (o.lab === 0 ? 1 : 0) - dm[1] / dm[0];
        const kk = s.cell + (f ? '+' : '-');
        const W = lifts[kk] || (lifts[kk] = [0, 0, 0, 0]); W[0]++; W[1] += up;
        if (o.beat != null && dm[2] >= minCtrl) { W[2]++; W[3] += (o.beat ? 1 : 0) - dm[3] / dm[2]; }
        const yk = s.yr + '|' + kk; const Y = yl[yk] || (yl[yk] = [0, 0]); Y[0]++; Y[1] += up;
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
        n, nOn: L.n, nThin,
        dBrier: n ? (bA - bB) / n : 0, rel: bB ? (bA - bB) / bB * 100 : 0,
        dBeat: nb ? (kA - kB) / nb : 0,
        liftUp: L.up, liftBeat: L.beat, yrs,
    };
}

/** 一個因子在一個天期的總判定 */
//   🔁 V79.4.3 opt.split = 這個因子自己的前後半切點(資料比整段晚開始時);rate = 觸發數 ÷ **知道的**筆數;
//   sham 只在真因子知道的那幾筆亂標(不知道的那幾筆一樣是 null)→ 對照的是同一批樣本
export function judge(S, fk, rate, hi, opt = {}) {
    const getReal = s => s.f[fk];
    const o2 = { halfOf: opt.split ? (s => s.d < opt.split ? 0 : 1) : null, dayMean: dayMeans(S, getReal, hi), minCtrl: opt.minCtrl };
    const real = [0, 1].map(lh => evalFlag(S, getReal, hi, lh, o2));
    const shams = [];
    for (let k = 0; k < N_SHAM; k++) shams.push([0, 1].map(lh => evalFlag(S, s => s.f[fk] == null ? null : hash01(s.id, 7919 * (k + 1) + fk.length) < rate, hi, lh, o2)));
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
    return { real, dReal, dSham, gates, pass: Object.values(gates).every(Boolean), yrOk, yrN: ys.length, nThin: real[0].nThin + real[1].nThin };
}

/**
 * 🔁 V79.4.3 因子資料比整段晚開始(第一個「知道」的日子 > 第一個樣本的日子)→ 前後半切在它自己那段交易日的中點(照日期);
 *   否則回 null = 用整段的切點(全期都有資料的因子跟舊版一模一樣)
 */
export function factorSplit(S, fk, dates) {
    let first = '9999', firstS = '9999';
    for (const s of S) { if (s.d < firstS) firstS = s.d; if (s.f[fk] != null && s.d < first) first = s.d; }
    if (first === '9999' || first <= firstS) return null;
    const ds = dates.filter(d => d >= first);
    return ds.length ? ds[Math.floor(ds.length / 2)] : null;
}

// 🔁 V79.4.3 一檔 K 線 → R(⛔ 不再因為一次斷崖就整檔丟掉;R.pre = 斷崖前綴和,只剔碰到斷崖的窗口)
export function rowsToR(d) {
    if (!Array.isArray(d) || d.length < 300) return null;
    const R = d.map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +(r.volume || 0), fn: r.foreign_net == null ? null : +r.foreign_net, tn: r.trust_net == null ? null : +r.trust_net }));
    if (!R.every(r => r.c > 0 && r.o > 0 && r.h > 0 && r.l > 0)) return null;
    R.pre = cliffPrefix(R.map(r => r.c), R.map(r => r.o));
    return R;
}

/**
 * 一檔 → 樣本(🔁 V79.4.3 從主程式抽出來:selftest 走同一條)。ctx = { MKT, mktRet, AMT_TH, fs_, SPLIT }
 * ⛔ 特徵窗口(i−268 ~ i)碰到斷崖 → 這一根不收;天期 hz 的結果窗口(i ~ i+hz)碰到斷崖 → 那個天期 null
 * onAmt1(cell, o, mr) = 成交額前 100 那一組「明天」的一列(給 _PROB_TABLE 的 schema)
 */
export function sampleStock(sym, R, ctx, onAmt1) {
    const { MKT, mktRet, AMT_TH, fs_, SPLIT } = ctx;
    const out = []; let nFinNull = 0, nCliff = 0;
    for (let i = 250; i < R.length - 21; i++) {
        const d = R[i].d, mk = MKT.get(d); if (mk == null) continue;
        if (R.pre && cliffIn(R.pre, i - FEAT_BACK, i)) { nCliff++; continue; }
        const f = featuresAt(R, i, mk); if (!f) continue;
        const h = HZ.map(hz => { if (R.pre && cliffIn(R.pre, i, i + hz)) return null; const o = outcomeAtL(R, i, hz); if (!o) return null; const mr = mktRet(d, hz); return { lab: labelOf(o.ret), beat: mr == null ? null : o.ret - mr > 0 }; });
        if (!h[0] && !h[2]) continue;
        const fin = fs_ ? finOnAt(fs_, d) : null; if (fin == null) nFinNull++;
        const a = amt20At(R, i), th = AMT_TH.get(d);
        if (onAmt1 && th != null && a >= th) {
            const o = (R.pre && cliffIn(R.pre, i, i + 1)) ? null : outcomeAtL(R, i, 1);
            if (o) onAmt1(f.cell, o, mktRet(d, 1));
        }
        out.push({ id: sym + d, d, cell: f.cell, half: d < SPLIT ? 0 : 1, yr: d.slice(0, 4), h, f: {
            acc: fin == null ? null : fin === true, sync: syncAt(R, i), amt: th == null ? null : a >= th, tri: triAt(R, i), ldred: ldredAt(R, i), retest: retestAt(R, i),
        } });
    }
    return { out, nFinNull, nCliff };
}

// ────────────────────────────── selftest ──────────────────────────────
if (process.argv.includes('--selftest')) {
    let bad = 0;
    const ok = (nm, c, x = '') => { if (!c) bad++; console.log(`${c ? '✅' : '❌'} ${nm}${c ? '' : '  → ' + JSON.stringify(x)}`); };
    // 合成樣本:每格基準漲 35%;因子 10% 觸發,觸發時漲 60%(前後半都一樣)
    // 🔁 V79.4.3 每一筆帶日期(400 天 × 150 筆;同一天的樣本在同一半)—— 方向那幾關要扣同一天的平均
    const dayStr = k => new Date(Date.UTC(2023, 0, 2) + k * 864e5).toISOString().slice(0, 10);
    const mkS = (lift, seed, o = {}) => {
        const S = []; let r = seed;
        const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
        const per = o.per || 150, nDay = o.nDay || 400;
        for (let i = 0; i < per * nDay; i++) {
            const day = Math.floor(i / per), d = dayStr(day);
            let f = rnd() < (o.rate ? o.rate(day) : 0.1);
            let p = (o.base ? o.base(day) : 0.35) + (f ? lift : 0);
            if (o.unk && o.unk(day, i)) { f = null; p = o.unkP ?? p; }
            const u = rnd(), lab = u < p ? 0 : (u < p + 0.3 ? 1 : 2);
            S.push({ id: 's' + i, d, cell: i % 8, half: o.half ? o.half(day) : day % 2, yr: String(2023 + (day % 3)), f: { x: f }, h: [{ lab, beat: lab === 0 }] });
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
    // ⑥ 🔁 V79.4.3 不知道 ≠ 沒有:每天一半的樣本旗標不知道(而且那一半本來就比較不會漲),知道的那一半有沒有因子都一樣
    //    → 正式路徑 ≈ 0;同一批資料把不知道當成「沒有」→ 憑空 +15pp(舊版就是這樣)
    {
        const S = mkS(0, 6, { unk: (day, i) => Math.floor(i / 8) % 2 === 1, unkP: 0.2, base: () => 0.5 });   // ⚠️ 不知道的要散在每一格(i % 2 會剛好等於奇數格 → 格內比較看不到)
        const nKnown = S.filter(s => s.f.x != null).length, rate = S.filter(s => s.f.x).length / nKnown;
        const J = judge(S, 'x', rate, 0);
        const old = [0, 1].map(lh => evalFlag(S, s => s.f.x === true, 0, lh).liftUp);
        ok(`⑥ 不知道的那一半不收:有 vs 沒有 ≈ 0(${J.real.map(x => x.liftUp.toFixed(1)).join(' / ')}pp)、判定不通過`, !J.pass && J.real.every(x => Math.abs(x.liftUp) < 3), J.real.map(x => x.liftUp));
        ok(`⑥b 決定性對照:同一批把「不知道」當「沒有」→ 憑空 ${old.map(v => v.toFixed(1)).join(' / ')}pp`, old.every(v => v > 10), old);
    }
    // ⑦ 🔁 V79.4.3 同一天對照:因子只在「大家都漲的日子」出現(每 4 天一次大漲日:人人 70% 漲,其他日子 30%),同一天裡有沒有因子都一樣
    //    → 正式路徑 ≈ 0;同一批改成「同一段時間的平均」當對照(舊版)→ 憑空 +25pp 以上
    {
        const good = day => Math.floor(day / 2) % 4 === 0;   // ⚠️ 大漲日要兩半都有(day % 4 會全部落在偶數天 = 同一半)
        const S = mkS(0, 7, { base: day => good(day) ? 0.7 : 0.3, rate: day => good(day) ? 0.3 : 0.02 });
        const rate = S.filter(s => s.f.x).length / S.length;
        const J = judge(S, 'x', rate, 0);
        const flat = new Map(); for (const s of S) if (!flat.has(s.d)) flat.set(s.d, [1e9, 0, 1e9, 0]);   // 每天同一個常數 = 不扣同一天(舊版)
        const old = [0, 1].map(lh => evalFlag(S, s => s.f.x, 0, lh, { dayMean: flat }).liftUp);
        ok(`⑦ 因子擠在大漲日:同一天比 ≈ 0(${J.real.map(x => x.liftUp.toFixed(1)).join(' / ')}pp)、判定不通過`, !J.pass && J.real.every(x => Math.abs(x.liftUp) < 3), J.real.map(x => x.liftUp));
        ok(`⑦b 決定性對照:同一批只比同一段時間 → 憑空 ${old.map(v => v.toFixed(1)).join(' / ')}pp`, old.every(v => v > 20), old);
    }
    // ⑧ 同一天的樣本不到 MIN_CTRL 筆 → 那天不進方向那幾關並計數(⛔ 不拿別天湊)
    {
        const thin = judge(mkS(0.25, 8, { per: 20, nDay: 3000 }), 'x', 0.1, 0), S40 = mkS(0.25, 8, { per: 40, nDay: 1500 }), fat = judge(S40, 'x', 0.1, 0);
        const upR = a => a.filter(s => s.h[0].lab === 0).length / a.length * 100, raw = upR(S40.filter(s => s.f.x)) - upR(S40.filter(s => !s.f.x));   // 這組亂數實際的差(注入 +25,連續兩個亂數有一點相關 → 約 +21.6)
        ok(`⑧ 一天只有 20 筆(<${MIN_CTRL}):方向那幾關 0 筆、剔除 ${thin.nThin}`, thin.nThin > 0 && thin.real.every(x => x.nOn === 0 && x.liftUp === 0), thin.real.map(x => [x.nOn, x.liftUp]));
        ok(`⑧b 一天 40 筆 → 方向照算(量到 ${fat.real.map(x => x.liftUp.toFixed(1)).join(' / ')} ≈ 這組資料實際的 +${raw.toFixed(1)})`, fat.nThin === 0 && fat.real.every(x => Math.abs(x.liftUp - raw) < 2), { lift: fat.real.map(x => x.liftUp), raw });
    }
    // ⑨ 因子資料比整段晚開始(後半段才有)→ 前後半切在它自己那段的中點;用整段的切點 → 學習段 0 筆、白測
    {
        const S = mkS(0.25, 9, { half: day => day < 200 ? 0 : 1, unk: day => day < 200 });
        const rate = S.filter(s => s.f.x).length / S.filter(s => s.f.x != null).length;
        const dates = [...new Set(S.map(s => s.d))].sort(), sp = factorSplit(S, 'x', dates);
        const own = judge(S, 'x', rate, 0, { split: sp }), glob = judge(S, 'x', rate, 0);
        ok(`⑨ 切點 = 它自己那段(第 200~399 天)的中點 ${sp}(整段是 ${dates[200]})`, sp === dates[300], sp);
        ok('⑨b 用它自己的切點 → 真的有效的因子判得出來;用整段切點 → 學習段 0 筆、判不出來', own.pass && !glob.pass && glob.real.some(x => x.n === 0), { own: own.gates, glob: glob.real.map(x => x.n) });
        ok('⑨c 全期都知道的因子 → 不另切(null,跟舊版一模一樣)', factorSplit(mkS(0, 10), 'x', dates) === null);
    }
    // ⑩ 🔁 V79.4.3 漲跌停走 lib_limit:2012(±7%)昨天 −6.5% = 跌停;同一根放 2020 不是;2020 −9.3% 才是
    {
        const mkR = (y, c1) => [{ d: `${y}-03-01`, c: 100 }, { d: `${y}-03-02`, c: c1 }, { d: `${y}-03-05`, c: c1 * 1.01 }];
        ok('⑩ 跌停後收紅:2012 −6.5% 算、2020 −6.5% 不算、2020 −9.3% 算', ldredAt(mkR(2012, 93.5), 2) === true && ldredAt(mkR(2020, 93.5), 2) === false && ldredAt(mkR(2020, 90.7), 2) === true);
        const up = (y, c1) => { const R = [{ d: `${y}-03-01`, o: 100, h: 100, l: 100, c: 100 }, { d: `${y}-03-02`, o: c1, h: c1, l: c1, c: c1 }, { d: `${y}-03-05`, o: c1, h: c1 + 1, l: c1 - 1, c: c1 }]; return outcomeAtL(R, 1, 1); };
        ok('⑩b 訊號日收在漲停價 → 尾盤買不到:2012 +6.8% → null、2020 +6.8% 照算、2020 +9.6% → null', up(2012, 106.8) === null && up(2020, 106.8) !== null && up(2020, 109.6) === null);
    }
    // ⑪ 🔁 V79.4.3 斷崖只剔碰到的窗口:×2 那一檔照樣讀得進來;特徵窗口(往回 268 根)或結果窗口碰到斷崖的才不收
    {
        const rows = []; let px = 50, r = 11;
        const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
        for (let k = 0; k < 1000; k++) {
            px *= 1 + (rnd() - 0.5) * 0.03; if (k === 400) px *= 2;
            const d = new Date(Date.UTC(2020, 0, 1) + k * 864e5).toISOString().slice(0, 10);
            rows.push({ date: d.replace(/-/g, '/'), open: px * (1 + (rnd() - 0.5) * 0.004), high: px * 1.02, low: px * 0.98, close: px, volume: 1000 });
        }
        const R = rowsToR(rows);
        ok('⑪ 有一次 ×2 斷崖的那一檔照樣讀得進來(⛔ 不整檔剔除)', !!R && R.pre[R.length] === 1);
        if (!R) ok('⑪b 讀不進來就沒有東西可以驗', false); else {
        const MKT = new Map(R.map(x => [x.d, 0])), ix = new Map(R.map((x, k) => [x.d, k]));
        const res = sampleStock('9999', R, { MKT, mktRet: () => 0, AMT_TH: new Map(), fs_: null, SPLIT: R[700].d });
        const at = res.out.map(s => [ix.get(s.d), s]);
        const inFeat = at.filter(([k]) => k >= 400 && k <= 400 + FEAT_BACK - 1);
        const spanBad = at.filter(([k, s]) => k < 400 && HZ.some((hz, j) => k + hz >= 400 && s.h[j] != null));
        const keptBefore = at.some(([k, s]) => k < 380 && s.h[2] != null), keptAfter = at.some(([k]) => k >= 400 + FEAT_BACK), oneDay = at.some(([k, s]) => k >= 381 && k <= 398 && s.h[0] != null && s.h[2] == null);
        ok(`⑪b 特徵窗口碰到斷崖 0 筆收進來(剔 ${res.nCliff})・結果窗口跨過斷崖的天期全是 null(違規 ${spanBad.length})・前後照收`, !inFeat.length && res.nCliff === FEAT_BACK && !spanBad.length && keptBefore && keptAfter && oneDay, { inFeat: inFeat.length, nCliff: res.nCliff, spanBad: spanBad.length, keptBefore, keptAfter, oneDay });
        }
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
if (!FD) console.log('⚠️ 沒有 FIN_DEEP → 營收加速那一項全部「不知道」→ 那個因子不評(🔁 V79.4.3 ⛔ 不當成「沒有」)');

const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const syms = (LIMIT ? files.slice(0, LIMIT) : files).map(f => f.replace('.json', ''));
// 🔁 V79.4.3 斷崖只剔碰到的窗口(rowsToR 掛 R.pre;⛔ 不再整檔剔除 —— 減過資的困難股整批不見 = 倖存者偏誤)
const load = sym => {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(DATA, sym + '.json'), 'utf8')); } catch { return null; }
    return rowsToR(d);
};

// pass 1:每天的成交額前 100 門檻
const AMT = new Map();
for (const sym of syms) {
    const R = load(sym); if (!R) continue;
    for (let i = 19; i < R.length; i++) { if (cliffIn(R.pre, i - 19, i)) continue; const a = amt20At(R, i); if (a > 0) { let arr = AMT.get(R[i].d); if (!arr) { arr = []; AMT.set(R[i].d, arr); } arr.push(a); } }   // 🔁 V79.4.3 20 日窗口碰到斷崖的不排
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
let nSym = 0, nFinNull = 0, nCliff = 0;
const onAmt1 = (cell, o, mr) => { for (const T of [AMT1[cell], AMT1B]) { T.lab[labelOf(o.ret)]++; T.ret.push(o.ret); T.mae.push(o.mae); T.mfe.push(o.mfe); if (mr != null) T.ex.push(o.ret - mr); } };
for (const sym of syms) {
    const R = load(sym); if (!R) continue;
    nSym++;
    const fs_ = FD ? finSeries(FD, sym) : null;
    const r = sampleStock(sym, R, { MKT, mktRet, AMT_TH, fs_, SPLIT }, onAmt1);
    for (const x of r.out) S.push(x);
    nFinNull += r.nFinNull; nCliff += r.nCliff;
    if (nSym % 300 === 0) process.stdout.write(`\r   ${nSym} 檔 ・${S.length.toLocaleString()} 股·日`);
}
console.log(`\r   ✅ ${nSym} 檔 ・${S.length.toLocaleString()} 股·日 ・切點 ${SPLIT} ・營收加速未知 ${nFinNull.toLocaleString()} 筆(🔁 V79.4.3 ⛔ 不當成「沒有」,評那個因子時剔除)・特徵窗口碰到斷崖剔除 ${nCliff.toLocaleString()} 根`);

const res = {};
for (const fk of FACTORS) {
    // 🔁 V79.4.3 觸發率 = 觸發 ÷ **知道的**筆數;因子資料比整段晚開始 → 前後半切在它自己那段的中點
    const nKnown = S.filter(s => s.f[fk] != null).length, nOn = S.filter(s => s.f[fk]).length, rate = nKnown ? nOn / nKnown : 0;
    const split = factorSplit(S, fk, dates);
    res[fk] = { name: FNAME[fk], nOn, nKnown, rate: +(rate * 100).toFixed(3), split: split || SPLIT, ownSplit: !!split, hz: {} };
    console.log(`   ${FNAME[fk]}:知道 ${nKnown.toLocaleString()} / ${S.length.toLocaleString()} 筆${split ? `(資料比整段晚開始 → 前後半切在 ${split})` : ''}`);
    for (let hi = 0; hi < HZ.length; hi++) {
        const J = judge(S, fk, rate, hi, { split });
        res[fk].hz[HZ[hi]] = {
            nThin: J.nThin,
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
console.log(`🔁 V79.4.3 方向那幾關 = 每一筆先扣同一天的漲% / 贏大盤% 再比同格有 vs 沒有;那天 <${MIN_CTRL} 筆 → 不進方向:${FACTORS.map(fk => `${FNAME[fk]} ${HZ.map(h => res[fk].hz[h].nThin).join('/')}`).join(' ・')}`);
const out = { amt1, amt1Base: rowOf(AMT1B), src: 'scripts/prob_factor_probe.mjs', built: new Date().toISOString().slice(0, 10), syms: nSym, samples: S.length, split: SPLIT, win: [dates[0], dates.at(-1)], hz: HZ, minSub: MIN_SUB, nSham: N_SHAM, finNull: nFinNull, cliffSkip: nCliff, ctrl: 'same-day', minCtrl: MIN_CTRL, res };
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log(`\n💾 ${OUT}`); }
console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
