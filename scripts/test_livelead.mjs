#!/usr/bin/env node
/**
 * 🧭 V74.2.4 即時頁「總覽邏輯」(使用者:「即時頁面也依照邏輯做」)
 *
 * 版面 = ① 頁首一句話結論(#liveLead)② 分時圖(主內容,盤中要盯的就是它);
 * 當沖總結燈完整卡 + 盤中作戰室收進「📖 更多解讀」(⛔ 一張不刪,同 K線 V74.2.2 / 籌碼 V74.2.3)。
 *
 * ⚠️ 即時頁**沙箱量不準**:多數卡要 Fugle 金鑰 + 盤中才有內容(陷阱 #40)——
 *    所以這支一律**直接餵資料呼叫渲染函式**,⛔ 不靠「今天剛好有沒有盤中資料」。
 *
 * ⛔ 釘死的六件事(③⑤⑥ 已用注入缺陷自我驗證):
 *   ① 摺疊存在且**預設收起**(⛔ 不可掛 open);兩張卡真的在裡面
 *   ② 頁首由 `renderDayTradeLight` 同步渲染、只轉述 `_dayTradeVerdict`(⛔ 不重算 = 不產生第二份真相)
 *   ③ 🚨 「別追多警訊」的**內容**要露在頁首(只寫「有 N 條」= 沒提醒)
 *   ④ 頁首要有大字結論 + ✅操作 + 進場檢查 N/M + 成本免責
 *   ⑤ 沒資料(盤後/沒金鑰)→ 頁首收掉、摺疊外殼也收掉(⛔ 不留點開什麼都沒有的橫條)
 *   ⑥ 切股要清乾淨(⛔ 不殘留上一檔的「操作」那句)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 220)}`}`); if (!c) fails++; };

// ── 靜態 ──
{
    const m = SRC.match(/<details id="liveMoreWrap"[^>]*>/);
    ok('① 摺疊存在且**預設收起**(⛔ 不可掛 open)', !!m && !/\bopen\b/.test(m[0]), m && m[0]);
    const s = SRC.indexOf('<details id="liveMoreWrap"'), e = SRC.indexOf('</details>', s);
    const seg = SRC.slice(s, e);
    ok('① 當沖總結燈 + 盤中作戰室 都在摺疊裡',
        seg.includes('id="dayTradeLight"') && seg.includes('id="intradayWarRoom"'));
    ok('① 頁首(#liveLead)在摺疊**外**', SRC.indexOf('id="liveLead"') < s);
    // ⚠️ 取樣範圍要**切到函式自己結束為止** —— 第一版固定取 3000 字,越界到下一個
    //    `renderDayTradeLight`(它本來就該呼叫 `_dayTradeVerdict`)→ 假失敗。
    //    ⭐ 這是「斷言前先確認取樣的是不是你以為的那一段」(本 session 第 2 次踩)。
    const f = SRC.indexOf('_renderLiveLead(v) {');
    const fseg = SRC.slice(f, f + SRC.slice(f).indexOf('\n    },'));
    ok('② ⭐ 頁首只轉述 `_dayTradeVerdict` 的結果(⛔ 不自己再算一次)',
        /\$\{v\.verdict\}/.test(fseg) && /\$\{v\.sop\}/.test(fseg) && !/_dayTradeVerdict\(/.test(fseg),
        `fnLen=${fseg.length}`);
    ok('② 由 renderDayTradeLight 同步呼叫(v 算完立刻給頁首,含 v=null 的情況)',
        /let v = null; try \{ v = this\._dayTradeVerdict\(bars, q\); \} catch \(_\) \{\}\s*\n\s*\/\/[^\n]*\n\s*try \{ this\._renderLiveLead\(v\); \} catch/.test(SRC));
    ok('⑥ 切股清空清單要含 liveLead / dayTradeLight / intradayWarRoom',
        /'liveLead', 'dayTradeLight', 'intradayWarRoom'/.test(SRC));
}

// ── 動態(直接餵資料,⛔ 不靠盤中)──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderDayTradeLight, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const o = {};
    try { app.switchAppTab('diag'); app.switchSubTab('live'); } catch (_) { }
    await new Promise(r => setTimeout(r, 500));
    // 🚧 空過守門:先確認 stub 真的被走到(⛔ 否則下面全是假通過)
    const real = app._dayTradeVerdict;
    const V = {
        verdict: '🔴 站上均價・偏多', tone: 'red', sop: '守均價 123.4,跌破就走。',
        warns: ['爆量長黑壓在上方', '外盤佔比正在縮'], chk: [{ t: 'x', ok: true }], chkOk: 4, chkApplic: 6,
        bull: ['a'], bear: [], hasReal: true, dir: 'long',
    };
    app._dayTradeVerdict = () => V;
    app.renderDayTradeLight([{ close: 100, average: 99, volume: 10 }], { price: 100, prevClose: 99 });
    const lead = document.getElementById('liveLead');
    o.shown = !!lead && !lead.classList.contains('hidden');
    o.txt = lead ? lead.innerText.replace(/\s+/g, ' ') : '';
    o.wrapShown = !document.getElementById('liveMoreWrap').classList.contains('hidden');
    o.closed = document.getElementById('liveMoreWrap').open === false;
    o.cardInside = !!document.getElementById('liveMoreWrap').querySelector('#dayTradeLight');
    o.cardLen = document.getElementById('dayTradeLight').innerHTML.length;

    // ③ 警訊「內容」要露(⛔ 不是只寫有幾條)
    o.warnOk = /別追多警訊 2 條/.test(o.txt) && /爆量長黑壓在上方/.test(o.txt);
    // 沒有警訊時⛔ 不留空行
    app._dayTradeVerdict = () => ({ ...V, warns: [] });
    app.renderDayTradeLight([{ close: 100, average: 99, volume: 10 }], { price: 100, prevClose: 99 });
    o.noWarnTxt = document.getElementById('liveLead').innerText.replace(/\s+/g, ' ');
    o.warnGone = !/別追多警訊/.test(o.noWarnTxt);

    // ⑤ 沒資料 → 頁首收掉 + 摺疊外殼也收掉
    app._dayTradeVerdict = () => null;
    app.renderDayTradeLight([], null);
    o.leadGone = document.getElementById('liveLead').classList.contains('hidden');
    o.wrapGone = document.getElementById('liveMoreWrap').classList.contains('hidden');
    // 🚧 空過守門:資料回來要能再顯示(⛔ 否則「收掉」可能只是它壞了)
    app._dayTradeVerdict = () => V;
    app.renderDayTradeLight([{ close: 100, average: 99, volume: 10 }], { price: 100, prevClose: 99 });
    o.backAgain = !document.getElementById('liveLead').classList.contains('hidden')
        && !document.getElementById('liveMoreWrap').classList.contains('hidden');
    // ⑥ 切股清空
    try { app._clearLivePanels(); } catch (_) { }
    o.clearedLead = document.getElementById('liveLead').classList.contains('hidden')
        && document.getElementById('liveLead').innerHTML === '';
    o.clearedWrap = document.getElementById('liveMoreWrap').classList.contains('hidden');
    app._dayTradeVerdict = real;
    return o;
});
await browser.close();

ok('④ 頁首顯示,而且有大字結論 + ✅操作',
    R.shown && /站上均價/.test(R.txt) && /✅ 操作/.test(R.txt), R.txt.slice(0, 140));
ok('④b 頁首要帶「進場檢查 N/M」與當沖成本免責(⛔ 不可只給方向)',
    /進場檢查 4\/6 成立/.test(R.txt) && /0\.25%/.test(R.txt) && /不是必賺/.test(R.txt), R.txt.slice(-200));
ok('① 摺疊實跑收起、完整卡片在裡面、⛔ 收起 ≠ 刪除',
    R.closed && R.cardInside && R.cardLen > 500, JSON.stringify({ c: R.closed, i: R.cardInside, len: R.cardLen }));
ok('③ 🚨 警訊「內容」要露在頁首(⛔ 只寫有幾條 = 沒提醒)', R.warnOk, R.txt.slice(0, 260));
ok('③b 沒有警訊時⛔ 不留那一行(條件觸發)', R.warnGone === true, R.noWarnTxt.slice(0, 160));
ok('⑤ 沒資料時頁首收掉、⛔ 摺疊外殼也要收(不留點開什麼都沒有的橫條)',
    R.leadGone && R.wrapGone, JSON.stringify({ l: R.leadGone, w: R.wrapGone }));
ok('⑤b 🚧 空過守門:資料回來要能再顯示', R.backAgain === true, '');
ok('⑥ 切股(_clearLivePanels)要把頁首與外殼一起清(⛔ 不殘留上一檔)',
    R.clearedLead && R.clearedWrap, JSON.stringify({ l: R.clearedLead, w: R.clearedWrap }));

console.log(fails ? `❌ ${fails} 條失敗` : '✅ LIVELEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
