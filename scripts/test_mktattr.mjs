#!/usr/bin/env node
/**
 * 📊🪁 持股損益歸因(本週:大盤帶動 vs 個股自己)+ 勝率鏡子「賣掉之後」(賣飛 / 賣對)
 *   想法參考 desk-note(MIT)app/analytics/core.py 的 fit_betas / attribution、journal.py 的 since_decision;程式是 index.html 自己寫的。
 *
 *  Ⓐ 純函式(node 直接跑,⛔ 開瀏覽器;函式原文從 index.html 抽出來,⛔ 另抄一份):
 *   ① _betaFit:斜率算對(造 β = 1.5 的資料)・只用 upTo 以前(決定性對照:之後改成 β = −1,結果不變)・只看最近 250 天・
 *      不到 60 天 → 1 + 估 ・沒還原的分割斷崖(單日 −75%)⛔ 進迴歸(決定性對照:把那一根放進去算,β 會歪)
 *   ② _wkAttrOne / _wkAttr:起點 = 週一以前最後一個收盤、合計 / 大盤帶動 / 個股自己的金額(手算對得上)・
 *      這週才買 → 起點用成本、大盤從買進日前一個收盤算 ・兩邊最後一天不同 → 用兩邊都有的那一天 ・
 *      這週沒收盤 / 買了還沒收盤 / K 線太短 → 跳過並寫原因 ・加總 = 各檔四捨五入後相加、個股自己 = 合計 − 大盤
 *   ③ _postSale / _soldFlySum:賣飛金額 = 股數 ×(之後收盤 − 賣價)、跟大盤比 = 股數 × 賣價 ×(這檔 − β × 0050)・
 *      最多看 20 天 ・不到 20 天 → full=false(畫面寫「才 N 天」)・賣出後還沒收盤 → n=0 ・β 只用賣出以前(決定性對照)・
 *      摘要:比大盤漲得多 → 賣飛(加總少賺)、跌了 → 賣對(加總少賠)、其餘另計
 *   ④ _wkMonday:週一起算(週日歸上一週)、往前一週;帳戶熔斷改用同一支(test_discipline ① 照跑)
 *  Ⓑ 畫面(Playwright,390 寬):
 *   ⑤ 庫存頁統計卡底下那一行:數字 = _wkAttr 算的、「大盤帶動」「個股自己」、註腳三件事 ・明細打開後重畫 ⛔ 被關掉 ・
 *      同一天同一批持股 ⛔ 每次重畫都重抓 K 線 ・算到一半持股被改了 → 算完再算新的 ・空庫存收起來 ・
 *      週一早上還沒有這週的收盤 → 寫「上週」⛔ 寫本週
 *   ⑥ 鏡子:🪁 那一行的筆數 / 金額 = _soldFlySum、明細有「才 N 天」、沒填買進日的也有「賣掉之後」
 *   ⑦ 新的字 ⛔ 🔴🟢(好壞不准用紅綠)、⛔ 研究字樣(跟 test_retail_clean 同一份清單)、⓪ 沒有 pageerror
 * 跑法:node scripts/test_mktattr.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMember } from './col_rate_base.mjs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) FAIL.push(n); };
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// ── Ⓐ 從 index.html 抽出同一份函式 ──
const NUM = n => { const m = new RegExp(`\\n    ${n}: (\\d+),`).exec(SRC); if (!m) throw new Error('index.html 找不到 ' + n); return `${n}: ${m[1]}`; };
const NEED = ['_kDate', '_closeMap', '_betaFit', '_wkMonday', '_wkAttrOne', '_wkAttr', '_postSale', '_soldFlySum'];
const A = (0, eval)(`({${[NUM('_BETA_WIN'), NUM('_BETA_MIN'), NUM('_POST_N'), ...NEED.map(n => extractMember(SRC, n))].join(',\n')}})`);

// 合成日 K:週一~週五(⛔ 用真的日曆:週一起算要對得上)
const pad = v => String(v).padStart(2, '0');
const ymd = d => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
// n 個交易日、最後一天 = end(往回數,⛔ 從開頭往後數:最後一天會跑掉)
const cal = (n, end) => { const o = [], d = new Date(end + 'T00:00:00'); while (o.length < n) { if (d.getDay() % 6) o.unshift(ymd(d)); d.setDate(d.getDate() - 1); } return o; };
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
// 0050 日報酬 ±2%、這檔 = β × 0050(+ 一點雜訊)
const series = (dates, rm, rs, base) => { const c = [base]; for (let i = 1; i < dates.length; i++) c.push(c[i - 1] * (1 + rs[i])); return dates.map((date, i) => ({ date, close: c[i] })); };

// ① _betaFit
{
    const D = cal(320, '2026-08-28');
    const rm = D.map(() => (rnd() - 0.5) * 0.04);
    const k50 = series(D, rm, rm, 50);
    const kl = series(D, rm, rm.map(v => 1.5 * v), 100);
    const up = D[299];
    const b = A._betaFit(kl, k50, up);
    ok('① β = 1.5 的資料 → 斜率 1.5、不是估的、用滿 250 天', near(b.beta, 1.5, 1e-6) && !b.est && b.n === 250, JSON.stringify(b));
    // 決定性對照:upTo 之後改成 β = −1 → 結果不變;拿全部算(upTo 給最後一天)就會變
    const rs2 = rm.map((v, i) => i > 299 ? -1 * v : 1.5 * v);
    const kl2 = series(D, rm, rs2, 100);
    const b2 = A._betaFit(kl2, k50, up), b2all = A._betaFit(kl2, k50, D[D.length - 1]);
    ok('① ⭐ 只用 upTo 以前(決定性對照:之後的日子改成 β = −1,結果一樣;把之後也算進去就會變)', near(b2.beta, 1.5, 1e-6) && b2all.beta < 1.4, `${b2.beta} / 全部 ${b2all.beta}`);
    // 只看最近 250 天:前面 69 天是 β = 3
    const rs3 = rm.map((v, i) => i <= 40 ? 3 * v : 1.5 * v);   // 窗口 = 第 50~299 個報酬
    ok('① 只看最近 250 天(更早的 β = 3 不算進去)', near(A._betaFit(series(D, rm, rs3, 100), k50, up).beta, 1.5, 1e-6));
    // 不到 60 天 → 1 + 估
    const s59 = A._betaFit(kl.slice(0, 60), k50, D[59]);   // 60 根 = 59 個日報酬
    const s60 = A._betaFit(kl.slice(0, 61), k50, D[60]);
    ok('① 兩邊都有收盤的日報酬不到 60 天 → β = 1、標估;剛好 60 天就照算', s59.est && s59.beta === 1 && s59.n === 59 && !s60.est && near(s60.beta, 1.5, 1e-6), JSON.stringify([s59, s60]));
    // 沒還原的分割斷崖:第 200 天之後整段 ÷4
    const kl4 = kl.map((b, i) => i >= 200 ? { ...b, close: b.close / 4 } : b);
    const b4 = A._betaFit(kl4, k50, up);
    // 對照:把斷崖那一根也放進 OLS(手算)→ 會歪
    const naive = (() => { const xs = [], ys = []; for (let i = 300 - 250; i < 300; i++) { ys.push(kl4[i].close / kl4[i - 1].close - 1); xs.push(k50[i].close / k50[i - 1].close - 1); } const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length; let a = 0, c = 0; xs.forEach((x, i) => { a += (x - mx) * (ys[i] - my); c += (x - mx) ** 2; }); return a / c; })();
    ok('① ⛔ 沒還原的分割斷崖(單日 −75%)不進迴歸(決定性對照:放進去 β 會歪)', near(b4.beta, 1.5, 1e-6) && Math.abs(naive - 1.5) > 0.1 && b4.n === 250, `守門 ${b4.beta}(n=${b4.n}) / 放進去 ${naive}`);
    ok('① 沒有 K 線 / 沒有 0050 → β = 1、估', A._betaFit(null, k50, up).est && A._betaFit(kl, null, up).beta === 1);
}

// ② _wkAttrOne / _wkAttr
const WK = (() => {
    // 280 個交易日:最後 5 根 = 2026/10/26(一)~2026/10/30(五)
    const D = cal(280, '2026-10-30');
    const iF = D.indexOf('2026/10/23');   // 上週五
    const rm = D.map(() => (rnd() - 0.5) * 0.04);
    const s50 = series(D, rm, rm, 1), s = series(D, rm, rm.map(v => 1.5 * v), 1);
    // 上週五收盤縮放成 0050 = 50、這檔 = 100(只是換尺,報酬不變)
    const f50 = 50 / s50[iF].close, fs_ = 100 / s[iF].close;
    const k50 = s50.map((b, i) => ({ date: b.date, close: i <= iF ? b.close * f50 : 50 * [0.996, 0.992, 0.988, 0.984, 0.98][i - iF - 1] }));
    const kl = s.map((b, i) => ({ date: b.date, close: i <= iF ? b.close * fs_ : 100 * [0.99, 0.98, 0.97, 0.96, 0.95][i - iF - 1] }));
    return { D, k50, kl, wk: '2026/10/26' };
})();
{
    const { k50, kl, wk } = WK;
    ok('② 合成資料自我檢查:最後一根是 2026/10/30(五)、上週五這檔 100 / 0050 50', kl[kl.length - 1].date === '2026/10/30' && near(kl[kl.length - 6].close, 100) && near(k50[k50.length - 6].close, 50));
    const r = A._wkAttrOne({ symbol: 'X', shares: 2, cost: 80, buyDate: '2025-01-02' }, kl, k50, wk);
    ok('② 起點 = 週一以前最後一個收盤(10/23)、終點 = 10/30', r && r.d0 === '2026/10/23' && r.d1 === '2026/10/30' && near(r.start, 100) && near(r.end, 95), JSON.stringify(r));
    ok('② 合計 = 2,000 股 ×(95 − 100)= −10,000', near(r.total, -10000, 1e-6), r.total);
    ok('② 大盤帶動 = β 1.5 × 0050 −2% × 起點市值 200,000 = −6,000;個股自己 = −4,000', near(r.beta, 1.5, 1e-6) && near(r.mkt, -6000, 1e-6) && near(r.stock, -4000, 1e-6), `${r.beta} ${r.mkt} ${r.stock}`);
    const f = A._wkAttrOne({ symbol: 'X', shares: 2, cost: 97.5, buyDate: '2026-10-28' }, kl, k50, wk);
    const mRet = (50 * 0.98) / (50 * 0.992) - 1;
    ok('② 這週三才買 → 起點用成本 97.5、大盤從週二收盤算', f && f.fresh && near(f.start, 97.5) && f.d0 === '2026/10/27' && near(f.mRet, mRet, 1e-9), JSON.stringify(f));
    ok('② 這週才買的 β 仍只用這週以前那一年(⛔ 用到這週)', near(f.beta, 1.5, 1e-6) && near(f.total, -5000, 1e-6) && near(f.mkt, 1.5 * mRet * 2000 * 97.5, 1e-6));
    // 這檔多一根 0050 沒有的(10/31)→ 用兩邊都有的最後一天
    const klx = kl.concat([{ date: '2026/10/31', close: 120 }]);
    const rx = A._wkAttrOne({ symbol: 'X', shares: 2, cost: 80 }, klx, k50, wk);
    ok('② 兩邊最後一天不同 → 用兩邊都有收盤的那一天(⛔ 各用各的)', rx && rx.d1 === '2026/10/30' && near(rx.end, 95));
    ok('② 這週還沒有收盤 → 跳過寫 noweek', A._wkAttrOne({ symbol: 'X', shares: 1 }, kl.slice(0, -5), k50, wk)?.skip === 'noweek');
    ok('② 買了還沒有收盤 → 跳過寫 nobar', A._wkAttrOne({ symbol: 'X', shares: 1, cost: 90, buyDate: '2026/10/31' }, kl, k50, wk)?.skip === 'nobar');
    ok('② K 線太短(這週以前沒有收盤)→ 跳過寫 nobase', A._wkAttrOne({ symbol: 'X', shares: 1 }, kl.slice(-5), k50, wk)?.skip === 'nobase');
    ok('② 沒有股數 / 沒有 K 線 → null', A._wkAttrOne({ symbol: 'X', shares: 0 }, kl, k50, wk) === null && A._wkAttrOne({ symbol: 'X', shares: 1 }, null, k50, wk) === null);
    // β 估:這檔只有最近 40 根
    const e = A._wkAttrOne({ symbol: 'Y', shares: 1 }, kl.slice(-40), k50, wk);
    ok('② 這週以前兩邊一起有收盤不到 60 天 → β 當 1、標估', e && e.est && e.beta === 1 && near(e.mkt, -0.02 * 1000 * 100, 1e-6), JSON.stringify(e));
    // 加總
    const inv = [{ symbol: 'X', shares: 2, cost: 80 }, { symbol: 'Y', shares: 1.234, cost: 90 }, { symbol: 'Z', shares: 1 }];
    const sum = A._wkAttr(inv, { X: kl, Y: kl.slice(-40), Z: kl.slice(0, -5) }, k50, wk);
    const ty = Math.round(1234 * (95 - 100)), my = Math.round(-0.02 * 1234 * 100);
    ok('② 加總 = 各檔四捨五入後相加;個股自己 = 合計 − 大盤(三個數字自己加減對得上)', sum.total === -10000 + ty && sum.mkt === -6000 + my && sum.stock === sum.total - sum.mkt && sum.rows.every(x => x.st === x.t - x.mk), JSON.stringify({ t: sum.total, m: sum.mkt, s: sum.stock }));
    ok('② 算不出來的那檔寫進 skip(⛔ 默默少一檔)、估的檔數有數', sum.skip.length === 1 && sum.skip[0].sym === 'Z' && sum.skip[0].why === 'noweek' && sum.nEst === 1 && sum.d1 === '2026/10/30', JSON.stringify(sum.skip));
}

// ③ _postSale / _soldFlySum
{
    const { D, k50, kl } = WK;
    const iS = D.indexOf('2026/09/25');
    const sd = D[iS];
    const t = { symbol: 'X', sellPrice: 101, shares: 2, date: sd };
    const p = A._postSale(t, kl, k50);
    const cE = kl[iS + 20].close, m0 = k50[iS].close, m1 = k50[iS + 20].close;
    const ret = cE / 101 - 1, mRet = m1 / m0 - 1;
    ok('③ 最多看 20 個交易日、從賣出那天收盤起算', p && p.n === 20 && p.full && p.dS === sd && p.dE === D[iS + 20], JSON.stringify(p));
    ok('③ 賣飛金額 = 股數 ×(之後收盤 − 賣價)', p.fly === Math.round(2000 * (cE - 101)), `${p.fly} vs ${2000 * (cE - 101)}`);
    ok('③ 跟大盤比 = 股數 × 賣價 ×(這檔報酬 − β × 0050 報酬),β 1.5', near(p.beta, 1.5, 1e-6) && p.adj === Math.round(2000 * 101 * (ret - 1.5 * mRet)) && near(p.mRet, mRet, 1e-12), `${p.adj}`);
    const short = A._postSale({ ...t, date: D[D.length - 8] }, kl, k50);
    ok('③ 賣掉還不到 20 天 → 算到最新一根、full = false(畫面寫「才 N 天」)', short && short.n === 7 && short.full === false && short.dE === '2026/10/30', JSON.stringify(short));
    ok('③ 最新那一天才賣 → n = 0(還沒有之後的收盤)', A._postSale({ ...t, date: '2026/10/30' }, kl, k50)?.n === 0);
    // β 只用賣出以前:賣出後的日子改成 β = −1 → β 不變
    const rmAll = k50.map((b, i) => i ? b.close / k50[i - 1].close - 1 : 0);
    const klB = series(D, rmAll, rmAll.map((v, i) => i > iS ? -1 * v : 1.5 * v), 100);
    const pB = A._postSale({ ...t, sellPrice: klB[iS].close }, klB, k50);
    ok('③ ⭐ β 只用賣出以前那一年(決定性對照:賣出後改成 β = −1,β 還是 1.5)', pB && near(pB.beta, 1.5, 1e-6), pB && pB.beta);
    ok('③ 沒有賣價 / 賣出日比 K 線還早 → null', A._postSale({ ...t, sellPrice: 0 }, kl, k50) === null && A._postSale({ ...t, date: '2020/01/02' }, kl, k50) === null);
    // 摘要分類
    const S = A._soldFlySum([
        { p: { n: 20, full: true, fly: 3000, adj: 1200 } },     // 漲、比大盤多 → 賣飛
        { p: { n: 20, full: true, fly: 500, adj: -800 } },      // 漲、沒大盤多 → 其餘
        { p: { n: 5, full: false, fly: -2000, adj: -1500 } },   // 跌 → 賣對
        { p: { n: 12, full: false, fly: -700, adj: 300 } },     // 跌得比大盤少 → 還是賣對(真的少賠)
        { p: { n: 0, full: false } },                            // 還沒有收盤 → 不算
    ]);
    ok('③ 摘要:比大盤漲得多 1 筆少賺 3,000、跌了 2 筆少賠 2,700、其餘 1 筆、不到 20 天 2 筆、沒有收盤的不算', S.n === 4 && S.nFly === 1 && S.gaveUp === 3000 && S.nRight === 2 && S.avoided === 2700 && S.nRest === 1 && S.nShort === 2, JSON.stringify(S));
}

// ④ _wkMonday
ok('④ 週一起算:週五 → 那週一、週日 → 上一週的週一、往前一週', A._wkMonday('2026/10/30') === '2026/10/26' && A._wkMonday('2026-11-01') === '2026/10/26' && A._wkMonday('2026/11/02') === '2026/11/02' && A._wkMonday('2026/11/02', 1) === '2026/10/26' && A._wkMonday('2026/1/7') === '2026/01/05' && A._wkMonday('') === '');
ok('④ 帳戶熔斷的「本週」走同一支(⛔ 兩份週一算法)', /_acctBreaker\(log, acc, todayStr\) \{[\s\S]{0,200}this\._wkMonday\(day\)/.test(SRC));

// ── Ⓑ 畫面 ──
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.addInitScript(() => { try { localStorage.removeItem('proTerminalInv'); localStorage.removeItem('proTerminalTradeLog'); } catch (_) {} });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._wkAttr === 'function' && typeof app.renderInventory === 'function', null, { timeout: 60000 });
await page.waitForTimeout(1500);
const R = await page.evaluate(async ({ kl, k50 }) => {
    const A = app, o = {};
    const wait = async (fn, ms = 4000) => { for (let t = 0; t < ms / 50 && !fn(); t++) await new Promise(r => setTimeout(r, 50)); return fn(); };
    // ⏰ 釘住「今天」= 2026/10/30(五)晚上(⛔ 讀真的時鐘:沙箱是 UTC,測資一過期就換週)
    A.getTodayStr = () => '2026/10/30';
    A._tpeMinutes = () => ({ wd: 'Fri', min: 20 * 60, ymd: '2026-10-30' });
    let calls = 0;
    const klY = kl.map(b => ({ ...b, close: +(b.close * 0.5).toFixed(6) }));
    A.fetchHistoricalData = async s => { calls++; return s === '0050' ? k50 : s === '1111' ? klY : s === '2222' ? kl.slice(0, -5) : kl; };
    A.inventory = [{ symbol: '9999', shares: 2, cost: 80, currentPrice: 95 }, { symbol: '1111', shares: 1, cost: 40, currentPrice: 47.5, buyDate: '2026-10-28' }, { symbol: '2222', shares: 1, cost: 50, currentPrice: 50 }];
    A._wkAttrMemo = null;
    A.switchAppTab('inv');
    A.renderInventory();
    const box = document.getElementById('invWeekAttr');
    await wait(() => box && box.querySelector('[data-wkattr="ok"]'));
    o.html = box.innerHTML; o.txt = box.textContent; o.hidden = box.classList.contains('hidden');
    const exp = A._wkAttr(A.inventory, { '9999': kl, '1111': klY, '2222': kl.slice(0, -5) }, k50, '2026/10/26');
    o.sumAttr = box.querySelector('[data-wkattr="ok"]')?.dataset.wkattrsum;
    o.exp = `${exp.total}|${exp.mkt}|${exp.stock}`;
    o.rows = box.querySelectorAll('[data-wkattrrow]').length;
    // 明細打開 → 重畫(刷價)⛔ 被關掉、⛔ 重抓 K 線
    const det = box.querySelector('details[data-wkattrdet]'); det.open = true;
    const c0 = calls;
    A.renderInventory(); await new Promise(r => setTimeout(r, 300));
    o.stillOpen = !!box.querySelector('details[data-wkattrdet]')?.open;
    o.noRefetch = calls === c0;
    // 換一批持股 → 重算
    A.inventory = A.inventory.slice(0, 1);
    A.renderInventory();
    await wait(() => box.querySelector('[data-wkattr="ok"]') && box.querySelectorAll('[data-wkattrrow]').length === 1);
    o.refetch = calls > c0;
    // 算到一半持股被改了(K 線還在抓)→ 算完要再算一次新的那一批(⛔ 停在舊的)
    let release; const gate = new Promise(r => { release = r; });
    A.fetchHistoricalData = async s => { calls++; await gate; return s === '0050' ? k50 : kl; };
    A._wkAttrMemo = null;
    A.inventory = [{ symbol: '9999', shares: 2, cost: 80, currentPrice: 95 }, { symbol: '1111', shares: 1, cost: 40, currentPrice: 47.5 }];
    A.renderInventory();
    await new Promise(r => setTimeout(r, 100));
    A.inventory = [{ symbol: '9999', shares: 2, cost: 80, currentPrice: 95 }];
    A.renderInventory();                       // 這時候還在算上一批 → 先不重算
    release();
    await wait(() => box.querySelectorAll('[data-wkattrrow]').length === 1 && !box.querySelector('[data-wkattrrow="1111"]'));
    o.midChange = box.querySelectorAll('[data-wkattrrow]').length === 1 && !!box.querySelector('[data-wkattrrow="9999"]');
    A.fetchHistoricalData = async s => { calls++; return s === '0050' ? k50 : s === '1111' ? klY : s === '2222' ? kl.slice(0, -5) : kl; };
    // 週一早上:最新收盤還是上週五 → 寫「上週」
    A.getTodayStr = () => '2026/11/02'; A._tpeMinutes = () => ({ wd: 'Mon', min: 9 * 60, ymd: '2026-11-02' });
    A._wkAttrMemo = null; A.renderInventory();
    await wait(() => /上週持股/.test(box.textContent));
    o.monTxt = box.textContent;
    // 空庫存 → 收起來
    A.inventory = []; A.renderInventory(); await new Promise(r => setTimeout(r, 200));
    o.emptyHidden = box.classList.contains('hidden') && !box.textContent.trim();
    // 0050 抓不到 → 講出來(⛔ 空白)
    A.getTodayStr = () => '2026/10/30'; A._tpeMinutes = () => ({ wd: 'Fri', min: 20 * 60, ymd: '2026-10-30' });
    A.fetchHistoricalData = async s => s === '0050' ? null : kl;
    A.inventory = [{ symbol: '9999', shares: 2, cost: 80, currentPrice: 95 }]; A._wkAttrMemo = null; A.renderInventory();
    await wait(() => box.querySelector('[data-wkattr="no50"]'));
    o.no50 = box.textContent;
    // ── ⑥ 鏡子 ──
    A.fetchHistoricalData = async s => s === '0050' ? k50 : kl;
    const D = kl.map(b => b.date), iS = D.indexOf('2026/09/25');
    const log = [{ symbol: '9999', name: '測試甲', cost: 90, sellPrice: 101, shares: 2, buyDate: D[iS - 30], date: D[iS], net: 1 },
                 { symbol: '9999', name: '測試乙', cost: 90, sellPrice: 99, shares: 1, date: D[D.length - 8], net: 1 },
                 { symbol: '9999', name: '測試丙', cost: 90, sellPrice: 98, shares: 1, buyDate: D[D.length - 30], date: '2026/10/30', net: 1 }];
    localStorage.setItem('proTerminalTradeLog', JSON.stringify(log));
    A._xcCache = {};
    A._showTradeMirror();
    const body = document.getElementById('updateLogBody');
    await wait(() => body.querySelector('[data-soldfly]'));
    o.fly = body.querySelector('[data-soldfly]')?.dataset.soldfly || '';
    o.flyExp = (() => { const ps = log.map(t => ({ t, p: A._postSale(t, kl, k50) })).filter(x => x.p); const S = A._soldFlySum(ps); return `${S.nFly}|${S.gaveUp}|${S.nRight}|${S.avoided}`; })();
    o.flyTxt = body.querySelector('[data-soldfly]')?.textContent || '';
    o.rowsTxt = [...body.querySelectorAll('[data-soldflyrow]')].map(x => x.textContent);
    o.noBuyDate = /沒填買進日/.test(body.textContent);
    o.xcN = +(body.querySelector('[data-mirrorxc]')?.dataset.mirrorxc || 0);
    o.newHtml = (document.getElementById('mirrorXc')?.outerHTML || '');
    return o;
}, { kl: WK.kl, k50: WK.k50 });

const T = h => String(h || '').replace(/<[^>]+>/g, ' ');
ok('⑤ 庫存統計卡底下那一行出現,數字 = _wkAttr 算的(合計 | 大盤 | 個股)', !R.hidden && R.sumAttr === R.exp, `${R.sumAttr} vs ${R.exp}`);
ok('⑤ 寫「本週持股 … 元:大盤帶動 …、個股自己 …」', /本週持股 [−+]?[\d,]+ 元:大盤帶動 [−+]?[\d,]+、個股自己 [−+]?[\d,]+/.test(R.txt), R.txt.slice(0, 160));
ok('⑤ 註腳三件事:0050 當大盤、沒算股利、β 用過去一年', /0050 當大盤、沒算股利、β 用過去一年/.test(R.txt));
ok('⑤ 明細:算得出來的 2 檔各一列、這週沒有收盤的那檔寫出來(⛔ 默默少一檔)', R.rows === 2 && /1 檔本週沒有收盤資料可比\(2222\)/.test(R.txt), R.txt.slice(-200));
ok('⑤ 這週才買的那檔標 🆕、註腳說「🆕 = 本週才買的,起點用你的買進成本」', /1111 🆕/.test(R.txt) && /🆕 = 本週才買的,起點用你的買進成本/.test(R.txt), R.txt.slice(0, 400));
ok('⑤ 明細打開後刷價重畫 → ⛔ 被關掉', R.stillOpen);
ok('⑤ 同一天同一批持股 → ⛔ 每次重畫都重抓 K 線;換了持股才重算', R.noRefetch && R.refetch);
ok('⑤ 算到一半持股被改了 → 算完再算一次新的那一批(⛔ 停在舊的)', R.midChange);
ok('⑤ 週一早上還沒有這週的收盤 → 寫「上週持股」(⛔ 寫本週)', /上週持股/.test(R.monTxt) && !/本週持股/.test(R.monTxt), R.monTxt.slice(0, 120));
ok('⑤ 空庫存 → 那一行收起來', R.emptyHidden);
ok('⑤ 0050 抓不到 → 講出來(⛔ 空白)', /0050 的 K 線這次沒抓到/.test(R.no50), R.no50);
ok('⑥ 鏡子 🪁 那一行的筆數 / 金額 = _soldFlySum', R.fly && R.fly === R.flyExp, `${R.fly} vs ${R.flyExp}`);
ok('⑥ 寫「比大盤漲得多(賣飛)… 少賺 … 元;… 跌了(賣對)… 少賠 … 元」', /比大盤漲得多\(賣飛\),少賺 [\d,]+ 元;\d+ 筆跌了\(賣對\),少賠 [\d,]+ 元/.test(R.flyTxt), R.flyTxt);
ok('⑥ 明細:不到 20 天寫「才 N 天」、滿 20 天寫「賣後 20 天」、當天才賣寫還沒有收盤', R.rowsTxt.some(x => /才 7 天/.test(x)) && R.rowsTxt.some(x => /賣後 20 天/.test(x)) && R.rowsTxt.some(x => /還沒有收盤可以比/.test(x)), JSON.stringify(R.rowsTxt));
ok('⑥ 沒填買進日的那筆也有「賣掉之後」(⛔ 因為算不出 R 就整筆不見)', R.noBuyDate && R.xcN === 2, `${R.noBuyDate} ${R.xcN}`);
const NEW = T(R.html) + '\n' + T(R.newHtml) + '\n' + R.monTxt;
ok('⑦ 新的字 ⛔ 🔴🟢(好壞不准用紅綠)', !/[🔴🟢]/u.test(R.html + R.newHtml));
const bad = badOf(NEW);
ok('⑦ 新的字 ⛔ 研究字樣(跟 test_retail_clean 同一份清單)', !bad.length, bad.join(' '));
ok('⓪ 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 項失敗' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
