// 🌳 V77.2.3 報告頁「視角切換」(⚡ 短中線 / 🌳 長線)
//   使用者:「我的報告是短中線的嗎?想新增長線,還是這樣子文字已經太長了」。
//
// ⛔ 五條不可違反(注入任何一條都要叫得出來):
//   ① ⛔ **不新增任何數字** —— 長線那一段全部轉述 `_rpLast` 既有欄位。
//      測試法:同一份 ctx 下,把來源欄位改掉,畫面上那個數字**必須跟著變**
//      (⛔ 只驗「有沒有那串字」的話,寫死一個數字照樣會過 = 假綠燈)。
//   ② ⛔ **長線這一句永遠不給買賣指令** —— 本站沒有任何回測過的長線進場規則,
//      而坊間那兩條(本益比低就買 / 越跌越買)本站實測**方向相反**。
//   ③ 🚨 那兩條實測結論**不可省** —— 少了它,這一段就變成在幫坊間說法背書。
//   ④ 位階必須跟 §14 同一支 `_rpPeRank`(⛔ 不可自己再算一份 = 同一頁兩個位階)。
//   ⑤ 切換⛔ 不可改變任何數字,只換「先看哪幾節」。
//
// ⚠️ **注入驗證的誠實紀錄**(6 種,5 種叫得出來):
//   ・拿掉兩條實測結論 → ④/④b/④d 紅 ✅
//   ・ROE 改成寫死 → ①c 紅 ✅   ・拿掉殖利率 0 守門 → ②c 紅 ✅
//   ・長線那一句在短中線也顯示 → ⑥f 紅 ✅(🚨 第一次注入因為 shell 引號**根本沒注進去**,
//     先 grep 確認才發現 —— ⛔「沒變紅」不等於「測試有洞」)
//   ・偷加「可以分批布局」→ ④c 紅 ✅
//   ・`_rpApplyView` 改回「只開不關」→ **叫不出來,而那是對的**:
//     `setRpView` 每次都完整重繪,重繪後所有 details 回到預設 → 那一半目前不 load-bearing。
//     ⛔ 沒有為此放寬任何斷言(CLAUDE.md:兩種合法解釋都不可以用放寬處理)。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };

// 🚧 空過守門:測資是**真實產物**(⛔ 不憑印象編 —— 陷阱 #40)
for (const f of ['data/fin/2327.json', 'data/pe_band.json', 'data/2327.json']) {
  if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }
}
const FIN = JSON.parse(readFileSync('data/fin/2327.json', 'utf8'));
const BAND = JSON.parse(readFileSync('data/pe_band.json', 'utf8')).data['2327'];
const K = JSON.parse(readFileSync('data/2327.json', 'utf8'));
ok(Number.isFinite(+FIN.roe4) && Number.isFinite(+BAND.pct) && K.length > 300,
  '⓪ 空過守門:測資有 roe4 / pe_band.pct / 300+ 根 K 線', `roe4=${FIN.roe4} pct=${BAND.pct} k=${K.length}`);

const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const pg = await (await b.newContext()).newPage();
await pg.goto(pathToFileURL(resolve('index.html')).href);
await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._rpLongHtml, null, { timeout: 30000 });
await pg.waitForTimeout(3000);

const seed = { fin: FIN, band: BAND };
const render = (over = {}) => pg.evaluate(({ fin, band, over }) => {
  app._rpLast = Object.assign({ sym: '2327', pC: 536, pe: 36.16, yld: 1.12, band,
    ae: { eps: 14.88, src: '近4季EPS' }, cyc: true, fin, isEtf: false }, over);
  const d = document.createElement('div'); d.innerHTML = app._rpLongHtml();
  return d.innerText.replace(/\s+/g, ' ');
}, { ...seed, over });

const base = await render();

// ① 數字真的來自 ctx(⛔ 不是寫死)—— 改來源,畫面必須跟著變
ok(base.includes('17.2%'), '① ROE 近4季 讀自 data/fin 的 roe4', 'ROE 17.2%');
ok(base.includes('288.9 億'), '①b 自由現金流近4季 讀自 fcf4', '288.9 億');
const mut = await render({ fin: { ...FIN, roe4: 3.3, fcf4: -1.2e8 } });
ok(mut.includes('3.3%') && mut.includes('-1.2 億') && !mut.includes('17.2%'),
  '①c ⭐ 決定性對照:改掉 roe4/fcf4,畫面必須跟著變(⛔ 寫死就會紅)');
ok(mut.includes('其中有負數'), '①d 自由現金流是負的要主動說出來');

// ②「買在哪個位置」與 §14 同一支 `_rpPeRank`(⛔ 不可同一頁兩個位階)
const rk = await pg.evaluate(({ band }) => app._rpPeRank(536 / 14.88, band), seed);
ok(base.includes(`第 ${rk} 百分位`), '② 位階跟 §14 用同一支 `_rpPeRank`(⛔ 不自己再算一份)', `第 ${rk} 百分位`);
ok(base.includes('1.12%'), '②b 殖利率讀自 ctx.yld');
const y0 = await render({ yld: 0 });
ok(!y0.includes('0.00%'), '②c 🚨 殖利率 0 = **沒有資料**,⛔ 不可印成「0.00%」(那會被讀成不配息)');

// ③ 循環股那行只在 cyc 時出現
ok(base.includes('循環股'), '③ 循環股警語(位階要反著讀)');
ok(!(await render({ cyc: false })).includes('循環股'), '③b cyc=false ⛔ 不顯示');

// ④ 🚨 兩條實測結論不可省,而且⛔ 不可出現買賣指令
ok(/單調反向/.test(base), '④ 實測①「本益比低就買」是單調反向 —— ⛔ 不可省');
ok(/擇時.*少賺|少賺.*擇時/.test(base), '④b 實測②「越跌越買/擇時」全部少賺 —— ⛔ 不可省');
const CMD = /(可以買|可以進場|建議買進|分批布局|逢低買|越跌越買(?!\s*\/)|該買|值得買|好買點)/;
const cmdHit = base.replace(/「[^」]*」/g, '').match(CMD);   // ⛔ 引號裡是「坊間說法」的引述,不算指令
ok(!cmdHit, '④c ⛔ 長線這一段**不給買賣指令**(本站沒有回測過的長線進場規則)', cmdHit ? `出現「${cmdHit[0]}」` : '');
ok(/不回答「該不該買」/.test(base), '④d 而且要**明說**它不回答該不該買');

// ⑤ 誠實講缺什麼(陷阱 #22:不講原因 = 沒講)
ok(/近 3 年/.test(base) && /負債比/.test(base) && /配息率/.test(base), '⑤ 誠實列出長線還缺的三樣');

// ⑥ 切換:⛔ 只換攤開哪幾節,數字一個都不動
const sw = await pg.evaluate(async (k) => {
  app.currentSymbolId = '2327'; app.rawDailyData = k; app.activeData = k; app.baseRawData = k;
  app.switchSubTab('report');
  const snap = async (v) => {
    app.settings = app.settings || {}; app.settings.rpView = v;
    await app.renderReportTab('2327'); app._rpApplyView();
    await new Promise(r => setTimeout(r, 250));
    const box = document.getElementById('subContentReport');
    const ds = [...box.querySelectorAll('details[data-dk]')];
    // 🚨 V77.2.3 **⛔ 不可用 `innerText` 量第一眼** —— 兩個理由(都踩過):
    //   ① 這一頁在測試環境是 `display:none`,而 `innerText` 對 display:none 的元素
    //      **照樣回傳全文**(CLAUDE.md 既有陷阱)→ 開幾節都量到同一個數字(實測 6,717 一字不差)。
    //   ② 就算看得見,關起來的 `<details>` 也量不準(V76.0.1 `card_inventory` 同型)。
    //   ⭐ 改成**結構性計算**:整頁文字扣掉「收起來的 `<details>` 內文」= 真正的第一眼。
    const clone = box.cloneNode(true);
    for (const d of clone.querySelectorAll('details[data-dk]')) {
        if (d.open) continue;
        for (const c of [...d.children]) if (c.tagName !== 'SUMMARY') c.remove();   // 收起來的只留 summary
    }
    const firstEye = (clone.textContent || '').replace(/\s+/g, '').length;
    return { open: ds.filter(d => d.open).map(d => d.dataset.dk).sort(),
             nums: ((box.textContent || '').match(/-?\d[\d,]*\.?\d*/g) || []).join('|'),
             len: firstEye, bar: (document.getElementById('rpView')?.textContent || '') };
  };
  const s = await snap('short'), l = await snap('long');
  app.settings.rpView = 'short';
  return { s, l };
}, K);
ok(sw.s.open.join() !== sw.l.open.join(), '⑥ 切換真的換掉「先看哪幾節」',
  `短中線[${sw.s.open.join(' ')}] vs 長線[${sw.l.open.join(' ')}]`);
ok(/§11|§16|§17|價格卡在哪/.test(sw.s.open.join()), '⑥b 短中線攤開「價格卡在哪」');
ok(/§14|§15|估值/.test(sw.l.open.join()) || /§4~§6|賺不賺錢/.test(sw.l.open.join()), '⑥c 長線攤開「估值 / 基本面」');
ok(sw.s.bar.includes('短中線') && sw.s.bar.includes('長線'), '⑥d 兩個視角都要看得到(⛔ 不可藏起來)');
ok(sw.l.bar.includes('長線視角'), '⑥e 切到長線時那一句才出現');
ok(!sw.s.bar.includes('長線視角'), '⑥f 短中線時⛔ 不顯示長線那一句(不然等於又加了一節)');
ok(sw.l.len <= sw.s.len, '⑥g ⭐ 使用者怕「字太長」→ 長線視角字數⛔ 不可比短中線多',
  `短中線 ${sw.s.len} 字 / 長線 ${sw.l.len} 字`);

// ⑦ 原始碼守門:⛔ 不可偷偷接上 `_bearGate`/`_mktGate` 以外的指令,也不可自己算位階
const SRC = readFileSync('index.html', 'utf8');
const fn = SRC.slice(SRC.indexOf('    _rpLongHtml() {'));
const body = fn.slice(0, fn.indexOf('\n    /** 🌳 切完視角'));
// ⚠️ 誠實紀錄:第一版這條斷言是**我自己寫錯的** —— 它把「`_rpPeRank` 算不出來時退回
//   `Math.round(+b.pct)`」當成「自己算了一份」。那個 fallback 跟 §14(`_rpValHtml`)**一模一樣**,
//   是合法的,⛔ 不該擋。正確的用意是:⛔ 不可自己刻一份百分位運算。
ok(/_rpPeRank\(/.test(body), '⑦ `_rpLongHtml` 用 `_rpPeRank`(⛔ 不自己再算一份位階)');
ok(!/\.filter\([^)]*\)\.length\s*\/|\.sort\(\([^)]*\)\s*=>/.test(body),
  '⑦a ⛔ 函式裡沒有自刻的百分位運算(排序 / 數個數再除)');
ok(!/_detect\w+\(|_calcBullBearScan\(|_patternFitBacktest\(/.test(body),
  '⑦b ⛔ 不可在長線那一段自己跑偵測器(那會變成第二份真相)');

await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ RPVIEW_PASS(全部通過)');
process.exit(bad ? 1 : 0);
