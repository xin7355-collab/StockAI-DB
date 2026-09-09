#!/usr/bin/env node
/**
 * 🌦️ 策略資料庫 × 市場情境矩陣(多情境 + 防偏誤嚴格重測)—— V74.9.1
 *
 * 使用者(2026-09-06)給的規格:
 *  【一】⛔ 不用全時段平均 —— 依「當下大盤狀態」切:
 *        ① 多頭:加權 > 60MA 且 60MA 扣抵向上(= MA60 今天 > 昨天)
 *        ② 空頭:加權 < 60MA 且 60MA 扣抵向下
 *        ③ 盤整/高波動:近 20 日高低振幅 < 5% **或** 大盤 ATR14 在近一年前 20% 高位
 *        ⚠️ 規格的 ③ 把「盤整(低振幅)」與「高波動」放同一格 —— 兩者是**相反的環境**,
 *           所以這裡照規格給合併格,**同時**拆成 ③a 盤整 / ③b 高波動 各報一次(⛔ 不可只給合併格)。
 *        ④ 過渡:四個都不符(> MA60 但 MA60 還在下彎,或反過來)—— 規格沒列,⛔ 但不可靜默丟掉。
 *  【二】防偏誤:
 *        ・零前視:條件只用 **T 日收盤前**可得的數字;位階/振幅/均線全部是**往回看**的窗口,
 *          ⛔ 沒有任何「全歷史極值」(pos252 是往回 252 日、不是全期)。
 *        ・進場 = **T+1 開盤**(⛔ 訊號日收盤買不到)、排除 T+1 開盤鎖漲停(買不到)。
 *        ・持有窗口 5 / 10 / 20 / 40 日**各跑一次** → 看「窗口長度會不會翻轉結論」。
 *        ・對照組 = **同情境、同窗口、同母體**的全部(股·日)—— ⛔ 不是全時段全市場。
 *          固定窗口(⛔ 不用停損/移動出場)→ 沒有「持有天數不同被退場效應吃掉」的問題。
 *        ・樣本 < 30 標「⚠️ 樣本不足,容易虛胖」。
 *  【三】輸出:全時段 vs 多頭 vs 空頭 vs 盤整 的勝率 / 盈虧比 / MDD + 判定標籤。
 *
 * ⚠️⚠️ 規格的判定門檻(🟢 = 三情境勝率皆 >55% 且盈虧比 >1.8)是**憑空訂的**:
 *    台股個股「隨便挑一天、抱 20 天」的上漲比例只有 **~41%**(市值加權指數被台積電拉著,中位數個股跑輸),
 *    空頭情境更低。要求**空頭也 >55%** 等於要求贏基準 15~20 個百分點 —— 本站 129 個訊號沒有一個做得到。
 *    → 這裡**照規格貼標籤**(⛔ 不改門檻),但**同時**給本站標準的第二個判定
 *      (扣成本後贏同情境對照組、而且 10/20/40 日同向),⛔ 不可只給其中一個。
 *
 * 🧪 MDD:事件研究沒有帳戶曲線 → 用「一次一筆、照進場日排序、⛔ 不重疊」的近似
 *    (同 V74.6.7 漁獲結算),⛔ 不是同時抱多檔的組合回撤。
 *
 * 用法:node scripts/regime_matrix_probe.mjs [--emit out.json] [--max N]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const args = process.argv.slice(2);
const EMIT = args.includes('--emit') ? args[args.indexOf('--emit') + 1] : null;
const MAX = args.includes('--max') ? +args[args.indexOf('--max') + 1] : 99999;
const WINS = [5, 10, 20, 40];
const COST = 0.44;                 // 來回成本 %(手續費 0.1425%×2×折數 + 證交稅 0.3%)
const DEDUP = 20;                  // 同檔同策略 20 日內只算一次
const MIN_AMT = 1e7;               // 可交易性:當日成交額 ≥ 1,000 萬(⛔ 買不到的價不算)
const MIN_N = 30;                  // 規格:樣本 < 30 → 標「樣本不足,容易虛胖」

const load = p => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.data || []); };
const num = x => (x == null || x === '' ? NaN : +x);

// ── ① 大盤情境(⛔ 只用 T 日收盤前可得的:MA60[t]、MA60[t-1]、近 20 日高低、ATR14 近一年分位)──
const TW = load(path.join(DATA, '^TWII.json')).filter(r => Number.isFinite(num(r.close)) && num(r.close) > 0);
const TWd = TW.map(r => r.date), TWc = TW.map(r => num(r.close)), TWh = TW.map(r => num(r.high)), TWl = TW.map(r => num(r.low));
const twIdx = new Map(TWd.map((d, i) => [d, i]));
const REG = new Array(TW.length).fill(null);      // 'bull' | 'bear' | 'flat' | 'hivol' | 'mixed'
{
  const ma60 = new Array(TW.length).fill(null);
  let s = 0;
  for (let i = 0; i < TW.length; i++) { s += TWc[i]; if (i >= 60) s -= TWc[i - 60]; if (i >= 59) ma60[i] = s / 60; }
  const tr = TWc.map((c, i) => i ? Math.max(TWh[i] - TWl[i], Math.abs(TWh[i] - TWc[i - 1]), Math.abs(TWl[i] - TWc[i - 1])) : TWh[i] - TWl[i]);
  const atr = new Array(TW.length).fill(null);
  { let a = null; for (let i = 0; i < TW.length; i++) { a = a == null ? tr[i] : (a * 13 + tr[i]) / 14; if (i >= 13) atr[i] = a; } }
  for (let i = 60; i < TW.length; i++) {
    const up = ma60[i] > ma60[i - 1], dn = ma60[i] < ma60[i - 1];
    if (TWc[i] > ma60[i] && up) { REG[i] = 'bull'; continue; }
    if (TWc[i] < ma60[i] && dn) { REG[i] = 'bear'; continue; }
    let hi = -Infinity, lo = Infinity;
    for (let q = i - 19; q <= i; q++) { if (TWh[q] > hi) hi = TWh[q]; if (TWl[q] < lo) lo = TWl[q]; }
    const amp20 = (hi - lo) / TWc[i] * 100;
    // ATR 在「近 250 日」的分位(⛔ 往回看,不是全期)
    let rank = 0, cnt = 0;
    for (let q = Math.max(13, i - 249); q <= i; q++) { cnt++; if (atr[q] <= atr[i]) rank++; }
    const atrPct = cnt ? rank / cnt : 0;
    REG[i] = amp20 < 5 ? 'flat' : atrPct >= 0.8 ? 'hivol' : 'mixed';
  }
}
const REGN = { bull: '多頭', bear: '空頭', flat: '盤整(振幅<5%)', hivol: '高波動(ATR前20%)', mixed: '過渡' };
const regCount = {}; for (const r of REG) if (r) regCount[r] = (regCount[r] || 0) + 1;
// 規格的第 ③ 格 = flat ∪ hivol;報表把它也算成一個 group(fh)
const G_OF = r => r === 'flat' || r === 'hivol' ? 'fh' : r;
const GROUPS = ['all', 'bull', 'bear', 'fh', 'flat', 'hivol', 'mixed'];
const GN = { all: '全時段', bull: '多頭', bear: '空頭', fh: '盤整/高波動(規格③)', flat: '　├ 盤整', hivol: '　└ 高波動', mixed: '過渡(規格沒列)' };

// 大盤 20 日報酬(相對強度用)
const TWret20 = TWc.map((c, i) => i >= 20 ? (c / TWc[i - 20] - 1) * 100 : NaN);

// ── ② 策略定義(每一條只用 ≤ t 的資料;回 true = 今天觸發)──────────────────
//    ⛔ 定義照本站既有探針/選股條件一字不差(改了就不能跟既有成績單對照)
const STRATS = [
  { k: 'gene',     t: '🧬 位階≥75 且 20日振幅≥3.2%(App 現行必要條件)', state: true,
    f: X => X.pos252 >= 75 && X.amp20 >= 3.2 },
  { k: 'hi252',    t: '🏔️ 創一年新高(收盤 ≥ 前 252 日最高收盤)',
    f: X => X.i >= 252 && X.c >= X.maxC252prev },
  { k: 'hi60',     t: '🏔️ 創 60 日新高',
    f: X => X.i >= 60 && X.c >= X.maxC60prev },
  { k: 'limitup',  t: '🔺 漲停股(今日漲幅 ≥9.5%)',
    f: X => X.chg >= 9.5 },
  { k: 'mom20',    t: '🚀 近 20 日漲幅 >20%', state: true,
    f: X => X.ret20 > 20 },
  { k: 'rs8',      t: '🚀 相對強度(近 20 日超額贏大盤 ≥8%,選股榜「相對強度」)', state: true,
    f: X => Number.isFinite(X.twr20) && X.ret20 - X.twr20 >= 8 },
  { k: 'racer',    t: '🏎️ 渣男賽車(成交 >5 億・近 5 日有單日 ≥7%・站上 5 日線)', state: true,
    f: X => X.amt >= 5e8 && X.max5chg >= 7 && X.c > X.ma5 },
  { k: 'monster',  t: '🐲 妖股雷達(5 日 ≥20% 或 10 日 ≥30%,且量 ≥2 倍 20 日均量)', state: true,
    f: X => (X.ret5 >= 20 || X.ret10 >= 30) && X.v >= 2 * X.v20 },
  { k: 'rsi70',    t: '📈 RSI14 >70(「超買」)', state: true,
    f: X => X.rsi > 70 },
  { k: 'ma20x',    t: '🐢 站上月線(收盤由下往上穿 20 日線)',
    f: X => X.i >= 21 && X.c > X.ma20 && X.cPrev <= X.ma20prev },
  { k: 'retest60', t: '🏔️ 創60日高後回測不破(今天收紅;streak_probe 定義)',
    f: X => X.retest60 },
  { k: 'gapHi',    t: '🕳️ 向上跳空(≥1%)× 位階≥70',
    f: X => X.i >= 1 && X.l > X.hPrev * 1.01 && X.pos252 >= 70 },
  { k: 'ldRedK',   t: '🕯️ 跌停後第一根紅K(昨跌 ≤−9.2%、今收漲)',
    f: X => X.chgPrev <= -9.2 && X.chg > 0 },
  { k: 'ldRedBig', t: '🕯️ 跌停後紅K × 大紅(≥3%)',
    f: X => X.chgPrev <= -9.2 && X.chg >= 3 },
  { k: 'lo25',     t: '🧊 位階低檔(≤25%)—— 抄底對照', state: true,
    f: X => X.pos252 <= 25 },
  { k: 'lo252',    t: '🧊 創一年新低 —— 抄底對照',
    f: X => X.i >= 252 && X.c <= X.minC252prev },
  { k: 'kd20',     t: '📉 KD 的 K <20(「超賣」)—— 抄底對照', state: true,
    f: X => X.k9 < 20 },
  { k: 'sectop3',  t: '💧 板塊 20 日動能前 3 強的成員(官方 33 產業,只有上市)', state: true, sector: true,
    f: X => X.secTop3 },
];

// ── ③ 累加器 ────────────────────────────────────────────────────────────
const mkAcc = () => ({ n: 0, sum: 0, w: 0, sw: 0, sl: 0, rs: [] });
// 🧪 P10(單筆最差 10%)—— 對照組有幾百萬筆,用水塘抽樣 20,000 筆估(⛔ 事件那邊 n 小,等於全存)
const RES = 20000;
const add = (a, r) => { a.n++; a.sum += r; if (r > 0) { a.w++; a.sw += r; } else a.sl += -r;
  if (a.rs.length < RES) a.rs.push(r); else { const j = Math.floor(Math.random() * a.n); if (j < RES) a.rs[j] = r; } };
const p10 = a => { if (!a.rs.length) return NaN; const b = a.rs.slice().sort((x, y) => x - y); return b[Math.floor(b.length * 0.1)]; };
const CTL = {};                          // CTL[g][w] = acc(對照組:同情境同窗口全部 股·日)
for (const g of GROUPS) { CTL[g] = {}; for (const w of WINS) CTL[g][w] = mkAcc(); }
// 🧪 對照組的序列 MDD:同樣一次一筆不重疊 —— ⛔ 沒有它,「空頭 MDD >30%」這條會把**隨便挑一天**也判成嚴禁
const CTLL = {}; for (const g of GROUPS) { CTLL[g] = {}; for (const w of WINS) CTLL[g][w] = []; }
const pushRes = (arr, rec, n) => { if (arr.length < RES) arr.push(rec); else { const j = Math.floor(Math.random() * n); if (j < RES) arr[j] = rec; } };
const EV = {};                           // EV[k][g][w] = acc;EVL[k][g][w] = [{d,x,r}] 給 MDD 用
const EVL = {};
for (const s of STRATS) { EV[s.k] = {}; EVL[s.k] = {};
  for (const g of GROUPS) { EV[s.k][g] = {}; EVL[s.k][g] = {}; for (const w of WINS) { EV[s.k][g][w] = mkAcc(); EVL[s.k][g][w] = []; } } }

// ── ④ 板塊 20 日動能前 3 強(每天算一次;只用 ≤t 的收盤)──────────────────
const IND = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'));
const files = fs.readdirSync(DATA).filter(f => /^[1-9]\d{3}[A-Z]?\.json$/.test(f)).slice(0, MAX);   // ⛔ 排除 ETF(00 開頭)
console.log(`📦 ${files.length} 檔(⛔ 不含 ETF)・大盤 ${TW.length} 根(${TWd[0]} ~ ${TWd.at(-1)})`);
console.log(`🌦️ 情境天數(大盤 60MA 暖身後):` + Object.entries(regCount).map(([k, v]) => `${REGN[k]} ${v}`).join(' ・ '));

// 先過一遍:每檔的 20 日報酬序列 → 每天每產業的等權中位數 → 前 3 強
const SEC_TOP = new Map();               // date → Set(ind code)
{
  const byDay = new Map();               // date → Map(ind → [ret20...])
  for (const f of files) {
    const sym = f.replace('.json', ''), ind = IND[sym]; if (!ind) continue;
    let R; try { R = load(path.join(DATA, f)); } catch (_) { continue; }
    const C = R.map(r => num(r.close));
    for (let i = 20; i < R.length; i++) {
      if (!(C[i] > 0 && C[i - 20] > 0)) continue;
      const d = R[i].date; let m = byDay.get(d); if (!m) { m = new Map(); byDay.set(d, m); }
      let a = m.get(ind); if (!a) { a = []; m.set(ind, a); }
      a.push((C[i] / C[i - 20] - 1) * 100);
    }
  }
  for (const [d, m] of byDay) {
    const rows = [];
    for (const [ind, a] of m) { if (a.length < 5) continue; a.sort((x, y) => x - y); rows.push([ind, a[a.length >> 1]]); }
    if (rows.length < 10) continue;
    rows.sort((x, y) => y[1] - x[1]);
    SEC_TOP.set(d, new Set(rows.slice(0, 3).map(x => x[0])));
  }
  console.log(`💧 板塊前 3 強:${SEC_TOP.size} 個交易日算得出來`);
}

// ── ⑤ 主迴圈 ──────────────────────────────────────────────────────────
let nSym = 0, nDay = 0;
for (const f of files) {
  const sym = f.replace('.json', ''), ind = IND[sym] || null;
  let R; try { R = load(path.join(DATA, f)); } catch (_) { continue; }
  R = R.filter(r => Number.isFinite(num(r.close)) && num(r.close) > 0 && Number.isFinite(num(r.open)));
  const N = R.length; if (N < 80) continue;
  nSym++;
  const C = R.map(r => num(r.close)), O = R.map(r => num(r.open)), H = R.map(r => num(r.high)), L = R.map(r => num(r.low)), V = R.map(r => num(r.volume) || 0);
  // 指標(全部往回看)
  const ma5 = new Array(N), ma20 = new Array(N), v20 = new Array(N);
  { let s5 = 0, s20 = 0, sv = 0;
    for (let i = 0; i < N; i++) { s5 += C[i]; s20 += C[i]; sv += V[i];
      if (i >= 5) s5 -= C[i - 5]; if (i >= 20) { s20 -= C[i - 20]; sv -= V[i - 20]; }
      ma5[i] = i >= 4 ? s5 / 5 : NaN; ma20[i] = i >= 19 ? s20 / 20 : NaN; v20[i] = i >= 19 ? sv / 20 : NaN; } }
  const rsi = new Array(N).fill(NaN);
  { let au = 0, ad = 0; for (let i = 1; i < N; i++) { const d = C[i] - C[i - 1]; const u = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
      if (i <= 14) { au += u; ad += dn; if (i === 14) { au /= 14; ad /= 14; rsi[i] = ad ? 100 - 100 / (1 + au / ad) : 100; } }
      else { au = (au * 13 + u) / 14; ad = (ad * 13 + dn) / 14; rsi[i] = ad ? 100 - 100 / (1 + au / ad) : 100; } } }
  const k9 = new Array(N).fill(NaN);
  { let k = 50; for (let i = 8; i < N; i++) { let hh = -Infinity, ll = Infinity; for (let q = i - 8; q <= i; q++) { if (H[q] > hh) hh = H[q]; if (L[q] < ll) ll = L[q]; }
      const rsv = hh > ll ? (C[i] - ll) / (hh - ll) * 100 : 50; k = k * 2 / 3 + rsv / 3; k9[i] = k; } }
  const last = new Map();                // strat → 上次觸發 index(去重)

  for (let i = 1; i < N - 1; i++) {
    const d = R[i].date, ti = twIdx.get(d); if (ti == null) continue;
    const reg = REG[ti]; if (!reg) continue;
    // 可交易性(對照組與事件**同一套**)
    if (C[i] * V[i] < MIN_AMT) continue;
    const o1 = O[i + 1]; if (!(o1 > 0)) continue;
    if (o1 >= C[i] * 1.095 && Math.abs(H[i + 1] - L[i + 1]) < 1e-9) continue;   // 隔天開盤鎖漲停 = 買不到
    // 各窗口報酬(進場 T+1 開盤、出場 T+w 收盤)
    const rets = {}; let anyW = false;
    for (const w of WINS) { if (i + w < N) { rets[w] = (C[i + w] / o1 - 1) * 100; anyW = true; } }
    if (!anyW) continue;
    nDay++;
    const g = G_OF(reg);
    for (const w of WINS) if (rets[w] != null) { add(CTL.all[w], rets[w]); add(CTL[g][w], rets[w]); if (g === 'fh') add(CTL[reg][w], rets[w]);
      const rec = { d, x: R[i + w].date, r: rets[w] };
      pushRes(CTLL.all[w], rec, CTL.all[w].n); pushRes(CTLL[g][w], rec, CTL[g][w].n); if (g === 'fh') pushRes(CTLL[reg][w], rec, CTL[reg][w].n); }

    // 特徵(只在需要時算)
    let maxC252prev = NaN, minC252prev = NaN, maxC60prev = NaN, pos252 = NaN, amp20 = NaN;
    { const a = Math.max(0, i - 251); let hi = -Infinity, lo = Infinity;
      for (let q = a; q <= i; q++) { if (C[q] > hi) hi = C[q]; if (C[q] < lo) lo = C[q]; }
      pos252 = hi > lo ? (C[i] - lo) / (hi - lo) * 100 : NaN;
      if (i >= 252) { let h2 = -Infinity, l2 = Infinity; for (let q = i - 252; q < i; q++) { if (C[q] > h2) h2 = C[q]; if (C[q] < l2) l2 = C[q]; } maxC252prev = h2; minC252prev = l2; }
      if (i >= 60) { let h3 = -Infinity; for (let q = i - 60; q < i; q++) if (C[q] > h3) h3 = C[q]; maxC60prev = h3; }
      let s = 0; for (let q = i - 19; q <= i; q++) if (q >= 0 && C[q] > 0) s += (H[q] - L[q]) / C[q]; amp20 = s / 20 * 100; }
    const chg = (C[i] / C[i - 1] - 1) * 100, chgPrev = i >= 2 ? (C[i - 1] / C[i - 2] - 1) * 100 : NaN;
    let max5chg = -Infinity; for (let q = Math.max(1, i - 4); q <= i; q++) max5chg = Math.max(max5chg, (C[q] / C[q - 1] - 1) * 100);
    // 創 60 日高後回測不破(streak_probe:最近 5 根內創過 60 日高,之後最低 ≥ 高點×0.95,今天收紅且收 ≥ 高點×0.98)
    let retest60 = false;
    if (i >= 66) { let nh = -Infinity, nhAt = -1; for (let q = i - 5; q < i; q++) { let h60 = -Infinity; for (let p = q - 60; p < q; p++) if (C[p] > h60) h60 = C[p]; if (C[q] > h60 && C[q] > nh) { nh = C[q]; nhAt = q; } }
      if (nhAt >= 0) { let lowest = Infinity; for (let q = nhAt + 1; q <= i; q++) if (C[q] < lowest) lowest = C[q]; if (lowest >= nh * 0.95 && chg > 0 && C[i] >= nh * 0.98) retest60 = true; } }
    const X = { i, c: C[i], cPrev: C[i - 1], hPrev: H[i - 1], l: L[i], v: V[i], v20: v20[i], amt: C[i] * V[i],
      chg, chgPrev, max5chg, ma5: ma5[i], ma20: ma20[i], ma20prev: ma20[i - 1], rsi: rsi[i], k9: k9[i],
      pos252, amp20, maxC252prev, minC252prev, maxC60prev, retest60,
      ret5: i >= 5 ? (C[i] / C[i - 5] - 1) * 100 : NaN, ret10: i >= 10 ? (C[i] / C[i - 10] - 1) * 100 : NaN,
      ret20: i >= 20 ? (C[i] / C[i - 20] - 1) * 100 : NaN, twr20: TWret20[ti],
      secTop3: !!(ind && SEC_TOP.get(d) && SEC_TOP.get(d).has(ind)) };

    for (const s of STRATS) {
      let hit = false; try { hit = !!s.f(X); } catch (_) {}
      if (!hit) continue;
      const lp = last.get(s.k); if (lp != null && i - lp < DEDUP) continue;
      last.set(s.k, i);
      for (const w of WINS) if (rets[w] != null) {
        const r = rets[w], rec = { d, x: R[i + w].date, r };
        add(EV[s.k].all[w], r); EVL[s.k].all[w].push(rec);
        add(EV[s.k][g][w], r); EVL[s.k][g][w].push(rec);
        if (g === 'fh') { add(EV[s.k][reg][w], r); EVL[s.k][reg][w].push(rec); }
      }
    }
  }
}
console.log(`✅ ${nSym} 檔・對照組 ${nDay.toLocaleString()} 個(股·日)`);

// ── ⑥ 報表 ─────────────────────────────────────────────────────────────
const pct = a => a.n ? a.w / a.n * 100 : NaN;
const mean = a => a.n ? a.sum / a.n : NaN;
const payoff = a => (a.w && a.n - a.w) ? (a.sw / a.w) / (a.sl / (a.n - a.w)) : NaN;
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '—';
const f2 = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—';
// MDD:照進場日排序、一次一筆不重疊、複利
const mdd = list => {
  if (!list.length) return { mdd: NaN, n: 0 };
  const L = list.slice().sort((a, b) => a.d.localeCompare(b.d));
  let eq = 1, peak = 1, dd = 0, n = 0, busyUntil = '';
  for (const t of L) { if (t.d < busyUntil) continue; busyUntil = t.x; n++; eq *= 1 + (t.r - COST) / 100; if (eq > peak) peak = eq; dd = Math.max(dd, (peak - eq) / peak); }
  return { mdd: dd * 100, n };
};

console.log('\n' + '═'.repeat(110));
console.log('⚠️ MDD = 一次一筆、照時間序、複利、每筆扣成本 0.44% —— 交易次數多的策略**天生**回撤大(190 筆各賠 1% 就是 −85%),');
console.log('   ⛔ 拿它比較不同策略要先看 n;「最差10%」(單筆報酬第 10 百分位)才是不受次數影響的下檔尺。');
console.log('📊 對照組(同情境、同窗口、全部可交易的 股·日):勝率 = 抱 w 天報酬 >0 的比例');
console.log('   ⚠️ 這就是規格裡「55%」要對照的基準 —— ⛔ 不是 50%');
for (const g of GROUPS) {
  console.log(`   ${GN[g].padEnd(18, '　')}` + WINS.map(w => { const a = CTL[g][w]; return `${w}日 勝率 ${f1(pct(a))}% 均 ${f2(mean(a))}% 最差10% ${f1(p10(a))}% 序列MDD ${f1(mdd(CTLL[g][w]).mdd)}% (n=${a.n.toLocaleString()})`; }).join(' ｜ '));
}

const OUT = { updated: new Date().toISOString().slice(0, 10), win: `${TWd[0]}~${TWd.at(-1)}`, regDays: regCount, cost: COST, minN: MIN_N,
  groups: GROUPS.map(g => ({ k: g, n: GN[g] })), wins: WINS,
  ctl: Object.fromEntries(GROUPS.map(g => [g, Object.fromEntries(WINS.map(w => [w, { n: CTL[g][w].n, win: +pct(CTL[g][w]).toFixed(1), mean: +mean(CTL[g][w]).toFixed(2), p10: +p10(CTL[g][w]).toFixed(1), mdd: +mdd(CTLL[g][w]).mdd.toFixed(1) }]))])),
  strats: [] };

for (const s of STRATS) {
  console.log('\n' + '─'.repeat(110));
  console.log(`▶ ${s.t}`);
  console.log('   情境              ' + WINS.map(w => `│ ${String(w).padStart(2)}日: n     勝率  盈虧比  均報酬  vs對照  最差10%  MDD`).join(' '));
  const row = { k: s.k, t: s.t, byG: {} };
  for (const g of GROUPS) {
    const cells = WINS.map(w => {
      const a = EV[s.k][g][w], c = CTL[g][w];
      const ex = mean(a) - mean(c), m = mdd(EVL[s.k][g][w]);
      const cm = mdd(CTLL[g][w]);
      return { n: a.n, win: pct(a), pay: payoff(a), mean: mean(a), ex, mdd: m.mdd, mddN: m.n, cwin: pct(c), p10: p10(a), cp10: p10(c), cmdd: cm.mdd };
    });
    row.byG[g] = Object.fromEntries(WINS.map((w, j) => [w, { n: cells[j].n, win: +f1(cells[j].win), pay: Number.isFinite(cells[j].pay) ? +cells[j].pay.toFixed(2) : null,
      mean: Number.isFinite(cells[j].mean) ? +cells[j].mean.toFixed(2) : null, ex: Number.isFinite(cells[j].ex) ? +cells[j].ex.toFixed(2) : null,
      mdd: Number.isFinite(cells[j].mdd) ? +cells[j].mdd.toFixed(1) : null, p10: Number.isFinite(cells[j].p10) ? +cells[j].p10.toFixed(1) : null, cmdd: Number.isFinite(cells[j].cmdd) ? +cells[j].cmdd.toFixed(1) : null, cp10: Number.isFinite(cells[j].cp10) ? +cells[j].cp10.toFixed(1) : null, low: cells[j].n < MIN_N }]));
    console.log(`   ${GN[g].padEnd(9, '　')}` + cells.map(c => `│ ${String(c.n).padStart(6)} ${f1(c.win).padStart(5)}% ${f1(c.pay).padStart(5)}  ${f2(c.mean).padStart(6)}  ${f2(c.ex).padStart(6)}  ${f1(c.p10).padStart(6)}%  ${f1(c.mdd).padStart(5)}%${c.n < MIN_N ? '⚠' : ' '}`).join(' '));
  }
  // ── 判定 ──
  const g20 = g => row.byG[g][20];
  const b = g20('bull'), r = g20('bear'), h = g20('fh'), all = g20('all');
  const three = [b, r, h];
  const lowAny = three.some(x => x.n < MIN_N);
  // 規格標籤(⛔ 門檻照抄,不改)
  let spec, why;
  if (three.every(x => x.win > 55 && x.pay > 1.8)) { spec = '🟢 實測更好'; why = '三情境勝率皆 >55% 且盈虧比 >1.8'; }
  else if (all.mean != null && all.mean - COST < 0) { spec = '⛔ 嚴禁操作'; why = `全時段 20 日均報酬扣成本 ${f2(all.mean - COST)}% <0`; }
  // 🚨 規格的「空頭回撤過大」⛔ 不能用序列 MDD 判:實測**對照組自己**的序列 MDD 就是 38~87%(隨機序列、被交易次數主導),
  //    而且事件多的策略序列更長 → 比對照更差是**必然**(位階低檔在空頭贏對照 +1.65pp,序列 MDD 卻 50.6% vs 38.4%)。
  //    → 改用不受次數影響的下檔尺:**空頭情境單筆最差 10% 比「隨便挑一天」更差 ≥3 個百分點**。⚠️ 這是我對「過大」的明確定義,規格原文沒定義。
  else if (r.p10 != null && r.cp10 != null && r.p10 - r.cp10 <= -3) { spec = '⛔ 嚴禁操作'; why = `空頭情境單筆最差 10% 是 ${f1(r.p10)}%,比「隨便挑一天」的 ${f1(r.cp10)}% 還差 ${f1(r.cp10 - r.p10)}pp`; }
  else if (b.mean > 0 && (r.win < 40 || h.win < 40)) { spec = '🟡 虛胖策略'; why = `只有多頭賺錢(空頭勝率 ${f1(r.win)}% / 盤整高波 ${f1(h.win)}%)→ 需加大盤濾網`; }
  else { spec = '⚪ 不在規格三類裡'; why = `多頭 ${f1(b.win)}% / 空頭 ${f1(r.win)}% / 盤整高波 ${f1(h.win)}%,⛔ 沒有三格**同時**達 55%(規格的 🟢 要三情境都過),但也沒有到嚴禁`; }
  // 本站標準(第二判定):扣成本後贏「同情境對照」且 10/20/40 日同向;⛔ 不看規格的 55%
  const exOK = g => { const c = row.byG[g]; return c[20].ex != null && c[20].ex - COST > 0 && [10, 20, 40].every(w => c[w].ex != null && Math.sign(c[w].ex) === Math.sign(c[20].ex)); };
  const site = ['bull', 'bear', 'fh'].filter(exOK);
  const flip = ['all', 'bull', 'bear', 'fh'].filter(g => { const c = row.byG[g]; const s5 = c[5].ex, s40 = c[40].ex; return s5 != null && s40 != null && Math.sign(s5) !== Math.sign(s40) && Math.abs(s5 - s40) > 0.5; });
  row.spec = spec; row.specWhy = why; row.site = site; row.flip = flip; row.lowAny = lowAny;
  console.log(`   📌 規格判定:${spec} —— ${why}${lowAny ? '  ⚠️ 有情境樣本 <30,容易虛胖' : ''}`);
  console.log(`   📌 本站判定(扣成本後贏同情境對照、10/20/40 日同向):${site.length ? site.map(g => GN[g]).join('、') + ' ✅' : '沒有一個情境過關 ❌'}` +
              (flip.length ? `  🔁 5 日與 40 日結論相反:${flip.map(g => GN[g]).join('、')}` : ''));
  OUT.strats.push(row);
}

if (EMIT) { fs.writeFileSync(EMIT, JSON.stringify(OUT)); console.log(`\n💾 已寫 ${EMIT}(${(fs.statSync(EMIT).size / 1024).toFixed(1)} KB)`); }
