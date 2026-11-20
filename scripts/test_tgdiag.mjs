// 📨 V82.6.3 設定 › Telegram「沒收到推送?自助診斷」⛔ 再提獵鷹分數
//   獵鷹分數 V39.2 起就不載入 → 以前永遠印「🦅 全市場獵鷹分 ≥ 80:0 檔」,只要清單不空就一定跳
//   「💡 全市場高分股少(可能盤勢淡或大盤回檔),自然訊號就少」—— 那句是假的。
//   跑法:node scripts/test_tgdiag.mjs
//   同版也拿掉「監控空 → 量爆突破 5MA + 朱家泓 5MA 朝掃都 skip、到朱家泓五大選股法一鍵加入」:
//   朝掃 V78.1.1 已刪、五大選股法 V79.9.3 起只剩實驗室、帶量站上 5 日線自選 / 庫存照樣推 → 那句也是假的。
//   INJECT=1 → 把獵鷹那兩行塞回去(①② 必紅);INJECT=2 → 把「監控空」那句塞回去(④ 必紅)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const ROOT = '/home/user/StockAI-DB';
const fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const INJ = process.env.INJECT || '';
let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), file = path.join(ROOT, 'index.html');
const ANCHOR = '        const tgBound = !!this.settings?.cloudCode;';
ok('⓪ 找得到診斷那支的錨點(⛔ 空過)', src.split(ANCHOR).length === 2);
if (INJ === '2') {
    src = src.replace("        lines.push(...issues);", "        if (monitor === 0) issues.push('💡 <b class=\"text-blue-300\">監控空</b> → 「量爆突破 5MA」+「朱家泓 5MA 朝掃」這兩個推送都 skip。到朱家泓五大選股法 → 一鍵加入監控');\n        lines.push(...issues);");
    file = path.join(ROOT, '_inj_tgdiag_index.html');
    fs.writeFileSync(file, src);
} else if (INJ) {
    src = src.replace(ANCHOR, ANCHOR + "\n        const falconHigh = 0;")
        .replace("        lines.push(...issues);", "        if (falconHigh < 5 && wl + inv + monitor > 0) issues.push('💡 <b class=\"text-blue-300\">全市場高分股少</b>(可能盤勢淡或大盤回檔),自然訊號就少');\n        lines.push(`🦅 全市場獵鷹分 ≥ 80:<b>${falconHigh}</b> 檔`);\n        lines.push(...issues);");
    file = path.join(ROOT, '_inj_tgdiag_index.html');
    fs.writeFileSync(file, src);
}
// 靜態:診斷那支 ⛔ 讀獵鷹分數(先剝 // 註解)
const fn = (src.match(/_runTelegramDiagnosis\s*\(\)\s*\{[\s\S]*?\n    \},/) || [''])[0];
const code = fn.replace(/\/\/.*$/gm, '');
ok('② 診斷那支 ⛔ 讀獵鷹分數(_falconScores / falconHigh)', fn.length > 800 && !/_falconScores|falconHigh/.test(code), fn.length);

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
        const run = (lists) => {
            Object.assign(app, lists);
            app.settings = Object.assign({}, app.settings || {}, { cloudCode: 'TEST01' });
            app._runTelegramDiagnosis();
            const el = document.getElementById('tgDiagnosisBody');
            return el ? el.innerText : null;
        };
        // 正式環境 _falconScores 是 null;就算有人塞一份高分的進去,也 ⛔ 印出來
        app._falconScores = { stocks: { 2330: { score: 90 } } };
        const full = run({ favGroups: { A: ['2330', '2317'] }, inventory: [{ sym: '2330', cost: 500, shares: 1000 }], monitorList: [], priceAlerts: [] });
        const empty = run({ favGroups: {}, inventory: [], monitorList: [], priceAlerts: [] });
        return { full, empty };
    });
    ok('渲染沒有 pageerror', errs.length === 0, errs[0] || '');
    ok('⓪ 診斷那一格真的有寫出東西(⛔ 空過)', typeof R.full === 'string' && /已綁定/.test(R.full) && /自選 2 檔/.test(R.full), String(R.full).slice(0, 200));
    ok('① 清單不空 → ⛔ 有「獵鷹」、⛔ 有「高分股少」', typeof R.full === 'string' && !/獵鷹/.test(R.full) && !/高分股少/.test(R.full), String(R.full).slice(0, 400));
    ok('④ 監控清單是空的 → ⛔ 說「兩個推送都 skip」、⛔ 叫你去朱家泓五大選股法(朝掃已刪、那頁只剩實驗室)', typeof R.full === 'string' && !/監控空|朝掃|五大選股法/.test(R.full), String(R.full).slice(0, 400));
    ok('③ 決定性對照:清單全空 → 照舊跳「清單全空」', typeof R.empty === 'string' && /清單全空/.test(R.empty), String(R.empty).slice(0, 200));
} finally {
    await b.close();
    if (INJ) fs.rmSync(file, { force: true });
}
console.log();
if (fails.length) { console.log('❌ TGDIAG_TEST_FAIL:', fails.length); process.exit(1); }
console.log('✅ TGDIAG_TEST_PASS');
