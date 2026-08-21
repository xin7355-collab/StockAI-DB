#!/usr/bin/env node
/**
 * 🚀 「起漲點怎麼看」教學段(V73.8.3)測試
 *
 * 使用者問「起漲點要怎麼看」。這個問題本站**早就用 129 個訊號實測過**,
 * 而答案跟直覺相反:「等它回檔再買」那批幾乎全是負期望值,「已經在動」的才是正的。
 * ⛔ 但那個結論以前**只寫在專案文件裡**(使用者看不到)——
 *    App 只給單一訊號的分級,使用者看得到每一棵樹、看不到那片森林。
 *
 * ⛔ 這支要釘死的八件事:
 *   ① 數字**現算自 `_SIGNAL_EDGE`**,⛔ 不可在文案裡寫死第二份(改成績表要自動跟著變)。
 *   ② 「等回檔型」與「已經在動型」兩組必須**互斥** —— 第一版把「頭肩底」同時列進兩邊,
 *      讀起來像自我矛盾(它既是抄底型、又是期望值最高的那個)。
 *   ③ 🚨 **必須點名例外並附樣本數** —— ⛔ 不可只講對自己結論有利的那一半。
 *   ④ ⛔ **不可下操作指令/買賣價位**(這是教學不是訊號,單一劇本原則)。
 *   ⑤ **指路要指對地方**(陷阱 #32 的變形:V72.4.1 就是卡片沒放錯、指路指錯)——
 *      文案講的分頁名稱必須真的存在於 App。
 *   ⑥ 必須寫出「**訊號當天尾盤買**」的時機限制(V72.9.0:隔天開盤買少賺一大半)。
 *   ⑦ 必須寫出「沒扣交易成本」。
 *   ⑧ 已接進 `_showEdgeHelp`(⛔ 寫了沒接上等於沒做,陷阱 #37)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._edgeEntryHelpText, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const out = {};
    out.S = app._edgeEntrySummary();
    out.t = app._edgeEntryHelpText();
    // ⑧ 教學總文案(⛔ alert 會擋住 headless → 攔截掉)
    const realAlert = window.alert; let cap = '';
    window.alert = s => { cap = String(s); };
    try { app._showEdgeHelp(); } catch (e) { cap = 'THREW:' + e.message; }
    window.alert = realAlert;
    out.help = cap;
    // ① 換一份**假的**成績表,文案必須跟著變(證明不是寫死的)
    const realT = app._SIGNAL_EDGE;
    app._SIGNAL_EDGE = {
        '_x｜多頭回檔等買點': ['A', 1234, 0, 40, 0.01, 0, 1.2, -9.99],
        '_y｜爆量長紅': ['A', 5678, 0, 40, 0.01, 0, 1.2, +8.88],
    };
    out.fake = app._edgeEntryHelpText();
    app._SIGNAL_EDGE = realT;
    return out;
});
await browser.close();

const S = R.S, t = R.t;
ok('⓪ 讀得到成績表', !!S && S.total > 50, JSON.stringify(S && S.total));

// ① 數字現算
ok('① 文案裡的「總數 / 正的幾個」跟成績表一致',
    t.includes(String(S.total)) && t.includes(`【${S.pos.length} 個】`), '');
ok('①b 🚨 換一份假成績表,文案要跟著變(⛔ 證明沒有寫死第二份)',
    R.fake.includes('-9.99') && R.fake.includes('+8.88') && !R.fake.includes(String(S.total)),
    R.fake.slice(0, 160));

// ② 兩組互斥
{
    const dipNames = new Set(S.dip.map(r => r.name));
    // 「已經在動」那段列出來的名字,⛔ 不可出現在 dip 名單裡
    const momoBlock = t.split('反而是')[1] || '';
    const leaked = [...dipNames].filter(n => momoBlock.split('→ 一句話')[0].includes(n));
    ok('② 🚨「已經在動」那段 ⛔ 不可列到抄底型的訊號(第一版頭肩底同時出現在兩邊)',
        leaked.length === 0, leaked.join(','));
}

// ③ 例外要點名 + 附樣本數
const dipPos = S.dip.filter(r => r.exp > 0);
ok('③ 🚨 抄底型裡若有正的,必須點名並附「只出現 N 次」的樣本警告',
    dipPos.length === 0 || (/這類裡也有例外/.test(t) && /樣本偏小/.test(t)), t.slice(0, 400));

// ④ 不可下操作指令
const CMD = /(掛單|停損價|目標價|買在|進場價|全押|重壓)/;
ok('④ ⛔ 不可下具體買賣指令/價位', !CMD.test(t), (t.match(CMD) || [''])[0]);

// ⑤ 指路要指到真的存在的分頁
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = t.match(/【([^】]+)】分頁/);
ok('⑤ 有指路到某個分頁', !!m, t.slice(-300));
// ⚠️ 這條第一版寫成 `src.includes(m[1])` —— **自我指涉、等於沒驗**:
//    文案本身就在 `src` 裡,隨便亂寫一個分頁名也會通過(注入缺陷時實測照樣綠)。
//    ⭐ 正解:那個名稱必須出現在 **`_edgeEntryHelpText` 這個函式以外**的地方
//       (= 真的有那顆分頁按鈕),⛔ 不能只是它自己講了一次。
{
    const a = src.indexOf('_edgeEntryHelpText() {');
    const b = src.indexOf('_tagPush(arr, detName, data)');
    const outside = (a > 0 && b > a) ? (src.slice(0, a) + src.slice(b)) : src;
    ok('⑤b 🚨 指的那個分頁名稱**真的有那顆按鈕**(⛔ 指路指錯比不指還糟)',
        !!m && outside.includes(m[1]), m ? m[1] : '');
}

// ⑥⑦ 時機與成本限制
ok('⑥ 要寫出「訊號當天尾盤買」的時機限制', /尾盤買/.test(t) && /隔天開盤/.test(t));
ok('⑦ 教學要寫「沒有扣交易成本」', /沒有扣交易成本|沒扣交易成本/.test(R.help), R.help.slice(-160));

// ⑧ 已接上
ok('⑧ 已接進 _showEdgeHelp(⛔ 寫了沒接上等於沒做)',
    R.help.includes('起漲點') && R.help.length > t.length, String(R.help.length));
ok('⑧b 靜態:_showEdgeHelp 有呼叫 _edgeEntryHelpText',
    /_edgeEntryHelpText\(\)/.test(src) && (src.match(/_edgeEntryHelpText\(\)/g) || []).length >= 1);

ok('⑨ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ EDGEENTRY_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
