#!/usr/bin/env node
/**
 * 📱 V80.0.8 庫存「手動新增」視窗與「編輯庫存 → 🎯 賣出」面板的手機版面(使用者兩張 iPhone 截圖)
 *   ① 兩個視窗裡每個輸入框 ≥16px(iOS 字小於 16px 一點就整頁放大 → 左邊被切掉)
 *   ② 輸入框深色底 + color-scheme dark(⛔ iOS 白底 / 淺灰底配白字)
 *   ③ 代號建議清單 / 視窗本體 ⛔ 被全站去框規則(V77.0.0)拉成透明、左右清成 0(.keepbox)
 *      代號建議清單跟著版面往下排(⛔ absolute 疊在底下那幾列上)
 *   ④ 股數還沒填 ⛔ 寫「= 0 張」;填 1000 → 「= 1 張」
 *   ⑤ 賣出面板三格(含賣出日)右緣不超出面板 / 390
 *   ⑥ 編輯頁頂列讓開瀏海(safe-area)
 *   ⑦ 整頁沒有橫向捲動
 * ⚠️ iOS 的自動放大與原生日期框在 Chromium 重現不了 → 這支只釘得住條件(字級 / 深色 / 不溢出)。
 * 注入:INV_SRC=<改過的 index.html> 必須紅。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.INV_SRC || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails++; };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + FILE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);
const shim = await page.evaluate(rwdShim);
ok('⓪ 版面 shim 全部生效', !shim || !shim.length || (Array.isArray(shim) ? shim.length === 0 : true), JSON.stringify(shim));

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const o = {};
    A.inventory = [{ symbol: '2330', cost: 1000, shares: 1, buyDate: '2026-07-02', currentPrice: 1100 }];
    try { localStorage.setItem('proTerminalInv', JSON.stringify(A.inventory)); } catch (_) {}
    A.allStockList = A.allStockList && A.allStockList.length ? A.allStockList
        : [{ stock_id: '3303', stock_name: '岱稜' }, { stock_id: '3305', stock_name: '昇貿' }, { stock_id: '3306', stock_name: '鼎天' }];
    const inpInfo = sel => [...document.querySelectorAll(sel + ' input')].map(i => {
        const cs = getComputedStyle(i);
        return { t: i.type, fs: parseFloat(cs.fontSize), bg: cs.backgroundColor, cs: cs.colorScheme };
    });
    // 編輯頁
    A.openInventoryEditPage();
    await sleep(200);
    const head = document.querySelector('#inventoryEditPageModal [data-invedithead]');
    o.head = head ? head.getAttribute('style') || '' : '';
    A._invSellOpen(0);
    await sleep(200);
    o.editInp = inpInfo('#inventoryEditPageModal');
    const panel = document.querySelector('[data-sellpanel="0"]');
    if (panel) {
        const pr = panel.getBoundingClientRect();
        o.panelR = pr.right;
        o.sellR = [...panel.querySelectorAll('[data-sellf]')].map(i => ({ k: i.dataset.sellf, r: i.getBoundingClientRect().right, w: i.getBoundingClientRect().width }));
    }
    // 手動新增
    A._addEmptyInvEditDraft();
    await sleep(200);
    o.addInp = inpInfo('#invManualAddModal');
    o.hint0 = document.getElementById('manualLotHint')?.textContent || '';
    const si = document.getElementById('manualAddSymInput');
    si.value = '33'; A._onManualAddSymInput('33');
    await sleep(100);
    const dd = document.getElementById('manualAddSymDropdown');
    const dcs = getComputedStyle(dd);
    o.ddShown = dcs.display !== 'none' && dd.children.length > 0;
    o.ddPos = dcs.position;
    o.ddBg = dcs.backgroundColor;
    const ddR = dd.getBoundingClientRect();
    const btn = [...document.querySelectorAll('#invManualAddModal button')].find(b => b.textContent.trim() === '現股');
    o.ddBottom = ddR.bottom; o.btnTop = btn ? btn.getBoundingClientRect().top : -1;
    const box = document.querySelector('#invManualAddModal > div');
    const bcs = getComputedStyle(box);
    o.boxBg = bcs.backgroundColor; o.boxPl = parseFloat(bcs.paddingLeft);
    o.addOverflow = box ? box.scrollWidth - box.clientWidth : 99;
    A._adjManualShares(1000);
    o.hint1 = document.getElementById('manualLotHint')?.textContent || '';
    window.scrollTo(80, 0);
    o.sx = window.scrollX;
    return o;
});

const all = [...(R.editInp || []), ...(R.addInp || [])];
ok('① 兩個視窗的輸入框都 ≥16px', all.length >= 6 && all.every(i => i.fs >= 16), JSON.stringify(all.filter(i => i.fs < 16)));
const white = /rgba?\(255, 255, 255|rgb\(2[0-4]\d, 2[0-4]\d, 2[0-4]\d/;
ok('② 輸入框深色底 + color-scheme dark', all.every(i => !white.test(i.bg) && /dark/.test(i.cs)), JSON.stringify(all.filter(i => white.test(i.bg) || !/dark/.test(i.cs))));
ok('③a 打代號有建議清單', R.ddShown, JSON.stringify(R));
ok('③b 清單跟著版面排(⛔ absolute 疊在別列上)', R.ddPos === 'static', R.ddPos);
ok('③c 清單底色不透明', /rgb\(13, 17, 23\)/.test(R.ddBg), R.ddBg);
ok('③d 清單沒有壓到「現股」那列', R.btnTop >= R.ddBottom - 1, `清單底 ${R.ddBottom} / 現股 ${R.btnTop}`);
ok('③e 手動新增視窗沒有橫向溢出', R.addOverflow <= 1, R.addOverflow);
ok('③f 視窗本體不透明(⛔ 被全站去框規則拉成透明)', /rgb\(22, 27, 34\)/.test(R.boxBg), R.boxBg);
ok('③g 視窗左右留邊(⛔ 被去框規則清成 0 → 字貼邊被切)', R.boxPl >= 12, R.boxPl);
ok('④a 股數還沒填 ⛔「= 0 張」', !/=\s*0\s*張/.test(R.hint0) && /1000 股/.test(R.hint0), R.hint0);
ok('④b 填 1000 → = 1 張', /=\s*1\s*張/.test(R.hint1), R.hint1);
ok('⑤ 賣出面板三格不超出面板 / 390', (R.sellR || []).length === 3 && R.sellR.every(x => x.r <= R.panelR + 0.5 && x.r <= 390), JSON.stringify(R.sellR) + ' panel ' + R.panelR);
ok('⑤b 賣出日自己一整行(16px 日期要放得下,⛔ 擠成三分之一被切)', ((R.sellR || []).find(x => x.k === 'date') || {}).w >= 250, JSON.stringify(R.sellR));
ok('⑥ 編輯頁頂列讓開瀏海', /safe-area-inset-top/.test(R.head), R.head);
ok('⑦ 整頁沒有橫向捲動', R.sx <= 2, R.sx);
ok('⑧ 沒有頁面錯誤', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
