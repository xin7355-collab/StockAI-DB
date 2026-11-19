#!/usr/bin/env node
/**
 * 🧠 V82.5.4 鏡子「你的習慣」(規劃第 4 期;💭 開著才有)
 *
 * ⛔ 釘死:
 *   ① 追高:買進那天碰到 `_QLAB_SIGS` 判 ⛔ 的那幾支或收盤鎖漲停 → 算;⭐ 決定性對照:買進日挪一天 → 不算;
 *      ⭐ 零前視:買進日之後的 K 換成亂數 → 結果一樣;隔天才鎖漲停 → 不算
 *   ② 早 / 晚 / 照計畫(你現在設定的出場規則回頭算,收盤跌破才算):三條線都沒碰到就賣 → 比計畫早;碰到那天或隔天賣 → 照計畫;
 *      隔天還沒賣 → 比計畫晚 + 跟碰到那天收盤賣差多少元;硬停損 / 你設定的線 / 抱滿天數三條都算;👑 / ETF 不判;K 線沒涵蓋賣出日 → 不算
 *   ③ 大盤大跌那天賣的:讀 `_DAY_TH`(⭐ 改那一份 → 跟著變)
 *   ④ 賠錢賣掉之後多久又買:當天到隔天 / 2~5 個交易日 / 更久 / 還沒;同一筆部位 ⛔ 算
 *   ⑤ 分組:這次為什麼賣 / 那天點的心情;未滿 10 筆寫「還太少」;未填放最後
 *   ⑥ 真的打開鏡子:💭 開著 → 有「🧠 你的習慣」;⭐ 決定性對照:沒解鎖 → 一個字都沒有
 *   ⑦ 句子 ⛔ 研究字樣、⛔ 指令字、⛔ 🔴🟢
 * 跑法:node scripts/test_habit.mjs ・INJECT=1 node scripts/test_habit.mjs(八種注入必紅)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(process.env.HTML || path.join(ROOT, 'index.html'), 'utf8');
const BAN = /(減碼|加碼|買進|賣出|現金比例|做多|做空|出脫|鎖利|停損|全面|強力|空手|承接|試單|分批|逢低|撿便宜|抄底|追進|搶反彈|別賣|不要賣|該賣|該買|建議你|保證|一定會|必漲|必跌|會漲|會跌|放空|現金為王|停利|快逃|出清|以後要|下次要|應該)/;

const INJ = {
    // 追高偷看隔天
    peek: ['const sub = d.slice(0, iB + 1);', 'const sub = d.slice(0, iB + 2);'],
    // 追高真的去看隔天那一根(行為上偷看)
    peek2: ['r.chase = hitAt(iB);', "r.chase = hitAt(iB) || (iB + 1 < d.length && this._luLock(d.slice(0, iB + 2), { anyTime: 1 }) ? '收盤鎖漲停' : null);"],
    // 碰到隔天就算晚
    late1: ['if (iS - jT >= 2) { r.plan = \'late\';', 'if (iS - jT >= 1) { r.plan = \'late\';'],
    // 不用解鎖
    nogate: ["    async _mirrorHabitFill(all, kl, posts) {\n        if (!this._deckShow().mood) return '';\n", '    async _mirrorHabitFill(all, kl, posts) {\n'],
    // 大跌門檻寫死
    dnfix: ['if (ch != null && ch <= T.dn2) r.dn = ch <= T.dn3 ? 3 : 2;', 'if (ch != null && ch <= -2) r.dn = ch <= -3 ? 3 : 2;'],
    // 同一筆部位也算又買
    self: ['const nx = B.find(x => x.b >= s && `${x.sym}|${kd(x.b)}` !== self);', 'const nx = B.find(x => x.b >= s);'],
    // 平常的比例把買的那天也算進去
    basepeek: ['for (let j = Math.max(30, iB - 250); j < iB; j++) { nb++; if (hitAt(j)) hb++; }', 'for (let j = Math.max(30, iB - 250); j <= iB; j++) { nb++; if (hitAt(j)) hb++; }'],
    // 不看抱滿天數
    nomaxd: ["if (j - iB >= maxd) { jT = j; why = 'maxd'; break; }", ''],
};

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

async function run(html, tag) {
    const fails = [];
    const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 360)}`); if (!c) fails.push(n); };
    const strip = html.replace(/\/\/[^\n]*/g, '');
    ok('ⓢ1 追高只看買進那天(含)以前的 K', /const sub = d\.slice\(0, iB \+ 1\);/.test(strip));
    ok('ⓢ2 大跌日讀 _DAY_TH(⛔ 寫死)', /ch <= T\.dn2\) r\.dn = ch <= T\.dn3/.test(strip));
    ok('ⓢ3 早晚用你設定的規則回頭算(_exitLevelAt + _maxHold)', /this\._exitLevelAt\(d, iB, j, key\)/.test(strip) && /this\._maxHold\(key\)/.test(strip));

    const TMP = path.join(ROOT, `.test_habit_${tag}.html`);
    fs.writeFileSync(TMP, html);
    const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const errs = [];
    const open = async (unlock) => {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
        page.on('pageerror', e => errs.push(String(e && e.message || e)));
        await page.addInitScript(u => { try { const o = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); o.stratUnlock = u; o.strategy = 'gene'; o.exitRule = 'don'; localStorage.setItem('proTerminalSettings', JSON.stringify(o)); } catch (_) {} }, unlock);
        await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._habitScan === 'function' && typeof QCORE !== 'undefined', null, { timeout: 60000 });
        await page.waitForTimeout(1200);
        return page;
    };
    try {
        const pg = await open(true);
        const R = await pg.evaluate(async () => {
            const o = {};
            // 交易日(平日)
            const days = []; { let t = Date.UTC(2025, 0, 6); while (days.length < 260) { const d = new Date(t), w = d.getUTCDay(); if (w && w < 6) days.push(d.toISOString().slice(0, 10).replace(/-/g, '/')); t += 864e5; } }
            const iso = d => d.replace(/\//g, '-');
            const flat = (n, c = 100) => Array.from({ length: n }, (_, i) => ({ date: days[i], open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }));
            const T = (sym, bi, si, x) => Object.assign({ symbol: sym, name: sym, cost: 100, sellPrice: 100, shares: 1, buyDate: iso(days[bi]), date: days[si], pnlNTD: 0, pnlPct: 0 }, x || {});
            const scan = (log, KL, tw, opt) => app._habitScan(log, KL, tw || new Map(), Object.assign({ key: 'don', maxd: 20 }, opt || {}));
            // ── ① 追高 ──
            const kG = flat(120); Object.assign(kG[60], { open: 104, high: 107, low: 103.5, close: 106 }); for (let i = 61; i < 120; i++) Object.assign(kG[i], { open: 106, high: 106.5, low: 105.5, close: 106 });
            const HG = scan([T('G1', 60, 70)], { G1: kG }); o.gap = HG.rows[0].chase; o.gapBase60 = HG.chase.nb;   // 買之前不到 60 天 → 不算比例
            const kG2 = flat(200); Object.assign(kG2[150], { open: 104, high: 107, low: 103.5, close: 106 }); for (let i = 151; i < 200; i++) Object.assign(kG2[i], { open: 106, high: 106.5, low: 105.5, close: 106 });
            const HG2 = scan([T('G2', 150, 160)], { G2: kG2 }); o.gapBase = [HG2.rows[0].chase, HG2.chase.exp, HG2.chase.nb];
            // 平常的比例:每 5 天一次跳空開高走高 → 買之前一年大約 2 成的日子碰得到
            const kB = []; { let c = 100; for (let i = 0; i < 260; i++) { const g = i > 0 && i % 5 === 0; const o2 = g ? c * 1.04 : c, c2 = g ? c * 1.05 : c; kB.push({ date: days[i], open: o2, high: Math.max(o2, c2) + 0.1, low: Math.min(o2, c2) - 0.1, close: c2, volume: 1000 }); c = c2; } }
            const HB = scan([T('B1', 200, 210)], { B1: kB }); o.base = [HB.chase.exp, HB.chase.nb];
            const kB2 = kB.map((b, i) => i <= 200 ? b : { date: b.date, open: 1, high: 300, low: 1, close: 150 + Math.random() * 100, volume: 99999 });
            o.baseRand = scan([T('B1', 200, 210)], { B1: kB2 }).chase.exp;
            o.gapShift = scan([T('G1', 61, 70)], { G1: kG }).rows[0].chase;
            const kR = kG.map((b, i) => i <= 60 ? b : (() => { const c = 50 + Math.random() * 100; return { date: b.date, open: c, high: c * 1.05, low: c * 0.95, close: c * (0.97 + Math.random() * 0.06), volume: 500 + Math.random() * 5000 }; })());
            o.gapRand = scan([T('G1', 60, 70)], { G1: kR }).rows[0].chase;
            // 隔天才鎖漲停(買進那天平盤)→ 不算追高
            const kL = flat(120); Object.assign(kL[61], { open: 100, high: 110, low: 100, close: 110 }); for (let i = 62; i < 120; i++) Object.assign(kL[i], { open: 110, high: 110.5, low: 109.5, close: 110 });
            o.luNext = scan([T('L1', 60, 70)], { L1: kL }).rows[0].chase;
            o.luSame = scan([T('L1', 61, 70)], { L1: kL }).rows[0].chase;
            // ── ② 早 / 晚 / 照計畫(cost 100、買進日 50;硬停損 95、唐奇安 20 = 99.5)──
            const kE = flat(140); for (let i = 56; i < 140; i++) Object.assign(kE[i], { open: 99, high: 99.4, low: 98.6, close: 99 });   // 第 56 根收 99 < 99.5 → 碰到線
            const p = si => scan([T('E1', 50, si, { sellPrice: 99 })], { E1: kE }).rows[0];
            o.e54 = p(54).plan; o.e56 = p(56).plan; o.e57 = p(57).plan; const r58 = p(58); o.e58 = [r58.plan, r58.why, r58.jDate, r58.diff];
            const kS = flat(140); for (let i = 56; i < 140; i++) Object.assign(kS[i], { open: 94, high: 94.4, low: 93.6, close: 94 });
            const rs = scan([T('S1', 50, 60, { sellPrice: 93 })], { S1: kS }).rows[0]; o.stop = [rs.plan, rs.why, rs.diff];
            const kM = flat(140);
            const m = si => scan([T('M1', 50, si)], { M1: kM }).rows[0];
            o.m69 = m(69).plan; o.m70 = [m(70).plan, m(70).why]; o.m75 = [m(75).plan, m(75).why];
            o.etf = scan([T('0050', 50, 75)], { '0050': kM }).rows[0].plan;
            o.lead = scan([T('M1', 50, 75, { why: 'lead' })], { M1: kM }).rows[0].plan;
            const Hc = scan([T('M1', 50, 130)], { M1: kM.slice(0, 120) }); o.cover = [Hc.nk, Hc.rows[0].plan];
            // ── ③ 大盤大跌那天 ──
            const tw = new Map(days.map(d => [iso(d), 0.1]));
            tw.set(iso(days[70]), -2.5); tw.set(iso(days[71]), -3.4); tw.set(iso(days[72]), -1.9);
            const L3 = [T('M1', 50, 70), T('M1', 50, 71), T('M1', 50, 72)];
            const H3 = scan(L3, { M1: kM }, tw); o.dn = H3.rows.map(r => r.dn); o.dnN = [H3.dn.n, H3.dn.n3];
            const keep = app._DAY_TH.dn2; app._DAY_TH.dn2 = -1.5;
            try { o.dnShared = scan(L3, { M1: kM }, tw).rows.map(r => r.dn); } finally { app._DAY_TH.dn2 = keep; }
            // ── ④ 賠錢賣掉之後多久又買 ──
            const loss = { pnlNTD: -1000, pnlPct: -5 };
            const L4 = [T('A', 40, 60, loss), T('B', 60, 65), T('C', 50, 70, loss), T('D', 74, 80), T('E', 55, 80, loss), T('F', 95, 99), T('G', 60, 96, loss),
                        T('H', 90, 97, loss), T('H', 90, 99, loss), T('I', 30, 30, loss)];   // I = 當天買當天賣(同一筆部位 ⛔ 算又買)
            o.rebuy = scan(L4, {}, tw).rebuy;
            // ── ⑤ 分組 ──
            const L5 = [];
            for (let i = 0; i < 12; i++) L5.push(T('W', 40, 41 + i, { sellWhy: 'cant', pnlNTD: i % 3 ? 500 : -500, pnlPct: i % 3 ? 2 : -2 }));
            for (let i = 0; i < 2; i++) L5.push(T('W', 40, 60 + i, { sellWhy: 'cash', pnlNTD: 100, pnlPct: 1 }));
            for (let i = 0; i < 3; i++) L5.push(T('W', 40, 70 + i, { sellWhy: 'zzz', pnlNTD: -100, pnlPct: -1 }));
            const mood = [{ t: 1, d: iso(days[41]), m: 'fear' }, { t: 3, d: iso(days[41]), m: 'cant_x' }, { t: 2, d: iso(days[42]), m: 'fomo' }, { t: 5, d: iso(days[42]), m: 'fear' }];
            const H5 = scan(L5, {}, tw, { mood });
            o.why = H5.byWhy.map(g => [g.k, g.n, g.win]); o.moodG = H5.byMood.map(g => [g.k, g.n]);
            const box = h => { const d = document.createElement('div'); d.innerHTML = h || ''; return d; };
            const H5k = scan(L5.map(t => Object.assign({}, t)), { W: flat(140) }, tw, { mood });
            const h5 = box(app._mirrorHabitHtml(H5k));
            o.h5 = { k: [...h5.querySelectorAll('[data-habitk]')].map(e => e.dataset.habitk), why: [...h5.querySelectorAll('[data-habitwhy]')].map(e => [e.dataset.habitwhy, e.textContent.replace(/\s+/g, ' ').trim()]), foot: h5.textContent.includes(app._exitRuleName()), few: (h5.textContent.match(/還太少/g) || []).length };
            // ⑦ 字
            o.copy = Object.values(app._HABIT_COPY);
            o.texts = [h5.textContent];
            // ── ⑥ 真的打開鏡子 ──
            const keepF = app.fetchHistoricalData, keepT = app._getTwiiRows;
            try {
                localStorage.setItem('proTerminalTradeLog', JSON.stringify([T('M1', 50, 75, { sellPrice: 100, pnlNTD: -300 }), T('E1', 50, 58, { sellPrice: 99 })]));
                app.fetchHistoricalData = async s => ({ M1: kM, E1: kE, '0050': flat(140) })[s] || null;
                app._getTwiiRows = async () => days.slice(0, 140).map(d => ({ date: d, close: 20000 }));
                app._showTradeMirror();
                for (let k = 0; k < 60 && !document.querySelector('#mirrorHabit [data-habit]'); k++) await new Promise(r => setTimeout(r, 100));
                const hb = document.querySelector('#mirrorHabit [data-habit]');
                o.live = hb ? { n: hb.dataset.habit, k: [...hb.querySelectorAll('[data-habitk]')].map(e => e.dataset.habitk), txt: hb.textContent.replace(/\s+/g, ' ').slice(0, 400) } : null;
                o.texts.push(hb ? hb.textContent : '');
            } finally { app.fetchHistoricalData = keepF; app._getTwiiRows = keepT; localStorage.removeItem('proTerminalTradeLog'); }
            return o;
        });
        ok('① 買進那天跳空開高走高 → 算追高(寫是哪一種)', R.gap === '跳空開高走高', R.gap);
        ok('① ⭐ 決定性對照:買進日挪到隔天 → 不算', R.gapShift === null, R.gapShift);
        ok('① ⭐ 零前視:買進日之後的 K 換成亂數 → 一樣算', R.gapRand === '跳空開高走高', R.gapRand);
        ok('① 平常的比例:買之前不到 60 天 → 不算;前面都平平 → 0 筆;每 5 天一次跳空 → 大約 0.2 筆(⭐ 零前視:買的那天以後換成亂數 → 一樣;⛔ 含買的那天)', R.gapBase60 === 0 && R.gapBase[0] === '跳空開高走高' && R.gapBase[1] === 0 && R.gapBase[2] === 1 && Math.abs(R.base[0] - 0.2) < 0.02 && R.base[1] === 1 && R.baseRand === R.base[0], JSON.stringify([R.gapBase, R.base, R.baseRand]));
        ok('① 隔天才鎖漲停 → 不算;買在鎖漲停那天 → 算「收盤鎖漲停」', R.luNext === null && R.luSame === '收盤鎖漲停', JSON.stringify([R.luNext, R.luSame]));
        ok('② 三條線都還沒碰到就賣 → 比計畫早', R.e54 === 'early', R.e54);
        ok('② 碰到那天 / 隔天賣 → 照計畫', R.e56 === 'ok' && R.e57 === 'ok', JSON.stringify([R.e56, R.e57]));
        ok('② 隔天還沒賣 → 比計畫晚(你設定的線、碰到那天、差多少元 = 股數 ×(賣價 − 那天收盤))', R.e58[0] === 'late' && R.e58[1] === 'line' && R.e58[3] === 0, JSON.stringify(R.e58));
        ok('② 收盤跌破硬停損 → 算碰到(硬停損),晚賣差 −1,000 元', R.stop[0] === 'late' && R.stop[1] === 'stop' && R.stop[2] === -1000, JSON.stringify(R.stop));
        ok('② 抱滿 20 個交易日:第 19 根賣 → 早、第 20 根 → 照計畫、第 25 根 → 晚', R.m69 === 'early' && R.m70[0] === 'ok' && R.m70[1] === 'maxd' && R.m75[0] === 'late' && R.m75[1] === 'maxd', JSON.stringify([R.m69, R.m70, R.m75]));
        ok('② ETF / 👑 不判早晚;K 線沒涵蓋賣出日 → 不算', R.etf === 'etf' && R.lead === 'lead' && R.cover[0] === 0 && R.cover[1] === null, JSON.stringify([R.etf, R.lead, R.cover]));
        ok('③ 大盤那天 −2.5 / −3.4 / −1.9 → 跌 2% / 跌 3% / 不算', JSON.stringify(R.dn) === '[2,3,0]' && R.dnN[0] === 2 && R.dnN[1] === 1, JSON.stringify([R.dn, R.dnN]));
        ok('③ ⭐ 改那一份門檻(_DAY_TH.dn2 = −1.5)→ −1.9 那天也算', JSON.stringify(R.dnShared) === '[2,3,2]', JSON.stringify(R.dnShared));
        ok('④ 當天到隔天 1・2~5 天 1・更久 2・還沒再買 3(當天買當天賣那筆 ⛔ 算成自己又買)', R.rebuy.b01 === 1 && R.rebuy.b25 === 1 && R.rebuy.bl === 2 && R.rebuy.none === 3 && R.rebuy.n === 7, JSON.stringify(R.rebuy));
        ok('⑤ 這次為什麼賣:受不了 12 筆(賺 8)/ 要用錢 2 / 未填 3(不認得的算未填、放最後)', JSON.stringify(R.why) === JSON.stringify([['cant', 12, 8], ['cash', 2, 2], ['', 3, 0]]), JSON.stringify(R.why));
        ok('⑤ 那天點的心情:同一天點好幾種 → 最後點的那種;不認得的心情不算', JSON.stringify(R.moodG) === JSON.stringify([['fear', 2], ['', 15]]), JSON.stringify(R.moodG));
        ok('⑤ 畫出來:五行 + 照為什麼賣分 + 腳註寫你現在的出場規則;未滿 10 筆寫還太少', JSON.stringify(R.h5.k) === JSON.stringify(['chase', 'dn', 'early', 'late', 'ok', 'rebuy']) && R.h5.why.length === 3 && R.h5.foot && R.h5.few >= 3, JSON.stringify(R.h5).slice(0, 300));
        ok('⑥ 真的打開鏡子(💭 開著):有「🧠 你的習慣」、2 筆都對得到 K 線', !!R.live && R.live.n === '2' && R.live.k.includes('early'), JSON.stringify(R.live));
        const badT = R.texts.join('\n').split('\n').filter(s => badOf(s).length);
        const badC = R.copy.filter(s => badOf(s).length || BAN.test(String(s).replace(/買進日|賣出紀錄/g, '')) || /🔴|🟢/.test(s));   // 「買進日」「賣出紀錄」是欄位 / 功能名稱
        ok('⑦ 句子與畫出來的字 ⛔ 研究字樣 / 指令字 / 🔴🟢', !badT.length && !badC.length, JSON.stringify([badT, badC]).slice(0, 300));

        const pl = await open(false);
        const L6 = await pl.evaluate(async () => {
            const days = []; { let t = Date.UTC(2025, 0, 6); while (days.length < 140) { const d = new Date(t), w = d.getUTCDay(); if (w && w < 6) days.push(d.toISOString().slice(0, 10).replace(/-/g, '/')); t += 864e5; } }
            const K = days.map(d => ({ date: d, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
            const tr = { symbol: 'M1', name: 'M1', cost: 100, sellPrice: 100, shares: 1, buyDate: days[50].replace(/\//g, '-'), date: days[75], pnlNTD: -300, pnlPct: -1 };
            localStorage.setItem('proTerminalTradeLog', JSON.stringify([{ symbol: '2330', name: '2330', cost: 100, sellPrice: 99, shares: 1, buyDate: '2025-03-03', date: '2025/04/01' }]));
            app.fetchHistoricalData = async () => null; app._getTwiiRows = async () => [];
            app._showTradeMirror(); await new Promise(r => setTimeout(r, 1500));
            const o = { slot: !!document.getElementById('mirrorHabit'), fill: await app._mirrorHabitFill([tr], { M1: K }, []) };
            localStorage.removeItem('proTerminalTradeLog');
            return o;
        });
        ok('⑥ ⭐ 決定性對照:沒解鎖 → 鏡子裡沒有「你的習慣」那一格、算出來是空字串', !L6.slot && L6.fill === '', JSON.stringify(L6));
        ok('整段沒有 pageerror', !errs.length, errs.slice(0, 3).join(' | '));
    } finally {
        await browser.close();
        try { fs.unlinkSync(TMP); } catch (_) {}
    }
    return fails;
}

if (process.env.INJECT) {
    let bad = 0;
    for (const [k, [a, b]] of Object.entries(INJ)) {
        const n = ORIG.split(a).length - 1;
        if (n !== 1) { console.log(`❌ 注入 ${k}:目標字串出現 ${n} 次(要剛好 1 次)`); bad++; continue; }
        process.env.QUIET = '1';
        const f = await run(ORIG.replace(a, b), 'inj_' + k);
        console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? `紅了 ${f.length} 條(${f.slice(0, 3).join(' / ')})` : '一條都沒紅(測試沒有鑑別力)'}`);
        if (!f.length) bad++;
    }
    console.log(bad ? `\n❌ HABIT_INJECT_FAIL(${bad} 種注入沒被抓到)` : `\n✅ HABIT_INJECT_PASS(${Object.keys(INJ).length} 種注入全紅)`);
    process.exit(bad ? 1 : 0);
}
const fails = await run(ORIG, 'main');
console.log(fails.length ? `\n❌ HABIT_FAIL(${fails.length} 條)` : '\n✅ HABIT_PASS');
process.exit(fails.length ? 1 : 0);
