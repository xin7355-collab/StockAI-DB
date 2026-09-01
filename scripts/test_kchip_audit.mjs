#!/usr/bin/env node
/**
 * 📐🔬 K線頁 / 籌碼頁 一致性(V72.1.3)
 *
 * 使用者:「幫我一筆一筆檢視…我想要的是顯示出來的資料是**勝率高**、
 *          讓使用者**一目了然知道現在要怎麼做**,而不是多個卡片自己講自己的,
 *          根本不知道要看哪一張卡片」。
 *
 * 用**真實 2327 資料 + 真實 gh-pages 分點**跑出來,抓到兩個:
 *
 * ① K線頁標「🎯 **實測有效**的訊號(3)」,但三個的期望值全是負的
 *    (−0.295% / −0.802% / −0.224%)。勝率 41~44% 確實贏基準 36%,
 *    但**輸的時候輸更大** → 標成「實測有效」會讓人以為可以進場,那是誤導。
 *    ⭐ V72.0.3 已在總覽定調「看多必須 exp>0」,K線頁沒跟上。
 *
 * ② 籌碼頁同一頁兩個「主力」方向相反:
 *    明日劇本「主力今日整體大買 9,828 張」(periods['1d'])
 *    主力動向「偏賣 −15,009 張」(periods['5d'])
 *    ⛔ 都沒算錯,是**不同時間範圍** —— 但名字一樣又沒標範圍,看起來就是在吵架。
 *    ⭐ V72.0.8 只修了總覽,籌碼頁沒跟上。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const txt = h => String(h == null ? '' : h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// ⚠️ 「禁止出現某句話」的測試,一律先拿掉**否定形** —— 正確的免責寫法本身就含被禁的字串。
//   本 session 已踩 7 次(「不是買賣訊號」含賣訊、「沒有推估台積電的官方權重」含權重、
//   「不是勝率」含勝率…)。⛔ 別因此把 BAD 放寬成不檢查 —— 那才是真正的危險。
const nono = t => String(t)
    .replace(/(?:不是|並非|沒有|不可|⛔[^。]{0,12}不)[^。;,]{0,24}(勝率|可信度|保證|準確|會賺|買訊|賣訊|權重)/g, '')
    .replace(/預測力還沒驗證過/g, '');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderKbarTactics, null, { timeout: 20000 });
// 🧭 V74.2.2 K線頁改總覽邏輯:卡片收進 <details id="chartMoreWrap">(**原生**隱藏,不靠 CSS)。
//   ⚠️ 收起狀態下 `innerText` 退化成 textContent(元素沒被渲染)→ ⑤ 的片語比對會失準,
//   全市場掃描從「掃幾檔就命中」變成掃完 2,600 檔 = 超時。這裡先把摺疊打開,
//   還原「讀渲染後文字」的語意(⛔ 這是測試環境的還原,不代表正式環境預設打開)。
await page.evaluate(() => { const d = document.getElementById('chartMoreWrap'); if (d) d.open = true; });

const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2327.json'), 'utf8'));

// ══ ① K線頁:分組要看期望值,⛔ 不是只看統計分級 ══════════════
const K = await page.evaluate(r => {
    app.currentSymbolId = '2327'; app.rawDailyData = r; app.activeData = r;
    const cl = r.map(x => +x.close);
    const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k);
    app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60), k: [], d: [], dif: [], macd: [] };
    app.renderKbarTactics(r);
    const el = document.getElementById('kbarHalfTactics');
    return { html: el ? el.innerHTML : null, src: app.renderKbarTactics.toString() };
}, rows);
ok('① 有渲染出東西', K.html && K.html.length > 200, String(K.html).slice(0, 120));
const kt = txt(K.html);

// ⚠️ regex 不可用 [^)]* —— 條件裡本來就有 `_exp(x)` 這種內層括號,會提前截斷(第一版就踩到)
ok('① ⭐ 分組要用期望值(good 必須 exp>0)',
   /const good = sigs\.filter\(x => x\._rk <= 1 && _isBull\(x\) && _exp\(x\) != null && _exp\(x\) > 0\)/.test(K.src),
   (K.src.match(/const good = [^\n]*/) || [''])[0]);
ok('① ⭐ 風險提醒獨立一區,⛔ 不看期望值(風險不打折)',
   /const risk = sigs\.filter\(x => x\._rk <= 1 && !_isBull\(x\)\)/.test(K.src), '');
ok('① ⭐ 「常對但不賺」的看多要收進摺疊,⛔ 不刪掉',
   /const dull = /.test(K.src) && /rest = sigs\.filter\(x => x\._rk > 1\)\.concat\(dull\)/.test(K.src), '');
ok('① ⭐⛔ 標題不可再叫「實測有效的訊號」(那三個期望值是負的)',
   !/實測有效的訊號/.test(kt), kt.slice(0, 200));
ok('① ⭐ 改叫「值得參考的進場訊號」並註明「實測期望值為正」',
   /值得參考的進場訊號|沒有.{0,4}「?實測期望值為正/.test(kt), kt.slice(0, 260));

// ⚠️ V72.1.8:原本這裡直接斷言「2327 今天沒有正期望值訊號」——
//   但**成績表一更新,那個前提就變了**(全市場回測後 2327 多了一個 exp>0 的訊號),
//   測試就假失敗。⛔ 測試不可綁死會浮動的資料。
//   ⭐ 改用 stub 控制 `_sigEdge`,**兩種情境各驗一次**。
// 🚨 V74.0.3:`map` 支援萬用字元 `'*'`(對**每一個**訊號都回同一份成績)。
//   ⛔ 原本寫死 `_detectMaDeviation｜負乖離過大`,但那個偵測器**今天不一定會觸發**
//      → 資料一變,stub 等於沒作用、測試落到別的分支 = 假失敗。
//      (CLAUDE.md V72.1.8 自己就寫過「測試⛔不可綁死會浮動的資料狀態」,這支正是再犯。)
//   ⭐ 用 '*' 就跟「今天剛好有哪幾個訊號」無關:
//      看多的全部拿到負期望值 → 進 dull;看空/警示的全部拿到成績 → 進 risk。
const kbar = (expMap) => page.evaluate(a => {
    const real = app._sigEdge;
    const ALL = (a.expMap && a.expMap.__all !== undefined) ? a.expMap.__all : undefined;
    app._sigEdge = (det, title) => {
        const e = ALL !== undefined ? ALL : a.expMap[`${det}｜${title}`];
        return e === undefined ? null : { grade: 'A', n: 500, e10: 1, w10: 42, p: 0.01, e20: 1, payoff: 1.2, exp: e };
    };
    app.currentSymbolId = '2327'; app.rawDailyData = a.rows; app.activeData = a.rows;
    const cl = a.rows.map(x => +x.close);
    const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k);
    app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60), k: [], d: [], dif: [], macd: [] };
    app._ovTrend = a.tr ? { sym: '2327', trend: a.tr, txt: 'x' } : null;
    app.renderKbarTactics(a.rows);
    app._sigEdge = real;
    const el = document.getElementById('kbarHalfTactics');
    return el ? el.innerHTML : '';
}, { rows, expMap: expMap.map, tr: expMap.tr || null });

// ⓐ 全部訊號期望值皆 ≤0(等同「今天沒有值得進場的」)→ 必須誠實說 + 勸阻
const ktNone = txt(await kbar({ map: {} }));   // 查不到成績 = 未驗證 → 不會進 good
ok('① ⭐ 沒有正期望值訊號時要誠實說「沒有」', /沒有.{0,20}進場訊號/.test(ktNone), ktNone.slice(0, 300));
ok('① ⭐ 要勸阻「別硬找理由進場」', /別硬找理由進場/.test(ktNone), ktNone.slice(0, 300));
ok('① ⭐ 風險提醒要標「不是賣出指令」(有風險訊號時)',
   !/風險提醒/.test(kt) || /不是賣出指令/.test(kt), kt.slice(0, 460));

// ⛔ 最關鍵:置頂區裡⛔ 不可出現任何負期望值的**看多**訊號
const head = kt.split('其餘')[0];
const negBullInHead = /🔺偏多[^🔺🔻⚠️➖]{0,120}?期望 -/.test(head);
ok('① ⭐⛔ 置頂區不可出現「負期望值的看多訊號」', !negBullInHead, head.slice(0, 400));

// ══ ② 籌碼頁:今日 vs 近5日 方向相反要主動說明 ══════════════
let chipsRaw = null;
try {
    chipsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chips/2327.json'), 'utf8'));
} catch (_) { /* 本機沒有分點檔 → 用合成的,仍能驗判定邏輯 */ }
const synth = {
    periods: {
        '1d': { buy: [{ name: 'A', net: 9828000, avg: 550 }], sell: [] },
        '5d': { buy: [{ name: 'A', net: 1000000, avg: 550 }], sell: [{ name: 'B', net: -16009000, avg: 600 }] },
    },
    hist: null, data_date: '2026-08-03',
};
const C = await page.evaluate(a => {
    const P = a.chips.periods;
    app.currentSymbolId = '2327'; app._fenSym = '2327'; app._fenPeriods = P;
    app._fenHist = a.chips.hist || null; app._fenDataDate = a.chips.data_date;
    const px = +a.rows[a.rows.length - 1].close;
    return {
        html: app._chipTomorrowScenario(P, px, a.chips.hist),
        m5: app._chipMainForce(P, px),
        v1: app._chipScenarioCalc(P, px, a.chips.hist),
        src: app._chipTomorrowScenario.toString(),
    };
}, { rows, chips: chipsRaw || synth });
const ct = txt(C.html);

ok('② 這組資料真的是「今日 vs 近5日 方向相反」(⛔ 否則下面空過)',
   C.v1 && C.m5 && (C.v1.mainNetLots > 0) !== (C.m5.net > 0),
   JSON.stringify({ d1: C.v1 && C.v1.mainNetLots, d5: C.m5 && C.m5.net }));
ok('② ⭐⛔ 方向相反時要主動點出來(⛔ 不可讓使用者自己發現)',
   /方向相反,不是算錯/.test(ct), ct.slice(0, 400));
ok('② ⭐ 要把兩個時間範圍都標出來', /今日/.test(ct) && /近 5 日/.test(ct), ct.slice(0, 400));
ok('② ⭐ 要明說「兩張不是在吵架」', /不是在吵架/.test(ct), ct.slice(0, 500));
ok('② ⭐ 要給白話解讀(單日回補 / 單日獲利了結)',
   /單日回補|單日獲利了結/.test(ct), ct.slice(0, 500));
ok('② ⭐ 因子清單也要標「今日」(⛔ 不可只寫「主力」)',
   !/[•・]\s*主力今日整體大買/.test(ct), ct.slice(0, 600));
ok('② ⛔ 不可硬統一成一個數字(註解要寫明)', /不硬統一成一個數字/.test(C.src), '');

// 方向一致時⛔ 不可誤報
const same = await page.evaluate(a => {
    const P = {
        '1d': { buy: [{ name: 'A', net: 5000000, avg: 550 }], sell: [] },
        '5d': { buy: [{ name: 'A', net: 9000000, avg: 550 }], sell: [] },
    };
    return app._chipTomorrowScenario(P, +a.rows[a.rows.length - 1].close, null);
}, { rows });
ok('② ⭐⛔ 方向一致時不可出現打架提示(避免變雜訊)',
   !/方向相反/.test(txt(same)), txt(same).slice(0, 200));

// ══ ③ V72.1.4 K線頁「一句話結論」 ═══════════════════════════
//   使用者:「一目了然知道現在要怎麼做,而不是多個卡片自己講自己的」。
//   ⛔ 但照「單一劇本原則」,**操作指令一律以總覽為準** ——
//      這句只做兩件事:① 把訊號狀態翻成人話 ② 引用總覽的中期結論保持一致。
//      ⛔ 不可在這頁另外下一套買賣指令。
const HL = {};
for (const tr of ['bear', 'bull', null]) {
    HL[String(tr)] = await page.evaluate(a => {
        app.currentSymbolId = '2327'; app.rawDailyData = a.rows; app.activeData = a.rows;
        const cl = a.rows.map(x => +x.close);
        const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k);
        app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60), k: [], d: [], dif: [], macd: [] };
        app._ovTrend = a.tr ? { sym: '2327', trend: a.tr, txt: 'x' } : null;
        app.renderKbarTactics(a.rows);
        const el = document.getElementById('kbarHalfTactics');
        return el ? el.innerHTML : '';
    }, { rows, tr });
}
const hb = txt(HL.bear), hu = txt(HL.bull), hn = txt(HL.null);
ok('③ ⭐ 三種趨勢下都要有「一句話結論」',
   /一句話結論/.test(hb) && /一句話結論/.test(hu) && /一句話結論/.test(hn), hb.slice(0, 160));
ok('③ ⭐ 結論要放在訊號清單**之前**(第一眼看到)',
   hb.indexOf('一句話結論') < hb.indexOf('進場訊號'), `${hb.indexOf('一句話結論')} vs ${hb.indexOf('進場訊號')}`);
// ⚠️ V72.1.8:空頭時的結論句有**兩個分支**(有無正期望值訊號),各驗一次,
//   ⛔ 別假設實際資料一定落在其中一邊。
// ⓐ 只有風險訊號(看空/警示有成績、看多沒有)→ 走「沒進場訊號 + 有風險提醒」那條
const hbRisk = txt(await kbar({ map: { __all: -0.8 }, tr: 'bear' }));
// 🚧 空過守門:先確認測資真的落在「沒有進場訊號 + 有風險提醒」那條路,
//    ⛔ 否則下面那條斷言是在驗一個根本沒走到的分支(假綠燈/假失敗都可能)。
ok('③ 🚧 空過守門:萬用 stub 真的產生「只有風險提醒」的情境',
   /風險提醒/.test(hbRisk) && !/值得參考的進場訊號/.test(hbRisk), hbRisk.slice(0, 300));
ok('③ ⭐ 空頭 + 只有風險提醒 → 要說「中期趨勢也是空頭 → 觀望或減碼」',
   /中期趨勢也是空頭/.test(hbRisk) && /觀望或減碼/.test(hbRisk), hbRisk.slice(0, 400));
// ⓑ 完全沒有通過實測的訊號 → 措辭要精確(⛔ 不可說「今天沒有明確訊號」,摺疊區還有一堆)
const hbNone = txt(await kbar({ map: {}, tr: 'bear' }));
ok('③ ⭐ 完全沒通過實測時,措辭要說「沒有通過實測的訊號」而非「沒有明確訊號」',
   /沒有通過實測的訊號/.test(hbNone) && !/今天沒有明確訊號/.test(hbNone), hbNone.slice(0, 300));
ok('③ ⭐ 並要交代摺疊區還有幾條(⛔ 別讓人以為什麼都沒偵測到)',
   /另有 \d+ 條未驗證/.test(hbNone), hbNone.slice(0, 300));
ok('③ ⭐ 空頭 + 有正期望值訊號 → 要說「只能挑反彈減碼,不是進場理由」',
   !/1 個正期望值訊號/.test(hb) || (/反彈到哪裡減碼/.test(hb) && /不是進場理由/.test(hb)), hb.slice(0, 400));
ok('③ ⭐ 空頭時要標「(中期空頭)」', /中期空頭/.test(hb), hb.slice(0, 300));
ok('③ ⭐ 多頭時⛔ 不可硬套空頭文案', !/中期趨勢也是空頭/.test(hu), hu.slice(0, 400));
ok('③ ⭐ 總覽還沒算出趨勢時仍要能出結論(⛔ 不可空白或 throw)',
   /一句話結論/.test(hn) && !/中期/.test(hn.split('要買要賣')[0]), hn.slice(0, 300));
ok('③ ⭐⛔ 必須指路「具體價位以總覽為準」(單一劇本原則)',
   /以\s*總覽\s*→「現在怎麼做」\s*那張為準/.test(hb), hb.slice(0, 500));
ok('③ ⭐ 要說明這頁的定位(只負責解讀 K 線)', /只負責解讀 K 線/.test(hb), hb.slice(0, 500));
// ⛔ 這句本身不可出現具體買賣價位指令
const hlOnly = hb.slice(hb.indexOf('一句話結論'), hb.indexOf('只負責解讀 K 線'));
ok('③ ⭐⛔ 結論句本身不可下具體買賣指令(買進/掛單/停損價)',
   !/買進|掛單|停損 \d|目標價/.test(hlOnly), hlOnly.slice(0, 300));

// ══ ④ V72.1.5 籌碼頁「其他籌碼指標怎麼說」收斂成一行 ═══════════
//   籌碼頁最上方已有主結論卡(🐘 大戶籌碼總結),但下面明日劇本(分點**今日**)/
//   籌碼乾淨度 / 分點**近5日** 各自也在下結論 → 使用者不知道要看哪張。
//   ⭐ 壓成一行放進主結論卡,方向不一致時**直接講出來**。
//   ⛔ 不新開卡、⛔ 不改任何子指標的數字(那會失真);只做「收斂 + 點出分歧」。
{
    const CN = await page.evaluate(a => {
        app.currentSymbolId = '2327'; app.rawDailyData = a.rows; app.activeData = a.rows;
        app._fenSym = '2327'; app._fenPeriods = a.chips.periods; app._fenHist = a.chips.hist || null;
        app._lastChipClean = { sym: '2327', clean: 38, driver: '大戶倒貨給散戶' };
        const o = { clash: app._chipConsensusLine('2327', -2) };
        app._lastChipClean = { sym: '2327', clean: 80 };
        o.clean = app._chipConsensusLine('2327', -2);
        // 全同向(合成:今日大買 + 近5日大買 + 法人偏多)
        app._fenPeriods = { '1d': { buy: [{ name: 'A', net: 9e6, avg: 550 }], sell: [] },
                            '5d': { buy: [{ name: 'A', net: 9e6, avg: 550 }], sell: [] } };
        o.allBull = app._chipConsensusLine('2327', 2);
        app._fenPeriods = null;
        o.noFen = app._chipConsensusLine('2327', 2);
        o.src = app._chipConsensusLine.toString();
        o.wired = /_chipConsensusLine\(sym, sc\)/.test(app.renderChipVerdict.toString());
        return o;
    }, { rows, chips: chipsRaw || synth });
    const cl = txt(CN.clash);

    ok('④ ⭐ 有接進「大戶籌碼總結」主結論卡(⛔ 沒開新卡)', CN.wired, '');
    ok('④ ⭐ 方向分歧時要明說「X 項偏多、Y 項偏空」', /\d+ 項偏多、\d+ 項偏空/.test(cl), cl.slice(0, 300));
    ok('④ ⭐⛔ 要點出「不同時間範圍,不是誰算錯」', /不同時間範圍.{0,12}不是誰算錯/.test(cl), cl.slice(0, 300));
    ok('④ ⭐ 要給可操作的判準(連續 2~3 天同向才算數)', /連續 2~3 天同向/.test(cl), cl.slice(0, 400));
    ok('④ ⭐ 要勸阻「別只挑順眼的那個看」', /別只挑順眼的那個看/.test(cl), cl.slice(0, 400));
    ok('④ ⭐ 每一項都要標時間範圍(⛔ 這正是 V72.1.3 的教訓)',
       /法人近10日/.test(cl) && /分點今日/.test(cl) && /分點近5日/.test(cl), cl.slice(0, 400));
    ok('④ ⭐ 乾淨度差要另外警示(⛔ 但不計入多空,它不是方向)',
       /籌碼偏亂/.test(cl) && !/乾淨度.{0,6}(偏多|偏空)/.test(cl), cl.slice(0, 500));
    ok('④ 乾淨度好時不顯示那句警示', !/籌碼偏亂/.test(txt(CN.clean)), txt(CN.clean).slice(0, 300));
    // ⚠️ V72.1.6 自我修正:原本寫「方向一致 → **可信度較高**」是**預測性主張**,
    //   而籌碼訊號的預測力從沒驗證過(法人非零資料只回溯到 2026/04,約 60 個交易日)。
    //   ⛔ 違反鐵則「描述可以直接顯示,預測主張一定要先實測」→ 改成純事實描述。
    ok('④ ⭐ 全部同向時只做事實描述(方向一致)',
       /方向一致/.test(txt(CN.allBull)), txt(CN.allBull).slice(0, 300));
    ok('④ ⭐⛔ 不可宣稱「可信度較高 / 勝率」(那是沒驗證過的預測主張)',
       !/可信度較高|勝率|準確/.test(nono(txt(CN.allBull))) && !/可信度較高|勝率|準確/.test(nono(cl)),
       (nono(cl).match(/可信度較高|勝率|準確/) || []).join(','));
    // ⚠️ V73.3.6 更新這條斷言:舊版釘的是「預測力還沒驗證過 —— 樣本只有 60 天」,
    //   而那個**事實已經不成立了** —— 法人歷史回補到約 3 年後,`chip_probe.py` 驗過了
    //   (外資+投信同買 +0.99pp;「認錯回補」−0.04pp 不成立)。
    //   ⛔ 但**不可整條放寬** —— 分點那兩項(分點今日 / 分點近5日)仍然沒有逐日歷史可驗,
    //      那半的免責必須留著,而且要指路到新的實測成績區塊。
    ok('④ ⭐ 分點那半仍要標「預測力仍未驗證」+ 為什麼',
       /預測力仍未驗證/.test(cl) && /沒有歷史/.test(cl), cl.slice(-400));
    ok('④ ⭐ 要說清楚定位(只是描述今天長什麼樣,不是勝率)',
       /不是勝率/.test(cl), cl.slice(-400));
    ok('④ 要指路到法人的實測成績', /成績在下面那塊/.test(cl), cl.slice(-300));
    // ⛔ 反過來也要釘:法人那半**已經**驗過了 → 不可再宣稱「法人也沒驗證過 / 只有 60 天」
    ok('④ ⛔ 不可再寫「只有 60 天」那個過期理由',
       !/60 個交易日/.test(cl) && !/2026\/04/.test(cl), cl.slice(-400));
    ok('④ ⛔ 沒有分點資料 → 整行不顯示(不留空殼)', CN.noFen === '', String(CN.noFen).slice(0, 120));
    // ⚠️ 註解寫在函式**之前** → toString() 拿不到,必須讀原始檔(同 test_guardtime ⑦ 那次的坑)
    ok('④ ⛔ 註解要寫明「不改子指標數字」',
       /不改任何一個子指標的數字/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')), '');
}

// ══ ⑤ V72.1.7 缺值不可直接印給使用者看 ═══════════════════════
//   `renderChuKbarVerdict` 的 recentLow(波段低點)可能是 null →
//   原本印出「跌破前低 **--** 就撤」,使用者根本不知道要撤在哪(實測 2327)。
{
    // 🚨 V74.0.3:原本寫死用 2327 —— 但要驗的是「型態偏多·**但月線壓著**」那個分支,
    //    而 2327 現在是「型態轉弱」→ 三條斷言全部假失敗。
    //    ⭐ 改成**在真實資料裡找出**今天落在那個分支的一檔(找不到就大聲失敗,⛔ 不靜默跳過)。
    //    (CLAUDE.md V72.1.8:測試⛔不可綁死會浮動的資料狀態;而用真實資料仍是本專案偏好。)
    const renderVerdict = (sym, rws, tr) => page.evaluate(a => {
        app.currentSymbolId = a.sym; app.rawDailyData = a.rows; app.activeData = a.rows;
        app.peaks = []; app.troughs = [];          // ⭐ 刻意留空 = 「沒有波段低點」那個情境
        const cl = a.rows.map(x => +x.close);
        const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k);
        app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60), k: [], d: [], dif: [], macd: [] };
        app._ovTrend = a.tr ? { sym: a.sym, trend: a.tr, txt: '空頭' } : null;
        try { app.renderChuKbarVerdict(a.rows); } catch (e) { return 'ERR:' + e.message; }
        return (document.getElementById('chuVerdictCard') || {}).innerText || '';
    }, { sym, rows: rws, tr });

    const pool = fs.readdirSync(path.join(ROOT, 'data'))
        .filter(f => /^\d{4}\.json$/.test(f) && !/^00/.test(f)).sort();
    let hit = null;
    for (const f of pool) {
        let rws; try { rws = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch { continue; }
        if (!Array.isArray(rws) || rws.length < 120) continue;
        const t = await renderVerdict(f.replace('.json', ''), rws, null);
        if (/型態偏多.{0,4}但月線壓著/.test(t)) { hit = { sym: f.replace('.json', ''), rows: rws }; break; }
    }
    // 🚧 空過守門:全市場都找不到 → ⛔ 不可靜默跳過,要說清楚是「今天沒有這種股票」還是程式壞了
    ok('⑤ 🚧 空過守門:全市場找得到一檔落在「型態偏多·但月線壓著」', !!hit,
       `掃了 ${pool.length} 檔都沒有 —— 若確實是市況造成,請改用合成測資,⛔ 不可直接把斷言拿掉`);
    const NP = hit ? {
        bull: await renderVerdict(hit.sym, hit.rows, null),
        bear: await renderVerdict(hit.sym, hit.rows, 'bear'),
        sym: hit.sym,
    } : { bull: '', bear: '', sym: '-' };
    if (hit) console.log(`   ↳ ⑤ 用來驗的是 ${NP.sym}(今天剛好落在那個分支)`);
    const NULLPX = /(跌破|站上|守住?|突破|回測|停損|目標)[^。;,]{0,10}(--|—)/;
    ok('⑤ ⭐ 這張卡真的有渲染(⛔ 否則下面空過)', NP.bull.length > 50, String(NP.bull).slice(0, 120));
    ok('⑤ ⭐⛔ 不可出現「跌破前低 --」這種缺值',
       !NULLPX.test(NP.bull) && !NULLPX.test(NP.bear),
       (NP.bull.match(NULLPX) || NP.bear.match(NULLPX) || []).join(','));
    ok('⑤ ⭐ 沒有波段低點時要退回「近 20 日低」並改名(⛔ 別混為一談)',
       /近 20 日低 [\d,.]+/.test(NP.bull) || /前低 [\d,.]+/.test(NP.bull), NP.bull.slice(0, 200));
    ok('⑤ ⭐⛔ 中期空頭時不可說「現在追要快進快出」(講反話第 6 處)',
       !/現在追要快進快出/.test(NP.bear), NP.bear.slice(0, 260));
    ok('⑤ ⭐ 空頭時要改講「只能當反彈看,不是進場理由」',
       /只能當.{0,4}反彈.{0,4}看/.test(NP.bear) && /不是進場理由/.test(NP.bear), NP.bear.slice(0, 300));
    ok('⑤ ⛔ 非空頭時維持原本文案(別把正常情境弄壞)',
       /先站回月線才算真轉強/.test(NP.bull), NP.bull.slice(0, 260));
}

ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ KCHIP_AUDIT_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ KCHIP_AUDIT_PASS');
