#!/usr/bin/env node
/**
 * 🔥 「曾經是飆股體質,後面是不是容易漲回來?」(V74.4.5)
 *
 * 使用者:「有曾經是飆股體質後面是不是就容易漲回來?」
 *
 * ⭐ 這題最容易做錯的地方是**對照組**:
 *   如果拿全市場當對照,量到的是「跌深之後會不會反彈」——那是另一個問題,
 *   而且 CLAUDE.md 已經測過(接刀多半不好)。
 *   ⛔ 要回答「**曾經飆過**有沒有差」,對照組必須是「**同樣跌深、但沒飆過**」的股票,
 *   也就是把「跌深」那條腿共用掉(同 broker_cross_probe / sector_pick_probe 的做法)。
 *
 * 三種「飆股體質」的可測定義(全部只用**當天為止**的資料,零前視):
 *   A 曾經翻倍   :過去 500 個交易日裡,某一天的「近 250 日報酬」≥ +100%
 *   B 曾經進 🧬  :過去 250 日裡曾經「一年位階 ≥75 且 20 日振幅 ≥3.2%」(本站實測有效的那組)
 *   C 曾經常漲停 :過去 250 日裡漲停 ≥ 3 次
 *
 * 🚨 進場 = **隔天開盤**(排除開盤仍鎖死);報酬扣同期加權;同檔同格 20 日去重。
 * ⭐ 六道關卡:全期正 ・前後半同向 ・逐年同向 ・去最好年 ・扣成本 0.44%
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const HOR = [10, 20, 60];
const COST = 0.44;
const DEDUP = 20;

const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) {
  const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
  if (!d) continue;
  mkt.set(d, +r.close); mdays.push(d);
}
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => {
  const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]);
  return a > 0 ? (b / a - 1) * 100 : null;
};

// 滑動視窗最大/最小(單調佇列,O(n))—— ⛔ 不用 Math.max(...win):2,500 檔 × 1,200 根 × 252 會跑很久
const slide = (arr, w, cmp) => {
  const out = new Array(arr.length).fill(null), q = [];
  for (let i = 0; i < arr.length; i++) {
    while (q.length && q[0] <= i - w) q.shift();
    const v = arr[i];
    if (v != null) { while (q.length && cmp(arr[q[q.length - 1]], v)) q.pop(); q.push(i); }
    out[i] = q.length ? arr[q[0]] : null;
  }
  return out;
};
const slideMax = (a, w) => slide(a, w, (x, y) => x <= y);
const slideMin = (a, w) => slide(a, w, (x, y) => x >= y);

const buckets = new Map();
const add = (k, ev) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ev); };

const files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
let nSym = 0, nBar = 0;
for (const f of files) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 600) continue;
  const sym = f.replace('.json', '');
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
    o: +r.open, h: +r.high, l: +r.low, c: +r.close,
  })).filter(r => r.d);
  if (R.length < 600) continue;
  nSym++; nBar += R.length;
  const N = R.length;
  const C = R.map(r => r.c);
  const chg = C.map((c, i) => i ? (c / C[i - 1] - 1) * 100 : 0);

  // 近 250 日報酬 / 位階 / 振幅
  const hi250 = slideMax(C, 250), lo250 = slideMin(C, 250);
  const ret250 = C.map((c, i) => i >= 250 ? (c / C[i - 250] - 1) * 100 : null);
  const pos = C.map((c, i) => {
    const a = hi250[i], b = lo250[i];
    return (i >= 250 && a > b) ? (c - b) / (a - b) * 100 : null;
  });
  const amp = new Array(N).fill(null);
  { let s = 0;
    for (let i = 0; i < N; i++) {
      s += (R[i].h - R[i].l) / R[i].c * 100;
      if (i >= 20) s -= (R[i - 20].h - R[i - 20].l) / R[i - 20].c * 100;
      if (i >= 19) amp[i] = s / 20;
    } }
  // 「曾經」= 過去 500 / 250 日裡出現過(⛔ 不含今天,避免把今天算成「曾經」)
  const maxRet500 = slideMax(ret250, 500);
  const geneFlag = C.map((_, i) => (pos[i] != null && amp[i] != null && pos[i] >= 75 && amp[i] >= 3.2) ? 1 : 0);
  const luFlag = chg.map(v => v >= 9.2 ? 1 : 0);
  const pre = (a) => { const p = [0]; for (let i = 0; i < a.length; i++) p.push(p[i] + a[i]); return p; };
  const pG = pre(geneFlag), pL = pre(luFlag);

  const last = new Map();
  const emit = (key, i) => {
    const p = last.get(key);
    if (p != null && i - p < DEDUP) return;
    const e = i + 1; if (e >= N) return;
    const gap = (R[e].o / R[i].c - 1) * 100;
    if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) return;
    const ret = { _d: R[e].d };
    for (const n of HOR) {
      const j = e + n;
      if (j >= N) { ret[n] = null; continue; }
      const m = mktRet(R[e].d, n);
      ret[n] = m == null ? null : (C[j] / R[e].o - 1) * 100 - m;
    }
    last.set(key, i);
    add(key, ret);
  };

  for (let i = 520; i < N - 1; i++) {
    // 「曾經」的三種定義(⛔ 一律看 i-1 為止)
    const everX2 = (maxRet500[i - 1] != null && maxRet500[i - 1] >= 100);
    const everGene = (pG[i] - pG[Math.max(0, i - 250)]) > 0;
    const luN = pL[i] - pL[Math.max(0, i - 250)];
    const everLU = luN >= 3;
    // 現在跌多深(距近 250 日高點)
    const dd = hi250[i] > 0 ? (C[i] / hi250[i] - 1) * 100 : 0;

    emit('對照組(所有交易日)', i);

    // ── ① 「曾經飆過」本身(不看現在跌不跌)──
    emit(everX2 ? '🔥 曾經翻倍(近2年內)' : '➖ 沒翻倍過', i);
    emit(everGene ? '🧬 曾經進過飆股框(位階≥75且振幅≥3.2)' : '➖ 沒進過飆股框', i);
    emit(everLU ? '🚀 曾經常漲停(近1年≥3次)' : '➖ 很少漲停', i);

    // ── ② 使用者真正問的:**跌深之後**,曾經飆過的會不會比較容易漲回來 ──
    //    ⭐ 對照組共用「跌深」那條腿 —— ⛔ 不可拿全市場比(那量到的是「跌深」本身)
    if (dd <= -30) {
      emit('📉 跌深 ≥30%(全部・這是下面幾格的對照組)', i);
      emit(everX2 ? '📉 跌深 × 🔥 曾經翻倍' : '📉 跌深 × 沒翻倍過', i);
      emit(everGene ? '📉 跌深 × 🧬 曾經進過飆股框' : '📉 跌深 × 沒進過飆股框', i);
      emit(everLU ? '📉 跌深 × 🚀 曾經常漲停' : '📉 跌深 × 很少漲停', i);
    }
    if (dd <= -50) {
      emit('📉 腰斬 ≥50%(全部・對照組)', i);
      emit(everX2 ? '📉 腰斬 × 🔥 曾經翻倍' : '📉 腰斬 × 沒翻倍過', i);
    }

    // ── ③ 「飆完多久了」—— 剛飆完 vs 飆很久以前(只在曾經進過框的股票裡比)──
    if (everGene) {
      let ago = null;
      for (let j = i - 1; j >= Math.max(0, i - 250); j--) if (geneFlag[j]) { ago = i - j; break; }
      if (ago != null) {
        emit(ago <= 20 ? '🧬 離開飆股框 ≤20 天(剛冷掉)'
          : ago <= 60 ? '🧬 離開飆股框 21~60 天'
          : ago <= 120 ? '🧬 離開飆股框 61~120 天' : '🧬 離開飆股框 >120 天(冷很久)', i);
      }
    }

    // ── ④ 反面對照:曾經飆過 **而且現在還在高檔**(追強)vs 曾經飆過但跌深(抄底)──
    if (everGene) emit(dd >= -10 ? '🧬 曾經飆過 × 現在還在高檔(追強)' : dd <= -30 ? '🧬 曾經飆過 × 現在跌深(抄底)' : '🧬 曾經飆過 × 中間', i);
  }
}

// ── 統計 ──
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const base = buckets.get('對照組(所有交易日)') || [];
const baseAvg = {}, baseWin = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null);
  baseAvg[n] = avg(v); baseWin[n] = v.filter(x => x > 0).length / v.length * 100;
}
console.log(`\n📊 樣本:${nSym} 檔 ・${nBar.toLocaleString()} 根 K ・對照組 ${base.length.toLocaleString()} 個事件`);
console.log('   對照組平均超額:' + HOR.map(n => `${n}日 ${baseAvg[n].toFixed(2)}%`).join(' ・'));
console.log('   對照組勝率  :' + HOR.map(n => `${n}日 ${baseWin[n].toFixed(1)}%`).join(' ・'));
console.log('   ⚠️ 基準是負的(中位數個股跑輸市值加權指數)—— ⛔ 不是 0 也不是 50%\n');

const stat = (evs, refAvg) => {
  const r = { n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - refAvg[n] : null;
    r[`w${n}`] = v.length ? v.filter(x => x > 0).length / v.length * 100 : null;
    r[`m${n}`] = v.length ? med(v) : null;
  }
  return r;
};
const pad = (s, w) => String(s).padEnd(w, ' ');
const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);

console.log('【相對「所有交易日」】');
console.log('事件'.padEnd(40) + 'n'.padStart(9) + '   10日    20日    60日  | 20日勝率  20日中位');
console.log('─'.repeat(100));
const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組') || evs.length < 300) continue;
  rows.push({ k, ...stat(evs, baseAvg) });
}
rows.sort((a, b) => (b.e20 ?? -99) - (a.e20 ?? -99));
for (const r of rows) {
  console.log(pad(r.k, 40) + String(r.n).padStart(9) + '  '
    + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + '  |'
    + (r.w20 == null ? '—' : r.w20.toFixed(1) + '%').padStart(8)
    + (r.m20 == null ? '—' : num(r.m20) + '%').padStart(10));
}

// ⭐⭐ 真正的判準:在「同樣跌深」的母體裡比(⛔ 共用那條腿)
const cell = (baseKey, pairs) => {
  const b = buckets.get(baseKey);
  if (!b || b.length < 100) { console.log(`\n(${baseKey} 樣本不足)`); return; }
  const bAvg = {};
  for (const n of HOR) { const v = b.map(e => e[n]).filter(x => x != null); bAvg[n] = avg(v); }
  console.log(`\n\n████ 對照組 = ${baseKey}(n=${b.length.toLocaleString()};`
    + HOR.map(n => `${n}日 ${bAvg[n].toFixed(2)}%`).join(' ・') + ')████');
  console.log('格'.padEnd(40) + 'n'.padStart(9) + '   10日    20日    60日  | 20日勝率');
  for (const k of pairs) {
    const e = buckets.get(k); if (!e) continue;
    const r = stat(e, bAvg);
    console.log(pad(k, 40) + String(r.n).padStart(9) + '  '
      + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + '  |'
      + (r.w20 == null ? '—' : r.w20.toFixed(1) + '%').padStart(8));
  }
};
cell('📉 跌深 ≥30%(全部・這是下面幾格的對照組)',
  ['📉 跌深 × 🔥 曾經翻倍', '📉 跌深 × 沒翻倍過', '📉 跌深 × 🧬 曾經進過飆股框',
   '📉 跌深 × 沒進過飆股框', '📉 跌深 × 🚀 曾經常漲停', '📉 跌深 × 很少漲停']);
cell('📉 腰斬 ≥50%(全部・對照組)', ['📉 腰斬 × 🔥 曾經翻倍', '📉 腰斬 × 沒翻倍過']);

// ── 🚧 穩健性(20 日)──
const allD = base.map(e => e._d).filter(Boolean).sort();
const MID = allD[Math.floor(allD.length / 2)];
console.log(`\n\n████ 🚧 穩健性檢定(20 日,相對「所有交易日」)・樣本 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID} ████`);
const yrs = [...new Set(allD.map(d => d.slice(0, 4)))].sort();
console.log('事件'.padEnd(40) + '前半    後半  |' + yrs.map(y => y.slice(2).padStart(7)).join('') + ' | 去最好年  扣成本');
for (const r of rows) {
  const evs = buckets.get(r.k);
  const sub = f => { const v = evs.filter(f).map(e => e[20]).filter(x => x != null); const bv = base.filter(f).map(e => e[20]).filter(x => x != null); return (v.length >= 30 && bv.length >= 30) ? avg(v) - avg(bv) : null; };
  const h1 = sub(e => e._d < MID), h2 = sub(e => e._d >= MID);
  const per = yrs.map(y => sub(e => e._d.startsWith(y)));
  const bestI = per.reduce((bi, v, i) => (v != null && (per[bi] == null || v > per[bi])) ? i : bi, 0);
  const exBest = sub(e => !e._d.startsWith(yrs[bestI]));
  console.log(pad(r.k, 40) + num(h1).padStart(6) + num(h2).padStart(8) + '  |'
    + per.map(v => num(v).padStart(7)).join('') + ' |'
    + num(exBest).padStart(8) + num(r.e20 == null ? null : r.e20 - COST).padStart(9));
}
