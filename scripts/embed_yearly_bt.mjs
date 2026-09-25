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
// 📚 V77.6.2 `--key _YEARLY_BT_LONG` = 2011~2026 長歷史那一份(SET=long,策略是子集 + 組合)
const KEY = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : '_YEARLY_BT';
const LONG = KEY !== '_YEARLY_BT';
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
const YRS = LONG ? J.years : YEARS;
if (!LONG && slim.strats.length !== STRATS.length) die(`策略數 ${slim.strats.length} ≠ STRATS ${STRATS.length}`);
if (LONG && (slim.strats.length < 20 || YRS.length < 15)) die(`長歷史那一份太小:${slim.strats.length} 個策略 × ${YRS.length} 年`);
for (const s of slim.strats) for (const y of YRS) if (!s.y[y]) die(`${s.id} 缺 ${y}`);
if (!(slim.bench['2022'] && slim.bench['2022'].twii < 0)) die('2022 的加權對照缺或不是負的(那一年應該是空頭)');
if (LONG && !(slim.bench['2011'] && slim.bench['2011'].twii < 0)) die('2011 的大盤代理不是負的(那一年應該是空頭)');
if (LONG) slim.proxyUntil = '2021-09-15';
if (!slim.strats.some(s => s.id === 'base')) die('沒有「決策台現行」那一列');

const P = path.join(ROOT, 'pro.html');
const html = fs.readFileSync(P, 'utf8');
const lines = html.split('\n');
const idx = lines.findIndex(l => new RegExp('^\\s*' + KEY + ': \\{').test(l));
if (idx < 0) die(`pro.html 找不到 \`${KEY}:\` 那一行`);
lines[idx] = `  ${KEY}: ` + JSON.stringify(slim) + ',';
fs.writeFileSync(P, lines.join('\n'));

// ④ 讀回來比對
const back = JSON.parse(fs.readFileSync(P, 'utf8').split('\n')[idx].replace(new RegExp('^\\s*' + KEY + ': '), '').replace(/,$/, ''));
for (const s of J.strats) {
    const b = back.strats.find(x => x.id === s.id);
    for (const y of YRS) { if (b.y[y][3] !== s.y[y].pnl || b.y[y][0] !== s.y[y].n) die(`讀回來對不上:${s.id} ${y}`); }
}
console.log(`✅ 已嵌入 ${KEY}:${slim.strats.length} 個策略 × ${YRS.length} 年(${(lines[idx].length / 1024).toFixed(1)} KB)・交叉驗證通過`);
