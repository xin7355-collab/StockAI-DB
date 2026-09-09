#!/usr/bin/env node
/**
 * 🕳️ 跳空缺口「沒回補」的續航(V74.4.3)—— LAB next 欄那條「偵測器已有、從沒回測過」。
 *
 * 朱家泓:「缺口不補繼續走」。可測版本:
 *   事件 = 向上**真缺口**(今天最低 > 昨天最高,且缺口 ≥0.5%)之後第 5 個交易日,
 *   分兩組:🕳️ 5 天內**沒回補**(這 5 根的最低都 > 缺口下緣)vs 🩹 已回補。
 *   進場 = 第 5 天的隔日開盤;報酬扣同期加權;對照組 = **全部真缺口事件**(共用那條腿)。
 * ⭐ 為什麼對照組不是全市場:問題是「沒回補 vs 回補了」的**差**,
 *   ⛔ 拿全市場當對照量到的是「跳空」本身(V74.4.1 已測過:+0.33pp 未過關)。
 * ⭐ 位階交叉:V74.4.1 已知「跳空×高位階」六關全過 → 這裡要問的是
 *   「沒回補」在位階**之外**還有沒有增量(⛔ 不可把高位階的功勞算給沒回補)。
 *
 * 用法:node scripts/gapfill_probe.mjs [gdataDir](預設 ./data)
 */
import fs from 'fs';
import path from 'path';

const GDATA = process.argv[2] || 'data';
const iso = s => String(s || '').replace(/\//g, '-');
const COST = 0.44;
const HOLDS = [10, 20];

function loadK(sym) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(GDATA, sym + '.json'), 'utf8'));
    if (!Array.isArray(rows) || rows.length < 300) return null;
    const d = [], o = [], c = [], h = [], l = [];
    for (const r of rows) {
      if (!Number.isFinite(r.close) || !Number.isFinite(r.open)) continue;
      d.push(iso(r.date)); o.push(r.open); c.push(r.close); h.push(r.high); l.push(r.low);
    }
    return { d, o, c, h, l };
  } catch { return null; }
}
const twii = loadK('^TWII');
const twIdx = {}; twii.d.forEach((x, i) => twIdx[x] = i);
const mkt = (d0, d1) => {
  const a = twIdx[d0], b = twIdx[d1];
  return (a == null || b == null) ? null : (twii.c[b] / twii.c[a] - 1) * 100;
};
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const wr = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : null;
const f1 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);

const events = [];
const files = fs.readdirSync(GDATA).filter(f => /^\d{4,6}\.json$/.test(f));
for (const f of files) {
  const sym = path.basename(f, '.json');
  const K = loadK(sym);
  if (!K) continue;
  let lastT = -99;
  for (let g = 260; g < K.d.length - 26; g++) {
    // 向上真缺口:今低 > 昨高,缺口 ≥0.5%(⛔ 幾乎貼平的不算 —— 一跳動單位就「回補」了)
    if (!(K.l[g] > K.h[g - 1] * 1.005)) continue;
    const t1 = g + 4;                          // 缺口日起算第 5 個交易日
    if (t1 - lastT < 10) continue;             // 同檔 10 日去重
    lastT = t1;
    const gapTop = K.h[g - 1];                 // 缺口下緣(回補判準)
    let filled = false;
    for (let j = g; j <= t1; j++) if (K.l[j] <= gapTop) { filled = true; break; }
    const e = t1 + 1;
    if (e >= K.d.length || !(K.o[e] > 0)) continue;
    // 排除進場開盤鎖死
    if (Math.abs(K.o[e] / K.c[t1] - 1) * 100 >= 9.7 && K.h[e] === K.l[e]) continue;
    // 位階(近 250 根收盤的百分位,只用當天為止的資料)
    const w = K.c.slice(Math.max(0, t1 - 249), t1 + 1);
    const rank = w.filter(x => x <= K.c[t1]).length / w.length * 100;
    const ret = {};
    for (const n of HOLDS) {
      const j = e + n;
      if (j >= K.d.length) { ret[n] = null; continue; }
      const mk = mkt(K.d[e], K.d[j]);
      ret[n] = mk == null ? null : (K.c[j] / K.o[e] - 1) * 100 - mk;
    }
    events.push({ sym, d: K.d[t1], filled, rank, ret });
  }
}
console.log(`真缺口事件(第 5 天檢查點):${events.length} 筆 ・沒回補 ${events.filter(e => !e.filled).length} ・已回補 ${events.filter(e => e.filled).length}`);

function cell(name, rows, baseRows) {
  const r20 = rows.map(r => r.ret[20]).filter(v => v != null);
  const b20 = baseRows.map(r => r.ret[20]).filter(v => v != null);
  if (r20.length < 100) { console.log(`  ${name}: n=${r20.length} ⏳ 樣本不足`); return; }
  const e20 = avg(r20) - avg(b20);
  const e10 = avg(rows.map(r => r.ret[10]).filter(v => v != null)) - avg(baseRows.map(r => r.ret[10]).filter(v => v != null));
  const ds = rows.filter(r => r.ret[20] != null).map(r => r.d).sort();
  const mid = ds[Math.floor(ds.length / 2)];
  const hf = w => avg(rows.filter(r => r.ret[20] != null && (w ? r.d >= mid : r.d < mid)).map(r => r.ret[20])) - avg(b20);
  const yrs = {};
  for (const r of rows) if (r.ret[20] != null) (yrs[r.d.slice(0, 4)] = yrs[r.d.slice(0, 4)] || []).push(r.ret[20]);
  const yE = Object.entries(yrs).filter(([, a]) => a.length >= 40).map(([y, a]) => [y, avg(a) - avg(b20)]);
  let exBest = null;
  if (yE.length >= 2) {
    const bestY = yE.slice().sort((a, b) => b[1] - a[1])[0][0];
    exBest = avg(rows.filter(r => r.ret[20] != null && r.d.slice(0, 4) !== bestY).map(r => r.ret[20])) - avg(b20);
  }
  console.log(`  ${name}: n=${r20.length} ・10/20日邊際 ${f1(e10)}/${f1(e20)}pp ・勝率 ${wr(r20).toFixed(1)}%(對照 ${wr(b20).toFixed(1)}%)` +
    `\n    前後半 ${f1(hf(0))}/${f1(hf(1))}${hf(0) * hf(1) > 0 ? ' ✅同向' : ' ❌不同向'} ・逐年 ${yE.map(([y, v]) => `${y}:${f1(v)}`).join(' ')} ・去最好年 ${f1(exBest)} ・扣成本 ${f1(e20 - COST)}pp`);
}

console.log('\n═══ ① 沒回補 vs 已回補(對照組 = 全部真缺口事件)═══');
cell('🕳️ 5天沒回補', events.filter(e => !e.filled), events);
cell('🩹 5天內已回補', events.filter(e => e.filled), events);
console.log('\n═══ ② 位階交叉(⭐ 對照組 = **同位階**的全部缺口事件 —— 位階的功勞不能算給「沒回補」)═══');
cell('沒回補 × 高位階(≥75)', events.filter(e => !e.filled && e.rank >= 75), events.filter(e => e.rank >= 75));
cell('已回補 × 高位階(≥75)', events.filter(e => e.filled && e.rank >= 75), events.filter(e => e.rank >= 75));
cell('沒回補 × 低位階(<40)', events.filter(e => !e.filled && e.rank < 40), events.filter(e => e.rank < 40));
console.log('\n⚠️ 限制:窗口偏多頭;倖存者偏誤;「回補」用日低觸及缺口下緣判定(盤中一根下影就算補)。');
