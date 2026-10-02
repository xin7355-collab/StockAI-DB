#!/usr/bin/env node
/**
 * 🗑️ V78.1.9 決策台「📦 只挑營收年增加速的」濾網**已移除** —— ⛔ 不可復活
 *   使用者:「以下資料沒有用的不是說要移除嗎?」
 *   實測(`_DECK_FIN`,17 條回測路徑):不濾 +324 萬 vs 開了 +234 萬・同通過率隨機抽 +266 萬(只贏隨機 1 條)
 *   = 少賺,而且連「隨便少挑一點」都贏不了 → 它不是取捨,是沒用。
 *
 * 釘住:
 *   ① 設定裡⛔ 沒有那個開關、⛔ 沒有 toggle / 說明函式
 *   ② 決策台名單⛔ 不再呼叫 `_finAccelOn`(連一次 `data/fin` 都不抓)
 *   ③ 就算手機上還存著舊設定 deckFinAccel = true,名單也⛔ 不被過濾、⛔ 沒有 📦 標籤
 *   ④ 🎯 決策台與個股總覽**同一份名單**:`_deckState` 與 `_deckRankOf` 都走 `_deckBuyOf`(V78.1.9,⛔ 不可各算一份)
 *   ⑤ 決定性對照:`_deckRankOf` 回的名次 == 決策台畫面上的順序
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, process.env.INDEX_HTML ? path.relative(ROOT, process.env.INDEX_HTML) : 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 220) : ''}`); } };
const body = name => { const i = CODE.indexOf(`    ${name}`); if (i < 0) return ''; return CODE.slice(i, CODE.indexOf('\n    },\n', i)); };

// ═══ 靜態 ═══
ok('① 設定裡⛔ 沒有「營收加速」開關', !/id="set_deckFinAccel"/.test(SRC) && !/toggleDeckFinAccel\(/.test(CODE) && !/_fillDeckFinDesc\(/.test(CODE), '');
const ds = body('async _deckState() {');
ok('🚧 找得到 _deckState', ds.length > 300, ds.length);
ok('② 決策台名單⛔ 不再呼叫 `_finAccelOn`', !/_finAccelOn\(/.test(ds), '');
ok('④ `_deckState` 與 `_deckRankOf` 都走 `_deckBuyOf`(同一份名單)', /this\._deckBuyOf\(j\)/.test(ds) && /this\._deckBuyOf\(j\)/.test(body('_deckRankOf(sym) {')), '');

// ═══ 實跑 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + (process.env.INDEX_HTML || path.join(ROOT, 'index.html')));
await page.waitForFunction(() => typeof app !== 'undefined' && app.renderDeck, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const BASE = { c: 100, v: 3000, d: '2026-09-07', k: '💪 發動棒破昨高', w: 61.1, po: 4.8, exp: 11.5, n: 18, trig: 105, loose: 0, rank: 92, vol: 103, hq: 1, bear: 0, up: 3.1, stop: 95 };
    const picks = [['1000', 9], ['1001', 8], ['1002', 7]].map(([s, lb]) => ({ ...BASE, s, lb }));
    A.inventory = []; A.favGroups = {};
    A._invExitAt = Date.now(); A._invExitFlags = []; A._invExitSkip = []; A._invExitN = 0;
    let hits = 0; A._loadFinSlim = async () => { hits++; return null; };
    A.settings.deckFinAccel = true;   // 舊手機上還存著的設定
    A._pbEdge = { data_date: '2026-09-07', picks };
    await A.renderDeck();
    const el = document.getElementById('deckBuy');
    const order = [...el.querySelectorAll('[onclick*="app.analyze"]')].map(b => (String(b.getAttribute('onclick')).match(/analyze\('(\d+)'/) || [])[1]).filter(Boolean);
    return { hits, txt: el.innerText.replace(/\s+/g, ' '), order: [...new Set(order)],
             rk: ['1000', '1001', '1002'].map(s => (A._deckRankOf(s) || {}).rank) };
});
await browser.close();

ok('③ 舊設定 deckFinAccel = true 也⛔ 不抓財報、⛔ 沒有 📦 標籤', R.hits === 0 && !/只挑營收加速/.test(R.txt), `hits=${R.hits}`);
ok('③b 名單 = 前 2 檔(⛔ 沒被過濾)', JSON.stringify(R.order) === '["1000","1001"]', JSON.stringify(R.order));
ok('⑤ 決定性對照:`_deckRankOf` 名次 == 決策台畫面順序(第 3 檔不在名單 → 0)', JSON.stringify(R.rk) === '[1,2,0]', JSON.stringify(R.rk));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails ? `\n❌ DECKFIN_FAIL(${fails})` : '\n✅ DECKFIN_PASS(全部通過)');
process.exit(fails ? 1 : 0);
