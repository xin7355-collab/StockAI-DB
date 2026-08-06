// 🧪 空殼卡清掃 + 上檔空間搬家(V71.8.8)
// 使用者:「1.找不到上方套牢區 2/3/4. 三頁請重新審視,該出現的顯示、不需要的隱藏」
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import fs from 'fs'; import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };
const C = '/tmp/k2327.json';
if (!fs.existsSync(C)) execSync(`git -C /home/user/StockAI-DB show origin/gh-pages:data/2327.json > ${C}`, { shell: '/bin/bash' });
const REAL = JSON.parse(fs.readFileSync(C, 'utf8'));

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
    const data = real.map(r => ({ ...r, close: +r.close, high: +r.high, low: +r.low, open: +r.open, volume: +r.volume }));
    const last = data.length - 1, pC = data[last].close;
    app.currentSymbolId = '2327';
    app.settings = app.settings || {}; app.settings.feeDiscount = 0.28;
    app._dynExit = { t1: 620, t2: 700, def: pC * 0.92, pC };
    app._guardStash = { g5: pC * 0.98, g20: pC * 0.95 };
    app._renderGuardRuler(pC, data, last);

    const upEl = document.getElementById('upsideRoomCard');
    const gEl = document.getElementById('guardRuler');
    const out = {
        upHidden: upEl.classList.contains('hidden'),
        upTxt: upEl.innerText,
        upPane: upEl.closest('[data-ovpane]')?.dataset.ovpane,
        guardPane: gEl.closest('[data-ovpane]')?.dataset.ovpane,
        guardTxt: gEl.innerText,
    };
    // 空殼清掃:造一個「子層全 hidden」的外殼
    // ⚠️ 白名單必須是**真的空殼**;第一版誤把 directActionBox(包住整段進場內容)放進來,
    //    實測字數 168 才發現 → 這裡順便釘住「有內容的外殼不可以在白名單裡」。
    out.liveWrappers = ['directActionBox', 'ovBodyEntry', 'ovBodyExit']
        .filter(id => app._EMPTY_SHELLS.includes(id));
    const shell = document.getElementById('chuMergedCard');
    // ⚠️ V72.5.6:K棒戰法卡搬進 chuMergedCard 之後,這檔股票**真的有訊號** → 它不再是空殼。
    //    ⛔ 測試不可依賴「這檔今天剛好沒東西」(同「測試不可綁死會浮動的資料狀態」)→
    //    這裡明確把所有子層藏起來,製造出「定義上的空殼」再驗清掃器。
    if (shell) [...shell.children].forEach(c => { c.classList.add('hidden'); c.innerHTML = ''; });
    out.shellBefore = shell ? shell.classList.contains('hidden') : null;
    app._sweepEmptyShells();
    out.shellAfter = shell ? shell.classList.contains('hidden') : null;
    // ⛔ 有內容的外殼不可被藏
    const merged = document.getElementById('chipRadarPanel');
    merged.innerHTML = '<div>有內容不可以被藏</div>';
    app._sweepEmptyShells();
    out.mergedHidden = merged.classList.contains('hidden');
    // ⛔ 含 canvas 的容器不可被藏(圖表沒文字但不是空的)
    merged.innerHTML = '<canvas></canvas>';
    app._sweepEmptyShells();
    out.canvasHidden = merged.classList.contains('hidden');
    return out;
}, REAL);
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
ok('① 上檔空間有自己的卡,而且看得到', !R.upHidden && R.upTxt.includes('上檔空間'), `hidden=${R.upHidden}`);
ok('① ⭐ 上檔空間搬到「進場」頁籤(使用者原本在出場找不到)', R.upPane === 'entry', String(R.upPane));
ok('① 防守價留在「出場」頁籤', R.guardPane === 'exit', String(R.guardPane));
ok('② 套牢區真的在上檔空間那張卡裡', R.upTxt.includes('套牢區'), R.upTxt.slice(0, 200));
ok('③ 防守價那張要指路(不然使用者還是不知道去哪找)', R.guardTxt.includes('進場'), R.guardTxt.slice(-100));
ok('④ 真的空的外殼會被藏起來', R.shellAfter === true, `before=${R.shellBefore} after=${R.shellAfter}`);
ok('④ ⛔ 白名單不可含「包住活內容的外殼」(第一版誤放,實測抓到)',
   R.liveWrappers.length === 0, JSON.stringify(R.liveWrappers));
ok('④ ⛔ 有內容的外殼不可被藏', R.mergedHidden === false, String(R.mergedHidden));
ok('④ ⛔ 含 canvas 的容器不可被藏(圖表沒文字但不是空的)', R.canvasHidden === false, String(R.canvasHidden));

console.log();
if (fails.length) { console.log('❌ EMPTYSHELL_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ EMPTYSHELL_TEST_PASS');
