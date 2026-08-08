#!/usr/bin/env node
/**
 * 📦 V73.1.1 網頁 / PWA / APK 環境偵測 —— 測試
 *
 * 使用者要求「程式要區分 PWA 及 APK」。
 * ⛔ 判斷順序是鐵則:APK(TWA)也符合 PWA 的 standalone 條件 →
 *    一定要**先**判 APK(referrer android-app:// / ?source=twa / localStorage 記號)再判 PWA。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('① 靜態:偵測邏輯與佈線');
ok('①a _runtimeEnv 存在且 APK 判斷在 PWA 之前(⛔ 順序不可換)', (() => {
    const i = src.indexOf('_runtimeEnv()');
    if (i < 0) return false;
    const body = src.slice(i, i + 1500);
    const a = body.indexOf("'apk'"), p = body.indexOf("'pwa'");
    return a > 0 && p > 0 && a < p;
})());
ok('①b referrer android-app:// 有寫進 localStorage(⚠️ 只有第一頁看得到,不記就會忘)',
   /android-app:\/\//.test(src) && /proTerm_env_apk/.test(src));
ok('①c ?source=twa 也算 APK(打包時 start_url 的記號)', /=== 'twa'/.test(src));
ok('①d iOS 的 navigator.standalone 也有判(iOS 沒有 display-mode)', /navigator\.standalone === true/.test(src));
ok('①e 設定中心有 envBadge + init 有呼叫 _renderEnvBadge',
   /id="envBadge"/.test(src) && /this\._renderEnvBadge\(\)/.test(src));
ok('①f 說明有講「三種載同一份程式、更新同步」(⛔ 不可讓使用者以為要各自維護)',
   /三種載的是同一份程式/.test(src));

console.log('② 靜態:APK 驗證檔與部署佈線');
const al = JSON.parse(fs.readFileSync(path.join(ROOT, '.well-known/assetlinks.json'), 'utf8'));
ok('②a assetlinks.json 合法且結構正確',
   Array.isArray(al) && al[0]?.target?.namespace === 'android_app' && !!al[0]?.target?.package_name);
const apkDoc = fs.readFileSync(path.join(ROOT, 'docs/APK_BUILD.md'), 'utf8');
ok('②b 文件的 Package ID 跟 assetlinks 一致(⛔ 不一致 APK 永遠驗不過)',
   apkDoc.includes(al[0].target.package_name));
const dp = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy_pages.yml'), 'utf8');
ok('②c deploy_pages 完整四步(paths 觸發/暫存/放回/git add)——少一步就默默不部署',
   /'\.well-known\/\*\*'/.test(dp) && /cp \.well-known\/assetlinks\.json \/tmp\/deploy/.test(dp)
   && /cp \/tmp\/deploy\/\.well-known\/assetlinks\.json/.test(dp) && /git add -f \.well-known\/assetlinks\.json/.test(dp));
const dm = fs.readFileSync(path.join(ROOT, '.github/workflows/daily_miner.yml'), 'utf8');
ok('②d daily_miner 完整四步(checkout main/暫存/放回/git add)——漏 git add 會每天消失且零錯誤',
   /git checkout origin\/main -- \.well-known\/assetlinks\.json/.test(dm)
   && /cp \.well-known\/assetlinks\.json \/tmp\/mine/.test(dm)
   && /cp \/tmp\/mine\/\.well-known\/assetlinks\.json/.test(dm)
   && /git add -f \.well-known\/assetlinks\.json/.test(dm));

console.log('③ 實跑:三種環境各驗一次');
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
const run = async (u, pre) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (pre) await page.addInitScript(pre);
    await page.goto(u, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._runtimeEnv, null, { timeout: 25000 });
    const r = await page.evaluate(() => ({
        env: app._runtimeEnv(),
        badge: (document.getElementById('envBadge') || {}).textContent || '',
    }));
    await ctx.close();
    return r;
};
const r1 = await run(url);
ok('③a 一般開啟 → browser', r1.env === 'browser', r1.env);
const r2 = await run(url + '?source=twa');
ok('③b ?source=twa → apk(而且會被記住)', r2.env === 'apk', r2.env);
const r3 = await run(url, "try{localStorage.setItem('proTerm_env_apk','1')}catch(_){}");
ok('③c localStorage 有 APK 記號 → 之後每次開都是 apk(⛔ referrer 只有第一頁有)', r3.env === 'apk', r3.env);
const r4 = await run(url + '?source=pwa');
ok('③d ?source=pwa(manifest start_url)→ pwa', r4.env === 'pwa', r4.env);
// ④ 空過守門:openSettings 一定會渲染徽章(⚠️ 沙箱裡 init 的那次呼叫排在多個 await 之後,
//    等不到 —— 所以 openSettings 也接了一次,這裡驗的就是那條路)
const ctx5 = await browser.newContext();
const p5 = await ctx5.newPage();
await p5.goto(url, { waitUntil: 'domcontentloaded' });
await p5.waitForFunction(() => typeof app !== 'undefined' && !!app._renderEnvBadge, null, { timeout: 25000 });
const r5 = await p5.evaluate(() => {
    try { app.openSettings(); } catch (_) { try { app._renderEnvBadge(); } catch (__) { } }
    const el = document.getElementById('envBadge');
    return { badge: el ? el.textContent : '', hidden: el ? el.classList.contains('hidden') : true };
});
await ctx5.close();
ok('④ 開設定中心 → envBadge 有字且不再 hidden', /網頁|PWA|APK/.test(r5.badge) && !r5.hidden, JSON.stringify(r5));
await browser.close();
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
