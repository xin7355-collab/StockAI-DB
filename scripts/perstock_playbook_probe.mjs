/**
 * 🧲 App 現行「這一檔最會賺的那一招」—— 名單穩定度到底夠不夠?(V74.6.3)
 *
 * 為什麼要做(⛔ 這一題比報酬重要):
 *   V74.5.9 用同一套方法測「每一檔挑它自己最適合的**指標**」→ 名單穩定度 2.7% ≈ 隨機 2.1%
 *   → 當場結案。V74.6.1 測「挑**出場**」→ 穩定度 48.6% 但 83% 都挑同一種 = 假象。
 *   🚨 而 App 每天在用的「挑**打法**」(playbook_edge / 明日作戰清單)**從來沒過這一關**:
 *      V72.9.0 只比過「這一檔自己的成績 +136 萬 vs 全市場型態平均 +3.5 萬」(38 倍),
 *      ⛔ 沒問過「前半段挑到的那一招,後半段還是同一招嗎」。
 *   ⭐ 評估紀錄⑮(分點同盟集團)的教訓:任何「先從資料學出一組名單,再拿它去預測」的做法,
 *      **先報名單重疊率,再談報酬** —— 報酬會騙人,名單不會。
 *
 * 方法(⛔ 直接呼叫 App 的 `_patternFitBacktest`,不複製一份判定邏輯):
 *   ・每一檔切兩半:前半 = rows[0..mid]、後半 = rows[mid-45..]
 *     (45 是 `_patternFitBacktest` 自己的暖身長度 → 後半的第一個事件剛好落在 mid)
 *   ・各自挑「最好的那一招」= 跟 App 完全一樣的排序:**保守下界** lb = 期望值 − 1.28×sd/√n,
 *     且 count ≥ MIN_N(8)、(lb − 成本 0.44) > 0  ⛔ 三個條件缺一都不是 App 在用的那套
 *   ・① 穩定度:兩段都有 pick 的股票裡,同一招的比例
 *     🚨 同時報**分布**(哪一招被挑最多)—— 分布極度集中的話,穩定度高只是「大家都選同一個」
 *   ・② 隨機基準:每一檔用 1/(後半可選招數) 平均 —— ⛔ 不可直接用 1/22(每檔可選的招不一樣多)
 *   ・③ 報酬:前半挑的那一招在後半的實際每趟,對照
 *        (a) 隨便挑一招(後半所有可選招的平均)(b) 全市場最好的那一招(用前半彙總挑)
 *   ・④ **反過來再做一次**(後半學、前半驗)—— 方向相反 = 那是被那一半資料湊出來的
 *
 * 跑法:node scripts/perstock_playbook_probe.mjs [最多幾檔]
 */
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
const MIN_N = +(process.env.MIN_N || 8);
const COST = 0.44;
const WARM = 45;                       // = `_patternFitBacktest` 內部的起跑點
const MIN_HALF = 140;                  // 每一半至少幾根(函式自己要求 ≥80,留寬一點)

const log = (...a) => console.log(...a);
const t0 = Date.now();

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out.length >= (MIN_HALF * 2 + WARM) ? out : null;
    } catch (_) { return null; }
}

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
log(`🧲 App「挑打法」名單穩定度 ・${files.length} 檔${MAX_SYMS < 99999 ? `(上限 ${MAX_SYMS})` : ''}`);
log(`   挑法跟 App 完全一樣:保守下界排序 + 樣本 ≥${MIN_N} + 扣成本 ${COST}% 後 > 0\n`);

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
    ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._patternFitBacktest, null, { timeout: 25000 });

// per-sym:{ a:{pick,cand:Map(key→每趟)}, b:{…} }  a = 前半、b = 後半
const rec = [];
let used = 0, skipped = 0;
for (const f of files) {
    if (used >= MAX_SYMS) break;
    const sym = f.slice(0, 4);
    const rows = loadSeries(path.join(DATA, f));
    if (!rows) { skipped++; continue; }
    const mid = Math.floor(rows.length / 2);
    let r;
    try {
        r = await page.evaluate(a => {
            const { rowsA, rowsB, minN, cost } = a;
            const lb = x => x.expectancy - 1.28 * (x.sd || 0) / Math.sqrt(Math.max(1, x.count));
            const one = rows => {
                let ranked; try { ranked = app._patternFitBacktest(rows); } catch (_) { return null; }
                if (!ranked || !ranked.length) return null;
                // ⭐ cand = 這一段裡「打得動」的招(給隨機基準與報酬對照用),⛔ 不套 App 的門檻
                const cand = ranked.filter(x => x.count >= 3)
                                   .map(x => [x.key, x.expectancy, x.count]);
                // ⭐ pick = App 真正會挑的那一招(門檻 + 保守下界排序,三個條件缺一不可)
                const ok = ranked.filter(x => x.count >= minN && (lb(x) - cost) > 0)
                                 .sort((p, q) => lb(q) - lb(p));
                // ⭐ pickR = **只看排序、不套獲利門檻**的版本。
                //   ⛔ 為什麼要多這個:App 的門檻嚴到「同一檔在兩段都有 pick」的只有幾 %,
                //      n 太小量不動穩定度。這一版把「排序本身有沒有結構」跟
                //      「有沒有通過門檻」拆開量 —— 兩件事的答案可以不一樣。
                const rk = ranked.filter(x => x.count >= minN).sort((p, q) => lb(q) - lb(p));
                return { pick: ok.length ? ok[0].key : null, pickR: rk.length ? rk[0].key : null, cand };
            };
            return { A: one(rowsA), B: one(rowsB) };
        }, { rowsA: rows.slice(0, mid), rowsB: rows.slice(Math.max(0, mid - WARM)), minN: MIN_N, cost: COST });
    } catch (_) { r = null; }
    used++;
    if (r && r.A && r.B) rec.push({ sym, A: r.A, B: r.B });
    if (used % 200 === 0) process.stdout.write(`   ${used} 檔 / 收到 ${rec.length}\r`);
}
await browser.close();
log(`✅ 掃過 ${used} 檔(K 線太短跳過 ${skipped})・兩段都算得出來的 ${rec.length} 檔          \n`);

if (rec.length < 100) { console.error(`🚨 樣本只有 ${rec.length} 檔 —— 太少,不下結論`); process.exit(1); }

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const f2 = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '  n/a');

// ── 一個方向:用 L 段挑、到 V 段驗 ────────────────────────────────
function run(Lk, Vk, label, PK) {
    let both = 0, same = 0, randExp = 0;
    const picked = [], randAll = [], bestAll = [];
    const dist = new Map();          // V 段實際被挑中的招 → 幾檔(看分布用)
    const distL = new Map();         // L 段挑到的招 → 幾檔
    // 全市場最好的那一招:用 L 段所有股票的每趟平均決定
    const agg = new Map();
    for (const r of rec) for (const [k, e] of r[Lk].cand) { const o = agg.get(k) || [0, 0]; o[0] += e; o[1]++; agg.set(k, o); }
    let gBest = null, gv = -1e9;
    for (const [k, [s, n]] of agg) if (n >= 30 && s / n > gv) { gv = s / n; gBest = k; }

    for (const r of rec) {
        const pL = r[Lk][PK], pV = r[Vk][PK];
        const cv = new Map(r[Vk].cand.map(([k, e]) => [k, e]));
        if (pL) distL.set(pL, (distL.get(pL) || 0) + 1);
        if (pV) dist.set(pV, (dist.get(pV) || 0) + 1);
        if (pL && pV) { both++; if (pL === pV) same++; if (cv.size) randExp += 1 / cv.size; }
        if (!pL || !cv.size) continue;
        if (cv.has(pL)) picked.push(cv.get(pL));                    // 前半挑的那一招在後半的每趟
        randAll.push(mean([...cv.values()]));                        // 隨便挑一招
        if (gBest && cv.has(gBest)) bestAll.push(cv.get(gBest));     // 全市場最好的那一招
    }

    log(`\n${'═'.repeat(88)}`);
    log(`${label}`);
    log('─'.repeat(88));
    log(`① 名單穩定度(兩段都挑得出來的 ${both} 檔):兩段挑到同一招 ${same} 檔 = ${(same / both * 100).toFixed(1)}%`);
    log(`   隨機期望 ${(randExp / both * 100).toFixed(1)}%   → 差 ${((same - randExp) / both * 100).toFixed(1)}pp`);
    const top = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const totV = [...dist.values()].reduce((a, b) => a + b, 0);
    log(`\n🚨 ${Vk === 'B' ? '後' : '前'}段被挑中的招 —— 分布(⛔ 極度集中的話,穩定度高只是「大家都選同一個」):`);
    for (const [k, n] of top) log(`   ${String(n).padStart(5)} 檔 (${(n / totV * 100).toFixed(1)}%)  ${k}`);
    log(`   共 ${dist.size} 種招被挑到 / 母體 ${totV} 檔`);
    log(`\n② 報酬(${Vk === 'B' ? '後' : '前'}段的每趟 %,已含該函式自己的停損與 5 日線出場):`);
    log(`   挑法(用另一段挑的那一招)  ${f2(mean(picked))}%   n=${picked.length}`);
    log(`   隨便挑一招                 ${f2(mean(randAll))}%   n=${randAll.length}   → 挑法 ${f2(mean(picked) - mean(randAll))}pp`);
    log(`   全市場最好的那一招(${gBest || '—'})  ${f2(mean(bestAll))}%   n=${bestAll.length}   → 挑法 ${f2(mean(picked) - mean(bestAll))}pp`);
    return { same, both, randExp, dPick: mean(picked) - mean(randAll) };
}

// 🅰️ 放寬版:只看排序、不套獲利門檻 —— 問「per-stock 排序本身有沒有結構」(樣本大,量得動)
const fwdR = run('A', 'B', '➡️🅰️ 只看排序(不套門檻)・前半段挑 → 後半段驗', 'pickR');
const revR = run('B', 'A', '⬅️🅰️ 只看排序(不套門檻)・後半段挑 → 前半段驗', 'pickR');
// 🅱️ App 實際版:門檻 + 排序 —— 問「App 真正會推給使用者的那一招穩不穩」(樣本小,只能參考)
const fwd = run('A', 'B', '➡️🅱️ App 實際在用的(含獲利門檻)・前半段挑 → 後半段驗', 'pick');
const rev = run('B', 'A', '⬅️🅱️ App 實際在用的(含獲利門檻)・後半段挑 → 前半段驗', 'pick');

log(`\n${'═'.repeat(88)}`);
log(`🧭 判定`);
const pct = (a, b) => (a / b * 100).toFixed(1);
log(`🅰️ 只看排序(樣本大,量得動):`);
log(`   穩定度 正向 ${pct(fwdR.same, fwdR.both)}%(隨機 ${pct(fwdR.randExp, fwdR.both)}%,n=${fwdR.both})`
  + ` ・反向 ${pct(revR.same, revR.both)}%(隨機 ${pct(revR.randExp, revR.both)}%,n=${revR.both})`);
log(`   挑法 vs 隨便挑:正向 ${f2(fwdR.dPick)}pp ・反向 ${f2(revR.dPick)}pp`);
log(`🅱️ App 實際在用的(含獲利門檻,⚠️ n 很小 → 只能參考):`);
log(`   穩定度 正向 ${pct(fwd.same, fwd.both)}%(隨機 ${pct(fwd.randExp, fwd.both)}%,n=${fwd.both})`
  + ` ・反向 ${pct(rev.same, rev.both)}%(隨機 ${pct(rev.randExp, rev.both)}%,n=${rev.both})`);
log(`   挑法 vs 隨便挑:正向 ${f2(fwd.dPick)}pp ・反向 ${f2(rev.dPick)}pp`);
log(`   🚨 「兩段都通過門檻」只有 ${fwd.both} / ${rec.length} 檔 = ${pct(fwd.both, rec.length)}%`
  + ` —— 這本身就是一個發現:那個門檻嚴到大多數股票在另一段就沒資格上榜。`);
log(`   ⚠️ 這裡的每趟是「該函式自己那套進出場」的毛報酬,⛔ 未扣來回成本 ${COST}%;`);
log(`      兩邊用同一把尺,所以「差幾 pp」是可比的,但絕對值不可拿去當獲利。`);
log(`   ⚠️ 窗口固定切一半 → 前後兩段的行情本來就不同,⛔ 不可把「後段比較好」讀成挑法有效。`);
log(`\n⏱️  ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
