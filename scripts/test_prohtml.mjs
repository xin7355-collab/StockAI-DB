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
// ⚠️ V74.4.8:這條第一版直接掃整份 index.html → 被**註解裡提到 pro.html** 給擋下來
//   (本專案第 8 次踩「說明文字本身含有被禁字串」這個坑)。
//   ⭐ 正解:只掃**會渲染出去的東西** —— 先剝掉 // 與 /* */ 註解;
//   並加**空過守門**(剝完不可以只剩一點點,否則這條等於沒驗)。
{
    const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const live = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('②z 🚧 空過守門:剝掉註解後仍要留著大部分內容(⛔ 否則下面那條是假通過)',
       live.length > raw.length * 0.6, `${live.length}/${raw.length}`);
    ok('② ⛔ index.html 不可出現 pro.html 連結(使用者明示不掛在 App 內)',
       !/pro\.html/.test(live), (live.match(/.{0,40}pro\.html.{0,40}/) || [''])[0]);
}
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
        // ⚠️ amp20/amt 加在**最後** —— 既有斷言吃的是索引,插在中間會全部錯位(陷阱 #40 的鄰居)
        cols: ['c', 'pe', 'chg', 'yoy', 'gm', 'f5', 't5', 'chg20', 'f10', 'pos252', 'pb', 'amp20', 'amt'],
        rows: {
            '2382': [100, 10, 1.5, 20, 15, 500, 300, 5, 800, 88, 3.2, 5.0, 90],     // ⑬ 股價高位(88) + 估值低位(25) = 背離
            '1111': [50, null, -2, -5, 3, -100, null, null, null, 12, 0.8, 1.0, 5],
            '2222': [80, 16, 0.5, 8, 22, 0, 0, 2, 10, 45, 2.0, 3.5, 20],
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
    r.overscroll = getComputedStyle(wrap).overscrollBehaviorY;
    return r;
});
// ㉑ 點五級卡 → 要真的跳到個股戰情表(使用者:「點進去要跳到戰情表」)
const J = await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 30));
    const before = window.scrollY;
    PRO.selLv(2);
    await new Promise(r => setTimeout(r, 700));
    const panel = document.getElementById('mapPanel');
    const out = {
        before, after: window.scrollY,
        panelTop: panel ? panel.getBoundingClientRect().top : null,
        // 篩選有生效嗎(⛔ 只捲過去但沒篩 = 只做一半)
        rows: document.querySelectorAll('#chainBody tr').length,
        allRows: PRO.CHAIN.stocks.length,
        backBtn: /backToLv\(\)/.test(document.getElementById('layerBar').innerHTML),
    };
    PRO.backToLv();
    await new Promise(r => setTimeout(r, 700));
    out.backScroll = window.scrollY;
    out.backRows = document.querySelectorAll('#chainBody tr').length;
    return out;
});
// ㉒ 💧 板塊輪動:四象限泡泡(使用者回報「不好看 / 一頁式 / 上上下下」後改版)
const T = await page.evaluate(async () => {
    PRO._cache['data/sector_rot.json'] = {
        updated: '2026-08-31 20:00', win: 20, listed_only: true,
        flow_keys: { f: '外資', t: '投信', dl: '自營', mg: '融資(散戶代理)' },
        days: ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'],
        ind: {
            '15': { n: 28, r20: [-5, -2, 0, 1, 8], flow: { f: [1, 1, 1, 1, 1], t: [1, 1, 1, 1, 1], dl: [0, 0, 0, 0, 0], mg: [1, 1, 1, 1, 1] } },
            '17': { n: 32, r20: [1, 1, 1, 1, 3], flow: { f: [-10, -10, -10, -10, -10], t: [5, 5, 5, 5, 5], dl: [0, 0, 0, 0, 0], mg: [-1, -1, -1, -1, -1] } },
            // ⚠️ 第一天塞一個 −35 —— 真實資料的分布就是這樣(全期最大 |r20| 38.5%,
            //    但平常那天只有 −11 ~ +2)。⛔ 沒有這個落差,「X 尺標用最大值還是 P95」根本測不出來。
            '10': { n: 31, r20: [-35, 2, 2, 2, -4], flow: { f: [2, 2, 2, 2, 2], t: [0, 0, 0, 0, 0], dl: [0, 0, 0, 0, 0], mg: [0, 0, 0, 0, 0] } },
            '24': { n: 96, r20: [8, 5, 3, 0, -9], flow: { f: [180, 180, 180, 180, 180], t: [-77, -77, -77, -77, -77], dl: [0, 0, 0, 0, 0], mg: [-17, -17, -17, -17, -17] } },
            '99': { n: 3, r20: [null, null, null, null, null], flow: { f: [null, null, null, null, null], t: [null, null, null, null, null], dl: [null, null, null, null, null], mg: [null, null, null, null, null] } },
        },
        // 🎯 題材(⭐ 格式照 miner 真產物 —— 陷阱 #40:測資格式必須跟真實資料一樣)
        themes: {
            mem: { n: 6, r20: [2, 3, 5, 7, 9.2], flow: { f: [50, 60, 40, 55, 80], t: [1, 1, 1, 1, 1], dl: [0, 0, 0, 0, 0], mg: [-2, -2, -2, -2, -2] } },
            cool: { n: 5, r20: [12, 12, 12, 13, 13], flow: { f: [20, 20, 20, 20, 20], t: [0, 0, 0, 0, 0], dl: [0, 0, 0, 0, 0], mg: [0, 0, 0, 0, 0] } },
            wafer: { n: 4, r20: [-20, -21, -22, -23, -23.6], flow: { f: [-9, -9, -9, -9, -9], t: [0, 0, 0, 0, 0], dl: [0, 0, 0, 0, 0], mg: [0, 0, 0, 0, 0] } },
        },
        theme_names: { mem: '記憶體', cool: '散熱/液冷', wafer: '矽晶圓' },
    };
    // 明細表要用 screener 的 ind 對照 + 名稱
    // 🚨🚨 這裡**必須用真實資料的格式**:screener.json 存的是 {股號: **中文產業名**}
    //    (實測 '1101' → '水泥'),⛔ 不是產業代碼。
    //    第一版測資寫成代碼('24')→ 跟正式程式一樣「比代碼」→ 兩邊一起錯、測試照樣綠,
    //    而真實資料上成分股表**永遠是空的**。⭐ 測資格式跟真實資料不同 = 這條測試等於沒驗。
    //    ⭐ '2801' 是**別名**案例:輪動圖 '17' 叫「金融」、screener 叫「金融保險」。
    PRO._cache['data/screener.json'].ind = Object.assign({}, PRO._cache['data/screener.json'].ind,
        { '2382': '半導體', '2222': '半導體', '2317': '航運', '2801': '金融保險' });
    PRO._names = Object.assign({}, PRO._names, { '2382': '廣達', '2222': '假無帶', '2317': '鴻海', '2801': '彰銀' });
    PRO._cache['data/screener.json'].rows['2801'] = [20, 12, 0.5, 3, null, 40, 10, 1, 50, 30, 0.9];
    PRO.switchTab('rot');
    await new Promise(r => setTimeout(r, 200));
    // 🚨 <details> 收合時 innerText **是空的** → 不先展開的話,底下所有「文案必須寫什麼」
    //    的斷言都拿到空字串 = 假失敗/假通過。(實測總表那頁踩過同一個坑,這是第二次。)
    document.querySelectorAll('#tabRot details').forEach(e => { e.open = true; });
    await new Promise(r => setTimeout(r, 30));
    const bubs = () => [...document.querySelectorAll('#rotBubs .bub')];
    const posOf = k => {
        const el = bubs().find(e => e.dataset.k === k); if (!el) return null;
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform);
        return m ? { x: +m[1], y: +m[2] } : null;
    };
    const out = {
        nBub: bubs().length,
        hasEmpty: bubs().some(e => e.dataset.k === '99'),
        lastDay: document.getElementById('rotDay').textContent,
        p15: posOf('15'), p24: posOf('24'),
        verdict: document.getElementById('rotVerdict').innerText,
        vH: document.getElementById('rotVerdict').getBoundingClientRect().height,
        vMinH: getComputedStyle(document.getElementById('rotVerdict')).minHeight,
        // 🚧 尺標壞掉的話泡泡會飛出畫布(_rotMax 若不是全期最大值就會這樣)
        outside: bubs().filter(e => {
            const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(e.style.transform);
            return !m || +m[1] < 0 || +m[1] > PRO.QW || +m[2] < 0 || +m[2] > PRO.QH;
        }).length,
        svgTop: document.querySelector('#rotRace svg').getBoundingClientRect().top,
        chips: document.getElementById('rotList').innerText,
        note: document.getElementById('rotNote').innerText,
        fiNote: document.getElementById('rotFiNote').innerText,
        fiFirst: (document.querySelector('#rotFiBody tr td') || {}).textContent,
        flowChks: [...document.querySelectorAll('#rotFlowBar .fchk')].map(e => e.textContent.trim()),
        flowOnN: document.querySelectorAll('#rotFlowBar .fchk.on').length,
        headTxt: document.getElementById('rotFiHead').innerText,
    };
    // 🚧 版面穩定:拉時間軸時,結論條高度與圖的位置**不可以變**(使用者回報「上上下下」)
    PRO.rotSeek(0);
    await new Promise(r => setTimeout(r, 60));
    out.vH0 = document.getElementById('rotVerdict').getBoundingClientRect().height;
    out.svgTop0 = document.querySelector('#rotRace svg').getBoundingClientRect().top;
    out.day0 = document.getElementById('rotDay').textContent;
    out.p24_day0 = posOf('24'); out.p15_day0 = posOf('15');
    // 打勾要讓泡泡的 Y 移動(Y 軸 = 勾起來那幾條的合計)
    PRO.rotSeek(4); await new Promise(r => setTimeout(r, 60));
    const y24 = posOf('24').y;
    PRO.toggleFlow('f');                       // 關掉外資(半導體 +180 億)
    await new Promise(r => setTimeout(r, 60));
    document.querySelectorAll('#tabRot details').forEach(e => { e.open = true; });
    out.y24_noF = posOf('24').y; out.y24_withF = y24;
    out.headNoF = document.getElementById('rotFiHead').innerText;
    out.firstNoF = (document.querySelector('#rotFiBody tr td') || {}).textContent;
    PRO.toggleFlow('t'); PRO.toggleFlow('mg');
    out.lastOnN = document.querySelectorAll('#rotFlowBar .fchk.on').length;
    PRO.toggleFlow('f'); PRO.toggleFlow('t');
    out.noteTxt = document.getElementById('rotFiNote').innerText;
    // 📱 長版 + ⏩ 速度 + 🔎 明細
    out.aspect = PRO.QH / PRO.QW;
    out.spd0 = document.getElementById('rotSpd').textContent;
    PRO.rotCycleSpeed();
    out.spd1 = document.getElementById('rotSpd').textContent;
    out.spdVal = PRO._rotSpeed;
    PRO.rotSeek(4);
    PRO.rotOpen('24');                       // 點半導體
    await new Promise(r => setTimeout(r, 60));
    out.detTxt = document.getElementById('rotDetail').innerText;
    out.detRows = document.querySelectorAll('#rotDetail tbody tr').length;
    out.detHasGoto = /PRO\.gotoStock\('2382'\)/.test(document.getElementById('rotDetail').innerHTML);
    PRO.rotSeek(1);
    await new Promise(r => setTimeout(r, 60));
    out.detTxtPast = document.getElementById('rotDetail').innerText;
    PRO.rotOpen('24');                       // 再點一次要收起
    out.detClosed = document.getElementById('rotDetail').innerHTML === '';
    // ⭐ 別名產業:輪動圖 '17' 叫「金融」,screener 叫「金融保險」→ 要靠 IND_ALIAS 才對得上
    PRO.rotSeek(4); PRO.rotOpen('17');
    await new Promise(r => setTimeout(r, 60));
    out.aliasTxt = document.getElementById('rotDetail').innerText;
    out.aliasRows = document.querySelectorAll('#rotDetail tbody tr').length;
    PRO.rotOpen('17');
    // ⛔ 真的對不上時要「說出來」,不可靜默空白('10' 鋼鐵在測資裡一檔都沒有)
    PRO.rotOpen('10');
    await new Promise(r => setTimeout(r, 60));
    out.missTxt = document.getElementById('rotDetail').innerText;
    PRO.rotOpen('10');
    // ㉖ 🎯 題材模式(V74.3.5)
    PRO._names = Object.assign({}, PRO._names, { '2408': '南亞科', '8299': '群聯' });
    PRO._cache['data/screener.json'].rows['2408'] = [80, 15, -0.2, 30, 30, 20597, 100, 49.8, 30000, 90, 2.5];
    PRO._cache['data/screener.json'].rows['8299'] = [600, 12, -0.2, 20, 25, 0, 50, 31.1, 100, 85, 3.0];
    PRO.rotToggleMode();
    await new Promise(r => setTimeout(r, 120));
    out.thBtn = document.getElementById('rotMode').textContent;
    out.thBubs = document.querySelectorAll('#rotBubs .bub').length;
    out.thChips = document.getElementById('rotList').innerText.replace(/\s+/g, ' ');
    out.thVerd = document.getElementById('rotVerdict').innerText;
    // ㉘ 🧬 個股泡泡圖:2408 高位階高振幅(命中)/ 8299 低位階低振幅(不命中)
    PRO._cache['data/screener.json'].rows['2408'] = [80, 15, -0.2, 30, 30, 20597, 100, 49.8, 30000, 90, 2.5, 5.5, 300];
    PRO._cache['data/screener.json'].rows['8299'] = [600, 12, -0.2, 20, 25, 0, 50, 31.1, 100, 20, 3.0, 1.2, 50];
    // ㉙ ③ 資金走向 sparkline 的個股 K 線測資 ——
    //   🚨 必須在 rotOpen 之前塞進 _cache:測試開了 --allow-file-access-from-files,
    //   不塞的話 _fillStockFlows 會抓到 repo 裡**真實的** data/2408.json(非決定性)。
    //   欄位格式照真實檔(陣列的 bar,foreign_net 單位=股 —— 陷阱 #40:測資格式要跟真檔一樣)
    PRO._cache['data/2408.json'] = Array.from({ length: 30 }, (_, i) => ({
      date: '2026/07/' + String(1 + (i % 28)).padStart(2, '0'),
      open: 80, close: 81, high: 82, low: 79, volume: 9e6,
      foreign_net: i % 3 === 0 ? -2000000 : 1500000 }));
    PRO._cache['data/8299.json'] = Array.from({ length: 30 }, (_, i) => ({
      date: '2026/07/' + String(1 + (i % 28)).padStart(2, '0'),
      open: 600, close: 601, high: 602, low: 599, volume: 5e5,
      foreign_net: 0 }));                     // 全 0 → 要誠實顯「—」不可畫空圖
    PRO.rotOpen('mem');
    await new Promise(r => setTimeout(r, 80));
    out.thDetTxt = document.getElementById('rotDetail').innerText;
    out.thDetRows = document.querySelectorAll('#rotDetail tbody tr').length;
    {
      const d = document.getElementById('rotDetail');
      out.sbN = d.querySelectorAll('.sbub circle').length;
      out.sbAmber = d.querySelectorAll('.sbub circle[stroke="var(--amber)"]').length;
      out.sbGene = (d.innerText.match(/🧬 這一組命中 (\d+)\/(\d+)/) || []).slice(1).join('/');
      out.sbGoto = /PRO\.gotoStock\('2408'\)/.test(d.innerHTML);
      out.sbTxt = d.innerText;
    }
    document.querySelectorAll('#tabRot details').forEach(d => d.open = true);
    out.thNote = document.getElementById('rotNote').innerText;
    // ㉙ ②③④ 成員總覽 + 個股資金走向 + 選中樣式(V74.4.2,趁 'mem' 明細還開著收)
    await new Promise(r => setTimeout(r, 80));
    await PRO._fillStockFlows();              // 保證 async 填圖跑完再量(rotOpen 那次沒 await)
    out.flowCells = document.querySelectorAll('#rotDetail td.flowcell').length;
    out.flowSpark = document.querySelectorAll('#rotDetail td.flowcell svg.flowspark rect').length;
    out.flowCum = /張/.test([...document.querySelectorAll('#rotDetail td.flowcell')].map(td => td.innerText).join(''));
    out.flowNone = [...document.querySelectorAll('#rotDetail td.flowcell')].some(td => td.textContent === '—');
    out.flowNote = document.getElementById('rotDetail').innerText;
    await PRO._rotMembers();
    out.memRows = document.querySelectorAll('#rotMembers .memrow').length;
    out.memTxt = document.getElementById('rotMembers').innerText.replace(/\s+/g, ' ');
    out.memGoto = /PRO\.gotoStock\('2408'\)/.test(document.getElementById('rotMembers').innerHTML);
    out.memSelOn = document.querySelectorAll('#rotMembers .memhead.on').length;   // 'mem' 開著 → 恰 1
    out.chipOnCls = document.querySelectorAll('#rotList .rotchip.on').length;     // 名次條選中恰 1
    PRO.rotOpen('mem');
    // 題材資料不存在時要說出來,⛔ 不可靜默(themes 鍵拿掉再切一次)
    const _th = PRO._cache['data/sector_rot.json'].themes;
    delete PRO._cache['data/sector_rot.json'].themes;
    await PRO.renderRot();
    out.thMissing = document.getElementById('rotVerdict').innerText;
    PRO._cache['data/sector_rot.json'].themes = _th;
    // 切回官方模式要完整復原
    PRO.rotToggleMode();
    await new Promise(r => setTimeout(r, 120));
    out.backBubs = document.querySelectorAll('#rotBubs .bub').length;
    out.backBtn = document.getElementById('rotMode').textContent;
    // ㉗ 📐 版面:泡泡要**真的散得開**(使用者截圖:全部擠成一團)
    // 🚨 這一段刻意換上**照真實規模**的測資(32 組 × 120 天)——
    //    上面那份小測資只有 20 個 r20 值,P95 會退化成最大值 → 「P95 vs 最大值」根本測不出來
    //    (陷阱 #40:測資跟真實資料規模不同 = 那條測試等於沒驗)。
    {
      const big = { updated: 'x', win: 20, listed_only: true,
        flow_keys: { f: '外資', t: '投信', dl: '自營', mg: '融資(散戶代理)' }, days: [], ind: {} };
      for (let d = 0; d < 120; d++) big.days.push('2026-' + String(1 + (d % 12)).padStart(2, '0') + '-' + String(1 + (d % 28)).padStart(2, '0'));
      for (let i = 0; i < 32; i++) {
        const r20 = [], fl = { f: [], t: [], dl: [], mg: [] };
        for (let d = 0; d < 120; d++) {
          // 多數落在 ±8%,少數極端(真實:P95 = 5.0 而最大 38.5)
          r20.push(i === 0 && d < 3 ? -38 + d : +(Math.sin(i * 1.7 + d / 6) * 7).toFixed(2));
          // 資金流極度偏斜(真實:|中位| 10 億、最大 2801 億)
          const amp = i === 3 ? 600 : i === 7 ? 120 : 8;
          fl.f.push(+(Math.sin(i * 2.3 + d / 4) * amp).toFixed(2));
          fl.t.push(+(Math.cos(i + d / 9) * 3).toFixed(2));
          fl.dl.push(0); fl.mg.push(+(Math.sin(d / 3) * 2).toFixed(2));
        }
        big.ind['I' + i] = { n: 5 + i, r20, flow: fl };
      }
      PRO._cache['data/sector_rot.json'] = big;
      PRO._rotMode = 'ind';
      await PRO.renderRot();
      await new Promise(r => setTimeout(r, 550));   // ⚠️ 等 .bub 的 0.42s transition 跑完
      const bubs = () => [...document.querySelectorAll('#rotBubs .bub')].filter(e => e.style.opacity !== '0');
      const ctr = e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      const svg = document.querySelector('#rotRace svg').getBoundingClientRect();
      const pos = bubs().map(ctr), xs = pos.map(o => o.x), ys = pos.map(o => o.y);
      const span = a => Math.max(...a) - Math.min(...a);
      const midY = svg.y + svg.height / 2;
      out.nBubs = pos.length;
      out.spreadY = span(ys) / svg.height * 100;
      out.nearMidPct = ys.filter(y => Math.abs(y - midY) < svg.height * 0.05).length / pos.length * 100;
      out.nTicks = document.querySelectorAll('#rotRace text.qtick').length;
      out.quadTxt = document.getElementById('rotQuad').innerText.replace(/\s+/g, ' ');
      out.quadSum = [...document.getElementById('rotQuad').querySelectorAll('b')]
        .reduce((s, b) => s + (+(b.textContent.match(/\d+/) || [0])[0]), 0);
      out.sy10 = PRO._sy(10); out.sy1000 = PRO._sy(1000);
      // ⭐ 對照組:X 尺標換成「全期最大值」(舊版做法)重畫 → P95 版必須散得更開
      out.spreadP95px = span(xs);
      const keep = PRO._rotMax;
      let gmax = 0;
      for (const o of Object.values(big.ind)) for (const v of o.r20) if (v != null) gmax = Math.max(gmax, Math.abs(v));
      // ⚠️ .bub 有 0.42s 的 transition —— ⛔ 改完立刻量會拿到**動畫還沒跑完的舊位置**
      //    (第一版就是這樣,兩種尺標量出來一模一樣 317px、看起來像「這個改動沒用」)。
      PRO._rotMax = gmax; PRO.rotSeek(PRO._rotK);
      await new Promise(r => setTimeout(r, 550));
      out.spreadMaxPx = span(bubs().map(ctr).map(o => o.x));
      PRO._rotMax = keep; PRO.rotSeek(PRO._rotK);
      await new Promise(r => setTimeout(r, 550));
    }
    PRO.rotSeek(4);
    PRO.rotPlay(); out.playing = !!PRO._rotTimer;
    PRO.switchTab('val');
    out.stoppedOnLeave = !PRO._rotTimer;
    return out;
});
// ㉔ 🔬 實測總表
// ㉜ 🎯 今日訊號頁(V74.4.5 使用者:「開一個高勝率訊號頁面併寫出勝率、還有要怎麼操作、注意什麼」)
//   ⛔ 這一頁最危險的是「讓人以為照著買就會賺」→ 五條釘死:
//     ① 勝率一定配次數,次數<10 要標「不能當結論」
//     ② 必須寫「基準勝率 36% 不是 50%」
//     ③ ⛔ 整頁不可出現「開盤買」指令(實測那樣少賺一半)
//     ④ 空頭趨勢(bear)的標的要標出來
//     ⑤ 檔案沒產出要說出來,⛔ 不可靜默空白
const SIG = await page.evaluate(async () => {
    const out = {};
    // 測資照**真實產物格式**(⛔ 憑印象編會測不到真的問題 —— 陷阱 #40)
    PRO._names = Object.assign({}, PRO._names, { '6949': '測試甲', '1303': '南亞', '9999': '測試乙', '8888': '測試丙' });
    PRO._cache['data/playbook_edge.json'] = {
        updated: 'x', data_date: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
        scanned: 2319, min_n: 8, cost: 0.44, picks_total: 3,
        picks: [
            { s: '9999', c: 100, k: '💪 發動棒破昨高', w: 42.4, po: 9.9, exp: 11.66, lb: 4.97, n: 33, trig: 105, loose: 0, hq: 0, bear: 0, up: 3, stop: 95 },
            { s: '6949', c: 200, k: '🌊 威科夫吸籌', w: 50, po: 3, exp: 5, lb: 2.0, n: 40, trig: 210, loose: 0, hq: 1, bear: 0, up: 5, stop: 190 },
            { s: '8888', c: 50, k: '🕯️ 守住長紅K', w: 60, po: 2, exp: 8, lb: 6.0, n: 5, trig: 52, loose: 1, hq: 0, bear: 1, up: 2, stop: 47 },
        ],
    };
    PRO._cache['data/today_signals.json'] = {
        updated: 'x', data_date: '2026-08-31', scanned: 2319, base_win: 36.39,
        cost_note: '期望值未扣交易成本(來回約 0.44%,當沖 0.25%)', bull_total: 2,
        bull: [{ s: '1303', c: 242.5, v: 1, d: '2026-08-31', t: '換手量(洗籌續攻)', g: 'A', n: 1309, w: 42.4, exp: 0.68, po: 1.56 }],
    };
    const scr = PRO._cache['data/screener.json'];
    scr.data_date = '2026-08-31';
    if (!scr.cols.includes('chg5')) scr.cols.push('chg5');
    if (!scr.cols.includes('att')) scr.cols.push('att');
    const Ci = {}; scr.cols.forEach((c, i) => Ci[c] = i);
    scr.rows['1303'] = new Array(scr.cols.length).fill(0);
    scr.rows['1303'][Ci.chg5] = 45; scr.rows['1303'][Ci.att] = 1;   // 噴 45% 又掛注意 → 要進避雷
    scr.rows['6949'] = new Array(scr.cols.length).fill(0);
    scr.rows['6949'][Ci.chg5] = 45; scr.rows['6949'][Ci.att] = 0;   // 噴但沒掛注意 → ⛔ 不可進避雷
    // 🌅 盤前分數:公式必須跟探針 STRICT 模式一致(⛔ 同名不同義)
    //   這組值算出來:那指 +1 / 標普 +1 / 費半 +1.5 / 台積ADR +2 / VIX +0.5 / 日經 +1 / 韓股 +1 / 台幣 +0.5 = 8.5 分
    PRO._cache['data/macro_risk.json'] = {
      nasdaq_chg_pct: 1.2, sp500_chg_pct: 0.8, sox_chg_pct: 2.1, tsm_chg_pct: 1.5,
      vix_chg_pct: -3.0, nikkei_chg_pct: 0.9, kospi_chg_pct: 1.1, usdtwd_chg_pct: -0.2,
    };
    PRO.switchTab('sig');
    await PRO.renderSig();
    await new Promise(r => setTimeout(r, 60));
    out.how = document.getElementById('sigHow').innerText;
    out.premktScore = PRO._premktScore(PRO._cache['data/macro_risk.json']);
    // 成分不足 → ⛔ 不硬給分數
    out.premktThin = PRO._premktHtml({ nasdaq_chg_pct: 1, sp500_chg_pct: 1 });
    // 資料沒到 → 要說出來
    out.premktNone = PRO._premktHtml(null);
    out.picks = document.getElementById('sigPicks').innerText;
    out.pickRows = document.querySelectorAll('#sigPicks tbody tr').length;
    out.firstRow = (document.querySelector('#sigPicks tbody tr') || {}).innerText || '';
    out.today = document.getElementById('sigToday').innerText;
    out.avoid = document.getElementById('sigAvoid').innerText;
    out.all = document.getElementById('tabSig').innerText;
    out.inWrap = !!document.querySelector('.wrap #tabSig');
    out.btn = (document.getElementById('tabBtnSig') || {}).textContent || '';
    // 過期清單要警告
    PRO._cache['data/playbook_edge.json'].data_date = '2026-01-01';
    await PRO.renderSig();
    out.stale = document.getElementById('sigPicks').innerText;
    // 檔案沒產出 → 要說出來(⛔ 不可靜默空白)
    PRO._cache['data/playbook_edge.json'] = null;
    PRO._cache['data/today_signals.json'] = null;
    await PRO.renderSig();
    out.missing = document.getElementById('sigPicks').innerText + ' ' + document.getElementById('sigToday').innerText;
    return out;
});
ok('㉜ 分頁註冊 + 容器在 .wrap 裡 + 按鈕文字無 emoji(使用者要求刪過分頁圖示)',
   SIG.inWrap && SIG.btn === '今日訊號' && /'sig', 'Sig'/.test(src), `btn=${SIG.btn} wrap=${SIG.inWrap}`);
ok('㉜a 作戰清單真的渲染出列', SIG.pickRows === 3, `rows=${SIG.pickRows}`);
ok('㉜b 🚨 排序:🧬 優先(6949 hq=1 要排第一,即使它的保守成績比 9999 低)',
   /6949/.test(SIG.firstRow) && /🧬/.test(SIG.firstRow), SIG.firstRow.slice(0, 60));
ok('㉜c 🚨 勝率一定配次數;次數 <10 要標「不能當結論」',
   /42% ・33 次/.test(SIG.picks.replace(/\s+/g, ' ')) && /次數太少/.test(SIG.picks), '');
ok('㉜d 🚨 必須寫「基準勝率 36%、不是 50%」(⛔ 少了會讓人覺得 30% 勝率很爛)',
   /36%/.test(SIG.all) && /不是 50%/.test(SIG.all));
ok('㉜e 🚨🚨 ⛔ 整頁不可出現「開盤買」這種指令 —— 實測那樣少賺一半',
   !/開盤就買|開盤買進|明天開盤買/.test(SIG.all.replace(/隔天一開盤就買|開盤前掛/g, '')),
   (SIG.all.match(/[^。\n]{0,12}開盤買[^。\n]{0,12}/g) || []).join(' | '));
ok('㉜f ⭐ 必須把「掛前一日收盤價」的實測結果寫出來(使用者提的方法,實測最糟)',
   /前一天收盤價/.test(SIG.how) && /46\.1%/.test(SIG.how) && /12\.4 萬/.test(SIG.how), SIG.how.slice(0, 120));
ok('㉜g 空頭趨勢的標的要標出來(bear=1 → 建議跳過)', /空頭趨勢/.test(SIG.picks));
ok('㉜h 不是靠價位觸發的招要標明(loose=1 → 盤中重算)', /盤中重新算/.test(SIG.picks));
ok('㉜i 清單過期(>3 天)要警告不能拿去掛單', /不能直接拿去掛單/.test(SIG.stale));
ok('㉜j ⛔ 檔案沒產出要說出來,不可靜默空白', /還沒產出/.test(SIG.missing), SIG.missing.slice(0, 80));
ok('㉜k ⚠️ 避雷只收「噴 ≥30% 且掛注意股」的(⛔ 只噴不掛注意的不可進來)',
   /1303/.test(SIG.avoid) && !/6949/.test(SIG.avoid), SIG.avoid.slice(0, 150));
// ㉜l V74.4.6 使用者明示要「建議掛單價格直接告訴我」→ ⛔ 舊的「不給任何買賣價位建議」作廢
//   (那句話本來就跟表格已經在顯示觸發價/停損自相矛盾)。改成釘**誠實揭露**:
//   價位是用昨天收盤算的估計值、盤中以散戶救星重算為準,而且要講清楚那是「站上才買」不是「跌到才撿」。
ok('㉜l 🚨 有給掛單價,就必須同時講「是估計值、盤中重算為準」',
   /昨天收盤算的估計值/.test(SIG.how) && /散戶救星/.test(SIG.how));
ok('㉜m 💰 建議掛單價要出現,而且⛔ 必須同時給昨收與要漲幾 %(否則看不出遠近)',
   /建議掛單價/.test(SIG.picks) && /昨收 100\.00/.test(SIG.picks) && /要漲 \+3\.0%/.test(SIG.picks),
   SIG.picks.replace(/\s+/g, ' ').slice(0, 200));
ok('㉜n ⛔ 沒有固定價位的招(loose)不可硬給一個掛單價',
   /這招沒有固定價位/.test(SIG.picks));
ok('㉜o 🚨 要講清楚是「站上才買」不是「等它跌回來撿」(⛔ 掛錯方向 = 買到走弱的那批)',
   /站上去才算數/.test(SIG.picks));
ok('㉜p 🏷️ 中文名在上、代號在下(使用者明示:認股票是認名字不是認號碼)',
   /class="signm">\$\{nm\(x\.s\) \|\| x\.s\}<\/span><br><span class="sigcode">/.test(src),
   '標的欄結構');
// ㉝ 🌅 盤前分數(V74.4.5,使用者:「這個分數我覺得還滿準」→ 實測支持)
ok('㉝ 分數算式跟探針 STRICT 一致(那指1+標普1+費半1.5+台積2+VIX0.5+日經1+韓股1+台幣0.5=8.5)',
   SIG.premktScore && Math.abs(SIG.premktScore.s - 8.5) < 1e-9 && SIG.premktScore.n === 8,
   JSON.stringify(SIG.premktScore && { s: SIG.premktScore.s, n: SIG.premktScore.n }));
ok('㉝b 高分要對照到「≥3 分」那格的歷史數字(84.7% 開高)', /84\.7%/.test(SIG.how));
ok('㉝c 🚨🚨 必須點出「開高有一大半是廢話」(同義反覆)+ 真正的預測力是開盤後那段',
   /有一大半是廢話/.test(SIG.how) && /0\.574/.test(SIG.how) && /開盤之後還會不會繼續漲/.test(SIG.how));
ok('㉝d 🚨 必須寫「⛔ 不是叫你買什麼」+「拿大盤方向篩個股反而少賺」',
   /不是叫你買什麼/.test(SIG.how) && /篩個股反而會少賺/.test(SIG.how));
ok('㉝e ⚠️ 要誠實說只算得到海外連動那一半', /海外連動那一半/.test(SIG.how));
ok('㉝f 🚧 成分不足 5 項 → ⛔ 不硬給分數', /不硬給分數/.test(SIG.premktThin), SIG.premktThin.slice(0, 80));
ok('㉝g ⛔ 資料沒到要說出來(不可靜默空白)', /盤前資料還沒到/.test(SIG.premktNone));

// ㉞ 🧮 回測計算機(V74.4.7 使用者:「新增回測計算機頁面…這樣我就不要請你一直回測」)
//   ⛔ 這頁最危險的兩件事,直接釘死:
//     ① 讓人以為是「現場算的」→ 必須寫明是預先真的跑過的情境庫
//     ② 讓人拿兩格數字相乘推估交叉 → 必須寫「沒列的交叉 = 沒測過」+ 混用 0/27 的實測
const CALC = await page.evaluate(async () => {
    const out = {};
    PRO.switchTab('calc');
    out.intro = document.getElementById('calcIntro').innerText;
    out.body0 = document.getElementById('calcBody').innerText;
    out.rows0 = document.querySelectorAll('#calcBody tbody tr').length;
    out.dims = document.querySelectorAll('#calcBar .labbtn').length;
    PRO.selCalc(5);                                   // 🏛️ 大盤狀態那組
    out.bodyMkt = document.getElementById('calcBody').innerText;
    out.rowsMkt = document.querySelectorAll('#calcBody tbody tr').length;
    out.inWrap = !!document.querySelector('.wrap #tabCalc');
    out.btn = (document.getElementById('tabBtnCalc') || {}).textContent || '';
    return out;
});
ok('㉞ 分頁註冊 + 在 .wrap 裡 + 按鈕文字', CALC.inWrap && CALC.btn === '回測計算機');
ok('㉞a 預設分組真的渲染出列(進場時機 5 列)', CALC.rows0 === 5, `rows=${CALC.rows0}`);
ok('㉞b 🚨 必須寫明是「真的跑過的回測」不是現場算的', /真的跑過的回測/.test(CALC.intro));
ok('㉞c 🚨🚨 必須寫「沒列的交叉 = 沒測過」(⛔ 不可讓人拿兩格數字相乘推估)',
   /沒列的交叉 = 沒測過/.test(CALC.intro));
ok('㉞c2 「交叉」分組要有「沒有一次贏過單獨用」的實測警告(27 次混用實測)',
   /沒有一次贏過單獨用/.test(src));
ok('㉞d 切分組真的會換內容(大盤狀態組要有三態拆解與嚴格空頭)',
   CALC.rowsMkt >= 4 && /嚴格空頭/.test(CALC.bodyMkt) && /−0\.29%|-0\.29%/.test(CALC.bodyMkt), CALC.bodyMkt.slice(0, 80));
ok('㉞e 🚨 沒過穩健性的格子要標出來(fragile 旗標真的會顯示)',
   /沒過穩健性檢定/.test(CALC.bodyMkt));
ok('㉞f 每一組都標窗口(⛔ 不標的話短窗口名次會被當永恆真理)',
   /📅 窗口:/.test(CALC.body0) && /📅 窗口:/.test(CALC.bodyMkt));
ok('㉞g ⭐ 窗口長度對照組要在(13/36/49 個月會翻轉結論)', /窗口長度/.test(CALC.intro + src) && /'win'/.test(src));

const L = await page.evaluate(async () => {
    PRO.switchTab('lab');
    await new Promise(r => setTimeout(r, 60));
    // 🚨 <details> 收合時 innerText **不含內文** → 不先展開的話,
    //    底下所有「內文必須寫什麼 / 不可寫什麼」的斷言都只掃到標題 = 假通過。
    const grab = () => {
        document.querySelectorAll('#labList .labitem').forEach(e => { e.open = true; });
        return {
            n: document.querySelectorAll('#labList .labitem').length,
            txt: document.getElementById('labList').innerText,
            intro: document.getElementById('labIntro').innerText,
        };
    };
    const out = { tabs: [...document.querySelectorAll('#labBar .labbtn')].map(e => e.textContent.trim()) };
    out.ok = grab();
    PRO.selLab('trap'); out.trap = grab();
    PRO.selLab('method'); out.method = grab();
    PRO.selLab('blocked'); out.blocked = grab();
    PRO.selLab('next'); out.next = grab();
    // ⚠️ 要掃**每一欄**(第一版只掃了「有用」那欄 → 把來源刪在別欄完全抓不到,注入驗證抓到的)
    out.srcMissing = 0;
    for (const k of Object.keys(PRO.LAB)) {
        PRO.selLab(k); grab();
        out.srcMissing += [...document.querySelectorAll('#labList .labitem')]
            .filter(e => !(e.querySelector('.lsrc') || {}).textContent.trim()).length;
    }
    let all = '';
    for (const k of Object.keys(PRO.LAB)) { PRO.selLab(k); all += grab().txt + '\n'; }
    out.all = all;
    out.counts = Object.fromEntries(Object.entries(PRO.LAB).map(([k, v]) => [k, v.length]));
    return out;
});
// ㉛ V74.4.4 使用者:「做一個排名,爾後加進來的自動去重新排名」——
//    ✅實測有用 依 r 遞減**渲染時排序**(新條目帶 r 就自動插進名次);⛔ 每條 ok 都要帶 r。
const RANK = await page.evaluate(() => {
  PRO.switchTab('lab'); PRO.selLab('ok');
  const items = [...document.querySelectorAll('#labList .labitem .lrank')].map(e => e.textContent.trim());
  const rs = PRO.LAB.ok.map(x => x.r);
  const sortedRs = PRO.LAB.ok.slice().sort((a, b) => (b.r ?? -1) - (a.r ?? -1)).map(x => x.r);
  const firstTitle = document.querySelector('#labList .labitem .lt')?.textContent || '';
  return { n: PRO.LAB.ok.length, badges: items.length, missR: rs.filter(r => r == null).length,
           mono: sortedRs.every((v, i) => i === 0 || v <= sortedRs[i - 1]), firstTitle,
           medal1: items[0] };
});
ok('㉛ 🏅 ok 欄要有排名徽章,且每一條都帶排序分 r(⛔ 忘了帶會排最後)',
   RANK.badges === RANK.n && RANK.missR === 0, `badges=${RANK.badges}/${RANK.n} missR=${RANK.missR}`);
ok('㉛b 🏅 第一名要是排序分最高的(🧬 高位階+高波動,r=100)+ 🥇 徽章',
   /🧬/.test(RANK.firstTitle) && RANK.medal1 === '🥇', `first=${RANK.firstTitle.slice(0, 20)} m=${RANK.medal1}`);
// ㉚ V74.4.3 使用者截圖:實測總表上方一大塊空白 —— #tabLab 被留在 .wrap 外面,
//    吃到 .wrap 的 80px+safe-area 底部 padding。⛔ 四個分頁容器都必須在 .wrap 裡。
const NEST = await page.evaluate(() =>
  ['tabVal', 'tabChain', 'tabRot', 'tabLab'].every(id => !!document.querySelector('.wrap #' + id)));
ok('㉚ 四個分頁容器都要在 .wrap 裡(⛔ 在外面會吃到 80px 底部 padding = 分頁頂端一大塊空白)', NEST);
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
ok('⑮b 🚧 樣本不足 10 檔 → ⛔ 不判定主戰場(門檻 5→10,實測後改的)', R.frontEmpty === null, R.frontEmpty);
ok('⑮c 表格有「階段位置」欄(主戰場/落後/太早)', /🎯 主戰場|⏳ 落後|🌱 太早/.test(R.chainTxt));
// ⚠️ V74.2.9 起「未實測」那句已經不成立(ailevel_probe 測過了)→ 改成必須寫出**實測結果**
ok('⑮d 🚨 文案必須寫「不是預測」+ 實測結果(⛔ 不可再寫「沒有實測過」)',
   /不是 AI 進度預測/.test(R.chainTxt) && /實測沒有預測力/.test(R.chainTxt)
   && !/沒有實測過預測力/.test(R.chainTxt), R.chainTxt.slice(0, 400));
ok('⑮d2 🚨 實測數字要寫在卡上(12 格全滅 + 幅度)',
   /12 格全部沒過關/.test(R.chainTxt) && /\+0\.72pp/.test(R.chainTxt), R.chainTxt.slice(0, 500));
ok('⑮d3 ⚠️ 小樣本假象要點名(成員最少的層靠雜訊佔住最強)',
   /42~47% 的時間/.test(R.chainTxt) && /10 檔/.test(R.chainTxt), R.chainTxt.slice(0, 600));
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
// ㉑ 點五級卡 → 跳戰情表 + 表格不回彈(使用者明示)
ok('㉑ 點 L2 之後畫面真的往下捲到戰情表', J.after > J.before + 100, J);
ok('㉑b 🚧 空過守門:捲完戰情表要接近畫面頂端(⛔ 不是隨便捲一點)', Math.abs(J.panelTop) < 220, J.panelTop);
ok('㉑c 只捲過去不夠 —— 篩選也要生效(L2 成員 < 全部)', J.rows > 0 && J.rows < J.allRows, [J.rows, J.allRows]);
ok('㉑d 篩選中要有「⬆️ 回五級」的路(⛔ 手機上沒有就只能自己滑很久)', J.backBtn);
ok('㉑e 回五級要取消篩選 + 捲回去', J.backRows === J.allRows && J.backScroll < J.after, [J.backRows, J.allRows, J.backScroll, J.after]);
ok('㉑f ⛔ 表格不可有橡皮筋回彈(overscroll-behavior:none)', S.overscroll === 'none', S.overscroll);
// ㉒ 💧 板塊輪動:四象限泡泡
ok('㉒ 泡泡有畫出來,⛔ 全空的產業不佔一顆', T.nBub === 4 && !T.hasEmpty, T.nBub);
ok('㉒b 預設停在最新那天', T.lastDay === '2026-08-29', T.lastDay);
ok('㉒c 最新那天 航運(+8)在右、半導體(−9)在左', T.p15 && T.p24 && T.p15.x > T.p24.x, [T.p15, T.p24]);
ok('㉒d 🚧 動畫是真的:拉回第 0 天左右要對調(半導體 +8 變最右)', T.p24_day0.x > T.p15_day0.x, [T.p24_day0, T.p15_day0, T.day0]);
ok('㉒d2 🚨🚨 版面穩定:拉時間軸時結論條高度與圖的位置**不可以變**(使用者回報「上上下下」)',
   Math.abs(T.vH - T.vH0) < 1 && Math.abs(T.svgTop - T.svgTop0) < 1, [T.vH, T.vH0, T.svgTop, T.svgTop0]);
// 🚧 兩件事:① 有沒有釘 ② 釘得夠不夠高。
//    ② 是注入驗證逼出來的 —— 加了新的一行卻沒調 min-height 時,
//    「資料還沒填進來(0 高)→ 填進來」那一刻仍然會跳一次,而 ㉒d2 抓不到
//    (它比的是拉時間軸前後,那時內容行數本來就一樣)。
ok('㉒d2b 🚧 而且要靠 CSS **釘死** min-height、並且**釘得夠高**撐住實際內容',
   parseFloat(T.vMinH) >= 40 && parseFloat(T.vMinH) >= T.vH - 4, [T.vMinH, T.vH]);
ok('㉒d3 🚧 尺標要用**全期**最大值:泡泡⛔ 不可飛出畫布(每天各自縮放就會)', T.outside === 0, T.outside);
ok('㉒e 結論要點名最強 / 最弱(🎯⛔ 圖示,⛔ 不靠顏色)',
   /🎯/.test(T.verdict) && /⛔/.test(T.verdict) && /航運/.test(T.verdict) && /半導體/.test(T.verdict), T.verdict.slice(0, 120));
ok('㉒e2 圖下方的名次條要一次列完所有產業(⛔ 不用捲)',
   /航運/.test(T.chips) && /半導體/.test(T.chips) && (T.chips.match(/[+-]\d/g) || []).length >= 4, T.chips.slice(0, 120));
ok('㉒f 🚨「幾天才有價值」必須寫出實測數字,⛔ 不可只說「20 日」',
   /1 日窗口/.test(T.note) && /60 日窗口/.test(T.note) && /\+1\.44pp/.test(T.note), T.note.slice(0, 200));
ok('㉒f2 🚨 必須寫「X 軸過關、Y 軸沒過關」——⛔ 不可讓人以為兩個軸一樣有份量',
   /份量完全不同/.test(T.note) && /X 軸.{0,20}實測唯一過關/.test(T.note)
   && /Y 軸.{0,12}實測沒過關/.test(T.note) && /只是描述/.test(T.note), T.note.slice(0, 400));
ok('㉒g 🚨 必須寫「刻意沒把加速/放緩做成一個軸」+ 實測數字',
   /刻意沒有把「加速\/放緩」做成一個軸/.test(T.note) && /-0\.88/.test(T.note.replace(/−/g, '-')), T.note.slice(0, 600));
ok('㉒h ⭐「避開最弱比追最強更有價值」要寫出來',
   /避開最弱/.test(T.note) && /-0\.8pp/.test(T.note.replace(/−/g, '-')), T.note.slice(0, 900));
// 🚨 ㉒h2:那句是整張圖最有實戰價值的一句 —— 只寫在 <details>(預設收起)裡等於使用者看不到。
//    ⛔ 這條刻意驗 **verdict**(第一眼常顯區)而不是 note,兩條缺一不可。
ok('㉒h2 🚨 而且要出現在**第一眼**,⛔ 不可只藏在收起來的說明區(功能有 ≠ 找得到)',
   /避開最弱/.test(T.verdict) && /追最強/.test(T.verdict)
   && /-0\.8pp/.test(T.verdict.replace(/−/g, '-')), T.verdict);
ok('㉒i 誰在買:預設勾選那幾條加總排序 → 半導體第一', T.fiFirst === '半導體', T.fiFirst);
ok('㉒j 🚨 外資「買最多卻最弱」的現成例子要主動點出來', /今天正好有現成的例子/.test(T.fiNote) && /半導體/.test(T.fiNote), T.fiNote.slice(0, 200));
ok('㉒k ⛔ 那張表要明說只做描述、不排名不下多空', /只做描述/.test(T.fiNote) && /不排名/.test(T.fiNote), T.fiNote.slice(-260));
// ㉓ 👥 三大 + 散戶疊加
ok('㉓ 四個打勾:外資 / 投信 / 自營 / 融資(散戶代理)',
   T.flowChks.length === 4 && /外資/.test(T.flowChks[0]) && /投信/.test(T.flowChks[1])
   && /自營/.test(T.flowChks[2]) && /融資/.test(T.flowChks[3]), T.flowChks);
ok('㉓b 表頭跟著勾選變(預設 3 條)', T.flowOnN === 3 && /外資/.test(T.headTxt) && /投信/.test(T.headTxt), [T.flowOnN, T.headTxt]);
ok('㉓b2 ⭐ 打勾要讓**泡泡的 Y** 跟著動(Y 軸 = 勾起來那幾條合計,這就是「誰在買」跟動畫合體)',
   Math.abs(T.y24_noF - T.y24_withF) > 5, [T.y24_withF, T.y24_noF]);
ok('㉓c 取消外資 → 表頭不再有外資、排序改用剩下的(半導體投信 −77 → 不再第一)',
   !/外資/.test(T.headNoF) && T.firstNoF !== '半導體', [T.headNoF, T.firstNoF]);
ok('㉓d ⛔ 不可全部取消(最後一個要擋住,否則變空表)', T.lastOnN >= 1, T.lastOnN);
ok('㉓e 🚨🚨 必須明寫「散戶不能用總量減三大」+ 為什麼(恆等式、完美鏡像、零資訊)',
   /不能.{0,4}用.{0,10}三大法人/.test(T.noteTxt) && /鏡像/.test(T.noteTxt) && /沒有官方的「散戶買賣超」/.test(T.noteTxt),
   T.noteTxt.slice(0, 300));
ok('㉓f 🚨「誰在追誰買」要誠實說沒有誰固定跟誰,⛔ 不可宣稱外資領先',
   /沒有誰固定跟誰/.test(T.noteTxt) && /量不出來/.test(T.noteTxt), T.noteTxt.slice(0, 600));
ok('㉓g ⭐ 跟單數字必須配「自己續買」的對照(⛔ 沒對照就是假結論)',
   /自己連買/.test(T.noteTxt) && /自己續買/.test(T.noteTxt) && /\+2\.05pp/.test(T.noteTxt), T.noteTxt.slice(-700));
ok('㉓h ⭐ 要點出「外資買了之後別人跟」幾乎沒有加成(⛔ 不可只講對自己結論有利的那半)',
   /加成只有.{0,12}沒有/.test(T.noteTxt.replace(/\s/g, '')) || /\+0\.08pp/.test(T.noteTxt), T.noteTxt.slice(-600));
// ㉕ 📱 長版 + ⏩ 速度 + 🔎 板塊明細(使用者第三輪回饋)
ok('㉕ 📱 手機長版:畫布要比寬還高(直式)', T.aspect > 1.2, T.aspect);
ok('㉕b ⏩ 播放速度可調(1x → 2x)', T.spd0 === '1x' && T.spd1 === '2x' && T.spdVal === 2, [T.spd0, T.spd1, T.spdVal]);
ok('㉕c 🔎 點板塊要攤開裡面的個股', T.detRows >= 2 && /廣達/.test(T.detTxt), [T.detRows, T.detTxt.slice(0, 80)]);
ok('㉕d 🔎 明細要有板塊自己的資金流(當日/近5日/近20日/資金停留)',
   /當日外資/.test(T.detTxt) && /近 5 日/.test(T.detTxt) && /近 20 日累計/.test(T.detTxt) && /資金停留/.test(T.detTxt),
   T.detTxt.slice(0, 200));
ok('㉕e 個股要能點去散戶救星', T.detHasGoto);
ok('㉕f 🚨 必須誠實說「個股表只有最新一天」(⛔ 不可假裝拉回過去看得到)',
   // ⚠️ V74.4.2 起走向欄**有**每檔近 20 日歷史(使用者叫回來的)→ 舊句「沒有存歷史」已不成立,
   //    改釘「表格是最新快照 + 走向欄要宣告自己的窗口(近 20 個交易日)」
   /只有「最新一天」的快照/.test(T.detTxt) && /近 20 個交易日/.test(T.detTxt), T.detTxt.slice(-300));
ok('㉕g 🚨 停在過去那天時要主動提醒「你現在停在 X,個股表仍是最新交易日」',
   /你現在停在/.test(T.detTxtPast), T.detTxtPast.slice(-260));
ok('㉕h ⛔ 明細也不可下多空/給價位', /只做描述/.test(T.detTxt) && /不給買賣價位/.test(T.detTxt), T.detTxt.slice(-200));
ok('㉕i 再點一次要收起', T.detClosed);
// 🚨 ㉕j/㉕k 是「測資格式跟真實資料不同 = 測試等於沒驗」抓出來的:
//    sector_rot 存產業**代碼**、screener 存**中文名** → 直接比代碼永遠是空表。
ok('㉕j 🚨 產業對照要用**中文名**(真實 screener 格式),而且別名(金融↔金融保險)要對得上',
   T.aliasRows >= 1 && /彰銀/.test(T.aliasTxt), [T.aliasRows, T.aliasTxt.slice(0, 120)]);
ok('㉕k ⛔ 真的對不上時要**說出來**,不可靜默空白(陷阱 #22)',
   /對不上/.test(T.missTxt) && /上面那幾個數字仍然是對的/.test(T.missTxt), T.missTxt.slice(-200));
// ㉖ 🎯 題材板塊(V74.3.5,使用者:「官方 33 產業沒什麼用,要矽光子/散熱/記憶體」)
ok('㉖ 切到題材模式:泡泡數 = 題材數、鈕文字跟著變',
   T.thBubs === 3 && /題材/.test(T.thBtn), [T.thBubs, T.thBtn]);
ok('㉖b 名次條顯示**題材名**(⛔ 不可顯示 key)',
   /記憶體/.test(T.thChips) && /散熱\/液冷/.test(T.thChips) && !/\bmem\b/.test(T.thChips), T.thChips.slice(0, 150));
ok('㉖c 題材明細:成分股直接讀 THEMES 名單(南亞科/群聯要在)+ 買超寬度',
   T.thDetRows >= 2 && /南亞科/.test(T.thDetTxt) && /群聯/.test(T.thDetTxt) && /買超寬度/.test(T.thDetTxt),
   [T.thDetRows, T.thDetTxt.slice(0, 200)]);
ok('㉖d 🚨 題材模式的結論第三行**必須換句** —— ⛔ 不可拿官方 33 產業的實測數字(+0.63/−0.8pp)背書題材版',
   /人工挑的/.test(T.thVerd) && /只驗過官方 33 產業/.test(T.thVerd)
   && !/-0\.8pp/.test(T.thVerd.replace(/−/g, '-')), T.thVerd);
ok('㉖e ⛔ themes 還沒產出時要說出來(⛔ 不可靜默退回官方版)',
   /題材板塊的資料還沒產出/.test(T.thMissing) && /不是壞掉/.test(T.thMissing), T.thMissing.slice(0, 160));
ok('㉖f 🚨 題材說明要含三條誠實限制:後見之明 / 實測不可套用 / 金額會重複計',
   /後見之明/.test(T.thNote) && /不可套用到題材版/.test(T.thNote) && /重複計/.test(T.thNote), T.thNote.slice(0, 300));
// ㉘ 🧬 個股泡泡圖(使用者:「題材細到個股,用一樣的邏輯,還有它的股價高低」)
ok('㉘ 題材明細要有個股泡泡圖,泡泡數 = 有資料的成分股數',
   T.sbN === 2 && T.sbGoto, [T.sbN, T.sbGoto]);
ok('㉘b 🧬 命中(位階≥75 且 振幅≥P60)要標出來,而且數字跟描邊數一致',
   T.sbGene === '1/2' && T.sbAmber === 1, [T.sbGene, T.sbAmber]);
ok('㉘c 🚨🚨 兩個軸必須是**位階 × 振幅**(個股層級實測有效的),⛔ 不可照抄板塊版的「誰在買」',
   /pos252/.test(src.slice(src.indexOf('_stockBubHtml'), src.indexOf('_stockBubHtml') + 2600))
   && /amp20/.test(src.slice(src.indexOf('_stockBubHtml'), src.indexOf('_stockBubHtml') + 2600))
   && !/C\.f5|C\.t5|C\.f10/.test(src.slice(src.indexOf('_stockBubHtml'), src.indexOf('_stockBubHtml') + 2600)));
ok('㉘d 🚨 必須寫出「個股層級的法人買超實測 0.64x」——⛔ 否則下一個人會把 Y 軸改回資金流',
   /0\.64x/.test(T.sbTxt) && /比隨便挑一天還低/.test(T.sbTxt), T.sbTxt.slice(0, 300));
ok('㉘e 🚨 必須寫「選股條件不是買進訊號」+ 回測還配了哪些條件(⛔ 不可讓人以為命中就會漲)',
   /不是買進訊號/.test(T.sbTxt) && /尾盤進場/.test(T.sbTxt) && /一天只做 2 檔/.test(T.sbTxt), T.sbTxt.slice(0, 400));
ok('㉘f ⚠️ 要誠實說波動是用「20 日振幅」代理、門檻是全市場 P60(⛔ 不可假裝跟回測用同一個量)',
   /振幅.{0,8}代理|代理.{0,20}振幅/.test(T.sbTxt) && /P60/.test(T.sbTxt), T.sbTxt.slice(-260));
// ㉙ ②③④ 板塊輪動三修(V74.4.2,使用者:「不知道個股有誰 / 資金走向叫回來 / 按下去沒差異」)
ok('㉙ ② 成員名單總覽:預設打開 + 至少一列 + 點個股可跳散戶救星',
   /id="rotMemWrap" open/.test(src) && T.memRows >= 1 && T.memGoto, `rows=${T.memRows} goto=${T.memGoto}`);
ok('㉙b ② 成員 chip 要有股名(⛔ 不可只有代號)', /2408 南亞科/.test(T.memTxt), T.memTxt.slice(0, 80));
ok('㉙c ③ 資金走向欄:明細表每檔一格 sparkline + 累計「張」',
   T.flowCells >= 2 && T.flowSpark > 5 && T.flowCum, `cells=${T.flowCells} rects=${T.flowSpark} cum=${T.flowCum}`);
ok('㉙d ③ 沒有外資資料的股票要誠實顯「—」(⛔ 不可畫一張空圖)', T.flowNone);
ok('㉙e ③ 🚨 走向欄必須帶 0.64x 免責 +「不是跟單訊號」(⛔ 少了它等於鼓勵跟單)',
   /0\.64x/.test(T.flowNote) && /不是跟單訊號/.test(T.flowNote));
ok('㉙f ④ 選中樣式:實心青底(⛔ 半透明底看不出按了誰)+ 成員總覽/名次條選中各恰一處',
   /\.rotchip\.on\{background:var\(--cyan\)/.test(src) && T.memSelOn === 1 && T.chipOnCls === 1,
   `memSel=${T.memSelOn} chip=${T.chipOnCls}`);
ok('㉙g 🚨 成員判定全 App 只有一份 _grpMembers(⛔ 明細與總覽各寫一份遲早只改到一邊 —— 陷阱 #37)',
   (src.match(/this\._grpMembers\(/g) || []).length >= 2 &&
   (src.match(/Object\.keys\(scr\.ind\)\.filter/g) || []).length === 1,
   `calls=${(src.match(/this\._grpMembers\(/g) || []).length}`);
ok('㉖g 切回官方模式要完整復原(泡泡 = 產業數)',
   T.backBubs === 4 && /官方產業/.test(T.backBtn), [T.backBubs, T.backBtn]);
// ㉗ 📐 版面(使用者截圖:泡泡全部擠成一團 —— 實測舊版 97% 黏在中線)
ok('㉗ 🚨 Y 軸必須是**對數**:資金流中位 10 億 vs 最大 2801 億,線性下一半的泡泡會黏在中線',
   T.sy10 > 0.15 && T.sy1000 > T.sy10 * 1.4 && T.sy1000 <= 1,
   [T.sy10, T.sy1000]);
ok('㉗b 🚨 Y 軸(對數)要讓泡泡散得開 —— ⛔ 舊版線性只用到 7.6% 的高度',
   T.spreadY >= 30, T.spreadY?.toFixed(1));
ok('㉗b2 🚨 X 尺標用 P95 必須比用「全期最大值」散得開(⭐ 對照組測法,不受測資規模影響)',
   T.spreadP95px >= T.spreadMaxPx * 1.05,
   [T.spreadP95px?.toFixed(0), T.spreadMaxPx?.toFixed(0)]);
ok('㉗c 🚨 黏在中線的泡泡要少(⛔ 舊版 97%)', T.nearMidPct <= 55, T.nearMidPct?.toFixed(0));
ok('㉗d 📏 要有軸刻度標籤(⛔ 只有兩條軸線的話泡泡位置不可解讀)', T.nTicks >= 6, T.nTicks);
ok('㉗e 四象限計數:四格加起來 = 泡泡數,而且**不可**用「漲潮/輪動/觀望/退潮」那套加速度分類',
   T.quadSum === T.nBubs && !/漲潮|退潮|輪動|觀望/.test(T.quadTxt), [T.quadSum, T.nBubs, T.quadTxt]);
ok('㉒l ⛔ 切走分頁要停掉動畫(不可留背景 timer)', T.playing && T.stoppedOnLeave, [T.playing, T.stoppedOnLeave]);
// ㉔ 🔬 實測總表
ok('㉔ 五個頁籤:有用 / 沒用 / 回測的坑 / 還測不了 / 推薦下一步',
   L.tabs.length === 5 && /實測有用/.test(L.tabs[0]) && /實測沒用/.test(L.tabs[1])
   && /回測自己的坑/.test(L.tabs[2]) && /還測不了/.test(L.tabs[3]) && /推薦下一步/.test(L.tabs[4]), L.tabs);
ok('㉔a2 🚧 空過守門:展開後內文真的抓得到(⛔ <details> 收合時 innerText 不含內文 = 假通過)',
   L.all.length > 6000 && /六道關卡|來回成本/.test(L.all), L.all.length);
ok('㉔b 每一欄都有內容,切換真的換掉列表',
   // ⚠️ next 欄的門檻刻意最低(≥1)—— 「驗證完當場歸類」的鐵則(V74.4.3)會把它越清越短,
   //    清到快空**是好事**,⛔ 別把門檻調回去逼人塞條目
   L.ok.n > 5 && L.trap.n > 5 && L.method.n > 5 && L.blocked.n > 3 && L.next.n >= 1
   && L.ok.txt !== L.trap.txt && L.trap.txt !== L.method.txt,
   [L.ok.n, L.trap.n, L.method.n, L.blocked.n, L.next.n]);
ok('㉔c 頁籤數字要跟實際筆數一致(⛔ 不可寫死)',
   L.tabs.every((t, i) => t.includes('(' + L.counts[['ok', 'trap', 'method', 'blocked', 'next'][i]] + ')')), L.tabs);
ok('㉔d 🚨 **每一欄**每一條都要附實測來源(⛔ 沒有數字的意見不准進來)', L.srcMissing === 0, L.srcMissing);
ok('㉔e 🚨「有用」那欄必須引用得出實測數字', /\+1\.44pp/.test(L.ok.txt) && /\+289\.6 萬|289\.6/.test(L.ok.txt), L.ok.txt.slice(0, 200));
ok('㉔f 🚨「沒用」那欄要留著方向相反的那幾條(⛔ 刪了下一個人會再做一次)',
   // ⚠️ V74.4.5 白話化:「Jaccard」已翻成「名單重疊率」→ 斷言跟著改(⛔ 兩種寫法都收,
   //    免得日後再翻一次又假失敗)
   /方向剛好相反|方向相反/.test(L.trap.txt) && /(名單重疊率|Jaccard) 0%/.test(L.trap.txt), L.trap.txt.slice(0, 200));
ok('㉔g ⭐「回測自己的坑」要含四條核心:對照組 / 兩端同號 / 同期相關 / 前視偏誤',
   /對照組/.test(L.method.txt) && /兩端同號/.test(L.method.txt)
   && /同期還是隔期/.test(L.method.txt) && /前視偏誤/.test(L.method.txt), L.method.txt.slice(0, 300));
ok('㉔h ⏳「還測不了」要說出「現在不存以後永遠沒有」那一類',
   /現在不開始存|現在不存/.test(L.blocked.txt), L.blocked.txt.slice(0, 300));
ok('㉔i 🔬「推薦」第一條要是補深歷史(它一次解鎖十幾支探針)',
   /補深到 2021|2022 空頭/.test(L.next.txt), L.next.txt.slice(0, 200));
ok('㉔j ⛔ 整頁不可下買賣指令、不可給買賣價位(這是研究紀錄不是訊號頁)',
   !/(建議買進|可以買進|買在|掛單價|停損價[:：]|目標價[:：]\s*\d)/.test(L.all), (L.all.match(/建議買進|可以買進|掛單價/) || [])[0]);
ok('⑩ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PROHTML_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
