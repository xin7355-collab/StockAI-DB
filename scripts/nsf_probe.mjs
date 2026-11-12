#!/usr/bin/env node
/**
 * 🏛️ nsf_probe.mjs —— 國安基金 10 次進場:進場前有什麼共同點?進場之後怎麼走?(V81.0.2,使用者 11/06 問)
 *   🏛️ V82.1.6 加第 10 次(2026-11-06 授權)+ 退場研究:宣布退場那天之後怎麼走(NSF_EXIT;使用者:「不要只研究進場,也要研究退場」)
 *
 * 日期(stopfall_probe.NSF;各來源差 1~2 天 → 這裡 ±2 個交易日都算一次看穩不穩):
 *   2000-03-16 政黨輪替 ・2000-10-03 網路泡沫 / 核四 ・2004-05-20 319 ・2008-09-19 金融海嘯 ・2011-12-20 歐債
 *   2015-08-25 人民幣 / 陸股 ・2020-03-20 新冠 ・2022-07-13 升息 / 俄烏 ・2025-04-09 對等關稅 ・2026-11-06 第 10 次(之後還沒有資料)
 * 每一次印:進場前從一年高點(收盤)跌了幾 %、離高點幾個交易日、前 10 天最大單日跌幅、近 20 天實現波動(年化)、VIX(2009 起)
 *          進場那天收盤買 → 5 / 20 / 60 / 120 / 250 天(含息 2003 起,之前用價格)、之後還再跌幾 %、幾天到底
 * 對照:① 隨便一天 ② 修正段隨便一天 ③「一樣深、但國安基金沒進場」的修正段(那一段第一次跌到 ≥ 國安基金進場時最淺那次的深度)
 * 退場:宣布「停止執行安定市場任務」那天收盤 → 20 / 60 / 120 / 250 天、之後還再跌幾 %;對照 ① 隨便一天 ② 離一年高 10% 以內的隨便一天
 *   (退場時大盤多半已經漲回來 → 拿「一樣接近高點」的日子比才公平)。
 * ⛔ n = 9 / 8 只描述,不是訊號;而且日期是事後才知道的(宣布當天收盤前不一定知道)。
 *
 * 跑法:IDX_LONG=$S/k_idx_long.json IDX_EARLY=$S/k_idx_long_early.json TWII_NOW=$S/k6/twii_now.json US_HIST=$S/k6/us_hist.json \
 *       node scripts/nsf_probe.mjs out.json
 *       node scripts/nsf_probe.mjs --selftest
 */
import fs from 'fs';
import { loadIndex, corrLegs, rollMax, mean, med, r2, usToTw } from './lib_crash.mjs';
import { NSF } from './stopfall_probe.mjs';

export const HS = [5, 20, 60, 120, 250];
// 🏛️ V82.1.6 宣布退場(停止執行安定市場任務)日期 —— 新聞整理(財訊 / 今周刊 / 聯合 / 公視 / 中央社轉載的整理表),
//   ⚠️ 沒逐一對到國安基金官方公告;各來源可能差 1~2 天 → 跟進場一樣 ±2 個交易日看穩不穩。
//   2022、2025 兩次用「護盤 275 / 279 天(含頭尾)」對過;2011 那次 4/21 是週六 → 對到下一個交易日。
//   null = 不算:2000-03 那次整理表寫「3/16~3/20」像是買進期間、不是宣布退場(存疑);2026-11-06 那次還在執行。
export const NSF_EXIT = {
    '2000-03-16': null, '2000-10-03': '2000-11-15', '2004-05-20': '2004-06-01', '2008-09-19': '2008-12-17',
    '2011-12-20': '2012-04-21', '2015-08-25': '2016-04-12', '2020-03-20': '2020-10-12', '2022-07-13': '2023-04-13',
    '2025-04-09': '2026-01-12', '2026-11-06': null,
};
const rd = p => p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;

/** 第 i 天的「進場前狀態」(只用 ≤ i 的資料) */
export function preState(S, i, hi250) {
    const c = S.c; let pk = i; while (pk > 0 && i - pk < 250 && c[pk] < hi250[i]) pk--;
    let worst = 0; for (let k = Math.max(1, i - 9); k <= i; k++) worst = Math.min(worst, c[k] / c[k - 1] - 1);
    const rs = []; for (let k = Math.max(1, i - 19); k <= i; k++) rs.push(Math.log(c[k] / c[k - 1]));
    const m = mean(rs), vol = Math.sqrt(mean(rs.map(x => (x - m) ** 2)) * 252) * 100;
    return { dd: r2((c[i] / hi250[i] - 1) * 100), days: i - pk, worst1d: r2(worst * 100), vol20: r2(vol) };
}
/** 第 i 天收盤之後:h 天報酬(含息有就用含息)、之後 250 天內最低收盤還再跌幾 %、幾天到 */
export function postPath(S, i, hs = HS) {
    const A = S.tr && S.tr[i] != null ? S.tr : S.c, out = { src: A === S.c ? '價格' : '含息' };
    for (const h of hs) out[h] = i + h < A.length && A[i + h] != null ? r2((A[i + h] / A[i] - 1) * 100) : null;
    let mn = S.c[i], mi = i; for (let k = i + 1; k < Math.min(S.c.length, i + 251); k++) if (S.c[k] < mn) { mn = S.c[k]; mi = k; }
    out.more = r2((mn / S.c[i] - 1) * 100); out.toLow = mi - i; out.lowDate = S.d[mi];
    return out;
}

export function run(S, us, log = console.log) {
    const hi = rollMax(S.c, 250), CL = corrLegs(S.c), nx = usToTw(S.d);
    const vixAt = {}; if (us && us.syms && us.syms['^VIX']) { const vc = us.syms['^VIX'].c; us.days.forEach((d, k) => { const t = nx(d); if (t >= 0) vixAt[t] = vc[k]; }); }
    const vixOn = i => { for (let k = i; k >= Math.max(0, i - 3); k--) if (vixAt[k] != null) return r2(vixAt[k]); return null; };
    const rows = [];
    for (const d of NSF) {
        const i = S.d.findIndex(x => x >= d); if (i < 0) continue;
        const pre = preState(S, i, hi), post = postPath(S, i);
        const alt = [-2, -1, 1, 2].map(k => i + k).filter(k => k > 0 && k < S.c.length).map(k => postPath(S, k)[60]);
        rows.push({ d, td: S.d[i], close: Math.round(S.c[i]), ...pre, vix: vixOn(i), post, alt60: alt });
    }
    log(`國安基金 ${rows.length} 次(進場那天收盤):`);
    log('日期        收盤   距一年高   離高點幾天  前10天最大單日  20天波動  VIX  |  5天   20天   60天  120天  250天 | 之後還再跌  幾天到底(那天)  | 60天 ±2天');
    for (const r of rows) log(`${r.td} ${String(r.close).padStart(6)} ${String(r.dd).padStart(7)}% ${String(r.days).padStart(6)} ${String(r.worst1d).padStart(10)}% ${String(r.vol20).padStart(8)}% ${String(r.vix ?? '—').padStart(5)} | `
        + HS.map(h => String(r.post[h] ?? '—').padStart(6)).join('') + ` | ${String(r.post.more).padStart(7)}% ${String(r.post.toLow).padStart(5)}(${r.post.lowDate}) ${r.post.src} | ${r.alt60.join(' / ')}`);
    // 對照:隨便一天、修正段隨便一天
    const base = (pool, h) => { const v = pool.map(i => postPath(S, i, [h])[h]).filter(x => x != null); return { n: v.length, m: r2(mean(v)), md: r2(med(v)), up: r2(v.filter(x => x > 0).length / v.length * 100) }; };
    const all = [], corr = []; for (let i = 0; i < S.c.length; i++) { all.push(i); if (CL.corr[i] >= 0) corr.push(i); }
    const sum = {};
    for (const h of HS) { const v = rows.map(r => r.post[h]).filter(x => x != null);
        sum[h] = { n: v.length, m: r2(mean(v)), md: r2(med(v)), up: r2(v.filter(x => x > 0).length / v.length * 100), all: base(all.filter((_, k) => k % 2 === 0), h), corr: base(corr, h) };
        log(`  ${String(h).padStart(3)} 天:國安基金 ${sum[h].m}%(中位 ${sum[h].md}、漲 ${sum[h].up}%、n=${sum[h].n})・隨便一天 ${sum[h].all.m}%(漲 ${sum[h].all.up}%)・修正段隨便一天 ${sum[h].corr.m}%(漲 ${sum[h].corr.up}%)`); }
    // 進場前條件:最淺的一次跌多少 → 一樣深但沒進場的修正段
    const minDD = Math.max(...rows.map(r => r.dd));               // dd 是負的,最淺 = 最大
    const nsfLegs = new Set(rows.map(r => CL.corr[S.d.indexOf(r.td)]));
    const same = [];
    CL.legs.forEach((L, k) => { if (nsfLegs.has(k)) return; let first = -1; for (let i = L.s; i <= L.e; i++) if ((S.c[i] / hi[i] - 1) * 100 <= minDD) { first = i; break; } if (first < 0) return;
        same.push({ leg: S.d[L.peakI], first: S.d[first], dd: r2((S.c[first] / hi[first] - 1) * 100), depth: r2(L.depth), post: postPath(S, first), open: !!L.open }); });
    log(`\n國安基金進場時最淺的一次:距一年高 ${minDD}% → 一樣深、但國安基金沒進場的修正段 ${same.length} 段:`);
    for (const s of same) log(`  ${s.leg} 高點那段:第一次到 ${s.dd}% = ${s.first} ・整段最深 ${s.depth}%${s.open ? '(還沒走完)' : ''} ・之後 20 天 ${s.post[20]}% / 60 天 ${s.post[60]}% / 250 天 ${s.post[250]}% ・之後還再跌 ${s.post.more}%`);
    const depths = rows.map(r => r.dd).sort((a, b) => a - b);
    log(`\n進場時距一年高:${depths.join(' / ')}%(中位 ${r2(med(depths))}%)・離高點中位 ${med(rows.map(r => r.days))} 個交易日 ・前 10 天最大單日跌幅中位 ${r2(med(rows.map(r => r.worst1d)))}%`);
    const ex = exitStudy(S, rows, hi, log);
    return { rows, sum, minDD, same, exit: ex };
}

/** 🏛️ V82.1.6 退場研究:宣布退場那天收盤 → 之後怎麼走;對照隨便一天、離一年高 10% 以內的隨便一天(只描述) */
export function exitStudy(S, rows, hi, log = console.log, EXIT = NSF_EXIT) {
    const out = [], skip = [];
    for (const r of rows) {
        const ed = EXIT[r.d];
        if (!ed) { skip.push(r.d); continue; }
        const ie = S.d.findIndex(x => x >= ed), i = S.d.indexOf(r.td);
        if (ie < 0 || i < 0 || ie <= i) { skip.push(r.d); continue; }
        const A = S.tr && S.tr[i] != null && S.tr[ie] != null ? S.tr : S.c;
        const post = postPath(S, ie);
        const alt = [-2, -1, 1, 2].map(k => ie + k).filter(k => k > i && k < S.c.length).map(k => postPath(S, k)[60]);
        out.push({ d: r.d, exit: ed, te: S.d[ie], days: ie - i, during: r2((A[ie] / A[i] - 1) * 100), ddExit: r2((S.c[ie] / hi[ie] - 1) * 100), post, alt60: alt });
    }
    log(`\n國安基金退場(宣布停止護盤那天收盤;${out.length} 次可算,不算:${skip.join(' / ') || '無'}):`);
    log('進場        退場(交易日)  護盤幾天  期間漲跌  退場時距一年高 |  5天   20天   60天  120天  250天 | 之後還再跌  幾天到底 | 60天 ±2天');
    for (const x of out) log(`${x.d}  ${x.te} ${String(x.days).padStart(8)} ${String(x.during).padStart(8)}% ${String(x.ddExit).padStart(10)}% |`
        + HS.map(h => String(x.post[h] ?? '—').padStart(6)).join('') + ` | ${String(x.post.more).padStart(7)}% ${String(x.post.toLow).padStart(5)} | ${x.alt60.join(' / ')}`);
    const near = [], all = [];
    for (let k = 250; k < S.c.length; k++) { all.push(k); if ((S.c[k] / hi[k] - 1) * 100 >= -10) near.push(k); }
    const base = (pool, h) => { const v = pool.map(k => postPath(S, k, [h])[h]).filter(x => x != null); return { n: v.length, m: r2(mean(v)), up: r2(v.filter(x => x > 0).length / v.length * 100) }; };
    const sum = {};
    for (const h of HS) {
        const v = out.map(x => x.post[h]).filter(x => x != null);
        if (!v.length) continue;
        sum[h] = { n: v.length, m: r2(mean(v)), md: r2(med(v)), up: r2(v.filter(x => x > 0).length / v.length * 100), all: base(all.filter((_, k) => k % 2 === 0), h), near: base(near.filter((_, k) => k % 2 === 0), h) };
        log(`  ${String(h).padStart(3)} 天:退場後 ${sum[h].m}%(中位 ${sum[h].md}、漲 ${sum[h].up}%、n=${sum[h].n})・隨便一天 ${sum[h].all.m}%(漲 ${sum[h].all.up}%)・離一年高 10% 以內的隨便一天 ${sum[h].near.m}%(漲 ${sum[h].near.up}%)`);
    }
    const moreV = out.map(x => x.post.more), deep = moreV.filter(x => x <= -10).length;
    const nearMore = near.filter((_, k) => k % 5 === 0).map(k => postPath(S, k, [250]).more), nearDeep = nearMore.filter(x => x <= -10).length;
    log(`  退場後一年內還再跌 ≥10%:${deep}/${out.length} 次 ・離一年高 10% 以內的隨便一天 ${r2(nearDeep / nearMore.length * 100)}%(n=${nearMore.length})`);
    log(`  護盤天數(交易日)中位 ${med(out.map(x => x.days))} ・期間漲跌中位 ${r2(med(out.map(x => x.during)))}% ・退場時距一年高中位 ${r2(med(out.map(x => x.ddExit)))}%`);
    const matched = exitMatched(S, rows, out, hi, log);
    return { rows: out, skip, sum, deep, nearDeepPct: r2(nearDeep / nearMore.length * 100), matched };
}

/** 🏛️ V82.1.6 退場的配對對照(EXP-20261112-01 事先登記,判定條件寫死在那裡):
 *  每一次退場日 e → 所有 k(≥250、之後 h 天有資料、不在任何護盤期間):|距一年高差| ≤ 5pp 且 |前 120 天漲跌差| ≤ 10pp;
 *  超額 = 退場後 h 天 − 配對日平均。8 次超額平均 ≤ −3pp 且 ≥6/8 為負 = 比較差;≥ +3pp 且 ≥6/8 為正 = 比較好;其他 = 分不出來。 */
export function exitMatched(S, rows, out, hi, log = console.log, H = [20, 60, 120], DD = 5, RUN = 10) {
    const pre120 = k => k >= 120 ? (S.c[k] / S.c[k - 120] - 1) * 100 : null;
    const ddOf = k => (S.c[k] / hi[k] - 1) * 100;
    // 護盤期間(進場 ~ 退場)⛔ 拿來當對照。退場日不明的(2000-03 存疑)標到下一次進場前一天;只有最後一次(還在執行)標到最後。
    //   🐛 第一版把「不明」一律當成還在執行、一路標到今天 → 2000-03 之後全部被排除、配對 0 筆(真資料跑出 n=0 才抓到)
    const inNsf = new Uint8Array(S.c.length);
    const rs = rows.map(r => ({ r, i: S.d.indexOf(r.td) })).filter(o => o.i >= 0).sort((a, b) => a.i - b.i);
    rs.forEach((o, j) => {
        const ed = NSF_EXIT[o.r.d];
        let ie = ed ? S.d.findIndex(x => x >= ed) : (j + 1 < rs.length ? rs[j + 1].i - 1 : S.c.length - 1);
        if (ie < 0) ie = S.c.length - 1;
        for (let k = o.i; k <= ie; k++) inNsf[k] = 1;
    });
    const res = {};
    for (const h of H) {
        const per = [];
        for (const x of out) {
            const e = S.d.indexOf(x.te); if (e < 0 || x.post[h] == null || pre120(e) == null) continue;
            const de = ddOf(e), re = pre120(e), v = [];
            for (let k = 250; k + h < S.c.length; k++) {
                if (inNsf[k] || k === e) continue;
                const rk = pre120(k); if (rk == null) continue;
                if (Math.abs(ddOf(k) - de) <= DD && Math.abs(rk - re) <= RUN) { const p = postPath(S, k, [h])[h]; if (p != null) v.push(p); }
            }
            if (!v.length) continue;
            per.push({ d: x.d, te: x.te, ev: x.post[h], ctl: r2(mean(v)), nCtl: v.length, ex: r2(x.post[h] - mean(v)) });
        }
        const exs = per.map(p => p.ex), m = exs.length ? r2(mean(exs)) : null, pos = exs.filter(v => v > 0).length, neg = exs.filter(v => v < 0).length;
        const verdict = m == null ? '算不出來' : (m <= -3 && neg >= 6) ? '退場後比較差' : (m >= 3 && pos >= 6) ? '退場後比較好' : '分不出來';
        res[h] = { per, m, pos, neg, n: exs.length, verdict };
        log(`  配對 ${String(h).padStart(3)} 天:超額平均 ${m}pp(正 ${pos} / 負 ${neg} / n=${exs.length})→ ${verdict}${h === 60 ? '  ← 事先登記的判定' : '(只描述)'}`);
        for (const p of per) log(`      ${p.te} 退場後 ${p.ev}% vs 配對 ${p.ctl}%(${p.nCtl} 天)→ ${p.ex}pp`);
    }
    return res;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 700, d = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2010, 0, 4 + i)).toISOString().slice(0, 10));
    const c = d.map((_, i) => i < 300 ? 100 : i < 320 ? 100 * (1 - 0.3 * (i - 300) / 20) : 70 * (1 + 0.002 * (i - 320)));
    const S = { d, c, tr: c.slice() }, hi = rollMax(c, 250);
    const p = preState(S, 315, hi);
    t(Math.abs(p.dd + 22.5) < 0.01 && p.days === 15, `① 進場前:距一年高 ${p.dd}%、離高點 ${p.days} 天`);
    const q = postPath(S, 315, [5]);
    t(q.more < 0 && q.toLow === 5 && q[5] != null, `② 進場後:之後還再跌 ${q.more}%、${q.toLow} 天到底`);
    // ⛔ 前視:preState 只看 ≤ i(改掉未來不變)
    const c2 = c.slice(); for (let i = 316; i < n; i++) c2[i] = 1;
    const p2 = preState({ d, c: c2 }, 315, rollMax(c2, 250));
    t(JSON.stringify(p) === JSON.stringify(p2), '③ 改掉未來的價格,進場前狀態一模一樣');
    // ④ 退場:第 315 天進、第 400 天(週末的話對到下一個交易日)退 → 護盤 85 天、退場後從第 400 天算
    const rowsT = [{ d: d[315], td: d[315] }, { d: 'X', td: d[330] }];
    const ex = exitStudy(S, rowsT, hi, () => {}, { [d[315]]: d[400], X: null });
    t(ex.rows.length === 1 && ex.rows[0].days === 85 && ex.rows[0].te === d[400] && ex.skip[0] === 'X'
        && JSON.stringify(ex.rows[0].post) === JSON.stringify(postPath(S, 400)), `④ 退場:護盤 ${ex.rows[0] && ex.rows[0].days} 天、從退場那天算、沒退場日的跳過`);
    // ⑤ 決定性對照:退場日往後挪 → 退場後的數字跟著換(證明真的從退場那天算,不是從進場)
    const ex2 = exitStudy(S, rowsT, hi, () => {}, { [d[315]]: d[500], X: null });
    t(ex2.rows[0].days === 185 && ex2.rows[0].post[20] === postPath(S, 500)[20], '⑤ 決定性對照:退場日換成第 500 天 → 護盤 185 天、20 天報酬跟著換');
    // ⑥ 退場日早於進場(打錯)→ 不算(⛔ 算出負的護盤天數)
    const ex3 = exitStudy(S, rowsT, hi, () => {}, { [d[315]]: d[300], X: null });
    t(ex3.rows.length === 0 && ex3.skip.includes(d[315]), '⑥ 退場日早於進場 → 不算');
    // ⑦ 配對對照:平穩上漲的序列 → 退場日跟配對日長得一樣 → 超額 ≈ 0、判「分不出來」(決定性對照)
    const n2 = 1200, d2 = Array.from({ length: n2 }, (_, i) => new Date(Date.UTC(2005, 0, 3 + i)).toISOString().slice(0, 10));
    const c3 = d2.map((_, i) => 100 * Math.pow(1.0004, i)), S2 = { d: d2, c: c3, tr: c3.slice() }, hi2 = rollMax(c3, 250);
    const evs = [600, 650, 700, 750, 800, 850, 900, 950].map(k => ({ post: postPath(S2, k), te: d2[k], d: d2[k - 100] }));
    const m0 = exitMatched(S2, [], evs, hi2, () => {}, [60]);
    t(Math.abs(m0[60].m) < 0.01 && m0[60].verdict === '分不出來' && m0[60].n === 8, `⑦ 決定性對照:退場日跟配對日一樣 → 超額 ${m0[60].m}pp、${m0[60].verdict}`);
    // ⑧ 注入:把 8 個退場日之後 60 天都壓低 10% → 必須判「退場後比較差」
    const c4 = c3.slice(); for (const k of [600, 650, 700, 750, 800, 850, 900, 950]) c4[k + 60] = c4[k + 60] * 0.9;
    const S4 = { d: d2, c: c4, tr: c4.slice() }, hi4 = rollMax(c4, 250);
    const evs4 = [600, 650, 700, 750, 800, 850, 900, 950].map(k => ({ post: postPath(S4, k), te: d2[k], d: d2[k - 100] }));
    const m4 = exitMatched(S4, [], evs4, hi4, () => {}, [60]);
    t(m4[60].verdict === '退場後比較差' && m4[60].neg >= 6, `⑧ 注入退場後壓低 10% → ${m4[60].verdict}(超額 ${m4[60].m}pp)`);
    // ⑨ 退場日不明的那次 ⛔ 一路標到最後(真資料第一版就是這樣把對照組清光):前面放一次「不明」的進場 → 照樣配得到
    const rowsU = [{ d: '2000-03-16', td: d2[250] }, { d: '2000-10-03', td: d2[400] }];   // 第一版 bug 會把 250 以後全標掉 → 0 筆
    const mU = exitMatched(S2, rowsU, evs, hi2, () => {}, [60]);
    t(mU[60].n === 8 && mU[60].per.every(p => p.nCtl > 0), `⑨ 退場日不明的只標到下一次進場前 → 8 次都配得到(n=${mU[60].n})`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('nsf_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(), us = rd(process.env.US_HIST);
    const out = run(S, us);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
