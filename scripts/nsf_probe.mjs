#!/usr/bin/env node
/**
 * 🏛️ nsf_probe.mjs —— 國安基金 9 次進場:進場前有什麼共同點?進場之後怎麼走?(V81.0.2,使用者 11/06 問)
 *
 * 日期(stopfall_probe.NSF;各來源差 1~2 天 → 這裡 ±2 個交易日都算一次看穩不穩):
 *   2000-03-16 政黨輪替 ・2000-10-03 網路泡沫 / 核四 ・2004-05-20 319 ・2008-09-19 金融海嘯 ・2011-12-20 歐債
 *   2015-08-25 人民幣 / 陸股 ・2020-03-20 新冠 ・2022-07-13 升息 / 俄烏 ・2025-04-09 對等關稅
 * 每一次印:進場前從一年高點(收盤)跌了幾 %、離高點幾個交易日、前 10 天最大單日跌幅、近 20 天實現波動(年化)、VIX(2009 起)
 *          進場那天收盤買 → 5 / 20 / 60 / 120 / 250 天(含息 2003 起,之前用價格)、之後還再跌幾 %、幾天到底
 * 對照:① 隨便一天 ② 修正段隨便一天 ③「一樣深、但國安基金沒進場」的修正段(那一段第一次跌到 ≥ 國安基金進場時最淺那次的深度)
 * ⛔ n = 9 只描述,不是訊號;而且日期是事後才知道的(宣布當天收盤前不一定知道)。
 *
 * 跑法:IDX_LONG=$S/k_idx_long.json IDX_EARLY=$S/k_idx_long_early.json TWII_NOW=$S/k6/twii_now.json US_HIST=$S/k6/us_hist.json \
 *       node scripts/nsf_probe.mjs out.json
 *       node scripts/nsf_probe.mjs --selftest
 */
import fs from 'fs';
import { loadIndex, corrLegs, rollMax, mean, med, r2, usToTw } from './lib_crash.mjs';
import { NSF } from './stopfall_probe.mjs';

export const HS = [5, 20, 60, 120, 250];
const rd = p => p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;

/** 第 i 天的「進場前狀態」(只用 ≤ i 的資料) */
export function preState(S, i, hi250) {
    const c = S.c; let pk = i; while (pk > 0 && i - pk < 250 && c[pk] < hi250[i]) pk--;
    let worst = 0; for (let k = Math.max(1, i - 9); k <= i; k++) worst = Math.min(worst, c[k] / c[k - 1] - 1);
    const rs = []; for (let k = Math.max(1, i - 19); k <= i; k++) rs.push(Math.log(c[k] / c[k - 1]));
    const m = mean(rs), vol = Math.sqrt(mean(rs.map(x => (x - m) ** 2)) * 252) * 100;
    return { dd: r2((c[i] / hi250[i] - 1) * 100), days: i - pk, worst1d: r2(worst * 100), vol20: r2(vol) };
}
/** 第 i 天收盤之後:h 天報酬(含息有就用含息)、之後 250 天內最低收盤還再跌幾 %、幾天到 */
export function postPath(S, i, hs = HS) {
    const A = S.tr && S.tr[i] != null ? S.tr : S.c, out = { src: A === S.c ? '價格' : '含息' };
    for (const h of hs) out[h] = i + h < A.length && A[i + h] != null ? r2((A[i + h] / A[i] - 1) * 100) : null;
    let mn = S.c[i], mi = i; for (let k = i + 1; k < Math.min(S.c.length, i + 251); k++) if (S.c[k] < mn) { mn = S.c[k]; mi = k; }
    out.more = r2((mn / S.c[i] - 1) * 100); out.toLow = mi - i; out.lowDate = S.d[mi];
    return out;
}

export function run(S, us, log = console.log) {
    const hi = rollMax(S.c, 250), CL = corrLegs(S.c), nx = usToTw(S.d);
    const vixAt = {}; if (us && us.syms && us.syms['^VIX']) { const vc = us.syms['^VIX'].c; us.days.forEach((d, k) => { const t = nx(d); if (t >= 0) vixAt[t] = vc[k]; }); }
    const vixOn = i => { for (let k = i; k >= Math.max(0, i - 3); k--) if (vixAt[k] != null) return r2(vixAt[k]); return null; };
    const rows = [];
    for (const d of NSF) {
        const i = S.d.findIndex(x => x >= d); if (i < 0) continue;
        const pre = preState(S, i, hi), post = postPath(S, i);
        const alt = [-2, -1, 1, 2].map(k => i + k).filter(k => k > 0 && k < S.c.length).map(k => postPath(S, k)[60]);
        rows.push({ d, td: S.d[i], close: Math.round(S.c[i]), ...pre, vix: vixOn(i), post, alt60: alt });
    }
    log('國安基金 9 次(進場那天收盤):');
    log('日期        收盤   距一年高   離高點幾天  前10天最大單日  20天波動  VIX  |  5天   20天   60天  120天  250天 | 之後還再跌  幾天到底(那天)  | 60天 ±2天');
    for (const r of rows) log(`${r.td} ${String(r.close).padStart(6)} ${String(r.dd).padStart(7)}% ${String(r.days).padStart(6)} ${String(r.worst1d).padStart(10)}% ${String(r.vol20).padStart(8)}% ${String(r.vix ?? '—').padStart(5)} | `
        + HS.map(h => String(r.post[h] ?? '—').padStart(6)).join('') + ` | ${String(r.post.more).padStart(7)}% ${String(r.post.toLow).padStart(5)}(${r.post.lowDate}) ${r.post.src} | ${r.alt60.join(' / ')}`);
    // 對照:隨便一天、修正段隨便一天
    const base = (pool, h) => { const v = pool.map(i => postPath(S, i, [h])[h]).filter(x => x != null); return { n: v.length, m: r2(mean(v)), md: r2(med(v)), up: r2(v.filter(x => x > 0).length / v.length * 100) }; };
    const all = [], corr = []; for (let i = 0; i < S.c.length; i++) { all.push(i); if (CL.corr[i] >= 0) corr.push(i); }
    const sum = {};
    for (const h of HS) { const v = rows.map(r => r.post[h]).filter(x => x != null);
        sum[h] = { n: v.length, m: r2(mean(v)), md: r2(med(v)), up: r2(v.filter(x => x > 0).length / v.length * 100), all: base(all.filter((_, k) => k % 2 === 0), h), corr: base(corr, h) };
        log(`  ${String(h).padStart(3)} 天:國安基金 ${sum[h].m}%(中位 ${sum[h].md}、漲 ${sum[h].up}%、n=${sum[h].n})・隨便一天 ${sum[h].all.m}%(漲 ${sum[h].all.up}%)・修正段隨便一天 ${sum[h].corr.m}%(漲 ${sum[h].corr.up}%)`); }
    // 進場前條件:最淺的一次跌多少 → 一樣深但沒進場的修正段
    const minDD = Math.max(...rows.map(r => r.dd));               // dd 是負的,最淺 = 最大
    const nsfLegs = new Set(rows.map(r => CL.corr[S.d.indexOf(r.td)]));
    const same = [];
    CL.legs.forEach((L, k) => { if (nsfLegs.has(k)) return; let first = -1; for (let i = L.s; i <= L.e; i++) if ((S.c[i] / hi[i] - 1) * 100 <= minDD) { first = i; break; } if (first < 0) return;
        same.push({ leg: S.d[L.peakI], first: S.d[first], dd: r2((S.c[first] / hi[first] - 1) * 100), depth: r2(L.depth), post: postPath(S, first), open: !!L.open }); });
    log(`\n國安基金進場時最淺的一次:距一年高 ${minDD}% → 一樣深、但國安基金沒進場的修正段 ${same.length} 段:`);
    for (const s of same) log(`  ${s.leg} 高點那段:第一次到 ${s.dd}% = ${s.first} ・整段最深 ${s.depth}%${s.open ? '(還沒走完)' : ''} ・之後 20 天 ${s.post[20]}% / 60 天 ${s.post[60]}% / 250 天 ${s.post[250]}% ・之後還再跌 ${s.post.more}%`);
    const depths = rows.map(r => r.dd).sort((a, b) => a - b);
    log(`\n進場時距一年高:${depths.join(' / ')}%(中位 ${r2(med(depths))}%)・離高點中位 ${med(rows.map(r => r.days))} 個交易日 ・前 10 天最大單日跌幅中位 ${r2(med(rows.map(r => r.worst1d)))}%`);
    return { rows, sum, minDD, same };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 700, d = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2010, 0, 4 + i)).toISOString().slice(0, 10));
    const c = d.map((_, i) => i < 300 ? 100 : i < 320 ? 100 * (1 - 0.3 * (i - 300) / 20) : 70 * (1 + 0.002 * (i - 320)));
    const S = { d, c, tr: c.slice() }, hi = rollMax(c, 250);
    const p = preState(S, 315, hi);
    t(Math.abs(p.dd + 22.5) < 0.01 && p.days === 15, `① 進場前:距一年高 ${p.dd}%、離高點 ${p.days} 天`);
    const q = postPath(S, 315, [5]);
    t(q.more < 0 && q.toLow === 5 && q[5] != null, `② 進場後:之後還再跌 ${q.more}%、${q.toLow} 天到底`);
    // ⛔ 前視:preState 只看 ≤ i(改掉未來不變)
    const c2 = c.slice(); for (let i = 316; i < n; i++) c2[i] = 1;
    const p2 = preState({ d, c: c2 }, 315, rollMax(c2, 250));
    t(JSON.stringify(p) === JSON.stringify(p2), '③ 改掉未來的價格,進場前狀態一模一樣');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('nsf_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(), us = rd(process.env.US_HIST);
    const out = run(S, us);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
