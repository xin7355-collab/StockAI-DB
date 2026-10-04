#!/usr/bin/env node
/**
 * ⏱️ V78.4.4 👑 領頭羊「換倉那天,幾點賣 / 幾點買」—— 用 5 分 K 量(使用者:「領頭羊 10 日後當日賣出時段高機率,
 *   比如說開高沒鎖漲停賣、開平尾盤賣、開低尾盤賣…給我連貫作法」)
 *
 * ⭐ 先講清楚兩件事:
 *   ① 👑 ⛔ 不是「抱 10 天就賣」—— 每 10 個交易日換倉一次,**掉出前 10 名**才在隔天開盤賣(這支會印持有天數分布)。
 *   ② 「開高沒鎖賣 / 開平開低尾盤賣」是 `_LUNEXT_EDGE`(limitup_next_probe),**只測過「前一天收盤鎖漲停」**的股票。
 *      這支才是第一次在**領頭羊真的要賣 / 要買的那一天**量。
 *
 * 交易從哪裡來:⛔ 不寫第二份領頭羊規則 —— 直接 import `leader_probe.simulate`(現行 DEF)跑 17 條起點,`log` 收每一筆成交
 *   (賣 = 換倉日掉出前 10 名 → 隔天開盤;買 = 換倉日進前 5 名 → 隔天開盤),依(代號, 日期, 買賣)去重。
 * 5 分 K:`loadKbar5`(dt_kbar5_probe 那一支,⛔ 不複製),母體 = 每月初成交額前 100 ≈ 領頭羊池子;對不到的計數印出來。
 *
 * 開盤狀態(⭐ 只用「昨天收盤 + 今天開盤」= 09:00 就知道,⛔ 不看當天後面的價):
 *   LU 開盤就在漲停 ・G3 開高 ≥3% ・G0 開高 0~3% ・F 開平或開低 0~−3% ・D3 開低 ≤−3%
 *   昨收:先用昨天 5 分 K 最後一根(⭐ 陷阱 #46:日 K 有一段是還原價),沒有才用日 K;除權息日乘回倍數(參考價)。
 * 賣法(賣價 ÷ 開盤 − 1;⭐ 兩邊都只賣一次 → ⛔ 不重扣成本):
 *   T0905 / T0930 / T1000 / T1030 / T1100 / T1200 / T1325 = 那個時點的價(= 前一根 5 分 K 的收盤)・CLOSE 收盤
 *   BRK  第一根收盤跌破開盤就賣(那根收盤),沒有就收盤賣
 *   TR2  從開盤後最高回落 2% 就賣(那根收盤),沒有就收盤賣
 *   LUH  (只給 LU)鎖住就抱、第一根低點打開漲停就賣(那根收盤),一路鎖到收盤就收盤賣
 * 買法(開盤 ÷ 買價 − 1 = 比開盤便宜幾 %):同樣的固定時點與收盤(LU 照舊買不到,只計數)。
 * 對照:同一天、同一開盤狀態、5 分 K 母體裡**其他**股票同一個時點差(擋「那天整個盤怎麼走」),只看不判。
 * 六關(每一格 vs 開盤):① 平均 > 0 且 t ≥ 2 ② 前後半都 > 0 ③ 逐年(n≥10)≥ 70% > 0 ④ 拿掉最好那年仍 > 0
 *   ⑤ 拿掉最好 1% 仍 > 0 ⑥ 中位 > 0;固定時點另看高原(相鄰時點同號)。
 * 連貫作法:每一類只有六關全過 + 高原才換掉「開盤」,其他照開盤。⭐ 再拿去組合驗證:
 *   `INTRA_PX` → leader_probe `intraPx`,17 條 × 兩個窗口逐條配對 + 安慰劑(每筆隨機挑時點)。
 *   ⚠️ 選規則跟驗證用的是同一段資料 → 另外印「只用前半選、後半驗」那一行(樣本外)。
 *
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5 \
 *        node --max-old-space-size=12000 scripts/leader_intraday_probe.mjs out.json
 *       node scripts/leader_intraday_probe.mjs --selftest
 * ⛔ 只讀、不打 API。exit 0(探針不進四驗證)。
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

export const STATES = ['LU', 'G3', 'G0', 'F', 'D3'];
export const STATE_NAME = { LU: '開盤就漲停', G3: '開高 ≥3%', G0: '開高 0~3%', F: '開平或開低 0~3%', D3: '開低 ≥3%' };
export const TIMES = [['T0905', 545], ['T0930', 570], ['T1000', 600], ['T1030', 630], ['T1100', 660], ['T1200', 720], ['T1325', 805]];
export const SELL_RULES = ['T0905', 'T0930', 'T1000', 'T1030', 'T1100', 'T1200', 'T1325', 'CLOSE', 'BRK', 'TR2', 'LUH'];
export const BUY_RULES = ['T0905', 'T0930', 'T1000', 'T1030', 'T1100', 'T1200', 'T1325', 'CLOSE'];
export const RULE_NAME = { OPEN: '開盤', T0905: '09:05', T0930: '09:30', T1000: '10:00', T1030: '10:30', T1100: '11:00', T1200: '12:00', T1325: '13:25', CLOSE: '收盤',
    BRK: '第一根跌破開盤就賣', TR2: '從高點回落 2% 就賣', LUH: '鎖住抱・打開就賣' };
const LU_THR = 1.09;   // 同 limitup_next_probe.lockThr(2015-06 之後)

/** 開盤狀態:⛔ 只吃開盤、昨收、除權息倍數(參考價 = 昨收 ÷ F) */
export function classify(open, prevC, F = 1) {
    if (!(open > 0 && prevC > 0)) return null;
    const ref = prevC / (F > 0 ? F : 1), g = open / ref - 1;
    if (open >= ref * LU_THR) return 'LU';
    if (g >= 0.03) return 'G3';
    if (g > 0) return 'G0';
    if (g > -0.03) return 'F';
    return 'D3';
}
/** 「T 點的價」= hm < T 的最後一根收盤(⭐ 09:05 = 09:00 那根收盤);一根都沒有 → null */
export function pxAt(bars, T) { let p = null; for (const b of bars) { if (b[0] + 5 <= T) p = b[4]; else break; } return p; }
/** 一天的 5 分 K → 每一種賣法 / 買法的價(bars = [[hm,o,h,l,c,v]],依時間排好);ref = 昨收參考價 */
export function rulePrices(bars, ref) {
    if (!bars || !bars.length) return null;
    const open = bars[0][1], close = bars[bars.length - 1][4];
    if (!(open > 0 && close > 0)) return null;
    const out = { OPEN: open, CLOSE: close };
    for (const [k, T] of TIMES) out[k] = pxAt(bars, T) ?? open;
    let brk = null; for (const b of bars) { if (b[4] < open) { brk = b[4]; break; } } out.BRK = brk ?? close;
    let hi = open, tr = null; for (const b of bars) { hi = Math.max(hi, b[2]); if (b[4] <= hi * 0.98) { tr = b[4]; break; } } out.TR2 = tr ?? close;
    if (ref > 0) { const lim = ref * LU_THR; let luh = null; for (const b of bars) { if (b[3] < lim) { luh = b[4]; break; } } out.LUH = luh ?? close; }
    else out.LUH = close;
    return out;
}
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sdv = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const r2 = x => Math.round(x * 100) / 100;
/** 六關:evs = [{d, v}](v = %)→ {n, m, t, med, p(比開盤好機率), g:[6 個布林], pass} */
export function gates(evs) {
    const v = evs.map(e => e.v), n = v.length;
    if (n < 30) return { n, pass: 0, g: [], small: true, m: mean(v) };
    const m = mean(v), s = sdv(v), t = s > 0 ? m / (s / Math.sqrt(n)) : 0, med = median(v);
    const srt = [...evs].sort((a, b) => a.d < b.d ? -1 : 1), h = n >> 1;
    const h1 = mean(srt.slice(0, h).map(e => e.v)), h2 = mean(srt.slice(h).map(e => e.v));
    const ys = {}; for (const e of evs) (ys[e.d.slice(0, 4)] = ys[e.d.slice(0, 4)] || []).push(e.v);
    const yr = Object.entries(ys).filter(([, a]) => a.length >= 10).map(([y, a]) => [y, mean(a), a.length]);
    const yrOK = yr.length >= 2 && yr.filter(x => x[1] > 0).length / yr.length >= 0.7;
    let dropY = false; if (yr.length >= 2) { const best = yr.reduce((a, b) => b[1] > a[1] ? b : a); const rest = evs.filter(e => e.d.slice(0, 4) !== best[0]).map(e => e.v); dropY = mean(rest) > 0; }
    const cut = [...v].sort((a, b) => b - a).slice(Math.max(1, Math.round(n * 0.01))); const drop1 = mean(cut) > 0;
    const g = [m > 0 && t >= 2, h1 > 0 && h2 > 0, yrOK, dropY, drop1, med > 0];
    return { n, m, t, med, h1, h2, yr: Object.fromEntries(yr.map(x => [x[0], r2(x[1])])), p: v.filter(x => x > 0).length / n * 100, eq: v.filter(x => x === 0).length / n * 100, g, pass: g.filter(Boolean).length };
}

// ═════════ selftest ═════════
function selftest() {
    let ok = 0, bad = 0; const T = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    T(classify(110, 100) === 'LU' && classify(104, 100) === 'G3' && classify(101, 100) === 'G0' && classify(100, 100) === 'F' && classify(98, 100) === 'F' && classify(96, 100) === 'D3', '① 開盤分類:漲停 / 開高 ≥3 / 0~3 / 開平開低 0~3 / 開低 ≥3');
    T(classify(100, 105, 1.05) === 'F' && classify(100, 105) === 'D3', '② 除權息日用參考價(昨收 ÷ 倍數):除息 5% 那天開 100 ⛔ 不算開低 5%');
    const day = [[540, 100, 101, 99, 100.5, 1], [545, 100.5, 102, 100, 101, 1], [595, 101, 103, 101, 102, 1], [805, 102, 102, 98, 98, 1], [810, 98, 98, 98, 97.5, 1]];
    const rp = rulePrices(day, 95);
    T(rp.T0905 === 100.5 && rp.T0930 === 101 && rp.T1000 === 102 && rp.T1030 === 102 && rp.T1325 === 102 && rp.CLOSE === 97.5 && rp.OPEN === 100, `③ 時點取價:09:05 = 09:00 那根收盤、中間沒成交就沿用前一根、收盤 = 最後一根(${JSON.stringify(rp)})`);
    T(rp.BRK === 98 && rp.TR2 === 98, '④ 第一根跌破開盤 / 從高點回落 2%:都在 13:25 那根(98)才觸發');
    const lu = [[540, 110, 110, 110, 110, 1], [545, 110, 110, 108, 109, 1], [810, 109, 110, 109, 110, 1]];
    T(rulePrices(lu, 100).LUH === 109 && rulePrices([[540, 110, 110, 110, 110, 1], [810, 110, 110, 110, 110, 1]], 100).LUH === 110, '⑤ 鎖住抱:第一根低點打開漲停就賣那根收盤;一路鎖到收盤 = 收盤');
    T(classify(day[0][1], 100) === classify(day[0][1], 100) && classify(100, 100) === 'F', '⑥ 分類只吃開盤:⛔ 不看當天收盤(收盤 97.5 不會把它改成開低)');
    // ⑦ 注入:10:00 永遠比開盤高 2% → 量得到且六關全過
    const evs = []; let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let y = 2021; y <= 2026; y++) for (let k = 0; k < 80; k++) evs.push({ d: `${y}-0${1 + (k % 9)}-1${k % 10}`, v: 2 + (rnd() - 0.5) * 2 });
    const g7 = gates(evs);
    T(g7.pass === 6 && Math.abs(g7.m - 2) < 0.2, `⑦ 注入 +2% → 平均 ${r2(g7.m)}、六關 ${g7.pass}/6`);
    // ⑧ 隨機 0 均值 → 不可全過
    const ev0 = evs.map(e => ({ d: e.d, v: (rnd() - 0.5) * 4 }));
    T(gates(ev0).pass < 6, `⑧ 雜訊 → 不可全過(${gates(ev0).pass}/6)`);
    // ⑨ 一年賺很多其他年賠 → 逐年 / 去最好年要擋
    const ev9 = evs.map(e => ({ d: e.d, v: e.d.startsWith('2021') ? 20 : -1 }));
    const g9 = gates(ev9);
    T(!g9.g[2] && !g9.g[3], `⑨ 只靠一年 → 逐年與拿掉最好那年擋掉(${g9.g.map(x => x ? 1 : 0).join('')})`);
    T(gates(evs.slice(0, 20)).small === true, '⑩ 樣本 <30 → ⛔ 不判');
    console.log(`\n${bad ? '❌' : '✅'} LEADER_INTRADAY_SELFTEST ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

// ═════════ main ═════════
async function main() {
    const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';
    const { loadCtx, simulate, DEF } = await import('./leader_probe.mjs');
    const { loadKbar5 } = await import('./dt_kbar5_probe.mjs');
    const DATA = process.env.DATA_DIR, DIV = process.env.DIV || '';
    if (!DATA || !process.env.KBAR5_DIR) { console.log('❌ 要 DATA_DIR 與 KBAR5_DIR'); process.exit(1); }
    const STEP = +(process.env.PATH_STEP || 3), PATHS = 17;
    const WINS = (process.env.WINS || '2021-06-01,2022-09-16').split(',');
    console.log('📂 載入 K 線…'); const ctx = loadCtx(DATA, DIV); const { cal } = ctx;
    const cIdx = new Map(cal.map((d, i) => [d, i])), bySym = new Map(ctx.stocks.map(S => [S.sym, S]));
    console.log(`   ${ctx.stocks.length} 檔 ・${cal[0]} ~ ${cal.at(-1)}`);
    console.log('📂 載入 5 分 K…'); const K5 = loadKbar5(process.env.KBAR5_DIR, { mergeSyms: true });   // V78.4.6 kbar5_lead 補 kbar5_deep 沒收到的檔
    const kDays = Object.keys(K5.days).sort(); console.log(`   ${kDays.length} 天 ・${kDays[0]} ~ ${kDays.at(-1)} ・母體:${K5.bias}`);
    const prevK = new Map(); for (let q = 1; q < kDays.length; q++) prevK.set(kDays[q], kDays[q - 1]);
    const barsOf = (sym, d) => { const D = K5.days[d]; return D && D.k ? D.k[sym] : null; };
    const refOf = (sym, d) => {   // 昨收參考價:昨天 5 分 K 最後一根 → 日 K;除以除權息倍數
        const S = bySym.get(sym), i = cIdx.get(d); if (i == null || i < 1) return null;
        const F = S ? S.F[i] : 1; const pd = cal[i - 1];
        const pb = prevK.get(d) === pd ? barsOf(sym, pd) : null;
        const pc = pb && pb.length ? pb.at(-1)[4] : (S ? S.C[i - 1] : NaN);
        return pc > 0 ? { ref: pc / (F > 0 ? F : 1), F, src: pb && pb.length ? 'k5' : 'day' } : null;
    };
    const dayRows = (sym, d) => { const b = barsOf(sym, d); const r = refOf(sym, d); if (!b || !b.length || !r) return null; const st = classify(b[0][1], r.ref * r.F, r.F); const P = rulePrices(b, r.ref); return P && st ? { st, P, ref: r } : null; };

    // ① 17 條 × 每個窗口跑現行 DEF,收成交
    const runs = {};
    const evMap = new Map();   // key sym|date|side → {sym,d,side,why,e}
    const hold = [];
    for (const W of WINS) {
        const s0 = cal.findIndex(d => d >= W); runs[W] = [];
        for (let k = 0; k < PATHS; k++) {
            const log = [], s = s0 + STEP * k;
            const r = simulate(ctx, s, { ...DEF, log }, 1000 + k);
            runs[W].push({ s, r });
            for (const x of log) { if (x.d < kDays[0]) continue; const key = `${x.s}|${x.d}|${x.side}`; if (!evMap.has(key)) evMap.set(key, x); if (x.side === 'S' && x.e) { const a = cIdx.get(x.e), b = cIdx.get(x.d); if (a != null && b != null) hold.push(b - a); } }
        }
    }
    const evAll = [...evMap.values()];
    console.log(`\n📒 去重後成交:賣 ${evAll.filter(x => x.side === 'S').length} ・買 ${evAll.filter(x => x.side === 'B').length}(${kDays[0]} 之後)`);
    // 持有天數分布(⭐ 回答「是不是 10 天後賣」)
    { const hs = [...hold].sort((a, b) => a - b), q = p => hs[Math.min(hs.length - 1, Math.floor(hs.length * p))];
      const bk = [[1, 10], [11, 20], [21, 40], [41, 80], [81, 1e9]].map(([a, b]) => [`${a}~${b < 1e9 ? b : ''}`, hs.filter(x => x >= a && x <= b).length / hs.length * 100]);
      console.log(`⏳ 持有幾個交易日(賣出那筆,${hs.length} 筆):中位 ${q(0.5)} ・P25 ${q(0.25)} ・P75 ${q(0.75)} ・P90 ${q(0.9)} ・${bk.map(([k, v]) => `${k} 天 ${r2(v)}%`).join(' ・')}`);
      runs._hold = { n: hs.length, med: q(0.5), p25: q(0.25), p75: q(0.75), p90: q(0.9), bk: Object.fromEntries(bk.map(([k, v]) => [k, r2(v)])) }; }

    // ② 每一筆 → 開盤狀態 + 各規則的值;對照 = 同一天同狀態母體其他股票
    const ctrlCache = new Map();
    const ctrlOf = (d, st, side, rule, excl) => {
        const key = `${d}|${st}|${side}|${rule}`;
        if (!ctrlCache.has(key)) {
            const D = K5.days[d], vals = [];
            if (D && D.k) for (const sym of Object.keys(D.k)) { if (sym === excl || !/^\d{4}$/.test(sym)) continue; const x = dayRows(sym, d); if (!x || x.st !== st) continue; vals.push(side === 'S' ? (x.P[rule] / x.P.OPEN - 1) * 100 : (x.P.OPEN / x.P[rule] - 1) * 100); }
            ctrlCache.set(key, vals.length >= 5 ? mean(vals) : null);
        }
        return ctrlCache.get(key);
    };
    const cnt = { miss: 0, ok: 0, luBuy: 0, srcDay: 0 };
    const rows = [];
    for (const x of evAll) {
        const z = dayRows(x.s, x.d); if (!z) { cnt.miss++; continue; }
        cnt.ok++; if (z.ref.src === 'day') cnt.srcDay++;
        if (x.side === 'B' && z.st === 'LU') { cnt.luBuy++; continue; }
        rows.push({ ...x, st: z.st, P: z.P });
    }
    console.log(`🔗 對到 5 分 K:${cnt.ok} ・對不到 ${cnt.miss}(⛔ 不補)・昨收改用日 K ${cnt.srcDay} ・買進日開盤漲停(本來就買不到)${cnt.luBuy}`);

    const res = { S: {}, B: {} };
    for (const side of ['S', 'B']) {
        const RULES = side === 'S' ? SELL_RULES : BUY_RULES;
        console.log('\n' + '═'.repeat(110));
        console.log(side === 'S' ? '【賣出日】換倉掉出前 10 名 → 現行 = 開盤賣。每一格 = 換成這個時點賣,比開盤多(少)幾 %' : '【買進日】換倉進前 5 名 → 現行 = 開盤買。每一格 = 換成這個時點買,比開盤便宜(貴)幾 %');
        console.log('═'.repeat(110));
        for (const st of STATES) {
            const sub = rows.filter(r => r.side === side && r.st === st); if (!sub.length) continue;
            console.log(`\n── ${STATE_NAME[st]} ・${sub.length} 筆(佔 ${r2(sub.length / rows.filter(r => r.side === side).length * 100)}%)──`);
            console.log('時點/規則'.padEnd(20) + '  平均%   中位%   t     比開盤好%  對照(同天同狀態)  前半  後半  逐年                      六關');
            res[side][st] = { n: sub.length, rules: {} };
            for (const rule of RULES) {
                if (rule === 'LUH' && st !== 'LU') continue;
                const evs = sub.map(r => ({ d: r.d, v: side === 'S' ? (r.P[rule] / r.P.OPEN - 1) * 100 : (r.P.OPEN / r.P[rule] - 1) * 100 }));
                const g = gates(evs);
                const cv = sub.map(r => ctrlOf(r.d, st, side, rule, r.s)).filter(v => v != null);
                const c = cv.length ? mean(cv) : null;
                res[side][st].rules[rule] = { ...g, ctrl: c == null ? null : r2(c), m: r2(g.m), t: r2(g.t || 0), med: r2(g.med || 0), p: r2(g.p || 0), h1: r2(g.h1 || 0), h2: r2(g.h2 || 0) };
                if (g.small) { console.log(`${RULE_NAME[rule].padEnd(18)} 樣本不足(${g.n})`); continue; }
                console.log(`${RULE_NAME[rule].padEnd(18)}${r2(g.m).toFixed(2).padStart(8)}${r2(g.med).toFixed(2).padStart(8)}${r2(g.t).toFixed(1).padStart(6)}${r2(g.p).toFixed(1).padStart(10)}${(c == null ? '—' : r2(c).toFixed(2)).padStart(14)}      ${r2(g.h1).toFixed(2).padStart(6)}${r2(g.h2).toFixed(2).padStart(6)}  ${Object.entries(g.yr).map(([y, v]) => y.slice(2) + ':' + v).join(' ').padEnd(26)}${g.pass}/6`);
            }
        }
    }

    // ③ 連貫作法:每一類只換「六關全過 + 高原」的;另外「前半選、後半驗」
    const tOrder = TIMES.map(x => x[0]).concat('CLOSE');
    const plateau = (side, st, rule) => { const i = tOrder.indexOf(rule); if (i < 0) return true; const R = res[side][st].rules; const nb = [tOrder[i - 1], tOrder[i + 1]].filter(Boolean).map(k => R[k]).filter(x => x && !x.small); return nb.some(x => x.m > 0); };
    const choose = (side, pickFrom) => {
        const out = {};
        for (const st of STATES) {
            if (!res[side][st]) { out[st] = 'OPEN'; continue; }
            let best = 'OPEN', bm = 0;
            for (const [rule, g] of Object.entries(res[side][st].rules)) { if (g.pass === 6 && plateau(side, st, rule) && g.m > bm && (!pickFrom || pickFrom(side, st, rule))) { best = rule; bm = g.m; } }
            out[st] = best;
        }
        return out;
    };
    const plan = { S: choose('S'), B: choose('B') };
    console.log('\n' + '═'.repeat(110) + '\n【連貫作法】只換「六關全過 + 相鄰時點同號」的,其餘照開盤');
    for (const side of ['S', 'B']) console.log(`  ${side === 'S' ? '賣出日' : '買進日'}:` + STATES.map(st => `${STATE_NAME[st]} → ${RULE_NAME[plan[side][st]]}`).join(' ・'));
    // 樣本外:前半(< 中位日)選、後半驗
    const allD = rows.map(r => r.d).sort(), midD = allD[allD.length >> 1];
    const oos = {};
    for (const side of ['S', 'B']) {
        oos[side] = {};
        for (const st of STATES) {
            const sub = rows.filter(r => r.side === side && r.st === st); if (sub.length < 60) continue;
            const RULES = (side === 'S' ? SELL_RULES : BUY_RULES).filter(r => r !== 'LUH' || st === 'LU');
            const val = (r, rule) => side === 'S' ? (r.P[rule] / r.P.OPEN - 1) * 100 : (r.P.OPEN / r.P[rule] - 1) * 100;
            const A = sub.filter(r => r.d < midD), B = sub.filter(r => r.d >= midD); if (A.length < 30 || B.length < 30) continue;
            let best = null, bm = -1e9; for (const rule of RULES) { const m = mean(A.map(r => val(r, rule))); if (m > bm) { bm = m; best = rule; } }
            const mB = mean(B.map(r => val(r, best)));
            oos[side][st] = { pick: best, inS: r2(bm), outS: r2(mB), nA: A.length, nB: B.length };
            console.log(`  🔍 樣本外 ${side === 'S' ? '賣' : '買'}・${STATE_NAME[st]}:前半最好 = ${RULE_NAME[best]}(${r2(bm)}%)→ 後半 ${r2(mB)}%`);
        }
    }

    // ④ 組合驗證:INTRA_PX → leader_probe intraPx;安慰劑 = 每筆隨機挑一個固定時點
    const mkMap = (planX, sham) => {
        const m = new Map(); let sd = 99991; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
        for (const r of rows) {
            const S = bySym.get(r.s), i = cIdx.get(r.d); if (!S || i == null || !(S.O[i] > 0)) continue;
            let rule = sham ? null : planX[r.side][r.st];
            if (sham) { const pool = ['OPEN', ...tOrder]; rule = pool[Math.floor(rnd() * pool.length)]; }
            if (!rule || rule === 'OPEN') continue;
            const ratio = r.P[rule] / r.P.OPEN; if (!(ratio > 0)) continue;
            m.set(`${r.s}|${r.d}|${r.side}`, S.O[i] * ratio);
        }
        return m;
    };
    const changed = STATES.some(st => plan.S[st] !== 'OPEN' || plan.B[st] !== 'OPEN');
    // ⭐ 也跑使用者講的那一套(開高 → 開盤賣、開平 / 開低 → 尾盤賣;買照開盤)= 直接回答「我說的對不對」
    const userPlan = { S: { LU: 'OPEN', G3: 'OPEN', G0: 'OPEN', F: 'T1325', D3: 'T1325' }, B: Object.fromEntries(STATES.map(s => [s, 'OPEN'])) };
    const combo = {};
    const arms = [['現行(開盤)', null], ['使用者那套', mkMap(userPlan)], ['安慰劑(隨機時點)', mkMap(null, true)]];
    if (changed) arms.splice(1, 0, ['連貫作法', mkMap(plan)]);
    for (const W of WINS) {
        const s0 = cal.findIndex(d => d >= W);
        const base = runs[W].map(x => x.r.eq.at(-1));
        combo[W] = {};
        console.log(`\n── 組合驗證 ${W} 起 ・17 條(現行中位 ${r2((median(base) - 1) * 100)}%)──`);
        for (const [name, mp] of arms) {
            if (!mp) { combo[W][name] = { med: r2((median(base) - 1) * 100) }; continue; }
            const fin = [], hit = [], miss = [];
            for (let k = 0; k < PATHS; k++) { const r = simulate(ctx, s0 + STEP * k, { ...DEF, intraPx: mp }, 1000 + k); fin.push(r.eq.at(-1)); hit.push(r.st.ipxHit || 0); miss.push(r.st.ipxMiss || 0); }
            const beat = fin.filter((v, k) => v > base[k]).length;
            const dMed = median(fin.map((v, k) => (v / base[k] - 1) * 100));
            combo[W][name] = { med: r2((median(fin) - 1) * 100), beat, dMed: r2(dMed), hit: median(hit), miss: median(miss) };
            console.log(`  ${name.padEnd(14)} 中位 ${r2((median(fin) - 1) * 100)}% ・贏現行 ${beat}/17 ・每條差距中位 ${r2(dMed)}% ・換成盤中價 ${median(hit)} 筆 / 照開盤 ${median(miss)} 筆`);
        }
    }
    const out = { at: new Date().toISOString().slice(0, 10), k5: { days: kDays.length, from: kDays[0], to: kDays.at(-1), bias: K5.bias }, cnt, hold: runs._hold, res, plan, userPlan, oos, combo };
    if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out)); console.log(`\n💾 ${OUT}`); }
}

const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (_isMain) { if (process.argv.includes('--selftest')) process.exit(selftest()); else main(); }
