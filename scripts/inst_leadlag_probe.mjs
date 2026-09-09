#!/usr/bin/env node
/**
 * 👥 三大法人 × 散戶代理:「誰在追誰買」—— 只讀探針
 *
 * ❓ 使用者:「三大加上散戶,用打勾方式各別重疊顯示,這樣可否判斷跟單還是誰在追誰買?」
 *
 * 🚨🚨 先講一個一定要避開的陷阱(⛔ 否則整張圖是假的):
 *    **「散戶 = −(外資+投信+自營)」是恆等式,不是資料。**
 *    每一股都有買方與賣方 → 非三大法人的淨額**必然**等於三大法人淨額的相反數。
 *    照這樣畫,散戶那條線會是三大法人的**完美鏡像** —— 看起來超有說服力
 *    (「法人買、散戶賣!」),但它**零資訊**,而且那個「非三大法人」裡面
 *    還包含主力分點、公司派、ETF、造市商,根本不是散戶。
 *    → 本探針的「散戶」一律用**真實的獨立資料**:融資餘額變化(散戶槓桿代理)。
 *
 * 🚨 第二個陷阱(CLAUDE.md 評估紀錄⑧ 已記過):
 *    **同期相關是廢話** —— 大家同一天對同一個消息反應,lag 0 的相關必然高,
 *    但那不是「跟單」。要問的是 **lag ≥ 1**,而且要比較**兩個方向**:
 *      corr(A_t, B_{t+k}) vs corr(B_t, A_{t+k}) —— 哪邊大,哪邊才是領先者。
 *
 * 📐 兩層檢定:
 *    ① 領先落後:每檔先做 z-score(⛔ 不然大型股會主宰),pooled 相關,lag 0~5
 *    ② 「跟單到底有沒有用」:A 今天大買(佔量比同檔前 10%)之後,
 *       分「B 隔天也大買」與「B 隔天沒跟」兩組,比未來 10/20 日超額報酬。
 *       ⛔ 進場一律**隔天開盤**(法人買賣超收盤後才公布)、排除開盤鎖死、扣同期加權。
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/inst_leadlag_probe.mjs
 *   node scripts/inst_leadlag_probe.mjs --selftest   # 注入「外資領先投信 1 天」驗 harness
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const LAGS = [0, 1, 2, 3, 5];
const WARM = 60;
const MIN_ROWS = 200;
const DEDUP = 20;
const COST = 0.44;
const TOPQ = 0.90;      // 「大買」= 該檔佔量比的前 10%

const nf = (x, d = 3) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const sg = (x) => (x >= 0 ? '+' : '');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

const SERIES = [
  ['f', '🌍 外資'],
  ['t', '🏦 投信'],
  ['d', '🏛️ 自營'],
  ['m', '💳 融資(散戶代理)'],
];

function load() {
  const idx = new Map();
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, '^TWII.json'), 'utf8'))
    .filter((r) => r && r.close != null)
    .forEach((r) => idx.set(String(r.date).replace(/\//g, '-'), +r.close));
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^\d/.test(f) && f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < MIN_ROWS) continue;
    const o = { sym: f.replace('.json', ''), d: [], c: [], o: [], h: [], l: [], v: [], f: [], t: [], dl: [], m: [] };
    let pm = null;
    for (const r of rows) {
      if (!r || r.close == null) continue;
      const v = +(r.volume || 0);
      o.d.push(String(r.date).replace(/\//g, '-'));
      o.c.push(+r.close); o.o.push(+r.open); o.h.push(+r.high); o.l.push(+r.low); o.v.push(v);
      // 佔量比(%)—— ⛔ 一定要 normalize,否則整份結果被台積電這種大型股主宰
      o.f.push(v > 0 ? (+(r.foreign_net || 0)) / v * 100 : 0);
      o.t.push(v > 0 ? (+(r.trust_net || 0)) / v * 100 : 0);
      o.dl.push(v > 0 ? (+(r.dealer_net || 0)) / v * 100 : 0);
      // 💳 融資餘額是**張**,要 ×1000 換成股才跟 volume 同單位
      const mb = +(r.margin_balance || 0);
      o.m.push(pm != null && v > 0 ? (mb - pm) * 1000 / v * 100 : 0);
      pm = mb || pm;
    }
    if (o.d.length < MIN_ROWS) continue;
    out.push(o);
  }
  return { stocks: out, idx };
}

const KEY = { f: 'f', t: 't', d: 'dl', m: 'm' };

function main() {
  const { stocks, idx } = load();
  console.log(`📈 ${stocks.length} 檔 ・欄位:外資 / 投信 / 自營 / 融資變化(都換成「佔當日成交量的 %」)\n`);

  // ── ① 領先落後:每檔 z-score 後 pooled 相關 ──
  // 只收「兩邊都真的有在動」的檔(⛔ 全 0 的序列會把相關稀釋成 0 而看起來像沒關係)
  const acc = {};   // `${a}>${b}|${lag}` -> {sxy, n}
  const push = (k, x, y) => { const o = acc[k] || (acc[k] = { sxy: 0, n: 0 }); o.sxy += x * y; o.n++; };
  let usable = 0;
  for (const o of stocks) {
    const N = o.d.length;
    const z = {};
    let ok = true;
    for (const [k] of SERIES) {
      const a = o[KEY[k]].slice(WARM);
      const mu = mean(a);
      const sd = Math.sqrt(mean(a.map((x) => (x - mu) ** 2)));
      if (!(sd > 1e-9)) { ok = false; break; }
      z[k] = a.map((x) => (x - mu) / sd);
    }
    if (!ok) continue;
    usable++;
    const M = z.f.length;
    for (const [a] of SERIES) for (const [b] of SERIES) {
      if (a === b) continue;
      for (const lag of LAGS) {
        for (let i = 0; i + lag < M; i++) push(`${a}>${b}|${lag}`, z[a][i], z[b][i + lag]);
      }
    }
  }
  console.log(`🔗 領先落後(${usable} 檔可用;每檔各自 z-score 後 pooled 相關)`);
  console.log('   ⚠️ lag 0 = 同一天,那是「一起反應」⛔ 不是跟單。要看的是 lag ≥ 1 的**不對稱**。\n');
  const corr = (a, b, lag) => { const o = acc[`${a}>${b}|${lag}`]; return o && o.n ? o.sxy / o.n : NaN; };
  const nameOf = Object.fromEntries(SERIES);
  console.log('   ' + 'A → B'.padEnd(26) + LAGS.map((l) => `lag${l}`.padStart(8)).join(''));
  const pairs = [];
  for (let i = 0; i < SERIES.length; i++) for (let j = 0; j < SERIES.length; j++) {
    if (i === j) continue;
    const [a] = SERIES[i], [b] = SERIES[j];
    const row = LAGS.map((l) => corr(a, b, l));
    console.log('   ' + `${nameOf[a]} → ${nameOf[b]}`.padEnd(24) + row.map((v) => nf(v).padStart(8)).join(''));
    if (i < j) pairs.push([a, b]);
  }
  console.log('\n   ⭐ 不對稱度(誰領先):corr(A今天, B明天) − corr(B今天, A明天),正 = A 領先 B');
  for (const [a, b] of pairs) {
    const ab = corr(a, b, 1), ba = corr(b, a, 1);
    const diff = ab - ba;
    const lead = Math.abs(diff) < 0.01 ? '➖ 分不出來' : (diff > 0 ? `⭐ ${nameOf[a]} 領先` : `⭐ ${nameOf[b]} 領先`);
    console.log(`     ${nameOf[a]} ↔ ${nameOf[b]}:${sg(diff)}${nf(diff)}  ${lead}`);
  }

  // ── ② 「跟單」到底有沒有用 ──
  console.log(`\n\n📊 「A 大買之後 B 有沒有跟」對未來報酬有沒有差(進場=隔天開盤・扣同期加權・同檔同組 ${DEDUP} 日去重)`);
  console.log(`   「大買」= 該檔自己佔量比的前 ${Math.round((1 - TOPQ) * 100)}%(⛔ 不寫死張數門檻)\n`);
  const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)]; };
  const res = {};
  const ctrl = [];
  for (const o of stocks) {
    const N = o.d.length;
    const th = {};
    for (const [k] of SERIES) th[k] = q(o[KEY[k]].slice(WARM), TOPQ);
    const last = {};
    for (let i = WARM; i + 21 < N; i++) {
      const c0 = o.c[i], op = o.o[i + 1];
      if (!(c0 > 0) || !(op > 0) || !(o.v[i] > 0)) continue;
      if (op >= c0 * 1.0995 && o.h[i + 1] === o.l[i + 1]) continue;   // 隔天開盤鎖死 = 買不到
      const bi = idx.get(o.d[i + 1]), b10 = idx.get(o.d[i + 10]), b20 = idx.get(o.d[i + 20]);
      if (!bi || !b10) continue;
      const e10 = (o.c[i + 10] / op - 1) * 100 - (b10 / bi - 1) * 100;
      const e20 = b20 ? (o.c[i + 20] / op - 1) * 100 - (b20 / bi - 1) * 100 : null;
      if (!isFinite(e10)) continue;
      ctrl.push(e10);
      for (const [a] of SERIES) {
        if (!(o[KEY[a]][i] >= th[a]) || !(th[a] > 0)) continue;
        for (const [b] of SERIES) {
          // 🚨 a === b 是**決定性的對照組**:A 大買後「**A 自己**隔天又大買」。
          //    若它跟「B 來跟」一樣好,那就代表這根本不是「跟單」,
          //    只是「隔天還有買盤 = 動能延續」—— ⛔ 少了這條會得出一個很漂亮但錯的結論。
          const follow = o[KEY[b]][i + 1] >= th[b] && th[b] > 0;
          const key = `${a}>${b}|${follow ? 'y' : 'n'}`;
          const lk = `${a}>${b}`;
          if (last[lk] != null && i - last[lk] < DEDUP) continue;
          last[lk] = i;
          (res[key] || (res[key] = [])).push({ e10, e20, y: o.d[i].slice(0, 4), i, sym: o.sym });
        }
      }
    }
  }
  const c10 = mean(ctrl);
  console.log(`🆚 對照組(所有可交易的股·日):10日 ${nf(c10, 2)}% ・n=${ctrl.length.toLocaleString()}\n`);
  console.log('   ' + 'A 大買 → B 隔天'.padEnd(30) + '跟了'.padStart(10) + '沒跟'.padStart(10) + '  差(跟−沒跟)');
  const out = [];
  for (const [a] of SERIES) for (const [b] of SERIES) {
    const y = res[`${a}>${b}|y`] || [], n = res[`${a}>${b}|n`] || [];
    if (y.length < 200 || n.length < 200) {
      console.log('   ' + `${nameOf[a]} → ${nameOf[b]}`.padEnd(28) + `  ⏳ 樣本不足(${y.length}/${n.length})`);
      continue;
    }
    const my = mean(y.map((x) => x.e10)) - c10, mn = mean(n.map((x) => x.e10)) - c10;
    const d = my - mn;
    const lbl = a === b ? `${nameOf[a]} → **自己續買**(對照)` : `${nameOf[a]} → ${nameOf[b]}`;
    console.log('   ' + lbl.padEnd(28)
      + `${sg(my)}${nf(my, 2)}pp`.padStart(10) + `${sg(mn)}${nf(mn, 2)}pp`.padStart(10)
      + `  ${sg(d)}${nf(d, 2)}pp` + (d > COST ? ' ✅' : ''));
    out.push({ a, b, my, mn, d, ny: y.length, nn: n.length });
    // 🚧 過了成本線的才做穩健性檢定 —— ⛔ 不可只看全期(V73.2.0 起的標準關卡)
    if (d > COST) {
      const ys = [...new Set(y.map((x) => x.y))].sort();
      const per = {};
      for (const yr of ys) {
        const yy = y.filter((x) => x.y === yr), nn2 = n.filter((x) => x.y === yr);
        if (yy.length > 60 && nn2.length > 60) per[yr] = mean(yy.map((x) => x.e10)) - mean(nn2.map((x) => x.e10));
      }
      const vs = Object.values(per);
      const worst = vs.length ? Math.min(...vs) : NaN;
      console.log('        逐年 ' + Object.entries(per).map(([k, v]) => `${k.slice(2)}:${sg(v)}${nf(v, 2)}`).join(' ')
        + `  → 最差年 ${sg(worst)}${nf(worst, 2)}` + (vs.length && vs.every((v) => v > 0) ? ' ✅ 逐年同向' : ' 🚨 有年份反向'));
    }
  }
  console.log(`\n📌 判讀:「差」要 > 來回成本 ${COST}pp 才有意義。`);
  console.log('   ⛔ 「散戶」用的是**融資餘額變化**(真實獨立資料),');
  console.log('      ⛔ 不是「−(外資+投信+自營)」—— 那是恆等式,畫出來必然是完美鏡像、零資訊。');
  return { out, pairs, corr, nameOf };
}

// ── 🧪 selftest:注入「外資今天買 → 投信明天跟,而且跟了會漲」 ──────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'll-'));
  fs.mkdirSync(path.join(tmp, 'd')); const dir = path.join(tmp, 'd');
  const NBAR = 700, NSYM = 60;
  const dates = [];
  for (let d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(dir, '^TWII.json'),
    JSON.stringify(dates.map((dt) => ({ date: dt, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  // ⚠️ 真雜湊(⛔ 線性式是斜坡不是雜湊 —— trustvol_probe 踩過)
  const H = (a, b) => { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  for (let s = 0; s < NSYM; s++) {
    const sym = String(4000 + s), rows = [];
    const fBig = new Set();
    for (let i = 0; i < NBAR; i++) if (H(s, i) < 0.05) fBig.add(i);
    let c = 100, mb = 10000;
    for (let i = 0; i < NBAR; i++) {
      let up = (H(s + 91, i) - 0.5) * 2;
      // 外資買 → 投信隔天跟 → 之後 10 天漲
      for (let k = 2; k <= 11; k++) if (fBig.has(i - k)) up += 0.35;
      c = Math.max(1, c * (1 + up / 100));
      const vol = 2_000_000;
      mb += Math.round((H(s + 13, i) - 0.5) * 200);
      rows.push({
        date: dates[i], open: +c.toFixed(2), high: +(c * 1.02).toFixed(2),
        low: +(c * 0.98).toFixed(2), close: +c.toFixed(2), volume: vol,
        foreign_net: fBig.has(i) ? Math.round(vol * 0.2) : Math.round(vol * 0.01 * (H(s + 3, i) - 0.5)),
        trust_net: fBig.has(i - 1) ? Math.round(vol * 0.2) : Math.round(vol * 0.01 * (H(s + 5, i) - 0.5)),
        dealer_net: Math.round(vol * 0.01 * (H(s + 7, i) - 0.5)),
        margin_balance: mb,
      });
    }
    fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
  }
  DATA_DIR = dir;
  console.log('🧪 --selftest:注入「外資今天大買 → 投信明天跟 → 之後 10 天漲」,harness 必須抓到方向與跟單效果。\n');
}

if (SELFTEST) {
  selftest();
  const { out, corr, nameOf } = main();
  const bad = [];
  const ft = corr('f', 't', 1), tf = corr('t', 'f', 1);
  if (!(ft - tf > 0.05)) bad.push(`不對稱度沒抓到「外資領先投信」(f→t ${nf(ft)} vs t→f ${nf(tf)})`);
  const row = out.find((x) => x.a === 'f' && x.b === 't');
  if (!row) bad.push('外資→投信 那一列樣本不足');
  else if (!(row.d > 1)) bad.push(`跟單效果沒抓到(差 ${nf(row.d, 2)}pp)`);
  if (bad.length) { console.error('\n❌ SELFTEST 失敗:'); bad.forEach((b) => console.error('   - ' + b)); process.exit(1); }
  console.log('\n✅ INST_LEADLAG_PROBE_SELFTEST_PASS');
} else {
  main();
}
