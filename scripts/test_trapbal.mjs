#!/usr/bin/env node
/**
 * ⚖️ V79.0.1 「上面套牢的量 vs 下面賺錢的量」守門
 * 使用者:「個股的壓力,有幾%套牢那個不見了」—— V79.0.0 拿掉分點時,籌碼頁那條「上面想逃的人 vs 下面挺你的人」
 * (分點均價版)一起被刪。改用 K 線成交量重做,數字只來自 `_trappedRatio`(⛔ 不另算)。
 *
 * 釘住的用意:
 *   ① 百分比 = 近 120 日典型價 > 現價的成交量佔比;unlockPx = 那部分的量加權典型價
 *   ② ⭐ 決定性對照:上方那段量 ×2 → 百分比要跟著變大
 *   ③ `_trappedRatio` 原本的 pct / tag / w60 對同一份資料一字不變(判定沒被偷改)
 *   ④ 籌碼頁畫得出 [data-trapbal];⛔ 不准寫「幾 % 的人」、⛔ 不下買賣指令;指數 / K 線不足 → 整格藏起來
 *   ⑤ 總覽價格位置圖那一行 = 同一個數字;報告頁那一列也是同一個數字且⛔ 不再寫「人」
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.TB_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(FILE, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails++; };

// 靜態:總覽那一行真的被放進價格位置圖的輸出(⛔ 不可算了不畫)
const rStart = SRC.indexOf('    _priceRulerHtml() {');
const rBody = SRC.slice(rStart, SRC.indexOf('\n    _ovEmergencyBar()', rStart));
ok('⑤ 🚧 空過守門:抓得到 _priceRulerHtml 的本體', rStart > 0 && rBody.length > 3000 && rBody.length < 40000, rBody.length);
ok('⑤ 價格位置圖的輸出有 ${trapLine}', /\$\{farTxt\}\$\{trapLine\}/.test(rBody), '');
ok('⑤ trapLine 讀 _trapBalanceLine(⛔ 不自己算)', /_trapBalanceLine\(/.test(rBody) && !/_trappedRatio\(/.test(rBody), '');
ok('④ 報告頁那一列⛔ 不再寫「買進的人還在賠錢」', !SRC.includes('買進的人還在賠錢的比例'), '');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = String(e && e.message || e); if (!/echarts|vibrate|Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto(pathToFileURL(FILE).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._trappedRatio, null, { timeout: 30000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    // 前 60 根在 120 元成交(量 2,000,000 股)、後 80 根在 100 元(量 1,000,000 股)
    const mk = (hiVol) => {
        const rows = [];
        for (let i = 0; i < 140; i++) {
            const px = i < 60 ? 120 : 100, v = i < 60 ? hiVol : 1e6;
            const d = new Date(2025, 0, 1 + i);
            rows.push({ date: d.toISOString().slice(0, 10).replace(/-/g, '/'), open: px, high: px, low: px, close: px, volume: v });
        }
        return rows;
    };
    const a = A._trappedRatio(mk(2e6)), b = A._trappedRatio(mk(4e6));
    out.a = a; out.b = b;
    // 期望值:窗口最後 121 根 = 41 根 @120 + 80 根 @100
    out.expA = 41 * 2e6 / (41 * 2e6 + 80 * 1e6) * 100;
    out.expB = 41 * 4e6 / (41 * 4e6 + 80 * 1e6) * 100;
    // 籌碼頁
    A.currentSymbolId = '9988'; A.rawDailyData = mk(2e6); A.activeData = A.rawDailyData;
    A._upsideStash = null;
    A._renderTrapBal();
    const el = document.getElementById('chipTrapBal');
    out.chipCls = el ? el.className : 'MISSING';
    out.chipTxt = el ? el.innerText.replace(/\s+/g, ' ') : '';
    out.chipAttr = el && el.querySelector('[data-trapbal]') ? el.querySelector('[data-trapbal]').getAttribute('data-trapbal') : null;
    // 總覽那一行
    out.line = A._trapBalanceLine(A.rawDailyData, '9988');
    // K 線不足 → 藏起來
    A.rawDailyData = mk(2e6).slice(0, 100);
    A._renderTrapBal();
    out.shortCls = el ? el.className : 'MISSING';
    out.shortLine = A._trapBalanceLine(A.rawDailyData, '9988');
    // 指數 → 藏起來
    A.currentSymbolId = '^TWII'; A.rawDailyData = mk(2e6);
    A._renderTrapBal();
    out.idxCls = el ? el.className : 'MISSING';
    return out;
});
await browser.close();

ok('① 百分比 = 現價上方的成交量佔比', R.a && Math.abs(R.a.pct - R.expA) < 0.01, JSON.stringify({ got: R.a && R.a.pct, exp: R.expA }));
ok('① unlockPx = 上方那部分的量加權典型價(120)', R.a && Math.abs(R.a.unlockPx - 120) < 0.01, R.a && R.a.unlockPx);
ok('① 張數 = 股 ÷ 1000', R.a && R.a.aboveLots === 82000 && R.a.belowLots === 80000, JSON.stringify(R.a && [R.a.aboveLots, R.a.belowLots]));
ok('② ⭐ 決定性對照:上方那段量 ×2 → 百分比變大且等於期望值', R.b && R.b.pct > R.a.pct + 10 && Math.abs(R.b.pct - R.expB) < 0.01, JSON.stringify({ a: R.a && R.a.pct, b: R.b && R.b.pct }));
ok('③ 原有分段沒被改(50.6% → ➖ 一半左右套牢、w60 25.2)', R.a && R.a.tag === '➖ 一半左右套牢' && R.a.w60 === 25.2 && R.a.baseW60 === 25.9, JSON.stringify(R.a));
ok('④ 籌碼頁畫出 [data-trapbal] 且是同一個百分比', R.chipCls === '' && R.chipAttr === String(Math.round(R.expA)), JSON.stringify({ cls: R.chipCls, attr: R.chipAttr }));
ok('④ 文字有「套牢」「賺錢」與百分比、解套價 120', /套牢/.test(R.chipTxt) && /賺錢/.test(R.chipTxt) && R.chipTxt.includes(`${Math.round(R.expA)}%`) && /120/.test(R.chipTxt), R.chipTxt);
ok('④ ⛔ 不准寫「幾 % 的人」', !/%\s*的人|的人套|人人/.test(R.chipTxt) && /成交量/.test(R.chipTxt), R.chipTxt);
ok('④ ⛔ 不下買賣指令', !/(該賣|先賣|快賣|進場|買點|加碼|減碼)/.test(R.chipTxt), R.chipTxt);
ok('④ K 線不足 140 根 → 整格藏起來(⛔ 不留空殼)', R.shortCls === 'hidden' && R.shortLine === '', JSON.stringify({ cls: R.shortCls, line: R.shortLine }));
ok('④ 指數 → 整格藏起來', R.idxCls === 'hidden', R.idxCls);
ok('⑤ 總覽那一行 = 同一個百分比 + 解套價', /data-trapline="51"/.test(R.line) && /120/.test(R.line) && /成交量/.test(R.line), R.line);
ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ TRAPBAL_PASS(全部通過)');
process.exit(fails ? 1 : 0);
