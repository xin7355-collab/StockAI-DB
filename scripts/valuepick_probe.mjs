#!/usr/bin/env node
/**
 * 💰 「價值選股」到底有沒有用(V74.4.5)
 *
 * 使用者:「之前我不是有給你很多選股策略,有什麼價值選股回測有用的,現在來檢測」
 *
 * ⭐ 先講清楚**哪些測得動、哪些測不動**(⛔ 不可含糊帶過):
 *   ✅ 殖利率 / 配息紀錄 → V74.4.1 起有 `dividends_hist.json`(1,912 檔・2021 起)
 *      → **第一次可以逐日重建「當時的近 12 個月現金殖利率」**,零前視(只算已經除息的)。
 *   ❌ 本益比 / 配息率 / PEG → 要**歷史 EPS**,而 `fund_yoy_gm.json` 的 qeps 只有 **8 季**
 *      → 歷史 PE 只回推得到 2025 年中(pe_probe 的窗口只有 12~15 個月,整段偏多頭)。
 *      ⛔ 這不是程式的問題,是財報資料本身的深度 → 在那之前⛔ 不可宣稱「低本益比有沒有用」。
 *   ❌ 股價淨值比 → `pb` 只有**當前快照**,沒有歷史。
 *
 * 🚨🚨 **這支探針最關鍵的方法論:報酬必須「含息」。**
 *    除息當天股價會**扣掉股利**,但你**領得到**那筆錢。
 *    不含息的話,高殖利率股在每一次除息都被記成「跌」→ 會**系統性低估**它們,
 *    而這正是「高殖利率有沒有用」這題的核心 → ⛔ 不含息等於直接把答案做錯。
 *
 * 🚨 進場 = 隔天開盤(排除開盤鎖死);報酬扣同期加權;同檔同格 20 日去重。
 * ⭐ 六道關卡:全期正 ・前後半同向 ・逐年同向 ・去最好年 ・扣成本 0.44%
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const DIVP = process.env.DIV_JSON || path.join(DATA, 'dividends_hist.json');
const HOR = [20, 60, 120];
const COST = 0.44;
const DEDUP = 20;

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

const DIVJ = JSON.parse(fs.readFileSync(DIVP, 'utf8'));
const DIV = DIVJ.d || DIVJ;

const buckets = new Map();
const add = (k, ev) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ev); };
const slide = (arr, w, cmp) => {
  const out = new Array(arr.length).fill(null), q = [];
  for (let i = 0; i < arr.length; i++) {
    while (q.length && q[0] <= i - w) q.shift();
    const v = arr[i];
    if (v != null) { while (q.length && cmp(arr[q[q.length - 1]], v)) q.pop(); q.push(i); }
    out[i] = q.length ? arr[q[0]] : null;
  }
  return out;
};
const slideMax = (a, w) => slide(a, w, (x, y) => x <= y), slideMin = (a, w) => slide(a, w, (x, y) => x >= y);

const files = fs.readdirSync(DATA).filter(f => /^(\d{4,5}|00\d{2,3}[A-Z]?)\.json$/.test(f));
let nSym = 0, nBar = 0, nWithDiv = 0;
for (const f of files) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 400) continue;
  const sym = f.replace('.json', '');
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c: +r.close,
  })).filter(r => r.d);
  if (R.length < 400) continue;
  const N = R.length, C = R.map(r => r.c);

  // 💰 每一天「當時已知」的近 12 個月現金股利(⛔ 只算除息日 ≤ 今天的,零前視)
  //    ⚠️ 只算現金(排除「權」= 配股 —— 那不是拿到錢,是股數變多)
  const hs = ((DIV[sym] || {}).h || []).filter(x => x && x[2] !== '權' && +x[1] > 0)
    .map(x => [String(x[0]).slice(0, 10), +x[1]]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  if (hs.length) nWithDiv++;
  const ttm = new Array(N).fill(0);          // 近 12 個月已配現金(元/股)
  const exOn = new Array(N).fill(0);         // 那一天除息多少(算含息報酬用)
  {
    const dIdx = new Map(R.map((r, i) => [r.d, i]));
    // 除息日對到 K 線的哪一根(⚠️ 那天可能沒開盤 → 對到下一個交易日)
    for (const [d, v] of hs) {
      let i = dIdx.get(d);
      if (i == null) { i = R.findIndex(r => r.d >= d); if (i < 0) continue; }
      exOn[i] += v;
    }
    let s = 0, j = 0;
    for (let i = 0; i < N; i++) {
      s += exOn[i];
      const cut = new Date(Date.parse(R[i].d) - 365 * 864e5).toISOString().slice(0, 10);
      while (j <= i && R[j].d < cut) { s -= exOn[j]; j++; }
      ttm[i] = s;
    }
  }
  // 含息累積(把每天的現金股利當天再投入 → 用「調整因子」比逐筆再投入簡單且等價)
  const tr = new Array(N).fill(1);
  for (let i = 1; i < N; i++) {
    const gross = (C[i] + exOn[i]) / C[i - 1];
    tr[i] = tr[i - 1] * gross;
  }
  const trOpen = new Array(N).fill(1);      // 以開盤價進場那一刻的含息基準
  for (let i = 0; i < N; i++) trOpen[i] = tr[i] * (R[i].o / C[i]);

  nSym++; nBar += N;
  const hi250 = slideMax(C, 250), lo250 = slideMin(C, 250);
  const pos = C.map((c, i) => { const a = hi250[i], b = lo250[i]; return (i >= 250 && a > b) ? (c - b) / (a - b) * 100 : null; });

  const last = new Map();
  const emit = (key, i) => {
    const p = last.get(key); if (p != null && i - p < DEDUP) return;
    const e = i + 1; if (e >= N) return;
    const gap = (R[e].o / C[i] - 1) * 100;
    if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) return;
    const ret = { _d: R[e].d };
    for (const n of HOR) {
      const j = e + n;
      if (j >= N) { ret[n] = null; continue; }
      const m = mktRet(R[e].d, n);
      // 🚨 含息:用含息累積比值,⛔ 不可只用價格(除息會被記成跌)
      ret[n] = m == null ? null : (tr[j] / trOpen[e] - 1) * 100 - m;
      ret['px' + n] = m == null ? null : (C[j] / R[e].o - 1) * 100 - m;   // 對照:不含息
    }
    last.set(key, i);
    add(key, ret);
  };

  for (let i = 260; i < N - 1; i++) {
    const y = C[i] > 0 ? ttm[i] / C[i] * 100 : 0;
    emit('對照組(所有交易日)', i);
    const b = ttm[i] <= 0 ? '💰 沒配息(近12個月)'
      : y < 2 ? '💰 殖利率 0~2%' : y < 4 ? '💰 殖利率 2~4%'
      : y < 6 ? '💰 殖利率 4~6%' : y < 8 ? '💰 殖利率 6~8%' : '💰 殖利率 >8%';
    emit(b, i);
    if (y >= 4) {
      emit('⭐ 殖利率 ≥4%(全部)', i);
      if (pos[i] != null) emit(pos[i] >= 60 ? '⭐ 殖利率 ≥4% × 位階高(≥60)' : pos[i] <= 30 ? '⭐ 殖利率 ≥4% × 位階低(≤30)' : '⭐ 殖利率 ≥4% × 位階中', i);
    }
    if (y > 0 && y < 2) emit('➖ 殖利率 <2%(全部)', i);
    // 🆚 對照:本站實測最強的「追強」那一族(同一份母體、同一個窗口 → 兩者可比)
    if (pos[i] != null && pos[i] >= 75) emit('🔥 位階 ≥75(追強・對照用)', i);
    // ⭐⭐ 決定性的增量檢定:**在「位階高」的母體裡**,殖利率高低有沒有差?
    //    ⛔ 拿全市場比會量到「位階高」的功勞,不是「殖利率」的(共用那條腿的鐵則)
    if (pos[i] != null && pos[i] >= 60) {
      emit('🅰️ 位階 ≥60(下面兩格的對照組)', i);
      emit(ttm[i] > 0 && y >= 4 ? '🅰️ 位階 ≥60 × 殖利率 ≥4%' : '🅰️ 位階 ≥60 × 殖利率 <4%', i);
    }
  }
}

const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const base = buckets.get('對照組(所有交易日)') || [];
const bA = {}, bP = {}, bW = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null); bA[n] = avg(v); bW[n] = v.filter(x => x > 0).length / v.length * 100;
  const p = base.map(e => e['px' + n]).filter(x => x != null); bP[n] = avg(p);
}
console.log(`\n📊 樣本:${nSym} 檔(其中 ${nWithDiv} 檔有配息紀錄)・${nBar.toLocaleString()} 根 K ・對照組 ${base.length.toLocaleString()} 個事件`);
console.log('   對照組平均超額(含息):' + HOR.map(n => `${n}日 ${bA[n].toFixed(2)}%`).join(' ・'));
console.log('   對照組(不含息)      :' + HOR.map(n => `${n}日 ${bP[n].toFixed(2)}%`).join(' ・'));
console.log('   對照組勝率(含息)    :' + HOR.map(n => `${n}日 ${bW[n].toFixed(1)}%`).join(' ・'));
console.log('   ⚠️ 基準是負的(中位數個股跑輸市值加權指數)—— ⛔ 不是 0 也不是 50%\n');

const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組') || evs.length < 500) continue;
  const r = { k, n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null);
    const p = evs.map(e => e['px' + n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - bA[n] : null;
    r[`p${n}`] = p.length ? avg(p) - bP[n] : null;
    r[`w${n}`] = v.length ? v.filter(x => x > 0).length / v.length * 100 : null;
    r[`m${n}`] = v.length ? med(v) : null;
  }
  rows.push(r);
}
rows.sort((a, b) => (b.e60 ?? -99) - (a.e60 ?? -99));
const pad = (s, w) => String(s).padEnd(w, ' ');
const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
console.log('條件'.padEnd(34) + 'n'.padStart(9) + '  20日   60日  120日 |60日不含息|60日勝率  60日中位');
console.log('─'.repeat(100));
for (const r of rows) {
  console.log(pad(r.k, 34) + String(r.n).padStart(9) + '  '
    + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + ' |'
    + num(r.p60).padStart(8) + ' |'
    + (r.w60 == null ? '—' : r.w60.toFixed(1) + '%').padStart(7)
    + (r.m60 == null ? '—' : num(r.m60) + '%').padStart(10));
}

// ⭐⭐ 增量檢定:對照組換成「位階 ≥60」(⛔ 共用那條腿)
{
  const b = buckets.get('🅰️ 位階 ≥60(下面兩格的對照組)');
  if (b && b.length > 500) {
    const bb = {}; for (const n of HOR) { const v = b.map(e => e[n]).filter(x => x != null); bb[n] = avg(v); }
    console.log(`\n\n████ 增量檢定:對照組 = 位階 ≥60(n=${b.length.toLocaleString()};`
      + HOR.map(n => `${n}日 ${bb[n].toFixed(2)}%`).join(' ・') + ')████');
    // 🚨 ⛔ 結論**要現算**,⛔ 不可先寫好一句話 —— 第一版我先寫死「兩格都貼近 0」,
    //    實跑卻是 +0.97 / −0.36(有增量)→ 那就是在輸出裡放一份跟資料打架的第二份真相。
    const dAll = [];
    for (const k of ['🅰️ 位階 ≥60 × 殖利率 ≥4%', '🅰️ 位階 ≥60 × 殖利率 <4%']) {
      const e = buckets.get(k); if (!e) continue;
      const o = HOR.map(n => { const v = e.map(x => x[n]).filter(x => x != null); return num(avg(v) - bb[n]).padStart(7); });
      console.log(pad(k, 34) + String(e.length).padStart(9) + '  ' + o.join(' '));
      dAll.push({ k, e });
    }
    // 🚧 穩健性也要在**同一個母體裡**做(⛔ 拿全市場的前後半來判這一格 = 換了問題)
    const bAllD = b.map(x => x._d).sort();
    const bMID = bAllD[Math.floor(bAllD.length / 2)];
    const bYrs = [...new Set(bAllD.map(d => d.slice(0, 4)))].sort();
    console.log('   🚧 同母體穩健性(60 日):' + '前半/後半'.padStart(2) + '  |' + bYrs.map(y => y.slice(2).padStart(7)).join(''));
    for (const { k, e } of dAll) {
      const sub = f => { const v = e.filter(f).map(x => x[60]).filter(x => x != null); const bv = b.filter(f).map(x => x[60]).filter(x => x != null); return (v.length >= 30 && bv.length >= 30) ? avg(v) - avg(bv) : null; };
      const h1 = sub(x => x._d < bMID), h2 = sub(x => x._d >= bMID);
      const per = bYrs.map(y => sub(x => x._d.startsWith(y)));
      const bi = per.reduce((z, v, ix) => (v != null && (per[z] == null || v > per[z])) ? ix : z, 0);
      console.log('   ' + pad(k, 31) + num(h1).padStart(7) + num(h2).padStart(8) + '  |'
        + per.map(v => num(v).padStart(7)).join('') + ' | 去最好年' + num(sub(x => !x._d.startsWith(bYrs[bi]))).padStart(7));
    }
  }
}

const allD = base.map(e => e._d).filter(Boolean).sort();
const MID = allD[Math.floor(allD.length / 2)];
const yrs = [...new Set(allD.map(d => d.slice(0, 4)))].sort();
console.log(`\n\n████ 🚧 穩健性檢定(60 日含息)・樣本 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID} ████`);
console.log('條件'.padEnd(34) + '前半    後半  |' + yrs.map(y => y.slice(2).padStart(7)).join('') + ' | 去最好年  扣成本');
for (const r of rows) {
  const evs = buckets.get(r.k);
  const sub = f => { const v = evs.filter(f).map(e => e[60]).filter(x => x != null); const bv = base.filter(f).map(e => e[60]).filter(x => x != null); return (v.length >= 30 && bv.length >= 30) ? avg(v) - avg(bv) : null; };
  const h1 = sub(e => e._d < MID), h2 = sub(e => e._d >= MID);
  const per = yrs.map(y => sub(e => e._d.startsWith(y)));
  const bi = per.reduce((b, v, i) => (v != null && (per[b] == null || v > per[b])) ? i : b, 0);
  console.log(pad(r.k, 34) + num(h1).padStart(6) + num(h2).padStart(8) + '  |'
    + per.map(v => num(v).padStart(7)).join('') + ' |'
    + num(sub(e => !e._d.startsWith(yrs[bi]))).padStart(8) + num(r.e60 == null ? null : r.e60 - COST).padStart(9));
}
