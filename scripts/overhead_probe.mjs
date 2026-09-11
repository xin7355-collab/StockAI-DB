#!/usr/bin/env node
/**
 * 🪤 上方套牢區(overhead supply)有沒有預測力(V76.0.6)
 *
 * 使用者(拿國巨 2327 問):「都說散戶的資金都卡在 800 左右…大約開高到 800 左右就要跑,
 *   這個資料怎麼看到的,**可以做為我的來回操作依據嗎**?」
 *
 * ⭐ 要回答的是**兩個不同的問題**(⛔ 別混為一談):
 *   ① 事實:撞到那道牆之後,**穿得過去嗎**?(穿過去 / 被壓回 / 卡在裡面)
 *   ② 交易:知道那道牆,**賺得到錢嗎**?(扣同期加權 + 六道關卡 + 扣成本 0.44%)
 *   ⚠️ ①成立不代表②成立 —— 這正是 `_trappedRatio`(V72.4.5)那次的結論型態。
 *
 * 🚨 判定邏輯搬自 `index.html:_overheadSupply`(V71.8.7,當初就是為了回答國巨這題才寫的)。
 *    ⛔ **改了那支就要重跑這支**(同 `_SIGNAL_EDGE` 鐵則),否則卡片上的成績會對不上。
 *
 * ⭐ 主對照組 = **撞進小層**(⛔ 不是全市場、也不是「沒漲的日子」):
 *    兩組都「漲上去而且真的碰到一道牆」,差別**只有牆的大小** → 才分得出是「牆」還是「上漲」本身。
 *    另附兩個次要對照:漲 2% 但沒撞到 / 位階交叉(⛔ 高位階的功勞不可算給套牢層)。
 *
 * 🚨 零前視:第 i 根的套牢層只用 data[i-WIN .. i-1],基準價用**昨收**;
 *    進場一律**隔天開盤**並排除開盤鎖死;報酬扣同期加權;同檔同桶 DEDUP=20。
 *
 * 跑法:
 *   node scripts/overhead_probe.mjs --selftest        # ⭐ 先跑這個
 *   LIMIT=150 node scripts/overhead_probe.mjs         # 快速迭代
 *   DATA_DIR=/tmp/deepdata node scripts/overhead_probe.mjs        # 正式(含 2022 空頭)
 *   WIN=60 / WIN=250 …                                # 窗口敏感度
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const LIMIT = +(process.env.LIMIT || 0);
const SELFTEST = process.argv.includes('--selftest');
const LOOKAHEAD = process.argv.includes('--inject-lookahead');   // 🧪 注入用:故意打開前視
const COST = 0.44;
const DEDUP = 20;
const HOR = [5, 10, 20];
const WIN = +(process.env.WIN || 120);      // 套牢層回看窗口(index.html 用 120)
const NB = 40;                              // 價格分 40 格(同 _overheadSupply)
// 🚨 STEP 必須是 1:selftest 用 2 的時候,300 檔注入只收到 74 筆 —— **被壓回的事件天生只在牆上待 1~2 根**,
//    隔根取樣會把它們整批漏掉 → 真實資料的「被壓回率」會被系統性低估。⛔ 別為了跑快改回 2。
const STEP = 1;
const SENS = [1.0, 1.5, 2.0, 2.5, 3.0];     // MIN_SHARE 門檻敏感度(%),2.0 = 現行

const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const med = a => { const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
const f = (v, d = 2) => v == null || !Number.isFinite(v) ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(d);
const pad = (s, w) => String(s).padEnd(w, ' ');

// ═══ 判定邏輯(搬自 index.html:_overheadSupply,⛔ 改那邊要同步)═══
//  回傳:由近到遠最多 3 層 {lo, hi, mid, pct, dist}
//  ⭐ buckets 只算一次,所有 MIN_SHARE 門檻共用(⛔ 否則敏感度掃描要跑 5 遍)
function buildBuckets(win) {
  const w2 = [];
  for (const b of win) if (b.c > 0 && b.v > 0) w2.push(b);
  if (w2.length < 40) return null;
  let mn = Infinity, mx = -Infinity;
  for (const b of w2) { const p = (b.h + b.l + b.c) / 3; if (p < mn) mn = p; if (p > mx) mx = p; }
  if (!(mx > mn)) return null;
  const w = (mx - mn) / NB, bk = new Float64Array(NB);
  for (const b of w2) bk[Math.min(NB - 1, Math.floor(((b.h + b.l + b.c) / 3 - mn) / w))] += b.v;
  let tot = 0; for (let i = 0; i < NB; i++) tot += bk[i];
  return tot > 0 ? { mn, w, bk, tot } : null;
}
function layersFrom(B, pC, minShare) {
  if (!B) return [];
  const hot = [];
  for (let i = 0; i < NB; i++) {
    const lo = B.mn + i * B.w;
    if (lo <= pC * 1.01) continue;                      // 只看現價上方(留 1% 緩衝)
    if (B.bk[i] / B.tot >= minShare) hot.push({ i, lo, hi: lo + B.w, v: B.bk[i] });
  }
  if (!hot.length) return [];
  const L = [];
  for (const b of hot) {                                 // 相鄰併層(最多容忍隔 1 格)
    const t = L[L.length - 1];
    if (t && b.i - t.iEnd <= 2) { t.hi = b.hi; t.v += b.v; t.iEnd = b.i; }
    else L.push({ lo: b.lo, hi: b.hi, v: b.v, iEnd: b.i });
  }
  return L.map(x => ({ lo: x.lo, hi: x.hi, mid: (x.lo + x.hi) / 2, pct: x.v / B.tot * 100 }))
          .sort((a, b) => a.lo - b.lo).slice(0, 3);
}

// ═══ 資料 ═══
function loadTwii(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8')).filter(r => r && +r.close > 0);
  const mkt = new Map(), md = [];
  for (const r of raw) { const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); md.push(d); } }
  md.sort();
  const mi = new Map(md.map((d, i) => [d, i]));
  return (d, n) => { const i = mi.get(d); if (i == null || i + n >= md.length) return null; const a = mkt.get(md[i]), b = mkt.get(md[i + n]); return a > 0 ? (b / a - 1) * 100 : null; };
}
// 🚧 斷崖守門:相鄰兩根比值 >1.4 或 <0.6 **且日曆間隔 ≤10 天**才算(⛔ 只看比值會把「資料有大洞」誤殺)
const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function hasCliff(R) {
  for (let i = 1; i < R.length; i++) {
    const r = R[i].c / R[i - 1].c;
    if ((r > 1.4 || r < 0.6) && dayGap(R[i - 1].d, R[i].d) <= 10) return true;
  }
  return false;
}
function loadBars(dir) {
  let files = fs.readdirSync(dir).filter(x => /^\d{4,5}\.json$/.test(x)).sort();
  if (LIMIT) files = files.slice(0, LIMIT);
  const out = [];
  for (const fn of files) {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < WIN + 160) continue;
    const R = rows.filter(r => r && +r.close > 0 && +r.open > 0).map(r => ({
      d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
      o: +r.open, h: +r.high || +r.close, l: +r.low || +r.close, c: +r.close, v: +r.volume || 0,
    })).filter(r => r.d);
    if (R.length < WIN + 160 || hasCliff(R)) continue;
    out.push([fn.replace('.json', ''), R]);
  }
  return out;
}

// ═══ 掃描 ═══
function scan(syms, mktRet, minShare) {
  const buckets = new Map();                 // key -> events
  const through = new Map();                 // key -> {穿過去, 被壓回, 卡在裡面}
  const add = (k, e) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(e); };
  const bump = (k, w) => { if (!through.has(k)) through.set(k, { 穿過去: 0, 被壓回: 0, 卡在裡面: 0 }); through.get(k)[w]++; };
  for (const [sym, R] of syms) {
    const last = new Map();
    for (let i = WIN + 2; i < R.length - 21; i += STEP) {
      const c = R[i].c, pc = R[i - 1].c;
      if (!(c > 0 && pc > 0)) continue;
      // 🚨 零前視:層只用 i-WIN..i-1,基準價用昨收
      //   🧪 --inject-lookahead 故意把**未來 20 根**也算進去(典型的前視 bug)——
      //      拿它問「這支偵測得出來嗎」(⛔「沒報錯」不等於「有能力報錯」)。
      const B = buildBuckets(LOOKAHEAD ? R.slice(i - WIN + 20, i + 20) : R.slice(i - WIN, i));
      const L = layersFrom(B, pc, minShare);
      if (!L.length) continue;
      const z = L[0], rose = (c - pc) / pc * 100;
      let key = null, hit = false;
      if (c >= z.lo && pc < z.lo) { hit = true; key = z.pct >= 8 ? '🧱 撞進大層(≥8%)' : z.pct >= 4 ? '🧱 撞進中層(4~8%)' : '🧱 撞進小層(2~4%)'; }
      else if (c > z.hi && pc <= z.hi) key = z.pct >= 8 ? '🚀 站上大層' : '🚀 站上小中層';
      else if (rose >= 2) key = '➖ 對照:漲2%但沒撞到';
      else continue;
      if ((i - (last.get(key) ?? -999)) < DEDUP) continue;
      last.set(key, i);
      // 進場 = 隔天開盤,⛔ 排除開盤鎖死
      const e = i + 1;
      const gap = (R[e].o / c - 1) * 100;
      if (Math.abs(gap) >= 9.7 && Math.abs(R[e].h - R[e].l) < 1e-9) continue;
      const ev = { _d: R[e].d, _s: sym, _p: z.pct };
      // 位階(近 250 日)
      const w0 = Math.max(0, i - 249);
      let hi = -Infinity, lo = Infinity;
      for (let q = w0; q <= i; q++) { if (R[q].c > hi) hi = R[q].c; if (R[q].c < lo) lo = R[q].c; }
      ev._rank = hi > lo ? (c - lo) / (hi - lo) * 100 : 50;
      for (const n of HOR) {
        const j = e + n;
        if (j >= R.length) { ev[n] = null; continue; }
        const m = mktRet(R[e].d, n);
        ev[n] = m == null ? null : (R[j].c / R[e].o - 1) * 100 - m;
      }
      add(key, ev);
      // ① 事實:20 日內先穿過去還是先被壓回
      if (hit) {
        let w = '卡在裡面';
        for (let j = i + 1; j <= Math.min(i + 20, R.length - 1); j++) {
          if (R[j].c > z.hi) { w = '穿過去'; break; }
          if (R[j].c < z.lo * 0.97) { w = '被壓回'; break; }
        }
        bump(key, w);
      }
    }
  }
  return { buckets, through };
}

// ═══ 六道關卡 ═══
function gateRow(evs, base, MID, YRS) {
  const sub = (a, fn, n = 10) => a.filter(fn).map(e => e[n]).filter(x => x != null);
  const bS = (fn, n = 10) => { const v = sub(base, fn, n); return v.length >= 50 ? avg(v) : null; };
  const r = { n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null), b = base.map(e => e[n]).filter(x => x != null);
    r['e' + n] = v.length && b.length ? avg(v) - avg(b) : null;
    if (n === 10) { r.w = v.length ? v.filter(x => x > 0).length / v.length * 100 : null; r.med = v.length ? med(v) - med(b) : null; }
  }
  const h1 = sub(evs, e => e._d < MID), h2 = sub(evs, e => e._d >= MID);
  r.h1 = h1.length >= 50 ? avg(h1) - bS(e => e._d < MID) : null;
  r.h2 = h2.length >= 50 ? avg(h2) - bS(e => e._d >= MID) : null;
  r.yr = {};
  for (const y of YRS) {
    const v = sub(evs, e => e._d.startsWith(y)), bv = bS(e => e._d.startsWith(y));
    if (v.length >= 50 && bv != null) r.yr[y] = avg(v) - bv;
  }
  const ys = Object.values(r.yr);
  r.ySame = ys.length >= 2 && ys.every(x => Math.sign(x) === Math.sign(ys[0]));
  if (ys.length >= 2) {
    const bestY = Object.entries(r.yr).sort((a, b) => b[1] - a[1])[0][0];
    const v = sub(evs, e => !e._d.startsWith(bestY)), bv = bS(e => !e._d.startsWith(bestY));
    r.exBest = v.length >= 50 && bv != null ? avg(v) - bv : null;
  }
  r.same = r.h1 != null && r.h2 != null && Math.sign(r.h1) === Math.sign(r.h2);
  r.net = (r.e10 ?? 0) - COST;
  r.pass = r.net > 0 && r.same && r.ySame && (r.exBest ?? -9) > 0;
  return r;
}

// ═══ 🧪 selftest:記憶體合成,⛔ 放在讀真實資料之前 ═══
function synth(edge) {
  // ⭐ 四個踩過的坑(⛔ 全部是「測資錯,不是程式錯」—— 寫下來免得下次又來一遍):
  //   ① 牆**必須落在 WIN 日的回看窗口內**(第一版堆在最前面 300 天,窗口早就滑過去了)。
  //   ② 下坡要**線性** —— 指數衰減會在低檔堆出一個假的層,把真正的牆擠掉。
  //   ③ 牆**必須夠寬** —— 只有一格(≈1 元)的話,爬升一天就同時跨過 lo 跟 hi,永遠判成「穿過去」。
  //   ④ 🚨 **一檔只准往上走一次** —— 用「多循環」版時,堆牆那段自己在牆裡亂跳,
  //      每隔幾根就觸發一次「撞進」,而那些事件跟注入無關 → 有注入/沒注入量起來一模一樣。
  //   ⚠️ 而且懲罰要**大過上坡**,否則注進去等於沒注(上坡 +1.5%/天 → 用 −3%)。
  //   → 現在的形狀:前 150 根**單調下跌**把量堆成 125~152 的寬牆 → 再跌到 100 → 之後一路爬上去撞它。
  const days = [];
  { const d0 = new Date('2021-01-04'); for (let i = 0; i < 560; i++) { const d = new Date(d0.getTime() + i * 86400000); if (d.getDay() % 6) days.push(d.toISOString().slice(0, 10)); } }
  const N = days.length;
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const twii = days.map(d => ({ date: d, close: 15000 }));
  const rowsBy = {};
  for (let s = 0; s < 300; s++) {
    const W_LO = 120 + 10 * rnd();              // 每檔的牆高度略不同(⛔ 別讓 300 檔完全一樣)
    const RATE = 1.013 + 0.004 * rnd();         // 上坡速度
    const rows = []; let c = W_LO * 1.6, pen = 0;
    for (let i = 0; i < N; i++) {
      let v = 1e6;
      if (i < 150) { c = W_LO * 1.6 - (W_LO * 0.6) * i / 149; v = 8e6; }   // ① 單調下跌 + 大量 = 堆牆
      else if (i < 200) { c = W_LO - (W_LO - 100) * (i - 149) / 50; }      // ② 繼續跌到 100
      else {                                                               // ③ 爬回去撞牆(唯一一次向上)
        c *= RATE;
        if (pen > 0) { c *= (1 - edge / 100); pen--; }
        else if (c >= W_LO) pen = 1e9;   // ⭐ 一觸發就到底 → **一檔剛好一個事件**
                                         //    (pen=20 時跌完又爬回去再撞一次,那些重複事件會把邊際稀釋掉)
      }
      c = Math.max(1, c);
      rows.push({ date: days[i], open: c * 0.999, high: c * 1.006, low: c * 0.994, close: c, volume: v });
    }
    rowsBy['S' + s] = rows;
  }
  return { twii, rowsBy };
}

function toSyms(rowsBy) {
  return Object.entries(rowsBy).map(([k, rows]) => [k, rows.map(r => ({ d: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }))]);
}

// 🧪 selftest:**同一套合成資料跑兩次**(有注入懲罰 / 沒注入),相減看 harness 量不量得到。
//   ⭐ 這樣寫的好處:⛔ 不依賴「合成資料剛好落在大層還是中層」——
//      第一版就是栽在這裡(小牆組的低檔盤整反而堆出一個假的層,`撞進小層` 掛零 → 整支停擺)。
function runSelftest() {
  // ⚠️ 懲罰必須**大過上坡**才會真的被壓回:③ 每天爬 +1.1%,所以 −0.3% 根本擋不住
  //    (第一版就是這樣:報酬那條斷言過了、被壓回率卻一動也不動 = 注入沒真的注進去)。
  const EDGE = 3.0;               // 上坡 +1.5%/天 → 淨 −1.5%/天,一觸發就到底 → 一定跌破 lo×0.97
  const mk = e => {
    const { twii, rowsBy } = synth(e);
    const mkt = new Map(twii.map(r => [r.date, r.close]));
    const md = twii.map(r => r.date), mi = new Map(md.map((d, i) => [d, i]));
    const mr = (d, n) => { const i = mi.get(d); return i == null || i + n >= md.length ? null : (mkt.get(md[i + n]) / mkt.get(md[i]) - 1) * 100; };
    return scan(toSyms(rowsBy), mr, 0.02);
  };
  console.log('🧪 --selftest:合成 300 檔 —— 前 150 根單調下跌把量堆成一道寬牆,再跌到 100,之後一路爬上去撞它。');
  console.log(`   注入:撞到牆之後每天 −${EDGE}%(蓋得過 +1.5% 的上坡)。**同一套資料跑兩次**(有注入 / 沒注入)相減。`);
  console.log('   ⚠️ 門檻是**推導**的(⛔ 不憑感覺):10 日視野吃得到前 10 天 → 沒注入 1.015^10 ≈ +16%、\n      有注入 0.985^10 ≈ −14% → **理論差 ≈ −30pp**;而淨 −1.5%/天 × 20 ≈ −26% → **一定被壓回**。\n');
  const A = mk(EDGE), B = mk(0);
  const pick = m => { for (const k of ['🧱 撞進大層(≥8%)', '🧱 撞進中層(4~8%)', '🧱 撞進小層(2~4%)']) { const v = m.get(k); if (v && v.length >= 50) return [k, v]; } return [null, []]; };
  const [kA, evA] = pick(A.buckets), [, evB] = pick(B.buckets);
  const a = evA.map(e => e[10]).filter(x => x != null), b = evB.map(e => e[10]).filter(x => x != null);
  const tA = kA ? A.through.get(kA) : null, tB = kA ? B.through.get(kA) : null;
  const rej = t => t ? t.被壓回 / (t.穿過去 + t.被壓回 + t.卡在裡面) * 100 : null;
  console.log(`   事件桶 ${kA || '(找不到)'} ・有注入 n=${a.length} ・沒注入 n=${b.length}`);
  if (a.length && b.length) console.log(`   10 日平均:有注入 ${f(avg(a))}pp ・沒注入 ${f(avg(b))}pp ・差 ${f(avg(a) - avg(b))}pp`);
  console.log(`   被壓回率:有注入 ${rej(tA) == null ? '—' : rej(tA).toFixed(1) + '%'} ・沒注入 ${rej(tB) == null ? '—' : rej(tB).toFixed(1) + '%'}`);
  const bad = [];
  if (!kA) bad.push('三個層級都收不到 ≥50 筆事件 —— harness 根本沒看到牆');
  else {
    const d = avg(a) - avg(b);
    if (!(d < -15)) bad.push(`沒量到注入的懲罰(差 ${f(d)}pp,理論 ≈ −30)`);
    // ⚠️ ⛔ 不斷言「兩次事件數要相近」—— 注入的就是「撞到就被壓回」,
    //    那本來就會讓價格待在牆上的時間變短、事件變少。要守的是「兩邊都夠比」。
    if (!(a.length >= 50 && b.length >= 50)) bad.push(`兩邊要各有 ≥50 筆才比得下去(${a.length} / ${b.length})`);
    if (!(rej(tA) > rej(tB) + 5)) bad.push(`注入的是「撞到就跌」,被壓回率應該明顯上升(${f(rej(tA), 1)}% vs ${f(rej(tB), 1)}%)`);
  }
  if (bad.length) { console.log('\n❌ SELFTEST 失敗:'); bad.forEach(x => console.log('   - ' + x)); return 1; }
  console.log('\n✅ OVERHEAD_PROBE_SELFTEST_PASS(harness 量得到已知邊際)');
  return 0;
}

function main() {
  let syms, mktRet;
  if (SELFTEST) return runSelftest();
  {
    mktRet = loadTwii(DATA);
    syms = loadBars(DATA);
    console.log(`📂 ${DATA} ・${syms.length} 檔 ・窗口回看 ${WIN} 日 ・每 ${STEP} 根掃一次 ・DEDUP=${DEDUP}`);
    if (LOOKAHEAD) console.log('🧪 --inject-lookahead:**故意打開前視**(用今天收盤算層)—— 邊際應該憑空變大\n');
  }

  const MAIN = 2.0;   // 現行 _overheadSupply 的 MIN_SHARE
  const { buckets, through } = scan(syms, mktRet, MAIN / 100);
  const base = buckets.get('🧱 撞進小層(2~4%)') || [];
  const ctl2 = buckets.get('➖ 對照:漲2%但沒撞到') || [];
  if (base.length < 50) { console.log('❌ 樣本不足(撞進小層 < 50),⛔ 不下結論'); return 1; }

  const allD = [...buckets.values()].flat().map(e => e._d).filter(Boolean).sort();
  const MID = allD[Math.floor(allD.length / 2)];
  const YRS = [...new Set(allD.map(d => d.slice(0, 4)))].sort();

  // ── ① 事實:穿得過去嗎 ──
  console.log('\n████ ① 事實:撞到那道牆之後 20 日內,先穿過去還是先被壓回 ████\n');
  console.log(pad('層的大小', 22) + 'n'.padStart(8) + '穿過去'.padStart(10) + '被壓回'.padStart(10) + '卡在裡面'.padStart(10));
  console.log('─'.repeat(62));
  for (const k of ['🧱 撞進小層(2~4%)', '🧱 撞進中層(4~8%)', '🧱 撞進大層(≥8%)']) {
    const t = through.get(k); if (!t) continue;
    const n = t.穿過去 + t.被壓回 + t.卡在裡面; if (!n) continue;
    console.log(pad(k, 22) + String(n).padStart(8) + (t.穿過去 / n * 100).toFixed(1).padStart(9) + '%'
      + (t.被壓回 / n * 100).toFixed(1).padStart(9) + '%' + (t.卡在裡面 / n * 100).toFixed(1).padStart(9) + '%');
  }

  // ── ② 交易:賺得到錢嗎 ──
  console.log(`\n\n████ ② 交易:扣同期加權的超額報酬 + 六道關卡 ████`);
  console.log(`   樣本 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID} ・逐年涵蓋 ${YRS.join('/')}`);
  const BEAR = YRS.filter(y => ['2022', '2018', '2015', '2008'].includes(y));
  console.log(`   → ${BEAR.length ? `✅ 窗口含空頭年 ${BEAR.join('/')}` : '⚠️ 窗口裡**沒有空頭年**,逐年那一關的說服力有限'}`);
  console.log(`   ⭐ 主對照組 = **撞進小層**(兩組都真的碰到牆,差別只有牆的大小)`);
  console.log(`   ⚠️ 基準本來就是負的(中位數個股跑輸市值加權)—— ⛔ 不是 0 也不是 50%\n`);
  const b10 = base.map(e => e[10]).filter(x => x != null);
  console.log(`   撞進小層(基準)平均 ${f(avg(b10))}pp ・中位 ${f(med(b10))}pp ・贏大盤 ${(b10.filter(x => x > 0).length / b10.length * 100).toFixed(1)}%\n`);
  console.log(pad('事件', 24) + 'n'.padStart(7) + '5日'.padStart(8) + '10日'.padStart(8) + '20日'.padStart(8)
    + '中位'.padStart(8) + ' |前半'.padStart(8) + '後半'.padStart(8) + '  逐年' + ' '.repeat(Math.max(1, YRS.length * 6 - 4)) + '去最好年'.padStart(9) + '扣成本'.padStart(8));
  console.log('─'.repeat(120));
  const rows = [];
  for (const [k, evs] of buckets) {
    if (k === '🧱 撞進小層(2~4%)' || evs.length < 50) continue;
    const r = gateRow(evs, base, MID, YRS); r.k = k; rows.push(r);
    console.log(pad(k, 24) + String(r.n).padStart(7) + f(r.e5).padStart(8) + f(r.e10).padStart(8) + f(r.e20).padStart(8)
      + f(r.med).padStart(8) + ' |' + f(r.h1).padStart(7) + f(r.h2).padStart(8) + (r.same ? '✅' : '❌')
      + ' ' + YRS.map(y => f(r.yr[y], 1).padStart(6)).join('') + (r.ySame ? '✅' : '❌')
      + f(r.exBest).padStart(8) + f(r.net).padStart(8) + (r.pass ? ' ⭐全過' : ''));
  }
  console.log(`\n(數字 = 相對「撞進小層」的超額 pp ・進場=隔天開盤(排除鎖死)・扣同期加權)`);
  console.log(`(⭐ 扣成本 ${COST}% 後仍為正,且前後半同向 + 逐年同向 + 去最好年為正,才算過關)`);

  // ── ③ 位階交叉(⛔ 高位階的功勞不可算給套牢層)──
  console.log('\n\n████ ③ 位階交叉:同位階裡「撞進大層」還有沒有增量 ████\n');
  console.log(pad('格', 30) + 'n'.padStart(8) + '10日邊際'.padStart(12) + '扣成本'.padStart(10));
  console.log('─'.repeat(62));
  for (const [nm, lo, hi] of [['高位階(≥75)', 75, 101], ['中位階(40~75)', 40, 75], ['低位階(<40)', -1, 40]]) {
    const ev = (buckets.get('🧱 撞進大層(≥8%)') || []).filter(e => e._rank >= lo && e._rank < hi).map(e => e[10]).filter(x => x != null);
    const bs = base.filter(e => e._rank >= lo && e._rank < hi).map(e => e[10]).filter(x => x != null);
    if (ev.length < 50 || bs.length < 50) { console.log(pad('大層 × ' + nm, 30) + String(ev.length).padStart(8) + '   樣本不足'); continue; }
    const d = avg(ev) - avg(bs);
    console.log(pad('大層 × ' + nm, 30) + String(ev.length).padStart(8) + f(d).padStart(12) + f(d - COST).padStart(10) + (d - COST > 0 ? ' ✅' : ' ❌'));
  }

  // ── ④ 門檻敏感度:一片高原還是一根孤峰 ──
  console.log('\n\n████ ④ 門檻敏感度(MIN_SHARE 左右各挪兩格;現行 = 2.0%)████\n');
  console.log(pad('門檻', 12) + 'n(大層)'.padStart(10) + '10日邊際'.padStart(12) + '扣成本'.padStart(10) + '  被壓回率' + '  判定');
  console.log('─'.repeat(70));
  const sens = {};
  for (const ms of SENS) {
    const s = ms === MAIN ? { buckets, through } : scan(syms, mktRet, ms / 100);
    const bb = s.buckets.get('🧱 撞進小層(2~4%)') || [], ee = s.buckets.get('🧱 撞進大層(≥8%)') || [];
    const ev = ee.map(e => e[10]).filter(x => x != null), bs = bb.map(e => e[10]).filter(x => x != null);
    const t = s.through.get('🧱 撞進大層(≥8%)');
    const rej = t ? t.被壓回 / (t.穿過去 + t.被壓回 + t.卡在裡面) * 100 : null;
    if (ev.length < 50 || bs.length < 50) { console.log(pad(ms.toFixed(1) + '%', 12) + String(ev.length).padStart(10) + '   樣本不足'); continue; }
    const d = avg(ev) - avg(bs); sens[ms] = d;
    console.log(pad(ms.toFixed(1) + '%', 12) + String(ev.length).padStart(10) + f(d).padStart(12) + f(d - COST).padStart(10)
      + (rej == null ? '     —' : rej.toFixed(1).padStart(9) + '%') + (d - COST > 0 ? '  ✅' : '  ❌'));
  }
  const vals = Object.values(sens);
  if (vals.length) {
    const nOk = vals.filter(v => v - COST > 0).length;
    console.log(`\n   ④ 判定:${vals.length} 格裡有 ${nOk} 格扣成本後為正 → ` +
      (nOk === vals.length ? '✅ 一片高原' : nOk === 0 ? '❌ 每一格都沒過 = 根本沒有山' : nOk <= 2 ? '🚨 **孤峰**,⛔ 不可採用' : '⚠️ 半高原,證據不足'));
  }

  // ── ⑤ 次要對照:漲 2% 但沒撞到 ──
  if (ctl2.length >= 50) {
    const a = (buckets.get('🧱 撞進大層(≥8%)') || []).map(e => e[10]).filter(x => x != null);
    const c = ctl2.map(e => e[10]).filter(x => x != null);
    console.log(`\n\n████ ⑤ 次要對照:「撞進大層」vs「漲2%但沒撞到」████`);
    console.log(`   撞進大層 n=${a.length} 平均 ${f(avg(a))}pp ・中位 ${f(med(a))}pp`);
    console.log(`   沒撞到   n=${c.length} 平均 ${f(avg(c))}pp ・中位 ${f(med(c))}pp`);
    console.log(`   → 差 ${f(avg(a) - avg(c))}pp(⚠️ 這組有**距離**的干擾:沒撞到代表牆比較遠,只當旁證)`);
  }

  return 0;
}
process.exit(main());
