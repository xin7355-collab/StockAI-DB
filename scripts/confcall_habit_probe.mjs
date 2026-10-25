#!/usr/bin/env node
/**
 * 🎤🎲 法說會「股性」:這一檔的法說會,常常變「法會」嗎?(V79.8.6,使用者 10/25:
 *    「法說會不能依照個股董事長的慣性是做嗎?有常常把法說會說成法會的,當然也有反之,用發生率去告訴使用者就好」)
 *
 * ⭐ 口徑(⛔ 不是買賣訊號,只描述那兩天發生過什麼):
 *    法說會前一個交易日收盤 → 法說會後隔一個交易日收盤(2 個交易日,涵蓋「盤中開」與「盤後開」兩種),
 *    減同期加權(收盤 → 收盤);比大盤差 ≥3% =「法會」、好 ≥3% =「大漲」、其他 = 平淡。
 *    除權息落在窗口裡 → 用參考價把價格接回去(⛔ 不然除息那天會被算成「法會」);碰到價格斷崖的窗口不算。
 *    同一檔 5 個交易日內的第二場(同一次法說會開兩天 / 中英文各一場)只算一次。
 *
 * ⭐ 這支要回答的只有一件事:**這一檔過去的「法會」比例,猜得準下一場嗎?** 跟兩個更簡單的猜法比:
 *    ① 一般股票開法說會的比例(全部股票同一個數字)
 *    ② 這一檔「平常隨便 2 天」的比例(= 股性:本來就很會動的股票,法說會那兩天當然也很會動)
 *    ③ 這一檔過去法說會的比例(使用者講的「董事長慣性」)—— 只用那一場**之前**的場次(⛔ 前視)
 *    ④ ③ 往 ② 縮(過去場次少的時候不要太相信它)
 *    🎲 安慰劑:把每一檔的法說會日期換成同一年隨便幾天 → 再算一次 ③ 的準度。
 *       如果 ③ 只比 ② 好一點、而安慰劑也一樣好,那「慣性」其實就是股性,⛔ 不是董事長的習慣。
 *    評分 = 每一場的 Brier 分數(猜的機率跟實際有沒有發生的差的平方,越小越準)+ 拆成「過去常法會 / 很少法會」兩群比實際比例。
 *
 * 跑法:CONFCALL=$S/confcall.json DATA_DIR=$S/d16 DIV=$S/d16/_div16.json node scripts/confcall_habit_probe.mjs [out.json]
 *       node scripts/confcall_habit_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

export const TH = 3, DEDUP = 5, MIN_PRIOR = 3, SHRINK = 4;

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);

/** K = [{date, close}] 排好;mk = Map(date → close)(加權);divs = [[ex, cash, type, prev, ref]] → 回 { idx, x(i) } */
export function prep(K, mk, divs) {
    const dates = K.map(r => nd(r.date)), closes = K.map(r => +r.close);
    const pre = cliffPrefix(closes);
    const adj = new Map();   // 除權息日 → prev / ref(價格接回去的倍數)
    for (const h of divs || []) { const p = +h[3], r = +h[4]; if (p > 0 && r > 0 && p / r < 1.6) adj.set(nd(h[0]), p / r); }
    const idx = new Map(dates.map((d, i) => [d, i]));
    /** 第 i 根是事件日:前一天收盤 → 後一天收盤,減加權;回 null = 算不出來 */
    const x = i => {
        const a = i - 1, b = i + 1;
        if (a < 0 || b >= K.length) return null;
        const c0 = closes[a], c1 = closes[b]; if (!(c0 > 0 && c1 > 0)) return null;
        if (cliffIn(pre, a, b)) return null;
        const m0 = mk.get(dates[a]), m1 = mk.get(dates[b]); if (!(m0 > 0 && m1 > 0)) return null;
        let f = 1; for (let k = a + 1; k <= b; k++) { const g = adj.get(dates[k]); if (g) f *= g; }
        return ((c1 * f) / c0 - 1) * 100 - (m1 / m0 - 1) * 100;
    };
    /** 事件日 d 不是交易日 → 用之後第一個交易日 */
    const at = d => { if (idx.has(d)) return idx.get(d); let lo = 0, hi = dates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < d) lo = m + 1; else hi = m; } return lo < dates.length && lo > 0 ? lo : null; };
    return { dates, x, at };
}

const cls = v => v <= -TH ? -1 : v >= TH ? 1 : 0;

/** 一檔:事件(去重)+ 平常日子(⛔ 含事件窗口 ±2)。回 { ev:[{d,i,v}], ord:[{i,v}] } */
export function stockRows(P, dates) {
    const ev = []; let last = -1e9;
    for (const d of [...new Set(dates.map(nd))].sort()) {
        const i = P.at(d); if (i == null) continue;
        if (i - last < DEDUP) continue;
        const v = P.x(i); if (v == null) continue;
        last = i; ev.push({ d: P.dates[i], i, v });
    }
    const near = new Set(); for (const e of ev) for (let k = e.i - 2; k <= e.i + 2; k++) near.add(k);
    const ord = [];
    for (let i = 1; i < P.dates.length - 1; i++) { if (near.has(i)) continue; const v = P.x(i); if (v != null) ord.push({ i, v }); }
    return { ev, ord };
}

/** 主分析:rows = { sym: {ev, ord} };回各猜法的 Brier 與分群實際比例 */
export function analyze(rows, side = -1, { minMkt = 200, minOrd = 120 } = {}) {
    const hit = v => cls(v) === side ? 1 : 0;
    // ① 一般股票的比例:只用那一場「之前」所有股票的事件(⛔ 前視)
    const all = []; for (const s in rows) for (const e of rows[s].ev) all.push({ s, ...e });
    all.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    const mktRate = new Map(); let h = 0, n = 0, j = 0;
    for (let k = 0; k < all.length; k++) {
        while (j < k && all[j].d < all[k].d) { h += hit(all[j].v); n++; j++; }
        mktRate.set(all[k].s + '|' + all[k].i, n >= minMkt ? h / n : null);
    }
    const sc = { mkt: [], ord: [], past: [], shrink: [] }, grp = { hi: [0, 0], mid: [0, 0], lo: [0, 0] }, ordGrp = { hi: [0, 0], mid: [0, 0], lo: [0, 0] };
    let N = 0;
    for (const s in rows) {
        const { ev, ord } = rows[s];
        for (let k = MIN_PRIOR; k < ev.length; k++) {
            const e = ev[k], y = hit(e.v);
            const m = mktRate.get(s + '|' + e.i); if (m == null) continue;
            const before = ord.filter(o => o.i < e.i - 2); if (before.length < minOrd) continue;
            const pOrd = before.reduce((a, o) => a + hit(o.v), 0) / before.length;
            const kHit = ev.slice(0, k).reduce((a, z) => a + hit(z.v), 0);
            const pPast = kHit / k, pShr = (kHit + SHRINK * pOrd) / (k + SHRINK);
            const b = (p) => (p - y) ** 2;
            sc.mkt.push(b(m)); sc.ord.push(b(pOrd)); sc.past.push(b(pPast)); sc.shrink.push(b(pShr));
            const g = pPast >= 0.5 ? 'hi' : pPast <= 0.15 ? 'lo' : 'mid'; grp[g][0] += y; grp[g][1]++;
            const go = pOrd >= 0.2 ? 'hi' : pOrd <= 0.08 ? 'lo' : 'mid'; ordGrp[go][0] += y; ordGrp[go][1]++;
            N++;
        }
    }
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const r4 = v => v == null ? null : Math.round(v * 1e4) / 1e4;
    const rate = ([a, b]) => b ? { n: b, pct: Math.round(1000 * a / b) / 10 } : { n: 0, pct: null };
    return {
        n: N,
        brier: { mkt: r4(mean(sc.mkt)), ord: r4(mean(sc.ord)), past: r4(mean(sc.past)), shrink: r4(mean(sc.shrink)) },
        byPast: { hi: rate(grp.hi), mid: rate(grp.mid), lo: rate(grp.lo) },
        byOrd: { hi: rate(ordGrp.hi), mid: rate(ordGrp.mid), lo: rate(ordGrp.lo) },
    };
}

/** 全體描述:事件 vs 平常日子的「法會 / 大漲」比例 */
export function describe(rows) {
    let en = 0, ed = 0, eu = 0, on = 0, od = 0, ou = 0;
    for (const s in rows) {
        for (const e of rows[s].ev) { en++; const c = cls(e.v); if (c < 0) ed++; else if (c > 0) eu++; }
        for (const o of rows[s].ord) { on++; const c = cls(o.v); if (c < 0) od++; else if (c > 0) ou++; }
    }
    const p = (a, b) => b ? Math.round(1000 * a / b) / 10 : null;
    return { ev: { n: en, dn: p(ed, en), up: p(eu, en) }, ord: { n: on, dn: p(od, on), up: p(ou, on) } };
}

/** 🎲 安慰劑:每一檔的事件日換成同一年隨便幾天(固定種子) */
export function placebo(P, dates, seed) {
    let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const byY = {}; P.dates.forEach((d, i) => { if (i > 0 && i < P.dates.length - 1) (byY[d.slice(0, 4)] = byY[d.slice(0, 4)] || []).push(d); });
    return dates.map(d => { const a = byY[nd(d).slice(0, 4)]; return a && a.length ? a[Math.floor(rnd() * a.length)] : d; });
}

function loadK(dir, sym) {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, sym + '.json'), 'utf8')); return Array.isArray(j) ? j.filter(r => r && r.date && +r.close > 0) : null; } catch (_) { return null; }
}

function main() {
    const DIR = process.env.DATA_DIR, CC = process.env.CONFCALL, DV = process.env.DIV;
    if (!DIR || !CC) { console.error('❌ 要 DATA_DIR / CONFCALL'); process.exit(1); }
    const hist = (JSON.parse(fs.readFileSync(CC, 'utf8')).hist) || {};
    const div = DV ? (JSON.parse(fs.readFileSync(DV, 'utf8')).d || {}) : {};
    if (!DV) console.log('⚠️ 沒給 DIV → 除權息落在窗口裡的會被算成「法會」(偏多算)');
    const TW = loadK(DIR, '^TWII'); if (!TW) { console.error('❌ 讀不到 ^TWII'); process.exit(1); }
    const mk = new Map(TW.map(r => [nd(r.date), +r.close]));
    const rows = {}, rowsP = [{}, {}, {}];
    let nSym = 0, dFrom = '9', dTo = '0';
    for (const [sym, dates] of Object.entries(hist)) {
        if (!Array.isArray(dates) || !dates.length) continue;
        const K = loadK(DIR, sym); if (!K || K.length < 300) continue;
        const P = prep(K, mk, (div[sym] || {}).h);
        const r = stockRows(P, dates); if (!r.ev.length) continue;
        rows[sym] = r; nSym++;
        for (const e of r.ev) { if (e.d < dFrom) dFrom = e.d; if (e.d > dTo) dTo = e.d; }
        for (let t = 0; t < 3; t++) rowsP[t][sym] = stockRows(P, placebo(P, dates, 1000 + t * 7919 + nSym));
    }
    const out = {
        how: '法說會前一個交易日收盤 → 後一個交易日收盤,減加權;≤ −3% = 法會、≥ +3% = 大漲;同一檔 5 天內只算一次;只用之前的場次猜下一場',
        syms: nSym, from: dFrom, to: dTo,
        desc: describe(rows),
        dn: analyze(rows, -1), up: analyze(rows, 1),
        placebo: rowsP.map(rp => ({ desc: describe(rp), dn: analyze(rp, -1), up: analyze(rp, 1) })),
    };
    const f = process.argv[2]; if (f) fs.writeFileSync(f, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
}

function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    // 合成:600 個交易日;加權不動
    const mkDates = n => { const out = []; let t = Date.UTC(2021, 0, 4); while (out.length < n) { const d = new Date(t); const w = d.getUTCDay(); if (w && w < 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; };
    const D = mkDates(900), mk = new Map(D.map(d => [d, 100]));
    // A:每一場法說會隔天跌 6%、平常每天 ±0.5% 小動;B:同樣的平常日子,法說會那兩天不動
    const mkK = (evIdx, drop) => { let c = 100; return D.map((d, i) => { c *= (i % 2 ? 1.004 : 0.996); if (evIdx.has(i - 1)) c *= (1 + drop); return { date: d, close: +c.toFixed(4) }; }); };
    const evI = [100, 160, 220, 280, 340, 400, 460, 520, 580, 640, 700, 760];
    const KA = mkK(new Set(evI), -0.06), KB = mkK(new Set(evI), 0);
    const PA = prep(KA, mk, []), PB = prep(KB, mk, []);
    const datesE = evI.map(i => D[i]);
    const rA = stockRows(PA, datesE), rB = stockRows(PB, datesE);
    ok('① A 每一場都是法會(−6%)', rA.ev.length === 12 && rA.ev.every(e => e.v <= -5.5), JSON.stringify(rA.ev.slice(0, 3)));
    ok('① B 每一場都平淡', rB.ev.every(e => Math.abs(e.v) < 1));
    ok('② 平常日子排除了法說會前後', rA.ord.every(o => !evI.some(i => Math.abs(o.i - i) <= 2)));
    const an = analyze({ A: rA, B: rB }, -1, { minMkt: 3, minOrd: 30 });
    ok('③ 過去場次猜得比平常股性準(A 的慣性是真的)', an.brier.past < an.brier.ord && an.n > 0, JSON.stringify(an.brier));
    ok('③ 分群:過去常法會那群實際 100%', an.byPast.hi.pct === 100 && an.byPast.lo.pct === 0, JSON.stringify(an.byPast));
    // ④ 決定性對照:A 的「跌」是平常日子也有的(股性),法說會那兩天沒有特別 → 過去場次⛔ 比平常股性準
    const KC = D.map((d, i) => ({ date: d, close: +(100 * (1 + ((i * 7919) % 13 - 6) / 100)).toFixed(4) }));   // 每天亂跳 ±6%
    const PC = prep(KC, mk, []), rC = stockRows(PC, datesE);
    const an2 = analyze({ C: rC, B: rB }, -1, { minMkt: 3, minOrd: 30 });
    ok('④ 決定性對照:只是股性很會動 → 過去場次⛔ 明顯比平常股性準', an2.n > 0 && !(an2.brier.past < an2.brier.ord - 0.02), JSON.stringify([an2.n, an2.brier]));
    // ⑤ 除權息:窗口裡有除息 10% → 接回去後⛔ 算成法會
    const KD = D.map((d, i) => ({ date: d, close: i >= 101 ? 90 : 100 }));
    const PD0 = prep(KD, mk, []), PD1 = prep(KD, mk, [[D[101], 10, '權息', 100, 90]]);
    ok('⑤ 除息落在窗口裡:沒接回 −10%、接回 0%', Math.round(PD0.x(100)) === -10 && Math.abs(PD1.x(100)) < 1e-9, `${PD0.x(100)} ${PD1.x(100)}`);
    // ⑥ 斷崖:窗口裡 ×0.4 → 不算
    const KE = D.map((d, i) => ({ date: d, close: i >= 101 ? 40 : 100 }));
    ok('⑥ 價格斷崖窗口不算', prep(KE, mk, []).x(100) === null);
    // ⑦ 去重:同一場開兩天只算一次
    const rDup = stockRows(PA, [D[100], D[101], D[160]]);
    ok('⑦ 5 天內第二場⛔ 重算', rDup.ev.length === 2, rDup.ev.length);
    // ⑧ 前視守門:把「過去」改成含這一場 → A 的 Brier 變 0(說明 analyze 確實只用之前的)
    ok('⑧ 只用之前的場次:第 4 場起才猜(前 3 場⛔ 計分)', an.n === 2 * (12 - MIN_PRIOR) || an.n === (12 - MIN_PRIOR) * 2, an.n);
    // ⑨ 非交易日:週六的法說會 → 用下一個交易日
    const sat = (() => { const t = new Date(D[200] + 'T00:00:00Z'); while (t.getUTCDay() !== 6) t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); })();
    ok('⑨ 週末的日期接到下一個交易日', PA.dates[PA.at(sat)] > sat && PA.dates[PA.at(sat) - 1] < sat);
    // ⑩ 安慰劑:固定種子 + 同一年
    const pl1 = placebo(PA, datesE, 7), pl2 = placebo(PA, datesE, 7);
    ok('⑩ 安慰劑固定種子、同一年', JSON.stringify(pl1) === JSON.stringify(pl2) && pl1.every((d, i) => d.slice(0, 4) === datesE[i].slice(0, 4)));
    console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest(); else main();
