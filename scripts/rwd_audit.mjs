#!/usr/bin/env node
/**
 * 📐 RWD 巡邏(⛔ 只讀不改,exit 0 —— 巡邏工具不是測試)
 *
 * 使用者:「筆電上畫面過大、元件被無限制拉伸;手機上文字/按鈕超出卡片、字體調大後版面崩壞」。
 * ⭐ 憑感覺改全站 CSS 風險極高 → 先量:
 *   ① 整頁橫向溢出(scrollWidth > innerWidth)
 *   ② 元素右緣超出**父容器**(真正的「衝出方塊」)—— ⛔ 父層 overflow:hidden 的另外歸一類「被裁掉」
 *   ③ 固定高度容器裡的內容溢出(scrollHeight > clientHeight + 4)——字體放大最容易炸的就是這個
 * 兩種寬度 × 兩種字級各量一次(medium / xl)。
 *
 * ⭐ V76.2.4 掃描範圍補齊:原本只掃「庫存 / 個股**預設分頁** / 設定中心」三頁
 *   → 個股那 9 個 sub-tab 與 選股/大盤/自選/決策台 **一次都沒被量過**
 *   (所以 V76.1.9 查出來的 `grid-cols-[1fr_auto]` 其餘幾處,改了也沒有工具看得見)。
 *   現在個股頁**一次載入、逐頁切換**量 9 次(⛔ 不重載,省時間),app tab 再多掃 4 頁。
 * 🚧 每一頁都有「掃到幾個元素」的空過守門 —— ⛔ 0 個要明講是哪一頁,
 *   不可讓「乾淨的輸出」與「根本沒掃到」長得一模一樣(這支工具最大的風險)。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

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
    await page.evaluate(rwdShim);   // 🧩 唯一一份版面 shim(見 scripts/lib_rwdshim.mjs)
    const r = await page.evaluate(async ([font, opener, SUBTABS, SUBID]) => {
        // 🚨 V76.2.2 沙箱連不到 Tailwind CDN → **祖先鏈整個塌掉**(實測報告頁卡片只剩 166px,
        //   正式環境是 373px)→ 量到的「沒有溢出」是假的(陷阱 #40)。
        //   ⭐ 注入**只補版面**的最小 shim(box-sizing / padding / width / flex / 換行),
        //      讓寬度跟正式環境一致;⛔ 它不假裝補齊 Tailwind(顏色、md: 斷點、max-w-* 都沒補)。
        //   ⚠️ 第一條 `box-sizing:border-box` 最關鍵 —— 少了它,`w-full` + `p-2` 的 textarea
        //      會被誤報成「超出父層 5px」(實測)。
        // 🧩 版面 shim 已在 page.evaluate **之前**注入(`scripts/lib_rwdshim.mjs`,唯一一份)
        //   ⛔ 別在這裡再補一份 —— 兩份會各自漏規則,而漏掉的誤報跟真問題長得一模一樣。
        const shimBad = window.__rwdShimBad || [];
        const A = window.app || app;
        try { A.setFontSize(font); } catch (_) {}
        const nap = ms => new Promise(r => setTimeout(r, ms));
        const vis = el => {
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || el.offsetParent === null) return false;
            // 🚨 沒有 Tailwind 時 `.hidden` 不生效 → 正式環境看不到的分頁面板會被誤判成可見
            //   (實測 subContentCorp/DayTrade/Backtest/Chart 四個全是這樣誤報)→ 自己往上追 class。
            // 🚨🚨 V76.2.4 修:⛔ **不能只看 class** —— `switchSubTab`/`switchAppTab` 是用
            //   `style.setProperty('display', …, 'important')` 顯示分頁、**從來不移除 hidden class**
            //   → 只看 class 會把「正在顯示的那一頁」整頁誤判成藏起來。
            //   實測後果:個股 9 個分頁**每一頁都只掃到同樣的 47 個外框元素**、分頁內容一個都沒掃到,
            //   而輸出看起來完全正常(CLAUDE.md 對 `page_sweep` 記過一模一樣的坑)。
            //   ⭐ 判準照 `page_sweep`/`font_audit`:**inline display 贏過 class**。
            for (let n = el; n && n !== document.body; n = n.parentElement) {
                const d = n.style && n.style.display;
                if (d === 'none') return false;
                if (!d && /(^|\s)hidden(\s|$)/.test(String(n.className || ''))) return false;
            }
            return true;
        };
        // 🚨 CLAUDE.md 鐵則:⛔ 不可用 `scrollWidth` 判整頁橫向溢出 —— `html,body{overflow-x:hidden}`
        //   會把真的溢出**默默切掉**,而 scrollWidth 仍把被 clip 的內容算進去 → 兩個方向都失真。
        //   正解是**真的去捲捲看**:捲得動才是真的能橫向捲動(V76.1.9,同 test_report 的修正)。
        //   ⚠️ 被 `overflow-x:hidden` 夾死的那種溢出改由下面「逐元素跟父層比」抓。
        const measure = () => {
        window.scrollTo(80, 0);
        const _sx = Math.round(window.scrollX);
        window.scrollTo(0, 0);
        const out = { pageOverflow: _sx, esc: [], cut: [], clip: [], wide: [], scanned: 0 };
        // 🧱 V76.3.2 新增:**垂直空間佔用** —— 使用者:「螢幕可觀看地方變窄、能使用空間很小」。
        //   以前這支只查橫向,而桌機真正被吃掉的是**垂直**:頂端列 + 分頁列 + 個股 sticky 區
        //   都是**永遠佔著**的固定框架,剩下才是內容。⛔ 憑截圖猜不準 → 量。
        //   ⚠️ 只收「真的看得到而且真的佔著位置」的(sticky/static 才算;手機的 nav 是 fixed,
        //      它蓋在內容上但 .scrollable-main 有等高 padding-bottom → 一樣算佔用)。
        out.vsp = (() => {
            const vh = window.innerHeight;
            const hh = (sel) => { const e = document.querySelector(sel);
                if (!e) return 0; const s2 = getComputedStyle(e);
                if (s2.display === 'none' || s2.visibility === 'hidden') return 0;
                return Math.round(e.getBoundingClientRect().height); };
            const head = hh('.header-fixed');
            const nav = hh('.nav-fixed');
            // 個股頁那一塊 sticky(報價頭 + 標籤列 + sub-tab 列)—— ⛔ 只有正在顯示的那個 tab 算
            let sub = 0;
            for (const el of document.querySelectorAll('.sticky-sub')) {
                if (!vis(el)) continue;
                sub += Math.round(el.getBoundingClientRect().height);
            }
            const chrome = head + nav + sub;
            // ⭐ 誰吃掉的要指名道姓 —— ⛔ 只報總數的話,下一輪還是得重量一次才知道要動哪裡
            const parts = [];
            for (const root of [document.querySelector('.header-fixed'), ...document.querySelectorAll('.sticky-sub')]) {
                if (!root || !vis(root)) continue;
                for (const c of root.children) {
                    if (!vis(c)) continue;
                    const hgt = Math.round(c.getBoundingClientRect().height);
                    if (hgt >= 8) parts.push({ t: (c.id || c.tagName.toLowerCase() + '.' + String(c.className || '').split(' ')[0]).slice(0, 28), h: hgt });
                }
            }
            return { vh, head, nav, sub, chrome, parts, freePct: Math.round((vh - chrome) / vh * 100) };
        })();
        for (const el of document.querySelectorAll('div,span,button,table,ul,section,header,nav,input')) {
            if (!vis(el)) continue;
            out.scanned++;
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
            // 🚨 V76.1.9 誤報收斂:父層 `overflow:hidden`(或 clip)的話,孩子**根本衝不出去** —— 它被裁掉。
            //   那是另一件事(內容看不完),⛔ 不是「衝出方塊」。混在一起報會讓人養成忽略巡邏輸出的習慣
            //   (同 data_audit 的 SUPERSEDED 清單)。⭐ 而 `text-overflow:ellipsis` 是**刻意**裁的
            //   (V76.0.8 價格尺就是這樣修的)→ 標出來,⛔ 但不隱藏。
            if (over > 6) {
                //   ⚠️ 沙箱連不到 Tailwind → `overflow-hidden` 這個 **class** 不生效(同上面那段 overflow-x-auto 的處置)
                //   → 再看一次 className,否則跑馬燈這種「本來就該比框寬」的會一直被報成 🚨 衝出。
                const clipped = /hidden|clip/.test(ps.overflowX + ps.overflow)
                    || /overflow-hidden|overflow-x-hidden|overflow-clip/.test(pcls);
                const row = { t: (el.id || el.className || '').toString().slice(0, 46), over, w: Math.round(a.width) };
                if (clipped) out.cut.push({ ...row, ell: ps.textOverflow === 'ellipsis' });
                else out.esc.push(row);
            }
            // 固定高度但內容裝不下
            const s = getComputedStyle(el);
            if (/px$/.test(s.height) && el.scrollHeight - el.clientHeight > 4 && !/auto|scroll/.test(s.overflowY + s.overflow))
                out.clip.push({ t: (el.id || el.className || '').toString().slice(0, 46), extra: el.scrollHeight - el.clientHeight });
            // 🚨🚨 V76.2.4 新增:**內容裝不下自己的框(橫向)** —— 這一類以前完全沒查。
            //   `grid-cols-[1fr_auto]` 撐寬的症頭正是這個(任意值 `1fr` = `minmax(auto,1fr)` ⛔ 不收縮)
            //   → 格子的 min-content 總和超過容器 → `scrollWidth > clientWidth`,
            //   而它**不會**讓任何子元素「右緣超出父層」,所以上面兩類**都抓不到**(實測回測頁打法列 119 vs 93)。
            //   ⛔ 只收 overflow 是 **visible** 的(hidden/clip 是刻意裁、auto/scroll 是刻意能捲 → 不是 bug)
            const ox = s.overflowX + s.overflow, ecls = String(el.className || '');
            if (!/auto|scroll|hidden|clip/.test(ox)
                && !/overflow-|truncate/.test(ecls)
                && el.clientWidth >= 40 && el.scrollWidth - el.clientWidth > 6)
                out.wide.push({ t: (el.id || ecls).toString().slice(0, 46), over: el.scrollWidth - el.clientWidth, w: el.clientWidth });
        }
        const key = o => o.t + '|' + (o.over ?? o.extra);
        const dedupe = a => [...new Map(a.map(o => [key(o), o])).values()].sort((x, y) => (y.over ?? y.extra) - (x.over ?? x.extra)).slice(0, 8);
        out.esc = dedupe(out.esc); out.cut = dedupe(out.cut); out.clip = dedupe(out.clip); out.wide = dedupe(out.wide);
        return out;
        };
        // ⭐ 個股頁:**一次載入、逐頁切換**(⛔ 不每頁重載一次瀏覽器,那會慢 9 倍)
        const res = [];
        if (opener === 'stock') {
            try { A.switchAppTab('diag'); await A.analyze('2330'); } catch (_) {}
            await nap(2500);
            for (const t of SUBTABS) {
                try { A.switchSubTab(t); } catch (_) {}
                // 🚧 V76.2.4:⛔ 固定等 900ms 不夠 —— 好幾個分頁是 lazy-init(回測的打法清單實測要 2 秒以上),
                //   等不夠就會量到「還沒渲染的空殼」,而**空過守門也擋不住**(它只看「有沒有元素」,
                //   而分頁外框本來就有幾十個)→ 改成**等到字數連續兩次沒變**才量。
                const box = () => document.getElementById(SUBID[t]);
                let prev = -1, same = 0;
                for (let i = 0; i < 14; i++) {
                    await nap(500);
                    const n = (box()?.innerText || '').replace(/\s/g, '').length;
                    if (n === prev && n > 0) { if (++same >= 2) break; } else same = 0;
                    prev = n;
                }
                const m = measure(); m.tab = t; m.txt = prev; res.push(m);
            }
        } else if (opener === 'radar') {
            // 🏅 V76.2.8 選股頁有 4 個**頂層模式**(策略/ETF/自訂/券商)——
            //   ⛔ 只切 switchAppTab 只量得到預設那個「策略」,新加的券商榜(4×3=12 格)整個掃不到。
            try { A.switchAppTab('radar'); } catch (_) {}
            await nap(1200);
            for (const [mode, nm] of [['strategy', '策略'], ['etf', 'ETF'], ['custom', '自訂'], ['broker', '券商']]) {
                try { A.switchRadarMode(mode); } catch (_) {}
                await nap(1400);
                const m = measure(); m.tab = nm; res.push(m);
            }
            try { A.switchRadarMode('strategy'); } catch (_) {}
        } else if (opener === 'settings') {
            try { A.openSettings(); } catch (_) {}
            await nap(600);
            const m = measure(); m.tab = ''; res.push(m);
        } else {
            try { A.switchAppTab(opener); } catch (_) {}
            await nap(1200);
            const m = measure(); m.tab = ''; res.push(m);
        }
        res.forEach(r => { r.shimBad = shimBad; });
        return res;
    }, [font, opener, SUBTABS, SUBID]);
    await page.close();
    return r;
};

// ⭐ 個股 9 個 sub-tab —— ⛔ 跟 `scripts/font_audit.mjs` 共用同一份順序,別另開第二份清單
const SUBTABS = ['strategy', 'report', 'chart', 'chip', 'corp', 'backtest', 'bullbear', 'daytrade', 'live'];
// 🚨 V76.2.4:分頁容器 id ⛔ 不是 `t[0].toUpperCase()+t.slice(1)` 組得出來的 ——
//   實際是 `subContentBullBear` / `subContentDayTrade`(**中間那個字母也大寫**)。
//   組錯的後果是安靜的:`font_audit` 那兩頁一路退回掃 `appMainArea`(**整頁**)、
//   `rwd_audit` 則量不到字數 → 都不會報錯。⭐ 改用明確對照表(同 data_audit 用明確清單不自動推導的理由)。
const SUBID = { strategy: 'subContentStrategy', report: 'subContentReport', chart: 'subContentChart', chip: 'subContentChip', corp: 'subContentCorp', backtest: 'subContentBacktest', bullbear: 'subContentBullBear', daytrade: 'subContentDayTrade', live: 'subContentLive' };
const SUBNAME = { strategy: '總覽', report: '報告', chart: 'K線', chip: '籌碼', corp: '基本', backtest: '回測', bullbear: '多空', daytrade: '當沖', live: '即時' };
// ⛔ `settings` 是 modal(`openSettings()`),不是 `switchAppTab` → 保留現行走法
const OPENERS = [['inv', '庫存頁'], ['stock', '個股頁'], ['radar', '選股頁'], ['market', '大盤頁'], ['fav', '自選頁'], ['desk', '決策台'], ['settings', '設定中心']];

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
        : '⚠️ Tailwind CDN 沒載入(沙箱)→ V76.2.2 起自動注入**只補版面**的最小 shim\n'
        + '   (box-sizing / padding / width / flex / 換行 / text-[Npx]);\n'
        + '   V76.2.4 再補 grid-cols-* / overflow-* / hidden / w-max / min-w-[…] / max-w-*。\n'
        + '   ⛔ 仍沒補的:`md:`/`sm:` 斷點、`space-x-*`、顏色 → 那幾類要在**真機**上看。');
}

// 🔎 迭代用的篩選(⛔ 巡邏本身不吃它 —— 預設仍然全掃):
//   `RWD_ONLY=stock,inv node scripts/rwd_audit.mjs` 只跑那幾頁,`RWD_FONT=medium` 只跑一種字級。
//   ⚠️ 用過之後**要再跑一次完整的**,⛔ 別拿只掃兩頁的輸出當「全站乾淨」。
const ONLY = (process.env.RWD_ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
const FONTS = (process.env.RWD_FONT || 'medium,xl').split(',').map(x => x.trim()).filter(Boolean);
if (ONLY.length || process.env.RWD_FONT) console.log(`⚠️ 這一輪是**篩選過的**(RWD_ONLY=${ONLY.join('|') || '全部'} ・RWD_FONT=${FONTS.join('|')})→ ⛔ 不可當成全站結論`);
const BLIND = []; let SHIM_REPORTED = false;
for (const [w, h, label] of [[390, 844, '📱 手機 390'], [1440, 900, '🖥️ 桌機 1440']]) {
    for (const font of FONTS) {
        for (const [opener, oname] of OPENERS) {
            if (ONLY.length && !ONLY.includes(opener)) continue;
            for (const r of await SCAN(w, h, font, opener)) {
                const tag = `${label} ・字級 ${font} ・${oname}${r.tab ? ' → ' + (SUBNAME[r.tab] || r.tab) : ''}`;
                console.log(`\n═══ ${tag} ═══`);
                if (!SHIM_REPORTED) { SHIM_REPORTED = true;
                    if (r.shimBad && r.shimBad.length) { console.log('  🚨 版面 shim 有規則沒生效 → ⛔ 底下的幾何數字全部不可信:'); r.shimBad.forEach(x => console.log('     ・' + x)); }
                    else console.log('  🚧 版面 shim 自我檢查 5 條全過(flex-wrap / hidden / overflow / grid 任意值 / gap)');
                }
                // 🚧 空過守門:⛔「乾淨的輸出」與「根本沒掃到」不可長得一樣
                if (!r.scanned) { console.log(`  🚨 這一頁掃到 0 個可見元素 → 切不過去或沒渲染,⛔ 這頁的結論不算數`); BLIND.push(tag); continue; }
                console.log(`  (掃了 ${r.scanned} 個可見元素${r.txt != null ? ' ・' + r.txt + ' 字' : ''})`);
                console.log(`  整頁可橫向捲動:${r.pageOverflow > 2 ? '❌ 捲得動 ' + r.pageOverflow + 'px' : '✅ 捲不動'}`);
                if (r.vsp) { const v = r.vsp;
                    const bar = v.freePct >= 70 ? '✅' : v.freePct >= 55 ? '⚠️' : '🚨';
                    console.log(`  🧱 垂直空間:視窗 ${v.vh}px → 框架吃掉 ${v.chrome}px(頂端 ${v.head} + 分頁列 ${v.nav} + 個股置頂 ${v.sub})→ 內容剩 ${bar} ${v.freePct}%`);
                    if (v.parts && v.parts.length) console.log('     └ ' + v.parts.map(x => `${x.t} ${x.h}`).join(' ・ '));
                }
                if (r.esc.length) { console.log('  🚨 衝出父容器:'); r.esc.forEach(o => console.log(`     +${o.over}px  w=${o.w}  ${o.t}`)); }
                else console.log('  ✅ 沒有元素衝出父容器');
                if (r.cut.length) {
                    console.log('  ✂️ 被父層裁掉(內容看不完;⭐ 有 … 的是刻意的):');
                    r.cut.forEach(o => console.log(`     ${o.ell ? '⭐…' : '⚠️  '} 超出 ${o.over}px  w=${o.w}  ${o.t}`));
                }
                if (r.wide.length) {
                    console.log('  📏 內容裝不下自己的框(橫向;`grid-cols-[1fr_auto]` 這類的典型症頭):');
                    r.wide.forEach(o => console.log(`     超出 ${o.over}px  框寬=${o.w}  ${o.t}`));
                }
                if (r.clip.length) { console.log('  ✂️ 固定高度裝不下:'); r.clip.forEach(o => console.log(`     溢出 ${o.extra}px  ${o.t}`)); }
                else if (!r.wide.length) console.log('  ✅ 沒有框被撐爆');
            }
        }
    }
}
await browser.close();
// 🚧 空過守門總結:⛔ 不可只在中間印一行就算了 —— 那會被上百行輸出淹掉
if (BLIND.length) {
    console.log(`\n🚨 有 ${BLIND.length} 個頁面掃到 0 個可見元素(⛔ 那幾頁的「乾淨」不算數):`);
    [...new Set(BLIND.map(t => t.split('・').pop().trim()))].forEach(t => console.log(`   ・${t}`));
} else console.log('\n✅ 每一頁都掃到可見元素(沒有空過)');
