#!/usr/bin/env node
/**
 * 🧭 V74.2.2 K線頁「總覽邏輯」(使用者:「K線頁面我也要用總覽邏輯做」)
 *
 * 版面 = 第一眼只留 ① 頁首一句話結論(#klineLead)② 風險/告警 ③ K線圖;
 * 朱老師總評/六脈/K棒戰法收進「📖 更多解讀」摺疊(⛔ 一張不刪,同 V72.4.7 總覽)。
 *
 * ⛔ 釘死的六件事(⑥⑦ 已用注入缺陷自我驗證):
 *   ① 摺疊**預設收起**(⛔ 不可掛 open —— 掛了等於沒摺,同 test_prohtml ㊲h2 的教訓)
 *   ② 三張卡真的都在摺疊裡;🚨 heavyReboundCard(告警類)必須在摺疊**外**(風險不可收)
 *   ③ 頁首條由 renderKbarTactics 同步渲染(同一份 sigs → 不產生第二份真相)且真的顯示
 *   ④ 頁首條⛔ 不可下指令(單一劇本原則:指令只在總覽「現在怎麼做」)
 *   ⑤ 沒訊號時頁首照樣給「➖ 不做等表態」(⛔ 不可留白讓人以為壞掉)
 *   ⑥ 風險收進摺疊的交換條件:頁首要列出風險**標題**(只寫「有 N 條」= 沒提醒)
 *   ⑦ 六脈亮「強共振」(唯一六關全過的複合訊號)→ 頁首露一行;⛔ 空頭時不露(_bearGate)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails++; };

// ── 靜態 ──
{
    const mWrap = SRC.match(/<details id="chartMoreWrap"[^>]*>/);
    ok('① 摺疊存在且**預設收起**(⛔ 不可掛 open)', !!mWrap && !/\bopen\b/.test(mWrap[0]), mWrap && mWrap[0]);
    const wrapStart = SRC.indexOf('<details id="chartMoreWrap"');
    const wrapEnd = SRC.indexOf('</details>', SRC.indexOf('id="onboard_kline"'));   // 內層教學 details 的收尾之後才是外層
    const seg = SRC.slice(wrapStart, SRC.indexOf('</details>', wrapEnd + 1) + 10);
    ok('② 朱老師總評/六脈/K棒戰法/教學 都在摺疊裡',
        ['id="chuMergedCard"', 'id="chuVerdictCard"', 'id="sixMeridianCard"', 'id="kbarHalfTactics"', 'id="onboard_kline"']
            .every(s => seg.includes(s)), '');
    // 🚨 告警類必須在摺疊外(位置在 chartMoreWrap 之前)
    ok('② 🚨 heavyReboundCard(權值股超跌告警)在摺疊**外**(風險/告警類⛔ 不可收)',
        SRC.indexOf('id="heavyReboundCard"') < wrapStart && SRC.indexOf('id="klineLead"') < wrapStart);
    // ③ 來源:頁首條在 renderKbarTactics 裡渲染(⛔ 不是另一支函式另算一份)
    const fnStart = SRC.indexOf('renderKbarTactics(data) {');
    const fnSeg = SRC.slice(fnStart, fnStart + 26000);
    ok('③ 頁首條由 renderKbarTactics 同步渲染(同一份資料,不產生第二份真相)',
        /klineLead/.test(fnSeg) && /_leadSet\(_headline \+ _leadRisk \+ _leadSix/.test(fnSeg));
    ok('⑤ 沒訊號的分支也要給頁首一句話(➖ 不做等表態)',
        /_leadSet\(`[^`]*一個型態訊號都沒偵測到/.test(fnSeg));
    ok('⑦ 六脈頁首那行要過 _bearGate(空頭不露)且附實測數字、⛔ 不下指令',
        /startsWith\('🔴'\) && !this\._bearGate/.test(fnSeg) && /\+0\.80 個百分點/.test(fnSeg));
}

// ── 動態(真引擎 headless)──
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderKbarTactics, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const o = {};
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze('2330', true, false, true); } catch (e) { return { err: String(e).slice(0, 160) }; }
    try { app.switchSubTab('chart'); } catch (_) { }
    await new Promise(r => setTimeout(r, 1500));
    const lead = document.getElementById('klineLead');
    o.leadShown = !!lead && !lead.classList.contains('hidden') && lead.innerText.replace(/\s/g, '').length > 20;
    o.leadTxt = lead ? lead.innerText.replace(/\s+/g, ' ') : '';
    const wrap = document.getElementById('chartMoreWrap');
    o.wrapClosed = !!wrap && wrap.open === false;
    o.inWrap = !!wrap && !!wrap.querySelector('#chuMergedCard');

    // ⑥ 風險標題要列在頁首 —— 用合成資料強制做出一個 bear 訊號(今收跌破昨低=收盤轉弱),
    //    並 stub _sigEdge 讓它進 A 級 risk 區(⛔ 不 stub 的話這條會依當天資料時有時無 = 空過)
    const realEdge = app._sigEdge, realSym = app.currentSymbolId;
    app._sigEdge = () => ({ grade: 'A', n: 100, e10: 1, w10: 45, p: 0.01, e20: 1, payoff: 1.2, exp: 0.5 });
    app.currentSymbolId = '9999';
    const mk = (c, h, l, v) => ({ date: '2026-01-01', open: c, high: h, low: l, close: c, volume: v });
    const dataR = Array.from({ length: 260 }, () => mk(100, 101, 99, 1000));
    dataR.push({ date: '2026-01-02', open: 98, high: 98.5, low: 94.8, close: 95, volume: 1200 });   // 跌破昨低 99
    app.renderKbarTactics(dataR);
    const leadR = (document.getElementById('klineLead') || { innerText: '' }).innerText.replace(/\s+/g, ' ');
    o.riskLead = leadR;
    o.riskListed = /⚠️ 風險提醒 \d+ 條:/.test(leadR) && /收盤轉弱|大量長黑|轉弱/.test(leadR);

    // ⑦ 六脈強共振:stub 亮紅 → 頁首要露;_bearGate=true → 不露
    const realSix = app._sixMeridianCalc, realBear = app._bearGate;
    app._sixMeridianCalc = () => ({ verdict: '🔴 強共振・買點', okN: 5, tone: 'red', cond: [] });
    app._bearGate = () => false;
    app.renderKbarTactics(dataR);
    o.sixOn = /(強共振)[\s\S]*\+0\.80 個百分點/.test((document.getElementById('klineLead') || { innerText: '' }).innerText);
    app._bearGate = () => true;
    app.renderKbarTactics(dataR);
    o.sixOffBear = !/六脈共振亮/.test((document.getElementById('klineLead') || { innerText: '' }).innerText);
    app._sixMeridianCalc = realSix; app._bearGate = realBear; app._sigEdge = realEdge; app.currentSymbolId = realSym;

    // ⑤ 資料不足 → 頁首要收掉(⛔ 不可殘留上一檔)
    app.renderKbarTactics([]);
    o.leadGone = (document.getElementById('klineLead') || { classList: { contains: () => true } }).classList.contains('hidden');
    return o;
});
await browser.close();
if (R.err) { console.log(`❌ analyze 失敗:${R.err}`); process.exit(1); }

ok('③ 頁首一句話真的顯示(真實 2330)', R.leadShown && /一句話結論|不做/.test(R.leadTxt), R.leadTxt.slice(0, 120));
ok('④ ⛔ 頁首不下指令、不給價位(單一劇本:指令在總覽),而且要指路總覽',
    !/可進場|買進 \d|掛單|停損 \d|目標價 \d/.test(R.leadTxt) && /總覽/.test(R.leadTxt), R.leadTxt.slice(0, 160));
ok('① 摺疊實跑也是收起的、卡在裡面', R.wrapClosed && R.inWrap, JSON.stringify({ c: R.wrapClosed, i: R.inWrap }));
ok('⑥ ⭐ 風險提醒的**標題**要列在頁首(⛔ 只寫「有 N 條」= 沒提醒)', R.riskListed, R.riskLead.slice(0, 200));
ok('⑦ 六脈亮「強共振」→ 頁首露一行(附實測 +0.80)', R.sixOn === true, '');
ok('⑦b ⛔ 空頭(_bearGate)時六脈那行不露(講反話鐵則)', R.sixOffBear === true, '');
ok('⑤b 資料不足時頁首收掉(⛔ 不殘留上一檔)', R.leadGone === true, '');

console.log(fails ? `❌ ${fails} 條失敗` : '✅ KLINELEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
