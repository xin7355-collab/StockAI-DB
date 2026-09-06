#!/usr/bin/env node
/**
 * 🎯 隔日沖「開盤買、盤中高點賣」pooled 全市場重驗(V74.2.0,雜訊清洗收尾)
 *
 * 背景:當沖作戰室的「隔日沖勝率回測」每檔只有 12~19 次樣本 → 收進精簡檢視。
 *   使用者:「沒用的就刪除」→ 但它是「驗不出」不是「驗出沒用」——
 *   ⭐ pooled 全市場(樣本從十幾次變幾萬次)就驗得出,先驗再決定刪不刪。
 *
 * ⚠️ 型態與勝負定義**逐字照抄** `index.html` 的 `_dtWinRateBacktest`(⛔ 改了要兩邊一起改):
 *   ・漲停後沖:當日漲 ≥9.4%
 *   ・爆量長紅:漲 ≥4% + 量 ≥1.8×前5日均 + 收在 K 棒上緣 60% 以上
 *   ・爆量突破:量 ≥2× + 漲 ≥2% + 收盤創 20 日高
 *   ・勝 = 隔天開盤買,盤中最高 ≥ 開盤 +1.5%
 *   ・基準 = 同一條勝負定義套在**所有**交易日
 *
 * ⭐ 另算「務實損益」:碰到 +1.5% 就停利,否則收盤出;扣當沖來回成本 0.25%。
 *   (「碰得到高點」≠「賣得到高點」—— 勝率那條本來就偏樂觀,所以要配這條。)
 *
 * 跑法:node --max-old-space-size=4096 scripts/dtflip_probe.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DTCOST = 0.25;            // 當沖來回成本(手續費折後 + 當沖稅減半)
const DEDUP = 3;                // 同檔同型態 3 日去重(隔日沖本來就是隔天的事)

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f));
const buckets = new Map();      // pat → [{win, pnl, date}]
const base = [];                // 對照組(所有交易日)
let nSym = 0;

for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(raw)) continue;
    const arr = raw.filter(x => x && +x.close > 0);
    if (arr.length < 80) continue;
    nSym++;
    const O = b => +b.open || 0, H = b => +b.high || 0, L = b => +b.low || 0, C = b => +b.close || 0, V = b => +b.volume || 0;
    const avg5 = i => { if (i < 6) return 0; let s = 0; for (let j = i - 5; j < i; j++) s += V(arr[j]); return s / 5; };
    const chgOf = i => C(arr[i - 1]) > 0 ? (C(arr[i]) - C(arr[i - 1])) / C(arr[i - 1]) * 100 : 0;
    const pats = [
        ['漲停後沖', i => chgOf(i) >= 9.4],
        ['爆量長紅', i => { const rng = H(arr[i]) - L(arr[i]); const upper = rng > 0 ? (C(arr[i]) - L(arr[i])) / rng : 0; const av = avg5(i); return chgOf(i) >= 4 && av > 0 && V(arr[i]) >= 1.8 * av && upper >= 0.6; }],
        ['爆量突破', i => { const av = avg5(i); if (!(av > 0 && V(arr[i]) >= 2 * av && chgOf(i) >= 2)) return false; let mx = 0; for (let j = Math.max(0, i - 20); j < i; j++) mx = Math.max(mx, H(arr[j])); return mx > 0 && C(arr[i]) >= mx; }],
    ];
    const last = {};
    for (let i = 6; i < arr.length - 1; i++) {
        if (C(arr[i - 1]) <= 0) continue;
        const nb = arr[i + 1], on = O(nb), hn = H(nb), cn = C(nb);
        if (!(on > 0 && hn > 0 && cn > 0)) continue;
        const dt = String(nb.date).replace(/\//g, '-').slice(0, 10);
        const maxGain = (hn - on) / on * 100;
        const win = maxGain >= 1.5;
        // 務實損益:碰 +1.5% 就停利,否則收盤出;扣來回成本
        const pnl = (win ? 1.5 : (cn - on) / on * 100) - DTCOST;
        // ⚠️ 隔天開盤仍鎖漲停 = 買不到 → 事件與對照組**一致地**排除(⛔ 只排一邊會偏)
        if (on >= C(arr[i]) * 1.095) continue;
        base.push({ win, pnl, date: dt });
        for (const [k, test] of pats) {
            if (!test(i)) continue;
            const kk = f + '|' + k;
            if (last[kk] != null && i - last[kk] < DEDUP) continue;
            last[kk] = i;
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push({ win, pnl, date: dt });
        }
    }
}

const bWr = base.filter(x => x.win).length / base.length * 100;
const bPnl = mean(base.map(x => x.pnl));
console.log(`📊 ${nSym} 檔 ・對照組 ${base.length.toLocaleString()} 個(股·日)`);
console.log(`🎯 對照組:碰到 +1.5% 的比例 ${bWr.toFixed(1)}% ・務實損益(碰1.5%停利否則收盤出,扣成本0.25%)${bPnl.toFixed(3)}%`);
const ds = base.map(x => x.date).sort(), midDate = ds[ds.length >> 1];
const bYr = {}, bHalf = [[], []];
for (const x of base) { (bYr[x.date.slice(0, 4)] ||= []).push(x); bHalf[x.date < midDate ? 0 : 1].push(x); }
const yrKeys = Object.keys(bYr).sort().filter(y => bYr[y].length >= 2000);
console.log(`🗓️ 中點 ${midDate}`);

const fmt = v => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2);
console.log(`\n型態          n       碰1.5%   vs基準   務實損益  vs基準   前半    後半   去最好年  同向?`);
for (const [k, a] of buckets) {
    const wr = a.filter(x => x.win).length / a.length * 100;
    const pnl = mean(a.map(x => x.pnl));
    const half = [[], []], yr = {};
    for (const x of a) { half[x.date < midDate ? 0 : 1].push(x); (yr[x.date.slice(0, 4)] ||= []).push(x); }
    const hp = half.map((hh, i) => hh.length >= 50 ? mean(hh.map(x => x.pnl)) - mean(bHalf[i].map(x => x.pnl)) : null);
    const yv = yrKeys.map(y => (yr[y] || []).length >= 50 ? mean(yr[y].map(x => x.pnl)) - mean(bYr[y].map(x => x.pnl)) : null).filter(v => v != null);
    let exBest = null;
    if (yv.length >= 2) {
        const perY = yrKeys.map(y => [y, (yr[y] || []).length >= 50 ? mean(yr[y].map(x => x.pnl)) - mean(bYr[y].map(x => x.pnl)) : null]).filter(x => x[1] != null);
        const bestY = perY.slice().sort((x, y2) => y2[1] - x[1])[0][0];
        const rest = [], restB = [];
        for (const y of yrKeys) if (y !== bestY) { for (const v of (yr[y] || [])) rest.push(v.pnl); for (const v of bYr[y]) restB.push(v.pnl); }
        if (rest.length >= 100) exBest = mean(rest) - mean(restB);
    }
    const sameHalf = hp[0] != null && hp[1] != null && Math.sign(hp[0]) === Math.sign(hp[1]);
    const sameYr = yv.length >= 2 && yv.every(v => Math.sign(v) === Math.sign(yv[0]));
    console.log(`${k.padEnd(10)} ${String(a.length).padStart(7)} ${wr.toFixed(1).padStart(8)}% ${fmt(wr - bWr).padStart(7)}pp ${fmt(pnl).padStart(8)}% ${fmt(pnl - bPnl).padStart(7)}pp ${fmt(hp[0]).padStart(7)} ${fmt(hp[1]).padStart(7)} ${fmt(exBest).padStart(8)}   ${sameHalf && sameYr ? '✅' : '❌'}`);
    console.log(`   逐年 vs 基準:${yrKeys.map(y => `${y} ${(yr[y] || []).length >= 50 ? fmt(mean(yr[y].map(x => x.pnl)) - mean(bYr[y].map(x => x.pnl))) : '—'}`).join(' ・ ')}`);
}
console.log(`\n⚠️ 「碰到 +1.5%」偏樂觀(碰得到 ≠ 賣得到);務實損益那欄才是能不能賺的判準。`);
console.log(`⚠️ 已排除「隔天開盤仍鎖漲停」(買不到);窗口偏多頭;倖存者偏誤。`);
