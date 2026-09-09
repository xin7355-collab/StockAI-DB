#!/usr/bin/env node
/**
 * ⏳ 出場提醒漏了「最長 20 個交易日」(V73.9.7)測試
 *
 * 🚨 使用者問「隔天獲利就持續抱著…這樣操作是否正確」時查出來的:
 *    `portfolio_backtest.mjs` 的出場**有三條**:
 *      ① 停損 = min(訊號日最低, 進場×0.95)
 *      ② 停利 = 跌破 5MA
 *      ③ **最長持有 20 個交易日(MAXD=20)**
 *    而 App 的 `_pbExitSweep` **只有 ①②**,⛔ 漏了 ③。
 *
 * ⭐ 後果不是「少一則通知」而已 —— 遇到一路沿著 5MA 走的強勢股,
 *    回測第 20 天就出場了,使用者卻會一直抱下去
 *    → **他實際在做的已經不是那套被驗證過的打法**,而回測數字是照那套算的。
 *    (V72.9.9 實測:出場放寬確實賺更多,但**回撤翻一倍**,−9.4% → −21.0%。)
 *
 * ⛔ 這支要釘死的五件事:
 *   ① 三條規則都要在(⛔ 少一條就不是那套打法)。
 *   ② 用**交易日**(K 線根數)數,⛔ 不可用日曆天 —— 連假會提早叫。
 *   ③ K 線日期是 `2026/08/26`、記錄是 `2026-08-26` → **要正規化再比**,
 *      ⛔ 不然永遠找不到進場那一根、這條規則等於沒接上。
 *   ④ 停損優先於停利/到期(⛔ 同一輪不可同時喊三種)。
 *   ⑤ 文案 ⛔ 不可寫成「一定要賣」—— 那是紀律提醒不是指令。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ① 靜態:三條規則都要在 ────────────────────────────────────────
{
    const i = src.indexOf('async _pbExitSweep()');
    const j = src.indexOf('_pbTrackHtml()', i);
    const blk = (i > 0 && j > i) ? src.slice(i, j) : '';
    ok('🚧 空過守門:抓得到 _pbExitSweep 的區塊', blk.length > 800, blk.length);
    ok('① 停損那條在', /px <= t\.sl/.test(blk));
    ok('①b 停利(跌破 5MA)那條在', /px < ma5/.test(blk));
    ok('①c 🚨 **最長 20 個交易日**那條在(⛔ 這條原本漏了)', /_held >= 20/.test(blk), blk.slice(-400));
    ok('② 用 K 線根數數交易日(⛔ 不可用日曆天,連假會提早叫)',
       /rows\.length - 1 - _di/.test(blk));
    ok('③ 🚨 日期要正規化再比(K 線是 2026/08/26、記錄是 2026-08-26)',
       /replace\(\/\\\/\/g, '-'\)/.test(blk) || blk.includes("replace(/\\//g, '-')"), '');
    ok('⑤ 文案 ⛔ 不可寫成「一定要賣」', !/一定要賣|馬上賣掉|務必賣出/.test(blk));
    ok('⑤b 但要說出「再抱下去就不是那套打法」', /不是.{0,6}驗證過的打法|回撤會翻/.test(blk));
}

// ── 實跑:三種情境各驗一次 ────────────────────────────────────────
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._pbExitSweep, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const fired = [];
    app._fireAlert = (title, body) => { fired.push({ title, body }); };
    app._kbarFiredToday = () => false;                 // 不要被「今天已響過」擋掉
    Object.defineProperty(window, 'Notification', { value: { permission: 'granted' }, configurable: true });

    // 造 K 線:26 根,進場那根在第 5 根 → 已持有 20 個交易日
    const mkRows = (n, price) => Array.from({ length: n }, (_, i) => ({
        date: `2026/08/${String(i + 1).padStart(2, '0')}`, close: price, high: price, low: price, open: price,
    }));
    const run = async (trade, rows, px) => {
        fired.length = 0;
        app._pbTrades = () => [trade];
        app._pbSaveTrades = () => {};
        app.fetchFugleData = async () => ({ price: px });
        app.idb = { get: async () => ({ data: rows }) };
        app.getStockName = () => '測試股';
        await app._pbExitSweep();
        return fired.map(f => f.title);
    };
    const base = { s: '9999', k: 'x', e: 100, sl: 95, took: true };

    // ① 抱滿 20 個交易日(進場在第 6 根、共 26 根 → held=20),價格在 5MA 之上
    const up = mkRows(26, 100); up[25].close = 110; up[24].close = 108; up[23].close = 106; up[22].close = 104;
    const maxd = await run({ ...base, d: '2026-08-06' }, up, 120);

    // ② 才抱 5 天 → ⛔ 不可叫
    const short = await run({ ...base, d: '2026-08-21' }, up, 120);

    // ③ 停損優先(價格跌破 sl)→ 只能有停損那一則
    const sl = await run({ ...base, d: '2026-08-06' }, up, 90);

    // ④ 日期對不上(記錄用 `/` 而不是 `-`)→ 找不到進場那根 ⇒ 不可誤叫
    const bad = await run({ ...base, d: '2026/08/06' }, up, 120);
    return { maxd, short, sl, bad };
});
await browser.close();

ok('④ 🚨 抱滿 20 個交易日 → 要跳「抱滿」提醒(⛔ 原本完全不會叫)',
   R.maxd.some(t => /抱滿 20/.test(t)), R.maxd);
ok('④b 才抱 5 天 ⛔ 不可叫', !R.short.some(t => /抱滿 20/.test(t)), R.short);
ok('④c 🚨 跌破停損時只能喊停損(⛔ 同一輪不可三種一起響)',
   R.sl.length === 1 && /停損/.test(R.sl[0]), R.sl);
ok('④d ⚠️ 記錄日期格式不同時,寧可不叫也不可亂叫',
   !R.bad.some(t => /抱滿 20/.test(t)), R.bad);
ok('⑥ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PBEXIT3_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
