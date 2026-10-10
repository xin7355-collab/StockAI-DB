#!/usr/bin/env node
/**
 * 🎯 V79.0.8 決策台「今天可以買的」改成 👑 領頭羊那種表格(使用者:「今天可以買的介面我要跟領頭羊一樣」)
 *   ① 表頭可排序:排序鍵固定那四個;同一欄再點一次反向;換一欄用那一欄自己的預設方向
 *   ② 沒有觸發價的一律排最後(⛔ 不可被當成 0 排到最前面)
 *   ③ 每一列都可以點進個股頁(app.analyze)・每一列都有機率格(data-deckprob)
 *   ④ 標籤走共用的 `_pbTagsHtml`(⛔處置 / 🚧量薄)—— 決定性對照:換一檔沒處置的就不可亂標
 *   ⑤ 張數走 `_lotsForPlaybook`(⛔ 不另算)—— 決定性對照:把它換成假的,表格要跟著變
 *   ⑥ ⛔ 散戶 App 不放研究數字(期望值 / 勝率 / 回測)
 *   ⑦ renderDeck 真的用新表格(⛔ 不可留舊的一列一卡)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails++; };

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const rd = src.slice(src.indexOf('} else if (st.buy.length) {'), src.indexOf('} else if (st.finOn && st.finBlocked.length) {'));
ok('⑦0 空過守門:切得到 renderDeck 買進那一段', rd.length > 1000, rd.length);
ok('⑦ renderDeck 用新表格,⛔ 不再一列一卡', /this\._deckBuyTableHtml\(st\.buy, mine/.test(rd) && !/_pbRowHtml\(/.test(rd));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => { const m = String(e); if (!/echarts is not defined/.test(m)) errs.push(m); });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._lotsForPlaybook, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    A.attentionStatus = { '9001': { interval: 5, end_date: '2026-12-31' } };
    const L = [
        { s: '9001', c: 100, trig: 105, up: 5, stop: 95, hq: 1, k: '💪 招', w: 40, n: 30, exp: 2, lb: 1 },
        { s: '9002', c: 50, trig: 51, up: 2, stop: 47, hq: 1, k: '💪 招', w: 40, n: 30, exp: 2, lb: 1 },
        { s: '9003', c: 300, trig: null, up: null, stop: 280, hq: 1, k: '🌊 招', loose: 1, w: 40, n: 30, exp: 2, lb: 1 },
    ];
    const box = document.createElement('div'); document.body.appendChild(box);
    const paint = () => { box.innerHTML = A._deckBuyTableHtml(L, new Set(['9002'])); };
    const order = () => [...box.querySelectorAll('[data-deckbuyrow]')].map(e => e.getAttribute('data-deckbuyrow'));
    A._deckBuySort = null; paint();
    out.keys = [...box.querySelectorAll('[data-deckbuysort]')].map(e => e.getAttribute('data-deckbuysort'));
    out.def = order();
    out.analyze = [...box.querySelectorAll('[data-deckbuyrow]')].every(r => /app\.analyze\('\d+'\)/.test(r.innerHTML));
    out.prob = box.querySelectorAll('[data-deckprob]').length;
    out.html = box.innerHTML; out.txt = box.innerText;
    // 排序:觸發價(預設由大到小)→ 再點一次反向;null 一律最後
    const sortBy = k => { A.deckBuySortBy(k); const b = document.querySelector('[data-deckbuytbl]'); box.innerHTML = b ? b.outerHTML : box.innerHTML; };
    // deckBuySortBy 直接換掉頁面上那張表 → 測試用的 box 就是那張
    A._deckBuySort = null; paint();
    A.deckBuySortBy('trig'); out.trigDesc = order(); out.hdrDesc = (document.querySelector('[data-deckbuysort="trig"]') || {}).textContent;
    A.deckBuySortBy('trig'); out.trigAsc = order(); out.hdrAsc = (document.querySelector('[data-deckbuysort="trig"]') || {}).textContent;
    A.deckBuySortBy('c'); out.cSort = order();
    A._deckBuySort = null; paint();
    // 標籤:9001 處置 → 有;9002 沒有
    const rowH = s => (box.querySelector(`[data-deckbuyrow="${s}"]`) || {}).innerHTML || '';
    out.disp1 = /⛔處置/.test(rowH('9001')); out.disp2 = /⛔處置/.test(rowH('9002'));
    out.mine = /👜/.test(rowH('9002')) && !/👜/.test(rowH('9001'));
    // 決定性對照:張數一律來自 _lotsForPlaybook
    const bk = A._lotsForPlaybook;
    A._lotsForPlaybook = () => ({ acc: 1e6, shares: 7000, howTxt: '假張數 7 張', investAmt: 1, investPct: 1, maxLoss: 1, riskPct: 1 });
    paint(); out.fakeLots = (box.innerText.match(/假張數 7 張/g) || []).length;
    A._lotsForPlaybook = bk;
    // 沒填帳戶資金 → 提示只講一次(⛔ 不每一列重複)
    const acc0 = A.settings.accountSize; A.settings.accountSize = 0; paint();
    out.noAcc = { tip: box.querySelectorAll('[data-deckbuynoacc]').length, n: (box.innerText.match(/帳戶總資金/g) || []).length };
    A.settings.accountSize = 1000000; paint();
    out.withAcc = { tip: box.querySelectorAll('[data-deckbuynoacc]').length, amt: /停損時虧/.test(box.innerText) };
    A.settings.accountSize = acc0; paint();
    box.remove();
    return out;
});
ok('① 表頭排序鍵 = rank / c / trig / stop', JSON.stringify(R.keys) === JSON.stringify(['rank', 'c', 'trig', 'stop']), JSON.stringify(R.keys));
ok('①b 預設照名次', JSON.stringify(R.def) === JSON.stringify(['9001', '9002', '9003']), JSON.stringify(R.def));
ok('①c 點觸發價 → 由大到小,表頭標 ▼', JSON.stringify(R.trigDesc) === JSON.stringify(['9001', '9002', '9003']) && /▼/.test(R.hdrDesc), JSON.stringify([R.trigDesc, R.hdrDesc]));
ok('①d 再點一次 → 反向,表頭標 ▲', JSON.stringify(R.trigAsc) === JSON.stringify(['9002', '9001', '9003']) && /▲/.test(R.hdrAsc), JSON.stringify([R.trigAsc, R.hdrAsc]));
ok('② 沒有觸發價的那一檔兩個方向都排最後(⛔ 不當 0)', R.trigDesc[2] === '9003' && R.trigAsc[2] === '9003');
ok('①e 換一欄 → 用那一欄的預設方向(現價由大到小)', JSON.stringify(R.cSort) === JSON.stringify(['9003', '9001', '9002']), JSON.stringify(R.cSort));
ok('③ 每一列都點得進個股頁', R.analyze);
ok('③b 每一列都有機率格(data-deckprob)', R.prob === 3, R.prob);
ok('④ 處置股標 ⛔處置', R.disp1);
ok('④b 決定性對照:沒處置的⛔ 不可被標', !R.disp2);
ok('④c 你的庫存/自選標 👜(只有那一檔)', R.mine);
ok('⑤ 張數來自 _lotsForPlaybook(換假的,三列都跟著變)', R.fakeLots === 3, R.fakeLots);
ok('⑤c 沒填帳戶資金 → 提示只出現一次(⛔ 每列重複)', R.noAcc.tip === 1 && R.noAcc.n === 1, JSON.stringify(R.noAcc));
ok('⑤d 填了 → 不出現提示、每列寫停損時虧多少', R.withAcc.tip === 0 && R.withAcc.amt, JSON.stringify(R.withAcc));
ok('⑤b 沒有觸發價寫「盤中算」⛔ 不寫 null', /盤中算/.test(R.txt) && !/null|NaN|undefined/.test(R.txt), R.txt.slice(0, 200));
ok('⑥ ⛔ 不放研究數字(期望值 / 勝率 / 回測)', !/期望值|勝率|回測|實測/.test(R.txt), R.txt.slice(0, 200));
ok('⑥b ⛔ 不用紅綠燈號', !/[🔴🟢]/u.test(R.html));
ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ DECKBUYTBL_PASS');
process.exit(fails ? 1 : 0);
