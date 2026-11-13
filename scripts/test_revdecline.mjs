#!/usr/bin/env node
/**
 * 📉 V82.3.1 「營收衰退中」App 抄本 == 研究那一份(EXP-20261113-04)
 *   ① index.html `_revDecline` 跟 scripts/trade_lead_probe.mjs 的 yoy3 / acc3(rev_decline_probe 用的同一份)用亂數逐筆比:
 *      算不算得出來一樣、近 3 個月年增 / 比上個月差多少一樣、成立與否(yoy3 < 0 且 acc3 < 0)一樣
 *   ② 過期守門:最新那個月不是「現在該有」的月份 → 不判;⭐ 決定性對照:同一份資料把今天往前挪 → 照判
 *   ③ 只有 12 個月 / 缺一個月 → 不判(⛔ 當成沒衰退);順序亂的照樣對
 *   ④ 全市場基準 _REV_DEC_BASE:比例 = 事件 ÷ 算得出來的股票·月、標實測日期與來源
 * 注入:INJECT=sign(改成 yoy3 > 0)/ stale(拿掉過期守門)各自紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { yoy3, acc3, ymAdd } from './trade_lead_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INJ = process.env.INJECT || '';
const ORIG = SRC;
if (INJ === 'sign') SRC = SRC.replace('return { ym: last, y3, a3, on: y3 < 0 && a3 < 0 };', 'return { ym: last, y3, a3, on: y3 > 0 && a3 < 0 };');
if (INJ === 'stale') SRC = SRC.replace('if (last < ymAdd(T.slice(0, 7), +T.slice(8, 10) >= 11 ? -1 : -2)) return null;', '');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// 抽出 index.html 的 _revDecline(⛔ 測試裡另寫一份 —— 要比的就是 App 那一份)
const m = SRC.match(/\n    _revDecline\(mrh, today\) \{\n([\s\S]*?)\n    \},\n/);
if (!m) { console.log('❌ index.html 找不到 _revDecline'); process.exit(1); }
const revDecline = new Function('mrh', 'today', m[1]);
const base = (SRC.match(/_REV_DEC_BASE: (\{[^}]*\})/) || [])[1];
const B = base ? Function(`return (${base});`)() : null;

// ① 亂數逐筆比
let seed = 20261113;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let same = 0, diff = 0, nOn = 0, nNull = 0;
const bad = [];
for (let t = 0; t < 600; t++) {
    const end = ymAdd('2026-09', -Math.floor(rnd() * 30)), n = 13 + Math.floor(rnd() * 8);
    const rows = [];
    for (let k = n - 1; k >= 0; k--) {
        if (rnd() < 0.04) continue;                       // 偶爾缺一個月
        rows.push([ymAdd(end, -k), Math.round(50 + rnd() * 100)]);
    }
    rows.sort(() => rnd() - 0.5);                         // 順序亂的也要對
    const app = revDecline(rows, null);
    const M = new Map(rows.map(r => [r[0], r[1]])), get = x => M.get(x);
    const last = [...M.keys()].sort().pop();
    const y = yoy3(get, last), a = acc3(get, last);
    const ref = (y == null || a == null) ? null : { y3: y, a3: a, on: y < 0 && a < 0 };
    const eq = (app == null && ref == null) || (app && ref && Math.abs(app.y3 - ref.y3) < 1e-9 && Math.abs(app.a3 - ref.a3) < 1e-9 && app.on === ref.on && app.ym === last);
    if (eq) same++; else { diff++; if (bad.length < 3) bad.push({ app, ref, last }); }
    if (ref == null) nNull++; else if (ref.on) nOn++;
}
ok(`① 600 組亂數:App 抄本 == trade_lead_probe 的 yoy3 / acc3(算得出來 ${600 - nNull}、成立 ${nOn}、算不出來 ${nNull})`, diff === 0 && nOn > 20 && nNull > 20, JSON.stringify(bad));

// ② 過期守門(手算一組:近 3 個月 85 / 90 / 80 vs 一年前 100 → −15%;上一段 −10% → 差 −5)
const mk = (end, tail) => { const out = []; const nn = 12 + tail.length; for (let k = nn - 1; k >= 0; k--) out.push([ymAdd(end, -k), k < tail.length ? tail[tail.length - 1 - k] : 100]); return out; };
const dn = mk('2026-09', [95, 90, 85, 80]);
const r1 = revDecline(dn, '2026-10-19'), r2 = revDecline(dn, '2026-11-13'), r3 = revDecline(dn, '2026-11-05');
ok('② 9 月營收:10/19 看(該有 9 月)→ 成立、近 3 個月 −15.0%、比上個月那段差 −5.0', r1 && r1.on && r1.ym === '2026-09' && Math.abs(r1.y3 + 15) < 1e-9 && Math.abs(r1.a3 + 5) < 1e-9, JSON.stringify(r1));
ok('② 11/13 看(該有 10 月了、這檔還停在 9 月)→ 過期 ⛔ 判;⭐ 決定性對照:11/05 看(10 月還沒到公布期限)→ 照判', r2 === null && r3 && r3.on, JSON.stringify([r2, r3]));
// ③ 資料不夠
ok('③ 只有 12 個月 → 算不出來(⛔ 當成沒衰退);缺上個月那一段要的那一個月 → 算不出來', revDecline(dn.slice(-12), null) === null
   && revDecline(dn.filter(r => r[0] !== '2025-06'), null) === null, JSON.stringify([revDecline(dn.slice(-12), null)]));
ok('③ 營收在成長 → 不成立;空的 / 壞的 → null', revDecline(mk('2026-09', [105, 110, 115, 120]), null).on === false && revDecline([], null) === null && revDecline([['x', 'y']], null) === null);
// ④ 全市場基準
ok('④ _REV_DEC_BASE:比例 = 事件 ÷ 股票·月(25.0%)、帶實測日期、期間與來源', B && Math.abs(B.pct - Math.round(B.ev / B.n * 1000) / 10) < 1e-9 && B.asof && B.from && B.to && /rev_decline_probe/.test(B.src), JSON.stringify(B));
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
