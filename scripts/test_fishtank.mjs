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
ok('③ ⛔ 魚池區塊不出現買賣指令', !/(進場價|停損|掛單|買點|該買|可以買|建議買|目標價|可加碼|放心做多)/.test(noCmt(FISHJS)),
   (noCmt(FISHJS).match(/.{0,50}(進場價|停損|掛單|買點|目標價)/) || [])[0] || '');
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

const R = await page.evaluate(async ({ SCR, COR, EDGE, DIV }) => {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 測資:真實格式 + 手動加一列 pos252 為 null 的(screener 遇到算不出來就寫 null,這是合法格式)
  SCR.rows['9999'] = SCR.rows['2330'].slice(); SCR.rows['9999'][SCR.cols.indexOf('pos252')] = null;
  PRO._cache['data/screener.json'] = SCR;
  PRO._cache['data/scr_edge.json'] = EDGE;
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
  out.legend = document.getElementById('fishLegend').innerText;
  out.note = document.getElementById('fishNote').innerText;
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

  // 🎣 釣魚
  PRO._fishPick('2408'); await sleep(150);
  out.card = document.getElementById('fishCard').innerText;
  out.fishDiv = (document.getElementById('fishDiv') || { innerText: '' }).innerText;
  // 陷阱 #19:配息那行是非同步補的 → 切到別檔之後回來的 promise ⛔ 不可寫進新卡
  PRO._fishPick('2330'); await sleep(150);
  out.fishDiv2330 = (document.getElementById('fishDiv') || { innerText: '' }).innerText;
  PRO._fishPick('8299'); await sleep(150);
  out.fishDivNone = (document.getElementById('fishDiv') || { innerText: '' }).innerText;
  PRO._fishPick('2408'); await sleep(150);
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
  out.treeNoLamp = !/[🔴🟢]/u.test(tb.innerHTML);
  // 📐 橫版鐵則(CLAUDE.md):8 顆分頁鈕在 390 寬曾爆 12px 橫向溢出(V74.3.5 抓到)→ 每個分頁都量
  out.overflow = {};
  for (const [k] of PRO.TABS) { PRO.switchTab(k); window.scrollTo(80, 0); out.overflow[k] = window.scrollX; }
  window.scrollTo(0, 0);
  window.requestAnimationFrame = _raf;
  return out;
}, { SCR, COR, EDGE, DIV });

ok('⑪ 分頁切得過去', R.tabVisible);
ok('⑪b 標題旁有資料日與檔數', /資料日 \d{4}-\d{2}-\d{2}/.test(R.sub) && /檔可下水/.test(R.sub), R.sub);
ok('⑪c 預設池 = 成交額前 100,魚數 ≤ 100 且 > 50', R.nFish > 50 && R.nFish <= 100, R.nFish);
ok('⑥ ETF 不在池子裡(測資有 7 檔 ETF,成交額都很大)', !R.hasEtf);
ok('⑥b null 的那列不在池子裡', !R.hasNull);
ok('⑪d 四個池子 chips 都在', /成交額前 100/.test(R.pools) && /高位階/.test(R.pools) && /有狀態/.test(R.pools) && /最強/.test(R.pools), R.pools);
ok('② 圖例真的渲染出實測數字 + 免責', /1\.52pp/.test(R.legend) && /1\.44pp/.test(R.legend) && /(不是|沒有一條魚是)買進訊號/.test(R.legend), R.legend.slice(0, 120));
ok('③ 說明寫著「不是買進訊號」與「不下多空」', /不是買進訊號/.test(R.note) && /不下多空/.test(R.note));
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
ok('⑭ 釣到魚:卡片有名字/現價/位階/同族/兩顆按鈕', /南亞科/.test(R.card) && /現價/.test(R.card) && /一年位階/.test(R.card)
   && /華邦電/.test(R.card) && /看它的星圖/.test(R.card) && /PRO\.gotoStock\('2408'\)/.test(R.cardHtml), R.card.slice(0, 150));
ok('⑭b 卡片明寫「不是進場建議」', /不是進場建議/.test(R.card));
ok('🏅⑮ 每一條魚都算了實測體質', R.scored === R.rowsN && R.rowsN > 0, `${R.scored}/${R.rowsN}`);
ok('🏅⑮b 手算對照:符合「創一年新高」的魚,分數裡那條的 pp 要等於成績表第 5 欄', R.nhCheck === 'no-sample' || R.nhCheck.has === true, JSON.stringify(R.nhCheck));
ok('🏅⑮c 🏅 池子:全部 ≥2 條領先、依加總排序', R.edgeN > 0 && R.edgeSorted && R.edgeAllPlus, `n=${R.edgeN}`);
ok('🏅⑮d ⚠️ 避雷池過濾正確', R.avoidOk);
ok('🏅⑮e 卡片顯示實測體質 + 每條 pp + 免責', /實測體質/.test(R.card) && /pp/.test(R.card) && /不是勝率/.test(R.card), R.card.slice(0, 200));
ok('🧺⑯ 釣起 → 籃子有這條、寫進 localStorage', /南亞科/.test(R.basket1) && R.stored.length === 1 && R.stored[0].sym === '2408', R.basket1.slice(0, 120));
ok('🧺⑯b 釣起後卡片按鈕變「放生」', /放生/.test(R.cardAfterCatch));
ok('🧺⑯c 價格變 +10% 後籃子算出正確的一張損益(元)與天數', new RegExp(`\\+${R.expectLot.toLocaleString()}`).test(R.basket2) && /\+10\.00%/.test(R.basket2) && /\b10\b/.test(R.basket2), R.basket2.slice(0, 200));
ok('🧺⑯d 放生 → 籃子空、localStorage 也清掉', /漁獲籃是空的/.test(R.basketEmpty) && R.storedAfter.length === 0);
ok('🧺⑯e 半截 JSON 不會炸,而且壞值被清掉(陷阱 #18)', Array.isArray(R.badLoad) && R.badLoad.length === 0 && R.badCleared);
ok('⑤ 切走分頁 rAF 停,而且之後不再排新的一格', R.stoppedOnLeave && R.noRafAfterLeave);
ok('⑦ 停在很久以前的資料 → ⚠️ 資料未更新', /資料未更新/.test(R.stale3) && /天前/.test(R.stale3), R.stale3);
ok('⑦b 2 天前的資料不誤報(週末守門)', R.fresh === '', R.fresh);
ok('⑥c 資料不在 → 誠實說「還沒產出」+「不是壞掉」', /還沒產出/.test(R.noData) && /不是這個功能壞掉/.test(R.noData), R.noData);
ok('📐 390 寬 8 個分頁都無橫向溢出(scrollX ≤ 2)', Object.values(R.overflow).every(v => v <= 2), JSON.stringify(R.overflow));
ok('🗺️ 熱力圖:磚數 ≥5、鋪滿畫布(≥85%)', R.treeN >= 5 && R.treeArea >= 0.85, `n=${R.treeN} area=${R.treeArea.toFixed(2)}`);
ok('🗺️b 磚面積跟成交額同向(大的不可比小的小)', R.treeMono, JSON.stringify(R.treeDbg));
ok('🗺️c 點磚 → 板塊明細(rotOpen)', R.treeClick);
ok('🗺️d 文案:今天錢在哪 + 「不是輪動訊號」+ 只含上市', /今天錢在哪/.test(R.treeTxt) && /不是.{0,3}輪動訊號/.test(R.treeTxt) && /上市/.test(R.treeTxt), R.treeTxt.slice(0, 120));
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
ok('💥 沒有未攔截的 JS 錯誤', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : `\n✅ 全部通過`);
process.exit(fails.length ? 1 : 0);
