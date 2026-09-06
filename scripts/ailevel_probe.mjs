#!/usr/bin/env node
/**
 * 🪜 「AI 演進五級」自己的預測力 —— 只讀探針
 *
 * ❓ 為什麼要做:`pro.html` 的「🎯 資金主戰場在哪一層」是**本頁的核心宣稱**,
 *    但卡上誠實標著「不是預測、**沒有實測過預測力**」。
 *    ⭐ 驗證自己的功能,比再加一個指標有價值(同 V72.4.4 打臉 `_playbookMode` 那次)。
 *
 * 📐 問的是:「**當時**最強的那一層,之後 5/10/20 日還會繼續比較強嗎?」
 *
 * ⛔⛔ 對照組是這題的成敗關鍵:
 *    這 81 檔是 2026-08 **人工整理**的名單 → 天生就是「現在紅的股票」(選樣偏誤),
 *    拿它們跟全市場比,量到的是「這份名單被挑得好」⛔ 不是「分層有沒有用」。
 *    ⭐ 所以對照組必須是**名單內部**:最強那一層 vs 其他層 / vs 全名單平均。
 *
 * ⛔ 其他鐵則:
 *    ・名單直接讀 `pro.html` 的 `PRO.CHAIN`(⛔ 不複製第二份,改名單不會對不上)
 *    ・報酬扣同期加權 ・進場用**隔天開盤**(排名是收盤後才算得出來)
 *    ・排除隔天開盤漲停鎖死(買不到)
 *    ・前後半 + 逐年 + 去最好年,幅度要 > 來回成本 0.44pp
 *
 * 用法:node --max-old-space-size=4096 scripts/ailevel_probe.mjs
 *       node scripts/ailevel_probe.mjs --selftest
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const WINS = [5, 10, 20, 60];      // 「當時最強」用幾日報酬決定
const HORIZONS = [5, 10, 20];
const MIN_MEMB = 5;
const COST = 0.44;

const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const sg = (x) => (x >= 0 ? '+' : '');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };

async function loadChain() {
  if (SELFTEST) return globalThis.__FAKE_CHAIN;
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.PRO && !!window.PRO.CHAIN, null, { timeout: 15000 });
  // ⭐ 直接讀 App 自己的名單(⛔ 不複製第二份 —— 改名單時這支自動跟上)
  const chain = await page.evaluate(() => PRO.CHAIN.stocks.map(s => [s[0], s[4]]));
  await browser.close();
  return chain;
}

function loadPrices(codes) {
  const idx = new Map();
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, '^TWII.json'), 'utf8'))
    .filter(r => r && r.close != null)
    .forEach(r => idx.set(String(r.date).replace(/\//g, '-'), +r.close));
  const px = new Map();
  for (const c of codes) {
    const p = path.join(DATA_DIR, `${c}.json`);
    if (!fs.existsSync(p)) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < 120) continue;
    const o = { d: [], c: [], o: [], h: [], l: [] };
    for (const r of rows) {
      if (!r || r.close == null) continue;
      o.d.push(String(r.date).replace(/\//g, '-'));
      o.c.push(+r.close); o.o.push(+r.open); o.h.push(+r.high); o.l.push(+r.low);
    }
    o.at = new Map(); o.d.forEach((d, i) => o.at.set(d, i));
    px.set(c, o);
  }
  return { px, idx };
}

async function main() {
  const chain = await loadChain();
  const codes = [...new Set(chain.map(x => x[0]))];
  const { px, idx } = loadPrices(codes);
  const memb = {};                       // 層 → 成員(⚠️ 一檔可以屬於多層)
  for (const [c, lv] of chain) {
    if (!px.has(c)) continue;
    for (const ch of String(lv)) if ('12345'.includes(ch)) (memb[ch] ||= new Set()).add(c);
  }
  const LVS = Object.keys(memb).sort().filter(l => memb[l].size >= MIN_MEMB);
  console.log(`🪜 名單 ${chain.length} 檔(讀 pro.html 的 PRO.CHAIN)・有 K 線 ${px.size} 檔`);
  console.log(`   各層成員:${LVS.map(l => `L${l} ${memb[l].size} 檔`).join(' ・')}`);
  console.log(`⛔ 對照組刻意用「**名單內部**其他層」—— 拿全市場比會量到「這份名單被挑得好」而不是分層有沒有用。\n`);
  if (LVS.length < 3) { console.log('⏳ 可用層數不足'); return []; }

  // 共同交易日
  const dates = [...idx.keys()].sort();
  const cnt = new Map();
  for (const c of codes) { const o = px.get(c); if (o) for (const d of o.d) cnt.set(d, (cnt.get(d) || 0) + 1); }
  const days = dates.filter(d => (cnt.get(d) || 0) >= px.size * 0.6);
  console.log(`🗓️ 可用交易日 ${days.length} 天(${days[0]} ~ ${days[days.length - 1]})\n`);
  if (days.length < 300) { console.log('⏳ 交易日不足'); return []; }
  const dpos = new Map(); days.forEach((d, i) => dpos.set(d, i));

  // 某層在 [k-W+1, k] 的成員報酬中位;以及未來 h 日
  const lvRet = (lv, k, from, to) => {
    const vals = [];
    for (const c of memb[lv]) {
      const o = px.get(c); if (!o) continue;
      const a = o.at.get(days[from]), b = o.at.get(days[to]);
      if (a == null || b == null || !(o.c[a] > 0) || !(o.c[b] > 0)) continue;
      vals.push((o.c[b] / o.c[a] - 1) * 100);
    }
    return vals.length >= MIN_MEMB ? med(vals) : null;
  };
  // 未來報酬:隔天開盤進場(排名是收盤後才算得出來)
  const lvFwd = (lv, k, h) => {
    const vals = [];
    for (const c of memb[lv]) {
      const o = px.get(c); if (!o) continue;
      const i = o.at.get(days[k]); if (i == null) continue;
      const e = o.o[i + 1], x = o.c[i + h];
      if (!(e > 0) || !(x > 0)) continue;
      if (e >= o.c[i] * 1.0995 && o.h[i + 1] === o.l[i + 1]) continue;   // 開盤鎖死 → 買不到
      vals.push((x / e - 1) * 100);
    }
    if (vals.length < MIN_MEMB) return null;
    const bi = idx.get(days[k + 1]), bj = idx.get(days[k + h]);
    if (!bi || !bj) return null;
    return med(vals) - (bj / bi - 1) * 100;
  };

  const out = [];
  console.log('  「當時最強那層」的窗口 │ ' + HORIZONS.map(h => `未來${h}日(最強−最弱)`).join(' │ '));
  for (const W of WINS) {
    const cells = [], det = {};
    for (const h of HORIZONS) {
      const rows = [];
      for (let k = W + 5; k + h < days.length; k++) {
        const sc = [];
        for (const lv of LVS) {
          const r = lvRet(lv, k, k - W, k); if (r == null) continue;
          const f = lvFwd(lv, k, h); if (f == null) continue;
          sc.push({ lv, r, f });
        }
        if (sc.length < 3) continue;
        sc.sort((a, b) => b.r - a.r);
        rows.push({ k, top: sc[0].f, bot: sc[sc.length - 1].f, all: mean(sc.map(x => x.f)),
                    y: days[k].slice(0, 4), lv: sc[0].lv });
      }
      if (rows.length < 200) { cells.push('  樣本不足  '); continue; }
      const spread = mean(rows.map(x => x.top - x.bot));
      const MID = Math.floor(rows.length / 2);
      const q1 = mean(rows.slice(0, MID).map(x => x.top - x.bot));
      const q2 = mean(rows.slice(MID).map(x => x.top - x.bot));
      const yr = {};
      for (const y of [...new Set(rows.map(x => x.y))].sort()) {
        const a = rows.filter(x => x.y === y);
        if (a.length > 40) yr[y] = mean(a.map(x => x.top - x.bot));
      }
      const yv = Object.entries(yr);
      const best = yv.slice().sort((a, b) => b[1] - a[1])[0];
      const exBest = best ? mean(rows.filter(x => x.y !== best[0]).map(x => x.top - x.bot)) : NaN;
      const same = (q1 > 0) === (q2 > 0);
      const pass = spread > COST && same && yv.every(([, v]) => v > 0) && exBest > COST;
      cells.push(`${pass ? '✅' : '  '}${sg(spread)}${nf(spread)}pp${same ? '' : '🚨'}`.padEnd(14));
      det[h] = { spread, q1, q2, yr, exBest, n: rows.length, pass,
                 topEx: mean(rows.map(x => x.top - x.all)),
                 // 🔍 「最強的那一層」到底常常是哪一層 —— 若永遠同一層,那不是輪動是常數
                 lvMix: rows.reduce((m, x) => (m[x.lv] = (m[x.lv] || 0) + 1, m), {}) };
    }
    console.log(`  ${String(W).padStart(2)} 日窗口 │ ` + cells.join(' │ '));
    out.push({ W, det });
  }

  console.log('\n📋 明細');
  for (const o of out) {
    for (const [h, d] of Object.entries(o.det)) {
      console.log(`\n─ ${o.W} 日窗口 ・未來 ${h} 日 (n=${d.n})`);
      console.log(`   最強−最弱 ${sg(d.spread)}${nf(d.spread)}pp ・最強層 vs 全名單平均 ${sg(d.topEx)}${nf(d.topEx)}pp`);
      console.log(`   前半 ${sg(d.q1)}${nf(d.q1)} / 後半 ${sg(d.q2)}${nf(d.q2)}${(d.q1 > 0) === (d.q2 > 0) ? '' : ' 🚨不同向'}`
        + ` ・逐年 ${Object.entries(d.yr).map(([y, v]) => `${y.slice(2)}:${sg(v)}${nf(v, 1)}`).join(' ')}`);
      const mix = Object.entries(d.lvMix).sort((a, b) => b[1] - a[1])
        .map(([l, n]) => `L${l} ${Math.round(n / d.n * 100)}%`).join(' ');
      console.log(`   去最好年 ${sg(d.exBest)}${nf(d.exBest)} ・${d.pass ? '✅ 四關全過' : '❌ 沒過'}`);
      console.log(`   🔍 「最強」是哪一層:${mix}` + (Math.max(...Object.values(d.lvMix)) / d.n > 0.7 ? '  🚨 幾乎固定同一層 → 那不是輪動,是常數' : ''));
    }
  }
  console.log(`\n📌 判讀:對照組是**名單內部**(⛔ 不是全市場)→ 量的是「分層」本身,不是「這份名單好不好」。`);
  console.log(`   成立門檻:最強−最弱 > ${COST}pp(成本)且前後半同向、逐年同向、去最好年仍在。`);
  console.log(`   ⚠️ 名單是 2026-08 人工整理的 → 就算過關也帶有選樣偏誤,⛔ 不可外推到「任意分層都有效」。`);
  return out;
}

// ── 🧪 selftest:注入「L3 只要當時最強,之後就繼續最強」 ────────────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ail-'));
  fs.mkdirSync(path.join(tmp, 'd')); const dir = path.join(tmp, 'd');
  const NBAR = 700, PER = 8;
  const dates = [];
  for (let d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(dir, '^TWII.json'),
    JSON.stringify(dates.map(dt => ({ date: dt, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  // ⚠️ 真雜湊(⛔ 線性式是斜坡不是雜湊)
  const H = (a, b) => { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  // 每 40 天換一個「當紅層」,而且它在那段期間**持續**最強(= 有延續性)
  const hot = (i) => 1 + Math.floor(H(555, Math.floor(i / 40)) * 5);
  const chain = [];
  for (let lv = 1; lv <= 5; lv++) {
    for (let s = 0; s < PER; s++) {
      const sym = String(5000 + lv * 20 + s);
      chain.push([sym, String(lv)]);
      let c = 100; const rows = [];
      for (let i = 0; i < NBAR; i++) {
        let up = (H(lv * 37 + s, i) - 0.5) * 2;
        if (hot(i) === lv) up += 0.5;
        c = Math.max(1, c * (1 + up / 100));
        rows.push({ date: dates[i], open: +c.toFixed(2), high: +(c * 1.01).toFixed(2),
                    low: +(c * 0.99).toFixed(2), close: +c.toFixed(2), volume: 1e6 });
      }
      fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
    }
  }
  globalThis.__FAKE_CHAIN = chain;
  DATA_DIR = dir;
  console.log('🧪 --selftest:每 40 天換一個「當紅層」且持續最強 → 各窗口必須抓到明顯的最強−最弱價差。\n');
}

if (SELFTEST) {
  selftest();
  const out = await main();
  const hit = out.flatMap(o => Object.values(o.det)).filter(d => d && d.spread > 1);
  if (!hit.length) { console.error('\n❌ SELFTEST 失敗:沒抓到注入的分層延續性'); process.exit(1); }
  console.log('\n✅ AILEVEL_PROBE_SELFTEST_PASS');
} else {
  await main();
}
