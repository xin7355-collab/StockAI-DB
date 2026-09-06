#!/usr/bin/env node
/**
 * 🪟 事件觸發彈窗(V74.8.9)—— 使用者:「有依照這個方式做事件觸發時的彈跳視窗嗎?」
 *
 * 答案原本是「沒有」:觸發時只走系統推播 + 鈴鐺,
 * 🚨 而 `_fireAlert` 在**沒開通知權限時直接 return** → 畫面上零反應。
 *
 * ⛔ 五條不可改掉的設計:
 * ① ⭐ **只有出場/風險類才彈窗**,買進/點火類一律 toast ——
 *    那不是版面偏好,是本站的**多空不對稱**鐵則(勝率 30~33%,靠小賠出場才會賺)。
 *    ⛔ 每個事件都彈 = 使用者三天後關掉 = 整套失效。
 * ② 同一件事**一天只跳一次**(⛔ 否則股價在門檻上下震盪會連跳)。
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

    // ⑤ 沒有 sym 時「看這一檔」要收起來
    clear(); A._fireAlert('🚨 大盤跌破月線', '風險提醒', '');
    out.noSymGoHidden = document.getElementById('alertPopGo').style.display === 'none';
    A._closeAlertPop();
    out.closed = !shown();

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
ok('⑤ 沒有股票代號時「看這一檔」要收起來(⛔ 不可給一顆按了沒用的鈕)', R.noSymGoHidden);
ok('⑥ 關得掉', R.closed);

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
  const n = (SRC.match(/this\._alertPopup\(/g) || []).length;
  ok('⑧ 接線只在 `_fireAlert` 一處(⛔ 28 個呼叫端不可各接一次)', n === 1, `實際 ${n} 處`);
}

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ ALERTPOP_PASS(全部通過)');
process.exit(fails ? 1 : 0);
