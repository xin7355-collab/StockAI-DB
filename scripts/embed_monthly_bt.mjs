#!/usr/bin/env node
/**
 * 📥 V77.8.4 把 `month_probe.mjs` 的結果嵌進 pro.html 的 `_MONTHLY_BT`(一行)
 *   ⛔ 別手動改那一行(V72.0.2 手動換 `_SIGNAL_EDGE` 只換到一半的教訓)。
 *   嵌完當場交叉驗證,任一項不符就 exit 1:
 *     ① 兩個 leg(現行 / 閒錢停 0050)都在、17 條起點 ② 完整月 ≥ 36 個、逐月表的完整月數 == desc.n
 *     ③ 持有 1/3/6/12 個月四格都在 ④ 預測檢定三條都在 ⑤ 嵌進去之後再讀回來逐格相同
 * 用法:node scripts/month_probe.mjs month.json && node scripts/embed_monthly_bt.mjs month.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
const KEY = '_MONTHLY_BT';
const PRO = process.env.PRO_HTML || path.join(ROOT, 'pro.html');
const die = m => { console.error('🚨 ' + m); process.exit(1); };
if (!SRC) die('用法:node scripts/embed_monthly_bt.mjs <month.json>');
const J = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const slimLeg = L => ({
    paths: L.paths, desc: L.desc, roll: L.roll,
    predict: Object.fromEntries(Object.entries(L.predict.tests).map(([k, v]) => [k, { q: v.q, d: v.d, t: v.t, na: v.na, nb: v.nb, first: v.first, second: v.second, pass: v.pass }])),
    t: L.table.map(r => [r.m, r.s, r.c, r.n, r.partial ? 1 : 0]),       // [月, 策略%, 0050含息%, 起點數, 不完整月]
});
const slim = { asof: J.asof, from: J.from, to: J.to, note: J.note, legs: {} };
for (const k of ['pb', 'idle']) { if (!J.legs[k]) die(`少了 leg ${k}`); slim.legs[k] = slimLeg(J.legs[k]); }
for (const [k, L] of Object.entries(slim.legs)) {
    if (L.paths !== 17) die(`${k} 起點數 ${L.paths} ≠ 17`);
    if (!(L.desc.n >= 36)) die(`${k} 完整月只有 ${L.desc.n} 個`);
    const full = L.t.filter(r => !r[4] && r[3] >= 1).length;
    if (Math.abs(full - L.desc.n) > 2) die(`${k} 逐月表完整月 ${full} 跟 desc.n ${L.desc.n} 對不上`);
    for (const h of [1, 3, 6, 12]) if (!L.roll[h] || L.roll[h].beat == null) die(`${k} 持有 ${h} 個月那格是空的`);
    if (Object.keys(L.predict).length < 3) die(`${k} 預測檢定不到 3 條`);
}
const lines = fs.readFileSync(PRO, 'utf8').split('\n');
const idx = lines.findIndex(l => new RegExp(`^\\s*${KEY}: \\{`).test(l));
if (idx < 0) die(`pro.html 找不到 ${KEY} 那一行`);
const ind = lines[idx].match(/^\s*/)[0];
lines[idx] = `${ind}${KEY}: ${JSON.stringify(slim)},`;
fs.writeFileSync(PRO, lines.join('\n'));
const back = JSON.parse(fs.readFileSync(PRO, 'utf8').split('\n')[idx].replace(new RegExp(`^\\s*${KEY}: `), '').replace(/,$/, ''));
if (JSON.stringify(back) !== JSON.stringify(slim)) die('讀回來跟 json 不一樣');
console.log(`✅ ${KEY} 已嵌入 L${idx + 1}(${(lines[idx].length / 1024).toFixed(1)} KB):${slim.from}~${slim.to}・現行完整月 ${slim.legs.pb.desc.n} 個`);
