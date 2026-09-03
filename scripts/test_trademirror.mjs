#!/usr/bin/env node
/**
 * 🪞 V74.5.6 勝率鏡子搬到「庫存股」標題列(懸浮視窗)
 *
 * 使用者:「勝率鏡子移到庫存股 📖 點看說明右手邊,變成點擊按鈕後才會跳出來的懸浮視窗」。
 * ⭐ 它本來就在庫存頁,但**在整份庫存清單的最下面** —— 持股一多就要捲很久,等於看不到。
 *
 * ⛔ 釘死五件事:
 *   ① 鈕在庫存股標題列、就在「📖 點看說明」右邊
 *   ② 鈕上要直接標「N 筆 · 勝率 X%」(⛔ 只寫「勝率鏡子」的話,使用者不知道有沒有東西可看)
 *   ③ 一筆都沒有時鈕**照顯示**(標「還沒紀錄」)—— 那正是要教他去結算平倉的時候
 *   ④ 內容一個字都沒改(勝率/賺賠比/總損益/賺短賠長診斷都還在)
 *   ⑤ ⛔ 舊的整張卡不可再留在庫存頁(不然又變成兩份)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails++; };

const h2 = (SRC.match(/<h2 onclick="alert\('💼 庫存股怎麼用[\s\S]*?<\/h2>/) || [''])[0];
ok('① 鈕在庫存股標題列裡', /tradeMirrorBtnSlot/.test(h2), h2.slice(0, 120));
ok('①b ⭐ 就在「📖 點看說明」**右邊**',
    h2.indexOf('📖 點看說明') > 0 && h2.indexOf('tradeMirrorBtnSlot') > h2.indexOf('📖 點看說明'));
ok('⑤ ⛔ 庫存頁不可再留舊的整張卡(否則變成兩份)', !/id="tradeJournalCard"/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const o = {};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // ── ③ 一筆都沒有 ──
    localStorage.removeItem('proTerminalTradeLog');
    A.renderTradeJournal();
    const slot = document.getElementById('tradeMirrorBtnSlot');
    o.emptyBtn = slot ? slot.innerText.replace(/\s+/g, ' ') : '';
    o.emptyBtnShown = !!(slot && slot.querySelector('button'));
    A._showTradeMirror(); await sleep(30);
    const m = document.getElementById('updateLogModal');
    o.emptyOpened = !m.classList.contains('hidden');
    o.emptyTxt = document.getElementById('updateLogBody').innerText.replace(/\s+/g, ' ');
    m.classList.add('hidden');

    // ── ②④ 有紀錄:3 勝 1 敗、而且「賺短賠長」 ──
    localStorage.setItem('proTerminalTradeLog', JSON.stringify([
        { symbol: '2330', name: '台積電', pnlNTD: 12000, pnlPct: 8.0, holdDays: 4, date: '2026-08-01' },
        { symbol: '2317', name: '鴻海',   pnlNTD: 5000,  pnlPct: 3.0, holdDays: 3, date: '2026-08-05' },
        { symbol: '2454', name: '聯發科', pnlNTD: 3000,  pnlPct: 2.0, holdDays: 5, date: '2026-08-09' },
        { symbol: '3231', name: '緯創',   pnlNTD: -9000, pnlPct: -6.0, holdDays: 30, date: '2026-08-12' },
    ]));
    A.renderTradeJournal();
    o.btn = document.getElementById('tradeMirrorBtnSlot').innerText.replace(/\s+/g, ' ');
    A._showTradeMirror(); await sleep(30);
    o.opened = !m.classList.contains('hidden');
    o.title = (document.getElementById('updateLogTitle') || {}).textContent || '';
    o.txt = document.getElementById('updateLogBody').innerText.replace(/\s+/g, ' ');
    o.html = document.getElementById('updateLogBody').innerHTML;
    return o;
});

ok('② 鈕上直接標「N 筆 · 勝率 X%」(⛔ 只寫名字的話不知道有沒有東西可看)',
    /勝率鏡子/.test(R.btn) && /4 筆/.test(R.btn) && /勝率 75%/.test(R.btn), R.btn);
ok('③ 一筆都沒有時鈕照顯示、標「還沒紀錄」(⛔ 不可整顆消失)',
    R.emptyBtnShown && /還沒紀錄/.test(R.emptyBtn), R.emptyBtn);
ok('③b 而且點開要教他怎麼產生第一筆(結算平倉)',
    R.emptyOpened && /結算平倉/.test(R.emptyTxt), R.emptyTxt.slice(0, 140));
ok('④ 點了開懸浮視窗、標題是勝率鏡子', R.opened && /勝率鏡子/.test(R.title), R.title);
ok('④b 內容還是完整的:勝率 / 賺賠比 / 總損益 三格都在',
    /勝率/.test(R.txt) && /賺賠比/.test(R.txt) && /總損益/.test(R.txt), R.txt.slice(0, 160));
ok('④c ⭐ 行為診斷還在(這份測資是「賺短賠長」:賺抱 4 天、賠凹 30 天)',
    /賺短賠長/.test(R.txt), R.txt.slice(0, 240));
ok('④d 數字是真的算出來的(3 勝 1 敗 → 勝率 75%、總損益 +11,000)',
    /75%/.test(R.txt) && /\+11,000/.test(R.txt), R.txt.slice(0, 200));
ok('④e 🚧 空過守門:內容夠長(⛔ 不是渲染出一個空殼)', R.txt.length > 150, R.txt.length);
ok('⑥ ⛔ 這頁不給買賣價位(它照的是你自己,不是訊號)',
    !/(進場價|買點|目標價|停損價)/.test(R.txt), R.txt.slice(0, 150));

await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ TRADEMIRROR_PASS(全部通過)');
process.exit(fails ? 1 : 0);
