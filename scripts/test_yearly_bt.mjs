#!/usr/bin/env node
/**
 * 📅 V77.6.1 逐年成績單守門(portfolio_backtest YEAR 模式 + yearly_bt.mjs + pro.html `_YEARLY_BT` / renderYearly)
 *   ① 引擎:YEAR 只影響「哪一天開倉」—— 取代 WARMUP 的那一行、過了那一年不再開倉、⛔ 不進 CACHE_KEY、n=0 要誠實寫出來
 *   ② 嵌入:每個策略 2022~2026 五格都在、2022 對照是空頭、有「決策台現行」、策略數 == STRATS
 *   ③ 畫面:數字讀常數(決定性對照)・表頭可排序・點一列換細節・2026 標至今・2022 標空頭・0050 兩列 + 加權・390px 不橫捲
 *   ④ 重跑不了的列要寫原因
 * 注入(逐一確認會紅):畫面寫死一個數字 / 拿掉 2022 / 過了那一年照樣開倉 / YEAR 進 CACHE_KEY
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRATS, YEARS, SKIPPED } from './yearly_bt.mjs';

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
    ok(`②b 策略數 == yearly_bt.mjs 的 STRATS(${STRATS.length})`, Y.strats.length === STRATS.length, Y.strats.length);
    ok('②c 每個策略每一年都有值(2022~2026)', Y.strats.every(s => YEARS.every(y => Array.isArray(s.y[y]) && s.y[y].length === Y.cols.length)));
    ok('②d 2022 的加權對照是負的(那一年是空頭;⛔ 窗口不含空頭就不算數)', Y.bench['2022'] && Y.bench['2022'].twii < 0, JSON.stringify(Y.bench['2022']));
    ok('②e 有「決策台現行」那一列', Y.strats.some(s => s.id === 'base'));
    ok('②f 重跑不了的列有寫原因', (Y.skipped || []).length === SKIPPED.length && Y.skipped.every(x => x.why && x.why.length > 10));
}

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
    PRO._labSel = 'bt'; PRO.renderLab();
    const box = () => document.getElementById('yearlyBody');
    const o = {};
    o.txt = box().innerText; o.rows = box().querySelectorAll('tbody tr').length;
    window.scrollTo(80, 0); o.sx = window.scrollX;
    const Y = PRO._YEARLY_BT, base = Y.strats.find(s => s.id === 'base');
    // 決定性對照:改 base 2024 的賺賠,細節卡要跟著變
    const bk = JSON.stringify(base.y['2024']); const ip = Y.cols.indexOf('pnl');
    base.y['2024'][ip] = 9876543; PRO._ybSel = 'base'; PRO.renderYearly(); o.inj = box().innerText.includes('9,876,543');
    base.y['2024'] = JSON.parse(bk); PRO.renderYearly();
    // 排序:點 2022 → 第一列(0050/加權之後)要是 2022 報酬最高的那一個
    PRO._ybSort = null; PRO.ybSort('2022');
    const firstId = (box().querySelector('tbody tr[onclick]') || {}).getAttribute ? box().querySelector('tbody tr[onclick]').getAttribute('onclick') : '';
    const ir = Y.cols.indexOf('ret'); const best = Y.strats.slice().sort((a, b) => b.y['2022'][ir] - a.y['2022'][ir])[0];
    o.sortOk = firstId.includes(`'${best.id}'`); o.sortArrow = box().innerText.includes('▼');
    // 點另一列 → 細節換成那一個
    const other = Y.strats.find(s => s.id !== 'base');
    PRO._ybSort = null; PRO.ybPick(other.id); o.pick = box().querySelector('#ybDetail').innerText.includes(other.t.slice(0, 6));
    PRO.ybPick('base');
    o.headers = [...box().querySelectorAll('th.ybsort')].length;
    return o;
});
await browser.close();
ok('③ 沒有 pageerror', !errs.length, errs.join(' | '));
ok('③b 總表列數 = 策略數 + 3 列對照(0050 不含息 / 含息 / 加權)', Y && R.rows === Y.strats.length + 3, `${R.rows}`);
ok('③c 決定性對照:改常數,畫面要跟著變(⛔ 不寫死)', R.inj);
ok('③d 表頭可排序(每一年 + 加起來 + 贏幾年),點了排對、有箭頭', R.headers === YEARS.length + 2 && R.sortOk && R.sortArrow, JSON.stringify({ h: R.headers, s: R.sortOk }));
ok('③e 點一列 → 細節換成那一個策略', R.pick);
ok('③f 2022 標「空頭」、今年標「至今」、0050 含息與不含息都有、有加權', /空頭/.test(R.txt) && /至今/.test(R.txt) && R.txt.includes('0050 買了放著(不含息') && R.txt.includes('0050 買了放著(含息)') && /加權指數/.test(R.txt));
ok('③g 白話欄位:年底 / 賺賠(不含本金)/ 每做一筆平均(期望值)/ 賺錢的比例 / 同一年 0050', ['年底', '不含本金', '期望值', '賺錢的比例', '同一年 0050'].every(k => R.txt.includes(k)));
ok('③h 390px 不可以整頁橫捲', R.sx <= 2, R.sx);
ok('③i 寫明「每年重新放 100 萬」與「倖存者偏誤」', /重新放 100 萬/.test(R.txt) && /倖存者偏誤/.test(R.txt));
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ YEARLY_BT_PASS');
process.exit(fails.length ? 1 : 0);
