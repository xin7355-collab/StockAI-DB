// 🧪 接刀階梯 + 兩條「沒有資料」的說明(V71.8.0)
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
    // 造 300 根加權:從 43,600 一路跌到 40,270(對應使用者當下的盤)
    const hist = [];
    for (let i = 0; i < 300; i++) {
        const c = i < 250 ? 38000 + i * 22 : 43600 - (i - 250) * 66;
        hist.push({ close: c });
    }
    app.usMacroCache = { twii_history: hist };
    app._d0050Close = 93.5;
    const L = app._dipLadder();
    const html = app._dipLadderHtml();

    // 兩條「沒資料」的說明
    app._macroRiskCache = {
        vix: 16, fi_futures_net: -81017,
        taifex_backwardation: null,
        taifex_backwardation_error: '期貨(2026-07-31)與現貨(2026-07-30)不同交易日,不計價差',
        tw_vix: null,
        tw_vix_error: 'tok2 金鑰有效但帳號等級不足(免費層無此資料集)',
    };
    app._riskHistCache = []; app._distDayCount = 1;
    app._renderReboundRadar();
    const txt = document.getElementById('reboundRadarCard').innerText;
    // 有值時要顯示兩條腿
    app._macroRiskCache = { ...app._macroRiskCache, taifex_backwardation: 231, taifex_near: 40270, taiex_close: 40039 };
    app._renderReboundRadar();
    const txt2 = document.getElementById('reboundRadarCard').innerText;
    return { L, html, txt, txt2 };
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
const L = R.L;
console.log('   階梯:', JSON.stringify(L.steps.map(s => ({ n: s.n, v: Math.round(s.v), pct: +s.pct.toFixed(1), etf: s.etf && +s.etf.toFixed(1) }))));
ok('① 有算出階梯', L && L.steps.length >= 2, JSON.stringify(L && L.steps.length));
ok('① 每一檔都在現價下方(不能列上方的)', L.steps.every(s => s.v < L.now), String(L.now));
ok('① 由近到遠排序(先碰到的在上)', L.steps.every((s, i) => i === 0 || s.v <= L.steps[i - 1].v), '');
ok('② 有千點整數關(分析師講的「4 萬點」就是這種)', L.steps.some(s => s.v % 1000 === 0), JSON.stringify(L.steps.map(s => s.v)));
// ⚠️ 年線只有在「現價還在年線之上」時才會是接刀檔位;跌破年線後它變成上方壓力 → 不該出現。
//    這組測資正是跌破年線的情境,所以改成檢查「一定要有回檔門檻那兩檔」把階梯撐住。
ok('② 跌破年線時不可誤列年線(那是壓力不是接刀點)', !L.steps.some(s => s.n.includes('年線')), JSON.stringify(L.steps.map(s => s.n)));
ok('② 一定有「高點回檔 15%/20%」把階梯撐住(不會只剩一格)',
   L.steps.filter(s => s.n.includes('回檔')).length >= 1 && L.steps.length >= 3,
   JSON.stringify(L.steps.map(s => s.n)));
ok('② 最多列 4 檔(不爆炸)', L.steps.length <= 4, String(L.steps.length));
ok('③ 距現在 % 是負的(還要再跌)', L.steps.every(s => s.pct < 0), JSON.stringify(L.steps.map(s => +s.pct.toFixed(1))));
ok('③ 有「從一年高點回檔幾%」', L.steps.every(s => s.ddHi < 0), JSON.stringify(L.steps.map(s => +s.ddHi.toFixed(1))));
ok('④ 0050 換算價 + 一張多少錢都有(使用者要實際金額)',
   L.steps.every(s => s.etf > 0 && s.lot > 0) && R.html.includes('一張'), JSON.stringify(L.steps.map(s => s.lot)));
ok('④ 金額有千分位逗號', /一張 \d{2,3},\d{3} 元/.test(R.html), (R.html.match(/一張 [\d,]+ 元/g) || []).slice(0, 2).join(' '));
ok('⑤ 明講「不是預測低點」', R.html.includes('先設價位') && R.html.includes('分批'), '');
ok('⑤ 誠實揭露 0050 是換算值非報價', R.html.includes('換算的約略值'), '');
ok('⑥ 階梯有掛進反攻雷達卡(不另開新卡)', R.txt.includes('跌到哪裡才敢買'), R.txt.slice(0, 120));

ok('⑦ 價差沒資料時要講原因,不是只顯「沒有資料」',
   R.txt.includes('不是同一天的收盤') || R.txt.includes('不同交易日'), (R.txt.match(/價差翻正[\s\S]{0,120}/) || [])[0]);
ok('⑦ 並說明「不計分、不影響其他判斷」', /價差翻正[\s\S]{0,400}不計分/.test(R.txt), (R.txt.match(/價差翻正[\s\S]{0,400}/) || [])[0]);
ok('⑧ 台指 VIX 沒資料時要講「已改抓官方免費源」而不是「維護中」',
   R.txt.includes('期交所公開資料') && !R.txt.includes('資料源維護中'), (R.txt.match(/台指 VIX[\s\S]{0,160}/) || [])[0]);
ok('⑧ 要提供美股 VIX 當替代', /台指 VIX[\s\S]{0,200}美股 VIX/.test(R.txt), '');
ok('⑨ 價差有值時要一併顯示兩條腿(期 vs 現)',
   R.txt2.includes('期 40,270') && R.txt2.includes('現 40,039'), (R.txt2.match(/價差翻正[\s\S]{0,160}/) || [])[0]);

console.log();
if (fails.length) { console.log('❌ DIPLADDER_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ DIPLADDER_TEST_PASS');
