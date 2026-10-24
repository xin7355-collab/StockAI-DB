#!/usr/bin/env node
/**
 * 🎤 法說會之後那一檔怎麼走 —— 正式回測(V78.2.5)
 *
 * 以前只有 `confcall_miner.build_react` 的事實統計(法說會當天收盤 → +N 天,⛔ 沒扣成本、沒過六關,
 * 而且窗口只從 2026-07 起)。`hist_backfill.yml` 把場次往回補到約 5 年前之後,這支才測得動。
 *
 * ⭐ 口徑:法說會常在盤後 → 一律**隔天開盤**買(零前視),抱 h 天收盤賣,扣 0.44%;同期 0050 同一段(開盤→收盤)扣掉
 * ⭐ 對照組 = **同一檔、同一年的每一個交易日**用一模一樣的做法(量的是「法說會」這件事,⛔ 不是那檔那幾年本來就強 / 弱)
 * ⭐ 同一檔 20 個交易日內只算一次;隔天開盤鎖漲停(買不到)剔除並計數
 * ⭐ 方向事前不知道 → 兩個方向都報;六關照「量到的那個方向」判(⚠️ 這樣做比較寬鬆,結論寫在畫面時要講)
 *
 * 跑法:CONFCALL=$S/confcall.json DATA_DIR=$S/d10n node scripts/confcall_event_probe.mjs [out.json]
 *       REACT=1 CONFCALL=… DATA_DIR=$S/d16 node scripts/confcall_event_probe.mjs out.json   ← V79.7.3 隔天反應會不會延續
 *       node scripts/confcall_event_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gates } from './maxim_kbar5_probe.mjs';
import { limitOf } from './lib_limit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const COST = 0.44, DEDUP = 20;
export const HS = [1, 3, 5, 10, 20];

/** K = [{date, open, close}](排序);mk = Map(date → {o, c})(0050)。回這一檔所有「隔天開盤進、抱 h 天」的超額。 */
export function excessAt(K, mk, i, h) {
    const a = K[i + 1], b = K[i + h];
    if (!a || !b || !(a.open > 0)) return null;
    const m1 = mk.get(a.date), m2 = mk.get(b.date);
    if (!m1 || !m2 || !(m1.o > 0)) return null;
    if (a.open >= K[i].close * (1 + limitOf(a.date) - 0.005)) return 'lock';   // 開盤就漲停 → 買不到(2015-06 前 ±7%)
    return (b.close / a.open - 1) * 100 - COST - (m2.c / m1.o - 1) * 100;
}

export function run(hist, loadK, mk, h) {
    const ev = [], cnt = { lock: 0, noK: 0, dedup: 0 };
    for (const [sym, dates] of Object.entries(hist)) {
        const K = loadK(sym); if (!K) { cnt.noK += dates.length; continue; }
        const idx = new Map(K.map((r, i) => [r.date, i]));
        // ⭐ V78.2.6 對照改成「同一檔、同一年」的平均(第一版用整段歷史平均 → 結果跟著年份翻正負 = 量到的是那檔股票那幾年強不強,⛔ 不是法說會)
        const by = {}; let nb = 0; for (let i = 0; i < K.length; i++) { const x = excessAt(K, mk, i, h); if (typeof x === 'number') { (by[K[i].date.slice(0, 4)] = by[K[i].date.slice(0, 4)] || []).push(x); nb++; } }
        if (nb < 100) { cnt.noK += dates.length; continue; }
        const bmY = Object.fromEntries(Object.entries(by).filter(([, a]) => a.length >= 60).map(([y, a]) => [y, mean(a)])); let last = -1e9;
        for (const d of [...dates].sort()) {
            const i = idx.get(d); if (i == null) continue;
            if (i - last < DEDUP) { cnt.dedup++; continue; }
            const x = excessAt(K, mk, i, h);
            if (x === 'lock') { cnt.lock++; continue; }
            if (x == null) continue;
            const bm = bmY[d.slice(0, 4)]; if (bm == null) { cnt.noK++; continue; }
            last = i; ev.push({ d, sym, v: x - bm, raw: x });
        }
    }
    return { ev, cnt };
}

// ───────── 🔁 V79.7.3 法說會「隔天市場反應」會不會延續(使用者 10/24:用現在就能回測的資料先驗法說會到底有沒有用) ─────────
// 問題:法說會講的東西,市場是不是一兩天就反映完?反應大的那幾場之後還會不會繼續(或反過來)?
// ⭐ 反應 = 法說會前一天收盤 → 隔天收盤(兩天:盤中開的、盤後開的都包到)減掉同一段所有股票的平均
// ⭐ 進場 = **第三天開盤**(反應看完才買,⛔ 前視),抱 h 天收盤賣,扣 0.44%、減 0050;再減同一天所有股票同樣做法的平均
// ⭐ 決定性對照 = **沒有法說會的日子、同樣大小的反應**(量「法說會的資訊」⛔ 量「大漲大跌之後的慣性」)
export const RX_TH = [3, 4, 5, 6, 7];
export const RX_CLEAR = 5;     // 非法說會日:離任何一場法說會 ≥5 個交易日

/** 一檔的每一天:r2 = 前一天收盤 → 隔天收盤(%)、fx = 第三天開盤進抱 h 天的超額(excessAt 從隔天那根算)。斷崖(兩天超過兩根漲跌停)不收。 */
export function reactRowsOf(K, mk, h) {
    const out = [];
    for (let i = 1; i + 1 < K.length; i++) {
        const a = K[i - 1], b = K[i + 1];
        if (!(a.close > 0) || !(b.close > 0)) continue;
        const r2 = (b.close / a.close - 1) * 100;
        if (Math.abs(r2) > 2 * limitOf(K[i].date) * 100 + 1.5) continue;     // 物理上不可能 = 分割 / 減資斷崖
        const fx = excessAt(K, mk, i + 1, h);
        if (typeof fx !== 'number') continue;
        out.push({ i, d: K[i].date, r2, fx });
    }
    return out;
}

const _welch = (a, b) => { if (a.length < 2 || b.length < 2) return null; const ma = mean(a), mb = mean(b);
    const va = mean(a.map(x => (x - ma) ** 2)), vb = mean(b.map(x => (x - mb) ** 2));
    return +((ma - mb) / Math.sqrt(va / a.length + vb / b.length || 1)).toFixed(2); };

/** hist {sym:[日期]}、syms 全部股票 → 每一個門檻:法說會那幾場 vs 沒有法說會的日子(同樣大小的反應)。minDay = 一天至少幾檔才算當天平均 */
export function reactRun(hist, syms, loadK, mk, h, { minDay = 300, from = '2021-06-01' } = {}) {
    const day = new Map(), per = [];
    for (const sym of syms) {
        const K = loadK(sym); if (!K) continue;
        const rows = reactRowsOf(K, mk, h).filter(r => r.d >= from);
        if (!rows.length) continue;
        per.push([sym, K, rows]);
        for (const r of rows) { const a = day.get(r.d) || [0, 0, 0]; a[0] += r.r2; a[1] += r.fx; a[2]++; day.set(r.d, a); }
    }
    const callEv = [], other = [], cnt = { dedup: 0, noDay: 0 };
    for (const [sym, K, rows] of per) {
        const idx = new Map(K.map((r, i) => [r.date, i]));
        const ci = [...new Set((hist[sym] || []).map(d => idx.get(d)).filter(i => i != null))].sort((x, y) => x - y);
        const callSet = new Set(); let last = -1e9;
        for (const i of ci) { if (i - last < DEDUP) { cnt.dedup++; continue; } callSet.add(i); last = i; }
        const near = i => ci.some(c => Math.abs(c - i) < RX_CLEAR);
        for (const r of rows) {
            const a = day.get(r.d); if (!a || a[2] < minDay) { cnt.noDay++; continue; }
            const ar = r.r2 - a[0] / a[2], af = r.fx - a[1] / a[2];
            const o = { d: r.d, sym, ar, v: af, raw: r.fx };
            if (callSet.has(r.i)) callEv.push(o); else if (!near(r.i)) other.push(o);
        }
    }
    const rowsOut = [];
    // ⭐ 第二個對照(差中差):有開法說會的股票本來就跟一般日子不一樣(公司比較大、比較常被研究)→
    //    同樣是法說會,只比「反應大的」vs「沒什麼反應的(±2 以內)」,再扣掉沒法說會的日子同樣那一段差距 = 法說會「內容」的部分
    const flat = ar => Math.abs(ar) < 2;
    const cF = callEv.filter(e => flat(e.ar)).map(e => e.v), oF = other.filter(e => flat(e.ar)).map(e => e.v);
    const sdOf = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
    const mk1 = (lab, pred, sign) => {
        const ev = callEv.filter(e => pred(e.ar)), oth = other.filter(e => pred(e.ar));
        const g = gates(ev, ev.map(e => sign > 0 ? e.raw : -e.raw - 2 * COST), sign);
        const ve = ev.map(e => e.v), vo = oth.map(e => e.v);
        const mo = mean(vo);
        const did = (mean(ve) - mean(cF)) - (mo - mean(oF));
        const se = Math.sqrt([ve, cF, vo, oF].reduce((acc, a) => acc + (a.length > 1 ? sdOf(a) ** 2 / a.length : 0), 0));
        rowsOut.push({ lab, sign, n: ev.length, inc: g.inc, t: g.t, pass: g.pass, gates: g.gates, years: g.years,
            other_n: oth.length, other_inc: +mo.toFixed(3), diff: +(mean(ve) - mo).toFixed(3),
            diff_t: _welch(ve, vo), vs_flat: +(mean(ve) - mean(cF)).toFixed(3), did: +did.toFixed(3), did_t: +(did / (se || 1)).toFixed(2) });
    };
    for (const th of RX_TH) { mk1(`≥+${th}`, ar => ar >= th, 1); mk1(`≤−${th}`, ar => ar <= -th, -1); }
    mk1('±2 以內', ar => Math.abs(ar) < 2, 1);
    return { rows: rowsOut, n_call: callEv.length, n_other: other.length, cnt };
}

function loader(DD, from = '') {
    const c = new Map();
    return sym => { if (c.has(sym)) return c.get(sym); let K = null;
        try { let r = JSON.parse(fs.readFileSync(path.join(DD, `${sym}.json`), 'utf8')); r = Array.isArray(r) ? r : r.data;
            K = r.map(x => ({ date: String(x.date).replace(/\//g, '-'), open: +x.open, close: +x.close })).filter(x => x.close > 0 && x.date >= from); } catch (_) {}
        c.set(sym, K); return K; };
}

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    let s = 5; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const D = []; const t0 = Date.UTC(2021, 0, 4);
    for (let i = 0; D.length < 800; i++) { const dt = new Date(t0 + i * 864e5); if (dt.getUTCDay() % 6) D.push(dt.toISOString().slice(0, 10)); }
    const mk = new Map(); let mc = 100; D.forEach(d => { const o = mc * (1 + (rnd() - 0.5) * 0.004); mc = o * (1 + (rnd() - 0.5) * 0.01); mk.set(d, { o, c: mc }); });
    const build = (plant) => { const Ks = {}, hist = {};
        for (let k = 0; k < 40; k++) { const sym = String(3000 + k), ev = new Set(); for (let i = 50; i < 780; i += 60) ev.add(i + (k % 7));
            const K = []; let c = 50, boost = 0;
            D.forEach((d, i) => { const o = c * (1 + (rnd() - 0.5) * 0.006); if (ev.has(i - 1)) boost = plant ? 5 : 0;
                c = o * (1 + (rnd() - 0.5) * 0.02 + (boost > 0 ? 0.006 : 0)); if (boost > 0) boost--; K.push({ date: d, open: o, close: c }); });
            Ks[sym] = K; hist[sym] = [...ev].map(i => D[i]); }
        return { Ks, hist }; };
    const A = build(true), ra = run(A.hist, s => A.Ks[s], mk, 5);
    const ga = gates(ra.ev, ra.ev.map(e => e.raw), 1);
    ok('① 埋「法說會後 5 天每天 +0.6%」→ 量得到、六關 ≥5', ga.inc > 1.5 && ga.pass >= 5, JSON.stringify(ga).slice(0, 160));
    const B = build(false), rb = run(B.hist, s => B.Ks[s], mk, 5);
    ok('② 沒埋 → |增量| < 0.5(對照組有在做事)', Math.abs(mean(rb.ev.map(e => e.v))) < 0.5, mean(rb.ev.map(e => e.v)));
    // ③ 法說會當天的漲跌⛔ 不算(隔天開盤才進)
    const C = build(false); for (const [sym, ds] of Object.entries(C.hist)) { const set = new Set(ds); C.Ks[sym].forEach(r => { if (set.has(r.date)) r.open = r.close / 1.08; }); }
    const rc = run(C.hist, s => C.Ks[s], mk, 5);
    ok('③ 法說會當天大漲 → 不影響(隔天開盤才進)', Math.abs(mean(rc.ev.map(e => e.v))) < 0.8, mean(rc.ev.map(e => e.v)));
    // ④ 20 天內第二場不算
    const H = { '3000': [D[100], D[105], D[200]] }; const rd = run(H, () => A.Ks['3000'], mk, 5);
    ok('④ 同一檔 20 天內的第二場 → 去重', rd.cnt.dedup === 1 && rd.ev.length === 2, JSON.stringify(rd.cnt));
    // ⑤~⑦ V79.7.3 隔天反應會不會延續:埋「法說會反應大 → 之後同方向漂 5 天」/ 埋在所有大漲大跌日 / 都不埋
    const buildR = (mode) => { const Ks = {}, hist = {};
        for (let k = 0; k < 60; k++) { const sym = String(4000 + k), ev = new Set(), oth = new Set();
            for (let i = 40; i < 780; i += 60) ev.add(i + (k % 9));
            for (let i = 70; i < 780; i += 60) oth.add(i + (k % 5));       // 沒有法說會的大漲大跌日(只有 all 那組之後會漂)
            const K = []; let c = 50, drift = 0, ds = 0;
            D.forEach((d, i) => { const o = c * (1 + (rnd() - 0.5) * 0.004); let r = (rnd() - 0.5) * 0.02;
                const isCall = ev.has(i - 1) && Math.floor((i - 41) / 60) % 3 !== 2, isOth = oth.has(i - 1);   // 三場有一場沒什麼反應(差中差要用)
                if (isCall || isOth) { ds = (k + i) % 2 ? 1 : -1; r += ds * 0.07; if ((isCall && mode !== 'none') || (isOth && mode === 'all')) drift = 5; }
                else if (drift > 0) { r += ds * 0.006; drift--; }
                c = o * (1 + r); K.push({ date: d, open: o, close: c }); });
            Ks[sym] = K; hist[sym] = [...ev].map(i => D[i]); }
        return { Ks, hist, syms: Object.keys(Ks) }; };
    const pick = (res, lab) => res.rows.find(r => r.lab === lab) || {};
    const R1 = buildR('call'), q1 = reactRun(R1.hist, R1.syms, s => R1.Ks[s], mk, 5, { minDay: 20, from: '2021-01-01' });
    ok('⑤ 埋在法說會那幾場 → ≥+5 那組量得到、比沒法說會的日子多', pick(q1, '≥+5').inc > 1 && pick(q1, '≥+5').diff > 1 && pick(q1, '≤−5').inc < -1 && pick(q1, '≤−5').diff < -1 && pick(q1, '≥+5').did > 1, JSON.stringify([pick(q1, '≥+5').inc, pick(q1, '≥+5').diff, pick(q1, '≤−5').inc, pick(q1, '≤−5').diff]));
    const R2 = buildR('all'), q2 = reactRun(R2.hist, R2.syms, s => R2.Ks[s], mk, 5, { minDay: 20, from: '2021-01-01' });
    ok('⑥ 決定性對照:所有大漲大跌日都會漂 → 法說會那幾場還是有,但「比沒法說會的日子」≈ 0', pick(q2, '≥+5').inc > 1 && Math.abs(pick(q2, '≥+5').diff) < 0.8 && Math.abs(pick(q2, '≥+5').did) < 0.8 && pick(q2, '≥+5').other_n > 30, JSON.stringify(pick(q2, '≥+5')).slice(0, 200));
    const R3 = buildR('none'), q3 = reactRun(R3.hist, R3.syms, s => R3.Ks[s], mk, 5, { minDay: 20, from: '2021-01-01' });
    ok('⑦ 都不埋 → |增量| < 0.6(反應那兩天的漲跌⛔ 算進之後的報酬)', Math.abs(pick(q3, '≥+5').inc) < 0.6 && Math.abs(pick(q3, '≤−5').inc) < 0.6, JSON.stringify([pick(q3, '≥+5').inc, pick(q3, '≤−5').inc]));
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ CONFCALL_EVENT_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const F = process.env.CONFCALL;
    if (!F || !fs.existsSync(F)) { console.error('❌ 要 CONFCALL=confcall.json(git show origin/data:data/confcall.json > …)'); process.exit(1); }
    const C = JSON.parse(fs.readFileSync(F, 'utf8')); const hist = C.hist || {};
    const all = Object.values(hist).flat().sort();
    console.log(`🎤 hist ${Object.keys(hist).length} 檔 ・${all.length} 場 ・${all[0]} ~ ${all[all.length - 1]}${C.backfill ? ` ・補挖 ${JSON.stringify(C.backfill)}` : ' ・⚠️ 還沒補挖'}`);
    const yrs = new Set(all.map(d => d.slice(0, 4)));
    if (yrs.size < 3) { console.error(`❌ 場次只涵蓋 ${yrs.size} 個年度 → 逐年那一關做不了,⛔ 不下結論(先跑 hist_backfill.yml)`); process.exit(1); }
    const DD = process.env.DATA_DIR || path.join(ROOT, 'data');
    let M = JSON.parse(fs.readFileSync(path.join(DD, '0050.json'), 'utf8')); M = Array.isArray(M) ? M : M.data;
    const mk = new Map(M.map(r => [String(r.date).replace(/\//g, '-'), { o: +r.open, c: +r.close }]));
    if (process.env.REACT) {
        // 🔁 V79.7.3 隔天反應會不會延續(REACT=1)
        const L2 = loader(DD, '2021-04-01'), syms = fs.readdirSync(DD).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4));
        const out = { generated: new Date().toISOString(), react: {} };
        console.log('🔁 隔天反應 = 前一天收盤 → 隔天收盤 減同一段所有股票平均;第三天開盤進、抱 h 天;「比沒法說會的日子」= 同樣大小反應、離法說會 ≥5 天');
        for (const h of [5, 10, 20]) {
            const r = reactRun(hist, syms, L2, mk, h);
            out.react[h] = r;
            console.log(`\n── 抱 ${h} 天 ・法說會 ${r.n_call} 場 ・沒法說會的日子 ${r.n_other.toLocaleString()} 個`);
            for (const x of r.rows) console.log(`${x.pass === 6 ? '✅' : x.pass >= 4 ? '⚠️' : '⛔'} 反應 ${x.lab} ・n=${x.n} ・之後 ${x.inc >= 0 ? '+' : ''}${x.inc}pp(t=${x.t})・六關 ${x.pass}/6`
                + ` ・沒法說會的日子 ${x.other_inc >= 0 ? '+' : ''}${x.other_inc}pp(n=${x.other_n})→ 法說會多 ${x.diff >= 0 ? '+' : ''}${x.diff}pp(t=${x.diff_t})`
                + ` ・比沒什麼反應的法說會 ${x.vs_flat >= 0 ? '+' : ''}${x.vs_flat} ・差中差 ${x.did >= 0 ? '+' : ''}${x.did}pp(t=${x.did_t})・逐年 ${JSON.stringify(x.years)}`);
        }
        if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
        return;
    }
    const L = loader(DD), out = { generated: new Date().toISOString(), rows: {} };
    console.log('增量 = 這一場的超額(扣 0.44%、減 0050)− 同一檔同一年每一個交易日用同樣做法的平均;方向看量到的正負');
    for (const h of HS) {
        const { ev, cnt } = run(hist, L, mk, h);
        if (ev.length < 30) { console.log(`⏳ 抱 ${h} 天:${ev.length} 場 → 不下結論`); continue; }
        const m = mean(ev.map(e => e.v)), sign = m >= 0 ? 1 : -1;
        const g = gates(ev, ev.map(e => sign > 0 ? e.raw : -e.raw - 2 * COST), sign);
        out.rows[h] = { sign, ...g, cnt };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} 抱 ${h} 天 ・n=${g.n} ・增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・方向 ${sign > 0 ? '比平常好' : '比平常差'} ・六關 ${g.pass}/6 ・開盤鎖漲停剔除 ${cnt.lock} ・去重 ${cnt.dedup} ・沒 K 線 ${cnt.noK}`);
        console.log(`     逐年 ${JSON.stringify(g.years)} ・沒過:${Object.entries(g.gates || {}).filter(([, v]) => !v).map(([n]) => n).join('、') || '—'}`);
    }
    // ⭐ 對照 B(V78.2.6):同一天**所有股票**的平均(擋掉月份 / 季節效應 —— 對照 A 量到 12 月 −3.4pp、3 月 ≈0,那是日曆不是法說會)
    console.log('\n── 對照 B:同一天所有股票(≥300 檔)用同樣做法的平均');
    const allSyms = fs.readdirSync(DD).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)); out.rowsB = {};
    for (const h of HS) {
        const day = new Map();
        for (const sym of allSyms) { const K = L(sym); if (!K) continue; for (let i = 0; i < K.length; i++) { if (K[i].date < '2021-06-01') continue; const x = excessAt(K, mk, i, h); if (typeof x !== 'number') continue; const a = day.get(K[i].date) || [0, 0]; a[0] += x; a[1]++; day.set(K[i].date, a); } }
        const ev = [];
        for (const [sym, dates] of Object.entries(hist)) { const K = L(sym); if (!K) continue; const idx = new Map(K.map((r, i) => [r.date, i])); let last = -1e9;
            for (const d of [...dates].sort()) { const i = idx.get(d); if (i == null || i - last < DEDUP) continue; const x = excessAt(K, mk, i, h); if (typeof x !== 'number') continue; const a = day.get(d); if (!a || a[1] < 300) continue; last = i; ev.push({ d, v: x - a[0] / a[1], raw: x }); } }
        if (ev.length < 30) continue;
        const sign = mean(ev.map(e => e.v)) >= 0 ? 1 : -1, g = gates(ev, ev.map(e => sign > 0 ? e.raw : -e.raw - 2 * COST), sign);
        out.rowsB[h] = { sign, ...g };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} 抱 ${h} 天 ・n=${g.n} ・增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・六關 ${g.pass}/6 ・逐年 ${JSON.stringify(g.years)}`);
    }
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
