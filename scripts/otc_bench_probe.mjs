#!/usr/bin/env node
/**
 * 🏪 上櫃股票該用哪個基準?探針(V73.6.1)—— 只讀 data/,不打網路。
 *
 * ❓ 使用者問「抓到櫃買指數對當沖有沒有優化空間」。
 *    ⭐ 這個問題的**可檢驗版本**是:上櫃股票的漲跌,跟**櫃買**比較像,還是跟**加權**比較像?
 *    如果只是「像一點點」,那抓到櫃買指數也只是多一格數字;
 *    如果差很多,代表本專案**現在所有回測扣的都是錯的基準**(全部扣 ^TWII)——
 *    那就不是「多一個功能」,是**量測本身有偏差**,層級完全不同。
 *
 * 📐 ⛔ 沒有 `^TWOII.json`(TPEx 端點改版,從沒抓成功過)→ 這裡用**上櫃股票自己的等權中位數**
 *    當櫃買的代理。⚠️ 它不等於官方櫃買指數(官方是市值加權),但要回答「上櫃股票之間是不是
 *    自成一個系統」,等權中位數其實**更貼近散戶實際會遇到的那一檔**(同 V72.0.4 中位數個股的理由)。
 *
 * 🏷️ 上市/上櫃怎麼分:`industry_map.json` 來自 TWSE 公司基本資料 = **只有上市**(實測 1,093 檔)。
 *    ⛔ 這是推導不是官方掛牌欄位,結論要記得這個限制。
 *
 * 🚧 空過守門:任一邊樣本 < 200 檔或 < 200 天 → exit 1。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');

const imap = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'));
const twRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
const twArr = Array.isArray(twRaw) ? twRaw : (twRaw.data || []);
const twRet = new Map();     // 日期 → 加權當日漲跌%
for (let i = 1; i < twArr.length; i++) {
    const a = +twArr[i - 1].close, b = +twArr[i].close;
    if (a > 0 && b > 0) twRet.set(String(twArr[i].date).replace(/\//g, '-'), (b / a - 1) * 100);
}

const files = fs.readdirSync(DATA).filter(f => /^\d+\.json$/.test(f));
const series = new Map();    // sym → Map(日期 → 當日漲跌%)
let nTse = 0, nOtc = 0;
for (const f of files) {
    const sym = f.replace('.json', '');
    if (sym.startsWith('00')) continue;                 // ⛔ 排除 ETF(它們跟哪個指數像都不奇怪)
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    rows = Array.isArray(rows) ? rows : (rows.data || []);
    if (rows.length < 250) continue;
    const m = new Map();
    for (let i = 1; i < rows.length; i++) {
        const a = +rows[i - 1].close, b = +rows[i].close;
        if (a > 0 && b > 0) m.set(String(rows[i].date).replace(/\//g, '-'), (b / a - 1) * 100);
    }
    if (m.size < 200) continue;
    series.set(sym, m);
    if (imap[sym]) nTse++; else nOtc++;
}
console.log(`📂 有效 ${series.size} 檔(上市 ${nTse} ・ 上櫃/其他 ${nOtc})`);
if (nTse < 200 || nOtc < 200) { console.log('❌ 任一邊樣本不足 200 檔 → 🚧 空過守門'); process.exit(1); }

// 每日中位數(上市組 / 上櫃組)
const allDates = [...new Set([...series.values()].flatMap(m => [...m.keys()]))].sort();
const medOf = arr => { if (!arr.length) return null; const s = arr.sort((a, b) => a - b); return s[s.length >> 1]; };
const tseMed = new Map(), otcMed = new Map();
for (const d of allDates) {
    const a = [], b = [];
    for (const [sym, m] of series) { const v = m.get(d); if (v === undefined) continue; (imap[sym] ? a : b).push(v); }
    if (a.length >= 100) tseMed.set(d, medOf(a));
    if (b.length >= 100) otcMed.set(d, medOf(b));
}
const days = allDates.filter(d => tseMed.has(d) && otcMed.has(d) && twRet.has(d));
console.log(`📅 三邊都有資料的交易日 ${days.length} 天(${days[0]} ~ ${days[days.length - 1]})`);
if (days.length < 200) { console.log('❌ 交易日不足 200 → 🚧 空過守門'); process.exit(1); }

const corr = (x, y) => {
    const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
};

const tw = days.map(d => twRet.get(d));
const tm = days.map(d => tseMed.get(d));
const om = days.map(d => otcMed.get(d));
console.log('\n═══ ① 三條基準彼此有多像 ═══');
console.log(`   加權指數 vs 上市中位數   r = ${corr(tw, tm).toFixed(3)}`);
console.log(`   加權指數 vs 上櫃中位數   r = ${corr(tw, om).toFixed(3)}`);
console.log(`   上市中位數 vs 上櫃中位數 r = ${corr(tm, om).toFixed(3)}`);
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`   平均日報酬:加權 ${avg(tw).toFixed(3)}% ・ 上市中位 ${avg(tm).toFixed(3)}% ・ 上櫃中位 ${avg(om).toFixed(3)}%`);

// ② 逐檔:上櫃股票跟誰比較像
console.log('\n═══ ② 逐檔相關係數(⭐ 這才是「該扣哪個基準」的答案)═══');
const res = { tse: { tw: [], own: [] }, otc: { tw: [], own: [] } };
for (const [sym, m] of series) {
    const dd = days.filter(d => m.has(d));
    if (dd.length < 200) continue;
    const r = dd.map(d => m.get(d));
    const isT = !!imap[sym];
    const g = isT ? res.tse : res.otc;
    g.tw.push(corr(r, dd.map(d => twRet.get(d))));
    g.own.push(corr(r, dd.map(d => (isT ? tseMed : otcMed).get(d))));
}
const line = (n, g) => {
    const a = medOf([...g.tw]), b = medOf([...g.own]);
    console.log(`   ${n}(${g.tw.length} 檔):跟**加權**的相關中位 ${a.toFixed(3)} ・ 跟**自己那一組中位數** ${b.toFixed(3)}  → 差 ${(b - a >= 0 ? '+' : '') + (b - a).toFixed(3)}`);
    return b - a;
};
const dT = line('上市股', res.tse);
const dO = line('上櫃股', res.otc);

console.log('\n⛔ 怎麼讀:');
console.log('   ・「差」很小(<0.05)→ 用加權當基準本來就夠,抓到櫃買指數**只是多一格數字**');
console.log('   ・「差」很大(>0.15)→ 上櫃自成一個系統 → 本專案所有回測對上櫃股扣錯基準,');
console.log('     那就**不是新功能,是量測偏差**,必須修');
console.log('   ⚠️ 上市/上櫃是用 industry_map 推導的(⛔ 不是官方掛牌欄位);');
console.log('     且「上櫃中位數」不等於官方櫃買指數(官方是市值加權)。');

if (Math.abs(dO) > 0.15) console.log('\n🚨 判定:上櫃股票確實自成一個系統 → 值得把櫃買指數修好');
else if (Math.abs(dO) > 0.05) console.log('\n⚠️ 判定:有差但不大 → 修好可以,但別期待當沖勝率因此改變');
else console.log('\n➖ 判定:差異在雜訊範圍 → ⛔ 抓到櫃買指數對當沖沒有實質幫助');
