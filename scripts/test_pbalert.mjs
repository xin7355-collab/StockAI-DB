#!/usr/bin/env node
/**
 * 🔔 明日作戰清單的「買點提醒」狀態列(V73.8.4)測試
 *
 * 使用者:「等買點到了…就要跟我告知,這樣不是就可以減少觀察了」
 * → 這件事 V72.9.0 就做好了(`_eodTriggerSweep`),⛔ 但清單上**從來沒說它存在、也沒說要開啟**
 *   → 等於沒有(陷阱 #32)。而且原文案直接寫「App 盤中會幫你盯,到價自動提醒」——
 *   **那句話在沒開通知時是假的**。
 *
 * ⛔ 這支要釘死的六件事:
 *   ① 沒開通知 → 要出現**可以一鍵開啟**的 CTA。
 *   ② 已開啟 → 改成「會提醒你」的狀態,⛔ 不可再顯示 CTA(不然像壞掉)。
 *   ③ 🚨 **兩種狀態都必須誠實寫「App 要開著/放背景才收得到」** ——
 *      ⛔ 少了這句,使用者會以為關掉 App 也會響,錯過買點會怪 App。
 *   ④ 必須寫出時窗 **13:00~13:28**(實測只有訊號日尾盤有效)。
 *   ⑤ ⛔ 原本那句無條件的「App 盤中會幫你盯,到價自動提醒」必須拿掉(它在沒開通知時是謊話)。
 *   ⑥ 已接進 `_tomorrowWatchHtml`(⛔ 寫了沒接上等於沒做,陷阱 #37)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._pbAlertBarHtml, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const out = {};
    const save = app.settings.watchlistAlert;
    // ⚠️ Notification.permission 是唯讀的 → 用 defineProperty 蓋掉(⛔ 不改瀏覽器設定)
    const stubPerm = v => {
        try { Object.defineProperty(Notification, 'permission', { value: v, configurable: true }); } catch (_) {}
    };
    app.settings.watchlistAlert = false; stubPerm('default');
    out.off = app._pbAlertBarHtml();
    app.settings.watchlistAlert = true; stubPerm('granted');
    out.on = app._pbAlertBarHtml();
    // 開了但瀏覽器權限沒給 → 仍要顯示 CTA(⛔ 不可假裝已就緒)
    app.settings.watchlistAlert = true; stubPerm('denied');
    out.halfway = app._pbAlertBarHtml();
    app.settings.watchlistAlert = save;
    return out;
});
await browser.close();

// ① 沒開 → CTA
ok('① 沒開通知 → 出現一鍵開啟的按鈕', /_enableAlertsFromBanner\(\)/.test(R.off) && /開啟提醒/.test(R.off), R.off.slice(0, 160));
ok('①b 而且要講清楚開了會得到什麼', /買點到了/.test(R.off));
// ② 已開 → 狀態
ok('② 已開啟 → 改成「會提醒你」的狀態', /會提醒你/.test(R.on));
ok('②b ⛔ 已開啟時不可再顯示 CTA 按鈕(不然像壞掉)', !/_enableAlertsFromBanner\(\)/.test(R.on), R.on.slice(0, 160));
// ②c 半套狀態
ok('②c 開關開了但瀏覽器權限沒給 → 仍要顯示 CTA(⛔ 不可假裝已就緒)',
    /_enableAlertsFromBanner\(\)/.test(R.halfway), R.halfway.slice(0, 160));
// ③ 誠實
for (const [k, v] of [['沒開', R.off], ['已開', R.on]]) {
    ok(`③ 🚨 ${k} 的狀態都要寫「App 要開著/放背景才收得到」`,
        /App\s*要開著|放在背景|完全關掉/.test(v), v.slice(0, 200));
}
// ④ 時窗
ok('④ 要寫出時窗 13:00~13:28', /13:00~13:28/.test(R.on) && /13:00~13:28/.test(R.off));
// ⑤ 原本那句無條件的謊話要拿掉
// ⚠️⚠️ 這條第一版直接掃整份 `src` → **被更新紀錄裡「引用那句話說明它被拿掉」給擋下來**。
//   CLAUDE.md 已記過:「禁止出現某句話」的測試會被自己寫對的免責/引用句誤判(這是第 6 次)。
//   ⭐ 正解:只掃**真正會渲染給使用者的模板**,⛔ 先把 `_CHANGELOG` 那段排除掉。
{
    const a = src.indexOf('_CHANGELOG: [');
    const b = a > 0 ? src.indexOf('\n    ],', a) : -1;
    const ui = (a > 0 && b > a) ? (src.slice(0, a) + src.slice(b)) : src;
    ok('⑤ 🚨 ⛔ 模板裡不可再有無條件的「App 盤中會幫你盯」(沒開通知時那是假的)',
        !ui.includes('App 盤中會幫你盯'), '');
    ok('⑤b 空過守門:排除後仍留著大部分內容(⛔ 否則這條等於沒驗)',
        ui.length > src.length * 0.5, `${ui.length} / ${src.length}`);
}
// ⑥ 接上
ok('⑥ 已接進明日作戰清單(⛔ 寫了沒接上等於沒做)',
    /\$\{this\._pbAlertBarHtml\(\)\}/.test(src), '');
ok('⑥b _pbAlertBarHtml 只定義一次', (src.match(/_pbAlertBarHtml\(\)\s*\{/g) || []).length === 1);
// ⑦ 燈號鐵則:這是狀態不是漲跌 → ⛔ 不可用紅綠
ok('⑦ ⛔ 不可用紅綠上色(這是提醒狀態,不是漲跌)',
    !/text-(red|green)-\d/.test(R.on) && !/text-(red|green)-\d/.test(R.off), '');
ok('⑧ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PBALERT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
