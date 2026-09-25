#!/usr/bin/env node
/**
 * 📅 V77.6.1 逐年成績單守門(portfolio_backtest YEAR 模式 + yearly_bt.mjs + pro.html `_YEARLY_BT` / renderYearly)
 *   ① 引擎:YEAR 只影響「哪一天開倉」—— 取代 WARMUP 的那一行、過了那一年不再開倉、⛔ 不進 CACHE_KEY、n=0 要誠實寫出來
 *   ② 嵌入(V77.6.6 只剩一份 2011~2026):策略數 == STRATS+COMBOS、每年有值或「資料起點之前的 null + 原因」、
 *      2011/2022 對照是空頭、有「決策台現行」、每列都有「一路滾」17 條 + 0050 含息對照
 *   ③ 畫面:數字讀常數(決定性對照)・**每一欄**都可排序且空值排最後・點一列換細節・預設照「一路滾」排・
 *      ⛔ 不再有兩顆切換鈕・舊情境庫表頭也可排序・390px 不橫捲
 *   ④ 重跑不了的列要寫原因
 * 注入(逐一確認會紅):畫面寫死一個數字 / 拿掉 2022 / 過了那一年照樣開倉 / YEAR 進 CACHE_KEY /
 *   一路滾欄寫死 / 排序方向不反轉 / null 年被當 0 加總 / 舊情境庫拿掉 onclick
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRATS, COMBOS, SKIPPED, CONT_WARMUPS } from './yearly_bt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PB = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const PRO_PATH = process.env.PRO_HTML || path.join(ROOT, 'pro.html');
const PRO = fs.readFileSync(PRO_PATH, 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ① 引擎(靜態)
ok('① YEAR 取代 WARMUP 的那一行(`i < YR_FROM`),沒設 YEAR 時 YR_FROM = WARMUP', /if \(i < YR_FROM\) continue;/.test(PB) && /let YR_FROM = WARMUP, YR_TO = days\.length - 1;/.test(PB) && !/if \(i < WARMUP\) continue;/.test(PB));
ok('①b 過了那一年就⛔ 不再開倉(只讓手上的照規則出場)', /if \(YEAR && i > YR_TO\) \{ if \(!live\.length\) break;[^}]*continue; \}/.test(PB));
ok('①c YEAR / YEAR_OFFSET ⛔ 不進 CACHE_KEY', /CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/.test(PB) && !/CACHE_KEY = JSON\.stringify\(\{[^}]*YEAR/.test(PB));
ok('①d 那一年一筆都沒做 → 寫出 n=0(⛔ 不可當成錯誤、⛔ 不可靜默消失)', /n: 0, pnl: 0, ret: 0, skipped, note: '這一年一筆都沒進場'/.test(PB));
ok('①e 同年 0050 含息用共用的 trSeries(⛔ 不另寫一份)', /import \{ trSeries \} from '\.\/lib_totalreturn\.mjs'/.test(PB) && /trSeries\(bars,/.test(PB));

// ② 嵌入
const line = PRO.split('\n').find(l => /^\s*_YEARLY_BT: \{/.test(l)) || '';
let Y = null; try { Y = JSON.parse(line.replace(/^\s*_YEARLY_BT: /, '').replace(/,$/, '')); } catch (_) {}
ok('② 🚧 空過守門:讀得到 `_YEARLY_BT` 而且有策略', !!(Y && Y.strats && Y.strats.length), line.slice(0, 80));
if (Y && Y.strats) {
    const WANT = STRATS.length + COMBOS.length;
    ok(`②b 策略數 == yearly_bt.mjs 的 STRATS+COMBOS(${WANT})`, Y.strats.length === WANT, Y.strats.length);
    const YEARS = Y.years || [];
    ok('②b2 年份是 2011 起的 16 年(⛔ 不再有只到 2022 的那一份)', YEARS[0] === '2011' && YEARS.length >= 16, YEARS.join(','));
    const badY = []; for (const s of Y.strats) for (const y of YEARS) { const v = s.y[y]; if (Array.isArray(v) && v.length === Y.cols.length) continue; if (v === null && s.na && y < s.na.from && s.na.why && s.na.why.length > 10) continue; badY.push(`${s.id}:${y}`); }
    ok('②c 每個策略每一年都有值;null 只准在「資料起點之前」而且寫原因', !badY.length, badY.slice(0, 5).join(' '));
    ok('②d 2011、2022 的加權對照都是負的(空頭年;⛔ 窗口不含空頭就不算數)', Y.bench['2022'] && Y.bench['2022'].twii < 0 && Y.bench['2011'] && Y.bench['2011'].twii < 0, JSON.stringify(Y.bench['2011']));
    ok('②e 有「決策台現行」與「舊預設」兩列', Y.strats.some(s => s.id === Y.nowId) && Y.strats.some(s => s.id === 'base'));
    ok('②f 重跑不了的列有寫原因', (Y.skipped || []).length === SKIPPED.length && Y.skipped.every(x => x.why && x.why.length > 10));
    const noC = Y.strats.filter(s => !(s.c && s.c.paths === CONT_WARMUPS.length && s.c.med != null && s.c.lo <= s.c.med));
    ok(`②g 🏦 每一列都有「一個帳戶一路滾」${CONT_WARMUPS.length} 條起點(中位 / 最差 / 回撤)`, !noC.length, noC.slice(0, 5).map(s => s.id).join(' '));
    ok('②h 一路滾的 0050 含息對照在(⛔ 只比不含息會讓策略看起來比較好)', !!(Y.benchCont && Y.benchCont.e0050tr != null && Y.benchCont.e0050tr > Y.benchCont.e0050), JSON.stringify(Y.benchCont));
}
ok('②i ⛔ pro.html 不可再有第二份 `_YEARLY_BT_LONG`(使用者:「把能合併就合併」)', !/_YEARLY_BT_LONG\s*:/.test(PRO));

// ③ 畫面
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + PRO_PATH, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderYearly, null, { timeout: 30000 });
const R = await page.evaluate(async () => {
    try { await PRO.switchTab('calc'); } catch (_) {}
    PRO._labSel = 'bt'; PRO._ybSort = null; PRO.renderLab();
    const box = () => document.getElementById('yearlyBody');
    const o = {};
    o.txt = box().innerText; o.rows = box().querySelectorAll('tbody tr').length;
    window.scrollTo(80, 0); o.sx = window.scrollX;
    const Y = PRO._YEARLY_BT, base = Y.strats.find(s => s.id === 'base'), now = Y.strats.find(s => s.id === Y.nowId);
    const firstId = () => { const tr = box().querySelector('tbody tr[onclick]'); return tr ? tr.getAttribute('onclick') : ''; };
    const rowIds = () => [...box().querySelectorAll('tbody tr[onclick]')].map(tr => (tr.getAttribute('onclick').match(/'([^']+)'/) || [])[1]);
    // 🏦 預設照「一路滾」排:第一列 = c.med 最大的那個
    const bestC = Y.strats.slice().sort((a, b) => (b.c ? b.c.med : -1e18) - (a.c ? a.c.med : -1e18))[0];
    o.defaultC = firstId().includes(`'${bestC.id}'`) && /一路滾/.test(box().querySelector('th.ybsort.on') ? box().querySelector('th.ybsort.on').innerText : '');
    // 決定性對照:改 base 2024 的賺賠,細節卡要跟著變
    const bk = JSON.stringify(base.y['2024']); const ip = Y.cols.indexOf('pnl');
    base.y['2024'][ip] = 9876543; PRO._ybSel = 'base'; PRO.renderYearly(); o.inj = box().innerText.includes('9,876,543');
    base.y['2024'] = JSON.parse(bk); PRO.renderYearly();
    // 決定性對照②:改 now 的一路滾中位,表格那一格與細節都要跟著變(⛔ 不可寫死)
    const cm = now.c.med; now.c.med = 123456789; PRO._ybSel = now.id; PRO.renderYearly();
    // ⚠️ 只看**表格那一列**(細節那一行也會印同一個數字 → 整頁比對會被它救活 = 假綠燈)
    const nowTr = [...box().querySelectorAll('tbody tr[onclick]')].find(t => t.getAttribute('onclick').includes(`'${now.id}'`));
    o.injC = !!nowTr && nowTr.innerText.includes('12,345.7 萬'); now.c.med = cm; PRO.renderYearly();
    // 排序:每一欄都要能排、同欄再點反向
    const ths = [...box().querySelectorAll('th.ybsort')];
    o.headers = ths.length; o.headClick = ths.every(th => /PRO\.ybSort\(/.test(th.getAttribute('onclick') || ''));
    const ir = Y.cols.indexOf('ret');
    PRO._ybSort = null; PRO.ybSort('2022');
    const best22 = Y.strats.filter(s => s.y['2022']).sort((a, b) => b.y['2022'][ir] - a.y['2022'][ir])[0];
    o.sortOk = firstId().includes(`'${best22.id}'`); o.sortArrow = box().innerText.includes('▼');
    PRO.ybSort('2022');
    const worst22 = Y.strats.filter(s => s.y['2022']).sort((a, b) => a.y['2022'][ir] - b.y['2022'][ir])[0];
    o.sortRev = firstId().includes(`'${worst22.id}'`) && box().innerText.includes('▲');
    // 最差一條
    PRO._ybSort = null; PRO.ybSort('clo');
    const bestLo = Y.strats.slice().sort((a, b) => b.c.lo - a.c.lo)[0]; o.sortLo = firstId().includes(`'${bestLo.id}'`);
    // 名稱排序
    PRO._ybSort = null; PRO.ybSort('name'); o.sortName = rowIds().length === Y.strats.length;
    // ⏳ 空值排最後(不論方向):有 na 的那一列在最早那一年排序時,兩個方向都要在最後
    const naS = Y.strats.find(s => s.na);
    if (naS) {
        PRO._ybSort = null; PRO.ybSort(Y.years[0]); const a1 = rowIds(); PRO.ybSort(Y.years[0]); const a2 = rowIds();
        o.naLast = a1.indexOf(naS.id) >= a1.length - Y.strats.filter(s => !s.y[Y.years[0]]).length && a2.indexOf(naS.id) >= a2.length - Y.strats.filter(s => !s.y[Y.years[0]]).length;
        // null 年不可被當 0 加總:它那一列要寫「只算 N 年」
        const tr = [...box().querySelectorAll('tbody tr[onclick]')].find(t => t.getAttribute('onclick').includes(`'${naS.id}'`));
        o.naSum = !!tr && /只算 \d+ 年/.test(tr.innerText);
    } else { o.naLast = true; o.naSum = true; }
    // 點另一列 → 細節換成那一個
    const other = Y.strats.find(s => s.id !== 'base');
    PRO._ybSort = null; PRO.ybPick(other.id); o.pick = box().querySelector('#ybDetail').innerText.includes(other.t.slice(0, 6));
    PRO.ybPick('base');
    o.noToggle = !/2022~2026\(本站資料/.test(box().innerText) && !box().querySelector('[onclick*="ybSet"]');
    // 📦 舊情境庫表頭可排序
    PRO._calcSort = null; PRO.renderCalc();
    const cths = [...document.querySelectorAll('#calcBody th.ybsort')];
    o.calcTh = cths.length; o.calcClick = cths.length >= 5 && cths.every(th => /PRO\.calcSort\(/.test(th.getAttribute('onclick') || ''));
    const d = PRO.BT.dims[PRO._calcDim ?? 0];
    PRO.calcSort('p');
    const firstCalc = (document.querySelector('#calcBody tbody tr td') || {}).textContent || '';   // ⚠️ 舊情境庫在關著的 <details> 裡 → innerText 是空的,要用 textContent
    const bestP = d.rows.filter(r => r.p != null).sort((a, b) => b.p - a.p)[0];
    o.calcSortOk = firstCalc.replace(/\s+/g, '').includes(String(bestP.t).replace(/<[^>]*>/g, '').replace(/\s+/g, '').slice(0, 8));
    PRO.calcSort('p'); o.calcRev = !!document.querySelector('#calcBody th.ybsort.on') && /▲/.test(document.querySelector('#calcBody th.ybsort.on').textContent);
    return o;
});
await browser.close();
ok('③ 沒有 pageerror', !errs.length, errs.join(' | '));
ok('③b 總表列數 = 策略數 + 3 列對照(0050 不含息 / 含息 / 加權)', Y && R.rows === Y.strats.length + 3, `${R.rows}`);
ok('③c 決定性對照:改常數,畫面要跟著變(⛔ 不寫死)', R.inj);
ok('③c2 決定性對照:改「一路滾」中位,畫面要跟著變', R.injC);
ok('③d 每一欄都可排序(名稱 + 一路滾 3 欄 + 每一年 + 加起來 + 贏幾年),點了排對、有箭頭、再點反向', Y && R.headers === 1 + 3 + Y.years.length + 2 && R.headClick && R.sortOk && R.sortArrow && R.sortRev && R.sortLo && R.sortName, JSON.stringify({ h: R.headers, s: R.sortOk, r: R.sortRev, lo: R.sortLo }));
ok('③d2 🏦 預設照「一個帳戶一路滾」排(⛔ 不是每年重放的加總)', R.defaultC);
ok('③d3 ⏳ 沒有資料的年份:排序兩個方向都排最後、加總寫「只算 N 年」(⛔ 不可當 0)', R.naLast && R.naSum, JSON.stringify({ l: R.naLast, s: R.naSum }));
ok('③e 點一列 → 細節換成那一個策略', R.pick);
ok('③f 2022 標「空頭」、今年標「至今」、0050 含息與不含息都有、有加權', /空頭/.test(R.txt) && /至今/.test(R.txt) && R.txt.includes('0050 買了放著(不含息') && R.txt.includes('0050 買了放著(含息)') && /加權指數/.test(R.txt));
ok('③g 白話欄位:年底 / 賺賠(不含本金)/ 每做一筆平均(期望值)/ 賺錢的比例 / 同一年 0050 / 一路滾', ['年底', '不含本金', '期望值', '賺錢的比例', '同一年 0050', '一路滾'].every(k => R.txt.includes(k)));
ok('③h 390px 不可以整頁橫捲', R.sx <= 2, R.sx);
ok('③i 寫明「每年重新放 100 萬」「加起來不能拿來排誰最強」「倖存者偏誤」', /重新放 100 萬/.test(R.txt) && /不能拿來排誰最強/.test(R.txt) && /倖存者偏誤/.test(R.txt));
ok('③k ⛔ 只剩一張表:不再有「2022~2026(本站資料)」與切換鈕', R.noToggle);
ok('③l 📦 舊版情境庫表頭每一欄都能點排序,點了排對、再點反向', R.calcClick && R.calcSortOk && R.calcRev, JSON.stringify({ n: R.calcTh, c: R.calcClick, s: R.calcSortOk, r: R.calcRev }));
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ YEARLY_BT_PASS');
process.exit(fails.length ? 1 : 0);
