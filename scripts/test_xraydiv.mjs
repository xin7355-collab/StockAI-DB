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

// ── 🧬 V77.0.2 靜態:營收年增只准有一份優先序 + 虧損封頂 ────────────
{
    const strip = t => t.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // ⚠️ 終點⛔ 不可用 `_applyFundamentalsToXray`(它排在**前面**)也⛔ 不可用寫死的字元數
    //   —— 第一版兩個都踩到:切片提早結束 → 月營收圖那行根本沒被掃到 = 假綠燈。
    const i = src.indexOf('    async fetchFundamentalAnalysis('), j = src.indexOf('async fetchCorpEvents(', i);
    const blk = strip(src.slice(i, j > i ? j : i + 60000));
    ok('🧬a 空過守門:抓得到 fetchFundamentalAnalysis 那一整段', i > 0 && blk.length > 3000, blk.length);
    // 🚨 真因:同一個「營收年增」有兩條**相反**的優先序 —— `_revYoY` 是 fund_yoy_gm 先、
    //    這裡是 fundamentals_cache 先 → 6706 分數吃到 −26.1%(舊 rotation)而報告頁是 +120.5%。
    ok('🧬a2 🚨 基本面分數的營收年增必須走 `_revYoY`(⛔ 不可自己再排一套優先序;三種舊寫法任一注回去 → 紅)',
       /_revYoY\(/.test(blk)
       && !/latestYoy == null && typeof _fcv\.rev_yoy/.test(blk)
       && !/latestYoy == null && typeof _v\.yoy/.test(blk)
       && !/latestYoy = Number\(localFund\.revenue_yoy\)/.test(blk),   // ⚠️ 籌碼檔在 `_revYoY` 裡排**最後**,直接 fallback 會蓋掉 fund_yoy_gm
       (blk.match(/latestYoy == null[^\n]*/g) || []).join(' | ').slice(0, 200));
    ok('🧬a3 ⚠️ 月營收圖的那行摘要也要讀同一個 `latestYoy`(⛔ 同一畫面不可出現第二個「年增」)',
       /const yoy = Number\.isFinite\(\+latestYoy\)/.test(blk) && !/haveMineYoY/.test(blk));
    const lc = strip(src.slice(src.indexOf('    _lossCapOf(sym) {'), src.indexOf('    _xrayScoreOf(m) {')));
    ok('🧬b 🩸 虧損封頂 `_lossCapOf` 存在,且判準只認「近 4 季 ROE」與「最新一季 EPS」',
       lc.length > 200 && /roe4/.test(lc) && /\.eps/.test(lc) && /cap: 0\.30/.test(lc), lc.length);
    const xs = strip(src.slice(src.indexOf('    _xrayScoreOf(m) {'), src.indexOf('    _renderXrayVerdict() {')));
    ok('🧬b2 `_xrayScoreOf` 真的有套上封頂(⛔ 寫好了沒接 = 陷阱 #37),而且理由要寫進 neg',
       /const lossCap = this\._lossCapOf\(m\.sym\)/.test(xs) && /pct = lossCap\.cap/.test(xs) && /neg\.push\(`\$\{lossCap\.why\}/.test(xs), xs.length);
    ok('🧬b3 ⚠️ pct 必須是 `let`(封頂要改寫它;`const` 會被空 catch 吞成「卡片直接不見」—— 陷阱 #33)',
       /let pct = max > 0 \? score \/ max : null;/.test(xs));
    // 💲 `+null === 0` —— 上一版在 `_rpPxTableHtml` 修過的同一個坑
    ok('💲a 🚨 報告頁唯一的格式化器 `_rpFmt`/`_rpPct` ⛔ 不可用裸 `Number.isFinite(+n)`(`+null === 0` 會把「沒有」印成 0.0)',
       /_rpFmt\(n, d = 1\) \{ return \(n != null && n !== '' && Number\.isFinite\(\+n\)\)/.test(src)
       && /_rpPct\(n, d = 1\) \{ return \(n != null && n !== '' && Number\.isFinite\(\+n\)\)/.test(src));
    ok('💲a2 🚨 股價淨值比的 fallback 鏈必須要求 > 0(`fen.pb: null` 會短路成 0,害 fund_yoy_gm 真的有的值永遠讀不到)',
       /const pb = _fp\(fc\?\.pbr\) \?\? _fp\(fen\?\.pb\) \?\? _fp\(fy\?\.pb\);/.test(src));
    ok('💲a3 ⚠️ 但殖利率 0% 是合法值 → ⛔ 不可一律改成 > 0(只擋 null/\'\')',
       /const yld = _fv\(fc\?\.yield_rate\) \?\? _fv\(fen\?\.yield_rate\) \?\? null;/.test(src));
    ok('💲a4 虧損股的本益比要印「—(虧損)」⛔ 不是 0.0x(海報 + 提示詞兩處都要)',
       /'—\(虧損\)'/.test(src) && /—\(公司在虧損 → 沒有本益比/.test(src));
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
    // 🚨 V75.0.3:這幾格住在基本面頁的 `<details>` 裡,而 V74.2.6 起它**預設收起** ——
    //    收起的 details 內容不算「有被渲染」→ `innerText` 回**空字串**。
    //    ⭐⭐ 這裡**刻意不展開**,因為那正是正式環境的預設狀態:
    //       App 的守門本來也讀 `innerText` → 每一格都被判成「空的」→
    //       V73.9.5 那道「⛔ 不可洗掉已有真值」的守門整個失效(真 bug,已修成 textContent)。
    //    ⛔ 所以讀值一律用 `textContent`(問「這一格有沒有內容」),
    //       `innerText`(問「使用者現在看不看得到」)在這裡會量到錯的東西。
    const g = id => (document.getElementById(id)?.textContent || '').trim();
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

// ── 🩸 V77.0.2 行為:虧損封頂真的會壓下去(⛔ 不是只驗「有那個欄位」)────
//   ⭐ 決定性對照組:**同一組指標**、只換 fin 切片的 roe4/eps 正負,分數必須明顯不同。
const LC = await page.evaluate(() => {
    const A = app;
    // 這組指標刻意「看起來很好」:營收年增 +120%(6706 真值)+ 三率三升 + 殖利率
    const m = () => ({ sym: '__T', yoy: 120.5, triV: { txt: '三率三升' }, pe: 12, yield: 4 });
    A._finSlimCache = A._finSlimCache || {};
    const run = (fin) => { A._finSlimCache['__T'] = { ts: Date.now(), data: fin }; const R = A._xrayScoreOf(m()); return { pct: R.pct, verdict: R.verdict, neg: R.neg.join(' / '), cap: !!R.lossCap }; };
    return {
        // 6706 惠特的真實數字(data/fin/6706.json 實查)
        loss: run({ roe4: -7.1, q: [{ p: '2026-06-30', eps: -1.89, nm: -83.7 }] }),
        prof: run({ roe4: 18.2, q: [{ p: '2026-06-30', eps: 5.20, nm: 31.4 }] }),
        epsOnly: run({ roe4: 3.1, q: [{ p: '2026-06-30', eps: -0.4, nm: -2.0 }] }),
        none: run(null),   // 沒有 fin 切片 → ⛔ 不可亂封頂
    };
});
await browser.close();

ok('🩸c1 空過守門:對照組(獲利)真的算得出一個高分,⛔ 不是兩邊都 null',
   LC.prof.pct != null && LC.prof.pct > 0.55, JSON.stringify(LC.prof));
ok('🩸c2 🚨 虧損股(ROE −7.1% / EPS −1.89)→ 分數封頂 ≤0.30,而且 verdict 落到「體質偏弱」',
   LC.loss.pct != null && LC.loss.pct <= 0.30 && /偏弱/.test(LC.loss.verdict), JSON.stringify(LC.loss));
ok('🩸c3 ⭐ 決定性對照:同一組指標、只換正負 → 分數必須明顯不同(注入拿掉封頂 → 兩邊一樣 → 紅)',
   LC.prof.pct - LC.loss.pct > 0.2, `${LC.prof.pct} vs ${LC.loss.pct}`);
ok('🩸c4 卡上要寫出**為什麼**被封頂(⛔ 不可默默扣分)',
   /ROE/.test(LC.loss.neg) && /封頂/.test(LC.loss.neg), LC.loss.neg);
ok('🩸c5 只有 EPS 負(ROE 還是正的)也要封頂', LC.epsOnly.cap === true && LC.epsOnly.pct <= 0.30, JSON.stringify(LC.epsOnly));
ok('🩸c6 ⚠️ 沒有財報切片時 ⛔ 不可亂封頂(不然冷門股會被誤殺)',
   LC.none.cap === false && LC.none.pct === LC.prof.pct, JSON.stringify(LC.none));


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
