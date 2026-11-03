#!/usr/bin/env node
/**
 * 🎲 V79.8.7 把 col_rate_base.mjs 的結果寫進 index.html 的 `_COL_BASE`(一行;⛔ 手改)
 *   跑法:node scripts/embed_col_base.mjs colbase.json
 *   交叉驗證(對不上 exit 1,⛔ 寫半套進去):
 *     ① `_COL_OCC` + 量化實驗室 `ql_` 每一個條件(`_colOccIds`)在 stk 都有、n > 0、p / base 是數字
 *     ② mkt 六條(bear_on / bull_on / crash20 / idx_drop3 / 🔀 V81.0.0 idx_drop2 / idx_up2)都有;大盤那天的兩條(m_dn2 / m_up2)要有 by / nd + trait
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
const ids = typeof A._colOccIds === 'function' ? A._colOccIds() : Object.keys(A._COL_OCC);   // 📐 V79.8.9 含量化實驗室的 ql_ 條件
const stk = {}, mkt = {};
for (const id of ids) {
    const x = (J.stk || {})[id], pool = !!(A._colOccDef(id) || {}).pool;
    if (!x || !(x.n > 0) || !Number.isFinite(x.p) || !Number.isFinite(x.base)) die(`① stk.${id} 沒有或不完整:${JSON.stringify(x)}`);
    if (pool && !(x.pool && Number.isFinite(x.sy))) die(`① stk.${id} 是「比同一天所有股票」那種,要有 sy(同一檔同一年隨便一天):${JSON.stringify(x)}`);
    stk[id] = pool ? { n: x.n, k: x.k, p: x.p, sy: x.sy, base: x.base, from: x.from, pool: 1 } : { n: x.n, k: x.k, p: x.p, base: x.base, own: x.own, from: x.from };
    // 🔀 V81.0.0 大盤那天的兩條(mk):多帶天數 nd + 分組 by(只留 App 用得到的欄位;ok = 穩)
    if ((A._colOccDef(id) || {}).mk) {
        if (!x.by || !(x.nd > 0)) die(`① stk.${id} 是大盤那天的條件,要有 by / nd:${JSON.stringify(Object.keys(x))}`);
        stk[id].nd = x.nd;
        stk[id].by = Object.fromEntries(Object.entries(x.by).filter(([, v]) => v && v.n > 0).map(([k, v]) => [k, { n: v.n, nd: v.nd, p: v.p, ok: !!v.ok }]));
    }
}
if (ids.some(id => (A._colOccDef(id) || {}).mk) && !(J.trait && Array.isArray(J.trait.amp) && J.trait.amp.length === 2 && J.trait.lbl)) die('① 沒有 trait(振幅三分位 + 名稱)');
for (const id of ['bear_on', 'bull_on', 'crash20', 'idx_drop3', 'idx_drop2', 'idx_up2']) {
    const x = (J.mkt || {})[id];
    if (!x || !(x.n > 0) || !x.ev || !x.out) die(`② mkt.${id} 沒有或不完整`);
    mkt[id] = { ev: x.ev, out: x.out, n: x.n, k: x.k, base: x.base, from: x.from };
}
const out = { built: J.built, src: J.src, syms: J.syms, win: J.win, stk, mkt, ...(J.trait ? { trait: { amp: J.trait.amp, lbl: J.trait.lbl } } : {}) };
const line = `    _COL_BASE: ${JSON.stringify(out)},`;
const re = /\n    _COL_BASE: \{.*\},\n/;
if (!re.test(src)) die('index.html 找不到 `    _COL_BASE: {…},` 那一行');
src = src.replace(re, '\n' + line + '\n');
// ③ 重新抽出來比
const back = (0, eval)('({' + extractMember(src, '_COL_BASE') + '})')._COL_BASE;
for (const id of ids) if (!back.stk[id] || back.stk[id].n !== stk[id].n) die(`③ 寫完對不上:stk.${id}`);
for (const id of Object.keys(mkt)) if (!back.mkt[id] || back.mkt[id].n !== mkt[id].n) die(`③ 寫完對不上:mkt.${id}`);
if (out.trait && JSON.stringify(back.trait) !== JSON.stringify(out.trait)) die('③ 寫完對不上:trait');
fs.writeFileSync(IDX, src);
console.log(`✅ _COL_BASE 寫入:${ids.length} 個個股條件 + ${Object.keys(mkt).length} 個大盤條件(${J.syms} 檔,${(J.win || []).join(' ~ ')},${line.length.toLocaleString()} 字)`);
