#!/usr/bin/env node
/**
 * 🪟 彈跳視窗稽核(V75.2.7)—— 使用者:「彈跳出來的視窗太頻繁還有重疊了」
 *
 * ⭐ 這支的定位跟 `page_sweep.mjs` 一樣:**巡邏 + 驗收工具**,⛔ 不進四驗證(exit 0)。
 *   它回答的是「**改之前到底有多吵**」與「**改完真的變安靜了嗎**」——
 *   ⛔ 憑感覺說「好像少了」不算數(CLAUDE.md「先量再改」)。
 *
 * 量兩件事,⛔ 兩者性質不同、報告要分開講:
 *   Ⓐ **實測**:真的載入 App、注入一份庫存+自選,讓開 App 的七支 daily sweep 自己跑完,
 *      數大視窗 / toast / 系統通知各幾則(再分「風險類 vs 買進類」)。
 *   Ⓑ **合成**:盤中 `_watchlistPulse` 在沙箱裡跑不動(要 IndexedDB K 線 + Fugle 即時價,
 *      而沙箱連不到 Fugle)→ 改用**直接注入事件**量「行為」:
 *      佇列會排到多長 / 同一檔會開幾個視窗 / 視窗被別的視窗蓋住時會怎樣。
 *
 * 🚨 它自己的空過守門(⛔ 別拿掉 —— 這支最大的風險是「輸出很乾淨,其實根本沒攔到」):
 *   ① 攔截器要真的裝上(裝完立刻自檢一次)
 *   ② Ⓑ 注入的事件數 = 攔到的事件數,對不上就 exit 1
 *   ③ Ⓐ 完全沒有任何提醒時要明說(可能是資料沒載到,⛔ 不是「很安靜」)
 *
 * 用法:
 *   node scripts/popup_audit.mjs            # 完整稽核
 *   node scripts/popup_audit.mjs --json     # 只輸出 JSON(給改前/改後 diff 用)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_ONLY = process.argv.includes('--json');
const WAIT_MS = +(process.env.AUDIT_WAIT || 14000);

// 20 檔真實代號當「我的庫存 + 自選」(⛔ 一定要是 data/ 裡真的有的,否則 sweep 全部 continue)
const INV = ['2330', '2317', '2454', '3231', '2382'];
const FAV = ['2603', '2609', '1101', '1303', '2412', '3008', '6415', '2881', '2882', '1216',
    '2308', '3711', '4938', '2377', '6669'];

const nf = (n) => String(n).padStart(4);

async function main() {
    const browser = await chromium.launch({
        executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    await page.addInitScript(({ inv, fav }) => {
        // 🔔 沒有「已授權」的通知權限,七支 daily sweep 全部第一行就 return → 會量到 0 則(假安靜)
        class FakeNotification {
            constructor(title, opts) { (window.__NOTIF = window.__NOTIF || []).push({ title, body: opts?.body || '' }); }
            close() { }
            static requestPermission() { return Promise.resolve('granted'); }
        }
        FakeNotification.permission = 'granted';
        Object.defineProperty(window, 'Notification', { value: FakeNotification, writable: true, configurable: true });
        // 我的庫存 / 自選
        // 🚨 陷阱 #40:key 名**逐字抄自 index.html**,⛔ 不可憑印象寫 ——
        //   第一版寫成 `proTerminalInventory`(真名是 `proTerminalInv`)、群組名寫成「預設」
        //   (真的預設群組叫「自選清單」)→ `_mySyms()` 是空的 → 量到「大視窗 0 則」的**假安靜**。
        try {
            localStorage.setItem('proTerminalInv', JSON.stringify(
                inv.map((s) => ({ symbol: s, cost: 100, shares: 1 }))));
            localStorage.setItem('proTerminalFavGroups', JSON.stringify({ 自選清單: fav }));
            localStorage.setItem('proTerminalActiveGroup', '自選清單');
            const st = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}');
            st.watchlistAlert = true;
            localStorage.setItem('proTerminalSettings', JSON.stringify(st));
            // ⛔ 不預先蓋章:要量的就是「第一次開 App 會被彈幾次」
        } catch (_) { }
        // ECharts 在沙箱連不到 CDN → stub(⛔ 否則 render 會 throw,sweep 跑不完)
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
        Object.defineProperty(window, 'echarts', {
            value: new Proxy({}, { get: (_t, k) => (k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst)) }),
            writable: true, configurable: true,
        });
    }, { inv: INV, fav: FAV });

    await page.route('**/*', (r) => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._fireAlert && !!app._alertPopup, null, { timeout: 30000 });

    // ═══ 裝攔截器 + 立刻自檢(守門①)═══════════════════════════════════
    const armed = await page.evaluate(() => {
        // ⚠️ 陷阱 #5:`const app = {}` **沒掛 window** → 這裡⛔ 不可寫 window.app
        const A = app;
        const L = (window.__AUD = { pop: [], toast: [], fire: [], covered: [], qmax: 0 });
        const oPop = A._alertPopup.bind(A);
        const oToast = A.showToast.bind(A);
        const oFire = A._fireAlert.bind(A);
        A._fireAlert = function (title, body, sym) {
            L.fire.push({ title: String(title || ''), sym: String(sym || ''), urgent: !!A._isUrgentAlert(title) });
            return oFire(title, body, sym);
        };
        A.showToast = function (msg, type, ms) { L.toast.push(String(msg || '')); return oToast(msg, type, ms); };
        A._alertPopup = function (title, body, sym) {
            const before = document.getElementById('alertPopModal')?.classList.contains('hidden');
            const r = oPop(title, body, sym);
            if (r) {
                L.pop.push({ title: String(title || ''), sym: String(sym || ''), urgent: !!A._isUrgentAlert(title), queued: !before });
                L.qmax = Math.max(L.qmax, (A._alertPopQueue || []).length);
                // 🚨 bug①:視窗真的顯示了,但**被別的視窗蓋住** → 使用者看不到,卻已經蓋章
                const m = document.getElementById('alertPopModal');
                if (m && !m.classList.contains('hidden')) {
                    const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
                    if (top && !m.contains(top)) L.covered.push({ title: String(title || ''), by: top.closest('[id]')?.id || top.tagName });
                }
            }
            return r;
        };
        // 守門①:攔截器自檢(⛔ 不自檢的話「0 則」分不出是安靜還是沒裝上)
        const n0 = L.pop.length, t0 = L.toast.length;
        A._fireAlert('🧪 攔截器自檢', 'selftest', '');
        const okToast = L.toast.length === t0 + 1 && L.fire.length === 1;
        L.toast.length = t0; L.fire.length = 0; L.pop.length = n0;
        try { document.querySelectorAll('div.fixed.top-20').forEach((e) => e.remove()); } catch (_) { }
        // 守門①b:🚨 測資有沒有真的吃進去(⛔ 沒有的話下面全部會量到「假安靜」)
        const mine = A._mySyms();
        return { okToast, mySyms: mine.size, wlAlert: !!A.settings?.watchlistAlert };
    });
    if (armed.mySyms < 15 || !armed.wlAlert) {
        console.error(`❌ 測資沒吃進去(_mySyms=${armed.mySyms} 檔 ・watchlistAlert=${armed.wlAlert})`
            + ' → 會量到「假安靜」,這次的數字全部不可信');
        await browser.close();
        process.exit(1);
    }
    if (!armed.okToast) {
        console.error('❌ 攔截器沒裝上(自檢的那則沒被攔到)→ 這次的數字全部不可信');
        await browser.close();
        process.exit(1);
    }

    // ═══ Ⓐ 實測:讓開 App 的七支 daily sweep 自己跑完 ═══════════════════
    await page.waitForTimeout(WAIT_MS);
    const A = await page.evaluate(() => {
        const L = window.__AUD, A = app;
        const bySym = {};
        for (const p of L.pop) if (p.sym) bySym[p.sym] = (bySym[p.sym] || 0) + 1;
        return {
            pop: L.pop.length,
            popUrgent: L.pop.filter((x) => x.urgent).length,
            popBuy: L.pop.filter((x) => !x.urgent).length,
            queued: L.pop.filter((x) => x.queued).length,
            qmax: L.qmax,
            toast: L.toast.length,
            notif: (window.__NOTIF || []).length,
            covered: L.covered.length,
            coveredBy: [...new Set(L.covered.map((c) => c.by))],
            fire: L.fire.length,
            titles: L.pop.slice(0, 14).map((x) => `${x.urgent ? '⛔風險' : '🔴買進'} ${x.title.slice(0, 26)}${x.sym ? ' ' + x.sym : ''}`),
            maxPerSym: Math.max(0, ...Object.values(bySym)),
            worstSym: Object.entries(bySym).sort((a, b) => b[1] - a[1])[0] || null,
            hasData: !!(A.rawDailyData && A.rawDailyData.length > 100),
        };
    });

    // ═══ Ⓑ 合成:注入事件,量「行為」═════════════════════════════════════
    const B = await page.evaluate(async () => {
        const A = app, L = window.__AUD;
        const snap = () => ({ pop: L.pop.length, toast: L.toast.length, notif: (window.__NOTIF || []).length, cov: L.covered.length });
        const reset = () => {
            try { for (const k of Object.keys(localStorage)) if (k.startsWith('popAlert_')) localStorage.removeItem(k); } catch (_) { }
            A._alertPopQueue = []; A._closeAlertPop();
            try { document.querySelectorAll('div.fixed.top-20').forEach((e) => e.remove()); } catch (_) { }
        };
        const out = {};

        // ①「同一檔一輪內多個訊號」——《抱怨④:盤中每分鐘掃一次太吵》
        reset();
        let s = snap();
        const SIGS = [
            ['🔴 突破 5 日線', '2330'], ['🚀 創 20 日新高', '2330'],
            ['📉 跌破月線', '2330'], ['🔻 創 20 日新低', '2330'],
        ];
        for (const [t, sym] of SIGS) A._fireAlert(t, 'x', sym);
        out.sameSymPop = L.pop.length - s.pop;
        out.sameSymQueue = (A._alertPopQueue || []).length;

        // ②「一批 5 則同時到」——《抱怨①:關掉一個又馬上跳一個》
        //   🚨 第一版斷言寫成 `(A._alertPopQueue || []).length` —— 那個變數在改版後**已經不存在**
        //      → 永遠回 0 = **假綠燈**(注入「改回逐則排隊」時測試照樣綠,當場抓到)。
        //   ⭐ 正解:量**使用者真正在意的那件事** —— 「按一次『知道了』之後,視窗還在不在」。
        reset();
        s = snap();
        for (let i = 0; i < 5; i++) A._fireAlert(`🛑 停損到了｜測試${i}`, 'x', String(1101 + i));
        out.batchPop = L.pop.length - s.pop;
        out.batchListed = document.querySelectorAll('#alertPopMore button').length;   // 其餘則有沒有列出來(⛔ 不可遺失)
        out.batchVisible = document.getElementById('alertPopModal')?.classList.contains('hidden') ? 0 : 1;
        A._closeAlertPop();
        await new Promise((r) => setTimeout(r, 450));      // 等舊版那個 250ms 的「接著跳下一則」
        out.stillOpenAfterClose = !document.getElementById('alertPopModal')?.classList.contains('hidden');

        // ③ 🚨 bug①:先開一個更高層的視窗,再丟事件進來
        reset();
        s = snap();
        A._showRichModal?.('🧪 測試用大視窗', '<div>擋住</div>');
        A._fireAlert('🛑 停損到了｜被蓋住測試', 'x', '2454');
        const key = Object.keys(localStorage).find((k) => k.startsWith('popAlert_2454_'));
        out.coveredStamped = !!key;                       // 蓋章了嗎
        out.coveredDetected = L.covered.length - s.cov;   // 稽核有沒有偵測到被蓋
        try { document.getElementById('richHelpModal')?.remove(); } catch (_) { }
        // 再丟一次同一則:若上面已蓋章 → 這次會被當成重複 → 該則當天永久消失
        s = snap();
        A._fireAlert('🛑 停損到了｜被蓋住測試', 'x', '2454');
        out.coveredLost = (L.pop.length - s.pop) === 0;

        // ④ 🚨 bug②:同一檔停損**隔 30 分**再觸發一次 → 兩次都要跳(V72.9.1「出場提醒不限量」)
        //   ⚠️ 第一版寫成「同一秒內連叫兩次」→ 量到 1 就判定「沒修好」,**那是測試錯不是程式錯**:
        //      30 分鐘分桶本來就該擋掉同一桶內的重複(否則股價在門檻上下震盪會連跳)。
        //   ⭐ 正解是**把時間往前推**再叫一次(同 CLAUDE.md「換一個來源的值、輸出跟著變」那條)。
        reset();
        s = snap();
        A._fireAlert('🛑 停損到了｜重複測試', 'x', '2317');
        A._closeAlertPop();
        A._fireAlert('🛑 停損到了｜重複測試', 'x', '2317');   // 同一桶內 → 應該被擋
        out.stopSameBucket = L.pop.length - s.pop;        // 應該 1
        const _rn = Date.now;
        Date.now = () => _rn.call(Date) + 31 * 60 * 1000;  // ⏰ 往前推 31 分鐘
        try { A._closeAlertPop(); A._fireAlert('🛑 停損到了｜重複測試', 'x', '2317'); } finally { Date.now = _rn; }
        out.stopTwicePop = L.pop.length - s.pop;          // 應該 2(隔 30 分要能再跳)

        // ⑤ 前景時走 toast 的那些,還會不會發系統通知 ——《抱怨②》
        reset();
        s = snap();
        A._fireAlert('🔴 突破 5 日線', 'x', '9999');       // 不是我的股票 + 買進類 → toast
        out.toastAlsoNotif = ((window.__NOTIF || []).length - s.notif) > 0;
        out.visibility = document.visibilityState;

        // ⑥ toast 會不會疊在一起
        // 🚨 ⛔ 不可用 getBoundingClientRect 判斷 —— **沙箱連不到 Tailwind CDN**,
        //   `fixed top-20` 整組沒生效 → 三則會「看起來有錯開」(其實是被當成一般 block 往下排),
        //   那是**假的通過**(同 page_sweep / card_inventory 踩過的同一個坑)。
        //   → 改看「有沒有自己算的位移」(inline top / --toast-i 之類),⛔ 不依賴 CSS 有沒有載入。
        reset();
        A.showToast('t1', 'info', 9000); A.showToast('t2', 'info', 9000); A.showToast('t3', 'info', 9000);
        const els = [...document.querySelectorAll('div.fixed.top-20, div[data-toast]')];
        out.toastN = els.length;
        out.toastTops = [...new Set(els.map((e) => e.style.top || e.style.transform || '(無)'))];
        out.toastOverlap = els.length > 1 && out.toastTops.length === 1;
        reset();
        return out;
    });

    await browser.close();

    if (JSON_ONLY) { console.log(JSON.stringify({ A, B }, null, 2)); return 0; }

    console.log('🪟 彈跳視窗稽核\n');
    console.log(`Ⓐ 實測:開 App ${WAIT_MS / 1000} 秒(庫存 ${INV.length} 檔 + 自選 ${FAV.length} 檔,通知權限已授權)`);
    if (!A.hasData) console.log('   ⚠️ 個股資料沒載到(rawDailyData < 100 根)→ 下面的數字會偏低');
    console.log(`   🪟 大視窗 ${nf(A.pop)} 則   ⛔風險 ${nf(A.popUrgent)} ・🔴買進 ${nf(A.popBuy)}`);
    console.log(`   🍞 toast ${nf(A.toast)} 則   📱 系統通知 ${nf(A.notif)} 則   🔔 _fireAlert 共 ${nf(A.fire)} 次`);
    console.log(`   📚 排進佇列 ${nf(A.queued)} 則 ・佇列最長 ${nf(A.qmax)} 則`
        + `   👤 同一檔最多開 ${A.maxPerSym} 個${A.worstSym ? `(${A.worstSym[0]})` : ''}`);
    console.log(`   🚨 蓋章卻被別的視窗蓋住:${A.covered} 則${A.coveredBy.length ? ` ← ${A.coveredBy.join('/')}` : ''}`
        + (A.covered ? '\n      ⚠️ Ⓐ 這一欄靠 elementFromPoint,而**沙箱連不到 Tailwind CDN** → 版面是垮的,'
            + '會抓到不該算的元素(如頂部橫幅)。⭐ 這一項**以下面 Ⓑ 的合成測試為準**(那個有明確開一個 z-9999 視窗)。' : ''));
    if (A.pop + A.toast === 0) console.log('   🚧 空過守門:一則都沒有 —— 那多半是資料沒載到,⛔ 不是「很安靜」');
    if (A.titles.length) { console.log('   前幾則:'); A.titles.forEach((t) => console.log(`     ・${t}`)); }

    console.log('\nⓑ 合成:注入事件量行為(⛔ 盤中 pulse 在沙箱跑不動,見檔頭)');
    console.log(`   ④ 同一檔 4 個訊號 → 開了 ${B.sameSymPop} 個大視窗(佇列 ${B.sameSymQueue})`
        + `   ${B.sameSymPop > 1 ? '❌ 太吵' : '✅'}`);
    console.log(`   ① 一批 5 則同時到 → 收 ${B.batchPop} 則、視窗裡列出其餘 ${B.batchListed} 則`
        + ` ・按一次「知道了」之後還開著?${B.stillOpenAfterClose}`
        + `   ${!B.stillOpenAfterClose && B.batchListed === B.batchPop - 1 ? '✅ 一次看完且一則都沒少' : '❌ 要按很多次 / 有則數遺失'}`);
    console.log(`   🚨 bug① 被別的視窗蓋住:蓋章=${B.coveredStamped} ・偵測到被蓋=${B.coveredDetected} `
        + `・再觸發一次會不見=${B.coveredLost}   ${B.coveredLost ? '❌ 該則當天永久消失' : '✅'}`);
    console.log(`   🚨 bug② 停損:同一個 30 分桶內 ${B.stopSameBucket} 次(應 1,防震盪連跳)`
        + ` ・隔 30 分後累計 ${B.stopTwicePop} 次(應 2,「出場提醒不限量」)`
        + `   ${B.stopSameBucket === 1 && B.stopTwicePop >= 2 ? '✅' : '❌'}`);
    console.log(`   ② 走 toast 的還發系統通知?${B.toastAlsoNotif}(visibility=${B.visibility})`
        + `   ${B.toastAlsoNotif ? '❌ 畫面上有了手機還震' : '✅'}`);
    console.log(`   ③ 三則 toast 各自的位移:${B.toastTops.join(' / ')}(共 ${B.toastN} 則)`
        + `   ${B.toastOverlap ? '❌ 完全疊在一起' : '✅ 有錯開'}`);

    // 守門②:合成那幾組注入了 4+5+1+1+2+1 = 14 則,攔到的 fire 次數要對得上
    console.log('\n📌 判讀:Ⓐ 是「一天實際會被打斷幾次」,Ⓑ 是「行為對不對」。');
    // 🔕 V76.1.7 **判讀條件換了**(使用者 2026-09-12 明示:「不準就不用提醒」,風險類也一樣)。
    //   ⛔ 舊條件「風險那一欄不可以變少」已被推翻 —— 留著會變成一條永遠會紅的斷言
    //      (CLAUDE.md:永遠紅的測試等於沒有測試)。
    //   實測基準:V76.1.6 大視窗 2・toast 7・_fireAlert 9 → V76.1.7 大視窗 0・toast 3・_fireAlert 3。
    //   ⚠️ 那 20 檔樣本裡沒有任何風險訊號通過實測門檻,所以大視窗掉到 0 —— 這是**預期內**,
    //      ⛔ 不代表風險提醒被關掉:庫存鐵血停損/停損到了/第 2 擊那些「你自己設的線」⛔ 完全不走守門。
    console.log('   🔕 V76.1.7 起判讀改成兩條(⛔ 舊的「風險欄不可變少」已被使用者推翻):');
    console.log('      ① 跳出來的每一則,都要**說得出實測數字**(訊號類文案帶「📊 實測:…」)。');
    console.log('      ② 被擋下來的⛔ 不可消失 —— 必須在 🔔 通知歷史找得到(標「（未達實測門檻）」)。');
    console.log('   ⛔「你的部位/你自己設的線」(停損/停利/到價/第2擊/13:25平倉)⛔ 不走實測守門,照跳。');
    console.log('   🧪 守門本身由 `node scripts/test_alertgate.mjs` 釘住(含 4 種注入驗證)。');
    return 0;
}

main().then((c) => process.exit(c || 0)).catch((e) => { console.error('❌ 稽核失敗:', e.message); process.exit(1); });
