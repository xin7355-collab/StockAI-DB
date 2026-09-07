#!/usr/bin/env node
/**
 * 🔗 事件鏈探針:「籌碼進駐 → 帶量突破」串起來有沒有比「帶量突破」單獨有用?
 *
 * 使用者提的「事件鏈狀態機」(利多發布 → 籌碼進駐 → 技術面帶量突破)是一個**預測性主張**,
 * 照本站鐵則要先回測再談要不要做成功能。三個階段裡:
 *   ・「利多發布」⛔ 現在測不了 —— news_hist.json 只累積 8 天;外部鉅亨網那份(評估紀錄⑰)
 *      已測過:新聞**方向**兩端同號(利多 +0.60 / 利空 +0.32)= 活躍度不是方向。
 *   ・「籌碼進駐 → 帶量突破」**測得動** —— foreign_net/trust_net 3 年、K 線 2021 起。
 *
 * 對照組鐵則:必須共用「帶量突破」那條腿 —— 拿全市場當對照量到的是突破本身,不是「籌碼先來」的功勞。
 *   A = 帶量突破(全部)       B = 突破前 10 天內有籌碼進駐(鏈)   C = 突破前沒有(B 的補集)
 *   D = 突破當天法人才大買(同步,不是先行)   E = 籌碼進駐但 10 天內沒突破(故事停在第 2 階段)
 * 進場一律隔天開盤(排除開盤鎖死)、扣同期加權、同檔同組 10 日去重。
 * 分層:成交額三分位 × 振幅三分位 → 回答「依股本/波動度動態調整」有沒有依據。
 *
 * 用法:node scripts/chain_probe.mjs            (真實 data/)
 *       node scripts/chain_probe.mjs --selftest  (合成資料:籌碼先行必須被量出 +邊際)
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELF = process.argv.includes('--selftest');
const COST = 0.44;

function loadRows(p) {
  try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(d) ? d : (d.data || d.records || []); }
  catch { return null; }
}
const iso = s => String(s).replace(/\//g, '-');

// ── 大盤(超額用)
function loadTwii() {
  const r = loadRows(path.join(DATA, '^TWII.json')) || [];
  const m = new Map(); for (const x of r) if (x.close > 0) m.set(iso(x.date), +x.close);
  return m;
}

// ── 每檔:找事件
function scan(sym, rows, twii, acc) {
  const n = rows.length; if (n < 300) return;
  const D = rows.map(r => iso(r.date)), O = rows.map(r => +r.open || 0), H = rows.map(r => +r.high || 0),
        C = rows.map(r => +r.close || 0), V = rows.map(r => +r.volume || 0),
        FN = rows.map(r => (+r.foreign_net || 0) + (+r.trust_net || 0));
  const hasChip = FN.some(x => x !== 0); if (!hasChip) return;
  // 籌碼進駐:5 日法人淨買 ≥ 5 日量的 2%(以股為單位,兩邊同單位)
  const chipIn = new Array(n).fill(false);
  for (let i = 5; i < n; i++) {
    let s = 0, v = 0; for (let k = i - 5; k < i; k++) { s += FN[k]; v += V[k]; }
    chipIn[i] = v > 0 && s / v >= 0.02;
  }
  const amt20 = i => { let s = 0; for (let k = i - 20; k < i; k++) s += C[k] * V[k]; return s / 20; };
  const amp20 = i => { let s = 0; for (let k = i - 20; k < i; k++) s += C[k - 1] > 0 ? (H[k] - rows[k].low) / C[k - 1] : 0; return s / 20 * 100; };
  // 先把每一天的「帶量突破」算出來(e2only 要看「之後 10 天有沒有突破」)
  const isBrk = new Array(n).fill(false);
  for (let i = 21; i < n; i++) {
    if (C[i] <= 0 || V[i] <= 0) continue;
    let hh = 0, av = 0; for (let k = i - 20; k < i; k++) { if (H[k] > hh) hh = H[k]; av += V[k]; } av /= 20;
    isBrk[i] = C[i] > hh && V[i] >= 2 * av && C[i] * V[i] >= 1e7;
  }
  let lastBrk = -99, lastE2 = -99;                            // ⛔ 兩組各自去重(共用會讓第 2 階段吃掉突破)
  for (let i = 260; i < n - 22; i++) {
    if (C[i] <= 0 || V[i] <= 0) continue;
    // 🚧 只收「這一檔在前 60 天內真的有法人資料」的日子 —— 否則 2022 那段(foreign_net 全 0)
    //    會全部落進「沒有籌碼先行」那一組,把 C 組灌成假的對照(V72.1.6:欄位存在 ≠ 有資料)
    let anyChip = false; for (let k = i - 60; k < i; k++) if (FN[k] !== 0) { anyChip = true; break; }
    if (!anyChip) continue;
    const brk = isBrk[i];
    // 籌碼先行:突破前 1~10 天內任一天 chipIn 成立
    let pre = false; for (let k = i - 10; k < i; k++) if (chipIn[k]) { pre = true; break; }
    const same = V[i] > 0 && FN[i] / V[i] >= 0.02;         // 突破當天才大買
    // 只有第 2 階段:今天籌碼進駐,而且前後 10 天都沒有帶量突破
    let nearBrk = false; for (let k = i - 10; k <= i + 10; k++) if (isBrk[k]) { nearBrk = true; break; }
    const e2only = chipIn[i] && !nearBrk;
    if (!brk && !e2only) continue;
    if (brk && i - lastBrk < 10) continue;                    // 同檔同組 10 日去重
    if (e2only && i - lastE2 < 10) continue;
    // 進場 = 隔天開盤;開盤鎖死(開盤=最高且跳空 ≥9%)排除
    const o1 = O[i + 1]; if (!(o1 > 0)) continue;
    if (o1 >= H[i + 1] && o1 >= C[i] * 1.09) continue;
    const t0 = twii.get(D[i + 1]), t10 = twii.get(D[i + 11]), t20 = twii.get(D[i + 21]);
    if (!(t0 > 0 && t10 > 0 && t20 > 0)) continue;
    const r10 = (C[i + 11] / o1 - 1) * 100 - (t10 / t0 - 1) * 100;
    const r20 = (C[i + 21] / o1 - 1) * 100 - (t20 / t0 - 1) * 100;
    if (brk) lastBrk = i; else lastE2 = i;
    acc.push({ sym, d: D[i], yr: D[i].slice(0, 4), brk, pre, same, e2only, r10, r20,
               amt: amt20(i), amp: amp20(i) });
  }
}

// ── 統計
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const win = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
const f = (x, d = 2) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '  —  ';

function report(name, ev, ctrl, midDate) {
  const r10 = ev.map(e => e.r10), r20 = ev.map(e => e.r20);
  const c10 = mean(ctrl.map(e => e.r10)), c20 = mean(ctrl.map(e => e.r20));
  const m10 = mean(r10) - c10, m20 = mean(r20) - c20;
  const fh = ev.filter(e => e.d < midDate), sh = ev.filter(e => e.d >= midDate);
  const cf = ctrl.filter(e => e.d < midDate), cs = ctrl.filter(e => e.d >= midDate);
  const fhm = mean(fh.map(e => e.r10)) - mean(cf.map(e => e.r10)), shm = mean(sh.map(e => e.r10)) - mean(cs.map(e => e.r10));
  const yrs = [...new Set(ev.map(e => e.yr))].sort();
  const byYr = yrs.map(y => [y, mean(ev.filter(e => e.yr === y).map(e => e.r10)) - mean(ctrl.filter(e => e.yr === y).map(e => e.r10)), ev.filter(e => e.yr === y).length]);
  const valid = byYr.filter(x => x[2] >= 30);
  const sameSign = valid.length >= 2 && valid.every(x => Math.sign(x[1]) === Math.sign(m10));
  const bestY = valid.length ? valid.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
  const exBest = bestY ? (() => { const ev2 = ev.filter(e => e.yr !== bestY[0]), c2 = ctrl.filter(e => e.yr !== bestY[0]); return mean(ev2.map(e => e.r10)) - mean(c2.map(e => e.r10)); })() : NaN;
  const gates = [m10 > 0, Math.sign(fhm) === Math.sign(shm) && Math.sign(fhm) === Math.sign(m10), sameSign, exBest > 0, m10 - COST > 0];
  console.log(`\n【${name}】n=${ev.length}(對照 n=${ctrl.length})`);
  console.log(`  10日 vs 對照 ${f(m10)}pp ・20日 ${f(m20)}pp ・勝率 ${win(r10).toFixed(1)}%(對照 ${win(ctrl.map(e => e.r10)).toFixed(1)}%)・中位 ${f(med(r10))}(對照 ${f(med(ctrl.map(e => e.r10)))})`);
  console.log(`  前後半 ${f(fhm)} / ${f(shm)} ・逐年 ${byYr.map(x => `${x[0]}:${f(x[1], 1)}(${x[2]})`).join(' ')} ・去最好年 ${f(exBest)} ・扣成本 ${f(m10 - COST)}`);
  console.log(`  關卡 ${gates.map(g => g ? '✅' : '❌').join('')}  ${gates.every(Boolean) ? '⭐ 全過' : ''}`);
  return { m10, m20, gates };
}

function tiers(ev, key, label) {
  const vals = ev.map(e => e[key]).sort((a, b) => a - b);
  const q1 = vals[Math.floor(vals.length / 3)], q2 = vals[Math.floor(vals.length * 2 / 3)];
  const tier = e => e[key] < q1 ? 0 : e[key] < q2 ? 1 : 2;
  console.log(`\n【分層:${label}】(每一層都只跟同層的「無籌碼先行」比)`);
  for (let t = 0; t < 3; t++) {
    const g = ev.filter(e => tier(e) === t);
    const B = g.filter(e => e.pre), Cc = g.filter(e => !e.pre);
    const m = mean(B.map(e => e.r10)) - mean(Cc.map(e => e.r10));
    console.log(`  ${['低', '中', '高'][t]}  鏈 n=${B.length} vs 無 n=${Cc.length} → 10日 ${f(m)}pp`);
  }
}

// ── selftest:合成資料,籌碼先行的突破之後**必定**多漲 5%
function synth() {
  const twii = new Map(), rowsBy = {};
  let d = new Date(2023, 0, 1);
  const days = []; while (days.length < 900) { d = new Date(d.getTime() + 864e5); if (d.getDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  days.forEach(dd => twii.set(dd, 100));
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let s = 0; s < 60; s++) {
    const rows = []; let c = 50; let bonus = 0;
    for (let i = 0; i < days.length; i++) {
      const dayVol = 1e6; let fn = 0, v = dayVol, brkDay = false;
      // 每 40 天一次突破;偶數突破前 5 天灌籌碼
      if (i > 260 && i % 40 === 0) { brkDay = true; v = 3e6; }
      const preBrk = i > 260 && [3, 4, 5].includes((40 - (i % 40)) % 40) && Math.floor((i + 5) / 40) % 2 === 0;
      if (preBrk) fn = 0.05 * dayVol;   // 突破前 3~5 天各買 5% 量 → 5 日累計 3%(過 2% 門檻)
      if (brkDay) { c *= 1.03; if (Math.floor(i / 40) % 2 === 0) bonus = 11; }
      else if (bonus > 0) { c *= 1.005; bonus--; }
      else c *= 1 + (rnd() - 0.5) * 0.01;
      rows.push({ date: days[i], open: c * 0.999, high: c * 1.01, low: c * 0.99, close: c, volume: v, foreign_net: fn, trust_net: 0 });
    }
    rowsBy['S' + s] = rows;
  }
  return { twii, rowsBy };
}

(function main() {
  let twii, rowsBy;
  if (SELF) ({ twii, rowsBy } = synth());
  else {
    twii = loadTwii(); rowsBy = {};
    for (const fn of fs.readdirSync(DATA)) {
      if (!fn.endsWith('.json') || fn.startsWith('^') || fn.includes('_')) continue;
      const sym = fn.slice(0, -5); if (!/^\d{4}[A-Z]?$/.test(sym)) continue;   // 個股(排除 ETF 00xxx)
      const r = loadRows(path.join(DATA, fn)); if (r && r.length >= 300 && r[0] && 'close' in r[0]) rowsBy[sym] = r;
    }
  }
  const acc = [];
  for (const [sym, rows] of Object.entries(rowsBy)) scan(sym, rows, twii, acc);
  const brks = acc.filter(e => e.brk);
  const dates = brks.map(e => e.d).sort(); const midDate = dates[dates.length >> 1] || '9999';
  console.log(`🔗 事件鏈探針 ${SELF ? '(selftest 合成)' : ''}:${Object.keys(rowsBy).length} 檔 ・帶量突破 ${brks.length} 筆 ・只有籌碼沒突破 ${acc.filter(e => e.e2only).length} 筆 ・中點 ${midDate}`);
  console.log(`  對照組 = 帶量突破(全部):10日 ${f(mean(brks.map(e => e.r10)))}% ・勝率 ${win(brks.map(e => e.r10)).toFixed(1)}% ・中位 ${f(med(brks.map(e => e.r10)))}%`);
  const B = report('B 籌碼先行 → 帶量突破(鏈)', brks.filter(e => e.pre), brks, midDate);
  const Cc = report('C 沒有籌碼先行的帶量突破', brks.filter(e => !e.pre), brks, midDate);
  report('D 突破當天法人才大買(同步,不是先行)', brks.filter(e => e.same), brks, midDate);
  report('B∖D 籌碼先行但突破當天法人沒買', brks.filter(e => e.pre && !e.same), brks, midDate);
  console.log(`\n【B − C(鏈 vs 沒鏈,同樣都是帶量突破)】10日 ${f(B.m10 - Cc.m10)}pp ・20日 ${f(B.m20 - Cc.m20)}pp`);
  const e2 = acc.filter(e => e.e2only);
  console.log(`\n【E 籌碼進駐但 10 天內沒突破(故事停在第 2 階段)】n=${e2.length} 10日 ${f(mean(e2.map(e => e.r10)))}% ・勝率 ${win(e2.map(e => e.r10)).toFixed(1)}%  🆚 帶量突破 ${f(mean(brks.map(e => e.r10)))}%`);
  if (!SELF) { tiers(brks, 'amt', '20 日均成交額(小/中/大)'); tiers(brks, 'amp', '20 日振幅(低/中/高)'); }
  if (SELF) {
    const inc = B.m10 - Cc.m10;
    if (!(inc > 3)) { console.log(`\n❌ SELFTEST_FAIL:合成資料裡籌碼先行必定 +5%,量到的增量只有 ${f(inc)}pp`); process.exit(1); }
    console.log(`\n✅ SELFTEST_PASS(增量 ${f(inc)}pp,harness 量得到已知訊號)`);
  }
})();
