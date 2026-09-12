#!/usr/bin/env node
/**
 * 📰 消息面事件研究(V74.3.1)—— 本專案**第一次**真的回測新聞
 *
 * ⭐ 背景:本專案已經三次寫下「消息面無法回測」(漲停預測 / 跌停回彈 / 事件研究),
 *    真因是 `stock_news.json` 只有當前快照。V74.2.8 起自己開始存,但要等 3 個月。
 *    ⭐⭐ 使用者上傳的 EventSignal 專案帶了一份 **鉅亨網 2026-01 ~ 07 的新聞(含全文)**
 *    → **現在就測得動**,不用等。
 *
 * 🎯 為什麼這份資料可以用(⛔ 另外兩份不行):
 *    鉅亨網內文固定寫成「群創 (3481-TW)」→ **代號直接印在文章裡**,
 *    可以用 regex 精準抽取,⛔ 不必靠股名比對(那會踩「南亞 ⊂ 南亞科」那類子字串問題)。
 *    實測 5,409 筆裡 **78.3% 抓得到代號**、涵蓋 1,351 檔、每則平均 2.4 檔。
 *
 * 🚨 三個一定要照做的地方(⛔ 少一個結論就不能用):
 *   ① **時間戳要用 `publishAt` 轉台北,⛔ 不可用 `date` 欄位** ——
 *      實測 `date='2026-01-01'` 那筆的實際發布時間是**台北 01-02 20:34**(date 是 UTC 日期)。
 *      差一天在事件研究裡就是前視偏誤。
 *   ② **進場一律「新聞日之後的第一個交易日開盤」** ——
 *      實測發布時間高峰在 **17:00~20:00(盤後)**,當天收盤價你買不到。
 *   ③ 報酬**扣同期加權指數**;同檔同類 10 日內只算一次;對照組 = 同一批(股·日)全部。
 *
 * ⛔ 情緒判定用**明文關鍵詞規則**,⛔ 不用 AI(禁 AI 算數鐵則),而且規則印在報告裡讓人檢視。
 *    ⭐ 但主結論用的是「**有沒有新聞**」這種零主觀的切法 —— 那才是最乾淨的第一個問題。
 *
 * 用法:node scripts/news_event_probe.mjs <cnyes_news_2026.json>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const ARGV = process.argv.slice(2);
const SELFTEST = ARGV.includes('--selftest');
const HIST = ARGV.includes('--hist');
const NEWS = ARGV.find(a => !a.startsWith('--'));
// 🗞️ --hist:改吃**本站自己存的** data/news_hist.json(V74.2.8 起累積)
const HISTF = process.env.NEWS_HIST || path.join(DATA, 'news_hist.json');
// 🚧 資料量守門(⛔ 不可省、⛔ 不可用環境變數調鬆 —— 調鬆等於拿雜訊當結論)
const MIN_DAYS = 60;    // 交易日
const MIN_EV = 300;     // 「算得出 10 日報酬」的事件數
if (SELFTEST) { runSelftest(); process.exit(0); }
if (!HIST && (!NEWS || !fs.existsSync(NEWS))) {
  console.error('用法:node scripts/news_event_probe.mjs <新聞 json>   (外部新聞資料集)');
  console.error('     node scripts/news_event_probe.mjs --hist        (本站自己的 data/news_hist.json)');
  console.error('     node scripts/news_event_probe.mjs --hist --selftest');
  process.exit(1);
}
if (HIST && !fs.existsSync(HISTF)) { console.error(`❌ 找不到 ${HISTF}`); process.exit(1); }

const HOR = [1, 3, 5, 10, 20];
const COST = 0.44;
const DEDUP = 10;

// ── 大盤(扣同期)──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && +r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) {
  const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
  if (d) { mkt.set(d, +r.close); mdays.push(d); }
}
mdays.sort();
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktRet = (d, n) => {
  const i = mIdx.get(d); if (i == null || i + n >= mdays.length) return null;
  const a = mkt.get(mdays[i]), b = mkt.get(mdays[i + n]);
  return a > 0 ? (b / a - 1) * 100 : null;
};

// ── 新聞 ──
const raw = HIST ? [] : JSON.parse(fs.readFileSync(NEWS, 'utf8'));
const tpe = ts => new Date((+ts + 8 * 3600) * 1000).toISOString().slice(0, 10);   // ⭐ publishAt → 台北日期
const TICK = /\((\d{4,6})-TW\)/g;

// ⛔ 情緒規則是**明文寫死並印出來**的(⛔ 不用 AI;規則本身要能被檢視才敢用)
const POS = ['大漲', '漲停', '創新高', '創高', '看好', '調升', '上修', '獲利創', '營收創', '接單', '急單', '滿載', '擴產', '漲價', '報價上漲', '結盪', '受惠', '得標', '通過認證', '外資買超', '投信買超', '目標價調升'];
const NEG = ['大跌', '跌停', '創新低', '重挫', '看壞', '調降', '下修', '虧損', '衰退', '砍單', '減產', '降價', '殺價', '停工', '罰款', '起訴', '搜索', '掏空', '下市', '外資賣超', '目標價調降', '示警'];
const tone = t => {
  const p = POS.filter(k => t.includes(k)).length, n = NEG.filter(k => t.includes(k)).length;
  return p > n ? 'pos' : n > p ? 'neg' : 'neu';
};

const evByStock = new Map();     // sym -> [{d(新聞台北日), tone}]
let nTick = 0, nNoTick = 0, nItems = 0;
const dayCount = new Map();      // `${sym}|${d}` -> 幾則
let newsDays = [];

if (HIST) {
  // 🗞️ 本站自己的歷史:days[日期][代號] = [[標題, AI判的tone, 分類], …]
  // ⛔⛔ **不讀檔案裡那個 tone 欄** —— 它是採礦端 **AI** 判的(universal_radar 的 ai_sentiment),
  //     ① 不可重現 ② 本站的 Groq 模型被下架換過(V73.9.0)→ 前後幾個月定義不一樣
  //     ③ 已測那一輪用的是上面那份**關鍵詞規則** → 兩者同名不同義。
  //     ⭐ 所以一律拿**標題**重判一次,才叫「用同一個定義重測」。
  const H = JSON.parse(fs.readFileSync(HISTF, 'utf8'));
  const days = (H && H.days) || {};
  for (const d of Object.keys(days).sort()) {
    const byS = days[d] || {};
    for (const sym of Object.keys(byS)) {
      const items = byS[sym];
      if (!Array.isArray(items) || !items.length) continue;
      if (!/^\d{4,6}$/.test(sym)) continue;
      nTick++;
      if (!evByStock.has(sym)) evByStock.set(sym, []);
      for (const it of items) {
        const title = Array.isArray(it) ? String(it[0] || '') : String((it && it.title) || '');
        if (!title) continue;
        nItems++;
        evByStock.get(sym).push({ d, tone: tone(title) });
        dayCount.set(`${sym}|${d}`, (dayCount.get(`${sym}|${d}`) || 0) + 1);
      }
    }
  }
  newsDays = Object.keys(days).sort();
  const tradeDays = newsDays.filter(d => mIdx.has(d));
  console.log(`\n🗞️ 本站自己的消息面歷史 ${HISTF}`);
  console.log(`   ${newsDays.length} 天(其中交易日 ${tradeDays.length} 天)・${nItems} 則 ・涵蓋 ${evByStock.size} 檔 ・(股·日) ${dayCount.size} 筆`);
  console.log(`   台北日期 ${newsDays[0] || '-'} ~ ${newsDays[newsDays.length - 1] || '-'}`);
  console.log(`   ⛔ 情緒**用標題重判**(關鍵詞規則,利多 ${POS.length} 詞 / 利空 ${NEG.length} 詞),⛔ 不用檔案裡 AI 判的那欄`);
  console.log(`   ⚠️ 這裡的日期是**採礦當天**不是發布時間 → 但進場仍是「之後第一個交易日開盤」,`);
  console.log(`      而採礦日 ≥ 發布日 → 方向是**保守的**,⛔ 不會前視。`);
  if (tradeDays.length < MIN_DAYS) {
    console.log(`\n🚧 資料量守門:交易日只有 **${tradeDays.length} 天**,還差 **${MIN_DAYS - tradeDays.length} 天**(門檻 ${MIN_DAYS})`);
    console.log(`   ⛔ 一個結論都不給 —— 這種樣本跑出來的數字是雜訊,印出來就會被當成結論。`);
    console.log(`   ℹ️ 時鐘從 2026-09-09 才真的開始跑(在那之前 news_express 被排程配額餓死 35 天)。\n`);
    process.exit(1);
  }
} else {
  for (const a of raw) {
    const d = tpe(a.publishAt);
    const txt = (a.title || '') + '\n' + (a.content || '');
    const codes = new Set();
    let m; TICK.lastIndex = 0;
    while ((m = TICK.exec(txt))) codes.add(m[1]);
    if (!codes.size) { nNoTick++; continue; }
    nTick++;
    const tn = tone(a.title || '');
    for (const c of codes) {
      if (!evByStock.has(c)) evByStock.set(c, []);
      evByStock.get(c).push({ d, tone: tn });
      dayCount.set(`${c}|${d}`, (dayCount.get(`${c}|${d}`) || 0) + 1);
    }
  }
  newsDays = [...new Set(raw.map(a => tpe(a.publishAt)))].sort();
  console.log(`\n📰 新聞 ${raw.length} 筆 ・台北日期 ${newsDays[0]} ~ ${newsDays[newsDays.length - 1]}`);
  console.log(`   抓得到台股代號 ${nTick} 筆(${(nTick / raw.length * 100).toFixed(1)}%)・涵蓋 ${evByStock.size} 檔`);
  console.log(`   ⛔ 情緒是**關鍵詞規則**判的(不是 AI):利多詞 ${POS.length} 個 / 利空詞 ${NEG.length} 個`);
}

// ── 個股 K 線 ──
const buckets = new Map();
const add = (k, ev) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ev); };
const lastSeen = new Map();

const files = new Set(fs.readdirSync(DATA).filter(f => /^\d{4,6}\.json$/.test(f)).map(f => f.replace('.json', '')));
let used = 0, noFile = 0;
const WIN_FROM = newsDays[0], WIN_TO = newsDays[newsDays.length - 1];

for (const [sym, evs] of evByStock) {
  if (!files.has(sym)) { noFile++; continue; }
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 260) continue;
  const R = rows.filter(r => r && +r.close > 0 && +r.open > 0).map(r => ({
    d: String(r.date || '').replace(/\//g, '-').slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c: +r.close,
  })).filter(r => r.d);
  if (R.length < 260) continue;
  used++;
  const idxByDate = new Map(R.map((r, i) => [r.d, i]));
  // 新聞日 → 之後第一個交易日(⭐ 盤後發布佔多數 → 一律隔天開盤進場)
  const nextTrade = d => {
    for (let k = 0; k < 8; k++) {
      const t = new Date(Date.parse(d + 'T00:00:00Z') + (k + 1) * 86400000).toISOString().slice(0, 10);
      if (idxByDate.has(t)) return idxByDate.get(t);
    }
    return null;
  };
  const emit = (key, e, dNews) => {
    const kk = `${key}|${sym}`;
    const prev = lastSeen.get(kk);
    if (prev != null && Math.abs(e - prev) < DEDUP) return;
    if (Math.abs(R[e].o / R[e - 1]?.c - 1) >= 0.097 && Math.abs(R[e].h - R[e].l) < 1e-9) return;  // 開盤即鎖死 → 買不到
    const ret = { _d: R[e].d, _nd: dNews };
    for (const n of HOR) {
      const j = e + n;
      if (j >= R.length) { ret[n] = null; continue; }
      const m = mktRet(R[e].d, n);
      ret[n] = m == null ? null : (R[j].c / R[e].o - 1) * 100 - m;
    }
    lastSeen.set(kk, e);
    ret._s = sym;                 // ⭐ 記下是哪一檔 —— 下面要算「成分集中度」
    add(key, ret);
  };

  // ── 對照組:這檔在**新聞窗口內**的每一個交易日(⛔ 不抽樣)──
  for (let i = 1; i < R.length - 1; i++) {
    if (R[i].d < WIN_FROM || R[i].d > WIN_TO) continue;
    emit('對照組(窗口內所有交易日)', i, R[i].d);
  }
  // ── 事件 ──
  const byDay = new Map();
  for (const ev of evs) {
    if (!byDay.has(ev.d)) byDay.set(ev.d, []);
    byDay.get(ev.d).push(ev.tone);
  }
  for (const [d, tones] of byDay) {
    const e = nextTrade(d);
    if (e == null || e < 1 || e >= R.length - 1) continue;
    const n = tones.length;
    emit('📰 有新聞(全部)', e, d);
    emit(n >= 3 ? '📰 同日 ≥3 則(被大量報導)' : n === 2 ? '📰 同日 2 則' : '📰 同日只有 1 則', e, d);
    const p = tones.filter(t => t === 'pos').length, g = tones.filter(t => t === 'neg').length;
    emit(p > g ? '🟥 標題偏利多(規則判)' : g > p ? '🟩 標題偏利空(規則判)' : '➖ 標題中性', e, d);
  }
}
console.log(`   個股 K 線:用到 ${used} 檔(${noFile} 檔在 data/ 裡沒有,多半是美股/沒上市)\n`);

// 🚧 第二道資料量守門(⭐ 天數夠不代表**算得完 10 日報酬** —— 最後 10 個交易日的事件是算不出來的)
if (HIST) {
  const all = buckets.get('📰 有新聞(全部)') || [];
  const ok10 = all.filter(e => e[10] != null).length;
  if (ok10 < MIN_EV) {
    console.log(`🚧 資料量守門:算得出 10 日報酬的事件只有 **${ok10} 筆**,還差 **${MIN_EV - ok10} 筆**(門檻 ${MIN_EV})`);
    console.log('   ⛔ 一個結論都不給。\n');
    process.exit(1);
  }
  console.log(`✅ 資料量守門通過:算得出 10 日報酬的事件 ${ok10} 筆(門檻 ${MIN_EV})\n`);
}

// ── 統計 ──
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const base = buckets.get('對照組(窗口內所有交易日)') || [];
if (base.length < 5000) { console.log(`❌ 空過守門:對照組只有 ${base.length} 筆 → 資料沒接上,⛔ 不下結論`); process.exit(1); }
const bAvg = {}, bWin = {};
for (const n of HOR) {
  const v = base.map(e => e[n]).filter(x => x != null);
  bAvg[n] = avg(v); bWin[n] = v.filter(x => x > 0).length / v.length * 100;
}
console.log(`📊 對照組 ${base.length.toLocaleString()} 個(股·日)・平均超額 1日 ${bAvg[1].toFixed(2)}% / 10日 ${bAvg[10].toFixed(2)}% / 20日 ${bAvg[20].toFixed(2)}%`);
console.log(`   對照組勝率:10日 ${bWin[10].toFixed(1)}% ・20日 ${bWin[20].toFixed(1)}%  ⚠️ 基準本來就是負的,⛔ 不是 0 也不是 50%\n`);

const pad = (s, n) => { let w = 0; for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(1, n - w)); };
const num = (x, d = 2) => x == null ? '  --' : (x >= 0 ? '+' : '') + x.toFixed(d);

const rows = [];
for (const [k, evs] of buckets) {
  if (k.startsWith('對照組')) continue;
  const r = { k, n: evs.length };
  for (const n of HOR) {
    const v = evs.map(e => e[n]).filter(x => x != null);
    r[`e${n}`] = v.length ? avg(v) - bAvg[n] : null;
    if (n === 10) { r.w = v.length ? v.filter(x => x > 0).length / v.length * 100 : null; r.med = med(v); }
  }
  rows.push(r);
}
// 🚨🚨 成分集中度 —— **這一欄比報酬還重要**。
//    ⚠️ **未去重**的原始事件裡,「同日 ≥3 則」台積電一檔就佔 49%、前三大佔 77%
//    → 看起來像是「台積電那半年漲很多」被誤讀成事件效果。
//    ⭐ 但**10 日去重之後前三大只剩 17%**(台積電被壓成 8%)—— 去重已經處理掉洗版問題。
//    ⛔ 這一欄仍然要印:沒有它就分不出「訊號」與「幾檔股票的表現」,而且**只有印出來才看得到**。
for (const r of rows) {
  const c = new Map();
  for (const e of buckets.get(r.k)) c.set(e._s, (c.get(e._s) || 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]);
  r.nSym = c.size;
  r.top1 = top[0] ? top[0][1] / r.n * 100 : 0;
  r.top3 = top.slice(0, 3).reduce((s2, x) => s2 + x[1], 0) / r.n * 100;
  r.topNm = top.slice(0, 3).map(x => `${x[0]}:${(x[1] / r.n * 100).toFixed(0)}%`).join(' / ');
}
rows.sort((a, b) => (b.e10 ?? -99) - (a.e10 ?? -99));
console.log(pad('事件', 30) + '     n     1日    3日    5日   10日   20日  |10日勝率 10日中位  檔數 前3大佔比(誰)');
console.log('─'.repeat(126));
for (const r of rows) {
  console.log(pad(r.k, 30) + String(r.n).padStart(6)
    + num(r.e1).padStart(7) + num(r.e3).padStart(7) + num(r.e5).padStart(7)
    + num(r.e10).padStart(7) + num(r.e20).padStart(7)
    + ('  ' + (r.w == null ? '--' : r.w.toFixed(1) + '%')).padStart(10)
    + num(r.med).padStart(9)
    + String(r.nSym).padStart(6)
    + ('  ' + r.top3.toFixed(0) + '% (' + r.topNm + ')').padEnd(30));
}
const conc = rows.filter(r => r.top3 >= 40);
if (conc.length) {
  console.log('\n🚨 成分過度集中(前 3 檔就佔 ≥40%)→ ⛔ 那不是「事件」的效果,是那幾檔那段期間的表現:');
  for (const r of conc) console.log(`   ・${r.k}:只有 ${r.nSym} 檔,前 3 大佔 ${r.top3.toFixed(0)}%(${r.topNm})`);
}

// ── 穩健性:前後半 + 逐月 + 去最好月 + 扣成本 ──
const allD = base.map(e => e._d).sort();
const MID = allD[Math.floor(allD.length / 2)];
const MONS = [...new Set(allD.map(d => d.slice(0, 7)))].sort();
console.log(`\n████ 🚧 穩健性檢定(只看 10 日;⭐ 邊際要 > 成本 ${COST}pp 才算數)████`);
console.log(`   樣本期間 ${allD[0]} ~ ${allD[allD.length - 1]} ・中點 ${MID} ・逐月涵蓋 ${MONS.join(' / ')}`);
const sub = (evs, f) => evs.filter(f).map(e => e[10]).filter(x => x != null);
const bSub = f => { const v = sub(base, f); return v.length ? avg(v) : null; };
console.log('\n' + pad('事件', 30) + ' 全期    前半    後半   |' + MONS.map(m => m.slice(5)).join('     ') + '  一致 去最好月 扣成本');
console.log('─'.repeat(118));
for (const r of rows) {
  const evs = buckets.get(r.k);
  const h1 = sub(evs, e => e._d < MID), h2 = sub(evs, e => e._d >= MID);
  const b1 = bSub(e => e._d < MID), b2 = bSub(e => e._d >= MID);
  const e1 = h1.length >= 40 ? avg(h1) - b1 : null, e2 = h2.length >= 40 ? avg(h2) - b2 : null;
  const mo = {};
  for (const m of MONS) {
    const v = sub(evs, e => e._d.startsWith(m)), bv = bSub(e => e._d.startsWith(m));
    mo[m] = v.length >= 40 && bv != null ? avg(v) - bv : null;
  }
  const ms = Object.values(mo).filter(x => x != null);
  let exBest = null;
  if (ms.length >= 3) {
    const bm = Object.entries(mo).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0][0];
    const v = sub(evs, e => !e._d.startsWith(bm)), bv = bSub(e => !e._d.startsWith(bm));
    exBest = v.length >= 40 && bv != null ? avg(v) - bv : null;
  }
  const same = e1 != null && e2 != null && Math.sign(e1) === Math.sign(e2);
  const mSame = ms.length >= 3 && ms.every(x => Math.sign(x) === Math.sign(ms[0]));
  const net = (r.e10 ?? 0) - COST;
  console.log(pad(r.k, 30) + num(r.e10).padStart(6) + num(e1).padStart(8) + num(e2).padStart(8) + (same ? ' ✅' : ' ❌')
    + ' |' + MONS.map(m => num(mo[m], 1).padStart(6)).join('') + (mSame ? ' ✅' : ' ❌')
    + num(exBest).padStart(8) + num(net).padStart(8)
    + ((net > 0 && same && mSame && (exBest ?? -9) > 0) ? ' ⭐全過' : ''));
}
console.log('\n⚠️ 讀這份報告的規則');
console.log('  ① 數字 = 相對「同一批股票在同一段窗口的所有交易日」的超額 pp,⛔ 不是跟 0 比。');
console.log('  ② 進場 = **新聞日之後第一個交易日的開盤**(發布高峰在盤後 17~20 點,當天收盤買不到);已排除開盤鎖死。');
console.log(`  ③ 窗口只有 ${MONS.length} 個月且**整段偏多頭** → ⛔ 不可外推;逐月那一關特別嚴是刻意的。`);
console.log('  ④ 情緒是**關鍵詞規則**判的,⛔ 不是 AI,也沒有經過人工標註驗證 → 那兩列只能當粗略參考。');
console.log('  ⑤ 資料只有鉅亨網一家 → 有來源偏誤;而且「有新聞」本身跟「成交量大/市值大」高度相關。\n');

// ═══════════════════════════════════════════════════════════════════
// 🧪 --selftest:合成資料驗「這支探針量得到已知的邊際、也量得到『沒有邊際』」
//    ⭐ CLAUDE.md 陷阱 #40:「檢查工具沒報錯」⛔ 不等於「它有能力報錯」
//       → 每一條斷言都配一組會讓它變成另一個答案的對照。
// ═══════════════════════════════════════════════════════════════════
function runSelftest() {
  const SELF = new URL(import.meta.url).pathname;
  const ok = (t, c) => { console.log((c ? '✅' : '❌') + ' ' + t); if (!c) process.exitCode = 1; };

  // ── 造交易日(跳週末)──
  const mkDays = n => {
    const out = []; const d = new Date(Date.UTC(2026, 8, 11));
    while (out.length < n) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out.reverse();
  };

  // ── 造一整組合成資料;edge = 事件後 10 根累積漲幅(0 = 沒有邊際)──
  const build = (newsTradeDays, edge) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newshist-'));
    const BARS = 400, PAD = 30;                       // ⭐ 新聞窗口之後留 30 根,10/20 日報酬才算得完
    const days = mkDays(BARS);
    const winEnd = BARS - PAD - 1, winStart = winEnd - newsTradeDays + 1;
    fs.writeFileSync(path.join(dir, '^TWII.json'),
      JSON.stringify(days.map(d => ({ date: d, close: 10000 }))));   // 大盤打平 → 超額 = 原始報酬

    // ⚠️ 對照組也吃 DEDUP=10(每檔 10 個交易日才留 1 筆)→ 要湊過既有的「對照組 ≥5000」空過守門,
    //    檔數與窗口都不能小(300 檔 × 180 交易日 ÷ 10 ≈ 5,400)
    const SYMS = Array.from({ length: 300 }, (_, i) => String(1001 + i));
    const hist = { updated: 'selftest', days_kept: 500, days: {} };
    SYMS.forEach((sym, si) => {
      const g = new Array(BARS).fill(0);
      // ⭐ 每檔錯開起點 → 窗口內**每一天**都有新聞(不然合成出來只有幾天,守門會擋掉),
      //    但同一檔間隔 30 根:① > DEDUP 10 不會被去重吃掉
      //    ② ⚠️ 對照組是「窗口內每一個交易日」,它也會吃到漲幅 → 間隔太密會把邊際稀釋掉
      //       (間隔 12 時 +5% 只量到 +0.55pp;間隔 30 才拉得開 → 注入要**看得出來**才算注得進去)
      for (let i = winStart + (si % 30); i <= winEnd; i += 30) {
        const d = days[i];
        (hist.days[d] ||= {})[sym] ||= [];
        // 🚨 標題是**利多**、但 tone 欄故意寫 'neg' —— 用來證明探針讀的是標題不是那個 AI 欄位
        hist.days[d][sym].push(['營收創新高 接單滿載', 'neg', '📊 財務事件']);
        const e = i + 1;                                             // 進場 = 隔一個交易日開盤
        for (let k = 0; k < 10; k++) if (e + k < BARS) g[e + k] += Math.pow(1 + edge, 0.1) - 1;
      }
      const rows = []; let c = 100;
      for (let i = 0; i < BARS; i++) {
        const o = c; c = c * (1 + g[i]);
        rows.push({ date: days[i], open: +o.toFixed(2), high: +(Math.max(o, c) * 1.005).toFixed(2), low: +(Math.min(o, c) * 0.995).toFixed(2), close: +c.toFixed(2), volume: 1000 });
      }
      fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
    });
    const hf = path.join(dir, 'news_hist.json');
    fs.writeFileSync(hf, JSON.stringify(hist));
    return { dir, hf };
  };

  const run = (b) => {
    try {
      return { rc: 0, out: execFileSync(process.execPath, [SELF, '--hist'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DATA_DIR: b.dir, NEWS_HIST: b.hf } }) };
    } catch (e) { return { rc: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
  };
  // 🔍 SELFTEST_DEBUG=1 才印子行程的完整輸出(排查「注入到底有沒有注進去」時用)
  const dbg = (tag, r) => { if (process.env.SELFTEST_DEBUG) console.log(`--- ${tag} rc=${r.rc} ---\n` + r.out.slice(-3000)); };
  const e10of = out => {
    const i = out.indexOf('穩健性檢定'); if (i < 0) return null;
    const m = out.slice(i).match(/📰 有新聞\(全部\)\s+([+-][\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  };

  console.log('🧪 news_event_probe --hist 自我驗證\n');

  // ① 注入 +5% 邊際 → 一定要量得到
  const A = run(build(180, 0.05)); dbg('A', A);
  ok('① 注入 +5% 邊際:跑得完(rc=0)', A.rc === 0);
  const eA = e10of(A.out);
  ok(`① 注入 +5% 邊際:10 日邊際量得到(實測 ${eA},應 > 2)`, eA != null && eA > 2.0);

  // ② ⭐ 決定性對照:完全沒有邊際的同一組測資 → ⛔ 不可以生出訊號
  const B = run(build(180, 0));
  const eB = e10of(B.out);
  ok(`② 沒有邊際時 ⛔ 不可生出訊號(實測 ${eB})`, eB != null && Math.abs(eB) < 0.5);
  ok('② 兩組差得出來(⛔ 否則等於沒有鑑別力)', eA != null && eB != null && eA - eB > 2.0);

  // ③ ⛔ 不可以讀檔案裡 AI 判的 tone(測資的 tone 全部寫 'neg',標題全是利多)
  ok('③ 情緒用**標題**重判 → 應出現「標題偏利多」而不是偏利空',
    A.out.includes('🟥 標題偏利多(規則判)') && !A.out.includes('🟩 標題偏利空(規則判)'));

  // ④ 資料量守門真的擋得住(⛔ 這一條就是「把守門拿掉會怎樣」的對照)
  const C = run(build(20, 0.05));
  ok('④ 交易日不足 → rc=1', C.rc === 1);
  ok('④ 交易日不足 → 要說「還差幾天」', /還差 \*\*\d+ 天\*\*/.test(C.out));
  ok('④ 交易日不足 → ⛔ 一個結論都不給(不可印出穩健性表)', !C.out.includes('穩健性檢定'));

  console.log(process.exitCode ? '\n❌ 自我驗證有失敗項' : '\n✅ 全部通過');
}
