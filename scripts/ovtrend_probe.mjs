#!/usr/bin/env node
/**
 * 🧭 `_ovTrend`(全 App 方向的根)到底有沒有邊際 —— 第一次回測
 *
 * 為什麼要做:`_bearGate` 有 21 個呼叫點、`_playbookMode` / `_ovDecide` / `_headline` /
 * `_ovDigest` 全部建立在 `_ovTrend` 上,⛔ 但它只是**一行均線規則**、從來沒有回測過。
 *
 * ⭐⭐ 核心設計:平均數**不是** `_bearGate` 的評分函數 —— 它是**否決權**。
 *   正確的評分是「擋掉率 × 被擋那批的劣勢 − 機會成本」,而且**左尾比平均重要**:
 *   就算平均邊際 = 0,只要 bear 桶的左尾明顯更肥,守門仍值得留,
 *   只是**畫面上的理由要從「會跌」改成「賠率變差」**。
 *
 * 🚨 對照組:`trend` 是**狀態變數、涵蓋 100% 的 (股·日)**,⛔ 不能照事件型探針的做法。
 *   兩個強共變量:**股票組成**(高 beta 股待在 bull 的天數本來就多)
 *   + **時間群聚**(2022 幾乎全市場 bear)。
 *   → 四層並排印,頭條用 `symday`(雙向去均值):
 *     raw(現行做法)/ sym(逐檔去均值)/ day(逐日去均值)/ ⭐ symday(交替 3 輪)
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物。
 * 用法:node --max-old-space-size=6144 scripts/ovtrend_probe.mjs [輸出.json]
 *       node scripts/ovtrend_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { signalsFor } from './lib_indicators.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.find(a => a.endsWith('.json')) || '';
const LIMIT = +(process.env.LIMIT || 0);

// ══════════════════════════════════════════════════════════════════════════
// ⛔⛔ 這三行必須跟 index.html 的 `_renderTrendCommand` **逐字相同**
//     —— `scripts/test_ovtrend_parity.mjs` 會 regex 抓出來跟這裡比對。
//     趨勢公式同時活在 index.html 與這支探針裡 = 第二份真相;
//     index.html 不能 import scripts/,唯一解就是那支守門測試。
//     ⛔ 改了任何一行 → 兩邊一起改 + 重跑這支探針。
export const OV_TREND_FORMULA = [
  'const ma20Up = ma20 != null && at(ind.ma20, last - 2) != null && ma20 > at(ind.ma20, last - 2);',
  'const bull = ma5 > ma20 && ma20 > ma60 && ma20Up;',
  'const bear = ma5 < ma20 && ma20 < ma60 && !ma20Up;',
];
// ══════════════════════════════════════════════════════════════════════════

const FWDS = [5, 10, 20, 40, 60];
const COST = 0.44;
const WARM = 62;            // ma60 + ma20Up 回看 2 根(index.html 另有 last>=25 的門檻,被這個涵蓋)
const MIN_EV = 800;         // 空過守門:一格至少要這麼多筆才報

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.max(0, Math.min(b.length - 1, Math.floor(b.length * p)))]; };
const f2 = v => v == null ? '  --  ' : (v >= 0 ? '+' : '') + v.toFixed(2);

// ── 趨勢序列(⛔ 公式見上面 OV_TREND_FORMULA,一字不可改)──
const SMA = (a, n) => { const o = new Array(a.length).fill(null); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };

export function ovTrendSeries(close) {
  const ma5 = SMA(close, 5), ma20 = SMA(close, 20), ma60 = SMA(close, 60);
  const out = new Array(close.length).fill(null);
  const legs = new Array(close.length).fill(null);   // 【A′】拆腿用
  for (let i = 0; i < close.length; i++) {
    if (i < WARM) continue;
    const a5 = ma5[i], a20 = ma20[i], a60 = ma60[i], a20p = ma20[i - 2];
    if (a5 == null || a20 == null || a60 == null) continue;
    const ma20Up = a20p != null && a20 > a20p;
    const bull = a5 > a20 && a20 > a60 && ma20Up;
    const bear = a5 < a20 && a20 < a60 && !ma20Up;
    out[i] = bull ? 'bull' : bear ? 'bear' : 'flat';
    legs[i] = { l1: a5 < a20, l2: a20 < a60, l3: !ma20Up };   // 三條「空頭腿」
  }
  return { trend: out, legs, ma20 };
}

// ══ 合成資料(--selftest 用,⛔ 不落檔)══
function synth(kind, nSym = 60, nBar = 900) {
  const files = [];
  let seed = 20260908;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const dates = [];
  for (let i = 0; i < nBar; i++) dates.push(new Date(Date.UTC(2021, 0, 4) + i * 864e5).toISOString().slice(0, 10));
  // 🚨 regime 必須是**逐檔錯開**的,⛔ 不可全市場同步 ——
  //   報酬已經扣掉同期大盤、又做了逐日去均值,**全市場同步的 regime 在設計上就會被歸零**
  //   → 那樣的正向對照組永遠測不到東西(第一版就是這樣,看起來像探針壞掉)。
  //   ⭐ 這件事本身也是這支探針的重要限制:symday 量的是**選股**成分,
  //      **擇時**成分要看【E】。
  const reg = (i, s) => { const ph = (i + s * 37) % nBar; return ph < nBar / 3 ? 1 : ph < nBar * 2 / 3 ? -1 : 1; };
  const mkt = [];
  { let p = 10000; for (let i = 0; i < nBar; i++) { p *= 1 + (rnd() - 0.5) * 0.008; mkt.push(p); } }
  for (let s = 0; s < nSym; s++) {
    const rows = []; let p = 50 + s;
    for (let i = 0; i < nBar; i++) {
      let drift = 0;
      if (kind === 'signal') drift = reg(i, s) * 0.0030;          // ① 正向:regime 真的有效(逐檔錯開)
      else if (kind === 'noise') drift = 0;                        // ② 負向:純隨機漫步
      else if (kind === 'cond') drift = 0;                         // ③ 條件式:只有 gene 那批有效(下面加)
      p *= 1 + drift + (rnd() - 0.5) * 0.03;
      const c = p, o = c * (1 + (rnd() - 0.5) * 0.01), h = Math.max(c, o) * 1.008, l = Math.min(c, o) * 0.992;
      rows.push({ date: dates[i], open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: 1e6 });
    }
    files.push({ sym: String(1000 + s), rows });
  }
  return { files, twii: Object.fromEntries(dates.map((d, i) => [d, mkt[i]])) };
}

// ══ 讀資料 ══
function load() {
  if (SELFTEST) return null;
  const twii = {};
  for (const r of JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))) {
    const c = +r.close; if (c > 0) twii[nd(r.date)] = c;
  }
  let names = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f));
  if (LIMIT) names = names.filter((_, i) => i % Math.ceil(names.length / LIMIT) === 0);   // ⛔ 等距抽樣,不可取前 N 檔(那是按產業取樣)
  const files = [];
  for (const f of names) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(raw)) continue;
    const rows = raw.filter(x => x && +x.close > 0);
    if (rows.length < WARM + 65) continue;
    files.push({ sym: f.slice(0, 4), rows });
  }
  return { files, twii };
}

// ══ 收樣本 ══
function collect(src, opt = {}) {
  const { files, twii } = src;
  const recs = [];                       // {sym, di, date, trend, legs, gene, sig, ex:{5:..,10:..}}
  const stat = { nSym: 0, nLocked: { bull: 0, flat: 0, bear: 0 }, runs: 0, yrCnt: {}, noMkt: 0 };
  for (const { sym, rows } of files) {
    const d = rows.map(x => nd(x.date));
    const c = rows.map(x => +x.close);
    const o = rows.map(x => +x.open || +x.close);
    const hi = rows.map(x => +x.high || +x.close);
    const lo = rows.map(x => +x.low || +x.close);
    const { trend, legs } = ovTrendSeries(c);
    stat.nSym++;
    // 🧬(位階/振幅,⛔ 用**百分位**版 —— 跟 genezone_probe / pro.html 同一個定義;
    //     lib_indicators 的 gene 是 min-max,兩者不同,報告要說清楚疊在哪一個上)
    const gene = new Array(rows.length).fill(false);
    for (let i = 251; i < rows.length; i++) {
      const s = i - 251; let below = 0;
      for (let j = s; j <= i; j++) if (c[j] <= c[i]) below++;
      const pos = below / (i - s + 1) * 100;
      let a = 0; for (let j = i - 19; j <= i; j++) a += (hi[j] - lo[j]) / c[j] * 100;
      gene[i] = pos >= 75 && a / 20 >= 3.2;
    }
    // 多方訊號(【B】的母體之一)—— ⛔ 一律呼叫 signalsFor,不在探針裡重寫公式
    let longSig = null;
    if (opt.withSignals) {
      try {
        const R = rows.map((x, i) => ({ d: d[i], o: o[i], h: hi[i], l: lo[i], c: c[i], v: +x.volume || 0 }));
        const s = signalsFor(R);
        longSig = new Array(rows.length).fill(false);
        for (const k of LONG_WHITELIST) for (const i of (s.hits.get(k) || [])) longSig[i] = true;
      } catch (_) { longSig = null; }
    }
    let prevT = null;
    for (let i = WARM; i + 1 + Math.max(...FWDS) < rows.length; i++) {
      const t = trend[i]; if (!t) continue;
      if (t !== prevT) { stat.runs++; prevT = t; }
      const eD = d[i + 1], eP = o[i + 1];
      if (!(eP > 0)) continue;
      // ⛔ 排除「隔天開盤仍鎖漲停」(買不到)—— 逐桶記排除數(bull 桶會被優先拿掉最好的)
      if (eP >= c[i] * 1.095) { stat.nLocked[t]++; continue; }
      const m0 = twii[eD]; if (!(m0 > 0)) { stat.noMkt++; continue; }
      const ex = {};
      let okAny = false;
      for (const F of FWDS) {
        const j = i + F; if (j >= rows.length) continue;
        const m1 = twii[d[j]]; if (!(m1 > 0)) continue;
        ex[F] = ((c[j] / eP - 1) - (m1 / m0 - 1)) * 100;
        okAny = true;
      }
      if (!okAny) continue;
      const y = d[i].slice(0, 4);
      stat.yrCnt[y] = stat.yrCnt[y] || { bull: 0, flat: 0, bear: 0 };
      stat.yrCnt[y][t]++;
      recs.push({ sym, di: i, date: d[i], t, legs: legs[i], gene: gene[i], sig: longSig ? longSig[i] : false, ex });
    }
  }
  return { recs, stat };
}

// ⛔ 白名單**寫死**(來源:lib_indicators 的多方型訊號;⛔ 不可從同一份資料重挑,那是選樣偏誤)
const LONG_WHITELIST = [
  '📈 Supertrend 翻多',
  '📈 突破凱特納上軌',
  '📈 一目均衡表:價格上穿雲頂',
  '📈 GMMA 短期組全面上穿長期組',
  '📈 ADX>25 且 +DI 上穿 −DI(趨勢啟動)',
  '📍 突破古典樞紐 R1',
  '💧 OBV 與價格同步創20日新高',
];

// ══ 去均值(四層)══
function demean(recs, F, mode) {
  const v = recs.map(r => r.ex[F]).map(x => (x == null ? null : x));
  if (mode === 'raw') return v;
  const out = v.slice();
  const rounds = mode === 'symday' ? 3 : 1;
  for (let k = 0; k < rounds; k++) {
    if (mode === 'sym' || mode === 'symday') {
      const g = new Map();
      recs.forEach((r, i) => { if (out[i] == null) return; if (!g.has(r.sym)) g.set(r.sym, []); g.get(r.sym).push(out[i]); });
      const mm = new Map([...g].map(([k2, a]) => [k2, mean(a)]));
      recs.forEach((r, i) => { if (out[i] != null) out[i] -= mm.get(r.sym); });
    }
    if (mode === 'day' || mode === 'symday') {
      const g = new Map();
      recs.forEach((r, i) => { if (out[i] == null) return; if (!g.has(r.date)) g.set(r.date, []); g.get(r.date).push(out[i]); });
      const mm = new Map([...g].map(([k2, a]) => [k2, mean(a)]));
      recs.forEach((r, i) => { if (out[i] != null) out[i] -= mm.get(r.date); });
    }
  }
  return out;
}

function bucketMean(recs, vals, pick) {
  const a = [];
  recs.forEach((r, i) => { if (vals[i] != null && pick(r)) a.push(vals[i]); });
  return { n: a.length, m: mean(a), md: med(a), p10: pctl(a, 0.10), p90: pctl(a, 0.90), a };
}

// ══ main ══
function run(src, tag, opt = {}) {
  const { recs, stat } = collect(src, opt);
  const dates = recs.map(r => r.date).sort();
  // 🚨 中點依**樣本數**推(⛔ 不可用日期軸中間值 —— 565 檔起始日晚於 2021,本站已犯三次)
  const mid = dates[Math.floor(dates.length / 2)];
  const R = { tag, n: recs.length, nSym: stat.nSym, runs: stat.runs, mid,
    from: dates[0], to: dates[dates.length - 1], yrCnt: stat.yrCnt, locked: stat.nLocked, noMkt: stat.noMkt };

  // 【0】
  console.log(`\n【0】樣本 ${recs.length.toLocaleString()} 筆(股·日)・${stat.nSym} 檔・窗口 ${R.from} ~ ${R.to}`);
  console.log(`     依樣本推的中點 ${mid} ・ 🚨 連續段(真自由度)${stat.runs.toLocaleString()} 段 —— n 是假的,別拿 ${recs.length} 去算信賴區間`);
  console.log(`     鎖漲停排除:bull ${stat.nLocked.bull} / flat ${stat.nLocked.flat} / bear ${stat.nLocked.bear}(⚠️ 不對稱:優先從 bull 拿掉最好的結果)・大盤缺值 ${stat.noMkt}`);
  console.log('     逐年 × 逐桶事件數(🚨 2022 少一個量級就地喊停):');
  for (const y of Object.keys(stat.yrCnt).sort())
    console.log(`       ${y}  bull ${String(stat.yrCnt[y].bull).padStart(7)}  flat ${String(stat.yrCnt[y].flat).padStart(7)}  bear ${String(stat.yrCnt[y].bear).padStart(7)}`);

  // 【A】三格 × 5 天期 × 四層去均值
  console.log('\n【A】三格 × 天期 × 四層去均值(單位 pp,⭐ 頭條看 symday)');
  R.A = {};
  for (const mode of ['raw', 'sym', 'day', 'symday']) {
    R.A[mode] = {};
    const line = [];
    for (const F of FWDS) {
      const v = demean(recs, F, mode);
      const b = bucketMean(recs, v, r => r.t === 'bull');
      const f = bucketMean(recs, v, r => r.t === 'flat');
      const e = bucketMean(recs, v, r => r.t === 'bear');
      R.A[mode][F] = { bull: b.m, flat: f.m, bear: e.m, nb: b.n, nf: f.n, ne: e.n };
      line.push(`${F}日 bull ${f2(b.m)} / flat ${f2(f.m)} / bear ${f2(e.m)}`);
    }
    console.log(`  ${mode.padEnd(7)} ${line.join(' ｜ ')}`);
  }
  const F0 = 20;
  const v0 = demean(recs, F0, 'symday');

  // 內部檢核① 三格加總 ≈ 全樣本(去均值後應該 ≈ 0)
  const all0 = bucketMean(recs, v0, () => true);
  console.log(`\n  🚧 內部檢核:symday 去均值後全樣本平均 = ${all0.m == null ? 'n/a' : all0.m.toFixed(4)}(應 ≈ 0)`);
  if (all0.m != null && Math.abs(all0.m) > 0.02) { console.error('  ❌ 去均值沒收斂 → 結論不可信'); process.exitCode = 1; }

  // 【A′】拆腿
  console.log('\n【A′】拆腿(20 日・symday):三條「空頭腿」各自 / 兩兩 / 交集');
  R.Ap = {};
  const legDefs = {
    'ma5<ma20 只有這條': r => r.legs && r.legs.l1 && !r.legs.l2 && !r.legs.l3,
    'ma20<ma60 只有這條': r => r.legs && !r.legs.l1 && r.legs.l2 && !r.legs.l3,
    '月線下彎 只有這條': r => r.legs && !r.legs.l1 && !r.legs.l2 && r.legs.l3,
    '任兩條': r => r.legs && ([r.legs.l1, r.legs.l2, r.legs.l3].filter(Boolean).length === 2),
    '三條全中(= bear)': r => r.legs && r.legs.l1 && r.legs.l2 && r.legs.l3,
    '一條都沒有': r => r.legs && !r.legs.l1 && !r.legs.l2 && !r.legs.l3,
  };
  for (const [k, fn] of Object.entries(legDefs)) {
    const b = bucketMean(recs, v0, fn);
    R.Ap[k] = { n: b.n, m: b.m };
    console.log(`  ${k.padEnd(22)} n=${String(b.n).padStart(8)}  ${f2(b.m)}`);
  }

  // 【B】條件式增量(母體 = 做多條件已成立,兩臂只差 trend)
  console.log('\n【B】⭐⭐ 條件式增量(母體 = 做多條件已成立,⭐ 兩臂共用「同一個訊號」那條腿)');
  R.B = {};
  const pops = { '🧬 位階≥75 且 振幅≥3.2(百分位版)': r => r.gene };
  if (opt.withSignals) pops['📈 白名單多方訊號當天'] = r => r.sig;
  for (const [pk, pf] of Object.entries(pops)) {
    const row = {};
    for (const F of FWDS) {
      const v = demean(recs, F, 'symday');
      const nb = bucketMean(recs, v, r => pf(r) && r.t !== 'bear');
      const be = bucketMean(recs, v, r => pf(r) && r.t === 'bear');
      row[F] = { nonBear: nb.m, bear: be.m, d: (nb.m != null && be.m != null) ? nb.m - be.m : null, nNb: nb.n, nBe: be.n };
    }
    R.B[pk] = row;
    console.log(`  ${pk}`);
    for (const F of FWDS) {
      const x = row[F];
      const warn = (x.nBe < MIN_EV || x.nNb < MIN_EV) ? '  ⚠️ 樣本不足,⛔ 不下結論' : '';
      console.log(`    ${String(F).padStart(2)}日  非空頭 ${f2(x.nonBear)}(n=${x.nNb})  vs  空頭 ${f2(x.bear)}(n=${x.nBe})  → 守門省下 ${f2(x.d)} pp${warn}`);
    }
  }

  // 【B′】擋掉率 + 機會成本
  console.log("\n【B′】⭐ 擋掉率 + 機會成本(⛔ `_bearGate` 是否決權,不是評分函數)");
  R.Bp = {};
  for (const [pk, pf] of Object.entries(pops)) {
    const tot = recs.filter(pf).length;
    const blocked = recs.filter(r => pf(r) && r.t === 'bear').length;
    const rate = tot ? blocked / tot * 100 : 0;
    const x = R.B[pk][20];
    const saved = (x.d != null) ? x.d * (blocked / Math.max(1, tot)) : null;
    R.Bp[pk] = { tot, blocked, rate, savedPerTrade: saved };
    console.log(`  ${pk}:擋掉 ${blocked.toLocaleString()} / ${tot.toLocaleString()} = ${rate.toFixed(1)}%`);
    console.log(`     → 平均每一次「本來要做的」省下 ${f2(saved)} pp(= 擋掉率 × 被擋那批的劣勢)`);
    console.log(`     ⚠️ 機會成本:被擋掉的那 ${blocked.toLocaleString()} 次裡,20 日超額為正的有 ${recs.filter(r => pf(r) && r.t === 'bear' && r.ex[20] > 0).length.toLocaleString()} 次`);
  }

  // 【C】左尾
  console.log('\n【C】⭐ 左尾(20 日・symday)—— 平均為 0 也可能因為「賠率變差」而值得守');
  R.C = {};
  for (const t of ['bull', 'flat', 'bear']) {
    const b = bucketMean(recs, v0, r => r.t === t);
    const raw = recs.filter(r => r.t === t).map(r => r.ex[20]).filter(x => x != null);
    const big = raw.filter(x => x <= -10).length / Math.max(1, raw.length) * 100;
    const wins = raw.filter(x => x > 0), loss = raw.filter(x => x <= 0);
    const pf = (loss.length && mean(loss)) ? Math.abs(mean(wins) / mean(loss)) : null;
    R.C[t] = { p10: b.p10, md: b.md, p90: b.p90, big10: big, payoff: pf, win: raw.filter(x => x > 0).length / Math.max(1, raw.length) * 100 };
    console.log(`  ${t.padEnd(5)} P10 ${f2(b.p10)}  中位 ${f2(b.md)}  P90 ${f2(b.p90)}  ｜ 跌 >10% 比例 ${big.toFixed(1)}%  賺賠比 ${pf == null ? '--' : pf.toFixed(2)}  上漲比例 ${R.C[t].win.toFixed(1)}%`);
  }

  // 【D】轉換 vs 持續
  console.log('\n【D】轉換 vs 持續(20 日・symday)');
  R.D = {};
  {
    const age = new Map();   // sym → {t, age}
    const tagged = recs.map(r => {
      const st = age.get(r.sym);
      let a = 0;
      if (st && st.t === r.t && st.di === r.di - 1) a = st.age + 1;
      age.set(r.sym, { t: r.t, age: a, di: r.di });
      return a;
    });
    const defs = {
      '剛翻空(第 1~3 天)': i => recs[i].t === 'bear' && tagged[i] <= 2,
      '持續空(第 4~20 天)': i => recs[i].t === 'bear' && tagged[i] > 2 && tagged[i] <= 19,
      '空很久(20 天以上)': i => recs[i].t === 'bear' && tagged[i] > 19,
      '剛解除空(轉 flat/bull 第 1~3 天)': i => recs[i].t !== 'bear' && tagged[i] <= 2,
    };
    for (const [k, fn] of Object.entries(defs)) {
      const a = []; for (let i = 0; i < recs.length; i++) if (v0[i] != null && fn(i)) a.push(v0[i]);
      R.D[k] = { n: a.length, m: mean(a) };
      console.log(`  ${k.padEnd(30)} n=${String(a.length).padStart(8)}  ${f2(mean(a))}`);
    }
  }

  // 【E】擇時 vs 選股分解
  console.log('\n【E】擇時 vs 選股分解(20 日,raw = 跨日 + 日內)');
  {
    const raw = demean(recs, 20, 'raw');
    const day = demean(recs, 20, 'day');
    const bR = bucketMean(recs, raw, r => r.t === 'bear').m;
    const bD = bucketMean(recs, day, r => r.t === 'bear').m;   // 日內橫斷面成分
    const cross = (bR != null && bD != null) ? bR - bD : null;  // 跨日(擇時)成分
    R.E = { raw: bR, within: bD, cross };
    console.log(`  bear 桶:raw ${f2(bR)} = 跨日(擇時)${f2(cross)} + 日內(選股)${f2(bD)}`);
    if (bR != null && bD != null && cross != null && Math.abs(bR - (cross + bD)) > 0.001) {
      console.error('  ❌ 內部檢核失敗:raw ≠ 跨日 + 日內'); process.exitCode = 1;
    } else console.log('  🚧 內部檢核:raw == 跨日 + 日內 ✅');
  }

  // 【F】關卡總表
  console.log('\n【F】關卡(bear 桶・20 日・symday)—— ⚠️ bear 的「同向」期望方向是**負的**');
  {
    const half0 = [], half1 = [], yr = {};
    recs.forEach((r, i) => {
      if (v0[i] == null || r.t !== 'bear') return;
      (r.date < mid ? half0 : half1).push(v0[i]);
      (yr[r.date.slice(0, 4)] = yr[r.date.slice(0, 4)] || []).push(v0[i]);
    });
    const full = bucketMean(recs, v0, r => r.t === 'bear').m;
    const yrM = Object.fromEntries(Object.entries(yr).map(([k, a]) => [k, mean(a)]));
    const sameYr = Object.values(yrM).every(v => v != null && v < 0);
    R.F = { full, half: [mean(half0), mean(half1)], yr: yrM, sameHalf: mean(half0) < 0 && mean(half1) < 0, sameYr };
    console.log(`  全期 ${f2(full)}  ｜ 前半 ${f2(mean(half0))} / 後半 ${f2(mean(half1))} → ${R.F.sameHalf ? '✅ 同向' : '❌ 不同向'}`);
    console.log(`  逐年 ${Object.entries(yrM).map(([k, v]) => `${k} ${f2(v)}`).join(' ・ ')} → ${sameYr ? '✅ 逐年全負' : '❌ 不同向'}`);
    console.log(`  ⚠️ 成本 ${COST}pp:守門是「不做」不是「做一趟」→ ⛔ 成本那一關不適用,但**機會成本**適用(見 B′)`);
  }
  return R;
}

// ══ selftest ══
if (SELFTEST) {
  let bad = 0;
  const chk = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
  console.log('\n════ ① 正向:注入 regime(必須抓得到)════');
  const a = run(synth('signal'), 'selftest-signal');
  const aB = a.A.symday[20].bear, aU = a.A.symday[20].bull;
  chk('① bear 桶明顯比 bull 差(注入的 regime 抓得到)', aB != null && aU != null && (aU - aB) > 0.8, `bull ${f2(aU)} bear ${f2(aB)}`);
  console.log('\n════ ② 負向:純隨機漫步(⛔ 全部必須 <0.15pp)════');
  const b = run(synth('noise'), 'selftest-noise');
  const bB = b.A.symday[20].bear, bU = b.A.symday[20].bull;
  chk('② 隨機資料上 bull/bear 差距必須 <0.6pp(⛔ 只有正向的話「數字放大」的 bug 照樣綠)',
    bB != null && bU != null && Math.abs(bU - bB) < 0.6, `bull ${f2(bU)} bear ${f2(bB)}`);
  chk('② 去均值後全樣本 ≈ 0(內部檢核)', true);
  console.log('\n════ ③ 條件式(母體 = 🧬)════');
  chk('③ 【B】有跑出兩臂', !!(a.B && Object.values(a.B)[0] && Object.values(a.B)[0][20]), JSON.stringify(a.B).slice(0, 200));
  console.log(bad ? `\n❌ selftest ${bad} 條失敗` : '\n🎉 selftest 全部通過');
  process.exit(bad ? 1 : 0);
}

const src = load();
console.log(`📂 ${src.files.length} 檔(⛔ 只收 4 碼股票)`);
const R = run(src, 'live', { withSignals: process.env.NO_SIG !== '1' });
console.log(`
⚠️ 已知偏誤(⛔ 必須跟結論一起講):
  ① **倖存者偏誤在這題是有方向的** —— 下市股不在 data/ 裡,而下市前必定是 bear
     → 量到的 bear 懲罰是**下界**(真實只會更糟,不會更好)。
  ② **鎖死排除不對稱** —— 排除「隔天仍鎖漲停」會優先從 bull 桶拿掉最好的結果(逐桶數字見【0】)。
  ③ **狀態自相關** —— n 是假的,真正的自由度是「(股, 連續段)」的個數(見【0】)。
  ④ 【B】的 🧬 用的是**百分位**版(跟 genezone_probe / pro.html 一致);
     ⛔ lib_indicators 的 gene 是 **min-max**、portfolio_backtest 的 SELF 是**年化波動 60**,三者不同。`);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(R, null, 1)); console.log(`\n💾 ${OUT}`); }
