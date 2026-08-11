#!/usr/bin/env node
/**
 * 🩺 推播體檢(V73.3.2)—— 使用者:「PWA 關螢幕/關網頁還是沒有背景提醒,是我做錯還是功能限制?」
 *
 * ⭐ 答案是「都不是 bug」:網頁一關,裡面的 JS 全部停止 → **PWA 沒有自己醒來的能力**。
 *    唯一機制是 Web Push(伺服器 → 蘋果/Google 推播服務 → 系統喚醒 SW),
 *    所以一定要有一台「一直醒著的機器」= 使用者自己的 Cloudflare Worker。
 * ⛔ 舊版失敗時只在按「啟用推播」才跳 alert → 平常完全看不出卡在哪,只會覺得「壞了」。
 *
 * 這支釘住:
 *   ① 體檢**一定要跳得出來**(⛔ 不可卡住 —— `serviceWorker.ready` 註冊失敗時永遠不 resolve)
 *   ② 要指出**唯一該先修的那一關**(⛔ 不可只列一堆 ❌ 讓使用者自己猜)
 *   ③ 必須誠實寫出「關 App 只推兩種」(⛔ 不可讓使用者以為尾盤買點也會推)
 *   ④ 必須解釋這是規格限制不是 App 壞掉
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const p = await b.newPage();
let msg = '';
p.on('dialog', d => { msg = d.message(); d.dismiss().catch(() => {}); });
await p.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof app !== 'undefined' && !!app._pushDiagnose, null, { timeout: 20000 });
await p.evaluate(() => { app.settings = app.settings || {}; app.settings.workerUrl = ''; });
p.evaluate(() => app._pushDiagnose()).catch(() => {});
await new Promise(r => setTimeout(r, 7000));

// ① ⛔ 空過守門:沒跳出來就代表卡住了 —— 那比沒有體檢更糟
ok('① 體檢視窗有跳出來(⛔ 不可卡住)', msg.length > 50, `msg 長度=${msg.length}`);
ok('②a 沒填 Worker 時要列成 ❌', /❌ 已填 Worker 網址/.test(msg), msg.slice(0, 200));
ok('②b 要指出「先修這一個」', /要先修這一個/.test(msg));
ok('③a 誠實寫出關 App 只推兩種', /只有兩種/.test(msg) && /到價提醒/.test(msg));
ok('③b ⛔ 必須寫明尾盤買點要 App 開著', /尾盤買點/.test(msg) && /必須 App 開著|App 開著/.test(msg));
ok('④ 要解釋是規格限制不是壞掉', /不是這支壞掉|共同限制/.test(msg));

// ⑤ Worker 有填時,那一格要變 ✅(⛔ 防「一律報錯」的過度修正)
msg = '';
await p.evaluate(() => { app.settings.workerUrl = 'https://example.invalid'; });
p.evaluate(() => app._pushDiagnose()).catch(() => {});
await new Promise(r => setTimeout(r, 12000));
ok('⑤a 填了 Worker 網址 → 那一格轉 ✅(⛔ 不可一律報錯)', /✅ 已填 Worker 網址/.test(msg), msg.slice(0, 260));
ok('⑤b Worker 連不上 → 要說是「舊版/沒部署」而不是靜默', /Worker 是最新版/.test(msg), msg.slice(0, 300));

// ⑥ 設定頁真的有那顆按鈕
const hasBtn = await p.evaluate(() => !!document.querySelector('[onclick*="_pushDiagnose"]'));
ok('⑥ 設定頁有「🩺 體檢」按鈕', hasBtn);

await b.close();
console.log(fails.length ? `\n❌ PUSHDIAG_FAIL (${fails.length})` : '\n✅ PUSHDIAG_PASS');
process.exit(fails.length ? 1 : 0);
