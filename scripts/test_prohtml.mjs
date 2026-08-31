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
            '10': { n: 31, r20: [2, 2, 2, 2, -4], flow: { f: [2, 2, 2, 2, 2], t: [0, 0, 0, 0, 0], dl: [0, 0, 0, 0, 0], mg: [0, 0, 0, 0, 0] } },
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
    PRO.rotOpen('mem');
    await new Promise(r => setTimeout(r, 80));
    out.thDetTxt = document.getElementById('rotDetail').innerText;
    out.thDetRows = document.querySelectorAll('#rotDetail tbody tr').length;
    document.querySelectorAll('#tabRot details').forEach(d => d.open = true);
    out.thNote = document.getElementById('rotNote').innerText;
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
    PRO.rotSeek(4);
    PRO.rotPlay(); out.playing = !!PRO._rotTimer;
    PRO.switchTab('val');
    out.stoppedOnLeave = !PRO._rotTimer;
    return out;
});
// ㉔ 🔬 實測總表
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
    out.kpi = document.getElementById('labKpis').innerText;
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
   /只有「最新一天」的快照/.test(T.detTxt) && /沒有存歷史/.test(T.detTxt), T.detTxt.slice(-300));
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
ok('㉖g 切回官方模式要完整復原(泡泡 = 產業數)',
   T.backBubs === 4 && /官方產業/.test(T.backBtn), [T.backBubs, T.backBtn]);
ok('㉒l ⛔ 切走分頁要停掉動畫(不可留背景 timer)', T.playing && T.stoppedOnLeave, [T.playing, T.stoppedOnLeave]);
// ㉔ 🔬 實測總表
ok('㉔ 五個頁籤:有用 / 沒用 / 回測的坑 / 還測不了 / 推薦下一步',
   L.tabs.length === 5 && /實測有用/.test(L.tabs[0]) && /實測沒用/.test(L.tabs[1])
   && /回測自己的坑/.test(L.tabs[2]) && /還測不了/.test(L.tabs[3]) && /推薦下一步/.test(L.tabs[4]), L.tabs);
ok('㉔a2 🚧 空過守門:展開後內文真的抓得到(⛔ <details> 收合時 innerText 不含內文 = 假通過)',
   L.all.length > 6000 && /六道關卡|來回成本/.test(L.all), L.all.length);
ok('㉔b 每一欄都有內容,切換真的換掉列表',
   L.ok.n > 5 && L.trap.n > 5 && L.method.n > 5 && L.blocked.n > 3 && L.next.n > 3
   && L.ok.txt !== L.trap.txt && L.trap.txt !== L.method.txt,
   [L.ok.n, L.trap.n, L.method.n, L.blocked.n, L.next.n]);
ok('㉔c 頁籤數字要跟實際筆數一致(⛔ 不可寫死)',
   L.tabs.every((t, i) => t.includes('(' + L.counts[['ok', 'trap', 'method', 'blocked', 'next'][i]] + ')')), L.tabs);
ok('㉔d 🚨 **每一欄**每一條都要附實測來源(⛔ 沒有數字的意見不准進來)', L.srcMissing === 0, L.srcMissing);
ok('㉔e 🚨「有用」那欄必須引用得出實測數字', /\+1\.44pp/.test(L.ok.txt) && /\+289\.6 萬|289\.6/.test(L.ok.txt), L.ok.txt.slice(0, 200));
ok('㉔f 🚨「沒用」那欄要留著方向相反的那幾條(⛔ 刪了下一個人會再做一次)',
   /方向剛好相反|方向相反/.test(L.trap.txt) && /Jaccard 0%/.test(L.trap.txt), L.trap.txt.slice(0, 200));
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
