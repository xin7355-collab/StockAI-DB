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
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const NEWS = process.argv[2];
if (!NEWS || !fs.existsSync(NEWS)) { console.error('用法:node scripts/news_event_probe.mjs <新聞 json>'); process.exit(1); }

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
const raw = JSON.parse(fs.readFileSync(NEWS, 'utf8'));
const tpe = ts => new Date((+ts + 8 * 3600) * 1000).toISOString().slice(0, 10);   // ⭐ publishAt → 台北日期
const TICK = /\((\d{4,6})-TW\)/g;

// ⛔ 情緒規則是**明文寫死並印出來**的(⛔ 不用 AI;規則本身要能被檢視才敢用)
const POS = ['大漲', '漲停', '創新高', '創高', '看好', '調升', '上修', '獲利創', '營收創', '接單', '急單', '滿載', '擴產', '漲價', '報價上漲', '結盪', '受惠', '得標', '通過認證', '外資買超', '投信買超', '目標價調升'];
const NEG = ['大跌', '跌停', '創新低', '重挫', '看壞', '調降', '下修', '虧損', '衰退', '砍單', '減產', '降價', '殺價', '停工', '罰款', '起訴', '搜索', '掏空', '下市', '外資賣超', '目標價調降', '示警'];
const tone = t => {
  const p = POS.filter(k => t.includes(k)).length, n = NEG.filter(k => t.includes(k)).length;
  return p > n ? 'pos' : n > p ? 'neg' : 'neu';
};

const evByStock = new Map();     // sym -> [{d(新聞台北日), tone, nSameDay}]
let nTick = 0, nNoTick = 0;
const dayCount = new Map();      // `${sym}|${d}` -> 幾則
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
const newsDays = [...new Set(raw.map(a => tpe(a.publishAt)))].sort();
console.log(`\n📰 新聞 ${raw.length} 筆 ・台北日期 ${newsDays[0]} ~ ${newsDays[newsDays.length - 1]}`);
console.log(`   抓得到台股代號 ${nTick} 筆(${(nTick / raw.length * 100).toFixed(1)}%)・涵蓋 ${evByStock.size} 檔`);
console.log(`   ⛔ 情緒是**關鍵詞規則**判的(不是 AI):利多詞 ${POS.length} 個 / 利空詞 ${NEG.length} 個`);

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
