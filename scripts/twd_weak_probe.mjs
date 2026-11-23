// 💱 twd_weak_probe.mjs —— 台幣貶到一年最弱、台股又在修正中 → 之後台股是不是比較慢回來?(EXP-20261123-01,事先登記)
//
// 為什麼要測:11/23 使用者聽到「台幣破 33、錢已經出去了,台股要很久才爬上來」,問是不是真的、是的話能不能做成告警。
//   照規則:大盤層級的「之後會怎樣」要先驗證過,才能做成會跳出來的提醒(.claude/rules/linkage.md「大盤層級的警示」)。
// ⛔ 不用「33」這個固定數字:2000~2026 台幣在 27.7~35.2 之間,同一個數字在不同年代意思不同
//   → 改用「台幣一年位置」(人性頁 mood_build.yearPos 同一支:那一筆跟它之前 365 個日曆天比,同分算一半)≥ 95 = 一年最弱 5% 以內。
//
// 資料:加權 2000 起(lib_crash.loadIndex)+ 美國聯準會 DEXTAUS(fred_hist.json series.usdtwd,紐約中午)
//       韓國綜合指數 ^KS11(world_hist.json.gz,1996 起)+ DEXKOUS(series.krw)= 第二個市場(驗證用)
//       外資現貨每日(fi_mkt_hist.json spot[0],億,2004 起)= 只描述
// 時間點(⛔ 前視):第 i 天收盤時看得到的匯率 = 日期比那天早的最後一筆(usd_dd_probe.fxPrev 同一套;比那天早超過 10 天 → 當成沒有);
//   一年位置要有滿一年的歷史才算;修正段只用到那天的收盤(lib_crash.corrLegs:離 250 天高點 ≥10% 開始、回到 5% 以內結束);
//   外資是盤後公布 → 成績一律從「隔一個交易日收盤」起算(保守)。
// 事件:修正段裡第一次「看得到的匯率一年位置 ≥ 95」那天(每一段只算一次)。
// 對手:同一個市場、同一種修正段裡隨便一天(lib_crash.evVsCorr,從一年位置算得出來那天起;陷阱 #50)。
// ⭐ 判定(EXP 寫死,⛔ 跑完再改)見 RULE / judge():只用到 2026-11-06(之後封存,只描述現在這一段)。
//
// 跑法:IDX_LONG IDX_EARLY TWII_NOW FRED_HIST WORLD_HIST [FI_HIST] node scripts/twd_weak_probe.mjs [out.json]
//       node scripts/twd_weak_probe.mjs --selftest
import fs from 'fs';
import zlib from 'zlib';
import { loadIndex, corrLegs, firstPerLeg, evVsCorr, after, mean, med, r2, rng } from './lib_crash.mjs';
import { loadFx, fxPrev } from './usd_dd_probe.mjs';
import { yearPos, rankPct, fiSums, FI_WIN } from './mood_build.mjs';

// ⭐ 事先登記的判定(EXP-20261123-01 寫死;⛔ 跑完再改)
//   台灣:120 天比修正段隨便一天差 ≥ effect 個百分點・「比較差」那一側 p ≤ p・≥ minN 次
//   韓國:同方向(差 < 0)・≥ krMinN 次
//   安慰劑:匯率整串往前挪 shift 個交易日(拿一年前的位置)跑同一套 → |差距| < 真的那個的一半
export const RULE = { POS: 95, W: 250, DD: 10, END: 5, h: 120, minN: 8, effect: 5, p: 0.05, krMinN: 5, shift: 250, cut: '2026-11-06' };
export const HS = [60, 120, 250];
export const STALE = 10;        // 看得到的那一筆匯率比那天早超過 10 個日曆天 → 當成沒有(⛔ 拿很舊的匯率排位置)
export const FI_MIN = 250;      // 外資 20 日合計排第幾:前面至少要有 250 個(人性頁是近 3 年 = 750 個;早年不到一年的 ⛔ 排)
export const DESC_POS = [90, 99];

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayGap = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

/** 每一筆匯率的一年位置(人性頁 mood_build.yearPos 同一支;前面不滿一年 → null) */
export function fxYearPos(F) {
    const pts = F.d.map((d, k) => [d, F.v[k]]), out = new Array(F.d.length).fill(null);
    let lo = 0;
    for (let j = 0; j < pts.length; j++) {
        const cut = addDays(F.d[j], -365);
        if (F.d[0] > cut) continue;                          // 歷史不到一年
        while (lo < j && F.d[lo] <= cut) lo++;
        out[j] = yearPos(pts.slice(lo, j), F.v[j], F.d[j]).pct;   // 只切出那一年(yearPos 自己再篩一次:> cut 且 < 那天)
    }
    return out;
}

/** 第 i 天收盤時看得到的那一筆(usd_dd_probe.fxPrev:日期比那天早的最後一筆,⛔ 同一天)→ { fx, pos, fd } */
export function onDays(Sd, F, posF) {
    const fx = fxPrev(Sd, F), pos = fxPrev(Sd, { d: F.d, v: posF }), fd = fxPrev(Sd, { d: F.d, v: F.d });
    for (let i = 0; i < Sd.length; i++) if (fd[i] == null || dayGap(fd[i], Sd[i]) > STALE) { fx[i] = null; pos[i] = null; fd[i] = null; }
    return { fx, pos, fd };
}

/** 截到 cut(含)為止 */
export function cutTo(S, cut) { let n = S.d.length; while (n > 0 && S.d[n - 1] > cut) n--; return { d: S.d.slice(0, n), c: S.c.slice(0, n) }; }
export function cutFx(F, cut) { let n = F.d.length; while (n > 0 && F.d[n - 1] > cut) n--; return { d: F.d.slice(0, n), v: F.v.slice(0, n) }; }

/** 訊號那天:修正段裡、位置 ≥ POS(pos 可以是任何「越大越極端」的分數);每一段只算第一次 */
export function signals(corr, pos, POS = RULE.POS) {
    const ev = [];
    for (let i = 0; i < pos.length; i++) if (corr[i] >= 0 && pos[i] != null && pos[i] >= POS) ev.push(i);
    return firstPerLeg(ev, corr);
}

/** 第 s 天收盤之後(那一段 = 訊號那天 sig 所在的段):回到「起跌前高點」5% 以內要幾個交易日(到資料最後都沒回到 → null)、120 天內有沒有再跌 1 成 */
export function pathAfter(c, legs, corr, sig, s) {
    const L = legs[corr[sig]];
    let rec = null;
    if (L) { const tgt = L.peak * (1 - RULE.END / 100); for (let k = s + 1; k < c.length; k++) if (c[k] >= tgt) { rec = k - s; break; } }
    let fall = null;
    if (s + 120 < c.length) { fall = false; for (let k = s + 1; k <= s + 120; k++) if (c[k] <= c[s] * 0.9) { fall = true; break; } }
    return { rec, left: c.length - 1 - s, fall };
}
/** H 天內回到高點附近的比例(還看不到 H 天、也還沒回到的 ⛔ 算) */
export function recShare(rows, H) {
    const ok = rows.filter(r => (r.rec != null && r.rec <= H) || r.left >= H);
    return ok.length ? r2(ok.filter(r => r.rec != null && r.rec <= H).length / ok.length * 100) : null;
}
const fallShare = rows => { const ok = rows.filter(r => r.fall != null); return ok.length ? r2(ok.filter(r => r.fall).length / ok.length * 100) : null; };

/** 一個市場跑一次:opt = { posF, shift, POS, sig(自己給訊號日), from, rot(整串循環挪幾天), hs, sims } */
export function runMarket(S, F, opt = {}) {
    const posF = opt.posF || fxYearPos(F), V = onDays(S.d, F, posF);
    const CL = corrLegs(S.c, RULE.W, RULE.DD, RULE.END);
    let pos = V.pos;
    const f0 = pos.findIndex(x => x != null);
    if (f0 < 0) throw new Error('匯率一年位置一筆都算不出來(匯率跟指數沒有重疊?)');
    if (opt.shift) pos = pos.map((_, i) => i - opt.shift >= 0 ? V.pos[i - opt.shift] : null);
    if (opt.rot) { const L = pos.length - f0; pos = pos.map((_, i) => i < f0 ? null : V.pos[f0 + (((i - f0 - opt.rot) % L) + L) % L]); }
    const from = Math.max(f0, opt.from || 0);
    const sig = (opt.sig || signals(CL.corr, pos, opt.POS ?? RULE.POS)).filter(i => i >= from && i + 1 < S.c.length);
    const ev = sig.map(i => i + 1);                                           // 隔一個交易日收盤才算
    const R = evVsCorr({ d: S.d, c: S.c }, S.c, CL, ev, opt.hs || HS, 7, opt.sims || 2000, from);
    if (opt.lite) return R;
    R.rows = sig.map(i => {
        const s = i + 1, P = pathAfter(S.c, CL.legs, CL.corr, i, s), x = h => r2(after(S, S.c, CL.legs, CL.corr, s, h).x);
        return { d: S.d[i], fx: V.fx[i], fxd: V.fd[i], pos: pos[i], dd: r2((S.c[i] / CL.hi[i] - 1) * 100), r60: x(60), r120: x(120), r250: x(250), rec: P.rec, left: P.left, fall: P.fall };
    });
    const pool = []; for (let q = from; q < S.c.length; q++) if (CL.corr[q] >= 0) pool.push(pathAfter(S.c, CL.legs, CL.corr, q, q));
    R.rec250 = recShare(R.rows, 250); R.rec250Base = recShare(pool, 250);
    R.rec500 = recShare(R.rows, 500); R.rec500Base = recShare(pool, 500);
    R.fall10 = fallShare(R.rows); R.fall10Base = fallShare(pool);
    const x120 = R.rows.map(r => r.r120).filter(v => v != null), b = (R.h[120] || {}).base;
    R.med120 = r2(med(x120));
    if (x120.length >= 3 && b != null) { const w = x120.slice().sort((a, c) => a - c); R.dropWorst = r2(mean(w.slice(1)) - b); R.dropBest = r2(mean(w.slice(0, -1)) - b); }
    R.legsAll = CL.legs.filter(L => L.e >= from).length;
    return R;
}

/** ⭐ 事先登記的判定(五條都要過) */
export function judge(T, K, P) {
    const t = T.h[RULE.h] || {}, k = K.h[RULE.h] || {}, p = P.h[RULE.h] || {};
    const c1 = (t.n || 0) >= RULE.minN;
    const c2 = t.diff != null && t.diff <= -RULE.effect;
    const c3 = t.pLo != null && t.pLo <= RULE.p;
    const c4 = (k.n || 0) >= RULE.krMinN && k.diff != null && k.diff < 0;
    const c5 = p.diff != null && t.diff != null && Math.abs(p.diff) < Math.abs(t.diff) / 2;
    return { pass: [c1, c2, c3, c4, c5], verdict: c1 && c2 && c3 && c4 && c5 ? '✅ 台幣一年最弱 + 修正中 → 之後 120 天真的比較差' : '⛔ 沒有比較慢回來(或樣本不夠)' };
}

/** 外資 20 日合計(fiSums 同一支,人性頁那一格)→ 每個交易日「賣超有多極端」的分數 = 100 − 排第幾(越大 = 賣越多);前面不到 FI_MIN 個 → null */
export function fiSellScore(Sd, FM) {
    const fs_ = fiSums(FM, null, [20]);
    const out = new Array(Sd.length).fill(null);
    if (!fs_) return out;
    const R = fs_.roll[20], at = new Map(Sd.map((d, i) => [d, i]));
    for (let k = FI_MIN; k < R.length; k++) {
        const i = at.get(R[k][0]); if (i == null) continue;
        const pc = rankPct(R.slice(Math.max(0, k - FI_WIN), k).map(x => x[1]), R[k][1]).pct;
        if (pc != null) out[i] = r2(100 - pc);
    }
    return out;
}

/** world_hist.json(.gz)→ 韓國綜合指數 { d, c } */
export function loadKs(buf, key = '^KS11') {
    const txt = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const j = JSON.parse(txt), s = j && j.s && j.s[key];
    if (!s || !Array.isArray(s.d) || !Array.isArray(s.c) || s.d.length !== s.c.length || s.d.length < 500) throw new Error(`world_hist 沒有 ${key}(或太短)`);
    return { d: s.d.slice(), c: s.c.map(Number) };
}

export function run(S0, F0, K0, FK0, FM = null, log = console.log) {
    const S = cutTo(S0, RULE.cut), F = cutFx(F0, RULE.cut), K = cutTo(K0, RULE.cut), FK = cutFx(FK0, RULE.cut);
    const posF = fxYearPos(F), posK = fxYearPos(FK);
    const T = runMarket(S, F, { posF }), KR = runMarket(K, FK, { posF: posK }), P = runMarket(S, F, { posF, shift: RULE.shift });
    const J = judge(T, KR, P);
    const out = { rule: RULE, cut: RULE.cut, tw: T, kr: KR, placebo: P, judged: J, desc: {} };
    const show = (zh, R) => {
        const a = R.h[60] || {}, b = R.h[120] || {}, c = R.h[250] || {};
        log(`  ${zh}:${R.n} 次(${R.legsAll} 段修正)・60 天 ${a.ev}% vs ${a.base}% → ${a.diff}pp・120 天 ${b.ev}% vs ${b.base}% → ${b.diff}pp(比較差那一側 p ${b.pLo}・前半 ${b.h1} / 後半 ${b.h2}・有漲 ${b.up}% vs ${b.upBase}%)・250 天 ${c.ev}% vs ${c.base}% → ${c.diff}pp`);
        if (R.rec250 !== undefined) log(`    1 年內回到起跌前高點 5% 以內 ${R.rec250}%(隨便一天 ${R.rec250Base}%)・2 年內 ${R.rec500}%(${R.rec500Base}%)・120 天內再跌 1 成 ${R.fall10}%(${R.fall10Base}%)・120 天中位 ${R.med120}%・拿掉最差一筆 ${R.dropWorst}pp`);
    };
    const rowsOut = R => R.rows.map(r => `${r.d} 匯率 ${r.fx}(位置 ${r.pos})離高點 ${r.dd}% → 60 天 ${r.r60}%・120 天 ${r.r120}%・250 天 ${r.r250}%・回到高點附近 ${r.rec == null ? `還沒(${r.left} 天)` : r.rec + ' 天'}${r.fall ? '・之後再跌 1 成' : ''}`).forEach(x => log('    ・' + x));
    log(`💱 台幣一年位置 ≥ ${RULE.POS} + 加權修正中(離 250 天高點 ≥${RULE.DD}%),每一段第一次、隔天收盤起算;判定資料到 ${RULE.cut}`);
    log(`⭐ 判的那一個(台灣,${S.d[0]} ~ ${S.d.at(-1)},一年位置 ${T.from} 起算得出來):`);
    show('台灣', T); rowsOut(T);
    log(`⭐ 第二個市場(韓國綜合指數 + 美元兌韓元,${K.d[0]} ~ ${K.d.at(-1)}):`);
    show('韓國', KR); rowsOut(KR);
    log(`⭐ 安慰劑(匯率整串往前挪 ${RULE.shift} 個交易日):`); show('安慰劑', P);
    log(`  → ${J.pass.map(x => x ? '✓' : '✗').join('')} ${J.verdict}`);
    log('・只描述(⛔ 拿來判):');
    for (const v of DESC_POS) { const R = runMarket(S, F, { posF, POS: v }); out.desc['pos' + v] = R; show(`一年位置 ≥ ${v}`, R); }
    const A = runMarket(S, F, { posF, POS: -1 }); out.desc.any = A; show('段落第一天(不管台幣)', A);
    // 整串循環挪很多次:真的那個排第幾(只描述)
    const f0 = onDays(S.d, F, posF).pos.findIndex(x => x != null), L = S.d.length - f0, rots = [];
    for (let k = 250; k <= L - 250; k += 125) { const R = runMarket(S, F, { posF, rot: k, lite: true, hs: [120], sims: 1 }); if ((R.h[120] || {}).diff != null) rots.push(R.h[120].diff); }
    const td = (T.h[120] || {}).diff;
    out.desc.rot = { n: rots.length, le: td == null ? null : rots.filter(x => x <= td).length, med: r2(med(rots)), min: r2(Math.min(...rots)), max: r2(Math.max(...rots)) };
    log(`  整串循環挪 ${rots.length} 次(每 125 天):挪過的差距中位 ${out.desc.rot.med}pp(${out.desc.rot.min} ~ ${out.desc.rot.max});跟真的一樣差或更差 ${out.desc.rot.le} 次`);
    if (FM) {
        const fz = fiSellScore(S.d, FM), ff = fz.findIndex(x => x != null);
        if (ff >= 0) {
            const CL = corrLegs(S.c, RULE.W, RULE.DD, RULE.END), V = onDays(S.d, F, posF);
            for (const [id, th, zh] of [['fi5', 95, '外資 20 日賣超到近 3 年前 5%'], ['fi2', 98, '外資 20 日賣超到近 3 年前 2%']]) {
                const R = runMarket(S, F, { posF, sig: signals(CL.corr, fz, th), from: ff }); out.desc[id] = R; show(`${zh}(${S.d[ff]} 起)`, R); rowsOut(R);
            }
            const both = fz.map((x, i) => x != null && V.pos[i] != null && V.pos[i] >= RULE.POS && x >= 95 ? 1 : null);
            const R = runMarket(S, F, { posF, sig: signals(CL.corr, both, 1), from: ff }); out.desc.twdfi = R; show('台幣一年最弱 + 外資 20 日賣超前 5%(同一天)', R); rowsOut(R);
        } else log('  外資:排不出第幾(fi_mkt_hist 太短)');
    } else log('  外資:沒給 FI_HIST,跳過');
    return out;
}

/** 現在這一段(封存期,只描述):用完整資料看最後一天 */
export function nowState(S0, F0) {
    const posF = fxYearPos(F0), V = onDays(S0.d, F0, posF), CL = corrLegs(S0.c, RULE.W, RULE.DD, RULE.END), i = S0.d.length - 1;
    const k = CL.corr[i], sig = signals(CL.corr, V.pos).filter(j => CL.corr[j] === k && k >= 0);
    return { d: S0.d[i], fx: V.fx[i], fxd: V.fd[i], pos: V.pos[i], dd: r2((S0.c[i] / CL.hi[i] - 1) * 100), inLeg: k >= 0, legStart: k >= 0 ? S0.d[CL.legs[k].s] : null, sig: sig.length ? S0.d[sig[0]] : null };
}

// ───────────────────────────── selftest(合成世界,⛔ 碰真資料)
export function bdays(n, y0 = 2000) { const out = []; for (let t = Date.UTC(y0, 0, 3); out.length < n; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) out.push(new Date(t).toISOString().slice(0, 10)); } return out; }
/** 合成一個市場:匯率是自己的隨機漫步(跟股價無關 → 安慰劑天生 ≈ 0);股價每 500 天一段大跌。
 *  plant = 修正中第一次「匯率一年位置 ≥ 95」之後 120 天每天多跌 plant;early = 每一段前 120 天每天多跌(不管匯率,干擾項)
 *  flat = 沒有固定形狀的大跌、純隨機漫步(每天 ±2%):段落前段 ⛔ 天生比較差 → 安慰劑應該 ≈ 0 */
export function world(n, seed, opt = {}) {
    const days = bdays(n), R = rng(seed), fx = [30];
    for (let i = 1; i < n; i++) fx.push(fx[i - 1] * (1 + Math.sin(i / 97 + seed) * 0.0007 + Math.sin(i / 331) * 0.0005 + (R() - 0.5) * 0.004));
    const F = { d: days.slice(), v: fx }, V = onDays(days, F, fxYearPos(F));
    const c = [100], done = new Set();
    let inLeg = false, legId = -1, legStart = -1, until = -1;
    for (let i = 1; i < n; i++) {
        const ph = i % 500;
        let r = opt.flat ? (R() - 0.5) * 0.04 + 0.0003 : (R() - 0.5) * 0.016 + 0.0004;
        if (!opt.flat && ph >= 200 && ph < 290) r -= 0.0045;
        if (opt.early && inLeg && i - legStart <= 120) r -= opt.early;
        if (opt.plant && i <= until) r -= opt.plant;
        c.push(c[i - 1] * (1 + r));
        let hi = 0; for (let k = Math.max(0, i - 249); k <= i; k++) if (c[k] > hi) hi = c[k];
        const d = c[i] / hi - 1;
        if (!inLeg) { if (d <= -RULE.DD / 100) { inLeg = true; legId++; legStart = i; } }
        else if (d > -RULE.END / 100) inLeg = false;
        if (opt.plant && inLeg && !done.has(legId) && V.pos[i] != null && V.pos[i] >= RULE.POS) { done.add(legId); until = i + 121; }
    }
    return { S: { d: days, c }, F };
}

function selftest() {
    let bad = 0; const ok = (nm, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${nm}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // ① 一年位置 = 人性頁 yearPos 拿整串去算的同一個數字;前面不滿一年 → null
    const G = world(1500, 5).F, pf = fxYearPos(G), pts = G.d.map((d, k) => [d, G.v[k]]);
    const js = [270, 400, 777, 1499], same = js.every(j => pf[j] === yearPos(pts, G.v[j], G.d[j]).pct);
    ok('① 一年位置跟人性頁 yearPos(整串)一模一樣;不滿一年的是 null', same && pf[10] == null && pf[250] == null && pf[270] != null, JSON.stringify(js.map(j => [pf[j], yearPos(pts, G.v[j], G.d[j]).pct])));
    // ② 看得到的匯率:比那天早的最後一筆(⛔ 同一天);斷超過 10 天 → 沒有
    const V2 = onDays(['2024-01-03', '2024-01-04', '2024-01-30'], { d: ['2024-01-02', '2024-01-04'], v: [30, 31] }, [50, 99]);
    ok('② 1/4 只看得到 1/2(同一天那筆 ⛔ 用);1/30 那筆是 26 天前 → 沒有', V2.fx[0] === 30 && V2.fx[1] === 30 && V2.pos[1] === 50 && V2.fx[2] == null && V2.pos[2] == null, JSON.stringify(V2));
    // ③ 埋了效果(台灣 + 韓國都埋)→ ✅;④ 同一套沒埋 → ⛔
    const P = world(6000, 11, { plant: 0.0015 }), Pk = world(6000, 23, { plant: 0.0015 });
    const run3 = (A, B) => { const T = runMarket(A.S, A.F), K = runMarket(B.S, B.F), Pl = runMarket(A.S, A.F, { shift: RULE.shift }); return { T, K, Pl, J: judge(T, K, Pl) }; };
    const r3 = run3(P, Pk);
    ok('③ 埋了「之後 120 天多跌」(兩個市場都埋)→ ✅ 五條都過', r3.J.verdict.startsWith('✅') && r3.J.pass.every(Boolean), JSON.stringify({ pass: r3.J.pass, t: r3.T.h[120], k: (r3.K.h[120] || {}).diff, pl: (r3.Pl.h[120] || {}).diff }));
    const Z = world(6000, 11), Zk = world(6000, 23), r4 = run3(Z, Zk);
    // ⚠️ 這個世界的大跌是固定形狀(段落前段一定還在跌)→ 前四條會過、靠第 5 條安慰劑擋下 —— 這正是要有安慰劑的原因(真資料一樣要看)
    ok('④ 決定性對照:同一個亂數世界沒埋 → ⛔(而且是第 5 條安慰劑擋下的)', r4.J.verdict.startsWith('⛔') && !r4.J.pass[4], JSON.stringify({ pass: r4.J.pass, t: (r4.T.h[120] || {}).diff, pl: (r4.Pl.h[120] || {}).diff }));
    // ④b 沒有固定形狀的純隨機漫步(6 個亂數世界):安慰劑 ≈ 0、6 個全部 ⛔
    const flat = [1, 2, 3, 4, 5, 6].map(sd => { const A = world(6000, sd, { flat: true }), B = world(6000, sd + 50, { flat: true }); return run3(A, B); });
    const plM = mean(flat.map(r => (r.Pl.h[120] || {}).diff ?? 0)), tM = mean(flat.map(r => (r.T.h[120] || {}).diff ?? 0));
    ok('④b 純隨機漫步 6 個世界:安慰劑平均 ≈ 0(|平均| < 3pp)、真的那個平均也 ≈ 0、6 個全部 ⛔', Math.abs(plM) < 3 && Math.abs(tM) < 3 && flat.every(r => r.J.verdict.startsWith('⛔')), JSON.stringify({ plM, tM, v: flat.map(r => r.J.pass.map(x => +x).join('')) }));
    // ⑤ 干擾項:每一段前 120 天本來就弱(跟匯率無關)→ 真的那個看起來差,但安慰劑一樣差 → 第 5 條擋下來
    const E = world(6000, 11, { early: 0.003 }), Ek = world(6000, 23, { early: 0.003 }), r5 = run3(E, Ek);
    const tE = (r5.T.h[120] || {}).diff, pE = (r5.Pl.h[120] || {}).diff;
    ok('⑤ 「段落前段本來就弱」的世界:真的差 ≤ −5 也一樣 → 安慰劑一樣差、第 5 條 ✗ → ⛔', tE != null && tE <= -RULE.effect && !r5.J.pass[4] && r5.J.verdict.startsWith('⛔'), JSON.stringify({ tE, pE, pass: r5.J.pass }));
    // ⑥ 韓國反方向 → 第 4 條 ✗
    const Kr = world(6000, 23, { plant: -0.0015 }), r6 = run3(P, Kr);
    ok('⑥ 台灣埋了、韓國反方向(之後比較好)→ 第 4 條 ✗ → ⛔', !r6.J.pass[3] && r6.J.verdict.startsWith('⛔'), JSON.stringify({ k: (r6.K.h[120] || {}).diff, pass: r6.J.pass }));
    ok('⑥ 少於 8 次 → 判樣本不夠(⛔ 硬判)', !judge({ h: { 120: { n: 5, diff: -20, pLo: 0.001 } } }, { h: { 120: { n: 9, diff: -3 } } }, { h: { 120: { diff: 0 } } }).pass[0]);
    // ⑦ ⛔ 前視:改掉第 3,500 天之後的價格與匯率,之前的訊號一個都不變
    const CLa = corrLegs(Z.S.c, RULE.W, RULE.DD, RULE.END), sa = signals(CLa.corr, onDays(Z.S.d, Z.F, fxYearPos(Z.F)).pos).filter(i => i < 3400);
    const Zb = { S: { d: Z.S.d, c: Z.S.c.map((x, i) => i > 3500 ? x * 1.6 : x) }, F: { d: Z.F.d, v: Z.F.v.map((x, i) => i > 3500 ? x * 0.7 : x) } };
    const CLb = corrLegs(Zb.S.c, RULE.W, RULE.DD, RULE.END), sb = signals(CLb.corr, onDays(Zb.S.d, Zb.F, fxYearPos(Zb.F)).pos).filter(i => i < 3400);
    ok('⑦ ⛔ 前視:第 3,500 天之後全部亂改,之前的訊號日一個都不變', sa.length >= 3 && JSON.stringify(sa) === JSON.stringify(sb), `${sa.length} vs ${sb.length}`);
    // ⑦b 偷看未來(同一天的匯率)那種寫法 → 訊號會變(證明 ② 那道擋得住的東西是真的)
    const peek = (S, F) => { const posF = fxYearPos(F), pos = S.d.map(d => { const j = F.d.indexOf(d); return j >= 0 ? posF[j] : null; }); return signals(corrLegs(S.c, RULE.W, RULE.DD, RULE.END).corr, pos); };
    ok('⑦b 注入「用同一天的匯率」→ 訊號日跟正確寫法不一樣(擋得住的是真的差別)', JSON.stringify(peek(Z.S, Z.F)) !== JSON.stringify(signals(CLa.corr, onDays(Z.S.d, Z.F, fxYearPos(Z.F)).pos)));
    // ⑧ 封存:2026-11-06 之後的資料亂改,判定一個數字都不變
    const W7 = world(7100, 11, { plant: 0.0015 }), W7k = world(7100, 23, { plant: 0.0015 });
    ok('⑧ 合成資料真的跨過封存日(不然這一條沒有鑑別力)', W7.S.d.at(-1) > RULE.cut && W7k.S.d.at(-1) > RULE.cut, W7.S.d.at(-1));
    const garb = W => ({ S: { d: W.S.d, c: W.S.c.map((x, i) => W.S.d[i] > RULE.cut ? x * (i % 2 ? 3 : 0.2) : x) }, F: { d: W.F.d, v: W.F.v.map((x, i) => W.F.d[i] > RULE.cut ? x * 2 : x) } });
    const q = () => {}, oA = run(W7.S, W7.F, W7k.S, W7k.F, null, q), G7 = garb(W7), G7k = garb(W7k), oB = run(G7.S, G7.F, G7k.S, G7k.F, null, q);
    const key = o => JSON.stringify([o.judged, o.tw.h, o.kr.h, o.placebo.h]);
    ok('⑧ 封存日之後的價格與匯率亂改 → 判定、台灣、韓國、安慰劑的數字一模一樣', key(oA) === key(oB));
    // ⑨ 外資分數:賣越多分數越大;前面不到 250 個 → null
    const spot = {}, fd = bdays(400, 2010); fd.forEach((d, k) => { spot[d] = [k === 399 ? -5000 : (k % 7) - 3, 0, 0]; });
    const fz = fiSellScore(fd, { spot });
    ok('⑨ 外資 20 日合計:最後一天賣超最大 → 分數接近 100;前 269 天(20 + 250)是 null', fz[399] >= 99 && fz[100] == null && fz[268] == null && fz[300] != null, JSON.stringify([fz[399], fz[100], fz[300]]));
    let threw = false; try { loadKs(Buffer.from(JSON.stringify({ s: {} }))); } catch (_) { threw = true; }
    ok('⑩ world_hist 沒有 ^KS11 → 丟例外(⛔ 當成沒事件)', threw);
    const ks = loadKs(zlib.gzipSync(Buffer.from(JSON.stringify({ s: { '^KS11': { d: bdays(600), c: bdays(600).map((_, i) => 100 + i) } } }))));
    ok('⑩ gz 也讀得到', ks.d.length === 600 && ks.c[5] === 105);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ TWD_WEAK_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('twd_weak_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(process.env);
    if (!process.env.FRED_HIST) throw new Error('FRED_HIST 沒給');
    if (!process.env.WORLD_HIST) throw new Error('WORLD_HIST 沒給');
    const FJ = JSON.parse(fs.readFileSync(process.env.FRED_HIST, 'utf8'));
    const F = loadFx(FJ, 'usdtwd'), FK = loadFx(FJ, 'krw'), K = loadKs(fs.readFileSync(process.env.WORLD_HIST));
    const FM = process.env.FI_HIST ? JSON.parse(fs.readFileSync(process.env.FI_HIST, 'utf8')) : null;
    const out = run(S, F, K, FK, FM);
    out.now = nowState(S, F);
    console.log(`・現在(封存期,只描述):${out.now.d} 看得到的匯率 ${out.now.fx}(${out.now.fxd},一年位置 ${out.now.pos})・加權離 250 天高點 ${out.now.dd}%・${out.now.inLeg ? `修正段 ${out.now.legStart} 起` : '不在修正段'}・這一段第一次訊號 ${out.now.sig || '還沒有'}`);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
