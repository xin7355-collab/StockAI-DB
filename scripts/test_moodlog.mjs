#!/usr/bin/env node
/**
 * 💭 V82.5.3 「我現在的心情」+ 心情日誌 ・賣出面板那一句與「為什麼賣」・買之前看一眼多兩行(規劃第 3 期)
 *
 * ⛔ 釘死:
 *   ⓢ 靜態:心情 / 為什麼賣的鍵只能加不能改(順序釘住);心情日誌全檔只有一處寫入、⛔ `_lsJson` / 裸 JSON.parse 讀它
 *   ① 記一筆:同一天同一種只留一筆、換一種 / 換一天才多;超過上限刪最舊;不認得的心情 ⛔ 記;
 *      舊的讀不出來 → 救回前面幾筆 + 這一筆、原文另存;連原文都存不下 → 這次不記、原本那個鍵一個位元都不變
 *   ② 小抄:怕 → 實際狀況(大盤 / 帳面)+ 計畫(`_moodPlan`,出場線)+ 專欄 = col.trig 有 feel_fear 的那幾篇(篇數跟 `_COL_TRIG` 一致);
 *      怕錯過 → 今天名單;想賺回來 → 熔斷亮著講熔斷那一句、沒亮講名單;想落袋 → 賺最多那兩檔的出場線(都沒賺 → 照怕那一邊);
 *      不知道 → 沒有專欄;專欄那塊關著 → 寫「關著」、0 篇
 *   ③ 只給解鎖的人(⭐ 決定性對照:同一個動作沒解鎖 → 按鈕 / 小抄 / 日誌 一個都沒有)
 *   ④ 賣出面板:💭 開著才問「這次為什麼賣」、存進紀錄(不認得的 ⛔ 存);那一句:碰到出場條件 → 照計畫;
 *      賠錢 + 今天大盤跌 2% 以上 + 還沒碰到 → 一行事實(⭐ 決定性對照:同一份只跌 1.5% → 沒有);賺錢 + 還遠 → 比計畫早;
 *      現價已經在線下 / ETF → 沒有
 *   ⑤ 備份帶心情日誌、還原是合併(⭐ 決定性對照:沒有那一欄的舊備份 → 現有的一個位元都不變;還原兩次筆數不變)
 *   ⑥ 買之前看一眼:不在今天名單 → 一行(名單沒讀到 / 在名單上 / ETF / 沒解鎖 → 沒有);最近一個收盤鎖漲停 → 一行
 *   ⑦ 心情 / 為什麼賣的字 ⛔ 研究字樣、⛔ 指令字、⛔ 🔴🟢
 * 跑法:node scripts/test_moodlog.mjs ・INJECT=1 node scripts/test_moodlog.mjs(九種注入必紅)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const BAN = /(減碼|加碼|買進|賣出|現金比例|做多|做空|出脫|鎖利|停損|全面|強力|空手|承接|試單|追高|分批|逢低|撿便宜|抄底|追進|搶反彈|別賣|不要賣|該賣|該買|建議|保證|一定會|必漲|必跌|會漲|會跌|放空|現金為王|停利|快逃|出清)/;

const INJ = {
    // 讀不出來就當空的(會把以前的整本蓋掉)
    blank: ['const arr = rd.arr.filter(t => !(t && t.d === d && t.m === k));', 'const arr = (rd.bad ? [] : rd.arr).filter(t => !(t && t.d === d && t.m === k));'],
    // 同一天同一種不合併
    nodedupe: ['const arr = rd.arr.filter(t => !(t && t.d === d && t.m === k));', 'const arr = rd.arr.slice();'],
    // 沒有上限
    nocap: ["        while (arr.length > this._MOOD_LOG_MAX) arr.shift();\n        return this._moodLogWrite(arr)", '        return this._moodLogWrite(arr)'],
    // 備份不帶
    noexport: ['if (md.arr.length) data.moodLog = md.arr;', ''],
    // 還原改成覆蓋
    overwrite: ['const mg = this._moodLogMerge(rd.arr, add);', 'const mg = { arr: add.slice(), added: add.length };'],
    // 不用解鎖也有心情按鈕
    nogate: ["    _moodPickHtml(where) {\n        if (!this._deckShow().mood) return '';\n", '    _moodPickHtml(where) {\n'],
    // 還原:備份只有心情紀錄(沒有賣出紀錄)→ 整段跳過(V82.5.3 改之前的寫法)
    skipmood: ['        this._restoreTradeLog(data, out);\n', '        if (!(data && Array.isArray(data.tradeLog) && data.tradeLog.length)) return out;\n        this._restoreTradeLog(data, out);\n'],
    // 小抄裡每篇專欄上面又印一次「你點了…」
    nowho: ["attr: 'data-moodcol', noWho: 1 }", "attr: 'data-moodcol' }"],
    // 賣出那一句:不管今天大盤
    nodate: ['if (px < cost && tw != null && tw <= this._DAY_TH.dn2) return wrap(', 'if (px < cost) return wrap('],
};

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

async function run(html, tag) {
    const fails = [];
    const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 320)}`); if (!c) fails.push(n); };

    // ── ⓢ 靜態 ──
    const strip = html.replace(/\/\/[^\n]*/g, '');
    const keys = re => { const m = strip.match(re); return m ? [...m[1].matchAll(/\['([a-z]+)',/g)].map(x => x[1]).join(',') : ''; };
    ok('ⓢ1 心情的鍵(只能加不能改):fear,fomo,back,lock,avg,idk', keys(/_MOOD_LIST:\s*(\[[^\n]*\]),/) === 'fear,fomo,back,lock,avg,idk', keys(/_MOOD_LIST:\s*(\[[^\n]*\]),/));
    ok('ⓢ2 為什麼賣的鍵(只能加不能改):line,giveback,cant,cash,swap,other', keys(/_SELLWHY_LIST:\s*(\[[^\n]*\]),/) === 'line,giveback,cant,cash,swap,other', keys(/_SELLWHY_LIST:\s*(\[[^\n]*\]),/));
    ok('ⓢ3 心情日誌全檔只有一處寫入(_moodLogWrite)', (html.match(/setItem\(\s*'proTerminalMoodLog'/g) || []).length === 1);
    ok('ⓢ4 ⛔ 用 _lsJson / 裸 JSON.parse 讀心情日誌(讀壞了會整本刪掉 / 蓋掉)', !/_lsJson\(\s*'proTerminalMoodLog'/.test(strip) && !/JSON\.parse\(\s*localStorage\.getItem\(\s*'proTerminalMoodLog'/.test(strip));

    const TMP = path.join(ROOT, `.test_moodlog_${tag}.html`);
    fs.writeFileSync(TMP, html);
    const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const errs = [];
    const open = async (unlock) => {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
        page.on('pageerror', e => errs.push(String(e && e.message || e)));
        await page.addInitScript(u => { try { const o = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); o.stratUnlock = u; o.strategy = 'gene'; localStorage.setItem('proTerminalSettings', JSON.stringify(o)); } catch (_) {} }, unlock);
        await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._moodTap === 'function' && typeof app.exportData === 'function', null, { timeout: 60000 });
        await page.waitForTimeout(1500);
        return page;
    };
    try {
        const pg = await open(true);

        // ── ① 記一筆 ──
        const A1 = await pg.evaluate(() => {
            const K = 'proTerminalMoodLog', BK = K + '_bad', o = {};
            const keepT = app._tpeMinutes, keepMax = app._MOOD_LOG_MAX;
            const day = ymd => { app._tpeMinutes = () => ({ wd: 'Wed', min: 600, ymd }); };
            const L = () => { try { return JSON.parse(localStorage.getItem(K) || '[]'); } catch (_) { return null; } };
            try {
                for (const k of [K, BK, BK + '2']) localStorage.removeItem(k);
                day('2026-11-18');
                o.r1 = app._moodLogAdd('fear', { tw: -3.234, pl: -12345.6 }); o.a1 = L();
                o.r2 = app._moodLogAdd('fear', { tw: -3.5 }); o.a2 = L();
                o.r3 = app._moodLogAdd('fomo'); o.n3 = L().length;
                day('2026-11-19'); o.r4 = app._moodLogAdd('fear'); o.n4 = L().length;
                o.bad = app._moodLogAdd('zzz'); o.nBad = L().length;
                // 上限改 3 → 第 4 筆擠掉最舊
                app._MOOD_LOG_MAX = 3; const first = L()[0]; day('2026-11-20'); app._moodLogAdd('lock'); const a5 = L();
                o.cap = { n: a5.length, firstGone: !a5.some(t => t.t === first.t && t.d === first.d && t.m === first.m) };
                app._MOOD_LOG_MAX = keepMax;
                // 舊的讀不出來(寫到一半)
                const half = '[{"t":1,"d":"2026-11-01","m":"fear"},{"t":2,"d":"2026-11-02","m":"fo';
                localStorage.setItem(K, half); localStorage.removeItem(BK);
                day('2026-11-21'); o.rHalf = app._moodLogAdd('avg'); o.aHalf = L(); o.bkHalf = localStorage.getItem(BK);
                // 連原文都存不下 → 這次不記、原本那個鍵不變
                localStorage.setItem(K, half); localStorage.removeItem(BK);
                const realSet = localStorage.setItem;
                try { localStorage.setItem = function (k, v) { if (String(k).startsWith(BK)) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } return realSet.call(this, k, v); }; } catch (_) {}
                o.stubOk = (() => { try { localStorage.setItem(BK, 'x'); return false; } catch (_) { return true; } })();
                o.rFull = app._moodLogAdd('avg'); o.mainFull = localStorage.getItem(K) === half;
                try { localStorage.setItem = realSet; } catch (_) {}
            } finally { app._tpeMinutes = keepT; app._MOOD_LOG_MAX = keepMax; for (const k of [K, BK, BK + '2']) localStorage.removeItem(k); }
            return o;
        });
        ok('① 第一筆:記下日期 / 心情 / 當時大盤(兩位小數)/ 帳面(整數)', A1.r1.ok && A1.a1.length === 1 && A1.a1[0].d === '2026-11-18' && A1.a1[0].m === 'fear' && A1.a1[0].tw === -3.23 && A1.a1[0].pl === -12346, JSON.stringify(A1.a1));
        ok('① 同一天同一種再點 → 還是 1 筆(留新的那筆)', A1.a2.length === 1 && A1.a2[0].tw === -3.5, JSON.stringify(A1.a2));
        ok('① 換一種 → 2 筆;換一天 → 3 筆;不認得的 ⛔ 記', A1.n3 === 2 && A1.n4 === 3 && !A1.bad.ok && A1.nBad === 3, JSON.stringify([A1.n3, A1.n4, A1.bad, A1.nBad]));
        ok('① 上限改成 3 → 第 4 筆擠掉最舊那筆', A1.cap.n === 3 && A1.cap.firstGone, JSON.stringify(A1.cap));
        ok('① 舊的讀不出來 → 救回前面那筆 + 這一筆、原文另存', A1.rHalf.ok && A1.aHalf.length === 2 && A1.aHalf[0].d === '2026-11-01' && A1.aHalf[1].m === 'avg' && /fo$/.test(A1.bkHalf || ''), JSON.stringify([A1.aHalf, (A1.bkHalf || '').slice(-10)]));
        ok('① 連原文都存不下 → 這次不記、原本那個鍵一個位元都不變', A1.stubOk && !A1.rFull.ok && A1.rFull.why === 'full' && A1.mainFull, JSON.stringify([A1.stubOk, A1.rFull, A1.mainFull]));

        // ── ②③ 小抄 ──
        const A2 = await pg.evaluate(async () => {
            const K = 'proTerminalMoodLog', o = {};
            const keep = { tw: app._twiiToday, rows: app._getTwiiRows, dip: app._loadDipData, dd: app._dipData, inv: app._getInventory, q: app._deckQuoteOf, brk: app._acctBreaker, st: app._moodLastSt, x: app._moodLastX, ds: app.settings.deckShow };
            const modalTitle = () => (document.getElementById('updateLogTitle') || {}).textContent || '';
            const nCols = f => (((app._COL_TRIG || {}).cols) || []).filter(c => !c.lead && (c.trig || []).includes(f)).length;
            const box = h => { const d = document.createElement('div'); d.innerHTML = h || ''; return d; };
            const cards = [], tapK = async k => { const h = await app._moodTap(k); cards.push(h || ''); return h; };
            try {
                localStorage.removeItem(K); localStorage.removeItem('moodSeen_v1');
                app._loadDipData = async function () { this._dipData = { pick: null, ev: null }; return this._dipData; };
                app._getTwiiRows = async () => [];
                app._twiiToday = () => ({ pct: -3.3 });
                app._acctBreaker = () => ({ state: 'ok', sum: { day: 0, week: 0, month: 0 } });
                app._getInventory = () => [{ symbol: '2330', cost: 500, shares: 1 }, { symbol: '2317', cost: 100, shares: 2 }];
                app._deckQuoteOf = s => ({ '2330': { p: 520, chg: -2 }, '2317': { p: 110, chg: -3 } })[s] || null;
                const ed = (pC, lines, level) => ({ pC, asOf: '2026-11-18', level, lines: lines.map(([name, v]) => ({ name, v })) });
                app._moodLastSt = { sell: [], buy: [{ s: '2454' }, { s: '3231' }] };
                app._moodLastX = { near: [], far: [{ sym: '2330', ed: ed(520, [['硬停損', 475]], 'far') }, { sym: '2317', ed: ed(110, [['硬停損', 95]], 'far') }] };
                app.settings.deckShow = Object.assign({}, keep.ds || {}, { mood: true, col: true, pb: true });
                const fear = await tapK('fear'); const bF = box(fear);
                o.fearOnce = (bF.textContent.match(/你點了/g) || []).length;
                o.fear = { card: !!bF.querySelector('[data-moodcard="fear"]'), facts: bF.querySelector('[data-moodfacts]')?.innerText || '', plan: bF.querySelector('[data-moodplan]')?.innerText || '', cols: bF.querySelectorAll('[data-colhit]').length, want: nCols('feel_fear'), logged: bF.querySelector('[data-moodlog]')?.dataset.moodlog, title: modalTitle(), sc: [...bF.querySelectorAll('[data-colhit]')].map(e => e.dataset.colsc) };
                o.logN1 = JSON.parse(localStorage.getItem(K) || '[]').length;
                const fomo = await tapK('fomo'); const bO = box(fomo);
                o.fomo = { plan: bO.querySelector('[data-moodplan]')?.innerText || '', cols: bO.querySelectorAll('[data-colhit]').length, want: nCols('feel_fomo') };
                const back = await tapK('back'); o.backNoBrk = box(back).querySelector('[data-moodplan]')?.innerText || '';
                app._acctBreaker = () => ({ state: 'week', sum: { day: 0, week: -9000, month: -9000 } });
                localStorage.removeItem('moodSeen_v1');
                const back2 = await tapK('back'); const bB = box(back2);
                o.backBrk = { plan: bB.querySelector('[data-moodplan]')?.innerText || '', want: app._brkMsg('week').todo + '。', facts: bB.querySelector('[data-moodfacts]')?.innerText || '' };
                app._acctBreaker = () => ({ state: 'ok', sum: { day: 0, week: 0, month: 0 } });
                const lock = await tapK('lock'); o.lock = box(lock).querySelector('[data-moodplan]')?.innerText || '';
                app._deckQuoteOf = s => ({ '2330': { p: 480, chg: -2 }, '2317': { p: 99, chg: -3 } })[s] || null;
                const lock0 = await tapK('lock'); o.lockNone = box(lock0).querySelector('[data-moodplan]')?.innerText || '';
                const idk = await tapK('idk'); o.idkCol = !!box(idk).querySelector('[data-moodcol]');
                // 有一檔沒有現價 → 帳面合計只算有價的那幾檔,另外講一句(⛔ 檔數寫全部)
                app._getInventory = () => [{ symbol: '2330', cost: 500, shares: 1 }, { symbol: '2317', cost: 100, shares: 2 }, { symbol: '1101', cost: 40, shares: 1 }];
                app._deckQuoteOf = s => ({ '2330': { p: 480, chg: -2 }, '2317': { p: 99, chg: -3 } })[s] || null;
                o.plN = app._moodPLNow();
                o.plSkip = box(await tapK('idk')).querySelector('[data-moodfacts]')?.innerText || '';
                app._deckQuoteOf = () => null;
                o.plNone = box(await tapK('idk')).querySelector('[data-moodfacts]')?.innerText || '';
                app._getInventory = () => [{ symbol: '2330', cost: 500, shares: 1 }, { symbol: '2317', cost: 100, shares: 2 }];
                app._deckQuoteOf = s => ({ '2330': { p: 480, chg: -2 }, '2317': { p: 99, chg: -3 } })[s] || null;
                app.settings.deckShow = Object.assign({}, app.settings.deckShow, { col: false });
                const off = await tapK('avg'); const bOff = box(off);
                o.colOff = { off: bOff.querySelector('[data-moodcol]')?.dataset.moodcol, n: bOff.querySelectorAll('[data-colhit]').length };
                app.settings.deckShow = Object.assign({}, app.settings.deckShow, { col: true });
                o.avg = { cols: box(await tapK('avg')).querySelectorAll('[data-colhit]').length, want: nCols('feel_avg') };
                o.back3 = { cols: box(await tapK('back')).querySelectorAll('[data-colhit]').length, want: nCols('feel_back') };
                o.lock3 = { want: nCols('feel_lock') };
                o.logAll = JSON.parse(localStorage.getItem(K) || '[]').map(t => t.m).sort().join(',');
                // 入口
                o.btn = /data-moodbtn/.test(app._tradeMirrorBtnHtml());
                o.pick = box(app._moodPickHtml('x')).querySelectorAll('[data-moodk]').length;
                o.pickOpen = app._moodPickOpen() && !!document.querySelector('#updateLogBody [data-moodpickbox] [data-moodk="fear"]');
                // 決策台那一塊(情緒大的日子)下面有六顆
                const M = app._moodState({ mk: { pct: -3.3, d: '2026-11-18' } });
                o.deckPick = box(app._deckMoodHtml(M, { today: '2026-11-18', R: new Map() }, { sell: [] }, {})).querySelectorAll('[data-moodpick="deck"] [data-moodk]').length;
                // 小抄的字
                // 只掃小抄自己的字(專欄那一塊是專欄原文,另有守門)
                o.cardText = cards.map(h => { const d = box(h); d.querySelectorAll('[data-moodcol]').forEach(e => e.remove()); return d.textContent; }).join('\n');
                o.cardN = cards.filter(Boolean).length;
            } finally {
                Object.assign(app, { _twiiToday: keep.tw, _getTwiiRows: keep.rows, _loadDipData: keep.dip, _dipData: keep.dd, _getInventory: keep.inv, _deckQuoteOf: keep.q, _acctBreaker: keep.brk, _moodLastSt: keep.st, _moodLastX: keep.x });
                app.settings.deckShow = keep.ds; localStorage.removeItem('proTerminalMoodLog'); localStorage.removeItem('moodSeen_v1');
            }
            return o;
        });
        ok('② 怕:小抄開在同一個視窗、標題「我現在的心情」、記一筆', A2.fear.card && A2.fear.title === '💭 我現在的心情' && A2.fear.logged === '1' && A2.logN1 === 1, JSON.stringify(A2.fear).slice(0, 300));
        ok('② 怕:實際狀況有今天大盤 + 帳面合計(扣成本)', /今天加權跌 3\.3%/.test(A2.fear.facts) && /帳面合計 \+/.test(A2.fear.facts), A2.fear.facts);
        ok('② 怕:計畫 = 決策台那一句(手上 2 檔個股都還沒碰到出場線)', /你手上 2 檔個股都還沒碰到出場線/.test(A2.fear.plan), A2.fear.plan);
        ok('② 怕:專欄篇數 = col.trig 有 feel_fear 的那幾篇、全部標「你現在的心情」', A2.fear.want >= 3 && A2.fear.cols === A2.fear.want && A2.fear.sc.every(s => s === 'me'), JSON.stringify([A2.fear.cols, A2.fear.want, A2.fear.sc]));
        ok('② 小抄裡「你點了」只在最上面講一次(每篇專欄 ⛔ 再重複)', A2.fearOnce === 1, A2.fearOnce);
        ok('② 有一檔沒有現價 → 帳面合計寫 2 檔 + 另 1 檔沒算進去;全部沒有現價 → 帳面先不算', A2.plN.n === 2 && A2.plN.all === 3 && /手上 2 檔,扣掉手續費和稅,帳面合計 −/.test(A2.plSkip) && /另 1 檔還沒有現價,沒算進去/.test(A2.plSkip) && /帳面先不算/.test(A2.plNone), JSON.stringify([A2.plN, A2.plSkip, A2.plNone]));
        ok('② 怕錯過:計畫講今天名單;專欄篇數 = feel_fomo', /今天名單上有 2 檔/.test(A2.fomo.plan) && A2.fomo.want >= 3 && A2.fomo.cols === A2.fomo.want, JSON.stringify(A2.fomo));
        ok('② 想賺回來:熔斷沒亮 → 講名單;亮著 → 熔斷那一句(_brkMsg)+ 實際狀況寫熔斷', /今天名單上有 2 檔/.test(A2.backNoBrk) && A2.backBrk.plan === A2.backBrk.want && /本週已實現虧損/.test(A2.backBrk.facts), JSON.stringify([A2.backNoBrk, A2.backBrk]));
        ok('② 想落袋:講賺最多那兩檔的出場線;都沒賺 → 照怕那一邊', /的出場線在 475\.00/.test(A2.lock) && /的出場線在 95\.00/.test(A2.lock) && /還沒碰到出場線/.test(A2.lockNone), JSON.stringify([A2.lock, A2.lockNone]));
        ok('② 不知道 → 沒有專欄;專欄那塊關著 → 寫關著、0 篇', !A2.idkCol && A2.colOff.off === 'off' && A2.colOff.n === 0, JSON.stringify([A2.idkCol, A2.colOff]));
        ok('② 想攤平 / 想賺回來 / 想落袋 的專欄都有掛(各 ≥ 3 篇)', A2.avg.want >= 3 && A2.avg.cols === A2.avg.want && A2.back3.want >= 3 && A2.back3.cols === A2.back3.want && A2.lock3.want >= 3, JSON.stringify([A2.avg, A2.back3, A2.lock3]));
        ok('② 心情日誌:同一天每種一筆', A2.logAll === 'avg,back,fear,fomo,idk,lock', A2.logAll);
        ok('③ 解鎖:勝率鏡子旁有 💭、六顆心情、決策台那一塊下面也有六顆、按 💭 開得到', A2.btn && A2.pick === 6 && A2.deckPick === 6 && A2.pickOpen, JSON.stringify([A2.btn, A2.pick, A2.deckPick, A2.pickOpen]));
        const badC = A2.cardText.split('\n').filter(s => badOf(s).length);
        ok('⑦ 小抄畫出來的字 ⛔ 研究字樣(專欄原文以外)', A2.cardN >= 10 && !badC.length, JSON.stringify([A2.cardN, badC]).slice(0, 300));

        // ── ④ 賣出面板 ──
        const A4 = await pg.evaluate(async () => {
            const o = {}, keep = { flags: app._invExitFlags, dist: app._invExitDist, q: app._deckQuoteOf, tw: app._twiiTodayPct };
            try {
                app._invExitFlags = [];
                app._invExitDist = { '2330': { pC: 480, level: 'watch', lines: [{ name: '硬停損', v: 450 }] } };
                app._deckQuoteOf = () => ({ p: 470, chg: -3 });
                const L = (tw, item) => { app._twiiTodayPct = () => tw; const d = document.createElement('div'); d.innerHTML = app._invSellFeelLine(item || { symbol: '2330', cost: 500 }); return { k: d.firstElementChild?.dataset.sellfeel || '', t: d.innerText }; };
                o.panic = L(-2.5); o.calm = L(-1.5);
                app._invExitDist['2330'].level = 'far'; o.early = L(0.3, { symbol: '2330', cost: 400 });
                app._deckQuoteOf = () => ({ p: 440, chg: -3 }); o.under = L(-2.5);
                app._deckQuoteOf = () => ({ p: 470, chg: -3 });
                app._invExitFlags = [{ sym: '2330', rule: '吊燈 ATR 2 倍' }]; o.plan = L(-2.5);
                o.etf = L(-2.5, { symbol: '0050', cost: 200 });
                // 賣出:存「為什麼賣」
                app.inventory = [{ symbol: '2330', cost: 500, shares: 1, buyDate: '2026-10-01', currentPrice: 470 }];
                localStorage.setItem('proTerminalInv', JSON.stringify(app.inventory)); localStorage.removeItem('proTerminalTradeLog');
                app.openInventoryEditPage(); await new Promise(r => setTimeout(r, 60));
                app._invSellOpen(0); await new Promise(r => setTimeout(r, 60));
                o.selectHas = !!document.querySelector('[data-sellpanel="0"] [data-sellf="sellwhy"]');
                const sel = document.querySelector('[data-sellpanel="0"] [data-sellf="sellwhy"]'); if (sel) sel.value = 'cant';
                o.read = (app._invSellRead(0) || {}).sellWhy;
                o.commit = app._invSellCommit(0, { price: 470, shares: 500, date: '2026-11-18', sellWhy: 'cant' });
                o.log1 = (JSON.parse(localStorage.getItem('proTerminalTradeLog') || '[]')[0] || {}).sellWhy;
                o.commit2 = app._invSellCommit(0, { price: 470, shares: 500, date: '2026-11-18', sellWhy: 'zzz' });
                const lg = JSON.parse(localStorage.getItem('proTerminalTradeLog') || '[]');
                o.log2Has = lg.length === 2 && !('sellWhy' in lg[1]);
            } finally {
                app._invExitFlags = keep.flags; app._invExitDist = keep.dist; app._deckQuoteOf = keep.q; app._twiiTodayPct = keep.tw;
                localStorage.removeItem('proTerminalTradeLog');
                try { document.getElementById('inventoryEditPageModal').style.display = 'none'; } catch (_) {}
            }
            return o;
        });
        ok('④ 賠錢 + 今天大盤跌 2.5% + 還沒碰到 → 一行事實(跌幾 %、最近那條線、還差幾 %)', A4.panic.k === 'panic' && /今天加權跌 2\.5%/.test(A4.panic.t) && /硬停損 450\.00/.test(A4.panic.t) && /還差 4\.3%/.test(A4.panic.t), JSON.stringify(A4.panic));
        ok('④ ⭐ 決定性對照:同一份只跌 1.5% → 沒有那一句', A4.calm.k === '' && A4.calm.t === '', JSON.stringify(A4.calm));
        ok('④ 賺錢 + 離出場線還遠 →「比計畫早」', A4.early.k === 'early' && /比計畫早/.test(A4.early.t), JSON.stringify(A4.early));
        ok('④ 現價已經在線下 / ETF → 沒有那一句;碰到出場條件 →「照計畫」+ 規則名', A4.under.k === '' && A4.etf.k === '' && A4.plan.k === 'plan' && /照計畫/.test(A4.plan.t) && /吊燈 ATR 2 倍/.test(A4.plan.t), JSON.stringify([A4.under, A4.etf, A4.plan]));
        ok('④ 解鎖:賣出面板問「這次為什麼賣」、讀得到、存進紀錄;不認得的 ⛔ 存', A4.selectHas && A4.read === 'cant' && A4.commit === true && A4.log1 === 'cant' && A4.commit2 === true && A4.log2Has, JSON.stringify(A4));

        // ── ⑤ 備份 / 還原 ──
        const A5 = await pg.evaluate(async () => {
            const K = 'proTerminalMoodLog', o = {}, cap = {}, sleep = ms => new Promise(r => setTimeout(r, ms));
            const keep = { O: app._obfuscate, Dl: app._downloadBackupFile, Save: app.saveSettings, Pwd: app._getBackupPwd, Toast: app.showToast, De: app._deobfuscate, Conf: app.showConfirm, Ref: app.refreshInventoryPrices, Tabs: app.renderFavTabs, An: app.analyze };
            const rows = [{ t: 1, d: '2026-11-10', m: 'fear', tw: -3.1 }, { t: 2, d: '2026-11-11', m: 'fomo' }, { t: 3, d: '2026-11-12', m: 'lock', pl: 1200 }];
            try {
                app._obfuscate = s => { cap.last = s; return 'X'; }; app._downloadBackupFile = () => {}; app.saveSettings = () => {}; app._getBackupPwd = () => ''; app.showToast = t => { cap.toast = String(t); };
                try { Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true }); } catch (_) {}
                try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); } catch (_) {}
                localStorage.setItem(K, JSON.stringify(rows));
                await app.exportData('holdings'); await sleep(30); o.exp = JSON.parse(cap.last || '{}'); o.expToast = cap.toast;
                await app.exportData('keys'); await sleep(30); o.expKeys = JSON.parse(cap.last || '{}');
                const area = document.getElementById('exportArea');
                app._deobfuscate = s => s; app.showConfirm = (m, cb) => { cap.msg = m; cb(); }; app.refreshInventoryPrices = () => {}; app.renderFavTabs = () => {}; app.analyze = () => {};
                const imp = async data => { area.value = JSON.stringify(data); cap.msg = ''; cap.toast = ''; await app.confirmImportData(); await sleep(30); };
                // 手機上現有 1 筆 + 備份 3 筆(其中 1 筆同一天同一種)→ 合併
                localStorage.setItem(K, JSON.stringify([{ t: 9, d: '2026-11-10', m: 'fear' }, { t: 5, d: '2026-11-15', m: 'avg' }]));
                await imp({ inv: [], favGroups: { '自選清單': [] }, moodLog: rows, _meta: { scope: 'holdings' } });
                o.m1 = JSON.parse(localStorage.getItem(K) || '[]'); o.m1msg = cap.msg; o.m1toast = cap.toast;
                await imp({ inv: [], favGroups: { '自選清單': [] }, moodLog: rows, _meta: { scope: 'holdings' } });
                o.m2 = JSON.parse(localStorage.getItem(K) || '[]').length; o.m2toast = cap.toast;
                // ⭐ 決定性對照:沒有那一欄的舊備份 → 一個位元都不變
                const before = localStorage.getItem(K);
                await imp({ inv: [], favGroups: { '自選清單': [] }, _meta: { scope: 'holdings' } });
                o.old = localStorage.getItem(K) === before;
            } finally {
                Object.assign(app, { _obfuscate: keep.O, _downloadBackupFile: keep.Dl, saveSettings: keep.Save, _getBackupPwd: keep.Pwd, showToast: keep.Toast, _deobfuscate: keep.De, showConfirm: keep.Conf, refreshInventoryPrices: keep.Ref, renderFavTabs: keep.Tabs, analyze: keep.An });
                localStorage.removeItem(K);
            }
            return o;
        });
        ok('⑤ 持股自選備份帶 3 筆心情紀錄、完成那句有寫;只備份金鑰不帶', A5.exp.moodLog?.length === 3 && /3 筆心情紀錄/.test(A5.expToast || '') && !('moodLog' in A5.expKeys), JSON.stringify([A5.exp.moodLog?.length, A5.expToast, Object.keys(A5.expKeys)]));
        ok('⑤ 還原是合併:現有 2 筆 + 備份 3 筆(1 筆重複)= 4 筆,同一天同一種留新的(t:9)', A5.m1.length === 4 && A5.m1.find(t => t.d === '2026-11-10').t === 9 && A5.m1.some(t => t.m === 'avg'), JSON.stringify(A5.m1));
        ok('⑤ 確認視窗寫「合併、不會蓋掉」;完成那句寫併進幾筆;還原兩次筆數不變', /心情紀錄\(跟現有的合併,不會蓋掉\)/.test(A5.m1msg) && /心情紀錄除外/.test(A5.m1msg) && /心情日誌併進 2 筆/.test(A5.m1toast) && A5.m2 === 4 && /本來就都有了/.test(A5.m2toast), JSON.stringify([A5.m1msg, A5.m1toast, A5.m2, A5.m2toast]));
        ok('⑤ ⭐ 決定性對照:沒有心情那一欄的舊備份 → 現有的一個位元都不變', A5.old === true);

        // ── ⑥ 買之前看一眼 ──
        const A6 = await pg.evaluate(async () => {
            const o = {}, keep = { rk: app._deckRankOf, idb: app.idb.get };
            const T = h => { const d = document.createElement('div'); d.innerHTML = h || ''; return d.innerText.trim(); };
            try {
                app._deckRankOf = () => ({ rank: 0, n: 2 }); o.not = T(app._preTradeFeelHtml('2330'));
                app._deckRankOf = () => ({ rank: 1, n: 2 }); o.in = T(app._preTradeFeelHtml('2330'));
                app._deckRankOf = () => null; o.nul = T(app._preTradeFeelHtml('2330'));
                app._deckRankOf = () => ({ rank: 0, n: 2 }); o.etf = T(app._preTradeFeelHtml('0050'));
                // 最近一個收盤鎖漲停
                const mk = lock => { const r = []; let c = 100; for (let i = 0; i < 40; i++) { r.push({ date: `2026/09/${String(i % 28 + 1).padStart(2, '0')}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }); } const p = r[38].close; if (lock) Object.assign(r[39], { open: p, close: +(p * 1.1).toFixed(2), high: +(p * 1.1).toFixed(2), low: p }); r[39].date = '2026/11/17'; return r; };
                const host = document.createElement('div'); document.body.appendChild(host);
                host.innerHTML = app._preTradeFeelHtml('2330');
                app.idb.get = async () => ({ data: mk(true) }); o.lu = await app._preTradeLuFill('2330'); o.luDom = host.innerText;
                host.innerHTML = app._preTradeFeelHtml('2330');
                app.idb.get = async () => ({ data: mk(false) }); o.noLu = await app._preTradeLuFill('2330');
                host.remove();
            } finally { app._deckRankOf = keep.rk; app.idb.get = keep.idb; }
            return o;
        });
        ok('⑥ 不在今天名單 → 一行(寫那 N 檔);在名單上 / 名單沒讀到 / ETF → 沒有', /不在今天決策台「今天可以買的」那 2 檔裡/.test(A6.not) && A6.in === '' && A6.nul === '' && A6.etf === '', JSON.stringify(A6));
        ok('⑥ 最近一個收盤鎖漲停 → 補一行(帶日期);沒鎖 → 沒有', /收盤鎖漲停/.test(A6.lu || '') && /收盤鎖漲停/.test(A6.luDom || '') && !A6.noLu, JSON.stringify([A6.lu, A6.noLu]));

        // ── ⑦ 字 ──
        const W = await pg.evaluate(() => [...app._MOOD_LIST.map(x => x[1]), ...app._SELLWHY_LIST.map(x => x[1])]);
        ok('⑦ 心情 / 為什麼賣的字 ⛔ 研究字樣、⛔ 指令字、⛔ 🔴🟢', W.length === 12 && !W.some(s => badOf(s).length || BAN.test(s) || /🔴|🟢/.test(s)), JSON.stringify(W));

        // ── ③ ⭐ 決定性對照:沒解鎖 ──
        const pl = await open(false);
        const L3 = await pl.evaluate(async () => {
            const o = {};
            localStorage.removeItem('proTerminalMoodLog');
            o.tap = await app._moodTap('fear');
            o.log = localStorage.getItem('proTerminalMoodLog');
            o.pickOpen = app._moodPickOpen();
            o.btn = /data-moodbtn/.test(app._tradeMirrorBtnHtml());
            o.pick = app._moodPickHtml('x');
            o.feel = app._invSellFeelLine({ symbol: '2330', cost: 500 });
            o.pre = app._preTradeFeelHtml('2330');
            app.inventory = [{ symbol: '2330', cost: 500, shares: 1, buyDate: '2026-10-01', currentPrice: 470 }];
            localStorage.setItem('proTerminalInv', JSON.stringify(app.inventory));
            app.openInventoryEditPage(); await new Promise(r => setTimeout(r, 60));
            app._invSellOpen(0); await new Promise(r => setTimeout(r, 60));
            o.select = !!document.querySelector('[data-sellpanel="0"] [data-sellf="sellwhy"]');
            return o;
        });
        ok('③ ⭐ 決定性對照:沒解鎖 → 沒有心情按鈕 / 小抄 / 日誌 / 賣出那一句 / 為什麼賣 / 買之前那兩行', L3.tap === null && L3.log === null && L3.pickOpen === false && !L3.btn && L3.pick === '' && L3.feel === '' && L3.pre === '' && !L3.select, JSON.stringify(L3));

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
    console.log(bad ? `\n❌ MOODLOG_INJECT_FAIL(${bad} 種注入沒被抓到)` : `\n✅ MOODLOG_INJECT_PASS(${Object.keys(INJ).length} 種注入全紅)`);
    process.exit(bad ? 1 : 0);
}
const fails = await run(ORIG, 'main');
console.log(fails.length ? `\n❌ MOODLOG_FAIL(${fails.length} 條)` : '\n✅ MOODLOG_PASS');
process.exit(fails.length ? 1 : 0);
