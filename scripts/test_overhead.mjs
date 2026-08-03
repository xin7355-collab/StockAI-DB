// 🧪 上方套牢區(overhead supply)—— V71.8.7
// 使用者問:分析師說國巨壓力在 800 左右,這是籌碼看的還是 K 線?
// 答:K 線+成交量(套牢賣壓)。而我原本兩個限制讓它顯示不出來:
//   ① 前高只收 +15% 以內(國巨最近前高在 +46%,全被濾掉)
//   ② 量價密集區只挑單一最大格(國巨最大格是暴漲前的底部,在下方)
// 用**真的** gh-pages 2327 資料當測資。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import fs from 'fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };
const CACHE = '/tmp/k2327.json';
if (!fs.existsSync(CACHE)) execSync(`git -C /home/user/StockAI-DB show origin/gh-pages:data/2327.json > ${CACHE}`, { shell: '/bin/bash' });
const REAL = JSON.parse(fs.readFileSync(CACHE, 'utf8'));

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

const R = await pg.evaluate((real) => {
    const data = real.map(r => ({ ...r, close: +r.close, high: +r.high, low: +r.low, volume: +r.volume }));
    const last = data.length - 1, pC = data[last].close;
    app.currentSymbolId = '2327';
    app.settings = app.settings || {}; app.settings.feeDiscount = 0.28;
    app._dynExit = { t1: null, t2: null, def: pC * 0.92, pC };
    app._guardStash = {};
    return {
        pC,
        layers: app._overheadSupply(data, last, pC),
        zones: app._chuResistanceZones(data, last),
        up: app._upsideRoom(pC, data, last),
    };
}, REAL);
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
console.log(`   國巨現價 ${R.pC}`);
console.log('   套牢層:', JSON.stringify(R.layers.map(l => ({ 區間: `${Math.round(l.lo)}~${Math.round(l.hi)}`, 量佔比: +l.pct.toFixed(1), 距現價: +l.dist.toFixed(0) + '%' }))));
console.log('   前高壓力:', JSON.stringify(R.zones.map(z => ({ 價: z.price, 距: +z.distancePct.toFixed(0) + '%' }))));
console.log('   上檔清單:', JSON.stringify(R.up.list.map(x => x.n + ' ' + x.v.toFixed(0))));

ok('① 有抓到上方套牢層', R.layers.length >= 1, JSON.stringify(R.layers));
ok('② ⭐ 800 附近那一層有被抓到(分析師講的就是這個)',
   R.layers.some(l => l.lo <= 850 && l.hi >= 780), JSON.stringify(R.layers.map(l => [Math.round(l.lo), Math.round(l.hi)])));
ok('③ 每一層都在現價上方', R.layers.every(l => l.lo > R.pC), '');
ok('③ 由近到遠排序', R.layers.every((l, i) => i === 0 || l.lo >= R.layers[i - 1].lo), '');
ok('④ 有標「多少成交量卡在這」', R.layers.every(l => l.pct > 0), '');
ok('⑤ 放寬距離上限後,前高壓力不再是空的(舊的 15% 會全濾掉)',
   R.zones.length >= 1, JSON.stringify(R.zones));
ok('⑥ 套牢區有進到「上檔空間」單一真相源',
   R.up.list.some(x => x.n.includes('套牢區')), JSON.stringify(R.up.list.map(x => x.n)));
ok('⑦ 上檔清單仍由近到遠', R.up.list.every((x, i) => i === 0 || x.v >= R.up.list[i - 1].v), '');
ok('⑧ 每一道都有 % 與一張淨賺元', R.up.list.every(x => Number.isFinite(x.pct) && Number.isFinite(x.ntd)), '');

console.log();
if (fails.length) { console.log('❌ OVERHEAD_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ OVERHEAD_TEST_PASS');
