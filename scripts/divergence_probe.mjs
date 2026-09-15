#!/usr/bin/env node
/**
 * 🔀 多空分歧探針(V77.1.2)—— 「基本面強、股價弱、法人偏空」這種**背離**到底有沒有用?
 *
 * 來源:評估紀錄㉗(外部 AI 對報告頁的 22 點評論)的**真缺口 C**。
 *   他說:「AI 最不該做的事是把複雜市場壓成一個買賣答案,它應該告訴你哪裡有衝突。」
 *   ⭐ 「把衝突講出來」這件事本身沒問題(本站的 `_chipAnalystLine` 的 `clashNote` 已經在做);
 *   🚨 但他進一步建議把它當成**訊號**(「這種狀態比全部向上更值得觀察」)——
 *      **那一句沒有任何實測背書**,而本站既有的證據**方向剛好相反**:
 *        ・`pe_probe`「本益比低會漲」→ **單調反向**
 *        ・`screener_edge_probe` 127 條的總結 → **追強 > 抄底**
 *      → ⛔ 先回測,六關過了才准顯示成訊號;沒過就只留「描述」。
 *
 * ── 四個面向怎麼來(⛔ 全部用**採礦產物**重建歷史,⛔ 不用前端算好的 `_lastGauge`)──
 *   技術   = 近 20 日報酬
 *   籌碼   = 近 20 日(外資+投信)淨買 ÷ 近 20 日成交量
 *   基本面 = 最近**已公布**那一季的 EPS 年增(跟去年同季比)
 *   估值   = 收盤 ÷ TTM EPS(最近 4 個已公布季)→ **反向**(便宜 = 分數高)
 *   四個都走**自己過去的 expanding 分位**(⛔ 不寫死門檻、⛔ 不用含未來的整檔排序)
 *
 *   分歧度 = max(四個分位) − min(四個分位)  → 0~1,越大越「各說各話」
 *   另外兩個**方向性**桶(他講的那一種):
 *     🧬強價弱 = 基本面分位 ≥0.70 且 技術分位 ≤0.30
 *     🧬弱價強 = 基本面分位 ≤0.30 且 技術分位 ≥0.70
 *
 * 🚨 三個一定要守住的方法論(每一條都是本 repo 踩過的坑)
 *   ・**前視偏誤**:財報一律用檔內的 `pub`(法定最晚公布日)判「那一天知不知道」——
 *     保守但安全;條件用 t 日收盤後才知道的資料,進場用 **t+1 開盤**。
 *   ・**基準區間 ⛔ 不含被判斷的那幾根**(陷阱 #43):20 日報酬用 `c[t]/c[t-20]`、
 *     expanding 分位比的是 `past = hist.slice(0, -1)`。
 *   ・**對照組 = 四個分數都算得出來的所有(股·日)**,⛔ 不是全市場 ——
 *     否則量到的是「有財報切片的股票」本身(同 `sector_pick_probe` 的教訓)。
 *
 * ⛔ 六道關卡:①全期 ②前後半同向 ③逐年同向 ④去最好年 ⑤扣成本 0.44% ⑥檢定 p≤0.05
 *    + 第七關「買得到嗎」(排除 t+1 開盤漲停 + 20 日均額 ≥3,000 萬)
 *    + 🔬 門檻高原檢定(分歧度門檻左右各挪 → 是一片高原還是一根孤峰)
 *
 * ⚠️ 已知限制(⛔ 報告裡不可省)
 *   ・窗口 = `data/fin/` 的 12 季 ≈ 3 年 → **不含 2022 空頭**,逐年那關只驗得到 2023~2026。
 *   ・倖存者偏誤:已下市的不在 `data/` 裡。
 *   ・虧損股沒有 TTM PE → 估值那一格算不出來 → 整檔那些日子不進樣本(要印出擋掉幾筆)。
 *   ・報酬扣同期加權指數;⛔ 不含股利。
 *
 * 🚧 `--selftest` 的**盲區**(⛔ 不可讀成「全部驗過了」)
 *   ・叫得出來的:前視偏誤(進場改 t 日收盤)・expanding 分位含今日・檢定失靈。
 *   ・⛔ 叫不出來的:20 日去重(合成資料的觸發日本來就疏)、`pub` 的正確性。
 *
 * ⛔ 只讀,不打 API、不寫任何會被部署的產物。exit 0(探針,不進四驗證)。
 *
 * 用法:
 *   node --max-old-space-size=4096 scripts/divergence_probe.mjs [輸出.json]
 *   node scripts/divergence_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const FIN = process.env.FIN_DIR || path.join(DATA, 'fin');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';

const COST = 0.44;
const HOLDS = [5, 10, 20];
const HI = 2;             // 主要看 20 日
const DEDUP = 20;
const MIN_EV = 400;
const WIN = 20;           // 技術/籌碼的窗口
const EXP_MIN = 120;      // expanding 分位至少累積幾筆
const LIQ_MIN = 3e7;
const LIMIT_UP = 1.095;
const MAX_SYMS = +process.env.MAX_SYMS || 99999;

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
};
const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);

// ═══════════ 桶 ═══════════
const BASE = 'ALL4';      // 對照組:四個分數都算得出來的所有(股·日)
const DIV_BUCKETS = [
    ['分歧 0~25%',   q => q <= 0.25],
    ['分歧 25~50%',  q => q > 0.25 && q <= 0.50],
    ['分歧 50~75%',  q => q > 0.50 && q <= 0.75],
    ['分歧 75~100%', q => q > 0.75],
];
// 🔬 門檻高原檢定:分歧度的**絕對**門檻左右各挪(⛔ 只有某一格好 = 孤峰)
const DIV_PLATEAU = [0.40, 0.50, 0.60, 0.70, 0.80].map(th => [`  └ 分歧度 ≥${th.toFixed(2)}`, (q, raw) => raw >= th]);
const DIR_BUCKETS = [
    ['🧬強價弱(基本面≥70 技術≤30)', (fq, tq) => fq >= 0.70 && tq <= 0.30],
    ['🧬弱價強(基本面≤30 技術≥70)', (fq, tq) => fq <= 0.30 && tq >= 0.70],
    ['🧬同向強(兩個都≥70)',         (fq, tq) => fq >= 0.70 && tq >= 0.70],
    ['🧬同向弱(兩個都≤30)',         (fq, tq) => fq <= 0.30 && tq <= 0.30],
];

const mk = () => HOLDS.map(() => ({ n: 0, s: 0, ss: 0 }));
const ACC = new Map();
const SKIP = { limitUp: 0, illiquid: 0, noFin: 0, noPE: 0, shortHist: 0 };
function bump(b, y, half, rets) {
    let a = ACC.get(b);
    if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()] }; ACC.set(b, a); }
    let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
    for (let i = 0; i < HOLDS.length; i++) {
        const v = rets[i]; if (v === null) continue;
        for (const t of [a.all[i], yy[i], a.byHalf[half][i]]) { t.n++; t.s += v; t.ss += v * v; }
    }
}
const stat = t => t.n ? { n: t.n, m: t.s / t.n, v: Math.max(0, t.ss / t.n - (t.s / t.n) ** 2) } : { n: 0, m: 0, v: 0 };
const margin = (a, b) => {
    const A = stat(a), B = stat(b);
    if (!A.n || !B.n) return { n: A.n, d: 0, z: 0, p: 1 };
    const se = Math.sqrt(A.v / A.n + B.v / B.n);
    const z = se > 0 ? (A.m - B.m) / se : 0;
    return { n: A.n, d: A.m - B.m, z, p: pTwoSided(z) };
};
// expanding 分位 —— ⛔ `past` 不含今日那一筆(陷阱 #43)
const expQ = (hist, cur) => {
    const past = hist.length > 1 ? hist.slice(0, -1) : [];
    if (past.length < EXP_MIN) return null;
    let s = 0; for (const v of past) if (v < cur) s++;
    return s / past.length;
};

// ═══════════ 大盤日曆 ═══════════
function loadTwii() {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
        .map(r => ({ d: nd(r.date), c: +r.close }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
        .sort((a, b) => a.d < b.d ? -1 : 1);
    return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])) };
}

// ═══════════ 財報:把「那一天知道哪一季」攤平成逐日 ═══════════
//  ⛔ 一律用 `pub`(法定最晚公布日)—— 保守,⛔ 不可用季別自己推日期(那會提早知道)
function finTimeline(sym) {
    let F;
    try { F = JSON.parse(fs.readFileSync(path.join(FIN, `${sym}.json`), 'utf8')); } catch (_) { return null; }
    const q = Array.isArray(F && F.q) ? F.q : [];
    if (q.length < 6) return null;
    const rows = q.map(x => ({ p: String(x.p || ''), pub: nd(x.pub || ''), eps: Number.isFinite(+x.eps) ? +x.eps : null }))
        .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.pub))
        .sort((a, b) => a.pub < b.pub ? -1 : 1);
    return rows.length >= 6 ? rows : null;
}

// ═══════════ 逐檔掃 ═══════════
function scanSymbol(sym, rows, TW, halfCut, dateTally, finRows) {
    const n = rows.length;
    if (n < WIN + 40) return 0;
    const o = new Float64Array(n), c = new Float64Array(n), vol = new Float64Array(n), amt = new Float64Array(n);
    const fn = new Float64Array(n).fill(NaN);
    const dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        o[i] = +r.open; c[i] = +r.close; vol[i] = +r.volume || 0; amt[i] = c[i] * vol[i]; dt[i] = nd(r.date);
        if (r.foreign_net !== undefined && r.foreign_net !== null) fn[i] = (+r.foreign_net || 0) + (+r.trust_net || 0);
    }
    const hT = [], hC = [], hF = [], hV = [];
    const last = new Map();
    let fi = 0;                        // 走到第幾筆財報(pub <= 今天)
    let ev = 0;

    for (let t = WIN; t < n - 1; t++) {
        if (!(o[t] > 0 && c[t] > 0)) continue;
        while (fi < finRows.length && finRows[fi].pub <= dt[t]) fi++;
        if (fi < 5) { SKIP.noFin++; continue; }                       // 要有 5 季才算得出「跟去年同季比」
        const known = finRows.slice(0, fi);                            // ⭐ 只有已公布的
        const L = known[known.length - 1], P4 = known[known.length - 5];
        if (!L || !P4 || L.eps == null || P4.eps == null) { SKIP.noFin++; continue; }
        // 基本面 = 已公布最新季 EPS 跟去年同季比(⛔ 不跟上一季比 —— 季 EPS 有季節性)
        const fundRaw = (Math.abs(P4.eps) > 0.01) ? (L.eps - P4.eps) / Math.abs(P4.eps) : null;
        if (fundRaw === null) { SKIP.noFin++; continue; }
        // 估值 = 收盤 ÷ TTM EPS(⛔ 虧損股沒有 PE → 不進樣本,而且要數出來)
        const ttm = known.slice(-4).reduce((s, x) => s + (x.eps || 0), 0);
        if (!(ttm > 0)) { SKIP.noPE++; continue; }
        const valRaw = -(c[t] / ttm);                                  // 反向:便宜 = 分數高
        // 技術 = 近 20 日報酬(⛔ 基準不含今日之後)
        if (!(c[t - WIN] > 0)) continue;
        const techRaw = c[t] / c[t - WIN] - 1;
        // 籌碼 = 近 20 日法人淨買 ÷ 近 20 日量
        let fSum = 0, vSum = 0, fOk = 0;
        for (let k = t - WIN + 1; k <= t; k++) { if (Number.isFinite(fn[k])) { fSum += fn[k]; fOk++; } vSum += vol[k]; }
        if (fOk < WIN * 0.8 || !(vSum > 0)) continue;
        const chipRaw = fSum / vSum;

        hT.push(techRaw); hC.push(chipRaw); hF.push(fundRaw); hV.push(valRaw);
        const tq = expQ(hT, techRaw), cq = expQ(hC, chipRaw), fq = expQ(hF, fundRaw), vq = expQ(hV, valRaw);
        if (tq === null || cq === null || fq === null || vq === null) { SKIP.shortHist++; continue; }

        // 流動性 + t+1 開盤漲停(第七關「買得到嗎」)
        let aSum = 0, aCnt = 0;
        for (let k = t - WIN; k < t; k++) if (amt[k] > 0) { aSum += amt[k]; aCnt++; }
        if (!aCnt || aSum / aCnt < LIQ_MIN) { SKIP.illiquid++; continue; }
        const e = t + 1;
        if (!(o[e] > 0) || o[e] >= c[t] * LIMIT_UP) { SKIP.limitUp++; continue; }
        const twEnter = TW.c.get(dt[e]); if (!twEnter) continue;
        const rets = HOLDS.map(H => {
            const x = e + H; if (x >= n || !(c[x] > 0)) return null;
            const twX = TW.c.get(dt[x]); if (!twX) return null;
            return (c[x] / o[e] - 1) * 100 - (twX / twEnter - 1) * 100;
        });
        if (rets.every(v => v === null)) continue;

        const y = +dt[t].slice(0, 4);
        const fire = b => {
            if (last.has(b) && t - last.get(b) < DEDUP) return;
            last.set(b, t); ev++;
            if (dateTally) { if (b === BASE) dateTally.set(dt[t], (dateTally.get(dt[t]) || 0) + 1); return; }
            bump(b, y, dt[t] < halfCut ? 0 : 1, rets);
        };
        const qs = [tq, cq, fq, vq];
        const div = Math.max(...qs) - Math.min(...qs);
        fire(BASE);
        for (const [nm, hit] of DIV_BUCKETS) if (hit(div)) { fire(nm); break; }
        for (const [nm, hit] of DIV_PLATEAU) if (hit(div, div)) fire(nm);
        for (const [nm, hit] of DIR_BUCKETS) if (hit(fq, tq)) { fire(nm); break; }
    }
    return ev;
}

// ═══════════ 關卡 ═══════════
function gates(a, base) {
    const M = margin(a.all[HI], base.all[HI]);
    const H = [0, 1].map(k => margin(a.byHalf[k][HI], base.byHalf[k][HI]).d);
    const yrs = [...a.byYear.keys()].sort();
    const YR = yrs.map(y => ({ y, n: a.byYear.get(y)[HI].n, d: base.byYear.has(y) ? margin(a.byYear.get(y)[HI], base.byYear.get(y)[HI]).d : 0 }))
        .filter(x => x.n >= 20);
    const sgn = Math.sign(M.d) || 1;
    const sameHalf = H.every(d => Math.sign(d) === sgn);
    const sameYear = YR.length >= 3 && YR.every(x => Math.sign(x.d) === sgn);
    let dropBest = 0;
    if (YR.length >= 3) {
        const bi = YR.reduce((b, x, i) => ((sgn > 0 ? x.d > YR[b].d : x.d < YR[b].d) ? i : b), 0);
        const rest = YR.filter((_, i) => i !== bi);
        const tot = rest.reduce((s, x) => s + x.n, 0);
        dropBest = tot ? rest.reduce((s, x) => s + x.d * x.n, 0) / tot : 0;
    }
    const pass = {
        '①全期': sgn > 0 && M.d > 0,
        '②前後半': sameHalf,
        '③逐年': sameYear,
        '④去最好年': Math.sign(dropBest) === sgn && dropBest !== 0,
        '⑤扣成本': M.d - COST > 0,
        '⑥檢定': M.p <= 0.05,
    };
    return { M, H, YR, dropBest, pass, nPass: Object.values(pass).filter(Boolean).length };
}

// ═══════════ selftest ═══════════
//  🚨 先確認**注入真的注進去了**:合成資料裡「分歧度高」的那幾天之後真的被拉高,
//     而對照組(全部)大部分日子沒有 → 量不到就是 harness 壞了,exit 1。
function selftest() {
    const fails = [];
    const days = [];
    const d0 = new Date('2023-01-02T00:00:00Z');
    for (let i = 0; i < 1700; i++) { const d = new Date(d0.getTime() + i * 86400000); if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) days.push(d.toISOString().slice(0, 10)); }
    const N = days.length;
    fs.rmSync('/tmp/divst', { recursive: true, force: true });
    fs.mkdirSync('/tmp/divst/fin', { recursive: true });
    // ⭐ 大盤全程持平 → 超額報酬 = 個股報酬(⛔ 不要讓基準也有結構,否則量到的是兩者的差)
    fs.writeFileSync('/tmp/divst/^TWII.json', JSON.stringify(days.map(d => ({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 1e6 }))));
    const SY = [];
    // 🎯 注入設計:45 天一個週期 —— 前 20 天每天 −0.15%(谷底時「近 20 日報酬」很差 → 技術分位低),
    //    接下來 20 天每天 +0.15%(≈ +3%)。EPS 用**加速成長**(k²)→ 基本面分位一路偏高。
    //    → 谷底那一天同時是「基本面高 + 技術低」= `🧬強價弱`,而它之後 20 日確實 +3%。
    //    ⭐ 對照組涵蓋整個週期 → 平均 ≈ 0,兩者差得出來。
    const CYC = 45, LEG = 20, STEP = 0.15;
    for (let s = 0; s < 40; s++) {
        const sym = `T${1000 + s}`; SY.push(sym);
        let px = 100; const rows = []; let rnd = s * 7919 + 13;
        const rr = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
        const off = s % CYC;                       // 各檔錯開,⛔ 不要全市場同一天觸發
        for (let i = 0; i < N; i++) {
            const ph = (i + off) % CYC;
            const drift = (ph < LEG ? -STEP : ph < LEG * 2 ? STEP : 0) + (rr() - 0.5) * 0.06;
            px = Math.max(5, px * (1 + drift / 100));
            rows.push({ date: days[i], open: +px.toFixed(3), high: +(px * 1.002).toFixed(3), low: +(px * 0.998).toFixed(3),
                        close: +px.toFixed(3), volume: 5e6, foreign_net: Math.round((rr() - 0.5) * 2e5), trust_net: 0 });
        }
        fs.writeFileSync(`/tmp/divst/${sym}.json`, JSON.stringify(rows));
        const q = [];
        for (let k = 0; k < 24; k++) {
            const y = 2021 + Math.floor(k / 4), m = [3, 6, 9, 12][k % 4];
            // EPS 加速成長 → (本季 − 去年同季)/|去年同季| **越來越大** → 基本面分位一路往上
            q.push({ p: `${y}-${String(m).padStart(2, '0')}-30`, pub: days[Math.min(N - 1, 20 + k * 40)], eps: +(0.5 * Math.exp(0.02 * k * k)).toFixed(3) });
        }
        fs.writeFileSync(`/tmp/divst/fin/${sym}.json`, JSON.stringify({ sym, q }));
    }
    const res = run('/tmp/divst', '/tmp/divst/fin', SY, true);
    const base = res.get(BASE), hi = res.get('\u{1f9ec}\u5f37\u50f9\u5f31(\u57fa\u672c\u9762\u226570 \u6280\u8853\u226430)');
    if (!base) { fails.push('⓪ 連對照組都沒有 → harness 壞了'); }
    else if (!hi) { fails.push('① 「🧬強價弱」一筆都沒有 → **注入沒注進去**(⛔ 不是偵測器有洞)'); }
    else {
        const M = margin(hi.all[HI], base.all[HI]);
        const bs2 = stat(base.all[HI]);
        console.log(`  selftest:對照組 n=${bs2.n} ${f2(bs2.m)}% ・🧬強價弱 n=${M.n} 邊際 ${f2(M.d)}pp (p=${M.p.toFixed(4)})`);
        if (!(M.n >= 150)) fails.push(`① 注入事件只有 ${M.n} 筆 → 注入沒注進去(⛔ 不是偵測器有洞)`);
        // ⚠️ 門檻是 0.5 不是 3 —— 注入的是「谷底之後 20 日 +3%」,但 `tq ≤ 0.30`
        //   涵蓋的是**整個下跌段**(不只谷底那一天)→ 量到的是那一段的**平均**。
        //   ⭐ 這正是偵測器該做的事,⛔ 不可為了「數字好看」把門檻提到 3。
        if (!(M.d > 0.5)) fails.push(`② 已知的正邊際只量到 ${M.d.toFixed(2)}pp → 偵測器叫不出來`);
        if (!(M.p <= 0.05)) fails.push(`③ 檢定失靈(p=${M.p.toFixed(3)})`);
        // ⭐⭐ **決定性對照**:鏡像那一桶(高點 = 基本面高 + 技術高)之後是**下跌段** → 必須是負的。
        //   ⛔ 兩邊都 ≈0 = 桶根本沒分對(而那種壞法只看正邊這一條看不出來)。
        const lo = res.get('\u{1f9ec}\u540c\u5411\u5f37(\u5169\u500b\u90fd\u226570)');
        if (!lo) fails.push('④ 鏡像桶「🧬同向強」一筆都沒有 → 桶的分配壞掉了');
        else {
            const Mlo = margin(lo.all[HI], base.all[HI]);
            console.log(`  selftest:鏡像桶 🧬同向強 n=${Mlo.n} 邊際 ${f2(Mlo.d)}pp`);
            if (!(Mlo.d < -0.3)) fails.push(`④ 鏡像桶應該是負的卻是 ${Mlo.d.toFixed(2)}pp → 桶沒分對(決定性對照)`);
        }
        const bm = Math.abs(bs2.m);
        if (!(bm < 0.4)) fails.push(`⑤ 對照組平均 ${bs2.m.toFixed(2)}% 不接近 0 → 基準扣除或週期涵蓋有問題`);
    }
    console.log(fails.length ? `❌ selftest 失敗:\n  ${fails.join('\n  ')}` : '✅ selftest 通過');
    process.exit(fails.length ? 1 : 0);
}

// ═══════════ 主流程 ═══════════
function run(dataDir, finDir, symList, quiet) {
    ACC.clear();
    for (const k of Object.keys(SKIP)) SKIP[k] = 0;
    const savedDATA = DATA;
    const TW = (() => {
        const rows = JSON.parse(fs.readFileSync(path.join(dataDir, '^TWII.json'), 'utf8'))
            .map(r => ({ d: nd(r.date), c: +r.close })).filter(r => r.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
        return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])) };
    })();
    const load = sym => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, `${sym}.json`), 'utf8')); } catch (_) { return null; } };
    const finOf = sym => {
        try {
            const F = JSON.parse(fs.readFileSync(path.join(finDir, `${sym}.json`), 'utf8'));
            const q = Array.isArray(F && F.q) ? F.q : [];
            const rows = q.map(x => ({ p: String(x.p || ''), pub: nd(x.pub || ''), eps: Number.isFinite(+x.eps) ? +x.eps : null }))
                .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.pub)).sort((a, b) => a.pub < b.pub ? -1 : 1);
            return rows.length >= 6 ? rows : null;
        } catch (_) { return null; }
    };
    // pass 1:先數對照組事件落在哪一天 → 算**這一組自己的**前後半切點(⛔ 不用全局日期中點)
    const tally = new Map();
    for (const sym of symList) {
        const rows = load(sym); if (!Array.isArray(rows) || rows.length < 200) continue;
        const fr = finOf(sym); if (!fr) continue;
        scanSymbol(sym, rows, TW, '', tally, fr);
    }
    const flat = [...tally.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const tot = flat.reduce((s, x) => s + x[1], 0);
    let acc = 0, halfCut = flat.length ? flat[Math.floor(flat.length / 2)][0] : '';
    for (const [d, k] of flat) { acc += k; if (acc >= tot / 2) { halfCut = d; break; } }
    if (!quiet) console.log(`📅 對照組 ${tot.toLocaleString()} 筆(股·日)・前後半切點 ${halfCut}`);
    // pass 2
    for (const sym of symList) {
        const rows = load(sym); if (!Array.isArray(rows) || rows.length < 200) continue;
        const fr = finOf(sym); if (!fr) continue;
        scanSymbol(sym, rows, TW, halfCut, null, fr);
    }
    return ACC;
}

if (SELFTEST) selftest();

const syms = fs.readdirSync(FIN).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
    .filter(s => fs.existsSync(path.join(DATA, `${s}.json`))).sort().slice(0, MAX_SYMS);
if (syms.length < 100) { console.log(`❌ 只有 ${syms.length} 檔同時有 K 線與財報切片 —— ⛔ 不跑假回測(先 bash scripts/fetch_testdata.sh)`); process.exit(0); }
console.log(`🔀 多空分歧探針 —— ${syms.length.toLocaleString()} 檔(同時有 K 線與財報切片)`);
const t0 = Date.now();
const R = run(DATA, FIN, syms, false);
const base = R.get(BASE);
if (!base || base.all[HI].n < MIN_EV) { console.log(`❌ 對照組只有 ${base ? base.all[HI].n : 0} 筆 → ⛔ 不給結論`); process.exit(0); }

const bs = stat(base.all[HI]);
console.log(`\n對照組(四個分數都算得出來的所有股·日):n=${bs.n.toLocaleString()} ・20 日超額 ${f2(bs.m)}%`);
console.log(`🚧 擋掉:漲停買不到 ${SKIP.limitUp.toLocaleString()} ・流動性不足 ${SKIP.illiquid.toLocaleString()} ・沒財報 ${SKIP.noFin.toLocaleString()} ・虧損沒 PE ${SKIP.noPE.toLocaleString()} ・歷史不夠 ${SKIP.shortHist.toLocaleString()}`);
console.log(`\n${'桶'.padEnd(30)} ${'n'.padStart(7)} ${'20日邊際'.padStart(9)} ${'p'.padStart(7)}  關卡`);
console.log('─'.repeat(78));
const report = [];
const order = [...DIV_BUCKETS.map(x => x[0]), ...DIV_PLATEAU.map(x => x[0]), ...DIR_BUCKETS.map(x => x[0])];
for (const nm of order) {
    const a = R.get(nm); if (!a || a.all[HI].n < 60) { console.log(`${nm.padEnd(30)} ${String(a ? a.all[HI].n : 0).padStart(7)}   樣本太少,不給結論`); continue; }
    const G = gates(a, base);
    const flag = G.nPass === 6 ? '✅ 六關全過' : `${G.nPass}/6 ${Object.entries(G.pass).filter(([, v]) => !v).map(([k]) => k).join('')}`;
    console.log(`${nm.padEnd(30)} ${String(G.M.n).padStart(7)} ${f2(G.M.d, 9)}pp ${G.M.p.toFixed(4).padStart(7)}  ${flag}`);
    report.push({ b: nm, n: G.M.n, d: +G.M.d.toFixed(3), p: +G.M.p.toFixed(4), pass: G.nPass,
                  half: G.H.map(x => +x.toFixed(2)), yr: G.YR.map(x => [x.y, +x.d.toFixed(2), x.n]), dropBest: +G.dropBest.toFixed(2) });
}
console.log('\n🔬 逐年(20 日邊際,⛔ 樣本 <20 的年份不參與判定):');
for (const r of report) if (r.yr.length) console.log(`  ${r.b.padEnd(30)} ${r.yr.map(y => `${y[0]}:${f2(y[1], 6, 1)}`).join('  ')}  ・去最好年 ${f2(r.dropBest, 5, 1)}`);
console.log(`\n⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
console.log('⚠️ 窗口 = data/fin 的 12 季 ≈ 3 年 → **不含 2022 空頭**;倖存者偏誤;虧損股沒有 TTM PE 不進樣本;⛔ 不含股利。');
console.log('⛔ 這是探針不是測試(exit 0)。要接進 App 當**訊號**必須六關全過 + 高原檢定站得住;沒過就只准當「描述」。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ base: { n: bs.n, m: +bs.m.toFixed(3) }, rows: report, skip: SKIP, syms: syms.length, cost: COST }, null, 1)); console.log(`💾 ${OUT}`); }
process.exit(0);
