#!/usr/bin/env node
/**
 * 🧼 「大戶洗散戶」洗盤走法回測(V74.4.2)—— 使用者:「當大戶在洗散戶的籌碼的時候
 * 是不是有特定的走法?再怎麼清洗?」
 *
 * 可測的版本:噴過一段(近20日 ≥20%)之後回檔 5~25%。回檔期間用**集保週資料**分辨:
 *   🧼 洗盤樣 = 千張大戶比例**升**(前1/3)且散戶人數**降**(前1/3)→ 大戶在接、散戶被洗出去
 *   🏃 出貨樣 = 大戶比例**降**且散戶人數**升** → 大戶把貨倒給散戶
 * 若「洗盤樣」的後續報酬明顯好於「出貨樣」→ 洗盤有可辨識的走法;再交叉「量縮/量增」
 * 回答「怎麼清洗」(坊間:洗盤量縮、出貨量增)。
 *
 * ⭐ 對照組 = **所有回檔事件**(共用「噴過+回檔」那條腿)——
 *   ⛔ 拿全市場當對照量到的是「回檔」本身,不是集保方向的鑑別力(broker_cross_probe 的做法)。
 * ⭐ 分類門檻用**事件內分位(前/後 1/3)**,⛔ 不寫死 ±X pp(憑空門檻鐵則)。
 * ⭐ 零前視:集保週資料取「週結算日 < 事件日」的紀錄(TDCC 週五結算、週六公布 →
 *   結算日嚴格早於事件日的紀錄,事件日當天一定查得到)。
 *
 * 用法:node scripts/washout_probe.mjs <tdcc_deep.json> [gdataDir]
 * 資料:tdcc_deep.json 內層 {sym:{t:總股數, h:[[週結算YYYYMMDD, 千張大戶%, 400張大戶%, 散戶%, 散戶人數],…]}}
 */
import fs from 'fs';
import path from 'path';

const TDCC_FILE = process.argv[2] || '';
const GDATA = process.argv[3] || 'data';
if (!TDCC_FILE || !fs.existsSync(TDCC_FILE)) { console.error('用法:node scripts/washout_probe.mjs <tdcc_deep.json> [gdataDir]'); process.exit(1); }
const TD = JSON.parse(fs.readFileSync(TDCC_FILE, 'utf8'));

const iso = s => String(s || '').replace(/\//g, '-');
const ymd = s => s.replace(/-/g, '');            // 2026-07-31 → 20260731(跟 tdcc 週日期同格式比大小)
const HOLDS = [10, 20, 60];
const COST = 0.44;

function loadK(sym) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(GDATA, sym + '.json'), 'utf8'));
    if (!Array.isArray(rows) || rows.length < 120) return null;
    const d = [], o = [], c = [], v = [];
    for (const r of rows) {
      if (!Number.isFinite(r.close) || !Number.isFinite(r.open)) continue;
      d.push(iso(r.date)); o.push(r.open); c.push(r.close); v.push(r.volume || 0);
    }
    return { d, o, c, v };
  } catch { return null; }
}
const twii = loadK('^TWII');
const twIdx = {}; twii.d.forEach((x, i) => twIdx[x] = i);
const mkt = (d0, d1) => {
  const a = twIdx[d0], b = twIdx[d1];
  return (a == null || b == null) ? null : (twii.c[b] / twii.c[a] - 1) * 100;
};
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const wr = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : null;
const f1 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);

// ═══ 掃事件:噴 ≥20% 的高點 → 10 個交易日後回檔 5~25% ═══
const events = [];
const files = fs.readdirSync(GDATA).filter(f => /^\d{4,6}\.json$/.test(f));
let nStock = 0;
for (const f of files) {
  const sym = path.basename(f, '.json');
  const td = TD[sym];
  if (!td || !(td.h || []).length) continue;
  const K = loadK(sym);
  if (!K) continue;
  nStock++;
  const H = td.h;                                 // [[yyyymmdd, big1000, big400, retailPct, retailCnt],…]
  let lastT1 = -99;
  for (let p = 25; p < K.d.length - 61; p++) {
    // 高點:今天是近 20 根最高收盤,且近 20 根漲幅 ≥20%
    if (K.c[p] !== Math.max(...K.c.slice(p - 19, p + 1))) continue;
    if (!(K.c[p - 20] > 0) || K.c[p] / K.c[p - 20] - 1 < 0.20) continue;
    const t1 = p + 10;
    const dd = K.c[t1] / K.c[p] - 1;
    if (dd > -0.05 || dd < -0.25) continue;       // 要「回檔」不要「還在噴」也不要「崩盤」
    if (t1 - lastT1 < 20) continue;               // 同檔 20 個交易日去重
    lastT1 = t1;
    // 集保:結算日**嚴格早於**事件日(零前視);高點前 vs 事件日前,要有新的一週才算
    const d1 = ymd(K.d[t1]), d0 = ymd(K.d[p]);
    let r1 = null, r0 = null;
    for (const rec of H) {
      if (rec[0] < d0) r0 = rec;
      if (rec[0] < d1) r1 = rec; else break;
    }
    if (!r0 || !r1 || r1[0] <= r0[0]) continue;
    const dBig = r1[1] - r0[1];                                     // 千張大戶比例變化(pp)
    const dRet = r0[4] > 0 ? (r1[4] / r0[4] - 1) * 100 : null;      // 散戶人數變化(%)
    if (dRet == null) continue;
    // 量:回檔期均量 / 噴的那段均量
    const vUp = avg(K.v.slice(p - 9, p + 1)), vDn = avg(K.v.slice(p + 1, t1 + 1));
    const vrr = vUp > 0 ? vDn / vUp : null;
    // 進場 = 事件日隔天開盤;報酬扣同期大盤
    const e = t1 + 1;
    if (!(K.o[e] > 0)) continue;
    const ret = {};
    for (const n of HOLDS) {
      const j = e + n;
      if (j >= K.d.length) { ret[n] = null; continue; }
      const mk = mkt(K.d[e], K.d[j]);
      ret[n] = mk == null ? null : (K.c[j] / K.o[e] - 1) * 100 - mk;
    }
    events.push({ sym, d: K.d[t1], dBig, dRet, vr: vrr, dd: dd * 100, ret });
  }
}
console.log(`掃描:${nStock} 檔有集保深歷史 ・回檔事件 ${events.length} 筆(噴≥20% → 10日內回 5~25%)`);
if (events.length < 200) { console.log('⏳ 樣本不足'); process.exit(0); }

// ═══ 分類:事件內分位(⛔ 不寫死 pp 門檻)═══
const q = (arr, p) => { const b = arr.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)]; };
const bigHi = q(events.map(e => e.dBig), 2 / 3), bigLo = q(events.map(e => e.dBig), 1 / 3);
const retHi = q(events.map(e => e.dRet), 2 / 3), retLo = q(events.map(e => e.dRet), 1 / 3);
console.log(`分位門檻:大戶Δ前1/3 > ${bigHi.toFixed(2)}pp ・後1/3 < ${bigLo.toFixed(2)}pp ・散戶人數Δ前1/3 > ${retHi.toFixed(2)}% ・後1/3 < ${retLo.toFixed(2)}%`);
const wash = events.filter(e => e.dBig > bigHi && e.dRet < retLo);   // 🧼 大戶收、散戶被洗出去
const dump = events.filter(e => e.dBig < bigLo && e.dRet > retHi);   // 🏃 大戶倒給散戶

function cell(name, rows) {
  const r20 = rows.map(r => r.ret[20]).filter(v => v != null);
  if (r20.length < 60) { console.log(`  ${name}: n=${r20.length} ⏳ 樣本不足`); return; }
  const base20 = avg(events.map(r => r.ret[20]).filter(v => v != null));
  const e10 = avg(rows.map(r => r.ret[10]).filter(v => v != null)) - avg(events.map(r => r.ret[10]).filter(v => v != null));
  const e20 = avg(r20) - base20;
  const e60 = avg(rows.map(r => r.ret[60]).filter(v => v != null)) - avg(events.map(r => r.ret[60]).filter(v => v != null));
  const ds = rows.filter(r => r.ret[20] != null).map(r => r.d).sort();
  const mid = ds[Math.floor(ds.length / 2)];
  const h1 = avg(rows.filter(r => r.ret[20] != null && r.d < mid).map(r => r.ret[20])) - base20;
  const h2 = avg(rows.filter(r => r.ret[20] != null && r.d >= mid).map(r => r.ret[20])) - base20;
  console.log(`  ${name}: n=${r20.length} ・10/20/60日邊際(vs 全部回檔事件)${f1(e10)}/${f1(e20)}/${f1(e60)}pp` +
    ` ・勝率 ${wr(r20).toFixed(1)}% ・前後半 ${f1(h1)}/${f1(h2)}${h1 * h2 > 0 ? ' ✅同向' : ' ❌不同向'}` +
    ` ・扣成本 ${f1(e20 - COST)}pp ・回檔深度中位 ${med(rows.map(r => r.dd)).toFixed(1)}% ・量比中位 ${med(rows.map(r => r.vr).filter(v => v != null)).toFixed(2)}`);
}

const base = events.map(r => r.ret[20]).filter(v => v != null);
console.log(`\n(對照組 = 全部回檔事件:20日均 ${f1(avg(base))}% ・中位 ${f1(med(base))}% ・勝率 ${wr(base).toFixed(1)}%)`);
console.log('\n═══ ① 集保方向(回檔期間誰在收/誰在跑)═══');
cell('🧼 洗盤樣(大戶↑・散戶人數↓)', wash);
cell('🏃 出貨樣(大戶↓・散戶人數↑)', dump);
console.log('\n═══ ② 交叉「怎麼清洗」:量縮 vs 量增 ═══');
const vShrink = e => e.vr != null && e.vr < q(events.map(x => x.vr).filter(v => v != null), 1 / 3);
const vHeavy = e => e.vr != null && e.vr > q(events.map(x => x.vr).filter(v => v != null), 2 / 3);
cell('🧼 洗盤樣 × 量縮', wash.filter(vShrink));
cell('🧼 洗盤樣 × 量增', wash.filter(vHeavy));
cell('🏃 出貨樣 × 量縮', dump.filter(vShrink));
cell('🏃 出貨樣 × 量增', dump.filter(vHeavy));
console.log('\n═══ ③ 只看量(不看集保)—— 坊間「洗盤量縮」單獨成不成立 ═══');
cell('全部回檔 × 量縮(前1/3)', events.filter(vShrink));
cell('全部回檔 × 量增(前1/3)', events.filter(vHeavy));

console.log('\n⚠️ 限制:集保是**週**資料(回檔 10 個交易日只夾得到 1~2 週);千張大戶比例含法人/' +
  '公司派,⛔ 不是只有「主力」;窗口受 tdcc_deep 覆蓋(多數 104 週、部分 53 週);' +
  '事件窗口偏多頭;倖存者偏誤。分類門檻 = 事件內前/後 1/3 分位(⛔ 非寫死)。');
