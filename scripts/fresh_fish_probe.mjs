#!/usr/bin/env node
/**
 * 🐟 V78.6.1「只釣這一批以外的新魚」回測(股海釣手的池子)
 *
 * V78.6.0 起:散戶 App 決策台固定列「上次換倉那天的前 10 名」(10 天不變),
 * 股海釣手每天釣「今天排名扣掉那一批」的前 10 條。使用者:「我要你回測」。
 *
 * 問的事:每天收盤看到的那 10 條新魚,隔天開盤買、抱 h 天(1/5/10/20),
 *   ① 有沒有贏 0050 含息(同一天開盤買、抱同樣天數)
 *   ② 有沒有比這幾組好:👑 今天前 10(舊的釣魚池)/ 📦 正在養的那一批 / 🎲 同一個池子隨便抽同樣檔數
 *
 * 排名 = leader_probe.simulate 的 rankAt 預設路徑一字不差(成交額 20 日均前 U、收盤 > 20 日線 > 60 日線、近 L 日動能排序);
 *   ⚠️ 那份是閉包 import 不到 → 這裡照抄,--selftest ⓪ 拿 data 分支的 pick_history 對表。
 * 換倉相位:錨點只是 10 個相位之一 → 10 個相位都算(這一批 = 最近一個換倉日 r ≤ i 那天的前 10),組平均先在相位間平均。
 * 零前視:第 i 天收盤決定,第 i+1 天開盤買(開盤接近漲停 = 買不到,剔除並計數);h 天後收盤賣;除權息倍數累乘;
 *   持有期間出現資料斷崖(jump)剔除。成本 0.44%(買賣手續費 + 證交稅)。0050 = 同一天開盤買、含息、不扣成本。
 * ⭐ 先算「每一天的組平均」再對天數平均(V78.2.6:事件平均會被大跌日撐起來);六關用每 h 天取一天(不重疊)。
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json WINS=2022-09-16,2011-01-03 node --max-old-space-size=8192 scripts/fresh_fish_probe.mjs out.json
 *       DATA_DIR=… PH=pick_history.json node scripts/fresh_fish_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, mom, rng, DEF, prepStock } from './leader_probe.mjs';
import { gates } from './maxim_kbar5_probe.mjs';

const FEE = 0.001425, TAX = 0.003, COST = 2 * FEE + TAX;
const HS = [1, 5, 10, 20];
const limitOf = d => d < '2015-06-01' ? 0.07 : 0.10;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const r3 = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
const INJ = process.env.FF_INJECT || '';

/** 排名:照抄 leader_probe.simulate 的 rankAt 預設路徑(pool 非 theme、pick='mom'、沒有 noAtt/noDisp/skip/riskadj) */
export function rankAt(ctx, i, P) {
    const univ = [];
    for (const S of ctx.stocks) { if (S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0) univ.push(S); }
    univ.sort((a, b) => b.val20[i] - a.val20[i]);
    const ok = univ.slice(0, P.U).filter(S => S.C[i] > S.ma20[i] && S.ma20[i] > S.ma60[i]);
    const ranked = ok.map(S => ({ S, m: mom(S, i, P.L) })).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m).map(x => x.S);
    return { ranked, ok };
}
/** 最近一個換倉日 r ≤ i(相位 φ:(r − φ) % R === 0) */
export function rebOf(i, phi, R) { const k = ((i - phi) % R + R) % R; return i - k + (INJ === 'reboff' ? 1 : 0); }
/** 新魚 = 今天排名扣掉這一批,取前 K */
export function freshOf(ranked, batchSet, K) { return (INJ === 'nobatch' ? ranked : ranked.filter(S => !batchSet.has(S))).slice(0, K); }

/** 隔天開盤買 → h 天後收盤賣(扣成本);'lock' = 開盤接近漲停買不到;null = 資料不夠 */
export function retOf(ctx, S, i, h) {
    const a = i + 1, b = i + h, n = ctx.cal.length;
    if (b >= n || !(S.O[a] > 0) || !(S.C[i] > 0)) return null;
    if (S.O[a] >= S.C[i] * (1 + limitOf(ctx.cal[a]) - 0.003)) return 'lock';
    if (!(S.C[b] > 0) || S.jump[b] > i) return null;
    let f = 1; for (let k = a + 1; k <= b; k++) f *= S.F[k];
    return S.C[b] * f / S.O[a] - 1 - COST;
}

function load0050(DATA, cal) {
    const p = path.join(DATA, '0050.json'); const oc = new Float64Array(cal.length).fill(NaN);
    if (!fs.existsSync(p)) return oc;
    const idx = new Map(cal.map((d, i) => [d, i]));
    for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) { const i = idx.get(String(r.date).replace(/\//g, '-').slice(0, 10)); if (i !== undefined && +r.open > 0 && +r.close > 0) oc[i] = +r.close / +r.open; }
    return oc;
}
/** 0050 同一天開盤買、含息、抱到 h 天後收盤(收盤之間用含息指數) */
function benchOf(ctx, oc, i, h) { const a = i + 1, b = i + h; if (b >= ctx.cal.length) return NaN; const tr = ctx.etf.tr; return (Number.isFinite(oc[a]) ? oc[a] : 1) * tr[b] / tr[a] - 1; }

const grpMean = (ctx, list, i, h, st) => { const v = []; for (const S of list) { const r = retOf(ctx, S, i, h); if (r === 'lock') { st.lock++; continue; } if (r == null) { st.miss++; continue; } v.push(r); } return v.length ? mean(v) : NaN; };

/** 跑一個窗口:回傳每一天各組的「扣成本報酬」與 0050 */
export function runWindow(ctx, oc, s0, P, opt = {}) {
    const R = P.R, KS = opt.KS || [10], seeds = opt.seeds || 5, n = ctx.cal.length;
    const end = n - 1 - Math.max(...HS);
    const rk = new Map(); const rank = i => { if (!rk.has(i)) rk.set(i, rankAt(ctx, i, P)); return rk.get(i); };
    const days = []; const st = { lock: 0, miss: 0, overlap: 0 };
    for (let i = s0; i <= end; i++) {
        const { ranked, ok } = rank(i);
        if (ranked.length < 12) continue;
        const day = { d: ctx.cal[i], i, h: {} };
        for (const h of HS) {
            const b0 = benchOf(ctx, oc, i, h); if (!Number.isFinite(b0)) continue;
            const g = { b0, lead10: grpMean(ctx, ranked.slice(0, 10), i, h, st), all: grpMean(ctx, ok, i, h, st) };
            const ph = { fresh: {}, batch: [], sham: [] };
            for (const K of KS) ph.fresh[K] = [];
            for (let phi = 0; phi < R; phi++) {
                const r = rebOf(i, phi, R); if (r < 0) continue;
                const B = new Set(rank(r).ranked.slice(0, 10));
                for (const K of KS) { const F = freshOf(ranked, B, K); if (h === 1 && K === 10) for (const S of F) if (B.has(S)) st.overlap++; ph.fresh[K].push(grpMean(ctx, F, i, h, st)); }
                ph.batch.push(grpMean(ctx, [...B], i, h, st));
                const pool = ok.filter(S => !B.has(S)), m = Math.min(10, pool.length), sv = [];
                for (let k = 0; k < seeds; k++) { const rr = rng(i * 131 + phi * 17 + k * 7919 + 1); const pick = pool.map(S => ({ S, k: rr() })).sort((a, b) => a.k - b.k).slice(0, m).map(x => x.S); sv.push(grpMean(ctx, pick, i, h, st)); }
                ph.sham.push(mean(sv.filter(Number.isFinite)));
            }
            const fm = {}; for (const K of KS) fm[K] = mean(ph.fresh[K].filter(Number.isFinite));
            g.fresh = fm[10]; g.freshK = fm; g.batch = mean(ph.batch.filter(Number.isFinite)); g.sham = mean(ph.sham.filter(Number.isFinite));
            g.freshPh = ph.fresh[10]; g.shamPh = ph.sham;
            day.h[h] = g;
        }
        days.push(day);
    }
    return { days, st };
}

/** 摘要:每組 vs 0050 的日平均超額、絕對;增量六關(不重疊取樣) */
export function summarize(W, s0, KS) {
    const out = {};
    for (const h of HS) {
        const D = W.days.filter(x => x.h[h] && Number.isFinite(x.h[h].fresh) && Number.isFinite(x.h[h].sham) && Number.isFinite(x.h[h].lead10) && Number.isFinite(x.h[h].batch));
        const NO = D.filter(x => (x.i - s0) % h === 0);
        const ex = (k, A) => A.map(x => ({ d: x.d, v: (x.h[h][k] - x.h[h].b0) * 100 }));
        const inc = (a, b, A) => A.map(x => ({ d: x.d, v: (x.h[h][a] - x.h[h][b]) * 100 }));
        const o = { days: D.length, nonOverlap: NO.length, grp: {} };
        for (const k of ['fresh', 'lead10', 'batch', 'sham', 'all']) { const v = D.map(x => x.h[h][k]).filter(Number.isFinite); o.grp[k] = { net: r3(mean(v) * 100), vs0050: r3(mean(D.map(x => x.h[h][k] - x.h[h].b0).filter(Number.isFinite)) * 100), beat0050: r3(D.filter(x => x.h[h][k] > x.h[h].b0).length / D.length * 100) }; }
        o.b0050 = r3(mean(D.map(x => x.h[h].b0)) * 100);
        o.freshK = {}; for (const K of KS) o.freshK[K] = r3(mean(D.map(x => x.h[h].freshK[K] - x.h[h].b0).filter(Number.isFinite)) * 100);
        // 相位:10 個相位各自的「新魚 − 安慰劑」日平均
        const R = D.length ? D[0].h[h].freshPh.length : 0, phs = [];
        for (let p = 0; p < R; p++) phs.push(r3(mean(D.map(x => x.h[h].freshPh[p] - x.h[h].shamPh[p]).filter(Number.isFinite)) * 100));
        o.phase = { vsSham: phs, pos: phs.filter(v => v > 0).length };
        const raw = ex('fresh', NO).map(e => e.v);
        o.gates = {
            fresh_vs_0050: gates(ex('fresh', NO), raw, 1),
            fresh_vs_sham: gates(inc('fresh', 'sham', NO), raw, 1),
            fresh_vs_lead10: gates(inc('fresh', 'lead10', NO), raw, 1),
            fresh_vs_batch: gates(inc('fresh', 'batch', NO), raw, 1),
            lead10_vs_sham: gates(inc('lead10', 'sham', NO), ex('lead10', NO).map(e => e.v), 1),
        };
        out[h] = o;
    }
    return out;
}

// ───────────────────────────── selftest ─────────────────────────────
function synthCtx(nStock = 30, nDay = 320, opt = {}) {
    const cal = []; for (let k = 0; k < nDay; k++) { const t = new Date(Date.UTC(2023, 0, 2) + k * 864e5); cal.push(t.toISOString().slice(0, 10)); }
    const stocks = [];
    for (let s = 0; s < nStock; s++) {
        const rows = []; let c = 50 + s;
        for (let k = 0; k < nDay; k++) { const g = opt.flat ? 0.001 : 0.0005 + s * 0.00015 + ((k * 7 + s * 3) % 5 - 2) * 0.002; const o = c; c = c * (1 + g); rows.push({ d: cal[k], o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1000 + s * 50 }); }
        stocks.push(prepStock(String(1100 + s), rows, cal, []));
    }
    return { cal, stocks, etf: { tr: new Float64Array(nDay).fill(1) } };
}
function selftest() {
    let fail = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fail++; };
    const P = { ...DEF };
    // ⓪ 對表真實產物
    const DATA = process.env.DATA_DIR, PH = process.env.PH;
    if (DATA && PH && fs.existsSync(PH)) {
        const ctx = loadCtx(DATA, process.env.DIV);
        const ph = JSON.parse(fs.readFileSync(PH, 'utf8')).days || [];
        let checked = 0;
        for (const day of ph) {
            const d = day.d || day.date, i = ctx.cal.indexOf(d); if (i < 0 || !day.lead || !day.lead.rows) continue;
            const want = day.lead.rows.slice(0, 10).map(r => String(r.s)), got = rankAt(ctx, i, P).ranked.slice(0, 10).map(S => S.sym);
            const same = want.filter(s => got.includes(s)).length; checked++;
            ok(same >= 8, `⓪ ${d} rankAt 前 10 vs pick_history:${same}/10 相同` + (same < 10 ? `(本站 ${want.join(',')} / 探針 ${got.join(',')})` : ''));
        }
        ok(checked > 0, `⓪ 對到 ${checked} 天(K 線目錄要包含 pick_history 的日子)`);
    } else console.log('⏭️ ⓪ 沒給 DATA_DIR + PH → 跳過對表');
    const ctx = synthCtx();
    const i = 260, R = 10;
    const { ranked } = rankAt(ctx, i, P);
    // ① 新魚 ∩ 這一批 = 0
    const r = rebOf(i, 3, R), B = new Set(rankAt(ctx, r, P).ranked.slice(0, 10)), F = freshOf(ranked, B, 10);
    ok(ranked.length >= 20, `① 合成資料排得出名單(${ranked.length} 檔)`);
    ok(F.every(S => !B.has(S)) && F.length === 10, '① 新魚跟這一批交集 = 0、取滿 10 條');
    ok(r <= i && (r - 3) % R === 0 && i - r < R, `① 換倉日 r=${r} 在相位 3、≤ i、10 天內`);
    // ⑤ 換倉日當天:新魚 = 今天第 11 名以後
    const r0 = rebOf(i, i % R, R); const F0 = freshOf(ranked, new Set(rankAt(ctx, r0, P).ranked.slice(0, 10)), 10);
    ok(r0 === i && F0.every((S, k) => S === ranked[10 + k]), '⑤ 換倉日:新魚 = 今天第 11~20 名');
    // ② 零前視:i+1 之後價格 ×3,排名 / 這一批不變
    const ctx2 = synthCtx(); for (const S of ctx2.stocks) for (let k = i + 1; k < ctx2.cal.length; k++) { S.C[k] *= 3; S.A[k] *= 3; S.val20[k] *= 3; S.ma20[k] *= 3; S.ma60[k] *= 3; }
    const ra = ranked.map(S => S.sym).join(), rb = rankAt(ctx2, i, P).ranked.map(S => S.sym).join();
    ok(ra === rb, '② 零前視:未來價格 ×3,第 i 天的排名一字不變');
    // ③ 報酬口徑:隔天開盤 100、h 天後收盤 110
    const S0 = ctx.stocks[0]; const save = [S0.O[i + 1], S0.C[i + 5], S0.C[i]];
    S0.O[i + 1] = 100; S0.C[i + 5] = 110; S0.C[i] = 100; for (let k = i + 2; k <= i + 5; k++) S0.F[k] = 1;
    const rr = retOf(ctx, S0, i, 5); ok(Math.abs(rr - (0.10 - COST)) < 1e-9, `③ 隔天開盤 100 → 第 5 天收盤 110 = +10% − 成本(${(rr * 100).toFixed(3)}%)`);
    S0.O[i + 1] = 110; ok(retOf(ctx, S0, i, 5) === 'lock', '③ 隔天開盤 +10%(漲停)= 買不到');
    [S0.O[i + 1], S0.C[i + 5], S0.C[i]] = save;
    // ④ 安慰劑:沒有邊際的資料上「新魚 − 安慰劑」≈ 0(全部股票同一條報酬)
    const ctx4 = synthCtx(30, 320, { flat: true });
    const oc = new Float64Array(320).fill(1); const W = runWindow(ctx4, oc, 230, P, { seeds: 3 });
    const dif = mean(W.days.map(x => x.h[5] && x.h[5].fresh - x.h[5].sham).filter(Number.isFinite));
    ok(W.days.length > 20 && Math.abs(dif) < 1e-9, `④ 沒有邊際時 新魚 − 安慰劑 = ${(dif * 100).toFixed(4)}%(${W.days.length} 天)`);
    ok(W.st.overlap === 0, `④ 實跑窗口:新魚與這一批重疊 ${W.st.overlap} 次`);
    console.log(fail ? `❌ ${fail} 條沒過` : '✅ 全部通過'); return fail ? 1 : 0;
}

function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR;
    if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, process.env.DIV); const oc = load0050(DATA, ctx.cal);
    console.log(`📂 ${ctx.stocks.length} 檔 ・${ctx.cal[0]} ~ ${ctx.cal.at(-1)} ・0050 開收 ${[...oc].filter(Number.isFinite).length} 天`);
    if ([...oc].filter(Number.isFinite).length < 500) { console.error('🚨 0050 開盤資料太少'); process.exit(1); }
    const WINS = (process.env.WINS || '2022-09-16,2011-01-03').split(',');
    const res = { meta: { from: ctx.cal[0], to: ctx.cal.at(-1), stocks: ctx.stocks.length, cost: COST, rule: { U: DEF.U, L: DEF.L, R: DEF.R } }, wins: {} };
    for (const w of WINS) {
        const s0 = ctx.cal.findIndex(d => d >= w);
        const KS = [5, 10, 15, 20];
        const W = runWindow(ctx, oc, s0, { ...DEF }, { KS });
        const sm = summarize(W, s0, KS);
        if (sm[1].days < 200) { console.error(`🚨 ${w} 窗口只有 ${sm[1].days} 天`); process.exit(1); }
        const Ls = {}; for (const L of [5, 20]) { const WL = runWindow(ctx, oc, s0, { ...DEF, L }, { seeds: 3 }); const sl = summarize(WL, s0, [10]); Ls[L] = Object.fromEntries(HS.map(h => [h, { fresh: sl[h].grp.fresh.vs0050, sham: sl[h].grp.sham.vs0050, inc: sl[h].gates.fresh_vs_sham.inc, pass: sl[h].gates.fresh_vs_sham.pass }])); }
        res.wins[w] = { sum: sm, L: Ls, st: W.st };
        console.log(`\n══ 窗口 ${w} 起(${sm[1].days} 天)・買不到 ${W.st.lock} ・資料不足 ${W.st.miss} ・新魚與這一批重疊 ${W.st.overlap}`);
        for (const h of HS) {
            const o = sm[h], g = o.grp;
            console.log(`  抱 ${h} 天:0050 ${o.b0050}% ・vs 0050 → 🐟新魚 ${g.fresh.vs0050} ・👑前10 ${g.lead10.vs0050} ・📦這一批 ${g.batch.vs0050} ・🎲隨便抽 ${g.sham.vs0050} ・全體 ${g.all.vs0050}(新魚贏 0050 的天 ${g.fresh.beat0050}%)`);
            console.log(`     新魚前 K:${Object.entries(o.freshK).map(([k, v]) => `${k}→${v}`).join(' ・')} ・相位 新魚>隨便抽 ${o.phase.pos}/${o.phase.vsSham.length}`);
            for (const [k, G] of Object.entries(o.gates)) console.log(`     ${k}: 增量 ${G.inc} t=${G.t} ・六關 ${G.pass}/6 ・前後半 ${G.A}/${G.B}`);
            console.log(`     動能天數 L=5 新魚−隨便抽 ${Ls[5][h].inc}(${Ls[5][h].pass}/6)・L=20 ${Ls[20][h].inc}(${Ls[20][h].pass}/6)`);
        }
    }
    if (out) { fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log('💾 ' + out); }
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
