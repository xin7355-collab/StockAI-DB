#!/usr/bin/env node
/**
 * ✂️ V82.0.7 每晚算「👑 跌 20% 收一半」現在是什麼狀態 → data/lead_dd.json
 *   App / 自動下單 / Telegram 只讀這一份(⛔ 各自再算一份 —— 邏輯會打架)。
 *
 * 看的是「完全照 👑 這套做」的那一份帳(模型帳,⛔ 不是使用者自己的帳戶):
 *   ・同一個回測引擎(leader_probe simulate,看板 👑 那一套 + 跌停賣不掉隔天再賣)、100 萬
 *   ・起點固定 = LEAD_DD.from 之後第一個換倉決策日(跟甲帳錨點對齊 → 模型的換倉日 == 真的換倉日)
 *     ⛔ 不用「資料最早那天 + 暖身」:網站上的 K 線最多 1,200 根、之後會往前滾 → 起點每天變 = 每天重算成不同的路徑
 *   ・lib_leaddd.ddSeries:從最高點跌 ≥20% → 一半;回到最高點 → 全部
 *
 * 輸出(⛔ 改格式要一起改 App _loadLeadDd / auto_trade _lead_dd_target / worker leadDdPlan):
 *   {v:1, updated, data_date, partial, rule, model, peak{d,v}, now{d,v,dd}, def, since, w,
 *    rot:[{d, b:'A'|'B', W 想要的, wa 實際用的, bear}](每本帳最近 6 次換倉), s:[[d, 淨值, def]](最近 120 個交易日)}
 *
 * 守門(exit 1,⛔ 寫檔 —— 線上留舊的):個股檔 < 500 / 引擎讀到 < 1000 檔 / 讀不到 lib_leader.py / 引擎預設跟 LEADER_RULE 對不上 /
 *   錨點不在日曆裡 / 暖身不夠 / 淨值有壞值 / 最後一天有成交的不到 500 檔
 *
 * 用法:node scripts/lead_dd_state.mjs [data] [data/lead_dd.json]・node scripts/lead_dd_state.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { LEAD_DD, LEAD_DD_MODEL, ddSeries, waChain } from './lib_leaddd.mjs';

const KEEP_ROT = 6, KEEP_S = 120, WARM = 252, MIN_STOCKS = 500;

/** 讀 lib_leader.py 的 LEADER_RULE / 兩個錨點(⛔ 這裡不再抄一份錨點) */
export function readLeaderPy(src) {
    const m1 = src.match(/^LEADER_RULE\s*=\s*\{([^}]*)\}/m), a1 = src.match(/^LEADER_ANCHOR\s*=\s*'(\d{4}-\d{2}-\d{2})'/m), a2 = src.match(/^LEADER_ANCHOR2\s*=\s*'(\d{4}-\d{2}-\d{2})'/m);
    if (!m1 || !a1 || !a2) return null;
    const rule = {};
    for (const kv of m1[1].split(',')) { const m = kv.match(/'(\w+)'\s*:\s*(\d+)/); if (m) rule[m[1]] = +m[2]; }
    return { rule, anchors: [a1[1], a2[1]] };
}

/** 引擎預設 == LEADER_RULE(U / N / R / L / hyst / 一年位置)—— 對不上回差在哪 */
export function ruleDrift(DEF, rule) {
    const pairs = [['U', 'U'], ['N', 'N'], ['R', 'R'], ['L', 'L'], ['hyst', 'hyst'], ['posMin', 'pos']];
    return pairs.filter(([a, b]) => DEF[a] !== rule[b]).map(([a, b]) => `${a}=${DEF[a]} vs ${b}=${rule[b]}`);
}

/** 起點:LEAD_DD.from 之後、跟錨點同一個換倉節奏的第一天(⛔ 早於 from) */
export function alignStart(cal, anchor, from, R) {
    const A = cal.indexOf(anchor), F = cal.findIndex(d => d >= from);
    if (A < 0) throw new Error(`錨點 ${anchor} 不在日曆裡`);
    if (F < 0) throw new Error(`日曆裡沒有 ${from} 之後的日子`);
    if (F > A) throw new Error(`起點 ${from} 晚於錨點 ${anchor}`);
    return A - R * Math.floor((A - F) / R);
}

/** 台北時間;今天那一根 14:30 以前還沒收完 → 不算 */
export function tpeNow(now = new Date()) {
    const t = new Date(now.getTime() + 8 * 3600e3);
    return { d: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
export function pickLast(cal, now = new Date()) {
    const T = tpeNow(now), n = cal.length;
    return cal[n - 1] === T.d && T.min < 14 * 60 + 30 ? { last: n - 2, partial: 1 } : { last: n - 1, partial: 0 };
}

/** 主計算(純函式;main 只負責讀寫檔)。opt:{simulate, rule, model, anchors, R, last, partial, prev, now, warm, minStocks} */
export function buildState(ctx, opt) {
    const rule = opt.rule || LEAD_DD, model = opt.model || LEAD_DD_MODEL, R = opt.R || 10, warm = opt.warm ?? WARM, minStocks = opt.minStocks ?? MIN_STOCKS;
    const { cal } = ctx, n = cal.length, last = opt.last ?? n - 1, warn = [];
    let s0 = alignStart(cal, opt.anchors[0], rule.from, R);
    let first = -1;
    for (let i = 0; i < n && first < 0; i++) { let c = 0; for (const S of ctx.stocks) { if (S.C[i] > 0 && ++c >= minStocks) { first = i; break; } } }
    if (first < 0) throw new Error(`沒有任何一天有 ≥${minStocks} 檔有成交`);
    let slid = 0; while (s0 - first < warm) { s0 += R; slid++; }
    if (slid) warn.push(`起點往後挪了 ${slid} 次換倉(暖身要 ${warm} 天)→ 模型帳從 ${cal[s0]} 起`);
    if (s0 > last - 20) throw new Error(`暖身之後剩不到 20 天(起點 ${cal[s0]}、最後 ${cal[last]})`);
    let liveN = 0; for (const S of ctx.stocks) if (S.C[last] > 0) liveN++;
    if (liveN < minStocks) throw new Error(`最後一天 ${cal[last]} 有成交的只有 ${liveN} 檔(< ${minStocks})`);
    const r = opt.simulate(ctx, s0, { ...model, endIdx: last }, 1000);
    if (!r.eq.length || !r.eq.every(v => Number.isFinite(v) && v > 0)) throw new Error('模型帳淨值有壞值');
    const ser = ddSeries(r.eq, rule), t = r.eq.length - 1;
    if (s0 + t !== last) throw new Error(`淨值長度 ${r.eq.length} 對不上(起點 ${s0}、最後 ${last})`);
    // 換倉:每本帳從自己的錨點往後每 R 天(⛔ 不往前:錨點以前還沒有這一本)
    let rots = [];
    opt.anchors.forEach((a, bi) => {
        const ia = cal.indexOf(a); if (ia < 0) { warn.push(`錨點 ${a} 不在日曆裡 → 這本帳不列`); return; }
        for (let k = ia; k <= last; k += R) if (k >= s0) rots.push({ d: cal[k], b: bi === 0 ? 'A' : 'B', W: ser.w[k - s0], bear: ctx.bear[k] ? 1 : 0 });
    });
    rots.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
    rots = waChain(rots, rule, rule.live);
    const keep = [];
    for (const b of ['A', 'B']) keep.push(...rots.filter(x => x.b === b).slice(-KEEP_ROT));
    keep.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
    // 最高點那天 / 這一段一半從哪天開始
    let pkI = t; while (pkI > 0 && r.eq[pkI] !== ser.pk[t]) pkI--;
    let since = null; if (ser.def[t]) { let j = t; while (j > 0 && ser.def[j - 1]) j--; since = cal[s0 + j]; }
    const s = []; for (let j = Math.max(0, t - KEEP_S + 1); j <= t; j++) s.push([cal[s0 + j], Math.round(r.eq[j]), ser.def[j]]);
    // 資料被改過 → 同一天的狀態變了(只警告,照寫)
    if (opt.prev && Array.isArray(opt.prev.s)) {
        const m = new Map(opt.prev.s.map(x => [x[0], x[2]])); let diff = 0;
        for (const [d, , df] of s) if (m.has(d) && m.get(d) !== df) diff++;
        if (diff) warn.push(`跟上一份比,有 ${diff} 天的狀態不一樣(資料被改過 → 模型帳的路徑變了)`);
    }
    return {
        state: {
            v: 1, updated: (opt.now || new Date()).toISOString(), data_date: cal[last], partial: opt.partial || 0,
            rule: { th: rule.th, lo: rule.lo, rec: rule.rec, top: rule.top, live: rule.live, from: rule.from },
            model: { from: cal[s0], slid, cfg: model, stocks: ctx.stocks.length, anchors: opt.anchors, R },
            peak: { d: cal[s0 + pkI], v: Math.round(ser.pk[t]) },
            now: { d: cal[last], v: Math.round(r.eq[t]), dd: Math.round(ser.dd[t] * 1000) / 10 },
            def: ser.def[t], since, w: ser.w[t], rot: keep, s,
        }, warn,
    };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); c ? ok++ : bad++; };
    // 假引擎:淨值照一條寫好的曲線走(驗這支的接線,⛔ 驗引擎 —— 引擎有自己的 selftest ㊿k)
    const n = 400, cal = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
    const curve = i => i < 250 ? 100 + i * 0.2 : i < 300 ? 150 - (i - 250) * 1.2 : 90 + (i - 300) * 1.0;   // 150 → 90(−40%)→ 190
    const stocks = Array.from({ length: 3 }, () => ({ C: new Float64Array(n).fill(10) }));
    const bear = new Uint8Array(n);
    const ctx = { cal, stocks, bear };
    const sim = (c, s0, cfg) => ({ eq: Array.from({ length: cfg.endIdx - s0 + 1 }, (_, j) => curve(s0 + j)) });
    const anchors = [cal[330], cal[334]], rule = { ...LEAD_DD, from: cal[100], live: cal[310] };
    const { state, warn } = buildState(ctx, { simulate: sim, rule, model: {}, anchors, R: 10, last: n - 1, warm: 50, minStocks: 3, now: new Date('2026-11-07T00:00:00Z') });
    // ① 換倉日 = 錨點 ± 10 的倍數、兩本帳各自
    const okA = state.rot.filter(x => x.b === 'A').every(x => (cal.indexOf(x.d) - 330) % 10 === 0), okB = state.rot.filter(x => x.b === 'B').every(x => (cal.indexOf(x.d) - 334) % 10 === 0);
    t(okA && okB && state.rot.some(x => x.b === 'B') && state.model.from === cal[100], `① 換倉日對齊錨點(甲帳 ${anchors[0]}、乙帳 ${anchors[1]})、起點 = from 那天(${state.model.from})`);
    // ② 狀態 = ddSeries:跌破 −20% 那天進一半;s 的 def 跟 ddSeries 一樣
    const eq = Array.from({ length: n - 100 }, (_, j) => curve(100 + j)), ser = ddSeries(eq, rule);
    const sOk = state.s.every(([d, v, df]) => { const j = cal.indexOf(d) - 100; return df === ser.def[j] && v === Math.round(eq[j]); });
    t(sOk && state.s.length === 120 && state.def === ser.def[n - 101] && state.w === ser.w[n - 101], `② 每一天的狀態 == lib_leaddd.ddSeries(最後一天 def ${state.def}、離最高點 ${state.now.dd}%)`);
    // ③ 實際用的比例:live 以前 1、之後照狀態(甲帳 330 那次:150→ 第 330 天 120 → −20%?)
    const wa = state.rot.map(x => `${x.b}${cal.indexOf(x.d)}:${x.W}/${x.wa}`);
    const preLive = state.rot.filter(x => x.d < rule.live).every(x => x.wa === 1), postOk = state.rot.filter(x => x.d >= rule.live).every(x => x.wa === x.W);
    t(preLive && postOk, `③ live 以前一律 1、之後 = 想要的(沒碰到空頭)(${wa.join(' ')})`);
    // ④ 空頭那次回到最高點不補(top 1):乙帳第一次「想要的回到 1」那次換倉標空頭 → 那次實際仍是一半、下一次才補
    const rB0 = state.rot.filter(x => x.b === 'B' && x.d >= rule.live), kUp = rB0.findIndex((x, k) => k > 0 && x.W === 1 && rB0[k - 1].W < 1);
    const bear2 = new Uint8Array(n); if (kUp > 0) bear2[cal.indexOf(rB0[kUp].d)] = 1;
    const st2 = buildState({ ...ctx, bear: bear2 }, { simulate: sim, rule, model: {}, anchors, R: 10, last: n - 1, warm: 50, minStocks: 3 }).state;
    const bB = st2.rot.filter(x => x.b === 'B' && x.d >= rule.live), up = bB[kUp], nx = bB[kUp + 1];
    t(kUp > 0 && up && up.bear === 1 && up.W === 1 && up.wa < 1 && nx && nx.wa === 1, `④ 空頭那次換倉:回到最高點先不補(乙帳 ${up && up.d} 想要 ${up && up.W} → 實際 ${up && up.wa})、下一次才補(${nx && nx.wa})`);
    // ⑤ 格式欄位
    const keys = ['v', 'updated', 'data_date', 'partial', 'rule', 'model', 'peak', 'now', 'def', 'since', 'w', 'rot', 's'];
    t(keys.every(k => k in state) && state.v === 1 && state.data_date === cal[n - 1] && Array.isArray(state.rot[0] ? Object.keys(state.rot[0]) : []), `⑤ 格式:${keys.join(' / ')}`);
    // ⑥ 守門:錨點不在日曆 / 暖身不夠 / 最後一天成交檔數不夠 → throw;引擎預設跟 LEADER_RULE 對不上要說出來
    let th = 0;
    try { buildState(ctx, { simulate: sim, rule, model: {}, anchors: ['1999-01-01', anchors[1]], R: 10, warm: 50, minStocks: 3 }); } catch (_) { th++; }
    try { buildState(ctx, { simulate: sim, rule, model: {}, anchors, R: 10, warm: 9999, minStocks: 3 }); } catch (_) { th++; }
    const thin = { ...ctx, stocks: stocks.map((S, k) => ({ C: k ? S.C : Float64Array.from(S.C, (v, i) => i === n - 1 ? NaN : v) })) };
    try { buildState(thin, { simulate: sim, rule, model: {}, anchors, R: 10, warm: 50, minStocks: 3 }); } catch (_) { th++; }
    const drift = ruleDrift({ U: 100, N: 5, R: 10, L: 10, hyst: 2, posMin: 80 }, { U: 100, N: 5, R: 10, L: 10, hyst: 2, pos: 85 });
    const py = readLeaderPy("LEADER_RULE = {'U': 100, 'N': 5, 'R': 10, 'L': 10, 'hyst': 2, 'pos': 85}\nLEADER_ANCHOR = '2026-09-24'\nLEADER_ANCHOR2 = '2026-10-02'\n");
    t(th === 3 && drift.length === 1 && /posMin=80/.test(drift[0]) && py && py.rule.pos === 85 && py.anchors[1] === '2026-10-02', `⑥ 守門 throw ${th}/3、引擎預設對不上說得出差在哪(${drift[0]})、讀得到 lib_leader.py 的規則與錨點`);
    // ⑦ 跟上一份比狀態變了 → 警告
    const prev = { s: state.s.map(([d, v, df], k) => [d, v, k === 50 ? 1 - df : df]) };
    const w7 = buildState(ctx, { simulate: sim, rule, model: {}, anchors, R: 10, last: n - 1, warm: 50, minStocks: 3, prev }).warn;
    t(w7.some(x => /1 天的狀態不一樣/.test(x)), '⑦ 跟上一份比同一天狀態不一樣 → 警告(資料被改過)');
    // ⑧ 今天那一根 14:30 以前不算
    const c2 = ['2026-11-06', '2026-11-09'];
    const a = pickLast(c2, new Date('2026-11-09T05:00:00Z')), b = pickLast(c2, new Date('2026-11-09T07:00:00Z')), c = pickLast(c2, new Date('2026-11-10T01:00:00Z'));
    t(a.last === 0 && a.partial === 1 && b.last === 1 && b.partial === 0 && c.last === 1, '⑧ 今天那一根:台北 13:00 不算、15:00 算、隔天早上算');
    console.log(`\n${bad ? '❌' : '✅'} lead_dd_state selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

async function main() {
    const DATA = process.argv[2] || 'data', OUT = process.argv[3] || path.join(DATA, 'lead_dd.json');
    const nFiles = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).length;
    if (nFiles < 500) { console.error(`🚨 ${DATA} 只有 ${nFiles} 個個股檔 → 不算(線上留舊的)`); process.exit(1); }
    const py = readLeaderPy(fs.readFileSync(new URL('../lib_leader.py', import.meta.url), 'utf8'));
    if (!py) { console.error('🚨 讀不到 lib_leader.py 的 LEADER_RULE / 錨點'); process.exit(1); }
    const { loadCtx, simulate, DEF } = await import('./leader_probe.mjs');
    const drift = ruleDrift(DEF, py.rule);
    if (drift.length) { console.error(`🚨 引擎預設跟 lib_leader.py 對不上:${drift.join('、')} → 模型帳不是 App 在跑的那一套,不算`); process.exit(1); }
    const divP = path.join(DATA, 'dividends_hist.json');
    const ctx = loadCtx(DATA, fs.existsSync(divP) ? divP : '');
    if (ctx.meta.stocks < 1000) { console.error(`🚨 引擎只讀到 ${ctx.meta.stocks} 檔 → 不算`); process.exit(1); }
    let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { /* 第一次 */ }
    const { last, partial } = pickLast(ctx.cal);
    let res;
    try { res = buildState(ctx, { simulate, anchors: py.anchors, R: py.rule.R, last, partial, prev }); }
    catch (e) { console.error(`🚨 ${e.message} → 不寫檔(線上留舊的)`); process.exit(1); }
    for (const w of res.warn) console.log(`::warning::✂️ ${w}`);
    const S = res.state;
    const tmp = OUT + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, OUT);
    const nextA = S.rot.filter(x => x.b === 'A').slice(-1)[0];
    console.log(`✂️ 👑 模型帳 ${S.now.d}:${(S.now.v / 1e4).toFixed(1)} 萬・最高 ${(S.peak.v / 1e4).toFixed(1)} 萬(${S.peak.d})・離最高點 ${S.now.dd}% → ${S.def ? `一半模式(${S.since} 起)` : '全部做'}`
        + `・最近一次甲帳換倉 ${nextA ? `${nextA.d} 想要 ${nextA.W} 實際 ${nextA.wa}` : '—'}・起點 ${S.model.from}・${ctx.meta.stocks} 檔${partial ? '(今天那一根還沒收完,沒算)' : ''}`);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
