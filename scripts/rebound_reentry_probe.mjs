#!/usr/bin/env node
/**
 * 🧭 V80.1.1 反攻雷達(App 那 12 條)回測 —— 研究用,⛔ 不改 App
 *
 * 使用者 2026-10-31:「最近大盤很差,我 App 有反攻條件,這樣是等反攻再買嗎?」
 *   → 雷達從來沒回測過(V79.9.8 才改成只描述)。逐日歷史由 scripts/rebound_hist_build.py 重建
 *     (2010-01 起;D 那天只用 D 之前看得到的:台股 / 期貨 / 融資 = 前一交易日,美股 / 匯率 / 油 / 日圓 = 美國日期 < D)。
 *
 * 一、怎麼用(報酬指數,ETF 成本 = ftd_probe;2010-01-05 起,所有做法同一段):
 *    買了放著 vs 收盤比進場後最高跌 10% 出場 →
 *      ① 雷達成形回來 ② 站回 60 日線回來 ③ 追盤日回來 ④ 隨機等(天數抽自 ① 實際等了幾天,200 種亂數)
 *    回場都加「創 250 天新高一定回來」(同 ftd_probe 的保險)。⭐ 模擬直接用 ftd_probe 的 actionRun(⛔ 不另寫一份)。
 *    雷達 D 那天成形 = D 開盤前就知道 → 當成 D−1 收盤後的訊號 → D 收盤買(⛔ 不提早一天)。
 *    門檻高原:k = 1 / 2(App:過 ≥ max(6, 算得出來的條數 − 2))/ 3 / 4;分段:2010–17 / 2018–26。
 * 二、逐條事件研究(大盤修正中 = 前一天收盤離 250 天最高 ≥10% 的日子):那一條「過」vs「沒過」,
 *    D 收盤起 20 / 60 天加權漲幅差;p = 標籤在修正日序列上循環平移 1,000 次(單邊:過的比較好);
 *    12 條 + 成形 + 黑天鵝 × 2 天期一起 BH。
 *
 * 跑法:
 *   REBOUND=…/rebound_hist.json IDX_LONG=data/idx_long.json IDX_EARLY=data/idx_long_early.json TWII_NOW=data/^TWII.json \
 *     node scripts/rebound_reentry_probe.mjs out.json
 *   node scripts/rebound_reentry_probe.mjs --selftest
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadIndex, rng, bh } from './crash_warn_probe.mjs';
import { actionRun, detectFTD } from './ftd_probe.mjs';

export const CORR_DD = 10, HS = [20, 60], N_SHIFT = 1000, MIN_SHIFT = 120, N_RAND = 200, KS = [1, 2, 3, 4];
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
const r2 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(2);
const pct = x => x == null || !Number.isFinite(x) ? null : +(x * 100).toFixed(2);

/** 雷達成形(門檻挪 k 格)—— 跟 rebound_hist_build.formed_k 同一條:過 ≥ max(6, 算得出來的條數 − k),而且算得出來 ≥ 6 條 */
export const formedK = (passN, judged, k = 2, floor = 6) => (judged >= floor && passN >= Math.max(floor, judged - k)) ? 1 : 0;

/** 回場訊號的索引集合:dates[i+1] 那天成形 → 訊號放在 i(i 收盤後 → i+1 收盤買)。⛔ 不放在 i+1(那會提早一天) */
export function radarSet(dates, byDate, k = 2) {
    const s = new Set();
    for (let i = 0; i + 1 < dates.length; i++) { const h = byDate.get(dates[i + 1]); if (h && formedK(h.passN, h.judged, k)) s.add(i); }
    return s;
}

/** 隨機等待的天數分布:用「同一套出場 + 這個回場訊號」實際等了幾天(照 ftd_probe 的做法) */
export function waitDays(C, v, set) {
    const out = [], n = C.length, st = v.findIndex(x => x > 0);
    if (st < 0) return out;
    let inM = true, pk = C[st], oi = -1;
    for (let i = st + 1; i < n; i++) {
        if (!(v[i] > 0)) continue;
        if (inM) { pk = Math.max(pk, C[i]); if (C[i] <= pk * (1 - CORR_DD / 100)) { inM = false; oi = i; } }
        else if (set.has(i)) { out.push(i - oi); inM = true; pk = C[i]; }
    }
    return out;
}

/** 事件研究:pop = 修正中的日子(索引),lab(i) = 1 / 0 / null,F(i) = D 收盤起 H 天漲幅 → {n1, n0, m1, m0, diff, p} */
export function condStudy(pop, lab, F, nIter = N_SHIFT, seed = 5) {
    const P = pop.filter(i => F(i) != null && lab(i) != null);
    const L = P.map(lab), V = P.map(F), m = P.length;
    const diffOf = off => { let s1 = 0, n1 = 0, s0 = 0, n0 = 0; for (let j = 0; j < m; j++) { const l = L[(j + off) % m]; if (l === 1) { s1 += V[j]; n1++; } else { s0 += V[j]; n0++; } } return n1 && n0 ? s1 / n1 - s0 / n0 : null; };
    const obs = diffOf(0);
    const n1 = L.filter(x => x === 1).length, n0 = m - n1;
    if (obs == null || n1 < 20 || n0 < 20 || m < 2 * MIN_SHIFT + 10) return { n1, n0, diff: obs, p: null };
    const R = rng(seed);
    let ge = 0;
    for (let t = 0; t < nIter; t++) { const off = MIN_SHIFT + Math.floor(R() * (m - 2 * MIN_SHIFT)); const d = diffOf(off); if (d != null && d >= obs - 1e-12) ge++; }
    const m1 = mean(V.filter((_, j) => L[j] === 1)), m0 = mean(V.filter((_, j) => L[j] === 0));
    return { n1, n0, m1, m0, diff: obs, p: (1 + ge) / (1 + nIter) };
}

export function run(env, log = console.log) {
    const readJ = (p, must) => { if (!p || !fs.existsSync(p)) { if (must) throw new Error(`${p || '(沒設)'} 不存在(⛔ 沒有資料不跑)`); return null; } return JSON.parse(fs.readFileSync(p, 'utf8')); };
    const H = readJ(env.REBOUND, true);
    const { rows, tr } = loadIndex({ long: readJ(env.IDX_LONG, true), early: readJ(env.IDX_EARLY, false), now: readJ(env.TWII_NOW, false) });
    const dates = rows.map(r => r.d), C = rows.map(r => r.c), A = rows.map(r => r.a), n = rows.length;
    const byDate = new Map(H.days.map((d, j) => [d, { passN: H.passN[j], judged: H.judged[j], swan: H.swan[j], c: Object.fromEntries(Object.keys(H.c).map(k => [k, H.c[k][j]])) }]));
    const from = H.days[0];
    log(`📈 加權 ${n} 天(${dates[0]} ~ ${dates[n - 1]})・報酬指數 ${tr.size} 天・雷達 ${H.days.length} 天(${from} ~ ${H.days[H.days.length - 1]})`);
    const vAll = dates.map(d => tr.has(d) ? tr.get(d) : null);
    const mask = (lo, hi) => vAll.map((x, i) => (dates[i] >= lo && dates[i] < hi) ? x : null);
    const ftdSet = new Set(detectFTD(C, A).ftd.map(e => e.i));
    const seg = [['all', `${from} 起`, from, '9999'], ['A', '2010–17', from, '2018-01-01'], ['B', '2018–26', '2018-01-01', '9999']];
    const action = {};
    for (const [key, name, lo, hi] of seg) {
        const v = mask(lo, hi);
        const out = { name, hold: actionRun(C, v, ftdSet, 'hold'), ma60: actionRun(C, v, ftdSet, 'ma60'), ftd: actionRun(C, v, ftdSet, 'ftd') };
        for (const k of KS) out[`radar_k${k}`] = actionRun(C, v, radarSet(dates, byDate, k), 'ftd');
        const rs = radarSet(dates, byDate, 2), delays = waitDays(C, v, rs);
        if (delays.length) {
            const rr = []; for (let s = 1; s <= N_RAND; s++) rr.push(actionRun(C, v, rs, { delays, seed: s }));
            out.rand = { mult: r2(med(rr.map(r => r.mult))), mdd: r2(med(rr.map(r => r.mdd))), inMkt: r2(med(rr.map(r => r.inMkt))),
                         beatRadar: rr.filter(r => r.mult >= out.radar_k2.mult).length, nSeeds: N_RAND, waitMed: med(delays), waits: delays.length };
        }
        action[key] = out;
    }
    // 二、逐條事件研究
    const hi = new Array(n).fill(null); { const dq = []; for (let i = 0; i < n; i++) { while (dq.length && dq[0] <= i - 250) dq.shift(); while (dq.length && C[dq[dq.length - 1]] <= C[i]) dq.pop(); dq.push(i); hi[i] = C[dq[0]]; } }
    const pop = []; for (let i = 1; i < n; i++) if (dates[i] >= from && byDate.has(dates[i]) && C[i - 1] <= hi[i - 1] * (1 - CORR_DD / 100)) pop.push(i);
    const F = Hh => i => (i + Hh < n ? C[i + Hh] / C[i] - 1 : null);      // D 收盤起 Hh 天
    const names = { ...(H.meta && H.meta.names) || {}, formed: '雷達成形(k=2)', swan: '黑天鵝層' };
    const labs = Object.keys(H.c).map(k => [k, i => { const h = byDate.get(dates[i]); const x = h && h.c[k]; return x == null ? null : x; }]);
    labs.push(['formed', i => { const h = byDate.get(dates[i]); return h ? formedK(h.passN, h.judged, 2) : null; }]);
    labs.push(['swan', i => { const h = byDate.get(dates[i]); return h ? h.swan : null; }]);
    const study = [];
    for (const [k, lab] of labs) for (const Hh of HS) { const r = condStudy(pop, lab, F(Hh)); study.push({ k, name: names[k] || k, H: Hh, n1: r.n1, n0: r.n0, m1: pct(r.m1), m0: pct(r.m0), diff: pct(r.diff), p: r.p }); }
    const q = bh(study.map(s => s.p));
    study.forEach((s, j) => { s.q = q[j] == null ? null : +q[j].toFixed(4); });
    return { meta: { generated: new Date().toISOString(), from, to: dates[n - 1], corrDays: pop.length, rule: 'App:過 ≥ max(6, 算得出來的條數 − 2);跌 10% 出場、回場訊號隔天收盤買、創 250 天新高一定回來' }, action, study };
}

function printReport(R, log = console.log) {
    const f = x => x == null ? '—' : x;
    log(`\n## 一、怎麼用(加權報酬指數,${R.meta.from} 起;最後變成幾倍 ・中途最多賠 ・在場時間 ・來回次數)`);
    for (const key of Object.keys(R.action)) {
        const a = R.action[key];
        log(`\n### ${a.name}`);
        const row = (nm, x) => x && log(`- ${nm}:×${f(x.mult)} ・${f(x.mdd)}% ・在場 ${f(x.inMkt)}% ・${x.trips != null ? x.trips + ' 趟' : ''}`);
        row('一直抱著', a.hold); row('跌 10% 出場 → 站回 60 日線回來', a.ma60); row('跌 10% 出場 → 追盤日回來', a.ftd);
        for (const k of KS) row(`跌 10% 出場 → 雷達成形回來(k=${k}${k === 2 ? ',App' : ''})`, a[`radar_k${k}`]);
        if (a.rand) log(`- 跌 10% 出場 → 隨機等(天數抽自雷達版,${a.rand.nSeeds} 種中位):×${a.rand.mult} ・${a.rand.mdd}% ・在場 ${a.rand.inMkt}% ・隨機贏雷達 ${a.rand.beatRadar}/${a.rand.nSeeds} ・雷達版等待中位 ${a.rand.waitMed} 天(${a.rand.waits} 次)`);
    }
    log(`\n## 二、修正中(${R.meta.corrDays} 天)那一條過 vs 沒過:D 收盤起漲幅差(pp)・p(循環平移)・q(BH)`);
    for (const s of R.study) log(`- ${s.name} ${s.H} 天:過 ${s.n1} 天 ${f(s.m1)}% vs 沒過 ${s.n0} 天 ${f(s.m0)}% → 差 ${f(s.diff)} ・p ${f(s.p)} ・q ${f(s.q)}${s.q != null && s.q <= 0.05 ? ' ✅' : ''}`);
}

function selftest() {
    const fails = [];
    const ok = (nm, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${nm}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) fails.push(nm); };
    // ① 成形門檻 = App 那條
    ok('① formedK:12 條算得出來時要過 10 條', formedK(10, 12) === 1 && formedK(9, 12) === 0 && formedK(6, 7) === 1 && formedK(5, 7) === 0 && formedK(6, 5) === 0);
    ok('① k 放寬 → 要過的條數變少', formedK(8, 12, 4) === 1 && formedK(8, 12, 2) === 0);
    // ② 訊號放在前一天(⛔ 提早):dates[i+1] 成形 → i 進集合
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-06'];
    const by = new Map([['2020-01-03', { passN: 12, judged: 12 }], ['2020-01-02', { passN: 1, judged: 12 }]]);
    const s = radarSet(dates, by, 2);
    ok('② 1/3 成形 → 訊號放在 1/2 收盤後(索引 1)、⛔ 不放在 1/3 本身', s.has(1) && !s.has(2) && s.size === 1, [...s]);
    // ③ 合成盤:跌 20% → 第 X 天雷達成形 → 隔天收盤才回場(⛔ 早一天)
    const N = 300, C = [], v = [];
    for (let i = 0; i < N; i++) { const c = i < 100 ? 100 + i * 0.1 : i < 140 ? 110 - (i - 100) * 0.6 : 86 + (i - 140) * 0.05; C.push(c); v.push(c); }
    const set = new Set([179]);                                   // 第 180 天成形 → 訊號在 179
    const a = actionRun(C, v, set, 'ftd'), hold = actionRun(C, v, set, 'hold');
    const w = waitDays(C, v, set);
    ok('③ 有出場、有在第 179 天訊號回場(等待天數 = 179 − 出場那天)', w.length === 1 && w[0] > 0 && a.trips === 1, JSON.stringify({ w, a }));
    const a2 = actionRun(C, v, new Set([178]), 'ftd');
    ok('③ ⭐ 決定性對照:訊號早一天 → 在場時間比較長(證明索引真的有作用)', a2.inMkt > a.inMkt, `${a2.inMkt} vs ${a.inMkt}`);
    ok('③ 一直抱著 ≠ 出場再回來', hold.mult !== a.mult);
    // ④ 事件研究:標籤完美對應未來 → p 小;標籤亂數 → p 大
    const M = 1200, R = rng(9), V = [], Lp = [], Lr = [];
    for (let i = 0; i < M; i++) { const blk = Math.floor(i / 30) % 2; V.push(blk ? 0.05 + R() * 0.01 : -0.05 + R() * 0.01); Lp.push(blk); Lr.push(R() < 0.5 ? 1 : 0); }
    const pop = [...Array(M).keys()];
    const good = condStudy(pop, i => Lp[i], i => V[i], 300), bad = condStudy(pop, i => Lr[i], i => V[i], 300);
    ok('④ 標籤對應未來(成塊的) → 差 > 0 而且 p ≤ 0.05', good.diff > 0.05 && good.p <= 0.05, JSON.stringify(good));
    ok('④ 標籤是亂數 → p > 0.05(⛔ 沒東西不可以量出東西)', bad.p > 0.05, JSON.stringify(bad));
    ok('④ null 不算過也不算沒過', condStudy(pop, i => (i % 3 === 0 ? null : Lp[i]), i => V[i], 50).n1 + condStudy(pop, i => (i % 3 === 0 ? null : Lp[i]), i => V[i], 50).n0 === M - 400);
    console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ selftest 全部通過');
    process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else {
        const out = process.argv.slice(2).find(a => a.endsWith('.json'));
        const R = run(process.env);
        printReport(R);
        if (out) { fs.writeFileSync(out, JSON.stringify(R)); console.log(`\n💾 ${out}`); }
    }
}
