#!/usr/bin/env node
// ⚡ intraday_six_probe —— 即時頁「盤中六脈」共振出現之後,照卡片說的做,賺不賺得到(V79.0.3)
//
// ⭐ 判定函式**直接從 index.html 抽出來跑**(`_intradaySixCalc` + `_rsiSeries`),⛔ 不複製第二份。
// ⚠️ App 用的是 Fugle 1 分 K;這裡只有 kbar5(5 分 K,每月初成交值前 100)→ 「3 根多數決」= 15 分鐘,
//    比 App 慢 → 是**近似**,結論只能說「5 分 K 版本」。
// 規則(照卡片文案):
//   🔴 多方共振出現(reso 由非 1 變 1)→ 下一根開盤做多;共振熄滅(reso ≠ 1)→ 再下一根開盤出;沒熄滅就收盤出。
//   🟢 空方共振 → 鏡像做空。另跑「抱到收盤」版本。13:00 以後出現的不進場。
// 對照:同一天、同一個進場根與出場根,所有其他股票的平均(⛔ 不拿 0 比 —— 盤中本來就有時段漂移)。
// 成本:當沖來回 0.25%。
//
// 用法:KBAR5_DIR=<kbar5_deep>:<kbar5> node scripts/intraday_six_probe.mjs [out.json]
//       node scripts/intraday_six_probe.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKbar5 } from './dt_kbar5_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COST = 0.25, LAST_ENTRY = 13 * 60;

function methodSrc(html, name) {
    const a = html.indexOf(`\n    ${name}(`);
    if (a < 0) throw new Error(`index.html 找不到 ${name}`);
    const b = html.indexOf('\n    },\n', a);
    const src = html.slice(a + 1, b + 6).trim().replace(/,$/, '');
    const head = src.indexOf('{');
    const args = src.slice(src.indexOf('(') + 1, src.indexOf(')'));
    return { args, body: src.slice(head + 1, src.lastIndexOf('}')) };
}
export function loadCalc(html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) {
    const rs = methodSrc(html, '_rsiSeries'), sx = methodSrc(html, '_intradaySixCalc');
    const ctx = {};
    ctx._rsiSeries = new Function(...rs.args.split(',').map(s => s.trim()), rs.body).bind(ctx);
    ctx._intradaySixCalc = new Function(...sx.args.split(',').map(s => s.trim()), sx.body).bind(ctx);
    return (bars, q) => ctx._intradaySixCalc(bars, q);
}

// kbar5 一根 = [hm, o, h, l, c, v](hm = 絕對分鐘,540 = 09:00)→ App 的 1 分 K 形狀(close / average / t)
export function toBars(k) {
    let pv = 0, vv = 0;
    return k.map(b => {
        const [hm, , h, l, c, v] = b.map(Number);
        const w = Math.max(+v || 0, 0);
        pv += (h + l + c) / 3 * w; vv += w;
        const hh = String(Math.floor(hm / 60)).padStart(2, '0'), mm = String(hm % 60).padStart(2, '0');
        return { t: `2000-01-01T${hh}:${mm}:00`, close: c, average: vv > 0 ? pv / vv : null, hm };
    });
}

export function trades(calc, k, prevClose) {
    const bars = toBars(k);
    const v = calc(bars, { prevClose });
    if (!v) return [];
    const out = [], R = v.reso, n = bars.length;
    for (let i = 1; i < n - 1; i++) {
        const dir = R[i];
        if (!dir || R[i - 1] === dir || bars[i].hm >= LAST_ENTRY) continue;
        const ei = i + 1, entry = +k[ei][1];
        let xj = n - 1, xp = +k[n - 1][4];
        for (let j = ei; j < n; j++) if (R[j] !== dir) { if (j + 1 < n) { xj = j + 1; xp = +k[j + 1][1]; } break; }
        const close = +k[n - 1][4];
        if (!(entry > 0)) continue;
        out.push({ dir, ei, xj, hm: bars[i].hm, rExit: (xp / entry - 1) * 100 * dir, rClose: (close / entry - 1) * 100 * dir });
    }
    return out;
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const tstat = a => { if (a.length < 3) return null; const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null; };

export function run(K, calc, { keep = false } = {}) {
    const dates = Object.keys(K.days).sort();
    const rows = [];
    for (let di = 1; di < dates.length; di++) {
        const d = dates[di], day = K.days[d], prev = K.days[dates[di - 1]];
        if (!day || !day.k) continue;
        const syms = Object.keys(day.k);
        for (const sym of syms) {
            const k = day.k[sym], pk = prev && prev.k && prev.k[sym];
            if (!k || k.length < 40 || !pk || !pk.length) continue;
            const pc = +pk[pk.length - 1][4];
            for (const tr of trades(calc, k, pc)) {
                // 對照:同一天同一個進場根 / 出場根,其他股票做多的平均
                const peers = [];
                for (const s2 of syms) {
                    if (s2 === sym) continue; const k2 = day.k[s2];
                    if (!k2 || k2.length <= Math.max(tr.ei, tr.xj)) continue;
                    const e2 = +k2[tr.ei][1], x2 = tr.xj === k2.length - 1 && tr.xj === k.length - 1 ? +k2[tr.xj][4] : +k2[tr.xj][1], c2 = +k2[k2.length - 1][4];
                    if (e2 > 0 && x2 > 0 && c2 > 0) peers.push([(x2 / e2 - 1) * 100, (c2 / e2 - 1) * 100]);
                }
                if (peers.length < 10) continue;
                rows.push({ d, sym, dir: tr.dir, hm: tr.hm, rExit: tr.rExit, rClose: tr.rClose,
                    cExit: mean(peers.map(p => p[0])) * tr.dir, cClose: mean(peers.map(p => p[1])) * tr.dir });
            }
        }
    }
    const pack = (rs, f, c) => {
        const net = rs.map(r => r[f] - COST), ex = rs.map(r => r[f] - r[c]), years = {};
        rs.forEach((r, i) => (years[r.d.slice(0, 4)] ||= []).push(net[i]));
        const h = Math.floor(rs.length / 2);
        return { n: rs.length, net: mean(net), win: mean(rs.map(r => r[f] > 0 ? 1 : 0)) * 100, ex: mean(ex), t: tstat(ex),
            half: [mean(ex.slice(0, h)), mean(ex.slice(h))],
            byYear: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, +mean(a).toFixed(3)])) };
    };
    const L = rows.filter(r => r.dir === 1), S = rows.filter(r => r.dir === -1);
    return {
        ...(keep ? { rows } : {}),
        from: rows[0] && rows[0].d, to: rows.length && rows[rows.length - 1].d, nDays: dates.length,
        longExit: pack(L, 'rExit', 'cExit'), longClose: pack(L, 'rClose', 'cClose'),
        shortExit: pack(S, 'rExit', 'cExit'), shortClose: pack(S, 'rClose', 'cClose'),
    };
}

// ── selftest ─────────────────────────────────────────────────────────
function synthDay(seed, drift, bump = null) {
    let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const k = []; let px = 100;
    for (let i = 0; i < 54; i++) {
        const hm = 540 + i * 5, o = px;
        let c = o * (1 + (rnd() - 0.5) * 0.004 + drift(i));
        if (bump) c = bump(i, o, c, k);
        k.push([hm, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, 100 + rnd() * 50]); px = c;
    }
    return k;
}
function selftest() {
    let ok = 0, bad = 0; const T = (nm, c) => { console.log(`${c ? '✅' : '❌'} ${nm}`); c ? ok++ : bad++; };
    const calc = loadCalc();
    // ① 抽出來的函式能跑,而且一路上漲會出現多方共振
    const up = synthDay(5, i => 0.002);
    const v = calc(toBars(up), { prevClose: 99 });
    T('① 從 index.html 抽出的 _intradaySixCalc 能跑、上漲日有多方共振', v && v.reso.includes(1));
    // ② 不看未來:改掉第 30 根以後,第 0~29 根的共振不變
    const up2 = up.map(b => b.slice()); for (let i = 30; i < up2.length; i++) up2[i][4] *= 0.9;
    const v2 = calc(toBars(up2), { prevClose: 99 });
    T('② 共振只用到當下以前(改未來,前面不變)', JSON.stringify(v.reso.slice(0, 30)) === JSON.stringify(v2.reso.slice(0, 30)));
    // ③ 埋邊際:多方共振出現後真的再漲 → 比對照 > 0
    const mk = (n, seed0, drift) => { const D = {}; for (let d = 0; d < n; d++) { const k = {}; for (let s = 0; s < 15; s++) k[1000 + s] = synthDay(seed0 + d * 31 + s, i => 0); k[9999] = synthDay(seed0 + d, drift); D[`2024-01-${String(d + 1).padStart(2, '0')}`] = { k }; } return { days: D }; };
    const r3 = run(mk(20, 7, i => 0.003), calc, { keep: true }).rows.filter(r => r.sym === '9999' && r.dir === 1);
    const ex3 = mean(r3.map(r => r.rClose - r.cClose));
    T('③ 埋「共振後續漲」:那一檔做多比對照 > 0.3pp', r3.length >= 10 && ex3 > 0.3);
    const r4 = run(mk(20, 7, i => 0), calc);
    T('④ 全部隨機:做多比對照 |ex| < 0.3', r4.longClose.n === 0 || Math.abs(r4.longClose.ex) < 0.3);
    console.log(`\nselftest ${ok}/${ok + bad}`);
    process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else {
    const spec = process.env.KBAR5_DIR; if (!spec) { console.error('❌ 要 KBAR5_DIR'); process.exit(1); }
    const K = loadKbar5(spec);
    const nd = Object.keys(K.days).length;
    if (nd < 100) { console.error(`❌ 只讀到 ${nd} 天`); process.exit(1); }
    const res = run(K, loadCalc());
    const f = (x, k = 3) => x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(k);
    console.log(`5 分 K ${nd} 天 ${res.from} ~ ${res.to}`);
    for (const [k, nm] of [['longExit', '多方共振→做多・熄滅就出'], ['longClose', '多方共振→做多・抱到收盤'], ['shortExit', '空方共振→做空・熄滅就補'], ['shortClose', '空方共振→做空・抱到收盤']]) {
        const s = res[k];
        console.log(`${nm.padEnd(22)} n=${String(s.n).padStart(6)} 扣成本每趟 ${f(s.net)}% 勝率 ${s.win == null ? '—' : s.win.toFixed(1)}% 比同時點其他股 ${f(s.ex)}pp t=${f(s.t, 1)} 前後半 ${f(s.half[0])}/${f(s.half[1])} 逐年 ${JSON.stringify(s.byYear)}`);
    }
    const out = process.argv[2]; if (out && !out.startsWith('--')) fs.writeFileSync(out, JSON.stringify(res, null, 1));
}
