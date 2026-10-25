// 💰 V77.9.4 回測數字頁最上面「100 萬放進去變多少」守門(pro.html `_PROFIT_BOARD` + renderProfit)
//   使用者:「使用者只想看到獲利而已」「0050 以外其他 ETF 也做進來」「錢不多能不能先快速累積」
//   ⛔ 這支釘的用意:
//     ① 嵌入:兩個窗口 + 小資金;每列同一組起點(17 條);0050 在策略那邊與 ETF 那邊是**同一個數字**
//     ② 畫面:數字讀常數(決定性對照:改一格畫面跟著變)・表頭每一欄可排序、再點反向・上市太晚的排最後寫原因
//     ③ ⛔「中途最多賠」那一欄不可拿掉;一句話結論要寫代價;科技 ETF 要寫「事後才知道」
//     ④ 小資金:三個起始金額 × 有沒有每月加碼都有;結論三件事從表裡讀;⛔ 不可暗示錢少可以冒更大的險
//     ⑤ 舊的逐年總表 + 情境庫仍在(收進「研究用」摺疊,⛔ 沒刪)・390px 不橫捲・無 pageerror・⛔ 無 🔴🟢
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

const line = PRO.split('\n').find(l => /^  _PROFIT_BOARD: \{/.test(l)) || '';
let B = null; try { B = JSON.parse(line.replace(/^  _PROFIT_BOARD: /, '').replace(/,$/, '')); } catch (_) {}
ok('① 🚧 空過守門:讀得到 `_PROFIT_BOARD`', !!(B && B.wins && B.wins.ai && B.wins.long && B.small), line.slice(0, 80));
if (!B) process.exit(1);
ok('①b 產生者註明是 embed_profit_board.mjs(⛔ 手改)', /embed_profit_board\.mjs/.test(PRO.slice(PRO.indexOf(line) - 300, PRO.indexOf(line))));
for (const w of ['ai', 'long']) {
  const R = B.wins[w].rows, e = R.find(r => r.k === '0050'), L = R.filter(r => r.grp === 'lead');
  ok(`①c ${w}:👑 四種做法 + 💵 錢放現金對照(V78.1.9)+ 0050,每一列有 100 萬變成 / 最差 / 中途最多賠`, L.length === 5 && L.some(r => r.k === 'leadcash') && e && !e.late && R.filter(r => !r.late).every(r => r.fin > 0 && r.worst > 0 && r.worst <= r.fin && r.mdd < 0), JSON.stringify(L.map(r => r.k)));
  ok(`①d ${w}:👑 贏 0050 的起點數 ≤ ${B.paths}`, L.every(r => r.beat >= 0 && r.beat <= B.paths));
}
ok('①e 16 年那一格:上市晚於 2011 的 ETF 標 late(⛔ 不硬比)', B.wins.long.rows.filter(r => r.grp === 'etf' && r.k !== '0050').every(r => r.late));
ok('①f 小資金 2 窗口 × 3 金額 × 2 加碼 × 3 打法 = 各 18 組,而且有「同樣的錢買 0050」', ['ai', 'long'].every(w => B.small[w].rows.length === 18 && B.small[w].rows.every(r => r.b0050 > 0 && r.contrib > 0)));
const sm = B.small.ai.rows.find(r => r.cap === 1e6 && !r.add && r.mode === 'lead'), mn = B.wins.ai.rows.find(r => r.k === 'lead');
ok('①g 同一把尺:小資金 100 萬全攻 ≈ 主表 👑 全攻(±1%)', Math.abs(sm.fin - mn.fin) / mn.fin < 0.01, `${sm.fin} vs ${mn.fin}`);

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });   // 🎯 V77.9.6 這支測的是 👑 那一套 → 先切成 👑(🧬 預設另由 test_stratswitch 測)
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderProfit, null, { timeout: 30000 });
const R = await page.evaluate(async () => {
  // 💰 V79.8.0 「100 萬放進去變多少」看板只留一份:🔬 研究 › 🏆 選哪一套 最下面的「📋 完整表」(#pkFull)
  try { await PRO.switchTab('pick'); } catch (_) {}
  PRO._labSel = 'pick'; PRO._pfSort = null; PRO._pbWin = 'ai'; PRO.renderLab();
  { const pf = document.getElementById('pkFull'); if (pf) pf.open = true; }
  const box = () => document.getElementById('profitBody'), o = {};
  o.txt = box().innerText;
  o.firstRow = (box().querySelector('#pbTbl tbody tr td') || {}).innerText || '';
  o.finCol = [...box().querySelectorAll('#pbTbl tbody tr')].map(tr => ((tr.children[1] || {}).innerText || '').replace(/[^\d]/g, '')).filter(x => x).map(Number);
  o.hdr = [...box().querySelectorAll('#pbTbl th.ybsort')].map(th => (th.getAttribute('onclick').match(/'(\w+)'/) || [])[1]);
  // 決定性對照:改常數
  const L = PRO._PROFIT_BOARD.wins.ai.rows.find(r => r.k === 'lead'), keep = L.fin; L.fin = 12345678; PRO.renderProfit();
  o.inj = box().innerText.includes('1,235 萬'); L.fin = keep; PRO.renderProfit();
  // 排序:照中途最多賠由小到大 → 第一列回撤最小;再點反向
  PRO.pbSortBy('mdd'); const f1 = box().querySelector('#pbTbl tbody tr td').innerText, a1 = box().querySelector('#pbTbl th.ybsort.on').innerText;
  PRO.pbSortBy('mdd'); const f2 = box().querySelector('#pbTbl tbody tr td').innerText, a2 = box().querySelector('#pbTbl th.ybsort.on').innerText;
  o.sort = { f1, f2, a1, a2 }; PRO._pfSort = null;
  o.pbFn = typeof PRO._pbSort === 'function';   // 🐛 V78.0.7 排序狀態以前也叫 _pbSort → 點表頭就把股票清單排序函式蓋掉
  const rows = [...box().querySelectorAll('#pbTbl tbody tr')].map(tr => tr.innerText);
  o.cagrRows = [...box().querySelectorAll('#pbTbl tbody tr')].map(tr => ({ t: tr.innerText, m: (tr.querySelector('[data-pfcagr]') || {}).innerText || '' }));
  o.lateLast = (() => { const k = rows.findIndex(t => /上市晚於/.test(t)); return k < 0 || rows.slice(k).every(t => /上市晚於/.test(t)); })();
  PRO.pbTab('long'); o.long = box().innerText; o.longRows = box().querySelectorAll('#pbTbl tbody tr').length;
  PRO._pbSW = 'ai'; PRO.pbTab('small'); o.small = box().innerText;   // 📅 V79.6.2 小資金預設改 16 年 → 這幾條驗的是最近 4 年那張(147 萬)
  o.smallCagr = [...box().querySelectorAll('#pbSmallTbl [data-pfcagr]')].length;
  PRO.pbSet('Cap', 1e6); PRO.pbSet('Add', 10000); o.small2 = box().innerText; o.small2Cagr = [...box().querySelectorAll('#pbSmallTbl [data-pfcagr]')].length; PRO.pbSet('Cap', 1e5); PRO.pbSet('Add', 0);
  // 📅 V79.6.2 預設頁籤 = 16 年(主數字);頁籤與標題寫起訖日期(讀看板),⛔「到今天」
  PRO._pbWin = null; PRO._pbSW = null; PRO.renderProfit();
  o.defTab = (box().querySelector('.ybchips button.on') || {}).innerText || '';
  o.tabs = [...box().querySelectorAll('.ybchips button')].map(b => b.innerText);
  o.defTxt = box().innerText;
  { const W = PRO._PROFIT_BOARD.wins.long, keepF = W.from; W.from = '2012-02-01'; PRO.renderProfit(); o.injTab = [...box().querySelectorAll('.ybchips button')].map(b => b.innerText).join(' '); W.from = keepF; PRO.renderProfit(); }
  PRO.pbTab('ai');
  o.sx = (window.scrollTo(80, 0), window.scrollX);
  { const t = document.getElementById('pbTbl'); o.fit = t.scrollWidth - t.parentElement.clientWidth; }
  o.research = !!document.querySelector('#btResearch #yearlyBody') && !!document.querySelector('#btResearch #calcOld');
  o.researchClosed = !document.getElementById('btResearch').open;
  // ⑥ V79.8.0 只留一份:回測數字頁⛔ 再印看板,改一行連到選哪一套
  PRO.selLab('bt'); o.btPf = box().innerText; o.btGo = !!document.querySelector('#labIntro [data-labbtgo]');
  o.btGoTxt = (document.querySelector('#labIntro [data-labbtgo]') || {}).innerText || '';
  return o;
});
ok('⑥ 💰 看板只留一份:回測數字頁⛔ 再印第二份、改一行連到「選哪一套」', R.btPf.trim() === '' && R.btGo && /選哪一套/.test(R.btGoTxt), JSON.stringify([R.btPf.slice(0, 40), R.btGoTxt]));
ok('② 畫面有 👑 / 0050 / 科技 ETF 各列', /領頭羊/.test(R.txt) && /0050 元大台灣50/.test(R.txt) && /00892/.test(R.txt));
ok('②b ⭐ 決定性對照:改 `_PROFIT_BOARD` 一格,畫面跟著變', R.inj);
ok('②c 表頭每一欄都可排序(做法 / 變成 / 最差 / 中途最多賠 / 贏 0050)', JSON.stringify(R.hdr) === JSON.stringify(['n', 'fin', 'worst', 'mdd', 'beat']), JSON.stringify(R.hdr));
ok('②d 排序再點反向、有 ▼/▲、第一列換人', R.sort.f1 !== R.sort.f2 && /[▼▲]/.test(R.sort.a1) && /[▼▲]/.test(R.sort.a2) && R.sort.a1 !== R.sort.a2, JSON.stringify(R.sort));
ok('②d2 🐛 點過表頭之後 `_pbSort` 仍是函式(⛔ 排序狀態不可跟股票清單排序同名)', R.pbFn);
ok('②e 預設照「100 萬變成」由大到小(第一列 = 變成最多的那一套,⛔ 不釘是哪一套 —— V79.2.4 修尺後近 4 年第一名換人)', R.finCol.length >= 10 && R.finCol.every((v, i) => i === 0 || v <= R.finCol[i - 1]), JSON.stringify(R.finCol.slice(0, 6)) + ' ' + R.firstRow);
ok('②f 上市太晚的 ETF 排最後、寫「上市晚於」', R.lateLast && /上市晚於/.test(R.long) && R.longRows >= 10);
ok('③ ⛔「中途最多賠」那一欄在,一句話結論寫代價', /中途\s*最多賠/.test(R.txt) && /代價/.test(R.txt) && /運氣最差的那個起點/.test(R.txt));
ok('③b 科技 / 半導體 ETF 要寫「事後才知道的產業押注」', /事後才知道/.test(R.txt));
ok('③c 口徑寫清楚(同一組起點 / 含息 / 已扣手續費和稅 / 倖存者偏誤)', /同一組 17 個起點/.test(R.txt) && /含息/.test(R.txt) && /已扣手續費和稅/.test(R.txt) && /倖存者偏誤/.test(R.txt));
ok('④ 小資金:同樣的錢買 0050 那一列 + 三件事(錢少不會變差 / 每月投入 / 先衝再穩)', /同樣的錢/.test(R.small) && /錢少不會讓報酬率變差/.test(R.small) && /每個月繼續放錢/.test(R.small) && /先衝再穩/.test(R.small));
ok('④b ⛔ 要明寫「錢少不代表可以冒更大的險」', /錢少\s*⛔?\s*不代表可以冒更大的險/.test(R.small));
ok('④c 切到 100 萬 + 每月 1 萬 → 投入總額跟著變(147 萬)', /總共投入 147 萬/.test(R.small2), R.small2.slice(0, 200));
// 📅 V79.1.8 每月報酬:每一列(沒上市太晚的)都有每年 / 每月,== 獨立重算;小資金「每月再投」那組⛔ 不換算
{
  const cg = fin => { const y = (Date.parse(B.to) - Date.parse(B.wins.ai.from)) / (365.25 * 864e5), r = Math.pow(fin / 1e6, 1 / y) - 1; return (Math.pow(1 + r, 1 / 12) - 1) * 100; };
  const fx = v => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1) + '%';
  const live = R.cagrRows.filter(r => !/上市晚於/.test(r.t));
  const bad = B.wins.ai.rows.filter(r => !r.late).filter(r => !live.some(x => x.m.includes(`每月 ${fx(cg(r.fin))}`)));
  ok('④d 📅 回測數字每一列都有「每年 / 每月」,每月 == 獨立重算', live.length >= 10 && live.every(r => /每年 [+−]\d/.test(r.m) && /每月 [+−]\d/.test(r.m)) && !bad.length, JSON.stringify(bad.map(r => r.k)));
  ok('④e 小資金:不加錢時每列有每月;選「每月再投」⛔ 不換算', R.smallCagr >= 4 && R.small2Cagr === 0, `${R.smallCagr} / ${R.small2Cagr}`);
}
{
  const ymd = d => d.slice(0, 4) + '/' + d.slice(5, 7);
  ok('④f 📅 預設頁籤是 16 年,頁籤寫起訖(讀看板)、16 年在前', /16 年/.test(R.defTab) && R.defTab.includes(ymd(B.wins.long.from)) && R.tabs[0].includes('16 年') && R.tabs.some(t => /最近 4 年/.test(t) && t.includes(ymd(B.wins.ai.from))), JSON.stringify(R.tabs) + ' / ' + R.defTab);
  ok('④g 📅 標題寫「放到 YYYY/MM/DD」,⛔「到今天」(資料只算到看板的 to)', R.defTxt.includes('放到 ' + B.to.replace(/-/g, '/')) && !/到今天變多少/.test(R.defTxt + R.txt), (R.defTxt.match(/100 萬放進去.{0,30}/) || [])[0]);
  ok('④h ⭐ 決定性對照:改看板 16 年起點 → 頁籤日期跟著變', R.injTab.includes('2012/02'), R.injTab);
  ok('④i 口徑寫明「含已下市」(⛔ 舊的「現在還在交易的股票」講反了)', /含已下市/.test(R.defTxt) && !/用的是現在還在交易的股票/.test(R.defTxt), (R.defTxt.match(/倖存者.{0,30}/) || [])[0]);
}
ok('⑤ 舊的逐年總表 + 情境庫仍在,收進「研究用」摺疊(預設關)', R.research && R.researchClosed);
ok('⑤b 390px 不橫捲,而且 5 欄一眼看得完(表格不超出外框)', R.sx <= 2 && R.fit <= 2, `${R.sx} / ${R.fit}`);
ok('⑤c ⛔ 無 🔴🟢', !/[🔴🟢]/u.test(R.txt + R.long + R.small));
ok('⑤d 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ PROFITBOARD_PASS');
process.exit(fails.length ? 1 : 0);
