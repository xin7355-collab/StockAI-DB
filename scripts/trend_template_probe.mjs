#!/usr/bin/env node
/**
 * 📈 BT25-A Minervini「趨勢樣板」+ RS ≥70 —— 比本站的「位階高檔」(一年位置 ≥75%)多給了什麼?
 *
 * 為什麼要測:位階高檔(index.html _SCR_CONDS `poshi`:pos252 ≥ 75)16 年已經六關全過(screener_edge_probe 20 日 +1.04pp)。
 *   外面很紅的 Minervini 趨勢樣板 + IBD 式 RS 排名,多半也是「股價在高檔、一直在漲」→ 可能只是同一件事換個說法。
 *   這支只回答一件事:**同一天**,樣板∧RS 挑出來的,比位階高檔挑出來的多賺嗎?(⛔ 只比全部股票會把位階本身的優勢算到樣板頭上)
 *
 * 定義(⛔ 只用訊號那天收盤以前的資料;均線 / 高低點 / 報酬一律用調整價 = leader_probe 的 A,除權息不會被當成下跌):
 *   ・趨勢樣板 TT:收盤 > MA50 > MA150 > MA200 ・MA200 今天 > 22 個交易日前 ・收盤 ≥ 1.30 × 252 日最低收盤 ・收盤 ≥ 0.75 × 252 日最高收盤
 *     (均線 / 高低點都用「有交易的」最近 N 根收盤;⚠️ 高低點用收盤不用盤中高低 —— 跟 pos252 同一個口徑)
 *   ・RS:0.20×r21 + 0.30×r63 + 0.20×r126 + 0.15×r189 + 0.15×r252(= leader_probe `rsScore`,⛔ 第二份)
 *     → 同一天「算得出 RS」的全部股票裡的百分位(0~100,同分取平均名次);⚠️ 排名母體不看成交額(RS 是全市場的相對強弱)
 *   ・位階高檔 P:leader_probe `pos252(S, i, raw=true)` = screener_miner pos252(原始收盤、近 252 根)→ 四捨五入到一位小數(= rd(…, 1))≥ 75
 *   ・母體 / 同一天對照:四碼普通股、至少 253 根、近 252 根沒有價格斷崖(lib_cliff;rsScore 另外擋 leader_probe 的斷崖)、
 *     那天成交額(收盤 × 量)≥ 1,000 萬(= screener_edge_probe 的 MIN_AMT)
 * 做法:訊號日收盤決定 → 隔天開盤買(一價鎖漲停 = 買不到,剔除)→ 第 H 個交易日收盤賣(H = 5 / 20 / 60,含息);窗口碰到斷崖 → 那一筆不算
 *   ① TT∧RS≥70 vs 同一天母體 ② P vs 同一天母體(① ② 同檔同訊號 H 天去重 = 本站慣例「同檔同條件去重」)
 *   ③ 同一天、⛔ 不去重(要同一天同一批才比得公平):a) TT∧RS≥70 全部 − P 全部 ・b) (TT∧RS≥70∧P) − P 全部 ・重疊比例
 *   ④ 出場變體(① 的 20 天那批進場配對):抱 20 天 vs「收盤跌破 MA50(調整價)→ 隔天開盤賣(一價鎖跌停賣不掉就再下一根)」
 * 統計(⭐ 每天先平均再檢定,lib_evgate 六關;成本 0.44;差值檢定 ③④b 兩邊付一樣的成本 → ⑤ 用 0):
 *   ⑥ 的 p:有去重且 H ≤ 20 → t(本站慣例);H > 20 或沒去重(天天重疊)→ Newey-West(lag = H−1);兩個都印出來。
 *   安慰劑 500 次:①② 同一天母體隨機挑同樣檔數 ・③ 從同一天 P 隨機挑同樣檔數 ・④b 每一筆照同樣比例隨機提早賣、哪天賣從實際觸發日的分布抽
 *     (⛔ 只拿真的會觸發的那幾筆換日子 = 偷看「之後會跌破」)。⚠️ 安慰劑只量「同一天抽樣的運氣」,⛔ 量不到日子之間的相關 → 很小的差也會落在 0 或 100,要看 Newey-West。
 *   BH:全部檢定跟 BT25 B / C(leader_rs_breadth_probe)一起校正 → 那支讀這支的輸出(A_OUT)。
 *
 * 跑法:DATA_DIR=<d16(含已下市;要有長的 ^TWII.json)> DIV=<d16>/_div16.json node --max-old-space-size=8000 scripts/trend_template_probe.mjs out.json
 *       RS_MIN=60|80|90 = RS 門檻高原(⛔ 不設 = 70);只有 ① ③ ④ 會變(② 跟 RS 無關)
 *       node scripts/trend_template_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, pos252, rsScore, rng } from './leader_probe.mjs';
import { gates, pTwo, COST } from './lib_evgate.mjs';
import { CLIFF_LO, CLIFF_HI } from './lib_cliff.mjs';
import { lockedBar } from './lib_limit.mjs';

export const HS = [5, 20, 60];
export const MIN_AMT = 1e7;          // 成交額 ≥ 1,000 萬(screener_edge_probe MIN_AMT = 0.1 億)
export const MIN_CTRL = 30;          // 同一天對照至少幾檔(screener_edge_probe MIN_CTRL)
export const RS_MIN = 70, POS_MIN = 75, HIST = 253, SHAM_N = 500;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sg = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');

// ───────────────────────── 共用工具(B / C 那支也 import)─────────────────────────
/** Newey-West 雙尾 p(重疊窗口;Bartlett 權重)—— trade_lead_probe 同一條算式(那支被 import 會跑 main,所以這裡放一份給 BT25 兩支共用) */
export function nwP(x, lag) {
    const n = x.length; if (n < 8) return 1;
    const m = mean(x), e = x.map(v => v - m);
    let s = e.reduce((a, v) => a + v * v, 0) / n;
    for (let L = 1; L <= lag; L++) { let c = 0; for (let t = L; t < n; t++) c += e[t] * e[t - L]; s += 2 * (1 - L / (lag + 1)) * c / n; }
    return pTwo(m / Math.sqrt(Math.max(s, 1e-12) / n));
}

/** 每檔(對齊日曆的 leader_probe 結構)加兩個前綴:cnt[i] = 到第 i 天有幾根、cl = 斷崖前綴(lib_cliff 門檻;跟「上一根有交易的」比,停牌後恢復也算一根) */
export function evPrep(S) {
    const n = S.C.length, cnt = new Int32Array(n), cl = new Int32Array(n + 1);
    let c = 0, pc = NaN;
    for (let i = 0; i < n; i++) {
        let m = 0;
        if (S.C[i] > 0) {
            c++;
            if (pc > 0) { const r1 = S.C[i] / pc, r2 = S.O[i] > 0 ? S.O[i] / pc : 1; if (!(r1 >= CLIFF_LO && r1 <= CLIFF_HI) || !(r2 >= CLIFF_LO && r2 <= CLIFF_HI)) m = 1; }
            pc = S.C[i];
        }
        cnt[i] = c; cl[i + 1] = cl[i] + m;
    }
    S.cnt = cnt; S.cl = cl;
    return S;
}

/** 第 i 天收盤決定 → 第 i+1 天開盤買、第 i+H 天收盤賣(含息 %)。買不到(一價鎖漲停)/ 窗口有斷崖 / 那幾天沒交易 → null。
 *  含息:A = 收盤 × 累積除權息倍數 → 第 e 天開盤之後的倍數 = A[x]·C[e] / (A[e]·O[e])(⛔ 不含進場那天的倍數:開盤就已經除息了) */
export function fwdRet(S, cal, i, H) {
    const e = i + 1, x = i + H;
    if (x >= S.C.length || !(S.C[i] > 0) || !(S.O[e] > 0) || !(S.C[e] > 0) || !(S.C[x] > 0)) return null;
    if (lockedBar(cal[e], S.C[i], S.O[e], S.H[e], S.L[e]) === 1) return null;
    if (S.cl[x + 1] - S.cl[e] > 0) return null;
    return (S.A[x] * S.C[e] / (S.A[e] * S.O[e]) - 1) * 100;
}

/** 六關 + 兩種 p。nw = true(沒去重、天天重疊)或 H > 20 → ⑥ 改用 Newey-West(lag H−1) */
export function gateX(days, dm, H, { cost = COST, nw = false, n = dm.length } = {}) {
    const g = gates({ n, days, dm, all: dm }, cost, 20);
    g.pT = g.p; g.pNW = nwP(dm, Math.max(0, H - 1));
    g.useNW = nw || H > 20;
    g.pUse = g.useNW ? g.pNW : g.pT;
    if (g.useNW) { g.pass['⑥檢定'] = g.d > 0 && g.pNW <= 0.05; g.nPass = Object.values(g.pass).filter(Boolean).length; }
    g.cost = cost;
    return g;
}

/** 安慰劑累加器:每天從 pool 隨機抽 k 個(不放回,就地部分洗牌)→ 平均 − center → 累加;最後 = 每天平均的平均(跟 gates 的 d 同一個口徑) */
export class Sham {
    constructor(seed, K = SHAM_N) { this.K = K; this.sum = new Float64Array(K); this.days = 0; this.rand = rng(seed); }
    day(pool, len, k, center = 0) {
        k = Math.min(k, len); if (!(k > 0)) return false;
        for (let s = 0; s < this.K; s++) {
            let acc = 0;
            for (let j = 0; j < k; j++) { const r = j + Math.floor(this.rand() * (len - j)); const t = pool[j]; pool[j] = pool[r]; pool[r] = t; acc += pool[j]; }
            this.sum[s] += acc / k - center;
        }
        this.days++; return true;
    }
    addRow(row) { for (let s = 0; s < this.K; s++) this.sum[s] += row[s]; this.days++; }
    dist() { return Array.from(this.sum, v => v / Math.max(1, this.days)).sort((a, b) => a - b); }
}
/** 實際值在安慰劑分布的百分位(0~100;同值算一半)+ 5 / 50 / 95% */
export function shamPct(dist, d) {
    if (!dist.length || !Number.isFinite(d)) return { pct: null };
    let lo = 0, eq = 0; for (const v of dist) { if (v < d) lo++; else if (v === d) eq++; }
    const q = f => dist[Math.min(dist.length - 1, Math.floor(dist.length * f))];
    return { pct: (lo + eq / 2) / dist.length * 100, p05: q(0.05), p50: q(0.5), p95: q(0.95), K: dist.length };
}

// ───────────────────────── 訊號 ─────────────────────────
/** 位階高檔:pos252 raw 四捨五入到一位小數(= screener_miner rd(…, 1))。⚠️ 剛好在二進位上整除的 x.25 這種,Python 是「逢五取偶」(86.25 → 86.2)、toFixed 是進位(86.3)
 *  → 顯示值偶爾差 0.1;但 75 那條線附近的 74.95 在二進位上不是剛好 → ≥75 的判定兩邊一定一樣(BT25 實測 10 檔 5,527 個股·日:判定 0 筆不同、顯示值 4 筆差 0.1) */
export const posHi = v => Number.isFinite(v) && +v.toFixed(1) >= POS_MIN;

/** 每檔算一次:tt(趨勢樣板)、rs(分數;算不出來 = NaN)、ph(位階高檔)、ma50(出場用)。⛔ 每一格只用 ≤ 那天的資料 */
export function ttPrep(S) {
    const n = S.C.length, X = S.A;
    const tt = new Uint8Array(n), ph = new Uint8Array(n), rs = new Float64Array(n).fill(NaN), ma50 = new Float64Array(n).fill(NaN);
    const idx = []; for (let i = 0; i < n; i++) if (X[i] > 0) idx.push(i);
    const m200 = new Float64Array(idx.length).fill(NaN);
    const mx = new Int32Array(idx.length), mn = new Int32Array(idx.length); let hx = 0, tx = 0, hn = 0, tn = 0;   // 單調佇列(放 t)
    let s50 = 0, s150 = 0, s200 = 0;
    for (let t = 0; t < idx.length; t++) {
        const i = idx[t], v = X[i];
        s50 += v; if (t >= 50) s50 -= X[idx[t - 50]];
        s150 += v; if (t >= 150) s150 -= X[idx[t - 150]];
        s200 += v; if (t >= 200) s200 -= X[idx[t - 200]];
        while (tx > hx && X[idx[mx[tx - 1]]] <= v) tx--; mx[tx++] = t;
        while (tn > hn && X[idx[mn[tn - 1]]] >= v) tn--; mn[tn++] = t;
        while (mx[hx] <= t - 252) hx++; while (mn[hn] <= t - 252) hn++;
        if (t >= 49) ma50[i] = s50 / 50;
        if (t >= 199) m200[t] = s200 / 200;
        if (t < HIST - 1) continue;                                   // 至少 253 根(r252 要第 t−252 根)
        if (S.cl[i + 1] - S.cl[idx[t - 251]] > 0) continue;          // 近 252 根有斷崖 → 均線 / 高低點 / 報酬都不可信
        const r = rsScore(S, i); if (!Number.isFinite(r)) continue;
        rs[i] = r;
        const a50 = s50 / 50, a150 = s150 / 150, a200 = m200[t], a200p = m200[t - 22], hi = X[idx[mx[hx]]], lo = X[idx[mn[hn]]];
        tt[i] = (v > a50 && a50 > a150 && a150 > a200 && a200 > a200p && v >= 1.3 * lo && v >= 0.75 * hi) ? 1 : 0;
        ph[i] = posHi(pos252(S, i, true)) ? 1 : 0;
    }
    S.tt = tt; S.ph = ph; S.rs = rs; S.ma50 = ma50;
    return S;
}

/** 同一天百分位(0~100,同分取平均名次):arr = [{S, v}] → 寫進 S._p */
export function pctRank(arr) {
    arr.sort((a, b) => a.v - b.v);
    const N = arr.length;
    for (let k = 0; k < N;) { let e = k; while (e + 1 < N && arr[e + 1].v === arr[k].v) e++; const p = N > 1 ? ((k + e) / 2) / (N - 1) * 100 : 50; for (let q = k; q <= e; q++) arr[q].S._p = p; k = e + 1; }
}

/** ④ 出場變體:第 i+1 天開盤買;那天起到第 i+H−1 天,任一天收盤(調整價)< MA50 → 下一根有交易的開盤賣(一價鎖跌停賣不掉 → 再下一根);
 *  都沒碰到(或碰到了但到第 i+H 天前都賣不掉)→ 第 i+H 天收盤賣。forceJ = 指定哪一天收盤觸發(安慰劑)。回 {r, j(觸發那天,沒有 = −1), k(賣出那天)} */
export function exitMa50(S, cal, i, H, forceJ = null) {
    const e = i + 1, x = i + H, base = S.C[e] / (S.A[e] * S.O[e]);
    let trig = -1;
    if (forceJ != null) trig = forceJ;
    else for (let j = e; j < x; j++) if (S.A[j] > 0 && S.ma50[j] > 0 && S.A[j] < S.ma50[j]) { trig = j; break; }
    if (trig >= 0) {
        let pc = S.C[trig];
        for (let k = trig + 1; k <= x; k++) {
            if (!(S.O[k] > 0 && S.C[k] > 0)) continue;
            if (lockedBar(cal[k], pc, S.O[k], S.H[k], S.L[k]) === -1) { pc = S.C[k]; continue; }
            return { r: (S.O[k] * (S.A[k] / S.C[k]) * base - 1) * 100, j: trig, k };   // 開盤賣:那天的除權息倍數照算(前一天收盤還抱著)
        }
    }
    return { r: (S.A[x] * base - 1) * 100, j: trig, k: x };
}

// ───────────────────────── 掃描 ─────────────────────────
/**
 * ctx = {cal, stocks}(leader_probe loadCtx 的結構;每檔先跑 evPrep + ttPrep)→ 全部檢定的每日序列 + 安慰劑。
 * opt.tSig(S, i) / opt.pSig(S, i):換掉 TT∧RS / P 的判斷(selftest 用);opt.K = 安慰劑次數;opt.from / opt.to = 訊號日範圍
 */
export function scanAll(ctx, opt = {}) {
    const { cal, stocks } = ctx, n = cal.length, K = opt.K ?? SHAM_N;
    const rsMin = opt.rsMin ?? RS_MIN;                          // 🧪 RS 門檻高原(⛔ 不設 = 70,逐位相同:selftest ⑩)
    const tSig = opt.tSig || ((S, i) => S.tt[i] === 1 && S._p >= rsMin), pSig = opt.pSig || ((S, i) => S.ph[i] === 1);
    const mk = () => ({ days: [], dm: [], n: 0 });
    const T = {}, P = {}, TmP = {}, TPmP = {}, shT = {}, shP = {}, shTmP = {}, shTPmP = {}, lastT = {}, lastP = {};
    for (const H of HS) { T[H] = mk(); P[H] = mk(); TmP[H] = mk(); TPmP[H] = mk(); shT[H] = new Sham(11 + H, K); shP[H] = new Sham(23 + H, K); shTmP[H] = new Sham(37 + H, K); shTPmP[H] = new Sham(53 + H, K); lastT[H] = new Map(); lastP[H] = new Map(); }
    const X50 = mk(), X50d = mk(), shX = new Sham(71, K), exitSt = { ev: 0, early: 0, held: 0, earlyHeld: 0 };
    const ov = { T: 0, P: 0, TP: 0, pool: 0, days: 0, univ: 0 };
    const i0 = Math.max(1, opt.from ? cal.findIndex(d => d >= opt.from) : 1), i1 = opt.to ? cal.findIndex(d => d > opt.to) : n;
    const poolBuf = new Float64Array(stocks.length), tBuf = new Float64Array(stocks.length), pBuf = new Float64Array(stocks.length);
    const xEv = [], xOff = [], rS = rng(97);                    // ④ 的每一筆進場 + 實際觸發是第幾天(給安慰劑抽)
    for (let i = i0; i < (i1 < 0 ? n : i1) - 1; i++) {
        const U = [];
        for (const S of stocks) if (Number.isFinite(S.rs[i])) U.push({ S, v: S.rs[i] });
        if (U.length < MIN_CTRL) continue;
        pctRank(U);
        const pool = [];
        for (const { S } of U) if (S.C[i] * S.V[i] >= MIN_AMT) pool.push(S);
        if (pool.length < MIN_CTRL) continue;
        const tSet = new Set(), pSet = new Set();
        for (const S of pool) { if (tSig(S, i)) tSet.add(S); if (pSig(S, i)) pSet.add(S); }
        ov.days++; ov.univ += U.length; ov.pool += pool.length; ov.T += tSet.size; ov.P += pSet.size; for (const S of tSet) if (pSet.has(S)) ov.TP++;
        for (const H of HS) {
            if (i + H >= n) continue;
            const rr = new Map(); let len = 0, sum = 0;
            for (const S of pool) { const r = fwdRet(S, cal, i, H); if (r === null) continue; rr.set(S, r); poolBuf[len++] = r; sum += r; }
            if (len < MIN_CTRL) continue;
            const m = sum / len;
            for (let k = 0; k < len; k++) poolBuf[k] -= m;
            // ①② 去重(同檔同訊號 H 天內只算一次;買不到 / 斷崖的那天 ⛔ 重設時鐘)
            const lev = (set, last, R, sh) => {
                let s = 0, c = 0;
                for (const S of set) { const r = rr.get(S); if (r === undefined) continue; const L = last.get(S); if (L !== undefined && i - L < H) continue; last.set(S, i); s += r - m; c++; }
                if (!c) return null;
                R.days.push(cal[i]); R.dm.push(s / c); R.n += c; sh.day(poolBuf, len, c); return c;
            };
            const nT = lev(tSet, lastT[H], T[H], shT[H]); lev(pSet, lastP[H], P[H], shP[H]);
            // ③ 同一天全部(⛔ 去重)
            let pl = 0, ps = 0, tl = 0, ts = 0, tpl = 0, tps = 0;
            for (const S of pSet) { const r = rr.get(S); if (r === undefined) continue; pBuf[pl++] = r; ps += r; }
            for (const S of tSet) { const r = rr.get(S); if (r === undefined) continue; tl++; ts += r; if (pSet.has(S)) { tpl++; tps += r; } }
            if (pl > 0) {
                const pm = ps / pl;
                if (tl > 0) { TmP[H].days.push(cal[i]); TmP[H].dm.push(ts / tl - pm); TmP[H].n += tl; shTmP[H].day(pBuf, pl, tl, pm); }
                if (tpl > 0) { TPmP[H].days.push(cal[i]); TPmP[H].dm.push(tps / tpl - pm); TPmP[H].n += tpl; shTPmP[H].day(pBuf, pl, tpl, pm); }
            }
            // ④ 出場變體:① 的 20 天那批(這一天剛記進去的去重事件)
            if (H === 20 && nT) {
                let sa = 0, sd = 0, c = 0;
                for (const S of tSet) {
                    if (lastT[H].get(S) !== i) continue;                       // 只拿這一天被記進 ① 的那幾筆
                    const r0 = rr.get(S), ex = exitMa50(S, cal, i, H);
                    sa += ex.r - m; sd += ex.r - r0; c++; exitSt.ev++; exitSt.held += ex.k - i;
                    if (ex.j >= 0) { exitSt.early++; exitSt.earlyHeld += ex.k - i; xOff.push(ex.j - i); }
                    xEv.push({ S, i, r0, t: ex.j });
                }
                if (c) { X50.days.push(cal[i]); X50.dm.push(sa / c); X50.n += c; X50d.days.push(cal[i]); X50d.dm.push(sd / c); X50d.n += c; }
            }
        }
    }
    // ④b 安慰劑:每一筆都照「實際提早賣的比例」隨機決定要不要提早賣、觸發日從實際觸發日(進場後第幾天)的分布抽,出場照同一套(隔天開盤、鎖跌停再下一根)
    //   ⛔ 只拿「真的會觸發」的那幾筆換一天賣 = 已經知道它之後會跌破均線(偷看未來)→ 第一版這樣寫,安慰劑憑空 +0.97pp(selftest ⑥b 釘住)
    if (xEv.length && xOff.length) {
        const pE = xOff.length / xEv.length;
        for (let s = 0; s < K; s++) {
            let tot = 0, nd = 0, ds = 0, dc = 0, cur = -1;
            for (const e of xEv) {
                if (e.i !== cur) { if (dc) { tot += ds / dc; nd++; } cur = e.i; ds = 0; dc = 0; }
                let r = e.r0;
                if (rS() < pE) { let j = e.i + xOff[Math.floor(rS() * xOff.length)]; while (j < e.i + 20 && !(e.S.C[j] > 0)) j++; if (j < e.i + 20) r = exitMa50(e.S, cal, e.i, 20, j).r; }
                ds += r - e.r0; dc++;
            }
            if (dc) { tot += ds / dc; nd++; }
            shX.sum[s] = tot; shX.days = nd;
        }
    }
    return { T, P, TmP, TPmP, X50, X50d, sh: { T: shT, P: shP, TmP: shTmP, TPmP: shTPmP, X: shX }, ov, exitSt };
}

/** 掃描結果 → 檢定列(B / C 那支會讀這些列做全家 BH) */
export function report(S) {
    const rows = [];
    const add = (key, name, H, R, sh, o) => {
        const g = gateX(R.days, R.dm, H, { ...o, n: R.n });
        const sp = sh ? shamPct(sh.dist(), g.d) : { pct: null };
        rows.push({ test: 'A', key, name, H, n: R.n, nDays: R.days.length, d: g.d, pT: g.pT, pNW: g.pNW, pUse: g.pUse, useNW: g.useNW, cost: g.cost,
            nPass: g.nPass, pass: g.pass, half: g.H, YR: g.YR.map(y => ({ y: y.y, n: y.n, d: y.d })), yPos: g.YR.filter(y => y.d > 0).length, yTot: g.YR.length, dropBest: g.dropBest, sham: sp });
    };
    for (const H of HS) add('A1', '① 樣板∧RS≥70 vs 同一天母體(去重)', H, S.T[H], S.sh.T[H], {});
    for (const H of HS) add('A2', '② 位階高檔 vs 同一天母體(去重)', H, S.P[H], S.sh.P[H], {});
    for (const H of HS) add('A3a', '③a 同一天:樣板∧RS≥70 − 位階高檔(全部)', H, S.TmP[H], S.sh.TmP[H], { cost: 0, nw: true });
    for (const H of HS) add('A3b', '③b 同一天:(樣板∧RS≥70∧位階高檔)− 位階高檔(全部)', H, S.TPmP[H], S.sh.TPmP[H], { cost: 0, nw: true });
    add('A4a', '④a 樣板∧RS≥70 改「跌破 MA50 隔天賣、最多 20 天」vs 同一天母體(抱 20 天)', 20, S.X50, null, {});
    add('A4b', '④b 同一批進場:跌破 MA50 出場 − 抱滿 20 天', 20, S.X50d, S.sh.X, { cost: 0 });
    return rows;
}

const failed = r => Object.entries(r.pass).filter(([, v]) => !v).map(([k]) => k.slice(1)).join('、') || '—';
export const fmtRow = r => `${r.key.padEnd(4)} ${String(r.H).padStart(2)}日 ${sg(r.d).padStart(7)}pp n=${String(r.n).padStart(7)}(${r.nDays} 天)p(t)=${r.pT.toFixed(4)} p(NW)=${r.pNW.toFixed(4)}${r.useNW ? '*' : ' '} 前/後半 ${sg(r.half[0])}/${sg(r.half[1])} 年正 ${r.yPos}/${r.yTot} → ${r.nPass}/6${r.cost === 0 ? '(⑤成本 0)' : ''}${r.nPass < 6 ? ' 沒過:' + failed(r) : ''}${r.sham.pct != null ? ` 🎲 安慰劑百分位 ${r.sham.pct.toFixed(1)}(5/50/95% ${sg(r.sham.p05)}/${sg(r.sham.p50)}/${sg(r.sham.p95)})` : ''}`;

function main(out) {
    const DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.log('❌ 要 DATA_DIR(跑法見檔頭)'); process.exit(1); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, DIV);
    if (ctx.meta.stocks < 1000) { console.log(`🚨 只有 ${ctx.meta.stocks} 檔(< 1000)→ 母體不夠,停`); process.exit(1); }
    if (ctx.cal[0] > '2011-01-01') { console.log(`🚨 日曆從 ${ctx.cal[0]} 才開始 → ^TWII.json 不是長歷史(先用 merge_k66_history.py --idx-long-only 接上),停`); process.exit(1); }
    for (const S of ctx.stocks) { evPrep(S); ttPrep(S); }
    console.log(`📂 ${ctx.meta.stocks} 檔・日曆 ${ctx.cal[0]}~${ctx.cal.at(-1)}・除權息對不上排除 ${ctx.meta.divSkip}・載入 + 指標 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const rsMin = process.env.RS_MIN ? +process.env.RS_MIN : undefined;
    if (rsMin !== undefined && !(rsMin >= 0 && rsMin <= 100)) { console.log(`❌ RS_MIN 要 0~100,收到 ${process.env.RS_MIN}`); process.exit(1); }
    const S = scanAll(ctx, { from: process.env.FROM || '2011-01-01', rsMin });
    const rows = report(S);
    const o = S.ov;
    if (o.days < 2000 || S.T[20].n < 1000) { console.log(`🚨 空過守門:有效訊號日 ${o.days}、① 20 日事件 ${S.T[20].n} → 太少,停`); process.exit(1); }
    console.log(`🗓️ 訊號日 ${o.days} 天(${S.T[20].days[0]} 起)・每天平均:算得出 RS ${(o.univ / o.days).toFixed(0)} 檔 ・母體(成交額 ≥1,000 萬)${(o.pool / o.days).toFixed(0)} ・樣板∧RS≥70 ${(o.T / o.days).toFixed(1)} ・位階高檔 ${(o.P / o.days).toFixed(1)}`);
    console.log(`🔗 重疊:樣板∧RS≥70 裡 ${(o.TP / o.T * 100).toFixed(1)}% 同時是位階高檔;位階高檔裡 ${(o.TP / o.P * 100).toFixed(1)}% 同時是樣板∧RS≥70`);
    console.log(`🚪 ④ 跌破 MA50 出場:${S.exitSt.ev} 筆裡 ${(S.exitSt.early / S.exitSt.ev * 100).toFixed(1)}% 提早賣 ・平均抱 ${(S.exitSt.held / S.exitSt.ev).toFixed(1)} 天(提早賣的 ${(S.exitSt.earlyHeld / Math.max(1, S.exitSt.early)).toFixed(1)} 天)`);
    console.log('\n(* = ⑥ 用 Newey-West)');
    for (const r of rows) console.log(fmtRow(r));
    console.log('\n逐年(每天平均的年平均,pp):');
    for (const k of ['A1', 'A2', 'A3a', 'A3b']) { const r = rows.find(x => x.key === k && x.H === 20); console.log(`  ${k} 20日 ` + r.YR.map(y => `${y.y.slice(2)}:${sg(y.d)}`).join(' ')); }
    const res = { asof: new Date().toISOString().slice(0, 10), meta: { ...ctx.meta, rsMin: rsMin ?? RS_MIN, from: S.T[20].days[0], to: ctx.cal.at(-1), days: o.days, perDay: { univ: o.univ / o.days, pool: o.pool / o.days, T: o.T / o.days, P: o.P / o.days },
        overlap: { TinP: o.TP / o.T, PinT: o.TP / o.P }, exit: { ...S.exitSt, earlyShare: S.exitSt.early / S.exitSt.ev, avgHeld: S.exitSt.held / S.exitSt.ev }, secs: Math.round((Date.now() - t0) / 1000) }, rows };
    if (out) { fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log(`💾 ${out}`); }
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s ・⛔ 探針不是測試(exit 0)`);
}

// ───────────────────────── selftest ─────────────────────────
async function selftest() {
    const { prepStock } = await import('./leader_probe.mjs');
    let bad = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) bad++; };
    const days = n => { const out = []; const d = new Date(Date.UTC(2016, 0, 4)); while (out.length < n) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };
    const cal = days(700);
    const mk = (sym, f, { divs = [], from = 0, vol = 1e6 } = {}) => {
        const rows = []; for (let i = from; i < cal.length; i++) { const c = f(i); if (!(c > 0)) continue; rows.push({ d: cal[i], o: c, h: c * 1.01, l: c * 0.99, c, v: vol }); }
        return ttPrep(evPrep(prepStock(sym, rows, cal, divs)));
    };
    // ① 趨勢樣板:一路穩漲 → 成立;一年前漲、後來跌 → ⛔;各條件逐一拿掉
    const up = mk('1101', i => 100 * Math.pow(1.002, i));
    ok(up.tt[600] === 1 && Number.isFinite(up.rs[600]) && up.ph[600] === 1, '① 一路穩漲:樣板成立、RS 算得出來、位階 100 → 高檔');
    const dn = mk('1102', i => i < 400 ? 100 * Math.pow(1.002, i) : 100 * Math.pow(1.002, 400) * Math.pow(0.997, i - 400));
    ok(dn.tt[600] === 0 && dn.ph[600] === 0, '① 先漲後跌 200 天:樣板 ⛔、位階 ⛔');
    // 只差「MA200 往上」:第 t−221 ~ t−200 根墊高 ×1.68(每天 ≤ 9.2%,⛔ 碰到兩種斷崖守門)→ 22 天前的 MA200 含這段、今天的不含
    //   → MA200 今天比 22 天前低;MA50 / MA150 / 今天的 MA200 都不含這段 → 其他五條照過 → 只有這條擋下來
    const sf = i => i >= 373 && i < 379 ? Math.pow(1.09, i - 372) : i >= 379 && i < 401 ? Math.pow(1.09, 6) : i >= 401 && i < 407 ? Math.pow(1.09, 6) / Math.pow(1.09, i - 400) : 1;
    const bump = mk('1103', i => 100 * Math.pow(1.002, i) * sf(i));
    const a = bump, t = 600, xi = [];
    {
        const X = a.A, ix = []; for (let k = 0; k <= t; k++) if (X[k] > 0) ix.push(k);
        const ma = (L, end) => { let s = 0; for (let q = end - L + 1; q <= end; q++) s += X[ix[q]]; return s / L; };
        const T = ix.length - 1, w = ix.slice(T - 251).map(k => X[k]);
        xi.push(X[t] > ma(50, T), ma(50, T) > ma(150, T), ma(150, T) > ma(200, T), ma(200, T) > ma(200, T - 22), X[t] >= 1.3 * Math.min(...w), X[t] >= 0.75 * Math.max(...w));
    }
    ok(xi.join() === 'true,true,true,false,true,true' && a.tt[t] === 0 && Number.isFinite(a.rs[t]) && up.tt[t] === 1, `① 只差「MA200 今天 > 22 天前」(${xi.map(v => v ? '✓' : '✗').join('')})→ 樣板 ⛔(手算六條跟程式一致;RS 照算 = 不是斷崖擋的)`);
    // ② 位階:四捨五入到一位小數 —— 74.96 → 75.0 算高檔、74.94 → 74.9 ⛔(100 → 200 → 慢慢跌到 100+x,每天 < 1%,⛔ 碰到斷崖守門)
    const mkPos = target => mk('1104', i => i < 450 ? 100 : i < 599 ? 100 + (i - 450) * (100 / 149) : i === 599 ? 200 : 200 - (i - 599) * (100 - target) / 100);
    const p1 = mkPos(74.96), p2 = mkPos(74.94);
    const raw1 = pos252(p1, 699, true), raw2 = pos252(p2, 699, true);
    ok(Math.abs(raw1 - 74.96) < 1e-9 && p1.ph[699] === 1 && Math.abs(raw2 - 74.94) < 1e-9 && p2.ph[699] === 0, `② 位階 ${raw1.toFixed(3)} → 一位小數 75.0 = 高檔、${raw2.toFixed(3)} → 74.9 ⛔(= screener rd(…, 1))`);
    // ③ 零前視:第 600 天之後的 K 線全部換掉 → 第 600 天的樣板 / RS / 位階 / MA50 一模一樣
    const upF = mk('1101', i => i > 600 ? 5 + (i % 7) : 100 * Math.pow(1.002, i));
    ok(upF.tt[600] === up.tt[600] && upF.rs[600] === up.rs[600] && upF.ph[600] === up.ph[600] && upF.ma50[600] === up.ma50[600] && upF.tt[650] !== up.tt[650],
        '③ 零前視:改掉第 600 天之後的 K 線 → 第 600 天的樣板 / RS / 位階 / MA50 不變(第 650 天會變 = 真的有改到)');
    // ④ 斷崖:近 252 根有 ×2 → RS 不算(不進母體);跨過 252 根之後恢復
    const cl = mk('1105', i => 100 * Math.pow(1.001, i) * (i >= 400 ? 2 : 1));
    ok(Number.isNaN(cl.rs[500]) && cl.tt[500] === 0 && Number.isFinite(cl.rs[690]), '④ 近 252 根有 ×2 斷崖 → 那段時間 RS 不算、樣板不判;斷崖滾出 252 根之後恢復');
    ok(Number.isNaN(mk('1106', i => 100 * Math.pow(1.002, i), { from: 500 }).rs[699]), '④ 不滿 253 根 → RS 不算');
    {   // 只有開盤跳 ×2(收盤連續)→ leader_probe 的斷崖(只看收盤)抓不到、lib_cliff 抓得到 → 一樣不算(注入:拿掉 lib_cliff 那道 → 這條紅)
        const og = mk('1109', i => 100 * Math.pow(1.002, i)); og.O[500] = og.C[499] * 2; evPrep(og); ttPrep(og);
        ok(Number.isNaN(og.rs[600]) && Number.isFinite(rsScore(og, 600)) && og.tt[600] === 0, '④ 只有開盤跳 ×2 → lib_cliff 算斷崖 → 那一年 RS / 樣板不判(rsScore 自己看收盤抓不到)');
    }
    // ⑤ 進出場:一價鎖漲停買不到;除息那段算回來;窗口斷崖不算
    {
        const c5 = days(10), mk5 = (bars, divs = [], cc = c5) => evPrep(prepStock('2001', bars.map((b, k) => ({ d: cc[k], ...b })), cc, divs));
        const one = p => ({ o: p, h: p, l: p, c: p, v: 1 }), tail = { o: 11, h: 11.5, l: 10.8, c: 11.4, v: 1 };
        const div = mk5([one(10), { o: 10, h: 10.1, l: 9.9, c: 10, v: 1 }, { o: 9.5, h: 9.6, l: 9.4, c: 9.5, v: 1 }], [[c5[2], 0.5, '息', 10, 9.5]]);
        const cf = mk5([one(10), { o: 10, h: 10.1, l: 9.9, c: 10, v: 1 }, { o: 20, h: 20.2, l: 19.8, c: 20, v: 1 }]);
        ok(Math.abs(fwdRet(div, c5, 0, 2)) < 1e-9 && Math.abs(fwdRet(div, c5, 0, 1)) < 1e-9 && fwdRet(cf, c5, 0, 2) === null && Number.isFinite(fwdRet(cf, c5, 0, 1)),
            '⑤ 除息 0.5 元那天跌 5% → 含息報酬 0;窗口裡 ×2 斷崖 → 不算(斷崖之前結束的窗口照算)');
        const c12 = days(10).map(d => '2012' + d.slice(4));
        const lock10 = mk5([one(10), one(11), tail]), lock7 = mk5([one(10), one(10.7), tail]), lock7o = mk5([one(10), one(10.7), tail], [], c12);
        ok(fwdRet(lock10, c5, 0, 2) === null && Number.isFinite(fwdRet(lock7, c5, 0, 2)) && fwdRet(lock7o, c12, 0, 2) === null,
            '⑤ 隔天開盤一價 +10%(2016 鎖漲停)→ 買不到;同樣一價 +7%:2016 買得到、2012(±7% 制度)買不到(lockedBar / lib_limit)');
    }
    // ⑥ 出場變體:跌破 MA50 那天收盤 → 隔天開盤賣;隔天一價鎖跌停 → 再下一根;安慰劑指定觸發日 → 照指定的那天
    {
        const f = i => i < 610 ? 100 * Math.pow(1.002, i) : 100 * Math.pow(1.002, 610) * (i < 612 ? 1 : 0.85);
        const S6 = mk('1107', f);
        const ex = exitMa50(S6, cal, 605, 20), r0 = fwdRet(S6, cal, 605, 20);
        ok(ex.j === 612 && ex.k === 613 && Math.abs(ex.r - (S6.O[613] / S6.O[606] - 1) * 100) < 1e-9 && ex.r > r0 - 1e-9, `⑥ 第 612 天收盤跌破 MA50 → 第 613 天開盤賣(${sg(ex.r)}% vs 抱 20 天 ${sg(r0)}%)`);
        const S7 = mk('1108', f); S7.O[613] = S7.H[613] = S7.L[613] = S7.C[612] * 0.9; S7.C[613] = S7.O[613];   // 第 613 天一價鎖跌停
        const ex7 = exitMa50(S7, cal, 605, 20), exF = exitMa50(S6, cal, 605, 20, 608);
        ok(ex7.k === 614 && exF.j === 608 && exF.k === 609, `⑥ 隔天一價鎖跌停 → 再下一根開盤賣(第 ${ex7.k} 天);安慰劑指定第 608 天觸發 → 第 ${exF.k} 天開盤賣`);
    }
    // ⑦ 同一天對照 + 安慰劑 + 去重:合成 80 檔 × 700 天;每天用雜湊挑一半當訊號
    const world = ({ edge = 0, regime = false, M = regime ? 2 : 40, NS = 80 } = {}) => {   // M = 每幾個股·日有一個訊號(注入那組要稀疏:天天有訊號的話每檔都一直在多漲,同一天對照會把它全部抵銷)
        const R = rng(5), stocks = [];
        const flag = (s, i) => ((s * 2654435761 + i * 40503) >>> 0) % M === 0;
        const mkt = Array.from({ length: cal.length }, (_, i) => regime ? (i < 450 ? 0.004 : -0.004) : 0);
        for (let s = 0; s < NS; s++) {
            const px = []; let p = 50, boost = 0;
            for (let i = 0; i < cal.length; i++) {
                const live = !regime || i < 450;
                const sig = live && flag(s, i);
                p *= 1 + mkt[i] + (R() - 0.5) * 0.02 + (boost > 0 ? edge : 0); boost--;
                px.push(p);
                if (sig && edge) boost = Math.max(boost, 21);   // 訊號那天收盤之後的 21 根多漲(第 i+1 天開盤 ≈ 第 i 天收盤 → 進場之後才吃得到)
            }
            const rows = px.map((c, i) => ({ d: cal[i], o: i ? px[i - 1] : c, h: Math.max(c, i ? px[i - 1] : c) * 1.005, l: Math.min(c, i ? px[i - 1] : c) * 0.995, c, v: 1e6 }));
            const S = ttPrep(evPrep(prepStock(String(3000 + s), rows, cal, []))); S._s = s; stocks.push(S);
        }
        return { ctx: { cal, stocks }, sig: (S, i) => flag(S._s, i) && (!regime || i < 450) };
    };
    {
        const W = world({ edge: 0.004 }), Sx = scanAll(W.ctx, { tSig: W.sig, pSig: (S, i) => true, K: 60 });
        const r = report(Sx).find(x => x.key === 'A1' && x.H === 20);
        const W0 = world({ edge: 0 }), S0 = scanAll(W0.ctx, { tSig: W0.sig, pSig: (S, i) => true, K: 60 });
        const r0 = report(S0).find(x => x.key === 'A1' && x.H === 20);
        ok(r.d > 3 && r.sham.pct > 95 && Math.abs(r0.d) < 1 && r0.sham.pct > 2 && r0.sham.pct < 98, `⑦ 注入「訊號之後多漲」→ 量得到 ${sg(r.d)}pp(安慰劑百分位 ${r.sham.pct.toFixed(0)});沒注入 → ${sg(r0.d)}pp(百分位 ${r0.sham.pct.toFixed(0)})`);
        const Wr = world({ regime: true }), Sr = scanAll(Wr.ctx, { tSig: Wr.sig, pSig: (S, i) => true, K: 20 });
        const rr = report(Sr).find(x => x.key === 'A1' && x.H === 20);
        const raw = (() => { let s = 0, c = 0, a = 0, b = 0; for (const S of Wr.ctx.stocks) for (let i = 260; i < 670; i++) { const v = fwdRet(S, cal, i, 20); if (v === null) continue; a += v; b++; if (Wr.sig(S, i)) { s += v; c++; } } return s / c - a / b; })();
        ok(Math.abs(rr.d) < 0.6 && raw > 2, `⑦ 決定性對照:前段大漲、後段大跌,訊號只在前段 → 跟整段平均比憑空 ${sg(raw)}pp、同一天對照 ${sg(rr.d)}pp(≈ 0)`);
        // 去重:同一檔天天有訊號 → 20 天只算一次
        // ⑥b ④ 的安慰劑要公平:沒有漂移的隨機漫步 → 跌破 MA50 出場跟抱滿 20 天理論上一樣 → 安慰劑中位 ≈ 0
        //    (⛔ 只拿真的會觸發的那幾筆換一天賣 → 那幾筆之後會跌是已知的 → 安慰劑憑空 > 0,注入那個寫法這條要紅)
        const Wx = world({ edge: 0, NS: 240 }), Sx2 = scanAll(Wx.ctx, { tSig: () => true, pSig: () => false, K: 60 });
        const x4 = report(Sx2).find(x => x.key === 'A4b');
        ok(x4.n > 4000 && Math.abs(x4.sham.p50) < 0.07 && Math.abs(x4.d) < 0.3, `⑥b 隨機漫步:跌破 MA50 出場 − 抱 20 天 ${sg(x4.d)}pp、安慰劑中位 ${sg(x4.sham.p50)}pp(≈ 0 = 沒偷看;${x4.n} 筆)`);
        const W1 = world({ edge: 0 }), S1 = scanAll(W1.ctx, { tSig: (S, i) => S._s === 0, pSig: () => false, K: 5 });
        const dd = S1.T[20].days.map(d => cal.indexOf(d)), gaps = dd.slice(1).map((v, k) => v - dd[k]);
        ok(S1.T[20].n === dd.length && gaps.length > 5 && gaps.every(g => g >= 20) && S1.T[5].days.length > S1.T[20].days.length * 3, `⑦ 去重:同一檔天天有訊號 → 20 日那組每隔 ≥20 天才算一次(${dd.length} 筆)、5 日那組多很多(${S1.T[5].days.length})`);
    }
    // ⑩ RS 門檻:不設 == rsMin 70(逐位相同);門檻 101 → 一筆都沒有;門檻 0 → 樣板成立的全部(比 70 多)
    {
        const R = rng(9), st = [];   // 40 檔都穩漲(斜率不同 + 小雜訊)→ 樣板幾乎天天成立、RS 照斜率排
        for (let s = 0; s < 40; s++) { const px = []; let p = 30; for (let i = 0; i < cal.length; i++) { p *= 1 + 0.0005 + s * 0.0001 + (R() - 0.5) * 0.004; px.push(p); }
            st.push(ttPrep(evPrep(prepStock(String(4000 + s), px.map((c, i) => ({ d: cal[i], o: i ? px[i - 1] : c, h: c * 1.005, l: c * 0.995, c, v: 1e6 })), cal, [])))); }
        const W = { ctx: { cal, stocks: st } };
        const base = scanAll(W.ctx, { pSig: () => true, K: 5, tSig: undefined }), s70 = scanAll(W.ctx, { pSig: () => true, K: 5, rsMin: 70 });
        const s101 = scanAll(W.ctx, { pSig: () => true, K: 5, rsMin: 101 }), s0 = scanAll(W.ctx, { pSig: () => true, K: 5, rsMin: 0 });
        const same = (a, b) => JSON.stringify(a.T) === JSON.stringify(b.T) && JSON.stringify(a.TmP) === JSON.stringify(b.TmP) && JSON.stringify(a.X50d) === JSON.stringify(b.X50d);
        ok(same(base, s70) && base.T[20].n > 0 && s101.T[20].n === 0 && s0.ov.T > base.ov.T, `⑩ RS 門檻:不設 == 70(逐位相同,${base.T[20].n} 筆)、101 → 0 筆、0 → 樣板成立的全部(${s0.ov.T} > ${base.ov.T} 股·日)`);
    }
    // ⑧ 同一天百分位:同分取平均名次、0~100
    { const arr = [3, 1, 2, 2, 5].map((v, k) => ({ S: { k }, v })); pctRank(arr); const p = Object.fromEntries(arr.map(x => [x.S.k, x.S._p])); ok(p[1] === 0 && p[4] === 100 && p[2] === 37.5 && p[3] === 37.5 && p[0] === 75, '⑧ 百分位:最低 0、最高 100、同分取平均名次(2 跟 2 都是 37.5)'); }
    // ⑨ Newey-West:同一串重複 3 次(重疊)→ p 比當成獨立的大;安慰劑百分位的算法
    { const R = rng(11), x = []; for (let i = 0; i < 120; i++) { const v = R() - 0.45; x.push(v, v, v); } const g = gates({ n: x.length, days: x.map((_, k) => '2020-' + String(k).padStart(5, '0')), dm: x, all: x }, COST, 20);
        ok(nwP(x, 2) > g.p && shamPct([1, 2, 3, 4], 2.5).pct === 50 && shamPct([1, 2, 3, 4], 9).pct === 100, `⑨ Newey-West p ${nwP(x, 2).toFixed(4)} > 當成獨立 ${g.p.toFixed(4)};安慰劑百分位算法對`); }
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過');
    process.exit(bad ? 1 : 0);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) selftest();
else if (_isMain) main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
