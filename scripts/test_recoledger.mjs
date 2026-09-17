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
const syms = new Set();
for (const d of H.days || []) {
  for (const x of d.pb || []) if (x && x.s) syms.add(String(x.s));
  for (const x of d.sig || []) if (x && x.s) syms.add(String(x.s));   // 📈 V77.2.5「符合進場」那幾檔也要
}
const K = {}; for (const s of syms) { const f = `data/${s}.json`; if (existsSync(f)) K[s] = JSON.parse(readFileSync(f, 'utf8')); }
ok((H.days || []).length >= 5 && Object.keys(K).length >= 20 && K2330.length > 300,
  '⓪ 空過守門:測資是真實產物', `${(H.days||[]).length} 天 / ${Object.keys(K).length} 檔 / 2330 ${K2330.length} 根`);

// 🚨 V77.2.5 launch 參數與 **預設 context** 都不可改:
//   「📈 符合進場」要靠 `PRO.loadIdx()` 去 `fetch('index.html')` 拿 🧬 門檻與黑名單,
//   file:// 下那個 fetch 需要 `--allow-file-access-from-files`,而且**開新 context 會失敗**
//   (實測 `newContext().newPage()` → `Failed to fetch`,`browser.newPage()` 才通)。
//   ⛔ 改回去的話 fit / mix 兩張會全部走到「算不出來」= 假失敗(陷阱 #40)。
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const pg = await b.newPage();
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
  window.__H = H;      // 📈 V77.2.5 下面幾條決定性對照要拿真實快照當輸入
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


// ══════════ 📈 V77.2.5 三張清單(使用者:「符合進場的也進到成績單裡面,重新回測,
//   用唐奇安及 atr 計算,另外用分頁區隔開高波動高基期及符合進場…另外可以用混搭的方式回測」)══════════
// ⛔ 五條不可違反(下面五種注入都要叫得出來):
//   ⑨a 三張分頁都在,而且換分頁**真的換一批資料**(⛔ 快取鍵漏了來源 = 一直看到上一張)
//   ⑨b 🧬 門檻與黑名單一律**現場讀 index.html 的 `_EDGE_RULES`**,⛔ pro.html 不可抄一份
//   ⑨c 舊快照沒有位階/振幅 → 回 `null`(重建不出來),⛔ 不可回空陣列冒充「那天 0 檔」
//   ⑨d 🧪 混搭 = 兩張聯集;任一張重建不出來就**整天不算**(⛔ 不可只算一半)
//   ⑨e 快照端的位階/振幅一律走 `screener_miner.build_one`(⛔ 不可讀 screener.json —— 它在
//       workflow 裡比這一步晚跑,那會拿**昨天**的位階配今天的訊號 = 跟畫面對不起來)
const fitDays = (H.days || []).filter(d => (d.sig || []).some(x => x && x.p != null && x.m != null));
ok(fitDays.length >= 1,
  '⑨⓪ 空過守門:快照裡至少要有一天帶位階/振幅(⛔ 沒有的話下面全部沒有鑑別力)',
  `${fitDays.length} 天 / 共 ${(H.days || []).length} 天`);

const srcRes = {};
for (const k of ['pb', 'fit', 'mix']) {
  await pg.evaluate(x => PRO.selRecoSrc(x), k);
  await pg.waitForFunction(y => PRO._rl && PRO._rl.src === y, k, { timeout: 40000 }).catch(() => {});
  await pg.waitForTimeout(1200);
  srcRes[k] = await pg.evaluate(() => {
    const el = document.getElementById('recoLedger');
    return {
      tabs: [...el.querySelectorAll('[data-recosrc]')].map(e => e.dataset.recosrc),
      on: [...el.querySelectorAll('[data-recosrc].on')].map(e => e.dataset.recosrc),
      syms: ((PRO._rl || {}).trades || []).map(t => t.sym).sort().join(','),
      n: ((PRO._rl || {}).trades || []).length,
      geneErr: (PRO._rl || {}).geneErr || null,
      since: (PRO._rl || {}).since || null,
      txt: (el.textContent || '').replace(/\s+/g, ' '),
    };
  });
}
ok(srcRes.pb.tabs.join(',') === 'pb,fit,mix' && srcRes.fit.on.join(',') === 'fit',
  '⑨a 三張分頁都在,而且點哪一張哪一張亮', `${srcRes.pb.tabs} / on=${srcRes.fit.on}`);
ok(!srcRes.pb.geneErr && !srcRes.fit.geneErr,
  '⑨a2 🧬 門檻要真的讀得到(⛔ 讀不到就會全部走「算不出來」= 下面沒有鑑別力)', String(srcRes.fit.geneErr));
// ⭐ 決定性對照:三張的**交易清單必須不一樣**(⛔ 全部一樣 = 快取鍵漏了來源,或 src 沒傳到底)
ok(srcRes.fit.n > 0 && srcRes.pb.syms !== srcRes.fit.syms,
  '⑨a3 ⭐ 決定性對照:換到「📈 符合進場」要換一批股票(⛔ 跟上一張一模一樣 = 沒接通)',
  `pb=${srcRes.pb.syms} ・fit=${srcRes.fit.syms}`);
// 🚨 ⛔ **不可**寫成「混搭筆數 ≥ 兩張裡的最大值」—— 那是錯的,而且它一度靠測資剛好通過:
//   混搭在「任一張重建不出來」的日子**整天不算**,而 `pb` 那張的可用天數比 `fit` 多
//   → 混搭的**天數本來就比 pb 少**(實測 pb=7 / fit=5 / mix=6)。
//   ⭐ 正確的用意:在混搭**真的涵蓋到**的那些日子裡,它要是兩張的**聯集** ——
//      所以 ① 起算日跟比較嚴的那張一致 ② 它必須包含 fit 的每一檔 ③ 而且比 fit 多。
const _mixSet = new Set(srcRes.mix.syms.split(',').filter(Boolean));
const _fitArr = srcRes.fit.syms.split(',').filter(Boolean);
ok(_fitArr.length > 0 && _fitArr.every(x => _mixSet.has(x)) && srcRes.mix.n > srcRes.fit.n,
  '⑨d 🧪 混搭在它涵蓋的日子裡是**聯集**:含 fit 的每一檔,而且比 fit 多',
  `pb=${srcRes.pb.n} fit=${srcRes.fit.n} mix=${srcRes.mix.n} ・fit=${srcRes.fit.syms} ・mix=${srcRes.mix.syms}`);
ok(/三張分頁的筆數⛔ 不可以相加|筆數⛔ 不可以相加/.test(srcRes.mix.txt),
  '⑨a4 ⛔ 要寫明「三張的筆數不可相加」(同一檔可能同時出現在兩張裡)');

// ⑨b 🧬 門檻是**現場讀**的 —— 決定性對照:把門檻改掉,名單要跟著變
const geneCtl = await pg.evaluate(() => {
  const day = (PRO._rlHist || null);
  const d = (window.__H.days || []).filter(x => (x.sig || []).some(y => y && y.p != null))[0];
  const before = (PRO._recoFitPicks(d) || []).length;
  const g = PRO._idxData.EDGE_RULES.gene, old = g.pos;
  g.pos = 999; const after = (PRO._recoFitPicks(d) || []).length; g.pos = old;
  return { before, after, pos: old };
});
ok(geneCtl.before > 0 && geneCtl.after === 0,
  '⑨b ⭐ 決定性對照:把 `_EDGE_RULES.gene.pos` 改成 999,名單要變 0 檔(⛔ 沒變 = 門檻寫死在 pro.html)',
  `門檻 ${geneCtl.pos} → ${geneCtl.before} 檔 ・改 999 → ${geneCtl.after} 檔`);

// ⑨b2 黑名單要真的擋 —— 決定性對照:把第一檔的打法改成黑名單裡的招
const blkCtl = await pg.evaluate(() => {
  const d = (window.__H.days || []).filter(x => (x.sig || []).some(y => y && y.p != null))[0];
  const picks = PRO._recoFitPicks(d) || [];
  if (!picks.length) return { before: 0, after: 0 };
  const row = (d.sig || []).find(x => String(x.s) === String(picks[0].s));
  const old = row.k; row.k = '低檔布局(撿便宜)';
  const after = (PRO._recoFitPicks(d) || []).length; row.k = old;
  return { before: picks.length, after };
});
ok(blkCtl.before > 0 && blkCtl.after === blkCtl.before - 1,
  '⑨b2 ⭐ 決定性對照:把一檔的打法換成黑名單裡的招,它要被擋掉(⛔ 沒擋 = 黑名單沒接)',
  `${blkCtl.before} → ${blkCtl.after}`);

// ⑨c 舊快照(沒有位階/振幅)必須回 null,⛔ 不可回空陣列
const nullCtl = await pg.evaluate(() => {
  const d = (window.__H.days || []).filter(x => (x.sig || []).some(y => y && y.p != null))[0];
  const clone = JSON.parse(JSON.stringify(d));
  for (const x of clone.sig) { x.p = null; x.m = null; }
  return { r: PRO._recoFitPicks(clone), mix: PRO._recoFitPicks(clone) === null };
});
ok(nullCtl.r === null,
  '⑨c 🚨 舊快照沒有位階/振幅 → 回 `null`(重建不出來),⛔ 不可回空陣列冒充「那天 0 檔」', String(nullCtl.r));

// ⑨d2 混搭:任一張是 null → 整天不算
const mixCtl = await pg.evaluate(() => {
  const days = (window.__H.days || []).filter(x => (x.sig || []).some(y => y && y.p != null));
  return { n: days.length, bothNeeded: /if \(!a \|\| !b\) return null;/.test(PRO._recoLedgerLoad.toString()) };
});
ok(mixCtl.bothNeeded,
  '⑨d2 🧪 混搭:任一張重建不出來就整天跳過(⛔ 只算一半 = 名不副實)');
// ⭐ 行為版(⛔ 上面那條只看原始碼,改寫成別的寫法就抓不到):混搭的**起算日**不可早於
//   比較嚴的那一張 —— 早了就代表它把「只有一張算得出來」的日子也算進去了。
ok(srcRes.mix.since && srcRes.fit.since && srcRes.mix.since >= srcRes.fit.since,
  '⑨d3 ⭐ 決定性對照:混搭的起算日⛔ 不可早於「📈 符合進場」的起算日(早了 = 只買了一張)',
  `mix ${srcRes.mix.since} ・fit ${srcRes.fit.since} ・pb ${srcRes.pb.since}`);

// ⑨e 快照端:位階/振幅走 screener_miner.build_one,⛔ 不可讀 screener.json
{
  const PS = readFileSync('pick_snapshot.py', 'utf8').split('\n')
    .filter(l => !l.trim().startsWith('#')).join('\n');       // 🚨 先剝註解(註解裡就寫著 screener.json)
  ok(/import screener_miner/.test(PS) && /build_one\(/.test(PS),
    '⑨e 快照端的位階/振幅走 `screener_miner.build_one`(⛔ 不可在 pick_snapshot 另寫一套公式)');
  ok(!/screener\.json/.test(PS),
    '⑨e2 🚨 ⛔ 不可讀 `screener.json` —— 它在 workflow 裡跑在這一步**之後**,會拿昨天的位階配今天的訊號');
  ok(/x\.get\('t'\)/.test(PS),
    '⑨e3 🐛 打法名稱要讀 `today_signals` 真正的欄名 `t`(⛔ 只試 title/k 會讓 `sig[].k` 全是 null → 黑名單整個擋不掉)');
  ok(/SIG_N/.test(PS) && !/\[:TOP_N\]\s*:?\s*$/m.test(PS.split('today_signals')[1] || ''),
    '⑨e4 看多訊號要存多一點(SIG_N)—— 🧬 那一檔可能排在第 30 名,只存前 20 會系統性漏掉');
}


// ══════════ 🔍 V77.2.6 使用者截圖抓到的三件事 ══════════
//   ⑩a 📏 畫面上⛔ 不可出現 4 位以上小數的價格(資料裡有 float32 殘留)
//   ⑩b 💰 同一列的「%」與「一張幾元」必須**同一個口徑**(⛔ 一個扣成本、一個沒扣 = 自己跟自己打架)
//   ⑩c 🛑 兩種出場算出一模一樣時,要**說出原因**(⛔ 不可印兩個一樣的數字卻不解釋)
await pg.evaluate(x => PRO.selRecoSrc(x), 'pb');
await pg.waitForFunction(() => PRO._rl && PRO._rl.src === 'pb', null, { timeout: 40000 }).catch(() => {});
await pg.waitForTimeout(1500);

const V = await pg.evaluate(() => {
  const el = document.getElementById('recoLedger');
  const txt = (el.textContent || '').replace(/\s+/g, ' ');
  const trades = ((PRO._rl || {}).trades || []).filter(t => t.st);
  return {
    longDec: (txt.match(/\d+\.\d{4,}/g) || []).slice(0, 5),
    // 💰 lot 必須 = 進場本金 × 扣完成本的 %(容許 1 元的四捨五入)
    money: trades.map(t => ({ sym: t.sym, ok: Math.abs(t.st.lot - t.st.entry * 1000 * t.st.net / 100) <= 1,
                              lot: t.st.lot, net: t.st.net, entry: t.st.entry })),
    // 🚨 決定性對照:進場價 == 出場價時,「%」與「元」必須同號(舊版會出現 −0.44% 配 +0 元)
    flat: trades.filter(t => t.st.entry === t.st.exitP).map(t => ({ sym: t.sym, net: t.st.net, lot: t.st.lot })),
    hasPx: typeof PRO._px === 'function',
    px: PRO._px(93.69999694824219),
    pxKeep: PRO._px(42.15),
  };
});
ok(V.hasPx && V.px === '93.7' && V.pxKeep === '42.15',
  '⑩a 📏 價格顯示一律收到 2 位小數(⛔ 也不可把 42.15 這種合法價改掉)', `${V.px} / ${V.pxKeep}`);
ok(V.longDec.length === 0,
  '⑩a2 ⭐ 決定性對照:整張成績單的文字裡⛔ 不可再出現 4 位以上小數(float32 殘留)', V.longDec.join(' '));
ok(V.money.length > 0 && V.money.every(m => m.ok),
  '⑩b 💰 每一列的「一張幾元」= 進場本金 × 扣完成本的 %(⛔ 不可一個扣成本一個沒扣)',
  V.money.filter(m => !m.ok).slice(0, 2).map(m => `${m.sym} lot=${m.lot} net=${m.net} entry=${m.entry}`).join(' | '));
ok(V.flat.every(f => Math.abs(f.net) < 1e-9 ? f.lot === 0 : (f.net < 0 && f.lot < 0)),
  '⑩b2 🚨 進場價 = 出場價那一列:% 是負的(扣了成本)→ 元也必須是負的(⛔ 舊版是 +0 元)',
  V.flat.map(f => `${f.sym} ${f.net}% / ${f.lot}元`).join(' | '));

// ⑩c 兩邊一樣 → 要講原因;兩邊不一樣 → ⛔ 不可亂講
const C = await pg.evaluate(() => {
  const el = document.getElementById('recoLedger');
  const txt = (el.textContent || '').replace(/\s+/g, ' ');
  const c = PRO._rlCmp || {};
  const a = c.don || {}, t = c.atr2 || {};
  const same = a.n > 0 && a.n === t.n && Math.abs((a.avg || 0) - (t.avg || 0)) < 1e-9;
  return { same, note: /兩邊數字一模一樣是對的/.test(txt), stop: a.stop, n: a.n,
           hasStop: Object.prototype.hasOwnProperty.call(a, 'stop') };
});
ok(C.hasStop, '⑩c0 `_recoSummary` 要回「幾筆是停損出場」(⛔ 沒有它就解釋不出為什麼兩邊一樣)');
ok(C.same === C.note,
  '⑩c 🛑 兩種出場算出一樣 → 必須說出原因;不一樣 → ⛔ 不可亂講',
  `一樣=${C.same} ・畫面有解釋=${C.note} ・停損 ${C.stop}/${C.n} 筆`);
ok(!C.same || C.stop === C.n,
  '⑩c2 ⭐ 而且「一樣」的成因要對得上:一樣的時候,已結算的那幾筆應該全都是停損出場',
  `停損 ${C.stop} / 共 ${C.n}`);

// 📏 採礦端也要修(⛔ 只修顯示 = 資料還是髒的,下一個讀它的人照樣中招)
{
  const MN = readFileSync('miner.py', 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  ok(/def _round_prices\(/.test(MN) && /_round_prices\(records\)/.test(MN),
    '⑩a3 📏 採礦端匯出前也要收小數(⛔ 只修顯示端 = 資料還是髒的)');
}

await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ RECOLEDGER_PASS(全部通過)');
process.exit(bad ? 1 : 0);
