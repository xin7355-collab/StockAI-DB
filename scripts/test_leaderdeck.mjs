#!/usr/bin/env node
/**
 * 👑 V77.8.8 決策台「領頭羊短線輪動」守門(第二套,⛔ 不換預設)
 *   ① 純函式 `_leaderCalc`:池子 = amt20 前 U(⛔ 不是今天的 amt)、不含 ETF、趨勢過濾用 b20 > 0 且 b20 < b60(⇔ c > ma20 > ma60)、
 *      排名 = chg10、前 N 買、前 2N 續抱;欄位缺 → 'notyet'(⛔ 不可拿 chg5/chg20 湊)
 *   ② `_leaderClock`:開始那天第 1 天、每 R 個交易日換倉(用 ^TWII 日期數)
 *   ③ 畫面:數字讀 `_LEADER_EDGE`(⭐ 決定性對照)、空頭時買鈕變「空頭不買」但名單照列、持股掉出前 2N 標賣、⛔ 無 🔴🟢、390px 不橫捲
 *   ④ 採礦:screener_miner COLS 有 chg10 / amt20
 * 注入(逐一確認會紅):池子改用 amt / 趨勢過濾拿掉 / 排名改 chg20 / 空頭照樣「🛒 買」/ 實測數字寫死 / 換倉日算錯
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PY = fs.readFileSync(path.join(ROOT, 'screener_miner.py'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

ok('④ screener_miner COLS 有 chg10 與 amt20', /'chg10',/.test(PY) && /'amt20',/.test(PY) && /\('chg10', 10\)/.test(PY) && /CI\['amt20'\]\] = rd\(sum\(cl\[i\] \* vo\[i\]/.test(PY));
ok('④b index.html 的常數不寫死在文案:實測數字只出現在 `_LEADER_EDGE`', (SRC.match(/3176|3,176/g) || []).length <= 2 && /_LEADER_EDGE: \{/.test(SRC), (SRC.match(/3176|3,176/g) || []).length);
ok('④c auto_trade.py ⛔ 沒有接領頭羊', !/leader|領頭羊/i.test(fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8')));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leaderCalc === 'function', null, { timeout: 60000 });   // 陷阱 #5:app 不掛 window

const R = await page.evaluate(async () => {
    const out = {};
    // 合成 screener:120 檔;amt20 越前面越大;今天的 amt 故意反過來(池子若用 amt 會選錯)
    const cols = ['c', 'chg', 'chg5', 'chg10', 'chg20', 'amt', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf'];
    const rows = {};
    for (let i = 0; i < 120; i++) {
        const sym = String(1000 + i);
        const amt20 = 200 - i, amt = i;                             // 池子(前 100)= 1000~1099;amt 反向
        const chg10 = i < 100 ? (i % 2 ? 30 - i * 0.2 : -5) : 99;  // 池子外(1100~1119)chg10 最高 → 排名若不限池子會選到它們
        const chg20 = 100 - i;                                     // 排名若用 chg20 會選到 1000
        const b20 = i % 2 ? 3 : -3, b60 = i % 2 ? 8 : 1;           // 奇數 = 過趨勢(b20>0 且 b20<b60)
        rows[sym] = [100, 1, 1, chg10, chg20, amt, amt20, b20, b60, 0, 0, 0];
    }
    rows['0050'] = [100, 1, 1, 50, 50, 999, 999, 5, 9, 0, 0, 1];   // ETF 高成交額 ⛔ 不可進池子
    const D = { data_date: '2026-09-28', cols, rows };
    const L = app._leaderCalc(D);
    out.n = L.n; out.poolHas0050 = L.poolSet.has('0050'); out.poolHas1100 = L.poolSet.has('1100'); out.poolHas1000 = L.poolSet.has('1000');
    out.buy = L.buy.map(r => r.sym); out.ranked = L.ranked.length; out.passed = L.passed;
    out.notyet = app._leaderCalc({ data_date: 'x', cols: cols.filter(c => c !== 'chg10'), rows }).err;
    // 決定性對照:把 1001 的 b60 改成比 b20 小(ma20 < ma60)→ 它必須被濾掉
    const D2 = JSON.parse(JSON.stringify(D)); D2.rows['1001'][8] = 1; out.filteredOut = !app._leaderCalc(D2).all.has('1001');
    // 時鐘
    const tw = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'].map(d => ({ date: d }));
    out.c1 = app._leaderClock(tw, '2026-09-21', '2026-09-21'); out.c5 = app._leaderClock(tw, '2026-09-25', '2026-09-21'); out.c11 = app._leaderClock(tw, '2026-10-05', '2026-09-21'); out.c0 = app._leaderClock(tw, '2026-09-25', null);
    // 畫面:注入 screener + 空頭 + 庫存
    app._scrData = D; app._loadScreener = async () => D; app._getTwiiRows = async () => tw;
    app.inventory = [{ symbol: '1001', cost: 100 }, { symbol: '1041', cost: 100 }, { symbol: '1000', cost: 100 }, { symbol: '2330', cost: 100 }];
    localStorage.setItem('proTerm_leaderStart', JSON.stringify({ d: '2026-09-21' }));
    app._mktBear60 = async () => ({ on: false, c: 1, ma20: 1, ma60: 1 });
    const host = document.createElement('div'); host.style.width = '358px'; document.body.appendChild(host);
    host.innerHTML = await app._leaderDeckHtml();
    out.txt = host.innerText; out.rows = [...host.querySelectorAll('[data-leaderrow]')].map(e => e.dataset.leaderrow);
    out.held = Object.fromEntries([...host.querySelectorAll('[data-leaderheld]')].map(e => [e.dataset.leaderheld, e.dataset.leaderkeep]));
    out.buyBtns = (host.innerText.match(/🛒 買/g) || []).length;
    // 決定性對照:實測數字讀常數
    const keep = app._LEADER_EDGE.ai.tot; app._LEADER_EDGE.ai.tot = 4321; host.innerHTML = await app._leaderDeckHtml(); out.constTxt = host.innerText; app._LEADER_EDGE.ai.tot = keep;
    // 空頭
    app._mktBear60 = async () => ({ on: true, c: 100, ma20: 105, ma60: 110 }); host.innerHTML = await app._leaderDeckHtml(); out.bearTxt = host.innerText; out.bearRows = host.querySelectorAll('[data-leaderrow]').length;
    window.scrollTo(80, 0); out.sx = window.scrollX;
    out.over = [...host.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > host.getBoundingClientRect().right + 1; }).length;
    return out;
});
ok('① 池子 = amt20 前 100(⛔ 不是今天的 amt)、不含 ETF', R.n === 100 && !R.poolHas0050 && !R.poolHas1100 && R.poolHas1000, JSON.stringify([R.n, R.poolHas0050, R.poolHas1100]));
ok('①b 趨勢過濾:只有 b20 > 0 且 b20 < b60 的過(50 檔)', R.passed === 50, R.passed);
ok('①c 排名 = chg10(前 5 = 1001/1003/1005/1007/1009;⛔ 不是 chg20 那組)', JSON.stringify(R.buy) === JSON.stringify(['1001', '1003', '1005', '1007', '1009']), JSON.stringify(R.buy));
ok('①d 名單列前 2N = 10 檔', R.ranked === 10 && R.rows.length === 10, R.ranked);
ok('①e 欄位缺 → notyet(⛔ 不可拿 chg5/chg20 湊)', R.notyet === 'notyet');
ok('①f ⭐ 決定性對照:把一檔改成 ma20 < ma60 → 被濾掉', R.filteredOut === true);
ok('② 時鐘:開始那天 = 第 1 天且是換倉日;第 5 天還剩 6 天;第 11 天又是換倉日;沒開始 → started false', R.c1.day === 1 && R.c1.isRebal && R.c5.day === 5 && !R.c5.isRebal && R.c5.left === 6 && R.c11.day === 11 && R.c11.isRebal && R.c0.started === false, JSON.stringify([R.c1, R.c5, R.c11, R.c0]));
ok('③ 畫面:前 5 名有 🛒 買、庫存 1001 續抱、1041(第 21 名)掉出前 10 → 賣、1000(沒過趨勢)也標賣、2330 不在池子不列', R.buyBtns === 5 && R.held['1001'] === '1' && R.held['1041'] === '0' && R.held['1000'] === '0' && !('2330' in R.held), JSON.stringify([R.buyBtns, R.held]));
ok('③b ⭐ 決定性對照:實測數字讀 `_LEADER_EDGE`(改成 4321 畫面要跟著變)', /4321/.test(R.constTxt) && !/4321/.test(R.txt));
ok('③c 空頭:名單照列(10 列)、但一個「🛒 買」都沒有、寫「今天不開新倉」', R.bearRows === 10 && !/🛒 買/.test(R.bearTxt) && /今天不開新倉/.test(R.bearTxt) && /空頭不買/.test(R.bearTxt));
ok('③d 一定寫代價:中途最多賠 / 只有 N 年贏 / 別加停利 / 不是決策台預設', /中途最多賠/.test(R.txt) && /年贏 0050/.test(R.txt) && /別加停利/.test(R.txt) && /不是決策台預設/.test(R.txt));
ok('③e ⛔ 無 🔴🟢', !/[🔴🟢]/u.test(R.txt) && !/[🔴🟢]/u.test(R.bearTxt));
ok('③f 390px 不橫捲、不超出', R.sx <= 2 && R.over === 0, `${R.sx} ${R.over}`);
ok('③g 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ LEADERDECK_PASS');
process.exit(fails.length ? 1 : 0);
