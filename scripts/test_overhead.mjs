// 🧪 上方套牢區(overhead supply)—— V71.8.7
// 使用者問:分析師說國巨壓力在 800 左右,這是籌碼看的還是 K 線?
// 答:K 線+成交量(套牢賣壓)。而我原本兩個限制讓它顯示不出來:
//   ① 前高只收 +15% 以內(國巨最近前高在 +46%,全被濾掉)
//   ② 量價密集區只挑單一最大格(國巨最大格是暴漲前的底部,在下方)
// 用**真的** gh-pages 2327 資料當測資。
import { ghJsonOrDie } from './lib_ghdata.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import fs from 'fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };
// 🚨 V75.1.5:改走共用入口 —— 舊寫法的 `> CACHE` 在 git show 失敗時會留下 0 bytes 的快取檔,
//   而 `existsSync` 是 true → 之後每次都讀那個空檔、**永遠不會自己好**(壞快取被永久固化)。
const REAL = ghJsonOrDie('data/2327.json');

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
        // ── 🪤 V76.0.6 實測賠率 + 回填到總覽關鍵價位卡 ──
        edge: app._SUPPLY_EDGE,
        odds: { big: app._supplyOdds(8.8), mid: app._supplyOdds(5), small: app._supplyOdds(3), zero: app._supplyOdds(0) },
        html: app._upsideRoomHtml(app._upsideRoom(pC, data, last)),
        cell: (() => {
            // 真的跑一次 `_renderGuardRuler`(⛔ 不在測試裡複製一份回填邏輯)
            const mk = id => { let e = document.getElementById(id); if (!e) { e = document.createElement('div'); e.id = id; document.body.appendChild(e); } return e; };
            mk('guardRuler'); mk('upsideRoomCard');
            const ph = document.createElement('div'); ph.setAttribute('data-supplycell', '1'); ph.className = 'hidden'; document.body.appendChild(ph);
            app._renderGuardRuler(pC, data, last);
            const got = { on: !ph.classList.contains('hidden'), t: (ph.innerText || '').replace(/\s+/g, ' ') };
            // ⑨ 空過:stash 對不上現價(跨股殘留)→ 那一格必須整個不顯,⛔ 不可顯 `--`
            app._upsideStash = null;
            app._renderGuardRuler(pC, data.map(r => ({ ...r, volume: 0 })), last);
            got.offWhenNoLayer = ph.classList.contains('hidden') && !(ph.innerText || '').trim();
            return got;
        })(),
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


// ═══ 🪤 V76.0.6 上方套牢區的**實測賠率**(overhead_probe.mjs)═══
console.log('\n   回填那一格:', JSON.stringify(R.cell));
const E = R.edge;
ok('⑨ `_SUPPLY_EDGE` 三段齊全且**穿過去的機率單調遞減**(牆越大越不容易穿過去)',
   E && E.band.length === 3 && E.band.every((b, i) => i === 0 || b.thru < E.band[i - 1].thru),
   JSON.stringify(E && E.band.map(b => b.thru)));
ok('⑩ `_supplyOdds` 依「佔量 %」查得到對的那一段;0 回 null(⛔ 不假裝有成績)',
   R.odds.big.lbl === '大' && R.odds.mid.lbl === '中' && R.odds.small.lbl === '小' && R.odds.zero === null,
   JSON.stringify(R.odds));
ok('⑪ 上檔空間卡有寫出實測賠率,而且數字**來自 `_SUPPLY_EDGE`**(注入:把數字**寫死在文案裡** → 必紅。⛔ 注意「改常數」不是有效注入 —— 兩邊都讀同一個常數,那樣改只會一起變、照樣綠)',
   R.html.includes(`${R.odds.big.thru.toFixed(0)}% 穿過去`) && R.html.includes(`${R.odds.big.back.toFixed(0)}% 被壓回`),
   R.html.slice(-420));
ok('⑫ 🚨 那段文案**必須寫明不是賣出訊號 + 邊際比成本小**(⛔ 不可變成「彈到這就跑」)',
   /不是賣出訊號/.test(R.html) && /比來回成本/.test(R.html) && /把期待值放低/.test(R.html), '');
ok('⑬ ⛔ 文案不可出現賣出/進場**指令**詞',
   !/(就跑|該賣|停利出場|可以賣|建議賣出|放空|彈到這就)/.test(R.html), (R.html.match(/就跑|該賣|停利出場|可以賣|建議賣出|放空|彈到這就/) || [''])[0]);
{
    // ⭐ 這條是重點:關鍵價位那一格的區間 **必須等於** `_upsideRoom` 算出來的那一層
    //   (注入:在 _renderGuardRuler 裡自己呼叫一次 _overheadSupply 重算 → 數字會對不上 → 必紅)
    const z = R.up.list.filter(x => +x.sup > 0)[0];
    ok('⑭ ⭐⭐ 回填那一格的區間 = `_upsideRoom` 的同一層(⛔ 不可自己再算一份)',
       !!z && R.cell.on && R.cell.t.includes(`${Math.round(z.lo)}~${Math.round(z.hi)}`)
          && R.cell.t.includes(`${z.sup.toFixed(0)}% 的量卡在這`),
       `cell=${R.cell.t} / stash=${z ? Math.round(z.lo) + '~' + Math.round(z.hi) : 'none'}`);
}
ok('⑮ 沒有套牢層時那一格**整個不顯**(⛔ 不留空殼、⛔ 不顯 --)', R.cell.offWhenNoLayer === true, JSON.stringify(R.cell));

console.log();
if (fails.length) { console.log('❌ OVERHEAD_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ OVERHEAD_TEST_PASS');
