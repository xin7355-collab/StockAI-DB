#!/usr/bin/env node
/**
 * 🐘 V80.1.9 鉅額交易之後,那檔股票會不會比較強?(評估紀錄 52 策略 D + LAB「💵 鉅額交易溢價錨定」)
 *
 * 資料:證交所 BFIAUU 2009 起每一天的鉅額交易(block_deep 分支,block_deep_fetch.py)+ 16 年 d16 K 線 / 除權息。
 *   ⚠️ 只有上市(上櫃的鉅額網址沒驗過);鉅額當天收盤後才公布 → 第二天開盤才算知道。
 * 一天一檔先合起來:鉅額股數 = 那天所有鉅額列加總、鉅額均價 = 金額 ÷ 股數;
 *   佔比 = 鉅額股數 ÷ 那天一般交易的成交股數(鉅額另外撮合,可以 > 1);溢價 = 鉅額均價 ÷ 當天收盤 − 1。
 * 五個檢定 × 抱 5 / 20 / 60 天(15 個一起 BH):
 *   T1 佔比前 1%   T2 佔比前 5%   (門檻 = 「之前」所有鉅額事件的分位數,⛔ 用到未來;至少 250 筆才開始)
 *   T3 溢價成交(鉅額均價 ≥ 收盤 +1%:買方願意用高於市價接手 = 可能知道什麼)
 *   T4 折價成交(≤ 收盤 −3%:賣方急著出)   T5 配對交易而且佔比前 5%(協議成交,最像大股東轉讓)
 * 規則同 trade_lead_probe:隔天開盤買(開盤一價鎖漲停 = 買不到)、含息、斷崖不算、對照 = 同一天全部股票、
 *   扣成本 0.44、六關(lib_evgate,每天先平均)、抱 60 天用 Newey-West、同一檔 10 天內只算第一次、500 次亂挑。
 *
 * 跑法:DATA_DIR=<d16> BLOCK_DIR=<block_deep 資料夾> IDX_LONG=<idx_long.json> node --max-old-space-size=8000 scripts/block_trade_probe.mjs out.json
 *       node scripts/block_trade_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gates, COST, increments, baseAdd } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';
import { alignStock, fwdRet, nwP } from './trade_lead_probe.mjs';

const HS = [5, 20, 60];
const DEDUP = 10;
const MIN_HIST = 250;
const SHAM_N = 500;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sg = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const rng = s => () => ((s = (s * 16807) % 2147483647) / 2147483647);

/** 一天的鉅額列 [[代號, 交易別, 價, 股數, 金額]] → Map(代號 → {sh, val, vwap, pair})。只收 4 碼普通股。 */
export function aggDay(rows) {
    const m = new Map();
    for (const r of rows || []) {
        const code = String(r[0] || '').trim(), sh = +r[3], val = +r[4];
        if (!/^[1-9]\d{3}$/.test(code) || !(sh > 0) || !(val > 0)) continue;
        const a = m.get(code) || { sh: 0, val: 0, pair: 0 };
        a.sh += sh; a.val += val;
        if (String(r[1]).includes('配對')) a.pair += sh;
        m.set(code, a);
    }
    for (const a of m.values()) a.vwap = a.val / a.sh;
    return m;
}

/** 擴張式分位數門檻:x 之前(⛔ 含自己)所有值的第 q 分位;不到 minN 筆回 Infinity。
 *  用排序陣列插入(事件約 5 萬筆,夠快)。回傳 [門檻...],跟 xs 對齊。 */
export function expandingQuantile(xs, q, minN = MIN_HIST) {
    const sorted = [], out = new Array(xs.length);
    const ins = v => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; } sorted.splice(lo, 0, v); };
    for (let i = 0; i < xs.length; i++) {
        out[i] = sorted.length < minN ? Infinity : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        ins(xs[i]);
    }
    return out;
}

/** 事件 [{d(日期編號), sym, ...}] 依日期排好 → 同一檔 DEDUP 天內只留第一次 */
export function dedup(evs, gap = DEDUP) {
    const last = new Map(), out = [];
    for (const e of evs) { const p = last.get(e.sym); if (p != null && e.i - p < gap) continue; last.set(e.sym, e.i); out.push(e); }
    return out;
}

function loadWorld(env) {
    const miss = ['DATA_DIR', 'BLOCK_DIR', 'IDX_LONG'].filter(k => !env[k]);
    if (miss.length) { console.log(`❌ 要設 ${miss.join(' / ')}(跑法見檔頭)`); process.exit(1); }
    const idx = JSON.parse(fs.readFileSync(env.IDX_LONG, 'utf8'));
    const tw = (idx.twii || []).map(r => d10(r[0]));
    let late = [];
    try { late = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, '^TWII.json'), 'utf8')).map(r => d10(r.date)).filter(d => d > tw[tw.length - 1]); } catch (_) {}
    const cal = [...tw, ...late], calIdx = new Map(cal.map((d, i) => [d, i]));
    const divAll = (() => { try { return JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, '_div16.json'), 'utf8')).d || {}; } catch (_) { return {}; } })();
    const stocks = new Map();
    for (const f of fs.readdirSync(env.DATA_DIR)) {
        const s = f.replace(/\.json$/, '');
        if (!/^[1-9]\d{3}$/.test(s)) continue;          // 普通股(⛔ ETF / 權證)
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 60) continue;
        const A = alignStock(cal, calIdx, bars, (divAll[s] || {}).h);
        A.date = cal;
        stocks.set(s, A);
    }
    const blocks = [];   // [{i, sym, sh, val, vwap, pair}]
    for (const f of fs.readdirSync(env.BLOCK_DIR).sort()) {
        if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
        const mj = JSON.parse(fs.readFileSync(path.join(env.BLOCK_DIR, f), 'utf8'));
        for (const [ds, rows] of Object.entries(mj.days || {})) {
            const i = calIdx.get(ymd(ds)); if (i == null) continue;
            for (const [sym, a] of aggDay(rows)) if (stocks.has(sym)) blocks.push({ i, sym, ...a });
        }
    }
    blocks.sort((a, b) => a.i - b.i || (a.sym < b.sym ? -1 : 1));
    return { cal, stocks, blocks };
}

/** 每天全部股票(同一個抱法)的平均 → base[k] = Map(日期 → {s, n}) */
function buildBase(W) {
    const base = HS.map(() => new Map());
    for (const S of W.stocks.values()) {
        for (let i = 1; i < W.cal.length - 1; i++) {
            if (!(S.c[i] > 0)) continue;
            HS.forEach((H, k) => { const r = fwdRet(S, i + 1, i + H); if (r != null) baseAdd(base[k], W.cal[i], r); });
        }
    }
    return base;
}

/** 鉅額事件 → 佔比 / 溢價(⛔ 那天沒有一般交易量或收盤 → 丟掉) */
export function enrich(blocks, stocks) {
    const out = [];
    for (const b of blocks) {
        const S = stocks.get(b.sym), v = S.v[b.i], c = S.c[b.i];
        if (!(v > 0) || !(c > 0)) continue;
        out.push({ ...b, ratio: b.sh / v, prem: b.vwap / c - 1, pairRatio: b.pair / v });
    }
    return out;
}

function evRets(evs, W, H) {
    const out = [];
    for (const e of evs) { const r = fwdRet(W.stocks.get(e.sym), e.i + 1, e.i + H); if (r != null) out.push({ d: W.cal[e.i], r }); }
    return out;
}

function gate(inc, H, nDaysAll) {
    const g = gates(inc, COST);
    const lag = H > 20 ? Math.max(1, Math.round((H - 1) * inc.days.length / Math.max(1, nDaysAll))) : 0;
    g.pNW = H > 20 ? nwP(inc.dm, lag) : g.p;
    if (H > 20) { g.pass['⑥檢定'] = g.d > 0 && g.pNW <= 0.05; g.nPass = Object.values(g.pass).filter(Boolean).length; }
    return g;
}

/** 亂挑:同一天、同樣幾檔,從那天有收盤的全部股票裡隨便挑 → 500 次的平均增量分布 */
function sham(evs, W, base, H, k, nDaysAll) {
    const byDay = new Map(); for (const e of evs) byDay.set(e.i, (byDay.get(e.i) || 0) + 1);
    const pool = new Map(), syms = [...W.stocks.keys()];
    for (const i of byDay.keys()) pool.set(i, syms.filter(s => W.stocks.get(s).c[i] > 0));
    const R = rng(20261102 + H), vals = [];
    for (let t = 0; t < SHAM_N; t++) {
        const ev = [];
        for (const [i, n] of byDay) { const p = pool.get(i); for (let j = 0; j < n && p.length; j++) ev.push({ i, sym: p[Math.floor(R() * p.length)] }); }
        const inc = increments(evRets(ev, W, H), base[k]);
        vals.push(mean(inc.dm));
    }
    vals.sort((a, b) => a - b);
    return { p95: vals[Math.floor(0.95 * SHAM_N)], med: vals[SHAM_N >> 1] };
}

function main(out) {
    const W = loadWorld(process.env);
    console.log(`🐘 ${W.stocks.size} 檔普通股、${W.cal.length} 個交易日、鉅額(一天一檔合併)${W.blocks.length} 筆`);
    if (!W.blocks.length) { console.log('❌ 一筆鉅額都沒有 → block_deep 還沒抓好?'); process.exit(1); }
    const base = buildBase(W), nDaysAll = W.cal.length;
    const ev = enrich(W.blocks, W.stocks);
    const thr1 = expandingQuantile(ev.map(e => e.ratio), 0.99), thr5 = expandingQuantile(ev.map(e => e.ratio), 0.95);
    const thrP = expandingQuantile(ev.map(e => e.pairRatio), 0.95);
    const T = {
        T1: dedup(ev.filter((e, j) => e.ratio >= thr1[j])),
        T2: dedup(ev.filter((e, j) => e.ratio >= thr5[j])),
        T3: dedup(ev.filter(e => e.prem >= 0.01)),
        T4: dedup(ev.filter(e => e.prem <= -0.03)),
        T5: dedup(ev.filter((e, j) => e.pair > 0 && e.pairRatio >= thrP[j])),
    };
    const NAME = { T1: '佔比前 1%', T2: '佔比前 5%', T3: '溢價 ≥ +1%', T4: '折價 ≤ −3%', T5: '配對交易佔比前 5%' };
    const rows = [];
    for (const [key, evs] of Object.entries(T)) {
        HS.forEach((H, k) => {
            const inc = increments(evRets(evs, W, H), base[k]);
            const g = gate(inc, H, nDaysAll);
            const yr = (g.YR || []).filter(y => y.n >= 20);
            rows.push({ key, name: NAME[key], H, n: inc.n, nDays: inc.days.length, d: g.d, p: H > 20 ? g.pNW : g.p,
                        nPass: g.nPass, pass: g.pass, H2: g.H, yrPos: yr.filter(y => y.d > 0).length, yrN: yr.length, YR: g.YR, dropBest: g.dropBest });
        });
    }
    const q = bhQ(rows.map(r => r.p)); rows.forEach((r, j) => { r.q = q[j]; });
    console.log('\n檢定                 抱  筆數   增量     p      q    年正   六關');
    for (const r of rows) console.log(`${r.name.padEnd(14)} ${String(r.H).padStart(3)} ${String(r.n).padStart(6)} ${sg(r.d).padStart(7)} ${r.p.toFixed(3).padStart(6)} ${r.q.toFixed(3).padStart(6)} ${String(r.yrPos).padStart(3)}/${r.yrN}  ${r.nPass}/6`);
    // 最有希望的那一格做亂挑
    const best = rows.slice().sort((a, b) => b.d - a.d)[0];
    const sh = sham(T[best.key], W, base, best.H, HS.indexOf(best.H), nDaysAll);
    console.log(`\n亂挑(${best.name} 抱 ${best.H} 天那一格,同一天同樣幾檔 × ${SHAM_N} 次):中位 ${sg(sh.med)}、前 5% 門檻 ${sg(sh.p95)} → 實際 ${sg(best.d)}`);
    const res = { updated: new Date().toISOString().slice(0, 10), stocks: W.stocks.size, blocks: W.blocks.length, ev: ev.length,
                  range: [W.cal[ev[0].i], W.cal[ev[ev.length - 1].i]], rows, sham: { ...sh, key: best.key, H: best.H } };
    if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
}

function selftest() {
    let bad = 0;
    const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) bad++; };
    const m = aggDay([['2330', '配對交易', 1000, 1000, 1000000], ['2330', '逐筆交易', 1010, 1000, 1010000], ['00878', '配對交易', 20, 5, 100], ['總計', '', 0, 0, 0]]);
    ok(m.size === 1 && m.get('2330').sh === 2000 && Math.abs(m.get('2330').vwap - 1005) < 1e-9 && m.get('2330').pair === 1000,
       '① 同一檔同一天合起來:股數加總、均價 = 金額 ÷ 股數、配對交易另計;ETF / 總計 ⛔ 收');
    const xs = [...Array(300).keys()].map(i => i % 100);
    const t = expandingQuantile(xs, 0.99, 250);
    ok(t[249] === Infinity && Number.isFinite(t[250]), '② 不到 250 筆不開始(門檻 = 無限大)');
    const xs2 = xs.slice(); xs2[299] = 1e9;
    const t2 = expandingQuantile(xs2, 0.99, 250);
    ok(t.slice(0, 299).every((v, i) => v === t2[i]), '③ ⛔ 前視:最後一筆改成超大,之前每一筆的門檻一個都沒變(門檻只用「之前」的事件)');
    const dd = dedup([{ i: 0, sym: 'A' }, { i: 5, sym: 'A' }, { i: 10, sym: 'A' }, { i: 3, sym: 'B' }].sort((a, b) => a.i - b.i));
    ok(dd.map(e => `${e.sym}${e.i}`).join(',') === 'A0,B3,A10', '④ 同一檔 10 天內只算第一次');
    // ⑤ 合成世界:鉅額之後 20 天平均多漲 2% → 抓得到;同一份資料把事件換成隨機日子 → ≈ 0
    const cal = [...Array(800).keys()].map(i => { const d = new Date(Date.UTC(2015, 0, 1) + i * 86400000); return d.toISOString().slice(0, 10); });
    const calIdx = new Map(cal.map((d, i) => [d, i])), R = rng(7);
    const stocks = new Map(), boosted = new Set();
    for (let s = 0; s < 40; s++) {
        const bars = []; let p = 50;
        for (let i = 0; i < cal.length; i++) { p *= 1 + (R() - 0.5) * 0.02 + (boosted.has(`${s}|${i}`) ? 0.002 : 0); bars.push({ date: cal[i], open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 }); }
        const A = alignStock(cal, calIdx, bars, []); A.date = cal; stocks.set(String(1000 + s), A);
    }
    // 事件:第 s 檔在第 (100 + 13s) 天;之後 20 天每天多 +0.1% → 讓那 20 天的價格逐日墊高
    const evs = [];
    for (let s = 0; s < 40; s++) for (let i0 = 100 + 3 * s; i0 < 700; i0 += 97) {
        const S = stocks.get(String(1000 + s));
        for (let i = i0 + 1; i < cal.length; i++) { const f = i <= i0 + 20 ? 1 + 0.001 * (i - i0) : 1 + 0.001 * 20; S.o[i] *= f; S.c[i] *= f; S.h[i] *= f; S.l[i] *= f; }
        evs.push({ i: i0, sym: String(1000 + s) });
    }
    const W = { cal, stocks };
    const base = [new Map(), new Map(), new Map()];
    for (const S of stocks.values()) for (let i = 1; i < cal.length - 1; i++) HS.forEach((H, k) => { const r = fwdRet(S, i + 1, i + H); if (r != null) baseAdd(base[k], cal[i], r); });
    const inc = increments(evRets(evs.sort((a, b) => a.i - b.i), W, 20), base[1]);
    const rnd = rng(3), fake = evs.map(e => ({ i: 100 + Math.floor(rnd() * 600), sym: e.sym }));
    const incF = increments(evRets(fake, W, 20), base[1]);
    ok(mean(inc.dm) > 1.0 && Math.abs(mean(incF.dm)) < mean(inc.dm) / 2,
       `⑤ 合成:鉅額之後 20 天墊高 → 增量 ${sg(mean(inc.dm))};決定性對照:同樣檔數隨機日子 ${sg(mean(incF.dm))}`);
    const en = enrich([{ i: 5, sym: '1000', sh: 5e5, val: 5e5 * stocks.get('1000').c[5] * 1.02, vwap: stocks.get('1000').c[5] * 1.02, pair: 0 }], stocks);
    ok(Math.abs(en[0].ratio - 0.5) < 1e-9 && Math.abs(en[0].prem - 0.02) < 1e-9, '⑥ 佔比 = 鉅額股數 ÷ 一般成交股數、溢價 = 鉅額均價 ÷ 收盤 − 1');
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過');
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
}
