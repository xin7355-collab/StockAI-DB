#!/usr/bin/env node
/**
 * 🌅 V82.0.8 早上第一次打開先到盤前(使用者 11/09:「每天早上第一次打開網頁我要在盤前頁面,幫我想一下什麼時候比較好」)
 *   ① `_premktAutoWant` 純判斷:台北平日 05:00~08:59、一天一次、設定關 / 深連結 → 不跳
 *      (邊界 04:59 / 05:00 / 08:59 / 09:00、週六、週日;判斷用傳進來的時間,⛔ 讀裝置時區)
 *   ② 真的開 App(時鐘固定):台北 11/09(一)06:24 → 落在 大盤 › 盤前、往回是決策台、記下今天;
 *      ⭐ 決定性對照(同一份 App 只換時間 / 狀態):09:05 → 決策台・週六 06:24 → 決策台・今天跳過了 → 決策台・
 *      設定關 → 決策台・?sym=2330 → 個股頁
 *   ③ 盤前頁最上面那一行 = 底部 🎯 徽章同一個數字(0 / 藏起來 → 這一行也藏)
 *   ④ 設定:預設勾、取消 = settings.premktAuto false;設定收起來那組的摘要寫出來
 *   ⑤ 停在盤前頁:台北 08:05~08:59、資料還是美股收盤前抓的 → 5 分鐘補抓一次;收盤後那份 / 離開盤前頁 / 07:59 / 09:01 → 不抓
 * 注入:INJECT=nogate(拿掉 09:00 截止)→ ② 的 09:05 那條必紅;INJECT=noline(那一行不讀徽章)→ ③ 必紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nogate') SRC = SRC.replace("if (/Sat|Sun/.test(wd) || min < 5 * 60 || min >= 9 * 60 || last === ymd) return null;", "if (/Sat|Sun/.test(wd) || min < 5 * 60 || last === ymd) return null;");
if (INJ === 'noline') SRC = SRC.replace("const n = dot && !dot.classList.contains('hidden') ? parseInt(dot.textContent, 10) || 0 : 0;", 'const n = 0;');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_premkt_open.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) fails.push(n); };

// ① 純判斷(從原始碼抽出來單獨跑,⛔ 在測試裡另寫一份)
const grab = (src, head) => {
    const i = src.indexOf(head); if (i < 0) return null;
    let j = src.indexOf('{', i), d = 0;
    for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } }
    return null;
};
const fW = grab(SRC, "_premktAutoWant(now = Date.now(), last = '', off = false, deep = false) {");
ok('①0 找得到 `_premktAutoWant`', !!fW);
const A = eval(`({ ${fW} })`);
const T = s => Date.parse(s);
const W = (iso, last = '', off = false, deep = false) => A._premktAutoWant(T(iso), last, off, deep);
ok('①a 週一 06:24(台北)第一次 → 跳,記 2026-11-09', W('2026-11-08T22:24:00Z') === '2026-11-09');
ok('①b 同一天已經跳過 → 不跳', W('2026-11-08T22:24:00Z', '2026-11-09') === null);
ok('①c 邊界:04:59 不跳、05:00 跳、08:59 跳、09:00 不跳',
    W('2026-11-08T20:59:00Z') === null && W('2026-11-08T21:00:00Z') === '2026-11-09' && W('2026-11-09T00:59:00Z') === '2026-11-09' && W('2026-11-09T01:00:00Z') === null);
ok('①d 週六 / 週日早上 → 不跳', W('2026-11-06T22:24:00Z') === null && W('2026-11-07T22:24:00Z') === null);
ok('①e 設定關 / 深連結 → 不跳', W('2026-11-08T22:24:00Z', '', true) === null && W('2026-11-08T22:24:00Z', '', false, true) === null);
ok('①f 昨天跳過、今天還沒 → 跳(一天一次,⛔ 永遠只跳一次)', W('2026-11-09T22:30:00Z', '2026-11-09') === '2026-11-10');

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
async function land(iso, { url = '', ls = {} } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(e.message));
    await page.clock.setFixedTime(new Date(iso));
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.addInitScript(o => { try { localStorage.clear(); for (const [k, v] of Object.entries(o)) localStorage.setItem(k, v); } catch (_) {} }, ls);
    await page.goto('file://' + TMP + url, { waitUntil: 'domcontentloaded' });
    // init 切落地頁那一步之後(決策台 / 帶股票連結的個股頁;個股頁 navStack 本來就是 ['diag'] 所以看 tab-active)
    await page.waitForFunction(() => typeof app !== 'undefined' && Array.isArray(app.navStack)
        && (app.navStack.includes('desk') || app.navStack.length > 1 || !!document.getElementById('tabContentDiag')?.classList.contains('tab-active')), null, { timeout: 90000 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
        const act = id => !!document.getElementById(id)?.classList.contains('tab-active');
        const adv = document.getElementById('subContent_advice');
        let rec = null; try { rec = localStorage.getItem('premktAuto_v1'); } catch (_) {}
        return { stack: app.navStack.slice(), last: app.navStack[app.navStack.length - 1], market: act('tabContentMarket'), desk: act('tabContentDesk'),
                 advice: !!adv && !adv.classList.contains('hidden'), rec, mkt: (() => { try { return localStorage.getItem('mktSubTab'); } catch (_) { return null; } })() };
    });
    return { page, ctx, r };
}

try {
    // ② 週一 06:24
    let L = await land('2026-11-08T22:24:00Z');
    ok('②a 週一 06:24 第一次打開 → 大盤 › 盤前', L.r.last === 'market' && L.r.advice && L.r.mkt === 'tw', JSON.stringify(L.r));
    ok('②b 往回是決策台(決策台照樣先切過一次 → 底部徽章照算)', L.r.stack.slice(-2).join('>') === 'desk>market', L.r.stack.join('>'));
    ok('②c 記下今天(同一天再開不會再跳)', L.r.rec === '2026-11-09', L.r.rec);
    // ③ 決策台那一行
    const D = await L.page.evaluate(() => {
        const dot = document.getElementById('navBtnDeskDot'), el = document.getElementById('premktDeskLine');
        const o = {};
        dot.textContent = '3'; dot.classList.remove('hidden'); app._premktDeskLineSync();
        o.on = { hid: el.classList.contains('hidden'), txt: el.textContent };
        dot.textContent = '0'; dot.classList.add('hidden'); app._premktDeskLineSync();
        o.off = { hid: el.classList.contains('hidden'), txt: el.textContent };
        dot.textContent = '2'; dot.classList.remove('hidden'); app._premktDeskLineSync();
        o.two = el.textContent;
        el.click();
        o.after = app.navStack[app.navStack.length - 1];
        o.inAdvice = !!el.closest('#subContent_advice') && el.parentElement.firstElementChild === el;
        return o;
    });
    ok('③a 徽章 3 → 盤前頁最上面寫「決策台今天有 3 件事」', !D.on.hid && /決策台今天有 3 件事要做/.test(D.on.txt), JSON.stringify(D.on));
    ok('③b 徽章藏起來 → 這一行也藏起來', D.off.hid && D.off.txt === '', JSON.stringify(D.off));
    ok('③c ⭐ 決定性對照:徽章改 2 → 這一行跟著寫 2', /有 2 件事/.test(D.two), D.two);
    ok('③d 點那一行 → 到決策台;放在盤前頁第一個', D.after === 'desk' && D.inAdvice, JSON.stringify(D));
    // ④ 設定
    const S = await L.page.evaluate(() => {
        app.openSettings?.();
        const cb = document.getElementById('set_premktAuto');
        const o = { exists: !!cb, def: cb ? cb.checked : null };
        if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
        o.saved = app.settings.premktAuto;
        o.inTools = !!cb && !!cb.closest('details[data-setgrp="tools"]');
        try { app._setGrpSummaries(); } catch (_) {}
        o.sumOff = document.getElementById('setGrpSum_tools')?.textContent || '';
        app.settings.premktAuto = true; try { app._setGrpSummaries(); } catch (_) {}
        o.sumOn = document.getElementById('setGrpSum_tools')?.textContent || '';
        return o;
    });
    ok('④a 設定開關預設勾、取消 = settings.premktAuto false', S.exists && S.def === true && S.saved === false, JSON.stringify(S));
    ok('④b 放在收起來的「進階與工具」(⛔ 撐大第一眼);摘要寫得出開 / 關', S.inTools && /早上先到盤前/.test(S.sumOn) && !/早上先到盤前/.test(S.sumOff), JSON.stringify(S));
    await L.ctx.close();

    // ② 決定性對照:同一份 App 只換時間 / 狀態
    L = await land('2026-11-09T01:05:00Z');   // 09:05
    ok('②d ⭐ 決定性對照:09:05 打開 → 決策台', L.r.last === 'desk' && L.r.rec === null, JSON.stringify(L.r));
    await L.ctx.close();
    L = await land('2026-11-06T22:24:00Z');   // 週六 06:24
    ok('②e 週六 06:24 → 決策台', L.r.last === 'desk', JSON.stringify(L.r));
    await L.ctx.close();
    L = await land('2026-11-08T22:24:00Z', { ls: { premktAuto_v1: '2026-11-09' } });
    ok('②f 今天已經跳過 → 決策台', L.r.last === 'desk', JSON.stringify(L.r));
    await L.ctx.close();
    L = await land('2026-11-08T22:24:00Z', { ls: { proTerminalSettings: JSON.stringify({ premktAuto: false }) } });
    ok('②g 設定關掉 → 決策台', L.r.last === 'desk' && L.r.rec === null, JSON.stringify(L.r));
    await L.ctx.close();
    L = await land('2026-11-08T22:24:00Z', { url: '?sym=2330' });
    ok('②h 帶股票的連結 → 個股頁(⛔ 被拉去盤前)', L.r.last === 'diag' && L.r.rec === null, JSON.stringify(L.r));
    await L.ctx.close();

    // ⑤ 停在盤前頁 08:05 之後補抓美股收盤後那份(Cloudflare 08:00 叫醒採礦)
    L = await land('2026-11-09T00:10:00Z');   // 台北 08:10,一樣會落在盤前
    const F = await L.page.evaluate(() => {
        const pre = '2026-11-07 02:40 +0800';
        app._macroRiskCache = { ...(app._macroRiskCache || {}), updated: pre };
        app._premktRefAt = 0;
        const a = app._premktRefreshTick();
        const b = app._premktRefreshTick();
        app._premktRefAt = 0; app._macroRiskCache.updated = '2026-11-09 08:09 +0800';
        const c = app._premktRefreshTick();
        app._macroRiskCache.updated = pre; app._premktRefAt = 0; app.switchAppTab('desk');
        const d = app._premktRefreshTick();
        app.switchAppTab('market'); app.switchMarketSubTab('tw'); app._macroRiskCache.updated = pre; app._premktRefAt = 0;
        return { a, b, c, d, onAdv: !document.getElementById('subContent_advice').classList.contains('hidden') };
    });
    await L.page.clock.setFixedTime(new Date('2026-11-08T23:59:00Z'));   // 台北 07:59
    const F2 = await L.page.evaluate(() => { app._macroRiskCache.updated = '2026-11-07 02:40 +0800'; app._premktRefAt = 0; return app._premktRefreshTick(); });
    await L.page.clock.setFixedTime(new Date('2026-11-09T01:01:00Z'));   // 台北 09:01
    const F3 = await L.page.evaluate(() => { app._premktRefAt = 0; return app._premktRefreshTick(); });
    ok('⑤a 停在盤前頁、08:10、還是收盤前那份 → 抓一次', F.a === true && F.onAdv, JSON.stringify(F));
    ok('⑤b 5 分鐘內 ⛔ 重抓', F.b === false, JSON.stringify(F));
    ok('⑤c ⭐ 決定性對照:已經是收盤後那份 → 不抓', F.c === false, JSON.stringify(F));
    ok('⑤d 離開盤前頁 → 不抓', F.d === false, JSON.stringify(F));
    ok('⑤e 07:59 / 09:01 → 不抓(只在 08:05~08:59)', F2 === false && F3 === false, JSON.stringify({ F2, F3 }));
    await L.ctx.close();
    ok('②z 這幾次開 App 沒有頁面錯誤', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
    await browser.close();
    fs.rmSync(TMP, { force: true });
}
console.log(fails.length ? `\n❌ test_premkt_open ${fails.length} 條失敗` : '\n✅ test_premkt_open 全過');
process.exit(fails.length ? 1 : 0);
