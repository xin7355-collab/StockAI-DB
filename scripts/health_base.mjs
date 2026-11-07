#!/usr/bin/env node
/**
 * 🩺 V82.0.6 策略健康度基準(外部健檢 11/07:「策略失效監控」)——「這一波在歷史裡算不算正常」
 *   讀三條 16 年逐日淨值(17 個起跑日):👑 領頭羊(leader_probe EQ_DIR)/ 🅿️ 高檔飆股+停車 0050(portfolio_backtest EQUITY_OUT)/ 0050 含息
 *   → ① 連續 N 個交易日報酬的百分位(N = 5 / 10 / 21 / 42 / 63 / 126 / 250;17 條起點全部放一起,大部分日子重疊)
 *     ② 中間那一條(最後剩下的錢排第 9)的每一段回撤(≥10%,全部列):高點 → 最低 → 回到高點,各幾個交易日
 *     ③ 17 條各自的中途最多賠(最淺 / 中間 / 最深)④ 中間那條最慘的 1 / 5 / 21 個交易日(與日期)
 *     ⑤ 0050 含息歷次跌 ≥15% 那幾段,同期各策略(中間那條)漲跌多少
 *   ⛔ 只描述歷史分佈,⛔ 不是預測、⛔ 不拿來換任何預設;寫進 pro.html `_HEALTH_BASE`(scripts/embed_health_base.mjs)
 *   事先講好的失效規則(App 端 `PRO._healthCheck` 照這個判,這裡只把參數寫進產物):封存日 2026-11-07 之後每 21 個交易日看一次,
 *     連 2 次低於歷史 21 天報酬的 2.5 百分位 → 標「可能失效、要重驗」(⛔ 不自動停用)
 *   用法:LEAD_EQ=<leader_probe EQ_DIR> PARK_EQ=<portfolio_backtest EQUITY_OUT 檔名前綴> DATA_DIR=<含 _bench0050.json / _div0050.json>
 *         node scripts/health_base.mjs out.json   ・   node scripts/health_base.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { trSeries } from './lib_totalreturn.mjs';

export const WINS = [5, 10, 21, 42, 63, 126, 250];
export const LV = [1, 2.5, 5, 10, 25, 50, 75, 90, 95, 97.5, 99];
export const SEAL = '2026-11-07';
export const RULE = { every: 21, below: 2.5, times: 2 };
const r4 = x => Math.round(x * 1e4) / 1e4;

/** 排好序的陣列取第 p 百分位(線性內插) */
export function quantile(sorted, p) {
    if (!sorted.length) return null;
    const h = (p / 100) * (sorted.length - 1), lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
/** 一條淨值(數字陣列)連續 W 個交易日的報酬 */
export function rollRets(v, W) { const out = []; for (let i = W; i < v.length; i++) if (v[i - W] > 0) out.push(v[i] / v[i - W] - 1); return out; }
/** 每一段回撤:高點 → 最低 → 回到高點(沒回到 = rec null);depth 是負的比例 */
export function ddSegs(d, v) {
    const segs = []; let pk = 0, inDD = false, tr = 0;
    for (let i = 1; i < v.length; i++) {
        if (v[i] >= v[pk]) {
            if (inDD) segs.push({ peak: d[pk], trough: d[tr], rec: d[i], depth: v[tr] / v[pk] - 1, down: tr - pk, up: i - tr });
            inDD = false; pk = i;
        } else {
            if (!inDD) { inDD = true; tr = i; }
            if (v[i] < v[tr]) tr = i;
        }
    }
    if (inDD) segs.push({ peak: d[pk], trough: d[tr], rec: null, depth: v[tr] / v[pk] - 1, down: tr - pk, up: null });
    return segs;
}
export function maxDD(v) { let pk = v[0], m = 0; for (const x of v) { if (x > pk) pk = x; if (pk > 0) m = Math.min(m, x / pk - 1); } return m; }
/** 最慘的連續 k 個交易日(報酬最低的那一段)*/
export function worstK(d, v, k) { let w = null; for (let i = k; i < v.length; i++) { const r = v[i] / v[i - k] - 1; if (w === null || r < w.r) w = { r, from: d[i - k], to: d[i] }; } return w; }
/** 日期 x 那天(或之前最近一天)的值 */
function valAt(path, x) { let lo = 0, hi = path.d.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (path.d[m] <= x) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? path.v[k] : null; }

/** 一套策略的基準:paths = [{d:[], v:[]}](已按日期排好) */
export function baseOf(paths, k, name) {
    if (!paths.length) throw new Error(`${k} 沒有任何一條淨值`);
    const q = {};
    for (const W of WINS) {
        const all = []; for (const p of paths) for (const r of rollRets(p.v, W)) all.push(r);
        all.sort((a, b) => a - b);
        if (all.length < 200) throw new Error(`${k} 連續 ${W} 天的樣本只有 ${all.length} 個`);
        q[W] = LV.map(p => r4(quantile(all, p)));
    }
    const ends = paths.map((p, i) => ({ i, e: p.v[p.v.length - 1] / p.v[0] })).sort((a, b) => a.e - b.e);
    const mid = paths[ends[ends.length >> 1].i];
    const segs = ddSegs(mid.d, mid.v).filter(s => s.depth <= -0.10);
    const dds = paths.map(p => maxDD(p.v)).sort((a, b) => a - b);
    const cnt = th => segs.filter(s => s.depth <= th).length;
    return { k, name, paths: paths.length, from: mid.d[0], to: mid.d[mid.d.length - 1], days: mid.v.length, q,
        mdd: [r4(dds[0]), r4(dds[dds.length >> 1]), r4(dds[dds.length - 1])],
        n10: cnt(-0.10), n20: cnt(-0.20), n30: cnt(-0.30),
        segs: segs.slice().sort((a, b) => a.depth - b.depth).map(s => [s.peak, s.trough, s.rec, r4(s.depth), s.down, s.up]),   // 跌 ≥10% 的每一段(最深的在前)
        worst: Object.fromEntries([1, 5, 21].map(kk => { const w = worstK(mid.d, mid.v, kk); return [kk, w ? [r4(w.r), w.from, w.to] : null]; })),
        _mid: mid };
}

/** 0050 歷次跌 ≥th 的那幾段 → 同期各策略(中間那條)漲跌 */
export function fallsOf(b50, bases, th = -0.15) {
    const segs = ddSegs(b50.d, b50.v).filter(s => s.depth <= th);
    return segs.map(s => {
        const row = { peak: s.peak, trough: s.trough, rec: s.rec, e50: r4(s.depth) };
        for (const B of bases) { const a = valAt(B._mid, s.peak), b = valAt(B._mid, s.trough); row[B.k] = (a > 0 && b > 0 && B._mid.d[0] <= s.peak) ? r4(b / a - 1) : null; }
        return row;
    });
}

function eqOf(rows) {
    const d = [], v = [];
    for (const r of rows) { const x = (+r.cash || 0) + (+r.park || 0) + (+r.mv || 0); if (!(x > 0)) continue; d.push(String(r.d).slice(0, 10)); v.push(x); }
    return { d, v };
}
function readLead(dir) {
    const fs_ = fs.readdirSync(dir).filter(f => /^eq_\d+\.json$/.test(f));
    return fs_.map(f => eqOf(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rows || []));
}
function readPark(prefix) {
    const dir = path.dirname(prefix), pre = path.basename(prefix);
    const fs_ = fs.readdirSync(dir).filter(f => f.startsWith(pre) && f.endsWith('.json'));
    return fs_.map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return eqOf(j.rows || []); });
}
function read50(DATA, from, to) {
    const bars = JSON.parse(fs.readFileSync(path.join(DATA, '_bench0050.json'), 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.c > 0 && x.d >= from && x.d <= to);
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, '_div0050.json'), 'utf8'));
    const d50 = Array.isArray(raw) ? raw : (raw.h || ((raw.d || raw)['0050'] || {}).h || []);
    const tr = trSeries(bars, d50);
    if (d50.length < 10) throw new Error(`0050 股利只有 ${d50.length} 筆 → 對照組不含息,拒跑`);
    return { d: tr.d, v: tr.v };
}

export function build({ lead, park, b50 }) {
    const B = [baseOf(lead, 'lead', '👑 領頭羊(全攻)'), baseOf(park, 'park', '🅿️ 高檔飆股+停車 0050'), baseOf([b50], '0050', '0050 元大台灣50(買了放著・含息)')];
    const falls = fallsOf(b50, B.slice(0, 2));
    const out = { asof: new Date().toISOString().slice(0, 10), seal: SEAL, rule: RULE, wins: WINS, lv: LV,
        src: 'scripts/health_base.mjs ← leader_probe EQ_DIR(👑)+ portfolio_backtest EQUITY_OUT(🅿️)+ 0050 含息(lib_totalreturn)',
        s: Object.fromEntries(B.map(x => { const { _mid, ...rest } = x; return [x.k, rest]; })), falls };
    return out;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const days = n => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2011, 0, 3 + i)).toISOString().slice(0, 10));
    // ① 每天固定 +0.1% → 每一個百分位都 = 1.001^W − 1(⛔ 用到別的天數就對不上)
    const n = 600, D = days(n), flat = { d: D, v: D.map((_, i) => Math.pow(1.001, i)) };
    const b1 = baseOf([flat, flat], 'x', 'x');
    t(WINS.every(W => b1.q[W].every(x => Math.abs(x - (Math.pow(1.001, W) - 1)) < 2e-4)) && b1.n10 === 0 && b1.mdd[1] === 0,
        `① 固定漲 0.1%:每個百分位都 = 1.001^W − 1(21 天 ${b1.q[21][5]})、沒有回撤`);
    // ② 埋一段:第 300 天高點 2.0 → 第 310 天 1.0(−50%)→ 第 330 天回到 2.0 → 找得到這一段、跌 10 天、回本 20 天
    const v2 = D.map((_, i) => i <= 300 ? 1 + i / 300 : i <= 310 ? 2 - (i - 300) / 10 : i <= 330 ? 1 + (i - 310) / 20 : 2 + (i - 330) / 1000);
    const s2 = ddSegs(D, v2).filter(s => s.depth <= -0.10);
    t(s2.length === 1 && Math.abs(s2[0].depth + 0.5) < 1e-9 && s2[0].down === 10 && s2[0].up === 20 && s2[0].peak === D[300] && s2[0].trough === D[310] && s2[0].rec === D[330],
        `② 埋一段 −50%:找到 ${s2.length} 段、深度 ${s2[0] && r4(s2[0].depth)}、跌 ${s2[0] && s2[0].down} 天・回本 ${s2[0] && s2[0].up} 天`);
    // ③ 最後還沒回到高點 → rec = null(⛔ 不可把還在水下的當成已經回本)
    const v3 = v2.slice(0, 320), s3 = ddSegs(D.slice(0, 320), v3).filter(s => s.depth <= -0.10);
    t(s3.length === 1 && s3[0].rec === null && s3[0].up === null, '③ 還沒回到高點那一段:回本日 = null');
    // ④ 中間那條 = 最後剩下的錢排中間的那一條(⛔ 不是第一條)
    const mk = g => ({ d: D, v: D.map((_, i) => Math.pow(1 + g, i)) });
    const b4 = baseOf([mk(0.003), mk(0.001), mk(0.002)], 'y', 'y');
    t(Math.abs(b4._mid.v[n - 1] - Math.pow(1.002, n - 1)) < 1e-9, '④ 中間那條 = 最後剩下的錢排中間的那一條');
    // ⑤ 最慘 5 天:埋在第 400~405 天(−20%)
    const v5 = D.map((_, i) => (i < 400 ? 1 : i < 405 ? 1 - 0.04 * (i - 399) : 0.8));
    const w5 = worstK(D, v5, 5);
    t(Math.abs(w5.r + 0.2) < 1e-9 && w5.from === D[399] && w5.to === D[404], `⑤ 最慘 5 天:${r4(w5.r)}(${w5.from}~${w5.to})`);
    // ⑥ 0050 跌 ≥15% 那一段 → 策略同期漲跌(策略比 0050 晚開始 → null,⛔ 不硬算)
    const e50 = { d: D, v: v2 }, Sx = { k: 'lead', _mid: { d: D, v: D.map(() => 1) } }, Sy = { k: 'park', _mid: { d: D.slice(305), v: D.slice(305).map(() => 1) } };
    const f6 = fallsOf(e50, [Sx, Sy]);
    t(f6.length === 1 && f6[0].e50 === -0.5 && f6[0].lead === 0 && f6[0].park === null, `⑥ 0050 跌 50% 那段:策略持平 → 0、還沒開始的策略 → null`);
    // ⑦ 百分位內插
    const arr = [0, 1, 2, 3, 4]; t(quantile(arr, 50) === 2 && quantile(arr, 25) === 1 && quantile(arr, 12.5) === 0.5, '⑦ 百分位線性內插');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const out = process.argv[2], LE = process.env.LEAD_EQ, PE = process.env.PARK_EQ, DATA = process.env.DATA_DIR;
    if (!out || !LE || !PE || !DATA) { console.error('要 out.json + LEAD_EQ + PARK_EQ + DATA_DIR'); process.exit(1); }
    const lead = readLead(LE), park = readPark(PE);
    if (lead.length < 17 || park.length < 17) { console.error(`🚨 👑 ${lead.length} 條 / 🅿️ ${park.length} 條,要各 17 條`); process.exit(1); }
    const from = [...lead, ...park].map(p => p.d[0]).sort()[0], to = [...lead, ...park].map(p => p.d[p.d.length - 1]).sort().slice(-1)[0];
    const b50 = read50(DATA, from, to);
    const res = build({ lead, park, b50 });
    for (const [k, b] of Object.entries(res.s)) {
        console.log(`${b.name}:${b.paths} 條 ${b.from}~${b.to}(${b.days} 天)・中途最多賠 ${(b.mdd[0] * 100).toFixed(1)} / ${(b.mdd[1] * 100).toFixed(1)} / ${(b.mdd[2] * 100).toFixed(1)}%・跌 ≥10% ${b.n10} 段 ≥20% ${b.n20} 段 ≥30% ${b.n30} 段`);
        for (const W of WINS) console.log(`   連續 ${W} 天:2.5% ${(b.q[W][1] * 100).toFixed(1)}%・中間 ${(b.q[W][5] * 100).toFixed(1)}%・97.5% ${(b.q[W][9] * 100).toFixed(1)}%`);
        console.log(`   最慘 1 / 5 / 21 天:${[1, 5, 21].map(x => b.worst[x] ? `${(b.worst[x][0] * 100).toFixed(1)}%(${b.worst[x][2]})` : '—').join(' ・')}`);
        console.log('   最深幾段:' + b.segs.slice(0, 6).map(s => `${s[0]}→${s[1]} ${(s[3] * 100).toFixed(0)}%(跌 ${s[4]} 天・回本 ${s[5] == null ? '還沒' : s[5] + ' 天'})`).join(' ・'));
    }
    console.log('0050 跌 ≥15% 那幾段:' + res.falls.map(f => `${f.peak}→${f.trough} 0050 ${(f.e50 * 100).toFixed(0)}%・👑 ${f.lead == null ? '—' : (f.lead * 100).toFixed(0) + '%'}・🅿️ ${f.park == null ? '—' : (f.park * 100).toFixed(0) + '%'}`).join(' ・'));
    fs.writeFileSync(out, JSON.stringify(res));
    console.log(`✅ 寫入 ${out}`);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
