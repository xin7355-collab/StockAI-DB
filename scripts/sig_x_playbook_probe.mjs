#!/usr/bin/env node
/**
 * 🔬 偵測器 × 個股打法 交叉探針(V73.2.5)
 *
 * 使用者:「46 個偵測器,有沒有比對個股打法,把可能的加進來?」
 *
 * ⭐ 要回答的是:**「這檔今天除了打法觸發,還同時亮了某個偵測器」時,這一趟會不會比較賺?**
 *    ⛔ 這跟 `signal_backtest.mjs` 問的**不是同一件事**——
 *       那支問「這個訊號自己有沒有預測力」(對照組 = 隨便挑一天),
 *       這支問「它**疊在打法上**有沒有加分」(對照組 = 同一批打法交易的平均)。
 *       V73.2.4 已經栽過一次:乖離年線自己有邊際,疊上來卻少賺 76 萬。
 *
 * 判準(⛔ 缺一不可):
 *   ① 樣本夠(預設 n >= 300)
 *   ② 邊際夠大(vs 同批打法交易的平均)
 *   ③ **前後半段同向** —— ⛔ 只看整段會挑到「靠某一段」的假贏家
 *
 * ⛔ 這支只讀不寫,exit 0,不進四驗證。每一筆都要人工讀過再決定要不要接。
 *
 * 用法:node scripts/sig_x_playbook_probe.mjs <交易快取.json> [最多幾檔]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.argv[2];
const MAX_SYMS = +(process.argv[3] || 99999);
const COST = 0.44;
const MIN_N = +(process.env.MIN_N || 300);
// 📤 把「(股|日)→ 命中哪些訊號」倒出來,讓 portfolio_backtest 直接讀,
//    ⛔ 免得每測一個變體就要重掃 4 分鐘(同交易快取的理由)
const SIGX_OUT = process.env.SIGX_OUT || '';
const sigMap = {};
if (!CACHE || !fs.existsSync(CACHE)) { console.log('❌ 請給交易快取路徑'); process.exit(1); }

const DETECTORS = [
    '_detectStarPatterns', '_detect2BarReversal', '_detectBoxBreakout', '_detectChuLongEntry',
    '_detectChuShortTrend', '_detectConsolidation', '_detectChuOverheat', '_detectKbarStrength',
    '_detectMaDeviation', '_detectFloorBounce', '_detectAvoidFlags', '_detectBottomBreakout',
    '_detectMaCluster', '_detectPressureTest', '_detectVolPriceDiverge', '_detectHeavyResistance',
    '_detectVolumeSignals', '_detectMaKoudi', '_detectGranville', '_detectBlackCandleLevels',
    '_detectRedCandleLevels', '_detectTrendline', '_detectMaGoldenCross', '_detectAbcBreakout',
    '_detectStall', '_detectElliott', '_detectGap', '_detectTopBreakdown', '_detectVCP',
    '_detectPocketPivot', '_detectNBottom', '_detectMomentumLaunch', '_detectVolStreak',
    '_detectWyckoffPhase', '_detectFibRetrace', '_detectReversalConfirm', '_detectChuThreeBlack',
    '_detectHeavyweightRebound', '_detectObvDivergence', '_detectVolPriceScenario',
];

const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const T = j.trades || [];
const bySym = new Map();
for (const t of T) { if (!bySym.has(t.sym)) bySym.set(t.sym, []); bySym.get(t.sym).push(t); }
console.log(`🔬 偵測器 × 個股打法 ・${T.length.toLocaleString()} 筆交易 / ${bySym.size} 檔`);

const { chromium } = await import(
    fs.existsSync('/opt/node22/lib/node_modules/playwright/index.mjs')
        ? '/opt/node22/lib/node_modules/playwright/index.mjs' : 'playwright');
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
    ...(fs.existsSync(exe) ? { executablePath: exe } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._detectStarPatterns, null, { timeout: 25000 });
const alive = await page.evaluate(ds => ds.filter(d => typeof app[d] === 'function'), DETECTORS);
console.log(`   偵測器可用 ${alive.length}/${DETECTORS.length}`);
// 🧭 把 App 內嵌的實測成績表撈出來 —— 用來標「這個訊號自己有沒有邊際」
const EDGE = await page.evaluate(() => {
    try { return JSON.parse(JSON.stringify(app._SIGNAL_EDGE || {})); } catch (_) { return {}; }
});

const net = t => t.ret - COST;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const dates = [...new Set(T.map(t => t.inD))].sort();
const MID = dates[Math.floor(dates.length / 2)];

// sig key → {all:[], h1:[], h2:[]}
const acc = new Map();
let done = 0, t0 = Date.now(), pairs = 0;
for (const [sym, arr] of bySym) {
    if (done >= MAX_SYMS) break;
    let rows;
    try {
        rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${sym}.json`), 'utf8'))
            .map(r => ({
                date: String(r.date || '').replace(/\//g, '-').slice(0, 10),
                open: +r.open || +r.close, high: +r.high || +r.close,
                low: +r.low || +r.close, close: +r.close, volume: +r.volume || 0,
            })).filter(r => r.date && r.close > 0);
    } catch (_) { continue; }
    done++;
    const idx = new Map(rows.map((r, i) => [r.date, i]));
    const want = [...new Set(arr.map(t => t.inD))].filter(d => idx.has(d) && idx.get(d) >= 250);
    if (!want.length) continue;
    pairs += want.length;
    let fired;
    try {
        fired = await page.evaluate(({ rows, dets, want }) => {
            const out = {};
            const byDate = {}; rows.forEach((r, i) => { byDate[r.date] = i; });
            for (const d of want) {
                const i = byDate[d];
                const slice = rows.slice(0, i + 1);
                app.rawDailyData = slice; app.currentSymbolId = 'BT';
                const names = [];
                for (const fn of dets) {
                    let r;
                    try { r = app[fn](slice); } catch (_) { continue; }
                    if (!Array.isArray(r)) continue;
                    for (const s of r) {
                        if (!s || !s.title) continue;
                        names.push(`${fn}｜${String(s.title).slice(0, 28)}`);
                    }
                }
                out[d] = names;
            }
            return out;
        }, { rows, dets: alive, want });
    } catch (_) { continue; }
    if (SIGX_OUT) for (const [d, names] of Object.entries(fired)) {
        if (names && names.length) sigMap[`${sym}|${d}`] = names;
    }
    for (const t of arr) {
        const names = fired[t.inD];
        if (!names) continue;
        for (const k of new Set(names)) {
            const o = acc.get(k) || { all: [], h1: [], h2: [] };
            o.all.push(net(t)); (t.inD < MID ? o.h1 : o.h2).push(net(t));
            acc.set(k, o);
        }
    }
    if (done % 50 === 0) process.stdout.write(`\r   ${done} 檔 ・${pairs.toLocaleString()} 個(股,日)・${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await browser.close();
console.log(`\r   ✅ ${done} 檔 ・${pairs.toLocaleString()} 個(股,日)・${((Date.now() - t0) / 1000).toFixed(0)}s      `);

// 🚧 空過守門:一個訊號都沒收到 = 偵測器改名/沒載起來,⛔ 不可當成「沒有加分」
if (!acc.size) { console.log('❌ 一個訊號都沒收到 → 這份結果無效(偵測器沒跑到)'); process.exit(1); }

const B = mean(T.map(net));
const B1 = mean(T.filter(t => t.inD < MID).map(net));
const B2 = mean(T.filter(t => t.inD >= MID).map(net));
console.log(`\n基準(同一批打法交易):全段 ${B.toFixed(3)}%  前半 ${B1.toFixed(3)}%  後半 ${B2.toFixed(3)}%`);
console.log(`⛔ 邊際一律跟「同一批打法交易」比,不是跟 0 比,也不是跟「隨便挑一天」比\n`);

const rows2 = [];
for (const [k, o] of acc) {
    if (o.all.length < MIN_N || o.h1.length < 50 || o.h2.length < 50) continue;
    const d = mean(o.all) - B, d1 = mean(o.h1) - B1, d2 = mean(o.h2) - B2;
    rows2.push({ k, n: o.all.length, avg: mean(o.all), d, d1, d2, same: (d1 > 0) === (d2 > 0) });
}
rows2.sort((a, b) => b.d - a.d);
const edgeOf = k => {
    const e = EDGE[k]; if (!e) return '未驗證';
    const exp = e[7];
    return `${e[0]}級${Number.isFinite(exp) ? (exp > 0 ? `・自身期望 +${(+exp).toFixed(2)}%` : `・自身期望 ${(+exp).toFixed(2)}%`) : ''}`;
};
const show = (title, list) => {
    console.log('═'.repeat(96));
    console.log(title);
    console.log('═'.repeat(96));
    console.log('   訊號                                            n     每趟%   邊際pp   前半pp   後半pp  同向  自身成績');
    for (const r of list) {
        console.log(`   ${r.k.slice(0, 44).padEnd(44)} ${String(r.n).padStart(5)}  ${r.avg.toFixed(2).padStart(6)}  ${(r.d >= 0 ? '+' : '') + r.d.toFixed(2).padStart(6)}  ${(r.d1 >= 0 ? '+' : '') + r.d1.toFixed(2).padStart(6)}  ${(r.d2 >= 0 ? '+' : '') + r.d2.toFixed(2).padStart(6)}  ${r.same ? '✅' : '❌'}  ${edgeOf(r.k)}`);
    }
    console.log('');
};
show(`🔼 疊在打法上「加分」最多的前 15(共 ${rows2.length} 個訊號通過樣本門檻 n>=${MIN_N})`, rows2.slice(0, 15));
show('🔽 疊在打法上「扣分」最多的前 10(⭐ 這些才是該當排除條件的)', rows2.slice(-10).reverse());

const good = rows2.filter(r => r.same && r.d > 0.5);
const bad = rows2.filter(r => r.same && r.d < -0.5);
console.log('═'.repeat(96));
console.log(`⭐ 同時滿足「邊際 > +0.5pp」且「前後半段同向」的:${good.length} 個`);
for (const r of good) console.log(`   ✅ ${r.k}  (n=${r.n}, +${r.d.toFixed(2)}pp)`);
console.log(`⛔ 同時滿足「邊際 < −0.5pp」且「前後半段同向」的:${bad.length} 個`);
for (const r of bad) console.log(`   ⛔ ${r.k}  (n=${r.n}, ${r.d.toFixed(2)}pp)`);
if (SIGX_OUT) {
    // 只留通過樣本門檻的訊號(⛔ 全存會爆檔案大小,而且低樣本的本來就不能用)
    const keep = new Set(rows2.map(r => r.k));
    const names = [...keep];
    const idx = new Map(names.map((n, i) => [n, i]));
    const out = {};
    for (const [k, arr2] of Object.entries(sigMap)) {
        const v = arr2.filter(n => idx.has(n)).map(n => idx.get(n));
        if (v.length) out[k] = v;
    }
    fs.writeFileSync(SIGX_OUT, JSON.stringify({ names, map: out }));
    console.log(`📤 已輸出訊號對照表:${names.length} 個訊號 / ${Object.keys(out).length.toLocaleString()} 個(股,日) → ${SIGX_OUT}`);
}
console.log('\n⚠️ 這裡的「加分」是**條件表現**,不等於「加進去總獲利會變多」——');
console.log('   要當濾網用,一定要再跑一次 portfolio_backtest 看**賺到的錢**(前 56 種變體幾乎都栽在這一步)。');
