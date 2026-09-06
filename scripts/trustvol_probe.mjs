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
 *    ・排除隔天開盤漲停鎖死(買不到)
 *    ・報酬扣同期加權 ・同檔同桶 20 日去重
 *    ・對照組 = **同一批可交易的(股·日)全部**(⛔ 不抽樣)
 *    ・六道關卡:全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 0.44% / 疊在 🧬 之上的增量
 *    ・格內對照(位階×波動×成交金額):投信本來就買大型股,不控就是在量「大型股」
 *
 * 用法:
 *   node scripts/trustvol_probe.mjs
 *   node scripts/trustvol_probe.mjs --selftest   # 注入一個必然有效的假訊號,驗 harness
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const DEDUP = 20;
const COST = 0.44;
const MIN_N = 200;
const WARM = 250;          // 位階/波動要 250 根暖身

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

function main() {
  const idxMap = loadIndex();
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^\d/.test(f) && f.endsWith('.json'));
  console.log(`📈 掃 ${files.length} 檔`);

  const ev = [];        // 所有事件 {b, e10, e20, y, dnum, pos, vola, amt, hq}
  const ctrl = [];      // 對照組 = 全部可交易的(股·日)
  let nSym = 0, dateIdx = new Map(), allDates = [];
  for (const d of idxMap.keys()) allDates.push(d);
  allDates.sort(); allDates.forEach((d, i) => dateIdx.set(d, i));

  for (const f of files) {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < WARM + 40) continue;
    const o = { d: [], c: [], h: [], l: [], op: [], v: [], t: [] };
    for (const r of rows) {
      if (!r || r.close == null) continue;
      o.d.push(String(r.date).replace(/\//g, '-'));
      o.c.push(+r.close); o.h.push(+r.high); o.l.push(+r.low);
      o.op.push(+r.open); o.v.push(+(r.volume || 0)); o.t.push(+(r.trust_net || 0));
    }
    const N = o.d.length;
    if (N < WARM + 40) continue;
    nSym++;
    const last = new Map();
    for (let i = WARM; i + 21 < N; i++) {
      const vol = o.v[i]; if (!(vol > 0)) continue;
      const c0 = o.c[i], op1 = o.op[i + 1];
      if (!(c0 > 0) || !(op1 > 0)) continue;
      if (op1 >= c0 * 1.0995 && o.h[i + 1] === o.l[i + 1]) continue;   // 隔天開盤鎖死 → 買不到
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
      ctrl.push(rec);
      const ratio = o.t[i] / vol * 100;
      if (!isFinite(ratio)) continue;
      for (let b = 0; b < BUCKETS.length; b++) {
        if (!BUCKETS[b][1](ratio)) continue;
        const pv = last.get(b);
        if (pv != null && dnum - pv < DEDUP) break;
        last.set(b, dnum);
        ev.push({ ...rec, b });
        break;
      }
    }
  }
  console.log(`📊 ${nSym} 檔 ・對照組 ${ctrl.length.toLocaleString()} 個(股·日) ・事件 ${ev.length.toLocaleString()} 筆\n`);

  // 🧬 現行配置門檻(位階 ≥75、波動 ≥ 全樣本 P60)—— 增量檢定用
  const volaP60 = pct(ctrl.map((e) => e.vola), 0.6);
  const isHQ = (e) => e.pos >= 75 && e.vola >= volaP60;

  const c10 = mean(ctrl.map((e) => e.e10));
  const c20 = mean(ctrl.filter((e) => e.e20 != null).map((e) => e.e20));
  const cw = ctrl.filter((e) => e.e10 > 0).length / ctrl.length * 100;
  console.log(`🆚 對照組:10日 ${nf(c10)}% ・20日 ${nf(c20)}% ・勝率 ${nf(cw, 1)}% ・🧬 波動 P60 = ${nf(volaP60, 1)}%`);
  console.log(`   (⛔ 基準不是 0% 也不是 50%)\n`);

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

  const out = [];
  for (let b = 0; b < BUCKETS.length; b++) {
    const g = ev.filter((e) => e.b === b);
    const name = BUCKETS[b][0];
    if (g.length < MIN_N) { console.log(`─ ${name}:n=${g.length} ⏳ 樣本不足`); continue; }
    const d10 = mean(g.map((e) => e.e10)) - c10;
    const g20 = g.filter((e) => e.e20 != null);
    const d20 = mean(g20.map((e) => e.e20)) - c20;
    const w = g.filter((e) => e.e10 > 0).length / g.length * 100;
    // 前後半
    const h = (lo, hi) => {
      const a = g.filter((e) => e.dnum >= lo && e.dnum < hi), c = ctrl.filter((e) => e.dnum >= lo && e.dnum < hi);
      return a.length > 60 && c.length > 200 ? mean(a.map((e) => e.e10)) - mean(c.map((e) => e.e10)) : NaN;
    };
    const q1 = h(LO, MID), q2 = h(MID, HI);
    // 逐年
    const yr = {};
    for (const y of years) {
      const a = g.filter((e) => e.y === y), c = ctrl.filter((e) => e.y === y);
      yr[y] = a.length > 40 && c.length > 200 ? mean(a.map((e) => e.e10)) - mean(c.map((e) => e.e10)) : NaN;
    }
    const yv = Object.values(yr).filter(isFinite);
    const bestY = Object.entries(yr).filter(([, v]) => isFinite(v)).sort((a, c) => c[1] - a[1])[0];
    const exBest = bestY ? (() => {
      const a = g.filter((e) => e.y !== bestY[0]), c = ctrl.filter((e) => e.y !== bestY[0]);
      return a.length > 40 ? mean(a.map((e) => e.e10)) - mean(c.map((e) => e.e10)) : NaN;
    })() : NaN;
    // 格內
    let ws = 0, wn = 0, cells = 0;
    const gc = new Map();
    for (const e of g) { const k = cellOf(e); (gc.get(k) || gc.set(k, []).get(k)).push(e); }
    for (const [k, a] of gc) {
      const c = byCell.get(k);
      if (!c || a.length < 20 || c.length < 200) continue;
      ws += (mean(a.map((e) => e.e10)) - mean(c.map((e) => e.e10))) * a.length; wn += a.length; cells++;
    }
    const dCell = wn ? ws / wn : NaN;
    // 🧬 增量:同樣鎖在 🧬 之內比
    const gh = g.filter(isHQ), ch = ctrl.filter(isHQ);
    const dHQ = gh.length >= 100 && ch.length >= 200 ? mean(gh.map((e) => e.e10)) - mean(ch.map((e) => e.e10)) : NaN;

    console.log(`─ ${name}  n=${g.length.toLocaleString()}`);
    console.log(`   10日 ${sg(d10)}${nf(d10)}pp ・20日 ${sg(d20)}${nf(d20)}pp ・勝率 ${nf(w, 1)}%(對照 ${nf(cw, 1)}%)`);
    console.log(`   前半 ${sg(q1)}${nf(q1)} / 後半 ${sg(q2)}${nf(q2)}${(q1 > 0) === (q2 > 0) ? '' : ' 🚨不同向'}`
      + ` ・逐年 ${Object.entries(yr).map(([y, v]) => `${y.slice(2)}:${sg(v)}${nf(v, 1)}`).join(' ')}`);
    console.log(`   去最好年(${bestY ? bestY[0] : '-'}) ${sg(exBest)}${nf(exBest)} ・扣成本 ${sg(d10 - COST)}${nf(d10 - COST)}`
      + ` ・格內(${cells}格/${wn}筆) ${sg(dCell)}${nf(dCell)} ・疊在🧬之上 ${sg(dHQ)}${nf(dHQ)}(n=${gh.length})`);
    const pass = d10 > 0 && (q1 > 0) === (q2 > 0) && yv.every((v) => v > 0) && exBest > 0
      && d10 - COST > 0 && dCell > COST;
    console.log(`   ${pass ? '✅ 六關全過' : '❌ 沒過'}\n`);
    out.push({ name, n: g.length, d10, d20, dCell, dHQ, pass });
  }

  console.log('📌 判讀:每一行是「該桶」減「所有可交易(股·日)」的 pp 差。');
  console.log(`   成立門檻:全期正 ・前後半同向 ・逐年全正 ・去最好年仍正 ・扣成本 ${COST}pp ・格內 > 成本。`);
  console.log('   ⚠️ 「投信持股率 0.5~3%」那半 ⛔ 測不了(累計持股需要起點,cumsum 不是持股率)。');
  return out;
}

// ── 🧪 selftest:注入「投信買超佔比 ≥10% 之後 10 日必漲」的假資料 ──────
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

if (SELFTEST) {
  selftest();
  const out = main();
  const top = out.find((o) => o.name.includes('≥10%'));
  const bad = [];
  if (!top) bad.push('≥10% 那桶樣本不足,harness 收不到事件');
  else if (!(top.d10 > 2)) bad.push(`≥10% 那桶沒抓到注入的邊際(${nf(top.d10)}pp)`);
  else if (!top.pass) bad.push('注入的訊號應該六關全過,卻沒過');
  if (bad.length) { console.error('\n❌ SELFTEST 失敗:'); bad.forEach((b) => console.error('   - ' + b)); process.exit(1); }
  console.log('\n✅ TRUSTVOL_PROBE_SELFTEST_PASS');
} else {
  main();
}
