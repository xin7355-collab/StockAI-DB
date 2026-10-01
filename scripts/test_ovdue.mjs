#!/usr/bin/env node
/**
 * ⏳ V78.1.4 總覽「時間到期」文案守門(使用者截圖 2327,台北 03:28)
 *
 * 畫面寫「⏳ 抱滿 20 天・今天尾盤賣」+「已經抱了 40 個交易日 = …抱滿 20 個交易日到了 —— 今天 13:00~13:28 尾盤賣」
 *   → 兩句都不對:① 他早就**超過**上限 20 天,不是「到了」② 那時候已經收盤(半夜),「今天尾盤」不存在。
 *   而那天收盤**鎖漲停**,本站 `_DT_EDGE.lu` 有實測卻沒顯示在這張卡。
 * 釘住:
 *   ⓐ 抱的天數 = 上限、盤中尾盤前 → 照舊「抱滿 N 天・今天尾盤賣」(⛔ 不可把正常情況也改掉)
 *   ⓑ 抱的天數 > 上限 → badge「已超過 X 天」、why 寫「上限 N 天」,⛔ 不可寫「到了」
 *   ⓒ 尾盤窗口過了(13:28 之後)/ 週末 → 「下一個交易日」,⛔ 不可寫「今天 13:00~13:28」
 *   ⓓ 最後一根收盤鎖漲停 → why 有 `[data-ovdue-lu]` 那一行,數字讀 `_DT_EDGE.lu`(決定性對照:改常數畫面跟著變)
 *   ⓔ 沒鎖漲停 → ⛔ 沒有那一行;盤中(isMarketOpen)→ ⛔ 沒有那一行(還沒收盤不知道會不會打開)
 *   ⓕ 靜態:鎖漲停判斷只有 `_luLock` 一份(當沖頁那一行也走它)
 * 注入(逐一確認會紅):`_over` 恆 0 → ⓑ 紅;`_late` 恆 false → ⓒ 紅;拿掉 `_luLock(data)` 那段 → ⓓ 紅
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const CODE = src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

// ── ⓕ 靜態 ──
{
    const n109 = CODE.split('\n').filter(l => /close >= \+?P\.close \* 1\.09/.test(l)).length;
    ok('ⓕ 鎖漲停判斷只有一份(`_luLock`)', n109 === 1 && /_luLock\(d\) \{/.test(CODE), `出現 ${n109} 次`);
    const i = CODE.indexOf('    _dtEdgeHtml(sym) {'), j = CODE.indexOf('\n    },\n', i);
    ok('ⓕb 當沖頁那一行也走 `_luLock`', /this\._luLock\(this\.rawDailyData\)/.test(CODE.slice(i, j)), '');
}

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._ovDecide && !!app._luLock && !!app._exitDistance, null, { timeout: 30000 });

const R = await page.evaluate(() => {
    const out = {};
    // 80 根緩漲(⛔ 不碰任何價格出場線),最後一根可選擇「鎖漲停」(收 = 昨收×1.1 且收在最高)
    const mk = lock => {
        const rows = [];
        for (let i = 0; i < 80; i++) {
            const c = 100 + i * 0.4;
            const d = new Date(Date.UTC(2026, 3, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
            rows.push({ date: d, open: c - 0.2, high: c + 0.5, low: c - 0.6, close: c, volume: 1000 });
        }
        if (lock) { const P = rows[78].close, c = +(P * 1.1).toFixed(2); rows[79] = { ...rows[79], open: P * 1.03, high: c, low: P * 1.02, close: c }; }
        return rows;
    };
    const N = app._maxHold();
    const run = ({ held, lock, wd = 'Wed', min = 11 * 60, open = false }) => {
        const rows = mk(lock);
        const buyIdx = rows.length - 1 - held;     // held = days − 1(進場那根算第 1 天)
        const buyDate = rows[buyIdx].date.replace(/\//g, '-');
        app.currentSymbolId = '2327';
        app._getInventory = () => [{ symbol: '2327', cost: rows[buyIdx].close, shares: 1, buyDate }];
        app.getStockName = s => (s === '2327' ? '國巨' : s);
        app._tpeMinutes = () => ({ wd, min, ymd: '2026-10-01' });
        app.isMarketOpen = () => open;
        const d = app._ovDecide(rows, '2327');
        return d ? { state: d.state, badge: d.badge, why: String(d.why || ''), lu: /data-ovdue-lu/.test(String(d.why || '')), maxd: (app._exitDistance(rows, '2327') || {}).maxd } : null;
    };
    out.N = N;
    out.a = run({ held: N, lock: false });                          // 到了・盤中尾盤前
    out.b = run({ held: N + 20, lock: false });                     // 超過 20 天
    out.c = run({ held: N, lock: false, min: 14 * 60 });             // 尾盤窗口過了
    out.c2 = run({ held: N, lock: false, wd: 'Sat', min: 10 * 60 }); // 週末
    out.c3 = run({ held: N + 20, lock: true, wd: 'Thu', min: 3 * 60 + 28 }); // 使用者那個情境:半夜、超過、鎖漲停
    out.d = run({ held: N, lock: true, min: 14 * 60 });
    const g = app._DT_EDGE.lu.up.open[0]; app._DT_EDGE.lu.up.open[0] = 7.77; app._DT_EDGE.lu.dn.open[0] = 7.77;
    out.d99 = run({ held: N, lock: true, min: 14 * 60 });
    app._DT_EDGE.lu.up.open[0] = g; app._DT_EDGE.lu.dn.open[0] = g;
    const L0 = app._LUDEFER_EDGE.w4.gap; app._LUDEFER_EDGE.w4.gap = 9.99; out.dLud = run({ held: N, lock: true, min: 14 * 60 }); app._LUDEFER_EDGE.w4.gap = L0;
    out.e = run({ held: N, lock: true, min: 11 * 60, open: true });  // 盤中
    return out;
});
await browser.close();

const s = x => JSON.stringify(x && { st: x.state, b: x.badge, w: x.why.replace(/<[^>]+>/g, '').slice(0, 260), m: x.maxd });
ok('🚧 空過守門:五種情境都進到「時間到期」(state=exit、maxd.due)', ['a', 'b', 'c', 'c2', 'd'].every(k => R[k] && R[k].state === 'exit' && R[k].maxd && R[k].maxd.due), s(R.a));
ok(`ⓐ 剛好 ${R.N} 天・尾盤前 → 照舊「抱滿 N 天・今天尾盤賣」+「今天 13:00」`, /抱滿 \d+ 天・今天尾盤賣/.test(R.a.badge) && /今天 13:00/.test(R.a.why) && !/超過/.test(R.a.badge), s(R.a));
ok('ⓑ 超過 20 天 → badge「已超過 20 天」、why 有「上限」,⛔ 沒有「到了」', /已超過 20 天/.test(R.b.badge) && /上限 \d+ 天/.test(R.b.why) && !/」到了/.test(R.b.why), s(R.b));
ok('ⓒ 13:28 之後 → 「下一個交易日」,⛔ 不寫「今天 13:00~13:28」', /下一個交易日/.test(R.c.badge) && /下一個交易日/.test(R.c.why) && !/今天 13:00/.test(R.c.why), s(R.c));
ok('ⓒ2 週末 → 「下一個交易日」', /下一個交易日/.test(R.c2.badge), s(R.c2));
ok('ⓒ3 使用者那個情境(週四 03:28・超過・鎖漲停)→ 「已超過」+「今天就賣」+ 有漲停那一行,⛔ 不寫「回測與自動下單都是今天」', /已超過 20 天・今天就賣/.test(R.c3.badge) && /錯過了/.test(R.c3.why) && !/回測與自動下單都是/.test(R.c3.why) && R.c3.lu, s(R.c3));
ok('ⓓ 收盤鎖漲停 → 有 `[data-ovdue-lu]` 那一行,且寫次數 + 開盤賣', R.d.lu && /鎖漲停/.test(R.d.why) && /開盤賣/.test(R.d.why) && /\d{1,3}(,\d{3})+ 次/.test(R.d.why), s(R.d));
ok('ⓓb 決定性對照:`_DT_EDGE.lu.*.open[0]` 改 7.77 → 畫面跟著變', /\+7\.77%/.test(R.d99.why) && !/\+7\.77%/.test(R.d.why), s(R.d99));
ok('ⓓc 這套自己的回測數字讀 `_LUDEFER_EDGE`(⛔ 寫死)且明講「規則沒改」', /規則沒改/.test(R.d.why) && /989 次/.test(R.d.why) && /\+9\.99%/.test(R.dLud.why), s(R.dLud));
ok('ⓔ 沒鎖漲停 → ⛔ 沒有那一行', !R.a.lu && !R.b.lu && !R.c.lu, '');
ok('ⓔb 盤中(isMarketOpen)→ ⛔ 沒有那一行(還沒收盤)', R.e && !R.e.lu, s(R.e));
ok('無 pageerror', errs.length === 0, errs.join(' | '));

console.log(fails.length ? `\n❌ OVDUE_FAIL(${fails.length}):${fails.join(' / ')}` : '\n✅ OVDUE_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
