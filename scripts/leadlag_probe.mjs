#!/usr/bin/env node
/**
 * ⏱️ 時間差交錯相關(TLCC / Lagged Cross-Correlation)—— 評估紀錄㉑
 *
 * 使用者上傳的 Gemini 對話「黑科技 1」:
 *   「關聯星圖現在算的是**同期** 120 日相關;改算 Corr(A[t−k], B[t]),
 *     算出 A 領先 B 幾天,在連線上加箭頭 →『台積電發動,B 股 15~30 天內跟漲』」
 *
 * ⭐ 這個問題本身問得對(⛔ 同期相關再高都不能拿來預測 —— 評估紀錄⑧ 的鐵則),
 *   而且**本站有資料就測得動**(純價格,零新採礦)→ ⛔ 不評估,直接測。
 *
 * 🚨🚨 這題的形狀是「**先從資料學出一組配對,再拿它去預測**」——
 *   跟 V74.x 的「分點同盟集團」一模一樣。那次六道關卡 + 格內對照**全過**,
 *   但只要問一句「換一半資料學,學到的是不是同一批人」→ **重疊率 0% 當場結案**。
 *   ⭐ 所以這支**先報名單穩定度,再談報酬**。
 *
 * ⛔ 三個一定要做的控制:
 *  ① **扣掉當日大盤**(殘差報酬)—— 兩檔都跟大盤走的話,落後相關會是大盤自我相關的副產品
 *     (同 V74.4.8 stock_tags:不扣大盤的話多頭裡每一檔都跟每個題材高相關)。
 *  ② **對照組 = 同期相關**(k=0)—— 落後相關要**贏過**它才有「領先」可言。
 *  ③ **安慰劑 = 環狀位移**(把 B 的序列整體平移)—— 疏密結構不變,只打亂對齊
 *     (同 calendar_stock_probe 的教訓:隨機抽會讓集中型事件天生佔便宜)。
 *
 * 🚨 報酬那段:進場一律**隔天開盤**(事件當天收盤才知道 A 動了),排除開盤鎖死,扣同期加權 + 成本。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const COST = 0.44;
const LAGS = 10;              // 測 k = 1..10 個交易日
const MINBARS = 500;
const TOPN = 400;             // 母體:成交金額前 N 檔(⛔ 冷門股的相關係數是雜訊)

const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);

// ── 大盤 ──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map();
for (const r of twii) mkt.set(norm(r.date), +r.close);
const mdays = [...mkt.keys()].sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet1 = new Map();     // 大盤當日報酬%
for (let i = 1; i < mdays.length; i++) {
  const a = mkt.get(mdays[i - 1]), b = mkt.get(mdays[i]);
  if (a > 0) mktRet1.set(mdays[i], (b / a - 1) * 100);
}
const mktRet = (d, n) => {
  const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]);
  return a > 0 ? (b / a - 1) * 100 : null;
};

// ── 載入個股 ──
console.log('📥 載入…');
const files = fs.readdirSync(DATA).filter(f => /^\d{4,6}\.json$/.test(f));
const S = new Map();           // sym → { d:[日期], c:[收], o:[開], hi, lo, r:[殘差報酬%], amt }
for (const f of files) {
  const sym = f.replace('.json', '');
  if (/^00/.test(sym)) continue;                       // ⛔ ETF 不列入(它裝著成分股,相關高是必然)
  let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(raw) || raw.length < MINBARS) continue;
  const d = [], c = [], o = [], hi = [], lo = [], vol = [];
  for (const b of raw) {
    const dd = norm(b.date), cc = +b.close;
    if (!dd || !(cc > 0) || !mkt.has(dd)) continue;
    d.push(dd); c.push(cc); o.push(+b.open || cc); hi.push(+b.high || cc); lo.push(+b.low || cc);
    vol.push(+b.volume || 0);
  }
  if (d.length < MINBARS) continue;
  // 殘差報酬% = 個股當日報酬 − 大盤當日報酬
  const r = new Float64Array(d.length); r[0] = NaN;
  for (let i = 1; i < d.length; i++) {
    const m = mktRet1.get(d[i]);
    r[i] = (m == null) ? NaN : (c[i] / c[i - 1] - 1) * 100 - m;
  }
  // 近一年日均成交金額(元)—— 當母體門檻
  let s = 0, n = 0;
  for (let i = Math.max(0, d.length - 240); i < d.length; i++) { s += c[i] * vol[i]; n++; }
  S.set(sym, { d, c, o, hi, lo, r, amt: n ? s / n : 0, idx: new Map(d.map((x, i) => [x, i])) });
}
const uni = [...S.entries()].sort((a, b) => b[1].amt - a[1].amt).slice(0, TOPN).map(x => x[0]);
console.log(`   讀到 ${S.size} 檔 → 母體取成交金額前 ${uni.length} 檔`);

// ── 共同日期軸 ──
const allD = mdays.filter(d => S.get(uni[0]).idx.has(d));
const days = mdays.slice(mdays.indexOf(allD[0]));
console.log(`   窗口 ${days[0]} ~ ${days[days.length - 1]}(${days.length} 個交易日)`);
const MID = Math.floor(days.length / 2);
const dayIdx = new Map(days.map((d, i) => [d, i]));

// 每檔對齊到共同軸的殘差報酬(缺的補 NaN)
const R = new Map();
for (const sy of uni) {
  const s = S.get(sy), a = new Float64Array(days.length).fill(NaN);
  for (let i = 0; i < days.length; i++) { const j = s.idx.get(days[i]); if (j != null) a[i] = s.r[j]; }
  R.set(sy, a);
}

// ── 相關係數(指定區間、指定 lag:corr(A[t−k], B[t]))──
function corrLag(a, b, k, i0, i1) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = Math.max(i0, k + 1); i < i1; i++) {
    const x = a[i - k], y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 60) return null;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  if (!(va > 0) || !(vb > 0)) return null;
  return cov / Math.sqrt(va * vb);
}

// ── ① 先問:落後相關到底存不存在(對照同期)──
console.log('\n⏱️ ① 落後相關 vs 同期相關(母體 = 星圖已收錄的高相關對)');
let starPairs = [];
try {
  const TC = JSON.parse(fs.readFileSync(path.join(DATA, 'top_correlations.json'), 'utf8'));
  for (const [a, list] of Object.entries(TC.r || {})) {
    if (!R.has(a)) continue;
    for (const [b] of list) if (R.has(b) && a !== b) starPairs.push([a, b]);
  }
} catch { }
if (!starPairs.length) {                                  // 沒有那份檔就自己挑同期最像的
  for (let i = 0; i < uni.length; i++) for (let j = 0; j < uni.length; j++) {
    if (i === j) continue;
    starPairs.push([uni[i], uni[j]]);
  }
  starPairs = starPairs.slice(0, 4000);
}
console.log(`   有向配對 ${starPairs.length} 組`);

const med = arr => { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
const stat = {};
for (let k = 0; k <= LAGS; k++) {
  const v = [];
  for (const [a, b] of starPairs) { const c = corrLag(R.get(a), R.get(b), k, 1, days.length); if (c != null) v.push(c); }
  stat[k] = { med: med(v), n: v.length, p90: (() => { const s = v.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.9)] : NaN; })() };
}
console.log('   k(交易日) │ 相關中位 │ 第90百分位 │ n');
for (let k = 0; k <= LAGS; k++)
  console.log(`   ${k === 0 ? ' 0(同期)' : String(k).padStart(7)} │ ${stat[k].med.toFixed(4).padStart(8)} │ ${stat[k].p90.toFixed(4).padStart(10)} │ ${stat[k].n}`);

// ── ② 名單穩定度:前半段學到的「A 領先 B k 天」,後半段還在嗎 ──
console.log('\n🧲 ② 名單穩定度(⭐ 這一關比報酬更快、更決定性)');
function bestLag(a, b, i0, i1) {
  let bk = 0, bv = 0;
  for (let k = 1; k <= LAGS; k++) {
    const c = corrLag(a, b, k, i0, i1);
    if (c != null && Math.abs(c) > Math.abs(bv)) { bv = c; bk = k; }
  }
  return { k: bk, v: bv };
}
const TH = 0.25;                                          // 「算得上領先」的門檻
const learn = (i0, i1) => {
  const m = new Map();
  for (const [a, b] of starPairs) {
    const r = bestLag(R.get(a), R.get(b), i0, i1);
    if (r.k && Math.abs(r.v) >= TH) m.set(a + '>' + b, r);
  }
  return m;
};
const A = learn(1, MID), B = learn(MID, days.length);
const inter = [...A.keys()].filter(k => B.has(k));
const sameK = inter.filter(k => A.get(k).k === B.get(k).k);
const uni2 = new Set([...A.keys(), ...B.keys()]);
console.log(`   前半學到 ${A.size} 組 ・後半學到 ${B.size} 組 ・兩段都出現 ${inter.length} 組`);
console.log(`   → 名單重疊率(Jaccard) ${(uni2.size ? inter.length / uni2.size * 100 : 0).toFixed(1)}%` +
            `  ・其中「領先天數也一樣」的 ${sameK.length} 組`);
// 隨機期望:兩邊各抽 |A|、|B| 組
const expJ = (A.size * B.size / starPairs.length) / (A.size + B.size - A.size * B.size / starPairs.length);
console.log(`   🆚 隨機期望重疊率 ${(expJ * 100).toFixed(1)}%(兩邊各自從 ${starPairs.length} 組裡挑)`);

// ── ③ 安慰劑:把 B 的序列環狀位移 137 天(疏密結構不變,只打亂對齊)──
const SHIFT = 137;
const Rp = new Map();
for (const [sy, a] of R) { const b = new Float64Array(a.length); for (let i = 0; i < a.length; i++) b[i] = a[(i + SHIFT) % a.length]; Rp.set(sy, b); }
const pv = [];
for (const [a, b] of starPairs) { const c = corrLag(R.get(a), Rp.get(b), 1, 1, days.length); if (c != null) pv.push(c); }
console.log(`\n🧪 ③ 安慰劑(B 環狀位移 ${SHIFT} 天)k=1 相關中位 ${med(pv).toFixed(4)}` +
            `  🆚 真的 k=1 是 ${stat[1].med.toFixed(4)}`);

// ── ④ 報酬:A 大漲之後,B 在 k 天後跟漲嗎(進場 = 隔天開盤)──
console.log('\n💰 ④ 事件研究:A 殘差大漲 ≥5% → B 在往後 k 天的超額報酬(進場=隔天開盤)');
const HOR = [3, 5, 10, 20];
function fwd(sy, dayI, n) {                               // 隔天開盤買、n 個交易日後收盤賣(扣同期加權)
  const s = S.get(sy); const d0 = days[dayI];
  const j = s.idx.get(d0); if (j == null || j + 1 + n >= s.d.length) return null;
  const op = s.o[j + 1];
  if (!(op > 0)) return null;
  if (Math.abs(op / s.c[j] - 1) > 0.095 && s.hi[j + 1] === s.lo[j + 1]) return null;   // 開盤鎖死 → 買不到
  const ex = (s.c[j + 1 + n] / op - 1) * 100;
  const m = mktRet(s.d[j + 1], n);
  return m == null ? null : ex - m;
}
// 🚨 對照組必須是**同一批 B 股票**、同一段期間、不看條件 ——
//    ⛔ 拿別的母體(例如成交金額前 120 檔)當對照,量到的是「哪些股票比較好」不是「A 大漲有沒有用」。
const bSet = [...new Set(starPairs.map(x => x[1]))];
const ctrl = {}; HOR.forEach(h => ctrl[h] = []);
for (const sy of bSet) {
  for (let i = 250; i < days.length - 25; i += 5) { for (const h of HOR) { const x = fwd(sy, i, h); if (x != null) ctrl[h].push(x); } }
}
const evt = {}; HOR.forEach(h => evt[h] = []);
const evtK = {};
for (const k of [1, 3, 5]) { evtK[k] = {}; HOR.forEach(h => evtK[k][h] = []); }
let nEvt = 0;
const dedup = new Map();
for (const [a, b] of starPairs) {
  const ra = R.get(a);
  for (let i = 250; i < days.length - 25; i++) {
    if (!(ra[i] >= 5)) continue;                          // A 當天殘差大漲 ≥5%
    const key = b + '@' + Math.floor(i / 10);
    if (dedup.has(key)) continue; dedup.set(key, 1);
    nEvt++;
    for (const k of [1, 3, 5]) {
      const j = i + k; if (j >= days.length - 25) continue;
      for (const h of HOR) { const x = fwd(b, j, h); if (x != null) evtK[k][h].push(x); }
    }
  }
}
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
console.log(`   事件 ${nEvt} 筆(同一檔 B 每 10 日去重)・對照組 ${ctrl[10].length} 筆`);
console.log('   進場延遲 │ ' + HOR.map(h => `${h}日`.padStart(9)).join(' │ '));
console.log('   (對照組) │ ' + HOR.map(h => avg(ctrl[h]).toFixed(2).padStart(9)).join(' │ '));
for (const k of [1, 3, 5])
  console.log(`   A 之後 ${k} 天 │ ` + HOR.map(h => {
    const e = avg(evtK[k][h]) - avg(ctrl[h]);
    return `${e >= 0 ? '+' : ''}${e.toFixed(2)}pp`.padStart(9);
  }).join(' │ '));
console.log(`\n   ⚠️ 來回成本 ${COST}% —— 上表任何一格要 > ${COST} 才談得上「可交易」`);

// ── ⑤ 直接測他舉的例子:**上游題材 → 下游題材**(⛔ 不是隨便兩檔高相關的股票)──
//    ⭐ 題材與上下游關係讀 pro.html 的 THEMES / CHAIN_FLOW(⛔ 不在探針裡再抄一份名單)
console.log('\n🏭 ⑤ 上游題材 → 下游題材(他舉的「台積電領先封測廠」就是這一類)');
const PH = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const THEME = {};
for (const m of PH.matchAll(/\{\s*k:\s*'([a-z0-9]+)'\s*,\s*n:\s*'([^']+)'[\s\S]{0,400}?syms:\s*\[([^\]]*)\]/g))
  THEME[m[1]] = { n: m[2], syms: m[3].split(',').map(x => x.replace(/['\s]/g, '')).filter(Boolean) };
const FLOWm = PH.match(/CHAIN_FLOW:\s*\[([\s\S]*?)\n\s*\]/);
const FLOW = FLOWm ? [...FLOWm[1].matchAll(/\['([a-z0-9]+)',\s*'([a-z0-9]+)'\]/g)].map(m => [m[1], m[2]]) : [];
console.log(`   讀到 ${Object.keys(THEME).length} 個題材 ・${FLOW.length} 條上下游關係`);
if (FLOW.length) {
  const chainPairs = [];
  for (const [up, dn] of FLOW) {
    for (const a of (THEME[up] || {}).syms || []) for (const b of (THEME[dn] || {}).syms || [])
      if (R.has(a) && R.has(b) && a !== b) chainPairs.push([a, b]);
  }
  console.log(`   上游→下游配對 ${chainPairs.length} 組`);
  if (chainPairs.length >= 20) {
    console.log('   k(交易日) │ 相關中位 │ 第90百分位');
    for (let k = 0; k <= 5; k++) {
      const v = [];
      for (const [a, b] of chainPairs) { const c = corrLag(R.get(a), R.get(b), k, 1, days.length); if (c != null) v.push(c); }
      const sv = v.slice().sort((x, y) => x - y);
      console.log(`   ${k === 0 ? ' 0(同期)' : String(k).padStart(7)} │ ${med(v).toFixed(4).padStart(8)} │ ${(sv[Math.floor(sv.length * 0.9)] ?? NaN).toFixed(4).padStart(10)}`);
    }
    // 反向對照:下游 → 上游(⭐ 如果「上游領先」是真的,反向應該明顯比較弱)
    const rev = [];
    for (const [a, b] of chainPairs) { const c = corrLag(R.get(b), R.get(a), 1, 1, days.length); if (c != null) rev.push(c); }
    const fwdv = [];
    for (const [a, b] of chainPairs) { const c = corrLag(R.get(a), R.get(b), 1, 1, days.length); if (c != null) fwdv.push(c); }
    console.log(`   🔁 k=1 上游→下游 ${med(fwdv).toFixed(4)}  🆚  下游→上游 ${med(rev).toFixed(4)}` +
                `  → 差 ${(med(fwdv) - med(rev)).toFixed(4)}(⭐ 真的有方向性的話這個差要明顯 > 0)`);
  }
}

// ── ⑥ 🚨 增量檢定:知道「A 漲了」有沒有比「B 自己漲了」多給一點東西 ──
//    ⭐ 這一關才是關鍵:A 與 B 是**高相關**的兩檔 → A 大漲那天 B 多半也漲了,
//      而「B 自己剛大漲」本來就有動能效應(本站實測 追強 > 抄底)。
//      ⛔ 不做這一關的話,會把「B 的動能」誤讀成「A 領先 B」。
console.log('\n🚨 ⑥ 增量檢定:A 漲了、但 B 自己**沒有**漲 —— 這才是「領先」的純樣本');
const grp = { both: {}, onlyA: {}, onlyB: {} };
for (const g of Object.keys(grp)) HOR.forEach(h => grp[g][h] = []);
const yrOf = d => d.slice(0, 4);
const byYear = { onlyA: {}, onlyB: {} };
const halves = { onlyA: [[], []], onlyB: [[], []] };
const dd2 = new Map();
for (const [a, b] of starPairs) {
  const ra = R.get(a), rb = R.get(b);
  for (let i = 250; i < days.length - 25; i++) {
    const aUp = ra[i] >= 5, bUp = rb[i] >= 5;
    if (!aUp && !bUp) continue;
    const g = aUp && bUp ? 'both' : aUp ? 'onlyA' : 'onlyB';
    const key = g + b + '@' + Math.floor(i / 10);
    if (dd2.has(key)) continue; dd2.set(key, 1);
    const j = i + 3;                                        // 統一用「A 之後 3 天」進場(上表最好的那格附近)
    if (j >= days.length - 25) continue;
    for (const h of HOR) { const x = fwd(b, j, h); if (x != null) grp[g][h].push(x); }
    if (g !== 'both') {
      const x20 = fwd(b, j, 20);
      if (x20 != null) {
        const y = yrOf(days[i]); (byYear[g][y] = byYear[g][y] || []).push(x20);
        halves[g][i < MID ? 0 : 1].push(x20);
      }
    }
  }
}
console.log('   情境                     │ ' + HOR.map(h => `${h}日`.padStart(9)).join(' │ ') + ' │ n');
const show = (lbl, g) => console.log(`   ${lbl.padEnd(22)} │ ` +
  HOR.map(h => { const e = avg(grp[g][h]) - avg(ctrl[h]); return `${e >= 0 ? '+' : ''}${e.toFixed(2)}pp`.padStart(9); }).join(' │ ') +
  ` │ ${grp[g][20].length}`);
show('A漲 且 B也漲', 'both');
show('⭐ A漲 但 B沒漲(領先)', 'onlyA');
show('🆚 B自己漲(A沒漲)', 'onlyB');
for (const g of ['onlyA', 'onlyB']) {
  const ys = Object.keys(byYear[g]).sort();
  console.log(`   ${g === 'onlyA' ? '⭐ A漲B沒漲' : '🆚 B自己漲'} 逐年(20日,已扣對照 ${avg(ctrl[20]).toFixed(2)}):` +
    ys.map(y => `${y} ${(avg(byYear[g][y]) - avg(ctrl[20]) >= 0 ? '+' : '')}${(avg(byYear[g][y]) - avg(ctrl[20])).toFixed(2)}`).join(' ・'));
  console.log(`      前後半:${(avg(halves[g][0]) - avg(ctrl[20])).toFixed(2)}pp / ${(avg(halves[g][1]) - avg(ctrl[20])).toFixed(2)}pp`);
}
