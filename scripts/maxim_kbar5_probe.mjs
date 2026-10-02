#!/usr/bin/env node
/**
 * 🗣️ 盤中口訣「非分 K 不可」的三條 —— 用 5 年 5 分 K 正式回測(V78.2.5)
 *
 * 以前卡在資料(LAB「⏳ 還測不了」那一條):api.kbars 只回溯 81~120 天、而且一根都沒存。
 * 現在 `kbar5_deep`(2021-05 起,每月初前 60 日成交值前 100)+ `kbar5`(每日量前 80)有 1,300+ 個交易日,含 2022 空頭。
 *
 * 判定照抄 `intraday_probe.py::maxim_signals`(⛔ 門檻一個都沒改):
 *   ⑦  下午(≥12:00 那根收完)現價 ≥ 昨收 +3% → 追(口訣:「下午大漲不追」)
 *   ⑦b 下午現價 ≤ 昨收 −3% → 口訣:「下午大跌**次日**買」→ 隔天開盤買(當沖到收盤 / 抱 5 天兩種)
 *   ⑧  開盤 ≤ 昨收 −2%,09:10 收盤站回開盤價 → 買(⚠️ 口訣原句是「不割」= 持有者的事,這裡測「買」是代理)
 *   ⑧b 同上但沒站回
 *   ⑨  第一根 5 分 K 上影 ≥ 全幅 50% → 追(口訣:「上影太長絕對不追」)・⑨b 上影 ≤ 20%
 *
 * ⭐ 對照組 = **同一天、同一個進場時點、所有其他股票** 都照做(量的是「條件」本身,⛔ 不是那天大盤)
 * ⭐ 昨收一律拿**昨天的 5 分 K 自己算**(⛔ 不讀日 K:上櫃日 K 四成是還原價,陷阱 #46);昨天不在名單 → 那一檔今天不算(計數印出來)
 * ⭐ 零前視:進場 = 訊號那根的收盤;判定只用那根(含)以前的 5 分 K
 * ⭐ 扣當沖來回成本 0.25%;⑦b 抱 5 天那組扣 0.44%
 * ⭐ 六關(跟口訣主張的方向比):全期增量 |t|≥2 ・前後半同向 ・逐年同向 ・去最好年 ・扣成本絕對報酬 ・拿掉最好 10 天
 *    「不追 / 不買」型的口訣:成立 = 增量顯著為負;「要買」型:成立 = 增量顯著為正而且扣完成本還是正的
 *
 * ⚠️ 母體 = 那個月 / 那一天的熱門股(選樣偏誤,⛔ 結論不可講得像全市場);ETF(0 開頭)排除;開盤就漲跌停的日子排除。
 *
 * 跑法:
 *   git archive origin/kbar5_deep | tar -x -C $S/k5d && git archive origin/kbar5 | tar -x -C $S/k5
 *   KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5 DATA_DIR=$S/d10n node scripts/maxim_kbar5_probe.mjs [out.json]
 *   node scripts/maxim_kbar5_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadKbar5, COST, COST_ON } from './dt_kbar5_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
export const AFTERNOON = 720, GAP_DN = -2, RUSH = 3, SHADOW = 0.5, SHADOW_LOW = 0.2;   // = intraday_probe.py MAXIM_*

/** 一檔一天的訊號。bars = [[hm,o,h,l,c,v], ...](09:00~13:25),pc = 昨收(昨天 5 分 K 最後一根)。
 *  回 [{k, j, e}](k = 名稱、j = 進場那根索引、e = 進場價)。⛔ 只看 bars[0..j]。 */
export function signals(bars, pc, th = {}) {
    const out = [], { rush = RUSH, gap = GAP_DN, shadow = SHADOW } = th;
    if (!(pc > 0) || bars.length < 3) return out;
    const [, o1, h1, l1, c1] = bars[0];
    const rg = h1 - l1;
    if (rg > 0) {                                   // ⑨ 第一根 5 分 K 上影(進場 = 那根收盤)
        const sh = (h1 - Math.max(o1, c1)) / rg;
        if (sh >= shadow) out.push({ k: '⑨', j: 0, e: c1 });
        else if (sh <= SHADOW_LOW) out.push({ k: '⑨b', j: 0, e: c1 });
    }
    const gap0 = (o1 / pc - 1) * 100;               // ⑧ 開盤大跌,09:10(bars[1] 收完)站不站得回開盤價
    if (gap0 <= gap && bars[1][0] === bars[0][0] + 5) out.push({ k: bars[1][4] >= o1 ? '⑧' : '⑧b', j: 1, e: bars[1][4] });
    for (let j = 1; j < bars.length - 1; j++) {     // ⑦ 下午第一根達標的(一天一次);⛔ 最後一根不算(沒得抱)
        if (bars[j][0] < AFTERNOON) continue;
        const chg = (bars[j][4] / pc - 1) * 100;
        if (chg >= rush) { out.push({ k: '⑦', j, e: bars[j][4] }); break; }
        if (chg <= -rush) { out.push({ k: '⑦b', j, e: bars[j][4] }); break; }
    }
    return out;
}

/** 六關:x = [{v, d}](v = 增量 %)、raw = 同一批的絕對報酬(扣成本後);sign = +1 口訣說會賺 / −1 口訣說會賠 */
export function gates(x, raw, sign) {
    const n = x.length; if (n < 30) return { n, pass: 0, note: '樣本 <30' };
    const v = x.map(e => e.v), m = mean(v), sd = Math.sqrt(mean(v.map(a => (a - m) ** 2))), t = m / (sd / Math.sqrt(n) || 1);
    const ds = [...new Set(x.map(e => e.d))].sort(), half = ds[ds.length >> 1];
    const A = x.filter(e => e.d < half).map(e => e.v), B = x.filter(e => e.d >= half).map(e => e.v);
    const yr = {}; x.forEach(e => (yr[e.d.slice(0, 4)] = yr[e.d.slice(0, 4)] || []).push(e.v));
    const ym = Object.fromEntries(Object.entries(yr).filter(([, a]) => a.length >= 20).map(([y, a]) => [y, mean(a)]));
    const best = Object.entries(ym).sort((a, b) => sign * (b[1] - a[1]))[0];
    const noBest = best ? x.filter(e => !e.d.startsWith(best[0])).map(e => e.v) : v;
    const byDay = {}; x.forEach(e => (byDay[e.d] = byDay[e.d] || []).push(e.v));
    const top10 = new Set(Object.entries(byDay).map(([d, a]) => [d, mean(a)]).sort((a, b) => sign * (b[1] - a[1])).slice(0, 10).map(e => e[0]));
    const no10 = x.filter(e => !top10.has(e.d)).map(e => e.v);
    const S = a => sign * mean(a) > 0;
    const g = {
        '全期增量 |t|≥2': S(v) && Math.abs(t) >= 2,
        前後半同向: S(A) && S(B),
        逐年同向: Object.values(ym).length >= 2 && Object.values(ym).every(a => sign * a > 0),
        去最好年: S(noBest),
        扣成本絕對: sign > 0 ? mean(raw) > 0 : mean(raw) < 0,
        拿掉最好10天: S(no10),
    };
    return { n, inc: +m.toFixed(3), t: +t.toFixed(2), abs: +mean(raw).toFixed(3), A: +mean(A).toFixed(3), B: +mean(B).toFixed(3),
        years: Object.fromEntries(Object.entries(ym).map(([y, a]) => [y, +a.toFixed(3)])), gates: g, pass: Object.values(g).filter(Boolean).length };
}

/** 跑一份 days(loadKbar5 的格式)。dailyNext(sym, d) → {o1, c1, c5}(隔天開盤 / 隔天收盤 / 隔天起第 5 天收盤)或 null。 */
export function run(days, th = {}, dailyNext = null) {
    const dates = Object.keys(days).sort();
    const ev = {}, put = (k, o) => (ev[k] = ev[k] || []).push(o);
    const cnt = { noPrev: 0, limitOpen: 0, limitEntry: 0, stockDays: 0 };
    let prev = {};
    for (let di = 0; di < dates.length; di++) {
        const d = dates[di], K = days[d].k || {}, yday = dates[di - 1];
        const rows = [];
        for (const [sym, raw] of Object.entries(K)) {
            if (/^0/.test(sym)) continue;
            const bars = raw.filter(b => b[0] >= 540 && b[0] <= 805);
            const all = raw.filter(b => b[0] >= 540 && b[0] <= 810);
            const pv = prev[sym]; prev[sym] = { d, all };
            if (bars.length < 40) continue;
            if (!pv || pv.d !== yday || !pv.all.length) { cnt.noPrev++; continue; }
            const pc = pv.all[pv.all.length - 1][4];
            const o = bars[0][1];
            if (!(pc > 0) || o >= pc * 1.095 || o <= pc * 0.905) { cnt.limitOpen++; continue; }
            cnt.stockDays++;
            rows.push({ sym, bars, pc, c: bars[bars.length - 1][4] });
        }
        // 對照組:同一天、同一根收盤進場、抱到收盤(所有股票)
        const ctrl = new Map();
        const cAt = (j, hm) => { const key = hm; if (ctrl.has(key)) return ctrl.get(key);
            const a = []; for (const r of rows) { const b = r.bars.find(x => x[0] === hm); if (b) a.push((r.c / b[4] - 1) * 100 - COST); }
            const m = a.length >= 10 ? mean(a) : null; ctrl.set(key, m); return m; };
        for (const r of rows) {
            // 🔀 拆解對照:「收盤跌 ≥rush%」就隔天買(⛔ 不看下午)—— 量的是「下午」那個條件有沒有多給東西
            if (dailyNext && r.c <= r.pc * (1 - (th.rush || RUSH) / 100)) {
                const nx = dailyNext(r.sym, d);
                if (nx && nx.o1 > 0 && nx.c5 > 0 && nx.ctrl && nx.ctrl.r5 != null) {
                    const g5 = (nx.c5 / nx.o1 - 1) * 100 - COST_ON;
                    put('🔀 對照:收盤跌 ≥3%(不看下午)→ 隔天開盤買・抱 5 天', { d, v: g5 - nx.ctrl.r5, raw: g5 });
                }
            }
            for (const s of signals(r.bars, r.pc, th)) {
                if (s.k === '⑦b') {
                    const nx = dailyNext && dailyNext(r.sym, d);
                    if (!nx) continue;
                    const nxAll = nx.ctrl;   // 同一天收盤後所有股票的隔天結果(對照)
                    if (nx.o1 > 0 && nxAll && nxAll.n >= 10) {
                        const g1 = (nx.c1 / nx.o1 - 1) * 100 - COST;
                        put('⑦b 下午大跌 → 隔天開盤買・當沖到收盤', { d, v: g1 - nxAll.r1, raw: g1 });
                        if (nx.c5 > 0 && nxAll.r5 != null) { const g5 = (nx.c5 / nx.o1 - 1) * 100 - COST_ON; put('⑦b 下午大跌 → 隔天開盤買・抱 5 天', { d, v: g5 - nxAll.r5, raw: g5 }); }
                    }
                    const hm = r.bars[s.j][0], cm = cAt(s.j, hm);
                    if (cm != null) { const g = (r.c / s.e - 1) * 100 - COST; put('⑦b′ 下午大跌當下就接(到收盤)', { d, v: g - cm, raw: g }); }
                    continue;
                }
                if (s.k === '⑦' && s.e >= r.pc * 1.095) { cnt.limitEntry++; continue; }   // 已鎖漲停 → 買不到
                const hm = r.bars[s.j][0], cm = cAt(s.j, hm);
                if (cm == null) continue;
                const g = (r.c / s.e - 1) * 100 - COST;
                put({ '⑦': '⑦ 下午大漲後追', '⑧': '⑧ 開盤大跌・09:10 站回開盤價 → 買', '⑧b': '⑧b 開盤大跌・09:10 沒站回 → 買',
                      '⑨': '⑨ 第一根上影 ≥50% 後追', '⑨b': '⑨b 第一根沒上影(≤20%)後追' }[s.k], { d, v: g - cm, raw: g });
            }
        }
    }
    return { ev, cnt, dates };
}

// 口訣主張的方向:+1 = 會賺(該做)/ −1 = 會賠(不該做)
export const CLAIM = {
    '⑦ 下午大漲後追': -1, '⑦b 下午大跌 → 隔天開盤買・當沖到收盤': 1, '⑦b 下午大跌 → 隔天開盤買・抱 5 天': 1,
    '⑦b′ 下午大跌當下就接(到收盤)': 1, '⑧ 開盤大跌・09:10 站回開盤價 → 買': 1, '⑧b 開盤大跌・09:10 沒站回 → 買': -1,
    '⑨ 第一根上影 ≥50% 後追': -1, '⑨b 第一根沒上影(≤20%)後追': 1,
    '🔀 對照:收盤跌 ≥3%(不看下午)→ 隔天開盤買・抱 5 天': 1,
};

function dailyLoader(DD) {
    const cache = new Map();
    const get = sym => { if (cache.has(sym)) return cache.get(sym); let m = null;
        try { let r = JSON.parse(fs.readFileSync(path.join(DD, `${sym}.json`), 'utf8')); r = Array.isArray(r) ? r : r.data;
            m = { r, idx: new Map(r.map((x, i) => [String(x.date).replace(/\//g, '-'), i])) }; } catch (_) {}
        cache.set(sym, m); return m; };
    const one = (sym, d) => { const m = get(sym); if (!m) return null; const i = m.idx.get(d); if (i == null || !m.r[i + 1]) return null;
        const a = m.r[i + 1], b = m.r[i + 5];
        return { o1: +a.open, c1: +a.close, c5: b ? +b.close : null }; };
    const ctrlCache = new Map();
    return (days) => (sym, d) => {
        const x = one(sym, d); if (!x) return null;
        if (!ctrlCache.has(d)) { const r1 = [], r5 = [];
            for (const s of Object.keys(days[d].k || {})) { if (/^0/.test(s)) continue; const y = one(s, d); if (!y || !(y.o1 > 0)) continue;
                r1.push((y.c1 / y.o1 - 1) * 100 - COST); if (y.c5 > 0) r5.push((y.c5 / y.o1 - 1) * 100 - COST_ON); }
            ctrlCache.set(d, { n: r1.length, r1: r1.length ? mean(r1) : null, r5: r5.length >= 10 ? mean(r5) : null }); }
        return { ...x, ctrl: ctrlCache.get(d) };
    };
}

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    const day = (o, path5) => { let p = o; return path5.map((c, i) => { const b = [540 + i * 5, p, Math.max(p, c) + 0.1, Math.min(p, c) - 0.1, c, 100]; p = c; return b; }); };
    // ① ⑨ 上影:開 100 高 105 收 100.5 低 99.8
    const b9 = day(100, Array(55).fill(100.5)); b9[0] = [540, 100, 105, 99.8, 100.5, 100];
    ok('① ⑨ 長上影會觸發', signals(b9, 100).some(s => s.k === '⑨'));
    const b9b = day(100, Array(55).fill(101)); b9b[0] = [540, 100, 101.05, 99.5, 101, 100];
    ok('①b ⑨b 沒上影會觸發', signals(b9b, 100).some(s => s.k === '⑨b'));
    // ② ⑧ 開盤 −3%,09:10 站回 / 沒站回
    const b8 = day(97, [96.5, 97.2, ...Array(53).fill(97.5)]);
    ok('② ⑧ 跌 3% 開、09:10 站回 → ⑧', signals(b8, 100).some(s => s.k === '⑧' && s.j === 1));
    const b8b = day(97, [96.5, 96.6, ...Array(53).fill(96)]);
    ok('②b 沒站回 → ⑧b', signals(b8b, 100).some(s => s.k === '⑧b'));
    // ③ ⑦ 下午才達標;上午達標不算
    const p7 = Array(55).fill(101); for (let i = 37; i < 55; i++) p7[i] = 104;   // 540+37*5 = 725 ≥ 720
    const s7 = signals(day(100, p7), 100).find(s => s.k === '⑦');
    ok('③ ⑦ 下午第一根 ≥+3% 才觸發', s7 && day(100, p7)[s7.j][0] >= 720);
    const p7am = Array(55).fill(104);
    const s7am = signals(day(100, p7am), 100).find(s => s.k === '⑦');
    ok('③b 早上就 +4%:觸發點仍在下午第一根(⛔ 不可用早上那根)', s7am && day(100, p7am)[s7am.j][0] >= 720);
    // ④ 零前視:改進場那根之後的 K,訊號與進場價不變
    const pA = [...p7]; const pB = [...p7]; for (let i = s7.j + 1; i < 55; i++) pB[i] = 90;
    const sA = signals(day(100, pA), 100).find(s => s.k === '⑦'), sB = signals(day(100, pB), 100).find(s => s.k === '⑦');
    ok('④ 改掉進場之後的 K → 訊號與進場價不變(零前視)', sA && sB && sA.j === sB.j && sA.e === sB.e);
    // ⑤ 埋邊際:⑨ 那幾檔之後一律跌 2% → 增量要量到負;昨收要從昨天 5 分 K 算
    const mk = (seed) => { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; };
    const rnd = mk(7), days = {};
    const D = [...Array(60)].map((_, i) => `2025-${String(1 + (i / 28 | 0)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`);
    for (const d of D) { const k = {};
        for (let s = 0; s < 30; s++) { const sym = String(2000 + s); const long = s < 6;
            const path5 = []; let p = 100; for (let i = 0; i < 55; i++) { p *= 1 + (rnd() - 0.5) * 0.004 - (long && i > 0 ? 0.0004 : 0); path5.push(+p.toFixed(3)); }
            const b = day(100, path5); const c0 = path5[0]; b[0] = long ? [540, c0, c0 + 4, c0 - 0.2, c0, 100] : [540, c0, c0 + 0.1, c0 - 0.5, c0, 100];
            b.push([810, path5[54], path5[54], path5[54], 100, 100]);   // 13:30 那根收 100 = 明天的昨收
            k[sym] = b; }
        days[d] = { k }; }
    delete days[D[10]].k['2001'];   // 2001 第 11 天不在名單 → 第 12 天「昨天」不是前一個交易日 → 不算
    const R = run(days);
    const e9 = R.ev['⑨ 第一根上影 ≥50% 後追'] || [];
    const g9 = gates(e9, e9.map(e => e.raw), -1);
    ok('⑤ 埋「長上影之後走低」→ 增量量到負', g9.inc < -0.5, JSON.stringify(g9).slice(0, 120));
    ok('⑤b 昨天不在名單不算:第一天 30 檔 + 中間斷一天的那一檔 = 31', R.cnt.noPrev === 31, R.cnt.noPrev);
    // ⑥ 決定性對照:把埋的邊際拿掉 → 增量 ≈ 0
    const rnd2 = mk(7), days2 = {};
    for (const d of D) { const k = {};
        for (let s = 0; s < 30; s++) { const sym = String(2000 + s);
            const path5 = []; let p = 100; for (let i = 0; i < 55; i++) { p *= 1 + (rnd2() - 0.5) * 0.004; path5.push(+p.toFixed(3)); }
            const b = day(100, path5); const c0 = path5[0]; b[0] = s < 6 ? [540, c0, c0 + 4, c0 - 0.2, c0, 100] : [540, c0, c0 + 0.1, c0 - 0.5, c0, 100];
            b.push([810, path5[54], path5[54], path5[54], 100, 100]); k[sym] = b; }
        days2[d] = { k }; }
    const e9n = run(days2).ev['⑨ 第一根上影 ≥50% 後追'] || [];
    ok('⑥ 沒埋邊際 → |增量| < 0.15(對照組有在做事)', Math.abs(mean(e9n.map(e => e.v))) < 0.15, mean(e9n.map(e => e.v)));
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ MAXIM_KBAR5_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

async function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const { days, bias, src } = loadKbar5(process.env.KBAR5_DIR);
    for (const x of src) console.log(`📂 ${x.dir}:${x.days} 天(採用 ${x.used})`);
    const dates = Object.keys(days).sort();
    if (dates.length < 200) { console.error(`❌ 只有 ${dates.length} 天 → 不下結論(要 KBAR5_DIR=<kbar5_deep>:<kbar5>)`); process.exit(1); }
    const DD = process.env.DATA_DIR || path.join(ROOT, 'data');
    const dn = dailyLoader(DD)(days);
    console.log(`📅 ${dates.length} 個交易日(${dates[0]} ~ ${dates[dates.length - 1]})・⚠️ 母體:${(bias || '熱門股').slice(0, 60)}`);
    const R = run(days, {}, dn);
    console.log(`🧮 股·日 ${R.cnt.stockDays} ・昨天不在名單跳過 ${R.cnt.noPrev} ・開盤漲跌停跳過 ${R.cnt.limitOpen} ・⑦ 已鎖漲停買不到 ${R.cnt.limitEntry}`);
    const out = { generated: new Date().toISOString(), days: dates.length, from: dates[0], to: dates[dates.length - 1], cnt: R.cnt, rows: {}, plateau: {} };
    console.log('═'.repeat(100));
    console.log('增量 = 這一筆 − 同一天同一時點進場的所有股票平均(都已扣成本);口訣方向:+ 會賺 / − 會賠');
    for (const [k, sign] of Object.entries(CLAIM)) {
        const e = R.ev[k] || [];
        if (!e.length) { console.log(`🚨 ${k}:0 筆 → 這個變體根本沒生效(⛔ 不可讀成沒差別)`); out.rows[k] = { n: 0 }; continue; }
        const g = gates(e, e.map(x => x.raw), sign);
        out.rows[k] = { claim: sign, ...g };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} ${k}  口訣說${sign > 0 ? '會賺' : '會賠'} ・n=${g.n} ・增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・絕對 ${g.abs >= 0 ? '+' : ''}${g.abs}% ・前後半 ${g.A}/${g.B} ・六關 ${g.pass}/6`);
        console.log(`     逐年 ${JSON.stringify(g.years)} ・沒過:${Object.entries(g.gates || {}).filter(([, v]) => !v).map(([n]) => n).join('、') || '—'}`);
    }
    console.log('─'.repeat(100) + '\n⛰️ 門檻高原(只看增量,⛔ 不重跑六關)');
    const P = { rush: [2, 3, 4, 5], gap: [-1.5, -2, -3, -4], shadow: [0.4, 0.5, 0.6, 0.7] };
    for (const [key, vals] of Object.entries(P)) for (const val of vals) {
        const r = run(days, { [key]: val }, null).ev; const pick = key === 'rush' ? '⑦ 下午大漲後追' : key === 'gap' ? '⑧ 開盤大跌・09:10 站回開盤價 → 買' : '⑨ 第一根上影 ≥50% 後追';
        const e = r[pick] || []; const m = mean(e.map(x => x.v));
        (out.plateau[key] = out.plateau[key] || []).push({ val, n: e.length, inc: +m.toFixed(3) });
        console.log(`   ${pick.slice(0, 2)} ${key}=${val}:n=${e.length} 增量 ${m >= 0 ? '+' : ''}${m.toFixed(3)}pp`);
    }
    for (const val of [2, 3, 4, 5, 7]) {
        const r = run(days, { rush: val }, dn).ev; const e = r['⑦b 下午大跌 → 隔天開盤買・抱 5 天'] || [], f = r['🔀 對照:收盤跌 ≥3%(不看下午)→ 隔天開盤買・抱 5 天'] || [];
        const g = gates(e, e.map(x => x.raw), 1);
        (out.plateau.rush7b = out.plateau.rush7b || []).push({ val, n: e.length, inc: g.inc, abs: g.abs, pass: g.pass, dailyInc: +mean(f.map(x => x.v)).toFixed(3) });
        console.log(`   ⑦b 抱5天 rush=${val}:n=${e.length} 增量 ${g.inc}pp ・絕對 ${g.abs}% ・六關 ${g.pass}/6 ・對照(收盤跌 ≥${val}%,不看下午)增量 ${mean(f.map(x => x.v)).toFixed(3)}pp n=${f.length}`);
    }
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
