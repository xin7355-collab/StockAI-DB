#!/usr/bin/env node
/**
 * 📥 把 `gap_base.mjs` 的產物嵌進 `index.html` 的 `_GAP_BASE`(V78.5.3,總覽開盤卡「一般股票」那一欄)
 * ⛔ 別手動改那一行:嵌完當場讀回來交叉驗證(直方圖總和 = n、檔數 ≥1000、讀回來一字不差),不對就 exit 1。
 * 用法:node scripts/embed_gap_base.mjs gap_base.json
 */
import fs from 'fs';
const src = process.argv[2];
if (!src) { console.error('用法:node scripts/embed_gap_base.mjs gap_base.json'); process.exit(1); }
const G = JSON.parse(fs.readFileSync(src, 'utf8'));
const sum = (G.bins || []).reduce((a, b) => a + b, 0);
if (!Array.isArray(G.bins) || G.bins.length !== 220 || sum !== G.n) { console.error(`❌ 直方圖壞掉:${G.bins && G.bins.length} 格、總和 ${sum} ≠ n ${G.n}`); process.exit(1); }
if (!(G.syms >= 1000)) { console.error(`❌ 只有 ${G.syms} 檔,不嵌`); process.exit(1); }
if (!(G.lu >= 0 && G.ld >= 0 && G.lu < G.n && G.ld < G.n)) { console.error('❌ 鎖漲停 / 鎖跌停次數不合理'); process.exit(1); }
const T = { v: 1, src: G.src, from: G.from, to: G.to, syms: G.syms, n: G.n, bin: G.bin, lo: G.lo, lu: G.lu, ld: G.ld, bins: G.bins,
    note: '上市櫃個股(⛔ ETF、⛔ 興櫃)最近一年每一天「開盤 ÷ 前一天收盤」落在哪一格(0.1% 一格,−11%~+11%);|跳空|>11% 剔除;lu / ld = 開盤就鎖漲停 / 跌停的次數;⛔ 不是預測' };
const lines = fs.readFileSync('index.html', 'utf8').split('\n');
let k = lines.findIndex(l => l.trim().startsWith('_GAP_BASE:'));
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
