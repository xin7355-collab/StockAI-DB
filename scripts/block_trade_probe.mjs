#!/usr/bin/env node
/**
 * 🐘 鉅額交易之後,那檔股票會比較強還是比較弱?(V80.1.9 寫好、V82.6.3 資料到齊後補方法再跑;評估紀錄 52 策略 D + LAB「💵 鉅額交易」)
 *
 * 資料:證交所 BFIAUU 2009 起每一天的鉅額交易(block_deep 分支,block_deep_fetch.py)+ 研究資料包 d16(含下市、除權息)。
 *   ⚠️ 只有上市(BFIAUU 只有上市)→ 股票池 = stock_names 標「上市」的 + 已下市(標不出市場的);⛔ 上櫃 / 興櫃。
 *   鉅額當天收盤後才公布 → 第二天開盤才算知道。成交量 0 的列(停牌時帶上一天收盤的佔位列)當沒有交易。
 * 一天一檔先合起來:鉅額股數 = 那天所有鉅額列加總、鉅額均價 = 金額 ÷ 股數。
 *   d16 在分割 / 面額變更之前那段換過尺標(列上 `_sk` = 股數倍數:d16 收盤 × _sk = 當時的原始收盤、d16 成交量 ÷ _sk = 原始成交量,
 *   merge_stock_deep.share_scale)→ 溢價 = 鉅額均價 ÷ 原始收盤 − 1。
 *   🚨 佔比的分母要同一個口徑:FinMind 的成交量「含鉅額」(2010~2023-05 的 3.6 萬筆鉅額沒有一筆超過當天成交量),本站 data 分支
 *   2023-05 起的成交量有些天含、有些天不含(同一天跟 FinMind 比:一樣 7,887 筆、差剛好一筆鉅額 301 筆、差鉅額 + 一點點 3,112 筆)
 *   → 佔比 = 鉅額股數 ÷ 當天總成交股數(含鉅額,FinMind 口徑):2021 起讀 klines_deep 的原始成交量(KD_DIR),
 *   2021 前 d16 本身就是 FinMind(÷ _sk 換回原始);2021 後 klines_deep 沒有那一天(2026-09 以後)→ 佔比算不出、只做溢價 / 折價。
 *   鉅額價格也在當天漲跌幅之內 → 均價 ÷ 收盤 超出 (1−L)/(1+L) ~ (1+L)/(1−L)(L = 當天漲跌幅)= 尺標還是對不上 → 丟掉、列數。
 * 五個檢定 × 抱 5 / 20 / 60 天(15 格一起 BH):
 *   T1 佔比前 1%   T2 佔比前 5%   (門檻 = 「之前」所有鉅額事件的分位數,⛔ 用到未來;至少 250 筆才開始)
 *   T3 溢價成交(≥ 收盤 +1%,預期之後比較強)   T4 折價成交(≤ 收盤 −3%,預期之後比較弱)
 *   T5 配對交易而且佔比前 5%(協議成交,最像大股東轉讓)   —— T1 / T2 / T5 方向不預設(看 Ⓑ 全期那個方向)
 * 規則同 trade_lead_probe:隔天開盤買(開盤一價鎖漲停 = 買不到、不算)、含息、窗口有斷崖不算、同一檔 10 天內只算第一次。
 * 兩種對照(都要過):Ⓐ 同一天股票池全部 Ⓑ 同一天同一格(20 日成交金額 × 一年位階 × 20 日波動 各三分位 = 27 格;
 *   特徵只用當天以前的資料、三分位只用當天的股票)。檢定先每天平均,p 一律 Newey-West(lag = ⌈(H−1) × 有事件的天數比例⌉)。
 * 兩種安慰劑:同一天同一格隨便挑一檔(500 次)、同一檔換到前後 40~120 個交易日(200 次;落在自己有鉅額的 10 天內就重抽)。
 * 🔒 樣本外封存:事件日與出場日都 ≤ 2026-11-06(LAB oos-seal)。判定條件寫在實驗登錄(EXP-20261124-01)。
 *
 * 跑法:DATA_DIR=<d16> BLOCK_DIR=<block_deep 資料夾> KD_DIR=<klines_deep 資料夾> IDX_LONG=<idx_long.json> node --max-old-space-size=8000 scripts/block_trade_probe.mjs out.json
 *       CHECK_ONLY=1 …(只印資料檢查:事件數 / 丟掉幾筆 / 佔比分布,⛔ 算任何報酬)
 *       node scripts/block_trade_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { gates, COST, increments, baseAdd, negate } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';
import { alignStock, fwdRet, nwP } from './trade_lead_probe.mjs';
import { limitOf } from './lib_limit.mjs';

export const HS = [5, 20, 60];
const DEDUP = 10;
const MIN_HIST = 250;
const SHAM_N = 500, SHIFT_N = 200, SHIFT_LO = 40, SHIFT_HI = 120;
const MIN_CELL = 5;                 // 那一格那一天至少幾檔才拿來當對照
export const CUTOFF = '2026-11-06'; // 🔒 樣本外封存(2026-11-07 起的資料只拿來驗)
export const KD_FROM = '2021-01-04';  // klines_deep(FinMind 原始日 K)從這天起;之前 d16 本身就是 FinMind
export const DIR = { T1: 0, T2: 0, T3: 1, T4: -1, T5: 0 };   // 預期方向:0 = 不預設
const NAME = { T1: '佔比前 1%', T2: '佔比前 5%', T3: '溢價 ≥ +1%', T4: '折價 ≤ −3%', T5: '配對佔比前 5%' };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sg = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const rng = s => () => ((s = (s * 16807) % 2147483647) / 2147483647);

/** 一天的鉅額列 [[代號, 交易別, 價, 股數, 金額]] → Map(代號 → {sh, val, vwap, pair})。只收 4 碼普通股。 */
export function aggDay(rows) {
    const m = new Map();
    for (const r of rows || []) {
        const code = String(r[0] || '').trim(), sh = +r[3], val = +r[4];
        if (!/^[1-9]\d{3}$/.test(code) || !(sh > 0) || !(val > 0)) continue;
        const a = m.get(code) || { sh: 0, val: 0, pair: 0 };
        a.sh += sh; a.val += val;
        if (String(r[1]).includes('配對')) a.pair += sh;
        m.set(code, a);
    }
    for (const a of m.values()) a.vwap = a.val / a.sh;
    return m;
}

/** 擴張式分位數門檻:x 之前(⛔ 含自己)所有值的第 q 分位;不到 minN 筆回 Infinity。
 *  用排序陣列插入(事件約 5 萬筆,夠快)。回傳 [門檻...],跟 xs 對齊。 */
export function expandingQuantile(xs, q, minN = MIN_HIST) {
    const sorted = [], out = new Array(xs.length);
    const ins = v => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; } sorted.splice(lo, 0, v); };
    for (let i = 0; i < xs.length; i++) {
        out[i] = sorted.length < minN ? Infinity : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        ins(xs[i]);
    }
    return out;
}

/** 事件 [{i(日期編號), sym, ...}] 依日期排好 → 同一檔 DEDUP 天內只留第一次 */
export function dedup(evs, gap = DEDUP) {
    const last = new Map(), out = [];
    for (const e of evs) { const p = last.get(e.sym); if (p != null && e.i - p < gap) continue; last.set(e.sym, e.i); out.push(e); }
    return out;
}

/** 鉅額均價 ÷ 當天收盤 物理上可能的範圍(兩個價都在當天漲跌幅之內) */
export const physRange = date => { const L = limitOf(date); return [(1 - L) / (1 + L), (1 + L) / (1 - L)]; };

/** 當天總成交股數(含鉅額,FinMind 口徑):klines_deep 有就用它;KD_FROM 以前 d16 本身就是 FinMind(÷ _sk);其他 → NaN(佔比算不出) */
export function totalVol(S, i, sk) {
    const kv = S.kv ? S.kv[i] : NaN;
    if (kv > 0) return kv;
    const d = S.date ? S.date[i] : '2020-01-01';
    return d < KD_FROM && S.v[i] > 0 ? S.v[i] / sk : NaN;
}

/** 鉅額事件 → 佔比 / 溢價(用 _sk 換回原始尺標);那天沒有一般成交 / 均價超出物理範圍 → 丟掉,計數進 st;
 *  佔比的分母算不出 → ratio = NaN(只做溢價 / 折價);鉅額比當天總成交股數還多 = 資料矛盾 → ratio = NaN、計數 */
export function enrich(blocks, stocks, st = {}) {
    for (const k of ['noTrade', 'phys', 'scaled', 'noTv', 'overOne']) st[k] = st[k] || 0;
    st.physEx = st.physEx || [];
    const out = [];
    for (const b of blocks) {
        const S = stocks.get(b.sym), v = S.v[b.i], c = S.c[b.i];
        if (!(v > 0) || !(c > 0)) { st.noTrade++; continue; }
        const sk = S.sk && S.sk[b.i] > 0 ? S.sk[b.i] : 1;
        const rc = c * sk, q = b.vwap / rc;
        const [lo, hi] = physRange(S.date ? S.date[b.i] : '2020-01-01');
        if (!(q >= lo - 1e-9 && q <= hi + 1e-9)) {
            st.phys++;
            if (st.physEx.length < 8) st.physEx.push(`${b.sym}@${S.date ? S.date[b.i] : b.i} 均價 ${b.vwap.toFixed(2)} ÷ 收盤 ${rc.toFixed(2)} = ${q.toFixed(3)}`);
            continue;
        }
        if (sk !== 1) st.scaled++;
        const tv = totalVol(S, b.i, sk);
        let ratio = tv > 0 ? b.sh / tv : NaN, pairRatio = tv > 0 ? b.pair / tv : NaN;
        if (!(tv > 0)) st.noTv++;
        else if (ratio > 1.001) { st.overOne++; ratio = NaN; pairRatio = NaN; }
        out.push({ ...b, ratio, prem: q - 1, pairRatio });
    }
    return out;
}

/** 第 i 天收盤時(只用 ≤ i 的資料):20 日平均成交金額、一年(250 根)位階、20 日波動。算不出 = NaN。
 *  成交金額 = 收盤 × 成交量(d16 換尺標時價 ÷ k、量 × k → 乘起來不變);位階窗口內有斷崖就不算;波動只用相鄰兩根都有交易、中間沒有斷崖的日報酬。 */
export function features(S, T) {
    const amt = new Float64Array(T).fill(NaN), pos = new Float64Array(T).fill(NaN), vol = new Float64Array(T).fill(NaN);
    const { c, v, h, l, cliff } = S;
    for (let i = 0; i < T; i++) {
        if (!(c[i] > 0)) continue;
        let sa = 0, na = 0;
        for (let t = Math.max(0, i - 19); t <= i; t++) if (c[t] > 0 && v[t] > 0) { sa += c[t] * v[t]; na++; }
        if (na >= 10) amt[i] = sa / na;
        let s1 = 0, s2 = 0, nv = 0;
        for (let t = Math.max(1, i - 19); t <= i; t++) {
            if (c[t] > 0 && c[t - 1] > 0 && cliff[t + 1] - cliff[t] === 0) { const x = Math.log(c[t] / c[t - 1]); s1 += x; s2 += x * x; nv++; }
        }
        if (nv >= 10) vol[i] = Math.sqrt(Math.max(0, (s2 - s1 * s1 / nv) / (nv - 1)));
        const a = Math.max(0, i - 249);
        if (cliff[i + 1] - cliff[a + 1] === 0) {
            let mx = -Infinity, mn = Infinity, np = 0;
            for (let t = a; t <= i; t++) if (c[t] > 0) { if (h[t] > mx) mx = h[t]; if (l[t] < mn) mn = l[t]; np++; }
            if (np >= 120 && mx > mn) pos[i] = (c[i] - mn) / (mx - mn);
        }
    }
    return { amt, pos, vol };
}

/** 每天:三個特徵各自在「當天三個都算得出來的股票」裡切三分位 → 格 0~26(算不出 / 那天不到 minN 檔 = −1)。只用同一天的截面。 */
export function buildCells(F, T, minN = 30) {
    const cells = F.map(() => new Int8Array(T).fill(-1));
    const cut = a => { const s = Float64Array.from(a).sort(); return [s[Math.floor(s.length / 3)], s[Math.floor(2 * s.length / 3)]]; };
    const bk = (x, t) => x < t[0] ? 0 : (x < t[1] ? 1 : 2);
    for (let i = 0; i < T; i++) {
        const A = [], P = [], V = [], who = [];
        for (let j = 0; j < F.length; j++) {
            const a = F[j].amt[i], p = F[j].pos[i], v = F[j].vol[i];
            if (a > 0 && Number.isFinite(p) && Number.isFinite(v)) { A.push(a); P.push(p); V.push(v); who.push(j); }
        }
        if (who.length < minN) continue;
        const ca = cut(A), cp = cut(P), cv = cut(V);
        for (let k = 0; k < who.length; k++) cells[who[k]][i] = bk(A[k], ca) * 9 + bk(P[k], cp) * 3 + bk(V[k], cv);
    }
    return cells;
}

/** Ⓑ 的增量:每一筆減「同一天同一格」的平均(那格那天 < minCell 檔不算),再照日期收成每天一個平均(同 lib_evgate.increments 的口徑) */
export function incCell(evs, baseB, minCell = MIN_CELL) {
    const byDay = new Map(); let n = 0;
    for (const e of evs) {
        const b = baseB.get(e.key); if (!b || b.n < minCell) continue;
        const a = byDay.get(e.d) || []; a.push(e.r - b.s / b.n); byDay.set(e.d, a); n++;
    }
    const days = [...byDay.keys()].sort();
    return { n, days, dm: days.map(d => { const a = byDay.get(d); return a.reduce((s, x) => s + x, 0) / a.length; }), all: days.flatMap(d => byDay.get(d)) };
}

/** 事件 → [{d, key, r, i, sym}](出場日超過 iCut / 那天沒有格 / 買不到 / 斷崖 → 不算) */
export function evRets(evs, W, H, iCut) {
    const out = [];
    for (const e of evs) {
        if (e.i + H > iCut) continue;
        const S = W.stocks.get(e.sym), cell = S.cell ? S.cell[e.i] : 0;
        if (cell < 0) continue;
        const r = fwdRet(S, e.i + 1, e.i + H); if (r == null) continue;
        out.push({ d: W.cal[e.i], key: W.cal[e.i] + '|' + cell, r, i: e.i, sym: e.sym });
    }
    return out;
}

/** 對照:Ⓐ 同一天股票池全部(key = 日期)Ⓑ 同一天同一格(key = 日期|格);只收出場日 ≤ iCut 的 */
export function buildBases(W, iCut) {
    const A = HS.map(() => new Map()), B = HS.map(() => new Map());
    for (const S of W.stocks.values()) {
        for (let i = 1; i <= iCut; i++) {
            if (!(S.c[i] > 0)) continue;
            for (let k = 0; k < HS.length; k++) {
                const H = HS[k]; if (i + H > iCut) continue;
                const r = fwdRet(S, i + 1, i + H); if (r == null) continue;
                baseAdd(A[k], W.cal[i], r);
                const cell = S.cell ? S.cell[i] : 0;
                if (cell >= 0) baseAdd(B[k], W.cal[i] + '|' + cell, r);
            }
        }
    }
    return { A, B };
}

/** 在方向 dir(+1 / −1)上過六關;p 一律 Newey-West(lag = ⌈(H − 1) × 有事件的天數比例⌉,至少 1;雙尾,方向不影響) */
export function gateDir(inc, H, dir, density) {
    const g = gates(dir < 0 ? negate(inc) : inc, COST);
    g.lag = Math.max(1, Math.ceil((H - 1) * density));
    g.pNW = nwP(inc.dm, g.lag);
    g.pass['⑥檢定'] = g.d > 0 && g.pNW <= 0.05;
    g.nPass = Object.values(g.pass).filter(Boolean).length;
    return g;
}

/** 拿掉方向上貢獻最大的 frac 筆(每筆增量 × dir 最大的),再照每天平均 → 方向上的平均(> 0 = 還在) */
export function trimDir(rets, baseB, dir, frac = 0.01, minCell = MIN_CELL) {
    const xs = [];
    for (const e of rets) { const b = baseB.get(e.key); if (!b || b.n < minCell) continue; xs.push({ d: e.d, x: e.r - b.s / b.n }); }
    xs.sort((a, b) => dir * b.x - dir * a.x);
    const drop = Math.ceil(frac * xs.length), byDay = new Map();
    for (const o of xs.slice(drop)) { const a = byDay.get(o.d) || []; a.push(o.x); byDay.set(o.d, a); }
    return { drop, m: dir * mean([...byDay.values()].map(mean)) };
}

const hasIn = (arr, lo, hi) => { if (!arr) return false; let a = 0, b = arr.length; while (a < b) { const m = (a + b) >> 1; if (arr[m] < lo) a = m + 1; else b = m; } return a < arr.length && arr[a] <= hi; };

/** 安慰劑①:每一筆換成「同一天同一格」隨便一檔(n 次)→ 每次的 Ⓑ 增量平均 */
export function shamCell(rets, W, H, baseB, n, seed) {
    const R = rng(seed), vals = [];
    W._pool = W._pool || new Map();
    const syms = [...W.stocks.keys()];
    const poolOf = (i, cell) => {
        const key = i + '|' + cell; let p = W._pool.get(key);
        if (!p) { p = syms.filter(s => { const S = W.stocks.get(s); return S.c[i] > 0 && (S.cell ? S.cell[i] : 0) === cell; }); W._pool.set(key, p); }
        return p;
    };
    for (let t = 0; t < n; t++) {
        const ev = [];
        for (const e of rets) {
            const cell = +e.key.split('|')[1], p = poolOf(e.i, cell);
            for (let k = 0; k < 5 && p.length; k++) {
                const s = p[Math.floor(R() * p.length)], r = fwdRet(W.stocks.get(s), e.i + 1, e.i + H);
                if (r != null) { ev.push({ d: e.d, key: e.key, r }); break; }
            }
        }
        vals.push(mean(incCell(ev, baseB).dm));
    }
    return vals;
}

/** 安慰劑②:同一檔換到前後 SHIFT_LO~SHIFT_HI 個交易日(落在自己有鉅額的 DEDUP 天內、沒有格、買不到 → 重抽,最多 10 次)→ 每次的 Ⓑ 增量平均 */
export function shamShift(rets, W, H, baseB, iCut, blockDays, n, seed) {
    const R = rng(seed), vals = [];
    for (let t = 0; t < n; t++) {
        const ev = [];
        for (const e of rets) {
            const S = W.stocks.get(e.sym);
            for (let k = 0; k < 10; k++) {
                const sh = SHIFT_LO + Math.floor(R() * (SHIFT_HI - SHIFT_LO + 1)), i2 = e.i + (R() < 0.5 ? -sh : sh);
                if (i2 < 1 || i2 + H > iCut || hasIn(blockDays.get(e.sym), i2 - DEDUP, i2)) continue;
                const cell = S.cell ? S.cell[i2] : 0; if (cell < 0 || !(S.c[i2] > 0)) continue;
                const r = fwdRet(S, i2 + 1, i2 + H); if (r == null) continue;
                ev.push({ d: W.cal[i2], key: W.cal[i2] + '|' + cell, r }); break;
            }
        }
        vals.push(mean(incCell(ev, baseB).dm));
    }
    return vals;
}

/** 安慰劑的單尾 p(在 dir 方向上,實際值至少一樣極端的比例) */
export const pSham = (vals, actual, dir) => (1 + vals.filter(v => dir * v >= dir * actual).length) / (1 + vals.length);

/** 一格(檢定 × 天期)的判定:全部過才算有用(登錄 EXP-20261124-01 的七條) */
export function judge(r) {
    const c = {
        '①兩種對照 q≤0.05 同方向': r.qA <= 0.05 && r.qB <= 0.05 && Math.sign(r.mA) === r.dir && Math.sign(r.mB) === r.dir,
        '②扣成本': r.gB.d - COST > 0,
        '③前後半': r.gB.H.every(x => x > 0),
        '④逐年 ≥75%': r.yrN >= 3 && r.yrPos / r.yrN >= 0.75,
        '⑤去最好年': r.gB.dropBest > 0,
        '⑥兩種安慰劑': r.pCell <= 0.05 && r.pShift <= 0.05,
        '⑦去極端 1%': r.trim.m > 0,
    };
    return { c, ok: Object.values(c).every(Boolean), n: Object.values(c).filter(Boolean).length };
}

function loadWorld(env) {
    const miss = ['DATA_DIR', 'BLOCK_DIR', 'KD_DIR', 'IDX_LONG'].filter(k => !env[k]);
    if (miss.length) { console.log(`❌ 要設 ${miss.join(' / ')}(跑法見檔頭)`); process.exit(1); }
    const idx = JSON.parse(fs.readFileSync(env.IDX_LONG, 'utf8'));
    const tw = (idx.twii || []).map(r => d10(r[0]));
    let late = [];
    try { late = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, '^TWII.json'), 'utf8')).map(r => d10(r.date)).filter(d => d > tw[tw.length - 1]); } catch (_) {}
    const cal = [...tw, ...late], calIdx = new Map(cal.map((d, i) => [d, i]));
    const divAll = (() => { try { return JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, '_div16.json'), 'utf8')).d || {}; } catch (_) { return {}; } })();
    const names = (() => { try { return JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, 'stock_names.json'), 'utf8')).names; } catch (_) { return null; } })();
    if (!names) { console.log('❌ 讀不到 stock_names.json(要用它挑上市 / 已下市的股票)'); process.exit(1); }
    const mkt = s => { const v = names[s]; return v && v.length > 2 ? v[2] : 'unknown'; };
    const stocks = new Map(), skipMkt = {}; let vol0 = 0, nKdMiss = 0;
    for (const f of fs.readdirSync(env.DATA_DIR).sort()) {
        const s = f.replace(/\.json$/, '');
        if (!/^[1-9]\d{3}$/.test(s)) continue;          // 普通股(⛔ ETF / 權證)
        const m = mkt(s);
        if (m !== 'twse' && m !== 'unknown') { skipMkt[m] = (skipMkt[m] || 0) + 1; continue; }
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 60) continue;
        const real = bars.filter(r => +r.volume > 0);
        vol0 += bars.length - real.length;
        const A = alignStock(cal, calIdx, real, (divAll[s] || {}).h);
        A.date = cal; A.mkt = m;
        A.sk = new Float64Array(cal.length).fill(1);
        for (const r of real) { const i = calIdx.get(d10(r.date)); if (i != null && +r._sk > 0) A.sk[i] = +r._sk; }
        A.kv = new Float64Array(cal.length).fill(NaN);
        try {
            const kd = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(env.KD_DIR, s + '.json.gz'))).toString('utf8'));
            for (const r of (kd.k || [])) { const i = calIdx.get(d10(r[0])); if (i != null && +r[5] > 0) A.kv[i] = +r[5]; }
        } catch (_) { nKdMiss++; }
        stocks.set(s, A);
    }
    const blocks = [], miss2 = { pre: 0, cal: 0, univ: 0 };
    for (const f of fs.readdirSync(env.BLOCK_DIR).sort()) {
        if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
        const mj = JSON.parse(fs.readFileSync(path.join(env.BLOCK_DIR, f), 'utf8'));
        for (const [ds, rows] of Object.entries(mj.days || {})) {
            const i = calIdx.get(ymd(ds));
            const agg = aggDay(rows);
            if (i == null) { if (ymd(ds) < cal[0]) miss2.pre += agg.size; else miss2.cal += agg.size; continue; }
            for (const [sym, a] of agg) { if (stocks.has(sym)) blocks.push({ i, sym, ...a }); else miss2.univ++; }
        }
    }
    blocks.sort((a, b) => a.i - b.i || (a.sym < b.sym ? -1 : 1));
    return { cal, calIdx, stocks, blocks, skipMkt, vol0, nKdMiss, miss: miss2 };
}

function main(out) {
    const t0 = Date.now(), env = process.env;
    const W = loadWorld(env);
    let iCut = W.cal.length - 1; while (iCut > 0 && W.cal[iCut] > CUTOFF) iCut--;
    const nU = [...W.stocks.values()].reduce((m, S) => { m[S.mkt] = (m[S.mkt] || 0) + 1; return m; }, {});
    console.log(`🐘 股票池 ${W.stocks.size} 檔(上市 ${nU.twse || 0}・已下市標不出市場 ${nU.unknown || 0};跳過 ${JSON.stringify(W.skipMkt)})・成交量 0 的列 ${W.vol0}`);
    console.log(`   日曆 ${W.cal[0]} ~ ${W.cal[W.cal.length - 1]}(${W.cal.length} 天)・🔒 判定只到 ${W.cal[iCut]}(第 ${iCut} 天)`);
    console.log(`   鉅額(一天一檔合併)${W.blocks.length} 筆・沒對上:2010 前(d16 沒有股價)${W.miss.pre}・不在日曆 ${W.miss.cal}・不在股票池 ${W.miss.univ}`);
    if (!W.blocks.length) { console.log('❌ 一筆鉅額都沒有 → block_deep 還沒抓好?'); process.exit(1); }
    const st = {};
    const ev = enrich(W.blocks.filter(b => b.i <= iCut), W.stocks, st);
    console.log(`   那天沒有一般成交 ${st.noTrade}・均價超出物理範圍(尺標對不上)${st.phys}・用 _sk 換回原始尺標 ${st.scaled}・可用 ${ev.length}`);
    console.log(`   佔比分母(FinMind 總成交股數)算不出 ${st.noTv}(只做溢價 / 折價)・鉅額比當天總成交還多(資料矛盾)${st.overOne}・klines_deep 沒有這檔 ${W.nKdMiss}`);
    if (st.physEx.length) console.log('   超出物理範圍的例子:' + st.physEx.join(' / '));
    const qs = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const evR = ev.filter(e => Number.isFinite(e.ratio)), ratios = evR.map(e => e.ratio), prems = ev.map(e => e.prem);
    console.log(`   佔比 中位 ${qs(ratios, 0.5).toFixed(3)}・前 5% ${qs(ratios, 0.95).toFixed(2)}・前 1% ${qs(ratios, 0.99).toFixed(2)}・溢價 ≥ +1% ${prems.filter(x => x >= 0.01).length} 筆・折價 ≤ −3% ${prems.filter(x => x <= -0.03).length} 筆`);
    const thr1 = expandingQuantile(ratios, 0.99), thr5 = expandingQuantile(ratios, 0.95), thrP = expandingQuantile(evR.map(e => e.pairRatio), 0.95);
    const raw = {
        T1: evR.filter((e, j) => e.ratio >= thr1[j]), T2: evR.filter((e, j) => e.ratio >= thr5[j]),
        T3: ev.filter(e => e.prem >= 0.01), T4: ev.filter(e => e.prem <= -0.03),
        T5: evR.filter((e, j) => e.pair > 0 && e.pairRatio >= thrP[j]),
    };
    console.log(`   門檻(最後那天):佔比前 1% ≥ ${thr1[thr1.length - 1].toFixed(3)}・前 5% ≥ ${thr5[thr5.length - 1].toFixed(3)}・配對前 5% ≥ ${thrP[thrP.length - 1].toFixed(3)}(佔比算得出的 ${evR.length} 筆,${W.cal[evR[0].i]} ~ ${W.cal[evR[evR.length - 1].i]})`);
    const T = Object.fromEntries(Object.entries(raw).map(([k, a]) => [k, dedup(a)]));
    for (const k of Object.keys(T)) {
        const ys = new Set(T[k].map(e => W.cal[e.i].slice(0, 4)));
        console.log(`   ${k} ${NAME[k].padEnd(10)} 原始 ${String(raw[k].length).padStart(6)} → 去重 ${String(T[k].length).padStart(6)} 筆・${new Set(T[k].map(e => e.sym)).size} 檔・${ys.size} 年`);
    }
    // 特徵 / 格
    const list = [...W.stocks.values()];
    const F = list.map(S => features(S, W.cal.length));
    const cells = buildCells(F, W.cal.length);
    list.forEach((S, j) => { S.cell = cells[j]; });
    F.length = 0;
    const noCell = Object.fromEntries(Object.entries(T).map(([k, a]) => [k, a.filter(e => W.stocks.get(e.sym).cell[e.i] < 0).length]));
    console.log(`   事件那天算不出格(上市不到半年 / 位階窗口有斷崖…)→ 不算:${JSON.stringify(noCell)}`);
    if (env.CHECK_ONLY) { console.log(`\n(CHECK_ONLY:只印資料檢查,⛔ 算報酬)${((Date.now() - t0) / 1000).toFixed(0)} 秒`); return; }

    const { A: baseA, B: baseB } = buildBases(W, iCut);
    const blockDays = new Map(); for (const b of W.blocks) { if (b.i > iCut) continue; const a = blockDays.get(b.sym) || []; if (a[a.length - 1] !== b.i) a.push(b.i); blockDays.set(b.sym, a); }
    const nDaysAll = iCut + 1, rows = [];
    for (const key of Object.keys(T)) {
        HS.forEach((H, k) => {
            const rets = evRets(T[key], W, H, iCut);
            const incA = increments(rets, baseA[k]), incB = incCell(rets, baseB[k]);
            const mA = mean(incA.dm), mB = mean(incB.dm);
            const dir = DIR[key] || (mB < 0 ? -1 : 1);
            const density = incB.days.length / nDaysAll;
            const gA = gateDir(incA, H, dir, incA.days.length / nDaysAll), gB = gateDir(incB, H, dir, density);
            const yr = (gB.YR || []).filter(y => y.n >= 20);
            const seed = 20261124 + 97 * HS.indexOf(H) + 7 * Object.keys(T).indexOf(key);
            const vC = shamCell(rets, W, H, baseB[k], SHAM_N, seed), vS = shamShift(rets, W, H, baseB[k], iCut, blockDays, SHIFT_N, seed + 1);
            const trim = trimDir(rets, baseB[k], dir);
            const med = (() => { const s = incB.all.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; })();
            const by = (a, b) => { const xs = incB.days.map((d, j) => [d, incB.dm[j]]).filter(([d]) => d >= a && d <= b).map(x => x[1]); return mean(xs); };
            rows.push({ key, name: NAME[key], H, dir, n: incB.n, nDays: incB.days.length, mA, mB, pA: gA.pNW, pB: gB.pNW, lag: gB.lag,
                        gB: { d: gB.d, H: gB.H, dropBest: gB.dropBest, nPass: gB.nPass, pass: gB.pass }, YR: gB.YR, yrPos: yr.filter(y => y.d > 0).length, yrN: yr.length,
                        shamCell: { med: mean(vC), p: pSham(vC, mB, dir) }, shamShift: { med: mean(vS), p: pSham(vS, mB, dir) },
                        pCell: pSham(vC, mB, dir), pShift: pSham(vS, mB, dir), trim, median: med,
                        split: { a: by('2010-01-01', '2018-12-31'), b: by('2019-01-01', '2026-12-31') },
                        rev: DIR[key] ? { pCell: pSham(vC, mB, -dir), pShift: pSham(vS, mB, -dir) } : null });
        });
    }
    const qA = bhQ(rows.map(r => r.pA)), qB = bhQ(rows.map(r => r.pB));
    rows.forEach((r, j) => { r.qA = qA[j]; r.qB = qB[j]; const J = judge(r); r.c = J.c; r.ok = J.ok; r.nOk = J.n; });
    console.log('\n檢定           抱  方向 筆數   Ⓐ增量  Ⓑ增量  中位   qⒶ    qⒷ   年同向  前後半        去最好年  安慰劑(格/換日)  去極端   判定');
    for (const r of rows) {
        console.log(`${r.name.padEnd(12)} ${String(r.H).padStart(3)}  ${r.dir > 0 ? '＋' : '－'} ${String(r.n).padStart(6)} ${sg(r.mA).padStart(6)} ${sg(r.mB).padStart(6)} ${sg(r.median).padStart(6)} ${r.qA.toFixed(3).padStart(6)} ${r.qB.toFixed(3).padStart(6)}  ${String(r.yrPos).padStart(2)}/${r.yrN}  ${sg(r.dir * r.gB.H[0])}/${sg(r.dir * r.gB.H[1])}  ${sg(r.dir * r.gB.dropBest).padStart(6)}  ${r.pCell.toFixed(3)}/${r.pShift.toFixed(3)}  ${sg(r.dir * r.trim.m).padStart(6)}  ${r.ok ? '✅' : '⛔'} ${r.nOk}/7`);
    }
    const ok = rows.filter(r => r.ok);
    console.log(`\n判定:${ok.length ? '✅ ' + ok.map(r => `${r.name} 抱 ${r.H} 天(${r.dir > 0 ? '之後比較強' : '之後比較弱'})`).join('、') : '⛔ 15 格沒有一格七條全過'}`);
    const surprise = rows.filter(r => r.rev && Math.sign(r.mB) === -r.dir && r.qA <= 0.05 && r.qB <= 0.05 && r.rev.pCell <= 0.05 && r.rev.pShift <= 0.05);
    if (surprise.length) console.log(`⚠️ 意外(跟預期方向相反、而且顯著):${surprise.map(r => `${r.name} 抱 ${r.H} 天`).join('、')} → ⛔ 採用,要另外登記再驗`);
    console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    const res = { updated: new Date().toISOString().slice(0, 10), cutoff: W.cal[iCut], stocks: W.stocks.size, blocks: W.blocks.length, ev: ev.length, evRatio: evR.length,
                  drop: { noTrade: st.noTrade, phys: st.phys, scaled: st.scaled, noTv: st.noTv, overOne: st.overOne, pre2010: W.miss.pre, cal: W.miss.cal, univ: W.miss.univ },
                  range: [W.cal[ev[0].i], W.cal[ev[ev.length - 1].i]], counts: Object.fromEntries(Object.entries(T).map(([k, a]) => [k, { raw: raw[k].length, dedup: a.length }])),
                  rows: rows.map(r => ({ ...r, c: r.c })), ok: ok.map(r => `${r.key}/${r.H}`), surprise: surprise.map(r => `${r.key}/${r.H}`) };
    if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
}

function selftest() {
    let bad = 0;
    const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) bad++; };
    const m = aggDay([['2330', '配對交易', 1000, 1000, 1000000], ['2330', '逐筆交易', 1010, 1000, 1010000], ['00878', '配對交易', 20, 5, 100], ['總計', '', 0, 0, 0]]);
    ok(m.size === 1 && m.get('2330').sh === 2000 && Math.abs(m.get('2330').vwap - 1005) < 1e-9 && m.get('2330').pair === 1000,
       '① 同一檔同一天合起來:股數加總、均價 = 金額 ÷ 股數、配對交易另計;ETF / 總計 ⛔ 收');
    const xs = [...Array(300).keys()].map(i => i % 100);
    const t = expandingQuantile(xs, 0.99, 250);
    ok(t[249] === Infinity && Number.isFinite(t[250]), '② 不到 250 筆不開始(門檻 = 無限大)');
    const xs2 = xs.slice(); xs2[299] = 1e9;
    const t2 = expandingQuantile(xs2, 0.99, 250);
    ok(t.slice(0, 299).every((v, i) => v === t2[i]), '③ ⛔ 前視:最後一筆改成超大,之前每一筆的門檻一個都沒變(門檻只用「之前」的事件)');
    const dd = dedup([{ i: 0, sym: 'A' }, { i: 5, sym: 'A' }, { i: 10, sym: 'A' }, { i: 3, sym: 'B' }].sort((a, b) => a.i - b.i));
    ok(dd.map(e => `${e.sym}${e.i}`).join(',') === 'A0,B3,A10', '④ 同一檔 10 天內只算第一次');

    // 合成世界(全部同一格 → Ⓑ = 同一天全部股票)
    const mkWorld = (nS, T, seedV, bump) => {
        const cal = [...Array(T).keys()].map(i => new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10));
        const calIdx = new Map(cal.map((d, i) => [d, i])), R = rng(seedV), stocks = new Map();
        for (let s = 0; s < nS; s++) {
            const bars = []; let p = 50;
            for (let i = 0; i < T; i++) { p *= 1 + (R() - 0.5) * 0.02 + bump(s, i); bars.push({ date: cal[i], open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 }); }
            const A = alignStock(cal, calIdx, bars, []); A.date = cal; A.cell = new Int8Array(T); A.sk = new Float64Array(T).fill(1);
            stocks.set(String(1000 + s), A);
        }
        return { cal, calIdx, stocks };
    };
    const mkBase = (W, iCut) => buildBases(W, iCut);
    // ⑤ 事件之後 20 天逐日墊高 → 抓得到;同樣檔數隨機日子 ≈ 0
    const T5 = 800, W5 = mkWorld(40, T5, 7, () => 0), evs = [];
    for (let s = 0; s < 40; s++) for (let i0 = 100 + 3 * s; i0 < 700; i0 += 97) {
        const S = W5.stocks.get(String(1000 + s));
        for (let i = i0 + 1; i < T5; i++) { const f = i <= i0 + 20 ? 1 + 0.001 * (i - i0) : 1 + 0.001 * 20; S.o[i] *= f; S.c[i] *= f; S.h[i] *= f; S.l[i] *= f; }
        evs.push({ i: i0, sym: String(1000 + s) });
    }
    const B5 = mkBase(W5, T5 - 1), r5 = evRets(evs.sort((a, b) => a.i - b.i), W5, 20, T5 - 1);
    const inc5 = incCell(r5, B5.B[1]);
    const rnd = rng(3), fake = evs.map(e => ({ i: 100 + Math.floor(rnd() * 600), sym: e.sym })).sort((a, b) => a.i - b.i);
    const incF = incCell(evRets(fake, W5, 20, T5 - 1), B5.B[1]);
    ok(mean(inc5.dm) > 1.0 && Math.abs(mean(incF.dm)) < mean(inc5.dm) / 2,
       `⑤ 合成:鉅額之後 20 天墊高 → 增量 ${sg(mean(inc5.dm))};決定性對照:同樣檔數隨機日子 ${sg(mean(incF.dm))}`);
    // ⑥ 佔比 / 溢價(沒有換尺標)
    const S0 = W5.stocks.get('1000');
    const en = enrich([{ i: 5, sym: '1000', sh: 5e5, val: 5e5 * S0.c[5] * 1.02, vwap: S0.c[5] * 1.02, pair: 0 }], W5.stocks);
    ok(Math.abs(en[0].ratio - 0.5) < 1e-9 && Math.abs(en[0].prem - 0.02) < 1e-9, '⑥ 佔比 = 鉅額股數 ÷ 一般成交股數、溢價 = 鉅額均價 ÷ 收盤 − 1');
    // ⑦ _sk = 4(d16 價 = 原始 ÷ 4、量 = 原始 × 4)→ 換回原始尺標;少了 _sk → 均價 ÷ 收盤 = 4.08 → 超出物理範圍、丟掉
    {
        const S = W5.stocks.get('1001'), i = 50, rawC = S.c[i] * 4, rawV = S.v[i] / 4;
        S.sk[i] = 4;
        const st = {}, e1 = enrich([{ i, sym: '1001', sh: rawV * 0.5, val: 0, vwap: rawC * 1.02, pair: 0 }], W5.stocks, st);
        S.sk[i] = 1;
        const st2 = {}, e2 = enrich([{ i, sym: '1001', sh: rawV * 0.5, val: 0, vwap: rawC * 1.02, pair: 0 }], W5.stocks, st2);
        ok(e1.length === 1 && Math.abs(e1[0].prem - 0.02) < 1e-9 && Math.abs(e1[0].ratio - 0.5) < 1e-9 && st.scaled === 1 && e2.length === 0 && st2.phys === 1,
           `⑦ 分割前那段用 _sk 換回原始尺標(溢價 ${e1[0] ? sg(e1[0].prem * 100) : '—'}%、佔比 ${e1[0] ? e1[0].ratio.toFixed(2) : '—'});決定性對照:少了 _sk → 均價是收盤的 4 倍 → 物理上不可能、丟掉`);
    }
    // ⑧ 物理範圍照日期:2012(±7%)1.16 倍 → 超出;2016(±10%)→ 還在範圍內
    {
        const [lo12, hi12] = physRange('2012-03-01'), [lo16, hi16] = physRange('2016-03-01');
        ok(!(1.16 <= hi12) && 1.16 <= hi16 && lo12 > lo16, `⑧ 物理範圍跟著漲跌幅制度:2015-06 前 ±7% → ${lo12.toFixed(3)}~${hi12.toFixed(3)}、之後 ±10% → ${lo16.toFixed(3)}~${hi16.toFixed(3)}`);
    }
    // ⑨ 特徵 ⛔ 前視:第 300 天以後的資料整段改掉 → 第 300 天以前的特徵一個都沒變
    {
        const S = W5.stocks.get('1002'), T = W5.cal.length;
        const f1 = features(S, T);
        const keep = ['o', 'h', 'l', 'c', 'v'].map(k => S[k].slice());
        for (let i = 301; i < T; i++) { S.c[i] *= 3; S.h[i] *= 3; S.l[i] *= 0.2; S.v[i] *= 9; }
        const f2 = features(S, T);
        ['o', 'h', 'l', 'c', 'v'].forEach((k, j) => S[k].set(keep[j]));
        const same = ['amt', 'pos', 'vol'].every(k => { for (let i = 0; i <= 300; i++) { const a = f1[k][i], b = f2[k][i]; if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) return false; } return true; });
        const changed = ['amt', 'pos', 'vol'].some(k => f1[k][T - 1] !== f2[k][T - 1]);
        ok(same && changed, '⑨ ⛔ 前視:把第 300 天以後的價量整段改掉,第 300 天以前的成交金額 / 位階 / 波動一個都沒變(之後的有變 = 測試有鑑別力)');
    }
    // ⑩ 格只用同一天的截面:別天的值改掉,這一天的格不變;那天不到 minN 檔 → −1
    {
        const T = 5, mk = v => ({ amt: Float64Array.from({ length: T }, () => v[0]), pos: Float64Array.from({ length: T }, () => v[1]), vol: Float64Array.from({ length: T }, () => v[2]) });
        const F = [...Array(60).keys()].map(j => mk([1 + j, (j % 7) / 7, (j % 11) / 11]));
        const c1 = buildCells(F, T);
        const R10 = rng(13); F.forEach(f => { f.amt[3] = R10(); f.pos[3] = R10(); });
        const c2 = buildCells(F, T);
        const fewF = F.slice(0, 10), c3 = buildCells(fewF, T);
        ok(c1.every((a, j) => a[2] === c2[j][2]) && c1.some((a, j) => a[3] !== c2[j][3]) && c3.every(a => a[2] === -1) && new Set(c1.map(a => a[2])).size > 5,
           '⑩ 三分位只用同一天的股票:改掉第 4 天的值,第 3 天的格一個都沒變;那天不到 30 檔 → 不分格');
    }
    // ⑪ Newey-West:重疊窗口(相鄰高度相關)→ p 比一般 t 檢定大
    {
        const R = rng(11), e = [...Array(600)].map(() => R() - 0.5), x = e.map((_, i) => { let s = 0; for (let k = 0; k < 20 && i - k >= 0; k++) s += e[i - k]; return s / 20 + 0.01; });
        const inc = { n: x.length, days: x.map((_, i) => `2016-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`), dm: x, all: x };
        const g = gateDir(inc, 20, 1, 1);
        ok(g.pNW > g.p && g.lag === 19, `⑪ 抱 20 天、天天有事件 → lag 19、Newey-West p ${g.pNW.toFixed(3)} > 一般 t 檢定 ${g.p.toFixed(3)}`);
    }
    // ⑫ 換日安慰劑分得出「時間點」與「這檔本來就強」:
    //    A 世界(事件之後才強)→ 換日安慰劑 p 很小;B 世界(這幾檔天天都多漲、事件日是隨便挑的)→ 增量一樣是正的,但換日安慰劑 p 大
    {
        const T = 900, iCut = T - 1, pick = rng(5);
        const evA = [], WA = mkWorld(60, T, 21, () => 0);
        for (let s = 0; s < 30; s++) for (let i0 = 150 + 5 * s; i0 < 750; i0 += 131) {
            const S = WA.stocks.get(String(1000 + s));
            for (let i = i0 + 1; i < T; i++) { const f = i <= i0 + 20 ? 1 + 0.0015 * (i - i0) : 1 + 0.0015 * 20; S.o[i] *= f; S.c[i] *= f; S.h[i] *= f; S.l[i] *= f; }
            evA.push({ i: i0, sym: String(1000 + s) });
        }
        const WB = mkWorld(60, T, 21, s => (s < 30 ? 0.002 : 0)), evB = [];
        for (let s = 0; s < 30; s++) for (let k = 0; k < 4; k++) evB.push({ i: 150 + Math.floor(pick() * 600), sym: String(1000 + s) });
        const run = (W, evl) => {
            evl.sort((a, b) => a.i - b.i);
            const B = buildBases(W, iCut), rets = evRets(evl, W, 20, iCut), inc = incCell(rets, B.B[1]);
            const bd = new Map(); for (const e of evl) { const a = bd.get(e.sym) || []; a.push(e.i); bd.set(e.sym, a); }
            const vS = shamShift(rets, W, 20, B.B[1], iCut, bd, 60, 9), vC = shamCell(rets, W, 20, B.B[1], 60, 9);
            return { m: mean(inc.dm), pS: pSham(vS, mean(inc.dm), 1), pC: pSham(vC, mean(inc.dm), 1) };
        };
        const a = run(WA, evA), b = run(WB, evB);
        ok(a.m > 1 && a.pS <= 0.05 && a.pC <= 0.05 && b.m > 1 && b.pS > 0.05 && b.pC <= 0.05,
           `⑫ 換日安慰劑:事件之後才強 → 增量 ${sg(a.m)}、換日 p ${a.pS.toFixed(3)};決定性對照「這幾檔本來就天天強」→ 增量 ${sg(b.m)} 但換日 p ${b.pS.toFixed(3)}(同一天同格安慰劑 p ${b.pC.toFixed(3)} 分不出來)`);
    }
    // ⑬ 去極端:一筆超大的撐起平均 → 拿掉最大 1% 之後翻負
    {
        const base = new Map([['d|0', { s: 0, n: 10 }]]), rets = [...Array(200)].map((_, j) => ({ d: `2016-01-${String(1 + (j % 28)).padStart(2, '0')}`, key: 'd|0', r: j === 7 ? 5000 : -1 }));
        const full = mean(incCell(rets, base).dm), tr = trimDir(rets, base, 1);
        ok(full > 0 && tr.m < 0 && tr.drop === 2, `⑬ 去極端 1%:全部平均 ${sg(full)} 是一筆撐起來的 → 拿掉最大 ${tr.drop} 筆變 ${sg(tr.m)}`);
    }
    // ⑭ 🔒 出場日超過封存日的事件不算
    {
        const S = W5.stocks.get('1003'); S.cell.fill(0);
        const rr = evRets([{ i: 600, sym: '1003' }, { i: 790, sym: '1003' }], W5, 20, 800 - 15);
        ok(rr.length === 1 && rr[0].i === 600, '⑭ 🔒 出場日在封存日之後的事件 ⛔ 算(只用封存日以前的資料下判定)');
    }
    // ⑮ 判定:T4(預期之後比較弱)結果卻是正的 → ①就不會過;方向 −1 的六關 = 增量取負號再過
    {
        const fake = { qA: 0.001, qB: 0.001, mA: 2, mB: 2, dir: -1, gB: { d: -2, H: [-1, -1], dropBest: -1 }, yrPos: 0, yrN: 10, pCell: 0.9, pShift: 0.9, trim: { m: -1 } };
        const J = judge(fake);
        const inc = { n: 50, days: [...Array(50).keys()].map(i => `20${10 + (i % 10)}-01-0${1 + (i % 9)}`), dm: [...Array(50)].map((_, i) => -1 - (i % 3) * 0.1), all: [] };
        const g1 = gateDir(inc, 5, -1, 0.5), g2 = gates(negate(inc), COST);
        ok(!J.ok && !J.c['①兩種對照 q≤0.05 同方向'] && Math.abs(g1.d - g2.d) < 1e-12 && g1.d > 0,
           '⑮ 預期方向寫死:T4 結果是正的 → ① 不過;方向 −1 = 增量取負號再過同一套關卡');
    }
    // ⑯ 佔比的分母 = 當天總成交股數(含鉅額,FinMind 口徑):有 klines_deep 用它;2021 前用 d16 ÷ _sk;2021 後沒有 → 佔比算不出(溢價照算);
    //    鉅額比總成交還多 = 資料矛盾 → 佔比不算。決定性對照:同一天把本站「不含鉅額」的成交量當分母 → 佔比會 > 1
    {
        const T = 4, mkS = (date, v, kv, sk) => ({ c: Float64Array.from([100, 100, 100, 100]), v: Float64Array.from([v, v, v, v]), sk: Float64Array.from([sk, sk, sk, sk]),
                                                  kv: Float64Array.from([kv, kv, kv, kv]), date: Array(T).fill(date) });
        const stocks = new Map([['1001', mkS('2024-05-02', 1e6, 3e6, 1)], ['1002', mkS('2015-05-04', 8e6, NaN, 4)], ['1003', mkS('2026-09-15', 1e6, NaN, 1)], ['1004', mkS('2024-05-02', 1e6, 1.5e6, 1)]]);
        const blk = sym => { const px = 101 * stocks.get(sym).sk[1]; return { i: 1, sym, sh: 2e6, val: 2e6 * px, vwap: px, pair: 2e6 }; };   // 均價照原始尺標(d16 收盤 × _sk)
        const st = {}, e = enrich(['1001', '1002', '1003', '1004'].map(blk), stocks, st);
        const by = Object.fromEntries(e.map(x => [x.sym, x]));
        ok(Math.abs(by['1001'].ratio - 2 / 3) < 1e-9 && Math.abs(by['1002'].ratio - 1) < 1e-9 && Number.isNaN(by['1003'].ratio) && Math.abs(by['1003'].prem - 0.01) < 1e-9
           && Number.isNaN(by['1004'].ratio) && st.noTv === 1 && st.overOne === 1 && 2e6 / 1e6 > 1,
           `⑯ 佔比分母:有 FinMind 總成交用它(2/3)・2021 前 d16 ÷ _sk(1.00)・2021 後沒有 → 佔比算不出、溢價照算・鉅額比總成交還多 → 資料矛盾不算;決定性對照:拿本站「不含鉅額」的量當分母 = ${(2e6 / 1e6).toFixed(1)}(> 1)`);
    }
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過');
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
}
