#!/usr/bin/env node
/**
 * 🏭 「這波是誰在漲?」—— 族群 vs 個股 的行情階段探針
 *
 * 使用者:「個股漲跌時機紀錄到說明,比如說缺貨時、供貨時機、做夢行情!
 *          把我說錯的沒有說到的去回測時間點,並在個股說明中列出,或者條件到了時候觸發說明」
 *
 * ⛔⛔ 先講**為什麼不用基本面做**(⛔ 別再試一次):
 *   「缺貨 → 漲價 → 毛利率上升 → 營收 YoY 加速」在觀念上完全正確,但**回測不了**:
 *   實測 `data/fund_yoy_gm.json` 的 `qeps` 只有 **8 季(2024-06 ~ 2026-03)、918 檔**
 *   → 要算 YoY 需要 q 與 q-4,只剩 **4 個 YoY 點**,而且全擠在同一段行情裡。
 *   毛利率更慘:只存了 3 個點的趨勢字串。⛔ 拿 4 個點去定義「缺貨週期」= 憑空門檻。
 *
 * ⭐ 所以改用**價量層面的可測代理**(3 年 × 全市場,而且完全沒有前視):
 *   ・缺貨/漲價行情 → **整條族群一起漲**(漲價是整條供應鏈同步反映,不會只有一家)
 *   ・供貨/產能開出 → **整條族群一起跌**
 *   ・做夢行情     → **族群沒動,只有這檔獨走**(個別題材,沒有產業基本面撐)
 *
 * ⛔ 五條方法論(缺一個結論就會歪):
 *   ① **門檻一律用「當天的橫斷面分位」**,⛔ 不寫死 +10% 這種數字
 *      (同 V71.1.6 外資期貨、V71.8.1 波動率的教訓 —— 絕對門檻會隨行情失真)。
 *   ② **報酬扣同期加權指數**(不扣會把大盤的漲算到狀態頭上)。
 *   ③ **對照組 = 同一批(股·日)的全部**,⛔ 不抽樣(V72.4.4 抽樣害基準勝率被壓低那次)。
 *   ④ **同檔同狀態 20 日內只算一次**(連續多天觸發是同一件事)。
 *   ⑤ **前後半段 + 逐年同向**才算數;而且要跟**來回成本 0.44%** 比。
 *
 * ⚠️ 已知限制(⛔ 報告裡不可省略):
 *   ・`industry_map.json` 來自證交所公司基本資料 = **只有上市**(實測 1,093 檔),上櫃不在裡面。
 *   ・產業別是 TWSE 33 大類,**半導體全擠在同一類**(代碼 24)→ 「族群」的顆粒度偏粗。
 *   ・倖存者偏誤(已下市的不在 data/ 裡)。🚨 V74.2.8 起窗口已含 2022 空頭(⛔ 舊註解的「整段偏多頭」作廢)。
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物。
 * 用法:node --max-old-space-size=4096 scripts/regime_probe.mjs [輸出.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = process.argv[2] || '';
const LOOK = 20;          // 用近 20 個交易日的報酬定義「這波」
const STEP = 3;           // 每 3 天取樣一次(⛔ 之後還會再做 20 日去重)
const DEDUP = 20;         // 同檔同狀態 20 日內只算一次
const MIN_IND = 5;        // 一個產業當天至少幾檔才算得出中位數
const MIN_EV = 2000;      // 空過守門
const COST = 0.44;        // 來回手續費+證交稅

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const med = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const qtl = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
const pct = (x, n) => n ? x / n * 100 : 0;
const f = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);

// ═══════════ 1. 大盤日曆 + 產業別 ═══════════
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
    .map(r => ({ d: nd(r.date), c: +r.close }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
    .sort((a, b) => a.d < b.d ? -1 : 1);
const days = twii.map(r => r.d);
const dPos = new Map(days.map((d, i) => [d, i]));
const tw = Float64Array.from(twii.map(r => r.c));

const indMap = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'));

// ═══════════ 2. 讀個股收盤,對齊日曆 ═══════════
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const CL = new Map();     // sym → Float64Array(days.length),沒資料放 NaN
let used = 0, firstIdx = days.length;
for (const fn of files) {
    const sym = fn.slice(0, 4);
    if (!indMap[sym]) continue;                       // ⚠️ 沒有產業別就沒有「族群」可比
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(arr) || arr.length < 300) continue;
    const v = new Float64Array(days.length).fill(NaN);
    let n = 0, f0 = days.length;
    for (const r of arr) {
        const i = dPos.get(nd(r.date));
        const c = +r.close;
        if (i === undefined || !(c > 0)) continue;
        v[i] = c; n++; if (i < f0) f0 = i;
    }
    if (n < 300) continue;
    CL.set(sym, v); used++;
    if (f0 < firstIdx) firstIdx = f0;
}
// ⭐ 分析窗口從「多數股票都有資料」那天開始(⛔ 不可用 days[0] —— 那是大盤的起點,
//    個股比它晚兩年,會像 V73.7.3 第一版那樣讓逐年檢定被殘尾決定)
const cover = days.map((_, i) => { let c = 0; for (const v of CL.values()) if (!Number.isNaN(v[i])) c++; return c; });
const START = Math.max(LOOK + 1, cover.findIndex(c => c >= used * 0.7));

// ═══════════ 3. 逐日:算 20 日報酬 + 產業中位 ═══════════
const r20 = new Map();    // sym → Float64Array(近 20 日報酬 %)
for (const [sym, v] of CL) {
    const a = new Float64Array(days.length).fill(NaN);
    for (let i = LOOK; i < days.length; i++) {
        const c0 = v[i - LOOK], c1 = v[i];
        if (!Number.isNaN(c0) && !Number.isNaN(c1) && c0 > 0) a[i] = (c1 / c0 - 1) * 100;
    }
    r20.set(sym, a);
}
// 每天:各產業的中位 20 日報酬 → 再算出「產業強弱分位」
const indOf = sym => indMap[sym];
const indRankByDay = [];   // i → Map(產業 → 分位 0~1)
const selfCutByDay = [];   // i → {p80, p20}(全市場個股 20 日報酬的分位,判「獨走」用)
for (let i = 0; i < days.length; i++) {
    if (i < START) { indRankByDay.push(null); selfCutByDay.push(null); continue; }
    const byInd = new Map(), allR = [];
    for (const [sym, a] of r20) {
        const x = a[i]; if (Number.isNaN(x)) continue;
        allR.push(x);
        const k = indOf(sym); if (!k) continue;
        (byInd.get(k) || byInd.set(k, []).get(k)).push(x);
    }
    const meds = [];
    for (const [k, arr] of byInd) if (arr.length >= MIN_IND) meds.push([k, med(arr)]);
    meds.sort((a, b) => a[1] - b[1]);
    const rank = new Map();
    meds.forEach(([k], j) => rank.set(k, meds.length > 1 ? j / (meds.length - 1) : 0.5));
    indRankByDay.push(rank);
    allR.sort((a, b) => a - b);
    selfCutByDay.push({ p80: qtl(allR, 0.8), p20: qtl(allR, 0.2), med: qtl(allR, 0.5) });
}

// ═══════════ 4. 分類 + 未來報酬 ═══════════
// ⛔ 每一個狀態都只用「當天已知」的資訊(近 20 日報酬 + 當天橫斷面分位),沒有任何前視。
const STATES = [
    ['ind_up_follow', '🏭 族群齊漲・自己跟上', '整條供應鏈一起動 = 漲價/缺貨型行情'],
    ['ind_up_lag', '🐌 族群齊漲・自己落後', '族群在漲它還沒動(補漲候選)'],
    ['solo', '🎯 族群沒動・只有它獨走', '個別題材/做夢型,沒有產業基本面撐'],
    ['ind_dn_follow', '📉 族群齊跌・自己也跌', '整條供應鏈一起殺 = 供給開出/砍單型'],
    ['ind_dn_strong', '💪 族群齊跌・自己逆勢強', '族群在殺它還撐著'],
    // ⭐⭐ 使用者問的是「**時機**」—— 靜態狀態不是時機,**轉折**才是。
    //    「缺貨行情」真正的起點不是「族群已經在漲」(那時已經漲一段了),
    //    而是「族群**剛從弱轉強**」;「供貨/產能開出」對應「族群剛從強轉弱」。
    ['ind_turn_up', '🌅 族群剛由弱轉強(轉折)', '產業循環剛翻正 = 缺貨行情的起點'],
    ['ind_turn_dn', '🌇 族群剛由強轉弱(轉折)', '產業循環剛翻負 = 供給開出的起點'],
];
const HOR = [5, 20, 60];
const bag = {}; for (const [k] of STATES) bag[k] = { n: 0, r: { 5: [], 20: [], 60: [] } };
const base = { n: 0, r: { 5: [], 20: [], 60: [] } };
const byHalf = {}, byYear = {};
for (const [k] of STATES) { byHalf[k] = { a: [], b: [] }; byYear[k] = {}; }
byHalf.__base = { a: [], b: [] }; byYear.__base = {};

const lastHit = new Map();     // `${sym}|${state}` → 上次命中的 index
const HALF_I = Math.floor((START + days.length) / 2);
let events = 0;

const fwdEx = (v, i, k) => {
    const j = i + k;
    if (j >= days.length) return null;
    const c0 = v[i], c1 = v[j];
    if (Number.isNaN(c0) || Number.isNaN(c1) || !(c0 > 0)) return null;
    return (c1 / c0 - 1) * 100 - (tw[j] / tw[i] - 1) * 100;
};

for (let i = START; i < days.length; i += STEP) {
    const rank = indRankByDay[i], cut = selfCutByDay[i];
    if (!rank || !cut) continue;
    const y = days[i].slice(0, 4);
    for (const [sym, v] of CL) {
        const me = r20.get(sym)[i];
        if (Number.isNaN(me)) continue;
        const k = indOf(sym); const ir = rank.get(k);
        if (ir === undefined) continue;
        // 對照組:所有掃到的(股·日),⛔ 不抽樣
        base.n++;
        for (const h of HOR) { const x = fwdEx(v, i, h); if (x !== null) base.r[h].push(x); }
        {
            const x20 = fwdEx(v, i, 20);
            if (x20 !== null) { (i < HALF_I ? byHalf.__base.a : byHalf.__base.b).push(x20); (byYear.__base[y] ||= []).push(x20); }
        }
        // ⚠️ 一個(股·日)可能同時符合「狀態」與「轉折」→ 兩個都要記,⛔ 不可只取一個
        //    (轉折問的是「時機」、狀態問的是「現在是什麼盤」,是兩個不同的問題)
        const hits = [];
        const indStrong = ir >= 0.8, indWeak = ir <= 0.2;
        if (indStrong) hits.push(me >= cut.med ? 'ind_up_follow' : 'ind_up_lag');
        else if (indWeak) hits.push(me <= cut.med ? 'ind_dn_follow' : 'ind_dn_strong');
        else if (me >= cut.p80) hits.push('solo');
        // 轉折:20 個交易日前那一天,同一個產業的分位
        const prevRank = indRankByDay[i - DEDUP];
        if (prevRank) {
            const pr = prevRank.get(k);
            if (pr !== undefined) {
                if (indStrong && pr <= 0.4) hits.push('ind_turn_up');
                if (indWeak && pr >= 0.6) hits.push('ind_turn_dn');
            }
        }
        for (const st of hits) {
            const key = sym + '|' + st;
            if (i - (lastHit.get(key) ?? -1e9) < DEDUP) continue;
            lastHit.set(key, i);
            bag[st].n++; events++;
            for (const h of HOR) { const x = fwdEx(v, i, h); if (x !== null) bag[st].r[h].push(x); }
            const x20 = fwdEx(v, i, 20);
            if (x20 !== null) { (i < HALF_I ? byHalf[st].a : byHalf[st].b).push(x20); (byYear[st][y] ||= []).push(x20); }
        }
    }
}

if (events < MIN_EV || used < 300) {
    console.error(`❌ 空過守門:${used} 檔 / ${events} 個事件(門檻 300 / ${MIN_EV})`);
    process.exit(1);
}

// ═══════════ 5. 報告 ═══════════
const wr = a => pct(a.filter(x => x > 0).length, a.length);
console.log('═'.repeat(100));
console.log('🏭 「這波是誰在漲?」—— 族群 vs 個股 行情階段實測');
console.log('═'.repeat(100));
console.log(`樣本:${used} 檔(⚠️ 只有上市 —— industry_map 來自證交所公司基本資料,上櫃不在裡面)`);
console.log(`窗口:${days[START]} ~ ${days[days.length - 1]} ・ 事件 ${events.toLocaleString()} 個(同檔同狀態 ${DEDUP} 日去重)`);
console.log(`對照組:同一批(股·日)全部 ${base.n.toLocaleString()} 個,⛔ 沒有抽樣`);
console.log('⚠️ 報酬全部**扣掉同期加權指數**;⛔ 未扣交易成本(來回約 0.44%)');

console.log('\n' + '─'.repeat(100));
console.log('【A】五種狀態之後的超額報酬(中位)與勝率');
console.log('─'.repeat(100));
// ⭐ 賺賠比:贏的平均 ÷ 輸的平均。⛔ 只看勝率會漏掉「常對但賠更大」
//    (V72.0.3 那次自我修正:42 個 A 級訊號有 36 個期望值是負的)。
const payoff = a => {
    const w = a.filter(x => x > 0), l = a.filter(x => x <= 0);
    return (w.length && l.length) ? mean(w) / Math.abs(mean(l)) : null;
};
console.log('狀態                        事件數   5日中位  20日中位 60日中位   20日勝率  vs對照   賺賠比  20日平均  vs對照');
const bw = wr(base.r[20]);
const bpo = payoff(base.r[20]);
const bavg = mean(base.r[20]);
console.log(`${'(對照組:所有掃到的)'.padEnd(24)} ${String(base.n).padStart(7)}  ${f(med(base.r[5]))}  ${f(med(base.r[20]))}  ${f(med(base.r[60]))}   ${bw.toFixed(1).padStart(6)}%      —      ${bpo.toFixed(2)}  ${f(bavg)}     —`);
const rows = [];
for (const [k, name] of STATES) {
    const B = bag[k];
    const o = { k, name, n: B.n, m5: med(B.r[5]), m20: med(B.r[20]), m60: med(B.r[60]), w20: wr(B.r[20]) };
    o.d5 = o.m5 - med(base.r[5]); o.d20 = o.m20 - med(base.r[20]); o.d60 = o.m60 - med(base.r[60]);
    o.po = payoff(B.r[20]);
    rows.push(o);
    o.avg20 = mean(B.r[20]); o.dAvg = o.avg20 - bavg;
    console.log(`${name.padEnd(24)} ${String(B.n).padStart(7)}  ${f(o.m5)}  ${f(o.m20)}  ${f(o.m60)}   ${o.w20.toFixed(1).padStart(6)}%  ${f(o.w20 - bw, 6, 1)}pp    ${o.po == null ? ' -- ' : o.po.toFixed(2)}  ${f(o.avg20)}  ${f(o.dAvg, 6)}pp`);
}
console.log('\n(對照組是「所有掃到的股·日」,所以上面五個狀態的樣本是它的子集合 → 可以直接相減)');
console.log('狀態                        vs對照 5日   vs對照 20日  vs對照 60日');
for (const o of rows) console.log(`${o.name.padEnd(24)} ${f(o.d5, 9)}pp  ${f(o.d20, 9)}pp  ${f(o.d60, 9)}pp`);

console.log('\n' + '─'.repeat(100));
console.log('【B】穩健性:前後半段 + 逐年(⭐ 只有兩邊都同向才算數;用**平均超額**=期望值,⛔ 不用中位)');
console.log('─'.repeat(100));
const yrs = [...new Set(days.slice(START).map(d => d.slice(0, 4)))].sort()
    .filter(y => (byYear.__base[y] || []).length >= 500);
console.log('狀態                        全期(pp)  前半     後半    同向   ' + yrs.map(y => y.slice(2)).join('      ') + '   逐年一致  拿掉最好年  判定');
for (const o of rows) {
    // ⭐ 穩健性用**平均(期望值)**不用中位數 —— 決定賺不賺錢的是期望值。
    //    「獨走」型正是中位持平、平均卻 +0.89pp(少數大賺),只看中位會漏掉它的真面目
    //    (同 V72.0.3 的教訓:勝率高 ≠ 會賺錢,要看期望值)。
    const h1 = byHalf[o.k].a.length >= 30 ? mean(byHalf[o.k].a) - mean(byHalf.__base.a) : null;
    const h2 = byHalf[o.k].b.length >= 30 ? mean(byHalf[o.k].b) - mean(byHalf.__base.b) : null;
    const same = h1 !== null && h2 !== null && (h1 > 0) === (h2 > 0);
    const yv = yrs.map(y => {
        const a = byYear[o.k][y] || [], b = byYear.__base[y] || [];
        return (a.length >= 30 && b.length >= 30) ? mean(a) - mean(b) : null;
    });
    const allSame = yv.every(v => v !== null) && yv.every(v => (v > 0) === (o.dAvg > 0));
    // ⭐⭐ 標準關卡:**拿掉最好的那一年還贏嗎** —— 本專案實測過五個「贏家」的 edge
    //    全部集中在同一個月(2026-04),拿掉就由正轉負。這一關成本是零,而且比「總量有沒有變多」嚴格得多。
    const idxBest = yv.reduce((bi, v, j) => (v !== null && (bi < 0 || v > yv[bi])) ? j : bi, -1);
    const rest = yrs.filter((_, j) => j !== idxBest);
    let rn = 0, rs = 0, bn = 0, bs = 0;
    for (const y of rest) {
        const a = byYear[o.k][y] || [], b = byYear.__base[y] || [];
        rn += a.length; rs += sum(a); bn += b.length; bs += sum(b);
    }
    o.dropBest = (rn && bn) ? (rs / rn - bs / bn) : null;
    o.bestYear = idxBest >= 0 ? yrs[idxBest] : '';
    o.same = same; o.allYear = allSame;
    o.pass = same && allSame && o.dropBest !== null && (o.dropBest > 0) === (o.dAvg > 0);
    console.log(`${o.name.padEnd(24)} ${f(o.dAvg, 8)}  ${h1 === null ? '  --  ' : f(h1, 6)}  ${h2 === null ? '  --  ' : f(h2, 6)}   ${same ? '✅' : '❌'}   ${yv.map(v => v === null ? '  --  ' : f(v, 6)).join(' ')}    ${allSame ? '✅' : '❌'}   ${o.dropBest === null ? '  --  ' : f(o.dropBest, 6)}(去${o.bestYear.slice(2)})  ${o.pass ? '⭐ 通過' : '❌'}`);
}

console.log('\n' + '─'.repeat(100));
console.log(`【C】💰 成本關卡:來回 ${COST}%(⛔ 統計顯著跟能不能賺是兩件事)`);
console.log('─'.repeat(100));
// ⭐⭐ 成本關卡一律用**保守值(拿掉最好那一年之後)**,⛔ 不用全期平均 ——
//    全期平均會被單一好年份撐起來(同 V72.9.2「排點估計值必定挑到僥倖股」的教訓)。
console.log('狀態                        全期邊際   保守值(去最好年)  扣成本後   判定');
for (const o of rows) {
    const cons = o.dropBest === null ? o.dAvg : o.dropBest;
    const net = cons - COST;
    o.netCons = net;
    o.usable = o.pass && net > 0;
    console.log(`${o.name.padEnd(24)} ${f(o.dAvg, 8)}pp  ${f(cons, 10)}pp     ${f(net, 8)}pp   ${o.usable ? '⭐ 全關通過' : o.pass ? '⚠️ 通過穩健性但扣完成本沒剩(⛔ 只能當描述)' : '❌ 沒通過穩健性'}`);
}
console.log('');
console.log(`⭐ 全關通過(穩健性 + 保守值扣完成本仍為正)的共 ${rows.filter(o => o.usable).length} 個:`);
for (const o of rows.filter(o => o.usable)) console.log(`   ・${o.name} → 保守值 ${f(o.dropBest ?? o.dAvg, 5)}pp,扣成本後 ${f(o.netCons, 5)}pp`);

// ═══════════ 6. 「做夢行情」補充:獨走之後會不會被打回原形 ═══════════
console.log('\n' + '═'.repeat(100));
console.log('【D】🎯 「做夢行情」(獨走)特別檢查:它的**波動**與**回吐**長什麼樣');
console.log('═'.repeat(100));
{
    const B = bag.solo;
    const s60 = B.r[60], s20 = B.r[20];
    const p = (a, q) => { const s = Float64Array.from(a).sort(); return s[Math.floor(s.length * q)] || 0; };
    console.log('           n      P10      P25     中位      P75      P90     (超額報酬分布)');
    console.log(`  20 日  ${String(s20.length).padStart(6)}  ${f(p(s20, .1))}  ${f(p(s20, .25))}  ${f(med(s20))}  ${f(p(s20, .75))}  ${f(p(s20, .9))}`);
    console.log(`  60 日  ${String(s60.length).padStart(6)}  ${f(p(s60, .1))}  ${f(p(s60, .25))}  ${f(med(s60))}  ${f(p(s60, .75))}  ${f(p(s60, .9))}`);
    const b20 = base.r[20], b60 = base.r[60];
    console.log(`  (對照 20 日) ${f(p(b20, .1))}  ${f(p(b20, .25))}  ${f(med(b20))}  ${f(p(b20, .75))}  ${f(p(b20, .9))}`);
    console.log(`  (對照 60 日) ${f(p(b60, .1))}  ${f(p(b60, .25))}  ${f(med(b60))}  ${f(p(b60, .75))}  ${f(p(b60, .9))}`);
    console.log('\n⭐ 看「分布」不是只看中位數:獨走型如果 P90 很高但 P10 很低,');
    console.log('   代表它是「少數大賺、多數被打回原形」→ 那不是「會漲」,是「賠率型」,做法完全不同。');
}

console.log('\n' + '═'.repeat(100));
console.log('⛔ 讀這份報告的規則');
console.log('  ① 對照組是同一批(股·日)的全部 → 五個狀態是它的子集合,可以直接相減。');
console.log('  ② 只信【B】判定「⭐ 通過」的(前後半段 + 逐年都同向)。');
console.log('  ③ 【C】扣完成本沒剩的,⛔ 不可做成進出場訊號 —— 最多當「現在是什麼盤」的事實描述。');
console.log('  ④ 產業別只有上市、而且是 TWSE 33 大類(半導體全擠在一類)→ 「族群」顆粒度偏粗。');
console.log(`  ⑤ 窗口 ${days[0]} ~ ${days[days.length - 1]}(K 線已補深到 2021,含 2022 空頭);倖存者偏誤(已下市的不在 data/ 裡)。`);

if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
        meta: { stocks: used, events, from: days[START], to: days[days.length - 1], look: LOOK, dedup: DEDUP, cost: COST, baseN: base.n,
                base: { m5: med(base.r[5]), m20: med(base.r[20]), m60: med(base.r[60]), w20: bw } },
        states: rows,
    }, null, 1));
    console.log(`\n💾 ${OUT}`);
}
