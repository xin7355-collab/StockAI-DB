#!/usr/bin/env node
/**
 * 🕯️💰 「跌停後大紅 K」真的拿錢照做會怎樣(V82.4.1,EXP-20261116-01)—— 只讀探針
 *
 * ❓ streak_probe 一筆一筆看:大盤一起跌造成的跌停 → 隔天收漲 ≥3% → 再隔天開盤買,10 天比大盤多約 4~5pp、每一關都過。
 * 🚨 一筆一筆是賺的 ≠ 拿錢去做會賺(融資斷頭那條就是:事件 +4.3pp、照資金實做輸隨便挑)——
 *    這種事件擠在大跌那幾天,一天幾十檔,錢只夠買幾檔。
 * → 一個真的帳戶:100 萬平常全放 0050(含息);有訊號那天開盤賣 0050 換股票,最多同時 10 檔、每檔 = 前一天總資產 ÷ 10、
 *    候選比空格多 → 20 日均成交金額大的先、20 日均成交金額 ≥ 1 億才買;進場後第 10 個交易日收盤賣、換回 0050。
 *    跟「同一段一直放 0050」比;安慰劑 = 同樣大盤一起跌的跌停、但隔天漲不到 3% 的股票,同一套帳戶規則隨機挑 ×20。
 *
 * 事件定義只在 lib_ldred.mjs(streak_probe 也用它);帳戶只在 margin_call_port.simulate。⛔ 這裡不另寫門檻。
 * 六條過關條件事先登記在 research/experiments.ndjson(EXP-20261116-01),寫死在 judge(),⛔ 跑完再改。
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/ldred_port.mjs <d16> [d04]     # d04 = 2004~2010 那段(research_pack TW04=1)
 *   OUT=out.json  LIST=2026-11-01(列出這天以後的訊號與到資料最後一天的報酬)
 *   node scripts/ldred_port.mjs --selftest        LD_INJECT=peek|nolock|noseq 必紅
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadX } from './retail_inst_probe.mjs';
import { cliffIn } from './lib_cliff.mjs';
import { lockedBar } from './lib_limit.mjs';
import { isLD, isSystemic, isBigRed } from './lib_ldred.mjs';
import { simulate, stats, bench0050, park0050 } from './margin_call_port.mjs';

export const HOLD = 10, SLOTS = 10, MIN_AMT = 1e8, DEDUP = 10, N_SHAM = 20, HOLD_MAX = 20;
export const BEAR_YEARS = ['2008', '2011', '2015', '2018', '2022', '2025'];
export const P1 = { from: '2011-01-01', to: '9999-12-31' }, P2 = { from: '2004-08-01', to: '2010-12-31' };
const PARK_RT = 0.0007 + 0.0017;          // 0050 來回成本
const INJ = process.env.LD_INJECT || '';
const iso = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;
const pc = (x, d = 1) => x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%';

/** 加權:日期 → 索引、當天漲跌 %、嚴格空頭(收盤 < 60 日線且 20 日線 < 60 日線) */
export function mktState(rows) {
  const R = rows.filter(r => r && +r.close > 0).map(r => ({ d: iso(r.date), c: +r.close })).filter(r => r.d).sort((a, b) => a.d < b.d ? -1 : 1);
  const n = R.length, cal = R.map(r => r.d), idx = new Map(cal.map((d, i) => [d, i]));
  const chg = new Float64Array(n).fill(NaN), bear = new Uint8Array(n);
  let s20 = 0, s60 = 0;
  for (let i = 0; i < n; i++) {
    if (i) chg[i] = (R[i].c / R[i - 1].c - 1) * 100;
    s20 += R[i].c; s60 += R[i].c;
    if (i >= 20) s20 -= R[i - 20].c;
    if (i >= 60) s60 -= R[i - 60].c;
    if (i >= 59) { const m20 = s20 / 20, m60 = s60 / 60; bear[i] = R[i].c < m60 && m20 < m60 ? 1 : 0; }
  }
  return { cal, idx, chg, bear, close: R.map(r => r.c) };
}

/**
 * 掃全部個股 → 候選。
 *   real   = 大盤一起跌的跌停 → 隔天大紅(主訊號)
 *   shamA  = 大盤一起跌的跌停 → 隔天漲不到 3%(安慰劑)
 *   bigAny = 大盤沒跌的跌停 → 隔天大紅(「不看大盤」那一組 = real + bigAny)
 * opts.sameDay = Set(訊號日) → 另外收「那幾個訊號日隨便一檔」(shamB,只描述)
 */
export function scan(dir, M, opts = {}) {
  const syms = fs.readdirSync(dir).filter(x => /^[1-9]\d{3}\.json$/.test(x)).map(x => x.slice(0, -5));
  const out = { real: [], shamA: [], bigAny: [], shamB: [] }, closes = new Map();
  for (const sym of syms) {
    const X = loadX(dir, sym);
    if (!X || X.n < 30) continue;
    const n = X.n, mi = new Int32Array(n);
    for (let i = 0; i < n; i++) { const k = M.idx.get(X.dates[i]); mi[i] = k == null ? -9 : k; }
    const last = { real: -99, shamA: -99, bigAny: -99, shamB: -99 };
    let keep = false, s20 = 0;
    const amt = new Float64Array(n);
    for (let i = 0; i < n; i++) { const a = X.c[i] * (Number.isFinite(X.v[i]) ? X.v[i] : 0); s20 += a; if (i >= 20) s20 -= X.c[i - 20] * (Number.isFinite(X.v[i - 20]) ? X.v[i - 20] : 0); amt[i] = i >= 19 ? s20 / 20 : NaN; }
    for (let i = 21; i < n - 1; i++) {
      const e = i + 1;
      const seq = INJ === 'noseq' ? true : (mi[i] >= 0 && mi[i - 1] === mi[i] - 1 && mi[i - 2] === mi[i] - 2 && mi[e] === mi[i] + 1);   // 前兩天、今天、明天都是連續的交易日(中間停牌不算)
      if (!seq || mi[i] < 0) continue;
      const chgP = (X.c[i - 1] / X.c[i - 2] - 1) * 100, chgT = (X.c[i] / X.c[i - 1] - 1) * 100;
      let kind = null;
      if (isLD(chgP, X.dates[i - 1])) {
        const sys = isSystemic(M.chg[mi[i - 1]]), big = isBigRed(chgT);
        kind = sys && big ? 'real' : sys ? 'shamA' : big ? 'bigAny' : null;
      }
      const kinds = kind ? [kind] : [];
      if (opts.sameDay && opts.sameDay.has(X.dates[i]) && kind !== 'real') kinds.push('shamB');
      if (!kinds.length) continue;
      if (!(X.o[e] > 0)) continue;
      if (INJ !== 'nolock' && lockedBar(X.dates[e], X.c[i], X.o[e], X.h[e], X.l[e]) === 1) continue;     // 開盤鎖漲停買不到
      if (cliffIn(X.pre, i - 5, Math.min(e + HOLD_MAX, n - 1))) continue;
      for (const k of kinds) {
        if (i - last[k] < DEDUP) continue;
        last[k] = i;
        out[k].push({ sym, sig: X.dates[i], ed: X.dates[e], eo: INJ === 'peek' ? X.c[i] : X.o[e], ei: e, amt: amt[i], dd: chgP, red: chgT,
          tag: { bear: M.bear[mi[i]], y: X.dates[e].slice(0, 4) } });
        keep = true;
      }
    }
    if (keep) closes.set(sym, { dates: X.dates, c: X.c });
  }
  return { cand: out, closes, nSym: syms.length };
}

/** 候選 → 帳戶(只組參數;帳戶本身在 margin_call_port.simulate) */
export function run(cal, cands, closes, o = {}) {
  const hold = o.hold || HOLD, minAmt = o.minAmt == null ? MIN_AMT : o.minAmt;
  const list = cands.filter(c => (minAmt <= 0 || c.amt >= minAmt) && (!o.skipDays || !o.skipDays.has(c.ed))).map(c => {
    const K = closes.get(c.sym), xi = Math.min(c.ei + hold, K.dates.length - 1);
    return { ...c, xi, xd: K.dates[xi], rank: o.rankBy === 'deep' ? c.dd : -c.amt };
  });
  return simulate(cal, list, closes, { slots: o.slots || SLOTS, from: o.from, to: o.to, park: o.park, costX: o.costX, rand: o.rand });
}

const lastOf = eq => eq.length ? eq[eq.length - 1][1] : null;
const cut = (eq, to) => eq.filter(([d]) => d <= to);

/** 一段期間:主帳戶 + 對照 + 安慰劑 + 壓力測試 */
export function period(dir, P, opts = {}) {
  const M = mktState(JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8')));
  const cal = M.cal, park = park0050(dir, cal);
  if (!park) throw new Error(`${dir} 沒有 _bench0050.json`);
  const s1 = scan(dir, M);
  const inP = c => c.ed >= P.from && c.ed <= P.to;
  const real = s1.cand.real.filter(inP), shamA = s1.cand.shamA.filter(inP), bigAny = s1.cand.bigAny.filter(inP);
  const base = { from: P.from, to: P.to, park };
  const B = cut(bench0050(dir, cal, P.from) || [], P.to), bs = stats(B);
  const A = run(cal, real, s1.closes, base), as = stats(A.eq);
  // 安慰劑 ×20
  const sham = []; for (let s = 1; s <= (opts.nSham || N_SHAM); s++) sham.push(stats(run(cal, shamA, s1.closes, { ...base, rand: s }).eq).mult);
  // 拿掉賺最多的 3 個進場日
  const byDay = new Map(); for (const t of A.trades) byDay.set(t.ed, (byDay.get(t.ed) || 0) + t.pnl);
  const top3 = [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  const A4 = stats(run(cal, real, s1.closes, { ...base, skipDays: new Set(top3) }).eq);
  const A5 = stats(run(cal, real, s1.closes, { ...base, costX: 2 }).eq);
  // 逐年(只算有進場的年份)
  const yTr = new Set(A.trades.map(t => t.ed.slice(0, 4)));
  const ys = [...yTr].sort().filter(y => as.years[y] != null && bs.years[y] != null);
  const yWin = ys.filter(y => as.years[y] > bs.years[y]);
  // 空頭日進場的那幾筆:每筆 − 同一段 0050 − 0050 來回成本
  const bearTr = A.trades.filter(t => t.tag && t.tag.bear).map(t => {
    const po = park.po.get(t.ed), pcl = park.pc.get(t.xd);
    return { y: t.ed.slice(0, 4), x: po > 0 && pcl > 0 ? t.ret - (pcl / po - 1) - PARK_RT : null };
  }).filter(t => t.x != null);
  // 只描述的變體
  const desc = {};
  if (!opts.lite) {
    for (const m of [5, 20]) desc[`最多 ${m} 檔`] = stats(run(cal, real, s1.closes, { ...base, slots: m }).eq).mult;
    for (const h of [5, 20]) desc[`抱 ${h} 天`] = stats(run(cal, real, s1.closes, { ...base, hold: h }).eq).mult;
    desc['跌最深的先'] = stats(run(cal, real, s1.closes, { ...base, rankBy: 'deep' }).eq).mult;
    desc['隨機先'] = stats(run(cal, real, s1.closes, { ...base, rand: 7 }).eq).mult;
    desc['不看大盤'] = stats(run(cal, real.concat(bigAny), s1.closes, base).eq).mult;
    desc['不設流動性門檻'] = stats(run(cal, real, s1.closes, { ...base, minAmt: 0 }).eq).mult;
    const cashRun = run(cal, real, s1.closes, { from: P.from, to: P.to });
    desc['閒錢放現金(不比 0050)'] = stats(cashRun.eq).mult;
    // 同一個訊號日隨便一檔(shamB)
    const s2 = scan(dir, M, { sameDay: new Set(real.map(c => c.sig)) });
    const sb = s2.cand.shamB.filter(inP), mB = [];
    for (let s = 1; s <= 5; s++) mB.push(stats(run(cal, sb, s2.closes, { ...base, rand: s }).eq).mult);
    desc['同一個訊號日隨便一檔 ×5'] = mB.sort((a, b) => a - b);
  }
  // 一筆一筆(不管錢夠不夠)的 10 天報酬 − 加權
  const ev = real.map(c => {
    const K = s1.closes.get(c.sym), j = c.ei + HOLD; if (j >= K.dates.length) return null;
    const a = M.idx.get(c.ed), b = M.idx.get(K.dates[j]); if (a == null || b == null || a < 1) return null;
    return (K.c[j] / c.eo - 1) - (M.close[b] / M.close[a - 1] - 1);           // 加權從進場前一天收盤算(加權沒有可成交的開盤價)
  }).filter(Number.isFinite);
  const mo = new Map(); for (const t of A.trades) mo.set(t.ed.slice(0, 7), (mo.get(t.ed.slice(0, 7)) || 0) + 1);
  const top5m = [...mo.values()].sort((a, b) => b - a).slice(0, 5).reduce((t, x) => t + x, 0);
  return {
    P, nSym: s1.nSym, nReal: real.length, nRealAmt: real.filter(c => c.amt >= MIN_AMT).length, nSham: shamA.filter(c => c.amt >= MIN_AMT).length,
    acct: as, bench: bs, trades: A.trades.length, days: byDay.size, win: A.trades.filter(t => t.ret > 0).length / Math.max(1, A.trades.length),
    avgTrade: mean(A.trades.map(t => t.ret)), invested: A.invested, top5m: top5m / Math.max(1, A.trades.length),
    sham: sham.sort((a, b) => a - b), top3, drop3: A4.mult, cost2: A5.mult, ys, yWin, bearTr, desc, evN: ev.length, evMean: mean(ev),
    _trades: A.trades, _cal: cal, _closes: s1.closes, _cand: s1.cand,
  };
}

/** 六條過關條件(EXP-20261116-01,⛔ 跑完再改)。r1 = 2011~、r2 = 2004-08~2010-12(可以是 null = 沒跑) */
export function judge(r1, r2) {
  const g = {};
  g[1] = { ok: !!(r1 && r2 && r1.acct.mult > r1.bench.mult && r2.acct.mult > r2.bench.mult),
    txt: `兩段期末都贏一直放 0050:2011~ ×${r1.acct.mult.toFixed(2)} vs ×${r1.bench.mult.toFixed(2)}` + (r2 ? ` ・2004~2010 ×${r2.acct.mult.toFixed(2)} vs ×${r2.bench.mult.toFixed(2)}` : ' ・2004~2010 沒跑') };
  const beat = r1.sham.filter(x => r1.acct.mult > x * (1 + 1e-9)).length;      // 差在小數第 9 位以後 = 浮點誤差,不算贏
  g[2] = { ok: r1.sham.length >= 20 && beat >= Math.ceil(r1.sham.length * 0.95), txt: `贏安慰劑 ${beat}/${r1.sham.length} 組(要 ≥ 19/20)` };
  const sh = r1.ys.length ? r1.yWin.length / r1.ys.length : 0;
  g[3] = { ok: r1.ys.length > 0 && sh >= 0.6, txt: `有進場的年份 ${r1.ys.length} 年,贏 0050 ${r1.yWin.length} 年(${(sh * 100).toFixed(0)}%,要 ≥ 60%)` };
  g[4] = { ok: r1.drop3 > r1.bench.mult, txt: `拿掉賺最多的 3 個進場日(${r1.top3.join('、')}):×${r1.drop3.toFixed(2)} vs 0050 ×${r1.bench.mult.toFixed(2)}` };
  g[5] = { ok: r1.cost2 > r1.bench.mult, txt: `成本加倍:×${r1.cost2.toFixed(2)} vs 0050 ×${r1.bench.mult.toFixed(2)}` };
  const bt = r1.bearTr.concat(r2 ? r2.bearTr : []), mAll = mean(bt.map(t => t.x));
  const yrs = BEAR_YEARS.map(y => ({ y, a: bt.filter(t => t.y === y).map(t => t.x) })).filter(o => o.a.length >= 5);
  const pos = yrs.filter(o => mean(o.a) > 0);
  g[6] = { ok: bt.length > 0 && mAll > 0 && yrs.length > 0 && pos.length / yrs.length >= 2 / 3,
    txt: `空頭日進場 ${bt.length} 筆:平均每筆比 0050 ${mAll == null ? '—' : (mAll * 100 >= 0 ? '+' : '') + (mAll * 100).toFixed(2) + '%'} ・六個空頭年裡 ≥5 筆的 ${yrs.length} 年、正的 ${pos.length} 年(${yrs.map(o => `${o.y} ${(mean(o.a) * 100).toFixed(1)}%/${o.a.length}筆`).join(' ・') || '沒有'})` };
  const pass = Object.values(g).every(x => x.ok);
  return { g, pass };
}

function show(tag, r) {
  console.log(`\n═══ ${tag}(${r.P.from} ~ ${r.P.to === '9999-12-31' ? '資料最後一天' : r.P.to})═══`);
  console.log(`📂 ${r.nSym} 檔 ・訊號 ${r.nReal} 筆(成交金額 ≥ 1 億的 ${r.nRealAmt} 筆)・安慰劑候選 ${r.nSham} 筆`);
  console.log(`🔍 一筆一筆(不管錢夠不夠):${r.evN} 筆,10 天比加權 ${r.evMean == null ? '—' : (r.evMean * 100 >= 0 ? '+' : '') + (r.evMean * 100).toFixed(2) + 'pp'}`);
  console.log(`💰 帳戶:×${r.acct.mult.toFixed(2)}(每年 ${pc(r.acct.cagr)}・中途最多賠 ${pc(r.acct.mdd)})・📏 一直放 0050:×${r.bench.mult.toFixed(2)}(每年 ${pc(r.bench.cagr)}・最多賠 ${pc(r.bench.mdd)})→ ${r.acct.mult > r.bench.mult ? '贏' : '輸'} ${((r.acct.mult / r.bench.mult - 1) * 100).toFixed(1)}%`);
  console.log(`   實際買到 ${r.trades} 筆 / ${r.days} 個進場日 ・賺錢 ${pc(r.win, 0)} ・平均每筆 ${pc(r.avgTrade, 2)}(已扣成本)・有持股的日子 ${pc(r.invested, 0)} ・最多的 5 個月佔 ${pc(r.top5m, 0)}`);
  console.log(`   🎲 安慰劑 ×${r.sham.length}:最差 ×${r.sham[0].toFixed(2)} ・中位 ×${r.sham[r.sham.length >> 1].toFixed(2)} ・最好 ×${r.sham[r.sham.length - 1].toFixed(2)}`);
  console.log(`   📅 逐年(帳戶 / 0050):${r.ys.map(y => `${y.slice(2)} ${pc(r.acct.years[y], 0)}/${pc(r.bench.years[y], 0)}`).join(' ・')}`);
  const d = Object.entries(r.desc);
  if (d.length) console.log(`   📎 只描述、不拿來判:${d.map(([k, v]) => `${k} ${Array.isArray(v) ? v.map(x => '×' + x.toFixed(2)).join('/') : '×' + v.toFixed(2)}`).join(' ・')}`);
}

export function main() {
  const d16 = process.argv[2], d04 = process.argv[3];
  if (!d16) { console.error('用法:node scripts/ldred_port.mjs <d16> [d04]'); process.exit(2); }
  const t0 = Date.now();
  const r1 = period(d16, P1);
  show('2011 起(d16)', r1);
  let r2 = null;
  if (d04) { r2 = period(d04, P2); show('2004~2010(d04,只有上市)', r2); }
  const J = judge(r1, r2);
  console.log('\n═══ 六條過關條件(EXP-20261116-01)═══');
  for (const k of Object.keys(J.g)) console.log(`${J.g[k].ok ? '✅' : '❌'} ${'①②③④⑤⑥'[k - 1]} ${J.g[k].txt}`);
  console.log(`\n${J.pass ? '✅ 六條全過' : '⛔ 沒過'}`);
  if (process.env.LIST) {
    const fromL = process.env.LIST;
    console.log(`\n═══ ${fromL} 以後的訊號(到資料最後一天)═══`);
    for (const k of ['real', 'bigAny']) for (const c of r1._cand[k].filter(c => c.sig >= fromL).sort((a, b) => a.sig < b.sig ? -1 : b.amt - a.amt)) {
      const K = r1._closes.get(c.sym), lastC = K.c[K.dates.length - 1];
      console.log(`${k === 'real' ? '🕯️' : '➖(大盤沒跌)'} ${c.sym} 訊號 ${c.sig}(跌停 ${c.dd.toFixed(1)}% → 紅 K +${c.red.toFixed(1)}%)・進場 ${c.ed} 開盤 ${c.eo} ・到 ${K.dates[K.dates.length - 1]} ${pc(lastC / c.eo - 1)} ・20 日均成交 ${(c.amt / 1e8).toFixed(1)} 億${c.amt >= MIN_AMT ? '' : '(不到 1 億,不買)'}`);
    }
  }
  if (process.env.OUT) {
    const strip = r => r && Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
    fs.writeFileSync(process.env.OUT, JSON.stringify({ exp: 'EXP-20261116-01', r1: strip(r1), r2: strip(r2), judge: J }, null, 1));
    console.log(`\n💾 ${process.env.OUT}`);
  }
  console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}

// ───────────── selftest ─────────────
/** 合成一個資料夾:mode = 'edge'(大紅的之後 10 天每天 +1%)/ 'none'(都不動)/ 'both'(安慰劑也一樣漲)/ 'gap'(大紅的隔天跳空 +4% 之後不動) */
export function synth(dir, mode, y0 = 2020) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const cal = []; let d = new Date(Date.UTC(y0, 0, 2));
  while (cal.length < 420) { const w = d.getUTCDay(); if (w && w < 6) cal.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
  const crash = [100, 160, 220, 280, 340];
  const idx = cal.map((dt, i) => ({ date: dt, close: 10000 * Math.pow(0.97, crash.filter(c => c <= i).length) }));
  fs.writeFileSync(path.join(dir, '^TWII.json'), JSON.stringify(idx));
  fs.writeFileSync(path.join(dir, '_bench0050.json'), JSON.stringify(cal.map(dt => ({ date: dt, open: 100, high: 100, low: 100, close: 100, volume: 1e7 }))));
  fs.writeFileSync(path.join(dir, '_div0050.json'), JSON.stringify({ d: {} }));
  const lim = y0 < 2015 ? 0.068 : 0.095;
  for (let s = 0; s < 60; s++) {
    const sym = String(1101 + s), big = s < 20, sham = s >= 20 && s < 40, rows = [];
    let c = 100;
    for (let i = 0; i < cal.length; i++) {
      let o = c;
      const k = crash.find(x => i >= x && i <= x + 12), j = k == null ? -1 : i - k;
      if (s < 40 && j === 0) c = c * (1 - lim);                                  // 大盤大跌那天跌停
      else if (s < 40 && j === 1) c = c * (big ? 1.05 : 1.01);                    // 隔天:大紅 / 小紅
      else if (j >= 2 && j <= 11) {
        if (mode === 'gap' && big && j === 2) { o = c * 1.04; c = o; }
        else if ((mode === 'edge' && big) || (mode === 'both' && (big || sham))) c = c * 1.01;
      }
      // 特例:第 59 檔第 3 次大跌隔天停牌(少一根);第 58 檔成交金額很小;第 19 檔第 2 次的進場日開盤鎖漲停
      if (s === 19 && k === crash[1] && j === 2) { o = rows[rows.length - 1].close * (1 + (y0 < 2015 ? 0.07 : 0.10)); c = o; rows.push({ date: cal[i], open: o, high: o, low: o, close: c, volume: 5e6 }); continue; }
      if (s === 39 && k === crash[2] && j === 1) continue;
      rows.push({ date: cal[i], open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: s === 38 ? 1e3 : 5e6 });
    }
    fs.writeFileSync(path.join(dir, sym + '.json'), JSON.stringify(rows));
  }
  return { cal, crash };
}

export function selftest() {
  const bad = []; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) bad.push(n); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ldred-'));
  const PP = { from: '2020-01-01', to: '9999-12-31' };
  try {
    // ① 埋效果:大紅的之後每天 +1% → 帳戶贏 0050(0050 不動)、贏全部安慰劑
    const S = synth(path.join(tmp, 'edge'), 'edge');
    const rE = period(path.join(tmp, 'edge'), PP);
    ok('① 埋效果 → 帳戶贏一直放 0050', rE.acct.mult > rE.bench.mult + 0.05, `${rE.acct.mult} vs ${rE.bench.mult}`);
    ok('② 埋效果 → 贏 20 組安慰劑(安慰劑沒埋)', rE.sham.length === 20 && rE.sham.every(x => rE.acct.mult > x), JSON.stringify(rE.sham.slice(-2)));
    // 候選數:5 次大跌 × 20 檔大紅,扣掉第 19 檔第 2 次(進場日開盤鎖漲停)
    ok('③ 訊號數 = 5 次 × 20 檔 − 1(進場日開盤鎖漲停買不到)', rE.nReal === 99, String(rE.nReal));
    ok('④ 安慰劑候選:20 檔小紅 × 5 次,扣掉成交金額太小那檔 5 筆、停牌那 1 筆', rE.nSham === 100 - 5 - 1, String(rE.nSham));
    const first = rE._trades.map(t => t.ed).sort()[0];
    ok('⑤ 進場日 = 大紅 K 的隔天(大跌日 + 2)', first === S.cal[S.crash[0] + 2], `${first} vs ${S.cal[S.crash[0] + 2]}`);
    ok('⑥ 一次最多 10 檔:第一次大跌只買到 10 筆', rE._trades.filter(t => t.ed === first).length === 10, String(rE._trades.filter(t => t.ed === first).length));
    // ② 沒埋:帳戶只輸成本
    synth(path.join(tmp, 'none'), 'none');
    const rN = period(path.join(tmp, 'none'), PP, { lite: 1 });
    ok('⑦ 沒埋效果 → 帳戶輸一直放 0050(只賠成本)', rN.acct.mult < rN.bench.mult && rN.acct.mult > 0.9, String(rN.acct.mult));
    // ③ 決定性對照:安慰劑也一樣漲 → 第 ② 條不過
    synth(path.join(tmp, 'both'), 'both');
    const rB = period(path.join(tmp, 'both'), PP, { lite: 1 });
    const jB = judge(rB, rB);
    ok('⑧ 決定性對照:安慰劑一樣好 → ② 贏安慰劑那條不過、整體不過', !jB.g[2].ok && !jB.pass, jB.g[2].txt);
    const jE = judge(rE, rE);
    ok('⑨ 埋效果那份:① ② ④ ⑤ 都過', jE.g[1].ok && jE.g[2].ok && jE.g[4].ok && jE.g[5].ok, JSON.stringify(Object.values(jE.g).map(x => x.ok)));
    // ④ 偷看:大紅的隔天開盤直接跳空 +4%、之後不動 → 照規矩(隔天開盤買)賺不到
    synth(path.join(tmp, 'gap'), 'gap');
    const rG = period(path.join(tmp, 'gap'), PP, { lite: 1 });
    ok('⑩ 隔天跳空那 4% 買不到 → 帳戶沒有贏 0050(偷看當天收盤價才會贏)', rG.acct.mult <= rG.bench.mult, `${rG.acct.mult} vs ${rG.bench.mult}`);
    // ⑤ 2015-06 以前:跌 6.8% 就是跌停;同樣的資料放到 2020 年不算
    synth(path.join(tmp, 'y08'), 'edge', 2008);
    const r08 = period(path.join(tmp, 'y08'), { from: '2008-01-01', to: '9999-12-31' }, { lite: 1 });
    ok('⑪ 2008 年(漲跌幅 7%):跌 6.8% 算跌停 → 有訊號', r08.nReal > 50, String(r08.nReal));
    // 把 2008 那份的日期整批改成 2020 → 6.8% 不到 −9.2 → 一筆都沒有
    const d20 = path.join(tmp, 'y08as20'); fs.mkdirSync(d20);
    for (const f of fs.readdirSync(path.join(tmp, 'y08'))) {
      const j = JSON.parse(fs.readFileSync(path.join(tmp, 'y08', f), 'utf8'));
      const sh = r => ({ ...r, date: String(+r.date.slice(0, 4) + 12) + r.date.slice(4) });
      fs.writeFileSync(path.join(d20, f), JSON.stringify(Array.isArray(j) ? j.map(sh) : j));
    }
    const r20 = period(d20, PP, { lite: 1 });
    ok('⑫ 決定性對照:同一份改成 2020 年 → 跌 6.8% 不算跌停、0 筆', r20.nReal === 0, String(r20.nReal));
    ok('⑬ 嚴格空頭 / 逐年欄位有值(空頭日進場的筆數 ≥ 0、有進場的年份 ≥ 1)', rE.ys.length >= 1 && Array.isArray(rE.bearTr));
    const m = mktState([{ date: '2020-01-02', close: 100 }, { date: '2020-01-03', close: 97 }]);
    ok('⑭ 加權當天漲跌:100 → 97 = −3%', Math.abs(m.chg[1] + 3) < 1e-9);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ ldred_port selftest 全過'}`);
  return bad.length ? 1 : 0;
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest());
else if (IS_MAIN) main();
