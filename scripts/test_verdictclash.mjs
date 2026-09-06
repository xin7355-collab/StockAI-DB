// 🧪「兩張卡下相反指令」防呆(V71.7.7)
// 使用者截圖:分析師盤勢解讀寫「偏多格局,可偏多操作」,同畫面反攻雷達寫「打底觀察中 7/10」、
// 跑馬燈寫「多頭轉弱」。→ 違反「邏輯不打架 / 單一劇本原則」。
// 規則:中期(反攻雷達)沒過門檻時,短線技術分數再高也不准下加碼指令。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const ROOT = '/home/user/StockAI-DB';
const url = pathToFileURL(ROOT + '/index.html').href;
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(() => {
  const noop = () => inst;
  const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
  Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const kl = { sup: [{ v: 39000, n: '季線' }], res: [{ v: 41000, n: '月線' }] };
    const mr = { kospi_chg_pct: 1.2, nikkei_chg_pct: 0.4 };
    const chips = { fiSpot: -220, fi: -81017, basis: 12, marginBil: 2900 };
    const out = {};
    // ① 中期未過關(7/10,門檻 8)+ 短線技術分 80 → 不可叫人加碼
    app._reboundVerdict = { icon: '⚠️', txt: '打底觀察中', passN: 7, total: 10 };
    out.weak = app._marketAnalystHtml(kl, mr, 80, chips, []);
    // ② 中期已過關(9/10)+ 短線技術分 80 → 才可以說偏多可操作
    app._reboundVerdict = { icon: '✅', txt: '反攻條件成形', passN: 9, total: 10 };
    out.strong = app._marketAnalystHtml(kl, mr, 80, chips, []);
    // ③ 雷達還沒算出來(undefined)→ 維持舊行為,不可 throw
    app._reboundVerdict = null;
    out.none = app._marketAnalystHtml(kl, mr, 80, chips, []);
    // ④ 短線本來就偏空 → 不受影響
    app._reboundVerdict = { icon: '⚠️', txt: '打底觀察中', passN: 7, total: 10 };
    out.bear = app._marketAnalystHtml(kl, mr, 20, chips, []);
    return out;
});
await b.close();

ok('① 中期未過關時,不可出現「可偏多操作」', !R.weak.includes('可偏多操作'), R.weak.slice(-260));
ok('① 要改講「短線轉強、但中期未過關」', R.weak.includes('短線轉強') && R.weak.includes('中期未過關'), R.weak.slice(-260));
ok('① 要把雷達的實際條數講出來(可稽核)', R.weak.includes('7/10') && R.weak.includes('門檻 8'), R.weak.slice(-260));
ok('① 要明確說「做短不加碼」', R.weak.includes('不加碼'), R.weak.slice(-260));
ok('② 中期過關時才准說「偏多格局,可偏多操作」', R.strong.includes('可偏多操作'), R.strong.slice(-200));
ok('③ 雷達沒資料時不 throw、維持舊行為', typeof R.none === 'string' && R.none.includes('可偏多操作'), String(R.none).slice(-200));
ok('④ 短線偏空時結論不變(仍是偏空格局)', R.bear.includes('偏空格局'), R.bear.slice(-200));

// ══════════════════════════════════════════════════════════════════
// 🔮 V72.0.7 第二處同類打架:「明日劇本」vs 總覽主結論(使用者 2327 截圖)
//   截圖同一畫面:總評儀表板「🟢 空方・避開 —— 反彈是給你出場用的」,
//   下面「🔮 明日劇本」卻寫「🟡 明日偏多(力道普通)」+
//   「開高站上昨高 583.00 → 可順勢做多/抱單」。
//   ⚠️ 兩張都沒算錯 —— 明日劇本看**明天一天**、總評看**中期趨勢**;
//      錯在**兩張都在下操作指令**。修法是讓短線那張改口,⛔ 不是改它的分數。
// ══════════════════════════════════════════════════════════════════
{
    const b2 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const p2 = await b2.newPage();
    await p2.goto('file://' + ROOT + '/index.html', { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => typeof app !== 'undefined' && !!app._tomorrowPlaybookHtml, null, { timeout: 20000 });
    // ⭐ 用**真實** 2327 日 K 重現那張截圖(⛔ 不用合成資料)
    const rows2327 = JSON.parse(fs.readFileSync(ROOT + '/data/2327.json', 'utf8'));
    const R2 = await p2.evaluate(rows => {
        rows = rows.slice();
        rows.push({ date: '2026/08/04', open: 552, high: 568, low: 550, close: 565, volume: 9e6 });
        app.currentSymbolId = '2327'; app.rawDailyData = rows; app.activeData = rows;
        const cl = rows.map(r => +r.close);
        const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((a, v) => a + v, 0) / k);
        app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
        const L = rows.length - 1;
        const o = { ma5: ma(5)[L], ma20: ma(20)[L], ma60: ma(60)[L] };
        app._ovTrend = { sym: '2327', trend: 'bear', txt: '空頭' };  o.bear = app._tomorrowPlaybookHtml();
        app._ovTrend = { sym: '2327', trend: 'bull', txt: '多頭' };  o.bull = app._tomorrowPlaybookHtml();
        app._ovTrend = { sym: '9999', trend: 'bear', txt: '空頭' };  o.other = app._tomorrowPlaybookHtml();  // 別檔的結論不可套用
        app._ovTrend = null;                                        o.none = app._tomorrowPlaybookHtml();
        return o;
    }, rows2327);
    const strip2 = h => String(h).replace(/<[^>]+>/g, '');

    ok('⑤ ⭐ 這組真實資料的均線真的是空排(⛔ 否則下面全是空過)',
       R2.ma5 < R2.ma20 && R2.ma20 < R2.ma60, JSON.stringify(R2).slice(0, 120));
    ok('⑥ ⭐⛔ 主結論空頭時,明日劇本不可再說「可順勢做多/抱單」',
       !/可順勢做多|抱單/.test(strip2(R2.bear)), strip2(R2.bear).slice(0, 300));
    ok('⑥ ⭐ 開高要改講「反彈減碼」', /反彈減碼/.test(strip2(R2.bear)), strip2(R2.bear).slice(0, 300));
    ok('⑥ ⭐ 要點出「別因為一根紅K就改看多」', /別因為一根紅K就改看多/.test(strip2(R2.bear)), '');
    ok('⑥ 要給「中期轉折的第一個條件」= 站回月線', /站回月線/.test(strip2(R2.bear)) && /中期轉折/.test(strip2(R2.bear)), '');
// NOTE V74.5.4: V73.2.9 起「大盤過熱/轉弱/盤整」時,那句刻意從「可順勢做多/抱單」
//   改成「有貨的可以續抱 … 空手的先不要追」→ 舊斷言釘死那個字串會**假失敗**。
//   改釘用意:非空頭情境不可套用空頭措辭,而且要留得住正向動詞。
    const _pos = t => /可順勢做多|可以續抱|續抱/.test(t);
    // NOTE: the 開低 line contains 別搶反彈 in BOTH branches -> only 中期是空頭 marks the bear branch.
    const _bearWords = t => /中期是空頭/.test(t);
    ok('⑦ ⭐ 主結論多頭時維持舊行為(⛔ 別把正常情境弄壞)',
       _pos(strip2(R2.bull)) && !_bearWords(strip2(R2.bull)), strip2(R2.bull).slice(0, 250));
    ok('⑧ ⭐ 主結論是**別檔**的 → 不可套用(切股殘留守門)',
       _pos(strip2(R2.other)) && !_bearWords(strip2(R2.other)), strip2(R2.other).slice(0, 250));
    ok('⑨ 主結論還沒算出來 → 維持舊行為,不可 throw',
       typeof R2.none === 'string' && _pos(strip2(R2.none)) && !_bearWords(strip2(R2.none)), String(R2.none).slice(0, 200));
    await b2.close();
}

// ══════════════════════════════════════════════════════════════════
// 🌡️ V72.0.8 第三處同類打架:「本股 vs 大盤」也在下多方指令
//   截圖:總評「空方・避開 —— 反彈是給你出場用的」,
//         這張卻「🔥 主流資金正在買的股 → 沿 5 日線抱好,別提早下車」。
//   ⚠️ diag(今天比大盤強)是**事實描述,不可動**;要改的只有 act(操作指令)。
//   ⭐ 這是同一個錯誤的第三次 → 已當成通則寫進 CLAUDE.md。
// ══════════════════════════════════════════════════════════════════
{
    const b3 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const p3 = await b3.newPage();
    await p3.goto('file://' + ROOT + '/index.html', { waitUntil: 'domcontentloaded' });
    await p3.waitForFunction(() => typeof app !== 'undefined' && !!app.renderMktCompare, null, { timeout: 20000 });
    const src3 = await p3.evaluate(() => app.renderMktCompare.toString());
    ok('⑩ ⭐ vs大盤 有走共用守門 _bearGate', /_bearGate\(sym\)/.test(src3), '');
    // ⭐ V72.0.9:守門抽成共用函式後,改驗**那一份**有綁 sym(防切股殘留)
    const gateSrc = await p3.evaluate(() => app._bearGate.toString());
    ok('⑩ ⭐ 共用守門要綁 sym + 只在 bear 觸發',
       /t\.sym === String\(/.test(gateSrc) && /t\.trend === 'bear'/.test(gateSrc), gateSrc);
    ok('⑩ ⭐ 守門要能容忍不傳 sym(退回 currentSymbolId)',
       /currentSymbolId/.test(gateSrc), gateSrc);
    ok('⑩ ⭐⛔ 只改 act(指令),不可動 diag(事實描述)',
       /act = `⚠️/.test(src3) && !/diag = `⚠️/.test(src3), '');
    ok('⑩ ⭐ 改寫後要說「不是抱牢或加碼的理由」', /不是抱牢或加碼的理由/.test(src3), '');
    ok('⑩ 條件要涵蓋原本的多方用詞(抱好/別提早下車/加碼)',
       /抱好\|別提早下車\|抱著\|加碼/.test(src3), '');

    // 🏷️ V72.0.8 同名不同義:三個「主力/大戶」
    const src4 = await p3.evaluate(() => app._overviewChipSnapInner.toString());
    const src5 = await p3.evaluate(() => app._renderTrendCommand.toString());
    ok('⑪ ⭐ 官方三大法人那格改叫「法人」(它算的是 foreign_net+trust_net,不是分點大戶)',
       /法人 5 日買超/.test(src5) && !/大戶 5 日買超/.test(src5), '');
    ok('⑪ ⭐ 分點那格要叫「分點主力」並標明近5日', /分點主力/.test(src4) && /近5日/.test(src4), '');
    ok('⑪ ⭐ 要有 title 說明「跟法人不是同一批人」', /跟上面「法人」不是同一批人/.test(src4), '');
    ok('⑪ ⭐⛔ 方向相反時要主動點出來(⛔ 不可讓使用者自己發現)',
       /方向相反,不是算錯/.test(src4), '');
    ok('⑪ 說明要講清楚差別(身分別 vs 哪家券商)',
       /身分別/.test(src4) && /哪家券商/.test(src4), '');
    ok('⑪ ⛔ 不可硬統一成一個數字(那會失真)', /不是硬統一成一個數字/.test(src4), '');

    // 📐 V72.0.8 波動率金額必須跟顯示的 % 自洽(使用者會拿畫面數字驗算)
    const vol = await p3.evaluate(() => {
        // per.vol = 7.375 → 顯示 7.4%,金額必須用 7.4 算(565×7.4% = 41.81)
        const real = app._stockPersonality;
        app._stockPersonality = () => ({ tag: '⚡ 高波動飆股', vol: 7.375, gaps: 0 });
        const d = Array.from({ length: 80 }, (_, i) => ({ date: `2026-06-${String(i % 28 + 1).padStart(2, '0')}`, open: 565, high: 570, low: 560, close: 565, volume: 1e6 }));
        const h = app._stockHabitLine ? app._stockHabitLine(d, 565) : null;
        app._stockPersonality = real;
        return h;
    });
    if (vol) {
        const m1 = String(vol).match(/震約 <b[^>]*>([\d.]+)%/);
        const m2 = String(vol).match(/±([\d.,]+) 元/);
        ok('⑫ ⭐ 顯示的 % 與金額必須自洽(使用者會拿畫面數字驗算)',
           m1 && m2 && Math.abs(565 * (+m1[1]) / 100 - (+m2[1].replace(/,/g, ''))) < 0.02,
           `顯示 ${m1 && m1[1]}% / ±${m2 && m2[1]} 元;565×${m1 && m1[1]}% = ${m1 ? (565 * +m1[1] / 100).toFixed(2) : '?'}`);
    } else {
        ok('⑫ 波動率那行取不到(函式名可能改了)→ 需人工確認', false, 'app._stockHabitLine 回 null');
    }

    // ⭐ V72.0.9 第 4 處:「⭐ 重點判讀」在**常顯區**,比摺疊區裡的更該守
    const src6 = await p3.evaluate(() => app._ovStrongSignals.toString());
    ok('⑬ ⭐ 重點判讀的「明日劇本偏多」也要走守門', /_bearGate\(sym\)/.test(src6), '');
    ok('⑬ ⭐ 空頭時要改講「反彈減碼用,不是買點」', /反彈減碼用/.test(src6), '');
    ok('⑬ ⛔ 空頭時不可再說「開低量縮是較好買點」',
       /_bearGate\(sym\)[\s\S]{0,400}?不是買點/.test(src6), '');

    // 🏷️ V72.0.9 「大戶站買方(大戶倒貨給散戶)」自相矛盾
    const src7 = await p3.evaluate(() => app._chipAnalystLine.toString());
    ok('⑭ ⭐ 負面 driver ⛔ 不可用括號跟「站買方」並排(會自相矛盾)',
       /_drvBad/.test(src7) && /倒貨\|撤退\|出貨/.test(src7), '');
    ok('⑭ ⭐ 相反時要改成「但…」明講', /dBut/.test(src7) && /但\$\{_drv\}/.test(src7), '');
    ok('⑭ ⭐ 空頭時⛔ 不可說「放心做 / 別自己嚇自己提前下車」',
       /_bullAct/.test(src7) && /不是進場或抱牢的理由/.test(src7), '');
    // 實跑:餵「分數偏多 + driver 是倒貨」→ 不可出現並排的矛盾句
    const clash = await p3.evaluate(() => {
        app.currentSymbolId = 'T1';
        app._lastChipScore = { sym: 'T1', score: 62 };
        app._lastChipClean = { sym: 'T1', clean: 75, driver: '大戶倒貨給散戶' };
        app._ovTrend = { sym: 'T1', trend: 'bear', txt: '空頭' };
        const bear = app._chipAnalystLine();
        app._ovTrend = { sym: 'T1', trend: 'bull', txt: '多頭' };
        const bull = app._chipAnalystLine();
        return { bear: bear && bear.txt, bull: bull && bull.txt };
    });
    ok('⑭ ⭐⛔ 實跑:不可出現「站買方(大戶倒貨給散戶)」這種並排',
       !/站買方[^—]*\(大戶倒貨給散戶\)/.test(String(clash.bear)) && !/站買方[^—]*\(大戶倒貨給散戶\)/.test(String(clash.bull)),
       JSON.stringify(clash));
    ok('⑭ ⭐ 實跑:矛盾要用「但」講出來', /但大戶倒貨給散戶/.test(String(clash.bull)), String(clash.bull));
    ok('⑭ ⭐ 實跑:空頭時不可出現「放心做」',
       !/放心做/.test(String(clash.bear)), String(clash.bear));
    ok('⑭ ⛔ 多頭時維持原本的打氣話(別把正常情境弄壞)',
       /放心做/.test(String(clash.bull)), String(clash.bull));
    await b3.close();
}

console.log();
if (fails.length) { console.log('❌ VERDICT_CLASH_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ VERDICT_CLASH_TEST_PASS');
