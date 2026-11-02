#!/usr/bin/env node
/**
 * 👑 BT25-B / C:領頭羊短線輪動(👑)兩個改法 —— 事件層 + 4% 寬度閘門的日期檔 + 組合回測配對表 + 全家 BH
 *
 *   B:排名從「10 日動能」換成 RS 加權分數(leader_probe `pick:'rs'`,r21/63/126/189/252 = 0.20/0.30/0.20/0.15/0.15)
 *      事件層:兩種名單(17 個起點的「本來會買的」,同 RK_TRACE)之後 5 / 10 / 20 天各比同一天全部股票多賺多少、同一天 RS 名單 − 動能名單
 *   C:Stockbee 4% 寬度閘門:每天在同一個母體數 up4(漲 ≥4%)/ dn4(跌 ≥4%)→ 近 5 天 Σup4 ÷ Σdn4 > 2 = 開(Σdn4 = 0:Σup4 > 0 才算開)
 *      → GATE_OUT = 「閘門關著的日子」→ leader_probe `pauseFile`(= V79.3.6 停手:換倉日碰到只賣不買、閒錢照停 0050;安慰劑 `pauseShift` 整段平移)
 *      事件層:👑 名單在閘門開 / 關的日子之後比同一天全部股票(C1 / C2)、開 − 關(C3)、名單 − 0050 的開 − 關(C4 = 閘門真正在換的東西:關的時候錢停 0050)
 *
 * 母體 / 同一天對照(B、C 共用;寬度也用同一個):四碼普通股(⛔ ETF)、到那天至少 60 根(⛔ 新股前幾天沒有漲跌幅限制)、那天成交額 ≥ 1,000 萬(screener_edge_probe MIN_AMT)。
 *   漲跌 = 收盤 vs 前一天收盤(除權息調整 = leader_probe 的 F);那天是資料斷崖(lib_cliff 或 leader_probe jump)→ 不算;漲停 / 跌停照算(⛔ 特別處理)。
 * 進出場 = trend_template_probe.fwdRet(隔天開盤買、一價鎖漲停剔除、第 H 天收盤賣、含息、窗口斷崖剔除)。
 * 統計:名單 vs 全部 → 同檔 H 天去重、lib_evgate 六關(成本 0.44;⑥ H ≤ 20 用 t、另印 Newey-West);
 *   同一天 RS − 動能(⛔ 去重、成本 0、⑥ 用 Newey-West lag H−1;安慰劑 = 同一天兩份名單的標籤隨機對調 500 次);
 *   開 − 關 = 兩段不同的日子 → 兩邊各自 Newey-West 變異數的 z(⛔ 六關:沒有同一天配對);安慰劑 = 閘門整段循環平移 500 次。
 *   A_OUT = trend_template_probe 的輸出(逗號隔開:第一個 = 主檔,其他 = RS_MIN 高原那幾次,只收 ③a / ③b 20 日)→ 全部檢定一起 BH(lib_fdr)。
 *
 * 跑法:DATA_DIR=<d16x> DIV=<d16>/_div16.json GATE_OUT=gate_off.json A_OUT=A.json node --max-old-space-size=8000 scripts/leader_rs_breadth_probe.mjs bc.json
 *       node scripts/leader_rs_breadth_probe.mjs --board <leader_probe 輸出.json> [--gate gate_off.json]   (組合回測配對表)
 *       node scripts/leader_rs_breadth_probe.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadCtx, simulate, pauseArr, rng } from './leader_probe.mjs';
import { evPrep, fwdRet, gateX, nwP, Sham, shamPct, fmtRow } from './trend_template_probe.mjs';
import { pTwo } from './lib_evgate.mjs';
import { bhQ } from './lib_fdr.mjs';

export const HS = [5, 10, 20];
export const MIN_AMT = 1e7, MIN_BARS = 60, MIN_CTRL = 30, SHAM_N = 500;
export const GATE = { th: 0.04, win: 5, ratio: 2 };
const STEP = 3, PATHS = 17;                          // = leader_probe runSet(17 條,每 3 個交易日一條)
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sg = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;

/** 母體:那天有交易、到那天至少 60 根、成交額 ≥ 1,000 萬 */
export const elig = (S, i) => S.C[i] > 0 && S.cnt[i] >= MIN_BARS && S.C[i] * S.V[i] >= MIN_AMT;

/** 4% 寬度:每天 up / dn 家數 + 閘門(1 = 開)。⛔ 只用 ≤ 那天收盤的資料;前 win−1 天算不出來 → 開(= 不停手) */
export function breadthGate(ctx, g = GATE) {
    const { cal, stocks } = ctx, n = cal.length, up = new Int32Array(n), dn = new Int32Array(n), on = new Uint8Array(n).fill(1), ratio = new Float64Array(n).fill(NaN);
    for (const S of stocks) for (let i = 1; i < n; i++) {
        if (!elig(S, i) || !(S.C[i - 1] > 0)) continue;
        if (S.cl[i + 1] - S.cl[i] > 0 || S.jump[i] === i) continue;      // 資料斷崖那天 ⛔ 算漲跌
        const r = S.C[i] * S.F[i] / S.C[i - 1] - 1;
        if (r >= g.th) up[i]++; else if (r <= -g.th) dn[i]++;
    }
    let su = 0, sd = 0;
    for (let i = 0; i < n; i++) {
        su += up[i]; sd += dn[i]; if (i >= g.win) { su -= up[i - g.win]; sd -= dn[i - g.win]; }
        if (i < g.win - 1) continue;
        ratio[i] = sd > 0 ? su / sd : (su > 0 ? Infinity : NaN);
        on[i] = sd > 0 ? (su / sd > g.ratio ? 1 : 0) : (su > 0 ? 1 : 0);
    }
    return { up, dn, on, ratio };
}

/** 👑 名單:跟 RK_TRACE 同一個做法 —— 17 個起點各跑一次,把每次換倉「本來會買的」收起來(同一天同一檔只算一次) */
export function leaderPicks(ctx, from, cfg = {}, paths = PATHS) {
    const s0 = ctx.cal.findIndex(d => d >= from), seen = new Map();
    for (let k = 0; k < paths; k++) { const tr = []; simulate(ctx, s0 + STEP * k, { ...cfg, trace: tr }, 1000 + k); for (const x of tr) seen.set(x.d + '|' + x.s, x); }
    const byDay = new Map();
    for (const x of seen.values()) { if (!byDay.has(x.d)) byDay.set(x.d, new Set()); byDay.get(x.d).add(x.s); }
    return byDay;
}

/** 兩段不同日子的平均差(開 − 關):各自用 Newey-West 的變異數 → z → 雙尾 p */
export function nwVarMean(x, lag) {
    const n = x.length; if (n < 8) return NaN;
    const m = mean(x), e = x.map(v => v - m);
    let s = e.reduce((a, v) => a + v * v, 0) / n;
    for (let L = 1; L <= lag; L++) { let c = 0; for (let t = L; t < n; t++) c += e[t] * e[t - L]; s += 2 * (1 - L / (lag + 1)) * c / n; }
    return Math.max(s, 1e-12) / n;
}
export function diffOnOff(days, dm, onOf, lag) {
    const a = [], b = [];
    days.forEach((d, k) => (onOf(d) ? a : b).push(dm[k]));
    const d = mean(a) - mean(b), v = nwVarMean(a, lag) + nwVarMean(b, lag);
    return { d, p: Number.isFinite(v) ? pTwo(d / Math.sqrt(v)) : 1, nOn: a.length, nOff: b.length, mOn: mean(a), mOff: mean(b) };
}

/** 事件層主體。picks = {mom: Map(日期 → Set(代號)), rs: …};gate = breadthGate 的 on */
export function scanBC(ctx, picks, gateOn, opt = {}) {
    const { cal, stocks } = ctx, n = cal.length, K = opt.K ?? SHAM_N;
    const bySym = new Map(stocks.map(S => [S.sym, S])), ix = new Map(cal.map((d, i) => [d, i]));
    const mk = () => ({ days: [], dm: [], n: 0 });
    const out = {};
    for (const H of HS) out[H] = { mom: mk(), rs: mk(), rsMom: mk(), on: mk(), off: mk(), v50: mk(), sh: { mom: new Sham(101 + H, K), rs: new Sham(131 + H, K), rsMom: new Sham(161 + H, K), on: new Sham(191 + H, K), off: new Sham(221 + H, K) }, last: { mom: new Map(), rs: new Map() } };
    const tr = ctx.etf.tr, buf = new Float64Array(stocks.length);
    let uni = new Float64Array(64);                                   // 同一天兩份名單合起來的報酬(標籤對調安慰劑用;不夠大就換大的)
    const days = [...new Set([...picks.mom.keys(), ...picks.rs.keys()])].filter(d => ix.has(d)).sort();
    for (const d of days) {
        const i = ix.get(d);
        for (const H of HS) {
            if (i + H >= n) continue;
            const O = out[H];
            let len = 0, sum = 0; const rr = new Map();
            for (const S of stocks) { if (!elig(S, i)) continue; const r = fwdRet(S, cal, i, H); if (r === null) continue; rr.set(S.sym, r); buf[len++] = r; sum += r; }
            if (len < MIN_CTRL) continue;
            const m = sum / len; for (let k = 0; k < len; k++) buf[k] -= m;
            const b50 = tr[i] > 0 && tr[i + H] > 0 ? (tr[i + H] / tr[i] - 1) * 100 : NaN;
            const ret = sym => { if (rr.has(sym)) return rr.get(sym); const S = bySym.get(sym); return S ? fwdRet(S, cal, i, H) : null; };   // 名單上的股票可能不在母體(例:成交額 < 1,000 萬)→ 照算報酬、對照照舊
            const lev = (key, R) => {
                const set = picks[key].get(d); if (!set) return null;
                let s = 0, c = 0, s50 = 0;
                for (const sym of set) { const r = ret(sym); if (r === null) continue; const L = O.last[key].get(sym); if (L !== undefined && i - L < H) continue; O.last[key].set(sym, i); s += r - m; s50 += r - b50; c++; }
                if (!c) return null;
                R.days.push(d); R.dm.push(s / c); R.n += c; O.sh[key].day(buf, len, c);
                return { c, x: s / c, x50: s50 / c };
            };
            const lm = lev('mom', O.mom); lev('rs', O.rs);
            if (lm) {
                const R = gateOn[i] ? O.on : O.off; R.days.push(d); R.dm.push(lm.x); R.n += lm.c; O.sh[gateOn[i] ? 'on' : 'off'].day(buf, len, lm.c);
                if (Number.isFinite(lm.x50)) { O.v50.days.push(d); O.v50.dm.push(lm.x50); O.v50.n += lm.c; }
            }
            // 同一天 RS − 動能(⛔ 去重:兩份名單同一天全部)
            const sm = picks.mom.get(d), sr = picks.rs.get(d);
            if (sm && sr) {
                const a = [], b = [];
                for (const sym of sr) { const r = ret(sym); if (r !== null) a.push(r); }
                for (const sym of sm) { const r = ret(sym); if (r !== null) b.push(r); }
                if (a.length && b.length) {
                    O.rsMom.days.push(d); O.rsMom.dm.push(mean(a) - mean(b)); O.rsMom.n += a.length;
                    const all = a.concat(b), na = a.length, nb = b.length, sh = O.sh.rsMom, tot = all.reduce((s, x) => s + x, 0);
                    if (uni.length < all.length) uni = new Float64Array(all.length * 2);
                    for (let k = 0; k < all.length; k++) uni[k] = all[k];
                    for (let s = 0; s < sh.K; s++) {   // 標籤對調:前 na 個當 RS、其餘當動能
                        let acc = 0;
                        for (let j = 0; j < na; j++) { const r = j + Math.floor(sh.rand() * (all.length - j)); const t = uni[j]; uni[j] = uni[r]; uni[r] = t; acc += uni[j]; }
                        sh.sum[s] += acc / na - (tot - acc) / nb;
                    }
                    sh.days++;
                }
            }
        }
    }
    return out;
}

/** 事件層 → 檢定列 */
export function reportBC(ctx, out, gateOn, opt = {}) {
    const rows = [], K = opt.K ?? SHAM_N, ix = new Map(ctx.cal.map((d, i) => [d, i])), n = ctx.cal.length;
    const add = (key, name, H, R, sh, o = {}) => {
        const g = gateX(R.days, R.dm, H, { ...o, n: R.n });
        rows.push({ test: key[0], key, name, H, n: R.n, nDays: R.days.length, d: g.d, pT: g.pT, pNW: g.pNW, pUse: g.pUse, useNW: g.useNW, cost: g.cost, nPass: g.nPass, pass: g.pass, half: g.H,
            YR: g.YR.map(y => ({ y: y.y, n: y.n, d: y.d })), yPos: g.YR.filter(y => y.d > 0).length, yTot: g.YR.length, dropBest: g.dropBest, sham: sh ? shamPct(sh.dist(), g.d) : { pct: null } });
    };
    for (const H of HS) add('B1', 'B1 👑 現行(10 日動能)名單 vs 同一天母體(去重)', H, out[H].mom, out[H].sh.mom);
    for (const H of HS) add('B2', 'B2 👑 RS 排名名單 vs 同一天母體(去重)', H, out[H].rs, out[H].sh.rs);
    for (const H of HS) add('B3', 'B3 同一天:RS 名單 − 動能名單(全部)', H, out[H].rsMom, out[H].sh.rsMom, { cost: 0, nw: true });
    for (const H of HS) add('C1', 'C1 👑 名單・閘門開的日子 vs 同一天母體(去重)', H, out[H].on, out[H].sh.on);
    for (const H of HS) add('C2', 'C2 👑 名單・閘門關的日子 vs 同一天母體(去重)', H, out[H].off, out[H].sh.off);
    // C3 / C4:開 − 關(兩段不同日子)+ 平移安慰劑
    const R = rng(4242), shifts = Array.from({ length: K }, () => 60 + Math.floor(R() * (n - 120)));
    const diffRow = (key, name, H, ser) => {
        const onOf = s => d => gateOn[(ix.get(d) + s) % n] === 1;
        const dd = diffOnOff(ser.days, ser.dm, onOf(0), Math.max(0, H - 1));
        const dist = shifts.map(s => { const z = diffOnOff(ser.days, ser.dm, d => gateOn[((ix.get(d) - s) % n + n) % n] === 1, 0); return z.d; }).filter(Number.isFinite).sort((a, b) => a - b);
        const byY = new Map(); ser.days.forEach((d, k) => { const y = d.slice(0, 4); const o = byY.get(y) || { on: [], off: [] }; (gateOn[ix.get(d)] ? o.on : o.off).push(ser.dm[k]); byY.set(y, o); });
        const YR = [...byY.entries()].sort().filter(([, o]) => o.on.length >= 10 && o.off.length >= 10).map(([y, o]) => ({ y, n: o.on.length + o.off.length, d: mean(o.on) - mean(o.off), on: mean(o.on), off: mean(o.off) }));
        rows.push({ test: 'C', key, name, H, n: ser.n, nDays: ser.days.length, d: dd.d, pT: dd.p, pNW: dd.p, pUse: dd.p, useNW: true, cost: 0, nPass: null, pass: null, half: null, onOff: dd,
            YR, yPos: YR.filter(y => y.d > 0).length, yTot: YR.length, sham: shamPct(dist, dd.d) });
    };
    for (const H of HS) diffRow('C3', 'C3 👑 名單 vs 同一天母體:閘門開 − 關', H, (() => { const a = out[H].mom; return a; })());
    diffRow('C4', 'C4 👑 名單 − 0050(同一段):閘門開 − 關(= 閘門關的時候改停 0050 換到的東西)', 10, out[10].v50);
    return rows;
}

/** A_OUT = 「主檔,高原檔,…」:主檔全部列;高原檔(RS_MIN ≠ 70 那幾次)只收跟 RS 有關的同一天比較(③a / ③b、20 日)、key 加 @門檻
 *  (⛔ 整檔收:② 跟 RS 無關,收進來 = 同一個檢定算好幾次,BH 會被灌水)。檔案不存在 → 直接報錯(⛔ 安靜地少一半家族) */
export function loadARows(spec) {
    if (!spec) return [];
    const files = spec.split(',').map(x => x.trim()).filter(Boolean), out = [];
    files.forEach((f, k) => {
        if (!fs.existsSync(f)) throw new Error(`A_OUT 找不到 ${f}`);
        const j = JSON.parse(fs.readFileSync(f, 'utf8')), rs = j.meta && j.meta.rsMin != null ? j.meta.rsMin : 70;
        if (k === 0) { out.push(...(j.rows || [])); return; }
        for (const r of j.rows || []) if ((r.key === 'A3a' || r.key === 'A3b') && r.H === 20) out.push({ ...r, key: `${r.key}@${rs}`, name: `${r.name}(RS ≥ ${rs})` });
    });
    return out;
}
/** 全家 BH:A 那支的列 + 這支的列 → q(依 pUse)*/
export function bhAll(rows) {
    const q = bhQ(rows.map(r => r.pUse));
    rows.forEach((r, k) => { r.q = q[k]; });
    return rows;
}

// ───────────────────────── 組合回測配對表(讀 leader_probe 的輸出)─────────────────────────
/** sets = leader_probe res.sets → 每個窗口:每一組 vs 該窗口第一組(現行)的 17 條配對贏幾條 + 中位數 + 0050 + 逐年 */
export function board(res) {
    const byW = new Map();
    for (const s of res.sets) { if (!byW.has(s.from)) byW.set(s.from, []); byW.get(s.from).push(s); }
    const out = [];
    for (const [w, sets] of byW) {
        const base = sets[0];
        const rows = sets.map(s => ({ name: s.name, cfg: s.cfg, tot: s.tot, b0050: s.b0050, ex: s.ex, beat: s.beat, worstEx: s.worstEx, cagr: s.cagr, mdd: s.mdd, mdd0050: s.mdd0050, trades: s.trades, win: s.win, avg: s.avg,
            worst: Math.min(...s.eqEnd), best: Math.max(...s.eqEnd), pair: s.eqEnd.filter((v, k) => v > base.eqEnd[k]).length, pairTie: s.eqEnd.filter((v, k) => v === base.eqEnd[k]).length, paths: s.eqEnd.length, years: s.years }));
        out.push({ from: w, base: base.name, rows });
    }
    return out;
}

function printBoard(B, shamRe = /平移/) {
    for (const W of B) {
        console.log(`\n📊 [${W.from} 起] 17 條起點(配對 = 跟「${W.base}」同一個起點比,贏幾條)`);
        const real = W.rows.filter(r => !shamRe.test(r.name)), sh = W.rows.filter(r => shamRe.test(r.name));
        for (const r of real) console.log(`  ${r.name.padEnd(24)} 中位 ${r.tot}%(最差 ${r.worst}・最好 ${r.best})vs 0050 含息 ${r.b0050}% ・贏 0050 ${r.beat}/17 ・年化 ${r.cagr}% ・回撤 ${r.mdd}% ・${r.trades} 筆 勝率 ${r.win}% 每筆 ${r.avg}% ・配對贏現行 ${r.pair}/${r.paths}${r.pairTie ? `(平手 ${r.pairTie})` : ''}`);
        if (sh.length) {
            const g = real.find(r => r.cfg && r.cfg.pauseFile && !r.cfg.pauseShift);
            const pairs = sh.map(r => r.pair).sort((a, b) => a - b), meds = sh.map(r => r.tot).sort((a, b) => a - b);
            console.log(`  🎲 閘門整段平移 ${sh.length} 組:中位數 ${meds[0]}~${meds.at(-1)}%(中間 ${meds[Math.floor(meds.length / 2)]})・配對贏現行 ${pairs[0]}~${pairs.at(-1)} 條(中間 ${pairs[Math.floor(pairs.length / 2)]})`
                + (g ? ` → 真的閘門中位 ${g.tot}% 贏 ${sh.filter(r => g.tot > r.tot).length}/${sh.length} 組平移、配對 ${g.pair} 條 ≥ ${sh.filter(r => g.pair >= r.pair).length}/${sh.length} 組` : ''));
        }
        const ys = Object.keys(W.rows[0].years);
        console.log('  逐年中位(策略 / 0050 含息,%):');
        for (const r of real) console.log(`    ${r.name.slice(0, 22).padEnd(22)} ` + ys.map(y => `${y.slice(2)}:${r2(r.years[y].s)}`).join(' '));
        console.log(`    ${'0050 含息'.padEnd(22)} ` + ys.map(y => `${y.slice(2)}:${r2(W.rows[0].years[y].c)}`).join(' '));
    }
}

function main(out) {
    const DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.log('❌ 要 DATA_DIR(跑法見檔頭)'); process.exit(1); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, DIV);
    if (ctx.meta.stocks < 1000) { console.log(`🚨 只有 ${ctx.meta.stocks} 檔 → 停`); process.exit(1); }
    if (ctx.cal[0] > '2011-01-01') { console.log(`🚨 日曆從 ${ctx.cal[0]} 才開始 → ^TWII.json 不是長歷史,停`); process.exit(1); }
    for (const S of ctx.stocks) evPrep(S);
    const G = breadthGate(ctx);
    const FROM = process.env.FROM || '2011-01-03', iF = ctx.cal.findIndex(d => d >= FROM), iAI = ctx.cal.findIndex(d => d >= '2022-09-16');
    const offShare = (a, b) => { let k = 0; for (let i = a; i < b; i++) if (!G.on[i]) k++; return k / (b - a); };
    const upAvg = (() => { let s = 0, t = 0; for (let i = iF; i < ctx.cal.length; i++) { s += G.up[i]; t += G.dn[i]; } return [s / (ctx.cal.length - iF), t / (ctx.cal.length - iF)]; })();
    let runs = 0; for (let i = iF + 1; i < ctx.cal.length; i++) if (!G.on[i] && G.on[i - 1]) runs++;
    console.log(`📂 ${ctx.meta.stocks} 檔・日曆 ${ctx.cal[0]}~${ctx.cal.at(-1)}・載入 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log(`🌡️ 4% 寬度閘門(${FROM} 起):每天平均 up4 ${upAvg[0].toFixed(1)} / dn4 ${upAvg[1].toFixed(1)} 家 ・關著的日子 ${(offShare(iF, ctx.cal.length) * 100).toFixed(1)}%(2022-09-16 起 ${(offShare(iAI, ctx.cal.length) * 100).toFixed(1)}%)・關了 ${runs} 段`);
    const offDates = []; for (let i = GATE.win - 1; i < ctx.cal.length; i++) if (!G.on[i]) offDates.push(ctx.cal[i]);
    if (!offDates.length) { console.log('🚨 閘門從來沒關過 → 算法或資料有問題,停'); process.exit(1); }
    if (process.env.GATE_OUT) { fs.writeFileSync(process.env.GATE_OUT, JSON.stringify(offDates)); console.log(`💾 閘門關著的日子 ${offDates.length} 天 → ${process.env.GATE_OUT}(leader_probe pauseFile)`); }
    const t1 = Date.now();
    const picks = { mom: leaderPicks(ctx, FROM, {}), rs: leaderPicks(ctx, FROM, { pick: 'rs' }) };
    const cnt = m => [...m.values()].reduce((a, s) => a + s.size, 0);
    console.log(`👑 名單(${FROM} 起 17 個起點,「本來會買的」同一天同一檔算一次):現行 ${cnt(picks.mom)} 筆 / ${picks.mom.size} 天 ・RS ${cnt(picks.rs)} 筆 / ${picks.rs.size} 天 ・${((Date.now() - t1) / 1000).toFixed(0)}s`);
    let ovl = 0, tot = 0; for (const [d, s] of picks.rs) { const m = picks.mom.get(d); tot += s.size; if (m) for (const x of s) if (m.has(x)) ovl++; }
    console.log(`🔗 同一天 RS 名單裡 ${(ovl / tot * 100).toFixed(1)}% 也在動能名單`);
    const ev = scanBC(ctx, picks, G.on);
    let rows = reportBC(ctx, ev, G.on);
    const aRows = loadARows(process.env.A_OUT);
    const all = bhAll([...aRows, ...rows]);
    console.log(`\n(* = ⑥ 用 Newey-West;C3 / C4 是兩段日子的差:z 用各自的 Newey-West 變異數、安慰劑 = 閘門平移)・BH 全家 ${all.length} 個檢定${aRows.length ? `(含 A ${aRows.length} 個)` : '(⚠️ 沒給 A_OUT:只有 B / C)'}`);
    for (const r of rows) {
        if (r.key === 'C3' || r.key === 'C4') console.log(`${r.key.padEnd(4)} ${String(r.H).padStart(2)}日 開 ${sg(r.onOff.mOn)} vs 關 ${sg(r.onOff.mOff)} → 差 ${sg(r.d)}pp(開 ${r.onOff.nOn} 天 / 關 ${r.onOff.nOff} 天)p=${r.pUse.toFixed(4)} q=${r.q.toFixed(3)} 年正 ${r.yPos}/${r.yTot} 🎲 平移安慰劑百分位 ${r.sham.pct?.toFixed(1)}`);
        else console.log(fmtRow(r) + ` q=${r.q.toFixed(3)}`);
    }
    if (aRows.length) { console.log('\nA 的 q(全家一起校正):'); for (const r of all.filter(x => x.test === 'A')) console.log(`  ${r.key} ${r.H}日 ${sg(r.d)}pp p=${r.pUse.toFixed(4)} → q=${r.q.toFixed(3)}`); }
    console.log('\n逐年(每天平均的年平均,pp):');
    for (const k of ['B1', 'B2', 'B3', 'C1', 'C2', 'C3']) { const r = rows.find(x => x.key === k && x.H === 10); console.log(`  ${k} 10日 ` + r.YR.map(y => `${y.y.slice(2)}:${sg(y.d)}`).join(' ')); }
    const res = { asof: new Date().toISOString().slice(0, 10), meta: { ...ctx.meta, from: FROM, to: ctx.cal.at(-1), gate: { ...GATE, offShare: offShare(iF, ctx.cal.length), offShareAI: offShare(iAI, ctx.cal.length), runs, offDays: offDates.length, upAvg: upAvg[0], dnAvg: upAvg[1] },
        picks: { mom: cnt(picks.mom), rs: cnt(picks.rs), overlap: ovl / tot } }, rows, bhAll: all.map(r => ({ test: r.test, key: r.key, H: r.H, d: r.d, p: r.pUse, q: r.q })) };
    if (out) { fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log(`💾 ${out}`); }
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s ・⛔ 探針不是測試(exit 0)`);
}

// ───────────────────────── selftest ─────────────────────────
async function selftest() {
    const { prepStock } = await import('./leader_probe.mjs');
    let bad = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) bad++; };
    const cal = []; { const d = new Date(Date.UTC(2016, 0, 4)); while (cal.length < 120) { if (d.getUTCDay() % 6) cal.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
    const mkS = (sym, px, { vol = 1e6, from = 0, opens = null } = {}) => evPrep(prepStock(sym, px.map((c, i) => ({ d: cal[i], o: opens && opens[i] ? opens[i] : c, h: c * 1.005, l: c * 0.995, c, v: vol })).slice(from), cal, []));
    // ① 寬度:A 每 3 天漲 5%(其餘不動)、B 第 70~72 天跌 5%、C 成交額太小(⛔ 算)、D 新股(第 80 天才上市,前 60 根 ⛔ 算)
    const flat = Array(120).fill(50);
    const pA = flat.map((_, i) => 50 * Math.pow(1.05, Math.floor(i / 3)) / Math.pow(1.05, 0)).map((v, i) => i % 3 === 0 ? v : v);
    const pB = flat.map((_, i) => i < 70 ? 50 : 50 * Math.pow(0.95, Math.min(3, i - 69)));
    const pC = flat.map((_, i) => 50 * Math.pow(1.05, i % 2 ? 1 : 0));
    const pD = flat.map((_, i) => 50 * Math.pow(1.06, Math.max(0, i - 80)));
    const ctx = { cal, stocks: [mkS('1201', pA), mkS('1202', pB), mkS('1203', pC, { vol: 100 }), mkS('1204', pD, { from: 80 })], etf: { tr: new Float64Array(120).fill(1) }, bear: new Uint8Array(120) };
    const G = breadthGate(ctx);
    const upDays = [...G.up].map((v, i) => v ? i : -1).filter(i => i >= 0);
    ok(upDays.length && upDays.every(i => i % 3 === 0 && G.up[i] === 1) && G.dn[70] === 1 && G.dn[72] === 1 && G.dn[73] === 0 && G.up.every((v, i) => i < 140 ? true : v === 0),
        `① up4 / dn4:A 每 3 天漲 5% 那天 +1、B 第 70~72 天各 −1;成交額太小 / 新股前 60 根 ⛔ 算(漲 ${upDays.length} 天)`);
    // ② 閘門:近 5 天 Σup ÷ Σdn > 2 才開;dn = 0 時 up > 0 才開
    const exp = i => { let u = 0, d = 0; for (let k = i - 4; k <= i; k++) { u += G.up[k]; d += G.dn[k]; } return d > 0 ? u / d > 2 : u > 0; };
    ok([...Array(116).keys()].map(k => k + 4).every(i => (G.on[i] === 1) === exp(i)) && G.on[72] === 0 && G.on[60] === 1 && G.on[61] === 1 && G.on[62] === 1,
        '② 閘門 = 近 5 天 Σup4 ÷ Σdn4 > 2(dn 加總 0:up > 0 才開);第 70~72 天 B 跌 → 關');
    // ③ 零前視:第 75 天之後全部改掉 → 第 75 天以前的閘門不變
    const ctx3 = { ...ctx, stocks: [mkS('1201', pA.map((v, i) => i > 75 ? v * (i % 2 ? 0.9 : 1.1) : v)), mkS('1202', pB.map((v, i) => i > 75 ? 30 : v)), ctx.stocks[2], ctx.stocks[3]] };
    const G3 = breadthGate(ctx3);
    ok(G3.on.slice(0, 76).every((v, i) => v === G.on[i]) && G3.up.slice(0, 76).every((v, i) => v === G.up[i]) && !G3.on.every((v, i) => v === G.on[i]), '③ 零前視:改掉第 75 天之後 → 第 75 天以前的閘門 / 家數一模一樣(之後有變 = 真的有改到)');
    // ④ 資料斷崖那天 ⛔ 算漲跌(開盤 ×2 的 lib_cliff、收盤 ×1.6 的 leader jump)
    // ⚠️ 斷崖要放在第 60 根以後(⛔ 放太早會因為「不滿 60 根」本來就不算,測不到這一關)
    const pE = flat.map((_, i) => i < 90 ? 50 : 80), pG = flat.map((_, i) => i < 90 ? 50 : 52.5);
    const G4 = breadthGate({ ...ctx, stocks: [mkS('1205', pE)] }), G4b = breadthGate({ ...ctx, stocks: [mkS('1206', pG)] });
    const pO = flat.map(() => 50), oO = pO.map((v, i) => i === 95 ? 100 : 0), G4c = breadthGate({ ...ctx, stocks: [mkS('1207', pO.map((v, i) => i === 95 ? 52.5 : v), { opens: oO })] });
    ok(G4.up[90] === 0 && G4b.up[90] === 1 && G4c.up[95] === 0, '④ 收盤 ×1.6 / 開盤 ×2 的資料斷崖那天 ⛔ 算成漲 4%(對照:同一天真的漲 5% → 算)');
    // ⑤ 閘門日期檔 → leader_probe pauseArr 對回來 = 閘門關著的那幾天(逐日相同)
    const tmp = path.join(os.tmpdir(), `bt25_gate_${process.pid}.json`);
    const offD = []; for (let i = 4; i < cal.length; i++) if (!G.on[i]) offD.push(cal[i]);
    fs.writeFileSync(tmp, JSON.stringify(offD));
    const pz = pauseArr({ cal }, { pauseFile: tmp, pauseK: 0, pauseShift: 0 }); fs.unlinkSync(tmp);
    ok(offD.length > 0 && [...pz].every((v, i) => v === (i >= 4 && !G.on[i] ? 1 : 0)), `⑤ 日期檔 → pauseArr(K=0)逐日 = 閘門關著的 ${offD.length} 天`);
    // ⑥ 開 − 關:開的日子 +1、關的日子 −1 → 差 2;同一串、標籤隨機 → ≈ 0;兩段都一樣 → p ≈ 1
    const days = cal.slice(0, 100), dm = days.map((_, k) => (k % 4 === 0 ? -1 : 1) + 0.01 * Math.sin(k)), onOf = d => days.indexOf(d) % 4 !== 0;
    const z = diffOnOff(days, dm, onOf, 3), z0 = diffOnOff(days, days.map(() => 1), onOf, 3);
    ok(Math.abs(z.d - 2) < 0.05 && z.p < 1e-6 && Math.abs(z0.d) < 1e-12, `⑥ 開 − 關:注入 +1 / −1 → 差 ${z.d.toFixed(3)}(p ${z.p.toExponential(1)});兩邊一樣 → 差 0`);
    // ⑦ 配對表:第二組 17 條裡 12 條比第一組高 → 配對 12/17;平移那幾組另外列
    const fake = (name, eq, cfg = {}) => ({ name, cfg, from: '2011-01-03', tot: eq[8], b0050: 100, ex: 0, beat: 0, worstEx: 0, cagr: 0, mdd: 0, mdd0050: 0, trades: 1, win: 1, avg: 1, eqEnd: eq, years: { 2011: { s: 1, c: 1 } } });
    const base = Array.from({ length: 17 }, (_, k) => 100 + k), alt = base.map((v, k) => k < 12 ? v + 1 : v - 1);
    const B = board({ sets: [fake('現行', base), fake('變體', alt), fake('平移 s', base.map(v => v - 5), { pauseFile: 'x', pauseShift: 9 })] });
    ok(B[0].rows[1].pair === 12 && B[0].rows[0].pair === 0 && B[0].rows[0].pairTie === 17 && B[0].rows[2].pair === 0, '⑦ 配對表:17 條同起點比,12 條贏 → 12/17;自己跟自己 = 全部平手');
    // ⑧ 名單事件層:注入「名單上的股票之後多漲」→ B1 量得到;同一天標籤對調的安慰劑 ≈ 0
    {
        const R = rng(3), N = 60, T = 400, cal8 = []; { const d = new Date(Date.UTC(2016, 0, 4)); while (cal8.length < T) { if (d.getUTCDay() % 6) cal8.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
        const pick = (s, i) => (s * 7 + i) % 15 === 0, stocks = [];
        for (let s = 0; s < N; s++) { const px = []; let p = 40, boost = 0; for (let i = 0; i < T; i++) { p *= 1 + (R() - 0.5) * 0.02 + (boost-- > 0 ? 0.004 : 0); px.push(p); if (pick(s, i) && i > 80) boost = 11; }
            stocks.push(evPrep(prepStock(String(5000 + s), px.map((c, i) => ({ d: cal8[i], o: i ? px[i - 1] : c, h: c * 1.005, l: c * 0.995, c, v: 1e6 })), cal8, []))); }
        const ctx8 = { cal: cal8, stocks, etf: { tr: new Float64Array(T).fill(1) }, bear: new Uint8Array(T) };
        const mom = new Map(), rs = new Map();
        for (let i = 81; i < T - 25; i++) { const a = new Set(), b = new Set(); stocks.forEach((S, s) => { if (pick(s, i)) a.add(S.sym); if (pick(s, i + 3)) b.add(S.sym); }); if (a.size) mom.set(cal8[i], a); if (b.size) rs.set(cal8[i], b); }
        const on = new Uint8Array(T).fill(1);
        const ev = scanBC(ctx8, { mom, rs }, on, { K: 40 }), rw = reportBC(ctx8, ev, on, { K: 40 });
        const b1 = rw.find(r => r.key === 'B1' && r.H === 10), b3 = rw.find(r => r.key === 'B3' && r.H === 10);
        // 每檔每 15 天被挑一次、之後 11 天多漲 0.4%/天 → 同一天對照本身有 ~73% 的時間也在多漲 → 理論上 ≈ (1 − 11/15) × 4.4% ≈ +1.2pp
        ok(b1.d > 0.8 && b1.d < 1.6 && b1.sham.pct > 95 && b3.d < -0.8 && b3.sham.pct < 5, `⑧ 注入「現行名單之後 11 天多漲」→ B1 ${sg(b1.d)}pp(理論 ≈ +1.2;安慰劑百分位 ${b1.sham.pct.toFixed(0)});RS 名單 = 3 天後才會被挑的 → 同一天 RS − 動能 ${sg(b3.d)}pp(標籤對調安慰劑百分位 ${b3.sham.pct.toFixed(0)})`);
        // 合起來超過 64 檔的那一天(標籤對調的暫存陣列要換大的,⛔ 不可以炸)
        const big = new Map([[cal8[100], new Set(stocks.slice(0, 40).map(S => S.sym))]]), big2 = new Map([[cal8[100], new Set(stocks.slice(20, 60).map(S => S.sym))]]);
        let threw = ''; try { scanBC(ctx8, { mom: big, rs: big2 }, on, { K: 5 }); } catch (e) { threw = String(e.message); }
        ok(!threw, `⑧ 同一天兩份名單合起來 80 檔(> 64)→ 照算(${threw || '沒有炸'})`);
    }
    // ⑨ A_OUT 多檔:主檔全收、高原檔只收 ③a / ③b 20 日(key 加 @門檻);找不到檔 → 報錯
    {
        const mkA = (rs, keys) => { const f = path.join(os.tmpdir(), `bt25_a${rs}_${process.pid}.json`); fs.writeFileSync(f, JSON.stringify({ meta: { rsMin: rs }, rows: keys.map(([k, H]) => ({ key: k, H, name: k, pUse: 0.5 })) })); return f; };
        const all = [['A1', 20], ['A2', 20], ['A3a', 5], ['A3a', 20], ['A3b', 20], ['A4b', 20]];
        const f70 = mkA(70, all), f80 = mkA(80, all);
        const rows = loadARows(`${f70},${f80}`);
        let threw = ''; try { loadARows(`${f70},/nope/x.json`); } catch (e) { threw = String(e.message); }
        fs.unlinkSync(f70); fs.unlinkSync(f80);
        ok(rows.length === 8 && rows.filter(r => r.key.includes('@')).map(r => r.key).join() === 'A3a@80,A3b@80' && /找不到/.test(threw), `⑨ A_OUT 多檔:主檔 6 列 + 高原檔只收 ③a / ③b 20 日 2 列(${rows.length})、找不到檔報錯`);
    }
    console.log(bad ? `❌ ${bad} 條沒過` : '✅ 全過');
    process.exit(bad ? 1 : 0);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) selftest();
else if (_isMain && process.argv.includes('--board')) {
    const f = process.argv[process.argv.indexOf('--board') + 1];
    const res = JSON.parse(fs.readFileSync(f, 'utf8'));
    const B = board(res); printBoard(B);
    const o = process.argv.find(a => a.startsWith('--out='));
    if (o) fs.writeFileSync(o.slice(6), JSON.stringify(B, null, 1));
}
else if (_isMain) main(process.argv.slice(2).find(a => a.endsWith('.json')) || '');
