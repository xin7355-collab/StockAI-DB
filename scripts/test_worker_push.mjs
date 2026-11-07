#!/usr/bin/env node
/**
 * 🐛 V82.0.3 關掉 App 時的手機推播(cloud-worker/worker.js `pushCandidates` / `scanPushUser`)
 *  ① 報價表的欄位是 z(fetchTwseMisQuote),⭐ 決定性對照:舊寫法讀 q.price → 同一份報價 0 則(重現「從來沒送過」)
 *  ② 跌破成本 −5% / −10%、到價(站上 / 跌到)各一則;沒到不發
 *  ③ ⛔ 不送:ETF(00 開頭)・👑 的持股(選 👑)・價格 / 成本不是正數
 *  ④ App `_syncPushSub` 同步前排除 ETF(`_isEtfSym`)與大跌撿便宜「我有買」那幾檔(`_dipMine`)——靜態釘 + 實跑一次
 *  ⑤ scanPushUser 走 pushCandidates(⛔ 第二份判斷)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
const W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const tmp = path.join(ROOT, 'scripts', `.tmp_worker_push_${process.pid}.mjs`);
fs.writeFileSync(tmp, W);
let M; try { M = await import(pathToFileURL(tmp).href); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
const { pushCandidates } = M;
ok('⓪ export pushCandidates', typeof pushCandidates === 'function');

// fetchTwseMisQuote 的真實形狀:{ z, y, pct, v, o, h, l }(⛔ 沒有 price)
const Q = (z, y = z) => ({ z, y, pct: (z - y) / y * 100, v: 1000, o: y, h: Math.max(y, z), l: Math.min(y, z) });
const quotes = new Map([
    ['2330', Q(940, 1000)],    // 成本 1000 → −6%:破 −5%
    ['2454', Q(880, 1000)],    // 成本 1000 → −12%:破 −10%
    ['2317', Q(990, 1000)],    // −1%:沒事
    ['0050', Q(150, 200)],     // ETF −25%:⛔ 不送
    ['3008', Q(2100, 2000)],   // 到價:站上 2050
]);
const rec = {
    strategy: 'gene',
    inventory: [{ sym: '2330', cost: 1000, name: '甲' }, { sym: '2454', cost: 1000, name: '乙' }, { sym: '2317', cost: 1000, name: '丙' }, { sym: '0050', cost: 200, name: 'ETF' }],
    triggers: [{ sym: '3008', dir: 'gte', px: 2050, name: '丁' }, { sym: '2317', dir: 'lte', px: 900, name: '丙' }],
};
const s = pushCandidates(rec, quotes, '2026-11-07');
const ks = s.map(x => x.k);
ok('② 跌破成本 −5% 那一檔 → 一則(hard5)', ks.includes('hard5:2330:2026-11-07'), ks.join(','));
ok('② 跌破成本 −10% 那一檔 → 一則(abs10,⛔ 同時再發 −5%)', ks.includes('abs10:2454:2026-11-07') && !ks.includes('hard5:2454:2026-11-07'), ks.join(','));
ok('② 沒破線的 ⛔ 發', !ks.some(k => /:2317:2026/.test(k)), ks.join(','));
ok('② 到價(站上)→ 一則;沒到的(跌到 900)⛔ 發', ks.includes('trig:3008:gte:2050') && !ks.includes('trig:2317:lte:900'), ks.join(','));
ok('③ ETF(00 開頭)⛔ 送停損', !ks.some(k => /0050/.test(k)), ks.join(','));
ok('② 總數 = 3', s.length === 3, ks.join(','));

// ① ⭐ 決定性對照:舊寫法(讀 q.price)用同一份報價 → 一則都沒有(= 從來沒送過的原因)
const oldPx = q => q && +q.price;
const oldCount = rec.inventory.filter(it => { const p = oldPx(quotes.get(it.sym)); return p > 0 && p <= it.cost * 0.95; }).length
    + rec.triggers.filter(t => { const p = oldPx(quotes.get(t.sym)); return p > 0 && (t.dir === 'gte' ? p >= t.px : p <= t.px); }).length;
ok('① ⭐ 決定性對照:舊寫法讀 q.price → 同一份報價 0 則(新寫法 3 則)', oldCount === 0 && s.length === 3, `舊 ${oldCount} / 新 ${s.length}`);
ok('① 原始碼 ⛔ 再出現只讀 q.price 的寫法', !/const price = q && \+q\.price;/.test(W));

// ③ 👑:選 👑 時個股 ⛔ 送停損(到價照送,那是你自己設的)
const sl = pushCandidates({ ...rec, strategy: 'lead' }, quotes, '2026-11-07');
ok('③ 選 👑 → 個股停損 0 則、到價照送', !sl.some(x => /^(hard5|abs10):/.test(x.k)) && sl.some(x => x.k === 'trig:3008:gte:2050'), sl.map(x => x.k).join(','));
// ③ 價格 / 成本不是正數 → ⛔ 發
const bad = pushCandidates({ strategy: 'gene', inventory: [{ sym: '2330', cost: 0 }, { sym: '9999', cost: 100 }], triggers: [] }, quotes, '2026-11-07');
ok('③ 成本 0 / 沒有報價 → 0 則', bad.length === 0, JSON.stringify(bad));
ok('③ rec 是空的也不丟例外', Array.isArray(pushCandidates(null, quotes, 'x')) && pushCandidates(null, quotes, 'x').length === 0);

// ⑤ scanPushUser 一定走 pushCandidates(⛔ 第二份判斷)
const scanBody = (W.match(/async function scanPushUser[\s\S]*?\n}\n/) || [''])[0];
ok('⑤ scanPushUser 走 pushCandidates', /pushCandidates\(rec, liveQuotes, today\)/.test(scanBody) && !/q\.price/.test(scanBody), scanBody.slice(0, 200));

// ④ App 端:同步前排除 ETF 與大跌撿便宜那幾檔(靜態 + 實跑)
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const syncBody = (IDX.match(/async _syncPushSub\(subArg\) \{[\s\S]*?\n    \},\n/) || [''])[0];
ok('④ _syncPushSub 排除 ETF(_isEtfSym)', /!this\._isEtfSym\(i\.symbol\)/.test(syncBody), syncBody.slice(0, 300));
ok('④ _syncPushSub 排除大跌撿便宜(_dipMine)', /this\._dipMine\(\)/.test(syncBody) && /!dipSet\.has\(/.test(syncBody));
ok('④ 有標「我有買」但批次還沒讀 → 先讀再排除(⛔ 讀不到就漏掉)', /_dipMineTs\(\)\.length && !this\._dipPick\(\)/.test(syncBody) && /_loadDipData\(\)/.test(syncBody));

// ④ 實跑:把 _syncPushSub 抽出來,餵假 app 物件
const fnSrc = syncBody.replace(/^\s*async _syncPushSub\(subArg\) \{/, 'async function(subArg) {').replace(/\},\n$/, '}');
let sent = null;
const fakeApp = {
    settings: { workerUrl: 'https://w.example' },
    inventory: [{ symbol: '2330', cost: 1000 }, { symbol: '0050', cost: 200 }, { symbol: '1815', cost: 120 }, { symbol: '2454', cost: 0 }],
    priceAlerts: [],
    _swReg: { pushManager: { getSubscription: async () => ({ toJSON: () => ({ endpoint: 'https://p' }) }) } },
    getStockName: s => s,
    _isEtfSym: s => /^00/.test(String(s)),
    _dipMineTs: () => ['2026-11-05'],
    _dipPick: () => null,
    _loaded: false,
    async _loadDipData() { this._loaded = true; },
    _dipMine() { return this._loaded ? new Set(['1815']) : new Set(); },
    _strat: () => 'gene',
};
const fakeFetch = async (u, o) => { sent = JSON.parse(o.body); return { json: async () => ({}) }; };
// navigator / fetch 用參數遮蔽(Node 22 的 globalThis.navigator 只能讀)
const fn = new Function('navigator', 'fetch', 'return ' + fnSrc)({ serviceWorker: {} }, fakeFetch);
await fn.call(fakeApp, { toJSON: () => ({ endpoint: 'https://p' }) });
const syms = sent ? sent.inventory.map(i => i.sym) : [];
ok('④ 實跑:送出去的庫存只有 2330(ETF 0050、大跌撿便宜 1815、成本 0 的都排除)', syms.join(',') === '2330', syms.join(','));
ok('④ 實跑:批次還沒讀 → 先讀了才排除(決定性:沒讀的話 1815 會被送出去)', fakeApp._loaded === true);

console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全過');
process.exit(fails.length ? 1 : 0);
