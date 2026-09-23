#!/usr/bin/env node
/**
 * 🛡️ 硬停損 = 回測與自動下單同一條(V77.5.2 改寫;原 V72.0.7 的「發動K」守門測試)
 *
 * 使用者 2026-09-23:「保留最強策略」+ 選「把 App 的硬停損改成跟回測一樣」。
 *   回測(`scripts/portfolio_backtest.mjs` STOP=lo5):stop = min(進場當天最低, 進場 × 0.95),進場後固定不動
 *   自動下單(`auto_trade.py` 讀 playbook_edge 的 stop):同上
 *   🚨 舊版 App:max(朱家泓「發動K」低, 成本 × 0.95),而且跟著之後的發動K往上移 —— 從來沒回測過,
 *      常常比自動下單**更早**叫你賣。
 *
 * 釘住的用意:
 *   ① 有買進日:stopFinal = min(買進當天那根的最低, 成本 × 0.95)(兩個方向各一組決定性對照)
 *   ② 沒填買進日:stopFinal = 成本 × 0.95,而且一定要寫原因(陷阱 #22)
 *   ③ ⛔ 不可再跟著「發動K」往上移(舊版的移動停損)—— 造一根發動K低於現價、高於成本的資料,結果必須仍是 −5%
 *   ④ 守門:stop ≥ 成本 → 退回 −5%(同回測 `stop >= entry → entry × 0.95`)
 *   ⑤ 跟回測原始碼同一條:portfolio_backtest.mjs 的 lo5 仍是 Math.min(L(eIdx), entry * 0.95)
 *   ⑥ 呼叫端照舊把 buyDate 傳進來(否則 ① 永遠退回 −5%)
 *   ⑦ 註解裡的舊規則(「別把 max 改成 min」)已移除 —— ⛔ 不可留著跟程式打架
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|scheme 'file'/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._unifiedExitPlan, null, { timeout: 20000 });

// 合成 K 線(⛔ 不綁會浮動的真實資料):60 根盤整 + 一根爆量長紅(發動K)+ 8 根高檔
const R = await page.evaluate(() => {
    const d = [];
    for (let i = 0; i < 60; i++) d.push({ date: `2026-05-${String(i % 28 + 1).padStart(2, '0')}`, open: 240, high: 245, low: 238, close: 242, volume: 1e6 });
    d.push({ date: '2026-07-01', open: 302, high: 340, low: 300, close: 336, volume: 9e6 });   // 爆量長紅,低 300
    for (let i = 0; i < 8; i++) d.push({ date: `2026-07-${String(2 + i).padStart(2, '0')}`, open: 320, high: 325, low: 315, close: 320, volume: 2e6 });
    const cl = d.map(r => +r.close);
    const ma = k => cl.map((_, i) => i < k - 1 ? null : cl.slice(i - k + 1, i + 1).reduce((a, v) => a + v, 0) / k);
    app.indicators = { ma5: ma(5), ma20: ma(20), ma60: ma(60) };
    const P = (c, b) => { const x = app._unifiedExitPlan(d, c, b); return x ? { s: x.stopFinal, why: x.stopWhy, drop: x.stopADropped, a: x.stopA } : null; };
    return {
        trig: (app._chuFindTriggerBarLow(d, d.length - 1) || {}).low ?? null,
        // ① 買進當天(07-03)最低 315;成本 320 → 320×0.95 = 304 → min = 304
        a: P(320, '2026-07-03'),
        // ①b 成本 330 → 313.5;買進當天最低 315 → min = 313.5
        b: P(330, '2026-07-03'),
        // ①c 成本 340 → 323;買進當天最低 315 → min = 315(買進當天低比較低)
        c: P(340, '2026-07-03'),
        // ② 沒填買進日
        n: P(320, null),
        // ③ 發動K低 300、成本 250、現價 320:舊版會給 300(移動停損),新版必須是 250×0.95 = 237.5
        mv: P(250, null),
        // ④ 買進日對不到 K 線(比最後一根還晚)→ 退回 −5% 並寫原因
        late: P(320, '2026-12-31'),
        noCost: P(null, null),
    };
});
ok('⓪ 空過守門:合成資料真的有一根發動K(低 300)', R.trig === 300, R.trig);
ok('① 有買進日:min(買進當天最低 315, 成本 320×0.95 = 304) = 304', R.a && R.a.s === 304, JSON.stringify(R.a));
ok('①b 成本 330 → min(315, 313.5) = 313.5', R.b && R.b.s === 313.5, JSON.stringify(R.b));
ok('①c ⭐ 決定性對照:成本 340 → min(315, 323) = 315(買進當天低比較低時要用它)', R.c && R.c.s === 315, JSON.stringify(R.c));
ok('①d 原因要寫出取了哪一個', /買進當天最低 315/.test(R.c && R.c.why || '') && /成本 −5%/.test(R.a && R.a.why || ''), `${R.c && R.c.why} / ${R.a && R.a.why}`);
ok('② 沒填買進日 → 成本 −5%(304)', R.n && R.n.s === 304, JSON.stringify(R.n));
ok('② ⭐ 而且要說出為什麼只用 −5%(陷阱 #22)', /沒填買進日/.test(R.n && R.n.drop || ''), R.n && R.n.drop);
ok('③ ⭐⛔ 不可再跟著發動K往上移(舊版會給 300)', R.mv && R.mv.s === 237.5, JSON.stringify(R.mv));
ok('④ 買進日對不到 K 線 → −5% + 原因', R.late && R.late.s === 304 && /對不到/.test(R.late.drop || ''), JSON.stringify(R.late));
ok('④b 沒有成本 → 沒有硬停損(⛔ 不可憑空給一個)', R.noCost && R.noCost.s == null, JSON.stringify(R.noCost));

// ⑤ 跟回測原始碼同一條(⛔ 一邊改了另一邊要一起改)
const bt = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8');
ok('⑤ 回測 lo5 仍是 Math.min(L(eIdx), entry * 0.95)', /stop = Math\.min\(L\(eIdx\), entry \* 0\.95\);\s*\/\/ lo5/.test(bt), '');

// ⑥ 呼叫端有傳 buyDate
const wired = await page.evaluate(() => ({
    trend: /_unifiedExitPlan\([^)]*,\s*_buyDate\)/.test(app._renderTrendCommand.toString()),
    dist: /_unifiedExitPlan\(data, x\.cost, x\.buyDate/.test(app._exitDistance.toString()),
}));
ok('⑥ _renderTrendCommand 有傳 buyDate', wired.trend, '');
ok('⑥ _exitDistance(決策台/總覽/報告)有傳 buyDate', wired.dist, '');

// ⑦ 舊規則的註解已移除
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fnStart = src.indexOf('    _unifiedExitPlan(data, cost, buyDate, ind) {');
const fnBody = src.slice(fnStart, src.indexOf('\n    },\n', fnStart));
ok('⑦ ⛔ 函式裡不可再用 Math.max 取停損(舊的移動停損)', fnStart > 0 && !/Math\.max\(\.\.\.stops\)/.test(fnBody), '');
ok('⑦b ⛔ 「別把它改成 min」那段舊註解要拿掉(會跟程式打架)', !/別把它改成\s*`min`/.test(src), '');

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log('');
if (fails.length) { console.log(`❌ GUARDTIME_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ GUARDTIME_TEST_PASS');
