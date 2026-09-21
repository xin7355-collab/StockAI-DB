// 🎣 V77.3.9 產業作戰室「🎣 釣魚」分頁(#tabRod)—— 釣魚池救回 + 魚改成 🧬 強勢高波動
//   使用者:「釣魚系統救回,另外裡面的魚改為強勢高波動,並重新敘述是用何種辦法篩選出來的,
//            在產業作戰室裡面另外新開一個釣魚分頁」。
//
// ⛔ 這支釘的「用意」(每一條都有注入驗證):
//   ① 分頁真的接上了(⛔ 特別防 tabRod / tabRot 只差一個字母的靜默切錯頁)
//   ② 🧬 是主角(預設池 + 排第一顆)
//   ③ ⛔ 一個池子都不准沉默 —— 每一池都要有實測狀態
//   ④ ⛔ 門檻與成績一律讀常數,不寫死(④b 還要證明它「真的印得出數字」,⛔ 不是 0)
//   ⑤ 🚨 池子的門檻 ≠ 拋竿的門檻,要主動講開
//   ⑥ 兩條限制(窗口偏多頭 / 贏不贏大盤取決於出場)⛔ 不可省
//   ⑦ 舊漏斗的死因要跟 `_CAST_DEAD` 對得上(⛔ 文案與常數不可脫鉤)
//   ⑧ 🏅 那池要寫 IC 與「別當排名」  ⑨ 名單只標註⛔ 不刪
//   ⑩ rAF 生命週期  ⑪ 背景/轉向的分頁判斷  ⑫ 📒 成績單點股名會動  ⑬ 個股彈窗那顆鈕
//   ⑭ ⛔ 無 pageerror(防陷阱 #42)  ⑮ `_HQ_RULE` 要跟採礦端一致
//
// ⚠️ launch 參數照抄 test_recoledger:`--allow-file-access-from-files` + `browser.newPage()`
//    (⛔ 不可 newContext()) —— 否則 `loadIdx()` 永遠失敗 = 假失敗(陷阱 #40)。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };

// ⓪ 空過守門 —— ⛔ 測資不是真實產物就直接 exit 1,不跑假測試
for (const f of ['data/screener.json', 'data/playbook_edge.json']) {
  if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }
}
const SCR = JSON.parse(readFileSync('data/screener.json', 'utf8'));
const PB = JSON.parse(readFileSync('data/playbook_edge.json', 'utf8'));
// ⚠️ `screener.json` 的 rows 是 **物件**(sym → 陣列)⛔ 不是陣列 —— 用 .length 會拿到 undefined
const nRows = Object.keys(SCR.rows || {}).length;
if (!(nRows >= 1000 && (PB.picks || []).length >= 1)) {
  console.log(`❌ 空過守門:screener ${nRows} 列 / playbook ${(PB.picks || []).length} 檔 —— ⛔ 太少,下面沒有鑑別力`);
  process.exit(1);
}
ok(true, '⓪ 空過守門:測資是真實產物', `screener ${nRows} 列 / playbook ${PB.picks.length} 檔`);

const SRC = readFileSync('pro.html', 'utf8');
const body = (head) => { const i = SRC.indexOf(head); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n  },', i)); };
const noComment = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const pg = await b.newPage();
await pg.emulateMedia({ reducedMotion: 'no-preference' });   // ⛔ 不然 `_fishStart` 不會排 rAF = ⑩ 假失敗
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderRod, null, { timeout: 30000 });

// ── ① 分頁接線 ───────────────────────────────────────────────
const T = await pg.evaluate(async () => {
  PRO.switchTab('rod'); await new Promise(r => setTimeout(r, 2500));
  const vis = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
  return { btn: (document.getElementById('tabBtnRod') || {}).textContent || '', inWrap: !!document.querySelector('.wrap #tabRod'),
           rod: vis('tabRod'), fish: vis('tabFish'), rot: vis('tabRot'), tab: PRO._tab,
           inTabs: !!document.querySelector('.tabs #tabBtnRod') };
});
ok(/釣魚/.test(T.btn) && T.inTabs && T.inWrap && T.rod && !T.fish && !T.rot && T.tab === 'rod',
  '① 分頁接線:#tabRod 在 .wrap 裡、切過去只有它亮(🚨 tabRod / tabRot 只差一個字母)',
  `btn=${T.btn.trim()} wrap=${T.inWrap} rod=${T.rod} fish=${T.fish} rot=${T.rot}`);
ok(/\['rod', 'Rod'\]/.test(SRC) && /if \(t === 'rod'\) this\._rodP = this\.renderRod\(\);/.test(SRC),
  '①b TABS 有註冊、switchTab 有 lazy render(⭐ 而且存 promise —— `_fishPick` 要 await 它)');

// ── ②③⑤⑥⑦⑧ 畫面內容 ────────────────────────────────────────
const R = await pg.evaluate(() => {
  const tab = document.getElementById('tabRod');
  for (const d of tab.querySelectorAll('details')) d.open = true;     // 🚨 關著的 <details> 讀不到 innerText
  const chips = [...document.querySelectorAll('#fishPool .fishpool')].map(e => ({ t: e.textContent.trim(), on: e.classList.contains('on'), tip: e.title || '' }));
  const ST = PRO._rodStatus();
  return {
    poolK: PRO._fishPoolK, chips, txt: (tab.innerText || '').replace(/\s+/g, ' '),
    pools: PRO.FISH_POOLS.map(p => p.k),
    st: Object.fromEntries(Object.entries(ST).map(([k, v]) => [k, { lv: v.lv, t: v.t, n: (v.why || '').length }])),
    dead: PRO._CAST_DEAD, hq: PRO._HQ_RULE, fishN: PRO._fish.length,
  };
});
ok(R.poolK === 'gene' && R.chips.length && /🧬/.test(R.chips[0].t) && R.chips[0].on,
  '② 🧬 強勢高波動是主角:預設池就是它,而且排第一顆並選中', `poolK=${R.poolK} 第一顆=${(R.chips[0] || {}).t}`);
const needPools = [...R.pools, 'fam', 'cast'];
ok(R.pools.length >= 7 && needPools.every(k => R.st[k] && R.st[k].lv && R.st[k].t && R.st[k].n >= 15),
  '③ ⛔ 一個池子都不准沉默:每一池都有實測狀態(徽章 + 一句話)',
  `${R.pools.length} 池 ・缺:${needPools.filter(k => !(R.st[k] && R.st[k].n >= 15)).join(',') || '無'}`);
ok(R.chips.every(c => c.tip.length >= 20), '③b 每一顆 chip 的說明都掛在 title 上', `最短 ${Math.min(...R.chips.map(c => c.tip.length))} 字`);
ok(/振幅/.test(R.txt) && /年化波動率/.test(R.txt) && /不是同一個數字/.test(R.txt),
  '⑤ 🚨 池子的門檻(振幅)≠ 拋竿的門檻(年化波動率)—— 要主動講開');
ok(/偏多頭/.test(R.txt) && /空頭沒有驗證過/.test(R.txt) && /取決於出場規則/.test(R.txt),
  '⑥ 兩條限制⛔ 一條都不可省(窗口偏多頭 / 贏不贏大盤取決於出場)');
ok(R.txt.includes(String(R.dead.relSector)) && R.txt.includes(String(R.dead.relGene))
   && R.txt.includes(String(R.dead.drop2)) && new RegExp(R.dead.pass + '/' + R.dead.gates).test(R.txt),
  '⑦ 舊漏斗的死因要跟 `_CAST_DEAD` 對得上(⛔ 文案與常數脫鉤 = 重跑探針畫面不會變)');
const edge = R.chips.find(c => /🏅/.test(c.t)) || { tip: '' };
ok(/IC/.test(edge.tip) && /別當排名/.test(edge.tip), '⑧ 🏅 那一池要寫 IC 與「⛔ 別當排名」', edge.tip.slice(0, 60));

// ── ④ ⛔ 門檻與成績不寫死 ────────────────────────────────────
const four = ['  _rodStatus() {', '  _rodPoolsHtml(pools) {', '  _rodWhyHtml(D) {', '  _rodCastNoteHtml() {'].map(h => noComment(body(h))).join('\n');
const stale = ['75', '3.2', '60', '589', '264'].filter(t => new RegExp('(?<![0-9.])' + t.replace('.', '\\.') + '(?![0-9])').test(four));
ok(four.length > 2000 && stale.length === 0
   && /_geneRule\(\)/.test(four) && /_HQ_RULE/.test(four) && /_SIG_DEEP/.test(four) && /_CAST_DEAD/.test(four),
  '④ ⛔ 門檻與成績一律讀常數,⛔ 不寫死(⭐ 重跑探針畫面要跟著變)', stale.length ? '殘留:' + stale.join(',') : `${four.length} 字`);
const cw = noComment(body('  _castWhyFull(sym) {'));
ok(/_SIG_DEEP/.test(cw) && /_HQ_RULE/.test(cw) && !/_DECK_TRACK49/.test(cw),
  '④a `_castWhyFull` 讀 `_SIG_DEEP`(🚨 `_DECK_TRACK49` 只存在於 index.html,舊寫法會印「+0 萬」)');
const W = await pg.evaluate(() => {
  const D = PRO._fishD, r = (D.rows || [])[0];
  PRO._cast = { picked: [{ ...r, sym: r.sym, pb: { k: 'X', w: 50, n: 20, exp: 1, lb: 0.5, rank: 80, vol: 70 }, warn: [] }], warnN: 0, thin: 0, avoided: [], disposed: [] };
  const h = PRO._castWhyFull(r.sym);
  return { w: [...h.matchAll(/\+([0-9.]+) 萬/g)].map(m => +m[1]), has0: /\+0 萬/.test(h) };
});
ok(W.w.length >= 2 && W.w.every(v => v > 0) && !W.has0,
  '④b ⭐ 決定性:「📖 這一條的細節」裡的實測成績要真的印得出數字(⛔ 不可是 +0 萬)', W.w.join(' / '));

// ── ⑨ 名單只標註⛔ 不刪 ──────────────────────────────────────
const cp = noComment(body('  _castPick(D) {'));
ok(/picked\.push\(/.test(cp) && !/if \(!w\.length\)\s*(\{)?\s*picked\.push/.test(cp),
  '⑨ `_castPick` 的 `picked.push` ⛔ 不在「沒有警示」的 if 裡面(名單只標註,不刪)');
const P = await pg.evaluate(() => {
  const orig = PRO._recoPicks;
  PRO._recoPicks = () => [{ s: 'AAA' }, { s: 'BBB' }];
  const R2 = PRO._castPick({ rows: [{ sym: 'AAA', att: 2, amt: 50 }, { sym: 'BBB', att: 0, amt: 50 }] });
  PRO._recoPicks = orig;
  return { n: R2.picked.length, warn: (R2.picked[0].warn || []).join(','), disp: R2.disposed.length };
});
ok(P.n === 2 && /disp/.test(P.warn) && P.disp === 1,
  '⑨b ⭐ 決定性:餵一檔處置中的進去 → 名單長度不變、只多一個警示(⛔ 不可被刪掉)', `n=${P.n} warn=${P.warn}`);

// ── ⑩⑪ rAF 生命週期 / 背景與轉向 ───────────────────────────
const L = await pg.evaluate(async () => {
  PRO.switchTab('rod'); await new Promise(r => setTimeout(r, 2000));
  const onRod = PRO._fishRaf, mode = PRO._fishModeV, n = PRO._fish.length;
  PRO.switchTab('fish'); await new Promise(r => setTimeout(r, 300));
  const onFish = PRO._fishRaf;
  PRO.switchTab('rot'); await new Promise(r => setTimeout(r, 300));
  const onRot = PRO._fishRaf;
  PRO.switchTab('rod'); await new Promise(r => setTimeout(r, 2000));
  return { onRod, onFish, onRot, back: PRO._fishRaf, mode, n };
});
ok(L.n > 0 && L.mode === 'tank' && L.onRod !== 0 && L.onFish === 0 && L.onRot === 0 && L.back !== 0,
  '⑩ 魚的 rAF:在 🎣 釣魚才跑,切走(成績單 / 板塊輪動)一律停,切回來要接上',
  `rod=${L.onRod} fish=${L.onFish} rot=${L.onRot} back=${L.back} ・${L.n} 條`);
const fs = noComment(body('  _fishSetup(rows, J) {'));
ok((fs.match(/_tab === 'rod'/g) || []).length === 2 && !/_tab === 'fish'/.test(fs),
  '⑪ 背景返回 / 轉橫向的分頁判斷要是 rod(⛔ 留著 fish = 靜默失效,而且不會報錯)');

// ── ⑫ 📒 成績單點股名會動(殭屍:舊版靜默無反應)──────────────
const C = await pg.evaluate(async () => {
  const sym = (PRO._fishD.rows || [])[0].sym;
  PRO.switchTab('fish'); await new Promise(r => setTimeout(r, 400));
  PRO._fishD = null;                                   // 🚨 模擬「一進來就先開成績單」的真實情況
  await PRO._fishPick(sym);
  const pick = document.getElementById('fishPickPane');
  return { sym, tab: PRO._tab, hidden: pick.classList.contains('hidden'),
           len: (document.getElementById('fishCard').innerText || '').replace(/\s+/g, '').length };
});
ok(C.tab === 'rod' && !C.hidden && C.len > 80,
  '⑫ 📒 成績單點股票名稱 → 自動跳 🎣 釣魚並展開那一檔(⛔ 舊版靜默無反應)',
  `${C.sym} tab=${C.tab} 卡片 ${C.len} 字`);

// ── ⑬⑮ 靜態 ────────────────────────────────────────────────
ok(/PRO\._fishPoolK='fam';PRO\.switchTab\('rod'\)/.test(SRC) && !/PRO\._fishPoolK='fam';PRO\.switchTab\('fish'\)/.test(SRC),
  '⑬ 個股彈窗「🎣 把這一族放下水」要跳 🎣 釣魚(⛔ 舊版跳到成績單 = 文案與行為打架)');
const PS = readFileSync('scripts/playbook_scan.mjs', 'utf8');
const mR = /r\.rank\s*>=\s*(\d+)/.exec(PS), mV = /r\.vol\s*>=\s*(\d+)/.exec(PS);
ok(mR && mV && +mR[1] === R.hq.pos && +mV[1] === R.hq.vol,
  '⑮ 🚨 `_HQ_RULE` 要等於採礦端 playbook_scan 標 hq 的門檻(⛔ 改一邊 = 畫面在講另一套)',
  `採礦端 ${mR && mR[1]}/${mV && mV[1]} ・pro.html ${R.hq.pos}/${R.hq.vol}`);

// ── ⑭ ⛔ 無 pageerror(防陷阱 #42:template literal 被反引號註解切斷)──
await pg.evaluate(async () => {
  for (let i = 0; i < 3; i++) {
    for (const t of ['rod', 'fish', 'star', 'rod']) { PRO.switchTab(t); await new Promise(r => setTimeout(r, 250)); }
  }
});
ok(errs.length === 0, '⑭ ⛔ 整段來回切分頁不可有 pageerror', errs.slice(0, 2).join(' | '));

await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ FISHROD_PASS(全部通過)');
process.exit(bad ? 1 : 0);
