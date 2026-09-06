#!/usr/bin/env node
/**
 * 🚦「現在怎麼做」三個打架點(V73.2.8,使用者截圖抓到)
 *
 * ① 🐛 **價位已經過了還叫人等**(陷阱 #46 再犯)
 *    6206 飛捷:現價 158(漲停鎖死),卡上卻寫「帶量突破前高 **153.50** → 買進」。
 *    ⚠️ 同一個函式裡的 `_pushTrig` 早就有 `rHigh > C` 守門 —— **只有顯示端漏掉**,
 *       所以「提醒」是對的、「文字」是錯的,自己跟自己不一致。
 *
 * ② 🚨 **緊急警示 vs 大字結論**
 *    6533 晶心科:上面紅框寫「緊急警示(最優先):疑主力出貨,明天不漲快跑」,
 *    下面大字卻寫「可以布局」。卡片自己說那條最優先,結論卻完全沒理它。
 *
 * ③ ⚠️ **同名不同義**:頂端 badge「波段空頭」(高低點結構) vs 這裡「多頭・行進間」(均線排列)。
 *    兩個都沒算錯,但⛔ 不可讓使用者自己去發現。
 *
 * ⛔ 兩邊都要釘:出問題時要改口,**正常時也不可誤傷**(⛔ 只驗一邊會做出過度修正)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

// ── ① 靜態:盤整分支的兩條規則一定要有現價守門 ─────────────────────
const flatBlk = (src.match(/why = '這檔在盤整\(方向不明\)[\s\S]{0,1600}?\n            \}/) || [''])[0];
ok('①a 盤整分支存在(前置條件,⛔ 免得後面驗到空字串)', flatBlk.length > 200, `len=${flatBlk.length}`);
ok('①b 前高那條有 `rHigh > C` 守門', /rHigh\s*>\s*C/.test(flatBlk), flatBlk.slice(0, 200));
ok('①c 前低那條有 `rLow < C` 守門', /rLow\s*<\s*C/.test(flatBlk));
ok('①d 已突破時要改口(出現「已經被突破」)', /已經被突破/.test(flatBlk));
ok('①e 已跌破時要改口(出現「早就跌破」)', /早就跌破/.test(flatBlk));
ok('②a 有讀 _lastGauge.emg(緊急警示)', /_lastGauge[\s\S]{0,80}?\.emg/.test(src));
ok('②b 緊急警示的 warn 是**最後**覆寫的(⛔ 不可被大盤/賺賠比蓋掉)',
    /if \(_emgOn\) warn =/.test(src) && src.indexOf('if (_emgOn) warn =') > src.indexOf('賺賠不划算'));
ok('③a 有偵測波段結構與均線的分歧', /_swingClash/.test(src));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderTrendCommand, null, { timeout: 20000 });

/** 造一段「盤整 + 今天噴出過前高」的 K 線,直接跑真的 _renderTrendCommand */
const run = ({ lastClose, emg = [], rHigh = 112, rLow = 96 }) => page.evaluate(a => {
    let box = document.getElementById('trendCommandCard');
    if (!box) { box = document.createElement('div'); box.id = 'trendCommandCard'; document.body.appendChild(box); }
    box.innerHTML = ''; box.classList.remove('hidden');
    // ⚠️ 測資要同時滿足兩件事,⛔ 少一件就掉到別的分支(第一版就是這樣被 ①f 抓到):
    //   ① 均線**不可**排成多頭也不可排成空頭 → 用「緩步走低的箱型」讓 ma20 < ma60、ma5 > ma20
    //   ② 要有**清楚的波段高低點**,`_pks/_trs` 才抓得到 rHigh/rLow(純正弦波抓不到)
    const rows = [];
    let d = 0;
    for (let i = 0; i < 200; i++) {
        const drift = 120 - i * 0.1;                       // 緩降 → ma20 會低於 ma60
        const zig = (Math.floor(i / 10) % 2 === 0) ? (i % 10) : (10 - (i % 10));  // 明確鋸齒
        const base = drift + zig * 1.4 - 7;
        d++;
        rows.push({
            date: `2025-${String(1 + (d % 12)).padStart(2, '0')}-${String(1 + (d % 27)).padStart(2, '0')}`,
            open: base, high: base + 1.5, low: base - 1.5, close: base, volume: 3000000,
        });
    }
    const c = a.lastClose;
    rows.push({ date: '2026-08-10', open: c - 3, high: c, low: c - 4, close: c, volume: 9000000 });
    // ⚠️ _renderTrendCommand(data, ind, last) 的 ind 是**均線陣列**、last 是索引 ——
    //    ⛔ 不可傳 app.indicators({}),那會在 `!ind.ma20` 就早退(第一版就栽在這,靠 ①f 空過守門抓到)
    const ma = n => rows.map((_, i) => {
        if (i < n - 1) return null;
        let s = 0; for (let k = i - n + 1; k <= i; k++) s += rows[k].close;
        return s / n;
    });
    const ind = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
    app.currentSymbolId = 'TST';
    app.rawDailyData = rows;
    app.activeData = rows;
    app.inventory = [];
    app.indicators = ind;
    // ⚠️ rHigh/rLow 讀的是 `app.peaks` / `app.troughs`(波段轉折,由 worker 算好後掛上來),
    //    ⛔ 不是從 data 現算 → 測試要直接餵,否則兩條規則整個不會出現(①f 之後靠 ①h/①i 才抓到)
    app.peaks = [{ i: 190, val: a.rHigh }];
    app.troughs = [{ i: 195, val: a.rLow }];
    app._lastGauge = { emg: a.emg };
    try { app._renderTrendCommand(rows, ind, rows.length - 1); } catch (e) { return 'ERR:' + e.message; }
    const L = rows.length - 1;
    const diag = `[diag ma5=${ind.ma5[L].toFixed(1)} ma20=${ind.ma20[L].toFixed(1)} ma60=${ind.ma60[L].toFixed(1)} C=${c}]`;
    return diag + '\n' + box.innerText;
}, { lastClose, emg, rHigh, rLow });

// 先確認測資真的落在「盤整」分支(⛔ 空過守門:沒落在這條分支等於什麼都沒驗)
const txtHigh = await run({ lastClose: 128, rHigh: 112, rLow: 96 });          // 遠高於箱頂 → 前高一定 < 現價
ok('①f 測資真的落在盤整分支(前置條件成立)', /先等它表態|盤整/.test(txtHigh), String(txtHigh).slice(0, 200));

// ── ① 已經突破了 → ⛔ 不可再叫人「等突破」 ──────────────────────
const badAsk = /帶量突破前高\s*([\d.,]+)/.exec(txtHigh || '');
let broke = false;
if (badAsk) {
    const p = parseFloat(badAsk[1].replace(/,/g, ''));
    broke = p <= 128;   // 叫人等一個「比現價低」的價 = 就是那個 bug
}
ok('①g ⛔ 不可出現「等突破一個比現價低的前高」', !broke, badAsk ? `寫了「帶量突破前高 ${badAsk[1]}」但現價 128` : '');
ok('①h 已突破時要改口說「已經被突破」', /已經被突破/.test(txtHigh || ''), String(txtHigh).slice(0, 400));

// 反向:現價在箱型中間 → 前高在上面 → 這時**應該**照常叫人等突破(⛔ 不可誤傷)
const txtMid = await run({ lastClose: 105, rHigh: 112, rLow: 96 });
ok('①i 正常情況仍要給「帶量突破前高」(⛔ 不可過度修正)', /帶量突破前高/.test(txtMid || ''), String(txtMid).slice(0, 300));
ok('①j 正常情況⛔ 不可誤報「已經被突破」', !/已經被突破/.test(txtMid || ''));

// ── ② 緊急警示 ────────────────────────────────────────────────
const txtEmg = await run({ lastClose: 105, rHigh: 112, rLow: 96, emg: ['今天高檔爆量收黑 → 疑主力出貨,明天不漲快跑'] });
ok('②c 有緊急警示時要明說「等警示消失再執行」', /等警示消失再執行/.test(txtEmg || ''), String(txtEmg).slice(0, 400));
ok('②d 沒有緊急警示時⛔ 不可亂加那句', !/等警示消失再執行/.test(txtMid || ''));

// ── ⑤ 大盤部位上限:個股卡與「明日劇本」都要跟著大盤狀態改口 ──────────
//    🐛 page_sweep 抓到:個股卡寫「可順勢做多/抱單」,大盤條卻寫
//       「多頭(過熱)・建議 3~5 成・**絕不追高**」→ 同一畫面兩個相反的動詞。
//    ⛔ 舊版只在 regime==='bear' 提醒,漏掉 過熱 / 轉弱 / 盤整 三種。
const regimeCase = (pct, label, advice, regime) => page.evaluate(a => {
    const _orig = app._chuPositionAdvice;
    app._chuPositionAdvice = () => ({ regime: a.regime, regimeLabel: a.label, pct: a.pct, advice: a.advice, bias: 0, color: '' });
    let out = '';
    try {
        let box = document.getElementById('trendCommandCard');
        if (!box) { box = document.createElement('div'); box.id = 'trendCommandCard'; document.body.appendChild(box); }
        box.innerHTML = ''; box.classList.remove('hidden');
        const rows = []; for (let i = 0; i < 200; i++) { const b = 120 - i * 0.1 + ((Math.floor(i / 10) % 2 === 0) ? (i % 10) : (10 - (i % 10))) * 1.4 - 7; rows.push({ date: `2025-01-0${1 + (i % 9)}`, open: b, high: b + 1.5, low: b - 1.5, close: b, volume: 3000000 }); }
        rows.push({ date: '2026-08-10', open: 102, high: 106, low: 101, close: 105, volume: 9000000 });
        const ma = n => rows.map((_, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += rows[k].close; return s / n; });
        const ind = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
        app.currentSymbolId = 'TST'; app.rawDailyData = rows; app.activeData = rows; app.inventory = [];
        app.indicators = ind; app.peaks = [{ i: 190, val: 112 }]; app.troughs = [{ i: 195, val: 96 }]; app._lastGauge = { emg: [] };
        app._renderTrendCommand(rows, ind, rows.length - 1);
        out = document.getElementById('trendCommandCard').innerText;
    } catch (e) { out = 'ERR:' + e.message; }
    app._chuPositionAdvice = _orig;
    return out;
}, { pct, label, advice, regime });

const overheat = await regimeCase('3~5 成(只留強勢股)', '🐂 多頭(過熱)', '位階過高、乖離過大,絕不追高;嚴設停損、分批停利,提防急拉回', 'bull');
ok('⑤a 大盤過熱時要在個股卡講出總部位上限', /3~5 成/.test(overheat) && /多頭\(過熱\)/.test(overheat), String(overheat).slice(0, 300));
const full = await regimeCase('8 成', '🐂 多頭', '可順勢做多,擇優股建倉', 'bull');
ok('⑤b 大盤正常(8 成)時⛔ 不可亂加上限提醒(防過度修正)', !/總部位建議/.test(full), String(full).slice(0, 300));
const bearMkt = await regimeCase('3 成以下 或 空手', '🐻 空頭', '空手觀望最安全,別硬接刀', 'bear');
ok('⑤c 大盤空頭時仍要用原本那句(⛔ 不可被新分支蓋掉)', /大盤現在偏空/.test(bearMkt), String(bearMkt).slice(0, 200));

// ⑥ 明日劇本的「開高」動詞要跟著大盤改
ok('⑥a 明日劇本有讀大盤部位上限', /_mktCap/.test(src));
ok('⑥b 大盤要縮手時⛔ 不可再寫「可順勢做多」', /_mktCap[\s\S]{0,400}?別追高加碼/.test(src));
ok('⑥c 大盤正常時仍保留原句(⛔ 不可一律改掉)', src.includes('可順勢做多/抱單,回不破昨高續抱'));

ok('④ 全程無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
