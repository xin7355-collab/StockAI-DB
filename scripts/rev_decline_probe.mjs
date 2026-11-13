#!/usr/bin/env node
/**
 * 📉 V82.2.9 營收衰退避雷(全市場,事先登記 EXP-20261113-04)
 *
 * 問題:「營收衰退中」(近 3 個月營收年增 < 0 而且比上個月還差)的股票,之後會不會比同一天的股票弱?
 *   以前只在 14 組出口產業裡量過(trade_lead_probe ④ D0:20 日 −0.78pp),這次全市場含下市、16 年。
 *
 * ⛔ 前視守門:資料月 M → 次月 11 日起第一個交易日收盤才算知道(決策日);隔天開盤買、第 H 個交易日收盤賣(含息)。
 *    開盤一價鎖漲停買不到 / 窗口有價格斷崖 → 那一檔那一窗不算(fwdRet,跟 trade_lead_probe 同一支)。
 * 訊號:yoy3 / acc3 一律 import trade_lead_probe(⛔ 第二份)。
 * 對照:同一天、訊號算得出來的全部股票(同一個 H);另外控制同一天前 20 / 60 日報酬五分組(非事件股當對照)。
 * 判定(照登記寫死,⛔ 跑完再改):
 *   ① 主格(yoy3<0 且 acc3<0、H=20)反向六關全過(lib_evgate negate + gates,每年至少 6 個月)
 *   ② 9 格 × 5 個 H 一起 BH(Newey-West p),主格 q ≤ 0.05
 *   ③ 控制動能:前 20 日 / 前 60 日五分組內的增量都 ≤ −0.30pp
 *   ④ 門檻高原:9 格在 H=20 至少 7 格是負的
 *   ⑤ 安慰劑:同一天隨機挑同樣多檔 300 次,主格比 95% 的安慰劑還低
 *
 * 用法:DATA_DIR=<d16> REV_DIR=<stock_deep/rev> node --max-old-space-size=6000 scripts/rev_decline_probe.mjs out.json
 *       EVENTS_OUT=<檔> … 同上:只寫主格事件 {代號:[決策日之後第一個交易日]}(給 🔥 CCWIN=<檔> CCWIN_PRE=0 CCWIN_POST=19 / 👑 ATT_EVENTS + noAtt:20)
 *       node scripts/rev_decline_probe.mjs --selftest(RD_INJECT=peek = 拿下個月的營收判斷,② 必紅)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { yoy3, acc3, ymAdd, alignStock, fwdRet, nwP, pastRet } from './trade_lead_probe.mjs';
import { gates, negate, COST, increments, baseAdd } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';

export const HS = [5, 10, 20, 40, 60];
export const GRID_Y = [0, -5, -10], GRID_A = [0, -2, -5];
export const MAIN = { y: 0, a: 0, h: 20 };
export const AVAIL = 11;
export const RULE = { inc: -COST, mom: -0.30, plateau: 7, shamPct: 0.05, nSham: 300, minPerYear: 6, q: 0.05 };
const PEEK = process.env.RD_INJECT === 'peek';
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const lagOf = h => Math.max(0, Math.ceil(h / 21) - 1);
const cellKey = (y, a) => `y${y}_a${a}`;

/** 資料月 ym → 決策日(次月 avail 日起第一個交易日;那個月沒有就跳過) */
export function decisionDays(cal, from, to, avail = AVAIL) {
    const out = [];
    for (let ym = from; ym <= to; ym = ymAdd(ym, 1)) {
        const nx = ymAdd(ym, 1), target = `${nx}-${String(avail).padStart(2, '0')}`;
        const i = cal.findIndex(d => d >= target);
        if (i < 0) break;
        if (cal[i].slice(0, 7) !== nx) continue;
        out.push({ ym, i, d: cal[i] });
    }
    return out;
}

/** 一檔在資料月 ym 的訊號(yoy3 / acc3,⛔ 用 ym 之後的月份;RD_INJECT=peek 故意偷看下個月 = 自我檢查用) */
export function revSig(R, ym) {
    const use = PEEK ? ymAdd(ym, 1) : ym;
    const get = m => R.get(m);
    return { y: yoy3(get, use), a: acc3(get, use), sym: use };
}

/**
 * 面板:每個決策日 → 每一檔 {s, y, a, r:{H: 報酬}, m20, m60}
 * W = {cal, stocks: Map(代號 → aligned), sigOf(s, ym) → {y, a, sym} | null}
 */
export function buildPanel(W, days) {
    const out = [];
    for (const D of days) {
        const e = D.i + 1, rows = [];
        if (e >= W.cal.length) continue;
        for (const [s, S] of W.stocks) {
            const g = W.sigOf(s, D.ym);
            const r = {};
            let any = false;
            for (const H of HS) { const v = fwdRet(S, e, e + H - 1); if (v != null) { r[H] = v; any = true; } }
            if (!any) continue;
            rows.push({ s, y: g ? g.y : null, a: g ? g.a : null, sym: g ? g.sym : null, r, m20: pastRet(S, D.i, 20), m60: pastRet(S, D.i, 60) });
        }
        out.push({ ...D, rows });
    }
    return out;
}

const hasSig = r => r.y != null && r.a != null;
const isEv = (r, y, a) => hasSig(r) && r.y < y && r.a < a;

/** 一格 × 一個 H → lib_evgate 的增量(對照 = 同一天訊號算得出來的全部股票;all=true 改成同一天全部股票) */
export function incOf(panel, H, y, a, { all = false } = {}) {
    const base = new Map(), ev = [];
    for (const D of panel) for (const r of D.rows) {
        if (r.r[H] == null || (!all && !hasSig(r))) continue;
        baseAdd(base, D.d, r.r[H]);
        if (isEv(r, y, a)) ev.push({ d: D.d, r: r.r[H] });
    }
    return increments(ev, base);
}

/** 控制動能:同一天、前 k 日報酬五分組裡,事件股 − 同組非事件股的平均;回 {d(每天平均的平均), days} */
export function momControlled(panel, H, y, a, k = 'm20') {
    const dm = [];
    for (const D of panel) {
        const rows = D.rows.filter(r => hasSig(r) && r.r[H] != null && r[k] != null);
        if (rows.length < 10) continue;
        const srt = rows.map(r => r[k]).sort((p, q) => p - q);
        const cut = [1, 2, 3, 4].map(j => srt[Math.floor(srt.length * j / 5)]);
        const qOf = v => cut.filter(c => v >= c).length;
        const nonEv = [[], [], [], [], []];
        for (const r of rows) if (!isEv(r, y, a)) nonEv[qOf(r[k])].push(r.r[H]);
        const mN = nonEv.map(mean);
        const inc = [];
        for (const r of rows) if (isEv(r, y, a)) { const q = qOf(r[k]); if (nonEv[q].length) inc.push(r.r[H] - mN[q]); }
        if (inc.length) dm.push(mean(inc));
    }
    return { d: mean(dm), days: dm.length };
}

/** 固定種子的亂數(mulberry32) */
export function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

/** 安慰劑:同一天從訊號算得出來的股票裡隨機挑同樣多檔 → 每天(樣本平均 − 全體平均)的平均;回 n 個值 */
export function shamDist(panel, H, y, a, n = RULE.nSham, seed = 1) {
    const prep = panel.map(D => {
        const vals = D.rows.filter(r => hasSig(r) && r.r[H] != null);
        const k = vals.filter(r => isEv(r, y, a)).length;
        return { v: vals.map(r => r.r[H]), k, m: mean(vals.map(r => r.r[H])) };
    }).filter(p => p.k > 0 && p.v.length > p.k);
    const out = [];
    for (let t = 0; t < n; t++) {
        const R = rng(seed + t * 7919), dm = [];
        for (const p of prep) {
            const idx = p.v.map((_, j) => j);
            for (let j = 0; j < p.k; j++) { const z = j + Math.floor(R() * (idx.length - j)); [idx[j], idx[z]] = [idx[z], idx[j]]; }
            let s = 0; for (let j = 0; j < p.k; j++) s += p.v[idx[j]];
            dm.push(s / p.k - p.m);
        }
        out.push(mean(dm));
    }
    return out;
}

/** 全部算完 + 照登記判定 */
export function analyze(panel, { nSham = RULE.nSham } = {}) {
    const cells = [];
    for (const y of GRID_Y) for (const a of GRID_A) for (const H of HS) {
        const inc = incOf(panel, H, y, a);
        cells.push({ y, a, H, n: inc.n, nDays: inc.days.length, d: mean(inc.dm), p: nwP(inc.dm, lagOf(H)), inc });
    }
    const q = bhQ(cells.map(c => c.p));
    cells.forEach((c, i) => { c.q = q[i]; });
    const main = cells.find(c => c.y === MAIN.y && c.a === MAIN.a && c.H === MAIN.h);
    const G = gates(negate(main.inc), COST, RULE.minPerYear);
    const m20 = momControlled(panel, MAIN.h, MAIN.y, MAIN.a, 'm20'), m60 = momControlled(panel, MAIN.h, MAIN.y, MAIN.a, 'm60');
    const plateau = cells.filter(c => c.H === MAIN.h && c.d < 0).length;
    const sh = shamDist(panel, MAIN.h, MAIN.y, MAIN.a, nSham);
    const shamBelow = sh.filter(v => v <= main.d).length / Math.max(1, sh.length);   // 安慰劑比真的還低的比例
    const c = {
        c1: Object.values(G.pass).every(Boolean) && main.d <= RULE.inc,
        c2: main.q <= RULE.q,
        c3: m20.d <= RULE.mom && m60.d <= RULE.mom,
        c4: plateau >= RULE.plateau,
        c5: shamBelow <= RULE.shamPct,
    };
    // 只描述
    const all = incOf(panel, MAIN.h, MAIN.y, MAIN.a, { all: true });
    const dm = main.inc.dm, days = main.inc.days;
    const seg = k => mean(dm.filter((_, j) => (days[j] < '2019-01-01') === (k === 0)));
    const srt = [...main.inc.all].sort((x, y) => x - y), lo = srt[Math.floor(srt.length * 0.01)], hi = srt[Math.floor(srt.length * 0.99)];
    const evN = panel.map(D => D.rows.filter(r => isEv(r, MAIN.y, MAIN.a) && r.r[MAIN.h] != null).length);
    const raw = (() => { const per = []; for (const D of panel) { const v = D.rows.filter(r => isEv(r, MAIN.y, MAIN.a) && r.r[MAIN.h] != null).map(r => r.r[MAIN.h]); if (v.length) per.push(mean(v)); } return mean(per); })();
    const desc = {
        raw: r2(raw), vsAll: r2(mean(all.dm)), seg: [r2(seg(0)), r2(seg(1))], median: r2(med(main.inc.all)),
        wins: r2(mean(main.inc.all.map(x => Math.min(hi, Math.max(lo, x))))),
        dropWorst3: r2(mean([...dm].sort((x, y) => x - y).slice(3))),
        bearYears: Object.fromEntries((G.YR || []).filter(x => ['2011', '2015', '2018', '2022'].includes(x.y)).map(x => [x.y, r2(-x.d)])),
        events: main.n, months: main.nDays, perMonth: r2(mean(evN.filter(x => x > 0))),
    };
    return {
        pass: Object.values(c).every(Boolean), c,
        main: { d: r2(main.d), n: main.n, nDays: main.nDays, p: main.p, q: main.q, gates: { pass: G.pass, H: G.H.map(x => r2(-x)), YR: (G.YR || []).map(x => ({ y: x.y, n: x.n, d: r2(-x.d) })), dropBest: r2(-G.dropBest), p: G.p } },
        mom: { m20: r2(m20.d), m60: r2(m60.d), days20: m20.days, days60: m60.days },
        plateau, sham: { below: r2(shamBelow * 100), p5: r2([...sh].sort((x, y) => x - y)[Math.floor(sh.length * 0.05)]), med: r2(med(sh)) },
        cells: cells.map(({ inc, ...x }) => ({ ...x, d: r2(x.d) })), desc,
    };
}

/** 🧾 EVENTS_OUT:主格事件 → {代號: [可以進場的那一天]}(決策日之後第一個交易日;給 🔥 CCWIN / 👑 ATT_EVENTS 當名單濾網) */
export function eventsOf(panel, cal, y = MAIN.y, a = MAIN.a) {
    const out = {};
    for (const D of panel) {
        const d1 = cal[D.i + 1]; if (!d1) continue;
        for (const r of D.rows) if (isEv(r, y, a)) (out[r.s] = out[r.s] || []).push(d1);
    }
    return out;
}

// ───────────────────────── 讀資料 ─────────────────────────
function loadWorld(env) {
    const DATA = env.DATA_DIR, REV = env.REV_DIR;
    if (!DATA || !REV) { console.log('❌ 要設 DATA_DIR / REV_DIR(跑法見檔頭)'); process.exit(1); }
    const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
    const cal = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => d10(r.date)).filter(Boolean);
    const calIdx = new Map(cal.map((d, i) => [d, i]));
    const divAll = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, '_div16.json'), 'utf8')).d || {}; } catch (_) { return {}; } })();
    const revOf = new Map();
    for (const f of fs.readdirSync(REV)) {
        if (!f.endsWith('.json.gz')) continue;
        const s = f.replace('.json.gz', '');
        try {
            const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REV, f))).toString('utf8'));
            const ci = j.c.indexOf('revenue'), cy = j.c.indexOf('revenue_year'), cm = j.c.indexOf('revenue_month');
            const m = new Map();
            for (const v of j.v || []) { const y = +v[cy], mo = +v[cm], r = +v[ci]; if (y > 1990 && mo >= 1 && mo <= 12 && r > 0) m.set(`${y}-${String(mo).padStart(2, '0')}`, r); }
            if (m.size) revOf.set(s, m);
        } catch (_) {}
    }
    const stocks = new Map();
    for (const f of fs.readdirSync(DATA)) {
        const s = f.replace(/\.json$/, '');
        if (!/^\d{4}$/.test(s) || s.startsWith('00')) continue;   // 普通股(4 位數代號、⛔ ETF)
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 60) continue;
        const A = alignStock(cal, calIdx, bars, (divAll[s] || {}).h);
        A.date = cal;
        stocks.set(s, A);
    }
    return { cal, stocks, revOf, sigOf: (s, ym) => { const R = revOf.get(s); return R ? revSig(R, ym) : null; } };
}

function main(out) {
    const t0 = Date.now();
    const W = loadWorld(process.env);
    const yms = [...new Set([...W.revOf.values()].flatMap(m => [...m.keys()]))].sort();
    const days = decisionDays(W.cal, ymAdd(yms[0], 15), ymAdd(W.cal[W.cal.length - 1].slice(0, 7), -1));
    console.log(`📦 日曆 ${W.cal[0]} ~ ${W.cal.at(-1)}・個股 ${W.stocks.size} 檔・月營收 ${W.revOf.size} 檔(${yms[0]} ~ ${yms.at(-1)})・決策日 ${days.length} 個(${days[0]?.d} ~ ${days.at(-1)?.d})`);
    const panel = buildPanel(W, days);
    if (process.env.EVENTS_OUT) {   // 只寫事件清單,不跑研究
        const E = eventsOf(panel, W.cal), n = Object.values(E).reduce((t, v) => t + v.length, 0);
        const allD = Object.values(E).flat().sort();
        fs.writeFileSync(process.env.EVENTS_OUT, JSON.stringify(E));
        console.log(`📝 EVENTS_OUT:營收衰退中 ${n.toLocaleString()} 個「股・月」/ ${Object.keys(E).length} 檔(${allD[0]} ~ ${allD.at(-1)})→ ${process.env.EVENTS_OUT}`);
        process.exit(n ? 0 : 1);
    }
    const R = analyze(panel);
    const yn = x => x ? '✅' : '❌', s = x => (x >= 0 ? '+' : '') + x;
    const M = R.main;
    console.log(`主格(yoy3<0 且 acc3<0、抱 20 天):比同一天訊號算得出來的股票 ${s(M.d)}pp ・事件 ${M.n.toLocaleString()} 筆(${M.nDays} 個月,每月平均 ${R.desc.perMonth} 檔)・NW p ${M.p.toFixed(4)} ・BH q ${M.q.toFixed(4)}`);
    console.log(`① 反向六關 ${Object.entries(M.gates.pass).map(([k, v]) => `${k}${v ? '✅' : '❌'}`).join(' ')}(前後半 ${M.gates.H.join(' / ')}、拿掉最好那年 ${M.gates.dropBest})${yn(R.c.c1)}`);
    console.log(`   逐年 ${M.gates.YR.map(x => `${x.y.slice(2)}:${x.d}`).join(' ')}`);
    console.log(`② BH q ≤ 0.05 ${yn(R.c.c2)} ・③ 控制動能 前 20 日 ${s(R.mom.m20)} / 前 60 日 ${s(R.mom.m60)}pp ${yn(R.c.c3)} ・④ 高原 ${R.plateau}/9 格是負的 ${yn(R.c.c4)} ・⑤ 安慰劑比它還低 ${R.sham.below}%(安慰劑中位 ${R.sham.med}、第 5 百分位 ${R.sham.p5})${yn(R.c.c5)}`);
    for (const H of HS) console.log(`   H=${String(H).padStart(2)}:${GRID_Y.map(y => GRID_A.map(a => { const c = R.cells.find(x => x.y === y && x.a === a && x.H === H); return `${cellKey(y, a)} ${s(c.d)}(q ${c.q.toFixed(3)})`; }).join(' ')).join(' ・')}`);
    console.log(`只描述:原始 ${s(R.desc.raw)}% ・比全部股票(含沒營收的)${s(R.desc.vsAll)}pp ・2011~2018 ${s(R.desc.seg[0])} / 2019~ ${s(R.desc.seg[1])} ・中位數 ${s(R.desc.median)} ・縮尾 ${s(R.desc.wins)} ・拿掉最差 3 個月 ${s(R.desc.dropWorst3)} ・空頭年 ${JSON.stringify(R.desc.bearYears)}`);
    console.log(`⇒ ${R.pass ? '✅ 全部過' : '❌ 沒過'}・${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
}

// ───────────────────────── selftest ─────────────────────────
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    // 日曆:2012-01-02 起的平日
    const cal = []; for (let t = Date.UTC(2012, 0, 2); cal.length < 1300; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) cal.push(d.toISOString().slice(0, 10)); }
    // ① 決策日:資料月 2013-03 → 2013-04-11 起第一個交易日(2013-04-11 是週四)
    const D = decisionDays(cal, '2013-03', '2013-03');
    ok('① 資料月 2013-03 → 決策日 2013-04-11(次月 11 日起第一個交易日)', D.length === 1 && D[0].d === '2013-04-11', JSON.stringify(D));
    const D2 = decisionDays(cal, '2013-05', '2013-05');   // 2013-06-11 週二
    ok('① 2013-05 → 2013-06-11', D2[0].d === '2013-06-11', JSON.stringify(D2));
    // ② yoy3 / acc3 手算:這 3 個月 110 / 一年前 100 → +10%;上個月的 yoy3 = (100+110+110)/(100+100+100)−1 = +6.67% → acc3 = +3.33
    const R = new Map(); for (let k = 0; k < 30; k++) R.set(ymAdd('2011-01', k), 100);
    for (const m of ['2013-01', '2013-02', '2013-03']) R.set(m, 110);
    R.set('2012-12', 100);
    const g = revSig(R, '2013-03');
    ok('② yoy3 = +10%、acc3 = yoy3(這個月) − yoy3(上個月)', Math.abs(g.y - 10) < 1e-9 && Math.abs(g.a - (10 - (320 / 300 - 1) * 100)) < 1e-9, JSON.stringify(g));
    ok('② ⭐ 訊號只用資料月 ≤ ym(RD_INJECT=peek 會用下個月 → 這條紅)', g.sym === '2013-03', `用了 ${g.sym}`);
    // 合成世界:300 檔;每個決策日隨機 30% 是事件股(sigOf 直接給),股價 = 雜訊 + 情境
    const mkWorld = (mode, seed = 3) => {
        const R0 = rng(seed), N = 300, T = cal.length, days = decisionDays(cal, '2012-03', '2016-10');
        const ev = new Map(), loser = new Map();   // `${s}|${ym}` → bool
        const drift = Array.from({ length: N }, () => new Float64Array(T));
        for (const Dd of days) for (let s = 0; s < N; s++) {
            const L = R0() < 0.4;                       // 過去 20 天跌的那群(動能情境用)
            const E = mode === 'mom' ? (L && R0() < 0.5) || (!L && R0() < 0.05) : R0() < 0.3;
            ev.set(`${s}|${Dd.ym}`, E); loser.set(`${s}|${Dd.ym}`, L);
            if (mode === 'eff' && E) for (let k = Dd.i + 1; k <= Dd.i + 20 && k < T; k++) drift[s][k] -= 0.001;   // 事件股之後 20 天每天 −0.1%
            if (mode === 'mom' && L) { for (let k = Dd.i - 19; k <= Dd.i; k++) if (k > 0) drift[s][k] -= 0.005;   // 過去 20 天跌約 10%(比雜訊大很多 → 五分組分得開)
                for (let k = Dd.i + 1; k <= Dd.i + 20 && k < T; k++) drift[s][k] -= 0.001; }
        }
        const stocks = new Map();
        for (let s = 0; s < N; s++) {
            const o = new Float64Array(T), h = new Float64Array(T), l = new Float64Array(T), c = new Float64Array(T);
            let p = 50;
            for (let t = 0; t < T; t++) { const op = p * (1 + (R0() - 0.5) * 0.004); p = op * (1 + drift[s][t] + (R0() - 0.5) * 0.02); o[t] = op; c[t] = p; h[t] = Math.max(op, p) * 1.005; l[t] = Math.min(op, p) * 0.995; }
            stocks.set(String(s), { o, h, l, c, cliff: new Int32Array(T + 1), divf: new Float64Array(T).fill(1), date: cal });
        }
        const W = { cal, stocks, sigOf: (s, ym) => { const E = ev.get(`${s}|${ym}`); return E == null ? null : (E ? { y: -12, a: -6, sym: ym } : { y: 5, a: 1, sym: ym }); } };
        return { W, days };
    };
    // ③ 決定性對照:事件股之後 20 天每天 −0.1% → 事件 −2%,但對照組(同一天全部股票)也含 3 成事件股 → 增量 ≈ 0.7 × −2 = −1.4pp;
    //    事件的 yoy3 / acc3 = −12 / −6 → 9 格都包含 → 高原 9/9;沒有效果 → ≈ 0、整體不過
    {
        const { W, days } = mkWorld('eff'); const P = buildPanel(W, days); const A = analyze(P, { nSham: 60 });
        ok(`③ 有效果:主格 ${A.main.d}pp(≈ −1.4)、反向六關全過、高原 ${A.plateau}/9、安慰劑比它低的 ≤ 5%、整體過`, A.main.d < -1.0 && A.main.d > -1.8 && A.c.c1 && A.c.c4 && A.c.c5 && A.pass, JSON.stringify({ d: A.main.d, c: A.c }));
        ok('③ 有效果:控制動能後也還在(⛔ 被動能吃掉)', A.c.c3, JSON.stringify(A.mom));
    }
    {
        const { W, days } = mkWorld('none'); const P = buildPanel(W, days); const A = analyze(P, { nSham: 60 });
        ok(`④ 沒效果:主格 ${A.main.d}pp ≈ 0、整體不過`, Math.abs(A.main.d) < 0.4 && !A.pass, JSON.stringify({ d: A.main.d, c: A.c }));
    }
    // ⑤ 動能情境:事件股大多是過去 20 天跌的那群,之後的弱是「跌的繼續跌」→ 原始增量 < 0,控制前 20 日動能之後 ≈ 0 → ③ 不過
    {
        const { W, days } = mkWorld('mom'); const P = buildPanel(W, days); const A = analyze(P, { nSham: 60 });
        ok(`⑤ 只是動能:原始增量 ${A.main.d}pp < −0.5,控制前 20 日動能後 ${A.mom.m20} ≈ 0 → c3 不過`, A.main.d < -0.5 && Math.abs(A.mom.m20) < 0.35 && !A.c.c3, JSON.stringify({ d: A.main.d, mom: A.mom }));
    }
    // ⑥ 進場是決策日「隔天開盤」:決策日當天收盤的大跳空 ⛔ 算進去
    {
        const T = cal.length, o = new Float64Array(T).fill(100), c = new Float64Array(T).fill(100), h = new Float64Array(T).fill(100.5), l = new Float64Array(T).fill(99.5);
        const Dd = decisionDays(cal, '2013-03', '2013-03')[0];
        c[Dd.i] = 90;                                           // 決策日當天收盤大跌 10%(那時還不能買)
        for (let t = Dd.i + 1; t < T; t++) { o[t] = 90; c[t] = 90; h[t] = 90.5; l[t] = 89.5; }
        const S = { o, h, l, c, cliff: new Int32Array(T + 1), divf: new Float64Array(T).fill(1), date: cal };
        const W = { cal, stocks: new Map([['1', S]]), sigOf: () => ({ y: -3, a: -1, sym: '2013-03' }) };
        const P = buildPanel(W, [Dd]);
        ok('⑥ 決策日當天的跌幅不算(隔天開盤 90 買、20 天後收盤 90 → 0%)', P[0].rows[0].r[20] === 0, JSON.stringify(P[0].rows[0].r));
    }
    // ⑧ EVENTS_OUT:只收事件股、日期 = 決策日之後第一個交易日(⛔ 決策日當天 —— 那天收盤才知道)
    {
        const Dd = decisionDays(cal, '2013-03', '2013-03')[0];
        const P = [{ ...Dd, rows: [{ s: 'A', y: -3, a: -1, r: { 20: 1 } }, { s: 'B', y: 3, a: -1, r: { 20: 1 } }, { s: 'C', y: null, a: null, r: { 20: 1 } }] }];
        const E = eventsOf(P, cal);
        ok('⑧ EVENTS_OUT:只有 A、日期 = 決策日隔一個交易日(2013-04-12)', JSON.stringify(E) === JSON.stringify({ A: ['2013-04-12'] }), JSON.stringify(E));
    }
    // ⑦ 安慰劑是同一天挑同樣多檔:沒效果的世界裡,安慰劑中位 ≈ 0
    {
        const { W, days } = mkWorld('none', 9); const P = buildPanel(W, days);
        const sh = shamDist(P, 20, 0, 0, 40);
        ok(`⑦ 安慰劑中位 ${r2(med(sh))} ≈ 0`, Math.abs(med(sh)) < 0.3);
    }
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ 全部通過');
    return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
}
