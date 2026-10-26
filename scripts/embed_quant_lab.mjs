#!/usr/bin/env node
/**
 * 📐 V79.9.2 把量化實驗室的結果 + 核心放進產業作戰室(⛔ 手改)
 *   ① PRO.QLAB  = quant_lab_build.mjs 的輸出(瘦身成一行;⛔ 超過 80 KB → exit 1)
 *   ② QCORE 區塊 = scripts/lib_quant.mjs「QCORE BEGIN ~ END」原封不動抄進 pro.html 與 index.html(test_quant_core ④ 逐字比對)
 *   ③ 📐 V79.8.9 index.html `_QLAB_SIGS` = PRO.QLAB 裡判定「⛔ 比亂買還差」的那幾支:只放 id / 名字 / 白話條件 / 中心參數的策略
 *      (⛔ 研究數字 —— 散戶 App 只拿來判「你的持股 / 自選今天碰到了」;≤ 3 KB)
 *   跑法:node scripts/embed_quant_lab.mjs qlab_all.json   ・只更新核心 + _QLAB_SIGS:node scripts/embed_quant_lab.mjs --core
 *   交叉驗證(對不上 exit 1):策略數 == qlab_strategies.json、每支都有判定 / 次數 / 逐年、寫完重新抽出來一樣
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expand } from './quant_lab_build.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO = path.join(ROOT, 'pro.html'), IDX = path.join(ROOT, 'index.html');
const die = m => { console.error('❌ ' + m); process.exit(1); };
let src = fs.readFileSync(PRO, 'utf8'), idx = fs.readFileSync(IDX, 'utf8');
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8'));

// ② QCORE 區塊(兩個檔)
const lib = fs.readFileSync(path.join(ROOT, 'scripts/lib_quant.mjs'), 'utf8');
const B = '// ==QCORE BEGIN==', E = '// ==QCORE END==';
const li = lib.indexOf(B), lj = lib.indexOf(E); if (li < 0 || lj < li) die('lib_quant.mjs 找不到 QCORE 區塊');
const block = lib.slice(li, lj + E.length);
const putCore = (s, anchor, nm) => {
    const pi = s.indexOf(B), pj = s.indexOf(E);
    if (pi >= 0 && pj > pi) return s.slice(0, pi) + block + s.slice(pj + E.length);
    const at = s.indexOf(anchor); if (at < 0) die(`${nm} 找不到 ${anchor.trim()}`);
    return s.slice(0, at + 1) + block + '\n' + s.slice(at + 1);
};
src = putCore(src, '\nconst PRO = {', 'pro.html');
idx = putCore(idx, '\nconst app = {', 'index.html');

// ① QLAB
const f = process.argv[2];
if (f && f !== '--core') {
    const J = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(J.fam) || J.fam.length !== S.families.length) die(`策略數對不上:結果 ${J.fam && J.fam.length} / 定義 ${S.families.length}`);
    const r2 = x => x == null ? null : Math.round(x * 1000) / 1000;
    const slim = j => j && j.n ? { n: j.n, x: r2(j.x), win: j.win, p: j.p, h1: r2(j.h1), h2: r2(j.h2), yPos: j.yPos, yN: j.yN, dropY: r2(j.dropY), dropM: r2(j.dropM), bestY: j.bestY, yrs: j.yrs } : { n: 0 };
    const fam = J.fam.map(x => {
        if (!['ok', 'bad', 'none'].includes(x.verdict) || !(x.n > 0) || !x.c || !Array.isArray(x.c.yrs)) die(`${x.id} 不完整`);
        const def = S.families.find(s => s.id === x.id);
        return { id: x.id, name: x.name, pl: x.pl || (def && def.pl) || x.key, why: x.why, desc: x.desc, key: x.key, center: x.center, verdict: x.verdict, st: def ? JSON.parse(JSON.stringify(def.st)) : null,
                 n: x.n, sig: x.sig, blk: x.blk, c: slim(x.c), h10: slim(x.h10), adj: slim(x.adj), shamGross: x.shamGross, q: x.q, qNeg: x.qNeg,
                 gates: x.gates, gatesNeg: x.gatesNeg, plateau: x.plateau, plateauNeg: x.plateauNeg, sham: x.sham, shamBeat: x.shamBeat, shamWorse: x.shamWorse,
                 grid: x.grid.map(g => ({ p: g.p, center: !!g.center, n: g.n, x: r2(g.x), x10: r2(g.x10), adj: r2(g.adj), q: g.q })) };
    });
    const out = { built: J.built, src: J.src, syms: J.syms, win: J.win, revSyms: J.revSyms, dispo: J.dispo, cost: J.cost, exits: J.exits, tests: J.tests, fam };
    const line = `  QLAB: ${JSON.stringify(out)},`;
    if (line.length > 80000) die(`QLAB 太大:${line.length} 字(上限 80,000)`);
    const re = /\n  QLAB: \{.*\},\n/;
    if (re.test(src)) src = src.replace(re, '\n' + line + '\n');
    else { const at = src.indexOf('\n  STRAT_NAMES: {'); if (at < 0) die('pro.html 找不到 STRAT_NAMES'); src = src.slice(0, at + 1) + line + '\n' + src.slice(at + 1); }
    const back = JSON.parse(src.match(/\n  QLAB: (\{.*\}),\n/)[1]);
    if (back.fam.length !== fam.length || back.fam.some((x, k) => x.n !== fam[k].n || x.verdict !== fam[k].verdict)) die('寫完重新抽出來對不上');
    console.log(`✅ PRO.QLAB 寫入:${fam.length} 支策略(${fam.filter(x => x.verdict === 'ok').length} 有用 / ${fam.filter(x => x.verdict === 'bad').length} 比亂買還差 / ${fam.filter(x => x.verdict === 'none').length} 跟亂買差不多)・${line.length.toLocaleString()} 字`);
}

// ③ index.html _QLAB_SIGS(從 pro.html 現在那份 QLAB 來 —— 只換核心時也跟著重寫)
function qlabSigs(Q, defs) {
    const bad = [];
    for (const x of (Q.fam || []).filter(x => x.verdict === 'bad')) {
        const def = defs.families.find(s => s.id === x.id); if (!def) die(`${x.id} 不在 qlab_strategies.json`);
        if (!def.ev) die(`${x.id} 沒有 ev(白話條件)`);
        const c = expand(def).find(v => v.center); if (!c) die(`${x.id} 找不到中心參數`);
        const key = Object.keys(def.center)[0], v = def.center[key];
        bad.push({ id: x.id, name: x.name, ev: def.ev.split('$' + key).join(String(v)), st: c.st });
    }
    return { built: Q.built, win: Q.win, bad };
}
{
    const m = src.match(/\n  QLAB: (\{.*\}),\n/);
    if (m) {
        const sigs = qlabSigs(JSON.parse(m[1]), S);
        const line = `    _QLAB_SIGS: ${JSON.stringify(sigs)},`;
        if (line.length > 3000) die(`_QLAB_SIGS 太大:${line.length} 字(上限 3,000)`);
        const re = /\n    _QLAB_SIGS: \{.*\},\n/;
        if (!re.test(idx)) die('index.html 找不到 _QLAB_SIGS 那一行(先放一行 `    _QLAB_SIGS: {},`)');
        idx = idx.replace(re, '\n' + line + '\n');
        const back = JSON.parse(idx.match(/\n    _QLAB_SIGS: (\{.*\}),\n/)[1]);
        if (back.bad.length !== sigs.bad.length || back.bad.some(x => JSON.stringify(x.st).includes('$'))) die('_QLAB_SIGS 寫完對不上 / 還有沒代換的參數');
        console.log(`✅ index.html _QLAB_SIGS:${sigs.bad.map(x => x.name).join('、') || '(沒有)'}・${line.length} 字`);
    }
}
fs.writeFileSync(PRO, src); fs.writeFileSync(IDX, idx);
console.log('✅ QCORE 區塊已同步到 pro.html + index.html');
