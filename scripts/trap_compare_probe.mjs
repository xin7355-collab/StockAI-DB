#!/usr/bin/env node
/**
 * ⚖️ 分點版「解套價」vs K 線版「套牢區」:哪一條線比較會「壓得住」股價?(V79.0.2)
 *
 * 使用者(拿國巨 2327 問):「是否 FinMind 付費 key 還是比 K 線看套牢區比較準」。
 * ⭐ 實際要決定的事:要不要為了這條再買 FinMind Sponsor(分點資料 10/01 起停了)。
 *
 * 四條「現價上方的壓力線」,⛔ 一律只用當天(含)以前的資料:
 *   B3  分點版(舊 App 預設 3 日)—— 照 872f950^ `_renderBrokerFenDian`:近 N 日買超前 15 家、≥30 張、
 *       均價 > 現價 的那幾家,張數加權均價(= 舊卡的「漲到 X 附近會卡住」)
 *   B20 同上,20 日
 *   KU  K 線版 `_trappedRatio` 的 unlockPx(近 121 根典型價 > 現價那部分的量加權均價,V79.0.1 卡上那個數)
 *   KL  K 線版 `_overheadSupply` 第一道套牢層下緣(lib_overhead.mjs,⛔ 不另寫一份)
 *
 * 結果:20 個交易日內盤中有沒有碰到那條線;碰到之後 10 天內先「收盤站上 3%」(穿過去)還是先
 *       「收盤跌回 3%」(被壓回)。
 * 🎯 主對照組 SHAM = 同一檔、隨機挑另一個取樣日、**同樣距現價 %** 的假線 ——
 *    距離本身就決定了碰不碰得到、碰到後回不回得來(遠的線本來就難穿),⛔ 不扣掉就會把距離的功勞算給線。
 *    lift = 被壓回率(真線)− 被壓回率(假線)。lift 越大 = 那條線越「是真的牆」。
 *
 * ⚠️ chips_deep 每天只存買超 / 賣超各前 15 家(淨額 + 當日均價)→ 多日均價用「|淨額| 加權當日均價」近似
 *    舊採礦的 pv/vol(成交值 ÷ 成交量);淨額外面的分點看不到(舊 App 也只看前 15 家)。
 *
 * 跑法:
 *   node scripts/trap_compare_probe.mjs --selftest
 *   CHIPS_DEEP_DIR=<git archive origin/chips_deep 解開的 chips_deep/> DATA_DIR=<origin/data 的 data/> \
 *     node --max-old-space-size=8000 scripts/trap_compare_probe.mjs out.json
 *   LOOKAHEAD=1 … --selftest   # 🧪 注入前視,selftest 必須紅
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { buildBuckets, layersFrom } from './lib_overhead.mjs';

const SELFTEST = process.argv.includes('--selftest');
const LOOKAHEAD = process.env.LOOKAHEAD === '1';
const LIMIT = +(process.env.LIMIT || 0);
const STEP = 5;            // 每 5 個交易日取樣一次
const FWD = 20;            // 碰線窗口
const AFTER = 10;          // 碰到後觀察天數
const BAND = 0.03;         // 穿過去 / 被壓回 的判準:收盤離線 3%
const MIN_SHARE = 0.02;    // 套牢層門檻(同 _overheadSupply)
const WIN = 120;
const METHODS = ['B3', 'B20', 'KU', 'KL'];
const DIST_BK = [[1, 5], [5, 15], [15, 60]];

// ── 隨機(固定種子)──
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ── 分點版:照舊 App 規則 ──
// days: [[ [code, net股, avg], ... ], ...]  (只放視窗內有資料的日子)
export function brokerUnlock(days, px) {
  const agg = new Map();
  for (const rows of days) for (const [code, net, avg] of rows) {
    let a = agg.get(code); if (!a) agg.set(code, a = { net: 0, pv: 0, w: 0 });
    a.net += net;
    if (avg > 0) { a.pv += Math.abs(net) * avg; a.w += Math.abs(net); }
  }
  const buy = [...agg.values()].filter(a => a.net > 0).sort((x, y) => y.net - x.net).slice(0, 15);
  let tr = 0, pf = 0, tc = 0;
  for (const a of buy) {
    const lots = Math.round(a.net / 1000), avg = a.w ? a.pv / a.w : 0;
    if (lots < 30 || !(avg > 0)) continue;
    if (avg > px) { tr += lots; tc += avg * lots; } else pf += lots;
  }
  if (tr + pf === 0) return null;
  return { pct: tr / (tr + pf) * 100, px: tr ? tc / tr : null, lots: tr + pf };
}

// ── K 線版 ──
export function trappedUnlock(win, px) {          // 同 index.html _trappedRatio(只取 unlockPx)
  let tot = 0, ab = 0, abv = 0;
  for (const b of win) { const t = (b.h + b.l + b.c) / 3; tot += b.v; if (t > px) { ab += b.v; abv += t * b.v; } }
  if (!(tot > 0)) return null;
  return { pct: ab / tot * 100, px: ab > 0 ? abv / ab : null };
}
export function firstLayer(win, px) {
  const L = layersFrom(buildBuckets(win), px, MIN_SHARE);
  return L.length ? L[0].lo : null;
}
export function kLevels(R, i) {
  // ⭐ 零前視:視窗只到 i(收盤後才算)
  const lo = LOOKAHEAD ? i - WIN + 1 + FWD : i - WIN + 1, hi = LOOKAHEAD ? i + FWD : i;
  const win = R.slice(Math.max(0, lo), hi + 1), c = R[i].c;
  const tu = trappedUnlock(R.slice(Math.max(0, (LOOKAHEAD ? i + FWD : i) - WIN), (LOOKAHEAD ? i + FWD : i) + 1), c);
  return { KU: tu && tu.px, KL: firstLayer(win, c) };
}

// ── 結果:碰到沒 / 碰到後穿過去還是被壓回 ──
export function outcome(R, i, L) {
  let j0 = -1;
  for (let j = i + 1; j <= i + FWD && j < R.length; j++) if (R[j].h >= L) { j0 = j; break; }
  if (j0 < 0) return 'miss';
  for (let j = j0; j <= j0 + AFTER && j < R.length; j++) {
    if (R[j].c > L * (1 + BAND)) return 'thru';
    if (R[j].c < L * (1 - BAND)) return 'rej';
  }
  return 'stuck';
}

// ── 統計 ──
const newCell = () => ({ n: 0, miss: 0, thru: 0, rej: 0, stuck: 0 });
const addCell = (c, o) => { c.n++; c[o]++; };
const rejRate = c => { const t = c.n - c.miss; return t ? c.rej / t * 100 : null; };
const thruRate = c => { const t = c.n - c.miss; return t ? c.thru / t * 100 : null; };
function zTest(a, b) {          // 被壓回率兩比例 z
  const n1 = a.n - a.miss, n2 = b.n - b.miss; if (n1 < 30 || n2 < 30) return null;
  const p1 = a.rej / n1, p2 = b.rej / n2, p = (a.rej + b.rej) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)); return se ? (p1 - p2) / se : null;
}

// ── 主流程(真實資料與 selftest 共用)──
// stocks: [[sym, R]];  broker(sym, i, N) → brokerUnlock 結果或 null
export function run(stocks, broker, sampleOk, seed = 7) {
  const rand = rng(seed);
  const cells = {};       // key = `${m}|${part}` part ∈ all / d1-5 … / h1 / h2 / paired
  const cell = k => (cells[k] ||= newCell());
  const events = [];
  for (const [sym, R] of stocks) {
    const idx = [];
    for (let i = WIN; i + FWD + AFTER < R.length; i += STEP) if (sampleOk(sym, R, i)) idx.push(i);
    if (idx.length < 2) continue;
    for (const i of idx) {
      const c = R[i].c, lv = kLevels(R, i);
      for (const N of [3, 20]) { const b = broker(sym, R, i, N); lv['B' + N] = b && b.px; }
      for (const m of METHODS) {
        const L = lv[m];
        if (!(L > c * 1.01) || L > c * 1.6) continue;
        const dist = (L / c - 1) * 100;
        let i2 = i; for (let t = 0; t < 8 && i2 === i; t++) i2 = idx[Math.floor(rand() * idx.length)];
        if (i2 === i) continue;
        const o = outcome(R, i, L), os = outcome(R, i2, R[i2].c * (1 + dist / 100));
        events.push({ m, sym, d: R[i].d, i, dist, o, os, L });
      }
    }
  }
  // 配對子集:同一個 (檔, 日) B3 與 KL 都有
  const has = new Map();
  for (const e of events) { const k = e.sym + '|' + e.i; if (!has.has(k)) has.set(k, new Set()); has.get(k).add(e.m); }
  const ds = events.map(e => e.d).sort(); const mid = ds[Math.floor(ds.length / 2)] || '';
  for (const e of events) {
    const parts = ['all', e.d < mid ? 'h1' : 'h2'];
    const bk = DIST_BK.find(([a, b]) => e.dist >= a && e.dist < b); if (bk) parts.push(`d${bk[0]}-${bk[1]}`);
    const s = has.get(e.sym + '|' + e.i); if (s.has('B3') && s.has('KL')) parts.push('pairBK');
    for (const p of parts) { addCell(cell(`${e.m}|${p}|real`), e.o); addCell(cell(`${e.m}|${p}|sham`), e.os); }
  }
  const summ = {};
  for (const m of METHODS) for (const p of ['all', 'h1', 'h2', 'pairBK', ...DIST_BK.map(([a, b]) => `d${a}-${b}`)]) {
    const r = cells[`${m}|${p}|real`], s = cells[`${m}|${p}|sham`];
    if (!r) continue;
    const rr = rejRate(r), sr = rejRate(s);
    summ[`${m}|${p}`] = {
      n: r.n, touch: (r.n - r.miss) / r.n * 100, touchSham: (s.n - s.miss) / s.n * 100,
      rej: rr, rejSham: sr, lift: rr != null && sr != null ? rr - sr : null,
      thru: thruRate(r), thruSham: thruRate(s), z: zTest(r, s),
      medDist: (() => { const a = events.filter(e => e.m === m).map(e => e.dist).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; })(),
    };
  }
  return { summ, events: events.length, mid };
}

// ═══ 🧪 selftest ═══
// 每檔每 40 根埋一個取樣日 i,在現價上方 d%(每個取樣日隨機 2~15%)放一條「真線」L,
// 注入時:之後 5 根爬到 L 碰一下 → 接著 10 根跌回 L×0.9(被壓回);沒注入:碰到之後繼續漲到 L×1.1(穿過去)。
// 真線由 broker 回呼交給 run()(當成 B3)→ 測的是整條管線:碰線判定 / 假線抽樣 / lift 計算。
function synthPlanted(seed, inject) {
  const r = rng(seed), R = [], plant = new Map();
  let p = 50 + r() * 100;
  const push = (px, v = 1e6) => { const k = R.length; R.push({ d: new Date(Date.UTC(2023, 0, 1 + k)).toISOString().slice(0, 10), o: px, h: px * 1.004, l: px * 0.996, c: px, v }); };
  for (let k = 0; k <= WIN; k++) { p *= 1 + (r() - 0.5) * 0.03; push(p); }
  for (let blk = 0; blk < 6; blk++) {
    const i = R.length - 1, c = R[i].c, d = 2 + r() * 13, L = c * (1 + d / 100);
    plant.set(i, L);
    for (let q = 1; q <= 5; q++) push(c + (L * 1.002 - c) * q / 5);
    const tgt = inject ? L * 0.9 : L * 1.1, st = R[R.length - 1].c;
    for (let q = 1; q <= 10; q++) push(st + (tgt - st) * q / 10);
    p = R[R.length - 1].c;
    for (let q = 0; q < 25; q++) { p *= 1 + (r() - 0.5) * 0.03; push(p); }
  }
  for (let q = 0; q < FWD + AFTER + 2; q++) { p *= 1 + (r() - 0.5) * 0.03; push(p); }
  return { R, plant };
}
function plantedRun(inject, seed) {
  const S = Array.from({ length: 200 }, (_, k) => ['P' + k, synthPlanted(seed + k, inject)]);
  const P = new Map(S.map(([sy, x]) => [sy, x.plant]));
  return run(S.map(([sy, x]) => [sy, x.R]), (sym, R, i, N) => (N === 3 && P.get(sym).has(i) ? { px: P.get(sym).get(i) } : null),
    (sym, R, i) => P.get(sym).has(i), seed);
}
function synthWalk(seed) {
  const r = rng(seed), R = []; let p = 100;
  for (let k = 0; k < 400; k++) { p *= 1 + (r() - 0.5) * 0.03; R.push({ d: new Date(Date.UTC(2023, 0, 1 + k)).toISOString().slice(0, 10), o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1e6 * (1 + r() * 3) }); }
  return R;
}
function selftest() {
  const f1 = v => v == null ? '—' : v.toFixed(1);
  const bad = [], okk = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad.push(n); };
  // ① 分點彙總照舊規則
  const days = [[['A', 500000, 110], ['B', 200000, 90], ['C', 20000, 120]], [['A', 100000, 120], ['D', -300000, 100]]];
  const b = brokerUnlock(days, 100);
  // A: 600 張、均價 (500k×110+100k×120)/600k=111.67 → 套牢;B 200 張 90 → 賺錢;C 20 張 <30 略過
  okk('① 分點彙總:套牢 600 張 / 賺錢 200 張', b && Math.round(b.pct) === 75 && Math.abs(b.px - 111.6667) < 0.01, JSON.stringify(b));
  okk('① 只收淨買超(D 賣超不算)', b && b.lots === 800, JSON.stringify(b));
  const t16 = Array.from({ length: 20 }, (_, k) => ['X' + k, (20 - k) * 1e5, 150]);
  okk('① 只取前 15 家', brokerUnlock([t16], 100).lots === [...Array(15)].reduce((s, _, k) => s + (20 - k) * 100, 0), '');
  // ② 結果判定
  const mk = arr => arr.map((c, k) => ({ d: 'x' + k, o: c, h: c, l: c, c, v: 1 }));
  okk('② 碰到後跌回 → rej', outcome(mk([100, 104, 110, 106, 100]), 0, 110) === 'rej', '');
  okk('② 碰到後站上 → thru', outcome(mk([100, 104, 110, 115]), 0, 110) === 'thru', '');
  okk('② 沒碰到 → miss', outcome(mk([100, 101, 102]), 0, 110) === 'miss', '');
  // ③ 零前視:改動未來 K 棒,今天的 K 線版線不可以變
  const R0 = synthWalk(3), i0 = 200, a = kLevels(R0, i0);
  const R1 = R0.map((x, k) => k > i0 ? { ...x, h: x.h * 3, l: x.l * 3, c: x.c * 3, o: x.o * 3, v: x.v * 9 } : x);
  const b1 = kLevels(R1, i0);
  okk('③ 零前視:未來 ×3 → KU / KL 一字不變', a.KU === b1.KU && a.KL === b1.KL, JSON.stringify({ a, b1 }));
  // ④ 注入「碰線必回落」→ lift 要明顯為正;不注入(碰線必穿過)→ lift 不可為正
  const l1 = plantedRun(true, 100).summ['B3|all'], l0 = plantedRun(false, 100).summ['B3|all'];
  console.log(`   注入 lift ${l1 && f1(l1.lift)}pp(n=${l1 && l1.n},碰到 ${l1 && f1(l1.touch)}%)・沒注入 ${l0 && f1(l0.lift)}pp`);
  okk('④ 注入:真線被壓回率比同距離假線高 ≥30pp', l1 && l1.lift >= 30, JSON.stringify(l1));
  okk('④ 沒注入:lift ≤ 0(碰到的都穿過去)', l0 && l0.lift != null && l0.lift <= 0, JSON.stringify(l0));
  okk('④ 🚧 空過守門:真線幾乎都碰得到(≥95%)', l1 && l1.touch >= 95, JSON.stringify(l1));
  // ⑤ 換一組隨機種子結論要同向
  const l2 = plantedRun(true, 900).summ['B3|all'];
  okk('⑤ 換種子仍 ≥30pp', l2 && l2.lift >= 30, JSON.stringify(l2));
  if (bad.length) { console.log(`\n❌ SELFTEST 失敗 ${bad.length} 條`); return 1; }
  console.log('\n✅ TRAP_COMPARE_SELFTEST_PASS');
  return 0;
}

// ═══ 真實資料 ═══
function main() {
  if (SELFTEST) process.exit(selftest());
  const CD = process.env.CHIPS_DEEP_DIR, DD = process.env.DATA_DIR;
  if (!CD || !DD || !fs.existsSync(CD) || !fs.existsSync(DD)) { console.error('❌ 要 CHIPS_DEEP_DIR 與 DATA_DIR'); process.exit(1); }
  const chipDates = fs.readdirSync(CD).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).map(f => f.slice(0, 10)).sort();
  const chipSet = new Set(chipDates);
  console.log(`📥 chips_deep ${chipDates.length} 天(${chipDates[0]} ~ ${chipDates.at(-1)})`);
  // K 線
  let files = fs.readdirSync(DD).filter(f => /^\d{4}\.json$/.test(f)).sort(); if (LIMIT) files = files.slice(0, LIMIT);
  const stocks = [];
  for (const f of files) {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DD, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    const R = rows.filter(r => r && +r.close > 0).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), o: +r.open || +r.close, h: +r.high || +r.close, l: +r.low || +r.close, c: +r.close, v: +r.volume || 0 }));
    // 🚧 斷崖守門(同 overhead_probe):相鄰兩根比值 >1.4 或 <0.6 → 跳過整檔
    let cliff = false; for (let k = 1; k < R.length; k++) { const q = R[k].c / R[k - 1].c; if (q > 1.4 || q < 0.6) { cliff = true; break; } }
    if (R.length >= WIN + FWD + AFTER + 10 && !cliff) stocks.push([f.slice(0, 4), R]);
  }
  console.log(`📥 K 線 ${stocks.length} 檔`);
  // 分點:取樣日只要那 20 天;依日期讀檔,快取全部要用到的日子(只留取樣需要的檔)
  const want = new Set();   // 要讀的 chips 日期
  const sampleDates = new Set();
  for (const [, R] of stocks) for (let i = WIN; i + FWD + AFTER < R.length; i += STEP) {
    if (!chipSet.has(R[i].d)) continue;
    sampleDates.add(R[i].d);
  }
  // 以加權指數日曆定義「近 N 個交易日」
  const cal = JSON.parse(fs.readFileSync(path.join(DD, '^TWII.json'), 'utf8')).map(r => String(r.date).replace(/\//g, '-').slice(0, 10)).sort();
  const calIdx = new Map(cal.map((d, k) => [d, k]));
  const CASE = '2026-09-30';   // 國巨那一天(不是取樣日:之後不滿 30 根)→ 分點也要讀進來
  for (const d of [...sampleDates, CASE]) { const k = calIdx.get(d); if (k == null) continue; for (let q = Math.max(0, k - 19); q <= k; q++) if (chipSet.has(cal[q])) want.add(cal[q]); }
  console.log(`📥 取樣日 ${sampleDates.size} 天,要讀分點 ${want.size} 天`);
  const chips = new Map();   // date -> {sym: rows}
  for (const d of [...want].sort()) {
    try { chips.set(d, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CD, d + '.json.gz')))).s); } catch { /* 壞檔略過 */ }
  }
  const broker = (sym, R, i, N) => {
    const k = calIdx.get(R[i].d); if (k == null) return null;
    const ds = cal.slice(Math.max(0, k - N + 1), k + 1);
    const have = ds.filter(d => chips.has(d) && chips.get(d)[sym]);
    if (have.length < (N === 3 ? 3 : 16)) return null;    // 3 日要全有;20 日至少 16 天
    return brokerUnlock(have.map(d => chips.get(d)[sym]), R[i].c);
  };
  const sampleOk = (sym, R, i) => sampleDates.has(R[i].d);
  const res = run(stocks, broker, sampleOk);
  // 國巨那一天
  const g = stocks.find(s => s[0] === '2327');
  let case2327 = null;
  if (g) {
    const R = g[1], i = R.findIndex(r => r.d === '2026-09-30');
    if (i > 0) {
      const lv = kLevels(R, i);
      case2327 = { d: R[i].d, c: R[i].c, B3: broker('2327', R, i, 3), B20: broker('2327', R, i, 20), KU: lv.KU, KL: lv.KL, after: R.slice(i + 1, i + 7).map(r => [r.d, r.h, r.c]) };
    }
  }
  // 報表
  const f = (v, d = 1) => v == null ? '  —  ' : v.toFixed(d);
  const name = { B3: '分點 3 日(舊 App 預設)', B20: '分點 20 日', KU: 'K線 套牢量加權價', KL: 'K線 第一道套牢層' };
  console.log(`\n樣本切點(前後半)= ${res.mid}・事件 ${res.events}`);
  console.log('\n版本                     n     中位距離  碰到%  被壓回%  假線壓回%  差距pp   z    穿過%  假線穿過%');
  for (const p of ['all', 'pairBK', 'h1', 'h2', ...DIST_BK.map(([a, b]) => `d${a}-${b}`)]) {
    console.log(`── ${p}`);
    for (const m of METHODS) {
      const s = res.summ[`${m}|${p}`]; if (!s) continue;
      console.log(`  ${name[m].padEnd(16, ' ')} ${String(s.n).padStart(6)}   ${f(s.medDist)}%  ${f(s.touch)}  ${f(s.rej)}   ${f(s.rejSham)}   ${f(s.lift)}  ${f(s.z, 2)}  ${f(s.thru)}  ${f(s.thruSham)}`);
    }
  }
  if (case2327) console.log('\n🔎 國巨 2327 @ 09/30:', JSON.stringify(case2327));
  const out = process.argv.slice(2).find(a => a.endsWith('.json'));
  if (out) fs.writeFileSync(out, JSON.stringify({ meta: { chips: [chipDates[0], chipDates.at(-1)], step: STEP, fwd: FWD, after: AFTER, band: BAND, mid: res.mid, events: res.events }, summ: res.summ, case2327 }, null, 1));
  // 空過守門
  if (!res.summ['B3|all'] || res.summ['B3|all'].n < 200 || !res.summ['KL|all'] || res.summ['KL|all'].n < 200) { console.error('❌ 樣本不足 200,不下結論'); process.exit(1); }
}
main();
