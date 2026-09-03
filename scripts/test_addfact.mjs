#!/usr/bin/env node
/**
 * 📈 V74.6.1 「加碼」的誠實處置(使用者問「每個個股的進場/加碼/退場都有做了嗎」)
 *
 * 查證結果:**加碼實際上沒有做** —— `_ovDecide` 的 'add' 只在「沒有庫存」那一邊,
 *   有部位的人永遠拿不到;`case 'add'` 裡的 `held ? '📈 符合加碼' : …` 是**死碼**。
 * ⛔ 但也不可以就這樣接上一條加碼規則 —— 回測顯示加碼「看起來有效卻沒過全部關卡」
 *   (逐年那一關 2025 是負的)。→ 折衷:**有庫存又符合條件時只講事實,⛔ 不下加碼指令**。
 *
 * ⛔ 六條釘死:
 *  ① 空手 + 符合條件 → 「📈 符合進場」(⛔ 不可再出現「符合加碼」那個死字串)
 *  ② 有庫存 + 符合條件 → 要講「它現在又符合當初的進場條件了」(⛔ 現在完全看不到 = 陷阱 #32)
 *  ③ 🚨 而且**必須同時寫「這不是叫你加碼」+ 沒過關的那一年**(⛔ 不可只講好的一半)
 *  ④ 數字讀 `_ADD_EDGE`,⛔ 不可寫死(換一份假表畫面要跟著變)
 *  ⑤ ⛔ 空頭(`_bearGate`)不可出現這段
 *  ⑥ ⛔ 整段不可出現「建議加碼 / 可以加碼」這種指令
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import fs from 'fs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, x) => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + JSON.stringify(x ?? ''))); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => { if (!/echarts is not defined/.test(String(e))) errs.push(String(e)); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && app._ADD_EDGE, null, { timeout: 30000 });

const R = await page.evaluate(() => {
    // 🧪 造一檔「🧬 高位階 + 高波動 + 還沒跌破出場線」的資料
    //   ⭐ 測資自己先算一遍:一路走高 → 位階 100、今天收在最高 → 不會跌破 5 日線
    const rows = [];
    for (let i = 0; i < 300; i++) {
        const c = 50 + i * 0.5;                      // 平穩上漲 → 位階 100
        rows.push({ date: '2026-01-01', open: c * 0.97, high: c * 1.04, low: c * 0.96, close: c, volume: 1000 });
    }
    const run = (held, bear) => {
        app._ovTrend = bear ? { sym: 'T', trend: 'bear', txt: '' } : null;
        app._exitMode = null;
        // 庫存:成本遠低於現價 → held 且沒跌破
        app._getInventory = () => held ? [{ symbol: 'T', cost: 60, shares: 1, buyDate: null }] : [];
        // 🧬 gene 讀 `_scrData.rows[sym]` 的 pos252 / amp20 → stub 一筆高位階高波動
        //   ⚠️ 第一版沒 stub 這個 → gene 恆為 null → 那段永遠不會出現(假失敗,⛔ 不是程式錯)
        app._scrData = { rows: { T: { pos252: 92, amp20: 6.5 } } };
        const realV = app._scrV; app._scrV = (row, k) => row ? row[k] : null;
        // 期望值為正的看多訊號:`_entryCheckup` 回的是 `proven`(⛔ 不是 bullets),
        //   而且每一筆要有 `tone:'bull'` 與 `_e.exp > 0`(⛔ 少一個就篩掉了)
        app._ecCache = null;
        const realEC = app._entryCheckup;
        app._entryCheckup = () => ({ verdict: '', proven: [{ tone: 'bull', title: '測試訊號', _e: { exp: 1.2 } }] });
        let html = '';
        // ⚠️ 簽名是 (data, sym),回傳的是**物件**不是 HTML(第一版兩個都寫錯 → 三條假失敗)
        try { const d = app._ovDecide(rows, 'T'); html = d ? (d.badge + ' ｜ ' + d.why) : ''; }
        catch (e) { html = 'ERR:' + e.message; }
        app._entryCheckup = realEC; app._scrV = realV;
        return typeof html === 'string' ? html : JSON.stringify(html);
    };
    const out = { free: run(false, false), held: run(true, false), heldBear: run(true, true) };
    // ⭐ 真正擋住空頭的是 `state`(bear → reduce,根本走不到 hold),⛔ 不是 hold 裡那個 `!bear`
    //   —— 注入驗證抓到的:把 `!bear` 拿掉測試照樣綠(陷阱 #35:別以為有 if 就安全)。
    out.bearState = (() => { app._ovTrend = { sym: 'T', trend: 'bear', txt: '' }; app._exitMode = null;
        app._getInventory = () => [{ symbol: 'T', cost: 60, shares: 1, buyDate: null }];
        const d = app._ovDecide(rows, 'T'); return d ? d.state : null; })();
    out.edge = JSON.parse(JSON.stringify(app._ADD_EDGE));   // ⛔ 斷言不寫死年份(重跑回測會變)
    const real = JSON.parse(JSON.stringify(app._ADD_EDGE));
    app._ADD_EDGE = { base: 11.11, best: 22.22, up: 9, verdict: '假的判定', failYear: '1999', exit: '假出場', yrs: 'x' };
    out.fake = run(true, false);
    app._ADD_EDGE = real;
    return out;
});
await browser.close();

const strip = h => String(h).replace(/<[^>]+>/g, '');
const F = strip(R.free), H = strip(R.held), B = strip(R.heldBear), K = strip(R.fake);

// ⓪ 空過守門:三種情境都要真的渲染得出東西(⛔ 空字串會讓下面每一條都假通過)
ok('⓪ 🚧 空過守門:三種情境都渲染得出內容', F.length > 20 && H.length > 20 && B.length > 20,
   [F.length, H.length, B.length]);
ok('① ⛔「符合加碼」那個死字串不可再出現在畫面上', !/符合加碼/.test(F + H + B),
   (F + H + B).slice(0, 80));
ok('② 有庫存又符合條件 → 要講「又符合當初的進場條件」(⛔ 現在完全看不到)',
   /又符合當初的進場條件/.test(H), H.slice(0, 120));
// ⛔ 年份從 `_ADD_EDGE.failYear` 讀,⛔ 不寫死(重跑回測那個年份會變 → 寫死就變假失敗)
ok('③ 🚨 同一段必須寫「這不是叫你加碼」與沒過關的那一年(⛔ 不可只講好的一半)',
   /不是叫你加碼/.test(H) && H.includes(R.edge.failYear) && /(沒過|逐年)/.test(H),
   [R.edge.failYear, H.slice(0, 160)]);
ok('④ 🚨 數字要讀 `_ADD_EDGE`,⛔ 不可寫死(換假表畫面要跟著變)',
   /22\.22/.test(K) && /1999/.test(K) && !/22\.22/.test(H), [K.length, /22\.22/.test(K)]);
// ⛔ 兩條一起釘:①畫面上不可出現 ②**而且**要釘住真正擋住它的機制(state 走 reduce)
ok('⑤ ⛔ 空頭時不可出現這一段(`_bearGate` 鐵則)', !/又符合當初的進場條件/.test(B), B.slice(0, 100));
ok('⑤b 🚧 而且真正擋住它的是 state —— 空頭 + 有庫存必須走 reduce(⛔ 不是靠 hold 裡那個 !bear)',
   R.bearState === 'reduce', R.bearState);
ok('⑥ ⛔ 不可下加碼指令(建議加碼 / 可以加碼 / 該加碼)',
   !/(建議加碼|可以加碼|該加碼|請加碼)/.test(F + H + B),
   ((F + H + B).match(/建議加碼|可以加碼|該加碼|請加碼/) || [])[0]);
// 🚧 原始碼守門:死碼真的被拿掉了(⛔ 只驗畫面的話,把 case 'add' 整段刪掉也會過)
// ⛔ 第 12 次踩「正確的句子含有被禁的字」:說明這段死碼的**註解本身**就寫著 `held ? …`
//   → 掃描前一定要先把註解行拿掉,並加空過守門確認還剩得下東西。
const fnRaw = SRC.slice(SRC.indexOf("case 'add':"), SRC.indexOf("default:", SRC.indexOf("case 'add':")));
const fn = fnRaw.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok('⑦ 🚧 `case \'add\'` 裡不可再有 `held ?` 三元(那是永遠 false 的死碼)',
   fn.length > 30 && !/held\s*\?/.test(fn), fn.slice(0, 160));   // 🚧 空過守門:剝完註解要還有東西
ok('⑧ 載入無 pageerror', errs.length === 0, errs.join(' | '));
console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ ADDFACT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
