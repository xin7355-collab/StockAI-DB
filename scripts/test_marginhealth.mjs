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

const run = (ratio, hist = null) => page.evaluate(a => {
    app._marketStats = { margin: { ratio: a.ratio, n: 1827, lots: 8488067, val_e: 9948.6, amt_e: 7812.6, date: '2026-08-04' },
                         margin_hist: a.hist };
    return { r: app._marginHealth(), html: app._marginHealthHtml() };
}, { ratio, hist });

// ① 分級
let x = await run(127.3);
ok('① 127.3% → 斷頭區', /已跌破 130%/.test(x.html) && /🚨/.test(x.html), x.html.slice(0, 300));
x = await run(136);
ok('① 136% → 接近危險線', /接近危險線/.test(x.html), x.html.slice(0, 300));
x = await run(155);
ok('① 155% → 正常區間', /正常區間/.test(x.html), x.html.slice(0, 300));

// ② ⭐ 必須標明是「推估」不是官方值
x = await run(127.3);
ok('② ⭐ 標題要標「推估」', /\(推估\)/.test(x.html), x.html.slice(0, 300));
ok('② ⭐ 必須明寫「不是官方公布值」', /不是官方公布值/.test(x.html), x.html.slice(0, 1500));
ok('② ⭐ 必須說明偏誤方向(推估會偏高)', /偏高/.test(x.html), x.html.slice(0, 1500));
ok('② ⭐ 必須說明資料只回溯到 2026/05', /2026\/05/.test(x.html), x.html.slice(0, 1500));
ok('② 要勸「看趨勢別對絕對值」', /看趨勢/.test(x.html), x.html.slice(0, 1500));

// ③ ⭐⛔ 不可引用他的 85% 勝率、不可說「跌破就該買」
// ⚠️ 「⛔ 那不是「跌破就該買」」這句**本身含「跌破就該買」五個字**,那是正確的免責寫法
//    → 比對前先拿掉否定形(同 test_tdcc4 / test_trustvol / test_buyexhaust 的做法)。
//    ⛔ 別把 BAD 放寬成不檢查 —— 要擋的是「正面主張」,不是「引用後打臉」。
const strip = h => h.replace(/(?:不是|並非|⛔\s*那不是)\s*[「『]?跌破就(?:該|要)買[」』]?/g, '');
const BAD = /85%|27\.4%|勝率高達|聖杯|跌破就(該|要)買/;
ok('③ ⭐⛔ 卡片不可引用未驗證的勝率宣稱', !BAD.test(strip(x.html)), (strip(x.html).match(BAD) || []).join(','));
ok('③ ⭐ 要明說「不是跌破就該買」', /不是「跌破就該買」|⛔.{0,20}跌破就該買/.test(x.html), x.html.slice(0, 1200));
const help = await page.evaluate(() => { let t = ''; const o = window.alert; window.alert = s => { t = s; }; app._showMarginHelp(); window.alert = o; return t; });
ok('③ ⭐ 教學要明說「我沒有驗證過」', /沒有.{0,3}驗證過/.test(help), help.slice(0, 400));
ok('③ ⭐ 教學要說明那個 85% 不是我算的、不背書', /不是我算的/.test(help) && /不敢背書/.test(help), help.slice(0, 900));
ok('③ ⭐ 教學要說「不要第一天就衝」', /不要第一天就衝/.test(help), help.slice(0, 900));
ok('③ 教學要說要等長下影線/紅K', /長下影線/.test(help) && /紅 ?K/.test(help), help.slice(0, 900));
ok('③ 教學要說 2~3 年才一次、好市況別用', /2~3 年才一次/.test(help) && /接刀子/.test(help), help.slice(0, 1200));

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
