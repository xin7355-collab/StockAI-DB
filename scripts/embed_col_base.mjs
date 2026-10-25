#!/usr/bin/env node
/**
 * 🎲 V79.8.7 把 col_rate_base.mjs 的結果寫進 index.html 的 `_COL_BASE`(一行;⛔ 手改)
 *   跑法:node scripts/embed_col_base.mjs colbase.json
 *   交叉驗證(對不上 exit 1,⛔ 寫半套進去):
 *     ① `_COL_OCC` 每一個條件在 stk 都有、n > 0、p / base 是數字
 *     ② mkt 四條(bear_on / bull_on / crash20 / idx_drop3)都有
 *     ③ 寫完重新抽出來 == 寫進去的那份(筆數 / n 逐一比)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMember, buildApp } from './col_rate_base.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDX = path.join(ROOT, 'index.html');
const die = m => { console.error('❌ ' + m); process.exit(1); };

const f = process.argv[2]; if (!f) die('要給 col_rate_base 的輸出檔');
const J = JSON.parse(fs.readFileSync(f, 'utf8'));
let src = fs.readFileSync(IDX, 'utf8');
const A = buildApp(src);
const ids = Object.keys(A._COL_OCC);
const stk = {}, mkt = {};
for (const id of ids) {
    const x = (J.stk || {})[id];
    if (!x || !(x.n > 0) || !Number.isFinite(x.p) || !Number.isFinite(x.base)) die(`① stk.${id} 沒有或不完整:${JSON.stringify(x)}`);
    stk[id] = { n: x.n, k: x.k, p: x.p, base: x.base, own: x.own, from: x.from };
}
for (const id of ['bear_on', 'bull_on', 'crash20', 'idx_drop3']) {
    const x = (J.mkt || {})[id];
    if (!x || !(x.n > 0) || !x.ev || !x.out) die(`② mkt.${id} 沒有或不完整`);
    mkt[id] = { ev: x.ev, out: x.out, n: x.n, k: x.k, base: x.base, from: x.from };
}
const out = { built: J.built, src: J.src, syms: J.syms, win: J.win, stk, mkt };
const line = `    _COL_BASE: ${JSON.stringify(out)},`;
const re = /\n    _COL_BASE: \{.*\},\n/;
if (!re.test(src)) die('index.html 找不到 `    _COL_BASE: {…},` 那一行');
src = src.replace(re, '\n' + line + '\n');
// ③ 重新抽出來比
const back = (0, eval)('({' + extractMember(src, '_COL_BASE') + '})')._COL_BASE;
for (const id of ids) if (!back.stk[id] || back.stk[id].n !== stk[id].n) die(`③ 寫完對不上:stk.${id}`);
for (const id of Object.keys(mkt)) if (!back.mkt[id] || back.mkt[id].n !== mkt[id].n) die(`③ 寫完對不上:mkt.${id}`);
fs.writeFileSync(IDX, src);
console.log(`✅ _COL_BASE 寫入:${ids.length} 個個股條件 + ${Object.keys(mkt).length} 個大盤條件(${J.syms} 檔,${(J.win || []).join(' ~ ')},${line.length.toLocaleString()} 字)`);
