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
 * 🔁 V79.4.3(16 年全市場 d16 重跑前修好,陷阱 #50 / #52):
 *    ・對照組本來就是**同一天**(當天全部產業的平均、前 3 減後 3)→ 這部分不用改;每天仍要 ≥20 個產業、每個產業 ≥5 檔。
 *    ・外資欄缺 = 不知道(⛔ 不當 0):舊寫法 `|| 0` 讓 d16 2010~2011(還沒有法人欄)每天每個產業的外資都是 0
 *      → 排序退化成「物件鍵的順序」(整數鍵 '10' '11' '12' 永遠排第 1~3、'06' '08' '09' 永遠墊底)= 一個假的、天天一樣的多空價差。
 *      現在:那天已知外資的成員 < 5 檔 → 那個產業那天的外資「不知道」→ 不排;整天都不知道 → 那天整天不排。
 *      部分成員缺 → 用同一天、同產業已知成員的「外資買超佔成交額比」× 缺的那幾檔成交額補估(⛔ 不當 0);
 *      ③ 佔比的分母也只算已知成員。
 *    ・訊號日收盤停在漲停(2015-06 前 ±7%,lib_limit)→ 那天尾盤買不到 → 那幾檔不算進「之後 h 日」的產業報酬(前 3 / 後 3 / 全產業一起)。
 *    ・價格斷崖(×1.5 / ×0.67,lib_cliff):那一天的日報酬是假的 → 不算進那天的產業中位數(⛔ 不整檔剔除)。
 *    ・前後半照**日期**切,而且中點用那一格自己的樣本推(外資那幾個指標 2012 才開始有,⛔ 不可再用整條日期軸的一半)。
 *
 * 用法:
 *   node --max-old-space-size=6144 scripts/sector_rotation_probe.mjs
 *   DATA_DIR=… MAX_SYMS=800 node scripts/sector_rotation_probe.mjs   # 試跑:等距抽 800 檔(⛔ 不取前 N 檔)
 *   node scripts/sector_rotation_probe.mjs --selftest   # 注入「N=10 的外資流入必然有效」+ 缺值 / ±7% / 斷崖 三個決定性對照
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upLimitClose } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const MAX_SYMS = +(process.env.MAX_SYMS || 0);   // 🔁 V79.4.3 試跑用:等距抽 N 檔(⛔ 不取前 N 檔 = 按產業取樣);0 = 全部

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

  let entries = Object.entries(map).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (MAX_SYMS > 0 && entries.length > MAX_SYMS) {   // 🔁 V79.4.3 等距抽樣(⛔ 不取前 N 檔)
    const step = Math.max(1, Math.floor(entries.length / MAX_SYMS));
    entries = entries.filter((_, k) => k % step === 0).slice(0, MAX_SYMS);
  }
  // 產業 → 日期 → {rets:[], ids:[], lu:[], fi, fiN, amt, amtK}
  //   🔁 V79.4.3 ids = 每一個日報酬是哪一檔(收漲停那幾檔要從之後的路徑剔掉)・lu = 那天收盤停在漲停的檔(買不到)
  //   fi / amtK 只加「外資欄已知」的成員(fiN 檔);amt 是全部成員(④ 人氣搬家用)
  const S = new Map();
  const skip = { cliff: 0, lu: 0, unk: 0 };
  let nSym = 0;
  for (const [sym, ind] of entries) {
    const p = path.join(DATA_DIR, `${sym}.json`);
    if (!fs.existsSync(p)) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < 80) continue;
    const id = nSym++;
    if (!S.has(ind)) S.set(ind, new Map());
    const m = S.get(ind);
    const R = rows.filter((r) => r && r.close != null);
    const cl = R.map((r) => +r.close);
    const pre = cliffPrefix(cl, R.map((r) => +r.open));
    for (let k = 1; k < R.length; k++) {
      const r = R[k], pc = cl[k - 1], c = cl[k];
      if (!(pc > 0 && c > 0)) continue;
      const d = String(r.date).replace(/\//g, '-'), v = +(r.volume || 0);
      let o = m.get(d);
      if (!o) { o = { rets: [], ids: [], lu: [], fi: 0, fiN: 0, amt: 0, amtK: 0 }; m.set(d, o); }
      // 🔁 V79.4.3 這一天跟前一天之間有價格斷崖 → 這個日報酬是假的,不算進產業中位數(⛔ 不整檔剔除)
      if (cliffIn(pre, k - 1, k)) skip.cliff++;
      else {
        o.rets.push((c / pc - 1) * 100); o.ids.push(id);
        // 🔁 V79.4.3 收盤停在漲停(lib_limit,2015-06 前 ±7%)→ 那天尾盤買不到(斷崖那天的漲跌是假的,不判)
        if (upLimitClose(d, c, pc)) { o.lu.push(id); skip.lu++; }
      }
      // 🔁 V79.4.3 外資欄缺 = 不知道(⛔ 不當 0)
      if (r.foreign_net == null) skip.unk++;
      else { o.fi += (+r.foreign_net) * c; o.fiN++; o.amtK += c * v; }
      o.amt += c * v;
    }
  }
  const dates = [...idx.keys()].sort();
  return { S, idx, dates, nSym, nInd: S.size, skip };
}

/**
 * 🔁 V79.4.3 一個產業一天的外資流入(元):已知成員 < MIN_MEMB 檔 → null(不知道,⛔ 不當 0);
 * 部分成員缺 → 已知成員的「外資買超 ÷ 成交額」× 全部成員成交額(缺的那幾檔照同一天同產業的比例補估)。
 * 回 { fi, fiAmt }(③ 佔比 = Σfi ÷ ΣfiAmt;單一天就等於「已知成員的外資買超 ÷ 已知成員的成交額」)。
 */
function indFlow(o) {
  if (!(o.fiN >= MIN_MEMB) || !(o.amtK > 0)) return { fi: null, fiAmt: null };
  return { fi: o.fi / o.amtK * o.amt, fiAmt: o.amt };
}

/** 🔁 V79.4.3 從 main 搬出來(selftest 直接測):每天的產業矩陣 D + 之後 h 日的產業報酬 fwd(收漲停那幾檔剔除)。 */
function prepare() {
  const B = build();
  const { S, idx, dates } = B;
  const inds = [...S.keys()].sort();
  // 產業 × 日期 的矩陣(只留每天都算得出來的日子)
  const D = [];   // [{d, di, per: {ind: {ret, fi, amt, fiAmt, o}}}]
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i], per = {};
    let okN = 0;
    for (const ind of inds) {
      const o = S.get(ind).get(d);
      if (!o || o.rets.length < MIN_MEMB) continue;
      const fl = indFlow(o);
      per[ind] = { ret: med(o.rets), fi: fl.fi, amt: o.amt, fiAmt: fl.fiAmt, o };
      okN++;
    }
    if (okN >= 20) D.push({ d, di: i, per });
  }
  // 每個產業的「未來 h 日中位報酬」,扣同期加權
  //   🔁 V79.4.3 訊號日(D[k])收盤停在漲停的那幾檔買不到 → 之後每一天的中位數都不算它們(前 3 / 後 3 / 全產業一起)
  const memo = new Map();
  const fwd = (k, h, ind) => {
    const key = (k * 64 + h) * 4096 + inds.indexOf(ind);
    if (memo.has(key)) return memo.get(key);
    const v = fwdRaw(k, h, ind);
    memo.set(key, v);
    return v;
  };
  const fwdRaw = (k, h, ind) => {
    const a = D[k], b = D[k + h];
    if (!b) return null;
    const a0 = a.per[ind];
    const ex = a0 && a0.o.lu.length ? new Set(a0.o.lu) : null;
    let cum = 0, n = 0;
    for (let j = k + 1; j <= k + h; j++) {
      const o = D[j].per[ind]; if (!o) return null;
      if (ex) {
        const rr = [];
        for (let q = 0; q < o.o.ids.length; q++) if (!ex.has(o.o.ids[q])) rr.push(o.o.rets[q]);
        if (!rr.length) return null;
        cum += med(rr);
      } else cum += o.ret;
      n++;
    }
    if (n !== h) return null;
    const bi = idx.get(a.d), bj = idx.get(b.d);
    if (!bi || !bj) return null;
    return cum - (bj / bi - 1) * 100;
  };
  return { ...B, inds, D, fwd };
}

/** 四種「錢流」定義(🔁 V79.4.3 從 main 搬出來;外資那幾個:窗口裡任一天「不知道」→ null,⛔ 不當 0) */
function metricsOf(D) {
  return {
    ret: { n: '① 價格動能(N日報酬)', f: (k, N, ind) => { let c = 0; for (let j = k - N + 1; j <= k; j++) { const o = D[j] && D[j].per[ind]; if (!o) return null; c += o.ret; } return c; } },
    fi: { n: '② 外資淨流入金額', f: (k, N, ind) => { let c = 0; for (let j = k - N + 1; j <= k; j++) { const o = D[j] && D[j].per[ind]; if (!o || o.fi == null) return null; c += o.fi; } return c; } },
    fiR: { n: '③ 外資買超佔成交額比', f: (k, N, ind) => { let c = 0, a = 0; for (let j = k - N + 1; j <= k; j++) { const o = D[j] && D[j].per[ind]; if (!o || o.fi == null) return null; c += o.fi; a += o.fiAmt; } return a > 0 ? c / a * 100 : null; } },
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
        const avg = (lo, hi) => { let c = 0, n = 0; for (let j = lo; j <= hi; j++) { const o = D[j] && D[j].per[ind]; if (!o || o.fi == null) return null; c += o.fi; n++; } return n ? c / n : null; };
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
}

function main() {
  const { nSym, nInd, dates, D, fwd, skip } = prepare();
  console.log(`📈 ${nSym} 檔上市股 ・${nInd} 個產業 ・指數日期 ${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`⛔ 只涵蓋**上市**(industry_map 沒有上櫃)→ 這是「上市板塊輪動」,不是全市場。`);
  console.log(`🔁 V79.4.3 股·日:日報酬碰到斷崖不算 ${skip.cliff.toLocaleString()} ・收漲停買不到(之後的路徑剔掉,2015-06 前 ±7%)${skip.lu.toLocaleString()}`
    + ` ・外資欄缺(⛔ 不當 0)${skip.unk.toLocaleString()}\n`);

  if (D.length < 300) { console.log(`⏳ 可用交易日只有 ${D.length} 天,樣本不足`); return []; }
  const fiDays = D.filter((x) => Object.values(x.per).filter((o) => o.fi != null).length >= 20).length;
  console.log(`🗓️ 可用交易日 ${D.length} 天(${D[0].d} ~ ${D[D.length - 1].d});外資已知 ≥20 個產業的 ${fiDays} 天(其餘那幾天外資指標整天不排)\n`);

  const METRICS = metricsOf(D);
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
        // 🔁 V79.4.3 前後半照日期切,中點用這一格自己的樣本(外資指標 2012 才有,⛔ 不可再用整條日期軸的一半)
        const MIDK = rows[Math.floor(rows.length / 2)].k;
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
// 真雜湊(⛔ 不可用線性式,那是斜坡不是雜湊 —— trustvol_probe 踩過)
const H = (a, b) => { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; };

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

// ── 🔁 V79.4.3 決定性對照用的合成資料 ──
const weekdays = (y, m, d, n) => {
  const out = [];
  for (let t = new Date(Date.UTC(y, m - 1, d)); out.length < n; t.setUTCDate(t.getUTCDate() + 1)) {
    if (t.getUTCDay() >= 1 && t.getUTCDay() <= 5) out.push(t.toISOString().slice(0, 10));
  }
  return out;
};
// retOf(i) = 第 i 天的日漲跌%;fiOf(i) 回 undefined = 那天外資欄整個不寫(= d16 的「沒有資料」,⛔ 不是 0);日期照 d16 寫 YYYY/MM/DD
function synthRows(dates, retOf, fiOf) {
  const rows = [];
  let c = 100;
  for (let i = 0; i < dates.length; i++) {
    if (i) c *= 1 + retOf(i) / 100;
    const r = { date: dates[i].replace(/-/g, '/'), open: +c.toFixed(4), high: +(c * 1.01).toFixed(4), low: +(c * 0.99).toFixed(4), close: +c.toFixed(4), volume: 1_000_000 };
    const f = fiOf(i);
    if (f !== undefined) r.foreign_net = f;
    rows.push(r);
  }
  return rows;
}
// groups = [{code, n, rows(s, dates) → K 線}] → 寫成一個資料夾,DATA_DIR 指過去
function synthDir(tag, dates, groups) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', `rot-${tag}-`));
  fs.writeFileSync(path.join(dir, '^TWII.json'), JSON.stringify(dates.map((d) => ({ date: d.replace(/-/g, '/'), close: 10000 }))));
  const map = {};
  let sym = 1000;
  for (const g of groups) {
    for (let s = 0; s < g.n; s++) {
      const id = String(sym++);
      map[id] = g.code;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(g.rows(s, dates)));
    }
  }
  fs.writeFileSync(path.join(dir, 'industry_map.json'), JSON.stringify(map));
  DATA_DIR = dir;
  return dir;
}
const codes = (n) => Array.from({ length: n }, (_, g) => String(g + 1).padStart(2, '0'));
const noise = (seed) => (i) => (H(seed, i) - 0.5) * 2;   // ±1%

function selftestV7943(bad) {
  const ok = (name, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + JSON.stringify(x).slice(0, 240)}`); if (!c) bad.push(name); };
  const dirs = [];
  try {
    // ⑩ 外資欄缺 ⛔ 當 0:前 350 天整天沒有外資欄。舊寫法每個產業都是 0 → 排序退化成物件鍵的順序
    //    → 讓「鍵順序的前 3」那 3 個產業那段每天 +0.5%、「最後 3」每天 −0.5% → 舊寫法憑空量出一大截多空價差;新寫法那幾天整天不排 ≈ 0
    const C24 = codes(24);
    const order = Object.keys(Object.fromEntries([...C24].sort().map((c) => [c, 1])));
    const up = new Set(order.slice(0, 3)), dn = new Set(order.slice(-3));
    const d10 = weekdays(2011, 1, 3, 700);
    dirs.push(synthDir('miss', d10, C24.map((code, g) => ({
      code, n: 6,
      rows: (s, dates) => synthRows(dates,
        (i) => noise(g * 40 + s)(i) + (i < 350 ? (up.has(code) ? 0.5 : dn.has(code) ? -0.5 : 0) : 0),
        (i) => (i < 350 ? undefined : Math.round(20_000 * (H(g * 40 + s + 7, i) - 0.5)))),
    }))));
    const P = prepare();
    const dEarly = P.D.find((x) => x.d === d10[100]);
    ok('⑩ 沒有外資欄的那天:每個產業的外資都是「不知道」(⛔ 不是 0)', dEarly && Object.values(dEarly.per).every((o) => o.fi == null), dEarly && Object.values(dEarly.per).map((o) => o.fi).slice(0, 4));
    let out;
    const log = console.log; console.log = () => {};
    try { out = main(); } finally { console.log = log; }
    const cell = (out.find((o) => o.mk === 'fi' && o.N === 5) || {}).detail || {};
    const c5 = cell[5];
    ok(`⑩ ② 外資流入 5 日 → 未來 5 日:沒有外資的日子整天不排,前3−後3 ≈ 0(${c5 ? nf(c5.spread) : '—'}pp;n=${c5 ? c5.n : 0})`,
      c5 && Math.abs(c5.spread) < 0.6 && c5.n >= 200, c5);
    ok('⑩b 前後半照日期、中點用這一格自己的樣本(外資 350 天後才有 → 兩半都要有數字)', c5 && isFinite(c5.q1) && isFinite(c5.q2), c5 && [c5.q1, c5.q2]);
    // ⑩c 部分成員缺:已知 < 5 檔 → 不知道;≥5 檔 → 用已知成員的「買超 ÷ 成交額」× 全部成交額補估(⛔ 不當 0)
    const f4 = indFlow({ fiN: 4, fi: 1000, amtK: 10, amt: 20 }), f5 = indFlow({ fiN: 5, fi: 100, amtK: 50, amt: 100 });
    ok('⑩c 已知外資的成員 4 檔 → 不知道;5 檔 → 100 ÷ 50 × 100 = 200(缺的那些照比例補,⛔ 不當 0)', f4.fi === null && f5.fi === 200 && f5.fiAmt === 100, [f4, f5]);

    // ⑪ 2015-06 前 ±7%:2012 年第 100 天產業 01 有 3 檔收 +7%(= 收在漲停,尾盤買不到)、之後 5 天每天 +5%;另 3 檔不動
    //    → 2012:那 3 檔不算 → 之後 5 天產業 01 ≈ 0;同一份資料放到 2020 年(+7% 不是漲停)→ 照算(中位數 = +5%/天 → ≈ +25)
    const luCase = (y) => {
      const ds = weekdays(y, 1, 2, 140);
      dirs.push(synthDir(`lu${y}`, ds, codes(21).map((code, g) => ({
        code, n: 6,
        rows: (s, dates) => synthRows(dates,
          (i) => (g > 0 ? noise(g * 40 + s)(i) : (s < 3 ? (i === 100 ? 7 : (i > 100 && i <= 105 ? 5 : 0)) : 0)),
          () => 1000),
      }))));
      const Q = prepare();
      const k = Q.D.findIndex((x) => x.d === ds[100]);
      return { d: ds[100], f: k >= 0 ? Q.fwd(k, 5, '01') : null, lu: Q.skip.lu };
    };
    const L12 = luCase(2012), L20 = luCase(2020);
    ok(`⑪ 2012(${L12.d})收 +7% 的 3 檔買不到 → 之後 5 天產業報酬 ${L12.f == null ? '—' : nf(L12.f)}(≈ 0);2020(${L20.d})照算 ${L20.f == null ? '—' : nf(L20.f)}(≈ +25)`,
      L12.f != null && Math.abs(L12.f) < 1 && L12.lu === 3 && L20.f != null && L20.f > 20 && L20.lu === 0, [L12, L20]);

    // ⑫ 斷崖:第 100 天產業 01 有 7 / 12 檔 ×1.6(減資恢復交易,假的日報酬)、5 檔不動 → 那天的產業中位數 ≈ 0(⛔ 不是 +60)
    const dc = weekdays(2016, 1, 4, 140);
    dirs.push(synthDir('cliff', dc, codes(21).map((code, g) => ({
      code, n: g === 0 ? 12 : 6,
      rows: (s, dates) => synthRows(dates, (i) => (g > 0 ? noise(g * 40 + s)(i) : (s < 7 && i === 100 ? 60 : 0)), () => 1000),
    }))));
    const R = prepare();
    const kc = R.D.findIndex((x) => x.d === dc[100]);
    const rc = kc >= 0 && R.D[kc].per['01'] ? R.D[kc].per['01'].ret : null;
    ok(`⑫ 斷崖那天的日報酬不算:產業 01 當天中位數 ${rc == null ? '—' : nf(rc)}%(≈ 0)、剔掉 ${R.skip.cliff} 個股·日(⛔ 也不當成收漲停)`,
      rc != null && Math.abs(rc) < 1 && R.skip.cliff === 7 && R.skip.lu === 0, [rc, R.skip]);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

if (SELFTEST) {
  selftest();
  const out = main();
  const hits = out.filter((o) => o.mk === 'fi' && [5, 10, 20].includes(o.N))
    .flatMap((o) => Object.values(o.detail)).filter((d) => d && d.spread > 1);
  const bad = [];
  if (!hits.length) bad.push('② 外資流入在 5/10/20 日窗口沒抓到注入的邊際');
  console.log('\n🧪 🔁 V79.4.3 決定性對照:');
  selftestV7943(bad);
  if (bad.length) { console.error('\n❌ SELFTEST 失敗:'); bad.forEach((b) => console.error('   - ' + b)); process.exit(1); }
  console.log('\n✅ SECTOR_ROTATION_PROBE_SELFTEST_PASS');
} else {
  main();
}
