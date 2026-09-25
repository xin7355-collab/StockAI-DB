#!/usr/bin/env node
/**
 * 📥 V77.6.1 把 `yearly_bt.mjs --collect` 的結果嵌進 pro.html 的 `_YEARLY_BT`(一行)
 *   ⛔ 別手動改那一行(V72.0.2 手動換 `_SIGNAL_EDGE` 只換到一半的教訓)。
 *   嵌完當場**交叉驗證**,任一項不符就 exit 1(⛔ 不可靜默寫進去):
 *     ① 策略數 == yearly_bt.mjs 的 STRATS ② 每個策略每一年都有值 ③ 2022 有加權/0050 對照
 *     ④ 嵌進去之後再讀回來,跟 json 逐格相同
 * 用法:node scripts/embed_yearly_bt.mjs <collect 產出的 json>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRATS, YEARS } from './yearly_bt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
if (!SRC) { console.error('🚨 用法:node scripts/embed_yearly_bt.mjs <yearly.json>'); process.exit(1); }
const J = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const die = m => { console.error('🚨 ' + m); process.exit(1); };

// ⭐ 只留畫面要用的欄位(控制大小)
const slim = {
    asof: J.asof, years: J.years, offsets: J.offsets, picks: J.picks, groups: J.groups, skipped: J.skipped, bench: J.bench,
    strats: J.strats.map(s => ({ id: s.id, g: s.g, t: s.t, y: Object.fromEntries(Object.entries(s.y).map(([y, v]) => [y,
        [v.n, v.win, v.per, v.pnl, v.ret, v.perAmt, v.worst, v.best, v.dd, v.lo, v.hi, v.cross]])) })),
    cols: ['n', 'win', 'per', 'pnl', 'ret', 'perAmt', 'worst', 'best', 'dd', 'lo', 'hi', 'cross'],
};
if (slim.strats.length !== STRATS.length) die(`策略數 ${slim.strats.length} ≠ STRATS ${STRATS.length}`);
for (const s of slim.strats) for (const y of YEARS) if (!s.y[y]) die(`${s.id} 缺 ${y}`);
if (!(slim.bench['2022'] && slim.bench['2022'].twii < 0)) die('2022 的加權對照缺或不是負的(那一年應該是空頭)');
if (!slim.strats.some(s => s.id === 'base')) die('沒有「決策台現行」那一列');

const P = path.join(ROOT, 'pro.html');
const html = fs.readFileSync(P, 'utf8');
const lines = html.split('\n');
const idx = lines.findIndex(l => /^\s*_YEARLY_BT: \{/.test(l));
if (idx < 0) die('pro.html 找不到 `_YEARLY_BT:` 那一行');
lines[idx] = '  _YEARLY_BT: ' + JSON.stringify(slim) + ',';
fs.writeFileSync(P, lines.join('\n'));

// ④ 讀回來比對
const back = JSON.parse(fs.readFileSync(P, 'utf8').split('\n')[idx].replace(/^\s*_YEARLY_BT: /, '').replace(/,$/, ''));
for (const s of J.strats) {
    const b = back.strats.find(x => x.id === s.id);
    for (const y of YEARS) { if (b.y[y][3] !== s.y[y].pnl || b.y[y][0] !== s.y[y].n) die(`讀回來對不上:${s.id} ${y}`); }
}
console.log(`✅ 已嵌入 _YEARLY_BT:${slim.strats.length} 個策略 × ${YEARS.length} 年(${(lines[idx].length / 1024).toFixed(1)} KB)・交叉驗證通過`);
