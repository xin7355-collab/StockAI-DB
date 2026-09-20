#!/usr/bin/env node
/**
 * 🧪 V77.3.6 App 內自訂回測守門(`_cbtSym` / `_cbtStats` / `_customBacktest` / 控制列)
 *   ① 合成 K 線 + stub 型態:訊號日已知 → 趟數 / 報酬 / 抱幾天算得對;出場一律走 `_exitLevelAt`(⛔ 不可另寫一份)
 *   ② 🧬 濾網:波動為 0 的合成股一趟都不准進;拿掉濾網就有
 *   ③ 型態多選:只跑選到的那幾種
 *   ④ 回歸:同一檔真實資料、同出場、全部型態、不濾 → 每一招的趟數跟既有 `_patternFitBacktest` **一模一樣**(同一份真相)
 *   ⑤ 統計:n < `_wrEnough()` 一律「樣本不足」不給關卡;≥ 才有四關;每趟已扣 0.44
 *   ⑥ 取消:跑到一半按取消 → 停下來、印「已取消」、按鈕復原
 *   ⑦ 控制列從 UI 讀設定(母體 / N / 出場 / 🧬 / 型態)
 * 注入:① `_cbtSym` 的 `- 0.44` 拿掉 → ⑤b 紅 ② `_exitLevelAt` 換成寫死 ma5 → ④ 紅(選 don 時)③ gene 判斷改成恆 true → ② 紅 ④ 取消旗標不看 → ⑥ 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails.push(n); };
if (!fs.existsSync(path.join(ROOT, 'data', '2330.json'))) { console.log('❌ 沒有 data/2330.json —— ⛔ 不跑假測試'); process.exit(1); }

// 靜態
const fn = CODE.slice(CODE.indexOf('_cbtSym(data, cfg) {'), CODE.indexOf('async _cbtUniverse(cfg) {'));
ok('⓪ 切得到 _cbtSym(空過守門)', fn.length > 800, String(fn.length));
ok('①s 出場只走 `_exitLevelAt`(⛔ 不可在這裡另寫 5 日線 / 唐奇安)', /this\._exitLevelAt\(data, i, j, exKey\)/.test(fn) && !/sm \/ 5/.test(fn), '');
ok('⑦s 舊入口 `_runSignalScorecard` 改走自訂回測(⛔ 不留第二套)', /async _runSignalScorecard\(force\) \{ return this\._customBacktest\(\); \}/.test(CODE), '');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', () => {});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._cbtSym, null, { timeout: 25000 });
await page.waitForTimeout(1500);
await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, '2330');
await page.waitForTimeout(6000);

const R = await page.evaluate(async () => {
    const A = app;
    // ── ① 合成:每天 +1%,型態 T 在 i%50===0 觸發;出場 ma5(價格一路漲,永遠不破 5 日線 → 抱滿 20 天)
    const mk = (n, step) => { const d = []; let c = 100; const day = new Date(Date.UTC(2023, 0, 2)); for (let i = 0; i < n; i++) { c = c * (1 + step(i)); while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1); d.push({ date: day.toISOString().slice(0, 10).replace(/-/g, '/'), open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 }); day.setUTCDate(day.getUTCDate() + 1); } return d; };
    const up = mk(400, () => 0.01);
    const orig = A._playbookPatternDefs;
    A._playbookPatternDefs = () => [{ key: 'T', test: i => i % 50 === 0 }, { key: 'U', test: i => i % 77 === 0 }];
    const tr = A._cbtSym(up, { exit: 'ma5', gene: false, patterns: null });
    const trT = tr.filter(t => t.key === 'T');
    const trOnlyT = A._cbtSym(up, { exit: 'ma5', gene: false, patterns: ['T'] });
    const trGene = A._cbtSym(up, { exit: 'ma5', gene: true, patterns: null });
    // 抱 20 天 +1%/天 → 1.01^20−1 = 22.02%
    const stats = A._cbtStats(trT);
    const small = A._cbtStats(trT.slice(0, 3));
    A._playbookPatternDefs = orig;
    // ── ④ 回歸:真實 2330、同出場、全部型態、不濾 → 趟數對得上 _patternFitBacktest
    const data = A.activeData;
    const exKey = A._exitRuleKey();
    const ref = A._patternFitBacktest(data) || [];
    const mine = A._cbtSym(data, { exit: exKey, gene: false, patterns: null });
    const cnt = {}; for (const t of mine) cnt[t.key] = (cnt[t.key] || 0) + 1;
    const mism = ref.filter(r => (cnt[r.key] || 0) !== r.count).map(r => `${r.key}:${r.count} vs ${cnt[r.key] || 0}`);
    const mineDon = A._cbtSym(data, { exit: 'don', gene: false, patterns: null }).length, mineMa5 = A._cbtSym(data, { exit: 'ma5', gene: false, patterns: null }).length;
    // ── ⑦ 控制列
    A._openSignalScore();
    const g = id => document.getElementById(id);
    g('cbtUniverse').value = 'fav'; g('cbtN').value = '7'; g('cbtExit').value = 'trail8'; g('cbtGene').checked = true;
    const boxes = [...document.querySelectorAll('.cbt-pat')]; boxes.forEach((b, i) => { b.checked = i < 2; });
    const cfg = A._cbtCfgFromUI();
    // ── ⑥ 取消:把母體 stub 成 30 檔全用 2330 的資料,跑到第 3 檔就取消
    A._cbtUniverse = async () => Array.from({ length: 30 }, (_, i) => `2330`);
    const origGet = A.idb.get; A.idb.get = async (k) => ({ data: data });
    const p = A._customBacktest();
    await new Promise(r => setTimeout(r, 400));
    A._cbtCancel();
    await p;
    const prog = g('cbtProg') ? g('cbtProg').textContent : '';
    const res = A._cbtLast;
    A.idb.get = origGet;
    return { n: tr.length, nT: trT.length, hold: trT.map(t => t.hold), ret: trT.map(t => +t.ret.toFixed(2)), onlyT: trOnlyT.every(t => t.key === 'T') && trOnlyT.length === trT.length, gene: trGene.length,
             stats, small, wrEnough: A._wrEnough(7), refN: ref.length, mism, mineDon, mineMa5, cfg, boxes: boxes.length,
             prog, aborted: res && res.aborted, done: A._cbtState.done, total: A._cbtState.total, runBtnOn: g('cbtRunBtn') && !g('cbtRunBtn').disabled, stopHidden: g('cbtStopBtn') && g('cbtStopBtn').classList.contains('hidden'),
             html: g('cbtResult').innerHTML };
});
await browser.close();

ok('① 合成 400 根、T 每 50 根觸發一次(i=50..350,i=45 起)→ 7 趟,每趟抱滿 20 天、+22.02%', R.nT === 7 && R.hold.every(h => h === 20) && R.ret.every(r => Math.abs(r - 22.02) < 0.05), JSON.stringify([R.nT, R.hold, R.ret]));
ok('③ 型態多選只跑選到的(patterns=[T] → 只有 T,趟數同)', R.onlyT === true && R.n > R.nT, JSON.stringify([R.n, R.nT, R.onlyT]));
ok('② 🧬 濾網:每天固定 +1% 的合成股波動 = 0 → 一趟都不進;拿掉濾網有 7 趟', R.gene === 0 && R.nT === 7, String(R.gene));
ok('④ ⭐ 回歸:真實 2330 全部型態同出場 → 每一招趟數跟 `_patternFitBacktest` 一模一樣(同一份出場真相)', R.refN > 3 && R.mism.length === 0, JSON.stringify(R.mism.slice(0, 4)));
ok('④b 換出場規則趟數會變(don vs ma5 不同 → 出場真的吃 cfg.exit)', R.mineDon !== R.mineMa5, JSON.stringify([R.mineDon, R.mineMa5]));
ok('⑤ n=3 → 樣本不足、不給關卡;n=7 跟 `_wrEnough(7)` 一致(⛔ 第一版 `n >= _wrEnough()` = 恆 true 就是這條抓到的)', R.small.enough === false && R.small.gates === null && R.stats.enough === R.wrEnough && R.wrEnough === false, JSON.stringify([R.small.enough, R.stats.enough, R.wrEnough]));
ok('⑤b 每趟已扣 0.44(22.02 − 0.44 = 21.58)', Math.abs(R.stats.per - 21.58) < 0.02, String(R.stats.per));
ok('⑦ 控制列讀得到:母體 fav / N=7 / 出場 trail8 / 🧬 開 / 型態只留兩種', R.cfg.universe === 'fav' && R.cfg.n === 7 && R.cfg.exit === 'trail8' && R.cfg.gene === true && Array.isArray(R.cfg.patterns) && R.cfg.patterns.length === 2 && R.boxes > 5, JSON.stringify(R.cfg));
ok('⑥ ⭐ 取消:跑到一半停下(done < total)、印「已取消」、結果標 aborted、按鈕復原', R.aborted === true && R.done < R.total && /已取消/.test(R.prog) && R.runBtnOn === true && R.stopHidden === true, JSON.stringify([R.aborted, R.done, R.total, R.prog]));
ok('⑥b 取消後仍畫出跑到一半的結果(⛔ 不是空白)', /data-cbt="overall"/.test(R.html) && /跑到一半取消/.test(R.html), R.html.slice(0, 120));
ok('⑧ 畫面寫明「不是 49 個月資金模擬、不含 2022、已扣成本」三個限制', /不是決策台那套 49 個月/.test(R.html) && /不含 2022/.test(R.html) && /已扣來回成本 0\.44%/.test(R.html), '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ CUSTOM_BACKTEST_PASS');
process.exit(fails.length ? 1 : 0);
