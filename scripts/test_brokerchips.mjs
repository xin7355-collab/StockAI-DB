#!/usr/bin/env node
/**
 * 🏦 券商分點卡:載入 + 單位(V72.2.8)
 *
 * ⚠️⚠️ 這支是為了釘住一個**躲了很久、而且完全沒有錯誤訊息**的 bug:
 *
 *   `loadBrokerChips` 裡 `const raw` 宣告在 `if (!records) { … }` **區塊內**,
 *   卻在區塊外(資料日期標籤那段)被引用 → 每一檔都
 *   **`ReferenceError: raw is not defined`**;而整段包在 `try/catch` 裡,
 *   例外被吞掉、直接掉到 catch → 畫面顯「⚠️ 今日分點尚未公布」。
 *
 *   ⛔ 那句話看起來像「資料還沒出來」的正常狀態 ——
 *      所以**券商分點對所有股票都是壞的**,而且完全看不出來
 *      (只有 console 那行 `[分點] loadBrokerChips 失敗` 有痕跡)。
 *
 * ⭐ 而且修好之後才看得到**第二個** bug:`net` 是**股**,÷1000 才是張,
 *   原本 `(val/1000)+'K'` 配「張」的表頭 → 讀成「23,630 千張」= 實際的 1000 倍。
 *   ⚠️ 它躲到現在,正是因為那張卡從來沒渲染出來過。
 *
 * ⭐ 通用教訓:**寬 catch 會把「程式壞了」偽裝成「資料還沒到」** ——
 *    catch 分支的文案越像正常狀態,bug 就活得越久(同陷阱 #33)。
 *
 * 跑法:node scripts/test_brokerchips.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

// ⭐ 空過守門:沒有真實 chips 測資就不要假裝驗過了
const CAND = ['2330', '2317', '2454', '0050'];
let SYM = null;
for (const s of CAND) {
    const p = path.join(ROOT, 'data/chips', `${s}.json`);
    if (!fs.existsSync(p)) continue;
    try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j && !Array.isArray(j) && j.periods && Object.keys(j.periods).length) { SYM = s; break; }
    } catch (_) { }
}
if (!SYM) {
    console.log('⏭️ 本機沒有「新格式(帶 periods)」的 data/chips/*.json,略過');
    console.log('   ↳ 取得測資:git show origin/gh-pages:data/chips/2330.json > data/chips/2330.json');
    process.exit(0);
}
console.log(`   測資:${SYM}`);

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const consoleErrs = [];
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) consoleErrs.push(m.text().slice(0, 300)); });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.loadBrokerChips, null, { timeout: 25000 });

const R = await page.evaluate(async s => {
    app.currentSymbolId = s;
    try { localStorage.removeItem(`brokerChips_v2_${s}`); } catch (_) { }
    await app.loadBrokerChips(s, true);
    await new Promise(r => setTimeout(r, 2200));
    const box = document.getElementById('brokerChipContent');
    const lbl = document.getElementById('brokerChipDate');
    return {
        txt: (box?.innerText || '').replace(/\s+/g, ' ').trim(),
        lbl: (lbl?.textContent || '').trim(),
        recs: (app._chipRecords || []).length,
        periods: app._chipPeriods ? Object.keys(app._chipPeriods) : null,
    };
}, SYM);

// ── ① 卡片真的渲染出來(⛔ 不可掉進 catch)──────────────────────
ok('① ⭐⛔ 不可顯示「今日分點尚未公布」(那是 catch 分支 —— 看起來像正常狀態,其實是程式壞了)',
   !/今日分點尚未公布/.test(R.txt), R.txt.slice(0, 200));
ok('① ⭐ 真的載到分點紀錄', R.recs > 0, `recs=${R.recs}`);
ok('① 多週期按鈕的資料在(1d/3d/5d/10d)',
   Array.isArray(R.periods) && R.periods.length >= 3, JSON.stringify(R.periods));
ok('① 資料日期標籤有填(那段正是 raw 出事的地方)', /資料日期/.test(R.lbl), R.lbl);
ok('① ⭐⛔ console 不可出現「loadBrokerChips 失敗」',
   !consoleErrs.some(x => /loadBrokerChips 失敗/.test(x)), consoleErrs.join(' | '));

// ── ② 單位:表頭寫「張」就不可以是 K(差 1000 倍)────────────────
ok('② 表頭是「累積主力動向(張)」', /累積主力動向（張）/.test(R.txt), R.txt.slice(0, 120));
ok('② ⭐⛔ 數字不可帶 K(表頭是張,加 K 會變成 1000 倍)',
   !/[+\-]\s?[\d,]+K\b/.test(R.txt), (R.txt.match(/[+\-]\s?[\d,]+K\b/g) || []).slice(0, 5).join(','));
ok('② ⭐ 要有千分位逗號(使用者要求會計格式)', /[+\-][\d]{1,3},[\d]{3}/.test(R.txt), R.txt.slice(0, 200));

// ⭐ 跟原始 JSON 對帳:畫面上的張數 = JSON 的 net ÷ 1000(⛔ 不靠肉眼看合不合理)
const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chips', `${SYM}.json`), 'utf8'));
const per = j.periods['3d'] || j.periods[Object.keys(j.periods)[0]];
const top = (per.buy || [])[0];
if (top) {
    const expect = Math.round(Math.abs(top.net) / 1000).toLocaleString();
    ok(`② ⭐ 首位買超要等於 JSON 的 net÷1000(${top.broker_name} → ${expect} 張)`,
       R.txt.includes(expect), `畫面找不到 ${expect};原始 net=${top.net}`);
}

// ── ③ 原始碼守門:raw 必須在函式層宣告 ──────────────────────────
const src = await page.evaluate(() => app.loadBrokerChips.toString());
ok('③ ⭐⛔ `raw` 必須宣告在函式層(⛔ 不可再寫成區塊內的 const/let)',
   /let raw = null;/.test(src) && !/const raw = await res\.json\(\)/.test(src),
   (src.match(/(const|let) raw[^\n]*/g) || []).join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ BROKERCHIPS_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ BROKERCHIPS_TEST_PASS');
