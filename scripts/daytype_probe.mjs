#!/usr/bin/env node
/**
 * 📅 日子 / 事件補測:加權指數在「排定的日子」前後 —— 方向有沒有規律、那一天顛不顛(2000 起,同一套方法一次量完)
 *
 * 為什麼要有這支:使用者 11/17「我想做一個反彈或易跌機率日期告警系統(結算見轉折、固定利多時間、星期幾、選舉…)」,
 *   追問「休市很久會有大波動 → 休市前買進、大波動後再賣出,邏輯有沒有錯」。
 *   查登記表:星期幾 / 月份 / 第四季 / 季底作帳 / 37 種行事曆日(個股層級、3 年)都測過 —— 方向 0 個可用,只有「顛不顛」成立。
 *   還沒量的:① 加權層級、長歷史的休市前後與結算日 ② 美股四巫日 / 每月選擇權結算 ③ 聯準會 / CPI / 非農(以前沒有官方歷史日期)
 *   ④ 選舉(次數太少)。這支的產物給 App「日子清單」當唯一的數字來源(⛔ 各處各寫各的)。
 *
 * 方法(事先登記,⛔ 看到結果再改):
 *   ・資料:加權價格指數 2000-01-04 起(idx_long_early + idx_long + ^TWII,跟 dipbuy_probe (E)~(H) 同一支 mergeIdx),收盤對收盤
 *   ・每一格 = 一種日子 × 一種量法。對照 = 「同一個星期幾、不是那種日子」的交易日
 *     (星期一本來就比較顛 → 不這樣比,非農 / 四巫之後的那個星期一會被算成「比較顛」;selftest ⑥ 決定性對照)
 *   ・p:照星期幾分層的隨機置換(雙尾,4,000 次);方向 20 格、顛不顛 12 格各自一起做 BH
 *   ・方向過關:n ≥ 30、q ≤ 0.05、前後半同向、|差| ≥ 0.27 個百分點(0050 來回成本);「結算見轉折」那格看轉折比例,|差| ≥ 5 個百分點
 *   ・比較顛:n ≥ 30、q ≤ 0.05、倍數 ≥ 1.10、前後半都 > 1(反過來 ≤ 0.91、前後半都 < 1 = 比較平靜)
 *   ・美國那天 → 台股:台北同一天的盤是「還沒公布」;公布後的反應 = 之後第一個交易日(隔超過 4 天 = 碰到連假,不算)
 *   ・選舉(各 6~7 次):只把每一次列出來,⛔ 進過關判定
 * ⚠️ 限制:價格指數不含息(一天的差別很小,除息旺季每天約 0.03~0.05%);結算日一律用「第三個星期三」
 *   (2008-12 以前最後結算日其實是隔天開盤的特別報價);聯準會只算排定的會議(臨時降息那種是突發事件,不是日子)。
 * ⛔ 只描述與比較,⛔ 不改 App。
 *
 * 跑法:IDX_LONG=data/idx_long.json IDX_EARLY=data/idx_long_early.json TWII_NOW='data/^TWII.json' US_CAL=research/us_cal.json \
 *        node scripts/daytype_probe.mjs out.json
 *      node scripts/daytype_probe.mjs --selftest
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { mergeIdx, bh } from './dipbuy_probe.mjs';

export const COST = 0.27;       // 0050 來回成本(%):手續費 6 折 ×2 + ETF 證交稅 0.1%(dipbuy_probe RT_COST_0050 = 0.271)
export const REV_MIN = 5;       // 結算見轉折:轉折比例至少差幾個百分點
export const VOL_MIN = 1.10;
export const N_MIN = 30;
export const Q_MAX = 0.05;
export const SIMS = 4000;
export const BIG = 1.5;         // 「大漲大跌」= 當天漲跌超過 1.5%
export const SPECIAL_YEARS = ['2008', '2020', '2022'];
export const MAX_LAG = 4;       // 美國那天之後第一個台股交易日,隔超過 4 天(碰到連假)→ 不算
// 台灣選舉投票日(都是星期六,當天不開盤)。總統 7 次與 2018 / 2022 地方選舉有查到來源;2001 / 2005 / 2009 / 2014 只做了「是星期六」的檢查
export const TW_PRES = ['2000-03-18', '2004-03-20', '2008-03-22', '2012-01-14', '2016-01-16', '2020-01-11', '2024-01-13'];
export const TW_LOCAL = ['2001-12-01', '2005-12-03', '2009-12-05', '2014-11-29', '2018-11-24', '2022-11-26'];
export const EL_HS = [1, 5, 20, 60];

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;
const r3 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 1000) / 1000;
const share = (a, f) => a.length ? a.filter(f).length / a.length * 100 : null;
export function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

// ── 日期 ──(一律字串 + UTC,⛔ 經過本地時區)
const T = d => Date.parse(d + 'T00:00:00Z');
export const dayDiff = (a, b) => Math.round((T(b) - T(a)) / 86400000);
export const addDays = (d, n) => new Date(T(d) + n * 86400000).toISOString().slice(0, 10);
export const wdOf = d => new Date(T(d)).getUTCDay();
/** 某年某月第 n 個星期 wd(0 = 日 … 6 = 六) */
export function nthWeekday(y, m, wd, n) {
    const first = new Date(Date.UTC(y, m - 1, 1));
    return new Date(Date.UTC(y, m - 1, 1 + ((wd - first.getUTCDay() + 7) % 7) + (n - 1) * 7)).toISOString().slice(0, 10);
}
/** 美國大選日:11 月第一個星期一之後的星期二 */
export const usElectionDay = y => addDays(nthWeekday(y, 11, 1, 1), 1);
function lb(d, x) { let lo = 0, hi = d.length; while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] < x) lo = m + 1; else hi = m; } return lo; }
export const idxOn = (d, x) => { const i = lb(d, x); return i < d.length && d[i] === x ? i : -1; };
export const idxAfter = (d, x, maxLag = MAX_LAG) => { const i = lb(d, addDays(x, 1)); return i < d.length && dayDiff(x, d[i]) <= maxLag ? i : -1; };
export const idxOnOrAfter = (d, x, maxLag = 10) => { const i = lb(d, x); return i < d.length && dayDiff(x, d[i]) <= maxLag ? i : -1; };
export const idxOnOrBefore = (d, x) => lb(d, addDays(x, 1)) - 1;
export const idxBefore = (d, x) => lb(d, x) - 1;

// ── 每一天的量 ──
export function series(S) {
    const { d, c } = S, n = d.length;
    const r1 = new Array(n).fill(null), gap = new Array(n).fill(null), wd = d.map(wdOf);
    for (let i = 1; i < n; i++) { r1[i] = (c[i] / c[i - 1] - 1) * 100; gap[i] = dayDiff(d[i - 1], d[i]); }
    const X = {
        day: r1,                                                                          // 前一天收盤 → 當天收盤
        next1: r1.map((_, i) => i + 1 < n ? r1[i + 1] : null),                            // 當天收盤 → 隔天收盤
        thru1: r1.map((_, i) => (i >= 1 && i + 1 < n) ? (c[i + 1] / c[i - 1] - 1) * 100 : null),   // 前一天收盤 → 隔天收盤
        fwd5: r1.map((_, i) => i + 5 < n ? (c[i + 5] / c[i] - 1) * 100 : null),           // 當天收盤 → 5 天後收盤
        abs: r1.map(v => v == null ? null : Math.abs(v)),
        // 轉折:前 5 天(到前一天為止)的方向,跟之後 5 天(從當天收盤起)相反 → 100,同向 → 0
        rev: r1.map((_, i) => { if (i < 6 || i + 5 >= n) return null; const a = c[i - 1] / c[i - 6] - 1, b = c[i + 5] / c[i] - 1;
            return (a === 0 || b === 0) ? null : (Math.sign(a) !== Math.sign(b) ? 100 : 0); }),
    };
    return { d, c, n, r1, gap, wd, X };
}

// ── 哪幾天是那種日子 ──
export function buildSets(Z, cal = {}) {
    const { d, n, gap } = Z, sets = {};
    const uniq = a => [...new Set(a.filter(i => i > 0))].sort((x, y) => x - y);
    const post = (lo, hi) => { const a = []; for (let i = 1; i < n; i++) if (gap[i] >= lo && gap[i] <= hi) a.push(i); return a; };
    sets.post45 = post(4, 5); sets.post6 = post(6, 9999);
    sets.pre45 = uniq(sets.post45.map(i => i - 1)); sets.pre6 = uniq(sets.post6.map(i => i - 1));
    const y0 = +d[0].slice(0, 4), y1 = +d[n - 1].slice(0, 4), settle = [], opx = [], wit = [];
    for (let y = y0; y <= y1; y++) for (let m = 1; m <= 12; m++) {
        const w3 = nthWeekday(y, m, 3, 3), f3 = nthWeekday(y, m, 5, 3);
        if (w3 >= d[0] && w3 <= d[n - 1]) settle.push(idxOnOrAfter(d, w3));        // 第三個星期三;那天休市 → 順延到下一個交易日
        if (f3 >= d[0] && f3 <= d[n - 1]) { opx.push(f3); if (m % 3 === 0) wit.push(f3); }
    }
    sets.settle = uniq(settle);
    sets.rev = []; for (let i = 1; i < n; i++) { const dom = +d[i].slice(8, 10); if (dom >= 9 && dom <= 11) sets.rev.push(i); }   // 跟 App 的 rev_day 同一條
    const us = (name, dates) => {
        const ds = [...new Set(dates || [])].filter(x => x >= d[0] && x <= d[n - 1]).sort();
        sets[name + 'Same'] = uniq(ds.map(x => idxOn(d, x))); sets[name + 'Next'] = uniq(ds.map(x => idxAfter(d, x))); sets[name + 'N'] = ds.length;
    };
    us('opx', opx); us('wit', wit);
    for (const k of ['fomc', 'cpi', 'nfp']) {
        if (Array.isArray(cal[k]) && cal[k].length) us(k, cal[k]); else { sets[k + 'Same'] = null; sets[k + 'Next'] = null; sets[k + 'N'] = 0; }
    }
    return sets;
}

// ── 每一格:哪種日子 × 怎麼量 ──
export function cellDefs(sets) {
    const C = [];
    const dir = (id, label, ev, x, min = COST) => C.push({ id, fam: 'dir', label, ev, x, min });
    const vol = (id, label, ev) => C.push({ id, fam: 'vol', label, ev, x: 'abs' });
    dir('pre45_day', '休市 4~5 天前的最後一個交易日・當天', sets.pre45, 'day');
    dir('pre6_day', '休市 6 天以上前的最後一個交易日・當天', sets.pre6, 'day');
    dir('thru45', '休市 4~5 天:休市前收盤買、開市第一天收盤賣', sets.post45, 'day');
    dir('thru6', '休市 6 天以上:休市前收盤買、開市第一天收盤賣', sets.post6, 'day');
    dir('thru45_1', '休市 4~5 天:休市前收盤買、開市第二天收盤賣', sets.post45, 'thru1');
    dir('thru6_1', '休市 6 天以上:休市前收盤買、開市第二天收盤賣', sets.post6, 'thru1');
    dir('settle_day', '台指期結算日・當天', sets.settle, 'day');
    dir('settle_next', '台指期結算日・隔天', sets.settle, 'next1');
    dir('settle_5', '台指期結算日收盤・之後 5 天', sets.settle, 'fwd5');
    dir('settle_rev', '結算見轉折:前 5 天的方向,之後 5 天反過來的比例', sets.settle, 'rev', REV_MIN);
    dir('wit_day', '美股四巫日・台北當天(美股還沒開盤)', sets.witSame, 'day');
    dir('wit_next', '美股四巫日・之後第一個交易日', sets.witNext, 'day');
    dir('opx_day', '美股每月選擇權結算(第三個星期五)・台北當天', sets.opxSame, 'day');
    dir('opx_next', '美股每月選擇權結算・之後第一個交易日', sets.opxNext, 'day');
    dir('fomc_day', '聯準會決議日・台北當天(還沒公布)', sets.fomcSame, 'day');
    dir('fomc_next', '聯準會決議・公布後第一個交易日', sets.fomcNext, 'day');
    dir('cpi_day', '美國 CPI 公布日・台北當天(還沒公布)', sets.cpiSame, 'day');
    dir('cpi_next', '美國 CPI・公布後第一個交易日', sets.cpiNext, 'day');
    dir('nfp_day', '美國非農公布日・台北當天(還沒公布)', sets.nfpSame, 'day');
    dir('nfp_next', '美國非農・公布後第一個交易日', sets.nfpNext, 'day');
    vol('v_pre45', '休市 4~5 天前的最後一個交易日', sets.pre45);
    vol('v_pre6', '休市 6 天以上前的最後一個交易日', sets.pre6);
    vol('v_post45', '休市 4~5 天後的第一個交易日', sets.post45);
    vol('v_post6', '休市 6 天以上後的第一個交易日', sets.post6);
    vol('v_settle', '台指期結算日當天', sets.settle);
    vol('v_settle_next', '台指期結算日隔天', sets.settle.map(i => i + 1).filter(i => i < 1e9));
    vol('v_rev', '月營收公布期(每月 9~11 日)', sets.rev);
    vol('v_wit_next', '美股四巫日之後第一個交易日', sets.witNext);
    vol('v_opx_next', '美股每月選擇權結算之後第一個交易日', sets.opxNext);
    vol('v_fomc_next', '聯準會決議公布後第一個交易日', sets.fomcNext);
    vol('v_cpi_next', '美國 CPI 公布後第一個交易日', sets.cpiNext);
    vol('v_nfp_next', '美國非農公布後第一個交易日', sets.nfpNext);
    return C;
}

/** 一格的統計。match=false → 對照不分星期幾(只給 selftest 的決定性對照用) */
export function cellStat(Z, cell, seed = 1, sims = SIMS, match = true) {
    const { d, wd, n: N } = Z, X = Z.X[cell.x], o = { id: cell.id, fam: cell.fam, label: cell.label };
    if (!cell.ev) return { ...o, nodata: true };
    const key = i => match ? wd[i] : 0;
    const ev = [...new Set(cell.ev)].filter(i => i >= 0 && i < N && X[i] != null);
    o.n = ev.length;
    if (ev.length < 3) return { ...o, few: true };
    /** 這批日子 vs 範圍內同星期幾、不是那種日子的對照 */
    const sub = (evs, keep) => {
        if (evs.length < 3) return null;
        const es = new Set(evs), b = {}, k = {};
        for (let i = 0; i < N; i++) { if (X[i] == null || es.has(i) || !keep(i)) continue; (b[key(i)] = b[key(i)] || []).push(X[i]); }
        for (const i of evs) k[key(i)] = (k[key(i)] || 0) + 1;
        let s = 0, su = 0, sb = 0, m = 0;
        for (const w in k) { const a = b[w]; if (!a || !a.length) continue; s += k[w] * mean(a); su += k[w] * share(a, x => x > 0); sb += k[w] * share(a, x => x >= BIG); m += k[w]; }
        if (!m) return null;
        const v = evs.map(i => X[i]), em = mean(v), bm = s / m;
        return { n: evs.length, ev: em, base: bm, diff: em - bm, ratio: bm ? em / bm : null, upBase: su / m, bigBase: sb / m };
    };
    const all = sub(ev, () => true);
    if (!all) return { ...o, few: true };
    const v = ev.map(i => X[i]);
    Object.assign(o, { ev: r3(all.ev), base: r3(all.base), med: r3(med(v)) });
    if (cell.fam === 'dir') Object.assign(o, { diff: r3(all.diff), up: r2(share(v, x => x > 0)), upBase: r2(all.upBase), worst: r2(Math.min(...v)), best: r2(Math.max(...v)) });
    else Object.assign(o, { ratio: r3(all.ratio), big: r2(share(v, x => x >= BIG)), bigBase: r2(all.bigBase) });
    // 分層隨機置換(雙尾):每個星期幾各抽跟那種日子一樣多的天數
    const pool = {}, nw = {};
    for (let i = 0; i < N; i++) if (X[i] != null) (pool[key(i)] = pool[key(i)] || []).push(X[i]);
    for (const i of ev) nw[key(i)] = (nw[key(i)] || 0) + 1;
    const mu = {}; for (const w in pool) mu[w] = mean(pool[w]);
    const tObs = ev.reduce((s, i) => s + (X[i] - mu[key(i)]), 0) / ev.length;
    const R = rng(seed), wk = Object.keys(nw); let ge = 0;
    for (let s = 0; s < sims; s++) {
        let sum = 0;
        for (const w of wk) { const a = pool[w], k = nw[w], seen = new Set(); let got = 0;
            while (got < k) { const j = Math.floor(R() * a.length); if (seen.has(j)) continue; seen.add(j); sum += a[j] - mu[w]; got++; } }
        if (Math.abs(sum / ev.length) >= Math.abs(tObs) - 1e-12) ge++;
    }
    o.p = +((ge + 1) / (sims + 1)).toFixed(4);
    // 前後半(照那種日子的時間對半切,對照也只用同一段)、逐年、拿掉特殊年、拿掉最極端的 2 次
    const cut = d[ev[ev.length >> 1]];
    const h1 = sub(ev.filter(i => d[i] < cut), i => d[i] < cut), h2 = sub(ev.filter(i => d[i] >= cut), i => d[i] >= cut);
    const pick = s => s ? (cell.fam === 'dir' ? r3(s.diff) : r3(s.ratio)) : null;
    o.cut = cut; o.h1 = pick(h1); o.h2 = pick(h2);
    const yrs = [...new Set(ev.map(i => d[i].slice(0, 4)))]; let win = 0, cnt = 0;
    for (const y of yrs) { const s = sub(ev.filter(i => d[i].slice(0, 4) === y), i => d[i].slice(0, 4) === y);
        if (!s) continue; cnt++; if (cell.fam === 'dir' ? Math.sign(s.diff) === Math.sign(all.diff) : (s.ratio > 1) === (all.ratio > 1)) win++; }
    o.yrsSame = win; o.yrsN = cnt;
    const sp = i => SPECIAL_YEARS.includes(d[i].slice(0, 4));
    o.exSpecial = pick(sub(ev.filter(i => !sp(i)), i => !sp(i)));
    const byDev = ev.slice().sort((a, b) => Math.abs(X[b] - all.base) - Math.abs(X[a] - all.base));
    o.exTail = pick(sub(byDev.slice(2), () => true));
    return o;
}

export function verdictOf(c, def) {
    if (c.nodata) return 'nodata';
    if (c.few || c.p == null) return 'few';
    if (c.fam === 'dir') {
        const ok = c.n >= N_MIN && c.q != null && c.q <= Q_MAX && c.h1 != null && c.h2 != null
            && Math.sign(c.h1) === Math.sign(c.diff) && Math.sign(c.h2) === Math.sign(c.diff) && Math.abs(c.diff) >= def.min;
        return ok ? 'pass' : 'none';
    }
    const sig = c.n >= N_MIN && c.q != null && c.q <= Q_MAX && c.h1 != null && c.h2 != null;
    if (sig && c.ratio >= VOL_MIN && c.h1 > 1 && c.h2 > 1) return 'wild';
    if (sig && c.ratio <= 1 / VOL_MIN && c.h1 < 1 && c.h2 < 1) return 'calm';
    return 'same';
}

/** 二項分布右尾:n 次裡至少 k 次,每次機率 p */
export function binomTail(n, k, p) {
    let s = 0;
    for (let i = k; i <= n; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); s += c * Math.pow(p, i) * Math.pow(1 - p, n - i); }
    return Math.min(1, s);
}

/** 選舉:只描述。美國(星期二)= 台北那天收盤當起點(結果台北隔天才出來);台灣(星期六)= 投票前最後一個交易日收盤當起點 */
export function elections(Z) {
    const { d, c, n } = Z, y0 = +d[0].slice(0, 4), y1 = +d[n - 1].slice(0, 4), usP = [], usM = [];
    for (let y = y0; y <= y1; y++) if (y % 2 === 0) (y % 4 === 0 ? usP : usM).push(usElectionDay(y));
    const keys = ['pre20', ...EL_HS.map(h => 'h' + h)], baseUp = {};
    const val = (b, k) => k === 'pre20' ? (b >= 20 ? (c[b] / c[b - 20] - 1) * 100 : null) : (b + (+k.slice(1)) < n ? (c[b + (+k.slice(1))] / c[b] - 1) * 100 : null);
    for (const k of keys) { const a = []; for (let i = 0; i < n; i++) { const x = val(i, k); if (x != null) a.push(x); } baseUp[k] = r2(share(a, x => x > 0)); }
    const study = (name, dates, baseIdx) => {
        const each = dates.filter(x => x >= d[0] && x <= d[n - 1]).map(x => { const b = baseIdx(x); if (b < 0) return null;
            const e = { date: x, base: d[b] }; for (const k of keys) e[k] = r2(val(b, k)); return e; }).filter(Boolean);
        const sum = {};
        for (const k of keys) { const v = each.map(e => e[k]).filter(x => x != null), up = v.filter(x => x > 0).length;
            sum[k] = { n: v.length, up, mean: r2(mean(v)), med: r2(med(v)), pUp: v.length ? +binomTail(v.length, up, baseUp[k] / 100).toFixed(3) : null }; }
        return { name, n: each.length, each, sum };
    };
    return { baseUp, sets: [
        study('美國總統大選', usP, x => idxOnOrBefore(d, x)), study('美國期中選舉', usM, x => idxOnOrBefore(d, x)),
        study('台灣總統大選', TW_PRES, x => idxBefore(d, x)), study('台灣縣市長選舉', TW_LOCAL, x => idxBefore(d, x)) ] };
}

export function run(S, cal = {}, { seed = 20261117, sims = SIMS } = {}) {
    const Z = series(S), sets = buildSets(Z, cal), defs = cellDefs(sets);
    const cells = defs.map((c, k) => cellStat(Z, c, seed + k, sims));
    for (const fam of ['dir', 'vol']) { const cs = cells.filter(c => c.fam === fam && c.p != null), q = bh(cs.map(c => c.p)); cs.forEach((c, i) => { c.q = q[i]; }); }
    cells.forEach((c, k) => { c.verdict = verdictOf(c, defs[k]); });
    // 星期幾本來的樣子(描述):每個星期幾當天漲跌幅絕對值的平均
    const wdAbs = {}; for (let w = 1; w <= 6; w++) { const a = []; for (let i = 1; i < Z.n; i++) if (Z.wd[i] === w) a.push(Math.abs(Z.r1[i])); if (a.length >= 30) wdAbs[w] = { n: a.length, abs: r3(mean(a)) }; }
    const all = Z.r1.filter(x => x != null);
    return { meta: { from: Z.d[0], to: Z.d[Z.n - 1], days: Z.n, absAll: r3(mean(all.map(Math.abs))), upAll: r2(share(all, x => x > 0)), bigAll: r2(share(all, x => Math.abs(x) >= BIG)),
        counts: { post45: sets.post45.length, post6: sets.post6.length, settle: sets.settle.length, opx: sets.opxN, wit: sets.witN, fomc: sets.fomcN, cpi: sets.cpiN, nfp: sets.nfpN },
        rule: { COST, REV_MIN, VOL_MIN, N_MIN, Q_MAX, SIMS: sims, BIG, MAX_LAG, seed } }, cells, wdAbs, elect: elections(Z) };
}

export function print(o) {
    const m = o.meta;
    console.log(`===== 日子 / 事件補測:加權 ${m.from} ~ ${m.to}(${m.days} 天)・平常一天漲跌絕對值平均 ${m.absAll}%、上漲 ${m.upAll}%、漲跌超過 ${BIG}% 的日子 ${m.bigAll}% =====`);
    console.log('次數:', JSON.stringify(m.counts));
    console.log('\n── 方向(對照 = 同星期幾、不是那種日子;差 = 那種日子 − 對照,單位 %)──');
    for (const c of o.cells.filter(x => x.fam === 'dir')) {
        if (c.nodata) { console.log(`  ⬜ ${c.label}:沒有日期、沒測`); continue; }
        if (c.few) { console.log(`  ⬜ ${c.label}:只有 ${c.n} 次、不算`); continue; }
        console.log(`  ${c.verdict === 'pass' ? '✅' : '➖'} ${c.label}:${c.n} 次・平均 ${c.ev}(對照 ${c.base}・差 ${c.diff})・中位 ${c.med}・上漲 ${c.up}%(對照 ${c.upBase}%)`
            + `・p ${c.p} q ${c.q}・前半 ${c.h1} / 後半 ${c.h2}・逐年同向 ${c.yrsSame}/${c.yrsN}・拿掉特殊年 ${c.exSpecial}・拿掉最極端 2 次 ${c.exTail}・最差 ${c.worst} / 最好 ${c.best}`);
    }
    console.log(`\n── 顛不顛(當天漲跌絕對值的平均;倍數 = 那種日子 ÷ 同星期幾的平常日子;大漲大跌 = 超過 ${BIG}%)──`);
    for (const c of o.cells.filter(x => x.fam === 'vol')) {
        if (c.nodata) { console.log(`  ⬜ ${c.label}:沒有日期、沒測`); continue; }
        if (c.few) { console.log(`  ⬜ ${c.label}:只有 ${c.n} 次、不算`); continue; }
        console.log(`  ${c.verdict === 'wild' ? '🌊' : c.verdict === 'calm' ? '🧊' : '➖'} ${c.label}:${c.n} 次・${c.ev}% vs ${c.base}% = ${c.ratio} 倍・大漲大跌 ${c.big}%(對照 ${c.bigBase}%)`
            + `・p ${c.p} q ${c.q}・前半 ${c.h1} / 後半 ${c.h2}・逐年同向 ${c.yrsSame}/${c.yrsN}・拿掉特殊年 ${c.exSpecial}・拿掉最極端 2 次 ${c.exTail}`);
    }
    console.log('\n星期幾本來的樣子(當天漲跌絕對值平均):', Object.entries(o.wdAbs).map(([w, x]) => `星期${'日一二三四五六'[w]} ${x.abs}%(${x.n} 天)`).join('・'));
    console.log('\n── 選舉(只描述;「任何一天」= 隨便挑一天同樣量法上漲的比例)──');
    console.log('  任何一天上漲比例:', JSON.stringify(o.elect.baseUp));
    for (const s of o.elect.sets) {
        console.log(`  ${s.name}(${s.n} 次):` + Object.entries(s.sum).map(([k, x]) => `${k === 'pre20' ? '選前 20 天' : '之後 ' + k.slice(1) + ' 天'} ${x.up}/${x.n} 漲・平均 ${x.mean}%(碰巧這麼多次的機率 ${x.pUp})`).join('・'));
        for (const e of s.each) console.log(`     ${e.date}(起點 ${e.base}):選前 20 天 ${e.pre20}・` + EL_HS.map(h => `+${h} 天 ${e['h' + h]}`).join('・'));
    }
}

// ---------- selftest ----------
function selftest() {
    let ok = 0, bad = 0;
    const TT = (c, msg, got) => { if (c) { ok++; console.log('✅ ' + msg); } else { bad++; console.log('❌ ' + msg + (got !== undefined ? '  ' + JSON.stringify(got).slice(0, 300) : '')); } };
    // ① 日期
    TT(nthWeekday(2026, 11, 3, 3) === '2026-11-18' && nthWeekday(2026, 12, 5, 3) === '2026-12-18' && nthWeekday(2026, 11, 3, 1) === '2026-11-04',
        '① 第三個星期三 / 第三個星期五(2026-11-18 結算、2026-12-18 四巫)');
    TT(usElectionDay(2026) === '2026-11-03' && usElectionDay(2024) === '2024-11-05' && usElectionDay(2016) === '2016-11-08' && usElectionDay(2022) === '2022-11-08' && usElectionDay(2000) === '2000-11-07',
        '①b 美國大選日 = 11 月第一個星期一之後的星期二(2000 / 2016 / 2022 / 2024 / 2026)');
    TT([...TW_PRES, ...TW_LOCAL].every(x => wdOf(x) === 6), '①c 台灣選舉投票日都是星期六');
    // 合成行事曆:平日;每年 2/8~2/14、10/8~10/14 整週休(間隔 ≥ 8 天)、4 月第一個星期一休(星期五 → 星期二 = 4 天)
    const mkDays = (y0 = 2000, y1 = 2025, extraOff = []) => { const days = [];
        for (let t = Date.UTC(y0, 0, 3); t <= Date.UTC(y1, 11, 31); t += 86400000) { const dt = new Date(t), w = dt.getUTCDay(); if (w === 0 || w === 6) continue;
            const s = dt.toISOString().slice(0, 10), m = dt.getUTCMonth() + 1, dom = dt.getUTCDate();
            if ((m === 2 || m === 10) && dom >= 8 && dom <= 14) continue; if (m === 4 && w === 1 && dom <= 7) continue; if (extraOff.includes(s)) continue; days.push(s); }
        return days; };
    const gauss = R => { let u = 0, v = 0; while (u === 0) u = R(); while (v === 0) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    /** inj(i, sets, d) → { add, mul }(那一天的報酬 = 0.03 + add + σ × mul × 常態) */
    const mk = ({ seed = 7, sigma = 1, inj = null, cal = {}, extraOff = [] } = {}) => {
        const d = mkDays(2000, 2025, extraOff), Z0 = series({ d, c: d.map(() => 100) }), sets = buildSets(Z0, cal), R = rng(seed), c = [100];
        const S = {}; for (const k in sets) if (Array.isArray(sets[k])) S[k] = new Set(sets[k]);
        for (let i = 1; i < d.length; i++) { const j = inj ? inj(i, S, d) : null; c.push(c[i - 1] * (1 + (0.03 + (j && j.add || 0) + sigma * (j && j.mul || 1) * gauss(R)) / 100)); }
        return { S: { d, c }, cal };
    };
    const firstFri = () => { const a = []; for (let y = 2000; y <= 2025; y++) for (let m = 1; m <= 12; m++) a.push(nthWeekday(y, m, 5, 1)); return a; };
    // ② 哪幾天是那種日子
    { const { S } = mk(), Z = series(S), s = buildSets(Z, {});
        TT(s.post6.length === 52 && s.post45.length === 26 && s.post6.every(i => Z.gap[i] >= 6) && s.post45.every(i => Z.gap[i] === 4),
            '② 休市 6 天以上每年 2 次、4~5 天每年 1 次(照實際的交易日間隔算)', [s.post6.length, s.post45.length]);
        TT(s.pre6.every((i, k) => i === s.post6[k] - 1), '②b 休市前最後一個交易日 = 開市那天的前一根');
        TT(s.settle.length === 26 * 12 && s.settle.every(i => Z.wd[i] === 3), '②c 結算日每月 1 次、都是星期三', s.settle.length);
        TT(s.fomcSame === null && s.cpiNext === null, '②d 沒給美國日期 → 那幾組是 null(⛔ 當成 0 次)'); }
    { const { S } = mk({ extraOff: ['2010-06-16'] }), Z = series(S), s = buildSets(Z, {});
        TT(s.settle.some(i => Z.d[i] === '2010-06-17') && !s.settle.some(i => Z.d[i].startsWith('2010-06-16')), '②e 第三個星期三休市 → 結算順延到下一個交易日(2010-06-17)'); }
    { const { S } = mk(), d = S.d;
        TT(idxOn(d, '2010-02-10') === -1 && idxAfter(d, '2010-02-05') === -1 && d[idxAfter(d, '2010-03-05')] === '2010-03-08' && d[idxOnOrBefore(d, '2010-02-10')] === '2010-02-05' && d[idxBefore(d, '2010-03-08')] === '2010-03-05',
            '②f 美國那天台股沒開 → 不算當天;之後第一個交易日隔超過 4 天(2/5 → 2/15)→ 不算;星期五 → 星期一照算'); }
    // ③ 什麼都沒埋:格數對、而且換 40 組亂數,碰巧有格子過關的不超過 4 組(10%)
    //   一次比 20 + 12 格、BH 5% 本來就容許少數碰巧 → 量比例,⛔ 只跑 1 組(第一版剛好碰到 p 0.002 那一組)。
    //   另外量過 300 組:方向 8 組(2.7%)、顛不顛 3 組(1.0%),每一格 p ≤ 0.05 的比例都在 5% 上下 = 沒有偏
    { const cal = { fomc: firstFri(), cpi: firstFri().map(x => addDays(x, 5)), nfp: firstFri() }; let hit = 0, dirN = 0, volN = 0;
        for (let k = 0; k < 40; k++) { const { S } = mk({ seed: 100 + k, cal }), o = run(S, cal, { sims: 400, seed: 900 + k });
            dirN = o.cells.filter(c => c.fam === 'dir').length; volN = o.cells.filter(c => c.fam === 'vol').length;
            if (o.cells.some(c => ['pass', 'wild', 'calm'].includes(c.verdict))) hit++; }
        TT(dirN === 20 && volN === 12, '③ 方向 20 格、顛不顛 12 格(登記的格數)', [dirN, volN]);
        TT(hit <= 4, `③b 什麼都沒埋、換 40 組亂數 → 碰巧有格子過關的不超過 4 組(實際 ${hit} 組)`, hit); }
    // ④ 結算日當天埋 +0.6% / −0.6%
    for (const add of [0.6, -0.6]) { const { S } = mk({ inj: (i, s) => s.settle.has(i) ? { add } : null }), o = run(S), g = id => o.cells.find(c => c.id === id);
        TT(g('settle_day').verdict === 'pass' && Math.sign(g('settle_day').diff) === Math.sign(add) && Math.abs(g('settle_day').diff - add) < 0.2 && g('settle_next').verdict === 'none',
            `④ 結算日當天埋 ${add}% → 那一格過關、差 ≈ ${add};隔天那格不過(${add < 0 ? '雙尾:負的也抓得到' : '只在埋的那格'})`, [g('settle_day'), g('settle_next').verdict]); }
    // ⑤ 休市 6 天以上後第一天波動 ×2
    { const { S } = mk({ inj: (i, s) => s.post6.has(i) ? { mul: 2 } : null }), o = run(S), c = o.cells.find(x => x.id === 'v_post6'), t = o.cells.find(x => x.id === 'thru6');
        TT(c.verdict === 'wild' && c.ratio > 1.6 && c.ratio < 2.4 && t.verdict === 'none', '⑤ 長假後第一天波動 ×2 → 「比較顛」、倍數 ≈ 2;方向那格(休市前買、開市賣)不過(顛 ≠ 會漲)', [c, t.verdict]); }
    // ⑥ 決定性對照:所有星期一波動 ×1.6;非農(第一個星期五)之後的那天都是星期一
    { const cal = { nfp: firstFri() }, { S } = mk({ cal, inj: (i, s, d) => wdOf(d[i]) === 1 ? { mul: 1.6 } : null }), Z = series(S), sets = buildSets(Z, cal);
        const def = cellDefs(sets).find(c => c.id === 'v_nfp_next'), a = cellStat(Z, def, 3, 2000, true), b = cellStat(Z, def, 3, 2000, false);
        TT(a.ratio > 0.88 && a.ratio < 1.12 && b.ratio > 1.3, '⑥ ⭐ 決定性對照:星期一本來就比較顛 → 跟「別的星期一」比 ≈ 1 倍(不分星期幾會算成 ' + b.ratio + ' 倍)', [a.ratio, b.ratio]); }
    // ⑦ 前後半不同向 → 不過(前半 +1.2、後半 −0.2)
    { const { S } = mk({ inj: (i, s, d) => s.settle.has(i) ? { add: d[i] < '2013-01-01' ? 1.2 : -0.2 } : null }), o = run(S), c = o.cells.find(x => x.id === 'settle_day');
        TT(c.q <= Q_MAX && c.h1 > 0 && c.h2 < 0 && c.verdict === 'none', '⑦ 整段看起來顯著、但前後半不同向 → 不過', c); }
    // ⑧ 比成本小 → 不過(波動調小讓它顯著)
    { const { S } = mk({ sigma: 0.3, inj: (i, s) => s.settle.has(i) ? { add: 0.15 } : null }), o = run(S), c = o.cells.find(x => x.id === 'settle_day');
        TT(c.q <= Q_MAX && Math.abs(c.diff) < COST && c.verdict === 'none', '⑧ 顯著但差距比來回成本小(0.15 < 0.27)→ 不過', c); }
    // ⑨ 次數不到 30 → 不過(休市 4~5 天每年只有 1 次 = 26 次)
    { const { S } = mk({ inj: (i, s) => s.post45.has(i) ? { add: 3 } : null }), o = run(S), c = o.cells.find(x => x.id === 'thru45');
        TT(c.n === 26 && c.q <= Q_MAX && c.verdict === 'none', '⑨ 效果再大、次數不到 30 → 不過', c); }
    // ⑩ 量法
    { const d = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09', '2020-01-10', '2020-01-13', '2020-01-14', '2020-01-15', '2020-01-16', '2020-01-17', '2020-01-20'],
        c = [100, 101, 102, 103, 104, 105, 106, 105, 104, 103, 102, 101, 100], Z = series({ d, c });
        TT(Z.X.rev[6] === 100 && Z.X.rev[5] === null && Math.abs(Z.X.thru1[6] - (105 / 105 - 1) * 100) < 1e-9 && Math.abs(Z.X.fwd5[6] - (101 / 106 - 1) * 100) < 1e-9 && Z.gap[2] === 3 && Z.X.day[0] === null,
            '⑩ 轉折(前 5 天漲、之後 5 天跌 → 100)・前一天收盤到隔天收盤・之後 5 天・間隔天數', [Z.X.rev[6], Z.X.thru1[6], Z.X.fwd5[6]]); }
    // ⑪ 選舉
    { const { S } = mk(), Z = series(S), e = elections(Z), us = e.sets[0], tw = e.sets[2];
        TT(us.n === 7 && us.each[0].date === '2000-11-07' && us.each.every(x => x.base === x.date) && e.sets[1].each.some(x => x.date === '2022-11-08'),
            '⑪ 美國總統大選 2000~2024 共 7 次、起點 = 台北那天收盤;期中選舉另外一組', us.each.map(x => x.date));
        TT(tw.n === 7 && tw.each.every(x => x.base < x.date && dayDiff(x.base, x.date) <= 3), '⑪b 台灣選舉(星期六)起點 = 投票前最後一個交易日', tw.each.map(x => [x.date, x.base]));
        TT(Math.abs(binomTail(7, 6, 0.6) - (7 * Math.pow(0.6, 6) * 0.4 + Math.pow(0.6, 7))) < 1e-12 && Math.abs(binomTail(5, 0, 0.3) - 1) < 1e-12 && Math.abs(binomTail(6, 6, 0.5) - 1 / 64) < 1e-12,
            '⑪c 二項分布右尾(7 次裡至少 6 次、至少 0 次 = 1、6 次全中 = 1/64)'); }
    // ⑫ 沒給美國日期 → 那幾格 nodata、BH 只算有跑的
    { const { S } = mk(), o = run(S, {}, { sims: 300 }), nd = o.cells.filter(c => c.verdict === 'nodata').map(c => c.id);
        TT(nd.length === 9 && o.cells.filter(c => c.fam === 'dir' && c.q != null).length === 14, '⑫ 沒給聯準會 / CPI / 非農日期 → 9 格寫沒測(⛔ 當成 0)、BH 只算有跑的 14 格', nd); }
    console.log(bad ? `\n❌ ${bad} 條失敗` : `\n✅ DAYTYPE_SELFTEST_PASS(${ok} 條)`);
    process.exit(bad ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const rd = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!process.env.IDX_LONG) { console.error('要給 IDX_LONG(見檔頭的跑法)'); process.exit(1); }
    const S = mergeIdx(rd(process.env.IDX_LONG), process.env.IDX_EARLY ? rd(process.env.IDX_EARLY) : null, process.env.TWII_NOW ? rd(process.env.TWII_NOW) : null);
    const cal = process.env.US_CAL ? rd(process.env.US_CAL) : {};
    const o = run(S, cal);
    print(o);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(o, null, 1));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
