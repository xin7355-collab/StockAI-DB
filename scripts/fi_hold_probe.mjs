// 🏦 fi_hold_probe.mjs —— 個股「外資持股比」20 天大增 / 大減之後,那一檔接下來 20 天比同一天的其他股票好(或差)嗎?
//   (「App 加上人性」第 7 期第 7 題,EXP 事先登記)
//
// 為什麼要測:常聽說「外資持股比一直往上 = 外資在買進布局,跟著買」。以前測過外資「連買幾天」「突然一大筆」都沒用
//   (fi-trust-sync / fi-burst);這一題看的是「持股比」本身的變化(買超 ÷ 股本,大型股小型股放在同一把尺上)。
//
// 資料:stock_deep/share/{sym}.json.gz(FinMind TaiwanStockShareholding 2010 起;欄 ForeignInvestmentSharesRatio = 外資持股比 %)
//   × d16 每一檔收盤 / 成交量(2010~2026,含已下市)。⛔ 00 開頭 ETF。
// 時間點(⛔ 前視):t 那天的持股比收盤後才公布 → 從 t+1 收盤進場,算到 t+21 收盤(20 個交易日)。
// 事件:ΔFR20 = t 的持股比 − 20 個交易日前(兩天都要有);那天「可以比」的股票(近 20 天平均成交金額 ≥ 5,000 萬、
//   之後 20 天有價)裡排前 5% 而且 ≥ +2 個百分點 = 大增;排後 5% 而且 ≤ −2 = 大減。同一檔 20 個交易日內只算第一次。
// 對手:同一天所有「可以比」的股票的平均(陷阱 #50:對照組一律同一天);超額 = 事件那一檔 − 那天平均。
//
// 跑法:SHARE_DIR=<stock_deep/share> D16=<d16> node scripts/fi_hold_probe.mjs [out.json]
//       node scripts/fi_hold_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { mean, r2, rng } from './lib_crash.mjs';

// ⭐ 事先登記的判定(EXP 寫死;⛔ 跑完再改)
export const RULE = { lag: 20, h: 20, liq: 5e7, liqMin: 15, pct: 5, minAbs: 2, dedup: 20, minDay: 200, minN: 300, effect: 1.0, years: 10, yrMin: 10, p: 0.025, sims: 200, split: '2018-01-01' };
export const JUDGED = [{ id: 'up', dir: 1, zh: '外資持股比 20 天大增(當天前 5% 而且 ≥ +2 個百分點)→ 之後 20 天贏同一天平均' },
                       { id: 'dn', dir: -1, zh: '外資持股比 20 天大減(當天後 5% 而且 ≤ −2 個百分點)→ 之後 20 天輸同一天平均' }];

const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const qtile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))]; };

/** 面板:cal(交易日)、每檔 { c 收盤, amt 成交金額, fr 持股比 }(對齊 cal,沒有 = NaN) */
export function panel(cal, stocks) {
    const at = new Map(cal.map((d, i) => [d, i])), N = cal.length, P = [];
    for (const s of stocks) {
        const c = new Float64Array(N).fill(NaN), amt = new Float64Array(N).fill(NaN), fr = new Float64Array(N).fill(NaN);
        for (const r of s.px) { const i = at.get(r.d); if (i == null || !(r.c > 0)) continue; c[i] = r.c; amt[i] = r.c * (r.v > 0 ? r.v : 0); }
        for (const [d, x] of s.fr) { const i = at.get(d); if (i != null && Number.isFinite(x)) fr[i] = x; }
        P.push({ sym: s.sym, c, amt, fr });
    }
    return P;
}

/** 每一天:可以比的股票、那天之後 h 天平均報酬、ΔFR 前 / 後 5% 門檻 → 事件 */
export function scan(cal, P, o = {}) {
    const lag = o.lag ?? RULE.lag, h = o.h ?? RULE.h, N = cal.length, ev = { up: [], dn: [] }, dayMean = new Float64Array(N).fill(NaN), lastUp = new Map(), lastDn = new Map();
    const elig = [];   // 每一天的 [k, dfr, f]
    for (let t = lag; t + 1 + h < N; t++) {
        const rows = [];
        for (let k = 0; k < P.length; k++) {
            const s = P[k];
            const a = s.fr[t], b = s.fr[t - lag], c0 = s.c[t + 1], c1 = s.c[t + 1 + h];
            if (!Number.isFinite(a) || !Number.isFinite(b) || !(c0 > 0) || !(c1 > 0)) continue;
            let sum = 0, n = 0; for (let j = t - 19; j <= t; j++) { const x = s.amt[j]; if (Number.isFinite(x)) { sum += x; n++; } }
            if (n < RULE.liqMin || sum / n < RULE.liq) continue;
            rows.push([k, a - b, (c1 / c0 - 1) * 100]);
        }
        if (rows.length < RULE.minDay) continue;
        const m = mean(rows.map(r => r[2])); dayMean[t] = m;
        const ds = rows.map(r => r[1]), hi = qtile(ds, 1 - RULE.pct / 100), lo = qtile(ds, RULE.pct / 100);
        for (const [k, d, f] of rows) {
            if (d >= hi && d >= RULE.minAbs && t - (lastUp.get(k) ?? -1e9) >= RULE.dedup) { ev.up.push({ k, t, d: r2(d), x: f - m }); lastUp.set(k, t); }
            if (d <= lo && d <= -RULE.minAbs && t - (lastDn.get(k) ?? -1e9) >= RULE.dedup) { ev.dn.push({ k, t, d: r2(d), x: f - m }); lastDn.set(k, t); }
        }
        elig.push([t, rows]);
    }
    return { ev, dayMean, elig };
}

/** 安慰劑:每一筆事件換成「同一檔、往前或往後 40~120 個交易日、那天也可以比」的日子,重算平均超額 */
export function placebo(S, evs, obs, dir, o = {}) {
    const sims = o.sims ?? RULE.sims, R = rng(o.seed ?? 21);
    const byDay = new Map(S.elig.map(([t, rows]) => [t, new Map(rows.map(r => [r[0], r[2] - S.dayMean[t]]))]));
    let ge = 0, n = 0;
    for (let s = 0; s < sims; s++) {
        const xs = [];
        for (const e of evs) {
            for (let tries = 0; tries < 6; tries++) {
                const off = (40 + Math.floor(R() * 81)) * (R() < 0.5 ? -1 : 1), m = byDay.get(e.t + off);
                const x = m && m.get(e.k); if (x != null) { xs.push(x); break; }
            }
        }
        if (xs.length < evs.length * 0.5) continue;
        n++; if (mean(xs) * dir >= obs * dir) ge++;
    }
    return n ? (ge + 1) / (n + 1) : null;
}

/** ⭐ 事先登記的判定:n ≥ 300・平均超額 ≥ 1 個百分點(照方向)・中位數同方向・兩段同方向・≥ 10 年同方向(那年 ≥ 10 筆才算)・安慰劑 p < 0.025 */
export function judge(cal, S, evs, dir, o = {}) {
    const xs = evs.map(e => e.x), avg = xs.length ? mean(xs) : null, med = xs.length ? qtile(xs, 0.5) : null;
    const A = evs.filter(e => cal[e.t] < RULE.split).map(e => e.x), B = evs.filter(e => cal[e.t] >= RULE.split).map(e => e.x);
    const yr = {}; for (const e of evs) (yr[cal[e.t].slice(0, 4)] ||= []).push(e.x);
    const yrs = Object.entries(yr).filter(([, a]) => a.length >= RULE.yrMin).map(([y, a]) => [y, r2(mean(a))]);
    const same = yrs.filter(([, m]) => m * dir > 0).length;
    const p = avg == null ? null : placebo(S, evs, avg, dir, o);
    const c0 = xs.length >= RULE.minN, c1 = avg != null && avg * dir >= RULE.effect && med * dir > 0;
    const c2 = A.length > 0 && B.length > 0 && mean(A) * dir > 0 && mean(B) * dir > 0, c3 = same >= RULE.years, c4 = p != null && p < RULE.p;
    const pass = [c0, c1, c2, c3, c4];
    return { n: xs.length, avg: r2(avg), med: r2(med), a: A.length ? r2(mean(A)) : null, b: B.length ? r2(mean(B)) : null, years: yrs, same, yrN: yrs.length, p: r2(p), pass,
             verdict: pass.every(Boolean) ? '✅ 照假設的方向走' : '⛔ 沒有(或說不準)' };
}

export function run(cal, P, log = console.log) {
    const S = scan(cal, P), out = { from: cal[0], to: cal.at(-1), stocks: P.length, days: S.elig.length, judged: {}, desc: {} };
    log(`🏦 ${P.length} 檔・可以比的日子 ${S.elig.length} 天(${cal[0]} ~ ${cal.at(-1)})・每天平均 ${Math.round(mean(S.elig.map(e => e[1].length)))} 檔`);
    for (const J of JUDGED) {
        const evs = S.ev[J.id], R = judge(cal, S, evs, J.dir);
        out.judged[J.id] = { ...R, dRange: evs.length ? [r2(qtile(evs.map(e => e.d), 0.1)), r2(qtile(evs.map(e => e.d), 0.9))] : null };
        log(`  ⭐ ${J.zh}:${R.n} 次・平均超額 ${R.avg}%・中位 ${R.med}%・~2017 ${R.a} / 2018~ ${R.b}・同方向 ${R.same}/${R.yrN} 年・p ${R.p}`);
        log(`      → ${R.pass.map(x => x ? '✓' : '✗').join('')} ${R.verdict}`);
    }
    // 只描述:60 天(同一批事件,⛔ 拿來判)
    const S60 = scan(cal, P, { h: 60 });
    for (const J of JUDGED) { const xs = S60.ev[J.id].map(e => e.x); out.desc[J.id + '_h60'] = { n: xs.length, avg: xs.length ? r2(mean(xs)) : null }; log(`  ・${J.id} 60 天:${xs.length} 次・平均超額 ${out.desc[J.id + '_h60'].avg}%`); }
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // 合成面板:300 檔 × 3,200 天(2010~2022,跨過 2018 才分得出兩段);持股比平常小幅亂動,每檔隨機幾次 20 天內大增 6 個百分點;
    //   埋或不埋「大增那一段開始之後 10~50 天多漲」(事件多半落在大增那一段中間)
    const N = 3200, cal = []; for (let t = Date.UTC(2010, 0, 4); cal.length < N; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) cal.push(new Date(t).toISOString().slice(0, 10)); }
    const mk = plant => {
        const Rs = rng(31), R = rng(17), stocks = [];
        for (let s = 0; s < 300; s++) {
            const jump = new Array(N).fill(0), boost = new Array(N).fill(0);
            for (let t0 = 60 + Math.floor(Rs() * 200); t0 < N - 80; t0 += 150 + Math.floor(Rs() * 250)) { for (let k = 0; k < 20; k++) jump[t0 + k] = 0.3; for (let k = t0 + 10; k <= t0 + 50 && k < N; k++) boost[k] = 0.002; }
            let c = 50, fr = 20; const px = [], fra = [];
            for (let t = 0; t < N; t++) {
                fr += jump[t] + (R() - 0.5) * 0.1; c *= 1 + (R() - 0.5) * 0.03 + (plant ? boost[t] : 0);
                px.push({ d: cal[t], c, v: 3e6 }); fra.push([cal[t], fr]);
            }
            stocks.push({ sym: String(1000 + s), px, fr: fra });
        }
        return panel(cal, stocks);
    };
    const PW = mk(true), PZ = mk(false), SW = scan(cal, PW);
    ok('① 事件 = 持股比 20 天 ≥ +2 個百分點而且當天前 5%、同一檔 20 天內只算第一次', SW.ev.up.length >= 300 && SW.ev.up.every(e => e.d >= 2) && (() => { const m = new Map(); return SW.ev.up.every(e => { const ok2 = e.t - (m.get(e.k) ?? -1e9) >= 20; m.set(e.k, e.t); return ok2; }); })(), SW.ev.up.length);
    const PW2 = PW.map(s => ({ ...s, fr: s.fr.map((x, t) => t > 2400 ? x + 50 : x) })), SW2 = scan(cal, PW2);
    const key = e => `${e.k}@${e.t}`, early = a => a.filter(e => e.t < 2350).map(key).join();
    ok('② ⛔ 前視:改掉第 2,400 天之後的持股比,之前的事件一個都不變', early(SW2.ev.up) === early(SW.ev.up));
    const jW = judge(cal, SW, SW.ev.up, 1, { sims: 60 }), jZ = judge(cal, scan(cal, PZ), scan(cal, PZ).ev.up, 1, { sims: 60 });
    ok('③ 埋了「大增之後 20 天多漲」→ ✅', jW.verdict.startsWith('✅'), JSON.stringify({ n: jW.n, avg: jW.avg, med: jW.med, a: jW.a, b: jW.b, same: jW.same, yrN: jW.yrN, p: jW.p }));
    ok('③ 決定性對照:同一份持股比、價格沒埋 → ⛔', jZ.verdict.startsWith('⛔'), JSON.stringify({ avg: jZ.avg, p: jZ.p }));
    ok('④ 方向寫反(假設會輸)→ ⛔', judge(cal, SW, SW.ev.up, -1, { sims: 20 }).verdict.startsWith('⛔'));
    // ⑤ 成交金額太小(近 20 天平均 < 5,000 萬)→ 不算
    const thin = panel(cal.slice(0, 80), [{ sym: '9999', px: cal.slice(0, 80).map(d => ({ d, c: 10, v: 1000 })), fr: cal.slice(0, 80).map((d, i) => [d, i]) }]);
    ok('⑤ 成交金額太小 → 那一檔不算(也湊不到每天 200 檔 → 沒有可以比的日子)', scan(cal.slice(0, 80), thin).elig.length === 0);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ FI_HOLD_SELFTEST_PASS');
    return bad ? 1 : 0;
}

function readJ(p) { const b = fs.readFileSync(p); return JSON.parse(p.endsWith('.gz') ? zlib.gunzipSync(b).toString('utf8') : b.toString('utf8')); }

if (process.argv[1] && process.argv[1].endsWith('fi_hold_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const SD = process.env.SHARE_DIR, D16 = process.env.D16;
    if (!SD || !D16) throw new Error('SHARE_DIR / D16 沒給');
    const tw = readJ(path.join(D16, '^TWII.json')), cal = (Array.isArray(tw) ? tw : tw.data).map(r => d10(r.date)).filter(Boolean).sort();
    const stocks = []; let miss = 0, empty = 0, noRatio = 0;
    for (const f of fs.readdirSync(SD).filter(f => /^\d+\.json(\.gz)?$/.test(f) && !/^00/.test(f))) {
        const sym = f.replace(/\.json(\.gz)?$/, ''), pf = path.join(D16, sym + '.json');
        if (!fs.existsSync(pf)) { miss++; continue; }
        const sh = readJ(path.join(SD, f)), ci = (sh.c || []).indexOf('ForeignInvestmentSharesRatio');
        if (ci < 0) { if ((sh.d || []).length) noRatio++; else empty++; continue; }   // 空檔 / 有日期卻沒有持股比那一欄(實測 413 + 12 檔)→ 記下來、不算
        let px = readJ(pf); px = Array.isArray(px) ? px : px.data;
        stocks.push({ sym, px: px.map(r => ({ d: d10(r.date), c: +r.close, v: +r.volume })), fr: sh.d.map((d, i) => [d10(d), +sh.v[i][ci]]) });
    }
    console.log(`📂 持股比 ${stocks.length} 檔(空檔 ${empty}・沒有持股比那一欄 ${noRatio}・d16 找不到 K 線 ${miss} 檔)`);
    const out = run(cal, panel(cal, stocks));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
