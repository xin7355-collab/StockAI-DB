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
    ok('⑦ ⭐ 主結論多頭時維持舊行為(⛔ 別把正常情境弄壞)',
       /可順勢做多/.test(strip2(R2.bull)), strip2(R2.bull).slice(0, 250));
    ok('⑧ ⭐ 主結論是**別檔**的 → 不可套用(切股殘留守門)',
       /可順勢做多/.test(strip2(R2.other)), strip2(R2.other).slice(0, 250));
    ok('⑨ 主結論還沒算出來 → 維持舊行為,不可 throw',
       typeof R2.none === 'string' && /可順勢做多/.test(strip2(R2.none)), String(R2.none).slice(0, 200));
    await b2.close();
}

console.log();
if (fails.length) { console.log('❌ VERDICT_CLASH_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ VERDICT_CLASH_TEST_PASS');
