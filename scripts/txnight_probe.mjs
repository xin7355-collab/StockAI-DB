// 🌙 txnight_probe.mjs —— 台指期夜盤(15:00 ~ 隔天 05:00)算進盤前體檢,猜開盤會不會更準?(EXP 事先登記)
//
// 為什麼(V82.6.7,使用者 11/23 選「比特幣 + 夜盤一起驗」):App 盤前體檢那條夜盤計分(V42.0:≥ +1% 加 1.5 分 …)
//   從來沒回測過 → V82.4.0 起採礦標 score: false 只顯示、⛔ 算分,「要不要算分等使用者決定(或先用期交所 2017 起的盤後歷史回測)」。
//
// 資料:
//   TXNIGHT  txnight.json(scripts/txnight_hist_miner.py,premkt_hist 分支):FinMind TaiwanFuturesDaily TX 一般盤 p / 盤後 a,日期照原樣
//   DUMP     premkt_app_probe.mjs 的逐日明細(App 自己的 _preOpenScore 每天重建;夜盤那一格是 null = 現在的 App)
//   B0050    0050 日 K(台股交易日曆)
//   HTML     index.html(預設 repo 那份;夜盤那條規則從 App 自己的 _preOpenScore 拿,⛔ 另抄)
//
// ⏰ 先確認日期歸屬(⛔ 碰開盤結果):夜盤 15:00 開 → 開盤價應該最接近「同一個交易日 13:45 的日盤收盤」。
//   FinMind 的盤後日期如果是「開始那天」→ 夜盤開盤 ≈ 同一個日期的日盤收盤;如果是期交所「歸屬的下一個交易日」→ ≈ 前一個日期的日盤收盤。
//   兩個假設的中位差,贏的要 < 0.3% 而且輸的那個至少是它的 2 倍,否則判不出 → 停。
// 夜盤漲跌(跟 App 同一把尺):近月 = 夜盤成交量最大的那個合約;漲跌 % = 夜盤收盤 ÷ 前一個日盤那個合約的結算價 − 1(lib_quotes.parse_taifex_night 的 CRefPrice)。
// ⭐ 判定(EXP 寫死,⛔ 跑完再改):見 RULE 與 judgeN。只用到 2026-11-06。
//
// 跑法:TXNIGHT DUMP B0050 [HTML] node scripts/txnight_probe.mjs [out.json]
//       node scripts/txnight_probe.mjs --selftest
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { judge, spearman } from './premkt_app_probe.mjs';
import { rng, mean, med, r2 } from './lib_crash.mjs';
import { load0050 } from './btc_tw_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RULE = { cut: '2026-11-06', yearShare: 0.76, callKeep: 0.8, nbrNeed: 2, wfFrom: 2019, wfShare: 0.75, alignMax: 0.3, alignRatio: 2 };
const yearsOf = rows => [...new Set(rows.map(r => r.d.slice(0, 4)))].sort();

// ───────────────────────────── 日期歸屬
/** → { by: 'next' | 'start' | null, mNext, mStart, n }(中位差 %)。⛔ 用到任何開盤 / 跳空。 */
export function alignCheck(T) {
    const ds = Object.keys(T.d || {}).sort(), eN = [], eS = [];
    for (let i = 1; i < ds.length; i++) {
        const a = (T.d[ds[i]].a || [])[0]; if (!a || !(a[1] > 0)) continue;
        const pSame = (T.d[ds[i]].p || []).find(r => r[0] === a[0]), pPrev = (T.d[ds[i - 1]].p || []).find(r => r[0] === a[0]);
        if (pSame && pSame[4] > 0) eS.push(Math.abs(a[1] / pSame[4] - 1) * 100);
        if (pPrev && pPrev[4] > 0) eN.push(Math.abs(a[1] / pPrev[4] - 1) * 100);
    }
    const mN = med(eN), mS = med(eS);
    let by = null;
    if (mN != null && mS != null && eN.length >= 100 && eS.length >= 100) {     // 兩邊各至少 100 天對得到同一個合約才判
        if (mN < RULE.alignMax && mS >= RULE.alignRatio * mN) by = 'next';
        else if (mS < RULE.alignMax && mN >= RULE.alignRatio * mS) by = 'start';
    }
    return { by, mNext: mN, mStart: mS, n: Math.min(eN.length, eS.length) };
}
/** 台股交易日 D 開盤前那一盤夜盤(05:00 收的那一盤)的漲跌 %;by = 日期歸屬;shift = 注入用(往後挪幾盤 = 偷看) */
export function nightMove(T, TD, by, shift = 0) {
    const out = new Map(), idx = new Map(TD.map((d, i) => [d, i]));
    for (let i = 1; i < TD.length; i++) {
        const D = TD[i + shift], prev = TD[i - 1 + shift]; if (!D || !prev) continue;
        const lab = by === 'next' ? D : prev, row = T.d[lab]; if (!row || !row.a || !row.a[0]) continue;
        const a = row.a[0], pr = ((T.d[prev] || {}).p || []).find(r => r[0] === a[0]);
        const ref = pr ? (pr[5] > 0 ? pr[5] : pr[4]) : null;
        if (!(ref > 0) || !(a[4] > 0)) continue;
        out.set(TD[i], { nm: Math.round((a[4] / ref - 1) * 10000) / 100, c: a[0], lab });
        void idx;
    }
    return out;
}

// ───────────────────────────── App 自己那條夜盤規則(headless 呼叫 _preOpenScore,⛔ 另抄)
export async function appNightPoints(values, html) {
    let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'txnight-')), 'index.html');
    fs.writeFileSync(tmp, html);
    const page = await browser.newPage();
    await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._preOpenScore, null, { timeout: 30000 });
    const pts = await page.evaluate(vs => vs.map(v => { const r = app._preOpenScore({ night: v }); const q = r.parts.find(p => /夜盤/.test(p.nm) && !/那指/.test(p.nm)); return q ? q.d : 0; }), values);
    await browser.close();
    return new Map(values.map((v, i) => [v, pts[i]]));
}
// 旁邊三格(⛔ App 的規則;只拿來看是不是一片高原)
export const VARIANTS = {
    '門檻 0.1 / 0.5': v => v >= 0.5 ? 1.5 : v >= 0.1 ? 1 : v <= -0.5 ? -2 : v <= -0.1 ? -1 : 0,
    '門檻 0.3 / 1.5': v => v >= 1.5 ? 1.5 : v >= 0.3 ? 1 : v <= -1.5 ? -2 : v <= -0.3 ? -1 : 0,
};

// ───────────────────────────── 判定
export function cellCheck(rows, f, need) {
    const ys = yearsOf(rows), S0 = r => r.s; let a = 0, b = 0;
    for (const y of ys) {
        const R = rows.filter(r => r.d.startsWith(y)), J0 = judge(R, S0), J1 = judge(R, f);
        if (J1.rho > J0.rho) a++;
        if (Number.isFinite(J1.hit) && Number.isFinite(J0.hit) && J1.hit > J0.hit) b++;
    }
    const all0 = judge(rows, S0), all1 = judge(rows, f), callOk = all1.call >= RULE.callKeep * all0.call;
    return { a, b, n: ys.length, need, callOk, pass: a >= need && b >= need && callOk, gain: all1.rho - all0.rho, hit0: all0.hit, hit1: all1.hit, rho0: all0.rho, rho1: all1.rho, call0: all0.call, call1: all1.call, wrong0: all0.wrong, wrong1: all1.wrong };
}
/** rows:{ d, s, gap, io, nm, appPts };cells = App 那條 + 旁邊三格 */
export function judgeN(rows) {
    const ys = yearsOf(rows), need = Math.ceil(RULE.yearShare * ys.length);
    const add = g => r => Math.round((r.s + g(r)) * 10) / 10;
    const cells = { 'App 那條': add(r => r.appPts), ...Object.fromEntries(Object.entries(VARIANTS).map(([k, f]) => [k, add(r => f(r.nm))])), 'App 那條 × 0.5': add(r => r.appPts * 0.5) };
    const res = Object.fromEntries(Object.entries(cells).map(([k, f]) => [k, cellCheck(rows, f, need)]));
    const main = res['App 那條'], nbr = Object.entries(res).filter(([k, v]) => k !== 'App 那條' && v.pass).length;
    let wfW = 0, wfN = 0; const wf = [];
    for (const y of ys.filter(y => +y >= RULE.wfFrom)) {
        const past = rows.filter(r => r.d.slice(0, 4) < y); if (past.length < 100) continue;
        const best = Object.entries(cells).map(([k, f]) => ({ k, g: judge(past, f).rho - judge(past, r => r.s).rho })).sort((p, q) => q.g - p.g)[0];
        const R = rows.filter(r => r.d.startsWith(y)), win = best.g > 0 && judge(R, cells[best.k]).rho > judge(R, r => r.s).rho;
        wfN++; wfW += win; wf.push(`${y}:${best.g > 0 ? best.k : '不加'}${win ? '✓' : '✗'}`);
    }
    const pass = [main.pass, nbr >= RULE.nbrNeed, wfN > 0 && wfW / wfN >= RULE.wfShare];
    return { n: rows.length, years: ys.length, need, cells: res, main, nbr, wf: { w: wfW, n: wfN, list: wf }, pass, ok: pass.every(Boolean) };
}

export function run(inp, log = console.log) {
    const cut = RULE.cut;
    const TD = inp.TD.filter(d => d <= cut);
    const T = { ...inp.T, d: Object.fromEntries(Object.entries(inp.T.d || {}).filter(([d]) => d <= cut)) };
    const al = alignCheck(T);
    const out = { rule: RULE, cut, align: al, judged: null, desc: {} };
    log(`🌙 台指期夜盤 × 盤前體檢(判定資料到 ${cut};FinMind 夜盤 ${Object.keys(T.d).filter(d => T.d[d].a).length} 天)`);
    log(`  日期歸屬:夜盤開盤 vs「前一個日期」日盤收盤 中位差 ${r2(al.mNext)}%・vs「同一個日期」${r2(al.mStart)}%(${al.n} 天)→ ${al.by === 'next' ? '歸屬下一個交易日' : al.by === 'start' ? '開始那天' : '⛔ 判不出'}`);
    if (!al.by) { out.stop = '日期歸屬判不出'; return out; }
    const NM = nightMove(T, TD, al.by);
    const rows = (inp.dump || []).filter(r => r.d <= cut && NM.has(r.d)).map(r => ({ d: r.d, s: r.s, gap: r.gap, io: r.io, nm: NM.get(r.d).nm, appPts: inp.pts.get(NM.get(r.d).nm) ?? 0 }));
    const J = judgeN(rows); out.judged = J;
    log(`⭐ 夜盤算進盤前分數(App 那條規則原封不動):${J.n} 天・${J.years} 年(要 ≥ ${J.need} 年)`);
    for (const [k, c] of Object.entries(J.cells))
        log(`  ${k.padEnd(14)} 名次相關 ${c.a}/${c.n} 年・方向猜對 ${c.b}/${c.n} 年・全期方向猜對 ${f1(c.hit0)}% → ${f1(c.hit1)}%・開反 ${f1(c.wrong0)}% → ${f1(c.wrong1)}%・名次相關 ${f3(c.rho0)} → ${f3(c.rho1)}・講話 ${f1(c.call0)}% → ${f1(c.call1)}% ${c.pass ? '✓' : '✗'}`);
    log(`  旁邊三格過 ${J.nbr}・逐年樣本外 ${J.wf.w}/${J.wf.n}(${J.wf.list.join(' ')})`);
    log(`  → ${J.pass.map(x => x ? '✓' : '✗').join('')} ${J.ok ? '✅ 過' : '⛔ 沒過'}`);
    // 只描述
    const ys = yearsOf(rows);
    out.desc.io = Object.fromEntries(ys.map(y => { const R = rows.filter(r => r.d.startsWith(y)); return [y, r2(spearman(R.map(r => r.nm), R.map(r => r.io)) * 100) / 100]; }));
    out.desc.ioAll = r2(spearman(rows.map(r => r.nm), rows.map(r => r.io)) * 100) / 100;
    const big = (f) => { const R = rows.filter(f); return { n: R.length, gap: r2(mean(R.map(r => r.gap))), io: r2(mean(R.map(r => r.io))), up: r2(R.filter(r => r.gap > 0.3).length / (R.length || 1) * 100), dn: r2(R.filter(r => r.gap < -0.3).length / (R.length || 1) * 100) }; };
    out.desc.bins = { dn1: big(r => r.nm <= -1), dn02: big(r => r.nm <= -0.2 && r.nm > -1), flat: big(r => Math.abs(r.nm) < 0.2), up02: big(r => r.nm >= 0.2 && r.nm < 1), up1: big(r => r.nm >= 1) };
    log('・只描述(⛔ 拿來判):');
    log(`  夜盤漲跌 vs 0050 開盤到收盤(名次相關):全期 ${out.desc.ioAll}・${Object.entries(out.desc.io).map(([y, v]) => `${y} ${v >= 0 ? '+' : ''}${v}`).join('・')}`);
    for (const [k, nm] of [['dn1', '夜盤 ≤ −1%'], ['dn02', '−1% < 夜盤 ≤ −0.2%'], ['flat', '夜盤 ±0.2% 以內'], ['up02', '+0.2% ≤ 夜盤 < +1%'], ['up1', '夜盤 ≥ +1%']]) {
        const v = out.desc.bins[k]; log(`  ${nm.padEnd(16)} ${v.n} 天・0050 開高 ${v.up}% / 開低 ${v.dn}%・跳空平均 ${v.gap}%・開盤到收盤 ${v.io}%`);
    }
    return out;
}
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—', f3 = v => Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '—';

// ───────────────────────────── selftest
const addD = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export function synth(seed, opt = {}) {
    const R = rng(seed), g = () => { let s = 0; for (let i = 0; i < 6; i++) s += R(); return s - 3; };
    const TD = []; for (let d = '2017-05-15'; d <= '2026-12-31'; d = addD(d, 1)) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w && w < 6) TD.push(d); }
    const T = { d: {} }; let px = 10000; const nmOf = new Map();
    for (let i = 0; i < TD.length; i++) {
        const d = TD[i], ct = '2099' + d.slice(5, 7);          // 近月合約一個月換一次(跟真的一樣;⛔ 每天換)
        const dayClose = px, settle = Math.round(px * (1 + g() * 0.0005));
        // 夜盤:15:00 從日盤收盤附近開(歸屬下一個交易日 → 記在下一個日期)
        const nOpen = Math.round(dayClose * (1 + g() * 0.0003)), nm = g() * 0.8, nClose = Math.round(settle * (1 + nm / 100));
        const nightLab = opt.byStart ? d : TD[i + 1];
        T.d[d] = T.d[d] || {}; T.d[d].p = [[ct, dayClose, dayClose, dayClose, dayClose, settle, 1000, 10]];
        if (nightLab) { T.d[nightLab] = T.d[nightLab] || {}; T.d[nightLab].a = [[ct, nOpen, nOpen, nOpen, nClose, nClose, 500, 0]]; }
        if (TD[i + 1]) nmOf.set(TD[i + 1], Math.round((nClose / settle - 1) * 10000) / 100);
        px = Math.round(nClose * (1 + g() * 0.01));
    }
    const dump = [];
    for (let i = 1; i < TD.length; i++) {
        const d = TD[i], s = Math.round(g() * 4), nm = nmOf.get(d) ?? 0, nmNext = nmOf.get(TD[i + 1]) ?? 0;
        const gap = 0.12 * s + (opt.plant ? opt.plant * nm : 0) + (opt.future ? opt.future * nmNext : 0) + g() * 0.4;
        dump.push({ d, s, gap, io: g() * 0.8, usd: TD[i - 1] });
    }
    return { TD, T, dump };
}
const APPRULE = v => v >= 1 ? 1.5 : v >= 0.2 ? 1 : v <= -1 ? -2 : v <= -0.2 ? -1 : 0;   // selftest 對照用(⑤ 釘住 App 那條就是這個)

async function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    const A = synth(3), Bs = synth(3, { byStart: true });
    const a1 = alignCheck(A.T), a2 = alignCheck(Bs.T);
    ok('① 日期歸屬:夜盤記在「下一個交易日」→ 判 next;記在「開始那天」→ 判 start', a1.by === 'next' && a2.by === 'start', JSON.stringify([a1, a2]));
    ok('① 兩種寫法算出來的夜盤漲跌一模一樣(歸屬對了就是同一盤)', JSON.stringify([...nightMove(A.T, A.TD, 'next')].slice(0, 50)) === JSON.stringify([...nightMove(Bs.T, Bs.TD, 'start')].slice(0, 50).map(([d, v]) => [d, { ...v, lab: nightMove(A.T, A.TD, 'next').get(d).lab }])));
    const nmA = nightMove(A.T, A.TD, 'next'), d0 = A.TD[10], row = A.T.d[d0].a[0], pr = A.T.d[A.TD[9]].p[0];
    ok('② 夜盤漲跌 = 夜盤收盤 ÷ 前一個日盤同一個合約的結算價 − 1(同 App 的 CRefPrice)', nmA.get(d0).nm === Math.round((row[4] / pr[5] - 1) * 10000) / 100, JSON.stringify([nmA.get(d0), row, pr]));
    // ③ App 那條規則(headless 呼叫 _preOpenScore)—— 釘住現在的 App
    const html = fs.readFileSync(process.env.HTML || path.join(ROOT, 'index.html'), 'utf8');
    const probe = [1.2, 1, 0.99, 0.5, 0.2, 0.19, 0, -0.19, -0.2, -0.5, -0.99, -1, -1.5];
    const mp = await appNightPoints(probe, html);
    ok('③ 夜盤那一格的分數從 App 自己的 _preOpenScore 拿(現在 = ≥1% 1.5・≥0.2% 1・≤−0.2% −1・≤−1% −2)', probe.every(v => mp.get(v) === APPRULE(v)), JSON.stringify([...mp]));
    // ④ 埋效果 → 過;沒埋 → ⛔
    const mk = (S) => { const NM = nightMove(S.T, S.TD, alignCheck(S.T).by); return S.dump.filter(r => NM.has(r.d)).map(r => ({ ...r, nm: NM.get(r.d).nm, appPts: APPRULE(NM.get(r.d).nm) })); };
    const jP = judgeN(mk(synth(5, { plant: 0.6 }))), jZ = judgeN(mk(synth(5)));
    ok('④ 埋了「夜盤 → 開盤跳空」→ ✅', jP.ok, JSON.stringify({ pass: jP.pass, a: jP.main.a, b: jP.main.b, need: jP.need }));
    ok('④ 決定性對照:同一個世界沒埋 → ⛔', !jZ.ok, JSON.stringify({ pass: jZ.pass, a: jZ.main.a, b: jZ.main.b }));
    // ⑤ 偷看未來:跳空其實跟「開盤之後才開始的那一盤夜盤」有關 → 正確歸屬判 ⛔;注入往後挪一盤才判得出
    const F = synth(7, { future: 0.6 }), alF = alignCheck(F.T).by;
    const NM0 = nightMove(F.T, F.TD, alF), NM1 = nightMove(F.T, F.TD, alF, 1);
    const rowsOf = NM => F.dump.filter(r => NM.has(r.d)).map(r => ({ ...r, nm: NM.get(r.d).nm, appPts: APPRULE(NM.get(r.d).nm) }));
    ok('⑤ ⛔ 前視:跳空跟「之後那一盤」有關 → 正確的那一盤判 ⛔;注入「往後挪一盤」→ 判得出(證明歸屬錯一天就會偷看)', !judgeN(rowsOf(NM0)).ok && judgeN(rowsOf(NM1)).ok,
       JSON.stringify([judgeN(rowsOf(NM0)).pass, judgeN(rowsOf(NM1)).pass]));
    // ⑥ 封存:之後亂改 → 判定一樣
    const W = synth(9, { plant: 0.6 }), pts = new Map();
    for (const v of new Set([...nightMove(W.T, W.TD, 'next').values()].map(o => o.nm))) pts.set(v, APPRULE(v));
    ok('⑥ 合成資料真的跨過封存日', W.TD.at(-1) > RULE.cut);
    const q = () => {}, o1 = run({ TD: W.TD, T: W.T, dump: W.dump, pts }, q);
    const T2 = { d: Object.fromEntries(Object.entries(W.T.d).map(([d, v]) => [d, d > RULE.cut ? { p: (v.p || []).map(r => [r[0], 1, 1, 1, 1, 1, 1, 1]), a: (v.a || []).map(r => [r[0], 1, 1, 1, 99999, 1, 1, 1]) } : v])) };
    const o2 = run({ TD: W.TD, T: T2, dump: W.dump.map(r => r.d > RULE.cut ? { ...r, gap: 50, s: 9 } : r), pts }, q);
    ok('⑥ 封存日之後的夜盤 / 分數 / 跳空亂改 → 日期歸屬與判定一模一樣', JSON.stringify([o1.align, o1.judged.pass, o1.judged.main]) === JSON.stringify([o2.align, o2.judged.pass, o2.judged.main]));
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ TXNIGHT_PROBE_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(await selftest());
    const need = k => { if (!process.env[k]) throw new Error(`${k} 沒給`); return process.env[k]; };
    const T = JSON.parse(fs.readFileSync(need('TXNIGHT'), 'utf8'));
    const dump = JSON.parse(fs.readFileSync(need('DUMP'), 'utf8'));
    const TD = load0050(need('B0050').split(',').filter(Boolean)).map(b => b.d);
    const html = fs.readFileSync(process.env.HTML || path.join(ROOT, 'index.html'), 'utf8');
    const al = alignCheck({ d: Object.fromEntries(Object.entries(T.d || {}).filter(([d]) => d <= RULE.cut)) });
    const vals = al.by ? [...new Set([...nightMove({ d: T.d }, TD.filter(d => d <= RULE.cut), al.by).values()].map(o => o.nm))] : [];
    const pts = vals.length ? await appNightPoints(vals, html) : new Map();
    const out = run({ TD, T, dump, pts });
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
