#!/usr/bin/env node
/**
 * 🌅 V74.5.6 盤前體檢「這份資料是不是今天的」守門
 *
 * 🚨 使用者回報「盤前體檢壞掉了」。實測 gh-pages 的 `macro_risk.json` 停在 **08-30**,
 *    而畫面照樣把它渲染成「今日開盤預判 50/100」——
 *    這是陷阱 #34:**顯示一個不該相信的數字,比空白更危險**。
 *    真因在採礦端(見 scripts/test_macro_bsi.py),但前端也不該裸奔。
 *
 * ⛔ 釘死四件事:
 *   ① 門檻用「**平日**天數」不用小時、也不用日曆天
 *      —— 採礦是平日 16:30 那輪 → **週一早上最新的本來就是上週五**(日曆 3 天)= 正常。
 *      用小時會每個週一都誤報,而誤報會讓人養成忽略警告的習慣。
 *   ② 過期時要**整條警告**,而且說出停在哪一天、幾個交易日沒更新
 *   ③ 大字結論的標題要**改口**(⛔ 不可再叫「今日開盤預判」)
 *   ④ 新鮮時⛔ 不可誤傷(不顯示任何警告、標題維持「今日開盤預判」)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails++; };

ok('⓪ 全 App 只有一支判斷點 `_macroFresh`(⛔ 別在顯示端各判一套)',
    (SRC.match(/_macroFresh\(todayISO\)\s*\{/g) || []).length === 1
    && (SRC.match(/this\._macroFresh\(/g) || []).length === 1);

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(() => {
    const A = window.app || app;
    const o = {};
    // 🚨 ⛔ 不可用「今天剛好是星期幾」來驗(那會變成一週紅兩天的假失敗)→ 自己造日期
    const wdBack = (n) => {          // 往回推 n 個**平日**,回傳 YYYY-MM-DD
        const d = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }) + 'T00:00:00Z');
        let left = n;
        while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); const w = d.getUTCDay(); if (w >= 1 && w <= 5) left--; }
        return d.toISOString().slice(0, 10);
    };
    const set = (dt) => { A._macroRiskCache = { ...(A._macroRiskCache || {}), updated: dt + ' 09:51 +0800' }; return A._macroFresh(); };
    o.today = A._macroFresh.call({ _macroRiskCache: { updated: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }) + ' 09:00' }, _macroFresh: A._macroFresh });
    o.w1 = set(wdBack(1));            // 昨天那個交易日 → 正常(收盤後採礦本來就這樣)
    o.w2 = set(wdBack(2));            // 2 個平日 → 仍算正常(留給連假 1 天)
    o.w4 = set(wdBack(4));            // 4 個平日 → 這就是使用者遇到的那種(停產)
    o.noDate = A._macroFresh.call({ _macroRiskCache: { updated: '' }, _macroFresh: A._macroFresh });
    // 🚨 週末那條規則**一定要用寫死的日期驗** —— 用「今天」的話只有星期一驗得到,
    //    其餘六天是假綠燈(第一次注入驗證就是這樣漏掉的)。
    //    2026-08-28 是星期五、2026-08-31 是星期一 → 日曆 3 天,但**平日只隔 1 天** = 正常。
    const at = (upd, today) => A._macroFresh.call(
        { _macroRiskCache: { updated: upd + ' 16:40' }, _macroFresh: A._macroFresh }, today);
    o.monVsFri = at('2026-08-28', '2026-08-31');     // 週一早上看週五的 → ⛔ 不可報
    o.thuVsSun = at('2026-08-30', '2026-09-03');     // 使用者遇到的那組(週日 → 週四)→ 一定要報
    return o;
});

ok('① 今天採的 → 新鮮', R.today.ok === true && R.today.wd === 0, JSON.stringify(R.today));
ok('①b 上一個交易日採的 → 仍算新鮮(⛔ 每個週一都誤報的話,警告就沒人看了)',
    R.w1.ok === true, JSON.stringify(R.w1));
ok('①c 隔 2 個平日 → 仍不報(留給國定假日,⛔ 誤報比漏報更傷)', R.w2.ok === true, JSON.stringify(R.w2));
ok('①d 🚨 隔 4 個平日 → 一定要報(使用者遇到的就是這種:停在 08-30、當天 09-03)',
    R.w4.ok === false && R.w4.wd >= 3, JSON.stringify(R.w4));
ok('①e 沒有日期就不判(⛔ 不硬報錯)', R.noDate.ok === true);
ok('①f 🚨 週一早上看到「上週五」⛔ 不可報(這條只有寫死日期才驗得到)',
    R.monVsFri.ok === true && R.monVsFri.wd === 1, JSON.stringify(R.monVsFri));
ok('①g 🚨 使用者那組(資料 08-30 / 當天 09-03)一定要報',
    R.thuVsSun.ok === false && R.thuVsSun.wd === 4, JSON.stringify(R.thuVsSun));

// ②③④ 渲染層接線(⛔ 只驗函式不夠 —— 算對了但沒接上等於沒修)
const brief = (SRC.match(/const _staleWarn = [\s\S]{0,900}?`;/) || [''])[0];
ok('② 過期時要說出「停在哪一天 + 幾個交易日沒更新」',
    /_mFresh\.date/.test(brief) && /_mFresh\.wd/.test(brief) && /個交易日沒更新/.test(brief), brief.slice(0, 200));
ok('②b 要講清楚「這是採礦端沒跑成功,不是你的設定問題」(⛔ 別讓使用者去翻自己的設定)',
    /採礦端沒跑成功/.test(brief));
ok('②c 🚨 要明說下面的數字都是那一天的、⛔ 不是今天的',
    /⛔ 不是今天的/.test(brief) && /先別照這張卡調部位/.test(brief));
ok('③ 大字結論標題會改口(⛔ 過期還叫「今日開盤預判」= 說謊)',
    /_mFresh\.ok \? '今日開盤預判' :/.test(SRC) && /那天的開盤預判\(不是今天\)/.test(SRC));
ok('③b 警告要插在標題列下方(跟「加權落後」同一區,而且排在它前面 —— 這條更嚴重)',
    SRC.indexOf('${_staleWarn}') > 0 && SRC.indexOf('${_staleWarn}') < SRC.indexOf('${_lagWarn}\n'));
ok('④ ⛔ 新鮮時整條不顯示(條件觸發,別留噪音)', /_mFresh\.ok \? '' :/.test(brief));
ok('④b ⛔ 不用紅綠 emoji(這是「資料新不新」不是漲跌方向)', !/[🔴🟢]/u.test(brief));

await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ MACROFRESH_PASS(全部通過)');
process.exit(fails ? 1 : 0);
