#!/usr/bin/env node
/**
 * 🔗 把 klines_deep 分支的深歷史(2021-01 起)接到 data/*.json 的**前面**(V74.4.5)
 *
 * ⭐ 目的:個股 K 線原本只有 2023-06 起 → 所有回測結論都來自一段偏多頭的行情。
 *    接上 2021-01 之後就涵蓋 **2022 那次 −32% 空頭**,十幾支「走完空頭要重跑」的探針
 *    現在就能重驗(尤其 🧬 追高+高波動 —— 那正是空頭最容易受傷的組合)。
 *
 * ⛔ 三條設計(改之前先讀):
 *   ① **只補前面、不動既有列** —— 既有列帶著籌碼欄位(foreign_net / trust_net / margin_balance),
 *      深歷史只有 OHLCV。⛔ 覆蓋既有列會把籌碼弄丟,籌碼類打法就全失效了。
 *   ② 舊列的籌碼欄位**留空**(本來 2023-06 之前也沒有)—— ⛔ 不可補 0,
 *      0 跟「沒有」在下游是兩件事(0 會被當成「法人今天沒買沒賣」)。
 *   ③ ⛔ 只寫 data/(本機暫存,gitignore),⛔ 不碰任何分支。壞了從 gh-pages 重抓即可。
 *
 * 用法:node scripts/merge_deep_klines.mjs <klines_deep 解出來的目錄> [data 目錄]
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const SRC = process.argv[2];
const DST = process.argv[3] || 'data';
if (!SRC || !fs.existsSync(SRC)) { console.error('用法:node scripts/merge_deep_klines.mjs <deepDir> [dataDir]'); process.exit(1); }

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.json.gz'));
console.log(`深歷史檔:${files.length}`);
let merged = 0, skipped = 0, noBase = 0, added = 0;
const before = [], after = [];

for (const f of files) {
  const sym = f.replace('.json.gz', '');
  const dstPath = path.join(DST, sym + '.json');
  if (!fs.existsSync(dstPath)) { noBase++; continue; }   // ⛔ 只補既有的檔(⛔ 不新增下市股到 data/,那會混進選股母體)
  let base, deep;
  try {
    base = JSON.parse(fs.readFileSync(dstPath, 'utf8'));
    deep = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SRC, f))).toString('utf8'));
  } catch { skipped++; continue; }
  if (!Array.isArray(base) || !base.length || !deep || !Array.isArray(deep.k)) { skipped++; continue; }
  const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);
  const firstBase = norm(base[0].date);
  before.push(firstBase);
  // 深歷史裡比既有最早日期還早的列 → 轉成 data 格式接到前面
  const pre = [];
  for (const [d, o, h, l, c, v] of deep.k) {
    if (norm(d) >= firstBase) break;                     // ⛔ 到既有範圍就停(⛔ 不覆蓋既有列)
    if (!(c > 0 && o > 0)) continue;
    pre.push({ date: String(d).replace(/-/g, '/'), open: o, high: h, low: l, close: c, volume: v || 0 });
  }
  if (!pre.length) { skipped++; after.push(firstBase); continue; }
  fs.writeFileSync(dstPath, JSON.stringify(pre.concat(base)));
  merged++; added += pre.length;
  after.push(norm(pre[0].date));
}
const med = a => { const b = a.slice().sort(); return b[Math.floor(b.length / 2)] || '-'; };
console.log(`✅ 合併 ${merged} 檔 ・共補 ${added.toLocaleString()} 根 K 線`);
console.log(`   跳過 ${skipped}(沒有更早的資料或格式壞)・data/ 沒有的 ${noBase}(下市股,⛔ 刻意不新增)`);
console.log(`   最早日期中位:${med(before)} → ${med(after)}`);
