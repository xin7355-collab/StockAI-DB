#!/usr/bin/env node
/**
 * 🚀 V74.0.2 「明天漲停/大漲機率」測試(`_luOdds` / `_luOddsHtml` / `showLuOddsHelp`)
 *
 * 這張卡最危險的地方是:**它會讓人想去追漲停**。
 * 實測結論是「命中率拉得到 5.8 倍,但扣掉成本後每一格都是負的」——
 * 少了那句話,這張卡等於在推薦一件實測會賠錢的事。所以測試把下面幾條**釘死**:
 *   ① 數字現算自 `_LU_ODDS`(換一份假表,畫面要跟著變)—— ⛔ 不可寫死第二份
 *   ② 命中多個時**不可以把單一機率相乘**(要讀 hits 聯合表)
 *   ③ 命中 0~1 個 → **整條不顯示**(跟平常一樣,顯示只是雜訊、還會留空殼)
 *   ④ 🚨 一定要寫「扣成本後是負的 / 賺不到」,⛔ 不可只講機率
 *   ⑤ 🚨 今天漲停鎖死 → 一定要先講「買不到」,而且⛔不可給追進去的指令
 *   ⑥ ⛔ 不可下操作指令、不可給買賣價位(K線頁是解讀頁,V72.1.4 的單一劇本原則)
 *   ⑦ ⛔ 不可用紅綠(這是機率不是漲跌方向 —— 燈號鐵則)
 *   ⑧ 兩處 render path 都要接上(⛔ 只接一處 = 只有「剛好有 K 棒訊號」的日子才出現)
 *   ⑨ 🚧 空過守門:測資真的觸發了目標路徑(⛔ 否則斷言是假綠燈)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`);
    if (!cond) fails++;
};

// ── 靜態:接線與唯一真相 ────────────────────────────────────
ok('⑧a 主 render path 接上 _luOddsHtml',
    /\$\{_headline\}\$\{this\._luOddsHtml\(data\)\}/.test(SRC));
ok('⑧b 「沒有 K 棒訊號」那條路徑也接上(⛔ 只接一處 = 隨機出現)',
    /const _rg = [\s\S]{0,120}?this\._luOddsHtml\(data\) \+ this\._ldRedKHtml\(data, this\.currentSymbolId\) \+ this\._stockRegimeHtml/.test(SRC));   // ⚠️ 前面會再插新的補充(V74.4.4 跌停紅K、V74.4.9 出場價)→ ⛔ 別釘死整串
ok('①a _LU_ODDS 有定義', /_LU_ODDS:\s*\{/.test(SRC));
ok('①b _luOdds / _luOddsHtml 都有定義',
    /_luOdds\(data\)\s*\{/.test(SRC) && /_luOddsHtml\(data\)\s*\{/.test(SRC));

// ⛔ 顯示端不可出現寫死的機率數字(⛔ 第二份真相)。只掃 _luOddsHtml 函式本體。
const bodyM = SRC.match(/_luOddsHtml\(data\) \{[\s\S]*?\n    \},\n/);
ok('⑨a 🚧 空過守門:抓得到 _luOddsHtml 函式本體', !!bodyM && bodyM[0].length > 800,
    `len=${bodyM ? bodyM[0].length : 0}`);
const body = bodyM ? bodyM[0] : '';
// ⛔ 成本 0.44% 是「規則」不是「實測成績」,可以寫在文案裡 → 掃描前先排除
const bodyNoCost = body.replace(/0\.44%/g, '');
ok('①c 顯示端沒有寫死的機率數字(一律讀 _LU_ODDS)',
    !/[^0-9.]\d\.\d\d?%/.test(bodyNoCost), bodyNoCost.match(/[^0-9.]\d\.\d\d?%/g) || '');
ok('①f 換假表時「隔天開盤買」那個數字也要跟著變(⛔ 它曾經是寫死的)',
    /\$\{O\.lockOpen\}%/.test(body));
ok('②a 命中多個時讀聯合表 hits,⛔ 不是相乘',
    /_LU_ODDS\.hits\[key\]/.test(SRC) && !/p\s*\*\s*p|reduce\([^)]*\*/.test(body));
ok('⑥a ⛔ 不下操作指令 / 不給買賣價位',
    !/(買進|進場|掛單|停損|停利|目標價|可以追|建議買)/.test(body),
    (body.match(/(買進|進場|掛單|停損|停利|目標價|可以追|建議買)/g) || []).join(','));
ok('⑦a ⛔ 不用紅綠(機率不是漲跌方向)',
    !/text-(red|green)-\d/.test(body), (body.match(/text-(red|green)-\d\d\d/g) || []).join(','));

// ── 動態:真的渲染一次 ──────────────────────────────────────
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._luOdds, null, { timeout: 30000 });

/** 造 K 線:預設平淡;opts 控制最後一根長什麼樣 */
const mk = (opts = {}) => {
    const o = { n: 400, amp: 1, chg: 0, vr: 1, posHi: false, nh60: false, luCnt: 0, gap: 0, lock: false, ...opts };
    const d = [];
    let p = 100;
    for (let i = 0; i < o.n; i++) {
        // 讓年位階可控:預設整段在 90~110 之間慢慢走
        p = 100 + (o.posHi ? i / o.n * 10 : Math.sin(i / 7) * 4);
        const half = p * o.amp / 100 / 2;
        d.push({
            date: `2026/01/${String((i % 28) + 1).padStart(2, '0')}`,
            open: +p.toFixed(2), high: +(p + half).toFixed(2), low: +(p - half).toFixed(2),
            close: +p.toFixed(2), volume: 1000000,
        });
    }
    // 塞漲停體質:在中段放 luCnt 根漲停(⛔ 不可放在最後 60 根,免得污染 60 日高)
    for (let k = 0; k < o.luCnt; k++) {
        const j = 80 + k * 3;
        d[j].close = +(d[j - 1].close * 1.10).toFixed(2);
        d[j].high = d[j].close;
    }
    const i = d.length - 1, pc = d[i - 1].close;
    const cc = +(pc * (1 + o.chg / 100)).toFixed(2);
    d[i].close = cc;
    d[i].open = +(pc * (1 + o.gap / 100)).toFixed(2);
    d[i].high = o.lock ? cc : +Math.max(cc, d[i].open, pc * 1.001).toFixed(2);
    d[i].low = +Math.min(cc, d[i].open, pc * 0.999).toFixed(2);
    d[i].volume = Math.round(1000000 * o.vr);
    if (o.nh60) { d[i].close = cc; d[i].high = Math.max(d[i].high, cc); }
    return d;
};

const run = (opts) => page.evaluate((o) => {
    const d = window.__mk(o);
    return { r: app._luOdds(d), html: app._luOddsHtml(d) };
}, opts);
await page.evaluate(`window.__mk = ${mk.toString()}`);

// ③ 命中 0 個 → 整條不顯示
const flat = await run({ amp: 1, chg: 0, vr: 1 });
ok('⑨b 🚧 空過守門:平淡測資真的命中 0~1 個', flat.r && flat.r.hits <= 1, JSON.stringify(flat.r));
ok('③ 命中 0~1 個 → ⛔ 整條不顯示(不留空殼)', flat.html === '', flat.html.slice(0, 80));

// 命中多個 → 要顯示,而且數字要等於 _LU_ODDS.hits
const hot = await run({ amp: 8, chg: 8, vr: 3, posHi: true, nh60: true, luCnt: 6, gap: 4 });
ok('⑨c 🚧 空過守門:測資真的命中 ≥2 個', hot.r && hot.r.hits >= 2, JSON.stringify(hot.r && hot.r.list));
ok('②b 顯示的機率 == _LU_ODDS.hits 那一格(⛔ 不是相乘出來的)',
    await page.evaluate((h) => {
        const row = app._LU_ODDS.hits[Math.min(h, 5)];
        const d = window.__mk({ amp: 8, chg: 8, vr: 3, posHi: true, nh60: true, luCnt: 6, gap: 4 });
        const html = app._luOddsHtml(d);
        return html.includes(`>${row[0]}%<`) && html.includes(`>${row[1]}%<`);
    }, hot.r.hits));
ok('④a 🚨 有寫「賺不到 / 扣成本後是負的」', /賺不到錢/.test(hot.html) && /扣掉來回成本/.test(hot.html));
ok('④b 🚨 有寫「機率高 ≠ 期望值正」的白話解釋',
    /容易漲停.*同樣容易跌停|機率高\s*≠/.test(hot.html));
ok('④c 有標樣本數', /次\)/.test(hot.html));
ok('⑥b 顯示內容⛔ 不含買賣價位/指令',
    !/(買進|進場|掛單|停損|停利|目標價|建議買|可以追)/.test(hot.html));

// ⑤ 今天漲停鎖死
const lk = await run({ amp: 5, chg: 10, vr: 3, lock: true });
ok('⑨d 🚧 空過守門:測資真的觸發鎖死', lk.r && lk.r.lock === true, JSON.stringify(lk.r));
ok('⑤a 🚨 鎖死時一定要講「買不到」', /買不到/.test(lk.html));
ok('⑤b 🚨 鎖死時要講「追進去是賠的」', /追進去反而是賠的/.test(lk.html));
ok('⑤c 鎖死時⛔ 不可出現追價指令', !/(可以追|建議買|進場|掛單)/.test(lk.html));
ok('⑤d 鎖死時數字讀 _LU_ODDS.lock',
    await page.evaluate(() => {
        const d = window.__mk({ amp: 5, chg: 10, vr: 3, lock: true });
        const r = app._luOdds(d);
        const L = r.hits >= 3 ? app._LU_ODDS.lock.hi : app._LU_ODDS.lock.lo;
        return app._luOddsHtml(d).includes(`>${L[0]}%<`);
    }));

// ① 換一份假表 → 畫面要跟著變(⛔ 證明沒有第二份寫死的數字)
const fake = await page.evaluate(() => {
    const bak = JSON.parse(JSON.stringify(app._LU_ODDS));
    app._LU_ODDS.hits[3] = [99.9, 88.8, 77.7, 12345, -9.99];
    app._LU_ODDS.hits[2] = [99.9, 88.8, 77.7, 12345, -9.99];
    app._LU_ODDS.hits[4] = [99.9, 88.8, 77.7, 12345, -9.99];
    app._LU_ODDS.hits[5] = [99.9, 88.8, 77.7, 12345, -9.99];
    const d = window.__mk({ amp: 8, chg: 8, vr: 3, posHi: true, nh60: true, luCnt: 6, gap: 4 });
    const html = app._luOddsHtml(d);
    app._LU_ODDS = bak;
    return html;
});
ok('①d 換一份假成績表 → 畫面數字跟著變(⛔ 沒有寫死的第二份)',
    /99\.9%/.test(fake) && /88\.8%/.test(fake) && /12,345/.test(fake), fake.slice(0, 200));

// 教學:數字也要現算
const help = await page.evaluate(() => {
    let cap = ''; const bak = window.alert; window.alert = m => { cap = m; };
    app.showLuOddsHelp(); window.alert = bak; return cap;
});
ok('④d 教學也要寫「機率高 ≠ 賺得到」', /機率高\s*≠\s*賺得到/.test(help));
ok('②c 教學要寫「⛔ 不可相乘」', /不可以把機率相乘/.test(help));
ok('①e 教學數字現算(含實際樣本數與窗口)',
    help.includes(String(app => 0) ? '2024-04-18' : '') && /534,563/.test(help) && /2,243/.test(help));
ok('⑤e 教學要提「鎖死那種買不到」', /買不到/.test(help));

// ⑨e 🚧 全域空過守門:真的有跑到動態測試(⛔ 防「瀏覽器沒開起來也全綠」)
ok('⑨e 🚧 空過守門:動態測試真的執行過', hot.html.length > 200 && lk.html.length > 200);

await browser.close();
console.log();
console.log(fails ? `❌ ${fails} 條失敗` : '✅ LUODDS_PASS(全部通過)');
process.exit(fails ? 1 : 0);
