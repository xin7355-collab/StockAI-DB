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
 *
 * ⏳ V78.1.6 精簡卡(使用者附圖:「你那套講太多文字了」「改明日開盤」):
 *   ⓒ 收盤後的日子改講「明天 / 下週一」(⛔ 不再寫抽象的「下一個交易日」);鎖漲停 → 徽章「開盤照規則」
 *   ⓗ 鎖漲停 → 卡上有 4 條明日規則 + 後天一行,數字讀 `_LUNEXT_EDGE`(決定性對照 8.88)
 *   ⓘ `_dueWhen().openWhen`:週四 15:00 明天 / 週五 15:00 下週一 / 週四 03:28 今天 / 週六 下週一
 *   ⓙ 卡片第一眼(摺疊關著)字數 ≤ 完整說明的 60%,完整說明在 `[data-ovdue-more]` 裡(⛔ 沒被刪)
 *   ⓚ 提示那行 ⛔ 不是紅框;現價正值紅字
 *   ⓛ 390px 不溢出;≥768px 兩欄(lib_rwdshim)
 *   注入:規則寫死 / 提示改紅框 / 拿掉摺疊 → 都要紅
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
    ok('ⓕ 鎖漲停判斷只有一份(`_luLock`)', n109 === 1 && /_luLock\(d(, o)?\) \{/.test(CODE), `出現 ${n109} 次`);
    const i = CODE.indexOf('    _dtEdgeHtml(sym) {'), j = CODE.indexOf('\n    },\n', i);
    ok('ⓕb 當沖頁那一行也走 `_luLock`', /this\._luLock\(this\.rawDailyData\)/.test(CODE.slice(i, j)), '');
}

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const { rwdShim } = await import(path.join(ROOT, 'scripts/lib_rwdshim.mjs'));
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
        // 🧾 V78.1.6 也真的畫一次卡片(量第一眼字數 / 規則 / 摺疊 / 提示框)
        let card = null;
        try {
            app.activeData = rows; app.rawDailyData = rows;
            app._renderOvCommand(rows);
            const el = document.getElementById('ovCommandCenter');
            const more = el && el.querySelector('[data-ovdue-more]');
            const first = (() => { if (!el) return ''; const c = el.cloneNode(true); c.querySelectorAll('details').forEach(x => x.remove()); return c.textContent.replace(/\s/g, ''); })();
            const tipRow = el && el.querySelector('[data-ovdue-row="提示"]');
            card = { html: el ? el.innerHTML : '', firstLen: first.length, moreLen: more ? more.textContent.replace(/\s/g, '').length : 0,
                     rules: el ? el.querySelectorAll('[data-ovdue-rule]').length : 0, rulesTxt: (el && el.querySelector('[data-ovdue-rules]') || {}).textContent || '',
                     tipCls: tipRow ? tipRow.innerHTML : '', moreOpen: more ? more.open : null };
        } catch (e) { card = { err: String(e) }; }
        return d ? { state: d.state, badge: d.badge, why: String(d.why || ''), lu: /data-ovdue-lu/.test(String(d.why || '')), maxd: (app._exitDistance(rows, '2327') || {}).maxd, card } : null;
    };
    out.N = N; window.__run = run;
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
    const H0 = app._LUNEXT_EDGE.S.S1.hold.d; app._LUNEXT_EDGE.S.S1.hold.d = 8.88; out.dTree = run({ held: N, lock: true, min: 14 * 60 }); app._LUNEXT_EDGE.S.S1.hold.d = H0;
    out.e = run({ held: N, lock: true, min: 11 * 60, open: true });  // 盤中
    // ⓘ openWhen
    const ow = (wd, min) => { app._tpeMinutes = () => ({ wd, min, ymd: '2026-10-01' }); return app._dueWhen().openWhen; };
    out.ow = { thu15: ow('Thu', 15 * 60), fri15: ow('Fri', 15 * 60), thu0328: ow('Thu', 3 * 60 + 28), sat: ow('Sat', 10 * 60), wed11: ow('Wed', 11 * 60) };
    return out;
});
// ⓛ 版面:把卡片複製到已知寬度的容器量(沙箱沒有 Tailwind → 先注入共用 shim)
const shimBad = await page.evaluate(rwdShim);
const lay = async (vw, boxW) => {
    await page.setViewportSize({ width: vw, height: 844 });
    return page.evaluate(({ boxW }) => {
        const r = window.__run({ held: app._maxHold() + 20, lock: true, wd: 'Wed', min: 14 * 60 });
        const box = document.createElement('div'); box.style.cssText = `position:absolute;left:0;top:0;width:${boxW}px;background:#0d1117`;
        box.innerHTML = r.card.html; document.body.appendChild(box);
        const g = box.querySelector('.ov-due-grid'), br = box.getBoundingClientRect();
        let over = 0; box.querySelectorAll('*').forEach(e => { const b = e.getBoundingClientRect(); if (b.width && b.right > br.right + 1) over = Math.max(over, b.right - br.right); });
        const cols = g ? getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
        const out = { w: br.width, cols, over: +over.toFixed(1) }; box.remove(); return out;
    }, { boxW });
};
const L390 = await lay(390, 358), L1024 = await lay(1024, 700);
await browser.close();

const s = x => JSON.stringify(x && { st: x.state, b: x.badge, w: x.why.replace(/<[^>]+>/g, '').slice(0, 260), m: x.maxd });
ok('🚧 空過守門:五種情境都進到「時間到期」(state=exit、maxd.due)', ['a', 'b', 'c', 'c2', 'd'].every(k => R[k] && R[k].state === 'exit' && R[k].maxd && R[k].maxd.due), s(R.a));
ok(`ⓐ 剛好 ${R.N} 天・尾盤前 → 照舊「抱滿 N 天・今天尾盤賣」+「今天 13:00」`, /抱滿 \d+ 天・今天尾盤賣/.test(R.a.badge) && /今天 13:00/.test(R.a.why) && !/超過/.test(R.a.badge), s(R.a));
ok('ⓑ 超過 20 天 → badge「已超過 20 天」、why 有「上限」,⛔ 沒有「到了」', /已超過 20 天/.test(R.b.badge) && /上限 \d+ 天/.test(R.b.why) && !/」到了/.test(R.b.why), s(R.b));
ok('ⓒ 週三 14:00(尾盤過了)→ 「明天尾盤賣」,⛔ 不寫「今天 13:00~13:28」', /抱滿 \d+ 天・明天尾盤賣/.test(R.c.badge) && /明天就賣/.test(R.c.why) && !/今天 13:00/.test(R.c.why), s(R.c));
ok('ⓒ2 週末 → 「下週一」', /下週一尾盤賣/.test(R.c2.badge), s(R.c2));
ok('ⓒ3 使用者那個情境(週四 03:28・超過・鎖漲停)→ 「已超過 20 天・今天開盤照規則」+ 有漲停那一行,⛔ 不寫「回測與自動下單都是今天」', /已超過 20 天・今天開盤照規則/.test(R.c3.badge) && /錯過了/.test(R.c3.why) && !/回測與自動下單都是/.test(R.c3.why) && R.c3.lu, s(R.c3));
ok('ⓒ4 收盤後鎖漲停(週三 14:00)→ 徽章「明天開盤照規則」(使用者:改明日開盤)', /明天開盤照規則/.test(R.d.badge), R.d.badge);
ok('ⓓ 收盤鎖漲停 → 有 `[data-ovdue-lu]` 那一行,且寫次數 + 開盤賣', R.d.lu && /鎖漲停/.test(R.d.why) && /開盤賣/.test(R.d.why) && /\d{1,3}(,\d{3})+ 次/.test(R.d.why), s(R.d));
ok('ⓓb 決定性對照:`_DT_EDGE.lu.*.open[0]` 改 7.77 → 畫面跟著變', /\+7\.77%/.test(R.d99.why) && !/\+7\.77%/.test(R.d.why), s(R.d99));
ok('ⓓc 這套自己的回測數字讀 `_LUDEFER_EDGE`(⛔ 寫死)且明講「規則沒改」', /規則沒改/.test(R.d.why) && /989 次/.test(R.d.why) && /\+9\.99%/.test(R.dLud.why), s(R.dLud));
ok('ⓖ 收盤鎖漲停 → 有「明天開盤看到哪一種」決策表(三種開盤 + 後天)', /data-lunext/.test(R.d.why) && /開盤就在漲停/.test(R.d.why) && /開盤就賣/.test(R.d.why) && /別在開盤殺/.test(R.d.why) && /後天/.test(R.d.why), s(R.d));
ok('ⓖb 決策表數字讀 `_LUNEXT_EDGE`(決定性對照:改 8.88 → 畫面跟著變)', /\+8\.88%/.test(R.dTree.why) && !/\+8\.88%/.test(R.d.why), s(R.dTree));
ok('ⓖc 沒鎖漲停 → ⛔ 沒有決策表', !/data-lunext/.test(R.a.why + R.b.why + R.c.why), '');
ok('ⓔ 沒鎖漲停 → ⛔ 沒有那一行', !R.a.lu && !R.b.lu && !R.c.lu, '');
ok('ⓔb 盤中(isMarketOpen)→ ⛔ 沒有那一行(還沒收盤)', R.e && !R.e.lu, s(R.e));
// ── V78.1.6 精簡卡 ──
const C = k => (R[k] && R[k].card) || {};
ok('🚧 卡片真的畫出來了(三個情境都有 [data-ovdue-card])', ['a', 'd', 'c3'].every(k => /data-ovdue-card/.test(C(k).html || '')), JSON.stringify(C('d')).slice(0, 300));
ok('ⓗ 鎖漲停 → 4 條明日規則(一字鎖抱 / 開高 ≥5% 開盤賣 / 開高 0~5% 09:30 / 開平開低尾盤)+ 後天', C('d').rules === 4 && /先抱著/.test(C('d').rulesTxt) && /開盤就賣/.test(C('d').rulesTxt) && /09:30/.test(C('d').rulesTxt) && /尾盤賣/.test(C('d').rulesTxt) && /後天/.test(C('d').rulesTxt), C('d').rulesTxt);
ok('ⓗb 決定性對照:`_LUNEXT_EDGE.S.S1.hold.d` 改 8.88 → 卡上規則跟著變', /\+8\.88%/.test(C('dTree').rulesTxt) && !/\+8\.88%/.test(C('d').rulesTxt), C('dTree').rulesTxt);
ok('ⓗc 沒鎖漲停 → ⛔ 沒有規則', C('a').rules === 0 && C('c').rules === 0, '');
ok('ⓘ openWhen:週四 15:00 明天 / 週五 15:00 下週一 / 週四 03:28 今天 / 週六 下週一 / 週三 11:00 今天',
   R.ow.thu15 === '明天' && R.ow.fri15 === '下週一' && R.ow.thu0328 === '今天' && R.ow.sat === '下週一' && R.ow.wed11 === '今天', JSON.stringify(R.ow));
ok('ⓙ 第一眼(摺疊關著)字數 ≤ 完整說明的 60%,而且完整說明在 [data-ovdue-more] 裡(⛔ 沒被刪)',
   C('d').moreLen > 300 && C('d').firstLen <= C('d').moreLen * 0.6 && C('d').moreOpen === false && /data-ovdue-lu/.test(C('d').html) && /data-lunext/.test(C('d').html), `first ${C('d').firstLen} / more ${C('d').moreLen}`);
ok('ⓚ 提示那行 ⛔ 不是紅框(紅色在本站 = 漲)', C('d').tipCls && !/red/.test(C('d').tipCls), C('d').tipCls);
ok('🚧 版面 shim 全部生效(否則幾何不可信)', Array.isArray(shimBad) && shimBad.length === 0, JSON.stringify(shimBad));
ok('ⓛ 390px:卡片單欄、沒有東西超出容器', L390.w >= 350 && L390.cols === 1 && L390.over <= 1, JSON.stringify(L390));
ok('ⓛb ≥768px:左右兩欄、沒有超出', L1024.cols === 2 && L1024.over <= 1, JSON.stringify(L1024));
ok('無 pageerror', errs.length === 0, errs.join(' | '));

console.log(fails.length ? `\n❌ OVDUE_FAIL(${fails.length}):${fails.join(' / ')}` : '\n✅ OVDUE_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
