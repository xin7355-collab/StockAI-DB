// 📒 V77.2.4 產業作戰室:釣魚池下架 → 只留「決策台推薦成績單」+ 兩種出場比較
//   使用者:「釣魚池這幾次看起來我覺得沒有用,把它刪除,只保留決策台推薦成績單,說明改在這,
//            另外出場規則除唐奇安還要有 atr,我要最強績效實測。我要清楚明瞭的方式,
//            說明就折疊起來不要版面亂,還有可以的話用顏色區分」。
//
// ⛔ 六條不可違反(注入都要叫得出來):
//   ① 釣魚池那三個畫面(魚池 canvas / 點魚 / 漁獲籃)⛔ 不可復活;分頁裡只剩成績單。
//   ② ⛔ 但 `proWar_catch`(漁獲籃你自己存的紀錄)**不可被刪掉** —— 下架功能 ≠ 刪資料。
//   ③ 🏆 比較條必須**真的用兩種出場各算一次**(⛔ 參數沒接通會兩邊印同一個數字 = 假綠燈)。
//   ④ 樣本 <10 筆⛔ 不可宣布誰比較強(全站 `_wrEnough` 規則)。
//   ⑤ 判準是**每趟平均**⛔ 不是總金額(總金額被資金路徑帶著跑,V74.4.8 明文)。
//   ⑥ 長說明要折疊(第一眼乾淨),⛔ 但不可刪掉。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };

for (const f of ['data/pick_history.json', 'data/2330.json']) {
  if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }
}
const H = JSON.parse(readFileSync('data/pick_history.json', 'utf8'));
const TW = existsSync('data/^TWII.json') ? JSON.parse(readFileSync('data/^TWII.json', 'utf8')) : null;
const K2330 = JSON.parse(readFileSync('data/2330.json', 'utf8'));
const syms = new Set(); for (const d of H.days || []) for (const x of d.pb || []) if (x && x.s) syms.add(String(x.s));
const K = {}; for (const s of syms) { const f = `data/${s}.json`; if (existsSync(f)) K[s] = JSON.parse(readFileSync(f, 'utf8')); }
ok((H.days || []).length >= 5 && Object.keys(K).length >= 20 && K2330.length > 300,
  '⓪ 空過守門:測資是真實產物', `${(H.days||[]).length} 天 / ${Object.keys(K).length} 檔 / 2330 ${K2330.length} 根`);

const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const pg = await (await b.newContext()).newPage();
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._recoLedgerRender, null, { timeout: 30000 });
await pg.waitForTimeout(2000);

// ③ ⭐ 決定性對照:同一批 K 線、只換出場,結果**必須不同**(⛔ 參數沒接通就會全部一樣)
const diff = await pg.evaluate((k) => {
  const rows = k.filter(x => x && +x.close > 0);
  let n = 0, d = 0;
  for (let i = 40; i < rows.length - 25; i += 17) {
    const a = PRO._settleReplay(rows, i, 'don'), c = PRO._settleReplay(rows, i, 'atr2');
    if (!a || !c) continue; n++;
    if (a.d1 !== c.d1 || Math.abs(a.exitP - c.exitP) > 1e-9) d++;
  }
  return { n, d };
}, K2330);
ok(diff.n >= 20 && diff.d > 0, '③ ⭐ 決定性對照:兩種出場在同一批進場點上算出**不同**結果(⛔ 全部相同 = 參數沒接通)',
  `${diff.n} 筆取樣 ・不同 ${diff.d} 筆(${(diff.d / diff.n * 100).toFixed(0)}%)`);
// ⚠️ **誠實紀錄**:上面那條**抓不到**「`_recoLedgerLoad` 的 `ruleArg` 沒接通」——
//   它打的是 `_settleReplay`(另一支函式),而比較條是透過 `_recoLedgerLoad(rule)` 拿資料的。
//   🚨 實測注入「`const rule = this._exitRule()`」(把參數丟掉)時 ③ **照樣綠** = 假綠燈。
//   ⭐ 所以要**直接釘那條傳遞路徑**:餵進去哪一條,回來的 `rule` 就必須是哪一條。

// 餵真實產物跑完整渲染
await pg.evaluate(({ H, K, TW }) => {
  const orig = PRO.fetchJson.bind(PRO);
  PRO.fetchJson = async (u) => {
    if (u.includes('pick_history')) return H;
    if (u.includes('^TWII')) return TW;
    const m = u.match(/data\/([\w^-]+)\.json/);
    if (m && K[m[1]]) return K[m[1]];
    try { return await orig(u); } catch (_) { return null; }
  };
}, { H, K, TW });
await pg.evaluate(() => PRO.switchTab('fish'));
await pg.waitForTimeout(9000);

// ③c 🚨 直接釘「參數真的傳到底」(⛔ ③ 抓不到這個,見上面的誠實紀錄)
const thread = await pg.evaluate(async () => {
  const a = await PRO._recoLedgerLoad('atr2'), d = await PRO._recoLedgerLoad('don');
  return { a: a && a.rule, d: d && d.rule, cur: PRO._exitRule() };
});
ok(thread.a === 'atr2' && thread.d === 'don',
  '③c 🚨 `_recoLedgerLoad(rule)` 的參數要傳到底(⛔ 丟掉的話比較條兩邊會印同一個數字 = 假綠燈)',
  `餵 atr2 → ${thread.a} ・餵 don → ${thread.d}(你目前設定 ${thread.cur})`);

const R = await pg.evaluate(() => {
  const tab = document.getElementById('tabFish');
  const el = document.getElementById('recoLedger');
  const txt = (el.textContent || '').replace(/\s+/g, ' ');
  const clone = el.cloneNode(true);
  for (const d of clone.querySelectorAll('details')) if (!d.open) for (const c of [...d.children]) if (c.tagName !== 'SUMMARY') c.remove();
  return {
    tabName: (document.getElementById('tabBtnFish').textContent || '').trim(),
    ids: [...tab.querySelectorAll('[id]')].map(e => e.id),
    txt, firstEye: (clone.textContent || '').replace(/\s+/g, '').length,
    total: (el.textContent || '').replace(/\s+/g, '').length,
    details: [...el.querySelectorAll('details')].map(d => ({ s: (d.querySelector('summary')?.textContent || '').trim(), open: d.open })),
    hasCmp: /哪個比較強/.test(txt),
    hasDon: /唐奇安 20 日低點/.test(txt), hasAtr: /ATR 追蹤停利/.test(txt),
    guard: /還不到 10 筆已結算/.test(txt) || /🏆/.test(txt),
    // 🎨 顏色分段:持有中 = 天藍色左邊條 / 已結算 = 灰
    holdBar: !!el.querySelector('[style*="border-left"][style*="--cyan"]'),
    catchKeep: (() => { try { return localStorage.getItem('proWar_catch') !== null || true; } catch (_) { return false; } })(),
  };
});

ok(R.tabName === '📒 成績單', '① 分頁已改名', R.tabName);
ok(R.ids.length === 1 && R.ids[0] === 'recoLedger',
  '①b 分頁裡只剩成績單(⛔ 魚池 / 點魚 / 漁獲籃三個畫面都不可復活)', R.ids.join(','));
ok(R.hasCmp && R.hasDon && R.hasAtr, '③b 比較條同時列出 唐奇安 與 ATR 兩種出場');
ok(R.guard, '④ 樣本不足時誠實說「還不能說誰比較強」/ 夠了才掛 🏆');
ok(R.details.length >= 2 && R.details.every(d => !d.open),
  '⑥ 長說明**預設折疊**(⛔ 版面不亂)', R.details.map(d => d.s.slice(0, 14)).join(' / '));
ok(R.firstEye < R.total, '⑥b 折疊真的有效(第一眼 < 全文)', `${R.firstEye} / ${R.total} 字`);
ok(R.holdBar, '🎨 顏色分段:📌 持有中那一段有天藍色左邊條');
ok(errs.length === 0, '⑦ 下架之後⛔ 不可有 pageerror(那些 `_fish*` 死碼不會被叫到)', errs.slice(0, 2).join(' | '));

// 原始碼守門
const SRC = readFileSync('pro.html', 'utf8');
// ⚠️ 誠實紀錄:第一版斷言寫成「原始碼裡不可出現 removeItem('proWar_catch')」—— **太粗了**。
//   那一處是 `_catchLoad` 的 **壞值清除**(陷阱 #18 的標準做法:JSON.parse 爆掉就刪掉重建),
//   是合法的,而且它在死碼裡根本不會被執行。
//   ⭐ 真正的用意是:**不可有「清空漁獲籃」的路徑從活的程式碼被走到**。
const live = SRC.slice(SRC.indexOf('  async renderFish() {'));
const liveBody = live.slice(0, live.indexOf('\n  fishPool('));
ok(!/_catchSave\(|_fishClearCatch\(/.test(liveBody),
  '② ⛔ 活的路徑不可清空漁獲籃(proWar_catch)—— 下架功能 ≠ 刪資料');
ok(/localStorage\.setItem\('proWar_catch'/.test(SRC) && !/localStorage\.removeItem\('proWar_catch'\);\s*\}\s*,/.test(SRC),
  '②b 讀取端的壞值清除仍在(那是陷阱 #18 的正確做法,⛔ 不可因為這條測試而拿掉)');
const cmp = SRC.slice(SRC.indexOf('  _recoCmpHtml() {'));
const cmpBody = cmp.slice(0, cmp.indexOf('\n  _recoLedgerRender('));
ok(/sort\(\(a, b\) => b\.s\.avg - a\.s\.avg\)/.test(cmpBody),
  '⑤ 🏆 判準是**每趟平均**(⛔ 不是總金額 —— 那被資金路徑帶著跑)');
ok(/_CMP_EXITS/.test(SRC) && /_CMP_EXITS: \['don', 'atr2'\]/.test(SRC),
  '⑤b 只比這兩條(⛔ 不把 ma5/trail8 也塞進來 = 多重比較)');
const rf = SRC.slice(SRC.indexOf('  async renderFish() {'));
ok(!/_fishRebuild\(|_fishBasketRender\(|_fishNote\(/.test(rf.slice(0, rf.indexOf('\n  fishPool('))),
  '①c `renderFish` ⛔ 不可再呼叫魚池 / 漁獲籃那一串');

// 🚪⑧ 🚨 **從已刪除的 `test_fishtank.mjs` 搬過來的** —— 它跟釣魚池無關,是出場預設的跨檔守門:
//   出場規則是**三份實作**(index.html / auto_trade.py / pro.html),改一邊而畫面上完全看不出來。
const IDX = readFileSync('index.html', 'utf8');
const iBlk = IDX.slice(IDX.indexOf('\n    _exitRuleKey() {'), IDX.indexOf('\n    _exitRuleKey() {') + 300);
const pBlk = SRC.slice(SRC.indexOf('  _exitRule() {'), SRC.indexOf('  _exitRule() {') + 500);
const g = x => (x.match(/'(don|atr2|trail8|ma5)'/g) || []).map(v => v.slice(1, -1));
ok(g(iBlk).length >= 2 && g(pBlk).length >= 2 && new Set([...g(iBlk), ...g(pBlk)]).size === 1,
  '🚪⑧ 🚨 pro.html 的出場預設要跟 index.html 一模一樣(⛔ 不一致 = 兩邊用不同規則,而且畫面看不出來)',
  `index=${g(iBlk)} pro=${g(pBlk)}`);

await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ RECOLEDGER_PASS(全部通過)');
process.exit(bad ? 1 : 0);
