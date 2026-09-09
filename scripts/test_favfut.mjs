#!/usr/bin/env node
/**
 * 🏀 自選列個股期貨標籤 + 夜盤新鮮度守門(V73.8.6)測試
 *
 * 使用者:「個股期貨新增簡短資訊放置在自選裡面,這樣比較可以快速查看」。
 *
 * 🚨 但做之前先抓到一個**更嚴重的既有 bug**(就在使用者自己的截圖裡):
 *    當沖頁顯示「個股期貨夜盤 −5.06% / 期 544.0 → 有人期貨放空避險,偏空留意」——
 *    而那份 `stock_futures_night.json` **停在 08-08(16 天前)**,畫面卻當成昨晚在判讀。
 *    夜盤是**當日快照**(昨天 −5% 今天可能 +3%)→ 這是陷阱 #34:
 *    **顯示一個不該相信的數字,比空白更危險**。
 *
 * ⛔ 這支要釘死的七件事:
 *   ① 資料太舊 → 自選標籤 ⛔ 整個不顯示。
 *   ② 資料太舊 → 當沖卡 ⛔ 不可照算,但也 ⛔ 不可靜默消失(要說「停在哪一天」)。
 *   ③ 新鮮時才顯示,而且數字要對。
 *   ④ 門檻用**日曆天**不用小時 —— 週末沒有夜盤,用 30 小時會讓每個週一都誤報。
 *   ⑤ 沒有個股期貨的股票 → 不顯示(⛔ 不留空殼)。
 *   ⑥ 紅綠只表**漲跌方向**(台股慣例),符合燈號鐵則。
 *   ⑦ 判斷點只有一個 `_stockFutFresh`(⛔ 不可在兩處各寫一套,陷阱 #37)。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._favFutChip && !!app._stockFutFresh, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const out = {};
    const mkData = (c0, c1) => [{ close: c0 }, { close: c1 }];
    const setFut = (isoAgoDays, rec) => {
        const d = new Date(Date.now() - isoAgoDays * 86400000);
        app._stockFutureUpdated = d.toISOString();
        app._stockFutureCache = rec ? { '2327': rec } : {};
    };
    // ③ 新鮮 + 有資料
    setFut(0, { nightChgPct: 6.46, price: 189.5, vol: 100, ts: '08/24 05:36' });
    out.fresh = app._favFutChip('2327', mkData(180, 180));
    out.freshState = app._stockFutFresh();
    // ①④ 太舊(16 天,= 使用者截圖那份)
    setFut(16, { nightChgPct: -5.06, price: 544, vol: 4225, ts: '08/08 05:36' });
    out.stale = app._favFutChip('2327', mkData(560, 567));
    out.staleState = app._stockFutFresh();
    // ④ 週末情境:3 天前(週五夜盤 → 週一看)必須仍算新鮮
    setFut(3, { nightChgPct: 1.2, price: 100, vol: 10, ts: '08/21 05:36' });
    out.weekend = app._favFutChip('2327', mkData(99, 99));
    out.weekendState = app._stockFutFresh();
    // ⑤ 這檔沒有個股期貨
    setFut(0, { nightChgPct: 1.0, price: 1, vol: 1 });
    out.noFut = app._favFutChip('9999', mkData(10, 10));
    // ⑥ 補漲情境:夜盤 +6.46 vs 現貨 0% → gap 6.46 ≥ 1.5
    setFut(0, { nightChgPct: 6.46, price: 189.5, vol: 100 });
    out.catchUp = app._favFutChip('2327', mkData(180, 180));
    // 下跌 → 綠
    setFut(0, { nightChgPct: -3.2, price: 170, vol: 100 });
    out.down = app._favFutChip('2327', mkData(180, 180));
    // 完全沒資料
    app._stockFutureUpdated = null; app._stockFutureCache = {};
    out.none = app._favFutChip('2327', mkData(1, 1));
    out.noneState = app._stockFutFresh();
    return out;
});
await browser.close();

// ③ 新鮮 → 有顯示且數字對
ok('③ 新鮮資料 → 顯示標籤,數字正確', /期夜 \+6\.5%/.test(R.fresh), R.fresh);
ok('③b 新鮮判定 ok=true', R.freshState.ok === true, JSON.stringify(R.freshState));
// ① 太舊 → 不顯示
ok('① 🚨 資料 16 天前 → 自選標籤 ⛔ 整個不顯示', R.stale === '', R.stale);
ok('①b 守門要說得出原因是 stale', R.staleState.ok === false && R.staleState.why === 'stale', JSON.stringify(R.staleState));
ok('①c 而且要算得出「幾天前」給當沖卡用', R.staleState.days >= 15, JSON.stringify(R.staleState));
// ④ 週末不可誤判
ok('④ 🚨 3 天前(週五夜盤→週一看)仍算新鮮(⛔ 用小時會每週一誤報)',
    R.weekendState.ok === true && R.weekend !== '', JSON.stringify(R.weekendState));
// ⑤ 沒期貨的股票
ok('⑤ 沒有個股期貨的股票 → ⛔ 不顯示(不留空殼)', R.noFut === '', R.noFut);
ok('⑤b 完全沒資料 → ⛔ 不顯示', R.none === '' && R.noneState.ok === false, R.none);
// ⑥ 顏色/方向
ok('⑥ 上漲用紅(台股慣例)', /text-red-300/.test(R.catchUp), R.catchUp);
ok('⑥b 下跌用綠', /text-green-300/.test(R.down), R.down);
ok('⑥c 夜盤領先現貨很多 → 標「補漲?」(⛔ 帶問號,不是斷言)', /補漲\?/.test(R.catchUp), R.catchUp);
ok('⑥d ⛔ 不可寫成買賣訊號', /不是買賣訊號/.test(R.catchUp), R.catchUp);

// ② 當沖卡:太舊要誠實說,⛔ 不可靜默消失
ok('② 🚨 當沖卡有「資料停在 X(N 天前)」的誠實訊息', /資料停在 \$\{_futFr\.label\}/.test(src), '');
ok('②b 而且明說「先不判讀」', src.includes('先不判讀'), '');
ok('②c 🚨 原本無條件的判讀已加上守門', /if \(fut && _futFr\.ok && isFinite/.test(src), '');
// ⑦ 單一判斷點
ok('⑦ _stockFutFresh 只定義一次(⛔ 不可兩處各寫一套)',
    (src.match(/_stockFutFresh\(\)\s*\{/g) || []).length === 1);
ok('⑦b 兩個呼叫端都接上(自選標籤 + 當沖卡)',
    (src.match(/_stockFutFresh\(\)/g) || []).length >= 3, String((src.match(/_stockFutFresh\(\)/g) || []).length));
ok('⑦c 已接進自選列的標籤組合', /_favFutChip\(sym, data\)/.test(src));

ok('⑧ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ FAVFUT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
