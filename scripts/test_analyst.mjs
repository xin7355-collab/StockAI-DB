#!/usr/bin/env node
/**
 * 🎙️ 消息面三格 + 財經分析師焦點(V72.6.2)
 *
 * 使用者要求:消息面分成「新聞焦點 / 財經行事曆 / 財經分析師焦點」,
 * 分析師收 兆華與股惑仔・兆華艾綸說・股癌・郭哲榮,分析標的,
 * 「關注它們說的時候的價格」。
 *
 * ⛔⛔ 這支最重要的任務是**擋住把它做成訊號**:
 *    名嘴說法的預測力從來沒被驗證過,而且 CLAUDE.md 對郭哲榮那份評估已寫明
 *    他「準」的一半是話術結構(條件式預告的不對稱性、雙向皆贏)。
 *    → 只准事實描述 + 價格快照,⛔ 不准出現多空/進場/勝率。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 280)}`}`); if (!c) fails.push(n); };

const FIX = {
    updated: '2026-08-06 22:10',
    analysts: [
        { k: 'gooaye', n: '股癌 Gooaye', tag: '🎧 Podcast', src: 'Podcast RSS', error: null, fresh: 2,
          items: [
              { t: '台積電還能不能追?順便聊鴻海', u: 'https://x/1', d: '2026-08-04', kind: 'podcast',
                syms: [{ s: '2330', n: '台積電', px: 1000, pxd: '2026-08-04', mkt: 23000, pxn: 1100, mktn: 24150 },
                       { s: '2317', n: '鴻海', px: 250, pxd: '2026-08-04', mkt: 23000, pxn: 240, mktn: 24150 }] },
              { t: '大盤到底崩不崩', u: 'https://x/2', d: '2026-08-02', kind: 'podcast', syms: [] },
          ] },
        { k: 'kuo_zhe_rong', n: '郭哲榮分析師', tag: '📺 YouTube', src: 'Google News 搜尋「郭哲榮」', fresh: 0,
          error: '本輪沒抓到新的(YouTube 全部候選 handle 都解析不到);以下是先前存下來的 1 則',
          items: [{ t: '郭哲榮:破四萬我就買 0050', u: 'https://x/3', d: '2026-08-01', kind: 'news', syms: [] }] },
    ],
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderAnalystFocus, null, { timeout: 20000 });

const R = await page.evaluate(d => {
    app._twiiRows = [{ date: '2026-08-04', close: 23000 }, { date: '2026-08-06', close: 24150 }];
    app._liveQuotes = null;
    app.switchAppTab('market');
    app.switchMarketSubTab('global');
    app.switchNewsPane('analyst');
    app._renderAnalystFocus(d);
    const vis = k => {
        const el = document.querySelector(`[data-newspane-body="${k}"]`);
        return !!el && el.style.display !== 'none';
    };
    return {
        txt: (document.getElementById('analystFocusBox').innerText || '').replace(/\s+/g, ' '),
        ts: document.getElementById('analystTs').textContent,
        panes: { news: vis('news'), cal: vis('cal'), analyst: vis('analyst') },
        // 切回新聞焦點,行事曆與分析師都要收起來
        after: (() => { app.switchNewsPane('news'); return { news: vis('news'), cal: vis('cal'), analyst: vis('analyst') }; })(),
        // 三張既有卡的 DOM id 必須都還在(⛔ 拆分頁不可動到 id,不然 JS 全斷)
        keptIds: ['globalNewsList', 'macroEventsList', 'newsDeepBtn', 'analystFocusBox'].filter(i => !!document.getElementById(i)),
    };
}, FIX);

// ── ① 三格分頁互斥 ─────────────────────────────────────────────────────
ok('① 選「分析師焦點」時只顯它', R.panes.analyst && !R.panes.news && !R.panes.cal, JSON.stringify(R.panes));
ok('① 切回「新聞焦點」時只顯它', R.after.news && !R.after.cal && !R.after.analyst, JSON.stringify(R.after));
ok('① ⭐ 既有三張卡的 DOM id 全保留(⛔ 拆分頁不可動 id)', R.keptIds.length === 4, JSON.stringify(R.keptIds));

// ── ② 內容:標題 + 日期 + 來源層級 ───────────────────────────────────────
ok('② 顯示分析師名稱', /股癌/.test(R.txt) && /郭哲榮/.test(R.txt), R.txt.slice(0, 160));
ok('② 顯示標題', /台積電還能不能追/.test(R.txt), R.txt.slice(0, 220));
ok('② ⭐ 要標來源層級(單集標題 / 媒體報導)', /單集標題/.test(R.txt) && /媒體報導/.test(R.txt), R.txt.slice(0, 400));
ok('② ⭐ 媒體報導那條要講明「不是他本人的節目」', /不是他本人的節目/.test(R.txt), R.txt.slice(0, 500));
ok('② 更新時間有帶入', R.ts === '2026-08-06 22:10', R.ts);

// ── ③ ⭐⭐ 價格快照:他講的那天 → 現在,而且要跟大盤比 ────────────────
ok('③ ⭐ 顯示「他講那天的價格」', /@1000\.00/.test(R.txt), R.txt.slice(0, 400));
ok('③ ⭐ 顯示至今漲跌(1000→1100 = +10.0%)', /\+10\.0%/.test(R.txt), R.txt.slice(0, 400));
// 大盤同期 23000→24150 = +5.0% → 台積電贏 5.0pp、鴻海 (250→240 = −4.0%) 輸 9.0pp
ok('③ ⭐⭐ 一定要跟大盤比(贏 5.0pp)', /贏大盤5\.0pp/.test(R.txt.replace(/\s/g, '')), R.txt.slice(0, 400));
ok('③ ⭐ 輸大盤的也要標出來(鴻海 −4.0% → 輸 9.0pp)', /輸大盤9\.0pp/.test(R.txt.replace(/\s/g, '')), R.txt.slice(0, 500));
ok('③ 標題沒提到台股 → 誠實說沒有(⛔ 不留空白)', /標題沒提到可辨識的台股/.test(R.txt), R.txt.slice(0, 600));

// ── ④ 抓不到時要寫原因(陷阱 #22)─────────────────────────────────────
ok('④ ⭐ 本輪沒抓到新的要顯示原因', /本輪沒抓到新的/.test(R.txt), R.txt.slice(0, 700));

// ── ⑤ ⛔⛔ 不可做成訊號 ────────────────────────────────────────────────
//    ⚠️ 先 strip 掉免責句 —— 正確的免責本身含被禁字串(本 session 第 10 次踩到)
const clean = R.txt.replace(/⛔[^⚠⭐📅]*/g, '').replace(/不能[^。]*/g, '').replace(/這頁只做[^。]*/g, '');
ok('⑤ ⛔ 不可出現多空判斷', !/(偏多|偏空|看多|看空|多方優勢|空方優勢)/.test(clean), clean.slice(0, 300));
ok('⑤ ⛔ 不可出現操作指令', !/(可以進場|建議買|該買|該賣|可加碼|停損價)/.test(clean), clean.slice(0, 300));
ok('⑤ ⛔ 不可出現勝率/準確率', !/(勝率|準確率|命中率)/.test(clean), clean.slice(0, 300));
ok('⑤ ⭐ 必須寫明「不下多空、不計分」', /不下多空/.test(R.txt) && /不計分/.test(R.txt), R.txt.slice(-500));
ok('⑤ ⭐ 必須寫明「只有標題、沒有逐字稿」', /沒有逐字稿/.test(R.txt), R.txt.slice(-500));
ok('⑤ ⭐ 必須寫明「標的是從文字抽的」', /從文字抽的/.test(R.txt), R.txt.slice(-500));
ok('⑤ ⭐ 必須提醒「簡介抽的證據較弱」', /證據比標題弱/.test(R.txt), R.txt.slice(-500));
ok('⑤ ⭐ 必須寫明樣本還不夠、不能說誰準', /樣本還不夠/.test(R.txt), R.txt.slice(-400));

// ── ⑥ 沒有資料時的誠實空狀態 ──────────────────────────────────────────
const E = await page.evaluate(async () => {
    app._analystCache = null;
    const box = document.getElementById('analystFocusBox');
    box.innerHTML = '';
    await app._loadAnalystFocus();          // file:// 下 fetch 一定失敗 → 走 catch
    return (box.innerText || '').replace(/\s+/g, ' ');
});
ok('⑥ 拿不到資料 → 誠實說還沒供應(⛔ 不留空白也不假造)', /還沒開始供應/.test(E), E.slice(0, 200));

ok('⑦ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:\n - ${fails.join('\n - ')}` : '\n✅ ANALYST_TEST_PASS');
process.exit(fails.length ? 1 : 0);
