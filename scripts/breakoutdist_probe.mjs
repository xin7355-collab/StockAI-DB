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
 * 跑法:node scripts/breakoutdist_probe.mjs [股票數上限]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
const STEP = 3;          // 每 3 根 K 掃一次(事件很多,降計算量)
const DEDUP = 20;        // 同檔 20 個交易日內只算一次
const HOR = [5, 10, 20];
const COST = 0.44;       // 來回成本 %
const MIN_N = 30;
const log = s => console.log(s);

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
log(`📂 掃描 ${files.length} 檔`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._chuResistanceZones === 'function', null, { timeout: 25000 });
log('✅ 已載入真正的 app._chuResistanceZones(⛔ 沒有複製第二份判定)');

// 事件桶:照「距壓力 %」分,門檻跟卡上的顏色門檻對齊(≤2 紅 / ≤5 琥珀 / 其餘灰)
const BUCKETS = [[0, 2, '≤2%(卡片標 🔥)'], [2, 5, '2~5%'], [5, 10, '5~10%'], [10, 60, '10~60%']];
const ev = BUCKETS.map(() => ({ n: 0, r: { 5: [], 10: [], 20: [] }, yr: {}, half: [[], []], brk: [0, 0] }));
const base = { 5: [], 10: [], 20: [] };
const allFunnel = { 5: [], 10: [], 20: [] };
let used = 0, allDates = [], t0 = Date.now();

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

    // 對照組:同一批股票、同一段期間的**每一個掃描點**(⛔ 不抽樣)
    for (let i = 250; i < rows.length - 20; i += STEP) {
        const d0 = rows[i].date; if (!(d0 in TWII)) continue;
        for (const h of HOR) {
            const j = i + h; if (j >= rows.length) continue;
            const d1 = rows[j].date; if (!(d1 in TWII) || !(TWII[d0] > 0)) continue;
            base[h].push((rows[j].close - rows[i].close) / rows[i].close * 100 - (TWII[d1] - TWII[d0]) / TWII[d0] * 100);
        }
    }

    let lastHit = -999;
    for (const [i, dist, resist] of fired) {
        if (i - lastHit < DEDUP) continue;                          // 去重
        lastHit = i;
        const d0 = rows[i].date; if (!(d0 in TWII)) continue;
        const bi = BUCKETS.findIndex(([a, b]) => dist >= a && dist < b);
        if (bi < 0) continue;
        const E = ev[bi];
        E.n++; allDates.push(d0);
        const yr = d0.slice(0, 4);
        // 🧱 穿不穿得過:未來 10 日收盤有沒有站上那道壓力
        const fwd = rows.slice(i + 1, i + 11);
        if (fwd.length >= 5) { E.brk[1]++; if (fwd.some(d => d.close > resist)) E.brk[0]++; }
        for (const h of HOR) {
            const j = i + h; if (j >= rows.length) continue;
            const d1 = rows[j].date; if (!(d1 in TWII) || !(TWII[d0] > 0)) continue;
            const x = (rows[j].close - rows[i].close) / rows[i].close * 100 - (TWII[d1] - TWII[d0]) / TWII[d0] * 100;
            E.r[h].push(x); allFunnel[h].push(x);
            if (h === 10) {
                (E.yr[yr] = E.yr[yr] || []).push(x);
                E.half[0].push([d0, x]);
            }
        }
    }
    if (used % 300 === 0) log(`   …${used} 檔 ・${Math.round((Date.now() - t0) / 1000)}s`);
}
await browser.close();

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const f2 = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—');

allDates.sort();
const mid = allDates[Math.floor(allDates.length / 2)] || '';
log(`\n📊 母體:${used} 檔 ・窗口 ${allDates[0] || '?'} ~ ${allDates[allDates.length - 1] || '?'} ・中位日 ${mid}`);
log(`   對照組(隨便挑一天,同一批股票同一段期間):n=${base[10].length} ・10 日超額 ${f2(mean(base[10]))}pp`);
log(`   漏斗全體(有壓力 + 振幅≤22% + 沒跌破雙均線):n=${allFunnel[10].length} ・10 日超額 ${f2(mean(allFunnel[10]))}pp`);
log(`   ⇒ ① 漏斗本身的邊際 = ${f2(mean(allFunnel[10]) - mean(base[10]))}pp(成本 ${COST}）`);

log(`\n🎯 ② 距離排序有沒有用(對照組 = **同一個漏斗裡的全體**,⛔ 不是全市場)`);
log(`${'桶'.padEnd(16)} ${'n'.padStart(7)} ${'5日'.padStart(8)} ${'10日'.padStart(8)} ${'20日'.padStart(8)}  ${'vs漏斗'.padStart(8)}  10日內站上壓力`);
const fu10 = mean(allFunnel[10]);
const rowsOut = [];
ev.forEach((E, i) => {
    const nm = BUCKETS[i][2];
    const m10 = mean(E.r[10]);
    const brk = E.brk[1] ? (E.brk[0] / E.brk[1] * 100) : NaN;
    rowsOut.push({ nm, n: E.n, m10, d: m10 - fu10, brk, yr: E.yr, half: E.half[0] });
    log(`${nm.padEnd(16)} ${String(E.n).padStart(7)} ${f2(mean(E.r[5])).padStart(8)} ${f2(m10).padStart(8)} ${f2(mean(E.r[20])).padStart(8)}  ${f2(m10 - fu10).padStart(8)}  ${Number.isFinite(brk) ? brk.toFixed(1) + '%' : '—'} (n=${E.brk[1]})`);
});

log(`\n🔬 六道關卡(對象:「≤2%」那一桶 —— 卡片標 🔥、排最前面的那些)`);
const T = rowsOut[0];
const gates = [];
gates.push([`樣本 n ≥ ${MIN_N}`, T.n >= MIN_N, `n=${T.n}`]);
gates.push(['全期邊際為正', T.d > 0, `${f2(T.d)}pp`]);
const h1 = T.half.filter(([d]) => d < mid).map(([, x]) => x), h2 = T.half.filter(([d]) => d >= mid).map(([, x]) => x);
const hd1 = mean(h1) - fu10, hd2 = mean(h2) - fu10;
gates.push(['前後半同向', hd1 > 0 && hd2 > 0, `前 ${f2(hd1)} / 後 ${f2(hd2)}`]);
const yrs = Object.keys(T.yr).sort();
const yd = yrs.map(y => [y, mean(T.yr[y]) - fu10]);
gates.push(['逐年同向', yd.length > 0 && yd.every(([, v]) => v > 0), yd.map(([y, v]) => `${y} ${f2(v)}`).join(' ・')]);
const bestYear = yd.slice().sort((a, b) => b[1] - a[1])[0];
const exBest = yrs.filter(y => y !== (bestYear || [])[0]).flatMap(y => T.yr[y]);
gates.push(['去掉最好的一年仍成立', exBest.length > 0 && (mean(exBest) - fu10) > 0, `${f2(mean(exBest) - fu10)}pp(去 ${(bestYear || ['—'])[0]})`]);
gates.push([`扣成本 ${COST}pp 後仍為正`, T.d - COST > 0, `${f2(T.d - COST)}pp`]);
let pass = 0;
gates.forEach(([nm, ok, txt]) => { if (ok) pass++; log(`   ${ok ? '✅' : '❌'} ${nm.padEnd(22)} ${txt}`); });
log(`\n🏁 六關通過 ${pass}/6`);
log(pass === 6
    ? '⭐ 距離排序站得住腳 → 可以保留並把實測數字寫在卡上。'
    : '⛔ 距離排序**沒有**通過 → 這張卡只能描述事實(「離壓力還差幾 %」),⛔ 不可暗示「排最前就最可能發動/該買」。');
log(`\n⚠️ 限制:倖存者偏誤(已下市的不在 data/)・窗口見上方 ・超額已扣同期加權 ・同檔 ${DEDUP} 日去重。`);
