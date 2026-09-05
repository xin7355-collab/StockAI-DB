/**
 * 📌 ETF「我追的四檔」分頁(V74.8.1)
 *
 * ⛔ 這支釘住的是「為什麼要這樣做」:
 *  ① 🚨 **這頁不是「跟著買」** —— V74.6.4 實測:被主動 ETF 持有 vs 同級距 −0.51pp;
 *     經理人「新買進」之後最差(−0.83pp)、「減碼」之後反而好(+0.57pp)= 活躍度不是方向。
 *     那組數字必須留在卡上(⛔ 少了它,這頁就是在鼓勵跟車)。
 *  ② 🚨 持股權重合計太低 = 明細**抓不全** → 要說出來(⛔ 不說的話使用者以為它只買 5 檔)。
 *  ③ 🚨 名字拿不到 ⛔ 不可印成「2330 2330」(本專案第三次踩,已抽成 _nmOnly/_nmPair)。
 *  ④ 只有進到 `etfs` 陣列的檔才有換股偵測 → 另外兩檔要誠實說「還沒開始比對」。
 *  ⑤ 四檔重疊只做描述,⛔ 不可暗示「共識高 = 會漲」。
 *
 * ⚠️ 測資用**真實 gh-pages 產物**(⛔ 不憑印象編,陷阱 #40)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fail.push(m); };

// ⚠️ 真實產物;拿不到就用 repo 裡的(⛔ 不可靜默跳過 → 那會變成假綠燈)
let D = null;
for (const f of ['/tmp/real_etf.json', path.join(ROOT, 'data/etf_tracking.json')]) {
    try { D = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (_) {}
}
if (!D) { console.log('❌ 讀不到 etf_tracking.json —— ⛔ 不可當成通過'); process.exit(1); }

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined', null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async (d) => {
    const html = app._etfPinHtml(d);
    const e = document.createElement('div'); e.innerHTML = html; document.body.appendChild(e);
    e.querySelectorAll('details').forEach(x => x.open = true);
    await new Promise(r => setTimeout(r, 200));
    const txt = e.innerText.replace(/\s+/g, ' ');
    const cards = [...e.querySelectorAll('div')].filter(c => /🎯 重倉壓在哪/.test(c.innerText || '')
        && !/🕸️/.test(c.innerText || '') && c.querySelector('.font-black'));
    const out = {
        txt, pins: app.ETF_PIN.slice(),
        nCards: new Set(cards.map(c => (c.innerText.match(/00\d{3}A/) || [''])[0])).size,
        bars: e.querySelectorAll('[style*="width:"]').length,
        // ③ 名字/代號重複
        dup: [...e.querySelectorAll('span')].filter(x => {
            const t = (x.innerText || '').trim();
            return /^(\d{4}|\d{5}[A-Z]?) \1$/.test(t);
        }).length,
        dupTxt: /(\b\d{4}\b) \1\b/.test(txt),
        // 空殼守門:真的有渲染出東西
        len: html.length,
        // ⑤ 空資料
        empty: app._etfPinHtml(null),
        emptyList: app._etfPinHtml({ concentration: [] }),
        // ③ 共用入口
        nmOnly: app._nmOnly('9999'), nmPair: app._nmPair('9999'),
    };
    e.remove(); return out;
}, D);

ok(R.len > 3000, `① 有渲染出內容(${R.len} bytes)`);
ok(R.nCards >= 3, `①b 四檔都畫得出卡片(${R.nCards} 檔)`);
ok(R.bars >= 20, `①c 有權重長條圖(${R.bars} 條)`);

// ① 🚨 實測免責
ok(/不是「跟著做」|看他們在做什麼/.test(R.txt), '② 🚨 必須寫明「這頁不是跟著買」');
ok(/0\.51pp/.test(R.txt), '②b 必須附上 vs 同級距 −0.51pp 的實測數字');
ok(/0\.83pp/.test(R.txt) && /0\.57pp/.test(R.txt),
   '②c 🚨 而且要寫「新買進之後最差、減碼之後反而好」的兩個數字');
ok(/活躍度不是方向/.test(R.txt), '②d 要點出那是「活躍度不是方向」');
ok(!/建議買|可以跟|跟著買進|值得買/.test(R.txt), '②e ⛔ 不可出現跟車的操作指令');

// ② 抓不全
ok(/抓不全|權重合計/.test(R.txt), '③ 🚨 持股明細抓不全要說出來(⛔ 不可讓人以為它只買幾檔)');
ok(/不代表它只買/.test(R.txt), '③b 而且要明說「這不代表它只買這幾檔」');

// ③ 名字
ok(R.dup === 0 && !R.dupTxt, `④ 🚨 ⛔ 不可印成「2330 2330」(違規 ${R.dup} 個)`);
ok(R.nmOnly === '9999' && R.nmPair === '<span>9999</span>',
   `④b 共用入口:名字拿不到只回代號一次(實際「${R.nmPair}」)`);

// ④ 換股
ok(/還沒開始比對|還沒有歷史|沒有換股/.test(R.txt), '⑤ 換股狀態要說得出來');
ok(/換股偵測要等/.test(R.txt), '⑤b 沒被納入追蹤的檔要誠實說原因(⛔ 不可靜默空白)');

// ⑤ 重疊只做描述
ok(/共識/.test(R.txt) && /獨門/.test(R.txt), '⑥ 四檔重疊:共識與獨門都要列');
ok(/共識高 ⛔ 不等於比較會漲|不等於比較會漲/.test(R.txt),
   '⑥b 🚨 ⛔ 不可暗示「共識高 = 會漲」');
ok(/沒有「合計持股比例」的意義/.test(R.txt), '⑥c 加總權重要說明它只用來排序');

// 空資料
ok(/還沒載入/.test(R.empty), '⑦ 沒有資料時誠實說(⛔ 不可空白或炸掉)');
ok(/還沒出現|還沒載入/.test(R.emptyList), '⑦b 空清單也要有話說');

ok(errs.length === 0, `⑧ 載入無 pageerror${errs.length ? ':' + errs[0] : ''}`);

await browser.close();
console.log(fail.length ? `\n❌ ETFPIN_FAIL(${fail.length})\n` + fail.map(x => ' - ' + x).join('\n')
                        : '\n✅ ETFPIN_PASS(全部通過)');
process.exit(fail.length ? 1 : 0);
