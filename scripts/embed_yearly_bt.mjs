#!/usr/bin/env node
/**
 * 📥 V77.6.1 把 `yearly_bt.mjs --collect` 的結果嵌進 pro.html 的 `_YEARLY_BT`(一行)
 *   ⛔ 別手動改那一行(V72.0.2 手動換 `_SIGNAL_EDGE` 只換到一半的教訓)。
 * 📚 V77.6.6 只剩**一份**(使用者:「把能合併就合併」):SET=long 的 2011~2026、全部策略 + 組合,
 *   每列多帶 `c`(一個帳戶一路滾 17 條起點)與 `na`(資料起點晚於 2011 的策略);⛔ 不再有 `_YEARLY_BT_LONG`。
 *   嵌完當場**交叉驗證**,任一項不符就 exit 1(⛔ 不可靜默寫進去):
 *     ① 策略數 == yearly_bt.mjs 的 STRATS + COMBOS ② 每一年都有值;null 只准出現在 `na.from` 之前
 *     ③ 2011 / 2022 的加權是負的(空頭年)④ 每列都有 `c` 且 17 條、有 benchCont(含息)
 *     ⑤ 嵌進去之後再讀回來,跟 json 逐格相同
 * 用法:SET=long … node scripts/yearly_bt.mjs --collect y.json && node scripts/embed_yearly_bt.mjs y.json [--proxy]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRATS, COMBOS } from './yearly_bt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
const KEY = '_YEARLY_BT';
if (!SRC) { console.error('🚨 用法:node scripts/embed_yearly_bt.mjs <yearly.json>'); process.exit(1); }
const J = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const die = m => { console.error('🚨 ' + m); process.exit(1); };

const cols = ['n', 'win', 'per', 'pnl', 'ret', 'perAmt', 'worst', 'best', 'dd', 'lo', 'hi', 'cross'];
// ⭐ 只留畫面要用的欄位(控制大小)
const slim = {
    asof: J.asof, nowId: J.nowId || 'base', years: J.years, offsets: J.offsets, picks: J.picks, groups: J.groups, skipped: J.skipped, bench: J.bench,
    benchCont: J.benchCont || null,
    strats: J.strats.map(s => ({ id: s.id, g: s.g, t: s.t, ...(s.na ? { na: s.na } : {}), ...(s.c ? { c: s.c } : {}),
        y: Object.fromEntries(Object.entries(s.y).map(([y, v]) => [y, v == null ? null : cols.map(k => v[k])])) })),
    cols,
};
const YRS = J.years;
const WANT = STRATS.length + COMBOS.length;
if (slim.strats.length !== WANT) die(`策略數 ${slim.strats.length} ≠ STRATS+COMBOS ${WANT}`);
if (YRS.length < 15 || YRS[0] !== '2011') die(`年份不對:${YRS[0]}~ 共 ${YRS.length} 年(應該是 2011 起的 16 年)`);
for (const s of slim.strats) for (const y of YRS) {
    if (s.y[y]) continue;
    if (s.y[y] === null && s.na && y < s.na.from) continue;   // ⏳ 資料起點之前:null + 原因(合法)
    die(`${s.id} 缺 ${y}`);
}
if (!(slim.bench['2022'] && slim.bench['2022'].twii < 0)) die('2022 的加權對照缺或不是負的(那一年應該是空頭)');
if (!(slim.bench['2011'] && slim.bench['2011'].twii < 0)) die('2011 的加權不是負的(那一年應該是空頭)');
for (const s of slim.strats) if (!s.c || s.c.paths !== 17) die(`${s.id} 沒有「一路滾」17 條(${s.c ? s.c.paths : 0})`);
if (!(slim.benchCont && slim.benchCont.e0050tr != null)) die('沒有一路滾的 0050 含息對照(benchCont)');
if (process.argv.includes('--proxy')) slim.proxyUntil = '2021-09-15';
if (!slim.strats.some(s => s.id === 'base')) die('沒有「舊預設」那一列(base)');
if (!slim.strats.some(s => s.id === slim.nowId)) die(`沒有「決策台現行」那一列(${slim.nowId})`);

const P = path.join(ROOT, 'pro.html');
const html = fs.readFileSync(P, 'utf8');
const lines = html.split('\n');
const idx = lines.findIndex(l => new RegExp('^\\s*' + KEY + ': \\{').test(l));
if (idx < 0) die(`pro.html 找不到 \`${KEY}:\` 那一行`);
lines[idx] = `  ${KEY}: ` + JSON.stringify(slim) + ',';
fs.writeFileSync(P, lines.join('\n'));

// ⑤ 讀回來比對
const back = JSON.parse(fs.readFileSync(P, 'utf8').split('\n')[idx].replace(new RegExp('^\\s*' + KEY + ': '), '').replace(/,$/, ''));
for (const s of J.strats) {
    const b = back.strats.find(x => x.id === s.id);
    if ((b.c && b.c.med) !== (s.c && s.c.med)) die(`讀回來對不上:${s.id} 一路滾`);
    for (const y of YRS) {
        if (s.y[y] == null) { if (b.y[y] !== null) die(`讀回來對不上:${s.id} ${y} 應為 null`); continue; }
        if (b.y[y][3] !== s.y[y].pnl || b.y[y][0] !== s.y[y].n) die(`讀回來對不上:${s.id} ${y}`);
    }
}
console.log(`✅ 已嵌入 ${KEY}:${slim.strats.length} 個策略 × ${YRS.length} 年 + 一路滾 17 條(${(lines[idx].length / 1024).toFixed(1)} KB)・交叉驗證通過`);
