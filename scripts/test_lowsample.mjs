// 🧪 「樣本太少不給方向」(V71.8.3)
// 使用者截圖:加權指數的多空頁顯「多方 1 項・1 分 / 0 項 空方 → 多方優勢 100%」,
// 而同一畫面總覽寫「高檔回檔中」、六脈寫「0/5 訊號不足」→ 三個結論打架,
// 而且那個 100% 完全是「1÷1」算出來的假信心。
// ⚠️ 這不只影響指數:任何籌碼/基本面資料不全的冷門股都會踩到。
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
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const out = {};

    // ── 六脈:量能沒資料(volume 全 0,加權指數就是這樣)不可被當成「條件沒過」──
    const mk = (n, withVol) => {
        const d = [];
        let c = 100;
        for (let i = 0; i < n; i++) { c *= 1.004; d.push({ date: '2026/07/31', open: c * 0.998, high: c * 1.004, low: c * 0.996, close: c, volume: withVol ? 5000 : 0, foreign_net: 0 }); }
        return d;
    };
    out.noVol = app._sixMeridianCalc(mk(120, false));
    out.withVol = app._sixMeridianCalc(mk(120, true));

    // ── 多空:呼叫**真的** _calcBullBearScan,⛔ 不在測試裡複製一份判定邏輯
    //   (複製 = 又生出第二份真相,程式改了測試還是綠的)
    const flat = (n) => {                       // 幾乎沒有波動的資料 → 命中規則極少
        const d = [];
        for (let i = 0; i < n; i++) d.push({ date: '2026/07/31', open: 100, high: 100.05, low: 99.95, close: 100, volume: 0, foreign_net: 0 });
        return d;
    };
    const trend = (n) => {                      // 強多頭 + 有量 + 外資買 → 命中很多
        const d = []; let c = 60;
        for (let i = 0; i < n; i++) { c *= 1.008; d.push({ date: '2026/07/31', open: c * 0.995, high: c * 1.01, low: c * 0.99, close: c, volume: 8000 + i * 60, foreign_net: 900000 }); }
        return d;
    };
    const scanWith = (rows, sym) => { app.activeData = rows; app.currentSymbolId = sym; return app._calcBullBearScan(sym); };
    out.bb = {
        few:    scanWith(flat(140), '2330'),
        fewIdx: scanWith(flat(140), '^TWII'),
        many:   scanWith(trend(140), '2330'),
    };
    return out;
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
const nv = R.noVol, wv = R.withVol;
console.log('   無量:', JSON.stringify({ okN: nv.okN, applicable: nv.applicable, verdict: nv.verdict }));
console.log('   有量:', JSON.stringify({ okN: wv.okN, applicable: wv.applicable, verdict: wv.verdict }));
ok('① 沒有成交量時,量能那條標成 na(不算失分)',
   nv.cond.find(c => c.k === '量能')?.na === true, JSON.stringify(nv.cond.find(c => c.k === '量能')));
ok('① 有成交量時,量能那條要正常計分', wv.cond.find(c => c.k === '量能')?.na !== true, '');
ok('② 沒有分點時,籌碼那條也標 na', nv.cond.find(c => c.k === '籌碼')?.na === true, '');
ok('③ 分母要用「算得出來的條件數」,不可寫死 5',
   nv.applicable === 3 && wv.applicable === 4, `無量 ${nv.applicable} / 有量 ${wv.applicable}`);
ok('③ 結論字串的分母要跟著變(加權指數不再是「?/5」)',
   nv.verdict.includes(`/${nv.applicable}`) && !nv.verdict.includes('/5'), nv.verdict);
ok('④ 同一份走勢,少了量能那條不可讓結論變差(門檻要跟著縮)',
   nv.okN === wv.okN, `無量 okN=${nv.okN} / 有量 okN=${wv.okN}`);
console.log();
console.log('   多空(真函式):', JSON.stringify({
    few: R.bb.few && { v: R.bb.few.verdict, hits: R.bb.few.hits, low: R.bb.few.lowSample },
    many: R.bb.many && { v: R.bb.many.verdict, hits: R.bb.many.hits, low: R.bb.many.lowSample } }));
ok('⑤ 多空:只命中 1 條時⛔ 不可判「多方優勢」', R.bb.few.verdict === '訊號不足', JSON.stringify(R.bb.few));
ok('⑤ 多空:要標 lowSample 讓顯示層知道別秀百分比', R.bb.few.lowSample === true, '');
ok('⑤ 多空:要講清楚命中幾條、門檻幾條', /只命中 1 條/.test(R.bb.few.oneLiner) && /至少要 4 條/.test(R.bb.few.oneLiner), R.bb.few.oneLiner);
ok('⑤ 多空:指數要額外說明「本來就只有技術面會亮」',
   R.bb.fewIdx.oneLiner.includes('指數沒有籌碼/基本面資料'), R.bb.fewIdx.oneLiner);
ok('⑥ 多空:命中夠多時要照常判方向(不可矯枉過正)',
   ['多方優勢', '空方優勢', '均衡拉鋸'].includes(R.bb.many.verdict), JSON.stringify(R.bb.many.verdict));
ok('⑥ 多空:命中夠多時 lowSample 要是 false', R.bb.many.lowSample === false, String(R.bb.many.lowSample));
ok('⑥ 多空:命中夠多時 hits 要 ≥4', R.bb.many.hits >= 4, String(R.bb.many.hits));

console.log();
if (fails.length) { console.log('❌ LOWSAMPLE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ LOWSAMPLE_TEST_PASS');
