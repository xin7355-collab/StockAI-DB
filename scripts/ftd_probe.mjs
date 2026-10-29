#!/usr/bin/env node
/**
 * 🚦 台股「追盤日」(FTD, follow-through day)回測(V80.0.3)
 *
 * 使用者 2026-10-30:「推薦都做」—— 14 個股票專案評估裡 claude-trading-skills 的 ftd-detector
 *   (歐尼爾:大盤修正後,反彈第 4 天以後某天大漲而且量比前一天大 = 新一波上漲確認)。
 *   ⭐ 那個專案只給規則、沒有任何回測;本站沒有 FTD → 先測台股有沒有用,⛔ 沒過關不上 App。
 *
 * 資料(只讀):IDX_LONG / IDX_EARLY / TWII_NOW(跟 crash_warn_probe 同一份讀法,加權 2000 起;
 *   報酬指數 2003 起只拿來做「怎麼用」那段)。量 = 成交金額(陷阱 #29:指數 volume 是 0)。
 *
 * FTD 規則(全部只用當天以前的資料,selftest ① 截斷不變):
 *   修正中 = 收盤比近 250 天最高收盤低 ≥10%。修正中追蹤「到今天為止的最低收盤」(⛔ 不用事後才知道的谷底):
 *   收盤再創新低 → 反彈重算;第一次收漲 = 反彈第 1 天;第 4~W 天出現「漲 ≥G% 而且成交金額 > 前一天」= FTD。
 *   FTD 之後這一段修正結束;收盤回到離高點 5% 以內也算結束(沒等到 FTD 就漲回去了)。
 *   主規格先寫死:G = 1.7%、W = 10(⛔ 看完結果不改)。
 *
 * 量什麼:FTD 隔天收盤買(⛔ 不用當天收盤)、抱 20 / 60 / 120 天的加權漲幅,跟兩個基準比:
 *   全部天數、「修正中隨便哪一天買」(真正的對手:同樣是跌深之後,等 FTD 有沒有比較好)。
 *
 * 過關(先寫死再跑):
 *   ① 全期:FTD 之後 60 天平均 > 修正中隨便一天、也 > 全部天數
 *   ② 分段:2000–09 / 2010–17 / 2018–26 有 ≥3 次 FTD 的段,每一段都 > 該段「修正中」基準(至少要有 2 段可比)
 *   ③ 拿掉最好的那一次,仍 > 基準
 *   ④ 高原:G ∈ {1.0, 1.25, 1.5, 1.7, 2.0, 2.5} × W ∈ {7, 10, 15},≥5 次的組合全部 > 基準
 *   ⑤ 隨機日對照:從「修正中」的日子抽同樣次數 1,000 次,p 值(20/60/120 天一起 BH)≤ 0.05
 *   ⑥ 平移安慰劑:FTD 那幾天整段循環平移 1,000 次,p 值(同上 BH)≤ 0.05
 * 怎麼用(報酬指數 2003 起,ETF 成本:買 0.09%、賣 0.19%):
 *   買了放著 vs「從進場後最高跌 10% 出場 → 等 FTD 回來」vs「同樣出場 → 站回 60 日線回來」
 *   vs「同樣出場 → 隨機等跟 FTD 一樣多天回來」(200 種亂數,看中位)。三種回場都加同一個保險:創 250 天新高一定回來。
 *
 * 跑法:
 *   IDX_LONG=data/idx_long.json IDX_EARLY=data/idx_long_early.json TWII_NOW=data/^TWII.json \
 *     node scripts/ftd_probe.mjs out.json
 *   node scripts/ftd_probe.mjs --selftest
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadIndex, rng, bh, SEGS, COST_SELL, COST_BUY } from './crash_warn_probe.mjs';

export const CORR_DD = 10, END_DD = 5, HI_WIN = 250, G_MAIN = 1.7, W_MAIN = 10, HS = [20, 60, 120], H_MAIN = 60;
export const N_CTRL = 1000, MIN_SHIFT = 250, SEG_MIN_EV = 3, PLATEAU_MIN_EV = 5, N_RAND_ACT = 200;
export const GRID_G = [1.0, 1.25, 1.5, 1.7, 2.0, 2.5], GRID_W = [7, 10, 15];

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
const pct = x => x == null || !Number.isFinite(x) ? null : +(x * 100).toFixed(2);
const r2 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(2);

/** 逐日跑狀態機 → { ftd: [{i, low, lowI, day}], corr: Int8Array(修正中=1), ends: 沒等到 FTD 就結束的次數 }
 *  ⛔ 每一步只看 C[0..i]、A[0..i] */
export function detectFTD(C, A, { g = G_MAIN, w = W_MAIN, dd = CORR_DD, endDd = END_DD, hiWin = HI_WIN } = {}) {
    const n = C.length, corr = new Int8Array(n), ftd = [];
    let inC = false, low = 0, lowI = -1, day = 0, ends = 0;
    const dq = [];                                     // 近 hiWin 天最高收盤(單調佇列)
    for (let i = 0; i < n; i++) {
        while (dq.length && dq[0] <= i - hiWin) dq.shift();
        while (dq.length && C[dq[dq.length - 1]] <= C[i]) dq.pop();
        dq.push(i);
        const hi = C[dq[0]], d = C[i] / hi - 1;
        if (!inC) {
            if (d <= -dd / 100) { inC = true; low = C[i]; lowI = i; day = 0; }
        } else if (C[i] < low) { low = C[i]; lowI = i; day = 0; }               // 再創新低 → 反彈重算
        else if (d > -endDd / 100) { inC = false; ends++; }                     // 沒等到 FTD 就漲回去了
        else if (day === 0) { if (i > 0 && C[i] > C[i - 1]) day = 1; }          // 第一次收漲 = 第 1 天
        else {
            day++;
            const up = C[i] / C[i - 1] - 1;
            if (day >= 4 && day <= w && up >= g / 100 && A[i] > 0 && A[i - 1] > 0 && A[i] > A[i - 1]) {
                ftd.push({ i, low, lowI, day }); inC = false;
            }
        }
        corr[i] = inC ? 1 : 0;
        if (!inC && ftd.length && ftd[ftd.length - 1].i === i) corr[i] = 1;      // FTD 當天本身也算「修正中」那天
    }
    return { ftd, corr, ends };
}

/** 第 i 天收盤看到 → 第 i+1 天收盤買、抱 H 天 */
export function fwd(C, i, H) { return i + 1 + H < C.length ? C[i + 1 + H] / C[i + 1] - 1 : null; }

function meanFwd(C, idx, H) { const v = idx.map(i => fwd(C, i, H)).filter(x => x != null); return { n: v.length, m: mean(v), v }; }

/** 從 pool 抽 k 天 N 次 → 平均 ≥ obs 的比例(單尾) */
export function randomControl(C, pool, k, H, obs, nIter = N_CTRL, seed = 11) {
    const P = pool.filter(i => fwd(C, i, H) != null);
    if (k < 1 || P.length < k * 3) return { p: null, med: null };
    const R = rng(seed), ms = [];
    let ge = 0;
    for (let t = 0; t < nIter; t++) {
        let s = 0; for (let j = 0; j < k; j++) s += fwd(C, P[Math.floor(R() * P.length)], H);
        const m = s / k; ms.push(m); if (m >= obs - 1e-12) ge++;
    }
    return { p: (1 + ge) / (1 + nIter), med: med(ms) };
}

/** 平移安慰劑:FTD 日在可評估區間內整段循環平移 */
export function placeboShift(C, evIdx, H, obs, nIter = N_CTRL, seed = 7) {
    const m = C.length - 1 - H - 1;                    // 可算 fwd 的最後一天 = m
    const ev = evIdx.filter(i => i <= m);
    if (!ev.length || m < 2 * MIN_SHIFT + 10) return { p: null, med: null };
    const R = rng(seed), ms = [];
    let ge = 0;
    for (let t = 0; t < nIter; t++) {
        const off = MIN_SHIFT + Math.floor(R() * (m + 1 - 2 * MIN_SHIFT));
        const mm = mean(ev.map(i => fwd(C, (i + off) % (m + 1), H)));
        ms.push(mm); if (mm >= obs - 1e-12) ge++;
    }
    return { p: (1 + ge) / (1 + nIter), med: med(ms) };
}

/** 怎麼用:v = 報酬指數(跟 C 同一天對齊的陣列,沒有的天是 null)。
 *  mode: 'hold' | 'ftd' | 'ma60' | {delays:[…], seed}(隨機等天數)
 *  出場:收盤比「進場後最高」低 ≥10% → 隔天收盤賣;回場訊號 → 隔天收盤買;創 250 天新高 → 一定回來(三種回場同一個保險) */
export function actionRun(C, v, ftdSet, mode) {
    const n = C.length, start = v.findIndex(x => x > 0);
    if (start < 0) return null;
    const ma60 = new Array(n).fill(null); { let s = 0; for (let i = 0; i < n; i++) { s += C[i]; if (i >= 60) s -= C[i - 60]; if (i >= 59) ma60[i] = s / 60; } }
    const hi250 = new Array(n).fill(null); { const dq = []; for (let i = 0; i < n; i++) { while (dq.length && dq[0] <= i - HI_WIN) dq.shift(); while (dq.length && C[dq[dq.length - 1]] <= C[i]) dq.pop(); dq.push(i); hi250[i] = C[dq[0]]; } }
    const R = typeof mode === 'object' ? rng(mode.seed) : null;
    let eq = 1, peakEq = 1, mdd = 0, inMkt = true, pkC = C[start], pend = null, wait = null, outI = -1, sw = 0, days = 0, inDays = 0, trips = 0;
    let last = start;
    for (let i = start + 1; i < n; i++) {
        if (!(v[i] > 0)) continue;
        if (pend !== null) {                                                     // 昨天收盤的訊號 → 上一個有報酬指數的那天收盤已經換了
            if (pend === 'out') { eq *= 1 - COST_SELL / 100; inMkt = false; sw++; trips++; }
            else { eq *= 1 - COST_BUY / 100; inMkt = true; sw++; pkC = C[last]; }
            pend = null;
        }
        if (inMkt) eq *= v[i] / v[last];
        days++; if (inMkt) inDays++;
        if (eq > peakEq) peakEq = eq; mdd = Math.min(mdd, eq / peakEq - 1);
        if (mode !== 'hold') {
            if (inMkt) {
                pkC = Math.max(pkC, C[i]);
                if (C[i] <= pkC * (1 - CORR_DD / 100)) { pend = 'out'; outI = i; wait = R ? mode.delays[Math.floor(R() * mode.delays.length)] : null; }
            } else {
                const back = C[i] >= hi250[i]
                    || (mode === 'ftd' && ftdSet.has(i))
                    || (mode === 'ma60' && ma60[i] != null && C[i] > ma60[i])
                    || (R && i - outI >= wait);
                if (back) pend = 'in';
            }
        }
        last = i;
    }
    const yrs = days / 250;
    return { mult: r2(eq), cagr: r2((Math.pow(eq, 1 / yrs) - 1) * 100), mdd: pct(mdd), inMkt: r2(inDays / days * 100), trips };
}

export function run(env, log = console.log) {
    const readJ = (p, must) => { if (!p || !fs.existsSync(p)) { if (must) throw new Error(`${p || 'IDX_LONG'} 不存在(⛔ 沒有資料不跑)`); return null; } return JSON.parse(fs.readFileSync(p, 'utf8')); };
    const { rows, tr } = loadIndex({ long: readJ(env.IDX_LONG, true), early: readJ(env.IDX_EARLY, false), now: readJ(env.TWII_NOW, false) });
    const dates = rows.map(r => r.d), C = rows.map(r => r.c), A = rows.map(r => r.a), n = rows.length;
    log(`📈 加權 ${n} 天:${dates[0]} ~ ${dates[n - 1]}・成交金額有值 ${A.filter(x => x > 0).length} 天・報酬指數 ${tr.size} 天`);
    const main = detectFTD(C, A);
    const evI = main.ftd.map(e => e.i);
    const allI = [...Array(n).keys()], corrI = allI.filter(i => main.corr[i] === 1);
    const res = { H: {} };
    const ps = { ctrl: [], plc: [] };
    for (const H of HS) {
        const f = meanFwd(C, evI, H), b = meanFwd(C, allI, H), bc = meanFwd(C, corrI, H);
        const ctrl = randomControl(C, corrI, f.n, H, f.m), plc = placeboShift(C, evI, H, f.m);
        res.H[H] = { n: f.n, mean: pct(f.m), med: pct(med(f.v)), win: r2(f.v.filter(x => x > 0).length / f.n * 100),
                     baseAll: pct(b.m), baseCorr: pct(bc.m), ctrlMed: pct(ctrl.med), pCtrl: ctrl.p, plcMed: pct(plc.med), pPlc: plc.p };
        ps.ctrl.push(ctrl.p); ps.plc.push(plc.p);
    }
    const qc = bh(ps.ctrl), qp = bh(ps.plc);
    HS.forEach((H, k) => { res.H[H].qCtrl = qc[k] == null ? null : +qc[k].toFixed(4); res.H[H].qPlc = qp[k] == null ? null : +qp[k].toFixed(4); });
    const M = res.H[H_MAIN];
    // ② 分段
    const segs = SEGS.map(([k, name, lo, hi]) => {
        const inS = i => dates[i] >= lo && dates[i] < hi;
        const f = meanFwd(C, evI.filter(inS), H_MAIN), bc = meanFwd(C, corrI.filter(inS), H_MAIN);
        return { k, name, n: f.n, mean: pct(f.m), baseCorr: pct(bc.m), ok: f.n >= SEG_MIN_EV ? f.m > bc.m : null };
    });
    // ③ 拿掉最好的一次
    const v60 = evI.map(i => ({ i, r: fwd(C, i, H_MAIN) })).filter(x => x.r != null).sort((a, b) => b.r - a.r);
    const dropBest = mean(v60.slice(1).map(x => x.r));
    // ④ 高原
    const grid = [];
    for (const g of GRID_G) for (const w of GRID_W) {
        const D = detectFTD(C, A, { g, w });
        const f = meanFwd(C, D.ftd.map(e => e.i), H_MAIN), bc = meanFwd(C, allI.filter(i => D.corr[i] === 1), H_MAIN);
        grid.push({ g, w, n: f.n, mean: pct(f.m), baseCorr: pct(bc.m), ok: f.n >= PLATEAU_MIN_EV ? f.m > bc.m : null });
    }
    const baseC = M.baseCorr / 100;
    const segOk = segs.filter(s => s.ok !== null);
    const gates = {
        '①全期': M.mean > M.baseCorr && M.mean > M.baseAll,
        '②分段': segOk.length >= 2 && segOk.every(s => s.ok),
        '③拿掉最好': dropBest > baseC,
        '④高原': grid.filter(x => x.ok !== null).every(x => x.ok),
        '⑤隨機日': M.qCtrl != null && M.qCtrl <= 0.05,
        '⑥安慰劑': M.qPlc != null && M.qPlc <= 0.05,
    };
    // 失敗率:60 天內收盤跌破那次反彈的低點
    const failed = main.ftd.filter(e => { for (let j = e.i + 1; j <= Math.min(n - 1, e.i + 60); j++) if (C[j] < e.low) return true; return false; }).length;
    const evDone = main.ftd.filter(e => e.i + 60 < n).length;
    // 怎麼用
    const v = dates.map(d => tr.has(d) ? tr.get(d) : null);
    const ftdSet = new Set(evI);
    const act = { hold: actionRun(C, v, ftdSet, 'hold'), ftd: actionRun(C, v, ftdSet, 'ftd'), ma60: actionRun(C, v, ftdSet, 'ma60') };
    // 隨機等待:等待天數抽樣自「FTD 版實際等了幾天」—— 用 FTD 版的出場點重跑一次記錄
    const delays = (() => {
        const out = []; let inM = true, pk = 0, oi = -1;
        const st = v.findIndex(x => x > 0); pk = C[st];
        for (let i = st + 1; i < n; i++) {
            if (inM) { pk = Math.max(pk, C[i]); if (C[i] <= pk * (1 - CORR_DD / 100)) { inM = false; oi = i; } }
            else if (ftdSet.has(i)) { out.push(i - oi); inM = true; pk = C[i]; }
        }
        return out;
    })();
    if (delays.length) {
        const rs = []; for (let s = 1; s <= N_RAND_ACT; s++) rs.push(actionRun(C, v, ftdSet, { delays, seed: s }));
        act.rand = { mult: r2(med(rs.map(r => r.mult))), cagr: r2(med(rs.map(r => r.cagr))), mdd: r2(med(rs.map(r => r.mdd))),
                     inMkt: r2(med(rs.map(r => r.inMkt))), beatFtd: rs.filter(r => r.mult >= act.ftd.mult).length, nSeeds: N_RAND_ACT };
    }
    return {
        meta: { generated: new Date().toISOString(), from: dates[0], to: dates[n - 1], days: n, rule: `修正 ≥${CORR_DD}%・反彈第 4~${W_MAIN} 天・漲 ≥${G_MAIN}% 且成交金額 > 前一天`,
                gates: '①全期 ②分段 ③拿掉最好 ④高原 ⑤隨機日 BH ⑥平移安慰劑 BH(都看 60 天)' },
        ftd: main.ftd.map(e => ({ d: dates[e.i], day: e.day, low: dates[e.lowI], r60: pct(fwd(C, e.i, H_MAIN)) })),
        corrDays: corrI.length, endsNoFtd: main.ends, failed, evDone,
        res, segs, dropBest: pct(dropBest), grid, gates, nPass: Object.values(gates).filter(Boolean).length, pass: Object.values(gates).every(Boolean),
        action: act, delaysMed: med(delays),
    };
}

function printReport(R, log = console.log) {
    const s = x => x == null ? '—' : (x >= 0 ? '+' : '') + x;
    log(`\n規則:${R.meta.rule}・${R.meta.from} ~ ${R.meta.to}`);
    log(`FTD ${R.ftd.length} 次・修正中的日子 ${R.corrDays} 天・沒等到 FTD 就漲回去 ${R.endsNoFtd} 次`);
    log(`60 天內跌破反彈低點(失敗):${R.failed}/${R.evDone}`);
    log('   ' + R.ftd.map(e => `${e.d}(第${e.day}天,60天${s(e.r60)}%)`).join(' ・'));
    log('\n持有  次數  平均    中位    賺錢%  全部天數  修正中隨便一天  隨機日中位 p→q     安慰劑中位 p→q');
    for (const [H, r] of Object.entries(R.res.H))
        log(`${String(H).padStart(4)}  ${String(r.n).padStart(4)}  ${s(r.mean).padStart(6)}  ${s(r.med).padStart(6)}  ${String(r.win).padStart(5)}  ${s(r.baseAll).padStart(7)}  ${s(r.baseCorr).padStart(10)}      ${s(r.ctrlMed)} ${r.pCtrl}→${r.qCtrl}   ${s(r.plcMed)} ${r.pPlc}→${r.qPlc}`);
    log('\n分段(60 天):' + R.segs.map(x => `${x.name} ${x.n} 次 ${s(x.mean)} vs ${s(x.baseCorr)} ${x.ok === null ? '(不算)' : x.ok ? '✅' : '❌'}`).join(' ・'));
    log(`拿掉最好那次:${s(R.dropBest)}%`);
    log('高原(60 天平均 vs 修正中基準):');
    for (const x of R.grid) log(`   G=${x.g}% W=${x.w}:${x.n} 次 ${s(x.mean)} vs ${s(x.baseCorr)} ${x.ok === null ? '(<5 次不算)' : x.ok ? '✅' : '❌'}`);
    log(`\n關卡:${Object.entries(R.gates).map(([k, v]) => `${k}${v ? '✅' : '❌'}`).join(' ')} → ${R.nPass}/6 ${R.pass ? '✅ 過關' : '⛔ 沒過'}`);
    const a = R.action;
    log('\n怎麼用(報酬指數、ETF 成本):');
    for (const [k, nm] of [['hold', '買了放著'], ['ftd', '跌 10% 出場 → 等 FTD 回來'], ['ma60', '跌 10% 出場 → 站回 60 日線回來'], ['rand', '跌 10% 出場 → 隨機等(同樣天數分布)']]) {
        const r = a[k]; if (!r) continue;
        log(`   ${nm}:${r.mult} 倍・年化 ${r.cagr}%・最大回撤 ${r.mdd}%・在場 ${r.inMkt}%` + (r.trips != null ? `・出場 ${r.trips} 次` : '') + (r.beatFtd != null ? `・${r.nSeeds} 種亂數有 ${r.beatFtd} 種 ≥ FTD 版` : ''));
    }
    log(`   FTD 版每次出場後等了中位 ${R.delaysMed} 天`);
}

// ── selftest ─────────────────────────────────────────────────────────────────
function selftest() {
    const fails = [];
    const ok = (name, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${name}${c ? '' : '  ' + x}`); if (!c) fails.push(name); };
    // 合成:漲 300 天 → 跌 15% → 谷底 → 反彈第 1~3 天小漲 → 第 5 天 +2% 放量
    const mk = (afterLow, amtUp = true) => {
        const C = [], A = [];
        for (let i = 0; i < 300; i++) { C.push(100 + i * 0.1); A.push(100); }
        const top = C[C.length - 1];
        for (let k = 1; k <= 20; k++) { C.push(top * (1 - 0.0085 * k)); A.push(100); }
        for (const r of afterLow) { C.push(C[C.length - 1] * (1 + r)); A.push(100); }
        if (!amtUp) A[A.length - 1] = 90; else A[A.length - 1] = 120;
        return { C, A };
    };
    const lowI = 319;
    let t = mk([0.003, 0.002, 0.001, 0.001, 0.02]);
    let D = detectFTD(t.C, t.A);
    ok('② 反彈第 5 天漲 2% 放量 → FTD', D.ftd.length === 1 && D.ftd[0].i === lowI + 5 && D.ftd[0].day === 5, JSON.stringify(D.ftd));
    t = mk([0.003, 0.002, 0.001, 0.001, 0.02], false);
    ok('② 同一天量縮 → 不是 FTD', detectFTD(t.C, t.A).ftd.length === 0);
    t = mk([0.003, 0.002, 0.02]);
    ok('③ 第 3 天就大漲 → 不算(要第 4 天以後)', detectFTD(t.C, t.A).ftd.length === 0);
    t = mk([0.003, 0.002, -0.02, 0.001, 0.001, 0.001, 0.02]);
    D = detectFTD(t.C, t.A);
    ok('② 中途跌破前低 → 反彈重算(第 5 天變成新第 3 天以後才數)', D.ftd.length === 1 && D.ftd[0].lowI === lowI + 3 && D.ftd[0].day === 4, JSON.stringify(D.ftd));
    t = mk([0.003, 0.002, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.02]);
    ok('④ 第 W 天以後才大漲 → 不算(W=10)', detectFTD(t.C, t.A).ftd.length === 0 && detectFTD(t.C, t.A, { w: 15 }).ftd.length === 1);
    // ① 截斷不變:任何一天的判斷只看那天以前
    const R0 = rng(3), C = [100], A = [100];
    for (let i = 1; i < 3000; i++) { C.push(C[i - 1] * (1 + (R0() - 0.5) * 0.04 - (i % 700 < 80 ? 0.004 : 0))); A.push(80 + R0() * 40); }
    const full = detectFTD(C, A);
    // 每一天都切一次:只給到那天的資料,那天算出來的(是不是 FTD、是不是修正中)要跟整段一起算的一樣
    //   ⛔ 只切幾個位置抓不到「偷看隔天」—— 切點剛好不是 FTD 那天就看不出來(注入實測過)
    const fullSet = new Set(full.ftd.map(e => e.i));
    let same = full.ftd.length > 0, nOnline = 0;
    for (let k = 1; k < C.length; k++) {
        const part = detectFTD(C.slice(0, k + 1), A.slice(0, k + 1));
        const isF = part.ftd.length && part.ftd[part.ftd.length - 1].i === k;
        if (isF) nOnline++;
        if (!!isF !== fullSet.has(k) || part.corr[k] !== full.corr[k]) { same = false; break; }
    }
    ok(`① 截斷不變(⛔ 偷看未來):亂數序列每一天切一次,當天判斷都跟整段一樣(${nOnline}/${full.ftd.length} 次 FTD)`, same && nOnline === full.ftd.length);
    // fwd:隔天收盤買
    ok('⑤ fwd = 隔天收盤買、抱 H 天', fwd([1, 2, 4, 8], 0, 2) === 3 && fwd([1, 2, 4], 0, 2) === null);
    // 隨機日 / 安慰劑:事件放在大漲前 → p 小;隨機事件 → p 不小
    const Cs = [100]; for (let i = 1; i < 4000; i++) Cs.push(Cs[i - 1] * (1 + (i % 400 >= 1 && i % 400 <= 60 ? 0.004 : -0.0005)));
    const good = []; for (let i = 0; i < 3800; i += 400) good.push(i);
    const pool = [...Array(3800).keys()];
    const gm = mean(good.map(i => fwd(Cs, i, 60)).filter(x => x != null));
    ok('⑥ 事件在大漲前 → 隨機日 p 小', randomControl(Cs, pool, good.length, 60, gm).p < 0.01);
    ok('⑥ 事件在大漲前 → 安慰劑 p 小', placeboShift(Cs, good, 60, gm).p < 0.05);
    const Rr = rng(9), bad = []; for (let k = 0; k < 10; k++) bad.push(Math.floor(Rr() * 3800));
    const bm = mean(bad.map(i => fwd(Cs, i, 60)).filter(x => x != null));
    ok('⑥ 隨機事件 → 安慰劑 p 不小', placeboShift(Cs, bad, 60, bm).p > 0.05);
    // 怎麼用:沒有任何出場 → 跟買了放著一樣;有出場 → 有扣成本
    const v = Cs.map(x => x);
    const h = actionRun(Cs, v, new Set(), 'hold');
    ok('⑦ 買了放著 = 指數本身', Math.abs(h.mult - +(Cs[Cs.length - 1] / Cs[0]).toFixed(2)) < 0.011, JSON.stringify(h));
    const up = [...Array(1000).keys()].map(i => 100 * Math.pow(1.001, i));
    const a1 = actionRun(up, up, new Set(), 'ftd'), a0 = actionRun(up, up, new Set(), 'hold');
    ok('⑦ 一路漲、從不出場 → FTD 版 = 放著', a1.mult === a0.mult && a1.trips === 0);
    const dip = []; for (let i = 0; i < 600; i++) dip.push(i < 200 ? 100 + i * 0.1 : i < 230 ? 120 - (i - 200) * 0.5 : 105 + (i - 230) * 0.1);
    const ad = actionRun(dip, dip, new Set(), 'ma60');
    ok('⑦ 跌 10% 會出場一次、之後回來', ad.trips === 1 && ad.inMkt < 100, JSON.stringify(ad));
    let threw = false; try { run({}); } catch (_) { threw = true; }
    ok('⑧ 沒有 IDX_LONG → 丟錯(⛔ 空過)', threw);
    console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ FTD_SELFTEST_PASS'}`);
    process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else {
        const out = process.argv.slice(2).find(a => a.endsWith('.json'));
        try {
            const R = run(process.env);
            printReport(R);
            if (out) { fs.writeFileSync(out, JSON.stringify(R)); console.log(`\n💾 ${out}`); }
        } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
    }
}
