/**
 * 🌡️ 大盤環境「多頭 / 盤整 / 空頭」再加上其它指數當變因(V74.6.3)
 *
 * 使用者:「加權指數現在有設計多頭、盤整、空頭,這個變因去加上其它指數,這樣回測」。
 *
 * ⚠️⚠️ **先講清楚哪些指數有歷史**(⛔ 不憑印象):
 *   ✅ 加權 `^TWII`(1,214 根,2021-09 起)・✅ 櫃買 `^TWOII`(1,178 根,gh-pages 上)
 *   ✅ 市場廣度 `breadth.json`(漲跌家數 / 地板股 / **中位數個股** / 成交金額)
 *   ⛔ 美股 / 費半 / 日韓 / VIX:`data/` 裡**一個都沒有**,而且這個環境連不到 Yahoo/stooq
 *      → 「其它指數」只能是**台股自己的那幾個**,⛔ 不可假裝測了海外。
 *
 * ⭐ 測法:讀 `portfolio_backtest` 的**候選交易快取**(= App 真正會挑的那些交易),
 *   依每一筆的進場日,貼上各種指數的環境標籤,再看每一格的「每趟淨報酬」。
 *   ⛔ 不重寫一份選股邏輯(那會變成第二份真相)。
 *
 * 判準(跟 App 的 bear60 濾網同一套,⛔ 不另訂):
 *   多頭 = 收 > 60 日線 且 20 日線 > 60 日線 ・空頭 = 收 < 60 且 20 < 60 ・其餘 = 盤整
 *
 * 跑法:TRADES_CACHE=/tmp/trades_official.json node scripts/regime_multi_probe.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = process.env.TRADES_CACHE || '/tmp/trades_official.json';
const TWOII = process.env.TWOII || '/tmp/twoii.json';
const COST = 0.44;
const log = (...a) => console.log(...a);

if (!fs.existsSync(CACHE)) { console.error(`🚨 找不到交易快取 ${CACHE} —— 先跑一次 portfolio_backtest 產生`); process.exit(1); }
const cj = JSON.parse(fs.readFileSync(CACHE, 'utf-8'));
const trades = cj.trades || cj;
log(`🌡️ 大盤環境 × 其它指數 ・交易 ${trades.length.toLocaleString()} 筆`);

// ── 指數 → 每日環境標籤 ────────────────────────────────────────
function regimeOf(rows) {
    const d = [], c = [];
    for (const r of rows) { const x = +(r.close || 0); if (x > 0) { d.push(String(r.date).replace(/\//g, '-').slice(0, 10)); c.push(x); } }
    const m = new Map();
    for (let i = 59; i < c.length; i++) {
        let s20 = 0, s60 = 0;
        for (let k = i - 19; k <= i; k++) s20 += c[k];
        for (let k = i - 59; k <= i; k++) s60 += c[k];
        const ma20 = s20 / 20, ma60 = s60 / 60;
        m.set(d[i], c[i] > ma60 && ma20 > ma60 ? '多頭' : c[i] < ma60 && ma20 < ma60 ? '空頭' : '盤整');
    }
    return m;
}
const twiiRows = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf-8'));
const RG_TWII = regimeOf(twiiRows);
let RG_OTC = new Map();
if (fs.existsSync(TWOII)) RG_OTC = regimeOf(JSON.parse(fs.readFileSync(TWOII, 'utf-8')));
else log('⚠️ 找不到櫃買指數檔 → 這一段跳過(⛔ 不靜默當成沒有差異)');

// ── 市場廣度:漲家數比 / 地板股 / 中位數個股 vs 大盤 ──────────────
let BR = new Map();
const bp = path.join(DATA, 'breadth.json');
if (fs.existsSync(bp)) {
    const b = JSON.parse(fs.readFileSync(bp, 'utf-8'));
    const rows = Array.isArray(b) ? b : (b.history || b.days || b.rows || []);
    for (const r of rows) {
        const d = String(r.d || r.date || '').replace(/\//g, '-').slice(0, 10); if (!d) continue;
        BR.set(d, { up: +r.up || 0, dn: +r.dn || 0, flr: r.flr != null ? +r.flr : null, med: r.med != null ? +r.med : null, idx: r.idx != null ? +r.idx : null });
    }
    const bd = [...BR.keys()].sort();
    log(`   市場廣度 ${BR.size} 天(${bd[0]} ~ ${bd[bd.length - 1]})⚠️ 只涵蓋這一段 → 廣度那幾格的樣本比上面兩格少很多`);
} else log('⚠️ 沒有 breadth.json → 廣度那幾格跳過');

// ── 分格統計 ────────────────────────────────────────────────
const net = t => t.ret - COST;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const wr = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
const f2 = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : ' n/a';

const all = trades.filter(t => RG_TWII.has(t.inD));
const bAll = mean(all.map(net));
log(`   基準(全部)每趟 ${f2(bAll)}% ・上漲 ${wr(all.map(net)).toFixed(1)}% ・n=${all.length.toLocaleString()}`);
const yrs = [...new Set(all.map(t => t.inD.slice(0, 4)))].sort();

function table(title, keyFn, note) {
    const g = new Map();
    for (const t of all) { const k = keyFn(t); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
    if (!g.size) { log(`\n${title}\n   ⛔ 算不出來(缺資料)`); return; }
    log(`\n${'═'.repeat(96)}\n${title}${note ? '\n' + note : ''}`);
    log('─'.repeat(96));
    log('格'.padEnd(30) + '  n      每趟     上漲%   vs全部    逐年(' + yrs.join('/') + ')');
    const mid = all.map(t => t.inD).sort()[Math.floor(all.length / 2)];
    for (const [k, arr] of [...g.entries()].sort((a, b) => mean(b[1].map(net)) - mean(a[1].map(net)))) {
        if (arr.length < 30) { log(k.padEnd(28) + String(arr.length).padStart(7) + '   樣本太少,⛔ 不下結論'); continue; }
        const m = mean(arr.map(net));
        const ys = yrs.map(y => { const a = arr.filter(t => t.inD.slice(0, 4) === y).map(net); return a.length >= 15 ? mean(a) : null; });
        const f1 = mean(arr.filter(t => t.inD < mid).map(net)), f2b = mean(arr.filter(t => t.inD >= mid).map(net));
        log(k.padEnd(28) + String(arr.length).padStart(7) + f2(m).padStart(9) + wr(arr.map(net)).toFixed(1).padStart(8)
            + f2(m - bAll).padStart(9) + '   ' + ys.map(v => v == null ? '  —  ' : f2(v).padStart(6)).join('')
            + `   前後半 ${f2(f1)}/${f2(f2b)}${(f1 > bAll) === (f2b > bAll) ? ' ✅' : ' ❌'}`);
    }
}

table('① 加權指數環境(現行 App 就是用這個)', t => RG_TWII.get(t.inD));
if (RG_OTC.size) {
    table('② 🆕 櫃買指數環境(其它指數之一)', t => RG_OTC.get(t.inD));
    table('③ 🆕 加權 × 櫃買 交叉 —— ⭐ 這才是使用者問的「加上其它指數當變因」',
        t => { const a = RG_TWII.get(t.inD), b = RG_OTC.get(t.inD); return a && b ? `加權${a} / 櫃買${b}` : null; },
        '⭐ 看「兩個一致」跟「兩個打架」有沒有差 —— 打架時通常是輪動或轉折');
}
if (BR.size) {
    table('④ 🆕 市場廣度:上漲家數比', t => { const b = BR.get(t.inD); if (!b || !(b.up + b.dn)) return null; const r = b.up / (b.up + b.dn); return r >= 0.6 ? '普漲 ≥60%' : r >= 0.4 ? '中性 40~60%' : '普跌 <40%'; });
    table('⑤ 🆕 中位數個股 vs 加權(誰在漲)', t => { const b = BR.get(t.inD); if (!b || b.med == null || b.idx == null) return null; const g = b.med - b.idx; return g >= 0.3 ? '個股贏大盤(散戶盤)' : g <= -0.3 ? '大盤贏個股(權值盤)' : '差不多'; },
        '⭐ 本站實測大盤平均每天贏中位數個股 +0.40pp(V72.0.4)→ 這一格問「權值盤 vs 散戶盤」哪種好做');
    table('⑥ 🆕 地板股家數(V72.4.9 實測 ≥300 對大盤有邊際)', t => { const b = BR.get(t.inD); if (!b || b.flr == null) return null; return b.flr >= 300 ? '≥300(剛被打過)' : b.flr >= 150 ? '150~299' : b.flr >= 50 ? '50~149' : '<50(市場平靜)'; });
}

log(`\n${'═'.repeat(96)}`);
log(`⚠️ 每趟已扣來回成本 ${COST}%;⛔ 這是「同一批交易分格比較」,不是「照這樣濾會賺多少」——`);
log(`   本站實測 53 種大盤濾網全部少賺(V73.2.1),因為差的環境每趟還是正的,砍掉就是砍獲利。`);
log(`   ⭐ 正確用法是**調部位大小**,⛔ 不是「這種環境整天不做」。`);
log(`⛔ 沒有海外指數:data/ 裡沒有美股/費半/日韓/VIX 的歷史,而且這個環境連不到 Yahoo/stooq。`);
