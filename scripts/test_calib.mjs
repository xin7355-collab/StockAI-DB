#!/usr/bin/env node
/**
 * 📏 V82.2.5 回測說的 vs 推薦之後真的(pro.html `_calibAgg` / `_recoAllPicks` / `_recoCalibRender`)
 *
 *  ① 統計(純函式):只拿「那天推薦的每一筆都出場了」的日子下結論(⛔ 只算已出場的 —— 先停損的會先算進來);
 *     還在抱的另外算帳面(mtm,⛔ 下結論);沒有回測數字的另外計數;
 *     差距 = 實際 − 回測、95% 區間 = 平均 ± 1.96×標準差/√n;未滿 10 筆 → few;整段 < 0 → worse;整段 > 0 → better;含 0 → same;
 *     打幾折 = 實際平均 ÷ 回測平均;每一招分開、筆數多的在前
 *     決定性對照:每一筆實際報酬都減 3 → 差距平均剛好少 3、區間整段平移
 *  ② 整份名單:那天每一檔都算(含 🧬 不夠的、空頭那天的)、同一檔只留排最前面那一招;
 *     ⛔ 動到原本的「實際推薦」(還是前 2 名、只收 🧬、⛔ 空頭)
 *  ③ 真的走一遍 `_recoLedgerLoad(rule, 'pball', 起算日)`:收盤到觸發價才買、沒到不買;每一筆帶推薦當時的回測數字
 *  ④ 畫面:成績單下面多一塊、按「算整份名單」才算(⛔ 一打開就下載幾百檔)、有進度、算完出結論;390px ⛔ 橫向溢出;
 *     ⛔ 用 🔴🟢 講好壞;沒有 pageerror
 * 跑法:node scripts/test_calib.mjs ・INJECT=1 node scripts/test_calib.mjs(注入必紅)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');

const INJ = {
    cohort: ["const done = new Set([...byDay.entries()].filter(([, a]) => a.every(t => !t.st.open)).map(([d]) => d));", "const done = new Set([...byDay.keys()]);"],
    noMin: ["(n < MIN || se == null) ? 'few'", "(se == null) ? 'few'"],
    top2: ["if (src === 'pball') return this._recoAllPicks(day.pb, day.rule);", "if (src === 'pball') return this._recoPicks(day.pb, day.rule);"],
    noExp: ["kk: x.k || '', exp: Number.isFinite(+x.exp) && x.exp !== null && x.exp !== '' ? +x.exp : null, hq: +x.hq || 0,", "kk: x.k || '', exp: null, hq: +x.hq || 0,"],
    noW: ["w: Number.isFinite(+x.w) && x.w !== null && x.w !== '' ? +x.w : null };", "w: null };"],
    netHit: ["hw = WA.filter(t => +t.st.ret > 0).length", "hw = WA.filter(t => +t.st.net > 0).length"],
    autoAll: ["    if (!A) all = `<div class=\"labbar\"", "    if (!A) { setTimeout(() => this._calibStart(), 0); } if (!A) all = `<div class=\"labbar\""],
};

async function run(html) {
    const fails = [];
    const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'calib-')), 'pro.html');
    fs.writeFileSync(tmp, html);
    const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
        const errs = [];
        page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|fetch/i.test(t)) errs.push(t); });
        await page.goto(pathToFileURL(tmp).href);
        await page.waitForFunction(() => typeof PRO !== 'undefined' && typeof PRO._calibAgg === 'function', null, { timeout: 30000 });

        // ── ① 統計 ──
        const A = await page.evaluate(() => {
            const P = PRO;
            let seq = 0;
            const mk = (ret, exp, k = '招甲', open = false, ld) => ({ kk: k, exp, ld: ld || ('D' + (++seq)), st: { ret, net: ret - 0.44, open, bench: -1 } });
            const few = P._calibAgg([mk(1, 5), mk(2, 5), mk(3, 5)]);
            // 12 筆:實際都比回測少 4 左右(有一點波動)→ worse
            const W = []; for (let i = 0; i < 12; i++) W.push(mk(1 + (i % 3) * 0.5, 5 + (i % 2) * 0.2, i < 8 ? '招甲' : '招乙'));
            const worse = P._calibAgg([...W, mk(9, 5, '招甲', true), { kk: 'x', exp: null, ld: 'NOEXP', st: { ret: 1, net: 0.56, open: false } }]);
            // 同一天一筆停損出場、一筆還在抱 → 那天⛔ 進結論;另一天全部出場 → 進
            const cohort = P._calibAgg([mk(-5, 5, '招甲', false, 'X'), mk(8, 5, '招甲', true, 'X'), mk(2, 5, '招甲', false, 'Y')]);
            const shifted = P._calibAgg(W.map(t => ({ ...t, st: { ...t.st, ret: t.st.ret - 3 } })));
            const S = []; for (let i = 0; i < 12; i++) S.push(mk(i % 2 ? 9 : 1, 5));                 // 平均 5 = 回測 → same
            const same = P._calibAgg(S);
            const B = []; for (let i = 0; i < 12; i++) B.push(mk(8 + (i % 3) * 0.3, 5));              // 都比回測好 → better
            const better = P._calibAgg(B);
            // 🎯 V82.3.3 命中率:12 筆回測勝率 60%、還沒扣成本賺錢的 6 筆(其中 2 筆 +0.3% 扣成本後是賠的)→ 實際 50% vs 60%、分不出差別;
            //   20 筆回測勝率 80%、只有 4 筆賺 → 比回測低而且不是運氣;沒有 w 的那筆不算進命中率
            const hw = (ret, w, ld) => ({ ...mk(ret, 5, '招甲', false, ld), w });
            const H1 = []; for (let i = 0; i < 12; i++) H1.push(hw(i < 2 ? 0.3 : i < 6 ? 4 : -3, 60));
            const hit1 = P._calibAgg([...H1, mk(2, 5)]);
            const H2 = []; for (let i = 0; i < 20; i++) H2.push(hw(i < 4 ? 3 : -2, 80));
            const hit2 = P._calibAgg(H2);
            return { few, worse, shifted, same, better, cohort, hit1, hit2, hHtml: P._calibVerdictHtml(hit1.all) + P._calibVerdictHtml(hit2.all), noWHtml: P._calibVerdictHtml(worse.all),
                     html: P._calibVerdictHtml(worse.all) + P._calibVerdictHtml(few.all) + P._calibKHtml(worse.byK) + P._calibVerdictHtml(cohort.mtm) };
        });
        ok('① 未滿 10 筆 → few(⛔ 下結論)', A.few.all.verdict === 'few' && A.few.all.n === 3, JSON.stringify(A.few.all));
        const h1 = A.hit1.all.hit, h2 = A.hit2.all.hit;
        ok('①h 🎯 命中率只算有回測勝率的(12 筆,⛔ 算進沒有 w 的那筆)、用還沒扣成本的報酬(+0.3% 算命中)→ 50% vs 60% 分不出差別',
           h1 && h1.n === 12 && h1.win === 6 && Math.abs(h1.exp - 60) < 1e-9 && h1.verdict === 'same' && A.hit1.all.n === 13, JSON.stringify(h1));
        ok('①h 🎯 回測說 80%、實際 4/20 → 比回測低而且不是運氣', h2 && h2.verdict === 'worse' && h2.z < -1.96 && h2.live === 20, JSON.stringify(h2));
        ok('①h 🎯 白話:有 w → 寫實際 / 回測說幾 %;沒有 w → 明講「名單還沒存回測勝率」(⛔ 空白)',
           /命中率\(有回測勝率的 12 筆\)/.test(A.hHtml) && /比回測低,而且不是運氣/.test(A.hHtml) && /名單還沒存回測勝率/.test(A.noWHtml) && !/data-calibhit="none"/.test(A.hHtml), A.hHtml.slice(0, 300));
        ok('① 持有中 / 沒有回測數字各自計數、⛔ 混進結論', A.worse.all.n === 12 && A.worse.open === 1 && A.worse.noExp === 1 && A.worse.mtm.n === 13, JSON.stringify([A.worse.all.n, A.worse.open, A.worse.noExp, A.worse.mtm && A.worse.mtm.n]));
        ok('① 只拿全部出場的日子下結論:X 那天還有一筆在抱 → 整天⛔ 進結論(只剩 Y 1 筆)、帳面那行 3 筆都算',
            A.cohort.all && A.cohort.all.n === 1 && A.cohort.all.live === 2 && A.cohort.mtm.n === 3 && A.cohort.days === 2 && A.cohort.doneDays === 1 && A.cohort.mtm.verdict === 'mtm',
            JSON.stringify([A.cohort.all, A.cohort.mtm && A.cohort.mtm.n, A.cohort.days, A.cohort.doneDays]));
        ok('① 實際一直比回測少 → worse(區間整段 < 0)、打幾折 = 實際 ÷ 回測', A.worse.all.verdict === 'worse' && A.worse.all.hi < 0 && Math.abs(A.worse.all.ratio - A.worse.all.live / A.worse.all.exp) < 1e-12, JSON.stringify(A.worse.all));
        ok('① 平均剛好等於回測 → same(區間含 0)', A.same.all.verdict === 'same' && A.same.all.lo < 0 && A.same.all.hi > 0, JSON.stringify(A.same.all));
        ok('① 都比回測好 → better', A.better.all.verdict === 'better' && A.better.all.lo > 0, JSON.stringify(A.better.all));
        ok('① 每一招分開、筆數多的在前(招甲 8 筆、招乙 4 筆)', A.worse.byK[0].k === '招甲' && A.worse.byK[0].n === 8 && A.worse.byK[1].k === '招乙' && A.worse.byK[1].n === 4, JSON.stringify(A.worse.byK.map(g => [g.k, g.n])));
        ok('① 同一段期間大盤一起寫(每筆 −1% → 平均 −1%)', A.worse.all.bench === -1 && /同一段期間大盤/.test(A.html), JSON.stringify(A.worse.all.bench));
        ok('① 決定性對照:實際報酬都減 3 → 差距平均剛好少 3、區間整段平移',
            Math.abs((A.worse.all.diff - A.shifted.all.diff) - 3) < 1e-9 && Math.abs((A.worse.all.lo - A.shifted.all.lo) - 3) < 1e-9 && Math.abs((A.worse.all.hi - A.shifted.all.hi) - 3) < 1e-9,
            JSON.stringify([A.worse.all.diff, A.shifted.all.diff]));
        ok('① 白話:worse 說「不是運氣」、few 說「還太少」、帳面那行說「會變」、每一招那塊有招名', /不是運氣/.test(A.html) && /還太少/.test(A.html) && /帳面,會變/.test(A.html) && /招甲/.test(A.html), A.html.slice(0, 200));

        // ── ②③ 整份名單 vs 實際推薦,真的走一遍 _recoLedgerLoad ──
        const R = await page.evaluate(async () => {
            const P = PRO;
            const wk = (a, b) => { const r = []; for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) r.push(d.toISOString().slice(0, 10)); } return r; };
            const CAL = wk('2026-07-01', '2026-11-12');
            const m = new Map(CAL.map((d, i) => [d, 20000 + i]));
            P._twii = { m, days: CAL.slice(), lastAmt: true };
            const d0 = '2026-10-22', d1 = '2026-10-23';
            const kl = px => CAL.map(d => { const c = px[d] ?? 50; return { date: d.replace(/-/g, '/'), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; });
            const after = (d, v) => Object.fromEntries(CAL.filter(x => x >= d).map(x => [x, v]));
            const K = { A: kl(after(d1, 55)), B: kl(after(d1, 56)), C: kl(after(d1, 57)), D: kl({}), E: kl(after(d1, 60)) };
            // 名單(d0):A 🧬+、B 🧬−、C 空頭那天的、D 收盤沒到、E 同一檔兩招(只留排前面那招)
            const pb = [
                { s: 'A', k: '招甲', exp: 6, lb: 1, r: 1, o: 1, trig: 54, hq: 1, bear: 0, c: 50, w: 62.5, n: 40 },
                { s: 'B', k: '招乙', exp: 5, lb: 1, r: 1, o: 1, trig: 54, hq: 0, bear: 0, c: 50 },
                { s: 'C', k: '招甲', exp: 4, lb: 1, r: 1, o: 1, trig: 54, hq: 1, bear: 1, c: 50 },
                { s: 'D', k: '招丙', exp: 3, lb: 1, r: 1, o: 1, trig: 54, hq: 1, bear: 0, c: 50 },
                { s: 'E', k: '招丁', exp: 7, lb: 1, r: 1, o: 1, trig: 54, hq: 0, bear: 0, c: 50 },
                { s: 'E', k: '招戊', exp: 2, lb: 1, r: 2, o: 2, trig: 54, hq: 0, bear: 0, c: 50 },
            ];
            const H = { days: [{ d: d0, rule: 'mean', pb }] };
            P._rlK = {};
            P.fetchJson = async p => {
                if (/pick_history\.json/.test(p)) return H;
                const s = decodeURIComponent((p.match(/data\/([^/?]+)\.json/) || [])[1] || '');
                if (K[s]) return K[s];
                throw new Error('404 ' + p);
            };
            const all = P._recoAllPicks(pb, 'mean').map(x => x.s + ':' + x.k);
            const top = (P._recoPicks(pb, 'mean') || []).map(x => x.s);
            const L = await P._recoLedgerLoad('atr2', 'pball', d0);
            const T = await P._recoLedgerLoad('atr2', 'pb', d0);
            return { all, top, L: { n: L.trades.length, miss: L.miss.length, mech: L.mech, ex: L.trades.map(t => [t.sym, t.kk, t.exp, t.st && t.st.entry]), w: L.trades.map(t => t.sym + ':' + t.w) },
                     T: { n: T.trades.length, syms: T.trades.map(t => t.sym) } };
        });
        ok('② 整份名單:每一檔都算(含 🧬 不夠、空頭那天)、同一檔只留排前面那招', R.all.join(',') === 'E:招丁,A:招甲,B:招乙,C:招甲,D:招丙', R.all.join(','));
        ok('② 實際推薦照舊:前 2 名、只收 🧬、⛔ 空頭(A、D)', R.top.join(',') === 'A,D', R.top.join(','));
        ok('③ 整份名單照 🔥 買法:收盤到觸發價才買(4 筆)、沒到的不買(D)', R.L.mech === 'trig' && R.L.n === 4 && R.L.miss === 1, JSON.stringify(R.L));
        ok('③ 每一筆帶推薦當時的回測數字與招名、成交在隔天收盤', R.L.ex.every(([s, k, e, en]) => typeof k === 'string' && k && Number.isFinite(e) && en > 0) && (R.L.ex.find(x => x[0] === 'E') || [])[2] === 7, JSON.stringify(R.L.ex));
        ok('③h 🎯 名單上有回測勝率的那檔帶進來(A 62.5),舊格式沒有的是 null(⛔ 補 0)', R.L.w.includes('A:62.5') && R.L.w.filter(x => x.endsWith(':null')).length === R.L.n - 1, R.L.w.join(','));
        ok('③ 實際推薦那份還是前 2 名(A 買到、D 沒到)', R.T.n === 1 && R.T.syms[0] === 'A', JSON.stringify(R.T));

        // ── ④ 畫面 ──
        const U = await page.evaluate(async () => {
            const P = PRO;
            let host = document.getElementById('recoLedger');
            if (!host) { const d = document.createElement('div'); d.className = 'panel'; d.innerHTML = '<div id="recoLedger"></div>'; document.body.appendChild(d); host = document.getElementById('recoLedger'); }
            P._calibSig = null; P._CALIB_START = '2026-10-22';
            let fetched = 0; const f0 = P.fetchJson; P.fetchJson = async p => { fetched++; return f0(p); };
            P._recoLedgerRender();
            await new Promise(r => setTimeout(r, 600));
            const el = document.getElementById('recoCalib');
            const afterLedger = !!el && host.nextElementSibling === el;
            const before = el ? el.innerText : '', nCntBefore = el ? el.querySelectorAll('[data-calibcounts]').length : -1;
            const fetchedBefore = fetched, hasBtn = !!(el && el.querySelector('[data-calibgo]'));
            P._calibStart();
            const sawProg = !!document.querySelector('[data-calibprog]');
            await new Promise(r => setTimeout(r, 800));
            const after = el ? el.innerText : '', nCntAfter = el ? el.querySelectorAll('[data-calibcounts]').length : -1;
            const ov = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            return { afterLedger, before, after, hasBtn, sawProg, fetchedBefore, ov, nCntBefore, nCntAfter, html: el ? el.innerHTML : '' };
        });
        ok('④ 成績單下面多一塊「回測說的 vs 推薦之後真的」', U.afterLedger && /回測說的 vs 推薦之後真的/.test(U.before), U.before.slice(0, 120));
        ok('④ 一打開只算實際推薦;整份名單要按了才算(有按鈕、⛔ 自己跑)', U.hasBtn && U.nCntBefore === 1, `btn=${U.hasBtn} counts=${U.nCntBefore}`);
        ok('④ 按下去有進度、算完出結果', U.sawProg && U.nCntAfter === 2 && /整份名單[\s\S]*買到/.test(U.after), `counts=${U.nCntAfter} ` + U.after.slice(-300));
        ok('④ 390px ⛔ 橫向溢出', U.ov <= 1, `溢出 ${U.ov}px`);
        ok('④ ⛔ 用 🔴🟢 講好壞', !/[🔴🟢]/u.test(U.html), '');
        ok('④ 沒有 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));
    } finally {
        await browser.close();
    }
    return fails;
}

if (process.env.INJECT) {
    let missed = 0;
    for (const [k, pair] of Object.entries(INJ)) {
        const [a, b] = pair;
        if (!SRC.includes(a)) { console.log(`❌ 注入 ${k}:原始碼找不到要換的那一段(程式改了?)`); missed++; continue; }
        process.env.QUIET = '1';
        const f = await run(SRC.replace(a, b));
        delete process.env.QUIET;
        console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? `紅 ${f.length} 條(${f.slice(0, 2).join(' / ')})` : '⛔ 沒有任何一條紅'}`);
        if (!f.length) missed++;
    }
    process.exit(missed ? 1 : 0);
}
const fails = await run(SRC);
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ 全部通過');
process.exit(fails.length ? 1 : 0);
