#!/usr/bin/env node
/**
 * 🧹 V74.5.1 雜訊清單(`_noiseHtml` / `_showNoiseList`)
 *
 * 使用者:「把雜訊或者驗證後沒有用的訊號加註起來,後面如果要刪除也比較清楚」。
 * ⛔ 釘死五件事:
 *   ① 分級數字**現算自 `_SIGNAL_EDGE`**(⛔ 不可寫死 —— 重跑回測後這頁會開始說謊)
 *   ② 已收起的卡**現算自 `_TIDY`**(⛔ 不可另抄一份清單)
 *   ③ 每一條「留著」的都要有:在哪一頁 + 實測數字 + 處置
 *   ④ 必須寫清楚「為什麼留著」(刪掉會讓人以為沒這回事)
 *   ⑤ ⛔ 不用紅綠(講的是有沒有用,不是漲跌方向)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  ${extra}`}`); if (!cond) fails++; };

// 🧹 V74.6.2 使用者明示把「雜訊清單 + 更新紀錄」搬到產業作戰室 → ⓪ 的斷言跟著改成釘**新規則**。
//   🚨 而且「搬移」必須是**真的搬走**:V74.0.1 那條「產業作戰室不顯示在散戶救星裡面、
//      也不放連結」還在(test_prohtml ② 釘住)→ 所以設定中心⛔ 不可留連結,只留純文字版本號。
ok('⓪ 設定中心⛔ 不再有雜訊清單入口(已搬走)',
    !/_showNoiseList\(\); app\.vibrate/.test(SRC) && !/🧹 雜訊清單<\/button>/.test(SRC));
ok('⓪c ⛔ 也不可留 pro.html 連結(V74.0.1);⭐ 但版本號要看得到(純文字)',
    !/pro\.html\?/.test(SRC) && /class="[^"]*"[^>]*>V\d+\.\d+\.\d+<\/span>/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(() => {
    const A = window.app || app;
    const out = {};
    A._showNoiseList();
    const m = document.getElementById('updateLogModal');
    out.opened = !m.classList.contains('hidden');
    out.title = (document.getElementById('updateLogTitle') || {}).textContent || '';
    out.txt = document.getElementById('updateLogBody').innerText;
    out.html = document.getElementById('updateLogBody').innerHTML;
    // ① 換一張假成績表 → 數字要跟著變
    const bak = A._SIGNAL_EDGE;
    A._SIGNAL_EDGE = { x: ['A', 10, 1, 50, 0.01, 1, 1, 0.5], y: ['C', 10, 1, 50, 0.9, 1, 1, -0.5], z: ['C', 10, 1, 50, 0.9, 1, 1, -0.5] };
    out.fake = document.createElement('div');
    out.fakeTxt = A._noiseHtml().replace(/<[^>]+>/g, ' ');
    A._SIGNAL_EDGE = bak;
    // ② 換一份假 _TIDY → 清單要跟著變
    const bt = A._TIDY;
    A._TIDY = [['zzz', '🧪 假卡片名稱', '假理由']];
    out.fakeTidy = A._noiseHtml().replace(/<[^>]+>/g, ' ');
    A._TIDY = bt;
    out.tidyN = bt.length;
    out.keepN = A._NOISE_KEEP.length;
    out.actN = (out.txt.match(/👉 處置:/g) || []).length;
    m.classList.add('hidden');
    return out;
});

ok('⓪b 點了真的打開,而且標題講清楚這是什麼', R.opened && /雜訊清單/.test(R.title), R.title);
const norm = t => String(t).replace(/\s+/g, '');
ok('① 🚨 K 棒訊號分級數字**現算自 _SIGNAL_EDGE**(換假表數字要跟著變)',
    /1個統計上站得住腳/.test(norm(R.fakeTxt)) && /2個跟隨機沒差/.test(norm(R.fakeTxt))
    && !/1個統計上站得住腳\(/.test(norm(R.txt)),
    norm(R.fakeTxt).slice(0, 160));
ok('①b 要點出「常對 ≠ 會賺」(期望值為負的個數)', /期望值是負的/.test(R.txt) && /常對 ≠ 會賺|常對/.test(R.txt));
ok('② 🗂️ 已收起的卡**現算自 _TIDY**(換假清單要跟著變)',
    /假卡片名稱/.test(R.fakeTidy) && !/假卡片名稱/.test(R.txt) && R.tidyN >= 1);
ok('③ 「留著」那幾條**每一列**都要有:在哪一頁 + 實測數字 + 處置',
    R.actN >= R.keepN + 1 && (R.txt.match(/📊 實測:/g) || []).length >= R.keepN && /總覽|籌碼頁|釣魚池/.test(R.txt),
    `處置 ${R.actN} 次 / 留著 ${R.keepN} 條`);
ok('③b 已刪掉的也要列(決策紀錄,免得日後再做一次)', /已經刪掉的/.test(R.txt) && /盤中連量偵測/.test(R.txt));
ok('④ 🚨 必須寫「為什麼留著」(刪掉會讓人以為沒這回事)',
    /以為(「|)沒有這回事|以為「沒有這回事」|沒有這回事/.test(R.txt), R.txt.slice(0, 200));
ok('④b 要指路實測總表(完整的有用/沒用清單在那裡)', /實測總表/.test(R.txt));
ok('⑤ ⛔ 不可用紅綠 emoji(講的是有沒有用,不是漲跌)', !/[🔴🟢]/u.test(R.html));
ok('⑤b ⛔ 不可出現操作指令(這頁是列管清單不是訊號)',
    !/(可以買|建議買進|進場價|買點推播|停損價)/.test(R.txt), R.txt.slice(0, 150));

// ⑥ 🧹 V74.5.6 使用者:「雜訊清單移到實測總表右手邊」
const PRO_SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const tabs = (PRO_SRC.match(/<div class="tabs">[\s\S]*?<\/div>/) || [''])[0];
ok('⑥ 產業作戰室的分頁列有「🧹 雜訊清單」入口', /🧹 雜訊清單/.test(tabs), tabs.slice(0, 200));
ok('⑥b ⭐ 而且排在「實測總表」**右邊**',
    tabs.indexOf('實測總表') > 0 && tabs.indexOf('🧹 雜訊清單') > tabs.indexOf('實測總表'));
// 🚨 V74.6.2 ⑥c/⑥d 是**刻意推翻** V74.5.6 的(使用者要求它變成真的分頁)。
//   ⛔ 但「不可以有第二份數據」那條鐵則沒有被推翻 —— 改成釘更強的東西:
//      pro.html 必須是「fetch index.html 再解析」,⛔ 不可把那些文字抄過來。
ok('⑥c 它是真的分頁(⛔ 不再是跳走的鈕)', /PRO\.switchTab\('noise'\)/.test(tabs) && !/↗/.test(tabs));
ok('⑥c2 🚨 pro.html ⛔ 不可抄一份資料過去 —— 必須 fetch index.html 現場解析',
    /fetch\('index\.html\?t='/.test(PRO_SRC) && /_cutLiteral\(src, name\)/.test(PRO_SRC)
    // ⛔ 只准出現在「解析用的名字字串」裡,不可出現成 pro.html 自己的資料定義
    && !/_NOISE_KEEP:\s*\[/.test(PRO_SRC) && !/_NOISE_GONE:\s*\[/.test(PRO_SRC)
    && !/_CHANGELOG:\s*\[/.test(PRO_SRC) && !/_TIDY:\s*\[/.test(PRO_SRC));
ok('⑥c3 🚨 讀不到要誠實說出來 + 留一條路(⛔ 不可靜默空白)',
    /_idxErr/.test(PRO_SRC) && /讀不到散戶救星的資料/.test(PRO_SRC) && /index\.html\?noise=1/.test(PRO_SRC));
ok('⑥d ⭐ 延遲載入(index.html 有 2.8MB,⛔ 不可開頁就抓)',
    /if \(this\._idxData \|\| this\._idxLoading\) return;/.test(PRO_SRC)
    && /if \(t === 'noise'\) this\.renderNoise\(\);/.test(PRO_SRC));
ok('⑥d2 分頁容器要在 .wrap 裡面(⛔ V74.4.3 那次 #tabLab 被留在外面 → 一大塊空白)',
    (() => { const i = PRO_SRC.indexOf('<div id="tabNoise"'); const w = PRO_SRC.indexOf('<div class="wrap">');
             const e = PRO_SRC.indexOf('<div id="stkSheet"'); return i > w && i < e; })());
await browser.close();

// ⑦ ⭐ 決定性的一關:pro.html **實跑**把資料解析出來並渲染
//   ⚠️ file:// 下 fetch('index.html') 需要 --allow-file-access-from-files(已給)
const p2 = await (await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
})).newPage();
p2.on('pageerror', () => {});
await p2.goto('file://' + path.join(ROOT, 'pro.html') + '?noise=1', { waitUntil: 'domcontentloaded' });
await p2.waitForFunction(() => typeof PRO !== 'undefined', null, { timeout: 20000 });
const R3 = await p2.evaluate(async () => {
    PRO._noiseSub = 'noise'; await PRO.renderNoise(); await PRO.renderNoise();
    const nb = document.getElementById('noiseBody');
    const noise = { txt: nb.innerText, html: nb.innerHTML, err: PRO._idxErr,
                    ver: PRO._idxData && PRO._idxData.ver,
                    nEdge: PRO._idxData ? Object.keys(PRO._idxData.SIGNAL_EDGE || {}).length : 0,
                    nTidy: PRO._idxData ? (PRO._idxData.TIDY || []).length : 0,
                    nLog: PRO._idxData ? (PRO._idxData.CHANGELOG || []).length : 0 };
    PRO._noiseSub = 'log'; await PRO.renderNoise();
    noise.logTxt = document.getElementById('noiseBody').innerText;
    // 🚨 換一份假表 → 畫面數字必須跟著變(⛔ 證明它不是寫死的)
    PRO._idxData.SIGNAL_EDGE = { x: ['A', 9, 0, 0, 0, 0, 0, 1], y: ['C', 9, 0, 0, 0, 0, 0, -1] };
    PRO._idxData.TIDY = [['zz', '假卡片名稱', '假理由']];
    PRO._noiseSub = 'noise'; await PRO.renderNoise();
    noise.fakeTxt = document.getElementById('noiseBody').innerText;
    return noise;
});
ok('⑦ pro.html 真的解析成功(⛔ 解析壞掉 = 這一頁等於沒有)',
    !R3.err && R3.nEdge > 100 && R3.nLog > 10, JSON.stringify({ err: R3.err, nEdge: R3.nEdge, nLog: R3.nLog }));
ok('⑦b 🚨 數字是**現算**的:換一份假表,畫面要跟著變',
    /1 個統計上站得住腳/.test(R3.fakeTxt) && /假卡片名稱/.test(R3.fakeTxt)
    && !/假卡片名稱/.test(R3.txt), R3.fakeTxt.slice(0, 160));
ok('⑦c 內容要真的搬過來(留著的 / 已刪的 / 收起的卡 三段都要有)',
    /實測沒用、但刻意留著/.test(R3.txt) && /已經刪掉的/.test(R3.txt) && /已收起的卡片/.test(R3.txt));
ok('⑦d 更新紀錄那一欄要顯示散戶救星**現在的**版本號(⛔ 兩邊不可各寫一份)',
    !!R3.ver && R3.logTxt.includes(R3.ver), JSON.stringify({ ver: R3.ver }));
ok('⑦e ⛔ 這一頁不可用紅綠 emoji', !/[🔴🟢]/u.test(R3.html));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ NOISE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
