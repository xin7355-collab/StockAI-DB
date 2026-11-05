#!/usr/bin/env node
/**
 * 🛑 stopfall_probe.mjs —— 「大盤大跌之後,哪些徵兆代表跌完了?」(V81.0.2,使用者 11/06 問;含 7 份逐字稿裡講得出規則的那幾條)
 *
 * 母體:修正段(lib_crash.corrLegs:收盤比近 250 天最高收盤低 ≥10%,回到高點 5% 以內結束)—— 2000 起 26 年
 * 對手:「修正段隨便一天」收盤買(⛔ 只跟隨便一天比 —— 跌深本來就常反彈,要分出「等那個徵兆」有沒有比較好)
 * 每一種徵兆:只在修正段裡算;兩種去重 ① 每段第一次 ② 同一段隔 10 天以上才算新的一次
 * 進場:徵兆那天收盤(加權含息 2003 起;價格 2000 起;⛔ ^TWII 開盤價,陷阱 #47)
 * 成績:20 / 60 / 120 天報酬 − 修正段隨便一天、抽一樣多次 2,000 次的 p、前後半、逐年;
 *       離那一段最低點 3% 以內的比例(事後量的)、之後 60 天內又再跌 ≥5% 的比例、之後還再跌多少(中位)
 * 徵兆(⛔ 看完結果不改門檻;高原用相鄰門檻一起印):
 *   價格:修正段第一天 / 跌 15% / 跌 20% · 同段第 2 / 3 次單日跌 ≥3% · 站回 5 / 10 / 20 日線 · 當天低點 3 天不破(大跌日盤中 ≥2.5%)
 *         爆量長下影(盤中 ≥2.5%、收在當天區間上 40% 內、成交金額 ≥ 前 20 天平均 ×1.3)· 爆量下殺(收跌 ≥2%、量 ×1.5)
 *         RSI 跌破 25 再站回 30 · 季線乖離 ≤ −10 / −15% · 連跌 6 天
 *   籌碼(2004 起):融資 10 天減 ≥5 / 8 / 10% · 外資現貨連賣 8 天後第一個買超日
 *   美股(2009 起):VIX 收盤 ≥30(前 20 天都 <30)· VIX 從近 10 天高點(≥30)回落 20%
 *   廣度(2010 起,breadth16_build):下跌家數 ≥85 / 90%(Lowry)· 90% 下跌日之後 5 天內出現 80% 上漲日 · Zweig 寬度衝刺 · 跌停家數 ≥3% / 6%
 *   國安基金:9 次進場日(nsf_probe 同一份日期)
 *   期交所(V81.0.3,TAIFEX_HIST=data/taifex_hist.json):選擇權 P/C 未平倉比 / 成交量比衝進一年最高 10% 或掉到最低 10%(2010 起);
 *         散戶多空比(小台,正 = 散戶淨多)極空 / 極多(2018-06 起)—— 以前只測過「隔天」,這裡看 20 / 60 / 120 天
 *         「一年最高 10%」= 跟前 250 個交易日(⛔ 不含當天,陷阱 #43)比,至少 120 天有資料才算;當天剛跨進去那天才算一次
 * 最後印「這一段(還沒走完)」哪些已經亮過。
 *
 * 跑法:IDX_LONG=$S/k_idx_long.json IDX_EARLY=$S/k_idx_long_early.json TWII_NOW=$S/k6/twii_now.json \
 *       FI_MKT=$S/k6/fi_mkt_hist.json US_HIST=$S/k6/us_hist.json BREADTH16=$S/k6/breadth16.json \
 *       BREADTH_NOW=$S/k6/breadth.json RISK_HIST=$S/k6/risk_history.json node scripts/stopfall_probe.mjs out.json
 *       node scripts/stopfall_probe.mjs --selftest
 */
import fs from 'fs';
import { loadIndex, corrLegs, firstPerLeg, gapDedup, evVsCorr, usToTw, sma, rsi, mean, r2, bh } from './lib_crash.mjs';

export const HS = [20, 60, 120];
// 國安基金進場日(各來源差 1~2 天;nsf_probe 有 ±2 天穩健檢查)—— 2000 / 2000 / 2004 / 2008 / 2011 / 2015 / 2020 / 2022 / 2025
export const NSF = ['2000-03-16', '2000-10-03', '2004-05-20', '2008-09-19', '2011-12-20', '2015-08-25', '2020-03-20', '2022-07-13', '2025-04-09'];
const rd = p => p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
const d10 = s => String(s).replace(/\//g, '-').slice(0, 10);

/** 日期 → 值 的表對到台股日曆(同一天);回陣列(沒有 = null) */
export function onCal(dates, m) { return dates.map(d => (m.has(d) ? m.get(d) : null)); }

/** 全部徵兆(只用 ≤ i 的資料;回 {名稱: [i...]} 原始日子,還沒去重) */
export function signals(S, X = {}) {
    const C = S.c, H = S.h, L = S.l, A = S.a, n = C.length, CL = X.CL || corrLegs(C), inC = i => CL.corr[i] >= 0;
    const ma5 = sma(C, 5), ma10 = sma(C, 10), ma20 = sma(C, 20), ma60 = sma(C, 60), R = rsi(C, 14);
    const r1 = i => (i > 0 && C[i - 1] > 0 ? C[i] / C[i - 1] - 1 : null);
    const amAvg = i => { if (i < 20) return null; let s = 0; for (let k = i - 20; k < i; k++) { if (!(A[k] > 0)) return null; s += A[k]; } return s / 20; };
    const out = {}; const add = (k, i) => (out[k] = out[k] || []).push(i);
    const drops = new Map(); let streak = 0;
    for (let i = 1; i < n; i++) {
        const r = r1(i); streak = r != null && r < 0 ? streak + 1 : 0;
        if (!inC(i)) continue;
        const dd = C[i] / CL.hi[i] - 1;
        add('修正段第一天', i);
        if (dd <= -0.15) add('跌深15%', i);
        if (dd <= -0.20) add('跌深20%', i);
        if (r != null && r <= -0.03) { const k = CL.corr[i], m = (drops.get(k) || 0) + 1; drops.set(k, m); if (m === 2) add('同段第2次跌≥3%', i); if (m === 3) add('同段第3次跌≥3%', i); }
        for (const [nm, M] of [['站回5日線', ma5], ['站回10日線', ma10], ['站回20日線', ma20]]) if (M[i] != null && M[i - 1] != null && C[i] > M[i] && C[i - 1] <= M[i - 1]) add(nm, i);
        if (i >= 3) { const j = i - 3; if (C[j - 1] > 0 && L[j] > 0 && L[j] / C[j - 1] - 1 <= -0.025 && Math.min(L[j + 1], L[j + 2], L[j + 3]) > L[j]) add('大跌日低點3天不破', i); }
        const av = amAvg(i);
        if (C[i - 1] > 0 && L[i] > 0 && H[i] > L[i] && L[i] / C[i - 1] - 1 <= -0.025 && (C[i] - L[i]) >= 0.6 * (H[i] - L[i]) && av && A[i] >= 1.3 * av) add('爆量長下影', i);
        if (r != null && r <= -0.02 && av && A[i] >= 1.5 * av) add('爆量下殺', i);
        if (R[i] != null && R[i - 1] != null && R[i] >= 30 && R[i - 1] < 30) { let lo = 100; for (let k = Math.max(1, i - 10); k < i; k++) if (R[k] != null) lo = Math.min(lo, R[k]); if (lo < 25) add('RSI跌破25再站回30', i); }
        if (ma60[i] != null && C[i] / ma60[i] - 1 <= -0.10) add('季線乖離≤−10%', i);
        if (ma60[i] != null && C[i] / ma60[i] - 1 <= -0.15) add('季線乖離≤−15%', i);
        if (streak === 6) add('連跌6天', i);
        // 籌碼
        if (X.mg && i >= 10 && X.mg[i] > 0 && X.mg[i - 10] > 0) { const m = X.mg[i] / X.mg[i - 10] - 1; if (m <= -0.05) add('融資10天減≥5%', i); if (m <= -0.08) add('融資10天減≥8%', i); if (m <= -0.10) add('融資10天減≥10%', i); }
        if (X.fi && i >= 8 && X.fi[i] != null && X.fi[i] > 0) { let all = true; for (let k = i - 8; k < i; k++) if (!(X.fi[k] != null && X.fi[k] < 0)) { all = false; break; } if (all) add('外資連賣8天後首買', i); }
        // 廣度
        if (X.br && X.br[i]) { const b = X.br[i], ud = b.up + b.dn; if (ud > 200) { const pd = b.dn / ud; if (pd >= 0.85) add('下跌家數≥85%', i); if (pd >= 0.90) add('下跌家數≥90%', i);
            if (b.up / ud >= 0.80) { for (let k = i - 5; k < i; k++) { const q = X.br[k]; if (q && q.up + q.dn > 200 && q.dn / (q.up + q.dn) >= 0.90) { add('90%下跌後5天內80%上漲', i); break; } } }
            const ldk = b.n > 0 ? b.ld / b.n : 0; if (ldk >= 0.03) add('跌停家數≥3%', i); if (ldk >= 0.06) add('跌停家數≥6%', i); } }
        if (X.zw && X.zw[i] != null && X.zw[i - 1] != null && X.zw[i] > 0.615 && X.zw[i - 1] <= 0.615) { let lo = 1; for (let k = Math.max(0, i - 10); k < i; k++) if (X.zw[k] != null) lo = Math.min(lo, X.zw[k]); if (lo < 0.40) add('Zweig寬度衝刺', i); }
        if (X.vixTw && X.vixTw[i]) for (const k of X.vixTw[i]) add(k, i);
        if (X.nsf && X.nsf.has(i)) add('國安基金進場', i);
        // 期交所:P/C 比、散戶多空比衝到一年的兩端(剛跨進去那天)
        for (const [nm, arr, side] of [['P/C未平倉比衝進一年最高10%', X.pcOi, 1], ['P/C未平倉比掉進一年最低10%', X.pcOi, -1],
            ['P/C成交量比衝進一年最高10%', X.pcVol, 1], ['散戶多空比極空(一年最低10%)', X.rl, -1], ['散戶多空比極多(一年最高10%)', X.rl, 1]]) {
            if (!arr) continue;
            const a = pctRank(arr, i), b = pctRank(arr, i - 1);
            if (a == null) continue;
            const inNow = side > 0 ? a >= 0.9 : a <= 0.1, inPrev = b != null && (side > 0 ? b >= 0.9 : b <= 0.1);
            if (inNow && !inPrev) add(nm, i);
        }
    }
    return out;
}

/** 第 i 天的值在「前 250 個交易日」裡排第幾(0~1;⛔ 不含當天);少於 120 天有資料 → null */
export function pctRank(arr, i, W = 250, MIN = 120) {
    if (i < 1 || arr[i] == null) return null;
    let n = 0, le = 0;
    for (let k = Math.max(0, i - W); k < i; k++) if (arr[k] != null) { n++; if (arr[k] < arr[i]) le++; else if (arr[k] === arr[i]) le += 0.5; }
    return n >= MIN ? le / n : null;
}

/** 廣度 EMA10(Zweig 用;up / (up+dn)) */
export function zweigSeries(br) { const o = new Array(br.length).fill(null); let e = null; const a = 2 / 11;
    for (let i = 0; i < br.length; i++) { const b = br[i]; if (!b || b.up + b.dn < 200) { e = null; continue; } const x = b.up / (b.up + b.dn); e = e == null ? x : e + a * (x - e); o[i] = e; } return o; }

/** VIX(美股日)→ 對到台股日:≥30 首次(前 20 天都 <30)、近 10 天高點 ≥30 又回落 20% */
export function vixEvents(us, twDates) {
    const nx = usToTw(twDates), m = new Map();
    if (!us || !us.syms || !us.syms['^VIX']) return m;
    const vc = us.syms['^VIX'].c, days = us.days;
    for (let i = 20; i < vc.length; i++) {
        const v = vc[i]; if (!(v > 0)) continue;
        const tags = [];
        let clean = true; for (let j = i - 20; j < i; j++) if (!(vc[j] < 30)) { clean = false; break; }
        if (v >= 30 && clean) tags.push('VIX衝上30');
        let mx = 0; for (let j = i - 9; j <= i; j++) if (vc[j] > mx) mx = vc[j];
        if (mx >= 30 && v <= 0.8 * mx) tags.push('VIX從30以上回落20%');
        if (!tags.length) continue;
        const k = nx(days[i]); if (k < 0) continue;
        m.set(k, [...(m.get(k) || []), ...tags]);
    }
    return m;
}

/** VIX 回落那條的門檻高原:近 10 天高點 ≥T、從高點回落 ≥F% → 下一個台股交易日;每段第一次 vs 修正段隨便一天(含息)
 *  ⭐ 門檻左右各挪一格仍成立才算一片高原(T 25/30/35 × F 15/20/25)。VIX_GRID=1 才跑 */
export function vixGrid(S, us, CL, log = console.log, Ts = [25, 30, 35], Fs = [15, 20, 25]) {
    if (!us || !us.syms || !us.syms['^VIX']) { log('⚠️ 沒有 VIX 資料 → 不跑門檻高原'); return null; }
    const nx = usToTw(S.d), vc = us.syms['^VIX'].c, A = S.tr && S.tr.some(x => x != null) ? S.tr : S.c, out = [];
    log('\nVIX 回落門檻高原(每段第一次 vs 修正段隨便一天,含息;差 = 百分點)');
    log('高點≥  回落≥  段數 |  20天 差(p)        60天 差(p)        120天 差(p)       | 60天內再跌≥5%');
    for (const T of Ts) for (const F of Fs) {
        const ev = new Set();
        for (let i = 9; i < vc.length; i++) { let mx = 0; for (let j = i - 9; j <= i; j++) if (vc[j] > mx) mx = vc[j];
            if (mx >= T && vc[i] <= (1 - F / 100) * mx) { const k = nx(us.days[i]); if (k >= 0) ev.add(k); } }
        const first = firstPerLeg([...ev].sort((a, b) => a - b), CL.corr), r = evVsCorr(S, A, CL, first, [20, 60, 120], 17, 2000, Math.max(0, nx(us.days[9])));
        const c = h => r.h[h] && r.h[h].diff != null ? `${String(r.h[h].diff).padStart(6)}(${r.h[h].p})` : '     —      ';
        out.push({ T, F, n: first.length, r });
        log(`${String(T).padStart(5)} ${String(F).padStart(5)}% ${String(first.length).padStart(5)} | ${c(20)}  ${c(60)}  ${c(120)} | ${r.deeper}%(${r.deeperBase}%)`);
    }
    return out;
}

export function buildExtras(S, env = process.env) {
    const idx = new Map(S.d.map((d, i) => [d, i])), X = {};
    const fm = rd(env.FI_MKT), rh = rd(env.RISK_HIST) || [];
    if (fm) {
        const mg = new Map(Object.entries(fm.mg || {}).map(([d, v]) => [d10(d), +v]));
        const fi = new Map(Object.entries(fm.spot || {}).map(([d, v]) => [d10(d), Array.isArray(v) ? +v[0] : +v]));
        const lastMg = [...mg.keys()].sort().at(-1) || '', lastFi = [...fi.keys()].sort().at(-1) || '';
        for (const r of rh) { const d = d10(r.date); if (!idx.has(d)) continue;                     // ⛔ 只收交易日;risk_history 會照抄前一天(陷阱 #16),只拿來接最後幾天
            if (d > lastMg && r.margin_100m > 0) mg.set(d, +r.margin_100m);
            if (d > lastFi && r.fi_spot_net != null) fi.set(d, +r.fi_spot_net); }
        X.mg = onCal(S.d, mg); X.fi = onCal(S.d, fi);
        X.mgSrc = `融資 ${[...mg.keys()].sort()[0]} ~ ${[...mg.keys()].sort().at(-1)}`; X.fiSrc = `外資現貨 ${[...fi.keys()].sort()[0]} ~ ${[...fi.keys()].sort().at(-1)}`;
    }
    const b16 = rd(env.BREADTH16), bnow = rd(env.BREADTH_NOW);
    const bm = new Map();
    if (b16) b16.days.forEach((d, k) => { const v = b16.v[k]; bm.set(d10(d), { up: v[0], dn: v[1], lu: v[3], ld: v[4], n: v[5] }); });
    const lastB = [...bm.keys()].sort().at(-1) || '';
    if (bnow && Array.isArray(bnow.history)) for (const r of bnow.history) { const d = d10(r.d); if (d > lastB && r.total > 0) bm.set(d, { up: +r.up, dn: +r.dn, lu: +r.lu || 0, ld: +r.ld || 0, n: +r.total }); }
    X.br = onCal(S.d, bm); X.zw = zweigSeries(X.br);
    X.brSrc = bm.size ? `廣度 ${[...bm.keys()].sort()[0]} ~ ${[...bm.keys()].sort().at(-1)}` : '';
    const us = rd(env.US_HIST);
    const vix = vixEvents(us, S.d);
    // 美股資料最後一天之後:用 risk_history 的 vix 補(那幾天的 VIX 收盤;⚠️ 只當「現在亮了沒」參考)
    if (us && us.days) { const lastUs = us.days.at(-1); const vs = rh.filter(r => d10(r.date) > lastUs && r.vix > 0 && idx.has(d10(r.date))).map(r => [idx.get(d10(r.date)), +r.vix]);
        const allV = us.syms['^VIX'].c.slice(-20); for (const [i, v] of vs) { const prev = allV.slice(-20); const tags = [];
            if (v >= 30 && prev.every(x => x < 30)) tags.push('VIX衝上30'); const mx = Math.max(...prev.slice(-9), v); if (mx >= 30 && v <= 0.8 * mx) tags.push('VIX從30以上回落20%');
            if (tags.length) vix.set(i, [...(vix.get(i) || []), ...tags]); allV.push(v); } }
    X.vixTw = new Array(S.d.length).fill(null); for (const [k, t] of vix) X.vixTw[k] = t;
    X.vixFrom = us && us.days && us.days.length > 10 ? Math.max(0, usToTw(S.d)(us.days[9])) : 0;
    X.vixSrc = us && us.days ? `VIX ${us.days[0]} ~ ${us.days.at(-1)}(之後用 risk_history 補)` : '';
    X.nsf = new Set(NSF.map(d => S.d.findIndex(x => x >= d)).filter(i => i >= 0));
    const tf = rd(env.TAIFEX_HIST);
    if (tf) {
        const pick = (o, j) => new Map(Object.entries(o || {}).map(([d, v]) => [d10(d), Array.isArray(v) && v[j] != null ? +v[j] : null]).filter(([, v]) => v != null && Number.isFinite(v)));
        const pv = pick(tf.pc, 0), po = pick(tf.pc, 1), rl = pick(tf.rl, 3);
        X.pcVol = onCal(S.d, pv); X.pcOi = onCal(S.d, po); X.rl = onCal(S.d, rl);
        X.tfSrc = `P/C ${[...po.keys()].sort()[0]} ~ ${[...po.keys()].sort().at(-1)} ・散戶多空比 ${[...rl.keys()].sort()[0]} ~ ${[...rl.keys()].sort().at(-1)}`;
    }
    return X;
}

/** 這個徵兆的資料從第幾天起才有(對照組要從同一天起算,陷阱 #50)—— 只用資料本身的起點,⛔ 不看事件 */
export function covFrom(k, S, X) {
    const first = (arr, lag = 0) => { if (!arr) return 0; const j = arr.findIndex(v => v != null && v !== 0); return j < 0 ? 0 : Math.min(arr.length - 1, j + lag); };
    if (/^融資/.test(k)) return first(X.mg, 10);
    if (/^外資/.test(k)) return first(X.fi, 8);
    if (/家數|Zweig/.test(k)) return first(X.br, 10);
    if (/^VIX/.test(k)) return X.vixFrom || 0;
    if (/爆量/.test(k)) return first(S.a, 20);
    if (/^P\/C未平倉/.test(k)) return first(X.pcOi, 120);
    if (/^P\/C成交量/.test(k)) return first(X.pcVol, 120);
    if (/^散戶多空比/.test(k)) return first(X.rl, 120);
    return 0;
}

export function run(S, X, log = console.log) {
    const CL = corrLegs(S.c); X.CL = CL;
    const raw = signals(S, X), res = {};
    const T = S.tr, P = S.c;
    const legsN = CL.legs.length, corrDays = CL.corr.filter(k => k >= 0).length;
    log(`加權 ${S.d[0]} ~ ${S.d.at(-1)}(${S.d.length} 天)・修正段 ${legsN} 段・修正段裡的日子 ${corrDays} 天(含息 2003 起)`);
    for (const L of CL.legs) log(`  段 ${S.d[L.peakI]} 高 ${Math.round(L.peak)} → 第一天 ${S.d[L.s]} → 最低 ${S.d[L.lowI]} ${Math.round(L.low)}(${r2(L.depth)}%)→ ${L.open ? '還沒結束' : '結束 ' + S.d[L.e]}`);
    for (const [k, ev] of Object.entries(raw)) {
        const fp = firstPerLeg(ev, CL.corr), gp = gapDedup(ev, CL.corr, 10), f0 = covFrom(k, S, X);
        res[k] = { first: evVsCorr(S, T, CL, fp, HS, 7, 2000, f0), gap: evVsCorr(S, T, CL, gp, HS, 9, 2000, f0), firstP: evVsCorr(S, P, CL, fp, HS, 11, 2000, f0), from: S.d[f0] };
    }
    // BH:每段第一次 × 含息 × 60 天(主規格)
    const ks = Object.keys(res), ps = ks.map(k => (res[k].first.h[60] || {}).p ?? null), qs = bh(ps);
    ks.forEach((k, j) => { res[k].q60 = qs[j]; });
    const pr = (tag, o) => { const c = h => { const z = o.h[h]; return z && z.diff != null ? `${h}天 ${z.diff >= 0 ? '+' : ''}${z.diff}pp(p ${z.p}・前後 ${z.h1}/${z.h2}・年 ${z.yrsWin}/${z.yrsN})` : `${h}天 n=${z ? z.n : 0}`; };
        return `${tag} n=${o.n}(${o.legs} 段)` + HS.map(c).join(' ・') + ` ・離底 3% 內 ${o.near}%(隨便一天 ${o.nearBase}%)・60 天內再跌 ≥5% ${o.deeper}%(${o.deeperBase}%)・之後還再跌中位 ${o.more}%(${o.moreBase}%)`; };
    log('\n徵兆(含息;vs 修正段隨便一天)');
    for (const k of ks) { log(`◆ ${k}  q60=${res[k].q60}`); log('   每段第一次 ' + pr('', res[k].first)); log('   隔 10 天    ' + pr('', res[k].gap)); log('   (價格 2000 起)' + pr('', res[k].firstP)); }
    // 這一段(還沒走完)
    const open = CL.legs.length && CL.legs.at(-1).open ? CL.legs.at(-1) : null, now = {};
    if (open) {
        const li = CL.legs.length - 1;
        log(`\n這一段:高點 ${S.d[open.peakI]} ${Math.round(open.peak)} → 進修正段 ${S.d[open.s]} → 目前最低 ${S.d[open.lowI]} ${Math.round(open.low)}(${r2(open.depth)}%)`);
        for (const [k, ev] of Object.entries(raw)) { const ds = ev.filter(i => CL.corr[i] === li).map(i => S.d[i]); if (ds.length) now[k] = ds; }
        for (const k of ks) log(`  ${now[k] ? '✔' : '·'} ${k}${now[k] ? ':' + now[k].join(' ') : ''}`);
    }
    return { res, now, legs: CL.legs.map(L => ({ peak: S.d[L.peakI], s: S.d[L.s], low: S.d[L.lowI], depth: r2(L.depth), end: L.open ? null : S.d[L.e] })),
        src: { mg: X.mgSrc, fi: X.fiSrc, br: X.brSrc, vix: X.vixSrc, tf: X.tfSrc } };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 900, d = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2010, 0, 4 + i)).toISOString().slice(0, 10));
    // 一段:漲到 300 天高點 → 跌 25%(第 300~360)→ 回升
    const c = d.map((_, i) => i < 300 ? 100 + i * 0.1 : i < 360 ? 130 * (1 - 0.25 * (i - 300) / 60) : 97.5 * (1 + 0.006 * (i - 360)));
    const S = { d, c, o: c.slice(), h: c.map(x => x * 1.005), l: c.map(x => x * 0.995), tr: c.slice(), a: c.map(() => 1e11) };
    const CL = corrLegs(c);
    t(CL.legs.length >= 1 && Math.abs(CL.legs[0].depth + 25) < 1, '① 修正段:跌 25% 那一段被抓到、深度 −25%');
    // ⛔ 前視:截到第 k 天算出來的徵兆,跟整段算出來的在 ≤ k 的部分完全一樣
    const full = signals(S, { CL });
    const k = 340, Sk = { d: d.slice(0, k + 1), c: c.slice(0, k + 1), o: c.slice(0, k + 1), h: S.h.slice(0, k + 1), l: S.l.slice(0, k + 1), tr: c.slice(0, k + 1), a: S.a.slice(0, k + 1) };
    const part = signals(Sk, {});
    const same = Object.keys(full).every(key => JSON.stringify((full[key] || []).filter(i => i <= k)) === JSON.stringify(part[key] || []));
    t(same, '② 截到第 340 天重算,每一種徵兆在 340 天以前的日子都一模一樣(⛔ 偷看未來)');
    // 埋效果:某個徵兆那幾天之後固定大漲 → 抓得到;沒埋 ≈ 0(用隨機路徑)
    let seed = 3; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const N2 = 4000, d2 = Array.from({ length: N2 }, (_, i) => new Date(Date.UTC(2003, 0, 1 + i)).toISOString().slice(0, 10));
    const mkPath = inject => { const c2 = [100]; const ev = []; for (let i = 1; i < N2; i++) { let r = (R() - 0.5) * 0.04 - 0.0002; if (inject && ev.length && i - ev.at(-1) <= 20 && i - ev.at(-1) > 0) r += 0.006; c2.push(c2[i - 1] * (1 + r)); if (i % 97 === 0) ev.push(i); } return { c2, ev }; };
    const run2 = inject => { const { c2, ev } = mkPath(inject); const S2 = { d: d2, c: c2, tr: c2 }; const CL2 = corrLegs(c2); const e2 = ev.filter(i => CL2.corr[i] >= 0); return evVsCorr(S2, c2, CL2, e2, [20], 5, 400).h[20]; };
    const yes = run2(true), no = run2(false);
    t(yes && yes.diff > 5 && yes.p < 0.05, `③ 埋「之後 20 天每天 +0.6%」→ 比修正段隨便一天多 ${yes && yes.diff}pp、p ${yes && yes.p}`);
    t(no && Math.abs(no.diff) < 3, `④ 沒埋 → 跟修正段隨便一天差不多(${no && no.diff}pp)`);
    // 同段第 2 次跌 ≥3%
    const c3 = d.map((_, i) => i < 300 ? 100 + i * 0.1 : 130);
    for (let i = 300; i < n; i++) c3[i] = i === 300 ? c3[299] * 0.88 : i === 305 ? c3[i - 1] * 0.96 : i === 310 ? c3[i - 1] * 0.965 : c3[i - 1];
    const S3 = { d, c: c3, o: c3, h: c3, l: c3, tr: c3, a: c3.map(() => 1e11) };
    const f3 = signals(S3, {});
    t((f3['同段第2次跌≥3%'] || [])[0] === 305 && (f3['同段第3次跌≥3%'] || [])[0] === 310, '⑤ 修正段裡第 2 / 第 3 次單日跌 ≥3% 抓到那一天');
    // 站回 5 日線:在修正段裡收盤從下面穿上去
    t((full['站回5日線'] || []).every(i => S.c[i] > sma(S.c, 5)[i] && S.c[i - 1] <= sma(S.c, 5)[i - 1]), '⑥ 站回 5 日線 = 今天收盤 > 5 日線、昨天 ≤');
    // NSF 日期對到交易日
    const Xn = { nsf: new Set([310]) }; const fn = signals(S3, Xn);
    t((fn['國安基金進場'] || []).includes(310), '⑦ 國安基金進場日在修正段裡 → 列入');
    // VIX 對到「下一個」台股日(同一天 = 前視)
    const us = { days: ['2010-02-01', '2010-02-02'], syms: { '^VIX': { c: [...Array(20).fill(20), 31].slice(-2) } } };
    const us2 = { days: Array.from({ length: 22 }, (_, i) => new Date(Date.UTC(2010, 0, 4 + i)).toISOString().slice(0, 10)), syms: { '^VIX': { c: [...Array(21).fill(20), 32] } } };
    const vm = vixEvents(us2, d);
    const lastUs = us2.days.at(-1), k2 = d.findIndex(x => x > lastUs);
    t(vm.has(k2) && vm.get(k2).includes('VIX衝上30') && !vm.has(d.indexOf(lastUs)), '⑧ VIX 美股那天衝上 30 → 算在下一個台股交易日(⛔ 同一天)');
    void us;
    // ⑨ 對照組期間要跟徵兆的資料起點對齊(陷阱 #50):前一半一路跌(修正段裡之後都賠)、後一半隨機;
    //    事件只在後一半、而且就是隨便挑的修正段日子 → from=0(對照組含前一半)差距灌水;from=後一半第一天 → ≈0
    let s9 = 11; const R9 = () => { s9 = (s9 * 16807) % 2147483647; return s9 / 2147483647; };
    const N9 = 4000, d9 = Array.from({ length: N9 }, (_, i) => new Date(Date.UTC(2003, 0, 1 + i)).toISOString().slice(0, 10)), c9 = [100];
    for (let i = 1; i < N9; i++) c9.push(c9[i - 1] * (1 + (i < 2000 ? -0.003 : 0) + (R9() - 0.5) * 0.03));
    const S9 = { d: d9, c: c9, tr: c9 }, CL9 = corrLegs(c9), ev9 = [];
    for (let i = 2100; i < N9 - 30; i += 23) if (CL9.corr[i] >= 0) ev9.push(i);
    const w0 = evVsCorr(S9, c9, CL9, ev9, [20], 3, 400, 0).h[20], w1 = evVsCorr(S9, c9, CL9, ev9, [20], 3, 400, 2000).h[20];
    t(w0 && w1 && w0.diff > 3 && Math.abs(w1.diff) < 2.5, `⑨ 對照組期間:含前一段空頭 → 差 ${w0 && w0.diff}pp(灌水)・從資料起點算 → ${w1 && w1.diff}pp(≈0),事件 ${ev9.length} 次`);
    // ⑩ covFrom:徵兆的資料從哪天起,對照組就從哪天起(只看資料本身)
    const Xc = { mg: [null, null, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], fi: [null, 1, 2], br: [null, null, null, { up: 1 }], vixFrom: 7 };
    const Sc = { a: [null, 1, 1] };
    t(covFrom('融資10天減≥5%', Sc, Xc) === 12 && covFrom('外資連賣8天後首買', Sc, Xc) === 2 && covFrom('跌停家數≥3%', Sc, Xc) === 3
        && covFrom('VIX從30以上回落20%', Sc, Xc) === 7 && covFrom('站回5日線', Sc, Xc) === 0, '⑩ 對照組起點 = 那個徵兆的資料起點(+ 回看天數),價格類從頭算');
    // ⑪ 期交所兩端:前 250 天(⛔ 不含當天)排名;剛跨進最高 10% 那天才算一次;改掉之後的值,前面判斷不變(⛔ 前視)
    const arr = d.map((_, i) => (i < 100 ? null : 50 + (i % 7)));
    arr[400] = 99; arr[401] = 99; arr[402] = 40;
    t(pctRank(arr, 219) === null && pctRank(arr, 400) === 1 && pctRank(arr, 402) === 0, `⑪ 排名只看前 250 天、少於 120 天不給(${pctRank(arr, 219)} / ${pctRank(arr, 400)} / ${pctRank(arr, 402)})`);
    const arr2 = arr.slice(); for (let k = 401; k < arr2.length; k++) arr2[k] = 0;
    t(pctRank(arr2, 400) === pctRank(arr, 400), '⑪ 改掉之後的值,當天的排名不變(⛔ 前視)');
    const Xt = { CL, pcOi: arr, pcVol: null, rl: null };
    const sig = signals({ ...S, c: S.c }, Xt);
    const hits = (sig['P/C未平倉比衝進一年最高10%'] || []);
    t(hits.includes(400) && !hits.includes(401), `⑪ 連兩天在最高 10% 只算第一天(${hits.filter(i => i >= 395 && i <= 405)})`);
    t(covFrom('P/C未平倉比衝進一年最高10%', S, Xt) === 220, '⑪ 對照組起點 = 資料起點 + 120 天');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('stopfall_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(), X = buildExtras(S);
    const out = run(S, X);
    if (process.env.VIX_GRID) out.vixGrid = vixGrid(S, rd(process.env.US_HIST), X.CL);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
