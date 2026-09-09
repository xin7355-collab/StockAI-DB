#!/usr/bin/env node
/**
 * 🎫 「這檔適不適合玩權證」測試(V71.9.3)
 *
 * 逐字稿的挑權證 5 字訣「大波・小波・穩・夠・優」,我只有第 ① 條(標的波動)的資料。
 * 這支釘住兩件最容易被做壞的事:
 *   ① 判定門檻必須跟**實測分位**對得上(2,315 檔實測 P10=20.1% / P50=46.6%)
 *      並且要通過「他點名的兩檔」的驗證:中華電 18.8%、中鋼 26.7% 必須被判成「太牛」
 *   ② ⛔ **不可假裝有那四條沒有的資料**(隱波/穩定度/委買量/槓桿)——
 *      必須明說做不到、要去券商 App 看,而且要有「權證不能放著不管」的到期提醒。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

// 造 100 根日 K:每日對數報酬 = ±step(交替)→ 年化波動 ≈ step×√252×100 %
const mk = (annualPct) => {
    const step = (annualPct / 100) / Math.sqrt(252);
    const a = []; let c = 100;
    for (let i = 0; i < 100; i++) {
        c = c * Math.exp(i % 2 ? step : -step);
        a.push({ date: `2026/01/${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c, volume: 1000 });
    }
    return a;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._warrantFitLine, null, { timeout: 20000 });

const run = d => page.evaluate(a => app._warrantFitLine(a), d);
const volOf = h => { const m = h.match(/([\d.]+)%<\/span>/); return m ? +m[1] : null; };

// ── ① 波動率算得準(±8% 容差,交替報酬的樣本標準差會略高於理論值)────────
for (const target of [18.8, 46.6, 101.4]) {
    const h = await run(mk(target));
    const got = volOf(h);
    ok(`① 年化波動率算得準(目標 ${target}%,實得 ${got}%)`,
       got != null && Math.abs(got - target) / target < 0.08, h.slice(0, 120));
}

// ── ② ⭐ 他點名的兩檔必須被判「太牛」(這是門檻對不對的實證)──────────
let h = await run(mk(18.8));      // 中華電實測值
ok('② ⭐ 中華電級(18.8%)→ 判「太牛,不適合」', /太牛/.test(h) && /⛔/.test(h), h.slice(0, 200));
ok('② 要點名中華電/中鋼當對照(讓使用者知道這不是我瞎編的)',
   /中華電/.test(h) && /中鋼/.test(h), h.slice(0, 300));
h = await run(mk(26.7));          // 中鋼實測值
ok('② 中鋼級(26.7%)→ 不可判成「波動夠大」', !/波動夠大/.test(h), h.slice(0, 200));

// ── ③ 高波動 → 才可以說適合 ──────────────────────────────
h = await run(mk(101.4));         // 國巨實測值
ok('③ 國巨級(101.4%)→ 判「波動夠大」', /波動夠大/.test(h) && /✅/.test(h), h.slice(0, 200));

// ── ④ ⛔ 不可假裝有那四條沒有的資料 ─────────────────────────
ok('④ ⭐ 必須明說另外四條做不到', /只算得出這一條/.test(h), h.slice(0, 400));
ok('④ 要點出四條各是什麼(隱波/穩/委買量/槓桿)',
   /隱含波動率/.test(h) && /委買量/.test(h) && /槓桿/.test(h), h.slice(0, 600));
ok('④ 要寫「不做假數字」', /不做假數字/.test(h));
ok('④ ⭐ 必須有「不能放著不管會歸零」的到期提醒', /歸零/.test(h) && /放著不管/.test(h), h.slice(0, 800));

// ── ⑤ 預設收合(照「資訊不爆炸」),不佔版面 ────────────────────
ok('⑤ 用 details 收合,預設不展開', /^<details/.test(h.trim()) && !/\bopen\b/.test(h.slice(0, 60)), h.slice(0, 80));

// ── ⑥ 資料不足 → 回 '',⛔ 不硬算 ──────────────────────────
ok('⑥ 日 K 不足 → 空字串', (await run(mk(50).slice(0, 30))) === '');
ok('⑥ 空陣列 → 空字串', (await run([])) === '');

// ── ⑦ 要真的接進「該買幾張」卡(合併,⛔ 沒開新卡)──────────────
const wired = await page.evaluate(() => {
    const s = app._renderPositionSizer.toString();
    return { n: (s.match(/_warrantFitLine/g) || []).length,
             noNewCard: !/document\.createElement|insertAdjacentHTML/.test(s) };
});
ok('⑦ ⭐ 合併進「該買幾張」卡的**兩個**分支(有填資金/沒填資金)', wired.n === 2, `找到 ${wired.n} 處`);
ok('⑦ ⛔ 沒有另開新卡片', wired.noNewCard);

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ WARRANTFIT_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ WARRANTFIT_TEST_PASS');
