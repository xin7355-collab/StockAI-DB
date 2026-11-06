#!/usr/bin/env node
/**
 * 📉 V82.0.0 worker 台北 08:00「大跌提醒」(cloud-worker/worker.js `crashDipLines` / `crashEvLine`)
 *  ① 事件日 = 資料最後那天 + 今天 = 它的下一個開盤日(nx)才講;nx 不是今天(放假 / 資料沒更新)→ 一個字都沒有(決定性對照)
 *  ② 今天 09:00 要買的那一批:選 👑 不發、開關關掉不發、空頭守門開著 + 那天嚴格空頭不發
 *  ③ 你有買的那一批今天抱滿才發;沒按「我有買」的⛔ 發
 *  ④ 沒事 → 空陣列(⛔ 天天發「今天沒事」)
 *  ⑤ 文字:發生率 +「⛔ 不是會漲或會跌」+ 照出場規則走;⛔ 減碼 / 出清 / 空手 / 現金為王
 *  ⑥ 跨檔:同一個事件,worker 的數字 == App `_crashEvText` 的數字(兩份文字、同一份 occ)
 *  ⑦ App 的同步:sanitizePayload 收 crashTg / dipTg / bearGate / dipMine(只收日期格式)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
const W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const tmp = path.join(ROOT, 'scripts', `.tmp_worker_cd_${process.pid}.mjs`);
fs.writeFileSync(tmp, W);
let M; try { M = await import(tmp); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
const { crashDipLines, crashEvLine } = M;
ok('⓪ export crashDipLines / crashEvLine', typeof crashDipLines === 'function' && typeof crashEvLine === 'function');
const occ = { from: 2000, leg10: { n: 24, d15: 16, d20: 9, end20: 6 }, bear20: { n: 9, more10: 5, end250: 5 }, end: { n: 23, again60: 6 }, fast15: { from: 1990, n: 21, leg: 20, wk: 8, mo: 7, half: 5, re: 12, reN: 19, base: 57 } };
const L = { s: '2026-11-03', peak: { d: '2026-10-06', c: 49822.55 }, ev: [{ k: 'leg10', d: '2026-11-03', c: 43307.5, dd: -13.1 }, { k: 'fast15', d: '2026-11-05', c: 41574.7, dd: -16.6 }] };
const ce = { through: '2026-11-05', nx: '2026-11-06', occ, legs: [L] };
const L10 = Array.from({ length: 10 }, (_, k) => ({ s: String(2301 + k), lim: 100 }));
const dp = { batches: [{ t: '2026-11-05', ix: -3.2, b: '2026-11-06', s: '2026-12-31', st: 'wait', bear: 1, L: L10 }, { t: '2026-10-15', ix: -3.41, b: '2026-10-16', s: '2026-11-06', st: 'hold', L: L10 }] };
const S = { strategy: 'gene' };
const a = crashDipLines(ce, dp, S, '2026-11-06');
ok('① 今天 = nx → 講昨天的事件(25 天跌 15%)', a.some(x => /25 天內跌了 15%/.test(x)), a.join(' || '));
ok('① 只講事件日 = 資料最後那天的(11/03 那則⛔ 再講)', !a.some(x => /第一次跌到 10%/.test(x)), a.join(' || '));
ok('① 今天 ≠ nx(放假 / 資料沒更新)→ 沒有事件(決定性對照)', !crashDipLines(ce, null, S, '2026-11-09').length);
ok('② 今天 09:00 要買的那一批', a.some(x => /今天 09:00 開盤買 10 檔/.test(x)), a.join(' || '));
ok('② 選 👑 → 不發', !crashDipLines(null, dp, { strategy: 'lead' }, '2026-11-06').some(x => /開盤買/.test(x)));
ok('② 開關關掉 → 不發', !crashDipLines(null, dp, { strategy: 'gene', dipTg: false }, '2026-11-06').some(x => /開盤買/.test(x)));
ok('② 空頭守門開著 + 那天嚴格空頭 → 不發', !crashDipLines(null, dp, { strategy: 'gene', bearGate: true }, '2026-11-06').some(x => /開盤買/.test(x)));
ok('② 大跌事件開關關掉 → 不講事件', !crashDipLines(ce, null, { crashTg: false }, '2026-11-06').length);
ok('③ 沒按「我有買」→ ⛔ 發抱滿', !a.some(x => /抱滿 40 天/.test(x)));
const b = crashDipLines(null, dp, { strategy: 'gene', dipMine: ['2026-10-15'] }, '2026-11-06');
ok('③ 你有買的那一批今天抱滿 → 發', b.some(x => /10\/15 那一批今天抱滿 40 天/.test(x)), b.join(' || '));
ok('④ 沒事 → 空陣列', crashDipLines({ ...ce, legs: [] }, { batches: [] }, S, '2026-11-06').length === 0);
const txt = a.join('\n');
ok('⑤ 發生率 +「⛔ 不是會漲或會跌」+ 照出場規則走', /🎲/.test(txt) && /⛔ 不是會漲或會跌/.test(txt) && /手上的照你的出場規則走/.test(txt));
ok('⑤ ⛔ 減碼 / 出清 / 空手 / 現金為王', !/減碼|出清|空手|現金為王|全部賣/.test(txt), txt);
// ⑥ 跨檔:App `_crashEvText`
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = /\n    _crashEvText\(/.exec(SRC); const s0 = SRC.indexOf('{', m.index + 5); let d = 0, i = s0;
for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
const appTxt = (0, eval)('({' + SRC.slice(m.index + 5, i + 1) + '})')._crashEvText;
const A = { _dW: v => String(v).slice(5).replace('-', '/') };
const nums = t => (String(t).split('🎲')[1] || '').match(/\d+(\.\d+)?/g) || [];
let same = 0, all = 0;
for (const e of [...L.ev, { k: 'bear20', d: '2026-11-07', c: 39800, dd: -20.1 }, { k: 'end', d: '2026-12-01', c: 48000, dd: -3.6 }]) {
    all++; const ap = appTxt.call(A, e, L, occ), wk = crashEvLine(e, L, occ);
    if (JSON.stringify(nums(ap[1])) === JSON.stringify(nums(wk))) same++; else console.log('   App:', nums(ap[1]).join(','), ' worker:', nums(wk).join(','));
}
ok(`⑥ 四種事件:worker 的發生率數字 == App(${same}/${all})`, same === all);
// ⑦ sanitizePayload 白名單(原始碼)
ok('⑦ worker 白名單收 crashTg / dipTg / bearGate / dipMine', /crashTg: payload\.settings\.crashTg !== false/.test(W) && /dipTg: payload\.settings\.dipTg !== false/.test(W) && /bearGate: payload\.settings\.bearGate === true/.test(W) && /dipMine: Array\.isArray\(payload\.settings\.dipMine\)/.test(W));
ok('⑦ App 同步有送這四個', /crashTg:\s+app\._alertCatOn/.test(SRC) && /dipTg:\s+app\._alertCatOn/.test(SRC) && /bearGate:\s+app\._bearGateOn/.test(SRC) && /dipMine:\s+\(app\._dipMineTs/.test(SRC));
ok('⑦ 08:00 那一輪有叫 runCrashDipPush', /ctx\.waitUntil\(runCrashDipPush\(env\)\)/.test(W));
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_worker_crashdip 全過');
process.exit(fails.length ? 1 : 0);
