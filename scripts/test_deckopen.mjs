#!/usr/bin/env node
/**
 * 👆 V80.0.5 決策台:整列點下去都進個股頁 + 返回回到原本捲到的位置
 *   使用者(👑 表截圖):「裡面個股點擊後不會到個股畫面,另外返回也要回來上一個頁面」
 *   真因:只有股票名字那一小格有 onclick(點價格 / 漲跌那幾格沒反應);switchAppTab 不記捲動位置,返回後跳回最上面。
 *   ① 點 👑 表那一列的「價格」格(⛔ 不是名字)→ analyze 那一檔 + 個股頁打開 + navStack 尾端 diag
 *   ② 決策台上每一種列著股票的列都掛 _deckOpen(👑 表 / 持股 / 今天要做的事 / 🔥 今天可以買的),名字格⛔ 再掛一份(點一次跑兩次)
 *   ③ 決策台捲到 600(捲的是 #appMainArea,⛔ 不是 window) → 點股票 → goBack → 回到決策台且 scrollY ≈ 600(⭐ 決定性對照:點下方分頁鈕切回來 ⛔ 不還原 = 照舊)
 *   ④ 列裡的按鈕(📋 條件單 / 複製)一律 stopPropagation
 * 注入(INJECT=):name(列的點擊拿掉、放回名字格)/ noscroll(還原整個不做)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
const inj = (a, b) => { if (!SRC.includes(a)) { console.log('❌ 注入錨點不見了:' + a.slice(0, 80)); process.exit(1); } SRC = SRC.split(a).join(b); };
if (INJ === 'name') {
    inj(`cursor-pointer active:bg-[#21262d]" style="display:grid;\${COLS};gap:4px" onclick="app._deckOpen('\${r.sym}')" data-leaderrow=`, `" style="display:grid;\${COLS};gap:4px" data-leaderrow=`);
    inj(`<span class="min-w-0 leading-tight" data-leadername="\${r.sym}">`, `<span class="min-w-0 cursor-pointer leading-tight" onclick="app.analyze('\${r.sym}'); app.switchAppTab('diag');" data-leadername="\${r.sym}">`);
}
if (INJ === 'noscroll') inj('    _tabScrollRestore(tabId, pending) {\n', '    _tabScrollRestore(tabId, pending) { return;\n');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_deckopen.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails.push(n); };

// ── 靜態:🔥 今天可以買的那一列 + 名字格不再重複掛 ──
{
    const fn = SRC.slice(SRC.indexOf('data-deckbuyrow="${esc(sym)}"'), SRC.indexOf('data-deckbuyrow="${esc(sym)}"') + 2500);
    ok('② 🔥 今天可以買的:整列(第一行 grid)掛 _deckOpen', /onclick="app\._deckOpen\('\$\{esc\(sym\)\}'\)" data-deckbuyopen=/.test(fn), fn.slice(0, 300));
    ok('② 🔥 名字格⛔ 再掛 analyze(點一次跑兩次)', !/onclick="app\.analyze\('\$\{esc\(sym\)\}'\)[^"]*" data-deckbuyname/.test(SRC));
    ok('④ 🔥 列裡的 📋 條件單 stopPropagation', /onclick="event\.stopPropagation\(\);app\._copyCondOrder/.test(fn));
    ok('③ 庫存頁:返回時⛔ 捲回頂端(只有一般切換才回頂端)', SRC.includes('if (!isGoBack) window.scrollTo(0, 0);'));
}

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };
    try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'leadpark'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {}
});
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leaderDeckHtml === 'function' && typeof app._deckOpen === 'function', null, { timeout: 60000 });
await page.waitForTimeout(4000);   // 讓 init 自己的 switchAppTab('desk') 先跑完

const R = await page.evaluate(async () => {
    const o = {};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // 沙箱沒有 Tailwind → body 的 flex flex-col 不生效、#appMainArea 不會變成捲動區 → 自己補上(= 手機上的版面)
    document.body.style.display = 'flex'; document.body.style.flexDirection = 'column';
    const SC = app._scrollEl(); const sy = () => SC.scrollTop; const st = v => { SC.scrollTop = v; };
    app._tpeMinutes = () => ({ ymd: '2026-10-12', wd: 'Mon', min: 8 * 60 });
    app.renderDeck = async () => { await sleep(150); };      // 決策台重畫(async)→ 測試自己控制內容
    const calls = []; app.analyze = async s => { calls.push(s); app.currentSymbolId = s; };
    app._mktSeen = null;
    const cols = ['c', 'chg', 'chg5', 'chg10', 'chg20', 'amt', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252'];
    const rows = {};
    for (let i = 0; i < 120; i++) { const chg10 = i < 100 ? (i % 2 ? 30 - i * 0.2 : -5) : 99; rows[String(1000 + i)] = [100, 1, 1, chg10, i, i, 200 - i, i % 2 ? 3 : -3, i % 2 ? 8 : 1, 0, 0, 0, 95]; }
    const D = { data_date: '2026-09-28', cols, rows };
    const tw = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'].map(d => ({ date: d }));
    const BL = [{ sym: '1003', r: 1, c: 80 }, { sym: '1001', r: 2, c: 90 }, { sym: '1005', r: 3, c: 95 }, { sym: '1007', r: 4, c: 100 }, { sym: '1031', r: 5, c: 110 }];
    app._scrData = D; app._loadScreener = async () => D; app._getTwiiRows = async () => tw;
    app._mktBear60 = async () => ({ on: false, c: 1, ma20: 1, ma60: 1 });
    app._leadRebPx = { D: '2026-09-24', v: { map: new Map(BL.map(b => [b.sym, b.c])), rank: new Map(BL.map(b => [b.sym, b.r])), list: BL, err: null } };
    app._loadKline = async () => null; app._leadRebK = null;
    app._liveQuotes = {}; app._liveUpdated = null; app._deckQ = {}; app._leadCtx = null;
    app.inventory = [{ symbol: '1001', shares: 1, cost: 90 }, { symbol: '1009', shares: 1, cost: 100 }];
    app._getInventory = () => app.inventory;
    app.settings.accountSize = 0;
    const host = document.getElementById('deckLeader'), headBox = document.getElementById('deckHead');
    headBox.innerHTML = '<div id="deckTodoLead"></div>';
    host.innerHTML = await app._leaderDeckHtml();
    // 決策台撐高(才有地方捲)
    const pad = document.createElement('div'); pad.style.height = '3000px'; pad.id = '__pad'; document.getElementById('tabContentDesk').appendChild(pad);

    // ② 每一種列都掛 _deckOpen
    const kinds = { row: '[data-leaderrow]', held: '[data-leaderheld]', todo: '#deckTodoLead [data-todostk]' };
    o.kinds = {};
    for (const [k, sel] of Object.entries(kinds)) { const els = [...document.querySelectorAll(sel)]; o.kinds[k] = [els.length, els.filter(e => /app\._deckOpen\(/.test(e.getAttribute('onclick') || '')).length]; }
    o.nameNoClick = [...host.querySelectorAll('[data-leadername]')].every(e => !e.getAttribute('onclick'));

    // ① 點價格那一格
    app.switchAppTab('desk'); await sleep(400);
    const pxCell = host.querySelector('[data-leaderpx="1003"]');
    o.pxFound = !!pxCell;
    if (pxCell) pxCell.click();
    await sleep(300);
    const shown = id => document.getElementById(id)?.classList.contains('tab-active');
    o.afterPx = { calls: [...calls], diag: shown('tabContentDiag'), top: app.navStack[app.navStack.length - 1] };

    // ③ 捲到 600 → 點股票 → 返回 → 回到 600
    app.goBack(); await sleep(600);
    st(0); await sleep(50);
    st(600); await sleep(80);
    o.y0 = sy();
    host.querySelector('[data-leaderrow="1005"]').click(); await sleep(300);
    o.diag2 = shown('tabContentDiag'); o.diagY = sy();   // 個股頁要從最上面開始
    app.goBack(); await sleep(700);
    o.back = { desk: shown('tabContentDesk'), y: sy() };
    // 決定性對照:一般切換(點下方分頁鈕)⛔ 不還原
    st(600); await sleep(50);
    app.switchAppTab('fav'); await sleep(200);
    app.switchAppTab('desk'); await sleep(700);
    o.navY = sy();
    // 使用者自己捲了 → ⛔ 不搶
    st(600); await sleep(80);
    host.querySelector('[data-leaderrow="1003"]').click(); await sleep(300);
    app._tabScrollY.desk = 600; app.renderDeck = async () => { await sleep(500); };
    app.goBack(); await sleep(80); st(100); await sleep(900);
    o.userY = sy();
    return o;
});

ok('② 👑 表每一列都掛 _deckOpen', R.kinds.row[0] >= 5 && R.kinds.row[0] === R.kinds.row[1], JSON.stringify(R.kinds));
ok('② 👜 持股那幾列掛 _deckOpen', R.kinds.held[0] >= 1 && R.kinds.held[0] === R.kinds.held[1], JSON.stringify(R.kinds));
ok('② 今天要做的事的股票名掛 _deckOpen', R.kinds.todo[0] === R.kinds.todo[1], JSON.stringify(R.kinds));
ok('② 名字格⛔ 再掛一份點擊', R.nameNoClick);
ok('① 點價格那一格 → 打開那一檔的個股頁', R.pxFound && R.afterPx.calls[0] === '1003' && R.afterPx.diag && R.afterPx.top === 'diag', JSON.stringify(R.afterPx));
ok('③ 返回 → 回到決策台原本的位置(≈600)', R.back.desk && Math.abs(R.back.y - R.y0) <= 4 && R.y0 >= 590, JSON.stringify({ y0: R.y0, ...R.back }));
ok('③ 打開個股頁從最上面開始(⛔ 停在決策台捲到的高度)', R.diag2 && R.diagY <= 4, R.diagY);
ok('③ 決定性對照:點下方分頁鈕切回決策台 → 從最上面開始', R.navY <= 4, R.navY);
ok('③ 返回時使用者自己捲了 → ⛔ 搶回去', Math.abs(R.userY - 100) <= 4, R.userY);
ok('沒有 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
if (fails.length) { console.log(`\n❌ DECK_OPEN ${fails.length} 條失敗`); process.exit(1); }
console.log('\n✅ DECK_OPEN_PASS');
