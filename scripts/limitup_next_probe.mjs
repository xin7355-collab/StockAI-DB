#!/usr/bin/env node
/**
 * 🟥 V78.1.4 「手上的股票收盤鎖漲停 → 隔天、後天怎麼賣」情境回測
 *
 * 起因:使用者拿國巨(10/01 收盤鎖漲停、剛好抱滿上限)問「明天預判還會漲停,要再觀察還是照總覽先出場」,
 *   追問「隔日情境應該是多種的,你要都想好加進來回測,還有後天要怎麼操作」。
 *   本站以前只有一個數字(`_DT_EDGE.lu`:隔天開盤賣 vs 隔天收盤賣),⛔ 沒有拆情境、沒有後天、沒有盤中規則。
 *
 * 事件 = 某一檔某一天(D0)收盤鎖漲停(收 ≥ 昨收 × 鎖價門檻 且 收在最高);
 *   2015-06-01 以前漲跌幅是 7% → 門檻 1.06,之後 10% → 門檻 1.09(同 `dt_daily_probe.lockUp`)。
 * 每一種賣法的報酬一律算成「比 D0 收盤就賣多(少)幾 %」= 賣價 ÷ D0 收盤 − 1
 *   (⭐ 兩邊都只賣一次 → 成本一樣,⛔ 不用再扣;R0 = D0 收盤賣 = 0)。
 *
 * 📋 隔天(D+1)開盤 4 種情境:S1 開盤就在漲停 / S2 開高 ≥5% / S3 開高 0~5% / S4 開平或開低
 *    隔天收盤 3 種情境:C1 又鎖漲停 / C2 收紅(比 D0 收盤高)/ C3 收黑
 * 🚪 賣法(日K):
 *   R1 隔天開盤賣 ・R2 隔天收盤賣 ・R3 開盤賣一半 + 收盤賣一半 ・R4 開高 ≥5% 開盤賣、否則收盤賣 ・R5 反過來
 *   R6 「開盤在漲停就抱,沒有就開盤賣;抱著的那天收盤還鎖就再等下一個開盤,沒鎖就收盤賣」(最多 10 天)
 *   R7 「收盤還鎖就留,沒鎖就收盤賣」(只看收盤,最多 10 天)
 *   R8 後天開盤賣 ・R9 後天收盤賣
 * ⏱️ 盤中(5 分K,`KBAR5_DIR`,母體 = 每月初成交值前 100):
 *   K1 開盤後第一根 5 分K 收盤跌破當天開盤價就賣(那根收盤),否則收盤賣
 *   K2 從當天最高回落 3% 就賣(那根收盤),否則收盤賣 ・K3 09:30 那根收盤賣 ・K4 10:00 那根收盤賣
 *   (同一批事件也算 R1/R2 當對照,⛔ 不拿全市場的 R1 跟這批比)
 * 📅 後天表:依隔天「開盤 × 收盤」12 格,抱過隔天收盤之後 → 後天開盤 / 後天收盤 比隔天收盤多幾 %。
 *
 * 關卡(每一種賣法 vs R0):① 平均 > 0 且 t ≥ 2 ② 前後半同號 ③ 逐年 ≥ 70% 同號 ④ 拿掉最好那一年仍 > 0
 *   ⑤ 拿掉最好 1% 的事件仍 > 0 ⑥ 中位數 > 0。
 * ⚠️ 隔天開盤鎖跌停(賣不掉)的事件:那幾種「開盤賣」照樣用開盤價算 → 偏樂觀;筆數印出來。
 * ⚠️ 母體是「還在 data/ 裡的股票」(倖存者偏誤);2021 前只有上市(長歷史資料只有上市)。
 *
 * 跑法:DATA_DIR=$S/d10n [STRAT_CACHE=<portfolio_backtest LUDEFER=1 的 TRADES_CACHE>] [KBAR5_DIR=a:b] node scripts/limitup_next_probe.mjs out.json
 *   --selftest:合成資料逐條驗(情境分類 / 各賣法的值 / 7% 年代 / 連鎖停在第一個沒鎖的那天 / 尺標斷崖跳過 / 不看未來)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const lockThr = d => (d < '2015-06-01' ? 1.06 : 1.09);
const lim = d => (d < '2015-06-01' ? 0.07 : 0.10);
const isLock = (c, pc, h, d) => c >= pc * lockThr(d) && c >= h - 1e-9;
const atLimitUp = (px, pc, d) => px >= pc * lockThr(d);
const atLimitDn = (px, pc, d) => px <= pc * (2 - lockThr(d));
const CHAIN_MAX = 10;

/** 一檔的 K 線 → 事件陣列(只用 D0 當天收盤以前的資訊決定「是不是事件」;賣法照時間順序走,⛔ 不偷看) */
export function eventsOf(sym, rows, strat) {
    const R = rows.map(r => ({ d: norm(r.date), o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter(r => r.c > 0 && r.o > 0);
    const out = [];
    for (let i = 21; i < R.length - 3; i++) {
        const P = R[i - 1], A = R[i], B = R[i + 1], C = R[i + 2];
        if (!isLock(A.c, P.c, A.h, A.d)) continue;
        // 尺標斷崖:隔天 / 後天開盤收盤超出漲跌幅 → 不是真實行情(分割 / 還原價混用)
        const L = lim(B.d) + 0.005;
        if (Math.abs(B.o / A.c - 1) > L || Math.abs(B.c / A.c - 1) > L || Math.abs(C.o / B.c - 1) > L || Math.abs(C.c / B.c - 1) > L) continue;
        const r = px => (px / A.c - 1) * 100;
        const g = B.o / A.c - 1;
        const S = atLimitUp(B.o, A.c, B.d) ? 'S1' : g >= 0.05 ? 'S2' : g > 0 ? 'S3' : 'S4';
        const Cc = isLock(B.c, A.c, B.h, B.d) ? 'C1' : B.c > A.c ? 'C2' : 'C3';
        // R6 / R7 連鎖
        const chain = (needOpen) => {
            let k = i + 1;
            for (let n = 0; n < CHAIN_MAX && k < R.length; n++, k++) {
                const X = R[k], Pk = R[k - 1];
                if (Math.abs(X.o / Pk.c - 1) > lim(X.d) + 0.005 || Math.abs(X.c / Pk.c - 1) > lim(X.d) + 0.005) return null;
                if (needOpen && !atLimitUp(X.o, Pk.c, X.d)) return { px: X.o, days: n + 1 };
                if (!isLock(X.c, Pk.c, X.h, X.d)) return { px: X.c, days: n + 1 };
            }
            return null;   // 一直鎖到資料結束 / 超過上限 → 不算
        };
        const c6 = chain(true), c7 = chain(false);
        if (!c6 || !c7) continue;
        let ma = 0, ma5 = 0; for (let j = i - 19; j <= i; j++) ma += R[j].c; for (let j = i - 24; j <= i - 5; j++) ma5 += R[j < 0 ? 0 : j].c;
        out.push({
            sym, d: A.d, y: A.d.slice(0, 4), S, C: Cc, up: ma > ma5, strat: !!(strat && strat.has(`${sym}|${A.d}`)),
            dnLock: atLimitDn(B.o, A.c, B.d),
            c0: A.c, d1: B.d,
            R: {
                R1: r(B.o), R2: r(B.c), R3: (r(B.o) + r(B.c)) / 2,
                R4: g >= 0.05 && S !== 'S1' ? r(B.o) : r(B.c), R5: g >= 0.05 && S !== 'S1' ? r(B.c) : r(B.o),
                R6: r(c6.px), R7: r(c7.px), R8: r(C.o), R9: r(C.c),
            },
            chain6: c6.days, chain7: c7.days,
            // 後天表用:抱過隔天收盤之後,後天開盤 / 收盤 比隔天收盤多幾 %
            n2o: (C.o / B.c - 1) * 100, n2c: (C.c / B.c - 1) * 100,
        });
    }
    return out;
}

/** 盤中賣法(5 分K)。bars = [[hm,o,h,l,c,v],...] 隔天那一天,c0 = D0 收盤 */
export function intraRules(bars, c0) {
    const B = bars.filter(b => b[0] >= 540 && b[0] <= 810);
    if (B.length < 30) return null;
    const r = px => (px / c0 - 1) * 100, open = B[0][1], close = B[B.length - 1][4];
    let k1 = close, hi = -Infinity, k2 = close;
    for (let k = 0; k < B.length; k++) { if (B[k][4] < open) { k1 = B[k][4]; break; } }
    for (let k = 0; k < B.length; k++) { hi = Math.max(hi, B[k][2]); if (B[k][4] <= hi * 0.97) { k2 = B[k][4]; break; } }
    const at = hm => { const b = B.find(x => x[0] >= hm); return b ? b[4] : close; };
    return { K1: r(k1), K2: r(k2), K3: r(at(565)), K4: r(at(595)), R1: r(open), R2: r(close), open };
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** 一組事件 × 一種賣法 → 統計 + 六關 */
export function stat(evs, get) {
    const v = evs.map(get).filter(Number.isFinite);
    const n = v.length; if (n < 30) return { n, few: true };
    const m = mean(v), t = m / (sd(v) / Math.sqrt(n));
    const sorted = [...evs].sort((a, b) => (a.d < b.d ? -1 : 1)), half = sorted.length >> 1;
    const h1 = mean(sorted.slice(0, half).map(get).filter(Number.isFinite)), h2 = mean(sorted.slice(half).map(get).filter(Number.isFinite));
    const by = {}; for (const e of evs) { const x = get(e); if (Number.isFinite(x)) (by[e.y] = by[e.y] || []).push(x); }
    const yrs = Object.entries(by).filter(([, a]) => a.length >= 10).map(([y, a]) => [y, mean(a)]);
    const ySame = yrs.filter(([, x]) => Math.sign(x) === Math.sign(m)).length;
    const best = yrs.length ? yrs.reduce((b, x) => (x[1] * Math.sign(m) > b[1] * Math.sign(m) ? x : b)) : null;
    const dropY = best ? mean(evs.filter(e => e.y !== best[0]).map(get).filter(Number.isFinite)) : m;
    const vs = [...v].sort((a, b) => b - a), dropTop = mean(vs.slice(Math.ceil(n * 0.01)));
    // ⭐ 關卡一律問「比 D0 收盤賣**好**嗎」(⛔ 不是「方向一致」—— 一致地比較差不算過關)
    const yPos = yrs.filter(([, x]) => x > 0).length;
    const gates = [m > 0 && t >= 2, h1 > 0 && h2 > 0, yrs.length ? yPos / yrs.length >= 0.7 : false, dropY > 0, dropTop > 0, med(v) > 0];
    return { n, mean: r2(m), med: r2(med(v)), win: r2(v.filter(x => x > 0).length / n * 100), p10: r2(pct(v, 0.1)), p90: r2(pct(v, 0.9)), t: r2(t),
             h1: r2(h1), h2: r2(h2), years: `${yPos}/${yrs.length}`, dropY: r2(dropY), dropTop: r2(dropTop), gates: gates.filter(Boolean).length, g: gates.map(x => (x ? 1 : 0)).join('') };
}

const RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'];
const RNAME = { R1: '隔天開盤賣', R2: '隔天收盤賣', R3: '開盤一半收盤一半', R4: '開高≥5%開盤賣、否則收盤賣', R5: '開高≥5%抱到收盤、否則開盤賣',
    R6: '開盤在漲停就抱(沒有就開盤賣),收盤還鎖就再等', R7: '收盤還鎖就留,沒鎖就收盤賣', R8: '後天開盤賣', R9: '後天收盤賣',
    K1: '開盤後跌破開盤價就賣', K2: '從當天最高回落3%就賣', K3: '09:30 賣', K4: '10:00 賣' };
const SNAME = { S1: '開盤就在漲停', S2: '開高≥5%', S3: '開高0~5%', S4: '開平或開低' };
const CNAME = { C1: '收盤又鎖漲停', C2: '收紅', C3: '收黑' };

function analyze(evs) {
    const out = { n: evs.length, rules: {}, byS: {}, byUp: {}, next2: {}, chainDays: {} };
    for (const k of RULES) out.rules[k] = stat(evs, e => e.R[k]);
    for (const S of ['S1', 'S2', 'S3', 'S4']) {
        const sub = evs.filter(e => e.S === S); out.byS[S] = { n: sub.length, share: r2(sub.length / evs.length * 100), rules: {} };
        for (const k of RULES) out.byS[S].rules[k] = stat(sub, e => e.R[k]);
        // ⭐ 看到隔天開盤之後才決定 → 真正的問題是「這個情境下,繼續抱比開盤就賣多(少)幾 %」(兩者相減再過六關)
        out.byS[S].vsOpen = {}; for (const k of ['R2', 'R6', 'R7', 'R8', 'R9']) out.byS[S].vsOpen[k] = stat(sub, e => e.R[k] - e.R.R1);
        out.byS[S].C = {}; for (const C of ['C1', 'C2', 'C3']) out.byS[S].C[C] = r2(sub.filter(e => e.C === C).length / Math.max(1, sub.length) * 100);
    }
    for (const up of [true, false]) { const sub = evs.filter(e => e.up === up); const o = { n: sub.length, rules: {} }; for (const k of ['R1', 'R2', 'R6', 'R7', 'R8']) o.rules[k] = stat(sub, e => e.R[k]); out.byUp[up ? 'up' : 'dn'] = o; }
    for (const S of ['S1', 'S2', 'S3', 'S4']) for (const C of ['C1', 'C2', 'C3']) {
        const sub = evs.filter(e => e.S === S && e.C === C);
        out.next2[`${S}${C}`] = { n: sub.length, o: stat(sub, e => e.n2o), c: stat(sub, e => e.n2c) };
    }
    for (const C of ['C1', 'C2', 'C3']) { const sub = evs.filter(e => e.C === C); out.next2[C] = { n: sub.length, o: stat(sub, e => e.n2o), c: stat(sub, e => e.n2c) }; }
    const cd = {}; for (const e of evs) cd[e.chain6] = (cd[e.chain6] || 0) + 1; out.chainDays = cd;
    out.dnLock = evs.filter(e => e.dnLock).length;
    return out;
}

function loadKbar5(spec) {
    const days = {};
    for (const dir of String(spec || '').split(':').filter(Boolean)) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort()) {
            const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
            for (const [d, v] of Object.entries(j.d || {})) if (!days[d]) days[d] = v;
        }
    }
    return days;
}

function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    const mk = (d0, extra) => {   // 30 根平盤 100 → 第 30 根(D0)鎖漲停 110 → 後面 extra
        const rows = []; const base = new Date(Date.UTC(2022, 0, 3));
        const day = k => new Date(base.getTime() + k * 86400000).toISOString().slice(0, 10);
        for (let k = 0; k < 30; k++) rows.push({ date: day(k), open: 100, high: 100.5, low: 99.5, close: 100 });
        rows.push({ date: d0 || day(30), open: 103, high: 110, low: 102, close: 110 });
        extra.forEach((x, j) => rows.push({ date: day(31 + j), ...x }));
        return rows;
    };
    // ① 開高 3%(S3)、收黑 105、後天開 106 收 104
    let E = eventsOf('9999', mk(null, [{ open: 113.3, high: 114, low: 104, close: 105 }, { open: 106, high: 107, low: 103, close: 104 }, { open: 104, high: 104, low: 104, close: 104 }, { open: 104, high: 104, low: 104, close: 104 }]));
    ok('① 偵測到 D0 鎖漲停一筆', E.length === 1, E.length);
    const e = E[0] || { R: {} };
    ok('② 開高 3% → S3;收 105 < 110 → C3', e.S === 'S3' && e.C === 'C3', `${e.S}${e.C}`);
    ok('③ R1 = +3.00、R2 = −4.55、R8 = −3.64、R9 = −5.45', Math.abs(e.R.R1 - 3) < 1e-6 && Math.abs(e.R.R2 - (105 / 110 - 1) * 100) < 1e-6 && Math.abs(e.R.R8 - (106 / 110 - 1) * 100) < 1e-6 && Math.abs(e.R.R9 - (104 / 110 - 1) * 100) < 1e-6, JSON.stringify(e.R));
    ok('④ R6:開盤沒在漲停 → 開盤賣(= R1),1 天', e.R.R6 === e.R.R1 && e.chain6 === 1, `${e.R.R6} ${e.chain6}`);
    ok('⑤ 後天表:n2o = 106/105−1、n2c = 104/105−1', Math.abs(e.n2o - (106 / 105 - 1) * 100) < 1e-6 && Math.abs(e.n2c - (104 / 105 - 1) * 100) < 1e-6, `${e.n2o} ${e.n2c}`);
    // ⑥ 連鎖:隔天開盤在漲停 121、收盤又鎖 121 → 後天開 125(沒在漲停 133.1)→ R6 賣在後天開盤 125,2 天;R7 後天收盤沒鎖 → 後天收盤
    E = eventsOf('9999', mk(null, [{ open: 121, high: 121, low: 121, close: 121 }, { open: 125, high: 126, low: 120, close: 122 }, { open: 122, high: 122, low: 122, close: 122 }, { open: 122, high: 122, low: 122, close: 122 }]));
    const f = E[0] || { R: {} };
    ok('⑥ S1 + C1;R6 賣在後天開盤 125(2 天)、R7 賣在後天收盤 122', f.S === 'S1' && f.C === 'C1' && Math.abs(f.R.R6 - (125 / 110 - 1) * 100) < 1e-6 && f.chain6 === 2 && Math.abs(f.R.R7 - (122 / 110 - 1) * 100) < 1e-6, JSON.stringify({ S: f.S, C: f.C, R6: f.R.R6, R7: f.R.R7, d: f.chain6 }));
    ok('⑦ R4/R5:S1(開盤在漲停)不算「開高 ≥5%」→ R4 = 收盤、R5 = 開盤', f.R.R4 === f.R.R2 && f.R.R5 === f.R.R1, JSON.stringify(f.R));
    // ⑧ 7% 年代:2014 年漲 7% 鎖住也算
    const old = mk('2014-01-31', [{ open: 108, high: 109, low: 106, close: 107 }, { open: 107, high: 107, low: 107, close: 107 }, { open: 107, high: 107, low: 107, close: 107 }, { open: 107, high: 107, low: 107, close: 107 }]);
    old[30] = { date: '2014-01-31', open: 102, high: 107, low: 101, close: 107 }; old.slice(31).forEach((r, j) => { r.date = `2014-02-0${3 + j}`; });
    for (let k = 0; k < 30; k++) old[k].date = `2013-12-${String(1 + k).padStart(2, '0')}`;
    ok('⑧ 2015-06 以前 7% 鎖住也算事件', eventsOf('9999', old).length === 1, eventsOf('9999', old).length);
    // ⑨ 尺標斷崖(隔天 ÷4)→ 跳過
    ok('⑨ 隔天價格 ÷4(分割 / 還原價)→ 不算', eventsOf('9999', mk(null, [{ open: 27.5, high: 28, low: 27, close: 27.5 }, { open: 27.5, high: 27.5, low: 27.5, close: 27.5 }, { open: 27.5, high: 27.5, low: 27.5, close: 27.5 }, { open: 27.5, high: 27.5, low: 27.5, close: 27.5 }])).length === 0);
    // ⑩ 沒鎖住(收 110 但最高 111)→ 不算
    const nl = mk(null, [{ open: 112, high: 113, low: 108, close: 109 }, { open: 109, high: 109, low: 109, close: 109 }, { open: 109, high: 109, low: 109, close: 109 }, { open: 109, high: 109, low: 109, close: 109 }]); nl[30].high = 111;
    ok('⑩ 收在漲停價但最高更高(打開過)→ 不算鎖漲停', eventsOf('9999', nl).length === 0);
    // ⑪ 盤中:開 113、第 3 根跌破開盤收 112 → K1 = 112;最高 115、回落到 111.5(≤ 115×0.97=111.55)→ K2
    const bars = [[540, 113, 115, 112.8, 114, 1], [545, 114, 115, 113, 113.5, 1], [550, 113.5, 113.6, 111.9, 112, 1], [555, 112, 112, 111, 111.5, 1]];
    for (let hm = 560; hm <= 810; hm += 5) bars.push([hm, 111.5, 112, 111, 111.6, 1]);
    const k = intraRules(bars, 110);
    ok('⑪ K1 跌破開盤那根收盤 112、K2 回落 3% 那根 111.5、K3 09:25 那根之後的 09:30 收盤', Math.abs(k.K1 - (112 / 110 - 1) * 100) < 1e-6 && Math.abs(k.K2 - (111.5 / 110 - 1) * 100) < 1e-6 && Math.abs(k.K3 - (111.6 / 110 - 1) * 100) < 1e-6, JSON.stringify(k));
    // ⑫ 統計:全部 +1 → 六關全過;全部 −1 → 0 關
    const fake = Array.from({ length: 200 }, (_, j) => ({ d: `20${15 + (j % 10)}-01-${String(1 + (j % 28)).padStart(2, '0')}`, y: `20${15 + (j % 10)}`, v: 1 + (j % 7) * 0.1 }));
    ok('⑫ stat:全部為正 → 6 關;全部為負 → 0 關', stat(fake, e => e.v).gates === 6 && stat(fake, e => -e.v).gates === 0, `${stat(fake, e => e.v).gates} ${stat(fake, e => -e.v).gates}`);
    console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ LUNEXT_SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}

async function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const DATA = process.env.DATA_DIR; if (!DATA || !fs.existsSync(DATA)) { console.error('❌ 要 DATA_DIR'); process.exit(1); }
    let strat = null;
    if (process.env.STRAT_CACHE) {   // portfolio_backtest LUDEFER=1 的交易快取:ld=1 那幾筆的出場日前一天 = D0
        const c = JSON.parse(fs.readFileSync(process.env.STRAT_CACHE, 'utf8')); strat = new Set();
        const byS = {};
        for (const t of c.trades.filter(t => t.ld)) (byS[t.sym] = byS[t.sym] || []).push(norm(t.outD));
        for (const [s, ds] of Object.entries(byS)) {
            const rows = JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf8')).map(r => norm(r.date));
            for (const d of ds) { const k = rows.indexOf(d); if (k > 0) strat.add(`${s}|${rows[k - 1]}`); }
        }
        console.log(`🧬 這套策略「抱滿那天鎖漲停」的事件:${strat.size} 筆(${process.env.STRAT_CACHE})`);
    }
    const files = fs.readdirSync(DATA).filter(f => /^[1-9]\d{3}\.json$/.test(f));
    const all = [], rowsBy = {};
    for (const f of files) {
        const sym = f.slice(0, 4); let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(rows) || rows.length < 40) continue;
        const ev = eventsOf(sym, rows, strat); for (const e of ev) all.push(e);
        if (ev.length) rowsBy[sym] = true;
    }
    if (all.length < 1000) { console.error(`❌ 事件只有 ${all.length} 筆(< 1,000)→ 資料目錄不對或尺標全壞,⛔ 不給結論`); process.exit(1); }
    const span = [all.reduce((m, e) => (e.d < m ? e.d : m), '9'), all.reduce((m, e) => (e.d > m ? e.d : m), '0')];
    console.log(`🟥 收盤鎖漲停事件 ${all.length.toLocaleString()} 筆 ・${Object.keys(rowsBy).length} 檔 ・${span[0]} ~ ${span[1]}`);
    const OUT = { src: 'scripts/limitup_next_probe.mjs(V78.1.4)', data: DATA, span, all: analyze(all), rname: RNAME, sname: SNAME, cname: CNAME };
    if (strat) {
        const st = all.filter(e => e.strat);
        console.log(`🧬 對到的策略事件 ${st.length} / ${strat.size}`);
        if (st.length >= 30) OUT.strat = analyze(st);
    }
    // ⏱️ 盤中(5 分K)
    if (process.env.KBAR5_DIR) {
        const days = loadKbar5(process.env.KBAR5_DIR); let hit = 0, miss = 0, scale = 0;
        const iv = [];
        for (const e of all) {
            const day = days[e.d1]; const raw = day && day.k && day.k[e.sym]; if (!raw) { miss++; continue; }
            const k = intraRules(raw, e.c0); if (!k) { miss++; continue; }
            if (Math.abs(k.R1 - e.R.R1) > 0.6) { scale++; continue; }   // 5 分K 開盤跟日K 開盤對不上(還原價等)→ 不算
            hit++; iv.push({ ...e, K: k });
        }
        console.log(`⏱️ 5 分K 對到 ${hit} 筆(沒有那一天/那一檔 ${miss}、開盤對不上 ${scale})`);
        if (iv.length >= 30) {
            const o = { n: iv.length, scaleSkip: scale, rules: {}, byS: {} };
            for (const kk of ['K1', 'K2', 'K3', 'K4', 'R1', 'R2']) o.rules[kk] = stat(iv, e => e.K[kk]);
            for (const S of ['S1', 'S2', 'S3', 'S4']) { const sub = iv.filter(e => e.S === S); o.byS[S] = { n: sub.length, rules: {}, vsOpen: {} };
                for (const kk of ['K1', 'K2', 'K3', 'K4', 'R1', 'R2']) o.byS[S].rules[kk] = stat(sub, e => e.K[kk]);
                for (const kk of ['K1', 'K2', 'K3', 'K4', 'R2']) o.byS[S].vsOpen[kk] = stat(sub, e => e.K[kk] - e.K.R1); }
            OUT.intra = o;
        }
    }
    const pr = (lbl, a) => {
        console.log(`\n━━ ${lbl}(n=${a.n.toLocaleString()};隔天開盤鎖跌停 ${a.dnLock} 筆)`);
        for (const k of RULES) { const s = a.rules[k]; console.log(`  ${k} ${RNAME[k].padEnd(26)} 平均 ${s.mean}% 中位 ${s.med}% 贏 ${s.win}% 最差一成 ${s.p10}% t=${s.t} 前後半 ${s.h1}/${s.h2} 逐年 ${s.years} 關 ${s.gates}/6`); }
        for (const S of ['S1', 'S2', 'S3', 'S4']) {
            const b = a.byS[S]; console.log(`  ── ${S} ${SNAME[S]}(${b.n},${b.share}%;收盤 又鎖 ${b.C.C1}% / 收紅 ${b.C.C2}% / 收黑 ${b.C.C3}%)`);
            for (const k of ['R1', 'R2', 'R6', 'R7', 'R8', 'R9']) { const s = b.rules[k]; if (s.few) continue; console.log(`     ${k} ${RNAME[k].padEnd(26)} 平均 ${s.mean}% 中位 ${s.med}% 贏 ${s.win}% 最差一成 ${s.p10}% 關 ${s.gates}/6`); }
            console.log('     ↳ 繼續抱 − 開盤就賣:' + Object.entries(b.vsOpen).filter(([, s]) => !s.few).map(([k, s]) => `${k} ${s.mean >= 0 ? '+' : ''}${s.mean}pp(贏 ${s.win}%、最差一成 ${s.p10}、關 ${s.gates}/6)`).join(' ・'));
        }
        console.log('  ── 後天(抱過隔天收盤之後,後天開盤 / 收盤 比隔天收盤多幾 %)');
        for (const key of ['C1', 'C2', 'C3']) { const x = a.next2[key]; console.log(`     ${CNAME[key]}(${x.n}):後天開盤 ${x.o.mean}%(贏 ${x.o.win}%、關 ${x.o.gates}/6)・後天收盤 ${x.c.mean}%(贏 ${x.c.win}%、關 ${x.c.gates}/6)`); }
        console.log(`  ── R6 抱了幾天:${JSON.stringify(a.chainDays)}`);
    };
    pr('全市場', OUT.all);
    if (OUT.strat) pr('這套策略抱滿那天鎖漲停', OUT.strat);
    if (OUT.intra) { console.log(`\n━━ ⏱️ 盤中(5 分K,n=${OUT.intra.n})`); for (const [k, s] of Object.entries(OUT.intra.rules)) console.log(`  ${k} ${RNAME[k].padEnd(26)} 平均 ${s.mean}% 中位 ${s.med}% 贏 ${s.win}% 最差一成 ${s.p10}% 關 ${s.gates}/6`);
        for (const [S, b] of Object.entries(OUT.intra.byS)) { console.log(`  ── ${S} ${SNAME[S]}(${b.n}):` + Object.entries(b.rules).filter(([, s]) => !s.few).map(([k, s]) => `${k} ${s.mean}%`).join(' ・'));
            console.log('     ↳ − 開盤就賣:' + Object.entries(b.vsOpen).filter(([, s]) => !s.few).map(([k, s]) => `${k} ${s.mean >= 0 ? '+' : ''}${s.mean}pp(關 ${s.gates}/6)`).join(' ・')); } }
    const out = process.argv[2]; if (out) { fs.writeFileSync(out, JSON.stringify(OUT)); console.log(`\n💾 ${out}`); }
}

main();
