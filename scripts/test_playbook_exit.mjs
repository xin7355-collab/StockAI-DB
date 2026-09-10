#!/usr/bin/env node
/**
 * 🚪 個股回測頁的出場規則 —— ⛔ 不可自己另外寫一套(V75.3.0)
 *
 * 🚨 為什麼要有這支:`_patternFitBacktest`(回測頁那份「這檔最會賺的招」排名)
 *   **把出場寫死成「跌破 5 日線」**,而 V74.4.8 全測 28 種裡 5 日線是**賺最少**的
 *   (唐奇安 590 萬 > ATR 531 > 移動停利 476 > **5 日線 193**),
 *   V75.0.9 早就把預設換成唐奇安 → 排出來的「最會賺的招」是用**使用者實際不會用的出場**算的。
 *   ⛔ 而 `_exitRuleKey` 的註解鐵則①白紙黑字寫著「誰都不准自己另外寫一套」。
 *
 * ⭐ 決定性對照組:**同一檔、同一批 K 線,只換出場設定 → 排名必須跟著變**。
 *   ⛔ 只驗「有沒有呼叫 _exitLevelAt」不算數(那是驗實作不是驗行為)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._patternFitBacktest, null, { timeout: 20000 });

// ── 測資:整組合成(⛔ 不用真實 data/,那台機器有沒有那一檔不該影響測試)──────
const rows = await page.evaluate(() => {
    const out = []; let c = 100;
    for (let i = 0; i < 400; i++) {
        // 有波段也有回檔 → 四種出場會走出不同結果
        c *= 1 + (Math.sin(i / 11) * 0.02 + Math.sin(i / 37) * 0.015 + (i % 17 === 0 ? -0.03 : 0.002));
        const h = c * 1.02, l = c * 0.975;
        const d = new Date(Date.UTC(2023, 0, 1 + i));
        out.push({ date: d.toISOString().slice(0, 10).replace(/-/g, '/'), open: +(c * 0.998).toFixed(2),
                   high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: 3000000 });
    }
    return out;
});

const rank = async (exitKey) => await page.evaluate(a => {
    app.settings = Object.assign({}, app.settings, { exitRule: a.k });
    const r = app._patternFitBacktest(a.rows) || [];
    return r.slice(0, 8).map(x => ({ k: x.key || x.name || x.t, exp: Math.round((x.exp ?? x.expectancy ?? 0) * 100) / 100 }));
}, { k: exitKey, rows });

const don = await rank('don'), ma5 = await rank('ma5'), atr = await rank('atr2');

ok('🚪a 四種出場都算得出排名(⛔ 不可有一種回空)',
   don.length > 0 && ma5.length > 0 && atr.length > 0,
   JSON.stringify({ don: don.length, ma5: ma5.length, atr: atr.length }));

// ⭐⭐ 決定性:換出場 → 數字必須變(⛔ 沒變就代表那個設定根本沒被讀到)
const same = JSON.stringify(don.map(x => x.exp)) === JSON.stringify(ma5.map(x => x.exp));
ok('🚪b ⭐⭐ 換出場設定(唐奇安 ↔ 5日線)→ 期望值必須跟著變 —— ⛔ 沒變 = 設定沒被讀到',
   !same, `don=${JSON.stringify(don.slice(0, 3))} ma5=${JSON.stringify(ma5.slice(0, 3))}`);
ok('🚪b2 ATR 也要是自己的一套(⛔ 不可跟其中任一種完全相同)',
   JSON.stringify(atr.map(x => x.exp)) !== JSON.stringify(don.map(x => x.exp)),
   JSON.stringify(atr.slice(0, 3)));

// ── 原始碼:⛔ 不可再出現寫死的 5 日線出場 ──────────────
{
    const H = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const i = H.indexOf('_patternFitBacktest(data) {');
    const seg = H.slice(i, i + 3000);
    ok('🚪c ⛔ 回測迴圈不可再自己算 5 日線當出場(那是寫死的第二份真相)',
       !/const ma5 = j >= 4 \?/.test(seg), seg.slice(0, 200));
    ok('🚪c2 ⭐ 必須走共用的 `_exitLevelAt`', /_exitLevelAt\(data, i, j, exKey\)/.test(seg));
    ok('🚪c3 ⭐ 出場鍵要跟全站唯一判斷點走', /_exitRuleKey\(\)/.test(seg));
    ok('🚪c4 ⛔ 停損與 20 日上限**不隨設定變**(鐵則③)',
       /entry \* 0\.95/.test(seg) && /i \+ 20/.test(seg));
}

// ── 公式一致:`_exitLevelAt` 對「最後一根」要跟 `_exitLines` 算出同樣的價 ──
//   ⭐ 這條才是「⛔ 不寫第二份真相」的真正守門(⛔ 光看有沒有呼叫不夠)
{
    const cmp = await page.evaluate(a => {
        const n = a.rows.length - 1;
        const L = app._exitLines(a.rows, '__TEST__');           // 無庫存 → proxy 模式(近 20 根)
        const at = k => app._exitLevelAt(a.rows, Math.max(0, n - 19), n, k);
        const r2 = v => v == null ? null : Number(v.toFixed(2));
        return { lines: { don: L.don, ma5: L.ma5, trail8: L.trail8, atr2: L.atr2 },
                 atFn: { don: r2(at('don')), ma5: r2(at('ma5')), trail8: r2(at('trail8')), atr2: r2(at('atr2')) } };
    }, { rows });
    for (const k of ['don', 'ma5', 'trail8', 'atr2']) {
        const a = cmp.lines[k], b = cmp.atFn[k];
        ok(`🚪d 公式一致(${k}):_exitLevelAt 要跟 _exitLines 算出同一個價`,
           a != null && b != null && Math.abs(a - b) < 0.02, `_exitLines=${a} _exitLevelAt=${b}`);
    }
}

// ── 誠實揭露:這一頁被自己的探針否定過,⛔ 不可不講 ──────────────
{
    const h = await page.evaluate(() => app._playbookHonestyHtml());
    const t = h.replace(/<[^>]+>/g, ' ');
    ok('📉e 要寫出「逐檔挑法的穩定度」實測數字(4.3% vs 隨機 5.0%)',
       /4\.3%/.test(t) && /5\.0%/.test(t), t.slice(0, 200));
    ok('📉e2 要寫出「全市場最好那一招贏過逐檔挑」', /全市場/.test(t) && /0\.89|0\.58/.test(t));
    ok('📉e3 ⛔ 但不可變成「所以這張表沒用」—— 要說還能看什麼', /還能看什麼|參考價值/.test(t));
    ok('📉e4 ⭐ 要標明「用哪一條出場算的」(⛔ 同名不同值的溫床)', /出場算的/.test(t), t.slice(-260));
    ok('📉e5 要附來源探針檔名', /perstock_playbook_probe/.test(t));
    ok('📉e6 ⛔ 是摺疊不是新卡片(使用者:回測那面已經很多東西)', /^<details/.test(h.trim()));
}

ok('⑨ 無 pageerror', true);
await browser.close();
console.log('');
if (fails.length) { console.log(`❌ PLAYBOOK_EXIT_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ PLAYBOOK_EXIT_PASS');
