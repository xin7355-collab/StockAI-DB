#!/usr/bin/env node
/**
 * 👩 投量比(投信單日淨買 ÷ 當日成交量)—— 只讀探針
 *
 * ❓ 為什麼**現在**才測得動:V71.9.5 做這張卡時 `trust_net` 只回溯到 2026/05,
 *    每桶不到 200 筆 → 當時**刻意只做單位換算、不下方向**(CLAUDE.md 有記)。
 *    2026-08-31 實測 `trust_net` 已有 **555 檔 ≥100 個非零日、最早 2023/06**
 *    → ⭐ 這是「等資料」等到的解鎖,不是新想法。
 *
 * ❓ 觸發:使用者上傳的 Gemini 籌碼文件主張
 *    「投信買超佔比 >10% 且持股率 0.5~3% = 低檔初升期,投信對中小型股有極強拉抬力」。
 *    ⛔ 「持股率」測不了(累計持股需要**起點**,cumsum 從 2023 開始不是真持股率)
 *       → 只測**佔比**那半,並誠實說另一半沒測。
 *
 * ⛔ 沿用鐵則:
 *    ・進場 = **隔天開盤**(法人買賣超收盤後才公布,用當天收盤 = 前視偏誤)
 *    ・排除隔天開盤漲停鎖死(買不到;2015-06 前 ±7%,lib_limit)
 *    ・報酬扣同期加權 ・同檔同桶 20 日去重
 *    ・對照組 = **同一天**、投信資料已知的可交易(股·日)全部(⛔ 不抽樣;🔁 V79.4.3 ⛔ 不再拿整段平均)
 *    ・六道關卡:全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 0.44% / 疊在 🧬 之上的增量
 *    ・格內對照(位階×波動×成交金額):投信本來就買大型股,不控就是在量「大型股」
 *
 * 🔁 V79.4.3(16 年全市場 d16 重跑前修好,陷阱 #50 / #52):
 *    ・對照組改**同一天**:每一筆事件(跟對照的每一個股·日)都先減掉「同一天、投信資料已知的可交易股·日」平均再比;
 *      那天不到 MIN_CTRL(30)檔 → 那天的事件不算(印出丟了幾筆)。勝率旁的「對照」= 同一批日子的對照勝率。
 *    ・`trust_net` 沒資料 = 不知道(⛔ 不當 0):舊寫法 `|| 0` 會把 d16 2010~2012 沒有法人欄的整段塞進「沒買沒賣」那一桶,
 *      而且整段平均會把那兩年算進對照 → 兩個一起修。
 *    ・隔天開盤鎖漲停 → lib_limit.lockedBar(2015-06 前 ±7%,⛔ 不再寫死 10%)。
 *    ・價格斷崖(×1.5 / ×0.67,lib_cliff):以前完全沒守 → 「位階 250 根 + 持有 20 天」碰到斷崖的股·日事件、對照一起不算(⛔ 不整檔剔除)。
 *
 * 用法:
 *   node scripts/trustvol_probe.mjs
 *   DATA_DIR=… MAX_SYMS=200 node scripts/trustvol_probe.mjs   # 試跑:等距抽 200 檔(⛔ 不取前 N 檔)
 *   node scripts/trustvol_probe.mjs --selftest   # 注入一個必然有效的假訊號 + 同一天對照 / 2012 ±7% / 斷崖 / 缺值四個決定性對照
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lockedBar } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const MAX_SYMS = +(process.env.MAX_SYMS || 0);   // 🔁 V79.4.3 試跑用:等距抽 N 檔(⛔ 不取前 N 檔 = 按產業取樣,V72.1.7);0 = 全部

const DEDUP = 20;
const COST = 0.44;
const MIN_N = 200;
const WARM = 250;          // 位階/波動要 250 根暖身
const MIN_CTRL = 30;       // 🔁 V79.4.3 同一天的對照組至少要這麼多檔,不夠 → 那天的事件不算(⛔ 不拿別天湊)
const CLIFF_LOOK = 249;    // 🔁 V79.4.3 斷崖窗口往回看到位階那 250 根
const FWD_MAX = 20;        // 最長持有天期(e20)

const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const sg = (x) => (x >= 0 ? '+' : '');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (a, q) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * q)]; };

function loadIndex() {
  const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '^TWII.json'), 'utf8'))
    .filter((r) => r && r.close != null);
  const m = new Map();
  rows.forEach((r) => m.set(String(r.date).replace(/\//g, '-'), +r.close));
  return m;
}

// ── 桶定義:投量比(%),⛔ 門檻不是我訂的,是文件講的 10% 附近前後各切幾層 ──
const BUCKETS = [
  ['投信賣超',        (r) => r < -0.1],
  ['沒買沒賣(±0.1%)', (r) => r >= -0.1 && r <= 0.1],
  ['買 0.1~1%',       (r) => r > 0.1 && r <= 1],
  ['買 1~3%',         (r) => r > 1 && r <= 3],
  ['買 3~5%',         (r) => r > 3 && r <= 5],
  ['買 5~10%',        (r) => r > 5 && r <= 10],
  ['⭐ 買 ≥10%(文件說的)', (r) => r > 10],
];

/**
 * 🔁 V79.4.3 一檔的對照組 / 事件(純函式,selftest 直接測;⛔ 不改判定,只是從 main 搬出來)。
 * 隔天開盤鎖漲停 / 窗口碰到斷崖 / 那天投信沒資料 → 這個股·日事件、對照一起不算(skip 分開數)。
 * 回 null = 這檔 K 線太短(不算進檔數)。
 */
function scanStock(rows, idxMap, dateIdx) {
  if (!Array.isArray(rows) || rows.length < WARM + 40) return null;
  const o = { d: [], c: [], h: [], l: [], op: [], v: [], t: [] };
  for (const r of rows) {
    if (!r || r.close == null) continue;
    o.d.push(String(r.date).replace(/\//g, '-'));
    o.c.push(+r.close); o.h.push(+r.high); o.l.push(+r.low);
    // 🔁 V79.4.3 投信沒資料 = 不知道(⛔ 不當 0 —— 舊寫法把沒有法人欄的整段塞進「沒買沒賣」那一桶)
    o.op.push(+r.open); o.v.push(+(r.volume || 0)); o.t.push(r.trust_net == null ? null : +r.trust_net);
  }
  const N = o.d.length;
  if (N < WARM + 40) return null;
  const out = { ctrl: [], ev: [], skip: { lim: 0, cliff: 0, unk: 0 } };
  const pre = cliffPrefix(o.c, o.op);
  const last = new Map();
  for (let i = WARM; i + 21 < N; i++) {
    const vol = o.v[i]; if (!(vol > 0)) continue;
    const c0 = o.c[i], op1 = o.op[i + 1];
    if (!(c0 > 0) || !(op1 > 0)) continue;
    // 🔁 V79.4.3 隔天開盤一價到底鎖漲停 → 買不到(lib_limit:2015-06 前 ±7%,⛔ 不再寫死 10%)
    if (lockedBar(o.d[i + 1], c0, op1, o.h[i + 1], o.l[i + 1]) === 1) { out.skip.lim++; continue; }
    // 🔁 V79.4.3 位階 250 根 + 持有 20 天碰到價格斷崖 → 這個股·日事件、對照一起不算(⛔ 不整檔剔除)
    if (cliffIn(pre, i - CLIFF_LOOK, i + FWD_MAX)) { out.skip.cliff++; continue; }
    // 🔁 V79.4.3 那天投信沒資料 → 不知道,事件、對照一起不算
    if (o.t[i] == null) { out.skip.unk++; continue; }
    const bi = idxMap.get(o.d[i + 1]), b10 = idxMap.get(o.d[i + 10]), b20 = idxMap.get(o.d[i + 20]);
    if (!bi || !b10) continue;
    const e10 = (o.c[i + 10] / op1 - 1) * 100 - (b10 / bi - 1) * 100;
    const e20 = b20 ? (o.c[i + 20] / op1 - 1) * 100 - (b20 / bi - 1) * 100 : null;
    if (!isFinite(e10)) continue;
    // 位階 / 波動 / 金額(格內對照與 🧬 都用得到)
    let mn = Infinity, mx = -Infinity;
    for (let k = i - 249; k <= i; k++) { const v = o.c[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const pos = mx > mn ? (c0 - mn) / (mx - mn) * 100 : 50;
    let sq = 0, sm = 0;
    for (let k = i - 19; k <= i; k++) { const r2 = Math.log(o.c[k] / o.c[k - 1]); sq += r2 * r2; sm += r2; }
    const vola = Math.sqrt(Math.max(0, sq / 20 - (sm / 20) ** 2)) * Math.sqrt(240) * 100;
    const amt = c0 * vol;
    const dnum = dateIdx.get(o.d[i]);
    if (dnum == null) continue;      // ⛔ 沒對到指數日期就不收(不然 dnum=-1 會混進前半段)
    const y = o.d[i].slice(0, 4);
    const rec = { e10, e20, y, dnum, pos, vola, amt };
    out.ctrl.push(rec);
    const ratio = o.t[i] / vol * 100;
    if (!isFinite(ratio)) continue;
    for (let b = 0; b < BUCKETS.length; b++) {
      if (!BUCKETS[b][1](ratio)) continue;
      const pv = last.get(b);
      if (pv != null && dnum - pv < DEDUP) break;
      last.set(b, dnum);
      out.ev.push({ ...rec, b });
      break;
    }
  }
  return out;
}

/**
 * 🔁 V79.4.3 同一天對照(陷阱 #50):每一筆(事件跟對照的每一個股·日)都先減掉「同一天、同一個母體」的平均 → a10 / a20;
 * 事件另外記 cw = 那一天對照組的贏大盤率。那天對照組不到 MIN_CTRL 檔 → 那天的事件、對照都不算(⛔ 不拿別天的平均湊)。
 */
function sameDay(ctrl, ev) {
  const by = new Map();                       // dnum → [n, Σe10, n20, Σe20, 贏大盤數]
  for (const e of ctrl) {
    let a = by.get(e.dnum);
    if (!a) { a = [0, 0, 0, 0, 0]; by.set(e.dnum, a); }
    a[0]++; a[1] += e.e10; if (e.e10 > 0) a[4]++;
    if (e.e20 != null) { a[2]++; a[3] += e.e20; }
  }
  const dayOf = (dn) => { const a = by.get(dn); return a && a[0] >= MIN_CTRL ? a : null; };
  const adj = (e, a) => { e.a10 = e.e10 - a[1] / a[0]; e.a20 = e.e20 != null && a[2] > 0 ? e.e20 - a[3] / a[2] : null; e.cw = a[4] / a[0] * 100; return e; };
  const ctl = [], ev2 = [];
  let dropped = 0;
  for (const e of ctrl) { const a = dayOf(e.dnum); if (a) ctl.push(adj(e, a)); }
  for (const e of ev) { const a = dayOf(e.dnum); if (a) ev2.push(adj(e, a)); else dropped++; }
  let okDays = 0;
  for (const a of by.values()) if (a[0] >= MIN_CTRL) okDays++;
  return { ctl, ev: ev2, dropped, days: by.size, okDays };
}

function main() {
  const idxMap = loadIndex();
  let files = fs.readdirSync(DATA_DIR).filter((f) => /^\d/.test(f) && f.endsWith('.json')).sort();
  if (MAX_SYMS > 0 && files.length > MAX_SYMS) {   // 🔁 V79.4.3 等距抽樣(⛔ 不取前 N 檔)
    const step = Math.max(1, Math.floor(files.length / MAX_SYMS));
    files = files.filter((_, k) => k % step === 0).slice(0, MAX_SYMS);
  }
  console.log(`📈 掃 ${files.length} 檔`);

  let ev = [];          // 所有事件 {b, e10, e20, y, dnum, pos, vola, amt, hq}
  let ctrl = [];        // 對照組 = 全部可交易、投信資料已知的(股·日)
  let nSym = 0, dateIdx = new Map(), allDates = [];
  const skip = { lim: 0, cliff: 0, unk: 0 };
  for (const d of idxMap.keys()) allDates.push(d);
  allDates.sort(); allDates.forEach((d, i) => dateIdx.set(d, i));

  for (const f of files) {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { continue; }
    const s = scanStock(rows, idxMap, dateIdx);
    if (!s) continue;
    nSym++;
    for (const e of s.ctrl) ctrl.push(e);
    for (const e of s.ev) ev.push(e);
    for (const k in skip) skip[k] += s.skip[k];
  }
  // 🔁 V79.4.3 同一天對照
  const sd = sameDay(ctrl, ev);
  ctrl = sd.ctl; ev = sd.ev;
  console.log(`📊 ${nSym} 檔 ・對照組 ${ctrl.length.toLocaleString()} 個(股·日) ・事件 ${ev.length.toLocaleString()} 筆\n`);
  console.log(`🔁 V79.4.3 剔除:隔天開盤鎖漲停(2015-06 前 ±7%)${skip.lim.toLocaleString()} ・窗口碰到斷崖 ${skip.cliff.toLocaleString()}`
    + ` ・投信沒資料(⛔ 不當 0)${skip.unk.toLocaleString()} 個股·日`);
  console.log(`   同一天對照:${sd.okDays.toLocaleString()} / ${sd.days.toLocaleString()} 天有 ≥${MIN_CTRL} 檔;對照不夠被丟掉的事件 ${sd.dropped.toLocaleString()} 筆\n`);
  if (!ctrl.length) { console.log('❌ 沒有任何一天的對照組夠 —— 資料不足,不下結論'); return []; }

  // 🧬 現行配置門檻(位階 ≥75、波動 ≥ 全樣本 P60)—— 增量檢定用
  const volaP60 = pct(ctrl.map((e) => e.vola), 0.6);
  const isHQ = (e) => e.pos >= 75 && e.vola >= volaP60;

  const c10 = mean(ctrl.map((e) => e.e10));
  const c20 = mean(ctrl.filter((e) => e.e20 != null).map((e) => e.e20));
  const cw = ctrl.filter((e) => e.e10 > 0).length / ctrl.length * 100;
  console.log(`🆚 對照組(整段平均只當描述):10日 ${nf(c10)}% ・20日 ${nf(c20)}% ・勝率 ${nf(cw, 1)}% ・🧬 波動 P60 = ${nf(volaP60, 1)}%`);
  console.log(`   (⛔ 基準不是 0% 也不是 50%;🔁 V79.4.3 下面每一個 pp 都是「同一天對照」,勝率旁的對照 = 同一批日子的對照勝率)\n`);

  // 🚨 中點必須從**實際樣本**推,⛔ 不可用整條日期軸的一半 ——
  //    `^TWII` 從 2021-08 起,但個股 K 線 2023-06 才有 + 250 根暖身
  //    → 用 allDates.length/2 的話所有事件都落在後半、前半永遠是 NaN,那一關等於沒作用。
  //    (V74.0.2 limitup_probe 已經犯過一次,這裡是第二次 —— 所以改成從樣本推。)
  const dn = ctrl.map((e) => e.dnum).sort((a, b) => a - b);
  const MID = dn[Math.floor(dn.length / 2)];
  const LO = dn[0], HI = dn[dn.length - 1] + 1;
  console.log(`🗓️ 實際樣本區間 ${allDates[LO]} ~ ${allDates[HI - 1]} ・中點 ${allDates[MID]}\n`);
  const years = [...new Set(ctrl.map((e) => e.y))].sort();

  // 格子切點(全對照組)
  const cP = [pct(ctrl.map((e) => e.pos), 1 / 3), pct(ctrl.map((e) => e.pos), 2 / 3)];
  const cV = [pct(ctrl.map((e) => e.vola), 1 / 3), pct(ctrl.map((e) => e.vola), 2 / 3)];
  const cA = [pct(ctrl.map((e) => e.amt), 1 / 3), pct(ctrl.map((e) => e.amt), 2 / 3)];
  const cellOf = (e) => `${e.pos > cP[1] ? 2 : e.pos > cP[0] ? 1 : 0}${e.vola > cV[1] ? 2 : e.vola > cV[0] ? 1 : 0}${e.amt > cA[1] ? 2 : e.amt > cA[0] ? 1 : 0}`;
  const byCell = new Map();
  for (const e of ctrl) { const k = cellOf(e); (byCell.get(k) || byCell.set(k, []).get(k)).push(e); }

  // 🔁 V79.4.3 對照組的 a10 已經減掉同一天平均 → 逐年 / 前後半 / 🧬 的對照平均先算一次(數學不變,⛔ 不必每桶重掃一遍)
  const cAgg = (pred) => { let s = 0, n = 0; for (const e of ctrl) if (pred(e)) { s += e.a10; n++; } return [s, n]; };
  const cHalf = [cAgg((e) => e.dnum >= LO && e.dnum < MID), cAgg((e) => e.dnum >= MID && e.dnum < HI)];
  const cYear = new Map();
  for (const e of ctrl) { let a = cYear.get(e.y); if (!a) { a = [0, 0]; cYear.set(e.y, a); } a[0] += e.a10; a[1]++; }
  const [cAllS, cAllN] = cAgg(() => true);
  const ca10 = cAllS / cAllN;
  const ca20 = mean(ctrl.filter((e) => e.a20 != null).map((e) => e.a20));
  const [chS, chN] = cAgg(isHQ);

  const out = [];
  for (let b = 0; b < BUCKETS.length; b++) {
    const g = ev.filter((e) => e.b === b);
    const name = BUCKETS[b][0];
    if (g.length < MIN_N) { console.log(`─ ${name}:n=${g.length} ⏳ 樣本不足`); continue; }
    // 🔁 V79.4.3 一律用 a10 / a20(= 減掉同一天平均)比;勝率仍是「贏大盤」,旁邊的對照 = 同一批日子的對照勝率
    const d10 = mean(g.map((e) => e.a10)) - ca10;
    const g20 = g.filter((e) => e.a20 != null);
    const d20 = mean(g20.map((e) => e.a20)) - ca20;
    const w = g.filter((e) => e.e10 > 0).length / g.length * 100;
    const cwm = mean(g.map((e) => e.cw));
    // 前後半(照日期切)
    const h = (lo, hi, c) => {
      const a = g.filter((e) => e.dnum >= lo && e.dnum < hi);
      return a.length > 60 && c[1] > 200 ? mean(a.map((e) => e.a10)) - c[0] / c[1] : NaN;
    };
    const q1 = h(LO, MID, cHalf[0]), q2 = h(MID, HI, cHalf[1]);
    // 逐年
    const yr = {};
    for (const y of years) {
      const a = g.filter((e) => e.y === y), c = cYear.get(y) || [0, 0];
      yr[y] = a.length > 40 && c[1] > 200 ? mean(a.map((e) => e.a10)) - c[0] / c[1] : NaN;
    }
    const yv = Object.values(yr).filter(isFinite);
    const bestY = Object.entries(yr).filter(([, v]) => isFinite(v)).sort((a, c) => c[1] - a[1])[0];
    const exBest = bestY ? (() => {
      const a = g.filter((e) => e.y !== bestY[0]), cy = cYear.get(bestY[0]) || [0, 0];
      return a.length > 40 ? mean(a.map((e) => e.a10)) - (cAllS - cy[0]) / (cAllN - cy[1]) : NaN;
    })() : NaN;
    // 格內
    let ws = 0, wn = 0, cells = 0;
    const gc = new Map();
    for (const e of g) { const k = cellOf(e); (gc.get(k) || gc.set(k, []).get(k)).push(e); }
    for (const [k, a] of gc) {
      const c = byCell.get(k);
      if (!c || a.length < 20 || c.length < 200) continue;
      ws += (mean(a.map((e) => e.a10)) - mean(c.map((e) => e.a10))) * a.length; wn += a.length; cells++;
    }
    const dCell = wn ? ws / wn : NaN;
    // 🧬 增量:同樣鎖在 🧬 之內比
    const gh = g.filter(isHQ);
    const dHQ = gh.length >= 100 && chN >= 200 ? mean(gh.map((e) => e.a10)) - chS / chN : NaN;

    console.log(`─ ${name}  n=${g.length.toLocaleString()}`);
    console.log(`   10日 ${sg(d10)}${nf(d10)}pp ・20日 ${sg(d20)}${nf(d20)}pp ・勝率 ${nf(w, 1)}%(對照 ${nf(cwm, 1)}%)`);
    console.log(`   前半 ${sg(q1)}${nf(q1)} / 後半 ${sg(q2)}${nf(q2)}${(q1 > 0) === (q2 > 0) ? '' : ' 🚨不同向'}`
      + ` ・逐年 ${Object.entries(yr).map(([y, v]) => `${y.slice(2)}:${sg(v)}${nf(v, 1)}`).join(' ')}`);
    console.log(`   去最好年(${bestY ? bestY[0] : '-'}) ${sg(exBest)}${nf(exBest)} ・扣成本 ${sg(d10 - COST)}${nf(d10 - COST)}`
      + ` ・格內(${cells}格/${wn}筆) ${sg(dCell)}${nf(dCell)} ・疊在🧬之上 ${sg(dHQ)}${nf(dHQ)}(n=${gh.length})`);
    const pass = d10 > 0 && (q1 > 0) === (q2 > 0) && yv.every((v) => v > 0) && exBest > 0
      && d10 - COST > 0 && dCell > COST;
    console.log(`   ${pass ? '✅ 六關全過' : '❌ 沒過'}\n`);
    out.push({ name, n: g.length, d10, d20, dCell, dHQ, pass, w, cw: cwm });
  }

  console.log('📌 判讀:每一行是「該桶」減「同一天所有可交易、投信資料已知的(股·日)」的 pp 差(🔁 V79.4.3 ⛔ 不再減整段平均)。');
  console.log(`   成立門檻:全期正 ・前後半同向 ・逐年全正 ・去最好年仍正 ・扣成本 ${COST}pp ・格內 > 成本。`);
  console.log('   ⚠️ 「投信持股率 0.5~3%」那半 ⛔ 測不了(累計持股需要起點,cumsum 不是持股率)。');
  return out;
}

// ── 🧪 selftest:注入「投信買超佔比 ≥10% 之後 10 日必漲」的假資料 ──────
// 決定性雜湊,⛔ 不用 Math.random(不然 selftest 不可重現)
// ⚠️ 第一版寫 `((a*2654435761 + b*40503)>>>0)/2**32` —— **那不是雜湊,是斜坡**:
//    固定 a、b 每 +1 只讓值增加 40503/2^32 ≈ 9.4e-6 → 一整段連續命中或整段都不命中,
//    於是「事件」全擠在一起、波動率也算成 0.1%。selftest 當場抓到(⛔ 不是程式錯,是測資錯)。
//    → 改用 murmur3 finalizer 真的把位元打散。
const H = (a, b) => {
  let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const weekdays = (y, m, d, n) => {        // 🔁 V79.4.3 selftest 用:從 y/m/d 起 n 個平日('YYYY-MM-DD')
  const out = [];
  for (let t = new Date(Date.UTC(y, m - 1, d)); out.length < n; t.setUTCDate(t.getUTCDate() + 1)) {
    if (t.getUTCDay() >= 1 && t.getUTCDay() <= 5) out.push(t.toISOString().slice(0, 10));
  }
  return out;
};

function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'tv-'));
  fs.mkdirSync(path.join(tmp, 'd'));
  const dir = path.join(tmp, 'd');
  const NBAR = 700, NSYM = 60;
  const dates = [];
  for (let d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(dir, '^TWII.json'),
    JSON.stringify(dates.map((dt) => ({ date: dt, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  for (let s = 0; s < NSYM; s++) {
    const sym = String(3000 + s), rows = [];
    const hit = new Set();
    for (let i = 0; i < NBAR; i++) if (H(s, i) < 0.02) hit.add(i);
    let c = 100;
    for (let i = 0; i < NBAR; i++) {
      // 命中日之後 10 天各漲 0.4%(= 訊號有效);其餘隨機遊走
      let up = (H(s + 77, i) - 0.5) * 2;
      for (let k = 1; k <= 10; k++) if (hit.has(i - k)) up += 0.4;
      c = Math.max(1, c * (1 + up / 100));
      const vol = 2_000_000;
      rows.push({
        date: dates[i], open: +c.toFixed(2), high: +(c * 1.01).toFixed(2),
        low: +(c * 0.99).toFixed(2), close: +c.toFixed(2), volume: vol,
        trust_net: hit.has(i) ? Math.round(vol * 0.15) : Math.round(vol * 0.001 * (H(s + 5, i) - 0.5)),
      });
    }
    fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
  }
  DATA_DIR = dir;
  console.log('🧪 --selftest:注入「投量比 ≥10% → 之後 10 日每天 +0.4%」,那一桶必須明顯領先。\n');
}

// 🔁 V79.4.3 合成一檔:drift(i) 每天漂移 + ±1% 雜訊;trust(i) 回 undefined = 那天欄位整個不寫(= d16 的「沒有資料」,⛔ 不是 0)
function synthRows(dates, seed, drift, trust, mut = null) {
  const rows = [];
  let c = 100;
  for (let i = 0; i < dates.length; i++) {
    c = c * (1 + drift(i) + (H(seed, i) - 0.5) * 0.02);
    const r = { date: dates[i].replace(/-/g, '/'), open: +c.toFixed(4), high: +(c * 1.01).toFixed(4), low: +(c * 0.99).toFixed(4), close: +c.toFixed(4), volume: 2_000_000 };
    const t = trust(i);
    if (t !== undefined) r.trust_net = t;
    rows.push(r);
  }
  if (mut) mut(rows);
  return rows;
}
const flatIdx = (dates) => {
  const idxMap = new Map(dates.map((d) => [d, 10000]));
  const dateIdx = new Map([...dates].sort().map((d, i) => [d, i]));
  return { idxMap, dateIdx };
};

// 🔁 V79.4.3 ⑩ 同一天對照(陷阱 #50)—— ⭐ 決定性對照:事件跟同一天的大家一模一樣 → 新算法 ≈ 0,三種舊算法都憑空量出一截
//    A 60 檔:前 350 根沒有投信欄、每天 +1%;350~529 有投信欄、每天 −0.2%(≥10% 那桶的事件只在這段);530 起 +0.6%
//    B 30 檔:350~579(跟 A 的事件同一批日子)投信欄缺、每天 +1% —— 缺值若被當 0,就會混進同一天的對照
function selftestSameDay(bad, ok) {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'tv-sd-'));
  try {
    const dates = weekdays(2011, 1, 3, 760);
    fs.writeFileSync(path.join(tmp, '^TWII.json'), JSON.stringify(dates.map((d) => ({ date: d.replace(/-/g, '/'), close: 10000 }))));
    const small = (s, i) => Math.round(2_000_000 * 0.001 * (H(s + 5, i) - 0.5));
    for (let s = 0; s < 60; s++) {
      const rows = synthRows(dates, 400 + s, (i) => (i < 350 ? 0.01 : i < 530 ? -0.002 : 0.006),
        (i) => (i < 350 ? undefined : (i < 530 && H(s + 900, i) < 0.08 ? 300_000 : small(s, i))));
      fs.writeFileSync(path.join(tmp, `${2000 + s}.json`), JSON.stringify(rows));
    }
    for (let s = 0; s < 30; s++) {
      const rows = synthRows(dates, 700 + s, (i) => (i < 580 ? 0.01 : 0.006), (i) => (i < 580 ? undefined : small(s + 60, i)));
      fs.writeFileSync(path.join(tmp, `${4000 + s}.json`), JSON.stringify(rows));
    }
    DATA_DIR = tmp;
    const idxMap = loadIndex();
    const dateIdx = new Map([...idxMap.keys()].sort().map((d, i) => [d, i]));
    const files = fs.readdirSync(tmp).filter((f) => /^\d/.test(f));
    const scanAll = (fill0) => {
      const ctrl = [], ev = [];
      for (const f of files) {
        let rows = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
        if (fill0) rows = rows.map((r) => ({ ...r, trust_net: r.trust_net == null ? 0 : r.trust_net }));   // 舊寫法:缺值當 0
        const s = scanStock(rows, idxMap, dateIdx);
        if (s) { ctrl.push(...s.ctrl); ev.push(...s.ev); }
      }
      return { ctrl, ev };
    };
    const NEW = scanAll(false), OLD = scanAll(true);
    const top = (evs) => evs.filter((e) => e.b === BUCKETS.length - 1);
    const oldWhole = mean(top(OLD.ev).map((e) => e.e10)) - mean(OLD.ctrl.map((e) => e.e10));
    const knownWhole = mean(top(NEW.ev).map((e) => e.e10)) - mean(NEW.ctrl.map((e) => e.e10));
    const sdOld = sameDay(OLD.ctrl, OLD.ev);
    const rowAll = mean(top(sdOld.ev).map((e) => e.a10)) - mean(sdOld.ctl.map((e) => e.a10));
    ok(`⑩ 決定性對照:缺值當 0 + 整段平均(舊)${nf(oldWhole)}pp、整段但只留已知 ${nf(knownWhole)}pp、同一天但缺值當 0 ${nf(rowAll)}pp(三個都 < −1)`,
      oldWhole < -1 && knownWhole < -1 && rowAll < -1, [oldWhole, knownWhole, rowAll]);
    const oldNoTrade = OLD.ev.filter((e) => e.b === 1 && e.dnum < 350).length;
    const newNoTrade = NEW.ev.filter((e) => e.b === 1 && e.dnum < 350).length;
    ok(`⑩ 缺值 ⛔ 當 0:沒有投信欄的那段,舊寫法塞了 ${oldNoTrade} 筆進「沒買沒賣」、新寫法 0 筆`, oldNoTrade > 50 && newNoTrade === 0, [oldNoTrade, newNoTrade]);
    let out;
    const log = console.log; console.log = () => {};
    try { out = main(); } finally { console.log = log; }
    const r = out.find((o) => o.name.includes('≥10%'));
    ok(`⑩ main() 用同一天、投信已知的對照 → ≥10% 那桶 ≈ 0(${r ? nf(r.d10) : '—'}pp,n=${r ? r.n : 0})`, r && Math.abs(r.d10) < 0.5 && r.n >= MIN_N, r);
    ok(`⑩b 勝率旁的「對照」= 同一批日子(事件 ${r ? nf(r.w, 1) : '—'}% vs 同日對照 ${r ? nf(r.cw, 1) : '—'}%)`, r && Math.abs(r.w - r.cw) < 10, r);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 🔁 V79.4.3 ⑪~⑬ 直接測 scanStock(2012 ±7% / 斷崖窗口 / 投信缺值)+ sameDay 的 MIN_CTRL
function selftestUnits(bad, ok) {
  const TOP = BUCKETS.length - 1;
  const hitAt = (set) => (i) => (set.includes(i) ? 300_000 : Math.round(2_000_000 * 0.001 * (H(31, i) - 0.5)));
  // ⑪ 2015-06 前漲跌幅 ±7%:2012 年隔天一價到底 +7% = 鎖漲停 → 買不到;同一根放到 2020 年(要 +10%)→ 買得到
  const lock = (y, m, d) => {
    const dates = weekdays(y, m, d, 400);
    const rows = synthRows(dates, 9, () => 0, hitAt([304]), (rs) => {
      const p = rs[304].close * 1.07;
      for (let k = 306; k < rs.length; k++) for (const f of ['open', 'high', 'low', 'close']) rs[k][f] = +(rs[k][f] * 1.07).toFixed(4);
      Object.assign(rs[305], { open: +p.toFixed(4), high: +p.toFixed(4), low: +p.toFixed(4), close: +p.toFixed(4) });
    });
    const { idxMap, dateIdx } = flatIdx(dates);
    const s = scanStock(rows, idxMap, dateIdx);
    return { d: dates[305], lim: s.skip.lim, top: s.ev.filter((e) => e.b === TOP).map((e) => e.dnum) };
  };
  const L12 = lock(2011, 1, 3), L20 = lock(2019, 1, 1);
  ok(`⑪ 2012 年(${L12.d})隔天鎖 +7% → 買不到、那筆不算;同一根在 2020 年(${L20.d})→ 照算`,
    L12.lim === 1 && L12.top.length === 0 && L20.lim === 0 && JSON.stringify(L20.top) === '[304]', [L12, L20]);
  // ⑫ 斷崖只剔碰到的窗口(⛔ 不整檔剔除):第 650 根起 ×1.6
  {
    const dates = weekdays(2016, 1, 4, 760);
    const rows = synthRows(dates, 11, () => 0, hitAt([304, 644]), (rs) => {
      for (let k = 650; k < rs.length; k++) for (const f of ['open', 'high', 'low', 'close']) rs[k][f] = +(rs[k][f] * 1.6).toFixed(4);
    });
    const { idxMap, dateIdx } = flatIdx(dates);
    const s = scanStock(rows, idxMap, dateIdx);
    const dn = s ? s.ctrl.map((e) => e.dnum) : [];
    const tops = s ? s.ev.filter((e) => e.b === TOP).map((e) => e.dnum) : [];
    ok('⑫ 有斷崖的股票 ⛔ 不整檔剔除:第 304 根的事件照算、持有會碰到斷崖的第 644 根不算',
      s && JSON.stringify(tops) === '[304]', tops);
    ok('⑫ 對照組也只剔碰到的窗口(第 250~629 根全留、630 根起全剔)',
      dn.length === 380 && Math.min(...dn) === 250 && Math.max(...dn) === 629 && s.skip.cliff === 109, [dn.length, Math.min(...dn), Math.max(...dn), s && s.skip]);
  }
  // ⑬ 投信沒資料 = 不知道(⛔ 不當 0):前 400 根沒有投信欄
  {
    const dates = weekdays(2016, 1, 4, 600);
    const rows = synthRows(dates, 13, () => 0, (i) => (i < 400 ? undefined : hitAt([])(i)));
    const { idxMap, dateIdx } = flatIdx(dates);
    const s = scanStock(rows, idxMap, dateIdx);
    const s0 = scanStock(rows.map((r) => ({ ...r, trust_net: r.trust_net == null ? 0 : r.trust_net })), idxMap, dateIdx);
    const early = (x) => x.ctrl.filter((e) => e.dnum < 400).length + x.ev.filter((e) => e.dnum < 400).length;
    ok(`⑬ 投信缺值 → 那 150 個股·日事件、對照都不算(缺值當 0 的話會收進 ${early(s0)} 筆)`,
      s.skip.unk === 150 && early(s) === 0 && early(s0) > 150, [s.skip, early(s), early(s0)]);
  }
  // ⑭ 同一天對照組不到 MIN_CTRL 檔 → 那天的事件不算(⛔ 拿別天湊)
  {
    const mk = (n, dnum) => Array.from({ length: n }, (_, k) => ({ e10: k % 3 - 1, e20: null, dnum }));
    const thin = sameDay(mk(MIN_CTRL - 1, 5), [{ e10: 3, e20: null, dnum: 5 }]);
    const enough = sameDay(mk(MIN_CTRL, 5), [{ e10: 3, e20: null, dnum: 5 }]);
    ok(`⑭ 那天只有 ${MIN_CTRL - 1} 檔 → 事件不算(數得出丟了 1 筆);${MIN_CTRL} 檔 → 照算`,
      thin.dropped === 1 && thin.ev.length === 0 && enough.dropped === 0 && enough.ev.length === 1, [thin.dropped, enough.dropped]);
  }
}

if (SELFTEST) {
  selftest();
  const out = main();
  const top = out.find((o) => o.name.includes('≥10%'));
  const bad = [];
  if (!top) bad.push('≥10% 那桶樣本不足,harness 收不到事件');
  else if (!(top.d10 > 2)) bad.push(`≥10% 那桶沒抓到注入的邊際(${nf(top.d10)}pp)`);
  else if (!top.pass) bad.push('注入的訊號應該六關全過,卻沒過');
  console.log('\n🧪 🔁 V79.4.3 決定性對照:');
  const ok = (name, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + JSON.stringify(x).slice(0, 240)}`); if (!c) bad.push(name); };
  selftestSameDay(bad, ok);
  selftestUnits(bad, ok);
  if (bad.length) { console.error('\n❌ SELFTEST 失敗:'); bad.forEach((b) => console.error('   - ' + b)); process.exit(1); }
  console.log('\n✅ TRUSTVOL_PROBE_SELFTEST_PASS');
} else {
  main();
}
