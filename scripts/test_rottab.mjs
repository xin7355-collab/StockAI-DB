#!/usr/bin/env node
/**
 * 💧 V76.0.3 大盤頁第 4 格「板塊輪動」測試
 *
 * 使用者:「新增市場板塊輪動頁面,放在盤前檢視右手邊,把市場板塊輪動移到這裡面;
 *          PRO 的板塊輪動要不要?我不要資料太亂,應該簡化還有重新設計介面」
 *
 * ⛔ 這支要擋住的(每條先想「注入什麼它會叫」):
 *   ① 按鈕位置錯(不在盤前檢視右邊)              ② 搬卡漏 id / id 重複(陷阱:搬卡必驗唯一性)
 *   ③ 🚨 名次自己算一份(⛔ 唯一真相 = _regimeStats)  ④ 390px / 橫版溢出
 *   ⑤ 這一頁下操作指令(它只准描述)              ⑥ 選股快照沒載到 → 空殼(要誠實空狀態)
 *   ⑦ 切到 rot 時別格還露出來                     ⑧ 實測數字沒帶來源(🧹 V78.3.6 起依據只在常數,畫面⛔ 不印數字/探針名)
 *
 * 測資:真實 gh-pages 的 screener.json(本機 data/ 退回);抓不到就誠實 exit 1(陷阱 #40)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };
if (!fs.existsSync(path.join(ROOT, 'data', 'screener.json'))) { console.log('❌ 沒有 data/screener.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試'); process.exit(1); }

// ── 靜態 ──
ok('① 按鈕順序:行情 → 盤前檢視 → 💧板塊輪動 → 消息面(注入:搬回最後 → 必紅)',
   /id="subTab_tw2"[\s\S]{0,600}?id="subTab_rot"[\s\S]{0,600}?id="subTab_global2"/.test(SRC));
// ⚡ V79.9.6 使用者:「📊市場板塊輪動內容改成概念股盤中即時更新」→ 舊的美股對標卡 6 個 id 拿掉(⛔ 不可復活)
const GONE = ['sectorSource', 'sectorIntradayBtn', 'sectorIntradayBar', 'sectorIdxStrip', 'sectorAiResult', 'predictGapTableResult'];
const NEWID = ['conceptLiveCard', 'conceptLiveBox', 'conceptLiveBtn', 'conceptLiveWhen'];
ok('②a 舊美股對標卡 6 個 id 都不在了;新卡 4 個 id 各出現一次', GONE.every(id => !SRC.includes(`id="${id}"`)) && NEWID.every(id => (SRC.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1),
   GONE.filter(id => SRC.includes(`id="${id}"`)).join(','));
ok('②a2 舊卡只為它活著的程式一起刪(⛔ 盤中再打 FinMind / Fugle 去填不存在的格子)', !/refreshSectorIntraday|_refreshOfficialSectorIdx|_restoreSectorIntradayMemory|renderSectorGapTable|_secSort\(/.test(SRC));
{
    const i = SRC.indexOf('id="subContent_rot"'), j = SRC.indexOf('id="subContent_global"', i);
    const seg = SRC.slice(i, j);
    ok('②b 新卡的 id 全部落在 #subContent_rot 裡', i > 0 && j > i && NEWID.every(id => seg.includes(`id="${id}"`)), NEWID.filter(id => !seg.includes(`id="${id}"`)).join(','));
    ok('②c 行情格原位留了指路註解', /市場板塊輪動」卡已搬到第 4 格/.test(SRC));
}
{
    // ⛔ 先剝註解 —— 說明「不可自己從 sector_rot 排」的註解本身就含被禁字串(本專案第 17 次踩)
    const strip = x => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '');
    const fn = strip(SRC.slice(SRC.indexOf('    _ROT_EDGE: {'), SRC.indexOf('    switchSccTab(tab) {')));   // 含 _ROT_EDGE(來源探針寫在那裡)
    ok('③a 🚨 名次只准讀 _regimeStats(),⛔ 不可自己從 sector_rot 排(注入:改讀 _loadSectorRot 排 → 必紅)',
       /_regimeStats\(W\)/.test(fn) && !/_loadSectorRot|sector_rot\.json|\bsector_rot\b|\.r20\b/.test(fn), '');   // ⚠️ \b:別把來源名 sector_rotation_probe 誤判成違規  ⚠️ V77.2.0 起帶天期參數(`W`)
    // 🧹 V78.3.6 散戶 App⛔ 不印實測數字 / 探針名 → 依據只留在常數裡(背後判斷用),畫面另由 ⑧c 驗
    ok('⑧ 🧹 V78.3.6 實測依據留在 `_ROT_EDGE` 常數(來源探針 + 20 日窗口),⛔ 不靠畫面文字', /src: 'sector_rotation_probe/.test(fn) && /win: 20\b/.test(fn));
    ok('⑤a 原始碼裡不寫操作指令詞', !/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多|買進這|進場買)/.test(fn));
}

// ── 動態 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
async function boot(viewport) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported/.test(m)) errs.push(m.slice(0, 160)); });
    await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app.switchMarketSubTab, null, { timeout: 25000 });
    await page.waitForTimeout(2500);
    return page;
}
const page = await boot({ width: 390, height: 844 });
const r = await page.evaluate(async () => {
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 3500));
    // 🏭 ③b/③c/⑧b 驗的是**官方產業 + 20 日**那一頁(實測背書只在這一格)——
    //   V77.1.7 起預設是「概念股」、V77.2.0 起天期可切 → ⭐ 測試要**自己把情境擺回來**,
    //   ⛔ 不是放寬斷言(那三條在 V77.1.7 之後一直是紅的 = 等於沒有測試)。
    app.switchRotView('ind'); app.switchRotWin(20);
    await new Promise(r => setTimeout(r, 1200));
    const vis = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
    const S = app._regimeStats(20);
    const truth = S ? [...S.imed.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]) : null;
    const shown = [...document.querySelectorAll('[data-rotrank]')].map(e => e.getAttribute('data-rotind'));
    const lead = document.getElementById('rotLead').innerText.replace(/\s+/g, ' ');
    const card = document.getElementById('rotRankCard').innerText.replace(/\s+/g, ' ');
    window.scrollTo(80, 0);
    return { vis: { idx: vis('subContent_idx'), ad: vis('subContent_advice'), tw: vis('subContent_tw'), rot: vis('subContent_rot'), g: vis('subContent_global') },
             truth, shown, lead, card, scrollX: window.scrollX, m: S ? S.imed.size : 0,
             hasGap: !!document.querySelector('#subContent_rot #conceptLiveBox'), btnRot: !!document.getElementById('subTab_rot') };
});
ok('⑦ 切到 rot:只有 subContent_rot 露出來', r.vis.rot && !r.vis.idx && !r.vis.ad && !r.vis.tw && !r.vis.g, JSON.stringify(r.vis));
ok('③b ⭐⭐ 32 列的順序 = _regimeStats().imed 由強到弱(一字不差)', r.truth && r.shown.length === r.truth.length && r.shown.every((k, i) => k === r.truth[i]), `${r.shown.slice(0, 4)} vs ${r.truth && r.truth.slice(0, 4)}`);
ok('③c 一句話寫的最強/最弱 3 族 = 排名的頭尾 3', r.truth && r.truth.slice(0, 3).every(k => r.lead.includes(k)) && r.truth.slice(-3).every(k => r.lead.includes(k)), r.lead.slice(0, 160));
// 🧹 V78.3.6 +1.44pp 不再印給散戶;20 日官方產業那一頁只留「怎麼做」那句(避開最弱)
const _RES = /1\.44pp|實測|回測|探針|_probe|\.mjs|勝率|期望值|對照組/;
ok('⑧b 🧹 V78.3.6 一句話留「避開最弱」(⛔ 不印 +1.44pp)', !/\+1\.44pp/.test(r.lead) && /避開最弱/.test(r.lead), r.lead.slice(0, 200));
ok('⑧c 🧹 V78.3.6 一般模式頁首⛔ 不可出現實測數字 / 探針名 / 研究字樣', !_RES.test(r.lead), (r.lead.match(_RES) || [''])[0] + ' … ' + r.lead.slice(-160));
ok('⑤b 畫面上不出現操作指令', !/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多)/.test(r.lead + r.card));
ok('②d ⚡ 概念股盤中即時那張就在這一格裡', r.hasGap);
ok('④a 390px 不橫向溢出', r.scrollX <= 2, String(r.scrollX));
ok('⑨ 無 pageerror', errs.length === 0, errs[0] || '');
await page.close();

// 🗓️ ⑨ V77.2.0 天期選單(1 / 3 / 5 / 20 日)—— 使用者:「概念股及官方產業日期改成 1、3、5 日選單」
//   🚨 最重要的一條:`_ROT_EDGE` 的 +1.44pp 是**拿 20 日**測的 → ⛔ 不可被其他天期借用。
const pw = await boot({ width: 390, height: 844 });
const wv = await pw.evaluate(async () => {
    const grab = () => ({
        lead: document.getElementById('rotLead').innerText.replace(/\s+/g, ' '),
        card: document.getElementById('rotRankCard').innerText.replace(/\s+/g, ' '),
        btns: [...document.querySelectorAll('[data-rotwinbtn]')].map(b => ({
            w: +b.getAttribute('data-rotwinbtn'), off: b.disabled, on: b.getAttribute('aria-pressed') === 'true' })),
        first: (document.querySelector('[data-rotrank="1"]') || {}).getAttribute
               ? document.querySelector('[data-rotrank="1"]').getAttribute('data-rotind') : null,
    });
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 3000));
    app.switchRotView('ind'); app.switchRotWin(20);
    await new Promise(r => setTimeout(r, 900));
    const w20 = grab();
    app.switchRotWin(5);
    await new Promise(r => setTimeout(r, 900));
    const w5 = grab();
    app.switchRotWin(1);
    await new Promise(r => setTimeout(r, 900));
    const w1 = grab();
    return { w20, w5, w1, has3: !!(app._scrC && app._scrC.chg3 !== undefined) };
});
ok('⑨s 空過守門:四顆天期鈕都在畫面上', wv.w20.btns.length === 4 && wv.w20.btns.some(b => b.w === 3), JSON.stringify(wv.w20.btns));
// 🧹 V78.3.6 數字不印了,但「避開最弱」這句怎麼做**只有 20 日有實測背書** → 仍然只准出現在 20 日那一頁
ok('⑨a 🧹 V78.3.6 20 日那一頁才可以給「避開最弱」那句(⛔ 不印 +1.44pp)', !/\+1\.44pp/.test(wv.w20.lead) && /避開最弱/.test(wv.w20.lead), wv.w20.lead.slice(0, 120));
// 🧹 V78.3.6 一般模式不可再寫「沒有回測過」(研究字樣),但 🚨 用意不變:非 20 日那幾頁⛔ 不可借 20 日的結論「避開最弱」,
//   而且要說清楚這只是描述(不是買賣訊號)。
ok('⑨b 🚨 換成 5 日 → ⛔ 不可借「避開最弱」那句、⛔ 沒有研究字樣,要說「不是買賣訊號 / 只描述」',
   !/避開最弱/.test(wv.w5.lead) && !_RES.test(wv.w5.lead) && /不是買賣訊號|只描述/.test(wv.w5.lead) && /近 5 日/.test(wv.w5.lead), wv.w5.lead.slice(0, 200));
ok('⑨b2 1 日同理(⛔ 不是只擋 5 日)', !/避開最弱/.test(wv.w1.lead) && !_RES.test(wv.w1.lead) && /近 1 日/.test(wv.w1.lead), wv.w1.lead.slice(0, 160));
ok('⑨c ⭐ 決定性對照:換天期之後排名**真的跟著換**(⛔ 不是只換標題)',
   !!wv.w20.first && !!wv.w1.first && (wv.w20.first !== wv.w1.first || wv.w20.card !== wv.w1.card),
   `${wv.w20.first} vs ${wv.w1.first}`);
ok('⑨d ⏳ 採礦還沒補到 chg3 時,3 日那顆要 disabled 並標「待採礦」(⛔ 不可拿別的天期冒充)',
   wv.has3 ? !wv.w20.btns.find(b => b.w === 3).off
           : (wv.w20.btns.find(b => b.w === 3).off && /待採礦/.test(wv.w20.card)),
   `has3=${wv.has3}`);
await pw.close();

// 🎯 ⑩ V79.9.5 點一列 → 展開成分股(使用者 10/27:「板塊輪動改成概念股」)
//   ⭐ 成員跟名次同一份(_regimeStats 的 tmem / imem),照那個天期由強到弱排;再點一次收起
const pm = await boot({ width: 390, height: 844 });
const mv = await pm.evaluate(async () => {
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 3000));
    app.switchRotView('theme'); app.switchRotWin(20);
    await new Promise(r => setTimeout(r, 900));
    const S = app._regimeStats(20), isTh = app._rotView() === 'theme' && S.tmed && S.tmed.size >= 5;
    const first = document.querySelector('[data-rotrank="1"]');
    const key = first && first.getAttribute('data-rotkey');
    first && first.click();
    await new Promise(r => setTimeout(r, 400));
    const box = document.querySelector('[data-rotmem]');
    const rows = [...document.querySelectorAll('[data-rotmemrow]')].map(e => e.getAttribute('data-rotmemrow'));
    const D = app._scrData, c20 = s => app._scrV(D.rows[s], 'chg20');
    const truth = isTh ? (S.tmem.get(key) || []).map(x => x[0]).filter(s => c20(s) !== null) : [];
    const sorted = rows.every((s, i) => i === 0 || c20(rows[i - 1]) >= c20(s));
    const txt = box ? box.innerText : '';
    const tab = (document.getElementById('subTab_rot') || {}).innerText || '';
    window.scrollTo(80, 0); const sx = window.scrollX;
    document.querySelector('[data-rotrank="1"]').click();
    await new Promise(r => setTimeout(r, 400));
    const closed = !document.querySelector('[data-rotmem]');
    // 官方產業也點得開(成員 = 那個產業有 K 線的那批)
    app.switchRotView('ind'); await new Promise(r => setTimeout(r, 600));
    const f2 = document.querySelector('[data-rotrank="1"]'), ik = f2.getAttribute('data-rotkey'); f2.click();
    await new Promise(r => setTimeout(r, 400));
    const indN = document.querySelectorAll('[data-rotmemrow]').length, indTruth = (S.imem.get(ik) || []).length;
    return { isTh, key, n: rows.length, truthN: truth.length, same: truth.slice().sort().join() === rows.slice().sort().join(), sorted, txt, tab, sx, closed, indN, indTruth };
});
ok('⑩a 🔁 V79.9.6 分頁鈕改叫「板塊輪動」(使用者:「🎯 概念股名稱改成板塊輪動」)', /板塊輪動/.test(mv.tab) && !/概念股/.test(mv.tab), mv.tab);
ok('⑩b 預設是概念股、點第一列展開成分股 = _regimeStats 的 tmem(⛔ 另一份名單)', mv.isTh && mv.n > 0 && mv.same && mv.n === mv.truthN, JSON.stringify({ k: mv.key, n: mv.n, t: mv.truthN }));
ok('⑩c 成分股照近 20 日由強到弱排', mv.sorted);
ok('⑩d 再點一次收起來', mv.closed);
ok('⑩e 官方產業那一頁也點得開,檔數 = 那個產業的成員', mv.indN > 0 && mv.indN === mv.indTruth, `${mv.indN} vs ${mv.indTruth}`);
ok('⑩f 展開區⛔ 買賣指令、⛔ 研究字樣;390px 不橫捲', !/(可以進場|建議買進|建議賣出|可加碼|放心做多)/.test(mv.txt) && !_RES.test(mv.txt) && mv.sx <= 2, mv.txt.slice(0, 160));
await pm.close();

// ⚡ ⑪ V79.9.6 概念股盤中即時(使用者:「📊市場板塊輪動內容改成概念股盤中即時更新」)
//   ⭐ 成員 = _regimeStats(20).tmem;今天漲跌 = 今天的全市場快照;快照不是今天 → 改用收盤並講出來
const pl = await boot({ width: 390, height: 844 });
const lv = await pl.evaluate(async () => {
    app._startLiveQuotePoll = () => {}; app._loadLiveQuotes = async () => false;   // ⛔ 讀真的快照(測資自己擺)
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 3000));
    const S = app._regimeStats(20);
    const syms = [...new Set([...S.tmem.values()].flat().map(x => x[0]))];
    // 每一檔給一個固定的假漲跌(代號雜湊),價格 = 100
    const h = s => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) % 1000; return +((x / 100) - 5).toFixed(2); };
    app._liveQuotes = Object.fromEntries(syms.map(s => [s, { p: 100, c: h(s), v: 1 }]));
    app._liveUpdated = new Date().toISOString(); app._liveTs = '10:30';
    app._clOpenK = null; app._renderConceptLive();
    const md = a => { const b = a.slice().sort((p, q) => p - q); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
    const truth = [...S.tmem.entries()].map(([k, m]) => { const cs = m.map(x => h(x[0])); return { k, med: md(cs), up: cs.filter(c => c > 0).length, dn: cs.filter(c => c < 0).length, n: cs.length }; })
        .filter(x => x.n >= 3).sort((a, b) => b.med - a.med);
    const R = app._conceptLiveRows();
    const shown = [...document.querySelectorAll('[data-clrow]')].map(e => e.getAttribute('data-clrow'));
    const okRows = R.rows.length === truth.length && R.rows.every((r, i) => Math.abs(r.med - truth[i].med) < 1e-9 && r.up === truth[i].up && r.dn === truth[i].dn && r.n === truth[i].n);
    const card = document.getElementById('conceptLiveCard').innerText;
    // 決定性對照:把第一名那一群的每一檔都改成 −9% → 那一列一定掉到最後
    const k0 = shown[0];
    for (const [s] of S.tmem.get(k0)) app._liveQuotes[s].c = -9;
    app._renderConceptLive();
    const shown2 = [...document.querySelectorAll('[data-clrow]')].map(e => e.getAttribute('data-clrow'));
    // 展開成分股:照今天漲跌排、點得到
    document.querySelector('[data-clrow] > div').click();
    await new Promise(r => setTimeout(r, 200));
    const memRows = [...document.querySelectorAll('[data-clmemrow]')].map(e => e.getAttribute('data-clmemrow'));
    const memSorted = memRows.every((s, i) => i === 0 || app._liveQuotes[memRows[i - 1]].c >= app._liveQuotes[s].c);
    const memTruth = (S.tmem.get(shown2[0]) || []).length;
    window.scrollTo(80, 0); const sx = window.scrollX;
    // 快照不是今天 → 改用收盤 + 講出來
    app._liveUpdated = new Date(Date.now() - 3 * 864e5).toISOString(); app._clOpenK = null; app._renderConceptLive();
    const stale = document.getElementById('conceptLiveCard').innerText;
    const D = app._scrData, R2 = app._conceptLiveRows();
    const anyStaleOk = R2.rows.length > 0 && R2.rows[0].ms.every(x => x.c === app._scrV(D.rows[x.s], 'chg'));
    return { okRows, nRows: R.rows.length, nTruth: truth.length, shownOk: shown.join() === truth.map(x => x.k).join(), k0, last2: shown2[shown2.length - 1], tie: truth.filter(x => x.med <= -9).length,
             card, memN: memRows.length, memTruth, memSorted, sx, stale, anyStaleOk, staleFlag: !!document.querySelector('[data-clstale]') };
});
ok('⑪a 每個概念的今天中位數 / 漲跌家數 / 檔數 == 自己用 tmem + 快照手算(成員 <3 檔不列)', lv.okRows, `${lv.nRows} vs ${lv.nTruth}`);
ok('⑪b 照今天中位數由強到弱排', lv.shownOk);
ok('⑪c ⭐ 決定性對照:第一名那群全改成 −9% → 掉到最後', lv.last2 === lv.k0 || lv.tie > 0, `${lv.k0} → 最後是 ${lv.last2}`);
ok('⑪d 點一列展開成分股 = 那一群的成員、照今天漲跌排', lv.memN > 0 && lv.memN === lv.memTruth && lv.memSorted, `${lv.memN} vs ${lv.memTruth}`);
ok('⑪e 表頭寫快照時間;⛔ 買賣指令、⛔ 研究字樣;390px 不橫捲', /10:30/.test(lv.card) && !/(可以進場|建議買進|建議賣出|可加碼|放心做多)/.test(lv.card) && !_RES.test(lv.card.replace(/測試\/探針/g, '')) && lv.sx <= 2, JSON.stringify({sx: lv.sx, res: (lv.card.match(_RES)||[''])[0], ins: (lv.card.match(/(可以進場|建議買進|建議賣出|可加碼|放心做多)/)||[''])[0]}));
ok('⑪f 快照不是今天 → 改用收盤漲跌並寫出「不是今天盤中」(⛔ 拿舊快照當現價)', lv.staleFlag && /不是今天盤中/.test(lv.stale) && lv.anyStaleOk, lv.stale.slice(0, 160));
await pl.close();

// ⑥ 空過守門:選股快照抓不到 → 誠實空狀態,⛔ 不留空殼、⛔ 不假造排名
const p2 = await boot({ width: 390, height: 844 });
const e = await p2.evaluate(async () => {
    // 🔁 V79.4.3 V79.1.2 起 _loadScreener 讀不到不會記住失敗、會自動再抓 → 光把 _scrData 設 null,
    //   它馬上又從 data/screener.json 讀回來(這條從那版起一直是假紅燈)。⭐ 改成真的模擬「讀不到」。
    app._loadScreener = async () => { app._scrData = null; app._scrErr = 'HTTP 404'; return null; };
    app._scrData = null; app._scrErr = 'HTTP 404'; app._regCache = null;
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 800));
    return { lead: document.getElementById('rotLead').innerText.replace(/\s+/g, ' '), cardHidden: document.getElementById('rotRankCard').classList.contains('hidden'), n: document.querySelectorAll('[data-rotrank]').length };
});
ok('⑥ 選股快照抓不到 → 一句話說「還沒載入」+ 原因,排名卡藏起、⛔ 沒有任何假名次', /還沒載入/.test(e.lead) && /404/.test(e.lead) && e.cardHidden && e.n === 0, JSON.stringify(e).slice(0, 200));
await p2.close();

// ④b 橫版
const p3 = await boot({ width: 844, height: 390 });
const land = await p3.evaluate(async () => { app.switchAppTab('market'); app.switchMarketSubTab('rot'); await new Promise(r => setTimeout(r, 3000)); window.scrollTo(80, 0); return window.scrollX; });
ok('④b 844×390 橫版不橫向溢出', land <= 2, String(land));
await p3.close();

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ ROTTAB_TEST_PASS');
process.exit(fails.length ? 1 : 0);
