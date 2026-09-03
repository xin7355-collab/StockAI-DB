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

ok('⓪ 設定中心有入口(⛔ 沒有入口 = 這份清單等於不存在)', /app\._showNoiseList\(\)/.test(SRC) && /🧹 雜訊清單/.test(SRC));

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
ok('⑥c 它是**跳回散戶救星**的深連結(⛔ 不可把清單複製一份到 pro.html —— 那些數字是現算的)',
    /gotoNoise\(\)/.test(tabs) && /location\.href = 'index\.html\?noise=1'/.test(PRO_SRC)
    && !/_NOISE_KEEP|_NOISE_GONE/.test(PRO_SRC));
ok('⑥d ↗ 要標出「會跳走」(⛔ 它不是一個分頁,別讓人以為點了會留在原地)', /🧹 雜訊清單 ↗/.test(tabs));
const R2 = await page.evaluate(async () => {
    const A = window.app || app;
    const m = document.getElementById('updateLogModal');
    m.classList.add('hidden');                      // 先關掉,才驗得出是不是深連結打開的
    history.replaceState(null, '', location.pathname + '?noise=1');
    // 重跑 init 太重 → 直接跑那段深連結判斷(⛔ 不複製邏輯:用同一個參數名 + 同一支函式)
    const hit = new URLSearchParams(location.search).get('noise') === '1';
    if (hit) A._showNoiseList();
    return { hit, opened: !m.classList.contains('hidden') };
});
ok('⑥e `?noise=1` 進來會自動打開清單', R2.hit && R2.opened, JSON.stringify(R2));
ok('⑥f 🚧 空過守門:index.html 真的有接這個參數(⛔ 上面那條只驗了函式,沒驗接線)',
    /get\('noise'\) === '1'/.test(SRC) && /_showNoiseList\(\)/.test(SRC));

await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ NOISE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
