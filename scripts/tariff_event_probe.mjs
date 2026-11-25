// 🏛️ tariff_event_probe.mjs —— 美國官方關稅「政策本身」→ 台股之後怎麼走(EXP-20261125-03,事先登記)
//
// 為什麼要測:2026-11-25 使用者:「川普新 301 關稅請持續追蹤,並且會對股市怎麼影響」。
//   本站只測過川普「發文」(LAB trump-post:發文之後的方向量不到)—— 這次測「政府正式做了什麼」:
//   加碼(新的 / 更高的關稅,有具體稅率)、降溫(暫停 / 休兵 / 協議)、生效那天。
//
// 事件:research/tariff_events_20261125.json(登記前寫死,規則寫在檔頭 note;⛔ 看價格調)
//   美國日期 → 第一個「台灣日期 > 美國日期」的台股交易日(美國白天宣布 = 台北晚上,隔天才反應得到;隔超過 10 天不算);
//   生效日 → 第一個「台灣日期 ≥ 生效日」的台股交易日(美東 0:01 生效 = 台北 13:01,那天的盤還在)。
//   同方向 5 個日曆天內併成一次(留第一個);方向相反對到同一個台股交易日 → 兩個都不算。
// 資料:加權 2000 起(lib_crash.loadIndex:idx_long_early + idx_long + ^TWII;含開盤價、含息 2003 起)
// ⭐ 判定(EXP 寫死,⛔ 跑完再改)見 RULE / judge():
//   加碼那天(反應日)收盤之後 20 個交易日 vs「同一級第一天漲跌、但不是關稅」的日子之後 20 天
//   (第一天漲跌分 5 級:≤ −3% / −3~−1.5 / −1.5~0 / 0~1.5 / > 1.5;對照 = 2010 起、離任何關稅事件 ±5 個交易日以外的日子)
//   差 ≥ 2 個百分點(好或壞都算)・隨機抽同級對照日 4,000 次的雙尾 p ≤ 0.05・2018~2020 與 2025~2026 兩段同方向・≥ 10 次。
//   只用到 2026-11-06。另外照日子類型探針(daytype_probe.cellStat,同星期幾對照、分層置換、BH)量「顛不顛」三格 + 方向三格
//   → 行事曆「美國關稅生效」那一句(scripts/embed_day_facts.mjs 讀 out.json 的 cells)。
//
// 跑法:IDX_LONG IDX_EARLY TWII_NOW [EVENTS] node scripts/tariff_event_probe.mjs [out.json]
//       node scripts/tariff_event_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadIndex, mean, med, r2, rng } from './lib_crash.mjs';
import { series, cellStat, verdictOf, COST, BIG } from './daytype_probe.mjs';
import { bh } from './dipbuy_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVENTS = path.join(ROOT, 'research', 'tariff_events_20261125.json');
// ⭐ 事先登記的判定(EXP-20261125-03 寫死;⛔ 跑完再改)
export const RULE = { cut: '2026-11-06', merge: 5, maxLag: 10, h: 20, effect: 2, p: 0.05, minN: 10,
    edges: [-3, -1.5, 0, 1.5], ctrlFrom: '2010-01-01', excl: 5, sims: 4000, seed: 20261125, hs: [5, 20, 60],
    eras: [['2018-01-01', '2020-12-31'], ['2025-01-01', '2026-12-31']] };

const T = s => Date.parse(s + 'T00:00:00Z');
const gapDays = (a, b) => Math.round((T(b) - T(a)) / 864e5);
const lb = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
/** 美國日期 → 第一個台灣日期 > 它的台股交易日(隔超過 maxLag 個日曆天 → −1) */
export function twAfter(d, us, maxLag = RULE.maxLag) { const i = lb(d, us + '~'); return i < d.length && gapDays(us, d[i]) <= maxLag ? i : -1; }
/** 生效日 → 第一個台灣日期 ≥ 它的台股交易日 */
export function twOnOrAfter(d, us, maxLag = RULE.maxLag) { const i = lb(d, us); return i < d.length && gapDays(us, d[i]) <= maxLag ? i : -1; }
/** 同方向 merge 個日曆天內併成一次(留第一個) */
export function mergeSame(xs, days = RULE.merge) {
    const out = []; for (const x of xs.slice().sort((a, b) => a.us.localeCompare(b.us))) { const last = out.at(-1); if (last && gapDays(last.us, x.us) <= days) { (last.merged = last.merged || []).push(x.us); continue; } out.push({ ...x }); }
    return out;
}
export const classOf = r => RULE.edges.filter(e => r > e).length;   // 0: ≤ −3 … 4: > 1.5

/** 事件 → 台股反應日;方向相反對到同一天的兩個都拿掉 */
export function buildEvents(S, E, cut = RULE.cut) {
    const map = (xs, dir) => mergeSame((xs || []).filter(x => x.us <= cut)).map(x => ({ ...x, dir, i: twAfter(S.d, x.us) })).filter(x => x.i > 0);
    let up = map(E.up, 'up'), dn = map(E.down, 'down');
    const iu = new Set(up.map(x => x.i)), idn = new Set(dn.map(x => x.i)), clash = new Set([...iu].filter(i => idn.has(i)));
    const dropped = [...up, ...dn].filter(x => clash.has(x.i)).map(x => `${x.us} ${x.dir}`);
    up = up.filter(x => !clash.has(x.i)); dn = dn.filter(x => !clash.has(x.i));
    const eff = (E.eff || []).filter(x => x.us <= cut).map(x => ({ ...x, dir: 'eff', i: twOnOrAfter(S.d, x.us) })).filter(x => x.i > 0);
    const mixed = (E.mixed || []).filter(x => x.us <= cut).map(x => twAfter(S.d, x.us)).filter(i => i > 0);
    return { up, dn, eff, dropped, mixed };
}

/** 每一個事件的第一天 / 開盤跳空 / 之後 h 天 */
export function outcomes(S, ev) {
    const n = S.d.length, o = S.o || [];
    for (const e of ev) {
        const i = e.i; e.d = S.d[i];
        e.day1 = r2((S.c[i] / S.c[i - 1] - 1) * 100);
        e.gap = o[i] > 0 ? r2((o[i] / S.c[i - 1] - 1) * 100) : null;
        e.cls = classOf(e.day1);
        e.f = {}; for (const h of RULE.hs) e.f[h] = i + h < n ? r2((S.c[i + h] / S.c[i] - 1) * 100) : null;
        e.tr20 = S.tr && S.tr[i] && i + RULE.h < n && S.tr[i + RULE.h] ? r2((S.tr[i + RULE.h] / S.tr[i] - 1) * 100) : null;
    }
    return ev;
}

/** 同一級第一天漲跌、但不是關稅的日子(對照池):第 k 天收盤之後 h 天 */
export function ctrlPools(S, evIdx, h = RULE.h) {
    const n = S.d.length, ban = new Set(), k0 = lb(S.d, RULE.ctrlFrom), pools = [[], [], [], [], []];
    for (const i of evIdx) for (let k = i - RULE.excl; k <= i + RULE.excl; k++) ban.add(k);
    for (let k = Math.max(1, k0); k + h < n; k++) {
        if (ban.has(k)) continue;
        const r = (S.c[k] / S.c[k - 1] - 1) * 100;
        pools[classOf(r)].push((S.c[k + h] / S.c[k] - 1) * 100);
    }
    return pools;
}

/** 一組事件 vs 同級對照:平均差、雙尾 p、兩段 */
export function vsCtrl(ev, pools, h = RULE.h, sims = RULE.sims, seed = RULE.seed) {
    const mu = pools.map(p => p.length ? mean(p) : null);
    const rows = ev.filter(e => e.f[h] != null && mu[e.cls] != null && pools[e.cls].length >= 30);
    const o = { n: rows.length, nAll: ev.length, h };
    if (rows.length < 3) return o;
    const diffs = rows.map(e => e.f[h] - mu[e.cls]), D = mean(diffs), R = rng(seed);
    let lo = 0, hi = 0;
    for (let s = 0; s < sims; s++) { let t = 0; for (const e of rows) { const p = pools[e.cls]; t += p[Math.floor(R() * p.length)] - mu[e.cls]; } t /= rows.length; if (t <= D + 1e-12) lo++; if (t >= D - 1e-12) hi++; }
    const era = RULE.eras.map(([a, b]) => { const x = rows.filter(e => e.us >= a && e.us <= b).map(e => e.f[h] - mu[e.cls]); return { n: x.length, diff: x.length ? r2(mean(x)) : null }; });
    Object.assign(o, { ev: r2(mean(rows.map(e => e.f[h]))), ctrl: r2(mean(rows.map(e => mu[e.cls]))), diff: r2(D), med: r2(med(diffs)),
        p: +Math.min(1, 2 * Math.min((lo + 1) / (sims + 1), (hi + 1) / (sims + 1))).toFixed(4), era,
        worse: diffs.filter(x => x < 0).length, up: r2(rows.filter(e => e.f[h] > 0).length / rows.length * 100) });
    return o;
}

export function judge(st) {
    const R = RULE, e = st.era || [];
    const c = [
        [`加碼有 20 天成績的次數 ≥ ${R.minN}`, st.n >= R.minN],
        [`比同級對照差或好 ≥ ${R.effect} 個百分點`, st.diff != null && Math.abs(st.diff) >= R.effect],
        [`雙尾 p ≤ ${R.p}`, st.p != null && st.p <= R.p],
        ['2018~2020 與 2025~2026 兩段同方向', e.length === 2 && e.every(x => x.n > 0 && x.diff != null && Math.sign(x.diff) === Math.sign(st.diff))],
    ];
    return { pass: c.every(z => z[1]), checks: c.map(([t, ok]) => ({ t, ok })) };
}

/** 顛不顛 / 方向:照日子類型探針同一套(同星期幾對照、分層置換;這支自己的六格做 BH) */
export function dayCells(S, B, seed = RULE.seed, sims = RULE.sims) {
    const Z = series(S), defs = [
        { id: 'tariff_up_day', fam: 'dir', label: '美國宣布關稅加碼・之後第一個台股交易日', ev: B.up.map(e => e.i), x: 'day', min: COST },
        { id: 'tariff_dn_day', fam: 'dir', label: '美國宣布關稅降溫・之後第一個台股交易日', ev: B.dn.map(e => e.i), x: 'day', min: COST },
        { id: 'tariff_eff_day', fam: 'dir', label: '美國關稅生效那天', ev: B.eff.map(e => e.i), x: 'day', min: COST },
        { id: 'v_tariff_up', fam: 'vol', label: '美國宣布關稅加碼之後第一個交易日', ev: B.up.map(e => e.i), x: 'abs' },
        { id: 'v_tariff_dn', fam: 'vol', label: '美國宣布關稅降溫之後第一個交易日', ev: B.dn.map(e => e.i), x: 'abs' },
        { id: 'v_tariff_eff', fam: 'vol', label: '美國關稅生效那天', ev: B.eff.map(e => e.i), x: 'abs' },
    ];
    const cells = defs.map((c, k) => cellStat(Z, c, seed + k, sims));
    for (const fam of ['dir', 'vol']) { const cs = cells.filter(c => c.fam === fam && c.p != null), q = bh(cs.map(c => c.p)); cs.forEach((c, i) => { c.q = q[i]; }); }
    cells.forEach((c, k) => { c.verdict = verdictOf(c, defs[k]); });
    return cells;
}

export function cutSer(S, cut) { let n = S.d.length; while (n > 0 && S.d[n - 1] > cut) n--; const o = {}; for (const [k, v] of Object.entries(S)) o[k] = Array.isArray(v) && v.length === S.d.length ? v.slice(0, n) : v; return o; }

export function run(S0, E, log = console.log, sims = RULE.sims) {
    const S = cutSer(S0, RULE.cut), B = buildEvents(S, E);
    for (const g of [B.up, B.dn, B.eff]) outcomes(S, g);
    const pools = ctrlPools(S, [...B.up, ...B.dn, ...B.eff].map(e => e.i).concat(B.mixed));
    const up = vsCtrl(B.up, pools, RULE.h, sims), dn = vsCtrl(B.dn, pools, RULE.h, sims);
    const side = {}; for (const h of [5, 60]) side[h] = { up: vsCtrl(B.up, pools, h, sims), dn: vsCtrl(B.dn, pools, h, sims) };
    const cells = dayCells(S, B, RULE.seed, sims);
    const d1 = g => ({ n: g.length, mean: r2(mean(g.map(e => e.day1))), med: r2(med(g.map(e => e.day1))), big: r2(g.filter(e => Math.abs(e.day1) >= BIG).length / Math.max(1, g.length) * 100), down: g.filter(e => e.day1 < 0).length });
    const out = { meta: { cut: RULE.cut, from: S.d[0], to: S.d.at(-1), rule: RULE, ctrlN: pools.map(p => p.length), dropped: B.dropped },
        events: { up: B.up, dn: B.dn, eff: B.eff }, day1: { up: d1(B.up), dn: d1(B.dn), eff: d1(B.eff) }, up, dn, side, cells, judge: judge(up) };
    print(out, log);
    return out;
}

export function print(o, log = console.log) {
    const m = o.meta;
    log(`===== 🏛️ 美國官方關稅動作 → 台股(加權 ${m.from}~${m.to};判定只用到 ${m.cut})=====`);
    log(`  同級對照池(2010 起、離事件 ±5 天以外)每一級天數:${m.ctrlN.join(' / ')}(≤−3% / −3~−1.5 / −1.5~0 / 0~1.5 / >1.5)・方向相反撞同一天拿掉:${m.dropped.join('、') || '無'}`);
    for (const [k, zh] of [['up', '加碼'], ['dn', '降溫'], ['eff', '生效']]) {
        const a = o.day1[k]; log(`\n── ${zh} ${a.n} 次:第一天平均 ${a.mean}%(中位 ${a.med}、下跌 ${a.down}/${a.n}、漲跌超過 ${BIG}% 的 ${a.big}%)──`);
        for (const e of o.events[k]) log(`   ${e.us} → ${e.d} ${e.what}${e.merged ? `(併入 ${e.merged.join('、')})` : ''}:第一天 ${e.day1}%(開盤 ${e.gap ?? '—'}%)・之後 5 / 20 / 60 天 ${e.f[5] ?? '—'} / ${e.f[20] ?? '—'} / ${e.f[60] ?? '—'}%`);
    }
    for (const [k, zh] of [['up', '加碼'], ['dn', '降溫']]) {
        const s = o[k]; log(`\n  ${zh}之後 20 天 vs 同級對照:${s.n} 次 ${s.ev ?? '—'}% vs ${s.ctrl ?? '—'}% → 差 ${s.diff ?? '—'}(中位 ${s.med ?? '—'}、比較差 ${s.worse ?? '—'}/${s.n}、雙尾 p ${s.p ?? '—'})・2018~2020 ${s.era ? `${s.era[0].diff}(${s.era[0].n} 次)` : '—'} / 2025~2026 ${s.era ? `${s.era[1].diff}(${s.era[1].n} 次)` : '—'}`);
        for (const h of [5, 60]) { const t = o.side[h][k]; log(`     只描述 ${h} 天:差 ${t.diff ?? '—'}(p ${t.p ?? '—'}、${t.n} 次)`); }
    }
    log(`\n── 顛不顛 / 方向(同星期幾對照、分層置換、BH;大漲大跌 = 超過 ${BIG}%)──`);
    for (const c of o.cells) log(`  ${c.id} ${c.label}:${c.n ?? 0} 次 ${c.fam === 'vol' ? `倍數 ${c.ratio ?? '—'}(大漲大跌 ${c.big ?? '—'}% vs 平常 ${c.bigBase ?? '—'}%)` : `差 ${c.diff ?? '—'}%(上漲 ${c.up ?? '—'}% vs ${c.upBase ?? '—'}%)`}・p ${c.p ?? '—'} q ${c.q ?? '—'}・前半 ${c.h1 ?? '—'} / 後半 ${c.h2 ?? '—'} → ${c.verdict}`);
    log(`\n  ⭐ EXP-20261125-03 判定:${o.judge.pass ? '✅' : '⛔'} ${o.judge.checks.map(c => (c.ok ? '✓' : '✗') + c.t).join(' / ')}`);
}

// ═══════════════════════════ selftest ═══════════════════════════
function bdays(n, y = 2016) { const out = []; let t = Date.UTC(y, 0, 1); while (out.length < n) { const w = new Date(t).getUTCDay(); if (w && w < 6) out.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; } return out; }
function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + x}`); if (!c) bad++; };
    const d = ['2025-04-02', '2025-04-07', '2025-04-08', '2025-04-09', '2025-04-10'];
    ok('① 美國 4/2(週三)宣布 → 台股 4/7(4/3~4/4 休市;⛔ 同一天的 4/2)', twAfter(d, '2025-04-02') === 1 && twAfter(d, '2025-04-07') === 2);
    ok('① 生效日 4/8 → 台股 4/8 那天;隔超過 10 天 → −1', twOnOrAfter(d, '2025-04-08') === 2 && twAfter(['2025-04-20'], '2025-04-02') === -1);
    const mg = mergeSame([{ us: '2018-04-05' }, { us: '2018-04-03' }, { us: '2018-04-12' }]);
    ok('② 同方向 5 天內併成一次(留第一個),第 9 天的另外算', mg.length === 2 && mg[0].us === '2018-04-03' && mg[0].merged[0] === '2018-04-05' && mg[1].us === '2018-04-12', JSON.stringify(mg));
    const Sx = { d: bdays(40, 2025), c: Array(40).fill(100) };
    const Bx = buildEvents(Sx, { up: [{ us: '2025-01-06', what: 'a' }], down: [{ us: '2025-01-06', what: 'b' }, { us: '2025-01-20', what: 'c' }] });
    ok('③ 方向相反、對到同一個台股交易日 → 兩個都拿掉', Bx.up.length === 0 && Bx.dn.length === 1 && Bx.dropped.length === 2, JSON.stringify(Bx.dropped));
    ok('④ 第一天漲跌分 5 級', classOf(-3.5) === 0 && classOf(-3) === 0 && classOf(-2) === 1 && classOf(-0.5) === 2 && classOf(1) === 3 && classOf(2) === 4);
    // ⑤ 埋效果:加碼之後 20 天一律多跌 6%(同一天第一天 −2%)→ 判得出;沒埋 → 判不出
    const N = 3200, dd = bdays(N, 2012), R = rng(5), ret = [0];
    for (let i = 1; i < N; i++) ret.push((R() - 0.498) * 0.03);
    const usDays = [], E = { up: [], down: [] };
    for (let k = 0; k < 24; k++) { const i = 1400 + k * 70; usDays.push(i); E.up.push({ us: dd[i - 1], what: 'x' + k }); }
    /** 加碼那天一律 −2%(同一級);shock = 之後 20 天額外多跌幾成(平均攤在 20 天) */
    const mkS = shock => { const r = ret.slice(); for (const i of usDays) { r[i] = -0.02; for (let k = i + 1; k <= i + 20; k++) r[k] += Math.log(1 - shock) / 20; }
        const c = [100]; for (let i = 1; i < N; i++) c.push(c[i - 1] * (1 + r[i])); return { d: dd.slice(), c, o: c.slice() }; };
    const eras = RULE.eras; RULE.eras = [[dd[0], dd[2299]], [dd[2300], dd[N - 1]]];
    const S1 = mkS(0.06), o1 = run(S1, E, () => {}, 800), S0 = mkS(0), o0 = run(S0, E, () => {}, 800);
    RULE.eras = eras;
    ok('⑤ 埋「加碼之後 20 天多跌 6%」→ 判得出來(差 ≤ −2、p ≤ 0.05、兩段同向)', o1.judge.pass && o1.up.diff <= -2, JSON.stringify([o1.up.diff, o1.up.p, o1.up.era]));
    ok('⑤ 沒埋 → 判不出來', !o0.judge.pass, JSON.stringify([o0.up.diff, o0.up.p]));
    // ⑥ 封存日之後亂改 → 判定一模一樣(合成資料跨過封存日)
    const d6 = bdays(5300, 2007), c6 = [100], R6 = rng(9); for (let i = 1; i < 5300; i++) c6.push(c6[i - 1] * (1 + (R6() - 0.499) * 0.025));
    const E6 = { up: d6.filter((_, i) => i > 2500 && i % 97 === 0 && d6[i] < RULE.cut).map(x => ({ us: x, what: 'u' })), down: d6.filter((_, i) => i > 2500 && i % 131 === 0 && d6[i] < RULE.cut).map(x => ({ us: x, what: 'd' })), eff: [] };
    ok('⑥ 合成資料真的跨過封存日', d6.at(-1) > RULE.cut, d6.at(-1));
    const A6 = run({ d: d6, c: c6, o: c6 }, E6, () => {}, 400), G6 = run({ d: d6, c: c6.map((x, i) => d6[i] > RULE.cut ? x * (i % 2 ? 4 : 0.3) : x), o: c6 }, { ...E6, up: [...E6.up, { us: '2026-11-10', what: '封存期' }] }, () => {}, 400);
    ok('⑥ 封存日之後的價格亂改、加一筆封存期事件 → 判定與數字一模一樣', JSON.stringify([A6.judge, A6.up, A6.dn, A6.cells.map(c => [c.id, c.n, c.p])]) === JSON.stringify([G6.judge, G6.up, G6.dn, G6.cells.map(c => [c.id, c.n, c.p])]));
    // ⑦ 真的事件檔:日期格式、加碼 / 降溫 / 生效都有、兩段都有加碼
    const EJ = JSON.parse(fs.readFileSync(EVENTS, 'utf8')), okD = x => /^\d{4}-\d{2}-\d{2}$/.test(x.us) && !Number.isNaN(T(x.us));
    ok('⑦ 事件檔:全部日期合法、加碼 ≥ 20 / 降溫 ≥ 10 / 生效 ≥ 15、兩段都有加碼', [...EJ.up, ...EJ.down, ...EJ.eff].every(okD) && EJ.up.length >= 20 && EJ.down.length >= 10 && EJ.eff.length >= 15
       && EJ.up.some(x => x.us < '2021') && EJ.up.some(x => x.us > '2025'), `${EJ.up.length}/${EJ.down.length}/${EJ.eff.length}`);
    ok('⑦ 事件檔判定截止日 = RULE.cut(⛔ 兩邊各寫一個)', EJ.cut === RULE.cut, EJ.cut);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ TARIFF_EVENT_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('tariff_event_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(process.env), E = JSON.parse(fs.readFileSync(process.env.EVENTS || EVENTS, 'utf8'));
    const out = run(S, E);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
