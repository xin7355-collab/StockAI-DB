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
 *       V78.0.8 只換單列:node scripts/embed_yearly_bt.mjs --merge now.json lead.json(⚠️ 整張模式不會帶 👑 那幾列,整張重跑完要再 --merge 一次)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRATS, COMBOS } from './yearly_bt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = '_YEARLY_BT';
const die = m => { console.error('🚨 ' + m); process.exit(1); };
const cols = ['n', 'win', 'per', 'pnl', 'ret', 'perAmt', 'worst', 'best', 'dd', 'lo', 'hi', 'cross'];
const P = path.join(ROOT, 'pro.html');
const readCur = () => { const ls = fs.readFileSync(P, 'utf8').split('\n'); const i = ls.findIndex(l => new RegExp('^\\s*' + KEY + ': \\{').test(l)); if (i < 0) die(`pro.html 找不到 \`${KEY}:\` 那一行`); return { ls, i, v: JSON.parse(ls[i].replace(new RegExp('^\\s*' + KEY + ': '), '').replace(/,$/, '')) }; };
const slimRow = (s, extra = {}) => ({ id: s.id, g: s.g, t: s.t, ...(s.na ? { na: s.na } : {}), ...(s.c ? { c: s.c } : {}), ...(s.yb ? { yb: s.yb } : {}), ...(s.bc ? { bc: s.bc } : {}), ...extra,
    y: Object.fromEntries(Object.entries(s.y).map(([y, v]) => [y, v == null ? null : cols.map(k => v[k] ?? null)])) });

// 🔀 V78.0.8 --merge <現行.json> <領頭羊.json>:⛔ 不用整張 79 種重跑,只換「⭐ 現行」那一列 + 加 👑 領頭羊四列
//   現行.json = ONLY=now807 SET=long yearly_bt.mjs --collect(帶 CONT_DIR)・領頭羊.json = leader_probe.mjs YEARLY_OUT
//   ⚠️ 這幾列是**修好日 K 之後**的資料,其餘是修好之前的 → 每一列標 `dv`(2 = 修好後),畫面分批標示,⛔ 不可靜默混在一起
if (process.argv[2] === '--merge') {
    const [nowF, leadF] = process.argv.slice(3);
    if (!nowF || !leadF) die('用法:node scripts/embed_yearly_bt.mjs --merge <now.json> <lead.json>');
    const N = JSON.parse(fs.readFileSync(nowF, 'utf8')), L = JSON.parse(fs.readFileSync(leadF, 'utf8'));
    const { ls, i: idx, v: Y } = readCur();
    const YRS = Y.years;
    const chk = (r, why) => {
        for (const y of YRS) { const a = r.y[y]; if (a == null && !(r.na && y < r.na.from)) die(`${r.id} ${why} 缺 ${y}`); if (a && a.length !== cols.length) die(`${r.id} ${y} 欄位數不對`); }
        if (!r.c || r.c.paths !== 17) die(`${r.id} 沒有一路滾 17 條`);
        if (!r.yb || !r.bc) die(`${r.id} 沒有自己的 0050 對照(yb / bc)→ ⛔ 不可拿舊表的 0050 跟新資料比`);
    };
    const nowRow = N.strats.find(s => s.id === N.nowId);
    if (!nowRow || N.strats.length !== 1) die(`現行.json 應該只有一列(${N.nowId}),實際 ${N.strats.length}`);
    const nr = slimRow(nowRow, { dv: 2 }); chk(nr, '現行');
    const leads = L.rows.map(r => slimRow(r, { dv: 2 }));
    if (leads.length < 1 || leads.some(r => r.g !== 'lead')) die('領頭羊.json 的列不是 g=lead');
    leads.forEach(r => chk(r, '領頭羊'));
    // ⭐ 交叉驗證:👑 全攻的一路滾 == 💰「100 萬變多少」那張表的 16 年全攻(同一個引擎、同一組 17 起點)
    const pbLine = ls.find(l => /^\s*_PROFIT_BOARD: \{/.test(l));
    if (pbLine) { const PB = JSON.parse(pbLine.replace(/^\s*_PROFIT_BOARD: /, '').replace(/,$/, '')); const a = (PB.wins.long.rows || []).find(x => x.k === 'lead'), b = leads.find(x => x.id === 'lead');
        if (a && b && Math.abs((a.fin - 1e6) - b.c.med) > 1000) die(`👑 全攻一路滾 ${b.c.med} ≠ 💰 表的 ${a.fin - 1e6}(引擎或資料對不上)`); }
    const keep = Y.strats.filter(s => s.id !== nr.id && s.g !== 'lead').map(s => s.id === Y.nowId ? { ...s, g: 'prev', t: s.t.replace(/^⭐\s*決策台現行\(([^)]*)\)/, '⏮️ 上一任($1)') } : s);
    Y.strats = [nr, ...leads, ...keep];
    Y.nowId = nr.id;
    Y.groups = { lead: '👑 領頭羊短線輪動', ...Y.groups };
    Y.v2 = { asof: L.asof, to: L.data_to, ids: [nr.id, ...leads.map(r => r.id)] };
    ls[idx] = `  ${KEY}: ` + JSON.stringify(Y) + ',';
    fs.writeFileSync(P, ls.join('\n'));
    const back = readCur().v;
    for (const r of [nr, ...leads]) { const b = back.strats.find(x => x.id === r.id); if (!b || b.c.med !== r.c.med || JSON.stringify(b.y) !== JSON.stringify(r.y)) die(`讀回來對不上:${r.id}`); }
    if (back.strats.length !== Y.strats.length || !back.strats.some(s => s.id === 'base')) die('讀回來列數不對或沒有 base');
    console.log(`✅ 已併入 ${KEY}:現行 ${nr.id} + 👑 ${leads.length} 列(共 ${back.strats.length} 列,${(ls[idx].length / 1024).toFixed(1)} KB)・交叉驗證通過`);
    process.exit(0);
}

const SRC = process.argv[2];
if (!SRC) { console.error('🚨 用法:node scripts/embed_yearly_bt.mjs <yearly.json>'); process.exit(1); }
const J = JSON.parse(fs.readFileSync(SRC, 'utf8'));
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
