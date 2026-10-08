#!/usr/bin/env node
/**
 * 🟥📉 downday_lu_probe.mjs —— 「大盤大跌那天還收盤鎖漲停」的股票,之後還會不會比較強?(V78.6.3)
 *
 * 使用者(2026-10-08,光頡 3624 大盤跌那天連兩根漲停):「是否可以做為高勝率選股參考」。
 * 事件:加權當天跌 ≥ X%(X = 1 / 1.5 / 2 / 3)且個股收盤鎖漲停
 *       鎖漲停定義 = dt_daily_probe.lockUp 的精神:收盤 ≥ 前收 ×(1 + 漲跌幅 − 1%)且收在最高(2015-06-01 前漲跌幅 7%)
 *       ⛔ 除權息日不判(那天的漲幅是假的)
 * 進場:隔天開盤買(開盤離漲停不到 0.3% = 買不到 → 剔除並計數),抱 h = 1 / 5 / 10 / 20 天、第 h 天收盤賣
 * 報酬:扣同期 0050 含息(tr[i+h] / tr[i])、扣來回成本 0.44%;同一檔 20 個交易日只算一次
 * 對照:① 同一天全部股票(同一條進場規則)= 「大盤跌那天隨便挑一檔」② 平常日子(大盤 > −0.5%)的鎖漲停
 * 六關:讀 maxim_kbar5_probe.gates(增量 = 事件 − 同一天全部股票平均)
 * 變體:連續第 2 根鎖漲停(前一天也鎖)
 *
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json node --max-old-space-size=8000 scripts/downday_lu_probe.mjs out.json
 *       node scripts/downday_lu_probe.mjs --selftest
 */
import fs from 'fs';
import { loadCtx } from './leader_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';

const COST = 0.44, DEDUP = 20, HS = [1, 5, 10, 20];
const limOf = d => (d < '2015-06-01' ? 0.07 : 0.10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

export function lockUp(S, i, cal) { const c = S.C[i], p = S.C[i - 1];
    return c > 0 && p > 0 && S.F[i] === 1 && c >= p * (1 + limOf(cal[i]) - 0.01) && c >= S.H[i] - 1e-9; }

/** 第 i 天收盤決定 → 第 i+1 天開盤買 → 第 i+h 天收盤賣;回 % (未扣成本) 或 null(買不到 / 沒資料) */
export function fwd(S, i, h, cal) {
    const o = S.O[i + 1], c1 = S.C[i + 1], pc = S.C[i];
    if (!(o > 0 && c1 > 0 && pc > 0 && i + h < cal.length)) return null;
    if (o >= pc * (1 + limOf(cal[i + 1]) - 0.003)) return 'lim';
    if (!(S.A[i + h] > 0 && S.A[i + 1] > 0)) return null;
    return ((c1 / o) * (S.A[i + h] / S.A[i + 1]) - 1) * 100;
}

export function scan(ctx, tw, opt = {}) {
    const { cal, stocks, etf } = ctx, n = cal.length, X = opt.X ?? [1, 1.5, 2, 3];
    const mret = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) if (tw[i] > 0 && tw[i - 1] > 0) mret[i] = (tw[i] / tw[i - 1] - 1) * 100;
    const out = { ev: {}, cnt: { lim: 0, divDay: 0 } };
    const put = (k, h, o) => ((out.ev[k] = out.ev[k] || {})[h] = (out.ev[k][h] || [])).push(o);
    // 同一天全部股票的平均(對照 ①),依天快取
    const dayAll = new Map();
    const allMean = (i, h) => { const key = i * 100 + h; if (dayAll.has(key)) return dayAll.get(key); const a = [];
        for (const S of stocks) { const r = fwd(S, i, h, cal); if (typeof r === 'number') a.push(r); }
        const v = a.length >= 30 ? mean(a) : NaN; dayAll.set(key, v); return v; };
    const bench = (i, h) => (etf.tr[i + h] > 0 && etf.tr[i] > 0 ? (etf.tr[i + h] / etf.tr[i] - 1) * 100 : NaN);
    const last = new Map();
    for (let i = 21; i < n - 1; i++) {
        if (!Number.isFinite(mret[i])) continue;
        const down = mret[i] <= -X[0], norm = mret[i] > -0.5;
        if (!down && !norm) continue;
        for (const S of stocks) {
            if (!lockUp(S, i, cal)) continue;
            const key = S.sym + (down ? 'D' : 'N'), lp = last.get(key);
            if (lp != null && i - lp < DEDUP) continue;
            last.set(key, i);
            const two = lockUp(S, i - 1, cal);
            for (const h of HS) {
                const r = fwd(S, i, h, cal); if (r === 'lim') { if (h === 1) out.cnt.lim++; continue; } if (r == null) continue;
                const b = bench(i, h), am = allMean(i, h); if (!Number.isFinite(b)) continue;
                const o = { d: cal[i], s: S.sym, ex: r - b, raw: r - b - COST, inc: Number.isFinite(am) ? r - am : NaN, m: mret[i] };
                if (norm) put('平常日鎖漲停', h, o);
                else {
                    for (const x of X) if (mret[i] <= -x) { put(`大盤跌≥${x}%`, h, o); if (two) put(`大盤跌≥${x}%·連2根`, h, o); }
                }
            }
        }
    }
    return out;
}

export function summarize(out) {
    const res = {};
    for (const [k, byH] of Object.entries(out.ev)) {
        res[k] = {};
        for (const [h, arr] of Object.entries(byH)) {
            const x = arr.filter(o => Number.isFinite(o.inc)).map(o => ({ d: o.d, v: o.inc }));
            const g = gates(x, arr.map(o => o.raw), 1);
            res[k][h] = { n: arr.length, ex: +mean(arr.map(o => o.ex)).toFixed(2), win: +(100 * arr.filter(o => o.ex > 0).length / arr.length).toFixed(1),
                inc: g.inc, t: g.t, abs: g.abs, pass: g.pass, gates: g.gates, years: g.years };
        }
    }
    return res;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 120, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10));
    const mk = (sym, f, o = {}) => { const C = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), F = new Float64Array(n).fill(1);
        for (let i = 0; i < n; i++) { C[i] = f(i); O[i] = i ? C[i - 1] : C[i]; H[i] = Math.max(C[i], O[i]); }
        if (o.mod) o.mod({ C, O, H, F }); return { sym, C, O, H, F, A: C.slice() }; };
    const flat = { tr: new Float64Array(n).fill(1) };
    const tw = Array.from({ length: n }, (_, i) => (i === 50 ? 97 : 100));            // 第 50 天大盤跌 3%
    const others = Array.from({ length: 40 }, (_, k) => mk(String(2000 + k), () => 50));
    // X:第 50 天鎖漲停(+10%,收最高),之後每天 +1%
    const X = mk('1111', i => (i < 50 ? 100 : 110 * (1 + 0.01 * (i - 50))));
    const ctx = { cal, stocks: [X, ...others], etf: flat };
    const s = summarize(scan(ctx, tw, { X: [2] }));
    t(s['大盤跌≥2%'] && s['大盤跌≥2%']['5'].n === 1 && Math.abs(s['大盤跌≥2%']['5'].ex - ((110 * 1.05 / (110 * 1.0)) - 1) * 100) < 1e-6,
        '① 第 50 天大盤跌 3% 收盤鎖漲停 → 第 51 天開盤(=昨收 110)買、第 55 天收盤賣 = +5%(⛔ 不可用第 50 天收盤當進場)');
    // 零前視:第 51 天開盤跳到漲停 → 買不到,計數
    const Xl = mk('1112', i => (i < 50 ? 100 : i === 50 ? 110 : 121), { mod: q => { q.O[51] = 121; q.H[51] = 121; } });
    const o2 = scan({ cal, stocks: [Xl, ...others], etf: flat }, tw, { X: [2] });
    t(o2.cnt.lim === 1 && !(o2.ev['大盤跌≥2%'] && o2.ev['大盤跌≥2%'][1]), '② 隔天開盤就漲停 → 買不到、剔除並計數(⛔ 不可假裝買到)');
    // 除權息日不判
    const Xd = mk('1113', i => (i < 50 ? 100 : 110), { mod: q => { q.F[50] = 0.9; } });
    t(!scan({ cal, stocks: [Xd, ...others], etf: flat }, tw, { X: [2] }).ev['大盤跌≥2%'], '③ 除權息那天的漲幅⛔ 不算鎖漲停');
    // 沒收在最高 → 不算
    const Xh = mk('1114', i => (i < 50 ? 100 : 110), { mod: q => { q.H[50] = 112; } });
    t(!scan({ cal, stocks: [Xh, ...others], etf: flat }, tw, { X: [2] }).ev['大盤跌≥2%'], '④ 收在最高才算鎖住(盤中打開再拉回 ⛔ 不算)');
    // 平常日子分組 + 去重
    const tw2 = Array.from({ length: n }, () => 100);
    const Xn = mk('1115', i => 100 * Math.pow(1.1, Math.min(Math.max(0, i - 49), 3)));   // 50/51/52 連三根漲停
    const o5 = scan({ cal, stocks: [Xn, ...others], etf: flat }, tw2, { X: [2] });
    t(o5.ev['平常日鎖漲停'] && o5.ev['平常日鎖漲停'][5].length === 1 && !o5.ev['大盤跌≥2%'], '⑤ 大盤沒跌 → 進「平常日」組;連三根只算一次(20 日去重)');
    // 連 2 根
    const tw3 = Array.from({ length: n }, (_, i) => (i >= 52 ? 97 : 100));            // 只有第 52 天大盤跌 3%
    const X2 = mk('1116', i => 100 * Math.pow(1.1, Math.min(Math.max(0, i - 50), 2)));    // 51/52 連兩根鎖(51 那天大盤沒跌)
    const o6 = scan({ cal, stocks: [X2, ...others], etf: flat }, tw3, { X: [2] });
    t(!!(o6.ev['大盤跌≥2%·連2根'] && o6.ev['大盤跌≥2%·連2根'][5]) && o6.ev['平常日鎖漲停'] && o6.ev['平常日鎖漲停'][5].length === 1, '⑥ 大跌日是連續第 2 根鎖漲停 → 另外記一組(前一天那根照平常日算,兩組各自去重)');
    // 增量 = 事件 − 同一天全部股票
    const s7 = summarize(scan(ctx, tw, { X: [2] }));
    t(Math.abs(s7['大盤跌≥2%']['5'].inc - (5 - 0)) < 1e-6 || s7['大盤跌≥2%']['5'].n < 30, '⑦ 增量拿同一天全部股票平均當對照(樣本 <30 只回空的關卡)');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('downday_lu_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const ctx = loadCtx(process.env.DATA_DIR, process.env.DIV);
    const raw = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/^TWII.json`, 'utf8'));
    const m = new Map(raw.map(r => [String(r.date).replace(/\//g, '-').slice(0, 10), +r.close]));
    const tw = ctx.cal.map(d => m.get(d) || NaN);
    const res = summarize(scan(ctx, tw));
    const FROM = process.env.FROM || '';
    for (const [k, byH] of Object.entries(res)) for (const h of HS) { const r = byH[h]; if (!r) continue;
        console.log(`${k.padEnd(14)} h=${String(h).padStart(2)} n=${String(r.n).padStart(5)} 超額0050 ${r.ex}% 贏 ${r.win}% ・增量(vs 同天全部) ${r.inc} t=${r.t} ・扣成本 ${r.abs} ・六關 ${r.pass}/6`); }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ from: ctx.cal[0], to: ctx.cal.at(-1), res, FROM }));
}
