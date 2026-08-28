#!/usr/bin/env node
/**
 * 📊 驗證過的成績表 + 🏆 A 級訊號分級(V73.9.8)測試
 *
 * 使用者:「把驗證過的勝率寫起來,這樣才不用一直問你,還有遇到高勝率值得買的訊號
 *          要跳出訊息告訴我,並且說服投資者」。
 *
 * ⚠️⚠️ 「說服」刻意做成**給足證據讓他自己信得過**,⛔ 不是寫煽動文案 ——
 *    那違反本專案所有鐵則(要配樣本、要有對照組、要講限制),
 *    而且會害使用者在空頭重壓(回測窗口沒有一年是空頭)。
 *
 * ⛔ 這支要釘死的八件事:
 *   ① 成績表的數字要跟 CLAUDE.md 記錄的實測值**完全一致**(⛔ 不可憑印象填)。
 *   ② 🚨 一定要同時出現「勝率高卻少賺」那組反例 —— 那是整段最重要的一句。
 *   ③ 基準勝率要寫 **36.4%** 而不是 50%,而且要講「沒扣滑價」「沒經歷空頭」。
 *   ④ A 級門檻**五關全部來自實測**,⛔ 不可自己訂一個好看的數字。
 *   ⑤ 樣本門檻要走 `_wrEnough`(⛔ 不可在這裡寫死 10)。
 *   ⑥ 沒過 A 級要**說得出卡在哪一關**(⛔ 只回 false 查不出原因)。
 *   ⑦ 🚨 ⛔ **不可新增第三種通知** —— 一天最多 2 檔是實測上限,再多會被關掉。
 *   ⑧ A 級文案 ⛔ 不可寫成「保證/一定會賺/穩賺」。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ⑦ ⛔ 不可新增第三種通知:買點通知的 _fireAlert 呼叫仍然只有一處
{
    const i = src.indexOf('async _eodTriggerSweep()');
    const j = src.indexOf('_pbRecordFire(sym, key', i);
    const blk = (i > 0 && j > i) ? src.slice(i, j) : '';
    ok('🚧 空過守門:抓得到尾盤推播那段', blk.length > 500, blk.length);
    ok('⑦ 🚨 ⛔ 不可新增第三種通知(買點推播仍只呼叫一次 _fireAlert)',
       (blk.match(/this\._fireAlert\(/g) || []).length === 1,
       (blk.match(/this\._fireAlert\(/g) || []).length);
    ok('⑦b 一天最多 2 檔的上限還在', /_pushed >= 2/.test(blk));
    ok('④b A 級是**升級既有通知**而不是另發一則', /_g\.top \?/.test(blk));
}
ok('⑤ 樣本門檻走 `_wrEnough`(⛔ 不可在分級裡寫死 10)',
   /_wrEnough \? this\._wrEnough\(n\)/.test(src));
ok('④ 勝率門檻用實測基準(⛔ 不是 50%)', /winBase \?\? 36\.4/.test(src));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._pbGrade && !!app._verifiedEdgeHtml, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const E = app._VERIFIED_EDGE;
    const html = app._verifiedEdgeHtml();
    const d = document.createElement('div'); d.innerHTML = html;
    const txt = (d.innerText || d.textContent || '').replace(/\s+/g, '');
    const good = { s: '1', k: 'x', w: 64.3, po: 4.13, lb: 2.1, n: 14, hq: 1 };
    return {
        E, html, txt,
        good: app._pbGrade(good),
        noHq: app._pbGrade({ ...good, hq: 0 }),
        fewN: app._pbGrade({ ...good, n: 8 }),
        negLb: app._pbGrade({ ...good, lb: -0.3 }),
        lowPo: app._pbGrade({ ...good, po: 1.4 }),
        lowWr: app._pbGrade({ ...good, w: 30 }),
    };
});
await browser.close();

// ① 數字要跟實測一致
const V = R.E;
ok('① 36 個月:🧬 現行配置 = +2,896,478', V.long[0].pl === 2896478, V.long[0]);
ok('①b 36 個月:不挑 🧬 = +1,260,926,而 0050 = +2,011,700(⭐ 所以不挑會輸)',
   V.long[2].pl === 1260926 && V.long[1].pl === 2011700 && V.long[2].pl < V.long[1].pl,
   [V.long[1].pl, V.long[2].pl]);
ok('①c 原版 +1,361,088 / 勝率 33.2%', V.vars[0].pl === 1361088 && V.vars[0].wr === 33.2, V.vars[0]);
ok('①d 🧬 +2,136,115 / 勝率 37.4% / 回撤 −9.35%',
   V.vars[1].pl === 2136115 && V.vars[1].wr === 37.4 && V.vars[1].dd === -9.35, V.vars[1]);
ok('①e 買點:隔天開盤 +818,734、跳空不追 −147,644(倒賠)',
   V.entry[1].pl === 818734 && V.entry[3].pl === -147644, V.entry);
ok('①f 已測 86 種、採用 2 種', V.base.n === 86 && V.base.adopted === 2, V.base);

// ② 🚨 反例一定要在
ok('② 🚨 要出現「勝率高卻少賺」那組反例(💧 成交值 ≥1 億)',
   V.vars.some(r => r.wr === 36.6 && r.pl === 1053560 && r.pl < V.vars[0].pl), V.vars);
ok('②b 文案要明講「提高勝率不是對的目標」',
   /「提高勝率」不是對的目標|提高勝率.{0,4}不是對的目標/.test(R.html), R.txt.slice(0, 160));
ok('②c 勝率最高那組(44.2%)要標「只做 52 次」',
   V.vars.some(r => r.wr === 44.2 && r.n === 52) && /52次/.test(R.txt), R.txt.slice(-200));

// ③ 三個限制
ok('③ 基準勝率寫 36.4%(⛔ 不是 50%)', V.base.winBase === 36.4 && /36\.4%/.test(R.txt));
ok('③b 要講「沒扣滑價」', /沒扣.{0,2}滑價|沒扣滑價/.test(R.txt), R.txt.slice(-260));
ok('③c 🚨 要講「期間沒有一年是空頭」', /沒有一年是空頭/.test(R.txt), R.txt.slice(-260));

// ④⑥ 分級
ok('④c 五關全過 → A 級', R.good.top === true, R.good);
for (const [k, label] of [['noHq', '🧬'], ['fewN', '樣本'], ['negLb', '期望值'], ['lowPo', '賺賠比'], ['lowWr', '勝率']]) {
    ok(`④d 缺「${label}」→ ⛔ 不可判 A 級`, R[k].top === false, [k, R[k]]);
}
ok('⑥ 🔍 沒過要說得出卡在哪一關(⛔ 不可只回 false)',
   R.noHq.miss.length >= 1 && /強勢高波動/.test(R.noHq.miss.join('')), R.noHq.miss);
ok('⑥b 樣本不足時要講出實際次數', /8 次/.test(R.fewN.miss.join('')), R.fewN.miss);

// ⑧ ⛔ 不可寫成保證
{
    const i = src.indexOf('🏆 A 級買點成立');
    const blk = src.slice(i, i + 1400);
    ok('⑧ 🚨 A 級文案 ⛔ 不可出現保證/穩賺字樣',
       !/保證會賺|穩賺|一定會漲|必賺/.test(blk), blk.slice(0, 200));
    ok('⑧b 而且要主動講限制(基準不是 50% + 沒經歷空頭)',
       /不等於會賺/.test(blk) && /空頭/.test(blk), blk.slice(0, 400));
}
ok('⑨ 已接進會賺訊號清單', /\$\{this\._verifiedEdgeHtml\(\)\}/.test(src));
ok('⑩ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ VERIFIED_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
