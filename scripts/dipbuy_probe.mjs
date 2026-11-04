#!/usr/bin/env node
// 📉 V79.3.1 「今天大跌,怎麼撿便宜?」—— 0050 層級的三個問題(使用者:「做」)
//
//  (A) 加權當天跌 ≥X%(X = 1.5 / 2 / 3)那天**尾盤**買 0050(含息),之後 5/20/60/120/250 天
//      vs 同期隨便挑一天(全部交易日);安慰劑 = 同樣天數隨機抽日子(固定種子)2,000 次
//      ⚠️ 同一段跌勢連續觸發會擠在一起 → 另印「獨立波段數」(前後隔 >20 個交易日才算新的一段)
//  (B) 手上有 100 萬、今天大跌:一次買 vs 分批買
//      L  今天尾盤一次買完
//      S4 今天 1/4,之後第 5/10/15 個交易日各 1/4(照時間分)
//      SD 今天 1/4,之後每遇到下一次大跌再買 1/4,60 天內沒用完的第 60 天全買(等更低)
//      W20 等 20 天再一次買
//      → 看第 120 / 250 天市值;⭐ 對照:同樣四種買法套在**隨便挑的日子**,差距一樣大就不是「大跌」的功勞
//  (C) 每月存 1 萬:平常定期定額 vs 「錢存著、大跌才買」(等太久 3/6 個月照買)vs 一半一半
//      10 年窗口、起點每 3 個月一條(2011~2016),最後市值配對比較;現金利率 0% 與 1.5% 各跑一次
//
//  (D) 🗓️ V81.0.0 大跌 × 星期幾(使用者 11/03:「大盤大跌又剛好遇到禮拜幾,要先賣還是撿便宜?」)
//      D0 平常日子:加權每一天依星期幾分組(收盤對收盤)平均 / 中位 / 上漲比例
//      D1 大跌那天(跌 ≥2% / ≥3%)依星期幾分:尾盤買 0050 含息,之後 1/5/20/60 天
//         vs **同一個星期幾的隨便一天**(⛔ 不跟全部日子比:星期一本來就比較顛);
//         ⭐ 主檢定 = 「星期 W 的大跌」vs「其他星期的大跌」—— 打亂星期幾標籤 2,000 次(排列檢定);40 格一起做 BH
//         先賣再買回:那天收盤賣、h 天後收盤買回 vs 一直抱 = −(之後 h 天報酬) − 來回成本(0050:賣 0.1425%×0.6 + 稅 0.1% + 買)
//      D2 隔天開盤跳空(STOCK_DIR 給了才算):全部股票「隔天開盤 ÷ 大跌那天收盤」平均(±11% 以外不算)
//         vs 同一個星期幾的平常日子 —— ⚠️ ⛔ 用 ^TWII 開盤(陷阱 #47:09:00 用昨收湊出來的)
//      星期幾一律用日期字串的 UTC 星期(⛔ 不看執行環境的時區)
//  ⛔ 描述與比較,不是選股訊號;⛔ 不改 App。
//  ⚠️ 進場用**當天收盤**:真的要做是 13:25 看到大盤跌夠了掛收盤(同 V72.9.0 尾盤進場)。
//
// 跑法:
//   DATA_DIR=$S/d10n DIV=data/dividends_hist.json node scripts/dipbuy_probe.mjs out.json
//   (DATA_DIR 需要 _bench0050.json 與 ^TWII.json;DIV 不給就讀 DATA_DIR/_div0050.json)
//   (D) 隔天開盤跳空另外要 STOCK_DIR=<d16>(全部股票的日 K;沒給就不算 D2)
//   ONLY_D=1 只跑 (D)
//   (E)~(H):IDX_LONG=<idx_long.json> IDX_EARLY=<idx_long_early.json> TWII_NOW=<^TWII.json> node scripts/dipbuy_probe.mjs out.json
//            (三份都在 data 分支:data/idx_long.json / data/idx_long_early.json / data/^TWII.json;沒給 DATA_DIR 就只跑 E~H)
//   node scripts/dipbuy_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trSeries, d10, num } from './lib_totalreturn.mjs';

export const XS = [1.5, 2, 3];
export const HS = [5, 20, 60, 120, 250];
export const BUY_FEE = 0.001425 * 0.6;
const EP_GAP = 20;

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);

// 固定種子亂數(mulberry32)
export function rng(seed) {
    let a = seed >>> 0;
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** 對齊:回 {d[], idx[](加權收盤), tr[](0050 含息指數)} */
export function align(twii, b0050, divs) {
    const m = new Map(twii.map(r => [r.d, r.c]));
    const bars = b0050.filter(r => m.has(r.d));
    const tr = trSeries(bars, divs).v;
    return { d: bars.map(b => b.d), idx: bars.map(b => m.get(b.d)), tr };
}

/** 加權當天跌 ≥X% 的日子(收盤對收盤) */
export function dropDays(idx, X) {
    const out = [];
    for (let i = 1; i < idx.length; i++) if ((idx[i] / idx[i - 1] - 1) * 100 <= -X) out.push(i);
    return out;
}
export function episodes(ev, gap = EP_GAP) {
    let n = 0, last = -1e9;
    for (const i of ev) { if (i - last > gap) n++; last = i; }
    return n;
}
export const fwd = (tr, i, h) => i + h < tr.length ? (tr[i + h] / tr[i] - 1) * 100 : null;

// ---------- (A) ----------
export function partA(S, X, seed = 7) {
    const ev = dropDays(S.idx, X);
    const out = { X, n: ev.length, ep: episodes(ev), h: {} };
    const R = rng(seed + Math.round(X * 10));
    for (const h of HS) {
        const all = []; for (let i = 1; i < S.tr.length; i++) { const f = fwd(S.tr, i, h); if (f != null) all.push(f); }
        const e = ev.map(i => fwd(S.tr, i, h)).filter(f => f != null);
        if (!e.length) { out.h[h] = { n: 0 }; continue; }
        const em = mean(e), bm = mean(all);
        // 安慰劑:同樣天數隨機抽
        let ge = 0; const SIMS = 2000;
        for (let s = 0; s < SIMS; s++) {
            let sum = 0; for (let k = 0; k < e.length; k++) sum += all[Math.floor(R() * all.length)];
            if (sum / e.length >= em) ge++;
        }
        // 逐年 + 前後半(按事件日期)
        const yr = {};
        for (const i of ev) { const f = fwd(S.tr, i, h); if (f == null) continue; const y = S.d[i].slice(0, 4); (yr[y] = yr[y] || []).push(f); }
        const half = Math.floor(e.length / 2);
        out.h[h] = {
            n: e.length, ev: r2(em), base: r2(bm), diff: r2(em - bm),
            up: r2(e.filter(x => x > 0).length / e.length * 100), upBase: r2(all.filter(x => x > 0).length / all.length * 100),
            p: +(ge / SIMS).toFixed(3),
            h1: r2(mean(e.slice(0, half)) - bm), h2: r2(mean(e.slice(half)) - bm),
            yrs: Object.fromEntries(Object.entries(yr).map(([y, a]) => [y, { n: a.length, m: r2(mean(a)) }])),
        };
    }
    return out;
}

// ---------- (B) ----------
// 回第 H 天市值(本金 1,現金不計息);tr 為含息指數
export function deploy(S, i0, mode, X, H) {
    const end = i0 + H; if (end >= S.tr.length) return null;
    let cash = 1, units = 0;
    const buy = (i, amt) => { amt = Math.min(amt, cash); if (amt <= 0) return; units += amt * (1 - BUY_FEE) / S.tr[i]; cash -= amt; };
    if (mode === 'L') buy(i0, 1);
    else if (mode === 'W20') buy(i0 + 20, 1);
    else if (mode === 'S4') { for (const k of [0, 5, 10, 15]) buy(i0 + k, 0.25); }
    else if (mode === 'SD') {
        buy(i0, 0.25);
        for (let i = i0 + 1; i <= i0 + 60 && cash > 1e-9; i++) {
            if ((S.idx[i] / S.idx[i - 1] - 1) * 100 <= -X) buy(i, 0.25);
            if (i === i0 + 60) buy(i, cash);
        }
    }
    return cash + units * S.tr[end];
}
export const MODES = ['L', 'S4', 'SD', 'W20'];
export function partB(S, X, H, seed = 11) {
    const ev = dropDays(S.idx, X);
    const res = (days) => {
        const v = {}; for (const m of MODES) v[m] = [];
        for (const i of days) { const r = MODES.map(m => deploy(S, i, m, X, H)); if (r.some(x => x == null)) continue; MODES.forEach((m, k) => v[m].push(r[k])); }
        const n = v.L.length; if (!n) return { n: 0 };
        const o = { n };
        for (const m of MODES) {
            o[m] = r2((mean(v[m]) - 1) * 100);
            if (m !== 'L') o[m + 'win'] = r2(v[m].filter((x, k) => x > v.L[k]).length / n * 100);   // 這種買法贏一次買的 %
        }
        return o;
    };
    // 對照:隨便挑的日子(同樣天數、固定種子)
    const R = rng(seed + H + Math.round(X * 10)), pool = [];
    for (let i = 1; i < S.tr.length - H; i++) pool.push(i);
    const rnd = []; for (let k = 0; k < Math.max(ev.length, 400); k++) rnd.push(pool[Math.floor(R() * pool.length)]);
    return { X, H, ev: res(ev), rnd: res(rnd) };
}

// ---------- (C) ----------
// 每月第一個交易日存入 1;mode: dca / dip:M(等 M 個月沒大跌就照買)/ half:M
export function monthly(S, i0, i1, mode, X, cashR = 0) {
    let cash = 0, units = 0, put = 0, lastBuyMon = 0, mon = 0;
    const dr = Math.pow(1 + cashR, 1 / 252) - 1;
    const buy = (i, amt) => { amt = Math.min(amt, cash); if (amt <= 0) return; units += amt * (1 - BUY_FEE) / S.tr[i]; cash -= amt; };
    const [kind, Ms] = mode.split(':'); const M = +Ms || 0;
    for (let i = i0; i <= i1; i++) {
        cash *= 1 + dr;
        const newMon = i === i0 || S.d[i].slice(0, 7) !== S.d[i - 1].slice(0, 7);
        if (newMon) {
            mon++; cash += 1; put += 1;
            if (kind === 'dca') buy(i, cash);
            else if (kind === 'half') buy(i, 0.5);
        }
        const drop = i > 0 && (S.idx[i] / S.idx[i - 1] - 1) * 100 <= -X;
        if (kind !== 'dca') {
            if (drop) { buy(i, cash); lastBuyMon = mon; }
            else if (newMon && M && mon - lastBuyMon >= M) { buy(i, cash); lastBuyMon = mon; }
        }
    }
    return { v: cash + units * S.tr[i1], put };
}
export const CMODES = ['dca', 'dip:3', 'dip:6', 'dip:0', 'half:6'];
export function partC(S, X, YEARS = 10, cashR = 0) {
    const out = { X, cashR, starts: [] };
    const span = Math.round(YEARS * 252);
    for (let i0 = 1; i0 + span < S.tr.length; i0 += 63) {
        const i1 = i0 + span;
        const row = { from: S.d[i0], to: S.d[i1] };
        for (const m of CMODES) { const r = monthly(S, i0, i1, m, X, cashR); row[m] = r.v / r.put; row.put = r.put; }
        out.starts.push(row);
    }
    const n = out.starts.length;
    out.summary = {};
    for (const m of CMODES) {
        const a = out.starts.map(r => r[m]).sort((x, y) => x - y);
        out.summary[m] = { med: r2((a[a.length >> 1] - 1) * 100), worst: r2((a[0] - 1) * 100), best: r2((a[a.length - 1] - 1) * 100),
            beatDca: m === 'dca' ? null : out.starts.filter(r => r[m] > r.dca).length, n };
    }
    return out;
}

// ---------- (D) 大跌 × 星期幾 ----------
export const WD_NAME = ['日', '一', '二', '三', '四', '五', '六'];
/** 星期幾(0=日…6=六):⛔ 不用 new Date(d).getDay() —— 那會吃執行環境的時區(紐約會把星期一算成星期日) */
export const wdOf = d => new Date(String(d).slice(0, 10) + 'T00:00:00Z').getUTCDay();
export const DHS = [1, 5, 20, 60];
export const DXS = [2, 3];
// 0050 來回成本(%):賣手續費 + 證交稅 0.1%(ETF)+ 買手續費(手續費 6 折)
export const RT_COST_0050 = (0.001425 * 0.6 * 2 + 0.001) * 100;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
/** Benjamini–Hochberg:回每一格的 q 值(同順序) */
export function bh(ps) {
    const ix = ps.map((p, i) => [p, i]).filter(x => x[0] != null).sort((a, b) => a[0] - b[0]);
    const q = ps.map(() => null); let prev = 1;
    for (let k = ix.length - 1; k >= 0; k--) { const [p, i] = ix[k]; prev = Math.min(prev, p * ix.length / (k + 1)); q[i] = +prev.toFixed(4); }
    return q;
}
/** D0:每一天依星期幾(加權收盤對收盤) */
export function partD0(S) {
    const by = {}; for (let w = 1; w <= 5; w++) by[w] = [];
    for (let i = 1; i < S.idx.length; i++) { const w = wdOf(S.d[i]); if (by[w]) by[w].push((S.idx[i] / S.idx[i - 1] - 1) * 100); }
    const out = {};
    for (let w = 1; w <= 5; w++) { const a = by[w]; const half = a.length >> 1;
        out[w] = { n: a.length, m: r2(mean(a) * 100) / 100, med: r2(med(a) * 100) / 100, up: r2(a.filter(x => x > 0).length / a.length * 100),
            sd: r2(Math.sqrt(mean(a.map(x => x * x)) - mean(a) ** 2)), bigDn: r2(a.filter(x => x <= -2).length / a.length * 100),
            h1: r2(mean(a.slice(0, half)) * 100) / 100, h2: r2(mean(a.slice(half)) * 100) / 100 }; }
    return out;
}
/** D1:大跌那天依星期幾 → 之後 h 天(0050 含息)。gapByDate(可省)= {date: 那天全部股票平均開盤跳空%} */
export function partD1(S, X, seed = 31, gapByDate = null) {
    const ev = dropDays(S.idx, X);
    const R = rng(seed + Math.round(X * 10));
    const pool = {}; for (let w = 1; w <= 5; w++) pool[w] = [];
    for (let i = 1; i < S.tr.length; i++) { const w = wdOf(S.d[i]); if (pool[w]) pool[w].push(i); }
    const out = { X, n: ev.length, ep: episodes(ev), w: {} };
    const evW = {}; for (let w = 1; w <= 5; w++) evW[w] = ev.filter(i => wdOf(S.d[i]) === w);
    for (let w = 1; w <= 5; w++) {
        const e = evW[w], o = { n: e.length, ep: episodes(e, EP_GAP), h: {} };
        for (const h of DHS) {
            const ef = e.map(i => fwd(S.tr, i, h)).filter(f => f != null);
            const pf = pool[w].map(i => fwd(S.tr, i, h)).filter(f => f != null);
            if (ef.length < 3) { o.h[h] = { n: ef.length }; continue; }
            // 其他星期的大跌(同一個 h)
            const oth = ev.filter(i => wdOf(S.d[i]) !== w).map(i => fwd(S.tr, i, h)).filter(f => f != null);
            const all = ev.map(i => fwd(S.tr, i, h)).filter(f => f != null);
            const em = mean(ef), pm = mean(pf), om = mean(oth), obs = em - om;
            // 排列檢定:打亂「這次大跌是星期幾」的標籤
            let ge = 0; const SIMS = 2000; const k = ef.length;
            for (let s = 0; s < SIMS; s++) {
                const a = all.slice();
                for (let j = 0; j < k; j++) { const r = j + Math.floor(R() * (a.length - j)); [a[j], a[r]] = [a[r], a[j]]; }
                const m1 = mean(a.slice(0, k)), m2 = mean(a.slice(k));
                if (Math.abs(m1 - m2) >= Math.abs(obs) - 1e-12) ge++;
            }
            const half = ef.length >> 1;
            o.h[h] = { n: ef.length, ev: r2(em), base: r2(pm), diff: r2(em - pm), oth: r2(om), vsOth: r2(obs),
                up: r2(ef.filter(x => x > 0).length / ef.length * 100), upBase: r2(pf.filter(x => x > 0).length / pf.length * 100),
                p: +(ge / SIMS).toFixed(3), h1: r2(mean(ef.slice(0, half)) - pm), h2: r2(mean(ef.slice(half)) - pm),
                // 先賣、h 天後買回 vs 一直抱:平均差多少 % / 幾次先賣比較好(扣完成本)
                sellAdv: r2(-em - RT_COST_0050), sellWin: r2(ef.filter(x => -x - RT_COST_0050 > 0).length / ef.length * 100) };
        }
        if (gapByDate) {
            const g = e.map(i => i + 1 < S.d.length ? gapByDate[S.d[i + 1]] : null).filter(x => x != null);
            const gb = pool[w].filter(i => !e.includes(i)).map(i => i + 1 < S.d.length ? gapByDate[S.d[i + 1]] : null).filter(x => x != null);
            const go = ev.filter(i => wdOf(S.d[i]) !== w).map(i => i + 1 < S.d.length ? gapByDate[S.d[i + 1]] : null).filter(x => x != null);
            o.gap = g.length ? { n: g.length, ev: r2(mean(g)), base: r2(mean(gb)), oth: r2(mean(go)), up: r2(g.filter(x => x > 0).length / g.length * 100) } : { n: 0 };
        }
        out.w[w] = o;
    }
    return out;
}
/** D2 用:全部股票「今天開盤 ÷ 昨天收盤 −1」的當天平均(±11% 以外、量 0 不算) */
export function gapIndex(dir, maxFiles = 0) {
    const sum = new Map(), cnt = new Map();
    let files = fs.readdirSync(dir).filter(f => /^\d{4,6}[A-Z]?\.json$/.test(f) && !f.startsWith('00'));
    if (maxFiles) files = files.slice(0, maxFiles);
    for (const f of files) {
        let rows; try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!Array.isArray(rows)) continue;
        let pc = null;
        for (const r of rows) {
            const c = num(r.close), o = num(r.open), v = num(r.volume), d = d10(r.date);
            if (c > 0 && o > 0 && pc > 0 && v > 0) { const g = (o / pc - 1) * 100; if (Math.abs(g) <= 11) { sum.set(d, (sum.get(d) || 0) + g); cnt.set(d, (cnt.get(d) || 0) + 1); } }
            if (c > 0) pc = c;
        }
    }
    const out = {}; for (const [d, s] of sum) if (cnt.get(d) >= 200) out[d] = s / cnt.get(d);
    return out;
}

// ======================================================================
// (E)~(H) 🗞️ 2026-11-04 郭哲榮「跌破四萬二買 0050」文章那幾句話(使用者:「有沒有參考價值」)
//   資料:加權 2000 起(idx_long_early + idx_long + ^TWII 接起來),報酬指數 2003 起(之前只有價格指數)
//   (E) 從高點跌 X%(60 日高 / 一年高,收盤):每一段只算第一次(收盤再創那個高點才重新起算)
//       → 收盤買,之後 20/60/120/250 天 vs 隨便一天;之後 2 天內有沒有一天大漲 ≥3%;之後 60 天會不會再跌 5% 以上
//       他的原樣:跌 ≥8%(60 日高)之後「盤中跌破兩位數整數關卡」(4 萬多 = 千點、8 千多 = 百點)那天
//   (F) 大盤破底翻:盤中跌 ≥X%、收盤收回到 −0.5% 以內(或收回跌幅的 2/3)vs 同樣盤中大跌但收不回來 vs 隨便一天
//   (G) 第四季 / 11~12 月:每個月的報酬,11+12 月 vs 其他月,打亂月份 2,000 次
//   (H) 美國期中選舉那天之後 5~250 天(6 次,只描述)
//   ⛔ 只描述與比較,⛔ 不改 App;⚠️ ^TWII 開盤價是湊出來的(陷阱 #47)→ 一律收盤進場;盤中最低是真的成交湊出來的,可以用
// ======================================================================
export const EXS = [8, 10, 12, 15, 20];
export const EHS = [20, 60, 120, 250];
export const FXS = [2.5, 3];
export const FHS = [1, 5, 20, 60];
export const MIDTERMS = ['2002-11-05', '2006-11-07', '2010-11-02', '2014-11-04', '2018-11-06', '2022-11-08'];

/** 接三份指數:early(2000~2010)只取 long 第一天以前的列;^TWII 只取 long 最後一天以後的列;
 *  報酬指數 long 最後一天以後用價格比例往後接(那十幾天的股利不算,⚠️ 只差很少)。回 {d,o,h,l,c,tr(2003 前 null)} */
export function mergeIdx(long, early, now) {
    const row = r => Array.isArray(r) ? { d: d10(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) }
        : { d: d10(r.date), o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close) };
    const L = (long.twii || []).map(row).filter(r => r.c > 0);
    if (!L.length) throw new Error('idx_long 沒有 twii');
    const f0 = L[0].d, f1 = L.at(-1).d;
    const E = early ? (early.twii || []).map(row).filter(r => r.c > 0 && r.d < f0) : [];
    const N = now ? now.map(row).filter(r => r.c > 0 && r.d > f1) : [];
    const all = [...E, ...L, ...N];
    for (let i = 1; i < all.length; i++) if (!(all[i].d > all[i - 1].d)) throw new Error('日期沒有由舊到新:' + all[i].d);
    const trm = new Map();
    for (const r of (early ? early.twii_tr || [] : [])) if (d10(r[0]) < f0) trm.set(d10(r[0]), num(r[1]));
    for (const r of (long.twii_tr || [])) trm.set(d10(r[0]), num(r[1]));
    const tr = all.map(r => trm.get(r.d) || null);
    for (let i = 1; i < all.length; i++) if (tr[i] == null && tr[i - 1] != null && all[i].d > f1) tr[i] = tr[i - 1] * all[i].c / all[i - 1].c;
    return { d: all.map(r => r.d), o: all.map(r => r.o), h: all.map(r => r.h), l: all.map(r => r.l), c: all.map(r => r.c), tr, nNow: N.length };
}
/** 滾動最高收盤(含今天) */
export function rollMax(c, W) {
    const out = new Array(c.length); const q = [];
    for (let i = 0; i < c.length; i++) {
        while (q.length && c[q.at(-1)] <= c[i]) q.pop();
        q.push(i); if (q[0] <= i - W) q.shift();
        out[i] = c[q[0]];
    }
    return out;
}
/** 從 W 日高點(收盤)跌 ≥X% 的第一天;收盤再創那個 W 日高才重新起算 —— 只用 ≤ i 的資料 */
export function ddEvents(c, W, X) {
    const hi = rollMax(c, W), ev = []; let armed = true;
    for (let i = W - 1; i < c.length; i++) {
        if (c[i] >= hi[i]) { armed = true; continue; }
        if (armed && (c[i] / hi[i] - 1) * 100 <= -X) { ev.push(i); armed = false; }
    }
    return ev;
}
/** 兩位數的整數關卡:4 萬多 → 1,000 點一格、8 千多 → 100 點一格 */
export const roundStep = x => Math.pow(10, Math.floor(Math.log10(x)) - 1);
/** 他的原樣:先從 60 日高(收盤)跌 ≥X%,之後盤中最低第一次跌破一個整數關卡(前 5 天的最低都還在那個關卡之上);
 *  每一段只算第一次;回 [{i, L}] */
export function roundBreakEvents(S, W = 60, X = 8) {
    const hi = rollMax(S.c, W), ev = []; let armed = true;
    for (let i = Math.max(W - 1, 5); i < S.c.length; i++) {
        if (S.c[i] >= hi[i]) { armed = true; continue; }
        if (!armed || !(S.l[i] > 0)) continue;
        if ((S.l[i] / hi[i] - 1) * 100 > -X) continue;
        let m = Infinity; for (let k = 1; k <= 5; k++) if (S.l[i - k] > 0) m = Math.min(m, S.l[i - k]);
        if (!isFinite(m)) continue;
        const st = roundStep(m), L = Math.floor(m / st) * st;
        if (L > S.l[i] && L <= m) { ev.push({ i, L }); armed = false; }
    }
    return ev;
}
/** 他的原樣・每一次:跌 ≥X% 期間每一次「前 5 天都還在關卡之上、今天盤中跌破」都算(⛔ 不只第一次) */
export function roundBreakAll(S, W = 60, X = 8) {
    const hi = rollMax(S.c, W), ev = [];
    for (let i = Math.max(W - 1, 5); i < S.c.length; i++) {
        if (!(S.l[i] > 0) || (S.l[i] / hi[i] - 1) * 100 > -X) continue;
        let m = Infinity; for (let k = 1; k <= 5; k++) if (S.l[i - k] > 0) m = Math.min(m, S.l[i - k]);
        if (!isFinite(m)) continue;
        const st = roundStep(m), L = Math.floor(m / st) * st;
        if (L > S.l[i] && L <= m) ev.push({ i, L });
    }
    return ev;
}
/** 事件研究(收盤進場):asset 可以有 null(那段沒有資料就不算) */
export function evStudy(A, d, ev, hs, seed, SIMS = 2000) {
    const R = rng(seed), out = { n: ev.length, ep: episodes(ev), h: {} };
    for (const h of hs) {
        const f = i => (A[i] != null && i + h < A.length && A[i + h] != null) ? (A[i + h] / A[i] - 1) * 100 : null;
        const all = []; for (let i = 0; i < A.length; i++) { const x = f(i); if (x != null) all.push(x); }
        const ex = ev.map(i => [i, f(i)]).filter(x => x[1] != null), e = ex.map(x => x[1]);
        if (e.length < 3) { out.h[h] = { n: e.length }; continue; }
        const em = mean(e), bm = mean(all);
        let ge = 0; for (let s = 0; s < SIMS; s++) { let sum = 0; for (let k = 0; k < e.length; k++) sum += all[Math.floor(R() * all.length)]; if (sum / e.length >= em) ge++; }
        const yr = {}; for (const [i, x] of ex) { const y = d[i].slice(0, 4); (yr[y] = yr[y] || []).push(x); }
        const ys = Object.values(yr); const half = e.length >> 1;
        out.h[h] = { n: e.length, ev: r2(em), base: r2(bm), diff: r2(em - bm), med: r2(med(e)), medBase: r2(med(all)),
            up: r2(e.filter(x => x > 0).length / e.length * 100), upBase: r2(all.filter(x => x > 0).length / all.length * 100),
            worst: r2(Math.min(...e)), p: +(ge / SIMS).toFixed(3), h1: r2(mean(e.slice(0, half)) - bm), h2: r2(mean(e.slice(half)) - bm),
            yrsWin: ys.filter(a => mean(a) > bm).length, yrsN: ys.length };
    }
    return out;
}
/** 之後 K 天內有沒有一天大漲 ≥U%(價格指數收盤對收盤)/ 之後 M 天內收盤曾比進場那天再低 ≥Z% */
export function bounceRate(c, ev, K = 2, U = 3) {
    const any = (i, f) => { for (let k = 1; k <= K && i + k < c.length; k++) if (f((c[i + k] / c[i + k - 1] - 1) * 100)) return true; return false; };
    const up = i => any(i, r => r >= U), dn = i => any(i, r => r <= -U);
    const okI = i => i + K < c.length;
    const e = ev.filter(okI), all = []; for (let i = 1; i < c.length; i++) if (okI(i)) all.push(i);
    const pc = (a, f) => r2(a.filter(f).length / Math.max(1, a.length) * 100);
    // ⭐ 同時看「大跌 ≥U%」:大漲變多如果大跌也一起變多 = 只是波動變大,不是方向
    return { n: e.length, rate: pc(e, up), base: pc(all, up), dnRate: pc(e, dn), dnBase: pc(all, dn) };
}
export function deeperRate(c, ev, M = 60, Z = 5) {
    const hit = i => { for (let k = 1; k <= M; k++) if ((c[i + k] / c[i] - 1) * 100 <= -Z) return true; return false; };
    const okI = i => i + M < c.length;
    const e = ev.filter(okI), all = []; for (let i = 1; i < c.length; i++) if (okI(i)) all.push(i);
    return { n: e.length, rate: r2(e.filter(hit).length / Math.max(1, e.length) * 100), base: r2(all.filter(hit).length / all.length * 100) };
}
export function partE(S) {
    const out = { dd: [], round: null };
    for (const W of [60, 250]) for (const X of EXS) {
        const ev = ddEvents(S.c, W, X);
        out.dd.push({ W, X, dates: ev.map(i => S.d[i]), px: evStudy(S.c, S.d, ev, EHS, 101 + W + X), tr: evStudy(S.tr, S.d, ev, EHS, 202 + W + X),
            bounce: bounceRate(S.c, ev), deeper: deeperRate(S.c, ev) });
    }
    const rb = roundBreakEvents(S, 60, 8), ev = rb.map(x => x.i);
    // 在那個關卡掛買(盤中碰到就成交):價格指數 L → h 天後收盤
    const atL = {}; for (const h of EHS) { const a = rb.filter(x => x.i + h < S.c.length).map(x => (S.c[x.i + h] / x.L - 1) * 100); atL[h] = a.length ? { n: a.length, ev: r2(mean(a)), up: r2(a.filter(v => v > 0).length / a.length * 100) } : { n: 0 }; }
    out.round = { list: rb.map(x => ({ d: S.d[x.i], L: x.L, c: S.c[x.i] })), px: evStudy(S.c, S.d, ev, EHS, 303), tr: evStudy(S.tr, S.d, ev, EHS, 304), atL,
        bounce: bounceRate(S.c, ev), deeper: deeperRate(S.c, ev) };
    const ra = roundBreakAll(S, 60, 8).map(x => x.i);
    out.roundAll = { n: ra.length, tr: evStudy(S.tr, S.d, ra, EHS, 305), bounce: bounceRate(S.c, ra), deeper: deeperRate(S.c, ra) };
    return out;
}
/** (F) 盤中跌 ≥X%:hammer = 收盤收回到 −0.5% 以內;rec = 收回跌幅的 2/3 以上;weak = 收盤還跌 ≥2%;只用當天的資料 */
export function hammerDays(S, X) {
    const H = [], R = [], Wk = [];
    for (let i = 1; i < S.c.length; i++) {
        const pc = S.c[i - 1], l = S.l[i], c = S.c[i];
        if (!(l > 0) || !(pc > 0) || l > c * 1.0000001) continue;
        if ((l / pc - 1) * 100 > -X) continue;
        const cr = (c / pc - 1) * 100;
        if (cr >= -0.5) H.push(i);
        if (c - l >= (pc - l) * 2 / 3) R.push(i);
        if (cr <= -2) Wk.push(i);
    }
    return { H, R, W: Wk };
}
export function partF(S, seed = 41) {
    const out = [];
    const hi60 = rollMax(S.c, 60);
    const deep = i => i > 0 && (S.c[i - 1] / hi60[i - 1] - 1) * 100 <= -10;
    for (const X of FXS) {
        const g = hammerDays(S, X), o = { X, n: { H: g.H.length, R: g.R.length, W: g.W.length }, dates: g.H.map(i => S.d[i]) };
        for (const [k, ev] of [['H', g.H], ['R', g.R], ['W', g.W], ['Hdeep', g.H.filter(deep)], ['Hshallow', g.H.filter(i => !deep(i))]])
            o[k] = evStudy(S.tr, S.d, ev, FHS, seed + k.length + X * 10);
        // 破底翻 vs 收不回來(打亂兩組標籤 2,000 次)
        const R = rng(seed + 7 + X * 10); o.vsW = {};
        for (const h of FHS) {
            const f = i => (S.tr[i] != null && i + h < S.tr.length && S.tr[i + h] != null) ? (S.tr[i + h] / S.tr[i] - 1) * 100 : null;
            const a = g.H.map(f).filter(x => x != null), b = g.W.map(f).filter(x => x != null);
            if (a.length < 3 || b.length < 3) { o.vsW[h] = null; continue; }
            const obs = mean(a) - mean(b), pool = [...a, ...b]; let ge = 0;
            for (let s = 0; s < 2000; s++) { const p = pool.slice(); for (let j = 0; j < a.length; j++) { const r = j + Math.floor(R() * (p.length - j)); [p[j], p[r]] = [p[r], p[j]]; }
                if (mean(p.slice(0, a.length)) - mean(p.slice(a.length)) >= obs - 1e-12) ge++; }
            o.vsW[h] = { diff: r2(obs), p: +(ge / 2000).toFixed(3) };
        }
        out.push(o);
    }
    return out;
}
/** (G) 每個月報酬(月底收盤對上個月底收盤);月份直接從日期字串切(⛔ 不經過 Date,不吃時區);最後一個月沒走完不算 */
export function monthRets(d, A, lastFull = null) {
    const ends = [];
    for (let i = 0; i < d.length; i++) if (A[i] != null && (i === d.length - 1 || d[i + 1].slice(0, 7) !== d[i].slice(0, 7))) ends.push(i);
    const out = [];
    for (let k = 1; k < ends.length; k++) {
        const i = ends[k], j = ends[k - 1]; const ym = d[i].slice(0, 7);
        if (lastFull && ym > lastFull) break;
        if (d[j].slice(0, 7) === ym) continue;
        out.push({ ym, y: +ym.slice(0, 4), m: +ym.slice(5, 7), r: (A[i] / A[j] - 1) * 100 });
    }
    return out;
}
export function partG(MR, sel = [11, 12], seed = 51, SIMS = 2000) {
    const by = {}; for (let m = 1; m <= 12; m++) by[m] = MR.filter(x => x.m === m).map(x => x.r);
    const months = {}; for (let m = 1; m <= 12; m++) { const a = by[m]; months[m] = { n: a.length, m: r2(mean(a)), med: r2(med(a)), up: r2(a.filter(x => x > 0).length / Math.max(1, a.length) * 100) }; }
    const inS = MR.filter(x => sel.includes(x.m)).map(x => x.r), outS = MR.filter(x => !sel.includes(x.m)).map(x => x.r);
    const obs = mean(inS) - mean(outS), R = rng(seed); let ge = 0; const all = MR.map(x => x.r), k = inS.length;
    for (let s = 0; s < SIMS; s++) { const p = all.slice(); for (let j = 0; j < k; j++) { const r = j + Math.floor(R() * (p.length - j)); [p[j], p[r]] = [p[r], p[j]]; }
        if (mean(p.slice(0, k)) - mean(p.slice(k)) >= obs - 1e-12) ge++; }
    const yrs = [...new Set(MR.map(x => x.y))], half = yrs[yrs.length >> 1];
    const sub = (f) => { const a = MR.filter(x => f(x) && sel.includes(x.m)).map(x => x.r), b = MR.filter(x => f(x) && !sel.includes(x.m)).map(x => x.r); return r2(mean(a) - mean(b)); };
    // 那幾個月合起來每一年的報酬(11/1 → 12/31 這種)
    const perYear = yrs.map(y => { const a = MR.filter(x => x.y === y && sel.includes(x.m)); if (a.length !== sel.length) return null;
        return { y, r: r2((a.reduce((p, x) => p * (1 + x.r / 100), 1) - 1) * 100) }; }).filter(Boolean);
    return { sel, months, inMean: r2(mean(inS)), outMean: r2(mean(outS)), diff: r2(obs), p: +(ge / SIMS).toFixed(3),
        h1: sub(x => x.y < half), h2: sub(x => x.y >= half), upIn: r2(inS.filter(x => x > 0).length / inS.length * 100),
        upOut: r2(outS.filter(x => x > 0).length / outS.length * 100), perYear, upYears: perYear.filter(x => x.r > 0).length };
}
/** (H) 美國期中選舉那天(台北同一天收盤;那天沒開盤就往後找):⚠️ 結果是台北隔天早上才出來 → 這是「選前一刻買」 */
export function midtermIdx(d, dates = MIDTERMS) { return dates.map(x => d.findIndex(y => y >= x)).filter(i => i >= 0); }
export function partH(S) {
    const ev = midtermIdx(S.d);
    const st = evStudy(S.c, S.d, ev, [5, 20, 60, 120, 250], 61);
    const each = ev.map(i => ({ d: S.d[i], r: Object.fromEntries([5, 20, 60, 120, 250].map(h => [h, i + h < S.c.length ? r2((S.c[i + h] / S.c[i] - 1) * 100) : null])) }));
    return { ...st, each };
}

// ---------- selftest ----------
function selftest() {
    let ok = 0, bad = 0;
    const T = (c, msg) => { if (c) ok++; else { bad++; console.log('❌', msg); } };
    // 合成:每 50 天一次 −3% 大跌,其餘每天 +0.03%;大跌後 5 天每天 +1%(注入反彈)
    const mk = (inject) => {
        const d = [], idx = [], tr = []; let p = 100;
        for (let i = 0; i < 2000; i++) {
            let r = 0.0003;
            if (i % 50 === 25) r = -0.03;
            else if (inject && i % 50 > 25 && i % 50 <= 30) r = 0.01;
            p *= 1 + r;
            const dt = new Date(Date.UTC(2010, 0, 1) + i * 86400000).toISOString().slice(0, 10);
            d.push(dt); idx.push(p); tr.push(p);
        }
        return { d, idx, tr };
    };
    const S1 = mk(true), S0 = mk(false);
    T(dropDays(S1.idx, 2).length === 40, '① 大跌日數 = 40');
    T(episodes(dropDays(S1.idx, 2)) === 40, '② 隔 50 天 = 40 個獨立波段');
    const a1 = partA(S1, 2), a0 = partA(S0, 2);
    T(a1.h[5].diff > 3, '③ 注入反彈 → 5 日多出 >3%(' + a1.h[5].diff + ')');
    T(a1.h[5].p < 0.01, '④ 注入 → 安慰劑 p<0.01');
    T(Math.abs(a0.h[5].diff) < 0.5, '⑤ 沒注入 → 5 日差距 ≈0(' + a0.h[5].diff + ')');
    // ⑥ 零前視:事件日收盤買,報酬從 i 起算(不含當天跌幅)
    const i = dropDays(S0.idx, 2)[0];
    T(Math.abs(fwd(S0.tr, i, 1) - 0.03) < 1e-6, '⑥ 隔一天報酬 = +0.03%(不含當天跌幅)');
    // ⑦ 一次買 vs 分批:單調上漲 → 一次買必贏
    const Sup = { d: S0.d, idx: S0.d.map((_, k) => 100 * Math.pow(1.001, k)), tr: S0.d.map((_, k) => 100 * Math.pow(1.001, k)) };
    T(deploy(Sup, 10, 'L', 2, 100) > deploy(Sup, 10, 'S4', 2, 100), '⑦ 一路漲 → 一次買 > 分批');
    T(deploy(Sup, 10, 'L', 2, 100) > deploy(Sup, 10, 'W20', 2, 100), '⑧ 一路漲 → 一次買 > 等 20 天');
    // ⑨ SD 60 天內一定用完
    const v = deploy(S0, 25, 'SD', 2, 100); T(v != null && v > 0.9, '⑨ SD 有買完');
    // ⑩ 每月存:總投入一樣、dca 一路漲時最好
    const c = partC(Sup, 2, 2, 0);
    T(c.starts.every(r => r.put > 0), '⑩ 每條都有投入');
    T(c.summary['dip:0'].med <= c.summary.dca.med, '⑪ 一路漲(沒大跌)→ 只等大跌的不會贏定期定額');
    const r0 = monthly(Sup, 1, 500, 'dip:0', 2, 0);
    T(r0.v === r0.put, '⑫ 從不大跌、從不買 → 市值 = 存入現金');
    const r1 = monthly(Sup, 1, 500, 'dip:0', 2, 0.05);
    T(r1.v > r1.put, '⑬ 現金利率有算進去');
    // ── (D) 大跌 × 星期幾 ──
    // ⑭ 星期幾不受執行環境時區影響(決定性對照:同一個日期用 getDay() 在紐約會變成星期日)
    const tz0 = process.env.TZ; process.env.TZ = 'America/New_York';
    T(wdOf('2010-01-04') === 1 && wdOf('2026-11-06') === 5, '⑭ 2010-01-04 = 星期一、2026-11-06 = 星期五(UTC 星期)');
    T(new Date('2010-01-04').getDay() === 0, '⑭b 對照:getDay() 在紐約時區算成星期日 → 一定要用 UTC');
    if (tz0 == null) delete process.env.TZ; else process.env.TZ = tz0;
    // 合成:只排平日;每 17 個交易日一次 −3%(輪流落在不同星期);inject = 星期五大跌後的下一個交易日 +2%
    const mkW = (inject) => {
        const d = [], idx = [], tr = []; let p = 100, t = Date.UTC(2005, 0, 3), k = 0, fri = false;
        while (d.length < 4000) {
            const dt = new Date(t).toISOString().slice(0, 10); t += 86400000;
            const w = new Date(dt + 'T00:00:00Z').getUTCDay(); if (w === 0 || w === 6) continue;
            let r = 0.0003 * (k % 3 === 0 ? 1 : -0.5);
            if (fri && inject) r += 0.02;
            fri = false;
            if (k % 17 === 9) { r = -0.03; if (w === 5) fri = true; }
            p *= 1 + r; d.push(dt); idx.push(p); tr.push(p); k++;
        }
        return { d, idx, tr };
    };
    const W1 = mkW(true), W0 = mkW(false);
    const dw1 = partD1(W1, 2), dw0 = partD1(W0, 2);
    T(dw1.w[5].n >= 40 && dw1.w[1].n >= 40, '⑮ 每個星期都有大跌(星期五 ' + dw1.w[5].n + '、星期一 ' + dw1.w[1].n + ')');
    T(dw1.w[5].h[1].vsOth > 1.5 && dw1.w[5].h[1].p < 0.01, '⑯ 埋「星期五大跌 → 隔天 +2%」→ 星期五比其他星期多 >1.5pp・p<0.01(' + dw1.w[5].h[1].vsOth + ' / ' + dw1.w[5].h[1].p + ')');
    T(Math.abs(dw1.w[3].h[1].vsOth) < 1 && dw1.w[3].h[1].vsOth < 0, '⑰ 星期三沒埋 → 只因為星期五被墊高而略負(' + dw1.w[3].h[1].vsOth + ')');
    T([1, 2, 3, 4, 5].every(w => Math.abs(dw0.w[w].h[1].vsOth) < 0.3), '⑱ 沒埋 → 五天都 ≈0');
    T(dw1.w[5].h[1].sellAdv < -1.5 && dw0.w[5].h[1].sellAdv < 0, '⑲ 星期五大跌後會反彈 → 先賣再買回比較差(' + dw1.w[5].h[1].sellAdv + ')');
    const q = bh([0.01, 0.04, 0.03, 0.5]); T(q[0] === 0.04 && q[3] === 0.5, '⑳ BH:' + q.join(','));
    const d0 = partD0(W1); T(d0[1].n > 700 && d0[5].n > 700, '㉑ D0 每個星期 >700 天');
    // ㉒ 隔天開盤跳空:給一份「星期五大跌後隔天開盤 −1%」的表 → 星期五 gap 平均 ≈ −1、其他 ≈ 0
    const gmap = {}; for (let i = 0; i + 1 < W1.d.length; i++) gmap[W1.d[i + 1]] = 0;
    for (const i of dropDays(W1.idx, 2)) if (wdOf(W1.d[i]) === 5) gmap[W1.d[i + 1]] = -1;
    const dg = partD1(W1, 2, 31, gmap);
    T(dg.w[5].gap.ev === -1 && dg.w[1].gap.ev === 0 && dg.w[5].gap.base === 0, '㉒ 隔天開盤跳空照星期幾分得出來');
    // ── (E)~(H) ──
    // 合成平日序列:每 120 天一個循環 —— 先漲 60 天、再跌 15%(15 天)、底部盤 5 天;inject = 跌完之後 10 天每天 +2%
    const mkE = (inject) => {
        const d = [], c = [], l = []; let p = 100, t = Date.UTC(2001, 0, 1), k = 0;
        while (d.length < 3000) {
            const dt = new Date(t).toISOString().slice(0, 10); t += 86400000;
            const w = new Date(dt + 'T00:00:00Z').getUTCDay(); if (w === 0 || w === 6) continue;
            const ph = k % 120; let r;
            if (ph < 60) r = 0.004; else if (ph < 75) r = Math.pow(0.85, 1 / 15) - 1; else if (inject && ph < 85) r = 0.02; else r = ph < 85 ? 0 : -0.0013;
            p *= 1 + r; d.push(dt); c.push(p); l.push(p * 0.995); k++;
        }
        return { d, c, l, h: c.slice(), o: c.slice(), tr: c.slice() };
    };
    const E1 = mkE(true), E0 = mkE(false);
    const ev10 = ddEvents(E1.c, 60, 10);
    T(ev10.length >= 20 && ev10.length <= 26, '㉓ 從 60 日高跌 10%:每個循環只算第一次(' + ev10.length + ' 次)');
    T(ddEvents(E1.c, 60, 20).length === 0, '㉔ 每次只跌 15% → 跌 20% 一次都沒有');
    // ㉕ ⛔ 前視:把第 k 天之後的資料全部換掉,第 k 天以前的事件一模一樣
    const kk = 1500, cut = E1.c.slice(0, kk).concat(E1.c.slice(kk).map(x => x * 0.5));
    T(JSON.stringify(ddEvents(cut, 60, 10).filter(i => i < kk)) === JSON.stringify(ev10.filter(i => i < kk)), '㉕ 改掉未來的資料 → 之前的事件不變(⛔ 前視)');
    const st1 = evStudy(E1.c, E1.d, ev10, [20], 9), st0 = evStudy(E0.c, E0.d, ddEvents(E0.c, 60, 10), [20], 9);
    T(st1.h[20].diff > 1 && st1.h[20].p < 0.05, '㉖ 埋「跌完反彈」→ 20 天比隨便一天多(' + st1.h[20].diff + ' / p=' + st1.h[20].p + ')');
    T(st0.h[20].diff < st1.h[20].diff - 5, '㉗ 沒埋 → 明顯比較差(' + st0.h[20].diff + ')');
    T(roundStep(43308) === 1000 && roundStep(8756) === 100 && roundStep(12682) === 1000, '㉘ 整數關卡:4 萬多 = 千點、8 千多 = 百點');
    // ㉙ 他的原樣:2026 七月那種 —— 從 45,000 跌、盤中第一次跌破 40,000
    const RB = { d: [], c: [], l: [] }; for (let i = 0; i < 80; i++) { const v = i < 60 ? 45000 : 45000 - (i - 59) * 300; RB.d.push('2026-' + String(i).padStart(3, '0')); RB.c.push(v); RB.l.push(v - 150); }
    const rb = roundBreakEvents(RB, 60, 8);
    T(rb.length === 1 && rb[0].L === 41000 && RB.c[rb[0].i] < 41500, '㉙ 先跌 ≥8%,盤中第一次跌破整數關卡(' + JSON.stringify(rb.map(x => [x.i, x.L])) + ')');
    // ㉚ 破底翻:盤中 −3%、收盤 −0.2% → H;盤中 −3%、收盤 −2.5% → W
    const FS = { c: [100, 99.8, 97.5, 97.4], l: [100, 96.8, 97.0, 96.0] };
    const hd = hammerDays(FS, 2.5);
    T(hd.H.join() === '1' && hd.W.join() === '2' && hammerDays({ c: [100, 97.5], l: [100, 96.9] }, 2.5).W.join() === '1', '㉚ 破底翻 / 收不回來分得出來');
    // ㉛ (F) 埋「破底翻後隔天 +1.5%」→ 比收不回來多;沒埋 ≈ 0
    const mkF = (inject) => {
        const d = [], c = [], l = [], tr = []; let p = 100, t = Date.UTC(2003, 0, 1), k = 0, after = false;
        const R = rng(5);
        while (d.length < 4000) {
            const dt = new Date(t).toISOString().slice(0, 10); t += 86400000;
            const w = new Date(dt + 'T00:00:00Z').getUTCDay(); if (w === 0 || w === 6) continue;
            let r = (R() - 0.5) * 0.01; if (after && inject) r = 0.015; after = false;
            const pc = p; p *= 1 + r; let lo = Math.min(pc, p) * 0.997;
            if (k % 40 === 20) { lo = pc * 0.965; p = pc * 0.998; after = true; }
            if (k % 40 === 30) { lo = pc * 0.965; p = pc * 0.97; }
            d.push(dt); c.push(p); l.push(lo); tr.push(p); k++;
        }
        return { d, c, l, tr };
    };
    const F1 = partF(mkF(true)), F0 = partF(mkF(false));
    T(F1[0].vsW[1].diff > 1 && F1[0].vsW[1].p < 0.01, '㉛ 埋破底翻後隔天反彈 → 比收不回來多(' + F1[0].vsW[1].diff + ' / p=' + F1[0].vsW[1].p + ')');
    T(Math.abs(F0[0].vsW[1].diff) < 0.5, '㉜ 沒埋 → ≈0(' + F0[0].vsW[1].diff + ')');
    // ㉝ (G) 月份:埋「11、12 月每月多 +3%」→ p<0.01;沒埋 → p 不小;月份不吃時區
    const mkG = (inject) => { const d = [], A = []; let p = 100, t = Date.UTC(2000, 0, 3); const R = rng(9);
        while (d.length < 6000) { const dt = new Date(t).toISOString().slice(0, 10); t += 86400000; const w = new Date(dt + 'T00:00:00Z').getUTCDay(); if (w === 0 || w === 6) continue;
            const m = +dt.slice(5, 7); p *= 1 + (R() - 0.5) * 0.02 + (inject && (m === 11 || m === 12) ? 0.0014 : 0); d.push(dt); A.push(p); } return { d, A }; };
    const G1 = mkG(true), G0 = mkG(false);
    const g1 = partG(monthRets(G1.d, G1.A)), g0 = partG(monthRets(G0.d, G0.A));
    T(g1.diff > 2 && g1.p < 0.01, '㉝ 埋 11~12 月 → 抓得到(' + g1.diff + ' / p=' + g1.p + ')');
    T(g0.p > 0.05, '㉞ 沒埋 → p 不小(' + g0.p + ')');
    const tz1 = process.env.TZ; process.env.TZ = 'Pacific/Kiritimati';
    T(monthRets(['2020-10-30', '2020-11-02', '2020-11-30', '2020-12-01'], [100, 101, 110, 111]).map(x => x.ym + ':' + x.r.toFixed(1)).join() === '2020-11:10.0,2020-12:0.9', '㉟ 月底對月底、月份不吃時區');
    if (tz1 == null) delete process.env.TZ; else process.env.TZ = tz1;
    T(monthRets(['2020-10-30', '2020-11-30', '2020-12-03'], [100, 110, 120], '2020-11').length === 1, '㊱ 最後一個月沒走完不算');
    // ㊲ (H) 選舉日沒開盤 → 往後找第一個交易日
    T(midtermIdx(['2018-11-02', '2018-11-05', '2018-11-07'], ['2018-11-06']).join() === '2', '㊲ 選舉那天沒開盤 → 用之後第一個交易日');
    // ㊳ 接三份指數:重疊那段以 long 為準、long 之後用 ^TWII、報酬指數用價格比例往後接
    const mg = mergeIdx({ twii: [['2010/01/04', 1, 2, 1, 10, 0], ['2010/01/05', 1, 2, 1, 11, 0]], twii_tr: [['2010/01/04', 100], ['2010/01/05', 110]] },
        { twii: [['2009/12/31', 1, 2, 1, 9, 0], ['2010/01/04', 1, 2, 1, 99, 0]], twii_tr: [['2009/12/31', 90]] },
        [{ date: '2010/01/05', open: 1, high: 2, low: 1, close: 77 }, { date: '2010/01/06', open: 1, high: 2, low: 1, close: 12.1 }]);
    T(mg.d.join() === '2010-01-01,2010-01-04,2010-01-05,2010-01-06'.replace('2010-01-01', '2009-12-31') && mg.c.join() === '9,10,11,12.1' && Math.abs(mg.tr[3] - 121) < 1e-9 && mg.tr[0] === 90,
        '㊳ 三份指數接起來:' + mg.d.join() + ' / ' + mg.c.join() + ' / ' + mg.tr.join());
    console.log(`selftest ${ok} ok / ${bad} bad`);
    process.exit(bad ? 1 : 0);
}

// ---------- main ----------
function loadBars(p) {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    return r.map(x => ({ d: d10(x.date), c: num(x.close) })).filter(x => x.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
}
function printStudy(tag, st, hs) {
    for (const h of hs) { const r = st.h[h]; if (!r || r.p == null) { console.log(`    ${tag} ${String(h).padStart(3)} 天 n=${r ? r.n : 0}`); continue; }
        console.log(`    ${tag} ${String(h).padStart(3)} 天 平均 ${r.ev}% vs 隨便一天 ${r.base}%  差 ${r.diff}pp(中位 ${r.med} vs ${r.medBase})・上漲 ${r.up}% vs ${r.upBase}%・最差 ${r.worst}%・p=${r.p}・前半 ${r.h1}/後半 ${r.h2}・贏的年 ${r.yrsWin}/${r.yrsN}・n=${r.n}`); }
}
/** (E)~(H):IDX_LONG=<idx_long.json> IDX_EARLY=<idx_long_early.json> TWII_NOW=<^TWII.json> */
function mainEH() {
    const rd = p => p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    const S = mergeIdx(rd(process.env.IDX_LONG), rd(process.env.IDX_EARLY), rd(process.env.TWII_NOW));
    const t0 = S.tr.findIndex(x => x != null);
    console.log(`\n===== (E)~(H) 加權 ${S.d[0]} ~ ${S.d.at(-1)}(${S.d.length} 天;^TWII 接在後面 ${S.nNow} 天)・報酬指數 ${S.d[t0]} 起 =====`);
    const out = {};
    const E = partE(S); out.E = E;
    const cells = [];
    console.log('\n(E) 從高點(收盤)跌 X% 的第一天收盤買(每一段只算第一次;收盤再創那個高點才重新起算)');
    for (const r of E.dd) {
        console.log(`  ${r.W === 60 ? '60 日高' : '一年高'} 跌 ≥${r.X}%:${r.dates.length} 次(${r.dates.slice(-4).join(' ')})`);
        console.log(`    之後 2 天內有一天大漲 ≥3%:${r.bounce.rate}% vs 隨便一天 ${r.bounce.base}%・大跌 ≥3%:${r.bounce.dnRate}% vs ${r.bounce.dnBase}%(n=${r.bounce.n})・之後 60 天內又再跌 ≥5%:${r.deeper.rate}% vs ${r.deeper.base}%`);
        printStudy('含息', r.tr, EHS); printStudy('價格', r.px, EHS);
        for (const h of EHS) { const c = r.tr.h[h]; if (c && c.p != null) cells.push(c); }
    }
    const qs = bh(cells.map(c => c.p)); cells.forEach((c, k) => { c.q = qs[k]; });
    console.log('  含息那幾格 BH q:' + E.dd.map(r => `${r.W}/${r.X}:` + EHS.map(h => r.tr.h[h] && r.tr.h[h].q != null ? r.tr.h[h].q : '-').join('/')).join(' ・'));
    const R = E.round;
    console.log(`\n(E2) 他的原樣:從 60 日高跌 ≥8% 之後,盤中第一次跌破整數關卡(4 萬多 = 千點、8 千多 = 百點)那天:${R.list.length} 次`);
    console.log('    ' + R.list.map(x => `${x.d} 破 ${x.L}(收 ${Math.round(x.c)})`).join(' ・'));
    console.log(`    之後 2 天內有一天大漲 ≥3%:${R.bounce.rate}% vs ${R.bounce.base}%・大跌 ≥3%:${R.bounce.dnRate}% vs ${R.bounce.dnBase}%・之後 60 天內又再跌 ≥5%:${R.deeper.rate}% vs ${R.deeper.base}%`);
    printStudy('收盤買含息', R.tr, EHS); printStudy('收盤買價格', R.px, EHS);
    console.log('    在關卡掛買(價格):' + EHS.map(h => `${h} 天 ${R.atL[h].ev}%(上漲 ${R.atL[h].up}%・n=${R.atL[h].n})`).join(' ・'));
    const RA = E.roundAll;
    console.log(`  (E2b) 每一次跌破關卡都算(跌 ≥8% 期間):${RA.n} 次・${RA.tr.ep} 段・之後 2 天大漲 ≥3% ${RA.bounce.rate}% / 大跌 ≥3% ${RA.bounce.dnRate}%・60 天內再跌 ≥5% ${RA.deeper.rate}%`);
    printStudy('每一次含息', RA.tr, EHS);
    // (F)
    const F = partF(S); out.F = F;
    console.log('\n(F) 大盤破底翻:盤中跌 ≥X%、收盤收回 −0.5% 以內(H)/ 收回跌幅 2/3(R)/ 收盤還跌 ≥2%(W);之後 h 天含息 vs 隨便一天');
    for (const o of F) {
        console.log(`  盤中跌 ≥${o.X}%:H ${o.n.H} 次・R ${o.n.R} 次・W ${o.n.W} 次;H 全部:` + o.dates.map(d => { const i = S.d.indexOf(d); return `${d}(低 ${r2((S.l[i] / S.c[i - 1] - 1) * 100)}% 收 ${r2((S.c[i] / S.c[i - 1] - 1) * 100)}%)`; }).join(' '));
        for (const k of ['H', 'R', 'W', 'Hdeep', 'Hshallow']) { console.log(`   [${k}] ${o[k].n} 次・${o[k].ep} 段`); printStudy(k, o[k], FHS); }
        console.log('   破底翻 vs 收不回來:' + FHS.map(h => o.vsW[h] ? `${h} 天 ${o.vsW[h].diff}pp(p=${o.vsW[h].p})` : `${h} 天 -`).join(' ・'));
    }
    // (G)
    const lastFull = S.d.at(-1).slice(0, 7) > '0000' ? (() => { const ym = S.d.at(-1).slice(0, 7); const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })() : null;
    out.G = {};
    for (const [tag, A] of [['價格 2000 起', S.c], ['含息 2003 起', S.tr]]) {
        const MR = monthRets(S.d, A, lastFull).filter(x => x.y <= 2025 || x.ym <= lastFull);
        const g = partG(MR, [11, 12]), q4 = partG(MR, [10, 11, 12], 52);
        out.G[tag] = { nov_dec: g, q4 };
        console.log(`\n(G) ${tag}(${MR[0].ym} ~ ${MR.at(-1).ym},${MR.length} 個月)`);
        console.log('   每個月:' + Object.entries(g.months).map(([m, r]) => `${m}月 ${r.m}%/中位 ${r.med}/漲 ${r.up}%(${r.n})`).join(' ・'));
        console.log(`   11+12 月 平均 ${g.inMean}% vs 其他月 ${g.outMean}% 差 ${g.diff}pp p=${g.p}・上漲 ${g.upIn}% vs ${g.upOut}%・前半 ${g.h1} / 後半 ${g.h2}・兩個月合起來漲的年 ${g.upYears}/${g.perYear.length}`);
        console.log('   11+12 月每一年:' + g.perYear.map(x => `${x.y} ${x.r}%`).join(' ・'));
        console.log(`   第四季(10~12)平均 ${q4.inMean}% vs ${q4.outMean}% 差 ${q4.diff}pp p=${q4.p}・前半 ${q4.h1} / 後半 ${q4.h2}`);
        // ⭐ 12 個月逐一比(看完資料才挑最好那個月 = 資料探勘 → 12 格一起 BH)
        const one = []; for (let m = 1; m <= 12; m++) one.push(partG(MR, [m], 60 + m));
        const qq = bh(one.map(x => x.p));
        out.G[tag].month = one.map((x, k) => ({ m: k + 1, diff: x.diff, p: x.p, q: qq[k], h1: x.h1, h2: x.h2 }));
        console.log('   每個月 vs 其他月(p / BH q / 前半・後半):' + one.map((x, k) => `${k + 1}月 ${x.diff}pp p=${x.p} q=${qq[k]}(${x.h1}・${x.h2})`).join(' ・'));
        // 10 月大跌(≤ −5%)之後的 11+12 月
        const oct = MR.filter(x => x.m === 10 && x.r <= -5).map(x => x.y);
        const after = oct.map(y => { const a = MR.filter(x => x.y === y && (x.m === 11 || x.m === 12)); return a.length === 2 ? `${y}(10 月 ${r2(MR.find(x => x.y === y && x.m === 10).r)}%)→ ${r2((a.reduce((p, x) => p * (1 + x.r / 100), 1) - 1) * 100)}%` : null; }).filter(Boolean);
        console.log('   10 月跌 ≥5% 的那幾年,11+12 月:' + (after.join(' ・') || '沒有'));
    }
    // (H)
    const Hh = partH(S); out.H = Hh;
    console.log('\n(H) 美國期中選舉那天收盤買(台北;結果台北隔天早上才出來),之後 h 天(價格指數)');
    printStudy('期中選舉', Hh, [5, 20, 60, 120, 250]);
    console.log('   每一次:' + Hh.each.map(x => `${x.d}:` + [5, 20, 60, 120, 250].map(h => x.r[h]).join('/')).join(' ・'));
    return out;
}
function main() {
    if (process.argv.includes('--selftest')) return selftest();
    if (process.env.IDX_LONG) { const o = mainEH(); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(o, null, 1)); if (!process.env.DATA_DIR) return; }
    const DIR = process.env.DATA_DIR;
    if (!DIR) { console.error('需要 DATA_DIR'); process.exit(1); }
    const twii = loadBars(path.join(DIR, '^TWII.json')), b = loadBars(path.join(DIR, '_bench0050.json'));
    let divs = [];
    const dvp = process.env.DIV || path.join(DIR, '_div0050.json');
    if (fs.existsSync(dvp)) { const dv = JSON.parse(fs.readFileSync(dvp, 'utf8')); divs = ((dv.d || dv)['0050'] || {}).h || []; }
    if (!divs.length) { console.error('⛔ 讀不到 0050 股利 → 含息算不出來'); process.exit(1); }
    const S = align(twii, b, divs);
    if (S.d.length < 2000) { console.error('⛔ 對齊後只有', S.d.length, '天'); process.exit(1); }
    console.log(`資料 ${S.d[0]} ~ ${S.d[S.d.length - 1]}(${S.d.length} 天)・0050 含息 ${((S.tr.at(-1) - 1) * 100).toFixed(0)}%`);
    const out = { from: S.d[0], to: S.d.at(-1), A: [], B: [], C: [], D: null };
    if (!process.env.ONLY_D) {

    console.log('\n(A) 加權當天跌 ≥X% → 尾盤買 0050(含息),之後 h 天 vs 隨便挑一天');
    for (const X of XS) {
        const a = partA(S, X); out.A.push(a);
        console.log(`  跌 ≥${X}%:${a.n} 天・${a.ep} 段`);
        for (const h of HS) { const r = a.h[h]; if (!r.n) continue;
            console.log(`    ${String(h).padStart(3)} 天 平均 ${r.ev}% vs ${r.base}%  差 ${r.diff}pp・上漲 ${r.up}% vs ${r.upBase}%・p=${r.p}・前半 ${r.h1} / 後半 ${r.h2}`); }
    }
    console.log('\n(B) 手上 100 萬:一次買 L / 時間分 4 批 S4 / 等下次大跌再加 SD / 等 20 天 W20(第 H 天報酬 %、贏一次買的 %)');
    for (const X of XS) for (const H of [120, 250]) {
        const r = partB(S, X, H); out.B.push(r);
        const f = o => o.n ? `L ${o.L} ・S4 ${o.S4}(${o.S4win}%)・SD ${o.SD}(${o.SDwin}%)・W20 ${o.W20}(${o.W20win}%)・n=${o.n}` : 'n=0';
        console.log(`  跌 ≥${X}% H=${H}  大跌日:${f(r.ev)}`);
        console.log(`                隨便一天:${f(r.rnd)}`);
    }
    console.log('\n(C) 每月存 1 萬、10 年(每條起點隔 3 個月):最後市值 ÷ 總存入 −1(中位 / 最差 / 贏定期定額幾條)');
    for (const cashR of [0, 0.015]) for (const X of [2, 3]) {
        const c = partC(S, X, 10, cashR); out.C.push({ X, cashR, summary: c.summary, n: c.starts.length });
        console.log(`  跌 ≥${X}% 現金利率 ${cashR * 100}%(${c.starts.length} 條,${c.starts[0].from}~${c.starts.at(-1).from} 起)`);
        for (const m of CMODES) { const s = c.summary[m]; console.log(`    ${m.padEnd(7)} 中位 ${s.med}% ・最差 ${s.worst}% ・最好 ${s.best}%${s.beatDca == null ? '' : ` ・贏定期定額 ${s.beatDca}/${s.n}`}`); }
    }
    }
    // ---------- (D) 大跌 × 星期幾 ----------
    let gap = null;
    if (process.env.STOCK_DIR) { const t0 = Date.now(); gap = gapIndex(process.env.STOCK_DIR, +(process.env.MAX_SYMS || 0));
        const ds = Object.keys(gap).sort(); console.log(`\n(D2 準備)全部股票開盤跳空:${ds.length} 天(${ds[0]}~${ds.at(-1)},每天 ≥200 檔)・${((Date.now() - t0) / 1000).toFixed(0)} 秒`); }
    const D = { d0: partD0(S), d1: [] };
    console.log('\n(D0) 平常日子:加權收盤對收盤,依星期幾');
    for (let w = 1; w <= 5; w++) { const r = D.d0[w]; console.log(`  星期${WD_NAME[w]} ${r.n} 天 平均 ${r.m}% ・中位 ${r.med}% ・上漲 ${r.up}% ・標準差 ${r.sd} ・跌 ≥2% 的天 ${r.bigDn}% ・前半 ${r.h1}% / 後半 ${r.h2}%`); }
    const cells = [];
    for (const X of DXS) { const r = partD1(S, X, 31, gap); D.d1.push(r);
        for (let w = 1; w <= 5; w++) for (const h of DHS) { const c = r.w[w].h[h]; if (c && c.p != null) cells.push(c); } }
    const qs = bh(cells.map(c => c.p)); cells.forEach((c, k) => { c.q = qs[k]; });
    for (const r of D.d1) {
        console.log(`\n(D1) 加權跌 ≥${r.X}%:${r.n} 天・${r.ep} 段 —— 依星期幾(之後 h 天 0050 含息;「同星期」= 同一個星期幾的隨便一天;「vs 別天大跌」= 比其他星期的大跌,p = 打亂星期幾 2,000 次,q = 40 格 BH)`);
        for (let w = 1; w <= 5; w++) { const o = r.w[w];
            console.log(`  星期${WD_NAME[w]}:${o.n} 天・${o.ep} 段${o.ep < 10 ? ' ⚠️ 太少' : ''}` + (o.gap ? `・隔天開盤跳空(全部股票平均)${o.gap.ev}% vs 同星期平常 ${o.gap.base}% vs 別天大跌 ${o.gap.oth}%(n=${o.gap.n}・開高 ${o.gap.up}%)` : ''));
            for (const h of DHS) { const c = o.h[h]; if (!c || c.p == null) { console.log(`    ${String(h).padStart(2)} 天 n=${c ? c.n : 0}`); continue; }
                console.log(`    ${String(h).padStart(2)} 天 平均 ${c.ev}%(同星期 ${c.base}%・差 ${c.diff})・vs 別天大跌 ${c.oth}% 差 ${c.vsOth}pp p=${c.p} q=${c.q}・上漲 ${c.up}% vs ${c.upBase}%・前半 ${c.h1}/後半 ${c.h2}・先賣再買回 ${c.sellAdv}%(先賣比較好 ${c.sellWin}%)`); }
        }
    }
    out.D = D;
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
