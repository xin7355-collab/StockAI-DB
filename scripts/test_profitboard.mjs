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
  try { await PRO.switchTab('calc'); } catch (_) {}
  PRO._labSel = 'bt'; PRO._pfSort = null; PRO._pbWin = 'ai'; PRO.renderLab();
  const box = () => document.getElementById('profitBody'), o = {};
  o.txt = box().innerText;
  o.firstRow = (box().querySelector('#pbTbl tbody tr td') || {}).innerText || '';
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
  o.lateLast = (() => { const k = rows.findIndex(t => /上市晚於/.test(t)); return k < 0 || rows.slice(k).every(t => /上市晚於/.test(t)); })();
  PRO.pbTab('long'); o.long = box().innerText; o.longRows = box().querySelectorAll('#pbTbl tbody tr').length;
  PRO.pbTab('small'); o.small = box().innerText;
  PRO.pbSet('Cap', 1e6); PRO.pbSet('Add', 10000); o.small2 = box().innerText; PRO.pbSet('Cap', 1e5); PRO.pbSet('Add', 0);
  PRO.pbTab('ai');
  o.sx = (window.scrollTo(80, 0), window.scrollX);
  { const t = document.getElementById('pbTbl'); o.fit = t.scrollWidth - t.parentElement.clientWidth; }
  o.research = !!document.querySelector('#btResearch #yearlyBody') && !!document.querySelector('#btResearch #calcOld');
  o.researchClosed = !document.getElementById('btResearch').open;
  return o;
});
ok('② 畫面有 👑 / 0050 / 科技 ETF 各列', /領頭羊/.test(R.txt) && /0050 元大台灣50/.test(R.txt) && /00892/.test(R.txt));
ok('②b ⭐ 決定性對照:改 `_PROFIT_BOARD` 一格,畫面跟著變', R.inj);
ok('②c 表頭每一欄都可排序(做法 / 變成 / 最差 / 中途最多賠 / 贏 0050)', JSON.stringify(R.hdr) === JSON.stringify(['n', 'fin', 'worst', 'mdd', 'beat']), JSON.stringify(R.hdr));
ok('②d 排序再點反向、有 ▼/▲、第一列換人', R.sort.f1 !== R.sort.f2 && /[▼▲]/.test(R.sort.a1) && /[▼▲]/.test(R.sort.a2) && R.sort.a1 !== R.sort.a2, JSON.stringify(R.sort));
ok('②d2 🐛 點過表頭之後 `_pbSort` 仍是函式(⛔ 排序狀態不可跟股票清單排序同名)', R.pbFn);
ok('②e 預設照「100 萬變成」由大到小,第一列是 👑', /👑/.test(R.firstRow), R.firstRow);
ok('②f 上市太晚的 ETF 排最後、寫「上市晚於」', R.lateLast && /上市晚於/.test(R.long) && R.longRows >= 10);
ok('③ ⛔「中途最多賠」那一欄在,一句話結論寫代價', /中途\s*最多賠/.test(R.txt) && /代價/.test(R.txt) && /運氣最差的那個起點/.test(R.txt));
ok('③b 科技 / 半導體 ETF 要寫「事後才知道的產業押注」', /事後才知道/.test(R.txt));
ok('③c 口徑寫清楚(同一組起點 / 含息 / 已扣手續費和稅 / 倖存者偏誤)', /同一組 17 個起點/.test(R.txt) && /含息/.test(R.txt) && /已扣手續費和稅/.test(R.txt) && /倖存者偏誤/.test(R.txt));
ok('④ 小資金:同樣的錢買 0050 那一列 + 三件事(錢少不會變差 / 每月投入 / 先衝再穩)', /同樣的錢/.test(R.small) && /錢少不會讓報酬率變差/.test(R.small) && /每個月繼續放錢/.test(R.small) && /先衝再穩/.test(R.small));
ok('④b ⛔ 要明寫「錢少不代表可以冒更大的險」', /錢少\s*⛔?\s*不代表可以冒更大的險/.test(R.small));
ok('④c 切到 100 萬 + 每月 1 萬 → 投入總額跟著變(147 萬)', /總共投入 147 萬/.test(R.small2), R.small2.slice(0, 200));
ok('⑤ 舊的逐年總表 + 情境庫仍在,收進「研究用」摺疊(預設關)', R.research && R.researchClosed);
ok('⑤b 390px 不橫捲,而且 5 欄一眼看得完(表格不超出外框)', R.sx <= 2 && R.fit <= 2, `${R.sx} / ${R.fit}`);
ok('⑤c ⛔ 無 🔴🟢', !/[🔴🟢]/u.test(R.txt + R.long + R.small));
ok('⑤d 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ PROFITBOARD_PASS');
process.exit(fails.length ? 1 : 0);
