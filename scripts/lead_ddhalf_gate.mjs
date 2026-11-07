#!/usr/bin/env node
/**
 * ✂️ V82.0.7 👑「跌 20% 收一半」上線前的過關測試(使用者 11/07 選「做成開關並幫我打開」)
 *
 * 為什麼要重測:lead_dd_probe 那份是「兩桶」做法(狀態一變隔天收盤整桶調、另一半放 0050),
 *   而真的要做的是「下一次換倉才收一半(留著的每檔賣一半、新買的每檔一半)、回到最高點那次換倉補回」,
 *   自動下單收回來的錢又是放現金 → 做法不一樣,⛔ 不可直接沿用那份數字。
 *
 * 📌 事先講好的過關條件(⛔ 跑完之後不改;寫在程式裡 = 寫在跑之前):兩段(2022-09-16 起 4 年 / 2011-01-03 起 16 年)都要
 *   G1 中途最多賠(17 條中位)比同一種全攻小 ≥ 3 個百分點
 *   G2 100 萬變多少(17 條中位)> 安慰劑(狀態整段平移 6 種 × 17 條 = 102 次)的中位
 *   ・🅿️ 停 0050 版(App 預設)與 💵 現金版(自動下單)各自要過;狀態一律看 🅿️ 那條帳(= 每晚狀態檔的那一條)
 *   ・補回(top 1)/ 不補回(top 0):兩種都過時用補回;只有「不補回」兩段都賺更多(超過 1%)才換
 *   ・只當參考(⛔ 不當過關條件):配對勝場、現金版用自己那條帳當狀態、'next'(隔天就收)對照兩桶舊數字
 *
 * 跟看板同一把尺:DATA_DIR=<d16> DIV=<d16>/_div16.json END=2026-09-24、100 萬、17 條起點(間距 3)、種子 1000+k
 *   → 先跑「現在」那一列,中位要逐元重現看板 👑(對不上 exit 1,⛔ 往下比)
 *
 * 用法:DATA_DIR=<d16> DIV=<d16>/_div16.json END=2026-09-24 WINS=2022-09-16 node --max-old-space-size=7000 scripts/lead_ddhalf_gate.mjs out.json
 *       node scripts/lead_ddhalf_gate.mjs --selftest(判定的算術)
 */
import fs from 'fs';
import path from 'path';
import { ddSeries, shiftSched, LEAD_DD } from './lib_leaddd.mjs';

const STEP = 3, PATHS = 17, PLACEBO = 6;
export const GATE = Object.freeze({ mddPP: 3, topSwitchPct: 1 });
const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return NaN; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => Math.round(x * 100) / 100;
export const mddOf = eq => { let pk = -Infinity, m = 0; for (const v of eq) { pk = Math.max(pk, v); m = Math.min(m, v / pk - 1); } return m * 100; };

/** 一組 17 條 → {fin 中位(萬), worst, mdd 中位(%), mddW, 配對} */
export function summ(rows, base) {
    const o = { fin: r2(median(rows.map(r => r.fin)) / 1e4), worst: r2(Math.min(...rows.map(r => r.fin)) / 1e4), mdd: r2(median(rows.map(r => r.mdd))), mddW: r2(Math.min(...rows.map(r => r.mdd))) };
    if (base) { o.winFin = rows.filter((r, k) => r.fin > base[k].fin).length; o.winMdd = rows.filter((r, k) => r.mdd > base[k].mdd).length; }
    if (rows[0] && rows[0].half != null) o.half = r2(median(rows.map(r => r.half)));
    return o;
}

/** 過關判定(⛔ 跑完不改):每一段 G1 + G2;回 {pass, why[]} */
export function judge(byWin, mode, top) {
    const why = []; let pass = true;
    for (const [w, x] of Object.entries(byWin)) {
        const v = x[`${mode}_t${top}`], b = x[`base_${mode}`], plc = x[`${mode}_t${top}_plc`];
        if (!v || !b || !plc) { pass = false; why.push(`${w} 缺資料`); continue; }
        const g1 = v.mdd >= b.mdd + GATE.mddPP, g2 = v.fin > plc.fin;
        if (!g1) why.push(`${w} G1 沒過:回撤 ${v.mdd}% vs 全攻 ${b.mdd}%(要小 ≥${GATE.mddPP} 個百分點)`);
        if (!g2) why.push(`${w} G2 沒過:${v.fin} 萬 ≤ 安慰劑 ${plc.fin} 萬`);
        pass = pass && g1 && g2;
    }
    return { pass, why };
}

/** 補回 / 不補回:兩種都過 → 補回;只有不補回兩段都多賺 >1% 才換 */
export function pickTop(byWin, mode) {
    const p1 = judge(byWin, mode, 1).pass, p0 = judge(byWin, mode, 0).pass;
    if (p1 && !p0) return 1;
    if (p0 && !p1) return 0;
    if (!p1 && !p0) return null;
    const better0 = Object.values(byWin).every(x => x[`${mode}_t0`].fin > x[`${mode}_t1`].fin * (1 + GATE.topSwitchPct / 100));
    return better0 ? 0 : 1;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); c ? ok++ : bad++; };
    const W = (v, b, plc) => ({ base_p: b, p_t1: v, p_t1_plc: plc, p_t0: v, p_t0_plc: plc, base_c: b, c_t1: v, c_t1_plc: plc, c_t0: v, c_t0_plc: plc });
    // ① 回撤小 3.0 個百分點 → 過;2.99 → 不過
    const a = judge({ w: W({ fin: 100, mdd: -40 }, { fin: 120, mdd: -43 }, { fin: 90 }) }, 'p', 1), b = judge({ w: W({ fin: 100, mdd: -40.01 }, { fin: 120, mdd: -43 }, { fin: 90 }) }, 'p', 1);
    t(a.pass && !b.pass, '① G1 門檻:小 3.00 個百分點過、2.99 不過');
    // ② 贏安慰劑才過(等於不算贏)
    const c = judge({ w: W({ fin: 100, mdd: -30 }, { fin: 120, mdd: -43 }, { fin: 100 }) }, 'p', 1);
    t(!c.pass && /G2/.test(c.why.join()), '② G2:跟安慰劑一樣多 = 沒過');
    // ③ 兩段都要:一段沒過就不過
    const d = judge({ a: W({ fin: 100, mdd: -30 }, { fin: 120, mdd: -43 }, { fin: 90 }), b: W({ fin: 100, mdd: -42 }, { fin: 120, mdd: -43 }, { fin: 90 }) }, 'p', 1);
    t(!d.pass && /^b G1/.test(d.why[0]), '③ 兩段都要過(16 年那段沒過 → 不過)');
    // ④ pickTop:都過 → 1;不補回兩段都多 1.5% → 0;只多 0.5% → 1
    const mk = (f1, f0) => ({ base_p: { fin: 200, mdd: -50 }, p_t1: { fin: f1, mdd: -40 }, p_t1_plc: { fin: 50 }, p_t0: { fin: f0, mdd: -40 }, p_t0_plc: { fin: 50 } });
    t(pickTop({ a: mk(100, 100), b: mk(100, 100) }, 'p') === 1 && pickTop({ a: mk(100, 101.5), b: mk(100, 101.6) }, 'p') === 0 && pickTop({ a: mk(100, 100.5), b: mk(100, 102) }, 'p') === 1,
        '④ 補回 / 不補回:都過用補回、不補回兩段都多 >1% 才換');
    // ⑤ mddOf:100 → 120 → 90 = −25%
    t(Math.abs(mddOf([100, 120, 90, 110]) + 25) < 1e-9, '⑤ 中途最多賠:100 → 120 → 90 = −25%');
    console.log(`\n${bad ? '❌' : '✅'} lead_ddhalf_gate selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

async function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA || !out) { console.error('用法:DATA_DIR=… DIV=… END=2026-09-24 node scripts/lead_ddhalf_gate.mjs out.json'); process.exit(1); }
    const { loadCtx, simulate } = await import('./leader_probe.mjs');
    const t0 = Date.now(), ctx = loadCtx(DATA, DIV);
    console.log(`📂 ${ctx.meta.stocks} 檔・${ctx.cal[0]}~${ctx.cal.at(-1)}・0050 股利 ${ctx.meta.d50} 筆`);
    if (ctx.meta.stocks < 1000 || ctx.meta.d50 < 10) { console.error('🚨 資料不夠(檔數 < 1000 或 0050 股利 < 10),拒跑'); process.exit(1); }
    let PB = null;
    try { const pro = fs.readFileSync(new URL('../pro.html', import.meta.url), 'utf8'), a = pro.indexOf('_PROFIT_BOARD: {'), b = pro.indexOf('\n', a); PB = JSON.parse(pro.slice(a + 15, b).trim().replace(/,$/, '')); }
    catch (e) { console.log('⚠️ 讀不到看板:' + e.message); }
    const WINS = (process.env.WINS || '2022-09-16,2011-01-03').split(',');
    const res = { asof: new Date().toISOString().slice(0, 10), data_to: ctx.cal.at(-1), gate: GATE, rule: LEAD_DD, wins: {} };
    const rowOf = (eq, w) => ({ fin: eq.at(-1), mdd: mddOf(eq), half: w ? Array.from(w).filter(x => x < 1).length / w.length * 100 : null });
    for (const w of WINS) {
        const s0 = ctx.cal.findIndex(d => d >= w), T = Date.now();
        const run = (cfg, wOf) => Array.from({ length: PATHS }, (_, k) => {
            const s = s0 + STEP * k, extra = wOf ? { ddHalf: { at: 'reb', ...cfg.ddHalf, _w: wOf(k) } } : {};
            return simulate(ctx, s, { ...cfg, ...extra, capital: 1e6 }, 1000 + k);
        });
        const x = {};
        // R0 尺:看板那一列(不設 ldLock)要逐元重現
        const r0 = run({});
        const me = Math.round(median(r0.map(r => r.eq.at(-1))));
        const row = PB && Object.values(PB.wins || {}).find(z => z.from === w), lead = row && row.rows.find(z => z.k === 'lead');
        if (lead && PB.to === (process.env.END || '')) {
            if (Math.abs(me - lead.fin) > 1) { console.error(`🚨 [${w}] 現在 ${me} ≠ 看板 ${lead.fin} → 尺不同,拒跑`); process.exit(1); }
            console.log(`🎯 [${w}] 現在 == 看板 👑 全攻(${lead.fin.toLocaleString()} 元)`);
        } else console.log(`⚠️ [${w}] END(${process.env.END || '沒設'})跟看板(${PB && PB.to})不同 → 不比對`);
        x.ruler = summ(r0.map(r => rowOf(r.eq)));
        // R1 / R2 全攻(跌停賣不掉隔天再賣)= 比較基準;R1 的淨值 = 狀態來源(= 每晚狀態檔那一條)
        const R1 = run({ ldLock: 1 }), R2 = run({ ldLock: 1, park: false });
        const S = R1.map(r => ddSeries(r.eq, LEAD_DD).w), S2 = R2.map(r => ddSeries(r.eq, LEAD_DD).w);
        const b1 = R1.map(r => rowOf(r.eq)), b2 = R2.map(r => rowOf(r.eq));
        x.base_p = summ(b1); x.base_c = summ(b2);
        console.log(`[${w}] 全攻 🅿️ ${x.base_p.fin} 萬・${x.base_p.mdd}% ・💵 ${x.base_c.fin} 萬・${x.base_c.mdd}% ・收一半的日子(🅿️ 帳)中位 ${r2(median(S.map(a => Array.from(a).filter(v => v < 1).length / a.length * 100)))}%`);
        for (const [mode, cfg, base] of [['p', { ldLock: 1 }, b1], ['c', { ldLock: 1, park: false }, b2]]) {
            for (const top of [1, 0]) {
                const V = run({ ...cfg, ddHalf: { top } }, k => S[k]);
                const rows = V.map((r, k) => rowOf(r.eq, S[k]));
                x[`${mode}_t${top}`] = summ(rows, base);
                const plc = [];
                for (let j = 1; j <= PLACEBO; j++) {
                    const P = run({ ...cfg, ddHalf: { top } }, k => shiftSched(S[k], Math.floor(S[k].length * j / 7)));
                    for (const r of P) plc.push({ fin: r.eq.at(-1), mdd: mddOf(r.eq) });
                }
                x[`${mode}_t${top}_plc`] = { fin: r2(median(plc.map(r => r.fin)) / 1e4), mdd: r2(median(plc.map(r => r.mdd))), n: plc.length };
                x[`${mode}_t${top}_st`] = { trim: median(V.map(r => r.st.ddTrim || 0)), top: median(V.map(r => r.st.ddTop || 0)), blk: median(V.map(r => r.st.ddTopBlk || 0)), ld: median(V.map(r => r.st.ddTrimLd || 0)) };
                const v = x[`${mode}_t${top}`], p = x[`${mode}_t${top}_plc`];
                console.log(`[${w}] ${mode === 'p' ? '🅿️' : '💵'} 補回 ${top}:${v.fin} 萬(最差 ${v.worst})・回撤 ${v.mdd}%(最差 ${v.mddW})・配對賺 ${v.winFin}/17 少賠 ${v.winMdd}/17 ・🎲 安慰劑 ${p.fin} 萬 / ${p.mdd}% ・收 ${x[`${mode}_t${top}_st`].trim} 次 補 ${x[`${mode}_t${top}_st`].top} 次`);
            }
        }
        // 只當參考:現金版用自己那條帳當狀態、'next'(隔天就收)對照兩桶舊數字
        const own = run({ ldLock: 1, park: false, ddHalf: { top: 1 } }, k => S2[k]);
        x.c_t1_own = summ(own.map((r, k) => rowOf(r.eq, S2[k])), b2);
        const nx = run({ ldLock: 1, ddHalf: { top: 1, at: 'next' } }, k => S[k]);
        x.p_next = summ(nx.map((r, k) => rowOf(r.eq, S[k])), b1);
        console.log(`[${w}] 參考:💵 用自己那條帳 ${x.c_t1_own.fin} 萬・${x.c_t1_own.mdd}% ・'next' 隔天就收 ${x.p_next.fin} 萬・${x.p_next.mdd}% ・⏱️ ${((Date.now() - T) / 1000).toFixed(0)}s`);
        res.wins[w] = x;
        fs.writeFileSync(out, JSON.stringify(res));
    }
    if (WINS.length >= 2) {
        res.verdict = {};
        for (const mode of ['p', 'c']) {
            res.verdict[mode] = { t1: judge(res.wins, mode, 1), t0: judge(res.wins, mode, 0), top: pickTop(res.wins, mode) };
            const v = res.verdict[mode];
            console.log(`\n⚖️ ${mode === 'p' ? '🅿️ 停 0050' : '💵 現金'}:補回 ${v.t1.pass ? '✅ 過' : '⛔ 沒過'}${v.t1.why.length ? '(' + v.t1.why.join(';') + ')' : ''} ・不補回 ${v.t0.pass ? '✅ 過' : '⛔ 沒過'}${v.t0.why.length ? '(' + v.t0.why.join(';') + ')' : ''} → 用 top ${v.top}`);
        }
        fs.writeFileSync(out, JSON.stringify(res));
    }
    console.log(`💾 ${out} ・⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

/** 兩段分開跑(各一個行程)時合起來判:node scripts/lead_ddhalf_gate.mjs --judge a.json b.json [out.json] */
function judgeFiles(files, out) {
    const res = { wins: {} };
    for (const f of files) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); Object.assign(res.wins, j.wins); res.asof = j.asof; res.data_to = j.data_to; res.gate = j.gate; res.rule = j.rule; }
    if (Object.keys(res.wins).length < 2) { console.error('🚨 要兩段(4 年 + 16 年)都在才判'); return 1; }
    res.verdict = {};
    for (const mode of ['p', 'c']) {
        res.verdict[mode] = { t1: judge(res.wins, mode, 1), t0: judge(res.wins, mode, 0), top: pickTop(res.wins, mode) };
        const v = res.verdict[mode];
        console.log(`⚖️ ${mode === 'p' ? '🅿️ 停 0050' : '💵 現金'}:補回 ${v.t1.pass ? '✅ 過' : '⛔ 沒過'}${v.t1.why.length ? '(' + v.t1.why.join(';') + ')' : ''} ・不補回 ${v.t0.pass ? '✅ 過' : '⛔ 沒過'}${v.t0.why.length ? '(' + v.t0.why.join(';') + ')' : ''} → 用 top ${v.top}`);
    }
    if (out) fs.writeFileSync(out, JSON.stringify(res));
    return 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain && process.argv[2] === '--judge') { const fs3 = process.argv.slice(3), outJ = fs3.length > 2 ? fs3.pop() : null; process.exit(judgeFiles(fs3, outJ)); }
else if (_isMain) main();
