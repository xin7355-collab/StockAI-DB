#!/usr/bin/env node
/**
 * 🧠 深度診斷:純公式層 + AI 提示詞鐵則(V72.4.0)
 *
 * 使用者要的:「把個股有用資料 + 總經 + 台股大盤加進來,告訴我要注意什麼、怎麼做、
 * 大戶什麼時候可能出貨、是區間操作還是低檔布局」。
 *
 * ⛔ 這支測試釘的是**四條不能被日後「優化」掉的鐵則**:
 *   ① 純公式段不靠 AI —— 沒有金鑰也要有東西看(AI 只是加值層)
 *   ② 出貨徵兆是**清單不是預測** —— 文案不可出現「會在 X 天出貨」這種話
 *   ③ AI 提示詞必須明令「⛔ 不准自己算數、⛔ 不准給買賣價位」(禁 AI 算數 + 單一劇本)
 *   ④ 操作型態必須先過 `_bearGate` —— 空頭時位階再低也不給「布局」這種進場指令
 *
 * ⚠️ 用**真實 data/*.json** 跑,⛔ 不用合成 K 線(合成資料常常一條徵兆都不會亮,
 *    斷言會全部變成假綠燈 —— 同 test_sigedge ⑫⑬ 踩過的空過問題)。
 *
 * 跑法:node scripts/test_deepbrief.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

// ⭐ 空過守門:沒有真實 K 線就別假裝驗過了
const CAND = ['2330', '2317', '2454', '2327', '0050'];
const SYMS = CAND.filter(s => fs.existsSync(path.join(ROOT, 'data', `${s}.json`)));
if (!SYMS.length) {
    console.log('⏭️ 本機沒有 data/*.json 測資,略過');
    console.log('   ↳ 取得:git show origin/gh-pages:data/2330.json > data/2330.json');
    process.exit(0);
}
console.log(`   測資:${SYMS.join(', ')}`);

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const pageErrs = [];
page.on('pageerror', e => pageErrs.push(String(e).slice(0, 200)));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._distributionWatch, null, { timeout: 25000 });

const R = await page.evaluate(async (syms) => {
    const out = { per: {}, err: null };
    try {
        for (const s of syms) {
            const r = await fetch(`data/${s}.json`);
            const raw = await r.json();
            const data = raw.map(x => ({ ...x, close: +x.close, open: +x.open, high: +x.high, low: +x.low, volume: +x.volume }));
            app.currentSymbolId = s;
            app.rawDailyData = data;
            app.activeData = data;
            const dist = app._distributionWatch(data, s);
            const play = app._playbookMode(data, s);
            const facts = app._deepBriefFacts(data, s);
            app.renderDeepBrief(data);
            const el = document.getElementById('deepBriefCard');
            out.per[s] = {
                bars: data.length,
                dist: dist && { hits: dist.hits, total: dist.total, level: dist.level, names: dist.items.map(x => x.name), whys: dist.items.map(x => x.why) },
                play: play && { mode: play.mode, why: play.why, bear: play.bear, boxed: play.boxed, pos: play.pos },
                factKeys: facts ? Object.keys(facts) : null,
                marketKeys: facts?.market ? Object.keys(facts.market) : null,
                shown: el ? !el.classList.contains('hidden') : false,
                text: (el?.innerText || '').replace(/\s+/g, ' ').slice(0, 1600),
            };
        }
        // 空頭守門:直接 stub _bearGate 看操作型態會不會改口
        const s0 = syms[0];
        const r0 = await fetch(`data/${s0}.json`); const d0 = (await r0.json()).map(x => ({ ...x, close: +x.close, open: +x.open, high: +x.high, low: +x.low, volume: +x.volume }));
        app.currentSymbolId = s0;
        const orig = app._bearGate;
        app._bearGate = () => true;
        out.bearMode = app._playbookMode(d0, s0)?.mode;
        app._bearGate = () => false;
        out.bullMode = app._playbookMode(d0, s0)?.mode;
        app._bearGate = orig;
        out.aiSrc = app.analyzeStockDeep.toString();
        out.jargon = app.jargonDict?.['深度診斷'] || '';
    } catch (e) { out.err = String(e).slice(0, 300); }
    return out;
}, SYMS);

ok('⓪ 執行期間沒有 pageerror', pageErrs.length === 0, pageErrs.join(' | '));
ok('⓪ evaluate 沒有丟例外', !R.err, R.err);

// ── ① 純公式段:每一檔都要算得出來,而且卡片真的顯示 ────────────────
let anyHit = 0;
for (const s of SYMS) {
    const p = R.per[s] || {};
    ok(`① ${s} 出貨徵兆表算得出來(8 條)`, !!p.dist && p.dist.total === 8, JSON.stringify(p.dist)?.slice(0, 160));
    ok(`① ${s} 操作型態算得出來`, !!p.play?.mode, JSON.stringify(p.play)?.slice(0, 160));
    ok(`① ${s} 卡片有顯示且有內容`, p.shown && (p.text || '').length > 80, `shown=${p.shown} len=${(p.text || '').length}`);
    ok(`① ${s} ⭐ 每條徵兆都附佐證數字/說明(⛔ 不可只給是非)`,
       !!p.dist && p.dist.whys.every(w => w && w.length > 2), JSON.stringify(p.dist?.whys)?.slice(0, 200));
    anyHit += (p.dist?.hits || 0);
}
// ⚠️ 空過守門:全部 0 條命中時,上面的斷言驗不到「亮起來的樣子」
ok('① ⚠️ 空過守門:測資裡至少要有 1 條徵兆亮起來(否則只驗到全滅的情況)',
   anyHit >= 1, `所有測資合計亮 ${anyHit} 條`);

// ── ② ⛔ 徵兆 ≠ 預測:文案不可宣稱哪天出貨 ─────────────────────────
const allText = SYMS.map(s => R.per[s]?.text || '').join(' ');
// ⚠️ 先 strip 掉**正確的免責句**再比對 —— 本專案踩過 6 次:
//    「這是徵兆清單不是預測」本身就含「預測」兩個字,不 strip 會被自己寫對的話擋下來。
const stripped = allText
    .replace(/不是預測/g, '').replace(/不可預測/g, '').replace(/沒有人算得出[^。]*/g, '')
    .replace(/⛔[^。]*/g, '');
ok('② ⭐⛔ 不可宣稱「大戶會在 X 天/X 日出貨」',
   !/(會在|將在|預計)[^。]{0,12}(天|日|週)[^。]{0,6}出貨/.test(stripped), stripped.slice(0, 200));
ok('② ⭐ 必須寫明「是徵兆不是預測」', /徵兆.{0,6}不是預測|不是預測/.test(allText));
ok('② ⭐ 必須寫明「不是幾條以上就會跌」', /不是「?幾條以上就會跌/.test(allText), allText.slice(0, 300));

// ── ③ AI 提示詞鐵則 ───────────────────────────────────────────────
const src = R.aiSrc || '';
ok('③ ⭐⛔ 提示詞明令「不要自己做加減乘除」(禁 AI 算數)',
   /不要自己做任何加減乘除|禁.{0,4}算數|不准.{0,4}算/.test(src), src.slice(0, 120));
ok('③ ⭐⛔ 提示詞明令「不要給買賣價位」(單一劇本原則)',
   /不要給任何買賣價位|不給買賣價位/.test(src));
ok('③ ⭐ 提示詞要求 AI 跟程式的操作結論一致(不可改口)',
   /你必須跟它一致|不可改口/.test(src));
ok('③ ⭐ 有切股競態守門(await 回來要確認還是同一檔)',
   /currentSymbolId\s*!==\s*sym/.test(src));
ok('③ ⭐ 有要求「這份分析看不到什麼」欄位(誠實揭露盲點)', /blindspot/.test(src));
ok('③ ⭐ 有要求「什麼情況代表判斷錯了」欄位', /invalidate/.test(src));
ok('③ 走深度模型鏈(gemini-openrouter),⛔ 不降級到 Groq', /gemini-openrouter/.test(src));

// ── ④ 空頭守門:_bearGate 為真時不可給「布局/做多」這種進場指令 ────
ok('④ ⭐⛔ 空頭時操作型態必須改口成「先不做」',
   /先不做|不做/.test(R.bearMode || ''), `bear=${R.bearMode}`);
ok('④ ⭐⛔ 空頭時⛔ 不可出現「布局」或「做多」',
   !/布局|做多/.test(R.bearMode || ''), `bear=${R.bearMode}`);
ok('④ 非空頭時會給出實際操作型態(⛔ 不可也是「先不做」→ 那代表守門沒接上)',
   !!R.bullMode && R.bullMode !== R.bearMode, `bull=${R.bullMode} / bear=${R.bearMode}`);

// ── ⑤ 有教學說明,而且說明裡要交代「數字是程式算的」 ────────────────
ok('⑤ 有 ⓘ 說明條目', (R.jargon || '').length > 200);
ok('⑤ ⭐ 說明要講清楚「上面的結論是程式算的,不是 AI 講的」',
   /程式算出來的|不是 ?AI ?講的/.test(R.jargon || ''));
ok('⑤ ⭐ 說明要交代冷門股可能沒有分點/集保資料(不是壞掉)',
   /無資料.{0,10}不是壞掉|不是壞掉/.test(R.jargon || ''));

// ── ⑥ 總經與大盤真的有被收進去(使用者明確要求的)──────────────────
const mk = R.per[SYMS[0]]?.marketKeys || [];
for (const need of ['risk', 'vix', 'sox', 'sp500', 'usdtwd', 'basis', 'fiFut', 'oil']) {
    ok(`⑥ facts.market 含 \`${need}\``, mk.includes(need), JSON.stringify(mk));
}

await browser.close();
console.log();
if (fails.length) { console.log(`❌ DEEPBRIEF_TEST_FAIL:${fails.length} 條`); process.exit(1); }
console.log('✅ DEEPBRIEF_TEST_PASS');
