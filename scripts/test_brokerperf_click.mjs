#!/usr/bin/env node
/**
 * 🧙 券商勝率榜「點一列要展開分點明細」(V73.2.7)
 *
 * 🐛 使用者回報:「券商勝率榜點分點券商沒有辦法點進去它買了什麼個股」。
 *    真因:`_renderRadarBroker` 只認 **#radarBrokerDetail** 這一個容器,
 *    而「券商勝率」那個分類(`_renderBrokerCat('perf')`)**只吐 #brokerPerfBox**
 *    → `if (!el) return;` → 點下去**零反應、零錯誤訊息**。
 *    ⚠️ 這一類最難發現:沒有例外、沒有紅字,只是什麼都不發生。
 *
 * ⛔ 三條釘死:
 *   ① 明細 HTML 必須是**共用函式** `_brokerDetailHtml`(⛔ 不可為勝率榜複製第二份版面,陷阱 #37)
 *   ② 在**只有 brokerPerfBox** 的環境下點一列 → 一定要生出 #brokerPerfDetail 且**有內容**
 *   ③ 再點一次要收起(⛔ 不可越點越多層)
 *   ④ 明細裡的**股票**要能跳個股頁(openStockFromRadar);分點名⛔不跳(它不是股票)
 *   ⑤ 沒有資料時要**指名是哪一家**(陷阱 #19:不寫名字 = 使用者分不出「沒資料」還是「壞了」)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

// ── ① 靜態:共用函式存在,而且被兩邊都接上 ────────────────────────────
ok('①a 有共用函式 _brokerDetailHtml', /_brokerDetailHtml\s*\(bn\)\s*\{/.test(src));
ok('①b _renderRadarBroker 呼叫共用函式(⛔ 不可自己再寫一份)',
    /_renderRadarBroker\(bn\)\s*\{[\s\S]{0,420}?_brokerDetailHtml\(bn\)/.test(src));
ok('①c 勝率榜也呼叫同一支(⛔ 不可複製第二份版面)',
    /id="brokerPerfDetail"[\s\S]{0,900}?_brokerDetailHtml\(this\._perfBrokerCur\)/.test(src));
ok('①d _renderRadarBroker 沒有容器時⛔不可直接 return(那就是「按了沒反應」)',
    !/_renderRadarBroker\(bn\)\s*\{\s*const el = this\._brokerEl\('radarBrokerDetail'\);\s*if \(!el\) return;/.test(src));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderBrokerPerfHtml, null, { timeout: 20000 });

// 造一個「只有 brokerPerfBox、⛔ 沒有 radarBrokerDetail」的環境 —— 就是使用者踩到的那個
const setup = (withBook) => page.evaluate(w => {
    document.querySelectorAll('#radarBrokerDetail,#radarBrokerSel').forEach(n => n.remove());
    let box = document.getElementById('brokerPerfBox');
    if (!box) { box = document.createElement('div'); box.id = 'brokerPerfBox'; document.body.appendChild(box); }
    app._perfBrokerCur = '';
    app._brokerPerf = {
        signals: 120, days: 30,
        swing: [{ broker: '凱基台北', win_rate: 71, avg_ret: 3.2, count: 42 },
                { broker: '元大土城永寧', win_rate: 63, avg_ret: 1.8, count: 31 }],
    };
    app._brokerPerfMode = 'swing';
    app._radarData = { brokers: { 凱基台北: { buy: [{ sym: '2330', net: 88000000 }], sell: [{ sym: '2317', net: -12000000 }] } } };
    if (w) {
        app._brokerBook = { brokers: { 凱基台北: { name: '凱基台北', tags: [], win: {}, periods: { '1d': { buy: [{ sym: '2330', net: 88000000 }], sell: [] } } } } };
        try { app._buildBookIndex(); } catch (_) {}
    } else { app._brokerBook = null; app._bookNorm = {}; }
    box.innerHTML = app._renderBrokerPerfHtml();
    return box.innerHTML.length;
}, withBook);

// ── ② 沒有 radarBrokerDetail 時,點一列必須有反應 ────────────────────
await setup(false);
ok('②a 榜單先渲染出來(前置條件成立,⛔ 免得後面驗到空的)', (await page.evaluate(() => document.getElementById('brokerPerfBox').innerText)).includes('凱基台北'));
ok('②b 一開始不該有明細框(⛔ 不留空殼)', await page.evaluate(() => !document.getElementById('brokerPerfDetail')));

const click1 = await page.evaluate(() => {
    app._perfBrokerOpen('凱基台北');
    const d = document.getElementById('brokerPerfDetail');
    return { has: !!d, txt: d ? d.innerText : '' };
});
ok('②c 點一列 → 生出 #brokerPerfDetail', click1.has);
ok('②d 明細**有內容**(⛔ 空的等於沒修好)', (click1.txt || '').replace(/\s/g, '').length > 20, JSON.stringify(click1.txt).slice(0, 160));
ok('②e 明細真的列出它買的股票(2330)', (click1.txt || '').includes('2330'), click1.txt.slice(0, 160));

// 舊路徑也要通:在沒有 radarBrokerDetail 的頁面呼叫 _renderRadarBroker 不可靜默失敗
const viaOld = await page.evaluate(() => {
    app._perfBrokerCur = '';
    document.getElementById('brokerPerfBox').innerHTML = app._renderBrokerPerfHtml();
    app._renderRadarBroker('凱基台北');
    const d = document.getElementById('brokerPerfDetail');
    return d ? d.innerText.length : 0;
});
ok('②f 舊入口 _renderRadarBroker 在這一頁也要落地(⛔ 不可靜默 return)', viaOld > 20, `len=${viaOld}`);

// ── ③ 再點一次收起 ──────────────────────────────────────────────
const click2 = await page.evaluate(() => { app._perfBrokerOpen('凱基台北'); return !!document.getElementById('brokerPerfDetail'); });
ok('③a 再點同一列 → 收起', !click2);
const click3 = await page.evaluate(() => {
    app._perfBrokerOpen('凱基台北'); app._perfBrokerOpen('元大土城永寧');
    return { n: document.querySelectorAll('#brokerPerfDetail').length, cur: app._perfBrokerCur };
});
ok('③b 換一列 → 明細只會有一個(⛔ 不可越點越多層)', click3.n === 1, JSON.stringify(click3));
ok('③c 換一列 → 目前選的跟著換', click3.cur === '元大土城永寧', click3.cur);

// ── ④ 明細裡股票可跳、分點名不可跳 ──────────────────────────────
const links = await page.evaluate(() => {
    app._perfBrokerCur = '';
    app._perfBrokerOpen('凱基台北');
    const d = document.getElementById('brokerPerfDetail');
    return d ? d.innerHTML : '';
});
ok('④a 明細裡的股票掛 openStockFromRadar(點得進個股頁)', /openStockFromRadar\('2330'\)/.test(links));
ok('④b ⛔ 分點名不可掛 analyze/openStock(分點不是股票)',
    !/app\.analyze\('凱基台北'\)/.test(links) && !/openStockFromRadar\('凱基台北'\)/.test(links));
ok('④c 說明有講清楚「不會跳個股頁」', /不會跳個股頁/.test(await page.evaluate(() => document.getElementById('brokerPerfBox').innerText)));

// ── ⑤ 沒資料時要指名是哪一家 ────────────────────────────────────
const empty = await page.evaluate(() => {
    app._brokerBook = null; app._bookNorm = {}; app._radarData = { brokers: {} };
    app._perfBrokerCur = '';
    document.getElementById('brokerPerfBox').innerHTML = app._renderBrokerPerfHtml();
    app._perfBrokerOpen('元大土城永寧');
    const d = document.getElementById('brokerPerfDetail');
    return d ? d.innerText : '';
});
ok('⑤a 沒資料也要顯示訊息(⛔ 不可整片空白)', empty.replace(/\s/g, '').length > 10, JSON.stringify(empty).slice(0, 160));
ok('⑤b 訊息要**指名是哪一家**(陷阱 #19)', empty.includes('元大土城永寧'), empty.slice(0, 160));

ok('⑥ 全程無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
