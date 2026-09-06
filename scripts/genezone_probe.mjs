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
 * ⚠️ 已知限制:窗口整段偏多頭;倖存者偏誤(已下市的不在 data/ 裡)。
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物。
 * 用法:node --max-old-space-size=4096 scripts/genezone_probe.mjs [輸出.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = process.argv[2] || '';

const FWD = 20;           // 未來幾個交易日
const DEDUP = 20;         // 同檔同格 20 日內只算一次
const WARM = 60;          // 至少要有這麼多根才算得出位階/振幅
const COST = 0.44;        // 來回手續費 + 證交稅
const GENE_POS = 75;      // 跟 pro.html 的 GENE_POS 一樣
const GENE_AMP = 3.2;     // 跟 pro.html 的 GENE_AMP 一樣(全市場 amp20 的 P60)
const MIN_EV = 500;       // 空過守門:一格至少要這麼多筆才報

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };

// ── 大盤(扣同期用)──
const twii = {};
{
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    for (const r of raw) { const c = +r.close; if (c > 0) twii[nd(r.date)] = c; }
}
const tDays = Object.keys(twii).sort();
const tIdx = new Map(tDays.map((d, i) => [d, i]));

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f));
console.log(`📂 ${files.length} 檔(⛔ 只收 4 碼股票,ETF/權證不計)`);

// ── 收樣本 ──
// cell key: `p${0..3}a${0..1}`   ・ streak key: `s0/s1/s2/s3` ・ exit key: `x`
const buckets = new Map();          // key → [超額報酬…]
const meta = new Map();             // key → {yr:{}, half:[[],[]]}
const allEx = [];                   // 對照組
const allYr = {}, allHalf = [[], []];
let midDate = null;

// 先掃一輪拿到樣本的實際中點(⛔ 不可用大盤日期軸 —— 個股比大盤短,那一關會等於沒作用)
const seenDates = new Set();

function push(key, ex, date) {
    if (!buckets.has(key)) { buckets.set(key, []); meta.set(key, { yr: {}, half: [[], []] }); }
    buckets.get(key).push(ex);
    const m = meta.get(key);
    const y = date.slice(0, 4);
    (m.yr[y] = m.yr[y] || []).push(ex);
    m.half[date < midDate ? 0 : 1].push(ex);
}

// pass 1:只為了求中點日期
for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(raw) || raw.length < WARM + FWD + 5) continue;
    for (const r of raw) if (+r.close > 0) seenDates.add(nd(r.date));
}
{
    // 🚨 中點要用「**事件**日期的中位數」,⛔ 不可用「所有檔案出現過的日期」的中間值 ——
    //    只要有一檔老股回溯到 2000 年,中點就會被拉到很早、前半段幾乎沒有樣本
    //    → 「前後半同向」那一關等於沒作用(V74.0.2 limitup_probe 犯過同型的錯)。
    const cnt = new Map();
    for (const f of files) {
        let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
        if (!Array.isArray(raw) || raw.length < WARM + FWD + 5) continue;
        for (let i = WARM; i + FWD + 1 < raw.length; i++) {
            const d = nd(raw[i].date); cnt.set(d, (cnt.get(d) || 0) + 1);
        }
    }
    const ds = [...cnt.keys()].sort();
    let tot = 0; for (const d of ds) tot += cnt.get(d);
    let acc = 0;
    for (const d of ds) { acc += cnt.get(d); if (acc >= tot / 2) { midDate = d; break; } }
    console.log(`🗓️ 事件涵蓋 ${ds[0]} ~ ${ds[ds.length - 1]}(依樣本數的中點 ${midDate})`);
}

let nSym = 0, nLocked = 0;
const ampAll = [];

for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(raw)) continue;
    const rows = raw.filter(x => x && +x.close > 0);
    if (rows.length < WARM + FWD + 5) continue;
    nSym++;
    const d = rows.map(x => nd(x.date));
    const c = rows.map(x => +x.close);
    const o = rows.map(x => +x.open || +x.close);
    const hi = rows.map(x => +x.high || +x.close);
    const lo = rows.map(x => +x.low || +x.close);

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
        if (i % 37 === 0) ampAll.push(ap[i]);
    }

    // 🧬 是否在框內 + 連續在框內幾天
    const inZ = po.map((v, i) => v != null && v >= GENE_POS && ap[i] >= GENE_AMP);
    const streak = new Array(rows.length).fill(0);
    for (let i = 1; i < rows.length; i++) streak[i] = inZ[i] ? streak[i - 1] + 1 : 0;

    const last = { };
    for (let i = WARM; i + FWD + 1 < rows.length; i++) {
        if (po[i] == null) continue;
        // ② 進場 = 隔天開盤;⛔ 排除隔天開盤仍鎖漲停(買不到)
        const eo = o[i + 1];
        if (!(eo > 0)) continue;
        if (eo >= c[i] * 1.095) { nLocked++; continue; }
        const ec = c[i + 1 + FWD - 1];
        if (!(ec > 0)) continue;
        const ti = tIdx.get(d[i + 1]), tj = tIdx.get(d[i + 1 + FWD - 1]);
        if (ti == null || tj == null) continue;
        const mk = (twii[tDays[tj]] / twii[tDays[ti]] - 1) * 100;
        const ex = (ec / eo - 1) * 100 - mk;

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
            push(k, ex, d[i]);
        }
        // 對照組(同一批股·日,⛔ 不抽樣)
        if (last.__all == null || i - last.__all >= DEDUP) {
            last.__all = i;
            allEx.push(ex);
            const y = d[i].slice(0, 4);
            (allYr[y] = allYr[y] || []).push(ex);
            allHalf[d[i] < midDate ? 0 : 1].push(ex);
        }
    }
}

console.log(`📊 ${nSym} 檔 ・對照組 ${allEx.length} 個(股·日)・排除「隔天開盤仍鎖漲停」${nLocked} 筆`);
console.log(`📏 全市場 amp20 的 P60 實測 = ${pct(ampAll, 0.60)?.toFixed(2)}%(程式用的門檻是 ${GENE_AMP}%)`);
const baseM = mean(allEx), baseMed = med(allEx), baseWin = allEx.filter(x => x > 0).length / allEx.length * 100;
console.log(`🎯 對照組:平均 ${baseM.toFixed(2)}% ・中位 ${baseMed.toFixed(2)}% ・勝率 ${baseWin.toFixed(1)}%`);

// ── 報表 ──
const yrKeys = Object.keys(allYr).sort();
const baseYr = {}; for (const y of yrKeys) baseYr[y] = mean(allYr[y]);
const baseHalf = allHalf.map(a => mean(a));

function row(key, label) {
    const a = buckets.get(key);
    if (!a || a.length < MIN_EV) return { key, label, n: a ? a.length : 0, skip: true };
    const m = meta.get(key);
    const edge = mean(a) - baseM;
    const half = m.half.map((h, i) => h.length >= 30 ? mean(h) - baseHalf[i] : null);
    const yr = {}; for (const y of yrKeys) yr[y] = (m.yr[y] || []).length >= 30 ? mean(m.yr[y]) - baseYr[y] : null;
    const yv = Object.values(yr).filter(v => v != null);
    // 去掉最好那一年之後還剩多少
    let exBest = null;
    if (yv.length >= 2) {
        const bestY = Object.keys(yr).filter(y => yr[y] != null).sort((x, y2) => yr[y2] - yr[x])[0];
        const rest = [], restBase = [];
        // ⛔ push(...大陣列) 會爆呼叫堆疊 —— 一律逐筆
        for (const y of yrKeys) if (y !== bestY && (m.yr[y] || []).length) { for (const v of m.yr[y]) rest.push(v); for (const v of allYr[y]) restBase.push(v); }
        if (rest.length >= 100) exBest = mean(rest) - mean(restBase);
    }
    const sameHalf = half[0] != null && half[1] != null && Math.sign(half[0]) === Math.sign(half[1]);
    const sameYr = yv.length >= 2 && yv.every(v => Math.sign(v) === Math.sign(yv[0]));
    return {
        key, label, n: a.length, edge, med: med(a) - baseMed,
        win: a.filter(x => x > 0).length / a.length * 100,
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
function table(title, defs) {
    console.log(`\n${title}`);
    console.log('  格                                        n      邊際   中位   勝率   前半   後半  去最好年  扣成本  六關');
    const out = [];
    for (const [k, lbl] of defs) {
        const r = row(k, lbl);
        out.push(r);
        if (r.skip) { console.log(`  ${lbl.padEnd(36)} ${String(r.n).padStart(6)}   (樣本不足,不報)`); continue; }
        console.log(`  ${lbl.padEnd(36)} ${String(r.n).padStart(6)} ${fmt(r.edge).padStart(7)} ${fmt(r.med).padStart(6)} ${r.win.toFixed(1).padStart(6)}% ${fmt(r.half[0]).padStart(6)} ${fmt(r.half[1]).padStart(6)} ${fmt(r.exBest).padStart(8)} ${fmt(r.edge - COST).padStart(7)}   ${r.pass ? '✅' : '❌'}`);
    }
    return out;
}

const cells = table('📦 ① 分格(未來 20 日超額,pp;⛔ 相對「所有股·日」的對照組)', CELLS);
const timing = table('⏱️ ② 時機(進框幾天了 / 剛掉出框)', TIMING);

// 🔍 逐年明細(六關「逐年同向」是最嚴的一關 —— 沒過的話要看得出是差在哪一年)
console.log('\n🔍 逐年邊際(pp,相對同年對照組)');
console.log('  格                                    ' + yrKeys.map(y => y.padStart(7)).join(''));
for (const r of [...cells, ...timing]) {
    if (r.skip) continue;
    console.log(`  ${r.label.padEnd(36)}` + yrKeys.map(y => fmt(r.yr[y]).padStart(7)).join(''));
}

console.log(`\n🗓️ 逐年對照組平均:${yrKeys.map(y => `${y} ${baseYr[y].toFixed(2)}%(n=${allYr[y].length})`).join(' ・ ')}`);
console.log('\n⚠️ 限制:窗口整段偏多頭;倖存者偏誤;進場=隔天開盤且已排除鎖漲停;⛔ 這是「位置」不是「時機訊號」。');

if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
        base: { n: allEx.length, mean: baseM, med: baseMed, win: baseWin, yr: baseYr, half: baseHalf, mid: midDate },
        cells, timing, geneAmpP60: pct(ampAll, 0.60), cost: COST, fwd: FWD,
    }, null, 1));
    console.log(`\n💾 ${OUT}`);
}
