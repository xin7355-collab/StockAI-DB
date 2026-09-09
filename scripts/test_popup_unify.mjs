#!/usr/bin/env node
/**
 * 🪟 視窗統一(V75.0.0)—— 使用者:「① 把更新版本提醒主動彈跳關閉
 *   ② 目前彈跳視窗有大小視窗感覺很像請關閉小的,統一用大的」
 *
 * ⭐ 「小視窗」= 瀏覽器原生 `alert()`(灰色系統對話框),「大視窗」= `_showRichModal`。
 *   → 教學/說明類一律改走 `app._helpBox(原本那個字串)`,⛔ 文案一個字都不用改。
 *
 * ⛔ 四類**刻意不動**(⛔ 別下一輪又「順手統一」):
 *   ・`showConfirm`(11 個破壞性操作的二次確認)—— 它要**擋住**你才安全
 *   ・輸入驗證錯誤(「格式不對」「請先填…」)—— 它要**阻斷**後續動作,而 toast 不會
 *   ・約 95 處操作回饋 toast(已加入自選/已儲存…)—— 每按一次鈕都被大視窗擋一次,體驗會崩
 *   ・`prompt` 9 處(要輸入值)
 *
 * ⛔ 三條不可改掉的設計:
 * ① 砍掉版本自動彈時,**下一行的 `localStorage.setItem` 一定要留** ——
 *    不蓋章的話日後恢復自動彈,會一次把中間累積的所有版本全倒出來。
 * ② `_showUpdateLog` 與 `updateLogModal` **⛔ 不可刪** —— 設定中心「🆕 更新紀錄」那條路要留,
 *    而且 `_showNoiseList` 共用同一顆 modal。
 * ③ `_fireHuntNotification` 一律走 `_fireAlert`(⛔ 不可自己 `new Notification`)——
 *    繞過去的話鈴鐺歷史查不到,而且前景會多跳一次系統通知。
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + e : ''}`); } };

// ═══ 靜態 ═══
// ① onclick 裡⛔ 不可再有 alert(
const inlineAlerts = (SRC.match(/onclick=\\?"[^"]*?(?<![\w.])alert\(/g) || []).length;
ok('① onclick 裡的教學⛔ 不可再走原生 alert(小視窗)', inlineAlerts === 0, `還有 ${inlineAlerts} 處`);

// ①b 空過守門:_helpBox 真的被大量接上(⛔ 全部被刪掉也會讓 ① 通過)
const helpCalls = (SRC.match(/_helpBox\(/g) || []).length;
ok('①b 空過守門:_helpBox 呼叫端要有 ≥60 處(⛔ 不是把教學整個刪掉)', helpCalls >= 60, `${helpCalls} 處`);

// ② 🚨 剩下的 alert 只能是「操作型」—— 用**明確清單**,⛔ 不自動推導
//    ⭐ 為什麼是清單不是規則:實測「長度」與「有沒有 \\n\\n」都分不開兩者
//       (最長的操作型 110 字、最短的教學型是變數 0 字)。
//    ⛔ 用會誤判的規則 = 誤報,而誤報會讓人養成無視守門的習慣(CLAUDE.md 鐵則)。
//    ⭐ 新增一個操作型 alert 要**自覺地**加進這張表 —— 那個摩擦是刻意的。
const OPERATIONAL = [
    "'請先在「Worker 網址」欄填入你的 Cloud", "'Worker 網址必須 https:// 開頭')",
    "'連線 Worker 失敗:' + (e?.mess", "'✅ 綁定完成!", "'請先至 ⚙️ 設定填寫 Gemini API Ke",
    "'ETF 代號格式不對,範例:0050 / 0087", "sym + ' 已是內建基準,不用重複加'); re",
    "sym + ' 已在你的自訂基準了'); retur", "'自訂基準最多 8 檔,請先移除一些'); retu",
    "'✅ 清除完成,即將重整...');", "'清除過程出錯,直接重整一次:", "'✅ 已下載 JSON 並複製到剪貼簿');",
    "'目前沒有任何歷史快照'); return; }", "'✅ 已清除');", "`✅ FinMind Token 驗證完成：${ok",
    "'尚無自選清單,請先到「自選」頁建立'); retu", "'⚠️ 請先在個股頁選一檔股票'); return;",
    "'請先點「分析這檔的最佳打法」產生結果。'); re", "'請輸入有效的數字。'); return; }",
    "'這一檔沒有固定的觸發價(這招不是靠價位成立)→ 不", "`⚠️ ${sym} K 線資料不足（< 20 筆）",
    "'當前 tab 沒有可加入的標的');", "'⚠️ 尚未設定任何 AI Key,無法生成盤前速報",
    "'您的瀏覽器不支援 Web Push。", "'⚠️ 關 App 推播需要你的 Cloudflar", "'✅ 已取消推播訂閱');",
    "'⚠️ 請允許通知權限才能啟用推播告警。'); re", "'❌ 你的 Worker 是舊版(還沒有推播功能)。",
    "testOk", "'推播啟用失敗：' + e.message); }", "'資料不足，至少需要20天資料'); return;",
];
const leftover = [];
SRC.split('\n').forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;                 // ⛔ 先剝註解(本專案已踩 15 次)
    if (/catch \(_\) \{ try \{ alert\(text\)/.test(ln)) return;   // _helpBox 自己的退路
    const re = /(?<![\w.])alert\(/g; let m;
    while ((m = re.exec(ln))) {
        const sig = ln.slice(m.index + 6, m.index + 32).trim();
        if (!OPERATIONAL.some(o => sig.startsWith(o.slice(0, 14)))) leftover.push([i + 1, sig]);
    }
});
ok('② 🚨 教學型⛔ 不可再留在 alert 裡(剩下的只能是清單上的操作型)', leftover.length === 0, JSON.stringify(leftover));
ok('②b 空過守門:清單上的操作型 alert 真的還在(⛔ 不是被整批刪光才通過)',
   (SRC.match(/(?<![\w.])alert\(/g) || []).length >= 25);

// ③ 版本自動彈:那一行要沒了,但蓋章要在
// ⚠️ 取樣要抓**定義**不是呼叫端 —— `indexOf('_checkVersionUpdate()')` 會先撞到 init 那行
const _vi = SRC.indexOf('_checkVersionUpdate() {');
const vf = SRC.slice(_vi, _vi + 1600);
ok('⓪ 取樣守門:真的抓到 `_checkVersionUpdate` 的定義', _vi > 0 && /localStorage/.test(vf));
ok('③ 🚨 版本更新⛔ 不可再自動彈窗', !/_showUpdateLog\(/.test(vf), vf.match(/_showUpdateLog\([^)]*\)/)?.[0] || '');
// ⚠️ 這裡要**數兩次** —— 函式裡本來就有「首次/舊用戶設起點」那一次 setItem,
//    只寫 `.test()` 的話,把「有新版時的蓋章」砍掉照樣會被那一次救活(假綠燈)。
const stamps = (vf.match(/localStorage\.setItem\(KEY, cur\)/g) || []).length;
ok('③b 🚨 但「記住已看過」的蓋章⛔ 不可一起砍掉(否則日後恢復會一次倒出整堆舊版)',
   stamps === 2, `只找到 ${stamps} 次(首次起點 1 次 + 有新版時 1 次)`);

// ③c 手動看更新紀錄那條路⛔ 不可刪
ok('③c `_showUpdateLog` 與 `updateLogModal` 仍在(設定中心那條路 + _showNoiseList 共用)',
   /_showUpdateLog\(seen\)\s*\{|_showUpdateLog\(/.test(SRC) && /id="updateLogModal"/.test(SRC));

// ④ _fireHuntNotification 走 _fireAlert
const _fi = SRC.indexOf('\n    _fireHuntNotification(alert) {');
const fh = SRC.slice(_fi, _fi + 900);
ok('⓪b 取樣守門:真的抓到 `_fireHuntNotification` 的定義', _fi > 0 && fh.includes('_fireHuntNotification(alert) {'));
ok('④ 🚨 獵殺通知要走 `_fireAlert`(⛔ 繞過去的話鈴鐺歷史查不到)', /this\._fireAlert\(/.test(fh));
ok('④b ⛔ 不可自己 `new Notification`', !/new Notification\(/.test(fh), fh.slice(0, 200));

// ⑤ 判準三層要在 _shouldPopup 裡(⛔ 不可散在呼叫端)
ok('⑤ 彈窗判準只有 `_shouldPopup` 一處(⛔ 呼叫端不可各判一次)',
   (SRC.match(/_shouldPopup\(/g) || []).length === 2);   // 定義 1 + _alertPopup 1

// ═══ 實跑 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app._helpBox, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const out = {};
    const rm = () => document.getElementById('richHelpModal');
    // ⑥ 教學走大視窗,第一行當標題
    A._helpBox('📖 這是標題\n\n第一段\n第二段');
    out.shown = !!rm() && !rm().classList.contains('hidden');
    out.title = rm()?.querySelector('h3')?.textContent || '';
    out.body = rm()?.querySelector('.p-4')?.innerText || '';
    out.pre = /whitespace-pre-wrap/.test(rm()?.innerHTML || '');
    rm()?.classList.add('hidden');
    // ⑦ 第一行太長 → 退回「📖 說明」,全文都當內文(⛔ 不可把內文截去當標題)
    const longFirst = '這是一段很長很長的說明文字它超過三十個字所以不該被拿去當抬頭用喔喔喔\n第二行';
    A._helpBox(longFirst);
    out.longTitle = rm()?.querySelector('h3')?.textContent || '';
    out.longBodyHasFirst = (rm()?.querySelector('.p-4')?.innerText || '').includes('很長很長');
    rm()?.classList.add('hidden');
    // ⑧ HTML 要被跳脫(⛔ 文案裡的 < 不可變成標籤)
    A._helpBox('標題\n<img src=x onerror=1> & <b>粗</b>');
    out.escaped = !/<img|<b>/.test(rm()?.querySelector('.p-4')?.innerHTML || '');
    out.escText = (rm()?.querySelector('.p-4')?.innerText || '').includes('<b>粗</b>');
    rm()?.classList.add('hidden');
    // ⑨ 獵殺通知 → 記得進鈴鐺歷史
    try { localStorage.removeItem('proTerminalNotifHistory'); } catch (_) {}
    A._fireHuntNotification({ label: '🎯 VCP突破', name: '台積電', sym: '2330', msg: '帶量突破', strategy: 'vcp' });
    try { out.hist = (JSON.parse(localStorage.getItem('proTerminalNotifHistory') || '[]') || []).length; } catch (_) { out.hist = -1; }
    A._closeAlertPop?.();
    return out;
});
await browser.close();

ok('⑥ 教學改走大視窗(richHelpModal)', R.shown === true);
ok('⑥b 第一行當標題', R.title === '📖 這是標題', R.title);
ok('⑥c 內文原樣呈現、換行保留', R.body.includes('第一段') && R.body.includes('第二段') && R.pre === true);
ok('⑦ 第一行太長 → 退回「📖 說明」', R.longTitle === '📖 說明', R.longTitle);
ok('⑦b 而且那一行要回到內文裡(⛔ 不可被吃掉)', R.longBodyHasFirst === true);
ok('⑧ 🚨 文案要被跳脫(⛔ 不可讓 < 變成標籤)', R.escaped === true);
ok('⑧b 但字面上要看得到原文', R.escText === true);
ok('⑨ 獵殺通知進得了鈴鐺歷史(⛔ 舊版繞過 _fireAlert → 查不到)', R.hist === 1, String(R.hist));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ POPUP_UNIFY_PASS(全部通過)');
process.exit(fails ? 1 : 0);
