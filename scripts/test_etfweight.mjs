#!/usr/bin/env node
/**
 * 🧩 ETF 成分股比例 + 個股反查(V73.3.4)
 *
 * 使用者:「ETF 新增成分股,還有比例,還有買入個股的個股全部比例」
 *   ① ETF 端:市值型(0050 等)以前**抓了成分股卻只算 top1/top5 就丟掉** → 現在整份存 `holdings`
 *   ② 個股端:`cross_ref.by_stock` 以前**只有 ETF 代號、沒有比例** → 現在多 `cross_ref.weights`
 *
 * ⛔ 釘住的規則:
 *   ・⛔ 不開新卡片(併進既有 `etfFollowCard`)
 *   ・⛔ 抓不到權重就不顯示,**不可填 0 冒充**
 *   ・⛔ 沒有任何資料時整張卡不顯示(不留空殼)
 *   ・⭐ % 要配「實際金額」(使用者鐵則)
 *   ・⛔ 採礦端不存股名(前端已有 getStockName,存兩份會不同步)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

// ── ① 採礦端原始碼靜態檢查 ──────────────────────────────────────
const py = fs.readFileSync(path.join(ROOT, 'etf_miner.py'), 'utf8');
ok('①a 市值型 ETF 有存完整成分股', /"holdings": \[\{"sym": h\.get\("sym"\), "weight": h\.get\("weight"\)\}/.test(py));
ok('①b cross_ref 有 weights', /"weights":/.test(py) && /_w_ref/.test(py));
ok('①c ⛔ 權重是 None 就不留(不填 0 冒充)', /if b is not None/.test(py));
ok('①d 市值型也併進個股反查表', /by_stock\.setdefault\(h\["sym"\], \[\]\)\.append\(cs\)/.test(py));
ok('①e ⛔ 採礦端不存股名(避免兩份不同步)',
    !/"holdings": \[\{"sym": h\.get\("sym"\), "weight": h\.get\("weight"\), "name"/.test(py));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = String(e && e.message || e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderEtfFollowCard, null, { timeout: 20000 });

const render = (cache, sym) => page.evaluate(async a => {
    let c = document.getElementById('etfFollowCard');
    if (!c) { c = document.createElement('div'); c.id = 'etfFollowCard'; document.body.appendChild(c); }
    c.innerHTML = ''; c.classList.remove('hidden');
    app._etfCache = a.cache;
    app.activeData = [{ date: '2026-08-08', close: 100 }, { date: '2026-08-10', close: 110 }];
    try { await app.renderEtfFollowCard(a.sym); } catch (e) { return 'ERR:' + e.message; }
    return c.classList.contains('hidden') ? '(整張隱藏)' : c.innerText;
}, { cache, sym });

const CACHE = {
    updated: '2026-08-10',
    etfs: [{ symbol: '00981A', name: '主動統一台股增長', holdings: [], changes: { added: [], up: [], down: [], removed: [] } }],
    concentration: [{ symbol: '0050', name: '元大台灣50', holdings: [] }],
    cross_ref: { by_stock: { 2330: ['0050', '00981A'] }, weights: { 2330: { '0050': 58.64, '00981A': 8.97 } } },
};

// ② 有權重 → 要顯示,而且要有比例、金額
const t1 = await render(CACHE, '2330');
ok('②a 有權重時卡片要顯示(⛔ 舊版沒動作就整張藏起來)', !/整張隱藏/.test(t1), t1.slice(0, 120));
ok('②b 顯示被幾支 ETF 持有', /被\s*2\s*支 ETF 持有/.test(t1.replace(/\s+/g, ' ')), t1.slice(0, 300));
ok('②c 有列出比例', /58\.64%/.test(t1) && /8\.97%/.test(t1), t1.slice(0, 300));
ok('②d 由大到小排序', t1.indexOf('58.64') < t1.indexOf('8.97'));
ok('②e ⭐ % 要配實際金額(使用者鐵則)', /1 萬元/.test(t1) && /5,864 元/.test(t1), t1.slice(0, 400));
ok('②f 要寫明「不是買賣訊號」', /不是買賣訊號/.test(t1));

// ③ 沒有任何資料 → 整張不顯示(⛔ 不留空殼);⛔ 也不可誤傷
const t2 = await render({ ...CACHE, cross_ref: { by_stock: {}, weights: {} } }, '9999');
ok('③ 沒資料 → 整張隱藏(⛔ 不留空殼)', /整張隱藏/.test(t2), t2.slice(0, 120));

// ④ 權重是 null/0 → 不可顯示成 0%
const t3 = await render({ ...CACHE, cross_ref: { by_stock: { 2330: ['0050'] }, weights: { 2330: { '0050': null } } } }, '2330');
ok('④ 權重缺 → ⛔ 不可顯示成 0.00%', !/0\.00%/.test(t3), t3.slice(0, 200));

// ⑤ ⛔ 不可新增卡片
const newCard = await page.evaluate(() => document.querySelectorAll('[id$="WeightCard"],[id*="etfWeightCard"]').length);
ok('⑤ ⛔ 沒有新增卡片(併進 etfFollowCard)', newCard === 0);

ok('⑥ 全程無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ETFWEIGHT_FAIL (${fails.length})` : '\n✅ ETFWEIGHT_PASS');
process.exit(fails.length ? 1 : 0);
