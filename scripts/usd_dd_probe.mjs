// 💵 usd_dd_probe.mjs —— 用美元算台股跌很深、台幣開始升值之後,台股比較會漲嗎?(「App 加上人性」第 7 期第 4 題,EXP 事先登記)
//
// 為什麼要測:外資是用美元算帳的 —— 同一段下跌,台幣一起貶的話外資虧得更多;常聽到「外資用美元算已經跌很深,
//   台幣一轉升就代表錢回來了」。這支回答:那個時間點之後,台股有沒有比「同樣用美元算跌很深的隨便一天」好。
//
// 資料:加權 2000 起(lib_crash.loadIndex)+ 美國聯準會 DEXTAUS(美元兌台幣,紐約中午;fred_hist.json series.usdtwd)
// 時間點(⛔ 前視):台股第 i 天收盤時看得到的匯率 = 日期比第 i 天早的最後一筆紐約中午匯率(同一天的紐約中午在台股收盤之後);
//   用美元算的加權 U[i] = 加權收盤 ÷ 那個匯率;事件那天看得到的都在收盤前,成績一律從「隔一個交易日收盤」起算(保守)。
// 段落:U 比近 250 天最高低 ≥ DD%(預設 20)開始、回到離最高 END%(預設 10)以內結束(= lib_crash.corrLegs,只換門檻)。
// 事件:段落裡第一次出現「台幣 20 個交易日升值 ≥ TW%(預設 1)」那天(每一段只算一次)。
// 對手:同樣在段落裡的隨便一天(lib_crash.evVsCorr:從段落日子抽一樣多次 2000 次)。
//
// 跑法:IDX_LONG IDX_EARLY TWII_NOW FRED_HIST node scripts/usd_dd_probe.mjs [out.json]
//       node scripts/usd_dd_probe.mjs --selftest
import fs from 'fs';
import { loadIndex, corrLegs, firstPerLeg, evVsCorr, mean, r2, rng } from './lib_crash.mjs';

// ⭐ 事先登記的判定(EXP 寫死;⛔ 跑完再改)
export const RULE = { DD: 20, END: 10, TW: 1, TWN: 20, h: 120, minN: 8, effect: 5, p: 0.05 };
export const DESC = [{ id: 'dd15', DD: 15, TW: 1, zh: '用美元算跌 ≥15%' }, { id: 'dd25', DD: 25, TW: 1, zh: '用美元算跌 ≥25%' },
                     { id: 'tw2', DD: 20, TW: 2, zh: '台幣 20 天升值 ≥2%' }, { id: 'any', DD: 20, TW: null, zh: '段落裡第一天(不管台幣)' }];

/** fred_hist.json → { d, v }(由舊到新、只留正數) */
export function loadFx(j, key = 'usdtwd') {
    const d = j && j.series && j.series[key] && j.series[key].d;
    if (!d || typeof d !== 'object') throw new Error(`fred_hist.json 沒有 series.${key}.d`);
    const ks = Object.keys(d).filter(k => +d[k] > 0).sort();
    return { d: ks, v: ks.map(k => +d[k]) };
}

/** 台股每一天收盤時看得到的匯率:日期比那天早的最後一筆(⛔ 同一天) */
export function fxPrev(Sd, F) {
    const out = new Array(Sd.length).fill(null); let j = -1;
    for (let i = 0; i < Sd.length; i++) {
        while (j + 1 < F.d.length && F.d[j + 1] < Sd[i]) j++;
        out[i] = j >= 0 ? F.v[j] : null;
    }
    return out;
}

/** 從第一個有匯率的日子起切一段:S2 = { d, c(台幣加權), u(美元加權), fx } */
export function usdSeries(S, F) {
    const fx = fxPrev(S.d, F), k0 = fx.findIndex(x => x != null);
    if (k0 < 0) throw new Error('匯率跟加權沒有重疊');
    const d = S.d.slice(k0), c = S.c.slice(k0), f = fx.slice(k0);
    return { d, c, fx: f, u: c.map((x, i) => x / f[i]) };
}

/** 事件(第幾天):段落裡第一次台幣 TWN 天升值 ≥ TW%;TW = null → 段落第一天 */
export function events(S2, CL, TW = RULE.TW, TWN = RULE.TWN) {
    const ev = [];
    for (let i = TWN; i < S2.u.length; i++) {
        if (CL.corr[i] < 0) continue;
        if (TW == null) { ev.push(i); continue; }
        const ch = (S2.fx[i] / S2.fx[i - TWN] - 1) * 100;      // 美元兌台幣變化:負的 = 台幣升值
        if (ch <= -TW) ev.push(i);
    }
    return firstPerLeg(ev, CL.corr);
}

/** ⭐ 事先登記的判定:≥8 次・120 天比段落隨便一天多 ≥5pp・抽樣 p < 0.05・前後兩半都比較好 */
export function judge(R) {
    const x = R.h[RULE.h] || {};
    const c1 = (x.n || 0) >= RULE.minN, c2 = x.diff != null && x.diff >= RULE.effect, c3 = x.p != null && x.p < RULE.p, c4 = x.h1 != null && x.h2 != null && x.h1 > 0 && x.h2 > 0;
    return { pass: [c1, c2, c3, c4], verdict: c1 && c2 && c3 && c4 ? '✅ 台幣轉升之後比較好' : '⛔ 沒有比較好(或樣本不夠)' };
}

export function runOne(S2, o) {
    const CL = corrLegs(S2.u, 250, o.DD, RULE.END);
    const ev0 = events(S2, CL, o.TW), ev = ev0.map(i => i + 1).filter(i => i < S2.c.length);   // 隔一個交易日收盤才算
    const R = evVsCorr({ d: S2.d, c: S2.c }, S2.c, CL, ev, [60, RULE.h], 7, 2000, 250);
    return { ...R, legsAll: CL.legs.length, sig: ev0.map(i => S2.d[i]) };
}

export function run(S, F, log = console.log) {
    const S2 = usdSeries(S, F), out = { from: S2.d[0], to: S2.d.at(-1), judged: null, desc: {} };
    log(`💵 用美元算的加權 ${S2.d[0]} ~ ${S2.d.at(-1)}(匯率:美國聯準會 DEXTAUS,用比台股那天早的最後一筆)`);
    const show = (zh, R) => {
        const a = R.h[60] || {}, b = R.h[RULE.h] || {};
        log(`  ${zh}:${R.n} 次(${R.legsAll} 段)・60 天 ${a.ev}% vs ${a.base}% → ${a.diff}pp・${RULE.h} 天 ${b.ev}% vs ${b.base}% → ${b.diff}pp(p ${b.p}・前半 ${b.h1} / 後半 ${b.h2})`);
        log(`    之後 60 天內再跌 5% 以上 ${R.deeper}%(段落隨便一天 ${R.deeperBase}%)・訊號日:${R.sig.join('、')}`);
    };
    const J = runOne(S2, { DD: RULE.DD, TW: RULE.TW });
    out.judged = { ...J, ...judge(J) };
    log(`⭐ 判的那一個(用美元算跌 ≥${RULE.DD}% 的段落裡,台幣 ${RULE.TWN} 天第一次升值 ≥${RULE.TW}%,隔天收盤起算):`);
    show('事件', J);
    log(`  → ${out.judged.pass.map(x => x ? '✓' : '✗').join('')} ${out.judged.verdict}`);
    log('・只描述:');
    for (const E of DESC) { const R = runOne(S2, E); out.desc[E.id] = R; show(E.zh, R); }
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // ① 看得到的匯率:比那天早的最後一筆(同一天 ⛔)
    const fp = fxPrev(['2024-01-02', '2024-01-03', '2024-01-05'], { d: ['2024-01-02', '2024-01-04'], v: [30, 31] });
    ok('① 同一天的紐約匯率 ⛔ 用;1/3 看得到 1/2 的、1/5 看得到 1/4 的', fp[0] == null && fp[1] === 30 && fp[2] === 31, JSON.stringify(fp));
    // 合成世界:5,400 個交易日;每 600 天一次「美元算跌 30%」的大段落(台幣也貶),段落中途台幣轉升
    const days = []; for (let t = Date.UTC(2003, 0, 1); days.length < 5400; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) days.push(new Date(t).toISOString().slice(0, 10)); }
    const mk = (plant, seed = 3) => {
        const R = rng(seed), c = [100], fx = [30];
        for (let i = 1; i < days.length; i++) {
            const ph = i % 600; let r = (R() - 0.5) * 0.02, f = 1 + (R() - 0.5) * 0.002;
            if (ph >= 300 && ph < 360) { r -= 0.006; f += 0.0012; }            // 段落:股跌、台幣貶
            if (ph >= 360 && ph < 380) { f -= 0.0015; }                        // 台幣轉升
            if (plant && ph >= 381 && ph < 501) r += 0.0025;                   // 埋:台幣轉升之後 120 天多漲
            c.push(c[i - 1] * (1 + r)); fx.push(fx[i - 1] * f);
        }
        return { S: { d: days, c }, F: { d: days.map(x => x), v: fx } };
    };
    const P = mk(true), Z = mk(false);
    const S2 = usdSeries(P.S, P.F);
    ok('② 用美元算 = 台幣加權 ÷ 前一天的匯率(第一天沒有匯率 → 切掉)', S2.d[0] === days[1] && Math.abs(S2.u[5] - P.S.c[6] / P.F.v[5]) < 1e-9, S2.d[0]);
    const CL = corrLegs(S2.u, 250, RULE.DD, RULE.END), ev = events(S2, CL);
    ok('③ 每一段只算一次、事件都在段落裡', ev.length >= 3 && new Set(ev.map(i => CL.corr[i])).size === ev.length && ev.every(i => CL.corr[i] >= 0), ev.length);
    const S2b = usdSeries({ d: P.S.d, c: P.S.c.map((x, i) => i > 2500 ? x * 1.5 : x) }, { d: P.F.d, v: P.F.v.map((x, i) => i > 2500 ? x * 0.7 : x) });
    const CLb = corrLegs(S2b.u, 250, RULE.DD, RULE.END), evb = events(S2b, CLb).filter(i => i < 2400);
    ok('④ ⛔ 前視:改掉第 2,500 天之後的價格與匯率,之前的事件一個都不變', JSON.stringify(evb) === JSON.stringify(ev.filter(i => i < 2400)));
    const jP = judge(runOne(S2, { DD: RULE.DD, TW: RULE.TW })), jZ = judge(runOne(usdSeries(Z.S, Z.F), { DD: RULE.DD, TW: RULE.TW }));
    ok('⑤ 埋了「台幣轉升之後多漲」→ ✅(四條都過)', jP.verdict.startsWith('✅') && jP.pass.every(Boolean), JSON.stringify(jP));
    ok('⑤ 決定性對照:同一份價格沒埋 → ⛔', jZ.verdict.startsWith('⛔'), JSON.stringify(jZ));
    ok('⑥ 少於 8 次 → 判樣本不夠(⛔ 硬判)', !judge({ h: { 120: { n: 5, diff: 20, p: 0.001, h1: 10, h2: 10 } } }).pass[0]);
    let threw = false; try { loadFx({ series: {} }); } catch (_) { threw = true; }
    ok('⑥ 沒有 series.usdtwd → 丟例外(⛔ 當成沒事件)', threw);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ USD_DD_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('usd_dd_probe.mjs')) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const S = loadIndex(process.env);
    if (!process.env.FRED_HIST) throw new Error('FRED_HIST 沒給');
    const F = loadFx(JSON.parse(fs.readFileSync(process.env.FRED_HIST, 'utf8')));
    const out = run(S, F);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
