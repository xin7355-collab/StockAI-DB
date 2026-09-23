#!/usr/bin/env node
/**
 * 🧭 基本面頁「全部展開」(V77.5.2 改寫;原 V74.2.6「預設收起、算不出結論才展開」)
 *
 * 使用者 2026-09-23:「基本面全部展開,另外把沒有用的 X 光機功能刪除」。
 *   ⭐ 🧬 體質總評(第一眼那個結論)已下架 → 「有結論就收起」的理由不存在了 → 全部預設展開。
 *
 * ⛔ 釘死的五件事:
 *   ① 完整數據 `corpMoreWrap` 預設 open;基本頁區段裡⛔ 不可有沒掛 open 的 <details>
 *   ② 打開時要 resize 裡面的 ECharts(收起→打開那一刻容器才有寬度)
 *   ③ `_syncCorpMore` ⛔ 不可再依結論把它收起來
 *   ④ 使用者自己點 summary 收起 → 程式⛔ 不可再自動打開(別跟使用者搶)
 *   ⑤ 換股票要重置「使用者動過」的記憶 → 回到全部展開
 *   ⑥ ontoggle 要擋「app 還沒建好」(open 的 <details> 載入時就會觸發一次 toggle —— 實測踩到:app is not defined)
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
    ok('① 完整數據摺疊存在而且預設 open', !!m && /\sopen[\s>]/.test(m[0]), m && m[0]);
    // ⚠️ 舊版用 subContentBullBear 當結尾,但它在 subContentCorp **前面** → 切到空字串 = 空過(假綠燈)
    const s = SRC.indexOf('id="subContentCorp"'), e = SRC.indexOf('id="subContent', s + 20);
    const seg = SRC.slice(s, e).replace(/<!--[\s\S]*?-->/g, '');
    const closed = (seg.match(/<details(?![^>]*\sopen[\s>])[^>]*>/g) || []);
    ok('① 基本頁區段裡⛔ 不可有沒掛 open 的 <details>', seg.length > 3000 && closed.length === 0, closed.join(' | '));
    ok('⑥ ontoggle 要先判 app 存在(open 的 details 載入就會 toggle 一次)',
        /ontoggle="typeof app !== 'undefined' && app\._onCorpMoreToggle\(this\)"/.test(SRC));
    ok('② handler 打開時要 resize 內部 echarts',
        /_onCorpMoreToggle\(el\) \{[\s\S]{0,900}_echarts_instance_[\s\S]{0,120}resize\(\)/.test(SRC));
    ok('④ 「使用者動過」由 <summary> 的實際點擊記',
        /onclick="app\._corpMoreUser\(\)"/.test(SRC) && /_corpMoreUser\(\) \{[^}]*userToggled = '1'/.test(SRC));
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

    // ③ 有結論 / 沒結論都要是打開的(⛔ 不可再依結論收起來)
    app._lastXrayVerdict = { sym: '2330', verdict: '✅ 體質穩健', tone: 'good', act: 'x' };
    app._syncCorpMore();
    o.openWithVerdict = el.open === true;
    // ② 收起 → 打開 → resize
    const probe = document.createElement('div');
    probe.setAttribute('_echarts_instance_', 'x');
    el.querySelector('div')?.appendChild(probe);
    el.open = false;
    await new Promise(r => setTimeout(r, 60));
    const before = window.__resizeCount;
    el.open = true;
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)));
    o.resized = window.__resizeCount > before;
    // ④ 使用者真的點 summary 收起 → 程式不可再打開
    el.querySelector('summary').click();   // 開著 → 點一下 = 收起
    await new Promise(r => setTimeout(r, 60));
    o.userToggled = el.dataset.userToggled;
    app._syncCorpMore();
    o.stayClosedAfterUser = el.open === false;
    // ⑤ 換股票 → 重置 → 全部展開
    app._lastXrayVerdict = { sym: '2317', verdict: '', tone: 'flat', act: '' };
    app._syncCorpMore();
    o.reopenOnSymChange = el.open === true && el.dataset.userToggled !== '1';
    return o;
});
await browser.close();
if (R.err) { console.log(`❌ analyze 失敗:${R.err}`); process.exit(1); }

ok('🚧 空過守門:摺疊真的在 DOM 裡', R.exists === true);
ok('③ 有結論也⛔ 不可收起(使用者:「全部展開」)', R.openWithVerdict === true);
ok('② 🚨 收起→打開時真的 resize 了內部 ECharts', R.resized === true);
ok('④ 使用者自己收起 → 程式⛔ 不再自動打開', R.userToggled === '1' && R.stayClosedAfterUser === true, JSON.stringify(R));
ok('⑤ 換股票 → 重置記憶、回到全部展開', R.reopenOnSymChange === true);

console.log(fails ? `❌ ${fails} 條失敗` : '✅ CORPLEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
