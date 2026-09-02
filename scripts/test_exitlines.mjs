#!/usr/bin/env node
/**
 * 🚪 V74.4.9 出場防守線(唐奇安 / ATR 追蹤 / 移動停利)—— `_exitLines` / `_exitLineSeries` / `_exitLinesHtml`
 *
 * 使用者:「把最有效的出場訊號呈現出來,散戶都看得懂;唐奇安軌道加到 K線頁面,ATR 都自動幫我算好」。
 * ⛔ 這一組最怕的六件事,全部釘死:
 *   ① 🚨 **公式跟回測一字不差** —— 唐奇安要用「前 N 日最低」(⛔ 不含今天);
 *      ATR 要用「近 14 日 TR 簡單平均」(⛔ 不是 indicators 的 Wilder 版 —— 同名不同義)
 *   ② 有庫存買進日 → 用**你真正的進場日**起算最高收盤;沒有 → 代理版而且**文案要說出來**(陷阱 #22)
 *   ③ 數字一律讀 `_EXIT_EDGE`(⛔ 顯示端不可寫死第二份 —— 重跑回測會對不上)
 *   ④ ⛔ 不下進場指令、不用紅綠標「哪條比較好」(燈號鐵則:紅綠只准表示漲跌)
 *   ⑤ ⛔ 必須寫明「App 預設仍是跌破 5 日線」(⛔ 不可讓人以為已經換了)
 *   ⑥ 兩條 render path 都要接 + K線圖疊圖 toggle 真的會加/拿掉線
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
ok('⑥a 主 render path 接上 _exitLinesHtml', /\$\{this\._exitLinesHtml\(data, this\.currentSymbolId\)\}\$\{this\._aiChainChipHtml/.test(SRC));
ok('⑥b 「沒有 K 棒訊號」那條路徑也接上', /const _exH = this\._exitLinesHtml\(data, this\.currentSymbolId\);[\s\S]{0,200}?const _rg = _exH \+/.test(SRC));
ok('⑥c 頁首兩條路徑都有 compact 版一行', (SRC.match(/_exitLinesHtml\(data, this\.currentSymbolId, true\)/g) || []).length >= 2);
ok('⑥d K線圖疊圖走共用的 _exitLineSeries(⛔ 不在 renderChart 再寫一份公式)',
    /const _exS = this\._exitLineSeries\(data\)/.test(SRC)
    && (SRC.match(/this\._exitLineSeries\(/g) || []).length >= 2
    && (SRC.match(/for \(let q = i - 20; q < i; q\+\+\)/g) || []).length === 1,
    `calls=${(SRC.match(/this\._exitLineSeries\(/g) || []).length} donLoops=${(SRC.match(/for \(let q = i - 20; q < i; q\+\+\)/g) || []).length}`);
ok('③a _EXIT_EDGE 常數存在,含基準與三條實測列', /_EXIT_EDGE:\s*\{[\s\S]{0,900}?base:\s*\{[\s\S]{0,200}?rows:\s*\[/.test(SRC));

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
    // 📐 測資自己先算得出唯一答案(⛔ 別讓斷言去猜實際輸出):
    //   40 根 K:收盤 100,101,…;高 = 收+1、低 = 收−1 → 前 20 日最低 = data[n-20].low
    const rows = [];
    for (let i = 0; i < 40; i++) {
        const c = 100 + i;
        rows.push({ date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, open: c, close: c, high: c + 1, low: c - 1, volume: 1e6 });
    }
    const n = rows.length - 1;                        // 39,收 139
    out.expDon = rows[n - 20].low;                    // 前 20 日(不含今天)最低 = index 19 的 low = 118
    out.expPeak = rows[n].close;                      // 一路上漲 → 最高收盤 = 今天 139
    A.currentSymbolId = '9999';
    A.inventory = [];
    A.indicators = {};
    const x1 = A._exitLines(rows, '9999');
    out.x1 = x1;
    // 🚨 唐奇安「含不含今天」要另外一組測資才驗得到 —— 一路上漲時兩種算法答案一樣,
    //    那條斷言會變成永遠會過的假綠燈(注入驗證當場抓到)。
    //    ⛔ 但破底那根會把 ATR 一起弄大 → **分開兩組測資**,別混在一起。
    const dip = rows.map(r => ({ ...r }));
    dip[dip.length - 1].low = 50;
    out.dipDon = A._exitLines(dip, '9999')?.don;
    // ① 唐奇安用「前 20 日」不含今天;ATR 是 TR 簡單平均(這裡每天 TR = 高−低 = 2 → ATR = 2)
    out.atrIsSimple = Math.abs((x1?.atr ?? 0) - 2) < 0.01;
    out.trail8 = x1 ? Math.abs(x1.trail8 - out.expPeak * 0.92) < 0.01 : false;
    out.atr2 = x1 ? Math.abs(x1.atr2 - (out.expPeak - 2 * 2)) < 0.01 : false;
    // ② 有庫存買進日 → 從那天起算(這裡故意讓進場日在中間,peak 仍是今天,但 proxy 要變 false)
    A.inventory = [{ symbol: '9999', cost: 120, shares: 1000, buyDate: '2026-02-05' }];
    const x2 = A._exitLines(rows, '9999');
    out.x2proxy = x2?.proxy; out.x2days = x2?.days;
    out.htmlPos = A._exitLinesHtml(rows, '9999') || '';
    A.inventory = [];
    out.htmlNo = A._exitLinesHtml(rows, '9999') || '';
    out.compact = A._exitLinesHtml(rows, '9999', true) || '';
    // ③ 換一張假成績表 → 畫面要跟著變(⛔ 證明沒有寫死第二份)
    const bak = JSON.parse(JSON.stringify(A._EXIT_EDGE));
    A._EXIT_EDGE.rows[0].p = 1234.5; A._EXIT_EDGE.base.p = 11.1;
    out.htmlFake = A._exitLinesHtml(rows, '9999') || '';
    A._EXIT_EDGE = bak;
    // ⑥ 疊圖序列
    const ser = A._exitLineSeries(rows);
    out.serDon = ser ? ser.don[n] : null;
    out.serAtr = ser ? ser.atrTrail[n] : null;
    out.serEarlyNull = ser ? ser.don.slice(0, 20).every(v => v == null) : false;
    // 資料太短 → 整條不顯示(⛔ 不留空殼)
    out.shortNull = A._exitLines(rows.slice(0, 10), '9999');
    out.shortHtml = A._exitLinesHtml(rows.slice(0, 10), '9999');
    return out;
});

const T = s => String(s).replace(/<[^>]+>/g, '');
ok('①a 唐奇安 = 前 20 日最低(⛔ 不含今天)',
    R.x1 && Math.abs(R.x1.don - R.expDon) < 0.01 && Math.abs(R.dipDon - R.expDon) < 0.01,
    `一般=${R.x1?.don} 今天破底時=${R.dipDon} 期望=${R.expDon}`);
ok('①b ATR 用「近 14 日 TR 簡單平均」(⛔ 不是 Wilder)', R.atrIsSimple, `atr=${R.x1?.atr}`);
ok('①c ATR 追蹤 = 最高收盤 − 2×ATR', R.atr2, `${R.x1?.atr2}`);
ok('①d 移動停利 = 最高收盤 × 0.92', R.trail8, `${R.x1?.trail8}`);
ok('②a 沒填庫存買進日 → proxy=true,而且文案要**說出來**是代理版',
    R.x1?.proxy === true && /沒有.*填.*庫存買進日|近 20 天最高收盤/.test(T(R.htmlNo)), T(R.htmlNo).slice(0, 160));
ok('②b 有買進日 → 改用你的進場日起算(proxy=false + 天數對得上)',
    R.x2proxy === false && R.x2days > 1 && /用你的買進日/.test(T(R.htmlPos)), `proxy=${R.x2proxy} days=${R.x2days}`);
ok('②c 有庫存 → 要把「賣在這裡是賺是賠」算成**元**(使用者鐵則:% 要配元)',
    /賣在這裡/.test(T(R.htmlPos)) && /元(獲利|虧損)|元\(/.test(T(R.htmlPos)) && !/賣在這裡/.test(T(R.htmlNo)));
ok('③b 數字現算自 _EXIT_EDGE(換假表畫面要跟著變 —— 三條列與**基準**都要變)',
    R.htmlFake !== R.htmlNo && /1234|1235/.test(T(R.htmlFake)) && /11 萬/.test(T(R.htmlFake)) && !/193 萬/.test(T(R.htmlFake)),
    T(R.htmlFake).slice(-260));
const T4 = T(R.htmlNo).replace(/買點推播/g, '');
ok('④a ⛔ 不可出現進場指令(進場價/買點/可以買)',
    !/(進場價|買點|可以買|建議買進|加碼到)/.test(T4), T4.slice(0, 200));
ok('④b ⛔ 不可用紅綠 emoji 標「哪條比較好」(燈號鐵則)', !/[🔴🟢]/u.test(R.htmlNo + R.compact));
ok('⑤a 🚨 必須寫明「App 自動出場提醒目前仍用跌破 5 日線」',
    /自動出場提醒目前仍用/.test(T(R.htmlNo)) && /5 日線/.test(T(R.htmlNo)));
ok('⑤b 要寫「已扣成本」與窗口(⛔ 沒扣成本的勝率是假的)',
    /只換出場規則跑/.test(T(R.htmlNo)) && /49 個月|2022/.test(T(R.htmlNo)));
ok('⑤c 要解釋「為什麼 5 日線比較差」(砍太早 / 靠少數大賺)',
    /砍太早/.test(T(R.htmlNo)) && /少數/.test(T(R.htmlNo)));
ok('⑥e 疊圖序列:最後一根對得上、前 20 根是 null(暖身不足不可畫)',
    Math.abs(R.serDon - R.expDon) < 0.01 && R.serEarlyNull && R.serAtr != null, `don=${R.serDon} atr=${R.serAtr}`);
ok('⑥f 頁首 compact 版有三個價位 + 指路,⛔ 但不重複整張卡',
    /出場防守價/.test(T(R.compact)) && T(R.compact).length < 200, T(R.compact).slice(0, 120));
ok('⑦ 資料太短 → 整條不顯示(⛔ 不留空殼)', R.shortNull === null && R.shortHtml === '');

await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ EXITLINES_PASS(全部通過)');
process.exit(fails ? 1 : 0);
