#!/usr/bin/env node
/**
 * 🏛️ V82.7.5 全市場公司公告(大盤 › 消息面 › 📰 新聞焦點那張卡、新聞列表上面;🔓「公司公告與本週重點」開著才有)
 *   走真的 `_renderEvtFeed()` / `_evtFeedHtml()` + 合成資料(⛔ 測試裡不複製一份邏輯):
 *   ① 沒解鎖 → 不讀檔、整塊藏起來;決定性對照:解鎖 + 開 → 有;解鎖但關掉 week → 藏起來
 *   ② 只列最近 3 個「有公告」的交易日(檔頭 days 加起來 > 0),新 → 舊;第 4 天 ⛔ 出現
 *   ③ 那幾類(kind)+ 停止買賣 / 澄清報導… 攤開(先 8 則、其他「再看 N 則」);法說會那種收進「其他公告 N 則」
 *   ④ 金額:新台幣訂單 = 金額 + 約一年營收的 Y%(mrh 最近 12 個月;14% / 8.2% 算給你看);
 *      增資 / 庫藏股 → 只寫金額(⛔ 營收佔比);外幣 → 只寫金額;不滿 12 個月 / 中間缺一個月 → ⛔ 佔比;
 *      沒抓到金額 / 不到 1 萬元(每股價格)→ 沒有 💰 那一行(⛔ 寫 0);不到 1 億 → 用萬
 *   ⑤ 產業:題材(stock_tags 的 s)→ 官方產業(screener ind)→ 其他;⛔ 純數字代碼
 *   ⑥ 新聞也報:nw ≥ 1 才寫「📰 新聞 N 則也報」;0 / 空 → 不寫
 *   ⑦ 每一列 ✅ 官方公告;⛔ 高 / 中 / 重要度、⛔ 研究字樣(lib_retailbad)、⛔ 🔴🟢
 *   ⑧ 讀到但窗口裡沒有列 → 整塊藏起來(⛔ 空殼);讀不到 → 一行寫原因(⛔ 當成沒有公告)
 *   ⑨ 檔頭 miss 記的整天沒抓到 → ⏳ 那一行寫日期 + 市場;決定性對照:沒有 miss → 沒有那一行
 *   ⑩ 使用者自己點開「再看 N 則」→ 重畫之後還是開著(_rpSet);決定性對照:沒點過 → 重畫後關著
 *   ⑪ 390px 不橫捲 ・⑫ 無 pageerror
 * 注入(逐一確認會紅):INJECT=nogate(拿掉 🔓 守門)/ rev11(11 個月當一年)/ ratioall(增資也算營收佔比)/
 *   zeroamt(沒抓到金額寫成數字)/ nomiss(檔頭 miss 不看)/ nosort(不照時間排)
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
const sub = (a, b) => { SRC = SRC.replace(a, b); };
if (INJ === 'nogate') sub("if (!this._deckShow().week) { box.innerHTML = ''; box.classList.add('hidden'); return; }\n        const jobs = [this._loadMopsRecent()", "\n        const jobs = [this._loadMopsRecent()");
if (INJ === 'rev11') { sub('if (M.size < 12) return null;\n        const last = [...M.keys()].sort().pop();\n        let y = +last.slice(0, 4), m = +last.slice(5, 7), sum = 0;', 'const last = [...M.keys()].sort().pop();\n        let y = +last.slice(0, 4), m = +last.slice(5, 7), sum = 0;'); sub("            if (!(v > 0)) return null;\n            sum += v;", '            if (!(v > 0)) { if (--m === 0) { m = 12; y--; } continue; }\n            sum += v;'); }
if (INJ === 'ratioall') sub('if (this._EVT_RATIO_KINDS.includes(r.kind)) {', 'if (true) {');
if (INJ === 'zeroamt') sub("const a = r && r.amt != null && r.amt !== '' ? +r.amt : NaN;", 'const a = r ? (+r.amt || 0.0001) : NaN;');
if (INJ === 'nomiss') sub('for (const [d, mks] of Object.entries(MS)) if (d >= lo && d < today)', 'for (const [d, mks] of Object.entries(MS)) if (false)');
if (INJ === 'nosort') sub('rows.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));', '');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_evt_feed.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._renderEvtFeed === 'function', null, { timeout: 60000 });
    const shimBad = await page.evaluate(rwdShim);
    const R = await page.evaluate(async () => {
        const out = {};
        const box = () => document.getElementById('evtFeedBox');
        const txt = el => (el ? (el.innerText || el.textContent || '') : '');
        // ── 合成資料 ──
        app._colToday = () => ({ tdy: '2026-11-13', wk: 5, weekday: true });
        app.getStockName = c => ({ 4588: '玖鼎電力', 2345: '智邦', 2409: '友達', 3711: '日月光投控', 6669: '緯穎', 1101: '台泥', 2330: '台積電',
            2317: '鴻海', 1234: '某公司', 2603: '長榮', 2609: '陽明', 2615: '萬海', 2002: '中鋼', 8888: '小公司' })[c] || c;
        const cols = ['s', 'n', 'd', 't', 'sub', 'mk', 'cat', 'kind', 'amt', 'cur', 'ev', 'nw'];
        const rows = [
            ['2317', '鴻海', '2026-11-10', '10:00:00', '第 4 天的公告不該出現', 'sii', 'order', '訂單', 10, 'TWD', '金額10億元', null],
            ['4588', '玖鼎電力', '2026-11-13', '15:35:20', '本公司獲得台電公司「模組化智慧型電表」金額約 新台幣1.64億元(未稅)', 'otc', 'order', '訂單', 1.64, 'TWD', '取得訂單金額約1.64億元', 2],
            ['2345', '智邦', '2026-11-13', '15:54:07', '本公司董事會決議辦理現金增資發行普通股', 'sii', 'cash_inc', '增資', 121.7, 'TWD', '發行股數10,000,000股', 0],
            ['2330', '台積電', '2026-11-13', '13:54:04', '公告本公司將參加法人說明會', 'sii', 'confcall', '', null, null, null, null],
            ['2409', '友達', '2026-11-12', '16:00:10', '本公司處分華亞廠不動產及其相關廠務附屬設施', 'sii', 'asset', '處分', 197.0, 'TWD', '交易總金額:新台幣197億元', null],
            ['3711', '日月光投控', '2026-11-12', '17:30:00', '代子公司矽品精密工業(股)公司公告取得廠務工程', 'sii', 'sub', '取得', 48.07, 'TWD', '交易總金額:4,807,346,759元', 1],
            ['1234', '某公司', '2026-11-12', '10:00:00', '公告本公司取得機器設備', 'sii', 'asset', '取得', null, null, '', null],
            ['8888', '小公司', '2026-11-12', '09:30:00', '公告本公司取得設備', 'sii', 'asset', '取得', 5e-8, 'TWD', '每股5元', null],   // 5 元(舊版解析抓到每股價格)
            ['6669', '緯穎', '2026-11-11', '18:00:00', '代子公司取得大陸使用權資產', 'sii', 'sub', '取得', 0.278, 'CNY', '交易總金額為人民幣2,780萬元', null],
            ['1101', '台泥', '2026-11-11', '09:00:00', '公告本公司接獲通知股票停止買賣日期', 'sii', 'halt', '', null, null, null, null],
            ['2603', '長榮', '2026-11-11', '14:00:00', '公告本公司董事會決議買回庫藏股', 'sii', 'buyback', '庫藏股', 30, 'TWD', '預定買回總金額30億元', 3],
            ['2609', '陽明', '2026-11-11', '14:10:00', '公告本公司董事會決議買回庫藏股', 'sii', 'buyback', '庫藏股', 12.5, 'TWD', '預定買回總金額12.5億元', null],
            ['2615', '萬海', '2026-11-11', '14:20:00', '公告本公司董事會決議買回庫藏股', 'sii', 'buyback', '庫藏股', 0.5, 'TWD', '預定買回總金額5,000萬元', null],
            ['2002', '中鋼', '2026-11-11', '08:00:00', '公告本公司董事會通過股利分派', 'sii', 'dividend', '', null, null, null, null],
        ];
        const DOC = (rr, extra = {}) => ({ cols, rows: rr, updated: '2026-11-13T18:20+08:00', keep: 14,
            days: { '2026-11-10': { sii: 5, otc: 2 }, '2026-11-11': { sii: 50, otc: 20 }, '2026-11-12': { sii: 40, otc: 10 }, '2026-11-13': { sii: 60, otc: 30 } }, miss: {}, ...extra });
        const mk = (n, v, end = '2026-10') => { const o = []; let y = +end.slice(0, 4), m = +end.slice(5, 7); for (let i = 0; i < n; i++) { o.unshift([`${y}-${String(m).padStart(2, '0')}`, v]); if (--m === 0) { m = 12; y--; } } return o; };
        const m11gap = mk(13, 100).filter(x => x[0] !== '2026-05');   // 12 個月裡缺 5 月
        app._fundYoyGmAll = { ts: Date.now(), data: {
            4588: { mrh: mk(12, 100) },            // 一年 1,200 百萬 = 12 億 → 1.64 億 = 13.67% → 14%
            2409: { mrh: mk(16, 20000) },          // 一年 240,000 百萬 → 197 億 = 8.21% → 8.2%
            3711: { mrh: mk(11, 50000) },          // 只有 11 個月 → ⛔ 佔比
            2345: { mrh: mk(16, 15000) },          // 增資 → ⛔ 佔比(營收有也一樣)
            2603: { mrh: mk(16, 30000) },
            1234: { mrh: m11gap } } };
        app._tagsCache = { names: { pwr: '電源/UPS', sw: '交換器/網通' }, by_stock: { 4588: { s: ['pwr'], n: [] }, 2345: { s: ['sw'], n: [] }, 2409: { s: [], n: [['x', 0.9]] } } };
        app._scrData = { cols: ['c'], rows: {}, ind: { 2409: '光電業', 1234: '35', 3711: '半導體業' } };
        const setDoc = d => { app._mopsRec = { at: Date.now(), doc: d, err: '' }; };
        setDoc(DOC(rows));
        let loads = 0; const L0 = app._loadMopsRecent.bind(app); app._loadMopsRecent = function () { loads++; return L0(); };
        // ① 🔓 守門
        app.settings.stratUnlock = false; app.settings.deckShow = {};
        await app._renderEvtFeed();
        out.lockedHidden = box().classList.contains('hidden') && !box().innerHTML.trim(); out.lockedLoads = loads;
        app.settings.stratUnlock = true; app.settings.deckShow = { week: false };
        await app._renderEvtFeed();
        out.offHidden = box().classList.contains('hidden') && !box().innerHTML.trim();
        app.settings.deckShow = { week: true };
        await app._renderEvtFeed();
        out.onShown = !box().classList.contains('hidden') && !!box().querySelector('[data-evtfeed]');
        out.html = box().innerHTML; out.text = txt(box());
        // ② / ③ 順序與分組
        out.order = [...box().querySelectorAll('[data-evtrow]')].map(e => e.getAttribute('data-evtrow'));
        out.mainShown = [...box().querySelectorAll(':scope [data-evtfeed] > [data-evtrow]')].length;
        const more = box().querySelector('details[data-dk="evt-more"]');
        out.moreSum = more ? txt(more.querySelector('summary')) : null;
        const oth = box().querySelector('details[data-dk="evt-other"]');
        out.otherSum = oth ? (oth.querySelector('summary').textContent || '') : null;
        out.otherRows = oth ? [...oth.querySelectorAll('[data-evtother]')].map(e => e.textContent) : [];
        const rowOf = s => { const e = box().querySelector(`[data-evtrow^="${s}|"]`); return e ? e.textContent : null; };
        out.r = Object.fromEntries(['4588', '2345', '2409', '3711', '1234', '6669', '1101', '2603', '2615', '2317', '2330'].map(s => [s, rowOf(s)]));
        out.amtLines = Object.fromEntries(['4588', '2345', '2409', '3711', '1234', '6669', '2603', '2615', '8888'].map(s => { const e = box().querySelector(`[data-evtrow^="${s}|"] [data-evtamt]`); return [s, e ? e.textContent : null]; }));
        out.ind = Object.fromEntries(['4588', '2409', '1234', '3711', '6669'].map(s => { const e = box().querySelector(`[data-evtrow^="${s}|"] [data-evtind]`); return [s, e ? e.textContent : null]; }));
        out.rowCount = box().querySelectorAll('[data-evtrow]').length;
        out.checkCount = [...box().querySelectorAll('[data-evtrow]')].filter(e => /✅/.test(e.textContent)).length;
        // ⑩ 使用者點開「再看 N 則」→ 重畫還是開著
        if (more) { more.querySelector('summary').click(); }
        app._mopsRec.at = Date.now(); await app._renderEvtFeed();
        const more2 = box().querySelector('details[data-dk="evt-more"]'); out.moreKept = !!(more2 && more2.open);
        // 決定性對照:沒點過的「其他公告」重畫後還是關著
        const oth2 = box().querySelector('details[data-dk="evt-other"]'); out.otherClosed = !!(oth2 && !oth2.open);
        // ⑨ 檔頭 miss
        setDoc(DOC(rows, { miss: { '2026-11-09': ['sii'], '2026-11-12': ['otc'] } }));
        await app._renderEvtFeed();
        const g = box().querySelector('[data-evtgap]'); out.gap = g ? g.textContent : null;
        setDoc(DOC(rows));
        await app._renderEvtFeed();
        out.gapNone = !box().querySelector('[data-evtgap]');
        // ⑧ 讀到但窗口裡沒有列 → 藏起來;讀不到 → 一行
        setDoc(DOC([rows[0]], { days: { '2026-11-12': { sii: 0, otc: 0 } } }));
        await app._renderEvtFeed();
        out.emptyHidden = box().classList.contains('hidden') && !box().innerHTML.trim();
        app._mopsRec = { at: Date.now(), doc: null, err: '連不上' };
        app._loadMopsRecent = async () => null;
        await app._renderEvtFeed();
        out.miss = txt(box());
        out.missShown = !box().classList.contains('hidden');
        // ⑪ 390px
        const c = document.createElement('div');
        c.style.cssText = 'position:absolute;left:16px;top:0;width:358px;';
        c.innerHTML = out.html;
        for (const d of c.querySelectorAll('details')) d.open = true;
        document.body.appendChild(c);
        const bx = c.getBoundingClientRect();
        let over = 0; for (const e of c.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width > 0) over = Math.max(over, r.right - bx.right); }
        out.w390 = { boxW: bx.width, over: Math.round(over) };
        c.remove();
        return out;
    });
    ok('⓪ 版面 shim 全部生效(⛔ 量到假的幾何)', !shimBad || !shimBad.length, JSON.stringify(shimBad));
    ok('① 沒解鎖 → 不讀檔、整塊藏起來', R.lockedHidden && R.lockedLoads === 0, JSON.stringify([R.lockedHidden, R.lockedLoads]));
    ok('① 解鎖但關掉 week → 藏起來', R.offHidden, R.offHidden);
    ok('① 決定性對照:解鎖 + 開 → 有', R.onShown, R.onShown);
    const O = R.order || [];
    ok('② 新 → 舊:11/13 智邦 15:54 → 玖鼎 15:35 → 11/12 … → 11/11', O[0] === '2345|2026-11-13' && O[1] === '4588|2026-11-13' && O.indexOf('2409|2026-11-12') < O.indexOf('2603|2026-11-11'), O.join(' '));
    ok('② 只列最近 3 個有公告的交易日(第 4 天 11/10 ⛔ 出現)', R.r['2317'] === null && !/第 4 天/.test(R.text), R.r['2317']);
    ok('③ 那幾類 + 停止買賣攤開(先 8 則),其他「再看 3 則」', R.mainShown === 8 && /再看 3 則/.test(R.moreSum || '') && !!R.r['1101'] && /停止買賣/.test(R.r['1101'] || ''), [R.mainShown, R.moreSum].join(' | '));
    ok('③ 法說會 / 股利收進「其他公告 2 則」(⛔ 攤開)', /其他公告 2 則/.test(R.otherSum || '') && R.r['2330'] === null && R.otherRows.some(t => /法人說明會/.test(t)) && R.otherRows.some(t => /股利/.test(t)), [R.otherSum, R.otherRows.join(' / ')].join(' | '));
    const A = R.amtLines || {};
    ok('④ 新台幣訂單:金額 1.64 億元・約一年營收的 14%', /金額 1\.64 億元・約一年營收的 14%/.test(A['4588'] || ''), A['4588']);
    ok('④ 處分:金額 197 億元・約一年營收的 8.2%(16 個月只取最近 12 個月)', /金額 197 億元・約一年營收的 8\.2%/.test(A['2409'] || ''), A['2409']);
    ok('④ 增資 / 庫藏股 → 只寫金額(⛔ 營收佔比)', /金額 121\.7 億元/.test(A['2345'] || '') && !/營收/.test(A['2345'] || '') && /金額 30 億元/.test(A['2603'] || '') && !/營收/.test(A['2603'] || ''), [A['2345'], A['2603']].join(' | '));
    ok('④ 不滿 12 個月 → 只寫金額', /金額 48\.07 億元/.test(A['3711'] || '') && !/營收/.test(A['3711'] || ''), A['3711']);
    ok('④ 外幣 → 「金額 人民幣 2,780 萬元」(⛔ 營收佔比)', /金額 人民幣 2,780 萬元/.test(A['6669'] || '') && !/營收/.test(A['6669'] || ''), A['6669']);
    ok('④ 不到 1 億 → 用萬(5,000 萬元)', /金額 5,000 萬元/.test(A['2615'] || ''), A['2615']);
    ok('④ 沒抓到金額 → 沒有 💰 那一行(⛔ 寫 0)', A['1234'] === null && !/金額 0/.test(R.text), A['1234']);
    ok('④ 不到 1 萬元(5 元 = 每股價格)→ 沒有 💰 那一行(⛔「金額 0 萬元」)', A['8888'] === null && !/金額 0 萬/.test(R.text), A['8888']);
    const I = R.ind || {};
    ok('⑤ 產業:題材優先(玖鼎 #電源/UPS)→ 官方產業(友達 #光電業、日月光 #半導體業)→ 其他', I['4588'] === '#電源/UPS' && I['2409'] === '#光電業' && I['3711'] === '#半導體業' && I['6669'] === '#其他', JSON.stringify(I));
    ok('⑤ 純數字代碼(35)⛔ 印出來 → 其他', I['1234'] === '#其他', I['1234']);
    ok('⑥ 新聞也報:nw 2 → 「📰 新聞 2 則也報」;nw 0 / 空 → 不寫', /📰 新聞 2 則也報/.test(A['4588'] || '') && /📰 新聞 3 則也報/.test(A['2603'] || '') && !/新聞/.test(A['2345'] || '') && !/新聞/.test(A['2409'] || ''), [A['4588'], A['2603'], A['2345']].join(' | '));
    ok('⑦ 每一列都有 ✅(官方公告)', R.rowCount === 11 && R.checkCount === 11, `${R.checkCount}/${R.rowCount}`);
    ok('⑦ ⛔ 高 / 中 / 重要度字樣', !/重要度|重要性|(?:^|[^\w])[高中]\s*(?:重要|影響)|影響[高中]/.test(R.text), R.text.slice(0, 300));
    const bad = badOf(R.text || '');
    ok('⑦ ⛔ 研究字樣(lib_retailbad)', !bad.length, bad.join(' '));
    ok('⑦ ⛔ 🔴🟢', !/[🔴🟢]/u.test(R.html || ''), '');
    ok('⑧ 讀到但窗口裡沒有列 → 整塊藏起來(⛔ 空殼)', R.emptyHidden, R.emptyHidden);
    ok('⑧ 讀不到 → 一行寫原因、⛔ 當成沒有公告', R.missShown && /讀不到\(連不上\)/.test(R.miss || '') && /不代表這幾天沒有公告/.test(R.miss || ''), R.miss);
    ok('⑨ 檔頭 miss:窗口裡那天(11/12 上櫃)寫出來,窗口外(11/09)不寫', /11\/12[^、]*上櫃/.test(R.gap || '') && !/11\/09/.test(R.gap || '') && /不代表沒有/.test(R.gap || ''), R.gap);
    ok('⑨ 決定性對照:沒有 miss → 沒有那一行', R.gapNone, R.gapNone);
    ok('⑩ 使用者自己點開「再看 N 則」→ 重畫之後還是開著', R.moreKept, R.moreKept);
    ok('⑩ 決定性對照:沒點過的「其他公告」重畫後關著', R.otherClosed, R.otherClosed);
    ok('⑪ 390px:容器 358px、全部展開也沒有元素超出', R.w390.boxW >= 350 && R.w390.over <= 2, JSON.stringify(R.w390));
    ok('⑫ 無 pageerror', !errs.length, errs.join(' | '));
} finally {
    await browser.close();
    fs.unlinkSync(TMP);
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
