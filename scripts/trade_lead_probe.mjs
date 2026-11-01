#!/usr/bin/env node
/**
 * 📦 出口 / 外銷訂單 → 產業 → 股價:能不能比月營收更早找到強勢產業?(評估紀錄 51,2026-11-01 使用者回「做」)
 *
 * 外部 AI 的主張:出口(按貨品)領先公司營收,所以「出口加速的產業」之後會漲;
 *   B 象限「出口↑ + 營收↑ + 股價還沒漲」是還沒反映的機會;外銷訂單比出口更早。
 *
 * ⭐ 先講時間(⛔ 不可以假裝出口比營收早很多):出口約次月 8~9 日公布、公司月營收法定次月 10 日前(很多更早)、
 *    外銷訂單約 20 日、國發會景氣指標約 27 日。→ 本探針**出口與月營收用同一個決定日**(次月 11 日起第一個交易日收盤),
 *    比的是「資訊內容」,⛔ 不給出口那 1~2 天的時間優勢(公布日每個月不一樣,資料檔裡也沒有)。
 *
 * 四個測驗(全部「同一天」對照,扣成本 0.44,六關 = lib_evgate,BH = lib_fdr):
 *   ① 出口挑產業:每月挑出口「加速 / 成長最快」的前 N 組產業 → 隔天開盤買、抱 5 / 20 / 60 個交易日(含息),
 *      減掉同一天全部產業組的平均;另比 加權報酬指數(含息)。參考臂:價格動能(sector_rotation_probe 那件事)、
 *      營收挑產業;安慰劑:每月隨機挑 N 組(500 次)、用一年前的出口(過時的資訊還有用 = 不是時效)。
 *   ② 出口有沒有比月營收多給資訊:
 *      ⓐ 每月橫切面迴歸(Fama-MacBeth):產業之後報酬 ~ 出口 + 營收 + 動能(同時放),看出口的係數
 *      ⓑ 基本面領先:下個月的產業營收年增 ~ 這個月營收年增 (+ 這個月出口年增),逐年往前樣本外比誤差
 *   ③ 外銷訂單(⛔ 經濟部按貨品的檔對自動下載回 403 → 只有國發會的「外銷訂單動向指數」,全體、不分貨品):
 *      ⓐ 動向指數 → 之後 1~3 個月全體營收年增(樣本外)ⓑ 動向指數 → 之後 20 / 60 日加權報酬指數(減同一年平均)
 *      ⓒ 名目半導體設備進口(同一份 ZIP)→ 電子零組件組之後的相對報酬
 *   ④ 個股四象限:A 出口↑營收↑已漲 / B 出口↑營收↑還沒漲 / C 出口↑營收沒↑ / D 出口↓營收↓ → 減同一天、同一批產業的全部股票
 *
 * ⛔ 前視守門:出口 / 營收 → 次月 11 日以後才算知道;國發會那兩項 → 次月 28 日以後;進場 = 決定日隔天開盤;
 *    開盤一價鎖漲停買不到 → 不算;窗口裡有價格斷崖(lib_cliff)→ 那一檔那一窗不算(⛔ 整檔剔除)。
 * ⚠️ 限制(誠實寫進輸出):產業別用**現在的** industry_map(下市股沒有產業別 → 不在籃子裡);出口 / 國發會資料是
 *    **最新修正後**的數字(財政部修正很小;國發會綜合指數修正較大,所以這裡只用它的構成項目);出口是美元、營收是台幣。
 *
 * 用法:DATA_DIR=<d16> REV_DIR=<stock_deep/rev> TRADE_DIR=<trade_deep> IDX_LONG=<idx_long.json> \
 *         node --max-old-space-size=6000 scripts/trade_lead_probe.mjs out.json
 *       node scripts/trade_lead_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { gates, COST, pTwo } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';
import { CLIFF_LO, CLIFF_HI } from './lib_cliff.mjs';
import { lockedBar } from './lib_limit.mjs';

const HS = [5, 20, 60];
const TOPS = [2, 3, 4, 5];
const MIN_MEMB = 4;          // 一組產業那個月至少要有幾檔算得出報酬(玻璃陶瓷只有 5 檔)
const MIN_BASKETS = 8;       // 一個月至少要有幾組產業才比
const AVAIL_DAY = 11;        // 出口 / 營收:次月 11 日起才算知道
const AVAIL_NDC = 28;        // 國發會:次月 28 日起才算知道
const SHAM_N = 500;

// 出口貨品(財政部「主要貨品」欄名,⛔ 改名要跟著 CSV 表頭)→ 上市櫃產業代碼
export const BASKETS = [
    { k: 'elec', n: '電子零組件 → 半導體+電子零組件', exp: '(1)電子零組件', ind: ['24', '28'] },
    { k: 'ict', n: '資通與視聽 → 電腦週邊+通信網路', exp: '(4)資通與視聽產品', ind: ['25', '27'] },
    { k: 'mach', n: '機械 → 電機機械', exp: '(2)機械', ind: ['05'] },
    { k: 'eleq', n: '電機產品 → 電器電纜', exp: '(3)電機產品', ind: ['06'] },
    { k: 'steel', n: '鋼鐵及其製品 → 鋼鐵', exp: '(1)鋼鐵及其製品', ind: ['10'] },
    { k: 'plas', n: '塑膠原料 → 塑膠', exp: '(1)塑膠原料', ind: ['03'] },
    { k: 'rubb', n: '橡膠及其製品 → 橡膠', exp: '(3)橡膠及其製品', ind: ['11'] },
    { k: 'text', n: '紡織品 → 紡織', exp: '11.紡織品', ind: ['04'] },
    { k: 'chem', n: '化學品 → 化學', exp: '6.化學品', ind: ['21'] },
    { k: 'paper', n: '紙漿紙品 → 造紙', exp: '10.紙漿；紙及其製品；印刷品', ind: ['09'] },
    { k: 'glass', n: '非金屬礦物製品 → 玻璃陶瓷', exp: '13.非金屬礦物製品', ind: ['08'] },
    { k: 'auto', n: '運輸工具 → 汽車', exp: '17.運輸工具', ind: ['12'] },
    { k: 'oil', n: '石油煉製品 → 油電燃氣', exp: '(1)石油煉製品', ind: ['23'] },
    { k: 'food', n: '調製食品飲料 → 食品', exp: '4.調製食品；飲料及菸酒', ind: ['02'] },
];

// ───────────────────────── 小工具 ─────────────────────────
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sg = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
export const ymAdd = (ym, k) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return `${y}-${String(m + 1).padStart(2, '0')}`; };
const rng = s => () => ((s = (s * 16807) % 2147483647) / 2147483647);

/** 簡單 CSV(財政部 / 國發會:欄位有雙引號、沒有跨行)→ 二維陣列 */
export function parseCsv(txt) {
    const out = [];
    for (const line of String(txt).replace(/^﻿/, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const row = []; let cur = '', q = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
            else if (ch === '"') q = true;
            else if (ch === ',') { row.push(cur); cur = ''; }
            else cur += ch;
        }
        row.push(cur); out.push(row);
    }
    return out;
}

/** 財政部「出口值_按主要貨品分」(列 = 期別「115年 9月」、欄 = 貨品)→ {cats, ser: Map(貨品 → Map(ym → 百萬美元))};年度列不收 */
export function loadExports(txt) {
    const rows = parseCsv(txt);
    const head = rows[0].map(h => h.replace(/^按美元計算\(百萬美元\)\/\s*/, '').trim());
    const ser = new Map(head.slice(1).map(h => [h, new Map()]));
    for (const r of rows.slice(1)) {
        const m = /^\s*(\d{2,3})年\s*(\d{1,2})月/.exec(r[0] || '');
        if (!m) continue;
        const ym = `${+m[1] + 1911}-${String(+m[2]).padStart(2, '0')}`;
        for (let j = 1; j < head.length; j++) { const v = parseFloat(r[j]); if (Number.isFinite(v)) ser.get(head[j]).set(ym, v); }
    }
    return { cats: head.slice(1), ser };
}

/** 最小 ZIP 讀取(國發會 6099 給 ZIP;⛔ 不另裝套件)→ Map(檔名 → Buffer) */
export function unzip(buf) {
    let e = buf.length - 22;
    while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('不是 ZIP(找不到目錄結尾)');
    const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
    const out = new Map();
    for (let k = 0; k < n; k++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目錄壞了');
        const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
        const st = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const raw = buf.subarray(st, st + csize);
        out.set(name, method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null);
        p += 46 + nlen + xlen + clen;
    }
    return out;
}

/** 國發會 ZIP 的一份 CSV(Date = 198201)→ Map(欄名 → Map(ym → 值)) */
export function loadNdc(buf) {
    const rows = parseCsv(buf.toString('utf8'));
    const head = rows[0];
    const ser = new Map(head.slice(1).map(h => [h, new Map()]));
    for (const r of rows.slice(1)) {
        const m = /^(\d{4})(\d{2})$/.exec((r[0] || '').trim()); if (!m) continue;
        for (let j = 1; j < head.length; j++) { const v = parseFloat(r[j]); if (Number.isFinite(v)) ser.get(head[j]).set(`${m[1]}-${m[2]}`, v); }
    }
    return ser;
}

/** 年增(3 個月加總 vs 一年前同 3 個月;任一個月缺 → null)與加速(這個月的 3 個月年增 − 上個月的) */
export function yoy3(get, ym) {
    let a = 0, b = 0;
    for (let k = 0; k < 3; k++) { const x = get(ymAdd(ym, -k)), y = get(ymAdd(ym, -k - 12)); if (!(x > 0) || !(y > 0)) return null; a += x; b += y; }
    return (a / b - 1) * 100;
}
export const acc3 = (get, ym) => { const a = yoy3(get, ym), b = yoy3(get, ymAdd(ym, -1)); return a == null || b == null ? null : a - b; };

/**
 * 產業組營收:同一批公司(這 3 個月與一年前同 3 個月都有營收的)加總 → 年增。⛔ 新上市公司不會把年增灌高。
 * revOf: Map(代號 → Map(ym → 營收));members: 代號陣列。回 get(ym) 用的 3 個月年增 / 加速。
 */
export function basketRevYoy3(revOf, members, ym) {
    let a = 0, b = 0, n = 0;
    for (const s of members) {
        const R = revOf.get(s); if (!R) continue;
        let x = 0, y = 0, ok = true;
        for (let k = 0; k < 3 && ok; k++) { const u = R.get(ymAdd(ym, -k)), v = R.get(ymAdd(ym, -k - 12)); if (!(u > 0) || !(v > 0)) ok = false; else { x += u; y += v; } }
        if (ok) { a += x; b += y; n++; }
    }
    return n >= 2 && b > 0 ? (a / b - 1) * 100 : null;
}

/** Newey-West 的雙尾 p(重疊窗口:抱 60 天、每月一次 → 相鄰幾個月的報酬重疊) */
export function nwP(x, lag) {
    const n = x.length; if (n < 8) return 1;
    const m = mean(x), e = x.map(v => v - m);
    let s = e.reduce((a, v) => a + v * v, 0) / n;
    for (let L = 1; L <= lag; L++) { let c = 0; for (let t = L; t < n; t++) c += e[t] * e[t - L]; s += 2 * (1 - L / (lag + 1)) * c / n; }
    return pTwo(m / Math.sqrt(Math.max(s, 1e-12) / n));
}
const lagOf = h => Math.max(0, Math.ceil(h / 21) - 1);

/** 小型最小平方法(正規方程 + 高斯消去)→ 係數;奇異回 null */
export function ols(X, y) {
    const k = X[0].length, A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
    for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b]; A[a][k] += X[i][a] * y[i]; }
    for (let c = 0; c < k; c++) {
        let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-10) return null;
        [A[c], A[p]] = [A[p], A[c]];
        for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let q = c; q <= k; q++) A[r][q] -= f * A[c][q]; }
    }
    return A.map((row, i) => row[k] / row[i]);
}

// ───────────────────────── 價格面板 ─────────────────────────
/**
 * 日曆 cal(日期陣列)上,每一檔的開高低收對齊成 Float64Array(沒交易 = NaN)+ 斷崖前綴 + 除權息因子。
 * bars: [{date, open, high, low, close}];divs: [[除權息日, 金額, 種類, 前價, 參考價]]。
 */
export function alignStock(cal, calIdx, bars, divs) {
    const T = cal.length, o = new Float64Array(T).fill(NaN), h = new Float64Array(T).fill(NaN), l = new Float64Array(T).fill(NaN), c = new Float64Array(T).fill(NaN), v = new Float64Array(T).fill(NaN);
    const cliff = new Int32Array(T + 1), divf = new Float64Array(T).fill(1);
    let prevC = NaN;
    const mark = new Uint8Array(T);
    for (const r of bars) {
        const i = calIdx.get(d10(r.date)); if (i == null) continue;
        const cc = +r.close, oo = +r.open; if (!(cc > 0)) continue;
        o[i] = oo > 0 ? oo : cc; h[i] = +r.high || cc; l[i] = +r.low || cc; c[i] = cc; v[i] = +r.volume || NaN;
        if (prevC > 0) {   // 跟「上一根有交易的」比(停牌後恢復也算一根)—— 同 lib_cliff 的門檻
            const r1 = cc / prevC, r2 = o[i] / prevC;
            if (!(r1 >= CLIFF_LO && r1 <= CLIFF_HI) || !(r2 >= CLIFF_LO && r2 <= CLIFF_HI)) mark[i] = 1;
        }
        prevC = cc;
    }
    for (let i = 0; i < T; i++) cliff[i + 1] = cliff[i] + mark[i];
    for (const dv of divs || []) {
        const i = calIdx.get(d10(dv[0])), bf = +dv[3], rf = +dv[4];
        if (i == null || !(bf > 0 && rf > 0)) continue;
        const f = bf / rf;
        if (f >= 1 && f < 1.6) divf[i] *= f;   // 除權息參考價 → 持有人拿到的價值(現金 + 配股都涵蓋);⛔ 比例怪的不猜
    }
    return { o, h, l, c, v, cliff, divf };
}

/** 一檔:第 e 天開盤買、第 x 天收盤賣(含息)報酬 %;買不到 / 斷崖 / 沒交易 → null */
export function fwdRet(S, e, x) {
    if (x >= S.c.length || !(S.o[e] > 0) || !(S.c[x] > 0)) return null;
    const pc = S.c[e - 1];
    if (pc > 0 && lockedBar(S.date ? S.date[e] : '2020-01-01', pc, S.o[e], S.h[e], S.l[e]) === 1) return null;   // 開盤一價鎖漲停:買不到
    if (S.cliff[x + 1] - S.cliff[e] > 0) return null;   // 進場那根(對前一根)到出場之間有斷崖
    let f = 1; for (let k = e + 1; k <= x; k++) f *= S.divf[k];
    return (S.c[x] * f / S.o[e] - 1) * 100;
}

/** 第 i 天收盤時,這一檔過去 n 個交易日的報酬 %(含息) */
function pastRet(S, i, n) {
    const a = S.c[i - n], b = S.c[i]; if (!(a > 0 && b > 0)) return null;
    if (S.cliff[i + 1] - S.cliff[i - n + 1] > 0) return null;
    let f = 1; for (let k = i - n + 1; k <= i; k++) f *= S.divf[k];
    return (b * f / a - 1) * 100;
}

// ───────────────────────── 建面板 ─────────────────────────
/**
 * 每個資料月 M → 決定日 i(次月 avail 日起第一個交易日)→ 每組產業:各種訊號 + 之後 h 日報酬(成員等權)。
 * W = {cal, calIdx, stocks: Map(代號 → aligned), indOf: Map(代號 → 產業), exp: Map(貨品 → Map(ym→值)), revOf}
 */
export function buildPanel(W, baskets, { from = '2010-01', to = '2099-12', avail = AVAIL_DAY } = {}) {
    const { cal } = W;
    const months = [];
    for (let ym = from; ym <= to; ym = ymAdd(ym, 1)) {
        const nx = ymAdd(ym, 1), target = `${nx}-${String(avail).padStart(2, '0')}`;
        let i = cal.findIndex(d => d >= target);
        if (i < 0) break;
        if (cal[i].slice(0, 7) !== nx) continue;   // 那個月 avail 日之後沒有交易日(不會發生,保險)
        months.push({ ym, i, d: cal[i] });
    }
    const memb = new Map(baskets.map(b => [b.k, [...W.indOf.entries()].filter(([s, ind]) => b.ind.includes(ind) && W.stocks.has(s)).map(([s]) => s)]));
    const revMemb = new Map(baskets.map(b => [b.k, [...W.indOf.entries()].filter(([, ind]) => b.ind.includes(ind)).map(([s]) => s)]));
    const panel = [];
    for (const mo of months) {
        const row = { ...mo, b: [] };
        for (const B of baskets) {
            const X = W.exp.get(B.exp);
            const gx = ym => X ? X.get(ym) : undefined;
            const gxLag = ym => X ? X.get(ymAdd(ym, -12)) : undefined;   // 🎲 安慰劑:一年前的出口
            const fw = {}, fwW = {}, nOk = {};
            // ⚖️ 第二種籃子:用決定日前 20 天的平均成交金額加權(≈ 市值大的說了算 —— 出口大宗是台積電這種大公司,等權會被小型股稀釋)
            const wOf = new Map(memb.get(B.k).map(s => { const S = W.stocks.get(s); let a = 0, n = 0; for (let k = mo.i - 19; k <= mo.i; k++) if (S.c[k] > 0 && S.v && S.v[k] > 0) { a += S.c[k] * S.v[k]; n++; } return [s, n >= 10 ? a / n : 0]; }));
            for (const H of HS) {
                const rs = []; let ws = 0, wr = 0;
                for (const s of memb.get(B.k)) { const r = fwdRet(W.stocks.get(s), mo.i + 1, mo.i + 1 + H); if (r != null) { rs.push(r); const w = wOf.get(s); if (w > 0) { ws += w; wr += w * r; } } }
                fw[H] = rs.length >= MIN_MEMB ? mean(rs) : null; nOk[H] = rs.length;
                fwW[H] = rs.length >= MIN_MEMB && ws > 0 ? wr / ws : null;
            }
            const mom = []; for (const s of memb.get(B.k)) { const r = pastRet(W.stocks.get(s), mo.i, 20); if (r != null) mom.push(r); }
            row.b.push({
                k: B.k, fw, fwW, nOk,
                expYoy: yoy3(gx, mo.ym), expAcc: acc3(gx, mo.ym), expAccOld: acc3(gxLag, mo.ym),
                revYoy: basketRevYoy3(W.revOf, revMemb.get(B.k), mo.ym),
                revAcc: (() => { const a = basketRevYoy3(W.revOf, revMemb.get(B.k), mo.ym), b = basketRevYoy3(W.revOf, revMemb.get(B.k), ymAdd(mo.ym, -1)); return a == null || b == null ? null : a - b; })(),
                mom: mom.length >= MIN_MEMB ? mean(mom) : null,
            });
        }
        panel.push(row);
    }
    return { panel, memb };
}

/** 一個挑法 × 抱幾天 → 每月「挑中的平均 − 全部組的平均」→ lib_evgate 的 inc 格式 */
export function incOf(panel, H, pick, key = 'fw') {
    const days = [], dm = [];
    for (const row of panel) {
        const ok = row.b.filter(x => x[key][H] != null);
        if (ok.length < MIN_BASKETS) continue;
        const sel = pick(ok, row); if (!sel || !sel.length) continue;
        const all = mean(ok.map(x => x[key][H]));
        days.push(row.d); dm.push(mean(sel.map(x => x[key][H])) - all);
    }
    return { n: days.length, days, dm, all: dm };
}

export const topBy = (f, n, rnd) => rows => {
    const ok = rows.filter(x => f(x) != null);
    if (ok.length < MIN_BASKETS) return null;
    return ok.slice().sort((a, b) => f(b) - f(a) || (rnd() - 0.5)).slice(0, n);
};
export const botBy = (f, n, rnd) => rows => {
    const ok = rows.filter(x => f(x) != null);
    if (ok.length < MIN_BASKETS) return null;
    return ok.slice().sort((a, b) => f(a) - f(b) || (rnd() - 0.5)).slice(0, n);
};

const failed = g => Object.entries(g.pass).filter(([, v]) => !v).map(([k]) => k.replace(/^[①-⑥]/, '')).join('、');
function gate(inc, H) {
    const g = gates(inc, COST, 6);
    g.pNW = nwP(inc.dm, lagOf(H));
    if (H > 20) { g.pass['⑥檢定'] = g.d > 0 && g.pNW <= 0.05; g.nPass = Object.values(g.pass).filter(Boolean).length; }
    return g;
}

// ───────────────────────── ④ 個股四象限 ─────────────────────────
export function quadrants(W, baskets, panel, memb) {
    // A0 / D0 = 個股條件一樣、但出口那一欄**不成立** → A − A0 才是「出口」本身的功勞(⛔ 不然量到的是營收 + 動能)
    const Q = { A: '出口↑ 營收↑ 已經漲', B: '出口↑ 營收↑ 還沒漲', C: '出口↑ 營收沒跟上', D: '出口↓ 營收↓', A0: '出口沒↑ 營收↑ 已經漲', D0: '出口沒↓ 營收↓' };
    const ev = Object.fromEntries(HS.map(H => [H, { A: [], B: [], C: [], D: [], A0: [], D0: [], base: new Map() }]));
    for (const row of panel) {
        for (const bk of row.b) {
            const up = bk.expYoy != null && bk.expAcc != null && bk.expYoy > 0 && bk.expAcc > 0;
            const dn = bk.expYoy != null && bk.expAcc != null && bk.expYoy < 0 && bk.expAcc < 0;
            const syms = memb.get(bk.k);
            const p20 = syms.map(s => pastRet(W.stocks.get(s), row.i, 20));
            const med = (() => { const a = p20.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; })();
            syms.forEach((s, j) => {
                const R = W.revOf.get(s); const g = ym => R ? R.get(ym) : undefined;
                const ry = yoy3(g, row.ym), ra = acc3(g, row.ym);
                for (const H of HS) {
                    const r = fwdRet(W.stocks.get(s), row.i + 1, row.i + 1 + H); if (r == null) continue;
                    const E = ev[H]; const b = E.base.get(row.d) || { s: 0, n: 0 }; b.s += r; b.n++; E.base.set(row.d, b);
                    if (ry == null || ra == null || p20[j] == null || med == null) continue;
                    const rUp = ry > 0 && ra > 0, rDn = ry < 0 && ra < 0;
                    if (up && rUp) (p20[j] > med ? E.A : E.B).push({ d: row.d, r });
                    else if (up && !rUp) E.C.push({ d: row.d, r });
                    else if (dn && rDn) E.D.push({ d: row.d, r });
                    if (!up && rUp && p20[j] > med) E.A0.push({ d: row.d, r });
                    if (!dn && rDn) E.D0.push({ d: row.d, r });
                }
            });
        }
    }
    return { Q, ev };
}

function incEv(events, base) {   // 同 lib_evgate.increments,base 是 {s,n}
    const by = new Map(); let n = 0;
    for (const e of events) { const b = base.get(e.d); if (!b || !b.n) continue; const a = by.get(e.d) || []; a.push(e.r - b.s / b.n); by.set(e.d, a); n++; }
    const days = [...by.keys()].sort();
    return { n, days, dm: days.map(d => mean(by.get(d))), all: [] };
}

// ───────────────────────── ②ⓑ / ③ⓐ 樣本外預測 ─────────────────────────
/** obs: [{y, x:[...], year}] → 逐年往前(只用之前年份估)→ {maeA(只用 x[0]), maeB(全部 x), nYears, better} */
export function oosCompare(obs, minTrain = 36) {
    const years = [...new Set(obs.map(o => o.year))].sort();
    let eA = 0, eB = 0, n = 0, better = 0, yrs = 0;
    const per = [];
    for (const Y of years) {
        const tr = obs.filter(o => o.year < Y), te = obs.filter(o => o.year === Y);
        if (tr.length < minTrain || !te.length) continue;
        const bA = ols(tr.map(o => [1, o.x[0]]), tr.map(o => o.y)), bB = ols(tr.map(o => [1, ...o.x]), tr.map(o => o.y));
        if (!bA || !bB) continue;
        let a = 0, b = 0;
        for (const o of te) { a += Math.abs(o.y - (bA[0] + bA[1] * o.x[0])); b += Math.abs(o.y - bB.reduce((s, c, i) => s + c * (i ? o.x[i - 1] : 1), 0)); }
        eA += a; eB += b; n += te.length; yrs++; if (b < a) better++;
        per.push({ y: Y, maeA: a / te.length, maeB: b / te.length });
    }
    return { n, maeA: eA / n, maeB: eB / n, gain: n ? (1 - eB / eA) * 100 : NaN, yrs, better, per };
}

// ───────────────────────── 主程式 ─────────────────────────
function loadWorld(env) {
    const DATA = env.DATA_DIR, REV = env.REV_DIR, TRD = env.TRADE_DIR, IDX = env.IDX_LONG;
    const miss = ['DATA_DIR', 'REV_DIR', 'TRADE_DIR', 'IDX_LONG'].filter(k => !env[k]);
    if (miss.length) { console.log(`❌ 要設 ${miss.join(' / ')}(跑法見檔頭)`); process.exit(1); }
    const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
    const tw = (idx.twii || []).map(r => d10(r[0]));
    let late = [];
    try { late = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => d10(r.date)).filter(d => d > tw[tw.length - 1]); } catch (_) {}
    const cal = [...tw, ...late];
    const calIdx = new Map(cal.map((d, i) => [d, i]));
    const tr = new Float64Array(cal.length).fill(NaN);
    for (const r of idx.twii_tr || []) { const i = calIdx.get(d10(r[0])); if (i != null) tr[i] = +r[1]; }
    const indOf = new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'))));
    const want = new Set(BASKETS.flatMap(b => b.ind));
    const divAll = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, '_div16.json'), 'utf8')).d || {}; } catch (_) { return {}; } })();
    const stocks = new Map();
    for (const [s, ind] of indOf) {
        if (!want.has(ind)) continue;
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 60) continue;
        const A = alignStock(cal, calIdx, bars, (divAll[s] || {}).h);
        A.date = cal;
        stocks.set(s, A);
    }
    const revOf = new Map();
    for (const f of fs.readdirSync(REV)) {
        if (!f.endsWith('.json.gz')) continue;
        const s = f.replace('.json.gz', '');
        try {
            const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REV, f))).toString('utf8'));
            const ci = j.c.indexOf('revenue'), cy = j.c.indexOf('revenue_year'), cm = j.c.indexOf('revenue_month');
            const m = new Map();
            for (const v of j.v || []) { const y = +v[cy], mo = +v[cm], r = +v[ci]; if (y > 1990 && mo >= 1 && mo <= 12 && r > 0) m.set(`${y}-${String(mo).padStart(2, '0')}`, r); }
            if (m.size) revOf.set(s, m);
        } catch (_) {}
    }
    const expTxt = zlib.gunzipSync(fs.readFileSync(path.join(TRD, 'raw', '8380all_0.csv.gz'))).toString('utf8');
    const E = loadExports(expTxt);
    const z = unzip(zlib.gunzipSync(fs.readFileSync(path.join(TRD, 'raw', '6099_1.bin.gz'))));
    const pick = re => { for (const [n, b] of z) if (re.test(n) && !/schema/i.test(n)) return b; return null; };
    const lead = pick(/領先指標構成項目/), light = pick(/景氣指標與燈號/);
    return { cal, calIdx, tr, indOf, stocks, revOf, exp: E.ser, expCats: E.cats, ndcLead: lead ? loadNdc(lead) : new Map(), ndcLight: light ? loadNdc(light) : new Map() };
}

function main(out) {
    const t0 = Date.now();
    const W = loadWorld(process.env);
    const lastExp = Math.max(...[...W.exp.values()].flatMap(m => [...m.keys()]).map(k => +k.replace('-', ''))).toString();
    console.log(`📦 日曆 ${W.cal[0]} ~ ${W.cal[W.cal.length - 1]}(${W.cal.length} 天)・有 K 線的成員 ${W.stocks.size} 檔・月營收 ${W.revOf.size} 檔・出口 ${W.expCats.length} 類(到 ${lastExp.slice(0, 4)}-${lastExp.slice(4)})・載入 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    const missCat = BASKETS.filter(b => !W.exp.has(b.exp));
    if (missCat.length) { console.log(`❌ 出口表頭找不到:${missCat.map(b => b.exp).join('、')} → 財政部改欄名了,先改 BASKETS`); process.exit(1); }
    const { panel, memb } = buildPanel(W, BASKETS, { from: '2010-02' });
    console.log(`🗓️ 決定日 ${panel.length} 個月(${panel[0].d} ~ ${panel[panel.length - 1].d});每組成員:` + BASKETS.map(b => `${b.k} ${memb.get(b.k).length}`).join('・'));
    const rep = { at: new Date().toISOString().slice(0, 10), window: [panel[0].d, panel[panel.length - 1].d], months: panel.length, baskets: BASKETS.map(b => ({ ...b, n: memb.get(b.k).length })), t1: [], fm: {}, lead: {}, t3: {}, t4: {} };

    // ① 挑產業
    const R = rng(20261101);
    const SIG = {
        expAcc: ['出口加速(3 個月年增 比上個月)', x => x.expAcc],
        expYoy: ['出口成長最快(3 個月年增)', x => x.expYoy],
        revAcc: ['營收加速(同批公司)', x => x.revAcc],
        revYoy: ['營收成長最快', x => x.revYoy],
        mom: ['參考:20 日價格動能', x => x.mom],
        expAccOld: ['🎲 一年前的出口加速(過時資訊)', x => x.expAccOld],
    };
    const rows = [];
    console.log('\n① 每月挑前 N 組產業 vs 同一天全部組平均(含息、扣成本前;關卡含扣 0.44)');
    for (const [k, [name, f]] of Object.entries(SIG)) for (const N of TOPS) for (const H of HS) {
        const inc = incOf(panel, H, topBy(f, N, R));
        const g = gate(inc, H);
        rows.push({ k, name, N, H, d: g.d, n: inc.n, p: H > 20 ? g.pNW : g.p, H2: g.H, YR: g.YR, dropBest: g.dropBest, nPass: g.nPass, pass: g.pass });
    }
    // ⚖️ 成交金額加權的籃子(大型股說了算)
    for (const k of ['expAcc', 'expYoy', 'revAcc', 'mom']) for (const H of HS) {
        const [name, f] = SIG[k];
        const inc = incOf(panel, H, topBy(f, 3, R), 'fwW'); const g = gate(inc, H);
        rows.push({ k: k + ':w', name: name + '(成交金額加權)', N: 3, H, d: g.d, n: inc.n, p: H > 20 ? g.pNW : g.p, H2: g.H, YR: g.YR, dropBest: g.dropBest, nPass: g.nPass, pass: g.pass });
    }
    // 底部 N 組(反向)與多空價差
    for (const k of ['expAcc', 'revAcc', 'mom']) for (const H of HS) {
        const [name, f] = SIG[k];
        const top = incOf(panel, H, topBy(f, 3, R)), bot = incOf(panel, H, botBy(f, 3, R));
        const mp = new Map(bot.days.map((d, i) => [d, bot.dm[i]]));
        const days = top.days.filter(d => mp.has(d)), dm = days.map(d => top.dm[top.days.indexOf(d)] - mp.get(d));
        const g = gate({ n: days.length, days, dm, all: dm }, H);
        rows.push({ k: k + ':ls', name: name + ' 前3 − 後3', N: 3, H, d: g.d, n: days.length, p: H > 20 ? g.pNW : g.p, H2: g.H, YR: g.YR, dropBest: g.dropBest, nPass: g.nPass, pass: g.pass });
    }
    // 出口 ∧ 動能、出口 ∧ 營收(兩個都在前一半)
    const both = (fa, fb) => rws => { const ok = rws.filter(x => fa(x) != null && fb(x) != null); if (ok.length < MIN_BASKETS) return null; const h = Math.ceil(ok.length / 2); const A = new Set(ok.slice().sort((a, b) => fa(b) - fa(a)).slice(0, h).map(x => x.k)), B = new Set(ok.slice().sort((a, b) => fb(b) - fb(a)).slice(0, h).map(x => x.k)); return ok.filter(x => A.has(x.k) && B.has(x.k)); };
    for (const H of HS) for (const [k, name, p] of [['expAcc&mom', '出口加速 ∧ 動能', both(SIG.expAcc[1], SIG.mom[1])], ['expAcc&revAcc', '出口加速 ∧ 營收加速', both(SIG.expAcc[1], SIG.revAcc[1])], ['revAcc&mom', '營收加速 ∧ 動能', both(SIG.revAcc[1], SIG.mom[1])]]) {
        const inc = incOf(panel, H, p); const g = gate(inc, H);
        rows.push({ k, name, N: 0, H, d: g.d, n: inc.n, p: H > 20 ? g.pNW : g.p, H2: g.H, YR: g.YR, dropBest: g.dropBest, nPass: g.nPass, pass: g.pass });
    }
    const q = bhQ(rows.map(r => r.p)); rows.forEach((r, i) => { r.q = q[i]; });
    // 安慰劑:每月隨機挑 3 組 × SHAM_N 次 → 全期平均的分布
    const shamQ = {};
    for (const H of HS) {
        const R2 = rng(7 + H), dist = [];
        for (let t = 0; t < SHAM_N; t++) dist.push(mean(incOf(panel, H, rws => rws.slice().sort(() => R2() - 0.5).slice(0, 3)).dm));
        dist.sort((a, b) => a - b);
        shamQ[H] = { p05: dist[Math.floor(SHAM_N * 0.05)], p50: dist[Math.floor(SHAM_N * 0.5)], p95: dist[Math.floor(SHAM_N * 0.95)] };
    }
    for (const r of rows.filter(x => x.N === 3 || x.N === 0)) {
        const s = shamQ[r.H];
        console.log(`  ${(r.name + (r.N ? ` 前${r.N}` : '')).padEnd(30)} ${String(r.H).padStart(2)}日 ${sg(r.d).padStart(6)}pp n=${String(r.n).padStart(3)} p=${r.p.toFixed(3)} q=${r.q.toFixed(2)} 前/後半 ${sg(r.H2[0])}/${sg(r.H2[1])} 年正 ${r.YR.filter(y => y.d > 0).length}/${r.YR.length} → ${r.nPass}/6${r.nPass < 6 ? ' 沒過:' + Object.entries(r.pass).filter(([, v]) => !v).map(([k]) => k.slice(1)).join('、') : ''}${r.d > s.p95 ? '' : '・沒贏過隨機 95%'}`);
    }
    console.log('  🎲 每月隨機挑 3 組(' + SHAM_N + ' 次)全期平均 5% / 50% / 95%:' + HS.map(H => `${H}日 ${sg(shamQ[H].p05)}/${sg(shamQ[H].p50)}/${sg(shamQ[H].p95)}`).join(' ・'));
    // 高原:出口加速 × 前 N 組 × 天數
    const plat = HS.map(H => TOPS.map(N => rows.find(r => r.k === 'expAcc' && r.N === N && r.H === H).d));
    console.log('  📐 出口加速 高原(前 2/3/4/5 組):' + HS.map((H, i) => `${H}日 ` + plat[i].map(sg).join(' ')).join(' ・'));
    rep.t1 = rows; rep.sham = shamQ;

    // ①' 對加權報酬指數(含息):出口加速前 3 組的絕對超額
    const vsTr = HS.map(H => {
        const a = [];
        for (const row of panel) {
            const ok = row.b.filter(x => x.fw[H] != null); const sel = topBy(SIG.expAcc[1], 3, R)(ok); if (!sel) continue;
            const t0i = W.tr[row.i], t1i = W.tr[row.i + 1 + H]; if (!(t0i > 0 && t1i > 0)) continue;
            a.push(mean(sel.map(x => x.fw[H])) - (t1i / t0i - 1) * 100);
        }
        return { H, n: a.length, d: mean(a) };
    });
    console.log('  📏 出口加速前 3 組 − 加權報酬指數(含息,≈ 0050 含息):' + vsTr.map(v => `${v.H}日 ${sg(v.d)}pp(n=${v.n})`).join(' ・'));
    rep.vsTr = vsTr;

    // ②ⓐ Fama-MacBeth:之後 20 / 60 日 ~ 出口加速 + 營收加速 + 動能(每月橫切面 z 分數)
    console.log('\n②ⓐ 每月橫切面迴歸(三個一起放):係數 = 那個指標高 1 個標準差的組,之後多幾 pp');
    for (const H of [20, 60]) {
        const co = [[], [], []];
        for (const row of panel) {
            const ok = row.b.filter(x => x.fw[H] != null && x.expAcc != null && x.revAcc != null && x.mom != null);
            if (ok.length < MIN_BASKETS) continue;
            const z = f => { const v = ok.map(f), m = mean(v), s = Math.sqrt(mean(v.map(x => (x - m) ** 2))) || 1; return v.map(x => (x - m) / s); };
            const ze = z(x => x.expAcc), zr = z(x => x.revAcc), zm = z(x => x.mom), m = mean(ok.map(x => x.fw[H]));
            const b = ols(ok.map((_, i) => [1, ze[i], zr[i], zm[i]]), ok.map(x => x.fw[H] - m));
            if (b) { co[0].push(b[1]); co[1].push(b[2]); co[2].push(b[3]); }
        }
        const res = ['出口加速', '營收加速', '20 日動能'].map((nm, j) => ({ nm, b: mean(co[j]), p: nwP(co[j], lagOf(H)), n: co[j].length }));
        console.log(`  ${H}日:` + res.map(r => `${r.nm} ${sg(r.b)}pp(p=${r.p.toFixed(3)})`).join(' ・') + `(${res[0].n} 個月)`);
        rep.fm[H] = res;
    }

    // ②ⓑ 基本面領先:下個月產業營收年增(單月)~ 這個月營收年增 + 這個月出口年增
    const obs = [];
    for (const B of BASKETS) {
        const X = W.exp.get(B.exp), mem = [...W.indOf.entries()].filter(([, ind]) => B.ind.includes(ind)).map(([s]) => s);
        const y1 = ym => { let a = 0, b = 0, n = 0; for (const s of mem) { const R0 = W.revOf.get(s); if (!R0) continue; const u = R0.get(ym), v = R0.get(ymAdd(ym, -12)); if (u > 0 && v > 0) { a += u; b += v; n++; } } return n >= 2 ? (a / b - 1) * 100 : null; };
        for (let ym = '2010-02'; ym <= '2026-08'; ym = ymAdd(ym, 1)) {
            const yt = y1(ymAdd(ym, 1)), r0 = y1(ym), x0 = X.get(ym), xl = X.get(ymAdd(ym, -12));
            if (yt == null || r0 == null || !(x0 > 0 && xl > 0)) continue;
            obs.push({ y: yt, x: [r0, (x0 / xl - 1) * 100], year: +ym.slice(0, 4) });
        }
    }
    const lead = oosCompare(obs.map(o => ({ ...o, y: Math.max(-80, Math.min(200, o.y)), x: o.x.map(v => Math.max(-80, Math.min(200, v))) })));
    console.log(`\n②ⓑ 用這個月的出口年增,預測下個月的產業營收年增(逐年往前、樣本外 ${lead.n} 筆 / ${lead.yrs} 年):`);
    console.log(`   只用營收 MAE ${lead.maeA.toFixed(2)}pp → 加上出口 ${lead.maeB.toFixed(2)}pp(誤差少 ${sg(lead.gain)}%,${lead.better}/${lead.yrs} 年較準)`);
    rep.lead = lead;

    // ③ 國發會:外銷訂單動向指數 / 名目半導體設備進口
    const ord = W.ndcLead.get('外銷訂單動向指數(以家數計)') || new Map(), semi = W.ndcLead.get('名目半導體設備進口(新臺幣百萬元)') || new Map();
    const ordKeys = [...ord.keys()].sort();
    console.log(`\n③ 國發會:外銷訂單動向指數 ${ordKeys[0] || '—'} ~ ${ordKeys[ordKeys.length - 1] || '—'}(${ord.size} 個月)・半導體設備進口 ${semi.size} 個月`);
    // ⓐ 動向指數 → 之後 1~3 個月全體營收年增(單月;同一批公司)
    const allMem = [...W.revOf.keys()];
    const yAll = ym => { let a = 0, b = 0; for (const s of allMem) { const R0 = W.revOf.get(s), u = R0.get(ym), v = R0.get(ymAdd(ym, -12)); if (u > 0 && v > 0) { a += u; b += v; } } return b > 0 ? (a / b - 1) * 100 : null; };
    const yAllMemo = new Map(); const yA = ym => { if (!yAllMemo.has(ym)) yAllMemo.set(ym, yAll(ym)); return yAllMemo.get(ym); };
    rep.t3.revenue = [];
    for (const k of [1, 2, 3]) {
        const ob = [];
        for (let ym = '2010-02'; ym <= '2026-08'; ym = ymAdd(ym, 1)) {
            // 動向指數 M 在 M+1 月 28 日才算知道 → 那時已知的營收是 M(M+1 月 10 日公布)→ 預測 M+k
            const o = ord.get(ym), r0 = yA(ym), yt = yA(ymAdd(ym, k)); if (o == null || r0 == null || yt == null) continue;
            ob.push({ y: yt, x: [r0, o], year: +ym.slice(0, 4) });
        }
        const r = oosCompare(ob, 24);
        rep.t3.revenue.push({ k, ...r });
        console.log(`  ⓐ 預測 ${k} 個月後全體營收年增:只用營收 MAE ${r.maeA.toFixed(2)} → 加動向指數 ${r.maeB.toFixed(2)}(誤差少 ${sg(r.gain)}%,${r.better}/${r.yrs} 年較準,n=${r.n})`);
    }
    // ⓑ 動向指數變化 → 之後加權報酬指數(減同一年所有決定日的平均 = 拿掉那一年的大盤方向)
    //   ⭐ 國發會的數字次月 28 日才算知道 → 另建一份「28 日決定」的面板(⛔ 借用 11 日那份的報酬 = 前視 17 天)
    const { panel: pN } = buildPanel(W, BASKETS, { from: '2010-02', avail: AVAIL_NDC });
    rep.t3.market = [];
    for (const [nm, sig] of [['動向指數比上個月升', ym => { const a = ord.get(ym), b = ord.get(ymAdd(ym, -1)); return a == null || b == null ? null : a - b; }],
        ['動向指數 ≥ 50(看好的家數比較多)', ym => { const a = ord.get(ym); return a == null ? null : a - 50; }]]) {
        for (const H of [20, 60]) {
            const rowsY = new Map();
            for (const row of pN) {
                const t0i = W.tr[row.i], t1i = W.tr[row.i + H]; if (!(t0i > 0 && t1i > 0)) continue;   // 指數只用收盤 → 收盤到收盤(陷阱 #47)
                const s = sig(row.ym); if (s == null) continue;
                const y = row.d.slice(0, 4); (rowsY.get(y) || rowsY.set(y, []).get(y)).push({ d: row.d, r: (t1i / t0i - 1) * 100, on: s > 0 });
            }
            const days = [], dm = [];
            for (const [, a] of rowsY) { const m = mean(a.map(x => x.r)); for (const x of a) if (x.on) { days.push(x.d); dm.push(x.r - m); } }
            const ord2 = days.map((d, i) => [d, dm[i]]).sort((a, b) => a[0] < b[0] ? -1 : 1);
            const g = gate({ n: ord2.length, days: ord2.map(x => x[0]), dm: ord2.map(x => x[1]), all: [] }, H);
            rep.t3.market.push({ nm, name: nm, H, d: g.d, n: g.n, p: H > 20 ? g.pNW : g.p, nPass: g.nPass, YR: g.YR });
            console.log(`  ⓑ ${nm.padEnd(22)} 之後 ${H} 日加權含息 比同年平均 ${sg(g.d)}pp n=${g.n} p=${(H > 20 ? g.pNW : g.p).toFixed(3)} → ${g.nPass}/6`);
        }
    }
    // ⓒ 半導體設備進口加速 → 電子零組件組 vs 全部組(28 日決定);再減「電子組同一年的平均相對報酬」
    //    (⛔ 不減的話量到的是「這 16 年電子本來就比較強」,不是設備進口的功勞)
    rep.t3.semi = [];
    for (const H of [20, 60]) {
        const byY = new Map();
        for (const row of pN) {
            const elecRow = row.b.find(x => x.k === 'elec'), all = row.b.filter(x => x.fw[H] != null);
            if (!elecRow || elecRow.fw[H] == null || all.length < MIN_BASKETS) continue;
            const a = acc3(ym => semi.get(ym), row.ym);
            const y = row.d.slice(0, 4); (byY.get(y) || byY.set(y, []).get(y)).push({ d: row.d, v: elecRow.fw[H] - mean(all.map(x => x.fw[H])), on: a != null && a > 0 });
        }
        const pairs = [];
        for (const [, a] of byY) { const m = mean(a.map(x => x.v)); for (const x of a) if (x.on) pairs.push([x.d, x.v - m]); }
        pairs.sort((a, b) => a[0] < b[0] ? -1 : 1);
        const days = pairs.map(x => x[0]), dm = pairs.map(x => x[1]);
        const g = gate({ n: days.length, days, dm, all: [] }, H);
        rep.t3.semi.push({ name: '半導體設備進口加速 → 電子組', H, d: g.d, n: g.n, p: H > 20 ? g.pNW : g.p, nPass: g.nPass });
        console.log(`  ⓒ 半導體設備進口加速的月份,電子零組件組之後 ${H} 日 比全部組 ${sg(g.d)}pp n=${g.n} → ${g.nPass}/6`);
    }

    // ④ 個股四象限
    console.log('\n④ 個股四象限(減同一天、這幾組產業的全部股票;含息)');
    const { Q, ev } = quadrants(W, BASKETS, panel, memb);
    for (const H of HS) {
        rep.t4[H] = {};
        for (const qk of ['A', 'B', 'C', 'D', 'A0', 'D0']) {
            const inc = incEv(ev[H][qk], ev[H].base); const g = gate(inc, H);
            rep.t4[H][qk] = { name: Q[qk], H, d: g.d, n: inc.n, p: H > 20 ? g.pNW : g.p, H2: g.H, YR: g.YR, nPass: g.nPass };
            rep.t4[H][qk].pass = g.pass;
            console.log(`  ${qk.padEnd(2)} ${Q[qk].padEnd(12)} ${String(H).padStart(2)}日 ${sg(g.d).padStart(6)}pp 筆數 ${String(inc.n).padStart(6)}(${inc.days.length} 個月)p=${(H > 20 ? g.pNW : g.p).toFixed(3)} 前/後半 ${sg(g.H[0])}/${sg(g.H[1])} 年正 ${g.YR.filter(y => y.d > 0).length}/${g.YR.length} → ${g.nPass}/6${g.nPass < 6 ? ' 沒過:' + failed(g) : ''}`);
        }
        for (const [x, y, nm] of [['A', 'A0', 'A − A0(出口本身的功勞:個股一樣是營收↑已經漲)'], ['D', 'D0', 'D − D0(出口本身的功勞:個股一樣是營收↓)']]) {
            const ix = incEv(ev[H][x], ev[H].base), iy = incEv(ev[H][y], ev[H].base), my = new Map(iy.days.map((d, i) => [d, iy.dm[i]]));
            const dd = ix.days.filter(d => my.has(d)), dm = dd.map(d => ix.dm[ix.days.indexOf(d)] - my.get(d));
            const g = gate({ n: dd.length, days: dd, dm, all: [] }, H);
            rep.t4[H][x + '-' + y] = { d: g.d, n: dd.length, p: H > 20 ? g.pNW : g.p, nPass: g.nPass };
            console.log(`    ${nm} ${sg(g.d)}pp(${dd.length} 個月)p=${(H > 20 ? g.pNW : g.p).toFixed(3)}`);
        }
        const a = incEv(ev[H].A, ev[H].base), b = incEv(ev[H].B, ev[H].base), mp = new Map(a.days.map((d, i) => [d, a.dm[i]]));
        const dd = b.days.filter(d => mp.has(d)), dm = dd.map(d => b.dm[b.days.indexOf(d)] - mp.get(d));
        const g = gate({ n: dd.length, days: dd, dm, all: [] }, H);
        rep.t4[H].BminusA = { d: g.d, n: dd.length, p: H > 20 ? g.pNW : g.p };
        console.log(`    B − A(還沒漲 減 已經漲)${sg(g.d)}pp(${dd.length} 個月)p=${(H > 20 ? g.pNW : g.p).toFixed(3)}`);
    }
    // 📊 全部檢定一起 BH(①②③④ 同一個家族;⛔ 分開校正會讓「試很多次總有一個中」溜過去)
    const fam = [...rep.t1.map(r => ({ r, p: r.p })), ...rep.t3.market.map(r => ({ r, p: r.p })), ...rep.t3.semi.map(r => ({ r, p: r.p })),
        ...HS.flatMap(H => ['A', 'B', 'C', 'D'].map(qk => ({ r: rep.t4[H][qk], p: rep.t4[H][qk].d > 0 ? rep.t4[H][qk].p : 1 })))];
    const qa = bhQ(fam.map(x => x.p)); fam.forEach((x, i) => { x.r.qAll = qa[i]; });
    const sig = fam.filter(x => x.r.qAll <= 0.05);
    console.log(`\n📊 全部 ${fam.length} 個檢定一起 BH:q ≤ 0.05 有 ${sig.length} 個 → ` + sig.map(x => `${x.r.name}${x.r.N ? ' 前' + x.r.N : ''}${x.r.H ? ' ' + x.r.H + '日' : ''}(${sg(x.r.d)})`).join('、'));
    console.log('\n⚠️ 產業別用現在的分類(下市股沒有產業別)・出口 / 國發會是修正後數字・出口美元 vs 營收台幣・⛔ 探針不是測試(exit 0)');
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    if (out) { fs.writeFileSync(out, JSON.stringify(rep, null, 1)); console.log(`💾 ${out}`); }
}

// ───────────────────────── selftest ─────────────────────────
function selftest() {
    let bad = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) bad++; };
    // ① 財政部 CSV:民國月份、年度列不收、欄名去掉前綴
    const csv = '﻿"幣別","按美元計算(百萬美元)/ 總計","按美元計算(百萬美元)/ (1)電子零組件"\n"114年",100,50\n"114年 1月",10,5\n"115年 9月",87222.162,31131.036\n';
    const E = loadExports(csv);
    ok(E.cats.join('|') === '總計|(1)電子零組件' && E.ser.get('(1)電子零組件').get('2026-09') === 31131.036 && !E.ser.get('總計').has('2025-00') && E.ser.get('總計').size === 2,
        '① 財政部 CSV:民國月份 → 西元、年度列不收、欄名去前綴');
    ok(ymAdd('2026-01', -1) === '2025-12' && ymAdd('2025-12', 1) === '2026-01' && ymAdd('2026-03', -15) === '2024-12', '② 月份加減跨年');
    // ③ 同一批公司的產業營收:新上市那家(一年前沒有)⛔ 算進來
    const revOf = new Map([['A', new Map()], ['B', new Map()], ['N', new Map()]]);
    for (const ym of ['2025-07', '2025-08', '2025-09', '2026-07', '2026-08', '2026-09']) { revOf.get('A').set(ym, 100); revOf.get('B').set(ym, ym < '2026' ? 100 : 110); }
    for (const ym of ['2026-07', '2026-08', '2026-09']) revOf.get('N').set(ym, 10000);
    ok(Math.abs(basketRevYoy3(revOf, ['A', 'B', 'N'], '2026-09') - 5) < 1e-9, '③ 產業營收年增只算同一批公司(新上市 ⛔ 灌高:+5%,不是 +5000%)');
    // ④ ZIP 讀取(Python 那邊寫的同一種格式:deflate)
    const zipBuf = (() => {
        const files = [['景氣指標與燈號.csv', Buffer.from('Date,景氣對策信號綜合分數\n202608,40\n202609,41\n')]];
        const parts = [], cd = []; let off = 0;
        for (const [nm, data] of files) {
            const comp = zlib.deflateRawSync(data), nb = Buffer.from(nm, 'utf8');
            const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
            parts.push(lh, nb, comp);
            const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
            cd.push(c, nb); off += 30 + nb.length + comp.length;
        }
        const cdb = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
        return Buffer.concat([...parts, cdb, end]);
    })();
    const zz = unzip(zipBuf), nd = loadNdc(zz.get('景氣指標與燈號.csv'));
    ok(nd.get('景氣對策信號綜合分數').get('2026-09') === 41, '④ ZIP(deflate)解得開、國發會 Date=202609 → 2026-09');
    // ⑤ 合成世界:8 組產業 × 6 檔 × 12 年;每月隨機一組「出口加速」→ 那組之後 20 天每天 +0.25%
    const mk = ({ inject = 'after', trend = 0 } = {}) => {
        const R = rng(99), cal = []; let d = new Date(Date.UTC(2011, 0, 3));
        while (cal.length < 3200) { if (d.getUTCDay() % 6) cal.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
        const calIdx = new Map(cal.map((x, i) => [x, i]));
        const BK = Array.from({ length: 8 }, (_, j) => ({ k: 'b' + j, n: 'b' + j, exp: 'E' + j, ind: [String(10 + j)] }));
        // 出口 = 隨機漫步的底 × (那個月被抽中 → ×1.3,只有那一個月;⛔ 墊高之後一直留著 —— 那樣後面兩個月的「加速」也會是正的,分不出是誰)
        const exp = new Map(BK.map(b => [b.exp, new Map()])), hot = new Map(), lvl = BK.map(() => 100);
        for (let ym = '2010-01'; ym <= '2023-12'; ym = ymAdd(ym, 1)) {
            const h = Math.floor(R() * 8); hot.set(ym, h);
            BK.forEach((b, j) => { lvl[j] *= 0.99 + R() * 0.02; exp.get(b.exp).set(ym, lvl[j] * (j === h ? 1.3 : 1)); });
        }
        const indOf = new Map(), stocks = new Map(), revOf = new Map();
        BK.forEach((b, j) => {
            for (let q = 0; q < 6; q++) {
                const s = `${b.ind[0]}${q}`; indOf.set(s, b.ind[0]);
                const bars = []; let p = 50;
                for (let i = 0; i < cal.length; i++) {
                    const dd = cal[i], ym0 = dd.slice(0, 7), dom = +dd.slice(8, 10);
                    const dm = ymAdd(ym0, -1);   // 這個月 11 日之後才知道「上個月」誰出口加速
                    let drift = trend;
                    if (inject === 'after' && hot.get(dm) === j && dom >= 13) drift += 0.0025;
                    if (inject === 'before' && hot.get(dm) === j && dom <= 9) drift += 0.0025;   // 公布前就漲完 → 決定日之後 ⛔ 該量到
                    p *= 1 + drift + (R() - 0.5) * 0.01;
                    bars.push({ date: dd, open: p, high: p * 1.002, low: p * 0.998, close: p });
                }
                const A = alignStock(cal, calIdx, bars, []); A.date = cal; stocks.set(s, A);
                const rm = new Map(); for (let ym = '2010-01'; ym <= '2023-12'; ym = ymAdd(ym, 1)) rm.set(ym, 100); revOf.set(s, rm);
            }
        });
        return { W: { cal, calIdx, stocks, indOf, exp, revOf }, BK };
    };
    {
        const { W, BK } = mk();
        const { panel } = buildPanel(W, BK, { from: '2011-02', to: '2023-06' });
        const R = rng(5);
        const g = gates(incOf(panel, 20, topBy(x => x.expAcc, 1, R)), COST, 6), sh = mean(incOf(panel, 20, rws => rws.slice().sort(() => R() - 0.5).slice(0, 1)).dm);
        ok(g.d > 1.0 && g.nPass >= 5, `⑤ 注入「出口加速那組之後會漲」→ 量得到(+${g.d.toFixed(2)}pp、${g.nPass}/6;⚠️ 一年前同月有尖峰的那組也會「加速」,所以不是每次都挑對)`);
        ok(Math.abs(sh) < 0.8, `⑥ 安慰劑(每月隨機一組)≈ 0(${sh.toFixed(2)}pp)`);
    }
    {
        const { W, BK } = mk({ inject: 'before' });
        const { panel } = buildPanel(W, BK, { from: '2011-02', to: '2023-06' });
        const d = mean(incOf(panel, 20, topBy(x => x.expAcc, 1, rng(5))).dm);
        ok(Math.abs(d) < 0.8, `⑦ 前視決定性對照:漲在公布前(1~9 日)→ 11 日之後才進場 ⛔ 量得到(${d.toFixed(2)}pp)`);
    }
    {
        const { W, BK } = mk({ inject: 'none', trend: 0.002 });
        const { panel } = buildPanel(W, BK, { from: '2011-02', to: '2023-06' });
        const d = mean(incOf(panel, 20, topBy(x => x.expAcc, 2, rng(5))).dm);
        ok(Math.abs(d) < 0.6, `⑧ 全部一起漲(大盤多頭)→ 減同一天全部組 ≈ 0(${d.toFixed(2)}pp)`);
    }
    // ⑨ 開盤一價鎖漲停買不到;除權息那天跌的那段算回來;斷崖窗口不算
    {
        const cal = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07'], ci = new Map(cal.map((d, i) => [d, i]));
        const lock = alignStock(cal, ci, [{ date: cal[0], open: 10, high: 10, low: 10, close: 10 }, { date: cal[1], open: 11, high: 11, low: 11, close: 11 }, { date: cal[2], open: 11.5, high: 12, low: 11, close: 12 }], []); lock.date = cal;
        const div = alignStock(cal, ci, [{ date: cal[0], open: 10, high: 10, low: 10, close: 10 }, { date: cal[1], open: 10, high: 10, low: 10, close: 10 }, { date: cal[2], open: 9.5, high: 9.5, low: 9.5, close: 9.5 }], [[cal[2], 0.5, '息', 10, 9.5]]); div.date = cal;
        const cl = alignStock(cal, ci, [{ date: cal[0], open: 10, high: 10, low: 10, close: 10 }, { date: cal[1], open: 10, high: 10, low: 10, close: 10 }, { date: cal[2], open: 20, high: 20, low: 20, close: 20 }], []); cl.date = cal;
        ok(fwdRet(lock, 1, 2) === null && Math.abs(fwdRet(div, 1, 2)) < 1e-9 && fwdRet(cl, 1, 2) === null,
            '⑨ 開盤鎖漲停 → 買不到;除息 0.5 元那天跌 5% → 含息報酬 0;窗口裡 ×2 斷崖 → 不算');
    }
    // ⑩ 樣本外:y = 2x₂ + 雜訊 → 加 x₂ 誤差變小;x₂ 是雜訊 → 不會變小很多
    {
        const R = rng(3), o1 = [], o2 = [];
        for (let i = 0; i < 400; i++) { const a = R() * 10, b = R() * 10, n = (R() - 0.5); o1.push({ y: a + 2 * b + n, x: [a, b], year: 2010 + Math.floor(i / 25) }); o2.push({ y: a + n, x: [a, R() * 10], year: 2010 + Math.floor(i / 25) }); }
        const r1 = oosCompare(o1), r2 = oosCompare(o2);
        ok(r1.gain > 50 && r2.gain < 5, `⑩ 樣本外比較:有用的變數誤差少 ${r1.gain.toFixed(0)}%、雜訊 ${r2.gain.toFixed(1)}%`);
    }
    // ⑪ Newey-West:同一串數字重複 3 次(重疊)→ p 比 iid 大
    {
        const R = rng(11), x = []; for (let i = 0; i < 120; i++) { const v = R() - 0.45; x.push(v, v, v); }
        const m = mean(x), sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)), pIid = pTwo(m / (sd / Math.sqrt(x.length)));
        ok(nwP(x, 2) > pIid, `⑪ 重疊窗口用 Newey-West:p ${nwP(x, 2).toFixed(4)} > 當成獨立的 ${pIid.toFixed(4)}`);
    }
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過');
    process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else if (process.argv.includes('--help')) console.log('用法:DATA_DIR=<d16> REV_DIR=<stock_deep/rev> TRADE_DIR=<trade_deep> IDX_LONG=<idx_long.json> node scripts/trade_lead_probe.mjs out.json\n      node scripts/trade_lead_probe.mjs --selftest');
else main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
