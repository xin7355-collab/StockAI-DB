#!/usr/bin/env node
/**
 * 📥 把 `gap_base.mjs` 的產物嵌進 `index.html` 的 `_GAP_BASE`(V78.5.3,總覽開盤卡「一般股票」那一欄)
 * ⛔ 別手動改那一行:嵌完當場讀回來交叉驗證(直方圖總和 = n、檔數 ≥1000、讀回來一字不差),不對就 exit 1。
 * 用法:node scripts/embed_gap_base.mjs gap_base.json
 */
import fs from 'fs';
// V78.5.4 第二個參數(選用)= `gap_after_probe.mjs` 的產物 → 嵌成 `_GAP_BASE.after`(開盤後那天怎麼走,一般股票);
//   沒給就沿用 index.html 裡現有那一份(⛔ 不會因為只重跑直方圖就把它洗掉)
const src = process.argv[2], srcAfter = process.argv[3];
if (!src) { console.error('用法:node scripts/embed_gap_base.mjs gap_base.json [gap_after.json]'); process.exit(1); }
const G = JSON.parse(fs.readFileSync(src, 'utf8'));
const sum = (G.bins || []).reduce((a, b) => a + b, 0);
if (!Array.isArray(G.bins) || G.bins.length !== 220 || sum !== G.n) { console.error(`❌ 直方圖壞掉:${G.bins && G.bins.length} 格、總和 ${sum} ≠ n ${G.n}`); process.exit(1); }
if (!(G.syms >= 1000)) { console.error(`❌ 只有 ${G.syms} 檔,不嵌`); process.exit(1); }
if (!(G.lu >= 0 && G.ld >= 0 && G.lu < G.n && G.ld < G.n)) { console.error('❌ 鎖漲停 / 鎖跌停次數不合理'); process.exit(1); }
const T = { v: 1, src: G.src, from: G.from, to: G.to, syms: G.syms, n: G.n, bin: G.bin, lo: G.lo, lu: G.lu, ld: G.ld, bins: G.bins,
    note: '上市櫃個股(⛔ ETF、⛔ 興櫃)最近一年每一天「開盤 ÷ 前一天收盤」落在哪一格(0.1% 一格,−11%~+11%);|跳空|>11% 剔除;lu / ld = 開盤就鎖漲停 / 跌停的次數;⛔ 不是預測' };
const lines = fs.readFileSync('index.html', 'utf8').split('\n');
let k = lines.findIndex(l => l.trim().startsWith('_GAP_BASE:'));
if (srcAfter) {
    const A = JSON.parse(fs.readFileSync(srcAfter, 'utf8'));
    const BK = ['lu', 'hi', 'flat', 'lo', 'ld'];
    if (!A.buckets || BK.some(b => !A.buckets[b] || !(A.buckets[b].n >= 1000))) { console.error('❌ gap_after 每一桶要有 ≥1000 次'); process.exit(1); }
    if (!(A.syms >= 1000)) { console.error(`❌ gap_after 只有 ${A.syms} 檔`); process.exit(1); }
    T.after = { src: A.src, from: A.from, to: A.to, th: A.th, syms: A.syms };
    for (const b of BK) { const x = A.buckets[b]; T.after[b] = { n: x.n, up: x.upPct, dn: x.dnPct, oc: x.ocMean, lock: x.lockPct, yrs: x.yearsSame }; }
} else if (k >= 0) {
    try { const old = JSON.parse(lines[k].trim().replace(/^_GAP_BASE:\s*/, '').replace(/,\s*$/, '')); if (old.after) T.after = old.after; } catch (_) {}
}
const line = '    _GAP_BASE: ' + JSON.stringify(T) + ',';
if (k >= 0) lines[k] = line;
else {
    const p = lines.findIndex(l => l.trim().startsWith('_PROB_TABLE:'));
    if (p < 0) { console.error('⛔ index.html 找不到 `_PROB_TABLE:` 那一行(要插在它後面)'); process.exit(1); }
    lines.splice(p + 1, 0, line); k = p + 1;
}
fs.writeFileSync('index.html', lines.join('\n'));
const back = fs.readFileSync('index.html', 'utf8').split('\n').find(l => l.trim().startsWith('_GAP_BASE:'));
const J = JSON.parse(back.trim().replace(/^_GAP_BASE:\s*/, '').replace(/,\s*$/, ''));
if (JSON.stringify(J) !== JSON.stringify(T)) { console.error('❌ 讀回來跟寫進去的不一樣'); process.exit(1); }
console.log(`✅ _GAP_BASE 已嵌入 index.html 第 ${k + 1} 行:${T.syms} 檔・${T.n.toLocaleString()} 次開盤・${T.from}~${T.to}(${back.length.toLocaleString()} 字元)`);
