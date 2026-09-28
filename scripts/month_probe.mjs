#!/usr/bin/env node
/**
 * 🗓️ AI 時代「逐月」成績單(V77.8.4)
 *
 * 起因:使用者「你現在回測都是以年計算,對於 AI 後的每個月有做回測嗎?有沒有參考價值?我想要的是做短中線」。
 *   以前只測過「幾月比較好」(月份效應)→ ⛔ 驗不了(每個月份只有 2~4 個樣本)。
 *   ⭐ 這支問的是另一件事:**持有 1 / 3 / 6 / 12 個月,這套有幾成機率賺錢、幾成機率贏 0050、最壞一段賠多少元**
 *   —— 年度表看不到(一年裡可能 −15% 又拉回來)。
 *
 * 輸入:portfolio_backtest `EQUITY_OUT` 的逐日市值淨值(17 條起點 WARMUP=240~320;⛔ 不重跑回測)
 *   EQ_GLOB(必填)・EQ_IDLE_GLOB(可選:閒錢停 0050 版)・DATA_DIR(0050.json / ^TWII.json)・DIV(dividends_hist.json)
 * 口徑:
 *   - 策略月報酬 = 月底市值淨值 E(cash + 停泊 + 持倉市價,含閒置現金)÷ 上月底 − 1(同 core_sat_probe 的日報酬流)。
 *     ⚠️ 帳戶是「每筆固定 15 萬」→ 賺越多閒置現金越多、% 會被稀釋 → 另給「當月賺賠元」(帳戶實際金額)與「平均持股比例」。
 *   - 0050 = 含息 + 二代健保(`lib_totalreturn.trSeries`),同一天切月。
 *   - 月底 = 那個月**最後一個交易日**(⛔ 不是月初第一天);第一段(起點到第一個月底)與最後一段(到資料最後一天)是**不完整月** → 只顯示、⛔ 不進統計。
 *   - 每個月取「有涵蓋那個月的起點」中位(起點晚的少幾個月,各月的 n 會印出來)。
 * 預測檢定(⛔ 樣本少,照實報配對數與 t):上月輸/贏 → 本月超額 ・上月 0050 三分位 → 本月超額 ・上月底加權在 60 日線上/下 → 本月超額。
 *   過關 = |t| ≥ 2 且前後半同向;過不了就寫「量不到」。⛔ 不做「幾月比較好」。
 * 跑法:EQ_GLOB="$S/eq/eq_*.json" EQ_IDLE_GLOB="$S/eqi/eq_*.json" DATA_DIR=$S/dd2 DIV=…/dividends_hist.json node scripts/month_probe.mjs out.json
 *       node scripts/month_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { trSeries, loadPx } from './lib_totalreturn.mjs';
import { alignTR } from './core_sat_probe.mjs';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

/** 每個月最後一個交易日的索引(⭐ 月底,⛔ 不是月初) */
export function monthEnds(dates) {
    const out = [];
    for (let i = 0; i < dates.length; i++) if (i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7)) out.push(i);
    return out;
}

/** 一條起點 → 逐月列:{m, s(策略%), c(0050%), x(超額pp), pl(元), exp(平均持股%), full} */
export function monthlyRows(dates, E, C, MV) {
    const me = monthEnds(dates);
    const rows = [];
    let prev = 0;                                     // 第一段從起點算(不完整月)
    for (let k = 0; k < me.length; k++) {
        const i = me[k];
        if (i === prev) continue;
        const s = (E[i] / E[prev] - 1) * 100, c = (C[i] / C[prev] - 1) * 100;
        let ex = null;
        if (MV) { const xs = []; for (let j = prev + 1; j <= i; j++) xs.push(MV[j] / E[j]); ex = mean(xs) * 100; }
        const full = k > 0 && !(k === me.length - 1 && isLastPartial(dates));
        rows.push({ m: dates[i].slice(0, 7), s, c, x: s - c, pl: E[i] - E[prev], exp: ex, full, from: dates[prev], to: dates[i] });
        prev = i;
    }
    return rows;
}
// 資料最後一天若不是月底(之後沒有交易日可以證明)→ 視為不完整;用「月底前 4 個自然日以內才算完整」判
function isLastPartial(dates) { const d = dates[dates.length - 1]; const [y, mo, dd] = d.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return last - dd > 3; }

/** 滾動 h 個「完整月」:策略複利 vs 0050 複利 */
export function rolling(rows, h) {
    const full = rows.filter(r => r.full);
    const out = [];
    for (let i = h - 1; i < full.length; i++) {
        let s = 1, c = 1; for (let j = i - h + 1; j <= i; j++) { s *= 1 + full[j].s / 100; c *= 1 + full[j].c / 100; }
        out.push({ end: full[i].m, s: (s - 1) * 100, c: (c - 1) * 100, x: (s - c) * 100 });
    }
    return out;
}
export function rollStats(win) {
    if (!win.length) return null;
    return { n: win.length, up: win.filter(w => w.s > 0).length / win.length * 100, beat: win.filter(w => w.x > 0).length / win.length * 100,
             xP10: pctl(win.map(w => w.x), 0.1), xMed: median(win.map(w => w.x)), xP90: pctl(win.map(w => w.x), 0.9),
             worst: Math.min(...win.map(w => w.s)), best: Math.max(...win.map(w => w.s)), c0050Up: win.filter(w => w.c > 0).length / win.length * 100 };
}
/** 上漲月 / 下跌月捕捉率:0050 漲的月份策略平均拿到幾成、跌的月份跟著跌幾成 */
export function capture(rows) {
    const up = rows.filter(r => r.c > 0), dn = rows.filter(r => r.c < 0);
    const cap = xs => xs.length && mean(xs.map(r => r.c)) !== 0 ? mean(xs.map(r => r.s)) / mean(xs.map(r => r.c)) * 100 : null;
    return { up: cap(up), down: cap(dn), nUp: up.length, nDown: dn.length,
             upBeat: up.length ? up.filter(r => r.x > 0).length / up.length * 100 : null,
             downBeat: dn.length ? dn.filter(r => r.x > 0).length / dn.length * 100 : null };
}
export function describe(rows) {
    const f = rows.filter(r => r.full);
    let streak = 0, maxLose = 0, uw = 0, maxUw = 0, eq = 1, peak = 1;
    for (const r of f) {
        streak = r.s < 0 ? streak + 1 : 0; maxLose = Math.max(maxLose, streak);
        eq *= 1 + r.s / 100; if (eq >= peak) { peak = eq; uw = 0; } else { uw++; maxUw = Math.max(maxUw, uw); }
    }
    return { n: f.length, up: f.filter(r => r.s > 0).length / f.length * 100, beat: f.filter(r => r.x > 0).length / f.length * 100,
             sMed: median(f.map(r => r.s)), cMed: median(f.map(r => r.c)), xMed: median(f.map(r => r.x)), xMean: mean(f.map(r => r.x)),
             worst: Math.min(...f.map(r => r.s)), best: Math.max(...f.map(r => r.s)), worstPl: Math.min(...f.map(r => r.pl)), bestPl: Math.max(...f.map(r => r.pl)),
             maxLose, maxUw, cap: capture(f), exp: median(f.map(r => r.exp).filter(x => x != null)) };
}

/** Welch t:a 組 − b 組 */
export function welch(a, b) {
    if (a.length < 3 || b.length < 3) return { d: null, t: null, na: a.length, nb: b.length };
    const d = mean(a) - mean(b), se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
    return { d, t: se > 0 ? d / se : null, na: a.length, nb: b.length };
}
/** 一個條件式檢定:cond(i) 回 true/false/null(沒資料)→ 本月超額 x[i];加前後半同向 */
export function condTest(xs, cond) {
    const run = (lo, hi) => { const a = [], b = []; for (let i = lo; i < hi; i++) { const c = cond(i); if (c === true) a.push(xs[i]); else if (c === false) b.push(xs[i]); } return welch(a, b); };
    const all = run(0, xs.length), h = xs.length >> 1, f = run(0, h), s = run(h, xs.length);
    const same = f.d != null && s.d != null && Math.sign(f.d) === Math.sign(s.d) && Math.sign(f.d) === Math.sign(all.d);
    return { ...all, first: f.d, second: s.d, pass: all.t != null && Math.abs(all.t) >= 2 && same };
}

function expand(spec) { if (!spec) return []; const out = []; for (const s of spec.split(',')) { if (s.includes('*')) { const dir = path.dirname(s), re = new RegExp('^' + path.basename(s).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f)); } else out.push(s); } return out.sort(); }

/** 一個 leg(17 條)→ 逐月中位表 + 各條統計的中位 */
export function runLeg(eqs, tr) {
    const paths = eqs.map(eq => {
        const rows0 = eq.rows.filter(r => r && r.d);
        const dates = rows0.map(r => r.d), E = rows0.map(r => r.cash + (r.park || 0) + r.mv), MV = rows0.map(r => r.mv);
        const C = alignTR(tr, dates);
        if (C.some(x => x == null)) throw new Error(`0050 含息序列對不到策略起點 ${dates[0]}`);
        return { warmup: eq.warmup, from: dates[0], rows: monthlyRows(dates, E, C, MV) };
    });
    // 逐月:有涵蓋而且是完整月的起點取中位
    const months = [...new Set(paths.flatMap(p => p.rows.map(r => r.m)))].sort();
    const table = months.map(m => {
        const cells = paths.map(p => p.rows.find(r => r.m === m)).filter(Boolean);
        const full = cells.filter(r => r.full);
        const use = full.length ? full : cells;
        return { m, n: full.length, partial: !full.length, s: r2(median(use.map(r => r.s))), c: r2(median(use.map(r => r.c))),
                 x: r2(median(use.map(r => r.x))), sLo: r2(Math.min(...use.map(r => r.s))), sHi: r2(Math.max(...use.map(r => r.s))),
                 pl: Math.round(median(use.map(r => r.pl))), exp: r2(median(use.map(r => r.exp).filter(x => x != null))) };
    });
    const med = (f) => r2(median(paths.map(f).filter(x => x != null)));
    const D = paths.map(p => describe(p.rows));
    const desc = {};
    for (const k of ['n', 'up', 'beat', 'sMed', 'cMed', 'xMed', 'xMean', 'worst', 'best', 'maxLose', 'maxUw', 'exp']) desc[k] = med((_, i) => D[i][k]);
    desc.worstPl = Math.round(median(D.map(d => d.worstPl))); desc.bestPl = Math.round(median(D.map(d => d.bestPl)));
    desc.worstAll = r2(Math.min(...D.map(d => d.worst)));
    desc.cap = { up: med((_, i) => D[i].cap.up), down: med((_, i) => D[i].cap.down), upBeat: med((_, i) => D[i].cap.upBeat), downBeat: med((_, i) => D[i].cap.downBeat), nUp: med((_, i) => D[i].cap.nUp), nDown: med((_, i) => D[i].cap.nDown) };
    const roll = {};
    for (const h of [1, 3, 6, 12]) {
        const RS = paths.map(p => rollStats(rolling(p.rows, h))).filter(Boolean);
        roll[h] = { n: med((_, i) => RS[i]?.n), up: med((_, i) => RS[i]?.up), beat: med((_, i) => RS[i]?.beat), c0050Up: med((_, i) => RS[i]?.c0050Up),
                    xP10: med((_, i) => RS[i]?.xP10), xMed: med((_, i) => RS[i]?.xMed), xP90: med((_, i) => RS[i]?.xP90),
                    worst: med((_, i) => RS[i]?.worst), worstAll: r2(Math.min(...RS.map(r => r.worst))), best: med((_, i) => RS[i]?.best) };
    }
    return { paths: paths.length, table, desc, roll };
}

/** 預測檢定:用逐月中位序列(一個月一個樣本) */
export function predictTests(table, twiiAbove60) {
    const T = table.filter(r => !r.partial && r.n >= 5);
    const xs = T.map(r => r.x), cs = T.map(r => r.c);
    const cT = [...cs].sort((a, b) => a - b), lo = cT[Math.floor(cT.length / 3)], hi = cT[Math.floor(cT.length * 2 / 3)];
    const out = {
        prevLose: { q: '上個月輸 0050 → 這個月超額比較好(補回來)?', ...condTest(xs, i => i === 0 ? null : xs[i - 1] < 0) },
        prevBig: { q: '上個月 0050 大漲(前 1/3)→ 這個月超額比較差?', ...condTest(xs, i => i === 0 ? null : cs[i - 1] >= hi ? true : cs[i - 1] <= lo ? false : null) },
    };
    if (twiiAbove60) out.above60 = { q: '上個月底加權在 60 日線之上 → 這個月超額比較好?', ...condTest(xs, i => twiiAbove60[T[i].m] ?? null) };
    for (const k in out) for (const f of ['d', 't', 'first', 'second']) out[k][f] = r2(out[k][f]);
    return { months: T.length, tests: out };
}

function twiiAbove60Map(dir) {
    const b = loadPx(dir, '^TWII'); if (!b) return null;
    const me = monthEnds(b.map(x => x.d)), map = {};
    for (let k = 1; k < me.length; k++) {
        const i = me[k - 1]; if (i < 59) continue;
        let s = 0; for (let j = i - 59; j <= i; j++) s += b[j].c;
        map[b[me[k]].d.slice(0, 7)] = b[i].c > s / 60;          // 上月底狀態 → 這個月
    }
    return map;
}

function selftest() {
    let ok = 0, bad = 0;
    const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① 月底切點 + 月報酬
    const dates = ['2024-01-30', '2024-01-31', '2024-02-01', '2024-02-29', '2024-03-01', '2024-03-28', '2024-04-01', '2024-04-30', '2024-05-02'];
    const E = [100, 110, 111, 121, 120, 133.1, 133, 146.41, 146];
    const C = [1, 1, 1, 1.05, 1.05, 1.05, 1.05, 1.05, 1.05];
    t(JSON.stringify(monthEnds(dates)) === JSON.stringify([1, 3, 5, 7, 8]), '① 月底 = 每個月最後一個交易日(⛔ 不是月初)');
    const R = monthlyRows(dates, E, C, null);
    const full = R.filter(r => r.full);
    t(full.length === 3 && full.every(r => Math.abs(r.s - 10) < 1e-9), '② 2~4 月每月 +10%,第一段與最後一段(5/2 不是月底)不算完整月');
    t(Math.abs(full[0].c - 5) < 1e-9 && Math.abs(full[0].x - 5) < 1e-9 && Math.abs(full[1].x - 10) < 1e-9, '③ 超額 = 策略 − 0050(同一天切月)');
    t(Math.abs(full[1].pl - 12.1) < 1e-9, '④ 當月賺賠元 = 月底淨值差');
    // ⑤ 滾動 3 個月是複利
    const W = rolling(R, 3);
    t(W.length === 1 && Math.abs(W[0].s - 33.1) < 1e-9, '⑤ 滾動 3 個月 = 複利(+33.1%,⛔ 不是相加 30%)');
    // ⑥ 捕捉率恆等式
    const same = [{ s: 3, c: 3, x: 0 }, { s: -2, c: -2, x: 0 }, { s: 5, c: 5, x: 0 }];
    const cp = capture(same);
    t(Math.abs(cp.up - 100) < 1e-9 && Math.abs(cp.down - 100) < 1e-9, '⑥ 策略 = 0050 時上漲/下跌捕捉率都是 100%');
    // ⑦ 預測檢定:反轉序列要抓得到、隨機序列不過
    const alt = Array.from({ length: 40 }, (_, i) => (i % 2 ? 3 : -3) + (i % 5) * 0.1);
    const ct = condTest(alt, i => i === 0 ? null : alt[i - 1] < 0);
    t(ct.pass && ct.d > 0, '⑦ 注入「輸一個月就贏一個月」→ 上月輸組的本月超額顯著較高');
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
    const noise = Array.from({ length: 40 }, () => rnd() * 6);
    t(!condTest(noise, i => i === 0 ? null : noise[i - 1] < 0).pass, '⑧ 隨機序列(固定種子)→ 不過關');
    // ⑨ 0050 含息 ≠ 價格(除息那個月)
    const bars = [{ d: '2024-06-27', c: 100 }, { d: '2024-06-28', c: 100 }, { d: '2024-07-01', c: 99 }, { d: '2024-07-31', c: 99 }];
    const tr = trSeries(bars, [['2024-07-01', 1, '息', 100]]);
    t(Math.abs(tr.v[3] - 1) < 1e-6 && tr.v[3] > bars[3].c / bars[0].c, '⑨ 除息那個月:含息 0%、價格 −1%(0050 一律含息)');
    // ⑩ 多條起點:各月只用有涵蓋的
    const mk = (w, ds, es) => ({ warmup: w, rows: ds.map((d, i) => ({ d, cash: es[i], park: 0, mv: 0 })) });
    const trx = { d: dates, v: dates.map(() => 1) };
    const L = runLeg([mk(1, dates, E), mk(2, dates.slice(2), E.slice(2).map(x => x * 2))], trx);
    const mar = L.table.find(r => r.m === '2024-03'), feb = L.table.find(r => r.m === '2024-02'), jan = L.table.find(r => r.m === '2024-01');
    t(mar.n === 2 && feb.n === 1 && Math.abs(feb.s - 10) < 1e-9 && jan.n === 0 && jan.partial, '⑩ 起點晚的那條不算它沒涵蓋的月份(1 月 n=0 只剩不完整月、2 月 n=1、3 月 n=2;⛔ 不可補 0)');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const out = process.argv[2];
    const DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    const eqF = expand(process.env.EQ_GLOB), idF = expand(process.env.EQ_IDLE_GLOB);
    if (!eqF.length || !DATA) { console.error('要 EQ_GLOB + DATA_DIR'); process.exit(1); }
    const b50 = loadPx(DATA, '0050'); if (!b50) { console.error('DATA_DIR 沒有 0050.json'); process.exit(1); }
    let divs = []; if (DIV && fs.existsSync(DIV)) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); divs = ((raw.d || raw)['0050'] || {}).h || []; }
    else { console.error('⛔ 沒給 DIV → 0050 不含息會低估基準,拒跑'); process.exit(1); }
    const tr = trSeries(b50, divs, { capital: 1000000, nhi: true });
    const load = fs2 => fs2.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    const legs = { pb: runLeg(load(eqF), tr) };
    if (idF.length) legs.idle = runLeg(load(idF), tr);
    const a60 = twiiAbove60Map(DATA);
    for (const k in legs) legs[k].predict = predictTests(legs[k].table, a60);
    const res = { asof: new Date().toISOString().slice(0, 10), from: legs.pb.table[0].m, to: legs.pb.table.at(-1).m, divs: divs.length, legs,
                  note: '現行預設(吊燈 ATR 2 倍・最長 20 天・大盤嚴格空頭不開新倉・收盤成交・含股利)17 條起點;0050 含息 + 二代健保' };
    for (const k in legs) {
        const L = legs[k], d = L.desc;
        console.log(`\n══ ${k === 'pb' ? '現行預設' : '現行 + 閒錢停 0050'}(${L.paths} 條起點)══`);
        console.log(`完整月 ${d.n} 個:賺錢月 ${d.up}% ・贏 0050 ${d.beat}% ・月報酬中位 ${d.sMed}%(0050 ${d.cMed}%)・超額中位 ${d.xMed}pp 平均 ${d.xMean}pp`);
        console.log(`最壞一個月 ${d.worst}%(17 條最差 ${d.worstAll}%)・最好 ${d.best}% ・最壞一個月賠 ${d.worstPl} 元 ・連虧最長 ${d.maxLose} 個月 ・水下最長 ${d.maxUw} 個月 ・平均持股 ${d.exp}%`);
        console.log(`捕捉:0050 上漲月 ${d.cap.nUp} 個拿到 ${d.cap.up}%(贏 ${d.cap.upBeat}%)・下跌月 ${d.cap.nDown} 個跟跌 ${d.cap.down}%(贏 ${d.cap.downBeat}%)`);
        for (const h of [1, 3, 6, 12]) { const r = L.roll[h]; console.log(`持有 ${String(h).padStart(2)} 個月(${r.n} 段):賺錢 ${r.up}%(0050 ${r.c0050Up}%)・贏 0050 ${r.beat}% ・超額 P10 ${r.xP10} / 中位 ${r.xMed} / P90 ${r.xP90} ・最壞 ${r.worst}%(全部最差 ${r.worstAll}%)`); }
        for (const [key, v] of Object.entries(L.predict.tests)) console.log(`🔮 ${v.q} 差 ${v.d}pp t=${v.t}(${v.na} vs ${v.nb})前半 ${v.first} 後半 ${v.second} → ${v.pass ? '✅ 過關' : '⛔ 量不到'}`);
        console.log('逐月:' + L.table.map(r => `${r.m}${r.partial ? '*' : ''} ${r.s}/${r.c}`).join(' ・'));
    }
    if (out) { fs.writeFileSync(out, JSON.stringify(res)); console.log(`\n💾 ${out}`); }
}

if (process.argv.includes('--selftest')) process.exit(selftest());
else if (import.meta.url === `file://${process.argv[1]}`) main();
