#!/usr/bin/env node
/**
 * 🐢 長期持有 × 多空切換 × 逐年績效(V74.3.2)
 *
 * 使用者四個問題:
 *   ① 回測台積電績效
 *   ② 「現在都是講買而已沒有賣」→ **出場規則**到底有沒有用
 *   ③ 多頭要買什麼(含「ETF 漲比較快」)?空頭是**止損換現金**、等好時機**一次全投入**嗎?
 *   ④ 有沒有說錯 / 推薦的回測方式(含混合)
 *
 * ⛔ 五條設計(⛔ 別改掉,每一條都是踩過的坑):
 *  ① **同一段窗口、同一筆本金** —— 不同標的的資料長度不一樣,⛔ 一律裁到**共同窗口**再比,
 *     否則「2330 賺比較多」可能只是它的窗口比較長(V73.2.9 對照組期間沒對齊那次)。
 *  ② **買賣成本要分開** —— ETF 賣出證交稅 **0.1%**、個股 **0.3%**,⛔ 不可用同一個數字
 *     (擇時策略換手多,這個差別會被放大)。
 *  ③ 🚨 **先驗資料有沒有斷崖再跑** —— `00631L`(正2)實測有 ×22.8 與 ×0.045 兩個斷崖
 *     (V74.4.7 已記載),拿它跑會得到 +6753% 這種垃圾。⛔ 壞的一律排除,並在報告裡說出來。
 *  ④ **「在市場的時間」要印** —— 擇時策略常常是「錢沒進場所以沒賠」,那不是本事;
 *     ⭐ 只看報酬會把「空手」誤讀成「避開下跌」。
 *  ⑤ **逐年報酬一定要印** —— 使用者明確要求,而且本專案已經三次被「窗口長度翻轉結論」咬到。
 *
 * ⚠️ 一律**不含股息**(資料源沒有配息紀錄)→ 高股息 ETF(0056/00878)會被系統性低估,
 *    報告裡要寫出來,⛔ 不可拿這裡的數字說「高股息比較差」。
 *
 * 用法:node scripts/hold_switch_probe.mjs
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const CAP = 1_000_000;                 // 本金
const FEE = 0.001425 * 0.6;            // 手續費 6 折
const TAX_ETF = 0.001, TAX_STK = 0.003;

const load = sym => {
  const p = path.join(DATA, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  let r; try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const R = (r || []).filter(x => x && +x.close > 0).map(x => ({
    d: String(x.date || '').replace(/\//g, '-').slice(0, 10), c: +x.close,
  })).filter(x => x.d);
  R.sort((a, b) => a.d < b.d ? -1 : 1);
  return R.length ? R : null;
};

// 🚧 斷崖守門(⛔ 沒有這條會跑出垃圾數字)
// 🚨 V74.3.3 修:第一版**只看價格比值**,把「資料有大洞」誤判成斷崖 ——
//    實測 006208 / 0051 / 0052 / 00692 在 `data/` 裡都留著一段 **2017 年的孤兒資料**,
//    然後直接跳到 2023-06(中間 5.5 年沒有)→ 相鄰兩根差 1.5~2.2 倍是**正常的**(隔了 5 年半)。
//    ⛔ 照第一版會把 006208(富邦台50,很多人買)這種好資料整檔排除掉。
//    → 只有「相鄰兩根**在 10 個日曆天以內**」才算真的斷崖。
const dayGap = (a2, b2) => Math.round((Date.parse(b2) - Date.parse(a2)) / 86400000);
const cliffs = R => {
  const out = [];
  for (let i = 1; i < R.length; i++) {
    const r = R[i].c / R[i - 1].c;
    if ((r > 1.4 || r < 0.6) && dayGap(R[i - 1].d, R[i].d) <= 10) out.push(`${R[i].d}×${r.toFixed(2)}`);
  }
  return out;
};
// ✂️ 只留「最後一段連續的資料」—— 中間有 >180 天的洞就從洞之後重新起算,
//    ⛔ 否則年數會被那段孤兒資料灌水(006208 會被算成 9 年,實際可用只有 3.2 年)。
const tail = R => {
  let st = 0;
  for (let i = 1; i < R.length; i++) if (dayGap(R[i - 1].d, R[i].d) > 180) st = i;
  return { R: R.slice(st), cut: st > 0 ? R[st].d : null };
};

const UNIV = [
  ['2330', '台積電', TAX_STK],
  ['2317', '鴻海', TAX_STK],
  ['2454', '聯發科', TAX_STK],
  ['0050', '0050 台灣50', TAX_ETF],
  ['0056', '0056 高股息', TAX_ETF],
  ['00878', '00878 高息低波', TAX_ETF],
  ['00757', '00757 全球科技', TAX_ETF],
];

const series = new Map();
const dropped = [];
for (const [sym, nm, tax] of UNIV) {
  const R = load(sym);
  if (!R) { dropped.push(`${sym} ${nm}(沒有資料)`); continue; }
  const cf = cliffs(R);
  if (cf.length) { dropped.push(`${sym} ${nm}(價格有斷崖 ${cf.slice(0, 3).join(' ')})`); continue; }
  series.set(sym, { nm, tax, R });
}
// ⭐ 合成「正2」代理 —— ⛔ 真的 00631L 資料有斷崖用不得(V74.4.7),
//    這裡用 0050 的日報酬 ×2 再扣年管理費 1.1%/252,並**明確標成「合成」**。
{
  const b = series.get('0050');
  if (b) {
    const R = [{ d: b.R[0].d, c: 100 }];
    for (let i = 1; i < b.R.length; i++) {
      const r = b.R[i].c / b.R[i - 1].c - 1;
      R.push({ d: b.R[i].d, c: R[i - 1].c * (1 + 2 * r - 0.011 / 252) });
    }
    series.set('SYN2X', { nm: '合成正2(0050×2,扣管理費)', tax: TAX_ETF, R, syn: true });
  }
}

// ── ① 共同窗口(⛔ 不對齊就不能比)──
let from = '0000-00-00', to = '9999-99-99';
for (const [, v] of series) { if (v.R[0].d > from) from = v.R[0].d; if (v.R[v.R.length - 1].d < to) to = v.R[v.R.length - 1].d; }
for (const [k, v] of series) v.R = v.R.filter(x => x.d >= from && x.d <= to);
const days = series.get('0050').R.map(x => x.d);
const YRS = [...new Set(days.map(d => d.slice(0, 4)))].sort();
console.log(`\n🐢 長期持有 × 多空切換 × 逐年績效`);
console.log(`   共同窗口 ${from} ~ ${to}(${days.length} 個交易日 ・${(days.length / 252).toFixed(1)} 年)・本金 ${CAP.toLocaleString()} 元`);
console.log(`   手續費 6 折;賣出證交稅 個股 0.3% / ETF 0.1%  ⚠️ **不含股息**(資料源沒有配息)`);
if (dropped.length) console.log(`   🚧 排除:${dropped.join(' ・ ')}`);

// ── 策略引擎 ──
// mode: 'bh' 買進持有 / 'ma' 均線切換 / 'ma_wait' 跌破就跑+站回才一次全投入 / 'dca' 定期定額
function run(sym, mode, opt = {}) {
  const S = series.get(sym); if (!S) return null;
  const R = S.R, tax = S.tax;
  const buyCost = 1 + FEE, sellCost = 1 - FEE - tax;
  let cash = CAP, sh = 0, trades = 0, inDays = 0;
  const eq = [], maN = opt.ma || 0;
  const ma = i => { if (i < maN) return null; let s = 0; for (let k = i - maN + 1; k <= i; k++) s += R[k].c; return s / maN; };
  // 定期定額:把本金平均分成每月一次
  const monKeys = [...new Set(R.map(x => x.d.slice(0, 7)))];
  const per = CAP / monKeys.length;
  const seenMon = new Set();
  let put = 0;                       // 已投入(定期定額用)

  for (let i = 0; i < R.length; i++) {
    const p = R[i].c;
    if (mode === 'bh') {
      if (i === 0) { sh = cash / (p * buyCost); cash = 0; trades++; }
    } else if (mode === 'dca') {
      const m = R[i].d.slice(0, 7);
      if (!seenMon.has(m)) {
        seenMon.add(m);
        const amt = Math.min(per, cash);
        // 🚨 一定要把現金扣掉 —— 第一版漏了這行,於是權益 = 本金 + 持股市值
        //    → 淨賺被整整灌水 100 萬,而且**看起來完全合理**(定期定額本來就該表現不錯)。
        //    ⭐ 通用:改「錢怎麼流動」的模式時,一定要檢查花錢那一端有沒有跟著減少(同 etf0050_probe 的教訓)。
        if (amt > 0) { sh += amt / (p * buyCost); cash -= amt; put += amt; trades++; }
      }
    } else if (mode === 'wait_ma') {
      // ⭐ 使用者③ 的字面做法:一開始**空手等**,第一次站上年線才一次全投入,之後**不再賣**
      const m = ma(i);
      if (sh === 0 && cash > 0 && m != null && p > m) { sh = cash / (p * buyCost); cash = 0; trades++; }
    } else if (mode === 'wait_dd') {
      // ⭐ 另一種「等好時機」:等它從近一年高點回落 ≥X% 才一次全投入,之後不再賣
      if (sh === 0 && cash > 0 && i >= 60) {
        let hi = 0; for (let k = Math.max(0, i - 251); k <= i; k++) if (R[k].c > hi) hi = R[k].c;
        if (hi > 0 && p / hi - 1 <= -(opt.dd || 0.2)) { sh = cash / (p * buyCost); cash = 0; trades++; }
      }
    } else if (mode === 'ma' || mode === 'ma_wait') {
      const m = ma(i);
      if (m != null) {
        const above = p > m;
        if (above && sh === 0 && cash > 0) { sh = cash / (p * buyCost); cash = 0; trades++; }
        else if (!above && sh > 0) { cash = sh * p * sellCost; sh = 0; trades++; }
      }
    }
    // ⭐ 「在市場」用**曝險比例**(持股市值 ÷ 總資產)不是「有沒有持股的天數」——
    //    定期定額幾乎每天都有持股,但錢是慢慢餵進去的;只數天數會把它算成 100% = 不可比。
    const tot = cash + sh * p;
    if (tot > 0) inDays += (sh * p) / tot;
    eq.push(tot);
  }
  const finalV = eq[eq.length - 1];
  let peak = 0, mdd = 0;
  for (const v of eq) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const yrs = days.length / 252;
  const invested = mode === 'dca' ? put : CAP;
  const cagr = (Math.pow(finalV / CAP, 1 / yrs) - 1) * 100;
  // 逐年報酬(用權益曲線)
  const yr = {};
  for (const y of YRS) {
    const ii = [];
    for (let i = 0; i < R.length; i++) if (R[i].d.slice(0, 4) === y) ii.push(i);
    if (ii.length < 20) { yr[y] = null; continue; }
    const a = ii[0] === 0 ? CAP : eq[ii[0] - 1], b = eq[ii[ii.length - 1]];
    yr[y] = a > 0 ? (b / a - 1) * 100 : null;
  }
  return { finalV, pnl: finalV - CAP, cagr, mdd: mdd * 100, inPct: inDays / R.length * 100, trades, invested, yr };
}

const pad = (s, n) => { let w = 0; for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(1, n - w)); };
const nf = x => x == null ? '   --' : Math.round(x).toLocaleString();
const pc = (x, d = 1) => x == null ? '  --' : (x >= 0 ? '+' : '') + x.toFixed(d);

function table(title, rows) {
  console.log(`\n${title}`);
  console.log(pad('做法', 30) + '     淨賺       年化   最大回撤  在市場  換手  ' + YRS.map(y => y.slice(2)).map(y => y.padStart(7)).join(''));
  console.log('─'.repeat(30 + 46 + YRS.length * 7));
  for (const [nm, r] of rows) {
    if (!r) { console.log(pad(nm, 30) + '  (沒有資料)'); continue; }
    console.log(pad(nm, 30) + nf(r.pnl).padStart(11) + pc(r.cagr).padStart(9) + '%'
      + pc(r.mdd).padStart(9) + '%' + (r.inPct.toFixed(0) + '%').padStart(7) + String(r.trades).padStart(6) + '  '
      + YRS.map(y => pc(r.yr[y], 0).padStart(7)).join(''));
  }
}

// ── ① 多頭要買什麼:買進持有比一比 ──
table('① 買進持有(同一段窗口、同一筆本金 100 萬)',
  [...series.entries()].map(([k, v]) => [v.nm + (v.syn ? ' ⚠️合成' : ''), run(k, 'bh')])
    .sort((a, b) => (b[1]?.pnl ?? -9e9) - (a[1]?.pnl ?? -9e9)));

// ── ② 有買也要有賣:出場規則 ──
const SW = [['ma', 20, '跌破月線(20日)全賣・站上再全買'], ['ma', 60, '跌破季線(60日)全賣・站上再全買'], ['ma', 240, '跌破年線(240日)全賣・站上再全買']];
for (const sym of ['2330', '0050', 'SYN2X']) {
  if (!series.has(sym)) continue;
  const rows = [[`買進持有(對照)`, run(sym, 'bh')]];
  for (const [m, n, nm] of SW) rows.push([nm, run(sym, m, { ma: n })]);
  rows.push(['定期定額(每月)', run(sym, 'dca')]);
  // ⭐ 使用者③:「等待好時機一次投入全部本金」的兩種字面做法
  rows.push(['空手等・站上年線才一次全押(之後不賣)', run(sym, 'wait_ma', { ma: 240 })]);
  rows.push(['空手等・回落 20% 才一次全押(之後不賣)', run(sym, 'wait_dd', { dd: 0.2 })]);
  rows.push(['空手等・回落 30% 才一次全押(之後不賣)', run(sym, 'wait_dd', { dd: 0.3 })]);
  table(`② ${series.get(sym).nm} —— 有買也要有賣?`, rows);
}

// ── ③ 混合:核心衛星 ──
console.log('\n③ 核心衛星(混合)—— 把本金拆成兩份,各自跑再相加');
{
  const core = run('0050', 'bh'), sat = run('2330', 'bh'), satL = run('SYN2X', 'bh');
  const mix = (a, b, wa) => a && b ? {
    pnl: a.pnl * wa + b.pnl * (1 - wa),
    yr: Object.fromEntries(YRS.map(y => [y, a.yr[y] == null || b.yr[y] == null ? null : a.yr[y] * wa + b.yr[y] * (1 - wa)])),
    mdd: null, cagr: null, inPct: 100, trades: 2,
  } : null;
  table('   ⚠️ 這是**近似**(兩條權益曲線加權相加,⛔ 沒有再平衡)', [
    ['100% 0050', core],
    ['70% 0050 + 30% 台積電', mix(core, sat, 0.7)],
    ['70% 0050 + 30% 合成正2 ⚠️', mix(core, satL, 0.7)],
    ['100% 台積電', sat],
  ]);
}

// ═══════════ ④ V74.3.3 ETF 全掃(使用者:「etf 幫我測」)═══════════
// 🚨 ⛔ **不可**把這些併進上面的共同窗口 —— 多數 ETF 是 2022~2024 才上市,
//    併進去會把「共同窗口」整段砍短,連台積電/0050 的結論都一起變樣。
//    → 每一檔跑**它自己的最長歷史**,只比 **年化** 與 **逐年**,⛔ 不比總報酬。
const ETF_NAMES = {
  '0050': '台灣50', '0051': '中型100', '0052': '富邦科技', '0056': '高股息', '0057': '富邦摩台',
  '006203': '元大MSCI台灣', '006208': '富邦台50', '00646': '元大S&P500', '00662': '富邦NASDAQ',
  '00692': '富邦公司治理', '00713': '元大高息低波', '00728': '第一金工業30', '00757': '統一FANG+',
  '00850': '元大臺灣ESG', '00878': '國泰永續高股息', '00881': '國泰台灣5G+', '00891': '中信關鍵半導體',
  '00892': '富邦台灣半導體', '00895': '富邦未來車', '00900': '富邦特選高股息30', '00904': '新光臺灣半導體30',
  '00909': '國泰數位支付', '00912': '中信臺灣智慧50', '00915': '凱基優選高股息30', '00919': '群益台灣精選高息',
  '00922': '國泰台灣領袖50', '00923': '群益台ESG低碳50', '00929': '復華台灣科技優息',
  '00935': '野村臺灣新科技50', '00939': '統一台灣高息動能', '00940': '元大台灣價值高息',
  '00941': '中信上游半導體', '00946': '群益科技高息成長',
};
{
  const rows = [];
  const skipped = [], gapped = [];
  for (const [sym, nm] of Object.entries(ETF_NAMES)) {
    const R0 = load(sym);
    if (!R0) { skipped.push(`${sym}(沒有資料)`); continue; }
    const t = tail(R0), R = t.R;
    if (R.length < 400) { skipped.push(`${sym}(只有 ${R.length} 天)`); continue; }
    const cf = cliffs(R);
    if (cf.length) { skipped.push(`${sym}(價格有斷崖 ${cf[0]})`); continue; }
    if (t.cut) gapped.push(`${sym} 從 ${t.cut} 起算`);
    // 🚧 每檔用自己的資料跑買進持有 —— 直接算,⛔ 不走 run()(那支綁共同窗口的 YRS)
    const buyCost = 1 + FEE, sellCost = 1 - FEE - TAX_ETF;
    const sh = CAP / (R[0].c * buyCost);
    const eq = R.map(x => sh * x.c);
    const finalV = eq[eq.length - 1] * sellCost / 1;      // 最後賣出扣一次稅費(跟上面口徑一致)
    let peak = 0, mdd = 0;
    for (const v of eq) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
    const yrs = R.length / 252;
    const cagr = (Math.pow(finalV / CAP, 1 / yrs) - 1) * 100;
    const yr = {};
    for (const y of [...new Set(R.map(x => x.d.slice(0, 4)))]) {
      const ii = []; for (let i = 0; i < R.length; i++) if (R[i].d.slice(0, 4) === y) ii.push(i);
      if (ii.length < 20) continue;
      const a2 = ii[0] === 0 ? CAP : eq[ii[0] - 1];
      yr[y] = (eq[ii[ii.length - 1]] / a2 - 1) * 100;
    }
    rows.push({ sym, nm, from: R[0].d, yrs, cagr, mdd: mdd * 100, pnl: finalV - CAP, yr });
  }
  rows.sort((a2, b2) => b2.cagr - a2.cagr);
  const ALLY = [...new Set(rows.flatMap(r => Object.keys(r.yr)))].sort();
  console.log(`\n④ ETF 全掃(⚠️ 每一檔用**自己**的最長歷史 → ⛔ 只比年化與逐年,不比總報酬)`);
  console.log(pad('代號 名稱', 24) + '  起算日' + '   年數' + '    年化' + '  最大回撤  '
    + ALLY.map(y => y.slice(2).padStart(7)).join(''));
  console.log('─'.repeat(24 + 34 + ALLY.length * 7));
  for (const r of rows) {
    console.log(pad(`${r.sym} ${r.nm}`, 24) + `  ${r.from}` + `  ${r.yrs.toFixed(1)}`.padStart(6)
      + `  ${pc(r.cagr)}%`.padStart(9) + `  ${pc(r.mdd)}%`.padStart(10) + '  '
      + ALLY.map(y => (r.yr[y] == null ? '    --' : pc(r.yr[y], 0)).padStart(7)).join(''));
  }
  if (skipped.length) console.log(`   🚧 排除:${skipped.join(' ・ ')}`);
  if (gapped.length) console.log(`   ⚠️ 資料中間有大洞(留著一段很舊的孤兒資料)→ 只用洞之後那一段:${gapped.join(' ・ ')}`);
  console.log('   ⚠️ ⛔ 這張表**不含配息**,而高股息 ETF 一年配 5~8% —— 0056/00878/00919/00929/00939/00940');
  console.log('      那一族的真實報酬要**再加回配息**,⛔ 不可照這張表判定它們比較差。');
  console.log('   ⚠️ 起算日不同 = **經歷的行情不同**:2023 後才上市的沒碰過 2022 那次空頭,');
  console.log('      年化看起來高很正常,⛔ 不可跟 0050/0056 直接比。');
}

console.log('\n⚠️ 讀這份報告的規則');
console.log('  ① **不含股息** → 0056/00878 這種高股息被系統性低估(年化少算約 3~8%),⛔ 不可據此說它們差。');
console.log(`  ② 窗口 ${from} ~ ${to} 只有 ${(days.length / 252).toFixed(1)} 年,而且**只涵蓋 2022 一次空頭** → ⛔ 不可外推。`);
console.log('  ③ 「在市場」欄位是關鍵:擇時策略常常只是**錢沒進場**,那不是本事 —— 要跟「同樣時間都在市場」的比。');
console.log('  ④ 合成正2 是用 0050 日報酬 ×2 扣管理費模擬的(真的 00631L 資料有斷崖用不得),⛔ 不是實際報價。\n');
