#!/usr/bin/env node
/**
 * 🚨 處置/注意股事件回測(V74.4.2)—— 使用者:「用官方的方式判斷…回測進處置及注意股,
 * 還有這些**前幾天的漲跌**的回測」。
 *
 * 事件來源(⛔ 不是本地 disposition.json —— 那只有 42 筆/1 個月):
 *   ・處置:證交所官網處置查詢(dispo_probe ④,2005 起、只有上市;FinMind 那份付費)→ 事件行 D|sym|公告日|處置起|處置迄|第幾次
 *   ・注意:TWSE rwd/zh/announcement/notice 逐月(⚠️ 只有上市;TPEx 對 runner 403)
 *     → 事件行 N|日期|sym,sym,… 或一個月一行 NM|YYYY-MM|日期=代號,…;…
 *   兩者都由 scripts/dispo_probe.py 在 Actions 印進 job log,本檔從抽出的文字檔讀。
 *
 * 用法:
 *   node scripts/dispo_backtest.mjs <events.txt> [gdataDir]
 *   events.txt = 含 D|/N|/NM| 行的檔;gdataDir 預設 ./data(要有 {sym}.json 與 ^TWII.json)
 *   EV_FROM / EV_TO = 只看這段日期的事件(對照組不受影響,本來就是同一天比)
 *   node scripts/dispo_backtest.mjs --selftest
 *
 * 設計(全部沿用本專案回測鐵則):
 *   ・進場 = 事件日的**隔一個交易日開盤**(公告是收盤後出的;⛔ 用公告日收盤 = 前視)
 *   ・排除隔日開盤仍鎖死(漲跌停一價到底買不到)—— 對照組同一條;2015-06 前漲跌幅是 ±7%(lib_limit,⛔ 寫死 9.7% 會漏掉那五年的鎖死)
 *   ・🚨 V79.4.1 對照組 = **同一個進場日**的全市場平均(⛔ 不是整段平均)。
 *     舊版對照組寫死 2023-06 起,事件拉長到 2005 / 2010 之後 2010~2022 的事件被拿去跟 2023 年以後的平均比
 *     → 那幾年的邊際整段被墊高或壓低(V79.3.9 / V79.4.0 的 2005 / 2010 起數字就是這樣算的,已作廢重算)。
 *     現在每一筆事件的超額 = 自己的報酬 − 同一天進場、同樣抱 N 天的全部股票平均(同一天少於 30 檔就不算)。
 *   ・🧱 V79.4.1 斷崖守門:事件前 5 天到抱滿那天之間,只要有一天收盤(或開盤)跟前一天差超過 ×1.5 / ×0.67
 *     (= 減資 / 停牌後恢復交易 / 資料洞,上市櫃有 ±10% 漲跌停,不可能是真漲跌)→ 那一筆不算;對照組同一條。
 *   ・「進注意」= 該股 10 個交易日內沒出現過注意才算「進」(連續掛注意的後續日不重複計)
 *   ・六關:全期・前後半同向(MID 用實際樣本推,⛔ 不用日期軸)・逐年同向・去最好年・
 *     扣成本 0.44%・勝率(贏加權的比例 vs 同一批日子對照組贏加權的比例)
 *   ・條件分桶 = **事件前 5 個交易日漲跌幅**(使用者指定的「前幾天的漲跌」)
 *   ・K 線逐檔讀完就丟(⛔ 不整包放進記憶體;16 年全市場約 3,000 檔)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { lockedBar } from './lib_limit.mjs';

// 📦 V79.3.9 事件行兩種格式都吃:逐日 N|日期|代號,… / 一個月一行 NM|YYYY-MM|日期=代號,…;日期=…(dispo_probe 預設)
//   ⚠️ GitHub 的 job log 工具只回最後 5,000 行 → 逐日一行 2010 起會被截掉 → 探針改成一個月一行
export function parseEvents(text) {
  const dispo = [], noticeByDay = new Map();
  const add = (d, syms) => noticeByDay.set(d, (noticeByDay.get(d) || []).concat(syms.filter(Boolean)));
  for (const line of String(text || '').split('\n')) {
    const nm = line.match(/NM\|(\d{4}-\d{2})\|(\S*)/);
    if (nm) {
      for (const seg of nm[2].split(';')) {
        const [dt, syms] = seg.split('=');
        if (/^\d{4}-\d{2}-\d{2}$/.test(dt || '')) add(dt, String(syms || '').split(','));
      }
      continue;
    }
    const m = line.match(/D\|(\d{4,6})\|([\d-]+)\|([\d-]*)\|([\d-]*)\|(\d*)/);
    if (m) { dispo.push({ sym: m[1], d: m[2], ps: m[3], pe: m[4], cnt: +m[5] || 1 }); continue; }
    const n = line.match(/N\|([\d-]+)\|([\d,]+)/);
    if (n) add(n[1], n[2].split(','));
  }
  return { dispo, noticeByDay };
}

const iso = s => String(s || '').replace(/\//g, '-').slice(0, 10);
export const COST = 0.44;              // 來回成本 %
export const HOLDS = [5, 10, 20];
export const CLIFF = [0.67, 1.5];      // 同 merge_stock_deep / merge_deep_klines 的斷崖門檻
export const MIN_CTRL = 30;            // 同一天對照組少於這麼多檔 → 那天的事件不算(⛔ 不拿別天的平均湊)
const PRE = 5;                         // 前 5 日漲跌
const GAP_DAYS = 10;                   // 事件日往前找最近一根 K,超過 10 天就當資料洞

// 讀一檔 K 線 → {dates, o, c, h, l, bad 前綴和};讀不到或太短回 null(⛔ 不快取,用完就丟)
export function loadK(dir, sym) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(dir, sym + '.json'), 'utf8')); } catch { return null; }
  if (!Array.isArray(rows) || rows.length <= 60) return null;
  const n0 = rows.length, dates = [], o = new Float64Array(n0), c = new Float64Array(n0), h = new Float64Array(n0), l = new Float64Array(n0);
  let n = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.close) || !Number.isFinite(r.open)) continue;
    dates.push(iso(r.date)); o[n] = r.open; c[n] = r.close; h[n] = r.high; l[n] = r.low; n++;
  }
  // pre[k+1] = 第 0..k 根裡有幾根是「跟前一根之間有斷崖」
  const pre = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    let b = 0;
    if (k > 0 && c[k - 1] > 0) {
      const r1 = c[k] / c[k - 1], r2 = o[k] / c[k - 1];
      if (!(r1 >= CLIFF[0] && r1 <= CLIFF[1]) || !(r2 >= CLIFF[0] && r2 <= CLIFF[1])) b = 1;
    }
    pre[k + 1] = pre[k] + b;
  }
  return { dates, o: o.subarray(0, n), c: c.subarray(0, n), h: h.subarray(0, n), l: l.subarray(0, n), pre, n };
}
// 第 a+1 根到第 b 根之間有沒有斷崖
export const cliffIn = (K, a, b) => K.pre[Math.min(b, K.n - 1) + 1] - K.pre[Math.max(a, -1) + 1] > 0;
// 日期 → 索引(找不到回 -1);lastLE = 最後一根 ≤ d
function lastLE(K, d) {
  let lo = 0, hi = K.n - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (K.dates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
const locked = (K, e) => lockedBar(K.dates[e], K.c[e - 1], K.o[e], K.h[e], K.l[e]) !== 0;   // 2015-06 前是 ±7%(lib_limit)

export function mkIndex(twii) {
  const idx = new Map();
  twii.dates.forEach((d, i) => idx.set(d, i));
  return (d0, d1) => {
    const i0 = idx.get(d0), i1 = idx.get(d1);
    if (i0 == null || i1 == null || !twii.c[i0]) return null;
    return (twii.c[i1] / twii.c[i0] - 1) * 100;
  };
}

// ── 對照組:全部(股·日),依「進場日」累加 —— 每天 [和, 筆數, 贏加權筆數] × 三個天期 ──
export function buildCtrl(dir, syms, mktRet) {
  const by = new Map();
  let nStock = 0, nObs = 0, nCliff = 0, nLock = 0, first = null, last = null;
  for (const sym of syms) {
    const K = loadK(dir, sym);
    if (!K) continue;
    nStock++;
    for (let e = 1; e < K.n; e++) {
      if (!(K.o[e] > 0) || !(K.c[e - 1] > 0)) continue;
      if (locked(K, e)) { nLock++; continue; }
      let a = null;
      for (let t = 0; t < HOLDS.length; t++) {
        const j = e + HOLDS[t];
        if (j >= K.n) break;
        if (cliffIn(K, e - 1 - PRE, j)) { nCliff++; break; }   // 天期是巢狀的:短的有斷崖,長的一定也有
        const mk = mktRet(K.dates[e], K.dates[j]);
        if (mk == null) continue;
        const raw = (K.c[j] / K.o[e] - 1) * 100;
        if (!a) { a = by.get(K.dates[e]); if (!a) { a = new Float64Array(HOLDS.length * 3); by.set(K.dates[e], a); } }
        a[t * 3] += raw; a[t * 3 + 1]++; if (raw > mk) a[t * 3 + 2]++;
        nObs++;
        if (!first || K.dates[e] < first) first = K.dates[e];
        if (!last || K.dates[e] > last) last = K.dates[e];
      }
    }
  }
  return { by, nStock, nObs, nCliff, nLock, first, last };
}

// ── 一筆事件 → 樣本(進場 = 事件日隔一個交易日開盤)。回 {skip} 或 {sym,d,entryDate,pre5,ex,beat,cw,rawx} ──
export function sampleEv(K, ctrl, mktRet, sym, evDate, opts = {}) {
  if (!K) return { skip: 'nok' };
  let i = lastLE(K, evDate);                        // 事件日剛好停牌/沒 K → 用事件日前最近的一根
  if (i < 0) return { skip: 'nok' };
  if ((Date.parse(evDate) - Date.parse(K.dates[i])) / 86400000 > GAP_DAYS) return { skip: 'gap' };   // 那一根離事件日太遠 = 資料洞,進場時點會錯位
  const e = i + 1;
  if (e >= K.n) return { skip: 'end' };
  if (!(K.o[e] > 0)) return { skip: 'nok' };
  // 開盤鎖死:鎖漲停一定買不到;鎖跌停其實買得到(賣的人排隊)→ opts.allowDownLock 時只擋鎖漲停(retail_inst_probe 融資斷頭用)
  { const lk = lockedBar(K.dates[e], K.c[e - 1], K.o[e], K.h[e], K.l[e]); if (lk === 1 || (lk === -1 && !opts.allowDownLock)) return { skip: 'lock' }; }
  if (cliffIn(K, i - PRE, e)) return { skip: 'cliff' };   // 前 5 天到進場那天就有斷崖 → 前 5 日漲跌是假的
  const pre5 = i >= PRE ? (K.c[i] / K.c[i - PRE] - 1) * 100 : null;
  const out = { sym, d: evDate, entryDate: K.dates[e], pre5, ex: {}, beat: {}, cw: {}, rawx: {} };
  const a = ctrl.by.get(K.dates[e]);
  let any = false, why = 'end';
  for (let t = 0; t < HOLDS.length; t++) {
    const n = HOLDS[t], j = e + n;
    out.ex[n] = null;
    if (j >= K.n) { why = 'end'; continue; }
    if (cliffIn(K, i - PRE, j)) { why = 'cliff'; continue; }
    if (!a || a[t * 3 + 1] < MIN_CTRL) { why = 'ctrl'; continue; }
    const mk = mktRet(K.dates[e], K.dates[j]);
    if (mk == null) { why = 'mkt'; continue; }
    const raw = (K.c[j] / K.o[e] - 1) * 100;
    out.ex[n] = raw - a[t * 3] / a[t * 3 + 1];
    out.rawx[n] = raw - mk;
    out.beat[n] = raw > mk ? 1 : 0;
    out.cw[n] = a[t * 3 + 2] / a[t * 3 + 1];
    any = true;
  }
  return any ? out : { skip: why };
}

const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const f1 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);

export function summarize(rows) {
  const r20 = rows.filter(r => r.ex[20] != null);
  if (r20.length < 30) return { n: r20.length, thin: true };
  const ex = n => rows.map(r => r.ex[n]).filter(v => v != null);
  const ds = r20.map(r => r.d).sort();
  const mid = ds[Math.floor(ds.length / 2)];
  const h1 = avg(r20.filter(r => r.d < mid).map(r => r.ex[20])), h2 = avg(r20.filter(r => r.d >= mid).map(r => r.ex[20]));
  const yrs = {};
  for (const r of r20) (yrs[r.d.slice(0, 4)] = yrs[r.d.slice(0, 4)] || []).push(r.ex[20]);
  const years = Object.entries(yrs).filter(([, a]) => a.length >= 15).map(([y, a]) => [y, avg(a), a.length]).sort((x, y) => x[0] < y[0] ? -1 : 1);
  let exBest = null;
  if (years.length >= 2) {
    const bestY = years.slice().sort((x, y) => y[1] - x[1])[0][0];
    exBest = avg(r20.filter(r => r.d.slice(0, 4) !== bestY).map(r => r.ex[20]));
  }
  const e20 = avg(ex(20));
  return {
    n: r20.length, e5: avg(ex(5)), e10: avg(ex(10)), e20, med: med(r20.map(r => r.ex[20])), medRaw: med(r20.map(r => r.rawx[20])),
    win: avg(r20.map(r => r.beat[20])) * 100, cwin: avg(r20.map(r => r.cw[20])) * 100,
    h1, h2, years, posYears: years.filter(y => y[1] > 0).length, exBest, cost: e20 - COST,
  };
}

function report(name, rows) {
  const s = summarize(rows);
  if (s.thin) { console.log(`  ${name}: n=${s.n} ⏳ 樣本不足`); return s; }
  console.log(`  ${name}: n=${s.n}`);
  console.log(`    5/10/20日超額 ${f1(s.e5)}/${f1(s.e10)}/${f1(s.e20)}pp(扣同一天全市場平均)・中位 ${f1(s.med)}%(扣加權 ${f1(s.medRaw)}%)・贏加權 ${s.win.toFixed(1)}%(同一批日子對照 ${s.cwin.toFixed(1)}%)`);
  console.log(`    前後半 ${f1(s.h1)}/${f1(s.h2)}${s.h1 * s.h2 > 0 ? ' ✅同向' : ' ❌不同向'}` +
    ` ・逐年(${s.posYears}/${s.years.length} 年正)${s.years.map(([y, v]) => `${y}:${f1(v)}`).join(' ')}` +
    ` ・去最好年 ${f1(s.exBest)} ・扣成本 ${f1(s.cost)}pp`);
  return s;
}

// ── 事件依股票分組,一檔讀一次 K 線 ──
export function collect(dir, ctrl, mktRet, ev) {
  const bySym = new Map();
  const put = (sym, k, x) => { if (!bySym.has(sym)) bySym.set(sym, { notice: [], dispo: [] }); bySym.get(sym)[k].push(x); };
  for (const [d, syms] of ev.noticeByDay) for (const s of syms) put(s, 'notice', d);
  for (const x of ev.dispo) put(x.sym, 'dispo', x);
  const out = { dEv: [], outEv: [], nEv: [], skip: {} };
  const sk = w => { out.skip[w] = (out.skip[w] || 0) + 1; };
  for (const [sym, g] of bySym) {
    const K = loadK(dir, sym);
    if (!K) { sk('nok'); continue; }
    // ① 進處置(以公告日為事件日;同一檔 10 個交易日內的重複公告只算一次)
    let lastI = null;
    for (const ev of g.dispo.slice().sort((a, b) => a.d < b.d ? -1 : 1)) {
      const s = sampleEv(K, ctrl, mktRet, sym, ev.d);
      if (s.skip) { sk(s.skip); continue; }
      const i = lastLE(K, ev.d);
      if (lastI != null && i - lastI < 10) continue;
      lastI = i;
      s.cnt = ev.cnt; s.pe = ev.pe;
      out.dEv.push(s);
    }
    // ①b 出關(處置迄日 → 隔日開盤)
    for (const ev of g.dispo) {
      if (!ev.pe) continue;
      const s = sampleEv(K, ctrl, mktRet, sym, ev.pe);
      if (!s.skip) out.outEv.push(s);
    }
    // ② 進注意(10 個交易日內沒掛過注意才算「進」;連續掛的後續日只往後推)
    let lastN = null;
    for (const d of g.notice.slice().sort()) {
      const i = lastLE(K, d);
      if (i < 0) continue;
      if (lastN != null && i - lastN < 10) { lastN = i; continue; }
      lastN = i;
      const s = sampleEv(K, ctrl, mktRet, sym, d);
      if (s.skip) { sk(s.skip); continue; }
      out.nEv.push(s);
    }
  }
  return out;
}

function main() {
  const EV_FILE = process.argv[2] || '';
  const GDATA = process.argv[3] || 'data';
  if (!EV_FILE || !fs.existsSync(EV_FILE)) { console.error('用法:node scripts/dispo_backtest.mjs <events.txt> [gdataDir] ・node scripts/dispo_backtest.mjs --selftest'); process.exit(1); }
  const EV_FROM = process.env.EV_FROM || '', EV_TO = process.env.EV_TO || '';
  const ev = parseEvents(fs.readFileSync(EV_FILE, 'utf8'));
  if (EV_FROM || EV_TO) {
    const inR = d => (!EV_FROM || d >= EV_FROM) && (!EV_TO || d <= EV_TO);
    ev.dispo = ev.dispo.filter(x => inR(x.d));
    for (const d of [...ev.noticeByDay.keys()]) if (!inR(d)) ev.noticeByDay.delete(d);
  }
  console.log(`事件檔:處置 ${ev.dispo.length} 筆 ・注意日 ${ev.noticeByDay.size} 天${EV_FROM || EV_TO ? `(只看 ${EV_FROM || '…'} ~ ${EV_TO || '…'})` : ''}`);
  const twii = loadK(GDATA, '^TWII');
  if (!twii) { console.error('❌ 讀不到 ^TWII.json'); process.exit(1); }
  const mktRet = mkIndex(twii);
  const syms = fs.readdirSync(GDATA).filter(f => /^\d{4,6}\.json$/.test(f)).map(f => f.slice(0, -5));
  console.log(`K 線檔:${syms.length} 個`);
  const ctrl = buildCtrl(GDATA, syms, mktRet);
  console.log(`對照組:${ctrl.nStock} 檔 ・(股·日)${ctrl.nObs.toLocaleString()} 筆 ・進場日 ${ctrl.first} ~ ${ctrl.last} ・斷崖剔除 ${ctrl.nCliff.toLocaleString()} ・鎖死剔除 ${ctrl.nLock.toLocaleString()}`);
  if (ctrl.nObs < 10000) { console.error('❌ 對照組不到 1 萬筆 → 資料夾可能不完整'); process.exit(1); }
  const r = collect(GDATA, ctrl, mktRet, ev);
  console.log(`略過的事件:${JSON.stringify(r.skip)}(cliff = 窗口裡有減資 / 停牌斷崖、lock = 隔天開盤鎖死買不到、ctrl = 那天對照組不到 ${MIN_CTRL} 檔、gap = 事件日前 ${GAP_DAYS} 天內沒有 K 線、nok = 沒有那一檔或事件比 K 線還早)`);

  console.log(`\n═══ ① 進處置(公告日隔天開盤進場,10 日去重)═══`);
  report('全部進處置', r.dEv);
  report('第一次處置(cnt=1)', r.dEv.filter(x => x.cnt === 1));
  report('慣犯(cnt≥2)', r.dEv.filter(x => x.cnt >= 2));
  console.log('  — 依「前 5 日漲跌」分桶(使用者要的條件)—');
  report('前5日 <0%(跌著進處置)', r.dEv.filter(x => x.pre5 != null && x.pre5 < 0));
  report('前5日 0~15%', r.dEv.filter(x => x.pre5 != null && x.pre5 >= 0 && x.pre5 < 15));
  report('前5日 15~30%', r.dEv.filter(x => x.pre5 != null && x.pre5 >= 15 && x.pre5 < 30));
  report('前5日 ≥30%(噴著進處置)', r.dEv.filter(x => x.pre5 != null && x.pre5 >= 30));
  console.log(`\n═══ ①b 出關後(處置最後一天的隔日開盤進場)═══`);
  report('全部出關', r.outEv);
  if (ev.noticeByDay.size) {
    console.log(`\n═══ ② 進注意股(第一次掛注意的隔日開盤進場,10 日去重)═══`);
    report('全部進注意', r.nEv);
    console.log('  — 依「前 5 日漲跌」分桶 —');
    report('前5日 <0%', r.nEv.filter(x => x.pre5 != null && x.pre5 < 0));
    report('前5日 0~15%', r.nEv.filter(x => x.pre5 != null && x.pre5 >= 0 && x.pre5 < 15));
    report('前5日 15~30%', r.nEv.filter(x => x.pre5 != null && x.pre5 >= 15 && x.pre5 < 30));
    report('前5日 ≥30%', r.nEv.filter(x => x.pre5 != null && x.pre5 >= 30));
  } else {
    console.log('\n⏳ 注意股事件 0 筆');
  }
  console.log('\n⚠️ 限制:進場=隔日開盤但處置股是 5/20 分盤撮合、流動性差,實際滑價會更糟;' +
    '\n   注意股與處置名單只有上市(TPEx 對 runner 403);下市股要資料夾本身有(d16 有、data/ 沒有)。');
}

// ═══ selftest ═══
function selftest() {
  const bad = [];
  const ok = (name, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${name}${!c ? ' ・' + String(x).slice(0, 200) : ''}`); if (!c) bad.push(name); };
  const a = parseEvents('2026-10-20T01:00:00Z N|2024-03-01|1101\nN|2024-03-05|2330,2317\nD|2330|2024-03-08|2024-03-11|2024-03-22|1');
  const b = parseEvents('2026-10-20T01:00:00Z NM|2024-03|2024-03-01=1101;2024-03-05=2330,2317\nD|2330|2024-03-08|2024-03-11|2024-03-22|1');
  ok('⓪ 逐日 N| 與一個月一行 NM| 讀出來一模一樣', JSON.stringify([...a.noticeByDay]) === JSON.stringify([...b.noticeByDay]) && a.dispo.length === 1 && b.dispo.length === 1);
  ok('⓪ 處置打包行 PM| ⛔ 不可被當成注意股', parseEvents('PM|2024-03|2330,2024-03-08,2024-03-11,2024-03-22,1,1').noticeByDay.size === 0);

  // 合成資料:2012~2023 兩段行情 —— 前段每檔每天 +0.3%、後段 −0.1%(全部股票一樣)→ 同一天的平均就是那個漂移
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispo-'));
  try {
    const days = [];
    for (let t = Date.UTC(2012, 0, 2); t <= Date.UTC(2023, 11, 29); t += 86400000) {
      const dd = new Date(t); if (dd.getUTCDay() % 6 !== 0) days.push(dd.toISOString().slice(0, 10));
    }
    const split = '2017-01-01';
    const drift = d => d < split ? 0.003 : -0.001;
    const mkRows = (bump = () => 0, mut = null) => {
      let p = 50; const rows = [];
      for (let k = 0; k < days.length; k++) {
        const d = days[k];
        p = p * (1 + drift(d) + bump(k));
        const r = { date: d.replace(/-/g, '/'), open: +p.toFixed(4), high: +(p * 1.01).toFixed(4), low: +(p * 0.99).toFixed(4), close: +p.toFixed(4), volume: 1000 };
        rows.push(r);
      }
      if (mut) mut(rows);
      return rows;
    };
    fs.writeFileSync(path.join(tmp, '^TWII.json'), JSON.stringify(days.map(d => ({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 0 }))));
    for (let s = 0; s < 60; s++) fs.writeFileSync(path.join(tmp, `${1100 + s}.json`), JSON.stringify(mkRows()));
    // 2000:後段某一天之後 20 天每天多 +0.25%(真的有優勢,約 +5%)
    const kE = days.indexOf('2020-03-02');
    fs.writeFileSync(path.join(tmp, '2000.json'), JSON.stringify(mkRows(k => (k > kE && k <= kE + 21 ? 0.0025 : 0))));
    // 3000:事件後第 8 天減資恢復交易 ×1.6(斷崖)→ 那一筆要被剔除
    const kC = days.indexOf('2014-06-02');
    fs.writeFileSync(path.join(tmp, '3000.json'), JSON.stringify(mkRows(() => 0, rows => { for (let k = kC + 9; k < rows.length; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] = +(rows[k][f] * 1.6).toFixed(4); })));
    // 4000:隔天開盤鎖漲停(一價到底)→ 買不到,剔除
    const kL = days.indexOf('2015-03-02');
    fs.writeFileSync(path.join(tmp, '4000.json'), JSON.stringify(mkRows(() => 0, rows => { const r = rows[kL + 1], p = rows[kL].close * 1.1; for (let k = kL + 1; k < rows.length; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] = +(rows[k][f] * 1.097).toFixed(4); r.open = r.high = r.low = r.close = +p.toFixed(4); })));
    const twii = loadK(tmp, '^TWII'), mktRet = mkIndex(twii);
    const syms = fs.readdirSync(tmp).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, -5));
    const ctrl = buildCtrl(tmp, syms, mktRet);
    // 前段 40 筆事件(跟大家一模一樣,沒有優勢)
    const evA = new Map();
    for (let q = 0; q < 40; q++) { const d = days[30 + q * 25]; evA.set(d, [String(1100 + q % 60)]); }
    const rA = collect(tmp, ctrl, mktRet, { dispo: [], noticeByDay: evA });
    const sA = summarize(rA.nEv);
    ok('① 前段事件跟同一天的大家一模一樣 → 超額 ≈ 0(同一天比)', !sA.thin && Math.abs(sA.e20) < 0.05, JSON.stringify(sA).slice(0, 160));
    // 決定性對照:舊算法(整段對照組平均)會憑空量到一大截優勢
    let gs = 0, gn = 0;
    for (const v of ctrl.by.values()) { gs += v[6]; gn += v[7]; }
    const oldEdge = avg(rA.nEv.map(r => r.ex[20] + ctrl.by.get(r.entryDate)[6] / ctrl.by.get(r.entryDate)[7])) - gs / gn;
    ok('① 決定性對照:同一批事件改用整段對照組平均 → 憑空 > +2pp(舊版 2010 起那幾個數字就是這樣歪的)', oldEdge > 2, oldEdge);
    // 真的有優勢 → 量得到(後段、30 筆都是 2000 那一天)
    const evB = new Map([['2020-03-02', ['2000']]]);
    const rB = collect(tmp, ctrl, mktRet, { dispo: [], noticeByDay: evB });
    ok('② 真的多賺約 5% → 量到 +4.5~+5.5pp', rB.nEv.length === 1 && rB.nEv[0].ex[20] > 4.5 && rB.nEv[0].ex[20] < 5.5, rB.nEv[0] && rB.nEv[0].ex[20]);
    // 斷崖 / 鎖死剔除
    const rC = collect(tmp, ctrl, mktRet, { dispo: [], noticeByDay: new Map([['2014-06-02', ['3000']], ['2015-03-02', ['4000']]]) });
    ok('③ 抱的期間碰到減資斷崖 → 20 天那格不算(5 天那格照算)', rC.nEv.some(r => r.sym === '3000' && r.ex[20] == null && r.ex[5] != null), JSON.stringify(rC.nEv.map(r => [r.sym, r.ex])));
    ok('③ 隔天開盤鎖死 → 整筆不算', !rC.nEv.some(r => r.sym === '4000') && rC.skip.lock === 1, JSON.stringify(rC.skip));
    ok('③ 對照組也剔除斷崖窗口(⛔ 只剔事件不剔對照 = 兩邊不同規則)', ctrl.nCliff > 0 && ctrl.nLock > 0, `${ctrl.nCliff}/${ctrl.nLock}`);
    // 同一天對照組太少 → 不算(⛔ 拿別天湊)
    const one = new Map([[days[40], ['1100']]]);
    const thinCtrl = { by: new Map([[days[41], (() => { const x = new Float64Array(9); x[1] = x[4] = x[7] = 5; return x; })()]]) };
    const rD = collect(tmp, thinCtrl, mktRet, { dispo: [], noticeByDay: one });
    ok('④ 那一天對照組不到 30 檔 → 整筆不算(原因 ctrl)', rD.nEv.length === 0 && rD.skip.ctrl === 1, JSON.stringify(rD.skip));
    // 2012 年(漲跌幅 ±7%)隔天開盤一價到底鎖漲停 +7% → 買不到,不算(⛔ 寫死 9.7% 會當成買得到)
    const kL7 = days.indexOf('2012-03-01');
    fs.writeFileSync(path.join(tmp, '4100.json'), JSON.stringify(mkRows(() => 0, rows => { const p = rows[kL7].close * 1.07; for (let k = kL7 + 1; k < rows.length; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] = +(rows[k][f] * 1.07).toFixed(4); const r = rows[kL7 + 1]; r.open = r.high = r.low = r.close = +p.toFixed(4); })));
    const rL7 = collect(tmp, ctrl, mktRet, { dispo: [], noticeByDay: new Map([['2012-03-01', ['4100']]]) });
    ok('③ 2012 年隔天開盤鎖 +7%(那時漲跌幅 ±7%)→ 買不到、整筆不算', rL7.nEv.length === 0 && rL7.skip.lock === 1, JSON.stringify(rL7.skip));
    // 事件日前 10 天內沒有 K(資料洞)→ 不算
    const rG = collect(tmp, ctrl, mktRet, { dispo: [], noticeByDay: new Map([['2026-01-05', ['1106']]]) });
    ok('④ 事件日離最後一根 K 太遠(資料洞)→ 不算(原因 gap)', rG.nEv.length === 0 && rG.skip.gap === 1, JSON.stringify(rG.skip));
    // 10 日去重
    const rE = collect(tmp, ctrl, mktRet, { dispo: [], noticeByDay: new Map([[days[100], ['1105']], [days[103], ['1105']], [days[140], ['1105']]]) });
    ok('⑤ 10 個交易日內連續掛注意只算第一次', rE.nEv.length === 2, rE.nEv.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ selftest 全過'}`);
  return bad.length ? 1 : 0;
}

// ⚠️ 只有「直接執行這支」才跑 selftest / main —— 別的探針 import 這支(retail_inst_probe)時帶著自己的 --selftest,
//   ⛔ 不可在 import 的當下跑掉這支的 selftest 然後 process.exit
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest());
else if (IS_MAIN) main();
