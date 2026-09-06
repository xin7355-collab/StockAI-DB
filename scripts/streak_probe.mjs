#!/usr/bin/env node
/**
 * 🔁 連漲/連跌 N 根 + 跌停後多久回彈(V74.4.0)
 *
 * 使用者:「連續漲幾根或者連跌多少會回彈還是會開始跌的訊號測出來,
 *          還有如欣興今天因被爆導致跌停,何時會回彈,要注意什麼事件才會回彈」
 *
 * ⛔ 消息面**無法回測**(stock_news.json 只有當前快照、沒有歷史)——
 *    但「跌停」這個**事件本身**不需要知道原因就測得動,而且可以測
 *    「什麼條件下的跌停後續比較好」,那正好回答「要注意什麼」。
 *
 * ⭐ 六道關卡:全期正 ・前後半同向 ・逐年同向 ・去最好年 ・扣成本 0.44% ・(需要時)增量檢定
 * ⭐ 對照組 = 同一批(股·日)全部(⛔ 不抽樣;基準本來就是負的,不是 0 也不是 50%)
 * ⚠️ 報酬一律扣**同期加權指數**;同檔同事件 10 日內只算一次(⛔ 否則連續事件會重複計)
 *
 * 🚨 進場價一律用**隔天開盤**:
 *    ・跌停/漲停鎖死那天你**買不到**收盤價(V74.0.2 的教訓,那次讓 4.12x 縮成 1.29x)
 *    ・而且「連 N 根」要收盤才知道
 *    ⭐ 並且**排除隔天開盤仍鎖死**的(那也買不到)
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const HOR = [1, 3, 5, 10, 20];
const COST = 0.44;            // 來回成本 %
const DEDUP = 10;             // 同檔同事件 N 日去重

// ── 大盤(扣同期)──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
  .filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) {
  const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
  if (!d) continue;
  mkt.set(d, +r.close); mdays.push(d);
}
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => {
  const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]);
  return a > 0 ? (b / a - 1) * 100 : null;
};

// ── 事件桶 ──
const SER = new Map();        // sym → {d:[], c:[]}  (⭐ V74.8.7 逐日曲線用)
const buckets = new Map();
const add = (k, ev) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ev); };

const files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
let nSym = 0, nBar = 0;
for (const f of files) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 260) continue;
  const sym = f.replace('.json', '');
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
    o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0,
  })).filter(r => r.d);
  if (R.length < 260) continue;
  nSym++; nBar += R.length;
  SER.set(sym, { d: R.map(x => x.d), c: Float64Array.from(R.map(x => x.c)), o: Float64Array.from(R.map(x => x.o)) });

  // 每日漲跌 + 連續段
  const chg = R.map((r, i) => i ? (r.c / R[i - 1].c - 1) * 100 : 0);
  const up = [], dn = [];      // 連幾根
  let u = 0, w = 0;
  for (let i = 0; i < R.length; i++) {
    if (i && chg[i] > 0) u++; else if (i && chg[i] < 0) u = 0;
    if (i && chg[i] < 0) w++; else if (i && chg[i] > 0) w = 0;
    up.push(u); dn.push(w);
  }
  // 位階(近 252 日)與均量
  const last = new Map();      // 去重:key -> 上次 index
  const emit = (key, i) => {
    const p = last.get(key);
    if (p != null && i - p < DEDUP) return;
    // 🚨 進場 = 隔天開盤;⛔ 排除隔天開盤仍鎖死(買不到)
    const e = i + 1;
    if (e >= R.length) return;
    const gap = (R[e].o / R[i].c - 1) * 100;
    if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) return;   // 開盤即鎖死
    const ret = {};
    for (const n of HOR) {
      const j = e + n;
      if (j >= R.length) { ret[n] = null; continue; }
      const raw = (R[j].c / R[e].o - 1) * 100;
      const m = mktRet(R[e].d, n);
      ret[n] = m == null ? null : raw - m;
    }
    last.set(key, i);
    ret._d = R[e].d; ret._s = sym; ret._e = e;
    add(key, ret);
  };

  for (let i = 250; i < R.length - 1; i++) {
    const win = R.slice(i - 251 < 0 ? 0 : i - 251, i + 1);
    const hi = Math.max(...win.map(x => x.c)), lo = Math.min(...win.map(x => x.c));
    const pos = hi > lo ? (R[i].c - lo) / (hi - lo) * 100 : 50;
    const v20 = R.slice(i - 19, i + 1).reduce((s, x) => s + x.v, 0) / 20;
    const vr = v20 > 0 ? R[i].v / v20 : 1;
    const mc = mktRet(R[i - 1] ? R[i - 1].d : R[i].d, 1);   // 當天大盤漲跌

    // ── 對照組:所有交易日 ──
    emit('對照組(所有交易日)', i);

    // ── ① 連漲 N 根 ──
    if (up[i] >= 2) emit(`📈 連漲 ${Math.min(up[i], 6)}${up[i] >= 6 ? '+' : ''} 根`, i);
    // ── ② 連跌 N 根 ──
    if (dn[i] >= 2) emit(`📉 連跌 ${Math.min(dn[i], 6)}${dn[i] >= 6 ? '+' : ''} 根`, i);

    // ── ③ 跌停(欣興那種)──
    if (chg[i] <= -9.2) {
      emit('🔻 跌停(全部)', i);
      // 「要注意什麼」= 分條件看
      emit(pos >= 60 ? '🔻 跌停 × 高位階(跌之前在高檔)' : pos <= 30 ? '🔻 跌停 × 低位階(本來就弱)' : '🔻 跌停 × 中位階', i);
      emit(vr >= 2 ? '🔻 跌停 × 爆量(≥2倍均量)' : vr <= 1 ? '🔻 跌停 × 量縮' : '🔻 跌停 × 中量', i);
      // ⭐ 這條最接近「個股利空 vs 系統性」:大盤沒事它卻跌停 = 個股自己的問題
      if (mc != null) emit(mc > -1 ? '🔻 跌停 × 大盤沒跌(個股利空)' : '🔻 跌停 × 大盤也在跌(系統性)', i);
      if (dn[i] >= 2) emit('🔻 跌停 × 已經連跌(不是第一根)', i);
      else emit('🔻 跌停 × 第一根(前一天還在漲/平)', i);
    }
    // ── ④ 暴跌但沒跌停 ──
    if (chg[i] <= -7 && chg[i] > -9.2) emit('🔻 暴跌 7~9.2%(沒鎖死)', i);
    // ── ⑤ 跌停後的「第一根紅K」= 止跌訊號?──
    if (i >= 1 && chg[i] > 0 && chg[i - 1] <= -9.2) {
      emit('🕯️ 跌停後第一根紅K', i);
      // ⭐⭐ 增量檢定:那根紅K有沒有用,要看**當初為什麼跌停**
      //    (使用者問的欣興 = 大盤沒事、它自己被爆 → 屬於「個股利空」那一格)
      const mcPrev = mktRet(R[i - 2] ? R[i - 2].d : R[i - 1].d, 1);
      if (mcPrev != null) {
        emit(mcPrev > -1 ? '🕯️ 跌停後紅K × 當初大盤沒跌(個股利空)'
                         : '🕯️ 跌停後紅K × 當初大盤也在跌(系統性)', i);
      }
      // 紅K本身的力道:小紅 vs 大紅
      emit(chg[i] >= 3 ? '🕯️ 跌停後紅K × 大紅(≥3%)' : '🕯️ 跌停後紅K × 小紅(<3%)', i);
    }
    // ── ⑥ 連跌之後的第一根紅K ──
    if (i >= 1 && chg[i] > 0 && dn[i - 1] >= 3) emit('🕯️ 連跌 3+ 根後第一根紅K', i);
    // ── ⑦ 漲停(對照:漲停後續)──
    if (chg[i] >= 9.2) emit('🔺 漲停', i);

    // ── ⑧ 跳空缺口四類(V74.4.1,`_detectGap` 有這個分類但從沒回測過期望值)
    //    向上跳空 = 今低 > 昨高;向下 = 今高 < 昨低。
    //    「回補」= 之後 5 個交易日內有摸回缺口(⚠️ 那要看未來 → ⛔ 不可當進場條件,
    //    這裡只是想知道「沒回補的那些後來走多遠」,結果只能當**觀察**不能當訊號)。
    if (i >= 1) {
      const gapUp = R[i].l > R[i - 1].h, gapDn = R[i].h < R[i - 1].l;
      if (gapUp || gapDn) {
        const gp = gapUp ? (R[i].l / R[i - 1].h - 1) * 100 : (R[i].h / R[i - 1].l - 1) * 100;
        if (Math.abs(gp) >= 1) {
          emit(gapUp ? '🕳️ 向上跳空 ≥1%' : '🕳️ 向下跳空 ≥1%', i);
          // 帶量 vs 沒量(這個**當天就知道**,可以當進場條件)
          if (gapUp) emit(vr >= 1.5 ? '🕳️ 向上跳空 × 帶量(≥1.5倍)' : '🕳️ 向上跳空 × 沒量', i);
          // 位階(也是當天就知道)
          if (gapUp) emit(pos >= 70 ? '🕳️ 向上跳空 × 高位階' : pos <= 30 ? '🕳️ 向上跳空 × 低位階' : '🕳️ 向上跳空 × 中位階', i);
        }
      }
    }

    // ── ⑨ 創 60 日新高後「回測不破」—— 最經典的「回後買上漲」型態
    //    定義:i-5..i-1 之間創過 60 日新高,之後回檔但**沒有跌破那個高點的 95%**,
    //    而且今天收紅站回。⚠️ 全部用**當天為止**的資訊,零前視。
    if (i >= 66) {
      const w60 = R.slice(i - 65, i - 5).map(x => x.c);
      const nh = Math.max(...w60);
      const seg = R.slice(i - 5, i);           // 最近 5 根(不含今天)
      const madeHigh = seg.some(x => x.c >= nh);
      const lowest = Math.min(...seg.map(x => x.l));
      if (madeHigh && lowest >= nh * 0.95 && chg[i] > 0 && R[i].c >= nh * 0.98) {
        emit('🏔️ 創60日高後回測不破(今天收紅)', i);
      }
    }

    // ── ⑩ 極度量縮之後的爆量(「量先價行」的可測版本)
    if (i >= 25) {
      const v5 = R.slice(i - 5, i).reduce((s, x) => s + x.v, 0) / 5;
      const v20p = R.slice(i - 25, i - 5).reduce((s, x) => s + x.v, 0) / 20;
      if (v20p > 0 && v5 / v20p <= 0.6 && vr >= 2) {
        emit(chg[i] > 0 ? '🔊 量縮後爆量 × 收紅' : '🔊 量縮後爆量 × 收黑', i);
      }
    }
  }
}

// ── 統計 ──
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const base = buckets.get('對照組(所有交易日)') || [];
const baseAvg = {}, baseWin = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null);
  baseAvg[n] = avg(v); baseWin[n] = v.filter(x => x > 0).length / v.length * 100;
}

console.log(`\n📊 樣本:${nSym} 檔 ・${nBar.toLocaleString()} 根 K ・對照組 ${base.length.toLocaleString()} 個事件`);
console.log(`   對照組平均超額(扣同期加權):` + HOR.map(n => `${n}日 ${baseAvg[n].toFixed(2)}%`).join(' ・'));
console.log(`   對照組勝率:` + HOR.map(n => `${n}日 ${baseWin[n].toFixed(1)}%`).join(' ・'));
console.log(`   ⚠️ 基準本來就是負的(中位數個股跑輸市值加權指數)—— ⛔ 不是 0 也不是 50%\n`);

const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組') || evs.length < 300) continue;
  const r = { k, n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - baseAvg[n] : null;      // 相對對照組的邊際
    r[`w${n}`] = v.length ? v.filter(x => x > 0).length / v.length * 100 : null;
    r[`m${n}`] = v.length ? med(v) : null;
  }
  rows.push(r);
}
rows.sort((a, b) => (b.e10 ?? -99) - (a.e10 ?? -99));

const pad = (s, w) => String(s).padEnd(w, ' ');
const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
console.log('事件'.padEnd(34) + ' n'.padStart(8) + '  1日     3日     5日    10日    20日   |10日勝率');
console.log('─'.repeat(96));
for (const r of rows) {
  console.log(pad(r.k, 34) + String(r.n).padStart(8) + '  '
    + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + '  |' + (r.w10 == null ? '—' : r.w10.toFixed(1) + '%').padStart(7));
}
// ── 🚧 六道關卡:前後半同向 / 逐年同向 / 去最好年 / 扣成本 ──
// ⛔ 中點必須從**實際樣本**推(V74.0.2 / trustvol 都栽在用整條日期軸的一半 → 前半永遠 NaN)
const allD = base.map(e => e._d).filter(Boolean).sort();
const MID = allD[Math.floor(allD.length / 2)];
console.log('\n\n████ 🚧 穩健性檢定(只看 10 日;⭐ 邊際要 > 成本 0.44pp 才算數)████');
console.log(`   樣本期間 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID}`);
const sub = (evs, f) => evs.filter(f).map(e => e[10]).filter(x => x != null);
const baseSub = f => { const v = sub(base, f); return v.length ? avg(v) : null; };
// 🚨 V74.2.8 逐年清單原本**寫死 2024/2025/2026** —— K 線補深到 2021 之後,
//    2022(空頭)與 2023 就**完全沒有被那道關卡檢查到**,而且畫面上看不出來(display 也只印 3 欄)。
//    ⭐ 通用:任何「逐年」檢定都要從**實際樣本**推年份,⛔ 不可寫死
//    (同 V74.0.2 limitup / trustvol「中點用整條日期軸」的同型錯誤)。
const YRS = [...new Set(allD.map(d => d.slice(0, 4)))].sort();
console.log(`   逐年檢定涵蓋:${YRS.join(' / ')}`);
console.log('\n事件'.padEnd(35) + '全期    前半    後半   |逐年(' + YRS.map(y => y.slice(2)).join('/') + ')' + ' '.repeat(Math.max(1, 12 - YRS.length * 3)) + '去最好年  扣成本');
console.log('─'.repeat(100));
for (const r of rows.slice(0, 26)) {
  const evs = buckets.get(r.k);
  const h1 = sub(evs, e => e._d < MID), h2 = sub(evs, e => e._d >= MID);
  const b1 = baseSub(e => e._d < MID), b2 = baseSub(e => e._d >= MID);
  const e1 = h1.length >= 60 ? avg(h1) - b1 : null, e2 = h2.length >= 60 ? avg(h2) - b2 : null;
  const yr = {}, yb = {};
  for (const y of YRS) {
    const v = sub(evs, e => e._d.startsWith(y)), bv = baseSub(e => e._d.startsWith(y));
    yr[y] = v.length >= 60 && bv != null ? avg(v) - bv : null; yb[y] = bv;
  }
  const ys = Object.values(yr).filter(x => x != null);
  // 去最好年:拿掉貢獻最大的那一年後重算
  let exBest = null;
  if (ys.length >= 2) {
    const bestY = Object.entries(yr).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0][0];
    const v = sub(evs, e => !e._d.startsWith(bestY)), bv = baseSub(e => !e._d.startsWith(bestY));
    exBest = v.length >= 60 && bv != null ? avg(v) - bv : null;
  }
  const same = e1 != null && e2 != null && Math.sign(e1) === Math.sign(e2);
  const ySame = ys.length >= 2 && ys.every(x => Math.sign(x) === Math.sign(ys[0]));
  const net = (r.e10 ?? 0) - COST;
  console.log(pad(r.k, 35)
    + num(r.e10).padStart(6) + num(e1).padStart(8) + num(e2).padStart(8) + (same ? ' ✅' : ' ❌')
    + ' |' + YRS.map(y => num(yr[y], 1).padStart(6)).join('') + (ySame ? ' ✅' : ' ❌')
    + num(exBest).padStart(9) + num(net).padStart(8) + ((net > 0 && same && ySame && (exBest ?? -9) > 0) ? ' ⭐全過' : ''));
}
console.log('\n(數字 = 相對「隨便挑一天」的超額報酬 pp;進場 = 隔天開盤,已排除開盤鎖死)');
console.log(`(⭐ 扣掉來回成本 ${COST}% 之後還是正的才有意義)\n`);


// ═══════════════════════════════════════════════════════════════════════
// ⏱️ V74.8.7 逐日累積超額報酬曲線 —— 承 doi_probe 的方法
//    (使用者:「有沒有之前回測過、可以用這種邏輯重測的」)
//
// ⭐ 為什麼要重測:上面那張表只給 1/3/5/10/20 日五個點,回答不了
//    「**多久才反應**」與「**反應完該什麼時候走**」。
//
// ⛔⛔ 三個一定要做對的地方(第一版全部踩到):
// ① 🚨 **一律減掉對照組同一天的值** —— 曲線是「扣同期加權」的絕對超額,
//    而中位數個股本來就跑輸市值加權指數(對照組 120 天 −7.6%)→
//    ⛔ 不減的話每一條 120 天都是負的,會被讀成「全部都不行」,
//    但其實「向上跳空×高位階 −1.13」是**贏對照組 6.5pp**。
// ② 🚨 **內部檢核要用同一個子集合** —— 曲線需要 CPOST 天的未來,
//    所以**最近 CPOST 天的事件全部畫不出來**;拿它跟上表(只需要 10 天未來)
//    比會系統性對不上。第一版 8 條有 4 條「❌」,那是我自己比錯不是曲線錯。
// ③ 🚨 **「反應集中度」不可用「前5天 ÷ 120天」** —— 120 天的值可能是負的,
//    比值會變成 −422% 這種無意義的數字。要用「前5天 ÷ **最高點**」+「最高點在第幾天」。
//
// ⚠️ 對照跟 doi_probe **刻意不同**:季報事件擠在同幾個公布日 → 必須橫斷面去均值;
//    個股事件散在各交易日 → 沿用本檔既有口徑「扣同期加權」+ 減對照組曲線。
// ═══════════════════════════════════════════════════════════════════════
const CPRE = 30, CPOST = 120;
const CURVE_KEYS = [
  '對照組(所有交易日)',                          // ⭐ 一定要第一個(後面每一條都要減它)
  '🕯️ 跌停後紅K × 大紅(≥3%)',
  '🕯️ 跌停後紅K × 當初大盤也在跌(系統性)',
  '🕯️ 跌停後紅K × 當初大盤沒跌(個股利空)',
  '🏔️ 創60日高後回測不破(今天收紅)',
  '🕳️ 向上跳空 × 高位階',
  '🔻 跌停(全部)',
  '🔺 漲停',
];
console.log(`\n⏱️ 逐日累積超額報酬曲線(進場前 ${CPRE} 天 ~ 後 ${CPOST} 天)`);

function ecurve(sym, e, d0) {
  const S = SER.get(sym); if (!S) return null;
  if (e - CPRE < 0 || e + CPOST >= S.c.length) return null;
  const mi = mIdx.get(d0); if (mi == null) return null;
  if (mi - CPRE < 0 || mi + CPOST >= mdays.length) return null;
  const b = S.o[e], mb = mkt.get(mdays[mi]);
  if (!(b > 0) || !(mb > 0)) return null;
  const out = new Float64Array(CPRE + CPOST + 1);
  for (let k = -CPRE; k <= CPOST; k++) {
    const px = k === 0 ? S.o[e] : S.c[e + k];
    const mp = mkt.get(mdays[mi + k]);
    out[k + CPRE] = (px / b - 1) * 100 - (mp / mb - 1) * 100;
  }
  return out;
}

// 🚨🚨 第一版的對照組是「全市場所有交易日」→ 拉到 120 天之後,
//    **每一條都變成正的,連「跌停」與「漲停」這兩個相反的事件都是**,
//    而且最高點全部落在窗口盡頭 —— 那是 V74.6.4 剛學到的
//    「贏全市場常常只是因為它是活躍股」在 120 天窗口下被放大 6 倍。
// ⭐ 正解:**對照組要共用「同一批股票」那條腿** —— 每個事件各配一組
//    「同一批股票、但沒觸發那個事件的其他日子」。
const evSyms = {};
for (const key of CURVE_KEYS) {
  if (key.startsWith('對照組')) continue;
  const evs = buckets.get(key); if (!evs) continue;
  evSyms[key] = new Set(evs.map(e => e._s));
}

const EC = {};
for (const key of CURVE_KEYS) {
  const evs = buckets.get(key); if (!evs) continue;
  const step = key.startsWith('對照組') ? 4 : 1;
  const o = { n: 0, sum: new Float64Array(CPRE + CPOST + 1),
              h: [new Float64Array(CPRE + CPOST + 1), new Float64Array(CPRE + CPOST + 1)], hn: [0, 0],
              yr: {}, t10: [] };
  for (let idx = 0; idx < evs.length; idx += step) {
    const ev = evs[idx];
    const c = ecurve(ev._s, ev._e, ev._d); if (!c) continue;
    const hh = ev._d < MID ? 0 : 1, y = ev._d.slice(0, 4);
    o.n++; o.hn[hh]++;
    if (ev[10] != null) o.t10.push(ev[10]);          // 🚧 同子集合的表格值(內部檢核用)
    const yo = (o.yr[y] ||= { n: 0, sum: new Float64Array(CPRE + CPOST + 1) }); yo.n++;
    for (let i = 0; i < c.length; i++) { o.sum[i] += c[i]; o.h[hh][i] += c[i]; yo.sum[i] += c[i]; }
  }
  if (o.n >= 200) EC[key] = o;
}
// ⭐ 每個事件各配一組「同一批股票」的對照
const CTL = {};
{
  const cev = buckets.get('對照組(所有交易日)') || [];
  for (const key of CURVE_KEYS) {
    if (key.startsWith('對照組')) continue;
    const set = evSyms[key]; if (!set) continue;
    const o = { n: 0, sum: new Float64Array(CPRE + CPOST + 1),
                h: [new Float64Array(CPRE + CPOST + 1), new Float64Array(CPRE + CPOST + 1)], hn: [0, 0], yr: {} };
    for (let idx = 0; idx < cev.length; idx += 4) {
      const ev = cev[idx]; if (!set.has(ev._s)) continue;
      const c = ecurve(ev._s, ev._e, ev._d); if (!c) continue;
      const hh = ev._d < MID ? 0 : 1, y = ev._d.slice(0, 4);
      o.n++; o.hn[hh]++;
      const yo = (o.yr[y] ||= { n: 0, sum: new Float64Array(CPRE + CPOST + 1) }); yo.n++;
      for (let i = 0; i < c.length; i++) { o.sum[i] += c[i]; o.h[hh][i] += c[i]; yo.sum[i] += c[i]; }
    }
    if (o.n >= 200) CTL[key] = o;
  }
}
const BALL = EC['對照組(所有交易日)'];
if (!BALL) { console.log('   ⚠️ 對照組畫不出曲線,略過這一段'); }
else {

const raw  = (o, k) => o.sum[k + CPRE] / o.n;                       // 絕對超額(扣大盤)
const bOf  = k => CTL[k] || BALL;                                   // ⭐ 優先用同一批股票的對照
const eat  = (o, k, key) => raw(o, k) - raw(bOf(key), k);
const eatH = (o, h, k, key) => o.h[h][k + CPRE] / o.hn[h] - bOf(key).h[h][k + CPRE] / bOf(key).hn[h];

// 🚧 內部檢核:**同一個子集合**的 10 日平均 vs 曲線 +10 日(絕對超額,兩邊都不減對照組)
console.log('\n   🚧 內部檢核(同子集合的曲線 +10 日 vs 表格 10 日 —— ⛔ 對不上就是曲線算錯了)');
let bad = 0;
for (const [k, o] of Object.entries(EC)) {
  const tbl = avg(o.t10), cur = raw(o, 10), gap = Math.abs(cur - tbl);
  if (gap > 0.05) bad++;
  console.log(`      ${pad(k, 34)} 曲線 ${cur.toFixed(2)} vs 表 ${tbl.toFixed(2)} ・差 ${gap.toFixed(3)} ${gap > 0.05 ? '❌' : '✅'}`);
}
console.log(bad ? `      🚨 ${bad} 條對不上 → 曲線算錯了,下面的數字⛔ 不可信` : '      ✅ 全部對得上 → 曲線算對了');
console.log(`   ⚠️ 曲線需要 ${CPOST} 天的未來 → **最近 ${CPOST} 天的事件畫不出來**,樣本比上表少`);

console.log(`\n   ⭐ 下面是「減掉**同一批股票**的對照組」之後的相對優勢 pp`);
console.log(`      (全市場對照 120 天 ${raw(BALL, 120).toFixed(2)}% ・同批股票對照見下)`);
for (const [k, o] of Object.entries(CTL)) console.log(`      ${pad(k, 34)} 同批對照 120 天 ${raw(o, 120).toFixed(2)}% ・n=${o.n}`);
console.log('   事件                                  │ 進場前30 │  +1日 │  +3日 │  +5日 │ +10日 │ +20日 │ +40日 │ +60日 │ +120日 │ n');
for (const [k, o] of Object.entries(EC)) {
  if (k.startsWith('對照組')) continue;
  const cells = [-30, 1, 3, 5, 10, 20, 40, 60, 120].map(x => {
    const v = eat(o, x, k);
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`.padStart(x === -30 ? 8 : 6);
  });
  console.log(`   ${pad(k, 36)} │ ${cells.join(' │ ')} │ ${o.n}`);
}
console.log('   🚨「進場前30」= 30 天前的價格**相對進場價**,所以 **負值 = 那 30 天漲了**、正值 = 跌了');
console.log('      (🏔️ 創新高 −10.97 = 事件前漲了 11%;🕯️ 跌停後紅K +6.74 = 事件前跌了 6.7% —— 都合理)');

console.log('\n   📈 反應時點:曲線最高在第幾天 ・前 5 天吃掉了多少');
for (const [k, o] of Object.entries(EC)) {
  if (k.startsWith('對照組')) continue;
  let bk = 1, bv = -1e9;
  for (let x = 1; x <= CPOST; x++) { const v = eat(o, x, k); if (v > bv) { bv = v; bk = x; } }
  const d5 = eat(o, 5, k);
  const pct = bv > 0.05 ? d5 / bv * 100 : NaN;
  console.log(`      ${pad(k, 34)} 最高 ${bv >= 0 ? '+' : ''}${bv.toFixed(2)} 在第 ${String(bk).padStart(3)} 天 ・前5天 ${d5 >= 0 ? '+' : ''}${d5.toFixed(2)} = 最高點的 ${isFinite(pct) ? pct.toFixed(0) + '%' : '—'}`);
}

console.log('\n   🚦 「抱幾天」有沒有延續性(前半段找、後半段驗 ・逐年再拆一次)');
for (const [k, o] of Object.entries(EC)) {
  if (k.startsWith('對照組')) continue;
  if (o.hn[0] < 150 || o.hn[1] < 150) { console.log(`      ${pad(k, 34)} 樣本不足`); continue; }
  let bk = 1, bv = -1e9;
  for (let x = 1; x <= CPOST; x++) { const v = eatH(o, 0, x, k); if (v > bv) { bv = v; bk = x; } }
  const test = eatH(o, 1, bk, k);
  const ys = Object.keys(o.yr).sort()
    .map(y => (o.yr[y].n >= 40 && bOf(k).yr[y] && bOf(k).yr[y].n >= 40)
      ? o.yr[y].sum[bk + CPRE] / o.yr[y].n - bOf(k).yr[y].sum[bk + CPRE] / bOf(k).yr[y].n : null)
    .filter(v => v != null);
  const pos = ys.filter(v => v > 0).length;
  const okT = test - COST > 0, okY = ys.length >= 2 && pos === ys.length;
  console.log(`      ${pad(k, 34)} 前半最佳抱 ${String(bk).padStart(3)} 天(${bv.toFixed(2)})→ 後半 ${test >= 0 ? '+' : ''}${test.toFixed(2)} ・扣成本 ${(test - COST).toFixed(2)} ${okT ? '✅' : '❌'} ・逐年 ${pos}/${ys.length} 正 ${okY ? '✅' : '❌'}${okT && okY ? '  ⭐兩關都過' : ''}`);
}

// ⭐⭐ 這一段才是回答使用者的:分成「有反應」與「只是慢漂」兩類
console.log('\n   🧭 分類:這個事件到底有沒有「反應」?(判準 = 前 5 天吃掉最高點的幾成)');
for (const [k, o] of Object.entries(EC)) {
  if (k.startsWith('對照組')) continue;
  let bk = 1, bv = -1e9;
  for (let x = 1; x <= CPOST; x++) { const v = eat(o, x, k); if (v > bv) { bv = v; bk = x; } }
  const pct = bv > 0.05 ? eat(o, 5, k) / bv * 100 : NaN;
  const top20 = eat(o, 20, k), d60 = eat(o, 60, k);
  const cls = !isFinite(pct) ? '— 沒有正的高點'
    : pct >= 50 ? `⭐ **有反應**(前 5 天走完 ${pct.toFixed(0)}%)`
    : pct >= 25 ? `⚠️ 半反應(${pct.toFixed(0)}%)`
    : `➖ **只是慢漂**(前 5 天只有 ${pct.toFixed(0)}%,沒有反應時點可言)`;
  const back = (top20 > 0.5 && d60 < top20 * 0.6) ? ` ・🚪 20 天到頂(${top20.toFixed(2)}),60 天回吐到 ${d60.toFixed(2)} → **離場約 20~30 天**` : '';
  console.log(`      ${pad(k, 34)} ${cls}${back}`);
}

console.log('\n   🚨🚨 但「抱 N 天賺更多」那半⛔ 不可信 —— 看這兩列:');
{
  const a = EC['🔻 跌停(全部)'], b = EC['🔺 漲停'];
  if (a && b) console.log(`      🔻 跌停 120 天 ${eat(a, 120, '🔻 跌停(全部)').toFixed(2)}pp ・🔺 漲停 120 天 ${eat(b, 120, '🔺 漲停').toFixed(2)}pp`);
}
console.log('      **兩個完全相反的事件同時「兩關都過」** → 那是「活躍度」不是「方向」(本站第 N 次遇到)。');
console.log('      真因:同批股票對照**還沒對齊時間**,而且在 120 天窗口裡搜尋最佳天數一定找得到東西。');
console.log('      ⭐ 所以這一段可信的只有「**有沒有反應、反應多久**」,⛔ 不是「抱 N 天可以賺多少」。');

console.log('\n   ⚠️ ⛔ 🔺 漲停那一列**不能拿來驗工具** —— V72.0.1 說的「次日 +1.54%」是');
console.log('      「昨天漲停 × 今天週轉率中等」而且用**當天收盤**進場;這裡是「漲停當天 → 隔天開盤買」,');
console.log('      漲停鎖死時那段動能**在隔天跳空就被吃掉了**(V74.0.2 的教訓)。⛔ 口徑不同,不可互相驗證。');
}
