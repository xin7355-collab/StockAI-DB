#!/usr/bin/env node
/**
 * 🎯 老余交易夜(裸 K 價格行為)—— 把「日 K 量得到、而且本站沒測過」的那幾條一次量完(評估紀錄㉘)
 *
 * 使用者上傳 19 份逐字稿(2023-11 ~ 2026-09)。⭐ 照 V77.0.1 口訣那次的鐵則,**第一步查登記表**:
 *   ~60 條主張裡,位置(區間下緣做多)/ 單根尖尖的 / 假跌破站回 / 互換 / 翻亞當出場 / 出一留一 /
 *   拉不賠 / 賺賠比門檻 / 結算日與月底月初 / 缺口 / 兇 K 隔壁 / 長上影隔壁 / K 棒變小 ……
 *   全部在 `_SIGNAL_EDGE`(129 訊號)/ `_STREAK_EDGE` / genezone / calendar / 28 種出場 / 停損距離 裡有答案
 *   (清單在 docs/EXTERNAL_REVIEWS.md ㉘ 的 A 表)。這一支只測**真的沒切過的條件**:
 *
 *   G1 尖尖的 × 位置 × 邊界(他整套的核心過濾器;本站只測過「任何位置的長下影線」= C 級 −0.19pp)
 *      對照組 = **所有尖尖的**(⛔ 不拿全市場當對照 —— 否則量到的是「尖尖的」本身)
 *      桶:真破邊界後收回 / 60 日區間位階下中上 / 一年位階 / 擋子彈 / 撞牆 / 兇K序列後的下影十字 /
 *          連續下影線根數 / 兩隻腳 / ⭐ 三問疊加(位置 → 慣性 → 圖,順序照他說的不能倒)
 *   G2 標準圖形狀(中段凶、兩端小、底部平)疊在「真破後收回」之上;互換(突破整理區後回測)的否決條件
 *      對照組 = 各自的母集(真破後收回全體 / 回測全體)
 *   G3 空方三條(下降三角 / 突破不續攻 / 樓梯爛掉)—— 用**空方尺**(10 日邊際 < 0 且 p ≤ 0.25;V76.1.7)
 *      對照組 = 所有(股·日);順便重現「長上影線隔壁」當管線自檢(本站 A 級但只有 −0.06pp)
 *
 * ⛔ 七道關卡:① 全期同向 ② 前後半同向 ③ 逐年同向 ④ 去最好年仍成立 ⑤ 扣成本 0.44 ⑥ z 檢定 p ≤ 0.05
 *   ⑦ 買得到(排除 t+1 開盤漲停 + 20 日均額 ≥ 3,000 萬)。門檻高原:主張的門檻左右各挪兩格。
 *
 * 🚨 方法論(每一條都是本 repo 踩過的坑):
 *   ・前視:條件用 t 日收盤後才知道的資料,進場 t+1 開盤(`gap_probe.mjs:11`)。他自己也講「K 棒要先停住」。
 *   ・基準區間 ⛔ 不含被判斷的那幾根(陷阱 #43):邊界 L20 / ATR / 撞牆密集帶一律 `[t-N, t-1]`;位階含今日是對的。
 *   ・對照組要是同一個母集(V74.4.1 板塊內挑法的教訓)。
 *   ・空方尺 ⛔ 不可跟多方尺互換(V76.1.7)。
 *
 * ⚠️ 已知限制(⛔ 報告裡不可省):倖存者偏誤 / 日 K 是他盤中定義的**代理** / 只做多方(他 2022 後只做多)/
 *   不含股利 / 「邊界」用 20 日最低價代理,他的「多人碰的價格帶」沒有精準定義 / 標準圖的左右寬度比沒量(要人判)。
 *
 * 用法:
 *   DATA_DIR=<合併過 klines_deep 的目錄> node --max-old-space-size=6144 scripts/laoyu_probe.mjs [輸出.json]
 *   node scripts/laoyu_probe.mjs --selftest
 * ⛔ 只讀、不打 API、不寫部署產物。exit 0(探針不進四驗證)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';

const COST = 0.44;
const HOLDS = [5, 10, 20];
const DEDUP = 20;
const MIN_EV = 400;
const WARM = 250;          // 一年位階要 250 根
const ATR_N = 20;
const BND_N = 20;          // 邊界 = 前 20 根最低(⛔ 不含今日)
const RNG_N = 60;          // 60 日區間位階
const LIQ_MIN = 3e7;
const LIMIT_UP = 1.095;
const PIN_LOWER = 0.5;     // 下影 ≥ 全距 50%
const PIN_BODY = 0.4;      // 實體 ≤ 全距 40%
const BREAK_ATR = 0.1;     // 真破 = 低點 < 邊界 − 0.1·ATR
const SHIELD_MIN = 3;      // 擋子彈:下方 1.5·ATR 內近 20 根 ≥3 根覆蓋
const WALL_MIN = 3;        // 撞牆:上方 1·ATR 內近 60 根 ≥3 個高點

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const f2 = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
};
const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);

// 每組的對照組桶 + 方向尺
const BASE_OF = { G1: 'PIN_ALL', G2: 'BRK_ALL', G2S: 'RT_ALL', G3: 'ALL' };
const DIR_OF = { G1: +1, G2: +1, G2S: +1, G3: -1 };

// ═══════════ 累加器 ═══════════
const mk = () => HOLDS.map(() => ({ n: 0, s: 0, ss: 0, w: 0 }));
const ACC = new Map();
const SKIP = { limitUp: 0, illiquid: 0 };
function bump(g, b, y, half, rets) {
    const k = `${g}|${b}`;
    let a = ACC.get(k);
    if (!a) { a = { all: mk(), byYear: new Map(), byHalf: [mk(), mk()] }; ACC.set(k, a); }
    let yy = a.byYear.get(y); if (!yy) { yy = mk(); a.byYear.set(y, yy); }
    for (let i = 0; i < HOLDS.length; i++) {
        const v = rets[i]; if (v === null) continue;
        for (const t of [a.all[i], yy[i], a.byHalf[half][i]]) { t.n++; t.s += v; t.ss += v * v; if (v > 0) t.w++; }
    }
}
const stat = t => t.n ? { n: t.n, m: t.s / t.n, v: Math.max(0, t.ss / t.n - (t.s / t.n) ** 2), w: t.w / t.n * 100 } : { n: 0, m: 0, v: 0, w: 0 };
const margin = (a, b) => {
    const A = stat(a), B = stat(b);
    if (!A.n || !B.n) return { n: A.n, d: 0, z: 0, p: 1 };
    const se = Math.sqrt(A.v / A.n + B.v / B.n);
    const z = se > 0 ? (A.m - B.m) / se : 0;
    return { n: A.n, d: A.m - B.m, z, p: pTwoSided(z) };
};

function loadTwii() {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
        .map(r => ({ d: nd(r.date), c: +r.close }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.c > 0)
        .sort((a, b) => a.d < b.d ? -1 : 1);
    return { days: rows.map(r => r.d), c: new Map(rows.map(r => [r.d, r.c])) };
}

// ═══════════ 逐檔掃(streaming)═══════════
function scanSymbol(rows, TW, halfCut, dateTally) {
    const n = rows.length;
    if (n < WARM + 30) return 0;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
    const vol = new Float64Array(n), amt = new Float64Array(n), dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        o[i] = +r.open; h[i] = +r.high; l[i] = +r.low; c[i] = +r.close; vol[i] = +r.volume || 0;
        amt[i] = c[i] * vol[i]; dt[i] = nd(r.date);
    }
    // 斷崖守門(短探針慣例):相鄰收盤 ±40% → 這檔資料不可信,整檔不跑
    for (let i = 1; i < n; i++) if (c[i] > 0 && c[i - 1] > 0 && (c[i] / c[i - 1] > 1.4 || c[i] / c[i - 1] < 0.6)) return 0;

    const last = new Map();
    let ev = 0;
    // 突破紀錄(給互換 / 樓梯爛掉用):{b, H, L, stood}
    const brks = [];

    for (let t = WARM; t < n - 1; t++) {
        if (!(o[t] > 0 && h[t] > 0 && l[t] > 0 && c[t] > 0 && h[t] >= l[t])) continue;
        // ATR20(⛔ 不含今日)
        let trs = 0, trc = 0;
        for (let k = t - ATR_N; k < t; k++) {
            if (!(c[k - 1] > 0 && h[k] >= l[k])) continue;
            trs += Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1])); trc++;
        }
        if (trc < ATR_N * 0.8) continue;
        const atr = trs / trc; if (!(atr > 0)) continue;
        // 流動性 + t+1 漲停
        let aSum = 0, aCnt = 0;
        for (let k = t - 20; k < t; k++) if (amt[k] > 0) { aSum += amt[k]; aCnt++; }
        if (!aCnt || aSum / aCnt < LIQ_MIN) { SKIP.illiquid++; continue; }
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
            if (dateTally) { if (b === BASE_OF[g]) dateTally[g].set(dt[t], (dateTally[g].get(dt[t]) || 0) + 1); return; }
            bump(g, b, y, dt[t] < halfCut[g] ? 0 : 1, rets);
        };

        // ── 共用幾何(全部 ⛔ 不含今日)──
        let L20 = Infinity, H20 = -Infinity;
        for (let k = t - BND_N; k < t; k++) { if (l[k] > 0 && l[k] < L20) L20 = l[k]; if (h[k] > H20) H20 = h[k]; }
        let L60 = Infinity, H60 = -Infinity;
        for (let k = t - RNG_N + 1; k <= t; k++) { if (l[k] > 0 && l[k] < L60) L60 = l[k]; if (h[k] > H60) H60 = h[k]; }   // 位階含今日
        let L250 = Infinity, H250 = -Infinity;
        for (let k = t - WARM + 1; k <= t; k++) { if (l[k] > 0 && l[k] < L250) L250 = l[k]; if (h[k] > H250) H250 = h[k]; }
        const pos60 = H60 > L60 ? (c[t] - L60) / (H60 - L60) : 0.5;
        const pos250 = H250 > L250 ? (c[t] - L250) / (H250 - L250) : 0.5;
        const rng = h[t] - l[t], body = Math.abs(c[t] - o[t]);
        const lower = Math.min(o[t], c[t]) - l[t], upper = h[t] - Math.max(o[t], c[t]);
        const lowerR = rng > 0 ? lower / rng : 0, upperR = rng > 0 ? upper / rng : 0, bodyR = rng > 0 ? body / rng : 1;

        fire('G3', 'ALL');

        // ══ G1 尖尖的 × 位置 ══
        const pin = rng > 0 && lowerR >= PIN_LOWER && bodyR <= PIN_BODY;
        if (pin) {
            fire('G1', 'PIN_ALL');
            const broke = l[t] < L20 - BREAK_ATR * atr && c[t] > L20;      // 真破後收回(單根破底翻)
            fire('G1', broke ? '真破邊界後收回' : '沒破(只是縮回來)');
            fire('G1', pos60 < 1 / 3 ? '60日位階 下1/3' : pos60 <= 2 / 3 ? '60日位階 中1/3' : '60日位階 上1/3');
            fire('G1', pos250 < 1 / 3 ? '一年位階 <33%' : pos250 <= 2 / 3 ? '一年位階 33~67%' : '一年位階 >67%');
            // 擋子彈:進場價(≈今收)下方 1.5·ATR 內,近 20 根有幾根 K 的 [低,高] 蓋到
            let shield = 0;
            for (let k = t - 20; k < t; k++) if (l[k] <= c[t] && h[k] >= c[t] - 1.5 * atr) shield++;
            fire('G1', shield >= SHIELD_MIN ? '擋子彈 有(≥3根)' : '擋子彈 無');
            // 撞牆:上方 1·ATR 內,近 60 根有幾根的高點落在裡面
            let wall = 0;
            for (let k = t - 60; k < t; k++) if (h[k] > c[t] && h[k] <= c[t] + atr) wall++;
            fire('G1', wall >= WALL_MIN ? '撞牆 有(上方≥3高點)' : '撞牆 無');
            // 兇K序列 → 下影十字(21 點 Double):前 3 根皆黑、合計實體 ≥ 2.5·ATR、實體遞減;今日實體 ≤ 20% 全距
            const b1 = o[t - 3] - c[t - 3], b2 = o[t - 2] - c[t - 2], b3 = o[t - 1] - c[t - 1];
            if (b1 > 0 && b2 > 0 && b3 > 0 && b1 + b2 + b3 >= 2.0 * atr && b1 >= b2 && b2 >= b3 && bodyR <= 0.25) fire('G1', '兇K序列後的下影十字');
            // 連續下影線根數(近 5 根含今日,下影 ≥40% 全距)
            let cnt = 0;
            for (let k = t - 4; k <= t; k++) { const rk = h[k] - l[k]; if (rk > 0 && (Math.min(o[k], c[k]) - l[k]) / rk >= 0.4) cnt++; }
            fire('G1', cnt >= 3 ? '連續下影 3根+' : cnt === 2 ? '連續下影 2根' : '連續下影 1根');
            // 兩隻腳:[t-30, t-3] 兩個局部低點 |L1−L2| ≤ 0.3·ATR,今日破它們再收回
            const lows = [];
            for (let k = t - 30; k <= t - 3; k++) if (l[k] > 0 && l[k] < l[k - 1] && l[k] < l[k - 2] && l[k] < l[k + 1] && l[k] < l[k + 2]) lows.push(l[k]);
            let twoFeet = false;
            for (let i = 0; i < lows.length && !twoFeet; i++) for (let j = i + 1; j < lows.length; j++) {
                if (Math.abs(lows[i] - lows[j]) <= 0.3 * atr) { const m = Math.min(lows[i], lows[j]); if (l[t] < m && c[t] > m) { twoFeet = true; break; } }
            }
            if (twoFeet) fire('G1', '兩隻腳(兩點一線後破再收回)');
            // 慣性 = 最近 3 個轉折低點遞升(fractal ±2,窗口 [t-60, t-3])—— 獨立一桶
            //   ⚠️ 它跟「真破」天生互斥(真破 = 創 20 日新低,低點就不可能遞升)→ ⛔ 不可疊在破底翻上面,
            //      他的「慣性」是在更小刻度看的,日 K 只能各測各的。
            const sl = [];
            for (let k = t - 60; k <= t - 3; k++) if (l[k] > 0 && l[k] < l[k - 1] && l[k] < l[k - 2] && l[k] < l[k + 1] && l[k] < l[k + 2]) sl.push(l[k]);
            const inertia = sl.length >= 3 && sl[sl.length - 1] > sl[sl.length - 2] && sl[sl.length - 2] > sl[sl.length - 3];
            fire('G1', inertia ? '慣性 低點遞升(漲多跌少)' : '慣性 不成立');
            // ⭐ 三問疊加(日 K 量得到的版本):位置 → 圖(真破後收回)→ 乾淨(不撞牆)→ 擋子彈
            if (pos60 < 1 / 3) {
                fire('G1', '三問① 位置(下1/3)');
                if (broke) {
                    fire('G1', '三問② +圖(真破後收回)');
                    if (wall < WALL_MIN) {
                        fire('G1', '三問③ +不撞牆');
                        if (shield >= SHIELD_MIN) fire('G1', '三問④ +擋子彈');
                    }
                }
            }
            // 門檻高原:真破後收回 × 下影比例門檻 / 破深門檻
            if (broke) {
                for (const th of [0.4, 0.5, 0.6, 0.7]) if (lowerR >= th) fire('G1', `  └ 真破收回·下影≥${th}`);
                for (const dp of [0, 0.1, 0.25, 0.5]) if (l[t] < L20 - dp * atr) fire('G1', `  └ 真破收回·破深≥${dp}ATR`);
            }
            // ══ G2 標準圖形狀(疊在真破後收回之上)══
            if (broke) {
                fire('G2', 'BRK_ALL');
                let midBig = false, headSmall = true, tailSmall = true;
                for (let k = t - 13; k <= t - 6; k++) if (c[k] < o[k] && o[k] - c[k] >= 1.0 * atr) midBig = true;
                for (let k = t - 19; k <= t - 14; k++) if (Math.abs(c[k] - o[k]) > 0.8 * atr) headSmall = false;
                for (let k = t - 5; k <= t - 1; k++) if (Math.abs(c[k] - o[k]) > 0.8 * atr) tailSmall = false;
                let tl = Infinity, th2 = -Infinity;
                for (let k = t - 5; k <= t - 1; k++) { if (l[k] < tl) tl = l[k]; if (l[k] > th2) th2 = l[k]; }
                const flatBase = th2 - tl <= 0.8 * atr;
                const shape = midBig && headSmall && tailSmall && flatBase;
                fire('G2', shape ? '標準圖(中段凶·兩端小·底平)' : '不符形狀');
                fire('G2', midBig ? '  只有 中段凶' : '  中段不凶');
                fire('G2', tailSmall && flatBase ? '  只有 尾段小且底平' : '  尾段不小/底不平');
            }
        }

        // ══ 互換 / 樓梯爛掉:先更新突破紀錄 ══
        // 整理區 = [t-15, t-1] 全距 ≤ 5·ATR;突破 = 今收 > 區間高
        {
            let bh = -Infinity, bl = Infinity;
            for (let k = t - 15; k < t; k++) { if (h[k] > bh) bh = h[k]; if (l[k] > 0 && l[k] < bl) bl = l[k]; }
            const box = bh - bl <= 5 * atr;
            if (box && c[t] > bh && !(c[t - 1] > bh)) brks.push({ b: t, H: bh, L: bl, stood: 1, done: false, rt: false });
        }
        for (const B of brks) {
            if (B.done || t === B.b) continue;
            const age = t - B.b;
            if (age > 30) { B.done = true; continue; }
            if (c[t] > B.H) B.stood++;
            // 互換回測:低點碰到 H(±0.5%)—— 每個突破只算第一次回測
            if (!B.rt && age >= 2 && age <= 15 && l[t] <= B.H * 1.005 && l[t] >= B.L) {
                if (c[t] > B.H) {
                    fire('G2S', 'RT_ALL'); fire('G2S', '回測站穩(收在H之上)');
                    fire('G2S', upperR >= 0.5 ? '  回測·帶長上影(他說爛掉)' : '  回測·沒長上影');
                    B.rt = true;
                } else if (c[t] > B.L) {
                    fire('G2S', 'RT_ALL'); fire('G2S', '回測掉進區間內側(他說爛掉)');
                    B.rt = true; B.done = true;       // 掉進內側 = 樓梯已經沒了,不再算「爛掉」
                }
            }
            // 樓梯爛掉:站上 ≥3 根後收回 H 之下(空方)—— 跟回測是兩件事,各自獨立
            if (!B.done && B.stood >= 3 && c[t] < B.H) { fire('G3', '樓梯爛掉(站上≥3根後收回)'); B.done = true; }
        }
        while (brks.length && brks[0].done) brks.shift();
        if (brks.length > 30) brks.splice(0, brks.length - 30);

        // ══ G3 空方 ══
        // 突破不續攻:昨收 > 前 20 根高(不含昨日),今收又掉回那個高之下
        {
            let hh = -Infinity;
            for (let k = t - 21; k < t - 1; k++) if (h[k] > hh) hh = h[k];
            if (c[t - 1] > hh && c[t] < hh) fire('G3', '突破不續攻(昨破20日高·今收回)');
        }
        // 下降三角:近 20 根高點回歸斜率 ≤ −0.05·ATR/根,且最低 3 個低點全距 ≤ 0.5·ATR
        {
            let sx = 0, sy = 0, sxy = 0, sxx = 0, N = 20;
            const ls = [];
            for (let i = 0; i < N; i++) { const k = t - N + 1 + i; sx += i; sy += h[k]; sxy += i * h[k]; sxx += i * i; ls.push(l[k]); }
            const slope = (N * sxy - sx * sy) / (N * sxx - sx * sx);
            ls.sort((a, b) => a - b);
            if (slope <= -0.05 * atr && ls[2] - ls[0] <= 0.5 * atr) fire('G3', '下降三角(上斜下平)');
            // 門檻高原:斜率 × 平坦 3×3(⛔ 只有中間那格好 = 孤峰)
            for (const sk of [0.03, 0.05, 0.08]) for (const fl of [0.3, 0.5, 0.8])
                if (slope <= -sk * atr && ls[2] - ls[0] <= fl * atr) fire('G3', `  └ 三角·斜率≤-${sk}ATR·平≤${fl}ATR`);
        }
        // 長上影線隔壁(管線自檢:本站 A 級 −0.06pp)
        if (rng > 0 && upperR >= 0.5 && bodyR <= 0.4) fire('G3', '長上影線(自檢用)');
    }
    return ev;
}

// ═══════════ 關卡 ═══════════
function gates(a, base, hi, dir = +1) {
    const M = margin(a.all[hi], base.all[hi]);
    const H = [0, 1].map(k => margin(a.byHalf[k][hi], base.byHalf[k][hi]).d);
    const yrs = [...a.byYear.keys()].sort();
    const YR = yrs.map(y => ({ y, n: a.byYear.get(y)[hi].n, d: base.byYear.has(y) ? margin(a.byYear.get(y)[hi], base.byYear.get(y)[hi]).d : 0 }))
        .filter(x => x.n >= 20);
    const sgn = dir;
    const sameHalf = H.every(d => Math.sign(d) === sgn);
    const sameYear = YR.length >= 3 && YR.every(x => Math.sign(x.d) === sgn);
    let dropBest = 0;
    if (YR.length >= 3) {
        const bi = YR.reduce((b, x, i) => (sgn > 0 ? x.d > YR[b].d : x.d < YR[b].d) ? i : b, 0);
        const rest = YR.filter((_, i) => i !== bi);
        const tot = rest.reduce((s, x) => s + x.n, 0);
        dropBest = tot ? rest.reduce((s, x) => s + x.d * x.n, 0) / tot : 0;
    }
    const pass = {
        '①全期': Math.sign(M.d) === sgn && M.d !== 0,
        '②前後半': sameHalf,
        '③逐年': sameYear,
        '④去最好年': Math.sign(dropBest) === sgn && dropBest !== 0,
        '⑤扣成本': sgn * M.d - COST > 0,
        '⑥檢定': M.p <= 0.05,
    };
    const bearRuler = dir < 0 ? (M.d < 0 && M.p <= 0.25) : null;   // V76.1.7 空方尺
    return { M, H, YR, dropBest, pass, nPass: Object.values(pass).filter(Boolean).length, bearRuler };
}

// ═══════════ selftest ═══════════
function mkDays(NBAR) {
    const days = []; let d = new Date(Date.UTC(2021, 0, 4));
    for (let i = 0; i < NBAR; i++) {
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5);
        days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5);
    }
    return days;
}
function selftest() {
    console.log('🧪 selftest —— 合成資料注入已知邊際,確認探針量得到\n');
    let bad = 0;
    const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    const NBAR = 1400, days = mkDays(NBAR);
    const TW = { days, c: new Map(days.map(x => [x, 10000])) };
    const half = { G1: days[700], G2: days[700], G2S: days[700], G3: days[700] };

    // ── 案例 A:尖尖的 + 真破邊界後收回,之後**第 10 日起**多給 +3%(⛔ 5 日不給 → 抓前視)──
    //    另外一半的尖尖的「沒破」不給 lift → 「真破後收回」桶的邊際應 ≈ +3 vs PIN_ALL 的一半
    ACC.clear();
    const INJECT = 3.0, NSYM = 30, MINGAP = 45;
    let ev = 0, pinTot = 0;
    for (let s = 0; s < NSYM; s++) {
        const rnd = (x => () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(777 + s * 131);
        const rows = []; let px = 100, lastPin = -MINGAP;
        const kind = new Array(NBAR).fill(0);       // 1 = 真破收回 pin, 2 = 沒破 pin
        for (let i = 0; i < NBAR; i++) {
            let op = px, cl, hi, lo;
            const gap = (i > 0 && kind[i - 1] === 1) ? 0.02 : 0;   // ⭐ 只有「真破收回」那種隔天開高 2%(只有前視才偷得到;兩種都開高會互相抵銷 → 注入叫不出來,第一版就是這樣)
            op = px * (1 + gap);
            if (i >= 300 && i - lastPin >= MINGAP && rnd() < 0.03) {
                let L20 = Infinity; for (let k = i - 20; k < i; k++) L20 = Math.min(L20, rows[k].low);
                const isBreak = rnd() < 0.5;
                kind[i] = isBreak ? 1 : 2; lastPin = i;
                cl = op * 0.998;                                    // 小實體
                // 真破 vs 沒破:沒破的低點必須**嚴格**在 L20 之上(第一版用 min(...) 會讓一部分「沒破」其實破了 → 桶被污染、邊際被稀釋)
                lo = isBreak ? L20 * 0.985 : Math.max(L20 * 1.003, cl * 0.985);
                hi = op * 1.001;
                if (isBreak && cl <= L20) cl = L20 * 1.002;          // 收回邊界上
            } else {
                const ch = (rnd() - 0.5) * 0.02; cl = op * (1 + ch);
                hi = Math.max(op, cl) * 1.004; lo = Math.min(op, cl) * 0.999;   // ⛔ 隨機日不可有下影(否則它們自己就是尖尖的,把對照組稀釋掉)
            }
            rows.push({ date: days[i], open: op, high: hi, low: lo, close: cl, volume: 5e6 }); px = cl;
        }
        for (let t = 0; t < NBAR; t++) {
            if (kind[t] !== 1) continue;
            pinTot++;
            const x = t + 11; if (x >= NBAR) continue;
            for (let k = x; k < NBAR; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= (1 + INJECT / 100);
        }
        ev += scanSymbol(rows, TW, half, null);
    }
    const g = ACC.get('G1|真破邊界後收回'), all = ACC.get('G1|PIN_ALL'), nb = ACC.get('G1|沒破(只是縮回來)');
    ck(ev > 300 && pinTot > 100, `案例A:事件 ${ev} ・注入 ${pinTot} 次(🚧 空過守門)`);
    ck(!!g && g.all[1].n >= 60 && !!nb && nb.all[1].n >= 60, `案例A:真破後收回 n=${g ? g.all[1].n : 0} ・沒破 n=${nb ? nb.all[1].n : 0}(🚨 真破 =0 代表 L20 把今日自己算進去了,陷阱 #43)`);
    if (g && all) {
        const m10 = margin(g.all[1], all.all[1]).d, m5 = margin(g.all[0], all.all[0]).d;
        ck(m10 > INJECT * 0.3, `案例A:10 日邊際 ${f2(m10)}pp(注入 +${INJECT};對照組含「沒破」那些沒 lift 的 → 期望約 +1.0~1.5)`);
        ck(Math.abs(m5) < 0.5, `案例A:5 日邊際 ${f2(m5)}pp 必須 ≈0(注入只在第 10 日後;隔天開高 2% 只有「進場用 t 收盤」才偷得到)`);
        const G = gates(g, all, 1);
        ck(G.pass['⑥檢定'], `案例A:關卡⑥ 叫得出來(p=${G.M.p.toFixed(5)})`);
        const nbm = margin(nb.all[1], all.all[1]).d;
        ck(nbm < 0, `案例A:「沒破」那桶必須為負(${f2(nbm)}pp)—— 兩桶反號才證明分桶分對了`);
    }
    // ── 案例 B:去重 —— 連續 3 天同型事件只能算 1 次 ──
    ACC.clear();
    {
        const rows = []; let px = 100;
        for (let i = 0; i < 400; i++) {
            const isPin = i >= 350 && i <= 352;
            const op = px, cl = isPin ? op * 0.999 : op * (1 + ((i % 7) - 3) * 0.002);
            const lo = isPin ? Math.min(op, cl) * 0.97 : Math.min(op, cl) * 0.999, hi = Math.max(op, cl) * 1.002;
            rows.push({ date: days[i], open: op, high: hi, low: lo, close: cl, volume: 5e6 }); px = cl;
        }
        scanSymbol(rows, TW, half, null);
        const p = ACC.get('G1|PIN_ALL');
        ck(!!p && p.all[0].n === 1, `案例B:連續 3 天尖尖的只算 1 次(n=${p ? p.all[0].n : 0})`);
    }
    // ── 案例 C:t+1 開盤漲停要被剔除(第七關)──
    ACC.clear();
    {
        const rows = []; let px = 100;
        for (let i = 0; i < 400; i++) {
            const isPin = i === 350;
            let op = px; if (i === 351) op = px * 1.10;
            const cl = isPin ? op * 0.999 : op * (1 + ((i % 7) - 3) * 0.002);
            const lo = isPin ? Math.min(op, cl) * 0.97 : Math.min(op, cl) * 0.999, hi = Math.max(op, cl) * 1.002;
            rows.push({ date: days[i], open: op, high: hi, low: lo, close: cl, volume: 5e6 }); px = cl;
        }
        SKIP.limitUp = 0;
        scanSymbol(rows, TW, half, null);
        const p = ACC.get('G1|PIN_ALL');
        ck(!p && SKIP.limitUp >= 1, `案例C:隔天開盤漲停的尖尖的要被擋掉(n=${p ? p.all[0].n : 0}、擋 ${SKIP.limitUp})`);
    }
    // ── 案例 D:空方 —— 下降三角之後注入 −3%,空方尺要叫得出來;而多方尺 ⛔ 不可放行 ──
    ACC.clear();
    {
        let evD = 0, tri = 0;
        for (let s = 0; s < 20; s++) {
            const rnd = (x => () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(99 + s * 17);
            const rows = []; let px = 100; const mark = [];
            for (let i = 0; i < NBAR; i++) {
                let op = px, cl, hi, lo;
                // 每 60 根排一個 20 根的下降三角:高點每根降 0.4%、低點平
                const ph = i % 60;
                if (i >= 300 && ph < 20) {
                    const base = rows[i - ph - 1].close;
                    lo = base * 0.985; hi = base * (1.06 - ph * 0.004); op = base * (1 + (rnd() - 0.5) * 0.01); cl = base * (1 + (rnd() - 0.5) * 0.01);
                    hi = Math.max(hi, op, cl); lo = Math.min(lo, op, cl);
                    if (ph === 19) mark.push(i);
                } else {
                    // 隨機段**緩漲**(+0.4%/根):三角前的低點都比三角底低 → 「3 個最低點要平」只在窗口幾乎全是三角時成立
                    //   → 觸發集中在三角第 15~19 根(實測),20 日去重後每個三角只觸發一次
                    cl = op * (1 + 0.004 + (rnd() - 0.5) * 0.01); hi = Math.max(op, cl) * 1.003; lo = Math.min(op, cl) * 0.996;
                }
                rows.push({ date: days[i], open: op, high: hi, low: lo, close: cl, volume: 5e6 }); px = cl;
            }
            // 🚨 注入放在三角**結束後**(mark+1),而且⛔ 不可放在三角裡面 —— 放進去會改變三角的形狀,
            //    偵測器就改在 lift 之後才觸發(第三版量到 +2.43 = 反號)。要讓觸發「一定發生在三角尾端」靠的是
            //    上面那個緩漲的隨機段,不是靠挪注入點(前兩版就是這樣一直猜)。
            for (const t of mark) { tri++; const x = t + 1; if (x >= NBAR) continue; for (let k = x; k < NBAR; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= 0.92; }
            evD += scanSymbol(rows, TW, half, null);
        }
        const a = ACC.get('G3|下降三角(上斜下平)'), b = ACC.get('G3|ALL');
        ck(!!a && a.all[1].n >= 100, `案例D:下降三角事件 n=${a ? a.all[1].n : 0}(注入 ${tri} 次)`);
        if (a && b) {
            const G = gates(a, b, 1, -1), Gpos = gates(a, b, 1, +1);
            ck(G.bearRuler === true && G.M.d < -2, `案例D:空方尺叫得出來(10 日 ${f2(G.M.d)}pp、p=${G.M.p.toFixed(4)})`);
            ck(!Gpos.pass['①全期'], `案例D:同一桶用多方尺 ⛔ 不可放行(①全期 = ${Gpos.pass['①全期']})`);
        }
    }
    // ── 案例 E:互換 —— 突破整理區後回測站穩要偵測到;回測時帶長上影要分到「爛掉」桶 ──
    ACC.clear();
    {
        const rows = []; let px = 100;
        const build = (i, op, cl, hi, lo) => rows.push({ date: days[i], open: op, high: hi, low: lo, close: cl, volume: 5e6 });
        for (let i = 0; i < 400; i++) {
            if (i < 340) { const cl = 100 + ((i % 5) - 2) * 0.3; build(i, 100, cl, 101, 99); px = cl; continue; }   // 整理區 99~101
            if (i === 340) { build(i, 100.5, 104, 104.2, 100.4); px = 104; continue; }                     // 突破
            if (i === 341) { build(i, 104, 104.5, 105, 103.8); px = 104.5; continue; }
            if (i === 342) { build(i, 104.5, 102.5, 104.6, 100.8); px = 102.5; continue; }                 // 回測:低點碰 H=101 ±0.5%,收在 H 上,無長上影
            if (i === 343) { build(i, 102.5, 103, 103.5, 102); px = 103; continue; }
            build(i, px, px, px * 1.002, px * 0.998);
        }
        scanSymbol(rows, TW, half, null);
        const a = ACC.get('G2S|回測站穩(收在H之上)'), rt = ACC.get('G2S|RT_ALL'), bad2 = ACC.get('G2S|  回測·帶長上影(他說爛掉)');
        ck(!!a && a.all[0].n === 1 && !!rt && rt.all[0].n === 1 && !bad2, `案例E:互換回測偵測到 1 次(n=${a ? a.all[0].n : 0})、沒被分到長上影桶`);
    }
    console.log('\n' + (bad ? `❌ SELFTEST_FAIL:${bad} 條` : '✅ SELFTEST_PASS'));
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) selftest();

// ═══════════ 實跑 ═══════════
const TW = loadTwii();
console.log(`📅 大盤日曆 ${TW.days[0]} ~ ${TW.days[TW.days.length - 1]}(${TW.days.length} 個交易日)`);
if (TW.days[0] > '2022-06-01') console.log('🚨 窗口沒有涵蓋 2022 空頭 → 逐年那關的意義大打折扣(要用合併過深歷史的 DATA_DIR)');
const files = fs.readdirSync(DATA).filter(x => /^\d{4}[A-Z]?\.json$/.test(x));
const readRows = fn => {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { return null; }
    if (!Array.isArray(rows) || rows.length < WARM + 60) return null;
    rows.sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
    return rows;
};
const tally = { G1: new Map(), G2: new Map(), G2S: new Map(), G3: new Map() };
for (const fn of files) { const r = readRows(fn); if (r) scanSymbol(r, TW, null, tally); }
const halfCut = {}, gWin = {};
for (const g of Object.keys(tally)) {
    const ds = [...tally[g].entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const tot = ds.reduce((s, x) => s + x[1], 0);
    let acc = 0, cut = ds.length ? ds[ds.length - 1][0] : '9999';
    for (const [d, n] of ds) { acc += n; if (acc >= tot / 2) { cut = d; break; } }
    halfCut[g] = cut; gWin[g] = ds.length ? [ds[0][0], ds[ds.length - 1][0], cut, tot] : ['—', '—', '—', 0];
}
SKIP.limitUp = 0; SKIP.illiquid = 0;
let used = 0, evTot = 0;
for (const fn of files) { const rows = readRows(fn); if (!rows) continue; const e = scanSymbol(rows, TW, halfCut, null); if (e) { used++; evTot += e; } }
console.log(`📊 掃 ${used} 檔 ・事件 ${evTot.toLocaleString()} 筆(同檔同桶 ${DEDUP} 日去重)`);
console.log(`🛒 第七關「買得到嗎」擋掉:t+1 開盤漲停 ${SKIP.limitUp.toLocaleString()} ・20 日均額 < 3,000 萬 ${SKIP.illiquid.toLocaleString()} 個(股·日)\n`);

const GROUPS = [
    ['G1', '🎯 G1 尖尖的 × 位置 × 邊界(對照組 = 所有尖尖的)', 'PIN_ALL',
     ['真破邊界後收回', '沒破(只是縮回來)', '60日位階 下1/3', '60日位階 中1/3', '60日位階 上1/3', '一年位階 <33%', '一年位階 33~67%', '一年位階 >67%',
      '擋子彈 有(≥3根)', '擋子彈 無', '撞牆 有(上方≥3高點)', '撞牆 無', '兇K序列後的下影十字', '連續下影 1根', '連續下影 2根', '連續下影 3根+',
      '兩隻腳(兩點一線後破再收回)', '慣性 低點遞升(漲多跌少)', '慣性 不成立', '三問① 位置(下1/3)', '三問② +圖(真破後收回)', '三問③ +不撞牆', '三問④ +擋子彈',
      '  └ 真破收回·下影≥0.4', '  └ 真破收回·下影≥0.5', '  └ 真破收回·下影≥0.6', '  └ 真破收回·下影≥0.7',
      '  └ 真破收回·破深≥0ATR', '  └ 真破收回·破深≥0.1ATR', '  └ 真破收回·破深≥0.25ATR', '  └ 真破收回·破深≥0.5ATR'],
     '尖尖的 = 下影 ≥50% 全距 ∧ 實體 ≤40%;邊界 = 前 20 根最低(⛔ 不含今日);位階含今日', +1],
    ['G2', '📐 G2 標準圖形狀(對照組 = 真破後收回全體)', 'BRK_ALL',
     ['標準圖(中段凶·兩端小·底平)', '不符形狀', '  只有 中段凶', '  中段不凶', '  只有 尾段小且底平', '  尾段不小/底不平'],
     '20 根窗口:中段 [t-13,t-6] 有 ≥1.0·ATR 黑K、頭尾段實體 ≤0.8·ATR、尾段低點全距 ≤0.8·ATR;⚠️ 左右寬度比沒量', +1],
    ['G2S', '🔁 G2 互換:突破整理區後回測(對照組 = 所有回測)', 'RT_ALL',
     ['回測站穩(收在H之上)', '  回測·沒長上影', '  回測·帶長上影(他說爛掉)', '回測掉進區間內側(他說爛掉)'],
     '整理區 = 前 15 根全距 ≤5·ATR;突破 = 收 > 區間高 H;2~15 根內低點碰 H(±0.5%);⚠️ 對照 `_STREAK_EDGE.retest` +0.73pp', +1],
    ['G3', '🐻 G3 空方(空方尺:10 日邊際 <0 且 p ≤0.25;對照組 = 所有股·日)', 'ALL',
     ['下降三角(上斜下平)', ...[0.03, 0.05, 0.08].flatMap(sk => [0.3, 0.5, 0.8].map(fl => `  └ 三角·斜率≤-${sk}ATR·平≤${fl}ATR`)), '突破不續攻(昨破20日高·今收回)', '樓梯爛掉(站上≥3根後收回)', '長上影線(自檢用)'],
     '⛔ 空方尺不可跟多方尺互換;「長上影線」是管線自檢(本站 A 級 −0.06pp)', -1],
];
const report = { window: [TW.days[0], TW.days[TW.days.length - 1]], bars: TW.days.length, syms: used, events: evTot, cost: COST, groups: {} };
for (const [g, title, baseKey, buckets, note, dir] of GROUPS) {
    const base = ACC.get(`${g}|${baseKey}`);
    console.log('═'.repeat(88));
    console.log(title); console.log(`  ${note}`);
    console.log(`  窗口 ${gWin[g][0]} ~ ${gWin[g][1]} ・前後半切點 ${gWin[g][2]}(這一組自己的中位日)`);
    if (!base || base.all[1].n < MIN_EV) { console.log(`  🚧 空過守門:對照組只有 ${base ? base.all[1].n : 0} 筆(< ${MIN_EV})→ ⛔ 不給結論\n`); report.groups[g] = { skipped: true }; continue; }
    const bm = HOLDS.map((_, i) => stat(base.all[i]));
    console.log(`  對照組 n=${base.all[1].n.toLocaleString()} ・超額 ${HOLDS.map((H, i) => `${H}日 ${f2(bm[i].m, 6)}`).join(' ・')} ・10 日勝率 ${bm[1].w.toFixed(1)}%`);
    console.log(`  ${'桶'.padEnd(30)} ${'n'.padStart(7)} ${'5日'.padStart(8)} ${'10日'.padStart(8)} ${'20日'.padStart(8)}  扣成本  勝率%  絕對10  關卡`);
    const gout = { base: { n: base.all[1].n, m: bm.map(x => x.m), w: bm[1].w }, buckets: {} };
    for (const b of buckets) {
        const a = ACC.get(`${g}|${b}`);
        if (!a || a.all[1].n < 30) { console.log(`  ${b.padEnd(30)} ${String(a ? a.all[1].n : 0).padStart(7)}   —— 樣本太少`); continue; }
        const ds = HOLDS.map((_, i) => margin(a.all[i], base.all[i]).d);
        const G = gates(a, base, 1, dir);
        const S = stat(a.all[1]);
        const flag = dir < 0 ? (G.bearRuler ? '🐻 空方尺過' : '➖ 空方尺沒過') + `(六關 ${G.nPass}/6)` : (G.nPass === 6 ? '✅ 六關全過' : `${G.nPass}/6`);
        console.log(`  ${b.padEnd(30)} ${String(G.M.n).padStart(7)} ${f2(ds[0], 8)} ${f2(ds[1], 8)} ${f2(ds[2], 8)} ${f2(dir * ds[1] - COST, 7)} ${S.w.toFixed(1).padStart(6)} ${f2(S.m, 7)}  ${flag} p=${G.M.p.toFixed(4)}`);
        gout.buckets[b] = { n: G.M.n, d: ds, abs: S.m, w: S.w, p: G.M.p, pass: G.pass, nPass: G.nPass, bearRuler: G.bearRuler, half: G.H, byYear: G.YR, dropBest: G.dropBest };
        if (G.nPass >= 4 || (dir < 0 && G.bearRuler)) {
            console.log(`      逐年:${G.YR.map(x => `${x.y} ${f2(x.d, 6)}(n=${x.n})`).join(' ・')}`);
            console.log(`      前半 ${f2(G.H[0], 6)} / 後半 ${f2(G.H[1], 6)} ・去最好年 ${f2(G.dropBest, 6)} ・${Object.entries(G.pass).map(([k, v]) => (v ? '✅' : '❌') + k).join(' ')}`);
        }
    }
    // 三問增量(G1):每疊一層 vs 上一層
    if (g === 'G1') {
        const chain = ['PIN_ALL', '三問① 位置(下1/3)', '三問② +圖(真破後收回)', '三問③ +不撞牆', '三問④ +擋子彈'];
        console.log('  ⭐ 三問疊加增量(每一層 vs 上一層,10 日):');
        for (let i = 1; i < chain.length; i++) {
            const a = ACC.get(`G1|${chain[i]}`), p = ACC.get(`G1|${chain[i - 1]}`);
            if (!a || !p || a.all[1].n < 30) { console.log(`     ${chain[i]}:樣本太少`); continue; }
            const m = margin(a.all[1], p.all[1]);
            console.log(`     ${chain[i].padEnd(28)} n=${String(a.all[1].n).padStart(6)} 增量 ${f2(m.d)}pp p=${m.p.toFixed(4)} ・絕對 ${f2(stat(a.all[1]).m)}%`);
            gout.buckets[chain[i]] && (gout.buckets[chain[i]].inc = { d: m.d, p: m.p, vs: chain[i - 1] });
        }
    }
    gout.window = gWin[g]; report.groups[g] = gout; console.log();
}
console.log('═'.repeat(88));
console.log('🚨 「絕對10」= 那一桶自己的 10 日超額(扣同期加權)。⭐ 邊際為正 ≠ 賺得到 —— 對照組本身就是負的。');
console.log('⚠️ 日 K 是他盤中定義的代理;只做多方;不含股利;倖存者偏誤;「邊界」用 20 日最低價代理。');
console.log('⛔ 探針不是測試(exit 0);要接進 App 必須六關全過 + V75.0.9 五條件。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`\n💾 ${OUT}`); }
