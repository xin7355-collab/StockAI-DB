#!/usr/bin/env node
/**
 * 📥 把 `prob_probe.mjs` 的產物嵌進 `index.html` 的 `_PROB_TABLE`(V77.4.6)
 *
 * ⭐ 為什麼要有這支(⛔ 不要手動 regex 換):V72.0.2 手動換 `_SIGNAL_EDGE` 時
 *   **只換到 meta、沒換到資料表** —— 兩邊各自看起來都對,最難發現。
 *   → 用**行號整行替換** + 換完立刻**交叉驗證**(格數 / 天期 / 基準率三項不符就 exit 1)。
 *
 * 用法:node scripts/embed_prob_table.mjs <prob_table.json>
 */
import fs from 'fs';
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) { console.error('用法:node scripts/embed_prob_table.mjs <prob_table.json>'); process.exit(1); }
const T = JSON.parse(fs.readFileSync(SRC, 'utf8'));
// ⛔ **兩個檔一起寫** —— `index.html` 與 `pro.html` 沒辦法互相 import,
//   但⛔ 不可以變成「兩份各自維護的數字」→ 由這一支同時寫,再由 test_prob ⑧ 跨檔比對。
const TARGETS = [['index.html', '    '], ['pro.html', '  ']];
let back = null, P = null, i = -1;
for (const [file, indent] of TARGETS) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const k = lines.findIndex(l => l.trim().startsWith('_PROB_TABLE:'));
    if (k < 0) { console.error(`⛔ ${file} 找不到 \`_PROB_TABLE:\` 那一行`); process.exit(1); }
    lines[k] = indent + '_PROB_TABLE: ' + JSON.stringify(T) + ',';
    fs.writeFileSync(file, lines.join('\n'));
    if (back == null) { back = lines[k]; P = file; i = k; }
}

// 🚧 交叉驗證(⛔ 少了這段,寫錯欄位會靜默寫進去)
const J = JSON.parse(back.replace(/^\s*_PROB_TABLE:\s*/, '').replace(/,\s*$/, ''));
// 🚧 兩個檔必須逐字相同(⛔ 只改一邊 = 同一個機率兩個數字)
{
    const a = fs.readFileSync('index.html', 'utf8').split('\n').find(l => l.trim().startsWith('_PROB_TABLE:')).trim();
    const c = fs.readFileSync('pro.html', 'utf8').split('\n').find(l => l.trim().startsWith('_PROB_TABLE:')).trim();
    if (a !== c) { console.error('❌ index.html 與 pro.html 的 _PROB_TABLE 不一致'); process.exit(1); }
}
const bad = [];
if (Object.keys(J.cells).length !== Object.keys(T.cells).length) bad.push('格數不符');
if (J.hz.join() !== T.hz.join()) bad.push('天期不符');
if (JSON.stringify(J.base) !== JSON.stringify(T.base)) bad.push('基準率不符');
if (J.schema.length !== J.base[0].length) bad.push(`schema ${J.schema.length} 欄 vs 資料 ${J.base[0].length} 欄`);
if (bad.length) { console.error('❌ 交叉驗證失敗:' + bad.join(' / ')); process.exit(1); }
console.log(`✅ 已嵌入:${Object.keys(J.cells).length} 格 ・天期 ${J.hz.join('/')} ・基準率(20日)漲 ${J.base[J.hz.indexOf(20)][1]}% ・${(back.length / 1024).toFixed(0)} KB`);
