#!/usr/bin/env node
/**
 * 👑 V77.8.8 決策台「領頭羊短線輪動」守門(第二套,⛔ 不換預設)
 *   ① 純函式 `_leaderCalc`:池子 = amt20 前 U(⛔ 不是今天的 amt)、不含 ETF、趨勢過濾用 b20 > 0 且 b20 < b60(⇔ c > ma20 > ma60)、
 *      排名 = chg10、前 N 買、前 2N 續抱;欄位缺 → 'notyet'(⛔ 不可拿 chg5/chg20 湊)
 *   ② `_leaderClock`:開始那天第 1 天、每 R 個交易日換倉(用 ^TWII 日期數)
 *   ③ 畫面:數字讀 `_LEADER_EDGE`(⭐ 決定性對照)、空頭時買鈕變「空頭不買」但名單照列、持股掉出前 2N 標賣、⛔ 無 🔴🟢、390px 不橫捲
 *   ④ 採礦:screener_miner COLS 有 chg10 / amt20
 *   ⑤ V77.8.9 自動下單接線:auto_trade.py 的 `leader_calc` / `leader_clock` 是第二份實作 → 規則、錨點、名單、時鐘**跨語言逐項比對**
 *      (合成 screener + 正式網站那一份);⭐ 決定性對照:把 Python 那份改成用 chg20 排 → 名單必須對不上
 * 注入(逐一確認會紅):池子改用 amt / 趨勢過濾拿掉 / 排名改 chg20 / 空頭照樣「🛒 買」/ 實測數字寫死 / 換倉日算錯
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PY = fs.readFileSync(path.join(ROOT, 'screener_miner.py'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

ok('④ screener_miner COLS 有 chg10 與 amt20', /'chg10',/.test(PY) && /'amt20',/.test(PY) && /\('chg10', 10\)/.test(PY) && /CI\['amt20'\]\] = rd\(sum\(cl\[i\] \* vo\[i\]/.test(PY));
const _le0 = SRC.indexOf('_LEADER_EDGE: {'), _le1 = SRC.indexOf('/** 👑 純函式', _le0);
const _outside = SRC.slice(0, _le0) + SRC.slice(_le1);
ok('④b 實測數字只出現在 `_LEADER_EDGE` 裡面(⛔ 文案不可寫死)', _le0 > 0 && _le1 > _le0 && !/3176|3,176|\+760%|\+670%|\+341%/.test(_outside.slice(_outside.indexOf('_leaderCalc(D'), _outside.indexOf('_leaderHelp() {') + 3000)), '');
const _hs = SRC.indexOf('_leaderHelp() {'), _hTxt = SRC.slice(_hs, _hs + 4000);
ok('④c 🗓️ 逐月數字讀 `_LEADER_EDGE.mon`(⛔ 說明不寫死)', /mon: \{ n: \d+, beat: \d+/.test(SRC) && /\$\{E\.mon\.beat\}/.test(_hTxt) && /\$\{E\.mon\.worstAll\}/.test(_hTxt) && !/贏 0050 的月份 53%/.test(_hTxt));
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
const jsRule = (SRC.match(/rule: \{ U: (\d+), N: (\d+), R: (\d+), L: (\d+), hyst: (\d+), pos: (\d+) \}/) || []).slice(1).join(',');
// 👑 V77.9.3 規則 / 錨點搬到 lib_leader.py(auto_trade.py 與成績單的採礦端共用)→ 比對那一份,並釘住 auto_trade 真的用它
const LIBL = fs.readFileSync(path.join(ROOT, 'lib_leader.py'), 'utf8');
const pyRule = (LIBL.match(/LEADER_RULE = \{'U': (\d+), 'N': (\d+), 'R': (\d+), 'L': (\d+), 'hyst': (\d+), 'pos': (\d+)\}/) || []).slice(1).join(',');
ok('⑤ 規則 App == lib_leader.py(U,N,R,L,hyst,pos),auto_trade.py 從它 import', jsRule && jsRule === pyRule && /LEADER_RULE = _LL\.LEADER_RULE/.test(AT), `${jsRule} vs ${pyRule}`);
const jsAnc = (SRC.match(/anchor: '(\d{4}-\d{2}-\d{2})'/) || [])[1], pyAnc = /LEADER_ANCHOR = os\.getenv\('LEADER_ANCHOR'\) or _LL\.LEADER_ANCHOR/.test(AT) ? (LIBL.match(/LEADER_ANCHOR = '(\d{4}-\d{2}-\d{2})'/) || [])[1] : null;
ok('⑤b 換倉錨點 App == auto_trade.py(⛔ 不存在手機上)', jsAnc && jsAnc === pyAnc && !/proTerm_leaderStart/.test(SRC), `${jsAnc} vs ${pyAnc}`);
ok('⑤c 領頭羊預設關(LEADER=1 才開)、⛔ 只動 lead 那一格的部位、空頭只擋買', /LEADER = os\.getenv\('LEADER'\) == '1'/.test(AT) && /held = st\.setdefault\('lead', \{\}\)/.test(AT) && /'lead': st\.get\('lead'\) or \{\}/.test(AT) && /BEAR_GATE and _mkt\.get\('bear60'\) is True:\n\s+log\("   👑 🐻/.test(AT));
ok('⑤d 舊名單⛔ 不下單(用「今天之前最近的交易日」判,不用天數)', /if not dates or dd != prev:/.test(AT));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });   // 🎯 V77.9.6 這支測的是 👑 那一套 → 先切成 👑(🧬 預設另由 test_stratswitch 測)
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leaderCalc === 'function', null, { timeout: 60000 });   // 陷阱 #5:app 不掛 window

const R = await page.evaluate(async () => {
    const out = {};
    // 合成 screener:120 檔;amt20 越前面越大;今天的 amt 故意反過來(池子若用 amt 會選錯)
    const cols = ['c', 'chg', 'chg5', 'chg10', 'chg20', 'amt', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252'];   // 📍 V78.0.5 pos252 全設 95(位置濾網由 ⑩ 單獨測)
    const rows = {};
    for (let i = 0; i < 120; i++) {
        const sym = String(1000 + i);
        const amt20 = 200 - i, amt = i;                             // 池子(前 100)= 1000~1099;amt 反向
        const chg10 = i < 100 ? (i % 2 ? 30 - i * 0.2 : -5) : 99;  // 池子外(1100~1119)chg10 最高 → 排名若不限池子會選到它們
        const chg20 = i;                                           // ⚠️ 必須跟 chg10 反向:排名若用 chg20 會選到 1099/1097…(V77.8.9 前寫成 100 − i,跟 chg10 同向 → ①c 與 ⑤g 都沒有鑑別力)
        const b20 = i % 2 ? 3 : -3, b60 = i % 2 ? 8 : 1;           // 奇數 = 過趨勢(b20>0 且 b20<b60)
        rows[sym] = [100, 1, 1, chg10, chg20, amt, amt20, b20, b60, 0, 0, 0, 95];
    }
    rows['0050'] = [100, 1, 1, 50, 50, 999, 999, 5, 9, 0, 0, 1, 95];   // ETF 高成交額 ⛔ 不可進池子
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
    app._mktBear60 = async () => ({ on: false, c: 1, ma20: 1, ma60: 1 });
    const host = document.createElement('div'); host.style.width = '358px'; document.body.appendChild(host);
    host.innerHTML = await app._leaderDeckHtml();
    out.D = D; out.rankedSyms = L.ranked.map(r => r.sym);
    out.txt = host.innerText; out.rows = [...host.querySelectorAll('[data-leaderrow]')].map(e => e.dataset.leaderrow);
    out.held = Object.fromEntries([...host.querySelectorAll('[data-leaderheld]')].map(e => [e.dataset.leaderheld, e.dataset.leaderkeep]));
    out.buyBtns = (host.innerText.match(/🛒 買/g) || []).length;
    // 👑 V77.9.1 收盤價 + 排序 + 持股標記
    out.close1 = host.querySelector('[data-leaderrow="1001"] [data-leaderclose]')?.textContent || '';
    out.hdr = [...host.querySelectorAll('[data-leadersort]')].map(e => e.dataset.leadersort);
    out.firstDefault = out.rows[0];
    app._leaderSort = { k: 'chg10', asc: true }; host.innerHTML = await app._leaderDeckHtml();
    out.firstAsc = host.querySelector('[data-leaderrow]').dataset.leaderrow; out.ascMark = /10 日▲/.test(host.innerText);
    out.buyAfterSort = (host.innerText.match(/🛒 買/g) || []).length;
    app._leaderSort = null;
    localStorage.removeItem('leaderMine_v1'); host.innerHTML = await app._leaderDeckHtml();
    out.unmarked = host.querySelector('[data-leaderheld="1041"]')?.innerText || '';
    localStorage.setItem('leaderMine_v1', JSON.stringify(['1041'])); host.innerHTML = await app._leaderDeckHtml();
    out.marked = host.querySelector('[data-leaderheld="1041"]')?.innerText || '';
    out.markedMine = host.querySelector('[data-leaderheld="1041"]')?.dataset.leadermine;
    localStorage.removeItem('leaderMine_v1'); host.innerHTML = await app._leaderDeckHtml();
    // 注意 / 處置:把 1003 標成處置
    D.rows['1003'][10] = 2; host.innerHTML = await app._leaderDeckHtml(); out.attTxt = host.innerText; D.rows['1003'][10] = 0;
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
ok('② 時鐘:起點那天 = 第 1 天且是換倉日;第 5 天還剩 6 天;第 11 天又是換倉日;沒傳起點 → 用共用錨點(09-24 起,09-25 是第 2 天)', R.c1.day === 1 && R.c1.isRebal && R.c5.day === 5 && !R.c5.isRebal && R.c5.left === 6 && R.c11.day === 11 && R.c11.isRebal && R.c0.day === 2 && !R.c0.isRebal, JSON.stringify([R.c1, R.c5, R.c11, R.c0]));
ok('③ 畫面(V77.9.6 選 👑 → 手上每一檔個股都照這套):前 5 名裡沒有的 4 檔 🛒 買(1001 已有)、1001 續抱、1041(第 21 名)/ 1000(沒過趨勢)/ 2330(池子外)都 keep=0', R.buyBtns === 4 && R.held['1001'] === '1' && R.held['1041'] === '0' && R.held['1000'] === '0' && R.held['2330'] === '0', JSON.stringify([R.buyBtns, R.held]));
ok('③b ⭐ 決定性對照:實測數字讀 `_LEADER_EDGE`(改成 4321 畫面要跟著變)', /4321/.test(R.constTxt) && !/4321/.test(R.txt));
ok('③c 空頭:名單照列(10 列)、但一個「🛒 買」都沒有、寫「今天不開新倉」', R.bearRows === 10 && !/🛒 買/.test(R.bearTxt) && /今天不開新倉/.test(R.bearTxt) && /空頭不買/.test(R.bearTxt));
ok('③d 一定寫代價:中途最多賠 / 只有 N 年贏 + 標明是預設', /中途最多賠/.test(R.txt) && /年贏 0050/.test(R.txt) && /你選的策略/.test(R.txt) && !/預設・實測最強/.test(R.txt));
ok('③i 每一列有收盤價(讀 screener 的 c)', R.close1 === '100.0', R.close1);
ok('③j 表頭可排序:名次/收盤/10 日/今天/億/日 五欄', JSON.stringify(R.hdr) === JSON.stringify(['rank', 'c', 'chg10', 'chg', 'amt20']), JSON.stringify(R.hdr));
ok('③k ⭐ 決定性對照:照 10 日由小到大排 → 第一列換人 + ▲;「🛒 買」仍只有前 5 名(⛔ 動作不跟排序變)', R.firstDefault === '1001' && R.firstAsc !== '1001' && R.ascMark && R.buyAfterSort === 4, JSON.stringify([R.firstDefault, R.firstAsc, R.ascMark, R.buyAfterSort]));
ok('③l ⭐ V77.9.6 ⛔ 不再有「標了才算」:選 👑 時 1041 一律講要賣,舊的 leaderMine_v1 標記有沒有都一樣、也⛔ 沒有標記按鈕', /掉出前 10 名/.test(R.unmarked) && /開盤賣|換倉日再賣/.test(R.unmarked) && R.marked === R.unmarked && !/照這套買的/.test(R.unmarked) && R.markedMine === '1', JSON.stringify([R.unmarked, R.marked]));
ok('③e ⛔ 無 🔴🟢', !/[🔴🟢]/u.test(R.txt) && !/[🔴🟢]/u.test(R.bearTxt));
ok('③f 390px 不橫捲、不超出', R.sx <= 2 && R.over === 0, `${R.sx} ${R.over}`);
ok('③g 無 pageerror', !errs.length, errs.join(' | '));
ok('③h 名單裡有注意 / 處置股 → 寫「不要跳過」+ 實測數字(讀常數)', /不要跳過/.test(R.attTxt) && /\+408%/.test(R.attTxt), R.attTxt.slice(0, 200));

// ⑤ 跨語言:同一份 screener → Python 與 JS 名單逐項相同
const pyRun = (Dpath, mode = '') => JSON.parse(execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import auto_trade as A
D = json.load(open(${JSON.stringify(Dpath)}))
if ${JSON.stringify(mode)} == 'chg20':
    ci = D['cols'].index('chg10'); cj = D['cols'].index('chg20')
    for v in D['rows'].values(): v[ci] = v[cj]
L = A.leader_calc(D)
if L.get('err'): print(json.dumps({'err': L['err']})); sys.exit()
dates = ['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-05','2026-10-06']
print(json.dumps({'buy': [r['sym'] for r in L['buy']], 'ranked': [r['sym'] for r in L['ranked']], 'passed': L['passed'], 'n': L['n'],
  'clk': [A.leader_clock(dates, d, '2026-09-21') for d in ['2026-09-21','2026-09-25','2026-10-05']]}))
`], { encoding: 'utf8' }));
const TMP = '/tmp/_leader_syn.json'; fs.writeFileSync(TMP, JSON.stringify(R.D));
const py = pyRun(TMP);
ok('⑤e 合成 screener:Python == JS(前 5、前 10、過趨勢檔數、池子)', JSON.stringify(py.buy) === JSON.stringify(R.buy) && JSON.stringify(py.ranked) === JSON.stringify(R.rankedSyms) && py.passed === R.passed && py.n === R.n, JSON.stringify([py.buy, R.buy]));
ok('⑤f 時鐘:Python == JS(第 1 / 5 / 11 天)', JSON.stringify(py.clk.map(c => [c[0], c[1]])) === JSON.stringify([[R.c1.day, R.c1.isRebal], [R.c5.day, R.c5.isRebal], [R.c11.day, R.c11.isRebal]]), JSON.stringify(py.clk));
const pyBad = pyRun(TMP, 'chg20');
ok('⑤g ⭐ 決定性對照:Python 那份改用 chg20 排 → 名單必須對不上(比對真的有鑑別力)', JSON.stringify(pyBad.buy) !== JSON.stringify(R.buy), JSON.stringify(pyBad.buy));
let real = null; try { real = execSync(`git -C ${JSON.stringify(ROOT)} show origin/gh-pages:data/screener.json`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
if (!real) ok('⑤h 正式網站的 screener.json 讀得到', false, '先 git fetch origin gh-pages');
else {
    const RP = '/tmp/_leader_real.json'; fs.writeFileSync(RP, real);
    const pyR = pyRun(RP);
    const b2 = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const p2 = await b2.newPage(); await p2.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });   // 🎯 V77.9.6 這支測的是 👑 那一套 → 先切成 👑(🧬 預設另由 test_stratswitch 測)
    await p2.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => typeof app !== 'undefined' && typeof app._leaderCalc === 'function', null, { timeout: 60000 });
    const js = await p2.evaluate(D => { const L = app._leaderCalc(D); return L.err ? { err: L.err } : { buy: L.buy.map(r => r.sym), ranked: L.ranked.map(r => r.sym), passed: L.passed, n: L.n }; }, JSON.parse(real));
    await b2.close();
    ok(`⑤h 正式網站那一份 screener(${JSON.parse(real).data_date}):Python == JS${js.err ? '(兩邊都 ' + js.err + ')' : `(前 5 = ${js.buy.join(' ')})`}`, JSON.stringify(pyR) .includes(JSON.stringify(js.buy || js.err)) && (js.err ? pyR.err === js.err : (JSON.stringify(pyR.ranked) === JSON.stringify(js.ranked) && pyR.passed === js.passed && pyR.n === js.n)), JSON.stringify([pyR.buy, js.buy]));
}
// ⑥ 🚧 決策台每一列「量薄」標註(V77.8.9;讀 screener amt20,⛔ 不刪名單)
// 🎯 V77.9.1 決策台區塊勾選 → V77.9.6 只列跟「我的策略」有關的區塊
const DS = await page.evaluate(() => {
    const out = {};
    const buy = document.getElementById('deckBuy'), head = document.getElementById('deckHead');
    buy.innerHTML = '<div data-deckpb="1">PB</div><div data-deckfit="1">FIT</div>'; head.innerHTML = '<div>H</div>';
    const box = document.getElementById('deckShowList');
    const snap = () => { app._deckShowApply(); app._renderDeckShowList(); return {
        def: app._deckShow(),
        pb: buy.querySelector('[data-deckpb]').style.display !== 'none',
        leader: document.getElementById('deckLeader').style.display !== 'none',
        idle: document.getElementById('deckIdle').style.display !== 'none',
        hidN: head.querySelector('[data-deckhidden]')?.dataset.deckhidden,
        keys: box ? [...box.querySelectorAll('[data-deckshowk]')].map(e => e.dataset.deckshowk) : [],
        checked: box ? box.querySelectorAll('input[type=checkbox]:checked').length : -1,
        pbDesc: box ? (box.querySelector('[data-deckshowk="pb"]')?.innerText || '') : '' }; };
    app.settings.deckShow = null;
    out.lead = snap();                                        // 這支測試開頭切成 👑
    app.settings.deckShow = { pb: true }; out.leadPbOn = snap();   // ⭐ 決定性對照:👑 時勾 pb 也⛔ 不會跑出來
    app.settings.strategy = 'gene'; app.settings.deckShow = null;
    out.gene = snap();
    app.settings.deckShow = { fit: true }; out.geneFit = snap();
    app.settings.strategy = 'lead'; app.settings.deckShow = null;
    return out;
});
ok('⑧ 👑:只有領頭羊 + 要賣的兩塊(🧬 那三塊不列也不顯)', JSON.stringify(DS.lead.def) === JSON.stringify({ leader: true, sell: true, pb: false, fit: false, note: false }) && DS.lead.leader && !DS.lead.pb && DS.lead.hidN === undefined && JSON.stringify(DS.lead.keys) === JSON.stringify(['leader', 'sell']), JSON.stringify(DS.lead));
ok('⑧b ⭐ 決定性對照:👑 時就算勾了 🧬 買點也⛔ 不顯示', DS.leadPbOn.pb === false, JSON.stringify(DS.leadPbOn));
ok('⑧c 🧬(預設):🧬 買點 + 要賣的開、領頭羊⛔ 不列也不顯;「今天不用做」只講 🧬', DS.gene.def.pb === true && DS.gene.def.leader === false && !DS.gene.leader && DS.gene.pb && DS.gene.idle && !DS.gene.keys.includes('leader') && DS.gene.keys.length === 4 && DS.gene.checked === 2, JSON.stringify(DS.gene));
ok('⑧d 🧬 收起的要寫出來(⛔ 不靜默);說明數字讀常數、⛔ 不再拿領頭羊來比', DS.gene.hidN === '2' && DS.geneFit.hidN === '1' && /324 萬/.test(DS.gene.pbDesc) && !/860 萬|領頭羊/.test(DS.gene.pbDesc), JSON.stringify([DS.gene.hidN, DS.geneFit.hidN, DS.gene.pbDesc]));

// 👑 V77.9.1 個股總覽一行
const OV = await page.evaluate(async () => {
    const out = {};
    const box = document.getElementById('ovLeaderLine');
    const run = async sym => { app.currentSymbolId = sym; await app._renderOvLeaderLine(sym); return { st: box.querySelector('[data-ovleader]')?.dataset.ovleader || null, hidden: box.classList.contains('hidden'), txt: box.innerText }; };
    const _inv = app.inventory; app.inventory = [];   // 🎯 V77.9.6 先測「手上沒有」
    out.top = await run('1001');      // 第 1 名
    out.keep = await run('1013');     // 第 7 名
    out.out = await run('1041');      // 第 21 名
    out.noTrend = await run('1000');  // 池子裡但沒過趨勢
    out.outside = await run('1110');  // 池子外
    app.inventory = [{ symbol: '1041', cost: 100 }, { symbol: '1110', cost: 100 }];   // 手上有 → 照 👑 講要不要賣
    out.outMine = await run('1041'); out.outsideMine = await run('1110');
    app.settings.strategy = 'gene'; out.geneHidden = await run('1001'); app.settings.strategy = 'lead';   // 🔒 🧬 時整行不出現
    app.inventory = _inv;
    // 切股競態:render 1001 但回來前換成 1003 → ⛔ 不可畫出 1001 的
    const _ls = app._loadScreener; app._loadScreener = async () => { app.currentSymbolId = '1003'; return _ls.call(app); };
    app.currentSymbolId = '1001'; await app._renderOvLeaderLine('1001'); out.race = box.innerText; app._loadScreener = _ls;
    return out;
});
ok('⑨ 總覽一行:第 1 名 → 🛒 買;第 7 名 → 已有才續抱;第 21 名 → 不在名單', OV.top.st === 'buy' && /🛒/.test(OV.top.txt) && OV.keep.st === 'keep' && /已有才續抱/.test(OV.keep.txt) && OV.out.st === 'out' && /不在名單/.test(OV.out.txt), JSON.stringify([OV.top, OV.keep, OV.out]));
ok('⑨b 沒過趨勢寫原因(V78.2.1 寫明條件方向);不在前 100 大、也沒標 → 整行不顯(不留空殼)', /沒過趨勢條件\(要 收盤 > 20日線 > 60日線 才算\)/.test(OV.noTrend.txt) && OV.outside.hidden === true && OV.outside.txt === '', JSON.stringify([OV.noTrend, OV.outside]));
ok('⑨e 🔒 選 🧬 時這一行整個不出現', OV.geneHidden.hidden === true && OV.geneHidden.txt === '', JSON.stringify(OV.geneHidden));
ok('⑨c ⭐ 決定性對照:同一檔手上有 → 從「不在名單」變成要賣(V78.2.1 非換倉日寫「⏳ 今天續抱;換倉日還在 10 名外才賣」);池子外的也要講賣', /(⛔|⏳) .*賣/.test(OV.outMine.txt) && !/(⛔|⏳) .*賣/.test(OV.out.txt) && OV.outsideMine.st === 'out' && /不在成交額前 100 大/.test(OV.outsideMine.txt) && /賣/.test(OV.outsideMine.txt), JSON.stringify([OV.outMine.txt, OV.outsideMine.txt]));
ok('⑨d 切股競態:await 回來已換股 → ⛔ 不畫上一檔', OV.race === '', OV.race);

const TH = await page.evaluate(() => {
    const x = { s: '1234', c: 50, stop: 45, trig: 52, exp: 1.2, lb: 0.8, k: '測試招', up: 4 };
    const save = app._scrData;
    const mk = a20 => { app._scrData = { cols: ['c', 'amt20'], rows: { '1234': [50, a20] } }; return app._pbRowHtml(x, new Set(), 1, 0, false); };
    const thin = mk(0.3), fat = mk(5);
    app._scrData = undefined; const none = app._pbRowHtml(x, new Set(), 1, 0, false);
    app._scrData = { cols: ['c', 'amt20'], rows: { '1234': [50, null] } }; const nul = app._pbRowHtml(x, new Set(), 1, 0, false);
    const old = app._DECK_THIN_AMT; app._DECK_THIN_AMT = 0.2; const moved = mk(0.3); app._DECK_THIN_AMT = old;
    app._scrData = save;
    return { thin: /data-deckthin/.test(thin), thinTxt: thin, fat: /data-deckthin/.test(fat), none: /data-deckthin/.test(none), nul: /data-deckthin/.test(nul), moved: /data-deckthin/.test(moved) };
});
ok('⑥ 決策台 amt20 < 1 億 → 🚧量薄;5 億 → 不標', TH.thin && !TH.fat, JSON.stringify(TH).slice(0, 200));
ok('⑥b 快照還沒載到 / 欄位是 null → ⛔ 不標(不知道 ≠ 很薄)', !TH.none && !TH.nul);
ok('⑥c ⭐ 決定性對照:門檻改成 0.2 億 → 同一檔 0.3 億就不標', !TH.moved);
ok('⑥d 名單刻意不刪 + 寫明門檻不是回測出來的', /名單刻意不刪/.test(TH.thinTxt) && /不是回測出來的/.test(TH.thinTxt));
// ⑦ 📐 K棒轉多/轉空榜每一列的實測成績(標題反查 `_SIGNAL_EDGE`,⛔ 單根變盤線不借成績)
const KB = await page.evaluate(() => {
    const keys = Object.keys(app._SIGNAL_EDGE);
    const star = keys.find(k => k.endsWith('｜晨星轉折')), night = keys.find(k => k.endsWith('｜夜星轉折'));
    const eS = app._sigEdge(star.split('｜')[0], '晨星轉折');
    app.radarMatrix = { updated: 't', data: { kbar_bull: [{ sym: '2330', close: 1, turnover_e: 9, gain: 1, status: '晨星轉折 + 低檔十字變盤線(轉折警訊,次日確認)' }], kbar_bear: [{ sym: '2317', close: 1, turnover_e: 9, gain: -1, status: '夜星轉折' }] } };
    app._radarIsDemo = true;
    const body = document.getElementById('radarMatrixBody');
    app.renderRadarMatrix('kbar_bull'); const bull = body ? body.innerHTML : '';
    app.renderRadarMatrix('kbar_bear'); const bear = body ? body.innerHTML : '';
    const L = app._kbarRadarEdge('晨星轉折 + 低檔十字變盤線(轉折警訊,次日確認)');
    const save = app._SIGNAL_EDGE; const alt = JSON.parse(JSON.stringify(save)); alt[star] = ['A', 999, 1, 50, 0.01, 1, 1, 7.77];
    const saveBt = app._btEdge; app._btEdge = null;   // ⚠️ 每週回測產物(data/backtest_edge.json)優先 → 要先拿掉,否則改常數量不到(本地有抓 gh-pages 資料時假失敗)
    app._SIGNAL_EDGE = alt; app._kbarTitleIdx = null; const moved = app._kbarRadarEdgeHtml('晨星轉折', true); app._SIGNAL_EDGE = save; app._btEdge = saveBt; app._kbarTitleIdx = null;
    return { hasBody: !!body, bull, bear, L: L.map(x => [x.t, x.det, x.e && x.e.grade]), eS, moved, starDet: star.split('｜')[0], nightOk: !!night };
});
ok('⑦ 轉多榜:晨星對到偵測器並印實測等級 + 每趟期望值;單根變盤線 → 未驗證', KB.hasBody && KB.L[0][1] === KB.starDet && KB.L[0][2] === KB.eS.grade && KB.L[1][1] === null && /data-kbedge/.test(KB.bull) && /data-kbg="na"/.test(KB.bull) && new RegExp(`每趟${KB.eS.exp >= 0 ? '\\+' : ''}${(+KB.eS.exp).toFixed(2)}%`).test(KB.bull), JSON.stringify(KB.L));
ok('⑦b 轉空榜看 10 日邊際(⛔ 不看期望值)', KB.nightOk && /data-kbg="[ABC]"[^>]*>[^<]*10日[+-]?\d/.test(KB.bear) && !/data-kbg="[ABC]"[^>]*>[^<]*每趟/.test(KB.bear));
ok('⑦c ⭐ 決定性對照:成績表改成 7.77 → 標籤跟著變(⛔ 不是寫死)', /每趟\+7\.77%/.test(KB.moved) && /data-kbg="A"/.test(KB.moved), KB.moved.slice(0, 200));
ok('⑦d 標籤⛔ 無 🔴🟢', !/[🔴🟢]/u.test(KB.bull + KB.bear));
const PROH = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const proMin = (PROH.match(/CAST_MIN_AMT: ([\d.]+),/) || [])[1], idxMin = (SRC.match(/_DECK_THIN_AMT: ([\d.]+),/) || [])[1];
ok('⑥e 門檻 index `_DECK_THIN_AMT` == pro `CAST_MIN_AMT`(同一條線)', proMin && proMin === idxMin, `${idxMin} vs ${proMin}`);
// ⑨ 🎣 V77.9.4 產業作戰室(pro.html)也有一份 `_leaderCalc`(釣魚拋竿 / 👑 池子用,⛔ 不讀 index.html —— 那是 4.9 MB)
//    → 第三份實作,規則與名單要跟 index 一模一樣(合成 + 正式 screener);決定性對照:pro 那份改成 chg20 排必須對不上
{
    const synth = (() => {
        const cols = ['c', 'chg', 'chg5', 'chg10', 'chg20', 'amt', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252'], rows = {};
        for (let i = 0; i < 120; i++) { const chg10 = i < 100 ? (i % 2 ? 30 - i * 0.2 : -5) : 99;
            rows[String(1000 + i)] = [100, 1, 1, chg10, i, i, 200 - i, i % 2 ? 3 : -3, i % 2 ? 8 : 1, 0, 0, 0, 95]; }
        rows['0050'] = [100, 1, 1, 50, 50, 999, 999, 5, 9, 0, 0, 1, 95];
        return { data_date: '2026-09-28', cols, rows };
    })();
    const sets = [['合成', synth]]; if (real) sets.push(['正式 ' + JSON.parse(real).data_date, JSON.parse(real)]);
    const pick = L => L.err ? { err: L.err } : { buy: L.buy.map(r => r.sym), ranked: L.ranked.map(r => r.sym), passed: L.passed, n: L.n };
    const idxRes = [], proRes = [];
    for (const [, D] of sets) idxRes.push(await page.evaluate(([D, f]) => { const L = app._leaderCalc(D); return eval(f)(L); }, [D, pick.toString()]));
    const pp = await browser.newPage(); await pp.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });   // 🎯 V77.9.6 這支測的是 👑 那一套 → 先切成 👑(🧬 預設另由 test_stratswitch 測)
    await pp.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
    await pp.waitForFunction(() => typeof PRO !== 'undefined' && typeof PRO._leaderCalc === 'function', null, { timeout: 60000 });
    for (const [, D] of sets) proRes.push(await pp.evaluate(([D, f]) => eval(f)(PRO._leaderCalc(D)), [D, pick.toString()]));
    const bad = await pp.evaluate(D => { const cols = D.cols.map(c => c === 'chg10' ? 'x' : c === 'chg20' ? 'chg10' : c); return PRO._leaderCalc({ ...D, cols }).buy.map(r => r.sym); }, synth);
    const pRule = await pp.evaluate(() => { const P = PRO._LEAD; return [P.U, P.N, P.R, P.L, P.hyst, P.pos, P.anchor].join(','); });
    const iRule = await page.evaluate(() => { const P = app._LEADER_EDGE.rule; return [P.U, P.N, P.R, P.L, P.hyst, P.pos].join(','); });
    const iAnc = (SRC.match(/anchor: '(\d{4}-\d\d-\d\d)'/) || [])[1];
    await pp.close();
    sets.forEach(([nm], k) => ok(`⑨ pro.html \`_leaderCalc\` == index(${nm}:前 5 / 前 10 / 過趨勢 / 池子)`, JSON.stringify(proRes[k]) === JSON.stringify(idxRes[k]), JSON.stringify([proRes[k], idxRes[k]]).slice(0, 240)));
    ok('⑨b ⭐ 決定性對照:pro 那份改用 chg20 排 → 名單必須對不上', JSON.stringify(bad) !== JSON.stringify(idxRes[0].buy), JSON.stringify(bad));
    ok('⑨c 規則 pro `_LEAD` == index `_LEADER_EDGE.rule` + 錨點', pRule === iRule + ',' + iAnc, `${pRule} vs ${iRule},${iAnc}`);
}
// ⑩ 📍 V78.0.5 買進多一道「一年位置 ≥ 85%」—— 四份實作(index / pro / lib_leader.py / worker)同一份合成資料名單要一樣;
//    1003 位置 50%、1005 沒有位置資料 → 都不買、往下找(1001/1007/1009/1011/1013);續抱名單(前 10)⛔ 不看位置;換回舊的 = 前 5 名
{
    const D = JSON.parse(JSON.stringify(R.D)); const pi = D.cols.indexOf('pos252');
    D.rows['1003'][pi] = 50; D.rows['1005'][pi] = null;
    const WANT = ['1001', '1007', '1009', '1011', '1013'], OLD = ['1001', '1003', '1005', '1007', '1009'];
    const iNew = await page.evaluate(D => { const L = app._leaderCalc(D); return { buy: L.buy.map(r => r.sym), ranked: L.ranked.map(r => r.sym), pos: L.pos }; }, D);
    const iOld = await page.evaluate(D => app._leaderCalc(D, { pos: 0 }).buy.map(r => r.sym), D);
    const iOff = await page.evaluate(D => { app.settings.leadPosOff = true; const b = app._leaderCalc(D).buy.map(r => r.sym); app.settings.leadPosOff = false; return b; }, D);
    const pp = await browser.newPage(); await pp.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });
    await pp.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
    await pp.waitForFunction(() => typeof PRO !== 'undefined' && typeof PRO._leaderCalc === 'function', null, { timeout: 60000 });
    const pNew = await pp.evaluate(D => PRO._leaderCalc(D).buy.map(r => r.sym), D);
    const pOff = await pp.evaluate(D => { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.leadPosOff = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); return PRO._leaderCalc(D).buy.map(r => r.sym); }, D);
    await pp.close();
    const TP = '/tmp/_leader_pos.json'; fs.writeFileSync(TP, JSON.stringify(D));
    const pyNew = pyRun(TP).buy;
    const W = '/tmp/_worker_pos.mjs'; fs.writeFileSync(W, fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8'));
    const WK = await import(W + '?t=' + Date.now());
    const wNew = WK.leadCalc(D).buy.map(r => r.sym), wOld = WK.leadCalc(D, 0).buy.map(r => r.sym);
    const J = x => JSON.stringify(x);
    ok('⑩ 一年位置 ≥85:index 跳過 1003(50%)與 1005(沒資料),往下買到 1013;續抱名單(前 10)照舊不看位置', J(iNew.buy) === J(WANT) && iNew.ranked.includes('1003') && iNew.ranked.includes('1005') && iNew.pos === 85, J(iNew));
    ok('⑩b 四份實作一樣(index / pro / lib_leader.py / Telegram worker)', J(pNew) === J(WANT) && J(pyNew) === J(WANT) && J(wNew) === J(WANT), J([pNew, pyNew, wNew]));
    ok('⑩c ⭐ 決定性對照:換回舊的(pos 0 / settings.leadPosOff / worker pos 0)→ 前 5 名(含 1003 / 1005)', J(iOld) === J(OLD) && J(iOff) === J(OLD) && J(pOff) === J(OLD) && J(wOld) === J(OLD), J([iOld, iOff, pOff, wOld]));
    // ⑩d V78.0.6 說明文字跟著規則走(設定選項 / 決策台區塊說明 / 換倉提醒 / pro 拋竿 / Telegram)
    const txt = await page.evaluate(() => {
        const one = () => { app.settings.stratUnlock = true; const box = document.getElementById('stratBox'); let st = '';
            if (box) { app._renderStratBox(); st = (box.querySelector('[data-stratopt="lead"]') || {}).innerText || ''; }   // ⚠️ V78.1.1 只看 👑 那一個選項(🔥 的說明本來就寫「一年位置高」,整格比會被它救活/害死)
            const dk = app._deckShowDesc(app._DECK_SECTIONS.find(c => c.k === 'leader').d); return { st, dk }; };
        const on = one(); app.settings.leadPosOff = true; const off = one(); app.settings.leadPosOff = false; return { on, off };
    });
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), wsrc = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8'), psrc = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
    const reb = (src.match(/async _leadRebalAlert\(\)[\s\S]*?\n    \},/) || [''])[0];
    ok('⑩d 說明文字跟著規則:開著寫「一年位置 ≥ 85%」、換回舊的就不寫(設定選項 / 決策台區塊說明)',
        /一年位置 ≥ 85%/.test(txt.on.dk) && !/一年位置/.test(txt.off.dk) && (!txt.on.st || (/一年位置 ≥ 85%/.test(txt.on.st) && !/一年位置/.test(txt.off.st))), JSON.stringify(txt));
    ok('⑩d2 換倉提醒 / Telegram / pro 拋竿⛔ 不再寫死「前 N 名」沒有位置條件',
        /_leadPos\(\)[^\n]*前 \$\{R\.N\} 名,等權/.test(reb) && /LEAD_RULE\.pos\}% 的`\}前 \$\{LEAD_RULE\.N\} 名,等權/.test(wsrc) && !/前 5 名你都有了/.test(wsrc) && /今天會買的 ' \+ this\._LEAD\.N/.test(psrc), '');
}
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ LEADERDECK_PASS');
process.exit(fails.length ? 1 : 0);
