// 📏 V77.5.8 釣魚分頁「準不準」—— ④ 紀律卡 + 🧺 計分板
//   使用者:「為什麼附件的釣魚系統釣起來的魚隔天漲停那麼準,如何優化我的釣魚系統」。
//   實測(scripts/pond_probe.mjs):「今日漲幅前 60」每天平均 6 條隔天漲停、96% 的日子至少一條 = 分母錯覺;
//   隔天上漲機率跟隨便抽幾乎一樣,多出來的只有漲停那端,而那批大多買不到、買得到的扣成本是負的。
//
// ⛔ 這支釘的用意(每條都做過注入驗證):
//   ⓐ 空籃 / 沒有隔日資料 → 計分板不顯示(⛔ 不留空殼)
//   ⓑ 計數正確:分母 + 隔天漲 + 隔天漲停(≥9.5%)+ 已結算贏大盤
//   ⓒ ⭐ 一定印對照組(隨便挑 / 附件那種),而且數字**讀 `_POND_EDGE`**(改常數 → 畫面跟著變)
//   ⓓ 樣本 <10 條 ⛔ 不下結論
//   ⓔ ④ 紀律卡的數字也讀常數,並寫出「買不到 / 扣成本」那一半(⛔ 只講命中的那一半 = 別人的魚看起來很準的原因)
//   ⓕ 接線:計分板真的被漁獲籃畫出來、④ 真的被 03 紀律卡畫出來
//   ⓖ 無 pageerror
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };

const SRC = readFileSync('pro.html', 'utf8');
const body = head => { const i = SRC.indexOf(head); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n  },', i)); };
const noComment = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// ⓕ 接線(靜態,⛔ 先剝掉註解 —— 註解裡提到函式名會救活斷言)
const basket = noComment(body('  _fishBasketRender() {'));
ok(basket.length > 500 && basket.includes('this._fishTallyHtml(rows)'), 'ⓕ 漁獲籃真的畫出計分板');
const rules = noComment(body('  _rodRulesHtml(D) {'));
ok(rules.length > 300 && rules.includes('this._rodPondRule()'), 'ⓕ2 03 紀律卡真的畫出 ④ 準不準');

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._fishTallyHtml, null, { timeout: 30000 });

const R = await pg.evaluate(() => {
  const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent || ''; };
  const row = (n1, fin, ex) => ({ sym: 'X', st: { next1: n1, open: !fin, ex } });
  const E = PRO._POND_EDGE;
  const out = {};
  out.empty = PRO._fishTallyHtml([]);
  out.noNext = PRO._fishTallyHtml([{ sym: 'A', st: { next1: null, open: true } }, { sym: 'B', st: null }]);
  // 12 條:隔天漲 7 條(其中 2 條 ≥9.5 = 漲停;+7% 那條⛔ 不算漲停 —— 注入「門檻寫成 5」要叫得出來)、跌 5 條;已結算 4 條,贏大盤 3 條
  const rows = [10, 9.6, 7, 2, 1, 0.5, 0.2, -1, -2, -3, -4, -0.1].map((v, i) => row(v, i < 4, i < 3 ? 1 : -1));
  out.full = txt(PRO._fishTallyHtml(rows));
  out.small = txt(PRO._fishTallyHtml(rows.slice(0, 5)));
  out.base = { all: E.all.lu, allUp: E.all.up, p1: E.p1.lu, p1Up: E.p1.up, n: E.n };
  // ⓒ 注入:改常數 → 畫面必須跟著變
  const save = JSON.stringify(E);
  E.all.lu = 12.34; E.p1.lu = 56.78;
  out.inj = txt(PRO._fishTallyHtml(rows));
  Object.assign(E, JSON.parse(save));
  out.rule = txt(PRO._rodPondRule());
  E.p1.perDay = 9.87; E.p1.lock = 76.54;
  out.ruleInj = txt(PRO._rodPondRule());
  Object.assign(E, JSON.parse(save));
  out.E = E;
  return out;
});
const E = R.E;
ok(R.empty === '' && R.noNext === '', 'ⓐ 空籃 / 沒有隔日資料 → 不顯示', JSON.stringify([R.empty.length, R.noNext.length]));
ok(/釣過 12 條/.test(R.full) && /隔天漲 7 條\(58\.3%\)/.test(R.full) && /隔天漲停 2 條\(16\.7%\)/.test(R.full), 'ⓑ 分母 12 / 隔天漲 7 / 漲停 2(≥9.5%)', R.full.slice(0, 120));
ok(/已結算贏大盤 3\/4/.test(R.full), 'ⓑ2 已結算贏大盤 3/4(持有中的不算)');
ok(R.full.includes(`漲停 ${E.all.lu}%`) && R.full.includes(`漲停 ${E.p1.lu}%`) && R.full.includes(`今日漲幅前 ${E.n}`), 'ⓒ 一定印對照組(隨便挑 + 附件那種)');
ok(R.inj.includes('12.34%') && R.inj.includes('56.78%') && !R.inj.includes(`漲停 ${E.all.lu}%`), 'ⓒ2 對照組數字讀 _POND_EDGE(注入改常數 → 畫面跟著變)');
ok(/⭐ 準不準/.test(R.full) && !/⏳ 才/.test(R.full), 'ⓓ 12 條 → 可以講準不準');
ok(/⏳ 才 5 條/.test(R.small) && !/⭐ 準不準/.test(R.small), 'ⓓ2 5 條 → ⛔ 不下結論');
ok(R.rule.includes(`${E.p1.perDay} 條隔天漲停`) && R.rule.includes(`${E.p1.dayAny}% 的日子`), 'ⓔ ④ 印出「每天幾條 / 幾成的日子」(分母錯覺那一半)');
ok(R.rule.includes(`${E.p1.lock}% 今天就鎖死買不到`) && /扣成本平均 [-−]?\d/.test(R.rule) && R.rule.includes(`${E.p1.up}% vs 隨便抽 ${E.p0.up}%`), 'ⓔ2 ④ 也印出「買不到 / 扣成本 / 上漲機率跟隨便抽一樣」那一半');
ok(R.ruleInj.includes('9.87 條') && R.ruleInj.includes('76.54%'), 'ⓔ3 ④ 的數字讀 _POND_EDGE(注入改常數 → 跟著變)');
ok(E.p1.lu > E.p0.lu && E.p1.up - E.p0.up < 3 && E.p1.net < 0 && E.days >= 250, 'ⓔ4 常數本身合理(漲停率高於隨機、上漲率差 <3pp、扣成本為負、≥250 天)');
ok(!errs.length, 'ⓖ 無 pageerror', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ test_fishscore 全過');
process.exit(bad ? 1 : 0);
