#!/usr/bin/env node
/**
 * 🔓📰 V78.4.2 散戶 App「進階功能」統一收納 + 觸發式專欄 守門
 *   使用者:「我要新增到散戶 app,在設定裡跟按 5 下一樣設定開啟;爾後這種有價值的統一都放那裡,
 *            放進去也要排序或設計好,不要盲目一直新增功能」
 *   ① 沒解鎖:`_deckShow().col` 一定 false、設定沒有 🔓 進階功能區、一般勾選清單也⛔ 不出現 unlock 項、決策台那一區是空的
 *   ② 解鎖後:🔓 進階功能區出現,順序 == `_DECK_SECTIONS` 登記表順序(⛔ 不照新增時間);一般勾選清單仍⛔ 不出現
 *   ③ 觸發判斷(`_colTrigEval` 直接餵合成資料,每一條都有「成立 / 不成立」決定性對照):
 *      鎖漲停(庫存 / 自選分開)・ETF 不判 K 線・K 線日期追不上大盤 ⛔ 不判・帳面 +20%・除息 7 天內・
 *      大盤剛轉空頭(長期空頭⛔ 不算剛轉)・結算日・休市前最後一個交易日・休市後第一天・週末⛔ 不判日子
 *   ④ 分組排序:庫存 > 自選 > 大盤 > 日子;同一篇只列一次
 *   ⑤ 畫面⛔ 研究字樣(跟 test_retail_clean 同一份清單)、今天沒碰到整區不畫
 *   ⑥ 每個條件 id 在 `_colTrigEval` 裡都有判斷(⛔ 登記了卻沒人判 = 永遠不會跳)
 *   ⑧ V78.4.3 個股總覽那一格:同一個開關、正在看的那檔用「🔎 這一檔」、大盤/日子收摺疊、切股不殘留、決策台行為不變
 * 注入(逐一確認會紅):INJECT=nounlock / stale / noetf / noview / ovnogate
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nounlock') SRC = SRC.replace('(c.unlock && !unl)', '(false)');
if (INJ === 'stale') SRC = SRC.replace('iso(b[b.length - 1].date) < lastD) continue;', 'false) continue;');
if (INJ === 'noetf') SRC = SRC.replace('if (etf || !Array.isArray(b)', 'if (!Array.isArray(b)');
if (INJ === 'noview') SRC = SRC.replace('view: new Set([sym]), ', '');
if (INJ === 'ovnogate') SRC = SRC.replace("if (!sym || !this._deckShow().col || (this._isIndexSym", "if (!sym || (this._isIndexSym").replace("if (String(this.currentSymbolId) !== sym || !this._deckShow().col) return", "if (String(this.currentSymbolId) !== sym) return");   // ⚠️ 兩道都要拿掉(只拿一道,另一道會救活)
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_advunlock.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const open = async (unlock) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.on('pageerror', e => errs.push(e.message));
    await page.addInitScript(u => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.stratUnlock = u; s.strategy = 'gene'; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} }, unlock);
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._colTrigEval === 'function', null, { timeout: 60000 });
    return page;
};
const ui = page => page.evaluate(async () => {
    app._renderStratBox(); app._renderDeckShowList();
    const sb = document.getElementById('stratBox'), dl = document.getElementById('deckShowList');
    // 決策台那一區:直接用合成的「碰到」去畫,看沒解鎖時會不會被藏
    app._colTrigCache = { at: Date.now(), groups: app._colTrigGroups([{ id: 'settle', why: '今天是台指期結算日', sym: null }]) };
    await app._renderDeckCol();
    return {
        col: app._deckShow().col,
        adv: !!(sb && sb.querySelector('[data-advbox]')),
        advKeys: sb ? [...sb.querySelectorAll('[data-advk]')].map(e => e.dataset.advk) : [],
        regKeys: app._DECK_SECTIONS.filter(c => c.unlock && (!c.st || c.st === app._strat())).map(c => c.k),   // 📚 V79.2.6 綁策略的那項只在選那套時列
        listUnlock: dl ? [...dl.querySelectorAll('[data-deckshowk]')].map(e => e.dataset.deckshowk).filter(k => (app._DECK_SECTIONS.find(c => c.k === k) || {}).unlock) : ['no-list'],
        deckCol: (document.getElementById('deckCol') || {}).innerHTML || '',
    };
});

// ① 沒解鎖
{
    const p = await open(false);
    const r = await ui(p);
    ok('① 沒解鎖:進階功能全部關、設定看不到 🔓 區、決策台那一區是空的', r.col === false && !r.adv && !r.listUnlock.length && r.deckCol === '', JSON.stringify(r).slice(0, 300));
    // ⑧a 沒解鎖:個股總覽那一格也一定是空的(⛔ 合成一個一定會碰到的狀況也不可以出現)
    const ov = await p.evaluate(async () => {
        app._colTrigCache = { at: Date.now(), hits: [], groups: app._colTrigGroups([{ id: 'settle', why: 'x', sym: null }]), ctx: { tw: [], div: null } };
        app.currentSymbolId = '2454'; app.rawDailyData = [];
        await app._renderOvCol('2454');
        const b = document.getElementById('ovColBox'); return [b.innerHTML, b.classList.contains('hidden')];
    });
    ok('⑧a 沒解鎖:個股總覽「這一檔的專欄」是空的', ov[0] === '' && ov[1] === true, JSON.stringify(ov).slice(0, 200));
    await p.close();
}
// ② 解鎖
const page = await open(true);
{
    const r = await ui(page);
    ok('② 解鎖後:🔓 進階功能區出現、順序 == 登記表、一般勾選清單⛔ 不出現', r.col === true && r.adv && JSON.stringify(r.advKeys) === JSON.stringify(r.regKeys) && !r.listUnlock.length, JSON.stringify(r).slice(0, 300));
    ok('②b 解鎖後決策台那一區有畫出來(合成一個結算日)', /data-deckcol="1"/.test(r.deckCol) && /data-colhit="calendar-filter"/.test(r.deckCol), r.deckCol.slice(0, 200));
}
// ⑧ 個股總覽那一格(V78.4.3,使用者:「個股總覽把今天碰到的專欄也加進來,一樣要有設定才看的到」)
{
    const O = await page.evaluate(async () => {
        const iso = d => d.toISOString().slice(0, 10);
        const mkK = (n, endIso, f) => { const out = []; const e = new Date(endIso + 'T00:00:00Z'); let d = new Date(e); d.setUTCDate(d.getUTCDate() - n * 2); let c = 100; while (out.length < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w === 0 || w === 6) continue; out.push({ date: iso(d), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }); } out[out.length - 1].date = endIso; if (f) f(out); return out; };
        const lock = k => { const n = k.length, p = k[n - 2].close; Object.assign(k[n - 1], { open: p, close: +(p * 1.1).toFixed(2), high: +(p * 1.1).toFixed(2), low: p }); };
        const tw = mkK(120, '2026-10-16'), kLock = mkK(80, '2026-10-16', lock), kFlat = mkK(80, '2026-10-16');
        const box = document.getElementById('ovColBox');
        const settleG = app._colTrigGroups([{ id: 'settle', why: '今天是台指期結算日', sym: null }]);
        const setCache = () => { app._colTrigCache = { at: Date.now(), hits: [], groups: settleG, ctx: { tw, div: null } }; };
        const inv0 = app._getInventory;
        const o = {};
        // 正在看、沒在庫存、鎖漲停 → lu_fav 那篇,scope 🔎 這一檔;大盤/日子收進摺疊
        setCache(); app._getInventory = () => []; app.currentSymbolId = '2454'; app.rawDailyData = kLock;
        await app._renderOvCol('2454');
        o.view = { html: box.innerHTML, hidden: box.classList.contains('hidden') };
        // 同一檔放進庫存 → lu_held 那篇
        setCache(); app._getInventory = () => [{ symbol: '2454', shares: 1, cost: 0 }];
        await app._renderOvCol('2454');
        o.held = box.innerHTML;
        // 沒鎖漲停、也沒有大盤/日子 → 整格藏起來
        app._colTrigCache = { at: Date.now(), hits: [], groups: [], ctx: { tw, div: null } }; app._getInventory = () => []; app.rawDailyData = kFlat;
        await app._renderOvCol('2454');
        o.none = [box.innerHTML, box.classList.contains('hidden')];
        // 設定裡把 col 關掉 → 空
        setCache(); app.rawDailyData = kLock; app.settings.deckShow = Object.assign({}, app.settings.deckShow || {}, { col: false });
        await app._renderOvCol('2454');
        o.off = [box.innerHTML, box.classList.contains('hidden')];
        app.settings.deckShow.col = true;
        // 等資料時切到別檔 → ⛔ 不可把上一檔的寫上去
        box.innerHTML = ''; setCache();
        const pr = app._renderOvCol('2454'); app.currentSymbolId = '9999'; await pr;
        o.switched = box.innerHTML;
        app.currentSymbolId = '2454';
        // 決策台(不傳 view)行為不變:同一份 K 線放在「自選」仍是 lu_fav、scope = fav
        o.deck = app._colTrigEval({ tw, today: { tdy: '2026-10-19', wk: 1, weekday: true }, held: new Map(), bars: new Map([['2454', kLock]]), fav: ['2454'], div: null, events: [], floor: null }).map(h => h.id + ':' + h.sc);
        app._getInventory = inv0;
        return o;
    });
    ok('⑧b 解鎖 + 正在看的那檔鎖漲停 → 「🔎 這一檔」+ lu-nextday 那篇', /data-ovcol=/.test(O.view.html) && /data-colhit="lu-nextday"[^>]*data-colsc="view"/.test(O.view.html) && /這一檔/.test(O.view.html) && !O.view.hidden, O.view.html.slice(0, 300));
    ok('⑧c 大盤 / 日子收進摺疊(⛔ 不佔第一眼)', /data-colfold="1"/.test(O.view.html) && /calendar-filter/.test(O.view.html.split('data-colfold')[1] || ''), O.view.html.slice(-300));
    ok('⑧d 同一檔在庫存 → limitup-hold(👜 你的庫存)', /data-colhit="limitup-hold"[^>]*data-colsc="held"/.test(O.held) && !/lu-nextday/.test(O.held), O.held.slice(0, 300));
    ok('⑧e 什麼都沒碰到 → 整格藏起來', O.none[0] === '' && O.none[1] === true, JSON.stringify(O.none).slice(0, 200));
    ok('⑧f 設定裡把專欄關掉 → 總覽那格也空', O.off[0] === '' && O.off[1] === true, JSON.stringify(O.off).slice(0, 200));
    ok('⑧g 等資料時切到別檔 → ⛔ 不寫上一檔的', O.switched === '', O.switched.slice(0, 200));
    ok('⑧h 決策台(不傳 view)行為不變:自選鎖漲停仍是 lu_fav / fav', JSON.stringify(O.deck) === JSON.stringify(['lu_fav:fav']), JSON.stringify(O.deck));
}
// ③ 觸發判斷
const T = await page.evaluate(() => {
    const iso = d => d.toISOString().slice(0, 10);
    const mkK = (n, endIso, f) => { const out = []; const e = new Date(endIso + 'T00:00:00Z'); let d = new Date(e); d.setUTCDate(d.getUTCDate() - n * 2); let c = 100; while (out.length < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w === 0 || w === 6) continue; out.push({ date: iso(d), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }); } out[out.length - 1].date = endIso; if (f) f(out); return out; };
    const lock = k => { const n = k.length, p = k[n - 2].close; Object.assign(k[n - 1], { open: p, close: +(p * 1.1).toFixed(2), high: +(p * 1.1).toFixed(2), low: p }); };
    const tw = mkK(120, '2026-10-16');
    const today = { tdy: '2026-10-19', wk: 1, weekday: true };   // 一般週一(⛔ 不是結算日 / 不是營收日)
    const run = (o) => app._colTrigEval(Object.assign({ tw, today, held: new Map(), bars: new Map(), fav: [], div: null, events: [], floor: null }, o));
    const ids = h => h.map(x => x.id + (x.sym ? ':' + x.sym : '')).sort();
    const R = {};
    const kLock = mkK(80, '2026-10-16', lock), kFlat = mkK(80, '2026-10-16'), kOld = mkK(80, '2026-10-09', lock);
    R.luHeld = ids(run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', kLock]]) }));
    R.luHeldNo = ids(run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', kFlat]]) }));
    R.luFav = ids(run({ bars: new Map([['2454', kLock]]), fav: ['2454'] }));
    // 🟥🔓 V79.2.2 盤中碰到漲停、收盤沒鎖 → lu_touch(收盤後才判;盤中 ⛔ 不判)
    const touch = k => { const n = k.length, p = k[n - 2].close; Object.assign(k[n - 1], { open: p, high: app._floorTick(p * 1.1), close: +(p * 1.07).toFixed(2), low: p }); };
    const kTouch = mkK(80, '2026-10-16', touch), mo = app.isMarketOpen;
    app.isMarketOpen = () => false;
    R.luTouch = ids(run({ bars: new Map([['2454', kTouch]]), fav: ['2454'] }));
    R.luTouchLock = ids(run({ bars: new Map([['2454', kLock]]), fav: ['2454'] }));
    R.luTouchHeld = ids(run({ held: new Map([['2454', { cost: 0 }]]), bars: new Map([['2454', kTouch]]) }));
    R.luTouchHeldSc = run({ held: new Map([['2454', { cost: 0 }]]), bars: new Map([['2454', kTouch]]) }).filter(x => x.id === 'lu_touch').map(x => x.sc).join(',');
    app.isMarketOpen = () => true;
    R.luTouchLive = ids(run({ bars: new Map([['2454', kTouch]]), fav: ['2454'] }));
    // 📅 V79.2.3 收盤後今天那根日 K 還沒採礦 → 用富果報價補(_colTodayBar)
    {
        const ac = app._afterCloseNow, gt = app.getTodayStr, fc = app._fugleCache;
        const base = mkK(40, '2026-10-16'), q = { price: 349, open: 321, high: 350.5, low: 320, volume: 161420, date: '2026/10/19' };
        app.getTodayStr = () => '2026/10/19';
        const tb = (open, after, qq, rows) => { app.isMarketOpen = () => open; app._afterCloseNow = () => after; app._fugleCache = qq ? { '1303': { data: qq, ts: 0 } } : {}; const r = app._colTodayBar('1303', rows || base); return r.length - (rows || base).length + ':' + (r[r.length - 1].high); };
        R.tbOk = tb(false, true, q);
        R.tbOpen = tb(true, true, q);
        R.tbPre = tb(false, false, q);
        R.tbYday = tb(false, true, Object.assign({}, q, { date: '2026/10/16' }));
        R.tbVol0 = tb(false, true, Object.assign({}, q, { volume: 0 }));
        R.tbHas = tb(false, true, q, base.concat([{ date: '2026-10-19', open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
        R.tbNoQ = tb(false, true, null);
        app._afterCloseNow = ac; app.getTodayStr = gt; app._fugleCache = fc;
    }
    app.isMarketOpen = mo;
    R.etf = ids(run({ held: new Map([['0050', { cost: 0 }]]), bars: new Map([['0050', kLock]]) }));
    R.stale = ids(run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', kOld]]) }));
    R.gain = ids(run({ held: new Map([['2330', { cost: 80 }]]), bars: new Map([['2330', kFlat]]) }));
    R.gainNo = ids(run({ held: new Map([['2330', { cost: 90 }]]), bars: new Map([['2330', kFlat]]) }));
    R.div = ids(run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', kFlat]]), div: { d: { 2330: { up: [['2026-10-23', 1]] } } } }));
    R.divNo = ids(run({ held: new Map([['2330', { cost: 0 }]]), bars: new Map([['2330', kFlat]]), div: { d: { 2330: { up: [['2026-11-03', 1]] } } } }));
    // 大盤:先漲後急跌 → 剛轉空頭;一路跌 → 早就是空頭(⛔ 不算剛轉)
    const up = mkK(120, '2026-10-16'); up.forEach((r, i) => { const c = i < 110 ? 100 + i : 210 - (i - 109) * 12; Object.assign(r, { open: c, high: c, low: c, close: c }); });
    const dn = mkK(120, '2026-10-16'); dn.forEach((r, i) => { const c = 300 - i; Object.assign(r, { open: c, high: c, low: c, close: c }); });
    R.bearFlip = ids(run({ tw: up }));
    R.bearLong = ids(run({ tw: dn }));
    R.settle = ids(run({ today: { tdy: '2026-10-21', wk: 3, weekday: true } }));
    R.settleNo = ids(run({ today: { tdy: '2026-10-14', wk: 3, weekday: true } }));
    const ev = [{ date: '2026-10-23', event: '🏮 測試假日 (台股休市,連假前後流動性低)' }];
    R.pre = ids(run({ today: { tdy: '2026-10-22', wk: 4, weekday: true }, events: ev }));
    R.preNo = ids(run({ today: { tdy: '2026-10-20', wk: 2, weekday: true }, events: ev }));
    R.weekend = ids(run({ today: { tdy: '2026-10-21', wk: 6, weekday: false } }));
    // 🌅 V79.3.1 盤前分數 ≤20 → premkt_low;21 分 / 沒算過 / 週末 → 沒有
    R.pm = ids(run({ premkt: { sPct: 0 } }));
    R.pmNo = ids(run({ premkt: { sPct: 21 } }));
    R.pmNull = ids(run({ premkt: null }));
    R.pmWk = ids(run({ premkt: { sPct: 5 }, today: { tdy: '2026-10-24', wk: 6, weekday: false } }));
    // 📉 V79.3.2 加權最新收盤跌 ≥3% → idx_drop3;跌 2% → 沒有
    { const mk = r => { const t = mkK(120, '2026-10-16'); const n = t.length; Object.assign(t[n - 1], { close: +(t[n - 2].close * (1 + r)).toFixed(2) }); return t; };
      R.d3 = ids(run({ tw: mk(-0.035) })); R.d3No = ids(run({ tw: mk(-0.02) })); }
    // 🛑 V79.3.6 外資台指期「急遽加空」(_fiFutState danger)→ fifut_cut;「空單近期最重」(warn)/ 沒資料 → 沒有
    R.ff = ids(run({ fifut: { level: 'danger', chg5: -10481, net: -93675 } }));
    R.ffNo = ids(run({ fifut: { level: 'warn', chg5: -2000, net: -93675 } }));
    R.ffNull = ids(run({ fifut: null }));
    // 📰 V79.3.3 再接 6 篇專欄
    { const H = new Map([['2330', { cost: 0 }]]);
      const drop = mkK(80, '2026-10-16', k => { k[k.length - 1].close = 95; });
      const hi = mkK(80, '2026-10-16', k => { k[k.length - 1].close = 105; });
      R.ma5 = ids(run({ held: H, bars: new Map([['2330', drop]]) })); R.ma5No = ids(run({ held: H, bars: new Map([['2330', kFlat]]) })); R.ma5Fav = ids(run({ bars: new Map([['2454', drop]]), fav: ['2454'] }));
      R.nh = ids(run({ held: H, bars: new Map([['2330', hi]]) })); R.nhNo = ids(run({ held: H, bars: new Map([['2330', kFlat]]) }));
      const fi = m => mkK(80, '2026-10-16', k => { const n = k.length; k.forEach(r => r.foreign_net = -1); for (let j = n - 1 - m; j <= n - 2; j++) k[j].foreign_net = 1000; k[n - 1].foreign_net = 0; });
      R.fi = ids(run({ bars: new Map([['2454', fi(5)]]), fav: ['2454'] })); R.fiNo = ids(run({ bars: new Map([['2454', fi(4)]]), fav: ['2454'] }));
      // 🏦 V79.3.7 外資突然一大筆:過去 200 天在 −500~+500 晃,最後一根(已公布的)買 big → big 很大才算;⛔ 門檻不含當天;過去 < 120 個值不判
      const fb = (big, n = 220) => mkK(n, '2026-10-16', k => { k.forEach((r, i) => r.foreign_net = ((i * 37) % 1001) - 500); k[k.length - 2].foreign_net = big; k[k.length - 1].foreign_net = 0; });
      R.fb = ids(run({ bars: new Map([['2454', fb(50000)]]), fav: ['2454'] })); R.fbNo = ids(run({ bars: new Map([['2454', fb(450)]]), fav: ['2454'] }));
      R.fbShort = ids(run({ bars: new Map([['2454', fb(50000, 100)]]), fav: ['2454'] }));
      const sh = last => mkK(150, '2026-10-16', k => { k.forEach(r => { r.margin_balance = 1000; r.short_balance = 10; }); k[k.length - 1].short_balance = last; });
      R.sh = ids(run({ bars: new Map([['2454', sh(50)]]), fav: ['2454'] })); R.shNo = ids(run({ bars: new Map([['2454', sh(10)]]), fav: ['2454'] }));
      // 🎭 V79.6.3 散戶在接、法人在賣:融資 10 天增 gm、三大法人每天賣 fs 股(量 1000)→ 佔量 fs/10;⛔ 最後一根三大法人都 0 = 沒公布,從前一根算
      const rc = (gm, fs, lastZero = true) => mkK(80, '2026-10-16', k => { const n = k.length, e = lastZero ? n - 2 : n - 1;
        k.forEach((r, i) => { r.margin_balance = i <= e - 10 ? 1000 : Math.round(1000 * (1 + gm * (i - (e - 10)) / 10)); r.foreign_net = -fs; r.trust_net = 0; r.dealer_net = 0; });
        if (lastZero) { k[n - 1].foreign_net = 0; k[n - 1].margin_balance = k[n - 2].margin_balance; } });
      R.rc = ids(run({ bars: new Map([['2454', rc(0.12, 40)]]), fav: ['2454'] }));
      R.rcNoM = ids(run({ bars: new Map([['2454', rc(0.05, 40)]]), fav: ['2454'] }));
      R.rcNoI = ids(run({ bars: new Map([['2454', rc(0.12, 20)]]), fav: ['2454'] }));
      // 💥 V79.6.3 融資斷頭:融資在 100 元附近一路增(成本 ≈ 100 → 追繳線 78),最後 6 天跌到 70、融資 5 天減 13% → margin_call;只跌到 85(還沒破線)→ 沒有
      const mc = lastPx => mkK(80, '2026-10-16', k => { const n = k.length, px = [95, 90, 85, 80, 75, lastPx];
        k.forEach((r, i) => { r.margin_balance = 1000 + Math.min(i, n - 6) * 10; });
        [1700, 1650, 1600, 1550, 1500].forEach((m, j) => { k[n - 5 + j].margin_balance = m; });
        for (let j = 0; j < 6; j++) { const c = j === 5 ? lastPx : px[j], r = k[n - 6 + j]; Object.assign(r, { open: c, high: c * 1.01, low: c * 0.99, close: c }); } });
      R.mc = ids(run({ bars: new Map([['2454', mc(70)]]), fav: ['2454'] }));
      R.mcNo = ids(run({ bars: new Map([['2454', mc(85)]]), fav: ['2454'] }));
      R.mcState = (() => { const st = app._marginCallState(mc(70), '2454'); return st ? `${st.level}:${Math.round(st.callLine)}:${Math.round(st.mgChg)}` : 'null'; })();
      const rb = mkK(80, '2026-10-16', k => { k[k.length - 1].close = 103; });
      R.rb = ids(run({ bars: new Map([['3008', rb]]), sold: new Map([['3008', { date: '2026-10-14', px: 101 }]]) }));
      R.rbNo = ids(run({ bars: new Map([['3008', rb]]), sold: new Map([['3008', { date: '2026-10-14', px: 105 }]]) }));
      R.rbOld = ids(run({ bars: new Map([['3008', rb]]), sold: new Map([['3008', { date: '2026-08-01', px: 101 }]]) }));
      R.rbOnly = ids(run({ bars: new Map([['3008', kLock]]), sold: new Map([['3008', { date: '2026-10-14', px: 200 }]]) }));
      const bu = mkK(120, '2026-10-16'); bu.forEach((r, i) => { const c = i < 110 ? 300 - i : 191 + (i - 109) * 4; Object.assign(r, { open: c, high: c, low: c, close: c }); });
      R.bull = ids(run({ tw: bu })); R.bullNo = ids(run({ tw: dn })); }
    const cv = app._calDayVol; app._calDayVol = () => ({ gap: 5, date: '2026-10-19' }); R.post = ids(run({})); app._calDayVol = () => ({ gap: 3, date: '2026-10-19' }); R.postNo = ids(run({})); app._calDayVol = cv;
    // ④ 分組排序
    const G = app._colTrigGroups([{ id: 'settle', why: 'x' }, { id: 'bear_on', why: 'y' }, { id: 'lu_fav', why: 'z', sym: '2454', sc: 'fav' }, { id: 'lu_held', why: 'w', sym: '2330', sc: 'held' }, { id: 'ld_redk', why: 'a', sym: '2330', sc: 'held' }]);
    R.order = G.map(g => g.sc);
    R.dupe = G.filter(g => g.col.k === 'ld-redk').length;
    // ⑤ 每一個條件都碰到一次 → 每一篇有觸發的專欄都畫出來,整份過研究字樣檢查
    const GA = app._colTrigGroups(app._COL_TRIG_IDS.map(x => ({ id: x.id, why: '測試', sym: x.sc === 'held' || x.sc === 'fav' ? '2330' : null, sc: x.sc })));
    R.allN = GA.length; R.colN = ((app._COL_TRIG || {}).cols || []).filter(c => !c.lead).length;
    const box = document.createElement('div'); box.innerHTML = app._deckColHtml(GA); box.querySelectorAll('details').forEach(d => d.open = true); document.body.appendChild(box);
    R.html = box.innerText; box.remove();
    R.empty = app._deckColHtml([]);
    // ⑥ 每個登記的條件都有判斷
    const src = String(app._colTrigEval);
    R.unhandled = app._COL_TRIG_IDS.map(x => x.id).filter(id => !src.includes(`'${id}'`));
    return R;
});
const has = (a, x) => a.some(v => v === x || v.startsWith(x + ':'));
ok('③a 庫存鎖漲停 → lu_held;沒鎖 → 沒有', has(T.luHeld, 'lu_held') && !has(T.luHeldNo, 'lu_held'), JSON.stringify([T.luHeld, T.luHeldNo]));
ok('③b 自選鎖漲停 → lu_fav(⛔ 不是 lu_held)', has(T.luFav, 'lu_fav') && !has(T.luFav, 'lu_held'), JSON.stringify(T.luFav));
ok('③b2 盤中碰漲停收盤沒鎖 → lu_touch(自選 + V79.2.3 庫存也判、scope=held);收盤鎖住 / 盤中 → 沒有', has(T.luTouch, 'lu_touch') && !has(T.luTouchLock, 'lu_touch') && has(T.luTouchHeld, 'lu_touch') && T.luTouchHeldSc === 'held' && !has(T.luTouchLive, 'lu_touch'), JSON.stringify([T.luTouch, T.luTouchLock, T.luTouchHeld, T.luTouchHeldSc, T.luTouchLive]));
ok('③b3 V79.2.3 收盤後用富果報價補今天那根(high 讀報價);盤中 / 盤前 / 報價是昨天 / 沒量 / 已經有今天 / 沒報價 → 不補', T.tbOk === '1:350.5' && [T.tbOpen, T.tbPre, T.tbYday, T.tbVol0, T.tbHas, T.tbNoQ].every(x => /^0:/.test(x)), JSON.stringify([T.tbOk, T.tbOpen, T.tbPre, T.tbYday, T.tbVol0, T.tbHas, T.tbNoQ]));
ok('③c ETF ⛔ 不判 K 線型態', !has(T.etf, 'lu_held'), JSON.stringify(T.etf));
ok('③d K 線日期追不上大盤 ⛔ 不判(舊資料不冒充今天)', !has(T.stale, 'lu_held'), JSON.stringify(T.stale));
ok('③e 帳面 +25% → gain20;+11% → 沒有', has(T.gain, 'gain20') && !has(T.gainNo, 'gain20'), JSON.stringify([T.gain, T.gainNo]));
ok('③f 除息 4 天後 → exdiv;15 天後 → 沒有', has(T.div, 'exdiv') && !has(T.divNo, 'exdiv'), JSON.stringify([T.div, T.divNo]));
ok('③g 大盤剛轉空頭 → bear_on;一直是空頭 → 沒有', has(T.bearFlip, 'bear_on') && !has(T.bearLong, 'bear_on'), JSON.stringify([T.bearFlip, T.bearLong]));
ok('③h 第三個星期三 → settle;第二個 → 沒有', has(T.settle, 'settle') && !has(T.settleNo, 'settle'), JSON.stringify([T.settle, T.settleNo]));
ok('③i 休市前最後一個交易日 → holiday_pre;前兩天 → 沒有', has(T.pre, 'holiday_pre') && !has(T.preNo, 'holiday_pre'), JSON.stringify([T.pre, T.preNo]));
ok('③j 休市 5 天後第一天 → holiday_post;一般週末後 → 沒有', has(T.post, 'holiday_post') && !has(T.postNo, 'holiday_post'), JSON.stringify([T.post, T.postNo]));
ok('③l 盤前分數 ≤20 → premkt_low;21 分 / 沒算過 / 週末 → 沒有', has(T.pm, 'premkt_low') && !has(T.pmNo, 'premkt_low') && !has(T.pmNull, 'premkt_low') && !has(T.pmWk, 'premkt_low'), JSON.stringify([T.pm, T.pmNo, T.pmNull, T.pmWk]));
ok('③m 加權最新收盤跌 3.5% → idx_drop3;跌 2% → 沒有', has(T.d3, 'idx_drop3') && !has(T.d3No, 'idx_drop3'), JSON.stringify([T.d3, T.d3No]));
ok('③m2 外資台指期急遽加空 → fifut_cut;空單近期最重 / 沒資料 → 沒有', has(T.ff, 'fifut_cut') && !has(T.ffNo, 'fifut_cut') && !has(T.ffNull, 'fifut_cut'), JSON.stringify([T.ff, T.ffNo, T.ffNull]));
ok('③n 手上的跌破 5 日線 → ma5_break;沒跌破 / 自選 → 沒有', has(T.ma5, 'ma5_break') && !has(T.ma5No, 'ma5_break') && !has(T.ma5Fav, 'ma5_break'), JSON.stringify([T.ma5, T.ma5No, T.ma5Fav]));
ok('③o 手上的收盤創 60 日新高 → nh60_held;平盤 → 沒有', has(T.nh, 'nh60_held') && !has(T.nhNo, 'nh60_held'), JSON.stringify([T.nh, T.nhNo]));
ok('③p 外資連買 5 天(最後一根 0 = 沒公布,從前一根算)→ fi_streak5;4 天 → 沒有', has(T.fi, 'fi_streak5') && !has(T.fiNo, 'fi_streak5'), JSON.stringify([T.fi, T.fiNo]));
ok('③p2 外資單日買超 ≥ 自己過去 250 天第 99 百分位(最後一根 0 = 沒公布,看前一根)→ fi_burst;只是平常大小 / 過去不到 120 天 → 沒有', has(T.fb, 'fi_burst') && !has(T.fbNo, 'fi_burst') && !has(T.fbShort, 'fi_burst'), JSON.stringify([T.fb, T.fbNo, T.fbShort]));
ok('③q 券資比衝到自己歷史最高 10% → short_hi;一樣 → 沒有', has(T.sh, 'short_hi') && !has(T.shNo, 'short_hi'), JSON.stringify([T.sh, T.shNo]));
ok('③q2 🎭 融資 10 天增 12% + 三大法人 10 天賣超 4% 佔量(最後一根沒公布 → 從前一根算)→ retail_catch;融資只增 5% / 法人只賣 2% → 沒有', has(T.rc, 'retail_catch') && !has(T.rcNoM, 'retail_catch') && !has(T.rcNoI, 'retail_catch'), JSON.stringify([T.rc, T.rcNoM, T.rcNoI]));
ok('③q3 💥 收盤跌破推估追繳線 + 融資 5 天減 13% → margin_call(追繳線讀 _marginCallState);跌到 85 還沒破線 → 沒有', has(T.mc, 'margin_call') && !has(T.mcNo, 'margin_call') && /^broken:/.test(T.mcState), JSON.stringify([T.mc, T.mcNo, T.mcState]));
ok('③r 賣掉 2 天後收盤站回賣價 → rebuy;沒站回 / 賣掉太久 → 沒有;只賣掉的那檔⛔ 判別的條件', has(T.rb, 'rebuy') && !has(T.rbNo, 'rebuy') && !has(T.rbOld, 'rebuy') && !T.rbOnly.length, JSON.stringify([T.rb, T.rbNo, T.rbOld, T.rbOnly]));
ok('③s 大盤剛脫離空頭 → bull_on;一路跌 → 沒有', has(T.bull, 'bull_on') && !has(T.bullNo, 'bull_on'), JSON.stringify([T.bull, T.bullNo]));
ok('③k 週末⛔ 不判日子類', !has(T.weekend, 'settle'), JSON.stringify(T.weekend));
ok('④ 排序:庫存 > 自選 > 大盤 > 日子;同一篇只列一次', JSON.stringify([...T.order].sort((a, b) => ['held', 'fav', 'mkt', 'date'].indexOf(a) - ['held', 'fav', 'mkt', 'date'].indexOf(b))) === JSON.stringify(T.order) && T.order[0] === 'held' && T.order.at(-1) === 'date' && T.dupe === 1, JSON.stringify([T.order, T.dupe]));
const txt = T.html;
ok('⑤ 每一篇有觸發的專欄都畫得出來,整份⛔ 研究字樣;今天沒碰到整區不畫', T.allN === T.colN && T.colN > 0 && !txt.split('\n').some(l => badOf(l).length) && T.empty === '', `${T.allN}/${T.colN} ` + txt.split('\n').filter(l => badOf(l).length).slice(0, 2).join(' / '));
ok('⑥ 每個登記的條件都有判斷', !T.unhandled.length, T.unhandled.join(','));
ok('⑦ 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
