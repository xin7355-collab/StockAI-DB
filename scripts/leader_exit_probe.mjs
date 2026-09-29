#!/usr/bin/env node
/**
 * 👑🚪 V77.9.6 「手上的股票,用領頭羊的賣法好,還是用 🧬 三條出場好?」
 *
 * 使用者(選 👑 當全站策略時):「其它個股要回測才知道是否適合,不是直接問我」。
 * 👑 的賣法 = 每 10 個交易日換倉那天收盤看排名:不在「成交額前 100 大 × 趨勢 × 10 日動能」前 10 名 → 隔天開盤賣;
 *             在前 10 名就續抱到下一次換倉(⛔ 沒有停損線)。
 * 🧬 的賣法 = 現行三條(先到先賣,收盤成交):硬停損 min(買進當天最低, 成本×0.95)・吊燈 ATR 2 倍(進場那天的 ATR)・抱滿 20 天。
 *
 * ⭐ 同一筆持股、只換賣法(⛔ 不各跑一次組合回測 —— 出場早晚會改變下一筆進場)。
 *   事件 = 任一檔普通股、任一天收盤「手上有這檔」(每 5 個交易日取樣一次,相位依代號錯開)。
 *   ⭐ 固定觀察 H 天:賣掉之後那筆錢停 0050 含息到第 H 天 → 兩種賣法比的是「第 H 天手上值多少」(持有天數不同也公平)。
 *   分組(進場那天的狀態,只用 ≤ 當天的資料):
 *     top5 = 領頭羊前 5 名 ・keep = 第 6~10 名 ・pool = 前 100 大且趨勢對、但排不進前 10 ・notrend = 前 100 大但趨勢不對 ・out = 不在前 100 大
 *   對照:sell0 = 當天收盤直接賣掉換 0050 ・hold = 抱滿 H 天(⛔ 都是描述,不是候選)。
 * 關卡(差值 = 👑 − 🧬,以「同一個進場日的平均」為一個樣本,⛔ 不把同一天的上百檔當獨立):
 *   ① 全期 > 0 且 |t| ≥ 2 ② 前後半同號 ③ 逐年同號(≥ 2/3 年)④ 拿掉最好那年仍同號 ⑤ 兩個窗口同號 ⑥ H=60 與 H=120 同號
 * 零前視:排名 / 趨勢 / 分組全部只用 ≤ 當天收盤;賣出成交在隔天開盤(👑)或當天收盤(🧬,同 auto_trade.py)。
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json node --max-old-space-size=8192 scripts/leader_exit_probe.mjs out.json
 *       node scripts/leader_exit_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, mom, DEF } from './leader_probe.mjs';

const FEE = 0.001425, TAX = 0.003, ETF_TAX = 0.001;
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const tstat = a => { if (a.length < 3) return NaN; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return m / Math.sqrt(v / a.length); };
const GROUPS = ['top5', 'keep', 'pool', 'notrend', 'out'];
export const GNAME = { top5: '領頭羊前 5 名', keep: '第 6~10 名', pool: '前 100 大・趨勢對・排 10 名外', notrend: '前 100 大・趨勢不對', out: '不在前 100 大' };

/** 每一天的排名狀態(⛔ 只用 ≤ i):rank(1 起算;前 N×hyst 以外記 99)、inPool、trendOk */
export function dailyStatus(ctx, from, P = DEF) {
    const { cal, stocks } = ctx, n = cal.length;
    const st = stocks.map(() => new Uint8Array(n));           // 0 = 沒資料 ・1 top5 ・2 keep ・3 pool ・4 notrend ・5 out
    for (let i = Math.max(from, 60); i < n; i++) {
        const univ = [];
        for (let k = 0; k < stocks.length; k++) { const S = stocks[k]; if (S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0) univ.push(k); else if (S.C[i] > 0 && S.val20[i] > 0) st[k][i] = 5; }
        univ.sort((a, b) => stocks[b].val20[i] - stocks[a].val20[i]);
        const pool = univ.slice(0, P.U), rest = univ.slice(P.U);
        for (const k of rest) st[k][i] = 5;
        const ok = [];
        for (const k of pool) { const S = stocks[k]; if (S.C[i] > S.ma20[i] && S.ma20[i] > S.ma60[i]) ok.push(k); else st[k][i] = 4; }
        const ranked = ok.map(k => ({ k, m: mom(stocks[k], i, P.L) })).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m);
        const seen = new Set(ranked.map(x => x.k));
        for (const k of ok) if (!seen.has(k)) st[k][i] = 3;
        ranked.forEach((x, r) => { st[x.k][i] = r < P.N ? 1 : r < P.N * P.hyst ? 2 : 3; });
    }
    return st;
}

/**
 * 一筆持股:第 e 天收盤手上有 1 元的這檔 → 第 e+H 天值多少(賣掉之後停 0050 含息)
 *   rule = 'lead' | 'gene' | 'sell0' | 'hold';reb(i) = 那天是不是換倉日;keep(i) = 那天收盤還在前 N×hyst
 */
export function simHold(S, e, H, rule, tr, reb, keep) {
    const C = S.C, O = S.O, n = C.length, end = e + H;
    if (end >= n || !(C[e] > 0)) return null;
    const entry = C[e], atr0 = S.atr[e], stop0 = Math.min(S.L[e] > 0 ? S.L[e] : entry, entry * 0.95);
    let sh = 1 / entry, peak = entry, j = e;
    const toEtf = (px, ti) => ({ units: sh * px * (1 - FEE - TAX) * (1 - FEE) / tr[ti], at: ti });
    let park = null;
    if (rule === 'sell0') park = toEtf(entry, e);
    for (j = e + 1; j <= end && !park; j++) {
        if (S.F[j] !== 1 && C[j] > 0) sh *= S.F[j];
        if (!(C[j] > 0)) continue;
        if (rule === 'hold') continue;
        if (rule === 'gene') {
            peak = Math.max(peak, C[j]);
            const hit = C[j] <= stop0 || (atr0 > 0 && C[j] <= peak - 2 * atr0) || j - e >= 20;
            if (hit) park = toEtf(C[j], j);
        } else if (rule === 'lead') {
            if (reb(j) && !keep(j) && j + 1 <= end) {
                let k = j + 1; while (k < end && !(O[k] > 0)) k++;
                const px = O[k] > 0 ? O[k] : C[j];
                if (S.F[k] !== 1 && C[k] > 0) sh *= S.F[k];
                park = toEtf(px, k - 1);             // 開盤成交 ≈ 0050 用前一天收盤(同 leader_probe)
            }
        }
    }
    if (park) return park.units * tr[end];
    let last = end; while (last > e && !(C[last] > 0)) last--;
    return sh * C[last];
}

function gates(byDate, dates) {
    const keys = [...byDate.keys()].sort();
    const v = keys.map(k => byDate.get(k));
    if (v.length < 10) return null;
    const half = keys.length >> 1, A = v.slice(0, half), B = v.slice(half);
    const yrs = {}; keys.forEach((k, i) => { const y = dates[k].slice(0, 4); (yrs[y] = yrs[y] || []).push(v[i]); });
    const ym = Object.fromEntries(Object.entries(yrs).filter(([, a]) => a.length >= 5).map(([y, a]) => [y, mean(a)]));
    const m = mean(v), sg = Math.sign(m);
    const same = Object.values(ym).filter(x => Math.sign(x) === sg).length, ny = Object.keys(ym).length;
    const best = Object.entries(ym).sort((a, b) => sg * (b[1] - a[1]))[0];
    const drop = v.filter((_, i) => !best || dates[keys[i]].slice(0, 4) !== best[0]);
    return { n: v.length, mean: r2(m), t: r2(tstat(v)), h1: r2(mean(A)), h2: r2(mean(B)), yrs: Object.fromEntries(Object.entries(ym).map(([y, x]) => [y, r2(x)])),
        g1: Math.abs(tstat(v)) >= 2, g2: Math.sign(mean(A)) === Math.sign(mean(B)), g3: ny ? same / ny >= 2 / 3 : false, g4: Math.sign(mean(drop)) === sg, yrSame: `${same}/${ny}` };
}

export function runWindow(ctx, st, from, H, opt = {}) {
    const { cal, stocks, etf } = ctx, n = cal.length, P = DEF;
    const s0 = cal.findIndex(d => d >= from); if (s0 < 0) throw new Error('窗口起點不在日曆裡 ' + from);
    const phases = opt.phases || [0, 3, 7];                     // 換倉相位(⛔ 只用一個相位會把結果綁在某幾天)
    const STEP = opt.step || 5;
    const out = {};
    for (const g of GROUPS) out[g] = { diff: new Map(), lead: [], gene: [], sell0: [], hold: [], cnt: 0 };
    for (const ph of phases) {
        const reb = i => (i - s0 - ph) % P.R === 0;
        for (let k = 0; k < stocks.length; k++) {
            const S = stocks[k], off = (k * 7 + ph) % STEP;
            const keep = i => st[k][i] === 1 || st[k][i] === 2;
            for (let e = s0 + 60 + off; e + H < n; e += STEP) {
                const code = st[k][e]; if (!code || !(S.C[e] > 0) || e - S.jump[e] <= 120) continue;
                const g = GROUPS[code - 1];
                const vL = simHold(S, e, H, 'lead', etf.tr, reb, keep), vG = simHold(S, e, H, 'gene', etf.tr, reb, keep);
                if (vL == null || vG == null) continue;
                const o = out[g]; o.cnt++;
                const d = (vL - vG) * 100;
                const key = e * 10 + ph;                         // 同一天同一相位的平均 = 一個樣本
                const cur = o.diff.get(key) || [0, 0]; cur[0] += d; cur[1]++; o.diff.set(key, cur);
                o.lead.push((vL - 1) * 100); o.gene.push((vG - 1) * 100);
                if (opt.refs !== false) { o.sell0.push((simHold(S, e, H, 'sell0', etf.tr, reb, keep) - 1) * 100); o.hold.push((simHold(S, e, H, 'hold', etf.tr, reb, keep) - 1) * 100); }
            }
        }
    }
    const res = {};
    for (const g of GROUPS) {
        const o = out[g], by = new Map(), dates = {};
        for (const [key, [s, c]] of o.diff) { by.set(key, s / c); dates[key] = cal[Math.floor(key / 10)]; }
        res[g] = { name: GNAME[g], events: o.cnt, lead: r2(mean(o.lead)), gene: r2(mean(o.gene)), sell0: r2(mean(o.sell0)), hold: r2(mean(o.hold)), gates: gates(by, dates) };
    }
    return res;
}

// ─────────────────────────── selftest(合成資料) ───────────────────────────
function synth(nDays, drift, seed) {
    let s = seed >>> 0 || 1; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const C = [], O = [], H = [], L = []; let p = 100;
    for (let i = 0; i < nDays; i++) { const o = p; p = p * (1 + drift + (rnd() - 0.5) * 0.04); O.push(o); C.push(p); H.push(Math.max(o, p) * 1.005); L.push(Math.min(o, p) * 0.995); }
    const n = nDays, f = a => Float64Array.from(a);
    const atr = new Float64Array(n).fill(2);
    return { sym: 'X', O: f(O), H: f(H), L: f(L), C: f(C), F: new Float64Array(n).fill(1), atr, jump: new Int32Array(n).fill(-1e9) };
}
function selftest() {
    let bad = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) bad++; };
    const n = 300, tr = new Float64Array(n).fill(1);             // 0050 不動 → 賣掉就是現金
    const up = synth(n, 0.004, 3), dn = synth(n, -0.004, 5);
    const always = () => true, never = () => false, everyday = () => true;
    // ① 一直在前 10 名 → 👑 抱滿 H 天 = hold
    const vL = simHold(up, 50, 60, 'lead', tr, everyday, always), vH = simHold(up, 50, 60, 'hold', tr, everyday, always);
    ok(Math.abs(vL - vH) < 1e-9, '① 一直在前 10 名 → 👑 賣法 = 抱滿 H 天');
    // ② 從來不在前 10 名 → 👑 第一個換倉日隔天開盤就賣
    const vL2 = simHold(up, 50, 60, 'lead', tr, i => i === 55, never);
    const exp2 = (1 / up.C[50]) * up.O[56] * (1 - FEE - TAX) * (1 - FEE);
    ok(Math.abs(vL2 - exp2) < 1e-9, '② 不在前 10 名 → 換倉日隔天開盤賣(⛔ 不是當天收盤 = 前視)');
    // ③ 🧬 抱滿 20 天就賣
    const flat = synth(n, 0, 9); for (let i = 0; i < n; i++) { flat.C[i] = 100 + (i % 2) * 0.1; flat.O[i] = flat.C[i]; flat.L[i] = 99.9; flat.H[i] = 100.2; }
    const vG = simHold(flat, 50, 60, 'gene', tr, everyday, always);
    ok(Math.abs(vG - (1 / flat.C[50]) * flat.C[70] * (1 - FEE - TAX) * (1 - FEE)) < 1e-9, '③ 🧬 平盤 → 第 20 天收盤賣');
    // ④ 🧬 硬停損:跌破 min(進場日低, ×0.95)那天收盤賣
    const vG2 = simHold(dn, 50, 60, 'gene', tr, everyday, always);
    ok(vG2 < 1 && vG2 > 0.9, '④ 🧬 下跌 → 停損出場,損失有限(' + r2((vG2 - 1) * 100) + '%)');
    // ⑤ ⭐ 決定性對照:上漲股 → 👑(一直在前 10)贏 🧬(20 天就賣);下跌股 → 🧬 贏 👑(沒有停損)
    const upL = simHold(up, 50, 120, 'lead', tr, everyday, always), upG = simHold(up, 50, 120, 'gene', tr, everyday, always);
    const dnL = simHold(dn, 50, 120, 'lead', tr, everyday, always), dnG = simHold(dn, 50, 120, 'gene', tr, everyday, always);
    ok(upL > upG && dnG > dnL, `⑤ 決定性對照:漲 👑${r2(upL)} > 🧬${r2(upG)}、跌 🧬${r2(dnG)} > 👑${r2(dnL)}`);
    // ⑥ 賣掉之後停 0050:0050 漲 10% → 值要跟著漲
    const tr2 = Float64Array.from({ length: n }, (_, i) => i < 56 ? 1 : 1.1);
    const v6 = simHold(up, 50, 60, 'lead', tr2, i => i === 55, never);
    ok(Math.abs(v6 - exp2 * 1.1) < 1e-9, '⑥ 賣掉的錢停 0050 含息到第 H 天');
    // ⑦ sell0 = 當天賣
    ok(Math.abs(simHold(up, 50, 60, 'sell0', tr, everyday, always) - (1 - FEE - TAX) * (1 - FEE)) < 1e-9, '⑦ sell0 = 當天收盤賣掉換 0050');
    // ⑧ 除權息:F 倍數 → 股數變多
    const dv = synth(n, 0, 11); for (let i = 0; i < n; i++) { dv.C[i] = 100; dv.O[i] = 100; dv.L[i] = 99; }
    dv.F[60] = 1.05; for (let i = 60; i < n; i++) { dv.C[i] = 100 / 1.05; dv.O[i] = dv.C[i]; }
    ok(Math.abs(simHold(dv, 50, 30, 'hold', tr, everyday, always) - 1) < 1e-9, '⑧ 除息當天股價掉、股數跟著變 → 市值不變');
    console.log(bad ? `❌ selftest ${bad} 條沒過` : '✅ selftest 8/8');
    return bad ? 1 : 0;
}

function main() {
    const out = process.argv.slice(2).find(a => !a.startsWith('--'));
    const DATA = process.env.DATA_DIR; if (!DATA) { console.error('要 DATA_DIR'); process.exit(2); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, process.env.DIV);
    console.log(`📦 ${ctx.meta.stocks} 檔・日曆 ${ctx.cal[0]} ~ ${ctx.cal[ctx.cal.length - 1]}`);
    const WINS = (process.env.WINS || '2022-09-16,2011-01-03').split(',');
    const res = { asof: ctx.cal[ctx.cal.length - 1], wins: {} };
    for (const w of WINS) {
        const st = dailyStatus(ctx, ctx.cal.findIndex(d => d >= w));
        res.wins[w] = {};
        for (const H of [60, 120]) {
            const R = runWindow(ctx, st, w, H);
            res.wins[w][H] = R;
            console.log(`\n=== 窗口 ${w} 起 ・觀察 ${H} 天(賣掉的錢停 0050)===`);
            for (const g of GROUPS) {
                const r = R[g], G = r.gates;
                console.log(`${GNAME[g].padEnd(18)} n=${r.events} ・👑 ${r.lead}% vs 🧬 ${r.gene}%(差 ${G ? G.mean : '—'}pp t=${G ? G.t : '—'})・當天賣 ${r.sell0}% ・抱滿 ${r.hold}%`
                    + (G ? ` ・關卡 ${[G.g1, G.g2, G.g3, G.g4].map(x => x ? '✅' : '❌').join('')} 前後半 ${G.h1}/${G.h2} 逐年同號 ${G.yrSame}` : ''));
            }
        }
    }
    // ⑤⑥ 跨窗口 / 跨天期同號
    res.verdict = {};
    for (const g of GROUPS) {
        const ms = []; for (const w of WINS) for (const H of [60, 120]) { const G = res.wins[w][H][g].gates; if (G) ms.push(G); }
        const all4 = ms.every(G => G.g1 && G.g2 && G.g3 && G.g4), sg = new Set(ms.map(G => Math.sign(G.mean)));
        res.verdict[g] = { name: GNAME[g], sameSign: sg.size === 1, allGates: all4, lead: sg.size === 1 && [...sg][0] > 0 ? 'lead' : sg.size === 1 ? 'gene' : 'mixed' };
        console.log(`🏁 ${GNAME[g]}:${res.verdict[g].sameSign ? (res.verdict[g].lead === 'lead' ? '👑 賣法較好' : '🧬 賣法較好') : '兩種窗口/天期方向不一致'}${all4 ? '(每一格六關全過)' : ''}`);
    }
    if (out) fs.writeFileSync(out, JSON.stringify(res));
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
