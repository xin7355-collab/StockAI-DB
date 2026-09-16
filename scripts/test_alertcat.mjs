// 🔔 V77.2.2 通知種類勾選 —— 守門測試
//   使用者:「不要這樣子的方式顯示,改成一般 app 通知的方式,另外列出通知的選單,
//            我想要變成我能控制勾選選擇的方式」。
//
// ⛔ 四條不可違反的設計(注入任何一條都要叫得出來):
//   ① 分類**順序**不可換 —— 實跑掃過所有真實標題,真的靠順序決定的有**兩處**:
//      ・「🥊 第 2 擊｜跌破 月線」同時對上 pos(第2擊)與 exit(跌破)→ pos 必須在前,
//        否則你自己的部位訊號會變成可以關掉的一般風險訊號。
//      ・「⛔ 逃頂共振·高危」同時對上 exit(逃頂)與 entry(共振)→ exit 必須在前,
//        否則一則賣訊會被歸成買點(多空不對稱鐵則直接破功)。
//      ⭐ 誠實紀錄:`day` 在 `pos` 前面目前**沒有重疊**,那條是預防性的。
//   ② `pos`/`price` 的 `lock` 不可拿掉 —— 那是「你自己設的停損/停利/到價」,
//      ⛔ 不是本站的預測(CLAUDE.md 既有鐵則:那一類不走任何統計守門)。
//   ③ `_fireAlert` 必須真的接上守門 —— 只有總表沒接 = 規則只活在文件裡(陷阱 #37)。
//   ④ 被關掉的**一則都不可以消失** —— `_recordNotifHistory` 要排在守門**之前**。
//      (使用者要的是「不被打擾」⛔ 不是「查不到」。)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, name, extra = '') => { console.log(`${c ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); if (!c) bad++; };

// 📦 期望分類(逐字取自真實 `_fireAlert` 呼叫端的標題,⛔ 不憑印象編 —— 陷阱 #40)
const EXPECT = [
  ['🛑 停損到了｜中美晶', 'pos'], ['💰 停利條件到了｜微星', 'pos'],
  ['🩸 庫存鐵血停損', 'pos'], ['🥊 第 2 擊｜跌破 月線', 'pos'], ['🚨 鐵血停損 -5%', 'pos'],
  ['⏰ 當沖平倉倒數(13:25)', 'day'], ['🎯 09:15 當沖候選｜多 3・空 1', 'day'],
  ['🔔 到價提醒', 'price'], ['🎯 獵殺清單觸發', 'price'],
  ['🚨 大盤極度恐慌', 'market'], ['🚨 全球熔斷警報!2 個指數觸發', 'market'], ['🚨 全面黑天鵝訊號', 'market'],
  ['🚨 處置股風險', 'dispo'],
  ['📉 高檔出貨訊號', 'exit'], ['🕯️ 長黑K壓力｜國巨', 'exit'], ['🟡 跌破月線', 'exit'],
  ['⚠️ 創 20 日新低', 'exit'], ['🧯 六脈熄火(盤中)', 'exit'], ['⛔ 逃頂共振·高危', 'exit'],
  ['🔴 突破 5MA', 'entry'], ['📐 費波納契回撤買點', 'entry'], ['⚡ 六脈點火(盤中)', 'entry'],
  ['🔴 A+ 級買點共振', 'entry'], ['🚀 創 20 日新高', 'entry'], ['🧊 低基期起漲', 'entry'],
  ['🌇 09/16(三) 盤後零股盤點', 'other'],
];

const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const pg = await (await b.newContext()).newPage();
await pg.goto(pathToFileURL(resolve('index.html')).href);
await pg.waitForTimeout(3000);

const alive = await pg.evaluate(() => typeof app === 'object' && Array.isArray(app._ALERT_CATS));
ok(alive, '⓪ 空過守門:app 有載起來且 `_ALERT_CATS` 存在');
if (!alive) { await b.close(); process.exit(1); }

// ① 每一則都要落到對的類(順序錯了這裡就會紅)
const got = await pg.evaluate(T => T.map(([t]) => app._alertCatOf(t).k), EXPECT);
const wrong = EXPECT.map(([t, w], i) => got[i] === w ? null : `${t} → ${got[i]}(該是 ${w})`).filter(Boolean);
ok(wrong.length === 0, `① ${EXPECT.length} 個真實標題全部分類正確`, wrong.join(' ・ '));

// ①b 當沖那兩則⛔ 不可被部位類收走(`day` 必須排在 `pos` 前面)
const dayIdx = await pg.evaluate(() => [app._ALERT_CATS.findIndex(c => c.k === 'day'), app._ALERT_CATS.findIndex(c => c.k === 'pos')]);
ok(dayIdx[0] >= 0 && dayIdx[0] < dayIdx[1], '①b 分類順序(預防性):⚡當沖 排在 👜你的部位 之前', `day=${dayIdx[0]} pos=${dayIdx[1]}`);
// ①c ⭐ 這兩條才是**真的**靠順序撐住的(拿掉順序它們就會歸錯類)
const ord = await pg.evaluate(() => {
  const i = k => app._ALERT_CATS.findIndex(c => c.k === k);
  return { pos: i('pos'), exit: i('exit'), entry: i('entry'),
           a: app._alertCatOf('🥊 第 2 擊｜跌破 月線').k, b: app._alertCatOf('⛔ 逃頂共振·高危').k };
});
ok(ord.pos < ord.exit && ord.a === 'pos', '①c 「第 2 擊｜跌破」必須歸 👜你的部位(⛔ 不可被 exit 搶走 = 會變成可關掉的)', `pos=${ord.pos} exit=${ord.exit} → ${ord.a}`);
ok(ord.exit < ord.entry && ord.b === 'exit', '①d 「逃頂共振」必須歸 🚪賣出(⛔ 不可被 entry 搶走 = 賣訊變買點)', `exit=${ord.exit} entry=${ord.entry} → ${ord.b}`);

// ② 勾掉一類就不再打擾,而且⛔ 只影響那一類
const g = await pg.evaluate(() => {
  app.settings = app.settings || {}; app.settings.alertOff = {};
  const on0 = app._alertCatOn('📐 費波納契回撤買點');
  app.settings.alertOff = { entry: true };
  const on1 = app._alertCatOn('📐 費波納契回撤買點');
  const other = app._alertCatOn('📉 高檔出貨訊號');
  app.settings.alertOff = { pos: true, price: true, entry: true, day: true };
  const locked = app._alertCatOn('🛑 停損到了') && app._alertCatOn('🔔 到價提醒');
  const dayOff = app._alertCatOn('⏰ 當沖平倉倒數(13:25)');
  app.settings.alertOff = {};
  return { on0, on1, other, locked, dayOff };
});
ok(g.on0 === true && g.on1 === false, '② 勾掉「📈 進場/買點」之後那一類就不打擾了');
ok(g.other === true, '②b ⛔ 只影響被勾掉的那一類(賣出類不受影響)');
ok(g.locked === true, '③ 🔒 部位/到價 就算被硬寫進 alertOff 仍然要過(⛔ 不給關)');
ok(g.dayOff === false, '③b 當沖類沒有 lock → 關得掉');

// ④ 被關掉的仍要進 🔔 通知歷史(⛔ 一則都不可以消失)
const h = await pg.evaluate(() => {
  try { localStorage.removeItem('proTerminalNotifHistory'); } catch (_) {}
  app.settings.alertOff = { entry: true };
  app._fireAlert('📐 費波納契回撤買點', '微星(2377) 回撤到 0.618', '2377');
  const hist = app._getNotifHistory().filter(x => String(x.title).includes('費波納契'));
  const banner = document.querySelectorAll('div[data-alert-toast]').length;
  app.settings.alertOff = {};
  return { n: hist.length, banner };
});
ok(h.n === 1, '④ 被勾掉的那一則仍然收進 🔔 通知歷史(⛔ 不會不見)', `找到 ${h.n} 筆`);
ok(h.banner === 0, '④b 但⛔ 不跳橫幅(真的不打擾)');

// ⑤ 沒被關掉的要真的跳橫幅,而且是**新樣式**(⛔ 不是舊的置中小方塊)
const s5 = await pg.evaluate(() => {
  document.querySelectorAll('div[data-toast]').forEach(e => e.remove());
  app.settings.alertOff = {};
  app._fireAlert('📐 費波納契回撤買點', '微星(2377) 回撤到 0.618 黃金分割 147.54 附近收紅止穩', '2377');
  const el = document.querySelector('div[data-alert-toast]');
  if (!el) return { has: 0 };
  const cs = getComputedStyle(el);
  return { has: 1, align: cs.textAlign, w: el.getBoundingClientRect().width, click: typeof el.onclick === 'function' };
});
ok(s5.has === 1, '⑤ 沒被關掉的照樣跳出來');
ok(s5.align === 'left', '⑤b 新樣式:一般通知是**左對齊**(⛔ 舊的是置中小方塊)', `textAlign=${s5.align}`);
ok(s5.w > 280, '⑤c 新樣式:整條橫幅(⛔ 不是 max-w-xs 的小方塊)', `寬 ${Math.round(s5.w)}px`);
ok(s5.click === true, '⑤d 點了要跳到那一檔');

// ⑥ 原始碼守門:`_fireAlert` 真的接上了,而且**記歷史排在守門之前**(陷阱 #37 + ④)
const CODE = readFileSync('index.html', 'utf8');
const fa = CODE.slice(CODE.indexOf('    _fireAlert(title, body, sym) {'));
const body6 = fa.slice(0, fa.indexOf('\n    _recordNotifHistory('));
const iHist = body6.indexOf('_recordNotifHistory(title');
const iGate = body6.indexOf('_alertCatOn(title)');
ok(iGate > 0, '⑥ `_fireAlert` 裡真的呼叫了 `_alertCatOn`(⛔ 光有總表沒接 = 規則只活在文件裡)');
ok(iHist > 0 && iHist < iGate, '⑥b 記通知歷史必須排在守門**之前**(⛔ 排後面 = 被關掉的那一則真的消失)');

// ⑦ 設定中心的清單由總表產生,⛔ 不另寫死一份
const ui = await pg.evaluate(() => {
  app._renderAlertCatList();
  const el = document.getElementById('alertCatList');
  return { rows: el.querySelectorAll('label').length, lock: el.querySelectorAll('input[disabled]').length, n: app._ALERT_CATS.length };
});
ok(ui.rows === ui.n, '⑦ 設定清單列數 == 總表筆數(⛔ 不可寫死第二份)', `${ui.rows}/${ui.n}`);
ok(ui.lock === 2, '⑦b 鎖住的剛好兩類(部位 / 到價)', `${ui.lock} 個`);

await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ ALERTCAT_PASS(全部通過)');
process.exit(bad ? 1 : 0);
