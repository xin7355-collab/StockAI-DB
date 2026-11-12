#!/usr/bin/env node
/**
 * 🇺🇸⚡ 輝達自己暴跌的隔天,台股開盤怎麼做(使用者 2026-11-13:「黃仁勳離職股市應該會震盪,你回測,如果這樣今日開盤要怎麼操作」)
 * 事先登記 EXP-20261113-01(判準寫死,見下;跑之前登記)。
 *
 * ⛔ 不寫第二份定義:
 *   事件 = us_tw_lead_probe 的 usFeatures / eventsOf(相對報酬的 120 日 Z,窗口不含當天;
 *          映射 = 第一個「晚於」美股日的台股交易日(美股 D 收盤 = 台北 D+1 凌晨,⛔ 同日期 = 前視);20 個台股交易日去重)
 *   開盤狀態 / 各時點賣價 = leader_intraday_probe 的 classify / rulePrices(昨收用前一天 5 分 K 最後一根,沒有才用日 K;除權息除回倍數)
 *   池子 = leader_probe simulate rankAt 的條件(val20 > 0・有收盤・離資料斷崖 > 120 天・有 60 日線與 ATR),val20 前 100,
 *          用「前一天」收盤那份(= 👑 換倉名單排好的那一刻)
 *   0050 = 研究資料包 _bench0050 + _div0050(含息)。⛔ 不用 ^TWII 開盤價(陷阱 #47:加權開盤價是用昨收湊的)
 *
 * A 大盤(2010 起):事件隔天 0050 開盤跳空(除息日用參考價)/ 開→收 / 開盤買 → T+5、T+20 收盤(含息)
 *     對照 = 全部交易日、前一天大盤嚴格空頭(bear60)的日子(只看不判)
 * B 開盤怎麼賣(5 分 K 2021-05 起):前一天池子 ∩ 當天有 5 分 K 的每一檔,比「同一檔換個時點賣」:
 *     現行 R0 = 開盤賣;開盤跌 ≥3%(D3)→ 09:30 與 10:00 兩個時點的平均(auto_trade split 在 09:30~10:00 賣)
 *     替代:ALL1000 全部 10:00 ・ALL1325 全部 13:25 ・ALLCLOSE 全部收盤 ・D3CLOSE 開低 ≥3% 改收盤 ・D3OPEN 開低 ≥3% 也開盤賣
 *     每一天先把池子裡每檔的(替代 − 現行)平均 → 一天一個數(= 依日期分群);開低 ≥3% 那兩種只算開低 ≥3% 的檔
 *     ⛔ 開盤就在跌停附近(≤ 參考價 × 0.905)的檔不算(開盤賣不掉,哪種賣法都不成立)→ 只計數
 * C 留著的(2010 起,日 K):同一個池子,開盤 → T+5 / T+20 收盤(含除權息)減 0050 同口徑;每天先平均
 *     要「多賣」= 事件日留著的平均 ≤ −0.5% 且同樣四條成立(更差的方向)
 * 判定(EXP-20261113-01 寫死):主事件 = NVDA 相對 ^SOX Z ≤ −2。要「改做法」必須四條同時:
 *   ① 事件日平均好 ≥ 0.5%(大於滑價)② 依日期重抽 95% 區間不含 0 ③ 前後兩半同向 ④ ≥ 70% 的事件日同向;任一沒過 = 照現行規則。
 *   費半自己 / 台積 ADR、Z 1.5 / 2.5 只列不判(tries 照實算)。
 *
 * 跑法:US_HIST=$S/us/us_hist.json DATA_DIR=$S/pack04/d16 DIV=$S/pack04/d16/_div16.json \
 *        KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5n/kbar5:$S/k5l/kbar5_lead \
 *        node --max-old-space-size=12000 scripts/us_shock_open_probe.mjs out.json
 *       node scripts/us_shock_open_probe.mjs --selftest
 * ⛔ 只讀、不打 API。exit 0(探針不進四驗證)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadUS, usFeatures, nextTwFactory, eventsOf, benchFactory } from './us_tw_lead_probe.mjs';
import { classify, rulePrices } from './leader_intraday_probe.mjs';

const MIN_GAIN = 0.5, SAME = 0.7, BOOT = 2000, SEED = 20261113, POOL_N = 100, LD_OPEN = 0.905;
export const ALTS = ['ALL1000', 'ALL1325', 'ALLCLOSE', 'D3CLOSE', 'D3OPEN'];
export const ALT_NAME = { ALL1000: '全部等到 10:00 賣', ALL1325: '全部 13:25 賣', ALLCLOSE: '全部收盤賣', D3CLOSE: '開低 ≥3% 的改收盤賣', D3OPEN: '開低 ≥3% 的也開盤賣' };
export const SOURCES = [['NVDA', '輝達(相對費半)'], ['^SOX', '費半自己'], ['TSM', '台積 ADR(相對費半)']];
export const ZS = [1.5, 2, 2.5];
export const PRIMARY = { src: 'NVDA', z: 2 };

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** 依日期重抽的 95% 區間(一個元素 = 一天,同一天多檔已先平均 → 重抽「天」= 依日期分群重抽) */
export function bootCI(xs, B = BOOT, seed = SEED) {
    if (xs.length < 2) return [NaN, NaN];
    const R = rng(seed), n = xs.length, ms = new Float64Array(B);
    for (let b = 0; b < B; b++) { let s = 0; for (let j = 0; j < n; j++) s += xs[Math.floor(R() * n)]; ms[b] = s / n; }
    ms.sort(); return [ms[Math.floor(B * 0.025)], ms[Math.ceil(B * 0.975) - 1]];
}
/** 四條判準(EXP-20261113-01 寫死)。pts = [{d, v}](v = 那一天的 %)。dir = +1 要「更好」;dir = −1 要「更差」(C 的留著) */
export function judge(pts, dir = 1) {
    const srt = [...pts].filter(p => Number.isFinite(p.v)).sort((a, b) => a.d < b.d ? -1 : 1), v = srt.map(p => p.v), n = v.length;
    if (n < 4) return { n, m: r2(mean(v)), ok: false, g: [false, false, false, false], why: '事件日 < 4' };
    const m = mean(v), [lo, hi] = bootCI(v), h = n >> 1, h1 = mean(v.slice(0, h)), h2 = mean(v.slice(h));
    const same = v.filter(x => Math.sign(x) === dir).length / n;
    const g = [dir * m >= MIN_GAIN, dir > 0 ? lo > 0 : hi < 0, dir * h1 > 0 && dir * h2 > 0, same >= SAME];
    return { n, m: r2(m), med: r2(median(v)), ci: [r2(lo), r2(hi)], h1: r2(h1), h2: r2(h2), same: r2(same * 100), g, ok: g.every(Boolean) };
}
/** 美股日 → 台股日 要「真的是下一個台股交易日」:台股日曆比美股日還晚開始(資料起點之前)或隔超過 12 天(農曆年最長約 10 天)→ ⛔ 不算 */
export function mapOk(usD, twD, cal0) { return !!(usD && twD && usD >= cal0 && (Date.parse(twD) - Date.parse(usD)) / 864e5 <= 12); }
/** 一檔一天 → 各賣法比「開盤賣」多(少)幾 %;R0 = 現行 */
export function sellRow(st, P) {
    const v = k => (P[k] / P.OPEN - 1) * 100, d3 = st === 'D3';
    const R0 = d3 ? (v('T0930') + v('T1000')) / 2 : 0;
    return { st, R0, ALL1000: v('T1000'), ALL1325: v('T1325'), ALLCLOSE: v('CLOSE'), D3CLOSE: d3 ? v('CLOSE') : 0, D3OPEN: 0 };
}
/** rows = [{d, st, R0, ALT…}] → 每一天 {d, n, nD3, all:{ALT: 平均(替代 − 現行)}, d3:{ALT: 只算 D3 的平均}|null} */
export function dayAgg(rows) {
    const by = new Map(); for (const r of rows) { if (!by.has(r.d)) by.set(r.d, []); by.get(r.d).push(r); }
    const out = [];
    for (const [d, rs] of by) {
        const all = {}, d3r = rs.filter(r => r.st === 'D3');
        for (const a of ALTS) all[a] = mean(rs.map(r => r[a] - r.R0));
        let d3 = null; if (d3r.length) { d3 = {}; for (const a of ALTS) d3[a] = mean(d3r.map(r => r[a] - r.R0)); }
        out.push({ d, n: rs.length, nD3: d3r.length, all, d3 });
    }
    return out.sort((a, b) => a.d < b.d ? -1 : 1);
}
/** B 的判定:事件日那幾天;D3 那兩種只看有 D3 的事件日 */
export function judgeB(days, evDates) {
    const ev = days.filter(x => evDates.has(x.d)), ctl = days.filter(x => !evDates.has(x.d)), out = {};
    for (const a of ALTS) {
        const d3only = a.startsWith('D3');
        const pts = ev.filter(x => !d3only || x.d3).map(x => ({ d: x.d, v: d3only ? x.d3[a] : x.all[a] }));
        const cpts = ctl.filter(x => !d3only || x.d3).map(x => d3only ? x.d3[a] : x.all[a]).filter(Number.isFinite);
        out[a] = { ...judge(pts, 1), ctrl: r2(mean(cpts)), ctrlN: cpts.length };
    }
    return out;
}
/** C:開盤 → T+h 收盤(含除權息倍數);資料斷崖落在 (k, k+h] → null */
export function holdRet(S, k, h) {
    const e = k + h; if (e >= S.C.length || !(S.O[k] > 0 && S.C[k] > 0 && S.A[k] > 0 && S.A[e] > 0)) return null;
    if (S.jump[e] > k) return null;
    return (S.A[e] / S.A[k] * S.C[k] / S.O[k] - 1) * 100;
}
/** 👑 池子(前一天收盤 i):同 leader_probe simulate rankAt 的條件,val20 前 N */
export function poolAt(stocks, i, N = POOL_N) {
    const u = [];
    for (const S of stocks) if (S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0) u.push(S);
    u.sort((a, b) => b.val20[i] - a.val20[i]); return u.slice(0, N);
}
const fmt = x => x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2);
const gStr = g => g.map(b => b ? '✓' : '✗').join('');

// ═════════ selftest ═════════
function selftest() {
    let ok = 0, bad = 0; const T = (name, cond) => { if (cond) ok++; else { bad++; console.log('❌', name); } };
    // ① 判準:全部 +1 → 過;正負交錯 → 不過;dir −1 全部 −1 → 過;平均 +0.4 → ① 不過
    const mk = vs => vs.map((v, i) => ({ d: `2024-01-${String(i + 1).padStart(2, '0')}`, v }));
    T('① 全部 +1 → 四條過', judge(mk(Array(10).fill(1))).ok === true);
    T('① 正負交錯 → 不過', judge(mk([1, -1, 1, -1, 1, -1, 1, -1, 1, -1])).ok === false);
    T('① dir −1 全部 −1 → 過', judge(mk(Array(10).fill(-1)), -1).ok === true);
    T('① 平均 +0.4 → 第一條不過', judge(mk(Array(10).fill(0.4))).g[0] === false);
    T('① 少於 4 天 → 不判', judge(mk([2, 2, 2])).ok === false);
    // ② 重抽:全部一樣 → 區間縮成一點;±1 交錯 → 含 0
    { const [lo, hi] = bootCI(Array(20).fill(0.7)); T('② 一樣的值 → 區間 = 那個值', Math.abs(lo - 0.7) < 1e-9 && Math.abs(hi - 0.7) < 1e-9); }
    { const [lo, hi] = bootCI([1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1]); T('② ±1 交錯 → 區間含 0', lo < 0 && hi > 0); }
    // ③ sellRow:D3 的現行 = 09:30 與 10:00 平均;非 D3 現行 = 開盤
    { const P = { OPEN: 100, T0930: 101, T1000: 102, T1325: 103, CLOSE: 104 };
      const r = sellRow('D3', P); T('③ D3 現行 = (1+2)/2', Math.abs(r.R0 - 1.5) < 1e-9);
      T('③ D3 改開盤賣 − 現行 = −1.5', Math.abs((r.D3OPEN - r.R0) + 1.5) < 1e-9);
      T('③ D3 改收盤 − 現行 = +2.5', Math.abs((r.D3CLOSE - r.R0) - 2.5) < 1e-9);
      const f = sellRow('F', P); T('③ 非 D3 現行 = 開盤(0)', f.R0 === 0 && f.D3CLOSE === 0 && Math.abs(f.ALL1325 - 3) < 1e-9); }
    // ④ 決定性對照:合成 60 天 × 15 檔;事件日(每 6 天一天)全部檔 10:00 比開盤高 2% → ALL1000 過、平常日 ≈ 0;不注入 → 不過
    const synth = inject => {
        const R = rng(7), rows = [], ev = new Set();
        for (let q = 0; q < 60; q++) {
            const d = `2024-${String(1 + Math.floor(q / 28)).padStart(2, '0')}-${String(1 + q % 28).padStart(2, '0')}`, isEv = q % 6 === 0; if (isEv) ev.add(d);
            for (let s = 0; s < 15; s++) {
                const nz = () => (R() - 0.5) * 0.6, add = inject && isEv ? 2 : 0;
                const P = { OPEN: 100, T0930: 100 * (1 + (nz() + add) / 100), T1000: 100 * (1 + (nz() + add) / 100), T1325: 100 * (1 + nz() / 100), CLOSE: 100 * (1 + nz() / 100) };
                rows.push({ d, ...sellRow(s % 5 === 0 ? 'D3' : 'F', P) });
            }
        }
        return judgeB(dayAgg(rows), ev);
    };
    const jIn = synth(true), jNo = synth(false);
    T('④ 注入 → 全部 10:00 那種四條過', jIn.ALL1000.ok === true);
    T('④ 注入 → 平常日對照 ≈ 0', Math.abs(jIn.ALL1000.ctrl) < 0.3);
    T('④ 注入 → 收盤那種不過(只注入到 10:00)', jIn.ALLCLOSE.ok === false);
    T('④ 不注入 → 沒有一種過', ALTS.every(a => jNo[a].ok === false));
    // ⑤ 前視:改掉未來的美股價,過去的 Z 一個都不變;當天的 Z 只用前一天以前(改「明天」不影響「今天」)
    { const n = 300, days = [], c = [], cb = []; const R = rng(11);
      for (let i = 0; i < n; i++) { const dd = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10); days.push(dd); c.push(100 * (1 + (R() - 0.5) * 0.04 * (i + 1) / n + i * 0.001)); cb.push(100 * (1 + i * 0.0008 + (R() - 0.5) * 0.01)); }
      const U = { days, syms: { NVDA: { c: [...c] }, '^SOX': { c: cb }, '^IXIC': { c: cb } } };
      const z1 = usFeatures(U, { W: 120 }).NVDA.z;
      const U2 = { days, syms: { NVDA: { c: c.map((x, i) => i > 200 ? x * 0.5 : x) }, '^SOX': { c: cb }, '^IXIC': { c: cb } } };
      const z2 = usFeatures(U2, { W: 120 }).NVDA.z;
      T('⑤ 改第 201 天以後 → 第 200 天以前的 Z 不變', z1.slice(0, 201).every((x, i) => x === z2[i]));
      T('⑤ 第 201 天以後的 Z 真的變了(注入有效)', z1.slice(201).some((x, i) => x !== z2[201 + i])); }
    // ⑥ 美股日 → 台股日:台股休市(農曆年)要跳到開市那天;同一天 ⛔ 對到同一天
    { const nx = nextTwFactory(['2025-01-22', '2025-02-03', '2025-02-04']);
      T('⑥ 休市中的美股日 → 開市那天', nx('2025-01-27') === 1);
      T('⑥ 同一天 → 下一個台股日(⛔ 同日期 = 前視)', nx('2025-01-22') === 1 && nx('2025-02-03') === 2);
      T('⑥ 最後一天之後 → null', nx('2025-02-04') === null);
      T('⑥ 資料起點之前的美股日 ⛔ 對到第一天', mapOk('2009-12-08', '2010-01-04', '2010-01-04') === false);
      T('⑥ 農曆年休市 7 天 → 算', mapOk('2025-01-27', '2025-02-03', '2010-01-04') === true);
      T('⑥ 隔 20 天 → 不算', mapOk('2025-01-01', '2025-01-21', '2010-01-04') === false); }
    // ⑦ 留著的報酬:除息加回(A 含倍數),開盤買
    { const S = { O: [10, 20, 20, 20], C: [10, 20, 19, 21], A: [10, 20, 19 * 1.05, 21 * 1.05], jump: [-1e9, -1e9, -1e9, -1e9] };
      T('⑦ 開盤 20 → 兩天後收 21、中間除息 5% → +10.25%', Math.abs(holdRet(S, 1, 2) - 10.25) < 1e-9);
      const S2 = { ...S, jump: [-1e9, -1e9, 2, 2] }; T('⑦ 中間有資料斷崖 → 不算', holdRet(S2, 1, 2) === null); }
    // ⑧ 池子:條件同 rankAt、照 val20 由大到小
    { const mkS = (v, ok = true) => ({ val20: [v], C: [ok ? 10 : 0], jump: [-1e9], ma60: [1], atr: [1] });
      const p = poolAt([mkS(5), mkS(9), mkS(7, false), mkS(1)], 0, 2); T('⑧ 池子照 val20 排、沒收盤的不算', p.length === 2 && p[0].val20[0] === 9 && p[1].val20[0] === 5); }
    console.log(`selftest:${ok} 過 ・${bad} 錯`); process.exit(bad ? 1 : 0);
}

// ═════════ main ═════════
async function main() {
    const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';
    const ENV = process.env;
    if (!ENV.US_HIST || !ENV.DATA_DIR || !ENV.KBAR5_DIR) { console.log('❌ 要 US_HIST、DATA_DIR、KBAR5_DIR'); process.exit(1); }
    const { loadCtx } = await import('./leader_probe.mjs');
    const { loadKbar5 } = await import('./dt_kbar5_probe.mjs');
    const U = loadUS(ENV.US_HIST); const F = usFeatures(U, { W: 120 });
    console.log(`📂 美股 ${U.days[0]} ~ ${U.days.at(-1)}(${U.days.length} 天)・asof ${U.asof}`);
    console.log('📂 載入台股日 K…'); const ctx = loadCtx(ENV.DATA_DIR, ENV.DIV || ''); const { cal, stocks } = ctx;
    const cIdx = new Map(cal.map((d, i) => [d, i])), bySym = new Map(stocks.map(S => [S.sym, S]));
    console.log(`   ${stocks.length} 檔 ・${cal[0]} ~ ${cal.at(-1)}`);
    const nextTw = nextTwFactory(cal);

    // 0050:開 / 收 + 除息(含息)
    const b50raw = JSON.parse(fs.readFileSync(path.join(ENV.DATA_DIR, '_bench0050.json'), 'utf8'));
    const b50 = b50raw.map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), o: +r.open, c: +r.close })).filter(x => x.o > 0 && x.c > 0);
    const dv = JSON.parse(fs.readFileSync(path.join(ENV.DATA_DIR, '_div0050.json'), 'utf8')); const d50 = Array.isArray(dv) ? dv : (dv.h || ((dv.d || dv)['0050'] || {}).h || []);
    const bench = benchFactory(b50, d50);
    const b50i = new Map(b50.map((b, i) => [b.d, i])), divOn = new Map(); for (const [dt, amt, typ] of d50) if (typ !== '權' && +amt > 0) divOn.set(String(dt).slice(0, 10), +amt);
    const gap50 = d => { const i = b50i.get(d); if (!(i > 0)) return null; const ref = b50[i - 1].c - (divOn.get(d) || 0); return ref > 0 ? (b50[i].o / ref - 1) * 100 : null; };
    const o2c50 = d => { const i = b50i.get(d); return i == null ? null : (b50[i].c / b50[i].o - 1) * 100; };

    // 事件(每個來源 × Z)
    const EV = {};
    for (const [src] of SOURCES) for (const z of ZS) EV[`${src}|${z}`] = eventsOf(F, src, U, nextTw, { Z: z, sign: -1 }).map(e => ({ ...e, d: cal[e.k] })).filter(e => mapOk(e.usD, e.d, cal[0]));
    const P0 = EV[`${PRIMARY.src}|${PRIMARY.z}`];
    console.log(`\n🗓️ 主事件(輝達相對費半 Z ≤ −2,20 天去重):${P0.length} 次`);
    for (const e of P0) console.log(`   美股 ${e.usD} → 台股 ${e.d} ・Z ${e.z.toFixed(2)} ・輝達比費半 ${e.rel.toFixed(1)}% ・0050 跳空 ${fmt(gap50(e.d))}% ・開→收 ${fmt(o2c50(e.d))}%`);
    // 今晚的 Z 要用的窗口(最後 120 天,⛔ 含不到 11/12 → 給公式讓人工算)
    { const rel = F.NVDA.rel.filter(x => x != null).slice(-120); const m = mean(rel), s = Math.sqrt(rel.reduce((a, x) => a + (x - m) ** 2, 0) / (rel.length - 1));
      console.log(`   📐 最近 120 天輝達比費半:平均 ${m.toFixed(3)}%・標準差 ${s.toFixed(3)}% → 今晚 Z ≈ (輝達 − 費半 − ${m.toFixed(2)}) ÷ ${s.toFixed(2)}`);
      EV._win = { m: r2(m), s: r2(s * 100) / 100, asof: U.days.at(-1) }; }

    // ── A 大盤 ──
    const allDays = cal.filter(d => b50i.has(d) && d >= '2010-01-15');
    const metA = { gap: gap50, o2c: o2c50, oc5: d => bench(d, 5), oc20: d => bench(d, 20) };
    const ctlA = {}, ctlBear = {};
    for (const [k, f] of Object.entries(metA)) {
        ctlA[k] = r2(mean(allDays.map(f).filter(Number.isFinite)));
        ctlBear[k] = r2(mean(allDays.filter(d => { const i = cIdx.get(d); return i > 0 && ctx.bear[i - 1] === 1; }).map(f).filter(Number.isFinite)));
    }
    const A = {};
    console.log('\n' + '═'.repeat(100) + '\n【A 大盤】事件隔天 0050(%;含息)・對照 = 全部交易日 / 前一天大盤嚴格空頭的日子\n' + '═'.repeat(100));
    console.log('事件'.padEnd(26) + '次數   開盤跳空        開→收          開盤買→T+5     開盤買→T+20');
    for (const [src, nm] of SOURCES) for (const z of ZS) {
        const ev = EV[`${src}|${z}`].filter(e => b50i.has(e.d));
        const row = { n: ev.length };
        for (const [k, f] of Object.entries(metA)) { const v = ev.map(e => f(e.d)).filter(Number.isFinite); const [lo, hi] = bootCI(v); row[k] = { m: r2(mean(v)), med: r2(median(v)), ci: [r2(lo), r2(hi)], n: v.length, neg: r2(v.filter(x => x < 0).length / v.length * 100) }; }
        A[`${src}|${z}`] = row;
        console.log(`${(nm + ' Z≤−' + z).padEnd(24)}${String(ev.length).padStart(4)}   ` + ['gap', 'o2c', 'oc5', 'oc20'].map(k => `${fmt(row[k].m)}[${fmt(row[k].ci[0])},${fmt(row[k].ci[1])}]`.padEnd(16)).join(''));
    }
    console.log(`${'對照:全部交易日'.padEnd(24)}        ` + ['gap', 'o2c', 'oc5', 'oc20'].map(k => fmt(ctlA[k]).padEnd(16)).join(''));
    console.log(`${'對照:前一天嚴格空頭'.padEnd(23)}        ` + ['gap', 'o2c', 'oc5', 'oc20'].map(k => fmt(ctlBear[k]).padEnd(16)).join(''));

    // ── C 留著的(日 K,2010 起)── 每天:前一天池子每檔 開盤 → T+h 收盤 − 0050 同口徑,先平均
    console.log('\n📊 算 C(每天池子留著 vs 0050)…');
    const C = { 5: [], 20: [] };
    for (let k = 1; k < cal.length; k++) {
        const d = cal[k]; if (d < '2010-01-15' || !b50i.has(d)) continue;
        const pool = poolAt(stocks, k - 1); if (pool.length < 50) continue;
        for (const h of [5, 20]) {
            const b = bench(d, h); if (!Number.isFinite(b)) continue;
            const xs = pool.map(S => holdRet(S, k, h)).filter(Number.isFinite); if (xs.length < 50) continue;
            C[h].push({ d, v: mean(xs) - b });
        }
    }
    const Cres = {};
    console.log('═'.repeat(100) + '\n【C 留著的】前一天 👑 池子(成交值前 100)開盤 → T+h 收盤,扣 0050 同口徑(%)・要「多賣」= 四條都在「更差」那邊\n' + '═'.repeat(100));
    for (const [src, nm] of SOURCES) for (const z of ZS) {
        const evD = new Set(EV[`${src}|${z}`].map(e => e.d)); const r = {};
        for (const h of [5, 20]) { const pts = C[h].filter(p => evD.has(p.d)); const ctl = C[h].filter(p => !evD.has(p.d)).map(p => p.v); r[h] = { ...judge(pts, -1), ctrl: r2(mean(ctl)) }; }
        Cres[`${src}|${z}`] = r;
        console.log(`${(nm + ' Z≤−' + z).padEnd(24)} T+5 ${fmt(r[5].m)} [${fmt(r[5].ci?.[0])},${fmt(r[5].ci?.[1])}] 對照 ${fmt(r[5].ctrl)} ${gStr(r[5].g)} ・T+20 ${fmt(r[20].m)} [${fmt(r[20].ci?.[0])},${fmt(r[20].ci?.[1])}] 對照 ${fmt(r[20].ctrl)} ${gStr(r[20].g)}${r[5].ok || r[20].ok ? ' ⚠️ 成立' : ''}`);
    }

    // ── B 開盤怎麼賣(5 分 K)──
    console.log('\n📂 載入 5 分 K…'); const K5 = loadKbar5(ENV.KBAR5_DIR, { mergeSyms: true });
    const kDays = Object.keys(K5.days).sort(); console.log(`   ${kDays.length} 天 ・${kDays[0]} ~ ${kDays.at(-1)} ・母體:${K5.bias}`);
    const prevK = new Map(); for (let q = 1; q < kDays.length; q++) prevK.set(kDays[q], kDays[q - 1]);
    const barsOf = (sym, d) => { const D = K5.days[d]; return D && D.k ? D.k[sym] : null; };
    const rows = [], cnt = { pool: 0, noK: 0, ldOpen: 0, cliff: 0, ok: 0, days: 0 };
    for (const d of kDays) {
        const i = cIdx.get(d); if (i == null || i < 2) continue;
        const pool = poolAt(stocks, i - 1); if (pool.length < 50) continue; cnt.days++;
        for (const S of pool) {
            cnt.pool++;
            const b = barsOf(S.sym, d); if (!b || !b.length) { cnt.noK++; continue; }
            if (S.jump[i] === i) { cnt.cliff++; continue; }
            const Fx = S.F[i], pd = cal[i - 1], pb = prevK.get(d) === pd ? barsOf(S.sym, pd) : null;
            const pc = pb && pb.length ? pb.at(-1)[4] : S.C[i - 1]; if (!(pc > 0)) { cnt.noK++; continue; }
            const ref = pc / (Fx > 0 ? Fx : 1);
            if (b[0][1] <= ref * LD_OPEN) { cnt.ldOpen++; continue; }
            const st = classify(b[0][1], ref * Fx, Fx), P = rulePrices(b, ref); if (!st || !P) { cnt.noK++; continue; }
            rows.push({ d, sym: S.sym, ...sellRow(st, P) }); cnt.ok++;
        }
    }
    console.log(`🔗 池子 ${cnt.pool} 檔次(${cnt.days} 天)・對到 5 分 K ${cnt.ok} ・沒有 5 分 K ${cnt.noK} ・開盤就在跌停附近(不算)${cnt.ldOpen} ・資料斷崖 ${cnt.cliff}`);
    const days = dayAgg(rows);
    const Bres = {};
    console.log('═'.repeat(100) + '\n【B 開盤怎麼賣】每一格 = 換成這種賣法,比現行(開盤賣;開低 ≥3% 等 09:30~10:00)多(少)賣幾 %;依日期重抽\n' + '═'.repeat(100));
    for (const [src, nm] of SOURCES) for (const z of ZS) {
        const evD = new Set(EV[`${src}|${z}`].map(e => e.d).filter(d => d >= kDays[0]));
        const jb = judgeB(days, evD); Bres[`${src}|${z}`] = jb;
        const isP = src === PRIMARY.src && z === PRIMARY.z;
        console.log(`\n── ${nm} Z≤−${z}${isP ? '(主判準)' : '(只列)'}・5 分 K 期間事件日 ${[...evD].filter(d => days.some(x => x.d === d)).length} 天 ──`);
        for (const a of ALTS) { const r = jb[a]; console.log(`   ${ALT_NAME[a].padEnd(16)} ${fmt(r.m)}% [${fmt(r.ci?.[0])},${fmt(r.ci?.[1])}] 前後半 ${fmt(r.h1)}/${fmt(r.h2)} 同向 ${r.same ?? '—'}% ・平常日 ${fmt(r.ctrl)}% ・${gStr(r.g)} ${r.ok ? '✅ 四條過' : ''}(${r.n} 天)`); }
    }
    // 事件日的開盤狀態分布(今天開盤大概會長什麼樣)
    const evP = new Set(P0.map(e => e.d)), stCnt = {}, stCtl = {};
    for (const r of rows) { const o = evP.has(r.d) ? stCnt : stCtl; o[r.st] = (o[r.st] || 0) + 1; }
    const pct = o => { const n = Object.values(o).reduce((s, x) => s + x, 0); return Object.fromEntries(['LU', 'G3', 'G0', 'F', 'D3'].map(k => [k, r2((o[k] || 0) / n * 100)])); };
    console.log(`\n🧭 池子開盤狀態:主事件隔天 ${JSON.stringify(pct(stCnt))} ・平常日 ${JSON.stringify(pct(stCtl))}`);

    const prim = `${PRIMARY.src}|${PRIMARY.z}`;
    const change = ALTS.filter(a => Bres[prim][a].ok), sellMore = [5, 20].filter(h => Cres[prim][h].ok);
    console.log('\n' + '═'.repeat(100));
    console.log(`📌 主判準(EXP-20261113-01):${change.length ? '⚠️ 這幾種比現行好且四條都過:' + change.map(a => ALT_NAME[a]).join('、') : '✅ 沒有一種賣法四條都過 → 照現行規則(開盤賣;開低 ≥3% 等 09:30~10:00)'}`);
    console.log(`📌 留著的:${sellMore.length ? '⚠️ T+' + sellMore.join('/') + ' 出事後池子明顯跑輸 0050(四條都過)' : '✅ 出事後池子沒有穩定跑輸 0050 → 收一半之外不用多賣'}`);
    const tries = SOURCES.length * ZS.length * (ALTS.length + 2);
    console.log(`🎲 tries = ${tries}(${SOURCES.length} 來源 × ${ZS.length} 門檻 × (${ALTS.length} 賣法 + 2 個留著天數))`);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ meta: { us: [U.days[0], U.days.at(-1)], tw: [cal[0], cal.at(-1)], k5: [kDays[0], kDays.at(-1)], cnt, tries, win: EV._win }, events: P0.map(e => ({ us: e.usD, tw: e.d, z: r2(e.z), rel: r2(e.rel), gap: r2(gap50(e.d)), o2c: r2(o2c50(e.d)) })), A, ctlA, ctlBear, B: Bres, C: Cres, states: { ev: pct(stCnt), ctl: pct(stCtl) }, verdict: { change, sellMore } }, null, 1));
}

const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (_isMain) { if (process.argv.includes('--selftest')) selftest(); else main(); }
