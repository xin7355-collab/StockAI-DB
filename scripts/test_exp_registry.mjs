#!/usr/bin/env node
/**
 * 🗂️ V82.1.2 實驗登錄守門(SELF_EVOLVING_AUDIT G2)
 *   ① research/experiments.ndjson 每一行讀得出來、每個 id 剛好一筆 pre(結果最多一筆)、pre 時間 ≤ done 時間、判定是那四種之一
 *   ② 實測總表(pro.html PRO.LAB)寫了 x 的條目:登錄裡找得到、已經有結果、判定 == 條目所在的欄(ok / trap)、tries 一致
 *   ③ 2026-11-12 以後新加的 ✅ / ⛔ 條目一定要有 x,而且 ⛔ 不可以是事後補登(retro)—— 先登記判定條件再跑
 *   ④ 同一個 id 不可以掛在兩條上
 *   ⭐ 決定性對照(合成資料,不讀檔):沒有 x / 判定跟欄位不同 / 先有結果才登記 / 新條目標補登 → 各自要紅
 * 跑法:node scripts/test_exp_registry.mjs      INJECT=nox|verdict|order|retro 注入必紅
 */
import fs from 'fs';
import path from 'path';
import { readReg, byId, VERDICTS } from './exp_log.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CUTOFF = '2026-11-12';

/** pro.html → [{col, k, u, x, tries}](只讀 ok / trap 兩欄) */
export function labRows(src) {
    const out = [];
    for (const col of ['ok', 'trap']) {
        const a = src.indexOf(`\n    ${col}: [`); if (a < 0) continue;
        const b = src.indexOf('\n    ],', a), seg = src.slice(a, b);
        for (const line of seg.split('\n')) {
            const k = (line.match(/\bk: '([a-z0-9-]+)'/) || [])[1]; if (!k) continue;
            out.push({ col, k, u: (line.match(/\bu: '([0-9-]+)'/) || [])[1] || '', x: (line.match(/\bx: '(EXP-[0-9]{8}-[0-9]{2})'/) || [])[1] || null,
                tries: +((line.match(/\btries: (\d+)/) || [])[1] || NaN) });
        }
    }
    return out;
}

export function check(rows, lab) {
    const bad = [];
    let M;
    try { M = byId(rows); } catch (e) { return [e.message]; }
    for (const [id, e] of M) {
        if (!/^EXP-\d{8}-\d{2}$/.test(id)) bad.push(`${id} id 格式不對`);
        if (!e.pre) { bad.push(`${id} 有結果卻沒有事先登記`); continue; }
        if (!e.pre.crit) bad.push(`${id} 沒寫判定條件`);
        if (e.done) {
            if (!(e.pre.at <= e.done.at)) bad.push(`${id} 結果比登記早(${e.done.at} < ${e.pre.at})`);
            if (!VERDICTS.includes(e.done.verdict)) bad.push(`${id} 判定 ${e.done.verdict} 不認得`);
        }
    }
    const used = new Map();
    for (const r of lab) {
        if (r.x) {
            if (used.has(r.x)) bad.push(`${r.x} 同時掛在 ${used.get(r.x)} 與 ${r.k}`); used.set(r.x, r.k);
            const e = M.get(r.x);
            if (!e) { bad.push(`${r.k} 的 ${r.x} 登錄裡找不到`); continue; }
            if (!e.done) bad.push(`${r.k} 的 ${r.x} 還沒有結果`);
            else {
                if (e.done.verdict !== r.col) bad.push(`${r.k} 在 ${r.col} 欄、登錄判定是 ${e.done.verdict}`);
                if (Number.isFinite(r.tries) && e.done.tries != null && e.done.tries !== r.tries) bad.push(`${r.k} tries ${r.tries} ≠ 登錄 ${e.done.tries}`);
            }
            if (r.u >= CUTOFF && e.pre && e.pre.retro) bad.push(`${r.k}(${r.u})是新條目卻標事後補登 —— 先登記判定條件再跑`);
        } else if (r.u >= CUTOFF) bad.push(`${r.k}(${r.u})是新的 ${r.col} 條目卻沒有 x(實驗登錄 id)`);
    }
    return bad;
}

function selftest() {
    let ok = 0, nbad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : nbad++; };
    const reg = [
        { id: 'EXP-20261112-01', t: 'pre', at: '2026-11-12T01:00:00Z', q: 'q', crit: 'c', retro: false },
        { id: 'EXP-20261112-01', t: 'done', at: '2026-11-12T02:00:00Z', verdict: 'trap', tries: 5 },
    ];
    const lab = [{ col: 'trap', k: 'a', u: '2026-11-12', x: 'EXP-20261112-01', tries: 5 }];
    const I = process.env.INJECT || '';
    const L1 = I === 'nox' ? [{ ...lab[0], x: null }] : lab;
    const R1 = I === 'verdict' ? [reg[0], { ...reg[1], verdict: 'ok' }] : I === 'order' ? [reg[0], { ...reg[1], at: '2026-11-11T00:00:00Z' }] : I === 'retro' ? [{ ...reg[0], retro: true }, reg[1]] : reg;
    t(check(R1, L1).length === 0, `① 正常的一組 → 沒問題`);
    t(check(reg, [{ ...lab[0], x: null }]).some(x => /沒有 x/.test(x)), '② 新條目沒有 x → 紅');
    t(check([reg[0], { ...reg[1], verdict: 'ok' }], lab).some(x => /登錄判定是 ok/.test(x)), '③ 判定跟欄位不同 → 紅');
    t(check([reg[0], { ...reg[1], at: '2026-11-11T00:00:00Z' }], lab).some(x => /結果比登記早/.test(x)), '④ 先有結果才登記 → 紅');
    t(check([{ ...reg[0], retro: true }, reg[1]], lab).some(x => /事後補登/.test(x)), '⑤ 新條目標事後補登 → 紅');
    t(check(reg, [{ ...lab[0], u: '2026-11-01', x: null }]).length === 0, '⑥ 11/12 以前的舊條目沒有 x → 不擋');
    t(check([...reg, reg[1]], lab).some(x => /兩筆 done/.test(x)), '⑦ 同一個 id 兩筆結果 → 紅');
    return nbad;
}

const nbadSelf = selftest();
const rows = readReg(), lab = labRows(fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8'));
const bad = check(rows, lab);
const M = byId(rows), withX = lab.filter(r => r.x).length, retro = [...M.values()].filter(e => e.pre && e.pre.retro).length;
console.log(`${bad.length ? '❌' : '✅'} ⑧ 真資料:登錄 ${M.size} 筆(事後補登 ${retro})・實測總表 ${lab.length} 條裡有 x 的 ${withX} 條${bad.length ? ':\n     ' + bad.join('\n     ') : ''}`);
const fails = nbadSelf + (bad.length ? 1 : 0);
console.log(fails ? `❌ ${fails} 條失敗` : '✅ 全部通過');
process.exit(fails ? 1 : 0);
