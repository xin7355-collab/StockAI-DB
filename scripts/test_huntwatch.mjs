#!/usr/bin/env node
/**
 * ⚔️ 觀察頁改造(V72.6.1)
 *
 * 使用者原話:「上面紅色會跳出的資料,是否改成該股票**勝率最高的策略**,還有**最重要的事情**」
 *            「觀察清單裡面要加入**當初加入時的個股價格**」
 *
 * ⛔ 這支要擋住四件事(每一件都是本專案犯過的錯):
 *   ① 把「常對但不賺」的招當成「勝率最高的策略」(V72.0.3:勝率高 ≠ 會賺錢)
 *   ② 樣本不足還敢下結論(陷阱 #27 / `_wrEnough`)
 *   ③ 空頭時還在鼓勵進場(`_bearGate`,同一個錯全 App 已犯 8 次)
 *   ④ ⭐⭐ **拿現價假裝成加入價** —— 那會讓報酬永遠是 0%,比空白更糟
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 280)}`}`); if (!c) fails.push(n); };

const TODAY = new Date().toISOString().split('T')[0];
const FIX = [
    // ① 有實測背書 + 今天觸發 2 個訊號
    { sym: '2317', name: '鴻海', addDate: '2026-07-10', addPrice: 210.5, currentPrice: 264.5, currentMA5: 255.3, currentMA20: 245.05,
      firedAlerts: [`2317_pullback_${TODAY}`, `2317_foreign_buy_${TODAY}`],
      bestPlay: { key: '🎯 回後買上漲', exp: 1.83, wr: 62, n: 24, fired: true },
      headline: { k: 'good', t: '底部頸線突破', e: 1.47 }, ckScore: 71, mktAtAdd: 22800 },
    // ② 樣本不足 → ⛔ 不給策略;而且最重要的事是風險
    { sym: '2382', name: '廣達', addDate: '2026-06-02', addPrice: 330, currentPrice: 302, currentMA5: 298.9, currentMA20: 327.07,
      firedAlerts: [`2382_wyckoff_${TODAY}`], bestPlay: null,
      bestPlayWhy: '期望值最高的「晨星轉折」只打過 3 次,樣本不到 10 次',
      headline: { k: 'risk', t: '向下跳空未回補', e: -1.16 }, ckScore: 38, mktAtAdd: 23500 },
    // ③ 舊資料:沒有 addPrice
    { sym: '3231', name: '緯創', currentPrice: 120, currentMA5: 118, currentMA20: 115, firedAlerts: [] },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.addInitScript(f => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
    localStorage.setItem('proTerminalHunt', JSON.stringify(f));
}, FIX);
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderHuntTab, null, { timeout: 25000 });

const render = (bearSym) => page.evaluate(async b => {
    app._twiiRows = [{ date: '2026-06-02', close: 23500 }, { date: '2026-07-10', close: 22800 }, { date: '2026-08-06', close: 24100 }];
    app._ovTrend = b ? { sym: b, trend: 'bear', txt: '' } : null;
    app.currentSymbolId = b || null;
    app.switchAppTab('hunt');
    app.renderHuntTab();
    await new Promise(r => setTimeout(r, 350));
    const box = document.getElementById('huntAlertBox');
    return {
        alerts: (box.innerText || '').replace(/\s+/g, ' '),
        cards: box.querySelectorAll(':scope > div').length,
        list: (document.getElementById('huntMonitorList').innerText || '').replace(/\s+/g, ' '),
        order: [...document.getElementById('huntMonitorList').children].map(el => (el.innerText.match(/\d{4}/) || [''])[0]),
    };
}, bearSym);

const R = await render(null);

// ── ① 每檔一張卡(⛔ 不是每個訊號一張)────────────────────────────────
ok('① ⭐ 兩檔觸發 → 兩張卡(⛔ 3 個訊號不可變 3 張)', R.cards === 2, `cards=${R.cards}`);
ok('① 訊號縮成標籤,兩個都在同一張卡上', /月線起漲/.test(R.alerts) && /外資連買3日/.test(R.alerts), R.alerts.slice(0, 200));
ok('① ⛔ 不可出現未翻譯的英文 key', !/pullback|foreign_buy|wyckoff/.test(R.alerts), R.alerts.slice(0, 200));

// ── ② 勝率最高的策略:必須配期望值 + 樣本 ────────────────────────────
ok('② ⭐ 有實測背書 → 給策略名 + 每趟期望值 + 樣本數',
   /勝率最高的策略/.test(R.alerts) && /回後買上漲/.test(R.alerts) && /\+1\.83%/.test(R.alerts) && /24 次/.test(R.alerts), R.alerts.slice(0, 300));
ok('② ⭐⛔ 樣本不足 → 明說「沒有站得住腳的」+ 原因',
   /沒有站得住腳的/.test(R.alerts) && /只打過 3 次/.test(R.alerts), R.alerts.slice(0, 400));
ok('② ⭐ 樣本不足時要勸阻(⛔ 不是進場理由)', /不是進場理由/.test(R.alerts), R.alerts.slice(0, 400));

// ── ③ 最重要的事情:風險優先,且風險不可寫成賣出指令 ────────────────
ok('③ ⭐ 有風險訊號 → 「最重要的事」講風險', /最重要的事[：:]?\s*同時出現「向下跳空未回補」/.test(R.alerts.replace(/\s/g, '').replace(/最重要的事:/, '最重要的事:')) || /向下跳空未回補/.test(R.alerts), R.alerts.slice(0, 400));
ok('③ ⭐⛔ 風險提醒必須標「不是賣出指令」', /不是賣出指令/.test(R.alerts), R.alerts.slice(0, 400));
ok('③ ⭐ 看空訊號的期望值要解釋方向(跌越多=越準)', /跌得越多.{0,12}越準/.test(R.alerts), R.alerts.slice(0, 400));

// ── ④ ⭐⭐ 加入時價格:絕不可拿現價假裝 ───────────────────────────────
ok('④ ⭐ 有 addPrice → 顯示加入價與加入至今 %', /加入 @210\.50/.test(R.list) && /\+25\.7%/.test(R.list), R.list.slice(0, 300));
ok('④ ⭐ % 一定要配實際金額(使用者鐵則)', /一張 \+[\d,]+ 元/.test(R.list), R.list.slice(0, 300));
ok('④ ⭐ 金額要走 `_netPL`(已扣手續費+稅 → 不可等於毛利 54,000)',
   /\+53,0\d\d 元/.test(R.list), R.list.slice(0, 300));
ok('④ ⭐ 虧損那檔要顯負金額', /−29,\d\d\d 元/.test(R.list), R.list.slice(0, 400));
ok('④ ⭐⭐⛔ 沒有 addPrice 的舊資料 → 誠實說「未記錄」', /加入價未記錄/.test(R.list), R.list.slice(-260));
ok('④ ⭐⭐⛔ 而且⛔不可用現價假裝(緯創不可出現 +0.0% / 加入 @120)',
   !/加入 @120/.test(R.list) && !/\+0\.0%/.test(R.list), R.list.slice(-260));

// ── ⑤ 贏不贏大盤(只有拿得到基準才給)────────────────────────────────
ok('⑤ ⭐ 要跟大盤比(個股 +25.7% vs 大盤 +5.7% → 贏 20.0pp)', /贏大盤 20\.0pp/.test(R.list), R.list.slice(0, 320));
ok('⑤ ⭐ 輸的那檔要說「輸大盤」', /輸大盤/.test(R.list), R.list.slice(0, 420));
ok('⑤ ⛔ 沒有基準的那檔不可硬算', !/緯創[^]*?大盤/.test(R.list.split('緯創')[1] || ''), (R.list.split('緯創')[1] || '').slice(0, 120));

// ── ⑥ 排序:今天有觸發的排最前 ──────────────────────────────────────
ok('⑥ ⭐ 有觸發的排前面(2317 兩個訊號 → 第一)', R.order[0] === '2317', JSON.stringify(R.order));
ok('⑥ ⭐ 沒觸發的排最後', R.order[R.order.length - 1] === '3231', JSON.stringify(R.order));

// ── ⑦ 空頭守門(⛔ 全 App 犯最多次的錯)─────────────────────────────
const B = await render('2317');
ok('⑦ ⭐ 空頭時要加「不是波段進場理由」', /不是波段進場理由/.test(B.alerts), B.alerts.slice(0, 400));
ok('⑦ ⭐ 非空頭時不可誤傷', !/不是波段進場理由/.test(R.alerts), R.alerts.slice(0, 300));

// ── ⑧ 掃描時真的有把 bestPlay / headline 算進去(⛔ 不是只有顯示端假裝有)──
const wired = await page.evaluate(() => {
    const src = app.scanAllMonitored.toString();
    return {
        bt: /_patternFitBacktest\(/.test(src),
        gate: /_wrEnough\(/.test(src) && /expectancy > 0/.test(src),
        ck: /_entryCheckup\(/.test(src),
        why: /bestPlayWhy/.test(src),
        twii: /_getTwiiRows\(/.test(src),
    };
});
ok('⑧ ⭐ 掃描時真的跑這檔自己的回測', wired.bt, JSON.stringify(wired));
ok('⑧ ⭐⛔ 而且有「期望值>0 且樣本足」雙重門檻', wired.gate, JSON.stringify(wired));
ok('⑧ ⭐ 有算「最重要的事」', wired.ck, JSON.stringify(wired));
ok('⑧ ⭐ 沒有策略時要留下原因(陷阱 #22)', wired.why, JSON.stringify(wired));
ok('⑧ ⭐ 大盤基準走共用 `_getTwiiRows`(⛔ 不另寫一份 fetch)', wired.twii, JSON.stringify(wired));

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:\n - ${fails.join('\n - ')}` : '\n✅ HUNTWATCH_TEST_PASS');
process.exit(fails.length ? 1 : 0);
