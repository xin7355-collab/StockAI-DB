#!/usr/bin/env node
/**
 * 🗣️ 盤中口訣探針 —— 把「用日 K 測得到的那幾條」一次量完
 *
 * 使用者貼了 8 條盤中口訣 + 4 條開盤 30 分鐘檢查表,問「該回測還是盤中提醒」。
 * ⭐ 12 條裡 6 條本 repo 早就有答案(全部否定,清單見 docs/DECISIONS.md),
 *    這一支只測**真的沒測過、而且日 K 就量得到**的三組:
 *
 *   G1 ⑤「買陰不買陽、賣陽不賣陰」
 *      → 用**實體幅度 ÷ 自己近 20 日平均振幅**分六桶(大陰…大陽),看超額是不是**單調遞減**。
 *      ⭐ 這一條值得測是因為**本站自己的證據互相打架**:
 *         `_SIGNAL_EDGE` 的「實體長紅棒」−1.129pp / 「站穩長紅K高點」−0.412pp(支持不買陽)
 *         vs `screener_edge_probe.py` 127 條的總結論「追強 > 抄底」(反對)。
 *
 *   G2 ⑧「高位橫盤再沖高趕緊拋」
 *      → 高位(一年位階 ≥80%)+ 窄幅整理(近 20 日振幅在**自己過去**的低分位)+ 今日沖高收回。
 *      ⛔ 對照組是「**所有高位的(股·日)**」,不是全市場 —— 否則量到的是「高位」本身。
 *
 *   G3 檢①「先看前一天籌碼軌跡」
 *      → 昨日三大法人淨買 ÷ 成交量,用**自己過去的分位**分桶(⛔ 不用絕對張數,V71.1.6 教訓)。
 *      ⚠️ 籌碼欄只有 2023-06 起 → 這一組窗口比另外兩組短,結論要分開講。
 *
 * ⛔ 七道關卡(第八關「疊在現行配置上還有增量」留給真的過關的才做,成本高)
 *   ① 全期邊際 > 0 ② 前後半同向 ③ 逐年同向 ④ 去最好的一年仍成立
 *   ⑤ 邊際 > 來回成本 0.44% ⑥ 雙樣本 z 檢定 p ≤ 0.05 ⑦ 買得到嗎(排除 t+1 開盤漲停 + 流動性門檻)
 *
 * 🚨 三個一定要守住的方法論(每一條都是本 repo 踩過的坑):
 *   ・**前視偏誤**:條件一律用 t 日**收盤後**才知道的資料,進場用 **t+1 開盤**
 *     (`scripts/gap_probe.mjs:11` 的註解記著第一版「用今天收盤當條件又用今天收盤算報酬」那次)。
 *   ・**基準區間 ⛔ 不可包含被判斷的那幾根**(陷阱 #43):平均振幅取 `[t-20, t-1]`、
 *     「沖高」比的是 `max(high[t-20..t-1])`。⭐ 但**位階**含今日是對的,⛔ 別亂改。
 *   ・**門檻用自己的過去分位(expanding)⛔ 不寫死數字**(V71.1.6 外資期貨的教訓);
 *     expanding = 只看過去,天生沒有前視。
 *
 * ⚠️ 已知限制(⛔ 報告裡不可省)
 *   ・倖存者偏誤:已下市的不在 data/ 裡。
 *   ・「陰/陽」是**日 K** 的定義,而口訣講的是**盤中**;這是代理,⛔ 不等於原句。
 *   ・報酬扣同期加權指數;⛔ 不含股利。
 *
 * 🚧 `--selftest` 自己的**盲區**(⛔ 不可讀成「全部驗過了」):
 *   ・它叫得出來的:前視偏誤(進場改 t 日收盤)・平均振幅基準含今日(陷阱 #43)・檢定失靈。
 *   ・⛔ **叫不出來的:20 日去重**(合成資料的觸發日本來就間隔 ≥30 根 → 拿掉去重也沒差)。
 *     真實資料上去重才有作用,那一段只能靠人工讀原始碼。
 *
 * ⛔ 只讀,不打 API、不寫任何會被部署的產物。exit 0(巡邏/探針,不進四驗證)。
 *
 * 用法:
 *   DATA_DIR=<合併過深歷史的目錄> node --max-old-space-size=4096 scripts/maxim_probe.mjs [輸出.json]
 *   node scripts/maxim_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';

const COST = 0.44;        // 來回手續費 0.1425%×2 + 證交稅 0.3%(未打折)
const HOLDS = [5, 10, 20];
const DEDUP = 20;         // 同檔同桶 20 個交易日內只算一次(連續多天觸發是同一件事)
const MIN_EV = 400;       // 🚧 空過守門:事件太少不給結論
const AMP_N = 20;         // 平均振幅的基準長度(⛔ 不含今日)
const POS_N = 250;        // 一年位階
const EXP_MIN = 120;      // expanding 分位至少要累積幾筆才敢用
const LIQ_MIN = 3e7;      // 20 日均額 ≥ 3,000 萬元(⛔ 買不到的不算數)
const LIMIT_UP = 1.095;   // t+1 開盤漲停 → 排除(第七關「買得到嗎」)

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
// 常態 CDF(Abramowitz-Stegun 7.1.26)
const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
};
const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);

const BASE_OF = { G1: 'ALL', G2: 'HIGH_ALL', G3: 'ALL_CHIP' };   // 每組的對照組桶

// ═══════════ 桶的定義 ═══════════
// G1:實體幅度 ÷ 近 20 日平均振幅
const G1_BUCKETS = [
    ['大陰', r => r <= -1.0], ['中陰', r => r > -1.0 && r <= -0.3], ['小陰', r => r > -0.3 && r < 0],
    ['小陽', r => r > 0 && r < 0.3], ['中陽', r => r >= 0.3 && r < 1.0], ['大陽', r => r >= 1.0],
];
const G3_BUCKETS = [   // 昨日法人淨買佔量比的自身分位
    ['法人大賣(≤10%)', q => q <= 0.10], ['法人賣(10~35%)', q => q > 0.10 && q <= 0.35],
    ['中性(35~65%)', q => q > 0.35 && q <= 0.65],
    ['法人買(65~90%)', q => q > 0.65 && q <= 0.90], ['法人大買(≥90%)', q => q > 0.90],
];
// 🔬 門檻敏感度(短探針慣例):最高那一端再切細 —— ⛔ 越嚴越好才算「高原」,
//    只有某一格特別好 = 孤峰 = 多重比較的產物(V74.3.8 chand2 / V74.4.7 證券股都死在這關)
const G3_TAIL = [
    ['  └ 90~95%', q => q > 0.90 && q <= 0.95], ['  └ 95~98%', q => q > 0.95 && q <= 0.98],
    ['  └ 98~99%', q => q > 0.98 && q <= 0.99], ['  └ 99~99.5%', q => q > 0.99 && q <= 0.995],
    ['  └ ≥99.5%', q => q > 0.995],
];

// ═══════════ 累加器(⛔ 不存個別事件 —— 2,000 檔 × 1,200 日會吃光記憶體)═══════════
const mk = () => HOLDS.map(() => ({ n: 0, s: 0, ss: 0 }));
const ACC = new Map();    // `${g}|${b}` → { all, byYear:Map, byHalf:[a,b] }
const SKIP = { limitUp: 0, illiquid: 0 };   // 第七關「買得到嗎」擋掉幾筆(⛔ 要印出來,不可靜默)
function bump(g, b, y, half, rets) {
    const k = `${g}|${b}`;
    let a = ACC.get(k);
    if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()] }; ACC.set(k, a); }
    let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
    for (let i = 0; i < HOLDS.length; i++) {
        const v = rets[i]; if (v === null) continue;
        for (const t of [a.all[i], yy[i], a.byHalf[half][i]]) { t.n++; t.s += v; t.ss += v * v; }
    }
}
const stat = t => t.n ? { n: t.n, m: t.s / t.n, v: Math.max(0, t.ss / t.n - (t.s / t.n) ** 2) } : { n: 0, m: 0, v: 0 };
const margin = (a, b) => {   // 邊際 + z 檢定
    const A = stat(a), B = stat(b);
    if (!A.n || !B.n) return { n: A.n, d: 0, z: 0, p: 1 };
    const se = Math.sqrt(A.v / A.n + B.v / B.n);
    const z = se > 0 ? (A.m - B.m) / se : 0;
    return { n: A.n, d: A.m - B.m, z, p: pTwoSided(z) };
};

// ═══════════ 1. 大盤日曆(報酬要扣同期加權)═══════════
function loadTwii() {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
        .map(r => ({ d: nd(r.date), c: +r.close }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
        .sort((a, b) => a.d < b.d ? -1 : 1);
    return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])) };
}

// ═══════════ 2. 逐檔掃(streaming,⛔ 不把全市場載進記憶體)═══════════
function scanSymbol(rows, TW, halfCut, dateTally) {
    const n = rows.length;
    if (n < POS_N + AMP_N + 25) return 0;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
    const amt = new Float64Array(n), fn = new Float64Array(n).fill(NaN), vol = new Float64Array(n);
    const dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        o[i] = +r.open; h[i] = +r.high; l[i] = +r.low; c[i] = +r.close; vol[i] = +r.volume || 0;
        amt[i] = c[i] * vol[i]; dt[i] = nd(r.date);
        const hasChip = r.foreign_net !== undefined && r.foreign_net !== null;
        if (hasChip) fn[i] = (+r.foreign_net || 0) + (+r.trust_net || 0) + (+r.dealer_net || 0);
    }
    // expanding 分位用的歷史池(⛔ 只放過去,天生沒有前視)
    const ampHist = [], chipHist = [];
    const last = new Map();      // `${g}|${b}` → 上次事件的 index(20 日去重)
    let ev = 0;

    for (let t = POS_N; t < n - 1; t++) {
        if (!(o[t] > 0 && h[t] > 0 && l[t] > 0 && c[t] > 0)) continue;
        // ── 近 20 日平均振幅(⛔ 基準區間不含今日 —— 陷阱 #43)──
        let ampSum = 0, ampCnt = 0;
        for (let k = t - AMP_N; k < t; k++) if (c[k] > 0 && h[k] >= l[k]) { ampSum += (h[k] - l[k]) / c[k]; ampCnt++; }
        if (ampCnt < AMP_N * 0.8) continue;
        const avgAmp = ampSum / ampCnt;
        if (!(avgAmp > 0)) continue;
        ampHist.push(avgAmp);
        if (Number.isFinite(fn[t])) chipHist.push(vol[t] > 0 ? fn[t] / vol[t] : 0);

        // ── 流動性(第七關「買得到嗎」的一半)──
        let aSum = 0, aCnt = 0;
        for (let k = t - AMP_N; k < t; k++) if (amt[k] > 0) { aSum += amt[k]; aCnt++; }
        if (!aCnt || aSum / aCnt < LIQ_MIN) { SKIP.illiquid++; continue; }
        // ── t+1 開盤漲停 → 買不到 ──
        const e = t + 1;
        if (!(o[e] > 0) || o[e] >= c[t] * LIMIT_UP) { SKIP.limitUp++; continue; }

        const dEnter = dt[e], twEnter = TW.c.get(dEnter);
        if (!twEnter) continue;
        const rets = HOLDS.map(H => {
            const x = e + H; if (x >= n || !(c[x] > 0)) return null;
            const twX = TW.c.get(dt[x]); if (!twX) return null;
            return (c[x] / o[e] - 1) * 100 - (twX / twEnter - 1) * 100;
        });
        if (rets.every(v => v === null)) continue;
        const y = +dt[t].slice(0, 4);
        const fire = (g, b) => {
            const k = `${g}|${b}`;
            if (last.has(k) && t - last.get(k) < DEDUP) return;
            last.set(k, t); ev++;
            // ⭐ pass 1 只數「每組的對照組事件落在哪一天」,用來算**那一組自己的**前後半切點
            //   🚨 ⛔ 不可用全局切點:籌碼欄 2023-12 才開始,拿全局 2024-03 切 → 前半只有 6% 的樣本
            //      (第一版就是這樣,G3 的「前後半同向」那一關等於在問一個沒有意義的問題)
            if (dateTally) { if (b === BASE_OF[g]) dateTally[g].set(dt[t], (dateTally[g].get(dt[t]) || 0) + 1); return; }
            bump(g, b, y, dt[t] < halfCut[g] ? 0 : 1, rets);
        };

        // ══ G1 買陰不買陽 ══
        const bodyR = ((c[t] - o[t]) / o[t]) / avgAmp;
        fire('G1', 'ALL');
        for (const [nm, hit] of G1_BUCKETS) if (hit(bodyR)) { fire('G1', nm); break; }

        // ══ G2 高位橫盤再沖高 ══
        let hi = -Infinity, lo = Infinity;
        for (let k = t - POS_N + 1; k <= t; k++) { if (h[k] > hi) hi = h[k]; if (l[k] > 0 && l[k] < lo) lo = l[k]; }
        const pos = hi > lo ? (c[t] - lo) / (hi - lo) : 0.5;      // ⭐ 位階含今日是對的
        if (pos >= 0.80) {
            fire('G2', 'HIGH_ALL');                               // ⛔ 對照組 = 所有高位的(股·日)
            if (ampHist.length >= EXP_MIN) {
                const past = ampHist.slice(0, -1);                // ⛔ 不含今日那筆
                const rank = past.reduce((s, v) => s + (v < avgAmp ? 1 : 0), 0) / past.length;
                let pHi = -Infinity;                              // 🚨 沖高比的是**前 20 根**(⛔ 不含今日)
                for (let k = t - AMP_N; k < t; k++) if (h[k] > pHi) pHi = h[k];
                const rng = h[t] - l[t];
                const clr = rng > 0 ? (c[t] - l[t]) / rng : 0.5;
                if (rank <= 0.30 && h[t] > pHi) fire('G2', clr <= 0.4 ? '窄幅沖高·收回(拋)' : '窄幅沖高·收高');
            }
        }

        // ══ G3 前一日籌碼軌跡 ══(⚠️ 只有 2023-06 之後的列才有籌碼欄)
        if (Number.isFinite(fn[t]) && vol[t] > 0 && chipHist.length >= EXP_MIN) {
            fire('G3', 'ALL_CHIP');
            const cur = fn[t] / vol[t];
            const past = chipHist.slice(0, -1);
            const q = past.reduce((s, v) => s + (v < cur ? 1 : 0), 0) / past.length;
            for (const [nm, hit] of G3_BUCKETS) if (hit(q)) { fire('G3', nm); break; }
            for (const [nm, hit] of G3_TAIL) if (hit(q)) { fire('G3', nm); break; }
        }
    }
    return ev;
}

// ═══════════ 3. 關卡判定 ═══════════
function gates(a, base, hi) {
    const M = margin(a.all[hi], base.all[hi]);
    const H = [0, 1].map(k => margin(a.byHalf[k][hi], base.byHalf[k][hi]).d);
    const yrs = [...a.byYear.keys()].sort();
    const YR = yrs.map(y => ({ y, n: a.byYear.get(y)[hi].n, d: base.byYear.has(y) ? margin(a.byYear.get(y)[hi], base.byYear.get(y)[hi]).d : 0 }))
        .filter(x => x.n >= 20);       // 樣本太少的年份不參與逐年檢定(但會印出來)
    const sgn = Math.sign(M.d) || 1;
    const sameHalf = H.every(d => Math.sign(d) === sgn);
    const sameYear = YR.length >= 3 && YR.every(x => Math.sign(x.d) === sgn);
    // 去掉貢獻最大的那一年,剩下的加權平均還同向嗎
    let dropBest = 0;
    if (YR.length >= 3) {
        const worstIdx = YR.reduce((bi, x, i) => (sgn > 0 ? x.d > YR[bi].d : x.d < YR[bi].d) ? i : bi, 0);
        const rest = YR.filter((_, i) => i !== worstIdx);
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

// ═══════════ 4. selftest:合成一個**已知邊際**,量不到就 exit 1 ═══════════
//  🚨 第一版的注入**注不進去**(本 repo 第二次犯,`news_event_probe` 也踩過):
//     觸發日太密(8%)→ 對照組有 57% 的窗口也跨到被拉高的那一段 → 3% 的注入只量到 0.32pp。
//  ⭐ 正解:**讓對照組拿不到那個 lift** —— 觸發日壓到 1.5% 且**強制間隔 ≥30 根**,
//     再用 40 檔合成股把事件數補回來(順便驗跨檔累加)。
function selftest() {
    console.log('🧪 selftest —— 合成資料注入已知邊際,確認探針量得到\n');
    const INJECT = 3.0;      // 「大陰」之後**第 10 日起**多給 +3%(⛔ 5 日不給 → 用來抓前視)
    const NSYM = 40, NBAR = 1400, PBIG = 0.015, MINGAP = 30;
    const days = [];
    let d = new Date(Date.UTC(2021, 0, 4));
    for (let i = 0; i < NBAR; i++) {
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5);
        days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5);
    }
    const TW = { days, c: new Map(days.map(x => [x, 10000])) };   // 大盤走平 → 邊際就是個股自己的
    ACC.clear();
    let ev = 0, bigTot = 0;
    for (let sIdx = 0; sIdx < NSYM; sIdx++) {
        const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(1000 + sIdx * 7919);
        const rows = [], isBig = new Array(NBAR).fill(false);
        let px = 100, lastBig = -MINGAP;
        for (let i = 0; i < NBAR; i++) {
            const big = (i - lastBig >= MINGAP) && rnd() < PBIG;
            if (big) lastBig = i;
            const ch = big ? -0.05 : (rnd() - 0.5) * 0.02;
            // 🚨 **隔夜價差是這支 selftest 的鑑別力來源**:大陰隔天開高 2%
            //    → 「進場用 t 日收盤」(前視)會偷到那 2%、「用 t+1 開盤」(正確)偷不到。
            //    ⛔ 少了這一段,把進場改成 c[t] 的注入**叫不出來**(實測過,第一版就是全綠)。
            const gap = (i > 0 && isBig[i - 1]) ? 0.02 : 0;
            const op = px * (1 + gap), cl = op * (1 + ch);
            rows.push({ date: days[i], open: op, high: Math.max(op, cl) * 1.005,
                        low: Math.min(op, cl) * 0.995, close: cl, volume: 5e6 });
            isBig[i] = big; px = cl;
        }
        for (let t = 0; t < NBAR; t++) {
            if (!isBig[t]) continue;
            bigTot++;
            const x = t + 11;    // = 進場(t+1 開盤)後的第 10 根 → 恰好是 HOLDS[1] 的出場
            if (x >= NBAR) continue;
            for (let k = x; k < NBAR; k++)
                for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= (1 + INJECT / 100);
        }
        ev += scanSymbol(rows, TW, { G1: days[Math.floor(NBAR / 2)], G2: days[Math.floor(NBAR / 2)], G3: days[Math.floor(NBAR / 2)] }, null);
    }
    const g = ACC.get('G1|大陰'), all = ACC.get('G1|ALL');
    let bad = 0;
    const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    ck(ev > 500, `掃到 ${ev} 個事件 ・注入 ${bigTot} 次(🚧 空過守門:太少就沒有鑑別力)`);
    ck(!!g && !!all && g.all[1].n >= 100, `「大陰」桶 n=${g ? g.all[1].n : 0} ・對照組 n=${all ? all.all[1].n : 0}`);
    if (g && all) {
        const m10 = margin(g.all[1], all.all[1]).d;      // HOLDS[1] = 10 日
        ck(m10 > INJECT * 0.6, `量到的 10 日邊際 ${f2(m10)}pp,注入的是 +${INJECT}(⛔ 量不到 = 探針本身有洞)`);
        const m5 = margin(g.all[0], all.all[0]).d;
        //  ⚠️ 門檻用**絕對值 1.0pp**,⛔ 不可只寫 `< m10 * 0.4` —— 前視會同時把 5 日與 10 日一起墊高,
        //     相對門檻因此永遠過得了(實測:注入前視後 5 日 +1.94 vs 10 日 +5.08,相對門檻 2.03 → 假綠燈)。
        ck(Math.abs(m5) < 1.0 && Math.abs(m5) < m10 * 0.4,
           `5 日邊際 ${f2(m5)}pp 必須 ≈0(注入只發生在第 10 日之後;隔夜開高 2% 只有「進場用 t 收盤」才偷得到)`);
        const G = gates(g, all, 1);
        ck(G.pass['⑥檢定'], `關卡⑥ 檢定叫得出來(p=${G.M.p.toFixed(5)})`);
    }

    // ══ 案例 B:平均振幅的基準區間**含不含今日**會翻桶(陷阱 #43)══
    //   前 20 根振幅都是 1%、今天振幅 50% → 正確 avgAmp=0.010(r=-2.5 → 大陰)
    //   含今日則 avgAmp≈0.033(r=-0.75 → 中陰)。⛔ 這是唯一叫得出那個注入的辦法。
    ACC.clear();
    {
        const NB = 400, T = 350, rowsB = [];
        let px = 100;
        for (let i = 0; i < NB; i++) {
            const isT = i === T;
            const op = px;
            const cl = isT ? op * 0.975 : op;                     // 今天實體 -2.5%
            const rng = isT ? op * 0.50 : op * 0.01;              // 今天振幅 50%、平常 1%
            rowsB.push({ date: days[i], open: op, close: cl,
                         high: Math.max(op, cl) + rng / 2, low: Math.min(op, cl) - rng / 2, volume: 5e6 });
            px = cl;
        }
        const TWB = { days: days.slice(0, NB), c: new Map(days.slice(0, NB).map(x => [x, 10000])) };
        scanSymbol(rowsB, TWB, { G1: days[200], G2: days[200], G3: days[200] }, null);
        const big = ACC.get('G1|大陰'), mid = ACC.get('G1|中陰');
        ck(!!big && big.all[1].n >= 1,
           `案例B:那一根被歸成「大陰」(n=${big ? big.all[1].n : 0})—— 0 的話代表平均振幅把今天那根 50% 自己算進去了(陷阱 #43)`);
        ck(!mid || mid.all[1].n === 0,
           `案例B:⛔ 不可被歸成「中陰」(n=${mid ? mid.all[1].n : 0})`);
    }
    console.log('\n' + (bad ? `❌ SELFTEST_FAIL:${bad} 條` : '✅ SELFTEST_PASS'));
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) selftest();

// ═══════════ 5. 實跑 ═══════════
const TW = loadTwii();
console.log(`📅 大盤日曆 ${TW.days[0]} ~ ${TW.days[TW.days.length - 1]}(${TW.days.length} 個交易日)`);
if (TW.days[0] > '2022-06-01') console.log('🚨 窗口沒有涵蓋 2022 空頭 → 逐年那關的意義大打折扣(要用合併過深歷史的 DATA_DIR)');

const files = fs.readdirSync(DATA).filter(x => /^\d{4}[A-Z]?\.json$/.test(x));
const readRows = fn => {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { return null; }
    if (!Array.isArray(rows) || rows.length < POS_N + 60) return null;
    rows.sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
    return rows;
};
// ── 第 1 趟:只數日期,算出**每一組自己的**前後半切點 ──
const tally = { G1: new Map(), G2: new Map(), G3: new Map() };
for (const fn of files) { const r = readRows(fn); if (r) scanSymbol(r, TW, null, tally); }
const halfCut = {}, gWin = {};
for (const g of Object.keys(tally)) {
    const ds = [...tally[g].entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const tot = ds.reduce((s, x) => s + x[1], 0);
    let acc = 0, cut = ds.length ? ds[ds.length - 1][0] : '9999';
    for (const [d, n] of ds) { acc += n; if (acc >= tot / 2) { cut = d; break; } }
    halfCut[g] = cut;
    gWin[g] = ds.length ? [ds[0][0], ds[ds.length - 1][0], cut, tot] : ['—', '—', '—', 0];
}
// ── 第 2 趟:真的累加 ──
let used = 0, evTot = 0;
for (const fn of files) {
    const rows = readRows(fn); if (!rows) continue;
    const e = scanSymbol(rows, TW, halfCut, null);
    if (e) { used++; evTot += e; }
}
console.log(`📊 掃 ${used} 檔 ・事件 ${evTot.toLocaleString()} 筆(已做同檔同桶 ${DEDUP} 日去重)`);
console.log(`🛒 第七關「買得到嗎」擋掉:t+1 開盤漲停 ${(SKIP.limitUp / 2).toLocaleString()} 個(股·日)`
    + ` ・20 日均額 < ${(LIQ_MIN / 1e4).toLocaleString()} 萬 ${(SKIP.illiquid / 2).toLocaleString()} 個`
    + `(⚠️ 兩趟掃各算一次,已除以 2)\n`);

const GROUPS = [
    ['G1', '⑤ 買陰不買陽 / 賣陽不賣陰', 'ALL', G1_BUCKETS.map(x => x[0]),
     '實體幅度 ÷ 自己近 20 日平均振幅;對照組 = 同一批(股·日)的全部'],
    ['G2', '⑧ 高位橫盤再沖高趕緊拋', 'HIGH_ALL', ['窄幅沖高·收回(拋)', '窄幅沖高·收高'],
     '一年位階 ≥80% + 近 20 日振幅在自己過去的低 30% + 今日過前 20 日高;⛔ 對照組是**所有高位的**'],
    ['G3', '檢① 先看前一天籌碼軌跡', 'ALL_CHIP', [...G3_BUCKETS, ...G3_TAIL].map(x => x[0]),
     '昨日三大法人淨買 ÷ 成交量的自身分位;⚠️ 籌碼欄只有 2023-06 起 → 窗口比另外兩組短'],
];
const report = { window: [TW.days[0], TW.days[TW.days.length - 1]], bars: TW.days.length, syms: used, events: evTot, cost: COST, groups: {} };

for (const [g, title, baseKey, buckets, note] of GROUPS) {
    const base = ACC.get(`${g}|${baseKey}`);
    console.log('═'.repeat(78));
    console.log(`${title}`);
    console.log(`  ${note}`);
    console.log(`  窗口 ${gWin[g][0]} ~ ${gWin[g][1]} ・前後半切點 ${gWin[g][2]}(⭐ 這一組自己的中位日,⛔ 不是全局)`);
    if (!base || base.all[1].n < MIN_EV) {
        console.log(`  🚧 空過守門:對照組只有 ${base ? base.all[1].n : 0} 筆(< ${MIN_EV})→ ⛔ 這一組不給結論\n`);
        report.groups[g] = { skipped: true, baseN: base ? base.all[1].n : 0 };
        continue;
    }
    const bm = HOLDS.map((_, i) => stat(base.all[i]).m);
    console.log(`  對照組 n=${base.all[1].n.toLocaleString()} ・超額 ${HOLDS.map((H, i) => `${H}日 ${f2(bm[i], 6)}`).join(' ・')}`);
    console.log(`  ${'桶'.padEnd(18)} ${'n'.padStart(7)} ${'5日邊際'.padStart(9)} ${'10日邊際'.padStart(9)} ${'20日邊際'.padStart(9)}  扣成本(10)  絕對(10)  關卡`);
    const gout = { base: { n: base.all[1].n, m: bm }, buckets: {} };
    const rows = [];
    for (const b of buckets) {
        const a = ACC.get(`${g}|${b}`);
        if (!a || a.all[1].n < 30) { console.log(`  ${b.padEnd(18)} ${String(a ? a.all[1].n : 0).padStart(7)}   —— 樣本太少`); continue; }
        const ds = HOLDS.map((_, i) => margin(a.all[i], base.all[i]).d);
        const G = gates(a, base, 1);
        const flag = G.nPass === 6 ? '✅ 六關全過' : `${G.nPass}/6`;
        console.log(`  ${b.padEnd(18)} ${String(G.M.n).padStart(7)} ${f2(ds[0], 9)} ${f2(ds[1], 9)} ${f2(ds[2], 9)} ${f2(ds[1] - COST, 8)} ${f2(stat(a.all[1]).m, 8)}  ${flag}  p=${G.M.p.toFixed(4)}`);
        rows.push([b, ds[1]]);
        gout.buckets[b] = { n: G.M.n, d: ds, abs: HOLDS.map((_, i) => stat(a.all[i]).m), p: G.M.p, pass: G.pass, nPass: G.nPass,
                            half: G.H, byYear: G.YR, dropBest: G.dropBest };
        if (G.nPass >= 4) {
            console.log(`      逐年:${G.YR.map(x => `${x.y} ${f2(x.d, 6)}(n=${x.n})`).join(' ・')}`);
            console.log(`      前半 ${f2(G.H[0], 6)} / 後半 ${f2(G.H[1], 6)} ・去最好年 ${f2(G.dropBest, 6)} ・關卡:${Object.entries(G.pass).map(([k, v]) => (v ? '✅' : '❌') + k).join(' ')}`);
        }
    }
    // ⭐ 單調性:口訣說「陰 > 陽」的話,邊際應該從大陰到大陽單調遞減
    if (g === 'G1' && rows.length >= 5) {
        const seq = rows.map(r => r[1]);
        const down = seq.every((v, i) => i === 0 || v <= seq[i - 1] + 1e-9);
        const up = seq.every((v, i) => i === 0 || v >= seq[i - 1] - 1e-9);
        console.log(`  🔎 單調性(大陰→大陽):${down ? '✅ 單調遞減 = 口訣方向成立' : up ? '🚨 單調遞增 = **跟口訣相反**' : '➖ 不單調 = 沒有一致的方向'}`);
        gout.monotonic = down ? 'down' : up ? 'up' : 'none';
    }
    gout.window = gWin[g]; report.groups[g] = gout;
    console.log();
}
console.log('═'.repeat(78));
console.log('🚨 「絕對(10)」= 那一桶自己的 10 日超額。⭐ 邊際為正 ≠ 賺得到 —— 對照組本身就是負的');
console.log('   (中位數個股本來就輸市值加權的大盤,同 _SIGNAL_EDGE 基準勝率 36.4% 那條)。');
console.log('⚠️ 報酬已扣同期加權指數,⛔ 不含股利;「扣成本」是嚴格版(邊際 − 0.44%,假設不做這筆就不付成本)。');
console.log('⚠️ 倖存者偏誤:已下市的不在 data/ 裡。「陰/陽」是**日 K** 代理,⛔ 不等於口訣講的盤中。');
console.log('⛔ 這是探針不是測試(exit 0);要接進 App 之前必須六關全過 + 第七關「買得到嗎」已內建(排除 t+1 開盤漲停 + 20 日均額 ≥ 3,000 萬)。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`\n💾 ${OUT}`); }
