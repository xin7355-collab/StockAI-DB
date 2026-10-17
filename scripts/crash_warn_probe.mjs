#!/usr/bin/env node
/**
 * 🌋 台股崩盤 / 空頭預警:高點「之前」有沒有徵兆?(V79.3.5)
 *
 * 使用者 2026-10-17:「台股崩盤或空頭前有什麼徵兆?以台股歷史找得到嗎?怎麼示警、怎麼防?」
 * ⭐ 本站以前只測過「跌下去之後」(vix_crash_probe B 段、空頭守門、bearday_probe)—— 這支第一次測「之前」,
 *    而且把 App 畫面上**沒回測過**的大盤警示(年線乖離盤勢、出貨日、崩跌盤、空頭守門)一起放進來量。
 *
 * 資料(全部只讀):
 *   IDX_LONG   加權 2010 起(origin/data:data/idx_long.json:OHLC + 成交金額 + 報酬指數)【必要】
 *   IDX_EARLY  加權 2000~2010(idx_long_early.json,V79.3.5 補抓;有就接在前面)
 *   TWII_NOW   本站 ^TWII.json(只取 idx_long 最後一天之後的列,接到最新)
 *   DATA_DIR + NAMES  d10n(上市個股 2010 起)+ stock_names.json(只收上市、⛔ 不收 ETF)→ 市場廣度
 *              (逐檔串流、每天只累加計數,⛔ 不把全部 K 線放進記憶體)
 *   TAIFEX     taifex_hist.json(2016 起:P/C、前十大交易人、散戶多空比;一律落後一天才用)
 *   US_HIST    us_hist.json(2021-10 起:VIX、費半)—— 段數太少,只描述、⛔ 不進檢定
 *
 * 目標(只用加權收盤,⛔ 不用開盤價 —— 陷阱 #47):
 *   主標籤 dn60 = 未來 60 個交易日內最低收盤比今天低 ≥10%
 *   其他:dn20(20 天內 ≥10%,急跌)・dn120x20(120 天內 ≥20%,大空頭)・up60(60 天內最高 ≥ +10%,看它是預告下跌還是預告大波動)
 *   段落:從近期高點跌 ≥10/15/20% 的每一段(zigzag:跌滿 10% 確認高點、從低點反彈 10% 才算結束)+ 20 天內急跌 ≥10%
 *     ⛔ 不用 vix_crash_probe.drawdownEvents —— 它要回到「歷史最高」才算新一段,2000 年那個高點 2018 才回去 → 18 年只算一段
 *     (第一次實跑就是這樣:2000~2026 只抓到 8 段,而且「拿掉最好那段」等於拿掉整個 2000~2017)
 *
 * 過關(先寫死再跑,⛔ 看完結果不改):
 *   ① 全期:亮燈那些天 dn60 的機率 > 全部天數的機率
 *   ② 分段:2000–09 / 2010–17 / 2018–26 每一段都 > 該段基準(該段亮燈 <30 天就不算那段)
 *   ③ 逐年:亮燈 ≥20 天的年份裡,高於基準的年數 ≥ 低於的年數
 *   ④ 拿掉貢獻最大那一段崩跌,仍 > 基準
 *   ⑤ 高原:門檻左右各挪兩格都 > 基準(沒有門檻的訊號這關免)
 *   ⑥ 平移安慰劑 1,000 次(整段平移、保留連續性)p 值,主訊號一起做 BH 校正後 ≤ 0.05
 * 怎麼防:加權報酬指數(2003 起;0050 代理)亮燈 → 留一半 / 全出、燈滅回來(看到燈的**隔天收盤**才換、扣成本),
 *   比買了放著(總報酬、年化、最大回撤、最差年、換手次數)。
 *
 * 跑法:
 *   IDX_LONG=$S/cw_idx_long.json IDX_EARLY=$S/cw_idx_long_early.json TWII_NOW=$S/cw_^TWII.json \
 *   DATA_DIR=$S/d10n NAMES=$S/sn_now.json TAIFEX=$S/cw_taifex_hist.json US_HIST=$S/cw_us_hist.json \
 *     node --max-old-space-size=4000 scripts/crash_warn_probe.mjs out.json
 *   node scripts/crash_warn_probe.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const H_MAIN = 60, X_MAIN = 10;
export const SEGS = [['E', '2000–09', '0000', '2010-01-01'], ['A', '2010–17', '2010-01-01', '2018-01-01'], ['B', '2018–26', '2018-01-01', '9999']];
export const N_SHIFT = 1000, MIN_SHIFT = 250, ONSET_GAP = 20, SEG_MIN_ON = 30, YEAR_MIN_ON = 20, PRE = 60;
export const COST_SELL = 0.19, COST_BUY = 0.09;   // %:ETF 手續費 6 折 0.0855% ×2 + 賣出證交稅 0.1%
export const BREADTH_MIN_N = 300;                   // 一天至少 300 檔上市股才算廣度(早期資料稀疏的日子不算)

const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const r2 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(2);
const pct = x => x == null || !Number.isFinite(x) ? null : +(x * 100).toFixed(2);

/** 固定種子亂數(mulberry32) */
export function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── 資料 ───────────────────────────────────────────────────────────────────
/** 加權日 K:early(idx_long 第一天以前)+ long + now(idx_long 最後一天以後)。回 {rows:[{d,o,h,l,c,a}], tr: Map(d → 報酬指數)} */
export function loadIndex({ long, early, now }) {
    const L = (long && long.twii) || [];
    if (!L.length) throw new Error('IDX_LONG 沒有 twii(⛔ 沒有資料不跑)');
    const rows = [];
    const push = (d, o, h, l, c, a) => { c = +c; if (c > 0) rows.push({ d, o: +o || c, h: +h || c, l: +l || c, c, a: +a || 0 }); };
    const first = d10(L[0][0]);
    for (const r of (early && early.twii) || []) { const d = d10(r[0]); if (d < first) push(d, r[1], r[2], r[3], r[4], r[5]); }
    for (const r of L) push(d10(r[0]), r[1], r[2], r[3], r[4], r[5]);
    const last = rows[rows.length - 1].d;
    const nowAmt = new Map();
    for (const r of (Array.isArray(now) ? now : [])) { const d = d10(r.date); if (+r.amount > 0) nowAmt.set(d, +r.amount); if (d > last) push(d, r.open, r.high, r.low, r.close, r.amount); }
    // FinMind 那份有 52 天成交金額是 0(2017-12、2026-02 兩段)→ 本站 ^TWII.json 有官方值(FMTQIK)就補上;補不到的照 0(= 沒有,下游跳過)
    for (const r of rows) if (!(r.a > 0) && nowAmt.has(r.d)) r.a = nowAmt.get(r.d);
    for (let i = 1; i < rows.length; i++) if (!(rows[i].d > rows[i - 1].d)) throw new Error(`日期沒有嚴格遞增:${rows[i - 1].d} → ${rows[i].d}`);
    const tr = new Map();
    for (const r of (early && early.twii_tr) || []) tr.set(d10(r[0]), +r[1]);
    for (const r of (long && long.twii_tr) || []) tr.set(d10(r[0]), +r[1]);
    return { rows, tr };
}

/** 滑動視窗最大 / 最小(含今天、長度 k);回陣列(前 k−1 天 null) */
function slideExt(x, k, isMax) {
    const n = x.length, out = new Array(n).fill(null), dq = [];
    for (let i = 0; i < n; i++) {
        while (dq.length && (isMax ? x[dq[dq.length - 1]] <= x[i] : x[dq[dq.length - 1]] >= x[i])) dq.pop();
        dq.push(i);
        if (dq[0] <= i - k) dq.shift();
        if (i >= k - 1) out[i] = x[dq[0]];
    }
    return out;
}

/** 過去 win 天(⛔ 不含今天)裡比今天小的比例 ×100;樣本 < minN → null */
export function pctTrail(x, win, minN) {
    const n = x.length, out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (x[i] == null) continue;
        let below = 0, m = 0;
        for (let j = Math.max(0, i - win); j < i; j++) { if (x[j] == null) continue; m++; if (x[j] < x[i]) below++; }
        if (m >= minN) out[i] = below / m * 100;
    }
    return out;
}

/** 歐尼爾出貨日(照 App `_calcDistributionDays` 的規則逐日算):跌 ≥0.2% 且「量」比前一天大;收盤站上那天最高就撤銷;算近 lookback 天內還有效的。
 *  ⭐ 量一律用**成交金額** —— 指數的 volume 是 0(陷阱 #29),App 那支因此從來沒算出過出貨日 */
export function distSeries(rows, lookback = 25) {
    const n = rows.length, out = new Array(n).fill(null), active = [];
    for (let i = 1; i < n; i++) {
        const c = rows[i].c, pc = rows[i - 1].c, a = rows[i].a, pa = rows[i - 1].a;
        if (c > 0 && pc > 0 && a > 0 && pa > 0 && (c - pc) / pc * 100 <= -0.2 && a > pa) active.push({ idx: i, high: rows[i].h });
        for (let k = active.length - 1; k >= 0; k--) if (c > active[k].high || active[k].idx <= i - lookback) active.splice(k, 1);
        if (i >= lookback) out[i] = active.length;
    }
    return out;
}

/** 加權的逐日特徵(全部只用當天以前的資料;selftest ① 逐一驗) */
export function features(rows) {
    const n = rows.length, C = rows.map(r => r.c), A = rows.map(r => r.a);
    const sma = k => { const o = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += C[i]; if (i >= k) s -= C[i - k]; if (i >= k - 1) o[i] = s / k; } return o; };
    const ma20 = sma(20), ma60 = sma(60), ma200 = sma(200), ma240 = sma(240);
    const ret = C.map((c, i) => i ? c / C[i - 1] - 1 : null);
    const sdN = k => { const o = new Array(n).fill(null); for (let i = k; i < n; i++) { let s = 0, s2 = 0; for (let j = i - k + 1; j <= i; j++) { s += ret[j]; s2 += ret[j] * ret[j]; } const m = s / k; o[i] = Math.sqrt(Math.max(0, s2 / k - m * m)); } return o; };
    const sd20 = sdN(20), sd120 = sdN(120);
    const volPct = pctTrail(sd20, 756, 250);
    const hi252 = slideExt(C, 252, true);
    const dd252 = C.map((c, i) => hi252[i] ? c / hi252[i] - 1 : null);
    const bias240 = C.map((c, i) => ma240[i] ? c / ma240[i] - 1 : null);
    const biasPct = pctTrail(bias240, 1000, 250);
    const ret126 = C.map((c, i) => i >= 126 ? c / C[i - 126] - 1 : null);
    // 成交金額 60 日均 ÷ 250 日均:只平均「有值」的日子(0 = 資料源缺),一個視窗缺超過兩成就不給
    const amtR = new Array(n).fill(null);
    { let s60 = 0, s250 = 0, k60 = 0, k250 = 0;
      for (let i = 0; i < n; i++) {
          const v = A[i] > 0 ? A[i] : 0, h = A[i] > 0 ? 1 : 0;
          s60 += v; s250 += v; k60 += h; k250 += h;
          if (i >= 60) { const o = A[i - 60] > 0; s60 -= o ? A[i - 60] : 0; k60 -= o ? 1 : 0; }
          if (i >= 250) { const o = A[i - 250] > 0; s250 -= o ? A[i - 250] : 0; k250 -= o ? 1 : 0; }
          if (i >= 249 && k60 >= 48 && k250 >= 200) amtR[i] = (s60 / k60) / (s250 / k250);
      } }
    const ma60dn = ma60.map((v, i) => v != null && i >= 5 && ma60[i - 5] != null ? v < ma60[i - 5] : null);
    // App `_marketRegime`:月線 5 日斜率(%)= (今天月線 − 5 天前月線)/ 5 天前月線
    const slope20 = ma20.map((v, i) => v != null && i >= 5 && ma20[i - 5] != null ? (v - ma20[i - 5]) / ma20[i - 5] * 100 : null);
    const dist = distSeries(rows, 25);
    return { n, C, ret, ma20, ma60, ma200, ma240, sd20, sd120, volPct, dd252, bias240, biasPct, ret126, amtR, ma60dn, slope20, dist };
}

/** 市場廣度(上市個股,⛔ ETF):每個加權交易日 → 有算的檔數 / 站上 200 日線 / 一年新高 / 一年新低 / 上漲 / 下跌。
 *  ⭐ 新高新低的基準是「前 252 天」⛔ 不含今天(陷阱 #43);上漲下跌比前一個**自己的**交易日 */
export function breadthFrom(dir, names, dates) {
    const di = new Map(dates.map((d, i) => [d, i]));
    const n = dates.length;
    const N = new Int32Array(n), above = new Int32Array(n), nh = new Int32Array(n), nl = new Int32Array(n), adv = new Int32Array(n), dec = new Int32Array(n);
    let files = 0;
    for (const f of fs.readdirSync(dir).sort()) {
        const m = f.match(/^(\d{4})\.json$/); if (!m) continue;
        const sym = m[1];
        if (sym.startsWith('00')) continue;                       // ETF
        const nm = names[sym]; if (!Array.isArray(nm) || nm[2] !== 'twse') continue;   // 只收上市
        let bars;
        try { bars = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!Array.isArray(bars)) continue;
        bars = bars.filter(b => +b.close > 0);
        if (bars.length < 260) continue;
        files++;
        const c = bars.map(b => +b.close), k = bars.length;
        let s200 = 0;
        const dqMax = [], dqMin = [];                              // 視窗 [j−252, j−1]
        for (let j = 0; j < k; j++) {
            if (j >= 1) {                                         // 把 j−1 放進視窗、把 j−253 踢出
                const t = j - 1;
                while (dqMax.length && c[dqMax[dqMax.length - 1]] <= c[t]) dqMax.pop(); dqMax.push(t);
                while (dqMin.length && c[dqMin[dqMin.length - 1]] >= c[t]) dqMin.pop(); dqMin.push(t);
                while (dqMax[0] < j - 252) dqMax.shift();
                while (dqMin[0] < j - 252) dqMin.shift();
            }
            s200 += c[j]; if (j >= 200) s200 -= c[j - 200];
            const idx = di.get(d10(bars[j].date));
            if (idx == null) continue;
            if (j >= 1) { if (c[j] > c[j - 1]) adv[idx]++; else if (c[j] < c[j - 1]) dec[idx]++; }
            if (j >= 252) {
                N[idx]++;
                if (c[j] > s200 / 200) above[idx]++;
                if (c[j] > c[dqMax[0]]) nh[idx]++;
                if (c[j] < c[dqMin[0]]) nl[idx]++;
            }
        }
    }
    return { files, N, above, nh, nl, adv, dec };
}

/** 外部日資料 → 對到加權交易日(⭐ 一律用「早於當天」的最後一筆 = 落後至少一天才用,免得用到收盤後才公布的數字) */
export function alignLag(dates, map) {
    const ks = [...map.keys()].sort();
    const out = new Array(dates.length).fill(null);
    let p = -1;
    for (let i = 0; i < dates.length; i++) {
        while (p + 1 < ks.length && ks[p + 1] < dates[i]) p++;
        if (p >= 0) {
            const gapDays = (Date.parse(dates[i]) - Date.parse(ks[p])) / 864e5;
            if (gapDays <= 7) out[i] = map.get(ks[p]);               // 超過一週沒資料 → 不硬沿用
        }
    }
    return out;
}

// ── 標籤與段落 ───────────────────────────────────────────────────────────────
/** 未來 H 天(不含今天)最低 / 最高收盤相對今天的變化 ≤ −X% / ≥ +X% → 1;資料不夠 → −1 */
export function labelDown(C, H, X) {
    const n = C.length, out = new Int8Array(n).fill(-1);
    const mins = slideExt(C, H, false);                          // mins[j] = min C[j−H+1..j]
    for (let i = 0; i + H < n; i++) out[i] = mins[i + H] / C[i] - 1 <= -X / 100 ? 1 : 0;
    return out;
}
export function labelUp(C, H, X) {
    const n = C.length, out = new Int8Array(n).fill(-1);
    const maxs = slideExt(C, H, true);
    for (let i = 0; i + H < n; i++) out[i] = maxs[i + H] / C[i] - 1 >= X / 100 ? 1 : 0;
    return out;
}
/** 從近期高點跌下來的每一段(zigzag):跌滿 base% 才確認高點、從低點反彈 base% 才算這段結束。
 *  回 [{peakI, botI, depth, done}];再依「最深跌幅 ≥ L%」分級,trigI = 第一次跌滿 L% 那天 */
export function swings(C, base = 10) {
    const out = [], th = base / 100;
    let mode = 'up', pk = 0, tr = 0;
    for (let i = 1; i < C.length; i++) {
        if (mode === 'up') {
            if (C[i] >= C[pk]) pk = i;
            else if (C[i] <= C[pk] * (1 - th)) { mode = 'down'; tr = i; out.push({ peakI: pk, botI: i, done: false }); }
        } else {
            const e = out[out.length - 1];
            if (C[i] <= C[tr]) { tr = i; e.botI = i; }
            else if (C[i] >= C[tr] * (1 + th)) { e.done = true; mode = 'up'; pk = i; }
        }
    }
    return out.map(e => ({ ...e, depth: +((C[e.botI] / C[e.peakI] - 1) * 100).toFixed(2) }));
}
export function episodes(rows, L, base = 10) {
    const C = rows.map(r => r.c);
    return swings(C, base).filter(e => e.depth <= -L).map(e => {
        let t = e.peakI; while (t < e.botI && C[t] > C[e.peakI] * (1 - L / 100)) t++;
        return { ...e, trigI: t, peakD: rows[e.peakI].d, trigD: rows[t].d, botD: rows[e.botI].d, daysToBot: e.botI - t };
    });
}
/** 20 天內急跌 ≥X%:第一次收盤比前 20 天最高低 X%(同一波 60 天內只算一次) */
export function fastCrashes(C, X = 10, W = 20, gap = 60) {
    const hi = slideExt(C, W, true), out = [];
    let last = -Infinity;
    for (let i = W; i < C.length; i++) {
        if (C[i] / hi[i] - 1 <= -X / 100 && i - last >= gap) {
            let pk = i; for (let j = i - W + 1; j <= i; j++) if (C[j] === hi[i]) { pk = j; break; }
            out.push({ trigI: i, peakI: pk }); last = i;
        }
    }
    return out;
}

// ── 檢定 ────────────────────────────────────────────────────────────────────
/** sig / lab:Int8Array(−1 = 沒有)→ 只看兩邊都有的日子 */
function pairs(sig, lab, keep) {
    const idx = [];
    for (let i = 0; i < sig.length; i++) if (sig[i] >= 0 && lab[i] >= 0 && (!keep || keep(i))) idx.push(i);
    return idx;
}
export function liftOf(sig, lab, keep) {
    const idx = pairs(sig, lab, keep);
    let on = 0, hit = 0, pos = 0;
    for (const i of idx) { pos += lab[i]; if (sig[i] === 1) { on++; hit += lab[i]; } }
    const base = idx.length ? pos / idx.length : NaN, prec = on ? hit / on : NaN;
    return { days: idx.length, on, hit, base, prec, lift: prec - base };
}
/** 平移安慰劑:亮燈序列整段循環平移(保留連續性)N 次 → 單尾 p 值 */
export function placebo(sig, lab, nShift = N_SHIFT, seed = 7) {
    const idx = pairs(sig, lab), m = idx.length;
    const s = idx.map(i => sig[i]), y = idx.map(i => lab[i]);
    const on = s.reduce((a, b) => a + b, 0), base = y.reduce((a, b) => a + b, 0) / m;
    if (!on || m < 2 * MIN_SHIFT + 10) return { p: null, med: null, obs: null };
    let hit = 0; for (let j = 0; j < m; j++) hit += s[j] & y[j];
    const obs = hit / on - base;
    const R = rng(seed), lifts = [];
    let ge = 0;
    for (let k = 0; k < nShift; k++) {
        const off = MIN_SHIFT + Math.floor(R() * (m - 2 * MIN_SHIFT));
        let h = 0; for (let j = 0; j < m; j++) h += s[(j + off) % m] & y[j];
        const l = h / on - base; lifts.push(l); if (l >= obs - 1e-12) ge++;
    }
    lifts.sort((a, b) => a - b);
    return { p: (1 + ge) / (1 + nShift), med: lifts[lifts.length >> 1], obs };
}
/** BH 校正:ps = [p 或 null] → q */
export function bh(ps) {
    const items = ps.map((p, i) => ({ p, i })).filter(x => x.p != null).sort((a, b) => a.p - b.p);
    const m = items.length, q = new Array(ps.length).fill(null);
    let prev = 1;
    for (let k = m - 1; k >= 0; k--) { prev = Math.min(prev, items[k].p * m / (k + 1)); q[items[k].i] = prev; }
    return q;
}

/** 段落層級:每一段崩跌,高點前 PRE 天到跌滿 L% 那天之間有沒有「新亮起來」的燈(⛔ 早就亮著的不算 —— 那是上一波留下來的)。
 *  第一次新亮那天:離跌滿還有幾天(lead)、相對高點早幾天(負 = 高點之前)、從那天到谷底還會跌多少(avoid)、到高點還會漲多少(forgo) */
export function episodeStats(sig, C, eps) {
    const rows = [];
    let stale = 0;
    for (const e of eps) {
        const from = Math.max(1, e.peakI - PRE);
        if (sig[from - 1] < 0) continue;                          // 那段時間訊號還沒有資料 → 不算
        if (sig[from - 1] === 1) stale++;                         // 視窗開始前就亮著(上一波的)
        let f = -1;
        for (let i = from; i <= e.trigI; i++) if (sig[i] === 1 && sig[i - 1] !== 1) { f = i; break; }
        rows.push(f < 0 ? { hit: false }
            : { hit: true, lead: e.trigI - f, vsPeak: f - e.peakI, avoid: pct(C[e.botI] / C[f] - 1), forgo: pct(Math.max(0, C[e.peakI] / C[f] - 1)) });
    }
    const hits = rows.filter(r => r.hit);
    const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
    return { n: rows.length, hit: hits.length, stale, recall: rows.length ? r2(hits.length / rows.length * 100) : null,
             leadMed: med(hits.map(r => r.lead)), vsPeakMed: med(hits.map(r => r.vsPeak)), beforePeak: hits.filter(r => r.vsPeak < 0).length,
             avoidMed: r2(med(hits.map(r => r.avoid))), forgoMed: r2(med(hits.map(r => r.forgo))) };
}
/** 亮燈起點(熄燈 ≥ONSET_GAP 天後第一次亮):多少次之後 60 天內真的跌 10%;每年幾次假警報 */
export function onsetStats(sig, lab, dates) {
    let onsets = 0, hits = 0, offRun = ONSET_GAP, avail = 0, first = null, last = null;
    for (let i = 0; i < sig.length; i++) {
        if (sig[i] < 0) { offRun = 0; continue; }
        avail++; if (first == null) first = i; last = i;
        if (sig[i] === 1) {
            if (offRun >= ONSET_GAP && lab[i] >= 0) { onsets++; hits += lab[i]; }
            offRun = 0;
        } else offRun++;
    }
    const yrs = avail / 250;
    return { onsets, hits, hitRate: onsets ? r2(hits / onsets * 100) : null, faPerYear: yrs > 0 ? r2((onsets - hits) / yrs) : null,
             from: first != null ? dates[first] : null, to: last != null ? dates[last] : null };
}

/** 怎麼防:報酬指數(0050 代理)亮燈 → 留 wOn、燈滅回到 1;看到燈的隔天收盤才換(⛔ 不用當天收盤)、扣成本 */
export function actionTest(sig, dates, tr, wOn) {
    const ix = []; for (let i = 0; i < dates.length; i++) if (tr.has(dates[i]) && sig[i] >= 0) ix.push(i);
    if (ix.length < 500) return null;
    const v = ix.map(i => tr.get(dates[i]));
    const run = useSig => {
        let eq = 1, peak = 1, mdd = 0, w = 1, sw = 0, expo = 0;
        const yearEnd = new Map(); let yStart = 1, curY = dates[ix[0]].slice(0, 4), worst = Infinity;
        for (let k = 1; k < ix.length; k++) {
            const tgt = useSig && k >= 2 && sig[ix[k - 2]] === 1 ? wOn : 1;      // 第 k−2 天的燈 → 第 k−1 天收盤換 → 第 k 天報酬
            if (tgt !== w) { const d = tgt - w; eq *= 1 - Math.abs(d) * (d < 0 ? COST_SELL : COST_BUY) / 100; w = tgt; sw++; }
            eq *= 1 + w * (v[k] / v[k - 1] - 1);
            expo += w;
            if (eq > peak) peak = eq; mdd = Math.min(mdd, eq / peak - 1);
            const y = dates[ix[k]].slice(0, 4);
            if (y !== curY) { worst = Math.min(worst, yearEnd.get(curY) / yStart - 1); yStart = yearEnd.get(curY); curY = y; }
            yearEnd.set(y, eq);
        }
        worst = Math.min(worst, yearEnd.get(curY) / yStart - 1);
        const yrs = (ix.length - 1) / 250;
        return { mult: r2(eq), cagr: r2((Math.pow(eq, 1 / yrs) - 1) * 100), mdd: pct(mdd), worstYear: pct(worst), switches: sw, expo: r2(expo / (ix.length - 1) * 100) };
    };
    return { from: dates[ix[0]], to: dates[ix[ix.length - 1]], hold: run(false), sig: run(true) };
}

// ── 訊號 ────────────────────────────────────────────────────────────────────
const toSig = (n, f) => { const s = new Int8Array(n).fill(-1); for (let i = 0; i < n; i++) { const v = f(i); if (v != null) s[i] = v ? 1 : 0; } return s; };

/** 全部訊號(每一個:key / 名字 / 組 / build(th) / def 預設門檻 / grid 高原用的門檻 / primary 進不進 BH) */
export function signalDefs(F, B, X) {
    const n = F.n, C = F.C, defs = [];
    const add = (o) => defs.push(o);
    // ① 趨勢
    add({ key: 'bear60', name: '嚴格空頭(收盤<季線且月線<季線,App 空頭守門)', g: '趨勢', build: () => toSig(n, i => F.ma60[i] == null ? null : C[i] < F.ma60[i] && F.ma20[i] < F.ma60[i]) });
    add({ key: 'below200', name: '跌破 200 日線', g: '趨勢', build: () => toSig(n, i => F.ma200[i] == null ? null : C[i] < F.ma200[i]) });
    add({ key: 'ma60dn', name: '季線下彎(比 5 天前低)', g: '趨勢', build: () => toSig(n, i => F.ma60dn[i]) });
    add({ key: 'dd252', name: '離一年最高已跌 X%', g: '趨勢', def: 7, grid: [3, 4, 5, 6, 7, 8, 10], build: th => toSig(n, i => F.dd252[i] == null ? null : F.dd252[i] <= -th / 100) });
    // ② 波動
    add({ key: 'volPct', name: '20 日波動在過去 3 年的位階 ≥ X', g: '波動', def: 80, grid: [70, 75, 80, 85, 90, 95], build: th => toSig(n, i => F.volPct[i] == null ? null : F.volPct[i] >= th) });
    add({ key: 'volRatio', name: '20 日波動 ÷ 120 日波動 ≥ X', g: '波動', def: 1.5, grid: [1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0], build: th => toSig(n, i => F.sd120[i] ? F.sd20[i] / F.sd120[i] >= th : null) });
    add({ key: 'calmShock', name: '平靜很久後第一根大跌(前一天波動位階 ≤30、今天跌 ≥ X%)', g: '波動', def: 2, grid: [1.5, 2, 2.5, 3, 3.5],
         build: th => toSig(n, i => i < 1 || F.volPct[i - 1] == null ? null : F.volPct[i - 1] <= 30 && F.ret[i] <= -th / 100) });
    // ③ 過熱
    add({ key: 'bias240', name: '年線乖離 ≥ X%', g: '過熱', def: 25, grid: [15, 20, 25, 30, 35], build: th => toSig(n, i => F.bias240[i] == null ? null : F.bias240[i] >= th / 100) });
    add({ key: 'biasPct', name: '年線乖離在過去 4 年的位階 ≥ X', g: '過熱', def: 90, grid: [80, 85, 90, 95, 97.5], build: th => toSig(n, i => F.biasPct[i] == null ? null : F.biasPct[i] >= th) });
    add({ key: 'ret126', name: '半年漲幅 ≥ X%', g: '過熱', def: 30, grid: [20, 25, 30, 35, 40], build: th => toSig(n, i => F.ret126[i] == null ? null : F.ret126[i] >= th / 100) });
    add({ key: 'amtR', name: '成交金額 60 日均 ÷ 250 日均 ≥ X', g: '過熱', def: 1.4, grid: [1.2, 1.3, 1.4, 1.5, 1.6, 1.8], build: th => toSig(n, i => F.amtR[i] == null ? null : F.amtR[i] >= th) });
    // ⑧ App 現有的大盤警示(式子照抄 index.html;⛔ 這裡只量,不改 App)
    add({ key: 'appBear', name: 'App 盤勢「🐻 空頭」(年線乖離 < −5%)', g: 'App', build: () => toSig(n, i => F.bias240[i] == null ? null : F.bias240[i] < -0.05) });
    add({ key: 'appHot', name: 'App 盤勢「🐂 多頭(過熱)」(年線乖離 > 20%、沒破月季線)', g: 'App',
         build: () => toSig(n, i => F.bias240[i] == null || F.ma60[i] == null ? null : F.bias240[i] > 0.20 && !(C[i] < F.ma20[i] && C[i] < F.ma60[i])) });
    add({ key: 'appWeak', name: 'App 盤勢「多頭轉弱」(年線乖離 > 5% 但破月線與季線)', g: 'App',
         build: () => toSig(n, i => F.bias240[i] == null || F.ma60[i] == null ? null : F.bias240[i] > 0.05 && C[i] < F.ma20[i] && C[i] < F.ma60[i]) });
    add({ key: 'appCrash', name: 'App「🩸 崩跌盤」(月線<季線、月線下彎、20 日波動 ≥1.8%)', g: 'App',
         build: () => toSig(n, i => F.slope20[i] == null || F.ma60[i] == null || F.sd20[i] == null ? null : C[i] < F.ma20[i] && F.ma20[i] < F.ma60[i] && F.slope20[i] < -0.3 && F.sd20[i] * 100 >= 1.8) });
    add({ key: 'dist', name: 'App 歐尼爾出貨日(近 25 天 ≥ X 天;量改用成交金額)', g: 'App', def: 5, grid: [3, 4, 5, 6, 7], build: th => toSig(n, i => F.dist[i] == null ? null : F.dist[i] >= th) });
    // ④ 廣度(2010 起)
    if (B) {
        const okN = i => B.N[i] >= BREADTH_MIN_N;
        const pA = i => B.above[i] / B.N[i];
        const nhnl10 = new Array(n).fill(null);
        for (let i = 9; i < n; i++) { let s = 0, ok = true; for (let j = i - 9; j <= i; j++) { if (!okN(j)) { ok = false; break; } s += (B.nh[j] - B.nl[j]) / B.N[j]; } if (ok) nhnl10[i] = s / 10; }
        const adl = new Array(n).fill(null); { let s = 0, on = false; for (let i = 0; i < n; i++) { if (okN(i)) on = true; if (!on) continue; s += B.adv[i] - B.dec[i]; adl[i] = s; } }
        add({ key: 'divA200', name: '指數離一年高 ≤3%,但站上 200 日線的股票 ≤ X%(頭部背離)', g: '廣度', def: 50, grid: [40, 45, 50, 55, 60],
             build: th => toSig(n, i => !okN(i) || F.dd252[i] == null ? null : F.dd252[i] >= -0.03 && pA(i) <= th / 100) });
        add({ key: 'divNHNL', name: '指數離一年高 ≤3%,但近 10 天創一年新低的股票比新高多', g: '廣度',
             build: () => toSig(n, i => nhnl10[i] == null || F.dd252[i] == null ? null : F.dd252[i] >= -0.03 && nhnl10[i] < 0) });
        add({ key: 'divADL', name: '指數 X 天上漲、但騰落線 X 天下跌(漲跌家數背離)', g: '廣度', def: 60, grid: [40, 50, 60, 80, 100],
             build: th => toSig(n, i => i < th || adl[i] == null || adl[i - th] == null ? null : C[i] > C[i - th] && adl[i] < adl[i - th]) });
        add({ key: 'breadthLow', name: '站上 200 日線的股票 ≤ X%(多數股已轉弱)', g: '廣度', def: 40, grid: [30, 35, 40, 45, 50],
             build: th => toSig(n, i => !okN(i) ? null : pA(i) <= th / 100) });
    }
    // ⑥ 期貨(2016 起,落後一天)
    if (X && X.tf) {
        const T = X.tf;
        const pcP = pctTrail(T.pcOI, 500, 120), ltP = pctTrail(T.lt10, 500, 120), rlP = pctTrail(T.retail, 500, 120);
        add({ key: 'pcLow', name: '選擇權 P/C 未平倉比在過去 2 年位階 ≤ X(太少人買保險)', g: '期貨', def: 10, grid: [5, 10, 15, 20, 25], build: th => toSig(n, i => pcP[i] == null ? null : pcP[i] <= th) });
        add({ key: 'ltShort', name: '台指期前十大交易人淨部位在過去 2 年位階 ≤ X(大戶偏空)', g: '期貨', def: 10, grid: [5, 10, 15, 20, 25], build: th => toSig(n, i => ltP[i] == null ? null : ltP[i] <= th) });
        add({ key: 'retailLong', name: '小台散戶多空比在過去 2 年位階 ≥ X(散戶偏多)', g: '期貨', def: 90, grid: [75, 80, 85, 90, 95], build: th => toSig(n, i => rlP[i] == null ? null : rlP[i] >= th) });
    }
    // ⑦ 美股(2021-10 起,只描述)
    if (X && X.us) {
        const U = X.us;
        add({ key: 'vix25', name: '美國 VIX ≥ 25(前一晚)', g: '美股', descOnly: true, build: () => toSig(n, i => U.vix[i] == null ? null : U.vix[i] >= 25) });
        add({ key: 'soxBelow200', name: '費半跌破 200 日線(前一晚)', g: '美股', descOnly: true, build: () => toSig(n, i => U.sox[i] == null ? null : U.sox[i] < 0) });
    }
    return defs;
}

/** 對一個訊號跑完整套:六關 + 段落 + 假警報 + 行動 */
export function assess(def, ctx, opt = {}) {
    const { F, dates, labs, eps, fast, tr } = ctx;
    const sig = def.build(def.def);
    const main = liftOf(sig, labs.dn60);
    const segs = {};
    for (const [k, nm, a, b] of SEGS) {
        const r = liftOf(sig, labs.dn60, i => dates[i] >= a && dates[i] < b);
        segs[k] = { nm, on: r.on, base: pct(r.base), prec: pct(r.prec), lift: pct(r.lift), counted: r.on >= SEG_MIN_ON };
    }
    const years = {}; { const ys = new Set(dates.map(d => d.slice(0, 4)));
        for (const y of ys) { const r = liftOf(sig, labs.dn60, i => dates[i].slice(0, 4) === y); if (r.on >= YEAR_MIN_ON) years[y] = pct(r.lift); } }
    const yPos = Object.values(years).filter(x => x > 0).length, yNeg = Object.values(years).filter(x => x < 0).length;
    // ④ 拿掉貢獻最大那一段(回撤 ≥10% 的段落,高點前 60 天到谷底)
    let dropBest = null, bestEp = null;
    { let bestHit = -1;
      for (const e of eps.L10) { const a = Math.max(0, e.peakI - PRE), b = e.botI; let h = 0; for (let i = a; i <= b; i++) if (sig[i] === 1 && labs.dn60[i] === 1) h++; if (h > bestHit) { bestHit = h; bestEp = e; } }
      if (bestEp) { const a = Math.max(0, bestEp.peakI - PRE), b = bestEp.botI; dropBest = liftOf(sig, labs.dn60, i => i < a || i > b).lift; } }
    // ⑤ 高原
    let plateau = null;
    if (def.grid) {
        const k = def.grid.indexOf(def.def), nb = def.grid.slice(Math.max(0, k - 2), k + 3);
        plateau = nb.map(th => ({ th, lift: pct(liftOf(def.build(th), labs.dn60).lift) }));
    }
    const pl = opt.noPlacebo ? { p: null } : placebo(sig, labs.dn60);
    const segOk = Object.values(segs).filter(s => s.counted);
    const gates = {
        '①全期': main.lift > 0,
        '②分段': segOk.length >= 2 && segOk.every(s => s.lift > 0),
        '③逐年': yPos + yNeg >= 3 && yPos >= yNeg,
        '④去最好那段': dropBest != null && dropBest > 0,
        '⑤高原': plateau ? plateau.every(x => x.lift > 0) : true,
        '⑥安慰劑': null,                                        // BH 之後填
    };
    const other = {
        dn20: pct(liftOf(sig, labs.dn20).lift), deep: pct(liftOf(sig, labs.deep).lift), up60: pct(liftOf(sig, labs.up60).lift),
    };
    const epi = { L10: episodeStats(sig, F.C, eps.L10), L15: episodeStats(sig, F.C, eps.L15), L20: episodeStats(sig, F.C, eps.L20), fast: episodeStats(sig, F.C, fast) };
    const ons = onsetStats(sig, labs.dn60, dates);
    const act = { half: actionTest(sig, dates, tr, 0.5), out: actionTest(sig, dates, tr, 0) };
    let last = -1; for (let i = sig.length - 1; i >= 0; i--) if (sig[i] >= 0) { last = i; break; }
    return {
        key: def.key, name: def.name, g: def.g, th: def.def ?? null, descOnly: !!def.descOnly,
        days: main.days, on: main.on, onPct: pct(main.on / main.days), base: pct(main.base), prec: pct(main.prec), lift: pct(main.lift),
        p: pl.p, plMed: pct(pl.med), segs, years, yPos, yNeg, dropBest: pct(dropBest), bestEp: bestEp ? bestEp.peakD : null, plateau, gates, other, epi, ons, act,
        now: last >= 0 ? { d: dates[last], on: sig[last] === 1 } : null,
    };
}

// ── 主程式 ───────────────────────────────────────────────────────────────────
const readJ = (p, must) => {
    if (!p) { if (must) throw new Error('缺必要輸入'); return null; }
    try { const t = fs.readFileSync(p, 'utf8'); if (!t.trim()) throw new Error('空檔'); return JSON.parse(t); }
    catch (e) { if (must) throw new Error(`${p} 讀不到(${e.message})`); console.log(`⚠️ ${p} 讀不到 → 跳過(${e.message})`); return null; }
};

export function run(env, log = console.log) {
    const long = readJ(env.IDX_LONG, true);
    const early = readJ(env.IDX_EARLY, false), now = readJ(env.TWII_NOW, false);
    const { rows, tr } = loadIndex({ long, early, now });
    const dates = rows.map(r => r.d), n = rows.length;
    log(`📈 加權 ${n} 天:${dates[0]} ~ ${dates[n - 1]}(${early ? '含 2000 年起的早期資料' : '⚠️ 沒有早期資料,只從 2010 起'})・報酬指數 ${tr.size} 天`);
    const F = features(rows);
    let B = null;
    if (env.DATA_DIR && env.NAMES) {
        const sn = readJ(env.NAMES, false);
        const names = sn ? (sn.names || sn) : null;
        if (names && fs.existsSync(env.DATA_DIR)) {
            B = breadthFrom(env.DATA_DIR, names, dates);
            const okDays = [...B.N].filter(x => x >= BREADTH_MIN_N).length;
            log(`🌐 廣度:上市個股 ${B.files} 檔 ・有 ≥${BREADTH_MIN_N} 檔可算的日子 ${okDays} 天`);
            if (B.files < 300 || okDays < 1000) { log('   ⚠️ 廣度樣本太少 → 不用廣度'); B = null; }
        }
    }
    const X = {};
    if (env.TAIFEX) {
        const T = readJ(env.TAIFEX, false);
        if (T && T.pc && T.lt) {
            const pcM = new Map(), ltM = new Map(), rlM = new Map();
            for (const [d, v] of Object.entries(T.pc)) if (Array.isArray(v) && Number.isFinite(+v[1])) pcM.set(d10(d), +v[1]);
            for (const [d, v] of Object.entries(T.lt)) { const a = v && v.all; if (Array.isArray(a) && +a[2] > 0) ltM.set(d10(d), +a[1] / +a[2]); }
            for (const [d, v] of Object.entries(T.rl || {})) if (Array.isArray(v) && Number.isFinite(+v[3])) rlM.set(d10(d), +v[3]);
            X.tf = { pcOI: alignLag(dates, pcM), lt10: alignLag(dates, ltM), retail: alignLag(dates, rlM) };
            log(`🧾 期貨:P/C ${pcM.size} 天 ・前十大 ${ltM.size} 天 ・散戶多空比 ${rlM.size} 天(一律落後一天才用)`);
        }
    }
    if (env.US_HIST) {
        const U = readJ(env.US_HIST, false);
        if (U && U.days && U.syms && U.syms['^VIX']) {
            const vM = new Map(), sM = new Map(), sc = U.syms['^SOX'] ? U.syms['^SOX'].c.map(Number) : [];
            U.days.forEach((d, k) => { const v = +U.syms['^VIX'].c[k]; if (v > 0) vM.set(d10(d), v); });
            for (let k = 199; k < sc.length; k++) { let s = 0; for (let j = k - 199; j <= k; j++) s += sc[j]; if (sc[k] > 0) sM.set(d10(U.days[k]), sc[k] / (s / 200) - 1); }
            X.us = { vix: alignLag(dates, vM), sox: alignLag(dates, sM) };
            log(`🇺🇸 美股:VIX ${vM.size} 天 ・費半 200 日線 ${sM.size} 天(只描述)`);
        }
    }
    const labs = { dn60: labelDown(F.C, H_MAIN, X_MAIN), dn20: labelDown(F.C, 20, 10), deep: labelDown(F.C, 120, 20), up60: labelUp(F.C, H_MAIN, X_MAIN) };
    const eps = { L10: episodes(rows, 10), L15: episodes(rows, 15), L20: episodes(rows, 20) };
    const fast = fastCrashes(F.C);
    const ctx = { F, dates, labs, eps, fast, tr };
    const defs = signalDefs(F, B, X);
    const res = defs.map(d => assess(d, ctx));
    const prim = res.map(r => r.descOnly ? null : r.p);
    const q = bh(prim);
    res.forEach((r, i) => { r.q = q[i] == null ? null : +q[i].toFixed(4); r.gates['⑥安慰劑'] = r.descOnly ? null : (r.q != null && r.q <= 0.05 && r.lift > 0);
        r.pass = !r.descOnly && Object.values(r.gates).every(Boolean); r.nPass = Object.values(r.gates).filter(Boolean).length; });
    const baseAll = liftOf(new Int8Array(n).fill(0), labs.dn60);
    const epsOut = eps.L10.map(e => ({ peak: e.peakD, trig: e.trigD, bot: e.botD, depth: e.depth, daysToBot: e.daysToBot, done: e.done }));
    const nowF = (() => { const i = n - 1; return { d: dates[i], bias240: pct(F.bias240[i]), biasPct: r2(F.biasPct[i]), volPct: r2(F.volPct[i]), ret126: pct(F.ret126[i]), dd252: pct(F.dd252[i]), amtR: r2(F.amtR[i]), dist: F.dist[i],
        pctAbove200: B ? (() => { for (let j = n - 1; j >= 0; j--) if (B.N[j] >= BREADTH_MIN_N) return { d: dates[j], v: r2(B.above[j] / B.N[j] * 100) }; return null; })() : null }; })();
    return {
        meta: { generated: new Date().toISOString(), from: dates[0], to: dates[n - 1], days: n, early: !!early, breadth: !!B, taifex: !!X.tf, us: !!X.us,
                base_dn60: pct(baseAll.base), label: `未來 ${H_MAIN} 個交易日內最低收盤比今天低 ≥${X_MAIN}%`,
                gates: '①全期 ②分段(2000–09/2010–17/2018–26)③逐年 ④拿掉最好那段 ⑤高原 ⑥平移安慰劑 BH≤0.05' },
        episodes: { L10: epsOut, L15: eps.L15.length, L20: eps.L20.length, fast: fast.map(f => ({ peak: dates[f.peakI], trig: dates[f.trigI] })) },
        signals: res, now: nowF,
        untestable: [
            { name: '風險指數(六因子合成)', why: 'VIX/外資期貨/美元/標普/日圓/黃金沒有同一段長歷史,而且權重是憑空訂的(陷阱 #38)' },
            { name: '外資台指期「急遽加空 / 空單最重」', why: 'risk_history.json 只有 90 天;期交所外資未平倉沒有長歷史(taifex_hist 的 inst 段抓不到)' },
            { name: '反攻雷達黑天鵝層(VIX 爆表 / 日圓急升 / 日韓股 −5%)', why: '日圓、日經、韓股沒有存逐日歷史;VIX 只有 2021-10 起' },
            { name: '全球熔斷(標普/那指 ≤ −7%、日經/韓股 ≤ −8%)', why: '2021-10 起標普、那指沒有任何一天跌到 −7%;日韓沒有歷史' },
        ],
    };
}

// ── 輸出 ────────────────────────────────────────────────────────────────────
function printReport(R, log = console.log) {
    const s = x => x == null ? '—' : (x >= 0 ? '+' : '') + x;
    log(`\n🧭 基準:任何一天「${R.meta.label}」的機率 = ${R.meta.base_dn60}%(${R.meta.from} ~ ${R.meta.to},${R.meta.days} 天)`);
    log(`📉 從近期高點跌 ≥10% 共 ${R.episodes.L10.length} 段、≥15% ${R.episodes.L15} 段、≥20% ${R.episodes.L20} 段、20 天急跌 ≥10% ${R.episodes.fast.length} 次`);
    log('   ' + R.episodes.L10.map(e => `${e.peak.slice(0, 7)}→${e.bot.slice(0, 7)} ${e.depth}%`).join(' ・'));
    log('\n訊號(門檻)                                             亮燈%  命中%  基準% 差(pp) 安慰劑p   q     分段 E/A/B           拿掉最好 逐年+/− 高原 → 關卡');
    for (const r of R.signals) {
        const sg = ['E', 'A', 'B'].map(k => r.segs[k].counted ? s(r.segs[k].lift) : '·').join('/');
        log(`${(r.name + (r.th != null ? `【${r.th}】` : '')).slice(0, 52).padEnd(52)} ${String(r.onPct).padStart(5)} ${String(r.prec).padStart(6)} ${String(r.base).padStart(6)} ${s(r.lift).padStart(6)} ${r.p == null ? '   —  ' : r.p.toFixed(3).padStart(6)} ${r.q == null ? '  —  ' : r.q.toFixed(3)} ${sg.padEnd(20)} ${s(r.dropBest).padStart(6)} ${r.yPos}/${r.yNeg} ${r.plateau ? r.plateau.map(x => s(x.lift)).join(',') : '免'} → ${r.descOnly ? '只描述' : r.nPass + '/6' + (r.pass ? ' ✅' : '')}`);
    }
    log('\n段落層級(跌 ≥15% 的每一段:高點前 60 天到跌滿 15% 之間「新亮」的燈;早就亮著的不算)與每年假警報:');
    for (const r of R.signals) {
        const e = r.epi.L15;
        log(`  ${r.key.padEnd(12)} 抓到 ${e.hit}/${e.n} 段(其中高點前就亮 ${e.beforePeak})・相對高點中位 ${e.vsPeakMed ?? '—'} 天 ・離跌滿 15% 還有 ${e.leadMed ?? '—'} 天 ・亮燈後到谷底還跌 ${e.avoidMed ?? '—'}% ・到高點還漲 ${e.forgoMed ?? '—'}% ・早就亮著 ${e.stale} 段 | 新亮 ${r.ons.onsets} 次(60 天內真的跌 10% 的 ${r.ons.hitRate ?? '—'}%)・假警報 ${r.ons.faPerYear ?? '—'} 次/年`);
    }
    log('\n怎麼防(報酬指數,亮燈隔天收盤換,扣成本):');
    for (const r of R.signals) {
        const a = r.act.half, b = r.act.out; if (!a) continue;
        log(`  ${r.key.padEnd(12)} ${a.from}~${a.to} 買了放著 ×${a.hold.mult}(年化 ${a.hold.cagr}%、最多賠 ${a.hold.mdd}%)| 留一半 ×${a.sig.mult}(${a.sig.cagr}%、${a.sig.mdd}%、換 ${a.sig.switches} 次)| 全出 ×${b.sig.mult}(${b.sig.cagr}%、${b.sig.mdd}%)`);
    }
    log(`\n📍 現在(${R.now.d}):年線乖離 ${R.now.bias240}%(位階 ${R.now.biasPct})・波動位階 ${R.now.volPct} ・半年 ${R.now.ret126}% ・離一年高 ${R.now.dd252}% ・成交金額比 ${R.now.amtR} ・出貨日 ${R.now.dist}` + (R.now.pctAbove200 ? ` ・站上 200 日線 ${R.now.pctAbove200.v}%(${R.now.pctAbove200.d})` : ''));
    log('   亮著的:' + (R.signals.filter(r => r.now && r.now.on).map(r => r.key).join('、') || '(沒有)'));
}

// ── selftest ─────────────────────────────────────────────────────────────────
function selftest() {
    const fails = [];
    const ok = (name, c) => { console.log((c ? '✅ ' : '❌ ') + name); if (!c) fails.push(name); };
    // 合成加權:隨機漫步 + 注入 4 次崩跌(各跌 25%),崩跌前 40 天有一個「真的前兆」
    const R = rng(11), n = 3000, rows = [], crashAt = [700, 1300, 1900, 2500];
    let c = 8000;
    const d0 = Date.UTC(2005, 0, 3);
    for (let i = 0; i < n; i++) {
        let r = (R() - 0.45) * 0.02;                           // 每天平均 +0.1%:兩次崩跌之間一定回到前高(段落才分得開)
        for (const k of crashAt) if (i > k && i <= k + 25) r = -0.012;
        c *= 1 + r;
        rows.push({ d: new Date(d0 + i * 864e5 * 7 / 5).toISOString().slice(0, 10), o: c, h: c * 1.005, l: c * 0.995, c, a: 1e11 * (1 + R()) });
    }
    for (let i = 1; i < n; i++) if (rows[i].d <= rows[i - 1].d) rows[i].d = new Date(Date.parse(rows[i - 1].d) + 864e5).toISOString().slice(0, 10);
    const F = features(rows);
    // ① 因果:只給前 m 根算出來的特徵,第 m 根要跟全部資料算的一模一樣(⛔ 偷看未來 = 不一樣)
    const keys = ['ma20', 'ma60', 'ma200', 'ma240', 'sd20', 'sd120', 'volPct', 'dd252', 'bias240', 'biasPct', 'ret126', 'amtR', 'ma60dn', 'slope20', 'dist'];
    let causal = true;
    for (const m of [400, 1100, 2222, 2999]) { const Fm = features(rows.slice(0, m + 1)); for (const k of keys) if (Fm[k][m] !== F[k][m]) { causal = false; console.log('   前視:', k, m, Fm[k][m], F[k][m]); } }
    ok('① 全部特徵只用當天以前的資料(截斷重算逐一比對)', causal);
    // ①b 偵測器本身要叫得出前視:故意寫一個偷看明天的特徵,同一招要抓到
    const leaky = rs => rs.map((r, i) => (rs[i + 1] || r).c);
    ok('①b 注入「偷看明天」的特徵 → 截斷比對叫得出來', leaky(rows.slice(0, 1001))[1000] !== leaky(rows)[1000]);
    // ② 段落:注入 4 次 25% 崩跌 → 回撤 ≥20% 至少 4 段
    const e20 = episodes(rows, 20);
    ok('② 注入 4 次崩跌 → 跌 ≥20% 的段落抓到 ≥4 段', e20.length >= 4);
    // ②b zigzag:沒回到歷史高點也要分得開(⛔ drawdownEvents 會把兩段併成一段)
    const zz = swings([100, 120, 100, 90, 100, 110, 99, 80, 95, 100], 10);
    ok('②b 沒回到前高的兩次下跌 → 分成兩段、各自的高點與低點', zz.length === 2 && zz[0].peakI === 1 && zz[0].botI === 3 && zz[1].peakI === 5 && zz[1].botI === 7);
    // ③ 真前兆:崩跌前 30 天亮、崩跌開始就熄 → 差 > 0、安慰劑 p 小、段落抓到
    const labs = { dn60: labelDown(F.C, 60, 10) };
    const pre = new Int8Array(n).fill(0); for (const k of crashAt) for (let i = k - 30; i <= k; i++) pre[i] = 1;
    const L = liftOf(pre, labs.dn60), P = placebo(pre, labs.dn60, 400);
    ok(`③ 真前兆 → 差 > 0(+${pct(L.lift)}pp)、平移安慰劑 p ≤ 0.02(${P.p})`, L.lift > 0 && P.p <= 0.02);
    const es = episodeStats(pre, F.C, e20);
    ok(`③b 真前兆 → 每一段崩跌都在跌滿之前亮(${es.hit}/${es.n})`, es.n >= 4 && es.hit === es.n);
    // ④ 跟崩跌無關的隨機開關 → 安慰劑 p 不顯著
    const R2 = rng(99), rnd = new Int8Array(n).fill(0); let st = 0;
    for (let i = 0; i < n; i++) { if (R2() < 0.03) st = 1 - st; rnd[i] = st; }
    const P2 = placebo(rnd, labs.dn60, 400);
    ok(`④ 隨機開關 → 安慰劑 p > 0.05(${P2.p})`, P2.p > 0.05);
    // ⑤ 標籤:未來最低 ≤ −10% 才是 1;最後 60 天沒有標籤
    const C2 = [100, 98, 95, 89, 92, 100, 100, 100];
    const lb = labelDown(C2, 3, 10);
    ok('⑤ 標籤 = 未來 H 天最低 ≤ −X%(不含今天);資料不夠 = −1', lb[0] === 1 && lb[1] === 0 && lb[2] === 0 && lb[4] === 0 && lb[5] === -1 && lb[7] === -1);
    // ⑥ 出貨日:指數 volume = 0 也要算得出來(用成交金額);站上那天最高就撤銷
    const dr = [{ c: 100, h: 101, a: 10 }, { c: 99, h: 100.5, a: 20 }, { c: 98, h: 99, a: 30 }, { c: 98.5, h: 99, a: 10 }, { c: 100.6, h: 101, a: 10 }];
    const ds = distSeries(dr.map(x => ({ ...x, l: x.c, o: x.c })), 3);
    ok('⑥ 出貨日用成交金額算(量 = 0 照算)、收盤站上那天最高就撤銷', ds[3] === 2 && ds[4] === 0);
    // ⑦ 行動測試:永遠不亮 = 買了放著(逐位相同);永遠亮且全出 = 只有一次賣出成本
    const dates = rows.map(r => r.d), tr = new Map(rows.map(r => [r.d, r.c]));
    const a0 = actionTest(new Int8Array(n).fill(0), dates, tr, 0);
    ok('⑦ 永遠不亮 → 跟買了放著一模一樣(決定性對照)', a0 && a0.sig.mult === a0.hold.mult && a0.sig.mdd === a0.hold.mdd && a0.sig.switches === 0);
    const a1 = actionTest(new Int8Array(n).fill(1), dates, tr, 0);
    ok('⑦b 永遠亮 + 全出 → 只換一次、最後 ≈ 1 扣一次賣出成本', a1.sig.switches === 1 && Math.abs(a1.sig.mult - (1 - COST_SELL / 100) * tr.get(dates[1]) / tr.get(dates[0])) < 0.02);
    // ⑧ 外部資料一律落後一天:同一天的值 ⛔ 不可用
    const al = alignLag(['2020-01-02', '2020-01-03', '2020-01-06'], new Map([['2020-01-02', 1], ['2020-01-03', 2]]));
    ok('⑧ 外部日資料只用「早於當天」的最後一筆', al[0] === null && al[1] === 1 && al[2] === 2);
    // ⑨ 廣度:3 檔合成股(上市 2 + 上櫃 1)→ 只算上市;新高基準不含今天
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'cwp-'));
    const ds2 = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2015, 0, 5) + i * 864e5).toISOString().slice(0, 10));
    const up = ds2.map((d, i) => ({ date: d.replace(/-/g, '/'), close: 10 + i * 0.1 }));
    const dn = ds2.map((d, i) => ({ date: d.replace(/-/g, '/'), close: 50 - i * 0.1 }));
    fs.writeFileSync(path.join(td, '1111.json'), JSON.stringify(up)); fs.writeFileSync(path.join(td, '2222.json'), JSON.stringify(dn)); fs.writeFileSync(path.join(td, '3333.json'), JSON.stringify(up));
    const Bt = breadthFrom(td, { '1111': ['a', '01', 'twse'], '2222': ['b', '01', 'twse'], '3333': ['c', '01', 'tpex'] }, ds2);
    const j = 299;
    ok('⑨ 廣度只收上市、站上 200 日線 / 一年新高新低 / 漲跌家數算對(新高基準不含今天)', Bt.files === 2 && Bt.N[j] === 2 && Bt.above[j] === 1 && Bt.nh[j] === 1 && Bt.nl[j] === 1 && Bt.adv[j] === 1 && Bt.dec[j] === 1);
    fs.rmSync(td, { recursive: true, force: true });
    // ⑩ 沒有必要資料 → 丟錯(⛔ 不可以輸出一份空的報告)
    let threw = false; try { run({}); } catch { threw = true; }
    ok('⑩ 沒有 IDX_LONG → 丟錯(⛔ 空過)', threw);
    // ⑪ BH:p 小的那個 q 也小、單調
    const qq = bh([0.001, 0.04, 0.5, null]);
    ok('⑪ BH 校正:q 單調、null 不算', qq[0] <= qq[1] && qq[1] <= qq[2] && qq[3] === null && Math.abs(qq[0] - 0.003) < 1e-9);
    console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ CRASH_WARN_SELFTEST_PASS'}`);
    process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else {
        const out = process.argv.slice(2).find(a => a.endsWith('.json'));
        try {
            const R = run(process.env);
            printReport(R);
            if (out) { fs.writeFileSync(out, JSON.stringify(R)); console.log(`\n💾 ${out}`); }
        } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
    }
}
