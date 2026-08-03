// 🧪 「這個勝率是不是運氣?」二項式檢定(V71.8.6)
// 來源:使用者提供的多代理分析包提到穩健性檢定 —— 那包多數東西我已經有,
// 但「幾次才算數」確實是我原本的缺口(原本只寫「樣本少,勝率別當真」)。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
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
const benign = t => /Failed to load resource|net::ERR_|ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(pathToFileURL('/home/user/StockAI-DB/index.html').href, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => ({
    // 已知數學值:P(X>=k | n, 0.5)
    p_5_10:   app._winRateP(5, 10),      // 對稱點,應 > 0.5
    p_8_10:   app._winRateP(8, 10),      // = 56/1024 ≈ 0.0547
    p_10_10:  app._winRateP(10, 10),     // = 1/1024 ≈ 0.000977
    p_0_10:   app._winRateP(0, 10),      // = 1(全部都算進去)
    p_27_40:  app._winRateP(27, 40),     // ≈ 0.0192
    p_8_12:   app._winRateP(8, 12),      // ≈ 0.1938
    bad:      [app._winRateP(-1, 10), app._winRateP(11, 10), app._winRateP(5, 0), app._winRateP('x', 'y')],
    big:      app._winRateP(300, 500),   // 大 n 不可溢位/回 NaN
    c_small:  app._winRateConfidence(67, 6),
    c_weak:   app._winRateConfidence(67, 12),
    c_strong: app._winRateConfidence(68, 40),
    c_coin:   app._winRateConfidence(52, 50),
}));
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
console.log(`   P(≥8/10)=${R.p_8_10.toFixed(4)} ・P(≥10/10)=${R.p_10_10.toFixed(6)} ・P(≥27/40)=${R.p_27_40.toFixed(4)} ・P(≥8/12)=${R.p_8_12.toFixed(4)}`);
ok('① 8/10 的機率 ≈ 0.0547(課本值)', Math.abs(R.p_8_10 - 56 / 1024) < 1e-9, String(R.p_8_10));
ok('① 10/10 的機率 ≈ 1/1024', Math.abs(R.p_10_10 - 1 / 1024) < 1e-9, String(R.p_10_10));
ok('① 0/10 的機率 = 1(全部都 ≥0)', Math.abs(R.p_0_10 - 1) < 1e-9, String(R.p_0_10));
ok('① 5/10 應該 > 0.5(對稱點含自己)', R.p_5_10 > 0.5, String(R.p_5_10));
ok('② 大樣本不溢位也不是 NaN(300/500 ≈ 4.5e-6)', R.big > 0 && R.big < 1e-4 && isFinite(R.big), String(R.big));
ok('③ 壞輸入一律回 null 不 throw', R.bad.every(v => v === null), JSON.stringify(R.bad));

ok('④ 樣本 <10 一律說「還不能當結論」', R.c_small.ok === false && R.c_small.txt.includes('還不能當結論'), JSON.stringify(R.c_small));
ok('④ 12 次 67% → ⚠️ 參考就好(p≈19%)', R.c_weak.ok === null && R.c_weak.icon === '⚠️', JSON.stringify(R.c_weak));
ok('④ 40 次 68% → ✅ 站得住腳(p≈1.9%)', R.c_strong.ok === true && R.c_strong.icon === '✅', JSON.stringify(R.c_strong));
ok('④ 50 次 52% → ⛔ 跟丟銅板差不多', R.c_coin.ok === false && R.c_coin.icon === '⛔', JSON.stringify(R.c_coin));
ok('⑤ 要誠實揭露「非保證、未計交易成本」', R.c_strong.txt.includes('未計交易成本'), R.c_strong.txt);

console.log();
if (fails.length) { console.log('❌ WINRATE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ WINRATE_TEST_PASS');
