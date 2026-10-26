#!/usr/bin/env node
/**
 * 📶 V79.9.2 背景一次抓很多檔 K 線:抓不到 ⛔ 跳紅框(使用者 10/26 通話中手機網路,選股頁背景連跳 5 個「無法載入 X 資料」)
 *   ① 選股頁「今日觸發」徽章(_fillRadarTriggerBadges)前 3 檔 OK、後 5 檔回 504 → 紅框 0 個、成功那 3 檔照樣畫徽章、失敗的每檔重試一次
 *   ② ⭐ 決定性對照:同一個假網路,使用者自己開那一檔(沒帶 quiet)→ 照舊 1 個紅框
 *   ③ 離開選股頁(switchAppTab 到決策台)→ 背景迴圈停,⛔ 再發 data/*.json 請求
 *   ④ 有抓不到的掃描卡寫一行灰字(data-klmiss = 幾檔),⛔ 靜默;有抓不到 ⛔ 快取
 *   ⑤ 背景同時最多 4 檔在抓(_klBgRun 排隊);使用者自己點的不排隊
 *   INJECT=noquiet → quiet 旗標失效(背景照樣跳紅框)→ ① 必紅;BG_FILE=拿掉離開就停那行的副本 → ③ 必紅(6 檔全抓)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let HTML = process.env.BG_FILE || path.join(ROOT, 'index.html');
const SRC0 = fs.readFileSync(HTML, 'utf8');
if (process.env.INJECT === 'noquiet') {
    const a = 'let r = await this._klFetchOnce(symbol, forceRefresh, true);';
    if (!SRC0.includes(a)) { console.error('❌ 注入點找不到'); process.exit(1); }
    HTML = path.join(os.tmpdir(), 'bgfetch_inject.html');
    fs.writeFileSync(HTML, SRC0.replace(a, 'let r = await this._klFetchOnce(symbol, forceRefresh, false);'));
    console.log('🧪 INJECT=noquiet:背景抓也跳紅框');
}
const SRC = fs.readFileSync(HTML, 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\s\/\/\s.*$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails++; };

// ── 靜態 ──
ok('⓪a 離開選股頁就讓背景徽章迴圈停(_radarTrigRun++)', /if \(tabId !== 'radar'\) this\._radarTrigRun = \(this\._radarTrigRun \|\| 0\) \+ 1;/.test(CODE));
{
    // 背景呼叫點都要帶 quiet(函式名 → 那一段裡必須有 quiet: true)
    const fnBody = name => { const i = CODE.indexOf(`    async ${name}(`); if (i < 0) return ''; const j = CODE.indexOf('\n    },', i); return CODE.slice(i, j); };
    const bg = ['_fillRadarTriggerBadges', '_renderFavRsRank', '_scanBreakoutCandidates', '_scanWatchlistCheckup', 'scanAllMonitored', '_potentialScan', 'refreshInventoryPrices', '_renderAiGodFavMode', 'openAiGod', 'renderFavList', 'addAllChuTabToMonitor', 'addAllGreenLightToMonitor'];
    const missQ = bg.filter(n => { const b = fnBody(n); return !b || /fetchHistoricalData\([^)]*\bfalse\)/.test(b) || !/fetchHistoricalData\([^)]*quiet: true/.test(b); });
    ok(`⓪b 背景 ${bg.length} 處都帶 { quiet: true }`, missQ.length === 0, missQ.join(','));
    const fg = ['analyze', 'addChuPickToMonitor', '_renderAiGodStockMode'];
    const quietFg = fg.filter(n => /quiet: true/.test(fnBody(n)));
    ok('⓪c 使用者自己點的那一檔⛔ 帶 quiet(抓不到要知道)', quietFg.length === 0, quietFg.join(','));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._klBgRun && !!app.idb, null, { timeout: 60000 });
await page.waitForTimeout(2500);

const R = await page.evaluate(async () => {
    const A = app, out = {};
    const GOOD = ['9101', '9102', '9103'], BAD = ['9201', '9202', '9203', '9204', '9205'];
    const mkK = n => { const rows = []; let c = 50; const t0 = Date.now() - n * 86400000; for (let k = 0; k < n; k++) { const d = new Date(t0 + k * 86400000); c = c * (1 + ((k % 7) - 3) * 0.004); rows.push({ date: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 }); } return rows; };
    const req = {}; let inflight = 0, maxIn = 0, delay = 0;
    const fake = async (u) => {
        const m = String(u).match(/data\/(\d{4})\.json/);
        if (!m) return new Response('{}', { status: 404 });
        const s = m[1]; req[s] = (req[s] || 0) + 1;
        inflight++; maxIn = Math.max(maxIn, inflight);
        try {
            if (delay) await new Promise(r => setTimeout(r, delay));
            if (BAD.includes(s) || s.startsWith('93')) return new Response('{}', { status: 504 });
            return new Response(JSON.stringify(mkK(80)), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } finally { inflight--; }
    };
    const realFetch = window.fetch; window.fetch = (u, o) => (/data\/\d{4}\.json/.test(String(u)) ? fake(u) : realFetch(u, o));
    const toasts = []; const realToast = A.showToast.bind(A); A.showToast = (m, ...x) => { toasts.push(String(m)); return realToast(m, ...x); };
    for (const s of [...GOOD, ...BAD]) { try { await A.idb.del(`proTerm_kline_${s}`); } catch (_) {} }

    // ① 選股頁徽章
    const tb = document.createElement('div');
    tb.innerHTML = [...GOOD, ...BAD].map(s => `<span data-radar-trig="${s}"></span>`).join('');
    document.body.appendChild(tb);
    const realBadge = A._favTriggerBadge; A._favTriggerBadge = () => '<b data-tbadge="1">B</b>';
    A.radarStrategy = 'momentum';
    const t0 = Date.now();
    await A._fillRadarTriggerBadges('momentum', [...GOOD, ...BAD].map(sym => ({ sym })));
    out.ms1 = Date.now() - t0;
    out.toast1 = toasts.filter(t => /無法載入|資料/.test(t)).length;
    out.badges = GOOD.map(s => !!document.querySelector(`[data-radar-trig="${s}"] [data-tbadge]`));
    out.badRetries = BAD.map(s => req[s] || 0);
    A._favTriggerBadge = realBadge;

    // ② 決定性對照:使用者自己開那一檔
    toasts.length = 0;
    const d2 = await A.fetchHistoricalData(BAD[0], false);
    out.fgNull = d2 === null; out.toast2 = toasts.filter(t => /無法載入/.test(t)).length;
    out.fgReq = req[BAD[0]];

    // ③ 離開選股頁就停
    const SLOW = ['9301', '9302', '9303', '9304', '9305', '9306'].map(s => s.replace('93', '94'));   // 94xx = 好的、慢的
    for (const s of SLOW) { try { await A.idb.del(`proTerm_kline_${s}`); } catch (_) {} }
    delay = 400;
    A.radarStrategy = 'momentum';
    const p3 = A._fillRadarTriggerBadges('momentum', SLOW.map(sym => ({ sym })));
    await new Promise(r => setTimeout(r, 150));
    A.switchAppTab('desk');
    await p3;
    out.slowReq = SLOW.reduce((a, s) => a + (req[s] || 0), 0);
    delay = 0;

    // ④ 掃描卡寫一行灰字 + ⛔ 快取
    toasts.length = 0;
    const box = document.getElementById('watchCheckupList') || (() => { const d = document.createElement('div'); d.id = 'watchCheckupList'; document.body.appendChild(d); return d; })();
    A.favGroups = { T: [...GOOD, ...BAD] }; A.activeGroupName = 'T';
    const realInv = A._getInventory; A._getInventory = () => [];
    A._wlCheckupCache = null;
    await A._scanWatchlistCheckup(true);
    out.miss = +((box.querySelector('[data-klmiss]') || {}).dataset || {}).klmiss || 0;
    out.cacheNull = A._wlCheckupCache === null;
    out.toast4 = toasts.filter(t => /無法載入/.test(t)).length;
    A._getInventory = realInv;

    // ⑤ 同時最多 4 檔
    const MANY = Array.from({ length: 10 }, (_, k) => String(9500 + k));
    for (const s of MANY) { try { await A.idb.del(`proTerm_kline_${s}`); } catch (_) {} }
    delay = 200; maxIn = 0;
    await Promise.all(MANY.map(s => A.fetchHistoricalData(s, false, { quiet: true })));
    out.maxBg = maxIn;
    const FG = Array.from({ length: 6 }, (_, k) => String(9600 + k));
    maxIn = 0;
    await Promise.all(FG.map(s => A.fetchHistoricalData(s, true)));
    out.maxFg = maxIn; delay = 0;
    window.fetch = realFetch; A.showToast = realToast;
    return out;
});

ok('① 背景徽章:5 檔抓不到 → 紅框 0 個', R.toast1 === 0, R.toast1);
ok('① 成功那 3 檔照樣畫徽章', R.badges.every(Boolean), JSON.stringify(R.badges));
ok('① 抓不到的每檔重試一次(各 2 個請求)', R.badRetries.every(n => n === 2), JSON.stringify(R.badRetries));
ok('② ⭐ 決定性對照:自己開那一檔 → 回 null 且照舊 1 個紅框、⛔ 重試', R.fgNull && R.toast2 === 1 && R.fgReq === 3, `${R.fgNull} ${R.toast2} ${R.fgReq}`);
ok('③ 切到決策台後背景迴圈停(6 檔只抓了 ≤ 2 檔)', R.slowReq <= 2, R.slowReq);
ok('④ 掃描卡寫「有 5 檔這次沒抓到」', R.miss === 5, R.miss);
ok('④ 有抓不到 → ⛔ 快取(下次打開重掃)', R.cacheNull);
ok('④ 掃描也⛔ 跳紅框', R.toast4 === 0, R.toast4);
ok('⑤ 背景同時最多 4 檔', R.maxBg <= 4 && R.maxBg >= 2, R.maxBg);
ok('⑤ 自己點的不排隊(6 檔同時)', R.maxFg >= 5, R.maxFg);
ok('⑥ 沒有 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
if (process.env.INJECT) fs.rmSync(HTML, { force: true });
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ BGFETCH_QUIET_PASS');
process.exit(fails ? 1 : 0);
