#!/usr/bin/env node
/**
 * 🔗 把 klines_deep 分支的深歷史(2021-01 起)接到 data/*.json 的**前面**(V74.4.5)
 *
 * ⭐ 目的:個股 K 線原本只有 2023-06 起 → 所有回測結論都來自一段偏多頭的行情。
 *    接上 2021-01 之後就涵蓋 **2022 那次 −32% 空頭**,十幾支「走完空頭要重跑」的探針
 *    現在就能重驗(尤其 🧬 追高+高波動 —— 那正是空頭最容易受傷的組合)。
 *
 * 🚨🚨 **第一版做錯了,而且是實跑輸出抓到的**(⛔ 別再犯):
 *    直接把深歷史接上去 → 0050 在接縫處出現 **×0.25 的斷崖**,回測印出
 *    「0050 買進持有 −10.32%」配「加權指數 +206%」—— 那個組合物理上不可能,一眼就知道基準壞了。
 *    真因:0050 分割時**停牌 8 天**,而 `miner._backadjust_splits` 有一道
 *    `gap > 5 → 不當成分割` 的守門(那是為了避免把「長期停牌後的真實跳空」誤判成分割)
 *    → 這種「分割 + 停牌超過 5 天」的組合它修不掉。
 *
 * ⭐ 正解:**用重疊期的中位比值對齊尺標**,⛔ 不去改採礦機的守門。
 *    深歷史涵蓋 2021-01~今天、既有涵蓋 2023-06~今天 → **重疊 3 年**。
 *    取重疊期每天的 (深歷史收盤 ÷ 既有收盤),中位數就是兩邊的尺標差
 *    (一致→1.0;深歷史沒除以分割倍數→4.0)。用中位數 ⇒ 單一天的髒值不影響。
 *    ⚠️ 一律**以既有列為準**(那是前端在用、也是所有既有回測的基準)。
 *
 * ⛔ 四條設計:
 *   ① **只補前面、不動既有列** —— 既有列帶籌碼欄位(法人買賣超等),深歷史只有 OHLCV。
 *   ② 舊列的籌碼欄位**留空**(本來就沒有)—— ⛔ 不可補 0(0 = 「今天沒買沒賣」,意思完全不同)。
 *   ③ 重疊不足 20 天 → **整檔跳過**(⛔ 不敢憑幾天就調尺標)。
 *   ④ 🚧 合併後**逐檔驗接縫**:相鄰兩根收盤差 >1.5 倍就報出來(⛔ 不可靜默放行)。
 *
 * 用法:node scripts/merge_deep_klines.mjs <klines_deep 解出來的目錄> [data 目錄] [--delisted-out <目錄>]
 *   🪦 V79.2.4 `--delisted-out`:klines_deep 標 `dl:1`(已下市)而 data/ 沒有的那幾檔(實測 54 檔),**另外**寫到指定目錄
 *   (給回測量倖存者偏誤用;⛔ 絕不寫進 data/ —— 下市股混進選股母體會害到 App)。沒給就照舊只計數。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };

// 深歷史接到既有前面那一段:重疊期中位比值 = 尺標差;只取比既有最早一天更早的列。回 {ratio, pre, firstBase} 或 {why}
// 🔢 V79.4.1:成交量要跟價格**反向**換尺標(價格 ÷ ratio → 股數 × ratio)。之前漏了 → 分割 / 面額變更 / 整數倍減資的股票
//    2021-01~2023-05 那段「價格是新尺標、成交量還是舊股數」→ 成交金額少算 ratio 倍(2327 國巨 ×4),
//    👑 用成交金額排池子、決策台成績單的「買得到嗎」都會把它們擠出去。同 miner._backadjust_splits 的做法(股數與價格反向)。
function deepPre(base, deepK) {
  const firstBase = norm(base[0].date);
  const baseMap = new Map();
  for (const r of base) if (+r.close > 0) baseMap.set(norm(r.date), +r.close);
  const ratios = [];
  for (const [d, , , , c] of deepK) {
    const b = baseMap.get(norm(d));
    if (b > 0 && c > 0) ratios.push(c / b);
  }
  if (ratios.length < 20) return { why: 'thin', firstBase };
  const ratio = med(ratios);
  if (!(ratio > 0)) return { why: 'bad', firstBase };
  const pre = [];
  for (const [d, o, h, l, c, v] of deepK) {
    if (norm(d) >= firstBase) break;                     // ⛔ 到既有範圍就停(⛔ 不覆蓋既有列)
    if (!(c > 0 && o > 0)) continue;
    pre.push({ date: String(d).replace(/-/g, '/'),
               open: o / ratio, high: h / ratio, low: l / ratio, close: c / ratio, volume: Math.round((v || 0) * ratio) });
  }
  return { ratio, pre, firstBase };
}

if (process.argv.includes('--selftest')) {
  // 2025-09-01 一拆四;既有那份照 App(價格 ÷4、成交量 ×4,2023-06 起);深歷史是原始價(2021-01 起,拆股那天有斷崖)
  const days = [];
  for (let t = Date.UTC(2021, 0, 4); t <= Date.UTC(2026, 5, 30); t += 86400000) { const x = new Date(t); if (x.getUTCDay() % 6) days.push(x.toISOString().slice(0, 10)); }
  const P = Object.fromEntries(days.map((d, i) => [d, 100 * (1 + i * 0.0003)]));
  const SPL = '2025-09-01';
  const deepK = days.map(d => { const c = d < SPL ? P[d] : P[d] / 4, v = d < SPL ? 1000 : 4000; return [d, c, c, c, c, v]; });
  const base = days.filter(d => d >= '2023-06-01').map(d => ({ date: d.replace(/-/g, '/'), open: P[d] / 4, high: P[d] / 4, low: P[d] / 4, close: P[d] / 4, volume: 4000 }));
  const r = deepPre(base, deepK);
  const amt = x => x.close * x.volume;
  const p0 = r.pre && r.pre[0], b0 = base[0];
  const raw0 = deepK[0][4] * deepK[0][5];
  const okA = r.ratio === 4 && r.pre.length > 500 && Math.abs(p0.close - P[days[0]] / 4) < 1e-9;
  const okB = r.pre.every(x => x.volume === 4000) && Math.abs(amt(p0) / raw0 - 1) < 1e-9;
  const okC = Math.abs(amt(r.pre[r.pre.length - 1]) / amt(b0) - 1) < 0.01;
  const old = deepK[0][4] / r.ratio * deepK[0][5];
  console.log(`${okA ? '✅' : '❌'} ① 尺標比 4、前段價格 ÷4、補了 ${r.pre ? r.pre.length : 0} 根`);
  console.log(`${okB ? '✅' : '❌'} ② 前段成交量 ×4 → 成交金額 = 原始成交金額(${amt(p0)} vs ${raw0})`);
  console.log(`${okC ? '✅' : '❌'} ③ 接縫兩邊成交金額連續(沒有一刀砍成四分之一)`);
  console.log(`${old / raw0 < 0.3 ? '✅' : '❌'} ④ 決定性對照:舊寫法(成交量不換)成交金額只剩 ${(old / raw0 * 100).toFixed(0)}%`);
  process.exit(okA && okB && okC && old / raw0 < 0.3 ? 0 : 1);
}

const SRC = process.argv[2];
const _dlI = process.argv.indexOf('--delisted-out');
const DL_OUT = _dlI > 0 ? process.argv[_dlI + 1] : null;
const DST = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : 'data';
if (DL_OUT && path.resolve(DL_OUT) === path.resolve(DST)) { console.error('🚨 --delisted-out 不可以是 data 目錄本身'); process.exit(1); }
if (!SRC || !fs.existsSync(SRC)) { console.error('用法:node scripts/merge_deep_klines.mjs <deepDir> [dataDir]'); process.exit(1); }

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.json.gz'));
console.log(`深歷史檔:${files.length}`);
let merged = 0, skipped = 0, noBase = 0, added = 0, rescaled = 0, thinOverlap = 0, dlOut = 0, dlSkip = 0;
if (DL_OUT) fs.mkdirSync(DL_OUT, { recursive: true });
const cliffs = [];
const beforeD = [], afterD = [];

for (const f of files) {
  const sym = f.replace('.json.gz', '');
  const dstPath = path.join(DST, sym + '.json');
  if (!fs.existsSync(dstPath)) {   // ⛔ 只補既有的檔(⛔ 下市股不新增到 data/,會混進選股母體)
    noBase++;
    if (DL_OUT) {   // 🪦 只有標 dl:1 的才另外寫出去(沒標的是「本站沒有但還在市」,⛔ 不當下市股)
      let deep; try { deep = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SRC, f))).toString('utf8')); } catch { dlSkip++; continue; }
      if (!deep || !deep.dl || !Array.isArray(deep.k) || deep.k.length < 120) { dlSkip++; continue; }
      const rows = deep.k.filter(([, o, , , c]) => c > 0 && o > 0).map(([d, o, h, l, c, v]) => ({ date: String(d).replace(/-/g, '/'), open: o, high: h, low: l, close: c, volume: v || 0, _dl: 1 }));
      if (rows.length < 120) { dlSkip++; continue; }
      fs.writeFileSync(path.join(DL_OUT, sym + '.json'), JSON.stringify(rows)); dlOut++;
    }
    continue;
  }
  let base, deep;
  try {
    base = JSON.parse(fs.readFileSync(dstPath, 'utf8'));
    deep = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SRC, f))).toString('utf8'));
  } catch { skipped++; continue; }
  if (!Array.isArray(base) || !base.length || !deep || !Array.isArray(deep.k)) { skipped++; continue; }
  const firstBase = norm(base[0].date);
  beforeD.push(firstBase);

  // ── ⭐ 尺標對齊:用重疊期的中位比值(deepPre;成交量反向換尺標)──
  const dp = deepPre(base, deep.k);
  if (dp.why === 'thin') { thinOverlap++; afterD.push(firstBase); continue; }
  if (dp.why) { skipped++; afterD.push(firstBase); continue; }
  const ratio = dp.ratio, pre = dp.pre;
  if (Math.abs(ratio - 1) > 0.02) rescaled++;            // 尺標不同(多半是分割/減資)
  if (!pre.length) { skipped++; afterD.push(firstBase); continue; }
  const out = pre.concat(base);
  // 🚧🚧 守門:合併後只要有斷崖就**整檔不寫**(保留原本的淺版)——
  //    ⛔ 寧可那一檔的窗口短一點,也不可以讓壞掉的價格序列進到回測母體。
  //    (第一版沒有這道守門,結果 0050 的基準壞掉、整份空頭結論不能看。)
  let cliff = null;
  for (let i = 1; i < out.length; i++) {
    const c0 = +out[i - 1].close, c1 = +out[i].close;
    if (c0 > 0 && c1 > 0 && (c1 / c0 > 1.5 || c1 / c0 < 0.67)) {
      cliff = `${sym} ${out[i - 1].date}→${out[i].date} ×${(c1 / c0).toFixed(2)}`;
      break;
    }
  }
  if (cliff) { cliffs.push(cliff); afterD.push(firstBase); continue; }   // ⛔ 不寫 → 維持淺版
  fs.writeFileSync(dstPath, JSON.stringify(out));
  merged++; added += pre.length;
  afterD.push(norm(pre[0].date));
}
const medS = a => { const b = a.slice().sort(); return b[Math.floor(b.length / 2)] || '-'; };
console.log(`✅ 合併 ${merged} 檔 ・共補 ${added.toLocaleString()} 根 K 線 ・其中 ${rescaled} 檔需要調整尺標(分割/減資)`);
console.log(`   跳過 ${skipped} ・重疊不足 20 天 ${thinOverlap}(⛔ 不敢調尺標)・data/ 沒有的 ${noBase}(下市股,刻意不加)` + (DL_OUT ? `・🪦 另外寫到 ${DL_OUT}:${dlOut} 檔(不合格 ${dlSkip})` : ''));
console.log(`   最早日期中位:${medS(beforeD)} → ${medS(afterD)}`);
if (cliffs.length) {
  console.log(`⛔ ${cliffs.length} 檔合併後仍有斷崖 → **已放棄合併、維持原本的淺版**(前 8):`);
  cliffs.slice(0, 8).forEach(x => console.log('   ' + x));
  console.log('   ⭐ 這是刻意的:那幾檔的窗口會短一點,但⛔ 不會有壞掉的價格進到回測。');
  console.log('   ⚠️ 常見原因:深歷史本身中間有大洞、或分割當時停牌太久導致兩段尺標對不齊。');
} else {
  console.log('✅ 接縫檢查:沒有任何一檔出現斷崖');
}
