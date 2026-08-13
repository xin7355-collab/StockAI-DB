#!/usr/bin/env node
/**
 * 💳 全市場融資維持率測試(V72.0.3)
 *
 * 來源:巨人傑逐字稿【恐慌中獲利:130% 融資市場反彈策略】——
 *   跌破 130% → 券商電腦自動強制斷頭 → 浮額清乾淨 → 常見 V 型反彈(強制去槓桿)。
 *
 * ⛔ 這支最重要的任務是**擋住兩件事**:
 *   ① 把「我自己推估的數字」講成官方公布值
 *   ② 引用他宣稱的「26 年 85% 勝率」—— 我的融資資料只有 3 個月,根本沒驗過
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = []; page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._marginHealth, null, { timeout: 20000 });

const run = (ratio, hist = null, src = 'estimate') => page.evaluate(a => {
    app._marketStats = { margin: { ratio: a.ratio, src: a.src, n: 1827, lots: 8488067, val_e: 9948.6, amt_e: 7812.6, date: '2026-08-04' },
                         margin_hist: a.hist };
    return { r: app._marginHealth(), html: app._marginHealthHtml() };
}, { ratio, hist, src });

// ⚠️⚠️ V73.3.8 這一節整個改寫,原因**不是測試太嚴,是它釘的事實已經被實測推翻**:
//   舊版釘「127.3% → 已跌破 130% → 斷頭區 🚨」。但拿證交所官方 11 年資料實測後發現:
//     ・2015 起 2,821 個交易日**一次都沒跌破過 130%**(史上最低 130.4%)
//     ・而我那個 127.3% 是**推估值**,官方同一天是 194.7%(差 67pp、方向相反)
//   ⛔ 所以「130% 分級」本身就是錯的判準,不可再釘。
//   🚨 而且舊版第 ② 條釘「推估會**偏高**」—— **那個方向本來就寫反了**,
//      實測是推估 127.9% vs 官方 194.7% = 系統性**偏低**。舊測試等於把一個錯的說法釘住了。
//   ⭐ 但保護使用者的那幾條(不可引用未驗證勝率、不可說「跌破就該買」)**一條都不放寬**,
//      而且改成更強的版本:現在要求明說「那條線 11 年沒觸發過」「方向跟流行說法相反」。

// ① 分級改用**11 年實測分布的位階**(⛔ 不再用寫死的 130/140/165)
let x = await run(127.3);
ok('① 127.3% → 11 年來最低的 5%(⛔ 不再叫「斷頭區」)', /最低的 5%/.test(x.html), x.html.slice(0, 400));
x = await run(160);
ok('① 160% → 低於 11 年中位數', /低於 11 年中位數/.test(x.html), x.html.slice(0, 400));
x = await run(175);
ok('① 175% → 11 年來的正常區間', /正常區間/.test(x.html), x.html.slice(0, 400));
x = await run(194.7, null, 'official');
ok('① 194.7% → 11 年來最高的 5%', /最高的 5%/.test(x.html), x.html.slice(0, 400));

// ② 推估 fallback 時仍必須標明是推估 —— ⭐ 但偏誤方向要寫**偏低**(舊版寫反了)
x = await run(127.3);
ok('② ⭐ 推估時標題要標「推估・非官方」', /推估・非官方/.test(x.html), x.html.slice(0, 400));
ok('② ⭐ 必須說明偏誤方向是**偏低**(⛔ 舊版寫成偏高是錯的)', /系統性偏低/.test(x.html), x.html.slice(0, 1600));
ok('② ⭐ 要給出推估 vs 官方的實際落差當證據', /127\.9/.test(x.html) && /194\.7/.test(x.html), x.html.slice(0, 1600));
ok('② ⛔ 推估時不可自稱官方值', !/證交所公布的官方值/.test(x.html), x.html.slice(0, 600));

// ②b 官方值時反過來:⛔ 不可再標推估
x = await run(194.7, null, 'official');
ok('②b 官方時標題要寫「官方公布值」', /官方公布值/.test(x.html), x.html.slice(0, 400));
ok('②b ⛔ 官方時不可標「推估・非官方」', !/推估・非官方/.test(x.html), x.html.slice(0, 400));

// ③ ⭐⛔ 不可引用未驗證勝率、不可說「跌破就該買」—— **一條都不放寬**
// ⚠️ 免責句本身含被禁的字 → 比對前先拿掉否定形(這個坑本專案踩過 6 次)
const strip = h => h.replace(/(?:不是|並非|⛔\s*那不是)\s*[「『]?跌破就(?:該|要)買[」』]?/g, '');
const BAD = /85%|27\.4%|勝率高達|聖杯|跌破就(該|要)買/;
ok('③ ⭐⛔ 卡片不可引用未驗證的勝率宣稱', !BAD.test(strip(x.html)), (strip(x.html).match(BAD) || []).join(','));
// ⭐ 舊版只要求「說一句不是跌破就該買」;現在有實測了 → 要求給出**證據**
ok('③ ⭐ 必須明說 11 年一次都沒跌破過 130%', /一次都沒有跌破 130%/.test(x.html), x.html.slice(0, 1400));
ok('③ ⭐ 必須點出實測方向跟流行說法相反', /跟流行說法相反/.test(x.html), x.html.slice(0, 1600));

const help = await page.evaluate(() => { let t = ''; const o = window.alert; window.alert = s => { t = s; }; app._showMarginHelp(); window.alert = o; return t; });
ok('③ ⭐ 教學⛔ 不可再說「常常跟著一波反彈」當賣點', !/常常跟著一波反彈/.test(help.replace(/⛔[^\n]*/g, '')), help.slice(0, 900));
ok('③ ⭐ 教學要給實測天數當證據', /2,821|2821/.test(help), help.slice(0, 900));
ok('③ ⭐ 教學要說明「那條線幾乎永遠不會觸發」', /永遠不會觸發/.test(help), help.slice(0, 1200));
ok('③ ⭐ 教學要坦承之前顯示的推估是錯的', /差 67 個百分點/.test(help), help.slice(0, 2000));
ok('③ ⭐ 教學仍要說「不是買賣訊號」', /不是買賣訊號/.test(help), help.slice(0, 2000));

// ④ 趨勢
x = await run(127.3, Array.from({ length: 8 }, (_, i) => ({ d: `2026-07-2${i}`, r: 135 - i, n: 1800 })));
ok('④ 有歷史 → 顯示近 5 日變化', /近 5 日/.test(x.html), x.html.slice(0, 600));
ok('④ 下降要用綠色(台股色:跌=綠)', /text-green-300">−|text-green-300">-/.test(x.html), x.html.slice(0, 700));

// ⑤ 無資料 → 不顯(⛔ 不硬掰)
ok('⑤ 沒有 margin 欄位 → 空字串', (await page.evaluate(() => { app._marketStats = { pb: {} }; return app._marginHealthHtml(); })) === '');
ok('⑤ 沒有 _marketStats → 空字串', (await page.evaluate(() => { app._marketStats = null; return app._marginHealthHtml(); })) === '');
ok('⑤ ratio=0 → 空字串', (await run(0)).html === '');

// ⑥ 接進泡沫風控面板(合併,⛔ 沒開新卡)
ok('⑥ ⭐ 併進 _updateBubbleCrashCard(沒另開卡)',
   await page.evaluate(() => /_marginHealthHtml/.test(app._updateBubbleCrashCard.toString())));
ok('⑦ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log('');
if (fails.length) { console.log(`❌ MARGINHEALTH_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ MARGINHEALTH_TEST_PASS');
