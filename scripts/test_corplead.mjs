#!/usr/bin/env node
/**
 * 🧭 V74.2.6 基本面頁「總覽邏輯」(使用者:「基本面」)—— 個股六頁到齊
 *
 * ⭐ 這頁**本來就有**骨架(V72.6.0 的 `pageLeadCorp` 頁首一句話 + 🧬 體質總評 + 完整數據 `<details>`),
 *    ⛔ 但那個 details 掛著 `open` = **摺了等於沒摺**(同 test_prohtml ㊲h2 釘過的坑)。
 *
 * ⛔ 釘死的五件事(②③④ 已用注入缺陷自我驗證):
 *   ① 完整數據摺疊⛔ 不可掛 open;內層(評分構成因子/填息歷史)也不可
 *   ② 🚨 打開時要 resize 裡面的 ECharts —— 收起狀態容器寬 0,不 resize 圖就是空的
 *   ③ 🚨 體質總評算不出來(⏳ 整備中)→ **自動展開** ——
 *      ⛔ 那段文案自己寫著「下方已顯示目前拿得到的訊號」,收起來就是說謊
 *   ④ 使用者手動動過之後,⛔ 程式不可再自動改它(別跟使用者搶)
 *   ⑤ 換股票要重置「使用者動過」的記憶(不同檔資料齊全度不同)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 220)}`}`); if (!c) fails++; };

// ── 靜態 ──
{
    const m = SRC.match(/<details id="corpMoreWrap"[^>]*>/);
    ok('① 完整數據摺疊存在且⛔ 不可掛 open', !!m && !/\bopen\b/.test(m[0]), m && m[0]);
    // 內層:整個基本面頁區段裡不可再有 `open>`(打開外層後不該又全部攤開)
    const s = SRC.indexOf('id="subContentCorp"'), e = SRC.indexOf('id="subContentBullBear"');
    const seg = SRC.slice(s, e);
    ok('① 內層(評分構成因子 / 填息歷史)也不可預設展開', !/<details[^>]*\sopen[\s>]/.test(seg),
        (seg.match(/<details[^>]*open[^>]*>/) || [''])[0]);
    ok('② 摺疊有掛 toggle handler', /ontoggle="app\._onCorpMoreToggle\(this\)"/.test(SRC));
    ok('② handler 打開時要 resize 內部 echarts(⛔ 收起容器寬 0,不 resize 圖是空的)',
        /_onCorpMoreToggle\(el\) \{[\s\S]{0,900}_echarts_instance_[\s\S]{0,120}resize\(\)/.test(SRC));
    // 🚨 「使用者動過」⛔ 不可靠 toggle 判斷(瀏覽器會把連續的 toggle 合併成一次)
    ok('④ 「使用者動過」是由 <summary> 的實際點擊記的(⛔ 不是在 toggle 裡猜)',
        /onclick="app\._corpMoreUser\(\)"/.test(SRC) && /_corpMoreUser\(\) \{[^}]*userToggled = '1'/.test(SRC));
    ok('③ 體質總評算完要呼叫 `_syncCorpMore`', /this\._syncCorpMore\(\); \} catch/.test(SRC));
}

// ── 動態 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
// ⚠️ 沙箱連不到 CDN → echarts 是 undefined。這裡 stub 一個「會記錄 resize 次數」的假 echarts,
//    ⭐ 否則 ② 那條在動態面**永遠驗不到**(陷阱 #40:沙箱 ≠ 正式環境)。
await page.addInitScript(() => {
    window.__resizeCount = 0;
    const inst = new Proxy({}, {
        get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300)
            : (k === 'resize') ? (() => { window.__resizeCount++; }) : (() => inst),
    });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, {
            get: (_t, k) => k === 'init' ? (() => inst)
                : k === 'getInstanceByDom' ? (() => inst)
                    : (k === 'graphic' ? {} : () => inst),
        }),
        writable: true, configurable: true,
    });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._syncCorpMore, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const o = {};
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze('2330', true, false, true); } catch (e) { return { err: String(e).slice(0, 160) }; }
    try { app.switchSubTab('corp'); } catch (_) { }
    await new Promise(r => setTimeout(r, 1200));
    const el = document.getElementById('corpMoreWrap');
    o.exists = !!el;

    // ③ 算不出結論(⏳ 整備中)→ 自動展開
    app._lastXrayVerdict = { sym: '2330', verdict: '⏳ 財報資料整備中', tone: 'flat', act: '下方已顯示目前拿得到的訊號' };
    app._syncCorpMore();
    o.openWhenNoVerdict = el.open;
    // 有結論 → 收起
    app._lastXrayVerdict = { sym: '2330', verdict: '✅ 體質穩健', tone: 'good', act: 'x' };
    app._syncCorpMore();
    o.closedWhenVerdict = el.open === false;

    // ② 打開 → resize 內部 echarts(用 stub 的計數驗;⛔ 先塞一個假的 echarts 容器進去)
    const probe = document.createElement('div');
    probe.setAttribute('_echarts_instance_', 'x');
    el.querySelector('div')?.appendChild(probe);
    const before = window.__resizeCount;
    el.open = true;                       // 觸發 ontoggle
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)));
    o.resized = window.__resizeCount > before;
    // ④ 「使用者動過」是靠 <summary> 的**實際點擊**記的(⛔ 不是靠 toggle —— toggle 會被瀏覽器合併)
    el.querySelector('summary').click();   // 真的點一次(這會同時把它關起來)
    o.userToggledAfterManual = el.dataset.userToggled;
    el.open = true;                        // 回到開啟狀態,驗下面「程式不再自動關」

    // ④ 使用者動過之後,程式⛔ 不可再自動改
    app._lastXrayVerdict = { sym: '2330', verdict: '✅ 體質穩健', tone: 'good', act: 'x' };
    app._syncCorpMore();
    o.stillOpenAfterUser = el.open === true;

    // ⑤ 換股票要重置記憶
    app._lastXrayVerdict = { sym: '2317', verdict: '✅ 體質穩健', tone: 'good', act: 'x' };
    app._syncCorpMore();
    o.resetOnSymChange = el.open === false && el.dataset.userToggled !== '1';
    return o;
});
await browser.close();
if (R.err) { console.log(`❌ analyze 失敗:${R.err}`); process.exit(1); }

ok('🚧 空過守門:摺疊真的在 DOM 裡', R.exists === true);
ok('③ 🚨 算不出體質總評(⏳ 整備中)→ 自動展開(⛔ 收起會讓文案說謊)', R.openWhenNoVerdict === true);
ok('③b 有結論時 → 收起(第一眼只留結論)', R.closedWhenVerdict === true);
ok('② 🚨 打開時真的 resize 了內部 ECharts(⛔ 不 resize 圖會是空的)', R.resized === true);
ok('④ 使用者手動開過 → 記住,程式⛔ 不再自動改', R.userToggledAfterManual === '1' && R.stillOpenAfterUser === true,
    JSON.stringify({ flag: R.userToggledAfterManual, open: R.stillOpenAfterUser }));
ok('⑤ 換股票要重置「使用者動過」的記憶', R.resetOnSymChange === true);

console.log(fails ? `❌ ${fails} 條失敗` : '✅ CORPLEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
