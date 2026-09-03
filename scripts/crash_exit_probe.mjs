#!/usr/bin/env node
/**
 * 🩸 「台股大跌時,出場規則該不該暫時放寬?」實測(V74.6.2)
 *
 * 使用者:「最近台股很常一天大跌、一天就回來,這樣會不會容易錯殺?出場是不是應該暫時放寬?」
 *
 * 🚨 **先驗前提**(⛔ 不憑印象):
 *   ・大盤單日跌 ≥2%(53 次 / 4.4% 的日子):隔天平均 +0.21%、上漲 60%(基準 55%)
 *     ⛔ 但「隔天就全部收回」**只有 8%**;跌 ≥3% 那組隔天平均是 **−0.07%**(完全沒有反彈優勢)
 *   ・個股跌破 5 日線 30 萬次:隔天就站回 **26.8%**、5 天內 78%
 *   🚨 **那一天大盤也跌 ≥2% 時,隔天站回只有 21.3% —— 比大盤沒跌那天的 28.5% 還低**
 *     → 大跌日的跌破**更不容易馬上站回**,⛔ 放寬的直覺方向可能是反的。
 *   → 所以這支不是「驗證放寬有用」,是**認真測它到底有沒有用**。
 *
 * 做法(跟 `perstock_exit_probe.mjs` 同一套,控制變因):
 *   固定同一批進場點(`lib_indicators.signalsFor()` 的全部事件)、只換出場;
 *   報酬扣同期加權 + 來回成本 0.44%;同檔 10 日去重;最長 20 個交易日。
 *   ⭐ 放寬的條件一律用**當天收盤就已知**的資訊(大盤今天跌幾%、個股今天跌幾%、今天的量)→ 零前視。
 *
 * 情境(⭐ 後五個是使用者沒問、但同一份資料順便測得動的):
 *   base      現行:跌破 5 日線就走
 *   pause2/3  大盤當天跌 ≥2%/3% → **那天不出場**(延到下一天)
 *   self5     個股自己當天跌 ≥5% → 那天不出場
 *   idio      ⭐ 個股大跌**但大盤沒跌**(它自己出事)→ 那天不出場
 *   sys       ⭐ 反過來:**只有大盤帶著跌**的那天不出場
 *   volup     ⭐ 爆量跌破(量 ≥1.5 倍)不放寬;**量縮**跌破(<0.8 倍)才放寬
 *   deep      ⭐ 只是「剛好跌破」(距 5 日線 <1%)才放寬,跌很深就照走
 *   wide      對照組:全程改用更寬的 ATR K=3(⛔ 不分大跌不大跌)
 */
import fs from 'fs';
import path from 'path';
import { signalsFor } from './lib_indicators.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const COST = 0.44, MAXD = 20, HOLD_STOP = 5;
const LIMIT = +(process.env.LIMIT || 0);

const SPECS = [
  ['base',   '現行:跌破 5 日線就走'],
  ['pause2', '大盤跌 ≥2% 那天不出場'],
  ['pause3', '大盤跌 ≥3% 那天不出場'],
  ['self5',  '個股自己跌 ≥5% 那天不出場'],
  ['idio',   '個股大跌但大盤沒跌 → 不出場'],
  ['sys',    '大盤帶著跌那天 → 不出場'],
  ['volup',  '量縮跌破才放寬(爆量照走)'],
  ['deep',   '只是剛好跌破才放寬(跌深照走)'],
  ['wide',   '(對照)全程改用 ATR K=3'],
  // ⭐⭐ 反方向:使用者問的是「該不該放寬」,但從事實看(大跌日跌破後隔天站回只有 21.3%、
  //    繼續抱之後 5 日 −0.90% 是全部分桶最差)→ **收緊**才可能是對的方向,所以一起測。
  ['tight3', '大跌日改看 3 日線(更早走)'],
  ['tightM2', '大盤跌 ≥2% 那天直接出場'],
  ['tightM3', '大盤跌 ≥3% 那天直接出場'],
];

// ═══ 大盤 ═══
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) { const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); mdays.push(d); } }
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mChg = new Map();                                   // 大盤當天漲跌%
for (let i = 1; i < mdays.length; i++) mChg.set(mdays[i], (mkt.get(mdays[i]) / mkt.get(mdays[i - 1]) - 1) * 100);
const mktBetween = (d0, d1) => { const a = mIdx.get(d0), b = mIdx.get(d1);
  if (a == null || b == null || b <= a) return null; return (mkt.get(mdays[b]) / mkt.get(mdays[a]) - 1) * 100; };

// ═══ 📊 事實段(`--facts`)—— ⭐ 先驗前提,再談策略 ═══
//   使用者的印象是「一天大跌、一天就回來」→ ⛔ 不可直接拿來當設計依據,要先量。
function facts() {
  const R = mdays.map((d, i) => ({ d, c: mkt.get(d) }));
  const g = R.map((r, i) => i ? (r.c / R[i - 1].c - 1) * 100 : 0);
  const allNx = []; for (let i = 1; i < R.length - 1; i++) allNx.push(g[i + 1]);
  const baseUp = allNx.filter(x => x > 0).length / allNx.length * 100;
  console.log(`📊 加權指數 ${R[0].d} ~ ${R[R.length - 1].d} ・${R.length} 個交易日`);
  console.log(`🎯 基準(隨便挑一天):隔天上漲 ${baseUp.toFixed(0)}%\n`);
  for (const TH of [1.5, 2, 3]) {
    const ev = []; for (let i = 1; i < R.length - 1; i++) if (g[i] <= -TH) ev.push(i);
    if (!ev.length) continue;
    const nx = ev.map(i => g[i + 1]);
    const up = nx.filter(x => x > 0).length / ev.length * 100;
    const half = ev.filter(i => g[i + 1] >= -g[i] * 0.5).length / ev.length * 100;
    const full = ev.filter(i => g[i + 1] >= -g[i]).length / ev.length * 100;
    console.log(`🔻 大盤單日跌 ≥${TH}%:${ev.length} 次(占 ${(ev.length / R.length * 100).toFixed(1)}%)`);
    console.log(`   隔天平均 ${(nx.reduce((a, b) => a + b, 0) / nx.length).toFixed(2)}% ・上漲 ${up.toFixed(0)}%(基準 ${baseUp.toFixed(0)}%)`);
    console.log(`   🚨 隔天收回一半以上 ${half.toFixed(0)}% ・**隔天就全部收回 ${full.toFixed(0)}%**`);
    const yr = {}; for (const i of ev) { const y = R[i].d.slice(0, 4); (yr[y] = yr[y] || []).push(g[i + 1]); }
    console.log('   逐年:' + Object.keys(yr).sort().map(y => `${y} ${yr[y].length}次/隔天均${(yr[y].reduce((a, b) => a + b, 0) / yr[y].length).toFixed(2)}%`).join(' ・') + '\n');
  }
  // 個股層級:跌破 5 日線之後多久站回 + 「不出場的話」之後怎樣
  let files2 = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
  if (LIMIT) files2 = files2.slice(0, LIMIT);
  const mChgL = mChg;
  let tot = 0, b1 = 0, b3 = 0, b5 = 0, crashT = 0, crashB = 0, calmT = 0, calmB = 0, nS = 0;
  const B = [['大盤漲', x => x > 0], ['大盤 0~−1%', x => x <= 0 && x > -1], ['大盤 −1~−2%', x => x <= -1 && x > -2], ['大盤 跌≥2%', x => x <= -2]];
  const acc2 = B.map(() => ({ n: 0, s5: 0, s10: 0, w5: 0 }));
  for (const f of files2) {
    const D = readOne(f); if (!D) continue; nS++;
    const ma5 = D.map((_, i) => i < 4 ? null : (D[i].c + D[i - 1].c + D[i - 2].c + D[i - 3].c + D[i - 4].c) / 5);
    let last = -1e9;
    for (let i = 250; i < D.length - 11; i++) {
      if (ma5[i] == null || ma5[i - 1] == null) continue;
      if (!(D[i - 1].c >= ma5[i - 1] && D[i].c < ma5[i])) continue;
      tot++;
      let b = 0;
      for (let j = i + 1; j <= Math.min(i + 5, D.length - 1); j++) if (ma5[j] != null && D[j].c >= ma5[j]) { b = j - i; break; }
      if (b === 1) b1++; if (b > 0 && b <= 3) b3++; if (b > 0 && b <= 5) b5++;
      const mc = mChgL.has(D[i].d) ? mChgL.get(D[i].d) : null;
      if (mc != null) { if (mc <= -2) { crashT++; if (b === 1) crashB++; } else if (mc > -0.5) { calmT++; if (b === 1) calmB++; } }
      if (i - last < 10 || mc == null) continue; last = i;
      const m5 = mktBetween(D[i].d, D[i + 5].d), m10 = mktBetween(D[i].d, D[i + 10].d);
      if (m5 == null || m10 == null) continue;
      const r5 = (D[i + 5].c / D[i].c - 1) * 100 - m5, r10 = (D[i + 10].c / D[i].c - 1) * 100 - m10;
      for (let k = 0; k < B.length; k++) if (B[k][1](mc)) { const a = acc2[k]; a.n++; a.s5 += r5; a.s10 += r10; if (r5 > 0) a.w5++; break; }
    }
  }
  console.log(`📉 個股「跌破 5 日線」事件:${nS} 檔 ・${tot.toLocaleString()} 次`);
  console.log(`   隔天就站回 ${(b1 / tot * 100).toFixed(1)}% ・3 天內 ${(b3 / tot * 100).toFixed(1)}% ・5 天內 ${(b5 / tot * 100).toFixed(1)}%`);
  console.log(`   🚨 那天大盤也跌 ≥2% → 隔天站回只有 ${(crashB / crashT * 100).toFixed(1)}%(n=${crashT.toLocaleString()})`);
  console.log(`   ☀️ 那天大盤沒跌   → 隔天站回 ${(calmB / calmT * 100).toFixed(1)}%(n=${calmT.toLocaleString()})`);
  console.log(`   ⭐ 大跌日的跌破**更不容易馬上站回** —— 「放寬」的直覺方向是反的\n`);
  console.log('🔬 跌破之後如果**繼續抱**(超額報酬,已扣同期大盤):');
  console.log('   那天的大盤'.padEnd(16) + 'n'.padStart(10) + '  之後5日'.padStart(9) + '  之後10日'.padStart(10) + '  5日上漲'.padStart(9));
  for (let k = 0; k < B.length; k++) { const a = acc2[k]; if (!a.n) continue;
    console.log('   ' + B[k][0].padEnd(14) + a.n.toLocaleString().padStart(10)
      + `${a.s5 / a.n >= 0 ? '+' : ''}${(a.s5 / a.n).toFixed(2)}%`.padStart(9)
      + `${a.s10 / a.n >= 0 ? '+' : ''}${(a.s10 / a.n).toFixed(2)}%`.padStart(10)
      + `${(a.w5 / a.n * 100).toFixed(1)}%`.padStart(9)); }
  console.log('   ⭐ 大盤跌 ≥2% 那天跌破 → 繼續抱是**全部分桶裡最虧的**,⛔ 不是最容易反彈的\n');
}

// ═══ 出場模擬 ═══
function simExit(R, eIdx, spec) {
  const n = R.length, entry = R[eIdx].c;
  if (!(entry > 0)) return null;
  const stop0 = Math.min(R[eIdx].l, entry * (1 - HOLD_STOP / 100));
  const endJ = Math.min(n - 1, eIdx + MAXD);
  const atrAt = j => { let s = 0, m = 0;
    for (let q = Math.max(1, j - 13); q <= j; q++) { const pc = R[q - 1].c; if (!(pc > 0)) continue;
      s += Math.max(R[q].h - R[q].l, Math.abs(R[q].h - pc), Math.abs(R[q].l - pc)); m++; }
    return m ? s / m : 0; };
  let peak = entry, exitP = null, exitIdx = endJ;
  for (let j = eIdx + 1; j <= endJ; j++) {
    const c = R[j].c;
    if (c > peak) peak = c;
    if (c <= stop0) { exitP = stop0; exitIdx = j; break; }      // 🚧 停損一律照走(⛔ 放寬不可動停損)
    if (spec === 'wide') {
      const at = atrAt(j);
      if (at > 0 && c <= peak - 3 * at) { exitP = c; exitIdx = j; break; }
      if (j === endJ) { exitP = c; exitIdx = j; }
      continue;
    }
    const mcNow = mChg.has(R[j].d) ? mChg.get(R[j].d) : 0;
    // ── 收緊:大盤大跌那天直接出場(⛔ 不看有沒有跌破)──
    if (spec === 'tightM2' && mcNow <= -2) { exitP = c; exitIdx = j; break; }
    if (spec === 'tightM3' && mcNow <= -3) { exitP = c; exitIdx = j; break; }
    if (j < 4) { if (j === endJ) { exitP = c; exitIdx = j; } continue; }
    let s = 0; for (let q = j - 4; q <= j; q++) s += R[q].c;
    let ma5 = s / 5;
    // ── 收緊:大跌日改用 3 日線(更敏感 → 更早走)──
    if (spec === 'tight3' && mcNow <= -2) { let s3 = 0; for (let q = j - 2; q <= j; q++) s3 += R[q].c; ma5 = s3 / 3; }
    if (c < ma5) {
      // ── 這一天「本來要出場」→ 看放寬條件成不成立(全部用當天收盤已知的資訊)──
      const mc = mChg.has(R[j].d) ? mChg.get(R[j].d) : 0;                 // 大盤今天漲跌%
      const sc = R[j - 1].c > 0 ? (c / R[j - 1].c - 1) * 100 : 0;         // 個股今天漲跌%
      let v20 = 0, vn = 0;
      for (let q = Math.max(0, j - 19); q <= j; q++) { v20 += R[q].v; vn++; }
      const vr = (vn && v20 > 0) ? R[j].v / (v20 / vn) : 1;
      const depth = (ma5 - c) / ma5 * 100;                                // 跌破多深(%)
      let skip = false;
      if (spec === 'pause2') skip = mc <= -2;
      else if (spec === 'pause3') skip = mc <= -3;
      else if (spec === 'self5') skip = sc <= -5;
      else if (spec === 'idio') skip = sc <= -5 && mc > -1;               // 它自己出事
      else if (spec === 'sys')  skip = mc <= -2 && sc > mc - 2;           // 大盤帶著跌、它沒特別弱
      else if (spec === 'volup') skip = vr < 0.8;                         // 量縮才放寬
      else if (spec === 'deep')  skip = depth < 1;                        // 只是剛好跌破
      if (!skip) { exitP = c; exitIdx = j; break; }
    }
    if (j === endJ) { exitP = c; exitIdx = j; }
  }
  if (exitP == null) { exitP = R[endJ].c; exitIdx = endJ; }
  return { ret: (exitP - entry) / entry * 100, outIdx: exitIdx };
}

// ═══ 掃描 ═══
let files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
if (LIMIT) files = files.slice(0, LIMIT);
const readOne = f => {
  let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return null; }
  if (!Array.isArray(rows) || rows.length < 340) return null;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
    o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 })).filter(r => r.d);
  return R.length < 340 ? null : R;
};
// ⚠️ `--facts` 的觸發要放在 `readOne` **定義之後** —— const 有暫時性死區,
//    放前面會 ReferenceError(實跑抓到的)。
if (process.argv.includes('--facts')) { facts(); process.exit(0); }
console.log('🔎 掃描中(固定同一批進場點,只換出場規則)…');
const acc = new Map(SPECS.map(([k]) => [k, []]));          // spec → [超額報酬…]
const byYear = new Map();                                   // spec → {year: [ret]}
let nSym = 0, nEv = 0, held = new Map(SPECS.map(([k]) => [k, 0]));
for (const f of files) {
  const R = readOne(f); if (!R) continue;
  const { hits } = signalsFor(R);
  const seen = new Set();
  for (const [, idxs] of hits) for (const i of idxs) seen.add(i);
  const idxs = [...seen].sort((a, b) => a - b);
  let last = -1e9;
  for (const i of idxs) {
    if (i - last < 10) continue;
    if (i + MAXD >= R.length) continue;
    const rec = {};
    let okAll = true;
    for (const [k] of SPECS) {
      const r = simExit(R, i, k); if (!r) { okAll = false; break; }
      const m = mktBetween(R[i].d, R[r.outIdx].d);
      if (m == null) { okAll = false; break; }
      rec[k] = { v: r.ret - m - COST, days: r.outIdx - i };
    }
    if (!okAll) continue;
    last = i; nEv++;
    const y = R[i].d.slice(0, 4);
    for (const [k] of SPECS) {
      acc.get(k).push(rec[k].v);
      held.set(k, held.get(k) + rec[k].days);
      if (!byYear.has(k)) byYear.set(k, {});
      (byYear.get(k)[y] = byYear.get(k)[y] || []).push(rec[k].v);
    }
  }
  nSym++;
  if (nSym % 400 === 0) process.stdout.write(`\r   ${nSym} 檔 / ${nEv} 個進場點`);
}
console.log(`\r✅ ${nSym} 檔 ・${nEv.toLocaleString()} 個進場點          \n`);

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)]; };
const base = acc.get('base'), baseAvg = avg(base);
const yrs = [...new Set(Object.keys(byYear.get('base')))].sort();
console.log('═'.repeat(96));
console.log('規則'.padEnd(30) + '每趟'.padStart(8) + ' vs現行'.padStart(9) + '  最差10%'.padStart(9)
          + '  勝率'.padStart(7) + '  平均抱'.padStart(8) + '  |逐年 vs 現行(' + yrs.map(y => y.slice(2)).join('/') + ')');
console.log('─'.repeat(96));
for (const [k, lbl] of SPECS) {
  const a = acc.get(k), m = avg(a);
  const yr = yrs.map(y => { const v = byYear.get(k)[y] || [], b = byYear.get('base')[y] || [];
    return (v.length && b.length) ? (avg(v) - avg(b)) : null; });
  const same = k === 'base' ? '' : (yr.every(x => x != null && x > 0) ? ' ✅' : ' ❌');
  console.log(lbl.padEnd(30)
    + `${m >= 0 ? '+' : ''}${m.toFixed(2)}%`.padStart(8)
    + (k === 'base' ? '   —' : `${m - baseAvg >= 0 ? '+' : ''}${(m - baseAvg).toFixed(2)}pp`).padStart(9)
    + `${pct(a, 0.10).toFixed(1)}%`.padStart(9)
    + `${(a.filter(x => x > 0).length / a.length * 100).toFixed(1)}%`.padStart(7)
    + `${(held.get(k) / a.length).toFixed(1)}天`.padStart(8)
    + '  |' + yr.map(x => (x == null ? '  —' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`).padStart(7)).join('') + same);
}
console.log('═'.repeat(96));
console.log('⚠️ 「最差10%」= 最慘那 10% 的報酬(⛔ 不是最大回撤,是它的代理)—— 放寬會不會讓大賠更大就看這欄。');
console.log('⚠️ 報酬已扣同期加權 + 來回成本 0.44%;放寬條件全部用「當天收盤就知道」的資訊(零前視);');
console.log('   🚧 停損(前一根低點 / −5% 取較近)一律照走,⛔ 放寬不可動停損。');
