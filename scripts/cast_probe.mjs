#!/usr/bin/env node
/**
 * 🎣 拋竿(castRod)整套漏斗的回測 — V74.4.2
 *
 * ⭐ 為什麼要這支:使用者問「我要確認有沒有用」。
 *    拋竿的**每一層**單獨都有六關全過的實測背書(🧬 V73.2.3 / 前3強板塊 V74.2.5 / 板塊內最強 V74.4.1),
 *    ⛔ 但**組合起來**從來沒被當成一件事量過 —— 而本專案自己的血淚教訓就是
 *    「每個零件都測過 ≠ 組合起來有用」(🏅 實測體質加總 IC≈0 就是這樣被打掉的)。
 *
 * 測的是 pro.html `_castPick()` **一模一樣**的漏斗:
 *   ⓪ 🚧 成交額 ≥ 1 億(買得到;門檻從每筆 15 萬 ÷ 0.15% 推導)
 *   ① 🧬 一年位階 ≥75 且 20 日振幅 ≥3.2%
 *   ② 💧 近 20 日報酬中位數最強的前 3 個板塊
 *   ③ 🏭 那個板塊裡近 20 日漲最多的
 *   ④ 🎣 一天最多 2 條、**同一個板塊只挑 1 條**
 *
 * ⚠️ 一個誠實限制:⛔ **避雷那一關(噴 ≥30% 又被掛官方注意股)沒有進回測** ——
 *    repo 裡沒有官方注意股的歷史名單。⭐ 但那一關只會**移除**一組另一次實測量到 −1.81pp 的標的,
 *    所以真實表現只會**比這裡好**,⛔ 不會更差(這是保守下界)。
 *
 * ⭐⭐ 對照組刻意有三個(⛔ 只跟全市場比會把「選對板塊」的功勞算到拋竿頭上):
 *    A 全市場(所有算得出來的股·日)
 *    B 🧬 全部(只過位階+波動,不看板塊)     ← 拋竿相對「只用 🧬」有沒有加分
 *    C 強勢板塊裡的所有股票                  ← 拋竿相對「選對板塊之後隨便挑」有沒有加分
 *
 * 進場 = **隔天開盤**(拋竿是收盤後的清單,⛔ 用當天收盤價是前視偏誤)
 * 報酬扣同期加權 ・同檔 20 日去重 ・六道關卡(前後半 / 逐年 / 去最好年 / 扣成本 0.44%)
 *
 * 用法:node scripts/cast_probe.mjs
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const WIN = 20;              // 板塊動能窗口(V74.2.5 實測最佳實用值)
const TOPN = 3;              // 取前 N 強板塊
const HOR = [5, 10, 20];
const COST = 0.44;
const DEDUP = 20;
const MIN_MEMB = 5;          // 板塊當天至少幾檔算得出來
const MIN_AMT = 1e8;         // 🚧 成交額 ≥ 1 億(pro.html CAST_MIN_AMT,⛔ 改一邊要改兩邊)
const POS_MIN = 75, AMP_MIN = 3.2;   // 🧬(pro.html _castPick,⛔ 同上)
const CAST_MAX = 2;          // 一天最多幾條(V73.0.0)

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

// 🚨 V74.2.8 這行原本寫死 `'2023-09-01'`(當時個股資料就是 2023-06 起 + 暖身)。
//    K 線補深到 2021 之後,寫死會把**多出來的兩年半(含 2022 空頭)整段丟掉**,
//    而且報告只會印一個看起來很正常的窗口 → 改成從**實際檔案**推起點。
const PICK_FROM = (() => {
  const firsts = [];
  for (const [, o] of S) if (o && o.d.length >= 400) firsts.push(o.d[0]);
  firsts.sort();
  if (firsts.length < 100) return '2023-09-01';        // 🚧 空過守門:推不出來就退回舊值
  const p75 = firsts[Math.floor(firsts.length * 0.75)];
  const t = new Date(p75 + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 90);   // + WIN 暖身
  return t.toISOString().slice(0, 10);
})();
const days = mdays.filter(d => d >= PICK_FROM);
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

  // ── 對照組 A:全市場(不看板塊、不看 🧬)——⛔ 每天抽 6 檔控制樣本量,但**不挑好的**
  {
    const all = [];
    for (const [sym, o] of S) {
      const i = o.i.get(D); if (i == null || i < WIN + 252) continue;
      all.push({ sym, i });
    }
    for (let q = 0; q < all.length; q += Math.max(1, Math.floor(all.length / 6))) emit('對照組A 全市場', all[q]);
  }
  // ── 對照組 C:前 3 強板塊裡的所有股票
  for (const x of pool) emit('對照組C 強勢板塊內全部', x);

  // 每檔算 🧬 與成交額(pool 已經算過,這裡補全市場的 🧬 對照組 B)
  const geneAll = [];
  for (const [sym, o] of S) {
    const i = o.i.get(D); if (i == null || i < WIN + 252) continue;
    const w = o.c.slice(i - 251, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    const pos = hi > lo ? (o.c[i] - lo) / (hi - lo) * 100 : 50;
    if (pos < POS_MIN) continue;
    let amp = 0; for (let q = i - 19; q <= i; q++) amp += Math.abs(o.c[q] / o.c[q - 1] - 1) * 100;
    amp /= 20;
    if (amp < AMP_MIN) continue;
    if (o.c[i] * o.v[i] < MIN_AMT) continue;                 // 🚧 買得到
    geneAll.push({ sym, i, r20: (o.c[i] / o.c[i - WIN] - 1) * 100 });
  }
  // ⛔ 對照組 B 也要抽樣控制量(⛔ 但不可依 r20 排序後取前幾名 —— 那就變成在挑好的了)
  for (let q = 0; q < geneAll.length; q += Math.max(1, Math.floor(geneAll.length / 4))) emit('對照組B 🧬全部(不看板塊)', geneAll[q]);

  // ── 🎣 拋竿本尊:🧬 ∩ 前3強板塊 ∩ 板塊內最強 ・同板塊只挑 1 條 ・一天最多 2 條
  const geneInHot = pool.filter(x => x.pos >= POS_MIN && x.amp >= AMP_MIN && x.amt >= MIN_AMT)
                        .sort((a, b) => b.r20 - a.r20);
  const usedInd = new Set(); let got = 0;
  for (const x of geneInHot) {
    const g = indOf[x.sym];
    if (usedInd.has(g)) continue;                            // ⛔ 兩條不押同一族
    usedInd.add(g);
    emit('🎣 拋竿(完整漏斗)', x);
    if (++got >= CAST_MAX) break;
  }
  // 🔬 拆解:少一關會差多少(⛔ 這才知道哪一層真的在做事)
  {
    const noSector = geneAll.slice().sort((a, b) => b.r20 - a.r20).slice(0, CAST_MAX);
    for (const x of noSector) emit('🔬 少了板塊那兩關(只 🧬 + 最強)', x);
    const noGene = pool.filter(x => x.amt >= MIN_AMT).sort((a, b) => b.r20 - a.r20);
    const u2 = new Set(); let g2 = 0;
    for (const x of noGene) { const g = indOf[x.sym]; if (u2.has(g)) continue; u2.add(g); emit('🔬 少了 🧬 那一關', x); if (++g2 >= CAST_MAX) break; }
    const noLiq = pool.filter(x => x.pos >= POS_MIN && x.amp >= AMP_MIN).sort((a, b) => b.r20 - a.r20);
    const u3 = new Set(); let g3 = 0;
    for (const x of noLiq) { const g = indOf[x.sym]; if (u3.has(g)) continue; u3.add(g); emit('🔬 少了買得到那一關', x); if (++g3 >= CAST_MAX) break; }
  }
}

// ── 統計 ──
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const BASE_KEY = process.env.BASE || '對照組C 強勢板塊內全部';
const base = buckets.get(BASE_KEY) || [];
const bAvg = {}, bWin = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null);
  bAvg[n] = avg(v); bWin[n] = v.filter(x => x > 0).length / v.length * 100;
}
console.log(`   掃 ${nDay} 個交易日 ・${nPick.toLocaleString()} 個 pick ・對照組 ${base.length.toLocaleString()}`);
{ const c = buckets.get('🎣 拋竿(完整漏斗)') || [];
  const u = new Set(); for (const [k] of lastSeen) if (k.startsWith('🎣 拋竿')) u.add(k.split('|')[1]);
  console.log(`   🎣 拋竿:去重後 ${c.length} 個事件 ・涵蓋 ${u.size} 檔不同的股票`
    + (c.length < 200 ? ' ⚠️ 樣本薄(一天最多 2 條 + 20 日去重,本來就會少)' : '')); }
console.log(`   🚨 對照組 = **${BASE_KEY}**(⛔ 只跟全市場比會把「選對板塊」的功勞算到拋竿頭上)`);
console.log(`   ⭐ 換對照組:BASE='對照組A 全市場' / BASE='對照組B 🧬全部(不看板塊)' node scripts/cast_probe.mjs`);
console.log(`   ⚠️ ⛔ 避雷那一關(噴≥30%又掛注意股)沒進回測(repo 沒有注意股歷史)→ 這是**保守下界**`);
console.log(`   對照組平均超額:` + HOR.map(n => `${n}日 ${bAvg[n].toFixed(2)}%`).join(' ・')
  + ` ・10日勝率 ${bWin[10].toFixed(1)}%\n`);

const allD = base.map(e => e._d).sort();
const MID = allD[Math.floor(allD.length / 2)];
// ⭐ 逐年清單從**實際樣本**推(⛔ 不可寫死 —— 補深之後 2021/2022 會整段不被檢查)
const YRS_SP = [...new Set(allD.map(d => d.slice(0, 4)))].sort();
const sub = (evs, f, n = 10) => evs.filter(f).map(e => e[n]).filter(x => x != null);
const bSub = (f, n = 10) => { const v = sub(base, f, n); return v.length ? avg(v) : null; };

const rows = [];
for (const [k, evs] of buckets) {
  // 🚨 ⛔ 樣本不足**不可靜默略過** —— 拋竿一天最多 2 條,去重後本來就會少;
  //    主角自己被門檻濾掉、表上直接消失,是這支探針最容易犯的錯(空過守門)。
  //    → 門檻降到 50,並在下面把 n < 200 的標出來「樣本薄」。
  if (k === BASE_KEY || evs.length < 50) continue;
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
  for (const y of YRS_SP) {
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
console.log('做法'.padEnd(32) + '    n   5日    10日   20日 |前半   後半      逐年     去最好年 扣成本');
console.log('─'.repeat(112));
for (const r of rows) {
  const same = r.h1 != null && r.h2 != null && Math.sign(r.h1) === Math.sign(r.h2);
  const net = (r.e10 ?? 0) - COST;
  const pass = net > 0 && same && r.ySame && (r.exBest ?? -9) > 0;
  console.log(pad(r.k, 32) + String(r.n).padStart(6) + ' '
    + [5, 10, 20].map(n => num(r[`e${n}`]).padStart(6)).join(' ') + ' |'
    + num(r.h1).padStart(6) + num(r.h2).padStart(7) + (same ? '✅' : '❌')
    + ' ' + YRS_SP.map(y => num(r.yr[y], 1).padStart(5)).join('') + (r.ySame ? '✅' : '❌')
    + num(r.exBest).padStart(8) + num(net).padStart(8) + (pass ? ' ⭐全過' : '') + (r.n < 200 ? ' ⚠️樣本薄' : ''));
}
console.log('\n(數字 = 相對「強勢板塊裡隨便挑一檔」的超額 pp ・進場=隔天開盤 ・扣同期加權)');
console.log(`(⭐ 扣成本 ${COST}% 後仍為正、且前後半同向+逐年同向+去最好年為正,才算過關)\n`);
