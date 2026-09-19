#!/usr/bin/env node
/**
 * 🧙💥 「某個分點突然大量買某檔」之後會漲嗎?—— 排除隔日沖(V77.3.2)
 *
 * 使用者(2026-09-19):「回測突然某個分點大量買某張個股,這時候會漲嗎?回測一下,另外排除隔日沖」
 *
 * ⭐ 先查登記表(⛔ 不重探):
 *   ・`broker_skill_probe` B 組(神秘分點 = 第一次出現就大買)❌ 六關 0 過
 *   ・`broker_cross_probe` A 組:**隔日沖佔比高反而 +2.11pp**(動能)→「排除隔日沖」這個方向被實測打過臉
 *   ・`chips_deep_probe`:分點集中度**沒有方向性預測力**
 *   → 這支的新意只有兩件:① 「突然」用**該分點在該股自己的歷史**定義(expanding,零前視)
 *                          ② 隔日沖用**連續分桶**(五分位)⛔ 不二分 —— 二分會把「排除隔日沖」變成自己選的門檻
 *
 * 「突然大量買」兩種定義(都只用 t 之前的資料):
 *   A 新面孔:該分點過去 60 天**沒出現**在該股買方前 15,今天出現且淨買 >0
 *   B 自身爆量:該分點在該股過去 ≥10 次上榜的淨買量 **expanding P95** 以上
 * 隔日沖:每家券商的 expanding 翻臉率(今天買、明天賣;抄 `broker_cross_probe.mjs` 的邏輯,⛔ 只用當天以前)
 *   → 事件按翻臉率**五分位**分桶各印一次(⛔ 不是「翻臉率 ≥35% 就排除」)
 * 進場 t+1 開盤(分點收盤後才公布)、t+1 一字漲停剔除、扣同期加權、20 日去重(以**檔**去重,⛔ 不以檔×分點 —— 同一檔多個分點會灌 n)
 * 對照組 = 同一批股票、同一段日期的**全部**股·日;六關 + 格內(位階 × 波動 × 成交金額)+ 門檻高原(A:30/60/90 日;B:P90/P95/P99)
 *
 * ⚠️ 限制:`chips_deep` 只存**買賣各前 15**(V74.0.6)→ 翻臉率是**下界**(前 15 以外的賣看不到);窗口 2024-08-30 起,**不含 2022**;
 *         同一檔一天最多 15 個買方 → 「該分點沒出現」可能只是「排到 16 名」
 *
 * ════════════════════════════════════════════════════════════════
 * 📊 2026-09-19 實測(V77.3.2):484 天 ・2,150 檔 ・對照組 943,463 ・事件 84,943(A 43,612 / B 41,331)・2 分 48 秒
 * ════════════════════════════════════════════════════════════════
 *   A 新面孔 ≥60 天:10 日 −0.09pp ・勝率 35.4%(對照 35.9%)・扣成本 −0.53 → 1/6;高原 ≥30/60/90 天 = −0.09 / −0.09 / −0.13(全負)
 *   B 自身爆量 ≥P95:10 日 +0.09pp ・勝率 36.6% ・扣成本 −0.35 → 2/6;高原 P90/95/99 = −0.04 / +0.09 / +0.08(≈ 0)
 *   A ∧ B:n=398 「六關全過」但扣成本只剩 +0.03、格內只有 5 格 160 筆、2024 沒樣本 → ⛔ 不採用(唯一過的那格先看樣本,V74.3.8 的教訓)
 *   翻臉率五分位(A / B 各自):Q1→Q5 = −0.04/−0.01/−0.34/−0.10/+0.03 與 +0.25/−0.33/+0.16/+0.02/+0.37 → **兩邊都不單調**,
 *     最隔日沖那桶反而略好(同 broker_cross A 組的方向)→「排除隔日沖」⛔ 不是一條線能切的
 *   強度互控:佔量比三分位沒有型態(A:+0.04/−0.10/−0.19;B:+0.02/+0.26/+0.01)
 *   結論:❌ 實測沒用(LAB trap r:31)。跟 broker_skill B 組(神秘分點)、chips_deep_probe(集中度)一致;封口令維持。
 *
 * 跑法:CHIPS_DEEP_DIR=/tmp/cd/chips_deep node --max-old-space-size=6144 scripts/broker_burst_probe.mjs
 *       node scripts/broker_burst_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEEP_DIR = process.env.CHIPS_DEEP_DIR || path.join(ROOT, 'chips_deep');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const WARM = 250, DEDUP = 20, COST = 0.44, MIN_N = 200;
const GAP_A = [30, 60, 90], P_B = [90, 95, 99], MIN_HIST_B = 10, MIN_FLIP_N = 40;

const nf = (x, d = 2) => (x == null || !Number.isFinite(x)) ? '—' : x.toFixed(d);
const sg = (x) => (x == null || !Number.isFinite(x)) ? '' : (x >= 0 ? '+' : '');
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const pctile = (sorted, p) => { if (!sorted.length) return NaN; const k = (sorted.length - 1) * p / 100, f = Math.floor(k), c = Math.ceil(k); return f === c ? sorted[f] : sorted[f] + (sorted[c] - sorted[f]) * (k - f); };
const bisect = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };

export function loadDeep(dir = DEEP_DIR) {
    if (!fs.existsSync(dir)) { console.error(`❌ 找不到 ${dir}(取法:git archive origin/chips_deep | tar -x -C /tmp/cd)`); process.exit(1); }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();
    const days = [];
    for (const f of files) {
        try { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString('utf8')); if (j && j.d && j.s) days.push(j); } catch (e) { console.error(`   ⚠️ ${f}:${String(e.message).slice(0, 60)}`); }
    }
    days.sort((a, b) => a.d < b.d ? -1 : 1);
    return days;
}

export function loadPrices(syms, dataDir = DATA_DIR) {
    const px = new Map(); let miss = 0, cliff = 0;
    for (const sym of syms) {
        const p = path.join(dataDir, `${sym}.json`);
        if (!fs.existsSync(p)) { miss++; continue; }
        let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { miss++; continue; }
        if (!Array.isArray(rows)) { miss++; continue; }
        const o = { dates: [], close: [], high: [], low: [], open: [], vol: [] };
        for (const r of rows) {
            if (!r || r.close == null || !(+r.close > 0)) continue;
            o.dates.push(String(r.date).replace(/\//g, '-'));
            o.close.push(+r.close); o.high.push(+(r.high ?? r.close)); o.low.push(+(r.low ?? r.close)); o.open.push(+(r.open ?? r.close)); o.vol.push(+(r.volume || 0));
        }
        if (o.dates.length < WARM + 25) { miss++; continue; }
        let bad = false;
        for (let i = 1; i < o.close.length; i++) { const r = o.close[i] / o.close[i - 1]; if (r > 1.4 || r < 0.6) { bad = true; break; } }
        if (bad) { cliff++; continue; }      // 斷崖守門(同 short_probe)
        o.at = new Map(); o.dates.forEach((d, i) => o.at.set(d, i));
        px.set(sym, o);
    }
    return { px, miss, cliff };
}

export function loadIndex(dataDir = DATA_DIR) {
    const p = path.join(dataDir, '^TWII.json');
    if (!fs.existsSync(p)) return null;
    const m = new Map();
    for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) if (r && +r.close > 0) m.set(String(r.date).replace(/\//g, '-'), +r.close);
    return m;
}

/** 某檔某天的「t+1 開盤進場」報酬包;回 null = 不可交易 / 資料不夠 */
function fwd(o, i, idx) {
    if (i < WARM || i + 21 >= o.dates.length) return null;
    const c0 = o.close[i], o1 = o.open[i + 1];
    if (!(c0 > 0 && o1 > 0)) return null;
    if (o1 >= c0 * 1.0995 && o.high[i + 1] === o.low[i + 1]) return { lim: true };
    const b0 = idx.get(o.dates[i + 1]), b5 = idx.get(o.dates[i + 5]), b10 = idx.get(o.dates[i + 10]), b20 = idx.get(o.dates[i + 20]);
    if (!b0 || !b10) return null;
    const r10 = (o.close[i + 10] / o1 - 1) * 100;
    const e10 = r10 - (b10 / b0 - 1) * 100;
    const e5 = b5 ? (o.close[i + 5] / o1 - 1) * 100 - (b5 / b0 - 1) * 100 : NaN;
    const e20 = b20 ? (o.close[i + 20] / o1 - 1) * 100 - (b20 / b0 - 1) * 100 : NaN;
    let mn = Infinity, mx = -Infinity;
    for (let k = Math.max(0, i - 249); k <= i; k++) { const v = o.close[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const pos = mx > mn ? (c0 - mn) / (mx - mn) * 100 : 50;
    let sq = 0, sm = 0;
    for (let k = i - 19; k <= i; k++) { const r = Math.log(o.close[k] / o.close[k - 1]); sq += r * r; sm += r; }
    const vola = Math.sqrt(Math.max(0, sq / 20 - (sm / 20) ** 2)) * Math.sqrt(240) * 100;
    return { e5, e10, e20, r10, pos, vola, amt: c0 * o.vol[i], y: +o.dates[i].slice(0, 4) };
}

/** 事件收集(核心;selftest 也走這一支) */
export function collect(days, px, idx, { verbose = true } = {}) {
    const dnum = new Map(days.map((d, i) => [d.d, i]));
    const lastSeen = new Map();     // 'b|s' -> dn(最後一次出現在該股買方前 15)
    const hist = new Map();         // 'b|s' -> 過去淨買量(排序陣列,expanding)
    const expFlip = new Map();      // b -> {n,f}
    let pend = new Map(), cur = new Map();
    const ev = [];                  // {kind:'A'|'B', gap, pct, flip, share, sym, b, dn, ...fwd}
    const lastEvt = new Map();      // `${kind}|${sym}` -> dn(20 日去重,以檔)
    let nLim = 0;
    for (let dn = 0; dn < days.length; dn++) {
        const day = days[dn];
        // ① 翻臉率:先結算昨天掛著的買(今天有出現在賣方 = 翻臉);⭐ 順序:先結算再記今天(零前視)
        pend = cur; cur = new Map();
        for (const [sym, arr] of Object.entries(day.s)) for (const x of arr) { if ((+x[1] || 0) >= 0) continue; const st = pend.get(`${x[0]}|${sym}`); if (st) st.f = 1; }
        for (const [k, st] of pend) { const b = k.slice(0, k.indexOf('|')); let a = expFlip.get(b); if (!a) expFlip.set(b, a = { n: 0, f: 0 }); a.n++; if (st.f) a.f++; }
        // ② 今天的事件(判斷只用 lastSeen / hist / expFlip 的「到昨天為止」狀態)
        const todayBuys = [];
        for (const [sym, arr] of Object.entries(day.s)) {
            const o = px.get(sym); if (!o) continue;
            const i = o.at.get(day.d); if (i == null) continue;
            const vol = o.vol[i]; if (!(vol > 0)) continue;
            let f = null;
            for (const x of arr) {
                const net = +x[1] || 0; if (net <= 0) continue;
                const b = String(x[0]), key = `${b}|${sym}`;
                todayBuys.push([key, b, sym, net]);
                const ls = lastSeen.get(key);
                const gap = ls == null ? (dn >= GAP_A[2] ? 9999 : null) : dn - ls;   // 從沒出現過:窗口夠長才算「新面孔」
                const h = hist.get(key);
                const pct = (h && h.length >= MIN_HIST_B) ? bisect(h, net) / h.length * 100 : null;
                const kinds = [];
                if (gap != null && gap >= GAP_A[0]) kinds.push('A');
                if (pct != null && pct >= P_B[0]) kinds.push('B');
                if (!kinds.length) continue;
                if (f === null) f = fwd(o, i, idx);
                if (!f) continue;
                if (f.lim) { nLim++; continue; }
                const ef = expFlip.get(b);
                const flip = (ef && ef.n >= MIN_FLIP_N) ? ef.f / ef.n : null;
                for (const kind of kinds) {
                    const lk = `${kind}|${sym}`, pv = lastEvt.get(lk);
                    if (pv != null && dn - pv < DEDUP) continue;
                    lastEvt.set(lk, dn);
                    ev.push(Object.assign({ kind, gap, pct, flip, share: net / vol * 100, sym, b, dn, d: day.d }, f));
                }
            }
        }
        // ③ 走完今天才更新狀態(⛔ 不可先更新 —— 那就含當天)
        for (const [key, b, sym, net] of todayBuys) {
            lastSeen.set(key, dn);
            let h = hist.get(key); if (!h) hist.set(key, h = []);
            h.splice(bisect(h, net), 0, net);
            cur.set(key, { f: 0 });
        }
    }
    // 對照組:同一批股票 × 深歷史涵蓋的每一天(⛔ 不是全 K 線 —— 窗口要跟事件一致)
    const ctrl = [];
    const d0 = days[0].d, d1 = days[days.length - 1].d;
    for (const [sym, o] of px) {
        for (let i = 0; i < o.dates.length; i++) {
            const d = o.dates[i]; if (d < d0 || d > d1 || !dnum.has(d)) continue;
            const f = fwd(o, i, idx); if (!f || f.lim) continue;
            ctrl.push(Object.assign({ dn: dnum.get(d) }, f));
        }
    }
    if (verbose) console.log(`   ⚠️ t+1 一字漲停剔除 ${nLim} 個事件`);
    return { ev, ctrl };
}

/** 六關(對照 = ctrl 或另一群事件) */
function stats(E, ctrl, { base = null, years, LO, MID, HI, cells } = {}) {
    const g = E.length; if (g < MIN_N) return null;
    const B = base || ctrl;
    const m = a => mean(a.map(x => x.e10));
    const d10 = m(E) - m(B), d5 = mean(E.map(x => x.e5).filter(Number.isFinite)) - mean(B.map(x => x.e5).filter(Number.isFinite));
    const d20 = mean(E.map(x => x.e20).filter(Number.isFinite)) - mean(B.map(x => x.e20).filter(Number.isFinite));
    const w = E.filter(x => x.e10 > 0).length / g * 100, raw = mean(E.map(x => x.r10)), rawW = E.filter(x => x.r10 > 0).length / g * 100;
    const half = (a, b) => { const e = E.filter(x => x.dn >= a && x.dn < b), c = B.filter(x => x.dn >= a && x.dn < b); return (e.length < 60 || c.length < 100) ? NaN : m(e) - m(c); };
    const q1 = half(LO, MID), q2 = half(MID, HI);
    const yr = {};
    for (const y of years) { const e = E.filter(x => x.y === y), c = B.filter(x => x.y === y); yr[y] = (e.length > 40 && c.length > 100) ? m(e) - m(c) : NaN; }
    const fin = Object.entries(yr).filter(([, v]) => Number.isFinite(v));
    const bestY = fin.length ? +fin.reduce((a, b) => b[1] > a[1] ? b : a)[0] : null;
    const exBest = bestY != null ? (() => { const e = E.filter(x => x.y !== bestY), c = B.filter(x => x.y !== bestY); return e.length > 40 ? m(e) - m(c) : NaN; })() : NaN;
    let ws = 0, wn = 0, nc = 0;
    const byCell = new Map(); for (const x of B) { const k = cells(x); let a = byCell.get(k); if (!a) byCell.set(k, a = []); a.push(x.e10); }
    const eCell = new Map(); for (const x of E) { const k = cells(x); let a = eCell.get(k); if (!a) eCell.set(k, a = []); a.push(x.e10); }
    for (const [k, a] of eCell) { const c = byCell.get(k); if (!c || a.length < 20 || c.length < (base ? 50 : 200)) continue; ws += (mean(a) - mean(c)) * a.length; wn += a.length; nc++; }
    const dCell = wn ? ws / wn : NaN;
    const yv = fin.map(([, v]) => v);
    const same = Number.isFinite(q1) && Number.isFinite(q2) && (q1 > 0) === (q2 > 0);
    const pass = [d10 > 0, same, yv.length > 0 && yv.every(v => v > 0), Number.isFinite(exBest) && exBest > 0, d10 - COST > 0, Number.isFinite(dCell) && dCell > COST];
    return { n: g, d5, d10, d20, w, raw, rawW, q1, q2, yr, bestY, exBest, dCell, nc, wn, same, passed: pass.every(Boolean), gates: pass.filter(Boolean).length };
}

function show(name, r, cw, cRaw, cRawW, note = '對照全市場') {
    if (!r) { console.log(`─ ${name}:⏳ 樣本不足(需 ≥${MIN_N})\n`); return; }
    console.log(`─ ${name}  n=${r.n.toLocaleString()}(${note})`);
    console.log(`   5日 ${sg(r.d5)}${nf(r.d5)}pp ・10日 ${sg(r.d10)}${nf(r.d10)}pp ・20日 ${sg(r.d20)}${nf(r.d20)}pp ・勝率 ${nf(r.w, 1)}%(對照 ${nf(cw, 1)}%)・💰 絕對 10 日 ${sg(r.raw)}${nf(r.raw)}% / 賺錢機率 ${nf(r.rawW, 1)}%(對照 ${sg(cRaw)}${nf(cRaw)}% / ${nf(cRawW, 1)}%)`);
    console.log(`   前半 ${sg(r.q1)}${nf(r.q1)} / 後半 ${sg(r.q2)}${nf(r.q2)}${r.same ? '' : ' 🚨不同向'} ・逐年 ${Object.entries(r.yr).map(([y, v]) => `${y % 100}:${sg(v)}${nf(v, 1)}`).join(' ')}`);
    console.log(`   去最好年(${r.bestY}) ${sg(r.exBest)}${nf(r.exBest)} ・扣成本 ${sg(r.d10 - COST)}${nf(r.d10 - COST)} ・格內(${r.nc}格/${r.wn}筆) ${sg(r.dCell)}${nf(r.dCell)}`);
    console.log(`   ${r.passed ? '✅ 六關全過' : `❌ 沒過(${r.gates}/6)`}\n`);
}

export function analyse(ev, ctrl, days, idx) {
    if (ctrl.length < 5000) { console.log(`❌ 對照組只有 ${ctrl.length} 筆 —— 不下結論`); return; }
    const cw = ctrl.filter(x => x.e10 > 0).length / ctrl.length * 100, cRaw = mean(ctrl.map(x => x.r10)), cRawW = ctrl.filter(x => x.r10 > 0).length / ctrl.length * 100;
    console.log(`📊 對照組 ${ctrl.length.toLocaleString()} 個(股·日)・事件 ${ev.length.toLocaleString()} 筆(A 新面孔 ${ev.filter(x => x.kind === 'A').length.toLocaleString()} / B 自身爆量 ${ev.filter(x => x.kind === 'B').length.toLocaleString()})`);
    console.log(`🆚 對照組:10 日 ${nf(mean(ctrl.map(x => x.e10)))}% ・勝率 ${nf(cw, 1)}% ・💰 絕對 ${sg(cRaw)}${nf(cRaw)}% / ${nf(cRawW, 1)}%\n`);
    const dns = ctrl.map(x => x.dn).sort((a, b) => a - b);
    const LO = dns[0], MID = dns[dns.length >> 1], HI = dns[dns.length - 1] + 1;
    const years = [...new Set(ctrl.map(x => x.y))].sort();
    const ylab = years.map(y => { const ds = days.filter(d => +d.d.slice(0, 4) === y).map(d => d.d).filter(d => idx.has(d)); if (ds.length < 20) return `${y}:樣本太短`; const r = (idx.get(ds[ds.length - 1]) / idx.get(ds[0]) - 1) * 100; return `${y}:${sg(r)}${r.toFixed(1)}% ${r > 0 ? '▲多頭' : '▼空頭'}`; });
    console.log(`🗓️ 窗口 ${days[0].d} ~ ${days[days.length - 1].d} ・中點 ${days[MID].d} ・逐年 ${ylab.join(' ・')}\n   → ⚠️ chips_deep 從 2024-08-30 起,不含 2022 空頭\n`);
    const cut = (a) => { const s = [...a].sort((x, y) => x - y); return [pctile(s, 100 / 3), pctile(s, 200 / 3)]; };
    const cP = cut(ctrl.map(x => x.pos)), cV = cut(ctrl.map(x => x.vola)), cA = cut(ctrl.map(x => x.amt));
    const cells = x => ((x.pos > cP[1]) + (x.pos > cP[0])) * 9 + ((x.vola > cV[1]) + (x.vola > cV[0])) * 3 + ((x.amt > cA[1]) + (x.amt > cA[0]));
    const opt = { years, LO, MID, HI, cells };
    const S = (E, base) => stats(E, ctrl, Object.assign({ base }, opt));
    const out = [];

    console.log('📌 ① 「突然」兩種定義(⛔ 不分隔日沖)');
    const A = ev.filter(x => x.kind === 'A'), B = ev.filter(x => x.kind === 'B');
    show('A 新面孔(該分點 ≥60 天沒出現在該股買方前 15)', S(A.filter(x => x.gap >= 60)), cw, cRaw, cRawW);
    show('B 自身爆量(該分點在該股過去 ≥10 次的淨買量 ≥P95)', S(B.filter(x => x.pct >= 95)), cw, cRaw, cRawW);
    show('A ∧ B(新面孔而且一出手就是它自己的爆量)—— ⚠️ 新面孔通常沒有 10 次歷史,n 會很小', S(ev.filter(x => x.kind === 'B' && x.pct >= 95 && x.gap != null && x.gap >= 60)), cw, cRaw, cRawW);
    console.log('⛰️ ② 門檻高原:A 幾天沒出現 / B 自身分位');
    const plateau = [];
    for (const g of GAP_A) { const r = S(A.filter(x => x.gap >= g)); plateau.push([`A ≥${g}天`, r]); }
    for (const p of P_B) { const r = S(B.filter(x => x.pct >= p)); plateau.push([`B ≥P${p}`, r]); }
    console.log('   ' + plateau.map(([k, r]) => `${k} ${r ? sg(r.d10) + nf(r.d10) + 'pp(n=' + r.n.toLocaleString() + ',' + r.gates + '/6)' : '—'}`).join(' / ') + '\n');
    out.push(...plateau.map(([k, r]) => ({ name: k, r })));

    console.log('📌 ③ 隔日沖:按該券商 expanding 翻臉率**五分位**分桶(⛔ 不二分;「?」= 那家券商還沒累積 40 次紀錄)');
    for (const [lab, E] of [['A 新面孔 ≥60 天', A.filter(x => x.gap >= 60)], ['B 自身 ≥P95', B.filter(x => x.pct >= 95)]]) {
        const known = E.filter(x => x.flip != null).map(x => x.flip).sort((a, b) => a - b);
        if (known.length < MIN_N * 2) { console.log(`   ${lab}:翻臉率已知的事件不足\n`); continue; }
        const qs = [20, 40, 60, 80].map(p => pctile(known, p));
        console.log(`   ${lab}(翻臉率五分位切點 ${qs.map(q => (q * 100).toFixed(0) + '%').join(' / ')})`);
        const rows = [];
        for (let q = 0; q < 5; q++) {
            const lo = q === 0 ? -1 : qs[q - 1], hi = q === 4 ? 2 : qs[q];
            const Eq = E.filter(x => x.flip != null && x.flip > lo && x.flip <= hi);
            const r = S(Eq); rows.push(r);
            console.log(`     Q${q + 1}${q === 0 ? '(最不隔日沖)' : q === 4 ? '(最隔日沖)' : ''}:n=${Eq.length.toLocaleString()} ・10日 ${r ? sg(r.d10) + nf(r.d10) : '—'}pp ・勝率 ${r ? nf(r.w, 1) : '—'}% ・扣成本 ${r ? sg(r.d10 - COST) + nf(r.d10 - COST) : '—'} ・${r ? (r.passed ? '✅' : r.gates + '/6') : ''}`);
        }
        const unk = E.filter(x => x.flip == null); const ru = S(unk);
        console.log(`     ?(券商紀錄不足):n=${unk.length.toLocaleString()} ・10日 ${ru ? sg(ru.d10) + nf(ru.d10) : '—'}pp`);
        const ds = rows.map(r => r ? r.d10 : NaN);
        const mono = ds.every(Number.isFinite) && (ds.every((v, i) => i === 0 || v >= ds[i - 1]) || ds.every((v, i) => i === 0 || v <= ds[i - 1]));
        console.log(`     → ${mono ? '單調(翻臉率越' + (ds[4] > ds[0] ? '高越好 = 動能,同 broker_cross A 組 +2.11pp' : '低越好') + ')' : '不單調 → 「排除隔日沖」不是一條線能切的'}\n`);
        out.push({ name: `flipQ|${lab}`, rows: ds });
    }
    console.log('📌 ④ 強度互控:該分點淨買 ÷ 當日成交量(三分位)');
    for (const [lab, E] of [['A 新面孔 ≥60 天', A.filter(x => x.gap >= 60)], ['B 自身 ≥P95', B.filter(x => x.pct >= 95)]]) {
        if (E.length < MIN_N * 3) continue;
        const s = E.map(x => x.share).sort((a, b) => a - b); const t1 = pctile(s, 100 / 3), t2 = pctile(s, 200 / 3);
        for (const [k, Eq] of [['買得少', E.filter(x => x.share < t1)], ['中', E.filter(x => x.share >= t1 && x.share < t2)], ['買得多', E.filter(x => x.share >= t2)]]) {
            const r = S(Eq); console.log(`   ${lab} ${k}(佔量 ${k === '買得少' ? '<' + nf(t1, 1) : k === '買得多' ? '≥' + nf(t2, 1) : nf(t1, 1) + '~' + nf(t2, 1)}%):n=${Eq.length.toLocaleString()} ・10日 ${r ? sg(r.d10) + nf(r.d10) : '—'}pp ・勝率 ${r ? nf(r.w, 1) : '—'}%`);
        }
        console.log();
    }
    console.log('📎 既有對照:broker_skill B 組(神秘分點)六關 0 過 ・broker_cross A 組「隔日沖佔比高 +2.11pp」・chips_deep_probe 分點集中度無方向');
    console.log('⚠️ 限制:買賣只存前 15 → 翻臉率是下界、「沒出現」可能只是排第 16 ・窗口不含 2022 ・去重以檔 ・封口令:只進 LAB,⛔ 不衍生 App 功能');
    return out;
}

// ═══ selftest ═══════════════════════════════════════════════════
function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) fails.push(n); };
    const NB = 400; const dates = []; let d = new Date(Date.UTC(2024, 0, 2));
    while (dates.length < NB) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    const idx = new Map(dates.map((x, i) => [x, 20000 + i]));
    const mkPx = (limAt = null) => { const o = { dates: [], close: [], high: [], low: [], open: [], vol: [] }; let c = 100; for (let i = 0; i < NB; i++) { c *= 1 + ((i * 7919) % 13 - 6) / 1000; let op = c * 1.001, h = c * 1.006, l = c * 0.994; if (i === limAt) { op = h = l = c = o.close[i - 1] * 1.1; } o.dates.push(dates[i]); o.close.push(c); o.open.push(op); o.high.push(h); o.low.push(l); o.vol.push(1e6); } o.at = new Map(o.dates.map((x, i) => [x, i])); return o; };
    const px = new Map([['1001', mkPx()], ['1002', mkPx(341)]]);
    // 分點劇本(全部在 ≥250 之後):X 每天都在 1001 買 1,000 股(累積歷史)→ 第 320 天買 50,000(自身 P95)→ 第 360 天再買 50,000(20 日外,第二次)
    //   Y 第 260 天在 1001 買過一次 → 第 330 天再出現(隔 70 天 = 新面孔)→ 第 345 天再出現(隔 15 天 ⛔ 不是新面孔)
    //   Z 每天在 1001 買 2,000、隔天賣(翻臉率 ~100%);第 320 天也大買
    //   1002:X 第 340 天大買但 t+1 一字漲停 → 剔除
    const days = dates.map((dd, i) => {
        const s = { '1001': [], '1002': [] };
        // X:第 251~260 天各買 1,000(剛好 10 次歷史)→ 第 300 天買 1,500(⭐ 只比歷史全部大一點:含當天算 pct 會變 90.9% 就不亮 → 抓「pct 含當天」的前視)
        //    → 第 320 / 360 天各買 50,000
        if ((i >= 251 && i <= 260) || i === 300 || i === 320 || i === 360) s['1001'].push(['X', i === 360 ? 60000 : (i === 320 ? 50000 : (i === 300 ? 1500 : 1000)), 100]);   // 360 要比 320 大(同值 bisect 會排在它前面 → 11/12 = 91.7 就不亮)
        if (i === 260 || i === 330 || i === 345) s['1001'].push(['Y', 3000, 100]);
        if (i >= 251) { s['1001'].push(['Z', 2000, 100]); if (i > 251) s['1001'].push(['Z', -2000, 100]); }
        if (i === 340) s['1002'].push(['X', 9000, 100]);
        if (i >= 251 && i < 340) s['1002'].push(['X', 100, 100]);   // 1002 上的 X 歷史
        return { d: dd, n: 2, k: 15, s };
    });
    const { ev, ctrl } = collect(days, px, idx, { verbose: false });
    const A = ev.filter(x => x.kind === 'A'), B = ev.filter(x => x.kind === 'B');
    ok('⓪ 空過守門:對照組有東西', ctrl.length > 200, String(ctrl.length));
    ok('① B 自身爆量:X 在 1001 第 300(1,500 > 過去 10 次全部 = P100)、320、360 天各一次(pct ≥95;⭐ 300 那筆 pct 若把當天算進去會掉到 90.9 就不亮)', B.filter(x => x.b === 'X' && x.sym === '1001').map(x => x.dn).join() === '300,320,360' && B.filter(x => x.b === 'X' && x.sym === '1001').every(x => x.pct >= 95), JSON.stringify(B.map(x => [x.b, x.sym, x.dn, x.pct])));
    // ⚠️ 第 260 天 Y「從沒出現過」本來也算新面孔,但第 251 天 X/Z 第一次出現已經佔了 1001 那 20 天的名額(去重以檔)→ 被去重掉,這是對的
    ok('② A 新面孔:Y 第 330 天(隔 70 天)算、第 345 天(隔 15 天)⛔ 不算;第 260 天被 251 天那筆(同檔 20 日內)去重掉;X 第 300 天隔 40 天也是 A', A.filter(x => x.b === 'Y').map(x => x.dn).join() === '330' && A.some(x => x.dn === 251 && x.sym === '1001') && A.some(x => x.b === 'X' && x.dn === 300 && x.gap === 40), JSON.stringify(A.map(x => [x.b, x.dn, x.gap])));
    ok('③ 去重以「檔」:第 320 天 X 與 Z 都在 1001 觸發 B → 只留一筆(⛔ 檔×分點會灌 n)', B.filter(x => x.dn === 320 && x.sym === '1001').length === 1, JSON.stringify(B.filter(x => x.dn === 320).map(x => x.b)));
    ok('④ t+1 一字漲停剔除:1002 第 340 天 X 大買不成事件', !ev.some(x => x.sym === '1002' && x.dn === 340), JSON.stringify(ev.filter(x => x.sym === '1002').map(x => x.dn)));
    const zf = ev.find(x => x.b === 'Z');
    ok('⑤ 翻臉率是 expanding、零前視:Z 天天買了隔天賣 → 翻臉率 ≈ 1;X 從不賣 → 0', ev.filter(x => x.b === 'X' && x.flip != null).every(x => x.flip === 0) && (!zf || zf.flip == null || zf.flip > 0.9), JSON.stringify(ev.map(x => [x.b, x.dn, x.flip])));
    // 決定性對照:改第 330 天**之後**的資料,前面的事件一個都不可變
    const days2 = days.map((dd, i) => i > 330 ? { ...dd, s: { '1001': [['X', 999999, 100], ['Y', 999999, 100]], '1002': [] } } : dd);
    const ev2 = collect(days2, px, idx, { verbose: false }).ev;
    const key = e => e.filter(x => x.dn <= 330).map(x => `${x.kind}|${x.sym}|${x.b}|${x.dn}|${nf(x.pct, 1)}|${x.gap}`).sort().join(';');
    ok('⑥ 零前視:改第 330 天之後的分點資料,≤330 的事件(含 pct / gap)一個都不變', key(ev) === key(ev2), `${key(ev).slice(0, 120)} vs ${key(ev2).slice(0, 120)}`);
    console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條失敗:' + fails.join(' / ') : '✅ selftest 全過'}`);
    return fails.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    if (SELFTEST) process.exit(selftest());
    const days = loadDeep();
    console.log(`📂 chips_deep ${days.length} 天(${days[0].d} ~ ${days[days.length - 1].d})`);
    const syms = new Set(); for (const dday of days) for (const s of Object.keys(dday.s)) if (/^\d{4}$/.test(s)) syms.add(s);
    const { px, miss, cliff } = loadPrices(syms);
    console.log(`   K 線 ${px.size} 檔(缺/太短 ${miss} ・斷崖剔除 ${cliff};⛔ 只掃 4 碼個股)`);
    const idx = loadIndex(); if (!idx) { console.error('❌ 沒有 ^TWII.json'); process.exit(1); }
    const { ev, ctrl } = collect(days, px, idx);
    analyse(ev, ctrl, days, idx);
}
