#!/usr/bin/env node
/**
 * 🧩 V80.1.3 回測穩健度:照「這檔跟大盤多像」分組看(19 個專案評估 2-3,abu ABuCrossVal 的做法)
 *
 * 問題:🔥 賺的錢是不是集中在某一類股票(例如只有跟大盤不像的小型股在賺)?
 * 做法(⛔ 不改引擎):讀 portfolio_backtest 的 TAKEN_OUT(實際成交的每一筆)→ 每一筆算「進場那天以前 250 個交易日,
 *   這檔日報酬跟加權日報酬的相關係數」(⛔ 只用進場日之前的資料)→ 分組,看每組幾筆、平均每趟、勝率、佔總獲利幾成。
 *   17 個起點各算一次,取中位數(⛔ 只看一條路徑 = 拿運氣當證據,V77.4.9)。
 *
 * 跑法:DATA_DIR=<d16> node scripts/corr_bucket_probe.mjs <taken 檔名樣式,{W} 會換成起點> [out.json]
 *   例:node scripts/corr_bucket_probe.mjs '/x/taken/ai_base_{W}.json' out.json  (WS=3125,3128,… 或自動找)
 * ⚠️ 限制:相關係數只量「同步」,不量領先落後;成交額 / 市值沒有分(那是另一題)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const LOOKBACK = 250, MIN_OBS = 120, COST = 0.44;
export const EDGES = [0.2, 0.4, 0.6];   // 固定門檻:< 0.2 / 0.2~0.4 / 0.4~0.6 / ≥ 0.6(⛔ 每個起點各切分位數 → 組跟組不能比)
const D = s => String(s || '').slice(0, 10).replace(/\//g, '-');

/** rows → {dIdx: Map(date → i), r: Float64Array 日報酬(第 i 根 vs 第 i−1 根;沒有就 NaN)} */
export function retSeries(rows) {
    const n = rows.length, r = new Float64Array(n).fill(NaN), dIdx = new Map();
    for (let i = 0; i < n; i++) {
        dIdx.set(D(rows[i].date), i);
        const c0 = +(rows[i - 1] || {}).close, c1 = +rows[i].close;
        if (i > 0 && c0 > 0 && c1 > 0) { const x = c1 / c0 - 1; if (Math.abs(x) < 0.5) r[i] = x; }   // |50%| 以上當斷崖,不算
    }
    return { dIdx, r, dates: rows.map(x => D(x.date)) };
}

/** 進場日 d 以前(⛔ 不含 d)最近 LOOKBACK 個「兩邊都有報酬」的交易日 → 相關係數;不夠 MIN_OBS 回 null */
export function corrBefore(stk, mkt, d) {
    let i = stk.dIdx.get(d);
    if (i == null) { i = stk.dates.findIndex(x => x >= d); if (i < 0) i = stk.dates.length; }   // 進場日沒有 K 線 → 用之後第一根之前
    const xs = [], ys = [];
    for (let k = i - 1; k >= 1 && xs.length < LOOKBACK; k--) {
        const mi = mkt.dIdx.get(stk.dates[k]);
        if (mi == null) continue;
        const a = stk.r[k], b = mkt.r[mi];
        if (Number.isFinite(a) && Number.isFinite(b)) { xs.push(a); ys.push(b); }
    }
    if (xs.length < MIN_OBS) return null;
    const n = xs.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, x) => s + x, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let j = 0; j < n; j++) { const a = xs[j] - mx, b = ys[j] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export const bucketOf = c => c == null ? 'na' : c < EDGES[0] ? 'b0' : c < EDGES[1] ? 'b1' : c < EDGES[2] ? 'b2' : 'b3';
export const BUCKETS = ['b0', 'b1', 'b2', 'b3', 'na'];
export const BUCKET_NAME = { b0: '跟大盤不像(< 0.2)', b1: '有點像(0.2~0.4)', b2: '蠻像(0.4~0.6)', b3: '很像(≥ 0.6)', na: '歷史不夠(< 120 天)' };

/** 一個起點的成交明細 → 每組 {n, sum, win, mean} (net = ret + dv − 成本) */
export function bucketStats(trades, corrOf) {
    const out = Object.fromEntries(BUCKETS.map(b => [b, { n: 0, sum: 0, win: 0 }]));
    let tot = 0;
    for (const t of trades) {
        const net = (+t.ret || 0) + (+t.dv || 0) - COST;
        const b = bucketOf(corrOf(t));
        const o = out[b]; o.n++; o.sum += net; if (net > 0) o.win++;
        tot += net;
    }
    for (const b of BUCKETS) { const o = out[b]; o.mean = o.n ? o.sum / o.n : null; o.share = tot ? o.sum / tot : null; }
    return { by: out, tot, n: trades.length };
}

const med = a => { const s = a.filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function main() {
    const DIR = process.env.DATA_DIR || 'data';
    const pat = process.argv[2];
    if (!pat || !pat.includes('{W}')) { console.error('用法:DATA_DIR=<d16> node scripts/corr_bucket_probe.mjs <含 {W} 的 taken 檔名樣式> [out.json]'); process.exit(1); }
    const dir = path.dirname(pat), base = path.basename(pat);
    const re = new RegExp('^' + base.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('\\{W\\}', '(\\d+)').replace('{W}', '(\\d+)') + '$');
    const files = fs.readdirSync(dir).filter(f => re.test(f)).sort();
    if (files.length < 5) { console.error(`❌ 只找到 ${files.length} 個起點的成交明細(< 5)→ 不夠看穩定度`); process.exit(1); }
    const mktRows = JSON.parse(fs.readFileSync(path.join(DIR, '^TWII.json'), 'utf8'));
    const mkt = retSeries(Array.isArray(mktRows) ? mktRows : mktRows.data);
    const cache = new Map(), series = new Map();
    const stkOf = sym => {
        if (series.has(sym)) return series.get(sym);
        let s = null; try { const j = JSON.parse(fs.readFileSync(path.join(DIR, sym + '.json'), 'utf8')); s = retSeries(Array.isArray(j) ? j : j.data); } catch (_) { /* 找不到 → na */ }
        series.set(sym, s); return s;
    };
    const corrOf = t => { const k = t.sym + '|' + t.d; if (cache.has(k)) return cache.get(k); const s = stkOf(t.sym); const c = s ? corrBefore(s, mkt, t.d) : null; cache.set(k, c); return c; };
    const per = files.map(f => ({ w: +re.exec(f)[1], ...bucketStats(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), corrOf) }));
    console.log(`📦 ${per.length} 個起點 ・每個起點平均 ${Math.round(per.reduce((s, p) => s + p.n, 0) / per.length)} 筆成交 ・相關 = 進場日之前 ${LOOKBACK} 天日報酬 vs 加權`);
    const out = { meta: { dir: DIR, pattern: pat, starts: per.map(p => p.w), lookback: LOOKBACK, minObs: MIN_OBS, edges: EDGES, cost: COST }, b: {} };
    for (const b of BUCKETS) {
        const nM = med(per.map(p => p.by[b].n)), meanM = med(per.map(p => p.by[b].mean)), shareM = med(per.map(p => p.by[b].share));
        const winM = med(per.map(p => p.by[b].n ? p.by[b].win / p.by[b].n : null));
        const pos = per.filter(p => p.by[b].n && p.by[b].sum > 0).length;
        out.b[b] = { name: BUCKET_NAME[b], nMed: nM, meanMed: meanM, winMed: winM, shareMed: shareM, posStarts: pos, starts: per.length };
        console.log(`  ${BUCKET_NAME[b].padEnd(16)} 每起點 ${String(nM ?? '-').padStart(5)} 筆 ・每趟中位 ${meanM == null ? '—' : (meanM >= 0 ? '+' : '') + meanM.toFixed(2) + '%'} ・勝率 ${winM == null ? '—' : (winM * 100).toFixed(0) + '%'} ・佔總獲利 ${shareM == null ? '—' : (shareM * 100).toFixed(0) + '%'} ・${pos}/${per.length} 個起點這組是賺的`);
    }
    const f = process.argv.slice(3).find(a => a.endsWith('.json'));
    if (f) { fs.writeFileSync(f, JSON.stringify(out, null, 1)); console.log(`💾 ${f}`); }
}

// ═══════════ 自我測試 ═══════════
function selftest() {
    let bad = 0; const ok = (m, c, x) => { console.log(`${c ? '✅' : '❌'} ${m}${c ? '' : '  ' + JSON.stringify(x)}`); if (!c) bad++; };
    const days = []; { const d = new Date(Date.UTC(2015, 0, 5)); while (days.length < 700) { if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
    let x = 7; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
    const m = [100]; for (let i = 1; i < days.length; i++) m.push(m[i - 1] * (1 + rnd() * 0.03));
    const mRows = days.map((d, i) => ({ date: d, close: m[i] }));
    const mk = (beta, noise) => { const p = [50]; for (let i = 1; i < days.length; i++) p.push(p[i - 1] * (1 + beta * (m[i] / m[i - 1] - 1) + rnd() * noise)); return days.map((d, i) => ({ date: d, close: p[i] })); };
    const M = retSeries(mRows);
    const hi = retSeries(mk(1.2, 0.004)), lo = retSeries(mk(0, 0.03));
    const ch = corrBefore(hi, M, days[400]), cl = corrBefore(lo, M, days[400]);
    ok(`① 跟大盤同步的那檔相關高(${ch.toFixed(2)})、亂跳的那檔接近 0(${cl.toFixed(2)})`, ch > 0.8 && Math.abs(cl) < 0.2, { ch, cl });
    // ② ⛔ 前視:進場日當天和之後的資料改掉,相關係數一個位數都不變
    const rows2 = mk(1.2, 0.004); const h2 = retSeries(rows2);
    const before = corrBefore(h2, M, days[400]);
    for (let i = 400; i < rows2.length; i++) rows2[i].close = 1 + i % 7;
    const after = corrBefore(retSeries(rows2), M, days[400]);
    ok('② ⛔ 前視:進場日當天與之後的價改掉 → 相關係數不變', before === after, { before, after });
    ok('③ 歷史不夠(< 120 天)→ null(⛔ 硬算)', corrBefore(hi, M, days[100]) === null);
    ok('④ 分組門檻:0.19 → b0、0.2 → b1、0.59 → b2、0.6 → b3、null → na', bucketOf(0.19) === 'b0' && bucketOf(0.2) === 'b1' && bucketOf(0.59) === 'b2' && bucketOf(0.6) === 'b3' && bucketOf(null) === 'na');
    // ⑤ 統計:淨報酬扣成本、佔比加起來 = 1
    const T = [{ ret: 5, dv: 0 }, { ret: -2, dv: 0.5 }, { ret: 1, dv: 0 }];
    const cs = [0.7, 0.1, null];
    const st = bucketStats(T, t => cs[T.indexOf(t)]);
    const shareSum = BUCKETS.reduce((s, b) => s + (st.by[b].share || 0), 0);
    ok('⑤ 每一筆扣 0.44%、股利算進去、佔比加起來 = 1', Math.abs(st.tot - (5 - 1.5 + 1 - 3 * COST)) < 1e-9 && Math.abs(shareSum - 1) < 1e-9 && st.by.b3.n === 1 && st.by.na.n === 1, st);
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ CORR_BUCKET_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest(); else if (IS_MAIN) main();
