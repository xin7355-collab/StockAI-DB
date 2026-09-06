#!/usr/bin/env node
/**
 * 🤖 AI 產業鏈地圖(V73.9.9)測試
 *
 * 使用者上傳「AI 策略儀表板」包,要求以散戶救星風格納入。
 * ⛔ 這支要釘死的九件事:
 *   ① `_AI_CHAIN` 資料完整性:代號唯一、段/層級/毛利欄位合法、每檔都有風險欄。
 *   ② 🚨 ⛔ 不可把上傳包的「動能分數」(YoY×60%+法人×40%,憑空權重)接回來 ——
 *      畫面上不可出現「動能分數」,程式裡不可有那條加權公式(陷阱 #38)。
 *   ③ 免責必須在:人工整理 / 不是買進名單 / 預測力未實測。
 *   ④ 動態數字缺值要顯 '—',⛔ 不可顯 0 或 NaN(null-sort/null-display 陷阱)。
 *   ⑤ 層級篩選要真的有作用(點 L5 後名單變少、且每檔都含該層)。
 *   ⑥ tab 有註冊(_RADAR_TABS.aichain + 按鈕存在 + 切過去 view 會顯示)。
 *   ⑦ K線頁成員 chip:成員回內容、非成員回 ''(⛔ 不可對每一檔都顯)。
 *   ⑧ 燈號鐵則:品質/層級標示不可用 🔴🟢(方向色 text-red/green 可以)。
 *   ⑨ 空過守門:stub screener 後至少要渲染出 60 檔列(⛔ 防「渲染掛了但測試照綠」)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ② 靜態:⛔ 不可有憑空加權的動能公式(上傳包是 s_rev*0.6 + s_inst*0.4)
ok('② ⛔ 程式裡不可出現「YoY×0.6+法人×0.4」型的動能加權公式',
   !/\*\s*0\.6\s*\+\s*\w+\s*\*\s*0\.4/.test(src));
// ⚠️ ②b 驗**渲染輸出**不驗原始碼 —— 原始碼註解裡本來就要寫「⛔ 不採用動能分數」
//    (第 7 次踩「禁止句測試被自己的免責/註解擋下」的坑,見 CLAUDE.md)→ 移到下方 evaluate 後驗。
ok('⑥ tab 已註冊(_RADAR_TABS.aichain)', /aichain:\s*\{\s*id:\s*'radarTabAiChain'/.test(src));
ok('⑥b hint 已寫且含「不是買進名單」', /aichain:\s*'🤖 AI 產業鏈地圖/.test(src) && /不是買進名單/.test(src));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._AI_CHAIN && !!app._renderAiChainView, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const C = app._AI_CHAIN;
    // ① 資料完整性
    const codes = C.stocks.map(s => s[0]);
    const integrity = {
        n: C.stocks.length,
        dup: codes.length - new Set(codes).size,
        badSeg: C.stocks.filter(s => !['up', 'mid', 'down'].includes(s[2])).length,
        badLv: C.stocks.filter(s => !/^[1-5]+$/.test(String(s[4]))).length,
        badGm: C.stocks.filter(s => !['高', '中', '低'].includes(s[5])).length,
        noRisk: C.stocks.filter(s => !s[6]).length,
        transWinCodes: C.trans.flatMap(t => [...t.win, ...t.lose])
            .map(x => (String(x).match(/^(\d{4,5}[A-Z]?)\s/) || [])[1]).filter(Boolean)
            .filter(c => !codes.includes(c)),
    };
    // ④⑨ stub screener:2330 有值、4585 缺 chg20(null)→ 顯 '—';gm 逐檔遞增(驗成員排序用)
    app._scrData = { data_date: '2026-08-26', cols: ['chg20', 'f10', 'yoy', 'gm'], rows: {}, ind: {} };
    app._scrC = { chg20: 0, f10: 1, yoy: 2, gm: 3 };
    C.stocks.forEach((s, i) => { app._scrData.rows[s[0]] = [5.5, 1200, 30, 10 + (i % 50)]; });
    app._scrData.rows['4585'] = [null, null, null, null];
    app._scrData.rows['3105'] = [5.5, 1200, 30, 99];   // ⑬ L5 成員裡毛利最高 → 展開後要排第一
    app.radarStrategy = 'aichain';
    app._aicLv = null;
    await app._renderAiChainView();
    const body = document.getElementById('aiChainBody');
    const html1 = body.innerHTML;
    // ⚠️ 只數「🗺️ 個股地圖」之後的列 —— 轉折區的受惠 chip 也有 analyze onclick,不屬於名單
    const map1 = html1.slice(html1.indexOf('個股地圖'));
    const rowN1 = (map1.match(/app\.analyze\('/g) || []).length;
    const dash4585 = new RegExp("4585[^]{0,400}?—").test(html1);
    // ⑤ 層級篩選
    app._aicSetLv(5);
    const html2 = body.innerHTML;
    const map2 = html2.slice(html2.indexOf('個股地圖'));
    const rowsL5 = C.stocks.filter(s => s[4].includes('5')).length;
    const shown2 = C.stocks.filter(s => map2.includes(`app.analyze('${s[0]}')`)).length;
    // ⑬ 展開的層級卡要列出成員 chips(範圍=轉折區之前,那裡只有五級卡)
    const lvArea = html2.slice(0, html2.indexOf('技術轉折雷達'));
    const memN = (lvArea.match(/app\.analyze\('/g) || []).length;
    const memFirst = (lvArea.match(/app\.analyze\('(\d{4,5}[A-Z]?)'/) || [])[1] || '';
    const memHasName = /穩懋/.test(lvArea) && /99%/.test(lvArea);
    const memWarn = /≠ 股價會漲/.test(lvArea);
    app._aicSetLv(5); // 再點一次取消
    // ⑦ chip
    const chipIn = app._aiChainChipHtml('3491');   // 上櫃、industry_map 沒收錄的成員
    const chipOut = app._aiChainChipHtml('2603');  // 非成員(長榮)
    // ⑧ 燈號:整個 dashboard 文字裡不可出現 🔴🟢(層級/熱度/毛利都不是方向)
    // ⚠️ 一定要加 u flag —— 沒加的話字元類別拆成 surrogate 半碼,🔄 也會被誤判成 🔴
    const lamp = /[🔴🟢]/u.test(html1);
    return { integrity, rowN1, dash4585, html1len: html1.length, disclaimer: /不是買進名單/.test(html1) && /人工整理/.test(html1) && /未實測/.test(html1),
             rowsL5, shown2, chipIn, chipOut, lamp,
             medShown: /近20日中位/.test(html1), nan: /NaN|undefined/.test(html1),
             momWord: /動能分數/.test(html1),
             memN, memFirst, memHasName, memWarn,
             // ⑫ 利潤池:代號要能在 stocks 表查到名(⛔ 防孤兒代號),渲染要有中文名
             poolOrphans: C.pool.flatMap(pp => pp.tw).map(x => String(x).split(' ')[0]).filter(c => !codes.includes(c)),
             poolNamed: /台積電/.test(html1.slice(html1.indexOf('錢被誰賺走'), html1.indexOf('訊號從哪裡先出現'))) };
});
await browser.close();

const I = R.integrity;
ok('① 檔數 ≥64 且代號唯一', I.n >= 64 && I.dup === 0, I);
ok('①b 段/層級/毛利欄位全部合法、每檔都有風險欄', I.badSeg === 0 && I.badLv === 0 && I.badGm === 0 && I.noRisk === 0, I);
ok('①c 轉折 win/lose 裡的代號都在名單裡(⛔ 防孤兒代號)', I.transWinCodes.length === 0, I.transWinCodes);
ok('⑨ 🚧 空過守門:渲染出 ≥60 檔可點的列', R.rowN1 >= 60, R.rowN1);
ok('③ 免責齊全(人工整理 / 不是買進名單 / 未實測)', R.disclaimer);
ok('②b ⛔ 渲染輸出不可出現「動能分數」', !R.momWord);
ok('④ 缺值顯 —(4585 被 stub 成 null)', R.dash4585);
ok('④b 畫面不可出現 NaN/undefined', !R.nan);
ok('④c 有中位數字(讀得到 stub 的 screener)', R.medShown);
ok('⑤ 層級篩選真的有作用(L5 成員 ' + R.rowsL5 + ' 檔)', R.shown2 === R.rowsL5 && R.rowsL5 < I.n, [R.shown2, R.rowsL5]);
ok('⑫ 利潤池代號都在名單裡(⛔ 防孤兒代號)', R.poolOrphans.length === 0, R.poolOrphans);
ok('⑫b 利潤池台股入口有中文名(不是只有代號)', R.poolNamed);
ok('⑬ 展開層級 → 成員 chips 數 = 該層檔數', R.memN === R.rowsL5, [R.memN, R.rowsL5]);
ok('⑬b 毛利最高的排第一(3105 stub 成 99%)且顯中文名+毛利', R.memFirst === '3105' && R.memHasName, [R.memFirst, R.memHasName]);
ok('⑬c 成員排序旁必附「公司會賺錢 ≠ 股價會漲」警語', R.memWarn);
ok('⑦ 成員 chip 有內容且含段名', R.chipIn.length > 50 && /上游/.test(R.chipIn), R.chipIn.slice(0, 80));
ok('⑦b 非成員回空字串(⛔ 不可對每檔都顯)', R.chipOut === '', R.chipOut.slice(0, 60));
ok('⑧ 燈號鐵則:dashboard 不可用 🔴🟢 表品質', !R.lamp);
ok('⑩ K線頁已接 chip(兩條渲染路徑都接)', (src.match(/_aiChainChipHtml\(this\.currentSymbolId\)/g) || []).length === 2,
   (src.match(/_aiChainChipHtml\(this\.currentSymbolId\)/g) || []).length);
ok('⑪ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ AICHAIN_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
