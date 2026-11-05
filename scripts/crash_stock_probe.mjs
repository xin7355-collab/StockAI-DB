#!/usr/bin/env node
/**
 * 🧺 crash_stock_probe.mjs —— 大盤跌深的時候,哪一種股票之後比較會回來?(V81.0.2,使用者 11/06 問 4、6 + 逐字稿 #8 #17)
 *
 * 時點:加權每一段修正(收盤比近 250 天最高收盤低 ≥10%,lib_crash.corrLegs)裡,第一次跌到 ≥10% / ≥15% / ≥20% 的那天收盤
 * 那天全市場(d16,含已下市;20 日均成交額 ≥0.1 億 = 買得到;近 250 天沒有減資 / 分割斷崖)分組:
 *   ≤4 折 / ≤3 折:收盤(含息還原)≤ 近 250 天最高的 40% / 30%(逐字稿 #8「跌到一年高點三四折」)
 *   站在季線上:收盤 > 60 日均線(原始收盤,同 App 的尺;逐字稿 #17「大跌還站在季線上的才是強勢股」)
 *   跌最深 10% / 最抗跌 10%:從加權那段高點那天到今天,這一檔跌了多少,全市場排前 / 後 10%
 * 之後 20 / 60 / 120 天(含息)vs 同一天全部股票(⛔ 跟別天比,陷阱 #50);持有期間碰到斷崖那筆不算
 * 每一段每個門檻只算一次 → 事件數 = 段數(十幾到三十幾),只描述;⛔ 改 App
 *
 * 跑法:DATA_DIR=$S/d16 DIV=$S/d16/_div16.json node --max-old-space-size=8000 scripts/crash_stock_probe.mjs out.json
 *       node scripts/crash_stock_probe.mjs --selftest
 */
import fs from 'fs';
import { loadCtx } from './leader_probe.mjs';
import { corrLegs, mean, med, r2 } from './lib_crash.mjs';

export const HS = [20, 60, 120], DDS = [10, 15, 20], MIN_AMT = 1e7, LOOK = 250;

/** 每一段修正裡第一次跌到 ≥X% 的那天(只用 ≤ i 的指數) */
export function evalDays(tw, X) {
    const CL = corrLegs(tw), out = [];
    CL.legs.forEach((L, k) => { for (let i = L.s; i <= L.e; i++) if (tw[i] / CL.hi[i] - 1 <= -X / 100) { out.push({ i, leg: k, peakI: L.peakI }); break; } });
    return out;
}

/** 第 i 天這一檔的特徵(只用 ≤ i);回 null = 這天不算(買不到 / 歷史不夠 / 近一年有斷崖) */
export function featAt(S, i, peakI) {
    if (!(S.A[i] > 0 && S.C[i] > 0) || !(S.val20[i] >= MIN_AMT) || i < LOOK) return null;
    if (S.jump[i] > i - LOOK) return null;
    let hi = 0, n = 0; for (let k = i - LOOK + 1; k <= i; k++) if (S.A[k] > 0) { n++; if (S.A[k] > hi) hi = S.A[k]; }
    if (n < 200 || !(hi > 0)) return null;
    const pk = S.A[peakI] > 0 ? S.A[peakI] : null;
    return { ratio: S.A[i] / hi, above60: S.ma60r[i] > 0 ? S.C[i] > S.ma60r[i] : null, ddLeg: pk ? S.A[i] / pk - 1 : null };
}
export function fwd(S, i, h) {
    if (i + h >= S.A.length || !(S.A[i] > 0 && S.A[i + h] > 0)) return null;
    if (S.jump[i + h] > i) return null;
    return (S.A[i + h] / S.A[i] - 1) * 100;
}
export const GROUPS = ['≤4折', '≤3折', '站在季線上', '季線下', '跌最深10%', '最抗跌10%'];

/** 一個時點的橫切面:每組平均 − 全部平均(同一天) */
export function crossAt(stocks, i, peakI, hs = HS) {
    const rows = [];
    for (const S of stocks) { const f = featAt(S, i, peakI); if (f) rows.push({ S, f }); }
    if (rows.length < 50) return null;
    const dd = rows.filter(r => r.f.ddLeg != null).map(r => r.f.ddLeg).sort((a, b) => a - b);
    const q10 = dd[Math.floor(dd.length * 0.1)], q90 = dd[Math.floor(dd.length * 0.9)];
    const inG = (g, f) => g === '≤4折' ? f.ratio <= 0.4 : g === '≤3折' ? f.ratio <= 0.3 : g === '站在季線上' ? f.above60 === true : g === '季線下' ? f.above60 === false
        : g === '跌最深10%' ? f.ddLeg != null && f.ddLeg <= q10 : g === '最抗跌10%' ? f.ddLeg != null && f.ddLeg >= q90 : false;
    const out = { n: rows.length, h: {} };
    for (const h of hs) {
        const all = rows.map(r => fwd(r.S, i, h)).filter(x => x != null);
        if (all.length < 50) continue;
        const am = mean(all), g = {};
        for (const G of GROUPS) { const xs = rows.filter(r => inG(G, r.f)).map(r => fwd(r.S, i, h)).filter(x => x != null);
            g[G] = xs.length >= 5 ? { n: xs.length, m: mean(xs), ex: mean(xs) - am } : { n: xs.length }; }
        out.h[h] = { all: am, nAll: all.length, g };
    }
    return out;
}

export function run(ctx, tw, log = console.log) {
    const res = {};
    for (const X of DDS) {
        const ev = evalDays(tw, X); res[X] = { ev: [], sum: {} };
        log(`\n── 加權每一段第一次跌到 ≥${X}%:${ev.length} 次 ──`);
        for (const e of ev) { const c = crossAt(ctx.stocks, e.i, e.peakI); if (!c) continue; res[X].ev.push({ d: ctx.cal[e.i], c }); }
        for (const h of HS) {
            log(`  ${h} 天(含息)vs 同一天全部股票:`);
            for (const G of GROUPS) {
                const xs = res[X].ev.map(o => o.c.h[h] && o.c.h[h].g[G]).filter(z => z && z.ex != null);
                if (xs.length < 3) { log(`    ${G.padEnd(6)} 次數太少(${xs.length})`); continue; }
                const ex = xs.map(z => z.ex), sd = Math.sqrt(mean(ex.map(x => (x - mean(ex)) ** 2))), t = sd > 0 ? mean(ex) / (sd / Math.sqrt(ex.length)) : 0;
                const half = ex.length >> 1, h1 = mean(ex.slice(0, half)), h2 = mean(ex.slice(half));
                res[X].sum[`${G}|${h}`] = { n: ex.length, ex: r2(mean(ex)), med: r2(med(ex)), win: ex.filter(x => x > 0).length, t: r2(t), h1: r2(h1), h2: r2(h2), size: Math.round(mean(xs.map(z => z.n))) };
                const s = res[X].sum[`${G}|${h}`];
                log(`    ${G.padEnd(6)} 平均多 ${String(s.ex).padStart(6)}pp(中位 ${s.med})・贏的次數 ${s.win}/${s.n} ・t=${s.t} ・前後半 ${s.h1}/${s.h2} ・每次約 ${s.size} 檔`);
            }
        }
        log('  每一次:' + res[X].ev.map(o => `${o.d}(${o.c.n} 檔)`).join(' ・'));
    }
    return res;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 1200, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2012, 0, 2 + i)).toISOString().slice(0, 10));
    // 加權:第 0~399 天漲、400~460 跌 25%、之後回升;第 800~840 再跌 18%
    const tw = cal.map((_, i) => i < 400 ? 100 + i * 0.05 : i < 460 ? 120 * (1 - 0.25 * (i - 400) / 60) : i < 800 ? 90 + (i - 460) * 0.1 : i < 840 ? 124 * (1 - 0.18 * (i - 800) / 40) : 101.7 + (i - 840) * 0.05);
    const mk = (sym, f) => { const C = new Float64Array(n), V = new Float64Array(n).fill(1e6); for (let i = 0; i < n; i++) C[i] = f(i);
        const ma60r = new Float64Array(n).fill(NaN); for (let i = 59; i < n; i++) { let s = 0; for (let k = i - 59; k <= i; k++) s += C[k]; ma60r[i] = s / 60; }
        return { sym, C, A: C.slice(), V, val20: new Float64Array(n).fill(5e8), ma60r, jump: new Int32Array(n).fill(-1e9) }; };
    let seed = 5; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const mkU = boost => Array.from({ length: 120 }, (_, k) => { const deep = k < 20, drift = (R() - 0.5) * 0.002;
        return mk(String(1000 + k), i => { let v = 50 * Math.exp(drift * i);
            if (deep) { if (i >= 400 && i < 420) v *= 1 - 0.7 * (i - 400) / 20; else if (i >= 420) v *= 0.3 * (1 + boost * (i - 420)); }
            else { if (i >= 400 && i < 420) v *= 1 - 0.2 * (i - 400) / 20; else if (i >= 420) v *= 0.8; }
            return v; }); });
    const ev = evalDays(tw, 15);
    t(ev.length >= 1 && ev[0].i > 400 && ev[0].i < 460, `① 加權第一次跌到 15% 那天在第一段裡(第 ${ev[0] && ev[0].i} 天)`);
    const U1 = mkU(0.01), c1 = crossAt(U1, ev[0].i, ev[0].peakI, [60]);
    t(c1 && c1.h[60].g['≤4折'].n >= 15 && c1.h[60].g['≤4折'].ex > 20, `② 埋「跌到 3 折以下的之後每天 +1%」→ ≤4 折那組多 ${c1 && r2(c1.h[60].g['≤4折'].ex)}pp`);
    const U0 = mkU(0), c0 = crossAt(U0, ev[0].i, ev[0].peakI, [60]);
    t(c0 && Math.abs(c0.h[60].g['≤4折'].ex) < 3, `③ 沒埋 → ≤4 折那組跟全部差不多(${c0 && r2(c0.h[60].g['≤4折'].ex)}pp)`);
    // ⛔ 前視:改掉第 i 天之後的價格,分組不變
    const i0 = ev[0].i, U2 = U1.map(S => { const C = S.C.slice(); for (let k = i0 + 1; k < n; k++) C[k] = 1; return { ...S, C, A: C.slice() }; });
    const same = U1.every((S, k) => JSON.stringify(featAt(S, i0, ev[0].peakI)) === JSON.stringify(featAt(U2[k], i0, ev[0].peakI)));
    t(same, '④ 改掉那天之後的價格 → 每一檔的分組一模一樣(⛔ 前視)');
    // 斷崖:近一年有斷崖 → 那天不算;持有期間有斷崖 → 那筆報酬不算
    const Sj = mk('9999', i => 50); Sj.jump.fill(-1e9); for (let k = i0 - 10; k < n; k++) Sj.jump[k] = i0 - 10;
    t(featAt(Sj, i0, ev[0].peakI) === null, '⑤ 近 250 天有減資 / 分割斷崖 → 那天這檔不算');
    const Sh = mk('9998', i => 50); for (let k = i0 + 5; k < n; k++) Sh.jump[k] = i0 + 5;
    t(featAt(Sh, i0, ev[0].peakI) !== null && fwd(Sh, i0, 20) === null, '⑥ 持有期間碰到斷崖 → 那筆報酬不算');
    // 成交額不夠 → 不算
    const Sa = mk('9997', i => 50); Sa.val20.fill(5e6);
    t(featAt(Sa, i0, ev[0].peakI) === null, '⑦ 20 日均成交額 < 0.1 億 → 買不到,不算');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('crash_stock_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const ctx = loadCtx(process.env.DATA_DIR, process.env.DIV);
    const raw = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/^TWII.json`, 'utf8'));
    const m = new Map(raw.map(r => [String(r.date).replace(/\//g, '-').slice(0, 10), +r.close]));
    const tw = ctx.cal.map(d => m.get(d) || NaN);
    for (let i = 1; i < tw.length; i++) if (!(tw[i] > 0)) tw[i] = tw[i - 1];
    console.log(`股票 ${ctx.stocks.length} 檔 ・${ctx.cal[0]} ~ ${ctx.cal.at(-1)}`);
    const out = run(ctx, tw);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { sum: v.sum, dates: v.ev.map(o => o.d) }])), null, 1));
}
