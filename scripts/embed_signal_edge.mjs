#!/usr/bin/env node
/**
 * 📥 把 data/signal_edge.json 嵌進 index.html 的 `_SIGNAL_EDGE` / `_SIGNAL_EDGE_META`
 *
 * ⚠️ 為什麼要有這支(V72.0.2 踩過的坑):
 *   以前是手動 sed/regex 換 —— 結果**只換到 meta、沒換到資料表**,
 *   於是 meta 說「500 檔、A=42」但資料還是 250 檔那版。
 *   這種不一致**最難發現**,因為兩邊各自看起來都對。
 *   ⭐ 所以嵌入這件事一定要「兩行一起換 + 換完立刻交叉驗證」,⛔ 別再手動改。
 *
 * 用法:
 *   node scripts/signal_backtest.mjs          # 先跑回測(產 data/signal_edge.json)
 *   node scripts/embed_signal_edge.mjs        # 再嵌入
 *   node scripts/test_sigedge.mjs             # 驗證
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'signal_edge.json');
const HTML = path.join(ROOT, 'index.html');

const j = JSON.parse(fs.readFileSync(SRC, 'utf-8'));
const sigs = j.signals || [];
if (!sigs.length) { console.error('❌ signal_edge.json 沒有訊號,不嵌入'); process.exit(1); }

// 資料表:key = "偵測器｜標題",value = [grade, n, e10, w10, p, e20, payoff, exp]
const table = {};
// ⚠️ 欄位名以 signal_edge.json 實際輸出為準:key 本身就是「偵測器｜標題」
//   (第一版猜成 s.det / s.title → 全部變成 "undefined｜undefined",
//    但**交叉驗證當場擋下來了** —— 這正是這支腳本存在的價值)
for (const s of sigs) {
    if (!s.key) { console.error('❌ 訊號缺 key 欄位,結構可能改了'); process.exit(1); }
    table[s.key] = [
        s.grade, s.n, s.e10, s.w10, s.p, s.e20,
        s.payoff == null ? null : s.payoff,
        s.exp == null ? null : s.exp,
    ];
}
// ⚠️ base.win / base.med 是**依天期分的物件**({5:..,10:..,20:..}),不是純數字。
//   前端 `_SIGNAL_EDGE_META.base_win` 要的是**10 日**那個(徽章與教學都用 10 日)。
const _b10 = (o, k) => {
    const v = (o && typeof o === 'object') ? o['10'] : o;
    if (typeof v !== 'number' || !isFinite(v)) { console.error(`❌ base.${k} 取不到 10 日值:${JSON.stringify(o)}`); process.exit(1); }
    return v;
};
const meta = {
    base_win: _b10(j.base.win, 'win'), base_med: _b10(j.base.med, 'med'), syms: j.syms,
    n_base: j.base.n, A: j.grades.A, B: j.grades.B, C: j.grades.C,
    ...(j.cover ? { cover: j.cover } : {}),
};

// ⭐ 兩行都是**單獨一行** → 用行號整行替換,⛔ 不用跨行 regex(那正是上次只換一半的原因)
const lines = fs.readFileSync(HTML, 'utf-8').split('\n');
const iMeta = lines.findIndex(l => l.trimStart().startsWith('_SIGNAL_EDGE_META:'));
const iData = lines.findIndex(l => l.trimStart().startsWith('_SIGNAL_EDGE:'));
if (iMeta < 0 || iData < 0) { console.error(`❌ 找不到嵌入點(meta=${iMeta} data=${iData})`); process.exit(1); }

const indent = l => l.slice(0, l.length - l.trimStart().length);
lines[iMeta] = `${indent(lines[iMeta])}_SIGNAL_EDGE_META: ${JSON.stringify(meta)},`;
lines[iData] = `${indent(lines[iData])}_SIGNAL_EDGE: ${JSON.stringify(table)},`;
fs.writeFileSync(HTML, lines.join('\n'), 'utf-8');

// ── ⭐ 換完立刻交叉驗證(⛔ 這步不可省 —— 它就是為了防「只換一半」)──
const after = fs.readFileSync(HTML, 'utf-8').split('\n');
const m2 = JSON.parse(after[iMeta].trim().replace(/^_SIGNAL_EDGE_META:\s*/, '').replace(/,$/, ''));
const t2 = JSON.parse(after[iData].trim().replace(/^_SIGNAL_EDGE:\s*/, '').replace(/,$/, ''));
const cnt = { A: 0, B: 0, C: 0 };
for (const v of Object.values(t2)) cnt[v[0]] = (cnt[v[0]] || 0) + 1;
const bad = [];
if (cnt.A !== m2.A || cnt.B !== m2.B || cnt.C !== m2.C) bad.push(`分級數不符 meta=${JSON.stringify({ A: m2.A, B: m2.B, C: m2.C })} 實際=${JSON.stringify(cnt)}`);
if (Object.keys(t2).length !== sigs.length) bad.push(`筆數不符 ${Object.keys(t2).length} vs ${sigs.length}`);
if (m2.syms !== j.syms) bad.push(`檔數不符 ${m2.syms} vs ${j.syms}`);
if (bad.length) { console.error('❌ 交叉驗證失敗:\n  ' + bad.join('\n  ')); process.exit(1); }

const kb = (after[iData].length / 1024).toFixed(1);
console.log(`✅ 已嵌入:${Object.keys(t2).length} 個訊號(${kb} KB)`);
console.log(`   涵蓋 ${m2.syms} 檔・基準勝率 ${m2.base_win.toFixed(1)}%・A=${m2.A} B=${m2.B} C=${m2.C}`);
if (m2.cover) console.log(`   代號開頭分布:${JSON.stringify(m2.cover)}`);
console.log('   ⭐ 交叉驗證通過(meta 與資料表一致)');
console.log('   👉 接著跑:node scripts/test_sigedge.mjs');
