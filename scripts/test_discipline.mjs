#!/usr/bin/env node
/**
 * 🧭 V80.0.4 交易紀律三件事(帳戶熔斷 / 總風險 / 鏡子每一筆的 R・最多曾賠・同期 0050)+ 新增持倉的「買之前看一眼」
 *
 *  ① 熔斷:今天 / 本週(週一起)/ 本月 已實現損益 ÷ 帳戶 ≥ 2 / 5 / 8% → day / week / month;
 *     同一天賺的抵掉賠的、明天的紀錄不算、週日不算進這一週、沒填帳戶 → noacc;決定性對照:門檻改 3% → 同一份紀錄變 ok
 *  ② 總風險:從現價算到停損(全站那份 _hardStopOf;K 線沒抓到 → 成本 −5% 並記數)、已經在停損下面的 ⛔ 不算還會再賠、
 *     加上還沒買的那一筆
 *  ③ 每一筆:最多曾賠 / 曾賺從買進那天到賣出那天、R = 淨損益 ÷(買進時到停損的距離 × 股數)、停損走 _unifiedExitPlan(同一份)、
 *     同期 0050 扣 ETF 成本;缺買進日 / 賣在買之前 / 沒有 K 線 → null
 *  ④ 鏡子實際打開:最上面有熔斷 + 總風險,背景抓 K 線後 📐 那塊填進來;⛔ 不改使用者存的交易紀錄
 *  ⑤ 熔斷了 → 標題列那顆鈕看得到燈
 *  ⑥ 新增持倉視窗:填了成本股數才算、超過單筆風險設定要說、沒填帳戶要說出來
 *  ⑦ 新的字 ⛔ 🔴🟢(燈號鐵則)、⛔ 研究字樣(散戶 App 鐵則,跟 test_retail_clean 同一份清單)
 *  ⑩ V82.0.9 總風險只算有停損線的(👑 名單上 / 大跌撿便宜 / ETF ⛔ 算進「碰到停損」,另寫一行;決定性對照:集合清空 → 照舊算)
 *  ⑧ V80.0.9 決策台「🧯 你的風控」一行:大盤三種狀態(嚴格空頭 / 跌破 60 日線但還不算 / 在上面)讀 `_mktBear60` 那份、
 *     你的空頭守門設定跟著變(決定性對照:同一份大盤改設定)、有記賣出才顯示熔斷、總風險同 ②;⛔ 🔴🟢、⛔ 研究字樣;登記在 `_DECK_SECTIONS`
 * 跑法:node scripts/test_discipline.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) FAIL.push(n); };
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._acctBreaker === 'function', null, { timeout: 60000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const out = {};
    const A = app;
    // ── ① 熔斷 ──
    const T = '2026/10/30';   // 週五
    const st = (log, acc = 1e6) => A._acctBreaker(log, acc, T).state;
    out.day = st([{ date: '2026/10/30', pnlNTD: -25000 }]);
    out.dayOffset = st([{ date: '2026/10/30', pnlNTD: -25000 }, { date: '2026/10/30', pnlNTD: 10000 }]);
    out.week = st([{ date: '2026/10/26', pnlNTD: -55000 }]);
    out.sunday = st([{ date: '2026/10/25', pnlNTD: -55000 }]);
    out.month = st([{ date: '2026/10/03', pnlNTD: -90000 }]);
    out.lastMonth = st([{ date: '2026/09/30', pnlNTD: -90000 }]);
    out.future = st([{ date: '2026/10/31', pnlNTD: -90000 }]);
    out.noacc = st([{ date: '2026/10/30', pnlNTD: -25000 }], 0);
    out.dash = st([{ date: '2026-10-30', pnlNTD: -25000 }]);
    const L0 = A._BRK_LIM.day; A._BRK_LIM.day = 3; out.ctrl = st([{ date: '2026/10/30', pnlNTD: -25000 }]); A._BRK_LIM.day = L0;
    out.brkHtml = ['ok', 'day', 'week', 'month', 'noacc'].map(s => A._acctBreakerHtml({ state: s, sum: { day: -1, week: -1, month: -1 }, pct: { day: 1, week: 1, month: 1 }, lim: A._BRK_LIM })).join('\n');
    // ── ② 總風險 ──
    A._invKlineCache = {};
    const r1 = A._totalRisk([{ symbol: '9999', cost: 100, shares: 1, currentPrice: 110 }], 1e6);
    out.risk1 = { sum: r1.sum, nEst: r1.nEst, pct: +r1.pct.toFixed(2) };
    const r2 = A._totalRisk([{ symbol: '9999', cost: 100, shares: 1, currentPrice: 110 }], 1e6, { symbol: '8888', cost: 50, shares: 2 });
    out.risk2 = r2.sum;
    const r3 = A._totalRisk([{ symbol: '9999', cost: 100, shares: 1, currentPrice: 90 }], 1e6);
    out.risk3 = { sum: r3.sum, below: r3.below };
    out.riskNoAcc = A._totalRisk([{ symbol: '9999', cost: 100, shares: 1 }], 0).pct;
    out.riskHtml = A._totalRiskHtml(A._totalRisk([{ symbol: '9999', cost: 100, shares: 1, currentPrice: 200 }], 1e5));
    out.riskHtmlNoAcc = A._totalRiskHtml(A._totalRisk([{ symbol: '9999', cost: 100, shares: 1 }], 0));
    // ── ③ 每一筆 ──
    const mk = (n, f) => { const o = []; const d = new Date('2026-08-03T00:00:00'); while (o.length < n) { if (d.getDay() % 6) { const i = o.length; o.push({ date: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`, ...f(i) }); } d.setDate(d.getDate() + 1); } return o; };
    const kl = mk(40, i => i < 30 ? { open: 100, high: 101, low: 99, close: 100 }
        : i === 30 ? { open: 100, high: 101, low: 93, close: 100 }
        : i === 33 ? { open: 98, high: 99, low: 92, close: 97 }
        : i === 36 ? { open: 108, high: 112, low: 107, close: 110 } : { open: 102, high: 103, low: 101, close: 102 });
    const k50 = kl.map((b, i) => ({ date: b.date, close: i <= 30 ? 50 : 55 }));
    const bd = kl[30].date, sd = kl[38].date;
    const t = { symbol: 'X', cost: 100, sellPrice: 105, shares: 1, buyDate: bd, date: sd };
    const x = A._tradeExcursion(t, kl, k50);
    out.x = x;
    const plan = A._unifiedExitPlan(kl.slice(0, 31), 100, bd, {});
    out.stopRef = plan && plan.stopFinal > 0 ? +plan.stopFinal : 95;
    out.pnl = A._tradePnl(t).ntd;
    out.xNull = [A._tradeExcursion({ ...t, buyDate: null }, kl, k50), A._tradeExcursion({ ...t, date: kl[20].date }, kl, k50), A._tradeExcursion(t, null, k50)].every(v => v === null);
    out.xNo50 = A._tradeExcursion(t, kl, null).e50;
    // ── ④ 鏡子實際打開 ──
    A.settings.accountSize = 1e6;
    const log = [{ symbol: 'X', name: '測試甲', cost: 100, sellPrice: 105, shares: 1, buyDate: bd, date: sd, net: 1 },
                 { symbol: 'Y', name: '測試乙', cost: 100, sellPrice: 96, shares: 1, buyDate: bd, date: sd, net: 1 }];
    localStorage.setItem('proTerminalTradeLog', JSON.stringify(log));
    const before = localStorage.getItem('proTerminalTradeLog');
    A.fetchHistoricalData = async s => s === '0050' ? k50 : kl;
    A._xcCache = {};
    A._showTradeMirror();
    const body = document.getElementById('updateLogBody');
    out.hasRisk = !!body.querySelector('[data-mirrorrisk] [data-brk]');
    for (let k = 0; k < 40 && !body.querySelector('[data-mirrorxc]'); k++) await new Promise(r => setTimeout(r, 100));
    out.xcN = +(body.querySelector('[data-mirrorxc]')?.dataset.mirrorxc || 0);
    out.mirrorTxt = body.textContent;
    out.mirrorHtml = body.innerHTML;
    out.newHtml = (body.querySelector('[data-mirrorrisk]')?.outerHTML || '') + (document.getElementById('mirrorXc')?.outerHTML || '');   // ⑦ 只掃新加的兩塊(鏡子原本的勝率格不歸這支管)
    out.logSame = localStorage.getItem('proTerminalTradeLog') === before;
    // ⑤ 鈕
    const today = A.getTodayStr();
    localStorage.setItem('proTerminalTradeLog', JSON.stringify([{ symbol: 'X', cost: 100, sellPrice: 70, shares: 1, date: today, net: 1 }]));
    out.btn = A._tradeMirrorBtnHtml();
    localStorage.setItem('proTerminalTradeLog', JSON.stringify([{ symbol: 'X', cost: 100, sellPrice: 101, shares: 1, date: today, net: 1 }]));
    out.btnOk = A._tradeMirrorBtnHtml();
    localStorage.removeItem('proTerminalTradeLog');
    // ⑥ 新增持倉視窗
    const m = document.getElementById('invModal'); m.classList.remove('hidden'); m.style.display = 'flex';
    const det = document.getElementById('invPreTrade');
    out.hasDrawer = !!det && !!document.getElementById('invPreTradeBody');
    det.open = true; A._invPreTradeRender();
    out.preEmpty = document.getElementById('invPreTradeBody').textContent;
    document.getElementById('invCostInput').value = '100';
    document.getElementById('invSharesInput').value = '1000';
    document.getElementById('invCostInput').dispatchEvent(new Event('input'));
    out.preOne = document.getElementById('invPreTradeBody').innerHTML;
    A.settings.accountSize = 3e5; A._invPreTradeRender();
    out.preOver = document.getElementById('invPreTradeBody').textContent;
    A.settings.accountSize = 0; A._invPreTradeRender();
    out.preNoAcc = document.getElementById('invPreTradeBody').textContent;
    out.allNew = [out.brkHtml, out.riskHtml, out.riskHtmlNoAcc, out.newHtml, out.preOne, out.preOver, document.getElementById('invPreTrade').textContent].join('\n');
    return out;
});

ok('① 今天賠 2.5% → 今天熔斷', R.day === 'day', R.day);
ok('① 同一天賺的抵掉賠的(淨 1.5%)→ 正常', R.dayOffset === 'ok', R.dayOffset);
ok('① 週一賠 5.5% → 本週熔斷', R.week === 'week', R.week);
ok('① 上週日賠的 ⛔ 不算這一週(本月 5.5% < 8% → 正常)', R.sunday === 'ok', R.sunday);
ok('① 本月 9% → 本月熔斷', R.month === 'month', R.month);
ok('① 上個月的 ⛔ 不算', R.lastMonth === 'ok', R.lastMonth);
ok('① 明天的紀錄 ⛔ 不算', R.future === 'ok', R.future);
ok('① 日期寫成 2026-10-30 也認得', R.dash === 'day', R.dash);
ok('① 沒填帳戶 → noacc(⛔ 自己編本金)', R.noacc === 'noacc');
ok('① 決定性對照:門檻改 3% → 同一份紀錄變正常', R.ctrl === 'ok', R.ctrl);
ok('① 沒填帳戶要說出來', /還沒填帳戶資金/.test(R.brkHtml));
ok('① 門檻要寫「常見的建議值、不是本站算出來的」', /常見的建議值\(不是本站算出來的\)/.test(R.brkHtml), R.brkHtml.slice(-200));
ok('② 現價 110 → 停損 95(K 線沒抓到用成本 −5%)→ 賠 15,000 並記數', R.risk1.sum === 15000 && R.risk1.nEst === 1 && R.risk1.pct === 1.5, JSON.stringify(R.risk1));
ok('② 加上還沒買的那一筆(50 元 2 張 → 停損 47.5)', R.risk2 === 20000, R.risk2);
ok('② 已經在停損下面 ⛔ 算成還會再賠', R.risk3.sum === 0 && R.risk3.below === 1, JSON.stringify(R.risk3));
ok('② 沒填帳戶 → 佔比 null(⛔ 0%)', R.riskNoAcc === null);
ok('② 超過 6% 要說、沒填帳戶要說', /超過常見建議上限 6%/.test(R.riskHtml) && /填了帳戶資金才算得出/.test(R.riskHtmlNoAcc), R.riskHtml.slice(0, 200));
const x = R.x || {};
ok('③ 最多曾賠 / 曾賺 = 買進那天到賣出那天的最低 / 最高', x.mae === -8 && x.mfe === 12, JSON.stringify(x));
ok('③ 停損走全站同一份(_unifiedExitPlan;算不出來才成本 −5%)', x.stop === R.stopRef && x.stop <= 95, `${x.stop} vs ${R.stopRef}`);
ok('③ R = 淨損益 ÷(到停損的距離 × 股數)', x.R === +(R.pnl / ((100 - x.stop) * 1000)).toFixed(2), `${x.R} pnl ${R.pnl}`);
ok('③ 同期 0050 +10%、扣 ETF 成本', x.e50 && x.e50.pct === 10 && x.e50.ntd === 9615, JSON.stringify(x.e50));
ok('③ 缺買進日 / 賣在買之前 / 沒有 K 線 → null', R.xNull);
ok('③ 沒有 0050 → 只少那一欄', R.xNo50 === null && x.mae != null);
ok('④ 鏡子最上面有熔斷 + 總風險', R.hasRisk);
ok('④ 背景抓完 K 線,📐 那塊填進來(2 筆)', R.xcN === 2 && /平均每筆/.test(R.mirrorTxt) && /0050/.test(R.mirrorTxt), R.mirrorTxt.slice(-400));
ok('④ ⛔ 不改使用者存的交易紀錄', R.logSame);
ok('⑤ 今天賠 3% → 鈕上看得到 🟡', /🟡 今天先停手/.test(R.btn) && !/先停手/.test(R.btnOk), R.btn.slice(-120));
ok('⑥ 新增持倉視窗有「買之前看一眼」', R.hasDrawer);
ok('⑥ 沒填成本股數 → 說要填什麼', /填了成本和股數/.test(R.preEmpty));
ok('⑥ 填了 → 停損 95、這一筆碰到停損會賠多少', /data-pretrade="one"/.test(R.preOne) && /停損 95\.00/.test(R.preOne) && /買完之後/.test(R.preOne), R.preOne.slice(0, 300));
ok('⑥ 帳戶 30 萬 → 超過單筆風險設定要說', /超過你設定的單筆/.test(R.preOver), R.preOver.slice(0, 300));
ok('⑥ 沒填帳戶 → ⛔ 佔帳戶幾 %、要說出來', !/佔帳戶 \d/.test(R.preNoAcc) && /還沒填帳戶資金/.test(R.preNoAcc), R.preNoAcc.slice(0, 300));
ok('⑦ 新的字 ⛔ 🔴🟢(燈號只代表漲跌)', R.newHtml.length > 200 && !/[🔴🟢]/u.test(R.allNew));
const bad = badOf(R.allNew.replace(/<[^>]+>/g, ' '));
ok('⑦ 新的字 ⛔ 研究字樣(跟 test_retail_clean 同一份清單)', !bad.length, bad.join(' '));
// ⑧ 🧯 V80.0.9 決策台「你的風控」
const K = await page.evaluate(async () => {
    const A = app, o = {};
    A._isLead = () => false;
    A.settings.accountSize = 1000000;
    A.inventory = [{ symbol: '1234', cost: 100, shares: 1, currentPrice: 110 }];
    const mk = (on, c, ma20, ma60) => ({ mkt: { on, c, ma20, ma60, d: '2026-10-30' } });
    const _tl = A._tradeLogNet;
    A._tradeLogNet = () => [];
    A.settings.bearGate = false;
    o.bear = A._deckRiskHtml(mk(true, 40000, 42000, 43000));
    o.below = A._deckRiskHtml(mk(false, 44780, 47705, 46534));
    o.up = A._deckRiskHtml(mk(false, 48000, 47705, 46534));
    o.na = A._deckRiskHtml({});
    A.settings.bearGate = true;
    o.gateOn = A._deckRiskHtml(mk(true, 40000, 42000, 43000));
    A.settings.bearGate = false;
    const today = A.getTodayStr();
    A._tradeLogNet = () => [{ date: today, pnlNTD: -30000 }];
    o.brk = A._deckRiskHtml(mk(false, 48000, 47705, 46534));
    A._tradeLogNet = _tl;
    // ⑨ ⚡ V82.0.5 盤中即時警報關著那一行(⭐ 決定性對照:同一份大盤只換開關 / 策略)
    A.settings.watchlistAlert = false; o.alOff = A._deckRiskHtml(mk(false, 48000, 47705, 46534));
    A.settings.watchlistAlert = true; o.alOn = A._deckRiskHtml(mk(false, 48000, 47705, 46534));
    A.settings.watchlistAlert = false; A._isLead = () => true; o.alLead = A._deckRiskHtml(mk(false, 48000, 47705, 46534)); A._isLead = () => false;
    o.alDef = A.settings.watchlistAlert;
    // 「⚙️ 打開」:展開通知那一組、⛔ 替你把開關打開
    const ws = document.getElementById('set_watchlistAlert'), wd = ws && ws.closest('details');
    if (wd) wd.open = false;
    const before = ws ? ws.checked : null;
    A._openAlertSetting();
    await new Promise(r => setTimeout(r, 400));
    o.alDetOpen = !!(wd && wd.open); o.alChecked = ws ? ws.checked : null; o.alBefore = before; o.alSet = A.settings.watchlistAlert;
    try { A.closeSettings?.(); } catch (_) {}
    o.reg = (A._DECK_SECTIONS.find(c => c.k === 'risk') || null);
    o.shown = A._deckShow().risk;
    o.hasBox = !!document.getElementById('deckRisk');
    return o;
});
const KT = h => String(h || '').replace(/<[^>]+>/g, ' ');
ok('⑧ 嚴格空頭 → 寫「嚴格空頭」(data-deckrisk=bear)', /data-deckrisk="bear"/.test(K.bear) && /嚴格空頭/.test(KT(K.bear)), KT(K.bear).slice(0, 160));
ok('⑧ 跌破 60 日線但 20 日線還在上面 → 寫「還不算空頭」(10/30 那種)', /data-deckrisk="below60"/.test(K.below) && /還不算空頭/.test(KT(K.below)) && !/嚴格空頭/.test(KT(K.below).split('你的設定')[0]), KT(K.below).slice(0, 200));
ok('⑧ 在 60 日線上 → 不是空頭', /data-deckrisk="ok"/.test(K.up) && /不是空頭/.test(KT(K.up)));
ok('⑧ 大盤還沒算出來 → 要說(⛔ 空白)', /data-deckrisk="na"/.test(K.na) && /還沒算出來/.test(KT(K.na)));
ok('⑧ 你的設定跟著變(決定性對照:同一份大盤,守門關 → 照常買;開 → 不開新倉)', /data-deckriskgate="off"/.test(K.bear) && /照常買/.test(KT(K.bear)) && /data-deckriskgate="on"/.test(K.gateOn) && /不開新倉/.test(KT(K.gateOn)));
ok('⑧ 沒有賣出紀錄 → ⛔ 熔斷那行;今天賠 3% → 熔斷那行出現', !/帳戶熔斷/.test(KT(K.below)) && /帳戶熔斷/.test(KT(K.brk)), KT(K.brk).slice(0, 300));
ok('⑧ 總風險同 ②(現價 110 → 停損 95 → 15,000)', /15,000/.test(KT(K.up)), KT(K.up).slice(-260));
ok('⑧ 登記在 _DECK_SECTIONS、預設開、決策台有容器', !!K.reg && K.reg.def === true && !K.reg.unlock && !K.reg.st && K.shown === true && K.hasBox, JSON.stringify(K.reg));
ok('⑨ ⚡ 盤中即時警報關著 → 多一行「哪些 App 通知不會跳」+ ⚙️ 打開(決定性對照:打開 → 那一行消失;選 👑 → 不顯示)',
   /data-deckriskalert="off"/.test(K.alOff) && /盤中即時警報關著/.test(KT(K.alOff)) && !/data-deckriskalert/.test(K.alOn) && !/data-deckriskalert/.test(K.alLead), [KT(K.alOff).slice(0, 200)]);
ok('⑨ ⛔ 改預設(盤中即時警報預設仍是關)、⚙️ 打開 = 展開通知那一組、⛔ 替你把開關打開', K.alDef === false && K.alDetOpen && K.alChecked === K.alBefore && K.alSet === false, JSON.stringify([K.alDef, K.alDetOpen, K.alChecked, K.alBefore, K.alSet]));
// ⑩ 🧮 V82.0.9 總風險只算「有停損線的」(11/09 截圖:選 👑 時寫「6 檔已經在停損下面(照你的出場規則處理)」,
//    同一頁最上面卻寫「今天不用動」)→ 👑 名單上的 / 大跌撿便宜那一批 / ETF ⛔ 算進來,另外數幾檔
const S = await page.evaluate(() => {
    const A = app, o = {};
    const oL = A._leaderMine, oD = A._dipMine, oI = A._isLead;
    A._invKlineCache = {};
    const inv = [
        { symbol: '1111', cost: 100, shares: 1, currentPrice: 80 },   // 👑 名單上(跌 20%)
        { symbol: '2222', cost: 100, shares: 1, currentPrice: 80 },   // 大跌撿便宜那一批
        { symbol: '0050', cost: 100, shares: 1, currentPrice: 80 },   // ETF
        { symbol: '9999', cost: 100, shares: 1, currentPrice: 110 },  // 一般持股(停損 95 → 15,000)
    ];
    try {
        A._leaderMine = () => new Set(['1111']); A._dipMine = () => new Set(['2222']);
        const r = A._totalRisk(inv, 1e6);
        o.r = { n: r.n, below: r.below, sum: r.sum, skip: r.skip };
        o.html = A._totalRiskHtml(r);
        // ⭐ 決定性對照:同一份清單,👑 / 大跌撿便宜的集合清空 → 那兩檔照舊算進去(現價 80 < 停損 95 → 在停損下面)
        A._leaderMine = () => new Set(); A._dipMine = () => new Set();
        const c = A._totalRisk(inv, 1e6);
        o.c = { n: c.n, below: c.below, sum: c.sum, skip: c.skip };
        o.cHtml = A._totalRiskHtml(c);
        // 全部都沒有停損線 → 只印那一行(⛔ 整段安靜消失)
        A._leaderMine = () => new Set(['1111']); A._dipMine = () => new Set(['2222']);
        o.onlySkip = A._totalRiskHtml(A._totalRisk(inv.slice(0, 3), 1e6));
        // 🧯 那一行:選 👑 → 👑 名單上的照換倉日名次走;沒選 → 照舊
        const mk = { mkt: { on: true, c: 39702, ma60: 46415, ma20: 46134, d: '2026-11-06' } };
        A._isLead = () => true; o.leadLine = A._deckRiskHtml(mk);
        A._isLead = () => false; A._leaderMine = () => new Set(); o.geneLine = A._deckRiskHtml(mk);
    } finally { A._leaderMine = oL; A._dipMine = oD; A._isLead = oI; }
    return o;
});
ok('⑩ ⭐ 👑 名單上 / 大跌撿便宜 / ETF ⛔ 算進「碰到停損」:只剩一般那檔(15,000)、⛔「在停損下面」', S.r.n === 1 && S.r.below === 0 && S.r.sum === 15000 && S.r.skip.lead === 1 && S.r.skip.dip === 1 && S.r.skip.etf === 1, JSON.stringify(S.r));
ok('⑩ 另外寫一行「另 3 檔沒有停損線…這裡算不出來」', /另 3 檔沒有停損線/.test(KT(S.html)) && /算不出來/.test(KT(S.html)) && /👑 名單上 1 檔/.test(KT(S.html)) && /大跌撿便宜 1 檔/.test(KT(S.html)), KT(S.html).slice(-260));
ok('⑩ ⭐ 決定性對照:同一份清單把那兩個集合清空 → 那兩檔照舊算(在停損下面 2 檔)、ETF 照樣不算', S.c.n === 3 && S.c.below === 2 && S.c.skip.lead === 0 && S.c.skip.dip === 0 && S.c.skip.etf === 1, JSON.stringify(S.c));
ok('⑩ 沒選 👑(集合是空的)→ 一個 👑 字都沒有', !/👑/.test(S.cHtml), KT(S.cHtml));
ok('⑩ 全部都沒有停損線 → 只印那一行(⛔ 整段消失)', /data-totrisk="skip"/.test(S.onlySkip) && /另 3 檔沒有停損線/.test(KT(S.onlySkip)), KT(S.onlySkip));
ok('⑩ 🧯 那一行:選 👑 → 「👑 名單上的照換倉日名次走」;沒選 → 「每一筆照你的出場規則走」', /👑 名單上的照換倉日名次走/.test(KT(S.leadLine)) && /每一筆照你的出場規則走/.test(KT(S.geneLine)) && !/👑/.test(KT(S.geneLine).split('你的設定')[1] || ''), [KT(S.leadLine).slice(0, 260), KT(S.geneLine).slice(0, 260)].join(' ‖ '));
const KA = [K.bear, K.below, K.up, K.na, K.gateOn, K.brk, K.alOff].join(' ');
ok('⑧ ⛔ 🔴🟢、⛔ 研究字樣', !/[🔴🟢]/u.test(KA) && !badOf(KT(KA)).length, badOf(KT(KA)).join(' '));
ok('⓪ 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 項失敗' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
