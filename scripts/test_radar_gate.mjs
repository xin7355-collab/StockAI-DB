// 🧪 反攻雷達「要幾條才算過」測試(V71.7.7)
// 使用者問:「7/10 何時才是反攻,要等到 10/10 嗎?」→ 卡上必須自己講清楚門檻。
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
  const ec = new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) });
  Object.defineProperty(window, 'echarts', { value: ec, writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|blocked by CORS|Cross origin|navigator\.vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

// 造一組「7 過 / 3 沒過」的資料,對應使用者截圖
const res = await pg.evaluate(() => {
    const mk = (over) => {
        // VIX 低(過)、台幣續貶(不過)、韓股翻紅(過)、外資期貨續加空(不過)、
        // 油價穩(過)、日圓穩(過)、跌破5MA(不過)、價差正(過)、量能過兆(過)、派發少(過)
        app._macroRiskCache = {
            vix: 17.1, sp500_chg_pct: 0.5, usdtwd_chg_5d: 0.36, usdtwd: 29.9,
            kospi_chg_pct: 1.2, nikkei_chg_pct: 0.4, wti_chg_pct: 0.5, jpy_chg_3d: -0.2,
            taifex_backwardation: 12, tw_vix: 22, fi_futures_net: -81017, fear_greed: 30,
            updated: '2026-07-31',
        };
        app.usMacroCache = { twii_history: Array.from({ length: 70 }, (_, i) => ({ close: 40000 - i * 5 })) };
        app._riskHistCache = Array.from({ length: 25 }, (_, i) => ({
            fi_futures_net: -75000 - i * 250, margin_100m: 4000 - i,
        }));
        app._distDayCount = 1;
        app._bubbleCache = { margin_leverage: { total_100m: 4000 } };
    };
    mk();
    app._renderReboundRadar();
    const el = document.getElementById('reboundRadarCard');
    return { html: el.innerHTML, txt: el.innerText, v: app._reboundVerdict };
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
const v = res.v;
console.log(`   → 判定 ${v.icon} ${v.txt} ${v.passN}/${v.total}`);
const need = Math.max(6, v.total - 2);
ok('① 卡上明確標出「進場門檻 N/M」', res.txt.includes(`進場門檻 ${need}/${v.total}`), res.txt.slice(0, 200));
ok('② 門檻不是全亮(M 條時門檻 = M−2,至少 6)', need < v.total, `need=${need} total=${v.total}`);
if (v.passN >= Math.ceil(v.total / 2) && v.passN < need) {
    ok('③ 打底觀察中要講「再亮 X 條就翻」', /再亮 \d+ 條/.test(res.txt), res.txt.slice(0, 400));
    ok('③ 要明講「不用等全亮」', res.txt.includes('不用等全亮'), res.txt.slice(0, 400));
    ok('③ 缺的條件要全列(不再只列前 3 條)',
        (res.txt.match(/缺:([^→]*)/) || ['', ''])[1].split('、').length === (v.total - v.passN),
        (res.txt.match(/缺:([^→]*)/) || [])[1]);
}
ok('④ 教學文也要寫門檻', res.html.includes(`${need}/${v.total}=反攻條件成形`), '');
ok('⑤ 教學 alert 的引號沒把 onclick 打斷(能 parse 出按鈕)', res.html.includes('📖 教學'));

console.log();
if (fails.length) { console.log('❌ RADAR_GATE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ RADAR_GATE_TEST_PASS');
