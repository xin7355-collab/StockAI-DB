#!/usr/bin/env node
/**
 * 📦 存貨週轉天數(DOI)+ 資本支出 —— 供應鏈前瞻指標到底有沒有預測力(評估紀錄㉑ 的 ②)
 *
 * 使用者上傳的 Gemini 對話主張:
 *   ・DOI 高檔但**加速度轉負**(去化在加快)= 落底訊號,「比新聞提前 1~2 個月」
 *   ・CapEx 大幅下修 = 利空出盡、股價拐點
 *   ・CapEx 領先 12~24 個月、DOI 領先 0~3 個月
 *
 * ⛔⛔ 三個一定要做對的地方:
 *  ① 🚨 **前視**:季報有公布時間差(Q1→5/15 … Q4→隔年 3/31)。
 *     ⭐ 一律走 `lib_fundamentals.knownAsOf`,⛔ 不可拿季別當可用日。
 *  ② 🚨 **累計 vs 單季**:FinMind 的流量欄位若是累計,直接拿來算 DOI 會讓它
 *     從 Q1 到 Q4 一路變小 = **假裝一直在去化**。→ 這支**自己偵測並還原**,並把判斷印出來。
 *  ③ **對照組要共用非受測那條腿**:比較對象是「同一批股票、同一段期間、不看條件」,
 *     ⛔ 不是全市場(那量到的是「哪些股票比較好」)。
 *
 * ⭐ 六道關卡:全期正 ・前後半同向 ・逐年同向 ・去最好年 ・扣成本 0.44% ・(需要時)增量檢定
 * 🚨 進場一律**隔天開盤**(公布日當天收盤才知道),排除開盤鎖死。
 *
 * 用法:FIN=<fin_deep.json 路徑> node scripts/doi_probe.mjs
 */
import fs from 'fs';
import path from 'path';
import { knownAsOf, doi as calcDoi } from './lib_fundamentals.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const FIN = process.env.FIN || path.join(ROOT, 'fin_deep', 'fin_deep.json');
const COST = 0.44;
const HOR = [20, 60, 120];              // 季頻訊號 → 看得比較遠(它主張領先 1~2 個月以上)
const DEDUP = 60;                       // 同檔同事件 N 個交易日去重(季報本來就一季一次)

if (!fs.existsSync(FIN)) {
  console.log(`🚨 找不到 ${FIN}`);
  console.log('   取得方式:git fetch origin fin_deep && git show origin/fin_deep:fin_deep/fin_deep.json > /tmp/fin.json');
  console.log('   然後:FIN=/tmp/fin.json node scripts/doi_probe.mjs');
  process.exit(1);
}
const F = JSON.parse(fs.readFileSync(FIN, 'utf8'));
const FI = Object.fromEntries(F.f.map((k, i) => [k, i]));
console.log(`📥 財報:${F.meta.n} 檔 ・${F.meta.quarters} 季 ・${F.q[0]} ~ ${F.q[F.q.length - 1]}`);

// ── ② 累計 vs 單季:自己偵測(⛔ 不憑印象假設)──
function detectCumulative(field) {
  const j = FI[field];
  let asc = 0, tot = 0;
  for (const qs of Object.values(F.s)) {
    const byY = {};
    for (const [q, v] of Object.entries(qs)) {
      if (v[j] != null) (byY[q.slice(0, 4)] ||= {})[q.slice(5, 7)] = Math.abs(v[j]);
    }
    for (const mm of Object.values(byY)) {
      const seq = ['03', '06', '09', '12'].map(m => mm[m]);
      if (seq.some(x => x == null)) continue;
      tot++;
      if (seq[0] < seq[1] && seq[1] < seq[2] && seq[2] < seq[3]) asc++;
    }
  }
  const pct = tot ? asc / tot * 100 : 0;
  console.log(`   📐 ${field}: ${tot} 個年度裡 ${asc} 個遞增(${pct.toFixed(0)}%)→ ` +
              (pct >= 80 ? '🚨 累計 → 自動相減還原成單季' : pct <= 40 ? '✅ 單季' : '⚠️ 看不出來'));
  return pct >= 80;
}
console.log('\n📐 先判斷流量欄位是累計還是單季(⛔ 搞錯的話 DOI 會假裝一直在去化)');
const CUM = Object.fromEntries(['cogs', 'rev', 'capex', 'ocf', 'dep'].map(f => [f, detectCumulative(f)]));

/** 取某一檔某一季的**單季**值(累計就跟前一季相減;Q1 本來就是單季) */
function q1(sym, q, field) {
  const j = FI[field], row = F.s[sym][q];
  if (!row || row[j] == null) return null;
  const v = row[j];
  if (!CUM[field] || q.slice(5, 7) === '03') return v;
  const i = F.q.indexOf(q);
  for (let k = i - 1; k >= 0; k--) {                       // 找同一年的前一季
    const p = F.q[k];
    if (p.slice(0, 4) !== q.slice(0, 4)) break;
    const pr = F.s[sym][p];
    if (pr && pr[j] != null) return v - pr[j];
  }
  return null;                                             // ⛔ 找不到前一季就不硬算
}

// ── 價格 ──
const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(); for (const r of twii) mkt.set(norm(r.date), +r.close);
const mdays = [...mkt.keys()].sort(), mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => { const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]); return a > 0 ? (b / a - 1) * 100 : null; };

const S = new Map();
for (const sym of Object.keys(F.s)) {
  const p = path.join(DATA, sym + '.json');
  if (!fs.existsSync(p)) continue;
  let raw; try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  if (!Array.isArray(raw) || raw.length < 300) continue;
  const d = [], c = [], o = [], hi = [], lo = [];
  for (const b of raw) { const dd = norm(b.date), cc = +b.close;
    if (!dd || !(cc > 0) || !mkt.has(dd)) continue;
    d.push(dd); c.push(cc); o.push(+b.open || cc); hi.push(+b.high || cc); lo.push(+b.low || cc); }
  if (d.length < 300) continue;
  S.set(sym, { d, c, o, hi, lo, idx: new Map(d.map((x, i) => [x, i])) });
}
console.log(`\n📥 對得上 K 線的:${S.size} 檔`);

/** 公布日之後第一個交易日開盤買、n 個交易日後收盤賣,扣同期加權 */
function fwd(sym, pubDay, n) {
  const s = S.get(sym); if (!s) return null;
  let i = s.d.findIndex(x => x >= pubDay); if (i < 0) return null;
  if (i + 1 + n >= s.d.length) return null;
  const op = s.o[i + 1]; if (!(op > 0)) return null;
  if (s.hi[i + 1] === s.lo[i + 1] && Math.abs(op / s.c[i] - 1) > 0.095) return null;   // 開盤鎖死買不到
  const ex = (s.c[i + 1 + n] / op - 1) * 100, m = mktRet(s.d[i + 1], n);
  return m == null ? null : ex - m;
}

// ── 逐檔算 DOI 序列與事件 ──
const evt = {};                       // 事件名 → 各天期報酬
const add = (k, h, v) => { ((evt[k] ||= {})[h] ||= []).push(v); };
const ctrl = {};
const yrOf = d => d.slice(0, 4);
const byYear = {}, halves = {};
let nDoi = 0;
const allPub = [];

for (const [sym, qs] of Object.entries(F.s)) {
  if (!S.has(sym)) continue;
  const periods = Object.keys(qs).sort();
  // 每一季算一次 DOI(單季營業成本)
  const doiByQ = {};
  for (const q of periods) {
    const inv = qs[q][FI.inv], cogs = q1(sym, q, 'cogs');
    const v = calcDoi(inv, cogs);
    if (v != null && v < 2000) doiByQ[q] = v;              // ⛔ 離譜值不要(>2000 天多半是資料問題)
  }
  const qk = Object.keys(doiByQ).sort();
  if (qk.length >= 4) nDoi++;
  for (let i = 2; i < qk.length; i++) {
    const [a, b, c] = [qk[i - 2], qk[i - 1], qk[i]];
    const pub = knownAsOf([c], '9999-12-31');               // 這一季的公布日
    if (!pub) continue;
    allPub.push(pub);
    const v0 = doiByQ[a], v1 = doiByQ[b], v2 = doiByQ[c];
    const spd = v2 - v1;                                    // 一階:DOI 變化
    const acc = v2 - 2 * v1 + v0;                           // 二階:加速度
    const hist = qk.slice(0, i + 1).map(x => doiByQ[x]).sort((x, y) => x - y);
    const rank = hist.indexOf(v2) / Math.max(1, hist.length - 1);   // DOI 在自己歷史的位階
    // CapEx 年增率(單季,跟去年同季比)
    const cq = q1(sym, c, 'capex');
    const lastY = qk.find(x => x.slice(5) === c.slice(5) && +x.slice(0, 4) === +c.slice(0, 4) - 1);
    const cLast = lastY ? q1(sym, lastY, 'capex') : null;
    const capexYoY = (cq != null && cLast != null && Math.abs(cLast) > 0)
      ? (Math.abs(cq) - Math.abs(cLast)) / Math.abs(cLast) * 100 : null;

    const rets = {};
    for (const h of HOR) { const r = fwd(sym, pub, h); if (r != null) rets[h] = r; }
    if (!Object.keys(rets).length) continue;
    for (const h of HOR) if (rets[h] != null) ((ctrl[h] ||= []).push(rets[h]));

    const tag = [];
    if (rank >= 0.7 && acc < 0) tag.push('🧊 庫存高檔但去化在加快(它說的落底訊號)');
    if (rank >= 0.7 && acc >= 0) tag.push('🚨 庫存高檔且還在惡化');
    if (rank <= 0.3 && acc > 0) tag.push('⚠️ 庫存低檔但開始堆積');
    if (spd < 0) tag.push('📉 DOI 下降(去化中)'); else if (spd > 0) tag.push('📈 DOI 上升(堆積中)');
    if (capexYoY != null && capexYoY <= -30) tag.push('✂️ 資本支出大砍(它說的利空出盡)');
    if (capexYoY != null && capexYoY >= 50) tag.push('🏗️ 資本支出大擴');
    for (const t of tag) {
      for (const h of HOR) if (rets[h] != null) add(t, h, rets[h]);
      if (rets[120] != null) {
        ((byYear[t] ||= {})[yrOf(pub)] ||= []).push(rets[120]);
        ((halves[t] ||= [[], []]))[pub < '2022-07-01' ? 0 : 1].push(rets[120]);
      }
    }
  }
}
const avg = a => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
console.log(`   算得出 DOI(≥4 季)的:${nDoi} 檔 ・對照組 ${(ctrl[120] || []).length} 筆`);
console.log(`   公布日範圍:${allPub.length ? allPub.sort()[0] : '-'} ~ ${allPub.length ? allPub[allPub.length - 1] : '-'}`);

console.log('\n💰 事件研究(公布日隔天開盤買 ・扣同期加權 ・對照組 = 同一批股票同一批公布日)');
console.log('   事件                                  │ ' + HOR.map(h => `${h}日`.padStart(9)).join(' │ ') + ' │ n');
console.log('   (對照組)                              │ ' + HOR.map(h => avg(ctrl[h]).toFixed(2).padStart(9)).join(' │ ') + ` │ ${(ctrl[120] || []).length}`);
const rows = Object.entries(evt).sort((a, b) => (avg(b[1][120]) || 0) - (avg(a[1][120]) || 0));
for (const [k, v] of rows) {
  console.log(`   ${k.padEnd(36)} │ ` + HOR.map(h => {
    const e = avg(v[h]) - avg(ctrl[h]);
    return `${e >= 0 ? '+' : ''}${e.toFixed(2)}pp`.padStart(9);
  }).join(' │ ') + ` │ ${(v[120] || []).length}`);
}
console.log('\n🚦 六道關卡(120 日,已扣對照組)');
for (const [k] of rows) {
  const ys = Object.keys(byYear[k] || {}).sort();
  const yv = ys.map(y => avg(byYear[k][y]) - avg(ctrl[120]));
  const h0 = avg(halves[k][0]) - avg(ctrl[120]), h1 = avg(halves[k][1]) - avg(ctrl[120]);
  const base = avg(evt[k][120]) - avg(ctrl[120]);
  const worst = ys.length > 1
    ? (() => { const bi = yv.indexOf(Math.max(...yv));
        const keep = ys.filter((_, i) => i !== bi).flatMap(y => byYear[k][y]);
        return avg(keep) - avg(ctrl[120]); })() : NaN;
  const same = ys.length > 1 && yv.every(v => v > 0) || yv.every(v => v < 0);
  console.log(`   ${k}`);
  console.log(`      全期 ${base >= 0 ? '+' : ''}${base.toFixed(2)}pp ・扣成本 ${(base - COST).toFixed(2)} ・` +
              `前後半 ${h0.toFixed(2)} / ${h1.toFixed(2)} ${((h0 > 0) === (h1 > 0)) ? '✅' : '❌'} ・` +
              `逐年 ${same ? '✅' : '❌'} ・去最好年 ${isFinite(worst) ? worst.toFixed(2) : '-'}`);
  console.log(`      逐年:${ys.map((y, i) => `${y} ${yv[i] >= 0 ? '+' : ''}${yv[i].toFixed(2)}`).join(' ・')}`);
}
console.log(`\n   ⚠️ 來回成本 ${COST}% —— 上面任何一格要 > ${COST} 才談得上「可交易」`);
console.log('   ⚠️ 季報只有 34 季 → 每檔最多 32 個事件;而且窗口(2018~2026)偏多頭。');
