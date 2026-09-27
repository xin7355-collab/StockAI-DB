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
ok(/59%/.test(t1) && /409/.test(t1) && /25%/.test(t2) && t1 !== t2, '② 少賺幾 % 跟著 `rob` 變(⛔ 不寫死)', t1 + ' | ' + t2);
ok(!/少賺一半以上/.test(src), '②b ⛔ 寫死的「少賺一半以上」不可再出現');

// ③
const I = lit('_IDLE0050_EDGE');
ok(!!I && I.long.on === 656 && I.long.wins === 16 && I.main.on === 417 && I.main.wins === 13,
   '③ 閒錢停 0050:4 年 417 萬(13/17)・16 年 656 萬(16/17)', I ? JSON.stringify({ m: [I.main.on, I.main.wins], l: [I.long.on, I.long.wins] }) : 'null');
ok(!/on: 864|on: 445/.test(src), '③b ⛔ 記錯的 864 / 445 不可再出現在常數裡');

// ④
const L = (lit('_BEAR_GATE_EDGE') || {}).long;
ok(!!(L && L.etfTr > L.on), '④ `_BEAR_GATE_EDGE.long` 有 0050 含息對照,而且它比這套多(16 年輸 0050 含息 = 事實)', L ? `${L.on} vs ${L.etfTr}` : 'null');
const deck = src.slice(src.indexOf('要打幾個折'), src.indexOf('要打幾個折') + 2500);
ok(/L\.etfTr/.test(deck) && /16 年來看這套輸 0050 含息/.test(deck), '④b 決策台「打折」那一塊要講 16 年輸 0050 含息,數字讀常數');

// ⑤ V77.6.8 決策台「看錯要不要先跑」:每一句讀常數(⛔ 不寫死),空頭清倉沒跑完要明說
{
  const Q = new Function('return ({' + grab('_cutlossFaqHtml') + '})')();
  Q._EXIT_EDGE = lit('_EXIT_EDGE'); Q._BREAKOUT_EXIT_EDGE = lit('_BREAKOUT_EXIT_EDGE'); Q._BEAR_GATE_EDGE = lit('_BEAR_GATE_EDGE');
  Q._CUTLOSS_FACTS = lit('_CUTLOSS_FACTS'); Q._DISPO_HOLD_EDGE = lit('_DISPO_HOLD_EDGE');
  const pm = /\n    _PROB_TABLE: (\{.*?\}),\n/.exec(src); Q._PROB_TABLE = pm ? JSON.parse(pm[1]) : null;
  const bx = /\n    _BEAR_EXIT_EDGE: (null|\{[\s\S]*?\n    \}),/.exec(src); Q._BEAR_EXIT_EDGE = bx ? new Function('return (' + bx[1] + ')')() : undefined;
  ok('⑤0 空過守門:五份常數都讀得到', !!(Q._EXIT_EDGE && Q._BREAKOUT_EXIT_EDGE && Q._BEAR_GATE_EDGE && Q._CUTLOSS_FACTS && Q._PROB_TABLE && Q._BEAR_EXIT_EDGE !== undefined), '');
  const h = Q._cutlossFaqHtml();
  ok('⑤ FAQ 有七問、講「硬停損就是賠小錢」「太早出場砍掉的是贏家」「30 天以下是懸崖」', (h.match(/❓/g) || []).length === 7 && /賠小錢/.test(h) && /砍掉的是<b>贏家<\/b>/.test(h) && /30 天以下是懸崖/.test(h), h.slice(0, 200));
  const ma5 = Q._EXIT_EDGE.rob.rows.ma5.med;
  ok('⑤b 跌破 5 日線的數字讀 `_EXIT_EDGE.rob`', h.includes(`${ma5} 萬`), '');
  Q._EXIT_EDGE.rob.rows.ma5.med = 7777; ok('⑤c 改常數畫面跟著變(⛔ 不寫死)', Q._cutlossFaqHtml().includes('7777 萬') && !Q._cutlossFaqHtml().includes(`${ma5} 萬`), ''); Q._EXIT_EDGE.rob.rows.ma5.med = ma5;
  const p1 = Q._PROB_TABLE.base[0];
  ok('⑤d 「明天漲/平/跌」讀 `_PROB_TABLE.base[0]`', h.includes(`漲 ${p1[1]}% / 平 ${p1[2]}% / 跌 ${p1[3]}%`), '');
  const saveX = Q._BEAR_EXIT_EDGE; Q._BEAR_EXIT_EDGE = null;
  ok('⑤e 空頭清倉沒跑完 → 明說「正在補這一條回測」、⛔ 不出現任何配對數字', /正在補這一條回測/.test(Q._cutlossFaqHtml()) && !/嚴格空頭那天把手上全賣/.test(Q._cutlossFaqHtml()), '');
  Q._BEAR_EXIT_EDGE = { paths: 17, win: 'W', base: { med: 409, lo: 249, dd: 26.1 }, strict: { med: 111, lo: 22, dd: 33.3, wins: 2 }, ma60: { med: 222, wins: 5 }, verdict: '測試判定丙' };
  ok('⑤f 跑完 → 印 strict/ma60 數字 + 判定', /全賣 <b>111 萬<\/b>/.test(Q._cutlossFaqHtml()) && /贏 <b>2\/17<\/b>/.test(Q._cutlossFaqHtml()) && /222 萬、贏 5\/17/.test(Q._cutlossFaqHtml()) && /測試判定丙/.test(Q._cutlossFaqHtml()), '');
  Q._BEAR_EXIT_EDGE = saveX;
  ok('⑤g 「不要藏私」那一問講 16 年輸 0050 含息、79 種都在表上', /79 種/.test(h) && /16 年沒有任何一種贏 0050 含息/.test(h), '');
  ok('⑤h 決策台有掛 `_cutlossFaqHtml()`', /\$\{this\._cutlossFaqHtml\(\)\}/.test(src), '');
}

console.log(fail ? `\n❌ OVTRUTH_FAIL(${fail})` : '\n✅ OVTRUTH_PASS(全部通過)');
process.exit(fail ? 1 : 0);
