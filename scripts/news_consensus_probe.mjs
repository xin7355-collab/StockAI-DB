#!/usr/bin/env node
/**
 * 🗣️ V82.7.4 新聞熱度 × 看好÷看壞 —— 評估紀錄 58(Chris Camillo「社會套利」逐字稿)的台股版
 *    研究用:⛔ 不改 App、⛔ 不改採礦。
 *
 * 使用者 11/27 上傳 YouTube 逐字稿,問「能不能改成可以用的策略」。影片裡能在台股測的兩條:
 *   H1 討論變多 = 有人開始注意 → 之後會漲?(TikTok 留言台股沒有歷史 → 用「新聞暴增」代替)
 *   H2 「看好 ÷ 看壞 < 2 = 市場還沒跟上;≥ 2 = 大家都知道了」
 *      → 新聞暴增那天往前 20 個交易日(含當天),這檔標題的看好 / 看壞比例
 * 事先登記(判準跑之前寫死,下面 RULE / judgeH1 / verdictH2 就是那一份;⛔ 跑完再改)。
 *
 * 沿用(⛔ 另寫一套):
 *   news_runup_probe.mjs  events(暴增 = 當天 ≥3 則、≥ 前 60 天平均 4 倍、同一檔 20 天只算一次)
 *                         judge(兩組差 + 逐年同向 + 年內打亂 p + 比 baseline 多)
 *   dispo_backtest.mjs    loadK / buildCtrl / sampleEv(隔天開盤進、扣同一天全部股票平均、鎖漲停 / 斷崖不算)
 *   news_factor.py        tone(字表 scripts/news_tone_words.json,⛔ AI 判;同一則 / 同標題只算一次)
 * 封存:事件日與 20 天出場那根都要 ≤ 2026-11-06(LAB oos-seal:之後的資料只拿來驗、⛔ 拿來判)。
 * 已知的不利證據(登記時就寫了):EXP-20261112-04 新聞暴增前已先漲的,之後反而比較好(跟 H2 方向相反)。
 *
 * 跑法:NEWS_CNT=news_cnt.json DATA_DIR=<d16> node scripts/news_consensus_probe.mjs [out.json]
 *       node scripts/news_consensus_probe.mjs --selftest        (INJECT=1 再把四種注入各跑一次,全部要紅)
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadK, buildCtrl, sampleEv, mkIndex } from './dispo_backtest.mjs';
import { events, judge } from './news_runup_probe.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const INJ = process.env._NC_INJ || '';   // selftest 注入用:look / minTone / seal / swap

export const RULE = {
    seal: INJ === 'seal' ? '9999-12-31' : '2026-11-06',   // LAB oos-seal
    h: 20,                // 看 20 天超額
    win: 20,              // 看好 / 看壞的窗口:事件那天往前 20 個交易日(含當天)
    minTone: INJ === 'minTone' ? 0 : 3,   // 看好 + 看壞 ≥ 3 篇才算比例
    cut: 2,               // 影片那條:看好 ÷ 看壞 < 2 = 市場還沒跟上
    plateau: [1.5, 3],    // 門檻左右各挪一格,lo − hi 都要 > 0
    h1Min: 1,             // H1 平均 ≥ +1pp(高於來回成本 0.44%)
    h1Net: 1,             // H1 比安慰劑多 ≥ 1pp
    plcLo: 40, plcHi: 120, plcK: 20,   // 安慰劑:同一檔挪 40~120 個交易日(往前或往後),每筆 20 次
    yrMin: 30,            // H1 逐年:那年 ≥ 30 筆才算
    nMin: 300,            // H1 至少 300 筆
    step: 5,              // H2 baseline:全部股票每 5 個交易日抽一天
    seed: 20261127,
};
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);
const lcg = seed => { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };

/** K 線最後一根 ≤ d 的索引(找不到 −1) */
export function lastLE(K, d) { let lo = 0, hi = K.n - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (K.dates[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; }

/** 封存:事件日 ≤ seal,而且 20 天出場那根(隔天進場 + h 天)也 ≤ seal */
export function sealOK(K, d, R = RULE) {
    if (d > R.seal) return false;
    const i = lastLE(K, d); if (i < 0) return false;
    const j = i + 1 + R.h;
    return j < K.n && K.dates[j] <= R.seal;
}

/** news_cnt.tone → Map(代號 → Map(交易日索引 → [看好, 看壞])) */
export function toneIndex(nc) {
    const out = new Map();
    for (const [sym, rows] of Object.entries(nc.tone || {})) out.set(sym, new Map(rows.map(r => [r[0], [r[1], r[2]]])));
    return out;
}

/** 窗口 [i − win + 1, i](含當天、⛔ 隔天)的看好 P / 看壞 N;窗口裡有一天不知道(news_deep 那週沒做完)→ null(⛔ 當 0) */
export function toneWin(tm, known, i, R = RULE) {
    if (i == null) return null;
    const lo = i - R.win + 1, hi = INJ === 'look' ? i + 1 : i;
    if (lo < 0 || hi >= known.length) return null;
    let P = 0, N = 0;
    for (let k = lo; k <= hi; k++) { if (!known[k]) return null; const v = tm && tm.get(k); if (v) { P += v[0]; N += v[1]; } }
    return { P, N };
}

/** 分組:看好 + 看壞 < minTone → null;看壞 0 篇 → hi(大家都看好);看好 ÷ 看壞 < cut → lo(還沒人人看好) */
export function group(t, cut = RULE.cut, R = RULE) {
    if (!t || t.P + t.N === 0 || t.P + t.N < R.minTone) return null;
    const r = t.N === 0 ? Infinity : t.P / t.N;
    return r < cut ? 'lo' : 'hi';
}

/** 借 news_runup 的 judge:lo(影片說會比較好)= 'flat'、hi = 'up' → judge 的 diff = lo − hi */
export const LAB_OF = INJ === 'swap' ? { lo: 'up', hi: 'flat' } : { lo: 'flat', hi: 'up' };

/** 一檔的事件 → 樣本列。sample(K, sym, d) → {x20, x5, x10} 或 null(正式 = sampleEv;selftest 換假的) */
export function stockRows(sym, K, ds, ctx, sample, R = RULE) {
    const rows = [], skip = {};
    const sk = k => { skip[k] = (skip[k] || 0) + 1; };
    for (const d of ds) {
        if (!sealOK(K, d, R)) { sk('seal'); continue; }
        const x = sample(K, sym, d); if (x == null) { sk('ret'); continue; }
        const t = toneWin(ctx.TI.get(sym), ctx.known, ctx.calIdx.get(d), R);
        rows.push({ sym, d, y: d.slice(0, 4), x: x.x20, x5: x.x5, x10: x.x10, t, g: group(t, R.cut, R) });
    }
    return { rows, skip };
}

/** H1 安慰劑:同一檔、日期往前或往後挪 40~120 個交易日,每筆 plcK 次 */
export function stockPlacebo(sym, K, ds, sample, rnd, R = RULE) {
    const xs = [];
    for (const d of ds) {
        const i = lastLE(K, d); if (i < 0) continue;
        for (let k = 0; k < R.plcK; k++) {
            const off = (R.plcLo + Math.floor(rnd() * (R.plcHi - R.plcLo + 1))) * (rnd() < 0.5 ? -1 : 1);
            const j = i + off; if (j < 25 || j >= K.n - 1) continue;
            const dj = K.dates[j]; if (!sealOK(K, dj, R)) continue;
            const x = sample(K, sym, dj); if (x != null) xs.push(x.x20);
        }
    }
    return xs;
}

/** H2 baseline:全部股票每 step 個交易日抽一天,同一套看好 / 看壞分組(問:效果是不是新聞暴增那天才有) */
export function stockBase(sym, K, ctx, sample, R = RULE) {
    const out = [];
    for (let k = 25; k < K.n - 22; k += R.step) {
        const d = K.dates[k];
        const g = group(toneWin(ctx.TI.get(sym), ctx.known, ctx.calIdx.get(d), R), R.cut, R); if (!g) continue;
        if (!sealOK(K, d, R)) continue;
        const x = sample(K, sym, d); if (x != null) out.push({ g, x: x.x20 });
    }
    return out;
}

/** H1 判定(事先寫死):平均 ≥ +1pp、前後兩半都 > 0、逐年(≥30 筆)為正 ≥ 2/3、比安慰劑多 ≥ 1pp */
export function judgeH1(rows, plc, R = RULE) {
    const xs = rows.map(r => r.x); if (xs.length < R.nMin) return { verdict: '⛔ 樣本不夠', n: xs.length };
    const m = mean(xs);
    const srt = rows.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const h = Math.floor(srt.length / 2), m1 = mean(srt.slice(0, h).map(r => r.x)), m2 = mean(srt.slice(h).map(r => r.x));
    const yrs = {}; for (const r of rows) (yrs[r.y] ||= []).push(r.x);
    const yd = Object.entries(yrs).filter(([, v]) => v.length >= R.yrMin).sort().map(([y, v]) => [y, mean(v)]);
    const pos = yd.filter(([, v]) => v > 0).length;
    const net = plc == null ? null : m - plc;
    const ok = m >= R.h1Min && m1 > 0 && m2 > 0 && yd.length > 0 && pos / yd.length >= 2 / 3 && net != null && net >= R.h1Net;
    return { verdict: ok ? '✅ 新聞暴增之後 20 天比較會漲(而且不是那檔本來就會漲)' : '⛔ 分不出來', n: xs.length, mean: r2(m), m1: r2(m1), m2: r2(m2),
        pos, nY: yd.length, years: yd.map(([y, v]) => `${y}:${r2(v)}`), plc: r2(plc), net: r2(net) };
}

/** 門檻高原:同一批事件換門檻 1.5 / 3 重新分組,lo − hi */
export function plateau(rows, R = RULE) {
    return R.plateau.map(c => {
        const L = [], H = [];
        for (const r of rows) { const g = group(r.t, c, R); if (g === 'lo') L.push(r.x); else if (g === 'hi') H.push(r.x); }
        return { cut: c, nL: L.length, nH: H.length, diff: L.length && H.length ? r2(mean(L) - mean(H)) : null };
    });
}

/** H2 最後判定:judge ✅(差 ≥2pp、≥2/3 年同向、p<0.05、比 baseline 多 ≥1.5pp)而且門檻 1.5 / 3 都 lo > hi */
export function verdictH2(J, P) {
    const ok = !!(J && String(J.verdict).startsWith('✅')) && P.length > 0 && P.every(p => p.diff != null && p.diff > 0);
    return ok ? '✅ 看好÷看壞 < 2(還沒人人看好)的新聞暴增,之後比較好' : '⛔ 分不出來';
}

export function mkCtx(nc) { return { calIdx: new Map(nc.meta.cal.map((d, i) => [d, i])), known: nc.meta.known, TI: toneIndex(nc) }; }

export function run(nc, dir, log = console.log, R = RULE) {
    const evs = events(nc);
    const tw = loadK(dir, '^TWII'); if (!tw) throw new Error('DATA_DIR 裡沒有 ^TWII.json');
    const mktRet = mkIndex({ dates: tw.dates, c: tw.c });
    const syms = fs.readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4));
    const ctrl = buildCtrl(dir, syms, mktRet);
    const sample = (K, sym, d) => { const s = sampleEv(K, ctrl, mktRet, sym, d); return s.skip || s.ex[20] == null ? null : { x20: s.ex[20], x5: s.ex[5], x10: s.ex[10] }; };
    const ctx = mkCtx(nc), rnd = lcg(R.seed);
    log(`📰 新聞暴增事件 ${evs.length} 筆(新聞 ${nc.meta.from} ~ ${nc.meta.to});對照組 ${ctrl.nStock} 檔;封存日 ${R.seal}`);
    log(`   看好 / 看壞字表 ${JSON.stringify(nc.meta.tone_words || null)}(scripts/news_tone_words.json)・有看好或看壞標題的股票 ${ctx.TI.size} 檔`);
    const bySym = new Map(); for (const e of evs) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e.d); }
    const rows = [], plcX = [], skip = {};
    for (const [sym, ds] of bySym) {
        const K = loadK(dir, sym); if (!K) { skip.nok = (skip.nok || 0) + ds.length; continue; }
        const r = stockRows(sym, K, ds, ctx, sample, R);
        rows.push(...r.rows); for (const [k, v] of Object.entries(r.skip)) skip[k] = (skip[k] || 0) + v;
        plcX.push(...stockPlacebo(sym, K, ds, sample, rnd, R));
    }
    const base = { lo: [], hi: [] };
    for (const sym of syms) { const K = loadK(dir, sym); if (!K) continue; for (const b of stockBase(sym, K, ctx, sample, R)) base[b.g].push(b.x); }

    // ── H1 ──
    const plc = mean(plcX), J1 = judgeH1(rows, plc, R);
    log(`\n🅷1 新聞暴增之後 20 天超額(扣同一天全部股票):${rows.length} 筆;跳過 ${JSON.stringify(skip)}`);
    for (const h of ['x5', 'x10', 'x']) { const v = rows.map(r => r[h]).filter(x => x != null); log(`   ${h === 'x' ? 20 : h.slice(1)} 天:平均 ${r2(mean(v))}pp(${v.length})`); }
    log(`   安慰劑(同一檔挪 ${R.plcLo}~${R.plcHi} 個交易日,${plcX.length} 筆):${r2(plc)}pp`);
    log(`   ⭐ 判定:平均 ${J1.mean}pp・前後兩半 ${J1.m1} / ${J1.m2}・逐年為正 ${J1.pos}/${J1.nY}・比安慰劑多 ${J1.net}pp → ${J1.verdict}`);
    log(`   逐年:${(J1.years || []).join(' ')}`);

    // ── H2 ──
    const gr = rows.filter(r => r.g);
    const lo = gr.filter(r => r.g === 'lo'), hi = gr.filter(r => r.g === 'hi');
    const baseDiff = base.lo.length && base.hi.length ? mean(base.lo) - mean(base.hi) : null;
    const J2 = judge(gr.map(r => ({ y: r.y, b: LAB_OF[r.g], x: r.x })), baseDiff, 2000, 17, '✅ 看好÷看壞 < 2 的比較好');
    const P = plateau(gr, R), V2 = verdictH2(J2, P);
    log(`\n🅷2 看好 ÷ 看壞(暴增那天往前 ${R.win} 個交易日、看好 + 看壞 ≥ ${R.minTone} 篇):算得出比例的 ${gr.length} 筆(< ${R.cut} 還沒人人看好 ${lo.length}・≥ ${R.cut} 大家都看好 ${hi.length});算不出來 ${rows.length - gr.length} 筆`);
    for (const h of ['x5', 'x10', 'x']) { const a = lo.map(r => r[h]).filter(x => x != null), b = hi.map(r => r[h]).filter(x => x != null); log(`   ${h === 'x' ? 20 : h.slice(1)} 天:< ${R.cut} ${r2(mean(a))}pp(${a.length})・≥ ${R.cut} ${r2(mean(b))}pp(${b.length})`); }
    log(`   baseline(全部股票每 ${R.step} 天、同一套分組):< ${R.cut} ${r2(mean(base.lo))}pp(${base.lo.length})・≥ ${R.cut} ${r2(mean(base.hi))}pp(${base.hi.length})→ 差 ${r2(baseDiff)}pp`);
    log(`   門檻高原:${P.map(p => `${p.cut} → ${p.diff}pp(${p.nL} / ${p.nH})`).join('・')}`);
    log(`   ⭐ 判定:< ${R.cut} − ≥ ${R.cut} = ${J2.diff}pp・同向年份 ${J2.same}/${J2.nY}・p ${J2.p}・比 baseline 多 ${J2.net}pp・高原 ${P.map(p => p.diff).join(' / ')} → ${V2}`);
    log(`   逐年:${(J2.years || []).join(' ')}`);
    return {
        rule: R, nEvents: evs.length, range: [nc.meta.from, nc.meta.to], skip,
        H1: { ...J1, x5: r2(mean(rows.map(r => r.x5).filter(x => x != null))), x10: r2(mean(rows.map(r => r.x10).filter(x => x != null))), nPlc: plcX.length },
        H2: { verdict: V2, J: J2, plateau: P, nLo: lo.length, nHi: hi.length, nNa: rows.length - gr.length,
            base: { lo: r2(mean(base.lo)), hi: r2(mean(base.hi)), nLo: base.lo.length, nHi: base.hi.length, diff: r2(baseDiff) } },
    };
}

// ─────────────────────────── selftest ───────────────────────────
function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const day = i => new Date(Date.UTC(2016, 0, 4) + i * 86400000).toISOString().slice(0, 10);
    const cal = Array.from({ length: 400 }, (_, i) => day(i)), known = cal.map(() => 1);
    const K0 = { n: cal.length, dates: cal };

    // ① 窗口含當天、⛔ 含隔天(零前視)
    const tm = new Map([[100, [1, 1]], [101, [10, 0]], [81, [1, 0]], [80, [9, 9]]]);
    const w = toneWin(tm, known, 100);
    t(w && w.P === 2 && w.N === 1, `① 窗口 = 往前 20 個交易日含當天(第 81~100 天:看好 2、看壞 1);隔天那 10 篇看好 ⛔ 算、第 80 天 ⛔ 算(${JSON.stringify(w)})`);
    // ② 分組
    t(group({ P: 1, N: 0 }) === null && group({ P: 2, N: 0 }) === null, '② 看好 + 看壞 < 3 篇 → 不算比例(⛔ 1 篇看好就當「大家都看好」)');
    t(group({ P: 3, N: 0 }) === 'hi' && group({ P: 0, N: 3 }) === 'lo', '② 看壞 0 篇 → 大家都看好(≥2);看好 0 篇 → 還沒人人看好');
    t(group({ P: 3, N: 2 }) === 'lo' && group({ P: 4, N: 2 }) === 'hi', '② 邊界:1.5 → < 2;剛好 2 → ≥ 2(大家都知道了)');
    // ③ 不知道 ≠ 0
    const k3 = known.slice(); k3[90] = 0;
    t(toneWin(tm, k3, 100) === null && toneWin(tm, known, 10) === null, '③ 窗口裡有一天不知道 / 窗口不夠長 → null(⛔ 當成 0 篇)');
    // ④ 封存
    const sc = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 8, 1) + i * 86400000).toISOString().slice(0, 10));
    const Ks = { n: sc.length, dates: sc };
    t(sealOK(Ks, '2026-09-15') === true && sealOK(Ks, '2026-10-20') === false && sealOK(Ks, '2026-11-10') === false,
        '④ 封存:09/15 那筆 20 天後還在 11/06 以前 → 算;10/20 那筆出場日跨過 11/06 → ⛔;11/10 → ⛔');

    // ⑤ H1 判定
    const R5 = lcg(5);
    const mk1 = (bump, f = () => 0) => { const rows = []; for (let y = 2016; y < 2026; y++) for (let k = 0; k < 60; k++) { const d = `${y}-0${1 + (k % 9)}-1${k % 10}`; rows.push({ y: String(y), d, x: (R5() - 0.5) * 10 + bump + f(y) }); } return rows; };
    const H0 = judgeH1(mk1(0), 0), H1 = judgeH1(mk1(3), 0), H2 = judgeH1(mk1(3), 3), H3 = judgeH1(mk1(3, y => (y < 2021 ? -5 : 5)), 0);
    t(H0.verdict.startsWith('⛔'), `⑤ 決定性對照:沒有效果 → ${H0.verdict}(平均 ${H0.mean})`);
    t(H1.verdict.startsWith('✅'), `⑤ 注入 +3pp、安慰劑 0 → ✅(平均 ${H1.mean}、多 ${H1.net})`);
    t(H2.verdict.startsWith('⛔'), `⑤ 安慰劑也 +3pp(那檔本來就會漲)→ ⛔(多 ${H2.net})`);
    t(H3.verdict.startsWith('⛔'), `⑤ 前半段 −2、後半段 +8(只有後來有用)→ ⛔(兩半 ${H3.m1} / ${H3.m2})`);

    // ⑥ H2 從頭走一遍(stockRows → judge → verdictH2):lo 那幾檔 20 天多 +4pp → ✅;看好看壞對調 → 判定要翻
    const R6 = lcg(11);
    const mkNc = flip => {
        const tone = {}, ev = [];
        for (let s = 0; s < 40; s++) {
            const sym = String(1000 + s), loS = s % 2 === 0;
            const P = loS ? 1 : 3, N = loS ? 3 : 1;   // lo:看好 1 / 看壞 3(0.33);hi:3 / 1(3)
            const rowsT = [];
            for (let e = 30; e < 380; e += 25) { rowsT.push([e, flip ? N : P, flip ? P : N]); ev.push({ sym, d: cal[e], i: e }); }
            tone[sym] = rowsT;
        }
        return { nc: { meta: { cal, known }, tone }, ev };
    };
    const fake = loSet => (K, sym, d) => ({ x20: (R6() - 0.5) * 8 + (loSet.has(sym) ? 4 : 0), x5: 0, x10: 0 });
    const loSet = new Set(Array.from({ length: 40 }, (_, s) => s).filter(s => s % 2 === 0).map(s => String(1000 + s)));
    const flow = flip => {
        const { nc, ev } = mkNc(flip), ctx = mkCtx(nc), rows = [];
        const by = new Map(); for (const e of ev) { if (!by.has(e.sym)) by.set(e.sym, []); by.get(e.sym).push(e.d); }
        for (const [sym, ds] of by) rows.push(...stockRows(sym, K0, ds, ctx, fake(loSet), { ...RULE, seal: '9999-12-31' }).rows);
        const gr = rows.filter(r => r.g);
        const J = judge(gr.map(r => ({ y: r.y, b: LAB_OF[r.g], x: r.x })), 0, 500, 17, '✅');
        return { J, P: plateau(gr), V: verdictH2(J, plateau(gr)), n: gr.length };
    };
    const F0 = flow(false), F1 = flow(true);
    t(F0.V.startsWith('✅'), `⑥ 看好÷看壞 < 2 那幾檔多 +4pp → ${F0.V.slice(0, 2)}(差 ${F0.J.diff}pp、p ${F0.J.p}、${F0.n} 筆)`);
    t(F1.V.startsWith('⛔') && F1.J.diff < 0, `⑥ ⭐ 決定性對照:同一組報酬、看好看壞對調 → 判定翻成 ⛔(差 ${F1.J.diff}pp)`);
    // ⑦ 門檻高原:門檻 2 過、1.5 反過來 → ⛔
    const rr = [];
    for (let k = 0; k < 60; k++) { rr.push({ t: { P: 2, N: 2 }, x: 0 }); rr.push({ t: { P: 3.6, N: 2 }, x: 6 }); rr.push({ t: { P: 8, N: 2 }, x: 0 }); }
    const P7 = plateau(rr), Jok = { verdict: '✅ 假裝 judge 過了' };
    t(P7[0].diff < 0 && P7[1].diff > 0 && verdictH2(Jok, P7).startsWith('⛔'), `⑦ 門檻 1.5 那格反過來(${P7.map(p => p.diff).join(' / ')})→ 就算 judge 過也 ⛔(孤峰)`);
    // ⑧ 字表只有一份
    const nep = fs.readFileSync(path.join(ROOT, 'scripts/news_event_probe.mjs'), 'utf8'), nf = fs.readFileSync(path.join(ROOT, 'scripts/news_factor.py'), 'utf8');
    const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/news_tone_words.json'), 'utf8'));
    t(nep.includes('news_tone_words.json') && !/const POS = \[/.test(nep) && nf.includes('news_tone_words.json'), '⑧ 看好 / 看壞字表只有一份(news_event_probe / news_factor 都讀 scripts/news_tone_words.json,⛔ 再抄一份)');
    t(W.pos.length >= 10 && W.neg.length >= 10 && !W.pos.some(x => W.neg.includes(x)), `⑧ 字表兩邊都有詞、沒有同一個詞兩邊都算(${W.pos.length} / ${W.neg.length})`);

    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}${INJ ? `(注入 ${INJ})` : ''}`);
    if (!INJ && process.env.INJECT) {
        let allRed = true;
        for (const k of ['look', 'minTone', 'seal', 'swap']) {
            let red = false;
            try { execFileSync(process.execPath, [HERE, '--selftest'], { env: { ...process.env, INJECT: '', _NC_INJ: k }, stdio: 'pipe' }); } catch (_) { red = true; }
            console.log(`  ${red ? '✅' : '❌'} 注入 ${k} → ${red ? '紅' : '⛔ 沒有紅(測試沒有鑑別力)'}`);
            if (!red) allRed = false;
        }
        console.log(allRed ? '✅ 🧪 四種注入全部叫得出來' : '❌ 有注入沒被抓到');
        if (!allRed) bad++;
    }
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('news_consensus_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    if (!process.env.NEWS_CNT || !process.env.DATA_DIR) { console.error('用法:NEWS_CNT=news_cnt.json DATA_DIR=<d16> node scripts/news_consensus_probe.mjs [out.json]'); process.exit(1); }
    const nc = JSON.parse(fs.readFileSync(process.env.NEWS_CNT, 'utf8'));
    if (!nc.tone) { console.error('❌ news_cnt 沒有 tone(用 V82.7.4 以後的 news_factor.py 重跑)'); process.exit(1); }
    const out = run(nc, process.env.DATA_DIR);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
