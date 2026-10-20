#!/usr/bin/env node
/**
 * 🧬 個股泡泡圖「每一格」的期望值 —— 位階 × 振幅 分區實測
 *
 * 使用者:「附圖目前有高位階高波動圖示,沒有辦法新增其它半透明圖示?
 *          應該有可以買進時間,還是加碼時間,高檔過熱要賣等等,我沒有想到的,
 *          這樣有沒有用,還有我沒有想到的」
 *
 * ⛔⛔ **在畫任何一個新的框之前一定要先量** —— 憑感覺畫「買進區/過熱賣出區」
 *   正是本專案批評別人最多次的那種事(憑空門檻 + 沒驗證過的預測性主張)。
 *   而且「高檔過熱要賣」的方向,本專案先前多次實測是**相反**的
 *   (位階高檔 +1.76pp、RSI>70 +1.64pp、創一年新高 +3.30pp;「等回檔再買」21 個有 18 個負)。
 *
 * 這支量三件事:
 *   ① **分格**:位階 4 段 × 振幅 2 段 = 8 格,每一格的未來 20 日超額報酬
 *      → 圖上每一格才敢標數字(⛔ 不敢標的格子就不畫框)
 *   ② **剛進 🧬 框 vs 已經在裡面很久**(使用者問的「買進/加碼時間」的可測版本)
 *      → 「時機」在這張圖裡唯一量得到的東西就是「進來幾天了」
 *   ③ **離開 🧬 框之後**(使用者問的「什麼時候該賣」的可測版本)
 *
 * ⛔ 五條方法論(缺一條結論就會歪,跟本專案其他探針一致):
 *   ① 位階/振幅**只用到當天為止**的資料(零前視),而且跟前端 `_memSeries` **同一個定義**
 *      —— ⛔ 定義不同的話,量出來的數字貼到那張圖上就是騙人的。
 *   ② 進場價 = **隔天開盤**(這張圖是收盤後才看得到的),⛔ 排除隔天開盤仍鎖漲停(買不到)。
 *   ③ 報酬**扣同期加權指數**。
 *   ④ **同檔同格 20 日內只算一次**。
 *   ⑤ 六道關卡:全期正 → 前後半同向 → 逐年同向 → 去最好年 → 扣成本 0.44% → 對照組。
 *
 * 🔁 V79.4.3(16 年 d16 重跑前修,陷阱 #50 / #52):
 *   ・對照組改成**同一天**:每一筆的邊際 = 自己 − 同一個進場日(隔天開盤)全部股票同樣抱 20 天的平均(⛔ 不去重、那天 <30 檔 → 不算並計數);
 *     前後半 / 逐年 / 去最好年 / 中位數都看這個邊際(⛔ 舊版減的是整段的對照組平均 —— 某一格擠在某幾年時,那幾年的行情會被算成那一格的功勞)
 *   ・隔天開盤在漲停價 → 買不到:改走 lib_limit(2015-06 前 ±7%;⛔ 不再寫死 1.095)
 *   ・斷崖(lib_cliff)只剔碰到的窗口:位階往回 252 根 + 進框天數往回 20 根 → 抱滿那天(⛔ 舊版完全沒有斷崖守門)
 *   ・讀 DATA_DIR(⛔ 舊版寫死 data/)・MAX_SYMS=N 冒煙測試(平均抽樣)
 *
 * ⚠️ 已知限制:窗口整段偏多頭;倖存者偏誤(已下市的不在 data/ 裡)。
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物。
 * 用法:node --max-old-space-size=4096 scripts/genezone_probe.mjs [輸出.json]
 *       node scripts/genezone_probe.mjs --selftest(⛔ 不讀真資料)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upLimitClose } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDirOf = env => env.DATA_DIR || path.join(ROOT, 'data');   // 🔁 V79.4.3 讀 DATA_DIR(d16 那份)
const DATA = dataDirOf(process.env);
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => !a.startsWith('--')) || '';
const MAX_SYMS = +(process.env.MAX_SYMS || 0);   // 🔁 V79.4.3 冒煙測試用;0 = 全部

const FWD = 20;           // 未來幾個交易日
const DEDUP = 20;         // 同檔同格 20 日內只算一次
const WARM = 60;          // 至少要有這麼多根才算得出位階/振幅
const COST = 0.44;        // 來回手續費 + 證交稅
const GENE_POS = 75;      // 跟 pro.html 的 GENE_POS 一樣
const GENE_AMP = 3.2;     // 跟 pro.html 的 GENE_AMP 一樣(全市場 amp20 的 P60)
const MIN_EV = 500;       // 空過守門:一格至少要這麼多筆才報
const MIN_CTRL = 30;      // 🔁 V79.4.3 同一天對照組少於這麼多檔 → 那一筆不算(⛔ 不拿別天湊)
const BACK = 251 + 20;    // 🔁 V79.4.3 位階往回 251 根 + 進框天數往回 20 根 → 斷崖窗口的左端

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
const pickEven = (arr, max) => { if (!(max > 0) || arr.length <= max) return arr; const out = [], st = arr.length / max; for (let k = 0; k < max; k++) out.push(arr[Math.floor(k * st)]); return out; };

// ── 大盤(扣同期用)──
export function twiiCtx(raw) {
    const twii = {};
    for (const r of raw) { const c = +r.close; if (c > 0) twii[nd(r.date)] = c; }
    const tDays = Object.keys(twii).sort();
    return { twii, tDays, tIdx: new Map(tDays.map((d, i) => [d, i])) };
}

// 🚨 中點要用「**事件**日期的中位數」,⛔ 不可用「所有檔案出現過的日期」的中間值 ——
//    只要有一檔老股回溯到 2000 年,中點就會被拉到很早、前半段幾乎沒有樣本
//    → 「前後半同向」那一關等於沒作用(V74.0.2 limitup_probe 犯過同型的錯)。
export function midDateOf(raws) {
    const cnt = new Map();
    for (const raw of raws) {
        if (!Array.isArray(raw) || raw.length < WARM + FWD + 5) continue;
        for (let i = WARM; i + FWD + 1 < raw.length; i++) {
            const d = nd(raw[i].date); cnt.set(d, (cnt.get(d) || 0) + 1);
        }
    }
    const ds = [...cnt.keys()].sort();
    let tot = 0; for (const d of ds) tot += cnt.get(d);
    let acc = 0, mid = null;
    for (const d of ds) { acc += cnt.get(d); if (acc >= tot / 2) { mid = d; break; } }
    return { mid, first: ds[0], last: ds[ds.length - 1] };
}

// cell key: `p${0..3}a${0..1}`   ・ streak key: `s0/s1/s2/s3` ・ exit key: `x`
// acc.ctrl:進場日 → [Σ超額, 檔數](🔁 V79.4.3 同一天對照:那天全部合格的股·日,⛔ 不去重)
// acc.evs:[格, 超額(扣加權), 訊號日, 進場日](同檔同格 20 日去重)
// acc.allEx / allYr / allHalf:舊版那個對照組(每檔 20 日取一筆)—— 現在只拿來描述,⛔ 不再拿來算邊際
export const newAcc = () => ({ ctrl: new Map(), evs: [], allEx: [], allYr: {}, allHalf: [[], []], ampAll: [], nSym: 0, nLocked: 0, nCliff: 0 });

export function scanStock(raw, ctx, acc) {
    const { twii, tDays, tIdx, midDate } = ctx;
    if (!Array.isArray(raw)) return false;
    const rows = raw.filter(x => x && +x.close > 0);
    if (rows.length < WARM + FWD + 5) return false;
    acc.nSym++;
    const d = rows.map(x => nd(x.date));
    const c = rows.map(x => +x.close);
    const o = rows.map(x => +x.open || +x.close);
    const hi = rows.map(x => +x.high || +x.close);
    const lo = rows.map(x => +x.low || +x.close);
    const pre = cliffPrefix(c, o);   // 🔁 V79.4.3 斷崖前綴和(lib_cliff)

    // 位階 / 振幅(跟前端 `_memSeries` 同一個定義,零前視)
    const po = new Array(rows.length).fill(null), ap = new Array(rows.length).fill(null);
    for (let i = 20; i < rows.length; i++) {
        const s = Math.max(0, i - 251);
        let below = 0;
        for (let j = s; j <= i; j++) if (c[j] <= c[i]) below++;
        po[i] = below / (i - s + 1) * 100;
        let a = 0;
        for (let j = i - 19; j <= i; j++) a += (hi[j] - lo[j]) / c[j] * 100;
        ap[i] = a / 20;
        if (i % 37 === 0) acc.ampAll.push(ap[i]);
    }

    // 🧬 是否在框內 + 連續在框內幾天
    const inZ = po.map((v, i) => v != null && v >= GENE_POS && ap[i] >= GENE_AMP);
    const streak = new Array(rows.length).fill(0);
    for (let i = 1; i < rows.length; i++) streak[i] = inZ[i] ? streak[i - 1] + 1 : 0;

    const last = { };
    for (let i = WARM; i + FWD + 1 < rows.length; i++) {
        if (po[i] == null) continue;
        // ② 進場 = 隔天開盤;⛔ 排除隔天開盤就在漲停價(買不到)—— 🔁 V79.4.3 lib_limit:2015-06 前 ±7%
        const eo = o[i + 1];
        if (!(eo > 0)) continue;
        // 🔁 V79.4.3 窗口(位階 / 進框天數往回 → 抱滿那天)碰到斷崖 → 這一筆事件與對照組都不收(先判斷崖:×2 那根不是漲停)
        if (cliffIn(pre, i - BACK, i + FWD)) { acc.nCliff++; continue; }
        if (upLimitClose(d[i + 1], eo, c[i])) { acc.nLocked++; continue; }
        const ec = c[i + 1 + FWD - 1];
        if (!(ec > 0)) continue;
        const ti = tIdx.get(d[i + 1]), tj = tIdx.get(d[i + 1 + FWD - 1]);
        if (ti == null || tj == null) continue;
        const mk = (twii[tDays[tj]] / twii[tDays[ti]] - 1) * 100;
        const ex = (ec / eo - 1) * 100 - mk;
        // 🔁 V79.4.3 同一天對照組:同一個進場日的全部股·日(⛔ 不去重)
        { let a = acc.ctrl.get(d[i + 1]); if (!a) { a = [0, 0]; acc.ctrl.set(d[i + 1], a); } a[0] += ex; a[1]++; }

        const keys = [];
        // ① 分格:位階 4 段 × 振幅 2 段
        const pb = po[i] >= 75 ? 3 : po[i] >= 50 ? 2 : po[i] >= 25 ? 1 : 0;
        const ab = ap[i] >= GENE_AMP ? 1 : 0;
        keys.push(`p${pb}a${ab}`);
        // ② 剛進框 vs 待很久
        if (inZ[i]) {
            const s = streak[i];
            keys.push(s <= 1 ? 'z_new' : s <= 5 ? 'z_2_5' : s <= 20 ? 'z_6_20' : 'z_21p');
        }
        // ③ 剛掉出框(昨天在、今天不在)= 使用者問的「什麼時候該賣」的可測版本
        if (!inZ[i] && inZ[i - 1]) keys.push('z_exit');

        for (const k of keys) {
            if (last[k] != null && i - last[k] < DEDUP) continue;
            last[k] = i;
            acc.evs.push([k, ex, d[i], d[i + 1]]);
        }
        // 舊版對照組(同一批股·日,每檔 20 日取一筆)—— 只拿來描述
        if (last.__all == null || i - last.__all >= DEDUP) {
            last.__all = i;
            acc.allEx.push(ex);
            const y = d[i].slice(0, 4);
            (acc.allYr[y] = acc.allYr[y] || []).push(ex);
            acc.allHalf[d[i] < midDate ? 0 : 1].push(ex);
        }
    }
    return true;
}

/** 🔁 V79.4.3 每一筆事件 − 同一個進場日的對照組平均;那天 <minCtrl 檔 → 不算(計數)。回 { buckets: Map 格 → {ex,raw,yr,half}, nThin } */
export function finalize(acc, midDate, minCtrl = MIN_CTRL) {
    const buckets = new Map(); let nThin = 0;
    for (const [k, ex, sd, ed] of acc.evs) {
        const a = acc.ctrl.get(ed);
        if (!a || a[1] < minCtrl) { nThin++; continue; }
        const x = ex - a[0] / a[1];
        let B = buckets.get(k); if (!B) { B = { ex: [], raw: [], yr: {}, half: [[], []] }; buckets.set(k, B); }
        B.ex.push(x); B.raw.push(ex);
        const y = sd.slice(0, 4);
        (B.yr[y] = B.yr[y] || []).push(x);
        B.half[sd < midDate ? 0 : 1].push(x);
    }
    return { buckets, nThin };
}

export function rowOf(buckets, key, label, o = {}) {
    const B = buckets.get(key), minEv = o.minEv ?? MIN_EV;
    if (!B || B.ex.length < minEv) return { key, label, n: B ? B.ex.length : 0, skip: true };
    const a = B.ex;
    const edge = mean(a);
    const half = B.half.map(h => h.length >= 30 ? mean(h) : null);
    const yrKeys = o.yrKeys || Object.keys(B.yr).sort();   // 對照組那幾年(同舊版 JSON 的形狀:沒有的年份 = null)
    const yr = {}; for (const y of yrKeys) yr[y] = (B.yr[y] || []).length >= 30 ? mean(B.yr[y]) : null;
    const yv = Object.values(yr).filter(v => v != null);
    // 去掉最好那一年之後還剩多少
    let exBest = null;
    if (yv.length >= 2) {
        const bestY = Object.keys(yr).filter(y => yr[y] != null).sort((x, y2) => yr[y2] - yr[x])[0];
        const rest = [];
        // ⛔ push(...大陣列) 會爆呼叫堆疊 —— 一律逐筆
        for (const y of yrKeys) if (y !== bestY) for (const v of (B.yr[y] || [])) rest.push(v);
        if (rest.length >= 100) exBest = mean(rest);
    }
    const sameHalf = half[0] != null && half[1] != null && Math.sign(half[0]) === Math.sign(half[1]);
    const sameYr = yv.length >= 2 && yv.every(v => Math.sign(v) === Math.sign(yv[0]));
    return {
        key, label, n: a.length, edge, med: med(a),
        win: B.raw.filter(x => x > 0).length / B.raw.length * 100,
        half, yr, exBest, sameHalf, sameYr,
        pass: edge > 0 && sameHalf && sameYr && exBest > 0 && edge > COST,
    };
}

const CELLS = [
    ['p3a1', '位階 ≥75 × 振幅 ≥3.2%  🧬(現行框)'],
    ['p3a0', '位階 ≥75 × 振幅 <3.2%'],
    ['p2a1', '位階 50~75 × 振幅 ≥3.2%'],
    ['p2a0', '位階 50~75 × 振幅 <3.2%'],
    ['p1a1', '位階 25~50 × 振幅 ≥3.2%'],
    ['p1a0', '位階 25~50 × 振幅 <3.2%'],
    ['p0a1', '位階 <25 × 振幅 ≥3.2%'],
    ['p0a0', '位階 <25 × 振幅 <3.2%  ⛔(左下角)'],
];
const TIMING = [
    ['z_new', '🧬 剛進框(第 1 天)'],
    ['z_2_5', '🧬 進框第 2~5 天'],
    ['z_6_20', '🧬 進框第 6~20 天'],
    ['z_21p', '🧬 已經在框內 >20 天'],
    ['z_exit', '🚪 剛掉出框(昨天在、今天不在)'],
];

const fmt = v => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2);

function main() {
    const { twii, tDays, tIdx } = twiiCtx(JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')));
    const files = pickEven(fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort(), MAX_SYMS);
    console.log(`📂 ${files.length} 檔(⛔ 只收 4 碼股票,ETF/權證不計)${MAX_SYMS > 0 ? `・⚠️ MAX_SYMS=${MAX_SYMS} 冒煙測試(平均抽樣)` : ''}`);
    const readRaw = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return null; } };

    // pass 1:只為了求中點日期(依樣本數)
    let M;
    { const raws = function* () { for (const f of files) yield readRaw(f); }; M = midDateOf(raws()); }
    const midDate = M.mid;
    console.log(`🗓️ 事件涵蓋 ${M.first} ~ ${M.last}(依樣本數的中點 ${midDate})`);

    const acc = newAcc();
    for (const f of files) scanStock(readRaw(f), { twii, tDays, tIdx, midDate }, acc);
    const { buckets, nThin } = finalize(acc, midDate);

    const { allEx, allYr, allHalf } = acc;
    console.log(`📊 ${acc.nSym} 檔 ・對照組 ${allEx.length} 個(股·日)・排除「隔天開盤就在漲停價」${acc.nLocked} 筆(2015-06 前 ±7%)・🧱 窗口碰到斷崖 ${acc.nCliff} 筆`);
    console.log(`🔁 V79.4.3 邊際 = 每一筆 − 同一個進場日全部股票的平均(${acc.ctrl.size} 個進場日,⛔ 不再減整段平均)・那天 <${MIN_CTRL} 檔 → 剔除 ${nThin} 筆`);
    console.log(`📏 全市場 amp20 的 P60 實測 = ${pct(acc.ampAll, 0.60)?.toFixed(2)}%(程式用的門檻是 ${GENE_AMP}%)`);
    const baseM = mean(allEx), baseMed = med(allEx), baseWin = allEx.filter(x => x > 0).length / allEx.length * 100;
    console.log(`🎯 對照組(描述用):平均 ${baseM.toFixed(2)}% ・中位 ${baseMed.toFixed(2)}% ・勝率 ${baseWin.toFixed(1)}%`);

    // ── 報表 ──
    const yrKeys = Object.keys(allYr).sort();
    const baseYr = {}; for (const y of yrKeys) baseYr[y] = mean(allYr[y]);
    const baseHalf = allHalf.map(a => mean(a));

    function table(title, defs) {
        console.log(`\n${title}`);
        console.log('  格                                        n      邊際   中位   勝率   前半   後半  去最好年  扣成本  六關');
        const out = [];
        for (const [k, lbl] of defs) {
            const r = rowOf(buckets, k, lbl, { yrKeys });
            out.push(r);
            if (r.skip) { console.log(`  ${lbl.padEnd(36)} ${String(r.n).padStart(6)}   (樣本不足,不報)`); continue; }
            console.log(`  ${lbl.padEnd(36)} ${String(r.n).padStart(6)} ${fmt(r.edge).padStart(7)} ${fmt(r.med).padStart(6)} ${r.win.toFixed(1).padStart(6)}% ${fmt(r.half[0]).padStart(6)} ${fmt(r.half[1]).padStart(6)} ${fmt(r.exBest).padStart(8)} ${fmt(r.edge - COST).padStart(7)}   ${r.pass ? '✅' : '❌'}`);
        }
        return out;
    }

    const cells = table('📦 ① 分格(未來 20 日超額,pp;🔁 相對「同一個進場日的全部股票」)', CELLS);
    const timing = table('⏱️ ② 時機(進框幾天了 / 剛掉出框)', TIMING);

    // 🔍 逐年明細(六關「逐年同向」是最嚴的一關 —— 沒過的話要看得出是差在哪一年)
    console.log('\n🔍 逐年邊際(pp,相對同一天的對照組)');
    console.log('  格                                    ' + yrKeys.map(y => y.padStart(7)).join(''));
    for (const r of [...cells, ...timing]) {
        if (r.skip) continue;
        console.log(`  ${r.label.padEnd(36)}` + yrKeys.map(y => fmt(r.yr[y]).padStart(7)).join(''));
    }

    console.log(`\n🗓️ 逐年對照組平均(描述用):${yrKeys.map(y => `${y} ${baseYr[y].toFixed(2)}%(n=${allYr[y].length})`).join(' ・ ')}`);
    console.log('\n⚠️ 限制:窗口整段偏多頭;倖存者偏誤;進場=隔天開盤且已排除開盤就在漲停價;⛔ 這是「位置」不是「時機訊號」。');

    if (OUT) {
        fs.writeFileSync(OUT, JSON.stringify({
            base: { n: allEx.length, mean: baseM, med: baseMed, win: baseWin, yr: baseYr, half: baseHalf, mid: midDate },
            ctrl: 'same-day', minCtrl: MIN_CTRL, ctrlDays: acc.ctrl.size, ctrlThin: nThin, locked: acc.nLocked, cliff: acc.nCliff, maxSyms: MAX_SYMS || null,
            cells, timing, geneAmpP60: pct(acc.ampAll, 0.60), cost: COST, fwd: FWD,
        }, null, 1));
        console.log(`\n💾 ${OUT}`);
    }
}

// ═══════════ selftest(⛔ 不讀真資料)═══════════
function selftest() {
    let bad = 0;
    const ok = (nm, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${nm}${c ? '' : '  → ' + JSON.stringify(x)}`); if (!c) bad++; };
    const rng = seed => { let x = seed >>> 0 || 1; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
    const mkDates = (n, y0) => { const out = []; let t = Date.UTC(y0, 0, 2); while (out.length < n) { const dd = new Date(t); if (dd.getUTCDay() % 6) out.push(dd.toISOString().slice(0, 10)); t += 864e5; } return out; };
    const mkRows = (dates, drift, seed, mut) => { const r = rng(seed), rows = []; let p = 50; dates.forEach((dd, k) => { p *= 1 + drift(k) + (r() - 0.5) * 0.006; const op = p * (1 + (r() - 0.5) * 0.002); rows.push({ date: dd.replace(/-/g, '/'), open: op, high: p * 1.02, low: p * 0.98, close: p, volume: 1000 }); }); if (mut) mut(rows); return rows; };
    const ctxOf = dates => twiiCtx(dates.map(dd => ({ date: dd, close: 100 })));
    const run = (raws, dates, minCtrl) => {
        const T = ctxOf(dates), M = midDateOf(raws), acc = newAcc();
        for (const raw of raws) scanStock(raw, { ...T, midDate: M.mid }, acc);
        return { acc, M, ...finalize(acc, M.mid, minCtrl) };
    };

    // ① 🔁 同一天對照(決定性對照):全部股票同一條走勢(前段每天 +0.3%、後段 −0.2%)→ 🧬 框(高位階)擠在前段
    //    → 同一天比 ≈ 0;舊版(減整段對照組平均)憑空一大截
    {
        const N = 1500, dates = mkDates(N, 2012);
        const raws = []; for (let s = 0; s < 60; s++) raws.push(mkRows(dates, k => k < 750 ? 0.003 : -0.002, 10 + s));
        const R = run(raws, dates);
        const r = rowOf(R.buckets, 'p3a1', '', { minEv: 30 });
        const B = R.buckets.get('p3a1');
        const old = B ? mean(B.raw) - mean(R.acc.allEx) : null;
        ok(`① 🧬 框擠在大家都漲的前段:同一天比 ${fmt(r.edge)}pp ≈ 0(n=${r.n})`, !r.skip && Math.abs(r.edge) < 0.3, r);
        ok(`①b 決定性對照:同一批改減整段對照組平均(舊版)→ 憑空 ${fmt(old)}pp`, old != null && old > 2, old);
        ok(`①c 前後半 / 逐年 / 中位數也都是同一天比(前 ${fmt(r.half && r.half[0])} / 後 ${fmt(r.half && r.half[1])})`, !r.skip && r.half.every(v => v == null || Math.abs(v) < 0.5) && Object.values(r.yr).every(v => v == null || Math.abs(v) < 0.5) && Math.abs(r.med) < 0.5, r);
    }
    // ② 同一天對照組 <MIN_CTRL 檔 → 不算並計數
    {
        const N = 500, dates = mkDates(N, 2020);
        const raws = []; for (let s = 0; s < 20; s++) raws.push(mkRows(dates, () => 0.0005, 30 + s));
        const R = run(raws, dates), R2 = run(raws, dates, 20);
        ok(`② 一天只有 20 檔(<${MIN_CTRL}):事件全部不算(剔除 ${R.nThin})`, R.nThin > 0 && R.buckets.size === 0, R.nThin);
        ok('②b 同一批門檻降到 20 → 回來(⛔ 剔除只因為對照組太薄)', R2.nThin === 0 && R2.buckets.size > 0, R2.nThin);
    }
    // ③ 🔁 隔天開盤一價到底 +6.9%:2012(±7%)= 漲停買不到(事件與對照組都不收);同一根放 2020 照算
    {
        const one = y0 => {
            const N = 400, dates = mkDates(N, y0);
            const rows = mkRows(dates, () => 0, 50, rows => { const p = rows[199].close * 1.069; for (let k = 200; k < N; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= 1.069; const r = rows[200]; r.open = r.high = r.low = r.close = p; });
            const T = ctxOf(dates), acc = newAcc();
            scanStock(rows, { ...T, midDate: dates[200] }, acc);
            return { acc, d200: dates[200] };
        };
        const a = one(2012), b = one(2020);
        ok(`③ 2012 隔天開盤 +6.9% 鎖死 = 買不到(剔 ${a.acc.nLocked}、對照組那天沒收);2020 同一根照算(剔 ${b.acc.nLocked})`, a.acc.nLocked === 1 && !a.acc.ctrl.has(a.d200) && b.acc.nLocked === 0 && b.acc.ctrl.has(b.d200), [a.acc.nLocked, b.acc.nLocked]);
    }
    // ④ 🔁 斷崖只剔窗口:第 500 根 ×2 → 窗口(往回 271 根 ~ 抱滿那天)碰到它的股·日不收,前後照收;那一檔照樣算(⛔ 不整檔剔除)
    {
        const N = 1000, dates = mkDates(N, 2016);
        const rows = mkRows(dates, () => 0.0002, 70, rows => { for (let k = 500; k < N; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= 2; });
        const T = ctxOf(dates), acc = newAcc();
        scanStock(rows, { ...T, midDate: dates[600] }, acc);
        const inWin = []; for (let i = 500 - FWD; i <= 500 + BACK - 1; i++) if (acc.ctrl.has(dates[i + 1])) inWin.push(i);
        ok(`④ 窗口碰到斷崖的 ${acc.nCliff} 筆不收(違規 ${inWin.length})・之前(第 ${500 - FWD - 1} 根)/ 之後(第 ${500 + BACK} 根)照收`, acc.nSym === 1 && acc.nCliff === FWD + BACK && !inWin.length && acc.ctrl.has(dates[500 - FWD]) && acc.ctrl.has(dates[500 + BACK + 1]), { nCliff: acc.nCliff, inWin: inWin.length });
    }
    // ⑤ 🔁 DATA_DIR
    ok('⑤ 讀 DATA_DIR(沒給才用 repo 的 data/)', dataDirOf({ DATA_DIR: '/x/d16' }) === '/x/d16' && dataDirOf({}) === path.join(ROOT, 'data'));
    console.log(bad ? `\n❌ GENEZONE_SELFTEST_FAIL ${bad} 條` : '\n✅ GENEZONE_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (SELFTEST) process.exit(selftest());
else main();
