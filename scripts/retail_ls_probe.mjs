#!/usr/bin/env node
/**
 * 👥 小台散戶多空比 → 隔天大盤(0050)有沒有方向(V79.0.9)
 *
 * 為什麼:App 拿這個數字計分 —— 主力出貨指數「散戶過度看多 +20 / 偏多 +10 / 極度看空 −15」、
 *   情緒卡 🚨⚠️💡、Telegram 盤前摘要 —— **從來沒回測過**(陷阱 #38)。
 *   而且 V79.0.9 之前正負號還兩套說法(test_retailsign.mjs)。
 * 資料:`scripts/taifex_hist_miner.py` 挖回來的 data/taifex_hist.json 的 `rl`
 *   rl[d] = [三大法人小台淨未平倉, 法人多+空, 小台全市場未平倉, 散戶多空比%(正 = 散戶淨多)]
 *
 * ⭐ 兩種算法都測:
 *   ① App 現行算法 = −淨 ÷ 法人多+空(macro_miner 的近似分母)→ 拿 App 的門檻 30 / 15 / −25 測
 *   ② 正式算法   = −淨 ÷ 小台全市場未平倉 → 拿「自己過去 250 天位階」前 / 後 20% 測(⛔ 只用過去)
 * ⭐ 口徑同 pcr_probe:期交所收盤後才公布 → 訊號日 d 的數字只能用在下一個交易日 T
 *    隔天開→收(扣 0.25%)= 做得到 ・收→收 / 5 日收→收 = 描述
 *    增量 = 訊號那天 − 同一年所有交易日平均;做空方向把正負號翻過來;六關 = maxim_kbar5_probe.gates()
 * ⭐ 校準:App 每天存的 risk_history.json(retail_ls_pct)vs 這裡用 ① 重算的 → 同號相關才代表正負號對
 *
 * 跑法:TAIFEX_HIST=$S/taifex_hist.json DATA_DIR=$S/d10n [RISK_HIST=$S/risk_history.json] node scripts/retail_ls_probe.mjs [out.json]
 *       node scripts/retail_ls_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gates } from './maxim_kbar5_probe.mjs';
import { pastPct } from './pcr_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const COST = 0.25;
// ⚠️ 跟 index.html _RETAIL_LS_CUT / worker.js RETAIL_LS_CUT 同一組(test_retailsign 釘那兩份)
export const CUT = { hot: 30, long: 15, panic: -25 };

/** rl → 兩條序列:app(−淨 ÷ 法人多+空)、std(−淨 ÷ 全市場未平倉) */
export function series(rl) {
    const ds = Object.keys(rl || {}).sort();
    return {
        app: ds.map(d => { const [n, ls] = rl[d]; return { d, x: ls > 0 ? -n / ls * 100 : null }; }),
        std: ds.map(d => { const [n, , oi] = rl[d]; return { d, x: oi > 0 ? -n / oi * 100 : null }; }),
    };
}

/** 跟 pcr_probe.events 同一把尺,多一欄 5 日收→收(描述) */
export function events(ser, px, pdates, rules) {
    const vals = ser.map(s => s.x);
    const idxOf = d => { let lo = 0, hi = pdates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pdates[m] <= d) lo = m + 1; else hi = m; } return lo; };
    const rows = [];
    for (let i = 0; i < ser.length; i++) {
        const d = ser[i].d, k = idxOf(d), T = pdates[k], T5 = pdates[k + 4], a = px.get(d), b = T && px.get(T);
        if (!a || !b || !(b.o > 0) || !(a.c > 0)) continue;
        const c5 = T5 && px.get(T5);
        rows.push({ d, oc: (b.c / b.o - 1) * 100, cc: (b.c / a.c - 1) * 100, c5: c5 ? (c5.c / a.c - 1) * 100 : null, pct: pastPct(vals, i), x: vals[i] });
    }
    const yr = {};
    rows.forEach(r => { const y = r.d.slice(0, 4); const o = (yr[y] = yr[y] || { oc: [], cc: [], c5: [] }); o.oc.push(r.oc); o.cc.push(r.cc); if (r.c5 != null) o.c5.push(r.c5); });
    const ym = Object.fromEntries(Object.entries(yr).map(([y, o]) => [y, { oc: mean(o.oc), cc: mean(o.cc), c5: mean(o.c5) }]));
    const out = {};
    for (const rule of rules) {
        out[rule.name] = rows.filter(r => r.x != null && rule.hit(r.x, r.pct)).map(r => {
            const m = ym[r.d.slice(0, 4)];
            return { d: r.d, v: rule.side * (r.oc - m.oc), raw: rule.side * r.oc - COST, v2: rule.side * (r.cc - m.cc), v5: r.c5 == null ? null : rule.side * (r.c5 - m.c5) };
        });
    }
    return { out, n: rows.length };
}

// App 的說法:散戶過熱 → 逆向看空(side −1)、散戶恐慌 → 逆向看多(side +1)
export const APP_RULES = [
    { name: '🐂 App 現行:散戶過度看多 ≥30% → 偏空(出貨指數 +20)', side: -1, hit: x => x >= CUT.hot },
    { name: '🐂 App 現行:散戶偏多 15~30% → 偏空(出貨指數 +10)', side: -1, hit: x => x >= CUT.long && x < CUT.hot },
    { name: '🐂 App 現行:散戶極度看空 ≤−25% → 偏多(出貨指數 −15)', side: 1, hit: x => x <= CUT.panic },
];
export const STD_RULES = [
    { name: '正式算法:散戶淨多位階前 20%(過去 250 天)→ 偏空', side: -1, hit: (x, p) => p != null && p >= 0.8 },
    { name: '正式算法:散戶淨多位階後 20% → 偏多', side: 1, hit: (x, p) => p != null && p <= 0.2 },
    { name: '正式算法:位階前 10% → 偏空', side: -1, hit: (x, p) => p != null && p >= 0.9 },
    { name: '正式算法:位階後 10% → 偏多', side: 1, hit: (x, p) => p != null && p <= 0.1 },
];

function report(title, res) {
    const rows = {};
    console.log(`\n── ${title}(可配對 ${res.n} 天)`);
    for (const [k, e] of Object.entries(res.out)) {
        if (e.length < 30) { console.log(`⏳ ${k}:${e.length} 天 → 樣本不足,⛔ 不下結論`); rows[k] = { n: e.length }; continue; }
        const g = gates(e, e.map(x => x.raw), 1);
        const cc = mean(e.map(x => x.v2)), c5 = mean(e.filter(x => x.v5 != null).map(x => x.v5));
        rows[k] = { ...g, ccInc: +cc.toFixed(3), c5Inc: +c5.toFixed(3) };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} ${k} ・n=${g.n} ・隔天開→收 增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・扣成本絕對 ${g.abs}% ・收→收 ${cc >= 0 ? '+' : ''}${cc.toFixed(3)}pp ・5 日收→收 ${c5 >= 0 ? '+' : ''}${c5.toFixed(3)}pp ・六關 ${g.pass}/6`);
        console.log(`     逐年 ${JSON.stringify(g.years)} ・沒過:${Object.entries(g.gates || {}).filter(([, v]) => !v).map(([n]) => n).join('、') || '—'}`);
    }
    return rows;
}

/** 校準:App 存的 retail_ls_pct(快照日可能晚一天)vs 這裡重算 → 取 lag 0 / 1 相關較高的那個 */
export function calib(appSer, hist) {
    const m = new Map(appSer.filter(s => s.x != null).map(s => [s.d, s.x]));
    const ds = [...m.keys()].sort();
    const best = [];
    for (const lag of [0, 1]) {
        const pr = [];
        for (const h of hist) {
            // 快照日 h.date 當下最新的交易日 = ds 裡 ≤ h.date 的最後一天;lag 1 = 再往前一天
            let k = -1; for (let i = 0; i < ds.length && ds[i] <= h.date; i++) k = i;
            const d = ds[k - lag];
            if (d && Number.isFinite(h.v)) pr.push([m.get(d), h.v]);
        }
        const xs = pr.map(p => p[0]), ys = pr.map(p => p[1]);
        const mx = mean(xs), my = mean(ys);
        const cov = mean(pr.map(p => (p[0] - mx) * (p[1] - my)));
        const sd = a => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
        best.push({ lag, n: pr.length, r: +(cov / (sd(xs) * sd(ys))).toFixed(3), same: pr.filter(p => Math.abs(p[0] - p[1]) < 1).length });
    }
    return best;
}

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    const s0 = series({ '2026-10-08': [-10000, 20000, 40000, 25] });
    ok('① 兩種算法:App = −淨 ÷ 法人多+空(+50)、正式 = −淨 ÷ 全市場(+25);正值 = 散戶淨多', s0.app[0].x === 50 && s0.std[0].x === 25, JSON.stringify(s0));
    let s = 7; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const D = []; const t0 = Date.UTC(2018, 0, 1);
    for (let i = 0; D.length < 1200; i++) { const dt = new Date(t0 + i * 864e5); if (dt.getUTCDay() % 6) D.push(dt.toISOString().slice(0, 10)); }
    const mk = plant => { const ser = [], px = new Map(); let c = 100;
        D.forEach((d, i) => { const x = -60 + rnd() * 120; ser.push({ d, x });
            const prevHot = i > 0 && ser[i - 1].x >= CUT.hot; const o = c * (1 + (rnd() - 0.5) * 0.004);
            const cl = o * (1 + (rnd() - 0.5) * 0.01 - (plant && prevHot ? 0.006 : 0)); px.set(d, { o, c: cl }); c = cl; });
        return { ser, px }; };
    const A = mk(true), ea = events(A.ser, A.px, D, APP_RULES).out[APP_RULES[0].name], ga = gates(ea, ea.map(x => x.raw), 1);
    ok('② 埋「散戶過熱隔天 −0.6%」→ 偏空訊號增量量得到(翻號後為正)、六關 ≥5', ga.inc > 0.3 && ga.pass >= 5, JSON.stringify(ga).slice(0, 160));
    const B = mk(false), eb = events(B.ser, B.px, D, APP_RULES).out[APP_RULES[0].name], gb = gates(eb, eb.map(x => x.raw), 1);
    ok('③ 沒埋 → |增量| < 0.15、⛔ 不可六關全過', Math.abs(gb.inc) < 0.15 && gb.pass < 6, JSON.stringify(gb).slice(0, 160));
    const C = mk(false); C.ser.forEach(r => { if (r.x >= CUT.hot) { const p = C.px.get(r.d); C.px.set(r.d, { o: p.o, c: p.o * 0.95 }); } });
    const ec = events(C.ser, C.px, D, APP_RULES).out[APP_RULES[0].name];
    ok('④ 訊號日當天大跌 → 隔天開→收增量不受影響(零前視)', Math.abs(mean(ec.map(x => x.v))) < 0.15, mean(ec.map(x => x.v)));
    // ⑤ 校準:同號 → 正相關;把 App 存的值翻號 → 負相關(決定性對照)
    const app = D.slice(0, 80).map((d, i) => ({ d, x: Math.sin(i / 5) * 40 }));
    const hist = app.map(r => ({ date: r.d, v: +r.x.toFixed(1) }));
    const c1 = calib(app, hist), c2 = calib(app, hist.map(h => ({ ...h, v: -h.v })));
    ok('⑤ 校準:同號 → lag 0 相關 ≈ 1;翻號 → ≈ −1', c1[0].r > 0.99 && c2[0].r < -0.99, JSON.stringify([c1, c2]));
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ RETAILLS_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const F = process.env.TAIFEX_HIST;
    if (!F || !fs.existsSync(F)) { console.error('❌ 要 TAIFEX_HIST=data/taifex_hist.json(git show origin/data:data/taifex_hist.json > …)'); process.exit(1); }
    const T = JSON.parse(fs.readFileSync(F, 'utf8'));
    const nRl = Object.keys(T.rl || {}).length;
    if (nRl < 250) { console.error(`❌ taifex_hist.json 的 rl 只有 ${nRl} 天(要先跑 📚 歷史補挖 workflow)→ ⛔ 不下結論`); process.exit(1); }
    const DD = process.env.DATA_DIR || path.join(ROOT, 'data');
    const bf = path.join(DD, '_bench0050.json'), useB = fs.existsSync(bf);
    let K = JSON.parse(fs.readFileSync(useB ? bf : path.join(DD, '0050.json'), 'utf8')); K = Array.isArray(K) ? K : K.data;
    const px = new Map(K.map(r => [String(r.date).replace(/\//g, '-'), { o: +r.open, c: +r.close }]));
    const pdates = [...px.keys()].sort();
    const S = series(T.rl);
    const ds = Object.keys(T.rl).sort();
    console.log(`📅 小台散戶多空比 ${ds[0]} ~ ${ds[ds.length - 1]}(${nRl} 天)・0050 ${useB ? '_bench0050' : '0050.json'} ${pdates[0]} ~ ${pdates[pdates.length - 1]}`);
    const q = a => { const v = a.map(s => s.x).filter(x => x != null).sort((x, y) => x - y); return [0.05, 0.25, 0.5, 0.75, 0.95].map(p => +v[Math.floor(p * (v.length - 1))].toFixed(1)); };
    console.log(`   分布(5/25/50/75/95%):App 算法 ${JSON.stringify(q(S.app))} ・正式算法 ${JSON.stringify(q(S.std))}`);
    const pctOf = (a, f) => +(a.filter(s => s.x != null && f(s.x)).length / a.filter(s => s.x != null).length * 100).toFixed(1);
    console.log(`   App 門檻有幾 % 的日子會亮:≥30 ${pctOf(S.app, x => x >= 30)}% ・15~30 ${pctOf(S.app, x => x >= 15 && x < 30)}% ・≤−25 ${pctOf(S.app, x => x <= -25)}%`);
    let cal = null;
    const RH = process.env.RISK_HIST;
    if (RH && fs.existsSync(RH)) {
        const h = JSON.parse(fs.readFileSync(RH, 'utf8')).filter(r => r && r.retail_ls_pct != null).map(r => ({ date: r.date, v: +r.retail_ls_pct }));
        cal = calib(S.app, h);
        console.log(`🔧 校準(App 每天存的 vs 這裡重算的 App 算法):${cal.map(c => `lag${c.lag} r=${c.r} 差<1 的 ${c.same}/${c.n} 天`).join(' ・')}`);
        console.log(`   ⭐ r 為正 → 正負號跟 App 一致;為負 → 採礦的正負號跟這裡相反(要先修再看結論)`);
    }
    const out = { generated: new Date().toISOString(), src: { from: ds[0], to: ds[ds.length - 1], n: nRl }, calib: cal,
        app: report('🐂 App 現行算法 + 現行門檻', events(S.app, px, pdates, APP_RULES)),
        std: report('📐 正式算法 + 自己位階', events(S.std, px, pdates, STD_RULES)) };
    console.log('\n⭐ 判讀:沒過六關 → 主力出貨指數那一項不該再計分、情緒卡只描述(同 V78.2.8 P/C 的處置)');
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
