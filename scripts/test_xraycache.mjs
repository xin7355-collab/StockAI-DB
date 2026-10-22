#!/usr/bin/env node
/**
 * 💾 V79.5.6 基本頁(X 光機)本地快取真的寫得進去 —— 巡邏 swallow_hunt 抓到的 ReferenceError
 *
 * 🐛 `fetchFundamentalAnalysis` 存快取那行寫 `最後更新 ${_ts}`,而 `_ts` 在 V72.5.5 改「標資料日期」時就拿掉了
 *    → ReferenceError 被空的 catch 吞掉 → `xrayCache_{sym}` 從那之後**一次都沒存成功**,畫面看不出來。
 *
 * 釘住:
 *   ① 真的跑一次 fetchFundamentalAnalysis(擋掉網路,只讀本機 data/)→ localStorage 有 xrayCache_2330
 *   ② 快取標的是資料日期(⛔ 不是「現在幾點」,V70.2.0)而且沒有 undefined
 *   ③ 每檔一份 → 一定有上限(_lruTrim 留 40 筆,最新那筆一定還在)
 *   ④ 原始碼那一段 ⛔ 不可再出現 `${_ts}`
 *   ⑤ 資料日期:每檔基本面檔的檔頭日期要帶進來、畫面要標出來(⛔ 不可寫「資料日期未知」)
 *   INJECT=1:換回舊寫法 → ① 必須紅;INJECT=2:讀檔又丟掉檔頭日期 → ⑤a/⑤c 必須紅(決定性對照)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJECT = process.env.INJECT === '1';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const NEW_LABEL = "dateLabel: _dd ? `資料 ${this._dW(_dd)}` : '',";
ok('④ 原始碼:存快取那行用資料日期,⛔ 不可再有 `${_ts}`', src.includes(NEW_LABEL) && !src.includes('最後更新 ${_ts}'));
let page_file = path.join(ROOT, 'index.html');
const INJECT2 = process.env.INJECT === '2';
if (INJECT || INJECT2) {
    if (INJECT) {
        src = src.replace(NEW_LABEL, 'dateLabel: `最後更新 ${_ts}`,');
        console.log('💉 INJECT=1:換回舊寫法(`最後更新 ${_ts}`)→ 下面 ① 必須紅');
    } else {
        src = src.replace('data_date: f0.data_date || raw.data_date || raw.generated || null,', 'data_date: f0.data_date || null,')
                 .replace('generated: f0.generated || raw.generated || raw.data_date || null,', 'generated: f0.generated || null,');
        console.log('💉 INJECT=2:讀檔時又把檔頭日期丟掉 → 下面 ⑤a / ⑤c 必須紅');
    }
    page_file = path.join(ROOT, '_xraycache_inject.html');
    fs.writeFileSync(page_file, src);
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
try {
    const page = await browser.newPage();
    // ⛔ 擋掉所有外部網路(FinMind / 富果…),只留本機檔 —— 快取那行不該依賴網路
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.goto('file://' + page_file, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app.fetchFundamentalAnalysis && !!app._lruTrim, null, { timeout: 30000 });

    const R = await page.evaluate(async () => {
        // ③ 先塞 50 筆舊的,看修好之後會不會被修剪
        for (let i = 0; i < 50; i++) localStorage.setItem(`xrayCache_9${String(i).padStart(3, '0')}`, JSON.stringify({ sym: 'x', ts: 1000 + i }));
        localStorage.removeItem('xrayCache_2330');
        app.currentSymbolId = '2330';
        let err = null;
        try {
            await Promise.race([app.fetchFundamentalAnalysis('2330', { skipAI: true }), new Promise(r => setTimeout(r, 60000))]);
        } catch (e) { err = String(e && e.message || e); }
        const raw = localStorage.getItem('xrayCache_2330');
        const n = Object.keys(localStorage).filter(k => k.startsWith('xrayCache_')).length;
        const dateTxt = (document.getElementById('xrayDataDate') || {}).textContent || '';
        const lf = await app._loadLocalFundamentals('2330');
        return { raw, n, err, dateTxt, lfDate: lf && lf.data_date, lfGen: lf && lf.generated, lfPe: lf && lf.pe };
    });
    const c = R.raw ? JSON.parse(R.raw) : null;
    ok('① 跑完一次之後 localStorage 有 xrayCache_2330(以前 ReferenceError 被吞掉 → 永遠沒有)', !!c, R.err || 'missing');
    ok('② 快取標的是資料日期、⛔ 沒有 undefined', !!c && typeof c.dateLabel === 'string' && /^資料 \d{1,2}\/\d{2}/.test(c.dateLabel), c && c.dateLabel);
    ok('③ 每檔一份的快取有上限:留 40 筆而且剛存的那筆還在', R.n <= 40 && !!c, `n=${R.n}`);

    // ⑤ 資料日期:每檔基本面檔(data/chips/{sym}.json)檔頭有 data_date → 讀進來要帶著,畫面要標出來
    const chips = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'chips', '2330.json'), 'utf8'));
    const want = String(chips.data_date || '');
    const mmdd = want.slice(5, 7) + '/' + want.slice(8, 10);
    ok('⑤a 讀每檔基本面時帶著檔頭的資料日期(以前只回 fundamentals 那一塊 → 日期被丟掉)', R.lfDate === want && !!R.lfGen, `${R.lfDate} vs ${want}`);
    ok('⑤b fundamentals 本身的欄位沒被蓋掉(本益比照舊)', R.lfPe === (chips.fundamentals || {}).pe, `${R.lfPe}`);
    ok('⑤c 基本頁標的是那份資料的日期,⛔ 不是「資料日期未知」', R.dateTxt.includes(mmdd) && !R.dateTxt.includes('未知'), R.dateTxt);
} finally {
    await browser.close();
    if (INJECT || INJECT2) fs.rmSync(page_file, { force: true });
}

console.log(fails.length ? `\n❌ XRAYCACHE_FAIL ${fails.length} 條` : '\n✅ XRAYCACHE_PASS');
process.exit(fails.length ? 1 : 0);
