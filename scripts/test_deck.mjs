#!/usr/bin/env node
/**
 * 🎯 決策台(V75.0.0)—— 使用者:「我覺得整套散戶 App 實測後常常不知道看哪個,
 *   決定越來越不會用這套程式,可否重新改版」
 *
 * ⭐ 診斷:App 照「**資料類型**」組織,而使用者的問題是「**決策**」。
 *   逐頁精簡已做過約 10 輪、他還是說不知道看哪個 → 剩下的不是頁內雜訊,是**結構**。
 *   ⛔ 所以是**純新增**一頁當落地頁,舊 9 個分頁一個都沒動。
 *
 * ⛔ 十條不可改掉的設計:
 * ① 🚪 要賣的**不限量**(勝率只有三成,整套會賺完全靠「錯的時候小賠出場」)
 * ② 🎯 可以買的**最多 2 檔**,而且**只有 🧬**(V73.2.9:不挑 🧬 整套輸給買 0050)
 * ③ 🚨 「清單抓不到」與「今天沒有可以買的」**必須長得不一樣** ——
 *    ⛔ 混在一起 = 使用者把「檔案沒下載」讀成「今天沒訊號」
 * ④ 🚨 庫存裡算不出來的**要說出來**(⛔ 不可讓「沒警報」被當成「安全」,陷阱 #22)
 * ⑤ 🚨 誠實揭露:49 個月**兩種做法都輸給買 0050** —— ⛔ 拿掉它這頁就是在推薦一件會輸的事
 * ⑥ 🚨 ⛔ 整頁不可出現「開盤買」;進場時窗要讀 `_EOD_FROM`/`_EOD_TO`(⛔ 不寫死)
 * ⑦ 🚨 觸發價要寫「**漲過去才算數**」(⛔ 不是掛在下面等它跌回來)
 * ⑧ ⛔ 空頭(`bear`)不給進場
 * ⑨ 「今天沒有」要**誠實顯示**並指路,⛔ 不可為了填版面硬給一檔
 * ⑩ 燈號鐵則:🔴🟢 只表漲跌方向 → 這一頁用 🚪🎯✅⚠️⛔🚨,⛔ 不用紅綠燈
 *
 * ⚠️ `data/playbook_edge.json` **不在版控裡**(只在 gh-pages)→ 本地永遠是 null
 *    → 測試一律**注入假清單**,⛔ 不可靠真檔(那會變成「今天剛好有沒有」決定測試綠不綠)。
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 200) : ''}`); } };

// ═══ 靜態 ═══
// ⓪ 🚨 49 個月那組數字必須跟 pro.html 的 `_SIG_DEEP` **一模一樣**(⛔ 同名不同義)
const grab = (txt, key) => { const m = txt.match(new RegExp(key + '\\s*:\\s*([0-9.]+)')); return m ? +m[1] : null; };
const dt = SRC.slice(SRC.indexOf('_DECK_TRACK49:'), SRC.indexOf('_DECK_TRACK49:') + 400);
const sd = PRO.slice(PRO.indexOf('_SIG_DEEP:'), PRO.indexOf('_SIG_DEEP:') + 300);
for (const k of ['gene', 'geneDD', 'plain', 'plainDD', 'etf0050', 'months'])
    ok(`⓪ 跨檔案一致:${k}(index.html 的 _DECK_TRACK49 == pro.html 的 _SIG_DEEP)`,
       grab(dt, k) != null && grab(dt, k) === grab(sd, k), `${grab(dt, k)} vs ${grab(sd, k)}`);
// ⓪b 🚨 「輸」的方向不可被寫反
ok('⓪b 🚨 0050 要**大於** 🧬(⛔ 這個方向被寫反的話整段揭露就變成在說謊)',
   grab(dt, 'etf0050') > grab(dt, 'gene'));
// ⓪c ⛔ 不可跟 36 個月那組混用
ok('⓪c ⛔ 兩個窗口的數字不可混用(_PB_TRACK 是 36 個月、_DECK_TRACK49 是 49 個月)',
   /months: 36/.test(SRC.slice(SRC.indexOf('_PB_TRACK:'), SRC.indexOf('_PB_TRACK:') + 200)) && grab(dt, 'months') === 49);

// ① 落地頁 + 分頁接線
ok('① 預設落地在決策台(⛔ 帶股票代號的深連結仍進個股頁)',
   /switchAppTab\(this\._deepLinkSym \? 'diag' : 'desk'\)/.test(SRC));
ok('①b 舊 9 個分頁一個都沒少', /\['Desk', 'Diag', 'Market', 'Fav', 'Inv', 'Radar', 'Hunt', 'Broker', 'Potential'\]/.test(SRC));
ok('①c 有接 render 分派', /tabId === 'desk'.{0,80}renderDeck\(\)/s.test(SRC));

// ② 排序:全 App 唯一一份
ok('② 🚨 排序式子全 App 只准有一份(⛔ 三處手抄遲早只改到一邊,陷阱 #37)',
   (SRC.match(/\(_hq\(b\) - _hq\(a\)\)/g) || []).length === 1);
ok('②b 清單/推播/決策台三處都呼叫 `_pbSort`', (SRC.match(/this\._pbSort\(/g) || []).length === 3);
ok('②c `_mySyms` 也只有一份(⛔ 不可再手抄 Set)',
   (SRC.match(/for \(const g of Object\.values\(this\.favGroups/g) || []).length === 1);
ok('②d ⛔ 排序不可用原始期望值 exp(V72.9.2:必定挑到僥倖股)',
   /_lb\(b\) - _lb\(a\)/.test(SRC) && !/\(b\.exp - a\.exp\)/.test(SRC));

// ③ ⛔ 整頁不可出現「開盤買」(⚠️ 先剝註解 —— 說明它的註解本身就含那三個字)
const deck = SRC.slice(SRC.indexOf('async renderDeck()'), SRC.indexOf('async renderDeck()') + 9000);
const deckNoCmt = deck.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
ok('③ 🚨 ⛔ 整頁不可叫人「開盤買」', !/開盤買下|一開盤就買|開盤就買/.test(deckNoCmt));
ok('③b 進場時窗要讀 `_EOD_FROM`/`_EOD_TO`(⛔ 不寫死 13:00~13:28)',
   /this\._EOD_FROM/.test(deckNoCmt) && /this\._EOD_TO/.test(deckNoCmt) && !/13:00~13:2\d/.test(deckNoCmt));

// ④ ⛔ 不用紅綠燈(講的是「要不要做」不是漲跌方向)
ok('④ ⛔ 決策台不用 🔴🟢 當狀態燈(燈號鐵則)', !/🔴|🟢/u.test(deckNoCmt));

// ═══ 實跑 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app.renderDeck, null, { timeout: 30000 });

// ⚠️ playwright 的 evaluate ⛔ 不能傳函式 → 傳**基底物件**進去,在瀏覽器裡再組
//   欄位形狀照真實 gh-pages 的 `playbook_edge.json`(陷阱 #40:測資格式要跟真實產物一樣)
const BASE = { s: '0000', c: 100, v: 3000, d: '2026-09-07', k: '💪 發動棒破昨高', w: 61.1, po: 4.8,
               exp: 11.5, lb: 5.4, n: 18, trig: 105, loose: 0, rank: 92, vol: 103, hq: 1, bear: 0, up: 3.1, stop: 95 };

const R = await page.evaluate(async (mk) => {
    const A = window.app || app;
    const out = {};
    const P = (s, o) => Object.assign({ ...mk }, { s }, o || {});
    const txt = () => ['deckHead', 'deckSell', 'deckBuy', 'deckIdle', 'deckNote']
        .map(i => (document.getElementById(i) || {}).innerHTML || '').join('\n').replace(/<[^>]+>/g, ' ');
    const reset = () => { A._invExitAt = 0; A._invExitFlags = null; A._invExitSkip = null; A._invExitN = 0; };

    // ── ⑤ 買:20 檔候選(15 檔 hq、3 檔 hq 但空頭、2 檔非 hq)→ 只能出 2 檔、且都是 hq 非 bear
    A.inventory = []; A.favGroups = {};
    A._pbEdge = { data_date: '2026-09-07', picks: [
        ...Array.from({ length: 15 }, (_, i) => P(String(1000 + i), { lb: 9 - i * 0.1 })),
        ...Array.from({ length: 3 }, (_, i) => P(String(2000 + i), { bear: 1, lb: 99 })),
        P('3001', { hq: 0, lb: 99 }), P('3002', { hq: 0, lb: 98 }),
    ] };
    reset(); await A.renderDeck();
    const buyEl = document.getElementById('deckBuy');
    out.buyN = buyEl.querySelectorAll('[onclick*="app.analyze"]').length;
    out.buyHasBear = /2000|2001|2002/.test(buyEl.innerHTML);
    out.buyHasNonHq = /3001|3002/.test(buyEl.innerHTML);
    out.buyTxt = buyEl.innerText.replace(/\s+/g, ' ');
    out.noteTxt = document.getElementById('deckNote').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // ── ⑥ 賣:注入 20 筆 → ⛔ 不可被限量
    A._invExitFlags = Array.from({ length: 20 }, (_, i) => ({ sym: String(9000 + i), name: `測試${i}`, v: 100, px: 95, rule: 'ATR 追蹤停利' }));
    A._invExitSkip = ['8888', '8889']; A._invExitN = 22; A._invExitAt = Date.now();
    await A.renderDeck();
    const sellEl = document.getElementById('deckSell');
    out.sellN = sellEl.querySelectorAll('[onclick*="app.analyze"]').length;
    out.skipTxt = sellEl.innerText.replace(/\s+/g, ' ');

    // ── ⑥c 🚨 **實跑** `_invExitScan`:K 線讀不到的那幾檔要進 `skip`
    //    ⚠️ 上面 ⑥ 是**直接注入** `_invExitSkip`,那條驗的是「有 skip 時畫面會不會說」;
    //       這一條才驗「`_invExitScan` 自己會不會把它記下來」——
    //       ⛔ 少了它,把 `skip.push` 拿掉照樣綠(注入驗證當場抓到的)。
    A.inventory = [{ symbol: '7777', cost: 50, shares: 1 }, { symbol: '7778', cost: 60, shares: 1 }];
    reset();
    const flags = await A._invExitScan();
    out.scanSkip = (A._invExitSkip || []).slice().sort();
    out.scanFlags = flags.length;
    out.scanN = A._invExitN;

    // ── ⑥d 🚨 **全部**都沒檢查到 → ⛔ 不可寫成「都還沒跌破」(⭐ 實跑讀輸出抓到的邏輯打架)
    A.inventory = [{ symbol: '7777', cost: 50, shares: 1 }];
    A._invExitFlags = []; A._invExitSkip = ['7777']; A._invExitN = 1; A._invExitAt = Date.now();
    await A.renderDeck();
    out.allSkipTxt = document.getElementById('deckSell').innerText.replace(/\s+/g, ' ');
    // ⑥e 只有一部分沒檢查到 → 主線的「N 檔」要**扣掉**沒檢查的那幾檔
    A.inventory = [{ symbol: '7777', cost: 50, shares: 1 }, { symbol: '7778', cost: 50, shares: 1 }, { symbol: '7779', cost: 50, shares: 1 }];
    A._invExitFlags = []; A._invExitSkip = ['7777']; A._invExitN = 3; A._invExitAt = Date.now();
    await A.renderDeck();
    out.partSkipTxt = document.getElementById('deckSell').innerText.replace(/\s+/g, ' ');

    // ── ⑦ 清單抓不到(null)⛔ 不可顯示成「今天沒有可以買的」
    A._pbEdge = null; reset(); A._invExitFlags = []; A._invExitN = 0; A._invExitAt = Date.now();
    await A.renderDeck();
    out.nullTxt = document.getElementById('deckBuy').innerText.replace(/\s+/g, ' ');

    // ── ⑧ 清單有、但一檔 hq 都沒有 → 這才是真的「今天沒有」
    A._pbEdge = { data_date: '2026-09-07', picks: [P('3001', { hq: 0 }), P('3002', { hq: 0 })] };
    reset(); A._invExitFlags = []; A._invExitN = 5; A._invExitAt = Date.now();
    await A.renderDeck();
    out.noneTxt = document.getElementById('deckBuy').innerText.replace(/\s+/g, ' ');
    out.idleTxt = document.getElementById('deckIdle').innerText.replace(/\s+/g, ' ');

    // ── ⑨ 庫存為空 → 賣區要說「你還沒填庫存」(⛔ 不可跟「今天沒有要賣的」長一樣)
    A.inventory = []; reset(); A._invExitFlags = []; A._invExitN = 0; A._invExitAt = Date.now();
    await A.renderDeck();
    out.emptyInvTxt = document.getElementById('deckSell').innerText.replace(/\s+/g, ' ');

    // ── ⑩ 同一檔兩招 ⛔ 不可吃掉兩個名額
    A._pbEdge = { data_date: '2026-09-07', picks: [
        P('4001', { lb: 9, k: '招 A' }), P('4001', { lb: 8.9, k: '招 B' }), P('4002', { lb: 8 }),
    ] };
    reset(); await A.renderDeck();
    // ⚠️ ⛔ 別去數「4001 出現幾次」—— 一列裡 onclick/顯示/title 都會有代號(那是在猜輸出)
    //   ⭐ 正解:把每一列的代號抽出來看是不是**兩個不同的**
    out.dupSyms = [...document.getElementById('deckBuy').querySelectorAll('[onclick*="app.analyze"]')]
        .map(el => (el.getAttribute('onclick').match(/analyze\('(\d+)'\)/) || [])[1]);

    out.all = txt();
    return out;
}, BASE);
await browser.close();

ok('⑤ 🎯 可以買的最多 2 檔', R.buyN === 2, String(R.buyN));
ok('⑤b 🚨 ⛔ 空頭的不可出現在買進清單', R.buyHasBear === false);
ok('⑤c 🚨 ⛔ 不符合 🧬 的不可出現(V73.2.9:🧬 是必要條件不是加分項)', R.buyHasNonHq === false);
ok('⑤d 🚨 必須寫「漲過去才算數,不是掛在下面等它跌回來」', /漲過.{0,30}才算數/.test(R.buyTxt) && /不是掛在下面等它跌回來/.test(R.buyTxt), R.buyTxt.slice(0, 120));
ok('⑤e 🚨 必須寫「不是開盤買」+ 尾盤時窗', /不是開盤買/.test(R.buyTxt) && /13:00~13:28/.test(R.buyTxt), R.buyTxt.slice(0, 200));
ok('⑤f 每一列都要有「買幾股 + 多少元 + 停損虧多少元」(% 一定配元)',
   /買 .*股|本金太小|帳戶總資金/.test(R.buyTxt));
ok('⑥ 🚪 要賣的⛔ 不可限量(注入 20 筆要全在)', R.sellN === 20, String(R.sellN));
ok('⑥b 🚨 算不出來的那幾檔要說出來 + 明寫「不代表安全」',
   /沒有.{0,4}幫你檢查/.test(R.skipTxt) && /不代表它們安全/.test(R.skipTxt), R.skipTxt.slice(0, 160));
ok('⑥c 🚨 `_invExitScan` 自己要把「K 線讀不到」的記下來(⛔ 不可靜默跳過)',
   JSON.stringify(R.scanSkip) === '["7777","7778"]' && R.scanFlags === 0 && R.scanN === 2,
   JSON.stringify([R.scanSkip, R.scanFlags, R.scanN]));
ok('⑥d 🚨 全部都沒檢查到 ⛔ 不可寫成「都還沒跌破」(那是說謊,而且跟旁邊的警告自己打架)',
   !/都還沒跌破/.test(R.allSkipTxt) && /還沒辦法幫你看|都還沒下載到/.test(R.allSkipTxt) && /不代表沒事/.test(R.allSkipTxt),
   R.allSkipTxt.slice(0, 140));
ok('⑥e 部分沒檢查到 → 主線的檔數要扣掉那幾檔(3 檔裡 1 檔沒檢查 → 說 2 檔)',
   /你手上 2 檔都還沒跌破/.test(R.partSkipTxt), R.partSkipTxt.slice(0, 140));
ok('⑦ 🚨 清單抓不到 ⛔ 不可顯示成「今天沒有可以買的」',
   /還沒下載到/.test(R.nullTxt) && /不是.{0,6}今天沒有可以買的/.test(R.nullTxt) && /重試/.test(R.nullTxt), R.nullTxt.slice(0, 160));
ok('⑧ 一檔 🧬 都沒有 → 誠實說「沒有」+ 說明為什麼 + 指路', /沒有/.test(R.noneTxt) && /位階/.test(R.noneTxt) && /今天不用做.{0,10}常態/.test(R.noneTxt), R.noneTxt.slice(0, 200));
ok('⑧b ⛔ 不可為了填版面硬給一檔', /不會為了填版面硬給你一檔/.test(R.noneTxt));
ok('⑧c 兩區都空 → 「✅ 今天不用做」要出現', /今天不用做/.test(R.idleTxt), R.idleTxt.slice(0, 120));
ok('⑨ 庫存為空 → 說「你還沒填庫存」(⛔ 不可跟「今天沒有要賣的」長一樣)',
   /還沒填庫存/.test(R.emptyInvTxt), R.emptyInvTxt.slice(0, 120));
ok('⑩ 同一檔的兩招⛔ 不可吃掉兩個名額(要是 4001 + 4002 兩個不同的)',
   JSON.stringify(R.dupSyms) === '["4001","4002"]', JSON.stringify(R.dupSyms));
ok('⑪ 🚨 誠實揭露:三個數字 + 「輸給 0050」+ 「🧬 讓你少輸不是一定贏」',
   /1,955,061/.test(R.noteTxt) && /2,600,300/.test(R.noteTxt) && /1,078,253/.test(R.noteTxt)
   && /都輸給買 0050/.test(R.noteTxt) && /讓你少輸/.test(R.noteTxt) && /不是讓你一定贏大盤/.test(R.noteTxt),
   R.noteTxt.slice(0, 260));
ok('⑪b 🚨 必須寫「勝率只有約 33%、十次會錯七次」', /33%/.test(R.noteTxt) && /十次會錯七次/.test(R.noteTxt));
ok('⑪c 🚨 必須寫「基準勝率 36% 不是 50%」', /基準勝率是 36% 不是 50%/.test(R.noteTxt));
ok('⑫ 空過守門:三塊真的都渲染出來了', R.all.length > 1200, String(R.all.length));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ DECK_PASS(全部通過)');
process.exit(fails ? 1 : 0);
