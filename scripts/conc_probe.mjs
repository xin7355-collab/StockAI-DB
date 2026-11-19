// 📊 conc_probe.mjs —— 成交擠在前 10 檔到極端之後,加權接下來比較顛嗎?(「App 加上人性」第 7 期第 6 題,EXP 事先登記)
//
// 為什麼要測:人性頁「成交集中在前 10 檔」那條量條標成「貪(擠在少數股)」;常聽說「量都擠在少數幾檔 = 行情很窄、快走完了」。
//   這支回答:擠到極端之後 20 天內,加權有沒有比「平常一樣顛的日子」更容易再跌 5% 以上。
//
// 資料:每天的集中度 = lib_conc.concDaily(人性頁同一支;⛔ 00 開頭 ETF、指數、輔助檔),
//   研究用 d16(2010~2026,含已下市);加權 = lib_crash.loadIndex(官方)。
// 時間點:集中度用那天收盤後的成交量 → 那天收盤才看得到 → 結果一律從那天收盤起算(⛔ 用那天之前的價格)。
// 極端:那天的值比之前所有日子(至少 250 天)的第 95 百分位還高(lib_conc.expandingPct,⛔ 含當天以後);20 個交易日內只算第一次。
// 結果:之後 20 個交易日內加權收盤曾經比那天收盤低 ≥5%(判);60 天報酬、60 天內跌 ≥10%、當天漲跌(描述)。
// 對手:同一個波動五分位(那天之前 20 天實現波動,只用之前的日子分組)的非事件日(yen_surge_probe 那一套,import ⛔ 抄)。
//
// 跑法:CONC_DIR=<d16> IDX_LONG IDX_EARLY TWII_NOW node scripts/conc_probe.mjs [out.json]
//       node scripts/conc_probe.mjs --selftest
import fs from 'fs';
import { loadIndex, mean, r2, rng } from './lib_crash.mjs';
import { volBuckets, outcome, delta, placebo, topYear } from './yen_surge_probe.mjs';
import { concDaily, rollMean, expandingPct } from './lib_conc.mjs';

// ⭐ 事先登記的判定(EXP 寫死;⛔ 跑完再改)
export const RULE = { pct: 95, minHist: 250, dedup: 20, h: 20, dd: 5, minN: 20, effect: 5, effectNoTop: 3, p: 0.025, sims: 300, split: '2019-01-01' };
export const JUDGED = [{ id: 'd1', key: 's10', avg: 1, side: 'hi', pct: 95, zh: '前 10 檔占比:單日到過去的第 95 百分位' },
                       { id: 'm20', key: 's10', avg: 20, side: 'hi', pct: 95, zh: '前 10 檔占比:近 20 天平均到過去的第 95 百分位' }];
export const DESC = [{ id: 'd1_90', key: 's10', avg: 1, side: 'hi', pct: 90, zh: '前 10 檔:單日第 90 百分位' },
                     { id: 'd1_lo5', key: 's10', avg: 1, side: 'lo', pct: 5, zh: '前 10 檔:單日第 5 百分位以下(大家都在玩小股)' },
                     { id: 'm20_lo5', key: 's10', avg: 20, side: 'lo', pct: 5, zh: '前 10 檔:近 20 天平均第 5 百分位以下' },
                     { id: 's5_95', key: 's5', avg: 1, side: 'hi', pct: 95, zh: '前 5 檔:單日第 95 百分位' },
                     { id: 's20_95', key: 's20', avg: 1, side: 'hi', pct: 95, zh: '前 20 檔:單日第 95 百分位' }];

/** 加權切到集中度那一段(第一天到最後一天),回 { d, c } 與日期 → 索引 */
export function sliceIdx(S, from) {
    const k0 = S.d.findIndex(d => d >= from);
    if (k0 < 0) throw new Error('加權沒有涵蓋集中度那一段');
    const S2 = { d: S.d.slice(k0), c: S.c.slice(k0) };
    return { S: S2, at: new Map(S2.d.map((d, i) => [d, i])) };
}

/** 集中度序列(對齊加權的日子)→ 事件(加權的索引 r),dedup 天內只算第一次 */
export function events(rows, at, o) {
    const v0 = rows.map(r => r[o.key]), v = o.avg > 1 ? rollMean(v0, o.avg) : v0;
    const p = expandingPct(v, RULE.minHist), out = []; let last = -1e9;
    for (let i = 0; i < rows.length; i++) {
        if (p[i] == null) continue;
        const hit = o.side === 'hi' ? p[i] >= o.pct : p[i] <= o.pct;
        if (!hit) continue;
        const r = at.get(rows[i].d);
        if (r == null || r - last < RULE.dedup) continue;
        out.push({ r, d: rows[i].d, v: r2(v[i]), pct: r2(p[i]) }); last = r;
    }
    return out;
}

/** 報酬差:事件之後 h 天報酬 − 同一波動組非事件日的平均(照事件分布加權) */
export function retDelta(S, B, evs, h = 60) {
    const evSet = new Set(evs.map(e => e.r)), base = [0, 1, 2, 3, 4].map(() => ({ n: 0, s: 0 }));
    for (let i = 0; i < S.c.length; i++) {
        if (B[i] == null || evSet.has(i)) continue;
        const x = outcome(S.c, i, h, 100); if (!x) continue;
        base[B[i]].n++; base[B[i]].s += x.ret;
    }
    const rows = [];
    for (const e of evs) { const b = B[e.r], x = outcome(S.c, e.r, h, 100); if (b == null || !x || !base[b].n) continue; rows.push([x.ret, base[b].s / base[b].n]); }
    if (!rows.length) return { n: 0 };
    const ev = mean(rows.map(x => x[0])), bl = mean(rows.map(x => x[1]));
    return { n: rows.length, ev: r2(ev), base: r2(bl), diff: r2(ev - bl) };
}

/** 事件當天加權漲跌:平均、跌 ≥2% / 漲 ≥2% 的比例 vs 全部日子 */
export function dayStats(S, evs) {
    const g = evs.filter(e => e.r > 0).map(e => (S.c[e.r] / S.c[e.r - 1] - 1) * 100), all = [];
    for (let i = 1; i < S.c.length; i++) all.push((S.c[i] / S.c[i - 1] - 1) * 100);
    const sh = (a, f) => r2(a.filter(f).length / (a.length || 1) * 100);
    return { n: g.length, mean: r2(mean(g)), dn2: sh(g, x => x <= -2), up2: sh(g, x => x >= 2), allDn2: sh(all, x => x <= -2), allUp2: sh(all, x => x >= 2) };
}

/** ⭐ 事先登記的判定:n ≥ 20・Δ ≥ +5pp・兩段(~2018 / 2019~)都 > 0・安慰劑 p < 0.025・拿掉事件最多那年 Δ ≥ +3pp */
export function judge(S, B, evs, o = {}) {
    const q = { h: RULE.h, dd: RULE.dd, sims: RULE.sims, ...o };
    const all = delta(S, B, evs, q), a = delta(S, B, evs, { ...q, to: RULE.split }), b = delta(S, B, evs, { ...q, from: RULE.split });
    const ty = topYear(S, evs), noTop = delta(S, B, evs, { ...q, skipY: ty });
    const p = all.delta == null ? null : placebo(S, B, evs, all.delta, q);
    const c0 = all.n >= RULE.minN, c1 = all.delta != null && all.delta >= RULE.effect, c2 = a.delta != null && b.delta != null && a.delta > 0 && b.delta > 0;
    const c3 = p != null && p < RULE.p, c4 = noTop.delta != null && noTop.delta >= RULE.effectNoTop;
    const pass = [c0, c1, c2, c3, c4];
    return { all, a, b, topYear: ty, noTop, p: r2(p), pass, verdict: pass.every(Boolean) ? '✅ 擠到極端之後比較顛' : '⛔ 沒有比較顛(或說不準)' };
}

export function run(rows, S0, log = console.log) {
    const { S, at } = sliceIdx(S0, rows[0].d), B = volBuckets(S.c);
    const out = { from: rows[0].d, to: rows.at(-1).d, days: rows.length, judged: {}, desc: {} };
    log(`📊 集中度 ${out.from} ~ ${out.to}(${rows.length} 天);加權 ${S.d[0]} ~ ${S.d.at(-1)}`);
    const one = (E, isJ) => {
        const ev = events(rows, at, E);
        const J = judge(S, B, ev), r60 = retDelta(S, B, ev, 60), d60 = delta(S, B, ev, { h: 60, dd: 10 }), ds = dayStats(S, ev);
        const R = { ...J, n: ev.length, ret60: r60, dd60: d60, day: ds, dates: ev.map(e => e.d) };
        log(`  ${isJ ? '⭐' : '・'} ${E.zh}:${ev.length} 次・20 天內跌 ≥5% ${J.all.ev}% vs 同波動 ${J.all.base}% → ${J.all.delta}pp・~2018 ${J.a.delta} / 2019~ ${J.b.delta}・拿掉 ${J.topYear} ${J.noTop.delta}・p ${J.p}`);
        log(`      60 天報酬 ${r60.ev}% vs ${r60.base}%(${r60.diff})・60 天內跌 ≥10% ${d60.ev}% vs ${d60.base}%・當天加權平均 ${ds.mean}%、跌 ≥2% ${ds.dn2}%(全部日子 ${ds.allDn2}%)、漲 ≥2% ${ds.up2}%(${ds.allUp2}%)`);
        if (isJ) log(`      → ${J.pass.map(x => x ? '✓' : '✗').join('')} ${J.verdict}`);
        return R;
    };
    log('⭐ 判的兩個(各自四條 + 次數,安慰劑 p < 0.025 = 兩個檢定 Bonferroni):');
    for (const E of JUDGED) out.judged[E.id] = one(E, true);
    log('・只描述(⛔ 拿來判):');
    for (const E of DESC) out.desc[E.id] = one(E, false);
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // 合成世界:5,400 個交易日;「擠到很高」的 20 天出現在隨機的日子(間隔 100~250 天,⛔ 固定週期 —— 循環平移的安慰劑會對到別段),
    //   第一天最高(49~50%)、之後 45~48%;埋或不埋「第一天之後 20 天一直跌」。兩個世界的集中度一模一樣(排程用另一顆亂數)
    const days = []; for (let t = Date.UTC(2010, 0, 4); days.length < 5400; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) days.push(new Date(t).toISOString().slice(0, 10)); }
    const N = days.length, first = new Array(N).fill(false), spike = new Array(N).fill(false), down = new Array(N).fill(false);
    { const Rs = rng(11); for (let s = 120; s < N - 60; s += 100 + Math.floor(Rs() * 150)) { first[s] = true; for (let k = s; k < s + 20; k++) spike[k] = true; for (let k = s + 1; k <= s + 20; k++) down[k] = true; } }
    const mk = (plant, seed = 7) => {
        const R = rng(seed), c = [100], conc = [25];
        for (let i = 1; i < N; i++) {
            let r = (R() - 0.5) * 0.024;
            if (plant && down[i]) r -= 0.006;                                // 埋:擠到很高之後 20 天一直跌
            c.push(c[i - 1] * (1 + r));
            const u = R(); conc.push(first[i] ? 49 + u : spike[i] ? 45 + u * 3 : 22 + u * 6);
        }
        const rows = days.map((d, i) => ({ d, n: 1500, s5: conc[i] * 0.7, s10: conc[i], s20: conc[i] * 1.3 }));
        return { rows, S: { d: days, c } };
    };
    const P = mk(true), Z = mk(false);
    const sl = sliceIdx(P.S, P.rows[0].d), ev = events(P.rows, sl.at, JUDGED[0]);
    ok('① 事件 = 擠到過去第 95 百分位、20 天內只算第一次(每一段擠的第一天)', ev.length >= 20 && ev.every((e, k) => k === 0 || e.r - ev[k - 1].r >= RULE.dedup) && ev.every(e => first[days.indexOf(e.d)]), JSON.stringify(ev.slice(0, 3)) + ' n ' + ev.length);
    const rowsB = P.rows.map((r, i) => i > 2500 ? { ...r, s10: 99 } : r), evB = events(rowsB, sl.at, JUDGED[0]).filter(e => e.r < 2400);
    ok('② ⛔ 前視:改掉第 2,500 天之後的集中度,之前的事件一個都不變', JSON.stringify(evB) === JSON.stringify(ev.filter(e => e.r < 2400)));
    const m20 = events(P.rows, sl.at, JUDGED[1]);
    ok('③ 近 20 天平均:要擠一陣子才算(事件比單日少或一樣、而且都在擠的那一段裡)', m20.length >= 5 && m20.length <= ev.length && m20.every(e => P.rows.find(r => r.d === e.d).s10 > 40), m20.length + ' vs ' + ev.length);
    const B = volBuckets(sl.S.c), jP = judge(sl.S, B, ev, { sims: 120 });
    const slZ = sliceIdx(Z.S, Z.rows[0].d), jZ = judge(slZ.S, volBuckets(slZ.S.c), events(Z.rows, slZ.at, JUDGED[0]), { sims: 120 });
    ok('④ 埋了「擠到極端之後一直跌」→ ✅(五條都過)', jP.verdict.startsWith('✅') && jP.pass.every(Boolean), JSON.stringify({ d: jP.all, p: jP.p, a: jP.a.delta, b: jP.b.delta, nt: jP.noTop.delta }));
    ok('④ 決定性對照:同一份集中度、價格沒埋 → ⛔', jZ.verdict.startsWith('⛔'), JSON.stringify({ d: jZ.all.delta, p: jZ.p }));
    ok('⑤ 次數不到 20 → 判樣本不夠(⛔ 硬判)', !judge(sl.S, B, ev.slice(0, 8), { sims: 20 }).pass[0]);
    const lo = events(P.rows, sl.at, DESC[1]);
    ok('⑥ 「第 5 百分位以下」只收低的那一側', lo.length > 0 && lo.every(e => e.pct <= 5));
    const rd = retDelta(sl.S, B, ev, 20);
    ok('⑦ 報酬差:埋了一直跌 → 事件之後 20 天報酬比同波動組低', rd.n >= 10 && rd.diff < -3, JSON.stringify(rd));
    let threw = false; try { sliceIdx({ d: ['2001-01-02'], c: [1] }, '2010-01-04'); } catch (_) { threw = true; }
    ok('⑧ 加權沒有涵蓋那一段 → 丟例外(⛔ 當成沒事件)', threw);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ CONC_PROBE_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('conc_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    if (!process.env.CONC_DIR) throw new Error('CONC_DIR 沒給(d16 那一份個股資料夾)');
    const C = concDaily(process.env.CONC_DIR);
    console.log(`📂 讀了 ${C.files} 檔(讀不出來 ${C.bad})・合格 ${C.rows.length} 天`);
    const out = run(C.rows, loadIndex(process.env));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
