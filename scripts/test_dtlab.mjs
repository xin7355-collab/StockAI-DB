#!/usr/bin/env node
/**
 * 🔬 V79.0.3 即時頁 / 當沖頁 / 當沖雷達「沒回測過的判讀收進實驗室模式」守門
 *
 * 釘住的用意(使用者選「整張收進實驗室模式」+「事實在上、結論精簡」):
 *   ① 一般模式:盤中當沖總結燈(#liveLead / #dayTradeLight)、盤中作戰室、盤中六脈、大戶散戶流向 → 看不到、⛔ 不推播
 *      實驗室模式(html.lab):同一批輸入 → 看得到(⭐ 決定性對照:同一份資料只換模式)
 *   ② 六脈共振的推播:一般模式 0 次、實驗室模式 ≥1 次(同一份會亮的資料)
 *   ③ 09:15 當沖候選推播 / 逐筆動能推播:一般模式不啟動
 *   ④ 大戶散戶流向的紀錄日期用**成交時間**(⛔ 不用手機時鐘 —— 週六打開會標成週六)
 *   ⑤ 當沖頁第一行 `_dtTopLine`:排在成本關卡之前、⛔ 研究字樣、讀 `_DT_EDGE.lu`(拿掉 → 整行不顯示)
 *      勝率那塊 `_dtVerdictInner` 只在實驗室模式呼叫
 *   ⑥ 當沖雷達:一般模式切不進去(退回會賺訊號)、按鈕是 labonly
 *   ⑦ 即時頁順序:現價那格(#intradaySummary)在分時圖之前、五檔分頁在分時圖之後、四張判讀卡在 data-labonly
 *   ⑧ 主力動向那句只在實驗室模式
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.DTL_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };
const strip = s => s.split('\n').map(l => l.replace(/\s\/\/\s.*$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');

// ── 靜態 ──
const live = (() => { const a = SRC.indexOf('<div id="subContentLive"'), b = SRC.indexOf('<div id="subContentChart"'); return a > 0 && b > a ? SRC.slice(a, b).replace(/<!--[\s\S]*?-->/g, '') : ''; })();
ok('⓪ 空過守門:切得到即時頁', live.length > 2000, live.length);
const pos = id => live.indexOf(`id="${id}"`);
ok('⑦ 現價那格(#intradaySummary)排在分時圖之前', pos('intradaySummary') > 0 && pos('intradaySummary') < pos('intradayKlineChart'));
ok('⑦b 五檔分頁(#ltab_depth)排在分時圖之後、判讀卡之前', pos('ltab_depth') > pos('intradayKlineChart') && pos('ltab_depth') < pos('intradaySixCard'));
for (const id of ['liveLead', 'liveMoreWrap', 'intradaySixCard', 'whaleFlowCard'])
    ok(`⑦c #${id} 掛 data-labonly`, new RegExp(`data-labonly="1" id="${id}"`).test(live));
const hero = (() => { const a = SRC.indexOf('🎯 今日當沖作戰指令'); return a > 0 ? strip(SRC.slice(a, a + 3000)) : ''; })();
ok('⑤ 當沖頁順序:第一行 → 成本關卡 → 這幾天比較顛 → 資格',
   hero.indexOf('_dtTopLine()') > 0 && hero.indexOf('_dtTopLine()') < hero.indexOf('_dtCostGateHtml(') && hero.indexOf('_dtCostGateHtml(') < hero.indexOf('_calDayVolHtml(') && hero.indexOf('_calDayVolHtml(') < hero.indexOf('${vTone}'),
   hero.slice(0, 300));
ok('⑤b 勝率那塊(_dtVerdictInner)只在實驗室模式呼叫', /showPlan && this\._labMode\(\) \? \(this\._dtVerdictInner\(/.test(hero));
ok('⑤c 「等下面掛單價觸發」(V77.5.1 已刪的東西)⛔ 不再出現', !/掛單價「觸發」/.test(SRC));
ok('③ 09:15 當沖候選推播只在實驗室模式啟動', /if \(this\._labMode\(\)\) this\._startDayTradeAlertWatch\(\)/.test(SRC));
const ftm = (() => { const a = SRC.indexOf('    _fireTickMomentumAlert(m) {'); return a > 0 ? SRC.slice(a, a + 300) : ''; })();
ok('③b 逐筆動能推播:一般模式在入口就 return', /if \(!this\._labMode\(\)\) return;/.test(ftm));
ok('⑧ 主力動向那句只在實驗室模式', /if \(this\._labMode\(\)\) parts\.push\(`<div class="flex items-center gap-1\.5 mb-0\.5"><span class="text-\[10px\] text-gray-500">🔴 盤中主力動向/.test(SRC));
ok('⑥ 當沖雷達按鈕是 labonly', /data-labonly="1" onclick="app\.switchRadarStrategy\('daytrade'\)"/.test(SRC));

// ── 執行期 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderIntradaySix && !!app._dtTopLine, null, { timeout: 60000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    // 合成 1 分 K:一路漲(六脈會共振)
    const bars = []; let c = 100, pv = 0, vv = 0;
    for (let i = 0; i < 80; i++) { c *= 1.0015; pv += c * 100; vv += 100; const m = 540 + i; bars.push({ t: `2026-10-08T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+08:00`, open: c / 1.0015, high: c, low: c / 1.0015, close: c, volume: 100, average: pv / vv }); }
    const q = { price: c, prevClose: 99, openPrice: 100, high: c, low: 100, bidVol: 100, askVol: 100 };
    A.currentSymbolId = '2330';
    A.isMarketOpen = () => true;
    let fired = 0; const _fa = A._fireAlert; A._fireAlert = () => { fired++; };
    const vis = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && e.innerHTML.trim().length > 40; };
    const run = (lab) => {
        document.documentElement.classList.toggle('lab', lab);
        fired = 0; A._isixAlertKey = null; A._isixShade = null;
        try { A._renderIntradayWarRoom(bars, q); } catch (e) { out.err = String(e); }
        try { A._renderIntradaySix(bars, q); } catch (e) { out.err = String(e); }
        A._tickAcc = null;
        const T0 = Date.parse('2026-10-08T09:01:00+08:00');
        const trades = []; for (let i = 0; i < 30; i++) trades.push({ time: (T0 + i * 60000) * 1000, price: 100 + i * 0.1, size: i % 2 ? 60 : 5, bid: 99.9 + i * 0.1, ask: 100 + i * 0.1, serial: i });
        A._updateTickAccum('2330', trades.slice().reverse());
        return { lead: vis('liveLead'), light: vis('dayTradeLight'), war: vis('intradayWarRoom'), six: vis('intradaySixCard'), whale: vis('whaleFlowCard'), fired, shade: !!A._isixShade };
    };
    out.norm = run(false);
    out.lab = run(true);
    document.documentElement.classList.remove('lab');
    A._fireAlert = _fa;
    // ④ 大戶散戶流向日期 = 成交日期
    const t2 = ms => new Date(ms).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
    out.rngA = A._whaleRangeTxt({ tFirst: Date.parse('2026-10-08T09:01:00+08:00'), tLast: Date.parse('2026-10-08T13:25:00+08:00') }, t2);
    out.rngB = A._whaleRangeTxt({ tFirst: Date.parse('2026-09-30T09:01:00+08:00'), tLast: Date.parse('2026-09-30T13:25:00+08:00') }, t2);
    out.rngNone = A._whaleRangeTxt({}, t2);
    out.today = A._dW(new Date());
    // ⑤ 第一行
    out.top = A._dtTopLine();
    const bak = A._DT_EDGE.lu; A._DT_EDGE.lu = null; out.topNoLu = A._dtTopLine(); A._DT_EDGE.lu = bak;
    // ⑥ 雷達:一般模式切不進去
    try { A.switchAppTab('radar'); A.switchRadarMode('strategy'); A.switchRadarStrategy('daytrade'); } catch (_) {}
    out.radarNorm = A.radarStrategy;
    document.documentElement.classList.add('lab');
    try { A.switchRadarStrategy('daytrade'); } catch (_) {}
    out.radarLab = A.radarStrategy;
    document.documentElement.classList.remove('lab');
    return out;
});
if (R.err) console.log('  (render err) ' + R.err);
ok('① 一般模式:總結燈頁首 / 總結燈 / 作戰室 / 六脈 / 大戶散戶 全部看不到', !R.norm.lead && !R.norm.light && !R.norm.war && !R.norm.six && !R.norm.whale, JSON.stringify(R.norm));
ok('① 決定性對照:實驗室模式同一份資料 → 總結燈 / 六脈 / 大戶散戶看得到', R.lab.light && R.lab.six && R.lab.whale, JSON.stringify(R.lab));
ok('② 一般模式:六脈 0 次推播、分時圖不畫紅綠帶', R.norm.fired === 0 && !R.norm.shade, JSON.stringify(R.norm));
ok('② 決定性對照:實驗室模式同一份資料會推播、會畫帶', R.lab.fired >= 1 && R.lab.shade, JSON.stringify(R.lab));
ok('④ 紀錄日期 = 成交那天(10/08)', /10\/08/.test(R.rngA) && /09:01~13:25/.test(R.rngA), R.rngA);
ok('④ 決定性對照:成交日改 09/30 → 日期跟著變', /09\/30/.test(R.rngB) && R.rngB !== R.rngA, R.rngB);
ok('④b 沒有成交時間時 ⛔ 不拿手機時鐘補', !R.rngNone.includes(R.today) && /最近交易日/.test(R.rngNone), R.rngNone);
const topTxt = R.top.replace(/<[^>]+>/g, '');
ok('⑤ 第一行有內容、標 data-dttop', /data-dttop/.test(R.top) && topTxt.length > 40, R.top.slice(0, 120));
ok('⑤ 第一行 ⛔ 研究字樣 / 勝率數字', badOf(topTxt).length === 0, badOf(topTxt).join(' '));
ok('⑤ 決定性對照:拿掉 _DT_EDGE.lu → 整行不顯示', R.topNoLu === '', R.topNoLu.slice(0, 80));
ok('⑥ 一般模式切當沖雷達 → 退回會賺訊號', R.radarNorm === 'todaysig', R.radarNorm);
ok('⑥ 決定性對照:實驗室模式切得進去', R.radarLab === 'daytrade', R.radarLab);
ok('無 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ test_dtlab 全過');
process.exit(fails ? 1 : 0);
