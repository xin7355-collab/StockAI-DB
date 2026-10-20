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
 *   ③ **對照組 = 同一天的全部可比(股·日)**,⛔ 不抽樣(V72.4.4 抽樣害基準勝率被壓低那次)。
 *   ④ **同檔同狀態 20 日內只算一次**(連續多天觸發是同一件事)。
 *   ⑤ **前後半段 + 逐年同向**才算數;而且要跟**來回成本 0.44%** 比。
 *
 * ⚠️ 已知限制(⛔ 報告裡不可省略):
 *   ・`industry_map.json` 來自證交所公司基本資料 = **只有上市**(實測 1,093 檔),上櫃不在裡面。
 *   ・產業別是 TWSE 33 大類,**半導體全擠在同一類**(代碼 24)→ 「族群」的顆粒度偏粗。
 *   ・倖存者偏誤(已下市的不在 data/ 裡;d16 有,但 industry_map 只有現在還在的)。🚨 V74.2.8 起窗口已含 2022 空頭(⛔ 舊註解的「整段偏多頭」作廢)。
 *
 * 🔁 V79.4.3(16 年全市場 d16 重跑前修三件):
 *   ① 對照組 = **同一天**可比的全部股票(陷阱 #50):每一筆事件的報酬減掉「同一天、同一套報酬定義」的全部可比股票平均
 *      (中位數欄改減同一天的中位數);同一天少於 MIN_CTRL(30)檔 → 那筆不算(印出幾筆)。
 *      舊版減的是**整段**(股·日)的平均 / 中位 —— 16 年裡各年「個股 vs 加權」差很多,狀態集中在某幾年就會把年份的差算成狀態的功勞。
 *      勝率的對照 = 同一天全部可比股票 20 日贏大盤的比例(照事件加權)。前後半段照日期切(本來就是)。
 *   ② 進場 = 狀態那天的**收盤**:收盤停在漲停 → 買不到,事件與對照組一起剔除(lib_limit.upLimitClose,2015-06 前 ±7%)。
 *      狀態本身(族群強弱、橫斷面分位)照舊用全部股票算(那是當天收盤就知道的事實)。
 *   ③ 斷崖窗口(lib_cliff ×1.5 / ×0.67):近 20 日報酬的窗口碰到 → 那天這檔沒有「近 20 日報酬」(不進族群中位、不分類);
 *      抱的期間碰到 → 那一個天期不算(⛔ 不整檔剔除)。
 *
 * ⛔ 只讀 data/,不打 API、不寫任何會被部署的產物。
 * 用法:node --max-old-space-size=4096 scripts/regime_probe.mjs [輸出.json]
 *       MAX_SYMS=N(只等距抽 N 檔,冒煙測試用)・node scripts/regime_probe.mjs --selftest(不需要真資料)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upLimitClose } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 📂 深歷史(klines_deep 合併後,2021 起)放在 repo 外 → 用 DATA_DIR 指過去,⛔ 不動 repo 的 data/
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT = process.argv[2] || '';
const LOOK = 20;          // 用近 20 個交易日的報酬定義「這波」
const STEP = 3;           // 每 3 天取樣一次(⛔ 之後還會再做 20 日去重)
const DEDUP = 20;         // 同檔同狀態 20 日內只算一次
const MIN_IND = 5;        // 一個產業當天至少幾檔才算得出中位數
const MIN_EV = 2000;      // 空過守門
const COST = 0.44;        // 來回手續費+證交稅
export const MIN_CTRL = 30;   // 🔁 V79.4.3 同一天對照組至少幾檔
const MAX_SYMS = Math.max(0, parseInt(process.env.MAX_SYMS || '0', 10) || 0);   // 🔁 V79.4.3 冒煙測試用

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const med = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const qtl = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
const pct = (x, n) => n ? x / n * 100 : 0;
const f = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);

// ═══════════ 4. 狀態定義 ═══════════
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

/** 🔁 V79.4.3 照交易日對齊(NaN = 那天沒交易)的斷崖前綴和:pre[t+1]−pre[t] = 第 t 天這根跟「上一根有交易的」之間有斷崖。配 cliffIn 用。 */
export function dayCliffPre(v, o = null) {
    const idx = [], cc = [], oo = [];
    for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) { idx.push(i); cc.push(v[i]); oo.push(o ? o[i] : NaN); }
    const p = cliffPrefix(cc, o ? oo : null);
    const pre = new Int32Array(v.length + 1);
    let k = 0;
    for (let i = 0; i < v.length; i++) {
        let b = 0;
        if (k < idx.length && idx[k] === i) { b = p[k + 1] - p[k]; k++; }
        pre[i + 1] = pre[i] + b;
    }
    return pre;
}

// ═══════════ 1. 大盤日曆 + 產業別 ・ 2. 讀個股收盤,對齊日曆 ═══════════
export function loadAll(dataDir, maxSyms = 0) {
    const twii = JSON.parse(fs.readFileSync(path.join(dataDir, '^TWII.json'), 'utf8'))
        .map(r => ({ d: nd(r.date), c: +r.close }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
        .sort((a, b) => a.d < b.d ? -1 : 1);
    const days = twii.map(r => r.d);
    const dPos = new Map(days.map((d, i) => [d, i]));
    const tw = Float64Array.from(twii.map(r => r.c));
    const indMap = JSON.parse(fs.readFileSync(path.join(dataDir, 'industry_map.json'), 'utf8'));
    // ⚠️ 沒有產業別就沒有「族群」可比
    let files = fs.readdirSync(dataDir).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00') && indMap[x.slice(0, 4)]).sort();
    const nAll = files.length;
    if (maxSyms && nAll > maxSyms) files = Array.from({ length: maxSyms }, (_, k) => files[Math.floor(k * nAll / maxSyms)]);   // 等距抽樣(⛔ 不取前 N 檔)
    const CL = new Map(), OP = new Map();     // sym → Float64Array(days.length),沒資料放 NaN
    for (const fn of files) {
        const sym = fn.slice(0, 4);
        let arr;
        try { arr = JSON.parse(fs.readFileSync(path.join(dataDir, fn), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(arr) || arr.length < 300) continue;
        const v = new Float64Array(days.length).fill(NaN), o = new Float64Array(days.length).fill(NaN);
        let n = 0;
        for (const r of arr) {
            const i = dPos.get(nd(r.date));
            const c = +r.close;
            if (i === undefined || !(c > 0)) continue;
            v[i] = c; o[i] = +r.open > 0 ? +r.open : NaN; n++;
        }
        if (n < 300) continue;
        CL.set(sym, v); OP.set(sym, o);
    }
    return { days, tw, CL, OP, indMap, nFiles: files.length, nAll };
}

// ═══════════ 3. 逐日:算 20 日報酬 + 產業中位 ═══════════
export function prepare({ days, tw, CL, OP, indMap }) {
    const used = CL.size;
    // ⭐ 分析窗口從「多數股票都有資料」那天開始(⛔ 不可用 days[0] —— 那是大盤的起點,
    //    個股比它晚兩年,會像 V73.7.3 第一版那樣讓逐年檢定被殘尾決定)
    const cover = days.map((_, i) => { let c = 0; for (const v of CL.values()) if (!Number.isNaN(v[i])) c++; return c; });
    const START = Math.max(LOOK + 1, cover.findIndex(c => c >= used * 0.7));
    const PRE = new Map();
    for (const [sym, v] of CL) PRE.set(sym, dayCliffPre(v, OP ? OP.get(sym) : null));
    const r20 = new Map();    // sym → Float64Array(近 20 日報酬 %)
    for (const [sym, v] of CL) {
        const a = new Float64Array(days.length).fill(NaN), pre = PRE.get(sym);
        for (let i = LOOK; i < days.length; i++) {
            const c0 = v[i - LOOK], c1 = v[i];
            // 🔁 V79.4.3 窗口碰到斷崖 → 這天沒有「近 20 日報酬」(⛔ 不進族群中位、不分類)
            if (!Number.isNaN(c0) && !Number.isNaN(c1) && c0 > 0 && !cliffIn(pre, i - LOOK, i)) a[i] = (c1 / c0 - 1) * 100;
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
    return { days, tw, CL, PRE, r20, indOf, START, indRankByDay, selfCutByDay, used };
}

/** 那一天的分類(⛔ 只用當天已知的資訊)。⚠️ 一個(股·日)可能同時符合「狀態」與「轉折」→ 兩個都記 */
export function classifyState(ctx, sym, i, me, ir, rank, cut) {
    const hits = [];
    const indStrong = ir >= 0.8, indWeak = ir <= 0.2;
    if (indStrong) hits.push(me >= cut.med ? 'ind_up_follow' : 'ind_up_lag');
    else if (indWeak) hits.push(me <= cut.med ? 'ind_dn_follow' : 'ind_dn_strong');
    else if (me >= cut.p80) hits.push('solo');
    // 轉折:20 個交易日前那一天,同一個產業的分位
    const prevRank = ctx.indRankByDay[i - DEDUP];
    if (prevRank) {
        const pr = prevRank.get(ctx.indOf(sym));
        if (pr !== undefined) {
            if (indStrong && pr <= 0.4) hits.push('ind_turn_up');
            if (indWeak && pr >= 0.6) hits.push('ind_turn_dn');
        }
    }
    return hits;
}

/** 第 i 天收盤進場、抱 k 天的超額(扣同期加權);抱的期間碰到斷崖 → null(🔁 V79.4.3) */
export function fwdEx(ctx, sym, i, k) {
    const j = i + k;
    if (j >= ctx.days.length) return null;
    const v = ctx.CL.get(sym), c0 = v[i], c1 = v[j];
    if (Number.isNaN(c0) || Number.isNaN(c1) || !(c0 > 0)) return null;
    if (cliffIn(ctx.PRE.get(sym), i, j)) return null;
    return (c1 / c0 - 1) * 100 - (ctx.tw[j] / ctx.tw[i] - 1) * 100;
}

const prevValid = (v, i) => { for (let q = i - 1; q >= 0 && q >= i - 30; q--) if (!Number.isNaN(v[q])) return v[q]; return NaN; };

// ═══════════ 4b. 分類 + 未來報酬(⭐ 每一筆減掉同一天的對照)═══════════
export function collect(ctx, classify = classifyState) {
    const { days, START, CL, r20, indRankByDay, selfCutByDay } = ctx;
    const mk = () => ({ 5: [], 20: [], 60: [] });
    const bag = {}; for (const [k] of STATES) bag[k] = { n: 0, r: mk(), a: mk(), md: mk(), cw: [] };
    const base = { n: 0, r: mk(), a: mk() };
    const byHalf = {}, byYear = {};
    for (const [k] of STATES) { byHalf[k] = { a: [], b: [] }; byYear[k] = {}; }
    const baseYearN = {};
    const lastHit = new Map();     // `${sym}|${state}` → 上次命中的 index
    const HALF_I = Math.floor((START + days.length) / 2);
    let events = 0, dropped = 0, nLimit = 0;
    const ctrlN = new Map();       // 取樣日 → 那天對照組有幾檔(selftest 用)
    for (let i = START; i < days.length; i += STEP) {
        const rank = indRankByDay[i], cut = selfCutByDay[i];
        if (!rank || !cut) continue;
        const y = days[i].slice(0, 4);
        // ① 當天可比的全部(股·日)= 對照組,⛔ 不抽樣
        const E = [];
        for (const [sym, v] of CL) {
            const me = r20.get(sym)[i];
            if (Number.isNaN(me)) continue;
            const ir = rank.get(ctx.indOf(sym));
            if (ir === undefined) continue;
            if (upLimitClose(days[i], v[i], prevValid(v, i))) { nLimit++; continue; }   // 🔁 V79.4.3 收盤停在漲停 → 收盤買不到(事件與對照一起剔)
            E.push({ sym, me, ir, x: HOR.map(h => fwdEx(ctx, sym, i, h)) });
        }
        ctrlN.set(i, E.length);
        // ② 同一天對照:平均 / 中位 / 20 日贏大盤的比例
        const cs = HOR.map((_, hi) => {
            const a = []; for (const e of E) if (e.x[hi] !== null) a.push(e.x[hi]);
            return { n: a.length, m: mean(a), md: med(a), w: pct(a.filter(x => x > 0).length, a.length) };
        });
        for (const e of E) {
            base.n++;
            HOR.forEach((h, hi) => { const x = e.x[hi]; if (x === null) return; base.r[h].push(x); if (cs[hi].n >= MIN_CTRL) base.a[h].push(x - cs[hi].m); });
            if (e.x[1] !== null) baseYearN[y] = (baseYearN[y] || 0) + 1;
        }
        // ③ 事件
        for (const e of E) {
            for (const st of classify(ctx, e.sym, i, e.me, e.ir, rank, cut)) {
                const key = e.sym + '|' + st;
                if (i - (lastHit.get(key) ?? -1e9) < DEDUP) continue;
                if (cs[0].n < MIN_CTRL) { dropped++; continue; }          // 🔁 V79.4.3 同一天對照組太少 → 這筆不算
                lastHit.set(key, i);
                const B = bag[st];
                B.n++; events++;
                HOR.forEach((h, hi) => {
                    const x = e.x[hi]; if (x === null) return;
                    B.r[h].push(x);
                    if (cs[hi].n >= MIN_CTRL) { B.a[h].push(x - cs[hi].m); B.md[h].push(x - cs[hi].md); }
                });
                if (e.x[1] !== null && cs[1].n >= MIN_CTRL) {
                    const a20 = e.x[1] - cs[1].m;
                    (i < HALF_I ? byHalf[st].a : byHalf[st].b).push(a20); (byYear[st][y] ||= []).push(a20);
                    B.cw.push(cs[1].w);
                }
            }
        }
    }
    return { bag, base, byHalf, byYear, baseYearN, events, dropped, nLimit, HALF_I, ctrlN };
}

// ⭐ 賺賠比:贏的平均 ÷ 輸的平均。⛔ 只看勝率會漏掉「常對但賠更大」
//    (V72.0.3 那次自我修正:42 個 A 級訊號有 36 個期望值是負的)。
const payoff = a => {
    const w = a.filter(x => x > 0), l = a.filter(x => x <= 0);
    return (w.length && l.length) ? mean(w) / Math.abs(mean(l)) : null;
};
const wr = a => pct(a.filter(x => x > 0).length, a.length);

/** 【A】【B】要的數字(🔁 V79.4.3 vs對照一律是同一天對照;前後半 / 逐年 / 去最好年也是) */
export function stateRows(res) {
    const { bag, byHalf, byYear, baseYearN } = res;
    const rows = [];
    for (const [k, name] of STATES) {
        const B = bag[k];
        const o = { k, name, n: B.n, m5: med(B.r[5]), m20: med(B.r[20]), m60: med(B.r[60]), w20: wr(B.r[20]) };
        o.d5 = med(B.md[5]); o.d20 = med(B.md[20]); o.d60 = med(B.md[60]);     // 每筆減同一天中位數 → 再取中位
        o.cw20 = B.cw.length ? mean(B.cw) : null;                                // 同一天對照的 20 日勝率(照事件加權)
        o.po = payoff(B.r[20]);
        o.avg20 = mean(B.r[20]); o.dAvg = mean(B.a[20]);                         // 每筆減同一天平均 → 再取平均
        rows.push(o);
    }
    const yrs = Object.keys(baseYearN).sort().filter(y => baseYearN[y] >= 500);
    for (const o of rows) {
        // ⭐ 穩健性用**平均(期望值)**不用中位數 —— 決定賺不賺錢的是期望值。
        //    「獨走」型正是中位持平、平均卻 +0.89pp(少數大賺),只看中位會漏掉它的真面目
        //    (同 V72.0.3 的教訓:勝率高 ≠ 會賺錢,要看期望值)。
        o.h1 = byHalf[o.k].a.length >= 30 ? mean(byHalf[o.k].a) : null;
        o.h2 = byHalf[o.k].b.length >= 30 ? mean(byHalf[o.k].b) : null;
        const same = o.h1 !== null && o.h2 !== null && (o.h1 > 0) === (o.h2 > 0);
        o.yv = yrs.map(y => { const a = byYear[o.k][y] || []; return (a.length >= 30 && (baseYearN[y] || 0) >= 30) ? mean(a) : null; });
        const allSame = o.yv.every(v => v !== null) && o.yv.every(v => (v > 0) === (o.dAvg > 0));
        // ⭐⭐ 標準關卡:**拿掉最好的那一年還贏嗎** —— 本專案實測過五個「贏家」的 edge
        //    全部集中在同一個月(2026-04),拿掉就由正轉負。這一關成本是零,而且比「總量有沒有變多」嚴格得多。
        const idxBest = o.yv.reduce((bi, v, j) => (v !== null && (bi < 0 || v > o.yv[bi])) ? j : bi, -1);
        let rn = 0, rs = 0;
        yrs.forEach((y, j) => { if (j === idxBest) return; const a = byYear[o.k][y] || []; rn += a.length; rs += sum(a); });
        o.dropBest = rn ? rs / rn : null;
        o.bestYear = idxBest >= 0 ? yrs[idxBest] : '';
        o.same = same; o.allYear = allSame;
        o.pass = same && allSame && o.dropBest !== null && (o.dropBest > 0) === (o.dAvg > 0);
    }
    return { rows, yrs };
}

function main() {
    const L = loadAll(DATA, MAX_SYMS);
    const ctx = prepare(L);
    const res = collect(ctx);
    const { days, START, used } = ctx;
    const { base, bag, events } = res;
    const SUB = L.nFiles / Math.max(1, L.nAll);
    if (events < MIN_EV * SUB || used < 300 * SUB) {
        console.error(`❌ 空過守門:${used} 檔 / ${events} 個事件(門檻 ${Math.round(300 * SUB)} / ${Math.round(MIN_EV * SUB)})`);
        process.exit(1);
    }
    const { rows, yrs } = stateRows(res);

    // ═══════════ 5. 報告 ═══════════
    console.log('═'.repeat(100));
    console.log('🏭 「這波是誰在漲?」—— 族群 vs 個股 行情階段實測');
    console.log('═'.repeat(100));
    console.log(`樣本:${used} 檔(⚠️ 只有上市 —— industry_map 來自證交所公司基本資料,上櫃不在裡面)`
        + (L.nFiles < L.nAll ? `  【⚠️ MAX_SYMS 等距抽樣 ${L.nFiles}/${L.nAll} 檔,只給冒煙測試用】` : ''));
    console.log(`窗口:${days[START]} ~ ${days[days.length - 1]} ・ 事件 ${events.toLocaleString()} 個(同檔同狀態 ${DEDUP} 日去重)`);
    console.log(`對照組:同一天的全部可比(股·日)${base.n.toLocaleString()} 個,⛔ 沒有抽樣`);
    console.log('⚠️ 報酬全部**扣掉同期加權指數**;⛔ 未扣交易成本(來回約 0.44%)');
    console.log(`🔁 V79.4.3 「vs對照」= 每一筆減掉**同一天**全部可比股票(平均 / 中位數欄減中位數);同一天 < ${MIN_CTRL} 檔 → 丟掉 ${res.dropped.toLocaleString()} 筆;`
        + `收盤停在漲停(收盤買不到)剔除 ${res.nLimit.toLocaleString()} 個(股·日)`);

    console.log('\n' + '─'.repeat(100));
    console.log('【A】五種狀態之後的超額報酬(中位)與勝率');
    console.log('─'.repeat(100));
    console.log('狀態                        事件數   5日中位  20日中位 60日中位   20日勝率  vs對照   賺賠比  20日平均  vs對照');
    const bw = wr(base.r[20]);
    const bpo = payoff(base.r[20]);
    const bavg = mean(base.r[20]);
    console.log(`${'(對照組:所有掃到的)'.padEnd(24)} ${String(base.n).padStart(7)}  ${f(med(base.r[5]))}  ${f(med(base.r[20]))}  ${f(med(base.r[60]))}   ${bw.toFixed(1).padStart(6)}%      —      ${bpo.toFixed(2)}  ${f(bavg)}     —`);
    for (const o of rows) {
        console.log(`${o.name.padEnd(24)} ${String(o.n).padStart(7)}  ${f(o.m5)}  ${f(o.m20)}  ${f(o.m60)}   ${o.w20.toFixed(1).padStart(6)}%  ${o.cw20 == null ? '   --  ' : f(o.w20 - o.cw20, 6, 1)}pp    ${o.po == null ? ' -- ' : o.po.toFixed(2)}  ${f(o.avg20)}  ${f(o.dAvg, 6)}pp`);
    }
    console.log('\n(🔁 V79.4.3 vs對照 = 跟**同一天**的全部可比股票比 —— 勝率比同一天贏大盤的比例、平均減同一天平均、下表中位減同一天中位)');
    console.log('狀態                        vs對照 5日   vs對照 20日  vs對照 60日');
    for (const o of rows) console.log(`${o.name.padEnd(24)} ${f(o.d5, 9)}pp  ${f(o.d20, 9)}pp  ${f(o.d60, 9)}pp`);

    console.log('\n' + '─'.repeat(100));
    console.log('【B】穩健性:前後半段 + 逐年(⭐ 只有兩邊都同向才算數;用**平均超額**=期望值,⛔ 不用中位;🔁 都是同一天對照後的超額)');
    console.log('─'.repeat(100));
    console.log('狀態                        全期(pp)  前半     後半    同向   ' + yrs.map(y => y.slice(2)).join('      ') + '   逐年一致  拿掉最好年  判定');
    for (const o of rows) {
        console.log(`${o.name.padEnd(24)} ${f(o.dAvg, 8)}  ${o.h1 === null ? '  --  ' : f(o.h1, 6)}  ${o.h2 === null ? '  --  ' : f(o.h2, 6)}   ${o.same ? '✅' : '❌'}   ${o.yv.map(v => v === null ? '  --  ' : f(v, 6)).join(' ')}    ${o.allYear ? '✅' : '❌'}   ${o.dropBest === null ? '  --  ' : f(o.dropBest, 6)}(去${o.bestYear.slice(2)})  ${o.pass ? '⭐ 通過' : '❌'}`);
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
        // 🔁 V79.4.3 兩邊都是「減掉同一天全部可比股票平均」之後的分布(⛔ 不再拿整段的分布比)
        const s60 = B.a[60], s20 = B.a[20];
        const p = (a, q) => { const s = Float64Array.from(a).sort(); return s[Math.floor(s.length * q)] || 0; };
        console.log('           n      P10      P25     中位      P75      P90     (超額報酬分布,已減同一天平均)');
        console.log(`  20 日  ${String(s20.length).padStart(6)}  ${f(p(s20, .1))}  ${f(p(s20, .25))}  ${f(med(s20))}  ${f(p(s20, .75))}  ${f(p(s20, .9))}`);
        console.log(`  60 日  ${String(s60.length).padStart(6)}  ${f(p(s60, .1))}  ${f(p(s60, .25))}  ${f(med(s60))}  ${f(p(s60, .75))}  ${f(p(s60, .9))}`);
        const b20 = base.a[20], b60 = base.a[60];
        console.log(`  (對照 20 日) ${f(p(b20, .1))}  ${f(p(b20, .25))}  ${f(med(b20))}  ${f(p(b20, .75))}  ${f(p(b20, .9))}`);
        console.log(`  (對照 60 日) ${f(p(b60, .1))}  ${f(p(b60, .25))}  ${f(med(b60))}  ${f(p(b60, .75))}  ${f(p(b60, .9))}`);
        console.log('\n⭐ 看「分布」不是只看中位數:獨走型如果 P90 很高但 P10 很低,');
        console.log('   代表它是「少數大賺、多數被打回原形」→ 那不是「會漲」,是「賠率型」,做法完全不同。');
    }

    console.log('\n' + '═'.repeat(100));
    console.log('⛔ 讀這份報告的規則');
    console.log('  ① 對照組是同一天的全部可比(股·日)→ 每一筆都先減掉自己那一天的對照,再平均 / 取中位(🔁 V79.4.3)。');
    console.log('  ② 只信【B】判定「⭐ 通過」的(前後半段 + 逐年都同向)。');
    console.log('  ③ 【C】扣完成本沒剩的,⛔ 不可做成進出場訊號 —— 最多當「現在是什麼盤」的事實描述。');
    console.log('  ④ 產業別只有上市、而且是 TWSE 33 大類(半導體全擠在一類)→ 「族群」顆粒度偏粗。');
    console.log(`  ⑤ 窗口 ${days[0]} ~ ${days[days.length - 1]}(K 線已補深到 2021,含 2022 空頭;d16 從 2010 起);倖存者偏誤(industry_map 只有現在還在的上市股)。`);

    if (OUT) {
        fs.writeFileSync(OUT, JSON.stringify({
            meta: { stocks: used, events, from: days[START], to: days[days.length - 1], look: LOOK, dedup: DEDUP, cost: COST, baseN: base.n,
                    base: { m5: med(base.r[5]), m20: med(base.r[20]), m60: med(base.r[60]), w20: bw },
                    ctrl: 'same-day', minCtrl: MIN_CTRL, dropped: res.dropped, limitExcluded: res.nLimit },
            states: rows,
        }, null, 1));
        console.log(`\n💾 ${OUT}`);
    }
}

// ═══ selftest(不需要真資料;每一條都有決定性對照)═══
function selftest() {
    const bad = [];
    const ok = (name, c, x = '') => { console.log(`  ${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + String(x).slice(0, 220)}`); if (!c) bad.push(name); };
    const days = [];
    for (let t = Date.UTC(2012, 0, 2); t <= Date.UTC(2021, 11, 31); t += 86400000) {
        const dd = new Date(t); if (dd.getUTCDay() % 6 !== 0) days.push(dd.toISOString().slice(0, 10)); }
    const at = d => days.findIndex(x => x >= d);
    const tw = new Float64Array(days.length).fill(100);                     // 加權不動 → 超額 = 個股報酬
    // 2012~2016 每檔每天 +0.3%、2017~2021 −0.1%(全部股票一樣)
    const series = (bump = () => 0, mut = null) => { let p = 50; const v = new Float64Array(days.length);
        for (let k = 0; k < days.length; k++) { p *= 1 + (days[k] < '2017-01-01' ? 0.003 : -0.001) + bump(k); v[k] = p; }
        if (mut) mut(v); return v; };
    const build = (n, extra = {}) => {
        const CL = new Map(), indMap = {};
        for (let s = 0; s < n; s++) { const sym = String(1100 + s); CL.set(sym, series()); indMap[sym] = String(s % 4); }
        for (const [sym, v] of Object.entries(extra)) { CL.set(sym, v); indMap[sym] = '0'; }
        return prepare({ days, tw, CL, OP: null, indMap });
    };
    const START = 21;
    const sampled = k => (k - START) % STEP === 0;
    const near = d => { let k = at(d); while (!sampled(k)) k++; return k; };
    // 事件只在前段(2012~2016)、跟同一天的大家一模一樣
    const era1 = new Set(); for (let k = near('2013-01-02'); k < at('2016-11-01'); k += 60) era1.add(k);
    const k0 = near('2019-03-01');                          // 2000:之後 20 天每天多 +0.25%(真的有優勢)
    const kL = near('2013-06-03'), kL2 = near('2020-06-01');   // 3000:2013 收盤 +6.6%(2015-06 前 ±7% = 漲停)/ 3001:2020 同一根(±10%,買得到)
    const kC = near('2015-06-01');                          // 4000:那天之後減資恢復交易 ×1.6(斷崖)
    const kCb = kC - 9, kCa = near(days[kC + 25]);
    const bumpUp = k => (k > k0 && k <= k0 + 20 ? 0.0025 : 0);
    const jumpAt = (k, x) => v => { for (let q = k; q < v.length; q++) v[q] *= x; };
    const ctx = build(40, {
        2000: series(bumpUp),
        3000: series(() => 0, jumpAt(kL, 1.066)), 3001: series(() => 0, jumpAt(kL2, 1.066)),
        4000: series(() => 0, jumpAt(kC + 1, 1.6)),
    });
    ok('⓪ 合成資料的窗口從第 21 天開始(取樣日對得上)', ctx.START === START, ctx.START);
    const fake = (c, sym, i) => {
        if (sym === '1100' && era1.has(i)) return ['solo'];
        if (sym === '2000' && i === k0) return ['ind_up_follow'];
        if (sym === '3000' && i === kL) return ['ind_dn_follow'];
        if (sym === '3001' && i === kL2) return ['ind_dn_strong'];
        if (sym === '4000' && (i === kCb)) return ['ind_turn_up'];
        if (sym === '4000' && (i === kCa)) return ['ind_up_lag'];
        return [];
    };
    const res = collect(ctx, fake);
    const { rows } = stateRows(res);
    const R = k => rows.find(o => o.k === k);
    // ① 同一天對照
    const solo = R('solo');
    ok('① 事件只在多頭那段、跟同一天的大家一模一樣 → 超額 ≈ 0(同一天比)', solo.n === era1.size && Math.abs(solo.dAvg) < 0.02 && Math.abs(solo.d20) < 0.02,
        JSON.stringify({ n: solo.n, dAvg: solo.dAvg, d20: solo.d20 }));
    const oldEdge = solo.avg20 - mean(res.base.r[20]);
    ok('① 決定性對照:舊版(減整段對照平均)→ 憑空 > +2pp', oldEdge > 2, oldEdge);
    ok('① 勝率的對照也是同一天(同一天大家都贏大盤 → 差 ≈ 0)', solo.cw20 != null && Math.abs(solo.w20 - solo.cw20) < 1, JSON.stringify([solo.w20, solo.cw20]));
    const up = R('ind_up_follow');
    ok('② 真的多賺約 5% → 量到 +4.5~+5.5pp(平均與中位兩欄都是)', up.n === 1 && up.dAvg > 4.5 && up.dAvg < 5.5 && up.d20 > 4.5 && up.d20 < 5.5, JSON.stringify([up.dAvg, up.d20]));
    // ② 漲跌幅制度:收盤停在漲停 → 收盤買不到
    ok('③ 2013 年(±7%)收盤 +6.6% = 停在漲停 → 收盤買不到、事件不算', R('ind_dn_follow').n === 0 && res.nLimit >= 1, JSON.stringify([R('ind_dn_follow').n, res.nLimit]));
    ok('③ 同一根放到 2020 年(±10%)→ 買得到、照算', R('ind_dn_strong').n === 1, R('ind_dn_strong').n);
    const cN = i => res.ctrlN.get(i);
    ok('③ 對照組那一天也少掉那一檔(⛔ 只剔事件不剔對照 = 兩邊不同規則)', cN(kL) === 43 && cN(kL2) === 44, JSON.stringify([cN(kL), cN(kL2)]));
    // ③ 斷崖窗口
    const tu = res.bag.ind_turn_up;
    ok('④ 抱的期間碰到斷崖:5 日照算、20 / 60 日那格不算', tu.n === 1 && tu.r[5].length === 1 && tu.r[20].length === 0 && tu.r[60].length === 0,
        JSON.stringify([tu.n, tu.r[5].length, tu.r[20].length, tu.r[60].length]));
    const r4 = ctx.r20.get('4000');
    ok('④ 近 20 日報酬的窗口碰到斷崖 → 那幾天沒有報酬(不分類、不進對照);窗口外照算(⛔ 不整檔剔除)',
        Number.isNaN(r4[kC + 1]) && Number.isNaN(r4[kC + 20]) && !Number.isNaN(r4[kC + 21]) && R('ind_up_lag').n === 1 && cN(kC + 3) === 43 && cN(kCa) === 44,
        JSON.stringify([r4[kC + 1], r4[kC + 20], r4[kC + 21], R('ind_up_lag').n, cN(kC + 3), cN(kCa)]));
    // ⑤ 同一天對照太少 → 丟掉
    const ctx5 = build(20);
    const res5 = collect(ctx5, (c, sym, i) => (sym === '1100' && era1.has(i)) ? ['solo'] : []);
    ok(`⑤ 同一天對照組不到 ${MIN_CTRL} 檔 → 事件全部不算、而且有記下丟掉幾筆`, res5.bag.solo.n === 0 && res5.dropped === era1.size, JSON.stringify([res5.bag.solo.n, res5.dropped]));
    // ⑥ 斷崖前綴和照交易日對齊(停牌那幾天 NaN 不算斷崖、恢復那天才算)
    const vv = Float64Array.from([10, 10, NaN, NaN, 16.5, 16.6]);
    const pp = dayCliffPre(vv);
    ok('⑥ 停牌後恢復交易 ×1.65 → 恢復那天算斷崖(停牌那幾天不算)', !cliffIn(pp, 0, 3) && cliffIn(pp, 3, 4) && !cliffIn(pp, 4, 5), Array.from(pp));
    console.log(`\n${bad.length ? '❌ 失敗:' + bad.join(', ') : '✅ selftest 全過'}`);
    return bad.length ? 1 : 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
else main();
