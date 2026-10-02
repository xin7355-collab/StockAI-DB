#!/usr/bin/env node
/**
 * 🎰 選擇權 P/C 比 + 台指期大額交易人 → 隔天大盤(0050)有沒有方向(V78.2.5)
 *
 * 為什麼:當沖頁 🚦 那張卡拿這兩個數字投票 ——
 *   P/C 未平倉比 ≥115 → +0.5、≤85 → −0.5;大額交易人(全部交易人)前 10 大淨部位 >2000 口 → +1、<−2000 → −1
 *   這些權重**從來沒回測過**(陷阱 #38)。資料:`scripts/taifex_hist_miner.py` 挖回來的 data/taifex_hist.json。
 *
 * ⭐ 口徑:期交所資料是收盤後才公布 → 訊號日 d 的數字只能用在**下一個交易日 T**(零前視)
 *    ① 隔天當沖:0050 T 開盤 → T 收盤(扣 0.25%)
 *    ② 隔天收盤:d 收盤 → T 收盤(⚠️ d 收盤時還不知道數字 → 這是「描述」,⛔ 不是做得到的進場)
 * ⭐ 增量 = 訊號那天的報酬 − **同一年所有交易日**的平均(扣掉那一年的大盤漂移);做空方向的訊號把正負號翻過來
 * ⭐ 除了 🚦 寫死的門檻,另跑「自己過去 250 天的位階」前 / 後 20%(⛔ 只用過去,selftest 釘住)
 * ⭐ 六關沿用 maxim_kbar5_probe 的 gates()(同一把尺)
 *
 * 跑法:TAIFEX_HIST=$S/taifex_hist.json DATA_DIR=$S/d10n node scripts/pcr_probe.mjs [out.json]
 *       node scripts/pcr_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gates } from './maxim_kbar5_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const COST = 0.25;

/** 過去 win 天(⛔ 不含今天)裡,今天的值排在哪(0~1);樣本不足回 null */
export function pastPct(vals, i, win = 250, minN = 120) {
    const lo = Math.max(0, i - win), past = vals.slice(lo, i).filter(v => v != null);
    if (past.length < minN || vals[i] == null) return null;
    return past.filter(v => v < vals[i]).length / past.length;
}

/** series = [{d, x}](依日期排序);px = Map(date → {o, c})、pdates = 0050 交易日(排序)
 *  rules = [{name, side(+1 多 / −1 空), hit(x, pct)}] → {name: [{d, v, raw, raw2}]} */
export function events(series, px, pdates, rules) {
    const vals = series.map(s => s.x);
    const nextOf = d => { let lo = 0, hi = pdates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pdates[m] <= d) lo = m + 1; else hi = m; } return pdates[lo]; };
    const rows = [];
    for (let i = 0; i < series.length; i++) {
        const d = series[i].d, T = nextOf(d), a = px.get(d), b = T && px.get(T);
        if (!a || !b || !(b.o > 0) || !(a.c > 0)) continue;
        rows.push({ d, i, oc: (b.c / b.o - 1) * 100, cc: (b.c / a.c - 1) * 100, pct: pastPct(vals, i), x: vals[i] });
    }
    const yr = {}; rows.forEach(r => { const y = r.d.slice(0, 4); (yr[y] = yr[y] || { oc: [], cc: [] }).oc.push(r.oc); yr[y].cc.push(r.cc); });
    const ym = Object.fromEntries(Object.entries(yr).map(([y, o]) => [y, { oc: mean(o.oc), cc: mean(o.cc) }]));
    const out = {};
    for (const rule of rules) {
        out[rule.name] = rows.filter(r => r.x != null && rule.hit(r.x, r.pct)).map(r => {
            const m = ym[r.d.slice(0, 4)];
            return { d: r.d, v: rule.side * (r.oc - m.oc), raw: rule.side * r.oc - COST, v2: rule.side * (r.cc - m.cc) };
        });
    }
    return { out, n: rows.length };
}

export const PC_RULES = [
    { name: '🚦 P/C 未平倉比 ≥115 → 偏多(現在 +0.5)', side: 1, hit: x => x >= 115 },
    { name: '🚦 P/C 未平倉比 ≤85 → 偏空(現在 −0.5)', side: -1, hit: x => x <= 85 },
    { name: 'P/C 位階前 20%(過去 250 天)→ 偏多', side: 1, hit: (x, p) => p != null && p >= 0.8 },
    { name: 'P/C 位階後 20% → 偏空', side: -1, hit: (x, p) => p != null && p <= 0.2 },
];
export const LT_RULES = [
    { name: '🚦 大額交易人前 10 大淨 >+2000 口 → 偏多(現在 +1)', side: 1, hit: x => x > 2000 },
    { name: '🚦 大額交易人前 10 大淨 <−2000 口 → 偏空(現在 −1)', side: -1, hit: x => x < -2000 },
    { name: '大額淨部位位階前 20% → 偏多', side: 1, hit: (x, p) => p != null && p >= 0.8 },
    { name: '大額淨部位位階後 20% → 偏空', side: -1, hit: (x, p) => p != null && p <= 0.2 },
];

function report(title, res) {
    const rows = {};
    console.log(`\n── ${title}(可配對 ${res.n} 天)`);
    for (const [k, e] of Object.entries(res.out)) {
        if (e.length < 30) { console.log(`⏳ ${k}:${e.length} 天 → 樣本不足,⛔ 不下結論`); rows[k] = { n: e.length }; continue; }
        const g = gates(e, e.map(x => x.raw), 1);
        const cc = mean(e.map(x => x.v2));
        rows[k] = { ...g, ccInc: +cc.toFixed(3) };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} ${k} ・n=${g.n} ・隔天開→收 增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・扣成本絕對 ${g.abs}% ・收→收 增量 ${cc >= 0 ? '+' : ''}${cc.toFixed(3)}pp ・六關 ${g.pass}/6`);
        console.log(`     逐年 ${JSON.stringify(g.years)} ・沒過:${Object.entries(g.gates || {}).filter(([, v]) => !v).map(([n]) => n).join('、') || '—'}`);
    }
    return rows;
}

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    // ① 位階只看過去
    const v = Array.from({ length: 400 }, (_, i) => i % 7);
    const p1 = pastPct(v, 300); const v2 = [...v]; for (let i = 301; i < 400; i++) v2[i] = 999;
    ok('① 改掉未來的值 → 今天的位階不變(零前視)', p1 === pastPct(v2, 300));
    ok('①b 樣本不足 → null', pastPct(v, 50) === null);
    // ② 埋邊際:x ≥115 那天之後 0050 開→收 +0.6%
    let s = 11; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const D = []; const t0 = Date.UTC(2020, 0, 1);
    for (let i = 0; D.length < 900; i++) { const dt = new Date(t0 + i * 864e5); if (dt.getUTCDay() % 6) D.push(dt.toISOString().slice(0, 10)); }
    const mk = (plant) => { const series = [], px = new Map(); let c = 100;
        D.forEach((d, i) => { const x = 70 + rnd() * 70; series.push({ d, x });
            const prevHi = i > 0 && series[i - 1].x >= 115; const o = c * (1 + (rnd() - 0.5) * 0.004);
            const cl = o * (1 + (rnd() - 0.5) * 0.01 + (plant && prevHi ? 0.006 : 0)); px.set(d, { o, c: cl }); c = cl; });
        return { series, px }; };
    const A = mk(true), Ra = events(A.series, A.px, D, PC_RULES).out[PC_RULES[0].name];
    const ga = gates(Ra, Ra.map(x => x.raw), 1);
    ok('② 埋「≥115 隔天 +0.6%」→ 增量量得到(同年平均裡也含這些天,所以會被稀釋到 ~0.4)、六關 ≥5', ga.inc > 0.3 && ga.pass >= 5, JSON.stringify(ga).slice(0, 160));
    const B = mk(false), Rb = events(B.series, B.px, D, PC_RULES).out[PC_RULES[0].name];
    const gb = gates(Rb, Rb.map(x => x.raw), 1);
    ok('③ 沒埋 → |增量| < 0.15、⛔ 不可六關全過(對照組有在做事)', Math.abs(gb.inc) < 0.15 && gb.pass < 6, JSON.stringify(gb).slice(0, 160));
    // ④ 訊號日當天的報酬⛔ 不可算進來(資料收盤後才公布)
    const C = mk(false); C.series.forEach((r, i) => { if (r.x >= 115) { const p = C.px.get(r.d); C.px.set(r.d, { o: p.o, c: p.o * 1.05 }); } });
    const Rc = events(C.series, C.px, D, PC_RULES).out[PC_RULES[0].name];
    ok('④ 訊號日當天大漲 → 增量不受影響(用的是下一天)', Math.abs(mean(Rc.map(x => x.v))) < 0.15, mean(Rc.map(x => x.v)));
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ PCR_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const F = process.env.TAIFEX_HIST;
    if (!F || !fs.existsSync(F)) { console.error('❌ 要 TAIFEX_HIST=data/taifex_hist.json(git show origin/data:data/taifex_hist.json > …)'); process.exit(1); }
    const T = JSON.parse(fs.readFileSync(F, 'utf8'));
    const DD = process.env.DATA_DIR || path.join(ROOT, 'data');
    // ⭐ V78.2.7 優先讀 _bench0050.json(長歷史 2010 起、已對齊分割尺標)—— 只讀 0050.json 會從 2021 才開始,期交所 2016~2020 那 5 年白白浪費
    const bf = path.join(DD, '_bench0050.json'), useB = fs.existsSync(bf);
    let K = JSON.parse(fs.readFileSync(useB ? bf : path.join(DD, '0050.json'), 'utf8')); K = Array.isArray(K) ? K : K.data;
    console.log(`0050 來源:${useB ? '_bench0050.json(長歷史)' : '0050.json'}`);
    const px = new Map(K.map(r => [String(r.date).replace(/\//g, '-'), { o: +r.open, c: +r.close }]));
    const pdates = [...px.keys()].sort();
    console.log(`📅 期交所 ${T.from} ~ ${T.to} ・P/C ${T.n?.pc} 天 ・大額 ${T.n?.lt} 天 ・0050 ${pdates[0]} ~ ${pdates[pdates.length - 1]}`);
    const pc = Object.entries(T.pc || {}).sort().map(([d, a]) => ({ d, x: a[1] }));
    const lt = Object.entries(T.lt || {}).sort().map(([d, o]) => ({ d, x: o.all ? o.all[1] : null }));
    const out = { generated: new Date().toISOString(), src: { from: T.from, to: T.to }, pc: report('🎰 選擇權 P/C 未平倉比', events(pc, px, pdates, PC_RULES)),
        lt: report('🐋 台指期大額交易人(全部交易人前 10 大淨部位)', events(lt, px, pdates, LT_RULES)) };
    console.log('\n⭐ 判讀:🚦 那幾條沒過六關 → 不該再計分(那時改 index.html 並停掉 daytrade_pack 採礦)');
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
