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
    const i = SRC.indexOf('    _RADAR_DELETED: {'), j = SRC.indexOf('\n    },', i);
    const blk = i >= 0 ? SRC.slice(i, j) : '';
    const rows = [...blk.matchAll(/^\s{8}(\w+):\s*\{ why: '([^']*)', s: '([^']*)' \}/gm)];
    ok('① 🪦 墓碑清單解析得到 ≥13 條(每條都要有 why + 來源探針)', rows.length >= 13, `n=${rows.length}`);
    // 🚨 「有數字」= 至少一個 pp / % / 倍 / 元 / 萬 的量;⛔ 只寫「沒有用」不算
    const noNum = rows.filter(([, , why]) => !/(\d+(\.\d+)?\s*(pp|%|x|倍|元|萬|週|筆))|未驗證|從來沒有回測/.test(why)).map(r => r[1]);
    ok('① 🚨 每一條都要有實測數字或明說「未驗證」(⛔ 沒有數字的意見不准列)', noNum.length === 0, noNum.join(','));
    const noSrc = rows.filter(([, , , s]) => !s || s.length < 3).map(r => r[1]);
    ok('① 每一條都要標來源探針', noSrc.length === 0, noSrc.join(','));
}

// ── ② 靜態:todaysig(唯一有實測成績)⛔ 不可被降級 ────────────────
{
    const i = SRC.indexOf('    _RADAR_DELETED: {'), j = SRC.indexOf('\n    },', i);
    const blk = i >= 0 ? SRC.slice(i, j) : '';
    ok('② 🚨 todaysig(唯一有實測成績)⛔ 不可進墓碑', i >= 0 && !/\n\s+todaysig:/.test(blk), '');
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
    o.weakN = Object.keys(P._RADAR_DELETED || {}).length;
    // ⛔ 收起 ≠ 刪除:每一顆 tab 都還在 DOM 裡、還點得到
    o.allAlive = Object.entries(P._RADAR_TABS).every(([, c]) => !!document.getElementById(c.id));
    // 主清單剩幾顆(⛔ 這是「精簡」的實質:第一眼看到的數量)
    const col = bar ? bar.parentElement : null;
    // ⚠️ 只數「真的是策略榜」的 —— radarTabBroker / radarTabChu 是導覽鈕,不在 _RADAR_TABS 裡
    const id2k = Object.fromEntries(Object.entries(P._RADAR_TABS).map(([k, c]) => [c.id, k]));
    o.mainN = col ? [...col.children].filter(e => id2k[e.id] && !P._RADAR_DELETED[id2k[e.id]]).length : -1;
    o.closedAtFirst = wrap ? wrap.classList.contains('hidden') : null;
    // 只搬一次
    P._tidyRadarTabs(); P._tidyRadarTabs();
    o.movedAgain = wrap ? wrap.children.length : -1;
    // 🗑️ V76.1.5 被刪的榜:按鈕**不可以還在 DOM**;程式硬叫它要**安全導回** todaysig
    o.deadBtns = Object.keys(P._RADAR_DELETED || {}).filter(k => document.querySelector(`[onclick*="switchRadarStrategy('${k}')"]`));
    P.switchRadarStrategy('foreign3');
    await new Promise(r => setTimeout(r, 300));
    o.afterDeadKey = P.radarStrategy;
    const hint = document.getElementById('radarMatrixHint');
    P.switchRadarStrategy('todaysig');
    await new Promise(r => setTimeout(r, 300));
    // 🚨 V76.1.4 **每一個榜都要講清楚自己的實測狀態**(⛔ 不可靜默、⛔ 不可含混套同一句)
    o.perTab = {};
    for (const k of Object.keys(P._RADAR_TABS || {})) {
        P.switchRadarStrategy(k);
        await new Promise(r => setTimeout(r, 60));
        o.perTab[k] = hint ? hint.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '';
    }
    o.weakKeys = Object.keys(P._RADAR_DELETED || {});
    o.tabKeys = Object.keys(P._RADAR_TABS || {});
    o.statusKeys = Object.keys(P._RADAR_STATUS || {});
    return o;
});
await browser.close();

// 🗑️🗑️ V76.1.5 使用者:「把沒有用的榜刪除」→ V74.9.0 的「收起來」機制**升級成真的刪掉**。
//   ⛔ 以下 ①~⑦ 是**重新釘新規格**,不是放寬舊斷言。
ok('③ 🗑️ 被刪的榜:按鈕⛔ 不可還留在 DOM 裡', R.deadBtns.length === 0, JSON.stringify(R.deadBtns));
ok('③b ⭐ 摺疊列也跟著消失(沒東西要摺了,⛔ 不可留空殼)', R.hasBar === false && R.hasWrap === false,
   JSON.stringify({ bar: R.hasBar, wrap: R.hasWrap }));
ok('④ ⭐ 程式硬叫已刪的榜要**安全導回** todaysig(⛔ 不可白畫面/停在不存在的榜)',
   R.afterDeadKey === 'todaysig', String(R.afterDeadKey));
ok('④b 主清單精簡到 ≤11 顆(原本 23)', R.tabKeys.length > 0 && R.tabKeys.length <= 11, `n=${R.tabKeys.length}`);
ok('⑤ 留在清單上的每一顆都還點得到', R.allAlive === true);
ok('⑦ 留在清單上的榜 ⛔ 不可誤掛 _radarWeakNote 那個警示區塊',
   !/📉 這個榜本站實測/.test(R.perTab.todaysig || ''), (R.perTab.todaysig || '').slice(0, 100));
// 🚨🚨 V76.1.4 使用者:「16 個榜只有一個有實測成績」→ 量完發現問題不是「榜太多」,
//   而是**中間那幾個什麼都沒說**,而且 `todaysig` 還被印上「未納入歷史回測」= 自己跟自己打架。
const _ALL = Object.keys(R.perTab);
const _silent = _ALL.filter(k => !R.weakKeys.includes(k) && !R.statusKeys.includes(k));
ok('⑨ 🚨 每一個榜都要有實測狀態(📉 沒優勢 / ✅ 有實測 / ⚠️ 間接證據 / 📚 查資料用),⛔ 一個都不可沉默',
   _silent.length === 0, '沉默的:' + JSON.stringify(_silent));
ok('⑨b 🚨 `todaysig` ⛔ 不可再出現「未納入歷史回測」(它是唯一有實測的那個 —— 以前這兩句同時印,自相矛盾)',
   !/未納入歷史回測/.test(R.perTab.todaysig || '') && /有實測成績/.test(R.perTab.todaysig || ''),
   (R.perTab.todaysig || '').slice(-160));
ok('⑨c ⭐ 有實測的要附**基準**(36.4% 不是 50%;⛔ 不可只給勝率)', /36\.4|36%/.test(R.perTab.todaysig || ''), '');
ok('⑨d ⚠️ 只有間接證據的要明說「**這個榜本身沒單獨測過**」,⛔ 不可借別的成績當背書',
   ['rs_strong', 'momentum', 'monster'].every(k => /沒(有)?單獨(回)?測過|沒有回測過/.test(R.perTab[k] || '')),
   JSON.stringify(['rs_strong', 'momentum', 'monster'].map(k => (R.perTab[k] || '').slice(-80))));
const _BADGE = /✅ 這個榜有實測成績|⚠️ 只有間接證據|📚 查資料用,不下多空/;
ok('⑨e ⛔ 降級榜不可同時掛兩段(📉 沒優勢 + 另一個徽章)—— 同一件事講兩遍',
   R.weakKeys.every(k => !_BADGE.test(R.perTab[k] || '')),
   JSON.stringify(R.weakKeys.filter(k => _BADGE.test(R.perTab[k] || ''))));
ok('⑨f ⭐ 非降級榜**一定要**掛到徽章(⛔ 不可只是沒報錯)',
   _ALL.filter(k => !R.weakKeys.includes(k)).every(k => _BADGE.test(R.perTab[k] || '')),
   JSON.stringify(_ALL.filter(k => !R.weakKeys.includes(k) && !_BADGE.test(R.perTab[k] || ''))));
// 🗑️🗑️ V76.1.5 使用者:「把沒有用的榜刪除」→ 那 13 個榜的**入口整組移除**。
//   ⭐ `_RADAR_DELETED` 留著當**墓碑**(記著是被哪支探針、用什麼數字打掉的)——
//      沒有它,下次有人看到「相對強度」「外資連買」又會再做一次(這已經是第 2 輪砍)。
ok('⑩ 🗑️ 被刪掉的榜 ⛔ 不可再出現在 _RADAR_TABS(注入:把任一個加回去 → 紅)',
   R.weakKeys.every(k => !R.tabKeys.includes(k)),
   JSON.stringify(R.weakKeys.filter(k => R.tabKeys.includes(k))));
ok('⑩b ⭐ 墓碑清單**不可被清空**(每一條都要有 why + 來源探針)',
   R.weakKeys.length >= 13, String(R.weakKeys.length));
ok('⑩c ⛔ 主清單一個榜都不可沉默(承 ⑨,刪完之後重驗一次)',
   R.tabKeys.every(k => (R.statusKeys || []).includes(k)),
   JSON.stringify(R.tabKeys.filter(k => !(R.statusKeys || []).includes(k))));
ok('⑧ 無 pageerror', perr.length === 0, perr.join(' | '));

console.log(fails ? `\n❌ ${fails} 條未通過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
