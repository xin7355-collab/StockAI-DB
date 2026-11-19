// 💴 yen_surge_probe.mjs —— 日圓急升之後,台股接下來比較顛嗎?(「App 加上人性」第 7 期第 5 題,EXP 事先登記)
//
// 為什麼要測:散戶 App 的風險指數有一段「美元兌日圓一天跌 > 1% 加 15 分」,反攻雷達有「日圓 3 日急升 ≥2%」、
//   黑天鵝有「3 日 ≥4%」—— 都是「2024/8/5 套利平倉」那一次的印象,⛔ 從來沒有回測過。
//   而且風險指數那一段讀的是不存在的欄位,其實從來沒作用。這支回答「要不要接上」。
//
// 資料:加權 2000 起(lib_crash.loadIndex)+ 美國聯準會 DEXJPUS(美元兌日圓,紐約中午;fred_hist.json series.jpy)
// 時間點(⛔ 前視):紐約中午 t 的匯率,台股 t 那天已經收盤 → 最早 t 之後第一個台股交易日(r)才看得到。
//   判斷「之後比較顛」一律從 r 收盤起算(那天早上 App 才會顯示;r 那一下的跳空只描述 = gap)。
// 對手:同一個「本來就多顛」(r 之前 20 天實現波動、只用之前的日子分五組)的非事件日 —— 日圓急升常出在本來就在顛的時候,
//   ⛔ 拿「全部日子」當對手會把「本來就顛」算成日圓的功勞。
// 事件:同一段 10 個台股交易日內只算第一次(gapDedup 同一個意思)。
//
// 跑法:IDX_LONG IDX_EARLY TWII_NOW FRED_HIST node scripts/yen_surge_probe.mjs [out.json]
//       node scripts/yen_surge_probe.mjs --selftest
import fs from 'fs';
import { loadIndex, mean, r2, rng } from './lib_crash.mjs';

// ⭐ 事先登記的判定(EXP 寫死;⛔ 跑完再改)
export const RULE = { dd: 5, h: 20, dd60: 10, h60: 60, dedup: 10, minHist: 250, effect: 5, effectNoTop: 3, p: 0.025, sims: 300, split: '2013-01-01' };
// 兩個判的事件(風險指數最大那一級 / 反攻雷達那條)+ 只描述的三個
export const JUDGED = [{ id: 'd1_1', kind: 1, th: -1.0, zh: '一天升值 ≥1%(風險指數 +15 分那一級)' },
                       { id: 'd3_2', kind: 3, th: -2.0, zh: '3 天升值 ≥2%(反攻雷達「日圓不急升」那條)' }];
export const DESC = [{ id: 'd1_05', kind: 1, th: -0.5, zh: '一天升值 ≥0.5%(+10 分那一級)' },
                     { id: 'd1_02', kind: 1, th: -0.2, zh: '一天升值 ≥0.2%(+5 分那一級)' },
                     { id: 'd3_4', kind: 3, th: -4.0, zh: '3 天升值 ≥4%(黑天鵝那條)' }];

/** fred_hist.json → { d: [...], v: [...] }(由舊到新、只留正數) */
export function loadJpy(j) {
    const d = j && j.series && j.series.jpy && j.series.jpy.d;
    if (!d || typeof d !== 'object') throw new Error('fred_hist.json 沒有 series.jpy.d');
    const ks = Object.keys(d).filter(k => +d[k] > 0).sort();
    return { d: ks, v: ks.map(k => +d[k]) };
}

/** 美元兌日圓 kind 天變化(%):負的 = 日圓升值 */
export function fxChg(J, kind) { return J.v.map((x, i) => i >= kind ? (x / J.v[i - kind] - 1) * 100 : null); }

/** 匯率日期 → 台股:b0 = 最後一個 ≤ t 的台股交易日、r = 第一個 > t 的台股交易日(看得到的那天) */
export function alignR(Sd, t) {
    let lo = 0, hi = Sd.length;           // 第一個 > t
    while (lo < hi) { const m = (lo + hi) >> 1; if (Sd[m] > t) hi = m; else lo = m + 1; }
    return { r: lo < Sd.length ? lo : -1, b0: lo - 1 };
}

/** 20 天實現波動(年化 %),i 那天收盤以前 20 天的日報酬(⛔ 含 i 之後) */
export function rv20(c, i) {
    if (i < 20) return null;
    const x = []; for (let k = i - 19; k <= i; k++) x.push(Math.log(c[k] / c[k - 1]));
    const m = mean(x); return Math.sqrt(x.reduce((s, y) => s + (y - m) ** 2, 0) / (x.length - 1)) * Math.sqrt(250) * 100;
}

/** 每一天的波動五分位(只用那天以前的波動排;前 minHist 天不分組 = null) */
export function volBuckets(c, minHist = RULE.minHist) {
    const v = c.map((_, i) => rv20(c, i)), out = new Array(c.length).fill(null), past = [];
    for (let i = 0; i < c.length; i++) {
        if (v[i] == null) continue;
        if (past.length >= minHist) {
            let lt = 0; for (const x of past) if (x < v[i]) lt++;
            out[i] = Math.min(4, Math.floor(lt / past.length * 5));
        }
        past.push(v[i]);
    }
    return out;
}

/** r 收盤之後 h 天內最低收盤有沒有比 r 收盤低 dd% 以上;之後 h 天報酬;之後 20 天實現波動 */
export function outcome(c, r, h, dd) {
    if (r < 0 || r + h >= c.length) return null;
    let mn = Infinity; for (let k = r + 1; k <= r + h; k++) mn = Math.min(mn, c[k]);
    return { hit: mn <= c[r] * (1 - dd / 100) ? 1 : 0, ret: (c[r + h] / c[r] - 1) * 100 };
}

/** 事件(台股 r 的索引),同一段 dedup 個台股交易日內只算第一次 */
export function events(S, J, kind, th, dedup = RULE.dedup) {
    const ch = fxChg(J, kind), out = []; let last = -1e9;
    for (let i = 0; i < J.d.length; i++) {
        if (ch[i] == null || ch[i] > th) continue;
        const { r, b0 } = alignR(S.d, J.d[i]);
        if (r < 0 || b0 < 0) continue;
        if (r - last < dedup) continue;
        out.push({ r, b0, t: J.d[i], chg: ch[i] }); last = r;
    }
    return out;
}

/** 事件 vs 同一波動組的非事件日:Δ = 事件「之後 h 天內跌 dd%」的比例 − 那一組平常的比例(照事件分布加權)
 *  from / to = 只算那一段(對手也只用那一段的日子) */
export function delta(S, B, evs, o = {}) {
    const h = o.h ?? RULE.h, dd = o.dd ?? RULE.dd, from = o.from || '0000', to = o.to || '9999', skipY = o.skipY || null;
    const evSet = new Set(evs.map(e => e.r));
    const base = [0, 1, 2, 3, 4].map(() => ({ n: 0, k: 0 }));
    for (let i = 0; i < S.c.length; i++) {
        if (B[i] == null || evSet.has(i) || S.d[i] < from || S.d[i] >= to) continue;
        const x = outcome(S.c, i, h, dd); if (!x) continue;
        base[B[i]].n++; base[B[i]].k += x.hit;
    }
    const rows = [];
    for (const e of evs) {
        if (S.d[e.r] < from || S.d[e.r] >= to || (skipY && S.d[e.r].slice(0, 4) === skipY)) continue;
        const b = B[e.r], x = outcome(S.c, e.r, h, dd);
        if (b == null || !x || !base[b].n) continue;
        rows.push({ hit: x.hit, ret: x.ret, rate: base[b].k / base[b].n, b });
    }
    if (!rows.length) return { n: 0, delta: null };
    const ev = mean(rows.map(x => x.hit)) * 100, bl = mean(rows.map(x => x.rate)) * 100;
    return { n: rows.length, ev: r2(ev), base: r2(bl), delta: r2(ev - bl), ret: r2(mean(rows.map(x => x.ret))) };
}

/** 安慰劑:事件那幾天(r)整串在台股日上循環平移(保留群聚),重算 Δ;回 p = 平移後 ≥ 實際的比例 */
export function placebo(S, B, evs, obs, o = {}) {
    const sims = o.sims ?? RULE.sims, R = rng(o.seed ?? 5), N = S.c.length; let ge = 0, n = 0;
    for (let s = 0; s < sims; s++) {
        const off = 260 + Math.floor(R() * (N - 520));
        const sh = evs.map(e => ({ r: (e.r + off) % N })).sort((a, b) => a.r - b.r);
        const d = delta(S, B, sh, o).delta; if (d == null) continue;
        n++; if (d >= obs) ge++;
    }
    return n ? (ge + 1) / (n + 1) : null;
}

/** 事件最多的那一年(拿掉它再算一次) */
export function topYear(S, evs) {
    const c = {}; for (const e of evs) { const y = S.d[e.r].slice(0, 4); c[y] = (c[y] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

/** ⭐ 事先登記的判定:Δ ≥ +5pp・兩段(2000~2012 / 2013~)都 > 0・安慰劑 p < 0.025・拿掉事件最多那一年 Δ ≥ +3pp */
export function judge(S, B, evs, o = {}) {
    const all = delta(S, B, evs, o), a = delta(S, B, evs, { ...o, to: RULE.split }), b = delta(S, B, evs, { ...o, from: RULE.split });
    const ty = topYear(S, evs), noTop = delta(S, B, evs, { ...o, skipY: ty });
    const p = all.delta == null ? null : placebo(S, B, evs, all.delta, o);
    const c1 = all.delta != null && all.delta >= RULE.effect, c2 = a.delta != null && b.delta != null && a.delta > 0 && b.delta > 0;
    const c3 = p != null && p < RULE.p, c4 = noTop.delta != null && noTop.delta >= RULE.effectNoTop;
    return { all, a, b, topYear: ty, noTop, p: r2(p), pass: [c1, c2, c3, c4], verdict: c1 && c2 && c3 && c4 ? '✅ 日圓急升之後比較顛' : '⛔ 沒有比較顛(或說不準)' };
}

/** 只描述:r 那一下(b0 收盤 → r 收盤)平均 / 跌 2% 以上的比例 vs 全部日子 */
export function gapStats(S, evs) {
    const g = evs.filter(e => e.b0 >= 0).map(e => (S.c[e.r] / S.c[e.b0] - 1) * 100);
    const all = []; for (let i = 1; i < S.c.length; i++) all.push((S.c[i] / S.c[i - 1] - 1) * 100);
    return { n: g.length, mean: r2(mean(g)), dn2: r2(g.filter(x => x <= -2).length / (g.length || 1) * 100), allMean: r2(mean(all)), allDn2: r2(all.filter(x => x <= -2).length / all.length * 100) };
}

export function run(S, J, log = console.log) {
    const B = volBuckets(S.c), out = { from: S.d[0], to: S.d.at(-1), fxFrom: J.d[0], fxTo: J.d.at(-1), judged: {}, desc: {} };
    log(`💴 日圓急升 → 台股 ${S.d[0]} ~ ${S.d.at(-1)}・匯率 ${J.d[0]} ~ ${J.d.at(-1)}(美國聯準會 DEXJPUS,紐約中午)`);
    log(`主判:r 收盤之後 ${RULE.h} 天內曾經比 r 收盤低 ≥${RULE.dd}% 的比例,事件 vs 同一波動組的非事件日`);
    for (const [grp, list] of [['judged', JUDGED], ['desc', DESC]]) {
        for (const E of list) {
            const evs = events(S, J, E.kind, E.th);
            const row = { zh: E.zh, n: evs.length, gap: gapStats(S, evs), dd60: delta(S, B, evs, { h: RULE.h60, dd: RULE.dd60 }) };
            if (grp === 'judged') Object.assign(row, judge(S, B, evs)); else row.all = delta(S, B, evs);
            out[grp][E.id] = row;
            log(`\n${grp === 'judged' ? '⭐' : '・'} ${E.zh}:${evs.length} 次(10 天內只算一次)`);
            log(`  ${RULE.h} 天內跌 ≥${RULE.dd}%:事件 ${row.all.ev}% vs 同波動組平常 ${row.all.base}% → 差 ${row.all.delta}pp(n=${row.all.n})・之後 ${RULE.h} 天平均 ${row.all.ret}%`);
            log(`  ${RULE.h60} 天內跌 ≥${RULE.dd60}%:事件 ${row.dd60.ev}% vs 平常 ${row.dd60.base}% → 差 ${row.dd60.delta}pp`);
            log(`  隔天那一下(看得到之前就發生了):平均 ${row.gap.mean}%・跌 2% 以上 ${row.gap.dn2}%(全部日子 ${row.gap.allMean}% / ${row.gap.allDn2}%)`);
            if (grp === 'judged') log(`  兩段:2000~2012 ${row.a.delta}pp(n=${row.a.n})/ 2013~ ${row.b.delta}pp(n=${row.b.n})・拿掉 ${row.topYear} 年 ${row.noTop.delta}pp・安慰劑 p ${row.p} → ${row.pass.map(x => x ? '✓' : '✗').join('')} ${row.verdict}`);
            if (evs.length) log(`  最近 5 次:${evs.slice(-5).map(e => `${e.t}(${r2(e.chg)}%)→ ${S.d[e.r]}`).join('、')}`);
        }
    }
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // 合成:台股 3,000 個交易日(週一~五)、匯率同樣的日子;日圓隨機急升(約 60 天一次;⛔ 固定週期 —— 循環平移會剛好對齊)
    const days = []; for (let t = Date.UTC(2003, 0, 1); days.length < 3000; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) days.push(new Date(t).toISOString().slice(0, 10)); }
    const Rs = rng(17), surgeAt = days.map((_, i) => i > 300 && Rs() < 1 / 60);
    const R = rng(3), mk = (plant) => {
        const c = [100], fx = [110]; let left = 0;
        for (let i = 1; i < days.length; i++) {
            fx.push(fx[i - 1] * (surgeAt[i] ? 0.985 : 1 + (R() - 0.5) * 0.004));
            let ret = (R() - 0.5) * 0.02;
            if (plant && left > 0 && left <= 8) ret -= 0.012;             // 埋:看得到之後(r 隔天起)一直跌 8 天(⛔ 碰 r 當天)
            if (left > 0) left--;
            if (surgeAt[i]) left = 10;                                      // 匯率 i → r = i + 1;r+1 起 left 1~8 那幾天跌
            c.push(c[i - 1] * (1 + ret));
        }
        return { S: { d: days, c }, J: { d: days, v: fx } };
    };
    const P = mk(true), Z = mk(false);
    const eP = events(P.S, P.J, 1, -1.0);
    ok('① 事件:約 60 天一次、r = 匯率那天之後第一個台股日、10 天內只算一次', eP.length >= 30 && eP.every(e => P.S.d[e.r] > e.t && P.S.d[e.b0] <= e.t), eP.length);
    const a = alignR(['2024-08-01', '2024-08-02', '2024-08-05'], '2024-08-02');
    ok('① 週五的匯率 → 週一才看得到(b0 = 週五)', a.r === 2 && a.b0 === 1, JSON.stringify(a));
    const B = volBuckets(P.S.c);
    ok('② 波動分組只用之前的日子:前 270 天沒有分組、之後 0~4', B.slice(0, 270).every(x => x == null) && B.slice(300).every(x => x >= 0 && x <= 4));
    const B2 = volBuckets(P.S.c.map((x, i) => i > 2000 ? x * (1 + (i % 7) * 0.01) : x));
    ok('② ⛔ 前視:改掉第 2,000 天之後的價格,之前的分組一個都不變', B.slice(0, 2001).every((x, i) => x === B2[i]));
    const jP = judge(P.S, B, eP, { sims: 120 }), jZ = judge(Z.S, volBuckets(Z.S.c), events(Z.S, Z.J, 1, -1.0), { sims: 120 });
    ok('③ 埋了「之後一直跌」→ ✅(四條都過)', jP.verdict.startsWith('✅') && jP.pass.every(Boolean), JSON.stringify({ d: jP.all.delta, p: jP.p, pass: jP.pass }));
    ok('③ 決定性對照:同一份價格沒埋 → ⛔', jZ.verdict.startsWith('⛔'), JSON.stringify({ d: jZ.all.delta, p: jZ.p, pass: jZ.pass }));
    // ④ 只是「本來就顛」:事件只出現在高波動的時候、之後並沒有更顛 → 同波動組對手要把它抵掉
    const Rv = rng(9), c4 = [100], fx4 = [110];
    for (let i = 1; i < days.length; i++) {
        const hiVol = Math.floor(i / 250) % 2 === 1;
        c4.push(c4[i - 1] * (1 + (Rv() - 0.5) * (hiVol ? 0.08 : 0.01)));
        fx4.push(fx4[i - 1] * (hiVol && i % 40 === 5 ? 0.985 : 1 + (Rv() - 0.5) * 0.004));
    }
    const S4 = { d: days, c: c4 }, J4 = { d: days, v: fx4 }, B4 = volBuckets(c4), e4 = events(S4, J4, 1, -1.0);
    const allBase = (() => { let n = 0, k = 0; for (let i = 300; i < c4.length; i++) { const x = outcome(c4, i, 20, 5); if (x) { n++; k += x.hit; } } return k / n * 100; })();
    const d4 = delta(S4, B4, e4);
    ok('④ 只是本來就顛:跟「全部日子」比會看起來很顛,跟同一波動組比 ≈ 0', d4.ev - allBase >= 15 && Math.abs(d4.delta) < 6, JSON.stringify({ vsAll: r2(d4.ev - allBase), vsBucket: d4.delta }));
    // ⑤ ⛔ 前視:把事件之後的匯率改掉,事件清單不變
    const J5 = { d: P.J.d, v: P.J.v.map((x, i) => i > 1500 ? x * 1.3 : x) };
    const e5 = events(P.S, J5, 1, -1.0).filter(e => e.t <= P.J.d[1500]).map(e => e.r).join(), e5b = eP.filter(e => e.t <= P.J.d[1500]).map(e => e.r).join();
    ok('⑤ ⛔ 前視:改第 1,500 天之後的匯率,之前的事件一個都不變', e5 === e5b);
    // ⑥ 3 天變化、topYear、gapStats
    const ch3 = fxChg({ d: ['a', 'b', 'c', 'd'], v: [100, 101, 99, 98] }, 3);
    ok('⑥ 3 天變化 = 第 3 天 ÷ 第 0 天', Math.abs(ch3[3] + 2) < 1e-9 && ch3[2] == null, ch3[3]);
    ok('⑥ 事件最多那一年拿得到、拿掉它再算一次', typeof jP.topYear === 'string' && jP.noTop.n < jP.all.n);
    ok('⑥ loadJpy 只留正數、由舊到新', JSON.stringify(loadJpy({ series: { jpy: { d: { '2000-01-04': 103, '2000-01-03': 101.7, '2000-01-05': null } } } })) === JSON.stringify({ d: ['2000-01-03', '2000-01-04'], v: [101.7, 103] }));
    let threw = false; try { loadJpy({}); } catch (_) { threw = true; }
    ok('⑥ 沒有 series.jpy → 丟例外(⛔ 當成沒事件)', threw);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ YEN_SURGE_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('yen_surge_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(process.env);
    if (!process.env.FRED_HIST) throw new Error('FRED_HIST 沒給');
    const J = loadJpy(JSON.parse(fs.readFileSync(process.env.FRED_HIST, 'utf8')));
    const out = run(S, J);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
