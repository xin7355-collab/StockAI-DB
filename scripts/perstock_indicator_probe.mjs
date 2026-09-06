#!/usr/bin/env node
/**
 * 🧬 逐檔「這一檔最適合哪個指標」實測(V74.5.9)
 *
 * 使用者問:「每個個股不是有有用最適合打法,以這個邏輯你有試過嗎?」
 * ⭐ App 的 `playbook_edge` 就是這個邏輯(這一檔自己歷史上最會賺的那一招),
 *   但它用的是 22 種 K 棒打法;⛔ 從來沒有拿 48 個技術指標試過。這支就是補這一塊。
 *
 * 做法(每一條都是本專案踩過坑之後定下來的規矩):
 *  ① 前半段學「這一檔哪個指標最好」→ 後半段驗收;⭐ 再反過來做一次(V74.0.5:訓練段前段班是幻覺)
 *  ② 排序用**保守下界** mean − 1.28×sd/√n,⛔ 不排點估計值(V72.9.2:排平均必定挑到僥倖股)
 *  ③ 🚨 **先報「學到的東西穩不穩」(兩段挑到同一個指標的比例),再談報酬**
 *     ——(評估紀錄⑮ 同盟集團:六關全過但名單重疊率 0% → 當場結案)
 *  ④ 對照組三個,而且**共用同一批股票、同一段時間**:
 *     ・隨便挑一個指標(該檔所有指標的平均)← 這才是「挑得準不準」的對照
 *     ・全市場最好的那一個指標(訓練段選出來,套到每一檔)
 *     ・對照組(所有交易日)
 *  ⑤ 指標公式吃 `lib_indicators.mjs`,⛔ 不在這裡寫第二份(陷阱 #37)
 *
 * 進場 = 隔天開盤(已排除開盤仍鎖住);報酬扣同期加權;同檔同指標 10 日去重。
 * 只讀 data/,不打 API、不寫檔。
 */
import fs from 'fs';
import path from 'path';
import { signalsFor } from './lib_indicators.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const HOR = 10;                 // 主天期
const COST = 0.44, DEDUP = 10;
const MIN_TRAIN = 5;            // 訓練段每個指標至少要有幾次才准被挑
const MIN_TEST = 3;             // 驗收段至少要有幾次才計入
const CTRL = '對照組(所有交易日)';
const LIMIT = +(process.env.LIMIT || 0);

const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) { const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); mdays.push(d); } }
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => { const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  return (mkt.get(mdays[i + n]) / mkt.get(mdays[i]) - 1) * 100; };

let files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
if (LIMIT) files = files.slice(0, LIMIT);

const readOne = f => {
  let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return null; }
  if (!Array.isArray(rows) || rows.length < 320) return null;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
    o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 })).filter(r => r.d);
  return R.length < 320 ? null : R;
};

// ═══ 前置:中點日期一律從**實際樣本**推,⛔ 不寫死 ═══
// (V74.0.2 limitup / V74.2.8 streak 都栽在「窗口寫死 → 那一關等於不存在」)
console.log('🔎 前置:掃描樣本日期分布…');
const dayCnt = new Map();
let nSymPre = 0;
for (const f of files) {
  const R = readOne(f); if (!R) continue;
  nSymPre++;
  for (let i = 300; i < R.length - 1; i++) dayCnt.set(R[i + 1].d, (dayCnt.get(R[i + 1].d) || 0) + 1);
}
const allDays = [...dayCnt.keys()].sort();
let tot = 0; for (const d of allDays) tot += dayCnt.get(d);
let acc = 0, MID = allDays[0];
for (const d of allDays) { acc += dayCnt.get(d); if (acc >= tot / 2) { MID = d; break; } }
console.log(`   ${nSymPre} 檔 ・${allDays[0]} ~ ${allDays[allDays.length - 1]} ・樣本中點 ${MID}\n`);

// ═══ 主掃描:每檔累計 (指標 × 前/後半) 的 n / Σr / Σr² ═══
// ⭐ 只存統計量不存事件 —— 2,500 檔 × 130 指標的事件全存會吃掉幾百 MB(記憶體極限防禦)
const symStat = new Map();      // sym → Map(key → [n1,s1,q1,n2,s2,q2])
const gKeys = new Set();
let nSym = 0, nEv = 0;
for (const f of files) {
  const R = readOne(f); if (!R) continue;
  const sym = f.replace('.json', '');
  const N = R.length;
  const { hits } = signalsFor(R);
  const st = new Map();
  for (const [key, idxs] of hits) {
    gKeys.add(key);
    let last = -1e9;
    for (const i of idxs) {
      if (i - last < DEDUP) continue;
      const e = i + 1; if (e >= N) continue;
      const gap = (R[e].o / R[i].c - 1) * 100;
      if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) continue;   // 開盤仍鎖住 = 買不到
      const j = e + HOR; if (j >= N) continue;
      const m = mktRet(R[e].d, HOR); if (m == null) continue;
      const r = (R[j].c / R[e].o - 1) * 100 - m;
      last = i;
      let a = st.get(key); if (!a) { a = [0, 0, 0, 0, 0, 0]; st.set(key, a); }
      const off = R[e].d < MID ? 0 : 3;
      a[off]++; a[off + 1] += r; a[off + 2] += r * r;
      nEv++;
    }
  }
  if (st.size) { symStat.set(sym, st); nSym++; }
  if (nSym % 400 === 0) process.stdout.write(`\r   掃描中… ${nSym} 檔 / ${nEv} 事件`);
}
console.log(`\r✅ 掃描完成:${nSym} 檔 ・${nEv} 個事件 ・${gKeys.size} 個指標          \n`);

const mean = a => a[0] ? a[1] / a[0] : null;
const lb = a => { const n = a[0]; if (n < 2) return null; const m = a[1] / n;
  const v = Math.max(0, a[2] / n - m * m), sd = Math.sqrt(v * n / (n - 1));
  return m - 1.28 * sd / Math.sqrt(n); };
const H1 = a => [a[0], a[1], a[2]], H2 = a => [a[3], a[4], a[5]];

// 每檔在某一半段挑出的「最適合的指標」(用保守下界排,⛔ 不用平均)
const pickBest = (half) => {
  const out = new Map();
  for (const [sym, st] of symStat) {
    let bk = null, bv = -Infinity;
    for (const [k, a] of st) {
      if (k === CTRL) continue;
      const h = half(a); if (h[0] < MIN_TRAIN) continue;
      const v = lb(h); if (v != null && v > bv) { bv = v; bk = k; }
    }
    if (bk) out.set(sym, bk);
  }
  return out;
};
const best1 = pickBest(H1), best2 = pickBest(H2);

// ═══ ① 先報「學到的東西穩不穩」 ═══
console.log('═'.repeat(74));
console.log('🧲 ① 名單穩定度 —— 前半段挑到的指標,後半段還是同一個嗎?');
console.log('   (⭐ 評估紀錄⑮ 的教訓:報酬會騙人,「學到的是不是同一批」不會)');
const both = [...best1.keys()].filter(s => best2.has(s));
let same = 0, inTop3 = 0;
const top3of = (sym, half) => {
  const st = symStat.get(sym), arr = [];
  for (const [k, a] of st) { if (k === CTRL) continue; const h = half(a); if (h[0] < MIN_TRAIN) continue;
    const v = lb(h); if (v != null) arr.push([k, v]); }
  arr.sort((x, y) => y[1] - x[1]); return arr.slice(0, 3).map(x => x[0]);
};
for (const s of both) { if (best1.get(s) === best2.get(s)) same++; if (top3of(s, H2).includes(best1.get(s))) inTop3++; }
let kSum = 0; for (const s of both) { let c = 0; for (const [k, a] of symStat.get(s)) if (k !== CTRL && H2(a)[0] >= MIN_TRAIN) c++; kSum += c; }
const kAvg = both.length ? kSum / both.length : 0;
console.log(`   兩段都挑得出來的股票:${both.length} 檔 ・平均每檔有 ${kAvg.toFixed(0)} 個指標可挑`);
console.log(`   ⭐ 兩段挑到**同一個**指標:${same} 檔 = ${(same / both.length * 100).toFixed(1)}%   (隨機期望 ${(100 / kAvg).toFixed(1)}%)`);
console.log(`   ⭐ 前半第一名落在後半前三名:${inTop3} 檔 = ${(inTop3 / both.length * 100).toFixed(1)}%   (隨機期望 ${(300 / kAvg).toFixed(1)}%)\n`);

// ═══ ② 報酬:挑法 vs 三個對照組(共用同一批股票、同一段時間) ═══
const agg = (rows) => { let n = 0, s = 0; for (const [nn, ss] of rows) { n += nn; s += ss; } return { n, m: n ? s / n : null }; };

const runDir = (label, learn, verify, bestMap) => {
  const symsHere = [...bestMap.keys()].filter(s => symStat.has(s));
  // (a) 挑法:只做那一檔被挑中的指標
  const A = [], B = [], C = [], D = [];
  let globalBestK = null, gbv = -Infinity;
  const gAcc = new Map();
  for (const s of symsHere) for (const [k, a] of symStat.get(s)) {
    if (k === CTRL) continue; const h = learn(a); if (!h[0]) continue;
    let g = gAcc.get(k); if (!g) { g = [0, 0, 0]; gAcc.set(k, g); }
    g[0] += h[0]; g[1] += h[1]; g[2] += h[2];
  }
  for (const [k, g] of gAcc) { if (g[0] < 300) continue; const v = lb(g); if (v != null && v > gbv) { gbv = v; globalBestK = k; } }

  for (const s of symsHere) {
    const st = symStat.get(s);
    const pk = bestMap.get(s), a = st.get(pk);
    if (a) { const h = verify(a); if (h[0] >= MIN_TEST) A.push([h[0], h[1]]); }
    // (b) 隨便挑一個指標 = 該檔所有指標「每個指標的平均」再取平均(⭐ 均勻挑一個的期望)
    let ks = 0, kn = 0;
    for (const [k, aa] of st) { if (k === CTRL) continue; const h = verify(aa); if (h[0] < MIN_TEST) continue; ks += h[1] / h[0]; kn++; }
    if (kn) B.push([1, ks / kn]);
    // (c) 全市場最好的那一個指標
    if (globalBestK) { const g = st.get(globalBestK); if (g) { const h = verify(g); if (h[0] >= MIN_TEST) C.push([h[0], h[1]]); } }
    // (d) 對照組(所有交易日)
    const cc = st.get(CTRL); if (cc) { const h = verify(cc); if (h[0]) D.push([h[0], h[1]]); }
  }
  const a = agg(A), b = agg(B), c = agg(C), d = agg(D);
  console.log(`【${label}】驗收段共 ${symsHere.length} 檔`);
  console.log(`   🎯 挑法(這一檔自己最好的指標)      ${a.m == null ? ' —' : (a.m >= 0 ? '+' : '') + a.m.toFixed(2)}%   n=${a.n}`);
  console.log(`   🎲 對照:隨便挑一個指標              ${b.m == null ? ' —' : (b.m >= 0 ? '+' : '') + b.m.toFixed(2)}%   ${b.n} 檔`);
  console.log(`   🌍 對照:全市場最好的指標            ${c.m == null ? ' —' : (c.m >= 0 ? '+' : '') + c.m.toFixed(2)}%   n=${c.n}   (${globalBestK || '—'})`);
  console.log(`   ➖ 對照:所有交易日(隨便挑一天)     ${d.m == null ? ' —' : (d.m >= 0 ? '+' : '') + d.m.toFixed(2)}%   n=${d.n}`);
  if (a.m != null && b.m != null) {
    const e1 = a.m - b.m, e2 = c.m == null ? null : a.m - c.m, e3 = d.m == null ? null : a.m - d.m;
    console.log(`   ⭐ 挑法 − 隨便挑指標 = ${(e1 >= 0 ? '+' : '') + e1.toFixed(2)}pp` +
      (e2 == null ? '' : ` ・挑法 − 全市場最好 = ${(e2 >= 0 ? '+' : '') + e2.toFixed(2)}pp`) +
      (e3 == null ? '' : ` ・挑法 − 隨便挑一天 = ${(e3 >= 0 ? '+' : '') + e3.toFixed(2)}pp`));
    console.log(`   💸 扣來回成本 ${COST}% 後,挑法本身 = ${(a.m - COST >= 0 ? '+' : '') + (a.m - COST).toFixed(2)}%`);
  }
  console.log('');
};
console.log('═'.repeat(74));
console.log(`📊 ② 報酬(${HOR} 日超額,已扣同期加權;⛔ 三個對照組共用同一批股票)\n`);
runDir(`正向:${allDays[0]}~${MID} 學 → ${MID} 之後驗收`, H1, H2, best1);
runDir(`反向:${MID} 之後學 → ${allDays[0]}~${MID} 驗收`, H2, H1, best2);
console.log('═'.repeat(74));
console.log('⚠️ 限制:窗口偏多頭;只用 K 線類指標(⛔ 沒有籌碼/基本面);');
console.log('   ⛔ 這裡量的是「挑指標」,跟 App 現行的「挑 K 棒打法」是不同的母體,不可互推。');
