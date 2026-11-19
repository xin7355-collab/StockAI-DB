#!/usr/bin/env node
/**
 * 💭 V82.5.2 決策台第一行「今天的心情」(使用者 11/18:「AI 做的 App 太過於理性…加上人性的貪婪與恐懼」
 *    → 選「情緒大的日子才講人話」「只給解鎖進階功能的人」)
 *
 * ⛔ 釘死:
 *   ⓢ 靜態:門檻只有一份 `_DAY_TH`(數字沒換:−3 / −2 / +2 / 兩成)、觸發專欄 ⛔ 再寫死;
 *          登記表 mood = 進階功能、預設開、排在 cross 前;#deckMood 緊接在 #deckHead 後面
 *   ① `_moodState` 純判斷:−3.2 大跌 / −2.5 跌 2% / +2.3 大漲;⭐ 決定性對照:同一份改成 −1.9 / +1.9 → null(平常日一個字都沒有)
 *   ② 優先序(跌停 > 跌 3% > 新的大跌事件 > 熔斷 > 跌 2% > 漲停 > 漲 2% > 帳面賺兩成);修正段「結束」、熔斷 ok ⛔ 算情緒日
 *   ③ ⭐ 改那一份常數 → 決策台的判斷與觸發專欄(idx_drop2)一起變
 *   ④ 第二句只轉述出場線:都沒碰到 → 「都還沒碰到…不用動」;⛔ 有算不出來的 / 在線下的 / 今天可能碰到的 → ⛔ 說都沒碰到、⛔ 說不用動
 *   ⑤ 大漲那天:名單有 → 照名單講;沒有 → 「照規則就是不買」;空頭不開新倉 / 名單沒讀到 / 那塊收起來 各講各的
 *   ⑥ 熔斷:第二句 = 🧯 那一行同一句(`_brkMsg`);🧯 那一行輸出跟改之前一字不差
 *   ⑦ 帳面賺兩成:同一筆只在第一次看到那天講
 *   ⑧ 讀資料(`_moodGather`):今天的大盤優先、沒有才用最後一根收盤(帶日期、太舊不講);大跌事件只收最新那天的、「結束」不收;
 *      漲停跌停只看今天的價、ETF 不算;熔斷同一週只在剛亮那天 / 今天又賠一筆才講
 *   ⑨ 句子表 `_MOOD_COPY` 逐句:⛔ 研究字樣(lib_retailbad)、⛔ 指令字、⛔ 🔴🟢;👑 只在選 👑 才會用到的那三句;整塊 ⛔ 紅綠樣式
 *   ⑩ 決策台真的畫(renderDeck):解鎖 + 大跌 → 有、在頂端那格下面;⭐ 決定性對照:−1.9 → 空;沒解鎖 / 關掉 → 空而且藏起來;
 *      設定「🔓 進階功能」列得出來、一般勾選清單 ⛔ 出現;沒選 👑 時畫面 ⛔ 👑 / 領頭羊
 * 跑法:node scripts/test_mood.mjs ・INJECT=1 node scripts/test_mood.mjs(七種注入必紅)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 指令字(⛔ 句子表裡不可出現):test_nodirective 那一組 + 情緒時最常見的幾種
const BAN = /(減碼|加碼|買進|賣出|賣 ?1\/3|現金比例|Call|Put|做多|做空|出脫|鎖利|停損|全面|強力|空手|承接|試單|追高|分批|逢低|撿便宜|抄底|追進|搶反彈|攤平|別賣|不要賣|該賣|該買|建議|保證|一定會|必漲|必跌|會漲|會跌|放空|現金為王|停利|落袋|快逃|出清)/;

const INJ = {
    // 門檻偷改:平常日也算情緒日
    th: ['dn2 = pct != null && pct <= T.dn2,', 'dn2 = pct != null && pct <= 0,'],
    // 不用解鎖就看得到
    nounlock: ["{ k: 'mood', unlock: true, n:", "{ k: 'mood', n:"],
    // 觸發專欄又寫死自己的門檻(兩邊不再同一份)
    lit: ["if (x != null && x <= this._DAY_TH.dn2 && x > this._DAY_TH.dn3) { add('idx_drop2'", "if (x != null && x <= -2 && x > -3) { add('idx_drop2'"],
    // 有算不出來的照樣說「都還沒碰到」
    allok: ['(S.skip || S.lead || S.dip || S.okNear) ? P.okSome : P.okAll', 'P.okAll'],
    // 整塊用紅色講好壞
    red: ['border-l-4 border-gray-500 border-y border-r border-[#30363d] rounded-r p-2.5 mb-2" data-deckmood=', 'border-l-4 border-red-500 border-y border-r border-[#30363d] rounded-r p-2.5 mb-2" data-deckmood='],
    // 帳面賺兩成天天講
    daily: ['if (gKeep[k] === today && !gseen.has(sym))', 'if (!gseen.has(sym))'],
    // 熔斷那一句自己另寫一份
    brkcopy: ["if (M.side === 'back') { const m = this._brkMsg(M.brk); return (m && m.todo) ? m.todo + '。' : ''; }", "if (M.side === 'back') { return '這幾天先休息。'; }"],
};

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

async function run(html, tag) {
    const fails = [];
    const quiet = !!process.env.QUIET;
    const ok = (n, c, e = '') => { if (!quiet) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 320)}`); if (!c) fails.push(n); };

    // ── ⓢ 靜態 ──
    const strip = html.replace(/\/\/[^\n]*/g, '');
    const th = strip.match(/_DAY_TH:\s*\{\s*dn3:\s*(-?[\d.]+),\s*dn2:\s*(-?[\d.]+),\s*up2:\s*(-?[\d.]+),\s*gain:\s*(-?[\d.]+)\s*\}/);
    ok('ⓢ1 門檻只有一份 _DAY_TH,數字沒換(−3 / −2 / +2 / 0.2)', !!th && +th[1] === -3 && +th[2] === -2 && +th[3] === 2 && +th[4] === 0.2, th && th[0]);
    const litLeft = [/x <= -2 && x > -3\) \{ add\('idx_drop2'/, /x <= -2 && wk === '五'/, /x >= 2\) \{ add\('idx_up2'/, /\* 100 <= -3\) \{ add\('idx_drop3'/, /cost - 1 >= 0\.2\) add\('gain20'/, /ch <= -2 : ch >= 2/].filter(r => r.test(strip));
    ok('ⓢ2 觸發專欄 ⛔ 再寫死 −3 / −2 / +2 / 0.2(一律讀 _DAY_TH)', litLeft.length === 0, litLeft.map(String).join(' '));
    const reg = strip.match(/\{ k: 'mood',[^\n]*\n/);
    const iMood = strip.indexOf("{ k: 'mood', unlock:"), iCross = strip.indexOf("{ k: 'cross', unlock:");   // ⚠️ 通知分類表也有一個 { k: 'cross', → 只認登記表那一個
    ok('ⓢ3 登記表:mood = 進階功能(unlock)、預設開、排在 cross 前', !!reg && /unlock: true/.test(reg[0]) && /def: true/.test(reg[0]) && iMood > 0 && iMood < iCross, reg && reg[0].slice(0, 120));
    ok('ⓢ4 #deckMood 緊接在 #deckHead 後面', /<div id="deckHead"><\/div>\s*<div id="deckMood"><\/div>/.test(html));

    const TMP = path.join(ROOT, `.test_mood_${tag}.html`);
    fs.writeFileSync(TMP, html);
    const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const errs = [];
    const open = async (unlock, strategy) => {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
        page.on('pageerror', e => errs.push(String(e && e.message || e)));
        await page.addInitScript(([u, s]) => { try { const o = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); o.stratUnlock = u; o.strategy = s; localStorage.setItem('proTerminalSettings', JSON.stringify(o)); } catch (_) {} }, [unlock, strategy]);
        await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._moodState === 'function' && typeof app.renderDeck === 'function', null, { timeout: 60000 });
        await page.waitForTimeout(1500);
        return page;
    };
    try {
        const pg = await open(true, 'gene');

        // ── ①② 純判斷 ──
        const A = await pg.evaluate(() => {
            const d = '2026-11-18', S = I => { const m = app._moodState(I); return m ? `${m.kind}/${m.side}` : null; };
            return {
                dn3: S({ mk: { pct: -3.2, d } }), dn2: S({ mk: { pct: -2.5, d } }), up2: S({ mk: { pct: 2.3, d } }),
                calm: S({ mk: { pct: -1.9, d } }), calmUp: S({ mk: { pct: 1.9, d } }), none: S({}), nul: S(null),
                p1: S({ mk: { pct: -3.5, d }, ld: ['2330'], ev: { k: 'leg10', d } }),
                p2: S({ mk: { pct: -3.5, d }, ev: { k: 'bear20', d }, brk: 'week' }),
                p3: S({ mk: { pct: -2.2, d }, ev: { k: 'leg10', d }, brk: 'week' }),
                p4: S({ mk: { pct: -2.2, d }, brk: 'week' }),
                p5: S({ mk: { pct: 2.4, d }, lu: ['2330'] }),
                p6: S({ mk: { pct: 1.0, d }, gain: ['2454'] }),
                p7: S({ mk: { pct: -2.1, d }, lu: ['2330'] }),
                endEv: S({ ev: { k: 'end', d } }), brkOk: S({ brk: 'ok' }), brkNoacc: S({ brk: 'noacc' }),
                gainLu: (app._moodState({ lu: ['2330'], gain: ['2330', '2454'] }) || {}).gain,
                gainOnlyLu: S({ lu: [], gain: [] }),
            };
        });
        ok('① −3.2 → 大跌(怕)', A.dn3 === 'dn3/fear', A.dn3);
        ok('① −2.5 → 跌 2%(怕)', A.dn2 === 'dn2/fear', A.dn2);
        ok('① +2.3 → 大漲(怕錯過)', A.up2 === 'up2/fomo', A.up2);
        ok('① ⭐ 決定性對照:同一份改成 −1.9 / +1.9 → 平常日(null)', A.calm === null && A.calmUp === null && A.none === null && A.nul === null, JSON.stringify([A.calm, A.calmUp, A.none, A.nul]));
        ok('② 優先序:跌停 > 跌 3% > 新的大跌事件 > 熔斷 > 跌 2% > 漲停 > 漲 2% > 帳面賺兩成',
            A.p1 === 'ld/fear' && A.p2 === 'dn3/fear' && A.p3 === 'ev/fear' && A.p4 === 'brk/back' && A.p5 === 'lu/lock' && A.p6 === 'gain/lock' && A.p7 === 'dn2/fear',
            JSON.stringify([A.p1, A.p2, A.p3, A.p4, A.p5, A.p6, A.p7]));
        ok('② 修正段「結束」、熔斷 ok / noacc ⛔ 算情緒日', A.endEv === null && A.brkOk === null && A.brkNoacc === null, JSON.stringify([A.endEv, A.brkOk, A.brkNoacc]));
        ok('② 同一檔漲停又賺兩成 → 只講漲停那件(⛔ 講兩次)', JSON.stringify(A.gainLu) === JSON.stringify(['2454']), JSON.stringify(A.gainLu));

        // ── ③ 改那一份常數 → 決策台判斷與觸發專欄一起變 ──
        const B = await pg.evaluate(() => {
            const tw = []; let d = new Date('2026-06-01T00:00:00Z'), c = 20000;
            while (tw.length < 130) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w === 0 || w === 6) continue; c *= 1.0004; tw.push({ date: d.toISOString().slice(0, 10).replace(/-/g, '/'), close: +c.toFixed(2) }); }
            const c0 = tw[tw.length - 2].close; tw[tw.length - 1].close = +(c0 * (1 - 0.019)).toFixed(2);   // 最後一天跌 1.9%
            const today = { tdy: '2026-11-18', wk: 3, weekday: true };
            const col = () => app._colTrigEval({ tw, today, held: new Map(), bars: new Map(), fav: [], div: null, events: [], floor: null }).some(h => h.id === 'idx_drop2');
            const st = () => { const m = app._moodState({ mk: { pct: -1.9, d: '2026-11-18' } }); return m ? m.kind : null; };
            const th0 = app._DAY_TH, before = { st: st(), col: col() };
            app._DAY_TH = Object.assign({}, th0, { dn2: -1.5 });
            const after = { st: st(), col: col() };
            app._DAY_TH = th0;
            return { before, after };
        });
        ok('③ 原本的門檻:−1.9 兩邊都不算', B.before.st === null && B.before.col === false, JSON.stringify(B.before));
        ok('③ ⭐ 把那一份常數改成 −1.5 → 決策台與觸發專欄一起算(同一份)', B.after.st === 'dn2' && B.after.col === true, JSON.stringify(B.after));

        // ── ④⑤⑥ 第二句 ──
        const C = await pg.evaluate(() => {
            const keep = { inv: app._getInventory, q: app._deckQuoteOf, lm: app._leaderMine, dm: app._dipMine, lead: app._isLead, ds: app.settings.deckShow };
            const out = {};
            try {
                app._leaderMine = () => new Set(); app._dipMine = () => new Set();
                const ed = (pC, lines, level) => ({ pC, asOf: '2026-11-18', level, lines: lines.map(([name, v]) => ({ name, v })) });
                const r2330 = { sym: '2330', ed: ed(520, [['硬停損', 475], ['吊燈 ATR 2 倍', 490]], 'far') };
                const r2317 = { sym: '2317', ed: ed(110, [['硬停損', 95]], 'far') };
                const R = new Map([['2330', r2330], ['2317', r2317]]);
                const G = { today: '2026-11-18', R };
                const inv2 = [{ symbol: '2330', cost: 500, shares: 1 }, { symbol: '2317', cost: 100, shares: 2 }, { symbol: '0050', cost: 150, shares: 1 }];
                const M = app._moodState({ mk: { pct: -3.3, d: '2026-11-18' } });
                const P = (st, X, inv, q, m) => { app._getInventory = () => inv; app._deckQuoteOf = q || (() => null); return app._moodPlan(m || M, st, G, X); };
                out.allOk = P({ sell: [] }, { near: [], far: [r2330, r2317] }, inv2);
                out.skip = P({ sell: [] }, { near: [], far: [r2330, r2317] }, inv2.concat([{ symbol: '3008', cost: 2000, shares: 1 }]));
                out.under = P({ sell: [] }, { near: [], far: [r2330, r2317] }, inv2, s => s === '2317' ? { p: 90, chg: -5 } : null);
                const nearT = { sym: '2330', ed: Object.assign({}, r2330.ed, { level: 'today' }) };
                out.near = P({ sell: [] }, { near: [nearT], far: [r2317] }, inv2);
                out.sell = P({ sell: [{ sym: '2330' }] }, { near: [], far: [r2317] }, inv2);
                out.none = P({ sell: [] }, { near: [], far: [] }, []);
                out.etfOnly = P({ sell: [] }, { near: [], far: [] }, [{ symbol: '0050', cost: 150, shares: 1 }]);
                const Mld = app._moodState({ mk: { pct: -1.0, d: '2026-11-18' }, ld: ['2330'] });
                out.ld = P({ sell: [] }, { near: [], far: [r2330, r2317] }, inv2, null, Mld);
                // ⑤ 大漲那天
                const Mup = app._moodState({ mk: { pct: 2.4, d: '2026-11-18' } });
                app.settings.deckShow = Object.assign({}, keep.ds || {}, { pb: true });
                out.upList = app._moodPlan(Mup, { buy: [{ s: '2330' }, { s: '2454' }] }, G, {});
                out.upNone = app._moodPlan(Mup, { buy: [] }, G, {});
                out.upBear = app._moodPlan(Mup, { buy: [], bearGate: true }, G, {});
                out.upNull = app._moodPlan(Mup, { pbNull: true, buy: [] }, G, {});
                app.settings.deckShow = Object.assign({}, keep.ds || {}, { pb: false });
                out.upOff = app._moodPlan(Mup, { buy: [{ s: '2330' }] }, G, {});
                app.settings.deckShow = keep.ds;
                app._isLead = () => true; out.upLead = app._moodPlan(Mup, { buy: [{ s: '2330' }] }, G, {}); app._isLead = keep.lead;
                // ⑥ 熔斷
                const Mb = app._moodState({ brk: 'week' });
                out.brk = app._moodPlan(Mb, {}, G, {});
                out.brkWant = app._brkMsg('week').todo + '。';
                const L = app._BRK_LIM;
                out.brkLine = app._acctBreakerHtml({ state: 'week', sum: { day: -100, week: -6000, month: -6000 }, pct: { day: 0.1, week: 6, month: 6 }, lim: L });
                out.brkLineOk = app._acctBreakerHtml({ state: 'ok', sum: { day: 0, week: 0, month: 0 }, pct: { day: 0, week: 0, month: 0 }, lim: L });
                out.brkOld = `本週已實現虧損到帳戶 ${L.week}% → 這週先不開新倉,手上的照你的出場規則走`;
                // 第一句
                out.fact = app._moodFacts(app._moodState({ mk: { pct: -3.3, d: '2026-11-18' }, ev: { k: 'fast15', d: '2026-11-18' } }), '2026-11-18');
                out.factOld = app._moodFacts(app._moodState({ ev: { k: 'leg10', d: '2026-11-17' } }), '2026-11-18');
            } finally {
                app._getInventory = keep.inv; app._deckQuoteOf = keep.q; app._leaderMine = keep.lm; app._dipMine = keep.dm; app._isLead = keep.lead; app.settings.deckShow = keep.ds;
            }
            return out;
        });
        ok('④ 都沒碰到 → 「都還沒碰到出場線…今天不用動」+ 寫照哪一天收盤算(ETF 不算進檔數)', /你手上 2 檔個股都還沒碰到出場線,這幾檔今天不用動/.test(C.allOk) && /收盤算/.test(C.allOk), C.allOk);
        ok('④ 有一檔算不出來 → ⛔ 說「都還沒碰到」、⛔ 說「不用動」,要講算不出來', !/都還沒碰到|不用動/.test(C.skip) && /2 檔個股還沒碰到出場線/.test(C.skip) && /另外 1 檔算不出來/.test(C.skip), C.skip);
        ok('④ 有一檔現價在線下 → 講它 +「收盤還在線下才算數」,⛔ 說不用動', /現價在出場線下面,收盤還在線下才算數/.test(C.under) && /其他 1 檔還沒碰到/.test(C.under) && !/不用動/.test(C.under), C.under);
        ok('④ 有一檔今天可能碰到 → 要講,⛔ 說「今天不用動」', /今天可能碰到/.test(C.near) && !/不用動/.test(C.near), C.near);
        ok('④ 今天要賣的 → 照決策台那一份講檔數', /今天要賣的有 1 檔/.test(C.sell) && /其他 1 檔還沒碰到/.test(C.sell), C.sell);
        ok('④ 沒有股票 / 只有 ETF → 各講各的', /沒有股票/.test(C.none) && /只有 ETF/.test(C.etfOnly), JSON.stringify([C.none, C.etfOnly]));
        ok('④ 跌停那一檔先講它自己的線(出場線在幾元、還差幾 %)', /的出場線在 490\.00.吊燈 ATR 2 倍.,還差 \d/.test(C.ld) && /^\S+的出場線/.test(C.ld) && /其他 1 檔還沒碰到/.test(C.ld), C.ld);
        ok('⑤ 大漲:名單有 → 照名單講檔數 + 尾盤到價才買', /今天名單上有 2 檔/.test(C.upList) && /尾盤漲過觸發價才買/.test(C.upList), C.upList);
        ok('⑤ 大漲:名單沒有 → 「照規則就是不買」', /照規則就是不買/.test(C.upNone), C.upNone);
        ok('⑤ 大漲:空頭不開新倉 / 名單沒讀到 / 那塊收起來 各講各的', /空頭不開新倉/.test(C.upBear) && /還沒讀到/.test(C.upNull) && /照決策台/.test(C.upOff), JSON.stringify([C.upBear, C.upNull, C.upOff]));
        ok('⑤ 選 👑:講換倉日那一套(⛔ 叫你看 🔥 名單)', /👑/.test(C.upLead) && !/名單上有/.test(C.upLead), C.upLead);
        ok('⑥ 熔斷:第二句 = 🧯 那一行同一句(_brkMsg)', C.brk === C.brkWant && C.brk.length > 3, JSON.stringify([C.brk, C.brkWant]));
        ok('⑥ 🧯 那一行輸出跟改之前一字不差(本週 / 正常)', C.brkLine.includes(C.brkOld) && /帳戶熔斷:正常/.test(C.brkLineOk), C.brkLine.slice(0, 200));
        ok('①b 第一句:大盤跟大跌事件同一天 → 一句講完(⛔ 重複「今天加權」)', C.fact.length === 2 && /^今天加權跌 3\.3%$/.test(C.fact[0]) && /^最近 25 天跌了 15% 以上$/.test(C.fact[1]), JSON.stringify(C.fact));
        ok('①b 第一句:前一天的事件要寫日期 +「收盤加權」', C.factOld.length === 1 && /^\d{2}\/\d{2}.*收盤加權離一年最高點跌到一成了/.test(C.factOld[0]), JSON.stringify(C.factOld));

        // ── ⑦⑧ 讀資料 ──
        const D = await pg.evaluate(async () => {
            const keep = { tpe: app._tpeMinutes, tw: app._twiiToday, rows: app._getTwiiRows, dip: app._loadDipData, dd: app._dipData, inv: app._getInventory, q: app._deckQuoteOf, brk: app._acctBreaker };
            const out = {};
            const day = ymd => { app._tpeMinutes = () => ({ wd: 'Wed', min: 600, ymd }); };
            const rowsWith = (lastIso, pct) => { const r = []; let c = 100; const e = new Date(lastIso + 'T00:00:00Z'); for (let k = 9; k >= 0; k--) { const d = new Date(e); d.setUTCDate(d.getUTCDate() - k); r.push({ date: d.toISOString().slice(0, 10).replace(/-/g, '/'), close: c }); } r[r.length - 1].close = +(100 * (1 + pct / 100)).toFixed(3); return r; };
            const G = async () => (await app._moodGather({ sell: [] }, { near: [], far: [] })).I;
            try {
                localStorage.removeItem('moodSeen_v1');
                app._loadDipData = async function () { return this._dipData; };
                app._dipData = { pick: null, ev: null };
                app._getInventory = () => []; app._deckQuoteOf = () => null;
                app._acctBreaker = () => ({ state: 'ok', sum: { day: 0, week: 0, month: 0 } });
                day('2026-11-18');
                // 大盤:今天的優先
                app._twiiToday = () => ({ pct: -3.4 }); app._getTwiiRows = async () => rowsWith('2026-11-17', -5);
                out.mkToday = (await G()).mk;
                // 沒有今天的 → 最後一根收盤(帶日期);太舊不講
                app._twiiToday = () => null; app._getTwiiRows = async () => rowsWith('2026-11-16', -3.1);
                out.mkLast = (await G()).mk;
                app._getTwiiRows = async () => rowsWith('2026-11-10', -3.1);
                out.mkStale = (await G()).mk;
                app._getTwiiRows = async () => { throw new Error('x'); };
                out.mkErr = (await G()).mk;
                // 大跌事件
                const evs = (through, list) => ({ pick: null, ev: { through, legs: [{ s: '2026-10-01', ev: list }] } });
                app._dipData = evs('2026-11-18', [{ k: 'leg10', d: '2026-11-10' }, { k: 'fast15', d: '2026-11-18' }]);
                out.evNew = (await G()).ev;
                app._dipData = evs('2026-11-18', [{ k: 'leg10', d: '2026-11-18' }, { k: 'bear20', d: '2026-11-18' }]);
                out.evRank = (await G()).ev;
                app._dipData = evs('2026-11-18', [{ k: 'leg10', d: '2026-11-10' }]);
                out.evOld = (await G()).ev;
                app._dipData = evs('2026-11-18', [{ k: 'end', d: '2026-11-18' }]);
                out.evEnd = (await G()).ev;
                app._dipData = evs('2026-11-10', [{ k: 'bear20', d: '2026-11-10' }]);
                out.evStale = (await G()).ev;
                app._dipData = { pick: null, ev: null };
                // 漲停 / 跌停(只看今天的價;ETF 不算)
                app._getInventory = () => [{ symbol: '2330', cost: 500, shares: 1 }, { symbol: '2317', cost: 100, shares: 1 }, { symbol: '0050', cost: 150, shares: 1 }, { symbol: '2454', cost: 1000, shares: 1 }];
                app._deckQuoteOf = s => ({ '2330': { p: 451, chg: -9.8 }, '2317': { p: 110, chg: 9.9 }, '0050': { p: 135, chg: -9.9 }, '2454': { p: 1005, chg: 0.5 } })[s] || null;
                const I1 = await G(); out.ld = I1.ld; out.lu = I1.lu;
                app._deckQuoteOf = () => null;
                const I2 = await G(); out.ldNoQ = I2.ld; out.luNoQ = I2.lu;
                // ⑦ 帳面賺兩成:同一筆只在第一次看到那天講
                localStorage.removeItem('moodSeen_v1');
                app._getInventory = () => [{ symbol: '2454', cost: 1000, shares: 1, buyDate: '2026/10/01' }];
                app._deckQuoteOf = () => ({ p: 1250, chg: 1 });
                day('2026-11-18'); out.g1 = (await G()).gain; out.g1b = (await G()).gain;
                day('2026-11-19'); out.g2 = (await G()).gain;
                app._deckQuoteOf = () => ({ p: 1100, chg: -1 }); day('2026-11-20'); out.g3 = (await G()).gain;
                app._deckQuoteOf = () => ({ p: 1300, chg: 1 }); day('2026-11-23'); out.g4 = (await G()).gain;
                app._deckQuoteOf = () => ({ p: 1150, chg: 1 }); out.gUnder = (await G()).gain;
                // 賣掉之後再買一筆(成本不同)→ 那一筆是新的,第一次看到那天照講
                app._getInventory = () => [{ symbol: '2454', cost: 900, shares: 1, buyDate: '2026/11/20' }];
                app._deckQuoteOf = () => ({ p: 1300, chg: 1 }); out.gNew = (await G()).gain;
                // ⑧ 熔斷:同一週只在剛亮那天 / 今天又賠一筆才講
                localStorage.removeItem('moodSeen_v1');
                app._getInventory = () => []; app._deckQuoteOf = () => null;
                app._acctBreaker = () => ({ state: 'week', sum: { day: 0, week: -6000, month: -6000 } });
                day('2026-11-17'); out.b1 = (await G()).brk; out.b1b = (await G()).brk;
                day('2026-11-18'); out.b2 = (await G()).brk;
                app._acctBreaker = () => ({ state: 'week', sum: { day: -500, week: -6500, month: -6500 } });
                out.b3 = (await G()).brk;
                app._acctBreaker = () => ({ state: 'week', sum: { day: 0, week: -6000, month: -6000 } });
                day('2026-11-24'); out.b4 = (await G()).brk;
                app._acctBreaker = () => ({ state: 'stale', sum: { day: -9000, week: -9000, month: -9000 } });
                day('2026-11-25'); out.bStale = (await G()).brk;
            } finally {
                Object.assign(app, { _tpeMinutes: keep.tpe, _twiiToday: keep.tw, _getTwiiRows: keep.rows, _loadDipData: keep.dip, _dipData: keep.dd, _getInventory: keep.inv, _deckQuoteOf: keep.q, _acctBreaker: keep.brk });
                localStorage.removeItem('moodSeen_v1');
            }
            return out;
        });
        ok('⑧ 大盤:今天的優先(日期 = 今天)', D.mkToday && D.mkToday.pct === -3.4 && D.mkToday.d === '2026-11-18', JSON.stringify(D.mkToday));
        ok('⑧ 大盤:沒有今天的 → 最後一根收盤 + 那一天的日期', D.mkLast && Math.abs(D.mkLast.pct + 3.1) < 0.01 && D.mkLast.d === '2026-11-16', JSON.stringify(D.mkLast));
        ok('⑧ 大盤:最後一根太舊(8 天前)/ 讀不到 → 不講', D.mkStale === null && D.mkErr === null, JSON.stringify([D.mkStale, D.mkErr]));
        ok('⑧ 大跌事件:只收最新那一天的;同一天兩件收大的;舊的 / 「結束」/ 資料太舊 ⛔ 收',
            D.evNew && D.evNew.k === 'fast15' && D.evRank && D.evRank.k === 'bear20' && D.evOld === null && D.evEnd === null && D.evStale === null,
            JSON.stringify([D.evNew, D.evRank, D.evOld, D.evEnd, D.evStale]));
        ok('⑧ 漲停 / 跌停只看今天的價、ETF 不算', JSON.stringify(D.ld) === '["2330"]' && JSON.stringify(D.lu) === '["2317"]' && !D.ldNoQ.length && !D.luNoQ.length, JSON.stringify([D.ld, D.lu, D.ldNoQ, D.luNoQ]));
        ok('⑦ 帳面賺兩成:第一次看到那天講(同一天再看也講)', JSON.stringify(D.g1) === '["2454"]' && JSON.stringify(D.g1b) === '["2454"]', JSON.stringify([D.g1, D.g1b]));
        ok('⑦ 帳面賺兩成:隔天 / 掉下來又漲回去 / 沒到兩成 → ⛔ 再講', !D.g2.length && !D.g3.length && !D.g4.length && !D.gUnder.length, JSON.stringify([D.g2, D.g3, D.g4, D.gUnder]));
        ok('⑦ 賣掉之後重新買的那一筆 → 第一次看到那天照講', JSON.stringify(D.gNew) === '["2454"]', JSON.stringify(D.gNew));
        ok('⑧ 熔斷:剛亮那天講(同一天再看也講)', D.b1 === 'week' && D.b1b === 'week', JSON.stringify([D.b1, D.b1b]));
        ok('⑧ 熔斷:同一週隔天沒再賠 → ⛔ 講;今天又賠一筆 → 講;下一週又亮 → 講', D.b2 === null && D.b3 === 'week' && D.b4 === 'week', JSON.stringify([D.b2, D.b3, D.b4]));
        ok('⑧ 帳戶總資金過期(stale)→ ⛔ 拿它講熔斷', D.bStale === null, JSON.stringify(D.bStale));

        // ── ⑨ 句子表 ──
        const COPY = await pg.evaluate(() => {
            const out = [];
            const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v, p + k + '.'); else out.push([p + k, String(v)]); } };
            walk(app._MOOD_COPY, '');
            return out;
        });
        const badR = COPY.filter(([, s]) => badOf(s).length);
        ok('⑨ 句子表逐句 ⛔ 研究字樣(lib_retailbad)', COPY.length >= 30 && !badR.length, JSON.stringify(badR).slice(0, 300));
        const dirR = COPY.filter(([, s]) => BAN.test(s.replace(/大跌撿便宜/g, '')));   // 「📉 大跌撿便宜」是那一塊的名字(⛔ 指令)
        ok('⑨ 句子表逐句 ⛔ 指令字', !dirR.length, JSON.stringify(dirR).slice(0, 300));
        const rg = COPY.filter(([, s]) => /🔴|🟢/.test(s));
        ok('⑨ 句子表 ⛔ 🔴🟢', !rg.length, JSON.stringify(rg));
        const crownK = COPY.filter(([, s]) => /👑|領頭羊|換倉/.test(s)).map(([k]) => k).sort();
        ok('⑨ 👑 / 換倉 只出現在選 👑 才會用到的那三句', JSON.stringify(crownK) === JSON.stringify(['plan.buyLead', 'plan.lead', 'plan.lineLead']), JSON.stringify(crownK));

        // ── ⑩ 決策台真的畫 ──
        const render = async (p, pct, opt) => p.evaluate(async ([pct, opt]) => {
            app._twiiToday = () => (pct == null ? null : { pct });
            app._getTwiiRows = async () => [];
            app._loadDipData = async function () { this._dipData = { pick: null, ev: null }; this._dipDataAt = Date.now(); return this._dipData; };
            app._getInventory = () => (opt && opt.inv) || [];
            if (opt && opt.q) app._deckQuoteOf = s => opt.q[s] || null;
            if (opt && opt.off) app.settings.deckShow = Object.assign({}, app.settings.deckShow || {}, { mood: false });
            app._invExitAt = 0;
            for (let i = 0; i < 50 && app._deckBusy; i++) await new Promise(r => setTimeout(r, 100));
            const box = document.getElementById('deckMood');
            if (box) box.innerHTML = '';
            await app.renderDeck();
            for (let i = 0; i < 40; i++) { if (box && box.querySelector('[data-deckmood]')) break; await new Promise(r => setTimeout(r, 100)); }
            await new Promise(r => setTimeout(r, 300));
            const head = document.getElementById('deckHead');
            return {
                html: box ? box.innerHTML : null, text: box ? box.innerText : '', disp: box ? box.style.display : null,
                after: head && head.nextElementSibling ? head.nextElementSibling.id : '',
                show: app._deckShow().mood,
                cls: box ? [...box.querySelectorAll('[class]')].map(e => e.className).join(' ') : '',
            };
        }, [pct, opt || null]);
        const E1 = await render(pg, -3.3);
        ok('⑩ 解鎖 + 今天跌 3.3% → 決策台頂端那格下面出現(💭 + 兩句)', /data-deckmood="dn3"/.test(E1.html || '') && /今天加權跌 3\.3%/.test(E1.text) && /data-moodplan/.test(E1.html) && E1.after === 'deckMood' && E1.disp !== 'none', JSON.stringify(E1).slice(0, 400));
        ok('⑨ 整塊 ⛔ 紅綠樣式(好壞不用紅綠講)', !/(text|border|bg)-(red|green|emerald|rose)-/.test(E1.cls), E1.cls.slice(0, 300));
        const E2 = await render(pg, -1.9);
        ok('⑩ ⭐ 決定性對照:同一頁今天只跌 1.9% → 一個字都沒有', E2.html === '' && E2.text === '', JSON.stringify(E2).slice(0, 300));
        const E3 = await render(pg, 2.6);
        ok('⑩ 大漲那天 → 有,講名單那一句;沒選 👑 ⛔ 出現 👑 / 領頭羊 / 換倉', /data-deckmood="up2"/.test(E3.html || '') && !/👑|領頭羊|換倉/.test(E3.text), E3.text);
        const E4 = await render(pg, -0.5, { inv: [{ symbol: '2330', cost: 500, shares: 1 }], q: { '2330': { p: 451, chg: -9.8 } } });
        ok('⑩ 手上的股票今天跌停 → 有(講那一檔);沒選 👑 ⛔ 出現 👑', /data-deckmood="ld"/.test(E4.html || '') && /今天跌停/.test(E4.text) && !/👑|領頭羊|換倉/.test(E4.text), E4.text);
        const allTxt = [E1.text, E3.text, E4.text].join('\n');
        const badT = allTxt.split('\n').filter(s => badOf(s).length);
        ok('⑨ 畫出來的字 ⛔ 研究字樣', !badT.length, JSON.stringify(badT));
        const E5 = await render(pg, -3.3, { off: true });
        ok('⑩ 設定裡關掉 → 空而且藏起來', E5.html === '' && E5.disp === 'none' && E5.show === false, JSON.stringify(E5).slice(0, 200));
        const SET = await pg.evaluate(() => { app.settings.deckShow = Object.assign({}, app.settings.deckShow || {}, { mood: true }); app._renderStratBox(); app._renderDeckShowList(); const sb = document.getElementById('stratBox'), dl = document.getElementById('deckShowList'); return { adv: !!(sb && sb.querySelector('[data-advk="mood"]')), list: !!(dl && dl.querySelector('[data-deckshowk="mood"]')) }; });
        ok('⑩ 設定「🔓 進階功能」列得出來、一般勾選清單 ⛔ 出現', SET.adv && !SET.list, JSON.stringify(SET));

        // 沒解鎖
        const pl = await open(false, 'gene');
        const L1 = await render(pl, -3.3, { inv: [{ symbol: '2330', cost: 500, shares: 1 }], q: { '2330': { p: 451, chg: -9.8 } } });
        ok('⑩ 沒解鎖:大跌 + 持股跌停也一個字都沒有,而且藏起來', L1.html === '' && L1.disp === 'none' && L1.show === false, JSON.stringify(L1).slice(0, 200));
        const SL = await pl.evaluate(() => { app._renderStratBox(); app._renderDeckShowList(); return { adv: !!document.querySelector('[data-advk="mood"]'), list: !!document.querySelector('[data-deckshowk="mood"]') }; });
        ok('⑩ 沒解鎖:設定裡 ⛔ 看得到這個開關', !SL.adv && !SL.list, JSON.stringify(SL));

        // 選 👑:大漲那天講換倉那一套
        const pd = await open(true, 'lead');
        const LD = await render(pd, 2.6);
        ok('⑩ 選 👑:大漲那天講換倉日那一套', /data-deckmood="up2"/.test(LD.html || '') && /👑/.test(LD.text), LD.text);

        ok('⑩ 整段沒有 pageerror', !errs.length, errs.slice(0, 3).join(' | '));
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
    console.log(bad ? `\n❌ MOOD_INJECT_FAIL(${bad} 種注入沒被抓到)` : `\n✅ MOOD_INJECT_PASS(${Object.keys(INJ).length} 種注入全紅)`);
    process.exit(bad ? 1 : 0);
}
const fails = await run(ORIG, 'main');
console.log(fails.length ? `\n❌ MOOD_FAIL(${fails.length} 條)` : '\n✅ MOOD_PASS');
process.exit(fails.length ? 1 : 0);
