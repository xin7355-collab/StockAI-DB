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
const HTML = process.env.OV_FILE || path.join(ROOT, 'index.html');   // 注入驗證用
const SRC = fs.readFileSync(HTML, 'utf8');
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
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const out = {};
    A.switchAppTab && A.switchAppTab('diag');
    await A.analyze('2330');                       // ⭐ 用真實 data/2330.json(⛔ 不編測資)
    await new Promise(r => setTimeout(r, 2000));
    const el = document.getElementById('ovCommandCenter');
    // 🧭 V77.5.0 V76.0.7 起「要注意的事 / 現在該做什麼 / 系統怎麼判的」搬進摺疊區 `#ovWhyBox`
    //   (第一眼只留結論 + 價格尺 + 盯價鈕)→ 這支測試以前只讀 `#ovCommandCenter`,
    //   於是 13 條從 V76.0.7 起一直紅、另有 3 條「⛔ 不可出現」的斷言變成**永遠會過的假綠燈**。
    //   ⭐ 兩塊分開回傳:`cc` = 第一眼、`why` = 摺疊區(⚠️ 用 innerHTML 剝標籤 —— 關著的
    //   <details> 在這個 Chromium 的 innerText 讀不到,見下方 V74.2.2 那條註解)。
    const wbox = () => document.getElementById('ovWhyBox');
    const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
    const draw = () => {
        A._initOvFold(); A._renderOvCommand(A.activeData);
        const w = wbox();
        return { cc: el.innerText, why: strip(w && w.innerHTML), whyHtml: w ? w.innerHTML : '',
                 inFold: !!(w && w.closest('#ovMoreWrap')) };
    };
    A.inventory = [];
    // ⏳ V77.5.1 買進日一律用「最後一根往前 5 根」—— 寫死 '2026-06-02' 會隨時間抱滿 20 天,
    //   那時 state 會(正確地)變成「抱滿 20 天・今天尾盤賣」,而這幾個情境要測的是續抱/減碼。
    const _ad = A.activeData; const BUY = String(_ad[_ad.length - 6].date).replace(/\//g, '-').slice(0, 10);
    out.flat = draw();
    // ⛔ V74.8.8 黑名單透明化:塞一個「實測沒用」的訊號進去,看它會不會被說出來
    {
        const realEc = A._entryCheckup, realCache = A._ecCache;
        A._ecCache = null;
        A._entryCheckup = () => ({
            verdict: '測試', score: 50,
            proven: [{ tone: 'bull', title: '低檔布局(測試用)', _e: { exp: 1.5 } },
                     { tone: 'bull', title: '補漲候選(測試用)', _e: { exp: 1.2 } }],
            bullets: [],
        });
        // ⚠️ 理由收在 <details> 裡,而**收起的 details 的 innerText 只給 summary**
        //   (V74.2.2 踩過)→ 這裡要讀 innerHTML 剝標籤,⛔ 不可用 innerText
        out.blkShown = draw();
        A._entryCheckup = realEc; A._ecCache = realCache;
    }
    // 🚧 對照:沒有任何被擋的東西時,⛔ 不可硬跳出「有 N 個被擋掉」
    {
        const realEc = A._entryCheckup, realCache = A._ecCache;
        A._ecCache = null;
        A._entryCheckup = () => ({ verdict: '測試', score: 50, proven: [], bullets: [] });
        // ⚠️ 同上:⛔ 不可用 innerText(收起的 details 在這個 Chromium 回空)
        //   → 注入「沒東西也硬跳出來」時 innerText 看不到 summary = 假綠燈(實測踩到)
        out.noBlock = draw();
        A._entryCheckup = realEc; A._ecCache = realCache;
    }
    // 8 collapsed-not-deleted: must be measured AFTER draw() (which runs _initOvFold)
    // 🧹 V77.5.2 舊劇本改搬進永遠不顯示的 #ovLegacyHold(⛔ 不在摺疊區;照算不顯示)
    out.moved = !!document.querySelector('#ovLegacyHold #ovTabBar')
             && !!document.querySelector('#ovLegacyHold #strategyMainBox')
             && !!document.querySelector('#ovLegacyHold [data-ovpane="now"]')
             && !document.querySelector('#ovMoreWrap #ovTabBar');
    out.dFlat = A._ovDecide(A.activeData, '2330');
    // 有庫存(成本很低 → 續抱)
    A.inventory = [{ symbol: '2330', cost: 900, shares: 2, buyDate: BUY }];
    out.hold = draw();
    out.dHold = A._ovDecide(A.activeData, '2330');
    // ⏳ V77.5.1 抱滿 20 個交易日 → 必須是出場(⛔ 不可再寫「持股續抱 ・還剩 0 個交易日」)
    // 🔁 V77.6.5 最長天數跟著出場規則走(預設 40)→ 買進日一律用「上限 + 10 根前」,⛔ 不寫死 30
    {   const OLD = String(_ad[_ad.length - (A._EXIT_DIST.maxd + 10)].date).replace(/\//g, '-').slice(0, 10);
        A.inventory = [{ symbol: '2330', cost: 900, shares: 2, buyDate: OLD }];
        out.due = draw(); out.dDue = A._ovDecide(A.activeData, '2330'); out.dueN = A._EXIT_DIST.maxd;
        // 🔬 決定性對照:把上限改成 60 天 → 同一筆庫存要回到「持股續抱」
        const D0 = A._EXIT_DIST.maxd; A._EXIT_DIST.maxd = 60; out.dDue60 = A._ovDecide(A.activeData, '2330'); A._EXIT_DIST.maxd = D0;
        A.inventory = [{ symbol: '2330', cost: 900, shares: 2, buyDate: BUY }]; }
    // ⑤ 期望字串**從 `_EXIT_EDGE` 組**(⛔ 不寫死 590/531/193 —— V77.4.9 起那組數字會隨重跑移動)
    {
        const E = A._EXIT_EDGE, uk = A._exitRuleKey();
        const cur = E.rows.find(r => r.k === uk) || E.base;
        out.edgeWant = [cur.p.toFixed(0) + ' 萬', E.base.p.toFixed(0) + ' 萬'];
        // 🔬 決定性對照:改表 → 卡片一定要跟著變(寫死的話這條會紅)
        const bakP = cur.p; cur.p = 987.6;
        out.holdPatched = draw();
        cur.p = bakP;
    }
    // 成本超高 + 現價已跌破 → 出場
    const px = A.activeData[A.activeData.length - 1].close;
    A.inventory = [{ symbol: '2330', cost: px * 2, shares: 1, buyDate: BUY }];
    const bak = A._exitLines;
    A._exitLines = (d, s) => ({ ...bak.call(A, d, s), don40: px * 1.55, don: px * 1.5, atr2: px * 1.4, ma5: px * 1.3 });
    out.exit = draw();
    out.dExit = A._ovDecide(A.activeData, '2330');
    A._exitLines = bak;
    // 🩹 V74.6.8 使用者截圖抓到:「反彈到 X → 先出一半」的金額用「1 張」算,
    //    而同一張卡上面三行用「你手上的實際股數」→ 兩種基準。零股族差最多(0.07 張 → 差 14 倍)。
    //    ⭐ 測資刻意用 **0.07 張(70 股)**,一半 = 35 股 → 金額必須落在「35 股」那個量級。
    {
      A.inventory = [{ symbol: '2330', cost: px * 2, shares: 0.07, buyDate: BUY }];
      A._exitLines = (d, sy) => ({ ...bak.call(A, d, sy), don: px * 1.5, atr2: px * 1.4, ma5: px * 1.3 });
      A._upsideStash = { pC: px, list: [{ v: px * 1.2, n: '測試壓力' }] };
      const dh = A._ovDecide(A.activeData, '2330');
      const half = ((dh && dh.plan) || []).find(x => /先出一半/.test(x.t));
      out.planTxt = ((dh && dh.plan) || []).map(x => x.t).join(' | ');
      out.halfMoney = half ? half.money : null;
      out.halfSub = half ? half.sub : '';
      out.half35 = A._netPL(px * 2, px * 1.2, 35);       // 手算對照(⛔ 不讓斷言去猜)
      out.half1000 = A._netPL(px * 2, px * 1.2, 1000);
    }
    // ═══ 🎯 V74.6.9 空手時給「這一檔自己的觸發價」 ═══
    //   ⭐ 觸發價本來就在 `playbook_edge.json`,⛔ 只是個股頁從來沒顯示 → 使用者以為「這檔沒買點」。
    {
      A.inventory = [];
      const trBak = A._ovTrend;
      A._ovTrend = { sym: '2330', trend: 'bull' };
      A._ecCache = { sym: '2330', at: Date.now(), r: { score: 40, verdict: 'x', bullets: [], proven: [] } };
      // ① 清單裡有這一檔 → 徽章、觸發價、停損、尾盤時窗都要出現
      A._pbEdge = { picks: [{ s: '2330', k: '🕯️ 站上長黑K壓力', w: 62.5, exp: 3.04, lb: 1.12, n: 24,
                              trig: 232.5, stop: 220.88, loose: 0, hq: 1 }] };
      out.pbHit = draw();
      // ② 空頭 → ⛔ 不可給進場價(講反話鐵則)
      A._ovTrend = { sym: '2330', trend: 'bear' };
      out.pbBear = draw();
      A._ovTrend = { sym: '2330', trend: 'bull' };
      // ③ 不靠價位的招(loose)→ ⛔ 不可硬給一個價
      A._pbEdge = { picks: [{ s: '2330', k: '🔧 盤中重算型', w: 55, exp: 2, lb: 0.5, n: 30, trig: 0, loose: 1 }] };
      out.pbLoose = draw();
      // ④ 不在清單裡 → 誠實說「大部分股票沒有值得做的招」(⛔ 不憑空生一個買點)
      A._pbEdge = { picks: [] };
      out.pbNone = draw();
      A._pbEdge = undefined; A._ovTrend = trBak;
    }
    // ⚙️ V74.6.9 減碼時要講明「你設定的那條還沒破」(使用者:國巨破了另外兩條、他設的 ATR 沒破)
    {
      const px2 = A.activeData[A.activeData.length - 1].close;
      A.inventory = [{ symbol: '2330', cost: px2 * 0.99, shares: 1, buyDate: BUY }];
      A._ovTrend = { sym: '2330', trend: 'bear' };          // 空頭 → reduce
      // ⚠️ 測資要**跟著使用者設定的那一條走**(⛔ 不可寫死某一條 —— V75.0.9 預設從 atr2 換成 don
      //    的時候,寫死的版本會讓這條變成假失敗)。情境:他設定的那條**還沒破**、另外三條破了。
      const _uk = A._exitRuleKey();
      A._exitLines = (d, sy) => { const o = { ...bak.call(A, d, sy) };
          for (const k of ['atr2', 'don', 'ma5', 'trail8']) o[k] = px2 * (k === _uk ? 0.9 : 1.05);
          return o; };
      out.reduceWhy = (A._ovDecide(A.activeData, '2330') || {}).why || '';
      A._exitLines = bak; A._ovTrend = null; A.inventory = [];
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
    // ③ 🚨 V77.5.0:黑名單與白名單**同時**出現、而且這一檔符合 🧬 → 一定會產生行動計畫,
    //   才驗得到「計畫裡⛔ 不可有黑名單項目」(舊版的情境根本不產生計畫 = 那條永遠會過)
    A._ecCache = { sym: '2330', at: Date.now(), r: { score: 70, verdict: 'x',
        bullets: [{ good: false, txt: '低檔布局(便宜就買)' }],
        proven: [{ tone: 'bull', title: '補漲候選', _e: { exp: 5 } }, { tone: 'bull', title: '底部頸線突破', _e: { exp: 1.2 } }] } };
    out.blkPlan = draw();
    out.dBlkPlan = A._ovDecide(A.activeData, '2330');
    A._scrData = _sd; A._scrV = _sv;
    // ④ 找不到 → 預設文字(空手 + 不符 🧬)
    A._ecCache = { sym: '2330', at: Date.now(), r: { score: 40, verdict: 'x', bullets: [], proven: [] } };
    out.none = draw();
    // ⑨ 指數不顯示
    A.currentSymbolId = '^TWII';
    A._renderOvCommand(A.activeData);
    out.idxEmpty = el.innerText.trim() === '' && el.classList.contains('hidden');
    A.currentSymbolId = '2330';
    { const r = draw(); out.html = el.innerHTML + r.whyHtml; }
    out.rarity = strip(A._ovRarityNote ? A._ovRarityNote() : '').replace(/\s+/g, ' ').trim();
    return out;
});

const has = (t, s) => String(t).includes(s);
const N = t => String(t || '').replace(/\s+/g, ' ');
const A_ = x => (x ? x.cc + '\n' + x.why : '');          // 第一眼 + 摺疊區(整張卡)
ok('①0 空過守門:摺疊區真的有東西、而且真的在 #ovMoreWrap 裡(⛔ 讀到空的就沒有鑑別力)',
   R.hold.why.length > 80 && R.hold.inFold, `why=${R.hold.why.length} inFold=${R.hold.inFold}`);
ok('① 第一眼 = 徽章;B 預警 → C 計畫 → D 判讀 三段在摺疊區而且順序正確(V76.0.7)', (() => {
    const w = R.hold.why, b = w.indexOf('要注意的事'), c = w.indexOf('現在該做什麼'), d = w.indexOf('系統怎麼判的');
    return has(R.hold.cc, '🛡️') && !/要注意的事|現在該做什麼|系統怎麼判的/.test(R.hold.cc) && b >= 0 && c > b && d > c;
})(), `cc=${N(R.hold.cc).slice(0, 80)} | why=${N(R.hold.why).slice(0, 120)}`);
ok('② 徽章:有庫存沒破線 → 🛡️ 持股續抱', R.dHold && R.dHold.state === 'hold' && has(R.hold.cc, '🛡️ 持股續抱'), R.dHold && R.dHold.badge);
ok('②b 徽章:跌破實測有效出場線 → 🚨 強烈建議出場', R.dExit && R.dExit.state === 'exit' && has(R.exit.cc, '🚨 強烈建議出場'), R.dExit && R.dExit.badge);
// 🔁 V77.6.5 天數跟著出場規則走 → 徽章要寫**那個上限**(⛔ 不寫死 20)
ok('②d ⏳ 抱滿最長天數 → state=exit、徽章講「抱滿 N 天・今天尾盤賣」(N = 規則的上限;V77.5.1 使用者截圖 2327)',
   R.dDue && R.dDue.state === 'exit' && /抱滿 \d+ 天/.test(R.due.cc) && has(R.due.cc, '尾盤') && R.dueN && has(R.due.cc, `抱滿 ${R.dueN} 天`), R.dDue && R.dDue.badge);
ok('②e ⛔ 抱滿之後第一眼不可再出現「持股續抱」或「還剩 0 個交易日」', !has(R.due.cc, '持股續抱') && !/還剩 0 個交易日/.test(R.due.cc + R.due.why));
ok('②f 🔬 決定性對照:上限改 60 天 → 同一筆庫存回到 🛡️ 持股續抱', R.dDue60 && R.dDue60.state === 'hold', R.dDue60 && R.dDue60.state);
ok('②g 抱滿時行動計畫第一條就是「今天尾盤賣」', R.dDue && R.dDue.plan[0] && /尾盤賣/.test(R.dDue.plan[0].t || ''), R.dDue && R.dDue.plan[0] && R.dDue.plan[0].t);
ok('②c 徽章:空手且不符條件 → ➖ 觀望(⛔ 不可硬給一個進場理由)', has(R.none.cc, '➖ 觀望'), N(R.none.cc).slice(0, 80));
// 卡片底部那句免責本身就含「低檔布局/補漲」(本專案第 11 次踩「正確的句子含有被禁的字」)
//   → 只驗**行動計畫那幾行**(📍 開頭的 li);「有沒有被擋掉」交給 _ovBlocked 的回傳值(R.blocked)驗。
// 🚨 V77.5.0:計畫早就搬進摺疊區 → 以前掃第一眼的版本**永遠抓不到東西 = 假綠燈**
const _planLis = (R.blkPlan.whyHtml.match(/<li[^>]*>[\s\S]*?<\/li>/g) || []).map(x => x.replace(/<[^>]+>/g, ' ')).filter(x => /📍/.test(x));
ok('③0 空過守門:摺疊區裡真的有 📍 計畫行(⛔ 0 行 = 下面那條永遠會過)', _planLis.length > 0, `n=${_planLis.length}`);
ok('③ 🚨 黑名單項目⛔ 不可進行動計畫(低檔布局/補漲/撿便宜/布林壓縮 都要被擋)',
   R.blocked.every(Boolean) && !_planLis.some(x => /低檔布局|補漲/.test(x))
   && !((R.dBlkPlan && R.dBlkPlan.plan) || []).some(p => /低檔布局|補漲/.test((p.t || '') + (p.sub || ''))),
   _planLis.join(' | ').slice(0, 220));
ok('③b ⛔ 白名單訊號不可被誤擋(底部頸線突破/晨星轉折/爆量長紅)',
   R.notBlocked.every(v => v === false), JSON.stringify(R.notBlocked));
ok('③c 🚨🚨 符合 🧬 但訊號在黑名單 → ⛔ 不可判成加碼;期望值為負也不行;白名單才可以',
   R.dOnlyBlocked && R.dOnlyBlocked.state !== 'add'
   && R.dNegExp && R.dNegExp.state !== 'add'
   && R.dAdd && R.dAdd.state === 'add',
   `黑名單=${R.dOnlyBlocked && R.dOnlyBlocked.state} 負期望=${R.dNegExp && R.dNegExp.state} 白名單=${R.dAdd && R.dAdd.state}`);
ok('④ 🚨 沒有實測有效訊號 → 指定的預設文字(摺疊區),第一眼 ➖ 觀望,⛔ 不給點位',
   has(R.none.why, '無明確實測有效之進出場訊號') && has(R.none.why, '依原定紀律操作或觀望')
   && has(R.none.cc, '➖ 觀望') && !/以上才算數|→ 全部出場/.test(R.none.why), N(R.none.why).slice(-200));
ok('⑤ 出場數字讀 `_EXIT_EDGE`(期望字串由表組出來,⛔ 不寫死)',
   R.edgeWant.every(w => has(N(R.hold.why), w)), `want=${R.edgeWant} why=${N(R.hold.why).slice(0, 200)}`);
ok('⑤b 🔬 決定性對照:把你設定那條的成績改成 987.6 → 卡片必須跟著變成 988 萬',
   has(N(R.holdPatched.why), '988 萬') && !has(N(R.hold.why), '988 萬'), N(R.holdPatched.why).slice(0, 200));
ok('⑥ 🚨 行動計畫第一條必須是「你設定的那一條」,而且要說出它就是出場提醒/自動下單用的',
   R.dHold && R.dHold.plan.length > 0 && /你設定的出場規則/.test(R.dHold.plan[0].sub || '')
   && has(R.hold.why, '出場提醒與自動下單也用這一條')
   && R.hold.why.indexOf('你設定的出場規則') >= 0
   && (R.hold.why.indexOf('參考 ・') < 0 || R.hold.why.indexOf('你設定的出場規則') < R.hold.why.indexOf('參考 ・')),
   (R.dHold && R.dHold.plan[0] && R.dHold.plan[0].sub || '').slice(0, 120));
ok('⑥b 🚨 跌破你設定的那條 → 警示必須留在**第一眼**(⛔ 不可被收進摺疊 —— V76.0.7 的條件觸發例外)',
   /你設定的出場規則|出場提醒與自動下單也用這一條/.test(R.exit.cc), N(R.exit.cc).slice(0, 200));
ok('⑦ 有庫存要給成本 + 報酬率 + 損益金額(% 要配元)',
   has(A_(R.hold), '你的成本') && has(A_(R.hold), '報酬率') && /\+[\d,]+/.test(A_(R.hold)) && has(A_(R.hold), '損益'));
ok('⑦b 空手時誠實說「你目前空手」(⛔ 不留空白)', has(A_(R.flat), '空手'));
ok('⑧ 原本三個頁籤與明細卡**照算不顯示**(DOM 在 #ovLegacyHold 裡,⛔ 不在摺疊區)', R.moved);
ok('⑨ 指數不顯示這一區(它沒有買賣價位可言)', R.idxEmpty);
// 🗑️ V77.5.2 「反彈到第一道壓力 → 先出一半」已拿掉(回測沒有分批出場;V74.4.8 提早出場會洗掉贏家)
//   → 🩹⑩ 改釘「⛔ 不可復活」;金額用實際股數那條規則仍由 `_netPL` 的其他呼叫端守(test_exitdist)。
ok('🩹⑩ ⛔ 持有時的行動計畫不可再有「先出一半」', R.halfMoney == null && !/先出一半/.test(R.planTxt || ''), R.planTxt);
ok('🩹⑩b 持有時的行動計畫要有三條出場(你設定的線 / 抱滿 / 硬停損)',
   /唐奇安|日最低|ATR|回落|日線/.test(R.planTxt || '') && /硬停損/.test(R.planTxt || ''), R.planTxt);
// ═══ 🎯 V74.6.9 空手時給這一檔自己的觸發價(使用者:「都只看到觀望,應該新增購買價格」)═══
ok('🎯⑪ 清單裡有這一檔 → 第一眼徽章「等它漲過去」+ 觸發價;摺疊區有觸發價 + 停損 + 尾盤時窗',
   has(R.pbHit.cc, '等它漲過去') && has(R.pbHit.cc, '232.50')
   && has(R.pbHit.why, '232.50') && has(R.pbHit.why, '220.88') && has(R.pbHit.why, '13:00~13:28'),
   `cc=${N(R.pbHit.cc).slice(0, 120)} | why=${N(R.pbHit.why).slice(0, 160)}`);
// 🚨 這條最重要:使用者說「掛到就代表買點到」—— ⛔ 掛在下面等實測是最糟的做法
ok('🎯⑪b 🚨 必須寫「漲過去才算數,⛔ 不是掛在下面等」+ 那組實測數字',
   has(N(R.pbHit.why), '不是掛在下面等') && has(N(R.pbHit.why), '12.4 萬') && has(N(R.pbHit.why), '46.1'),
   (N(R.pbHit.why).match(/🚨.{0,120}/) || [''])[0]);
ok('🎯⑪c 招的成績要配次數(勝率 62% ・24 次 ・每趟 +3.04%)',
   has(N(R.pbHit.why), '24 次') && has(R.pbHit.why, '3.04'), (N(R.pbHit.why).match(/最會賺的招.{0,90}/) || [''])[0]);
ok('🎯⑪d ⛔ 空頭時不給進場價(講反話鐵則)—— 第一眼**與摺疊區**都不可以',
   !has(A_(R.pbBear), '232.50') && !has(R.pbBear.cc, '等它漲過去'), N(A_(R.pbBear)).slice(0, 160));
ok('🎯⑪e 不靠價位的招(loose)⛔ 不可硬給一個價',
   has(N(R.pbLoose.why), '不是靠固定價位') && !has(A_(R.pbLoose), '232.50'), N(R.pbLoose.why).slice(0, 200));
// 🎯⑪f V77.0.9 起那句話改讀 `_ovRarityNote()`(今天的採礦數字)→ 期望值從它來,⛔ 不寫死
ok('🎯⑪f0 空過守門:`_ovRarityNote()` 拿得到東西(⛔ 空的話下面那條沒有鑑別力 → 先跑 bash scripts/fetch_testdata.sh)',
   R.rarity.length > 10, `rarity="${R.rarity}"`);
ok('🎯⑪f 不在清單裡 → 第一眼講「今天全市場實際有幾檔」+ ➖ 觀望(⛔ 不憑空生一個買點)',
   has(N(R.pbNone.cc), R.rarity.slice(0, 18)) && has(R.pbNone.cc, '➖ 觀望')
   && !/等它漲過去|以上才算數/.test(A_(R.pbNone)), N(R.pbNone.cc).slice(0, 220));
ok('🎯⑪f2 ⛔ 寫死的「全市場 2,326 檔…是常態」不可復活(V77.0.9:安慰句不是答案)',
   !/2,326 檔裡|是常態/.test(A_(R.pbNone)), '');
// ⚙️ V74.6.9 使用者問「破了 ATR 線是不是還是要離場」→ 查證後他看錯了(破的是另外兩條)
// 🚪 V77.5.2 空頭持股改講「⛔ 別加碼、照三條出場走」(回測沒有「空頭就先減碼」這一步)
ok('⚙️⑫ 空頭持股要主動講明「你設定的那條還沒破」+ 照出場規則走(⛔ 不叫你提早減碼)',
   /你設定的那條/.test(R.reduceWhy) && /還沒破/.test(R.reduceWhy) && /三條出場規則/.test(R.reduceWhy) && !/先出一部分/.test(R.reduceWhy),
   R.reduceWhy.replace(/<[^>]+>/g, '').slice(0, 200));
ok('⑨b ⛔ 不可用紅綠 emoji 當狀態燈(燈號鐵則)—— 第一眼**與摺疊區**都掃', !/[🔴🟢]/u.test(R.html), (R.html.match(/[🔴🟢]/gu) || []).join(''));

// ⛔ V74.8.8 黑名單透明化(附件建議 + 本專案陷阱 #22:守門擋掉東西一定要寫原因)
// ⚠️ 剝完標籤會留下多餘空白(<b>2</b> → " 2 ")→ 斷言前先正規化,⛔ 別去猜實際輸出長什麼樣
const _blkTxt = N(R.blkShown.why);
ok('⛔⑬ 被擋掉的訊號要**說出來**,而且要講幾個(⛔ 不可靜默過濾)',
   /今天有 2 個訊號被擋掉/.test(_blkTxt), _blkTxt.slice(0, 200));
ok('⛔⑬a 要說出**是哪幾個**(低檔布局 / 補漲)',
   /低檔布局/.test(_blkTxt) && /補漲/.test(_blkTxt));
ok('⛔⑬b 每一條都要有**實測數字**(⛔ 不可只寫「實測沒用」)',
   /−0\.58pp|-0\.58pp/.test(_blkTxt) && /逐年全負/.test(_blkTxt));
ok('⛔⑬c 要說明「擋掉不是說它沒發生」(⛔ 否則使用者以為今天沒訊號)',
   /不是.{0,4}說它今天沒發生|並不會賺/.test(_blkTxt), _blkTxt.slice(-260));
ok('⛔⑬d 沒東西被擋時 ⛔ 不可硬跳出「有 N 個被擋掉」(⛔ 天天道歉會讓人習慣忽略)',
   !/訊號被擋掉/.test(A_(R.noBlock)) && /只採用/.test(R.noBlock.why), N(R.noBlock.why).slice(0, 160));
ok('⛔⑬e 被擋掉的說明與「只採用」那句都收在摺疊區(V76.0.7:第一眼 ≤600 字)',
   !/被擋掉/.test(R.blkShown.cc) && !/只採用/.test(R.noBlock.cc), '');

await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ OVCOMMAND_PASS(全部通過)');
process.exit(fails ? 1 : 0);
