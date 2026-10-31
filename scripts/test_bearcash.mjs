#!/usr/bin/env node
/**
 * 🅿️ V80.1.4「空頭時 0050 也賣掉放現金」設定(研究 C4 = 回測引擎 BEAR_MODE=cash;取捨型 → 選項,預設關)
 *
 *  ① 預設關:沒存過 → `_bearCashOn()` false、設定那一格沒勾
 *  ② 打開 → 連「空頭不開新倉」一起開(回測就是兩件一起做的);只有選 🅿️ 才算開(📈 錢放現金 / 👑 ⛔ 算)
 *  ③ 關掉「空頭不開新倉」→ 這一格一起關(⛔ 留下「只賣 0050、照常買股票」這種沒測過的組合)
 *  ④ `_parkPlanBear`:開 + 嚴格空頭 → 0050 目標 0、要賣多少 = 現在 0050;⭐ 決定性對照:同一個帳戶,不是空頭 / 沒開 → 跟 `_parkPlan` 一模一樣
 *     (`_parkPlan` 本身一個字都不動 —— 它跟 auto_trade.py park_plan 跨檔比對)
 *  ⑤ 決策台 🅿️ 那一行:開 + 空頭 → 講「下一次收盤前把 0050 約 X 萬賣掉放現金」+ 自動下單不會跟著做;決定性對照:同一天沒開 → 原本那一行
 *  ⑥ 🧯 你的風控那一行跟著講(data-deckriskgate="cash")
 *  ⑦ 說明:選的不是 🅿️ → 要說這一格目前沒有作用
 *  ⑧ 新的字 ⛔ 研究字樣(散戶 App V78.3.4,跟 test_retail_clean 同一份清單)、⛔ 🔴🟢
 *  ⑨ 接線:決策台把當天大盤(st.mkt)傳進去;設定 DOM 只有一個 set_bearCash
 * 跑法:node scripts/test_bearcash.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) FAIL.push(n); };
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._bearCashOn === 'function', null, { timeout: 60000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(() => {
    const A = app, o = {};
    A.saveSettings = () => {};
    A.renderDeck = () => {};
    A.showToast = () => {};
    // 帳戶:100 萬,手上一檔個股 20 萬、0050 50 萬
    A.settings.accountSize = 1000000;
    A.inventory = [{ symbol: '2330', cost: 1000, shares: 0.2, currentPrice: 1000 }, { symbol: '0050', cost: 50, shares: 10, currentPrice: 50 }];
    A._getInventory = () => A.inventory;
    A._deckQuoteOf = () => null;
    delete A.settings.bearCash; A.settings.bearGate = false; A.settings.strategy = 'park';
    o.def = A._bearCashOn();
    try { A._applySettingsToUI?.(); } catch (_) {}
    const bc = document.getElementById('set_bearCash');
    o.domN = document.querySelectorAll('#set_bearCash').length;
    o.defChecked = bc ? bc.checked : null;
    // ② 打開
    A.toggleBearCash(true, true);
    o.onSet = { cash: A.settings.bearCash, gate: A.settings.bearGate, gateBox: document.getElementById('set_bearGate')?.checked, on: A._bearCashOn() };
    A.settings.strategy = 'gene'; o.onGene = A._bearCashOn();
    A.settings.stratUnlock = true;   // 👑 要解鎖才是 👑(沒解鎖時 App 一律當 🔥 —— leadpark 沒解鎖 = 🅿️ 🔥,這一格照算)
    A.settings.strategy = 'lead'; o.onLead = A._bearCashOn();
    A.settings.strategy = 'leadpark'; o.onLeadPark = A._bearCashOn();
    A.settings.stratUnlock = false;
    A.settings.strategy = 'park';
    // ③ 關掉空頭守門 → 一起關
    A.toggleBearGate(false, true);
    o.offSet = { cash: A.settings.bearCash, gate: A.settings.bearGate, box: document.getElementById('set_bearCash')?.checked, on: A._bearCashOn() };
    // ④ 0050 該停多少
    const S = A._leadSlot();
    o.S = { st: S.st, acc: S.acc, stock: S.stock, park: S.park };
    const bear = { on: true, c: 40000, ma20: 42000, ma60: 43000, d: '2026-10-30' }, notBear = { on: false, c: 48000, ma20: 47000, ma60: 46000, d: '2026-10-30' };
    o.planOffBear = JSON.stringify(A._parkPlanBear(S, bear)); o.planBase = JSON.stringify(A._parkPlan(S));
    A.toggleBearCash(true, true);
    o.planOnBear = A._parkPlanBear(S, bear);
    o.planOnNotBear = JSON.stringify(A._parkPlanBear(S, notBear));
    o.planOnNull = JSON.stringify(A._parkPlanBear(S, null));
    const Ssmall = { ...S, park: 10000 };
    o.planSmall = A._parkPlanBear(Ssmall, bear);
    // ⑤ 決策台那一行
    o.lineOnBear = A._parkAmountHtml(bear);
    o.lineOnNotBear = A._parkAmountHtml(notBear);
    A.toggleBearCash(false, true);
    o.lineOffBear = A._parkAmountHtml(bear);
    // ⑥ 風控那一行
    A._tradeLogNet = () => [];
    A.toggleBearCash(true, true);
    o.riskCash = A._deckRiskHtml({ mkt: bear });
    A.toggleBearCash(false, true); A.settings.bearGate = true;
    o.riskOn = A._deckRiskHtml({ mkt: bear });
    A.settings.bearGate = false;
    // ⑦ 說明
    A.settings.strategy = 'park'; A._fillBearCashDesc(); o.descPark = document.getElementById('set_bearCashDesc')?.innerText || '';
    A.settings.strategy = 'gene'; A._fillBearCashDesc(); o.descGene = document.getElementById('set_bearCashDesc')?.innerText || '';
    A.settings.strategy = 'park'; A._fillBearGateDesc(); o.descGate = document.getElementById('set_bearGateDesc')?.innerText || '';
    o.label = document.querySelector('[data-setbearcash] label')?.innerText || '';
    return o;
});
const T = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

ok('① 預設關(沒存過 → 不算開、設定那格沒勾)', R.def === false && R.defChecked === false, JSON.stringify([R.def, R.defChecked]));
ok('⑨ 設定裡只有一個 set_bearCash', R.domN === 1, R.domN);
ok('② 打開 → 連「空頭不開新倉」一起開、那一格也勾上;選 🅿️ 才算開', R.onSet.cash === true && R.onSet.gate === true && R.onSet.gateBox === true && R.onSet.on === true, JSON.stringify(R.onSet));
ok('② 📈 錢放現金 / 👑 / 👑+🅿️(解鎖後)⛔ 算開', R.onGene === false && R.onLead === false && R.onLeadPark === false, JSON.stringify([R.onGene, R.onLead, R.onLeadPark]));
ok('③ 關掉空頭不開新倉 → 這一格一起關', R.offSet.cash === false && R.offSet.gate === false && R.offSet.box === false && R.offSet.on === false, JSON.stringify(R.offSet));
ok('④ 測試帳戶算得出來(100 萬、個股 20 萬、0050 50 萬)', R.S.st === 'ok' && R.S.acc === 1e6 && Math.round(R.S.stock) === 200000 && Math.round(R.S.park) === 500000, JSON.stringify(R.S));
ok('④ 開 + 嚴格空頭 → 0050 目標 0、要賣 = 現在 0050(50 萬)、act sell', R.planOnBear.bear === true && R.planOnBear.target === 0 && Math.round(R.planOnBear.diff) === -500000 && R.planOnBear.act === 'sell', JSON.stringify(R.planOnBear));
ok('④ 0050 已經剩很少(< 帳戶 2%)→ ok(⛔ 為了一點點來回賣)', R.planSmall.act === 'ok' && R.planSmall.bear === true, JSON.stringify(R.planSmall));
ok('④ 決定性對照:沒開 + 空頭 / 開 + 不是空頭 / 開 + 大盤讀不到 → 跟 _parkPlan 一模一樣', R.planOffBear === R.planBase && R.planOnNotBear === R.planBase && R.planOnNull === R.planBase, [R.planOffBear, R.planOnNotBear, R.planOnNull, R.planBase].join(' | '));
ok('⑤ 開 + 空頭 → 那一行講「收盤前把 0050 約 50 萬賣掉放現金」+ 自動下單不會跟著做', /data-parkbear="1"/.test(R.lineOnBear) && /0050 約\s*50 萬\s*賣掉放現金/.test(T(R.lineOnBear)) && /自動下單不會/.test(T(R.lineOnBear)) && /空頭結束那天收盤/.test(T(R.lineOnBear)), T(R.lineOnBear).slice(0, 260));
ok('⑤ 決定性對照:同一天沒開 → 原本那一行(⛔ 賣掉放現金);開 + 不是空頭 → 原本那一行', !/data-parkbear/.test(R.lineOffBear) && !/賣掉放現金/.test(T(R.lineOffBear)) && /該停在 0050/.test(T(R.lineOffBear)) && !/data-parkbear/.test(R.lineOnNotBear) && /該停在 0050/.test(T(R.lineOnNotBear)), T(R.lineOffBear).slice(0, 200));
ok('⑥ 🧯 風控那一行:開 → data-deckriskgate="cash" + 0050 也賣掉放現金;只開不開新倉 → "on"', /data-deckriskgate="cash"/.test(R.riskCash) && /0050 也賣掉放現金/.test(T(R.riskCash)) && /data-deckriskgate="on"/.test(R.riskOn) && !/放現金/.test(T(R.riskOn)), T(R.riskCash).slice(0, 200));
ok('⑦ 說明:選 🅿️ ⛔ 寫「沒有作用」;選 📈 → 要寫「這一格目前沒有作用」', !/目前沒有作用/.test(R.descPark) && /目前沒有作用/.test(R.descGene) && /自動下單/.test(R.descPark) && /少賺/.test(R.descPark), R.descGene.slice(-80));
ok('⑦ 空頭不開新倉那格的說明有指到這一格', /下面那一格/.test(R.descGate), R.descGate.slice(-80));
const ALL = [R.lineOnBear, R.riskCash, R.descPark, R.descGene, R.label].map(T).join(' ');
const bad = badOf(ALL);
ok('⑧ 新的字 ⛔ 研究字樣(實測 / 回測 / 勝率 …)', !bad.length, bad.slice(0, 5).join(' / '));
ok('⑧ 新的字 ⛔ 🔴🟢', !/[🔴🟢]/u.test(ALL), ALL.match(/[🔴🟢]/u));
ok('⑨ 決策台把當天大盤傳進去(_parkAmountHtml(st.mkt) / _parkPlanBear(S0, st.mkt))', /this\._parkAmountHtml\(st\.mkt\)/.test(SRC) && /_parkPlanBear\(S0, st\.mkt\)/.test(SRC));
ok('⑨ `_parkPlan` 本身沒動(跟 auto_trade.py park_plan 跨檔比對的那一份)', /_parkPlan\(S\) \{\n\s+S = S \|\| this\._leadSlot\(\);\n\s+const target = Math\.max\(0, S\.acc - S\.stock\), diff = target - S\.park;/.test(SRC));
ok('沒有頁面錯誤', !errs.length, errs.slice(0, 3).join(' | '));
await browser.close();
if (FAIL.length) { console.log(`\n❌ ${FAIL.length} 條失敗`); process.exit(1); }
console.log('\n✅ test_bearcash 全過');
