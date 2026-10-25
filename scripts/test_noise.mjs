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
    // 💸 V79.4.5 第 9 欄 xr(比同一天平均股票)、第 10 欄 tone;「值得做」= `_sigProven`(A/B 且 xr > 成本)
    A._SIGNAL_EDGE = { '_d｜x': ['A', 10, 1, 50, 0.01, 1, 1, 0.5, 2.0, 'bull'], '_d｜y': ['C', 10, 1, 50, 0.9, 1, 1, -0.5, 2.0, 'bull'], '_d｜z': ['C', 10, 1, 50, 0.9, 1, 1, -0.5, -0.5, 'bear'] };
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
// 💸 V79.4.5 「值得做」改成跟提醒同一把尺 → 要講「看多 N 個裡扣成本還贏的只有 M 個」;假表:看多 2 個(x A 級 / y C 級)、過關 1 個
ok('①b 要點出「常對 ≠ 會賺」+ 看多裡扣成本還贏同一天平均股票的個數(V79.4.5 同一把尺)',
    /常對 ≠ 會賺/.test(R.txt) && /扣掉來回成本還比同一天平均股票多賺/.test(R.txt), R.txt.slice(0, 300));
ok('①c ⭐ 假表的過關數 = 1(C 級 xr 再高也不算、看空不算)', /看多的2個裡/.test(norm(R.fakeTxt)) && /只有1個/.test(norm(R.fakeTxt)), norm(R.fakeTxt).slice(0, 300));
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

// ⑥ 🧹 V74.5.6 使用者:「雜訊清單移到實測總表右手邊」→ V74.6.2 變成真的分頁 →
//   🧭 V79.8.0 分頁改五大類:雜訊清單⛔ 再自己一個分頁,改住在「🔬 實測總表 › ⛔ 沒用」最下面的摺疊(使用者選「去重 + 雜訊清單併進實測總表」)
//   ⛔ 「不可以有第二份數據」「延遲載入」「讀不到要說」三條鐵則照舊
const PRO_SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const PRO_NC = PRO_SRC.replace(/<!--[\s\S]*?-->/g, '');
const labSec = PRO_NC.slice(PRO_NC.indexOf('<div id="tabLab"'), PRO_NC.indexOf('<div id="tabPoli"'));
ok('⑥ 雜訊清單住在實測總表裡(⛔ 不再是自己一個分頁)', /id="labNoiseWrap"/.test(labSec) && /雜訊清單/.test(labSec) && !/id="tabNoise"/.test(PRO_SRC) && !/id="tabBtnNoise"/.test(PRO_SRC), labSec.slice(0, 120));
ok('⑥b ⭐ 排在實測總表清單的下面(⛔ 擋在結論前面)', labSec.indexOf('id="labNoiseWrap"') > labSec.indexOf('id="labList"'));
ok('⑥b2 🧽 ⛔ 不可再有掃把圖示(使用者明示移除)', !/🧹\s*(<b>)?雜訊清單/.test(PRO_NC.replace(/\/\/[^\n]*/g, '')), (PRO_NC.match(/.{0,40}🧹\s*(<b>)?雜訊清單.{0,20}/) || [''])[0]);
ok('⑥c 舊入口(switchTab(\'noise\') / ?noise=1)照樣進得來 → 實測總表「沒用」+ 打開那一段', /noise: \['lab', 'trap'\]/.test(PRO_SRC) && /_labNoiseOpen/.test(PRO_SRC));
ok('⑥c2 🚨 pro.html ⛔ 不可抄一份資料過去 —— 必須 fetch index.html 現場解析',
    /fetch\('index\.html\?t='/.test(PRO_SRC) && /_cutLiteral\(src, name\)/.test(PRO_SRC)
    // ⛔ 只准出現在「解析用的名字字串」裡,不可出現成 pro.html 自己的資料定義
    && !/_NOISE_KEEP:\s*\[/.test(PRO_SRC) && !/_NOISE_GONE:\s*\[/.test(PRO_SRC)
    && !/_CHANGELOG:\s*\[/.test(PRO_SRC) && !/_TIDY:\s*\[/.test(PRO_SRC));
ok('⑥c3 🚨 讀不到要誠實說出來 + 留一條路(⛔ 不可靜默空白)',
    /_idxErr/.test(PRO_SRC) && /讀不到散戶救星的資料/.test(PRO_SRC) && /index\.html\?lab=1&noise=1/.test(PRO_SRC));   // 🔬 V78.3.8 雜訊清單只在實驗室模式開 → 退路要帶 lab=1
ok('⑥d ⭐ 延遲載入(index.html 有 2.8MB,⛔ 不可開頁就抓)—— 摺疊打開才讀',
    (/if \(this\._idxData \|\| this\._idxLoading\) return;/.test(PRO_SRC) || (/if \(this\._idxData\) return Promise\.resolve\(\);/.test(PRO_SRC) && /if \(this\._idxP\) return this\._idxP;/.test(PRO_SRC)))
    && /ontoggle="if\(this\.open\)PRO\.renderNoise\(\)"/.test(PRO_SRC));
ok('⑥d2 更新紀錄自己一頁(研究 › 🆕 更新紀錄),容器在 .wrap 裡面(⛔ V74.4.3 那次 #tabLab 被留在外面 → 一大塊空白)',
    (() => { const i = PRO_SRC.indexOf('<div id="tabLog"'); const w = PRO_SRC.indexOf('<div class="wrap">');
             const e = PRO_SRC.indexOf('<div id="stkSheet"'); return i > w && i < e; })() && /\['log', 'Log'\]/.test(PRO_SRC));
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
    await PRO.renderNoise(); await PRO.renderNoise();
    const nb = document.getElementById('noiseBody');
    const noise = { txt: nb.innerText, html: nb.innerHTML, err: PRO._idxErr,
                    ver: PRO._idxData && PRO._idxData.ver,
                    nEdge: PRO._idxData ? Object.keys(PRO._idxData.SIGNAL_EDGE || {}).length : 0,
                    nTidy: PRO._idxData ? (PRO._idxData.TIDY || []).length : 0,
                    nLog: PRO._idxData ? (PRO._idxData.CHANGELOG || []).length : 0 };
    await PRO.renderLog();   // 🧭 V79.8.0 更新紀錄自己一頁
    noise.logTxt = document.getElementById('logBody').innerText;
    // 🚨 換一份假表 → 畫面數字必須跟著變(⛔ 證明它不是寫死的)
    PRO._idxData.SIGNAL_EDGE = { x: ['A', 9, 0, 0, 0, 0, 0, 1], y: ['C', 9, 0, 0, 0, 0, 0, -1] };
    PRO._idxData.TIDY = [['zz', '假卡片名稱', '假理由']];
    await PRO.renderNoise();
    noise.fakeTxt = document.getElementById('noiseBody').innerText;
    // 📰 V79.0.8 決定性對照:專欄一篇都沒有 → 那幾條要回來
    const bk = PRO._colItems; PRO._colItems = () => [];
    await PRO.renderNoise(); noise.noColTxt = document.getElementById('noiseBody').innerText;
    PRO._colItems = bk;
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
// ⑧ 📰 V79.0.8 使用者:「有進專欄的就把原本刪除…我不要重複訊息」
ok('⑧a 已寫成專欄的(低檔布局 / 布林壓縮 / 盤中連量 / 隔日沖勝率)⛔ 不再重複列',
    !/低檔布局|布林壓縮|盤中連量偵測|隔日沖勝率回測/.test(R3.txt), (R3.txt.match(/[^\n]*(低檔布局|布林壓縮|盤中連量)[^\n]*/) || [''])[0]);
ok('⑧b 要說「另有 N 條在專欄」+ 一顆看專欄鈕(⛔ 不可默默消失)', /另有\s*\d+\s*條已經寫成專欄/.test(R3.txt) && /看專欄/.test(R3.txt));
ok('⑧c 決定性對照:專欄清空 → 那幾條回來(證明是專欄擋掉的)', /低檔布局/.test(R3.noColTxt) && /盤中連量偵測/.test(R3.noColTxt));
ok('⑧d 沒進專欄的照列(投信佔成交量比 / 分析師焦點)', /投信買超佔成交量比/.test(R3.txt) && /分析師焦點/.test(R3.txt));

// ⑨ 💸 V79.4.5 產業作戰室那份「值得做」的條件跟散戶救星 `_sigProven` 同一條(pro 叫不到 index 的函式,條件照抄一行 → 這裡兩邊比)
{
    const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const sp = (IDX.match(/_sigProven\(e\) \{[\s\S]*?\n    \},/) || [''])[0];
    const pn = (PRO_SRC.match(/_noiseHtml\(\) \{[\s\S]*?\n  \},/) || [''])[0];
    ok('⑨ index `_sigProven` = A/B 級 且 xr > 成本 且 樣本夠', /e\.grade === 'A' \|\| e\.grade === 'B'/.test(sp) && /e\.xr > this\._sigCost\(\)/.test(sp) && /_wrEnough/.test(sp), sp.slice(0, 200));
    ok('⑨b pro `_noiseHtml` 照同一條數(看多・A/B・xr > meta.cost・樣本 ≥10)',
        /v\[9\] === 'bull'/.test(pn) && /\(g === 'A' \|\| g === 'B'\)/.test(pn) && /v\[8\] > cost/.test(pn) && /v\[1\] >= 10/.test(pn) && /SIGNAL_EDGE_META/.test(pn), pn.slice(0, 200));
    // 數字一致:用 index 的表在 node 裡照兩邊的條件各算一次(⛔ 不一致 = 有一邊改了沒改另一邊)
    const line = n => IDX.split('\n').find(l => l.trimStart().startsWith(n + ':'));
    const T = JSON.parse(line('_SIGNAL_EDGE').trim().replace(/^_SIGNAL_EDGE:\s*/, '').replace(/,$/, ''));
    const M = JSON.parse(line('_SIGNAL_EDGE_META').trim().replace(/^_SIGNAL_EDGE_META:\s*/, '').replace(/,$/, ''));
    const nProven = Object.values(T).filter(v => v[9] === 'bull' && (v[0] === 'A' || v[0] === 'B') && typeof v[8] === 'number' && v[8] > M.cost && v[1] >= 10).length;
    const okN = (R.txt.match(/只有\s*(\d+)\s*個/) || [])[1];
    ok('⑨c ⭐ 散戶救星雜訊清單的過關數 = 照那條規則直接從表算的數', okN !== undefined && +okN === nProven, `畫面 ${okN} / 直接算 ${nProven}`);
}

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ NOISE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
