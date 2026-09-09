#!/usr/bin/env node
/**
 * 🪟 事件觸發彈窗(V74.8.9)—— 使用者:「有依照這個方式做事件觸發時的彈跳視窗嗎?」
 *
 * 答案原本是「沒有」:觸發時只走系統推播 + 鈴鐺,
 * 🚨 而 `_fireAlert` 在**沒開通知權限時直接 return** → 畫面上零反應。
 *
 * 🪟 V75.0.0 判準曾經改成「**跟你有關**」(① 庫存/自選不論多空都彈)——
 *   🚨 **V75.2.7 收回那一層**(使用者 2026-09-09:「太頻繁還有重疊了」)。
 *   ⭐ 為什麼收回是**量出來的**,⛔ 不是憑感覺:`scripts/popup_audit.mjs` 實測
 *      開 App 14 秒 / 20 檔庫存+自選 → 跳 **14 個大視窗,其中 13 個是買進類**,
 *      佇列最長 13 則 = 要按 **14 次**「知道了」;真正該打斷他的只有 1 則。
 *   現行判準兩層(⛔ 順序不可換,見 `_shouldPopup`):
 *     ① 沒有 `sym`(全市場盤點摘要)→ ⛔ 不彈,走 toast + 鈴鐺
 *     ② **風險/賣出類** → 彈(⛔ 不論是不是你的股票);買進類一律 toast
 *   ⭐ 這是回到 V74.8.9 的**多空不對稱**鐵則:勝率只有 30~33%,
 *      整套會賺完全靠「錯的時候小賠出場」→ 買進錯過還有下一次,出場錯過就住套房。
 *
 * 🪟 V75.2.7 另外三件(每一件都對應使用者講的一個現象):
 *   ・「關掉一個又馬上跳一個」→ 排隊改**合併**:同一批進同一個視窗,其餘則列成一行一則,
 *     按一次整批關掉。⛔ 一則都不遺失(測試 ⑩b2 數列出幾則)。
 *   ・「手機通知和 App 視窗講同一件事」→ **前景一律不發系統通知**(不只大視窗那條);背景照發。
 *   ・🚨 兩個會讓提醒**靜默消失**的 bug:① 視窗被更高層的視窗蓋住卻已蓋章
 *     ② 停損的 30 分分桶被「一天一次」吃掉(V72.9.1「出場提醒不限量」名存實亡)。
 *
 * ⛔ 五條不可改掉的設計:
 * ① ⭐ **買進/點火類一律 toast** ——
 *    那不是版面偏好,是本站的**多空不對稱**鐵則(勝率 30~33%,靠小賠出場才會賺)。
 *    ⛔ 每個事件都彈 = 使用者三天後關掉 = 整套失效。
 * ② 同一件事**一天只跳一次**;⭐ **但風險/出場類跟著 30 分鐘分桶**
 *    (V72.9.1:出場提醒⛔ 不限量 —— 少提醒一次的代價遠大於多提醒一次)。
 * ③ 沒被彈窗攔下的**一定要有 toast**(⛔ 不可靜默 —— 那正是原本的 bug)。
 * ④ ⛔ 不用紅綠燈(講風險不是漲跌方向,V74.8.8 的鐵則)。
 * ⑤ 要附**實測數字**說明為什麼值得打斷(⭐ 那是本站相對別家的優勢)。
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + e : ''}`); } };

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app._fireAlert, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const out = {};
    const m = () => document.getElementById('alertPopModal');
    const shown = () => !m().classList.contains('hidden');
    const clear = () => { try { Object.keys(localStorage).filter(k => k.startsWith('popAlert_')).forEach(k => localStorage.removeItem(k)); } catch (_) {} };
    // 攔 toast 看有沒有被呼叫
    let toasts = []; const realToast = A.showToast; A.showToast = (msg) => { toasts.push(String(msg)); };

    clear(); A._closeAlertPop();
    // ① 出場類 → 應該彈窗
    toasts = [];
    A._fireAlert('🩸 庫存鐵血停損', '國巨(2327) 已破成本 -5%', '2327');
    out.exitShown = shown();
    out.exitTitle = document.getElementById('alertPopTitle').textContent;
    out.exitEdge  = document.getElementById('alertPopEdge').textContent;
    out.exitToast = toasts.length;                       // 彈窗時⛔ 不該重複再 toast
    A._closeAlertPop();

    // ② 同一件事再來一次 → ⛔ 不可再彈
    toasts = [];
    A._fireAlert('🩸 庫存鐵血停損', '國巨(2327) 已破成本 -5%', '2327');
    out.dupShown = shown();
    out.dupToast = toasts.length;                        // 沒彈窗就要有 toast
    A._closeAlertPop();

    // ③ 買進類 → ⛔ 不可彈窗,但要有 toast
    clear(); toasts = [];
    A._fireAlert('⚡ 六脈點火(盤中)', '低檔齊發參考買點', '2330');
    out.buyShown = shown();
    out.buyToast = toasts.length;
    A._closeAlertPop();

    // ④ 分級判定
    out.urgent = ['🩸 庫存鐵血停損', '🔻 庫存轉偏空', '⏰ 當沖平倉倒數(13:25)', '🧯 六脈熄火(盤中)', '🚨 官方處置'].map(t => A._isUrgentAlert(t));
    out.calm   = ['⚡ 六脈點火(盤中)', '🎯 買點到了', '📈 A+ 級買點共振', '📅 財報行事曆'].map(t => A._isUrgentAlert(t));

    // ⑤ V75.0.0 沒有 sym(全市場盤點摘要)→ ⛔ 不彈窗,走 toast + 鈴鐺
    //    ⭐ 「你有 5 檔有處置風險」是統計,不是一件要你現在做的事 —— 彈窗要留給「哪一檔、現在」。
    clear(); toasts = [];
    A._fireAlert('📊 處置股盤點摘要', '你還有 3 檔股有處置風險,點🔔看歷史通知', '');
    out.noSymShown = shown();
    out.noSymToast = toasts.length;
    A._closeAlertPop();
    out.closed = !shown();

    // ⑮ V75.2.7 判準**收回 V75.0.0 的第 ① 層**:買進類⛔ 一律不彈(不論是不是你的股票)
    //   使用者 2026-09-09:「太頻繁還有重疊」。實測 popup_audit:開 App 跳 14 個大視窗、
    //   其中 **13 個是買進類** → 要按 14 次「知道了」。⭐ 回到多空不對稱鐵則(V74.8.9)。
    const invBak0 = A.inventory, favBak0 = A.favGroups;
    A.inventory = [{ symbol: '2330', cost: 900, shares: 1 }];
    A.favGroups = { 預設: ['1101'] };
    clear(); toasts = [];
    A._fireAlert('⚡ 六脈點火(盤中)', '台積電(2330) 低檔齊發', '2330');   // 庫存 + 買進類 → ⛔ 不彈
    out.mineInvShown = shown(); out.mineInvToast = toasts.length; A._closeAlertPop();
    clear(); toasts = [];
    A._fireAlert('⚡ 六脈點火(盤中)', '台泥(1101) 低檔齊發', '1101');      // 自選 + 買進類 → ⛔ 不彈
    out.mineFavShown = shown(); A._closeAlertPop();
    clear(); toasts = [];
    A._fireAlert('🩸 庫存鐵血停損', '台積電(2330) 已破成本', '2330');       // 庫存 + 風險類 → 要彈
    out.mineRiskShown = shown(); A._closeAlertPop();
    clear(); toasts = [];
    A._fireAlert('⚡ 六脈點火(盤中)', '別人的(9999) 低檔齊發', '9999');    // 不是你的 + 買進類 → ⛔ 不彈
    out.otherBuyShown = shown(); out.otherBuyToast = toasts.length; A._closeAlertPop();
    clear(); toasts = [];
    A._fireAlert('🩸 庫存鐵血停損', '別人的(9999) 已破成本', '9999');       // 不是你的 + 風險類 → 仍要彈
    out.otherRiskShown = shown(); A._closeAlertPop();
    out.mySymsHas = [A._mySyms().has('2330'), A._mySyms().has('1101'), A._mySyms().has('9999')];
    A.inventory = invBak0; A.favGroups = favBak0;

    // ═══ 🥊 V74.9.2 大視窗為主 + 排隊 + 不重複系統通知 + 連續技 ═══
    // ⑨ 賣訊/風險類(頂背離/停利/出貨…)→ 以前是 toast,現在要走大視窗
    clear(); toasts = [];
    A._fireAlert('⚠️ RSI 頂背離', '南亞(1303) 股價4天前創波段新高,但 RSI 沒跟著創高=上漲動能衰竭;噴出末段賣訊,別追高、有貨分批停利。', '1303');
    out.divShown = shown(); out.divToast = toasts.length;
    A._closeAlertPop();
    out.sellUrgent = ['📉 高檔出貨訊號', '🔺 多頭過熱停利', '📉 無量創高(量價背離)', '🔻 庫存減碼', '🥊 第 2 擊｜跌破 ATR 追蹤停利'].map(t => A._isUrgentAlert(t));
    out.buyCalm2  = ['🔺 晨星轉折', '🎯 主打型態觸發｜台積電', '🔺 底部頸線突破'].map(t => A._isUrgentAlert(t));

    // ⑩ 🪟 V75.2.7 合併:彈窗開著時來第二則 → ⛔ 不可蓋掉第一則,而是**列在同一個視窗裡**,
    //   按一次「知道了」整批關掉(⛔ 不再逐則重跳)
    clear(); toasts = [];
    A._fireAlert('⚠️ RSI 頂背離', '宏致(3605) …', '3605');
    A._fireAlert('📉 高檔出貨訊號', '南亞(1303) …', '1303');
    out.q1Title = document.getElementById('alertPopTitle').textContent;          // 仍是第一則
    out.qHint = document.getElementById('alertPopQueue').textContent;
    out.qHintShown = !document.getElementById('alertPopQueue').classList.contains('hidden');
    out.moreCount = document.querySelectorAll('#alertPopMore button').length;     // 其餘則要列出來
    out.moreTxt = document.getElementById('alertPopMore').textContent;
    out.qToast = toasts.length;                                                   // 併進去的那則⛔ 不可另外 toast
    A._closeAlertPop(); await new Promise(r => setTimeout(r, 400));
    out.q2Title = document.getElementById('alertPopTitle').textContent;
    out.q2Shown = shown();                                                        // ⛔ 應該已經整批關掉
    A._closeAlertPop(); await new Promise(r => setTimeout(r, 300));

    // ⑪ 大視窗跳了 + App 在前景 → ⛔ 不再發系統通知(兩個視窗長得很像);背景時仍要發
    const RealN = window.Notification; let nCalls = 0;
    class FakeN { constructor(t, o) { nCalls++; this.t = t; } close() {} } FakeN.permission = 'granted';
    window.Notification = FakeN;
    clear(); nCalls = 0;
    A._fireAlert('🩸 庫存鐵血停損', '測試(2330)', '2330');                          // 前景 + 彈窗 → 0 次
    out.osWhenPopped = nCalls; A._closeAlertPop();
    clear(); nCalls = 0;
    A._fireAlert('⚡ 六脈點火(盤中)', '低檔齊發', '2330');                           // 前景 + 走 toast → ⛔ 也不發
    out.osWhenToast = nCalls;
    // ⭐ 但背景時一定要發(⛔ 那時畫面上的東西他一個都看不到)——
    //   用 defineProperty 蓋掉 visibilityState(⛔ 直接指派無效,它是 getter)
    const _vd = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    clear(); nCalls = 0;
    A._fireAlert('⚡ 六脈點火(盤中)', '低檔齊發(背景)', '2317');
    out.osWhenHidden = nCalls;
    delete document.visibilityState;
    if (_vd) { try { Object.defineProperty(Document.prototype, 'visibilityState', _vd); } catch (_) {} }
    window.Notification = RealN;

    // ⑫ 連續技:有貨 → 三擊 + 金額 + 「幫我盯第 2 擊」;⛔ 三條誠實限制要在
    const invBak = A.inventory;
    A.inventory = [{ symbol: '2327', cost: 561, shares: 0.07, buyDate: '2026-08-20' }];   // 零股族(0.07 張 = 70 股)
    const k = []; let px = 500; for (let i = 0; i < 80; i++) { px *= 1 + (Math.sin(i / 5) * 0.01); k.push({ date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, open: px, high: px * 1.02, low: px * 0.98, close: px, volume: 1000000 }); }
    k[k.length - 1].close = 590; k[k.length - 1].high = 595; k[k.length - 1].low = 585;
    const rdBak = A.rawDailyData, curBak = A.currentSymbolId;
    A.rawDailyData = k; A.currentSymbolId = '2327';
    clear(); localStorage.removeItem('proTerm_comboWatch');
    // ⑫b 把出場規則改成「唐奇安」→ 第 2 擊必須跟著變(⛔ 注入「寫死 ma5」時這條才抓得到)
    const erBak = A.settings.exitRule; A.settings.exitRule = 'don';
    const L2327 = A._exitLines(k, '2327');
    out.donPx = L2327 ? L2327.don : null; out.ma5Px = L2327 ? L2327.ma5 : null;
    A._fireAlert('⚠️ RSI 頂背離', '國巨(2327) …', '2327');
    await new Promise(r => setTimeout(r, 500));
    const cb = document.getElementById('alertPopCombo');
    out.comboTxt = cb.innerText.replace(/\s+/g, ' ');
    out.armShown = !document.getElementById('alertPopArm').classList.contains('hidden');
    out.plan = A._comboPlanCur ? { held: A._comboPlanCur.held, sh: A._comboPlanCur.sh, half: A._comboPlanCur.halfSh, px: A._comboPlanCur.prim.px, nm: A._comboPlanCur.prim.nm } : null;
    // 按「幫我盯第 2 擊」→ 到價提醒 + comboWatch 都要有
    const paBak = A.priceAlerts; A.priceAlerts = [];
    document.getElementById('alertPopArm').click();
    out.armedPA = (A.priceAlerts || []).filter(a => a.sym === '2327' && a.cond === 'lte').length;
    out.armedWatch = A._comboWatchGet()['2327'] || null;
    A._closeAlertPop();
    // ⑬ 第 2 擊接力:即時價跌破出場線 → 再跳一次大視窗(標題「第 2 擊」);沒跌破 ⛔ 不跳;跳過一次就從清單移除
    clear(); A.currentSymbolId = '2327'; A.rawDailyData = k;
    out.hit0 = A._comboCheck('2327', out.armedWatch ? out.armedWatch.px + 5 : 9999);   // 還沒破
    out.hit0Shown = shown();
    out.hit1 = A._comboCheck('2327', out.armedWatch ? out.armedWatch.px - 1 : 0);      // 破了
    out.hit1Title = document.getElementById('alertPopTitle').textContent;
    out.hit1Shown = shown();
    out.watchAfter = A._comboWatchGet()['2327'] || null;
    A._closeAlertPop();
    // 空手 → 不給「幫我盯」、要說「不是進場點」
    // ⚠️ 頁面自己的 init() 會在幾秒後把 currentSymbolId 切成預設股(2330)—— 測試環境的事,不是 App bug;
    //    但 _comboFill 只在「sym === 當前股」時讀 rawDailyData(否則讀 IndexedDB,沙箱是空的)→ 每一段前都要再釘一次
    A.inventory = []; A.currentSymbolId = '2327'; A.rawDailyData = k; clear(); localStorage.removeItem('proTerm_comboWatch');
    A._fireAlert('⚠️ RSI 頂背離', '國巨(2327) …', '2327');
    await new Promise(r => setTimeout(r, 500));
    out.flatTxt = cb.innerText.replace(/\s+/g, ' ');
    out.flatArm = !document.getElementById('alertPopArm').classList.contains('hidden');
    A._closeAlertPop();
    A.inventory = invBak; A.rawDailyData = rdBak; A.currentSymbolId = curBak; A.priceAlerts = paBak; A.settings.exitRule = erBak;
    localStorage.removeItem('proTerm_comboWatch');

    A.showToast = realToast;
    return out;
});
await browser.close();

ok('① 出場/停損類 → **彈窗**(那是錯過會住套房的事)', R.exitShown && /鐵血停損/.test(R.exitTitle), R.exitTitle);
ok('①b 彈窗要附**實測數字**說明為什麼值得打斷(⛔ 不是只喊快跑)',
   /30~33%/.test(R.exitEdge) && /小賠出場/.test(R.exitEdge), R.exitEdge.slice(0, 90));
ok('①c 已經彈窗就⛔ 不要再 toast 一次(⛔ 同一件事講兩遍)', R.exitToast === 0, `toast=${R.exitToast}`);
ok('② 同一件事一天只跳一次(⛔ 否則門檻上下震盪會連跳)', R.dupShown === false, `dupShown=${R.dupShown}`);
ok('②b 但沒彈窗時⛔ 不可靜默 —— 一定要有 toast', R.dupToast === 1, `toast=${R.dupToast}`);
ok('③ 🚨 買進/點火類 ⛔ 不可彈窗(多空不對稱:錯過還有下一次)', R.buyShown === false);
ok('③b 買進類仍要有 toast(⛔ 不可完全沒反應)', R.buyToast === 1, `toast=${R.buyToast}`);
ok('④ 分級:出場/風險類全部判為高優先級', R.urgent.every(Boolean), JSON.stringify(R.urgent));
ok('④b 分級:買進/共振類全部⛔ 不可判為高優先級', R.calm.every(v => v === false), JSON.stringify(R.calm));
ok('⑤ 🚨 全市場盤點摘要(沒有 sym)⛔ 不可彈窗 —— 那是統計不是「現在要做的事」', R.noSymShown === false);
ok('⑤b 沒彈窗就一定要有 toast(⛔ 不可靜默吞掉)', R.noSymToast >= 1);
ok('⑮ 🚨 你**庫存**裡的股票 + **買進類** → ⛔ 不可彈窗(V75.2.7 收回;使用者回報太頻繁)',
   R.mineInvShown === false, JSON.stringify(R.mineInvShown));
ok('⑮a2 但它⛔ 不可靜默 —— 要有 toast(錯過還有下一次,但不能沒訊息)', R.mineInvToast >= 1, `${R.mineInvToast}`);
ok('⑮b 你**自選**裡的股票 + 買進類 → 同樣⛔ 不彈', R.mineFavShown === false);
ok('⑮b2 ⭐ 你庫存裡的股票 + **風險類** → 一定要彈(⛔ 這一半不可跟著收掉)', R.mineRiskShown === true);
ok('⑮c 🚨 不是你的股票 + 買進類 → ⛔ 不可彈窗(那正是「跟他無關的東西也在彈」)', R.otherBuyShown === false, JSON.stringify(R.otherBuyShown));
ok('⑮d 不是你的股票 + 買進類 → 仍要有 toast', R.otherBuyToast >= 1);
ok('⑮e 不是你的股票 + **風險類** → 仍要彈(⛔ 多空不對稱那層不可整個關掉)', R.otherRiskShown === true);
ok('⑮f `_mySyms()` 涵蓋庫存與自選、⛔ 不含別人的', JSON.stringify(R.mySymsHas) === '[true,true,false]', JSON.stringify(R.mySymsHas));
ok('⑥ 關得掉', R.closed);
// ═══ 🥊 V74.9.2 ═══
ok('⑨ 🚨 賣訊/風險類(頂背離)→ 大視窗(使用者:「請以大視窗為主」),⛔ 不再是 toast', R.divShown === true && R.divToast === 0, `shown=${R.divShown} toast=${R.divToast}`);
ok('⑨b 停利/出貨/減碼/背離/第N擊 全部判高優先', R.sellUrgent.every(Boolean), JSON.stringify(R.sellUrgent));
ok('⑨c ⛔ 進場類(晨星/主打型態/頸線突破)仍⛔ 不可彈窗(多空不對稱)', R.buyCalm2.every(v => v === false), JSON.stringify(R.buyCalm2));
ok('⑩ 排隊:第二則⛔ 不可蓋掉第一則', /RSI 頂背離/.test(R.q1Title), R.q1Title);
ok('⑩b 🪟 V75.2.7 合併:提示要說「這批共 N 則」(⛔ 不再是「還有 N 則」那種看不到內容的排隊)',
   R.qHintShown && /這批共 2 則/.test(R.qHint), R.qHint);
ok('⑩b2 ⭐ 其餘則要**真的列在視窗裡**(⛔ 一則都不可遺失)', R.moreCount === 1, `列出 ${R.moreCount} 則`);
ok('⑩c 排隊的那則⛔ 不可另外 toast(那正是「兩個視窗很像」的來源)', R.qToast === 0, `toast=${R.qToast}`);
ok('⑩d 🪟 V75.2.7 按一次「知道了」→ **整批關掉**(⛔ 不再逐則重跳 —— 使用者:「關掉一個又馬上跳一個」)',
   R.q2Shown === false, `關掉後還開著=${R.q2Shown}`);
ok('⑪ 🚨 大視窗跳了 + App 在前景 → ⛔ 不再發系統通知', R.osWhenPopped === 0, `Notification 呼叫 ${R.osWhenPopped} 次`);
ok('⑪b 🚨 V75.2.7 走 toast 的那些,**前景時也⛔ 不可再發系統通知**'
   + '(使用者:「手機通知和 App 視窗講同一件事」)', R.osWhenToast === 0, `${R.osWhenToast}`);
ok('⑪b2 ⭐ 但 App 在**背景**時一定要發(⛔ 那時畫面上的東西他一個都看不到)',
   R.osWhenHidden >= 1, `背景時發了 ${R.osWhenHidden} 次`);
ok('⑫ 🥊 連續技:有貨 → 第 1/2/3 擊都排出來', /第 1 擊/.test(R.comboTxt) && /第 2 擊/.test(R.comboTxt) && /第 3 擊/.test(R.comboTxt), R.comboTxt.slice(0, 120));
ok('⑫b 第 2 擊 = 你設定的出場線(設定改成唐奇安 → 名字與價位都要跟著變,⛔ 不可自己另訂一條)',
   !!R.plan && /唐奇安/.test(R.plan.nm) && R.plan.px > 0 && R.donPx > 0 && Math.abs(R.plan.px - R.donPx) < 1e-6 && R.donPx !== R.ma5Px && /唐奇安/.test(R.comboTxt),
   JSON.stringify({ plan: R.plan, don: R.donPx, ma5: R.ma5Px }));
{   // ⑫b2 靜態:_comboPlan 本體必須呼叫 _exitRuleKey()(全 App 唯一設定點)
    const i = SRC.indexOf('    _comboPlan(sym, kdata) {'), j = SRC.indexOf('\n    },', i);
    const fn = i >= 0 ? SRC.slice(i, j) : '';
    ok('⑫b2 靜態:_comboPlan 讀 this._exitRuleKey()(⛔ 不可寫死某一條)', fn.length > 100 && /this\._exitRuleKey\(\)/.test(fn) && !/key = '(ma5|atr2|don|trail8)'/.test(fn));
}
ok('⑫c 零股族股數要對(0.07 張 = 70 股 → 一半 35 股,⛔ 不是 1 張)', !!R.plan && R.plan.sh === 70 && R.plan.half === 35 && /35 股/.test(R.comboTxt), JSON.stringify(R.plan));
ok('⑫d 🚨 必須寫「串起來沒有另外回測」+「不是自動下單」', /串起來沒有另外回測/.test(R.comboTxt) && /不是自動下單/.test(R.comboTxt), R.comboTxt.slice(-120));
ok('⑫e 有貨才顯示「幫我盯第 2 擊」', R.armShown === true);
ok('⑫f 按下去 → 到價提醒 + 連續技清單都要有(⛔ 只記一邊等於沒接力)', R.armedPA === 1 && !!R.armedWatch && R.armedWatch.step === 2, `pa=${R.armedPA} watch=${JSON.stringify(R.armedWatch)}`);
ok('⑬ 第 2 擊接力:沒跌破⛔ 不跳', R.hit0 === false && R.hit0Shown === false);
ok('⑬b 跌破 → 再跳一次大視窗、標題「第 2 擊」', R.hit1 === true && R.hit1Shown && /第 2 擊/.test(R.hit1Title), R.hit1Title);
ok('⑬c 跳過一次就從清單移除(⛔ 不可每 60 秒連跳)', R.watchAfter === null);
ok('⑭ 空手:⛔ 不給「幫我盯」、必須寫「不是進場點」', R.flatArm === false && /不是進場點/.test(R.flatTxt), R.flatTxt.slice(0, 100));

// 靜態:⛔ 不可用紅綠燈(V74.8.8 的鐵則)
{
  const i = SRC.indexOf('id="alertPopModal"');
  const seg = SRC.slice(i, i + 2200);
  ok('⑦ ⛔ 彈窗⛔ 不可用紅綠 emoji / 紅綠底色(講風險不是漲跌方向)',
     !/[🔴🟢]/u.test(seg) && !/bg-green-|bg-red-/.test(seg));
  ok('⑦b 要寫明「這是提醒不是自動下單」+ 指路個股頁',
     /不是自動下單/.test(seg) && /現在該做什麼/.test(seg));
}
// 靜態:接線只有一處(⛔ 不可在 28 個呼叫端各寫一次 —— 陷阱 #37)
{
  // 🪟 V75.2.7 回到**只有一處**:`_closeAlertPop` 的「排隊接力」已經拿掉(改成整批一起關),
  //   所以合法呼叫端只剩 `_fireAlert`。⛔ 任何 `_fireAlert` 的呼叫端自己接 `_alertPopup` 仍要抓。
  const fn = (head) => { const i = SRC.indexOf(`    ${head}`); const j = SRC.indexOf('\n    },', i); return i >= 0 ? SRC.slice(i, j) : ''; };
  const nAll = (SRC.match(/this\._alertPopup\(/g) || []).length;
  const nOK = (fn('_fireAlert(title, body, sym) {').match(/this\._alertPopup\(/g) || []).length;
  ok('⑧ 接線只在 `_fireAlert` 一處 ⛔ 28 個呼叫端不可各接一次', nAll === 1 && nOK === 1, `全檔 ${nAll} 處 / 合法 ${nOK} 處`);
}

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ ALERTPOP_PASS(全部通過)');
process.exit(fails ? 1 : 0);
