#!/usr/bin/env node
// 💰 crash_playbook_probe.mjs —— 大跌時「錢怎麼放」正面對決(V81.0.3,使用者 11/06:「大跌的神級操作也給研究出來」)
//
// ⭐ 問的是:同樣的錢、同樣的時間,哪一種「大跌時的做法」最後最多錢?而且要走過真的空頭(2008 / 2011 / 2015 / 2018 / 2020 / 2022)。
//   已知(⛔ 這支不重測):dipbuy_probe —— 存錢「等某天大跌 ≥X%」才買 輸定期定額(2000 起 0~9/53 次贏)、一次買 > 分 4 批 > 等 20 天;
//   etf0050_probe —— 0050 七種買法只有 2021~2026(沒空頭、沒含息,⛔ 不可外推)。
// 這支補的:
//   (A) 一筆錢:一次全買 / 12 個月平均 / 等跌 X% 才買 / 分批承接 −10・−15・−20・−25 / 固定比例再平衡 / 大跌換一部分正 2 / 年線擇時
//   (B) 每月存錢:定期定額 /「神」(事後知道每段最低點)/ 凡人等跌 X% / 定期定額 + 跌深加碼(同總額)
//   (C) 搶反彈短打:急跌(收盤比前 25 天最高低 ≥15%,每段第一次)隔一天收盤買,抱 5 / 20 天,其他時候放現金
// 每個月第一個交易日當一次起點(10 年窗口),跟一次全買 / 定期定額配對比;門檻高原、成本 ×2、前後半、安慰劑(同樣次數、隨機日子)。
//
// 規矩:
//   ・資產 = 加權報酬指數(lib_crash.loadIndex 的 tr,2003 起;同 dipbuy 的做法)當 0050;訊號用大家看得到的加權「價格」離 250 天高點多遠
//   ・成交 = 那天收盤(訊號在收盤才知道 → 一律「隔一天」收盤成交,⛔ 同一天收盤 = 前視);手續費 6 折、ETF 稅 0.1%;現金年息 1.5%(CASH_R)
//   ・正 2 合成:每天 2 × 含息報酬 − (現金利率 + 1%)/252(期貨型槓桿 ETF 的資金成本 + 管理費);有 data/00631L.json 就拿一段沒斷崖的真資料對一次
//   ・「神」是故意用未來資料的(Maggiulli「Even God Couldn't Beat DCA」的做法):兩個歷史新高之間最低那天才買,⛔ 不是可以照做的規則
//   ・D16=<目錄>(有 _bench0050.json + _div0050.json)→ 2010 起用真 0050 含息再跑一次排名(lib_totalreturn.trSeries)
//
// 跑法:IDX_LONG=data/idx_long.json IDX_EARLY=data/idx_long_early.json TWII_NOW=<^TWII.json> [D16=<d16 目錄>] [CASH_R=0.015] [COSTX=1] [YEARS=10] \
//        node scripts/crash_playbook_probe.mjs [out.json]
//       node scripts/crash_playbook_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { loadIndex, rollMax, rng, mean, med, r2, corrLegs, firstPerLeg } from './lib_crash.mjs';
import { fastEvents } from './crash_cycle_probe.mjs';
import { trSeries } from './lib_totalreturn.mjs';

export const FEE_BUY = 0.001425 * 0.6, FEE_SELL = 0.001425 * 0.6 + 0.001, FEE_2X = 0.01;

/** 共用帳戶:cash / u(現股單位)/ u2(正 2 單位);P、P2 是兩個資產的價格線 */
export function account(P, P2, costX = 1, cashR = 0.015) {
    const dr = Math.pow(1 + cashR, 1 / 252) - 1, fb = FEE_BUY * costX, fs_ = FEE_SELL * costX;
    const A = { cash: 0, u: 0, u2: 0, buys: [] };
    A.accrue = () => { A.cash *= 1 + dr; };
    A.put = amt => { A.cash += amt; };
    A.buy = (i, amt, two = false) => { amt = Math.min(amt, A.cash); if (amt <= 1e-12) return 0; const px = two ? P2[i] : P[i]; const n = amt * (1 - fb) / px; if (two) A.u2 += n; else A.u += n; A.cash -= amt; A.buys.push([i, amt, two ? 2 : 1]); return amt; };
    A.sellU = (i, units, two = false) => { const have = two ? A.u2 : A.u; units = Math.min(units, have); if (units <= 1e-15) return 0; const px = two ? P2[i] : P[i]; const v = units * px * (1 - fs_); if (two) A.u2 -= units; else A.u -= units; A.cash += v; return v; };
    A.value = i => A.cash + A.u * P[i] + A.u2 * (P2 ? P2[i] : 0);
    A.liquid = i => A.cash + A.u * P[i] * (1 - fs_) + A.u2 * (P2 ? P2[i] : 0) * (1 - fs_);   // 最後一天全部賣掉拿回多少
    return A;
}

/** 合成正 2:每天 2 × 報酬 − (現金利率 + 費用)/252 */
export function synth2x(P, from, cashR = 0.015, fee = FEE_2X) {
    const out = new Array(P.length).fill(null); out[from] = 1;
    for (let i = from + 1; i < P.length; i++) out[i] = out[i - 1] * (1 + 2 * (P[i] / P[i - 1] - 1) - (cashR + fee) / 252);
    return out;
}

/** 「神」的買點:資產每一次創新高 a_k、a_{k+1} 之間最低收盤那天(⛔ 故意用未來,只當天花板) */
export function godDays(P, from) {
    const ath = []; let mx = -Infinity;
    for (let i = from; i < P.length; i++) if (P[i] > mx) { mx = P[i]; ath.push(i); }
    const out = new Set();
    const ends = [...ath, P.length];          // 最後一段:最後一次創新高之後到資料結束的最低點
    for (let k = 0; k < ath.length; k++) {
        const a = ath[k], b = ends[k + 1];
        if (b - a < 2) continue;
        let lo = a + 1; for (let i = a + 2; i < b; i++) if (P[i] < P[lo]) lo = i;
        out.add(lo);
    }
    return out;
}

/** 門檻比較留一點浮點誤差(90 / 100 − 1 = −0.09999…,⛔ 剛好跌 10% 那天被漏掉)*/
export const hit = (v, X) => v <= -X + 1e-9;
const monthStarts = (d, a, b) => { const o = []; for (let i = a; i <= b; i++) if (i === a || d[i].slice(0, 7) !== d[i - 1].slice(0, 7)) o.push(i); return o; };

/**
 * 一筆錢(本金 1,第 i0 天收盤可以開始用)→ 第 i1 天全部賣掉拿回多少 + 中途最大回撤 + 買進日子
 * sig:dd[i] = 加權價格距 250 天高點(%,≤ 0),只看 ≤ i;所有「看到訊號」的買賣都在 i+1 收盤
 */
export function runLump(ctx, i0, i1, spec, opt = {}) {
    const { P, P2, dd, d, ma200 } = ctx;
    const A = account(P, P2, opt.costX ?? 1, opt.cashR ?? 0.015);
    A.put(1);
    const [kind, a1, a2] = spec.split(':');
    const X = +a1, K = +a2;
    let peak = 0, mdd = 0, armed = true, sw = false, done = new Set(), firstMon = d[i0].slice(0, 7), mons = 0, pend = null, inMkt = false, epIn = -1;
    const eps = [];                                     // 正 2 那幾段:[換進去那天, 換回來那天](安慰劑拿來挪到別的窗口)
    const months = new Set(monthStarts(d, i0, i1));
    const rnd = opt.placebo ? opt.placebo : null;      // 安慰劑:同樣的錢、同樣次數,隨機日子
    for (let i = i0; i <= i1; i++) {
        if (i > i0) A.accrue();
        if (months.has(i) && i > i0) mons++;
        if (pend && i === pend.i) { pend.f(i); pend = null; }
        if (rnd) { if (rnd.has(i)) A.buy(i, rnd.get(i)); }
        else if (kind === 'lump') { if (i === i0) A.buy(i, 1); }
        else if (kind === 'avg12') { if (months.has(i) && mons < 12) A.buy(i, Math.min(A.cash, 1 / 12 + 1e-12)); }
        else if (kind === 'cash') { /* 不動 */ }
        else if (kind === 'wait') {
            if (A.cash > 1e-9 && !pend && i < i1) {
                if (hit(dd[i], X)) pend = { i: i + 1, f: j => A.buy(j, A.cash) };
                else if (K && mons >= K && months.has(i)) A.buy(i, A.cash);
            }
        } else if (kind === 'ladder') {
            for (const [k, lv] of [[0, 10], [1, 15], [2, 20], [3, 25]])
                if (!done.has(k) && hit(dd[i], lv) && i < i1) { done.add(k); const j = i + 1; const q = pend; pend = { i: j, f: jj => { if (q) q.f(jj); A.buy(jj, Math.min(A.cash, 0.25)); } }; }
            if (K && mons >= K && months.has(i) && A.cash > 1e-9) A.buy(i, A.cash);
        } else if (kind === 'reb') {
            const w = X / 100, band = a2 === 'yr' ? null : +a2 / 100;
            if (i === i0) A.buy(i, w);
            else {
                const v = A.value(i), wn = A.u * P[i] / v;
                const yr = a2 === 'yr' && d[i].slice(0, 4) !== d[i - 1].slice(0, 4);
                if (yr || (band != null && Math.abs(wn - w) >= band)) {
                    if (wn > w) A.sellU(i, (wn - w) * v / P[i]); else A.buy(i, (w - wn) * v);
                }
            }
        } else if (kind === 'lev') {
            const f = K / 100;
            if (i === i0) A.buy(i, 1);
            else if (opt.levEp) {                       // 安慰劑:照給的日子換進換出(⛔ 看訊號)
                for (const [a, b] of opt.levEp) {
                    if (i === a && i < i1) { A.sellU(i, A.u * f); A.buy(i, A.cash, true); }
                    if (i === b && i < i1) { A.sellU(i, A.u2, true); A.buy(i, A.cash); }
                }
            }
            else if (!sw && hit(dd[i], X) && i < i1) { sw = true; pend = { i: i + 1, f: j => { A.sellU(j, A.u * f); A.buy(j, A.cash, true); epIn = j; } }; }
            else if (sw && dd[i] > -5 && i < i1 && !pend) { sw = false; pend = { i: i + 1, f: j => { A.sellU(j, A.u2, true); A.buy(j, A.cash); eps.push([epIn, j]); epIn = -1; } }; }
        } else if (kind === 'stat') {                   // 對照:一直放 X% 在正 2(每年調回),看「大跌才換」有沒有比「一直有槓桿」多
            const f = X / 100;
            if (i === i0) { A.buy(i, 1 - f); A.buy(i, A.cash, true); }
            else if (i < i1 && d[i].slice(0, 4) !== d[i - 1].slice(0, 4)) {
                const v = A.value(i), w2 = A.u2 * P2[i] / v;
                if (w2 > f + 0.02) { A.sellU(i, (w2 - f) * v / P2[i], true); A.buy(i, A.cash); }
                else if (w2 < f - 0.02) { A.sellU(i, (f - w2) * v / P[i]); A.buy(i, A.cash, true); }
            }
        } else if (kind === 'trend') {
            const up = ma200[i] != null && P[i] >= 0 && ctx.c[i] >= ma200[i];
            if (i === i0) { if (up) { A.buy(i, 1); inMkt = true; } }
            else if (i < i1 && !pend) {
                if (up && !inMkt) { inMkt = true; pend = { i: i + 1, f: j => A.buy(j, A.cash) }; }
                else if (!up && inMkt) { inMkt = false; pend = { i: i + 1, f: j => A.sellU(j, A.u) }; }
            }
        }
        const v = A.value(i); if (v > peak) peak = v; if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
    }
    if (epIn >= 0) eps.push([epIn, i1]);
    const in2 = eps.reduce((a, [x, y]) => a + (y - x), 0) / Math.max(1, i1 - i0);
    return { W: A.liquid(i1), mdd: mdd * 100, buys: A.buys, eps, in2 };
}

/** 每月存 1(每月第一個交易日)→ 第 i1 天全部賣掉 ÷ 總共存的錢
 *  dip:X:K   存錢,加權離 250 天高點跌 ≥X% 那天看到 → 隔天收盤把現金全買;回到 −5% 以內才再等下一次;K 個月沒等到就買(0 = 一直等)
 *  boost:X:K 每月買 (100−K)%、其餘留著,跌 ≥X% 隔天把留著的全買(同總額)
 *  god       事後知道每段最低點(故意用未來)
 *  opt.placebo:Set(日子)→ 觸發的日子換成這些隨機日子(其他照舊) */
export function runMonthly(ctx, i0, i1, spec, opt = {}) {
    const { P, dd, d } = ctx;
    const A = account(P, null, opt.costX ?? 1, opt.cashR ?? 0.015);
    const [kind, a1, a2] = spec.split(':');
    const X = +a1, K = +a2;
    const months = new Set(monthStarts(d, i0, i1));
    let put = 0, armed = true, pend = -1, idle = 0, trig = 0;
    const rnd = opt.placebo || null, ev = [];        // ev = 不是固定每月那筆的買進日(等到跌了 / 等太久補買)→ 安慰劑挪到別的窗口
    for (let i = i0; i <= i1; i++) {
        if (i > i0) A.accrue();
        if (pend === i) { A.buy(i, A.cash); pend = -1; ev.push(i); }
        if (months.has(i)) {
            A.put(1); put += 1; idle++;
            if (kind === 'dca') A.buy(i, A.cash);
            else if (kind === 'boost') A.buy(i, 1 - K / 100);
        }
        if (rnd) { if (rnd.has(i)) { A.buy(i, A.cash); trig++; } continue; }
        if (kind === 'god') { if (ctx.god.has(i)) { A.buy(i, A.cash); trig++; } }
        else if (kind === 'dip' || kind === 'boost') {
            if (dd[i] > -5) armed = true;
            if (armed && hit(dd[i], X) && i < i1 && pend < 0) { armed = false; pend = i + 1; idle = 0; trig++; }
            else if (kind === 'dip' && K && idle >= K && months.has(i)) { A.buy(i, A.cash); idle = 0; ev.push(i); }
        }
    }
    return { W: A.liquid(i1) / put, put, trig, buys: A.buys, ev };
}

/** 安慰劑:同樣的買進筆數 / 金額,換成窗口裡隨機的日子(一筆錢那一組) */
export function placeboLump(buys, i0, i1, R) {
    const m = new Map();
    for (const [, amt] of buys) { let k; do { k = i0 + Math.floor(R() * (i1 - i0)); } while (m.has(k)); m.set(k, amt); }
    return m;
}

export function buildCtx(S, opt = {}) {
    const src = opt.price ? S.c : S.tr;                 // price:用加權「價格」(不含息,2000 起才走得到 2000~2002 那段空頭)
    const f0 = src.findIndex(v => v != null && v > 0);
    const P = src.map((v, i) => (i >= f0 ? v : null));
    const hi = rollMax(S.c, 250);
    const dd = S.c.map((c, i) => (c / hi[i] - 1) * 100);
    const ma200 = S.c.map((_, i) => { if (i < 199) return null; let s = 0; for (let k = i - 199; k <= i; k++) s += S.c[k]; return s / 200; });
    const P2 = synth2x(P, f0, opt.cashR ?? 0.015, opt.fee2x ?? FEE_2X);
    return { d: S.d, c: S.c, P, P2, dd, ma200, f0, god: godDays(P, f0) };
}

const LUMP = ['lump', 'avg12', 'cash', 'wait:10:0', 'wait:15:0', 'wait:20:0', 'wait:30:0', 'wait:10:12', 'wait:15:12', 'wait:20:12', 'wait:30:12',
    'ladder:0:0', 'ladder:0:12', 'reb:70:5', 'reb:70:10', 'reb:70:yr', 'reb:50:5', 'reb:50:10', 'reb:50:yr',
    'lev:15:30', 'lev:20:30', 'lev:25:30', 'lev:30:30', 'lev:15:50', 'lev:20:50', 'lev:25:50', 'lev:30:50', 'stat:30', 'stat:50', 'trend'];
const MON = ['dca', 'god', 'dip:10:0', 'dip:15:0', 'dip:20:0', 'dip:30:0', 'dip:10:12', 'dip:20:12', 'boost:10:30', 'boost:15:30', 'boost:20:30', 'boost:10:50', 'boost:15:50', 'boost:20:50'];
const NAME = {
    lump: '一次全買', avg12: '12 個月平均買', cash: '全放現金', trend: '年線擇時(站上買、跌破賣)',
    wait: (X, K) => `等跌 ${X}% 才買${+K ? `(${K} 個月沒等到就買)` : '(一直等)'}`,
    ladder: (X, K) => `分批承接 −10/−15/−20/−25${+K ? '(12 個月沒買完就補齊)' : '(沒跌到就不買)'}`,
    reb: (X, K) => `股票 ${X}% / 現金 ${100 - X}%,${K === 'yr' ? '每年調回' : `偏 ${K} 個百分點才調`}`,
    lev: (X, K) => `跌 ${X}% 時把 ${K}% 換成正 2,回到 −5% 換回`,
    stat: X => `一直放 ${X}% 在正 2(每年調回)`,
    dca: '定期定額', god: '「神」(事後知道每段最低點才買)',
    dip: (X, K) => `存錢,跌 ${X}% 才一次買${+K ? `(${K} 個月沒等到就買)` : '(一直等)'}`,
    boost: (X, S) => `定期定額 ${100 - S}% + 留 ${S}% 等跌 ${X}% 加碼`,
};
export const nameOf = s => { const [k, a, b] = s.split(':'); const v = NAME[k]; return typeof v === 'function' ? v(a, b) : v; };

function pairStats(rows, key, base) {
    const ok = rows.filter(r => r[key] != null && r[base] != null);
    if (!ok.length) return null;
    const ratio = ok.map(r => r[key].W / r[base].W);
    const win = ok.filter(r => r[key].W > r[base].W).length;
    return { n: ok.length, medW: med(ok.map(r => r[key].W)), win, winPct: win / ok.length * 100, medRatio: med(ratio), worst: Math.min(...ratio), best: Math.max(...ratio),
        mdd: mean(ok.map(r => r[key].mdd ?? 0)) };
}

/**
 * 安慰劑(換窗口):同一個做法在「別的起點」那次是第幾天買、買多少(或第幾天換進正 2、換多久),原封不動搬到這個起點。
 * ⭐ 保留了「平均在現金裡等多久 / 平均有幾成時間拿著槓桿」,只打斷「買的那天剛好是大跌」那件事。
 * ⛔ 舊版用「窗口裡隨便挑日子」:錢平均在現金裡躺好幾年 → 安慰劑天生很差,真的那組贏 150/163 是假的(V81.0.3 第一版就這樣)。
 */
export function permPlacebo(ctx, lumpRows, monRows, H, opt = {}, log = console.log) {
    const R = rng(opt.seed ?? 31), NP = opt.nPlacebo ?? 30, out = {};
    const pick = (n, k) => { if (n < 2) return k; let j; do { j = Math.floor(R() * n); } while (j === k); return j; };
    const line = (s, win, n, ratio) => log(`  ${nameOf(s).padEnd(40, ' ')} 贏「同樣的時間表搬到別的起點」 ${win}/${n} ・中位 ${n ? ((med(ratio) - 1) * 100).toFixed(1) : '—'}%`);
    log(`\n━━ ${opt.tag || ''} 安慰劑:同一個做法在別的起點是第幾天買(或換進正 2 多久),搬到這個起點(各 ${NP} 次)━━`);
    const lumpS = Object.keys(lumpRows[0] || {}).filter(s => /^(wait|ladder)/.test(s));
    for (const s of lumpS) {
        const prof = lumpRows.map(r => r[s].buys.map(([i, amt]) => [i - r.i0, amt]));
        let win = 0, n = 0; const ratio = [];
        lumpRows.forEach((r, k) => {
            let acc = 0;
            for (let q = 0; q < NP; q++) {
                const m = new Map();
                for (const [dl, amt] of prof[pick(lumpRows.length, k)]) { const day = r.i0 + dl; if (day <= r.i0 + H) m.set(day, (m.get(day) || 0) + amt); }
                acc += runLump(ctx, r.i0, r.i0 + H, 'lump', { ...opt, placebo: m }).W;
            }
            const pw = acc / NP; n++; if (r[s].W > pw) win++; ratio.push(r[s].W / pw);
        });
        out[s] = { n, win, medRatio: med(ratio) }; line(s, win, n, ratio);
    }
    for (const s of Object.keys(lumpRows[0] || {}).filter(s => s.startsWith('lev'))) {
        const prof = lumpRows.map(r => r[s].eps.map(([a, b]) => [a - r.i0, b - r.i0]));
        let win = 0, n = 0; const ratio = [];
        lumpRows.forEach((r, k) => {
            let acc = 0;
            for (let q = 0; q < NP; q++) {
                const ep = prof[pick(lumpRows.length, k)].map(([a, b]) => [r.i0 + a, Math.min(r.i0 + b, r.i0 + H)]).filter(([a]) => a < r.i0 + H);
                acc += runLump(ctx, r.i0, r.i0 + H, s, { ...opt, levEp: ep }).W;
            }
            const pw = acc / NP; n++; if (r[s].W > pw) win++; ratio.push(r[s].W / pw);
        });
        out[s] = { n, win, medRatio: med(ratio) }; line(s, win, n, ratio);
    }
    for (const s of Object.keys(monRows[0] || {}).filter(s => /^(dip|boost)/.test(s))) {
        const prof = monRows.map(m => m[s].ev.map(i => i - m.i0));
        let win = 0, n = 0; const ratio = [];
        monRows.forEach((m, k) => {
            let acc = 0;
            for (let q = 0; q < NP; q++) acc += runMonthly(ctx, m.i0, m.i0 + H, s, { ...opt, placebo: new Set(prof[pick(monRows.length, k)].map(x => m.i0 + x)) }).W;
            const pw = acc / NP; n++; if (m[s].W > pw) win++; ratio.push(m[s].W / pw);
        });
        out[s] = { n, win, medRatio: med(ratio) }; line(s, win, n, ratio);
    }
    return out;
}

export function runAll(ctx, opt = {}, log = console.log) {
    const H = Math.round((opt.years ?? 10) * 252);
    const starts = monthStarts(ctx.d, ctx.f0, ctx.d.length - 1 - H);
    const LS = opt.lump || LUMP, MS = opt.mon || MON;
    if (!LS.includes('lump')) LS.unshift('lump');
    if (!MS.includes('dca')) MS.unshift('dca');
    const lumpRows = [], monRows = [];
    for (const i0 of starts) {
        const i1 = i0 + H;
        const r = { i0, d: ctx.d[i0] }, m = { i0, d: ctx.d[i0] };
        for (const s of LS) r[s] = runLump(ctx, i0, i1, s, opt);
        for (const s of MS) m[s] = runMonthly(ctx, i0, i1, s, opt);
        lumpRows.push(r); monRows.push(m);
    }
    const out = { H, starts: starts.length, from: ctx.d[starts[0]], to: ctx.d[starts.at(-1)], lump: {}, mon: {} };
    const half = r => r.d < '2010-01-01';
    log(`\n━━ ${opt.tag || ''} 一筆錢(本金 100 萬,${opt.years ?? 10} 年後全部賣掉),起點 ${out.from} ~ ${out.to} 每個月一次,共 ${starts.length} 個 ━━`);
    log('做法                                        | 10 年後中位 | 贏一次全買 | 中位比一次全買 | 最差 / 最好      | 平均中途最大回撤 | 前半 / 後半 贏');
    for (const s of LS) {
        const p = pairStats(lumpRows, s, 'lump'), a = pairStats(lumpRows.filter(half), s, 'lump'), b = pairStats(lumpRows.filter(r => !half(r)), s, 'lump');
        out.lump[s] = { ...p, h1: a && a.winPct, h2: b && b.winPct };
        const in2 = /^(lev|stat)/.test(s) ? ` ・正 2 時間 ${(mean(lumpRows.map(r => r[s].in2 ?? (s.startsWith('stat') ? 1 : 0))) * 100).toFixed(0)}%` : '';
        log(`${nameOf(s).padEnd(40, ' ')} | ${((p.medW - 1) * 100).toFixed(0).padStart(6)}% | ${s === 'lump' ? '   —   ' : `${p.win}/${p.n}`.padStart(7)} | ${((p.medRatio - 1) * 100).toFixed(1).padStart(8)}% | ${((p.worst - 1) * 100).toFixed(0)}% / ${((p.best - 1) * 100).toFixed(0)}% | ${p.mdd.toFixed(1)}% | ${a ? a.winPct.toFixed(0) : '—'}% / ${b ? b.winPct.toFixed(0) : '—'}%${in2}`);
    }
    if (MS.length < 2 && opt.noMon) return { H, starts: starts.length, from: out.from, to: out.to, lump: out.lump, placebo: permPlacebo(ctx, lumpRows, [], H, opt, log) };
    log(`\n━━ ${opt.tag || ''} 每月存 1 萬(${opt.years ?? 10} 年),跟定期定額比 ━━`);
    log('做法                                        | 10 年後中位(÷ 存的錢) | 贏定期定額 | 中位比定期定額 | 最差 / 最好 | 前半 / 後半 贏');
    for (const s of MS) {
        const p = pairStats(monRows, s, 'dca'), a = pairStats(monRows.filter(half), s, 'dca'), b = pairStats(monRows.filter(r => !half(r)), s, 'dca');
        out.mon[s] = { ...p, h1: a && a.winPct, h2: b && b.winPct };
        log(`${nameOf(s).padEnd(40, ' ')} | ${((p.medW - 1) * 100).toFixed(0).padStart(6)}% | ${s === 'dca' ? '   —   ' : `${p.win}/${p.n}`.padStart(7)} | ${((p.medRatio - 1) * 100).toFixed(1).padStart(8)}% | ${((p.worst - 1) * 100).toFixed(0)}% / ${((p.best - 1) * 100).toFixed(0)}% | ${a ? a.winPct.toFixed(0) : '—'}% / ${b ? b.winPct.toFixed(0) : '—'}%`);
    }
    out.placebo = permPlacebo(ctx, lumpRows, monRows, H, opt, log);
    out.rows = { lump: lumpRows.map(r => ({ d: r.d, ...Object.fromEntries(LS.map(s => [s, r4(r[s].W)])) })), mon: monRows.map(r => ({ d: r.d, ...Object.fromEntries(MS.map(s => [s, r4(r[s].W)])) })) };
    return out;
}
const r4 = x => +x.toFixed(4);

/** (C) 搶反彈短打:急跌那天收盤之後「隔一天」收盤買(含息資產),抱 h 天,扣來回成本;對照 = 同樣天數放現金 */
export function bounce(ctx, log = console.log, costX = 1, cashR = 0.015) {
    const CL = corrLegs(ctx.c), out = {};
    const cost = (FEE_BUY + FEE_SELL) * costX * 100;
    for (const [X, W] of [[15, 25], [10, 10], [20, 40]]) {
        const ev = firstPerLeg(fastEvents(ctx.c, X, W), CL.corr).filter(i => i >= ctx.f0);
        for (const h of [5, 20, 60]) {
            const tr = ev.map(i => { const a = i + 1, b = a + h; if (b >= ctx.P.length) return null; return { d: ctx.d[i], r: (ctx.P[b] / ctx.P[a] - 1) * 100 - cost - (Math.pow(1 + cashR, h / 252) - 1) * 100 }; }).filter(Boolean);
            if (!tr.length) continue;
            const xs = tr.map(z => z.r), m = mean(xs), sd = Math.sqrt(mean(xs.map(x => (x - m) ** 2)) * xs.length / Math.max(1, xs.length - 1));
            out[`${X}/${W}/${h}`] = { n: xs.length, mean: r2(m), med: r2(med(xs)), win: xs.filter(x => x > 0).length, t: r2(m / (sd / Math.sqrt(xs.length))), trades: tr.map(z => [z.d, r2(z.r)]) };
            log(`  急跌 ${X}%/${W} 天 → 隔天收盤買、抱 ${h} 天(扣成本 ${cost.toFixed(2)}%、扣同期現金利息):${xs.length} 次 ・平均 ${r2(m)}% ・中位 ${r2(med(xs))}% ・賺的 ${xs.filter(x => x > 0).length}/${xs.length} ・t=${r2(m / (sd / Math.sqrt(xs.length)))}`);
            if (X === 15 && h === 20) log('     ' + tr.map(z => `${z.d} ${r2(z.r)}%`).join(' ・'));
        }
    }
    return out;
}

/** 合成正 2 對真 00631L:找一段沒有斷崖的真資料,比累積報酬 */
export function check2x(ctx, rows, log = console.log) {
    if (!rows || rows.length < 100) return null;
    const px = rows.map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(r => r.c > 0);
    let best = [0, 0], s = 0;
    for (let i = 1; i <= px.length; i++) {
        const cut = i === px.length || Math.abs(px[i].c / px[i - 1].c - 1) > 0.3;
        if (cut) { if (i - s > best[1] - best[0]) best = [s, i]; s = i; }
    }
    const seg = px.slice(best[0], best[1]);
    const pos = new Map(ctx.d.map((d, i) => [d, i]));
    const a = pos.get(seg[0].d), b = pos.get(seg.at(-1).d);
    if (a == null || b == null || b - a < 100 || ctx.P2[a] == null) return null;
    const real = (seg.at(-1).c / seg[0].c - 1) * 100, syn = (ctx.P2[b] / ctx.P2[a] - 1) * 100;
    log(`  正 2 合成 vs 真 00631L(${seg[0].d} ~ ${seg.at(-1).d},${seg.length} 天沒斷崖):真的 ${r2(real)}% ・合成 ${r2(syn)}% ・差 ${r2(syn - real)} 個百分點`);
    return { from: seg[0].d, to: seg.at(-1).d, real: r2(real), syn: r2(syn) };
}

// ── selftest ─────────────────────────────────────────────────────────────────
function selftest() {
    let ok = 0, bad = 0;
    const t = (c, m) => { if (c) ok++; else { bad++; console.log('❌ ' + m); } if (c) console.log('✅ ' + m); };
    const mk = (cs, start = '2000-01-03') => { const d = []; let tm = Date.parse(start + 'T00:00:00Z'); for (let k = 0; k < cs.length; k++) { while ([0, 6].includes(new Date(tm).getUTCDay())) tm += 864e5; d.push(new Date(tm).toISOString().slice(0, 10)); tm += 864e5; } return { d, c: cs, tr: cs.slice(), a: cs.map(() => null) }; };
    // ① 平盤:一次全買 = 扣買賣成本;現金 = 照利率
    const flat = buildCtx(mk(new Array(600).fill(100)), { cashR: 0.015 });
    const L = runLump(flat, 300, 552, 'lump', { cashR: 0.015 }), C = runLump(flat, 300, 552, 'cash', { cashR: 0.015 });
    t(Math.abs(L.W - (1 - FEE_BUY) * (1 - FEE_SELL)) < 1e-9, `① 平盤一次全買 = 扣買進 + 賣出成本(${L.W.toFixed(6)})`);
    t(Math.abs(C.W - Math.pow(1.015, 252 / 252)) < 1e-9, `① 全放現金 252 天 = 年息 1.5%(${C.W.toFixed(6)})`);
    // ② 等跌 X%:跌到那天收盤才知道 → 隔天收盤買(⛔ 同一天)
    const cs = new Array(300).fill(100).concat([98, 95, 92, 88, 85, 84, 90, 95, 100]).concat(new Array(300).fill(100));
    const ctx2 = buildCtx(mk(cs), {});
    const w = runLump(ctx2, 290, 600, 'wait:15:0', {});
    t(w.buys.length === 1 && w.buys[0][0] === 305, `② 等跌 15%:收盤 85(第 304 天)看到 → 第 305 天收盤買(${w.buys.map(b => b[0])})`);
    // 改掉之後的價格,前面的決定不變(⛔ 前視)
    const cs2 = cs.slice(); for (let k = 306; k < cs2.length; k++) cs2[k] = 50;
    const w2 = runLump(buildCtx(mk(cs2), {}), 290, 600, 'wait:15:0', {});
    t(w2.buys[0][0] === 305, '② 改掉之後的價格,買進那天不變(⛔ 前視)');
    // ③ 分批承接:−10 / −15 / −20 / −25 各 1/4
    const cs3 = new Array(300).fill(100).concat([95, 90, 85, 80, 75, 74, 80, 90, 100]).concat(new Array(300).fill(100));
    const l3 = runLump(buildCtx(mk(cs3), {}), 290, 600, 'ladder:0:0', {});
    t(l3.buys.length === 4 && l3.buys.map(b => b[0]).join() === '302,303,304,305' && l3.buys.every(b => Math.abs(b[1] - 0.25) < 1e-9),
        `③ 分批承接:跌到 90 / 85 / 80 / 75 的隔天各買 1/4(${l3.buys.map(b => b[0] + ':' + b[1].toFixed(3))})`);
    // ④ 再平衡:漲一倍之後 70/30 要賣回 70%
    const cs4 = new Array(300).fill(100).concat(new Array(50).fill(200)).concat(new Array(260).fill(200));
    const ctx4 = buildCtx(mk(cs4), { cashR: 0 });
    const A = runLump(ctx4, 299, 600, 'reb:70:5', { cashR: 0 });
    t(A.buys.length === 1 && A.W > 1.5 && A.W < 1.75, `④ 70/30:漲一倍後賣回目標,最後 ≈ 1.7(${A.W.toFixed(3)})`);
    // ⑤ 神:兩次新高之間最低那天
    const g = godDays([1, 2, 1.5, 1.2, 1.8, 3, 2.5, 4], 0);
    t([...g].sort((a, b) => a - b).join() === '3,6', `⑤ 神的買點 = 新高之間的最低點(${[...g]})`);
    // ⑥ 合成正 2:每天 +1% → 每天 +2% − 成本
    const p6 = [1]; for (let k = 1; k < 260; k++) p6.push(p6[k - 1] * 1.01);
    const s6 = synth2x(p6, 0, 0.015);
    t(Math.abs(s6[259] - Math.pow(1.02 - 0.025 / 252, 259)) < 1e-9, '⑥ 合成正 2 = 每天 2 倍報酬 − (利率 + 1%)/252');
    // ⑦ 決定性對照:先跌 40% 再漲到 1.3 倍 → 等跌 20% 贏一次全買;一路慢漲 → 等跌永遠買不到、一次全買贏
    const v7 = new Array(300).fill(100);
    for (let k = 1; k <= 100; k++) v7.push(100 * (1 - 0.4 * k / 100));
    for (let k = 1; k <= 200; k++) v7.push(60 + 70 * k / 200);
    for (let k = 0; k < 100; k++) v7.push(130);
    const c7 = buildCtx(mk(v7), {});
    const W7 = runLump(c7, 299, 699, 'wait:20:0', {}).W, L7 = runLump(c7, 299, 699, 'lump', {}).W;
    const up = [100]; for (let k = 1; k < 1000; k++) up.push(up[k - 1] * 1.0005);
    const cU = buildCtx(mk(up), {});
    const wu = runLump(cU, 300, 900, 'wait:10:0', {}), lu = runLump(cU, 300, 900, 'lump', {});
    t(W7 > L7 * 1.2 && lu.W > wu.W && wu.buys.length === 0,
        `⑦ 跌深再大漲的世界等跌贏(${W7.toFixed(2)} > ${L7.toFixed(2)})、一路慢漲等不到(${wu.buys.length} 筆)一次全買贏(${lu.W.toFixed(2)} > ${wu.W.toFixed(2)})`);
    // ⑧ 每月存:定期定額每個月都買;鋸齒往上的世界(每次新高後先跌 10% 再漲 22%)神贏定期定額
    const mo = runMonthly(flat, 300, 552, 'dca', { cashR: 0 });
    t(mo.put === 12 || mo.put === 13, `⑧ 定期定額每個月第一天各存 1(共 ${mo.put} 次)`);
    const sw = [100]; for (let k = 1; k < 2600; k++) { const ph = k % 100; sw.push(sw[k - 1] * (ph < 50 ? Math.pow(0.9, 1 / 50) : Math.pow(1.22, 1 / 50))); }
    const cS = buildCtx(mk(sw), {});
    const gm = runMonthly(cS, 300, 2300, 'god', {}), dm = runMonthly(cS, 300, 2300, 'dca', {});
    t(gm.W > dm.W && gm.trig >= 15, `⑧ 鋸齒往上的世界神贏定期定額(${gm.W.toFixed(3)} > ${dm.W.toFixed(3)},買 ${gm.trig} 次)`);
    // ⑨ 安慰劑:同一批觸發日子當安慰劑 → 結果一模一樣(安慰劑接線沒寫歪)
    const dr = runMonthly(c7, 299, 699, 'dip:20:0', {});
    const days = new Set(dr.buys.map(b => b[0]));
    const pl = runMonthly(c7, 299, 699, 'dip:20:0', { placebo: days });
    t(Math.abs(pl.W - dr.W) < 1e-12, `⑨ 安慰劑用同一批日子 = 原本(${pl.W.toFixed(4)} = ${dr.W.toFixed(4)})`);
    // ⑩ 換窗口安慰劑的接線:把自己的時間表搬回自己 → 一模一樣(等跌 / 正 2 換進換出 / 每月存錢含「等太久補買」)
    const wr = runLump(c7, 299, 699, 'wait:20:0', {});
    const wm = new Map(wr.buys.map(([i, a]) => [i, a]));
    t(Math.abs(runLump(c7, 299, 699, 'lump', { placebo: wm }).W - wr.W) < 1e-12, '⑩ 等跌那次的時間表原封不動搬回去 = 原本');
    const lr = runLump(c7, 299, 699, 'lev:20:50', {});
    t(lr.eps.length === 1 && Math.abs(runLump(c7, 299, 699, 'lev:20:50', { levEp: lr.eps }).W - lr.W) < 1e-12 && lr.in2 > 0,
        `⑩ 正 2 換進換出照同一批日子重播 = 原本(${lr.eps.map(e => e.join('→'))},時間 ${(lr.in2 * 100).toFixed(0)}%)`);
    const mr = runMonthly(c7, 299, 699, 'dip:20:6', {});
    t(mr.ev.length >= 2 && Math.abs(runMonthly(c7, 299, 699, 'dip:20:6', { placebo: new Set(mr.ev) }).W - mr.W) < 1e-12,
        `⑩ 每月存錢:跌到才買 + 等 6 個月補買那幾天重播 = 原本(${mr.ev.length} 次)`);
    // ⑪ 正 2:一直放 30% 的那組要真的有 30% 左右在正 2;跌深再大漲的世界,大跌才換正 2 贏一次全買
    const st = runLump(c7, 299, 699, 'stat:30', {});
    t(st.W > runLump(c7, 299, 699, 'lump', {}).W && lr.W > runLump(c7, 299, 699, 'lump', {}).W, '⑪ 跌深再大漲:大跌換正 2、一直放正 2 都贏一次全買');
    // ⑫ 價格版:沒有含息那條也能跑(P = 價格)
    const pc = buildCtx({ ...mk(v7), tr: v7.map(() => null) }, { price: true });
    t(pc.f0 === 0 && pc.P[10] === v7[10], '⑫ price:true 用價格那條(含息那條是空的也跑得動)');
    console.log(`\n${bad ? '❌' : '✅'} crash_playbook selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('crash_playbook_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const opt = { cashR: +(process.env.CASH_R ?? 0.015), costX: +(process.env.COSTX ?? 1), years: +(process.env.YEARS ?? 10) };
    const S = loadIndex();
    const ctx = buildCtx(S, opt);
    console.log(`加權報酬指數 ${S.d[ctx.f0]} ~ ${S.d.at(-1)}(${S.d.length - ctx.f0} 天)・現金年息 ${opt.cashR * 100}% ・成本 ×${opt.costX}`);
    const out = { opt, idx: runAll(ctx, { ...opt, tag: '加權報酬指數' }) };
    // 正 2 費用敏感度:合成正 2 跟真 00631L 對過一段 → 合成比較樂觀(差 ~4%/年)→ 費用拉到 4% / 6% 再看一次
    const LEV = ['lev:15:30', 'lev:20:30', 'lev:25:30', 'lev:15:50', 'lev:20:50', 'lev:25:50', 'stat:30', 'stat:50'];
    out.fee2x = {};
    for (const fee of [0.04, 0.06]) {
        out.fee2x[fee] = runAll(buildCtx(S, { ...opt, fee2x: fee }), { ...opt, lump: LEV.slice(), mon: ['dca'], noMon: true, nPlacebo: 10,
            tag: `正 2 每年多扣 ${(fee * 100).toFixed(0)}%(合成比真的樂觀,保守一點)` });
    }
    // 加權「價格」2000 起(不含息,但走得到 2000~2002 那段空頭)
    out.price2000 = runAll(buildCtx(S, { ...opt, price: true }), { ...opt, nPlacebo: 10, tag: '加權價格(不含息)2000 起' });
    console.log('\n━━ 搶反彈短打 ━━');
    out.bounce = bounce(ctx, console.log, opt.costX, opt.cashR);
    const lev = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', '00631L.json');
    if (fs.existsSync(lev)) { try { out.check2x = check2x(ctx, JSON.parse(fs.readFileSync(lev, 'utf8'))); } catch (_) { /* 只是對照 */ } }
    if (process.env.D16) {
        const b = JSON.parse(fs.readFileSync(path.join(process.env.D16, '_bench0050.json'), 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-'), c: +r.close })).filter(r => r.c > 0);
        const dv = JSON.parse(fs.readFileSync(path.join(process.env.D16, '_div0050.json'), 'utf8')).d['0050'].h;
        const T = trSeries(b, dv, {});
        const pos = new Map(T.d.map((d, i) => [d, i]));
        // ⚠️ 0050 那份有缺的日子(加權有開盤、0050 那天沒資料)→ 沿用前一天;0050 最後一天之後整段切掉(⛔ 用 null 算出 NaN)
        let tr2 = S.d.map(d => (pos.has(d) ? T.v[pos.get(d)] : null));
        const fst = tr2.findIndex(v => v != null), lst = tr2.findLastIndex(v => v != null);
        let fill = 0;
        for (let i = fst + 1; i <= lst; i++) if (tr2[i] == null) { tr2[i] = tr2[i - 1]; fill++; }
        const cut = lst + 1;
        const S2 = { d: S.d.slice(0, cut), c: S.c.slice(0, cut), a: S.a.slice(0, cut), tr: tr2.slice(0, cut) };
        const ok2 = S2.tr.filter(v => v != null).length;
        if (ok2 > 2000) {
            console.log(`\n真 0050 含息(${T.d[0]} ~ ${T.d.at(-1)},對到加權 ${ok2} 天,其中 ${fill} 天沒資料沿用前一天)`);
            out.e0050 = runAll(buildCtx(S2, opt), { ...opt, years: Math.min(opt.years, 10), nPlacebo: 10, tag: '真 0050 含息' });
        }
    }
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out));
}
