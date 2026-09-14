#!/usr/bin/env node
/**
 * 🖼️ 本站自己畫的一頁圖(#rpOwn,V76.3.4)
 *
 * 使用者:「AI 做圖…沒有產出,直接是一鍵可以複製版本,請修正」「⛔ 不要把原本的刪除,直接新增一張卡片」。
 * ⭐ 釘的是**用意**:
 *   ⓐ 真的有畫出東西(⛔ 不是空白 canvas —— 那跟「沒有產出」是同一件事)
 *   ⓑ 數字**來自本站算好的**,⛔ 不是寫死在畫圖程式裡(改來源 → 畫面要跟著變)
 *   ⓒ 台股**紅漲綠跌**(外部 AI 那張圖就是在這裡自打嘴巴的)
 *   ⓓ ⛔ 不顯融合總分(陷阱 #38:憑空權重的分數不可當結論)
 *   ⓔ ⛔ 原本那張「外部 AI 圖」還在(使用者明示不要刪)
 *   ⓕ 免責不可省
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
const fail = [];
const ck = (ok, m) => { if (!ok) fail.push(m); };

// ── ⓔ 原本那張外部 AI 圖不可被刪掉 ──────────────────────────────
ck(/id="rpImg"/.test(SRC) && /_rpImgHtml\(/.test(SRC), 'ⓔ 原本那張外部 AI 圖(#rpImg)不見了 —— 使用者明示⛔ 不要刪除,只能新增');
ck(SRC.indexOf('id="rpOwn"') < SRC.indexOf('id="rpImg"'),
   'ⓔ2 本站自己畫的那張要排在外部 AI 圖**之前**(主結論最大,⛔ 外部 AI 的東西不可壓在本站結論上面)');
// ⚠️ 原始碼斷言先剝 `//` 註解(本 repo 被自己的註解救活斷言已經三次)
const code = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fn = code.slice(code.indexOf('_rpDrawOwn(sym) {'), code.indexOf('_rpOwnSave(sym) {'));
ck(fn.length > 1000, 'ⓓ0 切不到 _rpDrawOwn → 這一輪不算數(空過守門)');
ck(!/_lastGauge\s*\.\s*total|G\.total|\btotal\b/.test(fn),
   'ⓓ 圖上出現了「融合總分」—— ⛔ 那是憑空權重的分數(陷阱 #38),只准畫各面向分數');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._rpDrawOwn === 'function', null, { timeout: 25000 });

const r = await page.evaluate(async () => {
    const A = window.app || app;
    A.switchAppTab('diag'); await A.analyze('2330');
    await new Promise(r => setTimeout(r, 4000));
    A.switchSubTab('report');
    for (let i = 0; i < 16; i++) { await new Promise(r => setTimeout(r, 600)); if (document.getElementById('rpOwnCv')) break; }
    const cv = document.getElementById('rpOwnCv');
    if (!cv) return { no: 'canvas' };
    const g = cv.getContext('2d');
    // 「畫了東西沒有」= 非背景色的像素數
    const ink = () => { const d = g.getImageData(0, 0, cv.width, Math.min(cv.height, 500)).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) n++; return n; };
    // 🎨 現價那一列的顏色(紅漲綠跌)—— 取「現價大字」那一帶
    // ⚠️ 取樣範圍要**只框住現價那幾個字** —— 框太大會把「近 20 日」那行(顏色是另一個方向)
    //   跟價格位置尺的琥珀色一起算進來,兩邊就分不出來了(第一版就是這樣假失敗的)。
    //   canvas 是照 devicePixelRatio 放大的 → 座標要乘上 k。
    const k = cv.width / 1080;
    const hue = () => { const d = g.getImageData(0, Math.round(96 * k), Math.round(cv.width * 0.42), Math.round(60 * k)).data; let R = 0, G2 = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i] > 120 && d[i] > d[i + 1] + 40) R++; if (d[i + 1] > 120 && d[i + 1] > d[i] + 40) G2++; }
        return { R, G: G2 }; };
    const base = { ink: ink(), png: cv.toDataURL('image/png').length };
    A._rpLast.chg = 5.5; A._rpDrawOwn('2330'); const up = hue();
    A._rpLast.chg = -5.5; A._rpDrawOwn('2330'); const dn = hue();
    // ⓑ 數字不是寫死的:改本站算好的那個值 → 圖要變
    // ⚠️ 整張圖的指紋不夠 —— 只要有一格還在讀真資料,整張就會變,**現價那幾個字寫死照樣過**
    //   (第一版的注入②「把現價寫死」就這樣溜過去了)。⭐ 要再單獨比**現價那一塊**。
    const sig = () => { const d = g.getImageData(0, Math.round(96 * k), Math.round(cv.width * 0.42), Math.round(60 * k)).data;
        let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647; return h; };
    A._rpLast.chg = 0; A._rpDrawOwn('2330'); const a1 = cv.toDataURL('image/png'), s1 = sig();
    A._rpLast.pC = (+A._rpLast.pC || 100) * 2 + 7; A._rpDrawOwn('2330'); const a2 = cv.toDataURL('image/png'), s2 = sig();
    return { ...base, up, dn, same: a1 === a2, pxSame: s1 === s2, w: cv.width, h: cv.height };
});
await browser.close();

ck(!r.no, 'ⓐ0 報告頁上找不到那張 canvas → 這一輪不算數');
if (!r.no) {
    ck(r.ink > 5000, `ⓐ 畫出來幾乎是空白的(只有 ${r.ink} 個非背景像素)→ 跟「沒有產出」是同一件事`);
    ck(r.png > 20000, `ⓐ2 存出來的 PNG 只有 ${r.png} 位元組,太小 → 圖是空的`);
    ck(r.w >= 900, `ⓐ3 圖只有 ${r.w}px 寬 → 存下來看不清楚`);
    ck(r.up.R > r.up.G * 2, `ⓒ 上漲時現價不是紅的(紅 ${r.up.R} / 綠 ${r.up.G})→ ⛔ 違反台股紅漲綠跌`);
    ck(r.dn.G > r.dn.R * 2, `ⓒ2 下跌時現價不是綠的(紅 ${r.dn.R} / 綠 ${r.dn.G})→ ⛔ 違反台股紅漲綠跌`);
    ck(!r.same, 'ⓑ 改掉本站算好的收盤價之後圖完全沒變 → 數字是寫死在畫圖程式裡的(⛔ 那就會騙人)');
    ck(!r.pxSame, 'ⓑ2 改掉收盤價之後**現價那幾個字**沒變 → 它是寫死的(⛔ 圖上印一個跟本站不一樣的價格最會害人)');
}

// ── ⓕ 免責 ─────────────────────────────────────────────────
ck(/不是買賣建議/.test(fn), 'ⓕ 圖上沒寫「⛔ 不是買賣建議」');
ck(/沒有經過 AI|不是 AI 畫的/.test(fn + SRC), 'ⓕ2 沒有講清楚「這張圖不是 AI 畫的」(那正是它跟上面那張的差別)');

if (fail.length) { console.log('❌ RPOWN_FAIL'); fail.forEach(f => console.log('   ・' + f)); process.exit(1); }
console.log('✅ RPOWN_PASS(全部通過)');
