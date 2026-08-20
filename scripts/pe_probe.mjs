#!/usr/bin/env node
/**
 * 💰 本益比篩選探針 —— 「PE 低 = 便宜 = 會漲」到底成不成立?
 *
 * 使用者:「幫我做一個本益比,由低到高的篩選器,其中還要包含同族群相比有沒有比較便宜
 *          還有財報等等我沒想到的比拚,看一下我有沒有說錯,還有推薦」
 *
 * ⭐⭐ **歷史 PE 是重建得出來的**(這是這支能成立的關鍵):
 *   `fund_yoy_gm.json` 的 `qeps` 有每季 EPS + 期別 → 加上「財報公布日」規則就能算出
 *   **任何一天的 TTM EPS**(只用當天已經公布的四季),再配 `data/{sym}.json` 的收盤價 → 歷史 PE。
 *   ⛔ **沒有前視**:2025-03-31 那一季要到 2025-05-15 才公布,在那之前不可以用。
 *
 * ⚠️ 四個限制(⛔ 報告裡不可省略):
 *   ① **窗口只有約 15 個月**(TTM 要 4 季,而 qeps 只有 8 季 → 最早只能從 2025 年中開始),
 *      而且**整段偏多頭** → 結論不可外推到空頭。
 *   ② 只有 918 檔有 `qeps`(全市場 2,356 檔的 39%),而且**倖存者偏誤**。
 *   ③ 產業中位 PE 用 `industry_map`(**只有上市**);TWSE 33 大類**顆粒度偏粗**(半導體全擠一類)。
 *   ④ EPS 含**一次性業外收益** → PE 特別低的那批,很多是「賣土地/賣股票」的假便宜。
 *      ⛔ 資料上分不出來,只能靠「極端值剔除」與「循環股警示」緩解。
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物。
 * 用法:node --max-old-space-size=4096 scripts/pe_probe.mjs [輸出.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = process.argv[2] || '';
const DEDUP = 20;        // 同檔 20 日只算一次
const STEP = 3;
const MIN_IND = 5;
const COST = 0.44;
const MIN_EV = 2000;

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const med = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (x, n) => n ? x / n * 100 : 0;
const f = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);

// ═══════ 1. 大盤日曆 ═══════
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
    .map(r => ({ d: nd(r.date), c: +r.close }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
    .sort((a, b) => a.d < b.d ? -1 : 1);
const days = twii.map(r => r.d);
const dPos = new Map(days.map((d, i) => [d, i]));
const tw = Float64Array.from(twii.map(r => r.c));

const indMap = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'));
const indPe = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_pe.json'), 'utf8'));
const cyclical = new Set(Object.entries(indPe.industries || {}).filter(([, v]) => v.is_cyclical).map(([k]) => k));
const fund = JSON.parse(fs.readFileSync(path.join(DATA, 'fund_yoy_gm.json'), 'utf8'));

// ═══════ 2. 財報公布日規則(⛔ 這一步錯了整份就是前視) ═══════
// 台股:Q1→5/15 ・ Q2→8/14 ・ Q3→11/14 ・ Q4(全年)→ 隔年 3/31
const pubDate = period => {
    const y = +period.slice(0, 4), m = period.slice(5, 7);
    if (m === '03') return `${y}-05-15`;
    if (m === '06') return `${y}-08-14`;
    if (m === '09') return `${y}-11-14`;
    if (m === '12') return `${y + 1}-03-31`;
    return null;
};

// ═══════ 3. 逐檔:重建每日 TTM EPS 與 PE ═══════
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const PE = new Map();      // sym → Float64Array(每日 PE,算不出來放 NaN)
const CL = new Map();      // sym → Float64Array(收盤)
const YOY = new Map();     // sym → 月營收 YoY(⚠️ 只有最新值,無歷史 → 只做交叉檢查不做時序)
let used = 0, firstOk = days.length;
for (const fn of files) {
    const sym = fn.slice(0, 4);
    const fv = fund[sym];
    const q = (fv && Array.isArray(fv.qeps)) ? fv.qeps.filter(x => x && x.period && x.eps != null) : null;
    if (!q || q.length < 5) continue;                      // TTM 要 4 季,至少要有 5 季才有一個以上的觀測點
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(arr) || arr.length < 200) continue;
    const cl = new Float64Array(days.length).fill(NaN);
    for (const r of arr) {
        const i = dPos.get(nd(r.date)); const c = +r.close;
        if (i !== undefined && c > 0) cl[i] = c;
    }
    // 依期別排序,算出「每一天已公布的最新 4 季 TTM EPS」
    const qs = q.slice().sort((a, b) => a.period < b.period ? -1 : 1)
        .map(x => ({ p: x.period, e: +x.eps, pub: pubDate(x.period) })).filter(x => x.pub);
    const pe = new Float64Array(days.length).fill(NaN);
    for (let i = 0; i < days.length; i++) {
        const c = cl[i]; if (Number.isNaN(c)) continue;
        const d = days[i];
        const avail = qs.filter(x => x.pub <= d);
        if (avail.length < 4) continue;
        const ttm = sum(avail.slice(-4).map(x => x.e));
        if (!(ttm > 0)) continue;                          // ⛔ 虧損股沒有 PE(⛔ 不可當成「便宜」)
        const v = c / ttm;
        if (!(v > 0) || v > 300) continue;                 // 極端值剔除(PE>300 多半是 EPS 趨近 0)
        pe[i] = v;
        if (i < firstOk) firstOk = i;
    }
    PE.set(sym, pe); CL.set(sym, cl); used++;
    if (fv && fv.yoy != null) YOY.set(sym, +fv.yoy);
}

// 分析窗口:從「有 PE 的檔數夠多」那天開始
const cov = days.map((_, i) => { let c = 0; for (const p of PE.values()) if (!Number.isNaN(p[i])) c++; return c; });
const START = cov.findIndex(c => c >= used * 0.6);

// ═══════ 4. 每天:全市場 PE 分位 + 各產業中位 PE ═══════
const dayStat = [];
for (let i = 0; i < days.length; i++) {
    if (i < START) { dayStat.push(null); continue; }
    const all = [], byInd = new Map();
    for (const [sym, p] of PE) {
        const v = p[i]; if (Number.isNaN(v)) continue;
        all.push(v);
        const k = indMap[sym]; if (!k) continue;
        if (!byInd.has(k)) byInd.set(k, []);
        byInd.get(k).push(v);
    }
    if (all.length < 100) { dayStat.push(null); continue; }
    all.sort((a, b) => a - b);
    const imed = new Map();
    for (const [k, a] of byInd) if (a.length >= MIN_IND) imed.set(k, med(a));
    dayStat.push({ all, imed });
}
const qOf = (sorted, v) => {   // v 在 sorted 裡的分位 0~1
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5;
};

// ═══════ 5. 分桶 + 未來報酬 ═══════
const HOR = [20, 60];
const mk = () => ({ n: 0, r: { 20: [], 60: [] }, h1: [], h2: [], byY: {} });
const G = {};
const put = (k, x20, x60, i, y) => {
    (G[k] ||= mk());
    G[k].n++;
    if (x20 !== null) { G[k].r[20].push(x20); (i < HALF ? G[k].h1 : G[k].h2).push(x20); (G[k].byY[y] ||= []).push(x20); }
    if (x60 !== null) G[k].r[60].push(x60);
};
const HALF = Math.floor((START + days.length) / 2);
const lastHit = new Map();
let events = 0;
const fwdEx = (cl, i, k) => {
    const j = i + k;
    if (j >= days.length) return null;
    const a = cl[i], b = cl[j];
    if (Number.isNaN(a) || Number.isNaN(b) || !(a > 0)) return null;
    return (b / a - 1) * 100 - (tw[j] / tw[i] - 1) * 100;
};

for (let i = START; i < days.length; i += STEP) {
    const S = dayStat[i]; if (!S) continue;
    const y = days[i].slice(0, 4) + '-' + days[i].slice(5, 7);
    for (const [sym, p] of PE) {
        const v = p[i]; if (Number.isNaN(v)) continue;
        const cl = CL.get(sym);
        const x20 = fwdEx(cl, i, 20), x60 = fwdEx(cl, i, 60);
        if (x20 === null) continue;
        const key = sym;
        if (i - (lastHit.get(key) ?? -1e9) < DEDUP) continue;
        lastHit.set(key, i);
        events++;
        put('__base', x20, x60, i, y);
        // ① 絕對 PE 分位(全市場當日)—— 使用者說的「由低到高」
        const qa = qOf(S.all, v);
        put('pe_q' + Math.min(4, Math.floor(qa * 5)), x20, x60, i, y);
        // ② 相對同業 PE(PE ÷ 產業中位)—— 使用者說的「同族群比」
        const k = indMap[sym], im = k ? S.imed.get(k) : null;
        if (im > 0) {
            const rel = v / im;
            const b = rel < 0.6 ? 0 : rel < 0.85 ? 1 : rel < 1.15 ? 2 : rel < 1.5 ? 3 : 4;
            put('rel_q' + b, x20, x60, i, y);
            // ③ 絕對便宜 vs 相對便宜:兩者不同意時誰對?
            if (qa <= 0.2 && rel >= 1.0) put('cheap_abs_only', x20, x60, i, y);
            if (qa >= 0.5 && rel < 0.85) put('cheap_rel_only', x20, x60, i, y);
            if (qa <= 0.2 && rel < 0.85) put('cheap_both', x20, x60, i, y);
        }
        // ④ 景氣循環股 × 低 PE(⛔ 經典陷阱:循環股 PE 低 = 獲利高峰)
        if (qa <= 0.2) put(cyclical.has(k) ? 'lowpe_cyc' : 'lowpe_noncyc', x20, x60, i, y);
        // ⑤ 極低 PE(<8)—— 排序取前面必然挑到這批
        if (v < 8) put('pe_lt8', x20, x60, i, y);
        if (v < 5) put('pe_lt5', x20, x60, i, y);
        // ⑥ 低 PE × 營收 YoY(⚠️ YoY 只有最新值 → 這條是**近似**,只當方向參考)
        const yo = YOY.get(sym);
        if (qa <= 0.3 && yo != null) put(yo > 0 ? 'lowpe_yoyup' : 'lowpe_yoydn', x20, x60, i, y);
    }
}
if (events < MIN_EV || used < 300) {
    console.error(`❌ 空過守門:${used} 檔 / ${events} 事件`);
    process.exit(1);
}

// ═══════ 6. 報告 ═══════
const B = G.__base;
const bm20 = med(B.r[20]), bavg20 = mean(B.r[20]), bwr = pct(B.r[20].filter(x => x > 0).length, B.r[20].length);
const line = (name, k, note = '') => {
    const g = G[k];
    if (!g || g.r[20].length < 100) { console.log(`${name.padEnd(30)} ${'樣本不足'.padStart(8)}`); return null; }
    const m20 = med(g.r[20]), a20 = mean(g.r[20]), wr = pct(g.r[20].filter(x => x > 0).length, g.r[20].length);
    const h1 = g.h1.length >= 30 ? mean(g.h1) - mean(B.h1) : null;
    const h2 = g.h2.length >= 30 ? mean(g.h2) - mean(B.h2) : null;
    const same = h1 !== null && h2 !== null && (h1 > 0) === (h2 > 0);
    const o = { k, name, n: g.n, m20, a20, wr, d20: m20 - bm20, dAvg: a20 - bavg20, dWr: wr - bwr, same };
    console.log(`${name.padEnd(30)} ${String(g.n).padStart(6)}  ${f(m20)}  ${f(a20)}  ${f(o.dAvg, 7)}  ${wr.toFixed(1).padStart(5)}%  ${f(o.dWr, 6, 1)}  ${h1 === null ? ' -- ' : f(h1, 6)} ${h2 === null ? ' -- ' : f(h2, 6)}  ${same ? '✅' : '❌'} ${note}`);
    return o;
};
console.log('═'.repeat(110));
console.log('💰 本益比篩選探針 —— 「PE 低 = 便宜 = 會漲」成不成立?');
console.log('═'.repeat(110));
console.log(`樣本:${used} 檔有可重建的歷史 PE ・ 窗口 ${days[START]} ~ ${days[days.length - 1]} ・ ${events.toLocaleString()} 個事件(同檔 ${DEDUP} 日去重)`);
console.log(`⚠️ 窗口只有約 ${Math.round((days.length - START) / 20)} 個月且整段偏多頭;倖存者偏誤;EPS 含一次性業外收益`);
console.log(`對照組:全部 ${B.n.toLocaleString()} 個 ・ 20 日超額 中位 ${f(bm20)}% 平均 ${f(bavg20)}% 勝率 ${bwr.toFixed(1)}%`);
console.log('\n欄位:事件數 / 20日中位 / 20日平均 / vs對照(平均) / 勝率 / vs對照 / 前半 / 後半 / 前後同向');

console.log('\n── ① 絕對 PE 分位(使用者說的「由低到高」;q0 = 最便宜的 20%)');
const rows = [];
for (let i = 0; i < 5; i++) rows.push(line(`  PE 分位 q${i}(${['最低20%', '20-40%', '40-60%', '60-80%', '最高20%'][i]})`, 'pe_q' + i));

console.log('\n── ② 相對同業 PE(使用者說的「同族群比」;PE ÷ 該產業中位 PE)');
const relNames = ['  比同業便宜 4 成以上(<0.6)', '  比同業便宜(0.6~0.85)', '  跟同業差不多(0.85~1.15)', '  比同業貴(1.15~1.5)', '  比同業貴 5 成以上(>1.5)'];
const relRows = [];
for (let i = 0; i < 5; i++) relRows.push(line(relNames[i], 'rel_q' + i));

console.log('\n── ③ 絕對便宜 vs 相對便宜:兩者不同意時誰對?');
const c1 = line('  只有絕對便宜(同業裡不便宜)', 'cheap_abs_only');
const c2 = line('  只有相對便宜(絕對值不低)', 'cheap_rel_only');
const c3 = line('  兩個都便宜', 'cheap_both');

console.log('\n── ④ ⛔ 經典陷阱:景氣循環股的低 PE(獲利高峰 → PE 假低)');
const y1 = line('  低 PE × 景氣循環股', 'lowpe_cyc');
const y2 = line('  低 PE × 非循環股', 'lowpe_noncyc');

console.log('\n── ⑤ 極低 PE(排序取前面必然挑到這批)');
const z1 = line('  PE < 8', 'pe_lt8');
const z2 = line('  PE < 5', 'pe_lt5');

console.log('\n── ⑥ 低 PE × 營收 YoY(⚠️ YoY 只有最新值,這條是近似,只看方向)');
const w1 = line('  低 PE × 營收成長', 'lowpe_yoyup');
const w2 = line('  低 PE × 營收衰退', 'lowpe_yoydn');

console.log('\n' + '═'.repeat(110));
console.log('💰 成本關卡:來回 0.44%');
for (const o of [...rows, ...relRows, c1, c2, c3, y1, y2, z1, z2, w1, w2].filter(Boolean)) {
    if (!o.same) continue;
    const net = o.dAvg - COST;
    if (net > 0) console.log(`  ⭐ ${o.name.trim()}:平均邊際 ${f(o.dAvg, 5)}pp − 成本 ${COST} = ${f(net, 5)}pp(前後半段同向)`);
}
const winners = [...rows, ...relRows, c1, c2, c3, y1, y2, z1, z2, w1, w2].filter(o => o && o.same && (o.dAvg - COST) > 0);
if (!winners.length) console.log('  ⛔ 沒有任何一個桶「前後半段同向 + 扣完成本還有剩」。');

console.log('\n⛔ 讀這份報告的規則');
console.log('  ① 「vs對照」是跟同一批(股·日)的全部比,⛔ 不是跟 0 比。');
console.log('  ② 前後半段不同向的一律不算數(窗口只有 15 個月,已經很難通過)。');
console.log('  ③ 窗口整段偏多頭 → ⛔ 不可外推到空頭;而且 EPS 含一次性業外收益,低 PE 那批有假便宜。');

if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
        meta: { stocks: used, events, from: days[START], to: days[days.length - 1], cost: COST,
                base: { n: B.n, m20: bm20, avg20: bavg20, wr: bwr } },
        rows: [...rows, ...relRows, c1, c2, c3, y1, y2, z1, z2, w1, w2].filter(Boolean),
    }, null, 1));
    console.log(`\n💾 ${OUT}`);
}
