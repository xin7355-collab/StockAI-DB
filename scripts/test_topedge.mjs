#!/usr/bin/env node
/**
 * 🎯 「今天最該看的一件事」(V72.1.0)
 *
 * 使用者原話:「你只要給我最最好應該出現的資料**勝率最高的資料**」
 *            「不要老是都是所有的資料都打出來根本就不知道看哪一個」
 *
 * 背景:實測有效的訊號(_SIGNAL_EDGE)本來只在**總覽→進場**頁籤 —— 踩到陷阱 #32
 *      「卡片放錯頁籤 → 使用者找不到,以為沒做」。他連問兩次都沒看到。
 * → 把**期望值最高的那一個**提到「⭐ 重點判讀」最上方(常顯區第一眼)。
 *
 * ⛔ 這支釘住四件事:
 *   ① 只放**一個**(整份搬過來就又變資訊爆炸,違反「合併不重複」鐵則)
 *   ② 看多必須**正期望值**才准上第一眼(常對但不賺的不該佔版面,V72.0.3 的教訓)
 *   ③ ⛔ 看空/警示**不設期望值門檻**(風險提醒不打折,V72.0.6 多空不對稱)
 *   ④ ⭐ 期望值對多空**意思相反**,⛔ 不可用同一句話講 ——
 *      看空的「−1.4%」代表訊號**兌現**,不是「會賠」
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
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._ovTopEdge, null, { timeout: 20000 });

// 用 stub 的 proven 直接驗挑選規則(⛔ 不複製一份判定邏輯,只是控制輸入)
const pick = proven => page.evaluate(pv => {
    app.currentSymbolId = 'T1';
    app._entryCheckup = () => ({ proven: pv });
    app._ecCache = null;
    const h = app._ovTopEdge([1, 2, 3], 'T1');
    return h == null ? null : h;
}, proven);
const mk = (title, tone, exp, grade = 'A') =>
    ({ title, tone, _e: { grade, n: 500, e10: 1, w10: 42, p: 0.01, e20: 1, payoff: 1.1, exp } });

// ── ① 只放一個(⛔ 不整份搬過來)────────────────────────────
let h = await pick([mk('訊號A', 'bull', 0.9), mk('訊號B', 'bull', 0.5), mk('訊號C', 'bull', 0.3)]);
ok('① ⭐ 只顯示第一個(⛔ 不整份搬過來)',
   /訊號A/.test(h) && !/訊號B/.test(h) && !/訊號C/.test(h), h);
ok('① 要指路完整清單在「進場」頁籤', /進場」?頁籤/.test(h), h);

// ── ② 看多:期望值必須為正才准上第一眼 ────────────────────────
h = await pick([mk('常對但不賺', 'bull', -0.8), mk('真的會賺', 'bull', 0.4)]);
ok('② ⭐ 跳過期望值為負的看多訊號', /真的會賺/.test(h) && !/常對但不賺/.test(h), h);
ok('② 沒有正期望值的看多 → 不顯示', (await pick([mk('只有這個', 'bull', -0.5)])) === null);
ok('② 期望值為 null 的看多 → 不顯示', (await pick([mk('沒成績', 'bull', null)])) === null);

// ── ③ ⛔ 看空/警示不設期望值門檻(風險提醒不打折)──────────────
h = await pick([mk('爆量長黑', 'bear', -1.4)]);
ok('③ ⭐⛔ 看空訊號期望值為負也要顯示(風險提醒不打折)', h != null && /爆量長黑/.test(h), String(h));
h = await pick([mk('高檔警示', 'warn', -0.2)]);
ok('③ warn 同樣不打折', h != null && /高檔警示/.test(h), String(h));

// ── ④ ⭐ 期望值對多空意思相反,⛔ 不可用同一句話 ────────────────
const hb = await pick([mk('底部頸線突破', 'bull', 0.6)]);
const hs = await pick([mk('極端超跌・沒量', 'bear', -1.433)]);
ok('④ ⭐ 看多用「期望 +X%」', /期望 <b[^>]*>\+0\.6%/.test(hb), hb);
ok('④ ⭐ 看空⛔ 不可寫「期望 −X%」(會被讀成「會賠」)', !/期望 <b[^>]*>-1\.433%/.test(hs), hs);
ok('④ ⭐ 看空要改講「訊號後 10 日平均 −X%」', /訊號後 10 日平均 <b[^>]*>-1\.433%/.test(hs), hs);
ok('④ ⭐ 看空要說「跌得越多代表這個警示越準」', /跌得越多代表這個警示越準/.test(hs), hs);
ok('④ ⭐⛔ 看空要說「不是賣出指令」', /不是賣出指令/.test(hs), hs);
ok('④ ⭐ 看多要提醒未扣交易成本', /未扣交易成本/.test(hb), hb);

// ── ⑤ 燈號鐵則:✅ 只能給看多,⛔ 不可拿來標警示 ──────────────
ok('⑤ ⭐ 看多用 ✅', /✅/.test(hb) && !/⚠️/.test(hb.split('</span>')[0]), hb.slice(0, 120));
ok('⑤ ⭐⛔ 看空不可用 ✅(✅ 在燈號鐵則是「安全/通過」)', !/✅/.test(hs), hs.slice(0, 160));

// ── ⑥ 台股色:看多紅、看空綠 ─────────────────────────────
ok('⑥ 看多標題用 text-red-300', /text-red-300">底部頸線突破/.test(hb), hb.slice(0, 200));
ok('⑥ 看空標題用 text-green-300', /text-green-300">極端超跌/.test(hs), hs.slice(0, 200));

// ── ⑦ 基準勝率要寫出來(否則 42% 會被誤讀成輸)──────────────
ok('⑦ ⭐ 要標基準勝率', /基準 \d+%/.test(hb), hb);

// ── ⑧ 沒有訊號 → null(⛔ 不留空殼)───────────────────────
ok('⑧ proven 為空 → null', (await pick([])) === null);
ok('⑧ _entryCheckup 回 null → 不可 throw', (await page.evaluate(() => {
    app._entryCheckup = () => null; app._ecCache = null;
    try { return app._ovTopEdge([1], 'T1'); } catch (e) { return 'THROW:' + e.message; }
})) === null);

// ── ⑨ 真的接進「⭐ 重點判讀」(常顯區),⛔ 不是新開一張卡 ────────
const wired = await page.evaluate(() => ({
    called: /_ovTopEdge\(data, sym\)/.test(app._ovStrongSignals.toString()),
    inCard: /今天最該看的一件事/.test(app._ovStrongSignals.toString()),
}));
ok('⑨ ⭐ _ovStrongSignals 有呼叫', wired.called, '');
ok('⑨ ⭐ 併進「⭐ 重點判讀」那張卡(⛔ 沒開新卡)', wired.inCard, '');
ok('⑨ ⛔ 沒有新增 DOM id', !/id="ovTopEdge/.test(await page.content()));

// ── ⑩ 真實資料實跑(⛔ 別只用 stub,那驗不到 _entryCheckup 真的跑得動)──
const real = await page.evaluate(rows => {
    delete app._entryCheckup;   // 還原成真的
    return null;
}, null).then(() => page.reload({ waitUntil: 'domcontentloaded' }))
    .then(() => page.waitForFunction(() => typeof app !== 'undefined' && !!app._ovTopEdge, null, { timeout: 20000 }))
    .then(() => page.evaluate(rows => {
        app.currentSymbolId = '2330'; app.rawDailyData = rows; app.activeData = rows; app._ecCache = null;
        const h = app._ovTopEdge(rows, '2330');
        return { ok: h === null || typeof h === 'string', txt: h ? h.replace(/<[^>]+>/g, '') : '(今天沒有)' };
    }, JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2330.json'), 'utf8'))));
ok('⑩ ⭐ 真實 2330 資料實跑不 throw、回字串或 null', real.ok, JSON.stringify(real).slice(0, 200));
console.log(`   ↳ 2330 實跑結果:${real.txt.slice(0, 110)}`);

ok('⑪ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ TOPEDGE_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ TOPEDGE_TEST_PASS');
