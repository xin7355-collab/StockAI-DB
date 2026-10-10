#!/usr/bin/env node
/**
 * 👥 V79.0.9 散戶多空比(小台)正負號 —— 全 App 只能有一個方向
 *   採礦 macro_miner.fetch_retail_long_short 算的是 −(三大法人小台淨未平倉)÷未平倉 → ⭐ 正值 = 散戶淨多。
 *   舊版:情緒卡把正值當偏多(對),主力出貨指數 / 因子卡 / Telegram 把負值當偏多(反了)
 *   → 2026-10-10 實際值 +54.7%:情緒卡 🚨 散戶過熱、同一頁主力出貨指數卻寫「散戶極度看空(反向利多)」扣 15 分。
 *   ① 唯一判斷點 _retailLsDir:+54.7 → hot、−54.7 → panic、0 → flat、null → null
 *   ② 主力出貨指數:+54.7 比 0 多 20 分、−54.7 比 0 少 15 分(決定性對照:只換這一個數字)
 *   ③ 因子卡「散戶情緒」:+54.7 → 偏空(利於下跌)、−54.7 → 偏多
 *   ④ 情緒卡(sccRetail)走同一支,⛔ 不再自己寫門檻
 *   ⑤ worker.js retailLsDir 跟 index.html 逐值一致;⛔ 舊寫法 `< -25 = 過度看多` 不可復活
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
ok('④ 情緒卡走 _retailLsDir,⛔ 不自己寫 rl >= 30 / rl <= -25', /_retailLsDir\(rl\)/.test(scc) && !/rl\s*[<>]=?\s*-?[1-9]/.test(strip(scc)));
ok('⑤a ⛔ index.html 舊寫法(retail <= -25 / retail <= -15)不可復活', !/retail\s*<=\s*-(25|15)/.test(strip(src)));
ok('⑤b ⛔ worker.js 舊寫法(< -25 = 散戶過度看多)不可復活', !/retail(_ls_pct)?\s*<\s*-25/.test(strip(wk)));
ok('⑤c worker 兩處都走 retailLsDir', (wk.match(/retailLsDir\([^)]*\)\s*===\s*'hot'/g) || []).length === 2);
const wfn = wk.match(/const RETAIL_LS_CUT = (\{[^}]+\});\s*function retailLsDir\(v\) \{([\s\S]*?)\n\}/);
ok('⑤0 抽得到 worker 的 retailLsDir', !!wfn);
const wDir = wfn ? new Function('v', `const RETAIL_LS_CUT = ${wfn[1]};${wfn[2]}`) : () => 'x';
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
ok('② 散戶淨多 +54.7 → 出貨指數比 0 多 20 分(散戶過熱 → 主力反向)', R.p.n - R.z.n === 20, `${R.p.n} vs ${R.z.n}`);
ok('②b 散戶淨空 −54.7 → 出貨指數比 0 少 15 分(反向利多)', R.m.n - R.z.n === -15, `${R.m.n} vs ${R.z.n}`);
ok('③ 因子卡:+54.7 → 偏空、−54.7 → 偏多、0 → 中性', /偏空/.test(R.p.card) && /偏多/.test(R.m.card) && /中性/.test(R.z.card), JSON.stringify([R.p.card, R.m.card, R.z.card]));
const vals = [-80, -25.1, -25, -24.9, 0, 14.9, 15, 29.9, 30, 80];
const iDir = vals.map(v => (v >= R.cut.hot ? 'hot' : v >= R.cut.long ? 'long' : v <= R.cut.panic ? 'panic' : 'flat'));
ok('⑤d worker.js retailLsDir == index.html(逐值)', JSON.stringify(vals.map(v => wDir(v))) === JSON.stringify(iDir), JSON.stringify(vals.map(v => wDir(v))));
ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ RETAILSIGN_PASS');
process.exit(fails ? 1 : 0);
