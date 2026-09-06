#!/usr/bin/env node
/**
 * 💧 板塊輪動:「錢流到哪裡」到底幾天的窗口才有價值 —— 只讀探針
 *
 * ❓ 使用者:「做一個錢流動到哪裡的板塊輪動,還可以做個動畫,要幾天才有價值,
 *    這個部分請深入想一下,要有用的方案」。
 *
 * ⭐⭐ 「要幾天」⛔ 不可以用猜的,這正是本專案最容易憑空訂門檻的地方
 *    (摩卡「跳空 2~4%」、Gemini「投量比 >10%」、權證小哥「地板股 100 檔」全部是隨口訂的)。
 *    → 把 1/3/5/10/20/60 日**全部測一遍**,讓資料自己說。
 *
 * 🧪 四種「錢流」定義各測一次(⛔ 不預設哪一種對):
 *    ① ret   價格動能   —— 該產業成分股 N 日報酬中位
 *    ② fi    外資淨流入金額(Σ foreign_net × close)
 *    ③ fiR   外資買超佔成交額比(② ÷ 成交額)—— 大產業不會天生佔便宜
 *    ④ amtS  成交額佔比的**變化**(這一段 vs 前一段)—— 純粹的「人氣搬家」
 *
 * 📐 檢定:每天把 33 個產業依該指標排名 → 取前 3 / 後 3 →
 *    看它們**未來** 5/10/20 日的成分股中位報酬,扣同期加權。
 *    ・對照組 = **當天全部產業的平均**(⛔ 不是 0,也不是全市場個股)
 *    ・主判準是 **前 3 減後 3**(多空價差)—— 單看前 3 會被大盤方向帶著跑
 *    ・關卡:前後半同向 + 逐年同向 + 去最好年仍在 + 幅度 > 來回成本 0.44pp
 *
 * ⛔ 資料限制(誠實寫在輸出裡):`industry_map.json` 只涵蓋**上市**(1,095 檔),
 *    上櫃股沒有官方產業別 → 這是「上市板塊輪動」,⛔ 不是全市場。
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/sector_rotation_probe.mjs
 *   node scripts/sector_rotation_probe.mjs --selftest   # 注入「N=10 的外資流入必然有效」
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const LOOKBACKS = [1, 3, 5, 10, 20, 60];
const HORIZONS = [5, 10, 20];
const TOPN = 3;
const MIN_MEMB = 5;        // 該產業當天至少要有這麼多檔算得出報酬
const COST = 0.44;

const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const sg = (x) => (x >= 0 ? '+' : '');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };

const IND_NAME = { '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織', '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙', '10': '鋼鐵', '11': '橡膠', '12': '汽車', '14': '建材營造', '15': '航運', '16': '觀光餐旅', '17': '金融', '18': '貿易百貨', '20': '其他', '21': '化學', '22': '生技醫療', '23': '油電燃氣', '24': '半導體', '25': '電腦週邊', '26': '光電', '27': '通信網路', '28': '電子零組件', '29': '電子通路', '30': '資訊服務', '31': '其他電子', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活' };

function build() {
  const map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'industry_map.json'), 'utf8'));
  const idx = new Map();
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, '^TWII.json'), 'utf8'))
    .filter((r) => r && r.close != null)
    .forEach((r) => idx.set(String(r.date).replace(/\//g, '-'), +r.close));

  // 產業 → 日期 → {rets:[], fi, amt}
  const S = new Map();
  let nSym = 0;
  for (const [sym, ind] of Object.entries(map)) {
    const p = path.join(DATA_DIR, `${sym}.json`);
    if (!fs.existsSync(p)) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < 80) continue;
    nSym++;
    if (!S.has(ind)) S.set(ind, new Map());
    const m = S.get(ind);
    let pc = null;
    for (const r of rows) {
      if (!r || r.close == null) continue;
      const d = String(r.date).replace(/\//g, '-'), c = +r.close, v = +(r.volume || 0);
      if (pc != null && pc > 0 && c > 0) {
        let o = m.get(d);
        if (!o) { o = { rets: [], fi: 0, amt: 0 }; m.set(d, o); }
        o.rets.push((c / pc - 1) * 100);
        o.fi += (+(r.foreign_net || 0)) * c;
        o.amt += c * v;
      }
      pc = c;
    }
  }
  const dates = [...idx.keys()].sort();
  return { S, idx, dates, nSym, nInd: S.size };
}

function main() {
  const { S, idx, dates, nSym, nInd } = build();
  const inds = [...S.keys()].sort();
  console.log(`📈 ${nSym} 檔上市股 ・${nInd} 個產業 ・指數日期 ${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`⛔ 只涵蓋**上市**(industry_map 沒有上櫃)→ 這是「上市板塊輪動」,不是全市場。\n`);

  // 產業 × 日期 的矩陣(只留每天都算得出來的日子)
  const D = [];   // [{d, di, per: {ind: {ret, fi, amt}}}]
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i], per = {};
    let okN = 0;
    for (const ind of inds) {
      const o = S.get(ind).get(d);
      if (!o || o.rets.length < MIN_MEMB) continue;
      per[ind] = { ret: med(o.rets), fi: o.fi, amt: o.amt };
      okN++;
    }
    if (okN >= 20) D.push({ d, di: i, per });
  }
  if (D.length < 300) { console.log(`⏳ 可用交易日只有 ${D.length} 天,樣本不足`); return []; }
  console.log(`🗓️ 可用交易日 ${D.length} 天(${D[0].d} ~ ${D[D.length - 1].d})\n`);

  const at = new Map(); D.forEach((x, k) => at.set(x.d, k));
  // 每個產業的「未來 h 日中位報酬」,扣同期加權
  const fwd = (k, h, ind) => {
    const a = D[k], b = D[k + h];
    if (!b) return null;
    let cum = 0, n = 0;
    for (let j = k + 1; j <= k + h; j++) { const o = D[j].per[ind]; if (!o) return null; cum += o.ret; n++; }
    if (n !== h) return null;
    const bi = idx.get(a.d), bj = idx.get(b.d);
    if (!bi || !bj) return null;
    return cum - (bj / bi - 1) * 100;
  };

  // 四種「錢流」定義
  const METRICS = {
    ret: { n: '① 價格動能(N日報酬)', f: (k, N, ind) => { let c = 0; for (let j = k - N + 1; j <= k; j++) { const o = D[j] && D[j].per[ind]; if (!o) return null; c += o.ret; } return c; } },
    fi: { n: '② 外資淨流入金額', f: (k, N, ind) => { let c = 0; for (let j = k - N + 1; j <= k; j++) { const o = D[j] && D[j].per[ind]; if (!o) return null; c += o.fi; } return c; } },
    fiR: { n: '③ 外資買超佔成交額比', f: (k, N, ind) => { let c = 0, a = 0; for (let j = k - N + 1; j <= k; j++) { const o = D[j] && D[j].per[ind]; if (!o) return null; c += o.fi; a += o.amt; } return a > 0 ? c / a * 100 : null; } },
    // ⑤ 加速度:近 5 日的日均 − 近 N 日的日均(>0 = 正在加速)
    //    ⭐ 這正是 Tide 那張四象限圖的 **Y 軸**(加速流入 / 流入放緩)。
    //    ⛔ 在把它畫成一個軸之前先測 —— 「看起來很有道理」不是理由。
    accel: {
      n: '⑤ 動能加速度(近5日日均 − 近N日日均)', f: (k, N, ind) => {
        const avg = (lo, hi) => { let c = 0, n = 0; for (let j = lo; j <= hi; j++) { const o = D[j] && D[j].per[ind]; if (!o) return null; c += o.ret; n++; } return n ? c / n : null; };
        const s5 = avg(k - 4, k), sN = avg(k - N + 1, k);
        return (s5 == null || sN == null) ? null : s5 - sN;
      },
    },
    // ⑥ 外資流入的加速度(同上,但用金額)
    fiAccel: {
      n: '⑥ 外資流入加速度', f: (k, N, ind) => {
        const avg = (lo, hi) => { let c = 0, n = 0; for (let j = lo; j <= hi; j++) { const o = D[j] && D[j].per[ind]; if (!o) return null; c += o.fi; n++; } return n ? c / n : null; };
        const s5 = avg(k - 4, k), sN = avg(k - N + 1, k);
        return (s5 == null || sN == null) ? null : s5 - sN;
      },
    },
    amtS: {
      n: '④ 成交額佔比的變化(人氣搬家)', f: (k, N, ind) => {
        const sum = (lo, hi) => { let s = 0, t = 0; for (let j = lo; j <= hi; j++) { const p = D[j]; if (!p) return null; const o = p.per[ind]; if (!o) return null; s += o.amt; for (const q of Object.keys(p.per)) t += p.per[q].amt; } return t > 0 ? s / t * 100 : null; };
        const now = sum(k - N + 1, k), pre = sum(k - 2 * N + 1, k - N);
        return (now == null || pre == null) ? null : now - pre;
      },
    },
  };

  const MIDK = Math.floor(D.length / 2);
  const years = [...new Set(D.map((x) => x.d.slice(0, 4)))].sort();
  const out = [];

  for (const [mk, M] of Object.entries(METRICS)) {
    console.log(`\n════════ ${M.n} ════════`);
    console.log(`  窗口 │ ` + HORIZONS.map((h) => `未來${h}日(前3−後3)`).join(' │ '));
    for (const N of LOOKBACKS) {
      const cells = [];
      const detail = {};
      for (const h of HORIZONS) {
        const rows = [];   // {k, top, bot}
        for (let k = Math.max(2 * N, 60); k + h < D.length; k++) {
          const sc = [];
          for (const ind of Object.keys(D[k].per)) {
            const v = M.f(k, N, ind); if (v == null || !isFinite(v)) continue;
            const r = fwd(k, h, ind); if (r == null) continue;
            sc.push({ ind, v, r });
          }
          if (sc.length < 20) continue;
          sc.sort((a, b) => b.v - a.v);
          const top = mean(sc.slice(0, TOPN).map((x) => x.r));
          const bot = mean(sc.slice(-TOPN).map((x) => x.r));
          const all = mean(sc.map((x) => x.r));
          rows.push({ k, top, bot, all, y: D[k].d.slice(0, 4) });
        }
        if (rows.length < 200) { cells.push('  樣本不足  '); continue; }
        const spread = mean(rows.map((x) => x.top - x.bot));
        const q1 = mean(rows.filter((x) => x.k < MIDK).map((x) => x.top - x.bot));
        const q2 = mean(rows.filter((x) => x.k >= MIDK).map((x) => x.top - x.bot));
        const yr = {}; for (const y of years) { const a = rows.filter((x) => x.y === y); if (a.length > 40) yr[y] = mean(a.map((x) => x.top - x.bot)); }
        const yv = Object.entries(yr).filter(([, v]) => isFinite(v));
        const bestY = yv.slice().sort((a, b) => b[1] - a[1])[0];
        const exBest = bestY ? mean(rows.filter((x) => x.y !== bestY[0]).map((x) => x.top - x.bot)) : NaN;
        const same = (q1 > 0) === (q2 > 0);
        const allPos = yv.every(([, v]) => v > 0);
        const pass = spread > COST && same && allPos && exBest > COST;
        cells.push(`${pass ? '✅' : '  '}${sg(spread)}${nf(spread)}pp${same ? '' : '🚨'}`.padEnd(14));
        detail[h] = { spread, q1, q2, yr, exBest, n: rows.length, topEx: mean(rows.map((x) => x.top - x.all)), botEx: mean(rows.map((x) => x.bot - x.all)), pass };
      }
      console.log(`  ${String(N).padStart(2)} 日 │ ` + cells.join(' │ '));
      out.push({ mk, N, detail });
    }
  }

  // 明細:只印「前 3 減後 3 ≥ 成本」的那幾格
  console.log(`\n\n📋 明細(只列 前3−後3 ≥ ${COST}pp 的格子)`);
  let any = 0;
  for (const o of out) {
    for (const [h, d] of Object.entries(o.detail)) {
      if (!(d.spread > COST)) continue;
      any++;
      console.log(`\n─ ${METRICS[o.mk].n} ・窗口 ${o.N} 日 ・未來 ${h} 日 (n=${d.n})`);
      console.log(`   前3−後3 ${sg(d.spread)}${nf(d.spread)}pp ・前3 vs 全產業平均 ${sg(d.topEx)}${nf(d.topEx)} ・後3 ${sg(d.botEx)}${nf(d.botEx)}`);
      console.log(`   前半 ${sg(d.q1)}${nf(d.q1)} / 後半 ${sg(d.q2)}${nf(d.q2)}${(d.q1 > 0) === (d.q2 > 0) ? '' : ' 🚨不同向'}`
        + ` ・逐年 ${Object.entries(d.yr).map(([y, v]) => `${y.slice(2)}:${sg(v)}${nf(v, 1)}`).join(' ')}`);
      console.log(`   去最好年 ${sg(d.exBest)}${nf(d.exBest)} ・${d.pass ? '✅ 四關全過' : '❌ 沒過'}`);
    }
  }
  if (!any) console.log('   (一格都沒有 → 任何窗口的板塊輪動都吃不掉來回成本)');

  console.log(`\n📌 判讀:主判準是「**前 3 減後 3**」—— 單看前 3 會被大盤方向帶著跑。`);
  console.log(`   ⛔ 「幾天才有價值」的答案就是上面表格裡有 ✅ 的那一列;都沒有 ✅ = 這件事只能做**描述**不能做**訊號**。`);
  return out;
}

// ── 🧪 selftest:注入「外資 10 日流入最多的產業,之後真的漲」──────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'rot-'));
  fs.mkdirSync(path.join(tmp, 'd')); const dir = path.join(tmp, 'd');
  const NBAR = 700, NIND = 24, PER = 6;
  const dates = [];
  for (let d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(dir, '^TWII.json'),
    JSON.stringify(dates.map((dt) => ({ date: dt, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  // 真雜湊(⛔ 不可用線性式,那是斜坡不是雜湊 —— trustvol_probe 踩過)
  const H = (a, b) => { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  // 每 30 天換一個「當紅產業」:它在那 30 天外資狂買,且**之後**繼續漲
  const hot = (i) => Math.floor(H(999, Math.floor(i / 30)) * NIND);
  const map = {}, series = {};
  for (let g = 0; g < NIND; g++) {
    for (let s = 0; s < PER; s++) {
      const sym = String(1000 + g * 10 + s);
      map[sym] = String(g + 1).padStart(2, '0');
      series[sym] = { g, rows: [] };
    }
  }
  for (const [sym, o] of Object.entries(series)) {
    let c = 100;
    for (let i = 0; i < NBAR; i++) {
      // 前 10 天是它當紅 → 現在繼續漲(訊號:過去 10 天外資買 → 未來會漲)
      let up = (H(o.g * 31 + Number(sym) % 7, i) - 0.5) * 2;
      for (let k = 1; k <= 12; k++) if (hot(i - k) === o.g) up += 0.25;
      c = Math.max(1, c * (1 + up / 100));
      o.rows.push({
        date: dates[i], open: +c.toFixed(2), high: +(c * 1.01).toFixed(2), low: +(c * 0.99).toFixed(2),
        close: +c.toFixed(2), volume: 1_000_000,
        foreign_net: hot(i) === o.g ? 500_000 : Math.round(20_000 * (H(o.g + 7, i) - 0.5)),
      });
    }
    fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(o.rows));
  }
  fs.writeFileSync(path.join(dir, 'industry_map.json'), JSON.stringify(map));
  DATA_DIR = dir;
  console.log('🧪 --selftest:每 30 天換一個當紅產業(外資狂買且之後繼續漲)→ ② 外資流入在 5~20 日窗口必須抓得到。\n');
}

if (SELFTEST) {
  selftest();
  const out = main();
  const hits = out.filter((o) => o.mk === 'fi' && [5, 10, 20].includes(o.N))
    .flatMap((o) => Object.values(o.detail)).filter((d) => d && d.spread > 1);
  const bad = [];
  if (!hits.length) bad.push('② 外資流入在 5/10/20 日窗口沒抓到注入的邊際');
  if (bad.length) { console.error('\n❌ SELFTEST 失敗:'); bad.forEach((b) => console.error('   - ' + b)); process.exit(1); }
  console.log('\n✅ SECTOR_ROTATION_PROBE_SELFTEST_PASS');
} else {
  main();
}
