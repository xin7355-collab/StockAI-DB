#!/usr/bin/env node
// 🌅🏦 盤前體檢「國內那一半」有沒有用(V79.3.8,變因研究盤點 1a)
//
// 為什麼要有這支:premkt_probe STRICT 只重建得出**海外那一半**(美股 / 費半 / 台積 ADR / VIX / 日韓 / 台幣,8 項)。
//   App 的盤前分數還有國內那一半:🏦 外資台指期(±2)・🏦 外資現貨(±1)・🏛️ 三大法人合計(±1)・📈 加權自己的技術面(±2)
//   —— 以前沒有歷史(risk_history 只有幾十天)。V79.3.6 補挖了 fi_mkt_hist(期貨 2018-06 起、現貨 2004 起)→ 現在算得出來。
// 問題:國內那一半「單獨」有沒有預測力?加進去之後,分數預測隔天開盤 / 收盤的能力變好還是變差?
//
// 做法(零前視;規則照 index.html 盤前體檢那段,⛔ 不另訂門檻):
//   ・T 日的分數 = 海外半(PREMKT_SCORES,T−1 海外收盤)+ 國內半(T−1 收盤後就知道的):
//     外資台指期 5 日增減(≤−8,000 −2 / ≤−3,000 −1 / ≥+8,000 +2 / ≥+3,000 +1;沒有 5 日才看 20 日位階 ±1)
//     外資現貨(>0 +1 / <−200 億 −1)・三大法人合計(同)・加權技術面(App `_entryCheckup` 的 vColor:紅 +2 / 綠 −2)
//   ・技術面直接在 headless 裡跑 **App 自己的 `_entryCheckup`**(⛔ 不複製判定邏輯),餵「T−1 為止最近 120 根」
//     (= App 用的 macro_cache.twii_history 長度)
//   ・結果 = T 日 0050:開盤跳空(開 ÷ 昨收)、開→收、收→收(⛔ 不用加權開盤價,陷阱 #47);T 日除息剔除
//   ・比較:海外半 / 國內半 / 合計 各自的名次相關、分數 ≥3 與 ≤−3 那幾天的方向命中率 vs 基準;國內半在「海外半同一格」裡的增量
//
// ⛔ 只描述 + 檢定,⛔ 不改 App。⚠️ 限制:夜盤 / 那指期 / 美債 / 日月光聯電 ADR / 恐懼貪婪 / 恆指 / 道瓊 / 台幣 5 日 / 亞幣 都沒有歷史 → 不在這裡。
//
// 跑法:PREMKT_SCORES=$S/premkt_scores.txt FI_MKT=$S/fi_mkt_hist.json TWII=$S/gh_twii.json DATA_DIR=$S/d10n \
//        node scripts/premkt_dom_probe.mjs out.json
//      (TWII = 有成交量欄的加權日 K,技術面用;DATA_DIR 要 _bench0050.json(含開盤)與 _div0050.json)
//      node scripts/premkt_dom_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const num = v => (v == null || v === '' || isNaN(+v)) ? null : +v;

// ── 國內半:四項(照 index.html 盤前體檢的 _add 那幾行)──────────────────
export function futPart(hist) {
    // hist = 到 T−1 為止的外資台指期淨口數序列(最後一個 = T−1);同 `_fiFutState` 的 chg5 / pct
    if (!hist || !hist.length) return null;
    const net = hist[hist.length - 1];
    const chg5 = hist.length >= 6 ? net - hist[hist.length - 6] : null;
    let pct = null;
    const win = hist.slice(-20);
    if (win.length >= 8) { const lo = Math.min(...win), hi = Math.max(...win); if (hi > lo) pct = (net - lo) / (hi - lo) * 100; }
    if (chg5 != null) return chg5 <= -8000 ? -2 : chg5 <= -3000 ? -1 : chg5 >= 8000 ? 2 : chg5 >= 3000 ? 1 : 0;
    if (pct != null) return pct <= 15 ? -1 : pct >= 85 ? 1 : 0;
    return null;
}
export const flowPart = v => v == null ? null : (v > 0 ? 1 : v < -200 ? -1 : 0);
export const techPart = vc => vc == null ? null : (vc === 'red' ? 2 : vc === 'green' ? -2 : 0);

export function parseScores(txt) {
    const out = {};
    for (const m of String(txt || '').matchAll(/(\d{4}-\d{2}-\d{2}):(-?[\d.]+)/g)) out[m[1]] = +m[2];
    return out;
}

// T 日用 T−1(加權日曆上 T 的前一天)的國內值;⛔ 不可用 T 當天的
export function buildRows({ scores, futMap, spotMap, techMap, bars, exdiv, cal }) {
    const fd = Object.keys(futMap).sort();
    const futIdx = new Map(fd.map((d, i) => [d, i]));
    const futVals = fd.map(d => futMap[d]);
    const bpos = new Map(bars.map((b, i) => [b.d, i]));
    const cpos = new Map(cal.map((d, i) => [d, i]));
    const rows = [];
    for (const T of Object.keys(scores).sort()) {
        const ci = cpos.get(T);
        if (ci == null || ci < 1) continue;
        const P = cal[ci - 1];                                   // T−1(加權日曆)
        const bi = bpos.get(T);
        if (bi == null || bi < 1 || bars[bi - 1].d !== P) continue;   // 0050 也要有 T−1(⛔ 對不上就不算)
        if (exdiv.has(T)) continue;
        const o = bars[bi].o, c = bars[bi].c, pc = bars[bi - 1].c;
        if (!(o > 0 && c > 0 && pc > 0)) continue;
        let fut = null;
        if (futIdx.has(P)) fut = futPart(futVals.slice(0, futIdx.get(P) + 1));
        const sp = spotMap[P];
        const spot = sp ? flowPart(sp[0]) : null;
        const inst = sp ? flowPart(sp[0] + sp[1] + sp[2]) : null;
        const tech = techPart(techMap[P]);
        rows.push({ T, P, ovs: scores[T], fut, spot, inst, tech,
                    gap: (o / pc - 1) * 100, oc: (c / o - 1) * 100, cc: (c / pc - 1) * 100 });
    }
    return rows;
}

// ── 統計 ─────────────────────────────────────────────────────────
function rankArr(a) { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); let i = 0;
    while (i < o.length) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; const avg = (i + j) / 2; for (let k = i; k <= j; k++) r[o[k][1]] = avg; i = j + 1; } return r; }
export function spearman(x, y) {
    const m = x.map((v, i) => [v, y[i]]).filter(([a, b]) => a != null && b != null && isFinite(a) && isFinite(b));
    if (m.length < 30) return { rho: null, n: m.length, t: null };
    const rx = rankArr(m.map(v => v[0])), ry = rankArr(m.map(v => v[1])), n = m.length;
    const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
    const rho = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    return { rho, n, t: rho * Math.sqrt((n - 2) / Math.max(1e-12, 1 - rho * rho)) };
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);

export function analyze(rows) {
    const dom = r => [r.fut, r.spot, r.inst, r.tech].every(v => v != null) ? r.fut + r.spot + r.inst + r.tech : null;
    const full = rows.filter(r => dom(r) != null);
    const res = { n: rows.length, nFull: full.length, from: full[0]?.T, to: full.at(-1)?.T, ic: {}, buckets: {}, within: {}, parts: {} };
    for (const k of ['gap', 'oc', 'cc']) {
        res.ic[k] = {
            ovs: spearman(full.map(r => r.ovs), full.map(r => r[k])),
            dom: spearman(full.map(dom), full.map(r => r[k])),
            sum: spearman(full.map(r => r.ovs + dom(r)), full.map(r => r[k])),
        };
        for (const p of ['fut', 'spot', 'inst', 'tech']) (res.parts[p] = res.parts[p] || {})[k] = spearman(full.map(r => r[p]), full.map(r => r[k]));
    }
    // App 的門檻:分數 ≥3 / ≤−3(LAB premkt-score)→ 方向命中率:海外半 vs 加上國內半
    const hit = (sel, k, dir) => { const a = sel.map(r => r[k]); return a.length ? a.filter(v => dir > 0 ? v > 0 : v < 0).length / a.length * 100 : null; };
    for (const k of ['gap', 'oc', 'cc']) {
        const b = {};
        for (const [nm, f] of [['ovs', r => r.ovs], ['sum', r => r.ovs + dom(r)]]) {
            const hi = full.filter(r => f(r) >= 3), lo = full.filter(r => f(r) <= -3);
            b[nm] = { hiN: hi.length, hiHit: r2(hit(hi, k, 1)), hiMean: r2(mean(hi.map(r => r[k]))), loN: lo.length, loHit: r2(hit(lo, k, -1)), loMean: r2(mean(lo.map(r => r[k]))) };
        }
        b.base = { up: r2(hit(full, k, 1)), down: r2(hit(full, k, -1)), mean: r2(mean(full.map(r => r[k]))) };
        res.buckets[k] = b;
        // 國內半在「海外半同一格」裡的增量:海外半分 5 格,每格內 國內 ≥+2 vs ≤−2 的平均差(加權平均)
        const cuts = [-Infinity, -3, -0.5, 0.5, 3, Infinity];
        let wsum = 0, wdiff = 0; const cells = [];
        for (let c = 0; c < 5; c++) {
            const cell = full.filter(r => r.ovs > cuts[c] && r.ovs <= cuts[c + 1]);
            const up = cell.filter(r => dom(r) >= 2), dn = cell.filter(r => dom(r) <= -2);
            if (up.length >= 10 && dn.length >= 10) { const d = mean(up.map(r => r[k])) - mean(dn.map(r => r[k])); wsum += up.length + dn.length; wdiff += d * (up.length + dn.length); cells.push({ c, up: up.length, dn: dn.length, d: r2(d) }); }
        }
        res.within[k] = { diff: wsum ? r2(wdiff / wsum) : null, cells };
    }
    // 逐年:國內半單獨的名次相關(收→收)
    const yrs = {};
    for (const r of full) (yrs[r.T.slice(0, 4)] = yrs[r.T.slice(0, 4)] || []).push(r);
    res.years = Object.fromEntries(Object.entries(yrs).map(([y, a]) => [y, { n: a.length, dom_cc: r2(spearman(a.map(dom), a.map(r => r.cc)).rho), ovs_cc: r2(spearman(a.map(r => r.ovs), a.map(r => r.cc)).rho) }]));
    return res;
}

// ── 技術面:headless 跑 App 的 _entryCheckup ──────────────────────
async function techMapFromApp(twiiRows, dates) {
    let chromium;
    try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
    const exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exec) ? { executablePath: exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    try {
        const page = await browser.newPage();
        page.on('pageerror', () => {});
        await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._entryCheckup === 'function', null, { timeout: 30000 });
        return await page.evaluate(({ rows, dates }) => {
            const pos = new Map(rows.map((r, i) => [String(r.date).replace(/\//g, '-').slice(0, 10), i]));
            const out = {};
            for (const d of dates) {
                const i = pos.get(d);
                if (i == null || i < 119) continue;
                const win = rows.slice(i - 119, i + 1).map(x => ({ ...x }));
                const l = win[win.length - 1];
                if (l && (!l.volume || +l.volume === 0) && win.length >= 2) l.volume = win[win.length - 2].volume || 0;   // 同 App:末根量 0 複製前一根
                try { const t = app._entryCheckup(win); out[d] = t ? (t.vColor || 'none') : null; } catch (_) { out[d] = null; }
            }
            return out;
        }, { rows: twiiRows, dates });
    } finally { await browser.close(); }
}

function loadJ(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

async function main() {
    const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
    const scores = parseScores(fs.readFileSync(process.env.PREMKT_SCORES || '', 'utf8'));
    const fm = loadJ(process.env.FI_MKT || '') || {};
    const tw = loadJ(process.env.TWII || '') || [];
    const DIR = process.env.DATA_DIR || '';
    const b = loadJ(path.join(DIR, '_bench0050.json')) || [];
    const dv = loadJ(path.join(DIR, '_div0050.json')) || {};
    const divs = ((dv.d || dv)['0050'] || {}).h || [];
    if (Object.keys(scores).length < 500) { console.error('❌ 海外半分數不到 500 天(PREMKT_SCORES)'); process.exit(1); }
    if (!fm.fut || !fm.spot) { console.error('❌ FI_MKT 沒有 fut / spot'); process.exit(1); }
    if (tw.length < 500 || !tw.some(r => +r.volume > 0)) { console.error('❌ TWII 太短或沒有成交量欄(技術面要量)'); process.exit(1); }
    if (!divs.length) { console.error('❌ 讀不到 0050 除息日'); process.exit(1); }
    const bars = b.map(x => ({ d: d10(x.date), o: num(x.open), c: num(x.close) })).filter(x => x.c > 0 && x.o > 0).sort((x, y) => x.d < y.d ? -1 : 1);
    const cal = tw.map(r => d10(r.date)).sort();
    const need = [...new Set(Object.keys(scores).map(T => cal[cal.indexOf(T) - 1]).filter(Boolean))];
    console.log(`🌅 海外半 ${Object.keys(scores).length} 天 ・技術面要算 ${need.length} 天(App _entryCheckup)…`);
    const t0 = Date.now();
    const techMap = await techMapFromApp(tw, need);
    const tv = Object.values(techMap);
    console.log(`   技術面 ${tv.filter(v => v).length} 天 ・紅 ${tv.filter(v => v === 'red').length} / 綠 ${tv.filter(v => v === 'green').length} / 其他 ${tv.filter(v => v && v !== 'red' && v !== 'green').length} ・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    if (tv.filter(v => v).length < need.length * 0.8) { console.error('❌ 技術面算得出來的不到 8 成 → App 載入有問題'); process.exit(1); }
    const futMap = Object.fromEntries(Object.entries(fm.fut).map(([k, v]) => [d10(k), v]));
    const spotMap = Object.fromEntries(Object.entries(fm.spot).map(([k, v]) => [d10(k), v]));
    const rows = buildRows({ scores, futMap, spotMap, techMap, bars, exdiv: new Set(divs.map(x => d10(x[0]))), cal });
    const R = analyze(rows);
    console.log(`📊 對得上 ${R.n} 天 ・四項國內都有 ${R.nFull} 天(${R.from} ~ ${R.to})`);
    for (const k of ['gap', 'oc', 'cc']) {
        const ic = R.ic[k], bk = R.buckets[k], w = R.within[k];
        console.log(`\n【${k === 'gap' ? '隔天開盤跳空' : k === 'oc' ? '開→收' : '收→收'}】名次相關:海外半 ${r2(ic.ovs.rho)}(t ${r2(ic.ovs.t)})・國內半 ${r2(ic.dom.rho)}(t ${r2(ic.dom.t)})・合計 ${r2(ic.sum.rho)}(t ${r2(ic.sum.t)})`);
        console.log(`   各項:` + ['fut', 'spot', 'inst', 'tech'].map(p => `${p} ${r2(R.parts[p][k].rho)}(t ${r2(R.parts[p][k].t)})`).join(' ・'));
        for (const nm of ['ovs', 'sum']) { const x = bk[nm]; console.log(`   ${nm === 'ovs' ? '海外半' : '合計  '} ≥3:${x.hiN} 天 漲 ${x.hiHit}%(平均 ${x.hiMean}%)・≤−3:${x.loN} 天 跌 ${x.loHit}%(平均 ${x.loMean}%)`); }
        console.log(`   基準:漲 ${bk.base.up}% / 跌 ${bk.base.down}% ・平均 ${bk.base.mean}%`);
        console.log(`   海外半同一格裡,國內半 ≥+2 − ≤−2:${w.diff}pp ・${JSON.stringify(w.cells)}`);
    }
    console.log('\n逐年(收→收名次相關):' + Object.entries(R.years).map(([y, v]) => `${y} 國內 ${v.dom_cc} / 海外 ${v.ovs_cc}(${v.n})`).join(' ・'));
    if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
}

function selftest() {
    let ok = 0, bad = 0;
    const T = (c, m, x) => { if (c) { ok++; console.log('✅', m); } else { bad++; console.log('❌', m, x === undefined ? '' : JSON.stringify(x).slice(0, 200)); } };
    T(futPart([0, 0, 0, 0, 0, -9000]) === -2 && futPart([0, 0, 0, 0, 0, 3500]) === 1 && futPart([0, 0, 0, 0, 0, 0]) === 0, '① 外資台指期 5 日增減四段(同 App)');
    T(futPart([1, 2, 3, 4, 5]) === null, '① 不到 6 天 → 沒有 5 日增減、也不到 8 個值 → null(⛔ 不補 0)');
    T(flowPart(5) === 1 && flowPart(-250) === -1 && flowPart(-100) === 0 && flowPart(null) === null, '① 外資現貨 / 三大法人:>0 +1、<−200 億 −1、中間 0、沒有 → null');
    T(techPart('red') === 2 && techPart('green') === -2 && techPart('yellow') === 0 && techPart(null) === null, '① 技術面:紅 +2 / 綠 −2 / 其他 0');
    T(Object.keys(parseScores('SCORES|2021-10-19:5.00,2021-10-20:-3.50\nSCORES|2021-10-21:0.00')).length === 3, '② 分數 log 解析(多行)');
    // ③ 零前視:T 日一律用 T−1 的國內值;把 T 當天的外資改成極端值,結果不變
    const cal = ['2022-01-03', '2022-01-04', '2022-01-05', '2022-01-06', '2022-01-07', '2022-01-10', '2022-01-11', '2022-01-12'];
    const futMap = Object.fromEntries(cal.map((d, i) => [d, i * 1000]));
    const spotMap = Object.fromEntries(cal.map(d => [d, [10, 0, 0]]));
    const techMap = Object.fromEntries(cal.map(d => [d, 'red']));
    const bars = cal.map((d, i) => ({ d, o: 100 + i, c: 100.5 + i }));
    const scores = { '2022-01-11': 4, '2022-01-12': -4 };
    const rows = buildRows({ scores, futMap, spotMap, techMap, bars, exdiv: new Set(), cal });
    const r11 = rows.find(r => r.T === '2022-01-11');
    T(r11 && r11.P === '2022-01-10' && r11.spot === 1 && r11.tech === 2, '③ T 日用 T−1 的國內值', r11);
    const rowsB = buildRows({ scores, futMap: { ...futMap, '2022-01-11': -99999 }, spotMap: { ...spotMap, '2022-01-11': [-9999, 0, 0] }, techMap: { ...techMap, '2022-01-11': 'green' }, bars, exdiv: new Set(), cal });
    T(JSON.stringify(rowsB.find(r => r.T === '2022-01-11')) === JSON.stringify(r11), '③ 零前視:改 T 當天的外資 / 技術面,T 日那一列一個字都不變');
    T(buildRows({ scores, futMap, spotMap, techMap, bars, exdiv: new Set(['2022-01-11']), cal }).every(r => r.T !== '2022-01-11'), '③ T 日除息 → 剔除');
    // ④ 合成:國內半真的有效 → 抓得到;打亂 → 抓不到(決定性對照)
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const syn = [];
    for (let i = 0; i < 1200; i++) {
        const fut = [-2, -1, 0, 1, 2][Math.floor(rnd() * 5)], spot = [-1, 0, 1][Math.floor(rnd() * 3)], inst = [-1, 0, 1][Math.floor(rnd() * 3)], tech = [-2, 0, 2][Math.floor(rnd() * 3)];
        const ovs = Math.round(gauss() * 4 * 2) / 2, dom = fut + spot + inst + tech;
        const cc = 0.15 * ovs + 0.25 * dom + gauss() * 1.2;
        syn.push({ T: `20${20 + Math.floor(i / 250)}-01-01`, ovs, fut, spot, inst, tech, gap: 0.1 * ovs + gauss() * 0.5, oc: cc * 0.5, cc });
    }
    const A = analyze(syn);
    T(A.ic.cc.dom.rho > 0.15 && A.within.cc.diff > 0.5, '④ 合成:國內半有效 → 名次相關與「海外同一格內」的增量都抓得到', { ic: A.ic.cc.dom, w: A.within.cc });
    const shuf = syn.map(r => ({ ...r })); const ccs = shuf.map(r => r.cc).sort(() => rnd() - 0.5); shuf.forEach((r, i) => { r.cc = ccs[i]; });
    const B = analyze(shuf);
    T(Math.abs(B.ic.cc.dom.rho) < 0.08 && Math.abs(B.within.cc.diff || 0) < 0.35, '④ 決定性對照:報酬打亂 → 抓不到(⛔ 不是寫死會過)', { ic: B.ic.cc.dom, w: B.within.cc });
    console.log(`selftest ${ok} ok / ${bad} bad`);
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { if (process.argv.includes('--selftest')) selftest(); else main(); }
