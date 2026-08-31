#!/usr/bin/env node
/**
 * 🏭 板塊選對之後,產業「內部」怎麼挑?(V74.4.1)
 *
 * V74.2.5 已證明「20 日相對強弱最強的前 3 個產業」有 +1.44pp 的邊際(六關全過)。
 * ⛔ 但**第二步從來沒測過**:選對板塊之後,在那個板塊裡面該挑哪一種股票?
 *
 * ⭐⭐ 這是**增量檢定**,所以對照組必須是「**同一批強勢板塊裡的所有股票**」——
 *    ⛔ 拿全市場當對照,量到的是「板塊選對」的功勞,不是「挑股」的功勞。
 *    (同 broker_cross_probe 的「共用非分點的那條腿」)
 *
 * 測 6 種挑法:
 *   ① 板塊內最強(近 20 日漲最多)     ← 追強
 *   ② 板塊內最弱(補漲)               ← 江湖最愛
 *   ③ 板塊內位階最高                   ← 🧬 的一半
 *   ④ 板塊內位階最低(便宜)
 *   ⑤ 板塊內波動最大                   ← 🧬 的另一半
 *   ⑥ 板塊內成交額最大(龍頭)
 *
 * 進場 = 隔天開盤 ・報酬扣同期加權 ・同檔同挑法 20 日去重
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const WIN = 20;              // 板塊動能窗口(V74.2.5 實測最佳實用值)
const TOPN = 3;              // 取前 N 強板塊
const HOR = [5, 10, 20];
const COST = 0.44;
const DEDUP = 20;
const MIN_MEMB = 5;          // 板塊當天至少幾檔算得出來

// ── 大盤 ──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) {
  const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
  if (d) { mkt.set(d, +r.close); mdays.push(d); }
}
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => {
  const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]);
  return a > 0 ? (b / a - 1) * 100 : null;
};

// ── 產業對照(只有上市有)──
const indOf = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'));

// ── 讀 K 線 ──
const S = new Map();         // sym -> {d:[], c:[], o:[], h:[], l:[], v:[]}
let nSym = 0;
for (const sym of Object.keys(indOf)) {
  const f = path.join(DATA, `${sym}.json`);
  if (!fs.existsSync(f)) continue;
  let rows;
  try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 300) continue;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0);
  if (R.length < 300) continue;
  const o = { d: [], c: [], op: [], v: [], i: new Map() };
  for (const r of R) {
    const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
    if (!d) continue;
    o.i.set(d, o.d.length);
    o.d.push(d); o.c.push(+r.close); o.op.push(+r.open); o.v.push(+r.volume || 0);
  }
  if (o.d.length < 300) continue;
  S.set(sym, o); nSym++;
}
console.log(`\n📊 母體:${nSym} 檔上市股(⚠️ industry_map 只涵蓋上市)・${Object.keys(indOf).length} 檔有產業別`);

// ── 逐日:算板塊動能 → 取前 3 強 → 在裡面挑股 ──
const buckets = new Map();
const add = (k, v) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(v); };
const lastSeen = new Map();  // `${key}|${sym}` -> 上次 index(去重)

const days = mdays.filter(d => d >= '2023-09-01');   // 個股資料 2023-06 起 + WIN 暖身
let nDay = 0, nPick = 0;

for (let di = 0; di < days.length - 21; di++) {
  const D = days[di];
  // ① 每個產業的 20 日中位報酬
  const byInd = new Map();
  for (const [sym, o] of S) {
    const i = o.i.get(D);
    if (i == null || i < WIN + 252) continue;
    const r20 = (o.c[i] / o.c[i - WIN] - 1) * 100;
    const g = indOf[sym];
    if (!byInd.has(g)) byInd.set(g, []);
    byInd.get(g).push({ sym, i, r20 });
  }
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const ranked = [...byInd.entries()]
    .filter(([, m]) => m.length >= MIN_MEMB)
    .map(([g, m]) => ({ g, m, v: med(m.map(x => x.r20)) }))
    .sort((a, b) => b.v - a.v);
  if (ranked.length < 20) continue;
  nDay++;

  // ② 只看前 3 強板塊(V74.2.5 已證明這一步有效)
  const hot = ranked.slice(0, TOPN);
  const pool = [];
  for (const { m } of hot) for (const x of m) pool.push(x);
  if (pool.length < 15) continue;

  // 每檔算挑股用的指標
  for (const x of pool) {
    const o = S.get(x.sym), i = x.i;
    const w = o.c.slice(i - 251, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    x.pos = hi > lo ? (o.c[i] - lo) / (hi - lo) * 100 : 50;
    let amp = 0;
    for (let q = i - 19; q <= i; q++) amp += Math.abs(o.c[q] / o.c[q - 1] - 1) * 100;
    x.amp = amp / 20;
    x.amt = o.c[i] * o.v[i];
  }

  const emit = (key, x) => {
    const o = S.get(x.sym), e = x.i + 1;
    if (e >= o.d.length) return;
    const kk = `${key}|${x.sym}`;
    const p = lastSeen.get(kk);
    if (p != null && x.i - p < DEDUP) return;
    lastSeen.set(kk, x.i);
    const ret = { _d: o.d[e] };
    for (const n of HOR) {
      const j = e + n;
      if (j >= o.d.length) { ret[n] = null; continue; }
      const m = mktRet(o.d[e], n);
      ret[n] = m == null ? null : (o.c[j] / o.op[e] - 1) * 100 - m;
    }
    add(key, ret); nPick++;
  };

  // ⭐ 對照組 = 前 3 強板塊裡的**所有**股票(⛔ 不是全市場)
  for (const x of pool) emit('對照組(強勢板塊內全部)', x);

  const top = (arr, f, n = 3) => arr.slice().sort((a, b) => f(b) - f(a)).slice(0, n);
  const bot = (arr, f, n = 3) => arr.slice().sort((a, b) => f(a) - f(b)).slice(0, n);
  for (const x of top(pool, z => z.r20)) emit('① 板塊內最強(近20日漲最多)', x);
  for (const x of bot(pool, z => z.r20)) emit('② 板塊內最弱(補漲)', x);
  for (const x of top(pool, z => z.pos)) emit('③ 板塊內位階最高', x);
  for (const x of bot(pool, z => z.pos)) emit('④ 板塊內位階最低(便宜)', x);
  for (const x of top(pool, z => z.amp)) emit('⑤ 板塊內波動最大', x);
  for (const x of top(pool, z => z.amt)) emit('⑥ 板塊內成交額最大(龍頭)', x);
  // ⑦ 🧬 組合:位階 ≥75 且 波動在池子裡前 40%
  const ampSort = pool.map(z => z.amp).sort((a, b) => a - b);
  const ampP60 = ampSort[Math.floor(ampSort.length * 0.6)];
  for (const x of pool) if (x.pos >= 75 && x.amp >= ampP60) emit('⑦ 🧬 板塊內「高位階+高波動」', x);
}

// ── 統計 ──
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const base = buckets.get('對照組(強勢板塊內全部)') || [];
const bAvg = {}, bWin = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null);
  bAvg[n] = avg(v); bWin[n] = v.filter(x => x > 0).length / v.length * 100;
}
console.log(`   掃 ${nDay} 個交易日 ・${nPick.toLocaleString()} 個 pick ・對照組 ${base.length.toLocaleString()}`);
console.log(`   🚨 對照組 = **強勢板塊裡的所有股票**(⛔ 不是全市場 —— 那樣量到的是「選對板塊」的功勞)`);
console.log(`   對照組平均超額:` + HOR.map(n => `${n}日 ${bAvg[n].toFixed(2)}%`).join(' ・')
  + ` ・10日勝率 ${bWin[10].toFixed(1)}%\n`);

const allD = base.map(e => e._d).sort();
const MID = allD[Math.floor(allD.length / 2)];
const sub = (evs, f, n = 10) => evs.filter(f).map(e => e[n]).filter(x => x != null);
const bSub = (f, n = 10) => { const v = sub(base, f, n); return v.length ? avg(v) : null; };

const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組') || evs.length < 200) continue;
  const r = { k, n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - bAvg[n] : null;
    if (n === 10) r.w = v.length ? v.filter(x => x > 0).length / v.length * 100 : null;
  }
  const h1 = sub(evs, e => e._d < MID), h2 = sub(evs, e => e._d >= MID);
  r.h1 = h1.length >= 50 ? avg(h1) - bSub(e => e._d < MID) : null;
  r.h2 = h2.length >= 50 ? avg(h2) - bSub(e => e._d >= MID) : null;
  const yr = {};
  for (const y of ['2023', '2024', '2025', '2026']) {
    const v = sub(evs, e => e._d.startsWith(y)), bv = bSub(e => e._d.startsWith(y));
    if (v.length >= 50 && bv != null) yr[y] = avg(v) - bv;
  }
  r.yr = yr;
  const ys = Object.values(yr);
  r.ySame = ys.length >= 2 && ys.every(x => Math.sign(x) === Math.sign(ys[0]));
  if (ys.length >= 2) {
    const bestY = Object.entries(yr).sort((a, b) => b[1] - a[1])[0][0];
    const v = sub(evs, e => !e._d.startsWith(bestY)), bv = bSub(e => !e._d.startsWith(bestY));
    r.exBest = v.length >= 50 && bv != null ? avg(v) - bv : null;
  }
  rows.push(r);
}
rows.sort((a, b) => (b.e10 ?? -99) - (a.e10 ?? -99));

const pad = (s, w) => String(s).padEnd(w, ' ');
const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
console.log('挑法(在前 3 強板塊裡)'.padEnd(32) + '    n   5日    10日   20日 |前半   後半      逐年     去最好年 扣成本');
console.log('─'.repeat(112));
for (const r of rows) {
  const same = r.h1 != null && r.h2 != null && Math.sign(r.h1) === Math.sign(r.h2);
  const net = (r.e10 ?? 0) - COST;
  const pass = net > 0 && same && r.ySame && (r.exBest ?? -9) > 0;
  console.log(pad(r.k, 32) + String(r.n).padStart(6) + ' '
    + [5, 10, 20].map(n => num(r[`e${n}`]).padStart(6)).join(' ') + ' |'
    + num(r.h1).padStart(6) + num(r.h2).padStart(7) + (same ? '✅' : '❌')
    + ' ' + ['2023', '2024', '2025', '2026'].map(y => num(r.yr[y], 1).padStart(5)).join('') + (r.ySame ? '✅' : '❌')
    + num(r.exBest).padStart(8) + num(net).padStart(8) + (pass ? ' ⭐全過' : ''));
}
console.log('\n(數字 = 相對「強勢板塊裡隨便挑一檔」的超額 pp ・進場=隔天開盤 ・扣同期加權)');
console.log(`(⭐ 扣成本 ${COST}% 後仍為正、且前後半同向+逐年同向+去最好年為正,才算過關)\n`);
