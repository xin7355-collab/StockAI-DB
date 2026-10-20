#!/usr/bin/env node
/**
 * 🧪 指標動物園:把「還沒測過、而且資料夠」的經典技術指標一次掃完(V74.5.8)
 *
 * 使用者給了一份完整的技術指標分類表。⭐ 先盤點:**一半以上本站已經有實測成績**
 * (`_SIGNAL_EDGE` 129 個 K 棒訊號 + `_SCR_EDGE` 96 個選股條件 + 28 種出場 + TD/WaveTrend)
 * → ⛔ 那些不重測。這支只掃**剩下的**,而且只收「純 OHLCV 算得出來」的。
 *
 * ⛔ 刻意不做(理由寫下來免得再問一次):
 *   ・ZigZag / 江恩 / 纏論 / 諧波型態 → 需要**未來資料確認轉折**或判定高度主觀 = 回測會有前視偏誤
 *   ・暗池 / VPIN / 另類數據 → 台股**沒有這些資料源**(逐筆委託簿與暗池不公開)
 *   ・KNN / SVM → `ml_probe.py` 已測(樣本外 AUC 0.522,輸給「位階≥75」一條 if)
 *   ・McClellan / 新高新低 → 那是**大盤層級**,測法不同(同 floorcount_probe),不混進個股事件表
 *
 * ⭐ 六道關卡 ・對照組 = 同一天進場的全部(股·日)・扣同期加權 ・10 日去重 ・進場=隔天開盤(排除鎖死)
 * ⚠️ 逐年/中點一律從實際樣本推(⛔ 不寫死)
 *
 * 🔁 V79.4.3(16 年全市場 d16 重跑前修三件):
 *   ① 對照組 = **同一天進場**的全部可比(股·日)平均(陷阱 #50)—— 舊版減的是「整段所有交易日」的平均:
 *      16 年裡各年「個股 vs 加權」的落差差很多,訊號集中在某幾年就會把「那幾年大家都比較好」算成訊號的功勞。
 *      同一天對照組 < MIN_CTRL(30)檔 → 那天的事件不算(印出幾筆)。對照組 ⛔ 不再 10 日去重(去重是事件的規則)。
 *      前後半照**日期**切(中點 = 對照組(股·日)的中位日期)、逐年 / 去最好年都用同一天對照後的超額。
 *   ② 隔天開盤一價到底鎖死 → 買不到,事件與對照組一起剔除(lib_limit.lockedBar;2015-06 前漲跌幅 ±7%,⛔ 不再寫死 9.7)。
 *   ③ 斷崖窗口(lib_cliff ×1.5 / ×0.67):訊號用到的回看(最長一年位階 252 根)到進場那天碰到 → 這一根不算;
 *      抱的期間碰到 → 那一個天期不算(⛔ 不整檔剔除;事件與對照組同一條)。
 *   MAX_SYMS=N 只等距抽 N 檔(冒煙測試用)・node scripts/indicator_zoo_probe.mjs --selftest(不需要真資料)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { signalsFor } from './lib_indicators.mjs';
import { lockedBar } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');   // V79.4.0:可指到 d16(16 年全市場)
const HOR = [1, 3, 5, 10, 20];
const NH = HOR.length, H10 = HOR.indexOf(10);
const COST = 0.44, DEDUP = 10;
const ONLY_GENE = process.env.GENE === '1';
export const MIN_CTRL = 30;          // 🔁 V79.4.3 同一天對照組至少幾檔
export const LOOK_CLIFF = 252;       // 🔁 V79.4.3 訊號用到的最長回看(一年位階)—— 這段碰到斷崖,訊號就是假的
export const CTRL_KEY = '對照組(所有交易日)';
const MAX_SYMS = Math.max(0, parseInt(process.env.MAX_SYMS || '0', 10) || 0);

// ── 大盤(扣同期加權)──
export function mkMarket(twiiRows) {
  const mkt = new Map(), mdays = [];
  for (const r of twiiRows) { if (!(r && r.close > 0)) continue;
    const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); mdays.push(d); } }
  mdays.sort();
  const mIdx = new Map(mdays.map((d, i) => [d, i]));
  const mktRet = (d, n) => { const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
    const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]); return a > 0 ? (b / a - 1) * 100 : null; };
  return { mdays, mIdx, mktRet };
}

// ── 累加器:事件與對照組都照「進場日」逐日累加(⭐ 同一天對照要等全市場掃完才知道 → 先存每天的和)──
export function newAcc(mk) {
  const L = mk.mdays.length * NH;
  return { mk, ND: mk.mdays.length, keys: new Map(),
    ctrl: { s: new Float64Array(L), c: new Int32Array(L), w: new Int32Array(L) },
    nSym: 0, nBar: 0, nLock: 0, nCliff: 0 };
}
function keyStore(acc, k) {
  let st = acc.keys.get(k);
  if (!st) { const L = acc.ND * NH;
    st = { s: new Float64Array(L), c: new Int32Array(L), w: new Int32Array(L), n: new Int32Array(acc.ND), noDate: 0 };
    acc.keys.set(k, st); }
  return st;
}

/**
 * 第 i 根出訊號、隔天(e = i+1)開盤進場的各天期超額報酬(扣同期加權)。
 * 'lock' = 隔天開盤一價到底鎖死(買不到)、'cliff' = 回看到進場那天碰到斷崖;否則回陣列(碰到斷崖 / 資料不夠的天期 = null)。
 */
export function retsAt(R, i, pre, mk) {
  const e = i + 1;
  if (e >= R.length) return null;
  if (lockedBar(R[e].d, R[i].c, R[e].o, R[e].h, R[e].l) !== 0) return 'lock';   // 🔁 V79.4.3 2015-06 前 ±7%(lib_limit)
  if (cliffIn(pre, i - LOOK_CLIFF, e)) return 'cliff';                              // 🔁 V79.4.3 回看 + 進場那根碰到斷崖
  const out = new Array(NH).fill(null);
  for (let h = 0; h < NH; h++) {
    const n = HOR[h], j = e + n;
    if (j >= R.length || cliffIn(pre, e, j)) continue;                              // 🔁 V79.4.3 抱的期間碰到斷崖 → 這個天期不算
    const m = mk.mktRet(R[e].d, n);
    out[h] = m == null ? null : (R[j].c / R[e].o - 1) * 100 - m;
  }
  return out;
}

function addTo(st, di, rr) {
  for (let h = 0; h < NH; h++) { const x = rr[h]; if (x == null) continue;
    const p = di * NH + h; st.s[p] += x; st.c[p]++; if (x > 0) st.w[p]++; }
}

/** 掃一檔:對照組 = 每一根可比的(股·日)(⛔ 不去重);事件 = 同檔同訊號 10 日去重(同舊版)。sigFn 只有 selftest 會換。 */
export function scanStock(R, acc, sigFn = signalsFor, onlyGene = ONLY_GENE) {
  const N = R.length;
  acc.nSym++; acc.nBar += N;
  const { hits, gene } = sigFn(R);
  const pre = cliffPrefix(R.map(r => r.c), R.map(r => r.o));
  const mk = acc.mk;
  for (const i of hits.get(CTRL_KEY) || []) {
    if (onlyGene && !gene[i]) continue;
    const rr = retsAt(R, i, pre, mk);
    if (rr === 'lock') { acc.nLock++; continue; }
    if (rr === 'cliff') { acc.nCliff++; continue; }
    if (!rr) continue;
    const di = mk.mIdx.get(R[i + 1].d); if (di == null) continue;
    addTo(acc.ctrl, di, rr);
  }
  for (const [key, idxs] of hits) {
    if (key === CTRL_KEY) continue;
    let last = null;
    for (const i of idxs) {
      if (onlyGene && !gene[i]) continue;
      if (last != null && i - last < DEDUP) continue;
      const rr = retsAt(R, i, pre, mk);
      if (!Array.isArray(rr)) continue;             // 鎖死 / 斷崖:跟舊版鎖死一樣不更新去重
      last = i;
      const st = keyStore(acc, key);
      const di = mk.mIdx.get(R[i + 1].d);
      if (di == null) { st.noDate++; continue; }
      st.n[di]++;
      addTo(st, di, rr);
    }
  }
}

/** 全市場掃完 → 每一筆減掉同一天對照組平均;同一天對照 < MIN_CTRL 檔的事件丟掉 */
export function summarize(acc) {
  const { ND, mk } = acc, C = acc.ctrl;
  const cm = new Float64Array(ND * NH).fill(NaN);
  for (let p = 0; p < ND * NH; p++) if (C.c[p] >= MIN_CTRL) cm[p] = C.s[p] / C.c[p];
  // 對照組(描述用):整體平均 / 勝率 / 期間 / 中點(⭐ 照日期,權重 = 每天的(股·日)數)/ 年份
  const ctrl = { n: 0, avg: {}, win: {} };
  for (let h = 0; h < NH; h++) { let s = 0, c = 0, w = 0;
    for (let d = 0; d < ND; d++) { const p = d * NH + h; s += C.s[p]; c += C.c[p]; w += C.w[p]; }
    ctrl.avg[HOR[h]] = c ? s / c : null; ctrl.win[HOR[h]] = c ? w / c * 100 : null; if (h === 0) ctrl.n = c; }
  let tot = 0; for (let d = 0; d < ND; d++) tot += C.c[d * NH];
  let acc2 = 0, MID = null, from = null, to = null; const yrs = new Set();
  for (let d = 0; d < ND; d++) { const c = C.c[d * NH]; if (!c) continue;
    if (from == null) from = mk.mdays[d]; to = mk.mdays[d]; yrs.add(mk.mdays[d].slice(0, 4));
    acc2 += c; if (MID == null && acc2 * 2 >= tot) MID = mk.mdays[d]; }
  const byKey = new Map(); let dropped = 0;
  for (const [k, st] of acc.keys) {
    const r = { k, n: 0, dropped: st.noDate, a10s: new Float64Array(ND), a10c: new Int32Array(ND) };
    const aS = new Float64Array(NH), aC = new Int32Array(NH), rS = new Float64Array(NH), rC = new Int32Array(NH), rW = new Int32Array(NH);
    for (let d = 0; d < ND; d++) {
      const ne = st.n[d]; if (!ne) continue;
      if (!(C.c[d * NH] >= MIN_CTRL)) { r.dropped += ne; continue; }     // 🔁 V79.4.3 那天對照組太少 → 不算
      r.n += ne;
      for (let h = 0; h < NH; h++) {
        const p = d * NH + h, c = st.c[p]; if (!c) continue;
        rS[h] += st.s[p]; rC[h] += c; rW[h] += st.w[p];
        if (Number.isNaN(cm[p])) continue;
        const a = st.s[p] - c * cm[p];
        aS[h] += a; aC[h] += c;
        if (h === H10) { r.a10s[d] = a; r.a10c[d] = c; }
      }
    }
    for (let h = 0; h < NH; h++) {
      r[`e${HOR[h]}`] = aC[h] ? aS[h] / aC[h] : null;
      r[`w${HOR[h]}`] = rC[h] ? rW[h] / rC[h] * 100 : null;
      r[`raw${HOR[h]}`] = rC[h] ? rS[h] / rC[h] : null;          // 沒減對照的原始超額(只給 selftest 對照舊算法用)
    }
    dropped += r.dropped;
    byKey.set(k, r);
  }
  return { byKey, ctrl, MID, from, to, YRS: [...yrs].sort(), dropped, mdays: mk.mdays };
}

/** 某個日期範圍內,同一天對照後的 10 日超額平均 + 筆數(前後半 / 逐年 / 去最好年共用) */
export function subAdj(S, r, f) {
  let s = 0, c = 0;
  for (let d = 0; d < r.a10c.length; d++) { if (!r.a10c[d] || !f(S.mdays[d])) continue; s += r.a10s[d]; c += r.a10c[d]; }
  return { avg: c ? s / c : null, n: c };
}

function main() {
  const mk = mkMarket(JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')));
  const acc = newAcc(mk);
  // ⭐ 指標公式全部住在 `scripts/lib_indicators.mjs`(逐檔探針也吃同一份)。
  // ⛔ 不可在這裡再寫一份公式（陷阱 #37）。
  let files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f)).sort();
  const nAll = files.length;
  if (MAX_SYMS && files.length > MAX_SYMS) files = Array.from({ length: MAX_SYMS }, (_, k) => files[Math.floor(k * nAll / MAX_SYMS)]);   // 等距抽樣(⛔ 不取前 N 檔)
  for (const f of files) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < 320) continue;
    const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
      d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
      o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 })).filter(r => r.d);
    if (R.length < 320) continue;
    scanStock(R, acc);
  }
  const S = summarize(acc);

  // ── 統計(同 streak_probe 的六道關卡)──
  const num = (v, d = 2) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
  console.log(`\n📊 樣本:${acc.nSym} 檔 ・${acc.nBar.toLocaleString()} 根 K ・對照組 ${S.ctrl.n.toLocaleString()} 個(股·日)${ONLY_GENE ? '  【🧬 增量檢定模式】' : ''}`
    + (files.length < nAll ? `  【⚠️ MAX_SYMS 等距抽樣 ${files.length}/${nAll} 檔,只給冒煙測試用】` : ''));
  console.log('   對照組平均超額:' + HOR.map(n => `${n}日 ${num(S.ctrl.avg[n])}%`).join(' ・'));
  console.log('   對照組勝率:' + HOR.map(n => `${n}日 ${S.ctrl.win[n] == null ? '—' : S.ctrl.win[n].toFixed(1)}%`).join(' ・'));
  console.log('   ⚠️ 基準本來就是負的 —— ⛔ 不是 0 也不是 50%');
  console.log(`   🔁 V79.4.3 下表的超額 = 每一筆減掉「同一天進場」的對照組平均(⛔ 不再減整段平均);同一天對照 < ${MIN_CTRL} 檔 → 丟掉 ${S.dropped.toLocaleString()} 筆`);
  console.log(`   🧱 隔天開盤鎖死剔除 ${acc.nLock.toLocaleString()} ・斷崖窗口(回看 ${LOOK_CLIFF} 根到進場)剔除 ${acc.nCliff.toLocaleString()} 個(股·日)\n`);

  const MIN_N = ONLY_GENE ? 120 : 300;
  const rows = [...S.byKey.values()].filter(r => r.n >= MIN_N);
  rows.sort((a, b) => (b.e10 ?? -99) - (a.e10 ?? -99));
  const pad = (s, w) => String(s).padEnd(w, ' ');
  console.log('事件'.padEnd(40) + ' n'.padStart(8) + '  1日     3日     5日    10日    20日  |10日勝率');
  console.log('─'.repeat(100));
  for (const r of rows) console.log(pad(r.k, 40) + String(r.n).padStart(8) + '  '
    + HOR.map(n => num(r[`e${n}`]).padStart(6)).join(' ') + '  |' + (r.w10 == null ? '—' : r.w10.toFixed(1) + '%').padStart(7));

  const MID = S.MID, YRS = S.YRS;
  const MINSUB = ONLY_GENE ? 30 : 60;
  console.log('\n\n████ 🚧 穩健性檢定(10 日;⭐ 要 > 成本 0.44pp)████');
  console.log(`   期間 ${S.from} ~ ${S.to} ・中點 ${MID}(照日期)・逐年 ${YRS.join('/')}`);
  console.log('\n事件'.padEnd(41) + '全期    前半    後半   |逐年(' + YRS.map(y => y.slice(2)).join('/') + ')   去最好年  扣成本');
  console.log('─'.repeat(112));
  const passed = [];
  for (const r of rows) {
    const h1 = subAdj(S, r, d => d < MID), h2 = subAdj(S, r, d => d >= MID);
    const e1 = h1.n >= MINSUB ? h1.avg : null, e2 = h2.n >= MINSUB ? h2.avg : null;
    const yr = {};
    for (const y of YRS) { const v = subAdj(S, r, d => d.startsWith(y)); yr[y] = v.n >= MINSUB ? v.avg : null; }
    const ys = Object.values(yr).filter(x => x != null);
    let exBest = null;
    if (ys.length >= 2) { const bestY = Object.entries(yr).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0][0];
      const v = subAdj(S, r, d => !d.startsWith(bestY));
      exBest = v.n >= MINSUB ? v.avg : null; }
    const same = e1 != null && e2 != null && Math.sign(e1) === Math.sign(e2);
    const ySame = ys.length >= 2 && ys.every(x => Math.sign(x) === Math.sign(ys[0]));
    const net = (r.e10 ?? 0) - COST;
    const all = net > 0 && same && ySame && (exBest ?? -9) > 0;
    if (all) passed.push(`${r.k}(扣成本 ${num(net)})`);
    console.log(pad(r.k, 41) + num(r.e10).padStart(6) + num(e1).padStart(8) + num(e2).padStart(8) + (same ? ' ✅' : ' ❌')
      + ' |' + YRS.map(y => num(yr[y], 1).padStart(6)).join('') + (ySame ? ' ✅' : ' ❌')
      + num(exBest).padStart(9) + num(net).padStart(8) + (all ? ' ⭐全過' : ''));
  }
  console.log(`\n⭐ 六關全過:${passed.length ? passed.join(' / ') : '(一個都沒有)'}`);
  console.log('(數字 = 相對「同一天進場的全部可比股票」的超額 pp;進場 = 隔天開盤,已排除開盤鎖死與斷崖窗口)\n');
}

// ═══ selftest(不需要真資料;每一條都有決定性對照)═══
function selftest() {
  const bad = [];
  const ok = (name, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + String(x).slice(0, 220)}`); if (!c) bad.push(name); };
  const days = [];
  for (let t = Date.UTC(2012, 0, 2); t <= Date.UTC(2021, 11, 31); t += 86400000) {
    const dd = new Date(t); if (dd.getUTCDay() % 6 !== 0) days.push(dd.toISOString().slice(0, 10)); }
  const at = d => days.findIndex(x => x >= d);
  const mk = mkMarket(days.map(d => ({ date: d, close: 100 })));          // 加權不動 → 超額 = 個股報酬
  // 2012~2016 每檔每天 +0.3%、2017~2021 −0.1%(全部股票一樣)
  const mkR = (bump = () => 0, mut = null) => { let p = 50; const R = [];
    for (let k = 0; k < days.length; k++) { p *= 1 + (days[k] < '2017-01-01' ? 0.003 : -0.001) + bump(k);
      R.push({ d: days[k], o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1000 }); }
    if (mut) mut(R); return R; };
  const N = days.length, CTRL_I = []; for (let i = 300; i <= N - 2; i++) CTRL_I.push(i);
  const fake = (ev = {}) => () => ({ hits: new Map([[CTRL_KEY, CTRL_I], ...Object.entries(ev)]), gene: new Array(N).fill(true) });

  // A:40 檔一模一樣的股票(① 同一天對照 / ⑥ 對照不去重)
  const accA = newAcc(mk);
  const E2017 = at('2017-01-01');
  const era1 = []; for (let i = 300; i < E2017 - 30; i += 25) era1.push(i);
  for (let s = 0; s < 40; s++) scanStock(mkR(), accA, fake(s === 0 ? { '🧪 只在前段': era1 } : {}), false);
  const SA = summarize(accA);
  // B:40 檔一樣的 + 4 檔特例(② 真優勢 / ③ 漲跌幅制度 / ④ 斷崖)
  const acc = newAcc(mk);
  for (let s = 0; s < 40; s++) scanStock(mkR(), acc, fake(), false);
  // 2000:進場後 10 天每天多 +0.5%(真的有優勢)
  const i0 = at('2019-03-01'), e0 = i0 + 1;
  scanStock(mkR(k => (k > e0 && k <= e0 + 10 ? 0.005 : 0)), acc, fake({ '🧪 真的有優勢': [i0] }), false);
  // 3000:2013 年隔天開盤一價到底 +7%(那時漲跌幅 ±7% → 鎖死買不到);3001:同一根放到 2020 年(±10%)→ 買得到
  const kL = at('2013-06-03'), kL2 = at('2020-06-01');          // 對照組從第 300 根(2013-02)起算
  const lockAt = k => R => { const p = R[k].c * 1.07; for (let q = k + 1; q < R.length; q++) for (const f of ['o', 'h', 'l', 'c']) R[q][f] *= 1.07;
    const r = R[k + 1]; r.o = r.h = r.l = r.c = p; };
  scanStock(mkR(() => 0, lockAt(kL)), acc, fake({ '🧪 鎖死2012': [kL] }), false);
  scanStock(mkR(() => 0, lockAt(kL2)), acc, fake({ '🧪 鎖死2020': [kL2] }), false);
  // 4000:2015 年減資恢復交易 ×1.6(斷崖)
  const kC = at('2015-06-01');
  scanStock(mkR(() => 0, R => { for (let q = kC; q < R.length; q++) for (const f of ['o', 'h', 'l', 'c']) R[q][f] *= 1.6; }), acc,
    fake({ '🧪 抱的期間碰到斷崖': [kC - 8], '🧪 回看碰到斷崖': [kC + 100, kC + 300] }), false);
  const S = summarize(acc);
  const K = k => S.byKey.get(k) || { n: 0 };
  const NS = 44;
  const ctrlCnt = i => acc.ctrl.c[mk.mIdx.get(days[i + 1]) * NH];

  // ① 同一天對照
  const r1 = SA.byKey.get('🧪 只在前段') || { n: 0 };
  ok('① 事件只在多頭那段、跟同一天的大家一模一樣 → 超額 ≈ 0(同一天比)', r1.n === era1.length && Math.abs(r1.e10) < 0.01, JSON.stringify({ n: r1.n, e10: r1.e10 }));
  const oldEdge = r1.raw10 - SA.ctrl.avg[10];
  ok('① 決定性對照:舊版(減整段對照平均)→ 憑空 > +1.5pp', oldEdge > 1.5, oldEdge);
  const r2 = K('🧪 真的有優勢');
  ok('② 真的多賺約 5% → 量到 +4.5~+5.5pp', r2.n === 1 && r2.e10 > 4.5 && r2.e10 < 5.5, r2.e10);
  const cA = accA.ctrl.c[mk.mIdx.get(days[at('2014-03-03') + 1]) * NH];
  ok('⑥ 對照組 ⛔ 不去重:一般日子每天 = 全部 40 檔(舊版 10 日去重只剩約 4 檔)', cA === 40, cA);
  // ② 漲跌幅制度
  ok('③ 2013 年(2015-06 前 ±7%)隔天開盤一價到底 +7% → 事件買不到、不算', K('🧪 鎖死2012').n === 0 && acc.nLock >= 1, JSON.stringify([K('🧪 鎖死2012').n, acc.nLock]));
  ok('③ 對照組那一天也少掉那一檔(⛔ 只剔事件不剔對照 = 兩邊不同規則)', ctrlCnt(kL) === NS - 1, ctrlCnt(kL));
  ok('③ 同一根放到 2020 年(±10%)→ 買得到、照算(事件與對照都在)', K('🧪 鎖死2020').n === 1 && ctrlCnt(kL2) === NS, JSON.stringify([K('🧪 鎖死2020').n, ctrlCnt(kL2)]));
  // ③ 斷崖窗口
  const st = acc.keys.get('🧪 抱的期間碰到斷崖'), dH = mk.mIdx.get(days[kC - 7]);
  ok('④ 抱的期間碰到斷崖:1/3/5 日照算、10/20 日那格不算', st && st.c[dH * NH + 2] === 1 && st.c[dH * NH + 3] === 0 && st.c[dH * NH + 4] === 0,
    st && Array.from(st.c.slice(dH * NH, dH * NH + NH)));
  ok('④ 回看 252 根內有斷崖 → 那一根不算;窗口外(300 根後)照算(⛔ 不整檔剔除)', K('🧪 回看碰到斷崖').n === 1, K('🧪 回看碰到斷崖').n);
  ok('④ 對照組同一條:斷崖後第 100 根那天少一檔、第 300 根照算', ctrlCnt(kC + 100) === NS - 1 && ctrlCnt(kC + 300) === NS,
    JSON.stringify([ctrlCnt(kC + 100), ctrlCnt(kC + 300)]));
  // ⑤ 同一天對照太少 → 丟掉
  const acc5 = newAcc(mk);
  for (let s = 0; s < 20; s++) scanStock(mkR(), acc5, fake(s === 0 ? { '🧪 對照太少': era1 } : {}), false);
  const S5 = summarize(acc5), r5 = S5.byKey.get('🧪 對照太少');
  ok(`⑤ 同一天對照組不到 ${MIN_CTRL} 檔 → 事件全部不算、而且有記下丟掉幾筆`, r5.n === 0 && r5.dropped === era1.length && S5.dropped === era1.length, JSON.stringify([r5.n, r5.dropped]));
  // 中點照日期
  ok('⑦ 前後半的中點是日期(對照組(股·日)的中位日期)', /^\d{4}-\d{2}-\d{2}$/.test(SA.MID) && SA.MID > '2016-06-01' && SA.MID < '2018-01-01', SA.MID);
  console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ selftest 全過'}`);
  return bad.length ? 1 : 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
else main();
