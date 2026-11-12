#!/usr/bin/env node
/**
 * 📰 news_runup_probe.mjs —— 「消息出來之前股價已經先漲」之後怎麼走?(V82.2.0,使用者提案 Phase 0 E;EXP-20261112-04 事先登記)
 *
 * 事件:某一檔某個交易日「被報導的則數暴增」(news_factor.py 的 news_cnt.json:鉅亨台股新聞標題講到它幾則,
 *   新聞歸到「看得到它之後的第一個交易日」= 零前視)—— 當天 ≥3 則 且 ≥ 前 60 個交易日平均的 4 倍(平均最少算 0.25)。
 *   同一檔 20 個交易日內只算第一次;前 60 天要整段都「知道」(news_deep 那幾週有做完)。
 * 分組(只用消息出來「前一天」以前的收盤):先漲 = 前 20 天漲 ≥ +15%;沒先漲 = 前 20 天 −5% ~ +5%。
 * 結果:dispo_backtest.sampleEv —— 隔天開盤進、抱 5/10/20 天、扣同一天全部股票平均(⛔ 跟別天比)、開盤鎖漲停買不到不算、有斷崖不算。
 * 對照(baseline):⛔ 只看有新聞的 —— 全部股票、全部日子(每 5 天取一天)用同一套「先漲 / 沒先漲」分組,
 *   差多少就是「先漲本身」的效果(短線反轉 / 動能),新聞那組要比它多才算新聞的功勞。
 * 判定(judge,寫死):沒先漲 − 先漲 之後 20 天 ≥ +2pp 且 有 ≥15 筆的年份 ≥2/3 同向 且 年內打亂標籤 2000 次 p < 0.05
 *   且 比 baseline 多 ≥ 1.5pp → ✅ 先漲的之後比較差(利多出盡);其他 ⛔。只跑這一組門檻。
 *
 * 跑法:NEWS_CNT=news_cnt.json DATA_DIR=<d16> node --max-old-space-size=8000 scripts/news_runup_probe.mjs out.json
 *       node scripts/news_runup_probe.mjs --selftest
 */
import fs from 'fs';
import { loadK, buildCtrl, sampleEv, mkIndex } from './dispo_backtest.mjs';

export const RULE = { minCnt: 3, mult: 4, floor: 0.25, look: 60, dedup: 20, upPre: 15, flatLo: -5, flatHi: 5, pre: 20 };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);

/** news_cnt → [{sym, d}](只用 ≤ 當天的則數) */
export function events(nc, R = RULE) {
    const cal = nc.meta.cal, known = nc.meta.known, out = [];
    for (const [sym, rows] of Object.entries(nc.cnt || {})) {
        const by = new Map(rows.map(r => [r[0], r[1]]));
        let last = -1e9;
        for (const [i, c] of rows) {
            if (c < R.minCnt || i < R.look || i - last < R.dedup) continue;
            let ok = true, s = 0; for (let k = i - R.look; k < i; k++) { if (!known[k]) { ok = false; break; } s += by.get(k) || 0; }
            if (!ok || !known[i]) continue;
            if (c >= R.mult * Math.max(s / R.look, R.floor)) { out.push({ sym, d: cal[i] }); last = i; }
        }
    }
    return out;
}
/** K 線裡 d 那天(或之前最近一根)的前 20 天漲跌:收盤(d 的前一天)/ 收盤(再往前 20 天)− 1 */
export function preRun(K, d, n = RULE.pre) {
    let lo = 0, hi = K.n - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (K.dates[m] <= d) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i - 1 - n < 0) return null;
    return (K.c[i - 1] / K.c[i - 1 - n] - 1) * 100;
}
export const bucket = (p, R = RULE) => p == null ? null : p >= R.upPre ? 'up' : (p >= R.flatLo && p <= R.flatHi) ? 'flat' : null;

/** 判定:rows = [{y, b:'up'|'flat', x:20 天超額}];base = baseline 的 flat − up */
export function judge(rows, base, SIMS = 2000, seed = 17) {
    const U = rows.filter(r => r.b === 'up').map(r => r.x), F = rows.filter(r => r.b === 'flat').map(r => r.x);
    if (U.length < 30 || F.length < 30) return { verdict: '樣本不夠', nU: U.length, nF: F.length };
    const diff = mean(F) - mean(U);
    const yrs = {}; for (const r of rows) (yrs[r.y] ||= { up: [], flat: [] })[r.b].push(r.x);
    const yd = Object.entries(yrs).filter(([, v]) => v.up.length + v.flat.length >= 15 && v.up.length && v.flat.length).map(([y, v]) => [y, mean(v.flat) - mean(v.up)]);
    const same = yd.filter(([, v]) => Math.sign(v) === Math.sign(diff)).length;
    let s = seed; const R = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const groups = Object.values(yrs); let ge = 0;
    for (let k = 0; k < SIMS; k++) {
        let su = 0, nu = 0, sf = 0, nf = 0;
        for (const g of groups) { const all = [...g.up, ...g.flat], nUp = g.up.length;
            for (let a = all.length - 1; a > 0; a--) { const b = Math.floor(R() * (a + 1)); [all[a], all[b]] = [all[b], all[a]]; }
            all.forEach((x, j) => { if (j < nUp) { su += x; nu++; } else { sf += x; nf++; } }); }
        if (nu && nf && sf / nf - su / nu >= diff) ge++;
    }
    const p = (ge + 1) / (SIMS + 1);
    const okv = diff >= 2 && yd.length && same / yd.length >= 2 / 3 && p < 0.05 && base != null && diff - base >= 1.5;
    return { verdict: okv ? '✅ 消息出來前已先漲的,之後比較差(利多出盡)' : '⛔ 分不出來', diff: r2(diff), mU: r2(mean(U)), mF: r2(mean(F)), nU: U.length, nF: F.length,
        years: yd.map(([y, v]) => `${y}:${r2(v)}`), same, nY: yd.length, p: r2(p), base: r2(base), net: base == null ? null : r2(diff - base) };
}

/** baseline:全部股票、每 5 天一天,同一套分組的 20 天超額(扣同一天全部股票平均)→ flat − up */
export function baseline(dir, syms, ctrl, mktRet, cal, step = 5) {
    const U = [], F = [];
    for (const sym of syms) {
        const K = loadK(dir, sym); if (!K) continue;
        for (let k = 25; k < K.n - 21; k += step) {
            const b = bucket(preRun(K, K.dates[k])); if (!b) continue;
            const s = sampleEv(K, ctrl, mktRet, sym, K.dates[k]); if (s.skip || s.ex[20] == null) continue;
            (b === 'up' ? U : F).push(s.ex[20]);
        }
    }
    return { diff: mean(F) - mean(U), nU: U.length, nF: F.length, mU: mean(U), mF: mean(F) };
}

export function run(nc, dir, log = console.log) {
    const ev = events(nc);
    const tw = loadK(dir, '^TWII'); if (!tw) throw new Error('DATA_DIR 裡沒有 ^TWII.json');
    const mktRet = mkIndex({ dates: tw.dates, c: tw.c });
    const syms = fs.readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4));
    const ctrl = buildCtrl(dir, syms, mktRet);
    log(`📰 新聞暴增事件 ${ev.length} 筆(${nc.meta.from} ~ ${nc.meta.to});對照組 ${ctrl.nStock} 檔`);
    const bySym = new Map(); for (const e of ev) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e.d); }
    const rows = [], skip = {};
    for (const [sym, ds] of bySym) {
        const K = loadK(dir, sym); if (!K) { skip.nok = (skip.nok || 0) + ds.length; continue; }
        for (const d of ds) {
            const b = bucket(preRun(K, d)); if (!b) { skip.mid = (skip.mid || 0) + 1; continue; }
            const s = sampleEv(K, ctrl, mktRet, sym, d); if (s.skip) { skip[s.skip] = (skip[s.skip] || 0) + 1; continue; }
            if (s.ex[20] == null) { skip.h20 = (skip.h20 || 0) + 1; continue; }
            rows.push({ sym, d, y: d.slice(0, 4), b, x: s.ex[20], x5: s.ex[5], x10: s.ex[10] });
        }
    }
    log(`   進得了分組的 ${rows.length} 筆(先漲 ${rows.filter(r => r.b === 'up').length}、沒先漲 ${rows.filter(r => r.b === 'flat').length});跳過 ${JSON.stringify(skip)}`);
    for (const h of ['x5', 'x10', 'x']) { const U = rows.filter(r => r.b === 'up').map(r => r[h]).filter(x => x != null), F = rows.filter(r => r.b === 'flat').map(r => r[h]).filter(x => x != null);
        log(`   ${h === 'x' ? 20 : h.slice(1)} 天超額:先漲 ${r2(mean(U))}pp(${U.length})・沒先漲 ${r2(mean(F))}pp(${F.length})`); }
    const B = baseline(dir, syms, ctrl, mktRet);
    log(`   baseline(全部股票每 5 天):先漲 ${r2(B.mU)}pp(${B.nU})・沒先漲 ${r2(B.mF)}pp(${B.nF})→ 沒先漲 − 先漲 ${r2(B.diff)}pp`);
    const J = judge(rows, B.diff);
    log(`\n⭐ 事先登記的判定(EXP-20261112-04):沒先漲 − 先漲 之後 20 天 ${J.diff}pp(新聞)vs baseline ${J.base}pp → 多 ${J.net}pp・同向年份 ${J.same}/${J.nY}・p ${J.p} → ${J.verdict}`);
    log(`   逐年:${(J.years || []).join(' ')}`);
    return { n: ev.length, rows: rows.length, J, B: { diff: r2(B.diff), nU: B.nU, nF: B.nF } };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① 事件:前 60 天平均 0.5 則 → 當天 3 則不算(要 ≥ 2 → 4×0.5=2,3 ≥ 2 算)…用 1 則 / 天的那檔當對照
    const cal = Array.from({ length: 200 }, (_, i) => `2020-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`);
    const known = cal.map(() => 1);
    const quiet = [[150, 5]], busy = Array.from({ length: 150 }, (_, i) => [i, 2]).concat([[150, 5]]);
    const nc = { meta: { cal, known }, cnt: { A: quiet, B: busy, C: [[150, 2]], D: [[150, 5], [160, 6]] } };
    const ev = events(nc).map(e => e.sym + '@' + e.d);
    t(ev.includes('A@' + cal[150]) && !ev.some(x => x.startsWith('B@')) && !ev.some(x => x.startsWith('C@')) && ev.filter(x => x.startsWith('D@')).length === 1,
        `① 暴增:平常沒新聞突然 5 則算;平常每天 2 則的 5 則不算;2 則不算;20 天內第二次不算(${ev.join(' ')})`);
    // ② 前 60 天有不知道的那幾週 → 不算
    const k2 = known.slice(); k2[120] = 0;
    t(events({ meta: { cal, known: k2 }, cnt: { A: quiet } }).length === 0, '② 前 60 天有一天不知道(news_deep 那週沒做完)→ 不算(⛔ 當成 0 則)');
    // ③ 前 20 天漲跌只用消息出來前一天以前(改掉當天收盤不變)
    const K = { n: 60, dates: Array.from({ length: 60 }, (_, i) => cal[i]), c: Float64Array.from({ length: 60 }, (_, i) => 100 + i) };
    const p1 = preRun(K, cal[40]); const K2 = { ...K, c: Float64Array.from(K.c) }; K2.c[40] = 999;
    t(Math.abs(p1 - ((139 / 119 - 1) * 100)) < 1e-9 && preRun(K2, cal[40]) === p1, `③ 前 20 天漲跌 = 前一天收盤 / 再往前 20 天(${r2(p1)}%;改當天收盤不變)`);
    t(bucket(16) === 'up' && bucket(3) === 'flat' && bucket(10) === null && bucket(-7) === null, '④ 分組:≥15 先漲、−5~5 沒先漲、其他不算');
    // ⑤ 判定:決定性對照(兩組同分布)→ ⛔;⑥ 注入先漲 −4pp、baseline 0 → ✅;⑦ baseline 也 4pp(先漲本身的反轉)→ ⛔
    let s = 3; const Rr = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const mk = bump => { const rows = []; for (let y = 2016; y < 2026; y++) for (let k = 0; k < 40; k++) { const up = k < 15; rows.push({ y: String(y), b: up ? 'up' : 'flat', x: (Rr() - 0.5) * 12 - (up ? bump : 0) }); } return rows; };
    const J0 = judge(mk(0), 0), J1 = judge(mk(4), 0), J2 = judge(mk(4), 4);
    t(J0.verdict.startsWith('⛔'), `⑤ 決定性對照:兩組一樣 → ${J0.verdict}(差 ${J0.diff}pp、p ${J0.p})`);
    t(J1.verdict.startsWith('✅'), `⑥ 注入先漲之後 −4pp → ${J1.verdict.slice(0, 2)}(差 ${J1.diff}pp、p ${J1.p})`);
    t(J2.verdict.startsWith('⛔'), `⑦ baseline 也差 4pp(先漲本身就會回檔)→ ⛔(多 ${J2.net}pp)`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('news_runup_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const nc = JSON.parse(fs.readFileSync(process.env.NEWS_CNT, 'utf8'));
    const out = run(nc, process.env.DATA_DIR);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
