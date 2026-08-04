#!/usr/bin/env node
/**
 * 🎯 今日實測訊號掃描 —— 全市場掃「今天出現了哪些**期望值為正**的訊號」
 *
 * 使用者原話:「只要給我最好、勝率最高的資料」「一目了然知道現在要怎麼做」。
 *
 * 問題:`_SIGNAL_EDGE` 的實測成績只能在**個股頁**看到 —— 使用者得先想到要看哪一檔,
 *      才知道它今天有沒有訊號。⛔ 那等於要他自己一檔一檔翻 2,227 檔。
 * → 這支在採礦端**跑真正的 JS 偵測器**(同 signal_backtest.mjs 的做法,⛔ 不複製一份判定邏輯),
 *   只掃**最後一根 K**,把「今天出現正期望值訊號」的股票挑出來寫成 data/today_signals.json。
 *
 * ⛔ 三條鐵則(跟顯示端一致,別在這裡另立一套):
 *   ① **看多只收 `exp > 0`** —— 常對但不賺的不該進榜(V72.0.3 的教訓)
 *   ② **看空/警示照收**,但另外分組 —— 風險提醒不打折(V72.0.6 多空不對稱)
 *   ③ 期望值**未扣交易成本**(來回約 0.44%)→ 輸出裡標明,顯示端要寫
 *
 * 跑法:node scripts/daily_signal_scan.mjs [最多幾檔]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
// 榜單細節列的上限。⚠️ 不只是檔案大小考量 —— 前端「👜 你手上那幾檔也在榜上」是拿這份清單去比對,
//   上限太低會讓排名靠後的持股**被默默漏掉**。實測每筆約 135 bytes → 200 筆約 27 KB,可接受。
const BULL_CAP = 200;
const t0 = Date.now();
const log = (...a) => console.log(...a);

// 跟 renderKbarTactics 收的是同一組偵測器(⛔ 別在這裡自己挑一套)
const DETECTORS = [
    '_detectStarPatterns', '_detectBottomBreakout', '_detectTopBreakdown', '_detectGap',
    '_detectMaDeviation', '_detectGranville', '_detectTrendline', '_detectIndicatorDivergence',
    '_detectMaKoudi', '_detectVolPriceDiverge', '_detectVolumeSignals', '_detectKbarStrength',
    '_detect2BarReversal', '_detectPressureTest', '_detectBlackCandleLevels', '_detectFloorBounce',
    '_detectPocketPivot', '_detectVCP', '_detectNBottom', '_detectReversalConfirm',
    '_detectHeavyResistance', '_detectChuLongEntry', '_detectChuOverheat', '_detectMaGoldenCross',
    '_detectAvoidFlags', '_detectVolPriceScenario', '_detectElliott', '_detectWyckoff',
];

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-');
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out.length >= 120 ? out : null;
    } catch (_) { return null; }
}

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
log(`📂 掃描 ${files.length} 檔${MAX_SYMS < 99999 ? `(上限 ${MAX_SYMS})` : ''}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._sigEdge, null, { timeout: 25000 });

const meta = await page.evaluate(() => app._SIGNAL_EDGE_META || {});
const alive = await page.evaluate(ds => ds.filter(d => typeof app[d] === 'function'), DETECTORS);
log(`🔬 偵測器 ${alive.length}/${DETECTORS.length} 可用・成績表涵蓋 ${meta.syms} 檔`);

// ⛔ 刻意**不存股票名稱** —— 前端本來就有 `getStockName(sym)`(從 FinMind 清單來),
//   採礦端再存一份等於同一份資料兩個來源,改名時會不同步(同「同名不同值」那類問題)。

const bull = [], risk = [];
let used = 0, latest = '';
for (const f of files) {
    if (used >= MAX_SYMS) break;
    const sym = f.slice(0, 4);
    const rows = loadSeries(path.join(DATA, f));
    if (!rows) continue;
    used++;
    const hits = await page.evaluate(a => {
        const { rows, dets } = a;
        app.currentSymbolId = a.sym;
        app.rawDailyData = rows;
        const cl = rows.map(x => +x.close);
        const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k);
        app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60), k: [], d: [], dif: [], macd: [] };
        const out = [];
        for (const d of dets) {
            let r;
            try { r = app[d](rows); } catch (_) { continue; }
            const arr = Array.isArray(r) ? r : (r ? [r] : []);
            for (const x of arr) {
                if (!x || !x.title) continue;
                const e = app._sigEdge(d, x.title);
                if (!e) continue;
                out.push({ d, t: x.title, tone: x.tone || 'flat', g: e.grade, n: e.n, w: e.w10, exp: e.exp, po: e.payoff });
            }
        }
        return out;
    }, { rows, dets: alive, sym });

    const last = rows[rows.length - 1];
    if (!latest || last.date > latest) latest = last.date;
    for (const h of hits) {
        const row = { s: sym, c: Math.round(last.close * 100) / 100, v: Math.round(last.volume / 1000), d: last.date, t: h.t, g: h.g, n: h.n, w: h.w, exp: h.exp, po: h.po };
        // ① 看多只收 exp>0(常對但不賺的不進榜)
        if (h.tone === 'bull' && h.exp != null && h.exp > 0) bull.push(row);
        // ② 看空/警示照收(風險提醒不打折),但分開放
        else if (h.tone === 'bear' || h.tone === 'warn') risk.push(row);
    }
    if (used % 250 === 0) log(`   …${used} 檔 / ${((Date.now() - t0) / 1000).toFixed(0)}s / 多方 ${bull.length}・風險 ${risk.length}`);
}
await browser.close();

// 期望值高的排前面;風險榜用「跌得越多代表越準」→ exp 越負排越前
// 同一個訊號的 exp/n 完全相同 → 第二鍵用**成交量**(量大的參與度高),
// ⛔ 別讓它退化成代號順序(那等於「1xxx 永遠排前面」,又是一種偏誤)
bull.sort((a, b) => (b.exp - a.exp) || (b.v - a.v));

const out = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    data_date: latest,
    scanned: used,
    edge_syms: meta.syms || null,
    base_win: meta.base_win || null,
    // ⚠️ 顯示端一定要寫:期望值未扣交易成本(來回約 0.44%)
    cost_note: '期望值未扣交易成本(來回約 0.44%,當沖 0.25%)',
    // ⛔ **有截斷就要講**(CLAUDE.md「no silent caps」):只給 `bull` 的話,
    //   顯示端會把「被 slice 剩下的筆數」當成「今天的總數」。
    //   實測 2026-08-04 就剛好卡在 60(= 舊上限)→ 前端顯「只有 60 檔」,而真值不是 60。
    //   ⚠️ 而且 `bull` 是**逐筆訊號**不是逐檔股票(同一檔可能命中多個訊號,實測 60 筆只有 56 檔)
    //      → 兩個數字都要輸出,顯示端才不會把「筆」講成「檔」。
    bull_total: bull.length,                                   // 截斷前的總筆數
    bull_syms: new Set(bull.map(b => b.s)).size,               // 截斷前的不重複股票數
    bull_cap: BULL_CAP,
    bull: bull.slice(0, BULL_CAP),
    // ⛔ **刻意不輸出風險股清單** —— 全市場實測有 6,158 筆風險訊號,
    //   取前 60 只是**任意截斷**(同一個訊號的期望值完全一樣,排序沒有意義),
    //   而且「全市場哪些股票有風險」對使用者沒有可操作性 ——
    //   他要看的是**自己手上那幾檔**,那前端用 `_entryCheckup` 本來就做得到。
    //   → 這裡只給**總數**,當作「今天大盤氛圍」的參考。
    risk_n: risk.length,
    risk_syms: new Set(risk.map(r => r.s)).size,
};
fs.writeFileSync(path.join(DATA, 'today_signals.json'), JSON.stringify(out), 'utf-8');
log(`\n✅ ${used} 檔 ・${((Date.now() - t0) / 1000).toFixed(0)}s`);
log(`   🎯 正期望值看多訊號:${bull.length} 筆 / ${out.bull_syms} 檔(輸出前 ${out.bull.length} 筆)`);
if (bull.length > out.bull.length) log(`   ⚠️ 有截斷:${bull.length} → ${out.bull.length}(上限 ${BULL_CAP});bull_total/bull_syms 已寫進 JSON,顯示端要用那兩個講總數`);
log(`   ⚠️ 風險提醒:${out.risk_n} 筆 / ${out.risk_syms} 檔(⛔ 不輸出清單,只給總數當大盤氛圍)`);
if (out.bull.length) {
    log('\n🏆 期望值最高的 8 檔:');
    for (const b of out.bull.slice(0, 8)) log(`   ${b.s} ${String(b.c).padStart(8)}  ${b.t}  期望 ${b.exp >= 0 ? '+' : ''}${b.exp}% ・勝率 ${b.w}% ・${b.n} 次`);
}
log(`\n💾 已寫 data/today_signals.json`);
