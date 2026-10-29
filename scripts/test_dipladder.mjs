// 🧪 反攻條件雷達(V71.8.0 兩條「沒有資料」的說明)+ V79.9.8 只描述・拿掉接刀階梯・空頭守門那一行・價差標日期
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
    // 造 300 根加權(帶日期):從 43,600 一路跌到 40,270
    const hist = [];
    const d0 = new Date('2025-08-01T00:00:00Z');
    for (let i = 0; i < 300; i++) {
        const c = i < 250 ? 38000 + i * 22 : 43600 - (i - 250) * 66;
        const d = new Date(d0.getTime() + i * 86400000).toISOString().slice(0, 10);
        hist.push({ date: d, close: c });
    }
    const lastD = hist[hist.length - 1].date;
    app.usMacroCache = { twii_history: hist };

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
    const card = () => document.getElementById('reboundRadarCard');
    const txt = card().innerText, html = card().innerHTML;
    const bearEl = card().querySelector('[data-bear60]');
    const bear = { attr: bearEl ? bearEl.getAttribute('data-bear60') : null, t: bearEl ? bearEl.innerText : '', want: app._bear60Of(hist) };
    // 有值時要顯示兩條腿;價差日期比加權那根舊 → 標日期
    const prevD = hist[hist.length - 2].date;
    app._macroRiskCache = { ...app._macroRiskCache, taifex_backwardation: 231, taifex_near: 40270, taiex_close: 40039, taifex_fut_date: prevD, taiex_date: prevD };
    app._renderReboundRadar();
    const txt2 = card().innerText, bwOld = card().querySelector('[data-bwdate]') ? card().querySelector('[data-bwdate]').getAttribute('data-bwdate') : null;
    // 決定性對照:同一天 → ⛔ 標日期
    app._macroRiskCache = { ...app._macroRiskCache, taifex_fut_date: lastD, taiex_date: lastD };
    app._renderReboundRadar();
    const bwSame = !!card().querySelector('[data-bwdate]');
    // 決定性對照:把加權改成多頭(一路漲)→ 空頭守門那一行要跟著翻
    const up = hist.map((r, k) => ({ date: r.date, close: 30000 + k * 40 }));
    app.usMacroCache = { twii_history: up };
    app._renderReboundRadar();
    const bearEl2 = card().querySelector('[data-bear60]');
    const bear2 = { attr: bearEl2 ? bearEl2.getAttribute('data-bear60') : null, t: bearEl2 ? bearEl2.innerText : '', want: app._bear60Of(up) };
    app.usMacroCache = { twii_history: hist };
    return { txt, html, txt2, bear, bear2, bwOld, bwSame, prevD,
             gone: ['_dipLadder', '_dipLadderHtml'].filter(k => typeof app[k] === 'function'), d0050: '_d0050Close' in app };
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
// 🗑️ V79.9.8 「🪜 跌到哪裡才敢買」拿掉(跟 dipbuy 研究相反、而且叫你「第 1 批 3 成」跟決策台打架)
ok('① 階梯函式不可復活(_dipLadder / _dipLadderHtml / _d0050Close)', R.gone.length === 0 && !R.d0050, JSON.stringify(R.gone));
ok('② 雷達卡上 ⛔「跌到哪裡才敢買」「第 N 批 3 成」', !/跌到哪裡才敢買|第\s*\d\s*批|定價不定時/.test(R.txt), (R.txt.match(/跌到哪裡[\s\S]{0,60}|第\s*\d\s*批[\s\S]{0,30}/) || [''])[0]);
ok('③ 替代那一行在:想買 0050 ⛔ 不用等跌到某個價位、⛔ 不用硬分好幾批', /data-dip0050/.test(R.html) && /不用等跌到某個價位/.test(R.txt) && /不用硬分好幾批/.test(R.txt), '');
ok('④ 雷達只描述:⛔「才進場 / 分批回場 / 先 1/3 / 跌破今日低點停損 / 新單先等 / 進場門檻」,要寫「不是買賣訊號」',
   !/才進場|分批回場|先\s*1\/3|跌破今日低點停損|新單先等|進場門檻|空手準備/.test(R.txt) && /不是買賣訊號|不是叫你等/.test(R.txt) && /成形門檻/.test(R.txt),
   (R.txt.match(/才進場[\s\S]{0,30}|分批回場[\s\S]{0,30}|新單先等|進場門檻/) || [''])[0]);
ok('⑤ 大盤空頭守門那一行 = `_bear60Of` 的結果(空頭那組);換成多頭的加權 → 跟著翻(決定性對照)',
   R.bear.want && R.bear.attr === (R.bear.want.on ? '1' : '0') && R.bear2.want && R.bear2.attr === (R.bear2.want.on ? '1' : '0') && R.bear.attr !== R.bear2.attr
   && /已觸發/.test(R.bear.t) === R.bear.want.on && /沒有觸發/.test(R.bear2.t) === !R.bear2.want.on,
   JSON.stringify({ a: [R.bear.attr, R.bear.want && R.bear.want.on], b: [R.bear2.attr, R.bear2.want && R.bear2.want.on] }));
ok('⑥ 價差比加權那根舊 → 標日期;同一天 ⛔ 標(決定性對照)', R.bwOld === R.prevD && R.bwSame === false, JSON.stringify({ old: R.bwOld, same: R.bwSame }));

ok('⑦ 價差沒資料時要講原因,不是只顯「沒有資料」',
   R.txt.includes('不是同一天的收盤') || R.txt.includes('不同交易日'), (R.txt.match(/價差翻正[\s\S]{0,120}/) || [])[0]);
ok('⑦ 並說明「不計分、不影響其他判斷」', /價差翻正[\s\S]{0,400}不計分/.test(R.txt), (R.txt.match(/價差翻正[\s\S]{0,400}/) || [])[0]);
// ⚠️ V71.8.1 起:台指 VIX 拿不到就直接改用自算的「台股波動率」(有日 K 就算得出來),
//    所以這裡不再是「解釋為什麼沒資料」,而是**要有真數字**。名稱守則另見 test_twvol.mjs。
ok('⑧ 台指 VIX 沒資料時改顯自算的台股波動率(要有數字,不是「沒有資料」)',
   /台股波動率退燒[\s\S]{0,60}\d+\.\d%/.test(R.txt), (R.txt.match(/波動率退燒[\s\S]{0,80}/) || [])[0]);
ok('⑧ ⛔ 不可再叫「台指 VIX」(不同公式不同名字)',
   !R.txt.includes('台指 VIX 退燒'), '');
ok('⑨ 價差有值時要一併顯示兩條腿(期 vs 現)',
   R.txt2.includes('期 40,270') && R.txt2.includes('現 40,039'), (R.txt2.match(/價差翻正[\s\S]{0,160}/) || [])[0]);

console.log();
if (fails.length) { console.log('❌ DIPLADDER_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ DIPLADDER_TEST_PASS');
