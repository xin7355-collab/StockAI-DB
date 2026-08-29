#!/usr/bin/env node
/**
 * 🛰️ 產業作戰室 PRO(pro.html,V74.1.0)測試
 *
 * 使用者需求(9 項)對應的釘子:
 *   ① 部署佈線:pro.html 接進 deploy_pages.yml 與 daily_miner.yml **各 4 處**
 *      (paths/checkout・cp 到暫存・cp 回來・git add)—— 少 git add 就是 V69.8.7 圖示那種
 *      「放回去了卻沒 commit,每天被洗掉、零錯誤訊息」。
 *   ② ⛔ 不顯示在散戶救星裡面:index.html 不可出現 pro.html 連結。
 *   ③ 估值數學:隱含價位 = 年化EPS(現價÷官方PE) × 近3年 P5/P25/中位/P75/P95。
 *   ④ 虧損股/無 PE 帶 → 誠實說「不適用」,⛔ 不硬給區間;prompt 表格填「—」。
 *   ⑤ prompt 必含防幻覺約束(禁目標價/買賣評等)+「不是分析師預估」+ 兩種基期的區分。
 *   ⑥ 畫面與 prompt 不可出現 NaN/undefined。
 *   ⑦ AI 鏈表格 67 檔、排序有作用、null 一律排最後(null-sort 陷阱)。
 *   ⑧ 燈號鐵則:不可用 🔴🟢 表品質(regex 必加 u flag —— surrogate 陷阱)。
 *   ⑨ peRank 分段插值:pe = 中位 → 50、pe ≤ 最低 → 0、pe ≥ 最高 → 100。
 *
 * 🆕 V74.1.0 新增(使用者第 2~9 點):
 *   ⑪ 個股可點 → 跳 index.html?sym=,且跳之前把捲動位置/分頁/篩選存進 sessionStorage。
 *   ⑫ 手勢:左右滑切分頁 + 下拉重新整理;⛔ 三個守門(表格內不攔截 / 水平要 2 倍於垂直 / 只在頂端下拉)。
 *   ⑬ 基期:股價基期(pos252)與估值基期(PE 位階)**分開顯示**,背離時要主動點出來。
 *   ⑭ 「目標價」= 歷史估值對照價位:⛔ 標題不可出現「目標價」,而且必須寫「不是目標價/不是預測」。
 *   ⑮ 階段位置(領先/落後):⛔ 樣本不足 5 檔不判定主戰場;文案必須寫「不是預測、未實測」。
 *   ⑯ 單股 prompt:要帶入該檔的 AI 鏈定位與兩種基期。
 *   ⑰ 問 AI:用 <a target="_blank">(⛔ 不可用 window.open —— iOS PWA 會留空白分頁)。
 *   ⑱ 供應鏈五層:台廠記憶體要標成 Enabler 系而非「Core(HBM)」,且文案要說明台廠沒有 HBM。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');

// ① 部署佈線(兩條路徑各 4 處)
for (const [f, min] of [['.github/workflows/deploy_pages.yml', 4], ['.github/workflows/daily_miner.yml', 4]]) {
    const y = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const n = (y.match(/pro\.html/g) || []).length;
    ok(`① ${f} 含 pro.html ≥${min} 處(paths/checkout・cp・cp回・git add)`, n >= min, n);
    ok(`①b ${f} 有 git add pro.html(⛔ 少了=每天被洗掉)`, /git add -f pro\.html/.test(y));
}
ok('①c deploy_pages 的 push paths 有 pro.html(改它才會觸發部署)',
   /- 'pro\.html'/.test(fs.readFileSync(path.join(ROOT, '.github/workflows/deploy_pages.yml'), 'utf8')));
// ② 不顯示在散戶救星裡面
ok('② ⛔ index.html 不可出現 pro.html 連結(使用者明示不掛在 App 內)',
   !/pro\.html/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
// ⑰ ⛔ 不可用 window.open(iOS PWA 空白分頁)
ok('⑰ ⛔ 問 AI 不可用 window.open(iOS PWA 會留空白分頁)', !/window\.open\(/.test(src));
ok('⑰b 用 <a target="_blank"> 點擊開外部 AI', /a\.target\s*=\s*'_blank'/.test(src));
// ⑫ 手勢的三個守門(靜態驗:它們是「拿掉就會出事、但畫面不會報錯」的那種)
ok('⑫ 手勢:表格等可橫向捲動的容器內不攔截(否則表格滑不動)',
   /overflowX === 'auto'[\s\S]{0,120}scrollWidth > n\.clientWidth/.test(src));
ok('⑫b 手勢:水平要 2 倍於垂直(touchmove + touchend **兩處**都要有,⛔ 少一處就會誤觸發)',
   (src.match(/Math\.abs\(dx\) > Math\.abs\(dy\) \* 2/g) || []).length === 2,
   (src.match(/Math\.abs\(dx\) > Math\.abs\(dy\) \* 2/g) || []).length);
ok('⑫c 手勢:下拉重新整理只在頁面頂端起算', /window\.scrollY <= 0/.test(src));
ok('⑫d 重新整理要清快取(⛔ 不清等於什麼都沒做)', /hardRefresh[\s\S]{0,120}this\._cache = \{\}/.test(src));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|Access to fetch/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pageComplete === true && !!window.PRO, null, { timeout: 15000 });

const R = await page.evaluate(async () => {
    // ── stub 資料庫(⛔ 不打網路)──
    PRO._names = { '2382': '廣達', '1111': '假虧損', '2222': '假無帶' };
    PRO._cache['data/screener.json'] = {
        data_date: '2026-08-28',
        cols: ['c', 'pe', 'chg', 'yoy', 'gm', 'f5', 't5', 'chg20', 'f10', 'pos252', 'pb'],
        rows: {
            '2382': [100, 10, 1.5, 20, 15, 500, 300, 5, 800, 88, 3.2],     // ⑬ 股價高位(88) + 估值低位(25) = 背離
            '1111': [50, null, -2, -5, 3, -100, null, null, null, 12, 0.8],
            '2222': [80, 16, 0.5, 8, 22, 0, 0, 2, 10, 45, 2.0],
        },
        ind: { '2382': '25' },
    };
    PRO._cache['data/pe_band.json'] = {
        updated: '2026-08-14T01:00:00Z',
        data: { '2382': { pe: 10, pct: 25, lo: 6, hi: 24, p5: 8, p25: 10, med: 12, p75: 16, p95: 20, n: 750, d: '2026-08-13' } },
    };
    PRO._cache['data/industry_pe.json'] = { industries: { '25': { median_pe: 18.9 } } };
    document.getElementById('inIndustry').value = '測試產業';
    document.getElementById('inCodes').value = '2382, 1111, 2222';
    document.getElementById('inNews').value = '測試動態';
    await PRO.runValuation(true);
    const valHtml = document.getElementById('valOut').innerHTML;
    const out = document.getElementById('valOut').innerText;
    const prompt = PRO.buildPrompt();
    const stockPrompt = PRO.buildStockPrompt(0);
    const r2382 = PRO._valRows.find(r => r.code === '2382');
    const b = PRO._cache['data/pe_band.json'].data['2382'];
    const ranks = [PRO.peRank(12, b), PRO.peRank(5, b), PRO.peRank(30, b), PRO.peRank(8, b)];
    // ⑪ 導航:攔截跳轉,驗 sessionStorage 有存 + 目標網址對
    let navUrl = '';
    const realAssign = Object.getOwnPropertyDescriptor(window.location, 'href');
    PRO._saveNav();  // 先存一次(gotoStock 內部也會存,這裡是驗存檔本身)
    const saved = JSON.parse(sessionStorage.getItem('proWar_nav') || '{}');
    // ⑮ 主戰場:先給每層足夠樣本
    const scr = PRO._cache['data/screener.json'];
    for (const s of PRO.CHAIN.stocks) scr.rows[s[0]] = scr.rows[s[0]] || [100, 15, 0, 10, 20, 0, 0, 1, 0, 50, 2];
    scr.rows['2330'] = [2400, 30, 1, 999, 60, 0, 0, 9.7, -1500, 92, 9.8];
    scr.rows['4585'] = [200, 50, 1, null, 30, 0, 0, null, 0, null, 5];
    // ⚠️ 一定要有一檔**負值** —— 否則「null 當 0」的壞排序也剛好把 null 排最後,注入驗證會漏(測資盲點)
    scr.rows['2317'] = [180, 12, -1, 5, 6, 0, 0, -3, 0, 30, 1.5];
    // 把 L3 成員全部灌成強勢 → 主戰場應判為 L3
    for (const s of PRO.CHAIN.stocks) if (s[4].includes('3')) scr.rows[s[0]][7] = 30;
    // ⚠️ 上一行會把 4585(L3 成員)的 null 一起蓋掉 → null 排序那條就驗不到了(測資自己的坑)
    scr.rows['4585'][7] = null;
    PRO.switchTab('chain', true);
    await new Promise(r => setTimeout(r, 30));
    PRO._sortK = 'yoy'; PRO._sortD = -1; await PRO.renderChain();
    const front = PRO._frontLevel();
    const rows1 = [...document.querySelectorAll('#chainBody tr')];
    const firstCode = rows1[0] ? rows1[0].innerText.trim().slice(0, 4) : '';
    PRO._sortK = 'chg20'; PRO._sortD = -1; await PRO.renderChain();
    const last2 = (() => { const rs = [...document.querySelectorAll('#chainBody tr')]; return rs.length ? rs[rs.length - 1].innerText : ''; })();
    const chainHtml = document.getElementById('tabChain').innerHTML;
    const chainTxt = document.getElementById('tabChain').innerText;
    // ⑮b 樣本不足時不可判主戰場
    const bak = JSON.parse(JSON.stringify(scr.rows));
    for (const kk in scr.rows) scr.rows[kk][7] = null;
    const frontEmpty = PRO._frontLevel();
    scr.rows = bak;
    // ⑱ 供應鏈層篩選
    PRO._layerSel = 'B'; await PRO.renderChain();      // ⚠️ selLayer 內的 renderChain 是 async → 直接 await 才數得到新 DOM
    const bRows = [...document.querySelectorAll('#chainBody tr')].length;
    const bOnly = PRO.CHAIN.stocks.filter(s => s[7] === 'B').length;
    PRO._layerSel = null; await PRO.renderChain();
    const allRows = [...document.querySelectorAll('#chainBody tr')].length;
    return {
        out, valHtml, prompt, stockPrompt, chainTxt, chainHtml,
        nCards: (valHtml.match(/class="vcard"/g) || []).length,
        lo: r2382.lo, mid: r2382.mid, hi: r2382.hi, q25: r2382.q25, q75: r2382.q75,
        eps: r2382.eps, rank: r2382.rank, peer: r2382.peer, peerPx: r2382.peerPx, pos: r2382.pos,
        ranks, savedKeys: Object.keys(saved), savedY: 'y' in saved, savedTab: saved.tab,
        front, frontEmpty, bRows, bOnly, allRows,
        rowsN: rows1.length, firstCode, last2,
        lamp: /[🔴🟢]/u.test(document.body.innerHTML),
        nan: /NaN|undefined/.test(out) || /NaN|undefined/.test(prompt) || /NaN|undefined/.test(stockPrompt),
        gotoInHtml: (valHtml.match(/PRO\.gotoStock\(/g) || []).length,
        missNote: document.getElementById('missNote').innerText,
        // 🚨 陷阱 #32:提醒必須跟表格在**同一個 panel** —— 放在上一個區塊等於沒做(使用者捲到表格就看不到)
        missInTablePanel: document.getElementById('missNote').closest('.panel')
                          === document.getElementById('chainTbl').closest('.panel'),
        badLayer: PRO.CHAIN.stocks.filter(s => !['A','B','C','D','E'].includes(s[7])).length,
        layerN: PRO.CHAIN.stocks.length,
    };
});
// ⑲ 📌 表格凍結:⚠️ 必須用**手機寬度**才有橫向溢出(1280 寬表格塞得下 → 捲不動 → 什麼都驗不到)
await page.setViewportSize({ width: 430, height: 900 });
await page.evaluate(() => { PRO._layerSel = null; PRO._lvSel = null; return PRO.renderChain(); });
const S = await page.evaluate(async () => {
    const wrap = document.querySelector('#tabChain .tblwrap');
    const td1 = () => document.querySelector('#chainBody tr td:first-child');
    const td3 = () => document.querySelector('#chainBody tr td:nth-child(3)');
    const th1 = () => document.querySelector('#chainTbl th');
    const b1 = td1().getBoundingClientRect().left;
    const b3 = td3().getBoundingClientRect().left;
    const bT = th1().getBoundingClientRect().top;
    wrap.scrollLeft = 260; wrap.scrollTop = 400;
    await new Promise(r => requestAnimationFrame(r));
    const r = {
        scrolled: wrap.scrollLeft > 50 && wrap.scrollTop > 50,
        // ⭐ 對照組:同一個「不該凍結」的欄位,捲動前後自己要移動 —— ⛔ 沒這條的話「整張表沒捲」也會假通過
        movedOther: Math.abs(td3().getBoundingClientRect().left - b3),
        stickyOK: Math.abs(td1().getBoundingClientRect().left - b1) <= 2,
        headOK: Math.abs(th1().getBoundingClientRect().top - bT) <= 2,
        // ⚠️ 要驗**整排**表頭 —— 只驗第一個會被 `th:first-child` 的規則遮掉(注入驗證時就是這樣漏掉的)
        thAlign: [...document.querySelectorAll('#chainTbl th')].map(t => getComputedStyle(t).textAlign),
    };
    wrap.scrollLeft = 0; wrap.scrollTop = 0;
    return r;
});
await browser.close();

// ③ 數學
ok('③ 年化EPS = 100/10 = 10', R.eps === 10, R.eps);
ok('③b 隱含區間 = 10×(8/12/20) = 80/120/200', R.lo === 80 && R.mid === 120 && R.hi === 200, [R.lo, R.mid, R.hi]);
ok('③c PE 位階:pe=10 落在 P25 → 25%', R.rank === 25, R.rank);
ok('③d 同業中位 PE 讀 industry_pe(18.9)→ 對應價 189', R.peer === 18.9 && R.peerPx === 189, [R.peer, R.peerPx]);
ok('⑨ peRank:中位→50、帶外低→0、帶外高→100、P5→5', R.ranks[0] === 50 && R.ranks[1] === 0 && R.ranks[2] === 100 && R.ranks[3] === 5, R.ranks);
// ⑭ 價位對照表(使用者要的「目標價」誠實版)
ok('⑭ 價位表有 P25/P75 兩檔(10×10=100、10×16=160)', R.q25 === 100 && R.q75 === 160, [R.q25, R.q75]);
ok('⑭b 表頭寫「如果市場給它這個評價」而不是目標價', /如果市場給它這個評價/.test(R.valHtml));
{
    // ⚠️ 要驗「價位表自己那一段」有免責 —— ⛔ 不可讓卡片別處的免責替它背書(第一版注入驗證就是這樣假通過的)
    const seg = R.valHtml.slice(R.valHtml.indexOf('pxtbl'), R.valHtml.indexOf('pxtbl') + 3000);
    ok('⑭c 🚨 價位表**自己那一段**必須寫「不是目標價、也不是預測」',
       /這不是目標價,也不是預測/.test(seg), seg.slice(-260));
    ok('⑭c2 ⛔ 整份輸出不可出現「目標價:xxx」這種用法', !/目標價[:：]\s*\d/.test(R.out));
}
ok('⑭d 有「一張差多少元」(使用者鐵則:% 一定要配元)', /一張差多少元/.test(R.valHtml));
// ⑬ 兩種基期
ok('⑬ 股價基期與估值基期分開顯示', /股價低基期|股價中基期|股價高基期/.test(R.out) && /估值低基期|估值中基期|估值高基期/.test(R.out), R.out.slice(0, 260));
ok('⑬b 背離要主動點出來(股價88高位 + 估值25低位)',
   /股價在高位、但估值在低位/.test(R.valHtml), R.out.slice(0, 400));
// ④ 不適用要誠實
ok('④ 虧損股(無官方 PE)→ 顯「不適用/不硬給」', /不適用|不硬給/.test(R.out));
ok('④b 三檔都有卡(⛔ 不可把算不出來的整檔藏掉)', R.nCards === 3, R.nCards);
ok('④c prompt 表格對虧損股填 —', /\| 1111 \| 假虧損 \| 50\.0 \| — \| — \|/.test(R.prompt),
   R.prompt.split('\n').filter(l => l.includes('1111')).join(''));
// ⑤ prompt 內容
ok('⑤ prompt 含防幻覺約束(禁目標價/買賣評等)', /禁止.{0,30}目標價/.test(R.prompt) && /買賣評等/.test(R.prompt));
ok('⑤b prompt 誠實標示 EPS 是近4季年化、不是分析師預估', /不是分析師預估/.test(R.prompt) && /年化EPS/.test(R.prompt));
ok('⑤c prompt 有循環股警語(獲利頂峰時 PE 最低)', /循環股.{0,40}PE 最低/.test(R.prompt));
ok('⑤d prompt 要求 AI 分辨兩種基期', /股價基期.{0,30}估值基期|兩件事/.test(R.prompt));
ok('⑤e prompt 代入真實數字(2382 廣達 100.0 / EPS 10.00 / 帶 8-12-20 / 估值25% / 股價88%)',
   /\| 2382 \| 廣達 \| 100\.0 \| 10\.00 \| 8\.0 \/ 12\.0 \/ 20\.0 \| 25% \| 88% \|/.test(R.prompt),
   R.prompt.split('\n').filter(l => l.includes('2382')).join(''));
// ⑯ 單股 prompt
ok('⑯ 單股 prompt 有代號名稱與收盤價', /2382 廣達/.test(R.stockPrompt) && /收盤價:100\.0 元/.test(R.stockPrompt), R.stockPrompt.slice(0, 200));
ok('⑯b 單股 prompt 帶入 AI 產業鏈定位(段/題材/層級/供應鏈層)',
   /AI 產業鏈定位:.*上游/.test(R.stockPrompt) && /供應鏈層/.test(R.stockPrompt),
   (R.stockPrompt.match(/AI 產業鏈定位:.*/) || [''])[0]);
ok('⑯c 單股 prompt 有完整 5 檔 PE 對照價位', /P5 8\.0x → 80\.0 元/.test(R.stockPrompt) && /P95 20\.0x → 200\.0 元/.test(R.stockPrompt));
ok('⑯d 單股 prompt 同樣有防幻覺約束(共用同一份 header)', /禁止.{0,30}目標價/.test(R.stockPrompt));
// ⑪ 導航
ok('⑪ 個股名稱可點(估值卡裡有 gotoStock)', R.gotoInHtml >= 3, R.gotoInHtml);
ok('⑪b gotoStock 跳 index.html?sym=', /location\.href = 'index\.html\?sym=' \+ encodeURIComponent\(code\)/.test(src));
ok('⑪c 跳之前存捲動位置與分頁狀態', R.savedY && R.savedKeys.includes('tab') && R.savedKeys.includes('codes'), R.savedKeys);
ok('⑪d 還原有時效(逾時不還原,⛔ 免得看到過期畫面)', /30 \* 60e3/.test(src));
ok('⑪e bfcache 回來也要補捲動位置', /pageshow[\s\S]{0,120}persisted[\s\S]{0,80}_restoreNav/.test(src));
// ⑥⑧
ok('⑥ 畫面與 prompt 無 NaN/undefined', !R.nan);
ok('⑧ 燈號鐵則:不可用 🔴🟢(u flag)', !R.lamp);
// ⑦ AI 鏈
ok('⑦ 戰情表 81 檔(V74.2.0 新增矽晶圓/無人機/散熱/連接器/光罩等 14 檔)', R.rowsN === 81, R.rowsN);
ok('⑦b 按 YoY 排序 → 2330(stub 999)排第一', R.firstCode === '2330', R.firstCode);
ok('⑦c null 排最後(4585 chg20=null)', /4585/.test(R.last2), R.last2.slice(0, 60));
ok('⑦d 利潤池有中文名而且可點', /台積電/.test(R.chainTxt) && /PRO\.gotoStock\('2330'\)/.test(R.chainHtml));
// ⑮ 階段位置 / 主戰場
ok('⑮ 主戰場判為 L3(L3 成員被灌成最強)', R.front && R.front.lv === 3, R.front);
ok('⑮b 🚧 樣本不足 5 檔 → ⛔ 不判定主戰場', R.frontEmpty === null, R.frontEmpty);
ok('⑮c 表格有「階段位置」欄(主戰場/落後/太早)', /🎯 主戰場|⏳ 落後|🌱 太早/.test(R.chainTxt));
ok('⑮d 🚨 文案必須寫「不是預測、未實測」', /不是 AI 進度預測/.test(R.chainTxt) && /沒有實測過預測力/.test(R.chainTxt), R.chainTxt.slice(0, 300));
ok('⑮e 成熟度那條要說明是人工框架、不隨時間增加', /不會隨時間自己增加/.test(R.chainTxt));
// ⑱ 供應鏈五層
ok('⑱ 五層篩選有作用(B 層 ' + R.bOnly + ' 檔)', R.bRows === R.bOnly && R.bOnly > 0 && R.bRows < R.allRows, [R.bRows, R.bOnly, R.allRows]);
ok('⑱b 🚨 台廠記憶體 ⛔ 不可標成 Core(台廠沒有 HBM)',
   /台廠沒有 HBM|台廠是利基型/.test(src) && /台廠做的是\*\*利基型記憶體不是 HBM\*\*|台廠做的是.{0,10}利基型記憶體不是 HBM/.test(src));
ok('⑱c 每檔都有合法的供應鏈層(A~E),⛔ 不可有漏標', R.badLayer === 0 && R.layerN === 81, [R.badLayer, R.layerN]);
// ⑲ 表格凍結(使用者:「標的這欄及這列要固定住才比對得了」)
ok('⑲ 🚧 空過守門:手機寬度下表格真的捲得動,而且沒凍結的欄位確實跟著移動', S.scrolled && S.movedOther > 50, S);
ok('⑲b 📌 橫向捲動時「標的」欄固定不動', S.stickyOK, S);
ok('⑲c 📌 直向捲動時表頭列固定不動', S.headOK, S);
ok('⑲d 表頭文字**整排**置中(⛔ 不可只有第一欄)',
   S.thAlign.length >= 8 && S.thAlign.every(a => a === 'center'), S.thAlign);
// 🚨 缺資料要誠實說,⛔ 不可靜默顯一排「—」
ok('⑳b 🚨 提醒必須跟戰情表在同一個 panel(⛔ 放在上一區塊 = 捲到表格就看不到)', R.missInTablePanel);
ok('⑳ 缺資料時要說出原因(上櫃/採礦未收到),⛔ 不可讓人以為程式壞了',
   !R.missNote || (/不是這幾檔沒在動|不是程式壞掉/.test(R.missNote) && /上櫃/.test(R.missNote)), R.missNote.slice(0, 120));
ok('⑩ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PROHTML_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
