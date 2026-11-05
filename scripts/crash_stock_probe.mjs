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
 * V81.0.3 擴充(使用者 11/06「大跌的神級操作」):
 *   ・扣掉 beta:進場前 250 天日報酬對加權回歸的斜率(只用 ≤ i),每一檔之後報酬先減 beta × 加權同期報酬再比
 *     —— 跌最深的多半是高 beta,大盤一反彈它本來就彈得多,⛔ 不算「挑對股票」
 *   ・門檻高原:跌最深 5% / 10% / 20%;再加「離一年高點 10% 內(強勢股)」「過去一年贏家 / 輸家」(250→20 天前,動能)
 *   ・時點再加「追盤日」(ftd_probe.detectFTD,只用 ≤ i)
 *   ・安慰劑:同一套分組換到 120 個交易日之後那天(⛔ 不是大跌那天)→ 分組本身天生的差別會在這裡現形
 *   ・跟「同期買合成正 2」比(2 × 加權日報酬 − 2.5%/年,同 crash_playbook_probe)
 *   ・Benjamini-Hochberg(lib_fdr.bhQ)把全部「門檻 × 分組 × 天數」的 p 一起校正
 *
 * 跑法:DATA_DIR=$S/d16 DIV=$S/d16/_div16.json node --max-old-space-size=8000 scripts/crash_stock_probe.mjs out.json
 *       node scripts/crash_stock_probe.mjs --selftest
 */
import fs from 'fs';
import { loadCtx } from './leader_probe.mjs';
import { corrLegs, mean, med, r2 } from './lib_crash.mjs';
import { detectFTD } from './ftd_probe.mjs';
import { bhQ } from './lib_fdr.mjs';
import { trSeries } from './lib_totalreturn.mjs';

export const HS = [20, 60, 120], DDS = [10, 15, 20], MIN_AMT = 1e7, LOOK = 250;

/** 每一段修正裡第一次跌到 ≥X% 的那天(只用 ≤ i 的指數) */
export function evalDays(tw, X) {
    const CL = corrLegs(tw), out = [];
    CL.legs.forEach((L, k) => { for (let i = L.s; i <= L.e; i++) if (tw[i] / CL.hi[i] - 1 <= -X / 100) { out.push({ i, leg: k, peakI: L.peakI }); break; } });
    return out;
}

/** 第 i 天這一檔的特徵(只用 ≤ i);回 null = 這天不算(買不到 / 歷史不夠 / 近一年有斷崖) */
export function featAt(S, i, peakI, tw = null) {
    if (!(S.A[i] > 0 && S.C[i] > 0) || !(S.val20[i] >= MIN_AMT) || i < LOOK) return null;
    if (S.jump[i] > i - LOOK) return null;
    let hi = 0, n = 0; for (let k = i - LOOK + 1; k <= i; k++) if (S.A[k] > 0) { n++; if (S.A[k] > hi) hi = S.A[k]; }
    if (n < 200 || !(hi > 0)) return null;
    const pk = S.A[peakI] > 0 ? S.A[peakI] : null;
    const a20 = S.A[i - 20], a250 = S.A[i - LOOK + 1];
    return { ratio: S.A[i] / hi, above60: S.ma60r[i] > 0 ? S.C[i] > S.ma60r[i] : null, ddLeg: pk ? S.A[i] / pk - 1 : null,
        mom: a20 > 0 && a250 > 0 ? a20 / a250 - 1 : null, beta: tw ? betaAt(S.A, tw, i) : null };
}

/** 進場前 250 天日報酬對加權回歸的斜率(只用 ≤ i;有效天數 < 150 → null) */
export function betaAt(A, tw, i, W = LOOK) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = i - W + 1; k <= i; k++) {
        if (!(A[k] > 0 && A[k - 1] > 0 && tw[k] > 0 && tw[k - 1] > 0)) continue;
        const y = A[k] / A[k - 1] - 1, x = tw[k] / tw[k - 1] - 1;
        if (Math.abs(y) > 0.25) continue;                      // 斷崖 / 除權沒還原乾淨的那天不進迴歸
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 150) return null;
    const vx = sxx - sx * sx / n;
    return vx > 0 ? (sxy - sx * sy / n) / vx : null;
}
/** 加權 h 天報酬(%)與同期合成正 2(2 × 日報酬 − 2.5%/年) */
export function idxFwd(tw, i, h) { return i + h < tw.length && tw[i] > 0 && tw[i + h] > 0 ? (tw[i + h] / tw[i] - 1) * 100 : null; }
export function idx2x(tw, i, h) {
    if (!(i + h < tw.length)) return null; let v = 1;
    for (let k = i + 1; k <= i + h; k++) { if (!(tw[k] > 0 && tw[k - 1] > 0)) return null; v *= 1 + 2 * (tw[k] / tw[k - 1] - 1) - 0.025 / 252; }
    return (v - 1) * 100;
}
export function fwd(S, i, h) {
    if (i + h >= S.A.length || !(S.A[i] > 0 && S.A[i + h] > 0)) return null;
    if (S.jump[i + h] > i) return null;
    return (S.A[i + h] / S.A[i] - 1) * 100;
}
export const GROUPS = ['≤4折', '≤3折', '站在季線上', '季線下', '跌最深10%', '最抗跌10%',
    '跌最深5%', '跌最深20%', '離一年高點10%內', '一年贏家前10%', '一年輸家後10%'];

/** 一個時點的橫切面:每組平均 − 全部平均(同一天) */
export function crossAt(stocks, i, peakI, hs = HS, tw = null) {
    const rows = [];
    for (const S of stocks) { const f = featAt(S, i, peakI, tw); if (f) rows.push({ S, f }); }
    if (rows.length < 50) return null;
    const qq = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const dd = rows.filter(r => r.f.ddLeg != null).map(r => r.f.ddLeg).sort((a, b) => a - b);
    const mo = rows.filter(r => r.f.mom != null).map(r => r.f.mom).sort((a, b) => a - b);
    const q5 = qq(dd, 0.05), q10 = qq(dd, 0.1), q20 = qq(dd, 0.2), q90 = qq(dd, 0.9), m10 = qq(mo, 0.1), m90 = qq(mo, 0.9);
    const inG = (g, f) => g === '≤4折' ? f.ratio <= 0.4 : g === '≤3折' ? f.ratio <= 0.3 : g === '站在季線上' ? f.above60 === true : g === '季線下' ? f.above60 === false
        : g === '跌最深10%' ? f.ddLeg != null && f.ddLeg <= q10 : g === '最抗跌10%' ? f.ddLeg != null && f.ddLeg >= q90
        : g === '跌最深5%' ? f.ddLeg != null && f.ddLeg <= q5 : g === '跌最深20%' ? f.ddLeg != null && f.ddLeg <= q20
        : g === '離一年高點10%內' ? f.ratio >= 0.9 : g === '一年贏家前10%' ? f.mom != null && f.mom >= m90 : g === '一年輸家後10%' ? f.mom != null && f.mom <= m10 : false;
    const out = { n: rows.length, h: {} };
    for (const h of hs) {
        const ix = tw ? idxFwd(tw, i, h) : null;
        const pr = rows.map(r => { const x = fwd(r.S, i, h); return x == null ? null : { r, x, a: ix != null && r.f.beta != null ? x - r.f.beta * ix : null }; }).filter(Boolean);
        if (pr.length < 50) continue;
        const am = mean(pr.map(z => z.x)), adj = pr.filter(z => z.a != null), aa = adj.length >= 50 ? mean(adj.map(z => z.a)) : null, g = {};
        for (const G of GROUPS) {
            const gs = pr.filter(z => inG(G, z.r.f));
            const ga = gs.filter(z => z.a != null);
            g[G] = gs.length >= 5 ? { n: gs.length, m: mean(gs.map(z => z.x)), ex: mean(gs.map(z => z.x)) - am,
                exb: aa != null && ga.length >= 5 ? mean(ga.map(z => z.a)) - aa : null, beta: ga.length ? mean(ga.map(z => z.r.f.beta)) : null } : { n: gs.length };
        }
        out.h[h] = { all: am, nAll: pr.length, g, idx: ix, x2: tw ? idx2x(tw, i, h) : null };
    }
    return out;
}

/** 追盤日(ftd_probe 同一支,只用 ≤ i):每一段修正第一次 FTD → {i, peakI}(peakI = 那段的高點) */
export function ftdDays(tw, amt) {
    const CL = corrLegs(tw), { ftd } = detectFTD(tw, amt), seen = new Set(), out = [];
    for (const f of ftd) { const k = CL.corr[f.i]; const L = k >= 0 ? CL.legs[k] : CL.legs.find(L => L.s <= f.i && f.i <= L.e + 5);
        const key = L ? CL.legs.indexOf(L) : -1; if (key < 0 || seen.has(key)) continue; seen.add(key); out.push({ i: f.i, leg: key, peakI: L.peakI }); }
    return out;
}

export function run(ctx, tw, log = console.log, amt = null) {
    const res = {}, allP = [];
    const timings = DDS.map(X => [`跌到 ≥${X}%`, evalDays(tw, X)]);
    if (amt) timings.push(['追盤日(FTD)', ftdDays(tw, amt)]);
    const tstat = ex => { const m = mean(ex), sd = Math.sqrt(mean(ex.map(x => (x - m) ** 2))); return sd > 0 ? m / (sd / Math.sqrt(ex.length)) : 0; };
    const pOf = t => { const z = Math.abs(t); const tt = 1 / (1 + 0.2316419 * z), d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
        const cdf = 1 - d * tt * (0.31938153 + tt * (-0.356563782 + tt * (1.781477937 + tt * (-1.821255978 + tt * 1.330274429)))); return 2 * (1 - cdf); };
    for (const [tag, ev] of timings) {
        res[tag] = { ev: [], pl: [], sum: {} };
        log(`\n── 加權每一段第一次${tag}:${ev.length} 次 ──`);
        for (const e of ev) {
            const c = crossAt(ctx.stocks, e.i, e.peakI, HS, tw); if (c) res[tag].ev.push({ d: ctx.cal[e.i], c });
            const j = e.i + 120;                                      // 安慰劑:同一套分組,換到 120 個交易日之後(⛔ 不是大跌那天)
            if (j + 20 < tw.length) { const cp = crossAt(ctx.stocks, j, e.peakI + 120, HS, tw); if (cp) res[tag].pl.push({ d: ctx.cal[j], c: cp }); }
        }
        for (const h of HS) {
            log(`  ${h} 天(含息)vs 同一天全部股票 ・[扣 beta 之後] ・{同一套分組挪到 120 天後那天} ・〈這組 vs 同期合成正 2〉:`);
            for (const G of GROUPS) {
                const xs = res[tag].ev.map(o => o.c.h[h] && Object.assign({ x2: o.c.h[h].x2 }, o.c.h[h].g[G])).filter(z => z && z.ex != null);
                if (xs.length < 3) { log(`    ${G.padEnd(9)} 次數太少(${xs.length})`); continue; }
                const ex = xs.map(z => z.ex), t = tstat(ex), half = ex.length >> 1;
                const eb = xs.filter(z => z.exb != null).map(z => z.exb), tb = eb.length >= 3 ? tstat(eb) : null;
                const pl = res[tag].pl.map(o => o.c.h[h] && o.c.h[h].g[G]).filter(z => z && z.ex != null).map(z => z.ex);
                const v2 = xs.filter(z => z.x2 != null), w2 = v2.filter(z => z.m > z.x2).length;
                const S = { n: ex.length, ex: r2(mean(ex)), med: r2(med(ex)), win: ex.filter(x => x > 0).length, t: r2(t), p: +pOf(t).toFixed(4),
                    h1: r2(mean(ex.slice(0, half))), h2: r2(mean(ex.slice(half))), size: Math.round(mean(xs.map(z => z.n))),
                    exb: eb.length >= 3 ? r2(mean(eb)) : null, tb: tb != null ? r2(tb) : null, winb: eb.filter(x => x > 0).length, nb: eb.length,
                    beta: r2(mean(xs.filter(z => z.beta != null).map(z => z.beta))),
                    pl: pl.length >= 3 ? r2(mean(pl)) : null, npl: pl.length, plt: pl.length >= 3 ? r2(tstat(pl)) : null,
                    vs2x: v2.length ? r2(mean(v2.map(z => z.m - z.x2))) : null, win2x: w2, n2x: v2.length };
                res[tag].sum[`${G}|${h}`] = S; allP.push([tag, `${G}|${h}`, S.p]);
                log(`    ${G.padEnd(9)} 多 ${String(S.ex).padStart(6)}pp(中位 ${S.med})・贏 ${S.win}/${S.n} ・t=${S.t} ・前後半 ${S.h1}/${S.h2}`
                    + ` ・[扣 beta ${S.exb}pp ・t=${S.tb} ・贏 ${S.winb}/${S.nb} ・beta ${S.beta}]`
                    + ` ・{挪 120 天 ${S.pl}pp ・t=${S.plt} ・${S.npl} 次} ・〈比正 2 ${S.vs2x}pp ・贏 ${S.win2x}/${S.n2x}〉 ・每次約 ${S.size} 檔`);
            }
        }
        log('  每一次:' + res[tag].ev.map(o => `${o.d}(${o.c.n} 檔)`).join(' ・'));
    }
    const qs = bhQ(allP.map(z => z[2]));
    allP.forEach((z, k) => { res[z[0]].sum[z[1]].q = +qs[k].toFixed(4); });
    const top = allP.map((z, k) => [z, qs[k]]).sort((a, b) => a[1] - b[1]).slice(0, 12);
    log(`\n── BH 校正(${allP.length} 個「時點 × 分組 × 天數」一起算)q 最小的 12 個 ──`);
    for (const [[tag, key, p], q] of top) { const S = res[tag].sum[key]; log(`  ${tag} ${key} ・多 ${S.ex}pp ・扣 beta ${S.exb}pp ・p ${p} ・q ${q.toFixed(3)} ・挪 120 天 ${S.pl}pp`); }
    return res;
}

/**
 * 👑 在大跌之後那段跟 0050(含息)比(只描述):EQ_DIR = leader_probe 吐的 17 條逐日淨值(eq_*.json,cash = 總資產)
 * 每個時點(同上:每段第一次跌到 ≥10/15/20%、追盤日)之後 20/60/120 天,17 條的中位報酬 − 0050 同期;
 * 對照:同一段資料「隨便一天」的 👑 − 0050(⛔ 只看大跌那幾天會把 👑 本來就比較會漲的部分算進去)
 */
export function eqAfter(cal, eqs, b50, timings, log = console.log) {
    const out = {};
    const at = (arr, i, h) => (i + h < arr.length && arr[i] > 0 && arr[i + h] > 0 ? (arr[i + h] / arr[i] - 1) * 100 : null);
    const medOf = xs => { const a = xs.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
    const first = eqs.map(e => e.findIndex(v => v > 0)).reduce((a, b) => Math.max(a, b), 0);
    for (const h of HS) {
        const base = [];
        for (let i = first; i + h < cal.length; i += 5) { const m = medOf(eqs.map(e => at(e, i, h))), z = at(b50, i, h); if (m != null && z != null) base.push(m - z); }
        out[`base|${h}`] = { n: base.length, ex: r2(mean(base)) };
        log(`  👑 隨便一天(每 5 天取一次)抱 ${h} 天:17 條中位 − 0050 含息 平均 ${r2(mean(base))}pp(${base.length} 個起點)`);
    }
    for (const [tag, ev] of timings) {
        for (const h of HS) {
            const rows = ev.filter(e => e.i >= first).map(e => { const m = medOf(eqs.map(q => at(q, e.i, h))), z = at(b50, e.i, h); return m != null && z != null ? { d: cal[e.i], m, z, x: m - z } : null; }).filter(Boolean);
            if (!rows.length) continue;
            out[`${tag}|${h}`] = { n: rows.length, ex: r2(mean(rows.map(r => r.x))), win: rows.filter(r => r.x > 0).length, rows: rows.map(r => [r.d, r2(r.m), r2(r.z)]) };
            log(`  👑 ${tag} 之後 ${h} 天:${rows.length} 次 ・👑 − 0050 平均 ${r2(mean(rows.map(r => r.x)))}pp ・贏 ${rows.filter(r => r.x > 0).length}/${rows.length}`
                + (h === 60 ? ' ・' + rows.map(r => `${r.d} 👑${r2(r.m)}% / 0050 ${r2(r.z)}%`).join(' ・') : ''));
        }
    }
    return out;
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
    // ⑧ beta:一檔每天 = 加權 2 倍漲跌 → beta ≈ 2;改掉 i 之後的資料 beta 不變(⛔ 前視)
    const twA = Float64Array.from(tw), B2 = new Float64Array(n); B2[0] = 50;
    for (let k = 1; k < n; k++) B2[k] = B2[k - 1] * (1 + 2 * (twA[k] / twA[k - 1] - 1));
    const b = betaAt(B2, twA, 700), B3 = B2.slice(); for (let k = 701; k < n; k++) B3[k] = 1;
    t(b != null && Math.abs(b - 2) < 1e-6 && betaAt(B3, twA, 700) === b, `⑧ beta:兩倍跟漲跌的股票 = ${b && b.toFixed(4)},改掉之後的資料不變`);
    // ⑨ 扣 beta:埋「跌最深那組只是 beta 高」(每天 = 加權 2 倍)→ 原始多很多、扣 beta 之後 ≈ 0
    const hiB = Array.from({ length: 120 }, (_, k) => mk(String(2000 + k), i => (k < 20 ? B2[i] : 50 * twA[i] / twA[0])));
    const e15 = evalDays(tw, 15)[0], cb = crossAt(hiB, e15.i, e15.peakI, [60], twA);
    const gb = cb && cb.h[60].g['跌最深10%'];
    t(gb && Math.abs(gb.ex) > 3 && Math.abs(gb.exb) < Math.abs(gb.ex) / 5,          // 2 倍日報酬複利 ≠ 期間 2 倍 → 留一點殘差
       `⑨ 只是 beta 高的那組:原始 ${gb && r2(gb.ex)}pp → 扣 beta ${gb && r2(gb.exb)}pp`);
    // ⑩ 合成正 2 = 每天 2 倍 − 2.5%/年
    const x2 = idx2x(twA, 100, 20), man = (() => { let v = 1; for (let k = 101; k <= 120; k++) v *= 1 + 2 * (twA[k] / twA[k - 1] - 1) - 0.025 / 252; return (v - 1) * 100; })();
    t(Math.abs(x2 - man) < 1e-9, '⑩ 合成正 2 = 每天 2 倍漲跌 − 2.5%/年');
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
    const am = new Map(raw.map(r => [String(r.date).replace(/\//g, '-').slice(0, 10), +r.amount || 0]));
    const amt = ctx.cal.map(d => am.get(d) || 0);
    console.log(`股票 ${ctx.stocks.length} 檔 ・${ctx.cal[0]} ~ ${ctx.cal.at(-1)}`);
    const out = run(ctx, tw, console.log, amt);
    if (process.env.EQ_DIR) {
        const pos = new Map(ctx.cal.map((d, i) => [d, i]));
        const files = fs.readdirSync(process.env.EQ_DIR).filter(f => /^eq_\d+\.json$/.test(f));
        const eqs = files.map(f => { const a = new Float64Array(ctx.cal.length).fill(NaN);
            for (const r of JSON.parse(fs.readFileSync(`${process.env.EQ_DIR}/${f}`, 'utf8')).rows) { const i = pos.get(r.d); if (i != null) a[i] = (+r.cash || 0) + (+r.park || 0) + (+r.mv || 0); }
            return a; });
        const b = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/_bench0050.json`, 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-'), c: +r.close })).filter(r => r.c > 0);
        const dv = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/_div0050.json`, 'utf8')).d['0050'].h;
        const T = trSeries(b, dv, {}), tp = new Map(T.d.map((d, i) => [d, T.v[i]]));
        const b50 = ctx.cal.map(d => tp.get(d) ?? NaN);
        console.log(`\n── 👑 在大跌之後(${process.env.EQ_DIR},${files.length} 條淨值)──`);
        const tm = DDS.map(X => [`跌到 ≥${X}%`, evalDays(tw, X)]).concat([['追盤日(FTD)', ftdDays(tw, amt)]]);
        out.lead = eqAfter(ctx.cal, eqs, b50, tm);
    }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, k === 'lead' ? v
        : { sum: v.sum, dates: v.ev.map(o => o.d), pl: v.pl.map(o => o.d) }])), null, 1));
}
