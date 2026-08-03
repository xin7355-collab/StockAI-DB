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
 *   ① **乾淨對照組**:同一批股票、同一段期間「沒有任何訊號」的日子當基準
 *      → 每個訊號報的是「比不看訊號好多少」,⛔ 不是絕對報酬
 *   ② **扣掉同期大盤**(broker_habit 那次的教訓:窗口內大盤 −8.4%,不扣結論會相反)
 *   ③ **事件去重**:同一檔同一訊號 5 個交易日內只算一次
 *   ④ **樣本守門 + 統計檢定**:n<30 不下結論;用二項式尾機率算「這個勝率是不是運氣」
 *      (直接呼叫 App 內既有的 app._winRateP,同一套標準)
 *
 * 輸出:data/signal_edge.json —— 供前端決定「哪些訊號才顯示、怎麼排序」。
 *
 * 跑法:node scripts/signal_backtest.mjs [股票數上限]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 300);
const STEP = 2;              // 每 2 根 K 掃一次(降計算量;訊號本來就不是天天有)
const DEDUP = 5;             // 同檔同訊號 5 日內只算一次
const HORIZONS = [5, 10, 20];
const MIN_N = 30;

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

const log = s => console.log(s);

// ── 讀 data/ ────────────────────────────────────────────────
function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
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

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
log(`📂 掃描 ${files.length} 檔,取前 ${MAX_SYMS} 檔有效樣本`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._detectStarPatterns, null, { timeout: 25000 });

// 只留頁面上真的存在的偵測器(避免打錯名字靜默略過)
const alive = await page.evaluate(ds => ds.filter(d => typeof app[d] === 'function'), DETECTORS);
log(`🔎 偵測器:${alive.length}/${DETECTORS.length} 存在` +
    (alive.length < DETECTORS.length ? `(缺:${DETECTORS.filter(d => !alive.includes(d)).join(',')})` : ''));

// key -> {tone, hits:{h:[超額%]}, dates:[]}
const acc = new Map();
const base = { 5: [], 10: [], 20: [] };   // 對照組:所有掃到的交易日(見下方說明)
let used = 0, t0 = Date.now();

for (const f of files) {
    if (used >= MAX_SYMS) break;
    const rows = loadSeries(path.join(DATA, f));
    if (!rows) continue;
    used++;

    // 一次把整檔丟進瀏覽器跑完(避免每根 K 都跨 IPC)
    let fired;
    try {
        fired = await page.evaluate(({ rows, dets, step }) => {
            const out = [];
            for (let i = 250; i < rows.length - 20; i += step) {
                const slice = rows.slice(0, i + 1);
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
        }, { rows, dets: alive, step: STEP });
    } catch (e) { continue; }

    const lastSeen = new Map();
    for (const [i, names] of fired) {
        const d0 = rows[i].date;
        if (!(d0 in TWII)) continue;
        const ex = {};
        let okAny = false;
        for (const h of HORIZONS) {
            const j = i + h;
            if (j >= rows.length) continue;
            const d1 = rows[j].date;
            if (!(d1 in TWII) || !(TWII[d0] > 0)) continue;
            ex[h] = (rows[j].close - rows[i].close) / rows[i].close * 100
                  - (TWII[d1] - TWII[d0]) / TWII[d0] * 100;
            okAny = true;
        }
        if (!okAny) continue;
        // ① 對照組 = **所有掃到的交易日**(不是「沒訊號的日子」)。
        //    ⭐ 為什麼改:實測發現「當天完全沒有任何訊號」的日子少到只有個位數 ——
        //    40 個偵測器讓幾乎每一天都有東西在叫(這正是使用者抱怨「不知道看哪一個」的根因)。
        //    所以正確的基準是「隨便挑一天」,問題變成:這個訊號有沒有比隨便一天好?
        for (const h of HORIZONS) if (ex[h] != null) base[h].push(ex[h]);
        if (!names.length) continue;
        for (const [key, tone] of names) {
            const prev = lastSeen.get(key);
            if (prev != null && i - prev < DEDUP) continue;   // ③ 事件去重
            lastSeen.set(key, i);
            let a = acc.get(key);
            if (!a) { a = { tone, hits: { 5: [], 10: [], 20: [] } }; acc.set(key, a); }
            for (const h of HORIZONS) if (ex[h] != null) a.hits[h].push(ex[h]);
        }
    }
    if (used % 25 === 0) log(`   …${used} 檔 / ${Math.round((Date.now() - t0) / 1000)}s / 訊號種類 ${acc.size}`);
}

const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winPct = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : 0;

const baseMed = Object.fromEntries(HORIZONS.map(h => [h, med(base[h])]));
const baseWin = Object.fromEntries(HORIZONS.map(h => [h, winPct(base[h])]));
log('');
log(`✅ ${used} 檔 ・訊號種類 ${acc.size} ・耗時 ${Math.round((Date.now() - t0) / 1000)}s`);
log(`📐 對照組(所有掃到的交易日 = 隨便挑一天):n=${base[10].length} ・10日中位 ${baseMed[10].toFixed(2)}% ・勝率 ${baseWin[10].toFixed(1)}%`);
log(`   ⭐ 沒有用「當天沒訊號」當對照 —— 實測那種日子少到個位數,因為 40 個偵測器讓幾乎每天都有東西在叫。`);
log('   ⚠️ 每個訊號的「邊際」= 它的報酬 − 對照組報酬(⛔ 不是絕對報酬)');
log('');

// ④ 統計檢定:直接用 App 內既有的 _winRateP(同一套標準,⛔ 不另寫一份)
const rows = [];
for (const [key, a] of acc) {
    const n = a.hits[10].length;
    if (n < MIN_N) continue;
    const r = { key, tone: a.tone, n };
    for (const h of HORIZONS) {
        r[`m${h}`] = +med(a.hits[h]).toFixed(3);
        r[`w${h}`] = +winPct(a.hits[h]).toFixed(1);
        r[`e${h}`] = +(med(a.hits[h]) - baseMed[h]).toFixed(3);   // 邊際
    }
    rows.push(r);
}
// ⭐ 用**實測基準勝率**當虛無假設(不是 50%)——
//    「隨便挑一天」的勝率就有 baseWin[10]%,訊號要比那個好才算有東西。
//    ⛔ 用 50% 檢定會把訊號評得太好(基準只有 36% 左右)。
const p0 = baseWin[10] / 100;
const withP = await page.evaluate(({ rs, p0 }) => rs.map(r => ({
    ...r, p: +(app._winRateP(Math.round(r.w10 / 100 * r.n), r.n, p0) || 1).toFixed(4),
})), { rs: rows, p0 });
// 排序:先看統計信心(p 值),同級再看邊際 —— 使用者要的是「勝率高且站得住腳」
const grade = r => (r.p <= 0.05 ? 0 : r.p <= 0.25 ? 1 : 2);
withP.sort((a, b) => (grade(a) - grade(b)) || (b.e10 - a.e10));
for (const r of withP) {
    r.grade = grade(r) === 0 ? 'A' : grade(r) === 1 ? 'B' : 'C';   // A=站得住腳 B=偏弱 C=跟隨機沒差
    r.base_win = +baseWin[10].toFixed(1);
}
const nA = withP.filter(r => r.grade === 'A').length;
const nB = withP.filter(r => r.grade === 'B').length;

log(`🏅 分級:A(統計上站得住腳,p≤0.05)= ${nA} 個 ・B(偏弱,p≤0.25)= ${nB} 個 ・C(跟隨機沒差)= ${withP.length - nA - nB} 個`);
log('');
const fmt = r => `${(r.grade + ' ' + r.key).slice(0, 46).padEnd(48)}`
    + `${String(r.n).padStart(5)}`
    + `${((r.e10 >= 0 ? '+' : '') + r.e10.toFixed(2) + '%').padStart(9)}`
    + `${(r.w10.toFixed(1) + '%').padStart(8)}`
    + `${r.p.toFixed(3).padStart(8)}`;
log(`${'級 訊號'.padEnd(48)}${'n'.padStart(5)}${'10日邊際'.padStart(9)}${'勝率'.padStart(8)}${'p值'.padStart(8)}`);
for (const r of withP.slice(0, 30)) log(fmt(r));
log('   …(完整清單見 data/signal_edge.json)');
log('');
log(`⚠️ 「勝率」是**超額報酬為正**的比例,基準 = ${baseWin[10].toFixed(1)}%(隨便挑一天)。`);
log('   p 值 = 假設這個訊號其實沒用,純靠運氣出現這種成績的機率。');

const out = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    syms: used, step: STEP, dedup: DEDUP, min_n: MIN_N,
    base: { n: base[10].length, med: baseMed, win: baseWin },
    grades: { A: nA, B: nB, C: withP.length - nA - nB },
    signals: withP,
};
fs.writeFileSync(path.join(DATA, 'signal_edge.json'), JSON.stringify(out), 'utf-8');
log(`\n💾 已寫 data/signal_edge.json(${withP.length} 個訊號通過樣本門檻)`);

await browser.close();
