#!/usr/bin/env node
/**
 * 🚨 處置/注意股事件回測(V74.4.2)—— 使用者:「用官方的方式判斷…回測進處置及注意股,
 * 還有這些**前幾天的漲跌**的回測」。
 *
 * 事件來源(⛔ 不是本地 disposition.json —— 那只有 42 筆/1 個月):
 *   ・處置:FinMind TaiwanStockDispositionSecuritiesPeriod(dispo_probe 實測 2,272 列,
 *     回溯 2023-06,上市+上櫃都有)→ 事件行 D|sym|公告日|處置起|處置迄|第幾次
 *   ・注意:TWSE rwd/zh/announcement/notice 逐月(⚠️ 只有上市;TPEx 對 runner 403)
 *     → 事件行 N|日期|sym,sym,…
 *   兩者都由 scripts/dispo_probe.py 在 Actions 印進 job log,本檔從抽出的文字檔讀。
 *
 * 用法:
 *   node scripts/dispo_backtest.mjs <events.txt> [gdataDir]
 *   events.txt = 含 D|/N| 行的檔;gdataDir 預設 ./data(要有 {sym}.json 與 ^TWII.json)
 *
 * 設計(全部沿用本專案回測鐵則):
 *   ・進場 = 事件日的**隔一個交易日開盤**(公告是收盤後出的;⛔ 用公告日收盤 = 前視)
 *   ・排除隔日開盤仍鎖死(漲跌停一價到底買不到)
 *   ・報酬扣同期加權(^TWII);對照組 = 全市場所有(股·日)(⛔ 不抽樣)
 *   ・「進注意」= 該股 10 個交易日內沒出現過注意才算「進」(連續掛注意的後續日不重複計)
 *   ・六關:全期・前後半同向(MID 用實際樣本推,⛔ 不用日期軸)・逐年同向・去最好年・
 *     扣成本 0.44%・勝率
 *   ・條件分桶 = **事件前 5 個交易日漲跌幅**(使用者指定的「前幾天的漲跌」)
 */
import fs from 'fs';
import path from 'path';

const EV_FILE = process.argv[2] || '';
const GDATA = process.argv[3] || 'data';
if (!EV_FILE || !fs.existsSync(EV_FILE)) { console.error('用法:node scripts/dispo_backtest.mjs <events.txt> [gdataDir]'); process.exit(1); }

const iso = s => String(s || '').replace(/\//g, '-');
const COST = 0.44;                   // 來回成本 %
const HOLDS = [5, 10, 20];

// ── 讀事件 ──
const dispo = [];                    // {sym, d(公告), ps, pe, cnt}
const noticeByDay = new Map();       // date -> [sym]
for (const line of fs.readFileSync(EV_FILE, 'utf8').split('\n')) {
  const m = line.match(/D\|(\d{4,6})\|([\d-]+)\|([\d-]*)\|([\d-]*)\|(\d*)/);
  if (m) { dispo.push({ sym: m[1], d: m[2], ps: m[3], pe: m[4], cnt: +m[5] || 1 }); continue; }
  const n = line.match(/N\|([\d-]+)\|([\d,]+)/);
  if (n) noticeByDay.set(n[1], (noticeByDay.get(n[1]) || []).concat(n[2].split(',').filter(Boolean)));
}
console.log(`事件檔:處置 ${dispo.length} 筆 ・注意日 ${noticeByDay.size} 天`);

// ── 讀 K 線(只讀被事件點名的股票 + 對照組抽全市場)──
const kl = new Map();                // sym -> {dates[], idx{date->i}, o[], c[], h[], l[]}
function load(sym) {
  if (kl.has(sym)) return kl.get(sym);
  let out = null;
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(GDATA, sym + '.json'), 'utf8'));
    if (Array.isArray(rows) && rows.length > 60) {
      const dates = [], o = [], c = [], h = [], l = [];
      for (const r of rows) {
        if (!Number.isFinite(r.close) || !Number.isFinite(r.open)) continue;
        dates.push(iso(r.date)); o.push(r.open); c.push(r.close); h.push(r.high); l.push(r.low);
      }
      const idx = {}; dates.forEach((d, i) => idx[d] = i);
      out = { dates, idx, o, c, h, l };
    }
  } catch { }
  kl.set(sym, out);
  return out;
}
const twii = load('^TWII');
if (!twii) { console.error('❌ 讀不到 ^TWII.json'); process.exit(1); }

// 大盤日期軸上「某日之後第 n 個交易日」用個股自己的索引,大盤對齊用日期查
function mktRet(d0, d1) {
  const i0 = twii.idx[d0], i1 = twii.idx[d1];
  if (i0 == null || i1 == null || !twii.c[i0]) return null;
  return (twii.c[i1] / twii.c[i0] - 1) * 100;
}

// ── 事件 → 樣本(進場 = 事件日隔一個交易日開盤)──
function sample(sym, evDate) {
  const K = load(sym);
  if (!K) return null;
  let i = K.idx[evDate];
  if (i == null) {   // 事件日剛好停牌/沒 K → 找事件日前最近的一根
    i = K.dates.findLastIndex(d => d <= evDate);
    if (i < 0) return null;
  }
  const e = i + 1;                                  // 進場根(隔日)
  if (e >= K.dates.length) return null;
  // 排除進場開盤仍鎖死(一價到底買不到):開=高=低 且 跳空 ≥9.7%
  const gapPct = (K.o[e] / K.c[i] - 1) * 100;
  if (Math.abs(gapPct) >= 9.7 && K.h[e] === K.l[e]) return null;
  if (!(K.o[e] > 0)) return null;
  // 前 5 個交易日漲跌(事件日收盤 vs 5 根前收盤)—— 使用者要的條件
  const pre5 = i >= 5 ? (K.c[i] / K.c[i - 5] - 1) * 100 : null;
  const out = { sym, d: evDate, entryDate: K.dates[e], pre5, ret: {} };
  for (const n of HOLDS) {
    const j = e + n;
    if (j >= K.dates.length) { out.ret[n] = null; continue; }
    const raw = (K.c[j] / K.o[e] - 1) * 100;
    const mk = mktRet(K.dates[e], K.dates[j]);
    out.ret[n] = mk == null ? null : raw - mk;
  }
  return out;
}

// ── 對照組:全市場所有(股·日),同一窗口、同樣扣大盤(⛔ 不抽樣)──
function buildControl(files) {
  const acc = { 5: [], 10: [], 20: [] };
  let nStock = 0;
  for (const f of files) {
    const sym = path.basename(f, '.json');
    if (sym.startsWith('^')) continue;
    const K = load(sym);
    if (!K) continue;
    nStock++;
    for (let e = 1; e < K.dates.length - 20; e += 3) {   // 每 3 根取 1(對照組容許系統性抽樣,量夠大)
      if (K.dates[e] < FROM) continue;
      if (!(K.o[e] > 0)) continue;
      for (const n of HOLDS) {
        const j = e + n;
        if (j >= K.dates.length) continue;
        const mk = mktRet(K.dates[e], K.dates[j]);
        if (mk == null) continue;
        acc[n].push((K.c[j] / K.o[e] - 1) * 100 - mk);
      }
    }
  }
  console.log(`對照組:${nStock} 檔 ・20日樣本 ${acc[20].length.toLocaleString()} 筆`);
  return acc;
}

const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const wr = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : null;
const f1 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);

// ── 六關報表 ──
function report(name, rows, ctrl) {
  const r20 = rows.map(r => r.ret[20]).filter(v => v != null);
  if (r20.length < 30) { console.log(`  ${name}: n=${r20.length} ⏳ 樣本不足`); return; }
  const base = avg(ctrl[20]);
  const edge = avg(r20) - base;
  // 前後半:MID 用實際樣本日期推(⛔ 不用日期軸 —— limitup_probe 的教訓)
  const ds = rows.filter(r => r.ret[20] != null).map(r => r.d).sort();
  const mid = ds[Math.floor(ds.length / 2)];
  const h1 = rows.filter(r => r.ret[20] != null && r.d < mid).map(r => r.ret[20]);
  const h2 = rows.filter(r => r.ret[20] != null && r.d >= mid).map(r => r.ret[20]);
  // 逐年
  const yrs = {};
  for (const r of rows) if (r.ret[20] != null) (yrs[r.d.slice(0, 4)] = yrs[r.d.slice(0, 4)] || []).push(r.ret[20]);
  const yEdge = Object.entries(yrs).filter(([, a]) => a.length >= 15)
    .map(([y, a]) => [y, avg(a) - base]);
  // 去最好年
  let exBest = null;
  if (yEdge.length >= 2) {
    const bestY = yEdge.slice().sort((a, b) => b[1] - a[1])[0][0];
    const rest = rows.filter(r => r.ret[20] != null && r.d.slice(0, 4) !== bestY).map(r => r.ret[20]);
    exBest = avg(rest) - base;
  }
  const e5 = avg(rows.map(r => r.ret[5]).filter(v => v != null)) - avg(ctrl[5]);
  const e10 = avg(rows.map(r => r.ret[10]).filter(v => v != null)) - avg(ctrl[10]);
  console.log(`  ${name}: n=${r20.length}`);
  console.log(`    5/10/20日邊際 ${f1(e5)}/${f1(e10)}/${f1(edge)}pp ・中位 ${f1(med(r20))}% ・勝率 ${wr(r20).toFixed(1)}%(對照 ${wr(ctrl[20]).toFixed(1)}%)`);
  console.log(`    前後半 ${f1(avg(h1) - base)}/${f1(avg(h2) - base)}${(avg(h1) - base) * (avg(h2) - base) > 0 ? ' ✅同向' : ' ❌不同向'}` +
    ` ・逐年 ${yEdge.map(([y, v]) => `${y}:${f1(v)}`).join(' ')}` +
    ` ・去最好年 ${f1(exBest)} ・扣成本 ${f1(edge - COST)}pp`);
}

// ═══ 主流程 ═══
const FROM = '2023-06-01';
const files = fs.readdirSync(GDATA).filter(f => /^\d{4,6}\.json$/.test(f)).map(f => path.join(GDATA, f));
console.log(`K 線檔:${files.length} 個`);

// ① 處置事件(以「公告日」為事件日;進場 = 處置第一天開盤)
const dEv = [];
{
  const lastBySym = {};                             // 同一檔 10 個交易日內的重複公告只算一次
  for (const ev of dispo.sort((a, b) => a.d < b.d ? -1 : 1)) {
    const s = sample(ev.sym, ev.d);
    if (!s) continue;
    const K = load(ev.sym);
    const i = K.idx[s.d] ?? K.dates.findLastIndex(x => x <= s.d);
    if (lastBySym[ev.sym] != null && i - lastBySym[ev.sym] < 10) continue;
    lastBySym[ev.sym] = i;
    s.cnt = ev.cnt; s.pe = ev.pe;
    dEv.push(s);
  }
}
console.log(`\n═══ ① 進處置(公告日隔天開盤進場,10 日去重)═══`);
const ctrl = buildControl(files);
console.log(`  (對照組 20 日:平均 ${f1(avg(ctrl[20]))}% ・中位 ${f1(med(ctrl[20]))}% ・勝率 ${wr(ctrl[20]).toFixed(1)}%)`);
report('全部進處置', dEv, ctrl);
report('第一次處置(cnt=1)', dEv.filter(r => r.cnt === 1), ctrl);
report('慣犯(cnt≥2)', dEv.filter(r => r.cnt >= 2), ctrl);
console.log('  — 依「前 5 日漲跌」分桶(使用者要的條件)—');
report('前5日 <0%(跌著進處置)', dEv.filter(r => r.pre5 != null && r.pre5 < 0), ctrl);
report('前5日 0~15%', dEv.filter(r => r.pre5 != null && r.pre5 >= 0 && r.pre5 < 15), ctrl);
report('前5日 15~30%', dEv.filter(r => r.pre5 != null && r.pre5 >= 15 && r.pre5 < 30), ctrl);
report('前5日 ≥30%(噴著進處置)', dEv.filter(r => r.pre5 != null && r.pre5 >= 30), ctrl);

// ①b 出關(處置迄日收盤 → 之後 5/10/20 日)
const outEv = [];
for (const ev of dispo) {
  if (!ev.pe) continue;
  const s = sample(ev.sym, ev.pe);
  if (s) outEv.push(s);
}
console.log(`\n═══ ①b 出關後(處置最後一天的隔日開盤進場)═══`);
report('全部出關', outEv, ctrl);

// ② 進注意(10 個交易日內沒掛過注意才算「進」)
if (noticeByDay.size) {
  const nEv = [];
  const lastBySym = {};
  const days = [...noticeByDay.keys()].sort();
  for (const d of days) {
    for (const sym of noticeByDay.get(d)) {
      const K = load(sym);
      if (!K) continue;
      const i = K.idx[d] ?? K.dates.findLastIndex(x => x <= d);
      if (i < 0) continue;
      if (lastBySym[sym] != null && i - lastBySym[sym] < 10) { lastBySym[sym] = i; continue; }
      lastBySym[sym] = i;
      const s = sample(sym, d);
      if (s) nEv.push(s);
    }
  }
  console.log(`\n═══ ② 進注意股(第一次掛注意的隔日開盤進場,10 日去重)═══`);
  report('全部進注意', nEv, ctrl);
  console.log('  — 依「前 5 日漲跌」分桶 —');
  report('前5日 <0%', nEv.filter(r => r.pre5 != null && r.pre5 < 0), ctrl);
  report('前5日 0~15%', nEv.filter(r => r.pre5 != null && r.pre5 >= 0 && r.pre5 < 15), ctrl);
  report('前5日 15~30%', nEv.filter(r => r.pre5 != null && r.pre5 >= 15 && r.pre5 < 30), ctrl);
  report('前5日 ≥30%', nEv.filter(r => r.pre5 != null && r.pre5 >= 30), ctrl);
} else {
  console.log('\n⏳ 注意股事件 0 筆(等 dispo_probe V2 的 N| dump)');
}
console.log('\n⚠️ 限制:進場=隔日開盤但處置股是 5/20 分盤撮合、流動性差,實際滑價會更糟;' +
  '\n   注意股只有上市(TPEx 對 runner 403);窗口 2023-06 起、整段偏多頭;倖存者偏誤(下市股不在 data/)。');
