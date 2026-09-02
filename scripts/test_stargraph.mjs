#!/usr/bin/env node
/**
 * 🕸️ 關聯星圖(pro.html 第 4 個分頁 + generate_correlations.py + sw.js)測試 — V74.3.4
 *
 * ⛔ 釘住的鐵則(每一條都用「注入已知缺陷 → 確認叫得出來」驗過):
 *  ① **前端零運算** —— pro.html 不可自己算 Pearson / 相關矩陣。
 *  ② **狀態列舉前後端一致** —— pro.html 的 STAR_STATUS 必須等於 Python 的 ST_FLAT/BREAK/HOT。
 *  ③ **燈號鐵則** —— 盤整那格⛔ 不可用 🟢(🔴🟢 只准表方向);風險/狀態一律非顏色圖示。
 *  ④ **只描述不下指令** —— 整頁⛔ 不可出現買賣價位或進出場指令。
 *  ⑤ **同期相關的免責必須在畫面上**(⛔ 不可只寫在註解或 JSON 裡)。
 *  ⑥ **查不到要好好講話** —— 誠實說出為什麼,⛔ 不可跳紅色錯誤、⛔ 不可靜默空白。
 *  ⑦ **資料載入器⛔ 不可加 ?t= 破快取** —— 加了的話 SW 的 12 小時快取永遠命中不了。
 *  ⑧ **SW 只給這一個檔開快取特例**,其餘 data/*.json 維持純網路。
 *  ⑨ **ECharts 載不到仍要看得到全部資料**(沙箱本來就連不到 CDN → 這條是真的在跑,不是模擬)。
 *  ⑩ **部署佈線** —— 新資料檔要真的被 workflow 產出並收進 gh-pages。
 *
 * ⚠️ 測資一律用**真實產物**(scripts/fixtures/top_correlations.sample.json,從實跑輸出裁下來)——
 *    ⛔ 別憑印象編格式,測資跟程式一起錯的話兩邊「對得上」但真實資料會炸(陷阱 #40)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

const src = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const py  = fs.readFileSync(path.join(ROOT, 'generate_correlations.py'), 'utf8');
const sw  = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/top_correlations.sample.json'), 'utf8'));

// ── 只取「星圖那幾支函式」的原始碼(⛔ 別掃全檔 —— 會被別處的同樣字串救活 = 假綠燈)──
const seg = (name) => {
  const i = src.indexOf(`\n  ${name}(`) >= 0 ? src.indexOf(`\n  ${name}(`) : src.indexOf(`\n  async ${name}(`);
  if (i < 0) return '';
  const j = src.indexOf('\n  },', i);
  return j < 0 ? '' : src.slice(i, j);
};
const STARJS = ['starFetch', '_starEcharts', 'renderStar', '_starIntro', '_starHot', 'starGo', '_starTable', '_starDraw']
  .map(seg).join('\n');
ok('⓪ 星圖 8 支函式都抓得到(⛔ 取樣抓錯的話下面每一條都是假綠燈)',
   STARJS.length > 3000 && ['starFetch', 'starGo', '_starTable', '_starDraw'].every(n => seg(n).length > 100),
   `len=${STARJS.length}`);

// ═══ ① 前端零運算 ═══
// 🚨 掃描前**一定要先拿掉註解** —— 說明「為什麼不在前端算」的那段註解裡就寫著 Pearson,
//    不拿掉的話這條會被自己寫對的說明擋下來(本專案第 9 次踩同一個坑)。
//    ⚠️ 而且要有**空過守門**:剝完註解還要剩下大部分內容,否則這條等於沒驗。
const noCmt = t => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
                    .split('\n').filter(l => !/^\s*(\/\/|#|\*)/.test(l)).join('\n');
const SRC_NC = noCmt(src);
ok('①⓪ 剝註解後仍留著大部分程式碼(⛔ 剝過頭的話下面那條是假綠燈)',
   SRC_NC.length > src.length * 0.55 && /starGo/.test(SRC_NC), `${SRC_NC.length}/${src.length}`);
ok('① pro.html ⛔ 不自己算 Pearson / 相關矩陣(重活全在採礦端)',
   !/pearson|corrcoef|covariance/i.test(SRC_NC) && !/pct_change|\.corr\(/.test(SRC_NC),
   (SRC_NC.match(/.{0,60}(pearson|corrcoef|pct_change)/i) || [])[0] || '');
ok('①b ⛔ 沒有殘留的相關性 Web Worker',
   !fs.existsSync(path.join(ROOT, 'correlationWorker.js')) &&
   !/correlationWorker|new Worker\([^)]*corr/i.test(SRC_NC));

// ═══ ② 前後端列舉一致 ═══
const pyEnum = /ST_FLAT,\s*ST_BREAK,\s*ST_HOT\s*=\s*(\d+),\s*(\d+),\s*(\d+)/.exec(py);
ok('② Python 的狀態列舉找得到', !!pyEnum, py.slice(0, 0));
ok('②b 前端 STAR_STATUS 的 key 跟 Python 一致(0/1/2)',
   !!pyEnum && [pyEnum[1], pyEnum[2], pyEnum[3]].join(',') === '0,1,2' &&
   /STAR_STATUS:\s*\{[\s\S]*?\n\s*0:/.test(src) && /\n\s*1:/.test(src) && /\n\s*2:/.test(src));
ok('②c 採礦端輸出的 status_enum 三格都在',
   Object.keys(FIX.status_enum || {}).sort().join(',') === '0,1,2', JSON.stringify(FIX.status_enum));

// ═══ ③ 燈號鐵則 ═══
const stBlock = /STAR_STATUS:\s*\{([\s\S]*?)\n\s*\},/.exec(src);
ok('③ 狀態 emoji 是 ➖ / 🚀 / 🔥',
   !!stBlock && /➖/u.test(stBlock[1]) && /🚀/u.test(stBlock[1]) && /🔥/u.test(stBlock[1]), stBlock && stBlock[1]);
// ⚠️ regex 一定要加 u flag —— 沒有的話 emoji 會被拆成 surrogate 半碼,🔄 會被誤判成 🔴(V73.9.9 教訓)
ok('③b ⛔ 狀態燈不可用 🔴🟢(那兩顆只准表示漲跌方向)',
   !!stBlock && !/[🔴🟢]/u.test(stBlock[1]), stBlock && stBlock[1]);

// ═══ ④⑤ 文案 ═══
ok('④ 星圖區塊⛔ 不出現買賣/進出場指令',
   !/(進場價|停損|掛單|買點|該買|可以買|建議買|目標價|可加碼|放心做多)/.test(noCmt(STARJS)),
   (noCmt(STARJS).match(/.{0,50}(進場價|停損|掛單|買點|目標價)/) || [])[0] || '');
ok('⑤ 「同期相關不能預測」的免責寫在畫面上(⛔ 不是只在註解裡)',
   /同期/.test(seg('_starIntro')) && /不是預測|不能拿來預測/.test(seg('_starIntro')));
ok('⑤b 而且要寫「不下多空、不計分」',
   /不下多空/.test(seg('_starIntro')) && /不計分/.test(seg('_starIntro')));

// ═══ ⑦ 資料載入器 ═══
ok('⑦ starFetch ⛔ 不加 ?t=Date.now()(加了 SW 的 12 小時快取永遠命中不了)',
   !/t=.*Date\.now\(\)/.test(seg('starFetch')) && !/fetchJson\(/.test(seg('starFetch')), seg('starFetch'));
ok('⑦b starFetch 讀的是 data/top_correlations.json',
   /data\/top_correlations\.json/.test(seg('starFetch')));

// ═══ ⑧ Service Worker ═══
ok('⑧ SW 有 top_correlations.json 的 12 小時快取分支',
   /top_correlations\.json/.test(sw) && /12 \* 60 \* 60 \* 1000/.test(sw));
ok('⑧b 用自訂 header 存時間戳(Cache API 存不了 metadata)', /sw-cached-at/.test(sw));
ok('⑧c 快取分支必須排在「動態資料一律純網路」**之前**(排後面 = 這個特例等於不存在)',
   sw.indexOf('top_correlations.json') < sw.indexOf("reqUrl.pathname.includes('/data/')"));
ok('⑧d 其餘 data/*.json 仍是純網路(⛔ 特例不可擴大)',
   /if \(reqUrl\.pathname\.includes\('\/data\/'\) \|\| reqUrl\.pathname\.endsWith\('\.json'\)\) \{/.test(sw));
ok('⑧e 過期後抓不到仍要吐舊的那份(⛔ 不可空白)', /return hit \|\| new Response/.test(sw));

// ═══ ⑩ 部署佈線 ═══
const dm = fs.readFileSync(path.join(ROOT, '.github/workflows/daily_miner.yml'), 'utf8');
// ⏳ 改 GitHub Actions 屬於「要先問使用者」的例外(CLAUDE.md 授權清單 ③)→ 接線前印 ⏳ 不印 ❌。
//    ⛔ 但**不可以就這樣算了** —— 沒接線的話這個功能永遠沒有資料(陷阱 #9:功能安靜地沒作用)。
//    使用者點頭接上之後,這兩條會自動轉成真的斷言。
// ⑩ 這一步是使用者點頭之後才接的(改 GitHub Actions 屬於 CLAUDE.md 授權清單的例外 ③)。
// 🚨 ⑩b ⛔ 不可只比對字串 'top_correlations.json' —— 光是**註解**裡寫到就會通過 = 假綠燈。
//    真正要驗的是兩件事:① 那一步真的會被執行(run: 底下有這行)
//                        ② 產物真的收得進 gh-pages(部署步驟是 `git add -f data/` 整包收)。
const runsCorr = /run:[\s\S]{0,200}?python3 generate_correlations\.py/.test(dm);
ok('⑩ daily_miner 真的會執行 generate_correlations.py(⛔ 不是只寫在註解裡)', runsCorr,
   (dm.match(/.{0,80}generate_correlations\.py.{0,40}/) || [])[0] || '沒找到');
ok('⑩b 產物收得進 gh-pages —— 部署步驟是 `git add -f data/` 整包收(陷阱 #11)',
   /git add -f index\.html data\//.test(dm) && /git add -f data\//.test(dm));
ok('⑩c 排在 potential/momentum_miner 之後、部署之前(要等 20 個平行節點的 OHLCV 全合併)',
   dm.indexOf('momentum_miner.py') < dm.indexOf('python3 generate_correlations.py') &&
   dm.indexOf('python3 generate_correlations.py') < dm.indexOf('git add -f index.html data/'));
ok('⑩d 失敗⛔ 不擋部署(它是加值資料,讀不到就整條不顯示)',
   /python3 generate_correlations\.py \|\| echo/.test(dm));

// ═══ 採礦端本身 ═══
ok('🐍 成交量有做 股→張 換算(⛔ 直接拿股數比 1000 的話濾網等於沒有,陷阱 #17)',
   /vol \/ 1000\.0/.test(py) && /股 → 張/.test(py));
ok('🐍b 有空過守門(檔數不足拒絕覆寫舊檔)', /CORR_MIN_OK/.test(py) && /拒絕覆寫舊檔/.test(py));
ok('🐍c NaN(新上市股)不 crash,一律歸 Enum 0', /fillna\(False\)/.test(py) && /ST_FLAT, index=/.test(py));
ok('🐍d 有 --selftest', /--selftest/.test(py));
ok('🐍e ETF 排除是預設開(⛔ 不排的話權值股前 5 名全是 ETF)', /EXCL_ETF\s*=\s*\(os\.getenv/.test(py));

// ═══════════════ 實跑 ═══════════════
const benign = t => /Cache|ServiceWorker|Failed to fetch|ERR_|net::/i.test(t);
const errs = [];
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH ? undefined : '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO.STAR_STATUS, null, { timeout: 15000 });

const R = await page.evaluate(async (FIX) => {
  const out = {};
  // 🚨 沙箱連不到網路 → 直接把**真實格式**的測資塞進去(⛔ 別讓它去 fetch,
  //    那會變成「測到網路」而不是「測到渲染」)。
  PRO._starData = FIX;
  PRO._names = { '2330': '台積電', '2317': '鴻海', '2408': '南亞科', '2344': '華邦電',
                 '8299': '群聯', '3006': '晶豪科', '2337': '旺宏', '8131': '福懋科' };
  PRO.switchTab('star');
  await new Promise(r => setTimeout(r, 300));
  out.tabVisible = !document.getElementById('tabStar').classList.contains('hidden');
  out.introTxt = document.getElementById('starNote').innerText;
  out.hotHtml = document.getElementById('starHot').innerHTML;

  await PRO.starGo('2408');
  await new Promise(r => setTimeout(r, 300));
  out.listTxt = document.getElementById('starList').innerText;
  out.listHtml = document.getElementById('starList').innerHTML;
  out.rows = document.querySelectorAll('#starList .startbl tr').length - 1;   // 扣表頭
  out.msgAfterHit = document.getElementById('starMsg').innerText;

  // ⑥ 查不到 —— 三種不同的原因要給不同的說法
  await PRO.starGo('9999'); await new Promise(r => setTimeout(r, 120));
  out.miss = document.getElementById('starMsg').innerText;
  out.missRows = document.querySelectorAll('#starList .startbl tr').length;
  await PRO.starGo('0050'); await new Promise(r => setTimeout(r, 120));
  out.missEtf = document.getElementById('starMsg').innerText;
  await PRO.starGo('ABC'); await new Promise(r => setTimeout(r, 120));
  out.missBad = document.getElementById('starMsg').innerText;

  // 🚧 空過守門:資料整個不存在時要說「還沒產出」,⛔ 不可靜默空白
  PRO._starData = null; PRO._starSym = '';
  document.getElementById('starMsg').innerHTML = '';
  await PRO.renderStar(); await new Promise(r => setTimeout(r, 120));
  out.noData = document.getElementById('starMsg').innerText;
  // 🏷️ 名字全部拿掉再畫一次(模擬連不到 FinMind)
  const _sv = PRO._names; PRO._names = {};
  PRO._starData = FIX;   // ⚠️ 上一段為了驗「還沒產出」把它清掉了 → 這裡要放回
  await PRO.starGo('2408');
  await new Promise(r => setTimeout(r, 300));
  out.noName = { head: document.querySelector('#starList .note b').innerText.trim(),
                 rows: [...document.querySelectorAll('#starList table tr')].slice(1).map(tr => tr.children[0].innerText.replace(/\s+/g, ' ').trim()) };
  // 🚨 2408 在 PRO.CHAIN 裡**有內建名字** → 用它驗標題等於沒驗到(注入驗證當場抓到)。
  //    ⭐ 標題那條一定要用「CHAIN 裡也沒有」的代號(2882 金控),否則永遠是綠的。
  await PRO.starGo('2882');
  await new Promise(r => setTimeout(r, 300));
  out.noNameHead2 = document.querySelector('#starList .note b').innerText.trim();
  PRO._names = _sv;
  // 🔗 V74.4.0:從星圖點股名 → 快捷面板;⚠️ 這頁沒載過選股快照 → 要自己補抓,⛔ 不可整排空白
  delete PRO._cache['data/screener.json'];
  PRO.openStock('2344');
  out.sheet1 = document.getElementById('stkSheet').innerText.replace(/\s+/g, ' ');
  out.sheetOn = document.getElementById('stkSheet').classList.contains('on');
  // 🚨 ⛔ 不可自己塞快取再手動呼叫 _drawStock —— 那樣「自動補抓」那條路根本沒被走到
  //    (第一版就是這樣寫,把補抓整行刪掉測試照樣綠 → 注入驗證當場抓到)。
  //    ⭐ 正解:stub fetchJson,讓 openStock **自己**去抓,然後等它回來看畫面有沒有變。
  const FAKE = { cols: ['c', 'chg', 'chg20', 'pos252', 'amt'], rows: { '2344': [176, -3.5, 12.1, 77, 182] }, ind: { '2344': '半導體' } };
  const _fj = PRO.fetchJson; let fetched = 0;
  PRO.fetchJson = async (u) => { if (u === 'data/screener.json') { fetched++; PRO._cache[u] = FAKE; return FAKE; } return _fj.call(PRO, u); };
  delete PRO._cache['data/screener.json'];
  PRO.openStock('2344');
  await new Promise(r => setTimeout(r, 200));
  out.sheet2 = document.getElementById('stkSheet').innerText.replace(/\s+/g, ' ');
  out.sheetFetched = fetched;
  PRO.fetchJson = _fj;
  return out;
}, FIX);

ok('⑪ 分頁切得過去而且真的顯示出來', R.tabVisible);
ok('⑪b 說明有寫「這張圖在講什麼」+ 可以拿來做什麼',
   /這張圖在講什麼/.test(R.introTxt) && /可以拿來做什麼/.test(R.introTxt), R.introTxt.slice(0, 120));
ok('⑪c 說明有講「誰不在名單裡」(ETF / 冷門股)—— ⛔ 查不到的人才知道為什麼',
   /誰不在名單裡/.test(R.introTxt) && /ETF/.test(R.introTxt));
ok('⑪d 有熱門捷徑(⛔ 別讓使用者面對空輸入框)', /PRO\.starGo\('2330'\)/.test(R.hotHtml));

ok('⑫ 查 2408 有列出鄰居', R.rows === (FIX.r['2408'] || []).length && R.rows > 0, `rows=${R.rows}`);
ok('⑫b 顯示的是中文名(不是只有代號)', /華邦電/.test(R.listTxt) && /群聯/.test(R.listTxt), R.listTxt.slice(0, 160));
ok('⑫c 相關係數有顯示', /0\.8[0-9]/.test(R.listTxt), R.listTxt.slice(0, 200));
ok('⑫d 每一列都有狀態圖示(➖/🚀/🔥)', (R.listTxt.match(/[➖🚀🔥]/gu) || []).length >= R.rows,
   (R.listTxt.match(/[➖🚀🔥]/gu) || []).join(''));
ok('⑫e ⛔ 清單裡不出現 🔴🟢', !/[🔴🟢]/u.test(R.listTxt));
ok('⑫f 股名可點 → 開個股快捷面板(V74.4.0;⛔ 以前是直接把人丟出網站)', /PRO\.openStock\('2344'\)/.test(R.listHtml));

// ⑨ 沙箱連不到 CDN → 這條是**真的**在驗 ECharts 掛掉時的降級路徑
ok('⑨ ECharts 載不到時仍看得到完整資料,而且明說原因(⛔ 不可讓整頁像壞掉)',
   R.rows > 0 && (/圖表元件載入失敗/.test(R.msgAfterHit) || R.msgAfterHit === ''), R.msgAfterHit.slice(0, 120));

ok('⑥ 查不到的代號 → 誠實說原因,⛔ 不是紅色錯誤',
   /沒有在這張圖裡/.test(R.miss) && /均量|沒有成交|相關係數/.test(R.miss), R.miss.slice(0, 200));
ok('⑥b 查不到時舊的表格要清掉(⛔ 不可留上一檔的內容,陷阱 #19)', R.missRows === 0, `rows=${R.missRows}`);
ok('⑥c ETF 要給 ETF 專屬的說法', /ETF 不列入/.test(R.missEtf), R.missEtf.slice(0, 160));
ok('⑥d 不是台股代號要給不同的說法', /不是台股代號/.test(R.missBad), R.missBad.slice(0, 160));
ok('🚧 資料檔還沒產出時要說「還沒產出」+「不是壞掉」(⛔ 靜默空白最糟)',
   /還沒產出/.test(R.noData) && /不是這個功能壞掉/.test(R.noData), R.noData.slice(0, 160));
// ═══ 🏷️ V74.3.9 名字沒載到時⛔ 不可變成「2882 2882」(CLAUDE.md V72.2.0 記過一次,pro.html 又犯)═══
//    ⚠️ 這條是**真實資料實跑**才浮出來的:沙箱/手機連不到 FinMind TaiwanStockInfo 時 `_names` 是空的,
//    而 nameOf 的呼叫端全都寫 `|| code` 當保底 → 名字欄跟代號欄變成同一個數字。
//    ⭐ 更難察覺的是 CHAIN 那 81 檔**有**內建名字 → 只有一部分列會重複。
ok('🏷️ 名字載不到時:列上只出現一次代號(⛔ 不可「2408 2408」),標題也只有代號',
   R.noName.rows.every(t => !/^(\d{4,6})\s+\1\b/.test(t)) && !/^(\d{4,6})\(\1\)/.test(R.noNameHead2) && /^2882$/.test(R.noNameHead2),
   JSON.stringify({ rows: R.noName.rows, head2: R.noNameHead2 }).slice(0, 240));
ok('🏷️b 空過守門:同一批資料在名字載得到時,名字與代號**都要**出現(⛔ 否則上一條可能只是沒渲染)',
   /華邦電/.test(R.listTxt) && /2344/.test(R.listTxt));
ok('🏷️c 只有一份實作:名字+代號一律走 _nmc / _nmTxt / _nmFull(⛔ 不可在各處自己拼)',
   /_nmc\(code, click\)/.test(src) && (src.match(/this\._nmc\(/g) || []).length >= 4
   && !/<span class="starnm"[^>]*>\$\{r\.nm\}<\/span>\s*<span class="starcode">/.test(src));

// ═══ 🔗 V74.4.0 個股快捷面板(從星圖點進來)═══
ok('🔗 點星圖的股名 → 面板打開,而且有「→ 散戶救星」出口與「誰跟它一起動」',
   R.sheetOn && /散戶救星/.test(R.sheet1) && /一起動/.test(R.sheet1), R.sheet1.slice(0, 140));
ok('🔗b 沒有選股快照時要誠實說,⛔ 不可整排空白', /沒有這一檔的數字/.test(R.sheet1), R.sheet1.slice(0, 140));
ok('🔗c 面板要**自己**去補抓快照並重畫(⛔ 否則那句「沒有數字」會永遠掛著)',
   R.sheetFetched === 1 && /現價/.test(R.sheet2) && /176/.test(R.sheet2) && /一年位階/.test(R.sheet2),
   `fetched=${R.sheetFetched} ${R.sheet2.slice(0, 140)}`);
ok('💥 沒有未攔截的 JS 錯誤', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : `\n✅ 全部通過`);
process.exit(fails.length ? 1 : 0);
