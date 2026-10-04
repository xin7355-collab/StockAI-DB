// 🧹 V78.1.1 設定瘦身 + 🅿️ 停車 0050 + 📊 機率放顯眼(使用者:「先清洗設定、沒用的刪除;高檔飆股+0050 停車加在隱藏進階選項;
//    設定重新排序瘦身;新增預判上漲下跌的機率」)
//   ⛔ 這支釘的用意:
//     ① 三件刪掉的⛔ 不可復活(預測歷史快照 / 朱家泓 5MA 早上推播 / 本地 API 伺服器),而且 JS 端也不再讀它們
//     ② 搬家⛔ 不可弄丟任何設定:原本的 input / select id 全部還在設定 modal 裡
//     ③ 常用四件(我的策略 / 出場 / 手續費+本金 / 字體)在摺疊外;其餘四組 details 預設收起來,summary 寫現況
//     ④ 🅿️ 只在解鎖時出現;選了它 _strat() 仍是 'gene'(選股 / 出場 / 提醒 / Telegram 全部同 🔥),決策台多一行停車金額
//        ⭐ 決定性對照:帳戶本金 / 持股一改,停車金額要跟著變;收起進階選項就改回 🔥
//     ⑤ 機率:個股頁頂端一行 = _probBox(chip),總覽不再重複;成交額前 100 那一組的「明天」用 amt1 那一列(決定性對照)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const stripC = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n').replace(/<!--[\s\S]*?-->/g, '');
const CODE = stripC(HTML);

// ── ① 刪掉的三件 ──
ok('①a 預測歷史快照⛔ 不可復活(UI 與三支函式)', !/predHistSummary|exportPredHist|clearPredHist|_renderPredHistSummary/.test(CODE));
ok('①b 朱家泓 5MA 早上推播的開關⛔ 不可復活', !/set_chuMorningPush/.test(CODE));
ok('①c Telegram 同步一律送 chuMorningPush:false', /chuMorningPush:\s*false/.test(CODE) && !/chuMorningPush:\s*app\.settings/.test(CODE));
ok('①d worker 排程⛔ 不再呼叫早上 5MA 掃描', !/ctx\.waitUntil\(runMonitorChuMorningScan/.test(stripC(W)));
ok('①e 本地 API 伺服器⛔ 不可復活,_apiBase 也不再讀 settings.localApiUrl', !/set_localApiUrl/.test(CODE) && !/settings\.localApiUrl/.test(CODE));

// ── 抽出設定 modal ──
const a = HTML.indexOf('<div id="settingsModal"'), b = HTML.indexOf('<!-- V19.5 — 結束 flex-1 overflow-y-auto 滾動區 -->', a);
const M = HTML.slice(a, b);
ok('② 抓得到設定 modal(空過守門)', a > 0 && b > a && M.length > 20000, M.length);
const MUST = ['set_bearGate', 'set_geneRank', 'set_backupPwd', 'set_aiEngine', 'set_freeAiEngine', 'set_feeDiscount', 'set_accountSize', 'set_riskPct',
    'set_liveBtc', 'set_liveTwIndex', 'set_massiveKey', 'set_workerUrl', 'set_botUsername', 'set_tgLevel', 'set_voiceAlert', 'set_watchlistAlert',
    'set_alertStrict', 'stratBox', 'deckShowBox', 'alertCatBox', 'set_riskAlertThreshold', 'pushSubscribeBtn', 'aiKeyStatsBox',
    'keyRows_groq', 'keyRows_openrouter', 'keyRows_gemini', 'keyRows_fugle', 'keyRows_finmind', 'exitRuleBtns', 'fontSizeBtns', 'tgCloudBindBtn', 'exportAreaContainer'];
const miss = MUST.filter(id => !M.includes(`id="${id}"`));
ok('②b 搬家⛔ 不可弄丟設定:原本的 ' + MUST.length + ' 個 id 都還在', !miss.length, miss);

// ── ③④⑤ 執行期 ──
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && app._park && app._probBox && app._PROB_TABLE, null, { timeout: 60000 });
const R = await page.evaluate(async () => {
    const o = {};
    app.openSettings();
    const modal = document.getElementById('settingsModal');
    const grps = [...modal.querySelectorAll('details[data-setgrp]')];
    o.grps = grps.map(d => d.getAttribute('data-setgrp'));
    o.grpOpen = grps.filter(d => d.open).length;
    o.grpSum = grps.map(d => (d.querySelector('summary')?.innerText || '').replace(/\s+/g, ' '));
    const inGrp = id => { const el = document.getElementById(id); return !!(el && el.closest('details[data-setgrp]')); };
    o.commonOut = ['stratBox', 'exitRuleBtns', 'set_feeDiscount', 'set_accountSize', 'fontSizeBtns'].map(id => [id, inGrp(id)]);
    o.restIn = ['set_aiEngine', 'set_watchlistAlert', 'aiKeyStatsBox', 'set_backupPwd', 'deckShowBox', 'keyRows_fugle'].map(id => [id, inGrp(id)]);
    // 第一眼字數(details 收著 → innerText 讀不到裡面)
    const sc = modal.querySelector('.overflow-y-auto');
    o.firstGlance = (sc ? sc.innerText : '').replace(/\s/g, '').length;
    // 常用四件的順序:我的策略 → 出場 → 手續費 → 字體
    const pos = id => { const el = document.getElementById(id); return el ? [...sc.querySelectorAll('*')].indexOf(el) : -1; };
    o.order = ['stratBox', 'exitRuleBtns', 'set_feeDiscount', 'fontSizeBtns'].map(pos);
    // ④ 🅿️
    app.settings.stratUnlock = false; app.settings.strategy = 'gene'; app._renderStratBox();
    const sbx = document.getElementById('stratBox');
    o.optsLocked = [...sbx.querySelectorAll('[data-stratopt]')].map(x => x.getAttribute('data-stratopt'));
    app.settings.strategy = 'park'; o.parkLocked = [app._park(), app._strat()];
    app.settings.stratUnlock = true; app._renderStratBox();
    o.optsUnlocked = [...sbx.querySelectorAll('[data-stratopt]')].map(x => x.getAttribute('data-stratopt'));
    app.setStrategy('park');
    o.parkOn = [app._park(), app._strat(), app._isLead(), app._stratKey()];
    o.parkChecked = !!sbx.querySelector('[data-stratopt="park"] input:checked');
    app.settings.accountSize = 1000000;
    app.inventory = [{ symbol: '2330', shares: 0.2, cost: 1000, currentPrice: 1500 }, { symbol: '0050', shares: 2, cost: 150, currentPrice: 200 }];
    const h1 = app._parkAmountHtml(); o.parkH1 = h1;
    app.inventory[0].currentPrice = 2000;
    o.parkH2 = app._parkAmountHtml();
    app.settings.accountSize = 0; o.parkNoAcc = app._parkAmountHtml();
    app.settings.accountSize = 1000000;
    app.setStrategy('gene'); o.geneAmt = app._parkAmountHtml();
    app.setStrategy('park');
    // 收起進階 → 改回 🔥
    for (let i = 0; i < 5; i++) app._verTap(); await new Promise(r => setTimeout(r, 800));
    o.afterLock = [app.settings.stratUnlock, app.settings.strategy, app._park()];
    // ⑤ 機率 chip
    const mk = n => { const a = []; let p = 100; for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 7) * 0.01 + 0.0006; const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10); a.push({ date: d, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 }); } return a; };
    const data = mk(400);
    const T = app._PROB_TABLE;
    o.hasAmt1 = !!(T.amt1 && Object.keys(T.amt1).length);
    app._scrData = { data_date: 'x', cols: ['amt20', 'etf'], rows: { '9999': [1, 0] } };
    app._amtTopKey = null;
    const f = app._probFeatures(data);
    o.cell = f && f.cell;
    o.chipOff = app._probBox('9999', { mode: 'chip', data });
    // 決定性對照:把這一格的 amt1 改成不可能巧合的數字 → 成交額前 100 時「明天」要換成它
    const keep = T.amt1; T.amt1 = Object.assign({}, keep || {});
    const row0 = (T.cells[f.cell] || [])[0]; T.amt1[f.cell] = row0 ? row0.map((v, i) => (i === 1 ? 77.7 : i === 2 ? 11.1 : i === 3 ? 11.2 : v)) : null;
    o.chipOn = app._probBox('9999', { mode: 'chip', data });
    app._scrData = { data_date: 'y', cols: ['amt20', 'etf'], rows: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [String(1000 + i), [500 - i, 0]]).concat([['9999', [0.1, 0]]])) };
    o.chipNotTop = app._probBox('9999', { mode: 'chip', data });
    o.full = app._probBox('9999', { mode: 'full', data });
    T.amt1 = keep;
    // 頂端那一行:綁 sym
    // 📊 V78.4.3 頂端那一行搬進總覽(#ovProbBox,圖)—— 一樣綁 sym
    app.currentSymbolId = '9999'; app.rawDailyData = data; app._renderOvProb('9999');
    const q = document.getElementById('ovProbBox');
    o.qp = [q.classList.contains('hidden'), q.innerText];
    app._renderOvProb('1234');   // 不是目前這一檔 → 清掉
    o.qpOther = [q.classList.contains('hidden'), q.innerHTML];
    o.ovNoDup = !document.getElementById('quoteProbLine') && !/mode: 'line'/.test(app._renderOvCommand.toString());
    return o;
});
await browser.close();

ok('③a 四組收起來的設定:通知 / 金鑰 / 備份 / 工具', JSON.stringify(R.grps) === JSON.stringify(['notify', 'keys', 'backup', 'tools']), R.grps);
ok('③b 四組預設都收著', R.grpOpen === 0, R.grpOpen);
ok('③c 每一組 summary 都寫一行現況(⛔ 收起來 ≠ 看不到)', R.grpSum.every(t => t.length > 12) && /Telegram/.test(R.grpSum[0]) && /Fugle \d+ 把/.test(R.grpSum[1]), R.grpSum);
ok('③d 常用四件在摺疊外', R.commonOut.every(x => x[1] === false), R.commonOut);
ok('③e 其他的都收進四組', R.restIn.every(x => x[1] === true), R.restIn);
ok('③f 常用順序:我的策略 → 出場 → 手續費/本金 → 字體', R.order.every(x => x >= 0) && R.order.every((x, i) => i === 0 || x > R.order[i - 1]), R.order);
ok(`③g 第一眼字數有上限(實測 ${R.firstGlance},上限 1600;改版前 6,670)`, R.firstGlance > 300 && R.firstGlance <= 1600, R.firstGlance);
ok('④a 沒解鎖:只有 🔥 一個選項', JSON.stringify(R.optsLocked) === '["gene"]', R.optsLocked);
ok('④b 沒解鎖時就算存著 park 也當 🔥(_park false)', R.parkLocked[0] === false && R.parkLocked[1] === 'gene', R.parkLocked);
// 🏆 V78.1.9 解鎖後四個、照實測由強到弱(16 年中位):👑+停車 → 👑 錢放現金 → 🅿️ → 🔥
ok('④c 解鎖後:四個、照實測由強到弱排', JSON.stringify(R.optsUnlocked) === '["leadpark","lead","park","gene"]', R.optsUnlocked);
ok('④d 選 🅿️:_strat() 仍是 gene(選股/出場/提醒/Telegram 同 🔥)', R.parkOn[0] === true && R.parkOn[1] === 'gene' && R.parkOn[2] === false && R.parkOn[3] === 'park' && R.parkChecked, R.parkOn);
const wanOf = h => (h.match(/該停在 0050 約 <b[^>]*>([\d.,]+) 萬/) || [])[1];
ok('④e 停車金額 = 帳戶 − 個股市值(100 萬 − 30 萬 = 70 萬)', wanOf(R.parkH1) === '70', wanOf(R.parkH1));
ok('④f ⭐ 決定性對照:個股漲了 → 停車金額跟著變(100 − 40 = 60 萬)', wanOf(R.parkH2) === '60', wanOf(R.parkH2));
ok('④g 說明「自動下單不會幫你做」', /自動下單不會幫你做/.test(R.parkH1));
ok('④h 沒填本金 → 叫你去填,⛔ 不編金額', /帳戶總資金/.test(R.parkNoAcc) && !wanOf(R.parkNoAcc), R.parkNoAcc.slice(0, 120));
ok('④i 🔥 時沒有停車那一行', R.geneAmt === '');
ok('④j 收起進階選項 → 改回 🔥', R.afterLock[0] === false && R.afterLock[1] === 'gene' && R.afterLock[2] === false, R.afterLock);
ok('⑤a _PROB_TABLE 有成交額前 100 那一組(amt1)', R.hasAmt1);
ok('⑤b chip 一行:明天 + 20 天 + 全市場基準 + 贏大盤', /明天/.test(R.chipOff) && /20 天/.test(R.chipOff) && /全市場/.test(R.chipOff) && /贏大盤/.test(R.chipOff), R.chipOff.slice(0, 200));
ok('⑤c ⭐ 決定性對照:前 100 大時「明天」換成 amt1 那一列(漲 77.7)、還標 💰', /漲 77\.7/.test(R.chipOn) && /💰/.test(R.chipOn), R.chipOn.slice(0, 200));
ok('⑤d 不在前 100 大 → ⛔ 不可用 amt1', !/77\.7/.test(R.chipNotTop) && !/💰/.test(R.chipNotTop));
ok('⑤e 總覽機率圖有內容、而且綁 sym(換別檔就清掉)(V78.4.3 從頂端搬進總覽)', R.qp[0] === false && /明天/.test(R.qp[1]) && R.qpOther[0] === true && R.qpOther[1] === '', R.qp);
ok('⑤f 頂端那一行已拿掉、總覽⛔ 不再印第二份', R.ovNoDup);
ok('⑤g 燈號鐵則:機率那一行⛔ 不用 🔴🟢', !/[🔴🟢]/u.test(R.chipOff + R.chipOn));
ok('⓪ 無 pageerror', !errs.length, errs.join(' | '));
console.log(fails.length ? `\n❌ test_settings_slim 失敗 ${fails.length} 條` : '\n✅ test_settings_slim 全部通過');
process.exit(fails.length ? 1 : 0);
