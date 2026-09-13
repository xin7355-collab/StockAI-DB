#!/usr/bin/env node
/**
 * 🔠 字級巡邏(V76.1.9)—— 找出「手機上小到看不清楚」的**說明/免責**文字。
 *
 * ⭐ 為什麼要有這支:使用者拿報告頁截圖說「版面修正」,查下去發現他是**捏放大在看** ——
 *   說明字全是 9px。而 V74.4.6 他就抱怨過「字太小」,當時訂下「⛔ 別再往 10px 以下調」。
 *   📊 但全檔有 **1,036 個 `text-[9px]` + 228 個 `text-[8px]`** → ⛔ 不可能全域 sed
 *   (diff 爆炸 + 會打爆一堆釘住字串的測試)→ 用工具找出「真的給人讀」的那些,分批修。
 *
 * 🚨 **沙箱沒有 Tailwind**(CDN,連不到)→ `text-[9px]` 這種 class **完全沒生效**,
 *   直接量 computed font-size 得到的是預設 16px = 全部假的(陷阱 #40)。
 *   ⭐ 所以先注入一份**只補字級**的最小 shim(把頁面上出現過的 `text-[Npx]` 轉成真 CSS 規則)。
 *   ⛔ 這個 shim **不假裝補齊 Tailwind** —— flex/grid/hidden 一律沒補,可見性另外自己判。
 *
 * ⛔ 定位:**巡邏工具**,exit 0、**不進四驗證**(誤報擋 push 會讓人養成無視它的習慣)。
 *   每一筆都要人工讀原始碼驗真偽。
 *
 * 跑法:node scripts/font_audit.mjs [代號…](預設 2330)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYMS = process.argv.slice(2).filter(a => /^[0-9A-Z^]{4,6}$/.test(a));
const SYM = SYMS[0] || '2330';
const FLOOR = 10;            // V74.4.6 訂的下限:⛔ 別再往 10px 以下調
const MIN_CJK = 8;           // 至少 8 個中文字才算「給人讀的說明」(⛔ 不報純數字標籤/圖表刻度)
const TABS = ['strategy', 'report', 'chart', 'chip', 'corp', 'backtest', 'bullbear', 'daytrade', 'live'];

const gh = f => { try { return JSON.parse(execSync(`git -C "${ROOT}" show origin/gh-pages:data/${f}`, { encoding: 'utf8', maxBuffer: 64 << 20 })); } catch (_) { return null; } };
const K = gh(`${SYM}.json`);
if (!K || K.length < 100) { console.log(`🚨 拿不到 ${SYM} 的 K 線(git show origin/gh-pages:data/${SYM}.json)→ ⛔ 不空跑`); process.exit(0); }

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 30000 });
await page.waitForTimeout(4000);

// 🚧 空過守門①:Tailwind 到底有沒有載到(有載到就不用 shim,而且結果更真)
const twReal = await page.evaluate(() => { const d = document.createElement('div'); d.className = 'hidden'; document.body.appendChild(d); const ok = getComputedStyle(d).display === 'none'; d.remove(); return ok; });
// ⭐ 注入「只補字級」的 shim
const shim = await page.evaluate(() => {
    const sizes = new Set();
    document.querySelectorAll('[class]').forEach(e => String(e.className).replace(/text-\[([\d.]+)px\]/g, (_, n) => { sizes.add(n); return _; }));
    const html = document.documentElement.outerHTML;
    (html.match(/text-\[([\d.]+)px\]/g) || []).forEach(m => sizes.add(m.slice(6, -3)));
    const css = [...sizes].map(n => `.text-\\[${String(n).replace('.', '\\.')}px\\]{font-size:${n}px}`).join('\n');
    const st = document.createElement('style'); st.id = '__fontshim'; st.textContent = css; document.head.appendChild(st);
    return { n: sizes.size };
});
// 🚧 空過守門②:shim 真的生效了嗎(⛔ 沒生效就整份報告是假的)
//   ⚠️ **不可拿 `text-[9px]` 來驗** —— index.html 自己有一張 V44.2 的 `!important` 放大表
//      (8→9 / 9→10 / 10→11 / 11→12),那張表會贏過 shim,量到 10px 是**對的**、不是 shim 壞掉。
//      ⭐ 要驗就驗**不在那張表裡**的字級(13px)。這一條第一版就踩到,誠實記著。
const probe = await page.evaluate(() => {
    const mk = c => { const d = document.createElement('div'); d.className = c; d.textContent = 'x'; document.body.appendChild(d); const s = getComputedStyle(d).fontSize; d.remove(); return s; };
    return { nine: mk('text-[9px]'), thirteen: mk('text-[13px]') };
});
console.log(`🔠 字級巡邏 ・${SYM} ・下限 ${FLOOR}px(V74.4.6)`);
console.log(`   Tailwind ${twReal ? '有載入' : '沒載入(沙箱)'} ・字級 shim 注入 ${shim.n} 種`);
console.log(`   實測 .text-[9px] = ${probe.nine}(⭐ 檔案內 V44.2 放大表把它撐到 10px,不是 9px)・.text-[13px] = ${probe.thirteen}`);
if (probe.thirteen !== '13px') { console.log('🚨 字級 shim 沒生效 → ⛔ 量到的字級不可信,停手(⛔ 不報 0 筆假裝沒事)'); await browser.close(); process.exit(0); }

await page.evaluate(async (s) => { app.switchAppTab('diag'); try { await app.analyze(s); } catch (_) {} }, SYM);
await page.waitForTimeout(2500);

const found = [];
for (const t of TABS) {
    const rows = await page.evaluate(async ({ t, FLOOR, MIN_CJK }) => {
        try { app.switchSubTab(t); } catch (_) {}
        await new Promise(r => setTimeout(r, 900));
        document.querySelectorAll('details').forEach(d => { d.open = true; });
        await new Promise(r => setTimeout(r, 300));
        // 可見性:⛔ 不信 offsetParent(沒有 Tailwind,`.hidden` 不生效)→ 自己往上追(同 page_sweep)
        const vis = el => { for (let n = el; n && n !== document.body; n = n.parentElement) {
            const d = n.style && n.style.display; if (d === 'none') return false;
            if (!d && n.classList && n.classList.contains('hidden')) return false; } return true; };
        const box = document.getElementById(`subContent${t[0].toUpperCase()}${t.slice(1)}`) || document.getElementById('appMainArea');
        if (!box) return [];
        const out = [];
        for (const el of box.querySelectorAll('div,span,p,li,b,button,summary')) {
            if (el.querySelector('div,span,p,li,b,button,summary')) continue;      // 只看最內層(⛔ 免得父子重複報)
            if (!vis(el)) continue;
            const txt = (el.textContent || '').replace(/\s+/g, '');
            const cjk = (txt.match(/[一-鿿]/g) || []).length;
            if (cjk < MIN_CJK) continue;                                            // ⛔ 純數字/短標籤不報
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (!(fs > 0) || fs >= FLOOR) continue;
            // 往上找最近一張有 id 的卡,方便人工去對
            let card = ''; for (let n = el; n && n !== box; n = n.parentElement) if (n.id) { card = n.id; break; }
            out.push({ card, fs, cjk, txt: txt.slice(0, 34) });
        }
        return out;
    }, { t, FLOOR, MIN_CJK });
    rows.forEach(r => found.push({ tab: t, ...r }));
}
await browser.close();

if (!found.length) { console.log('\n✅ 這幾頁沒有 10px 以下的說明文字'); process.exit(0); }
const byCard = new Map();
for (const r of found) { const k = `${r.tab}｜${r.card || '(無 id)'}`; const v = byCard.get(k) || { n: 0, cjk: 0, fs: new Set(), eg: r.txt }; v.n++; v.cjk += r.cjk; v.fs.add(r.fs); byCard.set(k, v); }
const list = [...byCard.entries()].sort((a, b) => b[1].cjk - a[1].cjk);
console.log(`\n📊 ${found.length} 段說明文字在 ${FLOOR}px 以下 ・分佈在 ${list.length} 張卡(依「字數」排,先修上面的)\n`);
console.log('  字數   段數  字級        分頁｜卡片                                  例句');
for (const [k, v] of list.slice(0, 30)) {
    const [tab, card] = k.split('｜');
    console.log(`  ${String(v.cjk).padStart(5)} ${String(v.n).padStart(5)}  ${[...v.fs].sort((a, b) => a - b).join('/').padEnd(10)} ${tab.padEnd(9)}｜${card.padEnd(26)} ${v.eg}`);
}
if (list.length > 30) console.log(`  …另外還有 ${list.length - 30} 張卡`);
console.log('\n⚠️ 盲區(⛔ 不可把「沒報到」讀成「沒問題」):');
console.log('   ・只掃個股頁的 9 個分頁 —— ⛔ 庫存/選股/大盤/自選/設定中心**沒掃**');
console.log('   ・只掃「≥8 個中文字」的段落 —— 短標籤、圖表刻度、純數字**刻意不報**');
console.log('   ・`<details>` 全部展開才掃 —— 使用者實際看到的第一眼更少');
console.log('   ・字級 shim 只補 `text-[Npx]`,⛔ 不含 `text-xs`/`text-sm` 這種具名字級');
console.log('   ・量的是**預設**字體設定;使用者切「大字/特大」時會再放大(index.html 有 html[data-font] 三張表)');
