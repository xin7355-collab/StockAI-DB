#!/usr/bin/env node
/**
 * 🧭 V74.5.3 總覽「行動指令中心」(`_ovDecide` / `_renderOvCommand` / `_initOvFold`)
 *
 * 使用者:「總覽變成高度自動化的行動指令中心;決策標準全面改用實測總表當唯一依據,
 *         白名單才准生成建議,黑名單即使觸發也要靜默過濾」。
 * ⛔ 釘死的九件事:
 *   ① 四個 Block 順序:A 狀態+徽章 → B 預警 → C 行動計畫 → D 判讀
 *   ② 徽章五種狀態由 `_ovDecide` 決定(有庫存:出場/減碼/續抱;空手:加碼/觀望)
 *   ③ 🚨 行動計畫**只准**出現白名單規則;黑名單(低檔布局/補漲/布林壓縮…)靜默過濾
 *   ④ 🚨 找不到實測有效訊號 → 顯示指定的預設文字,⛔ 不給點位
 *   ⑤ 出場價位**只讀 `_exitLines`**,數字**只讀 `_EXIT_EDGE`**(⛔ 不寫死第二份)
 *   ⑥ 🚨 一定要含「App 現行的 5 日線」那條(⛔ 少了它 = 推播叫你走、總覽沒提)
 *   ⑦ 有庫存要給成本/報酬率/損益元(使用者鐵則:% 要配元)
 *   ⑧ 原本的三個頁籤與明細卡是**收起不是刪除**(DOM 仍在,可展開)
 *   ⑨ ⛔ 指數不顯示(它沒有買賣價位可言);⛔ 不用紅綠 emoji 當狀態燈
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`); if (!cond) fails++; };

ok('⓪ 主呼叫點在 `_renderTrendCommand` 之後(要讀它寫好的 _ovTrend/_exitMode)',
   /_renderTrendCommand\(data, ind, last\);[\s\S]{0,320}?this\._renderOvCommand\(data\)/.test(SRC));
ok('⓪b 保險呼叫點:切回總覽也要重畫一次(⛔ 只接一處 = 有時有有時沒有)',
   /tab === 'strategy'[\s\S]{0,120}?_renderOvCommand/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const out = {};
    A.switchAppTab && A.switchAppTab('diag');
    await A.analyze('2330');                       // ⭐ 用真實 data/2330.json(⛔ 不編測資)
    await new Promise(r => setTimeout(r, 2000));
    const el = document.getElementById('ovCommandCenter');
    const draw = () => { A._initOvFold(); A._renderOvCommand(A.activeData); return el.innerText; };
    A.inventory = [];
    out.flat = draw();
    // 8 collapsed-not-deleted: must be measured AFTER draw() (which runs _initOvFold)
    out.moved = !!document.querySelector('#ovMoreWrap #ovTabBar')
             && !!document.querySelector('#ovMoreWrap #strategyMainBox')
             && !!document.querySelector('#ovMoreWrap [data-ovpane="now"]');
    out.dFlat = A._ovDecide(A.activeData, '2330');
    // 有庫存(成本很低 → 續抱)
    A.inventory = [{ symbol: '2330', cost: 900, shares: 2, buyDate: '2026-06-02' }];
    out.hold = draw();
    out.dHold = A._ovDecide(A.activeData, '2330');
    // 成本超高 + 現價已跌破 → 出場
    const px = A.activeData[A.activeData.length - 1].close;
    A.inventory = [{ symbol: '2330', cost: px * 2, shares: 1, buyDate: '2026-06-02' }];
    const bak = A._exitLines;
    A._exitLines = (d, s) => ({ ...bak.call(A, d, s), don: px * 1.5, atr2: px * 1.4, ma5: px * 1.3 });
    out.exit = draw();
    out.dExit = A._ovDecide(A.activeData, '2330');
    A._exitLines = bak;
    // 🩹 V74.6.8 使用者截圖抓到:「反彈到 X → 先出一半」的金額用「1 張」算,
    //    而同一張卡上面三行用「你手上的實際股數」→ 兩種基準。零股族差最多(0.07 張 → 差 14 倍)。
    //    ⭐ 測資刻意用 **0.07 張(70 股)**,一半 = 35 股 → 金額必須落在「35 股」那個量級。
    {
      A.inventory = [{ symbol: '2330', cost: px * 2, shares: 0.07, buyDate: '2026-06-02' }];
      A._exitLines = (d, sy) => ({ ...bak.call(A, d, sy), don: px * 1.5, atr2: px * 1.4, ma5: px * 1.3 });
      A._upsideStash = { pC: px, list: [{ v: px * 1.2, n: '測試壓力' }] };
      const dh = A._ovDecide(A.activeData, '2330');
      const half = ((dh && dh.plan) || []).find(x => /先出一半/.test(x.t));
      out.halfMoney = half ? half.money : null;
      out.halfSub = half ? half.sub : '';
      out.half35 = A._netPL(px * 2, px * 1.2, 35);       // 手算對照(⛔ 不讓斷言去猜)
      out.half1000 = A._netPL(px * 2, px * 1.2, 1000);
      A._exitLines = bak; A._upsideStash = null;
    }
    // ③ 黑名單過濾:塞一條「低檔布局」的負面 bullet 與一個「補漲」看多訊號
    A.inventory = [];
    A._ecCache = { sym: '2330', at: Date.now(), r: {
        score: 70, verdict: '測試', bullets: [{ good: false, txt: '低檔布局(便宜就買)' }, { good: false, txt: '跌破月線' }],
        proven: [{ tone: 'bull', title: '補漲候選', _e: { exp: 5 } }, { tone: 'bull', title: '底部頸線突破', _e: { exp: 1.2 } }] } };
    out.blk = draw();
    out.blocked = ['低檔布局', '撿便宜', '補漲', '布林壓縮'].map(t => A._ovBlocked(t));
    out.notBlocked = ['底部頸線突破', '晨星轉折', '爆量長紅'].map(t => A._ovBlocked(t));
    // ③c 🚨 決定性的一條:空手 + 符合 🧬,但唯一的看多訊號在**黑名單**(補漲)→ ⛔ 不可判成「符合加碼」
    //    (⛔ 只驗畫面上有沒有那幾個字是不夠的 —— 那條路徑根本不會被走到,注入驗證抓到的)
    const _sd = A._scrData, _sv = A._scrV;
    A._scrData = { rows: { '2330': {} } };
    A._scrV = (row, k) => (k === 'pos252' ? 90 : k === 'amp20' ? 6 : null);
    A.inventory = [];
    A._ecCache = { sym: '2330', at: Date.now(), r: { score: 70, verdict: 'x', bullets: [],
        proven: [{ tone: 'bull', title: '補漲候選', _e: { exp: 5 } }] } };
    out.dOnlyBlocked = A._ovDecide(A.activeData, '2330');
    A._ecCache = { sym: '2330', at: Date.now(), r: { score: 70, verdict: 'x', bullets: [],
        proven: [{ tone: 'bull', title: '爆量長紅', _e: { exp: -1 } }] } };
    out.dNegExp = A._ovDecide(A.activeData, '2330');          // 期望值為負 → 也不可以判成加碼
    A._ecCache = { sym: '2330', at: Date.now(), r: { score: 70, verdict: 'x', bullets: [],
        proven: [{ tone: 'bull', title: '爆量長紅', _e: { exp: 1.5 } }] } };
    out.dAdd = A._ovDecide(A.activeData, '2330');             // 白名單 → 才可以
    A._scrData = _sd; A._scrV = _sv;
    // ④ 找不到 → 預設文字(空手 + 不符 🧬)
    A._ecCache = { sym: '2330', at: Date.now(), r: { score: 40, verdict: 'x', bullets: [], proven: [] } };
    out.none = draw();
    // ⑨ 指數不顯示
    A.currentSymbolId = '^TWII';
    A._renderOvCommand(A.activeData);
    out.idxEmpty = el.innerText.trim() === '' && el.classList.contains('hidden');
    A.currentSymbolId = '2330';
    out.html = draw() && el.innerHTML;
    return out;
});

const has = (t, s) => String(t).includes(s);
ok('① 四個 Block 齊全且順序正確(A 徽章 → B 預警 → C 計畫 → D 判讀)', (() => {
    const t = R.hold, a = t.indexOf('🛡️'), b = t.indexOf('⚠️ 要注意的事'), c = t.indexOf('📍 現在該做什麼'), d = t.indexOf('🧠 系統怎麼判的');
    return a >= 0 && b > a && c > b && d > c;
})(), R.hold.slice(0, 120));
ok('② 徽章:有庫存沒破線 → 🛡️ 持股續抱', R.dHold && R.dHold.state === 'hold' && has(R.hold, '🛡️ 持股續抱'), R.dHold && R.dHold.badge);
ok('②b 徽章:跌破實測有效出場線 → 🚨 強烈建議出場', R.dExit && R.dExit.state === 'exit' && has(R.exit, '🚨 強烈建議出場'), R.dExit && R.dExit.badge);
ok('②c 徽章:空手且不符條件 → ➖ 觀望(⛔ 不可硬給一個進場理由)', has(R.none, '➖ 觀望'), R.none.slice(0, 80));
// 卡片底部那句免責本身就含「低檔布局/補漲」(本專案第 11 次踩「正確的句子含有被禁的字」)
//   -> 掃之前先把那一行剝掉,否則這條永遠紅。
const _blkBody = String(R.blk).replace(/\u{1F512}[^\n]*/gu, '');
ok('③ 🚨 黑名單靜默過濾(低檔布局/補漲/撿便宜/布林壓縮 都要被擋)',
   R.blocked.every(Boolean) && !has(_blkBody, '低檔布局') && !has(_blkBody, '補漲'), _blkBody.slice(0, 220));
ok('③b ⛔ 白名單訊號不可被誤擋(底部頸線突破/晨星轉折/爆量長紅)',
   R.notBlocked.every(v => v === false), JSON.stringify(R.notBlocked));
ok('③c 🚨🚨 符合 🧬 但訊號在黑名單 → ⛔ 不可判成加碼;期望值為負也不行;白名單才可以',
   R.dOnlyBlocked && R.dOnlyBlocked.state !== 'add'
   && R.dNegExp && R.dNegExp.state !== 'add'
   && R.dAdd && R.dAdd.state === 'add',
   `黑名單=${R.dOnlyBlocked && R.dOnlyBlocked.state} 負期望=${R.dNegExp && R.dNegExp.state} 白名單=${R.dAdd && R.dAdd.state}`);
ok('④ 🚨 沒有實測有效訊號 → 指定的預設文字,⛔ 不給點位',
   has(R.none, '無明確實測有效之進出場訊號') && has(R.none, '依原定紀律操作或觀望'), R.none.slice(-200));
ok('⑤ 出場數字讀 `_EXIT_EDGE`(卡上要出現 590 / 531 / 193 萬)',
   has(R.hold, '590 萬') && has(R.hold, '531 萬') && has(R.hold, '193 萬'), R.hold.slice(-300));
ok('⑥ 🚨 行動計畫第一條必須是「你設定的那一條」,而且要說出它就是出場提醒/自動下單用的',
   R.dHold && R.dHold.plan.length > 0 && /你設定的出場規則/.test(R.dHold.plan[0].sub || '')
   && has(R.hold, '出場提醒與自動下單也用這一條'), (R.dHold && R.dHold.plan[0] && R.dHold.plan[0].sub || '').slice(0, 120));
ok('⑦ 有庫存要給成本 + 報酬率 + 損益金額(% 要配元)',
   has(R.hold, '你的成本') && has(R.hold, '報酬率') && /\+[\d,]+/.test(R.hold) && has(R.hold, '損益'));
ok('⑦b 空手時誠實說「你目前空手」(⛔ 不留空白)', has(R.flat, '空手'));
ok('⑧ 原本三個頁籤與明細卡是**收起不是刪除**(DOM 仍在 #ovMoreWrap 裡)', R.moved);
ok('⑨ 指數不顯示這一區(它沒有買賣價位可言)', R.idxEmpty);
// 🩹 V74.6.8 零股族的「先出一半」(使用者截圖:上面三行用 70 股算、這一行用 1 張算,差 14 倍)
ok('🩹⑩ 「先出一半」的金額用**實際股數的一半**(⛔ 不是寫死 1 張)',
   R.halfMoney != null && Math.abs(R.halfMoney - R.half35) < 1 && Math.abs(R.halfMoney - R.half1000) > 100,
   `half=${R.halfMoney} ・35股=${R.half35} ・1000股=${R.half1000}`);
ok('🩹⑩b 金額改了,標籤要跟著寫出是幾股(⛔ 不可讓人以為是一張)',
   /35/.test(R.halfSub) && /股/.test(R.halfSub), R.halfSub);
ok('⑨b ⛔ 不可用紅綠 emoji 當狀態燈(燈號鐵則)', !/[🔴🟢]/u.test(R.html), (R.html.match(/[🔴🟢]/gu) || []).join(''));

await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ OVCOMMAND_PASS(全部通過)');
process.exit(fails ? 1 : 0);
