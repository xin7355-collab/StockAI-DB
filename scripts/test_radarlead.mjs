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
 * 🧹 V78.3.6 散戶 App 拿掉「實測根據」摺疊 → ②③ 改釘「一般模式整張卡⛔ 不出現那些實測數字 / 研究字樣」
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
    // 🧹 V78.3.6「實測根據」摺疊已從散戶 App 拿掉 → 改成檢查**區段內每一個** <details>…</details> 都不含它們
    //    (⛔ 舊寫法 indexOf 找不到時 slice(-1,…) 會變空字串 = 永遠會過的假綠燈)
    const dets = seg.match(/<details[\s\S]*?<\/details>/g) || [];
    ok('④ 🚨 大盤風險提醒(riskLine)⛔ 不可被放進摺疊', dets.every(d => !d.includes('riskLine')) && seg.includes('${mktLine}${riskLine}'), dets.length);
    ok('④b 🚨 推播 CTA(買點提醒)⛔ 不可被放進摺疊', dets.every(d => !d.includes('_pbAlertBarHtml')) && seg.includes('${this._pbAlertBarHtml()}'));
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
        // ⚠️ V78.1.2 V78.0.7 之後 🧬 已經用 2011~2026(含 2022 空頭)驗過 → 舊句「空頭沒有驗證過」**變成不實**、改寫是對的;
        //   用意(🧬 那條⛔ 不可只講好的,要帶跟空頭有關的代價)改成兩種寫法都收:舊的未驗證 / 新的「空頭那年比較差」。
        bearNote: /空頭沒有驗證過/.test(foldTxt) || /⚠️[^\n]{0,160}空頭[^\n]{0,80}(差|輸|沒過)/.test(foldTxt),
        // 🧹 V78.3.6 一般模式:整個卡(含所有摺疊)都⛔ 不可出現實測數字 / 研究字樣
        allTxt: (v.textContent || '').replace(/\s+/g, ' '),
        // 只框「🎯 明天要盯這 N 檔」那張卡(⛔ 別被同頁其他卡的字救活或誤殺)
        cardTxt: (([...v.querySelectorAll('div')].filter(d => /^\s*🎯 明天要盯這/.test(d.firstElementChild?.textContent || ''))[0] || {}).textContent || '').replace(/\s+/g, ' '),
        openTxt,
    };
});
await browser.close();
if (R.err) { console.log(`⏭️ ${R.err} —— 略過動態驗證`); process.exit(fails ? 1 : 0); }

const P = R.preamble;
ok('① 第一眼要留「一天最多做前 2 檔」', /一天最多做前 2 檔/.test(P), P.slice(0, 160));
// ⚠️ V75.1.5:⛔ 不可把尾盤時窗的**分鐘數**寫死在測試裡(舊版釘 `13:00~13:25`,
//   App 後來統一成 13:00~13:28 → 假失敗)。⭐ 改成「跟 index.html 裡實際在用的那個時窗一致」,
//   這樣時窗要改的時候,測試擋的是「兩邊不一致」,而不是「跟我當年寫的不一樣」。
const _WIN = (() => {
    const all = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/13:\d\d~13:\d\d/g) || []);
    const cnt = {}; all.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
    return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || '';
})();
ok('🚧 空過守門:index.html 裡找得到尾盤時窗字串', !!_WIN, _WIN);
ok('① 🚨 第一眼要留「不是開盤買」+ 尾盤時窗(⛔ 這是防止做錯事的指令,不可收)',
    /不是開盤買/.test(P) && !!_WIN && P.includes(_WIN), `窗口=${_WIN} / ${P.slice(0, 200)}`);
// 🧹 V78.3.6 散戶 App 不放「實測根據」摺疊(2/3/6 檔各賺多少搬去產業作戰室)→ 改釘:
//    ② 那個摺疊與那三個數字在一般模式**整張卡(含所有摺疊)**都⛔ 不可出現
//    ③ 🧬 那一行改成講「決策台會買的那一格」(怎麼做),⛔ 不帶研究字樣
ok('② ⛔ 一般模式沒有「實測根據」摺疊,2/3/6 檔回測數字整張卡都不出現(🧹 V78.3.6)',
    R.foldFound === false && !/1,718,529|1,361,088|735,938|實測根據/.test(R.allTxt), JSON.stringify({ found: R.foldFound }));
ok('🚧 空過守門:框得到「🎯 明天要盯這 N 檔」那張卡', R.cardTxt.length > 200 && /一天最多做前 2 檔/.test(R.cardTxt), R.cardTxt.length);
ok('③ 🧬 那一行講「決策台會買的那一格」(或今天沒有),⛔ 這張卡不帶實測/回測研究字樣(🧹 V78.3.6)',
    /決策台(唯一)?會買的那一格/.test(R.cardTxt) && !/實測|回測|期望值|勝率\s*\d|對照組|探針/.test(R.cardTxt),
    (R.cardTxt.match(/實測|回測|勝率\s*\d|對照組|探針/) || [''])[0]);
ok('⑤ 前言瘦身:看到第一檔股票前 < 450 字(改版前是 593)', R.firstStockAt > 0 && R.firstStockAt < 450,
    `firstStockAt=${R.firstStockAt}`);
console.log(`   ↳ 前言 ${R.firstStockAt} 字 ・攤開合計 ${R.openLen} 字`);

console.log(fails ? `❌ ${fails} 條失敗` : '✅ RADARLEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
