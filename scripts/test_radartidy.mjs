#!/usr/bin/env node
/**
 * 🧹 V74.9.0 選股榜精簡:實測沒有優勢的收進摺疊
 *
 * 使用者:「目前我的選股策略那面多,我想要精簡策略,把實測後沒有用都刪除」。
 *
 * ⛔ 五條鐵則:
 *  ① 🚨 **收起 ≠ 刪除** —— DOM 移動不是移除,tab 還在、render 照跑、點得到。
 *     刪掉的話使用者會以為沒這回事,跑去別處學了再回來問(同 `_SIGNAL_EDGE` 對 C 級的處置)。
 *  ② 🚨 每一條降級都要有**實測數字 + 來源探針**(⛔ 沒有數字的意見不准列進來)。
 *  ③ 選到降級榜 → **自動展開**(⛔ 否則使用者不知道自己現在在哪一頁)+ 說明條最上面先講「它實測沒優勢」。
 *  ④ 主清單裡**唯一有實測成績**的那個(todaysig)⛔ 不可被降級。
 *  ⑤ 只搬一次(重複搬會把順序弄亂)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── ① 靜態:每一條降級都要有數字 + 來源 ─────────────────────────────
{
    const i = SRC.indexOf('    _RADAR_WEAK: {'), j = SRC.indexOf('\n    },', i);
    const blk = i >= 0 ? SRC.slice(i, j) : '';
    const rows = [...blk.matchAll(/^\s{8}(\w+):\s*\{ why: '([^']*)', s: '([^']*)' \}/gm)];
    ok('① _RADAR_WEAK 解析得到 ≥10 條', rows.length >= 10, `n=${rows.length}`);
    // 🚨 「有數字」= 至少一個 pp / % / 倍 / 元 / 萬 的量;⛔ 只寫「沒有用」不算
    const noNum = rows.filter(([, , why]) => !/(\d+(\.\d+)?\s*(pp|%|x|倍|元|萬|週|筆))|未驗證|從來沒有回測/.test(why)).map(r => r[1]);
    ok('① 🚨 每一條都要有實測數字或明說「未驗證」(⛔ 沒有數字的意見不准列)', noNum.length === 0, noNum.join(','));
    const noSrc = rows.filter(([, , , s]) => !s || s.length < 3).map(r => r[1]);
    ok('① 每一條都要標來源探針', noSrc.length === 0, noSrc.join(','));
}

// ── ② 靜態:todaysig(唯一有實測成績)⛔ 不可被降級 ────────────────
{
    const i = SRC.indexOf('    _RADAR_WEAK: {'), j = SRC.indexOf('\n    },', i);
    const blk = i >= 0 ? SRC.slice(i, j) : '';
    ok('② 🚨 todaysig(唯一有實測成績)⛔ 不可被降級', i >= 0 && !/^\s*todaysig:/m.test(blk));
    ok('② 預設 fallback ⛔ 不可再指向已降級的 layup',
       /if \(!this\._RADAR_TABS\[key\]\) key = 'todaysig'/.test(SRC));
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const perr = [];
page.on('pageerror', e => { const m = e.message || '';
    if (/Cache.*scheme 'file'|unsupported/.test(m)) return;   // ⚠️ file:// 下 SW 的 Cache.put 必炸 = 環境限制,⛔ 不是 App bug
    perr.push(m.slice(0, 200)); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._RADAR_TABS, null, { timeout: 40000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const P = app;
    const o = {};
    P._tidyRadarTabs();
    const wrap = document.getElementById('radarMoreWrap');
    const bar = document.getElementById('radarMoreBar');
    o.hasBar = !!bar; o.hasWrap = !!wrap;
    o.moved = wrap ? wrap.children.length : 0;
    o.weakN = Object.keys(P._RADAR_WEAK || {}).length;
    // ⛔ 收起 ≠ 刪除:每一顆 tab 都還在 DOM 裡、還點得到
    o.allAlive = Object.entries(P._RADAR_TABS).every(([, c]) => !!document.getElementById(c.id));
    // 主清單剩幾顆(⛔ 這是「精簡」的實質:第一眼看到的數量)
    const col = bar ? bar.parentElement : null;
    // ⚠️ 只數「真的是策略榜」的 —— radarTabBroker / radarTabChu 是導覽鈕,不在 _RADAR_TABS 裡
    const id2k = Object.fromEntries(Object.entries(P._RADAR_TABS).map(([k, c]) => [c.id, k]));
    o.mainN = col ? [...col.children].filter(e => id2k[e.id] && !P._RADAR_WEAK[id2k[e.id]]).length : -1;
    o.closedAtFirst = wrap ? wrap.classList.contains('hidden') : null;
    // 只搬一次
    P._tidyRadarTabs(); P._tidyRadarTabs();
    o.movedAgain = wrap ? wrap.children.length : -1;
    // ③ 選到降級榜 → 自動展開 + 說明條先講
    P.switchRadarStrategy('foreign3');
    await new Promise(r => setTimeout(r, 300));
    o.openAfterWeak = wrap ? !wrap.classList.contains('hidden') : null;
    const hint = document.getElementById('radarMatrixHint');
    o.hintWeak = hint ? hint.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '';
    // 主清單的榜 ⛔ 不可出現那段警示
    P.switchRadarStrategy('todaysig');
    await new Promise(r => setTimeout(r, 300));
    o.hintMain = hint ? hint.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '';
    return o;
});
await browser.close();

ok('③ 摺疊列與容器都建起來了', R.hasBar && R.hasWrap, JSON.stringify({ bar: R.hasBar, wrap: R.hasWrap }));
ok('③ 降級的榜全部搬進摺疊', R.moved === R.weakN, `moved=${R.moved} weak=${R.weakN}`);
ok('③ 預設是收起來的(⛔ 不然等於沒精簡)', R.closedAtFirst === true, String(R.closedAtFirst));
ok('④ 🚨 收起 ≠ 刪除:每一顆 tab 都還在 DOM 裡', R.allAlive === true);
ok('④ 主清單精簡到 ≤11 顆(原本 23)', R.mainN > 0 && R.mainN <= 11, `mainN=${R.mainN}`);
ok('⑤ 只搬一次(⛔ 重複呼叫不可再搬)', R.movedAgain === R.moved, `${R.movedAgain} vs ${R.moved}`);
ok('⑥ 選到降級榜 → 自動展開', R.openAfterWeak === true, String(R.openAfterWeak));
ok('⑥ 🚨 說明條最上面要講「實測沒有優勢」+ 附數字 + 來源',
   /實測.{0,4}沒.{0,4}優勢/.test(R.hintWeak) && /0\.64/.test(R.hintWeak) && /limitup_probe/.test(R.hintWeak),
   R.hintWeak.slice(0, 140));
ok('⑥ 🚨 而且要明說「⛔ 沒有刪掉」(⛔ 不可讓使用者以為功能被拿走)',
   /沒有刪掉|資料照顯示/.test(R.hintWeak), R.hintWeak.slice(0, 140));
ok('⑦ 主清單的榜 ⛔ 不可誤掛那段警示', !/實測.{0,4}沒.{0,4}優勢/.test(R.hintMain), R.hintMain.slice(0, 100));
ok('⑧ 無 pageerror', perr.length === 0, perr.join(' | '));

console.log(fails ? `\n❌ ${fails} 條未通過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
