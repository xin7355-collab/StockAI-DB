#!/usr/bin/env node
/**
 * 🧠 「現在該做什麼」只留一個聲音(V75.0.2)
 *   使用者:「以出場進場等等,**太多版本應該統一用最厲害的招式,使用者很混亂**」
 *
 * ⭐ 量出來的事實:個股頁**獨立下結論的介面有 30+ 個**,光「這檔現在該做什麼」就有 5 份
 *   (程式碼註解自己就寫著「五張卡各說各話」)。
 *
 * ⭐⭐ 但 V73.7.0 起其中 **4 份已經被 `_initOvFold()` 收進 `#ovMoreWrap`** 了 ——
 *   所以這一輪要做的**不是再改渲染**(那會打到 6 支既有測試),而是:
 *     ① **把現狀釘住**(⛔ 別哪天有人「順手」把它們搬回第一屏)
 *     ② 🚨 **補上誠實揭露** —— 收起來還不夠:使用者點開之後仍會看到 4 份各自下結論的卡,
 *        而它們**沒有各自的實測背書**;不明講「以上面為準」的話,收起來只是把矛盾藏起來。
 *
 * ⛔ 三條不可改掉:
 * ① 第一屏**只有 `ovCommandCenter` 在下指令**,其餘 4 份都在 `ovMoreWrap` / `ovNowMore` 裡
 * ② 🚨 **收起 ≠ 拿掉計算** —— `_renderTrendCommand` 仍要寫入
 *    `_ovTrend` / `_lastOvPlan` / `_exitMode`(全 App 依賴,而且 6 支測試釘著)
 * ③ 揭露文案必須寫「⛔ 各自沒有獨立的實測背書」+「以上面那張為準」
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 220) : ''}`); } };

// ═══ 靜態 ═══
const fold = SRC.slice(SRC.indexOf('_initOvFold() {'), SRC.indexOf('_initOvFold() {') + 700);
ok('⓪ 取樣守門:抓得到 `_initOvFold` 的定義', fold.includes('ovMoreWrap'));
ok('① 三個容器都在收合清單裡(`ovTabBar` / now pane / `strategyMainBox`)',
   /getElementById\('ovTabBar'\)/.test(fold) && /\[data-ovpane="now"\]/.test(fold) && /getElementById\('strategyMainBox'\)/.test(fold));
ok('①b 收合有接線(切到總覽 / 重繪時都會跑)', (SRC.match(/this\._initOvFold\(\)/g) || []).length >= 2);
// ② 🚨 收起 ≠ 拿掉計算
const tc = SRC.slice(SRC.indexOf('_renderTrendCommand(data, ind, last) {'), SRC.indexOf('_renderChuExitSop(data, ind, last) {'));
ok('⓪b 取樣守門:抓得到 `_renderTrendCommand` 的定義', tc.length > 3000, String(tc.length));
for (const [k, re] of [['_ovTrend', /this\._ovTrend = \{/], ['_lastOvPlan', /this\._lastOvPlan = \{/], ['_exitMode', /this\._exitMode = \{/]])
    ok('② 🚨 收起⛔ 不可拿掉計算:_renderTrendCommand 仍要寫入 ' + k, re.test(tc));
// ③ 揭露文案
ok('③ 🚨 必須明講「各自沒有獨立的實測背書」', /各自沒有獨立的實測背書/.test(SRC));
ok('③b 🚨 必須明講「說法不一樣時以上面那張為準」', /說法不一樣時一律以上面那張為準/.test(SRC));

// ═══ 實跑 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app.analyze, null, { timeout: 30000 });
const R = await page.evaluate(async () => {
    const A = window.app || app;
    await A.analyze('2330'); A.switchAppTab('diag');
    await new Promise(r => setTimeout(r, 2500));
    try { A.switchSubTab('strategy'); } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
    const anc = id => { const el = document.getElementById(id); if (!el) return 'missing'; const o = []; let n = el.parentElement; while (n && n !== document.body) { if (n.id) o.push(n.id); n = n.parentElement; } return o.join(' < '); };
    // 🚨 `_renderTrendCommand` 在沙箱可能因為指標算不出來而早退 → 直接餵資料呼叫它
    const k = []; for (let i = 0; i < 90; i++) { const c = 60 + i * 0.8; k.push({ date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, open: c - .3, high: c + .5, low: c - .6, close: c, volume: 1e6 }); }
    const cl = k.map(r => r.close), ma = n => cl.map((_, i) => i < n - 1 ? null : cl.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
    A.currentSymbolId = '9999'; A.rawDailyData = k; A.activeData = k;
    A.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60), ma240: ma(60) };
    A._ovTrend = null; A._lastOvPlan = null; A._exitMode = null;
    try { A._renderTrendCommand(k, A.indicators, k.length - 1); } catch (e) { return { err: String(e) }; }
    return {
        anc: Object.fromEntries(['ovCommandCenter', 'trendCommandCard', 'playbookRadarCard', 'chuActionCard', 'deepBriefCard'].map(i => [i, anc(i)])),
        folded: document.getElementById('ovMoreWrap')?.dataset.folded,
        hidden: document.getElementById('ovMoreWrap')?.classList.contains('hidden'),
        wrote: { t: !!A._ovTrend, p: !!A._lastOvPlan, e: !!A._exitMode },
        // ⚠️ 沙箱連不到 Tailwind CDN → `.hidden` 沒有 CSS,`innerText` 對它照樣回傳全文
        //   ⛔ 所以「看不看得見」不能用 innerText 判 → 自己往上追祖先的 hidden class
        //   (注入「把揭露藏進 hidden」時,第一版就是這樣假通過的)
        note: (() => {
            const el = document.querySelector('#ovMoreBar .text-\\[9px\\]') || document.getElementById('ovMoreBar');
            if (!el) return '';
            let n = el; while (n && n !== document.body) { if (n.classList.contains('hidden')) return '(被 hidden 藏起來了)'; n = n.parentElement; }
            return (el.innerText || '').replace(/\s+/g, ' ');
        })(),
    };
});
await browser.close();
if (R.err) { console.log('❌ 實跑丟例外  ' + R.err); process.exit(1); }

ok('④ 🚨 第一屏只有行動指令中心在下指令(⛔ 其餘 4 份都要在收合裡)',
   !/ovMoreWrap/.test(R.anc.ovCommandCenter)
   && ['trendCommandCard', 'playbookRadarCard', 'chuActionCard', 'deepBriefCard'].every(i => /ovMoreWrap/.test(R.anc[i])),
   JSON.stringify(R.anc));
ok('④b 收合預設是收起來的', R.folded === '1' && R.hidden === true, JSON.stringify([R.folded, R.hidden]));
ok('⑤ 🚨 收起⛔ 不可影響計算:三個結論都要被寫進去', R.wrote.t && R.wrote.p && R.wrote.e, JSON.stringify(R.wrote));
ok('⑥ 揭露文案看得見(⛔ 不可藏在收合裡 —— 那就是它要解決的問題)',
   /各自沒有獨立的實測背書/.test(R.note) && /以上面那張為準/.test(R.note), R.note.slice(0, 200));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ ONEVOICE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
