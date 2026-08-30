#!/usr/bin/env node
/**
 * 🚀 「漲停前一天看得出來嗎」探針 —— 只讀 data/,不打網路、不寫產物。
 *
 * ❓ 問題(使用者 2026-08-30):
 *    「個股漲停時有什麼資訊可以提早知道或者是高機率?K線、籌碼、K線加籌碼、基本面、消息面」
 *
 * ⭐⭐ 這支問的是**還來得及的那一版**:
 *    站在 t 日**收盤**(13:30 之前決定),預測 **t+1 日會不會漲停**。
 *    ⛔ 不是「漲停之後怎麼辦」(那是 V72.0.1 漲停隔日動能,已經測過)。
 *    ⛔ 不是「今天漲停了嗎」(那是事後諸葛,零價值)。
 *
 * 🚨 前視偏誤守門(這類題目最容易死在這):
 *    所有條件**只能用 t 日(含)以前的資料**;標籤只看 t+1。
 *    ⛔ 不可用 t+1 的開盤/最高價當條件 —— 那是「開盤才知道」,跟「提早知道」是兩回事。
 *
 * 📐 兩個指標一起看(⛔ 只看其中一個一定會判錯):
 *    ① **命中率倍數 lift** = P(隔日漲停|條件) ÷ P(隔日漲停)
 *    ② **隔日超額報酬** = (買 t 收盤 → 賣 t+1 收盤) − 同期加權指數,再扣來回成本 0.44%
 *    ⭐ 本專案已經栽過一次(V72.0.3:42 個 A 級訊號有 36 個期望值是負的)——
 *      「比較容易漲停」跟「這樣做會賺錢」**不是同一件事**,漲停機率高的股票通常也跌得兇。
 *
 * 🚧 守門:
 *    ・可交易性:當日成交額 ≥ 1,000 萬元(⛔ 不然一堆冷門股用兩張成交就漲停,測出來的東西買不到)
 *    ・對照組 = **同一個母體、不抽樣**
 *    ・前後半段分開看 / 逐年分開看 / 拿掉最好那一年
 *    ・事件數 < 300 的桶標「樣本不足」,⛔ 不下結論
 *    ・整體事件數 < 20 萬 → exit 1(空過守門)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const WARM = 250;            // 需要 250 根才算得出年位階 / 個股漲停體質
const COST = 0.44;           // 股票來回成本 %(手續費 6 折 ×2 + 證交稅 0.3%)
const LU = 0.095;            // 漲停判定(台股 ±10%,留一點跳動單位誤差)
const MIN_AMT = 1e7;         // 🚧 可交易性:當日成交額 ≥ 1,000 萬元

// ── 日期軸(用加權指數當基準)──────────────────────────────
const twRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
const twArr = (Array.isArray(twRaw) ? twRaw : (twRaw.data || []))
    .filter(r => +r.close > 0);
const dates = twArr.map(r => String(r.date).replace(/\//g, '-'));
const dIdx = new Map(dates.map((d, i) => [d, i]));
const twC = twArr.map(r => +r.close);
const ND = dates.length;
console.log(`📈 日期軸 ${ND} 天(${dates[0]} ~ ${dates[ND - 1]})`);

// 大盤隔日報酬 %(t 收盤 → t+1 收盤)
const twNext = new Float64Array(ND);
for (let i = 0; i + 1 < ND; i++) twNext[i] = (twC[i + 1] / twC[i] - 1) * 100;
// 大盤 t+1 當日 開→收 %(⭐ 「買不到只好隔天開盤買」那條的對照組要用同一段時間)
const twO = twArr.map(r => +r.open || 0);
const twOC = new Float64Array(ND);
for (let i = 0; i < ND; i++) twOC[i] = twO[i] > 0 ? (twC[i] / twO[i] - 1) * 100 : 0;

// ── 產業別(只有上市有)────────────────────────────────────
let indMap = {};
try { indMap = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8')); } catch { }

// ── 基本面(季 EPS / 季營收 + 公布日規則,⛔ 不可用還沒公布的數字)──
//    Q1→5/15 ・ Q2→8/14 ・ Q3→11/14 ・ Q4→隔年 3/31
let fundMap = {};
try { fundMap = JSON.parse(fs.readFileSync(path.join(DATA, 'fund_yoy_gm.json'), 'utf8')); } catch { }
const pubDate = (period) => {
    const [y, m] = period.split('-').map(Number);
    if (m === 3) return `${y}-05-15`;
    if (m === 6) return `${y}-08-14`;
    if (m === 9) return `${y}-11-14`;
    return `${y + 1}-03-31`;
};
/** sym → [{pub, epsYoY, revYoY}] 依 pub 排序(已公布才看得到) */
const fundTL = new Map();
for (const [sym, o] of Object.entries(fundMap)) {
    const q = o && o.qeps;
    if (!Array.isArray(q) || q.length < 5) continue;
    const arr = [];
    for (let i = 4; i < q.length; i++) {
        const cur = q[i], prv = q[i - 4];
        if (!cur || !prv) continue;
        const rv = (+prv.revenue > 0 && +cur.revenue > 0) ? (cur.revenue / prv.revenue - 1) * 100 : null;
        const ep = (Math.abs(+prv.eps) > 0.01) ? ((cur.eps - prv.eps) / Math.abs(prv.eps)) * 100 : null;
        arr.push({ pub: pubDate(cur.period), rv, ep });
    }
    if (arr.length) fundTL.set(sym, arr.sort((a, b) => a.pub < b.pub ? -1 : 1));
}
console.log(`📒 基本面時間軸 ${fundTL.size} 檔(季報 + 公布日規則,⛔ 只看已公布的)`);

// ── 讀個股 ────────────────────────────────────────────────
const files = fs.readdirSync(DATA)
    .filter(f => /^\d{4,6}\.json$/.test(f))
    .filter(f => !/^00/.test(f));          // ⛔ 排除 ETF(漲跌幅限制與槓桿反向不同)
console.log(`📂 掃 ${files.length} 檔(已排除 ETF)`);

const stocks = [];
for (const f of files) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    rows = Array.isArray(rows) ? rows : (rows.data || []);
    if (!rows || rows.length < WARM + 30) continue;
    const n = rows.length;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n),
        c = new Float64Array(n), v = new Float64Array(n),
        fn = new Float64Array(n), tn = new Float64Array(n), mb = new Float64Array(n);
    const di = new Int32Array(n).fill(-1);
    let ok = 0;
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        c[i] = +r.close || 0; o[i] = +r.open || 0; h[i] = +r.high || 0; l[i] = +r.low || 0;
        v[i] = +r.volume || 0;
        fn[i] = +r.foreign_net || 0; tn[i] = +r.trust_net || 0; mb[i] = +r.margin_balance || 0;
        const g = dIdx.get(String(r.date).replace(/\//g, '-'));
        if (g !== undefined) { di[i] = g; ok++; }
    }
    if (ok < WARM + 30) continue;
    stocks.push({ sym: f.replace('.json', ''), n, o, h, l, c, v, fn, tn, mb, di });
}
console.log(`✅ 可用 ${stocks.length} 檔`);

// ── PASS A:全市場 / 各產業「當日漲停家數」(t 日收盤就知道)──
const dayLu = new Int32Array(ND), dayTot = new Int32Array(ND);
const INDS = [...new Set(Object.values(indMap))].sort();
const iIdx = new Map(INDS.map((x, i) => [x, i]));
const dayIndLu = new Int32Array(ND * INDS.length);
const dayIndTot = new Int32Array(ND * INDS.length);
for (const s of stocks) {
    const ii = iIdx.has(indMap[s.sym]) ? iIdx.get(indMap[s.sym]) : -1;
    for (let i = 1; i < s.n; i++) {
        const g = s.di[i]; if (g < 0) continue;
        if (!(s.c[i] > 0 && s.c[i - 1] > 0)) continue;
        dayTot[g]++;
        const up = s.c[i] / s.c[i - 1] - 1 >= LU;
        if (up) dayLu[g]++;
        if (ii >= 0) { dayIndTot[g * INDS.length + ii]++; if (up) dayIndLu[g * INDS.length + ii]++; }
    }
}

// ── 統計容器 ──────────────────────────────────────────────
const HB = 401, HOFF = 20, HSC = 10;   // −20% ~ +20%,0.1% 一格
const mkStat = () => ({
    n: 0, sum: 0, luC: 0, luT: 0, u5: 0, u3: 0, lock: 0, sumO: 0, sumL: 0, hist: new Int32Array(HB),
    byY: new Map(), h1n: 0, h1s: 0, h1lu: 0, h2n: 0, h2s: 0, h2lu: 0,
});
const FEAT = new Map();          // feature → Map(bucket → stat)
const ORDER = [];                // 維持顯示順序
/**
 * @param ex   買 t 收盤 → 賣 t+1 收盤 的超額 %
 * @param exO  🚨 買 t+1 **開盤** → 賣 t+1 收盤 的超額 %(= 「t 收盤買不到」時的實際版本)
 * @param lock t 日是否**漲停鎖死**(收=最高且漲停)→ 那天收盤買不到
 */
function rec(feat, bucket, ex, luC, luT, year, isH1, exO, lock, exL, up5, up3) {
    let m = FEAT.get(feat);
    if (!m) { m = new Map(); FEAT.set(feat, m); ORDER.push(feat); }
    let st = m.get(bucket);
    if (!st) { st = mkStat(); m.set(bucket, st); }
    st.n++; st.sum += ex; st.sumO += exO; st.sumL += exL; if (luC) st.luC++; if (luT) st.luT++; if (up5) st.u5++; if (up3) st.u3++; if (lock) st.lock++;
    let b = Math.round((ex + HOFF) * HSC); if (b < 0) b = 0; else if (b >= HB) b = HB - 1;
    st.hist[b]++;
    let y = st.byY.get(year); if (!y) { y = { n: 0, s: 0, lu: 0 }; st.byY.set(year, y); }
    y.n++; y.s += ex; if (luC) y.lu++;
    if (isH1) { st.h1n++; st.h1s += ex; if (luC) st.h1lu++; } else { st.h2n++; st.h2s += ex; if (luC) st.h2lu++; }
}
const medOf = st => {
    if (!st.n) return null;
    let acc = 0; const half = st.n / 2;
    for (let b = 0; b < HB; b++) { acc += st.hist[b]; if (acc >= half) return b / HSC - HOFF; }
    return null;
};

// ── PASS B:特徵 + 標籤 ───────────────────────────────────
// 🚨 前後半的中點**必須對齊實際樣本**,⛔ 不可用整條日期軸的中點 ——
//    日期軸從 2021-08 開始,但個股 K 線 2023-06 才有 + 250 根暖身
//    → 用 ND/2 的話**所有事件都會落在後半**,那一關等於沒作用(CLAUDE.md V73.2.9 記過同一個坑)。
let minG = Infinity, maxG = -1;
for (const s of stocks) {
    for (let i = WARM; i + 1 < s.n; i++) { if (s.di[i] >= 0) { if (s.di[i] < minG) minG = s.di[i]; break; } }
    for (let i = s.n - 2; i >= WARM; i--) { if (s.di[i] >= 0) { if (s.di[i] > maxG) maxG = s.di[i]; break; } }
}
const MID = Math.floor((minG + maxG) / 2);
console.log(`🗓️ 實際樣本區間 ${dates[minG]} ~ ${dates[maxG]}(中點 ${dates[MID]})`);
let EV = 0;
for (const s of stocks) {
    const { n, o, h, l, c, v, fn, tn, mb, di, sym } = s;
    const ftl = fundTL.get(sym) || null;
    let fp = 0;                      // 基本面時間軸游標
    for (let i = WARM; i + 1 < n; i++) {
        const g = di[i], g1 = di[i + 1];
        if (g < 0 || g1 < 0 || g1 <= g) continue;
        const pc = c[i - 1], cc = c[i], nc = c[i + 1], nh = h[i + 1];
        if (!(pc > 0 && cc > 0 && nc > 0 && nh > 0 && v[i] > 0)) continue;
        const amt = cc * v[i];
        if (amt < MIN_AMT) continue;                 // 🚧 可交易性

        // ── 標籤(⛔ 只用 t+1)──
        const luC = (nc / cc - 1) >= LU;
        const luT = (nh / cc - 1) >= LU;
        // 使用者要的是「漲停**或大漲**」→ 大漲用兩個門檻:收 ≥5% 與 ≥3%
        const up5 = (nc / cc - 1) >= 0.05;
        const up3 = (nc / cc - 1) >= 0.03;
        const ex = (nc / cc - 1) * 100 - twNext[g];  // 隔日超額 %
        // 🚨 「買得到嗎」:t 日**漲停鎖死**(收盤=最高且漲停)那天,收盤價根本買不到。
        //    → 另外算一條「隔天開盤才買、收盤賣」的實際版本(對照組用大盤同一段 開→收)。
        const no = o[i + 1];
        const exO = no > 0 ? (nc / no - 1) * 100 - twOC[g1] : 0;
        const lock = (cc / pc - 1) >= LU && cc >= h[i] - 1e-9;
        // 🎯 「掛漲停價賣」:隔日**盤中觸及**漲停就當成交在 +9.5%(⛔ 保守,不用 +10%),
        //    沒觸及就照收盤賣 —— 這是「真的預測到漲停」時實務上最合理的出場方式。
        const exL = (luT ? 9.5 : (nc / cc - 1) * 100) - twNext[g];
        const date = dates[g], year = date.slice(0, 4), isH1 = g < MID;
        EV++;
        const R = (f, b) => rec(f, b, ex, luC, luT, year, isH1, exO, lock, exL, up5, up3);
        R('對照組', '全部(隨便挑一天)');

        // ── K 線特徵 ───────────────────────────────────
        const chg = (cc / pc - 1) * 100;
        let v20 = 0; for (let k = i - 19; k <= i; k++) v20 += v[k]; v20 /= 20;
        const vr = v20 > 0 ? v[i] / v20 : 0;
        let hi252 = 0, lo252 = Infinity, hi60 = 0, luCnt = 0, ampS = 0;
        for (let k = i - 249; k <= i; k++) {
            if (h[k] > hi252) hi252 = h[k];
            if (l[k] > 0 && l[k] < lo252) lo252 = l[k];
            if (k > i - 250 && c[k - 1] > 0 && c[k] / c[k - 1] - 1 >= LU) luCnt++;
        }
        for (let k = i - 59; k <= i; k++) if (h[k] > hi60) hi60 = h[k];
        for (let k = i - 19; k <= i; k++) if (c[k] > 0) ampS += (h[k] - l[k]) / c[k] * 100;
        const amp20 = ampS / 20;
        const pos = (hi252 > lo252) ? (cc - lo252) / (hi252 - lo252) * 100 : 50;
        const dd60 = hi60 > 0 ? (cc / hi60 - 1) * 100 : 0;
        let streak = 0; for (let k = i; k > i - 20 && c[k] > c[k - 1]; k--) streak++;
        const clr = (h[i] > l[i]) ? (cc - l[i]) / (h[i] - l[i]) * 100 : 50;
        const gap = pc > 0 ? (o[i] / pc - 1) * 100 : 0;
        let ma5 = 0, ma20 = 0; for (let k = i - 4; k <= i; k++) ma5 += c[k]; ma5 /= 5;
        for (let k = i - 19; k <= i; k++) ma20 += c[k]; ma20 /= 20;
        let sd = 0; for (let k = i - 19; k <= i; k++) sd += (c[k] - ma20) ** 2;
        sd = Math.sqrt(sd / 20);
        const bbw = ma20 > 0 ? (4 * sd) / ma20 * 100 : 0;

        R('K線·今日漲跌幅', chg >= 9.5 ? 'a 今天漲停' : chg >= 7 ? 'b 漲 7~9.5%' : chg >= 5 ? 'c 漲 5~7%'
            : chg >= 3 ? 'd 漲 3~5%' : chg >= 1 ? 'e 漲 1~3%' : chg > -1 ? 'f 平盤 ±1%'
                : chg > -5 ? 'g 跌 1~5%' : 'h 跌超過 5%');
        R('K線·量比(vs 20日均量)', vr >= 5 ? 'a ≥5倍' : vr >= 3 ? 'b 3~5倍' : vr >= 2 ? 'c 2~3倍'
            : vr >= 1.2 ? 'd 1.2~2倍' : vr >= 0.8 ? 'e 0.8~1.2倍' : 'f <0.8倍(量縮)');
        R('K線·年位階', pos >= 90 ? 'a ≥90(貼著年高)' : pos >= 75 ? 'b 75~90' : pos >= 50 ? 'c 50~75'
            : pos >= 25 ? 'd 25~50' : 'e <25(年底部)');
        R('K線·距60日高', dd60 >= -1 ? 'a 創60日新高' : dd60 >= -5 ? 'b 差 1~5%' : dd60 >= -15 ? 'c 差 5~15%'
            : dd60 >= -30 ? 'd 差 15~30%' : 'e 差超過30%');
        R('K線·20日振幅(波動)', amp20 >= 6 ? 'a ≥6%(超高波)' : amp20 >= 4 ? 'b 4~6%' : amp20 >= 2.5 ? 'c 2.5~4%'
            : 'd <2.5%(牛皮)');
        R('K線·連漲天數', streak >= 5 ? 'a ≥5天' : streak >= 3 ? 'b 3~4天' : streak >= 1 ? 'c 1~2天'
            : 'd 今天收黑');
        R('K線·收盤在K棒位置', clr >= 90 ? 'a 收最高(≥90%)' : clr >= 70 ? 'b 70~90%' : clr >= 30 ? 'c 30~70%'
            : 'd 收最低(<30%)');
        R('K線·布林帶寬', bbw >= 25 ? 'a ≥25%(極寬)' : bbw >= 15 ? 'b 15~25%' : bbw >= 8 ? 'c 8~15%'
            : 'd <8%(壓縮)');
        R('K線·開盤跳空', gap >= 3 ? 'a 跳空 ≥3%' : gap >= 1 ? 'b 跳空 1~3%' : gap > -1 ? 'c 平開'
            : 'd 跳空下跌');
        R('K線·股價', cc >= 500 ? 'a ≥500元' : cc >= 200 ? 'b 200~500' : cc >= 100 ? 'c 100~200'
            : cc >= 50 ? 'd 50~100' : cc >= 20 ? 'e 20~50' : 'f <20元(雞蛋水餃)');
        R('K線·成交額', amt >= 3e9 ? 'a ≥30億' : amt >= 1e9 ? 'b 10~30億' : amt >= 3e8 ? 'c 3~10億'
            : amt >= 1e8 ? 'd 1~3億' : 'e 1000萬~1億(冷)');
        // ⭐ 這個是「使用者可能沒想到」的:這一檔自己過去一年漲停過幾次(漲停體質)
        R('⭐個股漲停體質(過去250日漲停次數)',
            luCnt >= 10 ? 'a ≥10次(常客)' : luCnt >= 5 ? 'b 5~9次' : luCnt >= 2 ? 'c 2~4次'
                : luCnt === 1 ? 'd 1次' : 'e 0次(一年沒漲停過)');

        // ── 漲停細分(今天已經漲停的那 1.9 萬筆,還能不能再分好壞)──
        let luStreak = 0;
        for (let k = i; k > i - 10 && c[k - 1] > 0 && c[k] / c[k - 1] - 1 >= LU; k--) luStreak++;
        if (luStreak >= 1) {
            R('🔥漲停細分·第幾根連板', luStreak >= 3 ? 'a 第3根以上' : luStreak === 2 ? 'b 第2根' : 'c 第1根');
            R('🔥漲停細分·量比', vr >= 5 ? 'a ≥5倍' : vr >= 3 ? 'b 3~5倍' : vr >= 1.5 ? 'c 1.5~3倍' : 'd <1.5倍(量縮鎖死)');
            R('🔥漲停細分·年位階', pos >= 90 ? 'a ≥90(高檔漲停)' : pos >= 50 ? 'b 50~90' : 'c <50(低檔漲停)');
            R('🔥漲停細分·有沒有鎖死', lock ? 'a 鎖死(收=最高)' : 'b 沒鎖死(打開過)');
        }

        // ── 市場面 ─────────────────────────────────────
        const mLu = dayLu[g];
        R('市場·當日全市場漲停家數', mLu >= 80 ? 'a ≥80家(全面狂熱)' : mLu >= 40 ? 'b 40~79家'
            : mLu >= 20 ? 'c 20~39家' : mLu >= 10 ? 'd 10~19家' : 'e <10家(冷)');
        const ii = iIdx.has(indMap[sym]) ? iIdx.get(indMap[sym]) : -1;
        if (ii >= 0 && dayIndTot[g * INDS.length + ii] >= 8) {
            const sLu = dayIndLu[g * INDS.length + ii];
            R('市場·同產業當日漲停家數', sLu >= 3 ? 'a ≥3家(族群點火)' : sLu === 2 ? 'b 2家'
                : sLu === 1 ? 'c 1家' : 'd 0家');
        }

        // ── ⭐ 「買得到的版本」:排除當天**漲停鎖死**的(那些收盤根本買不到)──
        //    上面整桶改「隔天開盤買」是**太粗**的測法 —— 實務上會直接跳過鎖死的那幾檔,
        //    所以真正要問的是:**只留買得到的那些,訊號還在嗎?**
        if (!lock) {
            if (dd60 >= -1) R('⭐買得到版(排除鎖死)', 'a 創60日新高');
            if (pos >= 90) R('⭐買得到版(排除鎖死)', 'b 年位階 ≥90');
            if (vr >= 2 && chg >= 3) R('⭐買得到版(排除鎖死)', 'c 爆量大漲(量≥2倍且漲≥3%)');
            if (amp20 >= 6) R('⭐買得到版(排除鎖死)', 'd 20日振幅 ≥6%');
            if (gap >= 3) R('⭐買得到版(排除鎖死)', 'e 跳空 ≥3%');
            if (clr >= 90) R('⭐買得到版(排除鎖死)', 'f 收最高(K棒上緣)');
            if (ii >= 0 && dayIndLu[g * INDS.length + ii] >= 3) R('⭐買得到版(排除鎖死)', 'g 同產業 ≥3家漲停');
            if (chg >= 7 && chg < 9.5) R('⭐買得到版(排除鎖死)', 'h 漲 7~9.5%(差一點漲停)');
            if (dd60 >= -1 && vr >= 2) R('⭐買得到版(排除鎖死)', 'i 創60日新高 + 量≥2倍');
            if (dd60 >= -1 && vr >= 2 && luCnt >= 5) R('⭐買得到版(排除鎖死)', 'j 新高+量增+漲停常客');
            R('⭐買得到版(排除鎖死)', 'z (對照)所有沒鎖死的日子');
        }

        // ── 🎯 前端要用的那一份:7 個「純 K 線算得出來」的條件 + **同時命中幾個** ──
        //    ⛔ 命中多個時**不可以把單一機率相乘** —— 這些條件高度相關(爆量/高波動/創新高常常一起來),
        //       相乘會嚴重高估。所以直接量「同時命中 N 個」的實際機率。
        const CONDS = [
            ['A 高波動(20日振幅≥6%)', amp20 >= 6],
            ['B 差一點漲停(漲7~9.5%)', chg >= 7 && chg < 9.5],
            ['C 跳空開高≥3%', gap >= 3],
            ['D 爆量大漲(量≥2倍且漲≥3%)', vr >= 2 && chg >= 3],
            ['E 年位階≥90', pos >= 90],
            ['F 創60日新高', dd60 >= -1],
            ['G 漲停常客(近一年≥5次)', luCnt >= 5],
        ];
        let hits = 0;
        for (const [, on] of CONDS) if (on) hits++;
        if (!lock) {
            for (const [nm, on] of CONDS) if (on) R('🎯前端條件·單一命中(排除鎖死)', nm);
            R('🎯前端條件·單一命中(排除鎖死)', 'zz (對照)沒鎖死的所有日子');
            R('🎯前端條件·同時命中幾個(排除鎖死)', hits >= 5 ? 'e 命中 5 個以上' : `${'abcde'[Math.min(hits, 4)]} 命中 ${hits} 個`);
        } else {
            R('🔒今天漲停鎖死(收盤買不到)', hits >= 3 ? 'b 同時命中 3 個以上' : 'a 命中 0~2 個');
        }

        // ── 籌碼 ───────────────────────────────────────
        const fnr = v[i] > 0 ? fn[i] / v[i] * 100 : 0;
        const tnr = v[i] > 0 ? tn[i] / v[i] * 100 : 0;
        let fn5 = 0, v5 = 0, fdays = 0;
        for (let k = i - 4; k <= i; k++) { fn5 += fn[k]; v5 += v[k]; }
        for (let k = i; k > i - 10 && fn[k] > 0; k--) fdays++;
        const fn5r = v5 > 0 ? fn5 / v5 * 100 : 0;
        const mbChg = mb[i - 5] > 0 ? (mb[i] / mb[i - 5] - 1) * 100 : null;
        const hasFn = fn.subarray(Math.max(0, i - 20), i + 1).some(x => x !== 0);
        if (hasFn) {
            R('籌碼·外資今日買超佔量比', fnr >= 20 ? 'a ≥20%(大買)' : fnr >= 10 ? 'b 10~20%' : fnr >= 3 ? 'c 3~10%'
                : fnr > -3 ? 'd ±3%(沒動)' : fnr > -10 ? 'e 賣 3~10%' : 'f 賣超過10%');
            R('籌碼·外資近5日買超佔量比', fn5r >= 15 ? 'a ≥15%' : fn5r >= 5 ? 'b 5~15%' : fn5r > -5 ? 'c ±5%'
                : 'd 賣超過5%');
            R('籌碼·外資連買天數', fdays >= 5 ? 'a 連買 ≥5天' : fdays >= 3 ? 'b 連買 3~4天'
                : fdays >= 1 ? 'c 連買 1~2天' : 'd 沒有連買');
        }
        const hasTn = tn.subarray(Math.max(0, i - 20), i + 1).some(x => x !== 0);
        if (hasTn) {
            R('籌碼·投信今日買超佔量比', tnr >= 10 ? 'a ≥10%(投信重壓)' : tnr >= 3 ? 'b 3~10%' : tnr > -3 ? 'c ±3%'
                : 'd 賣超過3%');
        }
        if (mbChg !== null) {
            R('籌碼·融資5日增減', mbChg >= 20 ? 'a 增 ≥20%(散戶追)' : mbChg >= 5 ? 'b 增 5~20%' : mbChg > -5 ? 'c ±5%'
                : mbChg > -20 ? 'd 減 5~20%' : 'e 減 ≥20%(洗乾淨)');
        }
        if (hasFn && hasTn) {
            const tag = (fnr >= 3 && tnr >= 3) ? 'a 外資+投信同買' : (fnr <= -3 && tnr <= -3) ? 'd 外資+投信同賣'
                : (fnr >= 3 || tnr >= 3) ? 'b 只有一邊買' : 'c 都沒動';
            R('籌碼·法人兩邊一起看', tag);
        }

        // ── 基本面(已公布的最近一季)────────────────────
        if (ftl) {
            while (fp + 1 < ftl.length && ftl[fp + 1].pub <= date) fp++;
            const cur = (ftl[fp] && ftl[fp].pub <= date) ? ftl[fp] : null;
            if (cur && cur.rv !== null) {
                R('基本面·最近一季營收YoY', cur.rv >= 50 ? 'a ≥+50%' : cur.rv >= 20 ? 'b +20~50%'
                    : cur.rv >= 0 ? 'c 0~+20%' : cur.rv >= -20 ? 'd −20~0%' : 'e 衰退超過20%');
            }
            if (cur && cur.ep !== null) {
                R('基本面·最近一季EPS YoY', cur.ep >= 100 ? 'a ≥+100%' : cur.ep >= 30 ? 'b +30~100%'
                    : cur.ep >= 0 ? 'c 0~+30%' : 'd 衰退');
            }
        }

        // ── 組合:K線 × 籌碼(先挑最直覺的幾組,細節看主表再決定)──
        const hot = (vr >= 2 && chg >= 3);                 // 爆量大漲
        const strong = (pos >= 75 && amp20 >= 4);          // 🧬 App 現行配置:高位階+高波動
        if (hasFn) {
            if (hot) R('組合·爆量大漲 × 外資', fnr >= 3 ? 'a 外資也在買' : fnr <= -3 ? 'c 外資在賣' : 'b 外資沒動');
            if (strong) R('組合·高位階高波動 × 外資', fnr >= 3 ? 'a 外資也在買' : fnr <= -3 ? 'c 外資在賣' : 'b 外資沒動');
        }
        if (hot) R('組合·爆量大漲 × 漲停體質', luCnt >= 5 ? 'a 漲停常客' : luCnt >= 1 ? 'b 偶爾漲停' : 'c 一年沒漲停過');
        R('組合·爆量大漲 × 族群點火',
            (hot ? '爆量大漲' : '沒有') + '｜' + ((ii >= 0 && dayIndLu[g * INDS.length + ii] >= 2) ? '族群有2家以上漲停' : '族群沒動'),);
    }
}

console.log(`\n🔢 事件(股·日)= ${EV.toLocaleString()}`);
if (EV < 200000) { console.error('🚧 空過守門:事件數太少,結論不可信'); process.exit(1); }

// ── 輸出 ──────────────────────────────────────────────────
const base = FEAT.get('對照組').get('全部(隨便挑一天)');
const bC = base.luC / base.n, bT = base.luT / base.n;
const bEx = base.sum / base.n;
console.log(`\n📊 對照組(隨便挑一天,成交額 ≥1000萬):`);
console.log(`   隔日**收**漲停 ${(bC * 100).toFixed(3)}%(約 ${Math.round(1 / bC)} 天一次)`);
console.log(`   隔日**盤中觸及**漲停 ${(bT * 100).toFixed(3)}%`);
console.log(`   隔日超額報酬 平均 ${bEx.toFixed(3)}% ・中位 ${medOf(base).toFixed(2)}%`);

const pct = x => (x * 100).toFixed(3);
const NLB = FEAT.get('⭐買得到版(排除鎖死)').get('z (對照)所有沒鎖死的日子');
for (const feat of ORDER) {
    if (feat === '對照組') continue;
    const m = FEAT.get(feat);
    console.log(`\n━━━ ${feat} ━━━`);
    // ⭐ 「買得到版」區塊的倍數分母要用**它自己的對照組**(所有沒鎖死的日子),
    //    ⛔ 不可用全母體 —— 鎖死那批的漲停率是 20%,會把分母墊高、倍數看起來變小。
    // ⛔ 「排除鎖死」的三個區塊一律用**沒鎖死的日子**當分母;⛔ 用全母體會低估倍數
    //    (鎖死那批的漲停率是 20%,會把分母墊高)。
    const zb = /^[⭐🎯]/.test(feat) ? NLB : null;
    const dC = zb ? zb.luC / zb.n : bC, dT = zb ? zb.luT / zb.n : bT;
    console.log(`  桶                              事件數   收漲停%  倍數  觸及%  倍數 │ ≥5%   ≥3%  │ 收盤買 扣成本 │ 鎖死% 掛漲停賣${zb ? '   (倍數分母=沒鎖死的日子)' : ''}`);
    for (const b of [...m.keys()].sort()) {
        const st = m.get(b);
        const pC = st.luC / st.n, pT = st.luT / st.n;
        const mean = st.sum / st.n, md = medOf(st), mo = st.sumO / st.n, ml = st.sumL / st.n;
        const flag = st.n < 300 ? ' ⚠️樣本不足' : '';
        console.log(`  ${b.padEnd(30)} ${String(st.n).padStart(7)}  ${pct(pC).padStart(7)} ${(pC / dC).toFixed(2).padStart(5)}x ${pct(pT).padStart(6)} ${(pT / dT).toFixed(2).padStart(5)}x │ ${pct(st.u5 / st.n).padStart(6)} ${pct(st.u3 / st.n).padStart(6)} │ ${(mean - COST).toFixed(3).padStart(7)} ${md.toFixed(2).padStart(6)} │ ${pct(st.lock / st.n).padStart(6)} ${(ml - COST).toFixed(3).padStart(9)}${flag}`);
    }
}

// ── 六道關卡:只對「命中倍數 ≥1.5 且 扣成本後為正」的桶做 ──
console.log(`\n\n${'='.repeat(96)}`);
console.log('🏁 穩健性檢定(只看「命中倍數 ≥1.5x」且「扣成本後仍為正」的桶)');
console.log('='.repeat(96));
let pass = 0, cand = 0;
for (const feat of ORDER) {
    if (feat === '對照組') continue;
    for (const [b, st] of FEAT.get(feat)) {
        const pC = st.luC / st.n, mean = st.sum / st.n;
        if (st.n < 300 || pC / bC < 1.5 || mean - COST <= 0) continue;
        cand++;
        const h1 = st.h1n ? st.h1s / st.h1n - COST : NaN;
        const h2 = st.h2n ? st.h2s / st.h2n - COST : NaN;
        const ys = [...st.byY.entries()].sort();
        const yv = ys.map(([y, o]) => [y, o.s / o.n - COST, o.n]);
        const allPos = yv.every(([, x]) => x > 0);
        const best = yv.reduce((a, x) => (x[1] > a[1] ? x : a), yv[0]);
        const exBestN = st.n - best[2], exBestS = st.sum - st.byY.get(best[0]).s;
        const exBest = exBestN ? exBestS / exBestN - COST : NaN;
        const okAll = h1 > 0 && h2 > 0 && allPos && exBest > 0;
        const mo = st.sumO / st.n - COST, lk = st.lock / st.n;
        const buyable = mo > 0;
        if (okAll && buyable) pass++;
        console.log(`\n${okAll && buyable ? '✅' : '❌'} ${feat} → ${b}  (n=${st.n}, ${(pC / bC).toFixed(2)}x, 收盤買扣成本 ${(mean - COST).toFixed(3)}%)`);
        console.log(`   前半 ${h1.toFixed(3)}% / 後半 ${h2.toFixed(3)}%  ${h1 > 0 && h2 > 0 ? '✅' : '❌ 前後半不同向'}`);
        console.log(`   逐年 ${yv.map(([y, x, nn]) => `${y}:${x.toFixed(2)}(${nn})`).join(' ')}  ${allPos ? '✅' : '❌'}`);
        console.log(`   拿掉最好那一年(${best[0]})後 ${exBest.toFixed(3)}%  ${exBest > 0 ? '✅' : '❌ 靠單一年'}`);
        console.log(`   🚨 買得到嗎:當天漲停鎖死 ${(lk * 100).toFixed(1)}% → 改「隔天開盤買」${mo.toFixed(3)}%  ${buyable ? '✅' : '❌ 買不到就沒了'}`);
    }
}
console.log(`\n候選 ${cand} 個,六關全過 ${pass} 個`);
if (!cand) console.log('（沒有任何桶同時滿足「命中倍數 ≥1.5x」與「扣成本後為正」）');


// ── 📤 EMIT:產出可嵌進 index.html 的 `_LU_ODDS`(⛔ 前端不可再寫第二份數字)──
if (process.env.EMIT) {
    const single = FEAT.get('🎯前端條件·單一命中(排除鎖死)');
    const joint = FEAT.get('🎯前端條件·同時命中幾個(排除鎖死)');
    const lockF = FEAT.get('🔒今天漲停鎖死(收盤買不到)');
    const zz = single.get('zz (對照)沒鎖死的所有日子');
    const P = st => [+(st.luC / st.n * 100).toFixed(2), +(st.u5 / st.n * 100).toFixed(2),
    +(st.u3 / st.n * 100).toFixed(2), st.n, +(st.sum / st.n - COST).toFixed(3)];
    const out = {
        win: [dates[minG], dates[maxG]], syms: stocks.length, n: zz.n,
        base: P(zz),                      // [漲停%, ≥5%, ≥3%, n, 扣成本超額%]
        cond: {}, hits: {}, lock: {},
    };
    for (const [k, st] of single) if (!k.startsWith('zz')) out.cond[k.slice(0, 1)] = P(st);
    for (const [k, st] of joint) out.hits[k.replace(/^[a-z] 命中 /, '').replace(' 個以上', '+').replace(' 個', '')] = P(st);
    for (const [k, st] of lockF) out.lock[k.slice(0, 1)] = P(st);
    console.log('\n===EMIT_JSON===');
    console.log(JSON.stringify(out));
}
