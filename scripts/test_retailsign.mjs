#!/usr/bin/env node
/**
 * 👥 V79.0.9 散戶多空比(小台)正負號 —— 全 App 只能有一個方向
 *   採礦 macro_miner.fetch_retail_long_short 算的是 −(三大法人小台淨未平倉)÷未平倉 → ⭐ 正值 = 散戶淨多。
 *   舊版:情緒卡把正值當偏多(對),主力出貨指數 / 因子卡 / Telegram 把負值當偏多(反了)
 *   → 2026-10-10 實際值 +54.7%:情緒卡 🚨 散戶過熱、同一頁主力出貨指數卻寫「散戶極度看空(反向利多)」扣 15 分。
 *   ① 唯一判斷點 _retailLsDir:+54.7 → hot、−54.7 → panic、0 → flat、null → null
 *   ② 主力出貨指數:+54.7 / 0 / −54.7 分數一樣(不計分)
 *   ③ 因子卡「散戶情緒」:+54.7 → 散戶偏多、−54.7 → 散戶偏空(⛔ 不翻成大盤方向)
 *   ④ 情緒卡(sccRetail)走同一支,⛔ 不再自己寫門檻
 *   ⑤ ⛔ 舊寫法 `< -25 = 過度看多` 不可復活
 *   🗑️ V79.1.1 回測(retail_ls_probe,2,033 天)對隔天大盤沒有方向 → 主力出貨指數 / Telegram ⛔ 不再計分;
 *      因子卡只寫「散戶偏多 / 散戶偏空」(灰色描述)、情緒卡只顯示數字(⛔ 🚨⚠️💡 / 閃爍)
 *   ⑥ 餵 AI 的提示詞要講清楚正負號的意思
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails++; };
const strip = s => s.replace(/\/\/[^\n]*/g, '');

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const wk = fs.readFileSync(path.join(ROOT, 'cloud-worker', 'worker.js'), 'utf8');

// ④⑤ 靜態
const scc = src.slice(src.indexOf('const rl = num(j.retail_ls_pct);'), src.indexOf("setTxt('sccRetail'"));
ok('④0 空過守門:切得到情緒卡那段', scc.length > 200, scc.length);
ok('④ 情緒卡只顯示數字:⛔ 🚨⚠️💡、⛔ 閃爍、⛔ 自己寫門檻', !/🚨|⚠️|💡|animate-pulse/.test(strip(scc)) && !/rl\s*[<>]=?\s*-?[1-9]/.test(strip(scc)));
ok('⑤a ⛔ index.html 舊寫法(retail <= -25 / retail <= -15)不可復活', !/retail\s*<=\s*-(25|15)/.test(strip(src)));
ok('⑤b ⛔ worker.js 不再拿散戶多空比加分(舊寫法 < -25 也不可復活)', !/retail(_ls_pct)?\s*<\s*-25/.test(strip(wk)) && !/factors\.push\('散戶/.test(strip(wk)));
const mm = src.slice(src.indexOf('_renderMarketMakerIndex(j) {'), src.indexOf('// 2️⃣ 期貨升貼水'));
ok('⑤c 主力出貨指數那段⛔ 不再用散戶多空比加減分', mm.length > 100 && !/score\s*[+-]=/.test(strip(mm)), mm.length);
ok('⑥ 餵 AI 的散戶多空要寫正負號意思', /retail_ls_pct,\s*'%'\)\s*\+[^\n]*正值=散戶淨多/.test(src));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => { const m = String(e); if (!/echarts is not defined/.test(m)) errs.push(m); });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._retailLsDir, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    out.dir = [54.7, 30, 29.9, 15, 0, -24.9, -25, -54.7, null, NaN].map(v => A._retailLsDir(v));
    const run = v => {
        A._renderMarketMakerIndex({ retail_ls_pct: v });
        const hero = document.getElementById('marketMakerHero');
        const grid = document.getElementById('macroFactorGrid');
        const n = +((hero && hero.innerText.match(/(-?\d+)\s*\n?\s*出貨指數/) || [])[1]);
        const card = grid ? [...grid.children].find(c => /散戶情緒/.test(c.innerText)) : null;
        return { n, card: card ? card.innerText : '' , hero: hero ? hero.innerText : '' };
    };
    out.p = run(54.7); out.z = run(0); out.m = run(-54.7);
    out.cut = A._RETAIL_LS_CUT;
    return out;
});
ok('① 方向:+54.7 hot、30 hot、29.9 long、15 long、0 flat、−24.9 flat、−25 panic、−54.7 panic、null/NaN null',
    JSON.stringify(R.dir) === JSON.stringify(['hot', 'hot', 'long', 'long', 'flat', 'flat', 'panic', 'panic', null, null]), JSON.stringify(R.dir));
ok('②0 空過守門:出貨指數讀得到', Number.isFinite(R.p.n) && Number.isFinite(R.z.n) && Number.isFinite(R.m.n), JSON.stringify([R.p.hero, R.z.hero]).slice(0, 200));
ok('② 不計分:+54.7 / 0 / −54.7 出貨指數一樣', R.p.n === R.z.n && R.m.n === R.z.n, `${R.p.n} / ${R.z.n} / ${R.m.n}`);
ok('③ 因子卡:+54.7 → 散戶偏多、−54.7 → 散戶偏空、0 → 中性(⛔ 不翻成大盤方向)', /散戶偏多/.test(R.p.card) && /散戶偏空/.test(R.m.card) && /中性/.test(R.z.card), JSON.stringify([R.p.card, R.m.card, R.z.card]));
ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ RETAILSIGN_PASS');
process.exit(fails ? 1 : 0);
