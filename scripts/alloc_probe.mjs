#!/usr/bin/env node
/**
 * 🧺 兩種資產配置(領息存股型 vs 資本利得型)+「定期再平衡」到底有沒有用
 *   —— V74.7.1,外部參考資料評估紀錄⑲
 *
 * 使用者上傳的 Gemini 對話給了兩套配置(只給**類別權重**,沒給代號):
 *   A 領息存股型:50% 高股息ETF + 30% 金融/電信 + 20% 低波高息
 *   B 資本利得型:50% 市值型ETF + 30% 半導體/科技 + 20% 政策題材
 *   並主張「每半年或每年底檢視一次、把偏離的權重調回來」。
 *
 * ⭐⭐ 三件本站必做、而那份對話沒做的事:
 *   ① **含息** —— 本站以前所有「買了放著」都是不含息的,高股息那族被系統性低估
 *      (V74.4.1 實測 0056 年化 +18.5% → 含息 +31.7%)。走共用的 `trSeries()`。
 *   ② **對照組** —— ⛔ 不可只報「這套配置賺多少」,一定要跟「100% 0050 買了放著」比。
 *   ③ **再平衡從來沒被測過** —— 本站測過的是「擇時」(全部少賺);
 *      再平衡是不同的東西(不擇時、只把權重調回去),值得單獨驗。
 *
 * ⚠️ 代號是**我挑的**(對話只給類別)→ 每一類各跑兩組不同代號,
 *   ⭐ 若兩組結論不同,那就代表結論是被選股決定的、⛔ 不是配置決定的。
 */
import fs from 'fs';
import { loadPx, trSeries, d10 } from './lib_totalreturn.mjs';

const DATA = process.env.DATA_DIR || 'data';
const CAP = 1_000_000;                 // 本金 100 萬(跟全站其他回測同口徑)
const FROM = process.env.FROM || '2021-01-04';
const DIVP = `${DATA}/dividends_hist.json`;
if (!fs.existsSync(DIVP)) { console.error(`🚨 找不到 ${DIVP} → ⛔ 直接停(不含息的結論會把高股息那族低估一大截)`); process.exit(1); }
const _divRaw = JSON.parse(fs.readFileSync(DIVP, 'utf8'));
// ⚠️ 這個檔的股利在 `d` 底下(頂層還有 updated/n/caveat)—— ⛔ 直接當成 {sym:...} 用會**靜默**變成不含息
const DIV = _divRaw.d || _divRaw;
if (!DIV['0050'] || !(DIV['0050'].h || []).length) { console.error('🚨 股利檔讀不到 0050 的紀錄 → ⛔ 停(不含息的結論會騙人)'); process.exit(1); }
console.log(`💰 股利檔:${Object.keys(DIV).length} 檔 ・ ${_divRaw.from || '?'} 起`);

// ── 配置(每一類兩組代號,⭐ 用來驗結論不是被選股決定的)──
const PORT = {
  'A1 領息存股型': [['0056', .5], ['2412', .15], ['2881', .15], ['00713', .2]],
  'A2 領息存股型(換代號)': [['00878', .5], ['2885', .15], ['2412', .15], ['00713', .2]],
  'B1 資本利得型': [['0050', .5], ['2330', .15], ['2454', .15], ['1519', .2]],
  'B2 資本利得型(換代號)': [['0050', .5], ['2330', .15], ['3231', .15], ['2308', .2]],
  '🆚 100% 0050(對照)': [['0050', 1]],
  '🆚 50% A1 + 50% B1': null,          // 事後合成
};

// ── 逐檔含息日線 ──
const S = new Map();
for (const w of Object.values(PORT)) for (const [s] of (w || [])) {
  if (S.has(s)) continue;
  const bars = loadPx(DATA, s);
  if (!bars) { console.error(`🚨 ${s} 讀不到 K 線 → ⛔ 停`); process.exit(1); }
  const cut = bars.filter(b => b.d >= FROM);
  if (cut.length < 500) { console.error(`🚨 ${s} 只有 ${cut.length} 根(< 500)→ ⛔ 停,窗口對不齊的比較沒有意義`); process.exit(1); }
  const dv = (DIV[s] || {}).h || [];
  S.set(s, { bars: cut, tr: trSeries(cut, dv), px: trSeries(cut, []) });   // px = 不含息(同一支函式,divs 給空)
}
// 共同交易日(⛔ 取交集,不可用其中一檔的日期軸)
let days = null;
for (const [, o] of S) { const set = new Set(o.tr.d); days = days ? days.filter(d => set.has(d)) : o.tr.d.slice(); }
console.log(`\n📊 窗口 ${days[0]} ~ ${days[days.length - 1]}(${days.length} 個交易日 / ${(days.length / 244).toFixed(1)} 年)・本金 ${CAP.toLocaleString()}・含息`);
console.log(`   ⭐ 含 2022 那次空頭(0050 當年 −24%)`);

const idxOf = new Map(days.map((d, i) => [d, i]));
const ser = (s, inc) => { const o = S.get(s), t = inc ? o.tr : o.px, m = new Map(t.d.map((d, i) => [d, t.v[i]])); return days.map(d => m.get(d)); };

/** 跑一組配置。reb: 0=不再平衡 / 122=每半年 / 244=每年 */
function run(weights, reb, inc = true) {
  const V = weights.map(([s]) => ser(s, inc));
  let sh = weights.map(([, w], k) => CAP * w / V[k][0]);        // 各成分的「單位數」
  const eq = [], yr = {};
  let peak = 0, mdd = 0, last = 0;
  for (let i = 0; i < days.length; i++) {
    let tot = 0; for (let k = 0; k < V.length; k++) tot += sh[k] * V[k][i];
    eq.push(tot);
    if (tot > peak) peak = tot;
    mdd = Math.min(mdd, tot / peak - 1);
    const y = days[i].slice(0, 4);
    if (yr[y] === undefined) { yr[y] = { s: last || tot, e: tot }; } else yr[y].e = tot;
    last = tot;
    if (reb && i > 0 && i % reb === 0) sh = weights.map(([, w], k) => tot * w / V[k][i]);
  }
  const end = eq[eq.length - 1];
  const yrs = days.length / 244;
  return {
    end, net: end - CAP, mdd: mdd * 100,
    cagr: (Math.pow(end / CAP, 1 / yrs) - 1) * 100,
    byYear: Object.fromEntries(Object.entries(yr).map(([y, o]) => [y, (o.e / o.s - 1) * 100])),
  };
}

const wOf = k => PORT[k];
const mix = (a, b) => [...wOf(a).map(([s, w]) => [s, w / 2]), ...wOf(b).map(([s, w]) => [s, w / 2])];
PORT['🆚 50% A1 + 50% B1'] = mix('A1 領息存股型', 'B1 資本利得型');

const YRS = [...new Set(days.map(d => d.slice(0, 4)))].sort();
const f = (v, n = 1) => (v >= 0 ? '+' : '') + v.toFixed(n);

console.log('\n═══ ① 兩種配置 vs 買 0050 放著(含息・不再平衡) ═══\n');
console.log('  ' + '配置'.padEnd(26) + '最終資產'.padStart(12) + '淨賺'.padStart(11) + '年化'.padStart(8) + '最大回撤'.padStart(10) + '   逐年 %');
const base = run(wOf('🆚 100% 0050(對照)'), 0);
for (const [k, w] of Object.entries(PORT)) {
  const r = run(w, 0);
  console.log('  ' + k.padEnd(26) + Math.round(r.end).toLocaleString().padStart(12)
    + Math.round(r.net).toLocaleString().padStart(11) + (f(r.cagr) + '%').padStart(8)
    + (r.mdd.toFixed(1) + '%').padStart(10)
    + '   ' + YRS.map(y => `${y.slice(2)}:${f(r.byYear[y] ?? 0, 0)}`).join(' '));
}
console.log(`\n  🆚 對照(100% 0050 買了放著)淨賺 ${Math.round(base.net).toLocaleString()} 元`);

console.log('\n═══ ② 含息 vs 不含息(⭐ 這一欄就是為什麼以前的數字會低估高股息) ═══\n');
console.log('  ' + '配置'.padEnd(26) + '不含息年化'.padStart(12) + '含息年化'.padStart(11) + '差'.padStart(9));
for (const [k, w] of Object.entries(PORT)) {
  const a = run(w, 0, false), b = run(w, 0, true);
  console.log('  ' + k.padEnd(26) + (f(a.cagr) + '%').padStart(12) + (f(b.cagr) + '%').padStart(11)
    + (f(b.cagr - a.cagr) + 'pp').padStart(9));
}

console.log('\n═══ ③ 「定期再平衡」有沒有用(⭐ 本站從來沒測過) ═══');
console.log('  ⛔ 再平衡 ≠ 擇時:它不判斷多空,只把漲多的那塊賣一點、補給跌的那塊\n');
console.log('  ' + '配置'.padEnd(26) + '不再平衡'.padStart(12) + '每半年'.padStart(12) + '每年'.padStart(12) + '   回撤(不/半/年)');
for (const [k, w] of Object.entries(PORT)) {
  if (w.length < 2) continue;
  const a = run(w, 0), b = run(w, 122), c = run(w, 244);
  console.log('  ' + k.padEnd(26) + Math.round(a.net).toLocaleString().padStart(12)
    + Math.round(b.net).toLocaleString().padStart(12) + Math.round(c.net).toLocaleString().padStart(12)
    + `   ${a.mdd.toFixed(1)} / ${b.mdd.toFixed(1)} / ${c.mdd.toFixed(1)}%`);
}

console.log('\n═══ ④ 權重漂移:不再平衡的話,最後變成什麼樣子 ═══');
console.log('  ⭐ 這一段解釋 ③ 為什麼會有差 —— ⛔ 不是「再平衡比較會賺」,是**集中度**變了\n');
for (const [k, w] of Object.entries(PORT)) {
  if (w.length < 2) continue;
  const V = w.map(([s]) => ser(s, true));
  const sh = w.map(([, x], j) => CAP * x / V[j][0]);
  const last = days.length - 1;
  let tot = 0; for (let j = 0; j < V.length; j++) tot += sh[j] * V[j][last];
  console.log('  ' + k.padEnd(26) + w.map(([s, x], j) =>
    `${s} ${(x * 100).toFixed(0)}%→${(sh[j] * V[j][last] / tot * 100).toFixed(0)}%`).join(' ・ '));
}

console.log('\n═══ ⑤ 判定 ═══\n');
{
  const b = run(wOf('🆚 100% 0050(對照)'), 0);
  const rows2 = ['A1 領息存股型', 'A2 領息存股型(換代號)', 'B1 資本利得型', 'B2 資本利得型(換代號)']
    .map(k => ({ k, r: run(PORT[k], 0), reb: [run(PORT[k], 0), run(PORT[k], 122), run(PORT[k], 244)] }));
  for (const x of rows2) {
    const d = x.r.net - b.net;
    console.log('  ' + x.k.padEnd(26) + `vs 0050 ${d >= 0 ? '+' : ''}${Math.round(d).toLocaleString()} 元`.padEnd(26)
      + `回撤 ${x.r.mdd.toFixed(1)}% vs ${b.mdd.toFixed(1)}%   ${d > 0 ? '⭐ 贏' : '❌ 輸'}`);
  }
  const best = rows2.map(x => { const n = x.reb.map(z => z.net); return n.indexOf(Math.max(...n)); });
  const lbl = ['不再平衡', '每半年', '每年'];
  console.log('\n  🔁 再平衡:四組各自最好的頻率 = ' + best.map((i, j) => `${rows2[j].k.slice(0, 2)}→${lbl[i]}`).join(' ・ '));
  console.log('     ' + (new Set(best).size === 1
    ? '⭐ 四組一致 → 可能是機制'
    : '🚨 **四組不一致** → ⛔ 量不出一致的邊際,那些差額是各組成分自己的走勢決定的,不是再平衡的功勞'));
  const dd = rows2.map(x => Math.max(x.reb[1].mdd, x.reb[2].mdd) - x.reb[0].mdd);   // 正 = 回撤變小
  console.log(`  🔁 但**回撤**四組全部變小(改善 ${dd.map(v => '+' + v.toFixed(1)).join(' / ')} pp)→ 那才是再平衡真正在做的事`);
  console.log('  🚨 而 B1 那 22.8pp 的改善其實在講同一件事:不再平衡的話 1519 會從 20% 膨脹到 47%,');
  console.log('     ⛔ 那時候整個組合已經不是「配置」而是「押一檔」了 —— 再平衡的作用是**不讓它變成那樣**。');
}

console.log('\n' + '═'.repeat(96));
console.log('🧭 怎麼讀 / ⛔ 限制');
console.log('   ⭐ 主判準是「跟 100% 0050 買了放著比」,⛔ 不是看它自己賺不賺。');
console.log('   ⚠️ 代號是**我挑的**(那份對話只給類別權重)→ 每一類看 1/2 兩組是否同向;');
console.log('      不同向就代表結論是被**選股**決定的,⛔ 不是被配置決定的。');
console.log('   ⚠️ ⛔ 沒扣二代健保補充保費與股利所得稅 → 領息型的實際到手更少。');
console.log('   ⚠️ 再平衡的手續費/證交稅⛔ 沒扣(每次調整都要真的買賣)→ 那一欄是**上限**。');
console.log('   ⚠️ 窗口 5.6 年只有 2022 一次空頭;⛔ 不可外推。');
