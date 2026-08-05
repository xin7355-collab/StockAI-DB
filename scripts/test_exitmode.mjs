#!/usr/bin/env node
/**
 * 🚪 出場管理狀態:單一劇本原則(V72.4.7)
 *
 * ⚠️ 使用者給總覽頁三張截圖(國巨 2327)後的要求:
 *   「把雜訊移除,讓使用者簡單知道這隻股票要怎麼操作,不要模擬兩可,也不要資訊打架」
 *
 * 截圖抓到的打架:主結論寫「🚪 建議離場」,但同一頁
 *   ・「進場劇本」還在給 進場 558 / 停損 524 / 目標 664.80
 *   ・「上檔空間」還在寫「還有 +8.7% 的空間,一張淨賺 +49,210 元」
 *   → **一邊叫你走、一邊告訴你還能賺**,而且金額還是用「一張」算的(使用者只有 0.07 張)。
 *
 * 這支釘住三條:
 *   ① `_exitMode` 是**單一真相**(⛔ 各卡不可各寫各的判斷)
 *   ② 出場狀態下:進場劇本收起、上檔空間改講「反彈到哪裡該出」
 *   ③ 金額用**實際股數**,標籤跟著改(⛔ 不可金額改了還寫「一張」)
 *
 * 跑法:node scripts/test_exitmode.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const CAND = ['2327', '2330', '2317'];
const SYM = CAND.find(s => fs.existsSync(path.join(ROOT, 'data', `${s}.json`)));
if (!SYM) { console.log('⏭️ 沒有測資,略過'); process.exit(0); }
console.log(`   測資:${SYM}`);

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const pageErrs = [];
page.on('pageerror', e => pageErrs.push(String(e).slice(0, 160)));
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'getInstanceByDom' ? (() => null) : (k === 'graphic' ? {} : noop)) }),
        writable: true, configurable: true,
    });
});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._inExitMode, null, { timeout: 25000 });

const R = await page.evaluate(async (sym) => {
    const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const r = await fetch(`data/${sym}.json`);
    const d = (await r.json()).map(x => ({ ...x, close: +x.close, open: +x.open, high: +x.high, low: +x.low, volume: +x.volume }));
    app.currentSymbolId = sym; app.rawDailyData = d; app.activeData = d;
    const pC = d[d.length - 1].close, last = d.length - 1;
    const out = {};

    // ── 情境 A:出場管理 + 持有 0.07 張(使用者截圖那樣)──────────
    app.inventory = [{ symbol: sym, shares: 70, cost: pC * 0.95 }];
    app._exitMode = { sym, on: true, big: '🚪 建議離場', slF: pC * 0.9 };
    out.exitOn = app._inExitMode(sym);
    const uA = app._upsideRoom(pC, d, last);
    out.upA = strip(app._upsideRoomHtml(uA));
    out.lblA = app._upsideUnitLbl;
    out.sharesA = uA?.shares;
    out.amtA = uA?.list?.[0]?.ntd;
    app.renderPlaybookRadar(d);
    out.pbA = (document.getElementById('playbookRadarCard')?.innerText || '').replace(/\s+/g, ' ');

    // ── 情境 B:非出場狀態、空手 ────────────────────────────────
    app.inventory = [];
    app._exitMode = { sym, on: false, big: '🟢 續抱', slF: null };
    out.exitOff = app._inExitMode(sym);
    const uB = app._upsideRoom(pC, d, last);
    out.upB = strip(app._upsideRoomHtml(uB));
    out.lblB = app._upsideUnitLbl;
    out.amtB = uB?.list?.[0]?.ntd;
    app.renderPlaybookRadar(d);
    out.pbB = (document.getElementById('playbookRadarCard')?.innerText || '').replace(/\s+/g, ' ');

    // ── 切股殘留守門:_exitMode 綁 sym ─────────────────────────
    app._exitMode = { sym: '9999', on: true, big: '🚪 建議離場' };
    out.crossStock = app._inExitMode(sym);

    out.moreCollapsed = !document.getElementById('ovNowMore')?.open;
    out.moreHasCards = ['dailyRecapCard', 'positionSizerCard', 'chuActionCard', 'chuIntradayCard']
        .every(id => document.getElementById('ovNowMore')?.contains(document.getElementById(id)));
    out.srcTrend = app._renderTrendCommand?.toString?.() || '';
    return out;
}, SYM);

ok('⓪ 沒有 pageerror', pageErrs.length === 0, pageErrs.join(' | '));

// ── ① 單一真相 ────────────────────────────────────────────────
ok('① _inExitMode 在出場狀態回 true', R.exitOn === true);
ok('① 非出場狀態回 false', R.exitOff === false);
ok('① ⭐ 綁 sym:別檔的出場狀態不可污染這檔(切股殘留)', R.crossStock === false);
ok('① ⭐ _exitMode 由主卡統一寫入(⛔ 各卡不可各判各的)',
   /_exitMode\s*=\s*\{/.test(R.srcTrend || ''), (R.srcTrend || '').slice(0, 100));

// ── ② 出場狀態:兩張卡都要改口 ────────────────────────────────
ok('② ⭐⛔ 進場劇本必須收起(⛔ 不可再給進場價)',
   /出場管理/.test(R.pbA) && /已收起/.test(R.pbA), R.pbA.slice(0, 140));
ok('② ⛔ 收起時不可還出現「進場」價位欄',
   !/進場\s*[\d,]+\.\d/.test(R.pbA), R.pbA.slice(0, 160));
ok('② ⭐ 上檔空間改講「反彈到哪裡該出」',
   /反彈到哪裡該分批出|減碼點/.test(R.upA), R.upA.slice(0, 180));
ok('② ⭐⛔ 出場狀態不可再寫「還有 X% 的空間…淨賺」(那是叫人買)',
   !/還有\s*\+?[\d.]+%\s*的空間/.test(R.upA), R.upA.slice(0, 180));
ok('② ⭐ 清單標題改成「不是買進目標」', /不是買進目標/.test(R.upA), R.upA.slice(0, 200));
// 非出場狀態要維持原本的說法(⛔ 不可一律改掉)
ok('② 非出場狀態仍講「還有多少空間」(⛔ 不可誤傷正常情況)',
   /還有/.test(R.upB) && /淨賺/.test(R.upB), R.upB.slice(0, 160));
ok('② 非出場狀態進場劇本不可被收起',
   !/已收起/.test(R.pbB), R.pbB.slice(0, 140));

// ── ③ 金額用實際股數 ──────────────────────────────────────────
ok('③ ⭐ 有庫存時 shares 傳進來了', R.sharesA === 70, `shares=${R.sharesA}`);
ok('③ ⭐ 標籤要跟著改成「你手上 0.07 張」(⛔ 不可金額改了還寫一張)',
   /你手上 0\.07 張/.test(R.lblA || ''), `lbl=${R.lblA}`);
ok('③ 空手時退回「一張」', R.lblB === '一張', `lbl=${R.lblB}`);
ok('③ ⭐ 金額真的差 ~14 倍(1000/70)',
   R.amtA && R.amtB && Math.abs((R.amtB / R.amtA) - (1000 / 70)) < 0.6,
   `${R.amtB} / ${R.amtA} = ${(R.amtB / R.amtA).toFixed(1)}x`);

// ── ④ 總覽最上方只留主卡 ──────────────────────────────────────
ok('④ ⭐ 「更多解讀」預設收起', R.moreCollapsed === true);
ok('④ ⭐ 四張次要卡都在摺疊區裡(⛔ 是收起不是刪掉)', R.moreHasCards === true);

await browser.close();
console.log();
if (fails.length) { console.log(`❌ EXITMODE_TEST_FAIL:${fails.length} 條`); process.exit(1); }
console.log('✅ EXITMODE_TEST_PASS');
