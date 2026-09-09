#!/usr/bin/env node
/**
 * 🧙 分點 per-(券商 × 產業) 的專長(V74.4.3)—— LAB next 欄那條。
 *
 * 問題:「這家券商在**這個產業**特別準」存不存在?
 * 已知:per-broker 整體排名有延續性(ρ=0.436)但頭尾差 < 成本(broker_skill_probe);
 *       「先學一組成員再拿去預測」一律要**先報成員穩定度**再談報酬(同盟集團 Jaccard 0% 的教訓)。
 *
 * 方法:
 *   事件 = 券商 b 在產業 ind 的股票 sym 淨買 ≥ 當日量 0.3%(chips_deep 逐日,前 200 家券商)
 *   報酬 = 隔日開盤進場 → 10 日,扣同期加權
 *   cell = (b, ind);訓練半段取 cell 平均排名 → 驗收半段看「前段班 cell 的事件」vs
 *          「**同產業**全部事件」(⭐ 對照組共用產業那條腿 —— 不然量到的是產業本身)
 *   ⭐⭐ 先報 cell 名單的跨半段穩定度(Jaccard),再談報酬。
 *
 * 用法:node scripts/broker_ind_probe.mjs <chips_deep_dir> [gdataDir]
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const CDIR = process.argv[2] || '';
const GDATA = process.argv[3] || 'data';
if (!CDIR || !fs.existsSync(CDIR)) { console.error('用法:node scripts/broker_ind_probe.mjs <chips_deep_dir> [gdata]'); process.exit(1); }

const iso = s => String(s || '').replace(/\//g, '-');
const COST = 0.44;

// ── 產業對照(上市 1,078 檔)──
const indMap = JSON.parse(fs.readFileSync(path.join(GDATA, 'industry_map.json'), 'utf8'));
const IND = indMap.map || indMap;                 // {sym: code}

// ── K 線(lazy)──
const kl = new Map();
function loadK(sym) {
  if (kl.has(sym)) return kl.get(sym);
  let out = null;
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(GDATA, sym + '.json'), 'utf8'));
    if (Array.isArray(rows) && rows.length > 120) {
      const d = [], o = [], c = [], v = [];
      for (const r of rows) {
        if (!Number.isFinite(r.close) || !Number.isFinite(r.open)) continue;
        d.push(iso(r.date)); o.push(r.open); c.push(r.close); v.push(r.volume || 0);
      }
      const idx = {}; d.forEach((x, i) => idx[x] = i);
      out = { d, o, c, v, idx };
    }
  } catch { }
  kl.set(sym, out);
  return out;
}
const twii = loadK('^TWII');
const mkt = (d0, d1) => {
  const a = twii.idx[d0], b = twii.idx[d1];
  return (a == null || b == null) ? null : (twii.c[b] / twii.c[a] - 1) * 100;
};
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const f1 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);

// ── 掃 chips_deep 逐日 → 事件 ──
const days = fs.readdirSync(CDIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
console.log(`chips_deep:${days.length} 天`);
const events = [];                                // {b, ind, sym, d, ret}
for (const f of days) {
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CDIR, f))).toString('utf8'));
  const d = j.d;
  for (const [sym, rows] of Object.entries(j.s || {})) {
    const ind = IND[sym];
    if (!ind) continue;                           // 只做有官方產業別的(上市)
    const K = loadK(sym);
    if (!K) continue;
    const i = K.idx[d];
    if (i == null || i + 11 >= K.d.length) continue;
    const vol = K.v[i];
    if (!(vol > 0)) continue;
    const e = i + 1;                              // 分點收盤後公布 → 隔日開盤進場(零前視)
    if (!(K.o[e] > 0)) continue;
    const mk = mkt(K.d[e], K.d[e + 10]);
    if (mk == null) continue;
    const ret = (K.c[e + 10] / K.o[e] - 1) * 100 - mk;
    for (const [bid, net] of rows) {              // [券商代號, 淨股數, 均價]
      if (!(net > 0) || net / vol < 0.003) continue;
      events.push({ b: bid, ind, sym, d, ret });
    }
  }
}
console.log(`買超事件(淨買 ≥0.3% 量):${events.length.toLocaleString()} 筆`);
if (events.length < 5000) { console.log('⏳ 樣本不足'); process.exit(0); }

// ── 依日期切半 ──
const ds = events.map(e => e.d).sort();
const MID = ds[Math.floor(ds.length / 2)];
console.log(`切半:${ds[0]} ~ ${MID} ~ ${ds[ds.length - 1]}`);

const MIN_N = 30;                                 // cell 最少事件數(訓練段)
function topCells(rows, frac) {
  const cells = new Map();
  for (const e of rows) {
    const k = e.b + '|' + e.ind;
    (cells.get(k) || cells.set(k, []).get(k)).push(e.ret);
  }
  const ranked = [...cells.entries()].filter(([, a]) => a.length >= MIN_N)
    .map(([k, a]) => [k, avg(a), a.length]).sort((a, b) => b[1] - a[1]);
  const n = Math.max(1, Math.floor(ranked.length * frac));
  return { top: new Set(ranked.slice(0, n).map(x => x[0])), bot: new Set(ranked.slice(-n).map(x => x[0])), ranked };
}

// ⭐⭐ 第一關:名單穩不穩(同盟集團的教訓 —— 報酬會騙人,成員名單不會)
const h1 = events.filter(e => e.d < MID), h2 = events.filter(e => e.d >= MID);
const c1 = topCells(h1, 0.1), c2 = topCells(h2, 0.1);
const inter = [...c1.top].filter(k => c2.top.has(k)).length;
const uni = new Set([...c1.top, ...c2.top]).size;
console.log(`\n═══ ① 「專長 cell」名單穩定度(前 10%)═══`);
console.log(`  前半學到 ${c1.top.size} 格 ・後半學到 ${c2.top.size} 格 ・兩段都在前 10% 的:${inter} 格 → Jaccard ${(inter / uni * 100).toFixed(1)}%`);
console.log(`  (合格 cell 數:前半 ${c1.ranked.length} / 後半 ${c2.ranked.length};隨機重疊期望 ≈ ${(c1.top.size * c2.top.size / Math.max(1, c1.ranked.length) / uni * 100).toFixed(1)}%)`);

// 第二關:報酬(訓練段前 10% cell,在驗收段的事件 vs **同產業全部事件**)
function verify(train, test, name) {
  const { top, bot } = topCells(train, 0.1);
  const indOf = new Set([...top].map(k => k.split('|')[1]));
  const base = test.filter(e => indOf.has(e.ind)).map(e => e.ret);      // ⭐ 共用產業那條腿
  const hit = test.filter(e => top.has(e.b + '|' + e.ind)).map(e => e.ret);
  const miss = test.filter(e => bot.has(e.b + '|' + e.ind)).map(e => e.ret);
  console.log(`  ${name}: 前段班事件 n=${hit.length} → ${f1(avg(hit) - avg(base))}pp(vs 同產業全部)・` +
    `後段班 n=${miss.length} → ${f1(avg(miss) - avg(base))}pp ・頭尾差 ${f1(avg(hit) - avg(miss))}pp(成本 ${COST})`);
}
console.log(`\n═══ ② 驗收段報酬(10 日,扣同期加權)═══`);
verify(h1, h2, '正向(前半學 → 後半考)');
verify(h2, h1, '反向(後半學 → 前半考)');

// 對照:per-broker(不分產業)同樣做,看「×產業」有沒有比「整家券商」多出東西
function topBrokers(rows, frac) {
  const m = new Map();
  for (const e of rows) (m.get(e.b) || m.set(e.b, []).get(e.b)).push(e.ret);
  const ranked = [...m.entries()].filter(([, a]) => a.length >= 200).map(([k, a]) => [k, avg(a)]).sort((a, b) => b[1] - a[1]);
  const n = Math.max(1, Math.floor(ranked.length * frac));
  return new Set(ranked.slice(0, n).map(x => x[0]));
}
const tb1 = topBrokers(h1, 0.1), tb2 = topBrokers(h2, 0.1);
const bi = [...tb1].filter(k => tb2.has(k)).length;
console.log(`\n═══ ③ 對照:per-broker(不分產業)名單穩定度 ═══`);
console.log(`  前半前 10% ${tb1.size} 家 ・後半 ${tb2.size} 家 ・重疊 ${bi} 家 → Jaccard ${(bi / new Set([...tb1, ...tb2]).size * 100).toFixed(1)}%`);

console.log('\n⚠️ 限制:只涵蓋上市(產業別限制)、前 200 家券商、窗口偏多頭;' +
  '\n   ⭐ 判準:①名單 Jaccard 要明顯高於隨機 ②正反向都要正 ③頭尾差 > 成本 —— 三關都過才算存在。');
