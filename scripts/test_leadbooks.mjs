#!/usr/bin/env node
/**
 * 📚 V79.2.5 👑 領頭羊「兩本帳、換倉日錯開 4 天」守門
 *   ① 錨點 / 本數 四份實作一字不差:index `_LEADER_EDGE.anchor2/books` = lib_leader `LEADER_ANCHOR2/LEADER_BOOKS` = pro `_LEAD.anchor2/books` = worker `LEAD_ANCHOR2`;
 *      而且 anchor2 = 錨點起第 5 個交易日(錯開 4 天;用 gh-pages / 本地 ^TWII 日曆算)
 *   ② App `_leadClk`:兩本 ⛔ 不同一天換倉;第 1 本換倉日 book 'A'、第 2 本 'B';一本帳(leadBooks 1)== `_leaderClock` 逐欄相同(決定性對照)
 *   ③ `_leadActs` 兩本帳:只賣「這本」上次名單上的(另一本的 → waitOther,⛔ 不賣)、兩本都有 → half、另一本有這本沒有 → 這本照買一份(addOne)、🔥 不在任何一本名單上的庫存照舊不重複買
 *      ⭐ 決定性對照:kRank 讀不到(null)→ 跟一本帳的舊做法逐欄相同
 *   ④ `_leadSlot`:兩本帳每檔 = 總資金 ÷ 10;一本帳 ÷ 5
 *   ⑤ App `_leadActs` == worker `leadActs`(同一組輸入,sell / buy / half / waitOther 一模一樣)
 *   ⑥ 決策台「今天要做的事」兩本帳寫出是哪一本 + 一半 / 再買一份;一本帳一個字都不多(⛔ 不可出現「本帳」)
 *   ⑦ `_STRAT_CHANGES` 有這一筆 + 「換回舊的」= setLeadBooks(1);Telegram 同步有送 leadBooks、worker 有收
 * 注入:INJECT=nohalf(兩本都有也全賣)/ sameday(第 2 本錨點 = 第 1 本)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nohalf') SRC = SRC.replace('const half = sell.filter(inO);', 'const half = [];');
if (INJ === 'sameday') SRC = SRC.replace("books: 2, anchor2: '2026-10-02',", "books: 2, anchor2: '2026-09-24',");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_leadbooks.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails.push(n); };

// ① 四份實作
const LIB = fs.readFileSync(path.join(ROOT, 'lib_leader.py'), 'utf8'), PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8'), WK = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const iA2 = (SRC.match(/books: (\d), anchor2: '(\d{4}-\d\d-\d\d)'/) || []).slice(1), lA2 = (LIB.match(/LEADER_ANCHOR2 = '(\d{4}-\d\d-\d\d)'/) || [])[1], lB = (LIB.match(/^LEADER_BOOKS = (\d)/m) || [])[1];
const pA2 = (PRO.match(/books: (\d), anchor2: '(\d{4}-\d\d-\d\d)'/) || []).slice(1), wA2 = (WK.match(/LEAD_ANCHOR2 = '(\d{4}-\d\d-\d\d)'/) || [])[1];
ok('① 第 2 本錨點 / 本數 四份一字不差(index / lib_leader / pro / worker)', iA2[1] && iA2[1] === lA2 && lA2 === pA2[1] && pA2[1] === wA2 && iA2[0] === lB && lB === pA2[0], JSON.stringify({ iA2, lA2, lB, pA2, wA2 }));
let TW = null;
for (const f of [path.join(ROOT, 'data/^TWII.json')]) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); TW = Array.isArray(j) ? j : j.data; } catch (_) {} }
if (TW) {
    const days = [...new Set(TW.map(r => String(r.date || '').replace(/\//g, '-').slice(0, 10)))].sort();
    const i0 = days.indexOf('2026-09-24');
    if (i0 >= 0 && days.length > i0 + 4) ok('① anchor2 = 錨點起第 5 個交易日(錯開 4 天)', days[i0 + 4] === lA2, `${days.slice(i0, i0 + 6)} vs ${lA2}`);
    else console.log('⏭️ 本地 ^TWII 不到 10-02,跳過 ① 日曆那條');
}

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leadClk === 'function' && typeof app._deckTodoLead === 'function', null, { timeout: 60000 });

const R = await page.evaluate(() => {
    const o = {};
    const days = ['2026-09-24', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
        '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21'];
    const tw = days.map(d => ({ date: d }));
    app.settings = app.settings || {};
    app.settings.leadBooks = 2;
    o.clk2 = days.map(d => { const c = app._leadClk(tw, d); return { d, book: c.book, reb: c.isRebal, left: c.left, a: c.A.isRebal, b: c.B && c.B.isRebal }; });
    app.settings.leadBooks = 1;
    o.same1 = days.every(d => { const a = app._leadClk(tw, d), b = app._leaderClock(tw, d, app._LEADER_EDGE.anchor); return ['started', 'day', 'isRebal', 'left', 'reb', 'prev'].every(k => a[k] === b[k]) && a.book === 'A'; });
    // ③ _leadActs:假名單 —— 前 10 名 = 1001..1010,買進 = 1001..1005
    const all = new Map(); for (let i = 1; i <= 12; i++) all.set(String(1000 + i), { sym: String(1000 + i), rank: i });
    const L = { all, buy: [1, 2, 3, 4, 5].map(i => ({ sym: String(1000 + i) })) };
    app.settings.leadBooks = 2;
    // 手上:1001(兩本都有)、1003(這本)、1011(這本,掉出)、1012(另一本,掉出)、1020(兩本都有、掉出)、2330(🔥,前 10 名外)、1004(只另一本有、在前 10)
    app._leadCtx = { snap: { kRank: new Map([['1001', 1], ['1003', 3], ['1011', 11], ['1020', 9]]), oRank: new Map([['1001', 1], ['1012', 12], ['1020', 9], ['1004', 4]]) } };
    const mine = ['1001', '1003', '1011', '1012', '1020', '1004'];
    o.a2 = app._leadActs(L, false, mine, [...mine, '2330']);
    // 決定性對照:kRank 讀不到 → 跟一本帳一樣
    app._leadCtx = { snap: { kRank: null, oRank: new Map([['1001', 1]]) } };
    const aNull = app._leadActs(L, false, mine, [...mine, '2330']);
    app.settings.leadBooks = 1; app._leadCtx = { snap: {} };
    const a1 = app._leadActs(L, false, mine, [...mine, '2330']);
    o.nullSame = JSON.stringify([aNull.sell, aNull.keep, aNull.buy]) === JSON.stringify([a1.sell, a1.keep, a1.buy]);
    o.a1 = a1;
    // ④ slot
    app._getInventory = () => []; app.settings.accountSize = 1000000;
    app.settings.leadBooks = 2; o.slot2 = app._leadSlot().slot;
    app.settings.leadBooks = 1; o.slot1 = app._leadSlot().slot;
    // ⑥ 今天要做的事:兩本帳 eve(換倉日收盤後)
    app._tpeMinutes = () => ({ ymd: '2026-10-02', wd: 'Fri', min: 18 * 60 });
    app._deckQuoteOf = () => null;
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent; };
    app.settings.leadBooks = 2;
    app._leadCtx = { snap: { kRank: new Map([['1001', 1], ['1011', 11], ['1020', 9]]), oRank: new Map([['1020', 9], ['1004', 4]]) } };
    const clkB = app._leadClk(tw, '2026-10-02');
    const held = ['1001', '1011', '1020', '1004'].map(s => ({ sym: s, mine: true }));
    o.todo2 = txt(app._deckTodoLead({ clk: clkB, bearOn: false, L: { ...L, date: '2026-10-02' }, held, H: 10, inv: held.map(h => h.sym) }));
    app.settings.leadBooks = 1; app._leadCtx = { snap: {} };
    const clkA = app._leadClk(tw, '2026-10-08');
    app._tpeMinutes = () => ({ ymd: '2026-10-08', wd: 'Thu', min: 18 * 60 });
    o.todo1 = txt(app._deckTodoLead({ clk: clkA, bearOn: false, L: { ...L, date: '2026-10-08' }, held, H: 10, inv: held.map(h => h.sym) }));
    o.chg = (app._STRAT_CHANGES || []).find(c => c.backBooks);
    return o;
});

const c2 = R.clk2;
ok('② 兩本帳:⛔ 不會同一天換倉、第 1 本 09-24 / 10-12 換、第 2 本 10-02 / 10-16 換',
    c2.every(x => !(x.a && x.b)) && c2.find(x => x.d === '2026-09-24').book === 'A' && c2.find(x => x.d === '2026-09-24').reb
    && c2.find(x => x.d === '2026-10-02').book === 'B' && c2.find(x => x.d === '2026-10-02').reb
    && c2.find(x => x.d === '2026-10-12').book === 'A' && c2.find(x => x.d === '2026-10-12').reb
    && c2.find(x => x.d === '2026-10-16').book === 'B' && c2.find(x => x.d === '2026-10-16').reb
    && c2.filter(x => x.reb).length === 4, JSON.stringify(c2));
ok('② 非換倉日:講下一個要換的那一本(10-05 → 第 1 本還 5 天;10-13 → 第 2 本還 3 天)',
    c2.find(x => x.d === '2026-10-05').book === 'A' && c2.find(x => x.d === '2026-10-05').left === 5 && c2.find(x => x.d === '2026-10-13').book === 'B' && c2.find(x => x.d === '2026-10-13').left === 3, JSON.stringify(c2.slice(5, 13)));
ok('② 一本帳(leadBooks 1)== `_leaderClock` 逐欄相同(決定性對照)', R.same1);
const a = R.a2;
ok('③ 只賣這本的:1011 賣、1012(另一本的)⛔ 不賣 → waitOther', a.sell.includes('1011') && !a.sell.includes('1012') && a.waitOther.includes('1012'), JSON.stringify(a));
ok('③ 兩本都有又掉出(1020)→ 只賣這本那一份(half)', a.sell.includes('1020') && a.half.includes('1020') && !a.half.includes('1011'), JSON.stringify(a));
ok('③ 另一本有、這本沒有、在買進名單(1004)→ 這本照樣買一份(addOne);🔥 2330 不重複買;這本已有的 1001 / 1003 不買',
    a.buy.includes('1004') && a.addOne.includes('1004') && !a.buy.includes('1001') && !a.buy.includes('1003') && !a.buy.includes('2330') && a.buy.length <= 5 - 2, JSON.stringify(a));
ok('③ 決定性對照:這本名單讀不到 → 跟一本帳逐欄相同', R.nullSame);
ok('③ 一本帳:手上掉出的全部賣(1011 / 1012 / 1020)、沒有 half', ['1011', '1012', '1020'].every(s => R.a1.sell.includes(s)) && !(R.a1.half || []).length, JSON.stringify(R.a1));
ok('④ 每檔金額:兩本帳 = 總資金 ÷ 10、一本帳 ÷ 5', R.slot2 === 100000 && R.slot1 === 200000, `${R.slot2} / ${R.slot1}`);
ok('⑥ 今天要做的事(兩本帳):寫出「第 2 本帳」+ 1020 只賣一半 + 1004 再買一份', /第 2 本帳/.test(R.todo2) && /只賣這本那一份/.test(R.todo2) && /再買一份/.test(R.todo2), R.todo2);
ok('⑥ 一本帳:一個字都不多(⛔「本帳」只出現在換回按鈕那一行)', !/第 [12] 本帳|只賣這本|再買一份/.test(R.todo1), R.todo1);
ok('⑦ 策略變更跳窗有這一筆 + 換回舊的 = setLeadBooks(1)', R.chg && R.chg.lead && /setLeadBooks\(1\)/.test(SRC) && /backBooks \? 'app\.setLeadBooks\(1\);'/.test(SRC), JSON.stringify(R.chg));
ok('⑦ Telegram:App 有送 leadBooks、worker 有收', /leadBooks:\s+app\.settings\?\.leadBooks === 1 \? 1 : 2/.test(SRC) && /leadBooks: payload\.settings\.leadBooks === 1 \? 1 : 2/.test(WK));

// ⑤ worker leadActs == App(同一組輸入)
const tmpW = path.join(ROOT, 'scripts', '.tmp_worker_leadbooks.mjs'); fs.writeFileSync(tmpW, WK);
const M = await import('file://' + tmpW);
try { fs.unlinkSync(tmpW); } catch (_) {}
const wA = M.leadActs(['1001', '1003', '1011', '1012', '1020', '1004'], Array.from({ length: 10 }, (_, i) => String(1001 + i)), ['1001', '1002', '1003', '1004', '1005'], false,
    ['1001', '1003', '1011', '1020'], ['1001', '1012', '1020', '1004']);
ok('⑤ worker leadActs == App _leadActs(sell / buy / half / waitOther / addOne)',
    ['sell', 'buy', 'half', 'waitOther', 'addOne'].every(k => JSON.stringify(wA[k]) === JSON.stringify(a[k])), JSON.stringify({ wA, a }));
const wc = M.leadClocks([{ date: '2026-09-24' }, { date: '2026-09-29' }, { date: '2026-09-30' }, { date: '2026-10-01' }, { date: '2026-10-02' }], '2026-10-02', 2);
ok('⑤ worker leadClocks:10-02 = 第 2 本換倉', wc.book === 'B' && wc.isRebal && M.leadClocks([{ date: '2026-09-24' }], '2026-09-24', 1).book === 'A');

ok('無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(`\n${fails.length ? '❌' : '✅'} LEADBOOKS ${fails.length ? fails.length + ' 條失敗' : '全部通過'}`);
process.exit(fails.length ? 1 : 0);
