#!/usr/bin/env node
/**
 * 📉📢 「連跌好幾天 + 籌碼亂」之後,手上的股票是不是比較會繼續跌(V79.9.5)—— 只讀探針
 *
 * ❓ 使用者 10/27:「富喬最近分析師、新聞都在講這一檔,又連跌好幾根,籌碼比較亂 → 是不是該賣的時候?
 *    能不能做出提醒」
 *    新聞那一半要等 news_buzz_miner 存夠(逐檔新聞 10/27 才開始抓);這支先測**不用新聞也量得到**的那一半:
 *      B   連跌 K 天(收盤一天比一天低)                          ← 對照組(只有連跌)
 *      V   連跌 K 天 + 今天爆量(≥ 前 20 天平均量 m 倍,⛔ 基準不含今天,陷阱 #43)
 *      F   連跌 K 天 + 近 5 天融資增 ≥ X% + 近 5 天三大法人賣超 ≥ Y%(佔成交量)= 「散戶在接、法人在賣」
 *      VF  三件同時(爆量 + 融資增 + 法人賣)
 *      D / DV  同上,但再加「近 20 天已跌 ≥ 10%」(對照 D = 只有連跌又跌深)
 *    假設方向:看空(s = −1)—— 手上有的人「之後 20 天比同一天全部股票差」才算有用。
 *    ⭐ 關鍵是**乾淨對照**:V / F / VF 要比「同樣連跌 K 天、但沒爆量 / 籌碼沒亂」的 B 更差,
 *       否則只是「連跌本身」的效果(而連跌本身以前就測過:跌深反而會彈)。
 *
 * 📐 回測鐵則(⛔ 不另寫一份,全部 import):
 *   ・進場 / 超額 / 同一天對照 / 斷崖 / 開盤鎖死 = dispo_backtest(sampleEv / buildCtrl / summarize,陷阱 #50 #52)
 *   ・融資 / 法人窗口 / 缺值 = retail_inst_probe(loadX / instPrefix / marginChg;缺值 ⛔ 當 0)
 *   ・六關 = retail_inst_probe.gates(照假設方向)
 *   ・同一檔同一個條件 20 個交易日內只算一次
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/dropbuzz_proxy_probe.mjs <d16_fi>    OUT=結果.json
 *   node scripts/dropbuzz_proxy_probe.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCtrl, sampleEv, summarize, mkIndex } from './dispo_backtest.mjs';
import { loadX, instPrefix, marginChg, gates } from './retail_inst_probe.mjs';

const iso = s => String(s || '').replace(/\//g, '-').slice(0, 10);
export const DEDUP = 20;
export const VBASE = 20;                       // 爆量基準:前 20 天(⛔ 含今天)
export const GRID = { K: [3, 4, 5], M: [1.5, 2, 3], X: [5, 10], Y: [1, 3] };
export const MAIN = { K: 3, M: 2, X: 5, Y: 1 };
export const DEEP = 10;                        // 近 20 天跌 ≥ 10% = 跌深

/** 連跌天數(收盤一天比一天低,今天往回數) */
export function downRun(X, i) {
  let k = 0;
  while (i - k - 1 >= 0 && X.c[i - k] < X.c[i - k - 1]) k++;
  return k;
}
/** 今天的量 ÷ 前 20 天平均量(⛔ 基準不含今天);缺量 → NaN */
export function volMult(X, i) {
  if (i - VBASE < 0 || !Number.isFinite(X.v[i])) return NaN;
  let s = 0, n = 0;
  for (let k = i - VBASE; k < i; k++) { if (!Number.isFinite(X.v[k])) return NaN; s += X.v[k]; n++; }
  return s > 0 ? X.v[i] / (s / n) : NaN;
}

export function eventsOf(X, grid = GRID) {
  const inst = instPrefix(X), ev = {}, last = {};
  const put = (key, i) => {
    if (last[key] != null && i - last[key] < DEDUP) return;
    last[key] = i; (ev[key] = ev[key] || []).push(X.dates[i]);
  };
  for (let i = 60; i < X.n - 1; i++) {
    const run = downRun(X, i);
    if (run < Math.min(...grid.K)) continue;
    const vm = volMult(X, i), mc = marginChg(X, i, 5), ins = inst(i, 5);
    const r20 = X.c[i - 20] > 0 ? (X.c[i] / X.c[i - 20] - 1) * 100 : NaN;
    const deep = Number.isFinite(r20) && r20 <= -DEEP;
    for (const K of grid.K) {
      if (run < K) continue;
      put(`B_${K}`, i);
      if (deep) put(`D_${K}`, i);
      for (const M of grid.M) if (Number.isFinite(vm) && vm >= M) { put(`V_${K}_${M}`, i); if (deep) put(`DV_${K}_${M}`, i); }
      if (Number.isFinite(mc) && Number.isFinite(ins)) {
        for (const Xp of grid.X) for (const Yp of grid.Y) {
          if (mc >= Xp && ins <= -Yp) {
            put(`F_${K}_${Xp}_${Yp}`, i);
            if (Number.isFinite(vm) && vm >= MAIN.M) put(`VF_${K}_${Xp}_${Yp}`, i);
          }
        }
      }
    }
  }
  return ev;
}

export function run(dir, opts = {}) {
  const log = opts.log || console.log;
  const rows0 = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8'));
  const twii = { dates: [], c: [] };
  for (const r of rows0) if (Number.isFinite(+r.close) && +r.close > 0) { twii.dates.push(iso(r.date)); twii.c.push(+r.close); }
  const mktRet = mkIndex(twii);
  const syms = fs.readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('^') && !x.startsWith('_'))
    .map(x => x.slice(0, -5)).filter(s => /^[1-9]\d{3}$/.test(s));
  log(`📂 ${dir}:${syms.length} 檔一般股票`);
  const ctrl = buildCtrl(dir, syms, mktRet);
  log(`🧮 對照組:${ctrl.nStock} 檔 ・${ctrl.first} ~ ${ctrl.last}`);
  const rows = {}, skip = {};
  let nX = 0;
  for (const sym of syms) {
    const X = loadX(dir, sym);
    if (!X) continue;
    nX++;
    for (const [key, ds] of Object.entries(eventsOf(X, opts.grid || GRID))) {
      const arr = rows[key] = rows[key] || [];
      for (const d of ds) {
        const r = sampleEv(X, ctrl, mktRet, sym, d);
        if (r.skip) skip[r.skip] = (skip[r.skip] || 0) + 1; else arr.push(r);
      }
    }
  }
  log(`📊 讀了 ${nX} 檔 ・略過 ${JSON.stringify(skip)}`);
  const S = {};
  for (const [k, arr] of Object.entries(rows)) S[k] = summarize(arr);
  return { S, meta: { syms: syms.length, nX, skip, ctrlFirst: ctrl.first, ctrlLast: ctrl.last } };
}

const f2 = v => v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);
function line(name, s, g) {
  if (!s || s.thin) return `  ${name}:樣本不足(${s ? s.n : 0})`;
  return `  ${name}:n=${s.n} ・20 日超額 ${f2(s.e20)}pp(5 日 ${f2(s.e5)}・10 日 ${f2(s.e10)})・前後半 ${f2(s.h1)}/${f2(s.h2)}・` +
    `逐年負 ${(s.years || []).filter(y => y[1] < 0).length}/${(s.years || []).length}` + (g ? ` ・六關 ${g.pass}/6${g.incY ? `(比對照逐年 ${g.incY})` : ''}` : '');
}
export function report(R, log = console.log) {
  const S = R.S, out = { main: {}, plateau: {}, meta: R.meta };
  const { K, M, X: Xp, Y } = MAIN;
  const show = (t, key, ck) => { const g = gates(S[key], S[ck], -1); log(line(t, S[key], g)); out.main[key] = { ...(S[key] || {}), gates: g, ctrl: ck }; };
  log(`\n━━ 主設定(連跌 ${K} 天・爆量 ≥${M} 倍・5 日融資增 ≥${Xp}%・法人賣 ≥${Y}% 佔量)━━`);
  log(line(`B 只有連跌 ${K} 天(對照)`, S[`B_${K}`]));
  show('V 連跌 + 爆量', `V_${K}_${M}`, `B_${K}`);
  show('F 連跌 + 融資增法人賣', `F_${K}_${Xp}_${Y}`, `B_${K}`);
  show('VF 三件同時', `VF_${K}_${Xp}_${Y}`, `B_${K}`);
  log(line(`D 連跌 ${K} 天 + 20 日跌 ≥${DEEP}%(對照)`, S[`D_${K}`]));
  show('DV 跌深 + 連跌 + 爆量', `DV_${K}_${M}`, `D_${K}`);
  log('\n━━ 門檻高原(20 日超額 pp,扣同一天全部股票;括號 = 減掉同 K 的連跌對照)━━');
  for (const k of GRID.K) {
    const b = S[`B_${k}`];
    const cell = key => { const s = S[key]; return !s || s.thin ? '—' : `${f2(s.e20)}(${b && !b.thin ? f2(s.e20 - b.e20) : '—'})`; };
    log(`  K=${k} 對照 B ${b && !b.thin ? f2(b.e20) : '—'} ・V ${GRID.M.map(m => `${m}x ${cell(`V_${k}_${m}`)}`).join(' ・')}`);
    log(`        F ${GRID.X.flatMap(x => GRID.Y.map(y => `${x}/${y} ${cell(`F_${k}_${x}_${y}`)}`)).join(' ・')}`);
    for (const key of Object.keys(S)) if (key.endsWith(`_${k}`) || key.includes(`_${k}_`)) out.plateau[key] = S[key] && !S[key].thin ? { n: S[key].n, e20: S[key].e20 } : null;
  }
  return out;
}

// ───────────────────────── selftest(合成資料)─────────────────────────
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function synth(dir, { after = true, sameDay = false, nStock = 60, nDay = 560, seed = 11 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const R = rng(seed);
  const dates = [];
  for (let t = Date.UTC(2014, 0, 6); dates.length < nDay; t += 86400000) { const wd = new Date(t).getUTCDay(); if (wd && wd < 6) dates.push(new Date(t).toISOString().slice(0, 10)); }
  fs.writeFileSync(path.join(dir, '^TWII.json'), JSON.stringify(dates.map((d, i) => ({ date: d, open: 100, high: 101, low: 99, close: 100 + i * 0.01 }))));
  for (let s = 0; s < nStock; s++) {
    const rows = [];
    let p = 50 + R() * 50, pend = 0;
    // 每檔同樣那幾天「連跌 3 天」,一半的股票第 3 天爆量(⭐ 只有爆量的那幾次之後會再跌)
    //   ⚠️ 全部股票同一天 → 同一天對照組也有一樣的連跌,⛔ 合成資料自己把對照組拉偏
    const runs = new Map();
    for (let k = 90, j = 0; k < nDay - 40; k += 70, j++) runs.set(k, (s + j) % 2 === 0);
    for (let i = 0; i < nDay; i++) {
      let r = (R() - 0.5) * 0.02, vol = 1e6 * (0.8 + R() * 0.4);
      for (const [k, spike] of runs) {
        if (i === k - 3) r = Math.max(r, 0.005);                      // 連跌開始前一天收紅(連跌天數剛好 3)
        if (i > k - 3 && i <= k) r = -0.01 - R() * 0.005;             // 連跌 3 天
        if (i === k && spike) { vol = 3.5e6; if (after) pend = 20; if (sameDay) r -= 0.08; }
        if (i === k + 1) r = Math.max(r, 0.002);                      // 隔天收紅(⛔ 讓它變成連跌 4 天)
      }
      if (pend > 0 && !runs.has(i)) { r -= 0.004; pend--; }
      const o = p, c = p * (1 + r);
      rows.push({ date: dates[i].replace(/-/g, '/'), open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c,
                  volume: vol, margin_balance: 3000, foreign_net: 0, trust_net: 0, dealer_net: 0 });
      p = c;
    }
    fs.writeFileSync(path.join(dir, String(1101 + s) + '.json'), JSON.stringify(rows));
  }
}

export function selftest() {
  const bad = [];
  const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) bad.push(n); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropbuzz-'));
  const g = { K: [3], M: [2], X: [5], Y: [1] };
  try {
    // ① 連跌天數 / 爆量基準
    const T = { c: Float64Array.from([10, 11, 10.5, 10.2, 10.1]), v: Float64Array.from(Array(25).fill(100)) };
    ok('① 連跌天數 = 3(前面一天是漲)', downRun(T, 4) === 3, String(downRun(T, 4)));
    T.v[24] = 300;
    ok('① 爆量倍數基準不含今天(300 ÷ 100 = 3)', Math.abs(volMult({ v: T.v }, 24) - 3) < 1e-9, String(volMult({ v: T.v }, 24)));
    // ② 注入:只有爆量那幾次之後跌 → V 明顯負、而且比只有連跌的 B 差
    const d1 = path.join(tmp, 'a'); synth(d1, { after: true });
    const R1 = run(d1, { log: () => {}, grid: g });
    const V = R1.S['V_3_2'], B = R1.S['B_3'];
    ok('② 注入「爆量連跌之後再跌 8%」→ V 20 日超額 < −3pp', V && !V.thin && V.e20 < -3, JSON.stringify(V || {}).slice(0, 160));
    ok('② V 比只有連跌的 B 差(乾淨對照抓得到)', V && B && !V.thin && !B.thin && V.e20 < B.e20 - 1.5, `${V && V.e20} vs ${B && B.e20}`);
    // ③ 決定性對照:不注入 → V ≈ 0
    const d2 = path.join(tmp, 'b'); synth(d2, { after: false });
    const V2 = run(d2, { log: () => {}, grid: g }).S['V_3_2'];
    ok('③ ⭐ 決定性對照:沒注入 → V ≈ 0(|超額| < 1pp)', V2 && !V2.thin && Math.abs(V2.e20) < 1, JSON.stringify(V2 || {}).slice(0, 160));
    // ④ 前視:跌在訊號那天收盤前 → 隔天開盤進場的人吃不到
    const d3 = path.join(tmp, 'c'); synth(d3, { after: false, sameDay: true });
    const V3 = run(d3, { log: () => {}, grid: g }).S['V_3_2'];
    ok('④ ⭐ 前視:跌完才出訊號 → 超額 ≈ 0', V3 && !V3.thin && Math.abs(V3.e20) < 1, JSON.stringify(V3 || {}).slice(0, 160));
    // ⑤ 六關照看空方向
    const G = gates(V, B, -1);
    ok('⑤ 注入的資料六關 ≥ 4(看空方向)', G.pass >= 4, JSON.stringify(G));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ dropbuzz_proxy_probe selftest 全過'}`);
  return bad.length ? 1 : 0;
}

function main() {
  const dir = process.argv[2] || process.env.DATA_DIR;
  if (!dir) { console.error('用法:node scripts/dropbuzz_proxy_probe.mjs <dataDir>'); process.exit(2); }
  const t0 = Date.now();
  const out = report(run(dir));
  if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify({ at: new Date().toISOString(), dir, ...out }, null, 1)); console.log(`\n💾 ${process.env.OUT}`); }
  console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest());
else if (IS_MAIN) main();
