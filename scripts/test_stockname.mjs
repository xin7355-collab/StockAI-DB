#!/usr/bin/env node
/**
 * 🏷️ V75.1.4 股名多層來源 + 「代號不可印兩次」
 *
 * 使用者截圖:庫存頁四檔(009816 / 5483 / 0050 / 2327)名字**全部變成代號**,
 * 而且大字與小字印的是同一個代號。連 0050 都沒名字 → 整份清單是空的。
 *
 * 🚨 根因鏈(逐行查證):
 *   ① `allStockList` 是全 App 唯一股名來源(初始 [])
 *   ② `fetchStockList` 打 FinMind,🚨 **URL 沒帶 token=**;而 safeFetch 的輪動注入條件是
 *      `/[?&]token=/.test(url)` → **輪動器不會幫它補**,永遠匿名發出
 *   ③ 抓失敗 + cache 空 → **函式靜默結束**(無 toast / 無 console)
 *   ④ `getStockName` 查不到 → 回代號本身 → 名字列與代號列各印一次
 *   ⑤ 🚨 連帶:`_filterStockList` 清單空就 `return []` → **搜尋整個失效**,而使用者還沒發現
 *
 * ⛔ 釘死七件事:
 *   ① 離線表(`data/stock_names.json`)是**第一順位**,⛔ 不可退回只靠 FinMind
 *   ② 離線表 <500 檔 → ⛔ 不採用(半份表比沒有更糟)
 *   ③ FinMind 那支 URL **一定要帶 token**(這正是本次的 bug)
 *   ④ 🚨 名字拿不到時**代號⛔ 不可印兩次**(`_nmDual` 的 sub 要空)
 *   ⑤ 🚨 三層全落空 ⛔ 不可靜默 —— 要有警告 + 一鍵重試
 *   ⑥ 🚨 警告必須講出「**搜尋也會失效**」(那才是使用者真正會卡住的地方)
 *   ⑦ 空庫存 / 空自選那條路**也要**顯示警告(那正是要新增持股的時候)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails++; };

// ═══════════ 靜態:抓「又寫回裸呼」的回頭路 ═══════════
// ⚠️ 掃描前先剝註解 —— 本專案已踩 16 次「說明 bug 的註解本身含被禁的字串」
// 🚨 但 `\/\/[^\n]*` 會**誤傷 URL**:`https://api.finmindtrade.com` 的 `//` 也被當成註解起點,
//    整個網址被剝掉 → 「FinMind 有沒有帶 token」那條斷言會拿到 -1,看起來像程式沒改到。
//    ⭐ 這次就是這樣浪費了一輪 → 用 lookbehind 排除 `:`(協定)與引號內的情況。
const NOCOM = SRC.replace(/(?<![:'"\w])\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const fsl = (NOCOM.match(/async fetchStockList\(\)[\s\S]{0,3200}?\n    \},/) || [''])[0];
ok('① 離線表是第一順位(在 FinMind 之前)',
    fsl.indexOf('_fetchNameTable') > 0 && fsl.indexOf('_fetchNameTable') < fsl.indexOf('finmindtrade'),
    `off=${fsl.indexOf('_fetchNameTable')} fm=${fsl.indexOf('finmindtrade')}`);
// 🚧 取樣守門要驗「兩個關鍵字都在」,⛔ 不可只驗長度 ——
//    取樣壞掉時長度照樣夠,而 ① 會給出「順序錯了」這種誤導的失敗訊息(本輪實際踩到)。
ok('①b 取樣守門:抓到的區塊同時含離線表與 FinMind',
    fsl.length > 800 && fsl.includes('_fetchNameTable') && fsl.includes('finmindtrade'),
    `len=${fsl.length} off=${fsl.includes('_fetchNameTable')} fm=${fsl.includes('finmindtrade')}`);

const nt = (NOCOM.match(/async _fetchNameTable\(\)[\s\S]{0,2000}?\n    \},/) || [''])[0];
ok('② 離線表 <500 檔不採用', /out\.length\s*<\s*500/.test(nt), nt.slice(0, 160));
ok('②b 用動態 ghBase + ?t=(⛔ 不可硬編碼路徑)',
    /window\.location\.href\.split/.test(nt) && /\?t=\$\{Date\.now\(\)\}/.test(nt));

ok('③ 🚨 FinMind URL 一定要帶 token(本次的 bug)',
    /_getFinmindToken\(\)/.test(fsl) && /token=\$\{_tk\}/.test(fsl), fsl.slice(0, 200));

ok('⑤ 三層全落空 ⛔ 不可靜默(要留旗標 + console)',
    /_nameSrc\s*=\s*'fail'/.test(fsl) && /console\.warn/.test(fsl));

// ⛔ 六個「名字列 + 代號列」的顯示點都要走 _nmDual,不可再裸呼
ok('④b 庫存/自選六處都改吃 _nd.sub / _nmDual(sym).sub',
    (NOCOM.match(/\$\{_nd\.sub\}/g) || []).length === 4
    && (NOCOM.match(/_nmDual\(sym\)\.sub/g) || []).length === 2,
    `_nd.sub=${(NOCOM.match(/\$\{_nd\.sub\}/g) || []).length} sym.sub=${(NOCOM.match(/_nmDual\(sym\)\.sub/g) || []).length}`);
ok('④c ⛔ 不可再有「名字列+代號列」裸印 item.symbol 的寫法',
    !/text-gray-500 font-mono">\$\{item\.symbol\}<\/span>/.test(NOCOM));

// ═══════════ 動態 ═══════════
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const o = {};

    // ── ④ 核心:名字拿不到時,代號⛔ 不可印兩次 ──
    A.allStockList = [];
    const d0 = A._nmDual('009816');
    o.dualNoName = { n: d0.n, sub: d0.sub };

    A.allStockList = [{ stock_id: '2330', stock_name: '台積電', industry_category: '半導體業' }];
    const d1 = A._nmDual('2330');
    o.dualHasName = { n: d1.n, sub: d1.sub };

    // ── ④d 真的渲染一次庫存頁,斷言畫面上代號沒有出現兩次 ──
    A.allStockList = [];
    A._nameSrc = 'fail';
    A.inventory = [{ symbol: '009816', cost: 13.5, shares: 11, buyDate: '2026-01-02' }];
    try { A.renderInventory(); } catch (e) { o.invErr = String(e).slice(0, 120); }
    const cont = document.getElementById('inventoryCardContainer');
    const txt = cont ? cont.innerText.replace(/\s+/g, ' ') : '';
    o.invTxt = txt.slice(0, 300);
    o.codeCount = (txt.match(/009816/g) || []).length;
    o.hasWarn = /股票名稱清單沒有載入成功/.test(txt);
    o.warnSaysSearch = /搜尋股票會打不出東西/.test(txt);
    o.hasRetryBtn = !!cont?.querySelector('button[onclick*="retryStockNames"]');

    // ── ⑦ 空庫存那條路也要有警告 ──
    A.inventory = [];
    try { A.renderInventory(); } catch (_) {}
    o.emptyInvWarn = /股票名稱清單沒有載入成功/.test(cont ? cont.innerText : '');

    // ── ⑤b 名字正常時,警告⛔ 不可出現(天天掛著會讓人養成忽略的習慣) ──
    A.allStockList = [{ stock_id: '009816', stock_name: '統一台股增長', industry_category: '' }];
    A._nameSrc = 'offline';
    A.inventory = [{ symbol: '009816', cost: 13.5, shares: 11, buyDate: '2026-01-02' }];
    try { A.renderInventory(); } catch (_) {}
    const t2 = cont ? cont.innerText.replace(/\s+/g, ' ') : '';
    o.okTxt = t2.slice(0, 200);
    o.okNoWarn = !/股票名稱清單沒有載入成功/.test(t2);
    o.okHasName = /統一台股增長/.test(t2);
    o.okCodeOnce = (t2.match(/009816/g) || []).length;

    // ── ② 離線表守門:半份表不可採用 ──
    const realFetch = window.fetch;
    window.fetch = async (u) => {
        if (String(u).includes('stock_names.json')) {
            const names = {}; for (let i = 0; i < 100; i++) names['A' + i] = ['名' + i, ''];
            return { ok: true, json: async () => ({ updated: 'x', names }) };
        }
        return realFetch(u);
    };
    o.tooSmall = await A._fetchNameTable();

    // 足量 → 要採用,而且形狀要對(⛔ 不可改壞既有 19+6+5 個欄位讀取點)
    window.fetch = async (u) => {
        if (String(u).includes('stock_names.json')) {
            const names = { '2330': ['台積電', '半導體業'], '0050': ['元大台灣50', ''] };
            for (let i = 0; i < 600; i++) names['B' + i] = ['名' + i, ''];
            return { ok: true, json: async () => ({ updated: '2026-09-09', names }) };
        }
        return realFetch(u);
    };
    const big = await A._fetchNameTable();
    o.bigLen = big ? big.length : 0;
    o.bigShape = big ? big.find(x => x.stock_id === '2330') : null;
    window.fetch = realFetch;
    return o;
});
// ══════════════════════════════════════════════════════════════════════════
// 🏷️ V75.3.3 「卡在哪一層」要說得出來 + 自己那幾檔的名字備援
// ──────────────────────────────────────────────────────────────────────────
// 使用者截圖:庫存四檔全變代號、警語卡掛著,而**三層全是靜默的** → 我這邊查不出卡在哪
// (陷阱 #22)。⭐ 決定性對照組:同一支程式,只換「這一層怎麼失敗」,原因字串必須不同。
{
    const probe = async (mode) => await page.evaluate(async (m) => {
        const A = app;
        A.allStockList = []; A._nameSrc = null; A._nameWhy = [];
        try { localStorage.removeItem('proTerm_stockList'); localStorage.removeItem('proTerm_stockList_at'); } catch (_) {}
        const realFetch = window.fetch;
        window.fetch = async (u, o) => {
            const url = String(u);
            if (/stock_names\.json/.test(url)) {
                if (m === 'http500') return new Response('x', { status: 500 });
                if (m === 'thin') return new Response(JSON.stringify({ names: { '1101': ['台泥', '01'] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                if (m === 'boom') throw new TypeError('Load failed');
            }
            if (/finmindtrade/.test(url)) return new Response(JSON.stringify({ msg: 'token不合法' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            return realFetch(u, o);
        };
        try { await A.fetchStockList(); } catch (_) {}
        window.fetch = realFetch;
        return { why: (A._nameWhy || []).join(' → '), src: A._nameSrc, warn: A._nameWarnHtml() };
    }, mode);

    const a = await probe('http500'), b = await probe('thin'), c = await probe('boom');
    ok('🏷️b1 離線表 HTTP 失敗 → 原因要寫出狀態碼', /離線表 HTTP 500/.test(a.why), a.why);
    ok('🏷️b2 離線表**筆數不足** → 原因要寫出實際筆數(⛔ 不可跟 HTTP 失敗同一句)',
       /只有 1 檔/.test(b.why) && b.why !== a.why, `${b.why} ｜ ${a.why}`);
    ok('🏷️b3 fetch 直接爆掉 → 原因要帶例外訊息', /離線表讀不到/.test(c.why) && /Load failed|TypeError/.test(c.why), c.why);
    ok('🏷️b4 FinMind 那一層失敗也要留原因(⛔ 三層不可有任何一層是靜默的)', /FinMind/.test(a.why), a.why);
    ok('🏷️c 警語卡要**印出原因**(⛔ 不可留白)', /卡在哪一層/.test(a.warn) && a.warn.includes(a.why.slice(0, 12)), a.warn.slice(0, 300));

    const diag = await page.evaluate(() => {
        app._nameWhy = ['離線表 HTTP 500'];
        app.settings = Object.assign({}, app.settings, { finmindToken: 'SECRET-TOKEN-1234567890' });
        let cap = ''; const w = navigator.clipboard && navigator.clipboard.writeText;
        try { navigator.clipboard.writeText = async t => { cap = t; }; } catch (_) {}
        app.copyNameDiag();
        try { if (w) navigator.clipboard.writeText = w; } catch (_) {}
        return cap;
    });
    ok('🏷️d1 診斷文字有內容且含「卡在哪一層」', diag.length > 40 && /卡在哪一層/.test(diag), diag.slice(0, 200));
    ok('🏷️d2 🔐 診斷文字⛔ 不可含金鑰本身,只寫有填/沒填',
       !/SECRET-TOKEN/.test(diag) && /金鑰:(有填|沒填)/.test(diag), diag);

    // ⭐ 自己那幾檔的名字備援:全市場清單被清空後仍要查得到
    const mine = await page.evaluate(() => {
        const A = app;
        A.allStockList = [{ stock_id: '5483', stock_name: '中美晶', industry_category: '24' }];
        A.inventory = [{ symbol: '5483' }];
        A._myNames = null; try { localStorage.removeItem('proTerm_myNames'); } catch (_) {}
        A._saveMyNames();
        A.allStockList = []; A._myNames = null;              // ← 只換這一個維度:清單不見了
        return { after: A.getStockName('5483'), miss: A.getStockName('9999') };
    });
    ok('🏷️e ⭐⭐ 全市場清單不見了,自己庫存那幾檔仍要有名字(只換「清單在不在」一個維度)',
       mine.after === '中美晶', JSON.stringify(mine));
    ok('🏷️e2 沒存過的仍照舊回代號(⛔ 不可亂編名字)', mine.miss === '9999', JSON.stringify(mine));
}

await browser.close();

ok('④ 🚨 名字拿不到 → sub 要空(⛔ 代號不可印兩次)',
    R.dualNoName.n === '009816' && R.dualNoName.sub === '', JSON.stringify(R.dualNoName));
ok('④a 名字拿得到 → n=名字 / sub=代號',
    R.dualHasName.n === '台積電' && R.dualHasName.sub === '2330', JSON.stringify(R.dualHasName));
ok('④d 🚨 實際渲染:代號只出現 1 次(⛔ 不是 2 次)',
    R.codeCount === 1, `出現 ${R.codeCount} 次 ・${R.invTxt}`);
ok('⑤ 名字載不到 → 要有警告(⛔ 不可靜默)', R.hasWarn, R.invTxt);
ok('⑥ 🚨 警告必須講出「搜尋也會失效」', R.warnSaysSearch, R.invTxt);
ok('⑤a 要有一鍵重試', R.hasRetryBtn);
ok('⑦ 空庫存那條路也要有警告(那時正要新增持股)', R.emptyInvWarn);
ok('⑤b 名字正常時 ⛔ 不可出現警告', R.okNoWarn, R.okTxt);
ok('⑤c 名字正常時要顯示中文名、代號仍只出現 1 次',
    R.okHasName && R.okCodeOnce === 1, `name=${R.okHasName} code=${R.okCodeOnce} ・${R.okTxt}`);
ok('② 離線表只有 100 檔 → ⛔ 不採用(回 null)', R.tooSmall === null, String(R.tooSmall));
ok('②c 足量 → 採用,且形狀是 {stock_id, stock_name, industry_category}',
    R.bigLen > 500 && R.bigShape && R.bigShape.stock_name === '台積電'
    && R.bigShape.industry_category === '半導體業',
    `len=${R.bigLen} shape=${JSON.stringify(R.bigShape)}`);

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
