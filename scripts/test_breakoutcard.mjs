#!/usr/bin/env node
/**
 * 📢 「多頭待發射」誠實話守門(V76.3.3)
 *
 * 這張卡實測 **六關只過 3/6、扣成本是負的**(`scripts/breakoutdist_probe.mjs`),
 * 但它宣稱的「快到了」那半**是真的而且單調** → 卡片保留當觀察清單,
 * ⛔ 但不可再暗示「排最前就最可能發動 / 就該買」。
 *
 * ⭐ 釘的是**用意**:① 數字只有一份(改常數,畫面要跟著變,⛔ 不可寫死在文案裡)
 *   ② 每一個寫入點都要帶誠實話(⛔ 不可只有「有候選」那一條路有)
 *   ③ 舊那句被實測打掉的話不可以再出現。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
const fail = [];
const ck = (ok, m) => { if (!ok) fail.push(m); };

// ── ⓒ 原始碼:三個寫入點都要帶誠實話 ────────────────────────────────
// ⚠️ 先剝掉 `//` 註解再比 —— 本 repo 已經被「自己寫的註解救活斷言」害過三次
const code = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fn = code.slice(code.indexOf('_scanBreakoutCandidates('), code.indexOf('_scanWatchlistCheckup('));
ck(fn.length > 500, 'ⓒ0 切不到那兩支函式 → 這一輪不算數(空過守門)');
const writes = fn.match(/box\.innerHTML\s*=/g) || [];
ck(writes.length >= 4, `ⓒ1 只找到 ${writes.length} 個寫入點,少於預期 → 斷言的前提變了`);
// 「掃描中…」那一條是轉瞬即逝的,不要求;其餘三條都要帶
const need = ['自選清單空', '無「接近突破」的打底候選', 'rows.slice(0, 20)'];
for (const k of need) {
    const i = fn.indexOf(k);
    ck(i > 0, `ⓒ2 找不到寫入點「${k}」`);
    if (i < 0) continue;
    const line = fn.slice(fn.lastIndexOf('\n', i) + 1, fn.indexOf('\n', i) + 1);
    ck(/_breakoutEdgeHtml\(\)/.test(line), `ⓒ3 寫入點「${k}」沒有帶上 _breakoutEdgeHtml() → 那條路的使用者看不到實測結論`);
}

// ── ⓓ 被實測打掉的那句話不可以再出現 ───────────────────────────────
ck(!/排最前=最可能先發動/.test(SRC), 'ⓓ 教學文案還寫著「排最前=最可能先發動」—— 那正是實測打掉的那句(排序扣成本後是負的)');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._breakoutEdgeHtml === 'function', null, { timeout: 25000 });

const r = await page.evaluate(() => {
    const A = window.app || app, E = A._BREAKOUT_EDGE || {};
    const real = A._breakoutEdgeHtml();
    // 🔬 把常數換掉,畫面必須跟著變 → 證明數字**不是寫死在文案裡**
    const keep = JSON.parse(JSON.stringify(E));
    A._BREAKOUT_EDGE = { ...keep, near: 9.87, brk: [11.1, 22.2, 33.3, 44.4], gates: 6, syms: 1234 };
    const faked = A._breakoutEdgeHtml();
    A._BREAKOUT_EDGE = keep;
    return { E: keep, real, faked, txt: real.replace(/<[^>]*>/g, '') };
});
await browser.close();

// ── ⓐ 常數本身 ────────────────────────────────────────────────
ck(r.E && Number.isFinite(r.E.near), 'ⓐ1 _BREAKOUT_EDGE 沒有 near');
ck(r.E.gates < 6, `ⓐ2 六關寫成 ${r.E.gates}/6 —— 若真的六關全過,這張卡的定調要重寫(⛔ 不可只改數字)`);
ck(r.E.near - r.E.cost < 0, `ⓐ3 扣成本後 ${(r.E.near - r.E.cost).toFixed(2)}pp 不是負的 → 定調要重寫`);
const b = r.E.brk || [];
ck(b.length === 4 && b[0] > b[1] && b[1] > b[2] && b[2] > b[3],
   `ⓐ4 「站上壓力」比例不再單調(${b.join('/')}) → 卡上那句「越近越容易過」失去依據`);

// ── ⓑ 顯示:誠實話 + 數字來自常數 ───────────────────────────────
ck(/不是買進順序|不代表最該買/.test(r.txt), 'ⓑ1 卡上沒寫「⛔ 不是買進順序 / 排第一不代表最該買」');
ck(r.txt.includes(String(r.E.brk[0])), 'ⓑ2 卡上沒印「站上壓力」的比例(那是它唯一測得到的東西)');
ck(/成本/.test(r.txt), 'ⓑ3 卡上沒提交易成本 —— 這張卡的關鍵正是「扣成本後是負的」');
ck(r.faked !== r.real && r.faked.includes('11.1'), 'ⓑ4 換掉 _BREAKOUT_EDGE 之後畫面沒變 → 數字被寫死在文案裡(改探針就會對不上)');

if (fail.length) { console.log('❌ BREAKOUTCARD_FAIL'); fail.forEach(f => console.log('   ・' + f)); process.exit(1); }
console.log('✅ BREAKOUTCARD_PASS(全部通過)');
