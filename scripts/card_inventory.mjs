#!/usr/bin/env node
/**
 * 📋 個股頁「卡片盤點器」—— 回答一個問題:**這一頁到底放了多少東西、各佔多少版面?**
 *
 * 使用者原話:「我的總覽、K線、籌碼頁面資料及卡片很多,我開發者都看到混亂」。
 * ⛔ 但**憑印象砍卡是危險的** —— CLAUDE.md 已經記過兩次教訓:
 *   ・陷阱 #31:靠「程式碼裡沒人參照這個 id」猜空殼 → 差點砍掉包住整段活內容的外殼
 *   ・`_SIGNAL_EDGE` 鐵則:⛔ 不可把 C 級訊號刪掉 —— 裡面有風險提醒,刪掉會讓人以為沒風險
 * → 所以先**量**再砍。這支只讀不改,產出一份可以照著討論的清單。
 *
 * 每張卡量四件事:
 *   ① 佔多少字(版面成本的代理)
 *   ② 預設是**攤開**還是**收在 <details> 裡**(收起來的其實不佔第一眼)
 *   ③ 這張卡有沒有**下操作指令**(有指令的才需要實測背書)
 *   ④ 有沒有引用實測數字(勝率/期望值/樣本數/pp)
 *
 * ⚠️ 跟 `page_sweep.mjs` 共用同一套「看得見」判斷(Tailwind CDN 在沙箱載不到,
 *    不能只看 class="hidden";而 switchAppTab 用 inline display 顯示卻不移除 hidden)。
 * ⛔ 這是盤點工具不是測試,exit 0,⛔ 別加進四驗證。
 *
 * 跑法:node scripts/card_inventory.mjs [股號]      預設 2330
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYM = process.argv[2] || '2330';
const SUBTABS = ['strategy', 'live', 'daytrade', 'chart', 'chip', 'corp', 'backtest', 'bullbear'];
const OVPANES = ['now', 'entry', 'exit'];

if (!fs.existsSync(path.join(ROOT, 'data', `${SYM}.json`))) {
    console.log(`❌ 沒有 data/${SYM}.json`);
    process.exit(1);
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    try {
        localStorage.setItem('proTerminalInv', JSON.stringify([{ symbol: '2330', cost: 1100, shares: 2000 }]));
        localStorage.setItem('proTerminalFavGroups', JSON.stringify({ 自選清單: ['2317'] }));
    } catch (_) { }
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }),
        writable: true, configurable: true,
    });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });

// 等 init() 落地(同 page_sweep:init 尾端會把頁面切回庫存)
{
    const t0 = Date.now(); let stable = 0;
    while (Date.now() - t0 < 45000 && stable < 2) {
        const ok = await page.evaluate(async () => {
            try { app.switchAppTab('diag'); } catch (_) { }
            await new Promise(r => setTimeout(r, 1200));
            const el = document.getElementById('tabContentDiag');
            return !!el && getComputedStyle(el).display !== 'none';
        });
        stable = ok ? stable + 1 : 0;
    }
    if (stable < 2) { console.log('❌ 等不到 init() 落地,盤點無效'); await browser.close(); process.exit(1); }
}

const meta = await page.evaluate(async s => {
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze(s, true, false, true); } catch (e) { return { err: String(e).slice(0, 200) }; }
    return { n: (app.rawDailyData || []).length, trend: app._ovTrend?.trend || null };
}, SYM);
if (meta.err || !(meta.n >= 100)) {
    console.log(`❌ 資料沒進去(${meta.err || meta.n + ' 根 K'})→ 盤點無效`);
    await browser.close(); process.exit(1);
}
await page.waitForTimeout(2500);

const RE_CMD = /(可以進場|可依紀律進場|可放心做多|順勢做多|可加碼|分批試單|可以追|反彈減碼|先出場|全數出場|空手觀望|停損|停利|掛單|買在|賣在|建議離場|建議買進)/;
const RE_EDGE = /(勝率|期望值|實測|回測|pp|樣本|次\)|基準)/;

const rows = [];
for (const tab of SUBTABS) {
    for (const pane of (tab === 'strategy' ? OVPANES : [null])) {
        const label = pane ? `總覽/${pane}` : tab;
        const cards = await page.evaluate(async a => {
            try { app.switchSubTab(a.tab); } catch (_) { }
            if (a.pane) { try { app.switchOvTab(a.pane); } catch (_) { } }
            await new Promise(r => setTimeout(r, 900));
            const shown = el => {
                if (!el.offsetParent && el.tagName !== 'BODY') return false;
                for (let n = el; n && n !== document.body; n = n.parentElement) {
                    const d = n.style && n.style.display;
                    if (d === 'none') return false;
                    if (!d && n.classList && n.classList.contains('hidden')) return false;
                }
                return true;
            };
            const seen = [], out = [];
            for (const el of document.querySelectorAll('[id]')) {
                if (!el.id || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
                if (/^(tabContent|subContent)/.test(el.id) || el.id === 'appMainArea') continue;
                if (!shown(el)) continue;
                if (seen.some(p => p.contains(el))) continue;
                const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                if (t.length < 12 || t.length > 2500) continue;
                seen.push(el);
                // 這張卡裡面「使用者第一眼看不到」的字數 → 剩下的才是版面成本。
                // 🐛 V72.5.6 修兩個「安靜地量錯」的缺陷(代理審查抓到的):
                //   ① 舊版只扣 `<details>:not([open])`,**沒扣 Tailwind `.hidden`** ——
                //      而沙箱連不到 Tailwind CDN、`.hidden{display:none}` 根本沒載入
                //      → 那些卡的內容全被算成「攤開」,字數被系統性高估。
                //   ② 巢狀重複扣:`details` 裡面又有 `.hidden` 會被扣兩次 → 用 Set 去重祖先。
                const foldedEls = [];
                const pushFold = n => { if (!foldedEls.some(p => p.contains(n))) foldedEls.push(n); };
                for (const d of el.querySelectorAll('details:not([open])')) pushFold(d);
                for (const h of el.querySelectorAll('.hidden')) {
                    const st = h.style && h.style.display;
                    if (st && st !== 'none') continue;       // inline display 會蓋掉 class(switchAppTab 就這樣做)
                    pushFold(h);
                }
                let folded = 0;
                for (const d of foldedEls) {
                    const dt = (d.innerText || '').replace(/\s+/g, ' ').trim();
                    const sm = (d.tagName === 'DETAILS' ? (d.querySelector('summary')?.innerText || '') : '').replace(/\s+/g, ' ').trim();
                    folded += Math.max(0, dt.length - sm.length);
                }
                // ⚠️ folded 可能**大於** len:`innerText` 對摺疊起來的 <details> 內容回傳的是全文,
                //    但外層那張卡的 innerText 反而不含它 → 相減會變負數(實測 −445)。
                //    ⛔ 不可讓「攤開字數」出現負值(會讓報表看起來像壞掉),一律 clamp。
                // ⛔ `txt` 不可截斷:舊版只留前 400 字 → 「有沒有下操作指令」只掃到卡片開頭,
                //    而指令通常寫在**最後**的「💡 對策 / 怎麼做」那一段 → 幾乎全部漏判。
                out.push({ id: el.id, len: t.length, folded: Math.min(folded, t.length), txt: t });
            }
            return out;
        }, { tab, pane });
        for (const c of cards) {
            rows.push({
                page: label, id: c.id, len: c.len, open: c.len - c.folded, folded: c.folded,
                cmd: RE_CMD.test(c.txt), edge: RE_EDGE.test(c.txt),
            });
        }
    }
}
await browser.close();

// ── 報表 ─────────────────────────────────────────────────
const byPage = {};
for (const r of rows) (byPage[r.page] ||= []).push(r);
const P = (n, w) => String(n).padEnd(w);
console.log(`\n📋 卡片盤點 ・${SYM}(${meta.n} 根 K,主結論 ${meta.trend || '未定'})\n${'═'.repeat(92)}`);
console.log('頁面          卡片數  攤開字數  摺疊字數  下指令的卡  引用實測的卡');
console.log('─'.repeat(92));
let tot = 0, totOpen = 0, totCmd = 0;
for (const [pg, list] of Object.entries(byPage)) {
    const o = list.reduce((s, x) => s + x.open, 0), f = list.reduce((s, x) => s + x.folded, 0);
    const c = list.filter(x => x.cmd).length, e = list.filter(x => x.edge).length;
    tot += list.length; totOpen += o; totCmd += c;
    console.log(`${P(pg, 14)}${P(list.length, 8)}${P(o.toLocaleString(), 10)}${P(f.toLocaleString(), 10)}${P(c, 12)}${e}`);
}
console.log('─'.repeat(92));
console.log(`${P('合計', 14)}${P(tot, 8)}${P(totOpen.toLocaleString(), 10)}${P('', 10)}${totCmd}`);

console.log(`\n🔝 攤開字數最多的 20 張卡(= 第一眼版面成本最高的)\n${'─'.repeat(92)}`);
console.log('攤開字  摺疊  指令 實測  頁面 / 卡片 id');
for (const r of [...rows].sort((a, b) => b.open - a.open).slice(0, 20)) {
    console.log(`${P(r.open, 8)}${P(r.folded || '', 6)}${P(r.cmd ? '⚠️' : '', 5)}${P(r.edge ? '📊' : '', 5)}${r.page} / ${r.id}`);
}

// ⭐ 最該注意的:**下了操作指令、但沒有引用任何實測數字**的卡
const risky = rows.filter(r => r.cmd && !r.edge).sort((a, b) => b.open - a.open);
console.log(`\n⚠️ 有下操作指令、但沒引用實測數字的卡:${risky.length} 張\n${'─'.repeat(92)}`);
for (const r of risky.slice(0, 25)) console.log(`  ${P(r.open, 7)}字  ${r.page} / ${r.id}`);
if (process.env.EMIT) {
    const fs2 = await import('fs');
    fs2.writeFileSync(process.env.EMIT, JSON.stringify(rows, null, 1));
    console.log(`\n💾 完整清單 → ${process.env.EMIT}`);
}
console.log(`\n⛔ 這只是**盤點**,不是判決 —— 有些卡本來就不該有勝率(K線圖、法人買賣超、集保分佈`);
console.log(`   都是「事實」不是「預測」)。要砍之前一律人工看過那張卡在回答什麼問題。`);
