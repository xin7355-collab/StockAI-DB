#!/usr/bin/env node
/**
 * 🕯️ V74.4.4 「跌停後的第一根紅K」落地測試(`_ldRedKHtml` / `_fillLdMkt` / `_ensureTwiiChgMap`)
 *
 * 這條是 streak_probe 六關全過的型態,但落地最怕三件事,全部釘死:
 *   ① 定義跟探針**一字不差**:跌停 = ≤−9.2%、紅K = 跌停的**隔一個交易日**就收漲
 *      (⛔ 任意天後的第一根紅不算 —— 那是另一個沒測過的東西)
 *   ② 🚨 必須顯示「當初大盤有沒有一起跌」—— 兩組差 4.8 倍(+4.89% vs +1.02%),
 *      不顯示的話使用者會拿系統性那組的數字去接個股利空的刀
 *   ③ ⛔ 不下操作指令、不給買賣價位(K線頁是解讀頁);小紅要講「參考價值低很多」
 *   ④ 數字讀 _LD_REDK 常數(⛔ 顯示端不可寫死第二份)
 *   ⑤ 切股殘留守門:_fillLdMkt 回來時 sym 不同就不可以填
 *   ⑥ 兩條 render path 都要接(⛔ 只接一處 = 只有剛好有 K 棒訊號的日子才出現)
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

// ── 靜態:接線 ──
ok('⑥a 主 render path 接上 _ldRedKHtml',
    /\$\{this\._luOddsHtml\(data\)\}\$\{this\._ldRedKHtml\(data, this\.currentSymbolId\)\}/.test(SRC));
ok('⑥b 「沒有 K 棒訊號」那條路徑也接上',
    /const _rg = [\s\S]{0,120}?this\._ldRedKHtml\(data, this\.currentSymbolId\)/.test(SRC));
ok('④a _LD_REDK 常數存在且四組數字齊(all/big/sys/idio)',
    /_LD_REDK:\s*\{\s*all:.*big:.*sys:.*idio:/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;                      // 陷阱 #5:const app 不掛 window
    const out = {};
    const mk = (chgPrev, chgLast) => {
        // 造 K 線:…普通日 × 30 → 跌停日 → 今天
        const rows = [];
        let px = 100;
        for (let i = 0; i < 30; i++) { rows.push({ date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, open: px, close: px, high: px + 1, low: px - 1, volume: 1e6 }); }
        px = px * (1 + chgPrev / 100);
        rows.push({ date: '2026-08-28', open: px * 1.02, close: px, high: px * 1.03, low: px, volume: 3e6 });
        const p2 = px * (1 + chgLast / 100);
        rows.push({ date: '2026-08-29', open: px, close: p2, high: p2 * 1.01, low: px * 0.99, volume: 2e6 });
        return rows;
    };
    A.currentSymbolId = '2409';
    // ① 觸發:昨天 −9.5%、今天 +3.5%(大紅)
    out.hit = A._ldRedKHtml(mk(-9.5, 3.5), '2409') || '';
    // 小紅
    out.small = A._ldRedKHtml(mk(-9.5, 1.2), '2409') || '';
    // 不觸發:跌 −8%(沒到跌停)/ 今天收黑 / 跌停在 3 天前(中間隔一根黑K)
    out.no1 = A._ldRedKHtml(mk(-8.0, 3.5), '2409') || '';
    out.no2 = A._ldRedKHtml(mk(-9.5, -1.0), '2409') || '';
    {
        const rows = mk(-9.5, -1.0);
        const px = rows[rows.length - 1].close * 1.04;
        rows.push({ date: '2026-08-30', open: px, close: px, high: px, low: px, volume: 1e6 });
        out.no3 = A._ldRedKHtml(rows, '2409') || '';
    }
    // ② 大盤那格:stub _getTwiiRows → 系統性 / 個股利空 兩個分支
    document.body.insertAdjacentHTML('beforeend', '<div id="_t1"></div>');
    A._twiiChgMap = null;
    A._getTwiiRows = async () => [
        { date: '2026-08-27', close: 24000 }, { date: '2026-08-28', close: 23500 }, { date: '2026-08-29', close: 23600 }];
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="2409">⏳</span>';
    await A._fillLdMkt('2026-08-28', '2409');
    out.sysTxt = document.getElementById('ldRedkMkt').innerText;
    // 個股利空分支(那天大盤 +0.4%)
    A._twiiChgMap = null;
    A._getTwiiRows = async () => [
        { date: '2026-08-27', close: 24000 }, { date: '2026-08-28', close: 24100 }, { date: '2026-08-29', close: 24000 }];
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="2409">⏳</span>';
    await A._fillLdMkt('2026-08-28', '2409');
    out.idioTxt = document.getElementById('ldRedkMkt').innerText;
    // ⑤ 切股殘留:sym 對不上就不可以填
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="9999">⏳</span>';
    await A._fillLdMkt('2026-08-28', '2409');
    out.staleTxt = document.getElementById('ldRedkMkt').innerText;
    // 查不到那天 → 誠實說 + 給兩組差距(⛔ 不可裝死也不可硬判)
    document.getElementById('_t1').innerHTML = '<span id="ldRedkMkt" data-sym="2409">⏳</span>';
    await A._fillLdMkt('2019-01-01', '2409');
    out.missTxt = document.getElementById('ldRedkMkt').innerText;
    // ⑦ V74.4.5 總覽提醒(使用者:「把滿足條件的加入總覽頁面提醒」)
    A.attentionStatus = {};
    out.ovHit = (A._ovNewEdges(mk(-9.5, 3.5), '2409') || []).map(x => x.txt).join(' ');
    out.ovNo = (A._ovNewEdges(mk(-8, 3.5), '2409') || []).length;
    // 噴 ≥30% + 在注意股名單 → 減碼提醒
    {
        const rows = [];
        let px = 100;
        for (let i = 0; i < 30; i++) rows.push({ date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, open: px, close: px, high: px, low: px, volume: 1e6 });
        for (let i = 0; i < 5; i++) { px *= 1.07; rows.push({ date: `2026-08-2${i + 1}`, open: px, close: px, high: px, low: px, volume: 2e6 }); }
        A.attentionStatus = { '2409': { status: '⚠️ 注意股' } };
        out.ovAtt = (A._ovNewEdges(rows, '2409') || []).map(x => x.txt).join(' ');
        A.attentionStatus = {};
        out.ovAttNo = (A._ovNewEdges(rows, '2409') || []).length;   // 沒在名單 → ⛔ 不可提醒
    }
    out.E = A._LD_REDK;      // ⭐ 數字一律從常數帶(⛔ 測試不寫死)
    return out;
});
await browser.close();
const E = R.E || {};

ok('🚧 空過守門:抓得到 _LD_REDK 常數', !!E && E.big > 0 && E.sys > 0, JSON.stringify(E));
// 🚨 ⛔ 渲染端不可自己寫死百分比(那樣重跑回測改了常數,畫面還是舊數字)——
//    測試自己也從常數讀,所以一定要另外釘這條,否則兩邊一起錯也會通過。
{
    const i = SRC.indexOf('_ldRedKHtml(data, sym)');
    const seg = SRC.slice(i, SRC.indexOf('\n    async _fillLdMkt', i));
    ok('④c ⛔ 渲染端不可寫死百分比(一律讀 _LD_REDK)',
        seg.length > 500 && !/\+\$\{?\d\.\d{2}%/.test(seg) && !/多 <b[^>]*>\+\d/.test(seg), seg.length);
}
ok('①a 🚧 空過守門:跌停(−9.5%)+紅K 真的觸發', R.hit.length > 300, `len=${R.hit.length}`);
ok('①b −8%(沒到跌停)/ 收黑 / 隔了一根才紅 → 都不觸發(⛔ 定義要跟探針一字不差)',
    R.no1 === '' && R.no2 === '' && R.no3 === '', `${R.no1.length}/${R.no2.length}/${R.no3.length}`);
// ⚠️ V74.2.8 起數字一律**從 `_LD_REDK` 帶入**,⛔ 測試不可寫死
//    (含 2022 空頭重跑之後整張表都變了;寫死等於每次重跑都要改測試,而且會誤以為程式壞了)。
// 🧹 V78.3.6 散戶 App ⛔ 不印回測數字(+x% / 勝率 / 基準搬到產業作戰室)→ 改釘:數字⛔ 不出現 + 白話「之後多半會彈」還在
ok('④b 🧹 V78.3.6 大紅那組⛔ 不印實測數字與勝率(_LD_REDK.big / wrBig / base),只講「之後多半會彈」',
    !R.hit.includes(`+${E.big}%`) && !R.hit.includes(`${E.wrBig}%`) && !R.hit.includes(`${E.base}%`) && /之後多半會彈/.test(R.hit),
    R.hit.slice(0, 120));
ok('③a 小紅要講「參考價值低很多」而且⛔不可顯大紅那組數字',
    /參考價值低/.test(R.small) && !R.small.includes(`+${E.big}%`));
ok('②a 系統性分支:那天大盤 −2.1% → 顯「系統性」+ 白話「跌完多半會彈」(🧹 V78.3.6 ⛔ 不印那組實測數字)',
    /系統性/.test(R.sysTxt) && /多半會彈/.test(R.sysTxt) && !R.sysTxt.includes(`+${E.sys}%`), R.sysTxt.slice(0, 60));
ok('②b 個股利空分支:顯「別急著接」(⛔ 不講的話使用者會去接刀;🧹 V78.3.6 ⛔ 不印那組實測數字)',
    /個股自己出事/.test(R.idioTxt) && /別急著接/.test(R.idioTxt) && !R.idioTxt.includes(`+${E.idio}%`), R.idioTxt.slice(0, 60));
ok('⑤ 切股殘留守門:sym 對不上不可以填(還是 ⏳)', R.staleTxt === '⏳', R.staleTxt);
ok('②c 🧹 V78.3.6 查不到那天 → 誠實說 + 講兩種情況差很多,⛔ 不印數字',
    /查不到/.test(R.missTxt) && /差很多/.test(R.missTxt) && !R.missTxt.includes(`+${E.sys}%`) && !R.missTxt.includes(`+${E.idio}%`), R.missTxt.slice(0, 60));
ok('③b ⛔ 不下操作指令(買進/加碼/停損價/目標價都不可出現)+ 要指路總覽',
    !/買進|加碼|停損價|目標價|掛單/.test(R.hit) && /現在怎麼做/.test(R.hit));
// 🧹 V78.3.6 「回測進場點(隔天開盤)」是研究說明 → 已不印;改釘「不是進場指令」+ ⛔ 不出現回測/實測字樣
ok('③c 要寫「不是進場指令」(🧹 V78.3.6 ⛔ 不再寫回測進場點,⛔ 不可出現回測/實測/勝率字樣)',
    /不是進場指令/.test(R.hit) && !/回測|實測|勝率|期望值|基準/.test(R.hit + R.small + R.sysTxt + R.idioTxt));

// 🧹 V78.3.4 散戶 App ⛔ 不印回測數字(+x% 的差距搬到產業作戰室),但「先看大盤有沒有一起跌」這個做法要講
ok('⑦a 總覽提醒:跌停後紅K 命中要出現,講「先看大盤有沒有一起跌」,⛔ 不印回測數字',
    /昨天跌停/.test(R.ovHit) && /大盤有沒有一起跌/.test(R.ovHit) && !R.ovHit.includes(String(E.sys)) && !/實測/.test(R.ovHit), R.ovHit.slice(0, 100));
ok('⑦b 總覽提醒:沒到跌停(−8%)⛔ 不可觸發', R.ovNo === 0, String(R.ovNo));
ok('⑦c 總覽提醒:噴 ≥30% 且在官方注意股名單 → 減碼提醒(⛔ 不是放空訊號)',
    /考慮減碼/.test(R.ovAtt) && !/1\.81|實測/.test(R.ovAtt) && /不是放空訊號/.test(R.ovAtt), R.ovAtt.slice(0, 100));
ok('⑦d ⛔ 沒在官方注意股名單就不可以提醒(⛔ 不可自己推估誰會被列注意)', R.ovAttNo === 0, String(R.ovAttNo));
ok('⑦e 接線:總覽的重點判讀真的有呼叫 _ovNewEdges',
    /for \(const r of \(this\._ovNewEdges\(data, sym\) \|\| \[\]\)\) rows\.push\(r\);/.test(SRC));

// ⏱️ V74.8.7 逐日曲線量出來的「多久反應、多久走」
ok('⑧ ⏱️ 大紅那組要寫出「前 5 天走完幾成 / 幾天到頂 / 60 天剩多少」(⛔ 那是使用者問的「多久離場」)',
    /多久反應/.test(R.hit) && R.hit.includes(`${E.tm.r5big} 成`)
    && R.hit.includes(`${E.tm.top} 個交易日到頂`) && R.hit.includes(`${E.tm.keepBig}%`), R.hit.slice(0, 60));
ok('⑧a ⏱️ 小紅(系統性口徑)要用**它自己那組**的比例,⛔ 不可套大紅那組',
    R.small.includes(`${E.tm.r5sys} 成`) && R.small.includes(`${E.tm.keepSys}%`)
    && !R.small.includes(`${E.tm.r5big} 成`));
// 🧹 V78.3.6 上面那個 +% 已不印 → 畫面只剩「幾成 / 剩幾 %」比例,⛔ 不可再出現 +N% 的報酬數字(同名不同義的來源消失了)
ok('⑧b 🧹 V78.3.6 卡上只剩比例(幾成),⛔ 不可再出現 +N% 的報酬數字跟它混在一起',
    /成/.test(R.hit) && !/\+\d+(\.\d+)?%/.test(R.hit.replace(/<[^>]+>/g, ' ')), R.hit.replace(/<[^>]+>/g, ' ').match(/\+\d+(\.\d+)?%/g));
ok('⑧c ⛔ 數字不可寫死在文案 —— 只准透過 E.tm.* 取值', (() => {
      const i = SRC.indexOf('_ldRedKHtml(');
      const src = SRC.slice(i, SRC.indexOf('\n    },', i));
      return /E\.tm\.r5big/.test(src) && /E\.tm\.top/.test(src) && /E\.tm\.keepBig/.test(src)
          && /E\.tm\.r5sys/.test(src) && /E\.tm\.keepSys/.test(src);
    })());

console.log(fails ? `❌ ${fails} 條失敗` : '✅ LDREDK_PASS(全部通過)');
process.exit(fails ? 1 : 0);
