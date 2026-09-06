#!/usr/bin/env node
/**
 * 🧪 指標動物園:把「還沒測過、而且資料夠」的經典技術指標一次掃完(V74.5.8)
 *
 * 使用者給了一份完整的技術指標分類表。⭐ 先盤點:**一半以上本站已經有實測成績**
 * (`_SIGNAL_EDGE` 129 個 K 棒訊號 + `_SCR_EDGE` 96 個選股條件 + 28 種出場 + TD/WaveTrend)
 * → ⛔ 那些不重測。這支只掃**剩下的**,而且只收「純 OHLCV 算得出來」的。
 *
 * ⛔ 刻意不做(理由寫下來免得再問一次):
 *   ・ZigZag / 江恩 / 纏論 / 諧波型態 → 需要**未來資料確認轉折**或判定高度主觀 = 回測會有前視偏誤
 *   ・暗池 / VPIN / 另類數據 → 台股**沒有這些資料源**(逐筆委託簿與暗池不公開)
 *   ・KNN / SVM → `ml_probe.py` 已測(樣本外 AUC 0.522,輸給「位階≥75」一條 if)
 *   ・McClellan / 新高新低 → 那是**大盤層級**,測法不同(同 floorcount_probe),不混進個股事件表
 *
 * ⭐ 六道關卡 ・對照組 = 同一批(股·日)全部 ・扣同期加權 ・10 日去重 ・進場=隔天開盤(排除鎖死)
 * ⚠️ 逐年/中點一律從實際樣本推(⛔ 不寫死)
 */
import fs from 'fs';
import path from 'path';
import { signalsFor } from './lib_indicators.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const HOR = [1, 3, 5, 10, 20];
const COST = 0.44, DEDUP = 10;
const ONLY_GENE = process.env.GENE === '1';

const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) { const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); mdays.push(d); } }
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => { const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]); return a > 0 ? (b / a - 1) * 100 : null; };

const buckets = new Map();
const add = (k, ev) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ev); };

// ⭐ 指標公式全部住在 `scripts/lib_indicators.mjs`(逐檔探針也吃同一份)。
// ⛔ 不可在這裡再寫一份公式（陷阱 #37）。

const files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
let nSym = 0, nBar = 0;
for (const f of files) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 320) continue;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
    o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 })).filter(r => r.d);
  if (R.length < 320) continue;
  nSym++; nBar += R.length;
  const N = R.length;
  const { hits, gene } = signalsFor(R);

  // ── 發射 ──
  const last = new Map();
  const emit = (key, i, g) => {
    if (ONLY_GENE && !g) return;
    const p = last.get(key); if (p != null && i - p < DEDUP) return;
    const e = i + 1; if (e >= N) return;
    const gap = (R[e].o / R[i].c - 1) * 100;
    if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) return;
    const ret2 = {};
    for (const n of HOR) { const j = e + n; if (j >= N) { ret2[n] = null; continue; }
      const m = mktRet(R[e].d, n); ret2[n] = m == null ? null : (R[j].c / R[e].o - 1) * 100 - m; }
    last.set(key, i); ret2._d = R[e].d; add(key, ret2);
  };
  for (const [key, idxs] of hits) for (const i of idxs) emit(key, i, gene[i]);
}


// ── 統計(同 streak_probe 的六道關卡)──
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const base = buckets.get('對照組(所有交易日)') || [];
const baseAvg = {}, baseWin = {};
for (const n of HOR) { const v = base.map(e => e[n]).filter(x => x != null);
  baseAvg[n] = avg(v); baseWin[n] = v.filter(x => x > 0).length / v.length * 100; }
console.log(`\n📊 樣本:${nSym} 檔 ・${nBar.toLocaleString()} 根 K ・對照組 ${base.length.toLocaleString()} 個事件${ONLY_GENE ? '  【🧬 增量檢定模式】' : ''}`);
console.log('   對照組平均超額:' + HOR.map(n => `${n}日 ${baseAvg[n].toFixed(2)}%`).join(' ・'));
console.log('   對照組勝率:' + HOR.map(n => `${n}日 ${baseWin[n].toFixed(1)}%`).join(' ・'));
console.log('   ⚠️ 基準本來就是負的 —— ⛔ 不是 0 也不是 50%\n');

const MIN_N = ONLY_GENE ? 120 : 300;
const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組') || evs.length < MIN_N) continue;
  const r = { k, n: evs.length };
  for (const n of HOR) { const v = evs.map(e => e[n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - baseAvg[n] : null;
    r[`w${n}`] = v.length ? v.filter(x => x > 0).length / v.length * 100 : null;
    r[`m${n}`] = v.length ? med(v) : null; }
  rows.push(r);
}
rows.sort((a, b) => (b.e10 ?? -99) - (a.e10 ?? -99));
const pad = (s, w) => String(s).padEnd(w, ' ');
const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
console.log('事件'.padEnd(40) + ' n'.padStart(8) + '  1日     3日     5日    10日    20日  |10日勝率');
console.log('─'.repeat(100));
for (const r of rows) console.log(pad(r.k, 40) + String(r.n).padStart(8) + '  '
  + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + '  |' + (r.w10 == null ? '—' : r.w10.toFixed(1) + '%').padStart(7));

const allD = base.map(e => e._d).filter(Boolean).sort();
const MID = allD[Math.floor(allD.length / 2)];
const YRS = [...new Set(allD.map(d => d.slice(0, 4)))].sort();
const sub = (evs, f) => evs.filter(f).map(e => e[10]).filter(x => x != null);
const baseSub = f => { const v = sub(base, f); return v.length ? avg(v) : null; };
const MINSUB = ONLY_GENE ? 30 : 60;
console.log('\n\n████ 🚧 穩健性檢定(10 日;⭐ 要 > 成本 0.44pp)████');
console.log(`   期間 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID} ・逐年 ${YRS.join('/')}`);
console.log('\n事件'.padEnd(41) + '全期    前半    後半   |逐年(' + YRS.map(y => y.slice(2)).join('/') + ')   去最好年  扣成本');
console.log('─'.repeat(112));
const passed = [];
for (const r of rows) {
  const evs = buckets.get(r.k);
  const h1 = sub(evs, e => e._d < MID), h2 = sub(evs, e => e._d >= MID);
  const b1 = baseSub(e => e._d < MID), b2 = baseSub(e => e._d >= MID);
  const e1 = h1.length >= MINSUB ? avg(h1) - b1 : null, e2 = h2.length >= MINSUB ? avg(h2) - b2 : null;
  const yr = {};
  for (const y of YRS) { const v = sub(evs, e => e._d.startsWith(y)), bv = baseSub(e => e._d.startsWith(y));
    yr[y] = v.length >= MINSUB && bv != null ? avg(v) - bv : null; }
  const ys = Object.values(yr).filter(x => x != null);
  let exBest = null;
  if (ys.length >= 2) { const bestY = Object.entries(yr).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0][0];
    const v = sub(evs, e => !e._d.startsWith(bestY)), bv = baseSub(e => !e._d.startsWith(bestY));
    exBest = v.length >= MINSUB && bv != null ? avg(v) - bv : null; }
  const same = e1 != null && e2 != null && Math.sign(e1) === Math.sign(e2);
  const ySame = ys.length >= 2 && ys.every(x => Math.sign(x) === Math.sign(ys[0]));
  const net = (r.e10 ?? 0) - COST;
  const all = net > 0 && same && ySame && (exBest ?? -9) > 0;
  if (all) passed.push(`${r.k}(扣成本 ${num(net)})`);
  console.log(pad(r.k, 41) + num(r.e10).padStart(6) + num(e1).padStart(8) + num(e2).padStart(8) + (same ? ' ✅' : ' ❌')
    + ' |' + YRS.map(y => num(yr[y], 1).padStart(6)).join('') + (ySame ? ' ✅' : ' ❌')
    + num(exBest).padStart(9) + num(net).padStart(8) + (all ? ' ⭐全過' : ''));
}
console.log(`\n⭐ 六關全過:${passed.length ? passed.join(' / ') : '(一個都沒有)'}`);
console.log('(數字 = 相對「隨便挑一天」的超額 pp;進場 = 隔天開盤,已排除開盤鎖死)\n');
