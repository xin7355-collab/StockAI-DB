// 🧪 加權/櫃買指數專用版面(V71.8.2)
// 使用者:「加權指數應該要簡化裡面資訊,用符合加權在看的東西」
// 原本 ^TWII 沿用個股版面 → 寫「這檔在盤整,先等它表態」「帶量突破前高→買進」「停損防守」,
// 但**指數不能買**,那些指令對它沒意義而且會誤導。
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
    // 造 300 根加權日K:一年高 43600 → 現價 40270(回檔 7.6%)
    const data = [];
    for (let i = 0; i < 300; i++) {
        const c = i < 250 ? 38000 + i * 22.4 : 43600 - (i - 250) * 66.6;
        data.push({ date: '2026/07/31', open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1000 });
    }
    const last = data.length - 1;
    const ma = n => data.map((_, i) => i < n - 1 ? null : data.slice(i - n + 1, i + 1).reduce((a, r) => a + r.close, 0) / n);
    const ind = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
    app.usMacroCache = { twii_history: data.map(r => ({ close: r.close })) };
    app._macroRiskCache = { fi_spot_net: -222.5, fi_futures_net: -81017, vix: 16 };
    app._riskHistCache = [];
    app._reboundVerdict = { icon: '⚠️', txt: '打底觀察中', passN: 7, total: 10 };

    const out = {};
    // ── 指數 ──
    app.currentSymbolId = '^TWII';
    app._renderTrendCommand(data, ind, last);
    app._syncIndexSubTabs(); app.switchOvTab('now', { auto: true });
    const box = document.getElementById('trendCommandCard');
    out.idxTxt = box.innerText;
    out.idxHidden = box.classList.contains('hidden');
    out.tabsHidden = ['entry', 'exit'].map(k => document.querySelector(`[data-ovtab="${k}"]`)?.classList.contains('hidden'));
    // V71.8.3:即時也藏(報價商只給個股逐筆/五檔,指數永遠拿不到,不是暫時故障)
    out.subHidden = ['Corp', 'DayTrade', 'Backtest', 'Live'].map(t => document.getElementById(`subTabBtn${t}`)?.classList.contains('hidden'));
    out.subShown = ['Strategy', 'Chart', 'Chip', 'BullBear'].map(t => document.getElementById(`subTabBtn${t}`)?.classList.contains('hidden'));
    // 籌碼:指數只留「籌碼進出」(三大法人),券商分點/籌碼分佈藏起來
    app.switchChipTab('broker');
    out.chipTab = app._activeChipTab;
    out.chipBtnHidden = ['broker', 'dist'].map(k => document.getElementById('chipTabBtn-' + k)?.classList.contains('hidden'));
    out.chipFlowShown = document.getElementById('chipTabBtn-flow')?.classList.contains('hidden');
    // 多空:命中太少不可給「多方 100%」
    const few = { sym: '^TWII', rules: [], cats: { chip: { bull:0,bear:0,rules:[] }, price: { bull:0,bear:0,rules:[] }, fund: { bull:0,bear:0,rules:[] }, tech: { bull:0,bear:0,rules:[] } } };
    out.lowSample = (() => {
        const scan = app._bullBearScan ? null : null;
        return null;
    })();
    // 指數點到被藏的分頁 → 要導回總覽
    app.switchSubTab('corp');
    out.redirected = app._activeSubTab;
    // ── 換回個股:一切要復原 ──
    app.currentSymbolId = '2330';
    app._renderTrendCommand(data, ind, last);
    app._syncIndexSubTabs(); app.switchOvTab('now', { auto: true });
    out.stockTxt = document.getElementById('trendCommandCard').innerText;
    out.tabsBack = ['entry', 'exit'].map(k => document.querySelector(`[data-ovtab="${k}"]`)?.classList.contains('hidden'));
    out.subBack = ['Corp', 'DayTrade', 'Backtest', 'Live'].map(t => document.getElementById(`subTabBtn${t}`)?.classList.contains('hidden'));
    app.switchChipTab('broker');
    out.chipBack = ['broker', 'flow', 'dist'].map(k => document.getElementById('chipTabBtn-' + k)?.classList.contains('hidden'));
    out.chipTabBack = app._activeChipTab;
    return out;
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
console.log('   指數卡開頭:', R.idxTxt.split('\n').slice(0, 4).join(' / '));
ok('① 指數卡有顯示', !R.idxHidden, '');
ok('① 標題是「加權指數・現在什麼位置」', R.idxTxt.includes('加權指數・現在什麼位置'), R.idxTxt.slice(0, 60));
ok('② ⛔ 不可出現個股的買賣指令(指數不能買)',
   !/先等它表態|帶量突破前高|停損防守|這檔不做|買進參考|掛單就看這/.test(R.idxTxt),
   (R.idxTxt.match(/先等它表態|帶量突破前高|停損防守|這檔不做|買進參考|掛單就看這/g) || []).join(','));
ok('② ⛔ 卡上不可出現「這檔」這種個股講法', !R.idxTxt.includes('這檔'), '');
ok('③ 要有指數該看的:一年位階', R.idxTxt.includes('一年位階'), '');
ok('③ 要有年線', R.idxTxt.includes('年線'), '');
ok('③ 要有月線/季線', R.idxTxt.includes('月線') && R.idxTxt.includes('季線'), '');
ok('③ 要有外資', R.idxTxt.includes('外資'), '');
ok('④ 要引用反攻雷達的中期結論(不自己再算一份)',
   R.idxTxt.includes('打底觀察中') && R.idxTxt.includes('7/10'), (R.idxTxt.match(/中期[\s\S]{0,60}/) || [])[0]);
ok('⑤ 要白話講「指數不能直接買,要買就買 0050」',
   R.idxTxt.includes('指數不能直接買') && R.idxTxt.includes('0050'), '');
ok('⑤ 要註明刻意不給買賣價位', R.idxTxt.includes('不給買賣價位'), '');
ok('⑥ 進場/出場頁籤要藏起來', R.tabsHidden.every(v => v === true), JSON.stringify(R.tabsHidden));
ok('⑥ 基本/當沖/回測/即時分頁要藏起來', R.subHidden.every(v => v === true), JSON.stringify(R.subHidden));
ok('⑥ 總覽/K線/籌碼/多空要留著', R.subShown.every(v => v === false), JSON.stringify(R.subShown));
ok('⑧ 籌碼:點券商分點要被導到「籌碼進出」(指數沒有分點)', R.chipTab === 'flow', String(R.chipTab));
ok('⑧ 籌碼:券商分點/籌碼分佈按鈕藏起來', R.chipBtnHidden.every(v => v === true), JSON.stringify(R.chipBtnHidden));
ok('⑧ 籌碼:籌碼進出要留著(三大法人是大盤該看的)', R.chipFlowShown === false, String(R.chipFlowShown));
ok('⑥ 點到被藏的分頁要導回總覽', R.redirected === 'strategy', String(R.redirected));
ok('⑦ 換回個股:恢復個股版面(有買賣指令)',
   /買進|停損|掛單|表態|進場/.test(R.stockTxt) && !R.stockTxt.includes('現在什麼位置'), R.stockTxt.slice(0, 80));
ok('⑦ 換回個股:進場/出場頁籤要回來', R.tabsBack.every(v => v === false), JSON.stringify(R.tabsBack));
ok('⑦ 換回個股:基本/當沖/回測/即時要回來', R.subBack.every(v => v === false), JSON.stringify(R.subBack));
ok('⑦ 換回個股:三個籌碼分頁都要回來', R.chipBack.every(v => v === false), JSON.stringify(R.chipBack));
ok('⑦ 換回個股:券商分點點得進去', R.chipTabBack === 'broker', String(R.chipTabBack));

console.log();
if (fails.length) { console.log('❌ INDEXPAGE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ INDEXPAGE_TEST_PASS');
