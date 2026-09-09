#!/usr/bin/env node
/**
 * 🏦 「法人推估成本」有沒有用?(V74.1.8,雜訊清洗第二波)
 *
 * 卡片(chipRadarPanel)顯示:外資近 20 日**淨買超日**的加權均價 = 推估成本,
 * 以及現價在成本之上(+%,紅)或之下(−%,綠)。隱含的主張是
 * 「站上法人成本比較強 / 跌破比較弱」—— ⛔ 從來沒驗證過 → 驗掉它。
 *
 * 成本定義**照卡片同一條**:cost = Σ(當日外資淨買超⁺ × 收盤) ÷ Σ(當日外資淨買超⁺),
 * 取近 20 日、只算淨買超日(`_renderChipPanel` 的 buyAmt/buyVol)。
 *
 * 事件:
 *   above / below   —— 現價在成本上/下(狀態)
 *   xup / xdn       —— 剛站上 / 剛跌破(昨天在另一邊)
 * 方法論:訊號日收盤進出、扣同期加權、同檔同事件 20 日去重、六道關卡。
 * ⚠️ foreign_net 全深度約 3 年(2023-06 起,V74.0.2 解鎖確認過)。
 *
 * 跑法:node scripts/instcost_probe.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const WIN = 20, DEDUP = 20, COST = 0.44, FWD = 20;

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };

const twii = {};
for (const r of JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')))
    if (+r.close > 0) twii[nd(r.date)] = +r.close;

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f));
const buckets = new Map(), meta = new Map();
const allEx = [], allMeta = [];
let nSym = 0, nWithF = 0;

for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(raw)) continue;
    const rows = raw.filter(x => x && +x.close > 0);
    if (rows.length < 120) continue;
    nSym++;
    const c = rows.map(x => +x.close), d = rows.map(x => nd(x.date));
    const fn = rows.map(x => +x.foreign_net || 0);
    if (!fn.some(v => v !== 0)) continue;
    nWithF++;
    // 推估成本(照卡片同一條公式)
    const cost = new Array(rows.length).fill(null);
    for (let i = WIN; i < rows.length; i++) {
        let bv = 0, ba = 0;
        for (let j = i - WIN + 1; j <= i; j++) if (fn[j] > 0) { bv += fn[j]; ba += fn[j] * c[j]; }
        if (bv > 0) cost[i] = ba / bv;
    }
    const last = {};
    for (let i = WIN + 1; i + FWD < rows.length; i++) {
        if (cost[i] == null || cost[i - 1] == null) continue;
        if (!(d[i] in twii) || !(d[i + FWD] in twii)) continue;
        const ex = (c[i + FWD] / c[i] - 1) * 100 - (twii[d[i + FWD]] / twii[d[i]] - 1) * 100;
        const above = c[i] > cost[i], wasAbove = c[i - 1] > cost[i - 1];
        const keys = [above ? 'above' : 'below'];
        if (above && !wasAbove) keys.push('xup');
        if (!above && wasAbove) keys.push('xdn');
        for (const k of keys) {
            const kk = f.slice(0, 4) + '|' + k;
            if (last[kk] != null && i - last[kk] < DEDUP) continue;
            last[kk] = i;
            if (!buckets.has(k)) { buckets.set(k, []); }
            buckets.get(k).push({ ex, date: d[i] });
        }
        if (last.__all == null || i - last.__all >= DEDUP) {
            last.__all = i; allEx.push(ex); allMeta.push(d[i]);
        }
    }
}

const b = mean(allEx);
console.log(`📊 ${nSym} 檔(有外資資料 ${nWithF})・對照組 ${allEx.length} 個(股·日)`);
console.log(`🎯 對照組 20 日超額:平均 ${b.toFixed(2)}% ・中位 ${med(allEx).toFixed(2)}% ・勝率 ${(allEx.filter(x => x > 0).length / allEx.length * 100).toFixed(1)}%`);
const ds = [...allMeta].sort(), midDate = ds[ds.length >> 1];
const baseYr = {}, baseHalf = [[], []];
allEx.forEach((v, i) => { (baseYr[allMeta[i].slice(0, 4)] ||= []).push(v); baseHalf[allMeta[i] < midDate ? 0 : 1].push(v); });
const yrKeys = Object.keys(baseYr).sort();
console.log(`🗓️ 中點 ${midDate}(依樣本數)`);

const LBL = { above: '現價在法人成本之上(卡片顯紅 +%)', below: '現價在法人成本之下(卡片顯綠 −%)', xup: '⤴️ 剛站上法人成本', xdn: '⤵️ 剛跌破法人成本' };
const fmt = v => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2);
console.log(`\n事件                                    n      邊際   中位差   勝率   前半   後半  去最好年  扣成本  六關`);
for (const k of ['above', 'below', 'xup', 'xdn']) {
    const a = buckets.get(k) || [];
    if (a.length < 500) { console.log(`${LBL[k].padEnd(34)} ${a.length}(樣本不足)`); continue; }
    const e = mean(a.map(x => x.ex)) - b;
    const half = [[], []], yr = {};
    for (const x of a) { half[x.date < midDate ? 0 : 1].push(x.ex); (yr[x.date.slice(0, 4)] ||= []).push(x.ex); }
    const h = half.map((hh, i) => hh.length >= 30 ? mean(hh) - mean(baseHalf[i]) : null);
    const yv = yrKeys.map(y => (yr[y] || []).length >= 30 ? mean(yr[y]) - mean(baseYr[y]) : null).filter(v => v != null);
    let exBest = null;
    if (yv.length >= 2) {
        const bestY = yrKeys.filter(y => (yr[y] || []).length >= 30).sort((x, y2) => (mean(yr[y2]) - mean(baseYr[y2])) - (mean(yr[x]) - mean(baseYr[x])))[0];
        const rest = [], restB = [];
        // ⛔ push(...大陣列) 會爆呼叫堆疊 —— 一律逐筆
        for (const y of yrKeys) if (y !== bestY && (yr[y] || []).length) { for (const v of yr[y]) rest.push(v); for (const v of baseYr[y]) restB.push(v); }
        if (rest.length >= 100) exBest = mean(rest) - mean(restB);
    }
    const sameHalf = h[0] != null && h[1] != null && Math.sign(h[0]) === Math.sign(h[1]);
    const sameYr = yv.length >= 2 && yv.every(v => Math.sign(v) === Math.sign(yv[0]));
    const pass = e > 0 && sameHalf && sameYr && exBest > 0 && e > COST;
    console.log(`${LBL[k].padEnd(34)} ${String(a.length).padStart(6)} ${fmt(e).padStart(7)} ${fmt(med(a.map(x => x.ex)) - med(allEx)).padStart(7)} ${(a.filter(x => x.ex > 0).length / a.length * 100).toFixed(1).padStart(6)}% ${fmt(h[0]).padStart(6)} ${fmt(h[1]).padStart(6)} ${fmt(exBest).padStart(8)} ${fmt(e - COST).padStart(7)}   ${pass ? '✅' : '❌'}`);
    console.log(`   逐年:${yrKeys.map(y => `${y} ${(yr[y] || []).length >= 30 ? fmt(mean(yr[y]) - mean(baseYr[y])) : '—'}`).join(' ・ ')}`);
}
console.log('\n⚠️ 限制:foreign_net 約 3 年(2023-06 起)、窗口偏多頭、倖存者偏誤;成本公式照卡片同一條(近20日淨買超日加權均價)。');
