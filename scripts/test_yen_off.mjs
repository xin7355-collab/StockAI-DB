// 💴 日圓那幾條只描述(EXP-20261120-01 沒過):反攻雷達不算進條件、不算黑天鵝;風險指數不讀任何黑天鵝旗標(V82.6.3)
//   INJECT=flag  → 把舊的「黑天鵝旗標加分」那段塞回風險指數(②③ 必紅;V82.6.3 起整段拿掉 —— 它讀的獵鷹分數 V39.2 起就不載入)
//   INJECT=radar → 把「日圓不急升」加回雷達條件(① 必紅)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const ROOT = '/home/user/StockAI-DB';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const INJ = process.env.INJECT || '';
let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), file = path.join(ROOT, 'index.html');
if (INJ) {
    if (INJ === 'flag') src = src.replace("        // 🦅 黑天鵝旗標加分已拿掉(V82.6.3)", "        const mf = this._falconScores?.macro_flags || {};\n        const flagCount = ['jpy_surge', 'metal_oil_spike', 'kospi_dump'].filter(k => mf[k]).length;\n        if (flagCount > 0) score += Math.min(flagCount * 5, 20);\n        // 🦅 黑天鵝旗標加分已拿掉(V82.6.3)");
    if (INJ === 'radar') src = src.replace("        const dist = N(this._distDayCount);", "        const dist = N(this._distDayCount);\n        const _injJ = 1;")
        .replace("        // 💴 2026-11-20 日圓那條改成只列出來", "        add('💴', '日圓不急升', jpy3 == null ? '—' : String(jpy3), jpy3 != null && jpy3 > -2, '3 日升值 <2%', jpy3 == null);\n        // 💴 2026-11-20 日圓那條改成只列出來");
    file = path.join(ROOT, '_inj_yen_index.html');
    fs.writeFileSync(file, src);
}
// ③ 靜態:風險指數那支沒有 usdjpy、也 ⛔ 讀任何黑天鵝旗標(INJECT 的時候讀注入後那份;先剝掉 // 註解)
const rs = (src.match(/_calcRiskScore\s*\([^)]*\)\s*\{[\s\S]*?\n    \},/) || [''])[0];
const rsCode = rs.replace(/\/\/.*$/gm, '');
ok('③ 風險指數那支 ⛔ 讀 usdjpy', rs.length > 500 && !/usdjpy/.test(rsCode), rs.length);
ok('③ 風險指數那支 ⛔ 讀黑天鵝旗標(_falconScores / macro_flags / blackswan / jpy_surge / flagCount)', rs.length > 500 && !/_falconScores|macro_flags|blackswan|jpy_surge|flagCount/.test(rsCode));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
try {
    const pg = await b.newPage();
    await pg.addInitScript(() => {
        const noop = () => inst;
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
        const ec = new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) });
        Object.defineProperty(window, 'echarts', { value: ec, writable: true, configurable: true });
    });
    const errs = [];
    const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|blocked by CORS|Cross origin|navigator\.vibrate|chromestatus|Access to fetch/i.test(t);
    pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
    await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
    await pg.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pg.waitForTimeout(2500);
    const R = await pg.evaluate(() => {
        const mk = (jpy3, vix) => {
            app._macroRiskCache = {
                vix, sp500_chg_pct: 0.5, usdtwd_chg_5d: 0.36, usdtwd: 29.9,
                kospi_chg_pct: 1.2, nikkei_chg_pct: 0.4, wti_chg_pct: 0.5, jpy_chg_3d: jpy3,
                taifex_backwardation: 12, tw_vix: 22, fi_futures_net: -81017, fear_greed: 30, updated: '2026-11-19',
            };
            app.usMacroCache = { twii_history: Array.from({ length: 70 }, (_, i) => ({ close: 40000 - i * 5 })) };
            app._riskHistCache = Array.from({ length: 25 }, (_, i) => ({ fi_futures_net: -75000 - i * 250, margin_100m: 4000 - i }));
            app._distDayCount = 1;
            app._bubbleCache = { margin_leverage: { total_100m: 4000 } };
            app._renderReboundRadar();
            const el = document.getElementById('reboundRadarCard');
            const jl = el.querySelector('[data-jpy3]');
            return { v: { ...app._reboundVerdict }, txt: el.innerText, jpy: jl ? jl.innerText : null };
        };
        const calm = mk(-0.2, 17.1), surge = mk(-4.5, 17.1), swan = mk(-0.2, 33);
        // 風險指數:只換旗標,其他一樣
        // 正式環境 App 不載入獵鷹分數(V39.2 起 _falconScores 永遠是 null)→ 測試硬塞旗標進去,分數也要一分不變
        const risk = flags => { app._falconScores = flags ? { macro_flags: flags } : null; app.fiShortQty = -50000; return app._calcRiskScore(); };
        const sc = s => s && typeof s === 'object' ? (s.score ?? s.total ?? s.value) : s;
        const r0 = sc(risk(null)), rAll = sc(risk({ jpy_surge: true, metal_oil_spike: true, kospi_dump: true, market_bias_high: true }));
        // 決定性對照:同一份資料只把台指選擇權 VIX 22 → 33(+2 分 → +8 分)→ 分數要跟著變(量得到東西,不是常數)
        const tv0 = app._macroRiskCache.tw_vix; app._macroRiskCache.tw_vix = 33;
        const rTw = sc(risk(null)); app._macroRiskCache.tw_vix = tv0;
        return { calm, surge, swan, r0, rAll, rTw };
    });
    ok('渲染沒有 pageerror', errs.length === 0, errs[0] || '');
    ok('① 雷達條件表沒有日圓那條(總條數不含它)', !/日圓不急升/.test(R.calm.txt) && R.calm.v.total === R.surge.v.total, JSON.stringify([R.calm.v, R.surge.v]));
    ok('① 日圓 3 日升值 4.5% → 過的條數不變、⛔ 變成黑天鵝', R.surge.v.passN === R.calm.v.passN && R.surge.v.txt === R.calm.v.txt && R.surge.v.txt !== '外面壓力很大', JSON.stringify(R.surge.v));
    ok('① 決定性對照:VIX 33 → 照樣是「外面壓力很大」(黑天鵝那條路還活著)', R.swan.v.txt === '外面壓力很大', JSON.stringify(R.swan.v));
    ok('① 條件表下面一行只列出來:「日圓 3 日升值 4.5%(只列出來,不算進上面的條件)」', /日圓 3 日升值 4\.5%/.test(R.surge.jpy || '') && /不算進/.test(R.surge.jpy || ''), R.surge.jpy);
    ok('① 那一行 ⛔ 研究字樣 / 指令字', !/實測|回測|探針|賣出|減碼|空手/.test(R.surge.jpy || ''), R.surge.jpy);
    ok('② 風險指數:黑天鵝旗標(日圓急升 / 金油暴漲 / 亞股提款)全部塞進去 → 分數一分不變', typeof R.r0 === 'number' && R.rAll === R.r0, JSON.stringify([R.r0, R.rAll]));
    ok('② 決定性對照:只把台指選擇權 VIX 22 → 33 → 分數 +6(這個量法量得到東西)', typeof R.rTw === 'number' && R.rTw === R.r0 + 6, JSON.stringify([R.r0, R.rTw]));
} finally {
    await b.close();
    if (INJ) fs.rmSync(file, { force: true });
}
console.log();
if (fails.length) { console.log('❌ YEN_OFF_TEST_FAIL:', fails.length); process.exit(1); }
console.log('✅ YEN_OFF_TEST_PASS');
