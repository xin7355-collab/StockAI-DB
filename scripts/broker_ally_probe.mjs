#!/usr/bin/env node
/**
 * 🕸️ 分點「同盟集團」(Brokerage Co-movement Graph)—— 只讀探針
 *
 * ❓ 來源:2026-08-31 使用者上傳的 Gemini 對話(籌碼策略)。它列的東西本專案幾乎都測過了
 *    (突破×籌碼集中度 ❌、剔除隔日沖 🚨方向相反、投信鎖碼 ⚠️反向、千張大戶背離 ❌),
 *    ⭐ **只有這一條是「沒測過 + 資料剛好夠」的**:
 *      「主力為避免被追蹤,把大單分散到多個分點同步下單 →
 *        算分點兩兩的 cosine similarity,>0.85 視為同一個影子集團;
 *        當同盟內 ≥3 個分點同天大買 → 高信賴度主力建倉」
 *
 * ⭐⭐ **對照組是這題的成敗關鍵**(文件自己沒講):
 *    事件是「**3 家**券商同天大買同一檔」。如果對照組拿「單一券商大買」,
 *    量到的會是「**很多人一起買**」的效果,⛔ 不是「**同盟**」的效果。
 *    → 對照組必須是「同樣 ≥3 家同天大買,但**彼此不是同盟**」。
 *
 * ⛔ 循環論證防護:同盟關係在**前半段**學(cosine similarity),
 *    事件與報酬只在**後半段**驗收(再反向做一次)。
 *
 * ⛔ 沿用鐵則:進場=隔天開盤(分點收盤後才公布)・排除開盤漲停鎖死・扣同期加權・
 *    (股票)10 日去重・成本 0.44% 對照。
 *
 * 用法:
 *   CHIPS_DEEP_DIR=/tmp/deepfull/chips_deep node --max-old-space-size=6144 scripts/broker_ally_probe.mjs
 *   node scripts/broker_ally_probe.mjs --selftest    # 注入一組必然同步的假券商,驗 harness
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DEEP_DIR = process.env.CHIPS_DEEP_DIR || path.join(ROOT, 'chips_deep');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const TOPB = 120;        // 只算前 N 家券商的兩兩相似度(N² 成長,120 → 7,140 對)
const BUY_TH = 0.5;      // 淨買 ≥ 當日量 0.5% 才算「大買」
const MIN_CO = 30;       // 兩家至少要共同出現在這麼多個(股·日)才算得出相似度
const DEDUP = 10;
const COST = 0.44;
const MIN_N = 200;

const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const sgn = (x) => (x >= 0 ? '+' : '');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

function loadDeep() {
  const files = fs.readdirSync(DEEP_DIR).filter((f) => f.endsWith('.json.gz')).sort();
  const days = []; const nm = {};
  for (const f of files) {
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DEEP_DIR, f))).toString('utf8'));
      if (j && j.d && j.s) { days.push(j); Object.assign(nm, j.nm || {}); }
    } catch { }
  }
  return { days, nm };
}

function loadPrices(need) {
  const px = new Map();
  for (const sym of need) {
    const p = path.join(DATA_DIR, `${sym}.json`);
    if (!fs.existsSync(p)) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < 260) continue;
    const o = { dates: [], close: [], high: [], low: [], open: [], vol: [] };
    for (const r of rows) {
      if (!r || r.close == null) continue;
      o.dates.push(String(r.date).replace(/\//g, '-'));
      o.close.push(+r.close); o.high.push(+r.high); o.low.push(+r.low);
      o.open.push(+r.open); o.vol.push(+(r.volume || 0));
    }
    if (o.dates.length < 260) continue;
    o.at = new Map(); o.dates.forEach((d, i) => o.at.set(d, i));
    px.set(sym, o);
  }
  return px;
}

function loadIndex() {
  const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '^TWII.json'), 'utf8'))
    .filter((r) => r && r.close != null);
  const m = new Map();
  rows.forEach((r) => m.set(String(r.date).replace(/\//g, '-'), +r.close));
  return m;
}

function exRet(px, idxMap, sym, i, fwd) {
  const o = px.get(sym);
  const entry = o.open[i + 1], exit = o.close[i + fwd];
  if (!(entry > 0) || !(exit > 0)) return null;
  const bi = idxMap.get(o.dates[i + 1]), bj = idxMap.get(o.dates[i + fwd]);
  if (!bi || !bj) return null;
  return (exit / entry - 1) * 100 - (bj / bi - 1) * 100;
}

function tradable(px, sym, i) {
  const o = px.get(sym);
  const pc = o.close[i], op = o.open[i + 1];
  if (!(pc > 0) || !(op > 0)) return false;
  return !(op >= pc * 1.0995 && o.high[i + 1] === o.low[i + 1]);
}

function main() {
  console.log('🕸️ 分點「同盟集團」(Brokerage Co-movement Graph)回測\n');
  const { days, nm } = loadDeep();
  console.log(`📥 深歷史 ${days.length} 天(${days[0]?.d} ~ ${days[days.length - 1]?.d})`);
  if (days.length < 240 && !SELFTEST) { console.log('⏳ 不足 240 天,不跑'); process.exit(2); }
  const need = new Set();
  for (const d of days) for (const s of Object.keys(d.s)) need.add(s);
  const px = loadPrices(need);
  const idxMap = loadIndex();
  console.log(`📈 K 線 ${px.size} 檔`);
  const MID = Math.floor(days.length / 2);

  // ── 前半段:挑前 TOPB 家券商 + 算兩兩 cosine similarity ─────────
  //    向量 = 每個(股·日)的「淨額佔當日成交量 %」(⛔ 不用絕對張數,
  //    否則大券商的向量長度壓過一切,相似度變成「誰都跟大券商像」)。
  const tot = new Map();
  for (let dn = 0; dn < MID; dn++) {
    for (const [sym, arr] of Object.entries(days[dn].s)) {
      const o = px.get(sym); if (!o) continue;
      const i = o.at.get(days[dn].d); if (i == null) continue;
      const vol = o.vol[i]; if (!(vol > 0)) continue;
      for (const x of arr) {
        const r = (+x[1] || 0) / vol * 100;
        tot.set(String(x[0]), (tot.get(String(x[0])) || 0) + Math.abs(r));
      }
    }
  }
  const topB = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPB).map(([b]) => b);
  const bIdx = new Map(topB.map((b, i) => [b, i]));
  console.log(`🏦 前 ${topB.length} 家券商進入相似度計算(${topB.length * (topB.length - 1) / 2} 對)`);

  // 稀疏累積:只在「同一(股·日)同時出現」時更新內積(⛔ 不建 N×M 稠密矩陣,會 OOM)
  const N = topB.length;
  const dot = new Float64Array(N * N);
  const norm = new Float64Array(N);
  const co = new Int32Array(N * N);
  for (let dn = 0; dn < MID; dn++) {
    for (const [sym, arr] of Object.entries(days[dn].s)) {
      const o = px.get(sym); if (!o) continue;
      const i = o.at.get(days[dn].d); if (i == null) continue;
      const vol = o.vol[i]; if (!(vol > 0)) continue;
      const here = [];
      for (const x of arr) {
        const bi = bIdx.get(String(x[0])); if (bi == null) continue;
        const r = (+x[1] || 0) / vol * 100;
        if (r !== 0) here.push([bi, r]);
      }
      for (let a = 0; a < here.length; a++) {
        norm[here[a][0]] += here[a][1] * here[a][1];
        for (let b = a + 1; b < here.length; b++) {
          const p = here[a][0] * N + here[b][0], q = here[b][0] * N + here[a][0];
          const v = here[a][1] * here[b][1];
          dot[p] += v; dot[q] += v; co[p]++; co[q]++;
        }
      }
    }
  }
  // 同盟關係:sim ≥ TH 且共同出現 ≥ MIN_CO
  const allyOf = new Map();   // b -> Set(同盟)
  const sims = [];
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      if (co[a * N + b] < MIN_CO) continue;
      const s2 = dot[a * N + b] / (Math.sqrt(norm[a]) * Math.sqrt(norm[b]) || 1);
      if (isFinite(s2)) sims.push([s2, topB[a], topB[b], co[a * N + b]]);
    }
  }
  sims.sort((x, y) => y[0] - x[0]);
  console.log(`🔗 可算相似度的配對 ${sims.length.toLocaleString()} 對 ・最高 ${nf(sims[0]?.[0], 3)} ・中位 ${nf(sims[Math.floor(sims.length / 2)]?.[0], 3)}`);
  console.log('   前 8 名最相似的配對(訓練段):');
  for (const [s2, a, b, c] of sims.slice(0, 8)) {
    console.log(`     ${nf(s2, 3)}  ${(nm[a] || a).padEnd(9)} ↔ ${(nm[b] || b).padEnd(9)}(共同出現 ${c.toLocaleString()} 次)`);
  }

  const results = [];
  for (const TH of [0.85, 0.7, 0.5]) {
    allyOf.clear();
    let pairs = 0;
    for (const [s2, a, b] of sims) {
      if (s2 < TH) break;
      pairs++;
      if (!allyOf.has(a)) allyOf.set(a, new Set());
      if (!allyOf.has(b)) allyOf.set(b, new Set());
      allyOf.get(a).add(b); allyOf.get(b).add(a);
    }
    if (!pairs) { console.log(`\n═ 門檻 sim ≥ ${TH}:0 對配對 ⏳ 跳過`); continue; }

    // ── 後半段驗收:同天 ≥3 家大買同一檔 → 分成「同盟」與「非同盟」兩組 ──
    const ally = [], nonAlly = [];
    const lastA = new Map(), lastN = new Map();
    for (let dn = MID; dn < days.length; dn++) {
      for (const [sym, arr] of Object.entries(days[dn].s)) {
        const o = px.get(sym); if (!o) continue;
        const i = o.at.get(days[dn].d);
        if (i == null || i < 250 || i + 21 >= o.dates.length) continue;
        const vol = o.vol[i]; if (!(vol > 0)) continue;
        const big = [];
        for (const x of arr) {
          const net = +x[1] || 0;
          if (net > 0 && net / vol * 100 >= BUY_TH && bIdx.has(String(x[0]))) big.push(String(x[0]));
        }
        if (big.length < 3) continue;
        // 這批大買的券商裡,有沒有「≥3 家互為同盟」的子集?
        let allyHit = false;
        for (const b of big) {
          const s3 = allyOf.get(b); if (!s3) continue;
          let c = 1;
          for (const b2 of big) if (b2 !== b && s3.has(b2)) c++;
          if (c >= 3) { allyHit = true; break; }
        }
        if (!tradable(px, sym, i)) continue;
        const e10 = exRet(px, idxMap, sym, i, 10), e20 = exRet(px, idxMap, sym, i, 20);
        if (e10 == null) continue;
        const bag = allyHit ? ally : nonAlly, last = allyHit ? lastA : lastN;
        const pv = last.get(sym);
        if (pv != null && dn - pv < DEDUP) continue;
        last.set(sym, dn);
        bag.push({ sym, dnum: dn, e10, e20 });
      }
    }
    const d10 = mean(ally.map((e) => e.e10)) - mean(nonAlly.map((e) => e.e10));
    const a20 = ally.filter((e) => e.e20 != null), n20 = nonAlly.filter((e) => e.e20 != null);
    const d20 = mean(a20.map((e) => e.e20)) - mean(n20.map((e) => e.e20));
    const w = ally.length ? ally.filter((e) => e.e10 > 0).length / ally.length * 100 : NaN;
    const cw = nonAlly.length ? nonAlly.filter((e) => e.e10 > 0).length / nonAlly.length * 100 : NaN;
    console.log(`\n═ 門檻 sim ≥ ${TH}(${pairs} 對配對 ・${allyOf.size} 家券商入盟)═`);
    if (ally.length < MIN_N || nonAlly.length < MIN_N) {
      console.log(`   同盟事件 ${ally.length} ・對照(非同盟 3 家同買)${nonAlly.length} ⏳ 樣本不足`);
      continue;
    }
    console.log(`   同盟 ≥3 家同天大買:n=${ally.length.toLocaleString()} ・對照(非同盟 ≥3 家同買)n=${nonAlly.length.toLocaleString()}`);
    console.log(`   10日 ${sgn(d10)}${nf(d10)}pp ・20日 ${sgn(d20)}${nf(d20)}pp ・勝率 ${nf(w, 1)}%(對照 ${nf(cw, 1)}%)`);
    // 前後半(驗收段再切兩半)
    const M2 = Math.floor((MID + days.length) / 2);
    const h = (lo, hi) => {
      const a2 = ally.filter((e) => e.dnum >= lo && e.dnum < hi), b2 = nonAlly.filter((e) => e.dnum >= lo && e.dnum < hi);
      return a2.length > 60 && b2.length > 60 ? mean(a2.map((e) => e.e10)) - mean(b2.map((e) => e.e10)) : NaN;
    };
    const q1 = h(MID, M2), q2 = h(M2, days.length);
    console.log(`   驗收段前半 ${sgn(q1)}${nf(q1)} / 後半 ${sgn(q2)}${nf(q2)}` + ((q1 > 0) === (q2 > 0) ? '' : ' 🚨不同向'));
    results.push({ TH, d10, d20, n: ally.length, same: (q1 > 0) === (q2 > 0) });
  }

  console.log(`\n📌 判讀:每一行是「同盟 ≥3 家同買」減「**非同盟** ≥3 家同買」的 pp 差`);
  console.log(`   —— 量的是「同盟」本身的資訊,⛔ 不是「很多人一起買」的資訊。`);
  console.log(`   成立門檻:10 日差 ≥ ${COST}pp(成本)且驗收段前後半同向且 n ≥ ${MIN_N}。`);
  return { results, sims };
}

// ── 🧪 selftest:注入 3 家「必然同步、且買了會漲」的假券商 ─────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ally-'));
  const dd = path.join(tmp, 'deep'), pd = path.join(tmp, 'data');
  fs.mkdirSync(dd); fs.mkdirSync(pd);
  const NSYM = 40, NBAR = 800, NDAY = 400;
  const dates = [];
  for (let d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(pd, '^TWII.json'),
    JSON.stringify(dates.map((dt) => ({ date: dt, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  const allyBuy = (s2, b) => ((b + s2 * 5) % 19 === 0);      // 同盟三家一起買(買了會漲)
  // ⚠️ 散兵的排班必須**每天輪換不同組合** —— 第一版用 `(b+f*3+s2*7)%11`,
  //    f=0 與 f=11 的排班完全一樣 → 它們相似度 1.000 也變成同盟,而且每天只有 1 家買
  //    → 對照組 0 筆(selftest 抓到)。改用雜湊讓每天挑到不同的 4 家。
  const _h = (f, s2, b) => ((f * 2654435761 + s2 * 40503 + b * 97) >>> 0) % 100;
  const randBuy = (f, s2, b) => _h(f, s2, b) < 33;   // 12 家 × 33% ≈ 每檔每天 4 家同買(對照組)
  const syms = [];
  for (let s2 = 0; s2 < NSYM; s2++) {
    const sym = String(6000 + s2); syms.push(sym);
    const rows = []; let c = 100;
    for (let b = 0; b < NBAR; b++) {
      const boost = [...Array(10).keys()].some((k) => b - 1 - k >= 0 && allyBuy(s2, b - 1 - k));
      const prevC = c;
      c *= 1 + (boost ? 0.004 : -0.0004);
      rows.push({ date: dates[b], open: +prevC.toFixed(2), high: +(Math.max(prevC, c) * 1.005).toFixed(2),
                  low: +(Math.min(prevC, c) * 0.995).toFixed(2), close: +c.toFixed(2), volume: 10_000_000 });
    }
    fs.writeFileSync(path.join(pd, `${sym}.json`), JSON.stringify(rows));
  }
  for (let b = NBAR - NDAY; b < NBAR - 25; b++) {
    const sMap = {};
    syms.forEach((sym, s2) => {
      const arr = [];
      if (allyBuy(s2, b)) for (let k = 0; k < 3; k++) arr.push([`A${k}00`, 300_000, 100]);
      for (let f = 0; f < 12; f++) if (randBuy(f, s2, b)) arr.push([String(7000 + f), 200_000, 100]);
      if (arr.length) sMap[sym] = arr;
    });
    fs.writeFileSync(path.join(dd, `${dates[b]}.json.gz`),
      zlib.gzipSync(Buffer.from(JSON.stringify({ d: dates[b], n: NSYM, k: 15,
        nm: { A000: '同盟甲', A100: '同盟乙', A200: '同盟丙' }, s: sMap }))));
  }
  DEEP_DIR = dd; DATA_DIR = pd;
  console.log('🧪 --selftest:A000/A100/A200 三家永遠同進退且買了會漲;7000+ 那批也常 3 家同買但無效。\n');
}

if (SELFTEST) {
  selftest();
  const { results, sims } = main();
  const bad = [];
  const top = sims[0];
  if (!top || !['A000', 'A100', 'A200'].includes(top[1])) bad.push(`最相似的配對不是注入的同盟(${top && top[1]})`);
  const best = results.filter((r) => r.n >= 100).sort((a, b) => b.d10 - a.d10)[0];
  if (!best || !(best.d10 > 1)) bad.push(`同盟組沒有抓到注入的邊際(${best ? nf(best.d10) : 'null'})`);
  if (bad.length) { console.error('\n❌ SELFTEST 失敗:'); bad.forEach((b) => console.error('   - ' + b)); process.exit(1); }
  console.log('\n✅ BROKER_ALLY_PROBE_SELFTEST_PASS(相似度找得到同盟、對照組也隔離得開)');
} else {
  main();
}
