#!/usr/bin/env node
/**
 * 🌀 crash_cycle_probe.mjs —— 加權 2000 起每一次大跌:往例表 + 「是不是幾年一次」(V81.0.2,使用者 11/06 問 3、5)
 *
 * ① 往例表:從高點跌 ≥10 / 15 / 20%(收盤)= 一段;從那段最低點反彈 ≥ 同樣幅度才算結束(標準的「高點 → 低點」切法)
 *    每段:高點日、低點日、跌幾 %、跌了幾個交易日、多久回到高點、原因(只標確定的)
 *    ⚠️ 低點是整段走完才知道的 —— 只拿來量「歷史上長什麼樣子」,⛔ 不是訊號
 * ② 每一年:年內最深回撤(那一年的高點 → 之後那一年的低點)vs 那一年漲跌 —— 「年年都會跌一段」有多常見
 * ③ 急跌:收盤比前 25 個交易日內最高收盤低 ≥15%(那天收盤就知道)→ 之後 5 / 20 / 60 / 120 / 250 天
 *    vs 修正段隨便一天(價格,兩邊都不含息)+ 之後還再跌幾 %;另跑 10%/10 天、20%/40 天看穩不穩
 * ④ 川普往例:2016-11-09 / 2018-03-23 / 2018-10-11 / 2019-05-06 / 2019-08-05 / 2025-04-07 —— 那天之後跌多深、怎麼走
 * ⑤ 週期:相鄰兩次的間隔(年)、變異係數 CV(1 ≈ 隨機;接近 0 = 很有規律;> 1 = 一來就一串)
 *    vs「次數一樣、時間隨機」模擬 2,000 次;間隔落在 2.5~3.5 年的比例 vs 隨機;距上一次多久 → 一年內再來的比例(hazard)
 * ⛔ n 很小(20% 那一級只有十次上下),只描述;日期是收盤價,⛔ 盤中低點
 *
 * 跑法:IDX_LONG=$S/k_idx_long.json IDX_EARLY=$S/k_idx_long_early.json TWII_NOW=$S/k6/twii_now.json node scripts/crash_cycle_probe.mjs out.json
 *       node scripts/crash_cycle_probe.mjs --selftest
 */
import fs from 'fs';
import { loadIndex, corrLegs, firstPerLeg, evVsCorr, mean, med, r2, rng } from './lib_crash.mjs';

export const XS = [10, 15, 20];
export const HS = [5, 20, 60, 120, 250];

/** 高點 → 低點切段:收盤從高點跌 ≥X% 進入;從最低收盤反彈 ≥X% 結束(那段的低點 = 反彈之前最低那天)。只用收盤 */
export function zigzag(c, X) {
    const out = []; let pk = 0, tr = -1;
    for (let i = 1; i < c.length; i++) {
        if (tr < 0) {
            if (c[i] > c[pk]) pk = i;
            else if (c[i] <= c[pk] * (1 - X / 100)) tr = i;
        } else {
            if (c[i] < c[tr]) tr = i;
            else if (c[i] >= c[tr] * (1 + X / 100)) { out.push({ pk, tr, end: i, depth: (c[tr] / c[pk] - 1) * 100, open: false }); pk = i; tr = -1; }
        }
    }
    if (tr >= 0) out.push({ pk, tr, end: null, depth: (c[tr] / c[pk] - 1) * 100, open: true });
    for (const e of out) { let r = null; for (let k = e.tr + 1; k < c.length; k++) if (c[k] >= c[e.pk]) { r = k; break; } e.rec = r; }
    return out;
}

/** 原因:只標確定的(低點日落在區間裡)。新聞說法另外標「新聞」 */
export const CAUSES = [
    ['2000-02-01', '2000-12-31', '網路泡沫 + 政黨輪替'],
    ['2001-01-01', '2001-10-31', '網路泡沫 + 911'],
    ['2002-04-01', '2002-10-31', '網路泡沫餘波'],
    ['2003-01-01', '2003-05-31', 'SARS + 伊拉克戰爭'],
    ['2004-03-01', '2004-08-31', '319 槍擊 + 中國宏觀調控'],
    ['2006-05-01', '2006-07-31', '美國升息(2006-05)'],
    ['2007-07-01', '2007-09-30', '次貸風暴'],
    ['2007-10-01', '2008-12-31', '金融海嘯'],
    ['2010-01-01', '2010-07-31', '歐債(希臘)'],
    ['2011-02-01', '2011-12-31', '歐債 + 美債降評'],
    ['2012-03-01', '2012-07-31', '歐債 + 證所稅爭議'],
    ['2015-04-01', '2015-09-30', '陸股股災 + 人民幣貶值'],
    ['2018-02-01', '2018-02-28', '美股波動率崩跌(2018-02)'],
    ['2018-06-01', '2019-01-31', '美中貿易戰'],
    ['2020-01-15', '2020-04-30', '新冠疫情'],
    ['2021-04-15', '2021-05-31', '台灣本土疫情'],
    ['2022-01-01', '2022-12-31', '升息 + 俄烏'],
    ['2024-07-01', '2024-09-30', '日圓套利平倉'],
    ['2025-01-01', '2025-05-31', '對等關稅'],
    ['2026-10-01', '2026-12-31', '這次(新聞:AI 股回檔、美國期中選舉、美伊衝突)'],
];
export const causeOf = d => { for (const [a, b, t] of CAUSES) if (d >= a && d <= b) return t; return '—'; };
/** 一段的原因:低點那天的;高點那天另有原因而且不一樣 → 「高點的 → 低點的」(例:日圓套利 → 對等關稅 被切成同一段) */
export const legCause = (pk, lo) => { const a = causeOf(pk), b = causeOf(lo); return a !== '—' && a !== b ? `${a} → ${b}` : b; };

/** 每一年:年內高點 → 之後年內低點的最深回撤 + 那一年漲跌(上一年最後一天收盤 → 這一年最後一天) */
export function intraYear(S) {
    const by = new Map();
    for (let i = 0; i < S.c.length; i++) { const y = S.d[i].slice(0, 4); if (!by.has(y)) by.set(y, []); by.get(y).push(i); }
    const out = []; let prevLast = null;
    for (const [y, ix] of by) {
        let pk = S.c[ix[0]], dd = 0;
        for (const i of ix) { pk = Math.max(pk, S.c[i]); dd = Math.min(dd, S.c[i] / pk - 1); }
        const last = ix.at(-1), base = prevLast != null ? S.c[prevLast] : S.c[ix[0]];
        out.push({ y, dd: r2(dd * 100), ret: r2((S.c[last] / base - 1) * 100), full: prevLast != null, partial: S.d[last].slice(5) < '12-20' });
        prevLast = last;
    }
    return out;
}

/** 急跌:收盤 ≤ 前 W 個交易日(不含今天)最高收盤 × (1 − X%) 的那天(只用 ≤ i 的資料) */
export function fastEvents(c, X, W) {
    const ev = [];
    for (let i = W; i < c.length; i++) {
        let mx = -Infinity; for (let k = i - W; k < i; k++) mx = Math.max(mx, c[k]);
        if (c[i] <= mx * (1 - X / 100)) ev.push(i);
    }
    return ev;
}

/** 週期:間隔(年)、CV;隨機對照 = 同樣次數均勻落在同一段時間(= 卜瓦松過程),SIMS 次 */
export function cycleStats(datesY, spanFrom, spanTo, seed = 5, SIMS = 2000) {
    const iv = []; for (let k = 1; k < datesY.length; k++) iv.push(datesY[k] - datesY[k - 1]);
    if (iv.length < 2) return { n: datesY.length, iv };
    const cvOf = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) / m; };
    const inWin = a => a.filter(x => x >= 2.5 && x <= 3.5).length / a.length;
    const cv = cvOf(iv), w = inWin(iv), R = rng(seed);
    let le = 0, ge = 0, wSum = 0; const cvs = [];
    for (let s = 0; s < SIMS; s++) {
        const t = Array.from({ length: datesY.length }, () => spanFrom + R() * (spanTo - spanFrom)).sort((a, b) => a - b);
        const v = []; for (let k = 1; k < t.length; k++) v.push(t[k] - t[k - 1]);
        const c2 = cvOf(v); cvs.push(c2); if (c2 <= cv) le++; if (c2 >= cv) ge++; wSum += inWin(v);
    }
    cvs.sort((a, b) => a - b);
    return { n: datesY.length, iv: iv.map(r2), mean: r2(mean(iv)), med: r2(med(iv)), min: r2(Math.min(...iv)), max: r2(Math.max(...iv)),
        cv: r2(cv), cvSimMed: r2(cvs[SIMS >> 1]), cvSim5: r2(cvs[Math.floor(SIMS * 0.05)]), cvSim95: r2(cvs[Math.floor(SIMS * 0.95)]),
        pRegular: +(le / SIMS).toFixed(3), pCluster: +(ge / SIMS).toFixed(3), win3: r2(w * 100), win3Sim: r2(wSum / SIMS * 100) };
}

/** 距上一次(那一段開始)幾年 → 之後 1 年內有新的一段開始的比例(只算不在跌段裡的日子) */
export function hazard(S, legs, buckets = [0, 1, 2, 3, 4, 6, 99]) {
    const yrs = d => +d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12 + (+d.slice(8, 10) - 1) / 365;
    const starts = legs.map(L => L.pk), inLeg = new Uint8Array(S.c.length);
    for (const L of legs) for (let k = L.pk; k <= (L.end ?? S.c.length - 1); k++) inLeg[k] = 1;
    const B = buckets.slice(0, -1).map((b, k) => ({ lo: b, hi: buckets[k + 1], n: 0, hit: 0 }));
    for (let i = 0; i + 250 < S.c.length; i++) {
        if (inLeg[i]) continue;
        let last = -1; for (const s of starts) if (s <= i) last = s; if (last < 0) continue;
        const t = yrs(S.d[i]) - yrs(S.d[last]); const b = B.find(x => t >= x.lo && t < x.hi); if (!b) continue;
        b.n++; if (starts.some(s => s > i && s <= i + 250)) b.hit++;
    }
    return B.map(b => ({ ...b, rate: b.n ? r2(b.hit / b.n * 100) : null }));
}

export const TRUMP = [['2016-11-09', '川普當選'], ['2018-03-23', '對中關稅備忘錄'], ['2018-10-11', '貿易戰期間全球殺盤'],
    ['2019-05-06', '推文加關稅到 25%'], ['2019-08-05', '加徵 10% + 人民幣破 7'], ['2025-04-07', '對等關稅(4/2 宣布、台股 4/7 開盤)']];

export function run(S, log = console.log) {
    const yrs = d => +d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12 + (+d.slice(8, 10) - 1) / 365;
    const out = { from: S.d[0], to: S.d.at(-1), legs: {}, cyc: {} };
    log(`加權 ${S.d[0]} ~ ${S.d.at(-1)}(${S.c.length} 天,收盤)`);
    for (const X of XS) {
        const L = zigzag(S.c, X);
        out.legs[X] = L.map(e => ({ peak: S.d[e.pk], low: S.d[e.tr], depth: r2(e.depth), days: e.tr - e.pk, rec: e.rec != null ? S.d[e.rec] : null,
            recDays: e.rec != null ? e.rec - e.tr : null, open: e.open, cause: legCause(S.d[e.pk], S.d[e.tr]), hi: Math.round(S.c[e.pk]), lo: Math.round(S.c[e.tr]) }));
        log(`\n── 從高點跌 ≥${X}%:${L.length} 段 ──`);
        log('高點日       高點    低點日       低點     跌幅    跌了幾天  回到高點(交易日)        原因');
        for (const e of out.legs[X]) log(`${e.peak} ${String(e.hi).padStart(6)}  ${e.low} ${String(e.lo).padStart(6)}  ${String(e.depth).padStart(7)}%  ${String(e.days).padStart(5)}  `
            + `${e.rec ? e.rec + '(' + e.recDays + ')' : (e.open ? '還在跌段裡' : '還沒回到')}`.padEnd(22) + `  ${e.cause}`);
        const closed = out.legs[X].filter(e => !e.open), ds = closed.map(e => e.depth), dd = closed.map(e => e.days), rr = closed.filter(e => e.recDays != null).map(e => e.recDays);
        log(`  已走完 ${closed.length} 段:跌幅中位 ${r2(med(ds))}% ・跌了中位 ${med(dd)} 個交易日 ・回到高點中位 ${med(rr)} 個交易日(${r2(med(rr) / 250)} 年)・還沒回到 ${closed.length - rr.length} 段`);
        const starts = L.map(e => yrs(S.d[e.pk]));
        out.cyc[X] = cycleStats(starts, yrs(S.d[0]), yrs(S.d.at(-1)));
        const c = out.cyc[X];
        log(`  週期:間隔(年)${c.iv.join(' / ')}`);
        log(`        平均 ${c.mean} 年 ・中位 ${c.med} ・最短 ${c.min} ・最長 ${c.max} ・變異係數 ${c.cv}(隨機模擬中位 ${c.cvSimMed},90% 落在 ${c.cvSim5}~${c.cvSim95})`
            + ` ・比隨機更規律的機率 p=${c.pRegular} ・比隨機更成串 p=${c.pCluster}`);
        log(`        間隔落在 2.5~3.5 年:${c.win3}%(隨機 ${c.win3Sim}%)`);
        const hz = hazard(S, L); out.legs[X + 'hz'] = hz;
        log('  距上一段開始幾年 → 一年內又來一段的比例:' + hz.map(b => `${b.lo}~${b.hi === 99 ? '' : b.hi}年 ${b.rate ?? '—'}%(${b.n}天)`).join(' ・'));
    }
    // ② 每一年
    const iy = intraYear(S); out.years = iy;
    log('\n── 每一年:年內最深回撤 vs 全年漲跌(價格)──');
    log(iy.map(r => `${r.y} ${String(r.dd).padStart(6)}% / ${String(r.ret).padStart(6)}%${r.partial ? '(到今天)' : ''}`).join('\n'));
    const full = iy.filter(r => r.full && !r.partial), dds = full.map(r => r.dd);
    log(`  完整年 ${full.length} 年:年內回撤中位 ${r2(med(dds))}% ・≥10% 的年 ${dds.filter(x => x <= -10).length} ・≥15% ${dds.filter(x => x <= -15).length} ・≥20% ${dds.filter(x => x <= -20).length}`
        + ` ・全年收紅 ${full.filter(r => r.ret > 0).length} 年 ・年內跌過 ≥10% 但全年收紅 ${full.filter(r => r.dd <= -10 && r.ret > 0).length} 年`);
    // ③ 急跌
    const CL = corrLegs(S.c); out.fast = {};
    for (const [X, W] of [[15, 25], [10, 10], [20, 40]]) {
        const ev = firstPerLeg(fastEvents(S.c, X, W), CL.corr);
        const vs = evVsCorr(S, S.c, CL, ev, HS, 13);
        out.fast[X + '/' + W] = { dates: ev.map(i => S.d[i]), vs };
        log(`\n── 急跌:收盤比前 ${W} 天最高收盤低 ≥${X}%(每段第一次)${ev.length} 次 ──`);
        for (const i of ev) {
            const f = h => i + h < S.c.length ? r2((S.c[i + h] / S.c[i] - 1) * 100) : null;
            let mn = S.c[i], mi = i; for (let k = i + 1; k < Math.min(S.c.length, i + 251); k++) if (S.c[k] < mn) { mn = S.c[k]; mi = k; }
            log(`  ${S.d[i]} 收 ${Math.round(S.c[i])}  之後 20天 ${f(20) ?? '—'}% ・60天 ${f(60) ?? '—'}% ・250天 ${f(250) ?? '—'}% ・還再跌 ${r2((mn / S.c[i] - 1) * 100)}%(${mi - i} 天後)  ${causeOf(S.d[i])}`);
        }
        for (const h of HS) { const x = vs.h[h]; if (!x || x.ev == null) continue;
            log(`  ${String(h).padStart(3)} 天:急跌 ${x.ev}%(漲 ${x.up}%)vs 修正段隨便一天 ${x.base}%(漲 ${x.upBase}%)差 ${x.diff} ・p=${x.p} ・前後半 ${x.h1}/${x.h2} ・n=${x.n}`); }
        log(`  離那段最低點 3% 以內 ${vs.near}%(修正段隨便一天 ${vs.nearBase}%)・60 天內再跌 ≥5% ${vs.deeper}%(${vs.deeperBase}%)・之後還再跌中位 ${vs.more}%(${vs.moreBase}%)`);
    }
    // ④ 川普往例
    log('\n── 川普相關往例(那天收盤起算)──');
    const hi = CL.hi; out.trump = [];
    for (const [d, t] of TRUMP) {
        const i = S.d.findIndex(x => x >= d); if (i < 1) continue;
        let mn = S.c[i], mi = i; for (let k = i; k < Math.min(S.c.length, i + 61); k++) if (S.c[k] < mn) { mn = S.c[k]; mi = k; }
        const f = h => i + h < S.c.length ? r2((S.c[i + h] / S.c[i] - 1) * 100) : null;
        const row = { d: S.d[i], t, day: r2((S.c[i] / S.c[i - 1] - 1) * 100), dd: r2((S.c[i] / hi[i] - 1) * 100), low60: r2((mn / S.c[i] - 1) * 100), lowD: S.d[mi],
            lowDD: r2((mn / hi[mi] - 1) * 100), r20: f(20), r60: f(60), r250: f(250) };
        out.trump.push(row);
        log(`  ${row.d} ${t}:當天 ${row.day}% ・距一年高 ${row.dd}% ・之後 60 天內最低再跌 ${row.low60}%(${row.lowD},距一年高 ${row.lowDD}%)・20天 ${row.r20}% ・60天 ${row.r60}% ・250天 ${row.r250 ?? '—'}%`);
    }
    return out;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① zigzag:100 → 70(−30%)→ 90(+28.6% 反彈結束)→ 130 → 110(−15.4%)→ 140
    const c = [100, 95, 80, 70, 75, 90, 100, 130, 120, 110, 125, 140];
    const z20 = zigzag(c, 20), z10 = zigzag(c, 10);
    t(z20.length === 1 && z20[0].pk === 0 && z20[0].tr === 3 && Math.abs(z20[0].depth + 30) < 1e-9 && z20[0].rec === 6, `① ≥20% 一段:高點第 0 天、低點第 3 天、−30%、第 6 天回到高點(${JSON.stringify(z20.map(e => [e.pk, e.tr, r2(e.depth), e.rec]))})`);
    t(z10.length === 2 && z10[1].pk === 7 && z10[1].tr === 9, `② ≥10% 兩段,第二段高點第 7 天、低點第 9 天(${JSON.stringify(z10.map(e => [e.pk, e.tr]))})`);
    // ③ 沒走完的段標 open
    const zo = zigzag([100, 110, 85, 80, 82], 20);
    t(zo.length === 1 && zo[0].open && zo[0].tr === 3 && zo[0].rec == null, '③ 還在跌段裡 → open、沒有回到高點');
    // ④ 急跌只用 ≤ i(改掉未來不變)
    const s = Array.from({ length: 80 }, (_, i) => i < 40 ? 100 : i < 60 ? 100 - (i - 39) : 80);
    const e1 = fastEvents(s, 15, 25), s2 = s.slice(); for (let i = 55; i < 80; i++) s2[i] = 1;
    const e2 = fastEvents(s2, 15, 25).filter(i => i <= 54);
    t(e1[0] === 54 && JSON.stringify(e1.filter(i => i <= 54)) === JSON.stringify(e2), `④ 急跌第一天 = 第 54 天(剛好跌 15%),改掉之後的價格不影響(${e1[0]})`);
    // ⑤ 週期:完全規律(每 3 年一次)→ 比隨機更規律 p 很小、間隔 2.5~3.5 年 100%;隨機 → CV 落在模擬中間
    const reg = cycleStats([2000, 2003, 2006, 2009, 2012, 2015, 2018, 2021, 2024], 2000, 2026);
    t(reg.cv < 0.05 && reg.pRegular < 0.01 && reg.win3 === 100, `⑤ 每 3 年一次:CV ${reg.cv}、比隨機更規律 p=${reg.pRegular}、2.5~3.5 年 ${reg.win3}%(隨機 ${reg.win3Sim}%)`);
    const R = rng(99), pois = Array.from({ length: 12 }, () => 2000 + R() * 26).sort((a, b) => a - b);
    const ps = cycleStats(pois, 2000, 2026);
    t(ps.pRegular > 0.05 && ps.pCluster > 0.05, `⑥ 隨機的 12 次:不會被判成有規律或成串(p 規律 ${ps.pRegular} / 成串 ${ps.pCluster},CV ${ps.cv})`);
    // ⑦ 每一年回撤:年內 100→80→90 = −20%
    const S = { d: ['2020-12-31', '2021-01-04', '2021-06-01', '2021-12-31'], c: [100, 100, 80, 90] };
    const iy = intraYear(S);
    t(iy[1].y === '2021' && iy[1].dd === -20 && iy[1].ret === -10, `⑦ 年內最深回撤 −20%、全年 −10%(${JSON.stringify(iy[1])})`);
    // ⑧ 原因只標確定的區間
    t(causeOf('2020-03-19') === '新冠疫情' && causeOf('2013-06-01') === '—', '⑧ 原因:落在區間才標,其他 —');
    t(legCause('2024-07-11', '2025-04-09') === '日圓套利平倉 → 對等關稅' && legCause('2020-01-14', '2020-03-19') === '新冠疫情' && legCause('2005-08-03', '2005-10-28') === '—', '⑨ 跨兩個原因的段寫「高點的 → 低點的」');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('crash_cycle_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const out = run(loadIndex());
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
