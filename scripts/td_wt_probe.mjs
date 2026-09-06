#!/usr/bin/env node
/**
 * 📐 TD Sequential(DeMark)+ WaveTrend(MarketCipher / LuxAlgo 那類「商業聖杯」的核心)全市場實測
 *
 * 使用者問:「這兩個指標以我目前的數據做得出來嗎?有還欠缺什麼?可以運用在哪裡?」
 * ⭐ 兩個都是**純 OHLC 公式** → 資料完全夠 → ⛔ 不用評估,直接回測(本專案鐵則:探針先行)。
 *
 * ── 實作(⛔ 照原版定義,不自己改門檻)──
 * ① TD Sequential(Tom DeMark):
 *    ・Buy  Setup = 連 9 根 close < close[4]   ・Sell Setup = 連 9 根 close > close[4]
 *    ・Perfection(買)= 第 8 或 9 根的 low  ≤ 第 6、7 根的 low
 *      Perfection(賣)= 第 8 或 9 根的 high ≥ 第 6、7 根的 high
 *    ・Countdown 13(買)= setup 完成後,累計 13 根 close ≤ low[2](賣:close ≥ high[2])
 * ② WaveTrend(LazyBear 版,MarketCipher B 的藍/綠點就是它):
 *      ap = (h+l+c)/3 ・esa = EMA(ap,10) ・d = EMA(|ap−esa|,10)
 *      ci = (ap−esa)/(0.015·d) ・wt1 = EMA(ci,21) ・wt2 = SMA(wt1,4)
 *    ・買 = wt1 由下往上穿 wt2 且 wt1 < −53(超賣區)  ・賣 = 反向且 wt1 > +53
 * ③ 「聖杯堆疊」= WaveTrend 超賣金叉 + RSI(14)<40 + 收在 EMA200 之上(趨勢濾網)
 *    —— 這正是那類商品在賣的「多指標共振」。
 *
 * ⭐ 六道關卡:全期正 ・前後半同向 ・逐年同向 ・去最好年 ・扣成本 0.44% ・增量檢定(疊在 🧬 之上)
 * ⭐ 對照組 = 同一批(股·日)全部(⛔ 不抽樣;基準本來就是負的,⛔ 不是 0 也不是 50%)
 * 🚨 進場 = **隔天開盤**(訊號要收盤才知道),並排除隔天開盤仍鎖死(買不到)
 * ⚠️ 逐年/中點一律從**實際樣本**推(⛔ 不寫死年份 —— V74.2.8 的教訓)
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const HOR = [1, 3, 5, 10, 20];
const COST = 0.44;
const DEDUP = 10;
const ONLY_GENE = process.env.GENE === '1';    // 🧬 增量檢定模式:只收「位階≥75 且 振幅≥3.2」的事件

// ── 大盤(扣同期)──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) {
  const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
  if (d) { mkt.set(d, +r.close); mdays.push(d); }
}
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => {
  const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]);
  return a > 0 ? (b / a - 1) * 100 : null;
};

const buckets = new Map();
const add = (k, ev) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ev); };

// ── 指標(純函式,方便日後搬進 App 時對照)──
const ema = (arr, n) => { const k = 2 / (n + 1), o = new Array(arr.length); let p = arr[0];
  for (let i = 0; i < arr.length; i++) { p = i ? arr[i] * k + p * (1 - k) : arr[0]; o[i] = p; } return o; };
const sma = (arr, n) => { const o = new Array(arr.length).fill(null); let s = 0;
  for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= n) s -= arr[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
function waveTrend(R, n1 = 10, n2 = 21) {
  const ap = R.map(r => (r.h + r.l + r.c) / 3);
  const esa = ema(ap, n1);
  const d = ema(ap.map((v, i) => Math.abs(v - esa[i])), n1);
  const ci = ap.map((v, i) => d[i] > 1e-9 ? (v - esa[i]) / (0.015 * d[i]) : 0);
  const wt1 = ema(ci, n2);
  return { wt1, wt2: sma(wt1, 4) };
}
function rsi14(R) {
  const o = new Array(R.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < R.length; i++) {
    const ch = R[i].c - R[i - 1].c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; if (i === 14) o[i] = al > 0 ? 100 - 100 / (1 + ag / al) : 100; }
    else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; o[i] = al > 0 ? 100 - 100 / (1 + ag / al) : 100; }
  }
  return o;
}

const files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
let nSym = 0, nBar = 0;
for (const f of files) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 300) continue;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
    o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0,
  })).filter(r => r.d);
  if (R.length < 300) continue;
  nSym++; nBar += R.length;

  const { wt1, wt2 } = waveTrend(R);
  const rsi = rsi14(R);
  const e200 = ema(R.map(r => r.c), 200);

  // ── TD Setup 計數 ──
  const bSet = new Array(R.length).fill(0), sSet = new Array(R.length).fill(0);
  for (let i = 4; i < R.length; i++) {
    bSet[i] = R[i].c < R[i - 4].c ? bSet[i - 1] + 1 : 0;
    sSet[i] = R[i].c > R[i - 4].c ? sSet[i - 1] + 1 : 0;
  }
  // ── TD Countdown 13(setup 9 完成後開始數)──
  const bCd = new Array(R.length).fill(0), sCd = new Array(R.length).fill(0);
  let bOn = false, bN = 0, sOn = false, sN = 0;
  for (let i = 2; i < R.length; i++) {
    // ⚠️ 原版規則:**反向 Setup 完成會取消還沒數完的 Countdown**(recycle/cancellation)。
    //    ⛔ 漏掉這條的話會多算一堆本來早就作廢的 13 → 那是「我實作錯」不是「指標沒用」。
    if (bSet[i] === 9) { bOn = true; bN = 0; sOn = false; sN = 0; }
    if (sSet[i] === 9) { sOn = true; sN = 0; bOn = false; bN = 0; }
    if (bOn && R[i].c <= R[i - 2].l) { bN++; bCd[i] = bN; if (bN >= 13) { bOn = false; } }
    if (sOn && R[i].c >= R[i - 2].h) { sN++; sCd[i] = sN; if (sN >= 13) { sOn = false; } }
  }

  const last = new Map();
  const emit = (key, i, gene) => {
    if (ONLY_GENE && !gene) return;
    const p = last.get(key);
    if (p != null && i - p < DEDUP) return;
    const e = i + 1;
    if (e >= R.length) return;
    const gap = (R[e].o / R[i].c - 1) * 100;
    if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) return;   // 開盤即鎖死 → 買不到
    const ret = {};
    for (const n of HOR) {
      const j = e + n;
      if (j >= R.length) { ret[n] = null; continue; }
      const m = mktRet(R[e].d, n);
      ret[n] = m == null ? null : (R[j].c / R[e].o - 1) * 100 - m;
    }
    last.set(key, i);
    ret._d = R[e].d;
    add(key, ret);
  };

  for (let i = 250; i < R.length - 1; i++) {
    // 位階 / 振幅(⛔ 用迴圈不用 spread,2,500 檔 × 1,300 根會很慢)
    let hi = -Infinity, lo = Infinity;
    for (let q = i - 251 < 0 ? 0 : i - 251; q <= i; q++) { if (R[q].c > hi) hi = R[q].c; if (R[q].c < lo) lo = R[q].c; }
    const pos = hi > lo ? (R[i].c - lo) / (hi - lo) * 100 : 50;
    let amp = 0;
    for (let q = i - 19; q <= i; q++) amp += (R[q].h - R[q].l) / R[q].c;
    amp = amp / 20 * 100;
    const gene = pos >= 75 && amp >= 3.2;            // 🧬 本站現行配置

    emit('對照組(所有交易日)', i, gene);

    // 🔬 V74.5.8 決定性對照:WT<−80 的 95% 落在低位階、66% 是剛暴跌 ——
    //    ⭐ 所以要問的是「**同樣剛暴跌**的日子裡,有沒有 WT<−80 差在哪」,
    //       ⛔ 拿全市場當對照量到的是「跌深」不是「WaveTrend」(共用那條腿的鐵則)。
    let dd10 = 0;
    { let h10 = -Infinity; for (let q = i - 9; q <= i; q++) if (R[q].c > h10) h10 = R[q].c;
      dd10 = (R[i].c / h10 - 1) * 100; }
    if (dd10 <= -12) emit('🆚 共用腿對照:剛暴跌(近10日 ≤−12%)全部', i, gene);

    // ═══ ① TD Sequential ═══
    if (bSet[i] === 9) {
      emit('📐 TD 買進 Setup 9(連9根收低於4根前)', i, gene);
      const perf = R[i].l <= R[i - 2].l && R[i].l <= R[i - 3].l
                || R[i - 1].l <= R[i - 2].l && R[i - 1].l <= R[i - 3].l;
      emit(perf ? '📐 TD 買 Setup 9 × 完美(perfected)' : '📐 TD 買 Setup 9 × 不完美', i, gene);
      emit(pos >= 60 ? '📐 TD 買 Setup 9 × 高位階' : pos <= 30 ? '📐 TD 買 Setup 9 × 低位階' : '📐 TD 買 Setup 9 × 中位階', i, gene);
    }
    if (sSet[i] === 9) {
      emit('📐 TD 賣出 Setup 9(連9根收高於4根前)', i, gene);
      const perf = R[i].h >= R[i - 2].h && R[i].h >= R[i - 3].h
                || R[i - 1].h >= R[i - 2].h && R[i - 1].h >= R[i - 3].h;
      emit(perf ? '📐 TD 賣 Setup 9 × 完美(perfected)' : '📐 TD 賣 Setup 9 × 不完美', i, gene);
      emit(pos >= 60 ? '📐 TD 賣 Setup 9 × 高位階' : pos <= 30 ? '📐 TD 賣 Setup 9 × 低位階' : '📐 TD 賣 Setup 9 × 中位階', i, gene);
    }
    if (bCd[i] === 13) emit('📐 TD 買進 Countdown 13(教科書最強買點)', i, gene);
    if (sCd[i] === 13) emit('📐 TD 賣出 Countdown 13(教科書最強賣點)', i, gene);

    // ═══ ② WaveTrend(MarketCipher B 核心)═══
    if (i >= 1 && wt2[i] != null && wt2[i - 1] != null) {
      const up = wt1[i - 1] <= wt2[i - 1] && wt1[i] > wt2[i];      // 金叉
      const dn = wt1[i - 1] >= wt2[i - 1] && wt1[i] < wt2[i];      // 死叉
      if (up) {
        emit('🌊 WaveTrend 金叉(不分區)', i, gene);
        if (wt1[i] < -53) emit('🌊 WT 金叉 × 超賣區(<−53,綠點)', i, gene);
        if (wt1[i] < -80) {
          emit('🌊 WT 金叉 × 極度超賣(<−80)', i, gene);
          // 🔬 V74.5.8 深挖:它到底是「WaveTrend 有料」還是只是**跌深反彈**?
          //    ⭐ 這兩者要分開 —— 本站已知「跌停後第一根紅K」六關全過,
          //       如果 <−80 大多落在剛暴跌的股票上,那它只是那條的換皮。
          emit(pos >= 60 ? '🔬 WT<−80 × 高位階' : pos <= 30 ? '🔬 WT<−80 × 低位階' : '🔬 WT<−80 × 中位階', i, gene);
          let dd = 0;                                  // 近 10 日最大跌幅(距 10 日高)
          { let h10 = -Infinity; for (let q = i - 9; q <= i; q++) if (R[q].c > h10) h10 = R[q].c;
            dd = (R[i].c / h10 - 1) * 100; }
          emit(dd <= -12 ? '🔬 WT<−80 × 剛暴跌(近10日 ≤−12%)' : '🔬 WT<−80 × 沒暴跌', i, gene);
          emit(amp >= 3.2 ? '🔬 WT<−80 × 高波動' : '🔬 WT<−80 × 低波動', i, gene);
        }
      }
      if (dn) {
        emit('🌊 WaveTrend 死叉(不分區)', i, gene);
        if (wt1[i] > 53) emit('🌊 WT 死叉 × 超買區(>+53,紅點)', i, gene);
      }
      // ═══ ③ 「聖杯堆疊」= WT 超賣金叉 + RSI<40 + 站上 EMA200 ═══
      if (up && wt1[i] < -53 && rsi[i] != null) {
        const above = R[i].c > e200[i];
        if (rsi[i] < 40) emit(above ? '💎 聖杯堆疊(WT超賣金叉+RSI<40+站上200EMA)' : '💎 聖杯堆疊 × 但在200EMA之下', i, gene);
      }
      // 對照:單純 RSI 超賣(拿來比「疊了那麼多層到底有沒有比較好」)
      if (rsi[i] != null && rsi[i - 1] != null && rsi[i - 1] < 30 && rsi[i] >= 30) emit('🆚 對照:RSI 由 30 以下翻上', i, gene);
    }
  }
}

// ── 統計 ──
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const base = buckets.get('對照組(所有交易日)') || [];
const baseAvg = {}, baseWin = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null);
  baseAvg[n] = avg(v); baseWin[n] = v.filter(x => x > 0).length / v.length * 100;
}
console.log(`\n📊 樣本:${nSym} 檔 ・${nBar.toLocaleString()} 根 K ・對照組 ${base.length.toLocaleString()} 個事件${ONLY_GENE ? '  【🧬 增量檢定模式:只收位階≥75且振幅≥3.2】' : ''}`);
console.log('   對照組平均超額(扣同期加權):' + HOR.map(n => `${n}日 ${baseAvg[n].toFixed(2)}%`).join(' ・'));
console.log('   對照組勝率:' + HOR.map(n => `${n}日 ${baseWin[n].toFixed(1)}%`).join(' ・'));
console.log('   ⚠️ 基準本來就是負的(中位數個股跑輸市值加權)—— ⛔ 不是 0 也不是 50%\n');

const MIN_N = ONLY_GENE ? 120 : 300;
const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組') || evs.length < MIN_N) continue;
  const r = { k, n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - baseAvg[n] : null;
    r[`w${n}`] = v.length ? v.filter(x => x > 0).length / v.length * 100 : null;
    r[`m${n}`] = v.length ? med(v) : null;
  }
  rows.push(r);
}
rows.sort((a, b) => (b.e10 ?? -99) - (a.e10 ?? -99));
const pad = (s, w) => String(s).padEnd(w, ' ');
const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
console.log('事件'.padEnd(40) + ' n'.padStart(8) + '  1日     3日     5日    10日    20日  |10日勝率 |10日中位');
console.log('─'.repeat(108));
for (const r of rows) console.log(pad(r.k, 40) + String(r.n).padStart(8) + '  '
  + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + '  |'
  + (r.w10 == null ? '—' : r.w10.toFixed(1) + '%').padStart(7) + '  |' + num(r.m10).padStart(7));

// ── 🚧 六道關卡 ──
const allD = base.map(e => e._d).filter(Boolean).sort();
const MID = allD[Math.floor(allD.length / 2)];
const YRS = [...new Set(allD.map(d => d.slice(0, 4)))].sort();
const sub = (evs, f) => evs.filter(f).map(e => e[10]).filter(x => x != null);
const baseSub = f => { const v = sub(base, f); return v.length ? avg(v) : null; };
console.log('\n\n████ 🚧 穩健性檢定(只看 10 日;⭐ 邊際要 > 成本 0.44pp 才算數)████');
console.log(`   樣本期間 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID} ・逐年涵蓋 ${YRS.join('/')}`);
const MINSUB = ONLY_GENE ? 30 : 60;
console.log('\n事件'.padEnd(41) + '全期    前半    後半   |逐年(' + YRS.map(y => y.slice(2)).join('/') + ')   去最好年  扣成本');
console.log('─'.repeat(110));
for (const r of rows) {
  const evs = buckets.get(r.k);
  const h1 = sub(evs, e => e._d < MID), h2 = sub(evs, e => e._d >= MID);
  const b1 = baseSub(e => e._d < MID), b2 = baseSub(e => e._d >= MID);
  const e1 = h1.length >= MINSUB ? avg(h1) - b1 : null, e2 = h2.length >= MINSUB ? avg(h2) - b2 : null;
  const yr = {};
  for (const y of YRS) {
    const v = sub(evs, e => e._d.startsWith(y)), bv = baseSub(e => e._d.startsWith(y));
    yr[y] = v.length >= MINSUB && bv != null ? avg(v) - bv : null;
  }
  const ys = Object.values(yr).filter(x => x != null);
  let exBest = null;
  if (ys.length >= 2) {
    const bestY = Object.entries(yr).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0][0];
    const v = sub(evs, e => !e._d.startsWith(bestY)), bv = baseSub(e => !e._d.startsWith(bestY));
    exBest = v.length >= MINSUB && bv != null ? avg(v) - bv : null;
  }
  const same = e1 != null && e2 != null && Math.sign(e1) === Math.sign(e2);
  const ySame = ys.length >= 2 && ys.every(x => Math.sign(x) === Math.sign(ys[0]));
  const net = (r.e10 ?? 0) - COST;
  console.log(pad(r.k, 41) + num(r.e10).padStart(6) + num(e1).padStart(8) + num(e2).padStart(8) + (same ? ' ✅' : ' ❌')
    + ' |' + YRS.map(y => num(yr[y], 1).padStart(6)).join('') + (ySame ? ' ✅' : ' ❌')
    + num(exBest).padStart(9) + num(net).padStart(8)
    + ((net > 0 && same && ySame && (exBest ?? -9) > 0) ? ' ⭐全過' : ''));
}
// 🔬 診斷:重點桶的逐年樣本分布(⛔ 「—」可能是「沒過關」也可能是「n 不夠」,要分得出來)
if (process.env.DIAG) {
  console.log('\n\n████ 🔬 逐年樣本數診斷 ████');
  for (const k of (process.env.DIAG || '').split('|')) {
    const evs = buckets.get(k); if (!evs) { console.log(`(找不到 ${k})`); continue; }
    const per = {};
    for (const e of evs) { const y = e._d.slice(0, 4); per[y] = (per[y] || 0) + 1; }
    const yv = {};
    for (const y of YRS) {
      const v = sub(evs, e => e._d.startsWith(y)), bv = baseSub(e => e._d.startsWith(y));
      yv[y] = v.length ? (avg(v) - bv) : null;
    }
    console.log(pad(k, 40) + ' 總 ' + String(evs.length).padStart(6) + ' | '
      + YRS.map(y => `${y.slice(2)}:n=${String(per[y] || 0).padStart(4)} ${num(yv[y], 1)}`).join('  '));
  }
}
console.log('\n(數字 = 相對「隨便挑一天」的超額 pp;進場 = 隔天開盤,已排除開盤鎖死)');
console.log('(⭐ 扣掉來回成本 0.44% 之後還是正的才有意義;賣出訊號要看**負**的才算「它說對了」)\n');
