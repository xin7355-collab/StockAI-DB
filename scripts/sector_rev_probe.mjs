#!/usr/bin/env node
/**
 * 🏭 產業月營收加速 + 20 日動能挑產業 —— 全部 33 個官方產業、16 年(EXP-20261113-07,使用者 11/13 選的四個回測之一)
 *
 * 由來:trade_lead_probe(V80.1.6)只有 14 組「出口對得上的產業」,營收加速 ∧ 20 日動能 +0.45pp / 20 日(5/6、BH 過)
 *   → LAB next-rev-sector 寫「要用全部產業再驗」。這支就是那一步(⛔ 另寫一套算法:面板 / 報酬 / 六關一律 import trade_lead_probe)。
 *
 * 主訊號(事先登記):每月決定日(資料月次月 11 日起第一個交易日)收盤 ——
 *   產業營收加速 = 同一批公司 3 個月營收年增(basketRevYoy3)這個月 − 上個月;20 日動能 = 成員過去 20 日報酬平均。
 *   動能在前一半的產業裡,營收加速最大的前 3 個 → 隔天開盤等權買成員、抱 20 天(含息)→ 減同一天全部產業的等權平均。
 * 判定(五條全過才算):① 六關全過(含扣 0.44)② 主格 BH q ≤ 0.05(家族 = 前 2/3/4/5 × 5/20/60 天 12 格)
 *   ③ 比 500 次「動能前一半裡隨機挑 3 個」的第 95 百分位高(⭐ 只換掉「營收」那一半 → 量的是營收本身的功勞,
 *      ⛔ 只跟「全部產業隨機挑」比 —— 那會把動能的功勞算給營收;selftest ⑤ 是決定性對照)
 *   ④ 前 2/3/4/5 個 × 20 天四格都 > 0(高原)⑤ 至少 120 個決定月。
 * 參考(⛔ 判定):只看營收加速前 N、兩個都在前一半(trade_lead_probe 那一種)、成交金額加權、全部產業隨機挑 3 個。
 * ⚠️ 限制:industry_map 只有現在還在的股票(下市的沒有產業別 → 不在籃子裡,存活者偏誤;比的是同一天產業之間)。
 *
 * 用法:DATA_DIR=<d16> REV_DIR=<stock_deep/rev> node --max-old-space-size=6000 scripts/sector_rev_probe.mjs out.json
 *       node scripts/sector_rev_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bhQ } from './lib_fdr.mjs';
import { buildPanel, incOf, topBy, gate, alignStock, loadRevDir, basketRevYoy3, ymAdd } from './trade_lead_probe.mjs';
import { rng } from './rev_decline_probe.mjs';

export const HS = [5, 20, 60];
export const NS = [2, 3, 4, 5];
export const MAIN = { N: 3, H: 20 };
export const RULE = { minMonths: 120, q: 0.05, shamPct: 0.95, nSham: 500 };
const MIN_BASKETS = 8;   // 同 trade_lead_probe:一個月至少要有幾組產業才比
// 顯示用(⛔ 判斷):官方產業代碼 → 名字(同 sector_rotation_probe 那張)
const IND_NAME = { '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織', '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙', '10': '鋼鐵', '11': '橡膠', '12': '汽車', '14': '建材營造', '15': '航運', '16': '觀光餐旅', '17': '金融', '18': '貿易百貨', '20': '其他', '21': '化學', '22': '生技醫療', '23': '油電燃氣', '24': '半導體', '25': '電腦週邊', '26': '光電', '27': '通信網路', '28': '電子零組件', '29': '電子通路', '30': '資訊服務', '31': '其他電子', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活' };

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };
const sg = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—');

// ───────────────────────── 挑法 ─────────────────────────
const usable = rows => rows.filter(x => x.mom != null && x.revAcc != null);
const momTopHalf = (ok, rnd) => ok.slice().sort((a, b) => b.mom - a.mom || (rnd() - 0.5)).slice(0, Math.ceil(ok.length / 2));
/** 主訊號:動能在前一半的產業裡,營收加速最大的前 N 個 */
export const momRevTop = (N, rnd) => rows => {
    const ok = usable(rows); if (ok.length < MIN_BASKETS) return null;
    return momTopHalf(ok, rnd).sort((a, b) => b.revAcc - a.revAcc || (rnd() - 0.5)).slice(0, N);
};
/** 🎲 安慰劑(判定用):同一個池子(動能前一半)隨機挑 N 個 —— 只換掉營收那一半 */
export const shamMomTop = (N, rnd) => rows => {
    const ok = usable(rows); if (ok.length < MIN_BASKETS) return null;
    return momTopHalf(ok, rnd).sort(() => rnd() - 0.5).slice(0, N);
};
/** 🎲 參考:全部產業隨機挑 N 個(同 trade_lead_probe 的安慰劑) */
export const shamAll = (N, rnd) => rows => (rows.length < MIN_BASKETS ? null : rows.slice().sort(() => rnd() - 0.5).slice(0, N));
/** 參考:兩個都在前一半的產業全部買(trade_lead_probe「營收加速 ∧ 動能」那一種,檔數不固定) */
export const bothTop = rnd => rows => {
    const ok = usable(rows); if (ok.length < MIN_BASKETS) return null;
    const h = Math.ceil(ok.length / 2);
    const A = new Set(momTopHalf(ok, rnd).map(x => x.k));
    const B = new Set(ok.slice().sort((a, b) => b.revAcc - a.revAcc || (rnd() - 0.5)).slice(0, h).map(x => x.k));
    const sel = ok.filter(x => A.has(x.k) && B.has(x.k));
    return sel.length ? sel : null;
};

// ───────────────────────── 分析 ─────────────────────────
const cellOf = (inc, H) => {
    const g = gate(inc, H);
    return { d: g.d, n: inc.n, p: H > 20 ? g.pNW : g.p, H2: g.H, YR: g.YR, dropBest: g.dropBest, nPass: g.nPass, pass: g.pass, med: median(inc.dm) };
};
function shamDist(panel, H, mk, n, seed) {
    const R = rng(seed), dist = [];
    for (let t = 0; t < n; t++) dist.push(mean(incOf(panel, H, mk(MAIN.N, R)).dm));
    dist.sort((a, b) => a - b);
    return { n, p05: dist[Math.floor(n * 0.05)], p50: dist[Math.floor(n * 0.5)], p95: dist[Math.min(n - 1, Math.floor(n * RULE.shamPct))], dist };
}

export function analyze(panel, { nSham = RULE.nSham, seed = 20261113 } = {}) {
    const cells = [];
    for (const N of NS) for (const H of HS) cells.push({ N, H, ...cellOf(incOf(panel, H, momRevTop(N, rng(seed + N * 100 + H))), H) });
    const q = bhQ(cells.map(c => c.p)); cells.forEach((c, i) => { c.q = q[i]; });
    const main = cells.find(c => c.N === MAIN.N && c.H === MAIN.H);
    const shamB = shamDist(panel, MAIN.H, shamMomTop, nSham, seed + 7);
    const shamA = shamDist(panel, MAIN.H, shamAll, nSham, seed + 11);
    const below = shamB.dist.filter(x => x < main.d).length / shamB.n;
    const plateau = NS.map(N => cells.find(c => c.N === N && c.H === MAIN.H).d);
    const refs = [];
    for (const N of NS) for (const H of HS) refs.push({ k: 'revAcc', name: `只看營收加速 前 ${N}`, N, H, ...cellOf(incOf(panel, H, topBy(x => x.revAcc, N, rng(seed + 3 + N))), H) });
    for (const H of HS) refs.push({ k: 'both', name: '兩個都在前一半(全部買)', N: 0, H, ...cellOf(incOf(panel, H, bothTop(rng(seed + 5 + H))), H) });
    for (const H of HS) refs.push({ k: 'w', name: '主訊號 成交金額加權', N: MAIN.N, H, ...cellOf(incOf(panel, H, momRevTop(MAIN.N, rng(seed + 9 + H)), 'fwW'), H) });
    const c = { c1: main.nPass === 6, c2: main.q <= RULE.q, c3: main.d > shamB.p95, c4: plateau.every(x => x > 0), c5: main.n >= RULE.minMonths };
    for (const s of [shamA, shamB]) delete s.dist;
    return { cells, main, shamA, shamB, shamBelow: below, plateau, refs, c, pass: Object.values(c).every(Boolean) };
}

// ───────────────────────── 讀資料 ─────────────────────────
function loadWorld(env) {
    const DATA = env.DATA_DIR, REV = env.REV_DIR;
    if (!DATA || !REV) { console.log('❌ 要設 DATA_DIR / REV_DIR(跑法見檔頭)'); process.exit(1); }
    const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
    const cal = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => d10(r.date)).filter(Boolean);
    const calIdx = new Map(cal.map((d, i) => [d, i]));
    const indOf = new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8'))).filter(([s]) => /^\d{4}$/.test(s) && !s.startsWith('00')));
    const divAll = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, '_div16.json'), 'utf8')).d || {}; } catch (_) { return {}; } })();
    const stocks = new Map();
    for (const [s] of indOf) {
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 60) continue;
        const A = alignStock(cal, calIdx, bars, (divAll[s] || {}).h);
        A.date = cal;
        stocks.set(s, A);
    }
    return { cal, calIdx, stocks, indOf, exp: new Map(), revOf: loadRevDir(REV) };
}

function main(out) {
    const t0 = Date.now();
    const W = loadWorld(process.env);
    const codes = [...new Set(W.indOf.values())].sort();
    const baskets = codes.map(k => ({ k, n: IND_NAME[k] || k, ind: [k] })).filter(b => [...W.indOf].filter(([s, ind]) => ind === b.k && W.stocks.has(s)).length >= 4);
    const yms = [...new Set([...W.revOf.values()].flatMap(m => [...m.keys()]))].sort();
    const from = ymAdd(yms[0], 15) > '2010-02' ? ymAdd(yms[0], 15) : '2010-02';
    const { panel, memb } = buildPanel(W, baskets, { from });
    console.log(`📦 日曆 ${W.cal[0]} ~ ${W.cal.at(-1)}・產業 ${baskets.length} 個(成員有 K 線 ${W.stocks.size} 檔)・月營收 ${W.revOf.size} 檔(${yms[0]} ~ ${yms.at(-1)})`
        + `・決定月 ${panel.length} 個(${panel[0]?.d} ~ ${panel.at(-1)?.d})・載入 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    console.log('   每組成員:' + baskets.map(b => `${b.n} ${memb.get(b.k).length}`).join('・'));
    const A = analyze(panel);
    const line = r => `${String(r.H).padStart(2)}日 ${sg(r.d).padStart(6)}pp n=${String(r.n).padStart(3)} p=${r.p.toFixed(3)}${r.q != null ? ` q=${r.q.toFixed(3)}` : ''} 中位 ${sg(r.med)} 前/後半 ${sg(r.H2[0])}/${sg(r.H2[1])} 年正 ${r.YR.filter(y => y.d > 0).length}/${r.YR.length} 去最好年 ${sg(r.dropBest)} → ${r.nPass}/6`;
    console.log('\n🏭 主訊號:動能前一半裡營收加速前 N 個 vs 同一天全部產業(含息;六關含扣 0.44;12 格一起 BH)');
    for (const c of A.cells) console.log(`  前 ${c.N} ${line(c)}`);
    const m = A.main;
    console.log(`\n⭐ 主格(前 ${MAIN.N}、抱 ${MAIN.H} 天):${sg(m.d)}pp ・逐年 ${m.YR.map(y => `${String(y.y).slice(2)}:${sg(y.d)}`).join(' ')}`);
    console.log(`🎲 動能前一半裡隨機挑 3 個(${A.shamB.n} 次,判定用):5% / 50% / 95% = ${sg(A.shamB.p05)} / ${sg(A.shamB.p50)} / ${sg(A.shamB.p95)} ・主格比 ${(A.shamBelow * 100).toFixed(1)}% 的安慰劑好`);
    console.log(`🎲 全部產業隨機挑 3 個(${A.shamA.n} 次,參考):${sg(A.shamA.p05)} / ${sg(A.shamA.p50)} / ${sg(A.shamA.p95)}`);
    console.log(`📐 高原(前 2/3/4/5、${MAIN.H} 天):${A.plateau.map(sg).join(' / ')}`);
    console.log('\n📎 參考(⛔ 判定):');
    for (const r of A.refs) console.log(`  ${r.name.padEnd(16)} ${line(r)}`);
    const C = A.c;
    console.log(`\n判定(登記的五條):① 六關 ${C.c1 ? '✅' : '❌'} ② BH q ${m.q.toFixed(3)} ${C.c2 ? '✅' : '❌'} ③ 贏動能前一半隨機挑的 95% ${C.c3 ? '✅' : '❌'}`
        + ` ④ 高原 ${C.c4 ? '✅' : '❌'} ⑤ 決定月 ${m.n} ${C.c5 ? '✅' : '❌'} ⇒ ${A.pass ? '✅ 全過 → 做第二步(引擎「只買這幾個產業」× 17 條)' : '❌ 沒過 → 只寫 LAB'}`);
    if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString().slice(0, 10), window: [panel[0]?.d, panel.at(-1)?.d], months: panel.length,
        baskets: baskets.map(b => ({ k: b.k, n: b.n, m: memb.get(b.k).length })), ...A }, null, 1));
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}

// ───────────────────────── selftest ─────────────────────────
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    // 日曆:2010-01-04 起約 12 年的平日;12 個產業 × 6 檔;月營收 2008-09 起 = 基數 × (1 + 每月獨立亂數)→ 加速每個月互相獨立
    const cal = []; for (let t = Date.UTC(2010, 0, 4); cal.length < 3150; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) cal.push(d.toISOString().slice(0, 10)); }
    const calIdx = new Map(cal.map((d, i) => [d, i]));
    const G = 12, PER = 6, T = cal.length;
    const mkWorld = (mode, seed = 5) => {
        const R0 = rng(seed), indOf = new Map(), revOf = new Map();
        const syms = [];
        for (let g = 0; g < G; g++) for (let s = 0; s < PER; s++) { const sym = String(1000 + g * 10 + s); indOf.set(sym, String(g + 1).padStart(2, '0')); syms.push(sym); }
        for (const sym of syms) { const m = new Map(); for (let ym = '2008-09'; ym <= '2022-12'; ym = ymAdd(ym, 1)) m.set(ym, 100 * (1 + (R0() - 0.5) * 0.4)); revOf.set(sym, m); }
        const baskets = Array.from({ length: G }, (_, g) => { const k = String(g + 1).padStart(2, '0'); return { k, n: k, ind: [k] }; });
        const membOf = k => syms.filter(s => indOf.get(s) === k);
        const drift = new Map(syms.map(s => [s, new Float64Array(T)]));
        // 決定日(同 buildPanel:資料月次月 11 日起第一個交易日)
        const dec = [];
        for (let ym = '2010-01'; ym <= '2021-10'; ym = ymAdd(ym, 1)) { const nx = ymAdd(ym, 1), i = cal.findIndex(d => d >= `${nx}-11`); if (i > 0 && cal[i].slice(0, 7) === nx) dec.push({ ym, i }); }
        const accOf = (k, ym) => { const a = basketRevYoy3(revOf, membOf(k), ym), b = basketRevYoy3(revOf, membOf(k), ymAdd(ym, -1)); return a == null || b == null ? null : a - b; };
        const push = (k, i0, n, v) => { for (const s of membOf(k)) for (let t = i0; t < i0 + n && t < T; t++) drift.get(s)[t] += v; };
        if (mode === 'mom') {   // 只有動能:每 40 個交易日換一批「熱門產業」,整段持續上漲 → 過去 20 天漲的之後也漲;營收跟它無關
            for (let b0 = 0; b0 < T; b0 += 40) { const hot = baskets.slice().sort(() => R0() - 0.5).slice(0, 3); for (const B of hot) push(B.k, b0, 40, 0.0025); }
        }
        for (const D of dec) {
            if (mode === 'rev' || mode === 'peek') {   // 營收加速前 3 的產業之後 21 天每天 +0.3%(peek:用下個月的營收挑 = 決定日還不知道)
                const ym = mode === 'peek' ? ymAdd(D.ym, 1) : D.ym;
                const top = baskets.map(B => ({ k: B.k, a: accOf(B.k, ym) })).filter(x => x.a != null).sort((a, b) => b.a - a.a).slice(0, 3);
                for (const x of top) push(x.k, D.i + 1, 21, 0.003);
            }
        }
        const stocks = new Map();
        for (const s of syms) {
            const o = new Float64Array(T), h = new Float64Array(T), l = new Float64Array(T), c = new Float64Array(T), dr = drift.get(s);
            let p = 50;
            for (let t = 0; t < T; t++) { const op = p * (1 + (R0() - 0.5) * 0.004); p = op * (1 + dr[t] + (R0() - 0.5) * 0.03); o[t] = op; c[t] = p; h[t] = Math.max(op, p) * 1.005; l[t] = Math.min(op, p) * 0.995; }
            stocks.set(s, { o, h, l, c, v: new Float64Array(T).fill(1000), cliff: new Int32Array(T + 1), divf: new Float64Array(T).fill(1), date: cal });
        }
        return { W: { cal, calIdx, stocks, indOf, exp: new Map(), revOf }, baskets };
    };
    const run = mode => { const { W, baskets } = mkWorld(mode); const { panel } = buildPanel(W, baskets, { from: '2010-01', to: '2021-10' }); return { panel, A: analyze(panel, { nSham: 100 }) }; };
    // ① 決定月數、產業營收加速有算出來
    const R1 = run('rev');
    ok(`① 決定月 ${R1.panel.length} 個(≥ 120)、每個月 12 組都有營收加速`, R1.panel.length >= 120 && R1.panel.slice(20).every(r => r.b.filter(x => x.revAcc != null).length === G), R1.panel.length);
    // ② 有效果:營收加速前 3 之後真的漲 → 主格明顯 > 0、五條全過
    ok(`② 有效果:主格 ${sg(R1.A.main.d)}pp > +1、五條全過`, R1.A.main.d > 1 && R1.A.pass, JSON.stringify({ d: R1.A.main.d, c: R1.A.c, q: R1.A.main.q }));
    // ③ 沒效果 → ≈ 0、整體不過
    const R3 = run('none');
    ok(`③ 沒效果:主格 ${sg(R3.A.main.d)}pp ≈ 0、整體不過`, Math.abs(R3.A.main.d) < 0.5 && !R3.A.pass, JSON.stringify({ d: R3.A.main.d, c: R3.A.c }));
    // ④ ⛔ 前視:效果跟「下個月的營收」走(決定日還不知道)→ 用這個月的營收挑 ≈ 0
    const R4 = run('peek');
    ok(`④ 效果跟下個月的營收走 → 主格 ${sg(R4.A.main.d)}pp ≈ 0、整體不過(⛔ 偷看)`, Math.abs(R4.A.main.d) < 0.5 && !R4.A.pass, JSON.stringify({ d: R4.A.main.d, c: R4.A.c }));
    // ⑤ ⭐ 決定性對照:只有動能 → 主格 > 0、也贏「全部產業隨機挑」,但贏不了「動能前一半裡隨機挑」→ ③ 不過(營收沒有功勞)
    const R5 = run('mom');
    ok(`⑤ 只有動能:主格 ${sg(R5.A.main.d)}pp > 全部產業隨機的 95%(${sg(R5.A.shamA.p95)}),但 ≤ 動能前一半隨機的 95%(${sg(R5.A.shamB.p95)})→ ③ 不過`,
        R5.A.main.d > R5.A.shamA.p95 && !R5.A.c.c3 && !R5.A.pass, JSON.stringify({ d: R5.A.main.d, a: R5.A.shamA, b: R5.A.shamB }));
    // ⑥ 挑法:動能前一半先篩、再照營收加速排(手算)
    const rows = Array.from({ length: 10 }, (_, j) => ({ k: String(j), mom: j, revAcc: 10 - j }));   // 動能 9..0、營收加速 1..10
    const sel = momRevTop(3, rng(1))(rows).map(x => x.k);
    ok('⑥ 動能前一半 = 9,8,7,6,5 → 裡面營收加速最大的 3 個 = 5,6,7(⛔ 全部裡面挑會變 0,1,2)', JSON.stringify(sel) === '["5","6","7"]', JSON.stringify(sel));
    ok('⑥ 少於 8 組 → 那個月不比', momRevTop(3, rng(1))(rows.slice(0, 7)) === null);
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ 全部通過');
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else main(process.argv.slice(2).find(a => !a.startsWith('--')));
}
