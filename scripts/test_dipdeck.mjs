#!/usr/bin/env node
/**
 * 📉 V82.0.0 決策台「📉 大跌撿便宜」+ 大跌撿便宜 / 大跌事件提醒(index.html;資料 = data/dip_pick.json、data/crash_events.json)
 *  ① 只在有還沒賣的批次時出現;沒有 → 一個字都沒有(決定性對照)
 *  ② 明天要買那一批:下一個開盤日 09:00 + 10 檔 + 限價 +「⛔ 不換別檔」;算「今天要做的事」(⛔ 同時說今天不用做)
 *  ③ 過了 09:00 → 已過買點(⛔ 追);空頭守門開著 + 嚴格空頭 → 這一批不買
 *  ④ 標了「我有買這一批」→ `_dipMine` 只收庫存裡有、還沒過賣出日的;⛔ 套三條出場(`_invExitScan` 跳過)
 *  ⑤ 提醒:名單出來那則一批只跳一次、類別 = 📉 大跌撿便宜(關得掉);你有買的那一批賣出日那則 = 👜 你的部位(關不掉)
 *  ⑥ 大跌事件:最近兩個交易日的才跳、第一次用這一版更早的⛔ 塞進鈴鐺、每段每種一次;類別 = 📉 大跌事件
 *  ⑦ 交叉提醒⛔ 同一件事叫兩次(跌 3% / 跌 20% 那兩則讓給這兩類)
 *  ⑧ 畫面⛔ 研究字樣(lib_retailbad)、⛔ 成交額前 100(👑 的字眼)、390px 不橫捲
 *  注入:INJECT=nogate(拿掉「只在有批次時出現」)/ INJECT=passed(買點永遠沒過)/ INJECT=mine(標了也照套三條出場)→ 必紅
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'nogate') SRC = SRC.replace("if (!open.length && !skips.length) return '';", '');
if (INJ === 'passed') SRC = SRC.replace("_dipBuyPassed(b) { const T = this._tpeMinutes(); return T.ymd > b.b || (T.ymd === b.b && T.min >= 9 * 60); },", '_dipBuyPassed(b) { return false; },');
if (INJ === 'mine') SRC = SRC.replace('                if (_dm.has(sym)) continue;', '');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, `_t_dipdeck_${process.pid}.html`);
fs.writeFileSync(TMP, SRC);

const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) FAIL.push(n); };
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errs = [];
    page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._dipDeckHtml === 'function', null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const L10 = Array.from({ length: 10 }, (_, k) => ({ s: String(2301 + k), pc: 100 + k, r: -9.9 + k * 0.3, lim: 109.5 }));
    const R = await page.evaluate(async (L10) => {
        const A = app, o = {};
        A.saveSettings = () => {}; A.showToast = () => {}; A.vibrate = () => {};
        A.settings.strategy = 'park'; A.settings.bearGate = false; A.settings.accountSize = 1000000;
        delete A.settings.deckShow;
        let now = { ymd: '2026-11-05', min: 19 * 60, wd: 'Thu' };
        A._tpeMinutes = () => now;
        const fired = [], quiet = [];
        A._fireAlert = (t, b) => fired.push([t, b]);
        A._alertQuiet = (t, b) => quiet.push([t, b]);
        A._loadDipData = async () => A._dipData;
        A._mktBear60 = async () => ({ on: false });
        const pick = { v: 1, through: '2026-11-05', batches: [
            { t: '2026-10-15', ix: -3.41, b: '2026-10-16', s: '2026-12-14', sp: 1, st: 'hold', dh: 13, L: L10.map(x => ({ ...x, s: String(+x.s + 100), o: 99 })) },
            { t: '2026-11-05', ix: -3.2, b: '2026-11-06', s: '2026-12-31', sp: 1, st: 'wait', L: L10 },
            { t: '2026-07-17', ix: -6.47, b: '2026-07-20', s: '2026-09-11', st: 'skip', why: '手上已經有 3 批還沒賣(同時最多 3 批)' },
        ] };
        // ① 沒有批次 → 一個字都沒有(決定性對照)
        A._dipData = { pick: { batches: [{ t: '2026-01-02', st: 'sold', b: '2026-01-05', s: '2026-03-02', L: L10 }] } };
        o.none = A._dipDeckHtml({});
        // ② 明天要買那一批
        A._dipData = { pick };
        o.buyHtml = A._dipDeckHtml({}); o.act = A._dipAct;
        const div = document.createElement('div'); div.innerHTML = o.buyHtml; document.body.appendChild(div);
        o.buyTxt = div.innerText; o.buyState = [...div.querySelectorAll('[data-dipstate]')].map(e => e.dataset.dipstate);
        o.rows = div.querySelectorAll('[data-dipbatch="2026-11-05"] [data-dipsym]').length;
        o.skipN = div.querySelectorAll('[data-dipskip]').length;
        o.wide = Math.max(...[...div.querySelectorAll('*')].map(e => e.getBoundingClientRect().right)) - 390;
        div.remove();
        // ③ 過了 09:00
        now = { ymd: '2026-11-06', min: 9 * 60 + 5, wd: 'Fri' };
        div.innerHTML = A._dipDeckHtml({}); o.passedState = [...div.querySelectorAll('[data-dipstate]')].map(e => e.dataset.dipstate); o.actPassed = A._dipAct;
        now = { ymd: '2026-11-05', min: 19 * 60, wd: 'Thu' };
        div.innerHTML = A._dipDeckHtml({ bearGate: true }); o.bearState = [...div.querySelectorAll('[data-dipstate]')].map(e => e.dataset.dipstate); o.actBear = A._dipAct;
        // ④ 標了「我有買這一批」
        try { localStorage.removeItem('dipMine_v1'); } catch (_) {}
        A.inventory = [{ symbol: '2401', cost: 99, shares: 1 }, { symbol: '2330', cost: 1000, shares: 1 }];
        A._getInventory = () => A.inventory;
        o.mine0 = [...A._dipMine()];
        A.renderDeck = () => {};
        A.toggleDipMine('2026-10-15');
        o.mine1 = [...A._dipMine()];
        div.innerHTML = A._dipDeckHtml({}); o.mineState = [...div.querySelectorAll('[data-dipstate]')].map(e => e.dataset.dipstate);
        now = { ymd: '2026-12-15', min: 10 * 60, wd: 'Tue' };
        o.mineAfter = [...A._dipMine()];
        now = { ymd: '2026-11-05', min: 19 * 60, wd: 'Thu' };
        // _invExitScan 跳過標了的那一檔
        A._invExitAt = 0;
        A.idb = { get: async k => ({ data: Array.from({ length: 60 }, (_, i) => ({ date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100, volume: 1000 })) }) };
        A._exitDistance = (rows, sym) => ({ sym, broken: [{ name: '硬停損', v: 99, k: 'hard' }], nearest: null, level: 'broken', missing: [], lines: [{ k: 'hard', v: 99 }], maxd: null, pC: 98 });
        A._heldAttention = () => null;
        try { await A._invExitScan(); } catch (e) { o.scanErr = String(e); }
        const flagged = new Set([...(A._invExitFlags || []), ...(A._invExitNear || []), ...(A._invExitFar || [])].map(x => String(x && x.sym)));
        o.scan2401 = flagged.has('2401'); o.scan2330 = flagged.has('2330'); o.scanSkipList = JSON.stringify([...flagged]);
        // ⑤ 提醒
        try { localStorage.removeItem('dipAlert_v1'); } catch (_) {}
        A.settings.alertOff = {};
        fired.length = 0;
        o.sw1 = await A._dipAlertSweep(); o.sw2 = await A._dipAlertSweep();
        o.firedBuy = fired.map(x => x[0]);
        o.catBuy = fired[0] ? A._alertCatOf(fired[0][0]).k : null;
        now = { ymd: '2026-12-14', min: 9 * 60, wd: 'Mon' };
        fired.length = 0; await A._dipAlertSweep();
        o.firedSell = fired.map(x => x[0]); o.catSell = fired[0] ? A._alertCatOf(fired[0][0]) : null;
        o.catSellK = o.catSell && o.catSell.k; o.catSellLock = !!(o.catSell && o.catSell.lock);
        now = { ymd: '2026-11-05', min: 19 * 60, wd: 'Thu' };
        A.settings.bearGate = true; A._mktBear60 = async () => ({ on: true });
        try { localStorage.removeItem('dipAlert_v1'); } catch (_) {}
        fired.length = 0; await A._dipAlertSweep(); o.firedBear = fired.length;
        A.settings.bearGate = false; A._mktBear60 = async () => ({ on: false });
        A.settings.strategy = 'lead'; A.settings.stratUnlock = true;
        try { localStorage.removeItem('dipAlert_v1'); } catch (_) {}
        fired.length = 0; await A._dipAlertSweep(); o.firedLead = fired.length;
        A.settings.strategy = 'park'; A.settings.stratUnlock = false;
        // ⑥ 大跌事件
        const ev = { through: '2026-11-05', occ: { from: 2000, leg10: { n: 24, d20: 9, end20: 6 }, fast15: { from: 1990, n: 21, wk: 8, mo: 7, half: 5, re: 12, reN: 19, base: 57 }, bear20: { n: 9, more10: 5, end250: 5 }, end: { n: 23, again60: 6 } },
            legs: [{ s: '2026-07-17', peak: { d: '2026-06-22', c: 47742 }, ev: [{ k: 'leg10', d: '2026-07-17', c: 42679, dd: -10.6 }, { k: 'end', d: '2026-08-12', c: 45500, dd: -4.7 }] },
                   { s: '2026-11-03', peak: { d: '2026-10-06', c: 49822 }, ev: [{ k: 'leg10', d: '2026-11-03', c: 43307, dd: -13.1 }, { k: 'fast15', d: '2026-11-05', c: 41574, dd: -16.6 }] }] };
        A._dipData = { pick, ev };
        try { localStorage.removeItem('crashEvFired_v1'); } catch (_) {}
        fired.length = 0; quiet.length = 0;
        o.ce1 = await A._crashEvAlertSweep();
        o.ceFired = fired.map(x => x[0]); o.ceQuiet = quiet.length; o.ceBodies = fired.map(x => x[1]);
        o.ceCat = fired.map(x => A._alertCatOf(x[0]).k);
        fired.length = 0; o.ce2 = await A._crashEvAlertSweep();
        ev.legs[1].ev.push({ k: 'bear20', d: '2026-11-04', c: 39800, dd: -20.1 });
        ev.legs[0].ev.push({ k: 'bear20', d: '2026-07-20', c: 38000, dd: -20.4 });
        fired.length = 0; quiet.length = 0; o.ce3 = await A._crashEvAlertSweep(); o.ce3Quiet = quiet.length;
        // ⑦ 交叉提醒讓位
        A.settings.stratUnlock = true; A.settings.deckShow = { cross: true, dip: true };
        A._crossGroups = () => ({ mkt: [{ id: 'idx_drop3', why: '加權跌 3%' }, { id: 'crash20', why: '離高點 20%' }, { id: 'bull_on', why: 'x' }], stocks: [], mstk: [] });
        try { localStorage.removeItem('crossBell_v1'); } catch (_) {}
        fired.length = 0; A._crossBell({ hits: [] }, '2026-11-05'); o.crossTitle = fired.map(x => x[0]).join('|');
        A.settings.alertOff = { dip: true, crash: true };
        try { localStorage.removeItem('crossBell_v1'); } catch (_) {}
        fired.length = 0; A._crossBell({ hits: [] }, '2026-11-05'); o.crossTitleOff = fired.map(x => x[0]).join('|');
        A.settings.alertOff = {}; A.settings.stratUnlock = false; delete A.settings.deckShow;
        o.cats = A._ALERT_CATS.map(c => c.k);
        o.secDip = A._DECK_SECTIONS.find(c => c.k === 'dip');
        return o;
    }, L10);
    ok('① 沒有還沒賣的批次 → 一個字都沒有(決定性對照)', R.none === '', R.none.slice(0, 80));
    ok('② 明天要買那一批:下一個開盤日 09:00 開盤買 + 10 檔 + 限價', /11\/06.*09:00 開盤買這 10 檔/.test(R.buyTxt) && R.rows === 10 && /限價/.test(R.buyTxt), R.buyTxt.slice(0, 200));
    ok('② 金額:這一批 1 成 ≈ 10 萬、每檔約 1 萬', /10 萬/.test(R.buyTxt) && /10,000 元/.test(R.buyTxt), R.buyTxt);
    ok('② ⛔ 不換別檔、⛔ 盤中追', /⛔ 不換別檔/.test(R.buyTxt) && /⛔ 盤中追/.test(R.buyTxt));
    ok('② 算「今天要做的事」(_dipAct)', R.act === true);
    ok('② 最近一次「這次不買」只列近 7 天的(7/17 那次⛔ 列)', R.skipN === 0, R.skipN);
    ok('② 狀態:買那一批 = buy、沒標的 10/15 = hold', JSON.stringify(R.buyState) === JSON.stringify(['hold', 'buy']), JSON.stringify(R.buyState));
    ok('③ 過了 09:00 → 已過買點(⛔ 算今天要做的事)', R.passedState.includes('passed') && R.actPassed === false, JSON.stringify(R.passedState));
    ok('③ 空頭守門開著 + 嚴格空頭 → 這一批不買', R.bearState.includes('bear') && R.actBear === false, JSON.stringify(R.bearState));
    ok('④ 沒標之前 _dipMine 是空的', R.mine0.length === 0, JSON.stringify(R.mine0));
    ok('④ 標了 → 只收庫存裡有的那一檔(2401)', JSON.stringify(R.mine1) === '["2401"]', JSON.stringify(R.mine1));
    ok('④ 標了 → 那一批顯示「第 13/40 天」', R.mineState.includes('mine'), JSON.stringify(R.mineState));
    ok('④ 過了賣出日 → 不再算(回到一般規則)', R.mineAfter.length === 0, JSON.stringify(R.mineAfter));
    ok('④ 標了的那一檔⛔ 套三條出場(_invExitScan 跳過);沒標的照套(決定性對照)', !R.scan2401 && R.scan2330 && !R.scanErr, R.scanErr || R.scanSkipList);
    ok('⑤ 名單出來那則:一批只跳一次', R.sw1 === 1 && R.sw2 === 0 && /📉 大跌撿便宜｜11\/06.*09:00 開盤買 10 檔/.test(R.firedBuy[0] || ''), JSON.stringify(R.firedBuy));
    ok('⑤ 類別 = 📉 大跌撿便宜(關得掉)', R.catBuy === 'dip', R.catBuy);
    ok('⑤ 你有買的那一批賣出日 → 👜 你的部位(關不掉)', /抱滿 40 天/.test(R.firedSell[0] || '') && R.catSellK === 'pos' && R.catSellLock, JSON.stringify(R.firedSell) + R.catSellK);
    ok('⑤ 空頭守門開著 + 嚴格空頭 → 名單那則不跳', R.firedBear === 0, R.firedBear);
    ok('⑤ 選 👑 → 名單那則不跳(👑 沒有停 0050 的錢)', R.firedLead === 0, R.firedLead);
    ok('⑥ 大跌事件:最近兩個交易日的才跳(11/03 進修正段、11/05 25 天跌 15%)', R.ce1 === 2 && R.ceFired.length === 2 && R.ceFired.every(t => /^📉 大跌事件｜/.test(t)), JSON.stringify(R.ceFired));
    ok('⑥ 第一次用這一版:更早的⛔ 塞進鈴鐺', R.ceQuiet === 0, R.ceQuiet);
    ok('⑥ 每段每種只跳一次', R.ce2 === 0, R.ce2);
    ok('⑥ 類別 = 📉 大跌事件', R.ceCat.every(k => k === 'crash'), JSON.stringify(R.ceCat));
    ok('⑥ 內容:過去發生過的比例 +「⛔ 不是會漲或會跌」+ 照出場規則走', R.ceBodies.every(b => /⛔ 不是會漲或會跌/.test(b) && /手上的照你的出場規則走/.test(b) && /🎲/.test(b)), R.ceBodies.join(' || ').slice(0, 300));
    ok('⑥ 之後新的事件:新的跳、舊段的進鈴鐺', R.ce3 === 1 && R.ce3Quiet === 1, `${R.ce3} / ${R.ce3Quiet}`);
    ok('⑦ 交叉提醒:跌 3% / 跌 20% 讓給這兩類', !/加權跌 3%|離高點 20%/.test(R.crossTitle) && /x/.test(R.crossTitle), R.crossTitle);
    ok('⑦ 這兩類關掉 → 交叉提醒照叫(決定性對照)', /加權跌 3%/.test(R.crossTitleOff) && /離高點 20%/.test(R.crossTitleOff), R.crossTitleOff);
    ok('⑧ 類別排在 👑 換倉日後面', R.cats.indexOf('crash') === 1 && R.cats.indexOf('dip') === 2, JSON.stringify(R.cats));
    ok('⑧ 決策台登記:st gene、預設開、⛔ 解鎖區', R.secDip && R.secDip.st === 'gene' && R.secDip.def === true && !R.secDip.unlock);
    const bad = badOf(R.buyTxt + '\n' + R.ceBodies.join('\n') + '\n' + R.secDip.d);
    ok('⑧ ⛔ 研究字樣(lib_retailbad)', !bad.length, JSON.stringify(bad));
    ok('⑧ ⛔ 👑 的字眼(成交額前 100 / 換倉 / 領頭羊)', !/成交額前 ?100|換倉|領頭羊|👑/.test(R.buyTxt + R.secDip.d), '');
    ok('⑧ 390px 不橫捲', R.wide <= 2, R.wide);
    ok('⑧ 無 pageerror', !errs.length, errs.join(' | '));
} finally {
    await browser.close();
    try { fs.unlinkSync(TMP); } catch (_) {}
}
console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗` : '\n✅ test_dipdeck 全過');
process.exit(FAIL.length ? 1 : 0);
