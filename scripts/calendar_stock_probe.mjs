#!/usr/bin/env node
/**
 * 📅 財經行事曆 × 全市場逐檔 —— 漲跌機率與幅度探針
 *
 * 使用者:「財經行事曆部分有很多種類,幫我用回測方式,計算出漲跌機率,
 *          還有漲多少還是跌多少,當然個股不同有不一樣的結果,幫我計算出來」
 *
 * ⭐⭐ 這支問的問題跟 `calendar_probe.mjs`(V73.2.0)**不一樣**,⛔ 別把兩者的結論互推:
 *   ・`calendar_probe`  問:把行事曆當成**打法的濾網**,總獲利會不會變多(答案:13 種全部少賺)
 *   ・本支           問:**每一種日子本身**的漲跌機率與幅度是多少(描述統計)
 *   本專案已有前例:地板股 300+ 對**大盤**有邊際,混進**個股打法**卻少賺 98 萬 —— 兩個是不同的問題。
 *
 * ⛔ 六個一定要寫進報告的限制:
 *   ① **只有「純日期算得出來」的行事曆**。⛔ 沒有資料源的一律不做,別假裝有:
 *      法說會・庫藏股公告・MSCI 正式換股名單・除權息日・FOMC/美國經濟數據・選舉。
 *      「財報公布截止日」只是法說會的**近似**,⛔ 不是法說會。
 *   ② **倖存者偏誤** —— `data/` 只有還活著的股票,已下市的不在裡面。
 *   ③ 🚨 V74.2.8 起窗口起點**改成從資料推**(K 線補深到 2021 → 已含 2022 空頭);
 *      但月份類每個桶仍只有幾個樣本,⛔ 不可下結論。
 *   ④ **一次測 20+ 種切法 ⇒ 多重比較**,必然有一兩格看起來很漂亮。
 *      判準是「**前後半段同向 + 逐年一致 + 天數夠**」,⛔ 不是「哪格最好看」。
 *   ⑤ **當日報酬不可直接操作** —— 「星期五平均 +0.1%」要在星期四收盤前買才吃得到。
 *      所以每個事件同時算「事件日當天」與「事件日**收盤後**買、隔 1/5 日賣」。
 *   ⑥ **超額才是重點**:某天上漲 60% 可能只是那段大盤在漲。一律同時給原始與超額。
 *
 * 🚨🚨 第一版有三個「會安靜地給出錯數字」的缺陷,實跑後人工讀輸出才抓到(寫下來免得再犯):
 *   ① **窗口取錯** —— 印的是 `^TWII` 的範圍(2021-08 起),但個股只有 2023-06 起。
 *      更糟的是**逐年檢定被殘尾決定**:實測 2022 年只有 **85 列**(少數異常檔的舊資料),
 *      卻能算出「+23.37pp」而奪下「最好年份」→ 那一關等於沒作用。
 *      → 改成**共同窗口** `WIN_FROM` 起,並要求每年至少 `MIN_YEAR_ROWS` 列才納入逐年檢定。
 *      ⭐ 通用:**對照組與檢定的期間必須跟實際樣本對齊**(同 V73.2.9 那次 0050 對照組消失)。
 *   ② **p 值嚴重高估** —— 2,184 檔在同一天**不是** 2,184 個獨立樣本(全市場同漲同跌)。
 *      → 檢定單位一律改成**天數**(每天先算橫截面中位數,再拿天當樣本做 Welch t)。
 *      股·日 只拿來做**描述**(上漲比例/幅度),⛔ 不掛 p 值。
 *   ③ **逐檔判定門檻是我隨手訂的**(0.05pp)—— 本專案自己批評過憑空門檻。
 *      → 改用**對照組**:跟「不分日子的個股強弱延續性」比。贏不過對照 = 只是「強股恆強」,
 *        ⛔ 不是「這檔喜歡星期五」。
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物(輸出 JSON 只給人看)。
 *
 * 用法:node --max-old-space-size=4096 scripts/calendar_stock_probe.mjs [輸出.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = process.argv[2] || '';
// ⭐ 共同窗口起點 —— V74.2.8 改成**執行時從實際檔案推**(⛔ 不再寫死)。
//   🚨 原本寫死 `'2023-06-15'`(當時 data/ 就是從那天開始)。K 線補深到 2021 之後,
//      那一行會把**多出來的兩年半(含 2022 空頭)整段丟掉**,而且畫面上看不出來 ——
//      報告只會印一個看起來很正常的窗口。⭐ 通用:任何「窗口起點」都要從資料推,
//      ⛔ 不可寫死;寫死的那一刻它就開始過期了。
//   規則不變:取各檔起始日的 p75(涵蓋約 75% 檔數),再往後 3 天緩衝。
const WIN_FROM = (() => {
  const env = process.env.WIN_FROM; if (env) return env;
  const firsts = [];
  for (const fn of fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'))) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8'));
      if (Array.isArray(a) && a.length >= 500) firsts.push(String(a[0].date || '').replace(/\//g, '-').slice(0, 10));
    } catch (_) { }
  }
  firsts.sort();
  if (firsts.length < 200) return '2023-06-15';        // 🚧 空過守門:推不出來就退回舊值
  const p75 = firsts[Math.floor(firsts.length * 0.75)];
  const t = new Date(p75 + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 3);
  return t.toISOString().slice(0, 10);
})();
const MIN_BARS = 500;            // 太新的股票不收(不然季節桶只涵蓋部分窗口)
const MIN_STOCKS = 500;          // 空過守門
const MIN_ROWS = 200000;         // 空過守門
const MIN_DAYS = 20;             // 事件**天數**不足就不下判定(⛔ 股·日 再多也不算)
const MIN_YEAR_ROWS = 20000;     // 逐年檢定:該年至少幾列才納入
const PS_MIN_N = 20;             // 逐檔:每檔每事件、每半段至少幾筆

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const med = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const vari = a => { if (a.length < 2) return 0; const m = mean(a); return sum(a.map(x => (x - m) ** 2)) / (a.length - 1); };
const pct = (x, n) => n ? x / n * 100 : 0;
const f = (x, w = 7, p = 3) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);

// 常態尾機率(Abramowitz-Stegun 7.1.26);n 已是天數層級,樣本 20+ 用常態近似夠了
const pFromZ = z => {
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 1 - erf;
};
// Welch t:事件日 vs 非事件日(⭐ 樣本單位是「天」)
function welch(a, b) {
    if (a.length < 2 || b.length < 2) return { t: 0, p: 1, d: 0 };
    const d = mean(a) - mean(b);
    const se = Math.sqrt(vari(a) / a.length + vari(b) / b.length);
    if (!(se > 0)) return { t: 0, p: 1, d };
    const t = d / se;
    return { t, p: pFromZ(t), d };
}

// ═══════════════ 1. 讀大盤,建交易日曆 ═══════════════
const twiiRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
    .map(r => ({ d: nd(r.date), c: +r.close }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
    .sort((a, b) => a.d < b.d ? -1 : 1);
const twiiRet = new Map();
for (let i = 1; i < twiiRaw.length; i++)
    twiiRet.set(twiiRaw[i].d, (twiiRaw[i].c - twiiRaw[i - 1].c) / twiiRaw[i - 1].c * 100);
// 🚨 日曆集合一律建在**完整**的大盤日期上(allDays),⛔ 不可建在裁切後的窗口 ——
//    否則【F】期外驗證那些日期一個都對不上(第一版 `結算日後一交易日` 期外天數顯示 0 就是這樣來的,
//    而且它**不會報錯**,只會安靜地把整個事件變成「期外沒有樣本」)。
const allDays = twiiRaw.map(r => r.d).filter(d => twiiRet.has(d));
const dIdx = new Map(allDays.map((d, i) => [d, i]));
const days = allDays.filter(d => d >= WIN_FROM);   // 個股分析用的窗口

const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
const ym = d => d.slice(0, 7);
const gapDays = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;

const byMonth = {};
for (const d of allDays) (byMonth[ym(d)] ||= []).push(d);
const mFirst = new Set(), mLast = new Set(), mFirst3 = new Set(), mLast3 = new Set();
for (const m of Object.keys(byMonth)) {
    const a = byMonth[m];
    mFirst.add(a[0]); mLast.add(a[a.length - 1]);
    a.slice(0, 3).forEach(d => mFirst3.add(d));
    a.slice(-3).forEach(d => mLast3.add(d));
}
const qLast5 = new Set(), qFirst5 = new Set();
{
    const byQ = {};
    for (const d of allDays) { const q = d.slice(0, 4) + 'Q' + Math.ceil(+d.slice(5, 7) / 3); (byQ[q] ||= []).push(d); }
    for (const q of Object.keys(byQ)) { const a = byQ[q]; a.slice(-5).forEach(d => qLast5.add(d)); a.slice(0, 5).forEach(d => qFirst5.add(d)); }
}
// 結算日:每月第三個星期三,遇休市順延(與 calendar_probe.mjs 同一套定義)
const settleSet = new Set(), settlePre = new Set(), settleNext = new Set();
for (const m of Object.keys(byMonth)) {
    const w0 = new Date(m + '-01T00:00:00Z').getUTCDay();
    const third = `${m}-${String(15 + ((3 - w0 + 7) % 7)).padStart(2, '0')}`;
    const hit = byMonth[m].find(d => d >= third);
    if (hit) settleSet.add(hit);
}
for (const d of settleSet) {
    const i = dIdx.get(d);
    if (i > 0) settlePre.add(allDays[i - 1]);
    if (allDays[i + 1]) settleNext.add(allDays[i + 1]);
}
const isoWeek = x => { const t = new Date(x + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const settleWeeks = new Set([...settleSet].map(isoWeek));

const preHol = new Set(), postHol = new Set(), cnyClose = new Set(), cnyOpen = new Set();
for (let i = 0; i < allDays.length - 1; i++) {
    const g = gapDays(allDays[i], allDays[i + 1]);
    if (g >= 4) { preHol.add(allDays[i]); postHol.add(allDays[i + 1]); }
    if (g >= 6) { cnyClose.add(allDays[i]); cnyOpen.add(allDays[i + 1]); }   // ⚠️ 近似,⛔ 不是農曆表
}
// 財報公布截止日 ±3 交易日(⚠️ 這不是法說會)
const finDl = new Set(), revDl = new Set();
for (const y of [...new Set(allDays.map(d => d.slice(0, 4)))]) {
    for (const t of ['-03-31', '-05-15', '-08-14', '-11-14']) {
        const i = allDays.findIndex(d => d >= y + t);
        if (i < 0) continue;
        for (let k = -3; k <= 3; k++) if (allDays[i + k]) finDl.add(allDays[i + k]);
    }
    // 月營收:上市櫃每月 10 日前公布上月營收 → 取每月 10 日當天及前後一個交易日
    for (let m = 1; m <= 12; m++) {
        const i = allDays.findIndex(d => d >= `${y}-${String(m).padStart(2, '0')}-10`);
        if (i < 0) continue;
        for (let k = -1; k <= 1; k++) if (allDays[i + k] && ym(allDays[i + k]) === `${y}-${String(m).padStart(2, '0')}`) revDl.add(allDays[i + k]);
    }
}

// ═══════════════ 2. 事件定義(⛔ 只收純日期算得出來的) ═══════════════
const EVENTS = [
    ['wk1', '星期一', d => dow(d) === 1],
    ['wk2', '星期二', d => dow(d) === 2],
    ['wk3', '星期三', d => dow(d) === 3],
    ['wk4', '星期四', d => dow(d) === 4],
    ['wk5', '星期五', d => dow(d) === 5],
    ['mfirst', '每月第一個交易日', d => mFirst.has(d)],
    ['mlast', '每月最後一個交易日', d => mLast.has(d)],
    ['mfirst3', '月初前 3 個交易日', d => mFirst3.has(d)],
    ['mlast3', '月底最後 3 個交易日', d => mLast3.has(d)],
    ['dec1', '上旬(1-10 日)', d => +d.slice(8, 10) <= 10],
    ['dec2', '中旬(11-20 日)', d => { const n = +d.slice(8, 10); return n > 10 && n <= 20; }],
    ['dec3', '下旬(21 日後)', d => +d.slice(8, 10) > 20],
    ['revdl', '月營收公布日(每月10日±1)', d => revDl.has(d)],
    ['qlast5', '季底最後 5 個交易日', d => qLast5.has(d)],
    ['qfirst5', '季初前 5 個交易日', d => qFirst5.has(d)],
    ['settle', '期貨結算日(第3個週三)', d => settleSet.has(d)],
    ['settlepre', '結算日前一交易日', d => settlePre.has(d)],
    ['settlenext', '結算日後一交易日', d => settleNext.has(d)],
    ['settlewk', '結算週', d => settleWeeks.has(isoWeek(d))],
    ['prehol', '長假前最後一個交易日', d => preHol.has(d)],
    ['posthol', '長假後第一個交易日', d => postHol.has(d)],
    ['cnyclose', '封關日(年假前,近似)', d => cnyClose.has(d)],
    ['cnyopen', '開紅盤(年假後,近似)', d => cnyOpen.has(d)],
    ['findl', '財報截止日±3(⚠️不是法說會)', d => finDl.has(d)],
    ['divseason', '除權息旺季(7-8 月)', d => ['07', '08'].includes(d.slice(5, 7))],
];
for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    EVENTS.push([`mon${mm}`, `${m} 月(⚠️只有 3 年)`, d => d.slice(5, 7) === mm]);
}
const evDays = new Map();   // key → Set(日期)
for (const [k, , fn] of EVENTS) evDays.set(k, new Set(days.filter(fn)));

// ═══════════════ 3. 掃全市場 ═══════════════
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));

// 每日橫截面(⭐ 檢定的樣本單位)
const dRaw = new Map(), dEx = new Map(), dF1 = new Map(), dF5 = new Map();
for (const d of days) { dRaw.set(d, []); dEx.set(d, []); dF1.set(d, []); dF5.set(d, []); }
// 股·日 累計(只做描述)
const ALL = { n: 0, up: 0, sum: 0, ex: 0, exUp: 0 };
const AGG = {}; for (const [k] of EVENTS) AGG[k] = { n: 0, up: 0, sum: 0, ex: 0, exUp: 0, absSum: 0 };
const PS = new Map();
// ⭐ 逐檔 × 逐日超額矩陣 —— 給【E3】安慰劑檢定用(隨機挑同樣天數,量出這個統計量本身的雜訊)
const MAT = new Map();          // sym → Float64Array(days.length),沒有資料的日子放 NaN
const dPos = new Map(days.map((d, i) => [d, i]));
let rows = 0, used = 0, minD = '9999', maxD = '0000';
const HALF = days[Math.floor(days.length / 2)];
const HALF_I = Math.floor(days.length / 2);

for (const fn of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(arr) || arr.length < MIN_BARS) continue;
    const sym = fn.slice(0, 4);
    const bars = arr.map(r => ({ d: nd(r.date), c: +r.close }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
        .sort((a, b) => a.d < b.d ? -1 : 1);
    // ⭐ 共同窗口:起始日要早於窗口起點,否則季節桶只涵蓋一部分 → 會扭曲月份統計
    if (!bars.length || bars[0].d > WIN_FROM) continue;
    const w = bars.filter(b => b.d >= WIN_FROM && twiiRet.has(b.d));
    if (w.length < MIN_BARS) continue;
    used++;
    const ps = {}; PS.set(sym, ps);
    const vec = new Float64Array(days.length).fill(NaN); MAT.set(sym, vec);

    for (let i = 1; i < w.length; i++) {
        const d = w[i].d;
        const tw = twiiRet.get(d);
        const r = (w[i].c - w[i - 1].c) / w[i - 1].c * 100;
        if (!isFinite(r) || Math.abs(r) > 40) continue;    // 分割/減資殘留的離譜列
        const ex = r - tw;
        if (d < minD) minD = d; if (d > maxD) maxD = d;
        dRaw.get(d).push(r); dEx.get(d).push(ex);
        vec[dPos.get(d)] = ex;
        // 事件日**收盤後**買的可操作報酬(⛔ 跟當日報酬是兩件事)
        const fwd = k => {
            if (!w[i + k]) return null;
            let acc = 0;
            for (let q = i + 1; q <= i + k; q++) {
                const tq = twiiRet.get(w[q].d);
                if (tq === undefined) return null;
                acc += (w[q].c - w[q - 1].c) / w[q - 1].c * 100 - tq;
            }
            return acc;
        };
        const f1 = fwd(1), f5 = fwd(5);
        if (f1 !== null) dF1.get(d).push(f1);
        if (f5 !== null) dF5.get(d).push(f5);

        ALL.n++; ALL.sum += r; ALL.ex += ex; if (r > 0) ALL.up++; if (ex > 0) ALL.exUp++;
        (ps.__all ||= { n1: 0, s1: 0, n2: 0, s2: 0 });
        if (d < HALF) { ps.__all.n1++; ps.__all.s1 += ex; } else { ps.__all.n2++; ps.__all.s2 += ex; }

        for (const [k] of EVENTS) {
            if (!evDays.get(k).has(d)) continue;
            const A = AGG[k];
            A.n++; A.sum += r; A.ex += ex; A.absSum += Math.abs(r); if (r > 0) A.up++; if (ex > 0) A.exUp++;
            const p = (ps[k] ||= { n: 0, up: 0, sum: 0, sumEx: 0, n1: 0, s1: 0, n2: 0, s2: 0 });
            p.n++; p.sum += r; p.sumEx += ex; if (r > 0) p.up++;
            if (d < HALF) { p.n1++; p.s1 += ex; } else { p.n2++; p.s2 += ex; }
        }
        rows++;
    }
}
if (used < MIN_STOCKS || rows < MIN_ROWS) {
    console.error(`❌ 空過守門:只掃到 ${used} 檔 / ${rows} 列(門檻 ${MIN_STOCKS} / ${MIN_ROWS})`);
    process.exit(1);
}

// 每天的橫截面中位數(⭐ 之後所有檢定都用這個當「一個樣本」)
// ⚠️ 用**等權平均**不用中位數:實測全市場當日中位個股常常剛好 0.00%(跳動單位造成)
//    → 中位數會**飽和在 0**,整排長一樣、完全看不出差別(第一版就是這樣)。
const okDays = days.filter(d => dEx.get(d).length >= 200);
const mdRaw = new Map(okDays.map(d => [d, mean(dRaw.get(d))]));
const mdEx = new Map(okDays.map(d => [d, mean(dEx.get(d))]));
const mdF1 = new Map(okDays.map(d => [d, mean(dF1.get(d))]));
const mdF5 = new Map(okDays.map(d => [d, mean(dF5.get(d))]));
// ⭐ 每日「波動」= 當天全市場個股漲跌幅的平均絕對值(⛔ 跟方向無關)
const mdVol = new Map(okDays.map(d => [d, mean(dRaw.get(d).map(Math.abs))]));

// ═══════════════ 4. 報告 ═══════════════
const P0 = pct(ALL.up, ALL.n), P0EX = pct(ALL.exUp, ALL.n);
console.log('═'.repeat(104));
console.log('📅 財經行事曆 × 全市場逐檔 —— 漲跌機率與幅度');
console.log('═'.repeat(104));
console.log(`樣本:${used} 檔 × ${minD} ~ ${maxD}(${okDays.length} 個交易日)= ${rows.toLocaleString()} 個(股·日)`);
console.log(`⚠️ 對照組(同一批股票的所有交易日):上漲 ${P0.toFixed(2)}% ・ 平均 ${f(ALL.sum / ALL.n)}% ・ 中位 ${f(med([...mdRaw.values()]))}%`);
console.log(`⚠️ 扣掉同一天加權指數:贏大盤 ${P0EX.toFixed(2)}% ・ 平均 ${f(ALL.ex / ALL.n)}%`);
console.log(`   ⭐ 「上漲只有 ${P0.toFixed(1)}%」不是空頭 —— 那是台股個股的常態(漲跌家數本來就常是 4 成多)。`);
console.log(`      看下表一律跟 ${P0.toFixed(1)}% 比,⛔ 不是跟 50% 比。`);
console.log('   🚨 檢定用的樣本單位是「天」不是「股·日」—— 同一天 2 千檔一起漲跌,不是 2 千個獨立樣本。');

console.log('\n' + '─'.repeat(104));
console.log('【A】每一種日子:當天的漲跌(⚠️ 要在前一天收盤前買才吃得到)');
console.log('─'.repeat(104));
console.log('事件                        天數   股·日     上漲%  vs對照   平均%    典型日漲跌  平均波動   超額均');
const out = [];
for (const [k, name] of EVENTS) {
    const A = AGG[k], nd_ = [...evDays.get(k)].filter(d => mdEx.has(d));
    if (!A.n) continue;
    const up = pct(A.up, A.n);
    const o = {
        k, name, days: nd_.length, n: A.n, up, dUp: up - P0,
        avg: A.sum / A.n, med: med(nd_.map(d => mdRaw.get(d))), absAvg: A.absSum / A.n, exAvg: A.ex / A.n,
    };
    out.push(o);
    console.log(`${name.padEnd(24)} ${String(o.days).padStart(5)} ${String(A.n).padStart(8)}   ${up.toFixed(2).padStart(6)} ${f(o.dUp, 6, 2)}  ${f(o.avg, 7)}  ${f(o.med, 8)}   ${o.absAvg.toFixed(3).padStart(7)}  ${f(o.exAvg, 7)}`);
}

console.log('\n' + '─'.repeat(104));
console.log('【B】🚨 天數層級檢定:事件日 vs 非事件日 的「當天全市場個股中位漲跌%」');
console.log('     ⭐ 這才是能講「有沒有差」的那張表(【A】的股·日 只能做描述)');
console.log('     ⚠️ 「當天全市場個股」用**等權平均**(⛔ 不用中位數 —— 它會飽和在 0.00%)');
console.log('─'.repeat(104));
console.log('     ⚠️ 同時看「平均」與「中位」—— 兩者差很多 = 那是**偶爾重摔**,不是**常常跌**(做法完全不同)');
console.log('事件                        天數  事件日平均  其他日平均   差(pp)     t      p    事件日典型 其他日典型  判定');
for (const o of out) {
    const S = evDays.get(o.k);
    const a = okDays.filter(d => S.has(d)).map(d => mdRaw.get(d));
    const b = okDays.filter(d => !S.has(d)).map(d => mdRaw.get(d));
    const { t, p, d } = welch(a, b);
    o.dayDiff = d; o.t = t; o.p = p; o.dayMedE = med(a); o.dayMedO = med(b);
    const verdict = a.length < MIN_DAYS ? `⛔ 天數不足(${a.length})` : p <= 0.01 ? '⭐⭐ 差異明確' : p <= 0.05 ? '⭐ 有差異' : '➖ 跟其他日沒差';
    console.log(`${o.name.padEnd(24)} ${String(a.length).padStart(5)} ${f(mean(a), 9)} ${f(mean(b), 9)} ${f(d, 8)} ${t.toFixed(2).padStart(6)} ${p.toFixed(3)}  ${f(med(a), 8)} ${f(med(b), 8)}  ${verdict}`);
}

console.log('\n' + '─'.repeat(104));
console.log('【C】可操作版:事件日**收盤後**買、隔 1 日 / 5 日賣(已扣同期大盤,⛔ 未扣交易成本 0.44%)');
console.log('     ⚠️ 隔 5 日的視窗**互相重疊** → 即使用天數當單位,p 值仍然偏樂觀,⛔ 別直接當顯著性看。');
console.log('     ⚠️ 上旬/中旬/下旬 是同一個切分 → 上旬差就必然襯托中下旬好,⛔ 不是三個獨立發現。');
console.log('─'.repeat(104));
const allF1 = okDays.map(d => mdF1.get(d)), allF5 = okDays.map(d => mdF5.get(d));
console.log(`(對照組:所有交易日)      ${String(okDays.length).padStart(5)}  隔1日 ${f(mean(allF1), 8)}   隔5日 ${f(mean(allF5), 8)}`);
console.log('事件                        天數   隔1日超額   vs對照     p      隔5日超額   vs對照     p');
for (const o of out) {
    const S = evDays.get(o.k);
    const a1 = okDays.filter(d => S.has(d)).map(d => mdF1.get(d)), b1 = okDays.filter(d => !S.has(d)).map(d => mdF1.get(d));
    const a5 = okDays.filter(d => S.has(d)).map(d => mdF5.get(d)), b5 = okDays.filter(d => !S.has(d)).map(d => mdF5.get(d));
    const w1 = welch(a1, b1), w5 = welch(a5, b5);
    o.f1 = mean(a1); o.d1 = w1.d; o.p1 = w1.p; o.f5 = mean(a5); o.d5 = w5.d; o.p5 = w5.p;
    console.log(`${o.name.padEnd(24)} ${String(a1.length).padStart(5)}  ${f(o.f1, 9)}  ${f(w1.d, 7)}  ${w1.p.toFixed(3)}   ${f(o.f5, 9)}  ${f(w5.d, 7)}  ${w5.p.toFixed(3)}`);
}

console.log('\n' + '─'.repeat(104));
console.log('【D】穩健性:① 前後半段同向 ② 每一年都同向(⭐ 這關比「數字好看」重要得多)');
console.log('─'.repeat(104));
const yrs = [...new Set(okDays.map(d => d.slice(0, 4)))].sort()
    .filter(y => okDays.filter(d => d.slice(0, 4) === y).length >= 30);
console.log(`(納入逐年檢定的年份:${yrs.join(' / ')} —— ⛔ 資料列太少的年份已排除,第一版就是被 85 列的 2022 決定的)`);
console.log('事件                        全期(pp)  前半    後半   同向   ' + yrs.map(y => y.slice(2)).join('     ') + '   逐年一致  判定');
for (const o of out) {
    const S = evDays.get(o.k);
    const seg = ds => {
        const a = ds.filter(d => S.has(d)).map(d => mdRaw.get(d)), b = ds.filter(d => !S.has(d)).map(d => mdRaw.get(d));
        return (a.length >= 3 && b.length >= 3) ? mean(a) - mean(b) : null;
    };
    const h1 = seg(okDays.filter(d => d < HALF)), h2 = seg(okDays.filter(d => d >= HALF));
    const yv = yrs.map(y => seg(okDays.filter(d => d.slice(0, 4) === y)));
    const same = h1 !== null && h2 !== null && (h1 > 0) === (h2 > 0);
    const val = yv.filter(v => v !== null);
    const allSame = val.length === yrs.length && val.every(v => (v > 0) === (o.dayDiff > 0));
    const enough = o.days >= MIN_DAYS;
    o.same = same; o.allYear = allSame;
    o.pass = enough && same && allSame && o.p <= 0.05;
    console.log(`${o.name.padEnd(24)} ${f(o.dayDiff, 8)}  ${h1 === null ? '  --  ' : f(h1, 6, 2)}  ${h2 === null ? '  --  ' : f(h2, 6, 2)}   ${same ? '✅' : '❌'}   ${yv.map(v => v === null ? '  --  ' : f(v, 5, 2)).join(' ')}    ${allSame ? '✅' : '❌'}    ${o.pass ? '⭐ 通過' : (!enough ? '⛔天數不足' : '❌')}`);
}

// ═══════════════ 5. 逐檔:「這檔偏好某種日子」是真的還是雜訊? ═══════════════
console.log('\n' + '═'.repeat(104));
console.log('【E】逐檔:個股真的「各有各的日子」嗎?—— 前半段學到的,後半段還成立嗎');
console.log('═'.repeat(104));
// ⭐ 對照組:不分日子的「個股強弱延續性」。事件版贏不過它 = 只是強股恆強,不是「這檔喜歡星期五」。
const persist = key => {
    const r = [];
    for (const [, m] of PS) {
        const p = key === '__all' ? m.__all : m[key];
        if (!p || p.n1 < PS_MIN_N || p.n2 < PS_MIN_N) continue;
        r.push({ a: p.s1 / p.n1, b: p.s2 / p.n2 });
    }
    if (r.length < 100) return null;
    r.sort((x, y) => y.a - x.a);
    const q = Math.floor(r.length / 4);
    return { n: r.length, spread: mean(r.slice(0, q).map(x => x.b)) - mean(r.slice(-q).map(x => x.b)) };
};
const baseP = persist('__all');
console.log(`⭐ 對照組(不分日子,純看個股強弱會不會延續):${baseP.n} 檔 → 前半最強25% 減 最弱25% = ${f(baseP.spread, 6, 3)} pp`);
console.log('   → 事件版的「差」要**大於這個數**,才代表「這檔特別喜歡這種日子」;');
console.log('     否則只是「強股恆強」被行事曆切了一刀而已。\n');
console.log('事件                      可評估檔數   差(pp)   vs對照(pp)   判定');
const psOut = [];
for (const [k, name] of EVENTS) {
    const r = persist(k);
    if (!r) continue;
    const vs = r.spread - baseP.spread;
    psOut.push({ k, name, n: r.n, spread: r.spread, vs });
    console.log(`${name.padEnd(24)} ${String(r.n).padStart(8)}  ${f(r.spread, 7, 3)}  ${f(vs, 9, 3)}    ${vs > 0.05 ? '⭐ 贏過對照' : vs < -0.05 ? '🔄 輸給對照' : '➖ 跟對照沒差(= 雜訊)'}`);
}

console.log('\n【E2】逐檔舉例(⚠️ 只示範「算得出差異」長什麼樣,⛔ 差異 ≠ 可預測 —— 看上面【E】的判定)');
for (const k of ['wk1', 'wk5', 'settle', 'mlast3']) {
    const ev = EVENTS.find(e => e[0] === k); if (!ev) continue;
    const r = [];
    for (const [sym, m] of PS) { const p = m[k]; if (p && p.n >= 30) r.push({ sym, up: pct(p.up, p.n), avg: p.sum / p.n, ex: p.sumEx / p.n, n: p.n }); }
    if (r.length < 50) continue;
    r.sort((a, b) => b.ex - a.ex);
    const fmt = x => `${x.sym}(n=${x.n} 上漲${x.up.toFixed(0)}% 均${f(x.avg, 5, 2)}%)`;
    console.log(`  ${ev[1]} 最強:${r.slice(0, 3).map(fmt).join(' ')}`);
    console.log(`  ${' '.repeat(ev[1].length)} 最弱:${r.slice(-3).map(fmt).join(' ')}`);
}

// ═══════════════ 6. 期外驗證:用個股樣本**沒涵蓋到**的那段大盤資料再測一次 ═══════════════
// ⭐⭐ 為什麼需要這一關:上面一次測 37 個切法,光靠運氣就會有約 2 個 p≤0.05。
//    唯一能分辨「真的有」與「碰巧有」的辦法,是拿**沒用過的資料**再測一次。
//    `^TWII` 有 2021-08 起的資料,而個股樣本從 WIN_FROM 才開始 → 前面那段是乾淨的期外樣本。
// ═══════════════ 5b.【E3】安慰劑檢定:隨機挑同樣天數,量出這個統計量本身的雜訊 ═══════════════
// 🚨 為什麼一定要做:【E】的對照組是用**全部 757 天**估出來的,事件版只用 154 天 ——
//    兩者的**估計誤差不一樣大**,不是同一把尺。真正的問法是:
//    「隨機挑 154 天也會不會跑出 +0.11pp?」→ 會的話,那個數字就沒有意義。
console.log('\n' + '═'.repeat(104));
console.log('【E3】🎲 安慰劑檢定(環狀位移):把事件日整組平移到日曆別處,重算同一個統計量');
console.log('═'.repeat(104));
const syms = [...MAT.keys()];
// 固定種子的 LCG(⛔ 不用 Math.random —— 要能重跑出同樣結果)
let _seed = 20260818;
const rnd = () => ((_seed = (_seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function spreadOf(mask) {
    const r = [];
    for (const sym of syms) {
        const v = MAT.get(sym);
        let n1 = 0, s1 = 0, n2 = 0, s2 = 0;
        for (let i = 0; i < v.length; i++) {
            if (!mask[i]) continue;
            const x = v[i]; if (Number.isNaN(x)) continue;
            if (i < HALF_I) { n1++; s1 += x; } else { n2++; s2 += x; }
        }
        if (n1 < PS_MIN_N || n2 < PS_MIN_N) continue;
        r.push({ a: s1 / n1, b: s2 / n2 });
    }
    if (r.length < 100) return null;
    r.sort((x, y) => y.a - x.a);
    const q = Math.floor(r.length / 4);
    return mean(r.slice(0, q).map(x => x.b)) - mean(r.slice(-q).map(x => x.b));
}
// 🚨🚨 對照組**不可以用「隨機散落的日子」** —— 這是第一版的錯,而且它會系統性地放大結論:
//    「5 月」那 62 天是**擠成 3 塊**的,隨機抽的 62 天卻散落整個窗口。
//    相鄰日子的個股強弱本來就比較像(產業/波段會延續好幾週)→ 集中型事件天生贏過散落型安慰劑。
//    ⭐ 正解:**環狀位移**(circular shift)—— 把整組事件日在交易日曆上整體平移,
//    疏密結構完全不變,只打亂「跟行事曆的對齊」。星期三平移後會落到別的星期,5 月會落到 7 月。
const SHIFTS = 30;
const shiftNull = (baseMask) => {
    const vals = [];
    const L = baseMask.length;
    for (let t = 1; t <= SHIFTS; t++) {
        const off = Math.max(3, Math.floor(rnd() * (L - 6)) + 3);
        const m = new Uint8Array(L);
        for (let i = 0; i < L; i++) if (baseMask[i]) m[(i + off) % L] = 1;
        const v = spreadOf(m);
        if (v !== null) vals.push(v);
    }
    return vals.length >= 10 ? { m: mean(vals), sd: Math.sqrt(vari(vals)), n: vals.length } : null;
};
console.log(`(每個事件把它的日期在交易日曆上整體平移 ${SHIFTS} 個隨機位移 —— 疏密結構不變,只打亂跟行事曆的對齊)`);
console.log('事件                      天數   事件版差(pp)   位移版平均   位移版標準差    z     判定');
for (const o of out) {
    const ps = psOut.find(x => x.k === o.k); if (!ps) continue;
    if (o.days < 30) continue;
    const S = evDays.get(o.k);
    const base = Uint8Array.from(days.map(d => S.has(d) ? 1 : 0));
    const nl = shiftNull(base); if (!nl) continue;
    const z = nl.sd > 0 ? (ps.spread - nl.m) / nl.sd : 0;
    o.psZ = z;
    console.log(`${o.name.padEnd(24)} ${String(o.days).padStart(5)}  ${f(ps.spread, 10, 3)}  ${f(nl.m, 10, 3)}   ${nl.sd.toFixed(3).padStart(9)}  ${z.toFixed(2).padStart(6)}   ${Math.abs(z) >= 2 ? '⭐ 超出雜訊' : '➖ 在雜訊範圍內'}`);
}
console.log('');
console.log('⭐ 判讀:|z| < 2 = 把同一組日期平移到別的位置也會跑出這種數字 → 那不是「這檔喜歡這種日子」。');

// ═══════════════ 5c.【G】波動:比方向可靠得多,而且直接決定「部位要放多大」 ═══════════════
// ⭐ 金融市場一個穩固的事實:**波動比方向好預測**。方向幾乎不可預測,但「哪種日子比較顛」
//    可以預測,而且可操作 —— ⛔ 不是拿來賭方向,是拿來決定**當天要不要把部位放小**。
console.log('\n' + '═'.repeat(104));
console.log('【G】📊 波動(當天全市場個股漲跌幅的平均絕對值)—— ⛔ 跟多空無關,只講「顛不顛」');
console.log('═'.repeat(104));
const volAll = okDays.map(d => mdVol.get(d));
console.log(`對照組(所有交易日):平均波動 ${mean(volAll).toFixed(3)}%\n`);
console.log('事件                        天數   平均波動   vs對照     倍數     p     位移對照 z   判定');
const volRows = [];
for (const o of out) {
    const S = evDays.get(o.k);
    const a = okDays.filter(d => S.has(d)).map(d => mdVol.get(d));
    const b = okDays.filter(d => !S.has(d)).map(d => mdVol.get(d));
    if (a.length < 3) continue;
    const { p, d } = welch(a, b);
    // 環狀位移對照(同【E3】的理由:保留疏密結構)
    const base = Uint8Array.from(okDays.map(x => S.has(x) ? 1 : 0));
    const nul = [];
    for (let t = 0; t < 40; t++) {
        const off = Math.max(3, Math.floor(rnd() * (base.length - 6)) + 3);
        const ea = [], eb = [];
        for (let i = 0; i < base.length; i++) (base[(i - off % base.length + base.length) % base.length] ? ea : eb).push(volAll[i]);
        if (ea.length >= 3) nul.push(mean(ea) - mean(eb));
    }
    const nm = mean(nul), nsd = Math.sqrt(vari(nul));
    const z = nsd > 0 ? (d - nm) / nsd : 0;
    o.vol = mean(a); o.volD = d; o.volP = p; o.volZ = z;
    volRows.push(o);
    // ⭐ 以**位移對照 z** 為主判準,⛔ 不用 Welch p —— 事件本身波動大時,Welch 會用它自己那組
    //    被效應撐大的變異數去除,反而把真的效應判成不顯著(實測「長假後第一天」z=5.8 但 p=0.108)。
    const verdict = a.length < MIN_DAYS ? `⛔ 天數不足(${a.length})` : Math.abs(z) >= 2 ? (d > 0 ? '⭐ 真的比較顛' : '⭐ 真的比較穩') : '➖ 跟其他日差不多';
    console.log(`${o.name.padEnd(24)} ${String(a.length).padStart(5)}   ${mean(a).toFixed(3).padStart(7)}  ${f(d, 7)}   ${(mean(a) / mean(b)).toFixed(2)}x  ${p.toFixed(3)}   ${z.toFixed(2).padStart(6)}    ${verdict}`);
}

// ── 【G2】機制檢查:星期一 與 長假後第一天 是不是同一件事(= 休市後第一個交易日)? ──
// ⭐ 為什麼要做:兩個發現如果是同一個機制,就該合成**一個**,⛔ 不可當成兩個獨立證據
//    (那會讓多重比較的問題看起來比實際更小)。
console.log('\n── 【G2】機制檢查:波動 vs 「距上一個交易日隔了幾天」');
{
    const gapOf = new Map();
    for (let i = 1; i < allDays.length; i++) gapOf.set(allDays[i], gapDays(allDays[i - 1], allDays[i]));
    const bk = {};
    for (const d of okDays) {
        const g = gapOf.get(d) || 1;
        const k = g <= 1 ? '1 天(隔天)' : g <= 3 ? '2-3 天(週末)' : g <= 5 ? '4-5 天' : '6 天以上(長假)';
        (bk[k] ||= []).push(mdVol.get(d));
    }
    const order = ['1 天(隔天)', '2-3 天(週末)', '4-5 天', '6 天以上(長假)'];
    console.log('   休市間隔          天數    平均波動   相對隔天');
    const b0 = mean(bk[order[0]] || [1]);
    for (const k of order) {
        const a = bk[k]; if (!a || !a.length) continue;
        console.log(`   ${k.padEnd(16)} ${String(a.length).padStart(4)}   ${mean(a).toFixed(3).padStart(7)}   ${(mean(a) / b0).toFixed(2)}x`);
    }
    console.log('   ⭐ 若單調遞增 → 「星期一比較顛」與「長假後比較顛」是**同一件事**:');
    console.log('      休市越久,累積越多沒反映的消息,開市第一天一次反映完。⛔ 不是兩個獨立發現。');
}

// ═══════════════ 5d.【H】成本關卡:邊際大到能扣掉交易成本嗎? ═══════════════
// ⭐⭐ 這一節是整份報告最實用的部分:行事曆玩法都是「進場出場只隔幾天」,
//    每一趟都要付來回成本。邊際小於成本 = 統計上再顯著也是白做。
console.log('\n' + '═'.repeat(104));
console.log('【H】💰 成本關卡:單日進出一趟的來回成本約 0.44%(手續費 0.1425%×2 + 證交稅 0.3%)');
console.log('═'.repeat(104));
const COST = 0.44;
const cand = [...out].sort((a, b) => Math.abs(b.dayDiff) - Math.abs(a.dayDiff)).slice(0, 8);
console.log('全部事件裡「跟其他日差最多」的前 8 名,跟成本比:');
console.log('事件                        天數    差(pp)    成本(pp)   扣完剩下   判定');
for (const o of cand) {
    const net = Math.abs(o.dayDiff) - COST;
    console.log(`${o.name.padEnd(24)} ${String(o.days).padStart(5)}  ${f(o.dayDiff, 8)}   ${COST.toFixed(2)}     ${f(net, 8)}   ${net > 0 ? '⭐ 還有剩' : '⛔ 不夠付成本'}`);
}
// ⚠️ 「差最大」不等於「可操作」,三個條件要一起看,⛔ 少一個就會得出太樂觀的結論:
//    ① 天數夠 ② 方向穩健(【D】通過)③ 差大於成本 ④ 而且方向要是**做多**吃得到的
//      —— 負的那些要放空才吃得到,而台股放空有券源限制、平盤下限制與借券成本(⛔ 不只 0.44%)。
const usable = out.filter(o => o.days >= MIN_DAYS && o.pass);
console.log('');
console.log(`⭐⭐ 同時滿足「天數夠 + 方向穩健(【D】通過)」的事件共 ${usable.length} 個:`);
if (!usable.length) {
    console.log('   → 一個都沒有 ⇒ **沒有可操作的行事曆玩法**。');
} else {
    for (const o of usable) {
        const net = Math.abs(o.dayDiff) - COST;
        console.log(`   ・${o.name}:差 ${f(o.dayDiff, 6)}pp,扣成本後 ${f(net, 6)}pp → ${net > 0 ? '⭐ 還有剩' : '⛔ 不夠付成本,白做'}`);
    }
}
const bigNeg = out.filter(o => o.days >= MIN_DAYS && o.dayDiff < -COST);
if (bigNeg.length) {
    console.log('');
    console.log(`⚠️ 有 ${bigNeg.length} 個事件「跌得比成本多」(${bigNeg.map(o => o.name).join('、')})——`);
    console.log('   ⛔ 但那要**放空**才吃得到:台股放空有券源限制、平盤下不得放空、還有借券費,');
    console.log('      實際成本遠高於 0.44%,而且它們沒通過方向穩健性檢定。⛔ 不可當成機會。');
}
console.log('   ⛔ 這一節跟統計顯著性無關 —— 就算某一格 p 值很漂亮,賺的錢也不夠付手續費。');

console.log('\n' + '═'.repeat(104));
console.log('【F】🔍 期外驗證(out-of-sample):加權指數在「個股樣本開始之前」那段的表現');
console.log('═'.repeat(104));
const oosAll = twiiRaw.map((r, i) => i ? { d: r.d, r: (r.c - twiiRaw[i - 1].c) / twiiRaw[i - 1].c * 100 } : null)
    .filter(x => x && x.d < WIN_FROM);
const insAll = twiiRaw.map((r, i) => i ? { d: r.d, r: (r.c - twiiRaw[i - 1].c) / twiiRaw[i - 1].c * 100 } : null)
    .filter(x => x && x.d >= WIN_FROM);
if (oosAll.length < 100) {
    console.log(`⛔ 期外樣本只有 ${oosAll.length} 天,不足以驗證 —— ⚠️ 這代表上面的「通過」還沒有獨立證據。`);
} else {
    console.log(`期外樣本:${oosAll[0].d} ~ ${oosAll[oosAll.length - 1].d}(${oosAll.length} 天,⛔ 完全沒被上面用到)`);
    console.log('⚠️ 這是**指數**層級不是個股層級 —— 只能當旁證,⛔ 不能取代個股結論。\n');
    console.log('事件                     ── 期內(個股樣本那段)──   ── 期外(獨立樣本)──   同向?');
    console.log('                          天數   差(pp)      p        天數   差(pp)      p');
    // ⭐ 只驗上面通過的 + 使用者明確問過的(星期五),⛔ 不再全部重測一遍(那只會製造更多多重比較)
    const check = out.filter(o => o.pass).map(o => o.k);
    for (const k of ['wk5', ...check]) {
        if (!EVENTS.find(e => e[0] === k)) continue;
        const fn = EVENTS.find(e => e[0] === k)[2];
        const name = EVENTS.find(e => e[0] === k)[1];
        const seg = arr => {
            const a = arr.filter(x => fn(x.d)).map(x => x.r), b = arr.filter(x => !fn(x.d)).map(x => x.r);
            return { n: a.length, ...welch(a, b) };
        };
        const A = seg(insAll), B2 = seg(oosAll);
        const same = A.n >= 20 && B2.n >= 20 && (A.d > 0) === (B2.d > 0);
        console.log(`${name.padEnd(22)} ${String(A.n).padStart(6)} ${f(A.d, 9)}  ${A.p.toFixed(3)}   ${String(B2.n).padStart(6)} ${f(B2.d, 9)}  ${B2.p.toFixed(3)}    ${B2.n < 20 ? '⛔天數不足' : same ? '✅ 同向' : '❌ 期外反向 → 很可能是碰巧'}`);
    }
    console.log('');
    console.log(`⚠️ 多重比較的算術:本次共檢定 ${out.length} 個切法 → 就算完全沒有效應,`);
    console.log(`   光靠運氣也會有約 ${(out.length * 0.05).toFixed(1)} 個出現 p≤0.05。通過 ${out.filter(o => o.pass).length} 個 →`);
    console.log('   ⛔ 「通過」本身不是證據,要配上面的期外同向 + 機制講得通才算數。');
}

console.log('\n' + '═'.repeat(104));
console.log('⛔ 讀這份報告的四條規則');
console.log(`  ① 「上漲%」跟對照組 ${P0.toFixed(1)}% 比,⛔ 不是跟 50% 比。`);
console.log('  ② 只信【D】判定「⭐ 通過」的(天數夠 + p≤0.05 + 前後半段同向 + 每年同向)。');
console.log('  ③ 【E】判定「➖ 跟對照沒差」= 「這檔喜歡星期幾」**看得到但學不到**,⛔ 不可做成個股標籤。');
console.log(`  ④ 未扣交易成本(來回約 0.44%);窗口 ${days[0]} ~ ${days[days.length - 1]};倖存者偏誤(已下市的不在裡面)。`);

if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
        meta: { stocks: used, rows, days: okDays.length, from: minD, to: maxD, half: HALF, p0: P0, p0ex: P0EX, years: yrs, basePersist: baseP },
        events: out, perstock: psOut,
    }, null, 1));
    console.log(`\n💾 ${OUT}`);
}
