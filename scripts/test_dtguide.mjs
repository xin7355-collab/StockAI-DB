#!/usr/bin/env node
/**
 * 📖 當沖注意事項(V73.7.2)測試
 *
 * 使用者:「簡化精簡再說明裡面清楚明瞭…用最直接的方式直接告訴使用者怎麼操作」
 *        「如果有雜訊沒有用的策略直接刪除沒關係」
 *
 * ⛔ 這支釘住的核心原則:**這份說明裡只准出現兩種東西**
 *   (a) 算術事實(不需驗證就成立:成本、平倉時間)
 *   (b) 本站實測過的(一律附數字)
 *   ⛔ 沒有實證來源的具體門檻(「量能≥80%」「跌破 VWAP 或 −1.5% 立刻砍」
 *      「賺 2~3% 先落袋一半」「三條件對齊才進」)一律不可再出現 ——
 *      留著會讓使用者以為那是驗證過的規則。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._dtBeginnerGuide, null, { timeout: 25000 });

const T = await page.evaluate(() => (app._dtBeginnerGuide() || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' '));

// ── ⛔ 沒有實證來源的門檻,一律不可再出現 ──
{
    const banned = [
        ['量能≥80%', /量能\s*[≥>]\s*80/],
        ['跌破 VWAP 或 −1.5% 立刻砍', /−1\.5%|-1\.5%\s*立刻砍/],
        ['賺 2~3% 先落袋一半', /賺\s*2~3%.*落袋/],
        ['三條件對齊才進', /三條件對齊/],
        ['單筆虧損上限=本金1%', /本金\s*1%/],
        ['當沖 90% 散戶長期虧損', /90%\s*散戶/],
    ];
    for (const [name, re] of banned) ok(`⛔ 不可再出現沒實證的「${name}」`, !re.test(T), T.slice(0, 120));
}

// ── ⭐ 必須留下的:算術事實 ──
ok('① 成本關卡(算術)要在', /成本關/.test(T) && /跳一檔/.test(T) && /回本/.test(T), T.slice(0, 100));
ok('①b 流動性關要在', /流動性關/.test(T), '');
ok('②a 停損:重點是「到價就執行」而不是設在哪',
   /到價就執行|設了就執行/.test(T) && /價位你自己定/.test(T), '');
ok('②b 13:25 前平倉(算術事實)', /13:25/.test(T) && /平倉/.test(T), '');
ok('②c 看不懂就不做', /看不懂就不做/.test(T), '');

// ── ⭐ 實測不成立清單:必須附數字(⛔ 不可只寫「沒用」)──
{
    ok('③ 連量:要附 +0.14pp 與 18~32% / 49~52%',
       /\+0\.14pp/.test(T) && /18~32%/.test(T) && /49~52%/.test(T), '');
    ok('③b 開盤跳空:要附 −1.63% 與「單調」', /−1\.63%/.test(T) && /單調/.test(T), '');
    ok('③c ORB:要說明是「扣掉來回成本 0.25% 後」沒有一組正的',
       /ORB/.test(T) && /0\.25%/.test(T), '');
    ok('③d 順大盤 80%:要說「沒有實證」且是「取捨不是變強」',
       /沒有任何實證/.test(T) && /取捨不是變強/.test(T), '');
    ok('③e ⭐ 要說明為什麼寫出來(省掉去別處學了再回來問)',
       /去別處學/.test(T), '');
}

// ── ⭐ 勝率三鐵則 ──
ok('④ 基準不是 50%,而且要附四檔實測基準',
   /基準不是 50%/.test(T) && /0050/.test(T) && /3231/.test(T), '');
ok('④b 樣本不到 10 次不算數', /不到 10 次/.test(T), '');

// ── 即時性 ──
ok('⑤ 下單那刻只看即時價', /下單那一刻只看/.test(T), '');

// ── 精簡度:段落數與長度 ──
{
    const segs = (T.match(/[①②③④⑤]/g) || []).length;
    ok('📏 分成 5 段、每段有編號(⛔ 不可再是一大坨)', segs >= 5, `找到 ${segs} 個編號`);
    ok('📏b 總長度不可膨脹(≤ 1600 字)', T.length <= 1600, `${T.length} 字`);
}
ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ DTGUIDE_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
