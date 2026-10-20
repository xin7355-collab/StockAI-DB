#!/usr/bin/env node
/**
 * 📊 全訊號勝率回測引擎(V71.9.9)
 *
 * 使用者要求:「K線頁面及總覽頁面只把**有用的、勝率高的**資料顯示出來,
 *   讓使用者一看就知道怎麼操作勝率才會高,不要所有資料都打出來根本不知道看哪一個。
 *   所以這部分你要幫我都做一個測試、做一個回測。」
 *
 * ⭐ 核心設計決定:**跑真正的 JS 偵測器**,⛔ 不在 Python/測試裡複製一份判定邏輯。
 *    (test_lowsample 那次的教訓:複製一份會變成第二份真相,程式改了回測還是綠的。)
 *    做法:headless 載入 index.html,逐根 K 餵歷史切片給 app._detectXxx(),
 *    收集它吐出的訊號,再算之後 5/10/20 日的**超額報酬**(已扣同期加權指數)。
 *
 * 方法論(照 CLAUDE.md 的四點鐵則):
 *   ① **乾淨對照組**:同一批股票「隨便挑一天」當基準 → 每個訊號報的是「比不看訊號好多少」,⛔ 不是絕對報酬
 *      🚨 V79.4.3 改成「**同一天**」(陷阱 #50):每一筆訊號減掉**同一個交易日**所有掃到的股票的中位數;
 *         p 值的虛無假設也用「那幾天各自的基準勝率」平均。⛔ 不再拿整段平均比 ——
 *         16 年裡中位數個股跑輸加權的幅度每年差很多,訊號集中在某幾年時,整段平均會憑空造出「邊際」。
 *   ② **扣掉同期大盤**(broker_habit 那次的教訓:窗口內大盤 −8.4%,不扣結論會相反)
 *   ③ **事件去重**:同一檔同一訊號 5 個交易日內只算一次
 *   ④ **樣本守門 + 統計檢定**:n<30 不下結論;用二項式尾機率算「這個勝率是不是運氣」
 *      (直接呼叫 App 內既有的 app._winRateP,同一套標準)
 *   ⑤ V79.4.3 **買不到的不算**:訊號當天收盤停在漲停(2015-06 前 ±7%,lib_limit)→「今天尾盤買」買不到,
 *      事件與對照組同一條一起剔除;**持有窗口碰到價格斷崖**(×1.5 / ×0.67,lib_cliff)→ 那個天期不算(⛔ 不整檔剔除)
 *   ⑥ V79.4.3 偵測器只看**最近 WIN 根**(預設 1,200 = App 那份 K 線的上限,採礦 LIMIT 1200),
 *      指標陣列同步切到同一段 → 16 年資料也跟 App 看到的長度一樣,而且偵測器怎麼索引都不會讀到未來
 *
 * 輸出:data/signal_edge.json —— 供前端決定「哪些訊號才顯示、怎麼排序」。
 *
 * 跑法:node scripts/signal_backtest.mjs [股票數上限]   (PAGES=3 同時開 3 個頁面跑;SIG_WIN=1200)
 *       node scripts/signal_backtest.mjs --selftest   (不開瀏覽器,驗統計那一段)
 */
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { regrade } from './lib_fdr.mjs';
import { upLimitClose } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');   // V77.7.0:可指到修好的資料夾(陷阱 #46 重跑用)
const SELFTEST = process.argv.includes('--selftest');
// 🐛 V72.1.7 預設改成**全市場**。舊版預設只取「代號排序的前 N 檔」——
//   實測 500 檔那版**完全沒有 3xxx~9xxx**(佔全市場 1,744 檔 = 74%),
//   大立光 3008 / 矽力 6415 / 緯創 3231 這些重要電子股全部缺席。
//   ⛔「500 檔」聽起來樣本很大,實際上只涵蓋 1xxx~2xxx 的傳產金融 —— 那是**選樣偏誤**。
//   ⭐ 通用:任何「取前 N 檔」的抽樣,都要先問「排序之後前 N 是不是有系統性偏向」。
const MAX_SYMS = +(process.argv.slice(2).find(a => /^\d+$/.test(a)) || 99999);
const STEP = 2;              // 每 2 根 K 掃一次(降計算量;訊號本來就不是天天有)
const DEDUP = 5;             // 同檔同訊號 5 日內只算一次
const HORIZONS = [5, 10, 20];
const MIN_N = 30;
const MIN_CTRL = 30;         // 同一天的對照組至少要這麼多「股·日」才算得出那天的基準(⛔ 不拿別天湊)
const WIN = Math.max(260, +(process.env.SIG_WIN || 1200));
const PAGES = Math.max(1, Math.min(6, +(process.env.PAGES || 3)));

const log = s => console.log(s);

// ── 純函式(selftest 直接測;⛔ 主程式也只用這幾支,不另寫一份) ─────────────
export const med = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const winPct = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : 0;

/** 一筆「股·日」的超額報酬(各天期);買不到 / 碰到斷崖的照規則剔除。rows 是舊→新;pre = cliffPrefix(...)。 */
export function eventEx(rows, i, twii, pre, horizons = HORIZONS) {
    const d0 = rows[i].date;
    if (!(twii[d0] > 0)) return { skip: 'twii' };
    if (i > 0 && upLimitClose(d0, rows[i].close, rows[i - 1].close)) return { skip: 'lu' };   // 收盤停在漲停 → 尾盤買不到
    const ex = {}; let cliff = 0, any = false;
    for (const h of horizons) {
        const j = i + h;
        if (j >= rows.length) continue;
        const d1 = rows[j].date;
        if (!(twii[d1] > 0)) continue;
        if (cliffIn(pre, i, j)) { cliff++; continue; }                                        // 持有窗口碰到斷崖 → 這個天期不算
        ex[h] = (rows[j].close - rows[i].close) / rows[i].close * 100 - (twii[d1] - twii[d0]) / twii[d0] * 100;
        any = true;
    }
    return any ? { ex, cliff } : { skip: cliff ? 'cliff' : 'end', cliff };
}

/** 每一天的對照組:中位數 + 勝率(小數);那天樣本 < minCtrl → 不算(⛔ 不拿別天湊)。byDate: Map(date → number[]) */
export function dateBase(byDate, minCtrl = MIN_CTRL) {
    const out = new Map();
    for (const [d, arr] of byDate) if (arr.length >= minCtrl) out.set(d, { med: med(arr), mean: arr.reduce((s, x) => s + x, 0) / arr.length, win: winPct(arr) / 100, n: arr.length });
    return out;
}

/** 一個訊號的統計:邊際 = 每一筆減「同一天」對照組中位數後的中位數;p0 = 每一筆那天的對照組勝率平均。
 *  ev = { d: [日期], x: {5:[..],10:[..],20:[..]} };db = {5: Map, 10: Map, 20: Map}(dateBase 的結果) */
export function sigStats(ev, db, horizons = HORIZONS) {
    const r = { drop: 0, p0: null };
    for (const h of horizons) {
        const raw = [], adj = [], rel = []; let ps = 0, pn = 0;
        for (let k = 0; k < ev.d.length; k++) {
            const v = ev.x[h][k];
            if (v == null) continue;
            const b = db[h].get(ev.d[k]);
            if (!b) { if (h === 10) r.drop++; continue; }
            raw.push(v); adj.push(v - b.med); rel.push(v - b.mean);
            if (h === 10) { ps += b.win; pn++; }
        }
        r[`raw${h}`] = raw; r[`adj${h}`] = adj; r[`rel${h}`] = rel;
        if (h === 10) r.p0 = pn ? ps / pn : null;
    }
    return r;
}

/** 指標陣列切到跟 K 線同一段(off..end),非陣列欄位照搬。 */
export function sliceInd(ind, off, end, arrKeys) {
    const v = {};
    for (const k in ind) v[k] = arrKeys.has(k) ? ind[k].slice(off, end) : ind[k];
    return v;
}

// ── selftest ─────────────────────────────────────────────────────────
if (SELFTEST) {
    let bad = 0;
    const ok = (name, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + JSON.stringify(x)}`); if (!c) bad++; };
    // ① 決定性對照:兩段行情(前段中位數個股每 10 天輸大盤 3%、後段贏 1%),訊號只在前段出現、報酬跟大家一模一樣
    {
        const byDate = new Map(), ev = { d: [], x: { 5: [], 10: [], 20: [] } };
        let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let t = 0; t < 400; t++) {
            const d = `2012-${String(1 + (t >> 5)).padStart(2, '0')}-${String(t % 28 + 1).padStart(2, '0')}#${t}`;
            const mu = t < 200 ? -3 : 1, arr = [];
            for (let s = 0; s < 60; s++) arr.push(mu + (rnd() - 0.5) * 8);
            byDate.set(d, arr);
            if (t < 200 && t % 2 === 0) { ev.d.push(d); for (const h of HORIZONS) ev.x[h].push(arr[t % 60]); }
        }
        const db = {}; for (const h of HORIZONS) db[h] = dateBase(byDate);
        const st = sigStats(ev, db);
        const all = [...byDate.values()].flat();
        const old = med(st.raw10) - med(all), neu = med(st.adj10);
        ok(`① 決定性對照:整段平均憑空 ${old.toFixed(2)}pp(< −1)、同一天對照 ${neu.toFixed(2)}pp(≈ 0)`, old < -1 && Math.abs(neu) < 0.6, { old, neu });
        const pAll = winPct(all) / 100;
        ok(`① p0 用那幾天的基準勝率(${st.p0.toFixed(3)})⛔ 不是整段(${pAll.toFixed(3)})`, Math.abs(st.p0 - pAll) > 0.1 && st.p0 < 0.2, { p0: st.p0, pAll });
        const xr = st.rel10.reduce((s, x) => s + x, 0) / st.rel10.length, rawMean = st.raw10.reduce((s, x) => s + x, 0) / st.raw10.length;
        ok(`① 相對期望值(減同一天平均)${xr.toFixed(2)} ≈ 0、絕對平均 ${rawMean.toFixed(2)} 是負的(那幾天大家都輸)`, Math.abs(xr) < 0.6 && rawMean < -2, { xr, rawMean });
    }
    // ② 那天樣本不夠 → 不算、計入 drop
    {
        const byDate = new Map([['A', Array(40).fill(1)], ['B', Array(10).fill(5)]]);
        const db = {}; for (const h of HORIZONS) db[h] = dateBase(byDate);
        const st = sigStats({ d: ['A', 'B', 'B'], x: { 5: [2, 9, 9], 10: [2, 9, 9], 20: [2, 9, 9] } }, db);
        ok('② 對照組 <30 筆的那天不算(drop=2)、其餘照算', db[10].size === 1 && st.drop === 2 && st.raw10.length === 1 && st.adj10[0] === 1, st);
    }
    // ③ 買不到 / 斷崖
    {
        const mk = (dates, closes) => dates.map((d, k) => ({ date: d, open: closes[k], high: closes[k], low: closes[k], close: closes[k], volume: 1 }));
        const ds = Array.from({ length: 40 }, (_, k) => `2012-03-${String(k + 1).padStart(2, '0')}`);
        const tw = Object.fromEntries(ds.map(d => [d, 100]));
        const c1 = ds.map((_, k) => 100);
        c1[10] = 106.8;                                                         // 2012 年 +6.8% = 漲停(±7% 制度)
        const r1 = mk(ds, c1);
        ok('③ 2012 年收盤 +6.8% = 停在漲停 → 尾盤買不到(剔除)', eventEx(r1, 10, tw, cliffPrefix(c1)).skip === 'lu');
        const ds2 = ds.map(d => d.replace('2012', '2020'));
        const tw2 = Object.fromEntries(ds2.map(d => [d, 100]));
        ok('③ 同一根放到 2020 年(±10% 制度)→ 照算', !eventEx(mk(ds2, c1), 10, tw2, cliffPrefix(c1)).skip);
        const c3 = ds.map((_, k) => (k < 18 ? 100 : 160));                      // 第 18 根 ×1.6 斷崖
        const e3 = eventEx(mk(ds2, c3), 10, tw2, cliffPrefix(c3));
        ok('③ 持有窗口碰到斷崖:5 日照算、10 / 20 日不算', e3.ex && e3.ex[5] === 0 && e3.ex[10] === undefined && e3.ex[20] === undefined && e3.cliff === 2, e3);
        const e4 = eventEx(mk(ds2, c3), 2, tw2, cliffPrefix(c3));
        ok('③ 斷崖在窗口外 → 不影響', e4.ex && e4.ex[5] === 0 && e4.ex[10] === 0, e4);
    }
    // ④ 指標陣列同步切
    {
        const ind = { k: [0, 1, 2, 3, 4, 5], x: 'meta', dif: [10, 11, 12, 13, 14, 15] };
        const v = sliceInd(ind, 2, 5, new Set(['k', 'dif']));
        ok('④ 指標切到 off..end:長度 = K 線那段、最後一個 = 當天(不會讀到未來)', v.k.length === 3 && v.k[2] === 4 && v.dif[0] === 12 && v.x === 'meta', v);
    }
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ SIGNAL_BACKTEST_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

// ── 主程式 ────────────────────────────────────────────────────────────
// ⚙️ V77.3.5 playwright 來源:本機開發是絕對路徑、CI(weekly_backtest.yml)是 node_modules —— 同 playbook_scan.mjs 的做法
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

// 43 個偵測器裡「純吃 data(OHLCV)」的那些 —— 其餘需要籌碼/指標快取,歷史回測餵不了,誠實排除
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

// ── 讀 data/ ────────────────────────────────────────────────
function loadSeries(p) {
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : null);
        if (!rows) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-');
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out.length >= 320 ? out : null;
    } catch (_) { return null; }
}

const twiiRows = loadSeries(path.join(DATA, '^TWII.json'));
if (!twiiRows) { console.log('❌ 找不到 ^TWII.json'); process.exit(2); }
const TWII = Object.fromEntries(twiiRows.map(r => [r.date, r.close]));

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort().slice(0, MAX_SYMS);
log(`📂 掃描 ${files.length} 檔,上限 ${MAX_SYMS >= 99999 ? '全市場(不設限)' : '前 ' + MAX_SYMS + ' 檔'} ・偵測器看最近 ${WIN} 根 ・${PAGES} 個頁面平行`);

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });   // CI 沒這支 → 用 playwright 自帶的
const pages = [];
for (let k = 0; k < PAGES; k++) {
    const page = await browser.newPage();
    page.on('pageerror', () => {});
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._detectStarPatterns, null, { timeout: 25000 });
    pages.push(page);
}

// 只留頁面上真的存在的偵測器(避免打錯名字靜默略過)
const alive = await pages[0].evaluate(ds => ds.filter(d => typeof app[d] === 'function'), DETECTORS);
log(`🔎 偵測器:${alive.length}/${DETECTORS.length} 存在` +
    (alive.length < DETECTORS.length ? `(缺:${DETECTORS.filter(d => !alive.includes(d)).join(',')})` : ''));

// key -> {tone, d:[日期], x:{h:[超額% | null]}}
const acc = new Map();
const baseByDate = { 5: new Map(), 10: new Map(), 20: new Map() };   // 對照組:同一天所有掃到的「股·日」
const baseAll = { 5: [], 10: [], 20: [] };                          // 整段(只拿來印出新舊口徑的差,⛔ 不再當基準)
const skip = { lu: 0, cliff: 0, twii: 0, end: 0 };
let used = 0, t0 = Date.now(), dMin = '9999', dMax = '0000';
const usedPrefix = {};   // ⭐ V72.1.7 代號開頭分布,用來自我檢查有沒有選樣偏誤

async function runStock(page, rows) {
    // 一次把整檔丟進瀏覽器跑完(避免每根 K 都跨 IPC)
    return page.evaluate(async ({ rows, dets, step, win }) => {
        // 🔧 V77.7.0:讀 `this.indicators` 的偵測器(量能動能發動 OBV×MACD×量、權值股反彈…)以前在這裡
        //    **永遠拿到空物件 → 一次都不觸發**,於是 K 線頁置頂顯示的訊號從來沒有成績。
        //    ⭐ 用 App **真的那支 worker**(masterWorkerCode)算一次整檔指標(⛔ 不複製公式);指標全是因果的。
        if (!window.__btWorker) window.__btWorker = new Worker(URL.createObjectURL(new Blob([masterWorkerCode], { type: 'application/javascript' })));
        const ind = await new Promise(res => {
            const t = setTimeout(() => res({}), 15000);
            window.__btWorker.onmessage = e => { clearTimeout(t); res(e.data || {}); };
            window.__btWorker.postMessage({ activeData: rows, marketCtx: null });
        });
        window.__btIndOk = (window.__btIndOk || 0) + (Array.isArray(ind.dif) ? 1 : 0);
        // ⭐ V79.4.3 指標陣列跟 K 線切到同一段(off..i+1):偵測器不管用哪種索引都讀不到未來
        const arrKeys = new Set(Object.keys(ind).filter(k => Array.isArray(ind[k]) && ind[k].length === rows.length));
        const out = [];
        for (let i = 250; i < rows.length - 20; i += step) {
            const off = Math.max(0, i + 1 - win);
            const slice = rows.slice(off, i + 1);
            const v = {};
            for (const k in ind) v[k] = arrKeys.has(k) ? ind[k].slice(off, i + 1) : ind[k];
            app.indicators = v;
            app.rawDailyData = slice;
            app.currentSymbolId = 'BT';
            const names = [];
            for (const d of dets) {
                let r;
                try { r = app[d](slice); } catch (_) { continue; }
                if (!Array.isArray(r)) continue;
                for (const s of r) {
                    if (!s || !s.title) continue;
                    names.push([`${d}｜${String(s.title).slice(0, 28)}`, s.tone || '']);
                }
            }
            out.push([i, names]);
        }
        return out;
    }, { rows, dets: alive, step: STEP, win: WIN });
}

function absorb(rows, fired) {
    const pre = cliffPrefix(rows.map(r => r.close), rows.map(r => r.open));
    const lastSeen = new Map();
    for (const [i, names] of fired) {
        const e = eventEx(rows, i, TWII, pre);
        if (e.skip) { skip[e.skip] += e.skip === 'cliff' ? e.cliff : 1; continue; }
        skip.cliff += e.cliff || 0;
        const d0 = rows[i].date;
        if (d0 < dMin) dMin = d0;
        if (d0 > dMax) dMax = d0;
        // ① 對照組 = **所有掃到的交易日**(不是「沒訊號的日子」),而且按**日期**分開存(V79.4.3 同一天對照)。
        //    ⭐ 為什麼不用「當天沒訊號」:實測那種日子少到只有個位數 —— 40 個偵測器讓幾乎每一天都有東西在叫。
        for (const h of HORIZONS) if (e.ex[h] != null) {
            let arr = baseByDate[h].get(d0);
            if (!arr) baseByDate[h].set(d0, (arr = []));
            arr.push(e.ex[h]);
            baseAll[h].push(e.ex[h]);
        }
        if (!names.length) continue;
        for (const [key, tone] of names) {
            const prev = lastSeen.get(key);
            if (prev != null && i - prev < DEDUP) continue;   // ③ 事件去重
            lastSeen.set(key, i);
            let a = acc.get(key);
            if (!a) { a = { tone, d: [], x: { 5: [], 10: [], 20: [] } }; acc.set(key, a); }
            a.d.push(d0);
            for (const h of HORIZONS) a.x[h].push(e.ex[h] ?? null);
        }
    }
}

let next = 0;
await Promise.all(pages.map(async page => {
    while (next < files.length) {
        const f = files[next++];
        const rows = loadSeries(path.join(DATA, f));
        if (!rows) continue;
        let fired;
        try { fired = await runStock(page, rows); } catch (e) { continue; }
        used++;
        usedPrefix[f[0]] = (usedPrefix[f[0]] || 0) + 1;
        absorb(rows, fired);
        if (used % 50 === 0) log(`   …${used} 檔 / ${Math.round((Date.now() - t0) / 1000)}s / 訊號種類 ${acc.size}`);
    }
}));

log('');
log(`✅ ${used} 檔 ・訊號種類 ${acc.size} ・耗時 ${Math.round((Date.now() - t0) / 1000)}s ・實際窗口 ${dMin} ~ ${dMax}`);
log(`🚧 剔除:收盤停在漲停(尾盤買不到)${skip.lu.toLocaleString()} 股·日 ・持有窗口碰到斷崖 ${skip.cliff.toLocaleString()} 個天期 ・加權沒那天 ${skip.twii.toLocaleString()}`);
{   // 🚧 V77.7.0 空過守門:worker 指標一檔都沒算出來 = 讀指標的偵測器又回到「永遠不觸發」(⛔ 不可讀成沒成績)
    const indOk = (await Promise.all(pages.map(p => p.evaluate(() => window.__btIndOk || 0)))).reduce((s, x) => s + x, 0);
    log(`🔧 worker 指標算得出來:${indOk}/${used} 檔`);
    if (used > 0 && indOk === 0) { console.log('❌ worker 指標一檔都沒算出來 → 讀 this.indicators 的偵測器全部失效'); process.exit(1); }
}

const DB = {}; for (const h of HORIZONS) DB[h] = dateBase(baseByDate[h]);
// 🚧 空過守門:沒有一天湊得到同一天對照組 → 算不出任何邊際(⛔ 不可寫出一份全部 0 個訊號的檔蓋掉上一版)
if (!DB[10].size) { console.log(`❌ 沒有任何一天有 ≥${MIN_CTRL} 筆對照(股票太少?)→ 不寫檔`); await browser.close(); process.exit(1); }
const baseMed = Object.fromEntries(HORIZONS.map(h => [h, med(baseAll[h])]));
const baseWin = Object.fromEntries(HORIZONS.map(h => [h, winPct(baseAll[h])]));
log(`📐 對照組:${baseAll[10].length.toLocaleString()} 股·日 ・${DB[10].size.toLocaleString()} 個交易日(每天 ≥${MIN_CTRL} 筆)・整段 10 日中位 ${baseMed[10].toFixed(2)}% ・勝率 ${baseWin[10].toFixed(1)}%`);
log('   ⭐ V79.4.3 每個訊號的「邊際」= 每一筆減「同一天」對照組中位數(⛔ 不再減整段 —— 陷阱 #50)');
log('');

// ④ 統計檢定:直接用 App 內既有的 _winRateP(同一套標準,⛔ 不另寫一份)
const rows = [];
let dropped = 0, flips = 0;
for (const [key, a] of acc) {
    const st = sigStats(a, DB);
    dropped += st.drop;
    const n = st.raw10.length;
    if (n < MIN_N) continue;
    const r = { key, tone: a.tone, n };
    for (const h of HORIZONS) {
        r[`m${h}`] = +med(st[`raw${h}`]).toFixed(3);
        r[`w${h}`] = +winPct(st[`raw${h}`]).toFixed(1);
        r[`e${h}`] = +med(st[`adj${h}`]).toFixed(3);                        // 邊際(同一天對照)
    }
    r.e10_all = +(med(st.raw10) - baseMed[10]).toFixed(3);                  // 舊口徑(整段),只留著比對
    // ⭐ V79.4.3 相對期望值 = 每一筆減「同一天隨便挑一檔的平均」再取平均 —— 16 年裡「隨便挑一檔」本身的期望值不一定是負的,
    //    只看 exp > 0(對加權)會把「比隨便買一檔還差」的訊號也放進來 → 兩個都印,App 要用哪個由人判
    r.xr = +(st.rel10.reduce((s, x) => s + x, 0) / Math.max(1, st.rel10.length)).toFixed(3);
    if (Math.sign(r.e10) !== Math.sign(r.e10_all) && Math.abs(r.e10 - r.e10_all) > 0.2) flips++;
    r.p0 = +(st.p0 * 100).toFixed(1);
    // ⭐ V72.0.3 賺賠比 + 期望值 —— 巨人傑逐字稿:「**賺賠比遠比勝率來得重要**」。
    //   ・payoff  = 平均獲利 ÷ 平均虧損(>1 = 賺的比賠的大)
    //   ・exp     = 期望值 = 勝率×平均獲利 − 敗率×平均虧損(⭐ 這才是最終該看的數字)
    //   ⚠️ 都是**超額報酬**口徑(已扣同期加權),所以「獲利/虧損」是相對大盤而言。
    {
        const v = st.raw10;
        const wins = v.filter(x => x > 0), losses = v.filter(x => x <= 0);
        const aw = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
        const al = losses.length ? Math.abs(losses.reduce((s, x) => s + x, 0) / losses.length) : 0;
        r.aw = +aw.toFixed(3);
        r.al = +al.toFixed(3);
        r.payoff = al > 0 ? +(aw / al).toFixed(2) : null;
        r.exp = +((wins.length / v.length) * aw - (losses.length / v.length) * al).toFixed(3);
    }
    rows.push(r);
}
// ⭐ 虛無假設 = **那個訊號出現的那幾天**各自的基準勝率平均(⛔ 不是 50%,也⛔ 不再是整段的基準)
const withP = await pages[0].evaluate(rs => rs.map(r => ({
    ...r, p: +(app._winRateP(Math.round(r.w10 / 100 * r.n), r.n, r.p0 / 100) || 1).toFixed(4),
})), rows);
// 📊 V77.5.5 分級走 lib_fdr(A = BH 校正後 q ≤ 0.05 ・B = p ≤ 0.25 ・C 其他)——
//    一次檢定 129 個訊號,不校正的話純雜訊也會有 ~6 個被評成 A。⛔ 別退回裸 p(test_sigedge 釘住)。
regrade(withP);
const _gi = g => (g === 'A' ? 0 : g === 'B' ? 1 : 2);
// 排序:先看統計信心,同級再看邊際 —— 使用者要的是「勝率高且站得住腳」
withP.sort((a, b) => (_gi(a.grade) - _gi(b.grade)) || (b.e10 - a.e10));
for (const r of withP) r.base_win = r.p0;
const nA = withP.filter(r => r.grade === 'A').length;
const nB = withP.filter(r => r.grade === 'B').length;

log(`🏅 分級:A(多重比較校正後站得住腳,BH q≤0.05)= ${nA} 個 ・B(偏弱,p≤0.25)= ${nB} 個 ・C(跟隨機沒差)= ${withP.length - nA - nB} 個`);
log(`🔁 新舊口徑(同一天 vs 整段)邊際方向相反的訊號 ${flips} 個 ・對照組不夠被丟掉的訊號筆數 ${dropped.toLocaleString()}`);
log('');
const fmt = r => `${(r.grade + ' ' + r.key).slice(0, 46).padEnd(48)}`
    + `${String(r.n).padStart(6)}`
    + `${((r.e10 >= 0 ? '+' : '') + r.e10.toFixed(2) + '%').padStart(9)}`
    + `${((r.e10_all >= 0 ? '+' : '') + r.e10_all.toFixed(2) + '%').padStart(9)}`
    + `${(r.w10.toFixed(1) + '%').padStart(8)}`
    + `${(r.p0.toFixed(1) + '%').padStart(7)}`
    + `${r.p.toFixed(3).padStart(8)}`;
log(`${'級 訊號'.padEnd(48)}${'n'.padStart(6)}${'10日邊際'.padStart(9)}${'(舊口徑)'.padStart(9)}${'勝率'.padStart(8)}${'基準'.padStart(7)}${'p值'.padStart(8)}${'賺賠比'.padStart(8)}${'期望值'.padStart(9)}`);
for (const r of withP.slice(0, 30)) log(fmt(r)
    + `${(r.payoff == null ? '—' : r.payoff.toFixed(2)).padStart(7)}`
    + `${((r.exp >= 0 ? '+' : '') + r.exp.toFixed(2) + '%').padStart(9)}`);
log('   …(完整清單見 signal_edge.json)');
log('');
log('⚠️ 「勝率」是**超額報酬為正**的比例,基準 = 那個訊號出現那幾天的「隨便挑一檔」勝率(每個訊號不同)。');
log('⭐ 「賺賠比」= 平均獲利 ÷ 平均虧損;「期望值」= 勝率×平均獲利 − 敗率×平均虧損。');
log('   ⚠️ 低勝率但高賺賠比也可能是好訊號(巨人傑:「賺賠比遠比勝率重要」)→ ⛔ 別只看勝率。');
{
    const byExp = [...withP].sort((a, b) => b.exp - a.exp).slice(0, 8);
    log('');
    log('🏆 依**期望值**排(跟依勝率排會不一樣 —— 這正是重點):');
    for (const r of byExp) log(`   ${r.grade} ${r.key.slice(0, 40).padEnd(42)}`
        + `期望 ${(r.exp >= 0 ? '+' : '') + r.exp.toFixed(2)}%`.padStart(12)
        + `  勝率 ${r.w10.toFixed(1)}%  賺賠比 ${r.payoff == null ? '—' : r.payoff.toFixed(2)}`);
}
log('   p 值 = 假設這個訊號其實沒用,純靠運氣出現這種成績的機率(⚠️ 同一天很多檔一起亮不是獨立樣本,p 值偏樂觀)。');

const out = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    syms: used, step: STEP, dedup: DEDUP, min_n: MIN_N, win_bars_detector: WIN,
    // ⭐ V72.1.7 記錄「代號開頭分布」—— 日後一眼看得出樣本有沒有選樣偏誤
    //   (舊的 500 檔版本這裡會是 {0:10,1:238,2:252},完全沒有 3~9 開頭)
    cover: usedPrefix,
    // ⭐ V79.4.3 實際窗口(訊號日的最早 / 最晚),embed 用這個 ⛔ 不再去讀 data/^TWII.json 猜
    window: { from: dMin, to: dMax, days: DB[10].size },
    match: 'same-day', min_ctrl: MIN_CTRL, skip,
    base: { n: baseAll[10].length, med: baseMed, win: baseWin },
    grades: { A: nA, B: nB, C: withP.length - nA - nB },
    signals: withP,
};
fs.writeFileSync(path.join(DATA, 'signal_edge.json'), JSON.stringify(out), 'utf-8');
log(`\n💾 已寫 ${path.join(DATA, 'signal_edge.json')}(${withP.length} 個訊號通過樣本門檻)`);

await browser.close();
