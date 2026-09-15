#!/usr/bin/env node
/**
 * 🕐 即時快照新鮮度守門(V77.0.4)
 *
 * 使用者截圖(2026-09-15 09:24,盤中):App 顯示加權 45,862.52 ▼322.33(−0.70%),
 * 同一時間外部看盤 App 是 45,768.99(−0.20%)—— 而它的「昨收」正好就是 45,862.52。
 * → 數字沒算錯,是**整份快照是 9/14 的**,卻被當成「盤中即時」在用。
 *
 * 🚨 真因:`_liveUpdated` 從上線以來**存了但一次都沒有人讀**(陷阱 #37 的極端版),
 *    而所有消費點的判準都是「有沒有資料 / 夠不夠多檔」,⛔ 沒有一個在問「這是哪一天的」。
 *    ⭐ 同陷阱 #10:快取判斷要綁「**資料的日期**」,不是「有沒有做過」。
 *
 * ⛔ 這支釘住的是**用意**(⛔ 不釘字串):
 *   ① 快照不是今天的 → `_liveQuote()` 一律回 null(⛔ 不可回舊值,比空白更危險=陷阱 #34)
 *   ② 快照是今天的 → 照常回值(⛔ 守門不可把好的一起擋掉)
 *   ③ 用**台北日曆日**比:收盤後(15:55)那份仍算今天(⛔ 不可改成「只有 09:00~13:30 才算」)
 *   ④ 擋掉之後**要說出原因**(陷阱 #22)—— ⛔ 不可靜默消失
 *   ⑤ ⛔ 全 App 不可再有「繞過守門直接讀 `_liveQuotes` / `_liveIdx`」的呼叫端(陷阱 #37)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) console.log('  ⚠️ pageerror:', t.slice(0, 160)); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._liveFresh, null, { timeout: 20000 });

// 🧪 共用:灌一份快照(指定 updated 的台北時間),回傳判斷結果
const probe = (tpeIso) => page.evaluate((iso) => {
    app._liveQuotes = { '2330': { p: 1000, c: 1.5, v: 100 }, '2881': { p: 70, c: 0.5, v: 50 } };
    app._liveIdx = { txf: { p: 20000, c: 1.0 } };
    app._liveUpdated = iso;
    app._liveTs = '09/14 15:55';
    return { fresh: app._liveFresh(), q: app._liveQuote('2330'), note: app._liveStaleNote() };
}, tpeIso);

// 台北「今天 / 昨天」的 ISO(⛔ 不寫死日期 —— 寫死的測試明天就自己紅了)
const tpeDay = off => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);

// ① 昨天的快照 → 一律回 null
let r = await probe(`${tpeDay(-1)}T15:55:00+08:00`);
ok('① 昨天的快照 → _liveFresh() 為 false', r.fresh === false, `fresh=${r.fresh}`);
ok('① 昨天的快照 → _liveQuote() 回 null(⛔ 不可回舊值)', r.q === null, `q=${JSON.stringify(r.q)}`);

// ② 今天盤中的快照 → 照常回值
r = await probe(`${tpeDay(0)}T10:30:00+08:00`);
ok('② 今天盤中的快照 → 照常回值(守門⛔ 不可把好的一起擋掉)', !!r.q && +r.q.p === 1000, `q=${JSON.stringify(r.q)}`);

// ③ 今天收盤後(15:55)仍算今天 —— ⛔ 不可改成「只有 09:00~13:30 才算」
r = await probe(`${tpeDay(0)}T15:55:00+08:00`);
ok('③ 今天收盤後的快照仍算今天(⛔ 盤後不可整段沒有現價)', r.fresh === true && !!r.q, `fresh=${r.fresh}`);

// ④ 擋掉之後要說出原因(陷阱 #22)
r = await probe(`${tpeDay(-1)}T15:55:00+08:00`);
ok('④ 擋掉之後要說出原因(⛔ 不可靜默消失)', /不是今天|停在/.test(r.note || ''), `note=${(r.note || '').slice(0, 120)}`);
r = await probe(`${tpeDay(0)}T10:30:00+08:00`);
ok('④b 快照是今天的時⛔ 不可亂貼警告', (r.note || '') === '', `note=${(r.note || '').slice(0, 120)}`);

// ⑤ ⛔ 全 App 不可再有繞過守門的呼叫端(陷阱 #37:共用工具只接了一處)
//    ⚠️ 斷言**先剝掉註解**再比 —— 本 repo 已踩過 6 次「被自己寫的註解救活」
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .split('\n').map(l => l.replace(/\/\/.*$/, '').replace(/<!--[\s\S]*?-->/g, '')).join('\n');
const bad = [];
// ⚠️ 守門**自己的實作**那一段要排除(`_liveFresh` ~ `_loadLiveQuotes` 之間)——
//    它本來就要碰原始欄位。⛔ 範圍刻意收到最小,別擴大成「整個 app 物件」。
let inGate = false;
src.split('\n').forEach((l, i) => {
    if (/_liveFresh\(\)\s*\{/.test(l)) inGate = true;
    if (/_loadLiveQuotes\(\)/.test(l)) inGate = false;
    if (inGate) return;
    if (!/this\._liveQuotes|this\._liveIdx/.test(l)) return;
    if (/_liveQuotes:\s*\{\}|_liveIdx:\s*\{\}/.test(l)) return;              // 宣告
    if (/this\._liveQuotes = |this\._liveIdx = /.test(l)) return;            // 寫入
    if (/_liveFresh\(\)/.test(l)) return;                                    // ✅ 已經過守門
    bad.push(`L${i + 1}: ${l.trim().slice(0, 100)}`);
});
ok('⑤ 沒有繞過 _liveFresh() 直接讀快照的呼叫端', bad.length === 0, bad.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ LIVEFRESH_PASS');
process.exit(fails.length ? 1 : 0);
