// 🧪「兩張卡下相反指令」防呆(V71.7.7)
// 使用者截圖:分析師盤勢解讀寫「偏多格局,可偏多操作」,同畫面反攻雷達寫「打底觀察中 7/10」、
// 跑馬燈寫「多頭轉弱」。→ 違反「邏輯不打架 / 單一劇本原則」。
// 規則:中期(反攻雷達)沒過門檻時,短線技術分數再高也不准下加碼指令。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
const url = pathToFileURL('/home/user/StockAI-DB/index.html').href;
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

console.log();
if (fails.length) { console.log('❌ VERDICT_CLASH_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ VERDICT_CLASH_TEST_PASS');
