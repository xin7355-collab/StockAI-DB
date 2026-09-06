// 🔧 V67.5 runtime 煙霧測試 — 用 headless Chromium 真的載入 index.html,
// 抓 node --check 抓不到的執行期 bug(如批5 那種 literal `$1` ReferenceError)。
// 跑法:node scripts/smoke_test.mjs   (需環境內建 playwright global + /opt/pw-browsers)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const htmlPath = resolve(process.cwd(), 'index.html');
const url = pathToFileURL(htmlPath).href;

const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();

// echarts CDN 在沙盒可能被擋 → 注入萬用 stub(chainable no-op),
// 讓 app init 能跑完,測試離線可重現且聚焦「我的程式」而非 CDN。
await page.addInitScript(() => {
  const noop = () => inst;
  const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
  const ec = new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) });
  Object.defineProperty(window, 'echarts', { value: ec, writable: true, configurable: true });
});

// 忽略我們刻意 abort 的外部資料請求造成的資源載入失敗(非程式 bug)
// file:// 下 data JSON fetch 會被 CORS 擋、vibrate/feature 也是瀏覽器政策噪音 → 全非程式 bug
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|blocked by CORS|Cross origin requests|navigator\.vibrate|chromestatus\.com|Access to fetch/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errors.push('pageerror: ' + t); });
page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!benign(t)) errors.push('console.error: ' + t); } });

// 只擋 data JSON / 即時報價這類外部資料請求(離線也能跑、且不卡逾時),
// 但放行 CDN(echarts / tailwind)——app init 需要 echarts,擋掉會假失敗。
await page.route('**/*', route => {
  const u = route.request().url();
  if (u.startsWith('file://')) return route.continue();
  if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return route.continue();
  return route.abort();
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2500); // 讓 CDN + inline script + app init 跑完

// 1) app 有沒有 init(app 是 top-level const,非 window 屬性 → 用裸識別字取)
const appOk = await page.evaluate(() => typeof app === 'object' && !!app && typeof app._detectVCP === 'function');

// 2) 直接用合成 K 線資料狂打所有偵測器 + 關鍵渲染函式,確認執行期不 throw
const detectorReport = await page.evaluate(() => {
  if (typeof app !== 'object' || !app) return { fatal: 'no app object' };
  // 造 260 根合成日 K(帶趨勢+雜訊),欄位齊全
  const data = [];
  let base = 50;
  for (let i = 0; i < 260; i++) {
    base += Math.sin(i / 9) * 0.8 + (i > 180 ? 0.15 : -0.02);
    const o = base + Math.sin(i) * 0.3;
    const c = base + Math.cos(i) * 0.3;
    const hi = Math.max(o, c) + 0.6, lo = Math.min(o, c) - 0.6;
    const vol = Math.round(8000 + Math.abs(Math.sin(i / 4)) * 12000);
    const d = new Date(2025, 0, 1); d.setDate(d.getDate() + i);
    data.push({
      date: d.toISOString().slice(0, 10),
      open: +o.toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2),
      close: +c.toFixed(2), volume: vol, foreign_net: (i % 3 - 1) * 500,
    });
  }
  const fails = [];
  const detectors = Object.getOwnPropertyNames(Object.getPrototypeOf(app) || {})
    .concat(Object.keys(app))
    .filter(k => /^_detect/.test(k) && typeof app[k] === 'function');
  const seen = new Set();
  for (const fn of detectors) {
    if (seen.has(fn)) continue; seen.add(fn);
    try { app[fn](data); } catch (e) { fails.push(fn + ': ' + (e.message || e)); }
  }
  return { detectorCount: seen.size, fails };
});

// 3) 呼叫「批5 $1 bug 現場」那類 render 函式,只抓 ReferenceError(未定義變數=$1 那種)
//    資料/DOM 缺造成的 TypeError 不算(正常防呆),只揪 ReferenceError/SyntaxError。
const renderReport = await page.evaluate(() => {
  if (typeof app !== 'object' || !app) return { fails: [] };
  const targets = ['renderMarketRegime', 'renderMarketBreadth', 'renderVolSurgeRadar',
    'renderMarketBreadthCard', '_marketRegime', 'renderTradeJournal', 'renderFavList'];
  const fails = [];
  for (const fn of targets) {
    if (typeof app[fn] !== 'function') continue;
    try { app[fn](); }
    catch (e) { if (e instanceof ReferenceError || e instanceof SyntaxError) fails.push(fn + ': ' + e.message); }
  }
  return { fails };
});

let ok = true;
if (renderReport.fails.length) {
  ok = false;
  console.log('❌ render 函式 ReferenceError:');
  renderReport.fails.forEach(f => console.log('   ', f));
} else console.log('render 函式無 ReferenceError($1 類 bug)');
console.log('window.app init:', appOk ? 'OK' : '❌ FAIL');
if (!appOk) ok = false;
if (detectorReport.fatal) { console.log('❌', detectorReport.fatal); ok = false; }
else {
  console.log('偵測器測試:', detectorReport.detectorCount, '個');
  if (detectorReport.fails.length) {
    ok = false;
    console.log('❌ 偵測器 throw:');
    detectorReport.fails.forEach(f => console.log('   ', f));
  } else console.log('偵測器全部 OK(無 throw)');
}
if (errors.length) {
  ok = false;
  console.log('❌ 執行期錯誤:');
  errors.forEach(e => console.log('   ', e));
} else console.log('無 pageerror / console.error');

await browser.close();
console.log(ok ? '\n✅ SMOKE_TEST_PASS' : '\n❌ SMOKE_TEST_FAIL');
process.exit(ok ? 0 : 1);
