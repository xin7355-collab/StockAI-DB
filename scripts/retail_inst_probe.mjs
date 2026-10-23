#!/usr/bin/env node
/**
 * 👥🏦 散戶 vs 法人「同時發生」的時候,之後股價有沒有不一樣(V79.6.3)—— 只讀探針
 *
 * ❓ 使用者 10/23:「股票是不是一場心理戰,是散戶與大戶的對決,我要的是能找出其中的東西 …
 *    看是否能減少損失還是能夠找出貓膩」
 *
 * 已經測過、這支 ⛔ 不重測的(都在實測總表):分點跟單三支、集保大戶散戶(兩上兩下)、券資比 / 軋空、
 *   散戶多空比、外資連買 / 突然一大筆、投信同步、法人 × 融資「誰領先誰」(inst_leadlag:lag ≥ 1 相關 ≈ 0)、
 *   板塊偷布局、處置 / 注意、隔日沖、期貨大額交易人(pcr-largetrader)、71 個因子(factor-zoo)。
 * ⭐ 這支測的是**兩邊同時發生**(以前都是單獨測一邊):
 *   A1  散戶在接、法人在賣:N 日融資增 ≥ X%  且 N 日三大法人賣超 ≥ Y%(佔成交量)
 *       ↔ 乾淨對照 C1:融資一樣增 ≥ X%,但法人沒有賣(≥ 0)—— 差的那一段才是「法人在賣」的貢獻
 *   A1r 散戶在逃、法人在接:融資減 ≥ X% 且法人買超 ≥ Y%   ↔ C1r:融資一樣減,但法人沒買
 *   A2  融資斷頭:收盤跌破推估追繳線(跟 App 的 _marginCallState 同一條:近 60 日融資增加日的加權均價 × 上市 0.78 / 上櫃 0.65)
 *       且融資 5 日減 ≥ 10%(已經在被砍)↔ C2:20 日一樣跌 ≥ 15%、但沒跌破追繳線(分開「跌很多」跟「被斷頭」)
 *   A3  趁高出貨(給手上有的人 = 少賠):離 60 日最高收盤 5% 內 + 10 日法人賣超 ≥ Y% + 10 日融資增 ≥ X%
 *       ↔ C3:一樣在高檔、法人沒賣;A3b:高檔 + 法人賣(不管融資)—— 看融資有沒有加料
 *
 * 📐 回測鐵則(沿用 dispo_backtest 的同一套,⛔ 不另寫一份):
 *   ・訊號用當天收盤後才公布的資料 → 進場 = **隔一個交易日開盤**;開盤鎖死買不到的不算(2015-06 前 ±7%,lib_limit)
 *   ・超額 = 自己的報酬 − **同一天進場、同樣抱 N 天的全部股票平均**(陷阱 #50;同一天 < 30 檔不算)
 *   ・斷崖守門:窗口碰到 ×1.5 / ×0.67 的那幾筆不算(⛔ 不整檔剔除,lib_cliff)
 *   ・同一檔同一個條件 20 個交易日內只算一次
 *   ・缺值 = 不知道(⛔ 不當 0):法人 / 融資窗口裡有一天沒有就不判
 *   ・六關(照假設的方向):全期 / 前後半 / 逐年 ≥ 2/3 / 去掉最有利的那一年 / |超額| > 來回成本 0.44% / 比乾淨對照多(逐年也同向)
 *   ・門檻高原:N ∈ {5,10,20} × X ∈ {5,10,20,30} × Y ∈ {1,2,3,5}
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/retail_inst_probe.mjs <dataDir>      # 要有 {sym}.json(含 margin_balance /
 *        foreign_net / trust_net / dealer_net)與 ^TWII.json;16 年請用 d16_fi(個股法人 2012 起、融資 2010 起)
 *   OUT=結果.json  NAMES=data/stock_names.json(第三欄 = 上市 / 上櫃;沒有 → 一律用上市 0.78 並計數)
 *   node scripts/retail_inst_probe.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCtrl, sampleEv, summarize, mkIndex, MIN_CTRL, COST } from './dispo_backtest.mjs';
import { cliffPrefix } from './lib_cliff.mjs';

const iso = s => String(s || '').replace(/\//g, '-').slice(0, 10);
export const DEDUP = 20;
export const MIN_M = 200;           // 融資基期至少 200 張(太小的基期 1 張變 2 張就是 +100%)
export const NEAR_HI = 0.95;        // 離 60 日最高收盤 5% 內 = 高檔
export const MARGIN_WIN = 60;       // = index.html _marginCallState
export const GRID = { N: [5, 10, 20], X: [5, 10, 20, 30], Y: [1, 2, 3, 5] };
export const MAIN = { N: 10, X: 10, Y: 3 };

// 讀一檔 → K(跟 dispo_backtest.loadK 同一個形狀與同一條過濾,sampleEv 直接吃)+ 融資 / 法人 / 量
export function loadX(dir, sym) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(dir, sym + '.json'), 'utf8')); } catch { return null; }
  if (!Array.isArray(rows) || rows.length <= 60) return null;
  const n0 = rows.length;
  const dates = [], o = new Float64Array(n0), c = new Float64Array(n0), h = new Float64Array(n0), l = new Float64Array(n0);
  const v = new Float64Array(n0), m = new Float64Array(n0), f = new Float64Array(n0);
  let n = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.close) || !Number.isFinite(r.open)) continue;        // ⚠️ 跟 loadK 同一條,索引才對得上
    dates.push(iso(r.date)); o[n] = r.open; c[n] = r.close; h[n] = r.high; l[n] = r.low;
    v[n] = Number.isFinite(+r.volume) ? +r.volume : NaN;
    m[n] = r.margin_balance == null || r.margin_balance === '' ? NaN : +r.margin_balance;
    const a = r.foreign_net, b = r.trust_net, d = r.dealer_net;
    f[n] = (a == null || b == null || d == null) ? NaN : (+a) + (+b) + (+d);   // 三個都要有(⛔ 缺一個不當 0)
    n++;
  }
  const pre = cliffPrefix(c.subarray(0, n), o.subarray(0, n));
  return { dates, o: o.subarray(0, n), c: c.subarray(0, n), h: h.subarray(0, n), l: l.subarray(0, n), pre, n,
           v: v.subarray(0, n), m: m.subarray(0, n), f: f.subarray(0, n) };
}

// N 日窗口的法人買賣超佔成交量(%)—— 前綴和,窗口裡有缺值就回 NaN
export function instPrefix(X) {
  const n = X.n, sf = new Float64Array(n + 1), sv = new Float64Array(n + 1), bad = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const ok = Number.isFinite(X.f[k]) && Number.isFinite(X.v[k]);
    sf[k + 1] = sf[k] + (ok ? X.f[k] : 0); sv[k + 1] = sv[k] + (ok ? X.v[k] : 0); bad[k + 1] = bad[k] + (ok ? 0 : 1);
  }
  return (i, N) => {
    if (i - N + 1 < 0) return NaN;
    if (bad[i + 1] - bad[i - N + 1] > 0) return NaN;
    const V = sv[i + 1] - sv[i - N + 1];
    return V > 0 ? (sf[i + 1] - sf[i - N + 1]) / V * 100 : NaN;
  };
}
export function marginChg(X, i, N) {
  if (i - N < 0) return NaN;
  const a = X.m[i - N], b = X.m[i];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < MIN_M) return NaN;
  return (b - a) / a * 100;
}
// 推估追繳線(= index.html _marginCallState:近 60 根融資 > 0 的列、增加日加權 (高+低+收)/3)
export function callLine(X, i, ratio) {
  const idx = [];
  for (let k = i; k >= 0 && idx.length < MARGIN_WIN; k--) if (X.m[k] > 0) idx.push(k);
  if (idx.length < 8) return NaN;
  idx.reverse();
  let ws = 0, ps = 0;
  for (let t = 1; t < idx.length; t++) {
    const dq = X.m[idx[t]] - X.m[idx[t - 1]];
    if (!(dq > 0)) continue;
    const k = idx[t], px = (X.h[k] > 0 && X.l[k] > 0 && X.c[k] > 0) ? (X.h[k] + X.l[k] + X.c[k]) / 3 : X.c[k];
    if (!(px > 0)) continue;
    ws += dq; ps += dq * px;
  }
  return ws > 0 ? ps / ws * ratio : NaN;
}

// 🧯 融資斷頭(A2 主設定)的判斷 —— 事件研究與組合回測(margin_call_port.mjs)共用這一支,⛔ 不各寫一份
//   收盤 ≤ 推估追繳線(= App _marginCallState)且融資 5 日減 ≥ 10% → 回 {cl, mg5, depth = 收盤 ÷ 追繳線};不成立回 null
export function marginCallAt(X, i, ratio, mgT = 10, lv = 100) {
  const cl = callLine(X, i, ratio), mg5 = marginChg(X, i, 5);
  if (!Number.isFinite(cl) || !Number.isFinite(mg5)) return null;
  if (X.c[i] <= cl * lv / 100 && mg5 <= -mgT) return { cl, mg5, depth: X.c[i] / cl };
  return null;
}

// 一檔 → 每個條件的事件日(同一條件 20 個交易日內只算一次)
export function eventsOf(X, ratio, grid = GRID) {
  const inst = instPrefix(X), ev = {};
  const last = {};
  const put = (key, i) => {
    if (last[key] != null && i - last[key] < DEDUP) return;
    last[key] = i;
    (ev[key] = ev[key] || []).push(X.dates[i]);
  };
  for (let i = MARGIN_WIN; i < X.n - 1; i++) {
    for (const N of grid.N) {
      const mc = marginChg(X, i, N), ins = inst(i, N);
      if (!Number.isFinite(mc) || !Number.isFinite(ins)) continue;
      for (const Xp of grid.X) {
        for (const Yp of grid.Y) {
          const tag = `${N}_${Xp}_${Yp}`;
          if (mc >= Xp && ins <= -Yp) put('A1_' + tag, i);
          if (mc <= -Xp && ins >= Yp) put('A1r_' + tag, i);
        }
        const tagc = `${N}_${Xp}`;
        if (mc >= Xp && ins >= 0) put('C1_' + tagc, i);
        if (mc <= -Xp && ins <= 0) put('C1r_' + tagc, i);
      }
    }
    // A2 融資斷頭 vs C2(跌一樣多、沒斷頭)
    const cl = callLine(X, i, ratio), mg5 = marginChg(X, i, 5);
    const r20 = i >= 20 && X.c[i - 20] > 0 ? (X.c[i] / X.c[i - 20] - 1) * 100 : NaN;
    let isA2 = false;
    if (Number.isFinite(cl) && Number.isFinite(mg5)) {
      isA2 = !!marginCallAt(X, i, ratio);
      if (isA2) put('A2', i);
      else if (X.c[i] > cl && Number.isFinite(r20) && r20 <= -15) put('C2', i);
      // 🔬 A2 門檻高原:融資 5 日減 ≥ mg% × 收盤 ≤ 追繳線 × lv%
      for (const mgT of [5, 10, 15, 20]) for (const lv of [100, 95, 90]) if (X.c[i] <= cl * lv / 100 && mg5 <= -mgT) put(`A2v_${mgT}_${lv}`, i);
      // 🔬 拆開兩件事:只有融資大減(沒跌破追繳線、20 日一樣跌 ≥15%)/ 只有跌破追繳線(融資沒大減)
      if (X.c[i] > cl && mg5 <= -10 && Number.isFinite(r20) && r20 <= -15) put('A2m', i);
      if (X.c[i] <= cl && mg5 > -10) put('A2b', i);
    }
    // 🔬 跌幅配對:同一桶 20 日跌幅,斷頭的 vs 沒斷頭的(⛔ 「跌很多本來就會彈」要先扣掉)
    if (Number.isFinite(r20) && r20 <= -15) {
      const bk = r20 <= -40 ? 40 : r20 <= -30 ? 30 : r20 <= -20 ? 20 : 15;
      put(isA2 ? `A2d_${bk}` : `D_${bk}`, i);
    }
    // 🔬 更嚴的配對:離 60 日最高收盤跌多深(追繳線本身就是「跌破近 60 日平均成本的七八成」→ 要拿一樣深的比)
    {
      let hi60 = 0; for (let k = i - 59; k <= i; k++) if (X.c[k] > hi60) hi60 = X.c[k];
      const dd = hi60 > 0 ? (X.c[i] / hi60 - 1) * 100 : NaN;
      if (Number.isFinite(dd) && dd <= -22 && Number.isFinite(r20)) {
        const b1 = dd <= -50 ? 50 : dd <= -40 ? 40 : dd <= -30 ? 30 : 22;
        const b2 = r20 <= -25 ? 'h' : 'l';            // 同一個深度裡再分「最近 20 天跌得急 / 跌得慢」
        put(isA2 ? `A2e_${b1}${b2}` : `E_${b1}${b2}`, i);
      }
    }
    // A3 高檔出貨
    let mx = 0;
    for (let k = i - 59; k <= i; k++) if (X.c[k] > mx) mx = X.c[k];
    if (mx > 0 && X.c[i] >= mx * NEAR_HI) {
      const ins10 = inst(i, 10), mc10 = marginChg(X, i, 10);
      if (Number.isFinite(ins10)) {
        for (const Yp of grid.Y) {
          if (ins10 <= -Yp) put('A3b_' + Yp, i);
          if (ins10 <= -Yp && Number.isFinite(mc10)) for (const Xp of grid.X) if (mc10 >= Xp) put(`A3_${Xp}_${Yp}`, i);
        }
        if (ins10 >= 0) put('C3', i);
      }
    }
  }
  return ev;
}

// ── 六關(照假設方向 s = +1 看多 / −1 看空)──
export function gates(S, C, s) {
  if (!S || S.thin) return { pass: 0, why: '樣本不足' };
  const g = [];
  g.push(s * S.e20 > 0);
  g.push(S.h1 != null && S.h2 != null && s * S.h1 > 0 && s * S.h2 > 0);
  const ys = S.years || [];
  g.push(ys.length >= 6 && ys.filter(y => s * y[1] > 0).length / ys.length >= 2 / 3);
  // 去掉「最有利的那一年」(看空就是去掉最負的那一年)
  let exFav = null;
  if (ys.length >= 2) {
    const fav = ys.slice().sort((a, b) => s * b[1] - s * a[1])[0][0];
    const rest = ys.filter(y => y[0] !== fav);
    const tot = rest.reduce((t, y) => t + y[1] * y[2], 0), cnt = rest.reduce((t, y) => t + y[2], 0);
    exFav = cnt ? tot / cnt : null;
  }
  g.push(exFav != null && s * exFav > 0);
  g.push(Math.abs(S.e20) > COST);
  let inc = false, incY = null;
  if (C && !C.thin) {
    const cy = new Map((C.years || []).map(y => [y[0], y[1]]));
    const both = ys.filter(y => cy.has(y[0]));
    const same = both.filter(y => s * (y[1] - cy.get(y[0])) > 0).length;
    incY = both.length ? `${same}/${both.length}` : null;
    inc = s * (S.e20 - C.e20) > 0 && both.length >= 6 && same / both.length >= 2 / 3;
  }
  g.push(inc);
  return { pass: g.filter(Boolean).length, g, exFav, incY };
}

export function ratioOf(names, sym) { const mk = names.get(sym) || ''; return /tpex|otc|上櫃/.test(mk) ? 0.65 : 0.78; }
export function readNames(p) {
  const mk = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    // data/stock_names.json = { names: { "1101": ["台泥", "01", "twse"], … } }(第三欄 = 市場別)
    const src = (j && j.names && typeof j.names === 'object') ? j.names : j;
    for (const [k, v] of Object.entries(src || {})) if (Array.isArray(v) && v.length >= 3) mk.set(String(k), String(v[2]).toLowerCase());
  } catch (_) { /* 沒有就全部當上市,並計數 */ }
  return mk;
}

export function run(dir, opts = {}) {
  const log = opts.log || console.log;
  const twii = (() => {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8'));
    const dates = [], c = [];
    for (const r of rows) if (Number.isFinite(+r.close) && +r.close > 0) { dates.push(iso(r.date)); c.push(+r.close); }
    return { dates, c };
  })();
  const mktRet = mkIndex(twii);
  const syms = fs.readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('^') && !x.startsWith('_')).map(x => x.slice(0, -5))
    .filter(s => /^[1-9]\d{3}$/.test(s));                       // 只看一般股票(⛔ ETF / 權證 / 特別股)
  log(`📂 ${dir}:${syms.length} 檔一般股票`);
  const ctrl = buildCtrl(dir, syms, mktRet);
  log(`🧮 對照組:${ctrl.nStock} 檔 ・${ctrl.nObs.toLocaleString()} 筆(股·日·天期)・${ctrl.first} ~ ${ctrl.last}`);
  const names = readNames(opts.names || '');
  const rows = {};                // 條件 → 樣本陣列
  let nX = 0, nM = 0, nF = 0, unkMkt = 0, skip = {};
  for (const sym of syms) {
    const X = loadX(dir, sym);
    if (!X) continue;
    nX++;
    if (X.m.some(Number.isFinite)) nM++;
    if (X.f.some(Number.isFinite)) nF++;
    const mk = names.get(sym) || '';
    if (!mk) unkMkt++;
    const ratio = /tpex|otc|上櫃/.test(mk) ? 0.65 : 0.78;
    const ev = eventsOf(X, ratio, opts.grid || GRID);
    for (const [key, ds] of Object.entries(ev)) {
      const arr = rows[key] = rows[key] || [];
      // 🔬 融資斷頭 / 跌幅配對那幾組另外多算一份「鎖跌停也買」(鎖跌停其實買得到 → 排掉它會把最慘的那幾筆拿掉 = 灌水)
      const ld = /^(A2|C2|D_|E_)/.test(key) ? (rows[key + '_LD'] = rows[key + '_LD'] || []) : null;
      for (const d of ds) {
        const r = sampleEv(X, ctrl, mktRet, sym, d);
        if (r.skip) { skip[r.skip] = (skip[r.skip] || 0) + 1; } else arr.push(r);
        if (ld) { const r2 = sampleEv(X, ctrl, mktRet, sym, d, { allowDownLock: true }); if (!r2.skip) ld.push(r2); }
      }
    }
  }
  log(`📊 讀了 ${nX} 檔 ・有融資 ${nM} ・有法人 ${nF} ・市場別不知道 ${unkMkt}(一律用上市 0.78)・略過 ${JSON.stringify(skip)}`);
  const S = {};
  for (const [k, arr] of Object.entries(rows)) S[k] = summarize(arr);
  return { S, rows, meta: { syms: syms.length, nX, nM, nF, unkMkt, skip, ctrlFirst: ctrl.first, ctrlLast: ctrl.last } };
}

const f2 = v => v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);
function line(name, s, g) {
  if (!s || s.thin) return `  ${name}:樣本不足(${s ? s.n : 0})`;
  return `  ${name}:n=${s.n} ・20 日超額 ${f2(s.e20)}pp(5 日 ${f2(s.e5)}・10 日 ${f2(s.e10)})・前後半 ${f2(s.h1)}/${f2(s.h2)}・` +
    `逐年同向 ${(s.years || []).filter(y => (g && g.s ? g.s : 1) * y[1] > 0).length}/${(s.years || []).length}` +
    (g ? ` ・六關 ${g.pass}/6${g.incY ? `(比乾淨對照逐年 ${g.incY})` : ''}` : '');
}

export function report(R, log = console.log) {
  const S = R.S, out = { main: {}, grid: {}, meta: R.meta };
  const M = `${MAIN.N}_${MAIN.X}_${MAIN.Y}`, Mc = `${MAIN.N}_${MAIN.X}`;
  const show = (title, key, ckey, s) => {
    const g = gates(S[key], S[ckey], s); g.s = s;
    log(line(title, S[key], g));
    out.main[key] = { ...(S[key] || {}), gates: g, ctrl: ckey };
  };
  log('\n━━ 主設定(N=10 天・融資 ≥10%・法人 ≥3% 佔量)━━');
  show('A1 散戶在接、法人在賣', 'A1_' + M, 'C1_' + Mc, -1);
  log(line('   └ 乾淨對照 C1(融資增、法人沒賣)', S['C1_' + Mc]));
  show('A1r 散戶在逃、法人在接', 'A1r_' + M, 'C1r_' + Mc, +1);
  log(line('   └ 乾淨對照 C1r(融資減、法人沒買)', S['C1r_' + Mc]));
  const s2 = S.A2 && !S.A2.thin && S.A2.e20 >= 0 ? +1 : -1;
  show(`A2 融資斷頭(探索:照實測方向 ${s2 > 0 ? '反彈' : '續跌'})`, 'A2', 'C2', s2);
  log(line('   └ 對照 C2(20 日一樣跌 ≥15%、沒斷頭)', S.C2));
  show('A3 高檔出貨(法人賣 + 融資增)', `A3_${MAIN.X}_${MAIN.Y}`, 'C3', -1);
  show('A3b 高檔 + 法人賣(不管融資)', `A3b_${MAIN.Y}`, 'C3', -1);
  log(line('   └ 對照 C3(高檔、法人沒賣)', S.C3));
  log('\n━━ 🔬 融資斷頭(A2)要過的幾道檢查 ━━');
  log(line('A2 原本(鎖跌停那天不買)', S.A2));
  log(line('A2 鎖跌停也買(⭐ 比較老實)', S.A2_LD));
  log(line('A2m 只有融資大減(沒跌破追繳線、20 日一樣跌 ≥15%)', S.A2m));
  log(line('A2b 只有跌破追繳線(融資沒大減)', S.A2b));
  for (const bk of [15, 20, 30, 40]) {
    const a = S[`A2d_${bk}_LD`], d = S[`D_${bk}_LD`];
    log(`  跌幅桶 ≥${bk}%(鎖跌停也買):斷頭 ${a && !a.thin ? `n=${a.n} ${f2(a.e20)}` : '樣本不足'} vs 沒斷頭 ${d && !d.thin ? `n=${d.n} ${f2(d.e20)}` : '樣本不足'}`);
    out.main[`bucket_${bk}`] = { a2: a && !a.thin ? { n: a.n, e20: a.e20, years: a.years } : null, d: d && !d.thin ? { n: d.n, e20: d.e20 } : null };
  }
  {
    let wins = 0, tot = 0, wsum = 0, wn = 0;
    for (const b1 of [22, 30, 40, 50]) for (const b2 of ['l', 'h']) {
      const a = S[`A2e_${b1}${b2}_LD`], d = S[`E_${b1}${b2}_LD`];
      const ok2 = a && !a.thin && d && !d.thin;
      log(`  離 60 日高點跌 ≥${b1}%・20 日${b2 === 'h' ? '跌 ≥25%(急)' : '跌 <25%(慢)'}:斷頭 ${a && !a.thin ? `n=${a.n} ${f2(a.e20)}` : `樣本不足(${a ? a.n : 0})`} vs 沒斷頭 ${d && !d.thin ? `n=${d.n} ${f2(d.e20)}` : '樣本不足'}${ok2 ? ` → 差 ${f2(a.e20 - d.e20)}` : ''}`);
      if (ok2) { tot++; if (a.e20 > d.e20) wins++; wsum += (a.e20 - d.e20) * a.n; wn += a.n; }
    }
    log(`  ⭐ 一樣深的配對:斷頭贏 ${wins}/${tot} 格・加權平均多 ${f2(wn ? wsum / wn : NaN)}pp`);
    out.main.A2_ddmatch = { wins, tot, diff: wn ? wsum / wn : null };
  }
  {
    let good = 0, tot = 0; const cells = [];
    for (const mgT of [5, 10, 15, 20]) for (const lv of [100, 95, 90]) {
      const v = S[`A2v_${mgT}_${lv}_LD`] || S[`A2v_${mgT}_${lv}`];
      if (v && !v.thin) { tot++; if (v.e20 > COST) good++; }
      cells.push(`${mgT}/${lv}:${v && !v.thin ? f2(v.e20) + '(' + v.n + ')' : '—'}`);
    }
    log(`  門檻高原(融資減 % / 追繳線 ×%,鎖跌停也買):${cells.join(' ')}\n  ⭐ ${good}/${tot} 格 > 成本`);
    out.grid.A2_plateau = { good, tot };
  }
  {
    const arr = (R.rows.A2_LD || []).filter(r => r.ex[20] != null);
    const byM = {};
    for (const r of arr) byM[r.d.slice(0, 7)] = (byM[r.d.slice(0, 7)] || 0) + 1;
    const top = Object.entries(byM).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const avg = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : NaN;
    const ex = arr.filter(r => !/^2020-0[2-4]|^2022|^2015-0[7-9]|^2011-0[8-9]/.test(r.d)).map(r => r.ex[20]);
    const med = (() => { const b = arr.map(r => r.ex[20]).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; })();
    log(`  集中度:最多的 5 個月 ${top.map(([m, n]) => `${m}×${n}`).join(' ')}(佔 ${(top.reduce((t, x) => t + x[1], 0) / Math.max(1, arr.length) * 100).toFixed(0)}%)`);
    log(`  拿掉 2011-08~09 / 2015-07~09 / 2020-02~04 / 2022 全年那幾段大跌之後:n=${ex.length} 20 日超額 ${f2(avg(ex))}pp ・全部的中位數 ${f2(med)}pp`);
    out.main.A2_conc = { top, exCrash: { n: ex.length, e20: avg(ex) }, med };
  }
  log('\n━━ 門檻高原(20 日超額 pp;⭐ 同方向且 |超額| > 0.44 的格數)━━');
  for (const [kind, s] of [['A1', -1], ['A1r', +1]]) {
    let good = 0, tot = 0;
    for (const N of GRID.N) {
      const cells = [];
      for (const Xp of GRID.X) for (const Yp of GRID.Y) {
        const k = `${kind}_${N}_${Xp}_${Yp}`, v = S[k];
        if (v && !v.thin) { tot++; if (s * v.e20 > 0 && Math.abs(v.e20) > COST) good++; }
        cells.push(v && !v.thin ? f2(v.e20) : '—');
        out.grid[k] = v && !v.thin ? { n: v.n, e20: v.e20, posYears: v.posYears, years: (v.years || []).length } : null;
      }
      log(`  ${kind} N=${N}:${cells.join(' ')}`);
    }
    log(`  ⭐ ${kind}:${good}/${tot} 格同方向且超過成本`);
    out.grid[kind + '_plateau'] = { good, tot };
    // ⭐ 同一格減掉乾淨對照(融資一樣增 / 減,但法人沒賣 / 沒買)—— 這才是「法人那一半有沒有多給資訊」
    //    (上面那張是跟同一天所有股票比;融資大減本身就常常是跌深之後,⛔ 不可把那個算成法人的功勞)
    let g2 = 0, t2 = 0;
    for (const N of GRID.N) {
      const cells = [];
      for (const Xp of GRID.X) for (const Yp of GRID.Y) {
        const v = S[`${kind}_${N}_${Xp}_${Yp}`], c = S[`${kind === 'A1' ? 'C1' : 'C1r'}_${N}_${Xp}`];
        if (v && !v.thin && c && !c.thin) { const d = v.e20 - c.e20; t2++; if (s * d > 0 && Math.abs(d) > COST) g2++; cells.push(f2(d)); out.grid[`${kind}_vsC_${N}_${Xp}_${Yp}`] = d; }
        else cells.push('—');
      }
      log(`  ${kind}−乾淨對照 N=${N}:${cells.join(' ')}`);
    }
    log(`  ⭐ ${kind} 比乾淨對照:${g2}/${t2} 格同方向且差距超過成本`);
    out.grid[kind + '_vsC_plateau'] = { good: g2, tot: t2 };
  }
  {
    let good = 0, tot = 0; const cells = [];
    for (const Xp of GRID.X) for (const Yp of GRID.Y) {
      const v = S[`A3_${Xp}_${Yp}`];
      if (v && !v.thin) { tot++; if (v.e20 < 0 && Math.abs(v.e20) > COST) good++; }
      cells.push(v && !v.thin ? f2(v.e20) : '—');
    }
    log(`  A3:${cells.join(' ')}\n  ⭐ A3:${good}/${tot} 格同方向且超過成本`);
    out.grid.A3_plateau = { good, tot };
  }
  return out;
}

// ───────────────────────── selftest(合成資料)─────────────────────────
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function synth(dir, { inject = true, injectSameDay = false, nStock = 60, nDay = 520, seed = 7 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const R = rng(seed);
  const d0 = Date.UTC(2014, 0, 6), dates = [];
  for (let k = 0, t = d0; dates.length < nDay; t += 86400000) { const wd = new Date(t).getUTCDay(); if (wd && wd < 6) dates.push(new Date(t).toISOString().slice(0, 10)); k++; }
  fs.writeFileSync(path.join(dir, '^TWII.json'), JSON.stringify(dates.map((d, i) => ({ date: d, open: 100 + i * 0.01, high: 101, low: 99, close: 100 + i * 0.01 }))));
  const marks = {};
  for (let s = 0; s < nStock; s++) {
    const sym = String(1101 + s), rows = [];
    let p = 50 + R() * 50, m = 2000 + R() * 2000;
    const evAt = new Set();
    if (s % 3 === 0) for (let k = 80 + (s % 7) * 10; k < nDay - 40; k += 120) evAt.add(k);      // 三分之一的股票有 A1 型態
    marks[sym] = [...evAt];
    let pend = 0, mUp = 0, sell = 0, armed = false;
    const mh = [], fh = [];
    for (let i = 0; i < nDay; i++) {
      if (evAt.has(i)) { mUp = 10; sell = 10; armed = true; }                    // 之後 10 天:融資每天 +2.5%、法人每天賣 6% 的量
      const vol = 1e6;
      let fNet = (R() - 0.5) * 0.02 * vol;
      if (mUp > 0) { m *= 1.025; mUp--; } else m *= 1 + (R() - 0.5) * 0.01;
      if (sell > 0) { fNet = -0.06 * vol; sell--; }
      mh.push(Math.round(m)); fh.push(fNet);
      // 照探針同一條規則算「今天收盤後訊號會不會成立」(N=10・融資 ≥10%・法人 ≤ −3% 佔量)
      let fire = false;
      if (armed && i >= 10 && mh[i - 10] >= MIN_M) {
        const mc = (mh[i] - mh[i - 10]) / mh[i - 10] * 100;
        let sf = 0; for (let k = i - 9; k <= i; k++) sf += fh[k];
        if (mc >= 10 && sf / (10 * vol) * 100 <= -3) { fire = true; armed = false; }
      }
      let r = (R() - 0.5) * 0.02;
      if (fire && inject) pend = 20;                                             // 訊號之後 20 天每天少 0.4%(= 約 −8%)
      else if (pend > 0) { r -= 0.004; pend--; }
      if (fire && injectSameDay) r -= 0.08;                                      // 只在訊號那天收盤前就跌完(⛔ 進場在隔天開盤 → 不該算到)
      const o = p, c = p * (1 + r);
      rows.push({ date: dates[i].replace(/-/g, '/'), open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c,
                  volume: vol, margin_balance: Math.round(m), foreign_net: fNet, trust_net: 0, dealer_net: 0 });
      p = c;
    }
    fs.writeFileSync(path.join(dir, sym + '.json'), JSON.stringify(rows));
  }
  return marks;
}

export function selftest() {
  const bad = [];
  const ok = (name, c, extra = '') => { console.log((c ? '✅ ' : '❌ ') + name + (c ? '' : '  ' + extra)); if (!c) bad.push(name); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retailinst-'));
  const small = { N: [10], X: [10], Y: [3] };
  try {
    // ① 有注入 → A1 20 日超額明顯為負
    const d1 = path.join(tmp, 'a');
    synth(d1, { inject: true });
    const R1 = run(d1, { log: () => {}, grid: small });
    const A1 = R1.S['A1_10_10_3'], C1 = R1.S['C1_10_10'];
    ok('① 注入「之後 20 天跌約 8%」→ A1 抓得到(20 日超額 < −4pp)', A1 && !A1.thin && A1.e20 < -4, JSON.stringify(A1 || {}).slice(0, 200));
    // ② 決定性對照:同一批股票不注入 → A1 ≈ 0
    const d2 = path.join(tmp, 'b');
    synth(d2, { inject: false });
    const R2 = run(d2, { log: () => {}, grid: small });
    const A1b = R2.S['A1_10_10_3'];
    ok('② ⭐ 決定性對照:沒注入 → A1 ≈ 0(|超額| < 1pp)', A1b && !A1b.thin && Math.abs(A1b.e20) < 1, JSON.stringify(A1b || {}).slice(0, 200));
    // ③ 前視:跌在訊號那天收盤前 → 隔天開盤進場的人吃不到 → ⛔ 不可算成訊號有效
    const d3 = path.join(tmp, 'c');
    synth(d3, { inject: false, injectSameDay: true });
    const R3 = run(d3, { log: () => {}, grid: small });
    const A1c = R3.S['A1_10_10_3'];
    ok('③ ⭐ 前視:跌完才出訊號 → 隔天開盤進場的超額 ≈ 0', A1c && !A1c.thin && Math.abs(A1c.e20) < 1, JSON.stringify(A1c || {}).slice(0, 200));
    // ④ 去重:一次型態(融資連增 10 天 + 法人連賣 10 天)只算一次
    const X = loadX(d1, '1101');
    const ev = eventsOf(X, 0.78, small);
    const marks = synth(path.join(tmp, 'm'), { inject: true });
    ok('④ 同一次型態只算一次(20 天內不重複)', (ev['A1_10_10_3'] || []).length === marks['1101'].length, `${(ev['A1_10_10_3'] || []).length} vs ${marks['1101'].length}`);
    // ⑤ 缺值 = 不知道:法人有一天是 null → 那個窗口不判
    const Xm = loadX(d1, '1101');
    const k0 = marks['1101'][0] + 9;
    Xm.f[k0 - 3] = NaN;
    const ins = instPrefix(Xm);
    ok('⑤ 法人窗口裡有一天沒資料 → NaN(⛔ 當 0)', Number.isNaN(ins(k0, 10)) && Number.isFinite(ins(k0 + 10, 5)), `${ins(k0, 10)}`);
    // ⑥ 追繳線 = App 的公式(增加日加權 (H+L+C)/3 × 成數)
    const T = { n: 12, m: Float64Array.from([100, 110, 110, 130, 130, 130, 130, 130, 130, 130, 130, 130]),
                h: new Float64Array(12).fill(11), l: new Float64Array(12).fill(9), c: new Float64Array(12).fill(10) };
    T.c[1] = 10; T.h[3] = 22; T.l[3] = 18; T.c[3] = 20;
    const cl = callLine(T, 11, 0.78);
    ok('⑥ 追繳線:增加日 (高+低+收)/3 加權 × 0.78', Math.abs(cl - ((10 * 10 + 20 * 20) / 30) * 0.78) < 1e-9, String(cl));
    // ⑦ 六關方向:看空的假設要看「負」
    const G = gates(A1, C1, -1);
    ok('⑦ 注入的資料六關 ≥ 4(看空方向)', G.pass >= 4, JSON.stringify(G));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ retail_inst_probe selftest 全過'}`);
  return bad.length ? 1 : 0;
}

function main() {
  const dir = process.argv[2] || process.env.DATA_DIR;
  if (!dir) { console.error('用法:node scripts/retail_inst_probe.mjs <dataDir>'); process.exit(2); }
  const t0 = Date.now();
  const R = run(dir, { names: process.env.NAMES || '' });
  const out = report(R);
  if (process.env.OUT) {
    fs.writeFileSync(process.env.OUT, JSON.stringify({ at: new Date().toISOString(), dir, ...out }, null, 1));
    console.log(`\n💾 ${process.env.OUT}`);
  }
  console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest());
else if (IS_MAIN) main();
