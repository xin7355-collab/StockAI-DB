#!/usr/bin/env node
/**
 * 🧭 V74.2.7 選股頁「總覽邏輯」(使用者:「選股頁面」)
 *
 * 📊 先量再改:實測選股頁預設榜(🎯 會賺訊號)**看到第一檔股票之前要先讀 593 字**前言。
 *    ⭐ 第一眼只留「**怎麼做**」兩句(做幾檔 / 什麼時候買),支撐它們的實測數字與 🧬 排序依據收進摺疊。
 *
 * ⚠️⚠️ 這頁的量測本身踩過一個坑,寫在這裡免得下次再犯:
 *    第一次量到「27,441 字」→ 那是**失真的**。頁面裡 5 個 `<details>` 全是收起的(25,043 字),
 *    而 `innerText` 對收起的 details 會**退化成 textContent**,把摺疊內容也算進去。
 *    ⭐ 正確量法:clone 之後把 `details:not([open])` 的內容拿掉再量(card_inventory 就是這樣做的)。
 *
 * ⛔ 釘死的五件事(①②③ 已用注入缺陷自我驗證):
 *   ① 第一眼要留「一天最多 2 檔 + 不是開盤買 + 尾盤時窗」(⛔ 這三個是**指令**,收起來等於沒講)
 *   ② 實測數字(2/3/6 檔各賺多少)⛔ 不可消失 —— 只是搬進摺疊
 *   ③ 🚨 「空頭沒有驗證過」這條免責⛔ 不可消失
 *   ④ 🚨 風險提醒(大盤風險分數)⛔ 不可進摺疊
 *   ⑤ 前言長度守門:看到第一檔股票前 < 450 字
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails++; };

// ── 靜態:風險提醒⛔ 不可被塞進摺疊 ──
{
    const i = SRC.indexOf('async _tomorrowWatchHtml()');
    const seg = SRC.slice(i, SRC.indexOf('\n    _showPbHelp()', i));
    ok('🚧 空過守門:抓得到 _tomorrowWatchHtml 區段', seg.length > 2000, seg.length);
    // riskLine / mktLine 必須直接插在卡片本體(⛔ 不在新加的 details 內)
    const det = seg.slice(seg.indexOf('<details class="mb-1.5">'), seg.indexOf('</details>', seg.indexOf('<details class="mb-1.5">')));
    ok('④ 🚨 大盤風險提醒(riskLine)⛔ 不可被放進摺疊', !det.includes('riskLine') && seg.includes('${mktLine}${riskLine}'));
    ok('④b 🚨 推播 CTA(買點提醒)⛔ 不可被放進摺疊', !det.includes('_pbAlertBarHtml'));
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._tomorrowWatchHtml, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    app.switchAppTab('radar');
    await new Promise(r => setTimeout(r, 4500));
    const v = document.getElementById('radarTodaySigView');
    if (!v || (v.innerHTML || '').length < 500) return { err: '清單沒渲染出來(沒有 playbook_edge.json?)' };
    // ⭐ 攤開字 = 把收起的 details 內容拿掉再量(⛔ 直接 innerText 會把摺疊內容算進去)
    const c = v.cloneNode(true);
    c.querySelectorAll('details:not([open])').forEach(d => { const s = d.querySelector('summary'); d.innerHTML = s ? s.outerHTML : ''; });
    const openTxt = (c.innerText || c.textContent || '').replace(/\s+/g, ' ');
    const at = openTxt.search(/\d{4}\s/);
    // ⚠️ 只認**這個**摺疊(標題含「上面那兩句的實測根據」)——
    //    第一版拿「頁面上所有收起的 details」當範圍,結果把數字整句刪掉之後
    //    n3/n6 還是 true(別的摺疊裡也有那些數字)→ 注入驗證只叫出 1/3 條。
    const mine = [...v.querySelectorAll('details')].find(d => /實測根據/.test(d.querySelector('summary')?.textContent || ''));
    const foldTxt = (mine ? (mine.innerText || mine.textContent || '') : '').replace(/\s+/g, ' ');
    return {
        openLen: openTxt.replace(/\s/g, '').length,
        firstStockAt: at,
        preamble: at > 0 ? openTxt.slice(0, at) : openTxt.slice(0, 600),
        foldFound: !!mine,
        foldHas: {
            n2: /1,718,529/.test(foldTxt), n3: /1,361,088/.test(foldTxt), n6: /735,938/.test(foldTxt),
            noOpen: !!mine && !mine.open,
        },
        hqShown: /強勢高波動/.test(foldTxt),      // 🧬 那條有出現才驗它的免責(hqN=0 走另一個分支)
        bearNote: /空頭沒有驗證過/.test(foldTxt),
    };
});
await browser.close();
if (R.err) { console.log(`⏭️ ${R.err} —— 略過動態驗證`); process.exit(fails ? 1 : 0); }

const P = R.preamble;
ok('① 第一眼要留「一天最多做前 2 檔」', /一天最多做前 2 檔/.test(P), P.slice(0, 160));
ok('① 🚨 第一眼要留「不是開盤買」+ 尾盤時窗(⛔ 這是防止做錯事的指令,不可收)',
    /不是開盤買/.test(P) && /13:00~13:25/.test(P), P.slice(0, 200));
ok('🚧 空過守門:找得到「實測根據」那個摺疊,而且它是收起的', R.foldFound === true && R.foldHas.noOpen === true,
    JSON.stringify({ found: R.foldFound, closed: R.foldHas.noOpen }));
ok('② ⛔ 實測數字沒有消失,只是搬進摺疊(2 檔 / 3 檔 / 6 檔各賺多少)',
    R.foldHas.n2 && R.foldHas.n3 && R.foldHas.n6, JSON.stringify(R.foldHas));
ok('③ 🚨 🧬 那條的「空頭沒有驗證過」免責⛔ 不可消失',
    !R.hqShown || R.bearNote === true, JSON.stringify({ hq: R.hqShown, bear: R.bearNote }));
ok('⑤ 前言瘦身:看到第一檔股票前 < 450 字(改版前是 593)', R.firstStockAt > 0 && R.firstStockAt < 450,
    `firstStockAt=${R.firstStockAt}`);
console.log(`   ↳ 前言 ${R.firstStockAt} 字 ・攤開合計 ${R.openLen} 字`);

console.log(fails ? `❌ ${fails} 條失敗` : '✅ RADARLEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
