// 🇺🇸 adr_premium_probe.mjs —— 台積電 ADR 溢價到極端之後,台積電接下來 20 天比較會贏(或輸)大盤嗎?(「App 加上人性」第 7 期第 3 題,EXP 事先登記)
//
// 為什麼要測:人性頁外資座位有「台積電 ADR 溢價」那一格;常聽說「ADR 溢價很高 = 外資很想要台積電,現股會跟上」、
//   「ADR 折價 = 外資不要了」。這支回答:溢價到過去一年的極端之後,2330 接下來 20 個交易日有沒有比加權好(或差)。
//
// 資料:美股日線 us_hist.json 的 TSM(⚠️ adj:true = 已還原除息)× 美國聯準會 DEXTAUS(紐約中午)÷ 5 ÷ 2330 收盤
//   ⭐ 2330 用同一種方式還原除息(_div16.json 的 [除息日, 現金, 類型, 前收, 參考價]:除息日之前的收盤 × 參考價 ÷ 前收)
//   —— ⛔ 一邊還原一邊沒還原,溢價會跟著配息一年一年漂(陷阱 #49 同一把尺)。
// 時間點(⛔ 前視):美國 t 那天收盤(台北 t+1 清晨)才看得到 → 配「台股 ≤ t 最後一天」的 2330 收盤與「≤ t 最後一筆」匯率;
//   台股看得到的那天 r = 日期比 t 晚的第一個台股交易日;結果一律從 r 收盤起算(r 開盤那一下的跳空只描述)。
// 極端:t 的溢價比之前 250 個美股交易日(⛔ 含 t)的第 95 百分位高 / 第 5 百分位低(滾動一年,溢價水準這些年一直在變);
//   20 個台股交易日內只算第一次。
// 結果:2330(還原)之後 20 個台股交易日報酬 − 加權同期報酬(超額);對手 = 同一段期間的非事件日平均(股利那一點偏差兩邊一樣)。
//
// 跑法:US_HIST FRED_HIST TW2330=<d16/2330.json> DIV16=<d16/_div16.json> IDX_LONG IDX_EARLY TWII_NOW node scripts/adr_premium_probe.mjs [out.json]
//       node scripts/adr_premium_probe.mjs --selftest
import fs from 'fs';
import { loadIndex, mean, r2, rng } from './lib_crash.mjs';

// ⭐ 事先登記的判定(EXP 寫死;⛔ 跑完再改)
export const RULE = { win: 250, dedup: 20, h: 20, minN: 20, effect: 1.5, effectNoTop: 1.0, p: 0.025, sims: 300, split: '2018-01-01' };
export const JUDGED = [{ id: 'hi', side: 'hi', pct: 95, dir: 1, zh: '溢價到過去一年第 95 百分位以上 → 2330 接下來 20 天贏加權' },
                       { id: 'lo', side: 'lo', pct: 5, dir: -1, zh: '溢價到過去一年第 5 百分位以下 → 2330 接下來 20 天輸加權' }];
export const DESC = [{ id: 'hi90', side: 'hi', pct: 90, dir: 1, zh: '第 90 百分位以上' }, { id: 'lo10', side: 'lo', pct: 10, dir: -1, zh: '第 10 百分位以下' },
                     { id: 'hi_h60', side: 'hi', pct: 95, dir: 1, h: 60, zh: '第 95 百分位以上・60 天' }, { id: 'lo_h60', side: 'lo', pct: 5, dir: -1, h: 60, zh: '第 5 百分位以下・60 天' }];

const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
/** 最後一個 ≤ t 的索引(二分) */
export function lastLE(ds, t) { let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] <= t) lo = m + 1; else hi = m; } return lo - 1; }

/** 2330 還原除息:除息日之前的收盤 × 參考價 ÷ 前收(往前累乘) */
export function adjust(T, divs) {
    const f = new Array(T.d.length).fill(1);
    for (const [d, , , prev, ref] of divs || []) {
        if (!(prev > 0) || !(ref > 0) || ref >= prev * 1.0001) continue;
        const k = lastLE(T.d, d10(d)), at = T.d[k] === d10(d) ? k : k + 1;   // 除息日那根(⛔ 含)以前的收盤要乘
        for (let i = 0; i < at && i < f.length; i++) f[i] *= ref / prev;
    }
    return { d: T.d, c: T.c.map((x, i) => x * f[i]), o: (T.o || T.c).map((x, i) => x * f[i]) };
}

/** 溢價序列(美股日):{ t, p(%), r = 台股看得到的那天(加權的索引) } */
export function premium(US, FX, T, S) {
    const out = [];
    for (let i = 0; i < US.d.length; i++) {
        const t = US.d[i], k = lastLE(T.d, t), j = lastLE(FX.d, t);
        if (k < 0 || j < 0 || !(US.c[i] > 0) || !(T.c[k] > 0)) continue;
        const r = lastLE(S.d, t) + 1;
        out.push({ t, p: (US.c[i] * FX.v[j] / 5 / T.c[k] - 1) * 100, r: r < S.d.length ? r : -1 });
    }
    return out;
}

/** 滾動百分位:第 i 筆比之前 win 筆(⛔ 含自己)幾 % 高;同分算一半;不到 win 筆 → null */
export function rollPct(v, win = RULE.win) {
    return v.map((x, i) => {
        if (i < win) return null;
        let lt = 0, eq = 0; for (let k = i - win; k < i; k++) { if (v[k] < x) lt++; else if (v[k] === x) eq++; }
        return (lt + eq / 2) / win * 100;
    });
}

/** 事件(加權索引 r),dedup 個台股交易日內只算第一次 */
export function events(P, o) {
    const pc = rollPct(P.map(x => x.p)), out = []; let last = -1e9;
    for (let i = 0; i < P.length; i++) {
        if (pc[i] == null || P[i].r < 0) continue;
        if (!(o.side === 'hi' ? pc[i] >= o.pct : pc[i] <= o.pct)) continue;
        if (P[i].r - last < RULE.dedup) continue;
        out.push({ r: P[i].r, t: P[i].t, p: r2(P[i].p), pct: r2(pc[i]) }); last = P[i].r;
    }
    return out;
}

/** 超額:2330 從 r 收盤起 h 天(還原)− 加權同期;align = 加權日期 → 2330 索引 */
export function excessAt(S, A, at, r, h) {
    if (r < 0 || r + h >= S.c.length) return null;
    const a0 = at.get(S.d[r]), a1 = at.get(S.d[r + h]);
    if (a0 == null || a1 == null) return null;
    return ((A.c[a1] / A.c[a0]) - (S.c[r + h] / S.c[r])) * 100;
}

/** 事件 − 同一段非事件日平均(from / to 只算那一段;skipY 拿掉那一年的事件) */
export function delta(S, A, at, evs, o = {}) {
    const h = o.h ?? RULE.h, from = o.from || '0000', to = o.to || '9999', first = o.first ?? 0;
    const ev = new Set(evs.map(e => e.r)), base = [];
    for (let i = first; i < S.c.length; i++) { if (ev.has(i) || S.d[i] < from || S.d[i] >= to) continue; const x = excessAt(S, A, at, i, h); if (x != null) base.push(x); }
    const xs = evs.filter(e => S.d[e.r] >= from && S.d[e.r] < to && !(o.skipY && S.d[e.r].slice(0, 4) === o.skipY)).map(e => excessAt(S, A, at, e.r, h)).filter(x => x != null);
    if (!xs.length || !base.length) return { n: xs.length, diff: null };
    return { n: xs.length, ev: r2(mean(xs)), base: r2(mean(base)), diff: r2(mean(xs) - mean(base)) };
}

/** 安慰劑:事件那幾天整串在台股日上循環平移(只在有溢價的那一段裡),p = 平移後「同方向一樣大或更大」的比例 */
export function placebo(S, A, at, evs, obs, dir, o = {}) {
    const sims = o.sims ?? RULE.sims, R = rng(o.seed ?? 9), first = o.first ?? 0, L = S.c.length - first; let ge = 0, n = 0;
    for (let s = 0; s < sims; s++) {
        const off = 260 + Math.floor(R() * (L - 520));
        const sh = evs.map(e => ({ r: first + ((e.r - first + off) % L) }));
        const d = delta(S, A, at, sh, o).diff; if (d == null) continue;
        n++; if (d * dir >= obs * dir) ge++;
    }
    return n ? (ge + 1) / (n + 1) : null;
}

export function topYear(S, evs) {
    const c = {}; for (const e of evs) { const y = S.d[e.r].slice(0, 4); c[y] = (c[y] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

/** ⭐ 事先登記的判定:n ≥ 20・差 ≥ 1.5pp(照假設的方向)・兩段同方向・安慰劑 p < 0.025・拿掉事件最多那年仍 ≥ 1pp */
export function judge(S, A, at, evs, dir, o = {}) {
    const all = delta(S, A, at, evs, o), a = delta(S, A, at, evs, { ...o, to: RULE.split }), b = delta(S, A, at, evs, { ...o, from: RULE.split });
    const ty = topYear(S, evs), noTop = delta(S, A, at, evs, { ...o, skipY: ty });
    const p = all.diff == null ? null : placebo(S, A, at, evs, all.diff, dir, o);
    const c0 = all.n >= RULE.minN, c1 = all.diff != null && all.diff * dir >= RULE.effect;
    const c2 = a.diff != null && b.diff != null && a.diff * dir > 0 && b.diff * dir > 0;
    const c3 = p != null && p < RULE.p, c4 = noTop.diff != null && noTop.diff * dir >= RULE.effectNoTop;
    const pass = [c0, c1, c2, c3, c4];
    return { all, a, b, topYear: ty, noTop, p: r2(p), pass, verdict: pass.every(Boolean) ? '✅ 照假設的方向走' : '⛔ 沒有(或說不準)' };
}

export function run(US, FX, T0, divs, S, log = console.log) {
    const T = adjust(T0, divs), P = premium(US, FX, T, S), at = new Map(T.d.map((d, i) => [d, i]));
    const first = P.length > RULE.win ? P[RULE.win].r : 0, o = { first };
    const out = { from: P[0] && P[0].t, to: P.at(-1) && P.at(-1).t, n: P.length, last: P.at(-1), judged: {}, desc: {} };
    log(`🇺🇸 溢價 ${out.from} ~ ${out.to}(${P.length} 個美股日)・最後一筆 ${out.last && out.last.t} ${out.last && r2(out.last.p)}%`);
    const yr = {}; for (const x of P) { const y = x.t.slice(0, 4); (yr[y] ||= []).push(x.p); }
    log('  每年溢價中位數:' + Object.entries(yr).map(([y, a]) => `${y} ${r2([...a].sort((p, q) => p - q)[a.length >> 1])}%`).join('・'));
    const one = (E, isJ) => {
        const ev = events(P, E), oo = { ...o, h: E.h || RULE.h };
        const J = judge(S, T, at, ev, E.dir, oo), gaps = ev.filter(e => e.r > 0).map(e => (S.c[e.r] / S.c[e.r - 1] - 1) * 100);
        const R = { ...J, n: ev.length, dates: ev.map(e => e.t), gapTw: r2(mean(gaps)) };
        log(`  ${isJ ? '⭐' : '・'} ${E.zh}:${ev.length} 次・2330 超額 ${J.all.ev}% vs 平常 ${J.all.base}% → ${J.all.diff}pp・~2017 ${J.a.diff} / 2018~ ${J.b.diff}・拿掉 ${J.topYear} ${J.noTop.diff}・p ${J.p}・看得到那天加權平均 ${R.gapTw}%`);
        if (isJ) log(`      → ${J.pass.map(x => x ? '✓' : '✗').join('')} ${J.verdict}`);
        return R;
    };
    log('⭐ 判的兩個(各自五條;安慰劑 p < 0.025 = 兩個檢定 Bonferroni):');
    for (const E of JUDGED) out.judged[E.id] = one(E, true);
    log('・只描述(⛔ 拿來判):');
    for (const E of DESC) out.desc[E.id] = one(E, false);
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // ① 還原除息:除息日之前 × 參考價 ÷ 前收,除息日當天(含)以後不動
    const T = { d: ['2024-06-10', '2024-06-11', '2024-06-12'], c: [100, 101, 99] };
    const A = adjust(T, [['2024-06-12', 2, '權息', 101, 99]]);
    ok('① 還原除息:除息日之前的收盤 × 99 ÷ 101、除息日那天不動', Math.abs(A.c[0] - 100 * 99 / 101) < 1e-9 && Math.abs(A.c[1] - 99) < 1e-9 && A.c[2] === 99, JSON.stringify(A.c));
    // ② 時間點:美國 t 的溢價配台股 ≤ t 的收盤與 ≤ t 的匯率;看得到的那天 = 比 t 晚的第一個台股日
    const S = { d: ['2024-01-02', '2024-01-03', '2024-01-05'], c: [1, 1, 1] };
    const P = premium({ d: ['2024-01-03', '2024-01-04'], c: [110, 120] }, { d: ['2024-01-02', '2024-01-04'], v: [30, 32] }, { d: ['2024-01-02', '2024-01-03'], c: [600, 660] }, S);
    ok('② 1/3 那筆配 1/3 台股收盤 660、1/2 匯率 30;1/4(台股休市)配 1/3 收盤、1/4 匯率;看得到的那天分別是 1/5、1/5',
        Math.abs(P[0].p - (110 * 30 / 5 / 660 - 1) * 100) < 1e-9 && Math.abs(P[1].p - (120 * 32 / 5 / 660 - 1) * 100) < 1e-9 && P[0].r === 2 && P[1].r === 2, JSON.stringify(P));
    // ③ 滾動百分位 ⛔ 含自己、⛔ 看未來
    const v = Array.from({ length: 300 }, (_, i) => (i * 37) % 101), pc = rollPct(v, 250), pc2 = rollPct([...v.slice(0, 280), ...Array(20).fill(999)], 250);
    ok('③ 滾動百分位:前 250 筆 null、改掉之後的值之前的百分位一個都不變', pc[249] === null && pc[250] != null && JSON.stringify(pc.slice(0, 280)) === JSON.stringify(pc2.slice(0, 280)));
    // 合成世界:4,000 個台股日;溢價大部分在 10±3%,隨機幾十段跳到高檔;埋或不埋「之後 20 天 2330 多漲」
    const N = 4000, days = []; for (let t = Date.UTC(2010, 0, 4); days.length < N; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) days.push(new Date(t).toISOString().slice(0, 10)); }
    //   跳到很高的那一段 15 天(第一天最高 35%、之後 30~32%),間隔 90~150 天 → 每一個 250 天的窗口裡都有 6% 以上的日子在高檔 → 第 95 百分位落在高檔那一區
    const fst = new Array(N).fill(false), spike = new Array(N).fill(false), up = new Array(N).fill(false);
    { const Rs = rng(13); for (let s = 100; s < N - 40; s += 90 + Math.floor(Rs() * 60)) { fst[s] = true; for (let k = s; k < s + 15; k++) spike[k] = true; for (let k = s + 1; k <= s + 20; k++) up[k] = true; } }
    const mk = plant => {
        const R = rng(5), tw = [100], ix = [100], prem = [10];
        for (let i = 1; i < N; i++) {
            const m = (R() - 0.5) * 0.02; ix.push(ix[i - 1] * (1 + m));
            tw.push(tw[i - 1] * (1 + m + (R() - 0.5) * 0.02 + (plant && up[i] ? 0.003 : 0)));
            const u = R(); prem.push(fst[i] ? 35 : spike[i] ? 30 + u * 2 : 10 + (u - 0.5) * 6);
        }
        const fx = days.map(() => 30), us = tw.map((x, i) => x * (1 + prem[i] / 100) * 5 / 30);
        return { S: { d: days, c: ix }, T: { d: days, c: tw }, US: { d: days, c: us }, FX: { d: days, v: fx } };
    };
    const W = mk(true), Z = mk(false);
    const PW = premium(W.US, W.FX, W.T, W.S), atW = new Map(W.T.d.map((d, i) => [d, i])), evW = events(PW, JUDGED[0]);
    ok('④ 事件 = 溢價跳到 30% 的那幾天、20 天內只算第一次(看得到的那天 = 隔一個台股日)', evW.length >= 20 && evW.every(e => fst[days.indexOf(e.t)] && e.r === days.indexOf(e.t) + 1), evW.length + ' ' + JSON.stringify(evW.slice(0, 2)));
    const first = PW[RULE.win].r, jW = judge(W.S, W.T, atW, evW, 1, { first, sims: 150 });
    const PZ = premium(Z.US, Z.FX, Z.T, Z.S), jZ = judge(Z.S, Z.T, new Map(Z.T.d.map((d, i) => [d, i])), events(PZ, JUDGED[0]), 1, { first, sims: 150 });
    ok('⑤ 埋了「溢價很高之後 2330 多漲」→ ✅(五條都過)', jW.verdict.startsWith('✅') && jW.pass.every(Boolean), JSON.stringify({ d: jW.all, p: jW.p, a: jW.a.diff, b: jW.b.diff, nt: jW.noTop.diff }));
    ok('⑤ 決定性對照:同一份溢價、2330 沒埋 → ⛔', jZ.verdict.startsWith('⛔'), JSON.stringify({ d: jZ.all.diff, p: jZ.p }));
    const jWrong = judge(W.S, W.T, atW, evW, -1, { first, sims: 50 });
    ok('⑥ 方向寫反(假設會輸)→ ⛔(差是正的 ⛔ 算過)', jWrong.verdict.startsWith('⛔') && !jWrong.pass[1]);
    ok('⑦ 次數不到 20 → 判樣本不夠', !judge(W.S, W.T, atW, evW.slice(0, 6), 1, { first, sims: 20 }).pass[0]);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ ADR_PREMIUM_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('adr_premium_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    for (const k of ['US_HIST', 'FRED_HIST', 'TW2330', 'DIV16']) if (!process.env[k]) throw new Error(`${k} 沒給`);
    const uh = JSON.parse(fs.readFileSync(process.env.US_HIST, 'utf8')), ts = uh.syms && uh.syms.TSM;
    if (!ts || !Array.isArray(ts.c)) throw new Error('us_hist 沒有 TSM');
    const US = { d: [], c: [] }; uh.days.forEach((d, i) => { const x = +ts.c[i]; if (x > 0) { US.d.push(d10(d)); US.c.push(x); } });
    const fh = JSON.parse(fs.readFileSync(process.env.FRED_HIST, 'utf8')), fd = fh.series && fh.series.usdtwd && fh.series.usdtwd.d;
    if (!fd) throw new Error('fred_hist 沒有 series.usdtwd');
    const fk = Object.keys(fd).filter(k => +fd[k] > 0).sort(), FX = { d: fk, v: fk.map(k => +fd[k]) };
    let tw = JSON.parse(fs.readFileSync(process.env.TW2330, 'utf8')); tw = Array.isArray(tw) ? tw : tw.data;
    const T = { d: tw.filter(r => +r.close > 0).map(r => d10(r.date)), c: tw.filter(r => +r.close > 0).map(r => +r.close) };
    const dv = JSON.parse(fs.readFileSync(process.env.DIV16, 'utf8')), divs = ((dv.d || dv)['2330'] || {}).h || [];
    console.log(`📂 TSM ${US.d[0]} ~ ${US.d.at(-1)}(us_hist adj=${uh.adj})・DEXTAUS ${FX.d[0]} ~ ${FX.d.at(-1)}・2330 ${T.d[0]} ~ ${T.d.at(-1)}・除息 ${divs.length} 次`);
    const out = run(US, FX, T, divs, loadIndex(process.env));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
