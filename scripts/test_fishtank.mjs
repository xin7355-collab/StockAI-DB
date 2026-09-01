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

const noCmt = t => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
                    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const seg = name => {
  const i = src.indexOf(`\n  ${name}(`) >= 0 ? src.indexOf(`\n  ${name}(`) : src.indexOf(`\n  async ${name}(`);
  if (i < 0) return ''; const j = src.indexOf('\n  },', i); return j < 0 ? '' : src.slice(i, j);
};
const FISHJS = ['_fishData', '_fishPoolRows', '_fishSchools', 'renderFish', 'fishMode', '_fishRebuild', '_fishListHtml',
                '_fishSetup', '_fishLegend', '_fishStart', 'fishStop', '_fishTick', '_fishPick', '_fishNote'].map(seg).join('\n');
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

// ═══ 實跑 ═══
const benign = t => /Cache|ServiceWorker|Failed to fetch|ERR_|net::/i.test(t);
const errs = [];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH ? undefined : '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });   // 手機寬(陷阱 #40:桌機寬會假通過)
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO.FISH_POOLS, null, { timeout: 15000 });

const R = await page.evaluate(async ({ SCR, COR }) => {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 測資:真實格式 + 手動加一列 pos252 為 null 的(screener 遇到算不出來就寫 null,這是合法格式)
  SCR.rows['9999'] = SCR.rows['2330'].slice(); SCR.rows['9999'][SCR.cols.indexOf('pos252')] = null;
  PRO._cache['data/screener.json'] = SCR;
  PRO._starData = COR;
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

  // 🎣 釣魚
  PRO._fishPick('2408'); await sleep(100);
  out.card = document.getElementById('fishCard').innerText;
  out.cardHtml = document.getElementById('fishCard').innerHTML;

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
  // 📐 橫版鐵則(CLAUDE.md):8 顆分頁鈕在 390 寬曾爆 12px 橫向溢出(V74.3.5 抓到)→ 每個分頁都量
  out.overflow = {};
  for (const [k] of PRO.TABS) { PRO.switchTab(k); window.scrollTo(80, 0); out.overflow[k] = window.scrollX; }
  window.scrollTo(0, 0);
  window.requestAnimationFrame = _raf;
  return out;
}, { SCR, COR });

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
ok('⑤ 切走分頁 rAF 停,而且之後不再排新的一格', R.stoppedOnLeave && R.noRafAfterLeave);
ok('⑦ 停在很久以前的資料 → ⚠️ 資料未更新', /資料未更新/.test(R.stale3) && /天前/.test(R.stale3), R.stale3);
ok('⑦b 2 天前的資料不誤報(週末守門)', R.fresh === '', R.fresh);
ok('⑥c 資料不在 → 誠實說「還沒產出」+「不是壞掉」', /還沒產出/.test(R.noData) && /不是這個功能壞掉/.test(R.noData), R.noData);
ok('📐 390 寬 8 個分頁都無橫向溢出(scrollX ≤ 2)', Object.values(R.overflow).every(v => v <= 2), JSON.stringify(R.overflow));
ok('💥 沒有未攔截的 JS 錯誤', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : `\n✅ 全部通過`);
process.exit(fails.length ? 1 : 0);
