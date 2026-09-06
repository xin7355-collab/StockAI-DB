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
        out.briefSrc = app.renderDeepBrief.toString();
        out.jargon = app.jargonDict?.['深度診斷'] || '';
        // ⑦ V72.4.2 品質守門:拿**使用者實測說「沒什麼屁用」的那一版原文**當測資
        out.qBad = app._deepBriefQuality({
            headline: '中美晶目前方向不明,觀望為主',
            watch: ['量能只有1.0×20日均量,需注意量能是否能夠帶動價格',
                    '5MA和季線糾結,月線209.60和季線179.78的突破或跌破將是關鍵',
                    '外資近5日和近20日的減碼行為值得關注'],
            distribution: '大戶出貨徵兆代表大戶減持和散戶增持的信號,而非預測出貨的時間,需注意大戶持股減少和散戶增持的趨勢',
            future: '接下來的關鍵在於是否能夠帶量突破或跌破前低,從而轉強或轉弱',
            invalidate: '如果出現明顯的趨勢和量能支持,則代表上述判斷錯了,需要重新評估',
            blindspot: '這份分析缺乏公司基本面的資料和國際市場的影響',
        }).bad;
        out.qGood = app._deepBriefQuality({
            headline: '今天+4.93%但月線209.6還在上方15%,是反彈不是轉強',
            watch: ['季線179.78剛站上,收盤守不守得住是這波關鍵',
                    '外資近5日賣超1,234張,反彈沒有法人買盤',
                    '量是昨量的+17%但只有20日均量1.0倍,追價力道不足'],
            conflict: '今天大漲4.93%但月線還在上方15% → 相信月線,這是反彈',
            mistake: '把站上季線當成轉強去追,結果在月線209.6前被套',
            distribution: '目前一條徵兆都沒亮', future: '盯季線179.78收盤守不守得住',
            invalidate: '收盤跌破季線179.78', blindspot: '此股無券商分點資料',
        }).bad;
        // ⚠️ 這裡不可以在 .every() 的箭頭函式裡用 await(不是 async)→ 先把資料備好再比對
        const _rr = await fetch(`data/${syms[0]}.json`);
        const _dd = (await _rr.json()).map(x => ({ ...x, close: +x.close, open: +x.open, high: +x.high, low: +x.low, volume: +x.volume }));
        const _ff = app._deepBriefFacts(_dd, syms[0]) || {};
        out.factsHasRel = ['relMa5', 'relMa20', 'relMa60', 'relMa240', 'volVsPrev'].every(k => k in _ff);
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

// ── ⑦ V72.4.2 AI 輸出品質守門 ───────────────────────────────────────
//   ⭐ 測資就是**使用者實測後說「沒什麼屁用」的那一版原文** ——
//      ⛔ 別用自己編的假廢話,那只會驗到自己想得到的說法(同 V72.1.4 巡邏 grep 的教訓)。
const qb = R.qBad || [];
ok('⑦ ⭐⛔ 使用者截圖那版必須被判定為「空泛」', qb.length >= 3, JSON.stringify(qb));
ok('⑦ 抓得到廢話詞(值得關注/突破或跌破)', qb.some(x => /廢話詞/.test(x)), JSON.stringify(qb));
ok('⑦ ⭐ 抓得到「在複述規則而不是講這檔」(上一版最致命的毛病)',
   qb.some(x => /複述規則/.test(x)), JSON.stringify(qb));
ok('⑦ 抓得到「判斷錯了的條件無法驗證」', qb.some(x => /無法驗證/.test(x)), JSON.stringify(qb));
ok('⑦ ⛔ 好的版本不可誤報(否則守門只會被無視)', (R.qGood || []).length === 0, JSON.stringify(R.qGood));

// ── ⑧ 提示詞要真的把那幾種廢話寫成禁令 + 補上缺的事實 ────────────
const s2 = R.aiSrc || '';
ok('⑧ ⭐ 提示詞明列禁用詞(值得關注/有待觀察/將是關鍵)',
   /值得關注/.test(s2) && /有待觀察/.test(s2) && /將是關鍵/.test(s2));
ok('⑧ ⭐ 提示詞禁止「雙向都對」的寫法', /雙向都對|漲也對跌也對/.test(s2));
ok('⑧ ⭐ 提示詞禁止複述規則/免責', /複述規則|複述.{0,4}免責/.test(s2));
ok('⑧ ⭐ 要求每條都要有數字', /都必須含具體數字|必須帶至少一個數字/.test(s2));
ok('⑧ ⭐ 新增「矛盾點」與「常見錯誤」欄位(這才是程式做不到的)',
   /conflict/.test(s2) && /mistake/.test(s2));
ok('⑧ ⭐ 均線要連「現價在它上面還下面幾%」一起給(上一版最大缺口)',
   /現價在它.{0,4}上方|不准只念均線數字/.test(s2));
ok('⑧ ⭐ 量能兩種定義都給,並警告只提一個會打架',
   /不同基準|只提其中一個會跟畫面上另一處打架/.test(s2));
ok('⑧ facts 有均線相對位置與量能兩種定義', R.factsHasRel === true, `factsHasRel=${R.factsHasRel}`);

// ── ⑨ V72.4.4 額度控管:快取綁「資料日期」而不是時間 ──────────────
//   使用者問「每次開啟都重新分析會不會爆掉」→ 綁日期就不會:同一檔同一天只算一次。
const s3 = R.aiSrc || '';
ok('⑨ ⭐ 快取鍵含資料日期(⛔ 不可再用 30 分鐘那種時間窗)',
   /dataDate/.test(s3) && /cacheKey\s*=\s*`aiCache_deepBrief_\$\{sym\}_\$\{f\.dataDate/.test(s3), s3.slice(0, 200));
ok('⑨ ⭐ 快取鍵含模型(兩個模型的結果不可互相覆蓋)', /_\$\{engine\}`/.test(s3));
ok('⑨ ⭐ 有 cacheOnly 模式(自動顯示用,⛔ 沒算過就不打 AI)', /opts\.cacheOnly/.test(s3));
ok('⑨ ⭐ renderDeepBrief 會自動吃快取(有算過就直接顯示,零額度)',
   /cacheOnly:\s*true/.test(R.briefSrc || ''));
ok('⑨ ⭐ 可切 Groq 做比對,但⛔ 不可變成自動 fallback',
   /engine === 'groq' \? 'groq-only'/.test(s3));
ok('⑨ ⭐ 會存「可回頭驗證」的紀錄(invalidate + 當時收盤 + 日期)',
   /aiVerifyLog/.test(s3) && /invalidate:/.test(s3) && /close: f\.pC/.test(s3), s3.slice(0, 150));
ok('⑨ 紀錄有滾動上限(⛔ 不可無限長大爆 localStorage)', /slice\(-200\)/.test(s3));

// ── ⑩ V72.4.5 持有結構:套牢比例(實測過)vs 散戶佔比(⛔ 只准講事實)──
const trap = await (async () => {
    const pg = page;
    return pg.evaluate(async (s) => {
        const r = await fetch(`data/${s}.json`);
        const d = (await r.json()).map(x => ({ ...x, close: +x.close, open: +x.open, high: +x.high, low: +x.low, volume: +x.volume }));
        app.currentSymbolId = s; app.rawDailyData = d; app.activeData = d;
        app.renderDeepBrief(d);
        return {
            t: app._trappedRatio(d),
            txt: (document.getElementById('deepBriefCard')?.innerText || '').replace(/\s+/g, ' '),
            src: app._trappedRatio.toString() + app._retailStructure.toString(),
            ai: app.analyzeStockDeep.toString(),
        };
    }, SYMS[0]);
})().catch(() => null);

ok('⑩ 套牢比例算得出來且在 0~100', !!trap?.t && trap.t.pct >= 0 && trap.t.pct <= 100, JSON.stringify(trap?.t));
ok('⑩ ⭐ 有附實測勝率與基準(⛔ 不可只給比例不給成績)',
   !!trap?.t?.w60 && !!trap?.t?.baseW60 && !!trap?.t?.rng, JSON.stringify(trap?.t));
ok('⑩ ⭐ 卡片有「誰在手上」區塊', /誰在手上/.test(trap?.txt || ''));
ok('⑩ ⭐⛔ 必須寫明套牢比例「不是進場或放空的理由」(差距只有 5pp)',
   /不是進場或放空的理由/.test(trap?.txt || ''), (trap?.txt || '').slice(0, 200));
ok('⑩ ⭐ 用典型價不用收盤(振幅大的日子會失真)', /H\(b\) \+ L\(b\) \+ C\(b\)\) \/ 3/.test(trap?.src || ''));
// ⭐ 最重要:散戶那條**只准當事實**,⛔ 不准生出沒驗證過的心理推論
const aiSrc4 = trap?.ai || '';
ok('⑩ ⭐⛔ 提示詞明令「不准講散戶多容易多殺多/信心不足」(那是沒驗證過的預測)',
   /不准講「?散戶多容易多殺多|多殺多/.test(aiSrc4) && /沒驗證/.test(aiSrc4), aiSrc4.slice(0, 150));
// ⚠️ 驗**語意**不驗確切寫法 —— 第一版把 `${f.retail?.weeks || '?'}` 的跳脫寫死進 regex,
//    模板稍微換個寫法就假失敗(測試不該綁死實作細節)。
ok('⑩ ⭐ 提示詞有說明集保只有幾週(誠實揭露樣本限制)',
   /集保資料只有/.test(aiSrc4) && /weeks/.test(aiSrc4), aiSrc4.slice(0, 120));
ok('⑩ ⭐ 套牢比例可以講「期待值要放低」但⛔ 不可當進場理由',
   /期待值要放低/.test(aiSrc4) && /不是進場或放空的理由/.test(aiSrc4));

await browser.close();
console.log();
if (fails.length) { console.log(`❌ DEEPBRIEF_TEST_FAIL:${fails.length} 條`); process.exit(1); }
console.log('✅ DEEPBRIEF_TEST_PASS');
