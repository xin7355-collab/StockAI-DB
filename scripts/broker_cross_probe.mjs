#!/usr/bin/env node
/**
 * 🧬 分點 × K線 / 籌碼 / 基本面 —— 交叉條件回測(只讀,⛔ 不打 API、⛔ 不寫 App)
 *
 * ❓ 使用者(2026-08-31):「分點絕對沒有你說的這麼沒有用…你有結合K線技術面籌碼面
 *    基本面去做一個分析嗎?不要隨便回答我我會來驗證。」
 *    → 他的方法論質疑**成立**:前兩支探針測的是分點**單獨**的效果,
 *      「單獨沒用」不等於「配上條件也沒用」(V73.7.4 做夢行情就是配條件才過關)。
 *
 * ⭐⭐ 方法核心:**每一組的對照組都共用「非分點」的那條腿。**
 *    例:測「低位階 × 分點大買」時,對照組是「低位階 × 沒有大買」——
 *    ⛔ 拿全市場當對照的話,量到的是位階的效果,不是分點的效果。
 *
 * 🔬 九組交叉:
 *    A. 大漲日 × 隔日沖券商佔比(技術×分點)—— 漲的那天是誰在買?隔日沖買的隔天弱?
 *    B. 位階 × 分點大買(關鍵分點「低檔大買」的正面檢驗)
 *    C. 連買 ≥3 天 × 還沒發動(隱形吃貨)vs 已經噴了
 *    D. 分點大買 × 外資/投信同買(籌碼面)
 *    E. 創 60 日新高 × 分點集中(技術面)
 *    F. 分點大買 × 基本面(最近一季 EPS>0 / EPS YoY>0,⛔ 只用事件當時已公布的)
 *    G. 🧬 高位階+高波動 × 分點大買(疊在現行配置上的增量)
 *    H. 訓練段高技巧券商 × 位階(好券商低檔買?)
 *    I. 關鍵分點:累積成本在區間低檔的券商今天又大買(⭐ 用累積成本,⛔ 不用單日均價 ——
 *       單日均價 ≈ 當天股價,跟位階是同一件事,量不到「買得低」)
 *
 * ⛔ 沿用的鐵則:進場=隔天開盤・排除開盤鎖死・扣同期加權・(券商,股票) 10 日去重・
 *    成本 0.44% 對照・前後半同向(全窗口的組)・訓練段學/驗收段考(用到券商屬性的組)。
 *
 * 用法:
 *    CHIPS_DEEP_DIR=/tmp/deepfull/chips_deep node --max-old-space-size=6144 scripts/broker_cross_probe.mjs
 *    node scripts/broker_cross_probe.mjs --selftest    # 注入「只在低位階有效」的訊號,驗 within-cell 對照
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DEEP_DIR = process.env.CHIPS_DEEP_DIR || path.join(ROOT, 'chips_deep');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const BUY_TH = 0.5, DEDUP = 10, COST = 0.44, MIN_N = 300;
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
    const o = { dates: [], close: [], high: [], low: [], open: [], vol: [], fn: [], tn: [] };
    for (const r of rows) {
      if (!r || r.close == null) continue;
      o.dates.push(String(r.date).replace(/\//g, '-'));
      o.close.push(+r.close); o.high.push(+r.high); o.low.push(+r.low);
      o.open.push(+r.open); o.vol.push(+(r.volume || 0));
      o.fn.push(r.foreign_net == null ? null : +r.foreign_net);   // 外資(張)
      o.tn.push(r.trust_net == null ? null : +r.trust_net);       // 投信(張)
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

// 📊 基本面(⛔ 零前視):季 EPS + 財報公布日規則(同 pe_probe 的做法)
//    Q1→5/15・Q2→8/14・Q3→11/14・Q4→隔年 3/31。回 {sym: [[knownDate, eps, epsYoY], ...]}
function loadFund() {
  const out = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'fund_yoy_gm.json'), 'utf8'));
    const data = j.data || j;
    for (const [sym, d] of Object.entries(data)) {
      if (sym.startsWith('_') || !d || !Array.isArray(d.qeps)) continue;
      const byP = new Map();
      for (const q of d.qeps) if (q && q.period && q.eps != null) byP.set(q.period, +q.eps);
      const lst = [];
      for (const [period, eps] of byP) {
        const [y, m] = period.split('-').map(Number);
        const known = m === 3 ? `${y}-05-15` : m === 6 ? `${y}-08-14`
          : m === 9 ? `${y}-11-14` : `${y + 1}-03-31`;
        const prev = byP.get(`${y - 1}-${period.slice(5)}`);
        lst.push([known, eps, prev == null ? null : (eps - prev)]);
      }
      lst.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (lst.length) out.set(sym, lst);
    }
  } catch { }
  return out;
}

function fundAt(fund, sym, date) {
  const lst = fund.get(sym); if (!lst) return null;
  let best = null;
  for (const row of lst) { if (row[0] <= date) best = row; else break; }
  return best;   // [knownDate, eps, epsYoY|null]
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

// ── 主程式 ─────────────────────────────────────────────────────
function main() {
  console.log('🧬 分點 × K線 / 籌碼 / 基本面 —— 交叉條件回測\n');
  const { days, nm } = loadDeep();
  console.log(`📥 深歷史 ${days.length} 天(${days[0]?.d} ~ ${days[days.length - 1]?.d})`);
  if (days.length < 240 && !SELFTEST) { console.log('⏳ 不足 240 天,不跑'); process.exit(2); }
  const need = new Set();
  for (const d of days) for (const s of Object.keys(d.s)) need.add(s);
  const px = loadPrices(need);
  const idxMap = loadIndex();
  const fund = loadFund();
  console.log(`📈 K 線 ${px.size} 檔・基本面(qeps)${fund.size} 檔`);
  const MID = Math.floor(days.length / 2);

  // ═ Pass 1(前半段):學券商屬性 —— 翻臉率 + 技巧(⛔ 只用前半,驗收在後半)═
  const bTrain = new Map();   // b -> {ex:[], flipF, flipN}
  {
    const lastEv = new Map(); let pend = new Map(); let cur = new Map();
    for (let dn = 0; dn < MID; dn++) {
      const day = days[dn];
      pend = cur; cur = new Map();
      for (const [sym, arr] of Object.entries(day.s)) {
        for (const x of arr) {
          if ((+x[1] || 0) >= 0) continue;
          const st = pend.get(`${x[0]}|${sym}`);
          if (st) st.f++;
        }
      }
      for (const [sym, arr] of Object.entries(day.s)) {
        const o = px.get(sym); if (!o) continue;
        const i = o.at.get(day.d);
        if (i == null || i < 250 || i + 21 >= o.dates.length) continue;
        const vol = o.vol[i]; if (!(vol > 0)) continue;
        for (const x of arr) {
          const b = String(x[0]); const net = +x[1] || 0;
          if (net <= 0) continue;
          if (net / vol * 100 < BUY_TH) continue;
          const key = `${b}|${sym}`;
          const pv = lastEv.get(key);
          if (pv != null && dn - pv < DEDUP) continue;
          lastEv.set(key, dn);
          if (!tradable(px, sym, i)) continue;
          const e10 = exRet(px, idxMap, sym, i, 10);
          if (e10 == null) continue;
          let a = bTrain.get(b); if (!a) bTrain.set(b, a = { ex: [], flipF: 0, flipN: 0 });
          a.ex.push(e10); a.flipN++;
          const st = { f: 0 }; cur.set(key, st); a._st = a._st || []; a._st.push(st);
        }
      }
    }
    for (const [, a] of bTrain) { a.flipF = (a._st || []).reduce((s, x) => s + x.f, 0); delete a._st; }
  }
  const flipRate = new Map(), skill = new Map();
  for (const [b, a] of bTrain) {
    if (a.flipN >= 80) { flipRate.set(b, a.flipF / a.flipN); skill.set(b, mean(a.ex)); }
  }
  const skSorted = [...skill.entries()].sort((x, y) => y[1] - x[1]);
  const topSkill = new Set(skSorted.slice(0, Math.max(5, Math.floor(skSorted.length / 5))).map(([b]) => b));
  const hiFlip = new Set([...flipRate.entries()].filter(([, r]) => r >= 0.35).map(([b]) => b));
  console.log(`🎓 前半段學到:可排名券商 ${flipRate.size} 家・高翻臉(≥35%)${hiFlip.size} 家・前 1/5 技巧組 ${topSkill.size} 家\n`);

  // ═ Pass 2(全窗口):日層級紀錄 + 券商事件(帶交叉特徵)═════════
  const dayRecs = [];    // {sym,dnum,i,chg1,chg5,pos,vola,brk,concBuy,flipShare,fSign,tSign,eps,epsYoY,ex1,ex10,ex20}
  const bEvents = [];    // {b,sym,dnum,i,pos,run,cost60,ex10,ex20,isTop}
  const lastEv = new Map(); const runLen = new Map();
  const cum = new Map();   // 關鍵分點:`b|s` -> {pv, vol, days}(累積成本,⭐ 用過去的,更新在事件之後)
  for (let dn = 0; dn < days.length; dn++) {
    const day = days[dn];
    for (const [sym, arr] of Object.entries(day.s)) {
      const o = px.get(sym); if (!o) continue;
      const i = o.at.get(day.d);
      if (i == null || i < 260 || i + 21 >= o.dates.length) continue;
      const vol = o.vol[i]; if (!(vol > 0)) continue;
      const C = o.close[i];
      // — 日層級特徵(全部只用當天以前的資料)—
      let mn = Infinity, mx = -Infinity;
      for (let k = i - 251; k <= i; k++) { const v = o.close[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const pos = mx > mn ? (C - mn) / (mx - mn) * 100 : 50;
      const chg1 = (C / o.close[i - 1] - 1) * 100;
      const chg5 = (C / o.close[i - 5] - 1) * 100;
      let hi60 = -Infinity; for (let k = i - 60; k < i; k++) if (o.high[k] > hi60) hi60 = o.high[k];
      const brk = C > hi60;
      let sq = 0, sm = 0;
      for (let k = i - 19; k <= i; k++) { const r = Math.log(o.close[k] / o.close[k - 1]); sq += r * r; sm += r; }
      const vola = Math.sqrt(Math.max(0, sq / 20 - (sm / 20) ** 2)) * Math.sqrt(240) * 100;   // 年化%
      const fSign = o.fn[i] == null ? null : (o.fn[i] > 0 ? 1 : o.fn[i] < 0 ? -1 : 0);
      const tSign = o.tn[i] == null ? null : (o.tn[i] > 0 ? 1 : o.tn[i] < 0 ? -1 : 0);
      const fu = fundAt(fund, sym, day.d);
      // — 分點特徵 —
      let buySum = 0, flipBuy = 0, top5 = [];
      for (const x of arr) {
        const net = +x[1] || 0; if (net <= 0) continue;
        buySum += net; top5.push(net);
        if (hiFlip.has(String(x[0]))) flipBuy += net;
      }
      top5.sort((a2, b2) => b2 - a2);
      const concBuy = top5.slice(0, 5).reduce((s2, x2) => s2 + x2, 0) / vol * 100;
      const flipShare = dn >= MID && buySum > 0 ? flipBuy / buySum * 100 : null;   // 後半才有(訓練段學的)
      if (!tradable(px, sym, i)) { /* 日層級也守「買得到」 */ } else {
        const ex1 = exRet(px, idxMap, sym, i, 1), ex10 = exRet(px, idxMap, sym, i, 10), ex20 = exRet(px, idxMap, sym, i, 20);
        if (ex10 != null) {
          dayRecs.push({ sym, dnum: dn, pos, vola, chg1, chg5, brk, concBuy, flipShare,
                         fSign, tSign, eps: fu ? fu[1] : null, epsYoY: fu ? fu[2] : null, ex1, ex10, ex20 });
        }
      }
      // — 券商事件(B/C/H/I 用)—
      for (const x of arr) {
        const b = String(x[0]); const net = +x[1] || 0;
        const key = `${b}|${sym}`;
        const cm = cum.get(key);
        if (net <= 0) { runLen.delete(key); continue; }
        const ratio = net / vol * 100;
        if (ratio < BUY_TH) { runLen.delete(key); continue; }
        const pr = runLen.get(key);
        const run = (pr && pr.dn === dn - 1) ? pr.run + 1 : 1;
        runLen.set(key, { dn, run });
        const pv0 = lastEv.get(key);
        const dedupOk = !(pv0 != null && dn - pv0 < DEDUP);
        // 關鍵分點:今天大買**之前**的累積成本位階(⛔ 更新在下面,不吃到今天)
        let cost60 = null;
        if (cm && cm.days >= 8 && cm.vol > 0 && mx > mn) {
          cost60 = ((cm.pv / cm.vol) - mn) / (mx - mn) * 100;
        }
        if ((dedupOk || run === 3) && tradable(px, sym, i)) {
          const ex10 = exRet(px, idxMap, sym, i, 10), ex20 = exRet(px, idxMap, sym, i, 20);
          if (ex10 != null) {
            bEvents.push({ b, dnum: dn, pos, run, cost60, chg5, ex10, ex20,
                           isTop: dn >= MID && topSkill.has(b) });
          }
        }
        if (dedupOk) lastEv.set(key, dn);
        // 累積成本更新(事件之後)
        const avg = +x[2] || 0;
        if (avg > 0) {
          const c2 = cm || { pv: 0, vol: 0, days: 0 };
          c2.pv += avg * net; c2.vol += net; c2.days++;
          cum.set(key, c2);
        }
      }
    }
  }
  console.log(`🧾 日層級 ${dayRecs.length.toLocaleString()} 筆・券商事件 ${bEvents.length.toLocaleString()} 筆\n`);
  if (dayRecs.length < 3000) { console.error('❌ 樣本太少'); process.exit(1); }

  // ── 報表工具:cell vs 同 cell 對照(⭐ 共用非分點腿)──────────────
  const line = (name, evs, ctl, { fwd = 'ex10', halves = true } = {}) => {
    if (evs.length < MIN_N || ctl.length < MIN_N) {
      console.log(`   ${name}:n=${evs.length}/${ctl.length} ⏳ 樣本不足`); return null;
    }
    const d10 = mean(evs.map((e) => e[fwd])) - mean(ctl.map((e) => e[fwd]));
    const e20 = evs.filter((e) => e.ex20 != null), c20 = ctl.filter((e) => e.ex20 != null);
    const d20 = mean(e20.map((e) => e.ex20)) - mean(c20.map((e) => e.ex20));
    const w = evs.filter((e) => e[fwd] > 0).length / evs.length * 100;
    const cw = ctl.filter((e) => e[fwd] > 0).length / ctl.length * 100;
    let hstr = '';
    if (halves) {
      const h = (lo, hi) => {
        const a = evs.filter((e) => e.dnum >= lo && e.dnum < hi), b2 = ctl.filter((e) => e.dnum >= lo && e.dnum < hi);
        return a.length > 100 && b2.length > 100 ? mean(a.map((e) => e[fwd])) - mean(b2.map((e) => e[fwd])) : NaN;
      };
      const d1 = h(0, MID), d2 = h(MID, days.length);
      hstr = ` ・前半 ${sgn(d1)}${nf(d1)} / 後半 ${sgn(d2)}${nf(d2)}` + ((d1 > 0) === (d2 > 0) ? '' : ' 🚨不同向');
    }
    console.log(`   ${name}:n=${evs.length.toLocaleString()} ・${fwd === 'ex1' ? '隔1日' : '10日'} ${sgn(d10)}${nf(d10)}pp ・20日 ${sgn(d20)}${nf(d20)}pp`
      + ` ・勝率 ${nf(w, 1)}%(cell對照 ${nf(cw, 1)}%)${hstr}`);
    return d10;
  };
  const pctOf = (list, key, p) => {
    const v = list.map((e) => e[key]).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : NaN;
  };

  // ═ A. 大漲日 × 隔日沖券商佔比(後半段;技術×分點)═══════════════
  console.log('═══ A. 大漲 ≥5% 那天「誰在買」—— 隔日沖券商佔買超的比例(後半段驗收)═══');
  const strong = dayRecs.filter((e) => e.chg1 >= 5 && e.flipShare != null);
  if (strong.length >= MIN_N * 2) {
    const hiT = pctOf(strong, 'flipShare', 0.7), loT = pctOf(strong, 'flipShare', 0.3);
    console.log(`   (大漲日 ${strong.length.toLocaleString()} 筆;隔日沖佔比 P70=${nf(hiT, 1)}% / P30=${nf(loT, 1)}%)`);
    line('隔日沖買最多(前30%)vs 買最少(後30%)・隔1日',
      strong.filter((e) => e.flipShare >= hiT), strong.filter((e) => e.flipShare <= loT),
      { fwd: 'ex1', halves: false });
    line('同上・10日', strong.filter((e) => e.flipShare >= hiT), strong.filter((e) => e.flipShare <= loT),
      { halves: false });
    // ⚠️ 混淆控制:佔比高的日子可能只是「漲得更兇」→ 再鎖住漲幅帶比一次
    for (const [nm2, lo2, hi2] of [['漲 5~7%', 5, 7], ['漲 7~9.5%', 7, 9.5]]) {
      const band = strong.filter((e) => e.chg1 >= lo2 && e.chg1 < hi2);
      const h2 = pctOf(band, 'flipShare', 0.7), l2 = pctOf(band, 'flipShare', 0.3);
      line(`${nm2} 內:隔日沖佔比 前30% vs 後30%`,
        band.filter((e) => e.flipShare >= h2), band.filter((e) => e.flipShare <= l2), { halves: false });
    }
    // ⚠️ 位階也鎖一次(高佔比可能偏中小型高位階股)
    for (const [nm2, lo2, hi2] of [['高位階(≥60)', 60, 101], ['中低位階(<60)', 0, 60]]) {
      const band = strong.filter((e) => e.pos >= lo2 && e.pos < hi2);
      const h2 = pctOf(band, 'flipShare', 0.7), l2 = pctOf(band, 'flipShare', 0.3);
      line(`${nm2} 內:隔日沖佔比 前30% vs 後30%`,
        band.filter((e) => e.flipShare >= h2), band.filter((e) => e.flipShare <= l2), { halves: false });
    }
  } else console.log(`   ⏳ 大漲日樣本 ${strong.length} 筆不足`);

  // ═ B. 位階 × 分點大買(關鍵分點「低檔大買」)═════════════════════
  console.log('\n═══ B. 位階 × 分點大買 —— 對照組共用位階腿 ═══');
  for (const [nm2, lo, hi] of [['低位階(<25)', 0, 25], ['中位階(40~60)', 40, 60], ['高位階(>75)', 75, 101]]) {
    const cell = dayRecs.filter((e) => e.pos >= lo && e.pos < hi);
    const th = pctOf(cell, 'concBuy', 0.75);
    line(`${nm2}:前5大買佔量 前25% vs 其餘`,
      cell.filter((e) => e.concBuy > th), cell.filter((e) => e.concBuy <= th));
  }

  // ═ C. 連買 ≥3 天 × 發動了沒(隱形吃貨)═════════════════════════
  console.log('\n═══ C. 連買 ≥3 天 × 還沒發動 vs 已經噴了 —— 對照組共用 chg5 腿(run=1)═══');
  const r3 = bEvents.filter((e) => e.run >= 3), r1 = bEvents.filter((e) => e.run === 1);
  line('連買≥3 且 5日漲幅 <2%(隱形吃貨)', r3.filter((e) => e.chg5 < 2), r1.filter((e) => e.chg5 < 2));
  line('連買≥3 且 5日漲幅 ≥8%(已經噴了)', r3.filter((e) => e.chg5 >= 8), r1.filter((e) => e.chg5 >= 8));
  // ⚠️ 位階控制:已噴的股票多在高位階 → 高位階內再比一次(排除「這只是位階效果」)
  line('　└ 且股票在高位階(≥60)', r3.filter((e) => e.chg5 >= 8 && e.pos >= 60),
       r1.filter((e) => e.chg5 >= 8 && e.pos >= 60));

  // ═ D. 分點大買 × 外資/投信同買(籌碼)═══════════════════════════
  console.log('\n═══ D. 分點大買 × 法人同買 —— 對照組共用法人腿 ═══');
  const thAll = pctOf(dayRecs, 'concBuy', 0.75);
  for (const [nm2, test] of [
    ['外資買超那天', (e) => e.fSign === 1], ['外資賣超那天', (e) => e.fSign === -1],
    ['投信買超那天', (e) => e.tSign === 1]]) {
    const cell = dayRecs.filter(test);
    line(`${nm2}:分點大買(前25%)vs 沒有`,
      cell.filter((e) => e.concBuy > thAll), cell.filter((e) => e.concBuy <= thAll));
  }

  // ═ E. 創 60 日新高 × 分點集中(技術)════════════════════════════
  console.log('\n═══ E. 創 60 日新高那天 × 分點集不集中 —— 對照組共用突破腿 ═══');
  const brkCell = dayRecs.filter((e) => e.brk);
  const thB = pctOf(brkCell, 'concBuy', 0.75);
  line('突破日:分點大買(前25%)vs 沒有',
    brkCell.filter((e) => e.concBuy > thB), brkCell.filter((e) => e.concBuy <= thB));

  // ═ F. 分點大買 × 基本面 ═══════════════════════════════════════
  console.log('\n═══ F. 分點大買 × 基本面 —— 對照組共用基本面腿(⛔ 只用事件當時已公布的季報)═══');
  const epsPos = dayRecs.filter((e) => e.eps != null && e.eps > 0);
  const yoyUp = dayRecs.filter((e) => e.epsYoY != null && e.epsYoY > 0);
  console.log(`   (覆蓋:最近一季 EPS 已知 ${dayRecs.filter((e) => e.eps != null).length.toLocaleString()} 筆・EPS YoY 已知 ${dayRecs.filter((e) => e.epsYoY != null).length.toLocaleString()} 筆 —— YoY 只覆蓋後段窗口,照實)`);
  line('最近一季賺錢(EPS>0):分點大買 vs 沒有',
    epsPos.filter((e) => e.concBuy > thAll), epsPos.filter((e) => e.concBuy <= thAll));
  line('獲利成長(EPS YoY>0):分點大買 vs 沒有',
    yoyUp.filter((e) => e.concBuy > thAll), yoyUp.filter((e) => e.concBuy <= thAll));

  // ═ G. 🧬 高位階+高波動 × 分點大買(現行配置的增量)═══════════════
  console.log('\n═══ G. 🧬 高位階(≥75)+ 高波動(≥全體 P60)× 分點大買 ═══');
  const vTh = pctOf(dayRecs, 'vola', 0.6);
  const gene = dayRecs.filter((e) => e.pos >= 75 && e.vola >= vTh);
  const thG = pctOf(gene, 'concBuy', 0.75);
  line('🧬 內:分點大買(前25%)vs 沒有', gene.filter((e) => e.concBuy > thG), gene.filter((e) => e.concBuy <= thG));

  // ═ H. 訓練段高技巧券商 × 位階(後半段驗收)══════════════════════
  console.log('\n═══ H. 前半段最會挑的券商,後半段在不同位階買 —— 對照組共用位階腿 ═══');
  const post = bEvents.filter((e) => e.dnum >= MID);
  for (const [nm2, lo, hi] of [['低位階(<40)', 0, 40], ['高位階(≥60)', 60, 101]]) {
    const cell = post.filter((e) => e.pos >= lo && e.pos < hi);
    line(`${nm2}:技巧組買 vs 其他券商買`,
      cell.filter((e) => e.isTop), cell.filter((e) => !e.isTop), { halves: false });
  }

  // ═ I. 關鍵分點:累積成本在低檔的券商又大買 ══════════════════════
  console.log('\n═══ I. 關鍵分點 —— 累積成本(≥8 個買超日)落在 252 日區間哪裡,今天又大買 ═══');
  const withCost = bEvents.filter((e) => e.cost60 != null);
  console.log(`   (有累積成本可算的事件 ${withCost.length.toLocaleString()} 筆)`);
  line('成本在低檔(<30%)的券商大買 vs 成本在高檔(>70%)的券商大買',
    withCost.filter((e) => e.cost60 < 30), withCost.filter((e) => e.cost60 > 70));
  // ⚠️ 上面兩組的「股票位階」不同 → 再做一次 within-位階:
  for (const [nm2, lo, hi] of [['且股票在低位階(<40)', 0, 40], ['且股票在中高位階(≥40)', 40, 101]]) {
    const cell = withCost.filter((e) => e.pos >= lo && e.pos < hi);
    line(`${nm2}:低成本券商買 vs 高成本券商買`,
      cell.filter((e) => e.cost60 < 30), cell.filter((e) => e.cost60 > 70));
  }

  console.log(`\n📌 判讀:每一行都是「同條件下,有分點腿 − 沒分點腿」的 pp 差 —— 量的是分點**多帶**的資訊。`);
  console.log(`   成立門檻:10 日差 ≥ ${COST}pp(成本)且前後半同向且 n≥${MIN_N}。`);
  return { dayRecs, bEvents, MID };
}

// ── 🧪 selftest:注入「分點大買**只在低位階**有效」,驗 within-cell 對照有沒有真的隔離 ──
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bcp-'));
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
  fs.writeFileSync(path.join(pd, 'fund_yoy_gm.json'), JSON.stringify({ data: {} }));
  // 偶數股票 = 低位階(長期陰跌後盤底)・奇數 = 高位階(長期上漲)
  // ⚠️ 訊號要**稀疏**(每 45 天一次)—— 第一版每 9 天一次、每次推 10 根,
  //    低位階組被自己的訊號推成高位階 → 低位階格變空(selftest 抓到)。
  const bigBuy = (s2, b) => ((b + s2 * 7) % 45 === 0);
  const syms = [];
  for (let s2 = 0; s2 < NSYM; s2++) {
    const sym = String(4000 + s2); syms.push(sym);
    const lowPos = s2 % 2 === 0;
    const rows = []; let c = 100;
    for (let b = 0; b < NBAR; b++) {
      // ⭐ 訊號效果**只給低位階組**:大買後 10 根各 +0.35%
      const boost = lowPos && [...Array(10).keys()].some((k) => b - 1 - k >= 0 && bigBuy(s2, b - 1 - k));
      // 低位階組整段陰跌(訊號的 +3.5% 蓋不過 −0.1%/日 的漂移)→ pos 保持在低檔
      const drift = lowPos ? -0.001 : 0.0012;
      const prevC = c;
      c *= 1 + drift + (boost ? 0.0035 : 0);
      rows.push({ date: dates[b], open: +prevC.toFixed(2), high: +(Math.max(prevC, c) * 1.005).toFixed(2),
                  low: +(Math.min(prevC, c) * 0.995).toFixed(2), close: +c.toFixed(2), volume: 10_000_000,
                  foreign_net: null, trust_net: null });
    }
    fs.writeFileSync(path.join(pd, `${sym}.json`), JSON.stringify(rows));
  }
  for (let b = NBAR - NDAY; b < NBAR - 25; b++) {
    const sMap = {};
    syms.forEach((sym, s2) => {
      const arr = [];
      if (bigBuy(s2, b)) for (let k = 0; k < 5; k++) arr.push([`77${k}0`, 500_000, 100]);
      for (let f = 0; f < 8; f++) if ((b + f * 7 + s2 * 3) % 13 === 0) arr.push([String(5000 + f), 60_000, 100]);
      if (arr.length) sMap[sym] = arr;
    });
    fs.writeFileSync(path.join(dd, `${dates[b]}.json.gz`),
      zlib.gzipSync(Buffer.from(JSON.stringify({ d: dates[b], n: NSYM, k: 15, nm: {}, s: sMap }))));
  }
  DEEP_DIR = dd; DATA_DIR = pd;
  console.log('🧪 --selftest:「分點大買 → 漲」**只發生在低位階組**。斷言 B 的低位階格要抓到、高位階格要接近 0。\n');
}

if (SELFTEST) {
  selftest();
  const { dayRecs } = main();
  // 直接重算 B 的兩格(⛔ 呼叫跟正式輸出同一套資料,不複製判定)
  const cellEdge = (lo, hi) => {
    const cell = dayRecs.filter((e) => e.pos >= lo && e.pos < hi);
    const v = cell.map((e) => e.concBuy).filter((x) => isFinite(x)).sort((a, b) => a - b);
    const th = v[Math.floor(v.length * 0.75)];
    const a = cell.filter((e) => e.concBuy > th), b2 = cell.filter((e) => e.concBuy <= th);
    if (a.length < 100 || b2.length < 100) return null;
    return mean(a.map((e) => e.ex10)) - mean(b2.map((e) => e.ex10));
  };
  const loE = cellEdge(0, 25), hiE = cellEdge(75, 101);
  console.log(`\n🧪 自驗:低位階格 edge=${nf(loE)}pp ・高位階格 edge=${nf(hiE)}pp`);
  const bad = [];
  if (!(loE > 1.5)) bad.push(`低位階格沒抓到注入的訊號(${nf(loE)})`);
  if (!(Math.abs(hiE) < 0.6)) bad.push(`高位階格出現不該有的邊際(${nf(hiE)})→ within-cell 對照壞了`);
  if (bad.length) { console.error('❌ SELFTEST 失敗:'); bad.forEach((b2) => console.error('   - ' + b2)); process.exit(1); }
  console.log('✅ BROKER_CROSS_PROBE_SELFTEST_PASS(within-cell 對照真的隔離得開)');
} else {
  main();
}
