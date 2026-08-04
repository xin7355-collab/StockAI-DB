#!/usr/bin/env node
/**
 * 🔬 個股頁「實際渲染後掃一遍」巡邏工具(V72.2.2)
 *
 * 使用者反覆講的兩句:「**邏輯不打架**」「**一目了然知道現在要怎麼做**」。
 * 過去抓這類問題都靠 `grep` 找關鍵字,但 CLAUDE.md 自己已經寫了教訓:
 *   ⭐「巡邏 grep 只能抓『你想得到的說法』→ **真正可靠的是實際渲染後人工看一遍**」
 *   (V72.1.4 抓第 6 處講反話、V72.1.7 抓「跌破前低 --」都是這樣才發現的)
 *
 * → 這支把「人工看一遍」自動化:用**真實 data/*.json** 跑完整 `analyze()`,
 *   把 8 個分頁 + 3 個總覽 pane 全部切一遍,**掃渲染後的 innerText**(不是原始碼),
 *   找四類已知會咬人的缺陷:
 *
 *   ① 💥 **缺值直接印給使用者**:「跌破前低 --」「停損 NaN」「目標 undefined」
 *      → 使用者根本不知道要撤在哪(V72.1.7 實例)
 *   ② 🗣️ **空頭主結論下卻在叫人做多**:`_ovTrend.trend==='bear'` 時出現
 *      「可以進場 / 加碼 / 抱好 / 順勢做多」(V72.0.7~V72.0.9 同一個錯犯了四次)
 *   ③ 📉 **占比沒有樣本守門**:「100%」「0%」配上極小的 N(1/1 的假信心,陷阱 #27)
 *   ④ 🫥 **空殼**:容器可見但幾乎沒有字(使用者以為功能壞了)
 *
 * ⛔ 它是**巡邏工具不是測試** —— 報出來的一律要人工讀原始碼驗真偽
 *    (CLAUDE.md 鐵則:代理/工具找到的約 1/3 是誤報)。所以 **exit code 永遠 0**,
 *    ⛔ 別把它加進四驗證,免得誤報擋住 push、久了大家就開始無視它。
 *
 * 跑法:node scripts/page_sweep.mjs [股號…]     預設掃 2327 2330 2317 0050 ^TWII
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYMS = process.argv.slice(2).length ? process.argv.slice(2) : ['2327', '2330', '2317', '0050', '^TWII'];
const SUBTABS = ['strategy', 'live', 'daytrade', 'chart', 'chip', 'corp', 'backtest', 'bullbear'];
const OVPANES = ['now', 'entry', 'exit'];

// ── 四類缺陷的樣式 ───────────────────────────────────────────
// ① 動詞 + 缺值:只抓「動詞後面 10 字內就出現缺值」,避免整頁到處誤報
// ⚠️ ⛔ 破折號 `—`/`——` **不可列入** —— 全 App 拿它當標點(「今日低 526 — 收盤不破就沒壞」),
//    第一版列進去,兩筆命中全是誤報。缺值的真面目是 `--`(`nf()` 的 fallback)與 NaN/undefined。
const RE_MISSING = /(跌破|站上|守住?|突破|回測|停損|停利|目標價?|掛單|買在|賣在)[^。;,、\n]{0,10}(--(?!-)|NaN|undefined|null|Infinity)/g;
// ② 多方指令用語(⚠️ 字典要持續補 —— 但別只靠它,見檔頭說明)
const RE_BULLCMD = /(順勢做多|順著做|可順勢|抱好|別提早下車|放心做|可以進場|順勢操作|抱單|可加碼|快進快出|分批試單|可以追|追要|逢低|進場)/g;
// ③ 極端占比(100%/0%)—— 要人工去看它旁邊的樣本數
const RE_PCT = /(?:^|[^\d.])(100(?:\.0)?%|0(?:\.0)?%)/g;
// ⚠️ 否定形先拿掉 —— 正確的免責寫法本身就含被禁字串(本專案已踩 7 次)
const nono = t => String(t)
    .replace(/(?:不是|並非|沒有|不可|不准|別|禁|⛔)[^。;,\n]{0,26}(進場|加碼|抱好|順勢|追|試單|做多)/g, '')
    .replace(/(?:不建議|不宜|暫不)[^。;,\n]{0,20}(進場|加碼|做多|追)/g, '');

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    // ⚠️ `--allow-file-access-from-files` 少了就 **fetch 不到 data/*.json** ——
    //    而 analyze() 抓不到資料時是**靜默降級**(不丟例外),於是整支掃描「全綠但什麼都沒驗到」。
    //    第一版就踩到(印出「0 根 K」才發現)→ 下面有「K 根數 < 100 就報錯退出」的守門。
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
// ECharts 走 CDN,沙箱連不到 → 用 Proxy stub(同 test_emptyshell 做法,圖表不是這支的重點)
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }),
        writable: true, configurable: true,
    });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
// file:// 讓它過(data/*.json 就在本機),外網一律擋
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(1500);

const findings = [];
let scanned = 0;
const add = (sym, tab, kind, card, hit, ctx) => findings.push({ sym, tab, kind, card, hit, ctx });

for (const sym of SYMS) {
    if (!fs.existsSync(path.join(ROOT, 'data', `${sym}.json`))) { console.log(`⏭️  ${sym} 沒有本機資料,略過`); continue; }
    process.stdout.write(`\n🔎 ${sym} `);
    const meta = await page.evaluate(async s => {
        // ⚠️ 一定要先切到「診斷」(個股頁)—— 預設落在庫存頁,
        //    不切的話 analyze() 資料是進去了,但整個個股頁 display:none → 掃到的全是庫存頁的字。
        //    第一版就踩到(只掃到 9 張卡、每個分頁內容一模一樣)。
        try { app.switchAppTab('diag'); } catch (_) { }
        try { await app.analyze(s, true, false, true); } catch (e) { return { err: String(e).slice(0, 200) }; }
        return { trend: app._ovTrend?.trend || null, bear: !!app._bearGate?.(s), n: (app.rawDailyData || []).length };
    }, sym);
    if (meta.err) { console.log(`❌ analyze 丟例外:${meta.err}`); continue; }
    // ⭐ 空過守門(CLAUDE.md「實跑驗證要先確認輸入真的觸發目標路徑」):
    //   K 根數 0 = 資料根本沒載進去 → 後面掃出來的「乾淨」是假的,一律當失敗中止。
    if (!(meta.n >= 100)) {
        console.log(`\n❌ ${sym} 只載到 ${meta.n} 根 K —— 資料沒進去,這次掃描無效(⛔ 別把它讀成「沒問題」)`);
        await browser.close();
        process.exit(1);
    }
    await page.waitForTimeout(2200);
    process.stdout.write(`(${meta.n} 根 K・主結論 ${meta.trend || '未定'}${meta.bear ? '・空頭' : ''}) `);

    for (const tab of SUBTABS) {
        const panes = tab === 'strategy' ? OVPANES : [null];
        for (const pane of panes) {
            const label = pane ? `${tab}/${pane}` : tab;
            // 切分頁 → 等非同步卡填完 → 收所有「看得見」的卡片文字
            const cards = await page.evaluate(async a => {
                try { app.switchSubTab(a.tab); } catch (_) { }
                if (a.pane) { try { app.switchOvTab(a.pane); } catch (_) { } }
                await new Promise(r => setTimeout(r, 900));
                const seen = [], out = [];
                // 只收「有 id 的卡片容器」,由外而內去重(父層收了就不收子層,免得同一句報三次)
                for (const el of document.querySelectorAll('[id]')) {
                    if (!el.id || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
                    if (!el.offsetParent && el.tagName !== 'BODY') continue;          // 看不見的不算
                    if (seen.some(p => p.contains(el))) continue;
                    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t.length < 12 || t.length > 4000) continue;
                    seen.push(el); out.push({ id: el.id, t });
                }
                return out;
            }, { tab, pane });

            for (const c of cards) {
                const clean = nono(c.t);
                // ① 缺值
                for (const m of c.t.matchAll(RE_MISSING)) add(sym, label, '💥缺值', c.id, m[0], ctxOf(c.t, m.index));
                // ② 空頭卻叫人做多
                if (meta.bear) for (const m of clean.matchAll(RE_BULLCMD)) add(sym, label, '🗣️講反話', c.id, m[0], ctxOf(clean, m.index));
                // ③ 極端占比
                for (const m of c.t.matchAll(RE_PCT)) {
                    const ctx = ctxOf(c.t, m.index);
                    if (/勝率|優勢|佔比|占比|命中/.test(ctx)) add(sym, label, '📉極端占比', c.id, m[1], ctx);
                }
            }
            // ④ 空殼:容器可見但字數 < 8
            const shells = await page.evaluate(() => {
                const out = [];
                for (const el of document.querySelectorAll('[id$="Card"],[id$="Box"],[id$="Panel"]')) {
                    if (!el.offsetParent) continue;
                    if (el.querySelector('canvas,img,input,button,svg')) continue;   // 圖表/互動不算空
                    const t = (el.innerText || '').replace(/\s/g, '');
                    if (t.length > 0 && t.length < 8) out.push({ id: el.id, t });
                }
                return out;
            });
            for (const s of shells) add(sym, label, '🫥空殼', s.id, s.t, '');
            // ⭐ 同樣是空過守門:掃到 0 張卡代表分頁沒切成功/內容還沒填,
            //   若不印出來,結果會長得跟「全部乾淨」一模一樣。
            scanned += cards.length;
            process.stdout.write(cards.length ? '.' : '∅');
        }
    }
}

// ── 底部主分頁(大盤 / 選股 / 觀察 / 券商)也掃一遍 ────────────────
//   ⚠️ 個股頁只佔全 App 的一部分 —— 陷阱 #32(「卡片放錯頁籤 → 使用者找不到」)
//      跟 V72.1.0(實測訊號只在進場頁籤)都是**跨分頁**的問題,只掃個股頁看不到。
//   ⭐ 這些頁不綁個股 → `_ovTrend` 不適用,**只掃缺值與空殼**(⛔ 不掃講反話,大盤層級的
//      建議本來就跟個股趨勢無關,掃了全是誤報 —— 見報告尾巴的誤報說明)。
process.stdout.write('\n🌐 主分頁 ');
for (const tab of ['market', 'radar', 'hunt', 'broker', 'inv', 'fav']) {
    const cards = await page.evaluate(async t => {
        try { app.switchAppTab(t); } catch (_) { return []; }
        await new Promise(r => setTimeout(r, 1800));
        const seen = [], out = [];
        for (const el of document.querySelectorAll('[id]')) {
            if (!el.id || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
            if (!el.offsetParent && el.tagName !== 'BODY') continue;
            if (seen.some(p => p.contains(el))) continue;
            const x = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (x.length < 12 || x.length > 4000) continue;
            seen.push(el); out.push({ id: el.id, t: x });
        }
        return out;
    }, tab);
    for (const c of cards) {
        for (const m of c.t.matchAll(RE_MISSING)) add('(全站)', tab, '💥缺值', c.id, m[0], ctxOf(c.t, m.index));
        for (const m of c.t.matchAll(RE_PCT)) {
            const ctx = ctxOf(c.t, m.index);
            if (/勝率|優勢|佔比|占比|命中/.test(ctx)) add('(全站)', tab, '📉極端占比', c.id, m[1], ctx);
        }
    }
    scanned += cards.length;
    // 印出每頁掃到幾張 —— ⭐ 「掃很少」跟「壞掉」長得一樣,不印就分不出來
    process.stdout.write(`${tab}:${cards.length} `);
}
await browser.close();

function ctxOf(t, i) { return t.slice(Math.max(0, i - 45), i + 55).replace(/\s+/g, ' '); }

// ── 報告 ────────────────────────────────────────────────────
console.log(`\n\n共掃過 ${scanned} 張可見卡片`);
if (!scanned) { console.log('❌ 一張卡都沒掃到 —— 這次掃描無效(⛔ 別讀成沒問題)'); process.exit(1); }
console.log('═'.repeat(70));
if (errs.length) console.log(`⚠️ 渲染期間有 ${errs.length} 個 pageerror:\n   ` + errs.slice(0, 5).join('\n   ') + '\n');
if (!findings.length) {
    console.log('✅ 四類缺陷都沒掃到(⚠️ 不代表沒問題 —— grep/樣式只抓得到想得到的說法)');
} else {
    const by = {};
    for (const f of findings) (by[f.kind] ||= []).push(f);
    for (const [kind, list] of Object.entries(by)) {
        console.log(`\n${kind}  ${list.length} 筆`);
        // 同一張卡的同一個命中只印一次(不同股票會重複命中同一段模板)
        const uniq = new Map();
        for (const f of list) {
            const k = `${f.card}｜${f.hit}｜${f.ctx.slice(0, 30)}`;
            if (!uniq.has(k)) uniq.set(k, { ...f, syms: new Set() });
            uniq.get(k).syms.add(f.sym);
        }
        for (const f of [...uniq.values()].slice(0, 30)) {
            console.log(`   #${f.card}  [${[...f.syms].join(',')}]  ${f.tab}`);
            console.log(`      「${f.hit}」  …${f.ctx}…`);
        }
        if (uniq.size > 30) console.log(`   …另有 ${uniq.size - 30} 筆同類`);
    }
}
console.log('\n' + '═'.repeat(70));
console.log('⚠️ 這是**巡邏工具不是測試** —— 每一筆都要人工讀原始碼驗真偽(約 1/3 是誤報)。');
console.log('   常見誤報:註解式說明、大盤層級的建議、條件本身已含 trend===\'bull\' 的分支。');
// ⛔ 永遠 exit 0:誤報擋 push 會讓人養成無視它的習慣(同 data_audit 的 SUPERSEDED 教訓)
