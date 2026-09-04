#!/usr/bin/env node
/**
 * 🎣 釣魚池(pro.html 第 5 個分頁)測試 — V74.3.5
 *
 * ⛔ 釘住的鐵則(每一條都用「注入已知缺陷 → 確認叫得出來」驗過):
 *  ① 零新採礦:只讀 screener.json + top_correlations.json;⛔ 不可出現 daily_stocks / fetch_daily。
 *  ② 視覺屬性綁實測維度,圖例要寫數字(+1.52pp / +1.44pp);⛔ 沒有純裝飾。
 *  ③ 只描述:⛔ 整段不可出現買賣指令;文案必寫「不是買進訊號」「魚游得快 ≠ 會漲」。
 *  ④ 🐟 ↔ 📊 一鍵切換,列表 = 同一批魚(數量必須一樣)。
 *  ⑤ 切走分頁 / 頁面隱藏 → rAF 必停;reduced-motion 只畫一張。
 *  ⑥ ETF 不下水;null 不下水(⛔ 不補 0);Canvas 不能用 → 退回列表 + 說原因。
 *  ⑦ 資料停在 4 天以上 → 標題旁掛「⚠️ 資料未更新」(規格的 SPOF 批判)。
 *
 * ⚠️ 測資一律用**真實產物**裁下來的(scripts/fixtures/),⛔ 不憑印象編格式(陷阱 #40)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const SCR = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/screener.sample.json'), 'utf8'));
const COR = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/top_correlations.sample.json'), 'utf8'));
// 🏅 實測成績表:直接用真的產物(它本來就是從 index.html 匯出的資料,不是測資)
const EDGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scr_edge.json'), 'utf8'));
// 💰 除權息測資(格式照 div_probe 實跑印出的欄位);⚠️ 日期一律相對「今天」平移,
//    ⛔ 不可寫死 —— 「未來 30 天」那張表 30 天後就會變成假失敗(V72.1.8:測試不可綁會浮動的資料狀態)
const DIV = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/dividends.sample.json'), 'utf8'));
// 🏆 明日作戰清單測資 —— ⚠️ 欄位照真產物(git show origin/gh-pages:data/playbook_edge.json)
//    s 代號 / k 招式 / w 勝率 / n 次數 / exp 每趟 / lb 保守下界 / trig 觸發價 / stop 停損 / c 昨收 / up 要漲% / hq 🧬 / bear 空頭 / loose 不看價位
const PBE = { data_date: '2026-09-01', scanned: 2319, picks: [
  { s: '2330', k: '爆量長紅', w: 55, n: 20, exp: 2.1, lb: 0.9, trig: 1200, stop: 1140, c: 1180, up: 1.7, hq: 1 },
  { s: '2408', k: '突破頸線', w: 48, n: 14, exp: 3.4, lb: 1.8, trig: 120, stop: 114, c: 118, up: 1.7, hq: 1 },
  { s: '8299', k: '回後買上漲', w: 41, n: 9,  exp: 5.0, lb: 0.2, trig: 0, stop: 0, c: 500, hq: 0, loose: 1, bear: 1 },
  // 🚨 同一檔出現第二次(不同招、排名較後)—— 真產物就長這樣(206 筆裡 6949 出現兩次)
  { s: '2408', k: '⛔ 比較差的那一招', w: 30, n: 11, exp: 1.0, lb: 0.1, trig: 999, stop: 900, c: 118, up: 1.0, hq: 1 },
] };
{
  const off = Math.floor((Date.now() - Date.UTC(2026, 8, 1)) / 864e5);
  const sh = d => new Date(Date.parse(d + 'T00:00:00Z') + off * 864e5).toISOString().slice(0, 10);
  for (const v of Object.values(DIV.d)) { v.h = v.h.map(x => [sh(x[0]), ...x.slice(1)]); v.up = v.up.map(x => [sh(x[0]), x[1]]); }
  DIV.d['2317'] = { h: [], up: [[sh('2026-10-20'), 5.8]] };   // 49 天後 → ⛔ 不該進「未來 30 天」
}
import { execFileSync } from 'child_process';

const noCmt = t => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
                    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const seg = name => {
  const i = src.indexOf(`\n  ${name}(`) >= 0 ? src.indexOf(`\n  ${name}(`) : src.indexOf(`\n  async ${name}(`);
  if (i < 0) return ''; const j = src.indexOf('\n  },', i); return j < 0 ? '' : src.slice(i, j);
};
const FISHJS = ['_fishData', '_fishPoolRows', '_fishSchools', 'renderFish', 'fishMode', '_fishRebuild', '_fishListHtml',
                '_fishSetup', '_fishLegend', '_fishStart', 'fishStop', '_fishTick', '_fishPick', '_fishNote',
                '_scrEval', '_fishScore', '_fishScoreHtml', '_catchLoad', '_catchSave', '_fishCatch', '_fishRelease', '_fishBasketRender'].map(seg).join('\n');
ok('⓪ 魚池 14 支函式都抓得到', FISHJS.length > 5000 && seg('_fishTick').length > 300 && seg('_fishPick').length > 300, FISHJS.length);

const NC = noCmt(src);
ok('① ⛔ 沒有另做 daily_stocks.json / fetch_daily.py / IndexedDB(重複造輪子)',
   !/daily_stocks|fetch_daily|indexedDB|IndexedDB/.test(NC) && !fs.existsSync(path.join(ROOT, 'data_pipeline')));
ok('①b 資料走共用 fetchJson(跟其他分頁同一份 screener,⛔ 不可另抓一份)',
   /fetchJson\('data\/screener\.json'\)/.test(seg('_fishData')) && /starFetch\(\)/.test(seg('_fishData')));
ok('② 圖例寫著實測數字(位階 +1.52pp / 動能 +1.44pp)', /1\.52pp/.test(seg('_fishLegend')) && /1\.44pp/.test(seg('_fishLegend')));
ok('②b 🧬 池子門檻跟泡泡圖同一組(75 / 3.2)', /pos252 >= 75 && r\.amp20 >= 3\.2/.test(src));
// ⚠️ V74.4.5 使用者:「釣到之後是都依紀律出場嗎?獲利之後要怎麼出場?」
//    → 魚池現在**要**給出場紀律(停損/出場線),⛔ 但仍然不給**進場**指令。
//    ⛔ 所以禁的是「叫你買」的字,⛔ 不是「停損」——那正是使用者要的東西。
ok('③ ⛔ 魚池區塊不出現**進場**指令(⛔ 出場紀律不在此限)',
   !/(進場價|掛單|買點|該買|可以買|建議買|目標價|可加碼|放心做多)/.test(noCmt(FISHJS)),
   (noCmt(FISHJS).match(/(進場價|掛單|買點|該買|可以買|建議買|目標價|可加碼|放心做多)/) || [''])[0]);
ok('③e 🚪 出場那段:要有停損 + 5 日線 + 「借過來的」誠實話,⛔ 而且不可混進進場指令',
   /停損/.test(seg('_exitBody')) && /5 日線/.test(seg('_exitBody'))
   && /借過來/.test(seg('_castExitHtml')) && /沒有替它單獨驗過/.test(seg('_castExitHtml'))
   && !/(進場價|買點|目標價|該買)/.test(seg('_exitBody') + seg('_castExitHtml')));
ok('③f 🚪 出場數字要讀 BT 情境庫(⛔ 不可在文案裡寫死第二份)',
   /_exitRow\('跌破 5 日線\(現行\)'\)/.test(seg('_castExitHtml')) && /_exitRow\('移動停利 8%'\)/.test(seg('_castExitHtml'))
   && /k === 'exit'/.test(seg('_exitRow')));
ok('③b 文案必寫「不是買進訊號」與「魚游得快 ≠ 會漲」',
   /(不是|沒有一條魚是)買進訊號/.test(seg('_fishLegend')) && /魚游得快 ≠ 會漲/.test(seg('_fishLegend')) &&
   /魚游得快 ≠ 會漲/.test(seg('_fishNote')) && /不是買進訊號/.test(seg('_fishNote')));
ok('⑤ 切走分頁會 fishStop', /if \(t !== 'fish'\) this\.fishStop\(\)/.test(src));
ok('⑤b 頁面隱藏會停、回來才續(visibilitychange)', /visibilitychange/.test(seg('_fishSetup')) && /document\.hidden\) this\.fishStop/.test(seg('_fishSetup')));
ok('⑤c 尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(seg('_fishStart')));
ok('⑥ ETF 不下水', /r\[iEtf\] === 1\) continue/.test(seg('_fishData')));
ok('⑥b null 不下水(⛔ 不補 0)', /every\(Number\.isFinite\)\) continue/.test(seg('_fishData')));
ok('⑧ 魚的顏色只表今日漲跌(紅漲綠跌)、狀態用 🚀🔥(⛔ 不用 🔴🟢)',
   /f\.chg > 0 \? '#ff6b6b' : f\.chg < 0 \? '#4ade80'/.test(seg('_fishTick')) && !/[🔴🟢]/u.test(FISHJS));
ok('⑨ 位階參考線 25/50/75 有畫(⛔ 沒參考線位置不可解讀)', /\[75, 50, 25\]/.test(seg('_fishTick')));
ok('⑩ 魚數上限 100(每條都畫名字,手機的上限)', /FISH_MAX: 100/.test(src));
// ═══ 🏅 實測體質 ═══
let syncOk = true; try { execFileSync('node', [path.join(ROOT, 'scripts/export_scr_edge.mjs'), '--check'], { stdio: 'pipe' }); } catch (_) { syncOk = false; }
ok('🏅 data/scr_edge.json 與 index.html 的 _SCR_EDGE/_SCR_CONDS 一致(⛔ 唯一真相在 index.html,JSON 只是產物)', syncOk);
ok('🏅b pro.html 讀 data/scr_edge.json,⛔ 不在頁面裡寫第二份成績或條件', /fetchJson\('data\/scr_edge\.json'\)/.test(seg('_fishData')) && !/nh252:|limup:|poshi:/.test(NC));
ok('🏅c 分數只用「測過的」條件(沒成績的不計)', /if \(!e\) continue/.test(seg('_fishScore')));
ok('🏅d 門檻跟 index.html 的 _scrEdgeTag 同一組(±0.3pp)', /pp >= 0\.3/.test(seg('_fishScore')) && /pp <= -0\.3/.test(seg('_fishScore')));
// 🚨 V74.3.7 IC 探針之後改口:加總實測排不出順序 → 卡上必須寫 IC 數字 + 「別當排名」,⛔ 不可再寫「只拿來排序」
ok('🏅e 文案必寫「不是勝率」+ IC 實測「排不出順序」+「別當排名」+ 對照組數字',
   /不是勝率/.test(seg('_fishScoreHtml')) && /排不出順序/.test(seg('_fishScoreHtml')) && /別當排名/.test(seg('_fishScoreHtml')) && /隨便挑一天本身是/.test(seg('_fishScoreHtml')) && !/只拿來排序/.test(seg('_fishScoreHtml')));
ok('🏅e2 IC 數字從 _FISH_IC 常數讀(⛔ 不可在文案裡寫死)', /_FISH_IC\.ic/.test(seg('_fishScoreHtml')) && /_FISH_IC: \{/.test(src) && /src: 'scripts\/fish_score_ic_probe\.py'/.test(src));
ok('🏅e3 池子名稱不可再叫「最強」(它排不出順序)', !/n: '🏅 實測體質最強'/.test(src) && /符合最多實測條件/.test(src));
ok('🏅f 說明明寫「不是憑空加權的綜合評分」', /不是憑空加權/.test(seg('_fishNote')));
ok('🏅g 沒有人訂的係數(⛔ 不可出現 ×0.6 / *0.4 那種權重)', !/\*\s*0\.[0-9]\s*\+|× ?0\.[0-9]/.test(noCmt(seg('_fishScore'))));
// ═══ 🧺 漁獲籃 ═══
ok('🧺 localStorage 讀取有 try/catch 且壞值會清掉(陷阱 #18)', /catch \(_\) \{ try \{ localStorage\.removeItem\('proWar_catch'\)/.test(seg('_catchLoad')));
ok('🧺b 一張損益明寫「毛損益、還沒扣手續費與證交稅」', /毛損益/.test(seg('_fishBasketRender')) && /手續費/.test(seg('_fishBasketRender')));
ok('🧺c 籃子明寫「不是本站推薦」', /不是本站推薦/.test(seg('_fishBasketRender')));

// ═══ 實跑 ═══
const benign = t => /Cache|ServiceWorker|Failed to fetch|ERR_|net::/i.test(t);
const errs = [];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH ? undefined : '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });   // 手機寬(陷阱 #40:桌機寬會假通過)
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO.FISH_POOLS, null, { timeout: 15000 });

const R = await page.evaluate(async ({ SCR, COR, EDGE, DIV, PBE }) => {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 測資:真實格式 + 手動加一列 pos252 為 null 的(screener 遇到算不出來就寫 null,這是合法格式)
  SCR.rows['9999'] = SCR.rows['2330'].slice(); SCR.rows['9999'][SCR.cols.indexOf('pos252')] = null;
  PRO._cache['data/screener.json'] = SCR;
  PRO._cache['data/scr_edge.json'] = EDGE;
  PRO._cache['data/playbook_edge.json'] = PBE;
  PRO._starData = COR;
  PRO._cache['data/dividends.json'] = DIV;
  try { localStorage.removeItem('proWar_catch'); } catch (_) {}
  PRO._names = { '2330': '台積電', '2317': '鴻海', '2408': '南亞科', '2344': '華邦電', '8299': '群聯' };
  const rafCalls = { n: 0 }; const _raf = window.requestAnimationFrame;
  window.requestAnimationFrame = cb => { rafCalls.n++; return _raf(cb); };

  PRO.switchTab('fish'); await sleep(400);
  out.tabVisible = !document.getElementById('tabFish').classList.contains('hidden');
  out.sub = document.getElementById('fishSub').innerText;
  out.count = document.getElementById('fishCount').innerText;
  out.nFish = PRO._fish.length;
  out.hasEtf = PRO._fish.some(f => /^00/.test(f.sym));
  out.hasNull = PRO._fish.some(f => f.sym === '9999');
  out.pools = document.getElementById('fishPool').innerText;
  // 🧾 V74.4.2 收進摺疊之後要分兩種讀法:innerText = 使用者**第一眼看得到的**、
  //    textContent = 含摺疊內容的全部。⭐ 免責必須在第一眼,細節可以收但⛔ 不可消失。
  out.legend = document.getElementById('fishLegend').innerText;
  out.legendAll = document.getElementById('fishLegend').textContent;
  out.note = document.getElementById('fishNote').innerText;
  out.noteAll = document.getElementById('fishNote').textContent;
  out.foldN = document.querySelectorAll('#tabFish details.fishmore').length;
  out.foldOpen = [...document.querySelectorAll('#tabFish details.fishmore')].filter(d => d.open).length;
  const cv = document.getElementById('fishCanvas');
  out.cvW = cv.width; out.cvH = cv.height; out.wrapH = document.getElementById('fishTankWrap').clientHeight;
  out.rafRunning = PRO._fishRaf !== 0; out.rafN0 = rafCalls.n;
  await sleep(250); out.rafN1 = rafCalls.n;
  // 魚有沒有在動(x 座標變了)
  const x0 = PRO._fish.map(f => f.x); await sleep(200);
  out.moved = PRO._fish.some((f, i) => f.x !== x0[i]);
  // 同族靠攏:2408 跟 2344 應該在同一群
  const g = Object.fromEntries(PRO._fish.map(f => [f.sym, f.grp]));
  out.school = g['2408'] !== undefined && g['2408'] >= 0 && g['2408'] === g['2344'];
  // 位階 → y:位階高的魚要在上面
  const hi = PRO._fish.filter(f => f.pos252 >= 90), lo = PRO._fish.filter(f => f.pos252 <= 30);
  out.yOrder = hi.length && lo.length ? Math.max(...hi.map(f => f.yBase)) < Math.min(...lo.map(f => f.yBase)) : null;

  // 📊 列表 = 同一批
  PRO.fishMode('list'); await sleep(100);
  out.listRows = document.querySelectorAll('#fishList .startbl tr').length - 1;
  out.wrapHiddenInList = getComputedStyle(document.getElementById('fishTankWrap')).display === 'none';
  out.rafStoppedInList = PRO._fishRaf === 0;
  out.listTxt = document.getElementById('fishList').innerText;
  PRO.fishMode('tank'); await sleep(100);

  // 🧬 池子切換
  PRO.fishPool('gene'); await sleep(300);
  out.geneN = PRO._fish.length; out.geneOk = PRO._fish.every(f => f.pos252 >= 75 && f.amp20 >= 3.2);
  PRO.fishPool('st'); await sleep(300);
  out.stOk = PRO._fish.length > 0 && PRO._fish.every(f => f.st > 0);
  PRO.fishPool('amt'); await sleep(300);

  // 🏅 分數
  out.scored = PRO._fishD.rows.filter(r => r.sc).length; out.rowsN = PRO._fishD.rows.length;
  const any = PRO._fishD.rows.find(r => r.sc && r.sc.plus.length);
  out.anyPlus = any ? any.sc.plus[0] : null;
  // 手算一條對照:創一年新高(nh ≥ 252)這條的 pp 必須等於成績表的第 5 欄
  const nhC = EDGE.conds.find(c => c.id === 'nh252'); const iNh = SCR.cols.indexOf(nhC.k);
  const hit = Object.entries(SCR.rows).find(([s, r]) => r[iNh] !== null && r[iNh] >= nhC.v && !/^00/.test(s));
  out.nhCheck = hit ? { sym: hit[0], has: (PRO._fishD.rows.find(r => r.sym === hit[0]) || { sc: { plus: [] } }).sc.plus.some(x => x.t === nhC.t && x.pp === EDGE.c.nh252[4]) } : 'no-sample';
  PRO.fishPool('edge'); await sleep(300);
  out.edgeN = PRO._fish.length;
  out.edgeSorted = PRO._fish.every((f, i, a) => i === 0 || (a[i - 1].sc.sum >= f.sc.sum));
  out.edgeAllPlus = PRO._fish.every(f => f.sc.plus.length >= 2);
  PRO.fishPool('avoid'); await sleep(300);
  out.avoidOk = PRO._fish.every(f => f.sc.minus.length >= 2 && f.sc.sum < -1);
  PRO.fishPool('amt'); await sleep(300);

  // ══ 🎣 拋竿(V74.4.0:使用者「我要放下釣竿真的有魚上鉤,誰上鉤你幫我判斷」)══
  //    ⚠️ 測資規模小 → 這裡驗的是**規則本身**(漏斗有沒有照順序過、守門有沒有作用),
  //    ⛔ 不驗「挑到哪一檔」(那會隨資料變成假失敗)。
  {
    const D0 = PRO._fishD;
    const mk = (sym, o) => ({ sym, nm: sym, c: 100, chg: 0, chg20: 0, amt: 50, pos252: 90, amp20: 5,
                              // ⚠️ V74.5.6 `att` 是**數字** 0 無 / 1 注意股 / 2 處置中(跟 screener_miner 同一個形狀)——
                              //    ⛔ 舊測資寫 true/false 的話「處置中」那條路根本測不到(陷阱 #40)
                              att: 0, st: 0, ind: '半導體', chg5: 0, sc: { plus: [], minus: [], sum: 0 }, ...o });
    PRO._fishD = { ...D0, rows: [
      mk('AAAA', { chg20: 50 }),                                  // 強勢板塊裡最強 → 應該上鉤
      mk('BBBB', { chg20: 40 }),                                  // 同板塊次強 → ⛔ 同板塊只能挑 1 條
      mk('CCCC', { chg20: 30, ind: '航運' }),                      // 另一個板塊 → 第 2 條
      mk('DDDD', { chg20: 99, amt: 0.2 }),                        // 🚧 成交額 0.2 億 → 買不到,要擋掉
      mk('EEEE', { chg20: 98, att: 1, chg5: 45 }),                 // ⚠️ 噴 45% 又掛注意股 → 避雷擋掉
      // 🚨 V74.5.6 使用者截圖:拋竿推薦了**處置中**的玉晶光。KKKK 是同型測資 ——
      //    位階/振幅/成交額/最強板塊每一關都過、chg5 也不到 30 → ⛔ 只有「處置中」擋得住它。
      mk('KKKK', { chg20: 97, att: 2, chg5: 5 }),
      mk('FFFF', { chg20: 80, pos252: 40 }),                       // 🧬 位階不過 → 擋掉
      mk('GGGG', { chg20: 70, amp20: 1.0 }),                       // 🧬 振幅不過 → 擋掉
      ...Array.from({ length: 6 }, (_, i) => mk('H' + i, { ind: '半導體', chg20: 5 })),
      ...Array.from({ length: 6 }, (_, i) => mk('I' + i, { ind: '航運', chg20: 4 })),
      ...Array.from({ length: 6 }, (_, i) => mk('J' + i, { ind: '食品', chg20: -9 })),
    ] };
    const R2 = PRO._castPick(PRO._fishD);
    out.cast = {
      picked: R2.picked.map(x => x.sym), tiers: R2.picked.map(x => x.tier),
      inds: R2.picked.map(x => x.ind), avoided: R2.avoided, thin: R2.thin,
      disposed: R2.disposed, top3: R2.top3.map(x => x.k),
    };
    // 🚨 處置中被擋掉之後要**說出來**(⛔ 不可靜默 —— 陷阱 #22)。
    //    ⚠️ 它跟「避雷擋掉幾檔」一樣屬於**證據**(V74.4.3 那條分界線:拿掉不會害人)
    //    → 住在「📖 這一條的細節」懸浮視窗裡,所以斷言要看 modalTxt ⛔ 不是卡片。
    // 🎣 V74.4.3 使用者:「每次點開都是鼎元,是代表它比較強嗎?」→ ⛔ 不是,所以兩條都要列出來
    PRO._cast = R2; PRO._fishPick(R2.picked[0].sym); await sleep(50);
    out.picksBar = document.getElementById('fishCard').innerText;
    out.picksBarChips = [...document.querySelectorAll('#fishCard .sigtag')].map(x => x.innerText.trim());
    // 📖 懸浮視窗:點「這一條的細節」→ 內容在視窗裡,關掉要真的關掉
    { const _b = document.getElementById('fishWhyBtn');
      out.whyBtn = { on: !!(_b && _b.offsetParent !== null), txt: _b ? _b.innerText : '',
                     inFold: !!(_b && _b.closest('details')) }; }
    PRO._castWhyOpen(); await sleep(20);
    const _md = document.getElementById('proModal');
    out.modalOpen = !_md.classList.contains('hidden');
    out.modalTxt = _md.innerText;
    out.modalBodyLock = document.body.style.overflow === 'hidden';
    PRO.closeModal();
    out.modalClosed = _md.classList.contains('hidden') && _md.innerHTML === '' && document.body.style.overflow !== 'hidden';
    // 自己點的(不是拋竿挑的)→ 視窗要誠實說沒有那份理由
    PRO._cast = null; PRO._fishPickSym = 'AAAA'; PRO._castWhyOpen(); await sleep(20);
    out.modalManual = _md.innerText; PRO.closeModal();
    PRO._cast = R2;
    // 沒有魚上鉤時要誠實說,⛔ 不放寬條件硬給
    PRO._fishD = { ...D0, rows: [mk('ZZZZ', { pos252: 10, amp20: 0.5 })] };
    PRO._cast = PRO._castPick(PRO._fishD);
    PRO._castNone(PRO._cast);
    out.castNone = document.getElementById('fishCard').innerText;
    PRO._fishD = D0; PRO._cast = null;
  }

  // 🎣 釣魚
  PRO._fishPick('2408'); await sleep(150);
  out.card = document.getElementById('fishCard').innerText;
  // 📋 V74.4.3:金鑰帶不過去 → 複製中文名自己貼過去(⛔ 不傳金鑰、不帶參數)
  { let _cp = null;
    const _oc = PRO._copy; PRO._copy = t => { _cp = t; };
    PRO._fishCopyName('2408');
    PRO._copy = _oc;
    out.copied = _cp;
    out.keyWarnHtml = (document.getElementById('fishCard').innerHTML.match(/🔑[\s\S]{0,900}/) || [''])[0]; }
  {const _acts = document.querySelector('#fishCard .fishacts'), _big = document.querySelector('#fishCard .fishbig');
   out.actsInBig = !!(_acts && _big && _big.contains(_acts));
   out.actsTxt = _acts ? _acts.innerText.replace(/\s+/g, ' ') : '';
   // ⭐ 「靠右」用實際座標驗(⛔ 不看 CSS 字串 —— margin-left:auto 寫了也可能被別的規則蓋掉)
   out.actsRight = !!(_acts && _big && (_acts.getBoundingClientRect().right >= _big.getBoundingClientRect().right - 2));
   const el=document.getElementById('fishCard');
   out.cardDbg = { len: el.innerHTML.length, view: PRO._fishView, tc: el.textContent.length,
     tabHidden: document.getElementById('tabFish').classList.contains('hidden'),
     pickHidden: document.getElementById('fishPickPane').classList.contains('hidden'),
     disp: getComputedStyle(el).display, rect: JSON.stringify(el.getBoundingClientRect().toJSON()).slice(0,90), it2: el.innerText.length, ftxt: el.firstElementChild.innerText.length, vis: getComputedStyle(el).visibility, kids: [...el.firstElementChild.children].map(c=>c.className+':'+getComputedStyle(c).display).slice(0,6) };}
  out.fishDiv = (document.getElementById('fishDiv') || { innerText: '' }).innerText;
  // 陷阱 #19:配息那行是非同步補的 → 切到別檔之後回來的 promise ⛔ 不可寫進新卡
  PRO._fishPick('2330'); await sleep(150);
  out.fishDiv2330 = (document.getElementById('fishDiv') || { innerText: '' }).innerText;
  PRO._fishPick('8299'); await sleep(150);
  out.fishDivNone = (document.getElementById('fishDiv') || { innerText: '' }).innerText;
  // 🏆 最強招式池(V74.4.6 使用者:「把最厲害的招式加到釣魚區裡面」)
  PRO.fishPool('pb'); await sleep(300);
  out.pbSyms = PRO._fish.map(f => f.sym);
  out.pbChip = document.getElementById('fishPool').innerText;
  PRO._fishPick('2408'); await sleep(200);
  out.pbCard = document.getElementById('fishCard').innerText;
  // ⏳ 清單還沒產出 → 要誠實說,⛔ 不可只寫「這個池子沒有魚」
  { const keep = PRO._pbJ; PRO._pbJ = null; PRO._pbMap = {}; PRO._fishRebuild(); await sleep(80);
    out.pbNone = document.getElementById('fishMsg').innerText;
    PRO._pbJ = keep; for (const x of keep.picks) PRO._pbMap[x.s] = x; }
  PRO.fishPool('amt'); await sleep(300);
  // 🚪 出場價位要抓那一檔的 K 線 —— headless 的 file:// 抓不到 → 塞進共用 _cache(⛔ 不繞過 fetchJson)。
  //    ⭐ 收盤 100..111、低點 = 收盤 −2 → 5 日線 = 109.00、近 10 日最低 = 100、
  //      停損 = min(當天低 109, 111×0.95 = 105.45) = **105.45**(跟回測同一條,算得出來才敢斷言數字)
  PRO._cache['data/2408.json'] = Array.from({ length: 12 }, (_, i) => ({
    date: `2026-08-${String(10 + i).padStart(2, '0')}`, close: 100 + i, high: 100 + i + 1, low: 100 + i - 2, volume: 1000,
  }));
  PRO._exCache = {};
  PRO._fishPick('2408'); await sleep(400);
  // 🚪 出場價位是**非同步**補的(要抓那一檔的 K 線)→ ⛔ 不可跟 out.card 一起在 150ms 就量
  out.cardExit = document.getElementById('fishCard').innerText;
  out.exDbg = { cache: JSON.stringify((PRO._exCache||{})['2408']||null), box: !!document.getElementById('fishExit') };
  // 陷阱 #19:出場價位是非同步補的 → 切到別檔之後,舊的 promise 回來⛔ 不可寫進新卡
  { PRO._exCache = {};
    PRO._cache['data/8299.json'] = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-08-${String(10 + i).padStart(2, '0')}`, close: 500 + i, high: 501 + i, low: 498 + i, volume: 100 }));
    PRO._fishPick('2408');            // 先射出 2408 的 promise
    PRO._fishPick('8299');            // 立刻切走
    await sleep(400);
    out.exRace = document.getElementById('fishCard').innerText; }
  PRO._fishPick('2408'); await sleep(400);
  // 💰 未來 30 天除權息(sig 分頁那張)
  await PRO._renderDivCal(); await sleep(50);
  out.divCal = document.getElementById('sigDiv').innerText;
  out.divCalRows = [...document.querySelectorAll('#sigDiv table tr')].slice(1).map(tr => tr.innerText.replace(/\s+/g, ' '));
  PRO._cache['data/dividends.json'] = null; await PRO._renderDivCal(); await sleep(50);
  out.divCalNoData = document.getElementById('sigDiv').innerText;
  PRO._cache['data/dividends.json'] = DIV;
  out.cardHtml = document.getElementById('fishCard').innerHTML;
  // 🧺 釣起 → 籃子 → 損益 → 放生 → 持久化
  PRO._fishCatch('2408'); await sleep(100);
  out.basket1 = document.getElementById('fishBasket').innerText;
  out.stored = JSON.parse(localStorage.getItem('proWar_catch') || '[]');
  out.cardAfterCatch = document.getElementById('fishCard').innerText;
  // 假裝隔了幾天、價格變了 → 損益要跟著算
  // 🆚 V74.4.2 同期大盤基準(⛔ 只給「賺賠」不夠:個股 +5% 而大盤 +8% 其實是輸)
  //    ⚠️ 沙箱抓不到 ^TWII → 直接塞一份小的,才驗得到「贏大盤」那兩欄(陷阱 #40)
  PRO._twii = { m: new Map([['2026-09-01', 1000], ['2026-09-11', 1040]]), days: ['2026-09-01', '2026-09-11'] };
  const r2408 = PRO._fishD.rows.find(r => r.sym === '2408'); const px0 = r2408.c; r2408.c = +(px0 * 1.1).toFixed(2); PRO._fishD.date = '2026-09-11';
  PRO._fishBasketRender(); await sleep(50);
  out.basket2 = document.getElementById('fishBasket').innerText;
  out.expectLot = Math.round((r2408.c - px0) * 1000);
  r2408.c = px0; PRO._fishD.date = SCR.data_date;
  PRO._fishRelease('2408'); await sleep(50);
  out.basketEmpty = document.getElementById('fishBasket').innerText;
  out.storedAfter = JSON.parse(localStorage.getItem('proWar_catch') || '[]');
  // 壞值守門
  localStorage.setItem('proWar_catch', '{"a":1,"b":[1,2'); out.badLoad = PRO._catchLoad(); out.badCleared = localStorage.getItem('proWar_catch') === null;

  // ═══ 🧾 V74.6.7 漁獲自動結算 ═══
  // ⭐ 測資全部**手算得出唯一答案**(⛔ 不讓斷言去猜實際輸出):
  //   收盤 100×10 → 105,106,107,108,109,106;low = close −1、high = close +1
  //   進場 = 第 9 根(收 100、低 99)→ 停損 = min(99, 100×0.95=95) = **95**
  //   5 日線:第 15 根 = (106+109+108+107+106)/5 = 107.2 → 收 106 < 107.2 → **跌破 5 日線出場**
  //   → 報酬 (106/100−1) = +6%,扣來回成本 0.44% → **+5.56%**;抱 **6** 個交易日;一張 **+6,000** 元
  //   大盤同期 1000 → 1010 = +1.0% → 超額 = 5.56 − 1.0 = **+4.56pp**
  const _D = i => new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString().slice(0, 10);
  const _mk = cs => cs.map((c, i) => ({ date: _D(i), close: c, high: c + 1, low: c - 1, volume: 1000 }));
  const FX_WIN = _mk([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 105, 106, 107, 108, 109, 106]);
  const setRule = k => localStorage.setItem('proTerminalSettings', JSON.stringify({ exitRule: k }));
  const stlRun = async (fx, rule) => {
    setRule(rule);
    PRO._stl = {}; PRO._stlSig = null; PRO._exCache = {};
    PRO._cache['data/2408.json'] = fx;
    PRO._catchSave([{ sym: '2408', nm: '南亞科', px: 100, d: _D(9) }]);
    PRO._twii = { m: new Map([[_D(9), 1000], [_D(15), 1010], [_D(29), 1010]]), days: [_D(9), _D(15), _D(29)] };
    await PRO._stlLoad(); PRO._fishBasketRender(); await sleep(30);
    return document.getElementById('fishBasket').innerText;
  };
  out.stlWin = await stlRun(FX_WIN, 'ma5');
  // 🚨 零前視:把**出場之後**的 K 棒改掉(甚至改成漲停),結算結果⛔ 必須一模一樣
  out.stlFuture = await stlRun(FX_WIN.concat(_mk([200, 200, 200, 200, 200]).map((b, i) => ({ ...b, date: _D(16 + i) }))), 'ma5');
  // 🛑 停損:第 10 根收 93 ≤ 95 → 出在**停損價 95**(⛔ 不是 93)→ (95/100−1) − 0.44 = −5.44%
  out.stlStop = await stlRun(_mk([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 93, 93]), 'ma5');
  // ⏳ 抱滿 20 個交易日:全平盤 → 收盤不會「< 5 日線」(相等不算)→ 第 20 天強制出場,−0.44%
  out.stlMax = await stlRun(_mk(Array.from({ length: 40 }, () => 100)), 'ma5');
  // ⭐ 換一條出場規則 → **同一批紀錄要全部重算**(移動停利 8%:峰值 109 × 0.92 = 100.28,收 106 沒破 → 還沒觸發)
  out.stlRule = await stlRun(FX_WIN, 'trail8');
  // 🧾 一條都還沒觸發時要誠實說(⛔ 不可留白、也不可假裝有成績)
  out.stlNone = out.stlRule;
  PRO._catchSave([]); PRO._stl = {}; PRO._stlSig = null; setRule('atr2');
  PRO._fishBasketRender(); await sleep(30);

  // ⑤ 切走要停
  PRO.switchTab('val'); await sleep(50);
  out.stoppedOnLeave = PRO._fishRaf === 0;
  const n2 = rafCalls.n; await sleep(200); out.noRafAfterLeave = rafCalls.n === n2;

  // ⑦ 過期浮水印
  out.stale3 = PRO._staleChip('2020-01-01', '選股');
  const d2 = new Date(Date.now() - 2 * 864e5); const s2 = d2.toISOString().slice(0, 10);
  out.fresh = PRO._staleChip(s2, '選股');

  // ⑥ 資料不在 → 誠實
  PRO._cache['data/screener.json'] = null; PRO._fishD = null;
  await PRO.renderFish(); await sleep(100);
  out.noData = document.getElementById('fishMsg').innerText;
  // 🗺️ 產業熱力圖(V74.3.7):只靠 screener;面積要照成交額、顏色只表方向、點磚能開板塊明細
  PRO._cache['data/screener.json'] = SCR;     // ⚠️ 上一段為了驗「資料不在」把它清掉了 → 這裡要放回
  await PRO._rotTreemap(); await sleep(50);
  const tb = document.getElementById('rotTree');
  const rects = [...tb.querySelectorAll('rect')].map(r => ({ w: +r.getAttribute('width'), h: +r.getAttribute('height'), t: r.querySelector('title').textContent }));
  out.treeN = rects.length;
  out.treeArea = rects.reduce((a, r) => a + (r.w + 1) * (r.h + 1), 0) / (340 * 300);
  const byAmt = rects.map(r => ({ area: (r.w + 1) * (r.h + 1), amt: +(r.t.match(/成交額 (\d+)/) || [0, 0])[1] })).sort((a, b) => b.amt - a.amt);
  // 只比成交額前 10 名(小磚只有幾 px,四捨五入的相對誤差會超過任何合理容忍)
  out.treeMono = byAmt.slice(0, 10).every((r, i, a) => i === 0 || a[i - 1].area >= r.area * 0.95);
  out.treeDbg = byAmt.slice(0, 6).map(r => [r.amt, Math.round(r.area)]);
  out.treeClick = !!tb.querySelector('g[onclick*="rotOpen"]');
  out.treeTxt = tb.innerText;
  out.treeColored = [...tb.querySelectorAll('.cell rect')].filter(r => !/143,163,187/.test(r.getAttribute('fill') || '')).length;
  out.treeNoLamp = !/[🔴🟢]/u.test(tb.innerHTML);
  // 📐 橫版鐵則(CLAUDE.md):8 顆分頁鈕在 390 寬曾爆 12px 橫向溢出(V74.3.5 抓到)→ 每個分頁都量
  out.overflow = {};
  for (const [k] of PRO.TABS) { PRO.switchTab(k); window.scrollTo(80, 0); out.overflow[k] = window.scrollX; }
  window.scrollTo(0, 0);
  window.requestAnimationFrame = _raf;
  return out;
}, { SCR, COR, EDGE, DIV, PBE });

ok('⑪ 分頁切得過去', R.tabVisible);
ok('⑪b 標題旁有資料日與檔數', /資料日 \d{4}-\d{2}-\d{2}/.test(R.sub) && /檔可下水/.test(R.sub), R.sub);
ok('⑪c 預設池 = 成交額前 100,魚數 ≤ 100 且 > 50', R.nFish > 50 && R.nFish <= 100, R.nFish);
ok('⑥ ETF 不在池子裡(測資有 7 檔 ETF,成交額都很大)', !R.hasEtf);
ok('⑥b null 的那列不在池子裡', !R.hasNull);
ok('⑪d 四個池子 chips 都在', /成交額前 100/.test(R.pools) && /高位階/.test(R.pools) && /有狀態/.test(R.pools) && /最強/.test(R.pools), R.pools);
// 🧾 V74.4.2 使用者:「文字雜請用折疊的方式」→ 細節收進 details,⛔ 但免責不可跟著被收起來
ok('② 圖例:實測數字還在(可以收在摺疊裡,⛔ 但不可消失)', /1\.52pp/.test(R.legendAll) && /1\.44pp/.test(R.legendAll), R.legendAll.slice(0, 120));
ok('②b 🚨 免責必須在第一眼看得到(⛔ 不可收進摺疊)', /(不是|沒有一條魚是)買進訊號/.test(R.legend) && /魚游得快/.test(R.legend), R.legend.slice(0, 120));
ok('③ 說明:「不是買進訊號」與「不下多空」都要在第一眼', /不是買進訊號/.test(R.note) && /不下多空/.test(R.note), R.note.slice(0, 120));
ok('③c 長說明真的有收起來(⛔ 掛 open 等於沒摺)', R.foldN >= 2 && R.foldOpen === 0, `n=${R.foldN} open=${R.foldOpen}`);
ok('③d 收起來的內容一個字都沒少(🏅 怎麼算 / 誰不在池子裡 都還在)',
   /實測體質怎麼算/.test(R.noteAll) && /誰不在池子裡/.test(R.noteAll) && /IC \+0\.0004/.test(R.noteAll));
// ⚠️ clientHeight 不含 1px 邊框 → 440 的容器量到 438;釘「固定在 430~440」而不是精確值
ok('⑫ Canvas 有尺寸(DPR 放大)且容器高度固定(430~440,⛔ 內容不可撐開它)', R.cvW > 300 && R.cvH > 400 && R.wrapH >= 430 && R.wrapH <= 440, `${R.cvW}x${R.cvH} wrap=${R.wrapH}`);
ok('⑫b rAF 迴圈在跑、魚真的在動', R.rafRunning && R.rafN1 > R.rafN0 && R.moved, `raf ${R.rafN0}→${R.rafN1} moved=${R.moved}`);
ok('⑫c 同族(2408↔2344)被分到同一群', R.school);
ok('⑫d 位階高的魚在上面、低的在下面', R.yOrder === true, R.yOrder);
ok('④ 📊 列表 = 同一批魚(數量一樣)', R.listRows === R.nFish, `list=${R.listRows} tank=${R.nFish}`);
ok('④b 列表模式:魚池收起、rAF 停', R.wrapHiddenInList && R.rafStoppedInList);
ok('④c 列表有中文名 + 狀態欄', /台積電/.test(R.listTxt) && /狀態/.test(R.listTxt));
ok('⑬ 🧬 池子過濾正確(75 / 3.2)', R.geneOk && R.geneN > 0, `n=${R.geneN}`);
ok('⑬b 🚀🔥 池子全部有狀態', R.stOk);
ok('⑭ 釣到魚:卡片有名字/現價/位階/同族', /南亞科/.test(R.card) && /現價/.test(R.card) && /一年位階/.test(R.card)
   && /華邦電/.test(R.card), R.card.slice(0, 150));
// 🔘 V74.4.2 使用者要求:三顆按鈕移到「🎣 釣到:XXX」那一列**最右側**(⛔ 不再自己佔一整列)
ok('⑭a 三顆按鈕在標題那一列(.fishacts)而且靠右',
   R.actsInBig && R.actsRight, `inBig=${R.actsInBig} right=${R.actsRight}`);
ok('⑭a2 四顆都在:收進漁獲籃 / 📋 複製名稱 / 星圖(真的連到 starGo)/ 散戶救星',
   /收進漁獲籃|放生/.test(R.actsTxt) && /複製名稱/.test(R.actsTxt) && /星圖/.test(R.actsTxt) && /散戶救星/.test(R.actsTxt)
   && /PRO\.starGo\('2408'\)/.test(R.cardHtml) && /PRO\.gotoStock\('2408'\)/.test(R.cardHtml), R.actsTxt);
ok('⑭b 卡片明寫「不是進場建議」', /不是進場建議/.test(R.card));
// 🏆 V74.4.6 使用者:「把最厲害的招式加到釣魚區裡面」——
//    ⭐ 最強的**不是**拋竿漏斗(它合起來是負的),是「每檔自己最會賺的招」那份清單。
// ⚠️ 測資三檔都在 screener 裡 → 三條都該進池子(⭐ 預期值是**算出來的**不是猜的:
//    hq=1 的先排,其中 lb 1.8(2408) > 0.9(2330);hq=0 的 8299 最後)
ok('🏆⑰ 最強招式池只留作戰清單裡的,而且照共用排序(🧬 優先 → 保守下界)',
   R.pbSyms.length === 3 && R.pbSyms[0] === '2408' && R.pbSyms[1] === '2330' && R.pbSyms[2] === '8299',
   JSON.stringify(R.pbSyms));
ok('🏆⑰a 🚨 同一檔出現多次時,要留**排名最前面(最好)**的那一招',
   /突破頸線/.test(R.pbCard) && !/比較差的那一招/.test(R.pbCard) && R.pbSyms.length === 3,
   (R.pbCard.match(/🏆[\s\S]{0,40}/) || [''])[0]);
ok('🏆⑰b 池子選項看得到', /最強招式/.test(R.pbChip), R.pbChip.slice(0, 80));
ok('🏆⑰c 卡片攤開那一招:招式名 / 觸發價 / 停損 / 勝率+次數 / 每趟平均',
   /突破頸線/.test(R.pbCard) && /120\.00/.test(R.pbCard) && /114\.00/.test(R.pbCard)
   && /48% ・14 次/.test(R.pbCard) && /\+3\.40%/.test(R.pbCard), (R.pbCard.match(/🏆[\s\S]{0,160}/) || [''])[0]);
ok('🏆⑰d 🚨 必寫「不是開盤買」+「基準 36% 不是 50%」+「仍輸 0050」',
   /不是明天一開盤就買|⛔ <b>不是明天一開盤/.test(R.pbCard) && /36%/.test(R.pbCard)
   && /輸給買 0050/.test(R.pbCard), (R.pbCard.match(/⏰[\s\S]{0,200}/) || [''])[0]);
ok('🏆⑰e ⛔ 排序只准有一份(renderSig 與魚池都吃 _pbSort)',
   /_pbSort/.test(seg('renderSig')) && /_pbSort/.test(seg('_fishPoolRows'))
   && !/hq \|\| 0\) - \(a\.hq/.test(seg('renderSig')) && !/hq \|\| 0\) - \(a\.hq/.test(seg('_fishPoolRows')));
ok('🏆⑰f ⏳ 清單還沒產出要誠實說(⛔ 不可只寫「這個池子沒有魚」)',
   /作戰清單還沒產出/.test(R.pbNone) && /不是這個功能壞掉/.test(R.pbNone), R.pbNone.slice(0, 90));
ok('③g 🚪 出場那段要**真的算出價位**(⛔ 只寫規則沒有數字等於沒說)',
   /停損價/.test(R.cardExit) && /出場線/.test(R.cardExit) && /\d+\.\d\d/.test(R.cardExit) && /移動停利/.test(R.cardExit),
   JSON.stringify({ ex: R.exDbg, snip: (R.cardExit.match(/🚪[\s\S]{0,200}/) || [''])[0].replace(/\n/g, '⏎') }));
// 🚨 V74.6.7:停損改成跟回測**一字不差** —— min(訊號日當天最低, 進場 −5%)。
//    ⛔ 舊版寫的是 max(進場 −5%, 近 10 日最低)= 比回測**更緊**,使用者會比回測更常被掃出場。
//    2408 測資:當天低 109 vs 111×0.95 = 105.45 → 取 105.45(標「進場 −5%」)。
ok('③h 🚪 停損 = min(訊號日當天最低, 進場 −5%),跟回測同一條(測資算得出來:105.45)',
   /105\.45/.test(R.cardExit) && /進場 −5%/.test(R.cardExit)
   && /出場線\((ATR 追蹤停利|唐奇安 20 日低點|移動停利 8%|跌破 5 日線)\)/.test(R.cardExit),
   (R.cardExit.match(/停損價[\s\S]{0,80}/) || [''])[0].replace(/\n/g, ' '));
// ⭐ 8299 測資是**分辨新舊規則**的那一組:當天低 509、511×0.95 = 485.45
//    新規則 min → 485.45 ・舊規則 max(485.45, 近10日最低 500) → 500.00
ok('③h2 🚪 ⛔ 不可退回舊的「取較近那個」(8299 測資:新 485.45 / 舊 500.00)',
   /485\.45/.test(R.exRace) && !/500\.00/.test(R.exRace),
   (R.exRace.match(/停損價[\s\S]{0,60}/) || [''])[0].replace(/\n/g, ' '));
ok('③i 陷阱 #19:切到別檔之後,舊那檔的出場價位⛔ 不可寫進新卡',
   /485\.45/.test(R.exRace) && !/105\.45/.test(R.exRace) && !/109\.00/.test(R.exRace),
   (R.exRace.match(/停損價[\s\S]{0,60}/) || [''])[0].replace(/\n/g, ' '));
ok('🏅⑮ 每一條魚都算了實測體質', R.scored === R.rowsN && R.rowsN > 0, `${R.scored}/${R.rowsN}`);
ok('🏅⑮b 手算對照:符合「創一年新高」的魚,分數裡那條的 pp 要等於成績表第 5 欄', R.nhCheck === 'no-sample' || R.nhCheck.has === true, JSON.stringify(R.nhCheck));
ok('🏅⑮c 🏅 池子:全部 ≥2 條領先、依加總排序', R.edgeN > 0 && R.edgeSorted && R.edgeAllPlus, `n=${R.edgeN}`);
ok('🏅⑮d ⚠️ 避雷池過濾正確', R.avoidOk);
ok('🏅⑮e 卡片顯示實測體質 + 每條 pp + 免責', /實測體質/.test(R.card) && /pp/.test(R.card) && /不是勝率/.test(R.card), R.card.slice(0, 200));
ok('🧺⑯ 釣起 → 籃子有這條、寫進 localStorage', /南亞科/.test(R.basket1) && R.stored.length === 1 && R.stored[0].sym === '2408', R.basket1.slice(0, 120));
ok('🧺⑯b 釣起後卡片按鈕變「放生」', /放生/.test(R.cardAfterCatch));
ok('🧺⑯c 價格變 +10% 後籃子算出正確的一張損益(元)與天數', new RegExp(`\\+${R.expectLot.toLocaleString()}`).test(R.basket2) && /\+10\.00%/.test(R.basket2) && /\b10\b/.test(R.basket2), R.basket2.slice(0, 200));
// 🆚 V74.4.2:漲 10% 但大盤同期漲 4% → 贏大盤只有 +6pp(⭐ 這一欄才是「有沒有用」)
ok('🧺⑯c2 有「大盤」與「贏大盤」兩欄,而且是「賺賠 − 大盤」', /\+4\.00%/.test(R.basket2) && /\+6\.00pp/.test(R.basket2), R.basket2.slice(0, 260));
ok('🧺⑯c3 樣本不足 10 筆要明寫⛔ 不能當結論(跟全站同一條規則)', /不能當結論/.test(R.basket2));
ok('🧺⑯d 放生 → 籃子空、localStorage 也清掉', /漁獲籃是空的/.test(R.basketEmpty) && R.storedAfter.length === 0);
ok('🧺⑯e 半截 JSON 不會炸,而且壞值被清掉(陷阱 #18)', Array.isArray(R.badLoad) && R.badLoad.length === 0 && R.badCleared);
// ═══ 🧾 V74.6.7 漁獲自動結算(使用者:「釣起來之後觸發到出場直接結算…這才知道這個策略是不是有用的」)═══
ok('🧾㉒ 觸發出場 → 自動結算,而且數字跟回測一字不差(+5.56% ・跌破 5 日線 ・6 天)',
   /\+5\.56%/.test(R.stlWin) && /跌破 5 日線/.test(R.stlWin) && /6天/.test(R.stlWin),
   (R.stlWin.match(/🧾[\s\S]{0,180}/) || [''])[0].replace(/\n/g, ' '));
ok('🧾㉒b 成績單:勝率配次數 + 每趟 + 一張合計(手算 +6,000 元)',
   /1\/1/.test(R.stlWin) && /\+5\.56%/.test(R.stlWin) && /\+6,000 元/.test(R.stlWin),
   (R.stlWin.match(/勝率[\s\S]{0,160}/) || [''])[0].replace(/\n/g, ' '));
ok('🧾㉒c 🆚 超額要扣同期加權(大盤 +1.0% → 5.56 − 1.0 = +4.56pp)',
   /\+4\.56pp/.test(R.stlWin), (R.stlWin.match(/超額[\s\S]{0,60}/) || [''])[0].replace(/\n/g, ' '));
ok('🧾㉒d ⚠️ 樣本 <10 筆要明寫⛔ 還不能當結論(全站同一條規則)',
   /只有 1 筆/.test(R.stlWin) && /還不能當結論/.test(R.stlWin));
ok('🧾㉒e 🚨 必須寫「這是紙上成績」+ 進場價跟回測不同(尾盤 vs 收盤)',
   /紙上成績/.test(R.stlWin) && /13:00/.test(R.stlWin) && /勝率鏡子/.test(R.stlWin));
ok('🧾㉒f 🚨 零前視:改掉**出場之後**的 K 棒(改成漲停),結算結果必須一模一樣',
   /\+5\.56%/.test(R.stlFuture) && /6天/.test(R.stlFuture) && !/200/.test((R.stlFuture.match(/🧾 結算[\s\S]{0,200}/) || [''])[0]),
   (R.stlFuture.match(/勝率[\s\S]{0,80}/) || [''])[0].replace(/\n/g, ' '));
ok('🧾㉒g 🛑 停損出在**停損價 95**(⛔ 不是當天收盤 93)→ −5.44%',
   /−5\.44%|-5\.44%/.test(R.stlStop) && /停損/.test(R.stlStop) && !/−7\.44%|-7\.44%/.test(R.stlStop),
   (R.stlStop.match(/🧾[\s\S]{0,160}/) || [''])[0].replace(/\n/g, ' '));
ok('🧾㉒h ⏳ 全平盤 → 抱滿 20 個交易日強制出場(⛔ 不可無限抱下去)',
   /抱滿 20 個交易日/.test(R.stlMax) && /20天/.test(R.stlMax),
   (R.stlMax.match(/🧾[\s\S]{0,160}/) || [''])[0].replace(/\n/g, ' '));
// ⭐ 這條是「⛔ 不產生第二份真相」的實證:籃子只存「哪一檔+哪一天」,換規則整籃重算
ok('🧾㉒i ⭐ 換一條出場規則 → 同一批紀錄全部重算(移動停利 8% 沒觸發 → 持有中,⛔ 不沿用 ma5 的 +5.56%)',
   /持有中/.test(R.stlRule) && !/\+5\.56%/.test(R.stlRule),
   (R.stlRule.match(/🧾[\s\S]{0,200}/) || [''])[0].replace(/\n/g, ' '));
ok('🧾㉒j 🧾 一條都沒觸發時要誠實說(⛔ 不可留白、也不可假裝有成績)',
   /還沒有任何一條觸發出場/.test(R.stlNone) && /持有中/.test(R.stlNone));
ok('🧾㉒k 📉 「中途最多賠」要標明⛔ 不是帳戶回撤(回測是同時抱 2 檔、每筆 15 萬)',
   /不是帳戶回撤/.test(R.stlWin) && /−32\.4%|-32\.4%/.test(R.stlWin));
ok('⑤ 切走分頁 rAF 停,而且之後不再排新的一格', R.stoppedOnLeave && R.noRafAfterLeave);
ok('⑦ 停在很久以前的資料 → ⚠️ 資料未更新', /資料未更新/.test(R.stale3) && /天前/.test(R.stale3), R.stale3);
ok('⑦b 2 天前的資料不誤報(週末守門)', R.fresh === '', R.fresh);
ok('⑥c 資料不在 → 誠實說「還沒產出」+「不是壞掉」', /還沒產出/.test(R.noData) && /不是這個功能壞掉/.test(R.noData), R.noData);
ok('📐 390 寬 8 個分頁都無橫向溢出(scrollX ≤ 2)', Object.values(R.overflow).every(v => v <= 2), JSON.stringify(R.overflow));
ok('🗺️ 熱力圖:磚數 ≥5、鋪滿畫布(≥85%)', R.treeN >= 5 && R.treeArea >= 0.85, `n=${R.treeN} area=${R.treeArea.toFixed(2)}`);
ok('🗺️b 磚面積跟成交額同向(大的不可比小的小)', R.treeMono, JSON.stringify(R.treeDbg));
ok('🗺️c 點磚 → 板塊明細(rotOpen)', R.treeClick);
ok('🗺️d 文案:錢在哪一區 + 「不是輪動訊號」+ 只含上市', /錢在哪一區/.test(R.treeTxt) && /不是.{0,3}輪動訊號/.test(R.treeTxt) && /上市/.test(R.treeTxt), R.treeTxt.slice(0, 120));
// 🎞️ V74.4.4:沒有輪動歷史時⛔ 不可整張變灰 —— 要退回原本的「最新交易日加權漲跌」
ok('🗺️f ⛔ 沒有輪動歷史時仍要有顏色(退回今日漲跌),並說出自己用的是哪一種',
   R.treeColored >= 3 && /最新交易日的加權漲跌/.test(R.treeTxt), `coloured=${R.treeColored}`);
ok('🗺️e ⛔ 不用 🔴🟢 emoji(顏色只在磚上,文字色紅漲綠跌)', R.treeNoLamp);
// ═══ 💰 除權息(V74.3.8)═══
ok('💰① 釣起的魚卡片有配息:近 12 個月合計 21.00 元 + 殖利率 + 下次除息', /最近 12 個月現金股利合計/.test(R.fishDiv) && /殖利率/.test(R.fishDiv) && /下次除息/.test(R.fishDiv), R.fishDiv.slice(0, 160));
ok('💰①b 2330 那張的合計要等於測資四筆相加(21.00)', /21\.00/.test(R.fishDiv2330) && /下次除息/.test(R.fishDiv2330), R.fishDiv2330.slice(0, 160));
ok('💰①c 測資裡沒有的魚(8299)誠實寫「沒有除權息紀錄」', /沒有除權息紀錄/.test(R.fishDivNone) && !/殖利率/.test(R.fishDivNone), R.fishDivNone);
ok('💰①d 配息那行明寫「不是承諾」+「還沒回測」+「不當進出場理由」', /不是承諾/.test(R.fishDiv2330) && /還沒回測/.test(R.fishDiv2330) && /不當進出場理由/.test(R.fishDiv2330));
ok('💰② 未來 30 天除權息表:30 天內的兩檔都在、49 天後的不在、依日期排序', R.divCalRows.length === 2 && /2330|台積電/.test(R.divCalRows[0]) && /2408|南亞科/.test(R.divCalRows[1]) && !/2317|鴻海/.test(R.divCal), JSON.stringify(R.divCalRows));
ok('💰②b 表格明寫「填不填息還沒回測」', /填不填息/.test(R.divCal) && /回測/.test(R.divCal), R.divCal.slice(0, 160));
ok('💰②c 資料不在 → 「還沒產出」+「不是壞掉」(陷阱 #22)', /還沒產出/.test(R.divCalNoData) && /不是壞掉/.test(R.divCalNoData), R.divCalNoData);
// ⚠️ 免責句本身就含「除息前買」(「⛔ 不是「除息前買」的建議」)→ 先把否定形剝掉再比對(CLAUDE.md 記過 8 次的坑)
const divTxt = noCmt(seg('_divCardHtml') + seg('_renderDivCal')).replace(/不是「[^」]*」/g, '').replace(/不[寫當]「[^」]*」/g, '');
ok('💰③ 配息只描述:⛔ 不下多空、不寫「除息前買」(否定形已剝掉)', !/除息前買|除息後買|偏多|偏空|看多|看空|該買|可買/.test(divTxt));
ok('💰③a 空過守門:免責句真的在(剝掉前找得到、剝掉後找不到)', /不是「除息前買」/.test(seg('_renderDivCal')) && !/除息前買/.test(divTxt));
ok('💰③b 非同步回來要驗還是同一檔(陷阱 #19)', /_fishPickSym === sym/.test(seg('_fishPick')));
ok('💰③c 殖利率分母是現價、分子只算現金(排除「權」)', /x\[2\] !== '權'/.test(seg('_divInfo')) && /y12 \/ px/.test(seg('_divInfo')));
// ═══ 🎣 拋竿(V74.4.0)═══
ok('🎣① 一天最多 2 條(V73.0.0:27 種變體裡唯一沒有任何一項變差的)', R.cast.picked.length === 2, JSON.stringify(R.cast));
ok('🎣② 同一個板塊只挑 1 條(⛔ 不可兩條都押同一族)', new Set(R.cast.inds).size === R.cast.inds.length, JSON.stringify(R.cast.inds));
ok('🎣③ 🚧 買不到的要擋掉(成交額 0.2 億)', !R.cast.picked.includes('DDDD') && R.cast.thin >= 1, `thin=${R.cast.thin}`);
ok('🎣④ ⚠️ 避雷守門:噴 ≥30% 又掛官方注意股的要擋掉(另一條六關全過的實測 −1.81pp)',
   !R.cast.picked.includes('EEEE') && R.cast.avoided.includes('EEEE'), JSON.stringify(R.cast.avoided));
ok('🎣⑤ 🧬 位階/振幅不過的不上鉤(它是必要條件不是加分)',
   !R.cast.picked.includes('FFFF') && !R.cast.picked.includes('GGGG'));
ok('🎣⑥ 挑的是「強勢板塊裡近 20 日最強」那一檔(⛔ 不是補漲:實測逐年全負)', R.cast.picked[0] === 'AAAA', JSON.stringify(R.cast.picked));
ok('🚨🎣⑨ 處置中的股票⛔ 不可被拋竿挑出來(使用者截圖:玉晶光處置中卻被推薦)',
   !R.cast.picked.includes('KKKK'), JSON.stringify(R.cast.picked));
ok('🚨🎣⑨b 它要被列進 disposed(⛔ 不是靜默丟掉)', (R.cast.disposed || []).includes('KKKK'), JSON.stringify(R.cast.disposed));
ok('🚨🎣⑨c 卡上要說出「排除幾檔處置中」+ 為什麼(分盤撮合買不到 + 中位是負的)',
   /排除 1 檔/.test(R.modalTxt.replace(/\s+/g, ' ')) && /分盤撮合/.test(R.modalTxt) && /4\.81/.test(R.modalTxt),
   R.modalTxt.replace(/\s+/g, ' ').slice(0, 260));
ok('🚨🎣⑨d ⛔ 那段要寫明「這是排除不是放空訊號」', /不是放空訊號/.test(R.modalTxt));
ok('🚨🎣⑨e 🚧 空過守門:注意股那條避雷仍然有效(⛔ 別把它一起弄壞)',
   (R.cast.avoided || []).includes('EEEE'), JSON.stringify(R.cast.avoided));
ok('🚨🎣⑨f ⛔ `att` 不可再用 `=== 1` 讀(那會把處置中讀成 false)',
   !/att:\s*r\[iAtt\]\s*===\s*1/.test(src) && /att:\s*\(r\[iAtt\]\s*\|\|\s*0\)/.test(src));
ok('🎣⑦ 沒有魚上鉤時誠實說,而且明寫⛔ 不放寬條件硬給', /今天沒有魚上鉤/.test(R.castNone) && /不放寬條件/.test(R.castNone), R.castNone.slice(0, 120));
ok('🎣⑧ ⛔ 挑選規則不可用 🏅 加總排序(它的 IC≈0,已被自己的檢定否定)',
   !/sc\.sum/.test(seg('_castPick')) && !/sort\s*===\s*'score'/.test(seg('_castPick')));
// 🚨 V74.4.2:組合回測跑完是**負的** → 這條免責是這張卡最重要的東西,⛔ 不可拿掉也不可收進摺疊
// ⚠️ V74.4.4 使用者明示把這段搬進懸浮視窗 → 交換條件是「開視窗那顆按鈕必須帶 🚨 且永遠看得到」
ok('🎣⑧b 「合起來回測量不出優勢」與那兩個負數必須在視窗裡',
   /合起來/.test(seg('_castWhyFull')) && /−0\.52pp/.test(seg('_castWhyFull')) && /−1\.44pp/.test(seg('_castWhyFull'))
   && /不是一個回測過的策略/.test(seg('_castWhyFull')) && /cast_probe/.test(seg('_castWhyFull'))
   && /−0\.52pp/.test(R.modalTxt) && /−1\.44pp/.test(R.modalTxt));
ok('🎣⑧c 🚨 開視窗那顆按鈕要帶警示、⛔ 不可收進摺疊(否則那個負數等於消失了)',
   R.whyBtn.on && /🚨/.test(R.whyBtn.txt) && !R.whyBtn.inFold, JSON.stringify(R.whyBtn));
ok('🎣⑨ 「為什麼釣到它」(懸浮視窗裡)要寫出每一層的實測數字 + ⛔ 不是買進訊號',
   /\+289\.6/.test(seg('_castWhyFull')) && /\+1\.44pp/.test(seg('_castWhyFull')) && /\+0\.90/.test(seg('_castWhyFull'))
   && /不是買進訊號/.test(seg('_castWhyFull')) && /散戶救星/.test(seg('_castWhyFull')));
// 📖 V74.4.3 使用者:「這是你點到的那一條的細節這個變成按鈕…用懸浮視窗方式呈現」
ok('🎣⑩ 標題列那個「細節」已經是按鈕,而且真的接到 _castWhyOpen',
   /<button[^>]*id="fishWhyBtn"[^>]*PRO\._castWhyOpen\(\)/.test(src) && !/>這是你點到的那一條的細節</.test(src));
ok('🎣⑩b 懸浮視窗打得開,而且完整理由(每一層的數字)真的在視窗裡',
   R.modalOpen && /為什麼釣到它/.test(R.modalTxt) && /\+289\.6/.test(R.modalTxt) && /\+1\.44pp/.test(R.modalTxt),
   (R.modalTxt || '').slice(0, 120));
ok('🎣⑩c 關掉要真的關掉(內容清空 + 背景可以捲回來)', R.modalClosed);
ok('🎣⑩d 開著時背景⛔ 不可跟著捲', R.modalBodyLock);
ok('🎣⑩e 自己點的(不是拋竿挑的)→ 視窗要誠實說沒有那份理由,⛔ 不可空白',
   /不是拋竿挑的/.test(R.modalManual) && R.modalManual.length > 30, (R.modalManual || '').slice(0, 80));
// 🎣 V74.4.3 使用者:「每次點開都是鼎元,是代表它比較強嗎?」→ ⛔ 不是:排序只是照 20 日漲幅,而漏斗連排序都沒有優勢
ok('🎣⑪ 拋竿上鉤的每一條都要列出來(⛔ 只顯示一條 = 用版面暗示不存在的強弱)',
   R.picksBarChips.some(t => /AAAA/.test(t)) && R.picksBarChips.some(t => /CCCC/.test(t)), JSON.stringify(R.picksBarChips.slice(0, 6)));
ok('🎣⑪b 必須明寫「沒有強弱之分 / 先出現的不代表比較強」,並給出那個負數',
   /沒有強弱之分/.test(R.picksBar) && /不代表比較強/.test(R.picksBar) && /−1\.44pp/.test(R.picksBar),
   (R.picksBar || '').slice(0, 160));
ok('🎣⑪c 那段⛔ 不可收進摺疊(收起來等於沒說)',
   !/<details[^>]*>[\s\S]{0,300}沒有強弱之分/.test(seg('_castPicksBarHtml')));
// 📋 V74.4.3 使用者:「改用點擊按鈕後變成複製個股中文,我自己轉貼過去查詢就好」
ok('📋⑫ 複製的是「中文名」,⛔ 不是代號、⛔ 不含金鑰或網址', R.copied === '南亞科', R.copied);
// ⚠️ 空過守門:headless 沒有金鑰 → 這段一定要渲染出來,⛔ 不可用「剛好是空的」矇混過去
ok('📋⑫b 金鑰提示改成指路那顆按鈕(⛔ 長篇搬進摺疊,但不可消失)',
   R.keyWarnHtml.length > 50 && /複製名稱/.test(R.keyWarnHtml) && /<details/.test(R.keyWarnHtml),
   (R.keyWarnHtml || '(沒渲染出來)').slice(0, 100));
ok('📋⑫c 🔐 ⛔ 絕不可把金鑰放進網址帶過去', !/gotoStock[\s\S]{0,200}(key|Key)=/.test(src));
ok('💥 沒有未攔截的 JS 錯誤', errs.length === 0, errs.join(' | '));

// ═══ 📏 V74.6.6 ATR 與回撤(使用者:「我要知道它的 ATR 還有回撤」)═══
{
  // ⭐ 直接餵一組**算得出唯一答案**的 K 線(⛔ 不用真實資料 —— 那會隨採礦漂移,測試遲早假失敗)
  //   收盤 100..119(20 根),每根 high=close+1 / low=close−1 → TR 恆為 2 → ATR14 = 2.0
  //   現價 119、近 10 日最低 = 110−1 = 109;進場 −5% = 113.05 → 較近的是 113.05
  //   停損距離 = 119 − 113.05 = 5.95 → 5.95 / 2.0 = 2.98 個 ATR
  //   近 60 日最高收盤 = 119 → 回撤 0.0%
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 });
  const r = await page.evaluate(rw => {
    PRO._cache = PRO._cache || {};
    PRO._cache['data/9911.json'] = rw;
    PRO._exCache = {};
    return PRO._exitLevels('9911').then(() => {
      const x = PRO._exRow('9911');
      return { x, html: x ? PRO._exitBody(x) : '' };
    });
  }, rows);
  const x = r.x || {};
  ok('📏㉑ ATR 有算出來而且是 2.0(TR 恆為 2 → ATR14 = 2.0)',
     x.atr != null && Math.abs(x.atr - 2) < 0.01, `atr=${x.atr}`);
  ok('📏㉑b 回撤算得出來(這組測資現價就是近 60 日最高 → 0%)',
     x.dd60 != null && Math.abs(x.dd60) < 0.01, `dd60=${x.dd60}`);
  const txt = r.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ok('📏㉑c 卡上要看得到 ATR 那一列', /ATR/.test(txt) && /2\.00 元/.test(txt), txt.slice(0, 200));
  ok('📏㉑d 「停損 = 幾個 ATR」要現算(這組是 2.98 個)',
     /2\.98 個|3\.0 個/.test(txt), txt.slice(0, 300));
  ok('📏㉑e 回撤那一列要在,而且⛔ 必須寫清楚「不是你的帳戶回撤」',
     /回撤/.test(txt) && /不是.{0,6}你的帳戶回撤/.test(txt), txt.slice(0, 400));
  ok('📏㉑f 🚨 帳戶回撤要給真數字(49 個月 −32.4%),⛔ 不可只寫「會有回撤」',
     /32\.4/.test(txt), txt.slice(-300));
  // ⭐ 決定性的一條:停損很近時要示警,而且⛔ 不可叫人把停損放寬(那是換一套沒驗過的規則)
  const rows2 = rows.map((b, i) => ({ ...b, high: b.close + 8, low: b.close - 8 }));  // ATR 變 16 → 停損只有 0.37 個
  const r2 = await page.evaluate(rw => {
    PRO._cache['data/9912.json'] = rw; PRO._exCache = {};
    return PRO._exitLevels('9912').then(() => PRO._exitBody(PRO._exRow('9912')));
  }, rows2);
  const t2 = r2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ok('📏㉑g 停損不到 1.5 個 ATR → 要示警', /🚨/.test(t2) && /個 ATR/.test(t2), t2.slice(0, 300));
  ok('📏㉑h ⛔ 但不可叫人把停損放寬(停損是回測釘死的)',
     /不是叫你把停損放寬|回測釘死/.test(t2), t2.slice(0, 400));
  // 🚨 決定性的一條:⛔ 「幾個 ATR」不可寫死 —— 兩組 ATR 差 8 倍的測資,印出來必須不一樣。
  //    ⚠️ 只驗「有出現 2.98」抓不到寫死(測資剛好就是 2.98)—— 這個坑本專案踩過很多次。
  const n1 = (txt.match(/([\d.]+) 個/) || [])[1];
  const n2 = (t2.match(/([\d.]+) 個/) || [])[1];
  ok('📏㉑i 🚨 換一組 ATR 差 8 倍的測資,倍數要跟著變(⛔ 證明不是寫死的)',
     !!n1 && !!n2 && n1 !== n2, `第一組 ${n1} 個 / 第二組 ${n2} 個`);
}

await browser.close();

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : `\n✅ 全部通過`);
process.exit(fails.length ? 1 : 0);
