#!/usr/bin/env node
// 📉 V79.3.1 「今天大跌,怎麼撿便宜?」—— 0050 層級的三個問題(使用者:「做」)
//
//  (A) 加權當天跌 ≥X%(X = 1.5 / 2 / 3)那天**尾盤**買 0050(含息),之後 5/20/60/120/250 天
//      vs 同期隨便挑一天(全部交易日);安慰劑 = 同樣天數隨機抽日子(固定種子)2,000 次
//      ⚠️ 同一段跌勢連續觸發會擠在一起 → 另印「獨立波段數」(前後隔 >20 個交易日才算新的一段)
//  (B) 手上有 100 萬、今天大跌:一次買 vs 分批買
//      L  今天尾盤一次買完
//      S4 今天 1/4,之後第 5/10/15 個交易日各 1/4(照時間分)
//      SD 今天 1/4,之後每遇到下一次大跌再買 1/4,60 天內沒用完的第 60 天全買(等更低)
//      W20 等 20 天再一次買
//      → 看第 120 / 250 天市值;⭐ 對照:同樣四種買法套在**隨便挑的日子**,差距一樣大就不是「大跌」的功勞
//  (C) 每月存 1 萬:平常定期定額 vs 「錢存著、大跌才買」(等太久 3/6 個月照買)vs 一半一半
//      10 年窗口、起點每 3 個月一條(2011~2016),最後市值配對比較;現金利率 0% 與 1.5% 各跑一次
//
//  ⛔ 描述與比較,不是選股訊號;⛔ 不改 App。
//  ⚠️ 進場用**當天收盤**:真的要做是 13:25 看到大盤跌夠了掛收盤(同 V72.9.0 尾盤進場)。
//
// 跑法:
//   DATA_DIR=$S/d10n DIV=data/dividends_hist.json node scripts/dipbuy_probe.mjs out.json
//   (DATA_DIR 需要 _bench0050.json 與 ^TWII.json;DIV 不給就讀 DATA_DIR/_div0050.json)
//   node scripts/dipbuy_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trSeries, d10, num } from './lib_totalreturn.mjs';

export const XS = [1.5, 2, 3];
export const HS = [5, 20, 60, 120, 250];
export const BUY_FEE = 0.001425 * 0.6;
const EP_GAP = 20;

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);

// 固定種子亂數(mulberry32)
export function rng(seed) {
    let a = seed >>> 0;
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** 對齊:回 {d[], idx[](加權收盤), tr[](0050 含息指數)} */
export function align(twii, b0050, divs) {
    const m = new Map(twii.map(r => [r.d, r.c]));
    const bars = b0050.filter(r => m.has(r.d));
    const tr = trSeries(bars, divs).v;
    return { d: bars.map(b => b.d), idx: bars.map(b => m.get(b.d)), tr };
}

/** 加權當天跌 ≥X% 的日子(收盤對收盤) */
export function dropDays(idx, X) {
    const out = [];
    for (let i = 1; i < idx.length; i++) if ((idx[i] / idx[i - 1] - 1) * 100 <= -X) out.push(i);
    return out;
}
export function episodes(ev, gap = EP_GAP) {
    let n = 0, last = -1e9;
    for (const i of ev) { if (i - last > gap) n++; last = i; }
    return n;
}
export const fwd = (tr, i, h) => i + h < tr.length ? (tr[i + h] / tr[i] - 1) * 100 : null;

// ---------- (A) ----------
export function partA(S, X, seed = 7) {
    const ev = dropDays(S.idx, X);
    const out = { X, n: ev.length, ep: episodes(ev), h: {} };
    const R = rng(seed + Math.round(X * 10));
    for (const h of HS) {
        const all = []; for (let i = 1; i < S.tr.length; i++) { const f = fwd(S.tr, i, h); if (f != null) all.push(f); }
        const e = ev.map(i => fwd(S.tr, i, h)).filter(f => f != null);
        if (!e.length) { out.h[h] = { n: 0 }; continue; }
        const em = mean(e), bm = mean(all);
        // 安慰劑:同樣天數隨機抽
        let ge = 0; const SIMS = 2000;
        for (let s = 0; s < SIMS; s++) {
            let sum = 0; for (let k = 0; k < e.length; k++) sum += all[Math.floor(R() * all.length)];
            if (sum / e.length >= em) ge++;
        }
        // 逐年 + 前後半(按事件日期)
        const yr = {};
        for (const i of ev) { const f = fwd(S.tr, i, h); if (f == null) continue; const y = S.d[i].slice(0, 4); (yr[y] = yr[y] || []).push(f); }
        const half = Math.floor(e.length / 2);
        out.h[h] = {
            n: e.length, ev: r2(em), base: r2(bm), diff: r2(em - bm),
            up: r2(e.filter(x => x > 0).length / e.length * 100), upBase: r2(all.filter(x => x > 0).length / all.length * 100),
            p: +(ge / SIMS).toFixed(3),
            h1: r2(mean(e.slice(0, half)) - bm), h2: r2(mean(e.slice(half)) - bm),
            yrs: Object.fromEntries(Object.entries(yr).map(([y, a]) => [y, { n: a.length, m: r2(mean(a)) }])),
        };
    }
    return out;
}

// ---------- (B) ----------
// 回第 H 天市值(本金 1,現金不計息);tr 為含息指數
export function deploy(S, i0, mode, X, H) {
    const end = i0 + H; if (end >= S.tr.length) return null;
    let cash = 1, units = 0;
    const buy = (i, amt) => { amt = Math.min(amt, cash); if (amt <= 0) return; units += amt * (1 - BUY_FEE) / S.tr[i]; cash -= amt; };
    if (mode === 'L') buy(i0, 1);
    else if (mode === 'W20') buy(i0 + 20, 1);
    else if (mode === 'S4') { for (const k of [0, 5, 10, 15]) buy(i0 + k, 0.25); }
    else if (mode === 'SD') {
        buy(i0, 0.25);
        for (let i = i0 + 1; i <= i0 + 60 && cash > 1e-9; i++) {
            if ((S.idx[i] / S.idx[i - 1] - 1) * 100 <= -X) buy(i, 0.25);
            if (i === i0 + 60) buy(i, cash);
        }
    }
    return cash + units * S.tr[end];
}
export const MODES = ['L', 'S4', 'SD', 'W20'];
export function partB(S, X, H, seed = 11) {
    const ev = dropDays(S.idx, X);
    const res = (days) => {
        const v = {}; for (const m of MODES) v[m] = [];
        for (const i of days) { const r = MODES.map(m => deploy(S, i, m, X, H)); if (r.some(x => x == null)) continue; MODES.forEach((m, k) => v[m].push(r[k])); }
        const n = v.L.length; if (!n) return { n: 0 };
        const o = { n };
        for (const m of MODES) {
            o[m] = r2((mean(v[m]) - 1) * 100);
            if (m !== 'L') o[m + 'win'] = r2(v[m].filter((x, k) => x > v.L[k]).length / n * 100);   // 這種買法贏一次買的 %
        }
        return o;
    };
    // 對照:隨便挑的日子(同樣天數、固定種子)
    const R = rng(seed + H + Math.round(X * 10)), pool = [];
    for (let i = 1; i < S.tr.length - H; i++) pool.push(i);
    const rnd = []; for (let k = 0; k < Math.max(ev.length, 400); k++) rnd.push(pool[Math.floor(R() * pool.length)]);
    return { X, H, ev: res(ev), rnd: res(rnd) };
}

// ---------- (C) ----------
// 每月第一個交易日存入 1;mode: dca / dip:M(等 M 個月沒大跌就照買)/ half:M
export function monthly(S, i0, i1, mode, X, cashR = 0) {
    let cash = 0, units = 0, put = 0, lastBuyMon = 0, mon = 0;
    const dr = Math.pow(1 + cashR, 1 / 252) - 1;
    const buy = (i, amt) => { amt = Math.min(amt, cash); if (amt <= 0) return; units += amt * (1 - BUY_FEE) / S.tr[i]; cash -= amt; };
    const [kind, Ms] = mode.split(':'); const M = +Ms || 0;
    for (let i = i0; i <= i1; i++) {
        cash *= 1 + dr;
        const newMon = i === i0 || S.d[i].slice(0, 7) !== S.d[i - 1].slice(0, 7);
        if (newMon) {
            mon++; cash += 1; put += 1;
            if (kind === 'dca') buy(i, cash);
            else if (kind === 'half') buy(i, 0.5);
        }
        const drop = i > 0 && (S.idx[i] / S.idx[i - 1] - 1) * 100 <= -X;
        if (kind !== 'dca') {
            if (drop) { buy(i, cash); lastBuyMon = mon; }
            else if (newMon && M && mon - lastBuyMon >= M) { buy(i, cash); lastBuyMon = mon; }
        }
    }
    return { v: cash + units * S.tr[i1], put };
}
export const CMODES = ['dca', 'dip:3', 'dip:6', 'dip:0', 'half:6'];
export function partC(S, X, YEARS = 10, cashR = 0) {
    const out = { X, cashR, starts: [] };
    const span = Math.round(YEARS * 252);
    for (let i0 = 1; i0 + span < S.tr.length; i0 += 63) {
        const i1 = i0 + span;
        const row = { from: S.d[i0], to: S.d[i1] };
        for (const m of CMODES) { const r = monthly(S, i0, i1, m, X, cashR); row[m] = r.v / r.put; row.put = r.put; }
        out.starts.push(row);
    }
    const n = out.starts.length;
    out.summary = {};
    for (const m of CMODES) {
        const a = out.starts.map(r => r[m]).sort((x, y) => x - y);
        out.summary[m] = { med: r2((a[a.length >> 1] - 1) * 100), worst: r2((a[0] - 1) * 100), best: r2((a[a.length - 1] - 1) * 100),
            beatDca: m === 'dca' ? null : out.starts.filter(r => r[m] > r.dca).length, n };
    }
    return out;
}

// ---------- selftest ----------
function selftest() {
    let ok = 0, bad = 0;
    const T = (c, msg) => { if (c) ok++; else { bad++; console.log('❌', msg); } };
    // 合成:每 50 天一次 −3% 大跌,其餘每天 +0.03%;大跌後 5 天每天 +1%(注入反彈)
    const mk = (inject) => {
        const d = [], idx = [], tr = []; let p = 100;
        for (let i = 0; i < 2000; i++) {
            let r = 0.0003;
            if (i % 50 === 25) r = -0.03;
            else if (inject && i % 50 > 25 && i % 50 <= 30) r = 0.01;
            p *= 1 + r;
            const dt = new Date(Date.UTC(2010, 0, 1) + i * 86400000).toISOString().slice(0, 10);
            d.push(dt); idx.push(p); tr.push(p);
        }
        return { d, idx, tr };
    };
    const S1 = mk(true), S0 = mk(false);
    T(dropDays(S1.idx, 2).length === 40, '① 大跌日數 = 40');
    T(episodes(dropDays(S1.idx, 2)) === 40, '② 隔 50 天 = 40 個獨立波段');
    const a1 = partA(S1, 2), a0 = partA(S0, 2);
    T(a1.h[5].diff > 3, '③ 注入反彈 → 5 日多出 >3%(' + a1.h[5].diff + ')');
    T(a1.h[5].p < 0.01, '④ 注入 → 安慰劑 p<0.01');
    T(Math.abs(a0.h[5].diff) < 0.5, '⑤ 沒注入 → 5 日差距 ≈0(' + a0.h[5].diff + ')');
    // ⑥ 零前視:事件日收盤買,報酬從 i 起算(不含當天跌幅)
    const i = dropDays(S0.idx, 2)[0];
    T(Math.abs(fwd(S0.tr, i, 1) - 0.03) < 1e-6, '⑥ 隔一天報酬 = +0.03%(不含當天跌幅)');
    // ⑦ 一次買 vs 分批:單調上漲 → 一次買必贏
    const Sup = { d: S0.d, idx: S0.d.map((_, k) => 100 * Math.pow(1.001, k)), tr: S0.d.map((_, k) => 100 * Math.pow(1.001, k)) };
    T(deploy(Sup, 10, 'L', 2, 100) > deploy(Sup, 10, 'S4', 2, 100), '⑦ 一路漲 → 一次買 > 分批');
    T(deploy(Sup, 10, 'L', 2, 100) > deploy(Sup, 10, 'W20', 2, 100), '⑧ 一路漲 → 一次買 > 等 20 天');
    // ⑨ SD 60 天內一定用完
    const v = deploy(S0, 25, 'SD', 2, 100); T(v != null && v > 0.9, '⑨ SD 有買完');
    // ⑩ 每月存:總投入一樣、dca 一路漲時最好
    const c = partC(Sup, 2, 2, 0);
    T(c.starts.every(r => r.put > 0), '⑩ 每條都有投入');
    T(c.summary['dip:0'].med <= c.summary.dca.med, '⑪ 一路漲(沒大跌)→ 只等大跌的不會贏定期定額');
    const r0 = monthly(Sup, 1, 500, 'dip:0', 2, 0);
    T(r0.v === r0.put, '⑫ 從不大跌、從不買 → 市值 = 存入現金');
    const r1 = monthly(Sup, 1, 500, 'dip:0', 2, 0.05);
    T(r1.v > r1.put, '⑬ 現金利率有算進去');
    console.log(`selftest ${ok} ok / ${bad} bad`);
    process.exit(bad ? 1 : 0);
}

// ---------- main ----------
function loadBars(p) {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    return r.map(x => ({ d: d10(x.date), c: num(x.close) })).filter(x => x.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
}
function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const DIR = process.env.DATA_DIR;
    if (!DIR) { console.error('需要 DATA_DIR'); process.exit(1); }
    const twii = loadBars(path.join(DIR, '^TWII.json')), b = loadBars(path.join(DIR, '_bench0050.json'));
    let divs = [];
    const dvp = process.env.DIV || path.join(DIR, '_div0050.json');
    if (fs.existsSync(dvp)) { const dv = JSON.parse(fs.readFileSync(dvp, 'utf8')); divs = ((dv.d || dv)['0050'] || {}).h || []; }
    if (!divs.length) { console.error('⛔ 讀不到 0050 股利 → 含息算不出來'); process.exit(1); }
    const S = align(twii, b, divs);
    if (S.d.length < 2000) { console.error('⛔ 對齊後只有', S.d.length, '天'); process.exit(1); }
    console.log(`資料 ${S.d[0]} ~ ${S.d[S.d.length - 1]}(${S.d.length} 天)・0050 含息 ${((S.tr.at(-1) - 1) * 100).toFixed(0)}%`);
    const out = { from: S.d[0], to: S.d.at(-1), A: [], B: [], C: [] };

    console.log('\n(A) 加權當天跌 ≥X% → 尾盤買 0050(含息),之後 h 天 vs 隨便挑一天');
    for (const X of XS) {
        const a = partA(S, X); out.A.push(a);
        console.log(`  跌 ≥${X}%:${a.n} 天・${a.ep} 段`);
        for (const h of HS) { const r = a.h[h]; if (!r.n) continue;
            console.log(`    ${String(h).padStart(3)} 天 平均 ${r.ev}% vs ${r.base}%  差 ${r.diff}pp・上漲 ${r.up}% vs ${r.upBase}%・p=${r.p}・前半 ${r.h1} / 後半 ${r.h2}`); }
    }
    console.log('\n(B) 手上 100 萬:一次買 L / 時間分 4 批 S4 / 等下次大跌再加 SD / 等 20 天 W20(第 H 天報酬 %、贏一次買的 %)');
    for (const X of XS) for (const H of [120, 250]) {
        const r = partB(S, X, H); out.B.push(r);
        const f = o => o.n ? `L ${o.L} ・S4 ${o.S4}(${o.S4win}%)・SD ${o.SD}(${o.SDwin}%)・W20 ${o.W20}(${o.W20win}%)・n=${o.n}` : 'n=0';
        console.log(`  跌 ≥${X}% H=${H}  大跌日:${f(r.ev)}`);
        console.log(`                隨便一天:${f(r.rnd)}`);
    }
    console.log('\n(C) 每月存 1 萬、10 年(每條起點隔 3 個月):最後市值 ÷ 總存入 −1(中位 / 最差 / 贏定期定額幾條)');
    for (const cashR of [0, 0.015]) for (const X of [2, 3]) {
        const c = partC(S, X, 10, cashR); out.C.push({ X, cashR, summary: c.summary, n: c.starts.length });
        console.log(`  跌 ≥${X}% 現金利率 ${cashR * 100}%(${c.starts.length} 條,${c.starts[0].from}~${c.starts.at(-1).from} 起)`);
        for (const m of CMODES) { const s = c.summary[m]; console.log(`    ${m.padEnd(7)} 中位 ${s.med}% ・最差 ${s.worst}% ・最好 ${s.best}%${s.beatDca == null ? '' : ` ・贏定期定額 ${s.beatDca}/${s.n}`}`); }
    }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
