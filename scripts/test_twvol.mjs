// 🧪 台股波動率(台指 VIX 拿不到時的替代)測試 V71.8.1
// 使用者已回報兩次「台指 VIX 沒有資料」→ 與其讓那格永遠空著,先給算得出來的替代品。
// ⛔ 但兩者不是同一個東西 → 名字必須不同(專案鐵則:不同公式不同名字)。
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
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const out = {};
    const mkHist = (dailyPct, n = 300) => {          // 每日固定振幅(正負交替)→ 已知波動率
        const h = []; let c = 40000;
        for (let i = 0; i < n; i++) { c *= (1 + (i % 2 ? -dailyPct : dailyPct) / 100); h.push({ close: c }); }
        return h;
    };
    // ① 平靜盤(每日 ±0.3%)vs 恐慌盤(每日 ±3%)→ 波動率要差一個量級
    app.usMacroCache = { twii_history: mkHist(0.3) };
    out.calm = app._twRealizedVol();
    app.usMacroCache = { twii_history: mkHist(3.0) };
    out.panic = app._twRealizedVol();
    // ② 先平靜 250 天、最後 20 天爆掉 → 位階要接近 100%
    const h = mkHist(0.3, 280).concat(mkHist(3.0, 25).map(x => ({ close: x.close })));
    app.usMacroCache = { twii_history: h };
    out.spike = app._twRealizedVol();
    // ③ 資料不足 → 回 null,不可 throw
    app.usMacroCache = { twii_history: mkHist(1, 10) };
    out.few = app._twRealizedVol();
    app.usMacroCache = {};
    out.none = app._twRealizedVol();

    // ④ 雷達:沒有台指 VIX 時,要用替代品且**名字不同**
    app.usMacroCache = { twii_history: mkHist(0.3, 300) };
    app._macroRiskCache = { vix: 16, fi_futures_net: -81017, tw_vix: null,
        tw_vix_error: 'tok2 金鑰有效但帳號等級不足' };
    app._riskHistCache = []; app._distDayCount = 1; app._d0050Close = 93.5;
    app._renderReboundRadar();
    out.noVix = document.getElementById('reboundRadarCard').innerText;
    out.noVixJudged = app._reboundVerdict;
    // 對照組:連加權日 K 都沒有 → 那條應該退回「⏳ 不計分」,計分條數要少 1
    const _keep = app.usMacroCache;
    app.usMacroCache = {};
    app._renderReboundRadar();
    out.noHistJudged = app._reboundVerdict;
    out.noHist = document.getElementById('reboundRadarCard').innerText;
    app.usMacroCache = _keep;
    app._renderReboundRadar();
    // ⑤ 有台指 VIX 時,要換回原本的名字與門檻
    app._macroRiskCache = { ...app._macroRiskCache, tw_vix: 22 };
    app._renderReboundRadar();
    out.hasVix = document.getElementById('reboundRadarCard').innerText;
    out.hasVixJudged = app._reboundVerdict;
    return out;
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
console.log(`   平靜 ${R.calm.vol.toFixed(1)}% ・恐慌 ${R.panic.vol.toFixed(1)}% ・爆量後位階 ${Math.round(R.spike.pct)}%`);
ok('① 平靜盤波動率低', R.calm.vol > 0 && R.calm.vol < 15, R.calm.vol.toFixed(2));
ok('① 恐慌盤波動率高很多(至少 5 倍)', R.panic.vol > R.calm.vol * 5, `${R.calm.vol.toFixed(1)} vs ${R.panic.vol.toFixed(1)}`);
ok('② 最近才爆掉 → 位階接近滿分(才抓得到「現在正在恐慌」)', R.spike.pct >= 90, String(Math.round(R.spike.pct)));
ok('③ 資料不足回 null 不 throw', R.few === null && R.none === null, `${R.few} / ${R.none}`);

ok('④ 沒有台指 VIX 時,那一格有數字(不再是「沒有資料」)',
   /台股波動率退燒[\s\S]{0,60}\d+\.\d%/.test(R.noVix), (R.noVix.match(/台股波動率退燒[\s\S]{0,80}/) || [])[0]);
ok('④ ⛔ 不可叫「台指 VIX」(不同公式必須不同名字)',
   R.noVix.includes('台股波動率退燒') && !R.noVix.includes('台指 VIX 退燒'), '');
ok('④ 要說清楚跟台指 VIX 的差別', R.noVix.includes('預期波動') && R.noVix.includes('已經發生的波動'), '');
// ⚠️ 拿掉 twii_history 會同時讓「站回 5 日線」也失去資料 → 差 2 條而不是 1 條,這是對的。
ok('④ 有數字後這條要**計分**(比「連日K都沒有」多算,不再是 ⏳)',
   R.noVixJudged.total > R.noHistJudged.total,
   `有日K ${R.noVixJudged.total} vs 無日K ${R.noHistJudged.total}`);
ok('④ 有數字時那一格不可以是 ⏳',
   !/台股波動率退燒[\s\S]{0,40}⏳/.test(R.noVix), (R.noVix.match(/台股波動率退燒[\s\S]{0,60}/) || [])[0]);
ok('④ 連日K都沒有時要誠實顯「不計分」,不可硬判',
   /台股波動率退燒[\s\S]{0,300}不計分/.test(R.noHist), (R.noHist.match(/台股波動率退燒[\s\S]{0,300}/) || [])[0]);
ok('⑤ 拿到真的台指 VIX 就換回原名與 30 門檻',
   R.hasVix.includes('台指 VIX 退燒') && !R.hasVix.includes('台股波動率退燒'), '');
ok('⑤ 換回去後條件總數不變(不會忽多忽少)',
   R.hasVixJudged.total === R.noVixJudged.total, `${R.noVixJudged.total} vs ${R.hasVixJudged.total}`);

console.log();
if (fails.length) { console.log('❌ TWVOL_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ TWVOL_TEST_PASS');
