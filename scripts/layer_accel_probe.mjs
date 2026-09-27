#!/usr/bin/env node
/**
 * 🏭 「供應鏈哪一層的營收正在加速?」有沒有用 —— V77.7.0(評估紀錄㊱:外部 AI 的「AI 供應鏈 12 層 + 瓶頸引擎」)
 *
 * ⭐ 外部建議裡**唯一做得出來又沒測過**的一塊:產能 / 稼動率 / 報價 / 交期 沒有免費結構化資料(LAB blocked),
 *    「層的位置」已實測沒用(ailevel_probe)、領先落後已實測不成立(leadlag_probe);
 *    但「這一層的公司營收 YoY 正在加速」= 本站唯一六關全過的基本面(accel_probe),而且**每一季都有**。
 *    → 把它從「個股」拉到「層 / 題材」:每個月初,看每一層成員裡有幾成「營收 YoY 加速」,挑最高的 3 層。
 *
 * 對照組 = 同一天**所有層**成員的平均(⛔ 不拿全市場 —— 否則量到的是「AI 題材」本身)。
 * 另外兩條參考:① 20 日動能前 3 層(sector_rotation_probe 在官方產業上 +1.44pp)② 加速 ∧ 動能。
 * 安慰劑:同一天隨機挑 3 層(sham),必須 ≈ 0。
 *
 * 方法:月初第一個交易日 t 決定 → t+1 開盤買、抱 20 個交易日、扣同期加權(成員等權);
 *   「知道營收」一律用法定公布截止日(lib_finaccel.finKnownAt,⛔ 不拿季別當可用日 = 前視);
 *   成員數 < 3 或已知財報的成員 < 2 的層那個月不算。六關:全期 / 前後半 / 逐年 / 去最好年 / 扣成本 0.44 / p ≤ 0.05。
 * ⚠️ 限制:層的成員是 **2026 年手選的**(後見之明,但兩臂同一份名單 → 比的是層與層之間);每層只有 3~7 檔;
 *   營收是**季**資料(月營收沒有歷史);月初換一次 → 樣本 ~50 個月 × 21 層。
 *
 * 用法:DATA_DIR=<合併 klines_deep> FIN_DEEP=<fin_deep.json> node scripts/layer_accel_probe.mjs [out.json]
 *       node scripts/layer_accel_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { finSeries, finOnAt } from './lib_finaccel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const FIN = process.env.FIN_DEEP || '';
const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';
const COST = 0.44, H = 20, TOPN = 3;
const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const erf = x => { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const pTwo = z => 1 - erf(Math.abs(z) / Math.SQRT2);
let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

export function parseThemes(src) {
    const a = src.indexOf('  THEMES: ['), b = src.indexOf('\n  ],', a);
    const out = [];
    for (const m of src.slice(a, b).matchAll(/\{ k: '([^']+)', n: '([^']+)', syms: \[([^\]]*)\] \}/g))
        out.push({ k: m[1], n: m[2], syms: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]) });
    return out;
}

// 每一個「換倉日」→ 每一層:{acc: 加速比例, mom: 20 日動能, fwd: 之後 20 日超額(成員等權)}
export function buildPanel(themes, px, TW, finOf, days) {
    const panel = [];
    let lastM = '';
    for (let i = 21; i < days.length - H - 1; i++) {
        const d = days[i]; if (d.slice(0, 7) === lastM) continue; lastM = d.slice(0, 7);
        const tw0 = TW.get(days[i + 1]) && TW.get(days[i + 1]).o, tw1 = TW.get(days[i + 1 + H]) && TW.get(days[i + 1 + H]).c;
        if (!(tw0 > 0 && tw1 > 0)) continue;
        const row = { d, th: [] };
        for (const T of themes) {
            let nK = 0, nOn = 0, mom = [], fwd = [];
            for (const s of T.syms) {
                const P = px.get(s); if (!P) continue;
                const a = P.get(d), a20 = P.get(days[i - 20]), e = P.get(days[i + 1]), x = P.get(days[i + 1 + H]);
                if (a && a20 && a.c > 0 && a20.c > 0) mom.push(a.c / a20.c - 1);
                if (a && e && x && e.o > 0 && x.c > 0 && e.o < a.c * 1.095) fwd.push((x.c / e.o - 1) * 100 - (tw1 / tw0 - 1) * 100);
                const on = finOf(s, d);
                if (on !== null) { nK++; if (on) nOn++; }
            }
            if (fwd.length < 3 || nK < 2) continue;
            row.th.push({ k: T.k, acc: nOn / nK, mom: mom.length ? mom.reduce((x, y) => x + y, 0) / mom.length : 0, fwd: fwd.reduce((x, y) => x + y, 0) / fwd.length });
        }
        if (row.th.length >= 8) panel.push(row);
    }
    return panel;
}

export function evaluate(panel, pick) {
    const diffs = [];
    for (const row of panel) {
        const all = row.th.reduce((a, x) => a + x.fwd, 0) / row.th.length;
        const sel = pick(row.th); if (!sel.length) continue;
        diffs.push({ d: row.d, v: sel.reduce((a, x) => a + x.fwd, 0) / sel.length - all });
    }
    const n = diffs.length, m = n ? diffs.reduce((a, x) => a + x.v, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(diffs.reduce((a, x) => a + (x.v - m) ** 2, 0) / (n - 1)) : 0;
    const z = sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
    const half = Math.floor(n / 2), avg = a => a.length ? a.reduce((s, x) => s + x.v, 0) / a.length : 0;
    const byY = {}; for (const x of diffs) (byY[x.d.slice(0, 4)] ||= []).push(x);
    const YR = Object.entries(byY).map(([y, a]) => ({ y, n: a.length, d: avg(a) })).filter(x => x.n >= 4);
    const best = YR.reduce((b, x) => (!b || x.d > b.d) ? x : b, null);
    const rest = YR.filter(x => x !== best), dropBest = rest.length ? rest.reduce((s, x) => s + x.d * x.n, 0) / rest.reduce((s, x) => s + x.n, 0) : 0;
    const pass = { '①全期': m > 0, '②前後半': avg(diffs.slice(0, half)) > 0 && avg(diffs.slice(half)) > 0, '③逐年': YR.length >= 3 && YR.every(x => x.d > 0), '④去最好年': dropBest > 0, '⑤扣成本': m - COST > 0, '⑥檢定': pTwo(z) <= 0.05 };
    return { n, m, p: pTwo(z), YR, half: [avg(diffs.slice(0, half)), avg(diffs.slice(half))], dropBest, pass, nPass: Object.values(pass).filter(Boolean).length };
}

const topBy = (key, n = TOPN) => th => th.slice().sort((a, b) => b[key] - a[key] || (rnd() - 0.5)).slice(0, n);
const PICKS = {
    '營收加速比例最高 3 層': topBy('acc'),
    '20 日動能最高 3 層(參考:官方產業 +1.44pp)': topBy('mom'),
    '加速 ∧ 動能(兩個都在前一半)': th => { const ma = th.slice().sort((a, b) => b.acc - a.acc).slice(0, Math.ceil(th.length / 2)), mm = new Set(th.slice().sort((a, b) => b.mom - a.mom).slice(0, Math.ceil(th.length / 2)).map(x => x.k)); return ma.filter(x => mm.has(x.k)); },
    '營收加速比例最低 3 層(反向)': th => th.slice().sort((a, b) => a.acc - b.acc || (rnd() - 0.5)).slice(0, TOPN),
    '🎲 安慰劑:隨機 3 層': th => th.slice().sort(() => rnd() - 0.5).slice(0, TOPN),
};

function selftest() {
    let bad = 0; const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    const T = parseThemes(fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8'));
    ck(T.length >= 20 && T.every(t => t.syms.length >= 3), `① 從 pro.html 讀到 ${T.length} 層(⛔ 不複製名單)`);
    // 合成:10 層 × 4 檔,每月只有 A 層「加速」;A 層成員之後 20 天每天 +0.15%
    const days = []; let dd = new Date(Date.UTC(2021, 0, 4));
    while (days.length < 900) { if (dd.getUTCDay() % 6) days.push(dd.toISOString().slice(0, 10)); dd = new Date(dd.getTime() + 864e5); }
    const TW = new Map(days.map(d => [d, { o: 100, c: 100 }]));
    const themes = Array.from({ length: 10 }, (_, j) => ({ k: 'L' + j, syms: [0, 1, 2, 3].map(q => `${j}${q}`) }));
    const px = new Map();
    for (const t of themes) for (const s of t.syms) {
        const m = new Map(); let p = 50;
        for (const d of days) { p *= 1 + (rnd() - 0.5) * 0.02 + (t.k === 'L0' ? 0.0015 : 0); m.set(d, { o: p, c: p }); }
        px.set(s, m);
    }
    const finOf = (s, d) => s.startsWith('0');
    const panel = buildPanel(themes, px, TW, finOf, days);
    const r = evaluate(panel, PICKS['營收加速比例最高 3 層']), sh = evaluate(panel, PICKS['🎲 安慰劑:隨機 3 層']);
    ck(r.m > 0.5, `② 注入「加速那層之後會漲」→ 量得到(+${r.m.toFixed(2)}pp)`);
    ck(Math.abs(sh.m) < 0.6, `③ 安慰劑 ≈ 0(${sh.m.toFixed(2)}pp)`);
    const lk = buildPanel(themes, px, TW, (s, d) => null, days);
    ck(lk.length === 0, '④ 財報一季都還沒公布 → 那個月不算(⛔ 不當成沒加速)');
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過'); process.exit(bad ? 1 : 0);
}
if (process.argv.includes('--selftest')) selftest();

const themes = parseThemes(fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8'));
const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => ({ d: nd(r.date), o: +r.open || +r.close, c: +r.close })).filter(r => r.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
const TW = new Map(tw.map(r => [r.d, r])), days = tw.map(r => r.d).filter(d => d >= '2022-01-01');
const px = new Map();
for (const t of themes) for (const s of t.syms) {
    if (px.has(s)) continue;
    try { const rows = JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf8')); px.set(s, new Map(rows.map(r => [nd(r.date), { o: +r.open, c: +r.close }]))); } catch (_) {}
}
if (!FIN) { console.log('❌ 要 FIN_DEEP=<fin_deep.json>'); process.exit(1); }
const FD = JSON.parse(fs.readFileSync(FIN, 'utf8'));
const serOf = new Map(); const finOf = (s, d) => { if (!serOf.has(s)) serOf.set(s, finSeries(FD, s)); return finOnAt(serOf.get(s), d); };
const panel = buildPanel(themes, px, TW, finOf, days);
console.log(`🏭 ${themes.length} 層 ・成員 ${px.size} 檔有 K 線 ・換倉 ${panel.length} 個月(${panel[0]?.d} ~ ${panel[panel.length - 1]?.d})・每月平均 ${(panel.reduce((a, r) => a + r.th.length, 0) / panel.length).toFixed(1)} 層可算`);
console.log(`   買法:月初決定 → 隔天開盤買、抱 ${H} 天、扣同期加權;對照組 = 同一天所有層的平均\n`);
const rep = { window: [panel[0]?.d, panel[panel.length - 1]?.d], months: panel.length, rows: {} };
for (const [name, pick] of Object.entries(PICKS)) {
    const r = evaluate(panel, pick);
    console.log(`  ${name.padEnd(30)} n=${String(r.n).padStart(3)} 平均多 ${(r.m >= 0 ? '+' : '') + r.m.toFixed(2)}pp p=${r.p.toFixed(3)} 前/後半 ${r.half.map(x => x.toFixed(2)).join('/')} 逐年 ${r.YR.map(x => `${x.y}:${x.d.toFixed(2)}`).join(' ')}  ${r.nPass === 6 ? '✅ 六關全過' : r.nPass + '/6'}`);
    rep.rows[name] = r;
}
console.log('\n⚠️ 成員是 2026 年手選的名單(後見之明);每層只有 3~7 檔;營收是季資料。⛔ 探針不是測試(exit 0)。');
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rep, null, 1)); console.log(`💾 ${OUT}`); }
