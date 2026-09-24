#!/usr/bin/env node
/**
 * 🎣 魚缸探針 —— 「魚缸每天放 N 條某種魚,隔天會有幾條漲停?這能拿來證明『很準』嗎?」(V77.5.8)
 * 只讀 data/,不打網路、不寫任何分支。
 *
 * ❓ 使用者(2026-09-24)拿外部「股王釣魚選股攻略」截圖問:
 *    「為什麼附件的釣魚系統,釣起來的魚隔天漲停那麼準?怎麼優化我的釣魚系統?」
 *    ⭐ 截圖本身的線索:魚缸標題是「台股**漲幅**排行」→ 畫面上的魚 = **今天已經漲的**。
 *
 * 📐 假說(用數字證實,⛔ 不用推論代替):
 *    「很準」是**分母錯覺** —— 每天放 N 條今天的強勢股,每條隔天漲停的機率若是 p,
 *    每天就平均有 N·p 條會漲停,而且幾乎「每天都有」;人會記得那幾條,不會記得另外那些。
 *
 * 🐟 四種魚缸(每天各取前 N 條;N = 30 / 60 / 100):
 *    P1 附件那種:今日漲幅前 N          P2 👑 今日成交額前 N(本站池子)
 *    P3 🧬 高位階+高波動(全部,檔數每天不同)   P0 對照:每天隨機抽 N 條(同母體、固定種子多次)
 *
 * ⛔ 定義一律照抄 `limitup_probe.mjs`(隔日收漲停 = 收盤漲 ≥9.5%;鎖死 = 今天漲 ≥9.5% 且收在最高 → 收盤買不到;
 *    可交易性 = 當日成交額 ≥1,000 萬;排除 00 開頭 ETF)—— 不然跟它的基準 2.94% 對不起來。
 *    🧬 門檻照抄 `kingpool_probe.mjs` 的 GENE(pos252 只用收盤 ≥75 ∧ amp20 ≥3.2 ∧ 成交額 ≥1 億)。
 *
 * 📊 每個魚缸報:每條魚隔天收漲停% / 盤中觸及% ・⭐ 每天平均幾條漲停 ・至少一條的日子% ・
 *    今天就鎖死(買不到)% ・買得到的那批:收盤買→隔天收盤 扣成本 0.44% ・觸及就掛漲停賣(+9.5%)扣成本 ・
 *    10 日超額(扣同期加權)・逐年 + 前後半。
 *
 * 用法:DATA_DIR=<合併過 klines_deep 的目錄> node --max-old-space-size=6144 scripts/pond_probe.mjs out.json
 *       node scripts/pond_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WARM = 253;          // pos252 要 252 根 + 1(同 kingpool_probe)
export const LU = 0.095;          // 同 limitup_probe
export const MIN_AMT = 1e7;       // 同 limitup_probe(當日成交額 ≥1,000 萬)
export const COST = 0.44;         // 股票來回成本 %
export const GENE = { pos: 75, amp: 3.2, amt: 1e8 };   // 同 kingpool_probe GENE
export const NS = [30, 60, 100];
export const MIN_CANDS = 300;     // 當天可交易檔數太少的日子不算(早期資料稀疏)

/** 單一股票 → 每一個可評估的日子一筆候選(⛔ 條件只用 ≤ t;標籤只用 t+1 / t+10)。
 *  opt.rankNext:🧪 selftest 專用的注入開關 —— 用 t+1 的漲幅當排序鍵(= 前視),正式跑一律 false */
export function candsOf(s, twC, opt = {}) {
    const out = [];
    const { n, o, h, l, c, v, di } = s;
    for (let i = WARM; i + 1 < n; i++) {
        const g = di[i], g1 = di[i + 1];
        if (g < 0 || g1 < 0 || g1 <= g) continue;
        const pc = c[i - 1], cc = c[i], nc = c[i + 1], nh = h[i + 1];
        if (!(pc > 0 && cc > 0 && nc > 0 && nh > 0 && v[i] > 0)) continue;
        const amt = cc * v[i];
        if (amt < MIN_AMT) continue;
        const chg = (cc / pc - 1) * 100;
        const lock = (cc / pc - 1) >= LU && cc >= h[i] - 1e-9;
        const luC = (nc / cc - 1) >= LU;
        const luT = (nh / cc - 1) >= LU;
        const r1 = (nc / cc - 1) * 100;
        const rL = luT ? 9.5 : r1;
        const tw1 = (twC[g1] / twC[g] - 1) * 100;
        let ex10 = null;
        if (i + 10 < n && di[i + 10] > g && c[i + 10] > 0) ex10 = (c[i + 10] / cc - 1) * 100 - (twC[di[i + 10]] / twC[g] - 1) * 100;
        let hi = -Infinity, lo = Infinity;
        for (let k = i - 251; k <= i; k++) { if (c[k] > hi) hi = c[k]; if (c[k] > 0 && c[k] < lo) lo = c[k]; }
        const pos = hi > lo ? (cc - lo) / (hi - lo) * 100 : 50;
        let a = 0; for (let k = i - 19; k <= i; k++) if (c[k] > 0) a += (h[k] - l[k]) / c[k];
        const amp20 = a / 20 * 100;
        const gene = pos >= GENE.pos && amp20 >= GENE.amp && amt >= GENE.amt;
        out.push({ g, sym: s.sym, chg: opt.rankNext ? r1 : chg, amt, gene, lock, luC, luT, r1, rL, ex1: r1 - tw1, ex10 });
    }
    return out;
}

/** 固定種子亂數(可重現) */
export function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
export function sample(arr, k, rnd) {
    const a = arr.slice(); const m = Math.min(k, a.length);
    for (let i = 0; i < m; i++) { const j = i + Math.floor(rnd() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, m);
}

const mk = () => ({ n: 0, up: 0, luC: 0, luT: 0, lock: 0, bn: 0, bNet: 0, bNetL: 0, bEx: 0, luBuy: 0, e10n: 0, e10: 0, days: 0, dayLu: [], byY: new Map(), h: [{ n: 0, lu: 0, bn: 0, net: 0 }, { n: 0, lu: 0, bn: 0, net: 0 }] });
/** 把一天的魚加進統計。half:0 前半 / 1 後半 */
export function addDay(st, fish, year, half) {
    st.days++;
    let dl = 0;
    let y = st.byY.get(year); if (!y) { y = { n: 0, lu: 0, bn: 0, net: 0, days: 0, dlu: 0 }; st.byY.set(year, y); }
    y.days++;
    const H = st.h[half];
    for (const f of fish) {
        st.n++; y.n++; H.n++;
        if (f.r1 > 0) st.up++;
        if (f.luC) { st.luC++; y.lu++; H.lu++; dl++; }
        if (f.luT) st.luT++;
        if (f.lock) { st.lock++; continue; }        // 🚨 今天鎖死 = 收盤買不到 → 不進「買得到」那批
        st.bn++; y.bn++; H.bn++;
        const net = f.r1 - COST;
        st.bNet += net; y.net += net; H.net += net;
        st.bNetL += f.rL - COST; st.bEx += f.ex1;
        if (f.luC) st.luBuy++;
        if (f.ex10 != null) { st.e10n++; st.e10 += f.ex10; }
    }
    st.dayLu.push(dl);
    if (dl > 0) y.dlu++;
}
export function summarize(st) {
    const d = st.dayLu, D = d.length || 1;
    const mean = d.reduce((a, b) => a + b, 0) / D;
    const pct = x => +(x * 100).toFixed(2);
    return {
        days: st.days, fish: st.n, perDay: +(st.n / D).toFixed(1),
        up: st.n ? pct(st.up / st.n) : null, luC: st.n ? pct(st.luC / st.n) : null, luT: st.n ? pct(st.luT / st.n) : null,
        luPerDay: +mean.toFixed(2),
        dayAny: pct(d.filter(x => x >= 1).length / D), day3: pct(d.filter(x => x >= 3).length / D),
        lockPct: st.n ? pct(st.lock / st.n) : null,
        luBuyShare: st.luC ? pct(st.luBuy / st.luC) : null,     // 隔天漲停的魚裡,今天買得到的比例
        buyN: st.bn, buyNet: st.bn ? +(st.bNet / st.bn).toFixed(3) : null,
        buyNetLimitSell: st.bn ? +(st.bNetL / st.bn).toFixed(3) : null,
        buyEx1: st.bn ? +(st.bEx / st.bn).toFixed(3) : null,
        ex10: st.e10n ? +(st.e10 / st.e10n).toFixed(3) : null,
        halves: st.h.map(x => ({ luC: x.n ? pct(x.lu / x.n) : null, net: x.bn ? +(x.net / x.bn).toFixed(3) : null })),
        byYear: Object.fromEntries([...st.byY].sort().map(([k, y]) => [k, { luC: y.n ? pct(y.lu / y.n) : null, net: y.bn ? +(y.net / y.bn).toFixed(3) : null, dayAny: y.days ? pct(y.dlu / y.days) : null }])),
    };
}

/** 主流程:days = Map(g → cands[]) → 各魚缸統計 */
export function runPools(byDay, dates, opt = {}) {
    const seeds = opt.seeds || 5, Ns = opt.Ns || NS;
    const gs = [...byDay.keys()].filter(g => byDay.get(g).length >= (opt.minCands ?? MIN_CANDS)).sort((a, b) => a - b);
    const mid = gs[Math.floor(gs.length / 2)];
    const P = {};
    const put = (k, fish, g) => { (P[k] ||= mk()); addDay(P[k], fish, dates[g].slice(0, 4), g < mid ? 0 : 1); };
    for (const g of gs) {
        const cs = byDay.get(g);
        put('ALL', cs, g);
        const byChg = cs.slice().sort((a, b) => b.chg - a.chg || (a.sym < b.sym ? -1 : 1));
        const byAmt = cs.slice().sort((a, b) => b.amt - a.amt || (a.sym < b.sym ? -1 : 1));
        for (const N of Ns) {
            put(`P1_${N}`, byChg.slice(0, N), g);
            put(`P2_${N}`, byAmt.slice(0, N), g);
            for (let s = 0; s < seeds; s++) put(`P0_${N}`, sample(cs, N, rng(g * 7919 + s * 104729 + N)), g);
        }
        put('P3', cs.filter(c => c.gene), g);
    }
    // P0 的「每天幾條」要除以種子數(同一天加了 seeds 次)
    const out = {};
    for (const [k, st] of Object.entries(P)) {
        const s = summarize(st);
        if (k.startsWith('P0_')) {
            // 把 seeds 次合成一天:每 seeds 筆 dayLu 取平均
            const arr = st.dayLu, per = [];
            for (let i = 0; i < arr.length; i += seeds) per.push(arr.slice(i, i + seeds));
            s.luPerDay = +(per.reduce((a, x) => a + x.reduce((p, q) => p + q, 0) / x.length, 0) / per.length).toFixed(2);
            s.dayAny = +(per.reduce((a, x) => a + x.filter(v => v >= 1).length / x.length, 0) / per.length * 100).toFixed(2);
            s.day3 = +(per.reduce((a, x) => a + x.filter(v => v >= 3).length / x.length, 0) / per.length * 100).toFixed(2);
            s.days = per.length; s.perDay = +(s.fish / per.length / seeds).toFixed(1);
        }
        out[k] = s;
    }
    return { days: gs.length, from: dates[gs[0]], to: dates[gs[gs.length - 1]], pools: out };
}

// ═══ 讀資料 ═══
export function load(DATA) {
    const twRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    const tw = (Array.isArray(twRaw) ? twRaw : (twRaw.data || [])).filter(r => +r.close > 0);
    const dates = tw.map(r => String(r.date).replace(/\//g, '-'));
    const dIdx = new Map(dates.map((d, i) => [d, i]));
    const twC = tw.map(r => +r.close);
    const files = fs.readdirSync(DATA).filter(f => /^\d{4,6}\.json$/.test(f) && !/^00/.test(f));
    const byDay = new Map();
    let used = 0, cliff = 0;
    for (const f of files) {
        let rows;
        try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
        rows = Array.isArray(rows) ? rows : (rows.data || []);
        if (!rows || rows.length < WARM + 30) continue;
        const n = rows.length;
        const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
        const di = new Int32Array(n).fill(-1);
        let bad = false;
        for (let i = 0; i < n; i++) {
            const r = rows[i];
            o[i] = +r.open || 0; h[i] = +r.high || 0; l[i] = +r.low || 0; c[i] = +r.close || 0; v[i] = +r.volume || 0;
            const g = dIdx.get(String(r.date).replace(/\//g, '-')); if (g !== undefined) di[i] = g;
            // 🚧 斷崖守門(同 etf_switch / kingpool 的精神):相鄰兩根 ±40% = 尺標斷層
            if (i > 0 && c[i] > 0 && c[i - 1] > 0) { const q = c[i] / c[i - 1]; if (q > 1.4 || q < 0.6) bad = true; }
        }
        if (bad) { cliff++; continue; }
        used++;
        for (const x of candsOf({ sym: f.replace('.json', ''), n, o, h, l, c, v, di }, twC)) {
            let a = byDay.get(x.g); if (!a) { a = []; byDay.set(x.g, a); }
            a.push(x);
        }
    }
    return { dates, byDay, used, cliff };
}

const NAME = { ALL: '全部可交易(隨便挑一條)', P1: '📈 附件那種:今日漲幅前', P2: '👑 今日成交額前', P0: '🎲 隨機抽', P3: '🧬 高位階+高波動(全部)' };
function label(k) { const [p, n] = k.split('_'); return n ? `${NAME[p]} ${n}` : NAME[p]; }

function main(argv) {
    const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
    const outJson = argv.find(a => a.endsWith('.json'));
    const t0 = Date.now();
    const { dates, byDay, used, cliff } = load(DATA);
    const R = runPools(byDay, dates);
    console.log(`🎣 魚缸探針 —— ${used} 檔(斷崖排除 ${cliff})・${R.days} 個交易日 ${R.from} ~ ${R.to} ・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    if (R.days < 250) { console.log('🚨 交易日 < 250 —— 資料不夠,不下結論'); process.exit(1); }
    const P = R.pools;
    const order = ['ALL', ...NS.flatMap(N => [`P1_${N}`, `P2_${N}`, `P0_${N}`]), 'P3'];
    console.log('\n魚缸                          魚/天  隔天收漲停% 觸及%   每天幾條漲停  ≥1條的日子  ≥3條   今天鎖死%  漲停魚裡買得到%  買得到:收盤買扣成本  觸及掛漲停賣扣成本  10日超額');
    for (const k of order) {
        const s = P[k]; if (!s) continue;
        console.log(`${label(k).padEnd(24)} ${String(s.perDay).padStart(6)}  ${String(s.luC).padStart(7)}%  ${String(s.luT).padStart(6)}%  ${String(s.luPerDay).padStart(8)}    ${String(s.dayAny).padStart(7)}%  ${String(s.day3).padStart(6)}%  ${String(s.lockPct).padStart(7)}%  ${String(s.luBuyShare).padStart(10)}%  ${String(s.buyNet).padStart(12)}%  ${String(s.buyNetLimitSell).padStart(12)}%  ${String(s.ex10).padStart(8)}pp`);
    }
    console.log('\n逐年(隔天收漲停% ・買得到那批扣成本 %)');
    for (const k of ['ALL', 'P1_60', 'P2_60', 'P0_60', 'P3']) {
        const s = P[k];
        console.log(`  ${label(k).padEnd(24)} ` + Object.entries(s.byYear).map(([y, v]) => `${y}:${v.luC}%/${v.net}%`).join('  ')
            + `  ・前半 ${s.halves[0].luC}%/${s.halves[0].net}% 後半 ${s.halves[1].luC}%/${s.halves[1].net}%`);
    }
    const p1 = P.P1_60, p0 = P.P0_60;
    console.log(`\n⭐ 一句話:附件那種魚缸(今日漲幅前 60)每天平均 ${p1.luPerDay} 條隔天漲停、${p1.dayAny}% 的日子至少一條;`
        + `隨機抽 60 條也有 ${p0.luPerDay} 條、${p0.dayAny}% 的日子至少一條。今天就鎖死買不到的佔 ${p1.lockPct}%;`
        + `買得到的那批收盤買扣成本平均 ${p1.buyNet}%(觸及掛漲停賣 ${p1.buyNetLimitSell}%)。`);
    console.log('⚠️ 限制:含興櫃/冷門股(門檻同 limitup_probe)・不含股利 ・倖存者偏誤 ・「掛漲停賣」假設觸及就成交在 +9.5%');
    if (outJson) {
        fs.writeFileSync(outJson, JSON.stringify({ probe: 'pond_probe.mjs', ...R, used, cliff, cost: COST, gene: GENE, measured: new Date().toISOString().slice(0, 10) }, null, 1));
        console.log(`💾 ${outJson}`);
    }
}

// ═══ 自我驗證 ═══
function selftest() {
    let fail = 0;
    const ok = (nm, cond, got) => { console.log(`${cond ? '✅' : '❌'} ${nm}${cond ? '' : '  → ' + JSON.stringify(got)}`); if (!cond) fail++; };
    // 合成一檔:WARM 根平穩後,指定 i 的漲跌
    const mkStock = (sym, path, opt = {}) => {
        const n = path.length, o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n), di = new Int32Array(n);
        for (let i = 0; i < n; i++) { c[i] = path[i]; o[i] = path[i]; h[i] = path[i] * (opt.hiMul?.[i] ?? 1.01); l[i] = path[i] * 0.99; v[i] = 1e6; di[i] = i; }
        if (opt.lockAt != null) h[opt.lockAt] = c[opt.lockAt];     // 收在最高
        return { sym, n, o, h, l, c, v, di };
    };
    const flat = k => Array.from({ length: k }, () => 100);
    const twC = Array.from({ length: 400 }, () => 100);
    // ② 鎖死判定:第 300 根 +10% 收在最高 → lock;另一檔同漲幅但最高 > 收盤 → 不鎖
    {
        const p = flat(310); for (let i = 300; i < 310; i++) p[i] = 110;
        const a = candsOf(mkStock('A', p, { lockAt: 300 }), twC).find(x => x.g === 300);
        const b = candsOf(mkStock('B', p), twC).find(x => x.g === 300);
        ok('② 漲停且收在最高 = 鎖死(買不到);最高 > 收盤 = 沒鎖', a && a.lock && b && !b.lock, [a?.lock, b?.lock]);
    }
    // ⑤ 標籤只看 t+1:第 300 根平、301 根 +10% → g=300 的 luC=true;g=299 的 luC=false
    {
        const p = flat(310); for (let i = 301; i < 310; i++) p[i] = 110;
        const cs = candsOf(mkStock('C', p), twC);
        ok('⑤ 隔天漲停的標籤掛在「前一天」(t 收盤就要決定)', cs.find(x => x.g === 300)?.luC === true && cs.find(x => x.g === 299)?.luC === false);
    }
    // ③ 排名只用今天:A 今天 +9% 明天 0;B 今天 +1% 明天 +10% → 漲幅前 1 必須是 A
    {
        const pa = flat(310), pb = flat(310);
        for (let i = 300; i < 310; i++) pa[i] = 109;
        pb[300] = 101; for (let i = 301; i < 310; i++) pb[i] = 111.1;
        const byDay = new Map();
        for (const s of [mkStock('A', pa), mkStock('B', pb)]) for (const x of candsOf(s, twC)) { if (!byDay.has(x.g)) byDay.set(x.g, []); byDay.get(x.g).push(x); }
        const dates = twC.map((_, i) => `2024-${String(1 + (i % 12)).padStart(2, '0')}-01`);
        const top = byDay.get(300).slice().sort((a, b) => b.chg - a.chg)[0];
        ok('③ 「今日漲幅前 N」只用今天的漲幅排(⛔ 不可偷看明天)', top.sym === 'A', top.sym);
        const only = new Map([[300, byDay.get(300)]]);
        const R = runPools(only, dates, { Ns: [1], seeds: 1, minCands: 1 });
        ok('③b 走 runPools:第 300 天漲幅第 1 名是 A(明天 0%)→ 那一天漲停率 0%', R.pools.P1_1.fish === 1 && R.pools.P1_1.luC === 0, R.pools.P1_1);
    }
    // ① 每天幾條:100 條魚,每天剛好 7 條隔天漲停(第 k 條在 (k+g)%100<7 的日子)→ 平均 7、≥1 的日子 100%、每條 7%
    {
        const dates = Array.from({ length: 60 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`);
        const byDay = new Map();
        for (let g = 0; g < 60; g++) {
            const cs = [];
            for (let k = 0; k < 100; k++) {
                const lu = (k + g) % 100 < 7;
                cs.push({ g, sym: 'S' + k, chg: k, amt: 1e9 - k, gene: k < 20, lock: false, luC: lu, luT: lu, r1: lu ? 10 : 0, rL: lu ? 9.5 : 0, ex1: 0, ex10: 0 });
            }
            byDay.set(g, cs);
        }
        const R = runPools(byDay, dates, { Ns: [100, 30], seeds: 3, minCands: 1 });
        const a = R.pools.ALL, b = R.pools.P1_100;
        ok('① 每天平均幾條漲停 = 7、隔天漲停率 = 7%、每天都至少一條', a.luPerDay === 7 && a.luC === 7 && a.dayAny === 100, [a.luPerDay, a.luC, a.dayAny]);
        ok('①b 前 100 = 全部 → 數字一致', b.luPerDay === 7 && b.luC === 7);
        ok('①d 隔天上漲%(漲停那 7 條是漲、其餘 0% 不算漲)= 7%', a.up === 7, a.up);
        ok('①c 買得到那批扣成本 = 7%×10 − 0.44 = 0.26%', Math.abs(a.buyNet - 0.26) < 1e-9, a.buyNet);
        // ④ 隨機抽 30 條:每天每個種子剛好 30 條、不重複
        const rnd = rng(5); const s1 = sample(byDay.get(3), 30, rnd);
        ok('④ 隨機抽剛好 N 條、不重複', s1.length === 30 && new Set(s1.map(x => x.sym)).size === 30);
        ok('④b 隨機魚缸的每天條數 = 30、交易日數 = 60(同一天抽 3 次 ⛔ 不可算成 180 天)', R.pools.P0_30.perDay === 30 && R.pools.P0_30.days === 60, [R.pools.P0_30.perDay, R.pools.P0_30.days]);
        ok('④c 隨機抽 30 條的平均漲停條數 ≈ 30×7% = 2.1(±0.5)', Math.abs(R.pools.P0_30.luPerDay - 2.1) <= 0.5, R.pools.P0_30.luPerDay);
    }
    // ⑥ 鎖死的魚不進「買得到」那批
    {
        const st = mk(); addDay(st, [{ luC: true, luT: true, lock: true, r1: 10, rL: 9.5, ex1: 10, ex10: 5 }, { luC: false, luT: false, lock: false, r1: 1, rL: 1, ex1: 1, ex10: 1 }], '2024', 0);
        const s = summarize(st);
        ok('⑥ 今天鎖死的魚算進命中、⛔ 不算進買得到', s.luC === 50 && s.buyN === 1 && Math.abs(s.buyNet - 0.56) < 1e-9 && s.luBuyShare === 0, s);
    }
    console.log(fail ? `\n❌ POND_SELFTEST_FAIL ${fail} 條` : '\n✅ POND_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
