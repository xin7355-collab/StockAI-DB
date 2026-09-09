#!/usr/bin/env node
/**
 * 💰 估值 5 條(本益比 / 股價淨值比 / 配息率 / 殖利率 / PEG / 價值陷阱)—— 用 fin_deep 的 34 季重測(V74.9.3)
 *
 * 為什麼以前測不了:歷史本益比要「當時已公布的 TTM EPS」,而 fund_yoy_gm 的 qeps 只有 8 季
 *   → pe_probe 的窗口只有 12~15 個月而且整段偏多頭。
 * ⭐ 現在:fin_deep(FinMind 三表)本來就有 34 季(2018 起),V74.9.3 補了 eps / eq(淨值)/ cap(股本)
 *   → TTM EPS 從 2019 起、每股淨值同樣 → 配上 klines_deep 合併後的日 K(2021 起)= **5.6 年、含 2022 空頭**。
 *
 * ⛔ 零前視:每一季只在法定公布日之後才「知道」(lib_fundamentals.pubDate,Q4 → 隔年 3/31)。
 * ⛔ 對照組 = 同一批(股·日)的全部;報酬扣同期加權;含息(除息日把現金股利加回去 —— 高殖利率那族不含息會被系統性低估,V74.4.5);
 *    同檔同桶 20 日去重;六道關卡:前後半同向・逐年同向・去最好年・扣成本 0.44%。
 * ⚠️ 限制:EPS 含一次性業外(低 PE 那批有假便宜)、倖存者偏誤、產業中位 PE 只有上市(industry_map)、
 *    淨值用「權益總額 ÷ 股數」是**含非控制權益**的近似。
 *
 * 用法:FIN_DEEP=/path/fin_deep.json DIV=/path/dividends_hist.json node --max-old-space-size=4096 scripts/valuation_deep_probe.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pubDate } from './lib_fundamentals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const FIN = process.env.FIN_DEEP || path.join(ROOT, 'fin_deep', 'fin_deep.json');
const DIVF = process.env.DIV || path.join(DATA, 'dividends_hist.json');
const COST = 0.44, STEP = 5, DEDUP = 20, MIN_IND = 5, HOR = [20, 60];
const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const f = (v, w = 6, d = 2) => (v == null || Number.isNaN(v) ? '--' : (v >= 0 ? '+' : '') + v.toFixed(d)).padStart(w);

if (!fs.existsSync(FIN)) { console.error(`❌ 找不到 ${FIN}(先 git show origin/fin_deep:fin_deep/fin_deep.json > …)`); process.exit(1); }
const FD = JSON.parse(fs.readFileSync(FIN, 'utf8'));
const FI = Object.fromEntries((FD.f || []).map((k, i) => [k, i]));
for (const k of ['eps', 'eq', 'cap', 'rev']) if (FI[k] == null) { console.error(`❌ fin_deep 沒有 ${k} 欄位(欄位:${FD.f})→ 要先跑 fin_backfill 補欄位`); process.exit(1); }
const DIV = fs.existsSync(DIVF) ? (JSON.parse(fs.readFileSync(DIVF, 'utf8')).d || {}) : {};
const indMap = fs.existsSync(path.join(DATA, 'industry_map.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8')) : {};

// ── 大盤 ──
const twArr = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
const days = [], tw = [];
for (const r of twArr) { const c = +r.close; if (c > 0) { days.push(nd(r.date)); tw.push(c); } }
const dPos = new Map(days.map((d, i) => [d, i]));

// ── 逐檔:重建 PE / PB / 殖利率 / 配息率 / PEG / 營收 YoY 的每日序列 ──
const S = new Map(); let used = 0, noEps = 0;
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
for (const fn of files) {
    const sym = fn.slice(0, 4);
    const rec = FD.s[sym]; if (!rec) continue;
    const qs = Object.keys(rec).sort();
    // 逐季:eps / eq / cap / rev(單季)
    const Q = qs.map(q => ({ q, pub: pubDate(q), eps: rec[q][FI.eps], eq: rec[q][FI.eq], cap: rec[q][FI.cap], rev: rec[q][FI.rev] })).filter(x => x.pub);
    if (Q.filter(x => x.eps != null).length < 8) { noEps++; continue; }
    let arr; try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(arr) || arr.length < 300) continue;
    const cl = new Float64Array(days.length).fill(NaN);
    for (const r of arr) { const i = dPos.get(nd(r.date)); const c = +r.close; if (i !== undefined && c > 0) cl[i] = c; }
    // 每一個公布日之後的「已知狀態」
    const states = [];   // {pub, ttm, ttmPrev, bvps, revYoY}
    for (let k = 0; k < Q.length; k++) {
        const last4 = Q.slice(Math.max(0, k - 3), k + 1);
        const ttm = last4.length === 4 && last4.every(x => x.eps != null) ? last4.reduce((s, x) => s + x.eps, 0) : null;
        const prev4 = Q.slice(Math.max(0, k - 7), k - 3);
        const ttmPrev = prev4.length === 4 && prev4.every(x => x.eps != null) ? prev4.reduce((s, x) => s + x.eps, 0) : null;
        const bvps = (Q[k].eq > 0 && Q[k].cap > 0) ? Q[k].eq / (Q[k].cap / 10) : null;
        const r4 = Q[k - 4];
        const revYoY = (Q[k].rev > 0 && r4 && r4.rev > 0 && Q[k].q.slice(5) === r4.q.slice(5)) ? Q[k].rev / r4.rev - 1 : null;
        states.push({ pub: Q[k].pub, ttm, ttmPrev, bvps, revYoY });
    }
    states.sort((a, b) => a.pub < b.pub ? -1 : 1);
    const divs = (DIV[sym] && DIV[sym].h) ? DIV[sym].h.filter(h => h[2] === '息' && h[1] > 0).map(h => [nd(h[0]), +h[1]]).sort() : [];
    const pe = new Float64Array(days.length).fill(NaN), pb = new Float64Array(days.length).fill(NaN);
    const yld = new Float64Array(days.length).fill(NaN), pay = new Float64Array(days.length).fill(NaN);
    const peg = new Float64Array(days.length).fill(NaN), ryo = new Float64Array(days.length).fill(NaN);
    let si = -1;
    for (let i = 0; i < days.length; i++) {
        const c = cl[i]; if (Number.isNaN(c)) continue;
        while (si + 1 < states.length && states[si + 1].pub <= days[i]) si++;
        if (si < 0) continue;
        const st = states[si];
        if (st.ttm > 0) { const v = c / st.ttm; if (v > 0 && v <= 300) pe[i] = v; }
        if (st.bvps > 0) { const v = c / st.bvps; if (v > 0 && v <= 100) pb[i] = v; }
        if (st.revYoY != null) ryo[i] = st.revYoY;
        if (st.ttm > 0 && st.ttmPrev > 0) { const g = st.ttm / st.ttmPrev - 1; if (g > 0 && pe[i] > 0) peg[i] = pe[i] / (g * 100); }
        // 近 12 個月已除息的現金股利(⛔ 只算已經除的)
        const d0 = days[i], y1 = `${+d0.slice(0, 4) - 1}${d0.slice(4)}`;
        let dsum = 0; for (const [dd, v] of divs) { if (dd > y1 && dd <= d0) dsum += v; }
        if (dsum > 0) { yld[i] = dsum / c * 100; if (st.ttm > 0) pay[i] = dsum / st.ttm; }
    }
    S.set(sym, { cl, pe, pb, yld, pay, peg, ryo, divs });
    used++;
}
const cov = days.map((_, i) => { let c = 0; for (const s of S.values()) if (!Number.isNaN(s.pe[i])) c++; return c; });
const START = cov.findIndex(c => c >= used * 0.5);
if (used < 300 || START < 0) { console.error(`❌ 空過守門:${used} 檔有 PE(沒 eps ${noEps} 檔)`); process.exit(1); }

// ── 每天:全市場分位 + 產業中位 ──
const dayStat = [];
for (let i = 0; i < days.length; i++) {
    if (i < START || i % STEP) { dayStat.push(null); continue; }
    const allPe = [], allPb = [], byInd = new Map();
    for (const [sym, s] of S) {
        if (!Number.isNaN(s.pe[i])) { allPe.push(s.pe[i]); const k = indMap[sym]; if (k) { (byInd.get(k) || byInd.set(k, []).get(k)).push(s.pe[i]); } }
        if (!Number.isNaN(s.pb[i])) allPb.push(s.pb[i]);
    }
    if (allPe.length < 200) { dayStat.push(null); continue; }
    allPe.sort((a, b) => a - b); allPb.sort((a, b) => a - b);
    const imed = new Map(); for (const [k, a] of byInd) if (a.length >= MIN_IND) imed.set(k, med(a));
    dayStat.push({ allPe, allPb, imed });
}
const qOf = (sorted, v) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5; };
const pos252 = (cl, i) => { let hi = -Infinity, lo = Infinity, n = 0; for (let j = Math.max(0, i - 251); j <= i; j++) { const c = cl[j]; if (Number.isNaN(c)) continue; n++; if (c > hi) hi = c; if (c < lo) lo = c; } return (n >= 120 && hi > lo) ? (cl[i] - lo) / (hi - lo) * 100 : null; };

// ── 未來報酬(含息、扣加權)──
const fwdEx = (s, i, k) => {
    const j = i + k; if (j >= days.length) return null;
    const a = s.cl[i], b = s.cl[j]; if (Number.isNaN(a) || Number.isNaN(b) || !(a > 0)) return null;
    let dv = 0; for (const [dd, v] of s.divs) { if (dd > days[i] && dd <= days[j]) dv += v; }
    return ((b + dv) / a - 1) * 100 - (tw[j] / tw[i] - 1) * 100;
};
const G = {}; const HALF = Math.floor((START + days.length) / 2);
const mk = () => ({ n: 0, r: { 20: [], 60: [] }, h1: [], h2: [], byY: {} });
const put = (k, x20, x60, i) => { const g = (G[k] ||= mk()); g.n++; const y = days[i].slice(0, 4); if (x20 !== null) { g.r[20].push(x20); (i < HALF ? g.h1 : g.h2).push(x20); (g.byY[y] ||= []).push(x20); } if (x60 !== null) g.r[60].push(x60); };
const lastHit = new Map(); let events = 0;
for (let i = START; i < days.length; i += STEP) {
    const D = dayStat[i]; if (!D) continue;
    for (const [sym, s] of S) {
        const v = s.pe[i], vb = s.pb[i];
        if (Number.isNaN(v) && Number.isNaN(vb)) continue;
        if (i - (lastHit.get(sym) ?? -1e9) < DEDUP) continue;
        const x20 = fwdEx(s, i, 20); if (x20 === null) continue;
        const x60 = fwdEx(s, i, 60);
        lastHit.set(sym, i); events++;
        put('__base', x20, x60, i);
        const pos = pos252(s.cl, i);
        if (!Number.isNaN(v)) {
            const qa = qOf(D.allPe, v);
            put('pe_q' + Math.min(4, Math.floor(qa * 5)), x20, x60, i);
            const k = indMap[sym], im = k ? D.imed.get(k) : null;
            if (im > 0) { const rel = v / im; put('rel_q' + (rel < 0.6 ? 0 : rel < 0.85 ? 1 : rel < 1.15 ? 2 : rel < 1.5 ? 3 : 4), x20, x60, i); }
            const ry = s.ryo[i];
            if (qa <= 0.3 && !Number.isNaN(ry)) put(ry < 0 ? 'trap' : 'lowpe_grow', x20, x60, i);
            if (qa <= 0.3 && pos != null) put(pos >= 60 ? 'lowpe_hi' : pos <= 30 ? 'lowpe_lo' : 'lowpe_mid', x20, x60, i);
            if (!Number.isNaN(s.peg[i])) put(s.peg[i] < 1 ? 'peg_lt1' : s.peg[i] < 2 ? 'peg_1_2' : 'peg_gt2', x20, x60, i);
            if (!Number.isNaN(s.pay[i])) { put(s.pay[i] > 1 ? 'pay_gt100' : s.pay[i] < 0.8 ? 'pay_lt80' : 'pay_80_100', x20, x60, i); }
            if (!Number.isNaN(s.yld[i]) && s.yld[i] >= 4) put(!Number.isNaN(s.pay[i]) && s.pay[i] < 0.8 ? 'y4_pay80' : 'y4_other', x20, x60, i);
        } else put('pe_none', x20, x60, i);      // 虧損 / 沒 PE
        if (!Number.isNaN(vb)) { const qb = qOf(D.allPb, vb); put('pb_q' + Math.min(4, Math.floor(qb * 5)), x20, x60, i); if (vb < 1) put('pb_lt1', x20, x60, i); }
    }
}
if (events < 20000) { console.error(`❌ 空過守門:只有 ${events} 個事件`); process.exit(1); }

// ── 報告 ──
const B = G.__base, ba = mean(B.r[20]), bm = med(B.r[20]), bw = B.r[20].filter(x => x > 0).length / B.r[20].length * 100, ba60 = mean(B.r[60]);
const yrsAll = Object.keys(B.byY).sort();
const bY = Object.fromEntries(yrsAll.map(y => [y, mean(B.byY[y])]));
console.log('═'.repeat(118));
console.log(`💰 估值條件深歷史重測 ・${used} 檔有 PE(fin_deep 沒 eps ${noEps} 檔)・窗口 ${days[START]} ~ ${days[days.length - 1]} ・${events.toLocaleString()} 事件(20 日去重)`);
console.log(`對照組 20 日超額(含息、扣加權):平均 ${f(ba)}% 中位 ${f(bm)}% 勝率 ${bw.toFixed(1)}% ・60 日平均 ${f(ba60)}%  逐年:${yrsAll.map(y => `${y.slice(2)}:${f(bY[y], 5)}`).join(' ')}`);
console.log('\n欄位:n / 20日平均 vs 對照 / 60日 vs 對照 / 勝率 / 前半 / 後半 / 逐年(相對對照) / 去最好年 / 扣成本 / 六關');
const line = (name, k) => {
    const g = G[k]; if (!g || g.r[20].length < 300) { console.log(`${name.padEnd(34)} 樣本不足(${g ? g.r[20].length : 0})`); return null; }
    const d20 = mean(g.r[20]) - ba, d60 = g.r[60].length ? mean(g.r[60]) - ba60 : NaN;
    const wr = g.r[20].filter(x => x > 0).length / g.r[20].length * 100;
    const h1 = g.h1.length >= 50 ? mean(g.h1) - mean(B.h1) : NaN, h2 = g.h2.length >= 50 ? mean(g.h2) - mean(B.h2) : NaN;
    const yrs = yrsAll.filter(y => (g.byY[y] || []).length >= 40).map(y => [y, mean(g.byY[y]) - bY[y]]);
    const same = !Number.isNaN(h1) && !Number.isNaN(h2) && (h1 > 0) === (h2 > 0);
    const yrSame = yrs.length >= 3 && yrs.every(([, v]) => (v > 0) === (d20 > 0));
    const best = yrs.length ? Math.max(...yrs.map(([, v]) => Math.abs(v))) : 0;
    const dropBest = yrs.length >= 3 ? (() => { const rest = yrs.filter(([, v]) => Math.abs(v) !== best); return mean(rest.map(([, v]) => v)); })() : NaN;
    const net = d20 - COST;
    const pass = same && yrSame && (Number.isNaN(dropBest) ? false : (dropBest > 0) === (d20 > 0)) && (d20 > 0 ? net > 0 : true);
    console.log(`${name.padEnd(34)} ${String(g.n).padStart(6)} ${f(d20)} ${f(d60)} ${wr.toFixed(1).padStart(5)}% ${f(h1)} ${f(h2)}${same ? '✅' : '❌'} ${yrs.map(([y, v]) => `${y.slice(2)}:${f(v, 5, 1)}`).join(' ')} ${yrSame ? '✅' : '❌'} ${f(dropBest)} ${f(net)} ${pass ? (d20 > 0 ? '⭐ 全過' : '⛔ 穩定地差') : ''}`);
    return { k, name: name.trim(), n: g.n, d20, d60, wr, h1, h2, same, yrSame, dropBest, net, pass };
};
const R = [];
console.log('\n── ① 本益比全市場分位(q0 = 最便宜 20%)'); for (let i = 0; i < 5; i++) R.push(line(`  PE q${i}(${['最低20%', '20-40%', '40-60%', '60-80%', '最高20%'][i]})`, 'pe_q' + i)); R.push(line('  沒有 PE(虧損 / 無 EPS)', 'pe_none'));
console.log('\n── ② 相對同業(PE ÷ 產業中位 PE,只有上市)'); ['便宜 4 成以上', '便宜 0.6~0.85', '差不多', '貴 1.15~1.5', '貴 5 成以上'].forEach((n, i) => R.push(line('  ' + n, 'rel_q' + i)));
console.log('\n── ③ 股價淨值比全市場分位 + PB<1'); for (let i = 0; i < 5; i++) R.push(line(`  PB q${i}`, 'pb_q' + i)); R.push(line('  PB < 1(跌破淨值)', 'pb_lt1'));
console.log('\n── ④ 價值陷阱 vs 低 PE + 營收成長(單季營收 YoY,已公布的)'); R.push(line('  ⛔ 價值陷阱:低 PE × 營收衰退', 'trap')); R.push(line('  低 PE × 營收成長', 'lowpe_grow'));
console.log('\n── ⑤ 低 PE × 一年位階'); R.push(line('  低 PE × 位階 ≥60', 'lowpe_hi')); R.push(line('  低 PE × 位階 30~60', 'lowpe_mid')); R.push(line('  低 PE × 位階 ≤30(便宜又跌深)', 'lowpe_lo'));
console.log('\n── ⑥ PEG(PE ÷ TTM EPS 成長率%,只算成長 >0 的)'); R.push(line('  PEG < 1', 'peg_lt1')); R.push(line('  PEG 1~2', 'peg_1_2')); R.push(line('  PEG > 2', 'peg_gt2'));
console.log('\n── ⑦ 配息率(近 12 月現金股利 ÷ TTM EPS)與殖利率'); R.push(line('  ⛔ 配息率 > 100%(賺的不夠發)', 'pay_gt100')); R.push(line('  配息率 80~100%', 'pay_80_100')); R.push(line('  配息率 < 80%', 'pay_lt80')); R.push(line('  殖利率 ≥4% 且配息率 <80%', 'y4_pay80')); R.push(line('  殖利率 ≥4%(其餘)', 'y4_other'));
const win = R.filter(o => o && o.pass);
console.log('\n' + '═'.repeat(118));
console.log(win.length ? `六關全過:${win.map(o => `${o.name}(${f(o.d20)}pp・扣成本 ${f(o.net)})`).join(' ・ ')}` : '⛔ 沒有任何一個桶六關全過(正向)。');
console.log('⚠️ 限制:EPS 含一次性業外(低 PE 有假便宜)・倖存者偏誤・產業中位只有上市・淨值含非控制權益・股利只算已除息的現金股利');
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ meta: { used, events, from: days[START], to: days[days.length - 1], base: { a20: ba, m20: bm, wr: bw } }, rows: R.filter(Boolean) }, null, 1));
