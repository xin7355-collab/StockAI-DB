#!/usr/bin/env node
/**
 * 🚨 volsurge_probe.mjs —— App 頂端「🚨 剛爆量啟動」那張清單,跟著買有沒有比較好?(V81.0.2,使用者 11/06 問)
 *
 * App 的規則(index.html renderVolSurgeRadar):全市場快照裡 量比(永豐快照的「昨量比」= 今天到現在的成交量 ÷ 昨天整天)≥ 2.5
 *   且 今天漲 1.5~6%(⛔ ETF),量比大的排前面。⚠️ App 說明寫的「今日投影量 ÷ 5 日均量」跟實際用的欄位不一樣。
 * 這裡用日 K 重現(沒有全市場盤中歷史,只能用收盤近似):
 *   事件 = 今天成交量 ÷ 昨天成交量 ≥ K 且 收盤漲 1.5~6%(除權息日不算、同一檔 20 天只算一次)
 *   K = 2.5(App 的數字,但這是「整天」的量;盤中 09:46 才 2.5 倍的,整天通常更大)/ 5 / 10(較接近盤中就爆的那種)/ 2(高原)
 *   進場 A = 當天收盤買(最接近「盤中看到就買」,實際盤中價會不同)・B = 隔天開盤買(開盤就漲停買不到 → 剔除計數)
 *   抱 1 / 5 / 20 天(含息還原收盤),扣來回成本 0.44%;對照 = 同一天全部股票(同一個進場規則)
 *   分組:流動性(昨天量 <100 張 / 20 日均成交額 <0.1 億 · 0.1~1 億 · ≥1 億)× 大盤(跌 ≥2% / 平常 / 小跌)
 *   斷崖(減資 / 分割沒還原,ind.jump)落在持有期間 → 那筆不算
 * 六關:maxim_kbar5_probe.gates(增量 = 事件 − 同一天全部股票平均)
 *
 * 跑法:DATA_DIR=$S/d16 DIV=$S/d16/_div16.json node --max-old-space-size=8000 scripts/volsurge_probe.mjs out.json
 *       node scripts/volsurge_probe.mjs --selftest
 */
import fs from 'fs';
import { loadCtx } from './leader_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';

export const COST = 0.44, DEDUP = 20, HS = [1, 5, 20], KS = [2, 2.5, 5, 10], LO = 0.015, HI = 0.06;
const limOf = d => (d < '2015-06-01' ? 0.07 : 0.10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

/** 第 i 天是不是事件(只用 ≤ i 的資料);回 null 或 { vr, r } */
export function surgeAt(S, i, K) {
    const c = S.C[i], p = S.C[i - 1], v = S.V[i], pv = S.V[i - 1];
    if (!(c > 0 && p > 0 && v > 0 && pv > 0) || S.F[i] !== 1) return null;
    const r = c / p - 1, vr = v / pv;
    return r >= LO && r <= HI && vr >= K ? { vr, r } : null;
}
/** 持有期間 (i, i+h] 有沒有斷崖(prepStock 的 ind.jump = 到那天為止最後一次物理不可能的跳動) */
const cliffIn = (S, i, h) => !!(S.jump && S.jump[i + h] > i);          // ⚠️ prepStock 把 ind 攤平在 S 上(S.jump / S.val20),⛔ S.ind
/** 進場 A:第 i 天收盤買 → 第 i+h 天收盤;進場 B:第 i+1 天開盤買 → 第 i+h 天收盤(開盤離漲停 <0.3% = 買不到) */
export function fwdA(S, i, h, n) { if (i + h >= n || !(S.A[i] > 0 && S.A[i + h] > 0) || cliffIn(S, i, h)) return null; return (S.A[i + h] / S.A[i] - 1) * 100; }
export function fwdB(S, i, h, cal) {
    const n = cal.length, o = S.O[i + 1], c1 = S.C[i + 1], pc = S.C[i];
    if (!(i + h < n && o > 0 && c1 > 0 && pc > 0) || cliffIn(S, i, h)) return null;
    if (o >= pc * (1 + limOf(cal[i + 1]) - 0.003)) return 'lim';
    if (!(S.A[i + h] > 0 && S.A[i + 1] > 0)) return null;
    return ((c1 / o) * (S.A[i + h] / S.A[i + 1]) - 1) * 100;
}
export function liqOf(S, i) {
    const pv = S.V[i - 1] / 1000, v20 = S.val20 ? S.val20[i - 1] : NaN;
    return { thin: pv < 100, amt: !(v20 > 0) ? '?' : v20 < 1e7 ? '<0.1億' : v20 < 1e8 ? '0.1~1億' : '≥1億' };
}

export function scan(ctx, tw, opt = {}) {
    const { cal, stocks } = ctx, n = cal.length, ks = opt.KS || KS, hs = opt.HS || HS;
    const mret = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) if (tw[i] > 0 && tw[i - 1] > 0) mret[i] = (tw[i] / tw[i - 1] - 1) * 100;
    const out = { ev: {}, cnt: { lim: 0 }, perDay: {} };
    const put = (k, h, o) => { const a = (out.ev[k] = out.ev[k] || {}); (a[h] = a[h] || []).push(o); };
    const cache = new Map();
    const dayMean = (i, h, mode) => { const key = (i * 100 + h) * 2 + (mode === 'B' ? 1 : 0); if (cache.has(key)) return cache.get(key);
        const a = []; for (const S of stocks) { const r = mode === 'B' ? fwdB(S, i, h, cal) : fwdA(S, i, h, n); if (typeof r === 'number') a.push(r); }
        const v = a.length >= 30 ? mean(a) : NaN; cache.set(key, v); return v; };
    for (const K of ks) {
        const last = new Map(); let days = 0, evN = 0;
        for (let i = 21; i < n - 1; i++) {
            let today = 0;
            for (const S of stocks) {
                const e = surgeAt(S, i, K); if (!e) continue;
                today++;
                const lp = last.get(S.sym); if (lp != null && i - lp < DEDUP) continue;
                last.set(S.sym, i); evN++;
                const L = liqOf(S, i), m = mret[i];
                const mk = !Number.isFinite(m) ? '?' : m <= -2 ? '大盤跌≥2%' : m > -0.5 ? '平常日' : '大盤小跌';
                for (const h of hs) for (const mode of ['A', 'B']) {
                    const r = mode === 'B' ? fwdB(S, i, h, cal) : fwdA(S, i, h, n);
                    if (r === 'lim') { if (h === hs[0]) out.cnt.lim++; continue; }
                    if (r == null) continue;
                    const am = dayMean(i, h, mode);
                    const o = { d: cal[i], s: S.sym, r, raw: r - COST, inc: Number.isFinite(am) ? r - am : NaN };
                    const tag = `K${K}·${mode}`;
                    put(`${tag}·全部`, h, o);
                    put(`${tag}·${L.thin ? '昨量<100張' : '昨量≥100張'}`, h, o);
                    put(`${tag}·均額${L.amt}`, h, o);
                    put(`${tag}·${mk}`, h, o);
                    if (mk === '大盤跌≥2%' && !L.thin) put(`${tag}·大盤跌≥2%·昨量≥100張`, h, o);
                }
            }
            if (today) days++;
            if (K === 2.5) (out.perDay[cal[i].slice(0, 4)] = out.perDay[cal[i].slice(0, 4)] || []).push(today);
        }
        out.cnt[`K${K}`] = { events: evN, daysWithAny: days };
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
            res[k][h] = { n: arr.length, ret: +mean(arr.map(o => o.r)).toFixed(2), abs: +mean(arr.map(o => o.raw)).toFixed(2),
                up: +(100 * arr.filter(o => o.raw > 0).length / arr.length).toFixed(1), inc: g.inc, t: g.t, pass: g.pass, gates: g.gates, years: g.years };
        }
    }
    return res;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 140, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10));
    const mk = (sym, f, vf, o = {}) => { const C = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), V = new Float64Array(n), F = new Float64Array(n).fill(1);
        for (let i = 0; i < n; i++) { C[i] = f(i); O[i] = i ? C[i - 1] : C[i]; H[i] = Math.max(C[i], O[i]); V[i] = vf(i); }
        const jump = new Int32Array(n).fill(-1e9), val20 = new Float64Array(n).fill(o.amt ?? 5e8);
        if (o.mod) o.mod({ C, O, H, V, F, jump });
        return { sym, C, O, H, V, F, A: C.slice(), jump, val20 }; };         // 形狀照 prepStock(攤平)
    const others = Array.from({ length: 40 }, (_, k) => mk(String(2000 + k), () => 50, () => 1e6));
    // X:第 60 天 +3%、量 3 倍(昨天 100 張 → 今天 300 張),之後每天 +1%
    const X = mk('1111', i => (i < 60 ? 100 : 103 * (1 + 0.01 * (i - 60))), i => (i === 60 ? 3e5 : 1e5));
    const tw = Array.from({ length: n }, () => 100);
    const s = summarize(scan({ cal, stocks: [X, ...others] }, tw, { KS: [2.5], HS: [5] }));
    const a = s['K2.5·A·全部'] && s['K2.5·A·全部']['5'];
    t(a && a.n === 1 && Math.abs(a.ret - 5) < 1e-6, '① 第 60 天量 3 倍、漲 3% → 當天收盤買、抱 5 天 = +5%');
    t(s['K2.5·A·昨量≥100張'] && s['K2.5·A·均額≥1億'], '② 昨天 100 張 → 進「昨量≥100張」;20 日均額 5 億 → 「≥1億」');
    // 漲太多(+8%)或下跌 → 不算
    const Xh = mk('1112', i => (i < 60 ? 100 : 108), i => (i === 60 ? 5e5 : 1e5));
    const Xd = mk('1113', i => (i < 60 ? 100 : 98), i => (i === 60 ? 5e5 : 1e5));
    t(!scan({ cal, stocks: [Xh, Xd, ...others] }, tw, { KS: [2.5], HS: [5] }).ev['K2.5·A·全部'], '③ 漲 8% 或下跌 ⛔ 不算(App 只收 1.5~6%)');
    // 量不夠 2.5 倍 → 不算;除權息日 → 不算
    const Xv = mk('1114', i => (i < 60 ? 100 : 103), i => (i === 60 ? 2e5 : 1e5));
    const Xf = mk('1115', i => (i < 60 ? 100 : 103), i => (i === 60 ? 5e5 : 1e5), { mod: q => { q.F[60] = 0.97; } });
    t(!scan({ cal, stocks: [Xv, Xf, ...others] }, tw, { KS: [2.5], HS: [5] }).ev['K2.5·A·全部'], '④ 量只有 2 倍 / 除權息日 ⛔ 不算');
    // ⛔ 前視:改掉未來的量,事件判斷不變
    const Xp = mk('1116', i => (i < 60 ? 100 : 103 * (1 + 0.01 * (i - 60))), i => (i === 60 ? 3e5 : i > 60 ? 9e9 : 1e5));
    const sp = summarize(scan({ cal, stocks: [Xp, ...others] }, tw, { KS: [2.5], HS: [5] }));
    t(sp['K2.5·A·全部'] && sp['K2.5·A·全部']['5'].n === 1, '⑤ 改掉未來的成交量 → 第 60 天照樣是事件(⛔ 前視)');
    // 持有期間碰到斷崖 → 那筆不算
    const Xc = mk('1117', i => (i < 60 ? 100 : 103), i => (i === 60 ? 3e5 : 1e5), { mod: q => { for (let i = 62; i < n; i++) q.jump[i] = 62; } });
    t(!scan({ cal, stocks: [Xc, ...others] }, tw, { KS: [2.5], HS: [5] }).ev['K2.5·A·全部'], '⑥ 持有期間有減資 / 分割斷崖 → 那筆不算');
    // 同一檔 20 天內只算一次;隔天開盤漲停買不到 → 計數
    const Xr = mk('1118', i => 100 * Math.pow(1.03, Math.max(0, Math.min(i, 64) - 59)), i => (i >= 60 && i <= 64 ? 1e5 * Math.pow(3, i - 59) : 1e5));
    const or = scan({ cal, stocks: [Xr, ...others] }, tw, { KS: [2.5], HS: [5] });
    t(or.ev['K2.5·A·全部'] && or.ev['K2.5·A·全部'][5].length === 1, '⑦ 連 5 天都符合 → 只算第一天(20 天去重)');
    const Xl = mk('1119', i => (i < 60 ? 100 : i === 60 ? 103 : 113.3), i => (i === 60 ? 3e5 : 1e5), { mod: q => { q.O[61] = 113.3; } });
    const ol = scan({ cal, stocks: [Xl, ...others] }, tw, { KS: [2.5], HS: [5] });
    t(ol.cnt.lim === 1 && !(ol.ev['K2.5·B·全部'] && ol.ev['K2.5·B·全部'][5]), '⑧ 隔天開盤就漲停 → B 買不到、剔除並計數');
    // 增量 = 事件 − 同一天全部股票(這裡其他股票都平 → 增量 = 報酬)
    const o9 = scan({ cal, stocks: [X, ...others] }, tw, { KS: [2.5], HS: [5] }).ev['K2.5·A·全部'][5][0];
    const others9 = Array.from({ length: 40 }, (_, k) => mk(String(3000 + k), i => (i <= 60 ? 50 : 51), () => 1e6));   // 其他股票第 61 天起 +2%
    const o9b = scan({ cal, stocks: [X, ...others9] }, tw, { KS: [2.5], HS: [5] }).ev['K2.5·A·全部'][5][0];
    t(Math.abs(o9.inc - (5 - 5 / 41)) < 1e-6 && Math.abs(o9b.inc - (5 - (5 + 40 * 2) / 41)) < 1e-6 && o9b.inc < o9.inc,
        '⑨ 增量 = 事件 − 同一天全部股票平均(別的股票漲 2% → 增量跟著變小)');
    // 大盤跌 ≥2% 那天 → 進大盤跌組
    const tw2 = Array.from({ length: n }, (_, i) => (i === 60 ? 97 : 100));
    const s10 = summarize(scan({ cal, stocks: [X, ...others] }, tw2, { KS: [2.5], HS: [5] }));
    t(!!s10['K2.5·A·大盤跌≥2%'] && !s10['K2.5·A·平常日'], '⑩ 大盤當天跌 3% → 進「大盤跌≥2%」組');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('volsurge_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const ctx = loadCtx(process.env.DATA_DIR, process.env.DIV);
    const raw = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/^TWII.json`, 'utf8'));
    const m = new Map(raw.map(r => [String(r.date).replace(/\//g, '-').slice(0, 10), +r.close]));
    const tw = ctx.cal.map(d => m.get(d) || NaN);
    const out = scan(ctx, tw), res = summarize(out);
    console.log(`股票 ${ctx.stocks.length} 檔 ・${ctx.cal[0]} ~ ${ctx.cal.at(-1)} ・開盤漲停買不到 ${out.cnt.lim} 筆`);
    for (const K of KS) console.log(`K=${K}:事件 ${out.cnt['K' + K].events} 筆(去重後)・有事件的日子 ${out.cnt['K' + K].daysWithAny} 天`);
    const pd = Object.entries(out.perDay).map(([y, a]) => `${y} ${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1)}`).join(' ・');
    console.log(`K=2.5 每天平均幾檔符合(去重前):${pd}`);
    for (const [k, byH] of Object.entries(res)) for (const h of HS) { const r = byH[h]; if (!r) continue;
        console.log(`${k.padEnd(26)} h=${String(h).padStart(2)} n=${String(r.n).padStart(6)} 平均 ${r.ret}% ・扣成本 ${r.abs}% ・扣完還賺 ${r.up}% ・比同一天全部股票 ${r.inc} t=${r.t} ・六關 ${r.pass}/6`); }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ cnt: out.cnt, res }, null, 1));
}
