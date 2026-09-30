#!/usr/bin/env node
// 📒 V78.0.3 決策台「照這套自動買賣到今天(模擬)」(使用者:「決策台沒有領頭羊自動買賣績效」)
// ⛔ 這支釘的「用意」:
//   ① ⭐ 跨檔:index.html `_leaderLedger` 每一筆(代號 / 買進日 / 買價 / 現價或賣價 / 抱著或賣了 / 扣完成本 %)
//      == pro.html 📒 成績單 `_leaderLedgerLoad`(同一份 pick_history.json + K 線)—— ⛔ 不可兩套規則
//   ② 常數同一份:limUp / cost / R / N / hyst / 錨點 兩邊相同
//   ③ 決策台真的畫出來(每一筆一列、有「模擬」與「App 讀不到真實成交」兩句誠實話)
//   ④ ⭐ 決定性對照:注入一筆假的換倉名單(把換倉日前 5 名換掉)→ 兩邊一起變、而且還是對得上
//   ⑤ 讀不到 pick_history → 說出原因(⛔ 不可空白)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c || !e ? '' : ' — ' + e}`); if (!c) bad++; };
for (const f of ['data/pick_history.json', 'data/^TWII.json']) if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)`); process.exit(1); }
const H = JSON.parse(readFileSync('data/pick_history.json', 'utf8'));
const leadDays = H.days.filter(d => d.lead && d.lead.rows && d.lead.rows.length).map(d => d.d);
if (!leadDays.length) { console.log('❌ data/pick_history.json 沒有任何 lead 名單 —— ⛔ 不跑假測試(git show origin/data:data/pick_history.json > data/pick_history.json)'); process.exit(1); }
const IDX = readFileSync('index.html', 'utf8'), PRO = readFileSync('pro.html', 'utf8');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const norm = t => ({ sym: String(t.sym), d0: t.d0, entry: +(+t.entry).toFixed(2), exitP: +(+t.exitP).toFixed(2), open: !!t.open, net: +(+t.net).toFixed(3), lot: t.lot });

// ── pro.html
const pp = await b.newPage(); pp.on('pageerror', e => errs.push('pro ' + String(e).slice(0, 160)));
await pp.goto(pathToFileURL(resolve('pro.html')).href);
await pp.waitForFunction(() => typeof PRO !== 'undefined' && PRO._leaderLedgerLoad, null, { timeout: 30000 });
// 🧪 file:// 攔不到網路請求 → 直接把兩邊讀檔那一支換掉(同一份改過的名單)
const HREV = (() => { const j = JSON.parse(JSON.stringify(H)); const d = j.days.find(x => x.lead && x.lead.rows && x.lead.rows.length);
  d.lead.rows = d.lead.rows.slice().reverse().map((r, i) => ({ ...r, r: i + 1 })); return j; })();   // 名次倒過來 → 買的 5 檔完全換人
const injectPro = (body) => pp.evaluate(B => { const o = PRO._fjOrig || (PRO._fjOrig = PRO.fetchJson);
  PRO.fetchJson = (u, ms) => /pick_history\.json/.test(u) ? Promise.resolve(B === 404 ? null : B) : o.call(PRO, u, ms); }, body);
const injectIdx = (body) => ip.evaluate(B => { const o = window._fOrig || (window._fOrig = window.fetch);
  window.fetch = (u, opt) => /pick_history\.json/.test(String(u)) ? Promise.resolve(B === 404 ? new Response('', { status: 404 }) : new Response(JSON.stringify(B), { status: 200 })) : o(u, opt); }, body);
const proRun = async () => pp.evaluate(async () => { PRO._rlK = {}; const o = await PRO._leaderLedgerLoad();
  return { trades: o.trades.filter(t => t.st).map(t => ({ sym: t.sym, d0: t.st.d0, entry: t.st.entry, exitP: t.st.exitP, open: t.st.open, net: t.st.net, lot: t.st.lot })), P: PRO._LEAD, cost: PRO._STL_COST, since: o.since }; });
const P0 = await proRun();

// ── index.html
const ip = await b.newPage({ viewport: { width: 390, height: 900 } }); ip.on('pageerror', e => errs.push('idx ' + String(e).slice(0, 160)));
await ip.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });
await ip.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded' });
await ip.waitForFunction(() => typeof app !== 'undefined' && app._leaderLedger, null, { timeout: 60000 });
const idxRun = async () => ip.evaluate(async () => { const o = await app._leaderLedger();
  return { trades: o.trades.map(t => ({ sym: t.sym, d0: t.d0, entry: t.entry, exitP: t.exitP, open: t.open, net: t.net, lot: t.lot })), E: app._LEADER_EDGE, since: o.since, err: o.err }; });
const I0 = await idxRun();
const a0 = JSON.stringify(P0.trades.map(norm)), b0 = JSON.stringify(I0.trades.map(norm));
ok(P0.trades.length > 0 && a0 === b0, '① ⭐ 跨檔:決策台模擬帳每一筆 == 產業作戰室成績單(代號 / 買進日 / 買價 / 現價 / 抱著 / 扣完成本 % / 一張)', `pro=${a0}\nidx=${b0}`);
const E = I0.E;
ok(E.ledger.limUp === P0.P.limUp && E.ledger.cost === P0.cost && E.rule.R === P0.P.R && E.rule.N === P0.P.N && E.rule.hyst === P0.P.hyst && E.anchor === P0.P.anchor,
  '② 常數兩邊同一份(漲停買不到門檻 / 來回成本 / 換倉天數 / 檔數 / 續抱名次 / 錨點)', JSON.stringify([E.ledger, P0.cost, P0.P]));

// ③ 畫面
const V = await ip.evaluate(async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  host.innerHTML = await app._leaderDeckHtml();
  for (let k = 0; k < 100; k++) { const b = document.getElementById('deckLeaderLedger'); if (b && b.dataset.leaderledger !== 'loading') break; await new Promise(r => setTimeout(r, 100)); }
  const b = document.getElementById('deckLeaderLedger');
  return { st: b && b.dataset.leaderledger, rows: b ? b.querySelectorAll('[data-llrow]').length : -1, txt: b ? b.innerText : '',
    sx: (window.scrollTo(80, 0), window.scrollX) };
});
ok(V.st === 'ok' && V.rows === I0.trades.length && /模擬/.test(V.txt) && /App 讀不到/.test(V.txt) && /扣來回成本/.test(V.txt) && V.sx <= 2,
  '③ 決策台畫出每一筆 + 寫明「模擬」「真實成交 App 讀不到」「已扣成本」、390px 不橫捲', JSON.stringify(V).slice(0, 400));
ok(!/[🔴🟢]/u.test(V.txt), '③b ⛔ 無 🔴🟢');

// ④ 決定性對照:名次倒過來 → 兩邊一起換人、仍然對得上
await injectPro(HREV); await injectIdx(HREV);
const P1 = await proRun(), I1 = await idxRun();
const a1 = JSON.stringify(P1.trades.map(norm)), b1 = JSON.stringify(I1.trades.map(norm));
ok(a1 === b1 && a1 !== a0 && P1.trades.length > 0, '④ ⭐ 決定性對照:換倉名單倒過來 → 兩邊買的一起換人,而且還是一筆一筆對得上', `${a0}\n${a1}\n${b1}`);

// ④b 📍 V78.0.5 採礦從這一版起存 b(= 真的會買的,已套一年位置)→ 兩邊都照 b 買(⛔ 不再是「前 5 名」);舊的日子沒有 b 照舊
const HB = (() => { const j = JSON.parse(JSON.stringify(H)); const d = j.days.find(x => x.lead && x.lead.rows && x.lead.rows.length >= 10);
  const rs = d.lead.rows.slice().sort((a, c) => (+a.r || 99) - (+c.r || 99)); rs.forEach((r, i) => { r.b = i >= 5 && i < 10 ? 1 : 0; });
  d.lead.rows = rs; d.lead.pos = 85; return { j, d: d.d, want: rs.slice(5, 10).map(r => String(r.s)) }; })();
await injectPro(HB.j); await injectIdx(HB.j);
const P3 = await proRun(), I3 = await idxRun();
const firstBuys = T => T.filter(t => t.d0 === (T[0] || {}).d0).map(t => String(t.sym)).sort();
const a3 = JSON.stringify(P3.trades.map(norm)), b3 = JSON.stringify(I3.trades.map(norm));
ok(a3 === b3 && P3.trades.length > 0 && firstBuys(I3.trades).every(s => HB.want.includes(s)) && !firstBuys(I3.trades).some(s => !HB.want.includes(s)),
  '④b 📍 名單有 b 旗標(第 6~10 名才是要買的)→ 兩邊都照 b 買、而且還是一筆一筆對得上', `want=${HB.want} idx=${firstBuys(I3.trades)} pro=${firstBuys(P3.trades)}`);

// ⑤ 讀不到 → 說原因
await injectIdx(404);
const I2 = await idxRun();
ok(I2.err && /pick_history/.test(I2.err), '⑤ 讀不到每日名單 → 說出原因(⛔ 不空白)', JSON.stringify(I2.err));
ok(/_renderLeaderLedger\(\)/.test(IDX) && /ledger: \{ limUp: /.test(IDX) && /_leaderLedgerLoad\(\)/.test(PRO), '⑥ 接線:名單畫完才補算模擬帳');
ok(!errs.length, '⑦ 無 pageerror', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ LEADER_DECK_LEDGER_PASS');
process.exit(bad ? 1 : 0);
