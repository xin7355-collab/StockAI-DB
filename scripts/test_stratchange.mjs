#!/usr/bin/env node
/**
 * 🔁 策略預設值變更通知(V75.0.9)—— 使用者:
 *   「爾後有回測或者厲害的策略,**比我原本設定的策略還要好就直接替換**,
 *     我不要等我發現你才替換,這樣我回測就沒有意義」
 *   +(選項)「開 App 跳一次,按了才消失」
 *
 * ⭐ 為什麼要有這支:V75.0.0 使用者自己要求把一般更新提醒關掉
 *   → `_checkVersionUpdate` 現在只蓋章、完全不跳窗
 *   → 我 V74.5.4 把預設出場從「跌破 5 日線」換成 ATR 時,他**沒有任何管道會知道**,
 *     而出場規則變更會**直接改變他手上部位的防守價**。
 *
 * ⛔ 五條不可改掉的設計(每一條都用注入缺陷驗證過):
 * ① 必須同時寫 from / to / why(**數字**)/ cost(**代價**)/ you(**對你的影響**)
 * ② 🚨 **按了「知道了」才蓋章**(⛔ 不可 render 就蓋 → 那會變成「跳一次就沒了」)
 * ③ ⛔ 一般功能更新**仍然不跳窗**(`_checkVersionUpdate` 一行都不動)
 * ④ ⛔ 舊選項不刪,而且視窗要有「換回舊的」一鍵
 * ⑤ 首次安裝/舊用戶:只蓋章不跳
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 240) : ''}`); } };

// ═══ 靜態 ═══
// ⛔ 註解本身會寫到那些欄位名 → 掃描前先剝掉註解(本專案已踩過 15 次)
const noCmt = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const scAt = noCmt.indexOf('_STRAT_CHANGES:');
const scBlk = scAt < 0 ? '' : noCmt.slice(scAt, noCmt.indexOf('\n    ]', scAt) + 6);
ok('⓪ 取樣守門:真的抓到 `_STRAT_CHANGES` 那一段', scAt > 0 && scBlk.length > 200, `len=${scBlk.length}`);

for (const k of ['from', 'to', 'why', 'cost', 'you', 'back'])
    ok(`① 每一筆變更都要有 \`${k}\``, new RegExp(`\\b${k}:`).test(scBlk));
ok('①b 🚨 why 必須含**數字**(⛔ 只寫「換成更好的了」等於沒說)', /why:[^\n]*\d/.test(scBlk));
ok('①c 🚨 cost 必須含**數字**(代價要說得出多少)', /cost:[^\n]*\d/.test(scBlk));

// ③ ⛔ 一般更新彈窗不可被恢復
const cvAt = noCmt.indexOf('_checkVersionUpdate() {');
const cvBlk = cvAt < 0 ? '' : noCmt.slice(cvAt, cvAt + 1400);
ok('③ ⛔ `_checkVersionUpdate` 仍然不跳窗(⛔ V75.0.0 使用者關掉的那個不可恢復)',
   cvBlk.length > 200 && !/_showUpdateLog|_showRichModal|updateLogModal/.test(cvBlk), cvBlk.slice(0, 160));

// ② 蓋章只准在 `_ackStratChange` 裡發生
const shAt = noCmt.indexOf('_showStratChange(c) {');
const shBlk = shAt < 0 ? '' : noCmt.slice(shAt, noCmt.indexOf('_ackStratChange(v) {', shAt));
ok('②a 取樣守門:真的抓到 `_showStratChange`', shAt > 0 && shBlk.length > 300);
ok('②b 🚨 `_showStratChange` 裡 ⛔ 不可蓋章(按了才算看過)',
   shBlk.length > 300 && !/lastSeenStrat/.test(shBlk));
ok('②c 蓋章寫在 `_ackStratChange`', /_ackStratChange\(v\) \{[\s\S]{0,200}proTerm_lastSeenStrat/.test(noCmt));
ok('②d ⛔ 不可用日期判斷(那是一般更新彈窗的做法)',
   !/_checkStratChange\(\) \{[\s\S]{0,900}Asia\/Taipei/.test(noCmt));

// ④ 舊選項不刪
ok('④ ⛔ 四個出場選項一個都不准刪', ['don', 'atr2', 'trail8', 'ma5']
   .every(k => new RegExp(`k: '${k}'`).test(noCmt.slice(noCmt.indexOf('_EXIT_RULE_OPTS:'), noCmt.indexOf('_EXIT_RULE_OPTS:') + 900))));

// ⑥ 預設真的換成 don(A 步驟)
// ⚠️ `_exitRuleKey()` 在檔案裡有多處**呼叫端**(5509 等)→ 取樣一律用**帶縮排的定義**
const erAt = noCmt.indexOf('\n    _exitRuleKey() {');
const erBlk = erAt < 0 ? '' : noCmt.slice(erAt, noCmt.indexOf('\n    },', erAt));
ok('⑥a 取樣守門:真的抓到 `_exitRuleKey` 的**定義**', erAt > 0 && /_EXIT_RULE_OPTS/.test(erBlk), erBlk.slice(0, 120));
ok('⑥ 預設出場 = 唐奇安(`_exitRuleKey` **兩個** fallback 都是 don)',
   (erBlk.match(/'don'/g) || []).length === 2, erBlk.replace(/\s+/g, ' '));
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
ok("⑥b 🚨 `auto_trade.py` 的預設也要一起換(那支會動真錢)", /EXIT_RULE = os\.getenv\('EXIT_RULE', 'don'\)/.test(AT));
ok('⑥c 🚨 沒設 ACCOUNT_SIZE 要印警告(POS_PCT 會完全不生效,⛔ 不可靜默)',
   /ACCOUNT_SIZE <= 0/.test(AT) && /完全沒有作用/.test(AT));

// ⑦ 燈號鐵則
ok('⑦ ⛔ 這個視窗不用紅綠燈(講的是規則換了,不是漲跌方向)',
   !/🔴|🟢/.test(shBlk));

// ═══ 動態 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app._checkStratChange, null, { timeout: 30000 });

const R = await page.evaluate(() => {
    const A = window.app || app;
    const K = 'proTerm_lastSeenStrat';
    const out = {};
    const shown = () => { const m = document.getElementById('richHelpModal'); return !!m && !m.classList.contains('hidden'); };
    const hide = () => { const m = document.getElementById('richHelpModal'); if (m) m.classList.add('hidden'); };

    // ⑤ 全新安裝(`_firstRun`):只蓋章不跳
    localStorage.removeItem(K); hide(); A._firstRun = true;
    A._checkStratChange();
    out.firstShown = shown(); out.firstStamp = localStorage.getItem(K);

    // ⑤b 🚨 老用戶但還沒看過任何策略變更 → **要跳**
    //    (⛔ 一律靜默的話,第一次的策略變更誰都收不到 = 整套通知等於沒做)
    localStorage.removeItem(K); hide(); A._firstRun = false;
    A._checkStratChange();
    out.oldUserShown = shown(); out.oldUserStamp = localStorage.getItem(K);

    // ⑤c 拿不到旗標時要當老用戶(寧可多提醒一次)
    localStorage.removeItem(K); hide(); delete A._firstRun;
    A._checkStratChange();
    out.noFlagShown = shown();

    // ⑧ 沒看過(舊版號)→ 要跳,而且**還沒蓋章**
    localStorage.setItem(K, 'V70.0.0'); hide();
    A._checkStratChange();
    out.newShown = shown();
    out.stampBeforeAck = localStorage.getItem(K);
    out.body = (document.getElementById('richHelpModal') || {}).innerText || '';

    // ⑨ 按「知道了」才蓋章
    A._ackStratChange(A._STRAT_CHANGES[0].v);
    out.stampAfterAck = localStorage.getItem(K);
    out.hiddenAfterAck = !shown();

    // ⑩ 已看過 → 不跳
    hide(); A._checkStratChange();
    out.seenShown = shown();

    // ⑪ 「換回舊的」真的會換
    A.settings = A.settings || {};
    out.defRule = A._exitRuleKey();
    A.setExitRule(A._STRAT_CHANGES[0].back);
    out.afterBack = A._exitRuleKey();
    delete A.settings.exitRule;
    out.backToDefault = A._exitRuleKey();
    return out;
});
await browser.close();

ok('⑤ 全新安裝:⛔ 不跳窗,只蓋章', R.firstShown === false && R.firstStamp);
ok('⑤b 🚨 老用戶(還沒看過任何策略變更)→ **要跳**,而且⛔ 還沒蓋章',
   R.oldUserShown === true && !R.oldUserStamp, `shown=${R.oldUserShown} stamp=${R.oldUserStamp}`);
ok('⑤c 拿不到旗標時當老用戶(寧可多提醒一次,⛔ 不可漏掉)', R.noFlagShown === true);
ok('⑧ 沒看過 → 會跳窗', R.newShown === true);
ok('⑧b 🚨 跳出來的當下**還沒蓋章**(⛔ 不可 render 就蓋)', R.stampBeforeAck === 'V70.0.0', R.stampBeforeAck);
ok('⑨ 按「知道了」才蓋章', R.stampAfterAck && R.stampAfterAck !== 'V70.0.0');
ok('⑨b 按了之後視窗會關掉', R.hiddenAfterAck === true);
ok('⑩ 已看過 → ⛔ 不再跳', R.seenShown === false);
ok('⑪ 預設是唐奇安', R.defRule === 'don', R.defRule);
ok('⑪b 「換回舊的」真的換得回 ATR', R.afterBack === 'atr2', R.afterBack);
ok('⑪c 清掉設定會回到預設 don', R.backToDefault === 'don', R.backToDefault);

// 內容:五件事都要看得到(⛔ 只寫「換成更好的了」等於沒說)
const B = String(R.body).replace(/\s+/g, ' ');
ok('⑫ 視窗要寫「原本是什麼」', /原本[：:]?/.test(B) && /ATR/.test(B), B.slice(0, 160));
ok('⑫b 視窗要寫「現在是什麼」', /現在[：:]?/.test(B) && /唐奇安/.test(B));
ok('⑫c 視窗要寫「為什麼換」而且有數字', /為什麼換/.test(B) && /590/.test(B) && /531/.test(B));
ok('⑫d 🚨 視窗要寫「代價」', /代價/.test(B) && /25\.2/.test(B));
ok('⑫e 🚨 視窗要寫「對你的影響」', /對你的影響/.test(B) && /防守價/.test(B));
ok('⑫f 視窗要有「換回舊的」', /換回舊的/.test(B));
ok('⑫g ⛔ 要明說舊的沒有刪掉', /沒有刪掉|都還在/.test(B));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
