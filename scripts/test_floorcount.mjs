#!/usr/bin/env node
/**
 * 🏚️📊 全市場地板股家數(V72.4.9)測試
 *
 * 來源:權證小哥《哥有籌必爆》S2 第22集 + 兆華艾綸說 2026-07-08
 *   「假如**地板股有大概 100 檔**,那大概就是短線的低點」
 *
 * ⛔ 這支最重要的任務是**擋住四件事**(每一條都對應一個已知會犯的錯):
 *   ① 有人把門檻改回他口述的「100 檔」—— 那個數字在我兩年的資料裡只出現 11 天
 *      (樣本不足無法驗證);實測有邊際的是 **300 檔**(n=51)。
 *   ② 把它做成「數字越大越好」的連續指標 —— 實測**非單調**,中間段(50~299)反而略差,
 *      所以卡上那句「只有在極端多的時候才有邊際」不可拿掉。
 *   ③ 把它寫成進場指令 —— 它是**大盤層級**的參考,而且個股接刀實測是輸大盤的
 *      (`_detectFloorBounce`,V71.8.9)。⛔ 不可出現「買進/all in/進場」這種指令。
 *   ④ 用 🔴🟢 上色 —— 這裡講的是「跌完沒/風險」不是漲跌方向(CLAUDE.md 燈號鐵則)。
 *
 * ⚠️ 測試**不綁死真實資料狀態**(同 V72.1.8 的教訓)—— 一律注入 `_breadthHist`,
 *    每種情境各驗一次,⛔ 別假設今天剛好落在哪個分支。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._floorCountState, null, { timeout: 20000 });

// 造 n 天歷史,最後一天的 flr / flrv 指定
const hist = (n, tailFlr, tailFlrv = 0, baseFlr = 80) => {
    const a = Array.from({ length: n }, (_, i) => ({
        d: `2026-0${1 + (i % 7)}-${String((i % 28) + 1).padStart(2, '0')}`,
        flr: baseFlr, flrv: 10, total: 2300, up: 1000, dn: 1000, flat: 300,
        lu: 5, ld: 5, st: 100, wk: 100, amt: 4000, med: 0, idx: 0,
    }));
    a[a.length - 1] = { ...a[a.length - 1], d: '2026-07-30', flr: tailFlr, flrv: tailFlrv };
    return a;
};
const run = h => page.evaluate(a => {
    app._breadthHist = a;
    return { s: app._floorCountState(), html: app._floorCountHtml() };
}, h);

// ── ① 資料不足要誠實回 null,⛔ 不可硬給結論 ─────────────────────
let x = await run(hist(5, 500));
ok('① 歷史 <20 天 → 回 null', x.s === null, JSON.stringify(x.s));
ok('① 回 null 時 HTML 完全不顯(⛔ 不留空殼)', x.html === '', x.html);
x = await run([]);
ok('① 空陣列也不爆', x.s === null && x.html === '');

// ── ② 極端多(≥300)—— 實測有邊際的那一區 ──────────────────────
x = await run(hist(120, 520, 60));
ok('② n=520 → hot=true', x.s && x.s.hot === true, JSON.stringify(x.s));
ok('② 家數/爆量數都要顯示', /520/.test(x.html) && /60/.test(x.html), x.html.slice(0, 500));
ok('② 要端出實測數字(+1.55 / +1.44 / +1.45)',
    /\+1\.55/.test(x.html) && /\+1\.44/.test(x.html) && /\+1\.45/.test(x.html), x.html);
ok('② 要寫出樣本天數 51 天', /51 天/.test(x.html), x.html);
const hotHtml = x.html;

// ── ③ ⛔ 不可下進場指令(單一劇本原則 + 接刀實測輸大盤)────────────
//    ⚠️ 先 strip 掉否定形,否則「⛔ 不是叫你今天就 all in」這種**正確的免責句**
//       會被自己的測試擋下來(本專案已踩過 6 次,見 CLAUDE.md)。
const strip = s => s.replace(/⛔[^。<]*/g, '').replace(/不是[^。<]*/g, '').replace(/別[^。<]*/g, '')
                    .replace(/不代表[^。<]*/g, '').replace(/還不能[^。<]*/g, '');
ok('③ ⛔ 極端時不可出現買進指令', !/(買進|進場|加碼|可以追|all in)/i.test(strip(hotHtml)), strip(hotHtml).slice(0, 600));
ok('③ 但「分批撿指數型」這種降級說法要在', /分批/.test(hotHtml) && /(0050|006208)/.test(hotHtml), hotHtml);

// ── ④ ⛔ 燈號鐵則:不可用 🔴🟢(這講的是風險不是漲跌方向)──────────
// ⚠️ ⛔ 別寫成字元類 `[🔴🟢]` —— emoji 是**代理對**,放進字元類會被拆成 4 個代理碼元,
//    於是任何共用高位代理的 emoji(💡 = D83D DCA1,跟 🔴 = D83D DD34 同一個高位)都會誤判。
//    (第一版就是這樣被自己寫對的 💡 擋下來的。)一律用 `u` 旗標或直接比字串。
ok('④ ⛔ 極端版不含 🔴🟢', !/(\u{1F534}|\u{1F7E2})/u.test(hotHtml), hotHtml);
ok('④ ⛔ 家數/位階數字不可上紅綠(text-red-*/text-green-*)',
    !/(text-red-|text-green-)/.test(hotHtml), (hotHtml.match(/text-(red|green)-\d+/g) || []).join(','));

// ── ⑤ 中間段(50~299)不可被說成好事 —— 實測反而略差 ────────────
x = await run(hist(120, 250, 20));
ok('⑤ n=250 → hot=false', x.s && x.s.hot === false, JSON.stringify(x.s));
ok('⑤ 要明說「還沒到實測有邊際的那一區」', /還沒到實測有邊際/.test(x.html), x.html.slice(0, 600));
ok('⑤ ⛔ 中間段不可宣稱有優勢', !/\+1\.55/.test(x.html), x.html.slice(0, 600));
ok('⑤ ⭐ 不熱時也要提醒「不代表可以放心做多」', /放心做多/.test(x.html), x.html.slice(0, 900));

// ── ⑥ 非單調的警語必須留著(⛔ 別為了好看拿掉)──────────────────
for (const [nm, h] of [['極端', hist(120, 520, 60)], ['中間', hist(120, 250, 20)]]) {
    const r = await run(h);
    ok(`⑥ ${nm}段都要有「非連續指標」警語`,
        /只有在極端多的時候才有邊際/.test(r.html) && /50～299|50~299/.test(r.html), r.html.slice(-400));
    ok(`⑥ ${nm}段都要寫「未扣交易成本」`, /未扣交易成本/.test(r.html), r.html.slice(-300));
}

// ── ⑦ 位階要用「自己的歷史」算,⛔ 不是寫死門檻 ────────────────
x = await run(hist(120, 520, 60, 80));         // 119 天都是 80,最後一天 520 → 位階應接近 100%
ok('⑦ 位階 = 自己歷史的百分位(最後一天最大 → 近 100%)', x.s.pct != null && x.s.pct > 95, x.s.pct);
x = await run(hist(120, 10, 0, 80));           // 最後一天最小 → 位階 0%
ok('⑦ 最小值 → 位階 0%', x.s.pct === 0, x.s.pct);
x = await run(hist(30, 300, 10));              // 只有 30 天 < 60 → 位階算不出來
ok('⑦ 歷史 <60 天 → 位階誠實顯「累積中」', x.s.pct === null && /累積中/.test(x.html), `${x.s.pct} ${x.html.slice(0, 400)}`);

// ── ⑧ 教學文案:必須交代「我沒有照抄 100 檔」與個股版的區別 ─────────
const help = await page.evaluate(() => {
    let cap = '';
    const orig = window.alert; window.alert = t => { cap = t; };
    try { app._showFloorCountHelp(); } finally { window.alert = orig; }
    return cap;
});
ok('⑧ 教學要說明門檻改用 300(而不是他口述的 100)', /300/.test(help) && /100/.test(help), help.slice(0, 300));
ok('⑧ 教學要點出「只出現 11 天、樣本太少」', /11 天/.test(help), help);
ok('⑧ 教學要區分個股版(接刀平均輸大盤)', /接刀/.test(help) && /輸大盤/.test(help), help);
ok('⑧ 教學要寫「回測窗口整段是多頭」', /多頭/.test(help), help);
ok('⑧ 教學要寫「不是 51 個獨立樣本」', /獨立樣本/.test(help), help);

// ── ⑨ 採礦端:breadth.json 真的有 flr/flrv,而且**歷史列都補齊**(⛔ 不是從今天開始累積)──
const bd = path.join(ROOT, 'data', 'breadth.json');
if (fs.existsSync(bd)) {
    const H = (JSON.parse(fs.readFileSync(bd, 'utf8')).history || []);
    const withFlr = H.filter(r => typeof r.flr === 'number').length;
    ok('⑨ breadth.json 每一列都有 flr(回算完成)', H.length > 0 && withFlr === H.length, `${withFlr}/${H.length}`);
    ok('⑨ flrv 一定 ≤ flr(有量是子集合)', H.every(r => (r.flrv || 0) <= (r.flr || 0)), 'flrv > flr');
    ok('⑨ 至少有一天曾經 ≥300(否則門檻永遠碰不到 = 死碼)', H.some(r => (r.flr || 0) >= 300), `max=${Math.max(...H.map(r => r.flr || 0))}`);
} else {
    ok('⑨ breadth.json 不存在(本地未跑採礦,跳過)', true);
}

// ── ⑩ 整體:不可有 pageerror ────────────────────────────────
ok('⑩ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:\n - ${fails.join('\n - ')}` : '\n✅ FLOORCOUNT_TEST_PASS');
process.exit(fails.length ? 1 : 0);
