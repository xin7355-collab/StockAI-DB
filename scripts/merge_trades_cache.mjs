#!/usr/bin/env node
/**
 * 🗃️ V79.4.7 把 portfolio_backtest 分片建的交易快取(`SHARD=k/K` + `TRADES_CACHE=*.ndjson`)合成一份
 *
 *   node --max-old-space-size=8000 scripts/merge_trades_cache.mjs <out.ndjson> <part0.ndjson> <part1.ndjson> …
 *
 * ⭐ 為什麼:🔥 的組合回測以前只抽 600 檔(陷阱 #55:換 41 檔成績差一倍),App 的 🔥 是掃全市場 →
 *   全市場 16 年單一建要 3 個多小時、而且交易約 730MB(超過 node 單一字串上限 512MB)→
 *   改成「一行一筆」的 .ndjson + 分片平行建,合併後跟單一建**逐筆相同、順序也相同**(test_tradecache 釘住)。
 *
 * ⛔ 守門(對不上就 exit 1,⛔ 不寫半套):
 *   ① 每一片的 key(= 引擎 CACHE_KEY)、K、allSyms 都一樣
 *   ② 分片編號 0..K−1 剛好各一份
 *   ③ 每一片自己掃的 syms = allSyms 裡 `i % K === k` 的那些(順序一樣)
 *   ④ 每一筆交易的 sym 都在它那一片的 syms 裡;同一檔的交易在片內是連在一起的
 * 輸出:第一行 `{key}`(⛔ 不帶 shard → 引擎才肯拿它來跑),之後照 allSyms 的順序、一行一筆(原始那一行,⛔ 不重新序列化)
 */
import fs from 'fs';

const [out, ...parts] = process.argv.slice(2);
const die = m => { console.error('❌ ' + m); process.exit(1); };
if (!out || !out.endsWith('.ndjson') || !parts.length) die('用法:node scripts/merge_trades_cache.mjs <out.ndjson> <part.ndjson>…');

const P = parts.map(f => {
    if (!fs.existsSync(f)) die(`${f} 不存在`);
    const buf = fs.readFileSync(f);
    let a = 0, head = null, last = null, n = 0;
    const bySym = new Map();
    while (a < buf.length) {
        let b = buf.indexOf(10, a); if (b < 0) b = buf.length;
        if (b > a) {
            const line = buf.toString('utf8', a, b);
            if (head === null) head = JSON.parse(line);
            else {
                const sym = JSON.parse(line).sym;
                if (typeof sym !== 'string' || !sym) die(`${f} 有一行沒有 sym`);
                if (sym !== last) { if (bySym.has(sym)) die(`${f} 的 ${sym} 交易沒有連在一起(⛔ 不是引擎一檔一檔掃出來的)`); bySym.set(sym, []); last = sym; }
                bySym.get(sym).push(line); n++;
            }
        }
        a = b + 1;
    }
    if (!head || !head.shard || !Array.isArray(head.syms) || !Array.isArray(head.allSyms)) die(`${f} 第一行不是分片表頭(要 SHARD=k/K 建的)`);
    return { f, head, bySym, n };
});

const H0 = P[0].head, K = +String(H0.shard).split('/')[1];
if (!(K >= 1) || P.length !== K) die(`分片數不對:表頭說 K=${K},給了 ${P.length} 份`);
const seen = new Set();
for (const p of P) {
    const [k, kk] = String(p.head.shard).split('/').map(Number);
    if (p.head.key !== H0.key) die(`${p.f} 的 key 跟第一份不一樣(參數不同的快取不可混)`);
    if (kk !== K) die(`${p.f} 的 K=${kk} ≠ ${K}`);
    if (JSON.stringify(p.head.allSyms) !== JSON.stringify(H0.allSyms)) die(`${p.f} 的 allSyms 跟第一份不一樣`);
    if (seen.has(k)) die(`分片 ${k}/${K} 重複`); seen.add(k);
    const want = H0.allSyms.filter((_, i) => i % K === k);
    if (JSON.stringify(p.head.syms) !== JSON.stringify(want)) die(`${p.f} 掃的 syms 不是 allSyms 裡 i % ${K} === ${k} 那些`);
    const own = new Set(p.head.syms);
    for (const s of p.bySym.keys()) if (!own.has(s)) die(`${p.f} 有不屬於它的 ${s}`);
    p.k = k;
}
for (let k = 0; k < K; k++) if (!seen.has(k)) die(`缺分片 ${k}/${K}`);

const owner = new Map();
for (const p of P) for (const s of p.head.syms) owner.set(s, p);
const tmp = out + '.tmp', fd = fs.openSync(tmp, 'w');
let chunk = JSON.stringify({ key: H0.key }) + '\n', nOut = 0, nSym = 0;
for (const s of H0.allSyms) {
    const L = owner.get(s).bySym.get(s); if (!L) continue;
    nSym++;
    for (const line of L) { chunk += line + '\n'; nOut++; if (chunk.length > 1 << 20) { fs.writeSync(fd, chunk); chunk = ''; } }
}
if (chunk) fs.writeSync(fd, chunk);
fs.closeSync(fd);
const nIn = P.reduce((a, p) => a + p.n, 0);
if (nOut !== nIn) { fs.rmSync(tmp, { force: true }); die(`筆數對不上:讀進 ${nIn}、寫出 ${nOut}`); }
fs.renameSync(tmp, out);
console.log(`✅ 合併 ${K} 片 → ${out}:${nSym} 檔有交易 / 全部 ${H0.allSyms.length} 檔 ・${nOut.toLocaleString()} 筆`);
