// 🌙 V80.1.2 勿擾時段(19 個專案評估 3-4):只管 App 內的通知(視窗 / 橫幅 / 手機通知),⛔ 不管 Telegram
//  ⓐ 靜態:_fireAlert 在「這一類有沒有開」之後、跳視窗之前先問 _inQuiet();lock 那幾類照樣叫
//  ⓑ 勿擾時段裡(23:00)一般通知 → 不跳視窗、不跳橫幅,但 🔔 歷史照記
//  ⓒ 🔒 lock(👜 你的部位 / 🔔 到價 / 👑 換倉日)照樣跳
//  ⓓ ⭐ 決定性對照:同一則、同一時間,勿擾沒打開 → 照樣跳;打開但不在時段內(12:00)→ 照樣跳
//  ⓔ 時段邏輯:跨半夜(22:00→07:00)06:59 算、07:00 不算、21:59 不算、22:00 算;不跨半夜(13:00→14:00);起訖一樣 ⛔ 不算;亂寫的時間退回預設
//  ⓕ 預設關(沒設定過 = 照舊全部會叫);設定頁:開關沒勾、時間 22:00 / 07:00、輸入框 16px(iPhone 一點才不會放大)
// 跑法:node scripts/test_quiet.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) FAIL.push(n); };

const fire = (SRC.match(/\n    _fireAlert\(title, body, sym\) \{[\s\S]*?\n    \},/) || [''])[0];
const iCat = fire.indexOf('this._alertCatOn(title)'), iQ = fire.indexOf('this._inQuiet()'), iPop = fire.indexOf('this._alertPopup(');
ok('ⓐ _fireAlert:先問這一類有沒有開 → 再問勿擾時段 → 才跳視窗;lock 那幾類放行', iCat > 0 && iQ > iCat && iPop > iQ && /_inQuiet\(\) && !this\._alertCatOf\(title\)\.lock/.test(fire), JSON.stringify({ iCat, iQ, iPop }));
ok('ⓐ2 歷史在勿擾判斷之前就記(勿擾 = 只記不吵,⛔ 不是不記)', fire.indexOf('_recordNotifHistory') > 0 && fire.indexOf('_recordNotifHistory') < iQ, '');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|echarts|Cache\.put|file' is unsupported/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._inQuiet && !!app._fireAlert, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(() => {
    const A = app;
    const defOn = A.settings.quietOn;
    const defIn = A._inQuiet(23 * 60);
    let pop = 0, toast = 0, hist = 0, now = 23 * 60;
    A._alertPopup = () => { pop++; return true; };
    A._alertToast = () => { toast++; return true; };
    A._recordNotifHistory = () => { hist++; };
    A._tpeMinutes = () => ({ wd: 'Wed', min: now, ymd: '2026-10-28' });
    A.saveSettings = () => {};
    const shot = (title) => { pop = 0; toast = 0; hist = 0; A._fireAlert(title, '內文', '2330'); return { pop, toast, hist }; };
    A.settings.alertOff = {};
    // ⓑ 勿擾時段裡
    A.settings.quietOn = true; A.settings.quietFrom = '22:00'; A.settings.quietTo = '07:00';
    const inQ = shot('📈 2330 突破買點');
    // ⓒ lock 照樣跳
    const lockPos = shot('🛑 庫存 2330 停損到了');
    const lockPrice = shot('🔔 到價提醒 2330');
    // ⓓ 決定性對照
    A.settings.quietOn = false;
    const offQ = shot('📈 2330 突破買點');
    A.settings.quietOn = true; now = 12 * 60;
    const noon = shot('📈 2330 突破買點');
    // ⓔ 時段邏輯
    const at = (f, t, m) => { A.settings.quietFrom = f; A.settings.quietTo = t; return A._inQuiet(m); };
    const L = {
        a0659: at('22:00', '07:00', 6 * 60 + 59), a0700: at('22:00', '07:00', 7 * 60), a2159: at('22:00', '07:00', 21 * 60 + 59), a2200: at('22:00', '07:00', 22 * 60), a0000: at('22:00', '07:00', 0),
        b1330: at('13:00', '14:00', 13 * 60 + 30), b1400: at('13:00', '14:00', 14 * 60), b1259: at('13:00', '14:00', 12 * 60 + 59),
        same: at('09:00', '09:00', 9 * 60), bad: at('25:99', 'abc', 23 * 60),
    };
    A.settings.quietOn = false; const offAny = A._inQuiet(23 * 60);
    // ⓕ 設定頁
    delete A.settings.quietOn; delete A.settings.quietFrom; delete A.settings.quietTo;
    let ui = null;
    try {
        A.openSettings();
        const on = document.getElementById('set_quietOn'), f = document.getElementById('set_quietFrom'), t = document.getElementById('set_quietTo');
        ui = { on: on && on.checked, f: f && f.value, t: t && t.value, fs: f && getComputedStyle(f).fontSize, ft: t && getComputedStyle(t).fontSize };
        // 改時間 → 存進設定
        f.value = '23:30'; t.value = '06:15'; A.setQuietTime();
        ui.saved = [A.settings.quietFrom, A.settings.quietTo];
        f.value = ''; A.setQuietTime(); ui.keep = A.settings.quietFrom;   // 空的 ⛔ 蓋掉
    } catch (e) { ui = { err: String(e) }; }
    return { defOn, defIn, inQ, lockPos, lockPrice, offQ, noon, L, offAny, ui };
});

ok('ⓕ 預設關:沒設定過 → quietOn 不是 true、23:00 也不算勿擾', R.defOn !== true && R.defIn === false, JSON.stringify([R.defOn, R.defIn]));
ok('ⓑ 勿擾時段裡(23:00)一般通知 → 不跳視窗、不跳橫幅,🔔 歷史照記', R.inQ.pop === 0 && R.inQ.toast === 0 && R.inQ.hist === 1, JSON.stringify(R.inQ));
ok('ⓒ 🔒 你的部位 / 到價提醒 → 勿擾時段照樣跳', R.lockPos.pop === 1 && R.lockPrice.pop === 1, JSON.stringify([R.lockPos, R.lockPrice]));
ok('ⓓ ⭐ 決定性對照:同一則同一時間、勿擾沒打開 → 照樣跳', R.offQ.pop === 1 && R.offQ.hist === 1, JSON.stringify(R.offQ));
ok('ⓓ2 打開但不在時段內(12:00)→ 照樣跳', R.noon.pop === 1, JSON.stringify(R.noon));
const L = R.L;
ok('ⓔ 跨半夜 22:00→07:00:06:59 / 22:00 / 00:00 算,07:00 / 21:59 不算', L.a0659 && !L.a0700 && !L.a2159 && L.a2200 && L.a0000, JSON.stringify(L));
ok('ⓔ2 不跨半夜 13:00→14:00:13:30 算、14:00 與 12:59 不算', L.b1330 && !L.b1400 && !L.b1259, JSON.stringify(L));
ok('ⓔ3 起訖一樣 ⛔ 不算(不可變成整天都不叫);亂寫的時間退回預設 22:00→07:00', L.same === false && L.bad === true, JSON.stringify(L));
ok('ⓔ4 沒打開 → 任何時間都不算', R.offAny === false, R.offAny);
const U = R.ui || {};
ok('ⓕ2 設定頁:開關沒勾、時間顯示 22:00 / 07:00、輸入框 16px', U.on === false && U.f === '22:00' && U.t === '07:00' && U.fs === '16px' && U.ft === '16px', JSON.stringify(U));
ok('ⓕ3 改時間會存進設定;空的⛔ 蓋掉原本的', JSON.stringify(U.saved) === JSON.stringify(['23:30', '06:15']) && U.keep === '23:30', JSON.stringify(U));
ok('⓪ 沒有 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
