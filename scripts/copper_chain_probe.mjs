#!/usr/bin/env node
/**
 * 🟠 V82.2.9 銅價 → 玻纖布 / CCL / PCB(事先登記 EXP-20261113-06)
 *
 * 問題:銅價(紐約期貨 HG=F)近 20 日漲最多 / 跌最多 / 創一年新高之後,材料鏈那 17 檔(stock_tags.json 人工種子)
 *   會不會比「它們平常」多漲或多跌?(使用者 11/13 貼的 AI 伺服器材料鏈週報範本把銅價當 CCL 成本指標)
 *
 * ⛔ 前視守門:美國那天收盤在台北隔天清晨 → 進場 = 美國那天之後第一個台股交易日開盤(CP_INJECT=peek 改成同一天 = 自我檢查用);
 *    百分位只用訊號日之前的資料(擴張窗,至少 250 天);一年新高只看之前 252 天。
 * ⚠️ 後見之明:17 檔是 2026 年人工挑的(還在、而且這幾年很強)→ 效果一律 = 訊號日的籃子超額 − 同一個籃子平常的超額
 *    (每個交易日都當進場日的平均),⛔ 拿籃子超額直接當效果(selftest ④ 決定性對照)。
 * 報酬:alignStock / fwdRet / nwP 一律 import trade_lead_probe(含息、鎖漲停買不到、斷崖窗口不算);六關 lib_evgate;BH lib_fdr。
 * 判定(照登記寫死,H=20,任一種訊號全部過才算有用):
 *   ① |效果| ≥ 0.44pp 而且在它的方向六關全過(每年至少 1 次)② 15 個檢定一起 BH,q ≤ 0.05
 *   ③ 比日期平移 ±60 / ±120 天的 4 組安慰劑在同方向都更極端 ④ 比同一批日期隨機 17 檔籃子 200 次的 95% 更極端
 *
 * 用法:DATA_DIR=<d16> US_HIST=<data/us_hist.json> TAGS=<data/stock_tags.json> node --max-old-space-size=6000 scripts/copper_chain_probe.mjs out.json
 *       node scripts/copper_chain_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { alignStock, fwdRet, nwP } from './trade_lead_probe.mjs';
import { gates, negate, COST } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';

export const HS = [5, 10, 20, 40, 60];
export const SIGS = ['up', 'dn', 'hi'];
export const MAIN_H = 20, DEDUP = 20, MIN_HIST = 250, HI_WIN = 252, SHIFTS = [-120, -60, 60, 120], N_RAND = 200;
export const GROUPS = ['glass', 'ccl', 'pcb'];
const PEEK = process.env.CP_INJECT === 'peek';
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const lagOf = h => Math.max(0, Math.ceil(h / 21) - 1);

/** 擴張窗百分位(只用 t 之前的值):回第 q 百分位(線性插值);樣本 < MIN_HIST → null */
function pctOf(sorted, q) { if (sorted.length < MIN_HIST) return null; const x = (sorted.length - 1) * q, lo = Math.floor(x), hi = Math.ceil(x); return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo); }
function insertSorted(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } a.splice(lo, 0, v); }

/** 美國那邊的訊號:回 {up, dn, hi} 各自是美國交易日索引陣列(還沒去重) */
export function copperSignals(c) {
    const out = { up: [], dn: [], hi: [] }, hist = [];
    for (let t = 0; t < c.length; t++) {
        const r = t >= 20 && c[t] > 0 && c[t - 20] > 0 ? c[t] / c[t - 20] - 1 : null;
        if (r != null) {
            const q90 = pctOf(hist, 0.9), q10 = pctOf(hist, 0.1);   // ⛔ 先判斷、再把今天放進去
            if (q90 != null && r >= q90) out.up.push(t);
            if (q10 != null && r <= q10) out.dn.push(t);
            insertSorted(hist, r);
        }
        if (t >= HI_WIN && c[t] > 0) {
            let mx = -Infinity, ok = true;
            for (let k = t - HI_WIN; k < t; k++) { if (!(c[k] > 0)) { ok = false; break; } mx = Math.max(mx, c[k]); }
            if (ok && c[t] >= mx) out.hi.push(t);
        }
    }
    return out;
}

/** 美國日期 → 台股進場日索引:之後第一個台股交易日(⛔ 同一天 —— 台股那天收盤時美國還沒開) */
export function entryOf(cal, usDate) {
    let lo = 0, hi = cal.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (PEEK ? cal[m] < usDate : cal[m] <= usDate) lo = m + 1; else hi = m; }
    return lo < cal.length ? lo : -1;
}

/** 同一種訊號 DEDUP 個台股交易日內只算第一次 */
export function dedupE(es, gap = DEDUP) { const out = []; let last = -Infinity; for (const e of [...es].sort((a, b) => a - b)) if (e - last >= gap) { out.push(e); last = e; } return out; }

/** 每一檔、每個進場日 e:第 e 天開盤買、抱 H 天(fwdRet,含息;買不到 / 斷崖 = NaN)—— 一個 H 算一次,籃子共用 */
export function fwdMatrix(stocks, T, H) {
    const M = new Map();
    for (const [s, S] of stocks) { const a = new Float64Array(T).fill(NaN); for (let e = 1; e + H - 1 < T; e++) { const r = fwdRet(S, e, e + H - 1); if (r != null) a[e] = r; } M.set(s, a); }
    return M;
}
/** 同一天全部股票的平均(⛔ 每個籃子重算一次 —— 這個數字跟籃子無關) */
export function allMeanOf(M, T) {
    const sum = new Float64Array(T), n = new Int32Array(T);
    for (const a of M.values()) for (let e = 0; e < T; e++) if (Number.isFinite(a[e])) { sum[e] += a[e]; n[e]++; }
    const out = new Float64Array(T).fill(NaN); for (let e = 0; e < T; e++) if (n[e] >= 20) out[e] = sum[e] / n[e];
    return out;
}
/** 籃子等權 − 同一天全部股票;籃子算得出來的成員 < 3 → NaN */
export function excessFrom(M, allMean, members) {
    const T = allMean.length, X = new Float64Array(T).fill(NaN), mem = members.map(s => M.get(s)).filter(Boolean);
    for (let e = 0; e < T; e++) { if (!Number.isFinite(allMean[e])) continue; let sb = 0, nb = 0; for (const a of mem) if (Number.isFinite(a[e])) { sb += a[e]; nb++; } if (nb >= 3) X[e] = sb / nb - allMean[e]; }
    return X;
}
/** 方便用(selftest):一次算完 */
export function excessSeries(cal, stocks, members, H) { const M = fwdMatrix(stocks, cal.length, H); return excessFrom(M, allMeanOf(M, cal.length), members); }

/** 效果:事件那幾天的超額 − 平常(全部算得出來的日子)的平均 → lib_evgate 形狀 {days, dm, all, n} */
export function effectOf(X, cal, es, xbar = null) {
    const ok = []; for (let e = 0; e < X.length; e++) if (Number.isFinite(X[e])) ok.push(X[e]);
    const base = xbar ?? mean(ok);
    const days = [], dm = [];
    for (const e of es) if (e >= 0 && e < X.length && Number.isFinite(X[e])) { days.push(cal[e]); dm.push(X[e] - base); }
    return { days, dm, all: dm.slice(), n: dm.length, base };
}

export function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

/** 全部算完 + 照登記判定 */
export function analyze(W, { nRand = N_RAND } = {}) {
    const { cal, stocks, members, us } = W;
    const raw = copperSignals(us.c);
    const ev = Object.fromEntries(SIGS.map(k => [k, dedupE(raw[k].map(t => entryOf(cal, us.days[t])).filter(e => e > 0))]));
    // 每個 H 算一次全部股票的報酬矩陣(只留 H=20 那份給隨機籃子 / 三組用)
    const X = {}; let M20 = null, A20 = null;
    for (const H of HS) { const M = fwdMatrix(stocks, cal.length, H), A = allMeanOf(M, cal.length); X[H] = excessFrom(M, A, members.all); if (H === MAIN_H) { M20 = M; A20 = A; } }
    const cells = [];
    for (const k of SIGS) for (const H of HS) {
        const inc = effectOf(X[H], cal, ev[k]);
        cells.push({ k, H, n: inc.n, d: mean(inc.dm), p: nwP(inc.dm, lagOf(H)), inc });
    }
    const q = bhQ(cells.map(c => c.p)); cells.forEach((c, i) => { c.q = q[i]; });
    const res = {};
    for (const k of SIGS) {
        const C = cells.find(c => c.k === k && c.H === MAIN_H), dir = C.d >= 0 ? 1 : -1;
        const G = gates(dir > 0 ? C.inc : negate(C.inc), COST, 1);
        const sh = SHIFTS.map(s => mean(effectOf(X[MAIN_H], cal, ev[k].map(e => e + s)).dm));
        // 隨機 17 檔籃子:同一批事件日、同一套「減掉這個籃子平常的超額」
        const pool = [...stocks.keys()], m = members.all.length, rnd = [];
        for (let b = 0; b < nRand; b++) {
            const R = rng(1000 + b), pick = [];
            const idx = pool.map((_, j) => j);
            for (let j = 0; j < m; j++) { const z = j + Math.floor(R() * (idx.length - j)); [idx[j], idx[z]] = [idx[z], idx[j]]; pick.push(pool[idx[j]]); }
            const Xr = excessFrom(M20, A20, pick);
            rnd.push(mean(effectOf(Xr, cal, ev[k]).dm));
        }
        const more = v => dir > 0 ? v >= C.d : v <= C.d;   // 安慰劑「跟真的一樣極端或更極端」
        const c = {
            c1: Math.abs(C.d) >= COST && Object.values(G.pass).every(Boolean),
            c2: C.q <= 0.05,
            c3: sh.every(v => Number.isFinite(v) && !more(v)),
            c4: rnd.filter(more).length / Math.max(1, rnd.length) <= 0.05,
        };
        const byG = Object.fromEntries(GROUPS.map(g => [g, r2(mean(effectOf(excessFrom(M20, A20, members[g]), cal, ev[k]).dm))]));
        const srt = [...C.inc.dm].sort((a, b) => a - b);
        res[k] = { pass: Object.values(c).every(Boolean), c, dir, n: C.n, d: r2(C.d), q: C.q, p: C.p,
            gates: { pass: G.pass, H: G.H.map(x => r2(dir * x)), YR: (G.YR || []).map(x => ({ y: x.y, n: x.n, d: r2(dir * x.d) })) },
            shifts: sh.map(r2), rndMore: r2(rnd.filter(more).length / Math.max(1, rnd.length) * 100), rndMed: r2(med(rnd)),
            byG, median: r2(med(C.inc.dm)), dropBest3: r2(mean(dir > 0 ? srt.slice(0, -3) : srt.slice(3))), dropWorst3: r2(mean(dir > 0 ? srt.slice(3) : srt.slice(0, -3))),
            dates: C.inc.days };
    }
    return { pass: SIGS.some(k => res[k].pass), res, cells: cells.map(({ inc, ...x }) => ({ ...x, d: r2(x.d) })),
        meta: { usFrom: us.days[0], usTo: us.days.at(-1), calFrom: cal[0], calTo: cal.at(-1), members: members.all, raw: Object.fromEntries(SIGS.map(k => [k, raw[k].length])) } };
}

// ───────────────────────── 讀資料 ─────────────────────────
function loadWorld(env) {
    const DATA = env.DATA_DIR, US = env.US_HIST, TAGS = env.TAGS;
    if (!DATA || !US || !TAGS) { console.log('❌ 要設 DATA_DIR / US_HIST / TAGS(跑法見檔頭)'); process.exit(1); }
    const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
    const cal = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => d10(r.date)).filter(Boolean);
    const calIdx = new Map(cal.map((d, i) => [d, i]));
    const divAll = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, '_div16.json'), 'utf8')).d || {}; } catch (_) { return {}; } })();
    const stocks = new Map();
    for (const f of fs.readdirSync(DATA)) {
        const s = f.replace(/\.json$/, '');
        if (!/^\d{4}$/.test(s) || s.startsWith('00')) continue;
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 60) continue;
        const A = alignStock(cal, calIdx, bars, (divAll[s] || {}).h); A.date = cal; stocks.set(s, A);
    }
    const U = JSON.parse(fs.readFileSync(US, 'utf8'));
    const hg = (U.mac || {})['HG=F'];
    if (!hg || !Array.isArray(hg.c) || hg.c.length !== U.days.length) { console.log('❌ us_hist 沒有 HG=F(或長度跟 days 對不上)→ 先手動派 us_hist(start 2009-01-01)'); process.exit(1); }
    const T = JSON.parse(fs.readFileSync(TAGS, 'utf8'));
    const members = Object.fromEntries(GROUPS.map(g => [g, ((T.seed || {})[g] || []).map(String).filter(s => stocks.has(s))]));
    members.all = [...new Set(GROUPS.flatMap(g => members[g]))];
    if (members.all.length < 10) { console.log(`❌ 籃子只有 ${members.all.length} 檔有 K 線(TAGS 的 seed 對不上?)`); process.exit(1); }
    return { cal, stocks, members, us: { days: U.days.map(d10), c: hg.c.map(x => +x || null) } };
}

function main(out) {
    const t0 = Date.now();
    const W = loadWorld(process.env);
    console.log(`📦 台股 ${W.cal[0]} ~ ${W.cal.at(-1)}・個股 ${W.stocks.size} 檔・銅價 ${W.us.days[0]} ~ ${W.us.days.at(-1)}・籃子 ${W.members.all.length} 檔(${GROUPS.map(g => `${g} ${W.members[g].join(' ')}`).join(' ・')})`);
    const R = analyze(W);
    const s = x => (x >= 0 ? '+' : '') + x, yn = x => x ? '✅' : '❌', nm = { up: '漲最多 10%', dn: '跌最多 10%', hi: '一年新高' };
    console.log(`原始訊號天數(去重前):${SIGS.map(k => `${nm[k]} ${R.meta.raw[k]}`).join(' ・')}`);
    for (const k of SIGS) {
        const V = R.res[k];
        console.log(`\n${nm[k]}(抱 20 天):效果 ${s(V.d)}pp(${V.n} 次・方向 ${V.dir > 0 ? '多漲' : '多跌'})・NW p ${V.p.toFixed(4)} ・BH q ${V.q.toFixed(4)}`);
        console.log(`  ① |效果| ≥ 0.44 + 六關 ${Object.entries(V.gates.pass).map(([a, b]) => `${a}${b ? '✅' : '❌'}`).join(' ')} ${yn(V.c.c1)} ・② ${yn(V.c.c2)} ・③ 平移 ${V.shifts.join(' / ')} ${yn(V.c.c3)} ・④ 隨機籃子一樣極端 ${V.rndMore}%(中位 ${V.rndMed})${yn(V.c.c4)}`);
        console.log(`  逐年 ${V.gates.YR.map(x => `${x.y.slice(2)}:${x.d}(${x.n})`).join(' ')} ・三組 玻纖布 ${V.byG.glass} / CCL ${V.byG.ccl} / PCB ${V.byG.pcb} ・中位 ${V.median} ・拿掉最好 3 次 ${V.dropBest3} / 最差 3 次 ${V.dropWorst3}`);
    }
    for (const H of HS) console.log(`H=${String(H).padStart(2)}:${SIGS.map(k => { const c = R.cells.find(x => x.k === k && x.H === H); return `${nm[k]} ${s(c.d)}(n ${c.n}・q ${c.q.toFixed(3)})`; }).join(' ・')}`);
    console.log(`⇒ ${R.pass ? '✅ 有一種過' : '❌ 三種都沒過'}・${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
}

// ───────────────────────── selftest ─────────────────────────
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    // ① 擴張窗:今天的大漲 ⛔ 拿去算自己的門檻(先判斷再放進去)—— 平平 300 天後突然一天大漲 → 一定算到
    const c = []; for (let t = 0; t < 400; t++) c.push(100 * (1 + 0.0001 * Math.sin(t)));
    c[350] = 150; for (let t = 351; t < 400; t++) c[t] = 150;
    const S = copperSignals(c);
    ok('① 第一次大漲那天就算「漲最多 10%」(門檻只用之前的日子)', S.up.includes(350), JSON.stringify(S.up.slice(0, 5)));
    ok('① 一年新高:要之前 252 天都有值、今天 ≥ 之前最高', S.hi.includes(350) && !S.hi.some(t => t < HI_WIN), JSON.stringify(S.hi.slice(0, 5)));
    // ② 進場日:美國 2015-03-06(五)→ 台股之後第一個交易日 2015-03-09(一);美國 2015-03-09 → 2015-03-10(⛔ 同一天)
    const cal = []; for (let t = Date.UTC(2010, 0, 4); cal.length < 1400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) cal.push(d.toISOString().slice(0, 10)); }
    ok('② 美國 2015-03-06 → 台股 2015-03-09', cal[entryOf(cal, '2015-03-06')] === '2015-03-09', cal[entryOf(cal, '2015-03-06')]);
    ok('② ⭐ 美國 2015-03-09 → 台股 2015-03-10(⛔ 同一天;CP_INJECT=peek 會紅)', cal[entryOf(cal, '2015-03-09')] === '2015-03-10', cal[entryOf(cal, '2015-03-09')]);
    ok('③ 去重:20 天內只算第一次', JSON.stringify(dedupE([5, 10, 24, 25, 60])) === JSON.stringify([5, 25, 60]));
    // 合成台股:200 檔,前 17 檔 = 籃子;情境:籃子平常就每天多 0.1%(後見之明)/ 訊號之後 20 天每天再多 0.15%
    const mk = (lvl, eff, sigE, seed = 7) => {
        const R = rng(seed), T = cal.length, stocks = new Map();
        const boost = new Float64Array(T); for (const e of sigE) for (let k = e; k < e + 20 && k < T; k++) boost[k] += eff;
        for (let s = 0; s < 200; s++) {
            const o = new Float64Array(T), h = new Float64Array(T), l = new Float64Array(T), cc = new Float64Array(T); let p = 50;
            for (let t = 0; t < T; t++) { const op = p; p = op * (1 + (R() - 0.5) * 0.02 + (s < 17 ? lvl + boost[t] : 0)); o[t] = op; cc[t] = p; h[t] = Math.max(op, p) * 1.003; l[t] = Math.min(op, p) * 0.997; }
            stocks.set(String(1000 + s), { o, h, l, c: cc, cliff: new Int32Array(T + 1), divf: new Float64Array(T).fill(1), date: cal });
        }
        const mem = Array.from({ length: 17 }, (_, s) => String(1000 + s));
        return { stocks, mem };
    };
    // 事件 18 次、間隔 60 天(真的訊號也很稀;間隔太密 →「平常」幾乎每天都被影響到,效果會被稀釋)
    const sigE = Array.from({ length: 18 }, (_, k) => 200 + k * 60);
    {   // ④ ⭐ 後見之明:籃子平常就強,訊號沒有效果 → 籃子超額很大,但效果(− 平常)≈ 0
        const { stocks, mem } = mk(0.001, 0, sigE); const X = excessSeries(cal, stocks, mem, 20); const E = effectOf(X, cal, sigE);
        const rawX = mean(sigE.map(e => X[e]));
        ok(`④ 籃子平常就每天多 0.1%:訊號日籃子超額 ${r2(rawX)}pp 很大,但效果 ${r2(mean(E.dm))} ≈ 0(減掉平常)`, rawX > 1 && Math.abs(mean(E.dm)) < 0.6, JSON.stringify({ rawX, d: mean(E.dm) }));
    }
    {   // ⑤ 有效果:訊號之後 20 天每天多 0.15% → 訊號日 ≈ +3 × (1 − 17/200) ≈ +2.7,「平常」也沾到一點(約 +0.7)→ 效果 ≈ +2
        const { stocks, mem } = mk(0, 0.0015, sigE); const X = excessSeries(cal, stocks, mem, 20); const E = effectOf(X, cal, sigE);
        ok(`⑤ 有效果:效果 ${r2(mean(E.dm))}pp ≈ +2`, mean(E.dm) > 1.4 && mean(E.dm) < 3, String(mean(E.dm)));
        const sh = mean(effectOf(X, cal, sigE.map(e => e + 30)).dm);
        ok(`⑤ 平移 30 天(跟訊號窗口完全錯開)效果 ${r2(sh)} ≤ 0`, sh <= 0.1, String(sh));
    }
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ 全部通過');
    return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
}
