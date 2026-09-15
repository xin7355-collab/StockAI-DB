#!/usr/bin/env node
/**
 * 🔎🧭📈 V77.0.9 使用者三點 —— 測試
 *   1. 搜尋個股那裡有個奇怪符號        → ⓐ 空的裝飾圓圈不可再出現
 *   2. 大盤右側有個 ! 符號沒有對齊       → ⓑ 徽章欄一律「置中的 flex 格」(⛔ 不靠 glyph 自己對齊)
 *   3. 要到 117.3 才轉強,加到報告裡面   → ⓒⓓ §21 要有那兩個價位,而且**讀 _keyLevels**、件數不可寫死
 *      另外「老是觀望」正不正常          → ⓔⓕ 那句話的數字必須**讀採礦產物**,⛔ 不可寫死
 *
 * ⛔ 每一條先想「注入什麼它會叫」:
 *   ⓐ 把圓圈加回去 ・ⓑ 退回 text-align:center ・ⓒ 自己用 ma20 算一份而不是讀 _keyLevels
 *   ⓓ 標題寫死「5 件事」・ⓔ 把數字寫死成 2,326/200 ・ⓕ 產物沒載入時謊報數字
 *
 * 測資:本機 data/1815 2330(沒有就誠實 exit 1,⛔ 不跑假測試)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// ⚠️ 原始碼斷言一律**先剝掉註解**再比 —— 本 repo 已經被「自己寫的註解救活斷言」騙過 6 次
const strip = x => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };
for (const s of ['1815', '2330']) if (!fs.existsSync(path.join(ROOT, 'data', `${s}.json`))) { console.log(`❌ 沒有 data/${s}.json(跑 bash scripts/fetch_testdata.sh)`); process.exit(1); }
for (const f of ['playbook_edge.json', 'today_signals.json']) if (!fs.existsSync(path.join(ROOT, 'data', f))) { console.log(`❌ 沒有 data/${f} —— ⛔ 不跑假測試`); process.exit(1); }

// ── ⓐ 靜態:搜尋列不可再有「什麼都沒裝的裝飾圓圈」 ──
{
    const fn = strip(SRC.slice(SRC.indexOf('    _renderRecentSearches() {'), SRC.indexOf('    // ◀▶ V45.4')));
    // ⛔ 釘「用意」:一個沒有任何內容的 span 當裝飾(無框判準:框講不出它在說什麼就不要框)
    const bad = (fn.match(/<span class="[^"]*rounded-full[^"]*border[^"]*"><\/span>/g) || []);
    ok('ⓐ 搜尋列(最近/聯想)⛔ 不可有空的裝飾圓圈', bad.length === 0, bad.join(' | '));
}
// ── ⓑⓒⓓⓔ 靜態 ──
{
    const g = strip(SRC.slice(SRC.indexOf('    _gaugeRow(label, pct, o = {}) {'), SRC.indexOf('    _rpValRuler(C) {')));
    ok('ⓑs 徽章欄用「置中的 flex 格」,⛔ 不可退回 text-align:center 靠 glyph 自己對齊',
       /BADGECELL/.test(g) && /display:flex;align-items:center;justify-content:center;line-height:1/.test(g)
       && !/width:18px;text-align:center/.test(g), '');
    const ev = strip(SRC.slice(SRC.indexOf('    _rpEventsHtml(C) {'), SRC.indexOf('    _copyText(t) {')));
    ok('ⓒs §21 的兩個價位一律讀 _keyLevels,⛔ 不可自己用均線/前高再算一份',
       /_keyLevels/.test(ev) && /\.buyPx/.test(ev) && /\.addPx/.test(ev)
       && !/_rpMaLevels\(\)[\s\S]{0,200}buyPx/.test(ev) && !/Math\.max\(\.\.\.(highs|hi)/.test(ev), '');
    ok('ⓒs2 §21 上行價位要先過 _bearGate(空頭時不可寫成買點)', /_bearGate\(sym\)/.test(ev), '');
    ok('ⓓs §21 標題的件數⛔ 不可寫死', /§21 接下來 30~90 天要看的 \$\{watch\.length\} 件事/.test(ev)
       && !/§21 接下來 30~90 天要看的 \d+ 件事/.test(ev), '');
    const r = strip(SRC.slice(SRC.indexOf('    _ovRarityNote() {'), SRC.indexOf('    _ovDecide(data, sym) {')));
    ok('ⓔs 「為什麼老是觀望」那句的數字一律讀產物,⛔ 不可寫死',
       /_pbEdge/.test(r) && /_todaySig/.test(r) && !/2,326|約 200|\b200 檔/.test(r), '');
    const ov = strip(SRC.slice(SRC.indexOf('    _ovDecide(data, sym) {'), SRC.indexOf('    _ovDecide(data, sym) {') + 20000));
    ok('ⓔs2 _ovDecide 裡⛔ 不可再出現寫死的全市場檔數', !/2,326|約 200 檔/.test(ov), '');
}

// ── 實跑 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported/.test(m)) errs.push(m.slice(0, 160)); });
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(2500);

// ⓐ2 實際渲染出來的搜尋列
{
    const r = await page.evaluate(() => {
        if (!app.allStockList || !app.allStockList.length) app.allStockList = [{ stock_id: '1815', stock_name: '富喬' }];
        app.openGlobalSearchModal();
        const inp = document.getElementById('globalSearchInput');
        inp.value = '18'; app._handleGlobalSearchInput({ target: inp });
        const li = document.querySelector('#globalSearchSuggest li');
        const out = { n: 0, empty: 0 };
        if (li) [...li.querySelectorAll('span')].forEach(e => { out.n++; if (!(e.textContent || '').trim()) out.empty++; });
        app.closeGlobalSearchModal();
        return out;
    });
    ok('ⓐ2 實際渲染的搜尋列:每一個 span 都有內容(空過守門:至少要掃到 2 個)', r.n >= 2 && r.empty === 0, JSON.stringify(r));
}

const load = async (sym) => { await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, sym); await page.waitForTimeout(10000); };
await load('1815');

// ⓑ2 五格徽章的幾何
// 🗑️ V77.1.5 **總覽那條儀表列已下架**(使用者:「與報告頁面重複了」)→ 改成把 `_gaugeStripHtml()`
//   的產物渲染到離屏容器再量。⭐ 釘的是**那支函式的徽章格規格**(置中的 flex + 幾何一致),
//   ⛔ 不是「它有沒有出現在總覽」—— 後者由 `test_dupnum ⓗ` 反過來釘「⛔ 不可再出現」。
{
    await page.evaluate(() => {
        const d = document.createElement('div'); d.id = '__gstrip';
        d.innerHTML = app._gaugeStripHtml(app.currentSymbolId) || '';
        document.body.appendChild(d);
    });
    const g = await page.evaluate(() => [...document.querySelectorAll('#__gstrip [data-badge]')].map(e => {
        const c = getComputedStyle(e), r = e.getBoundingClientRect();
        return { k: e.dataset.badge, t: (e.innerText || '').trim(), w: +r.width.toFixed(1), l: +r.left.toFixed(1), d: c.display, jc: c.justifyContent, ai: c.alignItems };
    }));
    ok('ⓑ2 空過守門:五個面向的徽章要真的掃得到(≥3 格)', g.length >= 3, JSON.stringify(g).slice(0, 200));
    ok('ⓑ2b 每一格都是置中的 flex(⛔ 不依賴 glyph 度量)', g.length >= 3 && g.every(x => x.d === 'flex' && x.jc === 'center' && x.ai === 'center'), JSON.stringify(g).slice(0, 300));
    ok('ⓑ2c 五格的左緣與寬度完全一致(⛔ 差一格就會看起來歪掉)',
       g.length >= 3 && new Set(g.map(x => x.w)).size === 1 && new Set(g.map(x => x.l)).size === 1, JSON.stringify(g.map(x => [x.k, x.l, x.w])));
    // ⚠️ 這裡刻意**不**斷言 glyph 自己的寬度 —— 沙箱沒有彩色 emoji 字型,所有 emoji 量到同一個值 = 零鑑別力(陷阱 #40)
}

// ⓒ2 §21 的兩個價位必須等於 _keyLevels(⛔ 不是自己算的)
{
    const r = await page.evaluate(() => new Promise(res => {
        app.switchSubTab && app.switchSubTab('report');
        setTimeout(() => {
            const box = document.querySelector('[data-rpwatch]');
            const K = app._keyLevels;
            res({ n: box ? +box.dataset.rpwatch : 0, txt: box ? box.innerText.replace(/\s+/g, ' ') : '',
                  head: (document.getElementById('subContentReport')?.innerText || '').match(/§21 接下來 30~90 天要看的 (\d+) 件事/)?.[1] || null,
                  buy: K ? K.buyPx : null, add: K ? K.addPx : null });
        }, 1800);
    }));
    const num = s => { const m = r.txt.match(new RegExp(s + ' ([\\d,]+\\.\\d\\d) 元')); return m ? +m[1].replace(/,/g, '') : null; };
    const b = num('站上這裡才算轉強'), a = num('帶量過這裡才算追買');
    ok('ⓒ2 §21 有「站上…才算轉強」而且價位 = _keyLevels.buyPx', b != null && r.buy > 0 && Math.abs(b - +(+r.buy).toFixed(2)) < 0.011, `畫面 ${b} vs K ${r.buy}`);
    ok('ⓒ2b §21 有「帶量過…才算追買」而且價位 = _keyLevels.addPx', a != null && r.add > 0 && Math.abs(a - +(+r.add).toFixed(2)) < 0.011, `畫面 ${a} vs K ${r.add}`);
    ok('ⓒ2c 追買那句要講清楚「這是前高、⛔ 不是可以直接掛的買價」', /前高/.test(r.txt) && /不是你可以直接掛的買價/.test(r.txt), r.txt.slice(0, 160));
    ok('ⓓ2 標題件數 = 實際列數(⛔ 不可寫死)', r.head != null && +r.head === r.n && r.n >= 6, `head=${r.head} rows=${r.n}`);

    // ⓒ2d 🚨 決定性對照組 —— 上面那兩條會被「剛好相等」救活(buyPx 常常**就是**月線 → 自己算一份也對得上,
    //   實測注入「改讀 _rpMaLevels()[20]」時 ⓒ2/ⓒ2b 照樣綠 = 假綠燈)。
    //   ⭐ 這一條直接把 `_keyLevels` 改成不可能巧合的數字,畫面**必須**跟著變。
    const r2 = await page.evaluate(() => new Promise(res => {
        const K = app._keyLevels;
        if (!K) return res({ err: 'no _keyLevels' });
        K.buyPx = 987.65; K.addPx = 1234.56; K.buyLb = '注入用';
        app.renderReportTab(app.currentSymbolId);
        setTimeout(() => {
            const box = document.querySelector('[data-rpwatch]');
            res({ txt: box ? box.innerText.replace(/\s+/g, ' ') : '' });
        }, 1800);
    }));
    ok('ⓒ2d 改掉 _keyLevels 之後畫面要跟著變(⛔ 證明不是自己算一份)',
       /987\.65/.test(r2.txt) && /1,234\.56/.test(r2.txt), (r2.err || r2.txt || '').slice(0, 220));
}

// ⓔ2ⓕ 「老是觀望」那句:數字必須跟著產物變 / 產物沒載入時不可謊報
{
    const r = await page.evaluate(() => {
        const keepP = app._pbEdge, keepT = app._todaySig;
        const real = app._ovRarityNote();
        app._pbEdge = { scanned: 1111, no_edge: 222, picks_syms: 3 };
        app._todaySig = { scanned: 1000, bull_syms: 7 };
        const fake = app._ovRarityNote();
        app._pbEdge = null; app._todaySig = null;
        const none = app._ovRarityNote();
        app._pbEdge = keepP; app._todaySig = keepT;
        return { real, fake, none };
    });
    ok('ⓔ2 真實產物:掃描檔數 + 有觸發價 + 亮看多訊號 三個數字都印得出來',
       /2,320/.test(r.real) && /觸發價/.test(r.real) && /看多訊號/.test(r.real) && /\d/.test(r.real), r.real.slice(0, 200));
    ok('ⓔ2b 換一份產物 → 三個數字全部跟著換(⛔ 證明不是寫死)',
       /1,111/.test(r.fake) && />3</.test(r.fake) && />7</.test(r.fake) && !/2,320/.test(r.fake), r.fake.slice(0, 200));
    // ⭐ 載不到時的正解是「**什麼都不說**」(呼叫端會退回原本那句)—— ⛔ 不可編一組數字(陷阱 #22)
    ok('ⓕ 產物載不到時⛔ 不可謊報數字(要回空字串)', r.none === '', JSON.stringify(r.none));
    ok('ⓔ2c 要指路去全市場的榜(⛔ 不可只丟一句「這是常態」就算了)', /今日訊號/.test(r.real), r.real.slice(0, 120));
}

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
