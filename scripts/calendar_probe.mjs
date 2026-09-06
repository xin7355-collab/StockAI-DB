#!/usr/bin/env node
/**
 * 📅 行事曆效應探針(V73.2.0)
 *
 * 使用者問:「禮拜五比較容易跌、法說會、月份、結算見轉折…加進去能不能提高勝率」
 *
 * ⭐ 這支**只讀資料、不打 API、不寫任何產物**,跟 orb_probe / sector_flow_probe 同一個定位:
 *    先回答「這個效應到底存不存在」,再決定要不要做成濾網。
 *
 * ⛔ 三個一定要先講清楚的限制(⛔ 別在報告裡省略):
 *   ① **法說會沒有資料源** —— FinMind 沒有法說會行事曆,MOPS 也沒有免費結構化 API。
 *      這裡只能用「財報公布截止日」當近似,⛔ 那不是法說會,別混為一談。
 *   ② **月份效應驗不了** —— 窗口只有 2 年 ⇒ 每個月份只有 2 個樣本。
 *      照樣列出來,但**標明樣本數**,⛔ 不可拿來下結論。
 *   ③ 一次測十幾個行事曆切法,**必然**有一兩個看起來很漂亮(多重比較)。
 *      所以判準是「單調 + 機制講得通 + 樣本夠」,⛔ 不是「哪一格數字最好看」。
 *
 * 用法:
 *   node scripts/calendar_probe.mjs [交易快取.json]
 *   (快取由 portfolio_backtest.mjs 的 TRADES_CACHE 產生)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.argv[2] || '';
const COST = 0.44;                     // 來回手續費+證交稅(跟 portfolio_backtest 一致)
const W = ['日', '一', '二', '三', '四', '五', '六'];

const twii = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '^TWII.json'), 'utf8'))
    .map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close }))
    .filter(r => r.d && r.c > 0);
const days = twii.map(r => r.d);
const dIdx = new Map(days.map((d, i) => [d, i]));
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
const ym = d => d.slice(0, 7);

// ── 結算日:每月第三個星期三,遇休市順延到下一個交易日 ──────────────────
const byM = {};
for (const d of days) (byM[ym(d)] ||= []).push(d);
const setDay = new Map();
for (const m of Object.keys(byM)) {
    const w0 = new Date(m + '-01T00:00:00Z').getUTCDay();
    const third = `${m}-${String(15 + ((3 - w0 + 7) % 7)).padStart(2, '0')}`;
    const hit = byM[m].find(d => d >= third);
    if (hit) setDay.set(m, hit);
}
const isSet = d => setDay.get(ym(d)) === d;
const isoWeek = x => { const t = new Date(x + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const setWeeks = new Set([...setDay.values()].map(isoWeek));
const inSetWeek = d => setWeeks.has(isoWeek(d));

// 長假前最後一個交易日
const preHol = new Set();
for (let i = 0; i < days.length - 1; i++)
    if ((new Date(days[i + 1]) - new Date(days[i])) / 86400000 >= 4) preHol.add(days[i]);

// 財報公布截止日 ±3 交易日(⚠️ 這不是法說會)
const finNear = new Set();
for (const y of [...new Set(days.map(d => d.slice(0, 4)))])
    for (const t of ['-03-31', '-05-15', '-08-14', '-11-14']) {
        const i = days.findIndex(d => d >= y + t);
        if (i < 0) continue;
        for (let k = -3; k <= 3; k++) if (days[i + k]) finNear.add(days[i + k]);
    }

// ── ① 先驗使用者的前提:大盤自己,禮拜五真的比較容易跌嗎? ─────────────
console.log('═'.repeat(78));
console.log('① 大盤(加權指數)本身的星期效應 —— 先驗「禮拜五比較容易跌」這個前提');
console.log('═'.repeat(78));
const dowStat = {};
for (let i = 1; i < twii.length; i++) {
    const r = (twii[i].c - twii[i - 1].c) / twii[i - 1].c * 100;
    const k = dow(twii[i].d);
    (dowStat[k] ||= []).push(r);
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log('星期   天數   平均漲跌%   中位%    上漲比例');
for (const k of [1, 2, 3, 4, 5]) {
    const a = dowStat[k] || [];
    if (!a.length) continue;
    const up = a.filter(x => x > 0).length / a.length * 100;
    console.log(`  ${W[k]}   ${String(a.length).padStart(4)}   ${mean(a).toFixed(3).padStart(8)}   ${med(a).toFixed(3).padStart(6)}   ${up.toFixed(1).padStart(6)}%`);
}
const all = Object.values(dowStat).flat();
console.log(`(全部) ${String(all.length).padStart(4)}   ${mean(all).toFixed(3).padStart(8)}   ${med(all).toFixed(3).padStart(6)}   ${(all.filter(x => x > 0).length / all.length * 100).toFixed(1).padStart(6)}%`);

// ── ② 結算日 / 結算週:大盤層級 ───────────────────────────────────────
console.log('\n② 大盤:結算日 vs 其他日(「結算見轉折」的前提)');
const setR = [], nonR = [], setWR = [], nonWR = [];
for (let i = 1; i < twii.length; i++) {
    const r = (twii[i].c - twii[i - 1].c) / twii[i - 1].c * 100;
    (isSet(twii[i].d) ? setR : nonR).push(r);
    (inSetWeek(twii[i].d) ? setWR : nonWR).push(r);
}
const line = (n, a) => `  ${n.padEnd(14)} n=${String(a.length).padStart(4)}  平均 ${mean(a).toFixed(3).padStart(7)}%  中位 ${med(a).toFixed(3).padStart(7)}%  上漲 ${(a.filter(x => x > 0).length / a.length * 100).toFixed(1)}%`;
console.log(line('結算日', setR));
console.log(line('非結算日', nonR));
console.log(line('結算週', setWR));
console.log(line('非結算週', nonWR));

// ── ③ 交易層級:每一筆打法交易,依進場日的行事曆特徵分桶 ──────────────
if (!CACHE || !fs.existsSync(CACHE)) {
    console.log('\n⚠️ 沒給交易快取 → 只跑大盤層級。');
    console.log('   產生方式:TRADES_CACHE=/tmp/bt/trades.json node scripts/portfolio_backtest.mjs 600 2');
    process.exit(0);
}
const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const T = (j.trades || []).filter(t => dIdx.has(t.inD));
console.log('\n' + '═'.repeat(78));
console.log(`③ 交易層級:${T.length} 筆候選交易(⚠️ 這是「所有觸發」不是「實際會買到的 2 檔」)`);
console.log('═'.repeat(78));

const net = t => t.ret - COST;
const base = T.map(net);
const B = { n: base.length, avg: mean(base), med: med(base), wr: base.filter(x => x > 0).length / base.length * 100 };
console.log(`基準(全部):n=${B.n}  每趟 ${B.avg.toFixed(3)}%  中位 ${B.med.toFixed(3)}%  勝率 ${B.wr.toFixed(1)}%\n`);

function bucket(title, keyFn) {
    const g = {};
    for (const t of T) { const k = keyFn(t.inD); if (k == null) continue; (g[k] ||= []).push(net(t)); }
    console.log(`── ${title}`);
    console.log('   桶            n      每趟%    vs基準pp    勝率%   vs基準pp');
    for (const k of Object.keys(g).sort()) {
        const a = g[k];
        const wr = a.filter(x => x > 0).length / a.length * 100;
        const d1 = mean(a) - B.avg, d2 = wr - B.wr;
        const flag = a.length < 200 ? ' ⚠️樣本少' : '';
        console.log(`   ${String(k).padEnd(12)} ${String(a.length).padStart(5)}  ${mean(a).toFixed(3).padStart(7)}  ${(d1 >= 0 ? '+' : '') + d1.toFixed(3).padStart(7)}   ${wr.toFixed(1).padStart(6)}  ${(d2 >= 0 ? '+' : '') + d2.toFixed(1).padStart(6)}${flag}`);
    }
    console.log('');
}

bucket('A. 進場日星期', d => W[dow(d)]);
bucket('B. 結算日', d => isSet(d) ? '結算日' : '其他');
bucket('C. 結算週', d => inSetWeek(d) ? '結算週' : '非結算週');
bucket('D. 月內位置', d => { const n = +d.slice(8, 10); return n <= 10 ? '1上旬(1-10)' : n <= 20 ? '2中旬(11-20)' : '3下旬(21-)'; });
bucket('E. 財報公布期±3日(⚠️ 不是法說會)', d => finNear.has(d) ? '財報期' : '其他');
bucket('F. 長假前最後一天', d => preHol.has(d) ? '長假前' : '其他');
bucket('G. 月份(⚠️ 每月只有 2 個樣本,⛔ 不可下結論)', d => d.slice(5, 7) + '月');

console.log('═'.repeat(78));
console.log('⚠️ 判讀原則(⛔ 別只挑數字最好看的那一格):');
console.log('   ① 交易層級的「每趟%」是**所有觸發**的平均,跟組合模擬(每天只買 2 檔)不同 →');
console.log('      這裡只用來看「效應存不存在」,實際賺多少一定要跑 portfolio_backtest。');
console.log('   ② 一次看 7 組分桶 ⇒ 多重比較。要單調、機制講得通、樣本夠才值得往下測。');
console.log('   ③ 濾掉一個桶 = 少做那些交易,總獲利**可能**因此下降(前 6 次濾網實驗都是這樣)。');
