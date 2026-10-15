#!/usr/bin/env node
/**
 * 🌅🐻 盤前體檢「極度偏空」那天:什麼股票比較會漲?開盤 / 09:05 / 隔天開盤哪種做法可行?(V79.3.0)
 *
 * 使用者 2026-10-15:盤前體檢 0/100 → 「遇到 0 分這種情形,什麼股票漲的機率比較大,
 *   開盤或 5 分鐘後進場當沖、或隔天開盤就賣,可行嗎?」
 *
 * ⚠️ 先講限制(⛔ 每次輸出都會印):
 *   ・App 的「0 分」有一半成分(外資台指期 / 夜盤 / 法人 / 大盤技術分…)**沒有歷史** → 0 分本身回測不了。
 *     能重建的只有海外 8 項(`premkt_probe.py` STRICT,T−1 海外收盤 → T 日台股,零前視),那 8 項最差也只到 5 分。
 *     → 用「海外那一半也極度偏空」當代理:重建分數 ≤10 / ≤15 / ≤20 三種門檻(看是不是高原),每格印天數。
 *   ・大盤層級早就測過(premkt_probe:偏空 ≤35 那天加權開盤買收盤賣 −0.33%)→ 這支只問「個股」。
 *
 * 量什麼:
 *   Q1 什麼股票比較會漲(只用開盤前就知道的事分組):上市/上櫃 ・成交額五分位 ・對加權的 β(過去 120 天,不含當天)
 *      ・一年位階 ・近 20 日漲幅 ・昨天漲跌 ・開盤跳空 ・產業 ・0050 / 00632R(反向)
 *      ⭐ 兩個數字:①比同一天全部股票多多少(增量)②**跟平常日子比**多了多少(雙重差分)
 *        —— 低 β 在大盤跌的日子相對強是數學必然,⛔ 那不是發現;只有雙重差分顯著的才算「這種日子特別」。
 *   Q2 怎麼進出(扣成本:當沖 0.25%、隔夜 0.44%;開盤鎖漲停買不到 / 鎖跌停空不到剔除):
 *      A 開盤買→收盤賣 ・C 開盤買→隔天開盤賣 ・E1 收盤買→隔天開盤賣 ・E2 收盤買→隔天收盤賣 ・F 開盤空→收盤補
 *      B 09:05 買→13:25 賣 ・D 09:05 買→隔天開盤賣(這兩個用 5 分 K,母體 = 熱門股;⛔ 價格只用 5 分 K,不混日 K)
 *   每格:天數 / 每天平均 / 賺的天 % / 前後半 / 逐年 / 拿掉最好 10 天 / 扣成本 / 安慰劑(同天數隨機日子,固定種子)
 *
 * 跑法:
 *   DATA_DIR=$S/d10n KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5 PREMKT_SCORES=$S/premkt_scores.txt \
 *   NAMES=$S/od/data/stock_names.json IND_MAP=$S/od/data/industry_map.json \
 *   node --max-old-space-size=10000 scripts/bearday_probe.mjs out.json
 *   node scripts/bearday_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pTwo } from './lib_evgate.mjs';
import { loadKbar5 } from './dt_kbar5_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COST_DT = 0.25, COST_ON = 0.44;
export const TH = [10, 15, 20];          // App 顯示分數(0~100)門檻
export const appScore = s => Math.max(0, Math.min(100, 50 + s * 5));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const tstat = a => { if (a.length < 3) return 0; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : 0; };
const welchT = (a, b) => { if (a.length < 3 || b.length < 3) return 0; const ma = mean(a), mb = mean(b);
    const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
    const se = Math.sqrt(va / a.length + vb / b.length); return se > 0 ? (ma - mb) / se : 0; };

/** SCORES|d:v,... → {date('YYYY-MM-DD') → 內部分數(±10)} */
export function parseScores(txt) {
    const m = {};
    for (const l of String(txt).split('\n')) { if (!l.startsWith('SCORES|')) continue;
        for (const p of l.slice(7).split(',')) { const [d, v] = p.split(':'); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v !== '' && Number.isFinite(+v)) m[d] = +v; } }
    return m;
}

/** 開盤前就知道的特徵(⛔ 一律只用 i−1 以前):回 null = 資料不夠 */
export function feats(R, i, idxC, idxIdx) {
    if (i < 121) return null;
    const pc = R[i - 1].c; if (!(pc > 0)) return null;
    let tv = 0; for (let k = i - 20; k < i; k++) tv += R[k].c * R[k].v; tv /= 20;
    // β:過去 120 天(i−120 … i−1)日報酬對加權日報酬;⛔ 不含當天
    const xs = [], ys = [];
    for (let k = i - 120; k < i; k++) { const a = idxIdx.get(R[k].d), b = idxIdx.get(R[k - 1].d);
        if (a == null || b == null || !(R[k - 1].c > 0)) continue; xs.push(idxC[a] / idxC[b] - 1); ys.push(R[k].c / R[k - 1].c - 1); }
    let beta = null;
    if (xs.length >= 80) { const mx = mean(xs), my = mean(ys); let cv = 0, vx = 0; for (let k = 0; k < xs.length; k++) { cv += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; } beta = vx > 0 ? cv / vx : null; }
    let hi = -Infinity, lo = Infinity; for (let k = Math.max(0, i - 252); k < i; k++) { hi = Math.max(hi, R[k].h); lo = Math.min(lo, R[k].l); }
    const pos = hi > lo ? (pc - lo) / (hi - lo) * 100 : null;
    const r20 = R[i - 21].c > 0 ? (pc / R[i - 21].c - 1) * 100 : null;
    const yd = R[i - 2].c > 0 ? (pc / R[i - 2].c - 1) * 100 : null;
    const gap = (R[i].o / pc - 1) * 100;      // ⭐ 09:00 開盤就知道 → 可以用來決定 A/C 要不要買
    return { pc, tv, beta, pos, r20, yd, gap };
}

/** 一檔一天的報酬(%,未扣成本)。開盤鎖漲停 → 不能買(多方那幾種 null);開盤鎖跌停 → 不能空。 */
export function rets(R, i) {
    const pc = R[i - 1].c, o = R[i].o, c = R[i].c, n = R[i + 1];
    const upLock = o >= pc * 1.095 && R[i].h <= o * 1.0001, dnLock = o <= pc * 0.905 && R[i].l >= o * 0.9999;
    const out = {};
    if (!upLock) { out.A = (c / o - 1) * 100; if (n && n.o > 0) out.C = (n.o / o - 1) * 100; }
    if (!dnLock) out.F = (1 - c / o) * 100;
    const cLock = c >= pc * 1.095 && R[i].h <= c * 1.0001;           // 收盤鎖漲停 → 收盤買不到
    if (!cLock && n && n.o > 0) { out.E1 = (n.o / c - 1) * 100; if (n.c > 0) out.E2 = (n.c / c - 1) * 100; }
    return out;
}

const q5 = (v, cuts) => v == null ? null : cuts.findIndex(x => v <= x) < 0 ? 4 : cuts.findIndex(x => v <= x);
export function groupKeys(f, mkt, ind, sym, liqQ, betaQ) {
    const g = ['全部股票'];
    if (mkt) g.push(mkt === 'twse' ? '上市' : mkt === 'tpex' ? '上櫃' : '興櫃');
    if (liqQ != null) g.push(`成交額 Q${liqQ + 1}${liqQ === 0 ? '(最小)' : liqQ === 4 ? '(最大)' : ''}`);
    if (betaQ != null) g.push(`β Q${betaQ + 1}${betaQ === 0 ? '(最不跟大盤)' : betaQ === 4 ? '(最跟大盤)' : ''}`);
    if (f.pos != null) g.push(f.pos < 25 ? '一年位階 <25%' : f.pos < 50 ? '一年位階 25~50%' : f.pos < 75 ? '一年位階 50~75%' : '一年位階 ≥75%');
    if (f.r20 != null) g.push(f.r20 <= -10 ? '近20日 ≤−10%' : f.r20 <= 0 ? '近20日 −10~0%' : f.r20 <= 10 ? '近20日 0~+10%' : f.r20 <= 25 ? '近20日 +10~25%' : '近20日 >+25%');
    if (f.yd != null) g.push(f.yd <= -3 ? '昨天 ≤−3%' : f.yd < 0 ? '昨天 −3~0%' : f.yd < 3 ? '昨天 0~+3%' : '昨天 ≥+3%');
    g.push(f.gap <= -3 ? '開盤 ≤−3%' : f.gap <= -1 ? '開盤 −3~−1%' : f.gap < 1 ? '開盤 ±1%' : f.gap < 3 ? '開盤 +1~3%' : '開盤 ≥+3%');
    if (ind) g.push('產業・' + ind);
    if (sym === '0050' || sym === '00632R') g.push('ETF・' + sym);
    return g;
}

/** 每日聚合 → 給定日子集合的「增量」(群組平均 − 同一天全部股票平均),每天先平均。 */
export function incOver(agg, days, g, e, minN = 3) {
    const out = [];
    for (const d of days) { const a = agg.get(d); if (!a) continue; const x = a.get(g + '|' + e), b = a.get('全部股票|' + e);
        if (!x || !b || x[1] < minN || !b[1]) continue; out.push({ d, v: x[0] / x[1] - b[0] / b[1], abs: x[0] / x[1] }); }
    return out;
}

/** 固定種子亂數(安慰劑要每次一樣) */
export function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const sgn = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
function summarize(rows, split) {          // rows: [{d, v}] 每天一個值
    const a = rows.map(r => r.v); const m = mean(a), t = tstat(a);
    const h = [mean(rows.filter(r => r.d < split).map(r => r.v)), mean(rows.filter(r => r.d >= split).map(r => r.v))];
    const ys = {}; for (const r of rows) (ys[r.d.slice(0, 4)] = ys[r.d.slice(0, 4)] || []).push(r.v);
    const yr = Object.fromEntries(Object.entries(ys).filter(([, x]) => x.length >= 4).map(([y, x]) => [y, mean(x)]));
    const top = new Set([...rows].sort((x, y) => y.v - x.v).slice(0, 10).map(r => r.d));
    const drop10 = mean(rows.filter(r => !top.has(r.d)).map(r => r.v));
    return { n: a.length, m, p: pTwo(t), win: a.filter(x => x > 0).length / (a.length || 1) * 100, h, yr, drop10 };
}

// ─────────────────────────────── main ───────────────────────────────
function loadDaily(dir, sym) {
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, sym + '.json'), 'utf8'));
        return r.map(x => ({ d: x.date.replace(/\//g, '-'), o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume || 0 })).filter(x => x.o > 0 && x.c > 0 && x.h > 0 && x.l > 0);
    } catch { return null; }
}

function main() {
    const DATA = process.env.DATA_DIR, SC = process.env.PREMKT_SCORES;
    if (!DATA || !SC) { console.error('❌ 要 DATA_DIR 與 PREMKT_SCORES'); process.exit(1); }
    const scores = parseScores(fs.readFileSync(SC, 'utf8'));
    const sDays = Object.keys(scores).sort();
    if (sDays.length < 500) { console.error(`❌ 分數只有 ${sDays.length} 天(<500)→ 不下結論`); process.exit(1); }
    const NM = process.env.NAMES ? JSON.parse(fs.readFileSync(process.env.NAMES, 'utf8')).names || {} : {};
    const IM = process.env.IND_MAP ? JSON.parse(fs.readFileSync(process.env.IND_MAP, 'utf8')) : {};
    const INDN = {}; { const t = fs.readFileSync(path.join(ROOT, 'screener_miner.py'), 'utf8'); const blk = t.slice(t.indexOf('IND = {'), t.indexOf('}', t.indexOf('IND = {')));
        for (const m of blk.matchAll(/'(\d{2})':\s*'([^']+)'/g)) INDN[m[1]] = m[2]; }
    const IDX = loadDaily(DATA, '^TWII'); const idxC = IDX.map(x => x.c), idxIdx = new Map(IDX.map((x, k) => [x.d, k]));
    const eventSet = th => new Set(sDays.filter(d => appScore(scores[d]) <= th));
    console.log('🌅🐻 盤前體檢極度偏空日 × 個股 回測');
    console.log('⚠️ 0 分本身回測不了:App 有一半成分沒有歷史;這裡用「海外那一半」重建的分數當代理(最差 5 分)。');
    for (const th of [...TH, 35]) console.log(`   重建分數 ≤${th}:${eventSet(th).size} 天`);

    // ── 第 1 段:日 K 全市場 ──
    const files = fs.readdirSync(DATA).filter(f => /^(\d{4}|0050|00632R)\.json$/.test(f));
    const agg = new Map();            // d → Map(g|e → [sum, n])
    const add = (d, g, e, r) => { let a = agg.get(d); if (!a) { a = new Map(); agg.set(d, a); } const x = a.get(g + '|' + e) || [0, 0]; x[0] += r; x[1]++; a.set(g + '|' + e, x); };
    // 先算每天每檔特徵,才知道當天的五分位(⛔ 五分位是同一天橫斷面,不看別天)
    const daily = new Map();          // d → [{sym, f, r, mkt, ind}]
    const sSet = new Set(sDays);
    let nStk = 0;
    for (const f of files) { const sym = f.replace('.json', ''); const R = loadDaily(DATA, sym); if (!R || R.length < 150) continue; nStk++;
        const nm = NM[sym]; const mkt = nm && nm[2]; if (mkt === 'emerging') continue;      // 興櫃沒有漲跌幅、成交稀 → 排除
        const ic = IM[sym] || (nm && nm[1]); const ind = /^\d/.test(sym) && sym[0] !== '0' ? (INDN[ic] || null) : null;
        for (let i = 121; i < R.length; i++) { const d = R[i].d; if (!sSet.has(d)) continue;
            const ft = feats(R, i, idxC, idxIdx); if (!ft) continue;
            if (Math.abs(ft.gap) > 11) continue;   // 尺標斷崖(分割 / 還原價接縫)→ 不算
            const rr = rets(R, i);
            let a = daily.get(d); if (!a) { a = []; daily.set(d, a); } a.push({ sym, f: ft, r: rr, mkt, ind }); } }
    for (const [d, arr] of daily) {
        const stocks = arr.filter(x => /^[1-9]/.test(x.sym));
        const cut = (key) => { const v = stocks.map(x => x.f[key]).filter(x => x != null).sort((a, b) => a - b); return [0.2, 0.4, 0.6, 0.8].map(q => v[Math.floor(q * (v.length - 1))]); };
        const lc = cut('tv'), bc = cut('beta');
        for (const x of arr) { const isS = /^[1-9]/.test(x.sym);
            const gs = isS ? groupKeys(x.f, x.mkt, x.ind, x.sym, x.f.tv > 0 ? q5(x.f.tv, lc) : null, q5(x.f.beta, bc)) : groupKeys(x.f, null, null, x.sym, null, null).filter(g => g.startsWith('ETF'));
            for (const g of gs) for (const [e, v] of Object.entries(x.r)) add(d, g, e, v); } }
    const allDays = [...agg.keys()].sort(); const split = allDays[allDays.length >> 1];
    console.log(`📊 日 K:${nStk} 檔 ・${allDays.length} 個有分數的交易日(${allDays[0]} ~ ${allDays.at(-1)})`);

    const out = { at: new Date().toISOString(), days: allDays.length, window: [allDays[0], allDays.at(-1)], th: {}, hot: {} };
    const ENT = { A: ['A 開盤買→收盤賣', COST_DT], C: ['C 開盤買→隔天開盤賣', COST_ON], E1: ['E1 收盤買→隔天開盤賣', COST_ON], E2: ['E2 收盤買→隔天收盤賣', COST_ON], F: ['F 開盤空→收盤補', COST_DT] };
    const allG = new Set(); for (const a of agg.values()) for (const k of a.keys()) allG.add(k.split('|')[0]);
    const R0 = rng(20261015);
    for (const th of TH) {
        const ev = eventSet(th), evD = allDays.filter(d => ev.has(d)), nmD = allDays.filter(d => !ev.has(d));
        console.log(`\n══════════ 重建分數 ≤${th}(${evD.length} 天;平常日子 ${nmD.length} 天)══════════`);
        const T = out.th[th] = { days: evD.length, abs: {}, groups: [] };
        // ① 絕對:全部股票平均(每天先平均)扣成本
        console.log('  ① 全部股票照做(每天先平均,扣成本)— 對照 = 平常日子');
        for (const [e, [lab, cost]] of Object.entries(ENT)) {
            const rowsE = incOver(agg, evD, '全部股票', e).map(r => ({ d: r.d, v: r.abs - cost }));
            const rowsN = incOver(agg, nmD, '全部股票', e).map(r => ({ d: r.d, v: r.abs - cost }));
            const s = summarize(rowsE, split), sN = mean(rowsN.map(r => r.v));
            T.abs[e] = { ...s, normal: sN };
            console.log(`    ${lab.padEnd(18)} 極空日 ${sgn(s.m)}%(賺的天 ${s.win.toFixed(0)}%)・平常 ${sgn(sN)}% ・前後半 ${sgn(s.h[0])}/${sgn(s.h[1])} ・逐年 ${Object.entries(s.yr).map(([y, v]) => y.slice(2) + ':' + sgn(v)).join(' ')} ・去最好10天 ${sgn(s.drop10)}`);
        }
        // ② 分組:增量 + 雙重差分 + 安慰劑
        const res = [];
        for (const g of allG) { if (g === '全部股票') continue;
            for (const e of ['A', 'C', 'E1']) {
                const iE = incOver(agg, evD, g, e), iN = incOver(agg, nmD, g, e);
                if (iE.length < Math.max(10, evD.length * 0.5)) continue;
                const sE = summarize(iE.map(r => ({ d: r.d, v: r.v })), split), mN = mean(iN.map(r => r.v));
                const did = sE.m - mN, tD = welchT(iE.map(r => r.v), iN.map(r => r.v)), pD = pTwo(tD);
                const absE = summarize(iE.map(r => ({ d: r.d, v: r.abs - ENT[e][1] })), split);
                // 安慰劑:從平常日子抽同樣天數 200 次 → 增量 ≥ 實際的比例
                const pool = iN.map(r => r.v); let ge = 0; const K = 200;
                for (let k = 0; k < K; k++) { let s = 0; for (let j = 0; j < iE.length; j++) s += pool[Math.floor(R0() * pool.length)]; if (s / iE.length >= sE.m) ge++; }
                res.push({ g, e, n: iE.length, inc: sE.m, incP: sE.p, normal: mN, did, pD, sham: ge / K, abs: absE.m, absWin: absE.win, h: sE.h, yr: sE.yr, drop10: sE.drop10, absH: absE.h, absYr: absE.yr });
            } }
        // 印:依雙重差分排序,前 12 + 後 5
        const show = (r) => `    ${(r.g + ' ・' + r.e).padEnd(26)} 天${String(r.n).padStart(4)} ・比同天全部 ${sgn(r.inc)}pp(平常 ${sgn(r.normal)})・特別多 ${sgn(r.did)}pp p=${r.pD.toFixed(3)} 安慰劑 ${(r.sham * 100).toFixed(0)}% ・絕對扣成本 ${sgn(r.abs)}%(賺的天 ${r.absWin.toFixed(0)}%)・前後半 ${sgn(r.h[0])}/${sgn(r.h[1])}`;
        const sorted = res.filter(r => r.e === 'A').sort((a, b) => b.inc - a.inc);
        console.log('  ② A 開盤買→收盤賣:比同一天其他股票強的組(前 10)');
        sorted.slice(0, 10).forEach(r => console.log(show(r)));
        console.log('  ②b 比同一天其他股票弱的組(後 5)'); sorted.slice(-5).forEach(r => console.log(show(r)));
        const sig = res.filter(r => r.pD <= 0.05 && r.did > 0 && r.h.every(x => x > 0)).sort((a, b) => b.did - a.did);
        console.log(`  ③ 「這種日子特別強」(雙重差分 >0、p≤0.05、前後半都比同天強):${sig.length} 組`);
        sig.slice(0, 12).forEach(r => console.log(show(r)));
        const absOk = res.filter(r => r.abs > 0 && r.absH.every(x => x > 0)).sort((a, b) => b.abs - a.abs);
        console.log(`  ④ 「扣完成本絕對賺錢」且前後半都賺的組:${absOk.length} 組`);
        absOk.slice(0, 10).forEach(r => console.log(show(r) + ` ・逐年 ${Object.entries(r.absYr).map(([y, v]) => y.slice(2) + ':' + sgn(v)).join(' ')}`));
        T.groups = res;
    }

    // ── 第 2 段:5 分 K 熱門股 09:05 進場 ──
    if (process.env.KBAR5_DIR) {
        const { days, bias } = loadKbar5(process.env.KBAR5_DIR);
        const kd = Object.keys(days).sort();
        console.log(`\n══════════ 5 分 K 熱門股(${kd.length} 天,${kd[0]} ~ ${kd.at(-1)};⚠️ ${bias || '母體 = 當天熱門股'})══════════`);
        const per = new Map();   // d → {B:[...], D:[...], A5:[...]}
        let prevClose = {};
        for (let di = 0; di < kd.length; di++) { const d = kd[di], K = days[d].k || {}, next = days[kd[di + 1]];
            const pcNow = {};
            const o = { A5: [], B: [], D: [], Bgap: {} };
            for (const [sym, raw] of Object.entries(K)) { if (/^0/.test(sym)) continue;
                const all = raw.filter(b => b[0] >= 540 && b[0] <= 810), bars = all.filter(b => b[0] <= 805);
                const c810 = all.find(b => b[0] === 810); if (c810) pcNow[sym] = c810[4];
                if (bars.length < 40 || bars[0][0] !== 540) continue;
                const pc = prevClose[sym]; if (!(pc > 0)) continue;      // ⛔ 昨收只用昨天的 5 分 K(陷阱 #46)
                const op = bars[0][1], c905 = bars[0][4], cEx = bars[bars.length - 1][4];
                if (op >= pc * 1.095 || op <= pc * 0.905) continue;     // 開盤就鎖住 → 不算
                const gap = (op / pc - 1) * 100; if (Math.abs(gap) > 11) continue;
                o.A5.push((cEx / op - 1) * 100); const b = (cEx / c905 - 1) * 100; o.B.push(b);
                const gk = gap <= -3 ? '≤−3%' : gap <= -1 ? '−3~−1%' : gap < 1 ? '±1%' : gap < 3 ? '+1~3%' : '≥+3%'; (o.Bgap[gk] = o.Bgap[gk] || []).push(b);
                const nb = next && next.k && next.k[sym] && next.k[sym].find(x => x[0] === 540);
                if (nb && nb[1] > 0) o.D.push((nb[1] / c905 - 1) * 100); }
            prevClose = pcNow;
            if (o.B.length >= 10) per.set(d, o); }
        const hd = [...per.keys()].sort(), hsplit = hd[hd.length >> 1];
        for (const th of TH) { const ev = eventSet(th), evD = hd.filter(d => ev.has(d)), nmD = hd.filter(d => !ev.has(d) && scores[d] != null);
            const H = out.hot[th] = { days: evD.length };
            console.log(`  ── ≤${th}:${evD.length} 天(平常 ${nmD.length} 天)`);
            for (const [k, lab, cost] of [['A5', 'A 開盤買→13:25 賣', COST_DT], ['B', 'B 09:05 買→13:25 賣', COST_DT], ['D', 'D 09:05 買→隔天開盤賣', COST_ON]]) {
                const rowsE = evD.filter(d => per.get(d)[k].length >= 10).map(d => ({ d, v: mean(per.get(d)[k]) - cost }));
                const rowsN = nmD.filter(d => per.get(d)[k].length >= 10).map(d => ({ d, v: mean(per.get(d)[k]) - cost }));
                const s = summarize(rowsE, hsplit); H[k] = { ...s, normal: mean(rowsN.map(r => r.v)) };
                console.log(`    ${lab.padEnd(18)} 極空日 ${sgn(s.m)}%(賺的天 ${s.win.toFixed(0)}%)・平常 ${sgn(H[k].normal)}% ・前後半 ${sgn(s.h[0])}/${sgn(s.h[1])} ・逐年 ${Object.entries(s.yr).map(([y, v]) => y.slice(2) + ':' + sgn(v)).join(' ')} ・去最好10天 ${sgn(s.drop10)}`); }
            H.gap = {};
            for (const gk of ['≤−3%', '−3~−1%', '±1%', '+1~3%', '≥+3%']) {
                const rowsE = evD.map(d => per.get(d).Bgap[gk]).filter(a => a && a.length >= 3).map(a => mean(a) - COST_DT);
                const rowsN = nmD.map(d => per.get(d).Bgap[gk]).filter(a => a && a.length >= 3).map(a => mean(a) - COST_DT);
                H.gap[gk] = { n: rowsE.length, m: mean(rowsE), normal: mean(rowsN) };
                console.log(`      B × 開盤 ${gk.padEnd(7)} 天${String(rowsE.length).padStart(4)} ・極空日 ${sgn(mean(rowsE))}% ・平常 ${sgn(mean(rowsN))}%`); } }
    }
    const OUT = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
}

// ─────────────────────────────── selftest ───────────────────────────────
function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fail++; };
    // ⓪ 分數解析:垃圾行 / 不像日期的鍵不收
    const sc = parseScores('xx\nSCORES|2026-10-13:-7.00,2026-10-14:-4.00,bad:1\nSCORES|2026-10-15:\n');
    ok('⓪ 分數解析只收合法日期', Object.keys(sc).join() === '2026-10-13,2026-10-14' && sc['2026-10-13'] === -7);
    ok('⓪b App 分數 = 50 + 5s、夾 0~100', appScore(-9) === 5 && appScore(-12) === 0 && appScore(0) === 50);
    // 合成 K 線
    const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const days = mk(300, i => `2025-${String(1 + (i / 28 | 0)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`);
    const idx = days.map((d, i) => ({ d, c: 100 * (1 + 0.01 * Math.sin(i)) }));
    const idxC = idx.map(x => x.c), idxIdx = new Map(idx.map((x, k) => [x.d, k]));
    const stk = days.map((d, i) => { const c = 50 * idxC[i] / 100; return { d, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }; });
    // ① β 不含當天:把第 i 天的收盤亂改,β 不能變
    const f1 = feats(stk, 200, idxC, idxIdx); const s2 = stk.map(x => ({ ...x })); s2[200].c *= 1.5; s2[200].o *= 1.5;
    const f2 = feats(s2, 200, idxC, idxIdx);
    ok('① β 窗口不含當天', Math.abs(f1.beta - f2.beta) < 1e-12 && Math.abs(f1.beta - 1) < 0.05, `${f1.beta} vs ${f2.beta}`);
    // ①b 注入:改第 i−1 天 → β 要變(證明窗口有算到昨天)
    const s3 = stk.map(x => ({ ...x })); s3[199].c *= 1.2; const f3 = feats(s3, 200, idxC, idxIdx);
    ok('①b β 有算到昨天(改昨天會變)', Math.abs(f3.beta - f1.beta) > 1e-3);
    ok('①c 成交額只用前 20 天(改當天量不變)', (() => { const s4 = stk.map(x => ({ ...x })); s4[200].v = 1e9; return feats(s4, 200, idxC, idxIdx).tv === f1.tv; })());
    // ② 開盤鎖漲停買不到 / 鎖跌停空不到 / 收盤鎖漲停收盤買不到
    const L = [{ d: 'a', o: 100, h: 100, l: 100, c: 100 }, { d: 'b', o: 110, h: 110, l: 110, c: 110 }, { d: 'c', o: 111, h: 112, l: 108, c: 109 }];
    const r1 = rets(L, 1); ok('② 開盤鎖漲停 → 不能買(A/C 沒有)、收盤鎖住 → E 沒有', r1.A == null && r1.C == null && r1.E1 == null && r1.F != null);
    const Ld = [{ d: 'a', o: 100, h: 100, l: 100, c: 100 }, { d: 'b', o: 90, h: 90, l: 90, c: 90 }, { d: 'c', o: 91, h: 92, l: 89, c: 90 }];
    ok('②b 開盤鎖跌停 → 不能空', rets(Ld, 1).F == null && rets(Ld, 1).A != null);
    const Ln = [{ d: 'a', o: 100, h: 100, l: 100, c: 100 }, { d: 'b', o: 98, h: 101, l: 97, c: 100 }, { d: 'c', o: 103, h: 104, l: 102, c: 102 }];
    const r3 = rets(Ln, 1); ok('②c 報酬口徑(A 開→收、C 開→隔開、E1 收→隔開)', Math.abs(r3.A - (100 / 98 - 1) * 100) < 1e-9 && Math.abs(r3.C - (103 / 98 - 1) * 100) < 1e-9 && Math.abs(r3.E1 - 3) < 1e-9);
    // ③ 雙重差分:注入「只在極空日 +3」→ 量得到;注入「每天都 +3」(低 β 的數學必然)→ 雙重差分 ≈ 0
    const mkAgg = (fn) => { const ag = new Map(); for (let k = 0; k < 200; k++) { const d = `D${String(k).padStart(3, '0')}`; const m = new Map();
        const ev = k % 5 === 0; m.set('全部股票|A', [0, 10]); m.set('X|A', [fn(ev) * 5, 5]); ag.set(d, m); } return ag; };
    const dd = Array.from({ length: 200 }, (_, k) => `D${String(k).padStart(3, '0')}`), evd = dd.filter((_, k) => k % 5 === 0), nmd = dd.filter((_, k) => k % 5 !== 0);
    const A1 = mkAgg(ev => ev ? 3 : 0); const did1 = mean(incOver(A1, evd, 'X', 'A').map(r => r.v)) - mean(incOver(A1, nmd, 'X', 'A').map(r => r.v));
    ok('③ 注入「只在極空日 +3」→ 雙重差分 ≈ +3', Math.abs(did1 - 3) < 1e-9, did1);
    const A2 = mkAgg(() => 3); const did2 = mean(incOver(A2, evd, 'X', 'A').map(r => r.v)) - mean(incOver(A2, nmd, 'X', 'A').map(r => r.v));
    ok('③b 注入「每天都 +3」→ 雙重差分 = 0(⛔ 不可當成這種日子特別)', Math.abs(did2) < 1e-9, did2);
    ok('③c 每組至少 3 檔才算(樣本守門)', incOver(new Map([['D', new Map([['全部股票|A', [0, 10]], ['X|A', [6, 2]]])]]), ['D'], 'X', 'A').length === 0);
    // ④ 安慰劑種子固定
    const g1 = rng(7), g2 = rng(7); ok('④ 安慰劑固定種子', g1() === g2() && g1() === g2());
    // ⑤ 分組只用開盤前資訊:跳空來自今天開盤(開盤就知道),位階 / 20 日 / 昨天只用 i−1 以前
    const s5 = stk.map(x => ({ ...x })); s5[200].c *= 2; s5[200].h *= 2; const f5 = feats(s5, 200, idxC, idxIdx);
    ok('⑤ 改當天收盤 / 最高 → 位階、20日、昨天都不變', f5.pos === f1.pos && f5.r20 === f1.r20 && f5.yd === f1.yd);
    console.log(fail ? `\n❌ ${fail} 條沒過` : '\n✅ BEARDAY_SELFTEST 全部通過'); process.exit(fail ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) { if (process.argv.includes('--selftest')) selftest(); else main(); }
