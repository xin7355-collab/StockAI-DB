#!/usr/bin/env node
/**
 * 🧭 「這幾週誰在收、誰在放」(V72.5.2)測試
 *
 * 來源:使用者貼了一份 Gemini 說明(集保四象限矩陣 / 隱藏大戶扣抵),問「怎麼運用、能不能圖表化」。
 *
 * ⛔ 這支最重要的任務是**擋住一件事**:把它寫成多空訊號。
 *    `tdcc_matrix_probe.py` 拿 **104 週深歷史、28,532 筆事件**實測過那套四象限:
 *      大戶↑人數↓ 60日 +1.04pp ・大戶↓人數↑ +0.92pp ・大戶↑人數↑ +0.14pp ・大戶↓人數↓ **+1.81pp**
 *    → 它說「偏多」跟「偏空」的兩格只差 0.12pp;它說最差的那格反而最好;
 *      **交互作用全部是負的**(−0.06 ~ −1.23pp)= 交叉之後比兩條腿各自相加還差。
 *    所以這張圖只准做**事實描述**,⛔ 不准出現偏多/偏空/進場/出場。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._tdccWhoIsBuyingHtml, null, { timeout: 20000 });

const run = (b, r) => page.evaluate(a => app._tdccWhoIsBuyingHtml(a.b, a.r), { b, r });

// ── ① 守門:資料不夠 / 長度不符 → 完全不顯(⛔ 不留空殼)────────────
ok('① null → 空字串', (await run(null, null)) === '');
ok('① 只有 2 週 → 空字串', (await run([1, 2], [1, 2])) === '');
ok('① ⭐ 兩條長度不符 → 空字串(⛔ 錯位比不顯更糟)', (await run([1, 2, 3, 4], [1, 2])) === '');

// ── ② 四種情境都要講對「誰在收、誰在放」──────────────────────
const UP = [60.0, 60.2, 60.5, 60.9, 61.2, 61.4], DNR = [5.4, 5.3, 5.2, 5.0, 4.8, 4.7];
const DN = [61.4, 61.0, 60.5, 60.1, 59.7, 59.3], UPR = [4.7, 4.9, 5.1, 5.4, 5.6, 5.9];
const cases = [
    ['大戶增·散戶減', UP, DNR, /往大戶那邊集中/],
    ['大戶減·散戶增', DN, UPR, /從大戶流向散戶/],
    ['兩邊同時增', UP, UPR, /同時增加/],
    ['兩邊同時減', DN, DNR, /同時減少/],
    ['幾乎沒變', [60, 60.05, 60, 59.98, 60.02, 60], [5, 5, 5.01, 5, 4.99, 5], /變化不大/],
];
const htmls = [];
for (const [nm, b, r, re] of cases) {
    const h = await run(b, r);
    htmls.push([nm, h]);
    ok(`② ${nm} → 判讀正確`, re.test(txt(h)), txt(h).slice(0, 200));
}

// ── ③ ⛔⛔ 任何一種情境都不可出現多空/操作字眼(實測沒有鑑別力)────────
//    ⚠️ 先 strip 掉否定形 —— 免責句本身含「偏多/偏空/買賣訊號」那幾個字
//       (本專案已踩過 6 次:正確的免責寫法被自己的測試擋下來)。
const strip = s => s.replace(/⛔[^。]*/g, '').replace(/不是[^。]*/g, '').replace(/不能[^。]*/g, '')
                    .replace(/實測過「[^」]*」/g, '').replace(/幾乎一樣[^。]*/g, '');
for (const [nm, h] of htmls) {
    const t = strip(txt(h));
    ok(`③ ⛔ ${nm} 不可講偏多/偏空`, !/(偏多|偏空|看多|看空)/.test(t), t.slice(0, 220));
    ok(`③ ⛔ ${nm} 不可給操作指令`, !/(買進|進場|加碼|出場|停損|可以追|該賣)/.test(t), t.slice(0, 220));
}

// ── ④ 實測免責必須留在卡上(⛔ 別為了好看拿掉)────────────────────
const t0 = txt(htmls[0][1]);
ok('④ ⭐ 要寫「現況描述,不是買賣訊號」', /現況描述/.test(t0) && /不是.{0,4}買賣訊號/.test(t0), t0.slice(-320));
ok('④ ⭐ 要端出實測樣本數(104 週 / 28,532 筆)', /104 週/.test(t0) && /28,532/.test(t0), t0.slice(-320));
ok('④ ⭐ 要說「四種組合後續表現幾乎一樣」', /四種組合.{0,8}幾乎一樣/.test(t0), t0.slice(-320));

// ── ⑤ 數字要對:起訖值與變化量 ────────────────────────────────
// ⚠️ 去標籤後 `<b>` 會留下一個空白(60.0→ 61.4),所以箭頭後面要允許空白 —— ⛔ 別因此把斷言放寬成只比數字
ok('⑤ 大戶 60.0→61.4 +1.4%', /60\.0→\s*61\.4/.test(t0) && /\+1\.4%/.test(t0), t0.slice(0, 240));
ok('⑤ 散戶 5.4→4.7 −0.7%', /5\.4→\s*4\.7/.test(t0) && /-0\.7%/.test(t0), t0.slice(0, 240));
ok('⑤ 週數要寫出來(6 週)', /這 6 週/.test(t0), t0.slice(0, 120));

// ── ⑥ 兩排 bar 數量要等於週數(⛔ 不可截斷)─────────────────────
const bars = await page.evaluate(a => {
    const d = document.createElement('div');
    d.innerHTML = app._tdccWhoIsBuyingHtml(a.b, a.r);
    return [...d.querySelectorAll('.grid')].map(g => g.children.length);
}, { b: UP, r: DNR });
ok('⑥ 兩排各 6 根 bar', bars.length === 2 && bars.every(x => x === 6), JSON.stringify(bars));

// ── ⑦ 已接進集保分佈卡(⛔ 沒開新卡)────────────────────────────
const wired = await page.evaluate(() => ({
    called: /_tdccWhoIsBuyingHtml\(histArr, retArr\)/.test(app._renderChipDistribution.toString()),
    ret: /retArr = tdH\.map/.test(app._renderChipDistribution.toString()),
}));
ok('⑦ ⭐ 集保分佈卡有呼叫它(不是死碼)', wired.called, '');
ok('⑦ ⭐ 散戶% 歷史有被收集(retArr)', wired.ret, '');

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:\n - ${fails.join('\n - ')}` : '\n✅ TDCCWHO_TEST_PASS');
process.exit(fails.length ? 1 : 0);
