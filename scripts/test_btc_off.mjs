// ₿ 比特幣那兩句只描述(EXP-20261123-02 四個判定全沒過:疊進盤前分數猜開盤沒有更準、盤中帶不動 0050、20 天大跌之後也沒有比較差)
//   ⓪ 靜態:`_btcMeaning` 全 App 只有一份,全球大玩家卡(updateBigPlayers case 'btc')與前端即時(_refreshLiveBtc)都走它;
//      程式碼裡(剝掉 // 註解)⛔ 再出現「同步利多科技股 / 科技股小心 / 風險亢奮 / 風險偏好回升 / 風險情緒轉弱」;
//      名詞解釋「比特幣」⛔「股市偏多 / 股市偏空」
//   ① 實跑 `_btcMeaning`:±5% 以上講「大漲 / 大跌・台股看盤前體檢」、2~5% 小漲 / 小跌、其他平穩、沒資料 --;
//      ⛔ 🔴🟢、⛔ 紅 / 綠底(燈號鐵則:紅綠只講方向 → 中性底、紅漲綠跌字);門檻 = `_BTC_BIG`(觸發專欄 btc_big 同一個)
//   ② 實跑全球大玩家卡 + 前端即時(假的 CoinGecko 回應):那一格的字 / 顏色 == `_btcMeaning` 同一個值
//   INJECT=old   → 大玩家卡那支換回舊的四級(⓪ ② 必紅)
//   INJECT=live  → 前端即時那支換回自己寫的舊四級(⓪ ② 必紅)
//   INJECT=gloss → 名詞解釋換回「BTC 暴漲 = 股市偏多」(⓪ 必紅)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const ROOT = '/home/user/StockAI-DB';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const OLD_CARD = `if (c > 5) return { txt: '🚀 風險亢奮·同步利多科技股', cls: 'bg-green-900/40 text-green-300' };
                    if (c > 2) return { txt: '🟢 風險偏好回升', cls: 'bg-green-900/30 text-green-300' };
                    if (c < -5) return { txt: '😱 風險暴跌·科技股小心', cls: 'bg-red-900/40 text-red-200' };
                    if (c < -2) return { txt: '🔻 風險情緒轉弱', cls: 'bg-red-900/30 text-red-300' };
                    return { txt: '✅ 情緒平穩', cls: 'bg-gray-800/40 text-gray-400' };`;
const INJ = process.env.INJECT || '';
let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), file = path.join(ROOT, 'index.html');
if (INJ) {
    const rep = (a, b) => { if (!src.includes(a)) { console.log(`❌ 注入 ${INJ}:找不到要改的那一行(測試過期了)`); process.exit(1); } src = src.replace(a, b); };
    if (INJ === 'old') rep("return this._btcMeaning(c);   // ₿ V82.6.7 只描述", OLD_CARD + ' //');
    if (INJ === 'live') rep("const m = this._btcMeaning(c);\n", "const m = (c > 5 ? { txt: '🚀 風險亢奮·同步利多科技股', cls: 'bg-green-900/40 text-green-300' } : this._btcMeaning(c));\n");
    if (INJ === 'gloss') rep("'比特幣': '加密貨幣龍頭，24 小時都在交易。", "'比特幣': '加密貨幣龍頭，最敏感的風險偏好指標。BTC 暴漲=市場敢冒險（股市偏多）。");
    file = path.join(ROOT, '_inj_btc_index.html');
    fs.writeFileSync(file, src);
}
// ⓪ 靜態(INJECT 的時候讀注入後那份;先剝掉 // 註解 —— 註解裡引用舊句子是在講「⛔ 不要這樣寫」)
const code = src.split('\n').map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
ok('⓪ `_btcMeaning` 全 App 只有一份定義', (src.match(/\n    _btcMeaning\(c\) \{/g) || []).length === 1);
const ubp = (src.match(/\n    updateBigPlayers\(j\) \{[\s\S]*?\n    \},\n/) || [''])[0], live = (src.match(/\n    async _refreshLiveBtc\(\) \{[\s\S]*?\n    \},\n/) || [''])[0];
ok('⓪ 全球大玩家卡(case \'btc\')與前端即時都走 `_btcMeaning`', /case 'btc':\s*\n\s*return this\._btcMeaning\(c\);/.test(ubp) && /const m = this\._btcMeaning\(c\);\n/.test(live), `${ubp.length} / ${live.length}`);
// ⚠️ 只認比特幣那一格的舊字串(原油那格「通膨壓力·科技股小心」、黃金名詞解釋「風險偏好回升」是別的事,⛔ 誤殺)
const OLD = /風險亢奮|同步利多科技股|🟢 風險偏好回升|風險暴跌·科技股小心|🔻 風險情緒轉弱|情緒平穩·即時/u;
ok('⓪ 程式碼裡 ⛔ 再出現比特幣那一格的舊四級(風險亢奮·同步利多科技股 / 風險偏好回升 / 風險暴跌·科技股小心 / 風險情緒轉弱)', !OLD.test(code), (code.match(OLD) || [])[0]);
const gloss = (src.match(/'比特幣': '([^']*)'/) || [])[1] || '';
ok('⓪ 名詞解釋「比特幣」只描述:⛔「股市偏多 / 股市偏空 / 風險偏好指標」、有講「盤前體檢」', gloss.length > 40 && !/股市偏多|股市偏空|風險偏好指標/.test(gloss) && /盤前體檢/.test(gloss), gloss.slice(0, 80));

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
    await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._btcMeaning, null, { timeout: 30000 });
    await pg.waitForTimeout(1500);
    const R = await pg.evaluate(async () => {
        const o = { big: app._BTC_BIG };
        o.m = Object.fromEntries([-8, -5, -4.99, -3, -1, 0, 1.5, 2, 4.99, 5, 9].map(c => [c, app._btcMeaning(c)]));
        o.na = [null, undefined, '', 'x'].map(v => app._btcMeaning(v).txt);
        // ② 全球大玩家卡:同一個值 → 那一格的字 / 顏色 == _btcMeaning
        const card = c => { app.updateBigPlayers({ btc_usd: 61496, btc_chg_pct: c }); const el = document.getElementById('bpBtcMeaning'); return el ? { t: el.textContent, cls: el.className } : null; };
        o.card = [-6.2, -3.1, 0.4, 3.3, 7.1].map(c => ({ c, got: card(c), want: app._btcMeaning(c) }));
        // ② 前端即時:假的 CoinGecko(24 小時 +5.3%、−2.4%);那一格要看得到(⛔ offsetParent 守門擋掉 = 沒跑到)
        const F = window.fetch, val = document.getElementById('bpBtc');
        Object.defineProperty(val, 'offsetParent', { get: () => document.body, configurable: true });
        app.settings = app.settings || {}; const lb = app.settings.liveBtc; app.settings.liveBtc = true;
        const liveRun = async c => { window.fetch = async () => ({ ok: true, json: async () => ({ bitcoin: { usd: 61000, usd_24h_change: c } }) });
            await app._refreshLiveBtc(); const el = document.getElementById('bpBtcMeaning'); return { c, t: el.textContent, cls: el.className, val: val.textContent, want: app._btcMeaning(c) }; };
        o.live = [await liveRun(5.3), await liveRun(-2.4)];
        window.fetch = F; app.settings.liveBtc = lb;
        return o;
    });
    ok('渲染沒有 pageerror', errs.length === 0, errs[0] || '');
    const M = R.m, T = c => (M[c] || {}).txt || '', C = c => (M[c] || {}).cls || '';
    ok('① 門檻 `_BTC_BIG` = 5(觸發專欄 btc_big 同一個)', R.big === 5, R.big);
    ok('① ±5% 以上:「大漲 / 大跌・台股看盤前體檢」;4.99% 還不算大', /大漲/.test(T(5)) && /盤前體檢/.test(T(9)) && /大跌/.test(T(-5)) && /盤前體檢/.test(T(-8))
       && !/大/.test(T(4.99)) && !/大/.test(T(-4.99)), JSON.stringify([T(5), T(9), T(-5), T(-8), T(4.99), T(-4.99)]));
    ok('① 2~5%:小漲 / 小跌;不到 2%:平穩;沒資料 / 空字串 / 不是數字:--', /小漲/.test(T(2)) && /小漲/.test(T(4.99)) && /小跌/.test(T(-3)) && /平穩/.test(T(0)) && /平穩/.test(T(1.5)) && /平穩/.test(T(-1))
       && R.na.every(x => x === '--'), JSON.stringify([T(2), T(-3), T(0), T(1.5), R.na]));
    const all = Object.values(M);
    ok('① ⛔ 🔴🟢、⛔ 紅 / 綠底(燈號鐵則);上漲紅字、下跌綠字、平穩灰字', all.every(m => !/[🔴🟢]/u.test(m.txt) && !/bg-(red|green)-/.test(m.cls))
       && /text-red-/.test(C(5)) && /text-red-/.test(C(2)) && /text-green-/.test(C(-5)) && /text-green-/.test(C(-3)) && /text-gray-/.test(C(0)), JSON.stringify(all.map(m => m.cls)));
    ok('① ⛔「利多 / 小心 / 風險 / 偏多 / 偏空」', all.every(m => !/利多|小心|風險|偏多|偏空/.test(m.txt)), JSON.stringify(all.map(m => m.txt)));
    ok('② 全球大玩家卡那一格 == `_btcMeaning`(字 + 顏色,5 個值)', R.card.every(x => x.got && x.got.t === x.want.txt && x.got.cls.includes(x.want.cls)), JSON.stringify(R.card));
    ok('② 前端即時(假的 CoinGecko)那一格 == `_btcMeaning`(+5.3% / −2.4%);價格真的換成即時那個(= 真的跑到了)', R.live.every(x => x.t === x.want.txt && x.cls.includes(x.want.cls)) && R.live[0].val === '61,000',
       JSON.stringify(R.live));
} finally {
    await b.close();
    if (INJ) fs.rmSync(file, { force: true });
}
console.log();
if (fails.length) { console.log('❌ BTC_OFF_TEST_FAIL:', fails.length); process.exit(1); }
console.log('✅ BTC_OFF_TEST_PASS');
