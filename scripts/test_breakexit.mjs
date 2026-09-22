// 🧪📢🚪 V77.4.6 「突破之後的出場」+ 到價監控出場快設 —— 守門
//
// ⛔ 這支釘的是**用意**不是字串:
//   ① `_breakoutState` 的基準⛔ 不含今天(陷阱 #43)—— 退回「含今天」在數學上不可能成立
//   ② `_breakoutExitHtml` **只轉述** `_BREAKOUT_EXIT_EDGE`,⛔ 不現算(不可出現 `_detect` / `_patternFitBacktest`)
//   ③ 出場快設的價位**來自 `_exitLines()`** —— 決定性對照:改 `_exitLines` 的回傳,鈕上的價位要跟著變
//   ④ 觸發價一律 `_floorTick`(無條件捨去)且條件是「跌到」(V76.2.9:停損要真的跌破才動作)
//   ⑤ 算不出來要**說出來**(⛔ 不可靜默空白,陷阱 #22)
//   ⑥ 數字⛔ 不可寫死在畫面上 —— 改常數,畫面要跟著變
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const url = pathToFileURL('/home/user/StockAI-DB/index.html').href;
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + JSON.stringify(x)}`); if (!c) fails.push(n); };

// ═══ 靜態:原始碼層 ═══
const SRC = fs.readFileSync('/home/user/StockAI-DB/index.html', 'utf8');
const body = (name) => {                     // 抓函式本體(⛔ 只比那一段,不要被頁面別處救活)
    const i = SRC.indexOf(`    ${name}(`);
    if (i < 0) return '';
    const j = SRC.indexOf('\n    },', i);
    return SRC.slice(i, j < 0 ? i + 4000 : j);
};
{
    const b = body('_breakoutExitHtml');
    ok('⑥s ⛔ `_breakoutExitHtml` 不可現算(不可呼叫偵測器/回測)',
        !!b && !/_detect[A-Z]|_patternFitBacktest\(|_calcBullBearScan\(|_sigEdge\(/.test(b), b.slice(0, 120));
    ok('⑥s2 它一定要讀 `_BREAKOUT_EXIT_EDGE`', /_BREAKOUT_EXIT_EDGE/.test(b));
    const q = body('_paQuickSetExit');
    ok('④s 出場快設一定用 `_floorTick`(⛔ 不可 `_roundTick`)', /_floorTick\(/.test(q) && !/_roundTick\(/.test(q), q);
    ok('④s2 條件一定是「跌到」lte', /_paCond\s*=\s*'lte'/.test(q), q);
    const l = body('_paExitList');
    ok('③s 出場快設的價位只讀 `_exitLines` 存下來的那份(⛔ 不自己算 MA/ATR)',
        /this\._paExit/.test(l) && !/_atrTR14\(|indicators\./.test(l), l);
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const out = {};
    const mk = arr => arr.map((c, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1000 }));

    // ── ① 一路走平 + 最後跳一根高的 → 今天就是突破 ──
    const flat = []; for (let i = 0; i < 300; i++) flat.push(100);
    flat.push(110);
    out.st = app._breakoutState(mk(flat));
    // ①b 決定性對照:一路走平**沒有**那一根 → 不可判成突破
    out.stNone = app._breakoutState(mk(flat.slice(0, 300)));

    // ② 常數自洽
    const B = app._BREAKOUT_EXIT_EDGE;
    out.B = { n: B.rows.length, ma5: B.rows.find(r => r.k === 'ma5'), don: B.rows.find(r => r.k === 'don'),
              horiz: B.horiz.map(h => h.v), volq: B.volq.map(v => v.e), med: B.med };

    // ③ 畫面轉述:數字要從常數來(改常數 → 畫面跟著變)
    const h1 = app._breakoutExitHtml(mk(flat));
    const keep = B.rows.find(r => r.k === 'ma5').vs;
    B.rows.find(r => r.k === 'ma5').vs = 9.87;
    const h2 = app._breakoutExitHtml(mk(flat));
    B.rows.find(r => r.k === 'ma5').vs = keep;
    //   🚨 斷言範圍要**只框住被改的那一塊** —— 「每一列」那段也印同一個數字,
    //      整份比對會被它救活(V77.4.6 注入驗證當場抓到的假綠燈)
    const slice = h => { const i = h.indexOf('一句話'); const j = h.indexOf('</div>', i); return i < 0 ? '' : h.slice(i, j); };
    out.h1has = /0\.03pp/.test(slice(h1));
    out.h2has = /9\.87pp/.test(slice(h2)) && !/0\.03pp/.test(slice(h2));
    out.h1len = h1.length;
    //   ⛔ 斷言⛔ 不可用 `||` 串 —— 底下的「限制」那行本來就有「倖存者偏誤」,
    //      用 `||` 會讓「把勝率/中位拿掉」的注入被它救活(CLAUDE.md `_ppTxt` 那條教訓)
    out.hasLimit = /勝率/.test(slice(h1)) && /中位/.test(slice(h1)) && /倖存者偏誤/.test(h1);

    // ④ 到價監控:出場快設讀 `_exitLines`(決定性對照 —— 覆寫成不可能巧合的數字)
    const realEL = app._exitLines;
    app._exitLines = () => ({ pC: 100, proxy: true, cost: null, shares: 0, buyDate: null, days: 20,
        peak: 111.11, atr: 2.22, don: 87.68, atr2: 76.54, trail8: 65.45, ma5: 54.36 });
    app._paCurrentSym = '2454';
    app._paExit = { sym: '2454', x: app._exitLines() };
    const lst = app._paExitList();
    out.lst = lst && lst.map(x => ({ k: x.k, v: x.v }));
    app._paPrice = 0; app._paCond = 'gte';
    app._renderPriceAlertModal = () => {};
    app._paQuickSetExit('don');
    out.pick = { price: app._paPrice, cond: app._paCond };
    out.tick = app._floorTick(87.68); out.rnd = app._roundTick(87.68);
    app._exitLines = realEL;

    // ⑤ 算不出來要說出來
    app._paExit = { sym: '2454', x: null };
    const row = app._renderPaSetTab();
    out.emptySaid = /算不出出場防守價/.test(row);
    app._paExit = null;
    const row2 = app._renderPaSetTab();
    out.loadingSaid = /正在算這檔的出場防守價/.test(row2);
    return out;
});

ok('① 一路走平 + 跳一根 → 判定為「今天突破」', R.st && R.st.today === true && R.st.n >= 20, R.st);
ok('①b ⭐ 決定性對照:一路走平(沒有那一根)⛔ 不可判成突破', R.stNone === null, R.stNone);
ok('② 常數 11 條出場規則', R.B.n === 11, R.B.n);
ok('②b 「跌破 5 日線」是最差的那一條(六關只過 1 關)', R.B.ma5.g === 1 && R.B.ma5.vs < 0.2, R.B.ma5);
ok('②c 預設「唐奇安 20 日」六關全過', R.B.don.g === 6 && R.B.don.vs > 1, R.B.don);
ok('②d 🧗 突破門檻越嚴優勢越大(單調遞增)',
    R.B.horiz.every((v, i, a) => i === 0 || v > a[i - 1]), R.B.horiz);
ok('②e 📊 量比門檻是平的(全距 < 0.1pp = 篩不到東西)',
    Math.max(...R.B.volq) - Math.min(...R.B.volq) < 0.1, R.B.volq);
ok('②f 🚨 中位數是負的(= 一半以上停損出場)', R.B.med < -1, R.B.med);
ok('③ 畫面印出常數裡的數字', R.h1has, R.h1len);
ok('③b ⭐ 決定性對照:改常數 → 畫面跟著變(⛔ 不可寫死)', R.h2has && !R.h1has === false, { h1: R.h1has, h2: R.h2has });
ok('③c 限制必須跟數字一起顯示:「一句話」那塊要有勝率+中位,整段要有倖存者偏誤(⛔ 三個都要,不可用 ||)', R.hasLimit);
ok('④ 出場快設四條都在,價位來自 `_exitLines`',
    R.lst && R.lst.length === 4 && R.lst.find(x => x.k === 'don').v === 87.68, R.lst);
ok('④b ⭐ 觸發價無條件捨去到跳動單位(87.68 → 87.6,⛔ 不是四捨五入的 87.7),條件 = 跌到',
    R.pick.price === R.tick && R.pick.price !== R.rnd && R.pick.cond === 'lte', { pick: R.pick, tick: R.tick, rnd: R.rnd });
ok('④c 🚧 這組測資真的分得出 floor 與 round(⛔ 否則上一條沒有鑑別力)', R.tick !== R.rnd, { tick: R.tick, rnd: R.rnd });
ok('⑤ 算不出來要說出來(⛔ 不可靜默空白)', R.emptySaid, R.emptySaid);
ok('⑤b 還在算的時候也要說', R.loadingSaid, R.loadingSaid);
ok('⑥ 無 pageerror', errs.length === 0, errs.slice(0, 2));

await b.close();
console.log(fails.length ? `\n❌ TEST_BREAKEXIT_FAIL ${fails.length} 條:\n  - ${fails.join('\n  - ')}` : '\n✅ TEST_BREAKEXIT_PASS');
process.exit(fails.length ? 1 : 0);
