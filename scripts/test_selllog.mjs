#!/usr/bin/env node
/**
 * 🎯 V78.5.7 賣出改在「編輯庫存」裡記(勝率鏡子)
 *
 * 使用者:「原本在個股附近點選賣出價格,很難按,請改在編輯庫存裡面」。
 * ⛔ 釘死:
 *   ① 編輯庫存每一列都有 🎯 賣出鈕,而且按得到(高度 ≥ 36px)
 *   ② 填賣價 / 股數 → 日誌一筆、損益 == _netPL(已扣費稅)、庫存扣股數、別檔不動
 *   ③ 全賣 → 那檔從庫存消失
 *   ④ ⭐ 決定性對照:草稿裡先刪掉別列再賣,仍賣到對的那一檔(_oi)
 *   ⑤ 舊入口(⋯ → 結算平倉)打開同一塊面板;全檔只有一處寫交易日誌
 *   ⑥ 鏡子把舊的毛利紀錄也換成淨損益
 * 注入:SELL_SRC=<改過的 index.html> 跑一次必須紅。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.SELL_SRC || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(FILE, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails++; };

// ⑤b 靜態:全檔只有一處把交易日誌寫回去
const writes = (SRC.match(/setItem\(\s*'proTerminalTradeLog'/g) || []).length;
ok('⑤b 全檔只有一處寫交易日誌(⛔ 不留第二份賣出程式)', writes === 1, `寫入點 ${writes} 處`);

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

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const o = {};
    const seed = () => {
        A.inventory = [
            { symbol: '0050', cost: 93.7, shares: 0.5, buyDate: '2026-07-29', currentPrice: 95 },
            { symbol: '5483', cost: 224.47, shares: 1, buyDate: '2026-07-02', currentPrice: 225.5 },
        ];
        localStorage.setItem('proTerminalInv', JSON.stringify(A.inventory));
        localStorage.removeItem('proTerminalTradeLog');
    };
    const fill = (idx, price, shares) => {
        const p = document.querySelector(`[data-sellpanel="${idx}"]`);
        if (!p) return false;
        const set = (k, v) => { const el = p.querySelector(`[data-sellf="${k}"]`); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('price', price); set('shares', shares); set('date', '2026-10-07');
        return true;
    };
    const confirmBtn = idx => [...document.querySelectorAll(`[data-sellpanel="${idx}"] button`)].find(b => /記入勝率鏡子/.test(b.textContent));
    const log = () => { try { return JSON.parse(localStorage.getItem('proTerminalTradeLog') || '[]'); } catch (_) { return []; } };

    // ── ①② 部分賣出 ──
    seed();
    A.openInventoryEditPage(); await sleep(50);
    const btn = document.querySelector('[data-sellbtn="1"]');
    o.btnH = btn ? btn.getBoundingClientRect().height : 0;
    o.btnCount = document.querySelectorAll('[data-sellbtn]').length;
    btn && btn.click(); await sleep(50);
    o.panel = !!document.querySelector('[data-sellpanel="1"]');
    o.defPrice = document.querySelector('[data-sellpanel="1"] [data-sellf="price"]')?.value;
    fill(1, 230, 500); await sleep(20);
    o.preview = document.querySelector('[data-sellpanel="1"] [data-sellprev]')?.innerText || '';
    confirmBtn(1)?.click(); await sleep(50);
    const L1 = log();
    o.n1 = L1.length; o.e1 = L1[0] || {};
    o.expect1 = A._netPL(224.47, 230, 500);
    o.inv1 = JSON.parse(localStorage.getItem('proTerminalInv'));
    o.mirrorBtn = (A._tradeMirrorBtnHtml() || '').replace(/<[^>]+>/g, ' ');
    o.draftShares = (A._invEditDraft || []).find(x => x.symbol === '5483')?.shares;
    A.closeInventoryEditPage();

    // ── ③ 全賣 ──
    seed();
    A.openInventoryEditPage(); await sleep(30);
    A._invSellOpen(1); await sleep(30);
    fill(1, 220, 1000); confirmBtn(1)?.click(); await sleep(50);
    o.inv3 = JSON.parse(localStorage.getItem('proTerminalInv')).map(x => x.symbol);
    o.e3 = log()[0] || {};
    A.closeInventoryEditPage();

    // ── ④ 草稿先刪 0050(沒儲存)再賣 5483 → 5483 變 idx0 ──
    seed();
    A.openInventoryEditPage(); await sleep(30);
    A._invEditDraft.splice(0, 1);
    A._renderInventoryEditPage(document.getElementById('inventoryEditPageModal'));
    A._invSellOpen(0); await sleep(30);
    fill(0, 230, 1000); confirmBtn(0)?.click(); await sleep(50);
    o.inv4 = JSON.parse(localStorage.getItem('proTerminalInv')).map(x => x.symbol);
    o.e4sym = (log()[0] || {}).symbol;
    A.closeInventoryEditPage();

    // ── ⑤ 舊入口 ──
    seed();
    A.settleInventory(1); await sleep(50);
    const m = document.getElementById('inventoryEditPageModal');
    o.oldOpen = !!m && m.style.display !== 'none' && !!document.querySelector('[data-sellpanel="1"]');
    o.oldNoWrite = log().length === 0;
    A.closeInventoryEditPage();

    // ── ⑥ 舊毛利紀錄 → 淨損益 ──
    localStorage.setItem('proTerminalTradeLog', JSON.stringify([{ symbol: '2330', cost: 100, sellPrice: 110, shares: 1, pnlNTD: 10000, pnlPct: 10 }]));
    o.netOld = A._tradeLogNet()[0].pnlNTD;
    o.netOldExp = A._netPL(100, 110, 1000);
    // 缺欄位的舊紀錄退回原值
    localStorage.setItem('proTerminalTradeLog', JSON.stringify([{ symbol: '2330', pnlNTD: 777, pnlPct: 1 }]));
    o.legacy = A._tradeLogNet()[0].pnlNTD;
    localStorage.removeItem('proTerminalTradeLog');
    return o;
});
await browser.close();

ok('① 每一列都有 🎯 賣出鈕', R.btnCount === 2, R.btnCount);
ok('①b 鈕夠大好按(高度 ≥ 36px,390 寬手機)', R.btnH >= 36, R.btnH);
ok('①c 點了在那一列底下展開面板,賣價預設現價', R.panel && +R.defPrice === 225.5, R.defPrice);
ok('②a 預覽寫出淨損益金額(已扣費稅)', /元/.test(R.preview) && /已扣/.test(R.preview), R.preview);
ok('②b 日誌多 1 筆', R.n1 === 1, R.n1);
ok('②c ⭐ 損益 == _netPL(224.47, 230, 500 股)(⛔ 不是毛利)', R.e1.pnlNTD === R.expect1 && R.e1.pnlNTD !== Math.round((230 - 224.47) * 500), `${R.e1.pnlNTD} vs ${R.expect1}`);
ok('②d 記下自己填的賣價 / 股數 / 日期 / 持有天數', R.e1.sellPrice === 230 && R.e1.shares === 0.5 && R.e1.date === '2026/10/07' && R.e1.holdDays === 97, JSON.stringify(R.e1));
ok('②e 庫存剩 500 股、成本不變;0050 不動', R.inv1.find(x => x.symbol === '5483')?.shares === 0.5 && R.inv1.find(x => x.symbol === '5483')?.cost === 224.47 && R.inv1.find(x => x.symbol === '0050')?.shares === 0.5, JSON.stringify(R.inv1));
ok('②f 草稿也跟著變(畫面上看到剩 500 股)', R.draftShares === 0.5, R.draftShares);
ok('②g 勝率鏡子那顆鈕變成「1 筆」', /1 筆/.test(R.mirrorBtn), R.mirrorBtn);
ok('②h 存進去的庫存沒有夾帶 _oi', !JSON.stringify(R.inv1).includes('_oi'), JSON.stringify(R.inv1));
ok('③ 全賣 → 那檔從庫存消失', R.inv3.length === 1 && R.inv3[0] === '0050' && R.e3.symbol === '5483', JSON.stringify(R.inv3));
ok('④ ⭐ 草稿刪掉別列後賣,仍賣到對的那一檔(_oi 決定性對照)', R.e4sym === '5483' && R.inv4.length === 1 && R.inv4[0] === '0050', `${R.e4sym} / ${JSON.stringify(R.inv4)}`);
ok('⑤ 舊入口(⋯ → 結算平倉)打開同一塊面板,而且⛔ 不會直接寫日誌', R.oldOpen && R.oldNoWrite, JSON.stringify({ o: R.oldOpen, w: R.oldNoWrite }));
ok('⑥ 舊的毛利紀錄在鏡子裡換成淨損益', R.netOld === R.netOldExp && R.netOld < 10000, `${R.netOld} vs ${R.netOldExp}`);
ok('⑥b 缺欄位的舊紀錄退回原本的數字', R.legacy === 777, R.legacy);
ok('⑦ 無 pageerror', errs.length === 0, errs.join(' | '));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ SELLLOG_PASS(全部通過)');
process.exit(fails ? 1 : 0);
