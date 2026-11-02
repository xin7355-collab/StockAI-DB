#!/usr/bin/env node
/**
 * 💰 最低手續費 + 零股「不到多少錢就收最低手續費」門檻
 *   以前 `_netPL` 只算「金額 × 0.1425% × 折數」→ 小額 / 零股的手續費被算少、淨賺被算多(1 萬元的零股 0.28 折算 4 元,券商收 20 元)。
 *
 *  Ⓐ 純函式(node 直接跑;函式原文從 index.html 抽出來):
 *   ① _minFee:預設 20;0~100 照用;空白 / null / 負數 / 超過 100 / 亂打 → 20(⛔ 變成 0 讓小額試算偷偷變便宜)
 *   ② _feeOf:每一邊 max(最低手續費, 四捨五入(金額 × 0.1425% × 折數));disc 參數(當沖試算機那格)蓋過設定
 *   ③ _netPL:大額跟以前一樣(100 → 110 一張 = 9,586,舊公式也是 9,586)・小額收最低手續費(10 → 11 一百股:舊 96 → 新 57)・
 *      最低手續費 1 元 → 95 ・決定性對照:最低手續費 0 → 跟只算百分比、每邊四捨五入一樣
 *   ④ 門檻 = 最低手續費 ÷(0.1425% × 折數):20 元 / 0.28 → 50,125 元;沒打折 → 14,035(舊說明的「14,000」只對沒打折的人)・
 *      _minFeeNote 只在不到門檻時出現 ・_minFeeListNote 清單底下講一次、算幾筆
 *  Ⓑ 畫面(Playwright,390 寬):
 *   ⑤ 設定:有「最低手續費(元)」欄、跟折數放在一起(常用區,⛔ 收進摺疊)、說明寫「很多券商零股低消 1 元,自己查」・
 *      存檔時壞值 → 20、0 → 0、打開設定讀回來;底下那一行門檻跟著你的設定變
 *   ⑥ 「零股操作」說明:⛔ 再寫死「14,000」;門檻用你的折數與最低手續費算(改折數就跟著變)
 *   ⑦ 當沖試算機:1 張 10 → 10.5,0.28 折 → 手續費兩邊都收 20、淨 +444;損益兩平價用「收最低手續費」那一段解
 *   ⑧ 賣出預覽:小額那筆寫「手續費收最低 20 元」、淨損益 = _netPL;大額 ⛔ 出現
 *   ⑨ 新的字 ⛔ 🔴🟢、⛔ 研究字樣;⓪ 沒有 pageerror
 * 跑法:node scripts/test_minfee.mjs
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

// ── Ⓐ ──
const NEED = ['_feeDisc', '_minFee', '_feeOf', '_oddLotMin', '_oddLotFeeTxt', '_minFeeNote', '_minFeeListNote', '_netPL'];
const A = (0, eval)(`({${NEED.map(n => extractMember(SRC, n)).join(',\n')}})`);
const old = (b, s, sh, fd = 0.28) => Math.round((s - b) * sh - (b + s) * sh * 0.001425 * fd - s * sh * 0.003);   // 改之前的公式(對照用)
A.settings = {};
ok('① 沒設定 → 最低手續費 20', A._minFee() === 20);
const mf = v => { A.settings = { minFee: v }; return A._minFee(); };
ok('① 0 / 1 / 100 照用', mf(0) === 0 && mf(1) === 1 && mf(100) === 100 && mf('5') === 5);
ok('① 空白 / null / 負數 / 超過 100 / 亂打 → 20(⛔ 自己變成 0)', [ '', null, undefined, -1, 100.5, 'abc', NaN ].every(v => mf(v) === 20), [ '', null, -1, 100.5, 'abc' ].map(mf).join(','));
A.settings = {};
ok('② 大額照百分比、每邊四捨五入:100,000 元 × 0.0399% = 39.9 → 40', A._feeOf(100000) === 40);
ok('② 小額收最低手續費:5,000 元 → 20(百分比只有 2 元)', A._feeOf(5000) === 20);
ok('② disc 參數蓋過設定(當沖試算機那一格):1 折 = 100,000 元 × 0.1425% = 142.5 → 143', A._feeOf(100000, 1) === 143);
ok('② 金額 0 / 負數 → 0(⛔ 對不存在的交易收最低手續費)', A._feeOf(0) === 0 && A._feeOf(-5) === 0);
ok('③ 大額跟以前一樣:100 → 110 一張 = 9,586(舊公式也是 9,586)', A._netPL(100, 110, 1000) === 9586 && old(100, 110, 1000) === 9586);
ok('③ ⭐ 小額收最低手續費:10 → 11 一百股 = 57(舊公式 96,高估了 39 元)', A._netPL(10, 11, 100) === 57 && old(10, 11, 100) === 96, `${A._netPL(10, 11, 100)} / 舊 ${old(10, 11, 100)}`);
A.settings = { minFee: 1 };
ok('③ 最低手續費設 1 元(很多券商零股低消)→ 95', A._netPL(10, 11, 100) === 95);
A.settings = { minFee: 0 };
const pctOnly = (b, s, sh) => Math.round((s - b) * sh - Math.round(b * sh * 0.000399) - Math.round(s * sh * 0.000399) - s * sh * 0.003);
ok('③ 決定性對照:最低手續費 0 → 等於「只算百分比、每邊四捨五入」', [[10, 11, 100], [55.3, 57.1, 350], [224.47, 230, 500]].every(([b, s, sh]) => A._netPL(b, s, sh) === pctOnly(b, s, sh)));
ok('③ 缺價 / 缺股數 → null', A._netPL(0, 10, 100) === null && A._netPL(10, 11, 0) === null);
A.settings = {};
const o = A._oddLotMin();
ok('④ 門檻 = 20 ÷(0.1425% × 0.28)= 50,125 元', o.amt === 50125 && o.minFee === 20 && o.disc === 0.28, JSON.stringify(o));
A.settings = { feeDiscount: 1 };
ok('④ 沒打折 → 14,035(舊說明的「14,000」只對沒打折的人)', A._oddLotMin().amt === 14035);
A.settings = { minFee: 0 };
ok('④ 最低手續費 0 → 沒有門檻、說明講清楚', A._oddLotMin().amt === 0 && /0 元 → 不管金額多小/.test(A._oddLotFeeTxt()) && A._minFeeNote(1000) === '');
A.settings = {};
ok('④ _minFeeNote:不到門檻才出現', /不到 50,125 元,手續費收最低 20 元/.test(A._minFeeNote(30000)) && A._minFeeNote(60000) === '' && A._minFeeNote(0) === '');
ok('④ _minFeeListNote:清單底下講一次、算幾筆(⛔ 每一列各一次)', /data-minfeelist="2"/.test(A._minFeeListNote([30000, 45000, 90000, 0])) && A._minFeeListNote([90000, 120000]) === '' && A._minFeeListNote(null) === '');
ok('④ 說明文字是算術(門檻 = 最低手續費 ÷ 費率),⛔ 叫人做什麼', /50,125 元\(= 20 ÷ 0\.0399%\)/.test(A._oddLotFeeTxt()) && !/建議|應該|最好/.test(A._oddLotFeeTxt()), A._oddLotFeeTxt());
ok('④ 「14,000」⛔ 再寫死在說明裡', !/14,000/.test(SRC.slice(SRC.indexOf("'零股操作'"), SRC.indexOf("'零股操作'") + 1500)));

// ── Ⓑ ──
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._feeOf === 'function' && typeof app.openSettings === 'function', null, { timeout: 60000 });
await page.waitForTimeout(1500);
const R = await page.evaluate(async () => {
    const A = app, o = {};
    A.settings.feeDiscount = 0.28; delete A.settings.minFee;
    // ⑤ 設定
    A.openSettings();
    const el = document.getElementById('set_minFee'), tip = document.getElementById('set_minFeeTip');
    o.has = !!el; o.inGrp = !!(el && el.closest('details[data-setgrp]'));
    o.sameBox = !!(el && el.closest('[data-setcommon="money"]') && el.closest('[data-setcommon="money"]').contains(document.getElementById('set_feeDiscount')));
    o.val0 = el && el.value; o.tip0 = tip && tip.textContent;
    o.help = el ? el.closest('div.flex-col').textContent : '';
    const save = v => { el.value = v; A.saveSettings(); return A.settings.minFee; };
    o.saves = ['', '-3', '150', 'abc', '0', '1', '100'].map(save);
    o.tipAfter1 = (save('1'), tip.textContent);
    o.persist = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}').minFee;
    A.closeSettings ? A.closeSettings() : null;
    A.settings.minFee = 20; A.openSettings(); o.reopen = document.getElementById('set_minFee').value;
    // ⑥ 零股操作說明
    A.showJargon('零股操作'); o.jg = document.getElementById('jargonDesc').innerText;
    A.settings.feeDiscount = 0.5; A.showJargon('零股操作'); o.jg2 = document.getElementById('jargonDesc').innerText;
    A.settings.feeDiscount = 0.28;
    // ⑦ 當沖試算機:它只認這 5 個 id(當沖頁要先分析一檔才會畫出來)→ 照它的介面放一份,直接叫同一支 _calcDayTradePnl
    if (!document.getElementById('dtResult')) {
        const w = document.createElement('div'); w.id = '__dtcalc';
        w.innerHTML = ['dtBuyPrice', 'dtSellPrice', 'dtLots', 'dtFeeDisc'].map(id => `<input id="${id}">`).join('') + '<div id="dtResult"></div>';
        document.body.appendChild(w);
    }
    const set = (id, v) => { const x = document.getElementById(id); if (x) x.value = v; return !!x; };
    o.dtHas = ['dtBuyPrice', 'dtSellPrice', 'dtLots', 'dtFeeDisc', 'dtResult'].every(id => !!document.getElementById(id));
    if (o.dtHas) {
        set('dtBuyPrice', '10'); set('dtSellPrice', '10.5'); set('dtLots', '1'); set('dtFeeDisc', '0.28');
        A._calcDayTradePnl(); o.dt = document.getElementById('dtResult').innerText;
        set('dtBuyPrice', '100'); set('dtSellPrice', '101'); A._calcDayTradePnl(); o.dtBig = document.getElementById('dtResult').innerText;
    }
    // ⑧ 賣出預覽
    const item = { symbol: '9999', cost: 10, shares: 0.5 };
    o.sellSmall = A._invSellPreviewHtml(item, 11, 300);
    o.sellSmallNet = A._netPL(10, 11, 300);
    o.sellBig = A._invSellPreviewHtml({ symbol: '9999', cost: 100, shares: 2 }, 110, 2000);
    o.all = [tip.textContent, o.jg, o.sellSmall, A._minFeeListNote([30000])].join('\n');
    return o;
});
const T = h => String(h || '').replace(/<[^>]+>/g, ' ');
ok('⑤ 設定有「最低手續費」欄,跟折數同一格(常用區,⛔ 收進摺疊)', R.has && !R.inGrp && R.sameBox);
ok('⑤ 說明寫「很多券商零股低消 1 元,自己查」', /很多券商零股低消 1 元,自己查/.test(R.help), R.help.slice(0, 200));
ok('⑤ 沒設定 → 欄位顯示 20、底下那行門檻 50,125 元', R.val0 === '20' && /50,125 元/.test(R.tip0), `${R.val0} | ${R.tip0}`);
ok('⑤ 存檔驗證:空白 / −3 / 150 / 亂打 → 20;0 / 1 / 100 照存', JSON.stringify(R.saves) === JSON.stringify([20, 20, 20, 20, 0, 1, 100]), JSON.stringify(R.saves));
ok('⑤ 改成 1 元 → 底下那行跟著變(2,506 元)、存進 localStorage', /2,506 元/.test(R.tipAfter1) && R.persist === 1, `${R.tipAfter1} | ${R.persist}`);
ok('⑤ 打開設定讀回來', R.reopen === '20', R.reopen);
ok('⑥ 「零股操作」說明用你的設定算:50,125 元、⛔ 再寫 14,000', /50,125 元/.test(R.jg) && !/14,000/.test(R.jg) && !/\{\{/.test(R.jg), R.jg.slice(0, 260));
ok('⑥ 改折數 0.5 → 說明跟著變(28,070 元)', /28,070 元/.test(R.jg2), R.jg2.slice(0, 260));
ok('⑦ 當沖試算機的輸入框都在(⛔ 空過)', R.dtHas);
ok('⑦ 1 張 10 → 10.5、0.28 折:手續費兩邊都收最低 20、淨 +444', /\+444 元/.test(R.dt || '') && /-20[\s\S]*-20/.test(R.dt || ''), (R.dt || '').replace(/\s+/g, ' ').slice(0, 260));
ok('⑦ 損益兩平價用「收最低手續費」那一段解:(10,000 + 20 + 20)÷(1,000 × 0.9985)= 10.06,並寫出收最低手續費', /10\.06/.test(R.dt || '') && /手續費收最低 20 元/.test(R.dt || ''), (R.dt || '').replace(/\s+/g, ' ').slice(-160));
ok('⑦ 決定性對照:100 → 101 一張(10 萬元)照百分比(1,000 − 40 − 40 − 當沖稅 152 = +768),⛔ 寫收最低手續費', /\+768 元/.test(R.dtBig || '') && !/收最低/.test(R.dtBig || ''), (R.dtBig || '').replace(/\s+/g, ' ').slice(0, 200));
ok('⑧ 賣出預覽:小額寫「手續費收最低 20 元」、淨損益 = _netPL(⛔ 另算一份)', /手續費收最低 20 元/.test(T(R.sellSmall)) && T(R.sellSmall).includes(`+${R.sellSmallNet.toLocaleString()} 元`), T(R.sellSmall));
ok('⑧ 決定性對照:大額 ⛔ 出現那句', !/收最低/.test(T(R.sellBig)));
ok('⑨ 新的字 ⛔ 🔴🟢', !/[🔴🟢]/u.test(R.all));
const bad = badOf(T(R.all));
ok('⑨ 新的字 ⛔ 研究字樣', !bad.length, bad.join(' '));
ok('⓪ 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 項失敗' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
