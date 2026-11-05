#!/usr/bin/env node
// 🌏 V81.0.3 crash_global_probe.py(Python)跟 JS 原版逐筆一樣 —— 同一份收盤丟兩邊,⛔ 第二份定義偷偷長歪
//
// 比的東西(全部是 JS 原本那幾支,⛔ 測試裡重寫):
//   ① 修正段 lib_crash.corrLegs:每一段 s / e / peak / peakI / low / lowI / open / depth
//   ② 急跌 crash_cycle_probe.fastEvents(三種門檻)+ lib_crash.firstPerLeg
//   ③ 事件 vs 修正段隨便一天 lib_crash.evVsCorr 的平均 / 漲的比例 / 前後半 / 離底 / 再跌(⛔ 比 p 值:兩邊亂數不同)
//   ④ 每一次見底的數字:250 天內最低(= crash_cycle_probe 每次那一行的寫法)、離底反彈 10%、回到前高 → 這裡用最笨的方法另算一次
// 資料:合成走勢(固定種子,埋好幾段急跌)× 4 + 台股官方那份(本機有 data/idx_long*.json 才跑,沒有就印出來 ⛔ 假裝有比)
// 注入:INJECT=w → Python 用前 W−1 天(少一天)當高點 → ② 必紅
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { fastEvents } from './crash_cycle_probe.mjs';
import { corrLegs, firstPerLeg, evVsCorr, after, loadIndex } from './lib_crash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let PY = path.join(ROOT, 'scripts', 'crash_global_probe.py');
if (process.env.INJECT === 'w') {
    const src = fs.readFileSync(PY, 'utf8');
    const bad = src.replace('mx = max(c[i - W:i])', 'mx = max(c[i - W + 1:i])');
    if (bad === src) { console.log('❌ 注入失敗:找不到那一行'); process.exit(1); }
    PY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-')), 'crash_global_probe.py');
    fs.writeFileSync(PY, bad);
    console.log('💉 INJECT=w:Python 少看一天高點');
}
let fails = 0, checks = 0;
const ok = (n, c, e = '') => { checks++; if (!c) { fails++; console.log(`❌ ${n}  ${String(e).slice(0, 300)}`); } };
const near = (a, b, tol = 1e-9) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)));
const near2 = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 0.0100001);   // JS 回的是 toFixed(2)
const FAST = [[15, 25], [10, 10], [20, 40]], HS = [5, 20, 60, 120, 250];

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function synth(seed, n = 6000) {
    const R = rng(seed), c = [1000], d = [];
    let t = Date.UTC(1995, 0, 2);
    const nextDay = () => { do { t += 864e5; } while ([0, 6].includes(new Date(t).getUTCDay())); return new Date(t).toISOString().slice(0, 10); };
    d.push(new Date(t).toISOString().slice(0, 10));
    let crash = 0;
    for (let i = 1; i < n; i++) {
        if (!crash && R() < 0.004) crash = 10 + Math.floor(R() * 25);
        const g = (R() + R() + R() - 1.5) * 0.02;
        const drift = crash ? -0.012 - R() * 0.01 : 0.0004;
        if (crash) crash--;
        c.push(+(c[i - 1] * (1 + drift + g)).toFixed(2));
        d.push(nextDay());
    }
    return { d, c };
}

function jsSide(d, c) {
    const S = { d, c }, CL = corrLegs(c), out = { legs: CL.legs, fast: {} };
    for (const [X, W] of FAST) {
        const raw = fastEvents(c, X, W), ev = firstPerLeg(raw, CL.corr);
        const vs = evVsCorr(S, c, CL, ev, HS, 7, 50);
        // ④ 最笨的寫法另算一次(⛔ 抄 Python)
        const ep = ev.map(i => {
            let mn = c[i], mi = i; for (let k = i + 1; k < Math.min(c.length, i + 251); k++) if (c[k] < mn) { mn = c[k]; mi = k; }   // = crash_cycle_probe 那一行
            let reb10 = null; for (let k = mi + 1; k < c.length; k++) if (c[k] >= mn * 1.10) { reb10 = k - i; break; }
            const L = CL.legs[CL.corr[i]];
            let back = null; if (L) for (let k = i + 1; k < c.length; k++) if (c[k] >= L.peak) { back = k - i; break; }
            const end = (!L || L.open) ? c.length - 1 : L.e;
            let lmn = c[i], lmi = i; for (let k = i + 1; k <= end; k++) if (c[k] < lmn) { lmn = c[k]; lmi = k; }
            return { low250: (mn / c[i] - 1) * 100, dLow: mi - i, reb10, back, legLow: (lmn / c[i] - 1) * 100, dLegLow: lmi - i };
        });
        out.fast[X + '/' + W] = { raw, ev, ep, vs };
    }
    return out;
}

function compare(tag, d, c) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-')), 'c.json');
    fs.writeFileSync(tmp, JSON.stringify(d.map((x, i) => [x, c[i]])));
    const py = JSON.parse(execFileSync('python3', ['-I', PY, '--events', tmp], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    const js = jsSide(d, c);
    // ① 修正段
    ok(`${tag} ① 修正段段數一樣(${js.legs.length})`, py.legs.length === js.legs.length, `${py.legs.length} vs ${js.legs.length}`);
    js.legs.forEach((L, k) => {
        const P = py.legs[k] || {};
        ok(`${tag} ① 第 ${k} 段`, P.s === L.s && P.e === L.e && P.peakI === L.peakI && P.lowI === L.lowI && P.open === L.open
            && near(P.peak, L.peak) && near(P.low, L.low) && near(P.depth, L.depth), JSON.stringify([P, L]));
    });
    let nEv = 0;
    for (const [X, W] of FAST) {
        const k = X + '/' + W, J = js.fast[k], P = py.fast[k];
        ok(`${tag} ② 急跌 ${k} 每一天`, JSON.stringify(P.raw) === JSON.stringify(J.raw), `${P.raw.length} vs ${J.raw.length}`);
        ok(`${tag} ② 急跌 ${k} 每段第一次`, JSON.stringify(P.ev) === JSON.stringify(J.ev), `${P.ev} vs ${J.ev}`);
        nEv += J.ev.length;
        for (const h of HS) {
            const a = P.vs[String(h)] || {}, b = J.vs.h[h] || {};
            if (b.ev == null) { ok(`${tag} ③ ${k} ${h} 天兩邊都算不出來`, a.ev == null, JSON.stringify(a)); continue; }
            ok(`${tag} ③ ${k} ${h} 天 平均 / 對照 / 差 / 漲的比例 / 前後半 / 年`,
                near2(a.ev, b.ev) && near2(a.base, b.base) && near2(a.diff, b.diff) && near2(a.up, b.up) && near2(a.upBase, b.upBase)
                && near2(a.h1, b.h1) && near2(a.h2, b.h2) && a.yrsWin === b.yrsWin && a.yrsN === b.yrsN && a.n === b.n,
                JSON.stringify([a, b]));
        }
        ok(`${tag} ③ ${k} 離底 / 再跌 / 中位`, near2(P.near, J.vs.near) && near2(P.nearBase, J.vs.nearBase) && near2(P.deeper, J.vs.deeper)
            && near2(P.deeperBase, J.vs.deeperBase) && near2(P.more, J.vs.more) && near2(P.moreBase, J.vs.moreBase),
            JSON.stringify([P.near, J.vs.near, P.deeper, J.vs.deeper, P.more, J.vs.more]));
        J.ep.forEach((e, m) => {
            const p = P.ep[m] || {};
            ok(`${tag} ④ ${k} 第 ${m} 次見底數字`, p.dLow === e.dLow && p.reb10 === e.reb10 && p.back === e.back && p.dLegLow === e.dLegLow
                && near(p.low250, e.low250) && near(p.legLow, e.legLow), JSON.stringify([p, e]));
        });
    }
    console.log(`  ${tag}:${c.length} 天 ・修正段 ${js.legs.length} ・急跌事件 ${nEv}`);
    return nEv;
}

let total = 0;
for (const seed of [1, 7, 42, 2026]) { const s = synth(seed); total += compare(`合成#${seed}`, s.d, s.c); }
ok('⓪ 空過守門:合成資料真的有急跌可以比(≥20 次)', total >= 20, total);

const LONG = process.env.IDX_LONG || path.join(ROOT, 'data', 'idx_long.json');
const EARLY = process.env.IDX_EARLY || path.join(ROOT, 'data', 'idx_long_early.json');
const NOW = process.env.TWII_NOW || path.join(ROOT, 'data', '^TWII.json');
if (fs.existsSync(LONG)) {
    const S = loadIndex({ IDX_LONG: LONG, IDX_EARLY: fs.existsSync(EARLY) ? EARLY : '', TWII_NOW: fs.existsSync(NOW) ? NOW : '' });
    const n = compare('台股官方', S.d, S.c);
    ok('⓪ 台股官方那份有急跌可以比', n >= 5, n);
} else console.log(`ℹ️ 本機沒有 ${LONG} → 台股官方那份這次沒比(合成資料照比)`);

console.log(fails ? `\n❌ test_crash_global ${fails}/${checks} 條沒過` : `\n✅ test_crash_global 全部通過(${checks} 條)`);
process.exit(fails ? 1 : 0);
