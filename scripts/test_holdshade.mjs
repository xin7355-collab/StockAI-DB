#!/usr/bin/env node
/**
 * 📦 V79.0.5 K 線「回測持有區間」守門(外部評估㊽:wkingnet/stock-analysis 的 pyecharts 持有區間)
 *
 * 釘住的用意:
 *   ① 只在實驗室模式:一般模式就算勾了開關也⛔ 不畫(V78.3.4 散戶 App 不放回測成績)
 *   ② ⛔ 不另寫回測:每一塊 = `_patternFitBacktest` 那一招的一趟(進場根 → 出場根),塊數 == 趟數
 *   ③ 賺的紅底、賠的綠底(台股紅漲綠跌 = 方向色)
 *   ④ 決定性對照:換出場規則 → 快取重算、塊跟著變;樣本不夠的招⛔ 不畫
 *   ⑤ 每一趟明細(trips)⛔ 不寫進 localStorage
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.HS_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };

// ── 靜態 ──
ok('⑤ 寫 playbook_ 快取前先剝掉 trips', /ranked: ranked\.map\(\(\{ trips, \.\.\.r \}\) => r\)/.test(SRC));
ok('① 開關是 data-labonly', /<label data-labonly="1"[^>]*><input type="checkbox" id="toggleHoldShade"/.test(SRC));
ok('② renderChart 讀 _holdShadeTrips(⛔ 不在 renderChart 裡另寫回測)', /const hs = this\._holdShadeTrips\(data\);/.test(SRC) && /markArea: _holdArea,/.test(SRC));

// ── 執行期 ──
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', process.env.HS_SYM || '2330.json'), 'utf8'));
if (!Array.isArray(rows) || rows.length < 200) { console.log('❌ 測資不足'); process.exit(1); }
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._holdShadeTrips && !!app.renderChart, null, { timeout: 60000 });
await new Promise(r => setTimeout(r, 1500));

const R = await page.evaluate((rows) => {
    const A = app, out = {};
    let last = null;
    A.chartInstance = { setOption: o => { last = o; }, getOption: () => null, resize() {}, dispose() {}, on() {}, off() {}, dispatchAction() {} };
    A.activeData = rows; A.rawDailyData = rows; A.currentSymbolId = '2330'; A.currentTF = 'D';
    A.indicators = A.indicators || {}; A.peaks = []; A.troughs = []; A.showPeaks = false; A.showPatterns = false;
    try { A.renderChartHud = () => {}; } catch (_) {}
    const cb = document.getElementById('toggleHoldShade');
    const draw = () => { last = null; try { A.renderChart(); } catch (e) { out.err = String(e && e.stack || e); } return last && last.series && last.series[0] ? last.series[0].markArea : 'no-option'; };
    cb.checked = true;
    document.documentElement.classList.remove('lab'); A._holdShadeCache = null;
    out.normal = draw();
    document.documentElement.classList.add('lab'); A._holdShadeCache = null;
    out.lab = draw();
    const ranked = A._patternFitBacktest(rows) || [];
    const top = ranked.find(r => r.expectancy > 0 && A._wrEnough(r.count));
    out.top = top ? { key: top.key, n: top.count, trips: top.trips } : null;
    out.dates = rows.map(d => d.date);
    cb.checked = false; out.off = draw(); cb.checked = true;
    // ④ 決定性對照:換出場規則 → 重算
    const _k = A._exitRuleKey; const now = _k.call(A);
    const alt = (A._EXIT_RULE_OPTS || []).map(o => o.k).find(k => k !== now);
    A._exitRuleKey = () => alt;
    const r2 = (A._patternFitBacktest(rows) || []).find(r => r.expectancy > 0 && A._wrEnough(r.count));
    out.alt = { k: alt, area: draw(), top: r2 ? { key: r2.key, trips: r2.trips } : null };
    A._exitRuleKey = _k;
    // ④b 樣本都不夠 → 不畫:讓 _wrEnough 永遠 false
    const _w = A._wrEnough; A._wrEnough = () => false; A._holdShadeCache = null;
    out.noEnough = draw(); A._wrEnough = _w;
    // ⑤ 跑一次回測頁卡,看 localStorage
    try { localStorage.removeItem('playbook_2330'); } catch (_) {}
    return out;
}, rows);

ok('🚧 renderChart 沒出錯', !R.err, R.err);
ok('🚧 有樣本夠的那一招(否則量不到)', R.top && R.top.trips && R.top.trips.length >= 3, JSON.stringify(R.top && R.top.key));
ok('① 一般模式:勾了也⛔ 不畫', R.normal === undefined, String(JSON.stringify(R.normal)).slice(0, 120));
ok('① 實驗室模式:畫出來', R.lab && Array.isArray(R.lab.data) && R.lab.data.length > 0, String(JSON.stringify(R.lab)).slice(0, 120));
ok('① 開關關掉 → ⛔ 不畫', R.off === undefined);
if (R.lab && R.top) {
    ok('② 塊數 == 那一招的趟數', R.lab.data.length === R.top.trips.length, `${R.lab.data.length} vs ${R.top.trips.length}`);
    const allMatch = R.top.trips.every((t, k) => R.lab.data[k][0].xAxis === R.dates[t.i] && R.lab.data[k][1].xAxis === R.dates[Math.min(t.j, R.dates.length - 1)]);
    ok('② 每一塊的起訖 == 進場根 / 出場根', allMatch);
    // ⭐ 用 K 線收盤自己算賺賠(⛔ 不拿 trips.r 跟自己比 —— 那樣 r 算反了也對得上)
    const colOk = R.top.trips.every((t, k) => (rows[t.j].close > rows[t.i].close) === /248,113,113/.test(R.lab.data[k][0].itemStyle.color));
    ok('③ 賺 = 紅底、賠 = 綠底(用收盤獨立驗)', colOk);
    ok('③b 最後一塊標出是哪一招', R.lab.data[R.lab.data.length - 1][0].label.formatter === R.top.key);
}
ok('④ 換出場規則 → 塊跟著那一套的 trips 走', R.alt.area && R.alt.top && R.alt.area.data.length === R.alt.top.trips.length && JSON.stringify(R.alt.top.trips) !== JSON.stringify(R.top && R.top.trips), `${R.alt.k} ${R.alt.area && R.alt.area.data && R.alt.area.data.length}`);
ok('④b 樣本都不夠 → ⛔ 不畫', R.noEnough === undefined);
ok('🚧 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ test_holdshade 全過');
process.exit(fails ? 1 : 0);
