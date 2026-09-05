#!/usr/bin/env node
/**
 * 🕸️ V74.7.3 關聯星圖:「真的同一族」(雙向)+「今天有沒有一起動」
 *
 * 使用者上傳一份 Gemini 的「產業星鏈應用指南」,問「需要區分頁面嗎?給你決定怎麼優化」。
 * ⛔ **不分頁**(星圖是「查一檔 → 看它的族群」的單一任務,分頁只是多點一次;
 *   痛點是**頁內少了什麼**不是分頁數量 —— 同 V72.6.0 的教訓)。
 * ⭐ 改成補兩件那份指南點出來、而且**本站有資料**的事:
 *   ① 🔁 **雙向確認** —— 對方的前 N 名裡也有你才算同族。解決「假分散、真集中」。
 *      實測有鑑別力:3231 是 3/5、2603 是 2/5、**2330 是 0/5**(它像的其實是大盤)。
 *   ② 📈 **今天有沒有一起動** —— 族群共振 vs 單打獨鬥。
 * ⛔ 那份指南教的「找補漲」**本站實測是穩定地差**(逐年全負 −0.40pp)→ 頁面要寫出來。
 * ⛔ 這一頁仍然**不下多空、不給買賣價位**(相關係數是同期的,不能預測)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

ok('⓪ 🔁 雙向確認要抽成自己的函式(⛔ 別 inline 在渲染裡,日後星圖別處也要用)',
   /_starMutual\s*\(sym, rows, J\)/.test(SRC));
ok('⓪b 📈 今天漲跌要走同一支(盤中即時 / 盤後收盤兩種來源)', /_starChg\s*\(code\)/.test(SRC));
ok('⓪c ⛔ 即時價要重用釣魚池那套(`_lqPx`/`_lqStamp`),⛔ 不可再寫一份',
   /_starChg[\s\S]{0,600}this\._lqPx\(code\)[\s\S]{0,200}this\._lqStamp\(\)/.test(SRC));
ok('⓪d 🚨 平盤要有明確門檻常數(⛔ 0.00% 不可算成「同方向」)', /const MOVE = 0\.1;/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const P = window.PRO;
    P.switchTab('star');
    await new Promise(r => setTimeout(r, 2500));
    const out = { note: (document.getElementById('starNote') || {}).innerText || '' };
    const grab = async sym => {
        await P.starGo(sym); await new Promise(r => setTimeout(r, 1000));
        const el = document.getElementById('starList');
        return { txt: (el.innerText || '').replace(/\s+/g, ' '), html: el.innerHTML || '',
                 mu: (P._starMutual(sym, (P._starData.r[sym] || []), P._starData)) };
    };
    out.a = await grab('3231');      // 緊密族群
    out.b = await grab('2330');      // 權值股:大家像它、它不像大家
    out.c = await grab('2603');      // 航運:族群性強
    // ⭐ 平盤守門:自己塞一組「中心 +3%、鄰居全部 0.00%」驗它⛔ 不會說成「一起動」
    const keepChg = P._starChg;
    P._starChg = c => (c === '3231' ? { pct: 3, live: false } : { pct: 0, live: false });
    await P.starGo('3231'); await new Promise(r => setTimeout(r, 600));
    out.flat = (document.getElementById('starList').innerText || '').replace(/\s+/g, ' ');
    P._starChg = keepChg;
    return out;
});
await browser.close();

// ── ① 雙向確認 ──
ok('①⓪ 空過守門:三檔都真的查得到(⛔ 查不到的話下面全部等於沒驗)',
   R.a.txt.includes('走勢最像') && R.b.txt.includes('走勢最像') && R.c.txt.includes('走勢最像'));
ok('① 🔁 每一檔都要顯示「真的同一族的有 N / M 檔」', /真的同一族的有 \d+ \/ \d+ 檔/.test(R.a.txt), R.a.txt.slice(0, 160));
ok('①b ⭐ 要有鑑別力:2330(權值股)必須是 0,而 3231(電子代工族)必須 > 0',
   Object.values(R.b.mu).filter(Boolean).length === 0 && Object.values(R.a.mu).filter(Boolean).length > 0,
   `2330=${Object.values(R.b.mu).filter(Boolean).length} 3231=${Object.values(R.a.mu).filter(Boolean).length}`);
ok('①c 🚨 0 的時候要說得出為什麼(⛔ 不可只丟一個 0 讓人以為壞掉)',
   /不是它們最像的/.test(R.b.txt), R.b.txt.slice(0, 200));
ok('①d ⚠️ 綁得緊的時候要講「重壓同一個風險」(這才是這一欄存在的理由)',
   /重壓同一個風險/.test(R.a.txt) || /重壓同一個風險/.test(R.c.txt));
ok('①e 表格要有「互相」欄與 ✔', /互相/.test(R.a.html) && /✔/.test(R.a.html));

// ── ② 今天有沒有一起動 ──
ok('② 📈 要顯示「今天 N / M 檔跟它同方向」或誠實說為什麼不談',
   /今天 \d+ \/ \d+ 檔跟它同方向|先不談「有沒有一起動」/.test(R.a.txt), R.a.txt.slice(0, 240));
ok('②b 🚨 講「整族一起動」時**必須**同時寫「本站沒有驗證過能不能預測」',
   !/整族一起動/.test(R.c.txt) || /沒有.{0,6}驗證過/.test(R.c.txt), R.c.txt.slice(0, 260));
ok('②c 🚨 中心那檔漲、鄰居全部平盤 → ⛔ 不可說成「整族一起動」',
   !/整族一起動/.test(R.flat), R.flat.slice(0, 200));
ok('②d ⭐ 而且要說出「幾乎沒動」這件事(⛔ 靜默把它們算掉 = 分母造假)',
   /沒動|先不談/.test(R.flat), R.flat.slice(0, 200));

// ── ③ 誠實限制 ──
// ⚠️ ⛔ 不可只驗「有沒有出現『補漲』兩個字」—— 把警語改寫成「補漲機會」照樣會通過(注入驗證抓到的)。
//   ⭐ 通用:驗「有沒有警告」時,要**同時**驗「沒有相反的推薦」。
ok('③ 🚨 說明區必須寫「⛔ 別拿它來找補漲」+ 實測數字(⛔ 那份指南正是教這個)',
   /別拿它來「找補漲」/.test(R.note) && /−0\.40|-0\.40/.test(R.note), R.note.slice(0, 400));
ok('③⓪ ⛔ 而且整頁不可出現把補漲講成機會的說法',
   !/補漲機會|尋找補漲|補漲空間|可以.{0,4}補漲/.test(R.note + R.a.txt), R.note.slice(0, 300));
ok('③b ⭐ 而且要寫「逐年全負」(⛔ 只說「比較差」會被當成雜訊)', /逐年全負/.test(R.note));
ok('③c ⛔ 這一頁仍然不下多空、不給買賣價位', /不下多空/.test(R.note) && /不給任何買賣價位/.test(R.note));
ok('③d ⛔ 不可出現進場指令', !/(建議買進|可以進場|進場價|停損價|目標價)/.test(R.a.txt), R.a.txt.slice(0, 200));

console.log(fails ? `\n❌ STARFAMILY_FAIL(${fails})` : '\n✅ STARFAMILY_PASS(全部通過)');
process.exit(fails ? 1 : 0);
