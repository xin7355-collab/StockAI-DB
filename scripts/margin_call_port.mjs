#!/usr/bin/env node
/**
 * 🧯💰 「融資斷頭之後買」真的拿錢去做會怎樣(V79.6.3)—— 只讀探針,接 retail_inst_probe.mjs 的 A2
 *
 * ❓ 事件研究(retail_inst_probe)量到:融資族群跌破推估追繳線 + 融資 5 日減 ≥10% → 隔天開盤買、抱 20 天,
 *    平均比同一天全部股票多約 +4pp(16 年 3,007 次、13/14 年同方向;跟「跌一樣深、一樣急」的比仍多 +2.4pp)。
 * 🚨 但一筆一筆算是賺的 ≠ 拿錢去做會賺(實測總表 hot-drop-reversal:熱門股跌深撿 → 一筆一筆賺、組合 16 年 −99%):
 *    事件有 53% 擠在 5 個月(2025-04 / 2020-03 / 2015-08 …),一天上百檔,錢只夠買幾檔,而且買在大跌途中。
 * → 這支模擬一個真的帳戶:100 萬、最多同時 M 檔、每檔 = 當下總資產 ÷ M、照「跌破追繳線最深」先買、抱 20 個交易日收盤賣,
 *    扣手續費 + 證交稅(來回 0.44%),閒錢不動;跟同一段 0050 含息、跟「同一天跌一樣深、但沒有斷頭」隨機挑(安慰劑)比。
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/margin_call_port.mjs <dataDir>      # d16_fi(要有 _bench0050.json / _div0050.json 才比 0050)
 *   SLOTS=5,10,20  FROM=2011-01-01  NAMES=data/stock_names.json
 *   node scripts/margin_call_port.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadX, marginCallAt, readNames, ratioOf } from './retail_inst_probe.mjs';
import { cliffIn } from './lib_cliff.mjs';
import { lockedBar } from './lib_limit.mjs';

const BUY_COST = 0.0007, SELL_COST = 0.0037;     // 手續費約 0.07%(折後)×2 + 證交稅 0.3% ≈ 來回 0.44%
export const HOLD = 20;
const iso = s => String(s || '').replace(/\//g, '-').slice(0, 10);
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

// 掃全部股票 → 候選(進場日、進場價、出場日、出場價、排序值)。kind = 'a2'(融資斷頭)/ 'sham'(同一天跌一樣深、沒斷頭)
export function scan(dir, names, opts = {}) {
  const syms = fs.readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('^') && !x.startsWith('_')).map(x => x.slice(0, -5))
    .filter(s => /^[1-9]\d{3}$/.test(s));
  const cand = { a2: [], sham: [] }, closes = new Map();
  for (const sym of syms) {
    const X = loadX(dir, sym);
    if (!X) continue;
    const ratio = ratioOf(names, sym);
    let lastA2 = -999, lastSh = -999;
    const keep = [];
    for (let i = 60; i < X.n - 1; i++) {
      const mc = marginCallAt(X, i, ratio);
      let hi60 = 0; for (let k = i - 59; k <= i; k++) if (X.c[k] > hi60) hi60 = X.c[k];
      const dd = hi60 > 0 ? X.c[i] / hi60 - 1 : 0;
      const kind = mc ? 'a2' : (dd <= -0.30 ? 'sham' : null);
      if (!kind) continue;
      if (kind === 'a2' ? i - lastA2 < HOLD : i - lastSh < HOLD) continue;
      const e = i + 1;
      if (!(X.o[e] > 0)) continue;
      if (lockedBar(X.dates[e], X.c[e - 1], X.o[e], X.h[e], X.l[e]) === 1) continue;     // 鎖漲停買不到(鎖跌停買得到)
      const xi = Math.min(e + HOLD, X.n - 1);                                              // 資料先結束(下市)→ 用最後一根
      if (cliffIn(X.pre, i - 5, xi)) continue;
      if (kind === 'a2') lastA2 = i; else lastSh = i;
      cand[kind].push({ sym, sig: X.dates[i], ed: X.dates[e], eo: X.o[e], xd: X.dates[xi], rank: mc ? mc.depth : dd, ei: e, xi });
      keep.push([e, xi]);
    }
    if (keep.length) closes.set(sym, { dates: X.dates, c: X.c });
  }
  return { cand, closes, nSym: syms.length };
}

// 一個帳戶:每天先賣到期的(收盤價),再用開盤價買當天的候選(照 rank 小 → 大;sham 隨機)
export function simulate(cal, cand, closes, opts = {}) {
  const M = opts.slots || 10, cap0 = opts.capital || 1e6, from = opts.from || '0000', R = opts.rand ? rng(opts.rand) : null;
  const byDay = new Map();
  for (const c of cand) { if (c.ed < from) continue; (byDay.get(c.ed) || byDay.set(c.ed, []).get(c.ed)).push(c); }
  const idxCache = new Map();
  const idxOf = (sym, d) => {           // 那檔在日期 d 的索引(最後一根 ≤ d)
    const K = closes.get(sym); if (!K) return -1;
    let lo = 0, hi = K.dates.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (K.dates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };
  let cash = cap0, pos = [], trades = [], eq = [], inv = 0, days = 0;
  for (const d of cal) {
    if (d < from) continue;
    // ① 賣:到期日(或資料最後一天)收盤
    const still = [];
    for (const p of pos) {
      if (d >= p.xd) {
        const K = closes.get(p.sym), px = K.c[p.xi];
        const v = p.sh * px * (1 - SELL_COST);
        cash += v; trades.push({ sym: p.sym, ed: p.ed, xd: p.xd, ret: v / p.cost - 1 });
      } else still.push(p);
    }
    pos = still;
    // ② 買:開盤
    const list = (byDay.get(d) || []).filter(c => !pos.some(p => p.sym === c.sym));
    if (list.length && pos.length < M) {
      if (R) { for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; } }
      else list.sort((a, b) => a.rank - b.rank);
      // 總資產用昨天收盤估(⛔ 用今天收盤 = 前視)
      let nav = cash; for (const p of pos) { const K = closes.get(p.sym), k = idxOf(p.sym, d); nav += p.sh * K.c[Math.max(0, k - (K.dates[k] === d ? 1 : 0))]; }
      for (const c of list) {
        if (pos.length >= M) break;
        const alloc = Math.min(cash, nav / M);
        if (alloc < 1000) break;
        const sh = alloc / (c.eo * (1 + BUY_COST));
        cash -= alloc;
        pos.push({ sym: c.sym, ed: c.ed, xd: c.xd, xi: c.xi, sh, cost: alloc });
      }
    }
    // ③ 收盤市值
    let v = cash;
    for (const p of pos) { const K = closes.get(p.sym), k = idxOf(p.sym, d); v += p.sh * (k >= 0 ? K.c[k] : 0); }
    eq.push([d, v]); days++; if (pos.length) inv++;
  }
  return { eq, trades, invested: days ? inv / days : 0 };
}

export function stats(eq, cap0 = 1e6) {
  if (!eq.length) return null;
  let peak = eq[0][1], mdd = 0;
  for (const [, v] of eq) { if (v > peak) peak = v; mdd = Math.min(mdd, v / peak - 1); }
  const last = eq[eq.length - 1][1], yrs = Math.max(1 / 252, eq.length / 252);
  const byY = {};
  for (const [d, v] of eq) { const y = d.slice(0, 4); if (!byY[y]) byY[y] = [v, v]; byY[y][1] = v; }
  const ys = Object.keys(byY).sort(); const yr = {};
  let prev = cap0; for (const y of ys) { yr[y] = byY[y][1] / prev - 1; prev = byY[y][1]; }
  return { mult: last / cap0, cagr: Math.pow(last / cap0, 1 / yrs) - 1, mdd, years: yr };
}

// 0050 含息(_bench0050.json 已經對齊分割;_div0050.json 每次除息用自己的「除息前收盤 ÷ (除息前收盤 − 股利)」)
export function bench0050(dir, cal, from) {
  let B, Dv;
  try { B = JSON.parse(fs.readFileSync(path.join(dir, '_bench0050.json'), 'utf8')); } catch { return null; }
  try { Dv = JSON.parse(fs.readFileSync(path.join(dir, '_div0050.json'), 'utf8')); } catch { Dv = null; }
  const fac = new Map();
  for (const h of (((Dv || {}).d || {})['0050'] || {}).h || []) { const [d, a, , pc] = h; if (pc > a && a > 0) fac.set(d, pc / (pc - a)); }
  const px = new Map(B.map(r => [iso(r.date), +r.close]));
  let f = 1, out = [], base = null;
  for (const d of cal) {
    if (fac.has(d)) f *= fac.get(d);
    if (d < from || !px.has(d)) continue;
    const v = px.get(d) * f;
    if (base == null) base = v;
    out.push([d, v / base * 1e6]);
  }
  return out;
}

function fmt(x, d = 1) { return x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%'; }

export function main() {
  const dir = process.argv[2] || process.env.DATA_DIR;
  if (!dir) { console.error('用法:node scripts/margin_call_port.mjs <dataDir>'); process.exit(2); }
  const from = process.env.FROM || '2011-01-01';
  const slotsL = String(process.env.SLOTS || '5,10,20').split(',').map(Number).filter(n => n > 0);
  const names = readNames(process.env.NAMES || '');
  const t0 = Date.now();
  const twii = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8')).map(r => iso(r.date)).filter(Boolean);
  const cal = Array.from(new Set(twii)).sort();
  const { cand, closes, nSym } = scan(dir, names);
  console.log(`📂 ${nSym} 檔 ・融資斷頭候選 ${cand.a2.length} 筆 ・安慰劑候選(跌離 60 日高 ≥30%、沒斷頭)${cand.sham.length} 筆 ・${from} 起`);
  {
    const raw = c => { const K = closes.get(c.sym); return K ? K.c[c.xi] / c.eo - 1 : NaN; };
    const avg = a => { const b = a.filter(Number.isFinite); return b.reduce((t, x) => t + x, 0) / Math.max(1, b.length); };
    console.log(`🔍 每一筆都買(不管錢夠不夠)的平均 20 日報酬(沒扣成本):融資斷頭 ${fmt(avg(cand.a2.filter(c => c.ed >= from).map(raw)), 2)} ・安慰劑 ${fmt(avg(cand.sham.filter(c => c.ed >= from).map(raw)), 2)}`);
  }
  const B = bench0050(dir, cal, from), bs = B ? stats(B) : null;
  if (bs) console.log(`📏 0050 含息:×${bs.mult.toFixed(2)} ・每年 ${fmt(bs.cagr)} ・中途最多賠 ${fmt(bs.mdd)}`);
  const out = { from, bench: bs, runs: {} };
  for (const M of slotsL) {
    const RK = process.env.RANK || 'depth';
    const r = RK === 'rand' ? simulate(cal, cand.a2, closes, { slots: M, from, rand: 11 })
      : simulate(cal, RK === 'shallow' ? cand.a2.map(c => ({ ...c, rank: -c.rank })) : cand.a2, closes, { slots: M, from });
    const st = stats(r.eq);
    const wins = r.trades.filter(t => t.ret > 0).length;
    const sham = [1, 2, 3, 4, 5].map(seed => stats(simulate(cal, cand.sham, closes, { slots: M, from, rand: seed }).eq));
    const shM = sham.map(x => x.mult).sort((a, b) => a - b);
    console.log(`\n💰 最多同時 ${M} 檔:×${st.mult.toFixed(2)} ・每年 ${fmt(st.cagr)} ・中途最多賠 ${fmt(st.mdd)} ・${r.trades.length} 筆(賺錢 ${fmt(wins / Math.max(1, r.trades.length), 0)})・有持股的日子 ${fmt(r.invested, 0)}`);
    console.log(`   🎲 安慰劑(同一天跌一樣深、沒斷頭、隨機挑 ×5):×${shM.map(x => x.toFixed(2)).join(' / ')}`);
    console.log(`   📅 逐年:${Object.entries(st.years).map(([y, v]) => `${y.slice(2)} ${fmt(v, 0)}`).join(' ・')}`);
    if (bs) {
      const by = bs.years, beat = Object.keys(st.years).filter(y => by[y] != null && st.years[y] > by[y]).length;
      console.log(`   🆚 0050 含息:逐年贏 ${beat}/${Object.keys(st.years).filter(y => by[y] != null).length} 年`);
    }
    const avgT = r.trades.reduce((t, x) => t + x.ret, 0) / Math.max(1, r.trades.length);
    console.log(`   🔍 帳戶實際買到的那幾筆:平均每筆 ${fmt(avgT, 2)}(已扣成本)`);
    out.runs[M] = { st, trades: r.trades.length, win: wins / Math.max(1, r.trades.length), invested: r.invested, sham: shM, avgTrade: avgT };
  }
  if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1)); console.log(`\n💾 ${process.env.OUT}`); }
  console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}

// ───────────── selftest ─────────────
export function selftest() {
  const bad = []; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) bad.push(n); };
  // 合成:兩檔,A 在第 10 天出現候選,之後 20 天漲 10%;B 同一天候選、20 天跌 10%;一個帳戶 1 格 → 先買 rank 小的
  const cal = Array.from({ length: 60 }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')}`.replace(/-(\d\d)$/, (m, d) => '-' + d));
  const dates = cal.slice();
  const mk = (drift) => ({ dates, c: Float64Array.from(dates.map((_, i) => i < 11 ? 100 : 100 * (1 + drift * Math.min(1, (i - 10) / 20)))) });
  const closes = new Map([['A', mk(0.10)], ['B', mk(-0.10)]]);
  const cand = [{ sym: 'A', ed: dates[11], eo: 100, xd: dates[31], xi: 31, rank: 0.8 }, { sym: 'B', ed: dates[11], eo: 100, xd: dates[31], xi: 31, rank: 0.9 }];
  const r = simulate(cal, cand, closes, { slots: 1 });
  ok('① 一格 → 先買跌破追繳線最深的(rank 小)那檔', r.trades.length === 1 && r.trades[0].sym === 'A', JSON.stringify(r.trades));
  ok('② 損益扣了來回成本(+10% 變成約 +9.5%)', Math.abs(r.trades[0].ret - (1.10 * (1 - SELL_COST) / (1 + BUY_COST) - 1)) < 1e-9, String(r.trades[0].ret));
  const r2 = simulate(cal, cand, closes, { slots: 2 });
  const st2 = stats(r2.eq);
  ok('③ 兩格 → 兩檔都買、一賺一賠 ≈ 打平扣成本', r2.trades.length === 2 && st2.mult < 1 && st2.mult > 0.98, JSON.stringify(st2));
  const st = stats([['2020-01-01', 1e6], ['2020-06-01', 1.2e6], ['2020-12-31', 0.9e6], ['2021-06-01', 1.1e6]]);
  ok('④ 中途最多賠 = 從最高點回落(1.2 → 0.9 = −25%)', Math.abs(st.mdd + 0.25) < 1e-9 && Math.abs(st.years['2020'] + 0.10) < 1e-9, JSON.stringify(st));
  console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ margin_call_port selftest 全過'}`);
  return bad.length ? 1 : 0;
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest());
else if (IS_MAIN) main();
