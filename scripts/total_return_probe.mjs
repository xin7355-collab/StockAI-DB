#!/usr/bin/env node
/**
 * 🐢💰 含息 vs 不含息「買了放著」對照(V74.3.9)
 *
 * ⭐ 為什麼要這支:本站**所有**「買進持有」的數字都是**不含配息**的
 *    (0050 的含息一直是用「年化 3%」估的,0056/00878 這種一年配 5~8% 的被系統性低估)。
 *    dividend_miner(V74.3.8)產出 `data/dividends_hist.json` 之後,終於可以把配息真的加回去。
 *
 * ⛔ 三個不可簡化的地方(每一個做錯都會安靜地給出好看的錯數字):
 *  ① **股利要在除息日當天再投入**,⛔ 不可把總股利加在最後一天 —— 那會少算複利,
 *     而且高配息、長年期的標的差最多(正是我們想量的那一群)。
 *  ② 🚨 **股利要跟價格用同一把尺**:`data/*.json` 的歷史價是**還原過分割的**(陷阱 #21),
 *     而 FinMind 的現金股利是**當時的實際金額**。0050 在 2025-06 分割 1:4 → 分割前的
 *     3.0 元股利,在還原後的價格尺標上只值 0.75。
 *     ⭐ 判斷方式:用股利紀錄自帶的 `before_price`(除息前一日實際收盤)跟**我們自己存的**
 *     那天收盤比 → 比值就是尺標差,直接拿來換算(⛔ 不去猜分割倍數、也不去改採礦端)。
 *     ⚠️ 比值離 1 太遠又不是常見分割倍數 → 那一筆標成可疑並**排除**,⛔ 不硬算。
 *  ③ **只算窗口內的除息**,而且窗口起點要用「兩邊都有資料」的那天(⛔ 不可拿 2021 的價格
 *     配 2023 才開始的股利紀錄,那會低估含息報酬)。
 *
 * ⛔ 這支只回答「含息差多少」,⛔ 不下任何買賣建議、不排名推薦。
 *
 * 用法:node scripts/total_return_probe.mjs [代號…]      DATA_DIR=… 可換資料夾
 *      node scripts/total_return_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';

const DATA = process.env.DATA_DIR || 'data';
const DEFAULT_SYMS = ['0050', '006208', '0056', '00878', '00713', '00919', '00929', '00757', '2330', '2317', '2412', '1101'];

const num = x => (x === null || x === undefined || !Number.isFinite(+x) ? null : +x);
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);

function loadPx(dir, sym) {
  const p = path.join(dir, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const r of rows) { const c = num(r.close); if (c !== null && c > 0) out.push({ d: d10(r.date), c }); }
  out.sort((a, b) => a.d < b.d ? -1 : 1);
  return out.length ? out : null;
}

/** 股利尺標對齊:回 {k, why} —— k = 要乘在現金股利上的倍率 */
function scaleFor(before, closeOnDate) {
  if (!(before > 0) || !(closeOnDate > 0)) return { k: 1, why: 'no-before' };   // 沒有 before_price → 假設同尺
  const ratio = closeOnDate / before;
  if (ratio > 0.9 && ratio < 1.1) return { k: 1, why: 'same' };                 // 同尺(常態)
  // 常見分割/合併倍數:2~10 與其倒數
  for (const m of [2, 3, 4, 5, 6, 8, 10]) {
    if (Math.abs(ratio - 1 / m) / (1 / m) < 0.08) return { k: 1 / m, why: `split1:${m}` };
    if (Math.abs(ratio - m) / m < 0.08) return { k: m, why: `merge${m}:1` };
  }
  return { k: null, why: `ratio=${ratio.toFixed(3)}` };                          // ⛔ 說不出來的一律排除
}

function run(px, divs, opt = {}) {
  const from = opt.from || px[0].d, to = opt.to || px[px.length - 1].d;
  const bars = px.filter(b => b.d >= from && b.d <= to);
  if (bars.length < 60) return null;
  const idx = new Map(bars.map((b, i) => [b.d, i]));
  const p0 = bars[0].c, pN = bars[bars.length - 1].c;
  let sh = 1, applied = 0, cash = 0, skipped = [];
  for (const [dt, amt, typ, before] of (divs || [])) {
    if (typ === '權') continue;                     // 股票股利:配股會改變股數,本站價格已還原過 → ⛔ 不重複計
    const c = num(amt); if (!(c > 0)) continue;
    const D = d10(dt); if (D < from || D > to) continue;
    const i = idx.get(D);
    const px_on = i !== undefined ? bars[i].c : null;
    if (px_on === null) { skipped.push(`${D}(那天沒有K棒)`); continue; }
    const { k, why } = scaleFor(num(before), px_on);
    if (k === null) { skipped.push(`${D}(尺標對不上 ${why})`); continue; }
    const cAdj = c * k;
    sh += (sh * cAdj) / px_on;                      // ⭐ 當天以收盤價再投入(⛔ 不是最後一天)
    cash += sh * cAdj; applied++;
  }
  const yrs = (Date.parse(to) - Date.parse(from)) / (365.25 * 864e5);
  const prOnly = pN / p0 - 1, total = (sh * pN) / p0 - 1;
  const ann = r => yrs > 0 ? Math.pow(1 + r, 1 / yrs) - 1 : null;
  return { from, to, yrs, bars: bars.length, prOnly, total, annPr: ann(prOnly), annTr: ann(total), applied, skipped };
}

function fmtPct(x) { return x === null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

function main(argv) {
  const syms = argv.filter(a => /^[0-9]{4,6}[A-Z]?$/.test(a));
  const divPath = path.join(DATA, 'dividends_hist.json');
  const litePath = path.join(DATA, 'dividends.json');
  const use = fs.existsSync(divPath) ? divPath : litePath;
  if (!fs.existsSync(use)) {
    console.log(`❌ 找不到 ${divPath}(或 ${litePath})—— dividend_sweep 還沒產出。`);
    console.log('   取得方式:git show origin/data:data/dividends_hist.json > data/dividends_hist.json');
    return 1;
  }
  const DV = JSON.parse(fs.readFileSync(use, 'utf8'));
  const D = DV.d || DV;
  console.log(`💰 股利檔:${path.basename(use)} ・${Object.keys(D).length} 檔 ・資料日 ${DV.data_date || '—'}${use === litePath ? ' ⚠️ 用的是精簡檔(每檔只有最近 12 筆)→ 含息會被低估' : ''}`);
  const list = syms.length ? syms : DEFAULT_SYMS;
  const rows = [];
  for (const s of list) {
    const px = loadPx(DATA, s);
    if (!px) { rows.push({ s, err: '沒有 K 線' }); continue; }
    const dv = (D[s] && D[s].h) || [];
    // ⛔ 窗口起點取「價格與股利都涵蓋得到」的那天:股利檔從 SINCE 起,價格從自己的第一天起
    const from = [px[0].d, DV.from || '2021-01-01'].sort().pop();
    const r = run(px, dv, { from });
    if (!r) { rows.push({ s, err: '窗口太短' }); continue; }
    rows.push({ s, ...r, nDiv: dv.length });
  }
  const W = (t, n) => String(t).padEnd(n - [...String(t)].filter(ch => ch.charCodeAt(0) > 255).length);
  console.log('\n代號    年數  除息筆數  不含息      含息        差(pp)   年化(不含息→含息)');
  for (const r of rows) {
    if (r.err) { console.log(`${W(r.s, 8)}${r.err}`); continue; }
    const gap = (r.total - r.prOnly) * 100;
    console.log(`${W(r.s, 8)}${r.yrs.toFixed(1).padStart(4)}  ${String(r.applied).padStart(4)}/${String(r.nDiv).padStart(2)}   ${fmtPct(r.prOnly).padStart(9)}  ${fmtPct(r.total).padStart(9)}  ${gap.toFixed(1).padStart(7)}  ${fmtPct(r.annPr)} → ${fmtPct(r.annTr)}`);
    if (r.skipped.length) console.log(`         ⚠️ 排除 ${r.skipped.length} 筆:${r.skipped.slice(0, 3).join(' / ')}`);
  }
  console.log('\n⚠️ 限制:① 股利以**除息日收盤價**再投入(實務上要等入帳,會有幾天落差)');
  console.log('   ② ⛔ 沒有扣二代健保補充保費與所得稅(高股息那族實際到手會少一點)');
  console.log('   ③ 股票股利(配股)不計 —— 本站價格已還原過分割,重複計會灌水');
  console.log('   ④ ⛔ 這是「含息差多少」的事實,不是推薦 —— 高配息 ≠ 總報酬高(看上表自己比)');
  return 0;
}

function selftest() {
  // 合成:每年漲 10%、每年配 5 元;另一檔中途分割 1:4(價格已還原 → 股利要跟著縮)
  const px = [], start = Date.UTC(2021, 0, 4);
  let p = 100;
  for (let i = 0; i < 1300; i++) {
    const dt = new Date(start + i * 864e5);
    if (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) continue;
    p *= Math.pow(1.10, 1 / 252);
    px.push({ d: dt.toISOString().slice(0, 10), c: +p.toFixed(2) });
  }
  const find = d => px.find(b => b.d >= d);
  // ① 同尺:before_price 就用那天前一根的價
  const exs = ['2021-07-15', '2022-07-15', '2023-07-14', '2024-07-15'].map(d => find(d).d);
  const divA = exs.map(d => [d, 5, '息', find(d).c, find(d).c - 5]);
  const a = run(px, divA);
  if (!(a.total > a.prOnly)) throw new Error('❌ selftest:含息沒有高於不含息');
  if (a.applied !== 4) throw new Error(`❌ selftest:應該套用 4 次除息,實際 ${a.applied}`);
  // 手算對照:每次再投入 5/當日價 → 股數連乘
  let sh = 1; for (const [d, amt] of divA) { const c = px.find(b => b.d === d).c; sh += sh * amt / c; }
  const want = sh * px[px.length - 1].c / px[0].c - 1;
  if (Math.abs(a.total - want) > 1e-9) throw new Error(`❌ selftest:含息報酬對不上手算 ${a.total} vs ${want}`);
  // ② 🚨 尺標:價格是「還原後」的(= 實際的 1/4),股利是實際金額 → 必須自動縮成 1/4
  const divB = exs.map(d => [d, 20, '息', find(d).c * 4, find(d).c * 4 - 20]);   // before 是實際價(4 倍)
  const b = run(px, divB);
  if (Math.abs(b.total - a.total) > 1e-6) throw new Error(`❌ selftest:分割尺標沒對齊(${b.total} 應等於 ${a.total})`);
  // ③ 對不上的尺標要被排除,⛔ 不可硬算
  const divC = [[exs[0], 5, '息', find(exs[0]).c * 1.7, 0]];
  const c = run(px, divC);
  if (c.applied !== 0 || c.skipped.length !== 1) throw new Error('❌ selftest:離譜的 before_price 沒有被排除');
  // ④ 配股(權)不計
  const divD = [[exs[0], 5, '權', find(exs[0]).c, 0]];
  if (run(px, divD).applied !== 0) throw new Error('❌ selftest:股票股利被算進去了');
  // ⑤ 窗口外的除息不算
  const divE = [['2020-07-15', 5, '息', 100, 95]];
  if (run(px, divE).applied !== 0) throw new Error('❌ selftest:窗口外的除息被算進去了');
  console.log(`✅ selftest 通過 — 不含息 ${fmtPct(a.prOnly)} → 含息 ${fmtPct(a.total)}(4 次再投入)・分割尺標自動對齊 ・離譜值排除 ・配股不計`);
  return 0;
}

const argv = process.argv.slice(2);
process.exit(argv.includes('--selftest') ? selftest() : main(argv));
