#!/usr/bin/env node
/**
 * 📐 V79.9.1 量化實驗室「定案」引擎 —— 16 年全市場(d16m_fi,含已下市),每一支策略都過同一套關卡
 *   策略定義:scripts/qlab_strategies.json(積木 = lib_quant,⛔ 第二份條件);出場:lib_exitsim(chand2 = App 預設)
 *
 *   一筆交易怎麼算(⛔ 一條都不省):
 *     ① 訊號 = 第 i 根收盤後條件成立(只用 ≤ i 的資料;法人 / 融資當天晚上公布 → 最快第 i+1 根收盤買)
 *     ② 進場 = 第 i+1 根收盤;那一根收在漲停(排不到)/ 成交量 0 / 在處置期間(上市,2004 起)→ 不買,各記「被擋幾次」
 *     ③ 出場兩種:固定 10 個交易日・吊燈 ATR 2 倍(進場那天的 ATR、最長 20 天、−5% 硬停損收盤成交)
 *     ④ 報酬含股利(除權息那天用「除權息前價 ÷ 參考價」接回),碰到價格斷崖的那一筆不算
 *     ⑤ 跟「同一天所有股票」比:全市場等權指數同一段期間的報酬(⛔ 跟加權比 —— 市值加權本來就贏中位數個股)
 *     ⑥ 扣來回成本 0.44%(= playbook_scan COST)
 *   判定(主出場 = 吊燈 ATR 2 倍;固定 10 天並列):
 *     六關 ① 全期 > 0 ② 前後半同號 ③ 逐年同向 ≥ 2/3 年 ④ 拿掉最好的一年仍 > 0 ⑤ 拿掉最好的一個月仍 > 0 ⑥ 月報酬 p 值做 BH 多重比較後 q ≤ 0.05
 *     ＋ 高原(中心值左右鄰近參數同號、至少一半大)＋ 3 組安慰劑(同一檔同一年換成隨便的日子)都要贏
 *     ✅ 有用 = 全過;⛔ 賠錢 = 「扣成本前」就比同一天的股票差,而且鏡像六關全過;其他 = ➖ 沒用
 *   跑法:DATA_DIR=$S/d16m_fi REV_DIR=$S/v991/stock_deep/rev DISPO=$S/dispo_D_twse.txt node scripts/quant_lab_build.mjs out.json
 *         ONLY=kd_gold(只跑一支)・node scripts/quant_lab_build.mjs --selftest
 *   🔁 V79.9.1 PAIRS=1(使用者 10/26:「全部不同的都交叉跑一次」):8 支兩兩「兩個條件同一天都成立」= 28 組,
 *         第一支的參數照樣左右挪(高原照判)、第二支用中心值;跟單獨的 8 支**一起**做多重比較校正(試越多、門檻越嚴)
 *         → 輸出多一個 pairs(瘦身版,⛔ 進 fam,畫面另一張表)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';
import QCORE from './lib_quant.mjs';
import { simExits } from './lib_exitsim.mjs';
import { upLimitClose } from './lib_limit.mjs';
import { bhQ } from './lib_fdr.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COST = 0.44, H_FIX = 10, MAXD = 20, HOLD_STOP = 5, SHAMS = 3;
const iso = x => String(x || '').replace(/\//g, '-').slice(0, 10);

/** 策略家族 → 每一組參數展開成可跑的策略($T / $NT = −T 代進去) */
export function expand(fam) {
    const key = Object.keys(fam.grid)[0], vals = fam.grid[key];
    const sub = (o, v) => JSON.parse(JSON.stringify(o), (k, x) => x === '$' + key ? v : x === '$N' + key ? -v : x);
    return vals.map(v => ({ fam: fam.id, p: v, center: v === fam.center[key], st: sub(fam.st, v) }));
}
/** 🔁 兩兩一起成立:A 的每一組參數 × B 的中心值;條件接在一起(all 合併、any 只准一邊有)、間隔取大的 */
export function pairVars(A, B) {
    const bc = expand(B).find(x => x.center), id = `${A.id}+${B.id}`;
    return expand(A).map(v => ({ fam: id, p: v.p, center: v.center, pair: [A.id, B.id],
        st: { all: [...(v.st.all || []), ...(bc.st.all || [])], ...((v.st.any || bc.st.any) ? { any: [...(v.st.any || []), ...(bc.st.any || [])] } : {}), gap: Math.max(v.st.gap || 10, bc.st.gap || 10) } }));
}
/** 一檔的每日報酬係數(含股利;斷崖 → null)*/
export function dailyFactors(bars, divs) {
    const n = bars.length, g = new Array(n).fill(null), ex = new Map();
    for (const [d, , , before, after] of divs || []) { const r = +before / +after; if (r > 1.0005 && r < 1.6) ex.set(iso(d), r); }
    for (let j = 1; j < n; j++) {
        const c0 = +bars[j - 1].close, c1 = +bars[j].close;
        if (!(c0 > 0 && c1 > 0)) continue;
        const raw = c1 / c0; if (!(raw >= 0.67 && raw <= 1.5)) continue;
        g[j] = raw * (ex.get(iso(bars[j].date)) || 1);
    }
    return g;
}
/** 第 a 根收盤 → 第 b 根收盤的含息報酬(%);中間有 null → null */
export function retBetween(g, a, b) { let f = 1; for (let j = a + 1; j <= b; j++) { if (g[j] == null) return null; f *= g[j]; } return (f - 1) * 100; }

/** 一組事件的統計 + 六關(dir = +1 看有沒有用、−1 看是不是賠錢) */
export function judge(ev, dir = 1) {
    const n = ev.length; if (!n) return { n: 0 };
    const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    const xs = ev.map(e => e.x), m = mean(xs);
    const byM = new Map(), byY = new Map();
    for (const e of ev) { (byM.get(e.ym) || byM.set(e.ym, []).get(e.ym)).push(e.x); (byY.get(e.y) || byY.set(e.y, []).get(e.y)).push(e.x); }
    const mm = [...byM.values()].map(mean), M = mm.length, mmu = mean(mm);
    const sd = M > 1 ? Math.sqrt(mm.reduce((s, x) => s + (x - mmu) ** 2, 0) / (M - 1)) : 0;
    const t = sd > 0 ? mmu / (sd / Math.sqrt(M)) : 0;
    const p = Math.min(1, 2 * (1 - normCdf(Math.abs(t))));
    const sorted = [...ev].sort((a, b) => a.d < b.d ? -1 : 1), half = Math.floor(n / 2);
    const h1 = mean(sorted.slice(0, half).map(e => e.x)), h2 = mean(sorted.slice(half).map(e => e.x));
    const yrs = [...byY.entries()].filter(([, a]) => a.length >= 20).map(([y, a]) => [y, mean(a), a.length]).sort((a, b) => a[0] < b[0] ? -1 : 1);
    const yPos = yrs.filter(([, v]) => v * dir > 0).length;
    const contrib = (map) => { let best = null, bs = -Infinity; for (const [k, a] of map) { const s = a.reduce((q, x) => q + x, 0) * dir; if (s > bs) { bs = s; best = k; } } return best; };
    const by = contrib(byY), bm = contrib(byM);
    const dropY = mean(ev.filter(e => e.y !== by).map(e => e.x)), dropM = mean(ev.filter(e => e.ym !== bm).map(e => e.x));
    const win = ev.filter(e => e.x > 0).length / n * 100;
    return { n, x: +m.toFixed(3), win: +win.toFixed(1), months: M, t: +t.toFixed(2), p: +p.toPrecision(3), h1: +h1.toFixed(3), h2: +h2.toFixed(3),
             yrs: yrs.map(([y, v, k]) => [y, +v.toFixed(2), k]), yPos, yN: yrs.length, dropY: +dropY.toFixed(3), dropM: +dropM.toFixed(3), bestY: by, bestM: bm };
}
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const pr = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - pr : pr; }
/** 六關(q 由呼叫端 BH 後帶進來)*/
export function gates(J, q, dir = 1) {
    if (!J.n) return [false, false, false, false, false, false];
    return [J.x * dir > 0, J.h1 * dir > 0 && J.h2 * dir > 0, J.yN >= 3 && J.yPos >= Math.ceil(J.yN * 2 / 3), J.dropY * dir > 0, J.dropM * dir > 0, q <= 0.05];
}
/** 高原:中心值的鄰居(grid 左右各一格)都同號、而且至少中心的一半 */
export function plateau(gridRows, key = 'x') {
    const ci = gridRows.findIndex(r => r.center); if (ci < 0) return false;
    const c = gridRows[ci][key]; if (!Number.isFinite(c) || c === 0) return false;
    const nb = [gridRows[ci - 1], gridRows[ci + 1]].filter(Boolean);
    return nb.length > 0 && nb.every(r => Number.isFinite(r[key]) && r[key] * Math.sign(c) >= Math.abs(c) / 2);
}
/** 固定種子亂數(mulberry32) */
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

/** 一檔:訊號 i → 進場 e = i+1 → 兩種出場的「比同一天股票多幾 %(扣成本)」;回傳 { ev:{h10,chand2}, blk } */
export function tradesOf(sigIdx, bars, g, EW, dispoOf, sym) {
    const n = bars.length, R = bars.map(r => ({ o: +r.open, h: +r.high, l: +r.low, c: +r.close }));
    const out = { h10: [], chand2: [] }, blk = { lock: 0, zero: 0, dispo: 0, cliff: 0, tail: 0 };
    for (const i of sigIdx) {
        const e = i + 1; if (e >= n) { blk.tail++; continue; }
        const d = iso(bars[e].date);
        if (!(+bars[e].volume > 0)) { blk.zero++; continue; }
        if (upLimitClose(d, +bars[e].close, +bars[e - 1].close)) { blk.lock++; continue; }
        if (dispoOf && dispoOf(sym, d)) { blk.dispo++; continue; }
        const y = d.slice(0, 4), ym = d.slice(0, 7);
        const bench = (a, b) => { const la = EW.get(iso(bars[a].date)), lb = EW.get(iso(bars[b].date)); return la > 0 && lb > 0 ? (lb / la - 1) * 100 : null; };
        // 固定 10 天
        if (e + H_FIX < n) {
            const r = retBetween(g, e, e + H_FIX), b = bench(e, e + H_FIX);
            if (r == null || b == null) blk.cliff++; else out.h10.push({ d, y, ym, x: r - b - COST, gx: r - b });
        } else blk.tail++;
        // 吊燈 ATR 2 倍(進場那天的 ATR)・最長 20 天・−5% 硬停損(收盤成交)
        if (e + 1 < n) {
            const s = simExits(R, e, { rules: ['chand2'], maxD: MAXD, holdStop: HOLD_STOP, stopFill: 'close' });
            if (s && s.chand2) { const o = s.chand2.outIdx, r = retBetween(g, e, o), b = bench(e, o); if (r != null && b != null) out.chand2.push({ d, y, ym, x: r - b - COST, gx: r - b, k: o - e }); }
        }
    }
    return { ev: out, blk };
}
/** 安慰劑:同一檔、同一年、同樣次數,換成隨便的日子(固定種子) */
export function shamIdx(sigIdx, bars, seed) {
    const R = rng(seed), byY = new Map();
    for (let i = 1; i < bars.length - 1; i++) { const y = iso(bars[i].date).slice(0, 4); (byY.get(y) || byY.set(y, []).get(y)).push(i); }
    return sigIdx.map(i => { const pool = byY.get(iso(bars[i].date).slice(0, 4)) || []; return pool.length ? pool[Math.floor(R() * pool.length)] : i; }).sort((a, b) => a - b);
}
export function loadRev(dir, sym) {
    try {
        const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, sym + '.json.gz'))).toString());
        const c = j.c || [], ir = c.indexOf('revenue'), im = c.indexOf('revenue_month'), iy = c.indexOf('revenue_year');
        const m = new Map(); for (const r of j.v || []) { const y = +r[iy], mo = +r[im], v = +r[ir]; if (y > 1990 && mo >= 1 && mo <= 12 && v > 0) m.set(`${y}-${String(mo).padStart(2, '0')}`, v); }
        return [...m.entries()].map(([ym, v]) => ({ ym, v }));
    } catch (_) { return null; }
}
export function loadDispo(file) {
    if (!file || !fs.existsSync(file)) return null;
    const M = new Map();
    for (const ln of fs.readFileSync(file, 'utf8').split('\n')) { const a = ln.split('|'); if (a[0] !== 'D' || !a[3] || !a[4]) continue; (M.get(a[1]) || M.set(a[1], []).get(a[1])).push([a[3], a[4]]); }
    return (sym, d) => (M.get(sym) || []).some(([s, e]) => d >= s && d <= e);
}

async function main() {
    const DIR = process.env.DATA_DIR, REV = process.env.REV_DIR || '', ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
    if (!DIR) { console.error('❌ 要 DATA_DIR'); process.exit(1); }
    const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8'));
    const fams = S.families.filter(f => !ONLY.length || ONLY.includes(f.id));
    const PAIRS = process.env.PAIRS === '1';
    const pairFams = PAIRS ? fams.flatMap((A, i) => fams.slice(i + 1).filter(B => !((A.st.any || []).length && (B.st.any || []).length)).map(B => ({ id: `${A.id}+${B.id}`, name: `${A.name} + ${B.name}`, A, B }))) : [];
    const vars = [...fams.flatMap(expand), ...pairFams.flatMap(P => pairVars(P.A, P.B))];
    if (PAIRS) console.log(`  🔁 兩兩一起成立 ${pairFams.length} 組 → 一共 ${vars.length} 種設定一起做多重比較校正`);
    for (const v of vars) QCORE.check(v.st);   // ⛔ 打錯字當場停
    const load = s => { try { const j = JSON.parse(fs.readFileSync(path.join(DIR, s + '.json'), 'utf8')); return Array.isArray(j) ? j.filter(r => r && r.date && +r.close > 0) : null; } catch (_) { return null; } };
    const DIV = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(DIR, '_div16.json'), 'utf8')); return j.d || j; } catch (_) { return {}; } })();
    const dispoOf = loadDispo(process.env.DISPO);
    const tw = load('^TWII'); if (!tw || tw.length < 1000) { console.error('❌ ^TWII 讀不到'); process.exit(1); }
    const idx = new Map(tw.map(r => [iso(r.date), +r.close]));
    const files = fs.readdirSync(DIR).filter(f => /^[1-9]\d{3}\.json$/.test(f)).map(f => f.slice(0, -5));
    // ── 第一趟:全市場等權指數(含息)
    const sum = new Map(), cnt = new Map(); let t0 = Date.now();
    for (const s of files) {
        const b = load(s); if (!b || b.length < 60) continue;
        const g = dailyFactors(b, (DIV[s] || {}).h);
        for (let j = 1; j < b.length; j++) if (g[j] != null) { const d = iso(b[j].date); sum.set(d, (sum.get(d) || 0) + g[j] - 1); cnt.set(d, (cnt.get(d) || 0) + 1); }
    }
    const EW = new Map(); let L = 1;
    for (const d of [...sum.keys()].sort()) { if (cnt.get(d) >= 100) L *= 1 + sum.get(d) / cnt.get(d); EW.set(d, L); }
    console.log(`  等權指數 ${EW.size} 天(${Math.round((Date.now() - t0) / 1000)}s)`);
    // ── 第二趟:每一檔 × 每一組參數
    const acc = new Map(vars.map((v, k) => [k, { h10: [], chand2: [], blk: { lock: 0, zero: 0, dispo: 0, cliff: 0, tail: 0 }, sig: 0, sham: Array.from({ length: SHAMS }, () => []) }]));
    let nSym = 0, revN = 0, first = '9999', last = '0000';
    for (const [k0, s] of files.entries()) {
        const b = load(s); if (!b || b.length < 120) continue;
        nSym++; if (iso(b[0].date) < first) first = iso(b[0].date); if (iso(b[b.length - 1].date) > last) last = iso(b[b.length - 1].date);
        const rev = REV ? loadRev(REV, s) : null; if (rev && rev.length) revN++;
        const ser = QCORE.series(b, { idx, rev: rev || [] }), g = dailyFactors(b, (DIV[s] || {}).h);
        for (const [k, v] of vars.entries()) {
            const sig = QCORE.signals(v.st, b, null, ser); if (!sig.length) continue;
            const A = acc.get(k); A.sig += sig.length;
            const T = tradesOf(sig, b, g, EW, dispoOf, s);
            A.h10.push(...T.ev.h10); A.chand2.push(...T.ev.chand2); for (const x in T.blk) A.blk[x] += T.blk[x];
            if (v.center) for (let z = 0; z < SHAMS; z++) { const T2 = tradesOf(shamIdx(sig, b, hash(s) ^ (z + 1) * 7919), b, g, EW, dispoOf, s); A.sham[z].push(...T2.ev.chand2); }
        }
        if (k0 % 300 === 0) console.log(`  ${k0}/${files.length} ${s} ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    // ── 判定
    // 🎲 「隨便挑一天」的基準(同一檔、同一年、同樣次數 × 3 組):扣成本前每年平均 → 每一筆減掉那一年的基準 = 比亂買多 / 少
    const shamYearOf = fam => { const C = vars.findIndex(v => v.fam === fam && v.center); const all = acc.get(C).sham.flat(), m = new Map();
        for (const e of all) { const a = m.get(e.y) || m.set(e.y, [0, 0]).get(e.y); a[0] += e.gx; a[1]++; }
        const out = new Map(); for (const [y, [s2, k2]] of m) if (k2 >= 20) out.set(y, s2 / k2); return { out, all: all.length ? all.reduce((q2, e) => q2 + e.gx, 0) / all.length : null }; };
    const SY = new Map([...fams, ...pairFams].map(f => [f.id, shamYearOf(f.id)]));
    const rows = vars.map((v, k) => { const A = acc.get(k), sy = SY.get(v.fam).out;
        const adj = A.chand2.filter(e => sy.has(e.y)).map(e => ({ ...e, x: e.gx - sy.get(e.y) }));
        return { v, A, Jc: judge(A.chand2, 1), Jh: judge(A.h10, 1), Ja: judge(adj, -1) }; });
    const qs = bhQ(rows.map(r => r.Jc.p)), qsNeg = bhQ(rows.map(r => r.Ja.p));
    rows.forEach((r, k) => { r.q = qs[k]; r.qNeg = qsNeg[k]; });
    const out = { built: new Date().toISOString().slice(0, 10), src: 'scripts/quant_lab_build.mjs(d16m_fi,含已下市)', syms: nSym, win: [first, last], revSyms: revN,
                  dispo: !!dispoOf, cost: COST, exits: { h10: `固定 ${H_FIX} 天`, chand2: `吊燈 ATR 2 倍・最長 ${MAXD} 天・−${HOLD_STOP}% 硬停損` }, tests: vars.length, fam: [] };
    for (const f of fams) {
        const R = rows.filter(r => r.v.fam === f.id), C = R.find(r => r.v.center);
        const grid = R.map(r => ({ p: r.v.p, center: r.v.center, n: r.Jc.n, x: r.Jc.x, x10: r.Jh.x, adj: r.Ja.x, q: +r.q.toPrecision(3) }));
        const g6 = gates(C.Jc, C.q, 1), g6n = gates(C.Ja, C.qNeg, -1);
        const sh = C.A.sham.map(a => judge(a, 1)), shamBeat = sh.every(j => j.n && C.Jc.x > j.x), shamWorse = sh.every(j => j.n && C.Jc.x < j.x);
        const plat = plateau(grid, 'x'), platN = plateau(grid, 'adj');
        // ✅ 扣成本後比同一天的股票賺、六關 + 高原 + 贏 3 組亂買;⛔ 扣成本前就比「同一年隨便挑一天買」差、鏡像六關 + 高原 + 輸 3 組亂買
        const verdict = g6.every(Boolean) && plat && shamBeat ? 'ok' : (C.Ja.x < 0 && g6n.every(Boolean) && platN && shamWorse ? 'bad' : 'none');
        out.fam.push({ id: f.id, name: f.name, pl: f.pl || '', why: f.why, desc: QCORE.describe(C.v.st), key: Object.keys(f.grid)[0], center: C.v.p, verdict,
                       n: C.Jc.n, sig: C.A.sig, blk: C.A.blk, c: C.Jc, h10: C.Jh, adj: C.Ja, shamGross: SY.get(f.id).all == null ? null : +SY.get(f.id).all.toFixed(3), q: +C.q.toPrecision(3), qNeg: +C.qNeg.toPrecision(3), gates: g6, gatesNeg: g6n, plateau: plat, plateauNeg: platN,
                       sham: sh.map(j => ({ n: j.n, x: j.x })), shamBeat, shamWorse, grid });
        console.log(`${verdict === 'ok' ? '✅' : verdict === 'bad' ? '⛔' : '➖'} ${f.name}:${C.Jc.n} 筆 ・吊燈 ${C.Jc.x}% ・固定 10 天 ${C.Jh.x}% ・比隨便一天 ${C.Ja.x}% ・q ${C.q.toPrecision(2)} ・六關 ${g6.filter(Boolean).length}/6 ・反向六關 ${g6n.filter(Boolean).length}/6 ・高原 ${plat}/${platN} ・安慰劑 ${sh.map(j => j.x).join(' / ')}`);
    }
    if (PAIRS) {
        out.pairs = [];
        for (const P of pairFams) {
            const R = rows.filter(r => r.v.fam === P.id), C = R.find(r => r.v.center);
            const grid = R.map(r => ({ p: r.v.p, center: r.v.center, n: r.Jc.n, x: r.Jc.x, x10: r.Jh.x, adj: r.Ja.x, q: +r.q.toPrecision(3) }));
            const g6 = gates(C.Jc, C.q, 1), g6n = gates(C.Ja, C.qNeg, -1);
            const sh = C.A.sham.map(a => judge(a, 1)), shamBeat = sh.every(j => j.n && C.Jc.x > j.x), shamWorse = sh.every(j => j.n && C.Jc.x < j.x);
            const plat = plateau(grid, 'x'), platN = plateau(grid, 'adj');
            const verdict = C.Jc.n >= 200 && g6.every(Boolean) && plat && shamBeat ? 'ok' : (C.Jc.n >= 200 && C.Ja.x < 0 && g6n.every(Boolean) && platN && shamWorse ? 'bad' : 'none');
            const singles = P.pair = [P.A.id, P.B.id];
            // ⭐ 比單獨那兩支好嗎?(同一把尺:吊燈出場、扣成本後比同一天股票)
            const sx = id => { const f = out.fam.find(x => x.id === id); return f ? f.c.x : null; };
            out.pairs.push({ id: P.id, name: P.name, pair: singles, verdict, n: C.Jc.n, x: C.Jc.x, x10: C.Jh.x, adj: C.Ja.x, win: C.Jc.win, yPos: C.Jc.yPos, yN: C.Jc.yN, h1: C.Jc.h1, h2: C.Jc.h2,
                             q: +C.q.toPrecision(3), plateau: plat, shamBeat, shamWorse, g6: g6.filter(Boolean).length, better: [sx(P.A.id), sx(P.B.id)].every(v => v != null && C.Jc.x > v) });
            console.log(`${verdict === 'ok' ? '✅' : verdict === 'bad' ? '⛔' : '➖'} 🔁 ${P.name}:${C.Jc.n} 筆 ・吊燈 ${C.Jc.x}% ・比隨便一天 ${C.Ja.x}% ・q ${C.q.toPrecision(2)} ・六關 ${g6.filter(Boolean).length}/6 ・高原 ${plat ? '✅' : '⛔'} ・安慰劑 ${shamBeat ? '贏' : shamWorse ? '輸' : '混'}`);
        }
    }
    const fo = process.argv[2]; if (fo) fs.writeFileSync(fo, JSON.stringify(out, null, 1));
}

function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8'));
    // ① 每一支都展開得出來、而且 lib_quant 認得
    let bad = []; for (const f of S.families) { const v = expand(f); if (v.filter(x => x.center).length !== 1) bad.push(f.id + ' 中心值'); for (const x of v) { try { QCORE.check(x.st); } catch (e) { bad.push(f.id + ':' + e.message); } if (JSON.stringify(x.st).includes('$')) bad.push(f.id + ' 沒代換'); } }
    ok('① 8 支策略都展開得出來、每支剛好一個中心值、$T 都代換掉', S.families.length >= 8 && !bad.length, bad.join(','));
    const neg = expand(S.families.find(f => f.id === 'bias_low')).find(x => x.center);
    ok('① $NT = 負的 T(乖離 < −10)', neg.st.all[0].b === -10, JSON.stringify(neg.st.all[0]));
    // ② 合成:10 檔,同一天所有股票都漲 1% → 超額 = 0 − 成本
    const days = n => { const D = []; let t = Date.UTC(2015, 6, 1); while (D.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; } return D; };
    const D = days(300), mk = f => { let c = 50; return D.map((d, i) => { const p = c; c = +(p * f(i)).toFixed(4); return { date: d, open: p, high: Math.max(p, c), low: Math.min(p, c), close: c, volume: 1e6 }; }); };
    const b = mk(() => 1.01), g = dailyFactors(b, []);
    const EW = new Map(); let L = 1; for (const [j, r] of b.entries()) { if (j) L *= 1.01; EW.set(r.date, L); }
    const T = tradesOf([50, 120], b, g, EW, null, '9999');
    ok('② 大家都一樣漲 → 比同一天股票多 0、扣成本 = −0.44', T.ev.h10.length === 2 && T.ev.h10.every(e => Math.abs(e.x + COST) < 1e-3 && Math.abs(e.gx) < 1e-3), JSON.stringify(T.ev.h10[0]));
    // ③ 股利接回:除息那天跌 5%(參考價)→ 含息報酬 = 0
    const bd = mk(i => i === 60 ? 0.95 : 1), gd = dailyFactors(bd, [[bd[60].date, 2.5, '息', 50, 47.5]]);
    ok('③ 除息那天跌的那段用參考價接回 → 含息報酬 0', Math.abs(retBetween(gd, 55, 65)) < 1e-9 && Math.abs(retBetween(dailyFactors(bd, []), 55, 65) + 5) < 1e-6);
    // ④ 斷崖 → 那一筆不算
    const bc = mk(i => i === 70 ? 0.3 : 1), gc = dailyFactors(bc, []);
    ok('④ 價格斷崖(×0.3)那一段 → null', retBetween(gc, 65, 75) === null && retBetween(gc, 71, 80) === 0);
    // ⑤ 進場那天收在漲停 / 量 0 / 處置 → 擋下來並記數
    const bl = mk(i => i === 101 ? 1.1 : 1); bl[201].volume = 0;
    const T5 = tradesOf([100, 200, 150], bl, dailyFactors(bl, []), EW, (s, d) => d === bl[151].date, '9999');
    ok('⑤ 收在漲停 / 量 0 / 處置各擋一次', T5.blk.lock === 1 && T5.blk.zero === 1 && T5.blk.dispo === 1 && !T5.ev.h10.length, JSON.stringify(T5.blk));
    // ⑥ 六關 + 高原 + 安慰劑
    const ev = []; for (let y = 2011; y <= 2026; y++) for (let m = 1; m <= 12; m++) for (let k = 0; k < 5; k++) ev.push({ d: `${y}-${String(m).padStart(2, '0')}-1${k}`, y: String(y), ym: `${y}-${String(m).padStart(2, '0')}`, x: 1 + Math.sin(y * 13 + m * 7 + k) });
    const J = judge(ev); const q = bhQ([J.p])[0];
    ok('⑥ 一直賺 1% 左右 → 六關全過', gates(J, q).every(Boolean), JSON.stringify(gates(J, q)));
    const evN = ev.map((e, k) => ({ ...e, x: (k % 2 ? 0.5 : -0.5) + (e.y === '2020' ? 30 : 0) }));
    const JN = judge(evN), gN = gates(JN, bhQ([JN.p])[0]);
    ok('⑥ 決定性對照:平常是 0、只有 2020 年大賺 → 「拿掉最好的一年」那關擋下', !gN[3] && !gN.every(Boolean), JSON.stringify(gN));
    ok('⑥ 高原:鄰居同號且 ≥ 一半 → 過;鄰居翻負 → 不過', plateau([{ x: 0.8 }, { x: 1, center: true }, { x: 0.6 }]) && !plateau([{ x: -0.2 }, { x: 1, center: true }, { x: 0.9 }]));
    const si = shamIdx([50, 120, 250], b, 7), si2 = shamIdx([50, 120, 250], b, 7);
    ok('⑥ 安慰劑:固定種子同一份、同一年、次數一樣', JSON.stringify(si) === JSON.stringify(si2) && si.length === 3 && si.every((i, k) => b[i].date.slice(0, 4) === b[[50, 120, 250][k]].date.slice(0, 4)));
    // ⑦ 🔁 兩兩一起成立:條件 = 兩支接在一起、A 的每組參數都有、B 固定中心值;決定性對照:兩個都成立的訊號 ⊆ 單獨任一支
    const fa = S.families.find(f => f.id === 'gap_up'), fb = S.families.find(f => f.id === 'kd_gold');
    const pv = pairVars(fa, fb), cA = expand(fa).find(x => x.center), cB = expand(fb).find(x => x.center), pc = pv.find(x => x.center);
    ok('⑦ 兩兩:A 的參數全部都有、B 用中心值、條件接在一起', pv.length === expand(fa).length && JSON.stringify(pc.st.all) === JSON.stringify([...cA.st.all, ...cB.st.all]) && pc.fam === 'gap_up+kd_gold', JSON.stringify(pc.st));
    const bb = mk(i => 1 + Math.sin(i / 3) * 0.03), serB = QCORE.series(bb, { idx: new Map(), rev: [] });
    const sP = QCORE.signals(pc.st, bb, null, serB), sA = QCORE.signals(cA.st, bb, null, serB), sB = QCORE.signals(cB.st, bb, null, serB);
    const allA = new Set(QCORE.signals({ ...cA.st, gap: 1 }, bb, null, serB)), allB = new Set(QCORE.signals({ ...cB.st, gap: 1 }, bb, null, serB));
    ok('⑦ 決定性對照:兩個都成立的那幾天 ⊆ 單獨每一支成立的日子', sP.every(i => allA.has(i) && allB.has(i)) && sP.length <= Math.min(sA.length, sB.length) + 1, JSON.stringify([sP.length, sA.length, sB.length]));
    console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.includes('--selftest')) selftest(); else main();
}
