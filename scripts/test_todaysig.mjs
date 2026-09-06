#!/usr/bin/env node
/**
 * 🎯 今日實測訊號榜(V72.2.0;V72.5.0 從「常駐條」改成榜單第一項)
 *
 * 使用者原話:「只要給我最好、勝率最高的資料」「一目了然知道現在要怎麼做」。
 *
 * 問題:`_SIGNAL_EDGE` 的實測成績只在**個股頁**看得到 —— 使用者得先想到要看哪一檔,
 *      才知道它今天有沒有訊號,等於要他自己翻 2,315 檔(陷阱 #32 的極端版)。
 * → 採礦端 `daily_signal_scan.mjs` 全市場掃(實測 2,315 檔 / 177 秒 / 產出 3.6 KB)。
 *
 * ⚠️ V72.5.0 改版:使用者回報「佔太大、文字太多、太亂」(截圖:常駐條吃掉整個第一屏,
 *   股名還被 truncate 成「太.」「元…」)→ 改成**榜單裡的第一個榜**(`todaysig`)。
 *   ⛔ 別把常駐條加回來;發現性改用「紅點數字 + 今天有訊號就自動預設開它」補。
 *
 * ⛔ 這支釘住:
 *   ① 榜單只收**看多且 exp>0**(常對但不賺的不進榜)
 *   ② ⛔ **不逐檔列出風險股**(全市場 6,158 筆沒有可操作性,截斷反而誤導)—— 只給總數
 *   ③ 沒資料 → 誠實空狀態(⛔ 不可 silent return 留白 —— 這裡是**分頁**,使用者是主動點進來的)
 *   ④ 三個免責必須在**卡上**:基準勝率不是 50% / 已扣交易成本 / 不是保證
 *      (V72.5.0 壓成一行,⛔ 但不可全部搬進 alert —— 使用者不點就看不到)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const txt = h => String(h == null ? '' : h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderTodaySignalView, null, { timeout: 20000 });

// ⭐ 用**採礦端真的產出的檔**當測資(⛔ 不用合成的,那驗不到欄位對接)
let real = null;
try { real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/today_signals.json'), 'utf8')); } catch (_) { }
ok('① ⭐ 採礦端真的產得出 today_signals.json', !!real, '找不到 data/today_signals.json');
if (real) {
    ok('① 有 bull 榜且是陣列', Array.isArray(real.bull), typeof real.bull);
    ok('① ⭐ bull 榜每筆的期望值都必須 > 0(⛔ 常對但不賺的不進榜)',
       real.bull.every(x => x.exp > 0), JSON.stringify(real.bull.filter(x => !(x.exp > 0)).slice(0, 3)));
    ok('① ⭐⛔ 不可輸出風險股清單(只給總數)',
       !Array.isArray(real.risk), `risk 欄位型別 ${typeof real.risk}`);
    ok('① 有給風險總數當大盤氛圍', Number.isFinite(real.risk_n) && Number.isFinite(real.risk_syms),
       JSON.stringify({ n: real.risk_n, s: real.risk_syms }));
    ok('① ⭐ 必須帶交易成本免責欄位', /未扣交易成本/.test(String(real.cost_note)), real.cost_note);
    ok('① 價格要 round(⛔ 不可出現 62.70000076293945 這種)',
       real.bull.every(x => String(x.c).replace(/^-?\d+\.?/, '').length <= 2),
       JSON.stringify(real.bull.map(x => x.c).slice(0, 5)));
    ok('① 檔案要夠小(≤ 30 KB)', JSON.stringify(real).length <= 30720, `${(JSON.stringify(real).length / 1024).toFixed(1)} KB`);
    console.log(`   ↳ 掃 ${real.scanned} 檔 ・命中 ${real.bull.length} 檔 ・風險 ${real.risk_n} 筆/${real.risk_syms} 檔`);
}

const render = d => page.evaluate(async j => {
    app._todaySig = j;
    await app._renderTodaySignalView();
    const el = document.getElementById('radarTodaySigView');
    return { hidden: el.classList.contains('hidden'), html: el.innerHTML };
}, d);

// ── ② 有資料 → 顯示,且免責齊全 ────────────────────────────
const R = await render(real || { bull: [{ s: '8464', c: 382.5, t: '換手量(洗籌續攻)', g: 'A', n: 1309, w: 42.4, exp: 0.68 }], scanned: 2315, base_win: 36.4, data_date: '2026-08-03', cost_note: '期望值未扣交易成本(來回約 0.44%,當沖 0.25%)', risk_n: 6158, risk_syms: 2079 });
const t = txt(R.html);
ok('② 有資料時要顯示', t.length > 80, `len=${t.length}`);
ok('② ⭐ 標題要講「扣完成本還會賺」的檔數(⛔ 不是毛期望值為正的檔數)',
   /扣完成本還會賺 \d+ 檔/.test(t), t.slice(0, 200));
ok('② ⭐ 必須標基準勝率(否則 42% 會被誤讀成輸)', /基準勝率 \d+%/.test(t), t.slice(-320));
// 💸 V72.3.1 改成「已經扣掉了」—— 只寫免責、卻讓賠錢訊號排最前面,等於沒講
ok('② ⭐⛔ 必須把來回成本寫成數字(而且是已扣掉的)',
   /已扣來回成本 [\d.]+%/.test(t), t.slice(-360));
ok('② ⭐⛔ 賺不回成本的**不可刪掉**,要收在摺疊區並說明',
   !/另有 \d+ 筆/.test(t) || (/扣完成本不夠賺/.test(t) && /不是叫你做/.test(t)), t.slice(-420));
ok('② ⭐ 必須寫明「不是保證」', /不是保證/.test(t), t.slice(-320));
ok('② 要標資料日期(⛔ 別讓人以為是即時)', /收盤資料/.test(t), t.slice(-320));
// 🧹 V72.5.0 風險總數那段搬進 alert(卡上留三個免責就好);⛔ 但**不可以刪掉**
const _hlp = await page.evaluate(() => { let s2=''; const o=window.alert; window.alert=x=>{s2=x;}; app._showTodaySigHelp(); window.alert=o; return s2; });
ok('② ⭐ 風險只給檔數、⛔ 不逐檔列(V72.5.0 起在教學裡)',
   !R.html.includes('risk') && (/檔出現風險訊號/.test(_hlp) || !(real && real.risk_syms)), _hlp.slice(0, 400));
// 🧹 V72.5.0 使用者:「文字太多、沒辦法一次顯示完」→ 每列改兩行式,股名不可被截成「太.」
ok('② ⭐⛔ 每列不可再擠成一行(股名會被 truncate 成看不出是哪一檔)',
   !/扣成本 [+-]/.test(t), t.slice(0, 300));
ok('② ⛔ 代號不可重複顯示兩次(getStockName 沒載入時會回代號本身)',
   !/\b(\d{4})\s+\1\b/.test(t), (t.match(/\b(\d{4})\s+\1\b/) || []).join(','));


// ── ②b ⛔ 不可把「截斷後的筆數」當成「今天有幾檔」(V72.2.7)────────
//   實測 2026-08-04:採礦端 slice 上限剛好被打滿(60 筆),而畫面寫「只有 60 檔」——
//   ① 那是**截斷後**的數字 ② `bull` 是逐筆訊號不是逐檔股票(60 筆只有 56 檔)。
const R2 = await render({ ...(real || {}), scanned: 2316, bull_total: 137, bull_syms: 96, bull_cap: 200,
    bull: (real && real.bull ? real.bull : []).slice(0, 5).length ? real.bull.slice(0, 5)
        : [{ s: '2511', c: 8.5, t: 'x', g: 'A', n: 100, w: 42, exp: 0.68 }],
    base_win: 36.4, data_date: '2026-08-04', cost_note: '期望值未扣交易成本(來回約 0.44%,當沖 0.25%)', risk_n: 1, risk_syms: 1 });
const t2 = txt(R2.html);
// 🧹 V72.5.0 全榜統計搬進「ⓘ 怎麼看」(卡上太吵)—— ⛔ 是**搬**不是刪,一樣要驗得到
const h2 = await page.evaluate(() => { let s2=''; const o=window.alert; window.alert=x=>{s2=x;}; app._showTodaySigHelp(); window.alert=o; return s2; });
ok('②b ⭐ 全榜的「檔/筆」要用採礦端的真值(⛔ 不是截斷後的陣列長度)',
   /共 96 檔 \/ 137 筆/.test(h2), h2.slice(0, 400));
ok('②b ⭐⛔ 有截斷就要看得出來(silent cap = 假裝「這就是全部」)',
   /其餘收在/.test(h2), h2.slice(0, 400));
// ⭐ exp=0.1 全都賺不回成本 → 主區要誠實說「今天沒有一檔賺得回交易成本」,⛔ 不可留白
const R3 = await render({ ...(real || {}), bull_total: 3, bull_syms: 3,
    bull: [{ s: '1', c: 1, t: 'x', g: 'A', n: 100, w: 42, exp: 0.1 }, { s: '2', c: 1, t: 'x', g: 'A', n: 100, w: 42, exp: 0.1 }, { s: '3', c: 1, t: 'x', g: 'A', n: 100, w: 42, exp: 0.1 }],
    scanned: 2316, base_win: 36.4, data_date: '2026-08-04', cost_note: '未扣交易成本', risk_n: 1, risk_syms: 1 });
ok('②b ⭐ 全部賺不回成本時要誠實講,並勸阻硬找理由進場',
   /沒有一檔的訊號賺得回交易成本/.test(txt(R3.html)) && /別硬找理由進場/.test(txt(R3.html)), txt(R3.html).slice(0, 300));
ok('②b ⛔ 那些訊號**不可以刪掉**,要收在摺疊區', /另有 3 筆/.test(txt(R3.html)), txt(R3.html).slice(0, 400));
const scanSrc2 = fs.readFileSync(path.join(ROOT, 'scripts/daily_signal_scan.mjs'), 'utf8');
ok('②b ⭐ 採礦端要輸出 bull_total / bull_syms(截斷前的真值)',
   /bull_total: bull\.length/.test(scanSrc2) && /bull_syms: new Set\(bull\.map/.test(scanSrc2), '');
ok('②b ⭐ 有截斷要在 log 講(no silent caps)', /有截斷:/.test(scanSrc2), '');

// ── ③ 沒資料 → 整條不顯示(⛔ 不留空殼)───────────────────
// ⚠️ V72.5.0 起這是**分頁**不是常駐條 —— 使用者是主動點進來的,留白等於陷阱 #4(silent return)。
//    ⛔ 不可再驗「整條隱藏」,要驗「有講為什麼是空的」。
for (const [name, d] of [['bull 是空陣列', { bull: [], scanned: 2315 }], ['整包 null', null], ['沒有 bull 欄位', { scanned: 1 }]]) {
    const r = await render(d);
    ok(`③ ⛔ ${name} → 要有誠實空狀態(不可留白)`,
       /還沒有掃描結果/.test(txt(r.html)) && /一檔都沒出現/.test(txt(r.html)), txt(r.html).slice(0, 200));
}

// ── ④ 教學要說清楚「為什麼只有十幾檔」────────────────────────
const help = await page.evaluate(() => {
    let s = ''; const o = window.alert; window.alert = x => { s = x; };
    app._showTodaySigHelp(); window.alert = o; return s;
});
ok('④ ⭐ 教學要解釋「為什麼通常只有十幾檔」', /為什麼通常只有十幾檔/.test(help), help.slice(0, 300));
ok('④ ⭐ 要說明「大部分訊號常對但輸更大」', /輸的時候輸更大/.test(help), help.slice(0, 500));
ok('④ ⭐ 三個免責都要在(基準不是 50% / 成本 / 不是保證)',
   /不是 50%/.test(help) && /手續費.{0,6}證交稅/.test(help) && /不是保證/.test(help), help.slice(-500));
ok('④ ⭐ 教學要解釋「為什麼要扣完成本才算數」', /為什麼要「扣完成本」才算數/.test(help), help.slice(0, 600));
ok('④ 要說明只看 K 線、沒看籌碼基本面', /沒有看籌碼/.test(help), help.slice(-300));

// ── ⑤ 接線:選股頁進入時要載入,ETF 模式要隱藏 ────────────────
const wired = await page.evaluate(() => ({
    tab: /_refreshTodaySigBadge\(\)/.test(app.switchAppTab.toString()),
    mode: /_refreshTodaySigBadge\(\)/.test(app.switchRadarMode.toString()),
    etfSkip: /this\._radarMode !== 'etf'/.test(app.switchAppTab.toString()),
    inTabs: !!app._RADAR_TABS.todaysig,
    first: Object.keys(app._RADAR_TABS)[0] === 'todaysig',
    hint: /扣完/.test(app._RADAR_HINT.todaysig || ''),
    // ⚠️ 兩個「自動選 tab」的機制不可打架(擂台冠軍 vs 今日訊號榜)
    arenaYields: /_todaySigAutoDone/.test(app._applyArenaChampion.toString()),
    sw: /key === 'todaysig'/.test(app.switchRadarStrategy.toString()),
    noBar: !document.getElementById('todaySignalBar'),
}));
ok('⑤ ⭐ 切到選股頁會更新紅點', wired.tab, '');
ok('⑤ 切換策略/ETF 模式也會處理', wired.mode, '');
ok('⑤ ⭐ ETF 模式不搶著自動切榜', wired.etfSkip, '');
ok('⑤ ⭐ todaysig 要在榜單清單裡', wired.inTabs, '');
ok('⑤ ⭐ 而且要排**第一個**(唯一有實測成績的榜)', wired.first, Object.keys(''));
ok('⑤ 說明條要有 todaysig 這一項', wired.hint, '');
ok('⑤ ⭐⛔ 擂台冠軍自動選 tab 不可蓋掉今日訊號榜', wired.arenaYields, '');
ok('⑤ switchRadarStrategy 有接 todaysig 分支', wired.sw, '');
ok('⑤ ⭐⛔ 舊的常駐條 DOM 要真的移除(⛔ 別留殭屍容器)', wired.noBar, '');

// ⑤b 紅點徽章:有訊號才顯,而且算的是「扣完成本還會賺」的**檔數**
const badge = async d => page.evaluate(async j => {
    app._todaySig = j;
    const n = await app._refreshTodaySigBadge();
    const el = document.getElementById('radarTodaySigCount');
    return { n, hidden: el.classList.contains('hidden'), txt: el.textContent };
}, d);
let bg = await badge({ bull: [{ s: '1', c: 1, t: 'x', n: 100, w: 42, exp: 3 }, { s: '1', c: 1, t: 'y', n: 100, w: 42, exp: 2 }, { s: '2', c: 1, t: 'z', n: 100, w: 42, exp: 0.05 }], scanned: 1 });
ok('⑤b ⭐ 紅點算「檔數」不是「筆數」(同一檔兩個訊號只算 1)', bg.n === 1 && bg.txt === '1', JSON.stringify(bg));
ok('⑤b ⭐⛔ 賺不回成本的不計入紅點', bg.n === 1, JSON.stringify(bg));
bg = await badge({ bull: [{ s: '1', c: 1, t: 'x', n: 100, w: 42, exp: 0.05 }], scanned: 1 });
ok('⑤b ⛔ 沒有會賺的訊號 → 紅點隱藏(不留空殼)', bg.n === 0 && bg.hidden, JSON.stringify(bg));

// ── ⑥ 採礦腳本本身的鐵則(⛔ 別在那裡另立一套判定)──────────────
const scan = fs.readFileSync(path.join(ROOT, 'scripts/daily_signal_scan.mjs'), 'utf8');
ok('⑥ ⭐ 掃描腳本要跑**真的**偵測器(⛔ 不複製判定邏輯)',
   /app\[d\]\(rows\)/.test(scan) && /不複製一份判定邏輯/.test(scan), '');
ok('⑥ ⭐ 看多必須 exp>0 才進榜', /h\.tone === 'bull' && h\.exp != null && h\.exp > 0/.test(scan), '');
ok('⑥ ⭐⛔ 註解要寫明「不輸出風險股清單」的理由', /刻意不輸出風險股清單/.test(scan), '');
ok('⑥ ⛔ 不可在採礦端重複存股票名稱(前端已有 getStockName)',
   /刻意\*\*不存股票名稱\*\*/.test(scan), '');



// ── ⑧b 勝率必須配樣本,而且基準是回測實測值不是 50%(陷阱 #36/#37)──
ok('⑧b ⭐ 每列要顯示勝率', /勝率 \d+(\.\d+)?%/.test(t), t.slice(0, 260));
const barSrc = await page.evaluate(() => app._renderTodaySignalView.toString());
ok('⑧b ⭐⛔ 要走共用的 `_wrTag`(⛔ 別另寫一套樣本判斷)', /_wrTag\(x\.w, x\.n,/.test(barSrc),
   (barSrc.match(/_wrTag\([^\n]*/) || [''])[0]);
ok('⑧b ⭐⛔ 第 3 參數要傳回測真實基準(⛔ 不可用 0.5) —— 42% 對 36% 是贏、對 50% 會被標成丟銅板',
   /_wrTag\(x\.w, x\.n, \(j\.base_win \|\| 36\.4\) \/ 100\)/.test(barSrc), '');

// ── ⑧ 👜 庫存/自選命中(V72.2.6)⛔ 沒交集要完全不顯示 ────────────
const withMine = (syms, d) => page.evaluate(async a => {
    const realInv = app._getInventory, realFav = app.favGroups;
    app._getInventory = () => a.syms.map(s => ({ symbol: s, cost: 1, shares: 1000 }));
    app.favGroups = { 預設: [] };
    app._todaySig = a.d;
    await app._renderTodaySignalView();
    const el = document.getElementById('radarTodaySigView');
    const out = { hidden: el.classList.contains('hidden'), html: el.innerHTML };
    app._getInventory = realInv; app.favGroups = realFav;
    return out;
}, { syms, d });

const SAMPLE = real && real.bull && real.bull.length ? real : { bull: [{ s: '8464', c: 382.5, t: '換手量', g: 'A', n: 1309, w: 42.4, exp: 0.68 }], scanned: 2315, base_win: 36.4, data_date: '2026-08-03', cost_note: '期望值未扣交易成本(來回約 0.44%,當沖 0.25%)', risk_n: 6158, risk_syms: 2079 };
const onList = String(SAMPLE.bull[0].s);

const M1 = await withMine([onList], SAMPLE);
const m1 = txt(M1.html);
// 🧹 V72.5.0 原本會把命中的股號股名整串列出來(截圖裡佔 4 行)→ 改成「有幾檔」+ 排到最前面 + 👜 徽章。
//   ⛔ 資訊不可消失:那幾檔必須**排在第一列**,而且看得出來是你的。
ok('⑧ ⭐ 手上有榜上的股 → 要點出有幾檔', /👜/.test(m1) && /你手上\/自選有 \d+ 檔在榜上/.test(m1), m1.slice(0, 220));
ok('⑧ ⭐ 要指路(已幫你排到最前面)', /排到最前面/.test(m1), m1.slice(0, 260));
ok('⑧ ⭐⛔ 命中的那檔必須真的排第一列', (m1.indexOf(onList) < 200), `${onList} @${m1.indexOf(onList)}`);

const M0 = await withMine(['9999'], SAMPLE);
const m0 = txt(M0.html);
ok('⑧ ⭐⛔ 沒交集時整行不顯示(⛔ 不留空殼、不寫「你沒有命中」)',
   !/👜/.test(m0) && !/你手上/.test(m0), m0.slice(0, 220));
// ⚠️ V72.5.0 起容器的顯示/隱藏由 `switchRadarStrategy` 控制(跟其他 15 個榜同一套),
//    ⛔ 渲染函式自己不碰 hidden → 這裡只驗「內容有渲染出來」。
ok('⑧ 沒交集時榜單本身照顯示', m0.length > 80, `len=${m0.length}`);

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ TODAYSIG_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ TODAYSIG_TEST_PASS');
