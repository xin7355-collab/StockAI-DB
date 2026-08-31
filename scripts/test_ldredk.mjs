#!/usr/bin/env node
/**
 * 🕯️ V74.4.4 「跌停後的第一根紅K」落地測試(`_ldRedKHtml` / `_fillLdMkt` / `_ensureTwiiChgMap`)
 *
 * 這條是 streak_probe 六關全過的型態,但落地最怕三件事,全部釘死:
 *   ① 定義跟探針**一字不差**:跌停 = ≤−9.2%、紅K = 跌停的**隔一個交易日**就收漲
 *      (⛔ 任意天後的第一根紅不算 —— 那是另一個沒測過的東西)
 *   ② 🚨 必須顯示「當初大盤有沒有一起跌」—— 兩組差 4.8 倍(+4.89% vs +1.02%),
 *      不顯示的話使用者會拿系統性那組的數字去接個股利空的刀
 *   ③ ⛔ 不下操作指令、不給買賣價位(K線頁是解讀頁);小紅要講「參考價值低很多」
 *   ④ 數字讀 _LD_REDK 常數(⛔ 顯示端不可寫死第二份)
 *   ⑤ 切股殘留守門:_fillLdMkt 回來時 sym 不同就不可以填
 *   ⑥ 兩條 render path 都要接(⛔ 只接一處 = 只有剛好有 K 棒訊號的日子才出現)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`);
    if (!cond) fails++;
};

// ── 靜態:接線 ──
ok('⑥a 主 render path 接上 _ldRedKHtml',
    /\$\{this\._luOddsHtml\(data\)\}\$\{this\._ldRedKHtml\(data, this\.currentSymbolId\)\}/.test(SRC));
ok('⑥b 「沒有 K 棒訊號」那條路徑也接上',
    /const _rg = this\._luOddsHtml\(data\) \+ this\._ldRedKHtml\(data, this\.currentSymbolId\)/.test(SRC));
ok('④a _LD_REDK 常數存在且四組數字齊(all/big/sys/idio)',
    /_LD_REDK:\s*\{\s*all:.*big:.*sys:.*idio:/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;                      // 陷阱 #5:const app 不掛 window
    const out = {};
    const mk = (chgPrev, chgLast) => {
        // 造 K 線:…普通日 × 30 → 跌停日 → 今天
        const rows = [];
        let px = 100;
        for (let i = 0; i < 30; i++) { rows.push({ date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, open: px, close: px, high: px + 1, low: px - 1, volume: 1e6 }); }
        px = px * (1 + chgPrev / 100);
        rows.push({ date: '2026-08-28', open: px * 1.02, close: px, high: px * 1.03, low: px, volume: 3e6 });
        const p2 = px * (1 + chgLast / 100);
        rows.push({ date: '2026-08-29', open: px, close: p2, high: p2 * 1.01, low: px * 0.99, volume: 2e6 });
        return rows;
    };
    A.currentSymbolId = '2409';
    // ① 觸發:昨天 −9.5%、今天 +3.5%(大紅)
    out.hit = A._ldRedKHtml(mk(-9.5, 3.5), '2409') || '';
    // 小紅
    out.small = A._ldRedKHtml(mk(-9.5, 1.2), '2409') || '';
    // 不觸發:跌 −8%(沒到跌停)/ 今天收黑 / 跌停在 3 天前(中間隔一根黑K)
    out.no1 = A._ldRedKHtml(mk(-8.0, 3.5), '2409') || '';
    out.no2 = A._ldRedKHtml(mk(-9.5, -1.0), '2409') || '';
    {
        const rows = mk(-9.5, -1.0);
        const px = rows[rows.length - 1].close * 1.04;
        rows.push({ date: '2026-08-30', open: px, close: px, high: px, low: px, volume: 1e6 });
        out.no3 = A._ldRedKHtml(rows, '2409') || '';
    }
    // ② 大盤那格:stub _getTwiiRows → 系統性 / 個股利空 兩個分支
    document.body.insertAdjacentHTML('beforeend', '<div id="_t1"></div>');
    A._twiiChgMap = null;
    A._getTwiiRows = async () => [
        { date: '2026-08-27', close: 24000 }, { date: '2026-08-28', close: 23500 }, { date: '2026-08-29', close: 23600 }];
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="2409">⏳</span>';
    await A._fillLdMkt('2026-08-28', '2409');
    out.sysTxt = document.getElementById('ldRedkMkt').innerText;
    // 個股利空分支(那天大盤 +0.4%)
    A._twiiChgMap = null;
    A._getTwiiRows = async () => [
        { date: '2026-08-27', close: 24000 }, { date: '2026-08-28', close: 24100 }, { date: '2026-08-29', close: 24000 }];
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="2409">⏳</span>';
    await A._fillLdMkt('2026-08-28', '2409');
    out.idioTxt = document.getElementById('ldRedkMkt').innerText;
    // ⑤ 切股殘留:sym 對不上就不可以填
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="9999">⏳</span>';
    await A._fillLdMkt('2026-08-28', '2409');
    out.staleTxt = document.getElementById('ldRedkMkt').innerText;
    // 查不到那天 → 誠實說 + 給兩組差距(⛔ 不可裝死也不可硬判)
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="2409">⏳</span>';
    await A._fillLdMkt('2019-01-01', '2409');
    out.missTxt = document.getElementById('ldRedkMkt').innerText;
    return out;
});
await browser.close();

ok('①a 🚧 空過守門:跌停(−9.5%)+紅K 真的觸發', R.hit.length > 300, `len=${R.hit.length}`);
ok('①b −8%(沒到跌停)/ 收黑 / 隔了一根才紅 → 都不觸發(⛔ 定義要跟探針一字不差)',
    R.no1 === '' && R.no2 === '' && R.no3 === '', `${R.no1.length}/${R.no2.length}/${R.no3.length}`);
ok('④b 大紅顯 +5.71%、整體 +3.66%(讀 _LD_REDK,勝率也要在)',
    /\+5\.71%/.test(R.hit) && /\+3\.66%/.test(R.hit) && /53\.8%/.test(R.hit));
ok('③a 小紅要講「參考價值低很多」而且⛔不可顯大紅那組數字',
    /參考價值低/.test(R.small) && !/\+5\.71%/.test(R.small));
ok('②a 系統性分支:那天大盤 −2.1% → 顯 +4.89% 與「系統性」',
    /系統性/.test(R.sysTxt) && /\+4\.89%/.test(R.sysTxt), R.sysTxt.slice(0, 60));
ok('②b 個股利空分支:顯 +1.02% 與「別急著接」(⛔ 不講的話使用者會拿好的那組數字去接刀)',
    /個股自己出事/.test(R.idioTxt) && /\+1\.02%/.test(R.idioTxt) && /別急著接/.test(R.idioTxt), R.idioTxt.slice(0, 60));
ok('⑤ 切股殘留守門:sym 對不上不可以填(還是 ⏳)', R.staleTxt === '⏳', R.staleTxt);
ok('②c 查不到那天 → 誠實說 + 仍給兩組差距', /查不到/.test(R.missTxt) && /4\.8 倍/.test(R.missTxt), R.missTxt.slice(0, 60));
ok('③b ⛔ 不下操作指令(買進/加碼/停損價/目標價都不可出現)+ 要指路總覽',
    !/買進|加碼|停損價|目標價|掛單/.test(R.hit) && /現在怎麼做/.test(R.hit));
ok('③c 要寫「不是進場指令」與回測進場點(隔天開盤)', /不是進場指令/.test(R.hit) && /隔天開盤/.test(R.hit));

console.log(fails ? `❌ ${fails} 條失敗` : '✅ LDREDK_PASS(全部通過)');
process.exit(fails ? 1 : 0);
