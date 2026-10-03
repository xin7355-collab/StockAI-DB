#!/usr/bin/env node
// 🧪 V77.6.7 總覽 / 決策台「講的話要跟回測一致」的守門(使用者:「用最好用的策略在總覽那邊看看有沒有講錯」)
//
// ① 量卡在哪些價位:現價落在那一段裡面時 ⛔ 不可標「在你上面」(實例 2330:2211~2505 包住 2380,舊版寫「−0.9% 在你上面」)
// ② 「不挑 🧬 會少賺多少」⛔ 不寫死,讀 `_DECK_TRACK49.rob`(舊文案寫死「少賺一半以上」)
// ③ 閒錢停 0050 的數字要跟重跑的 17 條配對一致(🚨 原本 16 年寫 864 萬 / 4 年寫 445 萬,兩個都是記錯的)
// ④ 決策台必須講 16 年那一句(這套輸 0050 含息),數字讀 `_BEAR_GATE_EDGE.long`
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m, d = '') => { console.log((c ? '✅ ' : '❌ ') + m + (d ? ' — ' + d : '')); if (!c) fail++; };
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = name => {
  const m = new RegExp('\\n    ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n    \\},').exec(src);
  if (!m) throw new Error('index.html 找不到 ' + name);
  return m[0].trim().replace(/,$/, '');
};
const lit = name => { const m = new RegExp('\\n    ' + name + ':\\s*(\\{[\\s\\S]*?\\n    \\}),').exec(src); return m ? new Function('return (' + m[1] + ')')() : null; };

// ①
const A = new Function('return ({' + grab('_volStuckBands') + '})')();
A._volProfile = () => ({});
A._volLayers = () => [{ lo: 2211, hi: 2505, mid: 2358, pct: 77 }, { lo: 1770, hi: 1788, mid: 1779, pct: 3 }, { lo: 2600, hi: 2650, mid: 2625, pct: 2 }];
const B = A._volStuckBands([], 0, 2380);
const at = lo => B.find(z => z.lo === lo);
ok(at(2211).inside === true && at(2211).below === false, '① 包住現價的那一段標 inside(⛔ 不是上面也不是下面)', JSON.stringify(at(2211)));
ok(at(1770).below === true && !at(1770).inside, '①b 整段在下面 → below');
ok(!at(2600).below && !at(2600).inside, '①c 整段在上面 → 兩個都 false');
const view = src.slice(src.indexOf('const stuckHtml = stk.length'), src.indexOf('const stuckHtml = stk.length') + 1600);
ok(/z\.inside \? '\(現價就在這一段裡\)'/.test(view), '①d 畫面上 inside 要寫「現價就在這一段裡」(⛔ 不可落到「在你上面」)');

// ②
const G = new Function('return ({' + grab('_geneGapTxt') + '})')();
G._DECK_TRACK49 = { rob: { paths: 17, med: 409, pmed: 167 } };
const t1 = G._geneGapTxt();
G._DECK_TRACK49 = { rob: { paths: 17, med: 400, pmed: 300 } };
const t2 = G._geneGapTxt();
// 🧹 V78.3.4 散戶 App ⛔ 不印回測數字 → 改釘「換了 rob 畫面也不會冒出數字」
ok(!/409|59%|25%|萬/.test(t1 + t2) && /只買 🧬/.test(t1), '② 🧹 不挑 🧬 那句⛔ 不印回測數字(換 rob 也一樣)', t1 + ' | ' + t2);
ok(!/少賺一半以上/.test(src), '②b ⛔ 寫死的「少賺一半以上」不可再出現');

// ③
const I = lit('_IDLE0050_EDGE');
// 🔁 V77.7.6 換預設後重跑(修好的日 K):釘**用意**(⛔ 不釘某一輪的值)—— 4 年那組一定要有配對勝場與回撤;16 年沒重跑就是 null,而畫面必須說出來
const idleFn = src.slice(src.indexOf('_idle0050NoteHtml() {'), src.indexOf('_idle0050NoteHtml() {') + 1600);
ok(!!I && I.main && I.main.on > 0 && I.main.off > 0 && I.main.wins >= 0 && I.main.wins <= I.main.paths && I.main.onDD > 0 && (I.long === null || (I.long.on > 0 && I.long.wins >= 0))
   && (I.long !== null || /還沒重跑/.test(idleFn)),
   '③ 閒錢停 0050:4 年有中位 / 配對勝場 / 回撤;16 年沒重跑時畫面要明說', I ? JSON.stringify({ m: [I.main.on, I.main.wins], l: I.long && [I.long.on, I.long.wins] }) : 'null');
ok(!/on: 864|on: 445/.test(src), '③b ⛔ 記錯的 864 / 445 不可再出現在常數裡');

// ④
const L = (lit('_BEAR_GATE_EDGE') || {}).long;
ok(!!(L && L.etfTr > L.on), '④ `_BEAR_GATE_EDGE.long` 有 0050 含息對照,而且它比這套多(16 年輸 0050 含息 = 事實)', L ? `${L.on} vs ${L.etfTr}` : 'null');
// 🧹 V78.3.4 「這套做法實測賺多少」整塊搬到產業作戰室 → 散戶 App 決策台⛔ 不再有那一塊
ok(src.indexOf('要打幾個折') < 0 && !/16 年來看這套輸 0050 含息/.test(src), '④b 🧹 決策台⛔ 不再有「打折 / 輸 0050 含息」那一塊(在產業作戰室)');

// ⑤ 🧹 V78.3.4 決策台「看錯要不要先跑」七問(_cutlossFaqHtml)整支刪除(它是研究對照,搬到產業作戰室)。
//   ⚠️ 舊版這一段的 ok() 參數順序寫反了(ok(名稱, 條件))→ 名稱字串恆為 truthy,七條一直是假綠燈。
ok(!/_cutlossFaqHtml/.test(src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), '⑤ 🧹 `_cutlossFaqHtml` 已刪除、⛔ 沒有任何地方再呼叫');

console.log(fail ? `\n❌ OVTRUTH_FAIL(${fail})` : '\n✅ OVTRUTH_PASS(全部通過)');
process.exit(fail ? 1 : 0);
