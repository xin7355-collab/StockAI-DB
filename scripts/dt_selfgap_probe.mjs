#!/usr/bin/env node
// 🚦 dt_selfgap_probe —— 當沖頁「今天這檔怎麼做」與選股「當沖雷達」換到沒看過的日子還準不準(V79.0.3)
//
// 兩張卡算的是同一件事:這一檔近 150 天「開盤買、收盤賣」收紅的比例,依開盤情境(開高 >1% / 開平 / 開低 <−1%)分三桶。
// 畫面上的數字全部是**樣本內**(拿今天以前 150 天算、套在今天以前那 150 天上)。這支只做一件事:
//   每一天 t,只用 t 以前 150 根算統計(⛔ 不含 t),照畫面同一套規則決定「做多 / 做空 / 不做」,
//   再看 t 當天真的開盤→收盤賺多少,扣當沖來回成本 0.25%。
//
// 規則照抄 index.html(⛔ 不改):
//   A 當沖頁 `_dtVerdictInner` / `_dtLongStats`:桶樣本 <10 退回全部;情境桶沒贏「隨便挑一天」退回全部;
//     扣成本後期望值 >0 才給方向(做多 netL / 做空 netS 取大)。
//   B 當沖雷達 `_renderDaytradeRadar` + `radar_miner._dt_winrate`:成交額 ≥5 千萬・近 5 日均振幅 ≥2%・昨量 ≥1,000 張;
//     桶樣本 <8 退回全部;勝率 ≥55% 依勝率排前 10。⚠️ 雷達的「開盤情境」用外資台指期**推估**,
//     這裡直接給**當天真的開盤桶**(= 推估全猜對的最好情況)+ 另跑「全部」桶。
// 對照:同一天、同一個開盤桶的所有股票(開盤買收盤賣的平均)—— 量的是「這檔自己的歷史有沒有多帶資訊」。
//
// 用法:DATA_DIR=<含 {sym}.json 的目錄> node scripts/dt_selfgap_probe.mjs [out.json]
//       node scripts/dt_selfgap_probe.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { loadKbar5 } from './dt_kbar5_probe.mjs';

const LIQ = +(process.env.LIQ || 0);   // 前一天成交額下限(元),拆流動性用
const WIN = 150, COST = 0.25, MIN_N = 10, RADAR_MIN_N = 8, RADAR_WR = 55, RADAR_TOP = 10;

export function bucketOf(o, pc) { const oc = (o - pc) / pc * 100; return oc > 1 ? 'up' : oc < -1 ? 'dn' : 'flat'; }

// 跟 `_dtLongStats` 同一個算法,只是吃「到 i−1 為止的最後 WIN 根」(⛔ 不含 i)
export function statsBefore(R, i) {
    const arr = R.slice(Math.max(0, i - WIN), i);
    const mk = () => ({ n: 0, win: 0, cL: 0, sumR: 0, sumW: 0, cW: 0 });
    const B = { up: mk(), flat: mk(), dn: mk(), all: mk() };
    for (let k = 1; k < arr.length; k++) {
        const o = arr[k].o, c = arr[k].c, pc = arr[k - 1].c;
        if (!(o > 0 && c > 0 && pc > 0)) continue;
        const r = (c - o) / o * 100, key = bucketOf(o, pc);
        for (const b of [B[key], B.all]) { b.n++; b.sumR += r; if (c > o) { b.win++; b.sumW += r; b.cW++; } else if (c < o) b.cL++; }
    }
    return B;
}

// A:當沖頁的判定(照抄 `_dtVerdictInner`)
export function verdictA(B, key) {
    if (!B.all.n) return null;
    let b = B[key], scen = true;
    if (!b || b.n < MIN_N) { b = B.all; scen = false; }
    const A = B.all;
    if (scen) {
        const wl = b.win / b.n, bl = A.win / A.n, ws = b.cL / b.n, bs = A.cL / A.n;
        if (!(wl > bl || ws > bs)) b = A;
    }
    const expL = b.sumR / b.n, netL = expL - COST, netS = -expL - COST, enough = b.n >= MIN_N;
    const okL = enough && netL > 0, okS = enough && netS > 0;
    const dir = okL && (!okS || netL >= netS) ? 'long' : okS ? 'short' : 'none';
    return { dir, wrL: b.win / b.n * 100, wrS: b.cL / b.n * 100, n: b.n };
}

// B:雷達(照抄 `_dt_winrate` pack + 前端 pick)
export function radarPick(B, key) {
    const b = B[key] && B[key].n >= RADAR_MIN_N ? B[key] : B.all;
    if (!b || b.n < RADAR_MIN_N) return null;
    return { lwr: b.win / b.n * 100, swr: b.cL / b.n * 100, n: b.n };
}

function load(dir) {
    const out = {};
    for (const f of fs.readdirSync(dir)) {
        const sym = f.replace(/\.json$/, '');
        if (!/^[1-9]\d{3}$/.test(sym)) continue;            // 上市櫃 4 碼個股(⛔ ETF、權證)
        let a; try { a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!Array.isArray(a) || a.length < WIN + 20) continue;
        const R = a.map(x => ({ d: String(x.date).replace(/\//g, '-'), o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume || 0 }))
            .filter(x => x.o > 0 && x.c > 0).sort((x, y) => x.d < y.d ? -1 : 1);
        out[sym] = R;
    }
    return out;
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function tstat(a) {
    if (a.length < 3) return null;
    const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
    return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null;
}

// 5 分 K:09:05 進場(第一根 5 分 K 收盤)→ 收盤(最後一根收盤)。⭐ 本站實測「開盤撮合價」那一筆常常是假象(dt_kbar5 V77.5.0)。
export function r905Of(K, sym, d) {
    const day = K && K.days[d]; const b = day && day.k && day.k[sym];
    if (!b || b.length < 30) return null;
    const e = +b[0][4], c = +b[b.length - 1][4];
    return e > 0 && c > 0 ? { r: (c - e) / e * 100, e } : null;
}
export function run(stocks, { lastDate = null, keepEv = false, K = null } = {}) {
    // 每一天每個桶的全市場平均(對照)
    const day = {}, day5 = {};   // d -> { up:[r], flat:[r], dn:[r] }(day5 = 09:05 進場,只有 5 分 K 那幾檔)
    const ev = [];
    for (const [sym, R] of Object.entries(stocks)) {
        for (let i = WIN + 1; i < R.length; i++) {
            const t = R[i], pc = R[i - 1].c;
            if (lastDate && t.d > lastDate) break;
            const oc = (t.o - pc) / pc * 100;
            if (Math.abs(oc) > 9.5) continue;                 // 開盤就漲跌停:買不到/空不到;|>11%| = 尺標斷崖
            if (LIQ && R[i - 1].c * R[i - 1].v < LIQ) continue;
            const r = (t.c - t.o) / t.o * 100, key = bucketOf(t.o, pc);
            // 🔒 收盤鎖漲停:當沖空單當天回補不了 → 隔天開盤才補(同 dt_kbar5 F7 的教訓)
            const nx = R[i + 1], locked = t.c >= pc * 1.095 && t.c >= t.h;
            const rS = locked ? (nx && nx.o > 0 ? (nx.o - t.o) / t.o * 100 : null) : r;
            ((day[t.d] ||= { up: [], flat: [], dn: [] })[key]).push(r);
            const k5 = K ? r905Of(K, sym, t.d) : null, r5 = k5 ? k5.r : null;
            const rS5 = k5 ? (locked ? (nx && nx.o > 0 ? (nx.o - k5.e) / k5.e * 100 : null) : k5.r) : null;
            if (r5 != null) ((day5[t.d] ||= { up: [], flat: [], dn: [] })[key]).push(r5);
            const B = statsBefore(R, i);
            const va = verdictA(B, key);
            // 雷達的流動性閘門(用 t−1 那天的資料,= 盤後採礦當時看得到的)
            const p = R[i - 1], turnover = p.c * p.v;
            const a5 = []; for (let k = Math.max(1, i - 5); k < i; k++) a5.push((R[k].h - R[k].l) / R[k - 1].c * 100);
            const amp5 = mean(a5) || 0;
            const radarOk = turnover >= 5e7 && amp5 >= 2 && p.v >= 1e6;
            ev.push({ sym, d: t.d, key, r, rS, locked, r5, rS5, va, rpAct: radarOk ? radarPick(B, key) : null, rpAll: radarOk ? radarPick(B, 'all') : null });
        }
    }
    const ctrlOf = (D, min) => (d, key) => { const a = D[d] && D[d][key]; return a && a.length >= min ? mean(a) : null; };
    const RF0 = e => e.r;
    let ctrl = ctrlOf(day, 20), rf = RF0;
    const side = (rows, s) => {
        const net = [], ex = [], win = [], pred = [], years = {};
        for (const e of rows) {
            const c = ctrl(e.d, e.key); if (c == null) continue;
            const rr = s === 'short' ? (rf === RF0 ? e.rS : e.rS5) : rf(e); if (rr == null) continue;
            const g = s === 'long' ? rr : -rr;
            net.push(g - COST); ex.push(g - (s === 'long' ? c : -c)); win.push(g > 0 ? 1 : 0);
            (years[e.d.slice(0, 4)] ||= []).push(g - COST);
            if (e.pw != null) pred.push(e.pw);
        }
        return {
            n: net.length, netMean: mean(net), exMean: mean(ex), tEx: tstat(ex), winRate: mean(win) * 100,
            predWin: pred.length ? mean(pred) : null,
            byYear: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, +mean(a).toFixed(3)])),
        };
    };
    const A_long = ev.filter(e => e.va && e.va.dir === 'long').map(e => ({ ...e, pw: e.va.wrL }));
    const A_short = ev.filter(e => e.va && e.va.dir === 'short').map(e => ({ ...e, pw: e.va.wrS }));
    // 雷達:每天每邊前 10
    const radarSide = (field, s) => {
        const byDay = {};
        for (const e of ev) { const p = e[field]; if (!p) continue; const w = s === 'long' ? p.lwr : p.swr; if (w >= RADAR_WR) (byDay[e.d] ||= []).push({ ...e, pw: w }); }
        const rows = [];
        for (const arr of Object.values(byDay)) arr.sort((a, b) => b.pw - a.pw).slice(0, RADAR_TOP).forEach(x => rows.push(x));
        return rows;
    };
    const allDays = ev.filter(e => ctrl(e.d, e.key) != null);
    // ⏱️ 同一批「有 5 分 K」的事件,開盤價進場 vs 09:05 進場(對照各用自己那個時點的同天同桶平均)
    let at905 = null;
    if (K) {
        const has = e => e.r5 != null;
        const pack = () => ({
            baseShort: side(ev.filter(has), 'short'), baseLong: side(ev.filter(has), 'long'),
            Along: side(A_long.filter(has), 'long'), Ashort: side(A_short.filter(has), 'short'),
            radarLong: side(radarSide('rpAct', 'long').filter(has), 'long'), radarShort: side(radarSide('rpAct', 'short').filter(has), 'short'),
        });
        ctrl = ctrlOf(day5, 10); rf = RF0; const open = pack();
        rf = e => e.r5; const m905 = pack();
        ctrl = ctrlOf(day, 20); rf = RF0;
        at905 = { open, m905 };
    }
    return {
        at905,
        ...(keepEv ? { ev: ev.map(e => e.sym + '|' + e.d) } : {}),
        nEvents: ev.length, lockedShortA: ev.filter(e => e.va && e.va.dir === 'short' && e.locked).length,
        from: ev.reduce((m, e) => e.d < m ? e.d : m, '9999'), to: ev.reduce((m, e) => e.d > m ? e.d : m, '0000'),
        base: { long: side(allDays, 'long'), short: side(allDays, 'short') },
        A: { long: side(A_long, 'long'), short: side(A_short, 'short'), none: ev.filter(e => e.va && e.va.dir === 'none').length },
        radarActual: { long: side(radarSide('rpAct', 'long'), 'long'), short: side(radarSide('rpAct', 'short'), 'short') },
        radarAll: { long: side(radarSide('rpAll', 'long'), 'long'), short: side(radarSide('rpAll', 'short'), 'short') },
    };
}

// ── selftest ─────────────────────────────────────────────────────────
function synth(seed, n, edge) {
    let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const R = []; let px = 100;
    for (let i = 0; i < n; i++) {
        const d = new Date(Date.UTC(2023, 0, 1) + i * 86400e3).toISOString().slice(0, 10);
        const o = px * (1 + (rnd() - 0.5) * 0.03);
        const r = (rnd() - 0.5) * 0.04 + edge(i);
        const c = o * (1 + r), h = Math.max(o, c) * 1.01, l = Math.min(o, c) * 0.99;
        R.push({ d, o, h, l, c, v: 5e6 }); px = c;
    }
    return R;
}
function selftest() {
    let ok = 0, bad = 0; const T = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); cond ? ok++ : bad++; };
    // ① statsBefore 不含當天:改當天的價格,統計不可變
    const R = synth(7, 400, () => 0);
    const s1 = JSON.stringify(statsBefore(R, 300));
    const R2 = R.map(x => ({ ...x })); R2[300].c *= 1.5;
    T('① 統計不含當天(改當天收盤,統計不變)', JSON.stringify(statsBefore(R2, 300)) === s1);
    // ② 注入「前視」:用到當天 → 改當天收盤統計會變(決定性對照)
    const leak = (RR, i) => statsBefore(RR, i + 1);
    T('② 決定性對照:含當天的版本會被當天收盤改變', JSON.stringify(leak(R2, 300)) !== JSON.stringify(leak(R, 300)));
    // ③ 埋一檔每天都 +1% 的股票 → A 要判做多、而且扣成本後為正、贏對照
    const stocks = { 1111: synth(3, 500, () => 0.01) };
    for (let k = 0; k < 30; k++) stocks[2000 + k] = synth(100 + k, 500, () => 0);
    const out = run(stocks);
    T('③ 埋 +1%/天:A 做多扣成本後 >0', out.A.long.n > 100 && out.A.long.netMean > 0.3);
    T('③b 埋 +1%/天:贏同桶對照 >0.5pp', out.A.long.exMean > 0.5);
    // ④ 隨機股票:A 不該有大量做多,而且做了也不會贏對照
    const rnd = {}; for (let k = 0; k < 30; k++) rnd[3000 + k] = synth(500 + k, 500, () => 0);
    const o2 = run(rnd);
    T('④ 隨機:做多(若有)贏對照 |ex| < 0.4pp', o2.A.long.n === 0 || Math.abs(o2.A.long.exMean) < 0.4);
    // ⑤ 開盤漲跌停剔除
    const L = synth(9, 200, () => 0); L[180].o = L[179].c * 1.1; L[180].c = L[180].o;
    const o3 = run({ 4444: L, ...Object.fromEntries(Array.from({ length: 25 }, (_, k) => [5000 + k, synth(900 + k, 200, () => 0)])) }, { keepEv: true });
    T('⑤ 開盤 +10% 那天不算', o3.ev.includes('4444|' + L[179].d) && !o3.ev.includes('4444|' + L[180].d));
    console.log(`\nselftest ${ok}/${ok + bad}`);
    process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else {
    const dir = process.env.DATA_DIR || 'data';
    const stocks = load(dir);
    const n = Object.keys(stocks).length;
    if (n < 200) { console.error(`❌ 只讀到 ${n} 檔(DATA_DIR=${dir})`); process.exit(1); }
    console.log(`讀到 ${n} 檔`);
    const K = process.env.KBAR5_DIR ? loadKbar5(process.env.KBAR5_DIR) : null;
    if (K) console.log(`5 分 K ${Object.keys(K.days).length} 天`);
    const res = run(stocks, { K });
    const f = (x, k = 2) => x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(k);
    const line = (name, s) => console.log(`${name.padEnd(28)} n=${String(s.n).padStart(7)}  扣成本每趟 ${f(s.netMean, 3)}%  勝率 ${s.winRate == null ? '—' : s.winRate.toFixed(1)}%${s.predWin != null ? `(畫面說 ${s.predWin.toFixed(1)}%)` : ''}  比同天同桶 ${f(s.exMean, 3)}pp t=${f(s.tEx, 1)}  逐年 ${JSON.stringify(s.byYear)}`);
    console.log(`窗口 ${res.from} ~ ${res.to}・股·日 ${res.nEvents}`);
    line('基準 全部做多', res.base.long); line('基準 全部做空', res.base.short);
    line('A 當沖頁 → 做多', res.A.long); line('A 當沖頁 → 做空', res.A.short);
    console.log(`A 當沖頁 → 不值得當沖 ${res.A.none} 天`);
    line('B 雷達(猜中開盤桶)做多前10', res.radarActual.long); line('B 雷達(猜中開盤桶)做空前10', res.radarActual.short);
    line('B 雷達(全部桶)做多前10', res.radarAll.long); line('B 雷達(全部桶)做空前10', res.radarAll.short);
    if (res.at905) for (const [k, lab] of [['baseLong', '全部做多'], ['baseShort', '全部做空'], ['Along', 'A 做多'], ['Ashort', 'A 做空'], ['radarLong', '雷達做多'], ['radarShort', '雷達做空']]) {
        line(`⏱️ ${lab}・開盤價`, res.at905.open[k]); line(`⏱️ ${lab}・09:05`, res.at905.m905[k]);
    }
    const out = process.argv[2];
    if (out && !out.startsWith('--')) { fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log('→', out); }
}
