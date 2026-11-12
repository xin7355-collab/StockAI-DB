#!/usr/bin/env node
/**
 * 🧠 psych_state_probe.mjs —— 大盤「心理狀態機」(V82.1.7,使用者 11/12:「心理狀態機也要做,我想要嘗試不一樣的方式」)
 *
 * 為什麼換做法:以前找「止跌訊號」34 種(+ 自創 8 種 × 33 國)一種都沒過(stopfall / crash_global)。這支 ⛔ 再找訊號,
 *   改成每天把大盤分成 5 種心理狀態(有遲滯:進去的門檻比出來的嚴 → ⛔ 一天跳來跳去),看兩件事:
 *   ① 狀態之間怎麼轉:恐慌通常多久變修復、修復之後多少比例又掉回恐慌、現在在哪一格(只描述)
 *   ② 跌深(距一年高 ≤ −10%)的日子裡,「恐慌」(波動在歷史前 10%)跟「擔憂」(一樣深、波動沒那麼大)之後 60 天差多少
 *      —— EXP-20261112-02 事先登記,判定條件寫死在 judge()
 *
 * 特徵(只用 ≤ 當天;百分位 = 擴張視窗、⛔ 含當天,2003 以前只暖機不判):
 *   D 距近 250 天最高收盤(%)・V 20 日實現波動(年化)的百分位・M 20 日漲跌的百分位
 * 狀態規則(STATE_RULES,寫死):
 *   恐慌 PANIC :V ≥ 90 且 D ≤ −10 進;V < 75 出 → 修復
 *   修復 REPAIR:恐慌出來後;D > −5 → 中性;又 V ≥ 90 且 D ≤ −10 → 恐慌
 *   擔憂 WORRY :D ≤ −10 但不是恐慌 / 修復;D > −5 → 中性
 *   貪婪 GREED :M ≥ 90 且 D > −3 且 V < 50 進;M < 60 或 D ≤ −5 出
 *   中性 NEUTRAL:其他
 * ⛔ RESEARCH_ONLY:結果只進 pro.html 實測總表,⛔ 散戶 App。
 *
 * 跑法:IDX_LONG=$S/k_idx_long.json IDX_EARLY=$S/k_idx_long_early.json TWII_NOW=$S/k6/twii_now.json node scripts/psych_state_probe.mjs out.json
 *       node scripts/psych_state_probe.mjs --selftest
 */
import fs from 'fs';
import { loadIndex, rng, mean, med, r2 } from './lib_crash.mjs';

export const STATES = ['PANIC', 'REPAIR', 'WORRY', 'NEUTRAL', 'GREED'];
export const ZH = { PANIC: '恐慌', REPAIR: '修復', WORRY: '擔憂', NEUTRAL: '中性', GREED: '貪婪' };
export const STATE_RULES = { panicV: 90, panicD: -10, panicOutV: 75, worryD: -10, backD: -5, greedM: 90, greedD: -3, greedV: 50, greedOutM: 60 };
export const START = '2003-01-01';

/** 擴張視窗百分位(含當天):第 i 天 = 0..i 裡 ≤ x[i] 的比例 × 100;null 跳過 */
export function expPct(x) {
    const out = new Array(x.length).fill(null), sorted = [];
    for (let i = 0; i < x.length; i++) {
        const v = x[i]; if (v == null || !isFinite(v)) continue;
        let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; }
        sorted.splice(lo, 0, v);
        out[i] = lo + 1 === 0 ? 0 : (lo + 1) / sorted.length * 100;   // lo+1 = ≤ v 的個數(剛插入的那個也算)
    }
    return out;
}

/** 特徵:D / V / M(只用 ≤ 當天) */
export function features(c) {
    const n = c.length, D = new Array(n).fill(null), vol = new Array(n).fill(null), r20 = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        let hi = -Infinity; for (let k = Math.max(0, i - 249); k <= i; k++) if (c[k] > hi) hi = c[k];
        D[i] = (c[i] / hi - 1) * 100;
        if (i >= 20) {
            const rs = []; for (let k = i - 19; k <= i; k++) rs.push(Math.log(c[k] / c[k - 1]));
            const m = mean(rs); vol[i] = Math.sqrt(mean(rs.map(x => (x - m) ** 2)) * 252) * 100;
            r20[i] = (c[i] / c[i - 20] - 1) * 100;
        }
    }
    return { D, V: expPct(vol), M: expPct(r20), vol, r20 };
}

/** 一天的狀態轉移(只看前一天狀態 + 今天特徵) */
export function step(prev, D, V, M, R = STATE_RULES) {
    const panicIn = V >= R.panicV && D <= R.panicD;
    switch (prev) {
        case 'PANIC': return V < R.panicOutV ? 'REPAIR' : 'PANIC';
        case 'REPAIR': return panicIn ? 'PANIC' : D > R.backD ? 'NEUTRAL' : 'REPAIR';
        case 'WORRY': return panicIn ? 'PANIC' : D > R.backD ? 'NEUTRAL' : 'WORRY';
        case 'GREED': if (panicIn) return 'PANIC'; if (M < R.greedOutM || D <= R.backD) return D <= R.worryD ? 'WORRY' : 'NEUTRAL'; return 'GREED';
        default: if (panicIn) return 'PANIC'; if (D <= R.worryD) return 'WORRY'; if (M >= R.greedM && D > R.greedD && V < R.greedV) return 'GREED'; return 'NEUTRAL';
    }
}

/** 整條序列的狀態(START 以前 = null,只暖機) */
export function states(S, R = STATE_RULES, start = START) {
    const F = features(S.c), st = new Array(S.c.length).fill(null);
    let prev = 'NEUTRAL';
    for (let i = 0; i < S.c.length; i++) {
        if (S.d[i] < start || F.V[i] == null || F.M[i] == null) continue;
        prev = step(prev, F.D[i], F.V[i], F.M[i], R); st[i] = prev;
    }
    return { st, F };
}

/** 之後 h 天報酬(含息有就用)、之後 h 天內最大回檔 */
export function fwd(S, i, h) {
    const A = S.tr && S.tr[i] != null ? S.tr : S.c;
    if (i + h >= A.length || A[i + h] == null) return null;
    let mn = S.c[i]; for (let k = i + 1; k <= i + h; k++) if (S.c[k] < mn) mn = S.c[k];
    return { ret: (A[i + h] / A[i] - 1) * 100, mdd: (mn / S.c[i] - 1) * 100 };
}

/** 主判定(EXP-20261112-02 寫死):距一年高 ≤ −10% 的日子,恐慌 vs 擔憂 之後 60 天
 *  ✅ = 平均差 ≥ +3pp 且「每段恐慌第一天 vs 同一年擔憂日平均」≥ 60% 為正 且 循環平移 300 次單尾 p < 0.05;其他 ⛔ */
export function judge(rows, SIMS = 300, seed = 11) {
    const pool = rows.filter(r => r.D <= -10 && (r.s === 'PANIC' || r.s === 'WORRY') && r.f60 != null);
    const P = pool.filter(r => r.s === 'PANIC').map(r => r.f60), W = pool.filter(r => r.s === 'WORRY').map(r => r.f60);
    if (P.length < 20 || W.length < 20) return { verdict: '樣本不夠', nP: P.length, nW: W.length };
    const diff = mean(P) - mean(W);
    // 每段恐慌(連續)第一天 vs 同一年擔憂日平均
    const wByYear = {}; for (const r of pool) if (r.s === 'WORRY') (wByYear[r.y] ||= []).push(r.f60);
    const eps = []; let prevI = -9;
    for (const r of pool) { if (r.s !== 'PANIC') continue; if (r.i !== prevI + 1) { const w = wByYear[r.y]; if (w && w.length) eps.push(r.f60 - mean(w)); } prevI = r.i; }
    const epPos = eps.length ? eps.filter(x => x > 0).length / eps.length * 100 : 0;
    // 安慰劑:恐慌標籤整段循環平移(保留「恐慌會連在一起」的樣子)
    const lab = pool.map(r => r.s === 'PANIC'), f = pool.map(r => r.f60), N = pool.length, R = rng(seed);
    let ge = 0;
    for (let s = 0; s < SIMS; s++) {
        const off = 1 + Math.floor(R() * (N - 1)); let sp = 0, np = 0, sw = 0, nw = 0;
        for (let k = 0; k < N; k++) { const L = lab[(k + off) % N]; if (L) { sp += f[k]; np++; } else { sw += f[k]; nw++; } }
        if (np && nw && sp / np - sw / nw >= diff) ge++;
    }
    const p = (ge + 1) / (SIMS + 1);
    const verdict = diff >= 3 && epPos >= 60 && p < 0.05 ? '✅ 恐慌多給了資訊' : '⛔ 沒有多給資訊';
    return { verdict, diff: r2(diff), mP: r2(mean(P)), mW: r2(mean(W)), nP: P.length, nW: W.length, eps: eps.length, epPos: r2(epPos), p: r2(p) };
}

export function run(S, log = console.log) {
    const { st, F } = states(S);
    const rows = [];
    for (let i = 0; i < S.c.length; i++) {
        if (!st[i]) continue;
        const a = fwd(S, i, 20), b = fwd(S, i, 60);
        rows.push({ i, d: S.d[i], y: S.d[i].slice(0, 4), s: st[i], D: F.D[i], f20: a ? a.ret : null, f60: b ? b.ret : null, mdd60: b ? b.mdd : null });
    }
    log(`🧠 大盤心理狀態機 ${rows[0].d} ~ ${rows[rows.length - 1].d}(${rows.length} 天)`);
    log('狀態      天數   佔比  | 之後20天  之後60天  60天漲的比例 | 60天內最大回檔  回檔≥10%的比例');
    const by = {};
    for (const s of STATES) {
        const R = rows.filter(r => r.s === s), f20 = R.map(r => r.f20).filter(x => x != null), f60 = R.map(r => r.f60).filter(x => x != null), md = R.map(r => r.mdd60).filter(x => x != null);
        by[s] = { n: R.length, pct: r2(R.length / rows.length * 100), f20: r2(mean(f20)), f60: r2(mean(f60)), up60: r2(f60.filter(x => x > 0).length / (f60.length || 1) * 100), mdd60: r2(mean(md)), dd10: r2(md.filter(x => x <= -10).length / (md.length || 1) * 100) };
        const b = by[s];
        log(`${ZH[s]}(${s.padEnd(7)}) ${String(b.n).padStart(5)} ${String(b.pct).padStart(5)}% | ${String(b.f20).padStart(7)}% ${String(b.f60).padStart(8)}% ${String(b.up60).padStart(9)}% | ${String(b.mdd60).padStart(10)}% ${String(b.dd10).padStart(11)}%`);
    }
    const all60 = rows.map(r => r.f60).filter(x => x != null), allMd = rows.map(r => r.mdd60).filter(x => x != null);
    log(`全部        ${rows.length}        | ${r2(mean(rows.map(r => r.f20).filter(x => x != null)))}% ${r2(mean(all60))}% ${r2(all60.filter(x => x > 0).length / all60.length * 100)}% | ${r2(mean(allMd))}% ${r2(allMd.filter(x => x <= -10).length / allMd.length * 100)}%`);
    // 轉移:每一段(連續同狀態)多長、下一格去哪
    const spells = []; let cur = null;
    for (const r of rows) { if (!cur || cur.s !== r.s || r.i !== cur.end + 1) { if (cur) spells.push(cur); cur = { s: r.s, start: r.i, end: r.i, d0: r.d }; } else cur.end = r.i; }
    if (cur) { cur.open = true; spells.push(cur); }
    const tr = {};
    for (let k = 0; k < spells.length; k++) {
        const sp = spells[k], nx = spells[k + 1];
        (tr[sp.s] ||= { n: 0, len: [], to: {} }); tr[sp.s].n++; if (!sp.open) tr[sp.s].len.push(sp.end - sp.start + 1);
        if (nx) tr[sp.s].to[nx.s] = (tr[sp.s].to[nx.s] || 0) + 1;
    }
    log('\n狀態轉移(每一段連續同狀態):');
    for (const s of STATES) { const t = tr[s]; if (!t) continue; const tot = Object.values(t.to).reduce((a, b) => a + b, 0) || 1;
        log(`  ${ZH[s]}:${t.n} 段・每段中位 ${med(t.len)} 個交易日(最長 ${Math.max(...t.len)})・下一格 → ${Object.entries(t.to).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${ZH[k]} ${r2(v / tot * 100)}%`).join('、')}`); }
    // 修復之後又掉回恐慌的比例
    const rep = spells.filter((sp, k) => sp.s === 'REPAIR' && spells[k + 1]);
    const relapse = rep.filter((sp, k) => spells[spells.indexOf(sp) + 1].s === 'PANIC').length;
    log(`  修復之後又掉回恐慌:${relapse}/${rep.length}(${r2(relapse / (rep.length || 1) * 100)}%)`);
    // 恐慌每一段的第一天(列出來)
    log('\n恐慌每一段的第一天(之後 60 天 / 60 天內最大回檔):');
    for (const sp of spells.filter(x => x.s === 'PANIC')) { const r = rows.find(x => x.i === sp.start); log(`  ${sp.d0}・${sp.end - sp.start + 1} 天${sp.open ? '(還在)' : ''}・D ${r2(r.D)}% → ${r2(r.f60) ?? '—'}% / ${r2(r.mdd60) ?? '—'}%`); }
    const J = judge(rows);
    log(`\n⭐ 事先登記的判定(EXP-20261112-02):距一年高 ≤ −10% 的日子,恐慌 vs 擔憂 之後 60 天`);
    log(`  恐慌 ${J.mP}%(n=${J.nP})vs 擔憂 ${J.mW}%(n=${J.nW})→ 差 ${J.diff}pp・每段恐慌第一天比同一年擔憂好的比例 ${J.epPos}%(${J.eps} 段)・安慰劑 p ${J.p} → ${J.verdict}`);
    const last = rows[rows.length - 1], tail = rows.slice(-30).map(r => ZH[r.s]);
    log(`\n現在(${last.d}):${ZH[last.s]}・D ${r2(last.D)}%・最近 30 個交易日:${tail.join(' ')}`);
    return { by, tr, relapse, nRep: rep.length, judge: J, now: { d: last.d, s: last.s, D: r2(last.D) }, spells: spells.filter(x => x.s === 'PANIC').map(x => ({ d: x.d0, len: x.end - x.start + 1 })) };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① 擴張百分位:含當天、⛔ 看未來
    const p = expPct([5, 1, 3, 9, 2]);
    t(p[0] === 100 && p[1] === 50 && Math.abs(p[2] - 66.67) < 0.01 && p[3] === 100 && p[4] === 40, `① 擴張視窗百分位 ${p.map(x => r2(x)).join('/')}`);
    // 合成:平穩 → 急跌高波動 → 波動退 → 慢慢漲回
    const n = 1400, d = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2003, 0, 2 + i)).toISOString().slice(0, 10)), R0 = rng(3);
    const c = [100]; for (let i = 1; i < n; i++) { let r = 0.0003 + (R0() - 0.5) * 0.01; if (i >= 900 && i < 930) r = -0.012 + (R0() - 0.5) * 0.08; if (i >= 930 && i < 1100) r = 0.0015 + (R0() - 0.5) * 0.008; c.push(c[i - 1] * Math.exp(r)); }
    const S = { d, c, tr: c.slice() }, A = states(S);
    const sAt = k => A.st[k];
    const crash = A.st.slice(900, 935);
    t(crash.includes('PANIC'), `② 急跌又高波動 → 會進恐慌(900~934:${[...new Set(crash)].map(x => ZH[x]).join('、')})`);
    const after = A.st.slice(935);   // 漲回離高點 5% 內要到第 1136 天(第一版只看到 1099 → 測試自己截太短)
    t(after.includes('REPAIR') && after.includes('NEUTRAL') && after.indexOf('REPAIR') < after.lastIndexOf('NEUTRAL'), '③ 波動退了 → 修復 → 漲回離高點 5% 內 → 中性');
    // ④ ⛔ 偷看未來:改掉第 1000 天以後的價格,前 1000 天的狀態一模一樣
    const c2 = c.slice(); for (let i = 1000; i < n; i++) c2[i] = c2[i] * (i % 2 ? 0.5 : 1.7);
    const B = states({ d, c: c2 });
    t(JSON.stringify(A.st.slice(0, 1000)) === JSON.stringify(B.st.slice(0, 1000)), '④ 改掉未來的價格,之前的狀態一模一樣');
    // ⑤ 遲滯:V 在 76~89 之間來回 → 已在恐慌就待著、不在恐慌就不進(⛔ 一天跳來跳去)
    t(step('PANIC', -15, 80, 50) === 'PANIC' && step('WORRY', -15, 80, 50) === 'WORRY' && step('PANIC', -15, 74, 50) === 'REPAIR', '⑤ 遲滯:恐慌要 V < 75 才出來,擔憂要 V ≥ 90 才進恐慌');
    // ⑥ 判定的決定性對照:恐慌 / 擔憂之後 60 天同一個分布 → ⛔
    const mk = (bump) => { const rows = [], R = rng(5); let i = 0;
        for (let y = 2003; y < 2023; y++) for (let k = 0; k < 60; k++) { const panic = k < 15; rows.push({ i: i++, y: String(y), s: panic ? 'PANIC' : 'WORRY', D: -15, f60: (R() - 0.5) * 20 + (panic ? bump : 0) }); }
        return rows; };
    const J0 = judge(mk(0));
    t(J0.verdict.startsWith('⛔') && Math.abs(J0.diff) < 3, `⑥ 決定性對照:恐慌跟擔憂一樣 → ${J0.verdict}(差 ${J0.diff}pp、p ${J0.p})`);
    // ⑦ 注入:恐慌之後 60 天多 +8pp → ✅
    const J1 = judge(mk(8));
    t(J1.verdict.startsWith('✅') && J1.diff >= 3 && J1.p < 0.05, `⑦ 注入恐慌 +8pp → ${J1.verdict}(差 ${J1.diff}pp、p ${J1.p})`);
    // ⑧ 只有距一年高 ≤ −10% 的日子算(D = −5 的恐慌 ⛔ 進池子)
    const rows8 = mk(8).map(r => r.s === 'PANIC' ? { ...r, D: -5 } : r);
    t(judge(rows8).verdict === '樣本不夠', '⑧ 池子只收距一年高 ≤ −10%(恐慌全在 −5% → 樣本不夠)');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('psych_state_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const out = run(loadIndex());
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
