#!/usr/bin/env node
/**
 * 🎯 今日實測訊號掃描 —— 全市場掃「今天出現了哪些**期望值為正**的訊號」
 *
 * 使用者原話:「只要給我最好、勝率最高的資料」「一目了然知道現在要怎麼做」。
 *
 * 問題:`_SIGNAL_EDGE` 的實測成績只能在**個股頁**看到 —— 使用者得先想到要看哪一檔,
 *      才知道它今天有沒有訊號。⛔ 那等於要他自己一檔一檔翻 2,227 檔。
 * → 這支在採礦端**跑真正的 JS 偵測器**(同 signal_backtest.mjs 的做法,⛔ 不複製一份判定邏輯),
 *   只掃**最後一根已收盤的 K**,把「出現正期望值訊號」的股票挑出來寫成 data/today_signals.json。
 *   🚨 「已收盤」是關鍵:盤中被 push 觸發時,miner 已把當天**未完成**的盤中列寫進絕大多數股票
 *      (實測 95.5%)→ 一律先把那根整根切掉,榜上就是**上一個交易日的收盤訊號**(`bar_closed:false`)。
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

// ══════════════════════════════════════════════════════════════════════════
// 🚨🚨 陷阱 #14(第二次修):判準是「這一根**收盤了沒有**」,⛔ 不是「多數人是哪一天」
// ──────────────────────────────────────────────────────────────────────────
// V75.2.7 第一版改用「最後一根的**眾數**」當 data_date,理由是「少數盤中列會綁架 max」。
// ⛔ **那個修法在真正會出事的情境下完全無效** —— 而且我當時是拿**本地 data/**(一份舊 clone)
//    量出「97.8% 是昨天」就下結論的(陷阱 #40:測試環境跟正式環境不一樣)。
// 📊 讀 daily_miner 實際部署的 `origin/data`(2026-09-10 台北 12:31 那輪)抽樣 400 檔:
//      382 檔(95.5%)最後一根是 **09/10**(當天盤中、未收盤) ・ 15 檔 09/09
//    → **眾數 = 09/10 = 跟 max 選的一模一樣**,而前端寫「📅 09/10 收盤資料」。
//    那根的 close 收盤前還會變 → 訊號可能收盤就消失。
// ⭐ 正解:算一個**全域上界**,在**餵給偵測器之前**就把未收盤那根切掉
//    (⛔ 不能只做事後過濾 —— 偵測器吃到的本來就是那半根 K)。
// ⛔ 不必去算「前一個交易日是哪天」:過濾之後每一檔自己的最後一根就是它自己的前一交易日。
// 🧪 測試注入用(⛔ `|| ''` 不可省:排程/workflow 餵過來時是**空字串**不是不存在)
const _FORCE_ASOF = (process.env.SCAN_ASOF || '').trim();
const NOW = _FORCE_ASOF ? new Date(_FORCE_ASOF) : new Date();
if (isNaN(+NOW)) { console.error(`❌ SCAN_ASOF 解析不了:${_FORCE_ASOF}`); process.exit(1); }
const _tpe = (opt) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', ...opt }).format(NOW);
const TODAY_TPE = _tpe({ year: 'numeric', month: '2-digit', day: '2-digit' });
const _hm = _tpe({ hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
const NOW_MIN = +_hm[0] * 60 + +_hm[1];
// 台股 13:30 收盤,留 15 分緩衝(同 intraday_window「收盤那一拍」的作風)
const CLOSED_AT = 13 * 60 + 45;
const CLOSED = NOW_MIN >= CLOSED_AT;
// 非 null = 這一天(含)以後的列都不收
const MAX_DATE_EXCL = CLOSED ? null : TODAY_TPE;
// ══════════════════════════════════════════════════════════════════════════

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
            // 🚨 未收盤的今天那一根**整根不可用**(見上面陷阱 #14 那段)。
            //   ⚠️ 這道過濾必須排在下面 `>= 120` 那道門檻**之前** —— 切完不足 120 根就該跳過,
            //      ⛔ 不可放行(偵測器算不準,而且完全不會報錯)。
            if (MAX_DATE_EXCL && d >= MAX_DATE_EXCL) continue;
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
let used = 0;
// 🚨 陷阱 #14:⛔ 不可用「全市場最大日期」當 data_date ——
//    只要有少數股票已寫入**當天未完成的盤中列**,max 就會被那幾檔綁架。
//    實測 2026-09-10 台北 10:16 那輪:96.2% 的股票最後一根是 09/09(昨天收盤),
//    但 2.8%(11/400)有 09/10 的盤中列 → data_date 變成 09-10,
//    而前端寫「📅 09/10 收盤資料」—— 那天根本還沒收盤,榜上每一筆其實都是 09/09。
// ⭐ 改用**眾數**(絕大多數股票的最後一根是哪天),並把佔比一起輸出當佐證。
const dateCnt = new Map();
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
    dateCnt.set(last.date, (dateCnt.get(last.date) || 0) + 1);
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
// ⭐ data_date = 最後一根 K 的**眾數**(⛔ 不是 max,見上面陷阱 #14 那段)
//    同票數時取比較新的那天(降序),避免結果隨 Map 插入順序飄動。
const dateRank = [...dateCnt.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? 1 : -1));
const dataDate = dateRank.length ? dateRank[0][0] : null;
const dataDateN = dateRank.length ? dateRank[0][1] : 0;

// 🚨 只收「最後一根就是 data_date」的訊號 —— 兩種要剔除的:
//   ① 停牌/資料落後的股票:它的最後一根是好幾天前,卻被當成「今天的訊號」
//      (實測 2026-09-10 那輪,60 筆裡有 1 筆是 **09-04** 的,停牌 5 天)
//   ② 已寫入當天盤中列的那 2.8%:那根還沒收盤,拿它算訊號等於用半根 K
// ⭐ 剔除幾筆一定要印出來(那是「這道守門真的有跑到」的佐證)——
//    ⛔ 靜默過濾會讓「沒東西可剔」跟「守門失效」長得一模一樣。
const _keep = r => !dataDate || r.d === dataDate;
const bullDrop = bull.length, riskDrop = risk.length;
const bullKept = bull.filter(_keep), riskKept = risk.filter(_keep);
const droppedStale = (bullDrop - bullKept.length) + (riskDrop - riskKept.length);
bull.length = 0; bull.push(...bullKept);
risk.length = 0; risk.push(...riskKept);

bull.sort((a, b) => (b.exp - a.exp) || (b.v - a.v));

const out = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    data_date: dataDate,
    // ⭐ 佐證欄位(⛔ 別拿掉):讓人一眼看出 data_date 是不是被少數盤中列綁架
    data_date_n: dataDateN,                                    // 眾數那天有幾檔
    data_date_pct: used ? Math.round(dataDateN / used * 1000) / 10 : null,
    dropped_stale: droppedStale,                               // 剔除幾筆「不是當日」的
    // ⭐ 這兩個是「未收盤那根有沒有被切掉」的佐證(⛔ 別拿掉)——
    //   `bar_closed:false` 就代表 data_date 是**上一個交易日**,顯示端要照實講。
    bar_closed: CLOSED,                                        // 產出當下台北是否已收盤(13:45 後)
    cutoff: MAX_DATE_EXCL,                                     // null=沒切;否則=被整根排除的那一天
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
log(`   📅 資料日期 ${out.data_date}(${out.data_date_n}/${used} 檔 = ${out.data_date_pct}% 的最後一根是這天)`);
if (droppedStale) log(`   🧹 剔除 ${droppedStale} 筆「最後一根不是 ${out.data_date}」的(停牌落後 / 當天未完成的盤中列)`);
else log(`   🧹 剔除 0 筆(全部訊號都落在 ${out.data_date})`);
// 🚨 這兩行是「切未收盤那根」有沒有跑到的唯一佐證 —— ⛔ 靜默通過會讓失效跟正常長得一模一樣
if (CLOSED) log(`   🔔 台北 ${_hm[0]}:${_hm[1]}(已收盤)→ 不切,${TODAY_TPE} 那根照用`);
else log(`   🔔 台北 ${_hm[0]}:${_hm[1]}(**未收盤**)→ 已把 ${MAX_DATE_EXCL} 那根整根切掉,榜上是上一個交易日的收盤訊號`);
if (out.data_date_pct != null && out.data_date_pct < 50) log(`   ⚠️ 眾數只佔 ${out.data_date_pct}% → 資料日期不集中,顯示端要當心`);
if (out.bull.length) {
    log('\n🏆 期望值最高的 8 檔:');
    for (const b of out.bull.slice(0, 8)) log(`   ${b.s} ${String(b.c).padStart(8)}  ${b.t}  期望 ${b.exp >= 0 ? '+' : ''}${b.exp}% ・勝率 ${b.w}% ・${b.n} 次`);
}
log(`\n💾 已寫 data/today_signals.json`);
