#!/usr/bin/env node
/**
 * 🌅 V79.5.2 盤前體檢「逐欄位日期」+ 開盤之後 ⛔ 不預測
 *
 * 🚨 2026-10-22 使用者截圖:盤前體檢寫「開高偏多 75/100 ・盤中型態:開高走高 → 順勢做多」,
 *    分析師那段寫「今日開盤受亞股拖累(韓股 −3.7%、日經 −1.3%)…台股易開低同步承壓」。
 *    實際:0050 開盤 +0.75%(開高對了)、開盤到收盤 −1.88%。查到三件事:
 *    ① 08:12 那份檔案時間是新的,但日經 / 韓股 / 恆指、台積電 / 日月光 / 聯電 ADR 是 10/20(兩個交易日前)
 *       → 分數照樣把它們加減進去(`_macroFresh` 只看整份檔的時間)
 *    ② 「盤中型態」四類從來沒有回測過,也沒過守門 → 同一頁一邊「順勢做多」一邊「做短不加碼」
 *    ③ 分析師把前一兩天的亞股講成「今日開盤」;亞股前一天對台股隔天幾乎沒有預測力(overseas_probe)
 *
 * ⛔ 釘死:
 *   ⓪ `_premktFieldAge` 全 App 只有一份,三處都接(分數 / 分析師 / 全球快讀)
 *   ① 判斷:亞股比「台股上一個交易日」舊、ADR 比「美股指數那一天」舊 → 舊;台股那天取 taiex 與法人日期比較早的
 *   ② 分數:舊的那幾項 0 分並寫「資料舊了」;⭐ 決定性對照:同一份資料把日期改新 → 那幾項照常算分
 *   ③ 卡片 ⛔ 不可再有「盤中型態 / 順勢做多 / 開高走高 / 別接刀 / 逃命波」;要有「📌 今天怎麼看」與「不預測」
 *   ④ 分析師:前一天的寫「台股那天已經一起反映」、今天的寫「今天亞股開盤」、太舊的不講;⛔「今日開盤 / 易開低 / 拖累」
 *   ⑤ 全球快讀:⛔「別追多 / 別接刀 / 同步承壓」;太舊的要寫「不算分」
 *
 * 注入驗證:`HTML=<另一份 index.html>` 讀那一份(⛔ 檔案要放在 repo 根目錄,相對路徑才讀得到)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.HTML ? path.resolve(process.env.HTML) : path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails++; };

// ⓪ 靜態:唯一一份 + 三處都接
ok('⓪ `_premktFieldAge` 全 App 只有一份定義', (SRC.match(/_premktFieldAge\(mr, todayISO\)\s*\{/g) || []).length === 1);
ok('⓪b 三處都接(分數 / 分析師 / 全球快讀)', (SRC.match(/this\._premktFieldAge\(mr\)/g) || []).length === 3,
    (SRC.match(/this\._premktFieldAge\(mr\)/g) || []).length);
// ③ 靜態:renderMarketBriefing 原始碼裡 ⛔ 不可再有沒驗證過的盤中指令
const rmb = (SRC.match(/async renderMarketBriefing\(\)\s*\{[\s\S]*?\n    \},\n/) || [''])[0];
ok('③s 空過守門:抓得到 renderMarketBriefing 原始碼', rmb.length > 20000, rmb.length);
const rmbCode = rmb.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');   // ⚠️ 註解裡會引用舊寫法 → 先剝掉
for (const w of ['盤中型態', '順勢做多', '開高走高', '開低走低', '開高走低', '開低走高', '別接刀', '逃命波', '同步承壓', '別追多']) {
    ok(`③s2 盤前體檢 ⛔「${w}」`, !rmbCode.includes(w));
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e && e.message || e)));
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const o = {};
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const wdBack = n => {            // 往回推 n 個平日
        const d = new Date(today + 'T00:00:00Z'); let left = n;
        while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); const w = d.getUTCDay(); if (w >= 1 && w <= 5) left--; }
        return d.toISOString().slice(0, 10);
    };
    const D1 = wdBack(1), D2 = wdBack(2);
    o.D1 = D1; o.D2 = D2; o.today = today;

    // ① 純函式(寫死日期,⛔ 不靠今天是星期幾)
    const F = (mr, t) => A._premktFieldAge(mr, t);
    o.f1 = F({ taiex_date: '2026-10-21', fi_three_date: '2026-10-21', sp500_date: '2026-10-21',
               nikkei_date: '2026-10-20', kospi_date: '2026-10-21', hsi_date: '20261020',
               tsm_date: '2026-10-20', asx_date: '2026-10-21', umc_date: '' }, '2026-10-22');
    // 盤中:taiex_date 已經是今天,法人還是昨天 → 台股那天 = 昨天(⛔ 不可把昨天的亞股判成舊)
    o.f2 = F({ taiex_date: '2026-10-22', fi_three_date: '2026-10-21', nikkei_date: '2026-10-21' }, '2026-10-22');
    o.f3 = F({}, '2026-10-22');

    // ②⑤ 實際渲染:同一份資料,只差日期(⭐ 決定性對照)
    const base = {
        updated: today + ' 08:12 +0800', fi_total_net: 10, fi_spot_net: -50, vix: 15,
        taiex_date: D1, fi_three_date: D1, sp500_date: D1, nasdaq_date: D1,
        sp500_chg_pct: 0.5, nasdaq_chg_pct: 0.8, dji_chg_pct: 0.3, sox_chg_pct: 1.2,
        tsm_chg_pct: 2.0, asx_chg_pct: 1.0, umc_chg_pct: 1.0,
        nikkei_chg_pct: -1.3, kospi_chg_pct: -3.7, hsi_chg_pct: -1.0,
        umc_date: D1, hsi_date: D1,
    };
    const run = async (mr) => {
        A._macroRiskCache = { ...mr };
        A.usMacroCache = { dji: { chg_pct: mr.dji_chg_pct }, sp500: { chg_pct: mr.sp500_chg_pct } };
        await A.renderMarketBriefing();
        const el = document.getElementById('marketBriefing');
        el.querySelectorAll('details').forEach(d => d.open = true);
        const C = A._preOpenCalc || {};
        const part = nm => (C.parts || []).find(p => p.nm === nm) || null;
        const an = el.querySelector('[data-asianote]');
        return {
            s: C.s, sum: Math.round((C.parts || []).reduce((a, x) => a + x.d, 0) * 10) / 10,
            tsm: part('🏭 台積電 ADR'), asx: part('🔌 日月光 ADR'), umc: part('🔌 聯電 ADR'),
            nk: part('🇯🇵 日經'), ks: part('🇰🇷 韓股'), hs: part('🇭🇰 恆指(半權重)'),
            txt: (el.textContent || '').replace(/\s+/g, ' '),
            pp: (el.querySelector('[data-ppnote]') || {}).textContent || '',
            an: an ? { k: an.getAttribute('data-asianote'), t: an.textContent.replace(/\s+/g, ' ') } : null,
        };
    };
    o.stale = await run({ ...base, tsm_date: D2, asx_date: D2, nikkei_date: D2, kospi_date: D2 });
    o.fresh = await run({ ...base, tsm_date: D1, asx_date: D1, nikkei_date: D1, kospi_date: D1 });
    o.weak = await run({ ...base, sp500_chg_pct: -1, nasdaq_chg_pct: -1.5, dji_chg_pct: -0.8, sox_chg_pct: -2, tsm_chg_pct: -3,
        tsm_date: D1, asx_date: D1, nikkei_date: D1, kospi_date: D1, kospi_chg_pct: -5.5 });

    // ④ 分析師(直接呼叫,⛔ 不依賴整張卡)
    const AN = mr => (A._marketAnalystHtml(null, mr, 50, {}, []) || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    const am = { kospi_chg_pct: -3.7, nikkei_chg_pct: -1.3, taiex_date: D1, fi_three_date: D1, sp500_date: D1 };
    o.anPrev = AN({ ...am, kospi_date: D1, nikkei_date: D1 });
    o.anToday = AN({ ...am, kospi_date: today, nikkei_date: today, taiex_date: today });
    o.anOld = AN({ ...am, kospi_date: D2, nikkei_date: D2 });
    return o;
});

// ① 純函式
ok('① 日經 10/20(台股上一天 10/21)→ 舊', R.f1.stale.nikkei === '2026-10-20' && R.f1.tw === '2026-10-21', JSON.stringify(R.f1));
ok('①b 韓股 10/21 → 不舊', !R.f1.stale.kospi);
ok('①c 恆指 8 碼日期 20261020 也認得 → 舊', R.f1.stale.hsi === '2026-10-20');
ok('①d 台積電 ADR 10/20(美股 10/21)→ 舊;日月光 10/21 → 不舊', R.f1.stale.tsm === '2026-10-20' && !R.f1.stale.asx);
ok('①e 沒有日期的欄位 ⛔ 不判', !R.f1.stale.umc && R.f1.at.umc === null);
ok('①f 🚨 盤中 taiex_date 已是今天 → 台股那天取法人那天(昨天),昨天的日經 ⛔ 不可判成舊',
    R.f2.tw === '2026-10-21' && !R.f2.stale.nikkei, JSON.stringify(R.f2));
ok('①g 什麼日期都沒有 → 一項都不判', Object.keys(R.f3.stale).length === 0);

// ② 分數
const S = R.stale, Fr = R.fresh;
ok('② 空過守門:兩次都有渲染出分數', Number.isFinite(S.s) && Number.isFinite(Fr.s), JSON.stringify([S.s, Fr.s]));
ok('②a 舊的台積電 ADR → 0 分 + 寫「資料舊了」', S.tsm && S.tsm.d === 0 && /資料舊了/.test(S.tsm.note) && /不計分/.test(S.tsm.note), JSON.stringify(S.tsm));
ok('②b 舊的日月光 ADR → 0 分', S.asx && S.asx.d === 0 && /資料舊了/.test(S.asx.note), JSON.stringify(S.asx));
ok('②c 舊的日經 / 韓股 → 0 分', S.nk && S.nk.d === 0 && S.ks && S.ks.d === 0 && /資料舊了/.test(S.ks.note), JSON.stringify([S.nk, S.ks]));
ok('②d 新的聯電 ADR / 恆指照常算分', S.umc && S.umc.d === 0.5 && S.hs && S.hs.d === -0.5, JSON.stringify([S.umc, S.hs]));
ok('②e ⭐ 決定性對照:同一份資料日期改新 → 台積電 +2・日月光 +0.5・日經 −1・韓股 −1',
    Fr.tsm && Fr.tsm.d === 2 && Fr.asx && Fr.asx.d === 0.5 && Fr.nk && Fr.nk.d === -1 && Fr.ks && Fr.ks.d === -1,
    JSON.stringify([Fr.tsm, Fr.asx, Fr.nk, Fr.ks]));
ok('②f 兩次分數差 == 舊的那幾項的分數(0.5 + 2 − 1 − 1 = 0.5)', Math.abs((Fr.s - S.s) - 0.5) < 0.051, `${Fr.s} − ${S.s}`);
ok('②g 逐項加總 == 分數(兩次都是)', Math.abs(S.sum - S.s) < 0.051 && Math.abs(Fr.sum - Fr.s) < 0.051, JSON.stringify([S.sum, S.s, Fr.sum, Fr.s]));

// ③ 畫面文字(三種分數都看)
for (const [nm, x] of [['偏多(舊資料)', S], ['偏多', Fr], ['偏空', R.weak]]) {
    ok(`③ ${nm}:⛔ 盤中型態 / 順勢做多 / 開高走高 / 別接刀`, !/盤中型態|順勢做多|順勢偏空|開高走高|開高走低|開低走高|開低走低|別接刀|逃命波/.test(x.txt), x.txt.slice(0, 300));
    ok(`③b ${nm}:有「📌 今天怎麼看」而且講明開盤之後不預測`, /今天怎麼看/.test(x.pp) && (/不預測/.test(x.pp) || /縮小部位/.test(x.pp)), x.pp);
}
ok('③c 偏多那天:⛔ 別在開盤追高', /別在開盤追高/.test(Fr.pp), Fr.pp);
ok('③d 偏空那天:⛔ 不叫人整天不做、手上的照出場規則', /不用因為分數低就整天不做/.test(R.weak.pp) && /出場規則/.test(R.weak.pp), R.weak.pp);

// ④ 分析師
ok('④ 前一天的亞股:寫「台股那天已經一起反映」', /台股那天已經一起反映/.test(R.anPrev) && /韓股 -3\.7%/.test(R.anPrev), R.anPrev);
ok('④b 前一天的亞股 ⛔「今日開盤 / 易開低 / 拖累 / 同盤」', !/今日開盤|易開低|拖累|同盤/.test(R.anPrev), R.anPrev);
ok('④c 今天的亞股:寫「今天亞股開盤…還在盤中」', /今天亞股開盤/.test(R.anToday) && /還在盤中/.test(R.anToday), R.anToday);
ok('④d 比台股上一天還舊的亞股 ⛔ 不講', !/韓股|日經/.test(R.anOld), R.anOld);

// ⑤ 全球快讀
ok('⑤ 空過守門:韓股 −3.7% 要有亞股那段', !!S.an && !!Fr.an, JSON.stringify([S.an, Fr.an]));
ok('⑤b 太舊的要寫「不算分」', S.an && /不算分/.test(S.an.t), S.an && S.an.t);
ok('⑤c 前一天的要寫「台股那天已一起反映」', Fr.an && /台股那天已一起反映/.test(Fr.an.t), Fr.an && Fr.an.t);
ok('⑤d 重挫(−5.5%)那段 ⛔ 不叫人「今天別接刀 / 別追多」,只描述', R.weak.an && R.weak.an.k === 'crash' && !/別接刀|別追多|同步承壓/.test(R.weak.an.t) && /出場規則/.test(R.weak.an.t), R.weak.an && R.weak.an.t);
ok('⑤e 一般走弱那段 ⛔ 下指令', S.an && !/別追多|停損|同步承壓/.test(S.an.t), S.an && S.an.t);

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條沒過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
