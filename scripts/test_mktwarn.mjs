#!/usr/bin/env node
/**
 * 🔕 V79.3.5 大盤警示「只描述、不推播」守門(使用者:「回測沒過的推播拿掉、改成只描述」)
 *
 * 背景:`crash_warn_probe.mjs`(加權 2000~2026、上市個股廣度、期貨、美股)量了 24 種大盤警示,
 *   **沒有一種六關全過**;而 App 畫面上好幾張卡在叫人「減碼 / 空手 / 現金為王 / 全出清」,還會跳通知。
 * 這支釘住:
 *   ① 大盤層級的提醒(風險指數 / 反攻雷達黑天鵝 / 全球熔斷)⛔ 不可再 `_fireAlert`,只進 🔔 鈴鐺(`_alertQuiet`)
 *   ② 那幾張卡的文案 ⛔ 不可再叫人減碼 / 空手 / 現金為王 / 全出清 /「常是頭部前兆」
 *   ③ 壞掉的輸入修好:出貨日(指數量是 0 → 改比成交金額)、熔斷通知讀錯欄位(label → name)
 *   ④ 死卡「🔄 大盤現在是什麼盤」⛔ 不可復活(只拿到 10 天資料、修好會跟盤勢 chip 打架)
 *   ⑤ Telegram:重大事件 ⛔ 不再單獨推「持股減 1/3」、改成盤前簡報一行;主力出貨指數只描述
 *   ⑥ 探針自己的 selftest 要過
 * 每一條都有「拿掉修法就紅」的決定性對照(注入見最下面 INJECT=1)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const WK = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails++; };

/** 取函式本體(到同縮排的 `},` 為止),並拿掉整行註解(註解裡記錄舊寫法是合法的) */
const body = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n    },\n', i);
    return src.slice(i, j < 0 ? i + 20000 : j).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
};
const BAD = /現金為王|持股先減碼|立即砍到|全市場都要減碼|持股只留核心|反彈是逃命波|空手觀望最安全|減碼至 ?3 成|全出清|送分題族群|金字塔加碼|先減碼 ?1\/3|3 成以下 或 空手|常是頭部前兆|主力可能殺出/;

// ── ① 推播 → 只進鈴鐺 ──
const fRisk = body(SRC, '    _checkMarketAlerts() {');
const fRadar = body(SRC, '    _renderReboundRadar(');
const fCb = body(SRC, '    _renderCircuitBreakerAlert() {');
ok('① 🚧 空過守門:三支函式都抓得到', fRisk.length > 300 && fRadar.length > 3000 && fCb.length > 800, `${fRisk.length}/${fRadar.length}/${fCb.length}`);
ok('① 風險指數 / 反攻雷達黑天鵝 / 全球熔斷 ⛔ 不可再 `_fireAlert`,改 `_alertQuiet`(只進 🔔 鈴鐺)',
   !/_fireAlert/.test(fRisk + fRadar + fCb) && /_alertQuiet\(/.test(fRisk) && /_alertQuiet\(/.test(fRadar) && /_alertQuiet\(/.test(fCb));

// ── ② 文案只描述 ──
const fGauge = body(SRC, '    _overallGaugeHtml(ind, last, C, trend, big, cost) {');
const fBreadth = body(SRC, '    renderMarketBreadth(');
const fChu = body(SRC, '    _chuPositionAdvice() {');
const fRegime = body(SRC, '    _detectMarketRegime() {');
const fBubble = body(SRC, '    _updateBubbleCrashCard() {');
const fDist = body(SRC, '    async _renderDistributionDays() {');
const jRisk = (SRC.match(/'市場風險指數': '[^\n]*/) || [''])[0], jDist = (SRC.match(/'歐尼爾出貨日': '[^\n]*/) || [''])[0];
const weather = (SRC.match(/\$\('weatherHealthSub'\)\.textContent = [^\n]*/) || [''])[0];
const parts = { 風險推播: fRisk, 反攻雷達: fRadar, 熔斷: fCb, 總評緊急列: fGauge, 市場廣度: fBreadth, 朱老師部位: fChu, 盤勢: fRegime, 泡沫破裂: fBubble, 出貨日卡: fDist, 名詞風險指數: jRisk, 名詞出貨日: jDist, 天氣健康度: weather };
const hits = Object.entries(parts).filter(([, t]) => BAD.test(t)).map(([k, t]) => `${k}:${(t.match(BAD) || [])[0]}`);
ok('② 🚧 空過守門:每一段都抓得到', Object.values(parts).every(t => t.length > 40), Object.entries(parts).filter(([, t]) => t.length <= 40).map(([k]) => k).join('、'));
ok('② ⛔ 大盤警示不可再叫人減碼 / 空手 / 現金為王 / 全出清 /「常是頭部前兆」', hits.length === 0, hits.join(' | '));
ok('② 風險指數 ≥68 ⛔ 不再進紅框「緊急警示」(改成描述那一格)', /riskS >= 68\) emgNote\.push/.test(fGauge) && !/riskS >= 68\) emg\.push/.test(fGauge));
ok('② 反攻雷達的外資期貨改讀 `_fiFutState()`(⛔ 不再自己算 5 日增減)', /this\._fiFutState\(\)/.test(fRadar) && !/fh\[fh\.length - 6\]/.test(fRadar));
ok('② 反攻雷達 / 泡沫卡的 VIX 走 `_vixState()`(V75.2.3 唯一來源)', /_vixState\(\)/.test(fRadar) && /_vixState\(\)/.test(fBubble));

// ── ④ 死卡 ⛔ 不可復活 ──
ok('④ 「🔄 大盤現在是什麼盤」死卡 ⛔ 不可復活(renderMarketRegime / _marketRegime / #marketRegimeCard)',
   !/renderMarketRegime\(\)\s*\{/.test(SRC) && !/_marketRegime\(\)\s*\{/.test(SRC) && !/id="marketRegimeCard"/.test(SRC) && !/this\.renderMarketRegime\(/.test(SRC));

// ── ⑤ Telegram ──
const wkCode = WK.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');   // 整行註解 / JSDoc 不算(那是紀錄舊寫法)
ok('⑤ worker ⛔ 不再有「持股減 50% / 1/3」範本、⛔ 不再單獨推重大事件', !/tplBlackswan\(/.test(wkCode) && !/持股減/.test(wkCode) && /const macroAlert = null/.test(wkCode));
ok('⑤ worker 盤前簡報有重大事件那一行、主力出貨指數兩處都走 `mmVerdictOf`', /premarketEventLine\(macro\)/.test(wkCode) && (wkCode.match(/= mmVerdictOf\(mmIndex\)/g) || []).length === 2 && !/主力可能殺出/.test(wkCode),
   `${(wkCode.match(/= mmVerdictOf\(mmIndex\)/g) || []).length} 處`);
{
    const W = await import(pathToFileURL(path.join(ROOT, 'cloud-worker/worker.js')).href);
    const today = new Date().toISOString().slice(0, 10);
    const ev = W.premarketEventLine({ upcoming_macro_events: [{ date: today, event: 'FOMC 利率決議', severity: '高' }] });
    ok('⑤ 重大事件那一行:只講波動、⛔ 不預設漲跌、⛔ 不給部位', /FOMC/.test(ev) && /波動/.test(ev) && /不預設漲跌/.test(ev) && !/減|賣|空手|成/.test(ev.replace('不預設漲跌', '')), ev);
    ok('⑤ 沒有重大事件 → 那一行整個不出現', W.premarketEventLine({ upcoming_macro_events: [] }) === '' && W.premarketEventLine(null) === '');
    ok('⑤ 主力出貨指數的那句話 ⛔ 不可用 🔴🟢(燈號鐵則)、⛔ 不可預告', [0, 45, 80].every(x => !/🔴|🟢|殺出|託盤/.test(W.mmVerdictOf(x))) && /⚠️/.test(W.mmVerdictOf(80)), [0, 45, 80].map(W.mmVerdictOf).join(' / '));
    ok('⑤ `fiFutChg5`:不夠 6 筆 → null(⛔ 不硬判)', W.fiFutChg5([{ fi_futures_net: -80000 }]) === null && W.fiFutChg5(null) === null);
}

// ── ⑥ 探針 selftest ──
{
    let out = '';
    try { out = execFileSync('node', [path.join(ROOT, 'scripts/crash_warn_probe.mjs'), '--selftest'], { encoding: 'utf8', timeout: 240000 }); } catch (e) { out = String(e.stdout || '') + String(e.message || ''); }
    ok('⑥ crash_warn_probe --selftest 全過', /CRASH_WARN_SELFTEST_PASS/.test(out), out.split('\n').filter(l => l.startsWith('❌')).join(' | '));
}

// ── ③ 動態:真的跑一次 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }), writable: true, configurable: true });
});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._checkMarketAlerts && !!app._calcDistributionDays, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const o = {};
    const fired = [], quiet = [];
    const _f = app._fireAlert, _r = app._recordNotifHistory;
    app._fireAlert = (t, b) => { fired.push(t); };
    app._recordNotifHistory = (t, b) => { quiet.push([t, b]); };
    // ③a 風險指數 90 → 只進鈴鐺
    const _rs = app._calcRiskScore;
    app._calcRiskScore = () => 90; app.settings = Object.assign({}, app.settings, { riskAlertThreshold: 60, watchlistAlert: true });
    app._alertCache = {};
    try { Object.keys(localStorage).filter(k => k.startsWith('mktrisk_')).forEach(k => localStorage.removeItem(k)); } catch (_) {}
    try { app._checkMarketAlerts(); } catch (e) { o.err1 = e.message; }
    o.risk = { fired: fired.slice(), quiet: quiet.slice() };
    // ③a2 🔕 V79.3.5 只進鈴鐺之後要「一天一筆」:同一頁再叫一次 + 模擬重開 App(清記憶體去重)都 ⛔ 不可再記一筆
    try { app._checkMarketAlerts(); } catch (e) { o.err1 = e.message; }
    app._alertCache = {};
    try { app._checkMarketAlerts(); } catch (e) { o.err1 = e.message; }
    o.riskAgain = quiet.length;
    // 決定性對照:把 localStorage 那個鍵清掉 = 隔天(新的一天)→ 要再記一筆
    try { Object.keys(localStorage).filter(k => k.startsWith('mktrisk_')).forEach(k => localStorage.removeItem(k)); } catch (_) {}
    app._alertCache = {};
    try { app._checkMarketAlerts(); } catch (e) { o.err1 = e.message; }
    o.riskNewDay = quiet.length;
    app._calcRiskScore = _rs;
    // ③b 全球熔斷:標普 −7.5% → 鈴鐺內文要有指數名字(舊碼讀 label → 空的)
    fired.length = 0; quiet.length = 0;
    const mk = (id, txt) => { let el = document.getElementById(id); if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); } el.textContent = txt; return el; };
    mk('circuitBreakerAlert', ''); mk('usBar_spx_chg', '-7.50%');
    try { localStorage.clear(); } catch (_) {}
    try { app._renderCircuitBreakerAlert(); } catch (e) { o.err2 = e.message; }
    o.cb = { fired: fired.slice(), quiet: quiet.slice(), html: document.getElementById('circuitBreakerAlert').innerText };
    app._fireAlert = _f; app._recordNotifHistory = _r;
    // ③c 出貨日:指數量 = 0、只有成交金額 → 也要算得出來;拿掉成交金額 → 0(決定性對照)
    const rows = [];
    let c = 100;
    for (let i = 0; i < 30; i++) {
        const dn = i % 3 === 2;                       // 每 3 天一根「跌 1%、金額變大」;那天最高 = 前一天收盤 ×1.001(後面小漲收不回去)
        const pc = c;
        c = dn ? c * 0.99 : c * 1.001;
        rows.push({ date: `2026/09/${String(i + 1).padStart(2, '0')}`, open: pc, high: dn ? pc * 1.001 : c * 1.0005, low: c * 0.995, close: c, volume: 0, amount: dn ? 2e11 : 1e11 });
    }
    o.distAmt = app._calcDistributionDays(rows, 25);
    o.distNoAmt = app._calcDistributionDays(rows.map(r => ({ ...r, amount: 0 })), 25);
    o.distVol = app._calcDistributionDays(rows.map(r => ({ ...r, volume: r.amount / 1e3, amount: 0 })), 25);
    // ③d 朱老師部位:年線乖離 −8% → 只擋新單、⛔ 空手;_mktGate 照樣守門
    const _m = app._macroRiskCache;
    app._macroRiskCache = Object.assign({}, _m || {}, { taiex_ma240_bias: -8 });
    o.chuBear = app._chuPositionAdvice(); o.gateBear = !!app._mktGate();
    app._macroRiskCache = Object.assign({}, _m || {}, { taiex_ma240_bias: 8 });
    // ⏰ V79.5.6 「多頭但已破月季線」要看真的加權 K 線(`_twiiBrokeMedium`)→ 測資一換(10/22 加權破了月線季線)
    //   這條就跟著行情變紅。這一格驗的是「健康多頭那格一個字都沒被改到」→ 把月季線釘成「沒破」
    const _bm = app._twiiBrokeMedium; app._twiiBrokeMedium = () => 0;
    o.chuBull = app._chuPositionAdvice();
    app._twiiBrokeMedium = () => 2;
    o.chuWeak = app._chuPositionAdvice();
    app._twiiBrokeMedium = _bm;
    app._macroRiskCache = _m;
    // ③e 泡沫破裂卡:VIX 35 + 外資賣 500 億 → 兩格只叫你照出場規則
    ['bubbleCrashSection', 'bubbleCrashType', 'bubbleCrashReason', 'bubbleCrashHoldAction', 'bubbleCrashEmptyAction', 'bubbleCrashSectors', 'bubbleCrashSectorList'].forEach(id => mk(id, ''));
    const _vs = app._vixState; app._vixState = () => ({ val: 35, src: 'macro_risk' });
    const _m2 = app._macroRiskCache; app._macroRiskCache = Object.assign({}, _m2 || {}, { vix: 35, fi_spot_net: -500 });
    try { app._updateBubbleCrashCard(); } catch (e) { o.err3 = e.message; }
    o.bubble = ['bubbleCrashType', 'bubbleCrashReason', 'bubbleCrashHoldAction', 'bubbleCrashEmptyAction'].map(id => document.getElementById(id).innerText).join(' | ');
    app._vixState = _vs; app._macroRiskCache = _m2;
    return o;
});
await browser.close();

ok('③a 風險指數 90 ⛔ 不跳通知、只進鈴鐺一筆,內文只描述',
   R.risk.fired.length === 0 && R.risk.quiet.length === 1 && /不是賣出訊號/.test(R.risk.quiet[0][1]) && !BAD.test(R.risk.quiet[0][1]), JSON.stringify(R.risk) + (R.err1 || ''));
ok('③a2 🔕 一天只記一筆:同頁再叫 + 重開 App(清記憶體去重)⛔ 不重複;清掉當天那個鍵(= 隔天)才再記',
   R.riskAgain === 1 && R.riskNewDay === 2, `重叫後 ${R.riskAgain} 筆 / 換一天 ${R.riskNewDay} 筆`);
ok('③b 全球熔斷 ⛔ 不跳通知、鈴鐺內文要有指數名字(修 label → name)',
   R.cb.fired.length === 0 && R.cb.quiet.length === 1 && /S&P500/.test(R.cb.quiet[0][1]) && /-7\.50%/.test(R.cb.quiet[0][1]), JSON.stringify(R.cb).slice(0, 400) + (R.err2 || ''));
ok('③b 熔斷卡 ⛔ 不可再寫「次日平均跌幾 %」這種沒驗過的數字', !/平均 ?-\d/.test(R.cb.html) && /波動/.test(R.cb.html), R.cb.html.slice(0, 300));
ok('③c ⭐ 出貨日:指數量是 0 也算得出來(用成交金額)', R.distAmt >= 3, `成交金額版 ${R.distAmt}`);
ok('③c ⭐ 決定性對照:同一份資料拿掉成交金額 → 0(證明是金額那條在算)', R.distNoAmt === 0 && R.distVol === R.distAmt, `沒金額 ${R.distNoAmt} / 用量 ${R.distVol}`);
ok('③d 大盤空頭 → 只擋新單(新單少量)、⛔ 空手 / 減碼;`_mktGate` 照樣守門',
   R.chuBear.regime === 'bear' && /新單少量/.test(R.chuBear.pct) && !/空手|減碼/.test(R.chuBear.pct + R.chuBear.advice) && R.gateBear, JSON.stringify(R.chuBear));
ok('③d 大盤多頭 → 8 成照舊(⛔ 不可改到沒問題的那格)', R.chuBull.regime === 'bull' && /^8 成/.test(R.chuBull.pct), JSON.stringify(R.chuBull));
ok('③d2 多頭但破月季線 → 保守、手上的照出場規則走(⛔ 不叫你賣)', R.chuWeak.regime === 'bull' && /保守/.test(R.chuWeak.pct) && /出場規則/.test(R.chuWeak.advice) && !/減碼|出清|空手/.test(R.chuWeak.advice), JSON.stringify(R.chuWeak));
ok('③e 泡沫破裂卡:只描述、兩格都「照你的出場規則走」', /照你的出場規則走/.test(R.bubble) && !BAD.test(R.bubble) && /VIX/.test(R.bubble), R.bubble + (R.err3 || ''));
ok('③ 全程無 pageerror', errs.length === 0, errs.join(' | '));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ MKTWARN_PASS(全部通過)');
process.exit(fails ? 1 : 0);
