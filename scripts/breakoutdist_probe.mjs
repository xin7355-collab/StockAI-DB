#!/usr/bin/env node
/**
 * 📢 「多頭待發射」實測(V76.3.3)—— 使用者:「請重新檢視是否有用」
 *
 * 那張卡的主張很明確:把自選裡「打完底、還沒突破」的股票,**照『離上方壓力還差幾 %』由近到遠排**,
 * 排最前的「最可能先發動」。⭐ 所以要驗的是**兩件事**,⛔ 不是一件:
 *   ① 那個**漏斗**(有上方壓力 + 20 日振幅 ≤22% + 沒跌破雙均線)本身有沒有優勢?
 *      → 對照組 = **全市場隨便一天**(同一批股票、同一段期間)
 *   ② **距離排序**有沒有用?(近的真的比遠的好嗎)
 *      → 對照組 = **同一個漏斗裡的其他候選**(⛔ 不可拿全市場比 —— 那會把漏斗的功勞算到排序頭上)
 *
 * ⭐ 判定用的是**真正的 `app._chuResistanceZones`**(headless 載入 index.html 呼叫),
 *    ⛔ 不在這裡複製一份 —— 複製會變成第二份真相,程式改了回測還是綠的。
 *
 * ⛔ 六道關卡:對照組不抽樣 ・同檔 20 日去重 ・扣同期加權 ・前後半同向 ・逐年同向 ・扣成本 0.44%。
 * ⭐ 另外量一個**它自己宣稱的事**:「近的比較快發動」→ 未來 10 日內收盤有沒有真的站上那道壓力。
 *    (同 `overhead_probe` 的教訓:**穿不穿得過**跟**賺不賺得到**是兩件事,要分開報。)
 *
 * 🔁 V79.4.3(16 年 d16 重跑前修,陷阱 #50 / #52):
 *   ・對照組改成**同一天**:① 每一筆 − 同一天全部股票(每一根都算,⛔ 不抽樣)的平均;② 每一筆 − 同一天漏斗裡全部候選(⛔ 不去重)的平均;
 *     那天對照組 <30 筆 → 那一筆不算並計數。前後半(照日期)/ 逐年 / 去最好年都看這個超額
 *     (⛔ 舊版拿「整段的漏斗平均」相減,前後半 / 逐年也是 —— 事件擠在某幾年時那幾年的行情會被算成排序的功勞)
 *   ・進場是訊號日收盤 → 收盤停在漲停價(lib_limit,2015-06 前 ±7%)買不到:事件與兩個對照組都剔除
 *   ・斷崖只剔碰到的窗口(lib_cliff:往回 120 根的壓力區 + 抱的那幾天)
 *   ・讀 DATA_DIR(⛔ 舊版寫死 data/)
 *
 * 跑法:node scripts/breakoutdist_probe.mjs [股票數上限](或 MAX_SYMS=N)
 *      node scripts/breakoutdist_probe.mjs --selftest(⛔ 不開瀏覽器、不讀真資料)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { upLimitClose } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDirOf = env => env.DATA_DIR || path.join(ROOT, 'data');   // 🔁 V79.4.3 讀 DATA_DIR(d16 那份)
const DATA = dataDirOf(process.env);
const ARG = process.argv.slice(2).find(a => !a.startsWith('--'));
const MAX_SYMS = +(ARG || process.env.MAX_SYMS || 99999);
const SELFTEST = process.argv.includes('--selftest');
const STEP = 3;          // 每 3 根 K 掃一次(事件很多,降計算量)
const DEDUP = 20;        // 同檔 20 個交易日內只算一次
const HOR = [5, 10, 20];
const COST = 0.44;       // 來回成本 %
const MIN_N = 30;
const MIN_CTRL = 30;     // 🔁 V79.4.3 同一天對照組少於這麼多筆 → 那一筆不算(⛔ 不拿別天湊)
const LOOKBACK = 120;    // 🔁 V79.4.3 _chuResistanceZones 往回看 120 根 → 斷崖窗口的左端
const log = s => console.log(s);

// 事件桶:照「距壓力 %」分,門檻跟卡上的顏色門檻對齊(≤2 紅 / ≤5 琥珀 / 其餘灰)
const BUCKETS = [[0, 2, '≤2%(卡片標 🔥)'], [2, 5, '2~5%'], [5, 10, '5~10%'], [10, 60, '10~60%']];
const bucketOf = dist => BUCKETS.findIndex(([a, b]) => dist >= a && dist < b);

export function loadSeries(p) {
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

// ── 每一檔:對照組(兩個,依日期累加)+ 事件。acc = newAcc() ──
export const newAcc = () => ({ base: new Map(), funnel: new Map(), events: [], skip: { limit: 0, cliff: 0, ctrlBase: 0, ctrlFunnel: 0 } });
const addCtrl = (M, d, x) => {
    let a = M.get(d); if (!a) { a = {}; for (const h of HOR) a[h] = [0, 0]; M.set(d, a); }
    for (const h of HOR) if (x[h] != null) { a[h][0] += x[h]; a[h][1]++; }
};
/** 第 i 根收盤進場、抱 h 根的超額(扣同期加權);窗口碰到斷崖 / 加權沒那天 → null */
const retAt = (rows, pre, TWII, i, h) => {
    const d0 = rows[i].date, j = i + h; if (j >= rows.length) return null;
    if (cliffIn(pre, i, j)) return null;
    const d1 = rows[j].date; if (!(d1 in TWII) || !(TWII[d0] > 0)) return null;
    return (rows[j].close - rows[i].close) / rows[i].close * 100 - (TWII[d1] - TWII[d0]) / TWII[d0] * 100;
};
/** 🔁 V79.4.3 這一根能不能當進場點:收盤停在漲停價(2015-06 前 ±7%)= 買不到;往回 120 根的壓力區碰到斷崖 = 壓力是假的 */
const entryOk = (rows, pre, i, sk) => {
    if (upLimitClose(rows[i].date, rows[i].close, rows[i - 1].close)) { if (sk) sk.limit++; return false; }
    if (cliffIn(pre, i - LOOKBACK, i)) { if (sk) sk.cliff++; return false; }
    return true;
};

/** rows = loadSeries;fired = 漏斗候選 [[i, 距壓力%, 壓力價]](掃描點,STEP 根一個) */
export function processStock(rows, fired, TWII, acc) {
    const pre = cliffPrefix(rows.map(r => r.close), rows.map(r => r.open));
    // ① 的對照組:同一批股票的**每一根**(🔁 V79.4.3 同一天對照要密:每天的全部股票;⛔ 不抽樣)
    for (let i = 250; i < rows.length - 20; i++) {
        const d0 = rows[i].date; if (!(d0 in TWII)) continue;
        if (!entryOk(rows, pre, i, null)) continue;
        const x = {}; for (const h of HOR) x[h] = retAt(rows, pre, TWII, i, h);
        addCtrl(acc.base, d0, x);
    }
    // ② 的對照組:同一天漏斗裡的全部候選(⛔ 不去重)
    for (const [i, dist] of fired) {
        const d0 = rows[i].date; if (!(d0 in TWII) || bucketOf(dist) < 0) continue;
        if (!entryOk(rows, pre, i, null)) continue;
        const x = {}; for (const h of HOR) x[h] = retAt(rows, pre, TWII, i, h);
        addCtrl(acc.funnel, d0, x);
    }
    // 事件(同檔 20 日去重;買不到 / 斷崖的 ⛔ 不佔去重的位子)
    let lastHit = -999;
    for (const [i, dist, resist] of fired) {
        if (!entryOk(rows, pre, i, acc.skip)) continue;
        if (i - lastHit < DEDUP) continue;                          // 去重
        lastHit = i;
        const d0 = rows[i].date; if (!(d0 in TWII)) continue;
        const bi = bucketOf(dist);
        if (bi < 0) continue;
        // 🧱 穿不穿得過:未來 10 日收盤有沒有站上那道壓力(🔁 V79.4.3 那 10 天碰到斷崖 → 不算)
        const fwd = rows.slice(i + 1, i + 11);
        const brk = fwd.length >= 5 && !cliffIn(pre, i, i + 10) ? fwd.some(d => d.close > resist) : null;
        const x = {}; for (const h of HOR) x[h] = retAt(rows, pre, TWII, i, h);
        acc.events.push({ bi, i, d0, x, brk });
    }
}

// ── 彙總 ──
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const f2 = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—');
/** 🔁 V79.4.3 同一天超額:這一筆 − 同一天對照組的平均;對照組 <MIN_CTRL 筆 → null */
export const sameDay = (ev, h, M, minCtrl = MIN_CTRL) => {
    if (ev.x[h] == null) return null;
    const a = M.get(ev.d0); if (!a || a[h][1] < minCtrl) return null;
    return ev.x[h] - a[h][0] / a[h][1];
};
export function summarize(acc, minCtrl = MIN_CTRL) {
    const E = acc.events;
    const thinB = E.filter(e => e.x[10] != null && sameDay(e, 10, acc.base, minCtrl) == null).length;
    const thinF = E.filter(e => e.x[10] != null && sameDay(e, 10, acc.funnel, minCtrl) == null).length;
    const allDates = E.map(e => e.d0).sort();
    const mid = allDates[Math.floor(allDates.length / 2)] || '';
    let bn = 0, bs = 0; for (const a of acc.base.values()) { bs += a[10][0]; bn += a[10][1]; }
    const raw10 = E.map(e => e.x[10]).filter(v => v != null);
    const funnelEdge = mean(E.map(e => sameDay(e, 10, acc.base, minCtrl)).filter(v => v != null));
    const buckets = BUCKETS.map(([, , nm], bi) => {
        const ev = E.filter(e => e.bi === bi);
        const r = h => ev.map(e => e.x[h]).filter(v => v != null);
        const X = ev.map(e => [e.d0, sameDay(e, 10, acc.funnel, minCtrl)]).filter(([, v]) => v != null);
        const brkN = ev.filter(e => e.brk != null).length;
        const yr = {}; for (const [d, v] of X) (yr[d.slice(0, 4)] = yr[d.slice(0, 4)] || []).push(v);
        return { nm, n: ev.length, m5: mean(r(5)), m10: mean(r(10)), m20: mean(r(20)), d: mean(X.map(([, v]) => v)), nX: X.length,
            brk: brkN ? ev.filter(e => e.brk).length / brkN * 100 : NaN, brkN, yr, half: X };
    });
    // 六道關卡(對象:「≤2%」那一桶):全部都看「同一天、同一個漏斗」的超額
    const T = buckets[0], gates = [];
    gates.push([`樣本 n ≥ ${MIN_N}`, T.n >= MIN_N, `n=${T.n}`]);
    gates.push(['全期邊際為正', T.d > 0, `${f2(T.d)}pp`]);
    const hd1 = mean(T.half.filter(([d]) => d < mid).map(([, x]) => x)), hd2 = mean(T.half.filter(([d]) => d >= mid).map(([, x]) => x));
    gates.push(['前後半同向', hd1 > 0 && hd2 > 0, `前 ${f2(hd1)} / 後 ${f2(hd2)}`]);
    const yrs = Object.keys(T.yr).sort();
    const yd = yrs.map(y => [y, mean(T.yr[y])]);
    gates.push(['逐年同向', yd.length > 0 && yd.every(([, v]) => v > 0), yd.map(([y, v]) => `${y} ${f2(v)}`).join(' ・')]);
    const bestYear = yd.slice().sort((a, b) => b[1] - a[1])[0];
    const exBest = yrs.filter(y => y !== (bestYear || [])[0]).flatMap(y => T.yr[y]);
    gates.push(['去掉最好的一年仍成立', exBest.length > 0 && mean(exBest) > 0, `${f2(mean(exBest))}pp(去 ${(bestYear || ['—'])[0]})`]);
    gates.push([`扣成本 ${COST}pp 後仍為正`, T.d - COST > 0, `${f2(T.d - COST)}pp`]);
    return { allDates, mid, baseN: bn, baseM: bn ? bs / bn : NaN, funnelN: raw10.length, funnelM: mean(raw10), funnelEdge, buckets, gates, hd: [hd1, hd2], thinB, thinF };
}

async function main() {
    const twiiRows = loadSeries(path.join(DATA, '^TWII.json'));
    if (!twiiRows) { console.log(`❌ 找不到 ^TWII.json(${DATA})`); process.exit(2); }
    const TWII = Object.fromEntries(twiiRows.map(r => [r.date, r.close]));

    const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
    log(`📂 掃描 ${files.length} 檔(${DATA})`);

    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    page.on('pageerror', () => {});
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._chuResistanceZones === 'function', null, { timeout: 25000 });
    log('✅ 已載入真正的 app._chuResistanceZones(⛔ 沒有複製第二份判定)');

    const acc = newAcc();
    let used = 0, t0 = Date.now();
    for (const f of files) {
        if (used >= MAX_SYMS) break;
        const rows = loadSeries(path.join(DATA, f));
        if (!rows) continue;
        used++;
        let fired;
        try {
            fired = await page.evaluate(({ rows, step }) => {
                const out = [];
                for (let i = 250; i < rows.length - 20; i += step) {
                    const slice = rows.slice(0, i + 1), last = slice.length - 1, pC = slice[last].close;
                    let zones = [];
                    try { zones = app._chuResistanceZones(slice, last) || []; } catch (_) { }
                    if (!zones.length) continue;                       // 已突破 = 不是待發射
                    const r20 = slice.slice(-20);
                    const hi = Math.max(...r20.map(d => d.high)), lo = Math.min(...r20.map(d => d.low));
                    const rangePct = lo > 0 ? (hi - lo) / lo * 100 : 999;
                    if (rangePct > 22) continue;                       // 振幅過大
                    const ma = n => slice.slice(-n).reduce((s, d) => s + d.close, 0) / n;
                    if (pC < ma(5) && pC < ma(20)) continue;           // 空頭排列
                    out.push([i, zones[0].distancePct, zones[0].price]);
                }
                return out;
            }, { rows, step: STEP });
        } catch (_) { continue; }
        processStock(rows, fired, TWII, acc);
        if (used % 300 === 0) log(`   …${used} 檔 ・${Math.round((Date.now() - t0) / 1000)}s`);
    }
    await browser.close();

    const S = summarize(acc);
    log(`\n📊 母體:${used} 檔 ・窗口 ${S.allDates[0] || '?'} ~ ${S.allDates[S.allDates.length - 1] || '?'} ・中位日 ${S.mid}`);
    log(`   🛒 收盤停在漲停價買不到剔除 ${acc.skip.limit.toLocaleString()} 筆候選(2015-06 前 ±7%)・🧱 壓力區窗口碰到斷崖剔除 ${acc.skip.cliff.toLocaleString()} 筆`);
    log(`   對照組(隨便挑一天,同一批股票同一段期間):n=${S.baseN} ・10 日超額 ${f2(S.baseM)}pp`);
    log(`   漏斗全體(有壓力 + 振幅≤22% + 沒跌破雙均線):n=${S.funnelN} ・10 日超額 ${f2(S.funnelM)}pp`);
    log(`   ⇒ ① 漏斗本身的邊際 = ${f2(S.funnelEdge)}pp(🔁 V79.4.3 每一筆 − 同一天全部股票的平均;成本 ${COST})`);
    log(`   🔁 同一天對照組 <${MIN_CTRL} 筆 → 剔除:① ${S.thinB.toLocaleString()} 筆 ・② ${S.thinF.toLocaleString()} 筆(10 日那格)`);

    log(`\n🎯 ② 距離排序有沒有用(對照組 = **同一天、同一個漏斗裡的全體候選**,⛔ 不是全市場)`);
    log(`${'桶'.padEnd(16)} ${'n'.padStart(7)} ${'5日'.padStart(8)} ${'10日'.padStart(8)} ${'20日'.padStart(8)}  ${'vs漏斗'.padStart(8)}  10日內站上壓力`);
    for (const B of S.buckets)
        log(`${B.nm.padEnd(16)} ${String(B.n).padStart(7)} ${f2(B.m5).padStart(8)} ${f2(B.m10).padStart(8)} ${f2(B.m20).padStart(8)}  ${f2(B.d).padStart(8)}  ${Number.isFinite(B.brk) ? B.brk.toFixed(1) + '%' : '—'} (n=${B.brkN})`);

    log(`\n🔬 六道關卡(對象:「≤2%」那一桶 —— 卡片標 🔥、排最前面的那些;全部看同一天、同一個漏斗的超額)`);
    let pass = 0;
    S.gates.forEach(([nm, ok, txt]) => { if (ok) pass++; log(`   ${ok ? '✅' : '❌'} ${nm.padEnd(22)} ${txt}`); });
    log(`\n🏁 六關通過 ${pass}/6`);
    log(pass === 6
        ? '⭐ 距離排序站得住腳 → 可以保留並把實測數字寫在卡上。'
        : '⛔ 距離排序**沒有**通過 → 這張卡只能描述事實(「離壓力還差幾 %」),⛔ 不可暗示「排最前就最可能發動/該買」。');
    log(`\n⚠️ 限制:倖存者偏誤(已下市的不在 data/)・窗口見上方 ・超額已扣同期加權 ・同檔 ${DEDUP} 日去重。`);
}

// ═══════════ selftest(⛔ 不開瀏覽器、不讀真資料)═══════════
function selftest() {
    let bad = 0;
    const ok = (nm, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${nm}${c ? '' : '  → ' + JSON.stringify(x)}`); if (!c) bad++; };
    const rng = seed => { let x = seed >>> 0 || 1; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
    const mkDates = (n, y0) => { const out = []; let t = Date.UTC(y0, 0, 2); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; };
    const mkRows = (dates, drift, seed, mut) => { const r = rng(seed), rows = []; let p = 50; dates.forEach((d, k) => { p *= 1 + drift(k) + (r() - 0.5) * 0.006; rows.push({ date: d, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 }); }); if (mut) mut(rows); return rows; };

    // ① 🔁 同一天對照(決定性對照):前段大家每天 +0.3%、後段 −0.1%(全部股票一樣)
    //    「≤2%」那一桶只在前段出現、其他桶兩段都有 → 同一天比 ≈ 0;舊版(減整段漏斗平均 / 整段全市場平均)憑空一大截
    {
        const N = 1500, dates = mkDates(N, 2012), TW = Object.fromEntries(dates.map(d => [d, 100]));
        const drift = k => k < 750 ? 0.003 : -0.001;
        const acc = newAcc();
        for (let s = 0; s < 80; s++) {
            const rows = mkRows(dates, drift, 100 + s);
            const fired = [];
            for (let i = 250; i < N - 20; i++) {
                if (s < 40 && i < 750) fired.push([i, 1, rows[i].close * 1.01]);          // 近:只在前段
                if (s >= 40) fired.push([i, 7, rows[i].close * 1.07]);                     // 遠:兩段都有
            }
            processStock(rows, fired, TW, acc);
        }
        const S = summarize(acc);
        const ev = acc.events, near = ev.filter(e => e.bi === 0), fun = ev;
        const oldT = mean(near.map(e => e.x[10]).filter(v => v != null)) - mean(fun.map(e => e.x[10]).filter(v => v != null));
        let bs = 0, bn = 0; for (const a of acc.base.values()) { bs += a[10][0]; bn += a[10][1]; }
        const oldF = mean(fun.map(e => e.x[10]).filter(v => v != null)) - bs / bn;
        ok(`① ② 近的那一桶只在前段、前段大家都漲:同一天、同一個漏斗比 ${f2(S.buckets[0].d)}pp ≈ 0(n=${S.buckets[0].nX})`, S.buckets[0].nX > 100 && Math.abs(S.buckets[0].d) < 0.3, S.buckets[0].d);
        ok(`①b 決定性對照:同一批改減整段漏斗平均(舊版)→ 憑空 ${f2(oldT)}pp`, oldT > 1, oldT);
        ok(`①c ① 漏斗本身:同一天全部股票比 ${f2(S.funnelEdge)}pp ≈ 0;舊版減整段全市場平均 → 憑空 ${f2(oldF)}pp`, Math.abs(S.funnelEdge) < 0.3 && oldF > 0.5, [S.funnelEdge, oldF]);
        ok(`①d 前後半(照日期)也都是同一天比:前 ${f2(S.hd[0])} / 後 ${f2(S.hd[1])}`, S.hd.every(v => !Number.isFinite(v) || Math.abs(v) < 0.5) && Number.isFinite(S.hd[0]), S.hd);
    }
    // ② 同一天對照組 <MIN_CTRL → 那一筆不算並計數
    {
        const N = 400, dates = mkDates(N, 2020), TW = Object.fromEntries(dates.map(d => [d, 100]));
        const acc = newAcc();
        for (let s = 0; s < 10; s++) { const rows = mkRows(dates, () => 0.0005, 200 + s); processStock(rows, [[260, 1, rows[260].close * 1.01]], TW, acc); }
        const S = summarize(acc);
        ok(`② 一天只有 10 檔(<${MIN_CTRL}):事件全部不算(① 剔 ${S.thinB}、② 剔 ${S.thinF})`, S.thinB === 10 && S.thinF === 10 && S.buckets[0].nX === 0, [S.thinB, S.thinF]);
        const S2 = summarize(acc, 10);
        ok('②b 同一批門檻降到 10 → 回來(⛔ 剔除只因為對照組太薄)', S2.thinF === 0 && S2.buckets[0].nX === 10, S2.thinF);
    }
    // ③ 🔁 收盤停在漲停價(lib_limit):2012 +6.8% = 漲停買不到(事件與兩個對照組都剔);同一根放 2020 照算
    {
        const one = y0 => {
            const N = 400, dates = mkDates(N, y0), TW = Object.fromEntries(dates.map(d => [d, 100]));
            const acc = newAcc();
            const rows = mkRows(dates, () => 0, 300, rows => { for (let k = 300; k < N; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= 1.069; });   // ⚠️ 雜訊 ±0.3% → 要 ×1.069 才一定過 2012 的 ×1.065
            processStock(rows, [[300, 1, rows[300].close * 1.01]], TW, acc);
            return acc;
        };
        const a12 = one(2012), a20 = one(2020);
        const d12 = [...a12.base.keys()].find(d => d.startsWith('2013')), b12 = a12.base.get(mkDates(400, 2012)[300]), b20 = a20.base.get(mkDates(400, 2020)[300]);
        ok(`③ 2012 收 +6.9% = 漲停買不到:事件 0、剔 ${a12.skip.limit}、對照組那天也沒收;2020 同一根照算`, a12.events.length === 0 && a12.skip.limit === 1 && !b12 && a20.events.length === 1 && a20.skip.limit === 0 && !!b20 && !!d12, [a12.events.length, a12.skip, !!b12, a20.events.length, !!b20]);
    }
    // ④ 🔁 斷崖只剔窗口(lib_cliff):第 700 根 ×2 → 往回 120 根碰到它的進場點剔除、抱的窗口跨過它的天期 null、其他照算
    {
        const N = 1200, dates = mkDates(N, 2018), TW = Object.fromEntries(dates.map(d => [d, 100]));
        const rows = mkRows(dates, () => 0.0003, 400, rows => { for (let k = 700; k < N; k++) for (const f of ['open', 'high', 'low', 'close']) rows[k][f] *= 2; });
        const fired = []; for (let i = 600; i < 900; i += 3) fired.push([i, 1, rows[i].close * 1.01]);
        const acc = newAcc(); processStock(rows, fired, TW, acc);
        const ev = acc.events, inLB = ev.filter(e => e.i >= 700 && e.i <= 700 + LOOKBACK - 1);
        const span = ev.filter(e => e.i < 700 && HOR.some(h => e.i + h >= 700 && e.x[h] != null));
        const before = ev.some(e => e.i + 20 < 700 && e.x[20] != null), after = ev.some(e => e.i >= 700 + LOOKBACK && e.x[10] != null);
        ok(`④ 壓力區窗口碰到斷崖的 ${acc.skip.cliff} 筆候選剔除(事件裡 ${inLB.length})・跨過斷崖的天期 null(違規 ${span.length})・前後照算`, acc.skip.cliff > 0 && !inLB.length && !span.length && before && after, { cliff: acc.skip.cliff, inLB: inLB.length, span: span.length, before, after });
        const bd = acc.base.get(dates[690]), bd2 = acc.base.get(dates[750]), bd3 = acc.base.get(dates[900]);
        ok('④b 對照組同一條:跨過斷崖的天期不收、壓力區窗口碰到的整天不收、之後照收', !!bd && bd[20][1] === 0 && bd[5][1] === 1 && !bd2 && !!bd3 && bd3[10][1] === 1, [bd, !!bd2, bd3]);
    }
    // ⑤ 🔁 DATA_DIR
    ok('⑤ 讀 DATA_DIR(沒給才用 repo 的 data/)', dataDirOf({ DATA_DIR: '/x/d16' }) === '/x/d16' && dataDirOf({}) === path.join(ROOT, 'data'));
    console.log(bad ? `\n❌ BREAKOUTDIST_SELFTEST_FAIL ${bad} 條` : '\n✅ BREAKOUTDIST_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (SELFTEST) process.exit(selftest());
else await main();
