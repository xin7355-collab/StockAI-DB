#!/usr/bin/env node
/**
 * 🔄 景氣循環股該不該「分週期回測」?(V74.6.9)
 *
 * 使用者:「回測證券股、航海股等等,他們不是都有週期性,像這種股不能用全年回測,這樣比較客觀」。
 *
 * ⭐ 他的方法論質疑是對的:整段窗口的平均值會把「產業在高峰」與「產業在谷底」兩種完全不同的
 *   環境混在一起。但要驗它,得先解決一個問題:**「週期位置」要怎麼定義才不會有前視偏誤?**
 *
 * ⛔ 不能用的定義(⛔ 別再提):
 *   ・「事後看哪幾年是景氣高峰」→ 那是**事後才知道**的,回測用它 = 拿答案當條件。
 *   ・「營收 YoY 的位階」→ `fund_yoy_gm.json` 的 qeps 只有 8 季(V74.3.3 已查),算不出位階。
 *   ・`industry_pe.json` 的 `is_cyclical` → 實測 **32 個產業全部是 False**,那個旗標從沒作用過。
 *
 * ⭐ 用得起來的定義:**該產業自己的等權指數,在它自己近一年裡的位階**。
 *   ・當天就算得出來(零前視)・每個產業都有・不需要任何新資料源。
 *   ・語意就是「這個產業現在是在自己的高檔還是低檔」= 可觀測的景氣位置代理。
 *
 * 🚨 對照組必須**共用同一條腿**:在**同一個週期格子裡**比「有沒有符合條件」,
 *   ⛔ 拿全市場當對照,量到的是「那一格好不好」不是「條件有沒有用」。
 *
 * 進場 = 隔天開盤(排除開盤鎖死)・報酬扣同期加權・同檔同格 20 日去重。
 *
 * ⚠️ 誠實限制:證交所 33 大類**沒有「證券」這一類** —— 元大金/群益期那些全在「金融保險(17)」裡,
 *   跟銀行、壽險混在一起。⛔ 所以「證券股的週期」這一題,用官方分類是量不準的。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const IND_NAME = { '01':'水泥','02':'食品','03':'塑膠','04':'紡織','05':'電機機械','06':'電器電纜','08':'玻璃陶瓷','09':'造紙','10':'鋼鐵','11':'橡膠','12':'汽車','14':'建材營造','15':'航運','16':'觀光餐旅','17':'金融','18':'貿易百貨','20':'其他','21':'化學','22':'生技醫療','23':'油電燃氣','24':'半導體','25':'電腦週邊','26':'光電','27':'通信網路','28':'電子零組件','29':'電子通路','30':'資訊服務','31':'其他電子','35':'綠能環保','36':'數位雲端','37':'運動休閒','38':'居家生活' };
const FOCUS = ['15', '17', '10', '03', '01', '24'];    // 使用者點名的 + 典型循環股 + 對照
const HOR = 20;              // 前瞻天數
const COST = 0.44;
const DEDUP = 20;
const MIN_MEMB = 5;
const GENE_POS = 75, GENE_AMP = 3.2;   // 🧬 現行配置(V73.2.3)

// ── 大盤 ──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) { const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); mdays.push(d); } }
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => { const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]); return a > 0 ? (b / a - 1) * 100 : null; };

const indOf = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'));

// ── 讀 K 線 ──
const S = new Map();
for (const sym of Object.keys(indOf)) {
  const f = path.join(DATA, `${sym}.json`);
  if (!fs.existsSync(f)) continue;
  let rows; try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 400) continue;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0);
  if (R.length < 400) continue;
  const o = { d: [], c: [], op: [], hi: [], lo: [], i: new Map() };
  for (const r of R) {
    const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (!d) continue;
    o.i.set(d, o.d.length);
    o.d.push(d); o.c.push(+r.close); o.op.push(+r.open);
    o.hi.push(+r.high || +r.close); o.lo.push(+r.low || +r.close);
  }
  if (o.d.length >= 400) S.set(sym, o);
}
console.log(`\n📊 母體:${S.size} 檔上市股(⚠️ industry_map 只涵蓋上市)`);

// ── ① 每個產業的等權指數(成分股當日報酬中位數累乘)──
const firsts = []; for (const [, o] of S) firsts.push(o.d[0]);
firsts.sort();
const FROM = firsts.length ? firsts[Math.floor(firsts.length * 0.75)] : mdays[0];
const days = mdays.filter(d => d >= FROM);
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };

const indIdx = new Map();          // ind -> { d:[], v:[] }  等權指數
const EW = { d: [], v: [] };       // 全市場等權基準(⭐ 這才是對的分母,理由見下)
for (let di = 1; di < days.length; di++) {
  const D = days[di], P = days[di - 1];
  const by = new Map();
  for (const [sym, o] of S) {
    const i = o.i.get(D), j = o.i.get(P);
    if (i == null || j == null) continue;
    const g = indOf[sym]; if (!g) continue;
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(o.c[i] / o.c[j] - 1);
  }
  for (const [g, arr] of by) {
    if (arr.length < MIN_MEMB) continue;
    if (!indIdx.has(g)) indIdx.set(g, { d: [], v: [] });
    const o = indIdx.get(g);
    o.d.push(D); o.v.push((o.v.length ? o.v[o.v.length - 1] : 100) * (1 + med(arr)));
  }
  // 🚨 全市場**等權**基準(同樣用中位數累乘)—— 見下方「為什麼不能拿加權指數當分母」
  const all = []; for (const arr of by.values()) for (const x of arr) all.push(x);
  if (all.length >= 100) { EW.d.push(D); EW.v.push((EW.v.length ? EW.v[EW.v.length - 1] : 100) * (1 + med(all))); }
}
const ewAt = new Map(EW.d.map((d, i) => [d, EW.v[i]]));
// 🚨🚨 第一版拿「產業指數自己的位階」當週期位置 —— **那是錯的**,而且錯得很好看:
//   等權指數是用**中位數個股**累乘的,而中位數個股本來就長期跑輸市值加權(本站早就量過,
//   基準勝率 36% 不是 50%)→ 這條線會**一路往下漂** → 幾乎每個產業每天都貼著自己一年的低點
//   → 實測「谷底」格 40,374 筆 vs「高峰」格 2,247 筆(差 18 倍)。
//   ⭐ 那不是「台股大部分時間都在景氣谷底」,是**我的尺自己在下沉**。
// 🚨🚨 第二版改用「產業指數 ÷ **加權指數**」—— **還是錯的**,而且錯法一模一樣:
//   加權指數是**市值加權**(台積電約四成),等權中位數指數對它一路跑輸
//   → 每個產業的相對線也一路往下 → 谷底格仍然 42,781 筆 vs 高峰 1,076 筆(差 40 倍)。
//   ⭐⭐ 通用:**分子分母的加權方式不同,比值一定會有系統性漂移** ——
//     那個漂移會假扮成「大家都在谷底」,而且看起來完全合理。
// ⭐ 第三版(正解):分母換成「**全市場等權**指數」(同樣用中位數累乘)→ 分子分母同一種加權,
//   剩下的才是「這個產業相對其他產業現在強還是弱」= 可觀測的景氣位置代理。
const indPos = new Map();          // `${ind}|${date}` -> 0~100
for (const [g, o] of indIdx) {
  const rel = o.v.map((v, i) => { const m = ewAt.get(o.d[i]); return m > 0 ? v / m : null; });
  for (let i = 252; i < o.d.length; i++) {
    const w = rel.slice(i - 251, i + 1).filter(x => x != null);
    if (w.length < 200 || rel[i] == null) continue;
    const hi = Math.max(...w), lo = Math.min(...w);
    indPos.set(`${g}|${o.d[i]}`, hi > lo ? (rel[i] - lo) / (hi - lo) * 100 : 50);
  }
}
console.log(`   產業等權指數:${indIdx.size} 個 ・週期位階樣本 ${indPos.size.toLocaleString()} 個(產業·日)`);

// 📤 EMIT=<path> → 把「產業·日 → 週期位階」倒出來給 `portfolio_backtest.mjs` 當濾網用。
//    ⭐ 刻意用**匯出**而不是在那邊再寫一份 —— ⛔ 兩份實作遲早只改到一邊(陷阱 #37)。
if (process.env.EMIT) {
  const out = {};
  for (const [k, v] of indPos) out[k] = Math.round(v * 10) / 10;
  fs.writeFileSync(process.env.EMIT, JSON.stringify({
    note: '產業等權指數 ÷ 全市場等權指數 的近 252 日位階(0~100);key = `${產業代碼}|${日期}`',
    src: 'scripts/cyclical_probe.mjs', n: indPos.size, pos: out,
  }));
  console.log(`   📤 已匯出 ${indPos.size.toLocaleString()} 筆 → ${process.env.EMIT}`);
}

// ── ② 逐日收事件 ──
const CELL = p => p < 25 ? '谷底(<25)' : p < 50 ? '偏低(25~50)' : p < 75 ? '偏高(50~75)' : '高峰(≥75)';
const CELLS = ['谷底(<25)', '偏低(25~50)', '偏高(50~75)', '高峰(≥75)'];
const bag = new Map();             // key -> []
const put = (k, v) => { if (!bag.has(k)) bag.set(k, []); bag.get(k).push(v); };
const seen = new Map();

for (let di = 252; di < days.length - HOR - 2; di++) {
  const D = days[di];
  for (const [sym, o] of S) {
    const i = o.i.get(D);
    if (i == null || i < 253 || i + HOR + 1 >= o.d.length) continue;
    const g = indOf[sym]; if (!g) continue;
    const ip = indPos.get(`${g}|${D}`); if (ip == null) continue;
    // 個股條件(🧬)
    const w = o.c.slice(i - 251, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    const pos = hi > lo ? (o.c[i] - lo) / (hi - lo) * 100 : 50;
    let amp = 0; for (let q = i - 19; q <= i; q++) amp += Math.abs(o.c[q] / o.c[q - 1] - 1) * 100;
    amp /= 20;
    // 進場 = 隔天開盤(⛔ 排除開盤鎖死)
    const e = o.op[i + 1];
    if (!(e > 0) || e >= o.c[i] * 1.095) continue;
    const ex = o.c[i + 1 + HOR - 1];
    if (!(ex > 0)) continue;
    const mr = mktRet(o.d[i + 1], HOR - 1);
    if (mr == null) continue;
    const r = (ex / e - 1) * 100 - mr;
    const cell = CELL(ip);
    const gene = pos >= GENE_POS && amp >= GENE_AMP;
    const yr = D.slice(0, 4);
    const rec = { r, yr, di, sym, g, gene };
    const kd = k => { const kk = `${k}|${sym}`; const l = seen.get(kk); if (l != null && di - l < DEDUP) return false; seen.set(kk, di); return true; };
    if (kd(`ALL|${cell}`)) put(`ALL|${cell}`, rec);
    if (gene && kd(`GENE|${cell}`)) put(`GENE|${cell}`, rec);
    if (FOCUS.includes(g)) {
      if (kd(`F${g}|${cell}`)) put(`F${g}|${cell}`, rec);
    }
  }
}

const stat = a => {
  if (!a.length) return null;
  const rs = a.map(x => x.r);
  const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
  const win = rs.filter(x => x > 0).length / rs.length * 100;
  return { n: a.length, mean, med: med(rs), win };
};
const byYear = a => { const m = new Map(); for (const x of a) { if (!m.has(x.yr)) m.set(x.yr, []); m.get(x.yr).push(x); } return m; };
const f = v => (v >= 0 ? '+' : '') + v.toFixed(2);

console.log(`\n⚠️ 窗口 ${days[252]} ~ ${days[days.length - HOR - 2]} ・前瞻 ${HOR} 日 ・扣同期加權 ・${DEDUP} 日去重\n`);
console.log('═══ ① 產業自己在週期的哪個位置 → 該產業成分股後 20 日超額 ═══');
console.log('  (⭐ 這一格回答:「整段平均」有沒有把不同環境混在一起)');
console.log('週期位置'.padEnd(16), 'n'.padStart(9), '平均'.padStart(8), '中位'.padStart(8), '勝率'.padStart(7));
const allS = {};
for (const c of CELLS) {
  const s = stat(bag.get(`ALL|${c}`) || []); if (!s) continue;
  allS[c] = s;
  console.log(c.padEnd(16), String(s.n).padStart(9), f(s.mean).padStart(8), f(s.med).padStart(8), (s.win.toFixed(1) + '%').padStart(7));
}

console.log('\n═══ ② 🧬(位階≥75 且 振幅≥3.2)在不同週期位置的**增量** ═══');
console.log('  🚨 對照組 = **同一格裡的所有股票**(⛔ 不是全市場 —— 那會量到「格子好不好」)');
console.log('週期位置'.padEnd(16), 'n'.padStart(8), '🧬平均'.padStart(9), '同格全部'.padStart(9), '增量'.padStart(8), '逐年同向');
for (const c of CELLS) {
  const g = stat(bag.get(`GENE|${c}`) || []), b = allS[c];
  if (!g || !b) continue;
  const yg = byYear(bag.get(`GENE|${c}`) || []), yb = byYear(bag.get(`ALL|${c}`) || []);
  const yrs = [...yg.keys()].filter(y => (yg.get(y) || []).length >= 30 && (yb.get(y) || []).length >= 30).sort();
  const dl = yrs.map(y => stat(yg.get(y)).mean - stat(yb.get(y)).mean);
  const same = dl.length >= 3 ? (dl.every(x => x > 0) ? '✅ 全正' : dl.every(x => x < 0) ? '全負' : '❌ 不同向') : '樣本不足';
  console.log(c.padEnd(16), String(g.n).padStart(8), f(g.mean).padStart(9), f(b.mean).padStart(9),
              f(g.mean - b.mean).padStart(8), ' ' + same + '  ' + yrs.map((y, k) => `${y.slice(2)}:${f(dl[k])}`).join(' '));
}

// ── ②b 二分之後跑完整六道關卡(⭐ 這才是「能不能拿來用」的判準)──
console.log('\n═══ ②b 二分:產業「還沒被追捧(<50)」 vs 「已經在相對高峰(≥50)」 ═══');
const half = lab => {
  const g = [], b = [];
  for (const c of CELLS) {
    const lo = c.startsWith('谷底') || c.startsWith('偏低');
    if (lab === 'lo' ? lo : !lo) { g.push(...(bag.get(`GENE|${c}`) || [])); b.push(...(bag.get(`ALL|${c}`) || [])); }
  }
  return { g, b };
};
for (const [lab, name] of [['lo', '產業還沒被追捧(位階<50)'], ['hi', '產業已在相對高峰(位階≥50)']]) {
  const { g, b } = half(lab);
  const sg = stat(g), sb = stat(b); if (!sg || !sb) continue;
  const edge = sg.mean - sb.mean;
  const yg = byYear(g), yb = byYear(b);
  const yrs = [...yg.keys()].filter(y => (yg.get(y) || []).length >= 50 && (yb.get(y) || []).length >= 50).sort();
  const dl = yrs.map(y => stat(yg.get(y)).mean - stat(yb.get(y)).mean);
  const mid = g.map(x => x.di).sort((a, c) => a - c)[Math.floor(g.length / 2)];
  const h1 = stat(g.filter(x => x.di < mid)), h2 = stat(g.filter(x => x.di >= mid));
  const b1 = stat(b.filter(x => x.di < mid)), b2 = stat(b.filter(x => x.di >= mid));
  const e1 = h1 && b1 ? h1.mean - b1.mean : NaN, e2 = h2 && b2 ? h2.mean - b2.mean : NaN;
  const worstOut = dl.length >= 2 ? (dl.reduce((a, c) => a + c, 0) - Math.max(...dl)) / (dl.length - 1) : NaN;
  console.log(`\n🧬 在「${name}」的產業裡  n=${sg.n}`);
  console.log(`   平均 ${f(sg.mean)} vs 同格全部 ${f(sb.mean)} → 增量 ${f(edge)}pp`);
  console.log(`   前後半 ${f(e1)} / ${f(e2)} ${(e1 > 0 && e2 > 0) || (e1 < 0 && e2 < 0) ? '✅ 同向' : '❌ 不同向'}`);
  console.log(`   逐年 ${yrs.map((y, k) => `${y.slice(2)}:${f(dl[k])}`).join(' ')} ${dl.length >= 3 && dl.every(x => x > 0) ? '✅ 全正' : '❌'}`);
  console.log(`   去最好年 ${f(worstOut)}pp ・扣來回成本 ${COST}% → ${f(edge - COST)}pp`);
}

console.log('\n═══ ③ 使用者點名的產業:逐格明細 ═══');
for (const g of FOCUS) {
  const rows = CELLS.map(c => ({ c, s: stat(bag.get(`F${g}|${c}`) || []) })).filter(x => x.s && x.s.n >= 100);
  if (!rows.length) continue;
  const sp = Math.max(...rows.map(x => x.s.mean)) - Math.min(...rows.map(x => x.s.mean));
  console.log(`\n🏭 ${IND_NAME[g] || g}(${g})　最好與最差的格子差 ${sp.toFixed(2)}pp`);
  for (const { c, s } of rows)
    console.log('   ', c.padEnd(16), String(s.n).padStart(7), '平均', f(s.mean).padStart(7), '・中位', f(s.med).padStart(7), '・勝率', (s.win.toFixed(1) + '%').padStart(6));
}

console.log(`\n⚠️ 證交所 33 大類**沒有「證券」這一類** —— 元大金/群益期那些跟銀行壽險一起放在「金融(17)」,`);
console.log(`   所以上面「金融」那一列 ⛔ 不能當成「證券股的週期」。要單獨測證券要先有次產業分類(本站沒有)。`);
