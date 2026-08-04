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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderKbarTactics, null, { timeout: 20000 });

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

// ⭐ 這組真實資料今天剛好**沒有**正期望值的看多訊號 → 必須誠實說,並勸阻
ok('① ⭐ 沒有正期望值訊號時要誠實說「沒有」', /沒有.{0,20}進場訊號/.test(kt), kt.slice(0, 300));
ok('① ⭐ 要勸阻「別硬找理由進場」', /別硬找理由進場/.test(kt), kt.slice(0, 300));
ok('① ⭐ 風險提醒要標「不是賣出指令」', /不是賣出指令/.test(kt), kt.slice(0, 460));

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
ok('③ ⭐ 空頭時要點出「中期趨勢也是空頭 → 觀望或減碼」',
   /中期趨勢也是空頭/.test(hb) && /觀望或減碼/.test(hb), hb.slice(0, 400));
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

ok('④ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ KCHIP_AUDIT_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ KCHIP_AUDIT_PASS');
