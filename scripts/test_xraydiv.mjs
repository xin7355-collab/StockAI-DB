#!/usr/bin/env node
/**
 * 🎁 股利政策三格被洗成 `--` + 燈號鐵則違規(V73.9.5)測試
 *
 * 使用者截圖(富喬 1815):
 *  🚨 ① 股利政策「殖利率 / 發配率 / 每股股利」三格全是 `--`,
 *       但**同一張卡**的「填息機率 100% ・ 平均填息天數 3 天」有值 —— 自相矛盾。
 *       (而且實測資料裡 `fund_yoy_gm.json['1815']` 明明有 `payout:8.3 / div:0.3`,
 *        `fundamentals_cache.json['1815']` 也有 `yield_rate:1.11` —— **資料一直都在**。)
 *  🚨 ② 「🟢 超預期空間大」—— 拿 🟢 表示「好事」,而台股 🟢 = 跌 → **讀起來剛好相反**;
 *       更糟的是同一張卡的邊框是 `red`(漲)→ emoji 跟顏色**自己打架**。
 *
 * 🔍 ① 的真因是**兩個寫入者打架**:
 *   ・`fetchFundamentalAnalysis` 有完整 fallback 鏈(會去 fund_yoy_gm 撈)
 *   ・`_applyFundamentalsToXray` **沒有**,而且讀的欄位名 `payout_ratio`/`total_dividend`
 *     在資料裡**根本不存在**(實際叫 `payout`/`div`)
 *   → 它後跑就把填好的格子洗成 `--`(`el.innerText = val ?? '--'`)。
 *
 * ⛔ 這支要釘死的五件事:
 *   ① 拿不到值時 ⛔ **不可覆蓋已經有真值的格子**。
 *   ② ⚠️ 但**反過來也不可以**:格子原本是空的('--'/'—')就該寫 '--',
 *      ⛔ 不然切股殘留會變成另一個更危險的 bug(陷阱 #19)。
 *   ③ 欄位名要吃得到實際存在的那幾個(payout / div / total_dividend_4q)。
 *   ④ 燈號鐵則:講好壞/風險 ⛔ 不可用 🔴🟢🟡,要用 ✅ ⚠️ ⛔ ➖。
 *   ⑤ emoji 與邊框顏色 ⛔ 不可互相矛盾。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ④⑤ 靜態:燈號鐵則 ─────────────────────────────────────────────
{
    const i = src.indexOf('let verdict, cls, tip;');
    const blk = i > 0 ? src.slice(i, i + 1400) : '';
    ok('④ 🚨 空過守門:抓得到那段判定', blk.length > 200, blk.length);
    const verdicts = [...blk.matchAll(/verdict = '([^']+)'/g)].map(m => m[1]);
    ok('④b 抓到三個 verdict', verdicts.length === 3, verdicts);
    ok('④c 🚨 講「好壞/風險」⛔ 不可用 🔴🟢🟡(台股 🟢=跌,用來表示「好」會讀反)',
       !verdicts.some(v => /🔴|🟢|🟡/.test(v)), verdicts);
    ok('④d 要改用非顏色圖示(✅ ⚠️ ⛔ ➖)',
       verdicts.every(v => /✅|⚠️|⛔|➖|🚨/.test(v)), verdicts);
    // ⑤ emoji 與邊框顏色不可矛盾:紅框(漲/好)配綠燈,或綠框配紅燈
    const pairs = [...blk.matchAll(/verdict = '([^']+)'; cls = '(\w+)'/g)].map(m => [m[1], m[2]]);
    const clash = pairs.filter(([v, c]) => (/🟢/.test(v) && c === 'red') || (/🔴/.test(v) && c === 'green'));
    ok('⑤ ⛔ emoji 與邊框顏色不可互相矛盾(舊版:🟢 配 red 框)', !clash.length, clash);
}

// ── 前端實跑 ─────────────────────────────────────────────────────
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._applyFundamentalsToXray, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const g = id => (document.getElementById(id)?.innerText || '').trim();
    const setRaw = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
    const out = {};

    // ① 情境:另一條路徑已經把三格填好了(fetchFundamentalAnalysis 的成果),
    //    然後這支帶著「沒有那些欄位」的 fund 進來 → ⛔ 不可以洗掉
    setRaw('xrayYield', '1.11%'); setRaw('xrayPayout', '8.3%'); setRaw('xrayDividend', '0.30 元');
    app._applyFundamentalsToXray({ pe: 26.06 });          // 只有 pe,其餘都沒有
    out.keep = [g('xrayYield'), g('xrayPayout'), g('xrayDividend')];

    // ② 反向:格子本來就是空的 → 該寫 '--'(⛔ 不可因為怕洗掉就永遠不寫)
    setRaw('xrayYield', '--'); setRaw('xrayPayout', '—'); setRaw('xrayDividend', '');
    app._applyFundamentalsToXray({ pe: 1 });
    out.blank = [g('xrayYield'), g('xrayPayout'), g('xrayDividend')];

    // ③ 欄位名:採礦端原名 payout / div 要吃得到
    setRaw('xrayYield', '--'); setRaw('xrayPayout', '--'); setRaw('xrayDividend', '--');
    app._applyFundamentalsToXray({ yield_rate: 1.11, payout: 8.3, div: 0.3 });
    out.byMinerNames = [g('xrayYield'), g('xrayPayout'), g('xrayDividend')];

    // ③b merge 寫的 total_dividend_4q 也要吃得到
    setRaw('xrayDividend', '--');
    app._applyFundamentalsToXray({ total_dividend_4q: 2.5 });
    out.by4q = g('xrayDividend');

    // ③c 舊欄位名仍要相容(⛔ 不可改壞既有路徑)
    setRaw('xrayPayout', '--'); setRaw('xrayDividend', '--');
    app._applyFundamentalsToXray({ payout_ratio: 55, total_dividend: 4 });
    out.legacy = [g('xrayPayout'), g('xrayDividend')];
    return out;
});
await browser.close();

ok('① 🚨 拿不到值時 ⛔ 不可把已經有真值的格子洗成 `--`(這就是使用者截圖那個 bug)',
   R.keep.join('|') === '1.11%|8.3%|0.30 元', R.keep);
ok('② ⚠️ 但格子本來是空的就該寫 `--`(⛔ 不可矯枉過正變成切股殘留,陷阱 #19)',
   R.blank.every(v => v === '--'), R.blank);
ok('③ 🚨 要吃得到採礦端的原欄位名 payout / div(舊版讀 payout_ratio/total_dividend → 永遠 undefined)',
   R.byMinerNames[0].startsWith('1.11') && R.byMinerNames[1].startsWith('8.3') && R.byMinerNames[2].startsWith('0.3'),
   R.byMinerNames);
ok('③b merge 寫的 total_dividend_4q 也要吃得到', R.by4q.startsWith('2.5'), R.by4q);
ok('③c 舊欄位名仍相容(⛔ 不可改壞既有路徑)',
   R.legacy[0].startsWith('55') && R.legacy[1].startsWith('4'), R.legacy);
ok('⑥ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ XRAYDIV_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
