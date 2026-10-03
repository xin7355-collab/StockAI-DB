#!/usr/bin/env node
// 📒 V78.2.2 領頭羊模擬帳**只在產業作戰室 📒 成績單**(使用者:「決策頁面裡面把模擬改買移到成績單裡面」)
//   (V78.0.3 ~ V78.2.1 決策台也有一份,兩邊逐筆比對;V78.2.2 起決策台那份刪掉,只留一行指路)
// ⛔ 這支釘的「用意」:
//   ① 決策台⛔ 不可再有模擬帳(函式 / 容器都沒有),只留一行指路(⛔ 不放連到 pro.html 的連結)
//   ② ⭐ 成績單的成交 = 換倉訊號隔天**開盤**(V78.2.2 回測最好的買法)—— 用 node 直接讀 K 線當獨立答案逐筆比
//   ③ 常數同一份:R / N / hyst / 錨點 跟散戶救星相同
//   ④ ⭐ 決定性對照:換倉名單倒過來 → 買的一起換人
//   ⑤ 名單有 b 旗標 → 照 b 買
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
const proRun = async () => pp.evaluate(async () => { PRO._rlK = {}; const o = await PRO._leaderLedgerLoad();
  return { trades: o.trades.filter(t => t.st).map(t => ({ sym: t.sym, d0: t.st.d0, entry: t.st.entry, exitP: t.st.exitP, open: t.st.open, net: t.st.net, lot: t.st.lot })), P: PRO._LEAD, cost: PRO._STL_COST, since: o.since }; });
const P0 = await proRun();


// ① 決策台沒有模擬帳
ok(!/_leaderLedger\(\)|_renderLeaderLedger|deckLeaderLedger|data-leaderledger=/.test(IDX) && /data-leaderledgerptr/.test(IDX) && /產業作戰室 → 📒 成績單 → 👑/.test(IDX),
  '① 決策台⛔ 不再有模擬帳(函式 / 容器都刪了),只留一行指路');
// ② 成交 = 隔天開盤(獨立答案:node 讀 K 線)
const kOpen = (sym, d) => { try { const k = JSON.parse(readFileSync(`data/${sym}.json`, 'utf8')); const r = k.find(x => String(x.date).replace(/\//g, '-').slice(0, 10) === d); return r ? +(+r.open).toFixed(2) : null; } catch (_) { return null; } };
const chk = P0.trades.map(t => ({ sym: t.sym, d0: t.d0, entry: +(+t.entry).toFixed(2), want: kOpen(t.sym, t.d0) })).filter(x => x.want != null);
ok(P0.trades.length > 0 && chk.length > 0 && chk.every(x => x.entry === x.want), '② ⭐ 成績單買價 = 換倉隔天的開盤價(node 讀 K 線逐筆比)', JSON.stringify(chk.slice(0, 5)));
const IE = IDX.match(/rule: \{ U: (\d+), N: (\d+), R: (\d+), L: (\d+), hyst: (\d+)/) || [], IA = (IDX.match(/anchor: '(\d{4}-\d{2}-\d{2})'/) || [])[1];
ok(+IE[2] === P0.P.N && +IE[3] === P0.P.R && +IE[5] === P0.P.hyst && IA === P0.P.anchor, '③ 常數跟散戶救星同一份(檔數 / 換倉天數 / 續抱名次 / 錨點)', JSON.stringify([IE.slice(1), IA, P0.P]));
// ④ 決定性對照
await injectPro(HREV);
const P1 = await proRun();
const a1 = JSON.stringify(P1.trades.map(norm)), a0 = JSON.stringify(P0.trades.map(norm));
ok(a1 !== a0 && P1.trades.length > 0, '④ ⭐ 決定性對照:換倉名單倒過來 → 買的一起換人', `${a0}\n${a1}`);
// ⑤ b 旗標
const HB = (() => { const j = JSON.parse(JSON.stringify(H)); const d = j.days.find(x => x.lead && x.lead.rows && x.lead.rows.length >= 10);
  const rs = d.lead.rows.slice().sort((a, c) => (+a.r || 99) - (+c.r || 99)); rs.forEach((r, i) => { r.b = i >= 5 && i < 10 ? 1 : 0; });
  d.lead.rows = rs; d.lead.pos = 85; return { j, d: d.d, want: rs.slice(5, 10).map(r => String(r.s)) }; })();
await injectPro(HB.j);
const P3 = await proRun();
const firstBuys = T => T.filter(t => t.d0 === (T[0] || {}).d0).map(t => String(t.sym)).sort();
ok(P3.trades.length > 0 && firstBuys(P3.trades).every(s => HB.want.includes(s)), '⑤ 📍 名單有 b 旗標(第 6~10 名才是要買的)→ 照 b 買', `want=${HB.want} pro=${firstBuys(P3.trades)}`);
ok(!errs.length, '⑥ 無 pageerror', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ LEADER_DECK_LEDGER_PASS');
process.exit(bad ? 1 : 0);
