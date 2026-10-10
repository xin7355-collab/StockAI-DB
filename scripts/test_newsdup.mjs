#!/usr/bin/env node
/**
 * 🧩 V79.0.6 「另 N 家也報」前端守門(採礦端 universal_radar 同一事件歸群)
 *   ① 有 dup 的那則印「・另 N 家也報」,滑過去列出是哪幾家;沒有 dup ⛔ 一個字都不多
 *   ② 兩個畫新聞的地方都接上(總覽消息面 _ovNewsHtml / AI 股神最新焦點 _appendAiGodNews)
 *   ③ also 是外部字串 → 要跳脫(⛔ 不可把 <img> 原樣塞進 title)
 *   ④ ⛔ 不用顏色(灰字)
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.ND_FILE || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._newsDupTxt && !!app._ovNewsHtml, null, { timeout: 60000 });
await page.waitForTimeout(800);

const R = await page.evaluate(async () => {
    const A = app, out = {};
    const items = [
        { title: '華邦電8月營收273.09億元', tone: 'pos', source: '鉅亨網', date: '2026-10-08 09:30', dup: 2, also: ['經濟日報', '<img src=x onerror=alert(1)>', 'x" onmouseover="alert(1)'] },
        { title: '華邦電砸354億買英飛凌', tone: 'neu', source: '工商時報', date: '2026-10-08 10:00' },
    ];
    A._stockNewsCache = { '2344': { items } }; A._stockNewsAt = Date.now();
    A.currentSymbolId = '2344';
    const box = document.createElement('div'); box.innerHTML = A._ovNewsHtml(); document.body.appendChild(box);
    const d = [...box.querySelectorAll('[data-newsdup]')];
    out.ovN = d.length; out.ovTxt = d.map(e => e.textContent.trim()); out.ovTitle = d[0] ? d[0].getAttribute('title') : '';
    out.ovHasImg = !!box.querySelector('img'); out.ovEvil = d[0] ? d[0].hasAttribute('onmouseover') : true; out.ovCls = d[0] ? d[0].className : '';
    // AI 股神最新焦點
    const g = document.createElement('div'); g.id = 'aiGodNewsBox'; document.body.appendChild(g);
    await A._appendAiGodNews(['2344'], '庫存');
    const d2 = [...g.querySelectorAll('[data-newsdup]')];
    out.godN = d2.length; out.godTxt = d2.map(e => e.textContent.trim());
    out.none = A._newsDupTxt({ title: 'x' }) === '' && A._newsDupTxt({ title: 'x', dup: 0 }) === '';
    return out;
});

ok('① 有 dup 的那則印一次「另 2 家也報」', R.ovN === 1 && /另 2 家也報/.test(R.ovTxt[0] || ''), JSON.stringify(R.ovTxt));
ok('① 滑過去列出是哪幾家', /經濟日報/.test(R.ovTitle || ''), R.ovTitle);
ok('① 沒有 dup ⛔ 一個字都不多', R.none);
ok('② AI 股神最新焦點也接上', R.godN === 1 && /另 2 家也報/.test(R.godTxt[0] || ''), JSON.stringify(R.godTxt));
ok('③ also 跳脫:⛔ 不可生出 <img> 元素', !R.ovHasImg);
ok('③ also 跳脫:引號⛔ 不可跳出 title 屬性', !R.ovEvil && /onmouseover/.test(R.ovTitle || ''), R.ovTitle);
ok('④ 灰字(⛔ 不用紅綠)', /text-gray/.test(R.ovCls) && !/text-(red|green)/.test(R.ovCls), R.ovCls);
ok('🚧 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ test_newsdup 全過');
process.exit(fails ? 1 : 0);
