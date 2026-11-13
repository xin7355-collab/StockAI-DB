#!/usr/bin/env node
/**
 * 📋 V82.2.9 週報「本週重點」兩段(使用者 11/13 選「另做本週重點」放 🔓 進階功能)
 *   走真的 `_weekHtml()` + 合成資料(⛔ 測試裡不複製一份邏輯):
 *   ① 沒解鎖 → 兩段都沒有;決定性對照:解鎖 + 開 → 有;解鎖但關掉 week → 沒有
 *   ② 你的股票:窗口內的公告才列、庫存排在自選前、⚠️ 只標那兩類(減資彌補虧損 / 庫藏股買完)、⚠️ 的怎麼做讀專欄原文
 *   ③ 申報轉讓:身分 / 方式 / 預定張數(第一次上線只列事實,⛔ ⚠️)
 *   ④ 月營收只在公布期(窗口裡有 1~12 號);決定性對照:窗口換到 16~20 號 → 沒有
 *   ⑤ 法說會:這週開完 / 7 天內要開 / 簡報第一次提到 / 公司說的展望做到了沒(讀 data/cc 的 g)
 *   ⑥ 除息(這週已除 / 接下來要除)・⑦ 注意股
 *   ⑧ 材料鏈:三組照 玻纖布 → CCL → PCB、中位數 == _regimeStats(5).tmed(唯一真相)、銅價讀 macro_risk(改數字畫面跟著變;沒有 → 寫還沒抓到)
 *   ⑨ 讀不到 ≠ 沒有:重大訊息讀不到要寫出來;決定性對照:讀到但空的 → 不寫讀不到
 *   ⑩ ⛔ 研究字樣(lib_retailbad)/ ⛔ 🔴🟢;⑪ 390px 不橫捲
 * 注入(逐一確認會紅):INJECT=nogate(拿掉解鎖守門)/ nowin(公告不看窗口)/ nomiss(讀不到當成沒有)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
import { rwdShim } from './lib_rwdshim.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nogate') SRC = SRC.replace('const wkOn = !!this._deckShow().week;', 'const wkOn = true;');
if (INJ === 'nowin') SRC = SRC.replace("for (const r of mrows) if (String(r.s) === sym && r.d >= W.from && r.d <= W.to) {", 'for (const r of mrows) if (String(r.s) === sym) {');
if (INJ === 'nomiss') SRC = SRC.replace("if (!MR.doc) miss.push(", 'if (false) miss.push(');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_week_digest.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._weekHtml === 'function', null, { timeout: 60000 });
    const shimBad = await page.evaluate(rwdShim);
    const R = await page.evaluate(() => {
        const out = {};
        const txt = h => { const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d); const t = d.innerText || d.textContent; d.remove(); return t; };
        const sec = (html, k) => { const d = document.createElement('div'); d.innerHTML = html; const e = d.querySelector(`[data-evesec="${k}"]`); return e ? (document.body.appendChild(d), (() => { const t = e.innerText; d.remove(); return t; })()) : null; };
        // ── 合成資料 ──
        app._colToday = () => ({ tdy: '2026-11-13', wk: 5, weekday: true });
        app._breadthHist = ['2026/11/09', '2026/11/10', '2026/11/11', '2026/11/12', '2026/11/13'].map((d, i) => ({ d, idx: 0.3 * (i - 2), up: 900, dn: 800, flat: 100 }));
        const cols = ['c', 'chg', 'chg3', 'chg5', 'chg20', 'amt'];
        app._scrC = Object.fromEntries(cols.map((c, i) => [c, i]));
        const rows = {}, ind = {};
        for (let i = 0; i < 330; i++) { const s = String(4000 + i); rows[s] = [50, 0.1, 0.2, (i % 7) - 3, 1, 1]; ind[s] = '產業' + (i % 9); }
        const SEED = { glass: ['1815', '5340', '1802'], ccl: ['2383', '6213', '6274'], pcb: ['3037', '8046', '2368'] };
        const c5 = { 1815: 4.0, 5340: 2.0, 1802: -1.0, 2383: 6.5, 6213: 3.1, 6274: -0.4, 3037: 1.2, 8046: 0.8, 2368: -2.2, 2330: 1.0, 2454: -0.5 };
        for (const [s, v] of Object.entries(c5)) { rows[s] = [100, 0.5, 1, v, 2, 1]; ind[s] = '電子'; }
        app._scrData = { cols, rows, ind, data_date: '2026-11-13' };
        const by = {};
        for (const [k, a] of Object.entries(SEED)) for (const s of a) by[s] = { s: [k], n: [] };
        app._tagsCache = { names: { glass: '玻纖布/玻纖紗', ccl: 'CCL 銅箔基板/銅箔', pcb: 'ABF 載板/PCB' }, by_stock: by, data_date: '2026-11-13' };
        app._regCache = null;
        app.inventory = [{ symbol: '2330', cost: 900, shares: 1000 }];
        app._getInventory = () => app.inventory;
        app.favGroups = { 自選: ['2454', '2330'] };
        const MOPS = rows => ({ cols: ['s', 'n', 'd', 't', 'sub', 'mk', 'cat'], avoid: { cap_red_loss: '減資彌補虧損', buyback_end: '庫藏股買完 / 期滿 / 註銷' }, from: '2026-10-31', to: '2026-11-13', rows });
        const mopsRows = [
            ['2330', '台積電', '2026-11-03', '10:00:00', '舊的公告不該出現', 'sii', 'other'],
            ['2330', '台積電', '2026-11-10', '14:00:00', '公告本公司董事會通過股利分派', 'sii', 'dividend'],
            ['2330', '台積電', '2026-11-12', '15:30:00', '公告本公司董事會決議減資彌補虧損', 'sii', 'cap_red_loss'],
            ['2454', '聯發科', '2026-11-11', '16:00:00', '公告本公司董事會通過合併財務報告', 'sii', 'finrep'],
            ['9999', '不相干', '2026-11-11', '16:00:00', '不是你的股票', 'sii', 'other'],
            ['2383', '台光電', '2026-11-12', '17:00:00', '公告取得設備', 'sii', 'asset'],
        ];
        app._mopsRec = { at: Date.now(), doc: MOPS(mopsRows), err: '' };
        app._insRec = { at: Date.now(), err: '', doc: { cols: ['s', 'n', 'd', 'role', 'rc', 'method', 'mc', 'sh', 'chg', 'mk'], rows: [
            ['2454', '聯發科', '2026-11-12', '董事本人', 'dir', '一般交易(每日得轉讓股數限制)', 'mkt', 1621000, '', 'sii']] } };
        app._fundYoyGmAll = { ts: Date.now(), data: {
            2330: { yoy: 12.3, ytd: 20.1, mrev: 350000000000, mrh: [['2026-09', 330000], ['2026-10', 350000]] },
            2383: { yoy: 45.2, mrh: [['2026-10', 9000]] }, 6213: { yoy: -3.0, mrh: [['2026-10', 1000]] } } };
        app._divFileCache = { ts: Date.now(), data: { d: { 2330: { h: [['2026-11-10', 5, '息', 1000, 995]], up: [['2026-11-18', 5]] } } } };
        app._confcallCache = { upcoming: [{ s: '2454', d: '2026-11-17', t: '14:00' }], recent: [{ s: '2330', d: '2026-11-11', t: '14:00' }, { s: '2383', d: '2026-11-12', t: '14:00' }] };
        app._ccCache = { 2330: { s: '2330', decks: [{ d: '2026-11-11', st: 'ok', f: 'x.pdf', new: [['CoWoS', 3], ['先進封裝', 5]],
            g: [{ p: 3, t: '第三季營收會比去年好', m: 'rev', dir: 'up', h: '2026Q3', ok: true, r: { res: 'hit', known: '2026-11-10', cur: '2026Q3', base: '2025Q3', src: 'm', chg: 30.2, a: 9000, b: 7000 } }] }] } };
        app.attentionStatus = { 2454: { status: '⚠️ 注意股', date: '2026-11-12' } };
        app._macroRiskCache = { copper: 4.85, copper_chg_pct: 0.5, copper_chg_5d: 2.3, copper_date: '2026-11-12', upcoming_macro_events: [] };
        app.settings.strategy = 'gene';
        // ① 解鎖守門
        app.settings.stratUnlock = false; app.settings.deckShow = {};
        const locked = app._weekHtml();
        out.lockedMine = /data-evesec="wmine"/.test(locked); out.lockedChain = /data-evesec="wchain"/.test(locked);
        app.settings.stratUnlock = true; app.settings.deckShow = { week: false };
        out.offMine = /data-evesec="wmine"/.test(app._weekHtml());
        app.settings.deckShow = {};   // 沒存過 → def:true
        const H = app._weekHtml();
        out.html = H;
        out.mine = sec(H, 'wmine'); out.chain = sec(H, 'wchain');
        out.secOrder = [...H.matchAll(/data-evesec="(\w+)"/g)].map(m => m[1]);
        out.blockOrder = [...H.matchAll(/data-weekmine="(\d+)"/g)].map(m => m[1]);
        out.avoidTips = (((app._COL_TRIG || {}).cols || []).find(c => c.k === 'mops-event') || {}).do || [];
        out.tmedCcl = app._regimeStats(5).tmed.get('ccl');
        out.cclPct = app._evePct(out.tmedCcl, 1);
        // ⑧ 銅價:改數字 → 畫面跟著變;拿掉 → 寫還沒抓到
        app._macroRiskCache.copper_chg_5d = -7.7; out.chainCu2 = sec(app._weekHtml(), 'wchain');
        delete app._macroRiskCache.copper; delete app._macroRiskCache.copper_date; delete app._macroRiskCache.copper_chg_5d;
        out.chainCu0 = sec(app._weekHtml(), 'wchain');
        app._macroRiskCache.copper = 4.85; app._macroRiskCache.copper_chg_5d = 2.3; app._macroRiskCache.copper_date = '2026-11-12';
        // ④ 決定性對照:窗口換到 16~20 號 → 沒有月營收
        app._colToday = () => ({ tdy: '2026-11-20', wk: 5, weekday: true });
        app._breadthHist = ['2026/11/16', '2026/11/17', '2026/11/18', '2026/11/19', '2026/11/20'].map(d => ({ d, idx: 0, up: 900, dn: 800, flat: 100 }));
        out.mineLate = sec(app._weekHtml(), 'wmine');
        app._colToday = () => ({ tdy: '2026-11-13', wk: 5, weekday: true });
        app._breadthHist = ['2026/11/09', '2026/11/10', '2026/11/11', '2026/11/12', '2026/11/13'].map(d => ({ d, idx: 0, up: 900, dn: 800, flat: 100 }));
        // ⑨ 讀不到 vs 讀到但空的
        app._mopsRec = { at: Date.now(), doc: null, err: '連不上' };
        out.mineMiss = sec(app._weekHtml(), 'wmine');
        app._mopsRec = { at: Date.now(), doc: MOPS([]), err: '' };
        out.mineEmpty = sec(app._weekHtml(), 'wmine');
        app._mopsRec = { at: Date.now(), doc: MOPS(mopsRows), err: '' };
        // ⑪ 390px:放進 358px 的容器量每個元素有沒有超出
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:16px;top:0;width:358px;';
        box.innerHTML = app._weekHtml();
        document.body.appendChild(box);
        const bx = box.getBoundingClientRect();
        let over = 0; for (const e of box.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width > 0) over = Math.max(over, r.right - bx.right); }
        out.w390 = { boxW: bx.width, over: Math.round(over) };
        box.remove();
        return out;
    });
    ok('⓪ 版面 shim 全部生效(⛔ 量到假的幾何)', !shimBad || !shimBad.length, JSON.stringify(shimBad));
    ok('① 沒解鎖 → 兩段都沒有', !R.lockedMine && !R.lockedChain, JSON.stringify([R.lockedMine, R.lockedChain]));
    ok('① 解鎖但關掉 week → 沒有', !R.offMine, R.offMine);
    ok('① 決定性對照:解鎖 + 沒存過(預設開)→ 兩段都有,材料鏈在板塊後、本週重點在持股後', R.mine && R.chain
       && R.secOrder.indexOf('wchain') === R.secOrder.indexOf('wsect') + 1 && R.secOrder.indexOf('wmine') > R.secOrder.indexOf('wsect'), JSON.stringify(R.secOrder));
    const M = R.mine || '';
    ok('② 窗口內的公告才列(11/03 那則 ⛔、別人的 ⛔)', /股利分派/.test(M) && !/舊的公告不該出現/.test(M) && !/不是你的股票/.test(M), M.slice(0, 300));
    ok('② 庫存排在自選前(2330 → 2454),同一檔在庫存也在自選只列一次', JSON.stringify(R.blockOrder) === '["2330","2454"]', JSON.stringify(R.blockOrder));
    ok('② ⚠️ 只標那兩類:減資彌補虧損有標、股利分派 / 合併財報 ⛔', /⚠️[^\n]*減資彌補虧損/.test(M) && !/⚠️[^\n]*股利分派/.test(M) && !/⚠️[^\n]*合併財務報告/.test(M), M);
    const tip = R.avoidTips.find(t => /減資彌補虧損/.test(t)) || '';
    ok('② ⚠️ 的怎麼做 = 專欄原文(_COL_TRIG mops-event)+ 照你的出場規則', tip && M.includes(tip) && /照你的出場規則走/.test(M), tip);
    ok('③ 申報轉讓:身分 + 方式 + 預定張數(1,621 張)、⛔ ⚠️', /🧾[^\n]*董事本人申報轉讓[^\n]*一般交易[^\n]*1,621 張/.test(M) && !/⚠️[^\n]*申報轉讓/.test(M), M);
    ok('④ 月營收(公布期):10 月營收 3500.00 億、年增 +12.3%、累計年增 +20.1%', /📈 10 月營收 3500\.00 億\(年增 \+12\.3%、今年累計年增 \+20\.1%\)/.test(M), M);
    ok('④ 決定性對照:窗口換到 16~20 號 → 沒有月營收那行', R.mineLate && !/📈/.test(R.mineLate), R.mineLate);
    ok('⑤ 法說會:這週開完(11/11)、7 天內要開(2454 11/17)', /📞 11\/11[^\n]*開法說會/.test(M) && /📞 11\/17[^\n]*要開法說會/.test(M), M);
    ok('⑤ 簡報第一次提到 2 個詞 + 公司說的展望做到了沒(✅ 做到了)', /第一次提到 2 個詞\(CoWoS、先進封裝\)/.test(M) && /📋[^\n]*公司說「[^」]*營收[^」]*」→ ✅ 做到了/.test(M), M);
    ok('⑥ 除息:這週已除 5 元、接下來 11/18 要除息', /已除息 5 元/.test(M) && /11\/18[^\n]*要除息 現金 5 元/.test(M), M);
    ok('⑦ 注意股寫出來', /⚠️ 被列為注意股/.test(M), M);
    const C = R.chain || '';
    ok('⑧ 材料鏈三組照 玻纖布 → CCL → PCB', C.indexOf('玻纖布') >= 0 && C.indexOf('玻纖布') < C.indexOf('CCL') && C.indexOf('CCL') < C.indexOf('PCB'), C.slice(0, 200));
    const pct = (R.cclPct.match(/[+-]?\d+\.\d%/) || [''])[0];
    ok('⑧ 中位數 == _regimeStats(5).tmed(唯一真相)', pct && new RegExp('CCL[^\\n]*近 5 日中位數 ' + pct.replace('+', '\\+')).test(C), `${pct} | ${C.slice(0, 300)}`);
    ok('⑧ 成員帶最新月營收年增(標月份)、這週公告 / 法說會家數', /10 月營收年增 \+45%/.test(C) && /這週公告 1 則/.test(C) && /開法說會 1 家/.test(C), C);
    ok('⑧ 銅價讀 macro_risk(4.85、近 5 日 +2.3%、日期);改數字 → 畫面跟著變;拿掉 → 寫還沒抓到', /銅價[^\n]*4\.85[^\n]*\+2\.3%/.test(C) && /-7\.7%/.test(R.chainCu2 || '') && /銅價還沒抓到/.test(R.chainCu0 || ''), [C.slice(-200), R.chainCu2, R.chainCu0].join(' || '));
    ok('⑨ 重大訊息讀不到 → 寫出來(⛔ 當成沒有)', /重大訊息讀不到\(連不上\)/.test(R.mineMiss || '') && /不代表這週沒有/.test(R.mineMiss || ''), R.mineMiss);
    ok('⑨ 決定性對照:讀到但空的 → 不寫讀不到', R.mineEmpty && !/讀不到/.test(R.mineEmpty), R.mineEmpty);
    const bad = badOf((R.mine || '') + '\n' + (R.chain || ''));
    ok('⑩ ⛔ 研究字樣(lib_retailbad)', !bad.length, bad.join(' '));
    ok('⑩ ⛔ 🔴🟢(漲跌用字的顏色,好壞用 ✅ ⚠️)', !/[🔴🟢]/u.test((R.mine || '') + (R.chain || '')), '');
    ok('⑪ 390px:容器 358px、沒有元素超出', R.w390.boxW >= 350 && R.w390.over <= 2, JSON.stringify(R.w390));
    ok('⑫ 無 pageerror', !errs.length, errs.join(' | '));
} finally {
    await browser.close();
    fs.unlinkSync(TMP);
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
