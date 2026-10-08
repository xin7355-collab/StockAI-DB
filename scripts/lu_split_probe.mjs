#!/usr/bin/env node
/**
 * 🟥🔪 lu_split_probe.mjs —— 「今天收盤鎖漲停的股票,隔天開盤買」拆開看:哪一種漲停才有參考價值?(V78.6.5)
 *
 * 使用者(2026-10-08):「還是你改今天漲停上市股去回測看看有沒有參考價值,或者你有沒有其它想法」。
 * 整體早就測過是零(downday_lu_probe:平常日子鎖漲停 30,359 次 ≈0;pond_probe 買得到的 −0.51%)→ 這一支只做「拆桶」:
 *   市場別(上市 / 上櫃,使用者點名)・量(量縮鎖 ≤0.6x / 普通 / 爆量鎖 >1.5x,⛔ 基準不含當天)・連續第幾根 ・一年位階四分位 ・
 *   同產業當天幾檔鎖漲停 ・隔天開盤開在哪(事後才知道,只回答「開在哪一段才值得買」)・幾點鎖住(kbar5,只有熱門股)
 * 事件:任一檔第 i 天收盤鎖漲停(lockUp:收盤 ≥ 前收 ×(1+漲跌幅−1%)且收在最高;除權息日不判),⛔ 不限大盤方向
 * 進場:隔天開盤買(開盤離漲停 <0.3% = 買不到 → 剔除並計數),抱 h = 1 / 5 / 10 / 20 天收盤賣;扣同期 0050 含息、扣成本 0.44%
 * 去重:同一檔**同一桶** 20 日一次(⛔ 不是整檔去重 —— 否則連兩天鎖的第 2 天永遠進不了「連續:第 2 根」那桶;「全部」桶因此只收每一串的第一天)
 * 對照:增量 = 事件 − 同一天全部買得到的股票平均(maxim_kbar5_probe.gates 的六關就是對這個算);桶對桶比;安慰劑在組合層
 * 組合層(PORT_KEYS):100 萬 / 5 格 / 隔天開盤買抱 N 天 / 閒錢 0050 / 17 條起點 / 同一天同檔數隨機股票當安慰劑(lu_setup_probe.portfolio entry:'open')
 *
 * ⚠️ 整體是零時拆桶很容易挑到孤峰 → 六關一樣不能少,量比門檻 0.5/0.6/0.7、位階兩種切法當高原,過了也只回報、⛔ 不直接做成選股。
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json NAMES=$S/od2/data/stock_names.json IND_MAP=$S/od2/data/industry_map.json \
 *       KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5 node --max-old-space-size=11000 scripts/lu_split_probe.mjs out.json
 *       FROM=2022-09-16 只算那之後 ・ PORT_KEYS='市場:上市|量:量縮≤0.6' END=2025-12-31 組合層 ・ DISP_PERIODS=$S/disp_periods.json 多切「處置中 / 非處置」
 *       node scripts/lu_split_probe.mjs --selftest
 */
import fs from 'fs';
import { lockUp, fwd } from './downday_lu_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';
import { portfolio } from './lu_setup_probe.mjs';

const COST = 0.44, DEDUP = 20, HS = [1, 5, 10, 20], POSW = 250;
const limOf = d => (d < '2015-06-01' ? 0.07 : 0.10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

/** 量比:當天量 ÷ 前 20 個有交易日的平均量(⛔ 不含當天,陷阱 #43);不足 10 天回 NaN */
export function volRatio(S, i) { let s = 0, c = 0; for (let j = i - 1; j >= 0 && c < 20; j--) { if (S.C[j] > 0 && S.V[j] > 0) { s += S.V[j]; c++; } } return c >= 10 && S.V[i] > 0 ? S.V[i] / (s / c) : NaN; }
/** 連續第幾根鎖漲停(含今天) */
export function streakOf(S, i, cal) { let k = 0; while (i - k > 0 && lockUp(S, i - k, cal)) k++; return k; }
/** 一年位階 0~100(high/low,含今天,同 app._basePos 口徑);不足 120 天回 NaN */
export function posOf(S, i) { let hi = -Infinity, lo = Infinity, c = 0; for (let j = i; j >= 0 && c < POSW; j--) { if (!(S.C[j] > 0)) continue; c++; if (S.H[j] > hi) hi = S.H[j]; if (S.L[j] < lo) lo = S.L[j]; }
    return c >= 120 && hi > lo ? 100 * (S.C[i] - lo) / (hi - lo) : NaN; }
/** 幾點鎖住:第一根 5 分 K 收盤 ≥ 漲停價、之後每一根都沒掉下來 → 那一根的絕對分鐘;沒資料回 null */
export function lockMin(bars, luPx) { if (!bars || !bars.length) return null; let j = -1;
    for (let k = 0; k < bars.length; k++) { if (bars[k][4] >= luPx - 1e-9) { if (j < 0) j = k; } else j = -1; }
    return j >= 0 ? bars[j][0] : 'never'; }

export function scan(ctx, opt = {}) {
    const { cal, stocks, etf } = ctx, n = cal.length, mkt = opt.mkt || {}, ind = opt.ind || {}, k5 = opt.k5 || null;
    const FROM = opt.FROM || '', vrs = opt.vrs || [0.5, 0.6, 0.7];
    const out = { ev: {}, cnt: { lim: 0, ev: 0 } };
    const put = (k, h, o) => ((out.ev[k] = out.ev[k] || {})[h] = (out.ev[k][h] || [])).push(o);
    const dayAll = new Map();
    const allMean = (i, h) => { const key = i * 100 + h; if (dayAll.has(key)) return dayAll.get(key); const a = [];
        for (const S of stocks) { const r = fwd(S, i, h, cal); if (typeof r === 'number') a.push(r); }
        const v = a.length >= 30 ? mean(a) : NaN; dayAll.set(key, v); return v; };
    const bench = (i, h) => (etf.tr[i + h] > 0 && etf.tr[i] > 0 ? (etf.tr[i + h] / etf.tr[i] - 1) * 100 : NaN);
    // 🎯 開低那桶的真正對照:同一天**同樣開低幅度**、但昨天沒鎖漲停的全部股票(開盤買→收盤賣)—— 回答「是漲停股才反彈,還是任何開低的股票都會反彈」
    const gBin = g => (g < -5 ? 3 : g < -3 ? 2 : g < -1 ? 1 : g < -0.5 ? 0 : -1);
    const dayGD = new Map();
    const gdMean = (i, bin) => { const key = i * 10 + bin; if (dayGD.has(key)) return dayGD.get(key); const acc = [[], [], [], []];
        for (const S of stocks) { if (!(S.O[i + 1] > 0 && S.C[i] > 0) || lockUp(S, i, cal)) continue; const b = gBin(100 * (S.O[i + 1] / S.C[i] - 1)); if (b < 0) continue; const r = fwd(S, i, 1, cal); if (typeof r === 'number') acc[b].push(r); }
        for (let b = 0; b < 4; b++) dayGD.set(i * 10 + b, acc[b].length >= 5 ? mean(acc[b]) : NaN); return dayGD.get(key); };
    const dper = ctx.dper || null;
    const inDisp = (sym, t) => { const a = dper && dper.get(sym); return !!(a && a.some(p => p.s != null && p.s <= t && t <= p.e)); };
    const last = new Map();
    for (let i = 21; i < n - 1; i++) {
        if (cal[i] < FROM) continue;
        const lu = []; for (const S of stocks) if (lockUp(S, i, cal)) lu.push(S);
        if (!lu.length) continue;
        const grp = {}; for (const S of lu) { const g = ind[S.sym]; if (g) grp[g] = (grp[g] || 0) + 1; }
        for (const S of lu) {
            out.cnt.ev++;   // 去重放在「桶」層(同一檔同一桶 20 天一次)—— 連兩天鎖的第 2 天才進得了「連續:第2根」那桶
            const r1 = fwd(S, i, 1, cal); if (r1 === 'lim') { out.cnt.lim++; put('_lim', 1, { d: cal[i], s: S.sym }); continue; }
            const tags = ['全部'];
            const m = mkt[S.sym]; tags.push('市場:' + (m === 'twse' ? '上市' : m === 'tpex' ? '上櫃' : '不明'));
            const vr = volRatio(S, i);
            if (Number.isFinite(vr)) { for (const R of vrs) if (vr <= R) tags.push(`量:量縮≤${R}`); if (vr > 1.5) tags.push('量:爆量>1.5'); else if (vr > 0.6) tags.push('量:普通0.6~1.5'); }
            const st = streakOf(S, i, cal); tags.push('連續:' + (st >= 3 ? '第≥3根' : `第${st}根`));
            const pos = posOf(S, i);
            if (Number.isFinite(pos)) { tags.push('位階:' + (pos < 25 ? '<25' : pos < 50 ? '25~50' : pos < 75 ? '50~75' : '≥75')); tags.push('位階b:' + (pos < 20 ? '<20' : pos < 50 ? '20~50' : pos < 80 ? '50~80' : '≥80')); }
            const g = ind[S.sym]; if (g) { const c = grp[g]; tags.push('族群同日:' + (c >= 3 ? '≥3家' : `${c}家`)); }
            const gap = S.O[i + 1] > 0 ? 100 * (S.O[i + 1] / S.C[i] - 1) : NaN;
            if (Number.isFinite(gap)) tags.push('隔天開盤:' + (gap < -1 ? '開低<−1%' : gap <= 1 ? '開平±1%' : gap < 5 ? '開高1~5%' : '開高≥5%'));
            if (k5) { const D = k5[cal[i]]; const bars = D && D.k && D.k[S.sym]; if (bars) { const lm = lockMin(bars, S.C[i]);
                if (lm != null) tags.push('鎖住時間:' + (lm === 'never' ? '收盤才到' : lm <= 545 ? '09:05前' : lm <= 600 ? '10:00前' : lm <= 720 ? '12:00前' : '12:00後')); } }
            // ⏱️ 隔天的 5 分 K(只有熱門股有):「開盤價」買不買得到?→ 同一批事件改用 09:05 那根的開盤價進場,當天收盤賣(扣 0050 同期與成本)
            let r905 = null, r900 = null;
            if (k5) { const D1 = k5[cal[i + 1]]; const b1 = D1 && D1.k && D1.k[S.sym];
                if (b1 && b1.length > 2 && b1[0][0] === 540 && b1[1][0] === 545 && b1[1][1] > 0 && S.C[i + 1] > 0 && Number.isFinite(bench(i, 1))) {
                    r905 = (S.C[i + 1] / b1[1][1] - 1) * 100 - bench(i, 1) - COST;            // 09:05 那根的第一筆成交(= 開盤後 5 分鐘)
                    r900 = (S.C[i + 1] / S.O[i + 1] - 1) * 100 - bench(i, 1) - COST; } }    // 同一批事件用日 K 開盤價(對照)
            if (m === 'twse') { if (Number.isFinite(vr) && vr <= 0.6) tags.push('上市×量縮≤0.6'); if (st === 1) tags.push('上市×第1根'); }
            if (Number.isFinite(vr) && vr <= 0.6 && Number.isFinite(gap)) tags.push('量縮≤0.6×' + (gap < -1 ? '開低' : gap <= 1 ? '開平' : gap < 5 ? '開高1~5' : '開高≥5'));
            if (Number.isFinite(gap) && gap < -1) {                                          // 開低那桶再切:深度高原 / 市場別 / 量
                tags.push('開低深:' + (gap < -5 ? '<−5%' : gap < -3 ? '−3~−5%' : '−1~−3%'));
                tags.push('開低×' + (m === 'twse' ? '上市' : m === 'tpex' ? '上櫃' : '不明'));
                if (Number.isFinite(vr)) tags.push('開低×' + (vr > 1.5 ? '爆量鎖' : vr <= 0.6 ? '量縮鎖' : '普通量'));
                tags.push('開低×' + (st >= 2 ? '連續第≥2根' : '第1根')); }
            if (Number.isFinite(gap) && gap < -0.5 && gap >= -1) tags.push('開低深:−0.5~−1%');
            let incGD = NaN;
            if (Number.isFinite(gap) && gap < -1) { const gm = gdMean(i, gBin(gap)); incGD = Number.isFinite(gm) ? r1 - gm : NaN;
                if (dper && cal[i] >= '2023-06-01') tags.push(inDisp(S.sym, i + 1) ? '開低×處置中' : '開低×非處置'); }
            const okTags = tags.filter(tg => { const key = S.sym + '|' + tg, lp = last.get(key); if (lp != null && i - lp < DEDUP) return false; last.set(key, i); return true; });
            if (!okTags.length) continue;
            const nextLU = lockUp(S, i + 1, cal) ? 1 : 0;
            for (const h of HS) {
                const r = h === 1 ? r1 : fwd(S, i, h, cal); if (typeof r !== 'number') continue;
                const b = bench(i, h), am = allMean(i, h); if (!Number.isFinite(b) || !Number.isFinite(am)) continue;
                const o = { d: cal[i], s: S.sym, t: i + 1, k: stocks.indexOf(S), ex: r - b, raw: r - b - COST, inc: r - am, nlu: nextLU, r905, r900, incGD };
                for (const tg of okTags) put(tg, h, o);
            }
        }
    }
    return out;
}

export function summarize(out) {
    const res = {}; const lim = (out.ev._lim || {})[1] || [];
    for (const [k, byH] of Object.entries(out.ev)) { if (k === '_lim') continue; res[k] = {};
        for (const [h, arr] of Object.entries(byH)) {
            const x = arr.map(o => ({ d: o.d, v: o.inc })), raw = arr.map(o => o.raw);
            const g = gates(x, raw, +1);
            const k9 = arr.filter(o => Number.isFinite(o.r905));
            const gd = arr.filter(o => Number.isFinite(o.incGD)).map(o => o.incGD);
            const gdT = gd.length > 30 ? (() => { const m = mean(gd), sd = Math.sqrt(mean(gd.map(a => (a - m) ** 2))); return { n: gd.length, inc: +m.toFixed(2), t: +(m / (sd / Math.sqrt(gd.length) || 1)).toFixed(1) }; })() : null;
            res[k][h] = { n: arr.length, ex: +mean(arr.map(o => o.ex)).toFixed(2), win: +(100 * arr.filter(o => o.raw > 0).length / arr.length).toFixed(1), nlu: +(100 * mean(arr.map(o => o.nlu))).toFixed(1), inc: g.inc, t: g.t, abs: g.abs, pass: g.pass, A: g.A, B: g.B, years: g.years,
                gd: gdT, k5: k9.length ? { n: k9.length, open: +mean(k9.map(o => o.r900)).toFixed(2), at905: +mean(k9.map(o => o.r905)).toFixed(2), win905: +(100 * k9.filter(o => o.r905 > 0).length / k9.length).toFixed(1) } : null }; } }
    res._lim = { n: lim.length, total: out.cnt.ev, pct: out.cnt.ev ? +(100 * lim.length / out.cnt.ev).toFixed(1) : NaN };
    return res;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 320, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10));
    let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const mk = (sym, mod) => { const C = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), L = new Float64Array(n), V = new Float64Array(n).fill(1000), F = new Float64Array(n).fill(1);
        let p = 100; for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.02; C[i] = p; O[i] = i ? C[i - 1] : p; H[i] = Math.max(O[i], C[i]) * 1.001; L[i] = Math.min(O[i], C[i]) * 0.999; }
        const S = { sym, C, O, H, L, V, F }; if (mod) mod(S); S.A = S.C.slice(); S.val20 = new Float64Array(n).fill(1e9); return S; };
    const lockAt = (S, i, opn) => { S.C[i] = S.C[i - 1] * 1.1; S.H[i] = S.C[i]; S.O[i + 1] = S.C[i] * (opn ?? 1.0); for (let j = i + 1; j < n; j++) { S.C[j] *= 1.1; S.H[j] *= 1.1; S.L[j] *= 1.1; if (j > i + 1) S.O[j] *= 1.1; } };
    const others = Array.from({ length: 60 }, (_, k) => mk(String(5000 + k)));
    const X = mk('1001', S => { S.V[300] = 300; lockAt(S, 300); });                 // 上市・量縮 0.3・第 1 根
    const Y = mk('6001', S => { S.V[300] = 3000; lockAt(S, 299); lockAt(S, 300); }); // 上櫃・爆量・第 2 根
    const Z = mk('1002', S => { lockAt(S, 300, 1.1); });                              // 隔天開盤就漲停 → 買不到
    const stocks = [X, Y, Z, ...others], ctx = { cal, stocks, etf: { tr: new Float64Array(n).fill(1) } };
    const mkt = { 1001: 'twse', 1002: 'twse', 6001: 'tpex' }, ind = { 1001: 'A', 6001: 'A', 1002: 'B' };
    const o = scan(ctx, { mkt, ind });
    const has = (k, s, d = cal[300]) => ((o.ev[k] || {})[1] || []).some(e => e.s === s && e.d === d);
    t(has('市場:上市', '1001') && has('市場:上櫃', '6001', cal[299]) && !has('市場:上櫃', '6001') && !has('市場:上市', '6001', cal[299]), '① 市場別讀 stock_names 第三欄,上市 / 上櫃分開(6001 第 299 天就鎖 → 市場桶只收那一天,第 300 天被同桶去重)');
    t(has('量:量縮≤0.5', '1001') && has('量:爆量>1.5', '6001') && !has('量:量縮≤0.7', '6001'), '② 量比 = 當天 ÷ 前 20 天(300/1000 = 0.3 量縮;3000 爆量)');
    const X2 = mk('1003', S => { for (let j = 280; j < 300; j++) S.V[j] = 300; S.V[300] = 300; lockAt(S, 300); });   // 前 20 天也只有 300 → 量比 1.0,⛔ 不是量縮
    const o2 = scan({ cal, stocks: [X2, ...others], etf: ctx.etf }, { mkt: { 1003: 'twse' } });
    t(!((o2.ev['量:量縮≤0.7'] || {})[1] || []).some(e => e.s === '1003') && ((o2.ev['量:普通0.6~1.5'] || {})[1] || []).some(e => e.s === '1003'), '③ 量比基準是「前」20 天 ⛔ 不含今天(含今天的話 300/300 也會變量縮)—— 這條在正確實作下量比 = 1.0');
    const X4 = mk('1007', S => { S.V[300] = 700; lockAt(S, 300); });   // 700/1000 = 0.70 剛好在門檻上;基準若含今天 → 700/985 = 0.71 就掉出去
    const o2b = scan({ cal, stocks: [X4, ...others], etf: ctx.etf }, { mkt: { 1007: 'twse' } });
    t(((o2b.ev['量:量縮≤0.7'] || {})[1] || []).some(e => e.s === '1007') && !((o2b.ev['量:量縮≤0.6'] || {})[1] || []).some(e => e.s === '1007'), '③b 量比 0.70 剛好在門檻上(基準含今天會變 0.71 → 這條會紅)');
    t(has('連續:第1根', '1001') && has('連續:第2根', '6001'), '④ 連續第幾根含今天');
    t(has('族群同日:2家', '1001') && has('族群同日:2家', '6001') && has('族群同日:1家', '1002', cal[300]) === false, '⑤ 同產業當天鎖漲停家數(A 族 2 家;1002 隔天買不到不進任何桶)');
    t(o.cnt.lim === 1 && !has('全部', '1002'), '⑥ 隔天開盤就在漲停 → 買不到,剔除並計數');
    t(has('上市×量縮≤0.6', '1001') && !has('上市×量縮≤0.6', '6001'), '⑦ 交叉桶只收上市');
    // 去重:連續三天鎖只算第一天
    const W = mk('1004', S => { lockAt(S, 300); lockAt(S, 301); lockAt(S, 302); });
    const o3 = scan({ cal, stocks: [W, ...others], etf: ctx.etf }, { mkt: { 1004: 'twse' } });
    t(((o3.ev['全部'] || {})[1] || []).filter(e => e.s === '1004').length === 1, '⑧ 同一檔 20 天內只算一次');
    // 注入 +3%:1001 隔天收盤多 3% → 增量量得到(h1)
    const X3 = mk('1005', S => { lockAt(S, 300); S.C[301] *= 1.03; S.H[301] = Math.max(S.H[301], S.C[301]); });
    const o4 = scan({ cal, stocks: [X3, ...others], etf: ctx.etf }, { mkt: { 1005: 'twse' } });
    const e4 = ((o4.ev['全部'] || {})[1] || []).find(e => e.s === '1005');
    t(e4 && e4.inc > 2.5, '⑨ 注入隔天 +3% → 增量(減同一天全部股票)量得到');
    // 鎖住時間
    const bars = [[540, 100, 100, 100, 100, 1], [545, 100, 110, 100, 110, 1], [550, 110, 110, 110, 110, 1], [555, 110, 110, 110, 110, 1]];
    t(lockMin(bars, 110) === 545 && lockMin([[540, 1, 1, 1, 1, 1], [545, 1, 110, 1, 110, 1], [550, 110, 110, 109, 109, 1], [555, 109, 110, 109, 110, 1]], 110) === 555 && lockMin(bars, 120) === 'never', '⑩ 鎖住時間 = 第一根碰到漲停且之後沒掉下來;中途掉過要重算');
    // 位階
    const P = mk('1006', S => { for (let j = 0; j < n; j++) { S.C[j] = 100 + j * 0.2; S.O[j] = S.C[j]; S.H[j] = S.C[j] + 0.1; S.L[j] = S.C[j] - 0.1; } lockAt(S, 300); });
    const o5 = scan({ cal, stocks: [P, ...others], etf: ctx.etf }, { mkt: { 1006: 'twse' } });
    t(((o5.ev['位階:≥75'] || {})[1] || []).some(e => e.s === '1006'), '⑪ 一路漲上來的在一年位階 ≥75 那桶');
    const s = summarize(o); t(s._lim.n === 1 && s['全部'] && s['全部'][1].n >= 2, '⑫ summarize 帶買不到比例與各桶六關');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('lu_split_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const { loadCtx } = await import('./leader_probe.mjs');
    const ctx = loadCtx(process.env.DATA_DIR, process.env.DIV);
    const mkt = {}; if (process.env.NAMES) { const j = JSON.parse(fs.readFileSync(process.env.NAMES, 'utf8')); for (const [s, v] of Object.entries(j.names || {})) if (Array.isArray(v) && v[2]) mkt[s] = v[2]; }
    const ind = process.env.IND_MAP ? JSON.parse(fs.readFileSync(process.env.IND_MAP, 'utf8')) : {};
    let k5 = null; if (process.env.KBAR5_DIR) { const { loadKbar5 } = await import('./dt_kbar5_probe.mjs'); const L = loadKbar5(process.env.KBAR5_DIR, { mergeSyms: true }); /* V78.6.6 kbar5_lu(漲停隔天)只補 deep 沒有的檔 → 一定要按檔合併 */ k5 = L.days; console.log(`kbar5 ${Object.keys(k5).length} 天(${L.bias || '當日量前 N / 每月初前 100'})`); }
    console.log(`${ctx.stocks.length} 檔 ・市場別 ${Object.keys(mkt).length} ・產業 ${Object.keys(ind).length}`);
    const FROM = process.env.FROM || '';
    const out = scan(ctx, { mkt, ind, k5, FROM });
    if (process.env.PORT_KEYS) {
        const s0 = ctx.cal.findIndex(d => d >= (FROM || '2011-01-03')); const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
        const endI = process.env.END ? ctx.cal.findLastIndex(d => d <= process.env.END) : ctx.cal.length - 1;
        const b50 = st => 1e6 * ctx.etf.tr[endI] / ctx.etf.tr[st];
        for (const key of process.env.PORT_KEYS.split('|')) { const ev0 = (out.ev[key] || {})[1]; if (!ev0) { console.log('⛔ 沒有這一組', key); continue; }
            const ev = ev0.filter(e => ctx.stocks[e.k].val20[e.t] >= 1e7);   // 流動性:20 日均成交額 ≥ 1,000 萬(跟安慰劑同一條)
            for (const hold of [0, 1, 5, 10]) { const R = [], Q = [], B = [];
                for (let p = 0; p < 17; p++) { const st = s0 + 3 * p; R.push(portfolio(ctx, ev, { start: st, hold, end: endI, entry: 'open' })); Q.push(portfolio(ctx, ev, { start: st, hold, end: endI, entry: 'open', sham: true, seed: 11 + p })); B.push(b50(st)); }
                const w = R.filter((r, i) => r.fin > Q[i].fin).length, wb = R.filter((r, i) => r.fin > B[i]).length;
                console.log(`💼 ${key} ${hold === 0 ? '當天收盤賣' : `抱${hold}天`} ・中位 ${(med(R.map(r => r.fin)) / 1e4).toFixed(0)} 萬(最差 ${(Math.min(...R.map(r => r.fin)) / 1e4).toFixed(0)})・筆數 ${med(R.map(r => r.trades))} 勝率 ${med(R.map(r => r.win)).toFixed(1)}% ・安慰劑中位 ${(med(Q.map(r => r.fin)) / 1e4).toFixed(0)} 萬 ・贏安慰劑 ${w}/17 ・0050 含息 ${(med(B) / 1e4).toFixed(0)} 萬 ・贏 0050 ${wb}/17`); } }
        process.exit(0);
    }
    const res = summarize(out);
    if (out.cnt.ev < 5000) { console.log('❌ 事件 <5,000,資料不對'); process.exit(1); }
    console.log(`事件 ${out.cnt.ev} ・隔天開盤就在漲停買不到 ${res._lim.n}(${res._lim.pct}%)`);
    const ORDER = ['全部', '市場:', '量:', '連續:', '位階:', '位階b:', '族群同日:', '隔天開盤:', '鎖住時間:', '上市×', '量縮≤0.6×', '開低深:', '開低×'];
    const keys = Object.keys(res).filter(k => k !== '_lim').sort((a, b) => ORDER.findIndex(p => a.startsWith(p)) - ORDER.findIndex(p => b.startsWith(p)) || a.localeCompare(b, 'zh-Hant'));
    for (const k of keys) { const r = res[k];
        const h = HS.map(x => r[x] ? `h${x} 超額${r[x].ex} 贏${r[x].win}% 增量${r[x].inc} t${r[x].t} 扣本${r[x].abs} 關${r[x].pass}` : '').join(' | ');
        const gds = r[1] && r[1].gd ? ` ・🎯 vs 同天同樣開低但沒漲停的股票 增量 ${r[1].gd.inc}%(t ${r[1].gd.t}, n ${r[1].gd.n})` : '';
        const k5s = r[1] && r[1].k5 ? ` ・⏱️ 5分K子集 n=${r[1].k5.n} 開盤價買→收盤 ${r[1].k5.open}% / 09:05 買→收盤 ${r[1].k5.at905}%(贏 ${r[1].k5.win905}%)` : '';
        console.log(`${k.padEnd(18)} n=${String((r[1] || {}).n || 0).padStart(6)} 隔天又鎖 ${(r[1] || {}).nlu}% ${h}${gds}${k5s}`); }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ from: FROM || ctx.cal[0], to: ctx.cal.at(-1), res }));
}
