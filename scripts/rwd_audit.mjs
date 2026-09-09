#!/usr/bin/env node
/**
 * 📐 RWD 巡邏(⛔ 只讀不改,exit 0 —— 巡邏工具不是測試)
 *
 * 使用者:「筆電上畫面過大、元件被無限制拉伸;手機上文字/按鈕超出卡片、字體調大後版面崩壞」。
 * ⭐ 憑感覺改全站 CSS 風險極高 → 先量:
 *   ① 整頁橫向溢出(scrollWidth > innerWidth)
 *   ② 元素右緣超出**父容器**(真正的「衝出方塊」)
 *   ③ 固定高度容器裡的內容溢出(scrollHeight > clientHeight + 4)——字體放大最容易炸的就是這個
 * 兩種寬度 × 兩種字級各量一次(medium / xl)。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});

const SCAN = async (w, h, font, opener) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(async ([font, opener]) => {
        const A = window.app || app;
        try { A.setFontSize(font); } catch (_) {}
        if (opener === 'settings') { try { A.openSettings(); } catch (_) {} }
        if (opener === 'stock') { try { A.switchAppTab('diag'); await A.analyze('2330'); } catch (_) {} }
        await new Promise(r => setTimeout(r, opener === 'stock' ? 2500 : 500));
        const vis = el => {
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || el.offsetParent === null) return false;
            // 🚨 沒有 Tailwind 時 `.hidden` 不生效 → 正式環境看不到的分頁面板會被誤判成可見
            //   (實測 subContentCorp/DayTrade/Backtest/Chart 四個全是這樣誤報)→ 自己往上追 class。
            for (let n = el; n && n !== document.body; n = n.parentElement)
                if (/(^|\s)hidden(\s|$)/.test(String(n.className || ''))) return false;
            return true;
        };
        const out = { pageOverflow: document.scrollingElement.scrollWidth - window.innerWidth, esc: [], clip: [] };
        for (const el of document.querySelectorAll('div,span,button,table,ul,section,header,nav,input')) {
            if (!vis(el)) continue;
            const p = el.parentElement; if (!p) continue;
            const a = el.getBoundingClientRect(), b = p.getBoundingClientRect();
            if (b.width < 40 || a.width < 20) continue;
            const ps = getComputedStyle(p);
            // 🚨 沙箱連不到 Tailwind CDN → `overflow-x-auto` 這種 class 不會生效,
            //   只看 computedStyle 會把「本來就能橫捲的列」全部誤報(實測誤報 4 個 sub-tab 按鈕)
            //   → 再看一次 className(正式環境那個 class 是有效的)。
            const pcls = String(p.className || '');
            if (/auto|scroll/.test(ps.overflowX + ps.overflow) || /overflow-x-auto|overflow-auto|overflow-x-scroll/.test(pcls)) continue;
            const over = Math.round(a.right - b.right);
            if (over > 6) out.esc.push({ t: (el.id || el.className || '').toString().slice(0, 46), over, w: Math.round(a.width) });
            // 固定高度但內容裝不下
            const s = getComputedStyle(el);
            if (/px$/.test(s.height) && el.scrollHeight - el.clientHeight > 4 && !/auto|scroll/.test(s.overflowY + s.overflow))
                out.clip.push({ t: (el.id || el.className || '').toString().slice(0, 46), extra: el.scrollHeight - el.clientHeight });
        }
        const key = o => o.t + '|' + (o.over ?? o.extra);
        const dedupe = a => [...new Map(a.map(o => [key(o), o])).values()].sort((x, y) => (y.over ?? y.extra) - (x.over ?? x.extra)).slice(0, 8);
        out.esc = dedupe(out.esc); out.clip = dedupe(out.clip);
        return out;
    }, [font, opener]);
    await page.close();
    return r;
};

// 🚧 空過守門:沙箱連不到 Tailwind CDN 的話,class 型的版面規則(max-w-*/md:/hidden/overflow-*)
//   **全部不生效** → 這份報告只涵蓋「寫在檔案裡的 CSS 與 inline 樣式」。⛔ 不講的話會被誤讀成「全部沒問題」。
{
    const pg = await browser.newPage();
    await pg.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(800);
    const tw = await pg.evaluate(() => {
        const d = document.createElement('div'); d.className = 'hidden'; document.body.appendChild(d);
        const ok = getComputedStyle(d).display === 'none'; d.remove(); return ok;
    });
    await pg.close();
    console.log(tw ? '✅ Tailwind 有載入,class 型版面規則有效'
        : '⚠️⚠️ Tailwind CDN 沒載入(沙箱)→ `max-w-*` / `md:` / `hidden` / `overflow-x-auto` **全部沒生效**。\n'
        + '   ⛔ 這份報告只涵蓋「檔案內 CSS + inline 樣式」;class 型的版面問題要在**真機**上看。');
}

for (const [w, h, label] of [[390, 844, '📱 手機 390'], [1440, 900, '🖥️ 桌機 1440']]) {
    for (const font of ['medium', 'xl']) {
        for (const opener of ['inv', 'stock', 'settings']) {
            const r = await SCAN(w, h, font, opener);
            const tag = `${label} ・字級 ${font} ・${opener === 'inv' ? '庫存頁' : opener === 'stock' ? '個股頁' : '設定中心'}`;
            console.log(`\n═══ ${tag} ═══`);
            console.log(`  整頁橫向溢出:${r.pageOverflow > 2 ? '❌ ' + r.pageOverflow + 'px' : '✅ 無'}`);
            if (r.esc.length) { console.log('  🚨 衝出父容器:'); r.esc.forEach(o => console.log(`     +${o.over}px  w=${o.w}  ${o.t}`)); }
            else console.log('  ✅ 沒有元素衝出父容器');
            if (r.clip.length) { console.log('  ✂️ 固定高度裝不下:'); r.clip.forEach(o => console.log(`     溢出 ${o.extra}px  ${o.t}`)); }
            else console.log('  ✅ 沒有固定高度被撐爆');
        }
    }
}
await browser.close();
