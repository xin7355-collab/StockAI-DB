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
// ⭐ 判準用 **Q4 ÷ Q1 的比值中位數**,⛔ 不用「是不是遞增」——
//    遞增會被「某一季虧損 / 負值」打亂(實測 ocf 明明是累計卻只有 43% 遞增)。
//    累計 → Q4 ≈ 4×Q1(比值 2.5~6);單季 → 比值 0.5~2。
// 🚨 實測 FinMind 的三表是**混的**:損益表(cogs/rev)單季、現金流量表(capex/dep/ocf)累計。
//    ⛔ 不可整批當成同一種處理。
function detectCumulative(field) {
  const j = FI[field], ratios = [];
  for (const qs of Object.values(F.s)) {
    const byY = {};
    for (const [q, v] of Object.entries(qs)) {
      if (v[j] != null) (byY[q.slice(0, 4)] ||= {})[q.slice(5, 7)] = Math.abs(v[j]);
    }
    for (const mm of Object.values(byY)) {
      if (mm['03'] > 0 && mm['12'] > 0) ratios.push(mm['12'] / mm['03']);
    }
  }
  ratios.sort((a, b) => a - b);
  const med = ratios.length ? ratios[ratios.length >> 1] : 1;
  const cum = med >= 2.5;
  console.log(`   📐 ${field}: Q4÷Q1 中位 ${med.toFixed(2)}(${ratios.length} 個年度)→ ` +
              (cum ? '🚨 累計 → 自動相減還原成單季' : med <= 2.0 ? '✅ 單季' : '⚠️ 看不出來,當單季處理'));
  return cum;
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
// 🚨🚨 對照組必須**按公布日對齊**(橫斷面去均值),⛔ 不可拿「全期平均」當基準 ——
//   第一版就是那樣做的,結果七種事件(連「DOI 上升」與「DOI 下降」這種相反的)
//   **逐年長得一模一樣**(2018~2022 全 +5~7pp、2023~2025 全負)= 量到的是「那一年大家好不好」,
//   不是「這個事件有沒有用」。⭐ 這是「對照組要共用非受測那條腿」的時間版。
const raw = [];                       // {pub, sym, tags[], rets{}}
const curveJobs = [];                 // 逐日曲線用(⭐ 回答「多久反應、多久離場」)
const yrOf = d => d.slice(0, 4);
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

    const tag = [];
    if (rank >= 0.7 && acc < 0) tag.push('🧊 庫存高檔但去化在加快(它說的落底訊號)');
    if (rank >= 0.7 && acc >= 0) tag.push('🚨 庫存高檔且還在惡化');
    if (rank <= 0.3 && acc > 0) tag.push('⚠️ 庫存低檔但開始堆積');
    if (spd < 0) tag.push('📉 DOI 下降(去化中)'); else if (spd > 0) tag.push('📈 DOI 上升(堆積中)');
    if (capexYoY != null && capexYoY <= -30) tag.push('✂️ 資本支出大砍(它說的利空出盡)');
    if (capexYoY != null && capexYoY >= 50) tag.push('🏗️ 資本支出大擴');
    raw.push({ pub, sym, tag, rets });
    curveJobs.push({ pub, sym, tag });
  }
}

// ── 🚨 橫斷面去均值:每一個公布日各自減掉「那天全部股票的平均」──
const avg0 = a => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const dayMean = {};                   // pub → { h: 平均 }
for (const r of raw) for (const h of HOR)
  if (r.rets[h] != null) ((dayMean[r.pub] ||= {})[h] ||= []).push(r.rets[h]);
const dayN = {};
for (const [p, m] of Object.entries(dayMean)) {
  dayN[p] = (m[120] || []).length;
  for (const h of HOR) m[h] = avg0(m[h]);
}
const evt = {}, byYear = {}, halves = {};
const ctrl = {}; HOR.forEach(h => ctrl[h] = []);
let skipThin = 0;
for (const r of raw) {
  if (dayN[r.pub] < 30) { skipThin++; continue; }   // ⛔ 同一天樣本太少,平均不可信
  for (const h of HOR) {
    if (r.rets[h] == null || !isFinite(dayMean[r.pub][h])) continue;
    const ex = r.rets[h] - dayMean[r.pub][h];        // ⭐ 相對「同一天的其他股票」
    ctrl[h].push(ex);                                // 對照組去均值後理應 ≈ 0
    for (const t of r.tag) ((evt[t] ||= {})[h] ||= []).push(ex);
  }
  const e120 = (r.rets[120] != null && isFinite(dayMean[r.pub][120]))
    ? r.rets[120] - dayMean[r.pub][120] : null;
  if (e120 != null) for (const t of r.tag) {
    ((byYear[t] ||= {})[yrOf(r.pub)] ||= []).push(e120);
    ((halves[t] ||= [[], []]))[r.pub < '2022-07-01' ? 0 : 1].push(e120);
  }
}
console.log(`   ⛔ 同一公布日樣本 <30 檔而略過:${skipThin} 筆`);
const avg = avg0;
// 🚧 空過守門:DOI 本身要像話 —— ⛔ 算出來全是垃圾的話,底下整張表都不用看
{
  const all = [], byS = {};
  for (const [sym, qs] of Object.entries(F.s)) {
    if (!S.has(sym)) continue;
    for (const q of Object.keys(qs)) {
      const v = calcDoi(qs[q][FI.inv], q1(sym, q, 'cogs'));
      if (v != null && v < 2000) { all.push(v); (byS[sym] ||= []).push(v); }
    }
  }
  all.sort((a, b) => a - b);
  const pick = k => all.length ? all[Math.floor(all.length * k)] : NaN;
  console.log(`   📏 DOI 分布(天):P10 ${pick(.1).toFixed(0)} ・中位 ${pick(.5).toFixed(0)} ・` +
              `P90 ${pick(.9).toFixed(0)}(${all.length} 個季度)`);
  const eg = ['2330', '1101', '2317', '2002', '2454'].filter(x => byS[x]);
  console.log('   📏 抽樣(各檔中位):' + eg.map(x => {
    const a = byS[x].slice().sort((p, q) => p - q);
    return `${x} ${a[a.length >> 1].toFixed(0)} 天`;
  }).join(' ・'));
  if (!(pick(.5) > 15 && pick(.5) < 200)) {
    console.log('   🚨 中位 DOI 不像話(合理應在 15~200 天)→ ⛔ 底下的表不要看,先查累計/單季判斷');
    process.exit(1);
  }
}
console.log(`   算得出 DOI(≥4 季)的:${nDoi} 檔 ・對照組 ${(ctrl[120] || []).length} 筆`);
console.log(`   公布日範圍:${allPub.length ? allPub.sort()[0] : '-'} ~ ${allPub.length ? allPub[allPub.length - 1] : '-'}`);

console.log('\n💰 事件研究(公布日隔天開盤買 ・扣同期加權 ・⭐ 再按公布日做橫斷面去均值)');
console.log('   ⭐ 對照組去均值後理應 ≈ 0 —— 那是這張表有沒有做對的**自我檢查**');
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


// ═══════════════════════════════════════════════════════════════════════
// ⏱️ 逐日累積超額報酬曲線 —— 回答「**多久才反應、反應完多久該走**」
//
// 🚨 使用者的質疑成立:只量 20/60/120 三個點、而且固定「抱滿 N 天」,
//    既看不出反應時點,也看不出該不該提早走。⭐ 正解是畫出**逐日**的曲線。
// ⭐ 而且窗口要**往前拉**(公布日前 60 天)—— 價格可能在財報出來之前就反應完了
//    (那份對話自己就說「資訊已 Price-in」)。⛔ 只看事後會漏掉這件事。
// ⛔ 對照仍然是**按公布日橫斷面去均值**(同上,⛔ 不可拿全期平均)。
// ═══════════════════════════════════════════════════════════════════════
const PRE = 60, POST = 250;
console.log(`\n⏱️ 逐日累積超額報酬曲線(公布日前 ${PRE} 天 ~ 後 ${POST} 天)`);

/** 以「公布日前最後一個收盤」為錨,回傳 k = -PRE..POST 的累積報酬%(相對錨點) */
function curve(sym, pub) {
  const st = S.get(sym); if (!st) return null;
  let a = st.d.findIndex(x => x >= pub); if (a <= 0) return null;
  a -= 1;                                             // 錨 = 公布日**之前**最後一個收盤
  if (a - PRE < 0 || a + POST >= st.d.length) return null;
  const base = st.c[a]; if (!(base > 0)) return null;
  const out = new Float64Array(PRE + POST + 1);
  for (let k = -PRE; k <= POST; k++) out[k + PRE] = (st.c[a + k] / base - 1) * 100;
  return out;
}

// 第一趟:每個公布日、每個 k 的**橫斷面平均**(那就是對照)
const cohort = {};                                    // pub → { n, sum:Float64Array }
const cvs = [];
for (const j of curveJobs) {
  const c = curve(j.sym, j.pub); if (!c) continue;
  cvs.push({ ...j, c });
  const g = (cohort[j.pub] ||= { n: 0, sum: new Float64Array(PRE + POST + 1) });
  g.n++; for (let i = 0; i < c.length; i++) g.sum[i] += c[i];
}
for (const g of Object.values(cohort)) for (let i = 0; i < g.sum.length; i++) g.sum[i] /= g.n;
console.log(`   樣本 ${cvs.length} 筆 ・${Object.keys(cohort).length} 個公布日`);

// 第二趟:去均值後按事件分組
const CUR = {};                                       // tag → { n, sum, half:[sum0,sum1], n0,n1, yr }
for (const e of cvs) {
  const g = cohort[e.pub]; if (g.n < 30) continue;
  const h = e.pub < '2022-07-01' ? 0 : 1;
  const y = e.pub.slice(0, 4);
  for (const t of e.tag) {
    const o = (CUR[t] ||= { n: 0, sum: new Float64Array(PRE + POST + 1),
                            h: [new Float64Array(PRE + POST + 1), new Float64Array(PRE + POST + 1)], hn: [0, 0],
                            yr: {} });
    o.n++; o.hn[h]++;
    const yo = (o.yr[y] ||= { n: 0, sum: new Float64Array(PRE + POST + 1) });
    yo.n++;
    for (let i = 0; i < e.c.length; i++) {
      const v = e.c[i] - g.sum[i];
      o.sum[i] += v; o.h[h][i] += v; yo.sum[i] += v;
    }
  }
}

const at = (o, k) => o.sum[k + PRE] / o.n;
const atH = (o, h, k) => o.h[h][k + PRE] / o.hn[h];
console.log('\n   事件                                  │ 公布前30 │ 公布日 │  +5日 │ +10日 │ +20日 │ +40日 │ +60日 │ +120日 │ +250日 │ n');
for (const [t, o] of Object.entries(CUR).sort((a, b) => at(b[1], 60) - at(a[1], 60))) {
  const cells = [-30, 0, 5, 10, 20, 40, 60, 120, 250].map(k => {
    const v = at(o, k) - at(o, 0);                     // ⭐ 一律以公布日為 0 點(⛔ 否則會混進事前的漂移)
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`.padStart(k === -30 ? 8 : 6);
  });
  console.log(`   ${t.padEnd(36)} │ ${cells.join(' │ ')} │ ${o.n}`);
}
console.log('   ⭐「公布前30」是**相對公布日**的 —— 負值代表事件股在公布前跑輸,正值代表已經先漲了');

console.log('\n📈 反應時點:曲線在哪一天最大 / 最小(⚠️ 全期找峰值一定會找到,所以下面還要驗)');
for (const [t, o] of Object.entries(CUR)) {
  let bk = 0, bv = 0, wk = 0, wv = 0;
  for (let k = 1; k <= POST; k++) {
    const v = at(o, k) - at(o, 0);
    if (v > bv) { bv = v; bk = k; }
    if (v < wv) { wv = v; wk = k; }
  }
  console.log(`   ${t}`);
  console.log(`      最大 +${bv.toFixed(2)}pp 在第 ${bk} 天 ・最小 ${wv.toFixed(2)}pp 在第 ${wk} 天 ・` +
              `第 250 天 ${(at(o, 250) - at(o, 0)).toFixed(2)}pp`);
}

console.log('\n🚦 「最佳持有天數」有沒有延續性(⭐ 前半段找、後半段驗 —— ⛔ 全期找峰值是過度配適)');
for (const [t, o] of Object.entries(CUR)) {
  if (o.hn[0] < 300 || o.hn[1] < 300) { console.log(`   ${t}: 樣本不足,略過`); continue; }
  let bk = 1, bv = -1e9;
  for (let k = 5; k <= POST; k++) { const v = atH(o, 0, k) - atH(o, 0, 0); if (v > bv) { bv = v; bk = k; } }
  const test = atH(o, 1, bk) - atH(o, 1, 0);
  const ok = test - COST > 0 ? '✅' : '❌';
  console.log(`   ${t}`);
  console.log(`      前半最佳持有 ${bk} 天(+${bv.toFixed(2)}pp)→ **後半段同樣抱 ${bk} 天:` +
              `${test >= 0 ? '+' : ''}${test.toFixed(2)}pp ・扣成本 ${(test - COST).toFixed(2)} ${ok}**`);
}
console.log('\n   ⚠️ 這一段回答的是「多久反應、多久離場」;⛔ 但「前半找到的天數在後半沒用」就代表沒有規律可循。');

// ⭐⭐ 上面通過的那幾個,找到的都是 97~248 天 = 「抱到窗口盡頭」,那不是「反應時點」是「慢慢漂」。
//    ⛔ 所以還要問兩件事:① 那個漂移逐年還是同一個方向嗎 ② 有沒有一個「反應」可言(集中在前幾天嗎)
console.log('\n🔍 追加兩問:那個「抱很久才賺」到底是不是訊號?');
console.log('\n   ① 前 20 天吃掉了 250 天走勢的幾成?(⭐ 有「反應」的話應該集中在前面)');
for (const [t, o] of Object.entries(CUR)) {
  const d20 = at(o, 20) - at(o, 0), d250 = at(o, 250) - at(o, 0);
  const pct = Math.abs(d250) > 0.05 ? (d20 / d250 * 100) : NaN;
  console.log(`   ${t.padEnd(36)} 前20天 ${d20 >= 0 ? '+' : ''}${d20.toFixed(2)}pp / 250天 ` +
              `${d250 >= 0 ? '+' : ''}${d250.toFixed(2)}pp = ${isFinite(pct) ? pct.toFixed(0) + '%' : '—'}`);
}

console.log('\n   ② 用「前半驗過的天數」逐年拆開(⛔ 逐年不同向 = 那個漂移不可靠)');
for (const [t, o] of Object.entries(CUR)) {
  if (o.hn[0] < 300 || o.hn[1] < 300) continue;
  let bk = 1, bv = -1e9;
  for (let k = 5; k <= POST; k++) { const v = atH(o, 0, k) - atH(o, 0, 0); if (v > bv) { bv = v; bk = k; } }
  const test = atH(o, 1, bk) - atH(o, 1, 0);
  if (test - COST <= 0) continue;                     // 前半/後半那關就沒過的不用再拆
  const ys = Object.keys(o.yr).sort();
  const cells = [], vals = [];
  for (const y of ys) {
    const yo = o.yr[y]; if (yo.n < 60) continue;
    const v = (yo.sum[bk + PRE] - yo.sum[0 + PRE]) / yo.n;
    vals.push(v); cells.push(`${y} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
  }
  const pos = vals.filter(v => v > 0).length;
  console.log(`   ${t}(抱 ${bk} 天)`);
  console.log(`      ${cells.join(' ・')}`);
  console.log(`      → ${pos}/${vals.length} 年為正 ${pos === vals.length ? '✅' : '❌ 逐年不同向'}`);
}
