#!/usr/bin/env node
/**
 * 🟥🔓 lu_touch_probe.mjs —— 「盤中摸到漲停,鎖住 / 打開 / 又鎖又打開」之後怎麼走?(V79.2.2)
 *
 * 使用者(2026-10-14,南亞 1303 截圖):「開盤平盤,盤中漲停又打開又漲停又打開這個是什麼訊息」。
 * 以前只測過**收盤鎖漲停**的(lu_split_probe / limitup_next_probe / dt_daily_probe);
 * 「碰過漲停但收盤沒鎖」的一筆都沒進去過 → 這一支只補這一塊。
 *
 * 資料:5 分 K = `KBAR5_DIR=<kbar5_deep>:<kbar5>`(每月初成交值前 100 / 每日量前 80,2021-05 起;loader 走 dt_kbar5_probe.loadKbar5)
 *       日 K = `DATA_DIR`(只拿來算之後幾天的報酬;⭐ 當天 5 分 K 收盤跟日 K 收盤差 >1% → 尺標不同,剔除並計數,陷阱 #46)
 * 漲停價:昨收(⭐ 用**昨天的 5 分 K 最後一根**,⛔ 不讀日 K)×1.1 往下對跳動單位;2015-06 前不在窗口內
 * 分類(只看 09:00~13:30 的 5 分 K;一根「收盤 ≥ 漲停價」= 那 5 分鐘鎖著):
 *   A 一鎖到底(第一次鎖住後每一根都鎖著,收盤鎖)・B 打開過又鎖回收盤 ・C 打開 1 次、收盤沒鎖
 *   D 打開 ≥2 次、收盤沒鎖(⭐ 南亞型)・E 只碰到漲停價、沒有一根收在漲停
 *   ⚠️ 5 分 K 看不到 5 分鐘內的開開鎖鎖 → 「打開次數」是**下限**
 * 另外切(各自一張表,⛔ 不疊起來挑):收盤離漲停 ≤1 / 1~3 / >3% ・第一次碰漲停 10:00 前/後 ・收盤在當天均價線上/下
 * 進場兩種:
 *   ① 當天收盤買(收盤鎖死 = 買不到 → 剔除並計數)→ 隔天開盤賣 / 隔天・5・10 天收盤賣;0050 收→收
 *   ② 隔天開盤買(開盤鎖漲停 = 買不到)→ 當天・5・10 天收盤賣;0050 開→收(V78.6.8)
 *   扣成本 0.44%(abs 欄);增量 = 事件 − 同一天對照組平均(同一個進場口徑)
 * 對照:⭐ ① 同一天、同一份熱門名單裡「收盤漲 6% 以上但整天沒碰到漲停」的 ② 同一天名單裡全部(4 碼個股)
 * 去重:同一檔同一桶 20 個交易日一次 ・六關 = maxim_kbar5_probe.gates
 *
 * 第二段 `--bigflow`:tick_hist.json(逐筆大單 ≥50 張的買 / 賣,每天約 80 檔)→ 大單淨買五分位 vs 隔天開盤買抱 1/5 天;
 *   天數 <120 → 只印方向、⛔ 不給結論(只有幾十天)
 *
 * 跑法:KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5 DATA_DIR=$S/dd2 node --max-old-space-size=10000 scripts/lu_touch_probe.mjs out.json
 *       TICK_HIST=$S/th.json DATA_DIR=$S/dd2 node scripts/lu_touch_probe.mjs --bigflow
 *       node scripts/lu_touch_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadKbar5 } from './dt_kbar5_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';

const COST = 0.44, DEDUP = 20, CTRL_MIN = 6;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
export const tickOf = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
/** 漲停價:前收 ×1.1 往下對到跳動單位(跳動單位看漲停價那一檔) */
export function luPx(pc) { const raw = pc * 1.1, t = tickOf(raw); return Math.floor(raw / t + 1e-6) * t; }

/** 一天的 5 分 K → 分類。bars = [[分鐘, o, h, l, c, v], …];pc = 昨收。沒碰到漲停回 null */
export function classify(bars, pc) {
    const B = bars.filter(b => b[0] >= 540 && b[0] <= 810);
    if (B.length < 40 || !(pc > 0)) return null;
    const lu = luPx(pc), eps = 1e-6;
    const ft = B.findIndex(b => b[2] >= lu - eps);
    if (ft < 0) return null;
    let opens = 0, locked = false, everLock = false, pv = 0, vv = 0;
    for (const b of B) { const on = b[4] >= lu - eps;
        if (on) { locked = true; everLock = true; } else if (locked) { opens++; locked = false; }
        pv += (b[2] + b[3] + b[4]) / 3 * b[5]; vv += b[5]; }
    const close = B[B.length - 1][4], closeLock = close >= lu - eps;
    const cls = !everLock ? 'E' : closeLock ? (opens === 0 ? 'A' : 'B') : (opens === 1 ? 'C' : 'D');
    const vwap = vv > 0 ? pv / vv : NaN;
    return { cls, lu, close, opens, closeLock, firstMin: B[ft][0], dist: (lu - close) / lu * 100,
        aboveVwap: Number.isFinite(vwap) ? close >= vwap : null };
}
export const BUCKETS = {
    A: 'A 一鎖到底', B: 'B 打開過又鎖回收盤', C: 'C 打開 1 次、收盤沒鎖', D: 'D 打開 ≥2 次、收盤沒鎖(南亞型)', E: 'E 只碰到、沒鎖過',
};

/** 日 K 讀成 {date → idx, O, C} */
function loadDaily(dir, sym) {
    const f = path.join(dir, sym + '.json'); if (!fs.existsSync(f)) return null;
    let r = JSON.parse(fs.readFileSync(f, 'utf8')); if (!Array.isArray(r)) r = r.data || [];
    const D = { idx: new Map(), d: [], O: [], C: [] };
    for (const x of r) { const d = String(x.date).replace(/\//g, '-'); if (!(x.close > 0)) continue;
        D.idx.set(d, D.d.length); D.d.push(d); D.O.push(+x.open || 0); D.C.push(+x.close); }
    return D;
}

/** 報酬:entry 'c'(當天收盤買)/'o'(隔天開盤買);h = 'o1' | 0 | 1 | 5 | 10;回 % 或 'lim' / null */
export function fwd(D, i, entry, h) {
    const C = D.C, O = D.O;
    if (entry === 'c') {
        if (h === 'o1') return O[i + 1] > 0 ? (O[i + 1] / C[i] - 1) * 100 : null;
        return C[i + h] > 0 ? (C[i + h] / C[i] - 1) * 100 : null;
    }
    if (!(O[i + 1] > 0)) return null;
    if (O[i + 1] >= luPx(C[i]) - 1e-6) return 'lim';
    const k = i + Math.max(1, h); return C[k] > 0 ? (C[k] / O[i + 1] - 1) * 100 : null;
}
export const PLANS = [['c', 'o1', '收盤買→隔天開盤賣'], ['c', 1, '收盤買→隔天收盤'], ['c', 5, '收盤買→抱 5 天'], ['c', 10, '收盤買→抱 10 天'],
    ['o', 0, '隔天開盤買→當天收盤'], ['o', 5, '隔天開盤買→抱 5 天'], ['o', 10, '隔天開盤買→抱 10 天']];

/** days = loadKbar5().days;daily(sym) → loadDaily 結果;bench = 0050 的 loadDaily */
export function scan(days, daily, bench) {
    const dates = Object.keys(days).sort();
    const prev = {}, cnt = { touch: 0, noPrev: 0, scale: 0, noDaily: 0, lim: 0, closeLocked: 0 };
    const ev = [], ctrl = {};      // ctrl[date] = {c6:[sym], all:[sym]}
    for (let di = 0; di < dates.length; di++) {
        const d = dates[di], K = days[d].k || {}, yday = dates[di - 1];
        const cc = (ctrl[d] = { c6: [], all: [] });
        for (const [sym, raw] of Object.entries(K)) {
            if (!/^[1-9]\d{3}$/.test(sym)) continue;
            const pv = prev[sym]; const B = raw.filter(b => b[0] >= 540 && b[0] <= 810);
            prev[sym] = { d, c: B.length ? B[B.length - 1][4] : NaN };
            if (!pv || pv.d !== yday || !(pv.c > 0) || B.length < 40) { cnt.noPrev++; continue; }
            const D = daily(sym), i = D ? D.idx.get(d) : undefined;
            if (i == null) { cnt.noDaily++; continue; }
            const c5 = B[B.length - 1][4];
            if (Math.abs(D.C[i] / c5 - 1) > 0.01) { cnt.scale++; continue; }   // 尺標不同 → 不算(陷阱 #46)
            cc.all.push(sym);
            const r = classify(raw, pv.c);
            if (!r) { if (c5 >= pv.c * (1 + CTRL_MIN / 100)) cc.c6.push(sym); continue; }
            cnt.touch++;
            ev.push({ d, sym, i, ...r });
        }
    }
    return { ev, ctrl, cnt, dates };
}

/** 把事件依 key 函式分桶,每桶 × 每個 plan 算增量(vs 對照組)與六關 */
export function evaluate(S, daily, bench, keyOf, ctrlKey = 'c6') {
    const out = {}, last = new Map(), memo = new Map();
    const benchR = (d, entry, h) => { const j = bench.idx.get(d); if (j == null) return NaN; const r = fwd(bench, j, entry, h); return typeof r === 'number' ? r : NaN; };
    const ctrlMean = (d, entry, h) => { const key = d + entry + h + ctrlKey; if (memo.has(key)) return memo.get(key); const a = [];
        for (const sym of S.ctrl[d][ctrlKey]) { const D = daily(sym), i = D.idx.get(d), r = fwd(D, i, entry, h); if (typeof r === 'number') a.push(r); }
        const v = a.length >= 3 ? mean(a) : NaN; memo.set(key, v); return v; };
    for (const e of S.ev) {
        const k = keyOf(e); if (!k) continue;
        const lk = e.sym + '|' + k, lp = last.get(lk); if (lp != null && e.i - lp < DEDUP) continue; last.set(lk, e.i);
        const D = daily(e.sym);
        for (const [entry, h, label] of PLANS) {
            const o = ((out[k] = out[k] || {})[label] = out[k][label] || { x: [], raw: [], ret: [], lim: 0 });
            if (entry === 'c' && e.closeLock) { o.lim++; continue; }
            const r = fwd(D, e.i, entry, h);
            if (r === 'lim') { o.lim++; continue; }
            if (typeof r !== 'number') continue;
            const cm = ctrlMean(e.d, entry, h), bm = benchR(e.d, entry, h);
            o.ret.push(r);
            if (Number.isFinite(bm)) o.raw.push(r - bm - COST);
            if (Number.isFinite(cm)) o.x.push({ d: e.d, v: r - cm });
        }
    }
    const res = {};
    for (const [k, plans] of Object.entries(out)) {
        res[k] = {};
        for (const [label, o] of Object.entries(plans)) {
            const m = mean(o.x.map(z => z.v)), sign = m >= 0 ? 1 : -1;
            const g = gates(o.x, o.raw, sign);
            res[k][label] = { n: o.ret.length, lim: o.lim, ret: +mean(o.ret).toFixed(2), win: o.ret.length ? +(100 * o.ret.filter(v => v > 0).length / o.ret.length).toFixed(1) : null,
                abs: +mean(o.raw).toFixed(2), inc: g.inc, t: g.t, A: g.A, B: g.B, pass: g.pass, years: g.years, dir: sign };
        }
    }
    return res;
}

function printTable(title, res) {
    console.log(`\n=== ${title} ===(增量 = 事件 − 同一天對照組;abs = 扣 0050 與成本 0.44%;pass = 六關過幾關,dir 是增量方向)`);
    for (const [k, plans] of Object.entries(res).sort()) {
        console.log(`  【${BUCKETS[k] || k}】`);
        for (const [label, s] of Object.entries(plans))
            console.log(`    ${label.padEnd(14)} n=${String(s.n).padStart(5)} 買不到=${String(s.lim).padStart(4)} 平均 ${String(s.ret).padStart(6)}% 賺錢 ${s.win}% ・abs ${s.abs} ・增量 ${s.inc}(t ${s.t},前/後 ${s.A}/${s.B})・${s.dir > 0 ? '偏好' : '偏差'} ${s.pass}/6`);
    }
}

/** 大單淨買(tick_hist)五分位 → 隔天開盤買抱 1 / 5 天,增量 = − 同一天 tick_hist 全部平均 */
export function bigflow(TH, daily) {
    const days = Object.keys(TH.d || {}).sort(), Q = [[], [], [], [], []].map(() => ({ 1: [], 5: [] }));
    let used = 0;
    for (const d of days) {
        const rows = [];
        for (const [sym, v] of Object.entries(TH.d[d])) {
            if (!/^[1-9]\d{3}$/.test(sym) || !Array.isArray(v)) continue;
            const [o, n, bb, bs] = v, tot = o + n; if (!(tot > 0)) continue;
            const D = daily(sym), i = D ? D.idx.get(d) : undefined; if (i == null) continue;
            const r1 = fwd(D, i, 'o', 0), r5 = fwd(D, i, 'o', 5);
            rows.push({ f: (bb - bs) / tot, r1: typeof r1 === 'number' ? r1 : NaN, r5: typeof r5 === 'number' ? r5 : NaN });
        }
        if (rows.length < 20) continue;
        used++;
        rows.sort((a, b) => a.f - b.f);
        for (const h of [1, 5]) {
            const ok = rows.filter(r => Number.isFinite(r['r' + h])); if (ok.length < 20) continue;
            const m = mean(ok.map(r => r['r' + h]));
            ok.forEach((r, k) => Q[Math.min(4, Math.floor(5 * k / ok.length))][h].push(r['r' + h] - m));
        }
    }
    return { days: days.length, used, q: Q.map((q, k) => ({ q: k + 1, h1: +mean(q[1]).toFixed(3), n1: q[1].length, h5: +mean(q[5]).toFixed(3), n5: q[5].length })) };
}

function selftest() {
    let n = 0, ok = 0; const t = (c, m) => { n++; if (c) ok++; console.log((c ? '✅ ' : '❌ ') + m); };
    t(luPx(319) === 350.5 && luPx(100) === 110 && Math.abs(luPx(45.3) - 49.8) < 1e-9, '漲停價:319→350.5、100→110、45.3→49.8(跳動單位)');
    const mk = path => { const B = []; for (let k = 0; k < 54; k++) { const p = path(k); B.push([540 + 5 * k, p, p, p, p, 100]); } return B; };
    const pc = 100, L = luPx(pc);
    t(classify(mk(k => (k < 3 ? 101 : L)), pc).cls === 'A', 'A 一鎖到底');
    t(classify(mk(k => (k < 3 ? 101 : k < 10 ? L : k < 15 ? 108 : L)), pc).cls === 'B', 'B 打開又鎖回');
    t(classify(mk(k => (k < 3 ? 101 : k < 10 ? L : 107)), pc).cls === 'C', 'C 打開 1 次沒鎖');
    const d = classify(mk(k => (k < 3 ? 101 : k < 10 ? L : k < 15 ? 106 : k < 20 ? L : 108)), pc);
    t(d.cls === 'D' && d.opens === 2, 'D 打開 2 次沒鎖(南亞型)');
    const eB = mk(k => 105); eB[20][2] = L;
    t(classify(eB, pc).cls === 'E', 'E 只碰到 high、沒有一根收在漲停');
    t(classify(mk(() => 105), pc) === null, '沒碰到漲停 → null');
    // 收盤買、收盤鎖死要剔除;隔天開盤鎖漲停要剔除
    const D = { C: [100, 110, 121, 121], O: [100, 105, 121, 121] };
    t(fwd(D, 1, 'o', 0) === 'lim', '隔天開盤就鎖漲停 → 買不到');
    t(Math.abs(fwd(D, 0, 'c', 'o1') - 5) < 1e-9, '收盤買 100 → 隔天開盤 105 = +5%');
    // 端到端:注入 D 桶 +3%、對照組 0 → 增量 ≈ +3;前視注入(用隔天價判桶)不可出現在 classify 的輸入
    const days = {}, cal = [], dailyMap = {}, Bn = { idx: new Map(), d: [], O: [], C: [] };
    const syms = ['1101', '1102', '1103', '1104', '1105'];
    for (const s of syms) dailyMap[s] = { idx: new Map(), d: [], O: [], C: [] };
    let price = Object.fromEntries(syms.map(s => [s, 100]));
    for (let k = 0; k < 900; k++) {
        const dt = new Date(Date.UTC(2022, 0, 3 + k)); const ds = dt.toISOString().slice(0, 10); cal.push(ds);
        days[ds] = { k: {} };
        Bn.idx.set(ds, k); Bn.d.push(ds); Bn.O.push(50); Bn.C.push(50);
        for (const s of syms) {
            const pc = price[s];
            const isD = s === '1101' && k % 25 === 5, isC6 = s !== '1101' && k % 25 === 5;
            let bars;
            if (isD) { const l = luPx(pc); bars = mk(q => (q < 3 ? pc : q < 10 ? l : q < 15 ? l * 0.97 : q < 20 ? l : l * 0.985)); }
            else if (isC6) bars = mk(q => (q < 10 ? pc : pc * 1.07));
            else bars = mk(() => pc);
            days[ds].k[s] = bars;
            const c = bars[bars.length - 1][4];
            const D2 = dailyMap[s]; D2.idx.set(ds, k); D2.d.push(ds);
            // 隔天開盤 = 今天收盤;D 桶那一檔之後 5 天每天 +0.6%(總共約 +3%)
            D2.O.push(pc); D2.C.push(c);
            price[s] = c;
        }
        // 讓 D 桶那天之後 1101 漲
        const D1 = dailyMap['1101']; const j = D1.d.length - 1;
        if (k % 25 >= 6 && k % 25 <= 10) { D1.C[j] *= 1.006; price['1101'] = D1.C[j]; days[ds].k['1101'] = mk(() => D1.C[j]); D1.O[j] = D1.C[j - 1]; }
    }
    const S = scan(days, s => dailyMap[s], Bn);
    t(S.ev.filter(e => e.cls === 'D').length >= 10, `scan 找得到 D 桶事件(${S.ev.filter(e => e.cls === 'D').length})`);
    const R = evaluate(S, s => dailyMap[s], Bn, e => e.cls);
    const r5 = R.D && R.D['收盤買→抱 5 天'];
    t(r5 && r5.inc > 2 && r5.inc < 4.5, `注入 +3% → D 桶抱 5 天增量量得到(${r5 && r5.inc})`);
    const r0 = R.D && R.D['收盤買→隔天開盤賣'];
    t(r0 && Math.abs(r0.inc) < 0.5, `隔天開盤賣(注入還沒開始)≈0(${r0 && r0.inc})`);
    console.log(ok === n ? `✅ LU_TOUCH_SELFTEST ${ok}/${n}` : `❌ ${ok}/${n}`);
    return ok === n ? 0 : 1;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) process.exit(selftest());
    const DIR = process.env.DATA_DIR; if (!DIR) { console.log('需要 DATA_DIR'); process.exit(2); }
    const cache = new Map(), daily = s => { if (!cache.has(s)) cache.set(s, loadDaily(DIR, s)); return cache.get(s); };
    if (argv.includes('--bigflow')) {
        const TH = JSON.parse(fs.readFileSync(process.env.TICK_HIST, 'utf8'));
        const r = bigflow(TH, daily);
        console.log(`🧾 大單淨買(逐筆 ≥${TH.big_lots || 50} 張)・tick_hist ${r.days} 天、能算的 ${r.used} 天`);
        for (const q of r.q) console.log(`   第 ${q.q} 分位(${q.q === 1 ? '大單淨賣最多' : q.q === 5 ? '大單淨買最多' : '中間'}):隔天開盤買→當天收盤 ${q.h1}%(n ${q.n1})・抱 5 天 ${q.h5}%(n ${q.n5})  [增量 vs 同一天全部]`);
        if (r.used < 120) console.log(`   ⛔ 只有 ${r.used} 天,不下結論(要 ≥120 天、最好滿一年)`);
        if (argv[argv.indexOf('--bigflow') + 1] && !argv[argv.indexOf('--bigflow') + 1].startsWith('--')) fs.writeFileSync(argv[argv.indexOf('--bigflow') + 1], JSON.stringify(r, null, 1));
        return;
    }
    const K = loadKbar5(process.env.KBAR5_DIR);
    console.log(`📂 5 分 K ${Object.keys(K.days).length} 天:` + K.src.map(s => `${path.basename(s.dir)} ${s.used}`).join(' + '));
    const bench = daily('0050'); if (!bench) { console.log('🚧 讀不到 0050'); process.exit(1); }
    const S = scan(K.days, daily, bench);
    const byCls = {}; S.ev.forEach(e => (byCls[e.cls] = (byCls[e.cls] || 0) + 1));
    console.log(`🟥 碰到漲停 ${S.cnt.touch} 次:` + Object.entries(byCls).sort().map(([k, v]) => `${k} ${v}`).join(' ・ ') +
        ` ・(沒有昨天 5 分 K ${S.cnt.noPrev}、沒有日 K ${S.cnt.noDaily}、尺標不同剔除 ${S.cnt.scale})`);
    if (S.cnt.touch < 200) { console.log('🚧 事件 <200,不下結論'); process.exit(1); }
    const out = { meta: { days: Object.keys(K.days).length, from: S.dates[0], to: S.dates[S.dates.length - 1], cnt: S.cnt, byCls, bias: K.bias } };
    out.main = evaluate(S, daily, bench, e => e.cls);
    printTable('主表:對照 = 同一天收盤漲 ≥6% 但沒碰到漲停', out.main);
    out.vsAll = evaluate(S, daily, bench, e => e.cls, 'all');
    printTable('對照 = 同一天名單全部', out.vsAll);
    const notLock = e => (e.cls === 'C' || e.cls === 'D' || e.cls === 'E');
    out.dist = evaluate(S, daily, bench, e => notLock(e) ? (e.dist <= 1 ? '收盤離漲停 ≤1%' : e.dist <= 3 ? '收盤離漲停 1~3%' : '收盤離漲停 >3%') : null);
    printTable('沒鎖的(C/D/E)× 收盤離漲停多遠', out.dist);
    out.first = evaluate(S, daily, bench, e => (e.cls === 'D' ? (e.firstMin < 600 ? 'D・10:00 前就碰' : 'D・10:00 後才碰') : null));
    printTable('D 桶 × 第一次碰漲停的時間', out.first);
    out.vwap = evaluate(S, daily, bench, e => (e.cls === 'D' ? (e.aboveVwap ? 'D・收在均價線上' : 'D・收在均價線下') : null));
    printTable('D 桶 × 收盤在均價線上 / 下', out.vwap);
    if (argv[0]) { fs.writeFileSync(argv[0], JSON.stringify(out, null, 1)); console.log('💾 ' + argv[0]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
