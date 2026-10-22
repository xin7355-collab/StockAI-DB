// 🏁 V79.5.3 成績單重新起算 + 100 萬同一天起跑(含 0050)
//   使用者 10/22:「成績單的部分設計重新計時日期起點,另外在新增設 0050 一起比拼」→ 預設起算日選「10/22 新規則上線」
//
// ⛔ 釘住(INJECT=1 注入五種壞寫法,每一種都要叫得出來):
//   ⓐ 跨檔:pro `_RECO_PICKS` == index `_DECK_TRACK49.picks`;`_CAP_RULE.lot` == index cap × posPct%;
//      `_RACE_PCOST` == portfolio_backtest PARK_COST 預設(⛔ 改一邊會被擋)
//   ⓑ 起算日:預設 10/22;存 9/24 → 讀到 9/24;不合法(未來 / 太早 / 亂寫)→ 預設;選回預設 = 刪掉鍵(⛔ 不存死)
//   ⓒ 🔥 收盤 < 觸發價不買、≥ 才買(收盤價成交);沒有觸發價不買;已抱著不重買
//   ⓓ 🅿️ 現金不夠先賣 0050;🔥(錢放現金)錢不夠就不買
//   ⓔ 沒有任何買進 → 🅿️ == 📏(停車 = 0050 買了放著)、🔥 == 100 萬
//   ⓕ 0050 碰到除息:📏 / 🅿️ 都有加(決定性對照:拿掉股利 → 變少)
//   ⓖ 📒 🔥 那頁也是新買法,而且換起算日結果跟著變
//   ⓗ 決定性對照:0050 成本 0 + 價格不動 → 🅿️ == 🔥(停車那段沒有任何影響);0050 漲 → 🅿️ > 🔥
//   ⓘ 👑:每檔 = 總資產 ÷ N、開盤進出;起算日之前的換倉不算(空手開始)
//   ⓙ 畫面:#recoRace 在 #recoCmpAll 前面、四列、起算日選擇、⛔ 無 🔴🟢、390px 不溢出、無 pageerror
//   ⓚ 舊 🏁 表的 0050 == 這張的 📏(同一個數字,⛔ 同名不同義)
// 跑法:node scripts/test_recorace.mjs ・INJECT=1 node scripts/test_recorace.mjs(注入必紅)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PB = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8');

// 🧪 注入:每一種壞寫法 → 至少一條要紅
const INJ = {
  notrig: ["if (!(c >= trig)) { cnt.miss++; continue; }", "if (false) { cnt.miss++; continue; }"],
  nopark: ["if (park && cash < lot && psh > 0 && p > 0) {   // 🅿️", "if (false && park && cash < lot && psh > 0 && p > 0) {   // 🅿️"],
  nostart: ["if ((F || D) < S) continue;", "if (false) continue;"],
  nodiv: ["const tr = this._poliTr(bars, evs, { stock: true });", "const tr = this._poliTr(bars, [], { stock: true });"],
  nols: ["try { const v = localStorage.getItem('proRecoStart'); if (this._recoStartOk(v)) return v; } catch (_) {}", ""],
};

async function run(html) {
  const fails = [];
  const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
  // ⓐ 跨檔(只看原始碼)
  const pk = (html.match(/_RECO_PICKS: (\d+),/) || [])[1], ip = (IDX.match(/_DECK_TRACK49: \{[^}]*?picks: (\d+)/) || [])[1];
  const lot = +(html.match(/_CAP_RULE: \{ lot: (\d+), cap: (\d+)/) || [])[1], cap = +(html.match(/_CAP_RULE: \{ lot: (\d+), cap: (\d+)/) || [])[2];
  const icap = +(IDX.match(/_DECK_TRACK49: \{[^}]*?cap: (\d+)/) || [])[1], ipos = +(IDX.match(/_DECK_TRACK49: \{[^}]*?posPct: (\d+)/) || [])[1];
  const pc = (html.match(/_RACE_PCOST: ([\d.]+),/) || [])[1], epc = (PB.match(/const PARK_COST = \+\(process\.env\.PARK_COST \|\| ([\d.]+)\)/) || [])[1];
  ok('ⓐ 跨檔:一天幾檔 / 每筆幾元 / 本金 / 0050 來回成本 == index `_DECK_TRACK49` 與回測引擎', pk && pk === ip && lot === icap * ipos / 100 && cap === icap && pc && pc === epc,
     JSON.stringify({ pk, ip, lot, cap, icap, ipos, pc, epc }));

  let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recorace-')), 'pro.html');
  fs.writeFileSync(tmp, html);
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.goto(pathToFileURL(tmp).href);
  await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._raceHot, null, { timeout: 30000 });

  // ── 合成資料(平日日曆 9/01 ~ 10/30;0050 每天 +0.1;個股自己設)──
  const R = await page.evaluate(() => {
    const out = {};
    const wk = (a, b) => { const r = []; for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) r.push(d.toISOString().slice(0, 10)); } return r; };
    const CAL = wk('2026-09-01', '2026-10-30');
    const days = CAL.filter(d => d >= '2026-10-01');            // 起算日 10/01
    const b50 = CAL.map((d, i) => ({ d, c: 100 + i * 0.1 }));
    const flat50 = CAL.map(d => ({ d, c: 100 }));
    const kl = (px) => CAL.map(d => { const c = px[d] ?? 50; return { date: d.replace(/-/g, '/'), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; });
    const [d0, d1, d2, d3] = days;                               // d0 = 起算日
    out.days = days; out.d = { d0, d1, d2, d3 };
    // A:名單日 d0 → d1 收盤 55 ≥ 觸發價 54 → 買;B:d1 收盤 50 < 54 → 不買;C:沒有觸發價;A 在 d1 名單又出現 → 已抱著不重買
    const K = { A: kl({ [d1]: 55, [d2]: 55, [d3]: 55 }), B: kl({}), C: kl({ [d1]: 80 }) };
    const lists = new Map([[d0, [{ s: 'A', trig: 54 }, { s: 'B', trig: 54 }]], [d1, [{ s: 'A', trig: 50 }, { s: 'C', trig: null }]]]);
    const H = PRO._raceHot({ days, lists, K, b50, div: null, rule: 'atr2', park: false });
    out.c = { buy: H.cnt.buy, miss: H.cnt.miss, notrig: H.cnt.notrig, held: H.cnt.held, t0: H.trades[0] && { sym: H.trades[0].sym, d: H.trades[0].d, entry: H.trades[0].entry, ld: H.trades[0].ld } };
    // ⓓ 停車:第一天收盤全部停進 0050 → 買 A 時現金是 0 → 要先賣 0050
    const Pk = PRO._raceHot({ days, lists, K, b50, div: null, rule: 'atr2', park: true });
    out.dPark = { buy: Pk.cnt.buy, nocash: Pk.cnt.nocash };
    const lots = new Map([[d0, [{ s: 'A', trig: 54 }, { s: 'B', trig: 40 }, { s: 'C', trig: 40 }]]]);
    const Ch = PRO._raceHot({ days, lists: lots, K, b50, div: null, rule: 'atr2', park: false, lot: 400000 });
    out.dCash = { buy: Ch.cnt.buy, nocash: Ch.cnt.nocash };
    // ⓔ 沒有買進:🅿️ == 📏、🔥 == 100 萬
    const empty = new Map();
    const P0 = PRO._raceHot({ days, lists: empty, K, b50, div: null, rule: 'atr2', park: true }), C0 = PRO._raceHot({ days, lists: empty, K, b50, div: null, rule: 'atr2', park: false });
    const E0 = PRO._race50({ days, b50, div: null });
    const fin = x => x.eq[x.eq.length - 1].v;
    out.e = { p: fin(P0), c: fin(C0), e: fin(E0), cap: PRO._CAP_RULE.cap };
    // ⓕ 0050 除息(第 5 天每股 1 元)
    const dx = days[4], before = b50.find(b => b.d === CAL[CAL.indexOf(dx) - 1]).c;
    const div = { '0050': { h: [[dx, 1.0, '息', before, before - 1]] } };
    const E1 = PRO._race50({ days, b50, div }), P1 = PRO._raceHot({ days, lists: empty, K, b50, div, rule: 'atr2', park: true });
    out.f = { e0: fin(E0), e1: fin(E1), p0: fin(P0), p1: fin(P1) };
    // ⓗ 決定性對照:0050 成本 0 + 價格不動 → 🅿️ == 🔥;0050 漲 → 🅿️ > 🔥
    const keep = PRO._RACE_PCOST; PRO._RACE_PCOST = 0;
    const Pf = PRO._raceHot({ days, lists, K, b50: flat50, div: null, rule: 'atr2', park: true }), Cf = PRO._raceHot({ days, lists, K, b50: flat50, div: null, rule: 'atr2', park: false });
    PRO._RACE_PCOST = keep;
    out.h = { pf: fin(Pf), cf: fin(Cf), pu: fin(Pk), cu: fin(H) };
    // ⓗ2 注入「拿掉觸發判斷」的行為版:觸發價設成 1 → 筆數一定變多
    const loose = new Map([[d0, [{ s: 'A', trig: 1 }, { s: 'B', trig: 1 }]]]);
    out.h2 = { strict: H.cnt.buy, loose: PRO._raceHot({ days, lists: loose, K, b50, div: null, rule: 'atr2', park: false }).cnt.buy };
    // ⓘ 👑:兩檔、N = 2 → 每檔 50 萬;L1 在 d3 開盤以 12 賣掉
    const KL = { L1: kl({}), L2: kl({}) };
    const trades = [{ sym: 'L1', st: { d0: d1, entry: 10, d1: d3, exitP: 12, open: false } }, { sym: 'L2', st: { d0: d1, entry: 20, d1: d3, exitP: 20, open: true } }];
    const Ld = PRO._raceLead({ days, trades, K: KL, b50, div: null, park: false, N: 2 });
    out.i = { buy: Ld.cnt.buy, sold: Ld.cnt.sold, cash: Ld.cash, live: Ld.live.map(x => ({ s: x.sym, a0: Math.round(x.a0), sh: x.sh })) };
    return out;
  });
  ok('ⓒ 🔥 收盤 ≥ 觸發價才買(買在名單隔天收盤)、收盤沒到不買、沒有觸發價不買、已抱著不重買',
     R.c.buy === 1 && R.c.miss === 1 && R.c.notrig === 1 && R.c.held === 1 && R.c.t0 && R.c.t0.sym === 'A' && R.c.t0.d === R.d.d1 && R.c.t0.entry === 55 && R.c.t0.ld === R.d.d0, JSON.stringify(R.c));
  ok('ⓓ 🅿️ 錢全停在 0050 時照樣買得到(先賣 0050);🔥 錢不夠那一筆就不買', R.dPark.buy === 1 && R.dPark.nocash === 0 && R.dCash.buy === 2 && R.dCash.nocash === 1, JSON.stringify([R.dPark, R.dCash]));
  ok('ⓔ 沒有買進:🅿️ == 📏(停車 = 0050 買了放著)、🔥 == 100 萬', Math.abs(R.e.p - R.e.e) < 1e-6 && R.e.c === R.e.cap && R.e.e > R.e.cap * 0.99, JSON.stringify(R.e));
  ok('ⓕ 0050 除息:📏 / 🅿️ 都有加,而且兩邊差不到萬分之一(決定性對照:拿掉股利 → 變少)', R.f.e1 > R.f.e0 + 1 && R.f.p1 > R.f.p0 + 1 && Math.abs(R.f.p1 - R.f.e1) / R.f.e1 < 1e-4, JSON.stringify(R.f));
  ok('ⓗ ⭐ 決定性對照:0050 不動且沒成本 → 🅿️ == 🔥;0050 一路漲 → 🅿️ > 🔥(停車那段真的有算)', Math.abs(R.h.pf - R.h.cf) < 1e-6 && R.h.pu > R.h.cu, JSON.stringify(R.h));
  ok('ⓗ2 ⭐ 觸發價放寬到 1 元 → 買進筆數一定變多(觸發判斷真的有作用)', R.h2.loose > R.h2.strict, JSON.stringify(R.h2));
  ok('ⓘ 👑 每檔 = 總資產 ÷ N(開盤進出):兩檔各 50 萬,L1 在 12 元賣掉 → 現金 = 50,000 股 × 12 − 成本 0.44%',
     R.i.buy === 2 && R.i.sold === 1 && R.i.live.length === 1 && R.i.live[0].s === 'L2' && R.i.live[0].a0 === 500000 && Math.abs(R.i.cash - (50000 * 12 - 500000 * 0.0044)) < 1e-6, JSON.stringify(R.i));

  // ⓑ 起算日
  const B = await page.evaluate(() => {
    const r = {};
    localStorage.removeItem('proRecoStart'); r.def = PRO._recoStart();
    PRO.selRecoStart('2026-09-24'); r.set = PRO._recoStart(); r.stored = localStorage.getItem('proRecoStart');
    PRO.selRecoStart('2099-01-01'); r.future = PRO._recoStart(); r.futureKey = localStorage.getItem('proRecoStart');
    localStorage.setItem('proRecoStart', '2020-01-01'); r.early = PRO._recoStart();
    localStorage.setItem('proRecoStart', '亂寫'); r.junk = PRO._recoStart();
    PRO.selRecoStart('2026-09-24'); PRO.selRecoStart(PRO._RECO_START_DEF); r.backKey = localStorage.getItem('proRecoStart');
    r.DEF = PRO._RECO_START_DEF;
    return r;
  });
  ok('ⓑ 起算日:預設 10/22、存 9/24 讀得到、未來 / 太早 / 亂寫 → 預設、選回預設 = 刪掉鍵(⛔ 不存死)',
     B.def === '2026-10-22' && B.DEF === '2026-10-22' && B.set === '2026-09-24' && B.stored === '2026-09-24' && B.future === B.DEF && B.futureKey === null && B.early === B.DEF && B.junk === B.DEF && B.backKey === null, JSON.stringify(B));

  // ⓖ 📒 🔥 那頁也是新買法 + 換起算日跟著變;ⓘ2 👑 起算日之前的換倉不算;ⓙ 畫面;ⓚ 0050 同一個數字
  const G = await page.evaluate(async () => {
    const wk = (a, b) => { const r = []; for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) r.push(d.toISOString().slice(0, 10)); } return r; };
    const CAL = wk('2026-06-01', '2026-10-22');                  // 最後一天 = 10/22(今天):10/22 那份名單要等明天
    const m = new Map(CAL.map((d, i) => [d, 20000 + i]));
    PRO._twii = { m, days: CAL.slice() }; PRO._twiiLoad = async () => PRO._twii;
    const i21 = CAL.indexOf('2026-10-21'), i22 = CAL.indexOf('2026-10-22');
    const kl = (px) => CAL.map(d => { const c = px[d] ?? 50; return { date: d.replace(/-/g, '/'), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; });
    const K = { X1: kl({ '2026-10-22': 56 }), X2: kl({}), Y1: kl({}), '0050': CAL.map((d, i) => ({ date: d.replace(/-/g, '/'), open: 100 + i * 0.05, high: 101, low: 99, close: 100 + i * 0.05, volume: 1 })) };
    // 👑 名單:錨點 9/24 起每 10 天;9/24 與 10/08 兩次名單一樣(前 5 名 L1~L5)
    const lead = { rows: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'].map((s, i) => ({ s, c: 100, r: i + 1, x: 30 - i })), n: 100, passed: 40 };
    for (const s of lead.rows.map(r => r.s)) K[s] = kl({});
    const calA = CAL.filter(d => d >= '2026-09-24');
    const H = { days: [
      { d: '2026-10-21', rule: 'mean', pb: [{ s: 'X1', c: 50, k: 'x', lb: 1, exp: 5, r: 1, o: 1, trig: 55, hq: 1, bear: 0 }, { s: 'X2', c: 50, k: 'x', lb: 1, exp: 4, r: 1, o: 1, trig: 55, hq: 1, bear: 0 }] },
      { d: '2026-10-22', rule: 'mean', pb: [{ s: 'Y1', c: 50, k: 'y', lb: 1, exp: 5, r: 1, o: 1, trig: 52, hq: 1, bear: 0 }] },
      { d: calA[0], lead }, { d: calA[10], lead },
    ] };
    PRO.fetchJson = async (u) => {
      if (/pick_history/.test(u)) return H;
      if (/dividends_hist/.test(u)) return { d: {} };
      const mm = String(u).match(/data\/(.+)\.json/); const s = mm ? decodeURIComponent(mm[1]) : '';
      return K[s] || [];
    };
    PRO._poliDiv = null; PRO._rlK = {};
    const r = {};
    localStorage.setItem('proRecoStart', '2026-10-21');
    const a = await PRO._recoLedgerLoad('atr2', 'pb');
    r.a = { mech: a.mech, n: a.trades.length, t: a.trades.map(t => ({ s: t.sym, d: t.d, ld: t.ld, e: t.st && t.st.entry })), miss: a.miss.length, pend: a.pend.map(x => x.sym), start: a.start };
    localStorage.removeItem('proRecoStart');
    const b = await PRO._recoLedgerLoad('atr2', 'pb');
    r.b = { n: b.trades.length, pend: b.pend.map(x => x.sym), start: b.start };
    // 👑 起算日:9/24(錨點那天)→ 第一次換倉就買;起算日挪到第一次成交日之後 → 第一次不算、第二次從空手買
    const l1 = await PRO._leaderLedgerLoad({ from: '2026-09-24' }), l2 = await PRO._leaderLedgerLoad({ from: calA[2] });
    r.l1 = { d0: [...new Set(l1.trades.map(t => t.st && t.st.d0))], n: l1.trades.length };
    r.l2 = { d0: [...new Set(l2.trades.map(t => t.st && t.st.d0))], n: l2.trades.length, F1: calA[1], F2: calA[11] };
    // ⓙ 畫面(起算日 9/24:四套都有東西)
    localStorage.setItem('proRecoStart', '2026-09-24');
    PRO._raceSig = null; PRO._race = null; PRO._cmpAllSig = null; PRO._cmpAll = null; PRO._rlSig = null; PRO._rl = null;
    try { PRO.switchTab('fish'); } catch (_) {}
    PRO._recoLedgerRender();
    for (let i = 0; i < 160 && !(document.querySelector('[data-race="ok"]') && document.querySelector('[data-cmpall="ok"]')); i++) await new Promise(q => setTimeout(q, 100));
    const race = document.getElementById('recoRace'), cmp = document.getElementById('recoCmpAll');
    r.j = { ok: !!document.querySelector('[data-race="ok"]'), order: !!(race && cmp && (race.compareDocumentPosition(cmp) & Node.DOCUMENT_POSITION_FOLLOWING)),
            rows: race ? [...race.querySelectorAll('[data-racerow]')].map(e => e.dataset.racerow) : [], chips: race ? race.querySelectorAll('[data-recostart]').length : 0,
            svg: race ? race.querySelectorAll('[data-raceline]').length : 0, txt: race ? race.innerText : '', sw: document.documentElement.scrollWidth,
            on: race ? [...race.querySelectorAll('[data-recostart].on')].map(e => e.dataset.recostart) : [] };
    window.scrollTo(80, 0); r.j.sx = window.scrollX; window.scrollTo(0, 0);
    // ⓚ 舊 🏁 表的 0050 == 這張的 📏
    const C = await PRO._recoCmpAllLoad();
    const etf = (C.rows || []).find(x => x.k === 'etf'), e50 = ((PRO._race || {}).rows || []).find(x => x.k === '0050');
    r.k = { etf: etf && etf.avg, race: e50 && e50.pct, err: etf && etf.err };
    localStorage.removeItem('proRecoStart');
    return r;
  });
  ok('ⓖ 📒 🔥 那頁 = 新買法:10/21 名單 → 10/22 收盤 56 ≥ 55 才買(X1 買、X2 沒到),10/22 名單等明天收盤',
     G.a.mech === 'trig' && G.a.n === 1 && G.a.t[0].s === 'X1' && G.a.t[0].d === '2026-10-22' && G.a.t[0].ld === '2026-10-21' && G.a.t[0].e === 56 && G.a.miss === 1 && G.a.pend.join() === 'Y1', JSON.stringify(G.a));
  ok('ⓖ2 換起算日跟著變:預設 10/22 → 10/21 那筆不算(0 筆、只剩等明天的 Y1)', G.b.start === '2026-10-22' && G.b.n === 0 && G.b.pend.join() === 'Y1', JSON.stringify(G.b));
  ok('ⓘ2 👑 起算日之前的換倉不算、從空手開始:起算日在第一次成交之後 → 第二次換倉才買滿前 5 名',
     G.l1.n === 5 && G.l1.d0.join() === G.l2.F1 && G.l2.n === 5 && G.l2.d0.join() === G.l2.F2, JSON.stringify([G.l1, G.l2]));
  ok('ⓙ 畫面:#recoRace 在 #recoCmpAll 前面、四列(🅿️ / 🔥 / 👑 / 📏)、起算日 3 個 + 自訂、四條線',
     G.j.ok && G.j.order && G.j.rows.join() === 'park,hot,lead,0050' && G.j.chips === 4 && G.j.svg === 4 && G.j.on.join() === '2026-09-24', JSON.stringify({ ...G.j, txt: undefined }));
  ok('ⓙ2 ⛔ 無 🔴🟢、390px 不橫向溢出、有「⛔ 現在還不能說誰比較厲害」', !/[🔴🟢]/u.test(G.j.txt) && G.j.sx <= 2 && /現在還不能說誰比較厲害/.test(G.j.txt), `sx=${G.j.sx} sw=${G.j.sw}`);
  ok('ⓚ 舊 🏁 表的 0050 == 這張的 📏(同一個數字)', G.k.etf != null && G.k.race != null && Math.abs(G.k.etf - G.k.race) < 1e-9, JSON.stringify(G.k));
  ok('ⓩ 無 pageerror', errs.length === 0, errs.join(' | '));
  await browser.close();
  return fails;
}

if (process.env.INJECT) {
  let bad = 0;
  for (const [k, [a, b]] of Object.entries(INJ)) {
    if (!SRC.includes(a)) { console.log(`❌ 注入 ${k}:找不到要改的那一行(測試過期了)`); bad++; continue; }
    process.env.QUIET = '1';
    const f = await run(SRC.replace(a, b));
    console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? '紅:' + f.join(' / ').slice(0, 160) : '⛔ 全綠(這個注入沒被抓到)'}`);
    if (!f.length) bad++;
  }
  console.log(bad ? `\n❌ ${bad} 種注入沒被抓到` : '\n✅ 五種注入全部叫得出來');
  process.exit(bad ? 1 : 0);
}
const f = await run(SRC);
console.log(f.length ? `\n❌ ${f.length} 條失敗:${f.join(' / ')}` : '\n✅ RECORACE_PASS(全部通過)');
process.exit(f.length ? 1 : 0);
