#!/usr/bin/env node
/**
 * 🏭 V74.7.4 「這家公司做什麼 ・ 上游是誰 ・ 下游是誰」
 *
 * 使用者:「我是還想要他有做了什麼設備做了什麼事情…這家公司做了什麼?他的上游是誰他的下游是誰」。
 *
 * ⭐ 資料從哪來(⛔ 零新採礦):
 *   ① `CHAIN.stocks` 第 4 欄 —— 81 檔的**精確產品/技術**(先進製程/CoWoS、ASIC 設計服務…)
 *   ② `THEMES` 20 組題材 × 成員(人工 seed)
 *   ③ `stock_tags.json` 的 `by_stock`(採礦端每天算的題材連動,226 檔)
 *   ④ 都沒有 → 證交所官方產業別 → 再沒有 → 誠實說 + 免費查入口
 * ⛔ 營收**產品別**佔比 / 產線 / 產能時程 / ASP / 供應商「純度分數」
 *   —— 台股沒有免費結構化來源,⛔ 不編(評估紀錄⑳)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── ⓪ 名字守門(🚨 這正是第一版踩到的) ──
ok('⓪ 🚨 上下游表**不可**叫 `FLOW`(那個名字已經被板塊輪動的法人資金流用掉了)',
   /^  CHAIN_FLOW: \[/m.test(SRC) && !/^  FLOW: \[\s*$\n\s*\['wafer'/m.test(SRC));
ok('⓪b `_bizFlow` 要吃 CHAIN_FLOW', /for \(const \[a, b\] of this\.CHAIN_FLOW\)/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const perr = [];
page.on('pageerror', e => perr.push(e.message.slice(0, 160)));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const P = window.PRO;
    await P.fetchJson('data/stock_tags.json').catch(() => null);
    await P.fetchJson('data/screener.json').catch(() => null);
    const out = { themeKeys: (P.THEMES || []).map(t => t.k), flow: P.CHAIN_FLOW || [] };
    out.tagShape = !!(P._cache['data/stock_tags.json'] || {}).by_stock;
    const panel = async c => {
        P.openStock(c); await new Promise(r => setTimeout(r, 350));
        const el = document.getElementById('stkPanel') || document.querySelector('.sh')?.parentElement;
        return (el ? el.innerText : '').replace(/\s+/g, ' ');
    };
    out.tsmc = await panel('2330');     // 鏈內:上游+下游都有
    out.wafer = await panel('6488');    // 鏈內:只有下游(它是最上游)
    out.srv = await panel('3231');      // 鏈內:上游一堆 + 終點說明
    out.cement = await panel('1101');   // 鏈外:只有官方產業別
    // ⭐ 空過守門專用:1514 亞力**不在任何人工 seed 裡**,只有採礦端算出來的「重電/電網」
    //   ⛔ 沒有這一檔的話,「by_stock 鍵名猜錯」那個缺陷完全驗不到(注入驗證抓到的)
    out.auto = await panel('1514');
    out.what = { '2330': P._bizWhat('2330'), '6488': P._bizWhat('6488'), '1101': P._bizWhat('1101') };
    return out;
});
await browser.close();

ok('⓪c 沒有 pageerror', perr.length === 0, perr.join('|'));
ok('⓪d 🚨 `stock_tags.json` 的內容在 `by_stock` 底下(⛔ 猜錯鍵名會靜默拿到空的)', R.tagShape);
ok('⓪d2 🚨🚨 而且要**真的讀得到** —— 1514 亞力不在任何人工名單裡,只有採礦端算出來的「重電/電網」',
   /重電\/電網/.test(R.auto) && /採礦端算出來的/.test(R.auto), R.auto.slice(0, 200));
ok('⓪e ⭐ CHAIN_FLOW 用到的每一個題材 k **都必須存在於 THEMES**(⛔ 打錯字會靜默失效)',
   R.flow.every(([a, b]) => R.themeKeys.includes(a) && R.themeKeys.includes(b)),
   R.flow.filter(([a, b]) => !R.themeKeys.includes(a) || !R.themeKeys.includes(b)).map(x => x.join('→')).join(','));

// ── ① 它做什麼 ──
ok('① 🏭 鏈內個股要給**精確產品**(⛔ 不是只給產業別)',
   /先進製程/.test(R.tsmc) && /矽晶圓/.test(R.wafer), R.tsmc.slice(0, 120));
ok('①b 來源要標出來(人工整理 / 官方產業別 / 採礦端算的,⛔ 不可讓人以為是財報抽的)',
   /資料來源:/.test(R.tsmc) && /人工整理/.test(R.tsmc) && /官方產業別/.test(R.cement));
ok('①c 鏈外個股也要有東西(退回官方產業別),⛔ 不可空白', /🏭 它做什麼 水泥/.test(R.cement), R.cement.slice(0, 140));

// ── ② 上下游 ──
ok('② ⬆️ 台積電要看得到上游(矽晶圓 / ASIC 設計)', /上游.{0,20}矽晶圓|矽晶圓/.test(R.tsmc) && /環球晶/.test(R.tsmc), R.tsmc.slice(0, 220));
// ⚠️ V74.7.7 起上下游改用**分層看板**呈現(⛔ 不再是 ⬆️/⬇️ 兩段文字清單)。
//    ⭐ 斷言跟著改成釘**用意**(「上下游的方向要對」),⛔ 不釘當時的版面。
ok('②b ⬇️ 台積電要看得到下游(先進封裝)', /先進封裝/.test(R.tsmc) && /下游/.test(R.tsmc));
ok('②c ⭐ 最上游那一檔(矽晶圓)要排在**上游**那一欄,而且看得到它的下游',
   /矽晶圓/.test(R.wafer) && /晶圓代工/.test(R.wafer) && /上游/.test(R.wafer) && /下游/.test(R.wafer),
   R.wafer.slice(0, 200));
ok('②d 成員要可以點(chip)', /勤誠|川湖|日月光/.test(R.srv));
ok('②e 🏁 鏈的終點在海外 → 要**誠實說出來**(⛔ 不可顯示成「還沒整理」)',
   /台股沒有對應標的/.test(R.srv), R.srv.slice(-260));

// ── ③ 誠實限制(⛔ 少一條就會被當成財報數字) ──
ok('③ 🚨 必須寫「⛔ 不等於這個題材佔它營收九成」', /不等於「這個題材佔它營收九成」/.test(R.tsmc));
ok('③b 🚨 必須寫「本站算不出純度」(⛔ 那份規格要的純度分數台股沒有資料源)', /算不出純度/.test(R.tsmc));
ok('③c 🚨 上下游要寫明是**製造流程的先後**,⛔ 不代表真的有生意往來',
   /製造流程的先後/.test(R.tsmc) && /不代表.{0,12}生意往來/.test(R.tsmc), R.tsmc.slice(-300));
ok('③d ⛔ 不可寫成「上游漲它就會漲」', /不是「上游漲它就會漲」/.test(R.tsmc));
ok('③e ⛔ 整段不下多空、不給買賣價位',
   !/(建議買進|可以進場|進場價|停損價|目標價|看多|看空)/.test(R.tsmc), R.tsmc.slice(0, 200));
ok('③f 🔎 要給免費查入口(質化問題走外部 AI —— 本站鐵則:數字自算、質化外查)',
   /免費查它的產品與客戶/.test(R.tsmc) && /免費查它的產品與客戶/.test(R.cement));

console.log(fails ? `\n❌ BIZCHAIN_FAIL(${fails})` : '\n✅ BIZCHAIN_PASS(全部通過)');
process.exit(fails ? 1 : 0);
