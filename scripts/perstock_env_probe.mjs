#!/usr/bin/env node
/**
 * 🧬 個股特性探針(V73.2.3)—— 使用者:「每隻股票都有他的特性,應該用個股的資料做檢測」
 *
 * ⭐ 這支要回答的**不是**「哪個特性有用」,而是更根本的一題:
 *    **「個股特性」這件事本身站不站得住?**
 *    判準只有一個:**前半段學到的東西,後半段還成立嗎?**(⛔ 不成立就是雜訊,不是特性)
 *
 * 三個實驗(樣本全部來自 portfolio_backtest 的交易快取,約 26 萬筆候選交易):
 *   ① 個股「整體」edge 的穩定性 —— 這檔前半段賺,後半段還賺嗎?
 *      ⚠️ 這是在檢驗 App 現行核心假設(per-stock 打法排序)的地基。
 *   ② 個股 × 打法 的穩定性 —— 「這檔最適合這招」後半段還成立嗎?
 *   ③ 個股 × **自己的狀態** 的穩定性 —— 「這檔在自己回檔深的時候比較好做」後半段還成立嗎?
 *      狀態全部用**這檔自己的**資料算(⛔ 不是大盤):距自己60日高、位階、量能、波動率。
 *
 * ⛔ 每個實驗都要有**對照組**:隨機挑一個桶,後半段表現如何。
 *    沒有對照組的話,「後半段也是正的」可能只是因為那段大盤在漲。
 *
 * 用法:node scripts/perstock_env_probe.mjs <交易快取.json>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.argv[2];
const COST = 0.44;
if (!CACHE || !fs.existsSync(CACHE)) { console.log('❌ 請給交易快取路徑'); process.exit(1); }

const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const T = j.trades || [];
console.log(`🧬 個股特性探針 ・${T.length.toLocaleString()} 筆候選交易`);

// ── 依股票分組,並補上「這檔自己的狀態」 ──────────────────────────────
const bySym = new Map();
for (const t of T) { if (!bySym.has(t.sym)) bySym.set(t.sym, []); bySym.get(t.sym).push(t); }

const feat = new Map();     // sym → Map(date → {dd60, rank, volr, vol})
let loaded = 0;
for (const sym of bySym.keys()) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${sym}.json`), 'utf8')); }
    catch (_) { continue; }
    const d = rows.map(r => ({
        d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
        c: +r.close, v: +r.volume || 0,
    })).filter(r => r.d && r.c > 0);
    const m = new Map();
    for (let i = 60; i < d.length; i++) {
        let hi = 0; for (let k = i - 59; k <= i; k++) hi = Math.max(hi, d[k].c);
        // 位階:近 250 日百分位(⛔ 只用 i 之前 → 無前視)
        const w = d.slice(Math.max(0, i - 249), i + 1).map(r => r.c);
        const rank = w.filter(c => c <= d[i].c).length / w.length * 100;
        let av = 0, cnt = 0;
        for (let k = Math.max(0, i - 19); k <= i; k++) { av += d[k].v; cnt++; }
        const volr = cnt && av ? d[i].v / (av / cnt) : null;
        let s2 = 0; for (let k = i - 19; k <= i; k++) s2 += Math.pow((d[k].c - d[k - 1].c) / d[k - 1].c, 2);
        m.set(d[i].d, { dd60: (hi - d[i].c) / hi * 100, rank, volr, vol: Math.sqrt(s2 / 20) * Math.sqrt(252) * 100 });
    }
    feat.set(sym, m); loaded++;
}
console.log(`   讀到 ${loaded} 檔的自身狀態`);

const dates = [...new Set(T.map(t => t.inD))].sort();
const MID = dates[Math.floor(dates.length / 2)];
console.log(`   前後分界:${MID}(前半 ${dates[0]}~ / 後半 ~${dates[dates.length - 1]})\n`);

const net = t => t.ret - COST;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const H2ALL = mean(T.filter(t => t.inD >= MID).map(net));
console.log(`後半段全體平均:${H2ALL.toFixed(3)}%  ← ⛔ 所有「後半段表現」都要跟這個比,不是跟 0 比\n`);

// ═══ ① 個股整體 edge 的穩定性 ═══════════════════════════════════════
console.log('═'.repeat(76));
console.log('① 個股「整體」edge 穩定性 —— 前半段賺的股票,後半段還賺嗎?');
console.log('═'.repeat(76));
const MINH = 30;   // 每半段至少幾筆才納入
const rows1 = [];
for (const [sym, arr] of bySym) {
    const h1 = arr.filter(t => t.inD < MID).map(net), h2 = arr.filter(t => t.inD >= MID).map(net);
    if (h1.length < MINH || h2.length < MINH) continue;
    rows1.push({ sym, a: mean(h1), b: mean(h2), n1: h1.length, n2: h2.length });
}
rows1.sort((x, y) => y.a - x.a);
const q = n => Math.floor(rows1.length * n);
const band = (lo, hi, label) => {
    const a = rows1.slice(lo, hi);
    console.log(`   ${label.padEnd(18)} ${String(a.length).padStart(3)} 檔  前半 ${mean(a.map(r => r.a)).toFixed(3).padStart(7)}%  → 後半 ${mean(a.map(r => r.b)).toFixed(3).padStart(7)}%  (vs 全體 ${(mean(a.map(r => r.b)) - H2ALL >= 0 ? '+' : '') + (mean(a.map(r => r.b)) - H2ALL).toFixed(3)}pp)`);
};
console.log(`   納入 ${rows1.length} 檔(每半段至少 ${MINH} 筆)`);
band(0, q(0.25), '前半段最好 25%');
band(q(0.25), q(0.5), '次好 25%');
band(q(0.5), q(0.75), '次差 25%');
band(q(0.75), rows1.length, '前半段最差 25%');
// 相關係數
const ma = mean(rows1.map(r => r.a)), mb = mean(rows1.map(r => r.b));
const cov = mean(rows1.map(r => (r.a - ma) * (r.b - mb)));
const sa = Math.sqrt(mean(rows1.map(r => (r.a - ma) ** 2))), sb = Math.sqrt(mean(rows1.map(r => (r.b - mb) ** 2)));
const corr = cov / (sa * sb);
console.log(`   ⭐ 前後半段相關係數 r = ${corr.toFixed(3)}  ${Math.abs(corr) < 0.1 ? '← ⛔ 幾乎沒有延續性' : Math.abs(corr) < 0.3 ? '← ⚠️ 很弱' : '← ✅ 有延續性'}`);

// ═══ ② 個股 × 打法 的穩定性 ═════════════════════════════════════════
console.log('\n' + '═'.repeat(76));
console.log('② 個股 × 打法 —— 「這檔最適合這招」後半段還成立嗎?(App 現行做法的地基)');
console.log('═'.repeat(76));
const pick2 = [], rnd2 = [];
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (const [sym, arr] of bySym) {
    const byK = new Map();
    for (const t of arr) { if (!byK.has(t.key)) byK.set(t.key, []); byK.get(t.key).push(t); }
    const cands = [];
    for (const [k, a] of byK) {
        const h1 = a.filter(t => t.inD < MID).map(net), h2 = a.filter(t => t.inD >= MID).map(net);
        if (h1.length < 4 || h2.length < 4) continue;
        cands.push({ k, a: mean(h1), b: mean(h2) });
    }
    if (cands.length < 2) continue;
    cands.sort((x, y) => y.a - x.a);
    pick2.push(cands[0].b);                                   // 前半段最好的那招 → 後半段
    rnd2.push(cands[Math.floor(rnd() * cands.length)].b);     // 對照組:隨便挑一招
}
console.log(`   ${pick2.length} 檔可比`);
console.log(`   前半段最好的那一招 → 後半段 ${mean(pick2).toFixed(3)}%`);
console.log(`   ⛔ 對照組(隨便挑一招) → 後半段 ${mean(rnd2).toFixed(3)}%`);
console.log(`   ⭐ 差距 ${(mean(pick2) - mean(rnd2) >= 0 ? '+' : '') + (mean(pick2) - mean(rnd2)).toFixed(3)}pp  ${mean(pick2) - mean(rnd2) > 0.3 ? '← ✅ 挑選有效' : '← ⛔ 挑選幾乎沒有作用'}`);

// ═══ ③ 個股 × 自己的狀態 ════════════════════════════════════════════
console.log('\n' + '═'.repeat(76));
console.log('③ 個股 ×「自己的狀態」——「這檔在某種狀態下比較好做」後半段還成立嗎?');
console.log('═'.repeat(76));
const STATES = [
    ['距自己60日高', t => { const f = feat.get(t.sym)?.get(t.inD); return f == null ? null : f.dd60 < 3 ? '1貼高' : f.dd60 < 10 ? '2小回' : '3回深'; }],
    ['自己的位階', t => { const f = feat.get(t.sym)?.get(t.inD); return f == null ? null : f.rank >= 80 ? '3高檔' : f.rank >= 40 ? '2中檔' : '1低檔'; }],
    ['量能比', t => { const f = feat.get(t.sym)?.get(t.inD); return f?.volr == null ? null : f.volr >= 2 ? '3爆量' : f.volr >= 1 ? '2溫和' : '1量縮'; }],
    ['自己的波動率', t => { const f = feat.get(t.sym)?.get(t.inD); return f == null ? null : f.vol >= 60 ? '3高波動' : f.vol >= 35 ? '2中' : '1低波動'; }],
];
for (const [name, fn] of STATES) {
    // (a) 全市場層級:這個狀態本身有沒有鑑別力
    const g = {};
    for (const t of T) { const k = fn(t); if (k == null) continue; (g[k] ||= []).push(net(t)); }
    const keys = Object.keys(g).sort();
    console.log(`\n── ${name}`);
    console.log('   [全市場]  ' + keys.map(k => `${k} ${mean(g[k]).toFixed(2)}%(n=${(g[k].length / 1000).toFixed(0)}k)`).join('  '));
    // (b) 個股層級:前半段學到的偏好,後半段還成立嗎(對照組=隨機挑一個狀態)
    const pk = [], rd = [];
    for (const [sym, arr] of bySym) {
        const byS = new Map();
        for (const t of arr) { const k = fn(t); if (k == null) continue; if (!byS.has(k)) byS.set(k, []); byS.get(k).push(t); }
        const cands = [];
        for (const [k, a] of byS) {
            const h1 = a.filter(t => t.inD < MID).map(net), h2 = a.filter(t => t.inD >= MID).map(net);
            if (h1.length < 15 || h2.length < 15) continue;
            cands.push({ k, a: mean(h1), b: mean(h2) });
        }
        if (cands.length < 2) continue;
        cands.sort((x, y) => y.a - x.a);
        pk.push(cands[0].b);
        rd.push(cands[Math.floor(rnd() * cands.length)].b);
    }
    if (!pk.length) { console.log('   [個股]    樣本不足,無法比較'); continue; }
    const d = mean(pk) - mean(rd);
    console.log(`   [個股]    ${pk.length} 檔可比 ・前半最好的狀態→後半 ${mean(pk).toFixed(3)}%  ・對照組 ${mean(rd).toFixed(3)}%  ・差距 ${(d >= 0 ? '+' : '') + d.toFixed(3)}pp  ${d > 0.3 ? '✅' : '⛔ 沒有延續性'}`);
}

console.log('\n' + '═'.repeat(76));
console.log('⚠️ 判讀:「後半段還是正的」不算數 —— 那可能只是那段大盤在漲。');
console.log('   唯一算數的是「**贏過對照組**」(隨機挑一個桶/一招)。');
