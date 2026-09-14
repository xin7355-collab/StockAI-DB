#!/usr/bin/env node
/**
 * 🧱 版面空間測試(V76.3.2)—— 使用者:「螢幕可觀看地方變窄、字體調到最小還是很大、庫存版面調一下」。
 *
 * ⭐ 釘的是**用意**不是當時的數字:
 *   ① 桌機的個股置頂要「並排」(股名列與現價列同一列)—— ⛔ 不是「高度剛好 65px」
 *   ② 手機**一行都不能被改到**(上下疊照舊)—— 桌機的修法不可以外溢到手機
 *   ③ 庫存表桌機要把寬度用滿(以前寫死 466px,右邊 714px 永遠空著);手機仍維持 ≥466px 橫捲
 *   ④ 字級「小」要真的讓 `text-[10px]` 變 10px —— 舊版那張**無條件**放大表讓「小」對它完全沒作用
 *
 * ⚠️ 沙箱沒有 Tailwind(CDN),所以這支**只驗寫在 index.html 裡的 CSS 與 inline 樣式**
 *   —— 上面四條剛好全部都是自家 CSS,⛔ 但別拿它當「全站版面沒問題」的保證。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const ck = (ok, msg) => { if (!ok) fail.push(msg); };
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});

const open = async (w, h) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    // 🧩 沒有這一行,量到的幾何全是假的(沙箱沒有 Tailwind)—— ⛔ 共用那一份,別複製第二份
    const bad = await page.evaluate(rwdShim);
    ck(!bad.length, '🧩 版面 shim 有規則沒生效(' + bad.join('・') + ')→ ⛔ 這一輪量到的數字全部不算數');
    return page;
};

// ── ①② 個股置頂:桌機並排 / 手機上下疊 ────────────────────────────────
for (const [w, h, mode] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
    const page = await open(w, h);
    const r = await page.evaluate(async () => {
        const A = window.app || app;
        try { A.switchAppTab('diag'); await A.analyze('2330'); } catch (_) {}
        await new Promise(r => setTimeout(r, 2500));
        const box = document.getElementById('quoteHeadBox');
        const n = document.getElementById('quoteRowName'), p = document.getElementById('quoteRowPrice');
        if (!box || !n || !p) return null;
        const a = n.getBoundingClientRect(), b = p.getBoundingClientRect();
        return { boxH: Math.round(box.getBoundingClientRect().height),
                 sameLine: Math.abs(a.top - b.top) < 12, nameH: Math.round(a.height), priceH: Math.round(b.height) };
    });
    await page.close();
    // 🚧 空過守門:量不到就是量不到,⛔ 不可靜默當成通過
    ck(r && r.nameH > 10 && r.priceH > 10, `①${mode} 量不到個股置頂(股名列/現價列高度為 0)→ 這一輪不算數`);
    if (!r) continue;
    if (mode === 'desk') {
        ck(r.sameLine, `① 桌機:股名列與現價列**沒有並排**(top 差 >12px)→ 桌機版面壓縮沒生效`);
        // 並排之後整塊一定明顯比「上下疊」矮 —— 門檻抓寬一點,釘用意不釘數字
        ck(r.boxH <= 100, `① 桌機:個股置頂 ${r.boxH}px,超過 100px → 並排沒省到空間`);
    } else {
        ck(!r.sameLine, `② 手機:股名列與現價列變成並排了 → ⛔ 桌機的修法外溢到手機`);
        ck(r.boxH >= 110, `② 手機:個股置頂只有 ${r.boxH}px,比預期矮 → 手機版面被改到了`);
    }
}

// ── ③ 庫存表寬度 ────────────────────────────────────────────────────
for (const [w, h, mode] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
    const page = await open(w, h);
    const r = await page.evaluate(async () => {
        const A = window.app || app;
        // ⭐ 測資:沒有庫存就沒有列可以量(空過守門會抓到)
        A.inventory = [{ symbol: '2330', cost: 1000, shares: 2 }, { symbol: '2317', cost: 200, shares: 5 }];
        try { A.switchAppTab('inv'); A.renderInventory(); } catch (_) {}
        await new Promise(r => setTimeout(r, 800));
        const row = document.querySelector('#inventoryCardContainer [data-inv-sym]');
        const wrap = document.querySelector('#inventoryCardContainer')?.parentElement;
        if (!row || !wrap) return null;
        const head = document.querySelector('#inventoryCardContainer')?.previousElementSibling;
        const rr = row.getBoundingClientRect(), last = row.lastElementChild.getBoundingClientRect();
        return { rowW: Math.round(rr.width),
                 wrapW: Math.round(wrap.getBoundingClientRect().width),
                 // 🚨 ⛔ 不可只量「列有多寬」—— grid 容器本來就會撐滿父層,欄位寫死 px 時它**照樣**是滿的,
                 //   空的是**右邊那一片沒有欄位的區域**。第一版就是這樣漏掉注入③(假綠燈)。
                 //   ⭐ 要量的是「最後一欄的右緣離列的右緣多遠」。
                 tail: Math.round(rr.right - last.right),
                 rowH: Math.round(rr.height),
                 // 🚨 `w-max` → `w-full` 之後外框不再被內容撐開 → 外框的 min-w **必須**把
                 //   「六欄最小寬 + 5 個間距 + 左右 padding」全算進去,否則手機上欄位會被擠爆。
                 //   ⛔ 這種溢出被 overflow 夾著 → 不會有元素「衝出父容器」,只能用 scrollWidth 抓。
                 squeeze: row.scrollWidth - row.clientWidth,
                 headSqueeze: head ? head.scrollWidth - head.clientWidth : -1,
                 cols: getComputedStyle(row).gridTemplateColumns.split(/\s+/).length };
    });
    await page.close();
    ck(r && r.rowW > 100, `③${mode} 量不到庫存列 → 這一輪不算數`);
    if (!r) continue;
    ck(r.cols === 6, `③${mode} 庫存列不是 6 欄(量到 ${r.cols})`);
    if (mode === 'desk') {
        ck(r.rowW >= 800, `③ 桌機:庫存列只有 ${r.rowW}px(容器 ${r.wrapW}px)→ 寬度沒有用滿,右邊還空著`);
        ck(r.tail <= 24, `③ 桌機:最後一欄的右邊還空著 ${r.tail}px(列寬 ${r.rowW}px)→ 欄位沒有跟著把寬度分掉`);
    } else {
        ck(r.rowW >= 466, `③ 手機:庫存列只有 ${r.rowW}px,少於 466px → 欄位被壓窄了(⛔ 手機要維持橫捲)`);
    }
    ck(r.rowH <= 56, `③${mode} 庫存列高 ${r.rowH}px > 56 → 沒有壓縮到`);
    ck(r.squeeze <= 4 && r.headSqueeze <= 4, `③${mode} 庫存表被擠爆(列 +${r.squeeze}px ・表頭 +${r.headSqueeze}px)→ 外框 min-w 沒把間距與 padding 算進去`);
}

// ── ④ 字級「小」真的會變小 ──────────────────────────────────────────
{
    const page = await open(390, 844);
    const r = await page.evaluate(() => {
        const d = document.createElement('div'); d.className = 'text-[10px]'; d.textContent = 'x';
        document.body.appendChild(d);
        const get = f => { document.documentElement.setAttribute('data-font', f); return parseFloat(getComputedStyle(d).fontSize); };
        const out = { small: get('small'), medium: get('medium'), xl: get('xl') };
        d.remove(); return out;
    });
    await page.close();
    // 🚧 空過守門:沙箱裡 `text-[10px]` 的規則是 index.html 自己寫的(V44.2 那張表)→ 一定量得到
    ck(r.medium > 0, '④ 量不到 text-[10px] 的字級 → 這一條不算數');
    ck(r.small < r.medium, `④ 字級「小」沒有比「中」小(小 ${r.small}px vs 中 ${r.medium}px)→ 「最小字體」這個選項對密集字沒有作用`);
    ck(r.small <= 10.5, `④ 字級「小」下 text-[10px] 量到 ${r.small}px,沒有回到寫在標記裡的尺寸`);
    ck(r.xl > r.medium, `④ 字級「特大」沒有比「中」大 → 放大表被改壞了`);
}

await browser.close();
if (fail.length) { console.log('❌ VSPACE_FAIL'); fail.forEach(f => console.log('   ・' + f)); process.exit(1); }
console.log('✅ VSPACE_PASS(全部通過)');
