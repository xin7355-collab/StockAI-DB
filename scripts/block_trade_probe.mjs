#!/usr/bin/env node
/**
 * 🐘 鉅額交易之後,那檔股票會比較強還是比較弱?(V80.1.9 寫好、V82.6.3 資料到齊後補方法再跑;評估紀錄 52 策略 D + LAB「💵 鉅額交易」)
 *
 * 資料:證交所 BFIAUU 2009 起每一天的鉅額交易(block_deep 分支,block_deep_fetch.py)+ 研究資料包 d16(含下市、除權息)。
 *   ⚠️ 只有上市(BFIAUU 只有上市)。鉅額當天收盤後才公布 → 第二天開盤才算知道。成交量 0 的列(停牌時帶上一天收盤的佔位列)當沒有交易。
 * 一天一檔先合起來:鉅額股數 = 那天所有鉅額列加總、鉅額均價 = 金額 ÷ 股數。
 *   d16 在分割 / 面額變更之前那段換過尺標(列上 `_sk` = 股數倍數:d16 收盤 × _sk = 當時的原始收盤、d16 成交量 ÷ _sk = 原始成交量,
 *   merge_stock_deep.share_scale)→ 溢價 = 鉅額均價 ÷ 原始收盤 − 1(2021 起直接用 klines_deep 的原始收盤;沒有才用 d16 × _sk)。
 *   🚨 佔比的分母要同一個口徑:FinMind 的成交量「含鉅額」(2010~2023-05 的 3.6 萬筆鉅額沒有一筆超過當天成交量),本站 data 分支
 *   2023-05 起的成交量有些天含、有些天不含(同一天跟 FinMind 比:一樣 7,887 筆、差剛好一筆鉅額 301 筆、差鉅額 + 一點點 3,112 筆)
 *   → 佔比 = 鉅額股數 ÷ 當天總成交股數(含鉅額,FinMind 口徑):2021 起讀 klines_deep 的原始成交量(KD_DIR),
 *   2021 前 d16 本身就是 FinMind(÷ _sk 換回原始);2021 後 klines_deep 沒有那一天(2026-09 以後)→ 佔比算不出、只做溢價 / 折價。
 *   鉅額價格也在當天漲跌幅之內 → 均價 ÷ 收盤 超出 (1−L)/(1+L) ~ (1+L)/(1−L)(L = 當天漲跌幅)= 尺標還是對不上 → 丟掉、列數。
 *   鉅額比當天總成交還多 = 資料矛盾 → 佔比、溢價都不用。
 * 五個檢定 × 抱 5 / 20 / 60 天(15 格一起 BH):
 *   T1 佔比前 1%   T2 佔比前 5%   (門檻 = 「之前」所有鉅額事件的分位數,⛔ 用到未來;至少 250 筆才開始)
 *   T3 溢價成交(≥ 收盤 +1%,預期之後比較強)   T4 折價成交(≤ 收盤 −3%,預期之後比較弱)
 *   T5 配對交易而且佔比前 5%(協議成交,最像大股東轉讓)   —— T1 / T2 / T5 方向不預設(看 Ⓑ 全期那個方向,p 一律雙尾)
 * 規則:隔天開盤買(開盤一價鎖漲停 = 買不到、不算;基準 = 參考價,除權息那天要先扣;漲停價照跳動單位往下捨)、含息、同一檔 10 天內只算第一次。
 *   出場:第 H 天收盤;那天沒交易(停牌 / 下市)或中間碰到斷崖 → 用「最後一根有交易、斷崖之前」的收盤(⛔ 整筆丟掉 = 倖存者偏誤)。
 *   斷崖 = 跟前一根(扣掉除權息的參考價)比,開盤或收盤超出當天漲跌幅(物理上不可能 = 尺標變了 / 減資恢復交易 / 興櫃那段)、
 *   或停牌 / 沒成交 ≥ 3 個交易日之後恢復的那一根(減資換股停止買賣)、或舊規則 ×1.5 / ×0.67。
 * 股票池 = 「那一天之前已經出現在上市鉅額名單」的股票日(證明那天是上市;⛔ 用今天的上市名單往回套 —— 會混進上市前的上櫃 / 興櫃那段,
 *   而且等於用未來挑對照組)。舊母體(今天上市 + 已下市的全部歷史)當敏感度,兩個都要過才算。
 * 兩種對照(都要過):Ⓐ 同一天股票池全部 Ⓑ 同一天同一格(前 20 日平均成交金額(⛔ 含當天:當天的量含鉅額本身)× 一年位階 × 20 日波動
 *   各三分位 = 27 格;特徵只用當天以前的資料、三分位只用當天的股票)。Ⓐ 跟事件一樣只收「那天算得出格」的;對照平均一律扣掉自己那一筆。
 *   只描述(⛔ 影響判定):Ⓒ 同一天同一格再切「當天漲跌」三分位(看是不是只是短線反轉)。
 * 檢定:先每天平均,p = 「H 天一段」的區塊穩健 t(每段加總、相鄰兩段的共變異也算進去、自由度 = 段數 − 1)。
 *   ⛔ 舊的 Newey-West(lag 照全期平均事件密度)在同一檔每 10 天一筆、抱 60 天時,沒效果也有 14% 的機會 p ≤ 0.05(審查 #1)。
 * 兩種安慰劑(都要過;方向沒預設的雙尾):
 *   ① 同一天同一格隨便挑一檔(500 次;同一檔窗口連在一起的那幾筆用同一檔替身,保留重疊)
 *   ② 同一串(同一檔、窗口重疊)整段一起挪到前後 H+20 ~ H+770 個交易日(200 次;只從「整串挪過去都還在股票池、有格」的位移裡抽,
 *      一個位移都沒有的整串兩邊一起拿掉;安慰劑沿用實際值每一天的權重)
 *   去極端 1% 照「串」拿(同一段大漲在抱 60 天時會被算好幾次)。
 *   📏 兩種 p 都拿「真實事件的時間點 × 沒效果的世界」校準過(200 個世界、名目 5%):區塊 p 15 格 3.5~7.0%;換日安慰劑挪 H+20~H+270 時
 *      抱 60 天有一格 10% → 照事先寫死的選法改成 H+20~H+770(最高 7.0%);同格安慰劑 2~7%。第二輪審查改完換日安慰劑之後重新校準(見 DECISIONS)。
 * 🔒 樣本外封存:事件日與出場日都 ≤ 2026-11-06(LAB oos-seal)。判定條件寫在實驗登錄(EXP-20261124-01)。
 * 🔍 2026-11-24 獨立審查 13 點(重疊窗口當獨立樣本、安慰劑太窄、單尾、母體、減資跳價、除息日鎖漲停、下市整筆消失…)→
 *   全部照上面改完才下判定;第一次跑的結果作廢(docs/DECISIONS.md 那一節有原文與作廢的數字)。
 *   第二輪審查(改完之後再派一個不知道結果的)6 點:換日安慰劑兩個洞(晚進股票池的被漏掉、同一天擠很多筆的權重不一樣)、
 *   漲停價沒照跳動單位、去極端一筆一筆拿、對照含自己、兩個股票池沒比方向 → 也全部改完(selftest ㉕~㉚)。
 *
 * 跑法:DATA_DIR=<d16> BLOCK_DIR=<block_deep 資料夾> KD_DIR=<klines_deep 資料夾> IDX_LONG=<idx_long.json> node --max-old-space-size=8000 scripts/block_trade_probe.mjs out.json
 *       CHECK_ONLY=1 …(只印資料檢查:事件數 / 丟掉幾筆 / 佔比分布 / 斷崖,⛔ 算任何報酬)
 *       node scripts/block_trade_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { gates, COST, baseAdd, negate } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';
import { alignStock, nwP } from './trade_lead_probe.mjs';
import { limitOf, lockedBar } from './lib_limit.mjs';
import { tickOf, floorTick } from './gap_base.mjs';

export const HS = [5, 20, 60];
const DEDUP = 10;
const MIN_HIST = 250;
const SHAM_N = 500, SHIFT_N = 200;
export const SHIFT_GAP = 20, SHIFT_SPAN = 750;   // 換日安慰劑:挪 H+20 ~ H+770 個交易日(⛔ 跟自己的窗口重疊;250 時太窄,校準見檔頭)
export const GAP_CLIFF = 3;                      // 停牌 / 沒成交幾個交易日以上,恢復的那一根當斷崖
export const JUMP_TOL = 0.01;                    // 超出漲跌幅多少才算「物理上不可能」(漲跌停價有跳動單位捨入)
const MIN_CELL = 5;                 // 那一格那一天至少幾檔才拿來當對照
export const CUTOFF = '2026-11-06'; // 🔒 樣本外封存(2026-11-07 起的資料只拿來驗)
export const KD_FROM = '2021-01-04';  // klines_deep(FinMind 原始日 K)從這天起;之前 d16 本身就是 FinMind
export const DIR = { T1: 0, T2: 0, T3: 1, T4: -1, T5: 0 };   // 預期方向:0 = 不預設(p 一律雙尾)
const NAME = { T1: '佔比前 1%', T2: '佔比前 5%', T3: '溢價 ≥ +1%', T4: '折價 ≤ −3%', T5: '配對佔比前 5%' };
const UNIV = { listed: '那天已上市(主)', all: '舊母體(敏感度)' };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sg = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const rng = s => () => ((s = (s * 16807) % 2147483647) / 2147483647);

// ───────── t 分配(區塊檢定的段數不多,⛔ 用常態近似)─────────
function lgamma(x) {
    const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1; let a = C[0]; const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += C[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a, b, x) {
    const FP = 1e-300; let c = 1, d = 1 - (a + b) * x / (a + 1); if (Math.abs(d) < FP) d = FP; d = 1 / d; let h = d;
    for (let m = 1; m <= 300; m++) {
        const m2 = 2 * m; let aa = m * (b - m) * x / ((a - 1 + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d; h *= d * c;
        aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + 1 + m2));
        d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d;
        const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-14) break;
    }
    return h;
}
const ibeta = (x, a, b) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
};
/** t 分配雙尾 p */
export const pT = (t, df) => Number.isFinite(t) && df > 0 ? ibeta(df / (df + t * t), df / 2, 0.5) : 1;

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

/** 鉅額事件 → 佔比 / 溢價(收盤用 klines_deep 原始收盤,沒有才用 d16 × _sk);那天沒有一般成交 / 均價超出物理範圍 → 丟掉,計數進 st;
 *  佔比的分母算不出 → ratio = NaN(只做溢價 / 折價);鉅額比當天總成交股數還多 = 資料矛盾 → ratio、溢價都 NaN、計數 */
export function enrich(blocks, stocks, st = {}) {
    for (const k of ['noTrade', 'phys', 'scaled', 'noTv', 'overOne', 'rawClose', 'rawDiff']) st[k] = st[k] || 0;
    st.physEx = st.physEx || [];
    const out = [];
    for (const b of blocks) {
        const S = stocks.get(b.sym), v = S.v[b.i], c = S.c[b.i];
        if (!(v > 0) || !(c > 0)) { st.noTrade++; continue; }
        const sk = S.sk && S.sk[b.i] > 0 ? S.sk[b.i] : 1, kc = S.kc ? S.kc[b.i] : NaN;
        let rc = c * sk;
        if (kc > 0) { st.rawClose++; if (Math.abs(rc / kc - 1) > 0.005) st.rawDiff++; rc = kc; }
        const q = b.vwap / rc;
        const [lo, hi] = physRange(S.date ? S.date[b.i] : '2020-01-01');
        if (!(q >= lo - 1e-9 && q <= hi + 1e-9)) {
            st.phys++;
            if (st.physEx.length < 8) st.physEx.push(`${b.sym}@${S.date ? S.date[b.i] : b.i} 均價 ${b.vwap.toFixed(2)} ÷ 收盤 ${rc.toFixed(2)} = ${q.toFixed(3)}`);
            continue;
        }
        if (sk !== 1) st.scaled++;
        const tv = totalVol(S, b.i, sk);
        let ratio = tv > 0 ? b.sh / tv : NaN, pairRatio = tv > 0 ? b.pair / tv : NaN, prem = q - 1;
        if (!(tv > 0)) st.noTv++;
        else if (ratio > 1.001) { st.overOne++; ratio = NaN; pairRatio = NaN; prem = NaN; }
        out.push({ ...b, ratio, prem, pairRatio });
    }
    return out;
}

/** 斷崖(審查 #9):跟前一根有交易的比(參考價 = 前收 ÷ 中間的除權息因子),開盤或收盤超出當天漲跌幅 + JUMP_TOL → 物理上不可能
 *  (減資恢復交易 / 沒記到的除權 / 資料錯 / 沒有漲跌幅的那段);舊規則(alignStock 的 ×1.5 / ×0.67)—— 這兩種 = 尺標變了(S.mkS);
 *  停牌 / 沒成交 ≥ GAP_CLIFF 個交易日之後恢復的那一根(可能是在漲跌幅之內的小減資)—— 只讓持有窗口提早出場,⛔ 算尺標變了。
 *  → S.mk(報酬用:三種都算)、S.cliff(前綴和,蓋掉 alignStock 的)、S.lastS(最近一次尺標變動在哪一根,位階用)、S.ldv(除權息因子取 log 的前綴和)。
 *  回 {nJ, nG} 新增幾根 */
export function markCliffs(S, gapMin = GAP_CLIFF, tol = JUMP_TOL) {
    const T = S.c.length, mk = new Uint8Array(T), mkS = new Uint8Array(T), ldv = new Float64Array(T + 1);
    for (let i = 0; i < T; i++) ldv[i + 1] = ldv[i] + Math.log(S.divf[i] > 0 ? S.divf[i] : 1);
    let p = -1, nJ = 0, nG = 0;
    for (let i = 0; i < T; i++) {
        if (!(S.c[i] > 0)) continue;
        if (p >= 0) {
            if (S.cliff[i + 1] - S.cliff[i] > 0) mkS[i] = 1;
            const ref = S.c[p] / Math.exp(ldv[i + 1] - ldv[p + 1]), L = limitOf(S.date ? S.date[i] : '2020-01-01') + tol;
            const o = S.o[i] > 0 ? S.o[i] : S.c[i], a = S.c[i] / ref, b = o / ref;
            if (a > 1 + L || a < 1 - L || b > 1 + L || b < 1 - L) { if (!mkS[i]) nJ++; mkS[i] = 1; }
            mk[i] = mkS[i];
            if (!mk[i] && i - p - 1 >= gapMin) { nG++; mk[i] = 1; }
        }
        p = i;
    }
    const cliff = new Int32Array(T + 1), lastS = new Int32Array(T);
    for (let i = 0; i < T; i++) { cliff[i + 1] = cliff[i] + mk[i]; lastS[i] = mkS[i] ? i : (i ? lastS[i - 1] : -1); }
    S.mk = mk; S.mkS = mkS; S.cliff = cliff; S.lastS = lastS; S.ldv = ldv;
    return { nJ, nG };
}

/** 開盤一價到底鎖漲停(審查第二輪:漲停價要照跳動單位往下捨 —— 參考價 99 的漲停價是 108.5 = +9.6%,⛔ 只拿 +9.7% 判會當成買得到):
 *  一價到底(高 = 低)而且開盤 ≥ 漲停價 − 一檔(參考價是自己算的,可能跟官方差一檔)。價格先乘 _sk 換回原始尺標再對跳動單位。 */
export function lockedUp(date, ref, o, h, l, sk = 1) {
    if (!(ref > 0 && o > 0) || h !== l) return false;
    const up = ref * sk * (1 + limitOf(date));
    return o * sk >= floorTick(up) - tickOf(up) - 1e-9;
}

/** 一檔:第 e 天開盤買、第 x 天收盤賣(含息)→ {r 報酬 %, y 實際出場那天};買不到 → null。
 *  鎖漲停的基準 = 前一根有交易的收盤 ÷ 除權息因子(審查 #10:除息日參考價比較低),漲停價照跳動單位(lockedUp)。進場那根本身是斷崖 → 不算(開盤跟前收不同尺標)。
 *  出場那天沒交易 / 中間有斷崖 → 最後一根有交易、斷崖之前的收盤(審查 #8:停牌 / 下市 ⛔ 整筆丟掉)。 */
export function fwdX(S, e, x) {
    if (e < 1 || x >= S.c.length || !(S.o[e] > 0) || S.mk[e]) return null;
    let p = e - 1; while (p >= 0 && !(S.c[p] > 0)) p--;
    if (p >= 0 && lockedUp(S.date ? S.date[e] : '2020-01-01', S.c[p] / Math.exp(S.ldv[e + 1] - S.ldv[p + 1]), S.o[e], S.h[e], S.l[e], S.sk && S.sk[e] > 0 ? S.sk[e] : 1)) return null;
    let y = x;
    if (S.cliff[x + 1] - S.cliff[e + 1] > 0) { for (let k = e + 1; k <= x; k++) if (S.mk[k]) { y = k - 1; break; } }
    while (y > e && !(S.c[y] > 0)) y--;
    if (!(S.c[y] > 0)) return null;
    return { r: (S.c[y] * Math.exp(S.ldv[y + 1] - S.ldv[e + 1]) / S.o[e] - 1) * 100, y };
}
export const fwd = (S, e, x) => { const o = fwdX(S, e, x); return o ? o.r : null; };

/** 第 i 天收盤時(只用 ≤ i 的資料):前 20 日平均成交金額(⛔ 含第 i 天:那天的量含鉅額本身,審查 #6)、一年(250 根)位階、20 日波動。算不出 = NaN。
 *  成交金額 = 收盤 × 成交量(d16 換尺標時價 ÷ k、量 × k → 乘起來不變);
 *  位階 = 最近 250 根、但只從最近一次尺標變動那一根起算(至少 120 根有交易);波動只用相鄰兩根都有交易、中間沒有斷崖的日報酬。 */
export function features(S, T) {
    const amt = new Float64Array(T).fill(NaN), pos = new Float64Array(T).fill(NaN), vol = new Float64Array(T).fill(NaN);
    const { c, v, h, l, cliff } = S, lastS = S.lastS;
    for (let i = 0; i < T; i++) {
        if (!(c[i] > 0)) continue;
        let sa = 0, na = 0;
        for (let t = Math.max(0, i - 20); t <= i - 1; t++) if (c[t] > 0 && v[t] > 0) { sa += c[t] * v[t]; na++; }
        if (na >= 10) amt[i] = sa / na;
        let s1 = 0, s2 = 0, nv = 0;
        for (let t = Math.max(1, i - 19); t <= i; t++) {
            if (c[t] > 0 && c[t - 1] > 0 && cliff[t + 1] - cliff[t] === 0) { const x = Math.log(c[t] / c[t - 1]); s1 += x; s2 += x * x; nv++; }
        }
        if (nv >= 10) vol[i] = Math.sqrt(Math.max(0, (s2 - s1 * s1 / nv) / (nv - 1)));
        const a = Math.max(0, i - 249, lastS ? lastS[i] : 0);
        if (lastS || cliff[i + 1] - cliff[a + 1] === 0) {
            let mx = -Infinity, mn = Infinity, np = 0;
            for (let t = a; t <= i; t++) if (c[t] > 0) { if (h[t] > mx) mx = h[t]; if (l[t] < mn) mn = l[t]; np++; }
            if (np >= 120 && mx > mn) pos[i] = (c[i] - mn) / (mx - mn);
        }
    }
    return { amt, pos, vol };
}

/** 每天:三個特徵各自在「當天三個都算得出來、而且在股票池裡的股票」裡切三分位 → 格 0~26(算不出 / 不在股票池 / 那天不到 minN 檔 = −1)。
 *  只用同一天的截面。first[j] = 第 j 檔從哪一天起算在股票池(null = 全部都算)。 */
export function buildCells(F, T, minN = 30, first = null) {
    const cells = F.map(() => new Int8Array(T).fill(-1));
    const cut = a => { const s = Float64Array.from(a).sort(); return [s[Math.floor(s.length / 3)], s[Math.floor(2 * s.length / 3)]]; };
    const bk = (x, t) => x < t[0] ? 0 : (x < t[1] ? 1 : 2);
    for (let i = 0; i < T; i++) {
        const A = [], P = [], V = [], who = [];
        for (let j = 0; j < F.length; j++) {
            if (first && !(i >= first[j])) continue;
            const a = F[j].amt[i], p = F[j].pos[i], v = F[j].vol[i];
            if (a > 0 && Number.isFinite(p) && Number.isFinite(v)) { A.push(a); P.push(p); V.push(v); who.push(j); }
        }
        if (who.length < minN) continue;
        const ca = cut(A), cp = cut(P), cv = cut(V);
        for (let k = 0; k < who.length; k++) cells[who[k]][i] = bk(A[k], ca) * 9 + bk(P[k], cp) * 3 + bk(V[k], cv);
    }
    return cells;
}

/** 只描述 Ⓒ:每天,那天有格的股票按「當天漲跌」(對參考價、含除權息;斷崖那根算不出)切三分位 → 0/1/2,算不出 = −1 */
export function buildRetTerc(list, T, minN = 30) {
    const dr = list.map(S => {
        const a = new Float64Array(T).fill(NaN); let p = -1;
        for (let i = 0; i < T; i++) { if (!(S.c[i] > 0)) continue; if (p >= 0 && !S.mk[i]) a[i] = S.c[i] * Math.exp(S.ldv[i + 1] - S.ldv[p + 1]) / S.c[p] - 1; p = i; }
        return a;
    });
    const out = list.map(() => new Int8Array(T).fill(-1));
    for (let i = 0; i < T; i++) {
        const xs = [], who = [];
        for (let j = 0; j < list.length; j++) { const x = dr[j][i]; if (list[j].cell[i] >= 0 && Number.isFinite(x)) { xs.push(x); who.push(j); } }
        if (who.length < minN) continue;
        const s = Float64Array.from(xs).sort(), t1 = s[Math.floor(s.length / 3)], t2 = s[Math.floor(2 * s.length / 3)];
        who.forEach((j, k) => { out[j][i] = xs[k] < t1 ? 0 : (xs[k] < t2 ? 1 : 2); });
    }
    return out;
}

/** 增量:每一筆減「同一天同一格、扣掉自己」的平均(對照本來就收了自己那一筆 —— 含自己會把增量縮成 (1 − 1/n) 倍,審查第二輪;
 *  扣掉自己之後那格那天 < minCell 檔不算),再照日期收成每天一個平均(同 lib_evgate.increments 的口徑)。
 *  kf = 用哪個欄位當對照的鍵(key = Ⓑ、keyC = Ⓒ、d = Ⓐ 同一天全部) */
export const xOf = (e, b) => e.r - (b.s - e.r) / (b.n - 1);
export function incCell(evs, base, minCell = MIN_CELL, kf = 'key') {
    const byDay = new Map(); let n = 0;
    for (const e of evs) {
        const k = e[kf]; if (k == null) continue;
        const b = base.get(k); if (!b || b.n - 1 < minCell) continue;
        const a = byDay.get(e.d) || []; a.push(xOf(e, b)); byDay.set(e.d, a); n++;
    }
    const days = [...byDay.keys()].sort();
    return { n, days, dm: days.map(d => { const a = byDay.get(d); return a.reduce((s, x) => s + x, 0) / a.length; }), all: days.flatMap(d => byDay.get(d)) };
}

/** 事件 → [{d, key, keyC, r, i, sym, cell, y}](出場日超過 iCut / 那天沒有格 / 買不到 → 不算) */
export function evRets(evs, W, H, iCut) {
    const out = [];
    for (const e of evs) {
        if (e.i + H > iCut) continue;
        const S = W.stocks.get(e.sym), cell = S.cell ? S.cell[e.i] : 0;
        if (cell < 0) continue;
        const o = fwdX(S, e.i + 1, e.i + H); if (!o) continue;
        const rt = S.rt ? S.rt[e.i] : -1, d = W.cal[e.i];
        out.push({ d, key: d + '|' + cell, keyC: rt >= 0 ? d + '|' + (cell * 3 + rt) : null, r: o.r, i: e.i, sym: e.sym, cell, y: o.y });
    }
    return out;
}

/** 對照:Ⓐ 同一天股票池全部(key = 日期)Ⓑ 同一天同一格(key = 日期|格)Ⓒ 再切當天漲跌三分位(只描述)。
 *  只收「那天算得出格」(= 在股票池、特徵算得出)而且出場日 ≤ iCut 的(Ⓐ 也是,審查 #4:跟事件同一個資格) */
export function buildBases(W, iCut) {
    const A = HS.map(() => new Map()), B = HS.map(() => new Map()), C = HS.map(() => new Map());
    for (const S of W.stocks.values()) {
        for (let i = 1; i <= iCut; i++) {
            const cell = S.cell ? S.cell[i] : 0;
            if (cell < 0 || !(S.c[i] > 0)) continue;
            const rt = S.rt ? S.rt[i] : -1;
            for (let k = 0; k < HS.length; k++) {
                const H = HS[k]; if (i + H > iCut) continue;
                const r = fwd(S, i + 1, i + H); if (r == null) continue;
                baseAdd(A[k], W.cal[i], r);
                baseAdd(B[k], W.cal[i] + '|' + cell, r);
                if (rt >= 0) baseAdd(C[k], W.cal[i] + '|' + (cell * 3 + rt), r);
            }
        }
    }
    return { A, B, C };
}

/** 區塊穩健 p(審查 #1):事件日照交易日編號切成 H 天一段 → 每段的每日增量加總 S_k、天數 n_k;
 *  殘差 e_k = S_k − n_k·平均;變異 = Σe² + 2Σ(相鄰兩段 e_k·e_{k+1})(⛔ 比 Σe² 小)× G/(G−1);t 分配、自由度 G − 1。
 *  H 天一段 → 窗口只會跟下一段的窗口重疊,同一檔 / 同一時期擠在一起的都算進同一段或相鄰段。idxOf(日期) → 交易日編號。 */
export function blockP(inc, H, idxOf) {
    const N = inc.dm.length, m = mean(inc.dm), G = new Map();
    inc.days.forEach((d, j) => { const k = Math.floor(idxOf(d) / H); const g = G.get(k) || { s: 0, n: 0 }; g.s += inc.dm[j]; g.n++; G.set(k, g); });
    const ks = [...G.keys()].sort((a, b) => a - b), g = ks.length;
    if (g < 8 || !Number.isFinite(m)) return { p: 1, g, t: 0 };
    let v0 = 0, v1 = 0;
    for (const k of ks) { const a = G.get(k), x = a.s - a.n * m; v0 += x * x; const b = G.get(k + 1); if (b) v1 += x * (b.s - b.n * m); }
    const V = Math.max(v0, v0 + 2 * v1) * g / (g - 1), t = m / (Math.sqrt(V) / N);
    return { p: pT(t, g - 1), g, t };
}

/** 在方向 dir(+1 / −1)上過六關;p 一律用區塊穩健 p(雙尾,方向不影響)。舊的 Newey-West(lag 照事件密度)留在 pNWold 只供對照 */
export function gateDir(inc, H, dir, idxOf, density = 1) {
    const g = gates(dir < 0 ? negate(inc) : inc, COST);
    const b = blockP(inc, H, idxOf);
    g.pBlk = b.p; g.nBlk = b.g; g.tBlk = b.t;
    g.pNWold = nwP(inc.dm, Math.max(1, Math.ceil((H - 1) * density)));
    g.pass['⑥檢定'] = g.d > 0 && g.pBlk <= 0.05;
    g.nPass = Object.values(g.pass).filter(Boolean).length;
    return g;
}

/** 拿掉方向上貢獻最大的 frac「串」(同一檔、窗口重疊的算同一串 —— 同一段大漲在抱 60 天時會被算好幾次,一筆一筆拿 1% 拿不掉,審查第二輪;
 *  H = 0 → 一筆一串),再照每天平均 → 方向上的平均(> 0 = 還在) */
export function trimDir(rets, baseB, dir, frac = 0.01, minCell = MIN_CELL, H = 0) {
    const cid = H > 0 ? clusterIds(rets, H).cid : null, xs = [];
    rets.forEach((e, j) => { const b = baseB.get(e.key); if (!b || b.n - 1 < minCell) return; xs.push({ d: e.d, c: cid ? cid[j] : j, x: xOf(e, b) }); });
    const byC = new Map(); for (const o of xs) byC.set(o.c, (byC.get(o.c) || 0) + dir * o.x);
    const order = [...byC.entries()].sort((a, b) => b[1] - a[1]), drop = Math.ceil(frac * order.length), gone = new Set(order.slice(0, drop).map(z => z[0]));
    const byDay = new Map(); let dropEv = 0;
    for (const o of xs) { if (gone.has(o.c)) { dropEv++; continue; } const a = byDay.get(o.d) || []; a.push(o.x); byDay.set(o.d, a); }
    return { drop, dropEv, m: dir * mean([...byDay.values()].map(mean)) };
}

/** 同一檔、窗口連在一起(跟上一筆差 < H 天)的事件 = 同一串 → [串編號...]、幾串 */
export function clusterIds(rets, H) {
    const last = new Map(), cid = new Int32Array(rets.length); let nc = 0;
    rets.forEach((e, j) => { const p = last.get(e.sym); cid[j] = p && e.i - p.i < H ? p.c : nc++; last.set(e.sym, { i: e.i, c: cid[j] }); });
    return { cid, nc };
}

/** 安慰劑①:每一筆換成「同一天同一格」隨便一檔(n 次)→ 每次的 Ⓑ 增量平均。
 *  同一串(同一檔、窗口重疊)用同一個替身(那天替身沒格 / 買不到才另抽)→ 保留重疊造成的相關(審查 #1)。 */
export function shamCell(rets, W, H, baseB, n, seed) {
    const R = rng(seed), vals = [], { cid, nc } = clusterIds(rets, H);
    W._pool = W._pool || new Map();
    const syms = [...W.stocks.keys()];
    const poolOf = (i, cell) => {
        const key = i + '|' + cell; let p = W._pool.get(key);
        if (!p) { p = syms.filter(s => { const S = W.stocks.get(s); return S.c[i] > 0 && (S.cell ? S.cell[i] : 0) === cell; }); W._pool.set(key, p); }
        return p;
    };
    for (let t = 0; t < n; t++) {
        const rep = new Array(nc), ev = [];
        rets.forEach((e, j) => {
            const c = cid[j], s0 = rep[c];
            if (s0 != null) {
                const S = W.stocks.get(s0), cl = S.cell ? S.cell[e.i] : 0;
                if (cl >= 0) { const r = fwd(S, e.i + 1, e.i + H); if (r != null) { ev.push({ d: e.d, key: e.d + '|' + cl, r }); return; } }
            }
            const p = poolOf(e.i, e.cell);
            for (let k = 0; k < 5 && p.length; k++) {
                const s = p[Math.floor(R() * p.length)], r = fwd(W.stocks.get(s), e.i + 1, e.i + H);
                if (r != null) { if (s0 == null) rep[c] = s; ev.push({ d: e.d, key: e.key, r }); break; }
            }
        });
        vals.push(mean(incCell(ev, baseB).dm));
    }
    return vals;
}

/** 安慰劑②:同一串(同一檔、窗口重疊)的事件一起挪 ±(H+SHIFT_GAP ~ H+SHIFT_GAP+SHIFT_SPAN) 個交易日 → 每次的 Ⓑ 增量平均。
 *  同一串挪一樣多 = 保留重疊造成的相關(審查 #1);至少挪 H+20 天 = ⛔ 跟自己的窗口重疊、範圍 750 天夠寬(審查 #2;250 天時校準最高 10%)。
 *  審查第二輪兩個洞:
 *   (a) 挪過去落在股票池外 / 超出範圍的直接丟掉 → 晚進股票池、歷史很短的那幾檔在安慰劑裡被漏掉,「這檔本來就強」擋不住
 *       → 每一串只從「整串挪過去都還在股票池、有格、有交易」的位移裡抽;一個位移都沒有的整串,實際值跟安慰劑兩邊一起拿掉(同一批事件比)
 *   (b) 原本擠在同一天的事件挪開之後各自變成一天 → 「先每天平均」的權重跟實際值不一樣
 *       → 安慰劑每一筆沿用它原本那一天的權重(1 ÷ 那天的筆數),實際值也用同一套權重算。
 *  回 {vals, actual(拿掉沒地方挪的那幾串之後的實際值), nKeep, nAll} */
export function shamShift(rets, W, H, baseB, iCut, n, seed) {
    const R = rng(seed), lo = H + SHIFT_GAP, hi = lo + SHIFT_SPAN, { cid, nc } = clusterIds(rets, H);
    const mem = Array.from({ length: nc }, () => []); rets.forEach((e, j) => mem[cid[j]].push(j));
    const okAt = (S, i2) => i2 >= 1 && i2 + H <= iCut && (S.cell ? S.cell[i2] : 0) >= 0 && S.c[i2] > 0 && S.o[i2 + 1] > 0 && !S.mk[i2 + 1];
    const valid = mem.map(js => {
        const S = W.stocks.get(rets[js[0]].sym), out = [];
        for (let a = lo; a <= hi; a++) for (const s of [a, -a]) if (js.every(j => okAt(S, rets[j].i + s))) out.push(s);
        return out;
    });
    const keep = rets.map((e, j) => { const b = baseB.get(e.key); return valid[cid[j]].length > 0 && !!b && b.n - 1 >= MIN_CELL; });
    const kDay = new Map(); rets.forEach((e, j) => { if (keep[j]) kDay.set(e.d, (kDay.get(e.d) || 0) + 1); });
    const w = rets.map((e, j) => keep[j] ? 1 / kDay.get(e.d) : 0);
    let sw = 0, sx = 0; rets.forEach((e, j) => { if (keep[j]) { sw += w[j]; sx += w[j] * xOf(e, baseB.get(e.key)); } });
    const actual = sw ? sx / sw : NaN, vals = [];
    for (let t = 0; t < n; t++) {
        const pick = valid.map(v => v.length ? v[Math.floor(R() * v.length)] : 0);
        let tw = 0, tx = 0;
        rets.forEach((e, j) => {
            if (!keep[j]) return;
            const S = W.stocks.get(e.sym), i2 = e.i + pick[cid[j]], cell = S.cell ? S.cell[i2] : 0;
            const r = fwd(S, i2 + 1, i2 + H); if (r == null) return;
            const b = baseB.get(W.cal[i2] + '|' + cell); if (!b || b.n - 1 < MIN_CELL) return;
            tw += w[j]; tx += w[j] * xOf({ r }, b);
        });
        vals.push(tw ? tx / tw : NaN);
    }
    return { vals: vals.filter(Number.isFinite), actual, nKeep: keep.filter(Boolean).length, nAll: rets.length };
}

/** 安慰劑 p:dir 方向上,實際值至少一樣極端的比例;two = 方向沒預設(用結果決定方向)→ 雙尾 = 單尾 × 2(審查 #3) */
export const pSham = (vals, actual, dir, two = false) => {
    const p = (1 + vals.filter(v => dir * v >= dir * actual).length) / (1 + vals.length);
    return two ? Math.min(1, 2 * p) : p;
};

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

/** 兩個股票池都七條全過、而且是同一個方向才算(審查第二輪:方向沒預設的那三個檢定,兩邊各自用自己的結果決定方向) */
export const bothOk = (p, q) => !!(p && q && p.ok && q.ok && p.dir === q.dir);

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
    const stocks = new Map(), skipMkt = {}; let vol0 = 0, nKdMiss = 0, nJ = 0, nG = 0, nOld = 0;
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
        nOld += A.cliff[cal.length];
        const mc = markCliffs(A); nJ += mc.nJ; nG += mc.nG;
        A.sk = new Float64Array(cal.length).fill(1);
        for (const r of real) { const i = calIdx.get(d10(r.date)); if (i != null && +r._sk > 0) A.sk[i] = +r._sk; }
        A.kv = new Float64Array(cal.length).fill(NaN); A.kc = new Float64Array(cal.length).fill(NaN);
        try {
            const kd = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(env.KD_DIR, s + '.json.gz'))).toString('utf8'));
            for (const r of (kd.k || [])) { const i = calIdx.get(d10(r[0])); if (i == null) continue; if (+r[5] > 0) A.kv[i] = +r[5]; if (+r[4] > 0) A.kc[i] = +r[4]; }
        } catch (_) { nKdMiss++; }
        A.first = Infinity;
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
    for (const b of blocks) { const S = stocks.get(b.sym); if (b.i < S.first) S.first = b.i; }   // 第一次出現在上市鉅額名單 = 那天起確定是上市
    return { cal, calIdx, stocks, blocks, skipMkt, vol0, nKdMiss, miss: miss2, cliffs: { old: nOld, jump: nJ, gap: nG } };
}

/** 只描述(⛔ 影響判定,登錄之後才加的):流動性、集中度、中位數、拿掉最大 5%、去掉冷門股、出場提早幾筆、Ⓒ、溢價那兩格只看配對 */
function describe(rows, T, W, baseB, iCut) {
    const out = {}, q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
    const dayMean = arr => { const m = new Map(); for (const r of arr) { const a = m.get(r.d) || []; a.push(r.x); m.set(r.d, a); } return mean([...m.values()].map(mean)); };
    for (const r of rows) {
        const id = `${r.key}/${r.H}`, k = HS.indexOf(r.H), evs = T[r.key];
        const rets = evRets(evs, W, r.H, iCut);
        const dir = r.dir;   // 審查第二輪:拿掉「方向上」最有利的那一端(方向 −1 的拿掉跌最多的)
        const xs = rets.map(e => { const b = baseB[k].get(e.key); return b && b.n - 1 >= MIN_CELL ? { ...e, x: xOf(e, b), amt: W.stocks.get(e.sym).amt[e.i] } : null; }).filter(Boolean);
        const liq = xs.filter(e => e.amt >= 1e7), sorted = xs.slice().sort((a, b) => dir * b.x - dir * a.x);
        const bySym = new Map(); for (const e of xs) bySym.set(e.sym, (bySym.get(e.sym) || 0) + dir * e.x);
        const top5 = [...bySym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
        const amts = xs.map(e => e.amt).filter(Number.isFinite);
        const early = rets.filter(e => e.y < e.i + r.H).length;
        out[id] = { n: xs.length, syms: bySym.size, all: dayMean(xs), median: q(xs.map(e => e.x), 0.5), winRate: xs.filter(e => dir * e.x > 0).length / xs.length,
                    dropTop5pct: dayMean(sorted.slice(Math.ceil(0.05 * sorted.length))), withoutTop5Syms: dayMean(xs.filter(e => !top5.includes(e.sym))), top5,
                    amt20Med: q(amts, 0.5), amt20P25: q(amts, 0.25), shareBelow1e7: 1 - liq.length / xs.length, liquidOnly: { n: liq.length, m: dayMean(liq) },
                    exitEarly: early, exitEarlyShare: early / Math.max(1, rets.length) };
        const o = out[id];
        console.log(`   ${r.name} 抱 ${r.H} 天:${o.n} 筆 / ${o.syms} 檔・平均 ${sg(o.all)}・中位 ${sg(o.median)}・${dir > 0 ? '比同格好' : '比同格差'}的比例 ${(o.winRate * 100).toFixed(0)}%・拿掉方向上最有利的 5% ${sg(o.dropTop5pct)}・拿掉貢獻最大 5 檔 ${sg(o.withoutTop5Syms)}(${top5.join(' ')})`);
        console.log(`      前 20 日平均成交金額 中位 ${(o.amt20Med / 1e4).toFixed(0)} 萬・P25 ${(o.amt20P25 / 1e4).toFixed(0)} 萬・不到 1,000 萬的 ${(o.shareBelow1e7 * 100).toFixed(0)}%・只看 ≥ 1,000 萬 ${o.liquidOnly.n} 筆 ${sg(o.liquidOnly.m)}・停牌 / 下市 / 斷崖提早出場 ${early} 筆(${(100 * o.exitEarlyShare).toFixed(1)}%)`);
    }
    return out;
}

/** 一個股票池跑完 15 格:格 → 對照 → 增量 / 六關 / 安慰劑 / 去極端 → BH → 判定 */
function analyze(W, T, F, list, univ, iCut, quiet = false) {
    const t0 = Date.now();
    const first = univ === 'all' ? null : list.map(S => S.first);
    const cells = buildCells(F, W.cal.length, 30, first);
    list.forEach((S, j) => { S.cell = cells[j]; });
    const rts = buildRetTerc(list, W.cal.length);
    list.forEach((S, j) => { S.rt = rts[j]; });
    W._pool = new Map();
    let nAct = 0, nAll = 0; for (const S of list) for (let i = 0; i <= iCut; i++) if (S.c[i] > 0) { nAll++; if (S.cell[i] >= 0) nAct++; }
    const noCell = Object.fromEntries(Object.entries(T).map(([k, a]) => [k, a.filter(e => W.stocks.get(e.sym).cell[e.i] < 0).length]));
    const { A: baseA, B: baseB, C: baseC } = buildBases(W, iCut);
    const idxOf = d => W.calIdx.get(d), nDaysAll = iCut + 1, rows = [];
    for (const key of Object.keys(T)) {
        HS.forEach((H, k) => {
            const rets = evRets(T[key], W, H, iCut);
            const incA = incCell(rets, baseA[k], MIN_CELL, 'd'), incB = incCell(rets, baseB[k]), incC = incCell(rets, baseC[k], MIN_CELL, 'keyC');
            const mA = mean(incA.dm), mB = mean(incB.dm), mC = mean(incC.dm);
            const dir = DIR[key] || (mB < 0 ? -1 : 1), two = !DIR[key];
            const gA = gateDir(incA, H, dir, idxOf, incA.days.length / nDaysAll), gB = gateDir(incB, H, dir, idxOf, incB.days.length / nDaysAll);
            const yr = (gB.YR || []).filter(y => y.n >= 20);
            const seed = 20261124 + 97 * HS.indexOf(H) + 7 * Object.keys(T).indexOf(key);
            const vC = shamCell(rets, W, H, baseB[k], SHAM_N, seed), sS = shamShift(rets, W, H, baseB[k], iCut, SHIFT_N, seed + 1), vS = sS.vals;
            const trim = trimDir(rets, baseB[k], dir, 0.01, MIN_CELL, H);
            const med = (() => { const s = incB.all.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; })();
            const by = (a, b) => mean(incB.days.map((d, j) => [d, incB.dm[j]]).filter(([d]) => d >= a && d <= b).map(x => x[1]));
            const { nc } = clusterIds(rets, H);
            const ovl = (() => { const bySym = new Map(); for (const e of rets) { const a = bySym.get(e.sym) || []; a.push(e.i); bySym.set(e.sym, a); } let c = 0; for (const a of bySym.values()) for (let j = 0; j + 1 < a.length; j++) if (a[j + 1] - a[j] <= H) c++; return c / Math.max(1, rets.length); })();
            rows.push({ key, name: NAME[key], H, dir, two, n: incB.n, nDays: incB.days.length, nClusters: nc, overlap: ovl, nBlk: gB.nBlk,
                        mA, mB, mC, nC: incC.n, pA: gA.pBlk, pB: gB.pBlk, pNWoldA: gA.pNWold, pNWoldB: gB.pNWold, pC: blockP(incC, H, idxOf).p,
                        gB: { d: gB.d, H: gB.H, dropBest: gB.dropBest, nPass: gB.nPass, pass: gB.pass }, YR: gB.YR, yrPos: yr.filter(y => y.d > 0).length, yrN: yr.length,
                        shamCell: { med: mean(vC) }, shamShift: { med: mean(vS), actual: sS.actual, keep: sS.nKeep / Math.max(1, sS.nAll) },
                        pCell: pSham(vC, mB, dir, two), pShift: pSham(vS, sS.actual, dir, two), trim, median: med,
                        exitEarly: rets.filter(e => e.y < e.i + H).length,
                        split: { a: by('2010-01-01', '2018-12-31'), b: by('2019-01-01', '2026-12-31') },
                        rev: DIR[key] ? { pCell: pSham(vC, mB, -dir), pShift: pSham(vS, sS.actual, -dir) } : null });
        });
    }
    const qA = bhQ(rows.map(r => r.pA)), qB = bhQ(rows.map(r => r.pB));
    rows.forEach((r, j) => { r.qA = qA[j]; r.qB = qB[j]; const J = judge(r); r.c = J.c; r.ok = J.ok; r.nOk = J.n; });
    if (!quiet) {
        console.log(`\n【${UNIV[univ]}】那天算得出格的股票日 ${nAct.toLocaleString()} / 有交易的 ${nAll.toLocaleString()}(${(100 * nAct / nAll).toFixed(0)}%)・事件那天算不出格 → 不算:${JSON.stringify(noCell)}`);
        console.log('檢定           抱  方向 筆數  串數 重疊%  段數  Ⓐ增量  Ⓑ增量  Ⓒ增量  中位   qⒶ    qⒷ  (舊NW pⒷ) 年同向  前後半        去最好年  安慰劑(格/換日)  去極端   判定');
        for (const r of rows) {
            console.log(`${r.name.padEnd(12)} ${String(r.H).padStart(3)}  ${r.dir > 0 ? '＋' : '－'}${r.two ? '雙' : '單'} ${String(r.n).padStart(5)} ${String(r.nClusters).padStart(5)} ${(100 * r.overlap).toFixed(0).padStart(4)} ${String(r.nBlk).padStart(5)} ${sg(r.mA).padStart(6)} ${sg(r.mB).padStart(6)} ${sg(r.mC).padStart(6)} ${sg(r.median).padStart(6)} ${r.qA.toFixed(3).padStart(6)} ${r.qB.toFixed(3).padStart(6)} (${r.pNWoldB.toFixed(3)})  ${String(r.yrPos).padStart(2)}/${r.yrN}  ${sg(r.dir * r.gB.H[0])}/${sg(r.dir * r.gB.H[1])}  ${sg(r.dir * r.gB.dropBest).padStart(6)}  ${r.pCell.toFixed(3)}/${r.pShift.toFixed(3)}  ${sg(r.dir * r.trim.m).padStart(6)}  ${r.ok ? '✅' : '⛔'} ${r.nOk}/7`);
        }
        console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    }
    return { rows, baseB, nAct, nAll, noCell };
}

function main(out) {
    const t0 = Date.now(), env = process.env;
    const W = loadWorld(env);
    let iCut = W.cal.length - 1; while (iCut > 0 && W.cal[iCut] > CUTOFF) iCut--;
    const nU = [...W.stocks.values()].reduce((m, S) => { m[S.mkt] = (m[S.mkt] || 0) + 1; return m; }, {});
    const nFirst = [...W.stocks.values()].filter(S => S.first <= iCut).length;
    console.log(`🐘 股票池 ${W.stocks.size} 檔(上市 ${nU.twse || 0}・已下市標不出市場 ${nU.unknown || 0};跳過 ${JSON.stringify(W.skipMkt)})・成交量 0 的列 ${W.vol0}・在封存日前出現過鉅額的 ${nFirst} 檔`);
    console.log(`   日曆 ${W.cal[0]} ~ ${W.cal[W.cal.length - 1]}(${W.cal.length} 天)・🔒 判定只到 ${W.cal[iCut]}(第 ${iCut} 天)`);
    console.log(`   斷崖:舊規則(×1.5 / ×0.67)${W.cliffs.old}・新增「超出當天漲跌幅」${W.cliffs.jump}・新增「停牌 / 沒成交 ≥ ${GAP_CLIFF} 天後恢復」${W.cliffs.gap}`);
    console.log(`   鉅額(一天一檔合併)${W.blocks.length} 筆・沒對上:2010 前(d16 沒有股價)${W.miss.pre}・不在日曆 ${W.miss.cal}・不在股票池 ${W.miss.univ}`);
    if (!W.blocks.length) { console.log('❌ 一筆鉅額都沒有 → block_deep 還沒抓好?'); process.exit(1); }
    const st = {};
    const ev = enrich(W.blocks.filter(b => b.i <= iCut), W.stocks, st);
    console.log(`   那天沒有一般成交 ${st.noTrade}・均價超出物理範圍(尺標對不上)${st.phys}・用 _sk 換回原始尺標 ${st.scaled}・可用 ${ev.length}`);
    console.log(`   溢價分母用 klines_deep 原始收盤 ${st.rawClose} 筆(跟 d16 × _sk 差 > 0.5% 的 ${st.rawDiff})・佔比分母算不出 ${st.noTv}(只做溢價 / 折價)・鉅額比當天總成交還多(資料矛盾,佔比 / 溢價都不用)${st.overOne}・klines_deep 沒有這檔 ${W.nKdMiss}`);
    if (st.physEx.length) console.log('   超出物理範圍的例子:' + st.physEx.join(' / '));
    const qs = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const evR = ev.filter(e => Number.isFinite(e.ratio)), ratios = evR.map(e => e.ratio), prems = ev.map(e => e.prem).filter(Number.isFinite);
    console.log(`   佔比 中位 ${qs(ratios, 0.5).toFixed(3)}・前 5% ${qs(ratios, 0.95).toFixed(2)}・前 1% ${qs(ratios, 0.99).toFixed(2)}・溢價 ≥ +1% ${prems.filter(x => x >= 0.01).length} 筆・折價 ≤ −3% ${prems.filter(x => x <= -0.03).length} 筆・有配對的 ${(100 * evR.filter(e => e.pair > 0).length / evR.length).toFixed(1)}%`);
    const thr1 = expandingQuantile(ratios, 0.99), thr5 = expandingQuantile(ratios, 0.95), thrP = expandingQuantile(evR.map(e => e.pairRatio), 0.95);
    const raw = {
        T1: evR.filter((e, j) => e.ratio >= thr1[j]), T2: evR.filter((e, j) => e.ratio >= thr5[j]),
        T3: ev.filter(e => e.prem >= 0.01), T4: ev.filter(e => e.prem <= -0.03),
        T5: evR.filter((e, j) => e.pair > 0 && e.pairRatio >= thrP[j]),
    };
    const t5zero = evR.filter((e, j) => e.pair > 0 && e.pairRatio >= thrP[j] && !(thrP[j] > 0)).length;
    console.log(`   門檻(最後那天):佔比前 1% ≥ ${thr1[thr1.length - 1].toFixed(3)}・前 5% ≥ ${thr5[thr5.length - 1].toFixed(3)}・配對前 5% ≥ ${thrP[thrP.length - 1].toFixed(3)}(最小 ${Math.min(...thrP.filter(Number.isFinite)).toFixed(3)}・T5 門檻 = 0 的 ${t5zero} 筆)(佔比算得出的 ${evR.length} 筆,${W.cal[evR[0].i]} ~ ${W.cal[evR[evR.length - 1].i]})`);
    const T = Object.fromEntries(Object.entries(raw).map(([k, a]) => [k, dedup(a)]));
    for (const k of Object.keys(T)) {
        const ys = new Set(T[k].map(e => W.cal[e.i].slice(0, 4)));
        console.log(`   ${k} ${NAME[k].padEnd(10)} 原始 ${String(raw[k].length).padStart(6)} → 去重 ${String(T[k].length).padStart(6)} 筆・${new Set(T[k].map(e => e.sym)).size} 檔・${ys.size} 年`);
    }
    const list = [...W.stocks.values()];
    const F = list.map(S => features(S, W.cal.length));
    list.forEach((S, j) => { S.amt = F[j].amt; });
    if (env.CHECK_ONLY) {
        for (const u of ['listed', 'all']) {
            const first = u === 'all' ? null : list.map(S => S.first), cells = buildCells(F, W.cal.length, 30, first);
            let nAct = 0, nAll = 0; list.forEach((S, j) => { for (let i = 0; i <= iCut; i++) if (S.c[i] > 0) { nAll++; if (cells[j][i] >= 0) nAct++; } });
            const noCell = Object.fromEntries(Object.entries(T).map(([k, a]) => [k, a.filter(e => cells[list.indexOf(W.stocks.get(e.sym))][e.i] < 0).length]));
            console.log(`   【${UNIV[u]}】算得出格的股票日 ${nAct.toLocaleString()} / ${nAll.toLocaleString()}・事件那天算不出格:${JSON.stringify(noCell)}`);
        }
        console.log(`\n(CHECK_ONLY:只印資料檢查,⛔ 算報酬)${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
        return;
    }
    const P = analyze(W, T, F, list, 'listed', iCut);
    const Q = analyze(W, T, F, list, 'all', iCut);
    const ok = P.rows.filter((r, j) => bothOk(r, Q.rows[j]));
    const okP = P.rows.filter(r => r.ok).map(r => `${r.key}/${r.H}`), okQ = Q.rows.filter(r => r.ok).map(r => `${r.key}/${r.H}`);
    console.log(`\n判定(兩個股票池都要七條全過):${ok.length ? '✅ ' + ok.map(r => `${r.name} 抱 ${r.H} 天(${r.dir > 0 ? '之後比較強' : '之後比較弱'})`).join('、') : '⛔ 15 格沒有一格七條全過'}`);
    console.log(`   主股票池過的:${okP.join('、') || '無'}・舊股票池過的:${okQ.join('、') || '無'}`);
    const surprise = P.rows.filter(r => r.rev && Math.sign(r.mB) === -r.dir && r.qA <= 0.05 && r.qB <= 0.05 && r.rev.pCell <= 0.05 && r.rev.pShift <= 0.05);
    if (surprise.length) console.log(`⚠️ 意外(跟預期方向相反、而且顯著):${surprise.map(r => `${r.name} 抱 ${r.H} 天`).join('、')} → ⛔ 採用,要另外登記再驗`);
    // 主股票池的格 / 對照重算回來給 describe 用(analyze 'all' 蓋掉了 S.cell)
    const first = list.map(S => S.first), cells = buildCells(F, W.cal.length, 30, first);
    list.forEach((S, j) => { S.cell = cells[j]; });
    const rts = buildRetTerc(list, W.cal.length); list.forEach((S, j) => { S.rt = rts[j]; });
    console.log('\n只描述(⛔ 影響判定;主股票池):');
    const desc = describe(P.rows.filter(r => ok.includes(r) || ['T1', 'T2', 'T5'].includes(r.key) && r.H !== 60), T, W, P.baseB, iCut);
    // 溢價 / 折價:只看「幾乎全是配對交易」的(配對股數 ≥ 鉅額股數一半;盤中逐筆成交的均價會跟收盤前的走勢綁在一起,審查 #5)
    const pairOnly = {};
    for (const key of ['T3', 'T4']) {
        const sub = dedup(raw[key].filter(e => e.pair >= 0.5 * e.sh));
        HS.forEach((H, k) => { const inc = incCell(evRets(sub, W, H, iCut), P.baseB[k]); pairOnly[`${key}/${H}`] = { n: inc.n, m: mean(inc.dm), p: blockP(inc, H, d => W.calIdx.get(d)).p }; });
    }
    console.log('   溢價 / 折價只看配對為主的:' + Object.entries(pairOnly).map(([k, o]) => `${k} ${o.n} 筆 ${sg(o.m)}(p ${o.p.toFixed(3)})`).join('・'));
    console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
    const slim = rows => rows.map(r => ({ ...r, c: r.c }));
    const res = { updated: new Date().toISOString().slice(0, 10), cutoff: W.cal[iCut], stocks: W.stocks.size, blocks: W.blocks.length, ev: ev.length, evRatio: evR.length,
                  drop: { noTrade: st.noTrade, phys: st.phys, scaled: st.scaled, noTv: st.noTv, overOne: st.overOne, pre2010: W.miss.pre, cal: W.miss.cal, univ: W.miss.univ, rawClose: st.rawClose, rawDiff: st.rawDiff },
                  cliffs: W.cliffs, range: [W.cal[ev[0].i], W.cal[ev[ev.length - 1].i]],
                  counts: Object.fromEntries(Object.entries(T).map(([k, a]) => [k, { raw: raw[k].length, dedup: a.length }])),
                  univ: { listed: { nAct: P.nAct, nAll: P.nAll, noCell: P.noCell }, all: { nAct: Q.nAct, nAll: Q.nAll, noCell: Q.noCell } },
                  rows: slim(P.rows), rowsAll: slim(Q.rows), ok: ok.map(r => `${r.key}/${r.H}`), okListed: okP, okAll: okQ,
                  surprise: surprise.map(r => `${r.key}/${r.H}`), desc, pairOnly };
    if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
}

// ───────── 合成世界(selftest / 校準共用)─────────
export function mkWorld(nS, T, seedV, bump = () => 0, sig = 0.02) {
    const cal = [...Array(T).keys()].map(i => new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10));
    const calIdx = new Map(cal.map((d, i) => [d, i])), R = rng(seedV), stocks = new Map();
    for (let s = 0; s < nS; s++) {
        const bars = []; let p = 50;
        for (let i = 0; i < T; i++) { p *= 1 + (R() - 0.5) * sig + bump(s, i); bars.push({ date: cal[i], open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 }); }
        const A = alignStock(cal, calIdx, bars, []); A.date = cal; A.cell = new Int8Array(T); A.sk = new Float64Array(T).fill(1); A.first = 0;
        markCliffs(A);
        stocks.set(String(1000 + s), A);
    }
    return { cal, calIdx, stocks };
}
/** 改過價之後重算斷崖(合成世界用) */
const remark = S => { const T = S.c.length; let p = NaN; const cl = new Int32Array(T + 1); for (let i = 0; i < T; i++) { let b = 0; if (S.c[i] > 0) { if (p > 0) { const r1 = S.c[i] / p, r2 = S.o[i] / p; if (!(r1 >= 0.67 && r1 <= 1.5) || !(r2 >= 0.67 && r2 <= 1.5)) b = 1; } p = S.c[i]; } cl[i + 1] = cl[i] + b; } S.cliff = cl; markCliffs(S); };

/** 沒效果的世界裡,三個檢定 p ≤ 0.05 的比例(名目 5%)。kind:stockCluster = 15 檔 × 3 段 × 每 10 天一筆(= 去重後天天有鉅額的樣子) */
export function nullFPR({ nW = 40, H = 20, kind = 'stockCluster', nPl = 60, NS = 60, T = 900, seed0 = 1 } = {}) {
    const k = HS.indexOf(H); let fB = 0, fC = 0, fS = 0, fOld = 0;
    for (let w = 0; w < nW; w++) {
        const W = mkWorld(NS, T, seed0 + 17 * w, () => 0, 0.06), R = rng(77 + w + seed0), ev = [], iCut = T - 1;
        if (kind === 'stockCluster') { for (let s = 0; s < 12; s++) for (let b = 0; b < 3; b++) { const i0 = 60 + Math.floor(R() * (T - 260)); for (let q = 0; q < 6; q++) ev.push({ i: i0 + 10 * q, sym: String(1000 + s) }); } }
        else { for (let q = 0; q < 220; q++) ev.push({ i: 60 + Math.floor(R() * (T - 200)), sym: String(1000 + Math.floor(R() * NS)) }); }
        ev.sort((a, b) => a.i - b.i);
        const B = buildBases(W, iCut), rets = evRets(ev, W, H, iCut), inc = incCell(rets, B.B[k]), m = mean(inc.dm);
        const g = gateDir(inc, H, 1, d => W.calIdx.get(d), inc.days.length / (iCut + 1));
        const vC = shamCell(rets, W, H, B.B[k], nPl, 9 + w), sS = shamShift(rets, W, H, B.B[k], iCut, nPl, 10 + w), dir = m < 0 ? -1 : 1;
        if (g.pBlk <= 0.05) fB++; if (g.pNWold <= 0.05) fOld++;
        if (pSham(vC, m, dir, true) <= 0.05) fC++; if (pSham(sS.vals, sS.actual, dir, true) <= 0.05) fS++;
    }
    return { blk: fB / nW, cell: fC / nW, shift: fS / nW, nwOld: fOld / nW };
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
    {   // ③ 後 50 筆全改成超大:之前每一筆的門檻都不變;決定性對照:用全期(含未來)算一個門檻的寫法 → 之前的門檻跟著變
        const xs2 = xs.slice(); for (let j = 250; j < 300; j++) xs2[j] = 1e9;
        const t2 = expandingQuantile(xs2, 0.99, 250);
        const leaky = a => { const s = a.slice().sort((x, y) => x - y), v = s[Math.floor(0.99 * s.length)]; return a.map((_, j) => j < 250 ? Infinity : v); };
        const l1 = leaky(xs), l2 = leaky(xs2);
        ok(t.slice(0, 251).every((v, i) => v === t2[i]) && t2[299] !== t[299] && l1[250] !== l2[250],
           `③ ⛔ 前視:後 50 筆改成超大,第 250 筆以前的門檻一個都沒變(之後的有變 = 有鑑別力);決定性對照:全期門檻的寫法第 250 筆就從 ${l1[250]} 變成 ${l2[250]}`);
    }
    const dd = dedup([{ i: 0, sym: 'A' }, { i: 5, sym: 'A' }, { i: 10, sym: 'A' }, { i: 3, sym: 'B' }].sort((a, b) => a.i - b.i));
    ok(dd.map(e => `${e.sym}${e.i}`).join(',') === 'A0,B3,A10', '④ 同一檔 10 天內只算第一次');

    // ⑤ 事件之後 20 天逐日墊高 → 抓得到;同樣檔數隨機日子 ≈ 0
    const T5 = 800, W5 = mkWorld(40, T5, 7), evs = [];
    for (let s = 0; s < 40; s++) for (let i0 = 100 + 3 * s; i0 < 700; i0 += 97) {
        const S = W5.stocks.get(String(1000 + s));
        for (let i = i0 + 1; i < T5; i++) { const f = i <= i0 + 20 ? 1 + 0.001 * (i - i0) : 1 + 0.001 * 20; S.o[i] *= f; S.c[i] *= f; S.h[i] *= f; S.l[i] *= f; }
        evs.push({ i: i0, sym: String(1000 + s) });
    }
    for (const S of W5.stocks.values()) remark(S);
    const B5 = buildBases(W5, T5 - 1), r5 = evRets(evs.sort((a, b) => a.i - b.i), W5, 20, T5 - 1);
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
    // ⑨ 特徵 ⛔ 前視:第 300 天以後的資料整段改掉 → 第 300 天以前的特徵一個都沒變;成交金額不含當天(只改第 400 天的量 → 第 400 天不變、第 401 天變)
    {
        const S = W5.stocks.get('1002'), T = W5.cal.length;
        const f1 = features(S, T);
        const keep = ['o', 'h', 'l', 'c', 'v'].map(k => S[k].slice());
        for (let i = 301; i < T; i++) { S.c[i] *= 3; S.h[i] *= 3; S.l[i] *= 0.2; S.v[i] *= 9; }
        const f2 = features(S, T);
        ['o', 'h', 'l', 'c', 'v'].forEach((k, j) => S[k].set(keep[j]));
        const same = ['amt', 'pos', 'vol'].every(k => { for (let i = 0; i <= 300; i++) { const a = f1[k][i], b = f2[k][i]; if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) return false; } return true; });
        const changed = ['amt', 'pos', 'vol'].some(k => f1[k][T - 1] !== f2[k][T - 1]);
        S.v[400] *= 10; const f3 = features(S, T); S.v[400] /= 10;
        ok(same && changed && f3.amt[400] === f1.amt[400] && f3.amt[401] > f1.amt[401],
           '⑨ ⛔ 前視:把第 300 天以後的價量整段改掉,第 300 天以前的成交金額 / 位階 / 波動一個都沒變(之後的有變 = 有鑑別力);成交金額只用前 20 天(當天量放大 10 倍 → 當天不變、隔天才變)');
    }
    // ⑩ 格只用同一天的截面:別天的值改掉,這一天的格不變;那天不到 minN 檔 → −1;不在股票池(first 之前)→ −1
    {
        const T = 5, mk = v => ({ amt: Float64Array.from({ length: T }, () => v[0]), pos: Float64Array.from({ length: T }, () => v[1]), vol: Float64Array.from({ length: T }, () => v[2]) });
        const F = [...Array(60).keys()].map(j => mk([1 + j, (j % 7) / 7, (j % 11) / 11]));
        const c1 = buildCells(F, T);
        const R10 = rng(13); F.forEach(f => { f.amt[3] = R10(); f.pos[3] = R10(); });
        const c2 = buildCells(F, T);
        const fewF = F.slice(0, 10), c3 = buildCells(fewF, T);
        const first = F.map((_, j) => j < 5 ? 3 : 0), c4 = buildCells(F, T, 30, first);
        ok(c1.every((a, j) => a[2] === c2[j][2]) && c1.some((a, j) => a[3] !== c2[j][3]) && c3.every(a => a[2] === -1) && new Set(c1.map(a => a[2])).size > 5
           && c4.slice(0, 5).every(a => a[2] === -1 && a[3] >= 0) && c4.slice(5).every(a => a[2] >= 0),
           '⑩ 三分位只用同一天的股票:改掉第 4 天的值,第 3 天的格一個都沒變;那天不到 30 檔 → 不分格;還沒出現在上市鉅額名單的那幾天 → 不算股票池');
    }
    // ⑪ 區塊穩健 p:重疊窗口(相鄰高度相關)→ p 比一般 t 檢定大;t 分配
    {
        const R = rng(11), e = [...Array(600)].map(() => R() - 0.5), x = e.map((_, i) => { let s = 0; for (let k = 0; k < 20 && i - k >= 0; k++) s += e[i - k]; return s / 20 + 0.02; });
        const days = x.map((_, i) => new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10)), di = new Map(days.map((d, i) => [d, i]));
        const inc = { n: x.length, days, dm: x, all: x };
        const g = gateDir(inc, 20, 1, d => di.get(d), 1);
        ok(g.pBlk > g.p && g.nBlk === 30 && Math.abs(pT(1.959964, 1e7) - 0.05) < 1e-4 && Math.abs(pT(2.228139, 10) - 0.05) < 1e-4,
           `⑪ 抱 20 天、天天有事件 → 切 ${g.nBlk} 段、區塊 p ${g.pBlk.toFixed(3)} > 一般 t 檢定 ${g.p.toFixed(3)};t 分配 p(1.96, ∞) = ${pT(1.959964, 1e7).toFixed(4)}、p(2.228, 10) = ${pT(2.228139, 10).toFixed(4)}`);
    }
    // ⑫ 換日安慰劑分得出「時間點」與「這檔本來就強」:
    //    A 世界(事件之後才強)→ 換日安慰劑 p 很小;B 世界(這幾檔天天都多漲、事件日是隨便挑的)→ 增量一樣是正的,但換日安慰劑 p 大
    {
        const T = 900, iCut = T - 1, pick = rng(5);
        const evA = [], WA = mkWorld(60, T, 21);
        for (let s = 0; s < 30; s++) for (let i0 = 150 + 5 * s; i0 < 750; i0 += 131) {
            const S = WA.stocks.get(String(1000 + s));
            for (let i = i0 + 1; i < T; i++) { const f = i <= i0 + 20 ? 1 + 0.0015 * (i - i0) : 1 + 0.0015 * 20; S.o[i] *= f; S.c[i] *= f; S.h[i] *= f; S.l[i] *= f; }
            evA.push({ i: i0, sym: String(1000 + s) });
        }
        for (const S of WA.stocks.values()) remark(S);
        const WB = mkWorld(60, T, 21, s => (s < 30 ? 0.002 : 0)), evB = [];
        for (let s = 0; s < 30; s++) for (let k = 0; k < 4; k++) evB.push({ i: 150 + Math.floor(pick() * 600), sym: String(1000 + s) });
        const run = (W, evl) => {
            evl.sort((a, b) => a.i - b.i);
            const B = buildBases(W, iCut), rets = evRets(evl, W, 20, iCut), inc = incCell(rets, B.B[1]);
            const sS = shamShift(rets, W, 20, B.B[1], iCut, 60, 9), vC = shamCell(rets, W, 20, B.B[1], 60, 9);
            return { m: mean(inc.dm), pS: pSham(sS.vals, sS.actual, 1), pC: pSham(vC, mean(inc.dm), 1) };
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
        const days = [...Array(50).keys()].map(i => new Date(Date.UTC(2010 + (i % 10), 0, 1 + i)).toISOString().slice(0, 10)).sort(), di = new Map(days.map((d, i) => [d, i * 30]));
        const inc = { n: 50, days, dm: [...Array(50)].map((_, i) => -1 - (i % 3) * 0.1), all: [] };
        const g1 = gateDir(inc, 5, -1, d => di.get(d), 0.5), g2 = gates(negate(inc), COST);
        ok(!J.ok && !J.c['①兩種對照 q≤0.05 同方向'] && Math.abs(g1.d - g2.d) < 1e-12 && g1.d > 0,
           '⑮ 預期方向寫死:T4 結果是正的 → ① 不過;方向 −1 = 增量取負號再過同一套關卡');
    }
    // ⑯ 佔比的分母 = 當天總成交股數(含鉅額,FinMind 口徑):有 klines_deep 用它;2021 前用 d16 ÷ _sk;2021 後沒有 → 佔比算不出(溢價照算);
    //    鉅額比總成交還多 = 資料矛盾 → 佔比、溢價都不算;溢價的收盤有 klines_deep 原始收盤就用它。決定性對照:同一天把本站「不含鉅額」的成交量當分母 → 佔比會 > 1
    {
        const T = 4, mkS = (date, v, kv, sk, kc = NaN) => ({ c: Float64Array.from([100, 100, 100, 100]), v: Float64Array.from([v, v, v, v]), sk: Float64Array.from([sk, sk, sk, sk]),
                                                  kv: Float64Array.from([kv, kv, kv, kv]), kc: Float64Array.from([kc, kc, kc, kc]), date: Array(T).fill(date) });
        const stocks = new Map([['1001', mkS('2024-05-02', 1e6, 3e6, 1)], ['1002', mkS('2015-05-04', 8e6, NaN, 4)], ['1003', mkS('2026-09-15', 1e6, NaN, 1)], ['1004', mkS('2024-05-02', 1e6, 1.5e6, 1)],
                                 ['1005', mkS('2024-05-02', 1e6, 3e6, 1, 100.5)]]);
        const blk = sym => { const px = 101 * stocks.get(sym).sk[1]; return { i: 1, sym, sh: 2e6, val: 2e6 * px, vwap: px, pair: 2e6 }; };   // 均價照原始尺標(d16 收盤 × _sk)
        const st = {}, e = enrich(['1001', '1002', '1003', '1004', '1005'].map(blk), stocks, st);
        const by = Object.fromEntries(e.map(x => [x.sym, x]));
        ok(Math.abs(by['1001'].ratio - 2 / 3) < 1e-9 && Math.abs(by['1002'].ratio - 1) < 1e-9 && Number.isNaN(by['1003'].ratio) && Math.abs(by['1003'].prem - 0.01) < 1e-9
           && Number.isNaN(by['1004'].ratio) && Number.isNaN(by['1004'].prem) && st.noTv === 1 && st.overOne === 1 && 2e6 / 1e6 > 1
           && Math.abs(by['1005'].prem - (101 / 100.5 - 1)) < 1e-12 && st.rawClose === 1 && st.rawDiff === 0,
           `⑯ 佔比分母:有 FinMind 總成交用它(2/3)・2021 前 d16 ÷ _sk(1.00)・2021 後沒有 → 佔比算不出、溢價照算・鉅額比總成交還多 → 資料矛盾,佔比 / 溢價都不算・溢價用原始收盤(${sg(100 * by['1005'].prem)}%);決定性對照:拿本站「不含鉅額」的量當分母 = ${(2e6 / 1e6).toFixed(1)}(> 1)`);
    }
    // ⑰ 隔天開盤才進場(審查 #13):效果全在事件當天(那天收盤 +5%,之後照常)→ 正確寫法 ≈ 0;決定性對照:當天開盤就買 ≈ +5
    {
        const T = 700, W = mkWorld(40, T, 31), ev = [];
        for (let s = 0; s < 40; s++) for (let i0 = 100 + 4 * s; i0 < 600; i0 += 89) {
            const S = W.stocks.get(String(1000 + s));
            S.c[i0] *= 1.05; S.h[i0] = Math.max(S.h[i0], S.c[i0]);
            for (let i = i0 + 1; i < T; i++) { S.o[i] *= 1.05; S.c[i] *= 1.05; S.h[i] *= 1.05; S.l[i] *= 1.05; }
            ev.push({ i: i0, sym: String(1000 + s) });
        }
        for (const S of W.stocks.values()) remark(S);
        ev.sort((a, b) => a.i - b.i);
        const B = buildBases(W, T - 1), good = mean(incCell(evRets(ev, W, 5, T - 1), B.B[0]).dm);
        const wrong = mean(ev.map(e => { const S = W.stocks.get(e.sym), b = B.B[0].get(W.cal[e.i] + '|0'); return fwd(S, e.i, e.i + 4) - b.s / b.n; }));
        ok(Math.abs(good) < 1 && wrong > 3.5, `⑰ 鉅額收盤後才公布 → 隔天開盤才買:效果全在事件當天的世界 → 增量 ${sg(good)};決定性對照:當天開盤就買(前視)${sg(wrong)}`);
    }
    // ⑱ 減資 30% 停牌 6 天後以 ×1.43 恢復交易(在 ×1.5 之內,舊斷崖抓不到)→ 超出漲跌幅 = 斷崖、在停牌前出場;決定性對照:舊寫法 +42.9%
    //    減資 8% 停牌 6 天後 ×1.087 恢復(在漲跌幅之內)→ 停牌 ≥ 3 天恢復 = 斷崖;沒停牌、一天跳 +20%(2016 漲跌幅 10%)→ 斷崖
    {
        const T = 120, cal = [...Array(T).keys()].map(i => new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10)), calIdx = new Map(cal.map((d, i) => [d, i]));
        const mkA = (pOf, skip = () => false) => { const bars = []; for (let i = 0; i < T; i++) { if (skip(i)) continue; const p = pOf(i); bars.push({ date: cal[i], open: p, high: p, low: p, close: p, volume: 1e6 }); } const A = alignStock(cal, calIdx, bars, []); A.date = cal; return A; };
        const halt = i => i >= 51 && i <= 56;
        const A = mkA(i => (i < 57 ? 50 : 50 / 0.7), halt), old = (A.c[69] / A.o[41] - 1) * 100, oldCliff = A.cliff[70] - A.cliff[41];
        const mc = markCliffs(A), o = fwdX(A, 41, 69);
        const A3 = mkA(i => (i < 57 ? 50 : 50 / 0.92), halt), mc3 = markCliffs(A3), o3 = fwdX(A3, 41, 69);
        const A2 = mkA(i => (i < 60 ? 50 : 60)); markCliffs(A2); const o2 = fwdX(A2, 41, 69);
        ok(oldCliff === 0 && mc.nJ === 1 && o && Math.abs(o.r) < 1e-9 && o.y === 50 && Math.abs(old - 42.857) < 0.01
           && mc3.nG === 1 && mc3.nJ === 0 && o3 && o3.y === 50 && A2.mk[60] === 1 && o2 && o2.y === 59,
           `⑱ 減資停牌 6 天後 ×1.43 恢復交易:舊斷崖沒標(${oldCliff})、舊寫法報酬 ${sg(old)}% → 超出漲跌幅 = 斷崖、在停牌前出場(${o ? sg(o.r) : '—'}%);×1.087(在漲跌幅之內)→ 停牌 ≥ 3 天恢復 = 斷崖;一天跳 +20% → 斷崖`);
    }
    // ⑲ 除息日鎖漲停(審查 #10):前收 100、除息 5 → 參考價 95、漲停 104.5;一價到底 104.5 = 買不到;決定性對照:拿前收當基準 → +4.5% < 9.7% → 當成買得到
    {
        const T = 30, cal = [...Array(T).keys()].map(i => new Date(Date.UTC(2016, 5, 1) + i * 86400000).toISOString().slice(0, 10)), calIdx = new Map(cal.map((d, i) => [d, i]));
        const bars = []; for (let i = 0; i < T; i++) { const p = i < 10 ? 100 : (i === 10 ? 104.5 : 105); bars.push({ date: cal[i], open: p, high: p, low: p, close: p, volume: 1e6 }); }
        const A = alignStock(cal, calIdx, bars, [[cal[10], 5, '息', 100, 95]]); A.date = cal; markCliffs(A);
        const naive = lockedBar(cal[10], A.c[9], A.o[10], A.h[10], A.l[10]);
        ok(fwdX(A, 10, 15) === null && naive === 0 && Math.abs(A.divf[10] - 100 / 95) < 1e-12,
           '⑲ 除息日一價到底在漲停(參考價 95 × 1.1 = 104.5)→ 買不到、不算;決定性對照:拿前收 100 當基準 → +4.5% → 會被當成買得到');
    }
    // ⑳ 出場那天已經下市(審查 #8):第 3 天之後就沒交易 → 用最後一根收盤出場(⛔ 整筆丟掉);決定性對照:只認第 H 天收盤 → 整筆不見
    {
        const T = 60, cal = [...Array(T).keys()].map(i => new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10)), calIdx = new Map(cal.map((d, i) => [d, i]));
        const bars = []; for (let i = 0; i <= 33; i++) { const p = i <= 30 ? 50 : 50 - 2 * (i - 30); bars.push({ date: cal[i], open: p, high: p, low: p, close: p, volume: 1e6 }); }
        const A = alignStock(cal, calIdx, bars, []); A.date = cal; markCliffs(A);
        const o = fwdX(A, 31, 50);
        ok(o && o.y === 33 && Math.abs(o.r - (44 / 48 - 1) * 100) < 1e-9 && !(A.c[50] > 0),
           `⑳ 抱 20 天、第 3 天後下市 → 用最後一根收盤出場 ${o ? sg(o.r) : '—'}%(⛔ 整筆丟掉 = 倖存者偏誤);決定性對照:第 H 天沒有收盤 → 舊寫法整筆不算`);
    }
    // ㉑ 方向沒預設(用結果決定方向)→ 安慰劑 p 雙尾 = 單尾 × 2(審查 #3)
    {
        const v = [...Array(99).keys()].map(i => (i - 49) / 10), p1 = pSham(v, 4.5, 1), p2 = pSham(v, 4.5, 1, true);
        ok(Math.abs(p2 - Math.min(1, 2 * p1)) < 1e-12 && p2 > p1 && pSham(v, 0, 1, true) === 1,
           `㉑ 方向用結果決定 → 安慰劑 p 雙尾:單尾 ${p1.toFixed(3)} → 雙尾 ${p2.toFixed(3)}(上限 1)`);
    }
    // ㉒ 校準(審查 #1 / #2 / #13):沒效果的世界、同一檔每 10 天一筆(= 去重後天天有鉅額)、抱 20 / 60 天
    //    → 區塊 p / 兩種安慰劑 p ≤ 0.05 的比例都要接近 5%;決定性對照:舊 Newey-West(lag 照事件密度)比例明顯偏高
    {
        const c20 = nullFPR({ nW: 40, H: 20 }), c60 = nullFPR({ nW: 40, H: 60, T: 1000 });
        const f = x => (100 * x).toFixed(0) + '%';
        ok(c20.blk <= 0.1 && c20.cell <= 0.1 && c20.shift <= 0.1 && c60.blk <= 0.1 && c60.cell <= 0.1 && c60.shift <= 0.1 && c60.nwOld >= c60.blk + 0.05,
           `㉒ 沒效果的世界(同一檔每 10 天一筆、40 個世界)p ≤ 0.05 的比例:抱 20 天 區塊 ${f(c20.blk)}・格 ${f(c20.cell)}・換日 ${f(c20.shift)}(舊 NW ${f(c20.nwOld)});抱 60 天 區塊 ${f(c60.blk)}・格 ${f(c60.cell)}・換日 ${f(c60.shift)}(決定性對照:舊 NW ${f(c60.nwOld)})`);
    }
    // ㉓ Ⓐ 也只收「那天算得出格」的股票日(審查 #4:舊版 Ⓐ 在檢查格之前就收)
    {
        const T = 200, W = mkWorld(10, T, 41, s => (s === 0 ? 0.01 : 0));
        W.stocks.get('1000').cell.fill(-1);
        const B = buildBases(W, T - 1), d = W.cal[50], a = B.A[0].get(d);
        ok(a && a.n === 9, `㉓ Ⓐ 只收那天算得出格的股票日:第 1 檔沒有格 → 同一天對照 ${a ? a.n : 0} 檔(⛔ 10)`);
    }
    // ㉔ 位階只從最近一次尺標變動起算:第 200 天減資(×1.43)→ 第 400 天的位階只看 200~400(⛔ 拿新舊兩種尺標的高低點);
    //    第 250 天(變動後才 51 根 < 120)→ 算不出;停牌 ≥ 3 天(尺標沒變)⛔ 擋位階
    {
        const T = 500, cal = [...Array(T).keys()].map(i => new Date(Date.UTC(2016, 0, 1) + i * 86400000).toISOString().slice(0, 10)), calIdx = new Map(cal.map((d, i) => [d, i]));
        const px = i => (i < 200 ? 50 : 50 / 0.7) * (1 + 0.05 * Math.sin(i / 9));
        const bars = []; for (let i = 0; i < T; i++) { if (i >= 194 && i <= 199) continue; const p = px(i); bars.push({ date: cal[i], open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 }); }
        const A = alignStock(cal, calIdx, bars, []); A.date = cal; markCliffs(A);
        const F = features(A, T);
        let mx = -Infinity, mn = Infinity; for (let t = 200; t <= 400; t++) { mx = Math.max(mx, A.h[t]); mn = Math.min(mn, A.l[t]); }
        const bars2 = []; for (let i = 0; i < T; i++) { if (i >= 300 && i <= 305) continue; const p = 50 * (1 + 0.05 * Math.sin(i / 9)); bars2.push({ date: cal[i], open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 }); }
        const A2 = alignStock(cal, calIdx, bars2, []); A2.date = cal; markCliffs(A2); const F2 = features(A2, T);
        ok(A.mkS[200] === 1 && Math.abs(F.pos[400] - (A.c[400] - mn) / (mx - mn)) < 1e-12 && Number.isNaN(F.pos[250]) && A2.mk[306] === 1 && !A2.mkS[306] && Number.isFinite(F2.pos[350]),
           `㉔ 位階只從最近一次尺標變動起算(減資後第 200 根 → ${F.pos[400].toFixed(3)};變動後不到 120 根 → 算不出);停牌 ≥ 3 天只讓持有提早出場、⛔ 擋位階`);
    }
    // ── 審查第二輪 ──
    // 舊的換日安慰劑(每檔各自挪、挪不過去就丟掉、跟全部事件的實際值比)—— 只拿來當 ㉕㉖ 的決定性對照
    const naiveShift = (rets, W, H, base, iCut, n, seed) => {
        const R = rng(seed), vals = [], syms = [...new Set(rets.map(e => e.sym))], lo = H + SHIFT_GAP;
        for (let t = 0; t < n; t++) {
            const sh = new Map(syms.map(s => [s, (R() < 0.5 ? -1 : 1) * (lo + Math.floor(R() * (SHIFT_SPAN + 1)))])), ev = [];
            for (const e of rets) {
                const S = W.stocks.get(e.sym), i2 = e.i + sh.get(e.sym); if (i2 < 1 || i2 + H > iCut) continue;
                const cell = S.cell[i2]; if (cell < 0 || !(S.c[i2] > 0)) continue;
                const r = fwd(S, i2 + 1, i2 + H); if (r != null) ev.push({ d: W.cal[i2], key: W.cal[i2] + '|' + cell, r });
            }
            vals.push(mean(incCell(ev, base).dm));
        }
        return vals;
    };
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    // ㉕ 20 檔「本來就強」(每天多 0.15%,跟鉅額無關)晚進股票池(第 650 天才第一次出現鉅額),事件都在 650~860 → 往前挪落在池子外
    //    → 新寫法:整串沒地方挪 → 兩邊一起拿掉 → 換日 p 不小;決定性對照:舊寫法(挪不過去就丟掉)→ p ≤ 0.05(誤判有效果)
    {
        const T = 900, iCut = T - 1, H = 20, pN = [], pO = [];
        for (const seed of [31, 44, 57]) {
            const W = mkWorld(60, T, seed, s => (s < 20 ? 0.0015 : 0)), ev = [];
            for (let s = 0; s < 60; s++) {
                const S = W.stocks.get(String(1000 + s));
                if (s < 20) { S.first = 650; for (let i = 0; i < 650; i++) S.cell[i] = -1; for (let i0 = 650 + (s % 15); i0 <= 860; i0 += 15) ev.push({ i: i0, sym: String(1000 + s) }); }
                else for (let i0 = 100 + 3 * s; i0 <= 860; i0 += 45) ev.push({ i: i0, sym: String(1000 + s) });
            }
            ev.sort((a, b) => a.i - b.i);
            const B = buildBases(W, iCut), rets = evRets(ev, W, H, iCut), m = mean(incCell(rets, B.B[1]).dm), sS = shamShift(rets, W, H, B.B[1], iCut, 100, 11);
            pN.push(pSham(sS.vals, sS.actual, 1, true)); pO.push(pSham(naiveShift(rets, W, H, B.B[1], iCut, 100, 11), m, 1, true));
        }
        ok(med(pN) > 0.2 && Math.max(...pO) <= 0.05, `㉕ 本來就強、晚進股票池的那幾檔(沒有任何鉅額效果):換日 p ${pN.map(x => x.toFixed(2)).join(' / ')}(不會誤判);決定性對照:舊寫法 ${pO.map(x => x.toFixed(3)).join(' / ')}(誤判有效果)`);
    }
    // ㉖ 沒效果的 40 檔事件 8 檔擠同一天、本來就強的 20 檔事件各自分開(都從頭就在池子)→ 新寫法沿用每天的權重 → 不會誤判;決定性對照:舊寫法拆散成一筆一天 → 誤判
    {
        const T = 900, iCut = T - 1, H = 20, pN = [], pO = [];
        for (const seed of [41, 48, 55]) {
            const W = mkWorld(60, T, seed, s => (s < 20 ? 0.0015 : 0)), ev = [];
            for (let s = 0; s < 20; s++) for (let i0 = 300 + 3 * s; i0 <= 600; i0 += 60) ev.push({ i: i0, sym: String(1000 + s) });
            for (let s = 20; s < 60; s++) for (let i0 = 300 + 7 * ((s - 20) % 5); i0 <= 600; i0 += 60) ev.push({ i: i0, sym: String(1000 + s) });
            ev.sort((a, b) => a.i - b.i);
            const B = buildBases(W, iCut), rets = evRets(ev, W, H, iCut), m = mean(incCell(rets, B.B[1]).dm), sS = shamShift(rets, W, H, B.B[1], iCut, 100, 5);
            pN.push(pSham(sS.vals, sS.actual, 1, true)); pO.push(pSham(naiveShift(rets, W, H, B.B[1], iCut, 100, 5), m, 1, true));
        }
        ok(med(pN) > 0.2 && Math.max(...pO) <= 0.05, `㉖ 同一天擠很多筆的沒效果、分開的本來就強:換日 p ${pN.map(x => x.toFixed(2)).join(' / ')}(不會誤判);決定性對照:舊寫法 ${pO.map(x => x.toFixed(3)).join(' / ')}`);
    }
    // ㉗ 漲停價照跳動單位往下捨:參考價 99 → 漲停 108.5(+9.6%)、2012 年 ±7% → 105.5(+6.6%),一價到底 = 買不到;+3% 一價到底(只成交一筆)照樣買得到
    //    決定性對照:共用的 lockedBar(只看 +9.7% / +6.7%)兩個都當成買得到
    {
        const mk = (y, p1) => { const T = 20, cal = [...Array(T).keys()].map(i => new Date(Date.UTC(y, 5, 1) + i * 86400000).toISOString().slice(0, 10)), calIdx = new Map(cal.map((d, i) => [d, i]));
            const bars = []; for (let i = 0; i < T; i++) { const p = i < 10 ? 99 : (i === 10 ? p1 : p1 * 1.001); bars.push({ date: cal[i], open: p, high: p, low: p, close: p, volume: 1e6 }); }
            const A = alignStock(cal, calIdx, bars, []); A.date = cal; A.sk = new Float64Array(T).fill(1); markCliffs(A); return A; };
        const a16 = mk(2016, 108.5), a12 = mk(2012, 105.5), a3 = mk(2016, 101.97);
        const n16 = lockedBar(a16.date[10], 99, 108.5, 108.5, 108.5), n12 = lockedBar(a12.date[10], 99, 105.5, 105.5, 105.5);
        ok(fwdX(a16, 10, 15) === null && fwdX(a12, 10, 15) === null && fwdX(a3, 10, 15) !== null && n16 === 0 && n12 === 0,
           '㉗ 漲停價照跳動單位:參考價 99 一價到底 108.5(+9.6%)/ 2012 年 105.5(+6.6%)→ 買不到;+3% 一價到底照樣買得到;決定性對照:只看 +9.7% / +6.7% 的寫法兩個都當成買得到');
    }
    // ㉘ 去極端照「串」拿:394 筆 −0.5、同一檔重疊的 6 筆 +120(抱 60 天、每 10 天一筆)→ 整串拿掉 −0.50;決定性對照:一筆一筆拿 1%(4 筆)→ 還剩 +0.11
    {
        const rets = [], base = new Map(), add = (j, sym, i, r) => { const key = 'k' + j; rets.push({ d: `d${String(i).padStart(5, '0')}`, key, r, i, sym }); base.set(key, { s: r, n: 11 }); };
        for (let j = 0; j < 394; j++) add(j, 'N' + j, 30 * j, -0.5);
        for (let q = 0; q < 6; q++) add(394 + q, 'X', 20000 + 10 * q, 120);
        rets.sort((a, b) => a.i - b.i);
        const tc = trimDir(rets, base, 1, 0.01, MIN_CELL, 60), te = trimDir(rets, base, 1, 0.01, MIN_CELL, 0);
        ok(Math.abs(tc.m + 0.5) < 1e-9 && tc.dropEv === 9 && te.m > 0.1 && te.drop === 4,
           `㉘ 去極端 1% 照串拿:同一檔重疊的 6 筆算一串 → 拿掉之後 ${sg(tc.m)}(⑦ 不過);決定性對照:一筆一筆拿 ${te.drop} 筆 → 還剩 ${sg(te.m)}`);
    }
    // ㉙ 對照扣掉自己:同一天同一格 6 檔 1 / 2 / 3 / 4 / 5 / 10,事件那檔是 10 → 增量 = 10 − 3 = 7;決定性對照:含自己 = 10 − 4.17 = 5.83
    {
        const base = new Map([['d|0', { s: 25, n: 6 }]]), inc = incCell([{ d: 'd', key: 'd|0', r: 10 }], base, 5);
        ok(Math.abs(inc.dm[0] - 7) < 1e-12 && Math.abs((10 - 25 / 6) - 5.8333) < 1e-3, `㉙ 對照扣掉自己:增量 ${sg(inc.dm[0])}(含自己會是 ${sg(10 - 25 / 6)})`);
    }
    // ㉚ 兩個股票池都要過、而且方向一樣
    ok(bothOk({ ok: true, dir: 1 }, { ok: true, dir: 1 }) && !bothOk({ ok: true, dir: 1 }, { ok: true, dir: -1 }) && !bothOk({ ok: true, dir: 1 }, { ok: false, dir: 1 }),
       '㉚ 兩個股票池都七條全過而且方向一樣才算(一邊之後比較強、一邊之後比較弱 ⛔ 算)');
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過');
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
}
